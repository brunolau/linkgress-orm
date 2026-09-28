import type { DatabaseClient, QueryResult, TypedTextRead } from '../database/database-client.interface';
import { isTextParsedType } from '../database/typed-text';
import type { QueryExecutor } from '../entity/db-context';
import { DRIVER_VALUE_MAPPER } from './conditions';

/**
 * Metadata attached by the query builder so QueryBatch can safely embed the
 * query as a json_agg branch of a single UNION ALL statement.
 *
 * A batch delivers every value as the client delivers it for the same query on its own. A value JSON
 * carries as the drivers deliver it (an integer, a text, a boolean, a json document) rides in the row
 * itself (`row_to_json`); a value it cannot — an int8, a numeric, a date / timestamp, bytea, their arrays,
 * a value of a user-defined type or of a type the client parses with a parser of its own — also travels
 * as its PostgreSQL TEXT, with its type once per branch, and the client parses that text as its driver
 * parses such a column (`DatabaseClient.parseTypedText`, see {@link applyBatchOverrides}).
 * @internal
 */
export interface FutureBatchMeta {
  /** Selection produces nested-path rows (nested object selections) — reconstructed by the shared transform. */
  hasNestedPaths: boolean;
  /**
   * Restores the values a batch has always restored from their JSON form, as it always did: a plain
   * select's declared date / timestamp / timestamptz / bytea column (for a custom mapper, in its text
   * form — see {@link jsonColumnDelivery}). Undefined when there is none.
   */
  reviveJsonRow?: (row: any) => any;
  /**
   * Flat aliases whose values the batch always sends as their TEXT — a declared int8 / numeric column,
   * whose value a JSON number would lose (JSON.parse collapses it to a float) — parsed back by the client
   * by their type (see {@link applyBatchOverrides}).
   */
  textColumns?: string[];
  /**
   * Flat aliases of values the batch sends as their TEXT when their type needs it — an expression (a raw
   * `sql` template, `dateTrunc()` / `castAsDate()`, an `agg.min` / `agg.max`, a mapped expression), a
   * scalar subquery of one, a collection's MIN / MAX, a column of a CTE, a table subquery, a set or a
   * manually joined table, a read-typed expression, a UNION column whose legs declare different types. The
   * batch tests each one's runtime type row by row (the test is constant for a column): a type of
   * TEXT_TRANSPORT_TYPE_OIDS, a user-defined type or a type the client parses with a parser of its own
   * sends the text, parsed back by the client by the type (its base type for a domain) the branch sends
   * once; any other value rides in the row as it is.
   */
  runtimeTypedColumns?: string[];
  /**
   * The name the batch gives the ONE column of a branch whose statement leaves it unnamed (a
   * selector returning one expression: PostgreSQL names that column itself), so the branch can
   * address it (`__batch_q0("<alias>")`). Set only for such a column the batch sends as its text.
   */
  columnAlias?: string;
}

/**
 * The (base) type OID of each of a QueryBatch branch's text-sent values, in the order the branch sends
 * their texts (its text columns, then its runtime-typed ones) — `null` for a branch of no rows.
 * @internal
 */
export type BatchTypeOids = ReadonlyArray<number | null>;

/** What a batch parses the texts it sends with: the client the batch runs on. */
type TypedTextParser = Pick<DatabaseClient, 'parseTypedText'>;

/**
 * The rows of a QueryBatch branch with the TEXTS the branch sent alongside them parsed in — `texts`: one
 * array per row, in row order, of one text (or NULL) per text-sent value (the branch's text columns, then
 * its runtime-typed ones), or `undefined` when none of the branch's values needed one; `typeOids`: the
 * (base) type of each. A value with a text whose (base) type the client parses from its text (see
 * isTextParsedType — `textTypeOids`) becomes what `client` delivers for that type standalone
 * (DatabaseClient.parseTypedText), read as the branch's own statement reads it (`read`: whether it binds
 * parameters). Any other value stays as the JSON row carries it: NULL (the text of NULL is empty), and a
 * value of a domain over a type JSON carries as the drivers deliver it. Each row keeps its key order.
 * @internal
 */
export function applyBatchOverrides(
  rows: Array<Record<string, any>>,
  texts: ReadonlyArray<ReadonlyArray<string | null> | null> | undefined,
  meta: Pick<FutureBatchMeta, 'textColumns' | 'runtimeTypedColumns'>,
  typeOids: BatchTypeOids | undefined,
  client: TypedTextParser,
  textTypeOids: ReadonlySet<number>,
  read?: TypedTextRead
): Array<Record<string, any>> {
  if (!texts) {
    return rows;
  }

  const keys = [...(meta.textColumns ?? []), ...(meta.runtimeTypedColumns ?? [])];
  const parsed = keys.map((_, i) => {
    const oid = typeOids?.[i];

    return typeof oid === 'number' && isTextParsedType(oid, textTypeOids) ? oid : undefined;
  });

  for (let rowIx = 0; rowIx < rows.length; rowIx++) {
    const rowTexts = texts[rowIx];

    if (!rowTexts) {
      continue;
    }

    const row = rows[rowIx];

    for (let i = 0; i < keys.length; i++) {
      const text = rowTexts[i];
      const oid = parsed[i];

      if (oid !== undefined && text !== null && text !== undefined && row[keys[i]] !== null && row[keys[i]] !== undefined) {
        row[keys[i]] = client.parseTypedText(oid, text, read);
      }
    }
  }

  return rows;
}

/**
 * How a plain select's DECLARED column of one SQL type is restored from its QueryBatch JSON form, as a
 * batch always restored it: JSON serialization bypasses the driver's type parsers, so a timestamp or a
 * date arrives as its ISO text and bytea as `\x…` hex text.
 * @internal
 */
export interface JsonColumnDelivery {
  /** Restores the value from its JSON form (never called for NULL). */
  readonly revive: (value: any) => any;
}

/**
 * The JSON revival of a plain select's declared `timestamp` / `timestamptz` / `date` / `bytea` column, as
 * a batch always did it — `undefined` for any other type (a declared int8 / numeric travels as its text,
 * see FutureBatchMeta.textColumns): a date / timestamp / timestamptz by the DEFAULT drivers' rules (a
 * Date; a date at local midnight), a bytea into a Buffer. This path keeps 1.0.10's values whatever the
 * client's own parsers — the documented limit: a client that parses these types otherwise reads such a
 * column otherwise standalone.
 *
 * A custom fromDriver mapper (`hasMapper`) is the value's type authority: it was written against the
 * driver's RAW output (apps that configure timestamp parser passthrough, so their mappers expect the
 * text-protocol string). For mapper values the revival reconstructs that text form — json's ISO 'T'
 * separator back to the driver's space, a timestamptz's ':00' offset minutes collapsed to the driver's
 * short form — and never hands the mapper a Date it does not expect.
 * @internal
 */
export function jsonColumnDelivery(type: string | undefined, hasMapper: boolean): JsonColumnDelivery | undefined {
  switch (type) {
    case 'timestamp':
      return {
        revive: hasMapper
          ? (v) => (typeof v === 'string' ? v.replace('T', ' ') : v)
          : (v) => (typeof v === 'string' ? new Date(v) : v),
      };
    case 'timestamptz':
      return {
        revive: hasMapper
          ? (v) => (typeof v === 'string' ? v.replace('T', ' ').replace(/([+-]\d{2}):00$/, '$1') : v)
          : (v) => (typeof v === 'string' ? new Date(v) : v),
      };
    case 'date':
      if (hasMapper) {
        // json 'YYYY-MM-DD' IS the driver text form — the mapper gets it as-is.
        return undefined;
      }

      return {
        revive: (v) => {
          if (typeof v !== 'string') {
            return v;
          }

          // Mirror the drivers' date parsing: local midnight, not UTC
          const [year, month, day] = v.split('-').map(Number);

          return new Date(year, month - 1, day);
        },
      };
    case 'bytea':
      // Driver delivery is a byte buffer; row_to_json emits the '\x…' hex text.
      return {
        revive: (v) => {
          if (typeof v !== 'string' || !v.startsWith('\\x')) {
            return v;
          }

          const hex = v.slice(2);
          const bufferCtor = (globalThis as any).Buffer;

          return bufferCtor
            ? bufferCtor.from(hex, 'hex')
            : Uint8Array.from(hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
        },
      };
    default:
      return undefined;
  }
}

/**
 * The canonical name of a SQL type among those a batch treats specially: a declared column type, a
 * PostgreSQL type name, or an alias of one — without modifiers (`timestamp(3) with time zone` →
 * `timestamptz`, `int8` / `bigserial` → `bigint`, `numeric(10,2)` → `numeric`). `undefined` for any other
 * type (arrays included).
 * @internal
 */
export function canonicalJsonColumnType(sqlType: unknown): string | undefined {
  if (typeof sqlType !== 'string') {
    return undefined;
  }

  const type = sqlType.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

  switch (type) {
    case 'timestamp':
    case 'timestamp without time zone':
      return 'timestamp';
    case 'timestamptz':
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'date':
      return 'date';
    case 'bigint':
    case 'int8':
    case 'bigserial':
    case 'serial8':
      return 'bigint';
    case 'numeric':
    case 'decimal':
      return 'numeric';
    case 'bytea':
      return 'bytea';
    default:
      return undefined;
  }
}

/**
 * Whether a value reads through a CUSTOM mapper — a column type's, a `mapWith()`, a numeric result
 * mapper — rather than none or the driver-value pass-through (`DRIVER_VALUE_MAPPER`, which helpers
 * such as `dateTrunc()` and set columns carry).
 * @internal
 */
export function isCustomReadMapper(mapper: unknown): boolean {
  const type = mapper && typeof (mapper as { getType?: unknown }).getType === 'function'
    ? (mapper as { getType(): unknown }).getType()
    : mapper;

  return type !== undefined && type !== null && typeof (type as { fromDriver?: unknown }).fromDriver === 'function' && type !== DRIVER_VALUE_MAPPER;
}

/**
 * How one field of a FLAT projection (a grouped select's, a grouped join's) travels through a
 * QueryBatch: `runtime` — as its text when its runtime type needs it (see
 * FutureBatchMeta.runtimeTypedColumns), which the client then parses as it parses such a column.
 * @internal
 */
export type BatchFieldDelivery = { readonly kind: 'runtime' };

/**
 * The QueryBatch metadata of a flat projection, from each field's delivery (`undefined`: the field
 * travels as it is — a count, an integer, text, a constant the reader restores itself), in projection
 * order.
 * @internal
 */
export function flatRowBatchMeta(fields: ReadonlyArray<readonly [key: string, delivery: BatchFieldDelivery | undefined]>): FutureBatchMeta {
  const runtimeTypedColumns = fields.filter(([, delivery]) => delivery !== undefined).map(([key]) => key);

  return {
    hasNestedPaths: false,
    runtimeTypedColumns: runtimeTypedColumns.length > 0 ? runtimeTypedColumns : undefined,
  };
}

/**
 * Represents a deferred query that will be executed later.
 * Captures the SQL, parameters, and transformation logic at creation time.
 *
 * @typeParam TResult - The type of results this query will return
 */
export class FutureQuery<TResult> {
  /** @internal */
  readonly _sql: string;
  /** @internal */
  readonly _params: any[];
  /** @internal */
  readonly _transformFn: (rows: any[]) => TResult[];
  /** @internal */
  readonly _client: DatabaseClient;
  /** @internal */
  readonly _executor?: QueryExecutor;
  /** @internal */
  readonly _mode: 'list' | 'single' | 'count';
  /** @internal Populated by the query builder for QueryBatch support */
  _batchMeta?: FutureBatchMeta;

  constructor(
    sql: string,
    params: any[],
    transformFn: (rows: any[]) => TResult[],
    client: DatabaseClient,
    executor?: QueryExecutor,
    mode: 'list' | 'single' | 'count' = 'list'
  ) {
    this._sql = sql;
    this._params = params;
    this._transformFn = transformFn;
    this._client = client;
    this._executor = executor;
    this._mode = mode;
  }

  /**
   * Get the SQL that will be executed
   */
  getSql(): string {
    return this._sql;
  }

  /**
   * Get the parameters for this query
   */
  getParams(): any[] {
    return this._params;
  }

  /**
   * Execute this future query individually.
   * For batch execution, use FutureQueryRunner.runAsync() instead.
   */
  async execute(): Promise<TResult[]> {
    const result = this._executor
      ? await this._executor.query(this._sql, this._params)
      : await this._client.query(this._sql, this._params);

    return this._transformFn(result.rows);
  }

  /**
   * Transform raw database rows using this query's transformation function
   * @internal Used by FutureQueryRunner
   */
  _transform(rows: any[]): TResult[] {
    return this._transformFn(rows);
  }
}

/**
 * A future query that returns a single result or null.
 * Not a subclass of FutureQuery to avoid type conflicts with execute() return type.
 */
export class FutureSingleQuery<TResult> {
  /** @internal */
  readonly _sql: string;
  /** @internal */
  readonly _params: any[];
  /** @internal */
  readonly _transformFn: (rows: any[]) => TResult[];
  /** @internal */
  readonly _client: DatabaseClient;
  /** @internal */
  readonly _executor?: QueryExecutor;
  /** @internal */
  readonly _mode: 'single' = 'single';
  /** @internal Populated by the query builder for QueryBatch support */
  _batchMeta?: FutureBatchMeta;

  constructor(
    sql: string,
    params: any[],
    transformFn: (rows: any[]) => TResult[],
    client: DatabaseClient,
    executor?: QueryExecutor
  ) {
    this._sql = sql;
    this._params = params;
    this._transformFn = transformFn;
    this._client = client;
    this._executor = executor;
  }

  /**
   * Get the SQL that will be executed
   */
  getSql(): string {
    return this._sql;
  }

  /**
   * Get the parameters for this query
   */
  getParams(): any[] {
    return this._params;
  }

  /**
   * Execute this future query and return single result or null
   */
  async execute(): Promise<TResult | null> {
    const result = this._executor
      ? await this._executor.query(this._sql, this._params)
      : await this._client.query(this._sql, this._params);

    const transformed = this._transformFn(result.rows);
    return transformed.length > 0 ? transformed[0] : null;
  }

  /**
   * Transform raw database rows using this query's transformation function
   * @internal Used by FutureQueryRunner
   */
  _transform(rows: any[]): TResult[] {
    return this._transformFn(rows);
  }
}

/**
 * A future query that returns a count.
 * Not a subclass of FutureQuery to avoid type conflicts with execute() return type.
 */
export class FutureCountQuery {
  /** @internal */
  readonly _sql: string;
  /** @internal */
  readonly _params: any[];
  /** @internal */
  readonly _client: DatabaseClient;
  /** @internal */
  readonly _executor?: QueryExecutor;
  /** @internal */
  readonly _mode: 'count' = 'count';
  /** @internal Populated by the query builder for QueryBatch support */
  _batchMeta?: FutureBatchMeta;

  constructor(
    sql: string,
    params: any[],
    client: DatabaseClient,
    executor?: QueryExecutor
  ) {
    this._sql = sql;
    this._params = params;
    this._client = client;
    this._executor = executor;
  }

  /**
   * Get the SQL that will be executed
   */
  getSql(): string {
    return this._sql;
  }

  /**
   * Get the parameters for this query
   */
  getParams(): any[] {
    return this._params;
  }

  /**
   * Execute this future query and return the count
   */
  async execute(): Promise<number> {
    const result = this._executor
      ? await this._executor.query(this._sql, this._params)
      : await this._client.query(this._sql, this._params);

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Transform raw database rows to count
   * @internal Used by FutureQueryRunner
   */
  _transform(rows: any[]): number {
    return parseInt(rows[0]?.count ?? '0', 10);
  }
}

/**
 * Union type for all future query types
 */
export type AnyFutureQuery = FutureQuery<any> | FutureSingleQuery<any> | FutureCountQuery;

/**
 * Type helper: Extract the result type from a FutureQuery
 */
export type FutureQueryResult<T> =
  T extends FutureSingleQuery<infer R> ? R | null :
  T extends FutureCountQuery ? number :
  T extends FutureQuery<infer R> ? R[] :
  never;

/**
 * Type helper for tuple of future queries results
 */
export type FutureQueryResults<T extends readonly AnyFutureQuery[]> = {
  [K in keyof T]: FutureQueryResult<T[K]>;
};

/**
 * Runner for executing multiple future queries in a single database roundtrip.
 *
 * @example
 * ```typescript
 * const q1 = db.users.select(u => ({ id: u.id, name: u.username })).future();
 * const q2 = db.posts.select(p => ({ title: p.title })).futureFirstOrDefault();
 * const q3 = db.comments.futureCount();
 *
 * const [users, firstPost, commentCount] = await FutureQueryRunner.runAsync([q1, q2, q3]);
 * // users: { id: number, name: string }[]
 * // firstPost: { title: string } | null
 * // commentCount: number
 * ```
 */
export class FutureQueryRunner {
  /**
   * Execute multiple future queries in a single database roundtrip when possible.
   *
   * If the database client supports multi-statement queries (PostgresClient),
   * all queries are combined and executed together. Otherwise, queries are
   * executed sequentially.
   *
   * @param futures - Array of future queries to execute
   * @returns Promise resolving to a tuple of results matching the input queries
   *
   * @example
   * ```typescript
   * const [users, posts, count] = await FutureQueryRunner.runAsync([
   *   db.users.select(u => ({ name: u.username })).future(),
   *   db.posts.select(p => ({ title: p.title })).future(),
   *   db.comments.futureCount()
   * ]);
   * ```
   */
  static async runAsync<T extends readonly AnyFutureQuery[]>(
    futures: T
  ): Promise<FutureQueryResults<T>> {
    if (futures.length === 0) {
      return [] as unknown as FutureQueryResults<T>;
    }

    // Get the client from the first query
    const client = futures[0]._client;
    const executor = futures[0]._executor;

    // One connection context for the whole batch, as QueryBatch requires: the multi-statement path runs every
    // future on the FIRST future's client — a transaction's future next to a root one ran outside its transaction,
    // and an ended transaction's future ran on the root instead of being refused
    futures.forEach((future, index) => {
      if (future._client !== client || future._executor !== executor) {
        throw new Error(
          `FutureQueryRunner: future #${index} uses a different database client or transaction than the rest of the batch — all futures must share one connection context`
        );
      }
    });

    // Check if we can use multi-statement optimization
    // Requirements: client supports it AND no queries have parameters
    const canUseMultiStatement = client.supportsMultiStatementQueries() &&
      futures.every(f => f._params.length === 0);

    if (canUseMultiStatement) {
      return FutureQueryRunner.executeMultiStatement(futures, client);
    } else {
      return FutureQueryRunner.executeSequential(futures);
    }
  }

  /**
   * Execute queries using multi-statement optimization (single roundtrip)
   */
  private static async executeMultiStatement<T extends readonly AnyFutureQuery[]>(
    futures: T,
    client: DatabaseClient
  ): Promise<FutureQueryResults<T>> {
    // Combine all SQL statements
    const combinedSql = futures.map(f => f._sql).join(';\n');

    // Execute all at once using querySimpleMulti (check dynamically since it's not on base interface)
    if (!('querySimpleMulti' in client) || typeof (client as any).querySimpleMulti !== 'function') {
      // Fallback to sequential if method not available
      return FutureQueryRunner.executeSequential(futures);
    }

    const results: QueryResult[] = await (client as any).querySimpleMulti(combinedSql);

    // Transform each result set with its corresponding transformer
    const transformed = futures.map((future, index) => {
      const resultSet = results[index];
      const rows = resultSet?.rows ?? [];

      if (future._mode === 'single') {
        const items = (future as FutureSingleQuery<any>)._transform(rows);
        return items.length > 0 ? items[0] : null;
      } else if (future._mode === 'count') {
        return (future as FutureCountQuery)._transform(rows);
      } else {
        return (future as FutureQuery<any>)._transform(rows);
      }
    });

    return transformed as FutureQueryResults<T>;
  }

  /**
   * Execute queries sequentially (fallback when multi-statement not available)
   */
  private static async executeSequential<T extends readonly AnyFutureQuery[]>(
    futures: T
  ): Promise<FutureQueryResults<T>> {
    const results = await Promise.all(
      futures.map(async (future) => {
        return await future.execute();
      })
    );

    return results as FutureQueryResults<T>;
  }
}

/**
 * Check if a value is a FutureQuery
 */
export function isFutureQuery(value: any): value is FutureQuery<any> {
  return value instanceof FutureQuery;
}

/**
 * Check if a value is a FutureSingleQuery
 */
export function isFutureSingleQuery(value: any): value is FutureSingleQuery<any> {
  return value instanceof FutureSingleQuery;
}

/**
 * Check if a value is a FutureCountQuery
 */
export function isFutureCountQuery(value: any): value is FutureCountQuery {
  return value instanceof FutureCountQuery;
}
