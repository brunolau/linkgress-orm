# Database Client Architecture

## Overview

Linkgress ORM now supports multiple PostgreSQL client libraries through a client-agnostic architecture. You can use the `pg` (node-postgres) library, the `postgres` library, or PGlite — PostgreSQL compiled to WASM, running in-process — with the same ORM API.

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

### 3. PGliteClient (PGlite)

The `PGliteClient` runs linkgress on [PGlite](https://pglite.dev): the PostgreSQL engine (18.x in
PGlite 0.5) compiled to WebAssembly, running inside your process — Node, Bun, Deno or a browser —
with no server to install. It suits tests, local-first apps, CLIs and demos.

**Installation:**
```bash
npm install @electric-sql/pglite
```

**Usage:**
```typescript
import { PGliteClient, DbContext } from 'linkgress-orm';

// Option 1: In-memory, gone when the process exits
const client = new PGliteClient();

// Option 2: Persisted to a directory, with extensions (register them here; CREATE EXTENSION then works)
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
const client = new PGliteClient({ dataDir: './pgdata', extensions: { pg_trgm } });

// Option 3: An instance you created (ESM and browser builds, or to share one instance)
import { PGlite } from '@electric-sql/pglite';
const client = new PGliteClient(await PGlite.create());

const db = new DbContext(client, schema);
```

`dispose()` closes an instance the client created; an instance you passed in stays open.

**How it differs from a server connection:**
- **One session.** PGlite runs a single session, one statement at a time. `connect()` leases that
  session until `release()` — a pool of one, shared by every `PGliteClient` over the same instance —
  and other queries wait meanwhile, so never await a query on the outer context while holding a
  connection. Inside `db.transaction()` use the transactional context: a query on the outer context
  (or a second transaction) from the callback could never run, so it throws at once instead of
  hanging. Session state (temp tables, `SET`) is shared by everything using the instance.
- **No statement timeouts.** PGlite cannot cancel a running statement: `.withTimeout()` and
  `statement_timeout` are not enforced.
- **Values.** An instance the client creates follows `pg` wherever `pg` and `postgres` agree:
  `int8`/`bigint` comes back as a string, `bytea` as a `Buffer` (a `Uint8Array` where there is no
  Buffer), and a `Date` bound to a `date` / `timestamp` / `timestamptz` parameter is sent in local
  time, so it stores the same calendar day and wall-clock time as with `pg` and `postgres`. (PGlite's
  own default sends UTC, which lands a local-midnight `Date` on the previous day east of Greenwich and
  shifts every `Date` round-tripped through `timestamp` by the host's offset.) Override any type with
  `parsers` / `serializers`, e.g. `parsers: { 20: v => BigInt(v) }`. `date` columns read back as UTC
  midnight, as with `postgres` (`pg` gives local midnight).
- **Collation and time zone.** A PGlite database uses the `C` collation, so text sorts by byte order
  (`Z` before `a`) where a server usually has a linguistic default, and ICU collations need ICU data
  PGlite does not ship. The session starts in a fixed-offset `TimeZone` such as `Etc/GMT-1`, which
  ignores daylight saving — `now()` and `timestamptz` text are then an hour off in summer. Named zones
  work: run `SET TIME ZONE 'Europe/Bratislava'` if your SQL depends on the zone.
- **Multi-statement SQL** runs through PGlite's `exec()`, so the single-round-trip paths (temp-table
  strategy, `FutureQuery` batches) apply.
- **Under jest**, node needs `--experimental-vm-modules`: PGlite loads its WASM through dynamic `import()`.

### 4. BunClient (Bun.SQL)

The `BunClient` runs linkgress on Bun's built-in SQL client — no driver package to install. It only
works under the Bun runtime.

**Usage:**
```typescript
import { BunClient, DbContext } from 'linkgress-orm';

// Option 1: Configuration object (Bun.SQL options)
const client = new BunClient({ hostname: 'localhost', port: 5432, database: 'mydb', username: 'postgres', password: 'password' });

// Option 2: Text-format results (see below)
const client = new BunClient({ hostname: 'localhost', database: 'mydb', prepare: false });

// Option 3: Connection string, or an SQL instance you created (it stays yours to close)
const client = new BunClient('postgres://postgres:password@localhost:5432/mydb');
const client = new BunClient(new Bun.SQL('postgres://…'));

const db = new DbContext(client, schema);
```

**Parameters.** BunClient sends what Bun cannot bind itself the way `postgres` does:
- A `Date` goes as its ISO instant, in both modes: a `timestamptz` gets the instant, a `timestamp` its
  UTC wall time, a `date` the UTC date. (Bun sends `Date.prototype.toString()` — "Sun Mar 10 2024
  01:00:00 GMT+0100 (…)" — wherever the server does not describe a timestamp parameter, and
  everywhere with `prepare: false`, which PostgreSQL rejects or stores as that text.)
- With `prepare: false`, a plain object or array goes as its JSON text (Bun would send
  "[object Object]"); bytes (`Uint8Array`, `Buffer`) and value classes with a `toString()` of their own
  are left to Bun.
- A JS array cannot be bound to a native ARRAY parameter by Bun in either mode. linkgress binds a
  native array column (`integer('ids').array()`) and `cast(values, 'int[]')` as a PostgreSQL array
  literal, which works; a raw JS array you pass to raw SQL for an array parameter still fails —
  pass `cast(values, 'int[]')` (or a literal) instead. A JS array bound to `jsonb` is JSON, as with
  the other drivers.

**Results.**
- Through the binary protocol (the default), Bun decodes an `int4[]` column as an `Int32Array` and a
  `float4[]` as a `Float32Array`; BunClient hands them over as plain arrays, as every other driver
  does (`int8[]` elements as strings). A multidimensional array result cannot be decoded at all
  (`ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET`) — read it as text, or use `prepare: false`.
- A numeric ZERO read through the binary protocol loses its scale (`numeric(20,4)` `0.0000` reads as
  `"0"`); non-zero values keep it, and text mode keeps both. A Bun decoder bug, pinned by the test
  suite so a fixed Bun shows up. BunClient reports it (`losesNumericZeroScale()` is `true` in the
  binary mode), and linkgress gives the zero of a column declared with a scale
  (`decimal('amount', 10, 2)`) its scale back — in entity rows, projections, one-value selections and
  every mutation's `.returning()`. A column without a declared scale (`numeric('n')`) and raw SQL
  (`db.query(...)`) read as Bun delivers them.
- `prepare: false` uses unnamed statements with text-format results: native arrays decode correctly
  everywhere (collections then keep `array_agg`), at a small re-parse cost per query.
- `datesAsStrings: true` turns `Date` results into PostgreSQL text (`YYYY-MM-DD HH:MM:SS.mmm`).

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

A few capability hooks have defaults a client overrides when its driver differs:
`supportsMultiStatementQueries()`, `supportsBinaryProtocol()`, `supportsBinaryArrayResults()` (false:
collections aggregate with `json_agg` so no native array reaches the driver) and
`losesNumericZeroScale()` (true: the driver reads a scaled numeric zero as `"0"`, and the query
builders restore the scale of columns declared with one).

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

A production context usually wants the opposite: no per-statement output, but every statement
that FAILS (and, via `onQueryTakingTooLong`, every slow one) still recorded:

```typescript
const db = new DbContext(client, schema, {
  logQueries: false,        // no '[SQL Query]' / '[Parameters]' lines
  logFailedQueries: true,   // '[SQL Error] <message>\n<statement>' on the 'error' section
  logParameters: false,     // keep parameter values out of the failure line too
  logger: (message, section) => myLogger.route(message, section),
});
```

`logFailedQueries` defaults to the value of `logQueries`, so contexts that never set it behave
as before.

### Prepared statements (PostgresClient)

postgres.js sends `unsafe()` statements UNNAMED by default: parsed, described (an extra round
trip) and planned on every execution. `preparedStatements: true` names them, so each distinct
statement text is planned once per connection and reused:

```typescript
const db = new DbContext(client, schema, {
  preparedStatements: true,   // opt-in; default false
});

// Per-query override in either direction — mirrors .withTimeout():
await db.products.withPreparedStatements(false).where(p => eq(p.active, true)).toList(); // wide analytical query: keep custom plans
await db.tokens.withPreparedStatements(true).where(t => eq(t.id, id)).firstOrDefault();  // hot lookup on an unprepared context
```

The same override is available on an **already-built** query — `QueryBuilder`,
`SelectQueryBuilder` and `JoinQueryBuilder`, at any point of the chain — so a helper that is
handed a query can opt it out without owning the context:

```typescript
// A paginated grid: the text changes with every request (offset, sort, filters),
// so preparing it would leave a cached plan per variant in every pooled connection.
await modelQuery.orderBy(o => o.createdAt).limit(25).offset(250)
  .withPreparedStatements(false)
  .toList();

await modelQuery.withPreparedStatements(false).count();
```

The override covers every execution of that builder (`toList`, `count`, `countOver`,
`firstOrDefault`, …) and survives `.withTimeout()` / `.expectedExecutionTime()` chaining.

Measure before enabling: after five executions PostgreSQL may switch to a generic plan, which
suits uniform-selectivity OLTP statements and can slow down wide analytical ones. Statements
whose text varies per call (`IN` lists of varying length, VALUES lists) are cached per variant —
[`inArrayOpt` / `inArrayPadBuckets`](./guides/querying.md#matching-a-list-of-values) bound that
variety; the bulk-insert legs (`insertWithChildren`, `insertBulkWithChildren`, `MutationBatch`)
stay unnamed regardless of the option. Only `PostgresClient` honors it, and only when the
postgres.js instance was not created with `prepare: false`.

Full option reference, including what to read on the server before and after enabling it:
[Configuration & Options](./guides/configuration.md#server-side-prepared-statements-opt-in).

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
- The only client that can run statements as named server-side prepared statements
  ([`preparedStatements`](#prepared-statements-postgresclient), opt-in)
- True single-round-trip multi-statement support (`querySimple`)
- Better streaming support
- Modern async/await first API

### PGliteClient (`@electric-sql/pglite`)
- No server and no network: the engine runs in your process, as WebAssembly
- One session, one statement at a time: not for concurrent workloads
- Slower per statement than a native server, much faster at what makes a server touch its disk
  (schema changes, `TRUNCATE`); in tests a database per test file allows parallel workers — see the
  [measurements](../bench/pglite/README.md)

## Future Enhancements

The client architecture enables future support for:

- **MySQL/MariaDB** via `mysql2` or other drivers
- **SQLite** via `better-sqlite3`
- **SQL Server** via `mssql`
- **Custom cloud databases** (AWS RDS, Azure SQL, etc.)

Each new driver can be added by implementing the `DatabaseClient` interface without changing the ORM's core logic.

## Connection Pooling and Lifecycle Management

### Understanding Connection Pooling

Both `PgClient` and `PostgresClient` use **connection pooling** under the hood (`PGliteClient` has no
pool: it runs one in-process session, see [above](#3-pgliteclient-pglite)). This means:

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
   - Use `PGliteClient` for tests without a server, local-first apps and browsers

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
