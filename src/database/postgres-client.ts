import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions } from './database-client.interface';
import type { PostgresOptions } from './types';

// Use dynamic import to make postgres optional
type Sql = any;

/**
 * Check if a value is a postgres.Sql instance
 */
function isPostgresSqlInstance(value: any): boolean {
  return value && typeof value === 'function' && typeof value.unsafe === 'function' && typeof value.end === 'function';
}

/**
 * Wrapper for the pooled connection from postgres library
 */
class PostgresPooledConnection implements PooledConnection {
  constructor(private sql: Sql) {}

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // postgres library doesn't have explicit binary protocol toggle
    // It automatically uses the most efficient protocol based on data types
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
  private ownsConnection: boolean;

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
        this.sql = postgres(config as any);
        this.ownsConnection = true;
      } catch (error) {
        throw new Error(
          'PostgresClient requires the "postgres" package to be installed. ' +
          'Install it with: npm install postgres'
        );
      }
    }
  }

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // postgres library doesn't have explicit binary protocol toggle
    // It automatically uses the most efficient protocol based on data types
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
