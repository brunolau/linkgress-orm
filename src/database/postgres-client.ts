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
 * Read the connection-level `statement_timeout` back off an already-constructed porsager
 * instance (`sql.options.connection`, where porsager keeps the parameters it sends at
 * connect). Callers that build their own pool — typically to keep ownership of it for
 * failover recycling — never go through {@link PostgresClient.normalizeConfig}, so this is
 * the only way the client can learn which cap the server is enforcing. Without it every
 * cancellation by that cap is reported as the `timeoutMs ?? 0` sentinel and renders as
 * "Query exceeded its timeout of 0ms and was cancelled", naming no limit at all.
 *
 * Returns `undefined` when the instance sets no timeout, so the sentinel behaviour is
 * unchanged for pools that genuinely have no connection-level cap.
 */
function readConnectionStatementTimeout(sqlInstance: Sql): number | undefined {
  const configured = sqlInstance?.options?.connection?.statement_timeout;

  if (configured === undefined || configured === null) {
    return undefined;
  }

  // porsager passes connection parameters through as given — a number here, but a string
  // when it came from a connection-string parameter.
  const timeoutMs = typeof configured === 'number' ? configured : Number(configured);

  return Number.isFinite(timeoutMs) ? timeoutMs : undefined;
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
/**
 * Send one parameterised statement. postgres.js hard-codes `prepare: false` on `unsafe()`
 * (an UNNAMED statement: parsed, described in an extra round trip and planned on every
 * execution); `prepare === true` asks for a NAMED server-side prepared statement instead,
 * which the driver caches per connection after its first execution. Anything else keeps
 * the exact call shape linkgress has always used.
 */
function sendStatement(target: Sql, sql: string, params: any[] | undefined, prepare: boolean | undefined) {
  return prepare === true
    ? target.unsafe(sql, params || [], { prepare: true })
    : target.unsafe(sql, params || []);
}

async function runStatement(
  sqlInstance: Sql,
  sql: string,
  params: any[] | undefined,
  timeoutMs: number | undefined,
  defaultTimeoutMs: number | undefined,
  prepare?: boolean
): Promise<QueryResult> {
  if (timeoutMs === undefined) {
    try {
      const result = await sendStatement(sqlInstance, sql, params, prepare);
      return { rows: result, rowCount: result.count ?? null };
    } catch (error) {
      throw asTimeoutError(error, defaultTimeoutMs, sql);
    }
  }

  // Per-query override: wrap only this query so SET LOCAL auto-resets at COMMIT.
  try {
    return await sqlInstance.begin(async (tx: Sql) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${normalizeTimeoutMs(timeoutMs)}`);
      const result = await sendStatement(tx, sql, params, prepare);
      return { rows: result, rowCount: result.count ?? null };
    });
  } catch (error) {
    throw asTimeoutError(error, timeoutMs, sql);
  }
}

/**
 * Execute a single statement inside an EXISTING porsager transaction, honoring an
 * optional per-statement timeout override.
 *
 * Unlike {@link runStatement}, we are already inside a transaction, so we cannot
 * open another one to get the automatic `SET LOCAL` reset at COMMIT. Instead we
 * capture the current `statement_timeout`, `SET LOCAL` the override for this one
 * statement, then restore the captured value — keeping the override scoped to this
 * statement even when other statements follow in the same transaction. (`SET LOCAL`
 * also auto-resets at the outer COMMIT/ROLLBACK, so the restore only matters for
 * subsequent statements.)
 *
 * - `timeoutMs === undefined`: run directly; any transaction/connection-level
 *   `statement_timeout` still applies.
 * - `timeoutMs === 0`: disable the timeout for this statement.
 *
 * A statement-timeout cancellation (`57014`) is surfaced as a {@link QueryTimeoutError}.
 */
async function runTxStatement(
  txSql: Sql,
  sql: string,
  params: any[] | undefined,
  timeoutMs: number | undefined,
  defaultTimeoutMs: number | undefined,
  prepare?: boolean
): Promise<QueryResult> {
  if (timeoutMs === undefined) {
    try {
      const result = await sendStatement(txSql, sql, params, prepare);
      return { rows: result, rowCount: result.count ?? null };
    } catch (error) {
      throw asTimeoutError(error, defaultTimeoutMs, sql);
    }
  }

  // Capture the current value so we can restore it after this one statement.
  let previous: string | undefined;
  try {
    const shown = await txSql.unsafe(`SHOW statement_timeout`);
    previous = shown && shown[0] ? shown[0].statement_timeout : undefined;
  } catch {
    previous = undefined;
  }

  await txSql.unsafe(`SET LOCAL statement_timeout = ${normalizeTimeoutMs(timeoutMs)}`);
  try {
    const result = await sendStatement(txSql, sql, params, prepare);
    return { rows: result, rowCount: result.count ?? null };
  } catch (error) {
    throw asTimeoutError(error, timeoutMs, sql);
  } finally {
    // Best-effort restore. If the statement timed out, the transaction is now
    // aborted and this throws — the outer ROLLBACK resets everything, so ignore it.
    if (previous !== undefined) {
      try {
        await txSql.unsafe(`SET LOCAL statement_timeout = '${previous}'`);
      } catch {
        /* transaction aborted — nothing to restore */
      }
    }
  }
}

/**
 * Wrapper for the pooled connection from postgres library.
 *
 * Backed by `sql.reserve()` (postgres >= 3.4) when available, so the
 * connection is genuinely pinned to ONE session — session state (temp
 * tables, SET, advisory locks) is visible across queries on this wrapper.
 * Falls back to the shared pool on older versions, where no pinning
 * guarantee exists.
 */
class PostgresPooledConnection implements PooledConnection {
  constructor(private sql: Sql, private reserved: boolean, private defaultStatementTimeout?: number) {}

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // postgres library doesn't have explicit binary protocol toggle
    // It automatically uses the most efficient protocol based on data types.
    return await runStatement(this.sql, sql, params, options?.timeoutMs, this.defaultStatementTimeout, options?.prepare) as QueryResult<T>;
  }

  release(): void {
    if (this.reserved && typeof (this.sql as any).release === 'function') {
      (this.sql as any).release();
    }
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
      // The instance already carries its connection parameters — recover the default cap
      // from them so timeout errors can name it (see readConnectionStatementTimeout).
      this.defaultStatementTimeout = readConnectionStatementTimeout(config);
    } else {
      let postgres: any;

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const postgresModule = require('postgres');
        // Under Bun (and other ESM-interop loaders) require() can return a
        // module-namespace object ({ default: postgres }) instead of the
        // callable itself — unwrap it.
        postgres = typeof postgresModule === 'function' ? postgresModule : postgresModule?.default;
      } catch (error) {
        throw new Error(
          'PostgresClient requires the "postgres" package to be installed. ' +
          'Install it with: npm install postgres'
        );
      }

      if (typeof postgres !== 'function') {
        throw new Error('The "postgres" package did not resolve to a callable factory (unexpected module shape).');
      }

      // Outside the try/catch: a pool-construction error (e.g. invalid options)
      // must propagate as-is, not masquerade as a missing package.
      this.sql = postgres(this.normalizeConfig(config));
      this.ownsConnection = true;
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
    return await runStatement(this.sql, sql, params, options?.timeoutMs, this.defaultStatementTimeout, options?.prepare) as QueryResult<T>;
  }

  async connect(): Promise<PooledConnection> {
    // Reserve a dedicated connection when the driver supports it (>= 3.4) so
    // the PooledConnection contract (one pinned session) actually holds.
    if (typeof this.sql.reserve === 'function') {
      const reserved = await this.sql.reserve();

      return new PostgresPooledConnection(reserved, true, this.defaultStatementTimeout);
    }

    // Fallback: shared pool instance (no session pinning). Transactions are
    // unaffected — they go through sql.begin() on the transaction() method.
    return new PostgresPooledConnection(this.sql, false, this.defaultStatementTimeout);
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
   * Normalize a porsager `.simple()` result into an array of result sets.
   *
   * For a SINGLE statement, `.simple()` returns the RowList itself (an array of
   * row objects carrying a string `command`); for MULTIPLE statements it
   * returns a plain array of RowLists. Distinguish by element shape — a result
   * set's elements are row objects, never arrays.
   */
  private static normalizeSimpleResultSets(results: any): any[] {
    if (results.length > 0) {
      return Array.isArray(results[0]) ? results : [results];
    }

    return typeof results.command === 'string' ? [results] : results;
  }

  /**
   * Execute a multi-statement query using the simple protocol
   * This bypasses prepared statements and allows multiple statements
   * WARNING: Only use with safe, validated inputs!
   */
  async querySimple<T = any>(sql: string): Promise<QueryResult<T>> {
    const results = await this.sql.unsafe(sql).simple();
    const resultSets = PostgresClient.normalizeSimpleResultSets(results);

    // Return the last ROW-BEARING result set (the SELECT) — trailing
    // row-less statements (DROP TABLE cleanup etc.) must not shadow it.
    let lastResult: any = [];

    for (let i = resultSets.length - 1; i >= 0; i--) {
      if ((resultSets[i]?.length ?? 0) > 0) {
        lastResult = resultSets[i];
        break;
      }
    }

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
    return PostgresClient.normalizeSimpleResultSets(results).map((result: any) => ({
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
  async transaction<T>(callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (sql: Sql) => {
      const queryFn = async (sqlStr: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult> => {
        // Honor a per-statement `.withTimeout()` override inside the transaction.
        // `runTxStatement` scopes `SET LOCAL statement_timeout` to this statement.
        return await runTxStatement(sql, sqlStr, params, options?.timeoutMs, this.defaultStatementTimeout, options?.prepare);
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
