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
 * Extract the field name from a FieldRef or string
 */
export type ExtractFieldName<T> = T extends FieldRef<infer N, any> ? N : T extends string ? T : never;

/**
 * Extract the value type from a FieldRef
 */
export type ExtractValueType<T> = T extends FieldRef<any, infer V> ? V : any;

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
  protected extractValue<V>(value: FieldRef<any, V> | V): any {
    if (this.isFieldRef(value)) {
      return value.__dbColumnName;
    }
    return value;
  }

  /**
   * Helper to get the right-hand side of a comparison
   * Returns either a column reference or a parameter placeholder
   */
  protected getRightSide<V>(value: FieldRef<any, V> | V, context: SqlBuildContext): string {
    if (this.isFieldRef(value)) {
      // Value is a field reference, use it with table alias if present
      if ('__tableAlias' in value && value.__tableAlias) {
        return `"${value.__tableAlias}"."${value.__dbColumnName}"`;
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
    protected field: FieldRef<any, V> | string,
    protected value?: FieldRef<any, V> | V
  ) {
    super();
  }

  /**
   * Get the comparison operator (e.g., '=', '>', 'LIKE')
   */
  protected abstract getOperator(): string;

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
  constructor(field: FieldRef<any, V> | string) {
    super(field, undefined);
  }

  protected getOperator(): string {
    return 'IS NULL';
  }
}

export class IsNotNullComparison<V = any> extends WhereComparisonBase<V> {
  constructor(field: FieldRef<any, V> | string) {
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
    field: FieldRef<any, V> | string,
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
    field: FieldRef<any, V> | string,
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
    field: FieldRef<any, V> | string,
    private min: FieldRef<any, V> | V,
    private max: FieldRef<any, V> | V
  ) {
    super(field, undefined);
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
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new EqComparison<V>(field, value);
}

export function ne<T extends string, V>(
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new NeComparison<V>(field, value);
}

export function gt<T extends string, V>(
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new GtComparison<V>(field, value);
}

export function gte<T extends string, V>(
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new GteComparison<V>(field, value);
}

export function lt<T extends string, V>(
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new LtComparison<V>(field, value);
}

export function lte<T extends string, V>(
  field: FieldRef<T, V> | T,
  value: FieldRef<any, V> | V
): Condition {
  return new LteComparison<V>(field, value);
}

export function like<T extends string>(
  field: FieldRef<T, string> | T,
  value: FieldRef<any, string> | string
): Condition {
  return new LikeComparison(field, value);
}

export function ilike<T extends string>(
  field: FieldRef<T, string> | T,
  value: FieldRef<any, string> | string
): Condition {
  return new ILikeComparison(field, value);
}

export function inArray<T extends string, V>(
  field: FieldRef<T, V> | T,
  values: V[]
): Condition {
  return new InComparison<V>(field, values);
}

export function notInArray<T extends string, V>(
  field: FieldRef<T, V> | T,
  values: V[]
): Condition {
  return new NotInComparison<V>(field, values);
}

export function isNull<T extends string, V>(
  field: FieldRef<T, V> | T
): Condition {
  return new IsNullComparison<V>(field);
}

export function isNotNull<T extends string, V>(
  field: FieldRef<T, V> | T
): Condition {
  return new IsNotNullComparison<V>(field);
}

export function between<T extends string, V>(
  field: FieldRef<T, V> | T,
  min: FieldRef<any, V> | V,
  max: FieldRef<any, V> | V
): Condition {
  return new BetweenComparison<V>(field, min, max);
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
   * Build the SQL string with proper parameter placeholders
   */
  buildSql(context: SqlBuildContext): string {
    let sql = '';

    for (let i = 0; i < this.sqlParts.length; i++) {
      sql += this.sqlParts[i];

      if (i < this.values.length) {
        const value = this.values[i];

        // Check if value is a FieldRef
        if (this.isFieldRef(value)) {
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
 * Tagged template literal for creating SQL fragments
 * Usage: sql`lower(${field})` or sql`${field} = ${value}`
 */
export function sql<TValueType = any>(
  strings: TemplateStringsArray,
  ...values: any[]
): SqlFragment<TValueType> {
  return new SqlFragment<TValueType>(Array.from(strings), values);
}

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
