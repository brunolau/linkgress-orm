import { DatabaseClient } from '../database/database-client.interface';
import { QueryBuilder, SelectQueryBuilder, ResolveCollectionResults, materializeMockSelection } from './query-builder';
import { SqlBuildContext, FieldRef, UnwrapSelection } from './conditions';
import { pgTypeOfValue } from './sql-functions';
import { renumberPlaceholders } from './query-batch';

/**
 * Interface for queries that can be used in CTEs
 * Supports SelectQueryBuilder, EntitySelectQueryBuilder, GroupedJoinedQueryBuilder
 * The TSelection type is inferred from the query's type parameter
 */
interface CteCompatibleQuery<TSelection> {
  toList: () => Promise<ResolveCollectionResults<TSelection>[] | TSelection[]>;
}

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. See conditions.ts for detailed explanation.
 * Excludes DbColumn and SqlFragment which have valueOf but are not value types.
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Exclude DbColumn
  : T extends { mapWith: any; as: any; buildSql: any }  // SqlFragment-like
  ? false  // Exclude SqlFragment
  : T extends { valueOf(): infer V }
  ? V extends T
    ? true
    : V extends number | string | boolean | bigint | symbol
    ? true
    : false
  : false;

/**
 * Check for types with known class method signatures
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
 * Type helper to convert value types to FieldRefs for CTE column access
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ToFieldRefs<T> = T extends object
  ? IsValueType<T> extends true
    ? FieldRef<string, T>  // Preserve class instances, wrap in FieldRef
    : { [K in keyof T]: FieldRef<string, T[K]> }
  : FieldRef<string, T>;

/**
 * Type helper to extract the underlying value type from a FieldRef or keep as-is
 */
type ExtractValueType<T> = T extends FieldRef<any, infer V> ? V : T;

/**
 * Type helper to resolve FieldRefs in an object to their value types
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends object
  ? IsValueType<T> extends true
    ? T  // Preserve class instances as-is
    : { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Reference to a CTE for use inside sql`` template literals, created via DbCte.as().
 * Interpolating the ref itself renders the FROM-clause identifier
 * (`"cte_name" AS "alias"`); interpolating a column property renders a
 * qualified column identifier (`"alias"."column"`).
 */
export type CteTableRef<TColumns> = {
  readonly __isCteTableRef: true;
  readonly __cteName: string;
  readonly __tableAlias: string;
} & {
  [K in keyof TColumns & string]: FieldRef<K, ExtractValueType<TColumns[K]>>;
};

/**
 * A ref to a column of a projection another query reads as a table — a CTE body, a table subquery
 * — qualified by `alias`, carrying what reading the column needs. `metaValue` is what the body
 * projected under `key`:
 * - an expression's (or a mapped column's) `mapWith` / mapper, as `getMapper`;
 * - a json_agg column's aggregation marker and inner metadata;
 * - `__cteKind` — `'column'` (with the column's own `__mapper` and `__sqlType`), `'literal'` or
 *   `'expression'` — so the reader applies the column's OWN mapper. The refs used to carry only
 *   `getMapper`: a mapped column read through a CTE came back as its storage value, and one named
 *   like a mapped column of the reading query's table went through THAT column's mapper.
 * @internal
 */
export function projectedColumnRef(key: string, alias: string, metaValue: unknown): Record<string, any> {
  const fieldRef: Record<string, any> = {
    __fieldName: key,
    __dbColumnName: key,
    __tableAlias: alias,
  };

  if (metaValue === null || metaValue instanceof Date || Array.isArray(metaValue)
    || (metaValue !== undefined && typeof metaValue !== 'object' && typeof metaValue !== 'function')) {
    // A literal (or null, or a list of values) the body projected — rendered typed from its JS
    // type (see projectionLiteralSql), which is the column's type
    fieldRef.__cteKind = 'literal';
    fieldRef.__sqlType = pgTypeOfValue(metaValue);

    if (typeof metaValue === 'bigint') {
      // An int8 the driver may hand back as text: read back as the bigint it was
      fieldRef.__bigintLiteral = true;
    }
  } else if (metaValue !== null && typeof metaValue === 'object') {
    const meta = metaValue as any;

    if (typeof meta.getMapper === 'function') {
      fieldRef.getMapper = () => meta.getMapper();
    }

    if (meta.__isAggregationArray) {
      fieldRef.__isAggregationArray = true;
      fieldRef.__innerSelectionMetadata = meta.__innerSelectionMetadata;
    }

    if ('__dbColumnName' in meta && !meta.__isAggregate) {
      fieldRef.__cteKind = 'column';
      fieldRef.__mapper = meta.__mapper;
      fieldRef.__sqlType = meta.__sqlType;
    } else {
      // An expression — an `sql` fragment, a condition, a grouped query's aggregate, a collection
      fieldRef.__cteKind = 'expression';

      // A fragment read as a column of its type (withReadType) reads so through the reader too
      const readType = typeof meta.getReadType === 'function' ? meta.getReadType() : undefined;
      if (readType !== undefined) {
        fieldRef.__sqlType = readType;
      }
    }
  } else {
    // A column the ref cannot tell anything about (a data-modifying CTE's RETURNING column, a
    // subquery without metadata): read like an expression — never through the mapper of a column
    // of the reading table that happens to share its name
    fieldRef.__cteKind = 'expression';
  }

  return fieldRef;
}

/**
 * The values of a nested object a projection holds — a plain object, or a navigation row projected
 * whole (the columns it renders as) — or `undefined` for any other value.
 */
function nestedProjectionMeta(metaValue: unknown): Record<string, unknown> | undefined {
  if (metaValue === null || typeof metaValue !== 'object' || Array.isArray(metaValue) || metaValue instanceof Date) {
    return undefined;
  }

  const value = materializeMockSelection(metaValue);
  const proto = Object.getPrototypeOf(value);

  if (!(proto === Object.prototype || proto === null || value.constructor === Object)
    || '__dbColumnName' in value || '__isAggregationArray' in value || '__collectionResult' in value) {
    return undefined;
  }

  return value;
}

/**
 * What a query reading a projection as a table (a CTE body, a table subquery) reads for its `key`: a
 * column ref (see projectedColumnRef), or — for a nested object or a navigation row the body
 * projected, which it renders as the flattened columns `__nested__<key>__<leaf>` — an object of refs
 * to those columns. Selecting such a key used to name a column the body does not have.
 * @internal
 */
export function projectedValueRef(key: string, alias: string, metaValue: unknown, columnName: string = key): any {
  const nested = nestedProjectionMeta(metaValue);

  if (nested === undefined) {
    return projectedColumnRef(columnName, alias, metaValue);
  }

  const prefix = columnName.startsWith('__nested__') ? columnName : `__nested__${columnName}`;
  const refs: Record<string, any> = {};

  for (const leaf of Object.keys(nested)) {
    refs[leaf] = projectedValueRef(leaf, alias, nested[leaf], `${prefix}__${leaf}`);
  }

  return refs;
}

/**
 * `value` — a column ref, or an object of refs (a nested value, see {@link projectedValueRef}) — with
 * every ref stamped with a query-chain identity (see `isForeignChainRef`). Only for refs minted for
 * the caller (a CTE's refs are fresh objects on every read).
 * @internal
 */
export function stampChainId<T>(value: T, chainId: number): T {
  if (value !== null && typeof value === 'object') {
    if ('__dbColumnName' in (value as object)) {
      (value as any).__chainId = chainId;
    } else {
      for (const nested of Object.values(value as object)) {
        stampChainId(nested, chainId);
      }
    }
  }

  return value;
}

/**
 * A statement compiled without being executed — `update(...).toStatement(selector)`,
 * `delete().toStatement(selector)`: its SQL text with `$1`-based placeholders and its parameters, typed
 * by the row its RETURNING produces (`TRow`, a phantom: nothing carries it at runtime). Attach it as a
 * data-modifying CTE with {@link DbCteBuilder.withMutation}, whose CTE is then typed by `TRow`.
 */
export interface CompiledStatement<TRow = unknown> {
  sql: string;
  params: any[];
  /** Phantom type of the RETURNING row — never set at runtime. */
  readonly __rowType?: TRow;
}

/** Where a compiled statement keeps its RETURNING selection (non-enumerable: `{ sql, params }` compares as before). */
const RETURNING_SELECTION = '__returningSelection';

/**
 * Attaches the RETURNING selection `toStatement(selector)` compiled to the statement — how
 * {@link DbCteBuilder.withMutation} reads each column (its type, its mapper). @internal
 */
export function attachReturningSelection<T extends { sql: string; params: any[] }>(statement: T, selection: Record<string, unknown> | undefined): T {
  if (selection !== undefined) {
    Object.defineProperty(statement, RETURNING_SELECTION, { value: selection, enumerable: false });
  }

  return statement;
}

/** The RETURNING selection attached by {@link attachReturningSelection}, if any. */
function returningSelectionOf(statement: { sql: string; params: any[] }): Record<string, any> | undefined {
  return (statement as any)[RETURNING_SELECTION];
}

/**
 * The CTEs declared at statement level, as the set of their NAMES every nested build receives
 * (`SqlBuildContext.hoistedCteNames`) — carrying their definitions, so that a nested query attaching a
 * DIFFERENT CTE under a declared name is refused (see {@link isStatementCte}) instead of silently
 * reading the statement's. A plain `Set` of names (built elsewhere) is honoured by name alone.
 */
class StatementCteNames extends Set<string> {
  constructor(readonly definitions: ReadonlyMap<string, DbCte<any> | undefined>) {
    super(definitions.keys());
  }
}

/**
 * The statement-level CTE set a builder hands to what it nests: the enclosing statement's (`inherited`)
 * plus `ctes` — an inherited name keeps the enclosing statement's definition. @internal
 */
export function declareStatementCtes(inherited: ReadonlySet<string> | undefined, ctes: readonly DbCte<any>[]): Set<string> {
  const definitions = new Map<string, DbCte<any> | undefined>();

  for (const name of inherited ?? []) {
    definitions.set(name, inherited instanceof StatementCteNames ? inherited.definitions.get(name) : undefined);
  }

  for (const cte of ctes) {
    if (!definitions.has(cte.name)) {
      definitions.set(cte.name, cte);
    }
  }

  return new StatementCteNames(definitions);
}

/**
 * Two CTEs that render the same relation — the same by CONTENT: the same object, or (a definition built
 * twice, e.g. by a factory called for the statement and again for a nested query) the same body once both
 * are numbered from `$1` — whatever offset their builders were at — the same `MATERIALIZED` flag, and the
 * same parameters by value (see {@link sameBoundValue}). A data-modifying CTE is one execution of its
 * statement: it is the same only as the same instance.
 * @internal
 */
export function sameCteDefinition(a: DbCte<any>, b: DbCte<any>): boolean {
  if (a === b) {
    return true;
  }

  return !a.dataModifying && !b.dataModifying
    && a.materialized === b.materialized
    && a.params.length === b.params.length
    && cteBodyAt(a, 1) === cteBodyAt(b, 1)
    && a.params.every((param, index) => sameBoundValue(param, b.params[index]));
}

/**
 * Whether two parameter values bind the same value: equal primitives (`Object.is`), Dates of the same time,
 * byte views (Buffer, Uint8Array, …) of the same bytes, arrays of such values element by element, and plain
 * objects (JSON documents) of the same JSON text — which is what a driver sends for them. Any other object
 * is the same only as the same instance.
 */
function sameBoundValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }

  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    return ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && sameBytes(a, b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameBoundValue(item, b[index]));
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Not serializable (a bigint inside): no driver could bind it either
    return false;
  }
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

  return left.every((byte, index) => byte === right[index]);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * Whether `cte` is declared by an enclosing statement (`hoisted`): a nested build then reads it by
 * name — neither declaring it again nor binding its parameters. A DIFFERENT CTE under a declared name
 * (different by content, see {@link sameCteDefinition}) is refused: inside the statement the name reads
 * the statement's CTE, so the nested query would read the other one's rows without a word.
 * @internal
 */
export function isStatementCte(hoisted: ReadonlySet<string> | undefined, cte: DbCte<any>): boolean {
  if (!hoisted?.has(cte.name)) {
    return false;
  }

  const declared = hoisted instanceof StatementCteNames ? hoisted.definitions.get(cte.name) : undefined;

  if (declared !== undefined && !sameCteDefinition(declared, cte)) {
    throw new Error(
      `The CTE "${cte.name}" a nested query attaches is not the CTE "${cte.name}" its statement declares: inside the `
      + 'statement the name reads the statement\'s CTE, so the nested query would read the other one\'s rows. '
      + 'Rename one of them, or attach the same DbCte to both.'
    );
  }

  return true;
}

/**
 * The body of `cte` with its placeholders renumbered for its parameters bound from `$slot` on: a body
 * is numbered from its builder's offset at its creation ({@link DbCte.paramBase}), whatever other
 * CTEs of its builder the statement declares with it.
 * @internal
 */
export function cteBodyAt(cte: DbCte<any>, slot: number): string {
  const shift = slot - cte.paramBase;

  return shift === 0 ? cte.query : renumberPlaceholders(cte.query, shift);
}

/** `"<name>" AS [MATERIALIZED ](<body>)`, its parameters bound from `$slot` on (see {@link cteBodyAt}). @internal */
export function cteDeclarationAt(cte: DbCte<any>, slot: number): string {
  return `"${cte.name}" AS ${cte.materialized ? 'MATERIALIZED ' : ''}(${cteBodyAt(cte, slot)})`;
}

/**
 * The refusal of a data-modifying CTE declared inside a nested subquery (see
 * {@link assertStatementLevelCtes}) — its own class, so that a build probing where such a CTE would be
 * read can tell it from any other error. @internal
 */
export class NestedDataModifyingCteError extends Error {
  constructor(readonly cteName: string) {
    super(
      `CTE "${cteName}" is data-modifying: a data-modifying CTE must be declared at statement level — `
      + 'attach it with .with() on the executing query'
    );
  }
}

/** How a CTE declared inside a nested subquery is refused when it is data-modifying. @internal */
export function assertStatementLevelCtes(ctes: readonly DbCte<any>[], hoisted: ReadonlySet<string> | undefined): void {
  for (const cte of ctes) {
    if (cte.dataModifying && !isStatementCte(hoisted, cte)) {
      throw new NestedDataModifyingCteError(cte.name);
    }
  }
}

/** Names that are never columns of a CTE: read by JS itself (`await`, JSON, coercion, inspection). */
const NON_COLUMN_KEYS: ReadonlySet<string> = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', 'inspect', 'asymmetricMatch', 'nodeType', 'tagName']);

/**
 * Represents a Common Table Expression (CTE) with strong typing
 */
export class DbCte<TColumns> {
  /**
   * Set of column names that contain aggregated JSONB arrays.
   * These columns need COALESCE(..., '[]'::jsonb) when used in LEFT JOINs.
   */
  public readonly aggregationColumns: Set<string>;

  /**
   * When true the CTE is emitted `AS MATERIALIZED` — an optimizer fence that
   * forces PostgreSQL to compute the CTE once and treat its result as an
   * opaque relation. Use for candidate-set CTEs whose join order must not be
   * dissolved into the outer plan (PostgreSQL 12+ inlines plain CTEs).
   */
  public readonly materialized: boolean;

  /**
   * A DML statement (`DbCteBuilder.withMutation`): PostgreSQL allows it only in the `WITH` of the
   * statement that executes, and runs it once there. Declaring it inside a nested subquery is refused
   * (see {@link assertStatementLevelCtes}).
   */
  public readonly dataModifying: boolean;

  /**
   * The placeholder number the body's parameters start at: its builder numbers the bodies of all its
   * CTEs as one block (`a` from `$1`, `b` after `a`'s). A statement renumbers each body from where ITS
   * parameters land (see {@link cteBodyAt}) — a builder's second CTE used without the first, or two
   * builders' CTEs in one WITH, used to keep `$2` / `$1` and bind another CTE's (or the WHERE's) values.
   */
  public readonly paramBase: number;

  constructor(
    public readonly name: string,
    public readonly query: string,
    public readonly params: unknown[],
    public readonly columnDefs: TColumns,
    public readonly selectionMetadata?: Record<string, any>,
    aggregationColumns?: string[],
    materialized?: boolean,
    dataModifying?: boolean,
    paramBase?: number
  ) {
    this.aggregationColumns = new Set(aggregationColumns || []);
    this.materialized = materialized ?? false;
    this.dataModifying = dataModifying ?? false;
    this.paramBase = paramBase ?? 1;
  }

  /**
   * Get a typed reference to a CTE column
   */
  getColumn<K extends keyof TColumns>(columnName: K): TColumns[K] {
    return columnName as TColumns[K];
  }

  /**
   * Create a typed reference to this CTE for use inside sql`` template literals,
   * mirroring SQL's `FROM cte AS alias`. Column properties render as qualified
   * identifiers, the ref itself renders as the FROM-clause table reference —
   * no hand-written string identifiers needed:
   *
   * @example
   * const stats = cteBuilder.with('post_stats', db.posts.select(p => ({
   *   postId: p.id,
   *   views: p.views,
   *   authorId: p.userId,
   * })));
   * const ps = stats.cte.as('ps');
   *
   * sql`(SELECT COALESCE(SUM(${ps.views}), 0) FROM ${ps} WHERE ${ps.authorId} = ${u.id})`
   * // -> (SELECT COALESCE(SUM("ps"."views"), 0) FROM "post_stats" AS "ps" WHERE "ps"."authorId" = "users"."id")
   *
   * Without an alias, columns are qualified by the CTE name and the table ref
   * renders as just `"post_stats"`.
   */
  as(alias?: string): CteTableRef<TColumns> {
    const effectiveAlias = alias || this.name;
    const ref: Record<string, any> = {
      __isCteTableRef: true,
      __cteName: this.name,
      __tableAlias: effectiveAlias,
    };
    const columns = Object.keys(this.columnDefs || {});

    for (const key of columns) {
      // The same ref the internal CTE mock rows mint, so refs behave identically wherever FieldRefs
      // are accepted
      ref[key] = this.columnRef(key, effectiveAlias);
    }

    if (columns.length > 0 || !this.dataModifying) {
      return ref as CteTableRef<TColumns>;
    }

    // A CTE whose columns are known only to its type (`withMutation(name, statement)` types them from
    // the statement's RETURNING): a column is minted when it is read
    return new Proxy(ref, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop in target || NON_COLUMN_KEYS.has(prop)) {
          return target[prop as any];
        }

        return this.columnRef(prop, effectiveAlias);
      },
    }) as CteTableRef<TColumns>;
  }

  /**
   * A ref to one of this CTE's columns, qualified by `alias` (the CTE's own name by default). It
   * carries what reading the column needs — see {@link projectedColumnRef}; a nested object the
   * body projected is an object of refs to its flattened columns (see {@link projectedValueRef}).
   * @internal
   */
  columnRef(key: string, alias: string = this.name): any {
    return projectedValueRef(key, alias, this.selectionMetadata ? this.selectionMetadata[key] : undefined);
  }

  /**
   * Check if a column is an aggregation column (JSONB array)
   */
  isAggregationColumn(columnName: string): boolean {
    return this.aggregationColumns.has(columnName);
  }
}

/**
 * Builder for creating Common Table Expressions (CTEs)
 */
export class DbCteBuilder {
  private ctes: DbCte<any>[] = [];
  private paramOffset: number = 1;

  /**
   * @param client - Optional. When provided, CTE bodies are built with the
   *   driver's capabilities in mind — notably `supportsBinaryArrayResults()`:
   *   array-producing aggregations (toNumberList/toStringList) inside CTE
   *   definitions emit json_agg for drivers that cannot decode native arrays
   *   (BunClient in binary mode). Without a client, CTE SQL is built
   *   driver-agnostically (array_agg), matching previous behavior.
   */
  constructor(private client?: DatabaseClient) {}

  /**
   * Create a regular CTE from a query
   *
   * @example
   * const activeUsersCte = cteBuilder.with(
   *   'active_users',
   *   db.users
   *     .where(u => lt(u.id, 100))
   *     .select(u => ({
   *       userId: u.id,
   *       createdAt: u.createdAt,
   *       postCount: u.posts.count()
   *     }))
   * );
   */
  with<TSelection extends Record<string, unknown>>(
    cteName: string,
    query: SelectQueryBuilder<TSelection> | { toList: () => Promise<TSelection[]> },
    options?: {
      /**
       * Emit the CTE `AS MATERIALIZED` — an optimizer fence forcing PostgreSQL
       * to compute it once as an opaque relation instead of inlining it into
       * the outer plan (the PG12+ default for single-reference CTEs). Use for
       * candidate-set CTEs that must drive the outer join order.
       */
      materialized?: boolean;
    }
  ): { cte: DbCte<TSelection> } {
    // A CTE body is nested in the statement that declares it: a data-modifying CTE the query carries
    // cannot be declared there
    if (typeof (query as any)._getAttachedCtes === 'function') {
      assertStatementLevelCtes((query as any)._getAttachedCtes(), undefined);
    }

    const context: SqlBuildContext = {
      paramCounter: this.paramOffset,
      params: [],
    };

    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: this.client ? !this.client.supportsBinaryArrayResults() : undefined,
      paramCounter: context.paramCounter,
      allParams: context.params,
      // The body's columns are read by other queries: its literals render typed
      typedLiterals: true,
    };

    let sql: string;
    let selectionResult: Record<string, any>;
    const paramBase = this.paramOffset;

    // Grouped query builders (`.groupBy(...).select(...)`, possibly with a
    // trailing `.leftJoin(...)`) render their body — including SUM/COUNT/MIN/MAX
    // aggregates and the GROUP BY — through `buildCteQuery`. They do NOT expose
    // `_createMockRow`/`selector`, so detect and handle them first. Column
    // definitions / mappers come from `getSelectionMetadata`. This lets an
    // aggregate query be used as a *plain* CTE (one row per group), distinct
    // from `withAggregation` which folds the whole group into a json_agg array.
    if (typeof (query as any).buildCteQuery === 'function') {
      const result = (query as any).buildCteQuery(queryContext);
      sql = result.sql;
      selectionResult = typeof (query as any).getSelectionMetadata === 'function'
        ? (query as any).getSelectionMetadata()
        : {};
    } else {
      // Standard SelectQueryBuilder — render via mock row + selector.
      const mockRow = (query as any)._createMockRow();
      selectionResult = materializeMockSelection((query as any).selector(mockRow));
      sql = (query as any).buildQuery(selectionResult, queryContext).sql;
    }

    // Update parameter offset for next CTE
    this.paramOffset = queryContext.paramCounter;

    // Create column definitions from the selection
    const columnDefs = {} as TSelection;
    if (selectionResult) {
      for (const key of Object.keys(selectionResult)) {
        (columnDefs as any)[key] = key;
      }
    }

    const cte = new DbCte<TSelection>(
      cteName,
      sql,
      context.params,
      columnDefs,
      selectionResult,
      undefined,
      options?.materialized,
      false,
      paramBase
    );
    this.ctes.push(cte);

    return { cte };
  }

  /**
   * Create a DATA-MODIFYING CTE from a pre-compiled DML statement (e.g. the
   * fluent update's `.toStatement()`), attachable to any query via `.with(cte)`.
   *
   * The canonical use is the CAS-gated load: the compare-and-swap UPDATE rides
   * as a CTE of the row-load SELECT — one statement where the outer query only
   * returns rows when the CAS matched (gate the outer WHERE on the CTE), the
   * table read keeps PRE-update snapshot semantics, and the CTE's RETURNING
   * exposes the POST-update values via scalar subselects. PostgreSQL executes
   * a data-modifying CTE exactly once whether or not the outer query reads it.
   * PostgreSQL only allows DML CTEs at the top-level statement — attach to the
   * query that executes directly, never inside another CTE.
   *
   * Read it with `db.selectFromCte(cte)…asSubquery()` inside the query that carries it (`.with(cte)`):
   * every nested read of the statement reads the ONE statement-level declaration by name. A
   * data-modifying CTE declared anywhere else — inside a nested subquery, inside another CTE's body — is
   * refused: PostgreSQL rejects it there, and run naively it would execute once per occurrence.
   *
   * @param cteName Name of the CTE (referenced from raw fragments as `"name"`).
   * @param statement Compiled DML — `{ sql, params }` with $1-based placeholders. A
   *   {@link CompiledStatement} from `toStatement(selector)` types the CTE's columns by its RETURNING.
   * @param columns Column names the statement's RETURNING exposes (typing only) — the older form,
   *   which types every column as its name.
   */
  withMutation<TRow>(
    cteName: string,
    statement: CompiledStatement<TRow>
  ): { cte: DbCte<TRow> };
  withMutation<TColumns extends Record<string, string>>(
    cteName: string,
    statement: { sql: string; params: any[] },
    columns: TColumns
  ): { cte: DbCte<TColumns> };
  withMutation(
    cteName: string,
    statement: { sql: string; params: any[] },
    columns?: Record<string, string>
  ): { cte: DbCte<any> } {
    const paramBase = this.paramOffset;
    const offset = this.paramOffset - 1;
    const sql = offset === 0 ? statement.sql : renumberPlaceholders(statement.sql, offset);

    this.paramOffset += statement.params.length;

    const cte = new DbCte<any>(
      cteName,
      sql,
      statement.params,
      // Without a columns map the columns are known to the type only (DbCte.as() mints them on read)
      columns ?? {},
      // A statement toStatement(selector) compiled carries its RETURNING selection: a column reads with
      // the type and mapper of what it returns (untyped, a text column's '0042' read as 42 and a
      // mapped column as its stored value). The (name, statement, columns) overload is the pre-1.0.9
      // form and keeps its untyped reads, so a program written against it reads what it always did.
      columns === undefined ? returningSelectionOf(statement) : undefined,
      undefined,
      false,
      true,
      paramBase
    );
    this.ctes.push(cte);

    return { cte };
  }

  /**
   * Create an aggregation CTE that groups results into a JSONB array
   *
   * @example
   * const aggregatedCte = cteBuilder.withAggregation(
   *   'aggregated_users',
   *   db.userAddress.select(ua => ({
   *     id: ua.id,
   *     userId: ua.userId,
   *     street: ua.address
   *   })),
   *   ua => ({ userId: ua.userId }),
   *   'items'
   * );
   */
  withAggregation<
    TSelection extends Record<string, unknown>,
    TKey extends Record<string, unknown>,
    TAlias extends string = 'items'
  >(
    cteName: string,
    query: SelectQueryBuilder<TSelection> | CteCompatibleQuery<TSelection>,
    keySelector: (value: TSelection) => TKey,
    aggregationAlias?: TAlias
  ): DbCte<UnwrapSelection<TKey> & { [K in TAlias]: Array<AggregatedItemType<TSelection, TKey>> }> {
    const paramBase = this.paramOffset;
    const context: SqlBuildContext = {
      paramCounter: this.paramOffset,
      params: [],
    };

    // Build the inner query - handle different query builder types
    // Also extract selection metadata for mapper preservation
    const { sql: innerSql, selectionMetadata: innerSelectionMetadata } = this.buildInnerQuerySqlWithMetadata(query, context);

    // Get group by columns - the keySelector maps output alias -> inner column name
    // e.g., p => ({ advancePriceId: p.userId }) means alias "advancePriceId" from inner column "userId"
    const mockItem = this.createMockItem();
    const groupByResult = keySelector(mockItem);
    const groupByEntries = Object.entries(groupByResult);

    // Build SELECT and GROUP BY with proper aliasing
    // SELECT "innerColumn" AS "outputAlias", ... GROUP BY "innerColumn"
    const selectColumns = groupByEntries
      .map(([outputAlias, innerColumn]) => {
        const innerCol = String(innerColumn);
        // If the alias differs from the inner column name, add AS clause
        if (outputAlias !== innerCol) {
          return `"${innerCol}" AS "${outputAlias}"`;
        }
        return `"${innerCol}"`;
      })
      .join(', ');
    const groupByClause = groupByEntries.map(([, innerColumn]) => `"${String(innerColumn)}"`).join(', ');

    // Use provided alias or default to 'items'
    const finalAggregationAlias = (aggregationAlias || 'items') as TAlias;

    // Build json_build_object with explicit columns for better performance
    // This is more efficient than to_jsonb(t.*) which includes all columns
    const groupByColumnSet = new Set(groupByEntries.map(([, innerColumn]) => String(innerColumn)));

    // Get all column names from inner selection metadata, excluding groupBy columns (and values the
    // inner query renders no column for: an undefined one)
    const aggregatedColumns: string[] = [];
    if (innerSelectionMetadata) {
      for (const key of Object.keys(innerSelectionMetadata)) {
        if (!groupByColumnSet.has(key) && innerSelectionMetadata[key] !== undefined) {
          aggregatedColumns.push(key);
        }
      }
    }

    // One key of an aggregated item: a column of the inner query, or — for a nested object (a
    // navigation row) it rendered as flattened `__nested__<path>` columns — the object rebuilt from
    // them. It used to name a column `"<key>"` the inner query does not have
    const jsonPart = (key: string, metaValue: unknown, column: string): string => {
      const nested = nestedProjectionMeta(metaValue);

      if (nested === undefined) {
        return `'${key}', "${column}"`;
      }

      // A nested value is always rendered (an undefined one as NULL, see renderFlatNestedLeaf)
      const prefix = column.startsWith('__nested__') ? column : `__nested__${column}`;
      const parts = Object.keys(nested).map(leaf => jsonPart(leaf, nested[leaf], `${prefix}__${leaf}`));

      return `'${key}', json_build_object(${parts.join(', ')})`;
    };

    // Build the aggregation expression
    // Use JSON instead of JSONB for better aggregation performance
    // JSON is faster because it doesn't parse/validate the structure during aggregation
    // The result is functionally equivalent for read operations
    let aggregationExpression: string;
    if (aggregatedColumns.length > 0) {
      // Use json_build_object for better performance - only include non-groupBy columns
      const jsonParts = aggregatedColumns.map(col => jsonPart(col, innerSelectionMetadata![col], col)).join(', ');
      aggregationExpression = `json_agg(json_build_object(${jsonParts}))`;
    } else {
      // Fallback to to_json(t.*) if we can't determine columns
      aggregationExpression = `json_agg(to_json(t.*))`;
    }

    const aggregationSql = `
      SELECT ${selectColumns},
             ${aggregationExpression} as "${finalAggregationAlias}"
      FROM (${innerSql}) t
      GROUP BY ${groupByClause}
    `.trim();

    // Update parameter offset
    this.paramOffset = context.paramCounter;

    // Create column definitions using output alias names
    const columnDefs: any = {};
    groupByEntries.forEach(([outputAlias]) => {
      columnDefs[outputAlias] = outputAlias;
    });
    columnDefs[finalAggregationAlias] = finalAggregationAlias;

    // Store inner selection metadata for mapper preservation during result transformation
    // The aggregation column contains items that need mappers applied. A grouping key is the inner
    // projection's value itself — a column (with its mapper and SQL type), an expression, a literal —
    // so a ref to it reads the way the inner column does (see projectedColumnRef)
    const selectionMetadata: Record<string, any> = {};
    groupByEntries.forEach(([outputAlias, innerColumn]) => {
      const innerCol = String(innerColumn);

      if (innerSelectionMetadata && innerCol in innerSelectionMetadata) {
        selectionMetadata[outputAlias] = innerSelectionMetadata[innerCol];
      }
    });
    // Store inner selection metadata under the aggregation alias so mappers can be applied to items
    selectionMetadata[finalAggregationAlias] = {
      __isAggregationArray: true,
      __innerSelectionMetadata: innerSelectionMetadata,
    };

    // Pass the aggregation alias as an aggregation column so it can be COALESCE'd in LEFT JOINs
    const cte = new DbCte(cteName, aggregationSql, context.params, columnDefs, selectionMetadata, [finalAggregationAlias], false, false, paramBase);
    this.ctes.push(cte);

    return cte;
  }

  /**
   * Build inner query SQL with metadata - handles different query builder types
   * Returns both the SQL and the selection metadata for mapper preservation
   */
  private buildInnerQuerySqlWithMetadata(query: any, context: SqlBuildContext): { sql: string; selectionMetadata: Record<string, any> | undefined } {
    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: this.client ? !this.client.supportsBinaryArrayResults() : undefined,
      paramCounter: context.paramCounter,
      allParams: context.params,
      // The aggregated rows' literals are typed like any CTE body's (they land in JSON typed)
      typedLiterals: true,
    };

    // Extract referenced CTEs from the query and add them to this builder
    if (typeof query.getReferencedCtes === 'function') {
      const referencedCtes = query.getReferencedCtes() as DbCte<any>[];
      for (const cte of referencedCtes) {
        if (!this.ctes.some(existing => existing.name === cte.name)) {
          this.ctes.push(cte);
        }
      }
    }

    let sql: string;
    let selectionMetadata: Record<string, any> | undefined;

    // Check for grouped query builders that have buildCteQuery method
    if (typeof query.buildCteQuery === 'function') {
      const result = query.buildCteQuery(queryContext);
      context.paramCounter = queryContext.paramCounter;
      sql = result.sql;

      // Try to extract selection metadata from grouped query
      if (typeof query.getSelectionMetadata === 'function') {
        selectionMetadata = query.getSelectionMetadata();
      }
    }
    // Standard SelectQueryBuilder - uses _createMockRow and selector
    else if (typeof query._createMockRow === 'function' && typeof query.selector === 'function') {
      const mockRow = query._createMockRow();
      const selectionResult = materializeMockSelection(query.selector(mockRow));
      const result = query.buildQuery(selectionResult, queryContext);
      context.paramCounter = queryContext.paramCounter;
      sql = result.sql;
      selectionMetadata = selectionResult;
    } else {
      throw new Error('Unsupported query type for CTE. Query must be a SelectQueryBuilder, GroupedSelectQueryBuilder, or GroupedJoinedQueryBuilder.');
    }

    return { sql, selectionMetadata };
  }

  /**
   * Build inner query SQL - handles different query builder types
   * - SelectQueryBuilder: uses _createMockRow() and selector()
   * - GroupedSelectQueryBuilder: uses buildCteQuery()
   * - GroupedJoinedQueryBuilder: uses buildCteQuery()
   *
   * This also extracts any CTEs referenced by the inner query and adds them to this builder
   * to avoid duplicate CTE definitions in nested queries.
   */
  private buildInnerQuerySql(query: any, context: SqlBuildContext): string {
    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: this.client ? !this.client.supportsBinaryArrayResults() : undefined,
      paramCounter: context.paramCounter,
      allParams: context.params,
    };

    // Extract referenced CTEs from the query and add them to this builder
    // This ensures CTEs are defined at the outermost level, not nested
    if (typeof query.getReferencedCtes === 'function') {
      const referencedCtes = query.getReferencedCtes() as DbCte<any>[];
      for (const cte of referencedCtes) {
        // Only add if not already present (avoid duplicates)
        if (!this.ctes.some(existing => existing.name === cte.name)) {
          this.ctes.push(cte);
        }
      }
    }

    // Check for grouped query builders that have buildCteQuery method
    if (typeof query.buildCteQuery === 'function') {
      const result = query.buildCteQuery(queryContext);
      context.paramCounter = queryContext.paramCounter;
      return result.sql;
    }

    // Standard SelectQueryBuilder - uses _createMockRow and selector
    if (typeof query._createMockRow === 'function' && typeof query.selector === 'function') {
      const mockRow = query._createMockRow();
      const selectionResult = query.selector(mockRow);
      const result = query.buildQuery(selectionResult, queryContext);
      context.paramCounter = queryContext.paramCounter;
      return result.sql;
    }

    throw new Error('Unsupported query type for CTE. Query must be a SelectQueryBuilder, GroupedSelectQueryBuilder, or GroupedJoinedQueryBuilder.');
  }

  /**
   * Get all CTEs created by this builder
   */
  getCtes(): DbCte<any>[] {
    return this.ctes;
  }

  /**
   * Clear all CTEs from this builder
   */
  clear(): void {
    this.ctes = [];
    this.paramOffset = 1;
  }

  /**
   * Infer column types from query selection
   */
  private inferColumnTypes(query: any): Record<string, any> {
    // Try to extract selection from query
    if (query.selection) {
      return query.selection;
    }
    return {};
  }

  /**
   * Create a mock item for extracting group by columns
   */
  private createMockItem(): any {
    return new Proxy({}, {
      get: (target, prop) => {
        if (typeof prop === 'string') {
          return prop;
        }
        return undefined;
      }
    });
  }
}

/**
 * Type helper to extract CTE column types
 */
export type InferCteColumns<T> = T extends DbCte<infer TColumns> ? TColumns : never;

/**
 * Type helper for aggregated items - removes the grouping keys from the selection
 * and unwraps DbColumn/SqlFragment types to their underlying values
 */
export type AggregatedItemType<
  TSelection extends Record<string, unknown>,
  TKey extends Record<string, unknown>
> = {
  [K in Exclude<keyof TSelection, keyof TKey>]: UnwrapSelection<TSelection[K]>;
};

/**
 * Check if a value is a CTE
 */
export function isCte(value: any): value is DbCte<any> {
  return value instanceof DbCte;
}
