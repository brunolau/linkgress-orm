import type { DbColumn } from '../entity/db-column';
import type { Subquery } from './subquery';

/**
 * SQL condition types
 */
export type ConditionOperator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'in' | 'notIn'
  | 'isNull' | 'isNotNull'
  | 'between';

/**
 * Field reference - wraps a database column name with type information
 * TName: The property name (e.g., 'isActive')
 * TValueType: The TypeScript type of the column value (e.g., boolean)
 */
export interface FieldRef<TName extends string = string, TValueType = any> {
  readonly __fieldName: TName;
  readonly __dbColumnName: string;
  readonly __valueType?: TValueType; // Phantom type - exists only for type checking
}

/**
 * Type that represents anything that can be used as a field in a condition.
 * This includes FieldRef, DbColumn, or any object with __dbColumnName.
 * Allows navigation properties (which return EntityQuery<DbColumn<T>>) to work in conditions.
 */
export type FieldLike<V = any> =
  | FieldRef<any, V>
  | DbColumn<V>
  | { __dbColumnName: string; __fieldName?: string };

/**
 * Extract the field name from a FieldRef or string
 */
export type ExtractFieldName<T> = T extends FieldRef<infer N, any> ? N : T extends string ? T : never;

/**
 * Extract the value type from a FieldRef
 */
export type ExtractValueType<T> = T extends FieldRef<any, infer V> ? V : any;

/**
 * Forward declaration for SqlFragment (actual class defined later in this file)
 * Used by UnwrapSqlFragment type
 */
export interface SqlFragmentLike<T = any> {
  mapWith: any;
  as: any;
  getMapper: any;
  getAlias: any;
  getFieldRefs: any;
  buildSql: any;
  /** Phantom property to hold the value type - never actually set */
  readonly __valueType?: T;
}

/**
 * Unwrap SqlFragment<T> to T, or return T if not a SqlFragment
 * This is used to extract the actual value type from SQL expressions in selections
 */
export type UnwrapSqlFragment<T> = T extends SqlFragmentLike<infer V> ? V : T;

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object (only has data properties).
 *
 * Class instances like Date, Map, Set, RegExp, Error, Promise, typed arrays,
 * and user-defined classes have inherited methods from prototypes.
 * Plain objects only have their own enumerable properties.
 *
 * We detect this by checking for common method signatures that class instances have.
 * If an object type has valueOf/toString as actual methods (not just from Object.prototype pattern),
 * it's likely a class instance.
 *
 * This approach works for:
 * - Built-in types: Date, Map, Set, RegExp, Error, Promise, ArrayBuffer, etc.
 * - Temporal API types (when available)
 * - BigInt, Symbol
 * - User-defined classes with methods
 * - Third-party library types like Decimal.js, moment, etc.
 *
 * EXCLUDES:
 * - DbColumn - has valueOf but should NOT be treated as a value type
 * - SqlFragment - has valueOf but should NOT be treated as a value type
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Explicitly exclude DbColumn from being a value type
  : T extends SqlFragmentLike<any>
  ? false  // Explicitly exclude SqlFragment from being a value type
  : T extends { valueOf(): infer V }
  ? // Has valueOf - check if it's a value-returning class instance
    // Class instances have valueOf that returns a primitive or itself
    V extends T
    ? true  // valueOf returns same type (like Date.valueOf() returns number, but Date itself)
    : V extends number | string | boolean | bigint | symbol
    ? true  // valueOf returns a primitive - it's a class instance
    : false
  : false;

/**
 * Alternative check: if type has constructor signature or known class methods
 * This catches types that might not have valueOf but are still class instances
 */
type HasClassMethods<T> = T extends { getTime(): number }  // Date-like
  ? true
  : T extends { size: number; has(value: any): boolean }  // Set/Map-like
  ? true
  : T extends { byteLength: number }  // ArrayBuffer/TypedArray-like
  ? true
  : T extends { then(onfulfilled?: any): any }  // Promise-like
  ? true
  : T extends { message: string; name: string }  // Error-like
  ? true
  : T extends { exec(string: string): any }  // RegExp-like
  ? true
  : false;

/**
 * Combined check for value types that should not be recursively processed
 */
type IsValueType<T> = IsClassInstance<T> extends true
  ? true
  : HasClassMethods<T> extends true
  ? true
  : false;

/**
 * Recursively unwrap all SqlFragment types in an object type
 * Maps { a: SqlFragment<number>, b: string } to { a: number, b: string }
 * Preserves arrays, functions, primitive types, and class instances without recursing into them
 * Also unwraps Subquery<TResult> to TResult
 */
export type UnwrapSelection<T> = T extends SqlFragment<infer V>
  ? V
  : T extends SqlFragmentLike<infer V>
    ? V
    : T extends DbColumn<infer V>
      ? V  // Unwrap DbColumn<T> to T
      : T extends Subquery<infer R, any>
        ? R  // Unwrap Subquery<TResult, TMode> to TResult
        : T extends (infer U)[]
          ? UnwrapSelection<U>[]
          : T extends (...args: any[]) => any
            ? T  // Preserve functions as-is
            : T extends object
              ? IsValueType<T> extends true
                ? T  // Preserve class instances (Date, Map, Set, Temporal, etc.) as-is
                : { [K in keyof T]: UnwrapSelection<T[K]> }
              : T;

/**
 * Context for building SQL with parameter tracking
 */
export interface SqlBuildContext {
  paramCounter: number;
  params: any[];
}

/**
 * Base class for all WHERE conditions with helper methods
 */
export abstract class WhereConditionBase {
  /**
   * Build the SQL for this condition
   */
  abstract buildSql(context: SqlBuildContext): string;

  /**
   * Get all field references used in this condition.
   * Used to detect navigation property references that need JOINs.
   */
  getFieldRefs(): FieldRef[] {
    return [];
  }

  /**
   * Helper to check if a value is a FieldRef
   */
  protected isFieldRef<V>(value: any): value is FieldRef<any, V> {
    return typeof value === 'object' && value !== null && '__dbColumnName' in value;
  }

  /**
   * Helper to extract database column name from field reference
   * Returns the fully qualified column name (with table alias if present)
   */
  protected getDbColumnName<T extends string, V = any>(field: FieldRef<T, V> | T): string {
    if (typeof field === 'object' && '__dbColumnName' in field) {
      // Check if field has a table alias
      if ('__tableAlias' in field && (field as any).__tableAlias) {
        // Return fully quoted table.column
        return `"${(field as any).__tableAlias}"."${field.__dbColumnName}"`;
      }
      // Return just the quoted column name
      return `"${field.__dbColumnName}"`;
    }
    // For string fields, quote them
    return `"${field as string}"`;
  }

  /**
   * Helper to extract value from a FieldRef or constant
   */
  protected extractValue<V>(value: FieldLike<V> | V): any {
    if (this.isFieldRef(value)) {
      return value.__dbColumnName;
    }
    return value;
  }

  /**
   * Helper to get the right-hand side of a comparison
   * Returns either a column reference or a parameter placeholder
   */
  protected getRightSide<V>(value: FieldLike<V> | V, context: SqlBuildContext): string {
    if (this.isFieldRef(value)) {
      // Value is a field reference, use it with table alias if present
      if ('__tableAlias' in value && (value as any).__tableAlias) {
        return `"${(value as any).__tableAlias}"."${value.__dbColumnName}"`;
      }
      return `"${value.__dbColumnName}"`;
    } else {
      // Value is a literal, use a parameter
      context.params.push(value);
      return `$${context.paramCounter++}`;
    }
  }
}

/**
 * Base class for comparison operations (eq, gt, like, etc.)
 */
export abstract class WhereComparisonBase<V = any> extends WhereConditionBase {
  constructor(
    protected field: FieldLike<V> | string,
    protected value?: FieldLike<V> | V
  ) {
    super();
  }

  /**
   * Get the comparison operator (e.g., '=', '>', 'LIKE')
   */
  protected abstract getOperator(): string;

  /**
   * Get all field references used in this comparison
   */
  override getFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    if (this.isFieldRef(this.field)) {
      refs.push(this.field);
    }
    if (this.value !== undefined && this.isFieldRef(this.value)) {
      refs.push(this.value);
    }
    return refs;
  }

  /**
   * Build the comparison SQL
   * Can be overridden for custom behavior
   */
  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field); // Returns already quoted name
    const operator = this.getOperator();

    if (this.value !== undefined) {
      const rightSide = this.getRightSide(this.value, context);
      return `${fieldName} ${operator} ${rightSide}`;
    } else {
      // For operators like IS NULL that don't have a value
      return `${fieldName} ${operator}`;
    }
  }
}

/**
 * Logical condition (AND, OR, NOT)
 */
export class LogicalCondition extends WhereConditionBase {
  constructor(
    private operator: 'and' | 'or' | 'not',
    private conditions: WhereConditionBase[]
  ) {
    super();
  }

  /**
   * Get all field references from nested conditions
   */
  override getFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    for (const cond of this.conditions) {
      refs.push(...cond.getFieldRefs());
    }
    return refs;
  }

  buildSql(context: SqlBuildContext): string {
    if (this.conditions.length === 0) {
      return '1=1';
    }

    const parts = this.conditions.map(c => c.buildSql(context));

    switch (this.operator) {
      case 'and':
        return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
      case 'or':
        return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
      case 'not':
        return `NOT (${parts[0]})`;
      default:
        throw new Error(`Unknown logical operator: ${this.operator}`);
    }
  }
}

/**
 * Raw SQL condition
 */
export class RawSqlCondition extends WhereConditionBase {
  constructor(
    private sql: string,
    private sqlParams: any[] = []
  ) {
    super();
  }

  buildSql(context: SqlBuildContext): string {
    if (this.sqlParams.length > 0) {
      context.params.push(...this.sqlParams);
    }
    return this.sql;
  }
}

// ============================================================================
// Specific comparison implementations
// ============================================================================

export class EqComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '=';
  }
}

export class NeComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '!=';
  }
}

export class GtComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '>';
  }
}

export class GteComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '>=';
  }
}

export class LtComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '<';
  }
}

export class LteComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '<=';
  }
}

export class LikeComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return 'LIKE';
  }
}

export class ILikeComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return 'ILIKE';
  }
}

export class IsNullComparison<V = any> extends WhereComparisonBase<V> {
  constructor(field: FieldLike<V> | string) {
    super(field, undefined);
  }

  protected getOperator(): string {
    return 'IS NULL';
  }
}

export class IsNotNullComparison<V = any> extends WhereComparisonBase<V> {
  constructor(field: FieldLike<V> | string) {
    super(field, undefined);
  }

  protected getOperator(): string {
    return 'IS NOT NULL';
  }
}

/**
 * IN comparison - handles array of values
 */
export class InComparison<V = any> extends WhereComparisonBase<V> {
  constructor(
    field: FieldLike<V> | string,
    private values: V[]
  ) {
    super(field, undefined);
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field); // Returns already quoted name

    if (!Array.isArray(this.values) || this.values.length === 0) {
      return '1=0'; // No matches
    }

    const params = this.values.map(() => `$${context.paramCounter++}`).join(', ');
    context.params.push(...this.values);
    return `${fieldName} IN (${params})`;
  }

  protected getOperator(): string {
    return 'IN';
  }
}

/**
 * NOT IN comparison
 */
export class NotInComparison<V = any> extends WhereComparisonBase<V> {
  constructor(
    field: FieldLike<V> | string,
    private values: V[]
  ) {
    super(field, undefined);
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field); // Returns already quoted name

    if (!Array.isArray(this.values) || this.values.length === 0) {
      return '1=1'; // All match
    }

    const params = this.values.map(() => `$${context.paramCounter++}`).join(', ');
    context.params.push(...this.values);
    return `${fieldName} NOT IN (${params})`;
  }

  protected getOperator(): string {
    return 'NOT IN';
  }
}

/**
 * BETWEEN comparison
 */
export class BetweenComparison<V = any> extends WhereComparisonBase<V> {
  constructor(
    field: FieldLike<V> | string,
    private min: FieldLike<V> | V,
    private max: FieldLike<V> | V
  ) {
    super(field, undefined);
  }

  /**
   * Get all field references including min and max
   */
  override getFieldRefs(): FieldRef[] {
    const refs = super.getFieldRefs();
    if (this.isFieldRef(this.min)) {
      refs.push(this.min);
    }
    if (this.isFieldRef(this.max)) {
      refs.push(this.max);
    }
    return refs;
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field); // Returns already quoted name
    const minSide = this.getRightSide(this.min, context);
    const maxSide = this.getRightSide(this.max, context);
    return `${fieldName} BETWEEN ${minSide} AND ${maxSide}`;
  }

  protected getOperator(): string {
    return 'BETWEEN';
  }
}

// ============================================================================
// Type alias for backward compatibility
// ============================================================================

/**
 * Condition type - can be any WHERE condition
 */
export type Condition = WhereConditionBase;

// ============================================================================
// Condition factory functions
// These are type-safe and return class instances
// ============================================================================

export function eq<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new EqComparison<V>(field!, value!);
}

export function ne<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new NeComparison<V>(field!, value!);
}

export function gt<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new GtComparison<V>(field!, value!);
}

export function gte<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new GteComparison<V>(field!, value!);
}

export function lt<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new LtComparison<V>(field!, value!);
}

export function lte<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  value: FieldLike<V> | V | undefined
): Condition {
  return new LteComparison<V>(field!, value!);
}

export function like<T extends string>(
  field: FieldLike<string> | T | undefined,
  value: FieldLike<string> | string | undefined
): Condition {
  return new LikeComparison(field!, value!);
}

export function ilike<T extends string>(
  field: FieldLike<string> | T | undefined,
  value: FieldLike<string> | string | undefined
): Condition {
  return new ILikeComparison(field!, value!);
}

export function inArray<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  values: V[]
): Condition {
  return new InComparison<V>(field!, values);
}

export function notInArray<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  values: V[]
): Condition {
  return new NotInComparison<V>(field!, values);
}

export function isNull<T extends string, V>(
  field: FieldLike<V> | T | undefined
): Condition {
  return new IsNullComparison<V>(field!);
}

export function isNotNull<T extends string, V>(
  field: FieldLike<V> | T | undefined
): Condition {
  return new IsNotNullComparison<V>(field!);
}

export function between<T extends string, V>(
  field: FieldLike<V> | T | undefined,
  min: FieldLike<V> | V | undefined,
  max: FieldLike<V> | V | undefined
): Condition {
  return new BetweenComparison<V>(field!, min!, max!);
}

export function and(...conditions: Condition[]): Condition {
  return new LogicalCondition('and', conditions);
}

export function or(...conditions: Condition[]): Condition {
  return new LogicalCondition('or', conditions);
}

export function not(condition: Condition): Condition {
  return new LogicalCondition('not', [condition]);
}

// ============================================================================
// SQL Fragment - for use in SELECT projections and WHERE conditions
// ============================================================================

/**
 * SQL Fragment - represents a raw SQL expression that can be used in SELECT or WHERE
 * Supports embedding FieldRef objects
 * Extends WhereConditionBase so it can be used directly in WHERE clauses
 */
export class SqlFragment<TValueType = any> extends WhereConditionBase {
  private sqlParts: string[];
  private values: any[];
  private mapper?: any; // TypeMapper - imported separately to avoid circular dep
  private alias?: string;

  constructor(parts: string[], values: any[], mapper?: any, alias?: string) {
    super();
    this.sqlParts = parts;
    this.values = values;
    this.mapper = mapper;
    this.alias = alias;
  }

  /**
   * Set custom type mapper for bidirectional transformation
   * Can accept either:
   * - A function (value: TDriver) => TData for inline transformations
   * - A CustomTypeBuilder with full toDriver/fromDriver methods
   */
  mapWith<TData = TValueType, TDriver = any>(
    mapper: ((value: TDriver) => TData) | any
  ): SqlFragment<TData> {
    // If mapper is a function, wrap it in a simple mapper object
    const normalizedMapper = typeof mapper === 'function'
      ? { fromDriver: mapper }
      : mapper;

    return new SqlFragment<TData>(this.sqlParts, this.values, normalizedMapper, this.alias);
  }

  /**
   * Set column alias for SELECT clause
   */
  as(alias: string): SqlFragment<TValueType> {
    return new SqlFragment<TValueType>(this.sqlParts, this.values, this.mapper, alias);
  }

  /**
   * Get the type mapper (internal use)
   */
  getMapper(): any | undefined {
    return this.mapper;
  }

  /**
   * Get the alias (internal use)
   */
  getAlias(): string | undefined {
    return this.alias;
  }

  /**
   * Get all field references from the fragment values
   */
  override getFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    for (const value of this.values) {
      if (this.isFieldRef(value)) {
        refs.push(value);
      } else if (value instanceof SqlFragment) {
        refs.push(...value.getFieldRefs());
      }
    }
    return refs;
  }

  /**
   * Check if value is a RawSql instance
   */
  private isRawSql(value: any): value is RawSql {
    return value instanceof RawSql;
  }

  /**
   * Build the SQL string with proper parameter placeholders
   */
  buildSql(context: SqlBuildContext): string {
    let sql = '';

    for (let i = 0; i < this.sqlParts.length; i++) {
      sql += this.sqlParts[i];

      if (i < this.values.length) {
        const value = this.values[i];

        // Check if value is a RawSql - insert directly without parameterization
        if (this.isRawSql(value)) {
          sql += value.value;
        }
        // Check if value is a FieldRef
        else if (this.isFieldRef(value)) {
          // It's a field reference - use the database column name with table alias if present
          if ('__tableAlias' in value && value.__tableAlias) {
            sql += `"${value.__tableAlias}"."${value.__dbColumnName}"`;
          } else {
            sql += `"${value.__dbColumnName}"`;
          }
        } else if (value instanceof SqlFragment) {
          // It's a nested SQL fragment
          sql += value.buildSql(context);
        } else if (typeof value === 'object' && value !== null && 'buildSql' in value && typeof value.buildSql === 'function') {
          // It's a Subquery (or any object with buildSql method)
          sql += `(${value.buildSql(context)})`;
        } else {
          // It's a literal value - use a parameter
          sql += `$${context.paramCounter++}`;
          context.params.push(value);
        }
      }
    }

    return sql;
  }

  /**
   * Get the SQL string with parameters (for debugging)
   */
  toString(): string {
    const context: SqlBuildContext = { paramCounter: 1, params: [] };
    return this.buildSql(context);
  }
}

/**
 * Marker class for raw SQL strings that should be inserted without parameterization
 * Used by sql.raw() to inject SQL directly into queries
 */
export class RawSql {
  constructor(public readonly value: string) {}
}

/**
 * Tagged template literal for creating SQL fragments
 * Usage: sql`lower(${field})` or sql`${field} = ${value}`
 */
function sqlTemplate<TValueType = any>(
  strings: TemplateStringsArray,
  ...values: any[]
): SqlFragment<TValueType> {
  return new SqlFragment<TValueType>(Array.from(strings), values);
}

/**
 * Create a raw SQL string that will be inserted directly without parameterization
 * WARNING: Do not use with user input - this can lead to SQL injection!
 * Use for table names, column names, SQL keywords, or trusted static strings only.
 *
 * @example
 * // Use for dynamic table/column names
 * sql`SELECT * FROM ${sql.raw(tableName)} WHERE ${sql.raw(columnName)} = ${value}`
 *
 * // Use for SQL keywords/operators
 * sql`SELECT * FROM users ORDER BY name ${sql.raw(sortDirection)}`
 *
 * // Use for complex SQL that shouldn't be parameterized
 * sql`SELECT ${sql.raw('COUNT(*)')} FROM users`
 */
function raw(value: string): RawSql {
  return new RawSql(value);
}

/**
 * Create an empty SQL fragment
 * Useful for conditional SQL building
 *
 * @example
 * const condition = shouldFilter ? sql`WHERE active = true` : sql.empty;
 */
const empty: SqlFragment<never> = new SqlFragment<never>([''], []);

/**
 * Join multiple SQL fragments with a separator
 *
 * @example
 * const columns = [sql`name`, sql`email`, sql`age`];
 * const selectList = sql.join(columns, sql`, `);
 * // Result: name, email, age
 */
function join<T = any>(fragments: SqlFragment<T>[], separator: SqlFragment<any> = new SqlFragment([', '], [])): SqlFragment<T> {
  if (fragments.length === 0) {
    return empty as SqlFragment<T>;
  }
  if (fragments.length === 1) {
    return fragments[0];
  }

  // Build combined parts and values
  const parts: string[] = [];
  const values: any[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    const fragmentParts = (fragment as any).sqlParts as string[];
    const fragmentValues = (fragment as any).values as any[];

    if (i > 0) {
      // Add separator
      const sepParts = (separator as any).sqlParts as string[];
      const sepValues = (separator as any).values as any[];

      // Merge last part of current result with separator's first part
      if (parts.length > 0) {
        parts[parts.length - 1] += sepParts[0];
      } else {
        parts.push(sepParts[0]);
      }

      for (let j = 0; j < sepValues.length; j++) {
        values.push(sepValues[j]);
        parts.push(sepParts[j + 1]);
      }
    }

    // Add fragment
    if (parts.length > 0 && fragmentParts.length > 0) {
      parts[parts.length - 1] += fragmentParts[0];
    } else if (fragmentParts.length > 0) {
      parts.push(fragmentParts[0]);
    }

    for (let j = 0; j < fragmentValues.length; j++) {
      values.push(fragmentValues[j]);
      parts.push(fragmentParts[j + 1]);
    }
  }

  return new SqlFragment<T>(parts, values);
}

// Create the sql function with additional methods
export const sql = Object.assign(sqlTemplate, {
  raw,
  empty,
  join,
});

// ============================================================================
// SQL builder for conditions
// ============================================================================

export class ConditionBuilder {
  build(condition: Condition, startParam: number = 1): { sql: string; params: any[] } {
    const context: SqlBuildContext = {
      paramCounter: startParam,
      params: [],
    };

    const sql = condition.buildSql(context);
    return { sql, params: context.params };
  }
}
