import { DatabaseClient, PooledConnection, QueryResult } from './database-client.interface';
import type { PostgresOptions } from './types';

// Use dynamic import to make postgres optional
type Sql = any;

/**
 * Wrapper for the pooled connection from postgres library
 */
class PostgresPooledConnection implements PooledConnection {
  constructor(private sql: Sql) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const result = await this.sql.unsafe(sql, params || []);

    return {
      rows: result as T[],
      rowCount: result.count ?? null,
    };
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

  constructor(config: string | PostgresOptions) {
    super();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const postgres = require('postgres');
      this.sql = postgres(config as any);
    } catch (error) {
      throw new Error(
        'PostgresClient requires the "postgres" package to be installed. ' +
        'Install it with: npm install postgres'
      );
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const result = await this.sql.unsafe(sql, params || []);

    return {
      rows: result as T[],
      rowCount: result.count ?? null,
    };
  }

  async connect(): Promise<PooledConnection> {
    // postgres library doesn't expose individual connections in the same way
    // We'll return a wrapper that uses the same sql instance
    // For transactions, the library handles it through sql.begin()
    return new PostgresPooledConnection(this.sql);
  }

  async end(): Promise<void> {
    await this.sql.end();
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
   */
  async begin<T>(callback: (sql: Sql) => Promise<T>): Promise<T> {
    return await this.sql.begin(callback);
  }

  /**
   * Get access to the underlying sql instance for advanced use cases
   */
  getSql(): Sql {
    return this.sql;
  }
}
