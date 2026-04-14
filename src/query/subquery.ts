import { WhereConditionBase, SqlBuildContext, FieldRef, SqlFragment } from './conditions';

/**
 * Represents a subquery that can be used in various contexts
 * TResult: The type of data the subquery returns
 * TMode: 'scalar' | 'array' | 'table' - determines how the subquery can be used
 */
export class Subquery<TResult = any, TMode extends 'scalar' | 'array' | 'table' = 'table'> {
  /**
   * The SQL generator function - called with context to build SQL
   */
  private sqlBuilder: (context: SqlBuildContext & { tableAlias?: string }) => string;

  /**
   * Optional alias for the subquery when used as a table source
   */
  private alias?: string;

  /**
   * Selection metadata - preserves SqlFragments with mappers for table subqueries
   */
  private selectionMetadata?: Record<string, any>;

  /**
   * Field refs from outer queries used inside this subquery's WHERE condition.
   * These need to be propagated to the outer query so it can add necessary JOINs.
   */
  private outerFieldRefs: FieldRef[] = [];

  /**
   * Phantom type marker for type checking
   */
  private __resultType?: TResult;
  private __mode?: TMode;

  constructor(
    sqlBuilder: (context: SqlBuildContext & { tableAlias?: string }) => string,
    mode: TMode = 'table' as TMode,
    selectionMetadata?: Record<string, any>,
    outerFieldRefs?: FieldRef[]
  ) {
    this.sqlBuilder = sqlBuilder;
    this.__mode = mode;
    this.selectionMetadata = selectionMetadata;
    this.outerFieldRefs = outerFieldRefs || [];
  }

  /**
   * Set an alias for this subquery (used when subquery is a table source)
   */
  as(alias: string): Subquery<TResult, TMode> {
    const clone = new Subquery<TResult, TMode>(this.sqlBuilder, this.__mode as TMode, this.selectionMetadata, this.outerFieldRefs);
    clone.alias = alias;
    return clone;
  }

  /**
   * Build the SQL for this subquery
   */
  buildSql(context: SqlBuildContext & { tableAlias?: string }): string {
    return this.sqlBuilder(context);
  }

  /**
   * Get the alias for this subquery
   */
  getAlias(): string | undefined {
    return this.alias;
  }

  /**
   * Get the selection metadata (preserves SqlFragments with mappers)
   */
  getSelectionMetadata(): Record<string, any> | undefined {
    return this.selectionMetadata;
  }

  /**
   * Get field refs from outer queries used inside this subquery.
   * These need to be propagated to the outer query for JOIN detection.
   */
  getOuterFieldRefs(): FieldRef[] {
    return this.outerFieldRefs;
  }

  /**
   * Check if this is a scalar subquery
   */
  isScalar(): this is Subquery<TResult, 'scalar'> {
    return this.__mode === 'scalar';
  }

  /**
   * Check if this is an array subquery
   */
  isArray(): this is Subquery<TResult, 'array'> {
    return this.__mode === 'array';
  }

  /**
   * Check if this is a table subquery
   */
  isTable(): this is Subquery<TResult, 'table'> {
    return this.__mode === 'table';
  }
}

/**
 * Subquery reference - used to reference columns from a subquery in a FROM clause
 * This is similar to FieldRef but for subquery columns
 */
export interface SubqueryFieldRef<TName extends string = string, TValueType = any> extends FieldRef<TName, TValueType> {
  readonly __isSubqueryField: true;
}

/**
 * Helper to check if something is a Subquery
 */
export function isSubquery(value: any): value is Subquery {
  return value instanceof Subquery;
}

/**
 * Condition: EXISTS (subquery)
 * Extends SqlFragment<boolean> so it works in both WHERE clauses and SELECT projections.
 * In SELECT: produces `EXISTS (SELECT ...) as "alias"` with boolean type inference.
 * In WHERE: works as WhereConditionBase since SqlFragment extends it.
 */
export class ExistsCondition extends SqlFragment<boolean> {
  constructor(private subquery: Subquery) {
    super([], []);
  }

  /**
   * Get field refs from outer queries used inside this subquery.
   * These are propagated to enable JOIN detection in the outer query.
   */
  override getFieldRefs(): FieldRef[] {
    return this.subquery.getOuterFieldRefs();
  }

  override buildSql(context: SqlBuildContext): string {
    const subquerySql = this.subquery.buildSql(context);
    return `EXISTS (${subquerySql})`;
  }
}

/**
 * Condition: NOT EXISTS (subquery)
 * Extends SqlFragment<boolean> so it works in both WHERE clauses and SELECT projections.
 */
export class NotExistsCondition extends SqlFragment<boolean> {
  constructor(private subquery: Subquery) {
    super([], []);
  }

  /**
   * Get field refs from outer queries used inside this subquery.
   * These are propagated to enable JOIN detection in the outer query.
   */
  override getFieldRefs(): FieldRef[] {
    return this.subquery.getOuterFieldRefs();
  }

  override buildSql(context: SqlBuildContext): string {
    const subquerySql = this.subquery.buildSql(context);
    return `NOT EXISTS (${subquerySql})`;
  }
}

/**
 * Condition: field IN (subquery)
 * The subquery must return a single column
 */
export class InSubqueryCondition<T> extends WhereConditionBase {
  constructor(
    private field: FieldRef<any, T>,
    private subquery: Subquery<T[], 'array'>
  ) {
    super();
  }

  override getFieldRefs(): FieldRef[] {
    return [this.field];
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field);
    const subquerySql = this.subquery.buildSql(context);
    return `${fieldName} IN (${subquerySql})`;
  }
}

/**
 * Condition: field NOT IN (subquery)
 */
export class NotInSubqueryCondition<T> extends WhereConditionBase {
  constructor(
    private field: FieldRef<any, T>,
    private subquery: Subquery<T[], 'array'>
  ) {
    super();
  }

  override getFieldRefs(): FieldRef[] {
    return [this.field];
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field);
    const subquerySql = this.subquery.buildSql(context);
    return `${fieldName} NOT IN (${subquerySql})`;
  }
}

/**
 * Comparison with scalar subquery
 * Example: field = (SELECT ...)
 */
export class ScalarSubqueryComparison<T> extends WhereConditionBase {
  constructor(
    private field: FieldRef<any, T>,
    private operator: '=' | '!=' | '>' | '>=' | '<' | '<=',
    private subquery: Subquery<T, 'scalar'>
  ) {
    super();
  }

  override getFieldRefs(): FieldRef[] {
    return [this.field];
  }

  buildSql(context: SqlBuildContext): string {
    const fieldName = this.getDbColumnName(this.field);
    const subquerySql = this.subquery.buildSql(context);
    return `${fieldName} ${this.operator} (${subquerySql})`;
  }
}

/**
 * Helper functions to create subquery conditions
 */

/**
 * EXISTS condition
 */
export function exists(subquery: Subquery): ExistsCondition {
  return new ExistsCondition(subquery);
}

/**
 * NOT EXISTS condition
 */
export function notExists(subquery: Subquery): NotExistsCondition {
  return new NotExistsCondition(subquery);
}

/**
 * Extract the non-undefined type from a potentially undefined type
 */
type NonUndefined<T> = T extends undefined ? never : T;

/**
 * IN subquery condition
 *
 * Supports both required and optional fields:
 * - Required field: `inSubquery(p.userId, subquery)` where userId is number
 * - Optional field: `inSubquery(u.age!, agesSubquery)` where age is number | undefined
 *
 * For optional fields, use non-null assertion (!) or check for undefined before calling.
 */
export function inSubquery<T>(
  field: FieldRef<any, NonUndefined<T>>,
  subquery: Subquery<NonUndefined<T>[], 'array'>
): InSubqueryCondition<NonUndefined<T>> {
  return new InSubqueryCondition(field, subquery);
}

/**
 * NOT IN subquery condition
 *
 * Supports both required and optional fields:
 * - Required field: `notInSubquery(p.userId, subquery)` where userId is number
 * - Optional field: `notInSubquery(u.age!, agesSubquery)` where age is number | undefined
 *
 * For optional fields, use non-null assertion (!) or check for undefined before calling.
 */
export function notInSubquery<T>(
  field: FieldRef<any, NonUndefined<T>>,
  subquery: Subquery<NonUndefined<T>[], 'array'>
): NotInSubqueryCondition<NonUndefined<T>> {
  return new NotInSubqueryCondition(field, subquery);
}

/**
 * Scalar subquery comparison helpers
 */
export function eqSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '=', subquery);
}

export function neSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '!=', subquery);
}

export function gtSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '>', subquery);
}

export function gteSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '>=', subquery);
}

export function ltSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '<', subquery);
}

export function lteSubquery<T>(
  field: FieldRef<any, T>,
  subquery: Subquery<T, 'scalar'>
): ScalarSubqueryComparison<T> {
  return new ScalarSubqueryComparison(field, '<=', subquery);
}

/**
 * Type helper: Extract result type from a subquery
 */
export type SubqueryResult<T> = T extends Subquery<infer R, any> ? R : never;

/**
 * Type helper: Extract mode from a subquery
 */
export type SubqueryMode<T> = T extends Subquery<any, infer M> ? M : never;
