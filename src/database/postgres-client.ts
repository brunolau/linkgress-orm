import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions, QueryTimeoutError } from './database-client.interface';
import type { PostgresOptions } from './types';

// Use dynamic import to make postgres optional
type Sql = any;

/** PostgreSQL error code raised when a statement is cancelled due to a timeout. */
const STATEMENT_TIMEOUT_CODE = '57014';

/**
 * Check if a value is a postgres.Sql instance
 */
function isPostgresSqlInstance(value: any): boolean {
  return value && typeof value === 'function' && typeof value.unsafe === 'function' && typeof value.end === 'function';
}

/** Clamp a timeout to a safe non-negative integer for inlining into SET LOCAL. */
function normalizeTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
}

/**
 * Translate a statement-timeout cancellation (PostgreSQL `57014`) into a typed
 * {@link QueryTimeoutError}. Any other error is returned unchanged.
 */
function asTimeoutError(error: any, timeoutMs: number | undefined, sql: string): any {
  if (error && error.code === STATEMENT_TIMEOUT_CODE) {
    return new QueryTimeoutError(timeoutMs ?? 0, sql, error);
  }
  return error;
}

/**
 * Execute a single statement against a `postgres` (porsager) sql instance,
 * honoring an optional per-query timeout override.
 *
 * - No override (`timeoutMs === undefined`): run the query directly. Any
 *   connection-level `statement_timeout` default still applies (server-enforced,
 *   no wrapping).
 * - Override present: run the query inside a short transaction that issues
 *   `SET LOCAL statement_timeout` first. `SET LOCAL` is scoped to the
 *   transaction and auto-resets at COMMIT, so it never leaks to other queries on
 *   the pooled connection. `timeoutMs === 0` disables the timeout for this query.
 *
 * A statement-timeout cancellation is surfaced as a {@link QueryTimeoutError}.
 */
async function runStatement(
  sqlInstance: Sql,
  sql: string,
  params: any[] | undefined,
  timeoutMs: number | undefined,
  defaultTimeoutMs: number | undefined
): Promise<QueryResult> {
  if (timeoutMs === undefined) {
    try {
      const result = await sqlInstance.unsafe(sql, params || []);
      return { rows: result, rowCount: result.count ?? null };
    } catch (error) {
      throw asTimeoutError(error, defaultTimeoutMs, sql);
    }
  }

  // Per-query override: wrap only this query so SET LOCAL auto-resets at COMMIT.
  try {
    return await sqlInstance.begin(async (tx: Sql) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${normalizeTimeoutMs(timeoutMs)}`);
      const result = await tx.unsafe(sql, params || []);
      return { rows: result, rowCount: result.count ?? null };
    });
  } catch (error) {
    throw asTimeoutError(error, timeoutMs, sql);
  }
}

/**
 * Wrapper for the pooled connection from postgres library
 */
class PostgresPooledConnection implements PooledConnection {
  constructor(private sql: Sql, private defaultStatementTimeout?: number) {}

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // postgres library doesn't have explicit binary protocol toggle
    // It automatically uses the most efficient protocol based on data types.
    return await runStatement(this.sql, sql, params, options?.timeoutMs, this.defaultStatementTimeout) as QueryResult<T>;
  }

  release(): void {
    // postgres library handles connection pooling automatically
    // No explicit release needed
  }
}

/**
 * DatabaseClient implementation for the 'postgres' library
 * @see https://github.com/porsager/postgres
 *
 * NOTE: This requires the 'postgres' package to be installed:
 * npm install postgres
 */
export class PostgresClient extends DatabaseClient {
  private sql: Sql;
  private ownsConnection: boolean;
  /** Default statement_timeout (ms) configured at construction, if any. */
  private defaultStatementTimeout?: number;

  /**
   * Create a PostgresClient
   * @param config - Either a connection string, PostgresOptions config object, or an existing postgres.Sql instance
   */
  constructor(config: string | PostgresOptions | Sql) {
    super();

    // Check if config is an existing postgres.Sql instance
    if (isPostgresSqlInstance(config)) {
      this.sql = config;
      this.ownsConnection = false;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const postgres = require('postgres');
        this.sql = postgres(this.normalizeConfig(config));
        this.ownsConnection = true;
      } catch (error) {
        throw new Error(
          'PostgresClient requires the "postgres" package to be installed. ' +
          'Install it with: npm install postgres'
        );
      }
    }
  }

  /**
   * Move a top-level `statement_timeout` (ms) option onto the porsager
   * `connection` parameters so PostgreSQL applies it as a native, connection-level
   * default (server-enforced, no per-query wrapping). Other config is untouched.
   *
   * String/URL configs are passed through unchanged — for those, set the default
   * via the connection string or use a config object.
   */
  private normalizeConfig(config: string | PostgresOptions | Sql): any {
    if (typeof config !== 'object' || config === null) {
      return config;
    }

    const options = config as PostgresOptions;
    const statementTimeout = options.statement_timeout;
    if (statementTimeout === undefined) {
      return config;
    }

    this.defaultStatementTimeout = statementTimeout;

    // Clone, drop the top-level alias, and push it into the connection params
    // (porsager sends `connection.*` as PostgreSQL connection parameters).
    const { statement_timeout: _omit, connection, ...rest } = options as any;
    return {
      ...rest,
      connection: {
        ...(connection || {}),
        statement_timeout: normalizeTimeoutMs(statementTimeout),
      },
    };
  }

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // postgres library doesn't have explicit binary protocol toggle
    // It automatically uses the most efficient protocol based on data types.
    return await runStatement(this.sql, sql, params, options?.timeoutMs, this.defaultStatementTimeout) as QueryResult<T>;
  }

  async connect(): Promise<PooledConnection> {
    // postgres library doesn't expose individual connections in the same way
    // We'll return a wrapper that uses the same sql instance
    // For transactions, the library handles it through sql.begin()
    return new PostgresPooledConnection(this.sql, this.defaultStatementTimeout);
  }

  async end(): Promise<void> {
    // Only close the connection if we created it
    if (this.ownsConnection) {
      await this.sql.end();
    }
  }

  getDriverName(): string {
    return 'postgres';
  }

  /**
   * postgres library supports multiple SQL statements using .simple() mode
   * This allows true single round-trip optimization
   */
  supportsMultiStatementQueries(): boolean {
    return true;
  }

  /**
   * Execute a multi-statement query using the simple protocol
   * This bypasses prepared statements and allows multiple statements
   * WARNING: Only use with safe, validated inputs!
   */
  async querySimple<T = any>(sql: string): Promise<QueryResult<T>> {
    const results = await this.sql.unsafe(sql).simple();

    // .simple() returns an array of results for each statement
    // Return the last non-empty result (usually the SELECT)
    const lastResult = results[results.length - 1] || [];

    return {
      rows: lastResult as T[],
      rowCount: lastResult.count ?? lastResult.length ?? null,
    };
  }

  /**
   * Execute a multi-statement query and return ALL result sets
   * Used for fully optimized single-query execution
   */
  async querySimpleMulti(sql: string): Promise<QueryResult[]> {
    const results = await this.sql.unsafe(sql).simple();

    // Convert each result set to QueryResult format
    return results.map((result: any) => ({
      rows: result as any[],
      rowCount: result.count ?? result.length ?? null,
    }));
  }

  /**
   * Begin a transaction using postgres library's built-in transaction support
   * @deprecated Use transaction() method instead for cross-driver compatibility
   */
  async begin<T>(callback: (sql: Sql) => Promise<T>): Promise<T> {
    return await this.sql.begin(callback);
  }

  /**
   * Execute a callback within a transaction.
   * Uses postgres library's built-in sql.begin() for proper transaction handling.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (sql: Sql) => {
      const queryFn = async (sqlStr: string, params?: any[]): Promise<QueryResult> => {
        const result = await sql.unsafe(sqlStr, params || []);
        return {
          rows: result as any[],
          rowCount: result.count ?? null,
        };
      };

      return await callback(queryFn);
    });
  }

  /**
   * postgres library automatically uses binary protocol where appropriate
   * No explicit toggle needed
   */
  supportsBinaryProtocol(): boolean {
    return false; // No explicit control, but uses binary internally
  }

  /**
   * Get access to the underlying sql instance for advanced use cases
   */
  getSql(): Sql {
    return this.sql;
  }
}
