import type { DatabaseClient } from '../database/database-client.interface';
import type { DbColumn } from '../entity/db-column';
import type { QueryExecutor } from '../entity/db-context';
import { assertExplicitAlias } from './aliased-scope';
import {
  and,
  assertPgTypeName,
  castTo,
  Condition,
  DRIVER_VALUE_MAPPER,
  FieldRef,
  isPlainSqlValue,
  PgCastType,
  SqlBuildContext,
  SqlFragment,
  UnwrapSelection,
  WhereConditionBase,
} from './conditions';
import { buildSelectParts, isSingleValueSelection, SCALAR_SELECTION_COLUMN, transformRows } from './cte-root-query';
import { holdsSqlValue, nextChainId } from './query-builder';
import { forEachOrderByKey } from './query-utils';
import type { SqlOperand } from './sql-functions';
import { selectorProjectingConditions } from './sql-functions';
import { Subquery } from './subquery';
import { UnionQueryBuilder } from './union-builder';
import type { UnionLegBuilder } from './union-builder';

/**
 * Set-returning functions — `unnest`, `jsonb_array_elements`, `jsonb_each_text` — as values that
 * multiply the rows of a projection, and as row sources: `fromSet()` (a context-free subquery),
 * `db.selectFromSet()` (a query of its own) and `crossJoinLateral()` (joined to every row of an
 * entity query).
 *
 * A set column reads back exactly as the driver delivers it (text stays text — '007' is not the
 * number 7 —, jsonb is the parsed JSON, NULL is `null`), never through the numeric-text coercion a
 * mapper-less expression gets.
 */

/** A set's row: one column ref per output column, typed by the column's value. */
export type SetRow<TRow> = {
  readonly [K in keyof TRow]-?: DbColumn<TRow[K]>;
};

/** The value of a single-column set, as a projection reads it. */
type SetValue<TRow> = TRow extends { value: infer V } ? V : TRow[keyof TRow];

/**
 * A call of a set-returning function: `unnest(…)`, `jsonb_array_elements(…)`, `jsonb_each_text(…)`.
 *
 * - As a projection value (a single-column set): the call as written — a set-returning select-list
 *   item, which multiplies the rows (`select(r => ({ tag: unnest(r.tags) }))`).
 * - As a source: `fromSet(set)`, `db.selectFromSet(set)`, `crossJoinLateral(row => set, …)` — its
 *   output columns are {@link columns}, read through the source's alias.
 *
 * Anywhere else — a WHERE, a HAVING, an ORDER BY, a GROUP BY key, a CASE, an aggregate's argument,
 * another expression — it is refused: PostgreSQL rejects most of those, and the rest multiply rows in
 * places no one expects.
 */
export class SetReturningFunction<TRow extends Record<string, unknown> = Record<string, unknown>> extends SqlFragment<SetValue<TRow>> {
  /** The output columns, in order: the names a source aliases them as, the keys of its row. */
  readonly columns: readonly string[];

  /** @internal The function's name: the default alias of a source over it. */
  readonly functionName: string;

  /** @internal The SQL type of each output column (when known) — how a column of it compares and reads. */
  readonly columnTypes: readonly (string | undefined)[];

  private readonly callParts: string[];
  private readonly callValues: unknown[];
  /** The SQL type the projected values read as (see {@link withReadType}). */
  private setReadType?: string;

  /** @internal */
  constructor(
    functionName: string,
    parts: string[],
    values: unknown[],
    columns: readonly string[],
    columnTypes: readonly (string | undefined)[],
    mapper: any = DRIVER_VALUE_MAPPER,
    alias?: string
  ) {
    super(parts, values, mapper, alias);
    this.functionName = functionName;
    this.callParts = parts;
    this.callValues = values;
    this.columns = columns;
    this.columnTypes = columnTypes;
  }

  /**
   * A set-returning function renders only as a projection value or as a source; nested in any other
   * expression it is refused (see the class docs).
   */
  override buildSql(_context: SqlBuildContext): string {
    throw new Error(
      `${this.functionName}() returns a set of rows: use it as a projection value (select(r => ({ v: ${this.functionName}(…) }))) `
      + 'or as a row source (fromSet(), db.selectFromSet(), crossJoinLateral()) — not inside a WHERE, HAVING, ORDER BY, '
      + 'GROUP BY key, CASE, an aggregate\'s argument or another expression'
    );
  }

  /** @internal The call itself, `unnest(CAST($1 AS text[]))`, its parameters appended to `context`. */
  renderCall(context: SqlBuildContext): string {
    return super.buildSql(context);
  }

  /** @internal As a projection value: the call — refused for a set of several columns (it would project a record). */
  renderProjection(context: SqlBuildContext): string {
    if (this.columns.length !== 1) {
      throw new Error(
        `${this.functionName}() returns ${this.columns.length} columns (${this.columns.join(', ')}): a projection value is one column — `
        + 'read them through a source: fromSet(), db.selectFromSet() or crossJoinLateral()'
      );
    }

    return this.renderCall(context);
  }

  /** @internal As a FROM / LATERAL item: `<call> AS "<alias>"("<c1>", …)`. */
  renderSource(alias: string, context: SqlBuildContext): string {
    return `${this.renderCall(context)} AS "${alias}"(${this.columns.map(column => `"${column}"`).join(', ')})`;
  }

  /**
   * A projection alias; the set stays a set at runtime (the refusals and the projection form still
   * apply). Typed as the plain fragment it projects as — its value type then unwraps like any
   * fragment's.
   */
  override as(alias: string): SqlFragment<SetValue<TRow>> {
    const copy = new SetReturningFunction<TRow>(this.functionName, this.callParts, this.callValues, this.columns, this.columnTypes, this.getMapper(), alias);
    copy.setReadType = this.setReadType;

    return copy;
  }

  /**
   * Read the projected values as a column of `pgType` reads (see `SqlFragment.withReadType`); the set
   * stays a set. It used to be wrapped into a plain fragment, which a projection then refused as a set
   * nested in an expression.
   */
  override withReadType<U = SetValue<TRow>>(pgType: PgCastType): SqlFragment<U> {
    // `null`, not `undefined`: the constructor's default would restore the driver-value mapper, which
    // outranks a read type
    const copy = new SetReturningFunction<TRow>(this.functionName, this.callParts, this.callValues, this.columns, this.columnTypes, null, this.getAlias());
    copy.setReadType = assertPgTypeName(pgType);

    return copy as unknown as SqlFragment<U>;
  }

  /** The SQL type set by {@link withReadType}, if any (internal use). */
  override getReadType(): string | undefined {
    return this.setReadType;
  }

  /** Read the projected values through `mapper`; the set stays a set. */
  override mapWith<TData, TDriver = any>(mapper: (value: TDriver) => TData): SqlFragment<TData>;
  override mapWith<TData = SetValue<TRow>>(mapper: object): SqlFragment<TData>;
  override mapWith(mapper: any): SqlFragment<any> {
    const normalized = typeof mapper === 'function'
      ? { fromDriver: (value: any) => (value == null ? value : mapper(value)) }
      : mapper;

    return new SetReturningFunction<TRow>(this.functionName, this.callParts, this.callValues, this.columns, this.columnTypes, normalized, this.getAlias());
  }
}

/**
 * The SQL of a fragment projected as a select-list item: a set-returning function as its call (the
 * one place it may render as a value), any other fragment as it renders. @internal
 */
export function renderProjectedFragment(fragment: SqlFragment<any>, context: SqlBuildContext): string {
  return fragment instanceof SetReturningFunction ? fragment.renderProjection(context) : fragment.buildSql(context);
}

/** The element type of an array type name (`text[]` → `text`), or `undefined` when it is none. */
function elementTypeOf(sqlType: unknown): string | undefined {
  return typeof sqlType === 'string' && /\[\d*\]\s*$/.test(sqlType)
    ? sqlType.replace(/\s*\[\d*\]\s*$/, '')
    : undefined;
}

/**
 * Refuses a JS value holding column refs or expressions: bound as ONE parameter, their objects would be
 * serialized into it — silent garbage instead of the columns.
 */
function assertBindable(usage: string, value: unknown, instead: string): void {
  if (isPlainSqlValue(value) && holdsSqlValue(value)) {
    throw new Error(`${usage}: a JS ${Array.isArray(value) ? 'array' : 'object'} holding column refs or expressions cannot be bound as a value — ${instead}`);
  }
}

/** One array argument of `unnest`: a JS array bound as ONE typed array literal, a column or expression as is (cast when typed). */
function arrayArgument(usage: string, array: unknown, elementType: PgCastType | undefined): unknown {
  assertBindable(usage, array, 'build the array in SQL (sql`ARRAY[…]`), or unnest the columns with unnestZip()');

  if (array === undefined || array === null || Array.isArray(array)) {
    if (elementType === undefined) {
      throw new Error(`${usage}: a ${array == null ? 'null' : 'JS array'} needs its element type — ${usage}(values, 'text')`);
    }

    return castTo(array, `${elementType}[]`);
  }

  if (isPlainSqlValue(array)) {
    throw new Error(`${usage}: expected an array — a JS array, an array column or an array expression — got ${typeof array}`);
  }

  return elementType === undefined ? array : castTo(array, `${elementType}[]`);
}

/**
 * `unnest(array)` — one row per element, the element in the column `value`.
 *
 * `array` is an array column or expression (`unnest(r.tags)`), or a JS array — which binds as ONE
 * parameter, the array literal cast to `<elementType>[]` (`unnest(CAST($1 AS text[]))`); a JS array
 * needs its `elementType`. NULL and an empty array give no rows.
 *
 * @example
 * // a set-returning projection value: one row per tag
 * db.shelves.select(s => ({ id: s.id, tag: unnest(s.tags) }))
 *
 * // a source
 * db.selectFromSet(unnest(names, 'text'), 'n').select(n => ({ name: n.value, key: lower(n.value) }))
 */
export function unnest<T>(
  array: SqlOperand<readonly T[] | null | undefined> | readonly T[] | null | undefined,
  elementType?: PgCastType
): SetReturningFunction<{ value: T }> {
  const argument = arrayArgument('unnest', array, elementType);
  const type = elementType ?? elementTypeOf((array as any)?.__sqlType);

  return new SetReturningFunction<{ value: T }>('unnest', ['unnest(', ')'], [argument], ['value'], [type]);
}

/**
 * Multi-argument `unnest(a, b, …)` — the arrays zipped by position into rows of the given columns,
 * a shorter array padded with NULL. Each column's values are a JS array (ONE parameter, cast to
 * `<type>[]`) or an array column / expression (cast to `<type>[]`).
 *
 * @example
 * db.selectFromSet(unnestZip({
 *   id: { values: [3, 9], type: 'integer' },
 *   amount: { values: [100, 250], type: 'integer' },
 * }), 't')
 * // FROM unnest(CAST($1 AS integer[]), CAST($2 AS integer[])) AS "t"("id", "amount")
 */
export function unnestZip<T extends Record<string, unknown>>(
  columns: { [K in keyof T]: { values: readonly T[K][] | SqlOperand; type: PgCastType } }
): SetReturningFunction<T> {
  const names = Object.keys(columns);

  if (names.length === 0) {
    throw new Error('unnestZip: give at least one column — { name: { values, type } }');
  }

  const parts = ['unnest('];
  const values: unknown[] = [];
  const types: string[] = [];

  names.forEach((name, index) => {
    assertExplicitAlias(name, 'unnestZip column');
    const column = (columns as Record<string, { values: unknown; type: PgCastType }>)[name];

    if (column === null || typeof column !== 'object' || typeof column.type !== 'string') {
      throw new Error(`unnestZip: column "${name}" must be { values, type }`);
    }

    values.push(arrayArgument(`unnestZip column "${name}"`, column.values, column.type));
    types.push(column.type);
    parts.push(index === names.length - 1 ? ')' : ', ');
  });

  return new SetReturningFunction<T>('unnest', parts, values, names, types);
}

/** A jsonb operand: a column or expression as is, a plain JS value serialized and cast. */
function jsonbArgument(usage: string, target: unknown): unknown {
  assertBindable(usage, target, 'build the jsonb in SQL (sql`jsonb_build_object(…)` / sql`jsonb_build_array(…)`)');

  return isPlainSqlValue(target) ? castTo(target, 'jsonb') : target;
}

/**
 * `jsonb_array_elements(target)` — one row per element of a jsonb array, the element (jsonb) in the
 * column `value`. A NULL target gives no rows; a non-array raises (PostgreSQL's
 * `cannot extract elements from …`).
 *
 * @example
 * db.boxes.crossJoinLateral(b => jsonbArrayElements(b.items), (b, item) => ({ box: b.id, kind: jsonbPathText(item.value, 'kind') }), 'item')
 */
export function jsonbArrayElements<T = unknown>(target: SqlOperand): SetReturningFunction<{ value: T }> {
  return new SetReturningFunction<{ value: T }>('jsonb_array_elements', ['jsonb_array_elements(', ')'], [jsonbArgument('jsonbArrayElements()', target)], ['value'], ['jsonb']);
}

/**
 * `jsonb_each_text(target)` — one row per key of a jsonb object: `key` and its value as text (a JSON
 * null is SQL NULL). A NULL target gives no rows; a non-object raises.
 *
 * @example
 * exists(fromSet(jsonbEachText(p.names), 'kv').where(kv => eq(kv.value, slug)).select(() => ({ one: literal(1) })).asSubquery())
 */
export function jsonbEachText(target: SqlOperand): SetReturningFunction<{ key: string; value: string | null }> {
  return new SetReturningFunction<{ key: string; value: string | null }>(
    'jsonb_each_text',
    ['jsonb_each_text(', ')'],
    [jsonbArgument('jsonbEachText()', target)],
    ['key', 'value'],
    ['text', 'text']
  );
}

/**
 * The row of a set under `alias`: one ref per output column, reading as the driver delivers it. The
 * refs carry `chainId` — the query the set belongs to (a lateral set's entity query), or an identity of
 * its own (a set query): a query nested in it reads them as correlations. Resolved by alias NAME, an
 * alias equal to one of that query's navigations (`group`) was its own join, compared with itself.
 * @internal
 */
export function createSetRow<TRow extends Record<string, unknown>>(set: SetReturningFunction<TRow>, alias: string, chainId: number): SetRow<TRow> {
  const row: Record<string, unknown> = {};

  set.columns.forEach((column, index) => {
    const ref = {
      __fieldName: column,
      __dbColumnName: column,
      __tableAlias: alias,
      // Never the column of a table named like the reading query's (see compileFieldRead)
      __sourceTable: alias,
      __mapper: DRIVER_VALUE_MAPPER,
      __sqlType: set.columnTypes[index],
      __setColumn: true,
      __chainId: chainId,
    };

    Object.defineProperty(row, column, { get: () => ref, enumerable: true });
  });

  return row as SetRow<TRow>;
}

/** A set joined to every row of an entity query: `CROSS JOIN LATERAL <call> AS "<alias>"(…)`. @internal */
export interface LateralSetJoin {
  readonly set: SetReturningFunction<any>;
  readonly alias: string;
}

/**
 * `\nCROSS JOIN LATERAL <call> AS "<alias>"(…)` for every lateral set, their params appended to `context`.
 * The query's joins (`precedingJoins`) render BEFORE its lateral sets — whenever they were added — so
 * a join whose ON predicate reads a set is refused: the set is not in scope there. @internal
 */
export function lateralSetJoinsSql(
  joins: readonly LateralSetJoin[],
  context: SqlBuildContext,
  precedingJoins: readonly { alias: string; condition?: Condition }[] = []
): string {
  if (joins.length === 0) {
    return '';
  }

  const setAliases = new Set(joins.map(join => join.alias));

  for (const join of precedingJoins) {
    const read = join.condition?.getFieldRefs().find(ref => setAliases.has((ref as any).__tableAlias));

    if (read !== undefined) {
      throw new Error(
        `crossJoinLateral(): the ON predicate of the join "${join.alias}" reads the set "${(read as any).__tableAlias}" — a query's joins `
        + 'render before its lateral sets, so the set is not in scope there. Filter on the set\'s values with where() instead.'
      );
    }
  }

  return joins.map(join => `\nCROSS JOIN LATERAL ${join.set.renderSource(join.alias, context)}`).join('');
}

/**
 * Whether a projection holds a set-returning function as a value (at any depth of its nested objects):
 * its rows are multiplied by the set, which `COUNT(*)` / `EXISTS` over the FROM never see. @internal
 */
export function holdsSetReturningValue(selection: unknown, depth: number = 0): boolean {
  if (selection instanceof SetReturningFunction) {
    return true;
  }

  if (selection === null || typeof selection !== 'object' || depth > 16 || Object.getPrototypeOf(selection) !== Object.prototype) {
    return false;
  }

  return Object.values(selection).some(value => holdsSetReturningValue(value, depth + 1));
}

/** The refs the functions of `joins` read from their query's rows (their arguments'). @internal */
export function lateralSetRefs(joins: readonly LateralSetJoin[]): FieldRef[] {
  return joins.flatMap(join => join.set.getFieldRefs());
}

/** Everything a set query holds; a set query never changes it after construction (see SetQueryBuilder). */
interface SetQueryState {
  readonly set: SetReturningFunction<any>;
  readonly alias: string;
  readonly row: Record<string, any>;
  readonly whereConds: readonly Condition[];
  readonly selector?: (row: any) => any;
  readonly orderKeys: readonly { readonly key: unknown; readonly direction: string }[];
  readonly limitCount?: number;
  readonly offsetCount?: number;
  readonly client?: DatabaseClient;
  readonly executor?: QueryExecutor;
}

/** A client for a context-free set query: running one is refused with a pointer to `db.selectFromSet()`. */
function unboundClient(): DatabaseClient {
  return new Proxy({} as DatabaseClient, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined;
      }

      return () => {
        throw new Error('fromSet(): a context-free set query cannot run on its own — run it through db.selectFromSet(...), or embed it with .asSubquery()');
      };
    },
  });
}

/**
 * A query over a set-returning function: `SELECT <selection> FROM <call> AS "<alias>"("<c1>", …) [WHERE …]
 * [ORDER BY …] [LIMIT n] [OFFSET m]`. Built context-free by {@link fromSet} (embed it with
 * `.asSubquery()` / as a union leg) or bound to a context by `db.selectFromSet()` (run it with
 * `.toList()` / `.firstOrDefault()`). Every method returns a new query.
 *
 * The row's columns render `"<alias>"."<column>"`; anything else the callbacks read — a column of an
 * enclosing query, in the function's argument too — is a correlation, rendered as that column and
 * reported by the subquery form (`getOuterFieldRefs()`) so the enclosing query joins its navigations.
 */
export class SetQueryBuilder<TRow extends Record<string, unknown>, TSelection = TRow> {
  /** @internal Metadata of the last `buildUnionSql` (the union reads its rows through its first leg). */
  private unionMetadata?: { nestedPaths: Set<string>; selectionResult: any };

  /** @internal */
  constructor(private readonly state: SetQueryState) {}

  /** @internal */
  static create<TRow extends Record<string, unknown>>(
    set: SetReturningFunction<TRow>,
    alias: string | undefined,
    client?: DatabaseClient,
    executor?: QueryExecutor
  ): SetQueryBuilder<TRow, TRow> {
    if (!(set instanceof SetReturningFunction)) {
      throw new Error('fromSet(): expected a set-returning function — unnest(…), unnestZip(…), jsonbArrayElements(…), jsonbEachText(…)');
    }

    const effectiveAlias = assertExplicitAlias(alias ?? set.functionName, 'fromSet()');

    return new SetQueryBuilder<TRow, TRow>({
      set,
      alias: effectiveAlias,
      row: createSetRow(set, effectiveAlias, nextChainId()),
      whereConds: [],
      orderKeys: [],
      client,
      executor,
    });
  }

  /** Filter the set's rows; repeated calls combine with AND. */
  where(predicate: (row: SetRow<TRow>) => Condition): SetQueryBuilder<TRow, TSelection> {
    const condition = predicate(this.state.row as SetRow<TRow>);

    if (!(condition instanceof WhereConditionBase)) {
      throw new Error('fromSet().where(): expected a condition (eq(), and(), exists(), a boolean sql fragment, …)');
    }

    return new SetQueryBuilder<TRow, TSelection>({ ...this.state, whereConds: [...this.state.whereConds, condition] });
  }

  /** Project the set's row — an object of fields, or one value (`n => n.value`). */
  select<TNewSelection>(selector: (row: SetRow<TRow>) => TNewSelection): SetQueryBuilder<TRow, UnwrapSelection<TNewSelection>> {
    return new SetQueryBuilder<TRow, UnwrapSelection<TNewSelection>>({ ...this.state, selector: selectorProjectingConditions(selector as any) });
  }

  /**
   * ORDER BY over the set's row — a column, an expression, a list of them, `[key, direction]` pairs
   * (`r => [[r.key, 'DESC'], r.value]`). Replaces a previous orderBy().
   */
  orderBy(selector: (row: SetRow<TRow>) => unknown): SetQueryBuilder<TRow, TSelection> {
    const orderKeys: Array<{ key: unknown; direction: string }> = [];
    const add = (key: unknown, direction: string): void => {
      orderKeys.push({ key, direction });
    };

    forEachOrderByKey(selector(this.state.row as SetRow<TRow>) as any, add, add);

    return new SetQueryBuilder<TRow, TSelection>({ ...this.state, orderKeys });
  }

  /** `LIMIT n` — an inline non-negative integer. */
  limit(count: number): SetQueryBuilder<TRow, TSelection> {
    return new SetQueryBuilder<TRow, TSelection>({ ...this.state, limitCount: assertCount('limit', count) });
  }

  /** `OFFSET n` — an inline non-negative integer. */
  offset(count: number): SetQueryBuilder<TRow, TSelection> {
    return new SetQueryBuilder<TRow, TSelection>({ ...this.state, offsetCount: assertCount('offset', count) });
  }

  /** `(this) UNION (other)` — see {@link UnionQueryBuilder}; the union reads every row the way this first leg does. */
  union(query: UnionLegBuilder): UnionQueryBuilder<TSelection> {
    return new UnionQueryBuilder<TSelection>(this, this.state.client ?? unboundClient(), this.state.executor).union(query);
  }

  /** `(this) UNION ALL (other)` — see {@link union}. */
  unionAll(query: UnionLegBuilder): UnionQueryBuilder<TSelection> {
    return new UnionQueryBuilder<TSelection>(this, this.state.client ?? unboundClient(), this.state.executor).unionAll(query);
  }

  /**
   * The query as a {@link Subquery}: `'scalar'` (one value — `coalesce`, a comparison, a projection),
   * `'array'` (`inSubquery`, `eqAnySubquery`) or `'table'` (`exists`, `notExists`, a join).
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<TMode extends 'scalar' ? SingleValue<TSelection> : TMode extends 'array' ? SingleValue<TSelection>[] : TSelection, TMode> {
    const sqlBuilder = (outerContext: SqlBuildContext): string => this.buildSelect(outerContext, true);
    const selectionMetadata = mode === 'table' ? this.evaluateSelection() : undefined;

    return new Subquery(sqlBuilder, mode, selectionMetadata, this.outerFieldRefs()) as any;
  }

  /** Run the query (`db.selectFromSet(...)` only) and read its rows. */
  async toList(): Promise<TSelection[]> {
    const { client, executor } = this.state;

    if (!client) {
      throw new Error('fromSet(): a context-free set query cannot run on its own — run it through db.selectFromSet(...), or embed it with .asSubquery()');
    }

    const { sql, params } = this.buildStatement();
    const result = executor ? await executor.query(sql, params) : await client.query(sql, params);

    return this.readRows(result.rows);
  }

  /** The first row, or `null`. */
  async firstOrDefault(): Promise<TSelection | null> {
    const rows = await this.limit(1).toList();
    return rows.length > 0 ? rows[0] : null;
  }

  /** The statement's SQL (for debugging and assertions). */
  toSql(): string {
    return this.buildStatement().sql;
  }

  /** @internal The statement as it runs on its own. */
  buildStatement(): { sql: string; params: any[] } {
    const context: SqlBuildContext = {
      paramCounter: 1,
      params: [],
      // The driver reads the projected values directly: an arrayAgg a value IS renders as JSON on a driver
      // without native array results (buildSelectParts marks each value's root), as a CTE-rooted statement does
      jsonArrayProjection: this.state.client ? !this.state.client.supportsBinaryArrayResults() : undefined,
    };
    const sql = this.buildSelect(context, false);
    return { sql, params: context.params };
  }

  /** @internal UnionLegBuilder — this query as a union leg (in parentheses, its ORDER BY / LIMIT kept). */
  buildUnionSql(context: SqlBuildContext): string {
    this.unionMetadata = { nestedPaths: new Set(), selectionResult: this.evaluateSelection() };
    return this.buildSelect(context, false);
  }

  /** @internal UnionLegBuilder */
  _consumeUnionMetadata(): { nestedPaths: Set<string>; selectionResult: any } | undefined {
    const metadata = this.unionMetadata;
    this.unionMetadata = undefined;
    return metadata;
  }

  /** @internal UnionLegBuilder — a union's rows, read the way this first leg reads its own. */
  _applyUnionPostProcessing(rows: any[], _metadata: { nestedPaths: Set<string>; selectionResult: any }): any[] {
    return this.readRows(rows);
  }

  /** The refs the query reads from an enclosing query: every ref of its function's argument, WHERE, projection and ORDER BY that is not a column of its row. */
  private outerFieldRefs(): FieldRef[] {
    const own = new Set<object>(Object.values(this.state.row));
    const refs: FieldRef[] = [];
    const seen = new Set<object>();

    const add = (ref: FieldRef): void => {
      if (!own.has(ref) && !seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    };

    const visit = (value: unknown, depth: number): void => {
      if (value === null || typeof value !== 'object' || depth > 16) {
        return;
      }

      if (value instanceof SetReturningFunction || value instanceof WhereConditionBase) {
        value.getFieldRefs().forEach(add);
      } else if (value instanceof Subquery) {
        value.getOuterFieldRefs().forEach(add);
      } else if ('__dbColumnName' in value) {
        add(value as FieldRef);
      } else if (Object.getPrototypeOf(value) === Object.prototype) {
        for (const nested of Object.values(value)) {
          visit(nested, depth + 1);
        }
      }
    };

    visit(this.state.set, 0);
    this.state.whereConds.forEach(condition => visit(condition, 0));
    visit(this.evaluateSelection(), 0);
    this.state.orderKeys.forEach(({ key }) => visit(key, 0));

    return refs;
  }

  /** The projection as an object of fields: one value is projected as the field `value`. */
  private evaluateSelection(): Record<string, any> {
    const selection = this.state.selector ? this.state.selector(this.state.row) : { ...this.state.row };

    return isSingleValueSelection(selection) ? { [SCALAR_SELECTION_COLUMN]: selection } : selection;
  }

  /** Whether the projection is one value — the rows then read as that value. */
  private selectsSingleValue(): boolean {
    return this.state.selector !== undefined && isSingleValueSelection(this.state.selector(this.state.row));
  }

  private readRows(rows: any[]): any[] {
    const read = transformRows(rows, this.evaluateSelection());
    return this.selectsSingleValue() ? read.map(row => row[SCALAR_SELECTION_COLUMN]) : read;
  }

  /**
   * `SELECT … FROM <call> AS "<alias>"(…) [WHERE …] [ORDER BY …] [LIMIT n] [OFFSET m]` in `context` —
   * parameters in textual order. `typedLiterals`: the projection's literals render typed, for an
   * enclosing query reading them as columns.
   */
  private buildSelect(context: SqlBuildContext, typedLiterals: boolean): string {
    const { set, alias } = this.state;

    // Inside the query the alias names ITS row: a correlation to a row under the same alias would read it instead
    for (const ref of this.outerFieldRefs()) {
      if ((ref as any).__tableAlias === alias) {
        throw new Error(
          `fromSet(): the alias "${alias}" is both the set's alias and the alias of the column "${alias}"."${ref.__dbColumnName}" `
          + 'it correlates to — give the set another alias (fromSet(set, \'<alias>\'))'
        );
      }
    }

    const selectParts = buildSelectParts(this.evaluateSelection(), context, alias, typedLiterals);
    let sql = `SELECT ${selectParts.join(', ')}\nFROM ${set.renderSource(alias, context)}`;

    if (this.state.whereConds.length > 0) {
      const condition = this.state.whereConds.length === 1 ? this.state.whereConds[0] : and(...this.state.whereConds);
      sql += `\nWHERE ${condition.buildSql(context)}`;
    }

    if (this.state.orderKeys.length > 0) {
      const keys = this.state.orderKeys.map(({ key, direction }) => {
        const keySql = key instanceof WhereConditionBase
          ? `(${key.buildSql(context)})`
          : new SqlFragment(['', ''], [key]).buildSql(context);

        return `${keySql} ${direction}`;
      });
      sql += `\nORDER BY ${keys.join(', ')}`;
    }

    if (this.state.limitCount !== undefined) {
      sql += `\nLIMIT ${this.state.limitCount}`;
    }

    if (this.state.offsetCount !== undefined) {
      sql += `\nOFFSET ${this.state.offsetCount}`;
    }

    return sql;
  }
}

/** The value a one-column projection carries (see CteRootQueryBuilder's SingleColumnValue). */
type SingleValue<TSelection> = TSelection extends Record<string, any> ? TSelection[keyof TSelection] : TSelection;

function assertCount(method: string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`fromSet().${method}(): expected a non-negative integer, got ${String(count)}`);
  }

  return count;
}

/**
 * A query over a set-returning function, needing no context — for helpers that build expressions
 * without a `DbContext` at hand. Embed it with `.asSubquery('scalar' | 'array' | 'table')` (in
 * `exists`, `inSubquery`, `coalesce`, a projection, …) or as a union leg; to run one on its own use
 * `db.selectFromSet()`. The alias defaults to the function's name.
 *
 * @example
 * // Does any value of the jsonb object equal `slug`?
 * exists(fromSet(jsonbEachText(p.slugs), 'kv').where(kv => eq(kv.value, slug)).select(() => ({ one: literal(1) })).asSubquery())
 *
 * // The first non-NULL value
 * fromSet(jsonbEachText(p.names), 'kv').where(kv => isNotNull(kv.value)).select(kv => kv.value).limit(1).asSubquery('scalar')
 */
export function fromSet<TRow extends Record<string, unknown>>(set: SetReturningFunction<TRow>, alias?: string): SetQueryBuilder<TRow, TRow> {
  return SetQueryBuilder.create(set, alias);
}
