/**
 * Example: Using typed configuration for database clients
 *
 * This example demonstrates the full TypeScript intellisense support
 * for both PgClient and PostgresClient configurations.
 */

import {
  PgClient,
  PostgresClient,
  DataContext,
  PoolConfig,
  PostgresOptions,
  table,
  serial,
  varchar
} from '../src/index';

// Define a simple schema
const userTable = table('users', {
  id: serial().primaryKey(),
  username: varchar(50).notNull(),
});

const schema = { users: userTable };

// ============================================================================
// Example 1: PgClient with typed configuration (full intellisense)
// ============================================================================

// TypeScript will provide intellisense for all options
const pgConfig: PoolConfig = {
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',

  // Connection pool options
  max: 20,                      // Maximum number of clients in the pool
  min: 0,                       // Minimum number of clients
  idleTimeoutMillis: 30000,     // Close idle clients after 30s
  connectionTimeoutMillis: 2000, // Timeout when connecting new client

  // Optional: SSL configuration
  ssl: {
    rejectUnauthorized: false,
    // ca: fs.readFileSync('path/to/ca.crt').toString(),
  },

  // Optional: Application name for logging
  application_name: 'my-app',
};

const pgClient = new PgClient(pgConfig);

// Or use connection string (also fully typed)
const pgClientWithUrl = new PgClient({
  connectionString: 'postgres://postgres:password@localhost:5432/mydb',
  max: 20,
  ssl: false,
});

// ============================================================================
// Example 2: PostgresClient with typed configuration (full intellisense)
// ============================================================================

// TypeScript will provide intellisense for all options
const postgresConfig: PostgresOptions = {
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',

  // Connection pool options
  max: 20,                // Maximum number of connections
  min: 0,                 // Minimum number of idle connections
  idle_timeout: 30,       // Idle connection timeout in seconds
  connect_timeout: 2,     // Connection timeout in seconds
  max_lifetime: 3600,     // Max lifetime of a connection in seconds

  // Optional: SSL configuration
  ssl: 'prefer',  // Can be boolean, string, or object

  // Optional: Prepared statements
  prepare: true,  // Use prepared statements (default: true)

  // Optional: Debug mode
  debug: false,   // or provide a function for custom logging

  // Optional: Transform column names
  transform: {
    column: (column) => column.toLowerCase(),
    // value: (value) => ...,
    // row: (row) => ...,
  },

  // Optional: Connection properties
  connection: {
    application_name: 'my-app',
  },

  // Optional: Event handlers
  onnotice: (notice) => console.log('Notice:', notice),
  onclose: (connectionId) => console.log('Connection closed:', connectionId),
};

const postgresClient = new PostgresClient(postgresConfig);

// Or use connection string (most common)
const postgresClientWithUrl = new PostgresClient('postgres://postgres:password@localhost:5432/mydb');

// ============================================================================
// Example 3: Creating DataContext with typed clients
// ============================================================================

async function exampleUsage() {
  // Both clients work the same way with DataContext
  const db = new DataContext(pgClient, schema);

  // All ORM operations work identically
  await db.users.insert({
    username: 'john_doe',
  });

  const users = await db.users
    .select(u => ({ id: u.id, username: u.username }))
    .toList();

  console.log('Users:', users);

  // Clean up
  await db.dispose();
}

// ============================================================================
// Example 4: Environment-based configuration with types
// ============================================================================

function createDatabaseClient() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // Choose client based on preference
  const usePostgres = process.env.DB_CLIENT === 'postgres';

  if (usePostgres) {
    // Modern postgres library
    const config: PostgresOptions = {
      connectionString: databaseUrl,
      max: parseInt(process.env.DB_POOL_MAX || '20'),
      idle_timeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30'),
      connect_timeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '2'),
      ssl: process.env.DB_SSL === 'true' ? 'require' : false,
    };

    return new PostgresClient(config);
  } else {
    // Traditional pg library
    const config: PoolConfig = {
      connectionString: databaseUrl,
      max: parseInt(process.env.DB_POOL_MAX || '20'),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '2000'),
      ssl: process.env.DB_SSL === 'true',
    };

    return new PgClient(config);
  }
}

// ============================================================================
// Example 5: Advanced configuration patterns
// ============================================================================

// PgClient with SSL for production
const pgProductionConfig: PoolConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // Production pool settings
  max: 50,
  min: 10,

  // SSL required for production
  ssl: {
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CA,
    key: process.env.DB_SSL_KEY,
    cert: process.env.DB_SSL_CERT,
  },

  // Timeouts for production
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 60000,
  query_timeout: 30000,
  statement_timeout: 30000,
};

// PostgresClient with debug logging
const postgresDevConfig: PostgresOptions = {
  host: 'localhost',
  port: 5432,
  database: 'dev_db',
  user: 'dev',
  password: 'dev',

  // Development pool settings
  max: 5,

  // Enable debug logging
  debug: (connection, query, params) => {
    console.log(`[Connection ${connection}] Query:`, query);
    console.log('Params:', params);
  },

  // Custom column transformation
  transform: {
    column: (column) => {
      // Convert snake_case to camelCase
      return column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    },
  },
};

// ============================================================================
// Benefits of Typed Configurations
// ============================================================================

/*
✅ Full IntelliSense in VS Code, WebStorm, etc.
✅ Auto-completion for all configuration options
✅ Inline documentation for each option
✅ Type checking catches errors at compile time
✅ Refactoring support (rename properties safely)
✅ No need to reference documentation constantly
✅ Discover available options through autocomplete

Example: Type in VS Code:
  const config: PoolConfig = {
    h   // ← IntelliSense shows: host, ...
  }

  const config: PostgresOptions = {
    max: 20,
    i   // ← IntelliSense shows: idle_timeout, ...
  }
*/

// ============================================================================
// Type Safety Examples
// ============================================================================

// TypeScript will catch these errors:

// ❌ Error: Property 'invalid_option' does not exist
// const badConfig: PoolConfig = {
//   invalid_option: true,
// };

// ❌ Error: Type 'string' is not assignable to type 'number'
// const badPort: PoolConfig = {
//   port: 'not-a-number',
// };

// ❌ Error: SSL must be boolean, string, or object
// const badSsl: PostgresOptions = {
//   ssl: 123,  // Wrong type
// };

// ✅ All these are valid:
const validSsl1: PostgresOptions = { ssl: false };
const validSsl2: PostgresOptions = { ssl: 'require' };
const validSsl3: PostgresOptions = { ssl: { rejectUnauthorized: true } };

export { exampleUsage, createDatabaseClient };
