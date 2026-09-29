import { applyBatchOverrides, FutureBatchMeta, FutureCountQuery, FutureQuery, FutureSingleQuery } from './future-query';
import type { BatchTypeOids } from './future-query';
import { DATE_STYLE_TYPE_OIDS, FIRST_USER_TYPE_OID, JSON_TEXT_TYPE_OIDS, JSON_TYPE_OID, TEXT_TRANSPORT_TYPE_OIDS } from '../database/typed-text';

/**
 * Typed handle returned by QueryBatch.addList(). Carries the element type so
 * getList(key) infers without manual generics; stringly-typed lookup remains
 * available as an escape hatch.
 */
export interface BatchListKey<T> {
  readonly id: string;
  readonly kind: 'list';
  /** @internal phantom type carrier — never assigned */
  readonly __element?: T;
}

/**
 * Typed handle returned by QueryBatch.addFirstOrDefault().
 */
export interface BatchItemKey<T> {
  readonly id: string;
  readonly kind: 'first';
  /** @internal phantom type carrier — never assigned */
  readonly __element?: T;
}

/**
 * Typed handle returned by QueryBatch.addCount().
 */
export interface BatchCountKey {
  readonly id: string;
  readonly kind: 'count';
}

/** Query sources accepted by the add* methods (any builder exposing the future factories). */
export interface BatchListSource<T> {
  future(): FutureQuery<T>;
}

export interface BatchItemSource<T> {
  futureFirstOrDefault(): FutureSingleQuery<T>;
}

export interface BatchCountSource {
  futureCount(): FutureCountQuery;
}

type BatchKind = 'list' | 'first' | 'count';

interface BatchEntry {
  id: string;
  kind: BatchKind;
  future: FutureQuery<any> | FutureSingleQuery<any> | FutureCountQuery;
}

/**
 * Quote-aware `$N` renumbering (string literals containing `$1` pass through
 * verbatim) — moved to `sql-utils` so the entity layer can share it without a
 * module cycle; re-exported here for existing importers.
 */
export { renumberPlaceholders } from './sql-utils';
import { renumberPlaceholders } from './sql-utils';

/** A column of a branch's row (`(__batch_q."…")`). */
const branchColumnSql = (column: string): string => `(__batch_q."${column.replace(/"/g, '""')}")`;

/**
 * Whether the session's `DateStyle` writes a date / timestamp as ISO — the form their JSON takes whatever the
 * style (see DATE_STYLE_TYPE_OIDS). Uncorrelated: PostgreSQL evaluates it once per statement.
 */
const ISO_DATE_STYLE_SQL = '(SELECT current_setting(\'DateStyle\') LIKE \'ISO%\')';

/** The date / timestamp / timestamptz types, as an array literal of their OIDs (see DATE_STYLE_TYPE_OIDS). */
const DATE_STYLE_TYPES_SQL = `'{${DATE_STYLE_TYPE_OIDS.join(',')}}'::oid[]`;

/**
 * Whether the server has to send a value's TEXT alongside the row whatever the session's settings — per row,
 * but constant for a column: a type of `textTypes` (the types the client parses from their text whose JSON
 * form does not give it back, see JSON_TEXT_TYPE_OIDS) or a user-defined one (a domain, an enum, a
 * composite, an extension's type), whose base type only the branch's header says.
 */
function needsServerTextSql(column: string, textTypes: string): string {
  const value = branchColumnSql(column);

  return `pg_typeof(${value})::oid = ANY(${textTypes}) OR pg_typeof(${value})::oid >= ${FIRST_USER_TYPE_OID}`;
}

/** Whether a value is a date / timestamp / timestamptz — whose JSON form is its text only under `DateStyle` ISO. */
const dateStyledSql = (column: string): string => `pg_typeof(${branchColumnSql(column)})::oid = ANY(${DATE_STYLE_TYPES_SQL})`;

/**
 * Whether a value's runtime type needs its TEXT sent alongside the row — per row, but constant for a column:
 * see needsServerTextSql, and — when the client rebuilds texts from the row (`rebuildsFromJson`, see
 * executeBatch) — a date / timestamp / timestamptz when the session's `DateStyle` is not ISO.
 */
function needsTextSql(column: string, textTypes: string, rebuildsFromJson: boolean): string {
  return rebuildsFromJson
    ? `(${needsServerTextSql(column, textTypes)} OR (NOT ${ISO_DATE_STYLE_SQL} AND ${dateStyledSql(column)}))`
    : `(${needsServerTextSql(column, textTypes)})`;
}

/**
 * The (base) type of each text-sent value of a branch, ONCE for the branch — the OID the aggregate found
 * (`__batch_s.t<i>`: the type is the same for every row of a column; NULL over no rows), resolved to the
 * type a domain is over (the drivers read a domain's value by that type): one catalog lookup per value.
 * Only a domain the server sends the text of is resolved — a user-defined one, or one of `textTypes`: a
 * domain the catalog itself defines (OID below 16384, `information_schema.time_stamp` over timestamptz)
 * sends none, and its value keeps its JSON form, as it always did — never rebuilt as the text of the type
 * it is over.
 */
function typeOidsSql(count: number, textTypes: string): string {
  const oids = Array.from({ length: count }, (_, i) => '(SELECT (CASE WHEN __batch_t.typtype = \'d\' '
    + `AND (__batch_t.oid >= ${FIRST_USER_TYPE_OID} OR __batch_t.oid = ANY(${textTypes})) THEN __batch_t.typbasetype `
    + `ELSE __batch_t.oid END)::bigint FROM pg_catalog.pg_type __batch_t WHERE __batch_t.oid = __batch_s.t${i})`);

  return `to_json(ARRAY[${oids.join(', ')}]::bigint[])`;
}

/**
 * A value's text as the wire protocol sends it for a column — its type's OUTPUT function (`concat()` applies
 * it), which the drivers parse: a CAST to text differs for a boolean (`true`, where the wire sends `t`), an
 * inet (`/32` appended), a char(n) (its padding trimmed). The text of NULL is empty: a NULL value keeps its
 * JSON null (see applyBatchOverrides).
 */
const outputTextSql = (column: string): string => `concat(${branchColumnSql(column)})`;

/**
 * The texts a branch sends alongside its rows — one array per row, in row order, of one text (or NULL)
 * per text column (always), then per runtime-typed value (when its type needs it) — NULL when no value of
 * the branch needs one (the FILTER, constant per column, then admits no row; it asks for the session's
 * `DateStyle` once per row, not once per value) — and each value's type OID.
 */
function textsAndTypesSql(textColumns: readonly string[], typedColumns: readonly string[], textTypes: string, rebuildsFromJson: boolean): string {
  const texts = [
    ...textColumns.map((column) => outputTextSql(column)),
    ...typedColumns.map((column) => `CASE WHEN ${needsTextSql(column, textTypes, rebuildsFromJson)} THEN ${outputTextSql(column)} END`),
  ];
  const filter = textColumns.length > 0
    ? ''
    : rebuildsFromJson
      ? ` FILTER (WHERE ${typedColumns.map((column) => needsServerTextSql(column, textTypes)).join(' OR ')}`
        + ` OR (NOT ${ISO_DATE_STYLE_SQL} AND (${typedColumns.map((column) => dateStyledSql(column)).join(' OR ')})))`
      : ` FILTER (WHERE ${typedColumns.map((column) => needsTextSql(column, textTypes, false)).join(' OR ')})`;
  const oids = [...textColumns, ...typedColumns].map((column, i) => `min(pg_typeof(${branchColumnSql(column)})::oid) AS t${i}`);

  return `json_agg(ARRAY[${texts.join(', ')}])${filter} AS x, ${oids.join(', ')}`;
}

/**
 * Collects heterogeneous queries and executes them in a SINGLE database round
 * trip as one UNION ALL statement of json envelopes:
 *
 *   SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (...) __batch_q
 *   UNION ALL
 *   SELECT 1, ... FROM (...) __batch_q
 *
 * Each branch is planned independently by PostgreSQL (Append node), so every
 * query keeps its own indexes. Results are demultiplexed by ordinal and pushed
 * through the SAME transform pipeline standalone execution uses.
 *
 * A batched value is the one the same query reads on its own THROUGH THIS CLIENT,
 * under its driver's configuration. A value JSON cannot carry as the driver
 * delivers it — an int8 / numeric, a date / time / timestamp / interval, bytea,
 * money, their arrays, a value of a user-defined type or of a type the client
 * parses with a parser of its own (`FutureBatchMeta.textColumns` /
 * `runtimeTypedColumns`) — reaches the client as its PostgreSQL TEXT (as the wire
 * protocol sends it), with its type once for the branch, and the client parses it
 * as its driver parses such a column (`DatabaseClient.parseTypedText`; a value of a
 * domain over a type JSON carries keeps its JSON value). The server sends that text
 * alongside the row — except for a type whose JSON form gives the text back
 * (JSON_TEXT_TYPE_OIDS: a date / time / timetz / timestamp / timestamptz / interval,
 * money, bytea, point, circle — a date / timestamp / timestamptz only under
 * `DateStyle` ISO): the client rebuilds that text from the row (textOfJsonForm):
 *
 *   SELECT 2 AS __batch_ix, json_build_object('t', to_json(ARRAY[(SELECT … typbasetype … = __batch_s.t0)]::bigint[]),
 *                                             'r', __batch_s.r, 'x', __batch_s.x) AS __batch_items
 *   FROM (SELECT coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS r,
 *                json_agg(ARRAY[CASE WHEN <its type needs it> THEN concat(…) END]) FILTER (WHERE …) AS x,
 *                min(pg_typeof(…)::oid) AS t0
 *         FROM (SELECT * FROM (...) __batch_q0 OFFSET 0) __batch_q) __batch_s
 *
 * The rows are `row_to_json`, as in any other branch (a json value untouched, its
 * keys in their order); `x` is NULL when no value of the branch needs its text.
 * The `OFFSET 0` fence evaluates the branch's query once per row, as on its own:
 * without it PostgreSQL would inline the query and evaluate an expression — a
 * correlated subquery — at every reference the envelope makes to it (five for a
 * value that may need its text). Per branch that costs a header of about 50 bytes
 * plus about 10 per text-sent value, and one catalog lookup per text-sent value;
 * per row, a type test per runtime-typed value, and the texts that are needed (one
 * `lower()` over 50 000 rows: about a third longer than a branch without texts).
 * A branch with no value to send as text is the envelope above, byte for byte.
 *
 * Known limits of the JSON transport: a plain select's DECLARED date / timestamp /
 * timestamptz / bytea column is revived from its JSON form by the default drivers'
 * rules, as a batch always did — whatever the client's own parsers (a custom
 * mapper gets the driver's TEXT form of a timestamp / date); a collection's list
 * travels as the JSON the query builds for it.
 *
 * A batch is one-shot: register queries, execute once, read results.
 *
 * @example
 * const batch = new QueryBatch();
 * const ordersKey = batch.addList(db.orders.where(o => eq(o.userId, id)).select(o => ({ id: o.id })), 'orders');
 * const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, id)).select(u => u), 'user');
 * const cntKey = batch.addCount(db.tickets.where(t => eq(t.eventId, ev)), 'tickets');
 * await batch.executeBatch();
 * const orders = batch.getList(ordersKey);   // typed
 * const user = batch.getItem(userKey);       // typed | null
 * const tickets = batch.getCount(cntKey);    // number
 */
export class QueryBatch {
  private readonly entries: BatchEntry[] = [];
  private results: Map<string, { kind: BatchKind; value: any }> | null = null;
  private prepare?: boolean;

  /**
   * Run the batch's single statement as a NAMED prepared statement (`true`) or as an
   * unnamed one (`false`), whatever the context's `preparedStatements` option says.
   *
   * A batch statement is one text per SET of registered queries, so a batch whose
   * branches all bind array parameters (`= ANY($n::type[])`) tends to be re-planned on
   * every call by PostgreSQL anyway (the generic plan cannot see the array sizes);
   * naming it then only keeps an unused generic plan and the rewritten query tree
   * in every pooled connection. Opting such a batch out costs one describe round
   * trip and no planning, because the planning was already happening.
   */
  withPreparedStatements(prepare: boolean): this {
    this.prepare = prepare;

    return this;
  }

  /**
   * Register a query whose full result list is wanted.
   * Returns a typed key for getList().
   */
  addList<T>(query: BatchListSource<T>, id: string): BatchListKey<T> {
    this.register(id, 'list', query.future());

    return { id, kind: 'list' };
  }

  /**
   * Register a query whose first row (or null) is wanted. LIMIT 1 is applied.
   * Returns a typed key for getItem().
   */
  addFirstOrDefault<T>(query: BatchItemSource<T>, id: string): BatchItemKey<T> {
    this.register(id, 'first', query.futureFirstOrDefault());

    return { id, kind: 'first' };
  }

  /**
   * Register a COUNT query. Returns a typed key for getCount().
   */
  addCount(query: BatchCountSource, id: string): BatchCountKey {
    this.register(id, 'count', query.futureCount());

    return { id, kind: 'count' };
  }

  /**
   * Execute every registered query in one round trip and store the results.
   */
  async executeBatch(): Promise<void> {
    if (this.results) {
      throw new Error('QueryBatch has already been executed — create a new batch for further queries');
    }

    if (this.entries.length === 0) {
      throw new Error('QueryBatch is empty — register queries before executing');
    }

    const first = this.entries[0].future;
    const client = first._client;
    const executor = first._executor;

    for (const entry of this.entries) {
      if (entry.future._client !== client || entry.future._executor !== executor) {
        throw new Error(
          `QueryBatch: query "${entry.id}" uses a different database client or transaction than the rest of the batch — all queries must share one connection context`
        );
      }
    }

    const branches: string[] = [];
    const params: any[] = [];
    // The branches that send texts alongside their rows: their items arrive as { t: type OIDs, r: rows, x: texts }
    const typedBranches = new Set<number>();
    // The types a value is handed to the client as its text for: those JSON cannot carry as the drivers
    // deliver them, and those this client parses with a parser of its own. The server sends the texts of
    // those whose JSON form does not give their text back (see JSON_TEXT_TYPE_OIDS) — of every one of them
    // when the client parses json itself: the envelope IS json, so its parser runs on the rows and may hand
    // back a date's ISO JSON form already made into something else (a reviver's Date); no text is rebuilt
    // from such rows
    const textTypeOids = new Set([...TEXT_TRANSPORT_TYPE_OIDS, ...client.customParsedTypeOids()]);
    const rebuildsFromJson = !textTypeOids.has(JSON_TYPE_OID);
    const textTypes = `'{${[...textTypeOids].filter((oid) => !rebuildsFromJson || !JSON_TEXT_TYPE_OIDS.has(oid)).join(',')}}'::oid[]`;

    this.entries.forEach((entry, ix) => {
      const offset = params.length;
      const branchSql = offset === 0 ? entry.future._sql : renumberPlaceholders(entry.future._sql, offset);
      const meta = entry.future._batchMeta;
      const textColumns = meta?.textColumns ?? [];
      const typedColumns = meta?.runtimeTypedColumns ?? [];

      if (textColumns.length === 0 && typedColumns.length === 0) {
        // Nothing to send as text: the envelope as it always was, byte for byte
        branches.push(`SELECT ${ix} AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${branchSql}\n) __batch_q`);
      } else {
        // The rows themselves, the texts of the values that need one with their types — see the class doc.
        // The OFFSET 0 fence evaluates the query once per row. A branch whose one column PostgreSQL names
        // itself gets the name its metadata addresses it by
        const alias = meta?.columnAlias === undefined ? '' : `("${meta.columnAlias.replace(/"/g, '""')}")`;
        typedBranches.add(ix);
        branches.push(
          `SELECT ${ix} AS __batch_ix, json_build_object('t', ${typeOidsSql(textColumns.length + typedColumns.length, textTypes)}, 'r', __batch_s.r, 'x', __batch_s.x) AS __batch_items `
          + `FROM (SELECT coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS r, ${textsAndTypesSql(textColumns, typedColumns, textTypes, rebuildsFromJson)} `
          + `FROM (SELECT * FROM (\n${branchSql}\n) __batch_q0${alias} OFFSET 0) __batch_q) __batch_s`
        );
      }
      params.push(...entry.future._params);
    });

    const sql = branches.join('\nUNION ALL\n');
    const execution = this.prepare === undefined ? undefined : { prepare: this.prepare };
    const result = executor ? await executor.query(sql, params, execution) : await client.query(sql, params, execution);

    const itemsByIx = new Map<number, any[]>();
    const typesByIx = new Map<number, BatchTypeOids>();
    const textsByIx = new Map<number, Array<Array<string | null>>>();

    for (const row of result.rows) {
      const raw = row.__batch_items;
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const ix = Number(row.__batch_ix);

      if (typedBranches.has(ix)) {
        itemsByIx.set(ix, Array.isArray(payload?.r) ? payload.r : []);
        typesByIx.set(ix, Array.isArray(payload?.t) ? payload.t : []);

        if (Array.isArray(payload?.x)) {
          textsByIx.set(ix, payload.x);
        }
      } else {
        itemsByIx.set(ix, Array.isArray(payload) ? payload : []);
      }
    }

    const results = new Map<string, { kind: BatchKind; value: any }>();

    this.entries.forEach((entry, ix) => {
      const meta: FutureBatchMeta | undefined = entry.future._batchMeta;
      let rows = itemsByIx.get(ix) ?? [];

      if (meta) {
        // The texts sent alongside the rows, parsed as this client's driver parses their types — for the
        // statement the branch runs standalone, which binds parameters when the branch has any
        rows = applyBatchOverrides(rows, textsByIx.get(ix), meta, typesByIx.get(ix), client, textTypeOids, { parameterized: entry.future._params.length > 0 }, rebuildsFromJson);
      }

      if (meta?.reviveJsonRow) {
        rows = rows.map(meta.reviveJsonRow);
      }

      if (entry.kind === 'count') {
        results.set(entry.id, { kind: entry.kind, value: (entry.future as FutureCountQuery)._transform(rows) });
      } else {
        const transformed = (entry.future as FutureQuery<any> | FutureSingleQuery<any>)._transform(rows);
        const value = entry.kind === 'first' ? (transformed.length > 0 ? transformed[0] : null) : transformed;
        results.set(entry.id, { kind: entry.kind, value });
      }
    });

    this.results = results;
  }

  getList<T>(key: BatchListKey<T>): T[];
  getList<T = any>(id: string): T[];
  getList(keyOrId: BatchListKey<any> | string): any[] {
    return this.lookup(keyOrId, 'list');
  }

  getItem<T>(key: BatchItemKey<T>): T | null;
  getItem<T = any>(id: string): T | null;
  getItem(keyOrId: BatchItemKey<any> | string): any {
    return this.lookup(keyOrId, 'first');
  }

  getCount(keyOrId: BatchCountKey | string): number {
    return this.lookup(keyOrId, 'count');
  }

  private register(id: string, kind: BatchKind, future: BatchEntry['future']): void {
    if (this.results) {
      throw new Error('QueryBatch has already been executed — create a new batch for further queries');
    }

    if (this.entries.some((entry) => entry.id === id)) {
      throw new Error(`QueryBatch: identifier "${id}" is already registered`);
    }

    this.entries.push({ id, kind, future });
  }

  private lookup(keyOrId: { id: string } | string, expected: BatchKind): any {
    if (!this.results) {
      throw new Error('QueryBatch results are not available — call executeBatch() first');
    }

    const id = typeof keyOrId === 'string' ? keyOrId : keyOrId.id;
    const entry = this.results.get(id);

    if (!entry) {
      throw new Error(`QueryBatch: unknown identifier "${id}"`);
    }

    if (entry.kind !== expected) {
      throw new Error(`QueryBatch: "${id}" was registered as ${entry.kind}, not ${expected}`);
    }

    return entry.value;
  }
}
