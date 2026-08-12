import type { DatabaseClient, QueryResult } from '../database/database-client.interface';
import type { QueryExecutor } from '../entity/db-context';

/**
 * Metadata attached by the query builder so QueryBatch can safely embed the
 * query as a json_agg branch of a single UNION ALL statement.
 * @internal
 */
export interface FutureBatchMeta {
  /** Selection produces nested-path rows (nested object selections) — not batchable. */
  hasNestedPaths: boolean;
  /**
   * Restores driver-equivalent values on a row delivered via JSON
   * (timestamps/dates/decimals lose their driver parsing through json_agg).
   * Undefined when no selected column needs revival.
   */
  reviveJsonRow?: (row: any) => any;
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
