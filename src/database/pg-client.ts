import { DatabaseClient, PooledConnection, QueryResult } from './database-client.interface';
import type { PoolConfig } from './types';

// Use dynamic import to make pg optional
type Pool = any;
type PoolClient = any;

/**
 * Wrapper for the pooled connection from pg library
 */
class PgPooledConnection implements PooledConnection {
  constructor(private client: PoolClient) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);

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

  constructor(config: PoolConfig) {
    super();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Pool } = require('pg');
      this.pool = new Pool(config);
    } catch (error) {
      throw new Error(
        'PgClient requires the "pg" package to be installed. ' +
        'Install it with: npm install pg'
      );
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);

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
    await this.pool.end();
  }

  getDriverName(): string {
    return 'pg';
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
   * Get access to the underlying pg Pool for advanced use cases
   */
  getPool(): Pool {
    return this.pool;
  }
}
