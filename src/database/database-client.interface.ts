/**
 * Database-agnostic query result interface
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Database-agnostic pooled client/connection interface
 * Represents a single connection from the pool for transactions
 */
export interface PooledConnection {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  release(): void;
}

/**
 * Base database client interface that all drivers must implement
 */
export abstract class DatabaseClient {
  /**
   * Execute a query with optional parameters
   */
  abstract query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;

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
   * Check if the driver supports executing multiple SQL statements in a single query
   * and returning multiple result sets.
   *
   * PostgreSQL drivers (pg, postgres) support this feature.
   * Default: false for safety
   */
  supportsMultiStatementQueries(): boolean {
    return false;
  }
}
