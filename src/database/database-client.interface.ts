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
