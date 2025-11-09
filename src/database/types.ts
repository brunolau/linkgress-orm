/**
 * Configuration types for database clients
 * These are based on the actual pg and postgres libraries but defined here
 * to avoid requiring the packages at compile time.
 */

/**
 * Connection pool configuration for node-postgres (pg) library
 * @see https://node-postgres.com/apis/pool
 */
export interface PoolConfig {
  /**
   * Database host (default: localhost)
   */
  host?: string;

  /**
   * Database server port (default: 5432)
   */
  port?: number;

  /**
   * Database name
   */
  database?: string;

  /**
   * Database user
   */
  user?: string;

  /**
   * Database password
   */
  password?: string;

  /**
   * Connection string (alternative to individual options)
   * Format: postgres://user:password@host:port/database
   */
  connectionString?: string;

  /**
   * Maximum number of clients in the pool (default: 10)
   */
  max?: number;

  /**
   * Minimum number of clients in the pool (default: 0)
   */
  min?: number;

  /**
   * Number of milliseconds to wait before timing out when connecting a new client (default: 0 - no timeout)
   */
  connectionTimeoutMillis?: number;

  /**
   * Number of milliseconds a client must sit idle in the pool before being closed (default: 10000)
   */
  idleTimeoutMillis?: number;

  /**
   * Maximum number of milliseconds to wait for a query to complete (default: 0 - no timeout)
   */
  query_timeout?: number;

  /**
   * Maximum number of milliseconds to wait for a connection (default: 0 - no timeout)
   */
  statement_timeout?: number;

  /**
   * Number of milliseconds before a query will time out (default: 0 - no timeout)
   */
  idle_in_transaction_session_timeout?: number;

  /**
   * Application name for logging (default: undefined)
   */
  application_name?: string;

  /**
   * Whether to use SSL (default: false)
   */
  ssl?: boolean | {
    rejectUnauthorized?: boolean;
    ca?: string;
    key?: string;
    cert?: string;
  };

  /**
   * Custom types parser
   */
  types?: any;

  /**
   * Whether to allow exiting the pool (default: true)
   */
  allowExitOnIdle?: boolean;
}

/**
 * Connection options for postgres.js library
 * @see https://github.com/porsager/postgres
 */
export interface PostgresOptions {
  /**
   * Database host (default: localhost)
   */
  host?: string;

  /**
   * Database server port (default: 5432)
   */
  port?: number;

  /**
   * Database name
   */
  database?: string;

  /**
   * Database user (default: process.env.USER)
   */
  user?: string;

  /**
   * Username (alias for user)
   */
  username?: string;

  /**
   * Database password
   */
  password?: string;

  /**
   * Pass phrase for encrypted key
   */
  pass?: string;

  /**
   * Maximum number of connections (default: 10)
   */
  max?: number;

  /**
   * Minimum number of idle connections (default: 0)
   */
  min?: number;

  /**
   * Idle connection timeout in seconds (default: undefined)
   */
  idle_timeout?: number;

  /**
   * Connection timeout in seconds (default: undefined)
   */
  connect_timeout?: number;

  /**
   * Max lifetime of a connection in seconds (default: 3600)
   */
  max_lifetime?: number;

  /**
   * Timeout for queries in seconds (default: undefined)
   */
  timeout?: number;

  /**
   * SSL configuration (default: false)
   */
  ssl?: boolean | 'require' | 'allow' | 'prefer' | 'verify-full' | {
    rejectUnauthorized?: boolean;
    ca?: string;
    key?: string;
    cert?: string;
  };

  /**
   * Whether to use prepared statements (default: true)
   */
  prepare?: boolean;

  /**
   * Transform column names (default: undefined)
   */
  transform?: {
    column?: (column: string) => string;
    value?: (value: any) => any;
    row?: (row: any) => any;
  };

  /**
   * Custom types mapping
   */
  types?: any;

  /**
   * Connection properties
   */
  connection?: {
    application_name?: string;
    [key: string]: any;
  };

  /**
   * Called when connection is established
   */
  onnotice?: (notice: any) => void;

  /**
   * Called when connection is closed
   */
  onclose?: (connectionId: number) => void;

  /**
   * Called for query logging
   */
  debug?: boolean | ((connection: number, query: string, params: any[], types: any[]) => void);

  /**
   * Fetch array mode (default: false)
   */
  fetch_types?: boolean;

  /**
   * Publications for logical replication
   */
  publications?: string;

  /**
   * Target session attributes (default: any)
   */
  target_session_attrs?: 'any' | 'read-write' | 'read-only' | 'primary' | 'standby' | 'prefer-standby';
}
