# Database Client Architecture

## Overview

Linkgress ORM now supports multiple PostgreSQL client libraries through a client-agnostic architecture. You can use either the `pg` (node-postgres) library or the `postgres` library with the same ORM API.

## Architecture

### Base Abstraction

The core abstraction is the `DatabaseClient` abstract class:

```typescript
abstract class DatabaseClient {
  abstract query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  abstract connect(): Promise<PooledConnection>;
  abstract end(): Promise<void>;
  abstract getDriverName(): string;
}
```

### Query Result Interface

All clients return a standardized `QueryResult`:

```typescript
interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}
```

### Pooled Connection

For transaction support, clients provide a `PooledConnection`:

```typescript
interface PooledConnection {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  release(): void;
}
```

## Supported Clients

### 1. PgClient (node-postgres)

The `PgClient` wraps the popular `pg` library.

**Installation:**
```bash
npm install pg
```

**Usage:**
```typescript
import { PgClient, DbContext } from 'linkgress-orm';

const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const db = new DbContext(client, schema);
```

**Features:**
- Mature and widely used
- Extensive community support
- Manual connection pooling
- Traditional callback-based or promise-based API

### 2. PostgresClient (postgres)

The `PostgresClient` wraps the modern `postgres` library by @porsager.

**Installation:**
```bash
npm install postgres
```

**Usage:**
```typescript
import { PostgresClient, DbContext } from 'linkgress-orm';

// Option 1: Configuration object
const client = new PostgresClient({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
  max: 20,
});

// Option 2: Connection string
const client = new PostgresClient('postgres://postgres:password@localhost:5432/mydb');

const db = new DbContext(client, schema);
```

**Features:**
- Modern, lightweight library
- Automatic connection pooling
- Template literal syntax support
- Built-in transaction support
- Better TypeScript support
- Smaller bundle size

## Creating a Custom Client

You can implement your own database client by extending `DatabaseClient`:

```typescript
import { DatabaseClient, PooledConnection, QueryResult } from 'linkgress-orm';

class MyCustomClient extends DatabaseClient {
  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    // Your implementation
  }

  async connect(): Promise<PooledConnection> {
    // Your implementation
  }

  async end(): Promise<void> {
    // Your implementation
  }

  getDriverName(): string {
    return 'my-custom-driver';
  }
}
```

## Usage with DbContext

### Basic Operations

All database operations work the same regardless of the client:

```typescript
// Insert
await db.users.insert({ username: 'john', email: 'john@example.com' });

// Query
const users = await db.users
  .select(u => ({ id: u.id, username: u.username }))
  .where(u => u.username.like('john%'))
  .toList();

// Update
await db.users.update(1, { email: 'newemail@example.com' });

// Delete
await db.users.delete(1);
```

### Transactions

Transactions are handled transparently by the client wrapper:

```typescript
await db.transaction(async (ctx) => {
  await ctx.users.insert({ username: 'user1', email: 'user1@example.com' });
  await ctx.users.insert({ username: 'user2', email: 'user2@example.com' });
  // Both inserts are committed together
});
```

### Schema Management

Schema management works with any client:

```typescript
// Create tables
await db.getSchemaManager().ensureCreated();

// Drop tables
await db.getSchemaManager().ensureDeleted();
```

### Logging

Enable query logging with both clients:

```typescript
const db = new DbContext(client, schema, {
  logQueries: true,
  logExecutionTime: true,
  logParameters: true,
  logger: console.log, // Custom logger
});
```

## Internal Changes

All internal components now use the abstract `DatabaseClient` instead of `Pool`:

- **FluentContext** → Uses `DatabaseClient`
- **QueryBuilder** → Uses `DatabaseClient`
- **DbSchemaManager** → Uses `DatabaseClient`
- **DbAutomaticMigrator** → Uses `DatabaseClient`
- **QueryExecutor** → Uses `DatabaseClient`

This allows the entire ORM to be database-agnostic while keeping the same API surface.

## Performance Considerations

Both clients offer good performance, but have different characteristics:

### PgClient (`pg`)
- Mature, battle-tested connection pooling
- Predictable performance
- Slightly larger memory footprint
- More verbose API

### PostgresClient (`postgres`)
- Newer, optimized implementation
- Smaller bundle size (~7KB vs ~20KB)
- Automatic prepared statements
- Better streaming support
- Modern async/await first API

## Future Enhancements

The client architecture enables future support for:

- **MySQL/MariaDB** via `mysql2` or other drivers
- **SQLite** via `better-sqlite3`
- **SQL Server** via `mssql`
- **Custom cloud databases** (AWS RDS, Azure SQL, etc.)

Each new driver can be added by implementing the `DatabaseClient` interface without changing the ORM's core logic.

## Connection Pooling and Lifecycle Management

### Understanding Connection Pooling

Both `PgClient` and `PostgresClient` use **connection pooling** under the hood. This means:

- The client maintains a pool of reusable database connections
- Each query borrows a connection from the pool and returns it when done
- Multiple queries can run concurrently using different connections from the pool
- You **should reuse a single DbContext instance** across your application

### Application Lifecycle Patterns

#### ❌ Anti-Pattern: Dispose After Every Query

**DON'T do this:**
```typescript
// BAD: Creates new pool for each request
app.get('/users', async (req, res) => {
  const client = new PostgresClient('postgres://...');
  const db = new AppDatabase(client);
  const users = await db.users.toList();
  await db.dispose(); // Closes entire pool!
  res.json(users);
});
```

#### ✅ Correct Pattern: Singleton DbContext

**DO this instead:**
```typescript
// GOOD: Create once at startup
const client = new PostgresClient('postgres://...');
const db = new AppDatabase(client);

// Reuse throughout your application
app.get('/users', async (req, res) => {
  const users = await db.users.toList();
  res.json(users);
});

app.get('/posts', async (req, res) => {
  const posts = await db.posts.toList();
  res.json(posts);
});

// Only dispose on shutdown
process.on('SIGTERM', async () => {
  await db.dispose();
  process.exit(0);
});
```

### Usage Patterns by Application Type

#### 1. Long-Running Applications (Web Servers, APIs)

Create the DbContext **once at startup** and keep it alive:

```typescript
import express from 'express';
import { PostgresClient } from 'linkgress-orm';
import { AppDatabase } from './database';

const app = express();

// Create database context once
const client = new PostgresClient({
  host: 'localhost',
  database: 'mydb',
  max: 20, // Pool size
});
const db = new AppDatabase(client);

// Use throughout your application
app.get('/api/users', async (req, res) => {
  const users = await db.users.toList();
  res.json(users);
});

// Graceful shutdown
const server = app.listen(3000);

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  server.close();
  await db.dispose(); // Close pool on shutdown
  process.exit(0);
});
```

#### 2. Short-Lived Scripts and CLIs

For scripts that run and exit immediately, **do** call `dispose()`:

```typescript
async function main() {
  const client = new PostgresClient('postgres://...');
  const db = new AppDatabase(client);

  try {
    await db.ensureCreated();
    await db.users.insert({ username: 'alice', email: 'alice@example.com' });
    console.log('Data inserted!');
  } finally {
    await db.dispose(); // Important for scripts!
  }
}

main().catch(console.error);
```

#### 3. Test Suites

Create a new DbContext **per test suite** (not per test):

```typescript
describe('User Tests', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    const client = new PostgresClient('postgres://...');
    db = new AppDatabase(client);
    await db.ensureCreated();
  });

  afterAll(async () => {
    await db.ensureDeleted();
    await db.dispose(); // Clean up after all tests
  });

  it('should create a user', async () => {
    const user = await db.users.insert({ username: 'test', email: 'test@example.com' });
    expect(user.username).toBe('test');
  });
});
```

### When to Call dispose()

| Scenario | Call dispose()? | Reason |
|----------|-----------------|--------|
| Web server startup | ❌ No | Keep connections alive for the app lifetime |
| After each request | ❌ **Never!** | Pool is shared across requests |
| Application shutdown | ✅ Yes | Graceful cleanup of connections |
| CLI script completion | ✅ Yes | Release resources when done |
| End of test suite | ✅ Yes | Clean up test resources |
| Lambda/Serverless cold start | ❌ No | Reuse across invocations |
| Lambda/Serverless shutdown | ✅ Maybe | Only if runtime allows cleanup hooks |

### Connection Pool Configuration

Configure pool size based on your workload:

```typescript
const client = new PostgresClient({
  host: 'localhost',
  database: 'mydb',
  max: 20,                    // Maximum pool size (default: 10)
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Timeout for acquiring connection
});
```

**Pool Size Guidelines:**
- **Low traffic** (< 100 req/s): `max: 10-20`
- **Medium traffic** (100-1000 req/s): `max: 20-50`
- **High traffic** (> 1000 req/s): `max: 50-100`
- **PostgreSQL max_connections**: Ensure `max * num_instances < max_connections`

### Dependency Injection Pattern

For better testability, inject the DbContext:

```typescript
// database.ts
export function createDatabase(connectionString: string) {
  const client = new PostgresClient(connectionString);
  return new AppDatabase(client);
}

// server.ts
const db = createDatabase(process.env.DATABASE_URL);

class UserService {
  constructor(private db: AppDatabase) {}

  async getUsers() {
    return this.db.users.toList();
  }
}

const userService = new UserService(db);
```

## Best Practices

1. **Choose the right client for your needs:**
   - Use `PgClient` if you need battle-tested stability
   - Use `PostgresClient` if you want modern features and smaller bundle size

2. **Reuse DbContext instances:**
   - Create **one** instance at startup for long-running apps
   - Only call `dispose()` when shutting down
   - Never create a new context per request

3. **Configure connection pooling appropriately:**
   - Set `max` pool size based on your workload
   - Set appropriate timeouts
   - Monitor pool exhaustion in production

4. **Enable logging during development:**
   ```typescript
   const db = new DbContext(client, schema, {
     logQueries: true,
     logExecutionTime: true,
   });
   ```

5. **Use transactions for multi-step operations:**
   ```typescript
   await db.transaction(async (ctx) => {
     // Multiple operations
   });
   ```

6. **Implement graceful shutdown:**
   ```typescript
   process.on('SIGTERM', async () => {
     await db.dispose();
     process.exit(0);
   });
   ```

## Troubleshooting

### Connection Issues

If you experience connection issues:

1. Check your connection config/URL
2. Verify database credentials
3. Ensure database is accessible
4. Check firewall settings
5. Enable connection logging

### Performance Issues

For performance problems:

1. Enable query logging to identify slow queries
2. Adjust pool size (`max` parameter)
3. Use appropriate indexes
4. Consider using `PostgresClient` for better performance

### Type Errors

If you get TypeScript errors:

1. Ensure you're importing from `linkgress-orm`
2. Update to latest version
3. Clear `node_modules` and reinstall

## Examples

See [examples/database-clients.example.ts](../examples/database-clients.example.ts) for complete working examples.
