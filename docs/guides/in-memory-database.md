# In-Memory Database

> **For agents:** How do I run code and tests against an in-process, PostgreSQL-compatible database without a server, and where does it behave differently from PostgreSQL?
> **Use this page when:** writing tests or runnable examples without a server, seeding once and restoring per test or worker, serving the database to another process or to `Bun.SQL`, switching an existing suite to memory, judging whether a result found in memory holds on PostgreSQL. **Look elsewhere when:** real PostgreSQL inside the process (WebAssembly) → [PGliteClient](../database-clients.md#pgliteclient-pglite); driver options, sessions and transactions → [Database Clients](../database-clients.md)
> **Key APIs:** `createInMemoryDatabase()`, `pgPoolConfig()`, `createPostgresSql()`, `postgresOptions()`, `snapshot()`, `restoreInMemoryDatabase()`, `fork()`, `listen()`, `startInMemoryDatabaseThread()`

linkgress-orm ships an in-memory database written in TypeScript. It is not a mock: it parses,
analyzes and executes the SQL linkgress (or your own code) sends, following PostgreSQL 18 semantics:
type resolution and coercion, NULL handling, MVCC visibility and transactions, constraints and error
codes (SQLSTATE, message, detail, hint), `pg_catalog` / `information_schema` views, and the text form
of every value. `SELECT version()` reports `PostgreSQL 18.3 (linkgress in-memory engine)`.

Connections are made with the **real** `pg` or `postgres` driver over an in-process socket that
speaks the PostgreSQL wire protocol. Everything above the socket (driver configuration, type parsers,
prepared statements, transactions) runs unchanged. The protocol covers the text and the binary
formats: results a client requests in binary (as Bun's SQL client does) and binary bind parameters
use PostgreSQL's send / receive formats for the built-in types, arrays, composites, domains and enums.
Every SQL example in these docs was captured on it.

## Contents

- [Choose an in-process database](#choose-an-in-process-database)
- [Start a database and connect a context](#start-a-database-and-connect-a-context)
- [Connection helpers](#connection-helpers)
- [Set the database name, user, time zone, collation and settings](#set-the-database-name-user-time-zone-collation-and-settings)
- [Start every test from a seeded state: `snapshot()`, `restoreInMemoryDatabase()`, `fork()`](#start-every-test-from-a-seeded-state-snapshot-restoreinmemorydatabase-fork)
- [Serve other processes over TCP: `listen()`](#serve-other-processes-over-tcp-listen)
- [Run the database in a worker thread: `startInMemoryDatabaseThread()`](#run-the-database-in-a-worker-thread-startinmemorydatabasethread)
- [Switch an existing test suite to memory](#switch-an-existing-test-suite-to-memory)
- [Timeouts and waits](#timeouts-and-waits)
- [How fast it is](#how-fast-it-is)
- [Scope and differences](#scope-and-differences)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose an in-process database

| Need | Use | Why | Avoid |
|---|---|---|---|
| Fast, isolated tests; many sessions with real isolation; runnable examples | `createInMemoryDatabase()` + `PgClient` / `PostgresClient` | in-process, real drivers, snapshot per test | timing, `EXPLAIN` costs, statement cancellation of running work |
| PostgreSQL's own behaviour without a server (IMMUTABLE checks, catalog text, planner) | `PGliteClient` | PostgreSQL 18 compiled to WebAssembly | concurrent sessions (PGlite has one) |
| Production behaviour, plans, timings | a PostgreSQL server | the real thing | – |

| | in-memory database | PGlite |
|---|---|---|
| Engine | PostgreSQL-compatible, written in TypeScript | PostgreSQL 18, compiled to WebAssembly |
| Reached through | the real `pg` / `postgres` drivers over an in-process socket; `BunClient` over TCP | `PGliteClient`, a `DatabaseClient` of its own |
| Sessions | many, with PostgreSQL's isolation, row locks and deadlock detection | one; statements run one at a time |
| Runs | in the process, in a worker thread, or behind a TCP endpoint | in the process: Node.js, Bun, Deno, browsers |
| This repository's suite | `npm run test:memory`: 13.8–14.1 s, 12 files in parallel | `npm run test:pglite`: 21.0 s, 8 files in parallel |

Both give every test file a database of its own, so a suite runs files in parallel. On the same
machine the suite took 112–125 s serially on a PostgreSQL server and 52.3–53.4 s with 6 PostgreSQL
worker databases ([bench/in-memory](https://github.com/brunolau/linkgress-orm/blob/main/bench/in-memory/README.md); PGlite:
[bench/pglite](https://github.com/brunolau/linkgress-orm/blob/main/bench/pglite/README.md), which also lists every difference found between PGlite
and a server).

## Start a database and connect a context

`createInMemoryDatabase()` creates an empty database. Connect a context through either driver; every
client, pool and connection created from the same database sees the same data.

```ts
import { createInMemoryDatabase, PgClient, PostgresClient } from 'linkgress-orm';

const memory = createInMemoryDatabase();

const db = new AppDatabase(new PgClient(memory.pgPoolConfig()));          // node-postgres
await db.getSchemaManager().ensureCreated();

const viaPostgres = new AppDatabase(new PostgresClient(memory.createPostgresSql({ max: 5 })));   // postgres.js
```

Observed: a user inserted through `db` is read back through `viaPostgres`
(`[{ username: 'alice' }]`).

- Sessions are isolated as in PostgreSQL (READ COMMITTED / REPEATABLE READ, row locks, `SKIP LOCKED`,
  advisory locks, deadlock detection). Observed: a second session counted 1 row while the first held an
  uncommitted insert. Serialization failures (`40001`) are not modelled: see
  [Scope and differences](#transactions-locks-and-constraints).
- `memory.close()` terminates every open session: it rolls back the session's open transaction and
  drops its temporary tables. It does not disconnect the drivers: after it, a held connection still
  answered `SELECT 1` and a pool opened a new session. Close the clients (`db.dispose()`) first.
- The engine is loaded on the first `createInMemoryDatabase()`, `restoreInMemoryDatabase()` or
  `startInMemoryDatabaseThread()` call.

To keep your own postgres.js options (custom `types`, `max`), let the database supply only the socket:

```ts
import postgres from 'postgres';

const sql = postgres(memory.postgresOptions({ max: 5, types: {} }));
const viaOwnSql = new AppDatabase(new PostgresClient(sql));
```

## Connection helpers

| Method | Returns | Use |
|---|---|---|
| `pgPoolConfig(config?)` | your `pg` config plus `stream` (and `host`, `port`, `user`, `database` defaults) | `new PgClient(memory.pgPoolConfig({ max: 5 }))` |
| `createPgPool(config?)` | a `pg.Pool` (requires `pg`) | `new PgClient(memory.createPgPool())` |
| `postgresOptions(options?)` | your postgres.js options plus `socket`, `ssl: false` | `postgres(memory.postgresOptions({ … }))` |
| `createPostgresSql(options?)` | a postgres.js `sql` instance (requires `postgres`) | `new PostgresClient(memory.createPostgresSql())` |
| `createSocket()` | one `MemorySocket` (a duplex stream) | a driver that accepts a custom socket |
| `listen({ port?, host? })` | a `Promise` of `{ host, port, connectionString(database?), close() }` | `psql`, child processes, `BunClient` |
| `snapshot()` / `fork(options?)` | a `Buffer` / an independent copy | seeded starts, see below |
| `close()` | `void` | terminate every open session (roll back, drop temp tables); connections stay open |

`createPgPool()` and `createPostgresSql()` are typed `unknown`: pass them straight to the client
constructor. A connection that names another `database` keeps working on the same data, and
`current_database()` reports the name it asked for.

```ts
const viaPool = new PgClient(memory.createPgPool({ max: 5 }));
const viaSql = new PostgresClient(memory.createPostgresSql({ max: 5 }));
```

## Set the database name, user, time zone, collation and settings

```ts
// fragment
createInMemoryDatabase({
  databaseName: 'app_test',                  // current_database(); default 'postgres'
  userName: 'postgres',                      // current_user; default 'postgres'
  timeZone: 'UTC',                           // session TimeZone; default: the process's zone
  collation: 'C',                            // 'C' = bytewise; a BCP 47 locale otherwise; default 'en-US'
  settings: { statement_timeout: '5000' },   // database-level setting defaults (name → value)
});
```

Observed with these options: `current_database()` = `app_test`, `SHOW TimeZone` = `UTC`,
`SHOW statement_timeout` = `5s`, and `ORDER BY` puts `'B'` before `'a'` (collation `C`). With the
defaults: `postgres`, the process's zone, and `a`, `b`, `B` (`en-US`).

## Start every test from a seeded state: `snapshot()`, `restoreInMemoryDatabase()`, `fork()`

Build the schema and seed data once, then start every test (or worker) from that committed state
instead of running the DDL and the inserts again.

```ts
import { createInMemoryDatabase, PgClient, restoreInMemoryDatabase } from 'linkgress-orm';

const template = createInMemoryDatabase();
const seeded = new AppDatabase(new PgClient(template.pgPoolConfig()));
await seeded.getSchemaManager().ensureCreated();
await seeded.users.insert({ username: 'alice', email: 'alice@example.com' });

const bytes = template.snapshot();                 // Buffer; can be written to disk
const perTest = restoreInMemoryDatabase(bytes);    // an independent database
const copy = template.fork();                      // snapshot + restore in one call
```

Observed with the two-table `User` / `Post` context of [Getting Started](../getting-started.md), after
one more insert into `template`: `template` 2 users, `perTest` 1, `copy` 1; the snapshot (two tables,
one row) was 9 245 bytes.

- A snapshot holds the committed state: schema, rows (in physical order), sequences and object ids.
  Temporary tables and uncommitted work are not included.
- It keeps the database's options; `restoreInMemoryDatabase(bytes, options)` and `fork(options)`
  override them (for example `{ databaseName: 'worker_1' }`).
- `InMemoryDatabase` is exported as a type only: use `restoreInMemoryDatabase()`, not
  `InMemoryDatabase.fromSnapshot()`.
- Measured for the 23-table example model: 2.7 ms to snapshot (77 KB), 2.9 ms from restore to a first
  result, against 43 ms to build the schema ([bench/in-memory](https://github.com/brunolau/linkgress-orm/blob/main/bench/in-memory/README.md)).

```ts
import { readFileSync, writeFileSync } from 'node:fs';

writeFileSync('seeded.snapshot', template.snapshot());
const restored = restoreInMemoryDatabase(readFileSync('seeded.snapshot'), { databaseName: 'worker_1' });
```

## Serve other processes over TCP: `listen()`

A test that starts another process (`psql -f script.sql`, a child server reading `DATABASE_URL`), or a
client without a custom-socket option (`Bun.SQL`), reaches the same database over TCP.

```ts
import { BunClient } from 'linkgress-orm';

const listener = await memory.listen();                      // loopback, a free port
const overTcp = new AppDatabase(new BunClient(listener.connectionString()));
// listener.connectionString() → 'postgresql://postgres@127.0.0.1:<port>/postgres'
```

```ts
import { spawn } from 'node:child_process';

const child = spawn('psql', ['-d', listener.connectionString(), '-f', 'backfill.sql']);
child.on('exit', () => void listener.close());
```

- Any password is accepted. The loopback interface is used unless `host` says otherwise; `port: 0`
  (the default) picks a free port.
- `connectionString(database?)` names another database in the URL; the data is the same.
- The server does not keep the process alive (it is `unref()`ed). `close()` stops accepting and
  closes the open connections.
- Each statement then takes a loopback TCP round trip instead of an in-process call.

## Run the database in a worker thread: `startInMemoryDatabaseThread()`

The thread form hosts the database in its own worker thread, like a server process: queries run in
parallel with your code, and the database keeps answering while your thread is blocked, for example
in `child_process.spawnSync` running `psql` against the thread's TCP endpoint.

```ts
import { spawnSync } from 'node:child_process';
import { PgClient, startInMemoryDatabaseThread } from 'linkgress-orm';

const server = startInMemoryDatabaseThread({ snapshotPath: 'seeded.snapshot', listen: true });
const db = new AppDatabase(new PgClient(server.pgPoolConfig()));   // in-process sockets to the thread
spawnSync('psql', ['-d', `postgresql://postgres@127.0.0.1:${server.listener!.port}/postgres`, '-c', 'select 1']);
const bytes = await server.snapshot();
await db.dispose();
await server.terminate();
```

| Option | Meaning |
|---|---|
| `snapshot` | snapshot bytes to restore |
| `snapshotPath` | a snapshot file, read in the thread on the first connection (a missing file means an empty database) |
| `database` | `InMemoryDatabaseOptions` for a new or restored database |
| `listen` | `true` or `{ port, host }`: also serve over TCP; the endpoint is known when the call returns |
| `databasePerName` | host a database per connection `database` name, see below |

- With `listen`, the call blocks (`Atomics.wait`, up to 60 s) until the TCP endpoint is open, so the
  endpoint can go into the environment before test modules load. With `snapshotPath`, the endpoint is
  open before the database exists: the thread restores the file on the first connection.
- The thread object offers `pgPoolConfig()`, `postgresOptions()`, `createSocket()`,
  `snapshot(database?)`, `stats()` (keys `heapUsedMB` and `database`; with `databasePerName`, one key
  per hosted database name) and `terminate()`.
- Like a server, a thread can host a database per connection `database` name:
  `databasePerName: { aliases: [{ pattern: '-test(-w\\d+)?$', name: 'app_test' }] }`. Each distinct
  name, after the first matching alias, is its own database, created from the snapshot on its first
  connection, and `current_database()` reports the name the connection used. Observed with that
  alias: `shop-test-w1` and `shop-test-w2` shared one database (`app_test`), `other` got its own.
- The thread entry is compiled JavaScript (`dist`); from TypeScript sources Bun runs it directly and
  Node.js loads it through `ts-node`.
- The worker thread adds a message-channel hop per round trip (about 0.05 ms): slower than in-process
  for short statements ([bench/in-memory](https://github.com/brunolau/linkgress-orm/blob/main/bench/in-memory/README.md)).

## Switch an existing test suite to memory

Because the database is reached through the drivers, an existing suite switches without touching
test code: point `pg` (and `postgres`) at wrappers that add the in-memory socket. Under Bun that is
`mock.module()` in a test preload; with Jest, `moduleNameMapper`.

```ts
// test-preload.ts — run with: bun test --preload ./test-preload.ts
import { mock } from 'bun:test';
import { createInMemoryDatabase } from 'linkgress-orm';

const memory = createInMemoryDatabase({ databaseName: 'app_test' });
const realPg = require('pg');

class Client extends realPg.Client {
  constructor(config?: object) {
    super(memory.pgPoolConfig({ ...config }));
  }
}

class Pool extends realPg.Pool {
  constructor(config?: object) {
    super({ ...memory.pgPoolConfig({ ...config }), Client });
  }
}

// require.resolve(): a bare 'pg' would not replace a module another file already loaded
mock.module(require.resolve('pg'), () => ({ ...realPg, Client, Pool, default: { ...realPg, Client, Pool } }));
```

Observed with this preload: a `PgClient` configured for `db.example.invalid` ran its query on the
in-memory database (`version()` = `PostgreSQL 18.3 (linkgress in-memory engine)`).

This repository's own suite does the same (`tests/setup.ts`, `tests/memory/`):

```bash
npm test              # the suite against PostgreSQL
npm run test:memory   # the same files against the in-memory database
npm run test:parity   # both, failing on any difference in test or file outcomes
npm run test:pglite   # the same files on PGlite
```

[tests/memory/sql-parity.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/memory/sql-parity.test.ts) also runs a corpus of SQL
statements against PostgreSQL and a fresh in-memory database and requires identical command tags, row
counts, column types, rows and errors.

## Timeouts and waits

A statement executes without interruption once it runs; `statement_timeout` applies to the time it
spends waiting: for a row lock or a transaction another session holds, in `pg_sleep()`, at a deferred
constraint check at `COMMIT`.

| Observed | Result |
|---|---|
| `SET statement_timeout = 100`, then `SELECT pg_sleep(1)` | `57014 canceling statement due to statement timeout` |
| session B updates a row session A holds `FOR UPDATE`, B's `statement_timeout = 200` | `57014` after about 200 ms |
| `PostgresClient` query with `timeoutMs: 100` running `pg_sleep(1)` | `QueryTimeoutError`: `Query exceeded its timeout of 100ms and was cancelled` |
| postgres.js `query.cancel()` 100 ms into `pg_sleep(2)` | `57014 canceling statement due to user request` after about 100 ms |
| `pg_cancel_backend(<pid>)` against a session in `pg_sleep(2)` | returns `true`; the sleep runs its 2 s |

A driver's cancel request (the protocol's CancelRequest, such as postgres.js `query.cancel()`)
interrupts a wait the same way. `pg_cancel_backend()` and `pg_terminate_backend()` are stubs that
return `true` and do nothing: cancel through the driver. A long computation (a large sort, an
expensive function over many rows) runs to its end: neither `statement_timeout` nor a cancel request
stops it (a 311 ms `count(*)` over 2 000 000 rows completed under `statement_timeout = 50`). Test the
cancellation of CPU-bound statements on a PostgreSQL server; PGlite enforces no timeout at all.

## How fast it is

Per operation, the same `PgClient` and statements, warm ([bench/in-memory](https://github.com/brunolau/linkgress-orm/blob/main/bench/in-memory/README.md)):

| Operation | PostgreSQL (localhost TCP) | in memory | in a worker thread |
|---|---|---|---|
| `SELECT $1` | 0.076 ms | 0.038 ms | 0.091 ms |
| `INSERT` one row, autocommit | 0.165 ms | 0.041 ms | 0.106 ms |
| Per-test reset: `TRUNCATE` 22 tables + seed | 70.36 ms | 1.96 ms | 3.44 ms |
| ORM read: users with their posts (CTE, `json_agg`) | 0.251 ms | 0.280 ms | 0.362 ms |
| DDL: `CREATE TABLE` + `CREATE INDEX` + `DROP TABLE` | 5.04 ms | 0.54 ms | 0.78 ms |

Writes and DDL are 4–10× cheaper and the per-test reset 36× cheaper (no WAL, no fsync, no files);
complex reads are on par, because the engine executes in TypeScript where PostgreSQL's executor is
native C. Creating a database takes 46 ms (the built-in catalog). Timings measured in memory say
nothing about PostgreSQL.

## Scope and differences

Everything below was written by the engine's authors or observed while writing these docs. The rule
of thumb: a test that passes in memory may still fail on PostgreSQL where this list says the engine
is more permissive; confirm such cases on PostgreSQL or PGlite.

### INSERT … ON CONFLICT … WHERE: arbiter inference

`INSERT … ON CONFLICT (…) WHERE <predicate>` infers its arbiter like PostgreSQL, for the predicate
forms below. The WHERE is analysed against the target table alone as an index predicate: an unknown
column (42703), another table (42P01), an unknown function or operator (42883), a literal its operand's
type cannot read (22P02, `WHERE k = 'abc'` for an integer `k`), a subquery, an aggregate, a window or
set-returning function are errors, as in PostgreSQL. A PARTIAL unique index is an arbiter only when
that WHERE implies its predicate; else 42P10.

Both are first normalised as PostgreSQL's planner does: a cast of a constant is folded
(`CAST(1 AS smallint)`, `'x'::varchar`, so `literal(v, pgType)` works), `x = true` is `x`, NOT is
pushed down (`NOT (a = b)` is `a <> b`, `NOT (x IS NULL)` is `x IS NOT NULL`, `NOT NOT x` is `x`), and
a constant on the left is commuted to the right (`1 = x` is `x = 1`). Then each conjunct of the index
predicate must be implied by a conjunct of the WHERE: equal to it (`x::text` and an implicit cast
alike), the same comparison with an int2 / int4 / int8 constant of equal value (`st = 1::bigint` for
`st = 1`), or, for `x IS NOT NULL`, any clause strict in `x` (`lower(x) = 'a'`, `x IN ('a', 'b')`,
`x IS DISTINCT FROM NULL`).

An IN list, `= ANY(…)` or `op ALL(…)` over constants is the OR (the AND) of its comparisons, as
PostgreSQL reads it: `x IN ('a', 'b')` is implied by the same values in any order, by a subset of them,
by one of them (`x = 'a'`) and by a one-element array (`x = ANY(ARRAY['a'])`, `'{a}'::text[]`);
`x = 'a'` by `x = ANY(ARRAY['a'])`; `x NOT IN ('a', 'b')` by a superset of its values, also written as
separate conjuncts (`x <> 'a' AND x <> 'b'`); int2 / int4 / int8 values compare by value.

Observed against `CREATE UNIQUE INDEX … (email) WHERE status IN ('active', 'trial')`:
`ON CONFLICT (email) WHERE status IN ('active', 'trial')` and `… WHERE status = 'active'` inferred the
index; `… WHERE status = 'gone'` and `… WHERE status = $1` failed with 42P10.

What PostgreSQL also proves but the engine does not (it answers 42P10 there, never the reverse, so a
test can fail where the server infers the index but cannot pass where the server refuses it):

- OR on either side: reordered arms (`b OR a` for `a OR b`), `a` for an index predicate `a OR b`, and
  `x = 'a' OR x = 'b'` for `x IS NOT NULL` (an IN list over constants is modelled, see above);
- IN lists / `= ANY` / `op ALL` whose array is empty (`x = ANY('{}')` proves anything there), holds a
  NULL (`x IN ('a', NULL)` for `x IN ('a', 'b')`: PostgreSQL proves anything from the NULL comparison),
  is multi-dimensional or longer than 100 elements, and a boolean list for a bare boolean column
  (`active = ANY(ARRAY[true])` for an index predicate `active`);
- range proofs: `amount > 5` (or `>= 1`, `= 5`) for `amount > 0`, and between the values of a list
  (`x = 'a'` for `x NOT IN ('b', 'c')`, `n IN (1, 2)` for `n < 5`);
- constant folding beyond a cast of a constant: `0 + 0`, `'act' || 'ive'`, `ARRAY[1]` for `'{1}'`,
  `'1'::text::int`, and implicit casts of constants to float / numeric (`f = 1.0` for `f = 1`);
- cross-type proofs other than int2 / int4 / int8 (`d = '…'::timestamp` for a date `d = '…'`), and a
  comparison with an explicit `COLLATE` matching the column's own collation (`status = 'a' COLLATE
  "default"` for `status = 'a'`: PostgreSQL proves it, the engine never equates a comparison carrying
  an explicit collation with one that does not).

A bound parameter in that WHERE proves nothing, as in a PostgreSQL GENERIC plan (a prepared statement
after its fifth execution): the engine refuses from the first execution what a server would refuse
only once its plan turns generic.

### Planner, EXPLAIN and row order

- Row order without `ORDER BY` follows PostgreSQL's sequential-scan and sort behaviour, but plans are
  not PostgreSQL's planner: when PostgreSQL would pick a hash or merge strategy, the order of an
  unordered result can differ. Tests should not depend on unordered results; against PostgreSQL they
  are not guaranteed either.
- Rows are stored in insertion order; PostgreSQL's physical order also depends on page space reuse
  and (auto)vacuum timing, so an unordered read of a table that was updated and vacuumed can return
  rows in a different order.
- There is no cost-based planner. `EXPLAIN` describes the plan PostgreSQL typically chooses (index,
  bitmap including `BitmapOr`, and sequential scans; hash / nested-loop / semi / anti joins; join
  removal; sort / aggregate / limit nodes) with PostgreSQL's condition formatting, which is what tests
  asserting "the query uses index X" inspect. Costs and row counts are not reported. Observed on a
  freshly created table: `Seq Scan on ni` / `Filter: (id = 1)`.
- A `FULL JOIN` is refused as PostgreSQL's planner refuses it (0A000 "FULL JOIN is only supported with
  merge-joinable or hash-joinable join conditions", since 1.0.29): no equality between the two sides
  and a condition that is neither one nor a constant (`IS NOT DISTINCT FROM`, an inequality, an OR, a
  condition on one side alone, a volatile equality); a WHERE that makes a side non-nullable turns it
  into another join first. The check runs when the join runs: a FULL JOIN in a subquery that never runs
  is not refused (PostgreSQL plans it), one in an unreferenced CTE is not refused on either.

### Aggregates that read only an outer query's columns (refused since 1.0.31)

PostgreSQL evaluates an aggregate in the query of the LOWEST-level columns its aggregated arguments, ORDER BY keys and
FILTER read: in `SELECT u.username, (SELECT sum(u.age) FROM posts p …) FROM users u` the `sum()` reads only `u`, so it
is an aggregate of the OUTER query, grouped and evaluated there. The engine evaluates every aggregate in the query it
is written in and models no outer-level aggregates, so it refuses one (`0A000`). Before 1.0.31 it answered in place,
with another result than PostgreSQL's and no error. On the [example model](../example-model.md):

```ts
import { agg, eq } from 'linkgress-orm';

// sum() reads only u.age, a column of the outer query: refused in memory
await db.users
  .select(u => ({
    username: u.username,
    ageSum: db.posts.where(p => eq(p.userId, u.id)).select(() => agg.sum(u.age)).asSubquery('scalar'),
  }))
  .toList();

// the ORDER BY key p.id is a column of the subquery's own table: an aggregate of its own query, on both engines
const names = await db.users
  .select(u => ({
    username: u.username,
    names: db.posts.where(p => eq(p.userId, u.id)).select(p => agg.arrayAgg(u.username, { orderBy: [[p.id, 'ASC']] })).asSubquery('scalar'),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', names: ['alice', 'alice'] }, { username: 'bob', names: ['bob'] }, { username: 'charlie', names: null }]
```

```sql
SELECT "users"."username" as "username", (SELECT sum("users"."age")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "ageSum"
FROM "users"
-- error: aggregate function sum() reads only columns of an outer query: outer-level aggregates are not supported by the in-memory database

SELECT "users"."username" as "username", (SELECT array_agg("users"."username" ORDER BY "posts"."id" ASC)
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "names"
FROM "users"
ORDER BY "username" ASC
```

- The error carries SQLSTATE `0A000`, the detail `PostgreSQL evaluates such an aggregate in the outer query whose
  columns it reads, not in the subquery it is written in.` and the hint `Make the aggregate read a column of its own
  query — for example join the table it means to read inside that subquery.`
- PostgreSQL 18 (observed on PGlite) answers the first statement with 42803 (`column "users.username" must appear in
  the GROUP BY clause or be used in an aggregate function`), and `SELECT (SELECT sum(u.age) FROM posts p WHERE p.id = 1)
  FROM users u`, which projects no other outer column, with ONE row: the sum over all users (`105`). The engine before
  1.0.31 returned a row per user for both.
- One column of the aggregate's own query among its aggregated arguments, ORDER BY keys or FILTER makes it an aggregate
  of that query, answered as PostgreSQL answers it (each observed identical on both): `array_agg(u.username ORDER BY
  p.id)`, `sum(u.age) FILTER (WHERE p.views > 100)`, `sum(u.age + p.views)`. An aggregate that reads no column
  (`count(*)`, `sum(1)`) and a window aggregate (`sum(u.age) OVER ()`) belong to their own query too.
- Through the ORM the shape comes from an `agg.*` fragment over an outer column in a scalar subquery, as above, and from
  a collection summand that reads nothing of the collection it sums: `u.posts!.sum(_p => u.orders!.count())` is refused
  the same way (PostgreSQL: 42803).

### Transactions, locks and constraints

- Data-modifying CTEs run in the order the main query first reads them (the rest after it), on the
  statement's snapshot.
- A statement that waits for a concurrent transaction at a unique check (an INSERT whose key a running
  transaction inserted) reads, once that transaction has ended, the snapshot it started with:
  committed, the key is a 23505 (or a row `ON CONFLICT DO NOTHING` skips); rolled back, the row is
  inserted, as in PostgreSQL (since 1.0.29). It used to restart with a new snapshot, where an
  `INSERT … SELECT … WHERE NOT EXISTS` saw the committed row and skipped it instead of failing.
- Foreign keys are checked under PostgreSQL's locking rules (since 1.0.30): the check reads the
  referenced row on a snapshot and holds it `FOR KEY SHARE` until its transaction ends. A parent another
  transaction inserted and has not committed is not there: 23503 at once, no wait. A parent another
  transaction deletes, re-keys or holds `FOR UPDATE` makes the check wait, then finds it gone (a
  committed delete or key change: 23503) or there (a rollback, a released lock); a non-key update and
  the weaker row locks do not conflict. The other way round, a delete, a key change (an UPDATE of a
  column of a unique index without predicate or expression locks the row `FOR UPDATE`, any other
  `FOR NO KEY UPDATE`) or `FOR UPDATE` of a row another transaction's check holds waits for that
  transaction; a non-key update does not, and carries the lock on to the new version; and the
  referenced side's check does not see a referencing row another transaction has not committed. A
  `DEFERRABLE` check runs at COMMIT, which waits like a statement. Under REPEATABLE READ a parent whose
  delete or key change committed after the transaction's snapshot is not there either (23503;
  PostgreSQL raises 40001: the engine models no serialization failure). Before 1.0.30 the engine
  waited for an uncommitted parent, wrote a child over a pending delete or key change at once, let
  `FOR UPDATE` take a row a check held, and failed with XX000 a COMMIT whose deferred check had to
  wait.
- Serialization failures are not modelled (observed while writing these docs): under REPEATABLE READ,
  an `UPDATE` of a row that another transaction updated and committed after this transaction's
  snapshot updates nothing (`rowCount` 0) and the transaction commits, where PostgreSQL raises
  `40001 could not serialize access due to concurrent update`. Retry logic for `40001` cannot be tested
  in memory.
- Procedures (`CALL`, `INOUT` / `OUT` parameters) may `COMMIT` / `ROLLBACK` when called outside a
  transaction block, as in PostgreSQL. `RAISE NOTICE` / `WARNING` and server warnings reach the client
  as notices (subject to `client_min_messages`).
- Errors carry PostgreSQL's SQLSTATE, message, detail, hint and, for syntax and analysis errors,
  position.

### DDL, indexes and catalogs

- `DROP INDEX` of a unique index a foreign key rests on is refused with `2BP01`, as PostgreSQL refuses
  it (`CASCADE` drops the foreign key; since 1.0.20).
- Index builds evaluate each index expression and predicate over the table's own rows (not an INHERITS
  child's, as in PostgreSQL). A `CREATE INDEX CONCURRENTLY` whose build fails (a unique index over
  duplicate keys, an expression or predicate raising for a row) leaves the index behind INVALID
  (`indisvalid` and `indisready` false: unused for reads, not maintained, skipped by
  `CREATE INDEX … IF NOT EXISTS`), as PostgreSQL does; without CONCURRENTLY a failed build leaves
  nothing. An expression the engine cannot evaluate (a function it does not implement, such as
  `to_tsvector`) is not evaluated over the rows of a non-unique index, which builds as it always did;
  a unique index's build still computes its keys, so over existing rows it fails with the engine's
  `0A000`.
- `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are refused where PostgreSQL refuses them:
  in a transaction block or a multi-statement query string, from a function or `DO` block (`25001`,
  before any name is looked up); a partitioned table or index, and for the drop several names or
  `CASCADE` (`0A000`). `TRUNCATE` makes a non-unique INVALID index valid and ready again (PostgreSQL
  rebuilds the table's indexes); a unique one keeps its flags.
- A partitioned index is one index over the whole table: `CREATE INDEX` on a partitioned table creates
  no index on each partition, as PostgreSQL does. `CREATE INDEX … ON ONLY` a partitioned table with
  partitions creates it INVALID (but ready), and `ALTER INDEX … ATTACH PARTITION` attaches an index of
  one of the partitions (`55000` for an index of another table, `42P17` when the definitions differ);
  the partitioned index turns valid once every partition has an attached valid index, PostgreSQL's
  online procedure. An attached index cannot be dropped on its own (`2BP01`, with PostgreSQL's hint);
  dropping the partitioned index drops the attached ones.
- An index builds within its statement, so `pg_stat_progress_create_index` is always empty (and
  `pg_locks` shows no relation locks), and a build reads only the rows its snapshot sees; PostgreSQL's
  blocking build also visits the row versions older transactions in the same database can still see.
  `REINDEX`, `VACUUM` and `CLUSTER` are accepted and do nothing, so an INVALID index stays INVALID
  through them. In PostgreSQL plain `VACUUM` leaves it INVALID too, while `REINDEX` rebuilds it valid,
  and `VACUUM FULL` and `CLUSTER` rebuild a non-unique one valid (a unique one stays INVALID, as after
  `TRUNCATE`).
- The catalogs are generated from the engine's own structures, not stored in tables, so catalog DML is
  refused with `42501` (`permission denied for table …`), with one exception, the write a PostgreSQL
  superuser uses to stage an INVALID index: `UPDATE pg_index SET indisvalid = …, indisready = …`
  (either flag or both, any `WHERE` / `FROM` / `RETURNING`, also in a data-modifying `WITH`) changes the
  state of the index each selected row describes. `indisvalid = false` stops reads using it;
  `indisready = false` stops writes maintaining it, so a unique index no longer rejects duplicates.
  The write is transactional, refused in a read-only transaction (`25006`), a NULL flag violates the
  column's NOT NULL (`23502`), and like DDL it holds the database's DDL lock until the transaction
  ends. A `SET` of any other column, even one `pg_index` does not have (where PostgreSQL reports
  `42703`), stays `42501`.
- `pg_depend` and `pg_rewrite` are empty, and a column type change or drop under a view is not refused
  (PostgreSQL raises `0A000` / `2BP01`). The schema manager does not rely on either: it drops and
  re-creates every model-managed view (`model.view()`) whenever a migration changes columns, so both
  engines behave the same.
- Object ids, backend pids and temp schema names are allocated by the in-memory database and differ
  from any particular server.

### Roles, extensions and functions

- Roles and privileges are not modelled. `CREATE ROLE`, `GRANT` / `REVOKE`, `SET ROLE` / `RESET ROLE`,
  `DROP OWNED` and the other role statements are accepted and do nothing. A session stays the user it
  connected as (`current_user` is `session_user`), every `has_*_privilege()` check answers true, and
  `information_schema` lists every object; PostgreSQL hides the objects the current role holds no
  privilege on.
- Supported extensions: `pg_trgm`, `unaccent`, `uuid-ossp`, `pgcrypto` (UUID generation:
  `gen_random_uuid()`, `uuid_generate_v4()`). Others are refused: `58P01 extension "postgis" is not
  available` (likewise `hstore`, `citext`).
- `pg_cancel_backend()` and `pg_terminate_backend()` return `true` and do nothing; a driver's cancel
  request does cancel a waiting statement ([Timeouts and waits](#timeouts-and-waits)).

### Not implemented (an error is raised)

`COPY`, `EXCLUDE` constraints, `MERGE` into a view, `INSTEAD OF` triggers and `SELECT … INTO` raise
an error. Observed, each with SQLSTATE `0A000`: `in-memory engine: COPY is not supported`,
`SELECT ... INTO is not supported by the in-memory engine`,
`in-memory engine: EXCLUDE constraints are not supported`. Some functions are missing too: `point()`
and `to_tsvector()` raised `0A000` `in-memory engine: function … is not implemented`.

### Found while writing these docs

- An index expression with `unaccent()` is accepted (`CREATE INDEX … (lower(unaccent("name")))`).
  PostgreSQL refuses it (`functions in index expression must be marked IMMUTABLE`, observed on PGlite).
  For accent-insensitive indexes use `ixNormalized()` ([Schema Configuration](./schema-configuration.md)).
- `information_schema.columns.column_default` of a `varchar(20)` column with `DEFAULT 'n/a'` reads
  `'n/a'::character varying(20)` (PostgreSQL: `'n/a'::character varying`), so `migrate()` against the
  in-memory database plans `SET DEFAULT` for such a column on every run; on PostgreSQL it converges
  ([Migrations](./migrations.md)).

## Pitfalls

- **Don't** call `InMemoryDatabase.fromSnapshot()` or `InMemoryDatabase.listenLazy()` →
  **Do** use `restoreInMemoryDatabase()` and `memory.listen()` (or `startInMemoryDatabaseThread({
  snapshotPath, listen: true })` for an endpoint before the database exists). `InMemoryDatabase` is
  exported as a type only (TS1362 when used as a value).
- **Don't** assert timings, plan costs or the cancellation of a CPU-bound statement in memory →
  **Do** run those tests on a PostgreSQL server.
- **Don't** test retry logic for serialization failures (`40001`) in memory → **Do** test it on
  PostgreSQL; the engine never raises `40001` by itself.
- **Don't** treat an accepted index expression or `ON CONFLICT` form as proof that PostgreSQL accepts
  it → **Do** confirm DDL that PostgreSQL may refuse (function volatility, permissions) on PGlite or a
  server.
- **Don't** construct `BunClient` with an in-process socket → **Do** connect it to `memory.listen()`
  (Bun.SQL has no custom-socket option).
- **Don't** rebuild the schema in every test → **Do** build once and `restoreInMemoryDatabase()` or
  `fork()` per test (2.9 ms against tens of ms of DDL and seed).
- **Don't** depend on the order of an unordered result → **Do** add `orderBy()`; neither engine
  guarantees it.
- **Don't** aggregate only an outer query's columns inside a subquery (`agg.sum(u.age)` in a scalar subquery over
  `posts`) → **Do** aggregate a column of the subquery's own table, or compute the value in the outer query. PostgreSQL
  makes such an aggregate the outer query's (42803, or one row); the engine refuses it with `0A000` since 1.0.31.

## See also

- [Database Clients](../database-clients.md) — `PgClient`, `PostgresClient`, `BunClient` and `PGliteClient`: options, sessions, transactions.
- [Installation](../installation.md) — the driver packages the in-memory database is reached through.
- [Getting Started](../getting-started.md) — a context whose whole flow runs on this database.
- [Migrations](./migrations.md) — `ensureCreated()` and `migrate()`, which tests usually run against it.
- [bench/in-memory](https://github.com/brunolau/linkgress-orm/blob/main/bench/in-memory/README.md) — the suite and per-operation measurements behind the numbers above (repository only, not in the npm package).
