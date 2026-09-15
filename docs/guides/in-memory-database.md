# In-Memory Database

Linkgress ships an in-memory, PostgreSQL-compatible database for fast, isolated tests. It is not a
mock: it parses, analyzes and executes the SQL Linkgress (or your own code) sends, following
PostgreSQL 18 semantics — type resolution and coercion, NULL handling, MVCC visibility and
transactions, constraints and error codes, `pg_catalog` / `information_schema` views, and the text
format of every value. A query returns the same rows, types and errors PostgreSQL would.

Connections are made with the **real** `pg` or `postgres` driver over an in-process socket that
speaks the PostgreSQL wire protocol. Everything above the socket — your driver configuration, custom
type parsers, prepared statements, transactions — runs unchanged.

## Quick start

```typescript
import { createInMemoryDatabase, PgClient, PostgresClient } from 'linkgress-orm';
import postgres from 'postgres';

const memory = createInMemoryDatabase();

// node-postgres
const pgClient = new PgClient(memory.pgPoolConfig());

// postgres.js — pass your usual options; only the socket is replaced
const sql = postgres(memory.postgresOptions({ max: 5, types: { /* ... */ } }));
const postgresClient = new PostgresClient(sql);

const db = new AppDatabase(pgClient);
await db.getSchemaManager().ensureCreated();
```

Every client, pool and connection created from the same `InMemoryDatabase` sees the same data, with
the isolation PostgreSQL provides between sessions (READ COMMITTED / REPEATABLE READ, row locks,
`SKIP LOCKED`, advisory locks, deadlock detection).

## Options

```typescript
createInMemoryDatabase({
  databaseName: 'app_test',    // current_database(); default "postgres"
  userName: 'postgres',        // current_user; default "postgres"
  timeZone: 'Europe/Budapest', // session TimeZone default; default: the process' zone
  collation: 'en-US',          // default text collation: a BCP 47 locale, or "C" for bytewise
  settings: { statement_timeout: '5000' }, // database-level GUC defaults
});
```

## Snapshots

Building a schema and seeding data once, then starting every test (or worker) from that state:

```typescript
const template = createInMemoryDatabase();
await migrateAndSeed(template);
const bytes = template.snapshot();              // Buffer — can be written to disk

const perTest = restoreInMemoryDatabase(bytes);  // from 'linkgress-orm'
const copy = template.fork();                   // same, in one step
```

A snapshot holds the committed state: schema, rows (in physical order), sequences and object ids.
Temporary tables and uncommitted work are not included.

## Other processes: a TCP endpoint

A test that starts another process — `psql -f script.sql`, a child server reading `DATABASE_URL` —
can reach the same database over TCP. Any password is accepted; the loopback interface is used unless
`host` says otherwise.

```typescript
const listener = await memory.listen();            // { host, port, connectionString(), close() }
spawn('psql', ['-d', listener.connectionString(), '-f', 'backfill.sql']);
```

`InMemoryDatabase.listenLazy(() => db)` opens the endpoint before the database exists (it is created
on the first connection).

## Running in a worker thread

`InMemoryDatabaseThread` hosts the database in its own worker thread, like a server process. Queries
then run in parallel with your code, and the database keeps answering while your thread is blocked —
for example in `child_process.spawnSync` running `psql` against the thread's TCP endpoint:

```typescript
import { startInMemoryDatabaseThread } from 'linkgress-orm';

const server = startInMemoryDatabaseThread({ snapshotPath: 'seeded.snapshot', listen: true });
const sql = postgres(server.postgresOptions({ max: 5 }));      // in-process sockets to the thread
spawnSync('psql', ['-d', `postgresql://postgres@127.0.0.1:${server.listener!.port}/postgres`, '-c', 'select 1']);
const bytes = await server.snapshot();
await server.terminate();
```

The endpoint is known when `start` returns, so it can be put into the environment before test modules
load.

Like a server, a thread can host a database per connection `database` name
(`databasePerName: { aliases: [{ pattern: '-test(-w\\d+)?$', name: 'app_test' }] }`): each distinct
name — after the first matching alias — is its own database, created from the snapshot on its first
connection, and `current_database()` reports the name the connection used. The thread entry is compiled JavaScript (`dist`); from TypeScript sources Bun runs it
directly and Node loads it through `ts-node`.

The wire protocol covers text and binary formats: results a client requests in binary (Bind result-format
codes, as Bun's SQL client does) and binary bind parameters use PostgreSQL's send / receive formats for
the built-in types, arrays, composites, domains and enums.

## Running a test suite in memory

Because the in-memory database is reached through the drivers, an existing suite can switch without
touching test code — point `pg` / `postgres` at small wrappers that add the in-memory socket. Under Bun
that is `mock.module()` in a test preload; with Jest, `moduleNameMapper`. This repository's own suite
does exactly that (`tests/setup.ts`, `tests/memory/`):

```bash
npm test              # the suite against PostgreSQL
npm run test:memory   # the same files against the in-memory database
npm run test:parity   # both, failing on any difference in test or file outcomes
npm run test:pglite   # the same files on PGlite (see below)
```

`tests/memory/sql-parity.test.ts` additionally runs a corpus of SQL statements against PostgreSQL and a
fresh in-memory database and requires identical command tags, row counts, column types, rows and errors.

## PGlite, the other in-process option

Linkgress also runs on [PGlite](https://pglite.dev) — PostgreSQL itself compiled to WebAssembly —
through a client of its own, `PGliteClient` (see
[Database Clients](../database-clients.md#3-pgliteclient-pglite)). The two differ in what they are and
how they are reached:

| | in-memory database | PGlite |
| --- | --- | --- |
| engine | PostgreSQL-compatible, written in TypeScript | PostgreSQL 18, compiled to WebAssembly |
| reached through | the real `pg` / `postgres` drivers, over an in-process socket | `PGliteClient`, a `DatabaseClient` of its own |
| sessions | many, with PostgreSQL's isolation, row locks and deadlock detection | one; statements run one at a time |
| runs | in process, in a worker thread, or behind a TCP endpoint | in process: Node, Bun, Deno, browsers |
| this repository's suite | `npm run test:memory` — 12.7 s, 12 files in parallel | `npm run test:pglite` — 21.0 s, 8 files in parallel |

Both give every test file its own database, so a suite can run files in parallel; on the same machine
the suite takes about 145 s serially against a PostgreSQL server. Measurements (on the earlier Jest
suite) and every difference found: [bench/pglite/README.md](../../bench/pglite/README.md).

## Scope and differences

- Row order without `ORDER BY` follows PostgreSQL's sequential-scan and sort behaviour, but plans are
  not PostgreSQL's planner: when PostgreSQL would pick a hash or merge strategy, the order of an
  unordered result can differ. Tests should not depend on unordered results — against PostgreSQL
  they are not guaranteed either.
- There is no cost-based planner. `EXPLAIN` describes the plan PostgreSQL typically chooses — index,
  bitmap (including `BitmapOr`) and sequential scans, hash / nested-loop / semi / anti joins, join
  removal, sort / aggregate / limit nodes, with PostgreSQL's condition formatting — which is what tests
  asserting "the query uses index X" inspect. Costs and row counts are not reported.
- Procedures (`CALL`, `INOUT` / `OUT` parameters) may `COMMIT` / `ROLLBACK` when called outside a
  transaction block, as in PostgreSQL. `RAISE NOTICE` / `WARNING` and server warnings are sent to the
  client as notices (subject to `client_min_messages`).
- Rows are stored in insertion order; PostgreSQL's physical order additionally depends on page space
  reuse and (auto)vacuum timing, so an unordered read of a table that was updated and vacuumed can
  return rows in a different order.
- Errors carry PostgreSQL's SQLSTATE, message, detail, hint and — for syntax and analysis errors —
  position; `tests/memory/sql-parity.test.ts` holds a corpus of statements to that standard.
- Not implemented (an error is raised instead): `COPY`, `EXCLUDE` constraints, `MERGE` into a view,
  `INSTEAD OF` triggers, `SELECT … INTO`.
- Supported extensions: `pg_trgm`, `unaccent`, `uuid-ossp`, `pgcrypto` (UUID generation).
- Object ids, backend pids and temp schema names are allocated by the in-memory database and
  differ from any particular server.
