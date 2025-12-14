import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions } from './database-client.interface';
import type { PoolConfig } from './types';

// Use dynamic import to make pg optional
type Pool = any;
type PoolClient = any;

/**
 * Check if a value is a pg.Pool instance
 */
function isPgPoolInstance(value: any): boolean {
  return value && typeof value === 'object' && typeof value.query === 'function' && typeof value.connect === 'function' && typeof value.end === 'function';
}

/**
 * Wrapper for the pooled connection from pg library
 */
class PgPooledConnection implements PooledConnection {
  constructor(private client: PoolClient) {}

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // pg library supports binary protocol via types option
    const queryConfig = options?.useBinaryProtocol
      ? { text: sql, values: params, rowMode: 'array' as const }
      : { text: sql, values: params };

    const result = await this.client.query(queryConfig);

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  release(): void {
    this.client.release();
  }
}

/**
 * DatabaseClient implementation for the 'pg' library
 * @see https://node-postgres.com/
 *
 * NOTE: This requires the 'pg' package to be installed:
 * npm install pg
 */
export class PgClient extends DatabaseClient {
  private pool: Pool;
  private ownsConnection: boolean;

  /**
   * Create a PgClient
   * @param config - Either a PoolConfig object or an existing pg.Pool instance
   */
  constructor(config: PoolConfig | Pool) {
    super();

    // Check if config is an existing pg.Pool instance
    if (isPgPoolInstance(config)) {
      this.pool = config;
      this.ownsConnection = false;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Pool } = require('pg');
        this.pool = new Pool(config);
        this.ownsConnection = true;
      } catch (error) {
        throw new Error(
          'PgClient requires the "pg" package to be installed. ' +
          'Install it with: npm install pg'
        );
      }
    }
  }

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // pg library supports binary protocol via types option
    const queryConfig = options?.useBinaryProtocol
      ? { text: sql, values: params, rowMode: 'array' as const }
      : { text: sql, values: params };

    const result = await this.pool.query(queryConfig);

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  async connect(): Promise<PooledConnection> {
    const client = await this.pool.connect();
    return new PgPooledConnection(client);
  }

  async end(): Promise<void> {
    // Only close the pool if we created it
    if (this.ownsConnection) {
      await this.pool.end();
    }
  }

  getDriverName(): string {
    return 'pg';
  }

  /**
   * Execute a callback within a transaction.
   * Uses pg's connection-based transaction with BEGIN/COMMIT/ROLLBACK.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const queryFn = async (sql: string, params?: any[]): Promise<QueryResult> => {
        const result = await client.query(sql, params);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
        };
      };

      const result = await callback(queryFn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * pg library does NOT support retrieving ALL result sets from multi-statement queries
   * It only returns the last result, making it unsuitable for the fully optimized approach
   * Use PostgresClient (postgres library) for true single-roundtrip multi-statement support
   */
  supportsMultiStatementQueries(): boolean {
    return false;
  }

  /**
   * pg library supports binary protocol via rowMode option
   */
  supportsBinaryProtocol(): boolean {
    return true;
  }

  /**
   * Get access to the underlying pg Pool for advanced use cases
   */
  getPool(): Pool {
    return this.pool;
  }
}
