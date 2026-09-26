import type { DbColumn } from '../entity/db-column';
import type { Subquery } from './subquery';
import { toPgArrayLiteral } from '../types/custom-types';

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
  | SqlFragment<V>
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
    : T extends WhereConditionBase
      ? boolean  // a condition projects as a boolean column
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
  /** Map of placeholder names to their parameter indices (for prepared statements) */
  placeholders?: Map<string, number>;
  /**
   * Names of CTEs already declared at STATEMENT level by an enclosing builder
   * (currently `UnionQueryBuilder.buildSql`, which hoists its legs' `.with()`
   * CTEs so every leg can reference them). A builder that finds one of its own
   * attached CTEs listed here must emit neither its params nor its own `WITH`
   * entry for it — both have already been contributed by the hoisting builder.
   */
  hoistedCteNames?: Set<string>;
  /**
   * Overrides the client-derived array aggregation style (`array_agg` vs `json_agg`) for a
   * subquery built under this context. A model-managed view sets `false`: its SQL is schema,
   * so it must not depend on which driver happens to render it.
   */
  useJsonArrayAggregation?: boolean;
  /**
   * The root of the ONE projected value being built that the driver reads back directly, while that
   * driver cannot decode native arrays (see `projectedValueRoot`): the `agg.arrayAgg` it is renders
   * `json_agg`, a scalar subquery it is projects its own value that way. Set per projected value by
   * the projection code — an `arrayAgg` that SQL consumes (a function argument, an operand, a
   * WHERE, a HAVING, a CTE body, a compared UNION leg) is never that root and stays `array_agg`.
   * @internal
   */
  jsonArrayRoot?: unknown;
  /**
   * The select built under this context (a UNION leg, a subquery that is such a root) projects
   * values the driver reads back directly, on a driver without native array results. @internal
   */
  jsonArrayProjection?: boolean;
  /**
   * Table names that the LATERAL collection being built renders under a generated alias
   * (`lib_editions` → `lateral_0_editions`). An `exists()` / `count()` over a collection of its
   * item, nested in its WHERE or projection, correlates to that alias: the table is not visible
   * under its own name inside the lateral.
   */
  lateralTableAliasMap?: Map<string, string>;
  /**
   * Renders a column or an expression operand some other way than its own SQL — `undefined` for a
   * value it leaves alone. A grouped query's HAVING sets it: an aggregate ref (`g.count()`,
   * `g.sum(r => r.x)`) renders as the aggregate, and, over a grouped subquery, a grouping key as that
   * subquery's column. Consulted for comparison operands and for the values interpolated into `sql`.
   */
  substitute?: (value: object, context: SqlBuildContext) => string | undefined;
  /**
   * Render a projection's literals typed from their JS type (`CAST($1 AS boolean)`), for a
   * projection another query reads as COLUMNS — a CTE body, a table subquery. Untyped, a literal
   * reaches such a reader as text: `true` as 'true', and `gt(x.n, 5)` over a literal `42` compared
   * strings.
   */
  typedLiterals?: boolean;
}

/**
 * Placeholder for named parameters in prepared statements
 * Used with sql.placeholder() to create reusable parameterized queries
 *
 * @example
 * const query = db.users
 *   .where(u => eq(u.id, sql.placeholder('userId')))
 *   .prepare('getUserById');
 *
 * await query.execute({ userId: 10 });
 */
export class Placeholder<TName extends string = string> {
  constructor(public readonly name: TName) {}
}

/** The type mapper a FieldRef or fragment carries, if any. @internal */
export function getValueMapper(value: any): any | undefined {
  if (value && typeof value === 'object') {
    if ('__mapper' in value && value.__mapper) {
      return value.__mapper;
    }
    if (typeof value.getMapper === 'function') {
      return value.getMapper();
    }
  }
  return undefined;
}

/** `mapper.toDriver(value)` when the mapper has one, else the value unchanged. @internal */
export function applyToDriverMapper(value: any, mapper: any): any {
  return mapper && typeof mapper.toDriver === 'function'
    ? mapper.toDriver(value)
    : value;
}

/**
 * A subquery used as a comparison operand — duck-typed, subquery.ts imports this module. It renders
 * as `(<subquery sql>)` in the statement's parameter sequence and reports its correlation refs.
 * @internal
 */
export function isSubqueryOperand(value: unknown): value is { buildSql(context: SqlBuildContext): string; getOuterFieldRefs(): FieldRef[] } {
  return typeof value === 'object' && value !== null && !(value instanceof WhereConditionBase)
    && typeof (value as any).buildSql === 'function' && typeof (value as any).getOuterFieldRefs === 'function';
}

/** A comparison operand that is a scalar subquery: `eq(col, db.t.where(…).select(…).asSubquery('scalar'))`. */
export type ScalarSubqueryOperand<V> = Subquery<V, 'scalar'>;

function isSqlFragmentLiteral(value: any): boolean {
  return !(
    getValueMapper(value) ||
    value instanceof Placeholder ||
    value instanceof SqlFragment ||
    value instanceof RawSql ||
    (value && typeof value === 'object' && 'buildSql' in value && typeof value.buildSql === 'function')
  );
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
  protected getDbColumnName<T extends string, V = any>(field: FieldRef<T, V> | T, context?: SqlBuildContext): string {
    if (context?.substitute && typeof field === 'object' && field !== null) {
      const substituted = context.substitute(field, context);
      if (substituted !== undefined) {
        return substituted;
      }
    }
    // SqlFragment — build it to get raw SQL (e.g. sql`${field}::varchar(255)`)
    if (field instanceof SqlFragment) {
      return field.buildSql(context!);
    }
    // A scalar subquery operand — it used to render its object text: `"[object Object]" IS NULL`
    if (isSubqueryOperand(field)) {
      if (!context) {
        throw new Error('A subquery operand renders within a statement — it needs the build context');
      }
      return `(${field.buildSql(context)})`;
    }
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
   * @param value The value to process (field reference, literal, or placeholder)
   * @param context The SQL build context
   * @param sourceField Optional source field that may contain a mapper for toDriver transformation
   */
  protected getRightSide<V>(value: FieldLike<V> | V | Placeholder<any>, context: SqlBuildContext, sourceField?: FieldLike<V> | string): string {
    // Check if value is a named placeholder for prepared statements
    if (value instanceof Placeholder) {
      // Track placeholder name and its parameter index
      if (!context.placeholders) context.placeholders = new Map();

      // Check if this placeholder was already encountered
      const existingIndex = context.placeholders.get(value.name);
      if (existingIndex !== undefined) {
        // Reuse the same parameter index for duplicate placeholder names
        return `$${existingIndex}`;
      }

      // First occurrence - assign new parameter index
      context.placeholders.set(value.name, context.paramCounter);
      return `$${context.paramCounter++}`;
    }

    if (context.substitute && typeof value === 'object' && value !== null) {
      const substituted = context.substitute(value, context);
      if (substituted !== undefined) {
        return substituted;
      }
    }

    // SqlFragment — build it to inline its SQL (mirrors getDbColumnName's field-side
    // handling). Without this the fragment object falls through to the literal branch
    // and is serialized into a bound parameter, so the driver sends the fragment's SQL
    // text as a string value (e.g. "invalid input syntax for type integer").
    if (value instanceof SqlFragment) {
      return value.buildSql(context);
    }

    // A scalar subquery — it used to take the literal branch below and bind the Subquery OBJECT
    if (isSubqueryOperand(value)) {
      return `(${value.buildSql(context)})`;
    }

    if (this.isFieldRef(value)) {
      // Value is a field reference, use it with table alias if present
      if ('__tableAlias' in value && (value as any).__tableAlias) {
        return `"${(value as any).__tableAlias}"."${value.__dbColumnName}"`;
      }
      return `"${value.__dbColumnName}"`;
    } else {
      // Value is a literal, use a parameter
      // Apply toDriver mapper if the source field has one
      const mappedValue = applyToDriverMapper(value, getValueMapper(sourceField));
      context.params.push(mappedValue);
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
    protected value?: FieldLike<V> | V | Placeholder<any>
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
    this.collectOperandRefs(this.field, refs);
    if (this.value !== undefined) {
      this.collectOperandRefs(this.value, refs);
    }
    return refs;
  }

  /** The refs one operand reads: a fragment's tree, a subquery's correlation refs, a column. */
  protected collectOperandRefs(operand: unknown, refs: FieldRef[]): void {
    if (operand instanceof SqlFragment) {
      refs.push(...operand.getFieldRefs());
    } else if (isSubqueryOperand(operand)) {
      refs.push(...operand.getOuterFieldRefs());
    } else if (this.isFieldRef(operand)) {
      refs.push(operand);
    }
  }

  /**
   * Build the comparison SQL
   * Can be overridden for custom behavior
   */
  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field, context);
    const operator = this.getOperator();

    if (this.value !== undefined) {
      // Pass the field to getRightSide so it can apply toDriver mapper if present
      const rightSide = this.getRightSide(this.value, context, this.field);
      return `${fieldName} ${operator} ${rightSide}`;
    } else if (operator.startsWith('IS ')) {
      // Unary operators like IS NULL, IS NOT NULL
      return `${fieldName} ${operator}`;
    } else {
      // Binary operator with undefined value — would produce broken SQL like "field" >
      throw new Error(`Cannot use ${operator} operator with undefined value on field ${fieldName}. Pass an explicit value or use eq()/ne() which treat undefined as NULL.`);
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

    // A raw `sql` operand is the caller's text — `a OR b` inside an AND must keep its grouping.
    // NOT parenthesizes its operand anyway; comparisons, helpers and nested AND / OR group themselves.
    const parts = this.conditions.map(c => (this.operator !== 'not' && isRawSqlFragment(c)
      ? `(${c.buildSql(context)})`
      : c.buildSql(context)));

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

  /**
   * Override buildSql to handle null values correctly.
   * In SQL, `column = NULL` never matches anything (returns NULL, not TRUE).
   * We convert `eq(field, null)` to `field IS NULL` for correct semantics.
   */
  override buildSql(context: SqlBuildContext): string {
    // Handle null/undefined: eq(field, null) and eq(field, undefined) → IS NULL
    if (this.value === null || this.value === undefined) {
      const fieldName = this.getDbColumnName(this.field, context);
      return `${fieldName} IS NULL`;
    }
    return super.buildSql(context);
  }
}

export class NeComparison<V = any> extends WhereComparisonBase<V> {
  protected getOperator(): string {
    return '!=';
  }

  /**
   * Override buildSql to handle null values correctly.
   * In SQL, `column != NULL` never matches anything (returns NULL, not TRUE).
   * We convert `ne(field, null)` to `field IS NOT NULL` for correct semantics.
   */
  override buildSql(context: SqlBuildContext): string {
    // Handle null/undefined: ne(field, null) and ne(field, undefined) → IS NOT NULL
    if (this.value === null || this.value === undefined) {
      const fieldName = this.getDbColumnName(this.field, context);
      return `${fieldName} IS NOT NULL`;
    }
    return super.buildSql(context);
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

export class StartsWithComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return '^@';
  }
}

export class RegexMatchesComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return '~';
  }
}

export class RegexMatchesCaseInsensitiveComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return '~*';
  }
}

export class RegexNoMatchComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return '!~';
  }
}

export class RegexNoMatchCaseInsensitiveComparison extends WhereComparisonBase<string> {
  protected getOperator(): string {
    return '!~*';
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
    const fieldName = this.getDbColumnName(this.field, context);

    if (!Array.isArray(this.values) || this.values.length === 0) {
      return '1=0'; // No matches
    }

    // Apply toDriver mapper if the field has one
    const mapper = getValueMapper(this.field);
    const mappedValues = mapper
      ? this.values.map(v => applyToDriverMapper(v, mapper))
      : this.values;

    const params = mappedValues.map(() => `$${context.paramCounter++}`).join(', ');
    context.params.push(...mappedValues);
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
    const fieldName = this.getDbColumnName(this.field, context);

    if (!Array.isArray(this.values) || this.values.length === 0) {
      return '1=1'; // All match
    }

    // Apply toDriver mapper if the field has one
    const mapper = getValueMapper(this.field);
    const mappedValues = mapper
      ? this.values.map(v => applyToDriverMapper(v, mapper))
      : this.values;

    const params = mappedValues.map(() => `$${context.paramCounter++}`).join(', ');
    context.params.push(...mappedValues);
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
    this.collectOperandRefs(this.min, refs);
    this.collectOperandRefs(this.max, refs);
    return refs;
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field, context);
    // Pass the field to getRightSide so it can apply toDriver mapper
    const minSide = this.getRightSide(this.min, context, this.field);
    const maxSide = this.getRightSide(this.max, context, this.field);
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
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new EqComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function ne<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new NeComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function gt<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new GtComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function gte<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new GteComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function lt<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new LtComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function lte<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  value: FieldLike<V> | ScalarSubqueryOperand<V> | V | Placeholder<any> | undefined
): Condition {
  return new LteComparison<V>(field as FieldLike<V>, value as FieldLike<V> | V);
}

export function like<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  value: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new LikeComparison(field as FieldLike<string>, value as FieldLike<string> | string);
}

export function ilike<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  value: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new ILikeComparison(field as FieldLike<string>, value as FieldLike<string> | string);
}

export function startsWith<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  value: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new StartsWithComparison(field as FieldLike<string>, value as FieldLike<string> | string);
}

export function regexMatches<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  pattern: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new RegexMatchesComparison(field as FieldLike<string>, pattern as FieldLike<string> | string);
}

export function regexMatchesCaseInsensitive<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  pattern: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new RegexMatchesCaseInsensitiveComparison(field as FieldLike<string>, pattern as FieldLike<string> | string);
}

export function regexNoMatch<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  pattern: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new RegexNoMatchComparison(field as FieldLike<string>, pattern as FieldLike<string> | string);
}

export function regexNoMatchCaseInsensitive<T extends string>(
  field: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | T | undefined,
  pattern: FieldLike<string> | ScalarSubqueryOperand<string | null | undefined> | string | Placeholder<any> | undefined
): Condition {
  return new RegexNoMatchCaseInsensitiveComparison(field as FieldLike<string>, pattern as FieldLike<string> | string);
}

// ============================================================================
// Normalized (accent/case-insensitive) text search helpers
//
// All of these wrap their operands in `public.search_normalize(...)`, the
// IMMUTABLE function created by the migration system (see `ixNormalized` /
// `model.useSearchNormalize()`). They pair with `ixNormalized` expression
// indexes so the database can use the index for the comparison.
// ============================================================================

/**
 * Wrap a field or value in `public.search_normalize(...)`. Usable both inside a
 * `sql\`\`` template and as a building block for the normalized helpers below.
 *
 * Projected, it reads back as the text the function returns — a digits-only value such as
 * `'01'` stays the string `'01'`, NULL reads `null` (the driver value, like every helper whose
 * result type is explicit).
 *
 * @example
 * db.users.where(u => sql<boolean>`
 *   ${searchNormalize(u.username)} LIKE ${searchNormalize(containsSearch(query))}
 * `)
 */
export function searchNormalize<V = string>(
  value: FieldLike<V> | string | Placeholder<any>
): SqlFragment<string> {
  return new SqlFragment<string>(['public.search_normalize(', ')'], [value], DRIVER_VALUE_MAPPER);
}

/** Build a `%value%` (contains) LIKE pattern. */
export function containsSearch(value: string): string {
  return `%${value}%`;
}

/** Build a `value%` (starts-with) LIKE pattern. */
export function startsWithSearch(value: string): string {
  return `${value}%`;
}

/** Build a `%value` (ends-with) LIKE pattern. */
export function endsWithSearch(value: string): string {
  return `%${value}`;
}

/**
 * Accent/case-insensitive equality:
 * `(search_normalize(field) = search_normalize(value))` — parenthesized like every helper, so it stays
 * one operand wherever it is composed (`eq(flag, normalizedEq(…))` compared `flag = a = b`, a syntax error).
 */
export function normalizedEq<T extends string>(
  field: FieldLike<string> | T,
  value: FieldLike<string> | string | Placeholder<any>
): Condition {
  return new SqlFragment<boolean>(
    ['(', ' = ', ')'],
    [searchNormalize(field as any), searchNormalize(value)]
  );
}

/**
 * Accent/case-insensitive `LIKE`. The `pattern` is normalized too, so pass the
 * wildcards yourself (or build them with `containsSearch` / `startsWithSearch`):
 * `(search_normalize(field) LIKE search_normalize(pattern))`.
 */
export function normalizedLike<T extends string>(
  field: FieldLike<string> | T,
  pattern: FieldLike<string> | string | Placeholder<any>
): Condition {
  return new SqlFragment<boolean>(
    ['(', ' LIKE ', ')'],
    [searchNormalize(field as any), searchNormalize(pattern)]
  );
}

/**
 * Accent/case-insensitive prefix match. The wildcard is appended after
 * normalization, so callers pass a plain prefix:
 * `(search_normalize(field) LIKE search_normalize(value) || '%')`.
 */
export function normalizedStartsWith<T extends string>(
  field: FieldLike<string> | T,
  value: FieldLike<string> | string | Placeholder<any>
): Condition {
  return new SqlFragment<boolean>(
    ['(', ' LIKE ', " || '%')"],
    [searchNormalize(field as any), searchNormalize(value)]
  );
}

/**
 * `column IN ($1, $2, …)` — one placeholder per element.
 *
 * Renders the exact-length list, unless `LinkgressConfig.inArrayUsesOpt` is on: then
 * it renders whatever {@link inArrayOpt} would — the same `IN` list up to the
 * threshold, `= ANY($1::type[])` above it, and the configured pad-bucket widths in
 * between. Identical rows either way; only the statement text differs.
 *
 * The switch exists because `inArray` is the call a codebase already has everywhere,
 * and the statement-text economy is worth more applied to all of them than waiting on
 * a rewrite to `inArrayOpt`. Leave it off (the default) and this stays the literal
 * exact-length operator it has always been.
 */
export function inArray<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  values: V[]
): Condition {
  return inArrayUsesOpt
    ? renderInArrayOpt<T, V>(field as FieldLike<V>, values)
    : new InComparison<V>(field as FieldLike<V>, values);
}

/**
 * `column NOT IN ($1, $2, …)`, and the negated counterpart of {@link inArray} in
 * every respect — including obeying `LinkgressConfig.inArrayUsesOpt`, which routes it
 * through {@link notInArrayOpt}'s rendering.
 */
export function notInArray<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  values: V[]
): Condition {
  return inArrayUsesOpt
    ? renderNotInArrayOpt<T, V>(field as FieldLike<V>, values)
    : new NotInComparison<V>(field as FieldLike<V>, values);
}

// ============================================================================
// ANY / ALL array operators
// ============================================================================

/**
 * Column types with no usable array form of their own.
 *
 * The serial pseudo-types exist only in DDL — the column is stored as, and must
 * be compared as, the integer type behind them. `char` is remapped because
 * `char[]` means `character(1)[]`, which truncates every element to its first
 * character and then silently matches nothing; the internal name `bpchar`
 * carries no length limit.
 */
const ARRAY_ELEMENT_TYPE_OVERRIDES: Record<string, string> = {
  serial: 'integer',
  smallserial: 'smallint',
  bigserial: 'bigint',
  char: 'bpchar',
};

/**
 * The `::type[]` suffix for a value list bound against `column`, or ''.
 *
 * Resolved from the column FieldRef's `__sqlType` (attached by the schema-aware
 * mock builders) exactly like {@link flagMaskCast}, including for custom-mapped
 * columns — `mapWith()` overwrites the declared type with the mapper's own
 * `dataType()`, so an enum or vector column reports its real PostgreSQL type.
 *
 * Semantically the cast is optional: `col = ANY($1)` already resolves `$1` to
 * the column's array type by context. Spelling it out keeps the expression tree
 * deterministic across every way the statement is reproduced. Refs carrying no
 * type info (CTE columns, post-select shapes) and the element-less `array`
 * column type therefore stay bare rather than guess.
 */
function arrayElementCast(column: unknown): string {
  const sqlType = (column as { __sqlType?: string } | null)?.__sqlType;
  if (!sqlType || sqlType === 'array') return '';
  return `::${ARRAY_ELEMENT_TYPE_OVERRIDES[sqlType] ?? sqlType}[]`;
}

/**
 * Serialize `values` into the single array-literal parameter both operators bind,
 * applying the column's `toDriver` mapper per element first (as `inArray` does).
 */
function toArrayParameter<V>(column: unknown, values: readonly V[]): string {
  const mapper = getValueMapper(column);
  return toPgArrayLiteral(
    mapper ? values.map(value => applyToDriverMapper(value, mapper)) : values
  );
}

/**
 * `(column = ANY($1::type[]))` — membership against a list bound as ONE parameter.
 *
 * The array-form counterpart to {@link inArray}. `inArray` renders one
 * placeholder per element, so its statement text changes with the list length;
 * this binds the whole list as a single PostgreSQL array literal cast to the
 * column's declared element type, giving one statement text for every length.
 * That is what makes it reusable as a prepared statement — see
 * `QueryOptions.preparedStatements`, whose bounded-cache caveat about
 * `IN ($1, $2, …)` lists this operator exists to remove.
 *
 * The trade-off is planning, not correctness: a literal `IN` list tells the
 * planner exactly how many values it will see, while a parameter array falls
 * back to a default selectivity estimate. Prefer `inArray` for short lists in
 * queries you have hand-tuned; prefer `eqAny` for hot lookups whose list length
 * varies, and for lists large enough that the parameter count itself is a cost.
 *
 * An empty list yields `= ANY('{}')`, which is FALSE — the same result as
 * `inArray`'s `1=0`, without a second statement text.
 *
 * Parenthesized like every helper: a fragment is spliced into the expression it is an operand of as
 * it renders, and a bare `x = ANY(…)` compared with a column (`eq(flag, eqAny(…))`) read
 * `flag = x = ANY(…)` — a syntax error.
 *
 * @example
 * db.orderItems.where(oi => eqAny(oi.productPriceId, boundPriceIds))
 * // ("oi"."product_price_id" = ANY($1::integer[]))
 *
 * @example
 * // Navigation properties resolve their JOIN like any other condition
 * db.orderTasks.where(ot => eqAny(ot.task!.level!.id, levelIds))
 */
export function eqAny<V>(
  column: FieldLike<V> | DbColumn<V> | undefined,
  values: readonly V[]
): SqlFragment<boolean> {
  return new SqlFragment<boolean>(
    ['(', ' = ANY(', `${arrayElementCast(column)}))`],
    [column!, toArrayParameter(column, values)]
  );
}

/**
 * `(column <> ALL($1::type[]))` — the negation of {@link eqAny}, and the array-form
 * counterpart to {@link notInArray}.
 *
 * NULL semantics match `NOT IN` exactly: a NULL column, or a NULL anywhere in
 * the list, yields NULL and the row is filtered out. An empty list yields
 * `<> ALL('{}')`, which is TRUE — the same result as `notInArray`'s `1=1`.
 *
 * @example
 * db.orderItems.where(oi => neAll(oi.productPriceId, excludedPriceIds))
 * // ("oi"."product_price_id" <> ALL($1::integer[]))
 */
export function neAll<V>(
  column: FieldLike<V> | DbColumn<V> | undefined,
  values: readonly V[]
): SqlFragment<boolean> {
  return new SqlFragment<boolean>(
    ['(', ' <> ALL(', `${arrayElementCast(column)}))`],
    [column!, toArrayParameter(column, values)]
  );
}

// ============================================================================
// inArrayOpt / notInArrayOpt — IN list up to a threshold, ANY / ALL above it
// ============================================================================

/**
 * Default list length up to which {@link inArrayOpt} renders an `IN ($1, $2, …)` list.
 *
 * Why 8, measured on PostgreSQL 18 with named prepared statements (2026-09-06): a
 * short fixed-length `IN` text gets a cached generic plan after five executions,
 * while the `= ANY($1)` form is re-planned on every call for one- to ten-element
 * arrays (its generic plan has to assume ~10 elements, so the custom plan keeps
 * winning the cost comparison) and only reaches a generic plan from roughly 30
 * elements on. Up to the threshold the IN form is therefore both faster and cheap
 * to cache (at most eight small texts per family); above it the array form costs
 * nothing extra in planning and keeps ONE statement text per family instead of
 * one per list length.
 */
export const DEFAULT_IN_ARRAY_OPT_THRESHOLD = 8;

let inArrayOptThreshold = DEFAULT_IN_ARRAY_OPT_THRESHOLD;

/**
 * INTERNAL write path behind `LinkgressConfig.inArrayOptThreshold` (and the
 * `QueryOptions.inArrayOptThreshold` hook). Not part of the package surface —
 * consumers configure the threshold through `LinkgressConfig`. It lives here,
 * next to the variable {@link inArrayOpt} reads, so the hot-path read stays a
 * plain module-level variable access.
 *
 * Lists with up to `threshold` elements render as `IN (…)` / `NOT IN (…)`
 * placeholders; longer lists bind as one array parameter (`= ANY(…)` /
 * `<> ALL(…)`). `0` sends every non-empty list to the array form.
 *
 * @internal
 */
export function setInArrayOptThreshold(threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new Error(`inArrayOpt threshold must be a non-negative integer, got ${String(threshold)}`);
  }

  inArrayOptThreshold = threshold;
}

/**
 * INTERNAL read path behind `LinkgressConfig.inArrayOptThreshold`.
 *
 * @internal
 */
export function getInArrayOptThreshold(): number {
  return inArrayOptThreshold;
}

let inArrayUsesOpt = false;

/**
 * INTERNAL write path behind `LinkgressConfig.inArrayUsesOpt` (and the
 * `QueryOptions.inArrayUsesOpt` hook). Not part of the package surface.
 *
 * `true` makes the plain {@link inArray} / {@link notInArray} render exactly what
 * {@link inArrayOpt} / {@link notInArrayOpt} render, so a codebase that never adopted
 * the opt operators still gets one statement text per family. Default `false`, which
 * leaves both operators at the exact-length `IN` list they have always emitted.
 *
 * @internal
 */
export function setInArrayUsesOpt(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new Error(`inArrayUsesOpt must be a boolean, got ${String(enabled)}`);
  }

  inArrayUsesOpt = enabled;
}

/**
 * INTERNAL read path behind `LinkgressConfig.inArrayUsesOpt`.
 *
 * @internal
 */
export function getInArrayUsesOpt(): boolean {
  return inArrayUsesOpt;
}

/**
 * A ladder a consumer may install to collapse the sub-threshold band further.
 *
 * Below the threshold `inArrayOpt` renders one placeholder per element, so a
 * family whose lists range over 1…8 elements leaves eight statement texts — and
 * eight cached plans — on every pooled connection. Rounding each list up to the
 * next rung and repeating its last element to fill the gap turns that into one
 * text per rung, without changing which rows come back: `x IN (a, b, b)` selects
 * exactly what `x IN (a, b)` does, and so does the `NOT IN` form.
 *
 * Why these rungs, measured on PostgreSQL 18 with named prepared statements
 * (2026-09-06): widening is free at every width except the two smallest. Sending
 * a one-element list to a wider statement costs ~32 %, and a two-element list
 * ~26 %, because the cached plan is then costed for a list several times longer
 * than the one that arrives; from three elements up the same widening is free.
 * A ladder therefore wants its lowest rungs tight and may collapse everything
 * above — `[1, 4, 8]` keeps single-element lookups exact, accepts the cost on
 * two-element ones, and folds 3…8 into two texts. `[1, 2, 8]` is the variant
 * that pays nothing at all for the same number of texts.
 */
export const DEFAULT_IN_ARRAY_PAD_BUCKETS: readonly number[] = Object.freeze([1, 4, 8]);

let inArrayPadBuckets: readonly number[] | null = null;

/**
 * INTERNAL write path behind `LinkgressConfig.inArrayPadBuckets`. `null` (the
 * default) leaves every list at its own width.
 *
 * @internal
 */
export function setInArrayPadBuckets(buckets: readonly number[] | null | undefined): void {
  if (buckets === null || buckets === undefined) {
    inArrayPadBuckets = null;

    return;
  }

  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error('inArrayOpt pad buckets must be an array holding at least one rung, or null to disable padding');
  }

  for (const bucket of buckets) {
    if (!Number.isInteger(bucket) || bucket < 1) {
      throw new Error(`inArrayOpt pad buckets must each be a positive integer, got ${String(bucket)}`);
    }
  }

  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i] <= buckets[i - 1]) {
      throw new Error(`inArrayOpt pad buckets must be in strictly ascending order, got [${buckets.join(', ')}]`);
    }
  }

  inArrayPadBuckets = Object.freeze([...buckets]);
}

/**
 * INTERNAL read path behind `LinkgressConfig.inArrayPadBuckets`.
 *
 * @internal
 */
export function getInArrayPadBuckets(): readonly number[] | null {
  return inArrayPadBuckets;
}

/**
 * Widen `values` to the next configured rung, filling with its last element.
 *
 * Returns the list unchanged when no ladder is installed, when the list is
 * empty (there is no element to repeat, and the empty list already renders as a
 * constant), or when its length is already a rung. A list longer than the top
 * rung takes the threshold as the implied final rung, so raising the threshold
 * widens the ladder instead of dropping lengths out of it — every list that
 * reaches the `IN` branch lands on a bucket.
 */
function padToInArrayBucket<V>(values: readonly V[]): readonly V[] {
  const buckets = inArrayPadBuckets;

  // `inArrayOpt` forwards a non-array straight through so `inArray` can degrade
  // it to its constant; the ladder must not be the thing that throws on it.
  if (buckets === null || !Array.isArray(values) || values.length === 0) {
    return values;
  }

  const width = buckets.find(bucket => bucket >= values.length) ?? inArrayOptThreshold;

  if (width <= values.length) {
    return values;
  }

  const last = values[values.length - 1];
  const padded = values.slice() as V[];

  while (padded.length < width) {
    padded.push(last);
  }

  return padded;
}

/**
 * The `inArrayOpt` rendering itself, kept as a private function so that no caller of
 * it has to go through a public operator to reach it.
 *
 * Every path bottoms out here: {@link inArrayOpt} always, and {@link inArray} when
 * `inArrayUsesOpt` is on. Building the `InComparison` directly, rather than calling
 * `inArray` the way `inArrayOpt` used to, is what makes that switch safe — routed
 * through the public operator it would be `inArray` → `inArrayOpt` → `inArray` → …,
 * blowing the stack on the first short list. The duplication is one `new` expression
 * and it is deliberate; keep it that way.
 */
function renderInArrayOpt<T extends string, V>(
  column: FieldLike<V> | DbColumn<V> | T | undefined,
  values: readonly V[]
): Condition {
  if (!Array.isArray(values) || values.length <= inArrayOptThreshold) {
    return new InComparison<V>(
      (column as FieldLike<V> | T | undefined)!,
      padToInArrayBucket(values) as V[]
    );
  }

  return eqAny(column as FieldLike<V> | DbColumn<V> | undefined, values);
}

/** The `notInArrayOpt` rendering; {@link renderInArrayOpt} negated, and non-recursive for the same reason. */
function renderNotInArrayOpt<T extends string, V>(
  column: FieldLike<V> | DbColumn<V> | T | undefined,
  values: readonly V[]
): Condition {
  if (!Array.isArray(values) || values.length <= inArrayOptThreshold) {
    return new NotInComparison<V>(
      (column as FieldLike<V> | T | undefined)!,
      padToInArrayBucket(values) as V[]
    );
  }

  return neAll(column as FieldLike<V> | DbColumn<V> | undefined, values);
}

/**
 * List membership that picks the rendering by list length: {@link inArray}'s
 * `IN ($1, $2, …)` for lists up to the configured threshold, {@link eqAny}'s
 * `= ANY($1::type[])` above it. Same results as `inArray` for every list,
 * including the empty one (`1=0`) — only the statement text differs.
 *
 * The reason to prefer it over a bare `inArray` wherever the list comes from
 * data (cart contents, cache misses, id batches) is the prepared-statement
 * cache: every distinct list length is a distinct statement text, and a family
 * whose lists range over dozens of lengths keeps dozens of cached plans per
 * pooled connection. Constant lists (enum members) never exceed a sane
 * threshold and keep their exact-length `IN` text and planner estimate.
 *
 * @example
 * db.products.where(p => inArrayOpt(p.id, productIds));
 * // productIds.length <= 8:  "product"."id" IN ($1, $2, $3)
 * // productIds.length  > 8:  ("product"."id" = ANY($1::integer[]))
 */
export function inArrayOpt<T extends string, V>(
  column: FieldLike<V> | DbColumn<V> | T | undefined,
  values: readonly V[]
): Condition {
  return renderInArrayOpt<T, V>(column, values);
}

/**
 * The negated counterpart of {@link inArrayOpt}: {@link notInArray}'s
 * `NOT IN (…)` up to the threshold, {@link neAll}'s `<> ALL($1::type[])` above
 * it. Same results as `notInArray` for every list (empty list: `1=1`; a NULL
 * column or a NULL element filters the row out under both forms).
 */
export function notInArrayOpt<T extends string, V>(
  column: FieldLike<V> | DbColumn<V> | T | undefined,
  values: readonly V[]
): Condition {
  return renderNotInArrayOpt<T, V>(column, values);
}

export function isNull<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined
): Condition {
  return new IsNullComparison<V>(field as FieldLike<V>);
}

export function isNotNull<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined
): Condition {
  return new IsNotNullComparison<V>(field as FieldLike<V>);
}

export function between<T extends string, V>(
  field: FieldLike<V> | ScalarSubqueryOperand<V> | T | undefined,
  min: FieldLike<V> | ScalarSubqueryOperand<V> | V | undefined,
  max: FieldLike<V> | ScalarSubqueryOperand<V> | V | undefined
): Condition {
  return new BetweenComparison<V>(field as FieldLike<V>, min as FieldLike<V> | V, max as FieldLike<V> | V);
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
// COALESCE and JSONB operators
// ============================================================================

/**
 * Extract the underlying value type from a FieldLike or DbColumn
 */
type ExtractFieldValue<T> = T extends FieldLike<infer V>
  ? V
  : T extends DbColumn<infer V>
  ? V
  : T;

/**
 * COALESCE - returns the first non-null value from the arguments.
 * Accepts two or more arguments; each may be a column, SqlFragment or literal.
 *
 * @example
 * // Use in select
 * db.users.select(u => ({
 *   name: coalesce(u.displayName, u.username),
 * }))
 *
 * @example
 * // With literal fallback
 * db.users.select(u => ({
 *   status: coalesce(u.status, 'unknown'),
 * }))
 *
 * @example
 * // Use in update with a SqlFragment fallback for JSONB
 * db.orderItems.where(p => eq(p.id, id)).update({
 *   integrationInfo: sql`${coalesce(p.integrationInfo, sql`'{}'::jsonb`)} || ${patch}::jsonb`,
 * })
 */
export function coalesce<T1, T2>(
  value1: FieldLike<T1> | T1,
  value2: FieldLike<T2> | T2
): SqlFragment<NonNullable<ExtractFieldValue<T1>> | ExtractFieldValue<T2>>;
export function coalesce<T1, T2, TRest extends any[]>(
  value1: FieldLike<T1> | T1,
  value2: FieldLike<T2> | T2,
  ...rest: TRest
): SqlFragment<NonNullable<ExtractFieldValue<T1>> | ExtractFieldValue<T2>>;
export function coalesce(
  value1: any,
  value2: any,
  ...rest: any[]
): SqlFragment<any> {
  const all = [value1, value2, ...rest];
  // Build parts: 'COALESCE(', ', ', ', ', ..., ')'
  const parts: string[] = ['COALESCE('];
  for (let i = 1; i < all.length; i++) {
    parts.push(', ');
  }
  parts.push(')');

  const mapper = pickResultMapper(all);
  const values = mapper
    ? all.map(value => isSqlFragmentLiteral(value) ? applyToDriverMapper(value, mapper) : value)
    : all;

  return new SqlFragment<any>(parts, values, mapper);
}

/**
 * JSONB merge helper - emits `(COALESCE(target, '{}'::jsonb) || (patch)::jsonb)`.
 *
 * Convenience wrapper for the common pattern of merging a JSONB patch onto a
 * column that may be null. Safe under concurrent writes because the `||`
 * operator is evaluated atomically by PostgreSQL per row.
 *
 * The patch is parenthesised before its cast, so a compound patch (`sql\`${a} || ${b}\``)
 * is cast as a whole — without the parentheses the cast bound to its last operand only. The whole
 * merge is parenthesised too, so it stays ONE operand of whatever it is composed with: bare,
 * `jsonbRemoveKey(jsonbMerge(t, p), 'k')` read `t || (p - 'k')` (the key of `t` survived) and
 * `concatStrict('x', jsonbMerge(t, p))` concatenated the two documents' texts.
 *
 * @param target - The JSONB column (or SqlFragment) to merge onto. May be null.
 *                 Accept the column proxy directly (e.g. `p.integrationInfo`) — at
 *                 runtime it is a FieldRef even though TypeScript sees the value type.
 * @param patch  - The JSONB object literal (or SqlFragment) to merge in.
 *
 * @example
 * // Atomic JSONB merge in update (note: must use the function form so `p` is
 * // the column proxy — bare `update({...})` lacks the proxy).
 * db.orderItems.where(p => eq(p.id, id)).update(p => ({
 *   integrationInfo: jsonbMerge(p.integrationInfo, patch),
 * }))
 */
export function jsonbMerge<T extends object = any>(
  target: FieldLike<T | null | undefined> | SqlFragment<T | null | undefined> | T | null | undefined,
  patch: FieldLike<T> | SqlFragment<T> | T
): SqlFragment<T> {
  return new SqlFragment<T>(
    ['(COALESCE(', `, '{}'::jsonb) || (`, ')::jsonb)'],
    [target, patch]
  );
}

/**
 * Type helper to extract property type from an object type
 */
type PropertyType<T, K extends keyof T> = T[K];

// ============================================================================
// Arithmetic operators
// ============================================================================

/**
 * Build a parenthesised infix arithmetic fragment from the given operands.
 * Mapper handling mirrors `coalesce`: the first operand-provided mapper wins and
 * is applied to plain literals so they bind in driver representation.
 */
function arithmetic(operator: string, operands: any[]): SqlFragment<number> {
  // Build parts: '(', ' + ', ' + ', ..., ')'
  const parts: string[] = ['('];
  for (let i = 1; i < operands.length; i++) {
    parts.push(operator);
  }
  parts.push(')');

  const mapper = pickResultMapper(operands);
  const values = mapper
    ? operands.map(value => isSqlFragmentLiteral(value) ? applyToDriverMapper(value, mapper) : value)
    : operands;

  return new SqlFragment<number>(parts, values, mapper);
}

/**
 * Addition - emits `(a + b + ...)`.
 * Accepts two or more operands; each may be a column, SqlFragment or literal.
 *
 * The result is always parenthesised so it nests safely inside other
 * expressions. NULL semantics are unchanged: `NULL + 1` is `NULL` in SQL, so
 * combine with `coalesce` when a null operand should read as zero.
 *
 * @example
 * // Use in select
 * db.posts.select(p => ({
 *   score: add(p.views, p.commentCount),
 * }))
 *
 * @example
 * // Conditional increment in update — no raw sql template needed
 * db.discountCodes.where(c => eq(c.id, id)).update(c => ({
 *   usedCount: add(c.usedCount, n),
 * }))
 *
 * @example
 * // Compose with coalesce when an operand may be NULL
 * db.users.select(u => ({
 *   total: add(u.age, coalesce(u.bonusYears, 0)),
 * }))
 */
export function add<T1, T2, TRest extends any[]>(
  value1: FieldLike<T1> | T1,
  value2: FieldLike<T2> | T2,
  ...rest: TRest
): SqlFragment<number> {
  return arithmetic(' + ', [value1, value2, ...rest]);
}

/**
 * Multiplication - emits `(a * b * ...)`.
 * Accepts two or more operands; each may be a column, SqlFragment or literal.
 *
 * The result is always parenthesised, so mixing precedence levels is safe:
 * `add(a, mul(b, c))` emits `(a + (b * c))`. NULL semantics are unchanged.
 *
 * @example
 * // Line total in select
 * db.orderItems.select(i => ({
 *   lineTotal: mul(i.quantity, i.unitPrice),
 * }))
 */
export function mul<T1, T2, TRest extends any[]>(
  value1: FieldLike<T1> | T1,
  value2: FieldLike<T2> | T2,
  ...rest: TRest
): SqlFragment<number> {
  return arithmetic(' * ', [value1, value2, ...rest]);
}

/**
 * Subtraction - emits `(left - right)`.
 *
 * Deliberately binary rather than variadic: subtraction is left-associative, so
 * a variadic form reads ambiguously. Nest explicitly for longer chains —
 * `sub(sub(a, b), c)`. NULL semantics are unchanged.
 *
 * @example
 * // Remaining capacity in select
 * db.events.select(e => ({
 *   remaining: sub(e.capacity, e.soldCount),
 * }))
 *
 * @example
 * // Decrement in update
 * db.products.where(p => eq(p.id, id)).update(p => ({
 *   stock: sub(p.stock, quantity),
 * }))
 */
export function sub<T1, T2>(
  left: FieldLike<T1> | T1,
  right: FieldLike<T2> | T2
): SqlFragment<number> {
  return arithmetic(' - ', [left, right]);
}

/**
 * Division - emits `(left / right)`.
 *
 * Deliberately binary rather than variadic: division is left-associative, so a
 * variadic form reads ambiguously. Nest explicitly for longer chains —
 * `div(div(a, b), c)`. NULL semantics are unchanged, and PostgreSQL integer
 * division still truncates — cast an operand if you need a fractional result.
 *
 * @example
 * // Average price per unit, guarding the divisor with coalesce
 * db.orders.select(o => ({
 *   perUnit: div(o.totalAmount, coalesce(o.itemCount, 1)),
 * }))
 */
export function div<T1, T2>(
  left: FieldLike<T1> | T1,
  right: FieldLike<T2> | T2
): SqlFragment<number> {
  return arithmetic(' / ', [left, right]);
}

// ============================================================================
// Flag/Bitmask Operators
// ============================================================================

/**
 * Explicit mask cast per integer width, resolved from the column FieldRef's
 * `__sqlType` (attached by the schema-aware mock builders).
 *
 * Semantically NO cast is needed: an untyped bind parameter is already
 * inferred to the column's width by describe, so `int2 & $1` resolves the
 * int2 operator and the column is never converted. The cast exists to make
 * the emitted SQL carry that fact EXPLICITLY, so the expression tree is
 * deterministic across every way the statement is (re)produced — the same
 * predicate inlined with a bare int4 literal promotes the COLUMN instead
 * (`(col)::integer & 1`), a different tree that expression statistics built
 * for the runtime form do not match. int4 columns need no annotation (a bare
 * parameter and a bare literal both land on int4). Columns whose refs carry
 * no type info (CTE columns, post-select shapes) keep the historical
 * uncast emission.
 */
const FLAG_MASK_CAST_BY_TYPE: Record<string, string> = {
  smallint: '::smallint',
  bigint: '::bigint',
};

/** The `::type` suffix for a flag mask bound against `column`, or ''. */
function flagMaskCast(column: unknown): string {
  const sqlType = (column as { __sqlType?: string } | null)?.__sqlType;
  return sqlType ? FLAG_MASK_CAST_BY_TYPE[sqlType] ?? '' : '';
}

/**
 * Creates a SQL condition to check if a flag is set in a numeric column
 * Uses bitwise AND to check if the specific bit is non-zero: `((column & $1) != 0)`.
 *
 * The flag predicates are parenthesised as a whole, like every helper: bare, `(column & $1) != 0`
 * compared with a column (`eq(active, flagHas(…))`) was a syntax error, and as an IN / BETWEEN
 * subject it bound its `!= 0` to the IN list.
 *
 * @param column - The numeric column containing flags
 * @param flag - The flag value to check for
 * @returns SqlFragment<boolean> that evaluates to true if the flag is set
 *
 * @example
 * enum UserStateFlags {
 *   Active = 1,
 *   Verified = 2,
 *   Admin = 4,
 * }
 * db.users.where(u => flagHas(u.state, UserStateFlags.Active))
 */
export function flagHas<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flag: T
): SqlFragment<boolean> {
  return new SqlFragment<boolean>(
    ['((', ' & ', `${flagMaskCast(column)}) != 0)`],
    [column, flag]
  );
}

/**
 * Creates a SQL condition to check if ALL specified flags are set
 * Uses bitwise AND and checks if result equals the flags value
 *
 * @param column - The numeric column containing flags
 * @param flags - The combined flag values to check for (use | to combine)
 * @returns SqlFragment<boolean> that evaluates to true if all flags are set
 *
 * @example
 * db.users.where(u => flagHasAll(u.state, UserStateFlags.Active | UserStateFlags.Verified))
 */
export function flagHasAll<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flags: T
): SqlFragment<boolean> {
  const cast = flagMaskCast(column);
  return new SqlFragment<boolean>(
    ['((', ' & ', `${cast}) = `, `${cast})`],
    [column, flags, flags]
  );
}

/**
 * Creates a SQL condition to check if ANY of the specified flags is set
 * Uses bitwise AND to check if any of the bits are non-zero
 *
 * @param column - The numeric column containing flags
 * @param flags - The combined flag values to check for (use | to combine)
 * @returns SqlFragment<boolean> that evaluates to true if any flag is set
 *
 * @example
 * db.users.where(u => flagHasAny(u.state, UserStateFlags.Slave | UserStateFlags.Unsynced))
 */
export function flagHasAny<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flags: T
): SqlFragment<boolean> {
  return new SqlFragment<boolean>(
    ['((', ' & ', `${flagMaskCast(column)}) != 0)`],
    [column, flags]
  );
}

/**
 * Creates a SQL condition to check if a flag is NOT set
 * Uses bitwise AND to check if the specific bit is zero
 *
 * @param column - The numeric column containing flags
 * @param flag - The flag value to check is not set
 * @returns SqlFragment<boolean> that evaluates to true if the flag is not set
 *
 * @example
 * db.users.where(u => flagHasNone(u.state, UserStateFlags.Banned))
 */
export function flagHasNone<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flag: T
): SqlFragment<boolean> {
  return new SqlFragment<boolean>(
    ['((', ' & ', `${flagMaskCast(column)}) = 0)`],
    [column, flag]
  );
}

/**
 * Value-side flag SET for UPDATE assignments — emits `(column | $mask)` so a
 * flag flip is ONE atomic statement with no read: the read-modify-write
 * alternative (SELECT flags → OR in JS → UPDATE) costs two roundtrips and
 * carries a lost-update window. Idempotent by bit algebra. The mask carries
 * the same column-width cast as the condition operators (`flagMaskCast`), so
 * the emitted expression tree stays deterministic on int2/int8 columns.
 *
 * @param column - The numeric flags column being reassigned
 * @param flags - The flag bit(s) to set (use | to combine)
 * @returns SqlFragment<T> usable as an UPDATE assignment value
 *
 * @example
 * db.orders.where(o => eq(o.id, id)).update(o => ({
 *   workflowFlags: flagSet(o.workflowFlags, OrderWorkflowFlag.COMPLETED),
 * }))
 */
export function flagSet<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flags: T
): SqlFragment<T> {
  return new SqlFragment<T>(
    ['(', ' | ', `${flagMaskCast(column)})`],
    [column, flags]
  );
}

/**
 * Value-side flag CLEAR for UPDATE assignments — emits `(column & ~($mask))`.
 * The complement of {@link flagSet}: one atomic statement, no read, clearing
 * an absent bit is a no-op.
 *
 * Mask cast rules differ from `flagSet` in ONE way: the mask is ALWAYS cast,
 * falling back to `::integer` when the column ref carries no width type.
 * Unlike `col & $1` (where the column operand fixes the parameter's type),
 * `~($1)` presents the bare parameter to the operator alone and Postgres
 * rejects it as ambiguous (`operator is not unique: ~ unknown`). Width-typed
 * refs keep their exact `::smallint` / `::bigint` cast; the int4 fallback
 * promotes cleanly against any integer column.
 *
 * @param column - The numeric flags column being reassigned
 * @param flags - The flag bit(s) to clear (use | to combine)
 * @returns SqlFragment<T> usable as an UPDATE assignment value
 *
 * @example
 * db.users.where(u => eq(u.id, id)).update(u => ({
 *   state: flagUnset(u.state, UserStateFlags.Banned),
 * }))
 */
export function flagUnset<T extends number>(
  column: FieldLike<T> | DbColumn<T>,
  flags: T
): SqlFragment<T> {
  const cast = flagMaskCast(column) || '::integer';
  return new SqlFragment<T>(
    ['(', ' & ~(', `${cast}))`],
    [column, flags]
  );
}

/**
 * JSONB property selector - extracts a property from a JSONB column
 * Uses the -> operator for JSONB extraction
 *
 * @param jsonbField - The JSONB column to extract from
 * @param key - The property key to extract (typed as keyof TJsonb)
 * @returns SqlFragment that extracts the property as JSONB
 *
 * @example
 * // Given a JSONB column 'metadata' with structure { priority: number, tags: string[] }
 * type Metadata = { priority: number; tags: string[] };
 * db.tasks.select(t => ({
 *   priority: jsonbSelect<Metadata>(t.metadata, 'priority'),
 * }))
 *
 * @example
 * // Use in where clause
 * db.tasks.where(t => eq(jsonbSelect<Metadata>(t.metadata, 'priority'), 'high'))
 */
export function jsonbSelect<TJsonb, TKey extends keyof TJsonb & string = keyof TJsonb & string>(
  jsonbField: FieldLike<any> | DbColumn<any> | undefined,
  key: TKey
): SqlFragment<TJsonb[TKey]> {
  // Build the JSONB extraction SQL: ((column #>> '{}')::jsonb->'propertyName')
  // This converts JSONB to text, then back to JSONB, then extracts the property.
  // The key is inlined as a properly quoted literal (a quote in the key used to break out
  // of it). For a plain `->` path without the text round trip, use jsonbPath().
  // Parenthesised as a whole: bare, `->` took the right operand of a `||` / `@>` it was composed
  // under as its own left operand, and a `::type` written after it cast the KEY.
  return new SqlFragment<TJsonb[TKey]>(
    ['((', ` #>> '{}')::jsonb->${quoteSqlLiteral(key)})`],
    [jsonbField]
  ).as(key);
}

/**
 * JSONB text property selector - extracts a property from a JSONB column as text
 * Uses the ->> operator for direct text extraction
 *
 * @param jsonbField - The JSONB column to extract from
 * @param key - The property key to extract (typed as keyof TJsonb)
 * @returns SqlFragment that extracts the property as text (string)
 *
 * @example
 * type Metadata = { priority: string };
 * db.tasks.select(t => ({
 *   priorityText: jsonbSelectText<Metadata>(t.metadata, 'priority'),
 * }))
 */
export function jsonbSelectText<TJsonb, TKey extends keyof TJsonb & string = keyof TJsonb & string>(
  jsonbField: FieldLike<any> | DbColumn<any> | undefined,
  key: TKey
): SqlFragment<string> {
  // Build the JSONB text extraction SQL: (column->>'propertyName') (the key quoted as a literal),
  // parenthesised so it stays one operand: `concatStrict(x, jsonbSelectText(…))` read `(x || column)->>'k'`
  return new SqlFragment<string>(
    ['(', `->>${quoteSqlLiteral(key)})`],
    [jsonbField]
  ).as(key);
}

// ============================================================================
// JSONB array querying — jsonbArraySome
// ============================================================================

/**
 * Recursive mapped type for navigating into a JSONB object.
 * Each property returns a type that can be:
 * - Used directly as a field in conditions (eq, ne, like, isNotNull, etc.)
 * - Navigated further for nested objects (e.g. `c.config.token`)
 *
 * Values are compared as text (PostgreSQL ->> operator) which works naturally
 * with string, number, and boolean comparisons via the pg driver's text protocol.
 */
export type JsonbElement<T> = SqlFragment<T> & {
  readonly [K in keyof T]-?: JsonbElement<NonNullable<T[K]>>;
};

/**
 * Creates a typed proxy that represents a JSONB array element for path navigation.
 * Each property access builds a deeper JSONB path expression using -> and ->> operators.
 * The result at any level is both a SqlFragment (for use in conditions) and a Proxy
 * for further navigation.
 *
 * @internal
 */
function createJsonbElementProxy<T>(alias: string, path: string[] = []): JsonbElement<T> {
  // Build the ->> expression for the current path
  // Uses -> for intermediate segments, ->> for the last segment (text extraction), parenthesised
  // like every helper's operator expression: `startsWith(x, e.prefix)` read `(x ^@ __elem)->>'prefix'`
  const buildExpression = (): string => {
    if (path.length === 0) return alias;
    let expr = alias;
    for (let i = 0; i < path.length - 1; i++) {
      expr += `->${quoteSqlLiteral(path[i])}`;
    }
    expr += `->>${quoteSqlLiteral(path[path.length - 1])}`;
    return `(${expr})`;
  };

  // Create a SqlFragment for this path (pure SQL text, no interpolated values)
  const fragment = new SqlFragment<string>([buildExpression()], []);

  // Proxy it: own properties delegate to SqlFragment, unknown properties extend the JSONB path
  return new Proxy(fragment, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === 'string') {
        return createJsonbElementProxy<any>(alias, [...path, prop]);
      }
      return Reflect.get(target, prop, receiver);
    }
  }) as any;
}

/**
 * Condition that checks if any element in a JSONB array matches a predicate.
 * Generates: EXISTS (SELECT 1 FROM jsonb_array_elements(field) AS __elem WHERE ...)
 *
 * @internal
 */
class JsonbArraySomeCondition extends WhereConditionBase {
  constructor(
    private jsonbField: any,
    private innerCondition: WhereConditionBase
  ) {
    super();
  }

  override getFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    if (this.isFieldRef(this.jsonbField)) {
      refs.push(this.jsonbField);
    } else if (this.jsonbField instanceof SqlFragment) {
      refs.push(...this.jsonbField.getFieldRefs());
    }
    return refs;
  }

  buildSql(context: SqlBuildContext): string {
    let fieldSql: string;
    if (this.jsonbField instanceof SqlFragment) {
      fieldSql = this.jsonbField.buildSql(context);
    } else if (this.isFieldRef(this.jsonbField)) {
      if ('__tableAlias' in this.jsonbField && this.jsonbField.__tableAlias) {
        fieldSql = `"${this.jsonbField.__tableAlias}"."${this.jsonbField.__dbColumnName}"`;
      } else {
        fieldSql = `"${this.jsonbField.__dbColumnName}"`;
      }
    } else {
      fieldSql = `"${this.jsonbField}"`;
    }

    const whereSql = this.innerCondition.buildSql(context);

    // `jsonb_array_elements` is strict about its input: an object raises
    // "cannot extract elements from an object", a scalar "…from a scalar".
    // JSONB columns are schema-less, so a single row holding `{}` or `"x"` —
    // from a migration, a hand-fix, or a double-encoded write — would abort the
    // whole statement instead of simply not matching. Feeding the function
    // through CASE keeps it looking at an array on every row; non-arrays
    // collapse to `[]` and contribute no elements, which is the same answer
    // SQL NULL already produced. CASE is one of the constructs PostgreSQL
    // guarantees to evaluate branch-wise, so the ELSE arm genuinely shields
    // the call rather than relying on AND short-circuiting, which the planner
    // is free to reorder.
    const elementsSql = `CASE WHEN jsonb_typeof(${fieldSql}) = 'array' THEN ${fieldSql} ELSE '[]'::jsonb END`;

    return `EXISTS (SELECT 1 FROM jsonb_array_elements(${elementsSql}) AS __elem WHERE ${whereSql})`;
  }
}

/**
 * Check if any element in a JSONB array matches a predicate.
 * Generates an EXISTS subquery with jsonb_array_elements.
 *
 * The callback receives a typed proxy where each property access builds
 * a JSONB path expression (using ->> for text extraction). Use standard
 * condition functions (eq, ne, like, isNotNull, etc.) on the proxy properties.
 *
 * Rows whose column does not actually hold a JSON array (an object, a scalar,
 * or SQL NULL) simply do not match — they never raise. See the emitted SQL
 * below: the element source is guarded, because `jsonb_array_elements` would
 * otherwise abort the entire statement on the first such row.
 *
 * @example
 * ```typescript
 * // Shelves carrying a 'fiction' tag that also records a reference
 * db.shelves.where(s =>
 *   jsonbArraySome<ShelfTag>(s.tags, t =>
 *     and(
 *       eq(t.kind, 'fiction'),
 *       isNotNull(t.meta.ref)
 *     )
 *   )
 * )
 * // → WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(
 * //       CASE WHEN jsonb_typeof("shelf"."tags") = 'array' THEN "shelf"."tags" ELSE '[]'::jsonb END
 * //     ) AS __elem
 * //     WHERE ((__elem->>'kind') = $1 AND (__elem->'meta'->>'ref') IS NOT NULL))
 * ```
 */
export function jsonbArraySome<T>(
  jsonbField: FieldLike<T[]> | FieldLike<any> | DbColumn<T[]> | DbColumn<any> | undefined,
  predicate: (element: JsonbElement<T>) => Condition
): Condition {
  const elementProxy = createJsonbElementProxy<T>('__elem');
  const condition = predicate(elementProxy);
  return new JsonbArraySomeCondition(jsonbField, condition as WhereConditionBase);
}

/**
 * Converts a value to its string representation for JSONB text comparisons.
 * The PostgreSQL ->> operator always returns text, so comparison values must be strings.
 *
 * @example
 * ```typescript
 * // ShelfKind.Fiction is a numeric enum member; ->> yields text, so unwrap it
 * jsonbArraySome<ShelfTag>(s.tags, t =>
 *   eq(t.kind, jsonbConditionUnwrap(ShelfKind.Fiction))
 * )
 * ```
 */
export function jsonbConditionUnwrap<T>(value: T): T {
  return String(value) as any;
}

// ============================================================================
// Literal quoting and type casts
// ============================================================================

/**
 * Quote a JS string as a PostgreSQL string literal: `'it''s'`.
 *
 * Correct whatever `standard_conforming_strings` is set to: a string containing a backslash
 * is emitted in the escape-string form with the backslashes doubled (`E'a\\b'`), exactly
 * like PostgreSQL's own `quote_literal()`. NUL cannot be represented in a PostgreSQL text
 * value at all and is refused.
 */
export function quoteSqlLiteral(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`quoteSqlLiteral expects a string, got ${typeof value}`);
  }

  if (value.includes('\u0000')) {
    throw new Error('A PostgreSQL string literal cannot contain the NUL character (\\u0000)');
  }

  const quoted = value.replace(/'/g, "''");

  return value.includes('\\')
    ? `E'${quoted.replace(/\\/g, '\\\\')}'`
    : `'${quoted}'`;
}

/**
 * PostgreSQL type names the cast helpers are commonly given — listed for editor completion;
 * any other valid type name (an enum, a domain, `numeric(12, 2)`, `varchar(64)[]`) is accepted.
 */
export type PgCastType =
  | 'integer' | 'int' | 'int4' | 'smallint' | 'int2' | 'bigint' | 'int8'
  | 'numeric' | 'decimal' | 'real' | 'float4' | 'double precision' | 'float8'
  | 'text' | 'varchar' | 'char' | 'bpchar' | 'citext'
  | 'boolean' | 'bool'
  | 'date' | 'time' | 'timetz' | 'timestamp' | 'timestamptz' | 'interval'
  | 'json' | 'jsonb' | 'jsonpath' | 'uuid' | 'bytea' | 'inet' | 'cidr'
  | 'integer[]' | 'bigint[]' | 'smallint[]' | 'text[]' | 'varchar[]' | 'uuid[]' | 'numeric[]' | 'boolean[]' | 'jsonb[]'
  | (string & {});

/** An identifier: plain (`int4`, `my_enum`) or double-quoted (`"Status"`). */
const PG_TYPE_IDENT = '(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"\\u0000]+")';

/**
 * A type name as it may follow `CAST(x AS …)`: optionally schema-qualified, possibly several
 * words (`double precision`, `character varying`, `timestamp with time zone`), an optional
 * `(n)` / `(p, s)` modifier and any number of `[]` / `[n]` array suffixes.
 *
 * The type name is inlined into the SQL text (a type cannot be a bind parameter), so it is
 * validated against this shape instead of being trusted.
 */
const PG_TYPE_NAME_PATTERN = new RegExp(
  `^(?:${PG_TYPE_IDENT}\\.)?${PG_TYPE_IDENT}(?: [A-Za-z_][A-Za-z0-9_$]*)*`
  + '(?:\\s*\\(\\s*\\d+\\s*(?:,\\s*-?\\d+\\s*)?\\))?'
  + '(?:\\s*\\[\\d*\\])*$'
);

/**
 * Validate a PostgreSQL type name for inlining into a cast; returns it trimmed.
 * Throws on anything that is not shaped like a type name.
 */
export function assertPgTypeName(pgType: string): string {
  const trimmed = typeof pgType === 'string' ? pgType.trim() : '';

  if (!trimmed || !PG_TYPE_NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid PostgreSQL type name for a cast: ${JSON.stringify(pgType)}`);
  }

  return trimmed;
}

/** Base type of a (possibly array, possibly parameterised) type name, lower-cased: `varchar(64)[]` → `varchar`. */
function baseTypeName(pgType: string): string {
  return pgType.replace(/(?:\s*\[\d*\])+$/, '').replace(/\s*\(.*\)$/, '').trim().toLowerCase();
}

function isJsonTypeName(pgType: string): boolean {
  if (/\[\d*\]\s*$/.test(pgType)) {
    return false;
  }

  const base = baseTypeName(pgType);
  return base === 'json' || base === 'jsonb';
}

/**
 * True for a plain JS value — anything that would bind as a parameter — as opposed to a
 * column ref, a fragment, a condition, a placeholder, raw SQL or a subquery.
 */
export function isPlainSqlValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value !== 'object') {
    return typeof value !== 'function';
  }

  return !(
    '__dbColumnName' in (value as object)
    || value instanceof WhereConditionBase
    || value instanceof Placeholder
    || value instanceof RawSql
    || typeof (value as any).buildSql === 'function'
    || '__collectionResult' in (value as object)
  );
}

function assertTypeModifier(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

/** `numeric`, `numeric(p)` or `numeric(p, s)`. @internal */
export function numericTypeName(precision?: number, scale?: number): string {
  if (precision === undefined) {
    if (scale !== undefined) {
      throw new Error('numeric scale needs a precision');
    }
    return 'numeric';
  }

  assertTypeModifier('numeric precision', precision, 1);

  if (scale === undefined) {
    return `numeric(${precision})`;
  }

  assertTypeModifier('numeric scale', scale, 0);
  return `numeric(${precision}, ${scale})`;
}

/** `varchar` or `varchar(n)`. @internal */
export function varcharTypeName(length?: number): string {
  if (length === undefined) {
    return 'varchar';
  }

  assertTypeModifier('varchar length', length, 1);
  return `varchar(${length})`;
}

/**
 * Result mapper that keeps the driver's value exactly as it arrives (NULL stays null).
 *
 * A fragment WITHOUT a mapper goes through the generic result conversion, which turns every
 * numeric-looking string into a number (built for untyped aggregates) — a text value such as
 * '01234' would come back as 1234. Helpers whose result type is explicit (casts, string
 * functions, JSON paths, literals) carry this mapper instead, so the value is the one the
 * statement produced.
 * @internal
 */
export const DRIVER_VALUE_MAPPER = Object.freeze({
  fromDriver: (value: unknown) => value,
});

/**
 * The result mapper of an expression over several operands (COALESCE, arithmetic, CASE, …):
 * the first REAL mapper an operand carries (a column's custom type) wins; failing that, the
 * driver-value mapper if an operand carries it; else none.
 * @internal
 */
export function pickResultMapper(values: readonly unknown[]): any | undefined {
  let fallback: any;

  for (const value of values) {
    const mapper = getValueMapper(value);
    if (!mapper) {
      continue;
    }
    if (mapper !== DRIVER_VALUE_MAPPER) {
      return mapper;
    }
    fallback = mapper;
  }

  return fallback;
}

/**
 * `CAST(value AS pgType)` — the one cast renderer behind `cast()`, every `castAs*()` helper
 * and the fluent `SqlFragment.cast*()` methods.
 *
 * - A column or fragment is cast as an expression.
 * - A plain JS value binds as ONE parameter and the cast types it — a typed parameter
 *   (`CAST($1 AS bigint)`); JS objects and arrays cast to `json`/`jsonb` are serialized with
 *   `JSON.stringify` first, because the drivers would otherwise send a JS array as a
 *   PostgreSQL array literal; a JS array cast to an array type (`int[]`) binds as that array
 *   literal, which every driver accepts.
 * - `null` / `undefined` render a typed NULL: `CAST(NULL AS text)`.
 *
 * The CAST(...) spelling needs no parentheses around a compound expression and is the same
 * expression tree PostgreSQL builds for `x::type`, so it matches expression indexes written
 * either way.
 *
 * The result is read back exactly as the driver returns the target type (NULL stays null):
 * numbers for integer / double types, strings for text, numeric and int8, parsed JSON for
 * json / jsonb.
 */
export function castTo<T = unknown>(value: unknown, pgType: PgCastType): SqlFragment<T> {
  const type = assertPgTypeName(pgType);

  if (value === null || value === undefined) {
    return new SqlFragment<T>([`CAST(NULL AS ${type})`], [], DRIVER_VALUE_MAPPER);
  }

  const bound = isJsonTypeName(type) && isPlainSqlValue(value) && typeof value === 'object' && !(value instanceof Date)
    ? JSON.stringify(value)
    // A JS array cast to an array type binds as its array LITERAL — the form every driver accepts
    // (Bun's SQL client cannot bind a JS array to an array parameter at all)
    : Array.isArray(value) && type.endsWith('[]')
      ? toPgArrayLiteral(value)
      : value;

  if (typeof bound === 'string' && isJsonTypeName(type)) {
    // JSON text binds as TEXT and is parsed by the cast. A parameter PostgreSQL types as json /
    // jsonb is serialized by its type on drivers that do so (postgres.js JSON-encodes it once more),
    // which stored the document as a JSON string: `->>` read null, `@>` never matched
    return new SqlFragment<T>(['CAST(CAST(', ` AS text) AS ${type})`], [bound], DRIVER_VALUE_MAPPER);
  }

  return new SqlFragment<T>(['CAST(', ` AS ${type})`], [bound], DRIVER_VALUE_MAPPER);
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
  /** The SQL type a projection reads this value as (see {@link withReadType}); no mapper then. */
  private readType?: string;

  constructor(parts: string[], values: any[], mapper?: any, alias?: string) {
    super();
    this.sqlParts = parts;
    this.values = values;
    this.mapper = mapper;
    this.alias = alias;
  }

  /**
   * A copy of this fragment with another mapper / alias / read type. A SUBCLASS renders and reports
   * its refs its own way (`ExistsCondition` has no parts of its own — it overrides `buildSql`), so
   * its copy wraps it and delegates to it: rebuilt from the (empty) parts, `exists(sub).as('x')`
   * used to render nothing at all (`,  as "x"`) and to lose the subquery's outer refs.
   */
  private derive<U>(mapper: any, alias: string | undefined, readType: string | undefined): SqlFragment<U> {
    const copy = this.constructor === SqlFragment
      ? new SqlFragment<U>(this.sqlParts, this.values, mapper, alias)
      : new SqlFragment<U>(['', ''], [this], mapper, alias);

    copy.readType = readType;

    // A copy of raw SQL is still raw SQL (an and() / or() operand groups it)
    if (isRawSqlFragment(this)) {
      RAW_SQL_FRAGMENTS.add(copy);
    }

    return copy;
  }

  /**
   * Set custom type mapper for bidirectional transformation
   * Can accept either:
   * - A function (value: TDriver) => TData for inline transformations — the fragment's value type
   *   is what the function returns (an unannotated parameter is `any`; it used to be an implicit
   *   `any` error, and the return type was ignored)
   * - A CustomTypeBuilder with full toDriver/fromDriver methods
   *
   * The mapper replaces a read type set by {@link withReadType}.
   */
  mapWith<TData, TDriver = any>(mapper: (value: TDriver) => TData): SqlFragment<TData>;
  mapWith<TData = TValueType>(mapper: object): SqlFragment<TData>;
  mapWith<TData = TValueType, TDriver = any>(
    mapper: ((value: TDriver) => TData) | any
  ): SqlFragment<TData> {
    // If mapper is a function, wrap it in a null-safe mapper object
    const normalizedMapper = typeof mapper === 'function'
      ? { fromDriver: (v: TDriver) => v == null ? v : mapper(v) }
      : mapper;

    return this.derive<TData>(normalizedMapper, this.alias, undefined);
  }

  /**
   * Set column alias for SELECT clause
   */
  as(alias: string): SqlFragment<TValueType> {
    return this.derive<TValueType>(this.mapper, alias, this.readType);
  }

  /**
   * Read this value back the way a COLUMN of `pgType` reads — no SQL changes. Without it a fragment
   * that carries no mapper (a raw `sql` template, a subquery expression) reads through the generic
   * conversion, which turns every numeric-looking string into a number: a text value `'007'` comes
   * back as `7`. Read as a column of its type instead:
   *
   * - a numeric string becomes a number only for a numeric type (`integer`, `bigint`, `numeric`, …);
   *   text, uuid, json, … stay as the driver delivers them;
   * - SQL NULL reads `undefined` at the top level of a projection and `null` inside a nested object;
   * - inside a collection's items the value stays as the JSON delivers it.
   *
   * The fragment's mapper is dropped (a later `.mapWith()` sets one again and wins). The read type is
   * kept by `.as()`, and by every place a projection is read back: `selectDistinct`, UNION legs,
   * QueryBatch parts, grouped selects (which keep NULL as null), CTE and table-subquery columns,
   * and a projected `asSubquery('scalar')` whose one value it is.
   *
   * @example
   * db.books.select(b => ({ title: sql<string>`${b.meta}->>${lang}`.withReadType('text') }))
   */
  withReadType<U = TValueType>(pgType: PgCastType): SqlFragment<U> {
    return this.derive<U>(undefined, this.alias, assertPgTypeName(pgType));
  }

  /** The SQL type set by {@link withReadType}, if any (internal use). */
  getReadType(): string | undefined {
    return this.readType;
  }

  /**
   * Cast this expression: `CAST(<this> AS pgType)`. The alias is kept; the mapper is dropped,
   * because it described the value BEFORE the cast.
   *
   * @example
   * jsonbSelectText(p.payload, 'qty').cast<number>('integer')
   * sql`${p.a} || ${p.b}`.cast<string>('varchar(64)')
   */
  cast<T = unknown>(pgType: PgCastType): SqlFragment<T> {
    return castTo<T>(this, pgType).as(this.alias as string);
  }

  /** `CAST(<this> AS integer)` — int4, read back as a JS number. */
  castAsInt(): SqlFragment<number> {
    return this.cast<number>('integer');
  }

  /** `CAST(<this> AS smallint)` — read back as a JS number. */
  castAsSmallInt(): SqlFragment<number> {
    return this.cast<number>('smallint');
  }

  /**
   * `CAST(<this> AS bigint)`. The pg / postgres.js drivers return int8 as a STRING (a JS
   * number cannot hold every int8) — chain `.mapWith(Number)` or `.mapWith(BigInt)` to convert.
   */
  castAsBigInt(): SqlFragment<string> {
    return this.cast<string>('bigint');
  }

  /**
   * `CAST(<this> AS numeric)` / `numeric(p)` / `numeric(p, s)`, read back as a JS number.
   * For the exact decimal text, use `.cast<string>('numeric')` (the drivers return numeric
   * as a string).
   */
  castAsNumeric(precision?: number, scale?: number): SqlFragment<number> {
    return this.cast<string>(numericTypeName(precision, scale)).mapWith<number>(Number);
  }

  /** `CAST(<this> AS double precision)` — float8, read back as a JS number. */
  castAsDouble(): SqlFragment<number> {
    return this.cast<number>('double precision');
  }

  /** `CAST(<this> AS text)`. */
  castAsString(): SqlFragment<string> {
    return this.cast<string>('text');
  }

  /** `CAST(<this> AS varchar)` / `varchar(n)` — an over-long value is truncated to n, as in PostgreSQL. */
  castAsVarchar(length?: number): SqlFragment<string> {
    return this.cast<string>(varcharTypeName(length));
  }

  /** `CAST(<this> AS boolean)`. */
  castAsBoolean(): SqlFragment<boolean> {
    return this.cast<boolean>('boolean');
  }

  /** `CAST(<this> AS date)`. */
  castAsDate(): SqlFragment<Date> {
    return this.cast<Date>('date');
  }

  /** `CAST(<this> AS timestamp)` — without time zone. */
  castAsTimestamp(): SqlFragment<Date> {
    return this.cast<Date>('timestamp');
  }

  /** `CAST(<this> AS timestamptz)`. */
  castAsTimestamptz(): SqlFragment<Date> {
    return this.cast<Date>('timestamptz');
  }

  /** `CAST(<this> AS jsonb)` — read back as the parsed JSON value. */
  castAsJsonb<T = unknown>(): SqlFragment<T> {
    return this.cast<T>('jsonb');
  }

  /** `CAST(<this> AS json)` — read back as the parsed JSON value. */
  castAsJson<T = unknown>(): SqlFragment<T> {
    return this.cast<T>('json');
  }

  /** `CAST(<this> AS uuid)`. */
  castAsUuid(): SqlFragment<string> {
    return this.cast<string>('uuid');
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
   * Get all field references from the fragment values.
   *
   * A Condition interpolated into a fragment (sql`${eq(p.user.name, x)}`, a caseWhen branch,
   * asBoolean) reports its refs too, and a Subquery its OUTER refs — JOIN detection reads the
   * refs of the whole tree, and a navigation hidden inside a nested condition would otherwise
   * render against an alias that was never joined.
   */
  override getFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    for (const value of this.values) {
      if (this.isFieldRef(value)) {
        refs.push(value);
      } else if (value instanceof WhereConditionBase) {
        // SqlFragment (and its subclasses) included — each reports its own tree
        refs.push(...value.getFieldRefs());
      } else if (value && typeof value === 'object' && typeof (value as any).getOuterFieldRefs === 'function') {
        // Subquery: only its correlation refs belong to the enclosing query
        refs.push(...(value as any).getOuterFieldRefs());
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
   * Check if value is a CTE table reference created by DbCte.as().
   * Duck-typed on marker properties to avoid a circular import with cte-builder.
   */
  private isCteTableRef(value: any): value is { __isCteTableRef: true; __cteName: string; __tableAlias?: string } {
    return typeof value === 'object' && value !== null && value.__isCteTableRef === true && typeof value.__cteName === 'string';
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
        const substituted = context.substitute && (this.isFieldRef(value) || value instanceof SqlFragment)
          ? context.substitute(value, context)
          : undefined;

        if (substituted !== undefined) {
          sql += substituted;
        }
        // Check if value is a RawSql - insert directly without parameterization
        else if (this.isRawSql(value)) {
          sql += value.value;
        }
        // Check if value is a named placeholder for prepared statements
        else if (value instanceof Placeholder) {
          if (!context.placeholders) context.placeholders = new Map();

          // Check if this placeholder was already encountered
          const existingIndex = context.placeholders.get(value.name);
          if (existingIndex !== undefined) {
            // Reuse the same parameter index for duplicate placeholder names
            sql += `$${existingIndex}`;
          } else {
            // First occurrence - assign new parameter index
            context.placeholders.set(value.name, context.paramCounter);
            sql += `$${context.paramCounter++}`;
          }
        }
        // Check if value is a CTE table reference (DbCte.as()) - render as a FROM-clause identifier
        else if (this.isCteTableRef(value)) {
          sql += value.__tableAlias && value.__tableAlias !== value.__cteName
            ? `"${value.__cteName}" AS "${value.__tableAlias}"`
            : `"${value.__cteName}"`;
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
  const fragment = new SqlFragment<TValueType>(Array.from(strings), values);
  RAW_SQL_FRAGMENTS.add(fragment);
  return fragment;
}

/**
 * The fragments whose text is the caller's own — written with the `sql` tag or put together by
 * `sql.join` — and their `.as()` / `.mapWith()` / `.withReadType()` copies. As an `and()` / `or()`
 * operand such a fragment renders in parentheses: it may hold a top-level OR.
 */
const RAW_SQL_FRAGMENTS = new WeakSet<SqlFragment<any>>();

function isRawSqlFragment(value: unknown): boolean {
  return value instanceof SqlFragment && RAW_SQL_FRAGMENTS.has(value);
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

  // A fragment SUBCLASS (exists(), a CASE, …) renders its own way — its parts may be empty — so it
  // joins as one interpolated value, exactly as `sql\`${fragment}\`` would render it
  const partsOf = (fragment: SqlFragment<any>): { fragmentParts: string[]; fragmentValues: any[] } =>
    fragment.constructor === SqlFragment
      ? { fragmentParts: (fragment as any).sqlParts as string[], fragmentValues: (fragment as any).values as any[] }
      : { fragmentParts: ['', ''], fragmentValues: [fragment] };

  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    const { fragmentParts, fragmentValues } = partsOf(fragment);

    if (i > 0) {
      // Add separator
      const { fragmentParts: sepParts, fragmentValues: sepValues } = partsOf(separator);

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

  const joined = new SqlFragment<T>(parts, values);
  RAW_SQL_FRAGMENTS.add(joined);
  return joined;
}

/**
 * Create a named placeholder for prepared statements
 * The placeholder will be replaced with a parameter when the query is executed
 *
 * @example
 * const query = db.users
 *   .where(u => eq(u.id, sql.placeholder('userId')))
 *   .prepare('getUserById');
 *
 * await query.execute({ userId: 10 });
 */
function placeholder<TName extends string>(name: TName): Placeholder<TName> {
  return new Placeholder(name);
}

// Create the sql function with additional methods
export const sql = Object.assign(sqlTemplate, {
  raw,
  empty,
  join,
  placeholder,
});

// ============================================================================
// SQL builder for conditions
// ============================================================================

export class ConditionBuilder {
  /**
   * @param hoistedCteNames CTEs the enclosing builder already declared at
   *   statement level. Carried into the condition's own build context so a
   *   nested subquery that reads one of them (see
   *   `CteRootQueryBuilder.asSubquery`) emits a bare reference instead of
   *   re-declaring the CTE and re-binding its parameters.
   */
  build(
    condition: Condition,
    startParam: number = 1,
    placeholders?: Map<string, number>,
    hoistedCteNames?: Set<string>,
    lateralTableAliasMap?: Map<string, string>
  ): { sql: string; params: any[]; placeholders?: Map<string, number>; paramCounter: number } {
    const context: SqlBuildContext = {
      paramCounter: startParam,
      params: [],
      placeholders,
      hoistedCteNames,
    };
    if (lateralTableAliasMap !== undefined) {
      context.lateralTableAliasMap = lateralTableAliasMap;
    }

    const sql = condition.buildSql(context);
    return { sql, params: context.params, placeholders: context.placeholders, paramCounter: context.paramCounter };
  }
}
