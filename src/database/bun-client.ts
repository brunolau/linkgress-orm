import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions } from './database-client.interface';
import type { BunSqlOptions } from './types';

// Use dynamic import to make bun:sql optional
type BunSql = any;

/**
 * Check if a value is a Bun SQL instance
 */
function isBunSqlInstance(value: any): boolean {
  return value && typeof value === 'function' && typeof value.unsafe === 'function' && typeof value.close === 'function';
}

/**
 * Wrapper for the reserved connection from Bun SQL
 */
class BunPooledConnection implements PooledConnection {
  constructor(private reserved: any) {}

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    const result = await this.reserved.unsafe(sql, params || []);

    return {
      rows: Array.from(result) as T[],
      rowCount: result.count ?? result.length ?? null,
    };
  }

  release(): void {
    this.reserved.release();
  }
}

/**
 * DatabaseClient implementation for Bun's built-in SQL client
 * @see https://bun.sh/docs/api/sql
 *
 * NOTE: This requires Bun runtime. The SQL client is built into Bun.
 * Supports PostgreSQL, MySQL, and SQLite.
 */
export class BunClient extends DatabaseClient {
  private sql: BunSql;
  private ownsConnection: boolean;

  /**
   * Create a BunClient
   * @param config - Either a connection string, BunSqlOptions config object, or an existing Bun SQL instance
   *
   * @example
   * ```typescript
   * // Connection string
   * const client = new BunClient("postgres://user:pass@localhost:5432/mydb");
   *
   * // Options object
   * const client = new BunClient({
   *   hostname: "localhost",
   *   port: 5432,
   *   database: "mydb",
   *   username: "user",
   *   password: "pass",
   * });
   *
   * // Existing SQL instance
   * import { SQL } from "bun";
   * const sql = new SQL("postgres://...");
   * const client = new BunClient(sql);
   * ```
   */
  constructor(config: string | BunSqlOptions | BunSql) {
    super();

    // Check if config is an existing Bun SQL instance
    if (isBunSqlInstance(config)) {
      this.sql = config;
      this.ownsConnection = false;
    } else {
      try {
        // Bun's SQL is available via require('bun:sql') or import { SQL } from 'bun'
        // We try the bun:sql module first
        const { SQL } = require('bun:sql');
        this.sql = new SQL(config as any);
        this.ownsConnection = true;
      } catch (error) {
        throw new Error(
          'BunClient requires Bun runtime with SQL support. ' +
          'This client only works when running under Bun. ' +
          'Make sure you are using Bun and have a compatible version.'
        );
      }
    }
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // Use unsafe() for parameterized queries (similar to postgres library)
    const result = await this.sql.unsafe(sql, params || []);

    return {
      rows: Array.from(result) as T[],
      rowCount: result.count ?? result.length ?? null,
    };
  }

  async connect(): Promise<PooledConnection> {
    // Bun SQL uses reserve() to get a dedicated connection from the pool
    const reserved = await this.sql.reserve();
    return new BunPooledConnection(reserved);
  }

  async end(): Promise<void> {
    // Only close the connection if we created it
    if (this.ownsConnection) {
      await this.sql.close();
    }
  }

  getDriverName(): string {
    return 'bun';
  }

  /**
   * Execute a callback within a transaction.
   * Uses Bun SQL's built-in sql.begin() for proper transaction handling.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx: BunSql) => {
      const queryFn = async (sqlStr: string, params?: any[]): Promise<QueryResult> => {
        const result = await tx.unsafe(sqlStr, params || []);
        return {
          rows: Array.from(result) as any[],
          rowCount: result.count ?? result.length ?? null,
        };
      };

      return await callback(queryFn);
    });
  }

  /**
   * Bun SQL supports multiple SQL statements using .simple() mode
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
    const resultsArray = Array.isArray(results) ? results : [results];
    const lastResult = resultsArray[resultsArray.length - 1] || [];

    return {
      rows: Array.from(lastResult) as T[],
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
    const resultsArray = Array.isArray(results) ? results : [results];
    return resultsArray.map((result: any) => ({
      rows: Array.from(result) as any[],
      rowCount: result.count ?? result.length ?? null,
    }));
  }

  /**
   * Bun SQL automatically uses binary protocol where appropriate
   * No explicit toggle needed
   */
  supportsBinaryProtocol(): boolean {
    return false; // No explicit control, but uses binary internally
  }

  /**
   * Get access to the underlying Bun SQL instance for advanced use cases
   */
  getSql(): BunSql {
    return this.sql;
  }
}
