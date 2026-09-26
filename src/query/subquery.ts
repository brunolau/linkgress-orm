import { WhereConditionBase, SqlBuildContext, FieldRef, SqlFragment } from './conditions';
import type { FieldLike } from './conditions';
import type { DbColumn } from '../entity/db-column';

/** How a projection reads a scalar subquery's value: through a mapper, or as a column of a type. @internal */
export interface ScalarSubqueryRead {
  mapper?: unknown;
  readType?: string;
}

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

  /** How a projection reads this scalar subquery's value (see {@link getScalarRead}). */
  private scalarRead?: ScalarSubqueryRead;

  /**
   * Phantom type marker for type checking
   */
  private __resultType?: TResult;
  private __mode?: TMode;

  constructor(
    sqlBuilder: (context: SqlBuildContext & { tableAlias?: string }) => string,
    mode: TMode = 'table' as TMode,
    selectionMetadata?: Record<string, any>,
    outerFieldRefs?: FieldRef[],
    scalarRead?: ScalarSubqueryRead
  ) {
    this.sqlBuilder = sqlBuilder;
    this.__mode = mode;
    this.selectionMetadata = selectionMetadata;
    this.outerFieldRefs = outerFieldRefs || [];
    this.scalarRead = scalarRead;
  }

  /**
   * Set an alias for this subquery (used when subquery is a table source)
   */
  as(alias: string): Subquery<TResult, TMode> {
    const clone = new Subquery<TResult, TMode>(this.sqlBuilder, this.__mode as TMode, this.selectionMetadata, this.outerFieldRefs, this.scalarRead);
    clone.alias = alias;
    return clone;
  }

  /**
   * Build the SQL for this subquery. A subquery that IS the projected value the driver reads
   * directly (the context's `jsonArrayRoot`) projects its own value the same way; any other one —
   * in a WHERE, an operand, a FROM — builds with that flag off.
   */
  buildSql(context: SqlBuildContext & { tableAlias?: string }): string {
    const decoded = context.jsonArrayRoot === this;
    const outer = context.jsonArrayProjection;

    if (!decoded && outer === undefined) {
      return this.sqlBuilder(context);
    }

    context.jsonArrayProjection = decoded;

    try {
      return this.sqlBuilder(context);
    } finally {
      context.jsonArrayProjection = outer;
    }
  }

  /**
   * How a projection reads this SCALAR subquery's value, when `asSubquery('scalar')` recorded it:
   * the subquery projects ONE aggregate fragment (read through its mapper — `agg.max(text)` keeps
   * '007', `agg.max(mapped)` maps) or one read-typed fragment (read as that type). `undefined`
   * otherwise: the value then reads through the generic conversion, as a raw fragment does (a
   * digits-only text becomes a number) — type such a value with `.asExpression().withReadType()` or
   * `.mapWith()`. @internal
   */
  getScalarRead(): ScalarSubqueryRead | undefined {
    return this.scalarRead;
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

  /**
   * This SCALAR subquery as an expression: `(<subquery sql>)`, a first-class fragment — usable in
   * `coalesce`, `caseWhen`, `isNull`, `eq`, arithmetic, an UPDATE SET value, a projection, and with
   * `.as()` / `.mapWith()` / `.withReadType()`. Its parameters render in the enclosing statement's
   * sequence and its correlation refs are reported (`getFieldRefs()`), so the enclosing query joins
   * the navigations they read.
   *
   * It carries NO mapper: projected, it reads like a raw `sql` fragment (a numeric-looking string
   * becomes a number, NULL reads `undefined` at the top level) — chain `.mapWith()` or
   * `.withReadType()` to type the read.
   *
   * @example
   * db.orders.select(o => ({
   *   city: coalesce(db.addresses.where(a => eq(a.id, o.addressId)).select(a => a.city).asSubquery('scalar').asExpression<string>(), 'n/a'),
   * }))
   */
  asExpression<T = TResult>(): SqlFragment<T> {
    if (this.__mode !== 'scalar') {
      throw new Error(`asExpression(): only a scalar subquery is an expression — build it with .asSubquery('scalar') (this one is '${this.__mode}')`);
    }

    return new SqlFragment<T>(['', ''], [this]);
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
 * Duck-typed interface for collection-like objects (e.g., CollectionQueryBuilder)
 * that can be used wherever a Subquery is expected.
 * This enables generic function syntax: exists(collection.where(...)), notExists(collection.where(...))
 */
export interface CollectionSubquerySource {
  exists(): SqlFragment<boolean>;
}

/** An `async` function: its call starts work (a query) and hands back a promise. */
function isAsyncFunction(fn: unknown): boolean {
  return Object.prototype.toString.call(fn) === '[object AsyncFunction]';
}

/**
 * What an EXISTS reads: a Subquery as it is, or the condition a collection navigation's `exists()`
 * builds. A query builder or a table is refused BEFORE anything is called: their `exists()` is a
 * query of its own — `notExists(db.orders.where(...))` used to START that query, then fail with
 * `this.resolved.getFieldRefs is not a function`.
 */
function resolveExistsSource(fnName: string, source: unknown): Subquery | SqlFragment<boolean> {
  if (source instanceof Subquery) {
    return source;
  }

  const candidate = source !== null && typeof source === 'object' ? source as { exists?: unknown; asSubquery?: unknown } : undefined;
  const existsOf = candidate?.exists;

  if (typeof existsOf !== 'function' || typeof candidate!.asSubquery === 'function' || isAsyncFunction(existsOf)) {
    throw new TypeError(
      `${fnName}() expects a subquery — db.<table>.where(…).select(…).asSubquery() — or a collection navigation `
      + '(row.items.where(…)). A query builder or a table is a query of its own; it cannot be embedded as it is.'
    );
  }

  // A collection's exists() hands back its EXISTS-marked snapshot, a fragment by shape
  const resolved = (existsOf as () => unknown).call(candidate) as { buildSql?: unknown; getFieldRefs?: unknown } | null;

  if (resolved === null || typeof resolved !== 'object' || typeof resolved.buildSql !== 'function' || typeof resolved.getFieldRefs !== 'function') {
    throw new TypeError(`${fnName}(): the source's exists() must return a condition fragment — pass .select(…).asSubquery() instead`);
  }

  return resolved as SqlFragment<boolean>;
}

/**
 * Base class for EXISTS / NOT EXISTS conditions.
 * Accepts either a Subquery or a collection navigation source (CollectionSubquerySource).
 */
abstract class ExistsConditionBase extends SqlFragment<boolean> {
  protected resolved: Subquery | SqlFragment<boolean>;

  constructor(fnName: string, source: Subquery | CollectionSubquerySource) {
    super([], []);
    this.resolved = resolveExistsSource(fnName, source);
  }

  override getFieldRefs(): FieldRef[] {
    return this.resolved instanceof Subquery
      ? this.resolved.getOuterFieldRefs()
      : this.resolved.getFieldRefs();
  }

  protected buildSubquerySql(context: SqlBuildContext): string {
    return this.resolved instanceof Subquery
      ? `(${this.resolved.buildSql(context)})`
      : '';
  }
}

/**
 * Condition: EXISTS (subquery)
 * Extends SqlFragment<boolean> so it works in both WHERE clauses and SELECT projections.
 * In SELECT: produces `EXISTS (SELECT ...) as "alias"` with boolean type inference.
 * In WHERE: works as WhereConditionBase since SqlFragment extends it.
 */
export class ExistsCondition extends ExistsConditionBase {
  constructor(source: Subquery | CollectionSubquerySource) {
    super('exists', source);
  }

  override buildSql(context: SqlBuildContext): string {
    if (this.resolved instanceof Subquery) {
      return `EXISTS ${this.buildSubquerySql(context)}`;
    }
    // Collection source — .exists() already produces "EXISTS (...)"
    return this.resolved.buildSql(context);
  }
}

/**
 * Condition: `(NOT EXISTS (subquery))`
 * Extends SqlFragment<boolean> so it works in both WHERE clauses and SELECT projections.
 *
 * Parenthesised as a whole: NOT binds looser than IS, the comparisons, IN, BETWEEN and `= ANY`, so a
 * bare `NOT EXISTS (…)` composed under one of them negated the whole comparison — `isNull(notExists(s))`
 * read `NOT (EXISTS (…) IS NULL)` (always TRUE), `isDistinctFrom(notExists(s), flag)` read
 * `NOT (EXISTS (…) IS DISTINCT FROM flag)` (wrong for every NULL flag).
 */
export class NotExistsCondition extends ExistsConditionBase {
  constructor(source: Subquery | CollectionSubquerySource) {
    super('notExists', source);
  }

  override buildSql(context: SqlBuildContext): string {
    if (this.resolved instanceof Subquery) {
      return `(NOT EXISTS ${this.buildSubquerySql(context)})`;
    }
    // Collection source — .exists() produces "EXISTS (...)", prepend NOT
    return `(NOT ${this.resolved.buildSql(context)})`;
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
export function exists(source: Subquery | CollectionSubquerySource): ExistsCondition {
  return new ExistsCondition(source);
}

/**
 * NOT EXISTS condition
 */
export function notExists(source: Subquery | CollectionSubquerySource): NotExistsCondition {
  return new NotExistsCondition(source);
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
 * `(<field> <operator> (ARRAY(<subquery>)))`, the subquery checked first — parenthesised as a whole, like
 * every helper: bare, `eq(flag, eqAnySubquery(…))` read `flag = x = ANY (…)`, a syntax error.
 */
function arraySubqueryMembership(
  fnName: string,
  operator: string,
  field: unknown,
  subquery: unknown
): SqlFragment<boolean> {
  if (!(subquery instanceof Subquery)) {
    throw new TypeError(`${fnName}() expects a subquery of one column — build it with .select(…).asSubquery('array')`);
  }

  if (field === undefined) {
    throw new Error(`${fnName}(): the field is undefined — pass a column or an expression`);
  }

  // The Subquery value renders parenthesised: `ARRAY` + `(<sql>)`
  return new SqlFragment<boolean>(['(', ` ${operator} (ARRAY`, '))'], [field, subquery]);
}

/**
 * `(<field> = ANY (ARRAY(<subquery>)))` — membership in the one-column result of a subquery, computed
 * as ONE array (an uncorrelated subquery is an InitPlan whose array can drive an index condition),
 * not as the `IN (SELECT …)` semi-join {@link inSubquery} renders.
 *
 * A NULL field gives NULL; an empty result gives FALSE (for every row). Only the subquery's own
 * parameters are bound; the field's refs and the subquery's correlation refs are reported, so the
 * navigations they read are joined.
 *
 * @example
 * db.books.where(b => eqAnySubquery(b.genreId, db.genres.where(g => eq(g.active, true)).select(g => g.id).asSubquery('array')))
 */
export function eqAnySubquery<V>(
  field: FieldLike<V> | DbColumn<V> | SqlFragment<V> | undefined,
  subquery: Subquery<any, 'array' | 'table'>
): SqlFragment<boolean> {
  return arraySubqueryMembership('eqAnySubquery', '= ANY', field, subquery);
}

/**
 * `(<field> <> ALL (ARRAY(<subquery>)))` — the negation of {@link eqAnySubquery}: TRUE for an empty
 * result; NULL for a NULL field, or when the result holds a NULL and no element equals the field.
 */
export function neAllSubquery<V>(
  field: FieldLike<V> | DbColumn<V> | SqlFragment<V> | undefined,
  subquery: Subquery<any, 'array' | 'table'>
): SqlFragment<boolean> {
  return arraySubqueryMembership('neAllSubquery', '<> ALL', field, subquery);
}

/**
 * Type helper: Extract result type from a subquery
 */
export type SubqueryResult<T> = T extends Subquery<infer R, any> ? R : never;

/**
 * Type helper: Extract mode from a subquery
 */
export type SubqueryMode<T> = T extends Subquery<any, infer M> ? M : never;
