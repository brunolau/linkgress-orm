/**
 * Database-agnostic query result interface
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Query execution options
 */
export interface QueryExecutionOptions {
  /**
   * Use binary protocol for data transfer (when supported by driver).
   * Binary protocol can improve performance by avoiding string conversions.
   * Default: false (uses text protocol)
   */
  useBinaryProtocol?: boolean;

  /**
   * Per-query timeout override, in milliseconds. Set by `.withTimeout(ms)`.
   *
   * When present, the driver runs *this query only* inside a short transaction
   * that issues `SET LOCAL statement_timeout` first — so the override is scoped
   * to the query (auto-resets at COMMIT) and cannot affect other queries on the
   * pooled connection. A value of `0` disables the timeout for this query
   * (overriding any connection-level default). When absent, no wrapping happens
   * and the connection-level default (if any) applies.
   *
   * On timeout the driver throws a {@link QueryTimeoutError}.
   *
   * NOTE: Currently only honored by `PostgresClient` (the `postgres`/porsager
   * driver). `PgClient` and `BunClient` ignore it.
   */
  timeoutMs?: number;
}

/**
 * Error thrown when a query is cancelled because it exceeded its timeout — the
 * per-query `.withTimeout(ms)` override or the connection-level
 * `statement_timeout` default.
 *
 * The underlying database error (PostgreSQL code `57014`, "canceling statement
 * due to statement timeout") is preserved on the `cause` property.
 */
export class QueryTimeoutError extends Error {
  /** The timeout that was exceeded, in milliseconds (`0` if not known). */
  readonly timeoutMs: number;
  /** The SQL text of the query that timed out. */
  readonly sql: string;
  /** The original driver error that surfaced the cancellation, if any. */
  readonly cause?: unknown;

  constructor(timeoutMs: number, sql: string, cause?: unknown) {
    super(`Query exceeded its timeout of ${timeoutMs}ms and was cancelled`);
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
    this.sql = sql;
    this.cause = cause;
    // Restore prototype chain so `instanceof` works when targeting ES5
    Object.setPrototypeOf(this, QueryTimeoutError.prototype);
  }
}

/**
 * Database-agnostic pooled client/connection interface
 * Represents a single connection from the pool for transactions
 */
export interface PooledConnection {
  query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>>;
  release(): void;
}

/**
 * Base database client interface that all drivers must implement
 */
export abstract class DatabaseClient {
  /**
   * Whether this client is currently in a transaction
   */
  isInTransaction(): boolean {
    return false;
  }
  /**
   * Execute a query with optional parameters and execution options
   */
  abstract query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>>;

  /**
   * Get a connection from the pool for transactions
   */
  abstract connect(): Promise<PooledConnection>;

  /**
   * Close the connection pool
   */
  abstract end(): Promise<void>;

  /**
   * Get the driver name (postgres, pg, mysql, etc.)
   */
  abstract getDriverName(): string;

  /**
   * Execute a callback within a transaction.
   * The transaction is automatically committed on success or rolled back on error.
   *
   * @param callback - Function to execute within the transaction. Receives a query function.
   * @returns The result of the callback
   */
  abstract transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T>;

  /**
   * Check if the driver supports executing multiple SQL statements in a single query
   * and returning multiple result sets.
   *
   * PostgreSQL drivers (pg, postgres) support this feature.
   * Default: false for safety
   */
  supportsMultiStatementQueries(): boolean {
    return false;
  }

  /**
   * Check if the driver supports binary protocol for improved performance.
   * Default: false
   */
  supportsBinaryProtocol(): boolean {
    return false;
  }
}

/**
 * A wrapper client that routes queries through a transactional connection.
 * Used internally to ensure all operations within a transaction use the same connection.
 */
export class TransactionalClient extends DatabaseClient {
  constructor(
    private queryFn: (sql: string, params?: any[]) => Promise<QueryResult>,
    private parentClient: DatabaseClient
  ) {
    super();
  }

  isInTransaction(): boolean {
    return true;
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    return await this.queryFn(sql, params) as QueryResult<T>;
  }

  async connect(): Promise<PooledConnection> {
    // In a transaction, we shouldn't allow getting a new connection
    throw new Error('Cannot get a new connection while in a transaction');
  }

  async end(): Promise<void> {
    // No-op - the parent client manages the connection lifecycle
  }

  getDriverName(): string {
    return this.parentClient.getDriverName();
  }

  async transaction<T>(_callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    // Nested transactions not supported - could implement savepoints in the future
    throw new Error('Nested transactions are not supported');
  }

  supportsMultiStatementQueries(): boolean {
    return this.parentClient.supportsMultiStatementQueries();
  }

  supportsBinaryProtocol(): boolean {
    return this.parentClient.supportsBinaryProtocol();
  }
}
