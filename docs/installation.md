# Installation

> **For agents:** Which packages does a project need for linkgress-orm, per driver and runtime, and how do I check that the install works?
> **Use this page when:** adding linkgress-orm to a project, choosing the driver package, fixing a missing-module or TypeScript setup error, declaring the dependency in a library. **Look elsewhere when:** configuring a client (pool size, timeouts, sessions) → [Database Clients](./database-clients.md); writing the first entities and queries → [Getting Started](./getting-started.md)
> **Key APIs:** `PgClient`, `PostgresClient`, `BunClient`, `PGliteClient`, `createInMemoryDatabase()`

## Install the core package

```bash
npm install linkgress-orm
```

- Current version: 1.0.31. The package ships CommonJS (`dist/index.js`, ES2020) with type
  declarations; `package.json` requires Node.js 16 or later. It also runs under Bun.
- No database driver is a hard dependency. `pg`, `postgres` and `@electric-sql/pglite` are optional
  peer dependencies (`^8.0.0`, `^3.0.0`, `^0.5.0`): install the one whose client you construct.
- A client loads its driver with `require()` when it is constructed, not when `linkgress-orm` is
  imported, so an uninstalled driver only fails if you construct its client.
- The in-memory PostgreSQL-compatible engine is part of the package and is loaded on the first call
  of `createInMemoryDatabase()`, `restoreInMemoryDatabase()` or `startInMemoryDatabaseThread()`.
- No decorators, `reflect-metadata` or code generation step: entities are plain classes mapped in code.

## Pick a driver

| Need | Install | Client | Avoid when |
|---|---|---|---|
| A Node.js server, general purpose; `pg` already in the stack | `pg` | `PgClient` | you need `.withTimeout()`, named prepared statements or one-round-trip multi-statement execution |
| Per-query timeouts (`QueryTimeoutError`), named server-side prepared statements, several statements in one round trip | `postgres` | `PostgresClient` | you rely on postgres.js `transform` options (they break result mapping) |
| The Bun runtime | nothing (`Bun.SQL` is built in) | `BunClient` | the process runs on Node.js (the constructor throws) |
| No server: tests that need real PostgreSQL 18 semantics, CLIs, local-first apps | `@electric-sql/pglite` | `PGliteClient` | concurrent server workloads (one session), statement timeouts |
| Fast isolated tests and runnable examples, many sessions, no server | `pg` or `postgres` | `createInMemoryDatabase()` + `PgClient` / `PostgresClient` | timing, `EXPLAIN` costs or server-only checks matter |

The capability differences behind this table (timeouts, prepared statements, `querySimple()`,
parameter limits, sessions) are listed in [Database Clients](./database-clients.md).

## Install commands per driver

```bash
# node-postgres
npm install linkgress-orm pg

# postgres.js (ships its own types)
npm install linkgress-orm postgres

# Bun: no driver package
bun add linkgress-orm

# PGlite: PostgreSQL compiled to WebAssembly, in-process
npm install linkgress-orm @electric-sql/pglite

# In-memory database for tests: the engine is in linkgress-orm, the driver is pg or postgres
npm install --save-dev pg
```

`@types/pg` is needed only when your own code imports `pg` (for example to build a `Pool` yourself):
the options of `PgClient` are typed by linkgress-orm's exported `PoolConfig`.

## Construct the client

One line per driver; everything after it (the context, the queries) is the same.

```ts
import { PgClient } from 'linkgress-orm';

const client = new PgClient({ connectionString: process.env.DATABASE_URL });
const db = new AppDatabase(client);   // AppDatabase: your DbContext subclass
```

```ts
import { PostgresClient } from 'linkgress-orm';

const client = new PostgresClient(process.env.DATABASE_URL!);
```

```ts
import { BunClient } from 'linkgress-orm';

const client = new BunClient(process.env.DATABASE_URL!);   // Bun runtime only
```

```ts
import { PGliteClient } from 'linkgress-orm';

const inMemory = new PGliteClient();              // gone when the process exits
const persisted = new PGliteClient('./pgdata');   // a data directory
```

The string is PGlite's `dataDir`: a directory path, `idb://<name>` (IndexedDB, in a browser) or
`memory://` (the default).

```ts
import { createInMemoryDatabase, PgClient } from 'linkgress-orm';

const memory = createInMemoryDatabase();
const client = new PgClient(memory.pgPoolConfig());
```

Options of each constructor (pool size, timeouts, SSL, extensions):
[Database Clients](./database-clients.md).

## Verify the installation

A complete program: one entity, one context, the schema, one insert, one read. Run it with
`DATABASE_URL` set (`bun verify.ts`, or compile with `tsc` and run with `node`).

```ts
import { DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, PgClient, varchar } from 'linkgress-orm';

class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
}

class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
    });
  }
}

async function main() {
  const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));
  try {
    await db.getSchemaManager().ensureCreated();
    const { id } = await db.users.insert({ username: 'john_doe' }).returning(u => ({ id: u.id }));
    console.log(await db.users.where(u => eq(u.id, id)).firstOrDefault());   // { id: 1, username: 'john_doe' }
  } finally {
    await db.dispose();   // closes the pool so the process can exit
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL,
  PRIMARY KEY ("id")
)

INSERT INTO "users" ("username") VALUES ($1) RETURNING "id" AS "id"
-- params: ["john_doe"]

SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [1]
```

3 statements, 3 round trips. On a second run the `CREATE TABLE IF NOT EXISTS` changes nothing and
the insert adds `id` 2.

## Declare the dependency in a library

A library built on linkgress-orm should leave the driver choice to the application, as
linkgress-orm itself does:

```json
{
  "dependencies": {
    "linkgress-orm": "^1.0.31"
  },
  "peerDependencies": {
    "@electric-sql/pglite": "^0.5.0",
    "pg": "^8.0.0",
    "postgres": "^3.0.0"
  },
  "peerDependenciesMeta": {
    "@electric-sql/pglite": { "optional": true },
    "pg": { "optional": true },
    "postgres": { "optional": true }
  }
}
```

`PostgresClient.connect()` pins one session only with postgres 3.4 or later (`sql.reserve()`); on
older 3.x versions it falls back to the shared pool without that guarantee. Require `^3.4.0` if your
code uses `connect()` for session state (temp tables, `SET`, advisory locks).

To work on linkgress-orm itself (its test suite, its devDependencies), see
[CONTRIBUTING.md](https://github.com/brunolau/linkgress-orm/blob/main/CONTRIBUTING.md).

## TypeScript settings

- The examples in these docs compile with `"strict": true`. Navigations and collections are declared
  optional (`posts?: Post[]`), so query lambdas dereference them with `!` (`u.posts!.count()`).
- A default import of postgres.js (`import postgres from 'postgres'`; its typings use `export =`)
  needs `"esModuleInterop": true` (or `allowSyntheticDefaultImports`, which
  `"moduleResolution": "bundler"` turns on); with `"module": "commonjs"` and neither, TypeScript
  reports TS1259.
- The repository itself compiles with `"moduleResolution": "node"` and `"esModuleInterop": true`.
- Client option types are exported: `PoolConfig` (`PgClient`), `PostgresOptions` (`PostgresClient`),
  `BunSqlOptions` (`BunClient`), `PGliteClientOptions` (`PGliteClient`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `PgClient requires the "pg" package to be installed. Install it with: npm install pg` | `pg` is missing; thrown by the constructor | `npm install pg` |
| `PostgresClient requires the "postgres" package to be installed. Install it with: npm install postgres` | `postgres` is missing | `npm install postgres` |
| `PGliteClient requires the "@electric-sql/pglite" package to be installed. Install it with: npm install @electric-sql/pglite` | `@electric-sql/pglite` is missing | `npm install @electric-sql/pglite` |
| `BunClient requires Bun runtime with SQL support. This client only works when running under Bun. …` | `BunClient` constructed under Node.js | run under Bun, or use `PgClient` / `PostgresClient` |
| `Cannot find module 'pg'` from `memory.createPgPool()` / `'postgres'` from `memory.createPostgresSql()` | these helpers `require()` the driver | install that driver |
| TS7016 `Could not find a declaration file for module 'pg'` on your own `import { Pool } from 'pg'` | `pg` ships no types | `npm install --save-dev @types/pg` |
| TS1259 on `import postgres from 'postgres'` | neither `esModuleInterop` nor `allowSyntheticDefaultImports` is on | set `"esModuleInterop": true` |
| TS18048 `'u.posts' is possibly 'undefined'` | optional collection under `strict` | write `u.posts!` |
| PGlite fails to load its WebAssembly under Jest | PGlite loads its WASM through dynamic `import()` | run Node.js with `--experimental-vm-modules` (Bun needs nothing) |

## Pitfalls

- **Don't** write `import postgres from 'postgres'` with neither `esModuleInterop` nor `allowSyntheticDefaultImports`
  → **Do** set `"esModuleInterop": true`: postgres.js types use `export =`, and TypeScript reports TS1259.
- **Don't** construct `BunClient` in a process that runs on Node.js → **Do** use `PgClient` or `PostgresClient`
  there: the constructor throws `BunClient requires Bun runtime with SQL support. …`.
- **Don't** rely on `PostgresClient.connect()` pinning one session with postgres below 3.4 → **Do** require
  `postgres@^3.4.0` when code keeps session state on a lease (temp tables, `SET`, advisory locks): older 3.x versions
  fall back to the shared pool without that guarantee.
- **Don't** make a driver a hard dependency of a library built on linkgress-orm → **Do** declare `pg`, `postgres` and
  `@electric-sql/pglite` as optional peer dependencies, as linkgress-orm does: the application picks the driver.
- **Don't** pass a postgres.js `transform` option to the instance a `PostgresClient` uses → **Do** leave column
  transforms off: they rename result columns before linkgress reads them (with `column: c => c.toLowerCase()` a
  two-field projection returned `[{}]`; [Database Clients](./database-clients.md#do-not-use-postgresjs-transform)).
- **Don't** end a script without `await db.dispose()` → **Do** call it once at shutdown: it closes the pool the client
  created, so the process can exit.

## See also

- [Getting Started](./getting-started.md) — from install to the first typed query.
- [Database Clients](./database-clients.md) — every client's options, capabilities, sessions, transactions and lifecycle.
- [In-Memory Database](./guides/in-memory-database.md) — the bundled engine for tests: snapshots, TCP, worker threads.
- [Schema Configuration](./guides/schema-configuration.md) — entities, columns, relations and indexes.
