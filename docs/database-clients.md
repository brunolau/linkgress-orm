# Database Clients

> **For agents:** Which `DatabaseClient` should I construct for this runtime and workload, and what does each one support: timeouts, prepared statements, several statements per round trip, sessions?
> **Use this page when:** choosing or configuring `PgClient`, `PostgresClient`, `BunClient` or `PGliteClient`; running raw SQL or a pinned session; running a transaction; closing the pool; writing a custom client. **Look elsewhere when:** installing packages → [Installation](./installation.md); tests without a server → [In-Memory Database](./guides/in-memory-database.md); every context option → [Configuration](./guides/configuration.md)
> **Key APIs:** `PgClient`, `PostgresClient`, `BunClient`, `PGliteClient`, `DatabaseClient`, `db.getClient()`, `connect()` / `release()`, `db.transaction()`, `querySimple()`, `querySimpleMulti()`, `db.dispose()` · **Round trips:** 1 per statement, except postgres.js: 2 for a parameterised statement that is not named (the default); a transaction adds `BEGIN` and `COMMIT`; `.withTimeout()` adds 3 statements (`PostgresClient` only)

A context talks to PostgreSQL through one `DatabaseClient`. The four built-in clients run the same
queries; they differ in pooling, timeouts, prepared statements, how many statements one message may
carry, the runtime they need, and a few value conversions listed per client below (a `date` column
reads as local midnight on `pg`, UTC midnight on postgres.js and PGlite; Bun reads a scaled numeric
zero as `"0"` in raw SQL).

## Contents

- [Choose a client](#choose-a-client)
- [What each client supports](#what-each-client-supports)
- [Connect a context to a client](#connect-a-context-to-a-client)
- [`PgClient` (node-postgres)](#pgclient-node-postgres)
- [`PostgresClient` (postgres.js)](#postgresclient-postgresjs)
- [`BunClient` (Bun.SQL)](#bunclient-bunsql)
- [`PGliteClient` (PGlite)](#pgliteclient-pglite)
- [Bound statement time on each client](#bound-statement-time-on-each-client)
- [Run raw SQL](#run-raw-sql)
- [Pin one session for several statements: `connect()` and `release()`](#pin-one-session-for-several-statements-connect-and-release)
- [Run a transaction](#run-a-transaction)
- [Log statements](#log-statements)
- [Manage the client lifecycle](#manage-the-client-lifecycle)
- [Write a custom client](#write-a-custom-client)
- [Round trips and performance per client](#round-trips-and-performance-per-client)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose a client

| Need | Use | Why | Avoid |
|---|---|---|---|
| A Node.js server, general purpose | `PgClient` | node-postgres pool; 1 round trip per parameterised statement | needing `.withTimeout()`, named prepared statements or `querySimple()` |
| Per-query timeouts with `QueryTimeoutError` | `PostgresClient` | the only client that honors `.withTimeout(ms)` | `PgClient`, `BunClient`, `PGliteClient`: they ignore it |
| Named server-side prepared statements | `PostgresClient` + `preparedStatements: true` | the only client that honors the option | statement texts that vary per call |
| Several statements in one round trip (`querySimple()`, `querySimpleMulti()`, the `temptable` strategy's single message, `FutureQueryRunner`'s single message for futures without parameters; outside `db.transaction()` only) | `PostgresClient`, `BunClient`, `PGliteClient` | `supportsMultiStatementQueries()` is `true` | `PgClient` (one statement per call) |
| The Bun runtime | `BunClient` (`prepare: false` when reading native arrays) | `Bun.SQL`, no package | Node.js: the constructor throws |
| No server: tests needing real PostgreSQL 18, CLIs, local-first apps | `PGliteClient` | PostgreSQL compiled to WebAssembly, in-process | concurrent workloads (one session), statements over 32 767 parameters |
| Fast isolated tests with many sessions | `PgClient` / `PostgresClient` over `createInMemoryDatabase()` | real drivers, in-process engine | timing or `EXPLAIN` cost assertions → [In-Memory Database](./guides/in-memory-database.md) |

## What each client supports

Values read from the clients (`getDriverName()`, the capability methods) and observed on the
in-memory database and PGlite 0.5.8.

| | `PgClient` | `PostgresClient` | `BunClient` | `PGliteClient` |
|---|---|---|---|---|
| Package | `pg` | `postgres` | none (Bun runtime) | `@electric-sql/pglite` |
| `getDriverName()` | `'pg'` | `'postgres'` | `'bun'` | `'pglite'` |
| Pool | `pg.Pool`, `max` default 10 | postgres.js, `max` default 10 | `Bun.SQL`, `max` default 10 | none: one session |
| `.withTimeout(ms)` → `QueryTimeoutError` | ignored | honored | ignored | ignored (cannot cancel a statement) |
| `preparedStatements` / `.withPreparedStatements()` | ignored | honored | ignored (Bun's own `prepare` option) | ignored |
| `supportsMultiStatementQueries()` | `false` | `true` | `true` | `true` |
| `querySimple()` / `querySimpleMulti()` | absent | yes | yes | yes (`exec()`) |
| `query('A; B')` without parameters | runs; `rows` is `undefined` | runs; `rows` holds one array per statement | runs; `rows` holds one array per statement | refused: `cannot insert multiple commands into a prepared statement` |
| `maxParameters()` | 65 535 | 65 535 | 65 535 | 32 767 (since 1.0.29) |
| `supportsBinaryArrayResults()` | `true` | `true` | `false`; `true` with `prepare: false` | `true` |
| `losesNumericZeroScale()` | `false` | `false` | `true`; `false` with `prepare: false` | `false` |
| `connect()` session | a checked-out pool client | `sql.reserve()` (postgres 3.4+) | `sql.reserve()` | a lease of the one session |
| Second `release()` | throws node-postgres's error | no-op | no-op | no-op |
| `end()` / `db.dispose()` on an instance you passed in | leaves it open | leaves it open | leaves it open | leaves it open |
| Underlying driver object | `getPool()` | `getSql()` | `getSql()` | `getPGlite()` |

## Connect a context to a client

The context constructor is `new AppDatabase(client, queryOptions?)` (your `DbContext` subclass). It
runs `setupModel`, sends no statement and opens no connection; the pool connects on the first query.

```ts
import { PgClient } from 'linkgress-orm';

const client = new PgClient({ connectionString: process.env.DATABASE_URL });
const db = new AppDatabase(client, { logFailedQueries: true });   // sends nothing yet
```

- One client and one context per database per process. Several contexts may share one client;
  `db.dispose()` closes the client for all of them.
- `DbContext` is abstract and its second parameter is `QueryOptions`, not a schema:
  `new DbContext(client, schema)` does not compile.
- `db.getClient()` returns the client; `tx.getClient()` (on the context `db.transaction()` hands its
  callback) returns the transaction's client, and so does `tx.<table>.getClient()` (since 1.0.30).

## `PgClient` (node-postgres)

`PgClient` wraps a `pg.Pool`. Pass a `PoolConfig` (exported by linkgress-orm) or a pool you created.

```ts
import { PgClient } from 'linkgress-orm';

const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
  max: 20,                        // pool size (pg default 10)
  idleTimeoutMillis: 30000,       // close a connection idle this long (pg default 10000)
  connectionTimeoutMillis: 2000,  // fail a checkout after this long (pg default 0 = wait forever)
  statement_timeout: 10000,       // server-side cap per statement, ms
});
```

```ts
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const client = new PgClient(pool);   // end() / dispose() leave `pool` open: close it yourself
```

| Option | Unit · default | Effect |
|---|---|---|
| `connectionString` | – | alternative to `host` / `port` / `database` / `user` / `password` |
| `max` | connections · 10 | pool size |
| `idleTimeoutMillis` | ms · 10 000 | idle connections are closed after this |
| `connectionTimeoutMillis` | ms · 0 (no limit) | how long a query waits for a free connection |
| `statement_timeout` | ms · none | the server cancels a longer statement (error code `57014`) |
| `ssl`, `types`, `application_name` | – | passed to node-postgres |

- A statement cancelled by `statement_timeout` rejects with node-postgres's error (`code: '57014'`,
  `canceling statement due to statement timeout`), not with `QueryTimeoutError`.
- `.withTimeout()` and `preparedStatements` are ignored: a 300 ms statement under
  `.withTimeout(50)` ran to completion.
- No `querySimple()` / `querySimpleMulti()`. `query('A; B')` without parameters runs both statements
  (simple protocol) but returns `rows: undefined`; send statements whose rows you need one by one.
- `getPool()` returns the `pg.Pool`.

## `PostgresClient` (postgres.js)

`PostgresClient` wraps a postgres.js `sql` instance. Pass a connection string, `PostgresOptions`
(exported by linkgress-orm) or an instance you created.

```ts
import { PostgresClient } from 'linkgress-orm';
import postgres from 'postgres';

const fromUrl = new PostgresClient('postgres://postgres:password@localhost:5432/mydb');

const fromOptions = new PostgresClient({
  host: 'localhost',
  database: 'mydb',
  user: 'postgres',
  password: 'password',
  max: 20,                  // pool size (default 10)
  idle_timeout: 30,         // SECONDS
  connect_timeout: 2,       // SECONDS
  statement_timeout: 10000, // ms: sent as a connection parameter, enforced by the server
});

const sql = postgres(process.env.DATABASE_URL!, { max: 20 });
const overSql = new PostgresClient(sql);   // end() / dispose() leave `sql` open
```

| Option | Unit · default (postgres.js) | Effect |
|---|---|---|
| `max` | connections · 10 | pool size |
| `idle_timeout` | seconds · none | idle connections are closed after this; by default never |
| `connect_timeout` | seconds · 30 | connection attempt limit |
| `max_lifetime` | seconds · random 30–60 min | a connection is replaced after this |
| `prepare` | boolean · `true` | `false` turns off named statements for the whole instance; `preparedStatements` then does nothing |
| `statement_timeout` | ms · none | linkgress moves it into the connection parameters; the server cancels longer statements and the client throws `QueryTimeoutError` |
| `types`, `ssl`, `connection`, `debug` | – | passed to postgres.js |

- `statement_timeout` in an options object (or on a `postgres()` instance's `connection`) is also
  what `QueryTimeoutError.timeoutMs` reports. In a URL (`…/mydb?statement_timeout=100`) postgres.js
  sends it as a connection parameter and the server enforces it, but the error then reads
  `Query exceeded its timeout of 0ms and was cancelled` (`timeoutMs: 0`).
- postgres.js options use postgres.js names: `idleTimeoutMillis` / `connectionTimeoutMillis` (pg
  names) are not read.
- `getSql()` returns the postgres.js instance. `begin()` is deprecated: it hands out postgres.js's own
  handle, which is not refused after the transaction ends (use `transaction()`).

### Cancel one slow statement: `.withTimeout(ms)`

`.withTimeout(ms)` on a table or a built query runs that one statement inside a short transaction
that sets `statement_timeout` first, so the limit cannot leak to other statements on the pooled
connection. `0` disables a connection default for that statement.

```ts
import { eq, QueryTimeoutError } from 'linkgress-orm';

try {
  await db.users.where(u => eq(u.id, 1)).withTimeout(5000).toList();
} catch (error) {
  if (error instanceof QueryTimeoutError) {
    // error.timeoutMs === 5000, error.sql = the statement, error.cause = the driver error (code 57014)
  }
}
```

```sql
-- illustrative (not captured): PostgresClient's own statements, traced with postgres.js's debug option (the harness instruments PgClient)
begin
SET LOCAL statement_timeout = 5000
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age", "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata", "users"."last_active_at" as "lastActiveAt"
FROM "users"
WHERE "users"."id" = $1
-- params: [1]
commit
```

- 4 statements instead of 1 at the root. Inside `db.transaction()` the client sends
  `SHOW statement_timeout`, `SET LOCAL statement_timeout = <ms>`, the statement, then restores the
  previous value (3 extra).
- A statement over its limit rejects with `QueryTimeoutError`: `Query exceeded its timeout of 100ms and
  was cancelled`, `cause.code === '57014'` (observed with a 500 ms statement under `.withTimeout(100)`).
- For a limit on every statement, the connection-level `statement_timeout` costs no extra statement.
- `.withTimeout()` gives the query an executor of its own: such a query cannot share a `QueryBatch`
  with plain queries
  ([Batching and prepared queries](./guides/batching-and-prepared-queries.md#batch-inside-a-transaction-or-under-a-timeout)).
  Set before `prepare()`, it limits every execution of the prepared query (since 1.0.33; before, the
  executions ignored it).

### Name statements on the server: `preparedStatements`

postgres.js sends a parameterised statement UNNAMED by default: parsed, described in an extra round
trip and planned on every execution. `preparedStatements: true` names it, so each distinct statement
text is parsed once per connection and later executions skip the describe round trip. PostgreSQL
still plans the first five executions of a named statement with their own parameters, then may keep
one generic plan.

```ts
const db = new AppDatabase(client, { preparedStatements: true });   // opt-in; default false

// per query, in either direction
await db.products.withPreparedStatements(false).where(p => eq(p.active, true)).toList();
await db.users.withPreparedStatements(true).where(u => eq(u.id, userId)).firstOrDefault();

// on a query that is already built (a paging grid: its text changes with every page)
await db.orders
  .where(o => eq(o.userId, userId))
  .orderBy(o => o.createdAt)
  .limit(25)
  .offset(250)
  .withPreparedStatements(false)
  .toList();
```

- Precedence: a per-call option, then the builder's override, then the context option.
- The override covers every execution of that builder (`toList()`, `count()`, `countOver()`,
  `firstOrDefault()`, …, and since 1.0.33 a `prepare()` called after it) and survives `.withTimeout()` /
  `.expectedExecutionTime()` chaining. Grouped, union and CTE-rooted builders have no override: set it
  before `groupBy()`.
- Observed: with the option on, `pg_prepared_statements` of the session lists the `SELECT` once
  after two executions with different parameters.
- Measure before enabling. After five executions PostgreSQL may switch a named statement to a generic
  plan, which suits uniform OLTP lookups and can slow wide analytical queries. Statement texts that
  vary per call (`IN` lists of varying length, `VALUES` lists, `LIMIT`/`OFFSET` literals) are cached
  per variant on every pooled connection: `inArrayOpt` / `inArrayPadBuckets` bound the variety of
  list texts ([Querying](./guides/querying.md)).
- Never named, whatever the option: `db.query()`, `FutureQueryRunner`'s multi-statement message,
  statements without parameters (simple protocol), and the bulk-insert legs of `insertWithChildren`,
  `insertBulkWithChildren` and `MutationBatch`. A `prepare()`d query's executions are named under the
  option since 1.0.33 (before, never).
- Only `PostgresClient` honors it, and only when the postgres.js instance was not created with
  `prepare: false`.

What to read on the server before and after enabling it:
[Configuration](./guides/configuration.md#measure-before-turning-it-on).

### Several statements in one round trip: `querySimple()` and `querySimpleMulti()`

Both send a semicolon-separated script over the simple protocol in one message, without parameters.
`querySimple()` returns the last result that has rows; `querySimpleMulti()` returns every result.
They exist on `PostgresClient`, `BunClient` and `PGliteClient`, not on the `DatabaseClient` type.

```ts
import { PostgresClient } from 'linkgress-orm';

const client = db.getClient() as PostgresClient;

const last = await client.querySimple('SELECT 1 AS a; SELECT id FROM users ORDER BY id');
// last.rows: [{ id: 1 }, { id: 2 }, { id: 3 }]

const all = await client.querySimpleMulti('SELECT 1 AS a; SELECT id FROM users ORDER BY id');
// all.map(r => r.rows): [[{ a: 1 }], [{ id: 1 }, { id: 2 }, { id: 3 }]]
```

Observed on the seeded example database; postgres.js's `debug` trace shows each script sent once.

> **Pitfall:** never interpolate user input into these scripts: there are no parameters. Index
> `querySimpleMulti()` results by position only when every statement returns a result set (a
> `SELECT`, even an empty one): postgres.js gives a statement without one (DDL, an `INSERT` /
> `UPDATE` without `RETURNING`) no entry of its own when another statement precedes it
> (`SELECT 2 AS b; CREATE TEMP TABLE t (id int)` returned 1 result, `CREATE …; INSERT …; SELECT …`
> 2). `BunClient` and `PGliteClient` return one result per statement.

### Do not use postgres.js `transform`

A `transform` option renames result columns before linkgress reads them: with
`transform: { column: c => c.toLowerCase() }` the projection
`select(u => ({ userName: u.username, isActive: u.isActive }))` returned `[{}]`. Keep column
transforms off the instance a `PostgresClient` uses.

> **Pitfall:** `timeout` is not a query timeout in postgres.js: it is a deprecated alias of
> `idle_timeout` (seconds). Use `statement_timeout` (ms).

## `BunClient` (Bun.SQL)

`BunClient` runs on Bun's built-in SQL client: no package, Bun runtime only (under Node.js the
constructor throws `BunClient requires Bun runtime with SQL support…`).

```ts
import { BunClient } from 'linkgress-orm';

const fromOptions = new BunClient({ hostname: 'localhost', port: 5432, database: 'mydb', username: 'postgres', password: 'password' });
const textMode = new BunClient({ url: 'postgres://postgres:password@localhost:5432/mydb', prepare: false });
const fromUrl = new BunClient('postgres://postgres:password@localhost:5432/mydb');
const overSql = new BunClient(new Bun.SQL('postgres://postgres:password@localhost:5432/mydb'));   // yours to close
```

| | default (prepared, binary results) | `prepare: false` (unnamed statements, text results) |
|---|---|---|
| `supportsBinaryArrayResults()` | `false`: collections aggregate with `json_agg` instead of `array_agg`, and a projected `agg.arrayAgg()` or `g.arrayAgg()` (since 1.0.31) travels as JSON too ([SQL Expression Helpers](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)) | `true`: `array_agg` kept |
| Scaled numeric zero (`0.0000::numeric(20,4)`) | read as `"0"`; restored for columns declared with a scale | `"0.0000"` |
| Multidimensional array result | fails: `ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET` (read it as text, or use `prepare: false`) | `[[1, 2], [3, 4]]` |
| Cost | – | a re-parse per query (about 0.05 ms, per the client's source) |

A pre-built `Bun.SQL` instance is treated as the default mode (the client cannot see its `prepare`
setting); pass options to get text mode.

**Parameters.** `BunClient` converts what Bun cannot bind the way postgres.js does:

- A `Date` is sent as its ISO instant, in both modes: a `timestamptz` stores the instant, a
  `timestamp` its UTC wall time, a `date` the UTC date. Observed for `2024-03-10T00:30:00.000Z` in a
  session at UTC+1: `2024-03-10 01:30:00+01`, `2024-03-10 00:30:00`, `2024-03-10`. (Bun itself sends
  `Date.prototype.toString()` wherever the server does not describe a timestamp parameter, and
  everywhere with `prepare: false`.)
- With `prepare: false`, a plain object or array is sent as its JSON text (Bun would send
  `"[object Object]"`); bytes (`Uint8Array`, `Buffer`) and classes with their own `toString()` are left
  to Bun.
- A JS array cannot be bound to a native array parameter in either mode: `SELECT $1::int[]` with
  `[[1, 2, 3]]` failed with `08P01 insufficient data left in message` (prepared) and, since
  `prepare: false` sends the array as JSON text, `22P02 malformed array literal: "[1,2,3]"`.
  linkgress binds a native array column (`integer('ids').array()`) and `cast(values, 'int[]')` as a
  PostgreSQL array literal, which works; a raw JS array passed to raw SQL for an array parameter still
  fails: pass `cast(values, 'int[]')`. A JS array bound to `jsonb` is JSON, as with the other drivers.

**Results.**

- Through the binary protocol Bun decodes an `int4[]` column as an `Int32Array` and a `float4[]` as a
  `Float32Array`; `BunClient` hands them over as plain arrays, as the other drivers do (`int8[]`
  elements as strings: `["1", "2"]`).
- A numeric zero read through the binary protocol loses its scale (`"0"` for `0.0000`); non-zero
  values keep it. It is a Bun decoder divergence the repository's
  [Bun.SQL contract tests](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/bun-sql-contract.test.ts) pin, so a fixed Bun shows up
  there. linkgress restores the scale of a column declared with one
  (`decimal('amount', 10, 2)`) in entity rows, projections, one-value selections and every
  `.returning()`. A column without a declared scale (`numeric('n')`) and raw SQL (`db.query()`) read
  as Bun delivers them.
- `datesAsStrings: true` turns `Date` results into PostgreSQL text: `2024-03-10 01:00:00.500` for a
  `timestamp`, `2024-03-10` for a `date` (UTC). Bun has no type-parser hook; this is the way to keep
  timestamps as strings. A value at exactly UTC midnight becomes the date alone: the `timestamp`
  `2024-03-10 00:00:00` read as `2024-03-10`.
- `bigint: true` (a `Bun.SQL` option) reads `int8` as `BigInt`; by default it is a string.

`.withTimeout()` and `preparedStatements` are ignored. `connect()` reserves a connection
(`sql.reserve()`), `transaction()` uses `sql.begin()`. `getSql()` returns the `Bun.SQL` instance. To
run a `BunClient` against the in-memory database, use its TCP endpoint (`memory.listen()`).

## `PGliteClient` (PGlite)

`PGliteClient` runs on [PGlite](https://pglite.dev): PostgreSQL 18.3 compiled to WebAssembly
(PGlite 0.5.8), inside your process (Node.js, Bun, Deno, browsers), with no server.

```ts
import { PGliteClient } from 'linkgress-orm';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const inMemory = new PGliteClient();                                                   // gone with the process
const onDisk = new PGliteClient('./pgdata');                                           // persisted to a directory
const withTrgm = new PGliteClient({ dataDir: './pgdata', extensions: { pg_trgm } });   // CREATE EXTENSION pg_trgm then works
const overInstance = new PGliteClient(await PGlite.create());                         // yours to close
```

`end()` / `dispose()` close an instance the client created; an instance you passed in stays open and
is used exactly as configured, parsers included. Pass one in for ESM and browser builds (construct
PGlite yourself there) or to share one instance between clients. `getPGlite()` returns the instance
(extensions, `dumpDataDir()`, live queries).

**One session.** PGlite runs one session, one statement at a time.

- `connect()` leases that session until `release()`: a pool of one, shared by every `PGliteClient`
  over the same instance (FIFO). Other queries wait meanwhile, so never await a query on the outer
  context while holding a lease. A released lease refuses its queries with `ConnectionReleasedError`.
- Inside `db.transaction()` use the transaction's context (`tx.<table>`, `tx.<sequence>`). A
  root-level call from the callback (another query on `db`, a second transaction,
  `tx.runtimeSequence(…)`, which is bound to the root client) could never run, so it throws at once:
  `PGliteClient: PGlite has a single session, and the transaction running this callback holds it — …`.
- Session state (temp tables, `SET`) is shared by everything using the instance.

**At most 32 767 parameters per statement** (since 1.0.29). PGlite counts parameters in a signed
16-bit field (PostgreSQL: unsigned, 65 535). A statement binding more used to desynchronize the
session; `PGliteClient` now refuses it before sending: `PGliteClient: the statement binds 32768
parameters — PGlite takes at most 32 767 …`. `maxParameters()` reports the limit and `MutationBatch`
honors it. Bind a large list as one array parameter (`eqAny`, `unnest`, `fromRows`) or in smaller
chunks. The standalone bulk writes (`insertBulk()`, `upsertBulk()`, `bulkUpdate()`, `mergeBulk()`)
size their default chunk within the client's limit too (since 1.0.32): at most ⌊32 767 / columns⌋
rows per statement on PGlite, so 11 000 rows of 3 columns go as 2 statements (32 766 + 234
parameters). From 1.0.29 to 1.0.31 they chunked by PostgreSQL's limit and that input was refused. A
`chunkSize` you pass is used as given: `{ chunkSize: 11000 }` with 3 columns is still refused.

**Values.** An instance the client creates follows `pg` wherever `pg` and postgres.js agree:

- `int8` / `bigint` reads as a string (`"9007199254740993"`), `bytea` as a `Buffer` (a `Uint8Array`
  where there is no `Buffer`).
- A `Date` bound to a `date`, `timestamp` or `timestamptz` parameter is sent in local time, so it
  stores the same calendar day and wall-clock time as with `pg` and postgres.js (local midnight of
  2024-03-10 stored as `2024-03-10` at UTC+1). PGlite's own default sends UTC, which lands a
  local-midnight `Date` on the previous day east of Greenwich and shifts every `Date` round-tripped
  through `timestamp` by the host's offset.
- A `date` column reads back as UTC midnight (`2024-03-10T00:00:00.000Z`), as with postgres.js (`pg`
  gives local midnight).
- Override any type with `parsers` / `serializers`, e.g. `parsers: { 20: value => BigInt(value) }`.

**Collation and time zone.** A PGlite database uses the `C` collation, so text sorts by byte order
(`Z` before `a`) where a server usually has a linguistic default, and ICU collations need ICU data
PGlite does not ship. The session starts in a fixed-offset `TimeZone` (`Etc/GMT-1` observed), which
ignores daylight saving: `now()` and `timestamptz` text are an hour off in summer. Named zones work:
run `SET TIME ZONE 'Europe/Bratislava'` if your SQL depends on the zone.

**Several statements.** `query()` refuses a script (`cannot insert multiple commands into a prepared
statement`); `querySimple()` and `querySimpleMulti()` run it through PGlite's `exec()` and return one
result per statement, row-less ones included. The single-message paths (`temptable` strategy,
`FutureQueryRunner`) therefore apply.

**No statement timeouts.** PGlite cannot cancel a running statement: `.withTimeout()` and
`statement_timeout` are not enforced (`SELECT pg_sleep(0.3)` ran to completion under
`statement_timeout = 50`).

**Under Jest**, Node.js needs `--experimental-vm-modules`: PGlite loads its WebAssembly through
dynamic `import()`. Bun needs no flag.

## Bound statement time on each client

| Client | Every statement (connection default) | One statement | Error when exceeded |
|---|---|---|---|
| `PgClient` | `statement_timeout` (ms) in the pool config | not available (`.withTimeout()` ignored) | node-postgres error, `code: '57014'` |
| `PostgresClient` | `statement_timeout` (ms) in the options object | `.withTimeout(ms)`; `.withTimeout(0)` lifts the default | `QueryTimeoutError` (`timeoutMs`, `sql`, `cause`) |
| `BunClient` | `Bun.SQL`'s `connection: { statement_timeout: <ms> }` (passed through, but not declared on `BunSqlOptions`: cast the options object), or a server default (`ALTER DATABASE … SET statement_timeout`, `ALTER ROLE … SET …`) | not available (`.withTimeout()` ignored) | Bun's `PostgresError`, `code: 'ERR_POSTGRES_SERVER_ERROR'`, `errno: '57014'` |
| `PGliteClient` | not enforced | not available | – |

`db.transaction(fn, { timeoutMs })` sends `SET LOCAL statement_timeout = <ms>` as the transaction's
first statement on every client, which covers every statement inside it, bulk writes included
([Insert, Update, Delete](./guides/insert-update-guide.md)); PGlite receives it but cannot enforce it.

```ts
import { BunClient, PgClient } from 'linkgress-orm';
import type { BunSqlOptions } from 'linkgress-orm';

const client = new PgClient({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000 });
const bunClient = new BunClient({ url: process.env.DATABASE_URL, connection: { statement_timeout: 10000 } } as BunSqlOptions);   // Bun runtime
```

Observed with `statement_timeout: 100` and `SELECT pg_sleep(0.5)`, on both clients:
`SHOW statement_timeout` → `100ms`, then `canceling statement due to statement timeout` (`PgClient`:
`code: '57014'`; `BunClient`: `errno: '57014'`), not a `QueryTimeoutError`.

## Run raw SQL

| Call | Returns | Use for |
|---|---|---|
| ``db.query<T>(sql`…`)`` / `db.query<T>(text, params?)` | `T[]` (the rows) | statements the builders do not express |
| `db.getClient().query<T>(text, params?, options?)` | `{ rows, rowCount }` | the affected-row count, per-call `QueryExecutionOptions` (`timeoutMs`, `prepare`: `PostgresClient` only) |
| `(db.getClient() as PostgresClient).querySimple(script)` | the last result with rows | several statements in one round trip (see above) |

```ts
import { sql } from 'linkgress-orm';

const adults = await db.query<{ id: number; username: string }>(
  sql`SELECT id, username FROM users WHERE age >= ${30} ORDER BY id`,
);

const result = await db.getClient().query('UPDATE posts SET views = views + 1 WHERE user_id = $1', [1]);
// result.rowCount: 2, result.rows: []
```

```sql
SELECT id, username FROM users WHERE age >= $1 ORDER BY id
-- params: [30]

UPDATE posts SET views = views + 1 WHERE user_id = $1
-- params: [1]
```

- Interpolated values in a ``sql`…` `` template become parameters; `sql.raw(text)` is inlined verbatim.
- Raw calls bypass the context's executor: no `logQueries` line, no `logFailedQueries`, no
  slow-query callback, no `.withTimeout()`, never named. Rows come as the driver delivers them
  (`count(*)` as the string `'3'`, custom mappers not applied).
- The `ClientQueryResult` type is exported under that name (the interface is `QueryResult` inside the
  package).

## Pin one session for several statements: `connect()` and `release()`

`connect()` checks out one session for raw statements that share session state (temp tables, `SET`,
session advisory locks) without a transaction. Release it in `finally`.

```ts
const connection = await db.getClient().connect();
try {
  await connection.query('CREATE TEMP TABLE import_batch (id int)');   // one session for these statements
  await connection.query('INSERT INTO import_batch VALUES (1), (2)');
  const { rows } = await connection.query<{ n: number }>('SELECT count(*)::int AS n FROM import_batch');   // [{ n: 2 }]
} finally {
  connection.release();                                               // from here on connection.query() throws
}
```

```sql
CREATE TEMP TABLE import_batch (id int)
INSERT INTO import_batch VALUES (1), (2)
SELECT count(*)::int AS n FROM import_batch
```

- A connection is valid until `release()`. Released, its session is back in the pool, which may
  already have handed it to another caller in the middle of that caller's transaction, so every
  statement issued afterwards throws `ConnectionReleasedError` (its `sql` is the refused text; it was
  never sent). A statement issued before `release()` completes.
- A second `release()` never reaches the driver's pool: `PgClient`'s throws node-postgres's own
  `Release called on client which has already been released to the pool.`; `PostgresClient`'s,
  `BunClient`'s and `PGliteClient`'s do nothing.
- A lease holds a pool connection until `release()`. It takes raw SQL only: no builders, no logging.
- Inside `db.transaction()`, `tx.getClient().connect()` throws
  `Cannot get a new connection while in a transaction`.

## Run a transaction

`db.transaction(fn)` runs `fn` on one pooled connection between `BEGIN` and `COMMIT` (`ROLLBACK` when
`fn` throws) and hands it a transaction-scoped copy of the context. Use `tx.<table>` inside.

```ts
const postId = await db.transaction(async tx => {
  const user = await tx.users
    .insert({ username: 'dora', email: 'dora@example.com' })
    .returning(u => ({ id: u.id }));
  const post = await tx.posts
    .insert({ userId: user.id, title: 'First post' })
    .returning(p => ({ id: p.id }));
  return post.id;   // return values, not tx objects
});
```

The two statements run on the transaction's connection, between the `BEGIN` and `COMMIT` the
driver sends itself (4 statements in all):

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: ["dora", "dora@example.com"]
INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: ["First post", 4]
```

- `tx` and everything obtained from it (tables, model sequences, builders, futures, batch legs,
  prepared queries, its schema manager, its client) work only until the callback settles. A statement
  sent through them afterwards throws `TransactionEndedError` (its `sql` is the refused statement)
  instead of running on the connection the transaction gave back to the pool.
- `db.<table>` inside the callback runs on another connection, outside the transaction. So does a
  future or `PreparedQuery` built on `db` (it is not refused).
- `tx.transaction(…)` throws `Nested transactions are not supported`; use `tx.query('SAVEPOINT …')`.
- `db.transaction(fn, { timeoutMs, expectedExecutionMs })`: `timeoutMs` sends
  `SET LOCAL statement_timeout = <ms>` first; `expectedExecutionMs` (default: `timeoutMs`) raises the
  slow-query threshold inside.
- The raw form is `client.transaction(async query => …)`: `query(text, params?)` runs on the
  transaction's connection and is refused with `TransactionEndedError` after the callback settles.
  `PostgresClient.begin()` is deprecated and not guarded.

More on transactions and writes: [Insert, Update, Delete](./guides/insert-update-guide.md).

## Log statements

Logging is a context option. A development context logs every statement; a production context
usually logs only failures (and reports slow statements through `onQueryTakingTooLong`).

```ts
import type { LogSection } from 'linkgress-orm';

const logger = (message: string, section?: LogSection) => console.log(`[${section}] ${message}`);

const dev = new AppDatabase(client, { logQueries: true, logParameters: true, logExecutionTime: true, logger });
const prod = new AppDatabase(client, { logFailedQueries: true, logger });
```

Calls `dev` makes for one `toList()` filtered on `'alice'`: `('\n[SQL Query]', 'sql')`,
`('<statement>', 'sql')`, `('[Parameters] ["alice"]', 'params')`, `('[Execution Time] <n>ms', 'timing')`.
Calls `prod` makes for a failing statement: `('[SQL Error] <driver message>\n<statement>', 'error')`,
for example `[SQL Error] function no_such_function(unknown) does not exist`; nothing for a statement
that succeeds.

- `logFailedQueries` defaults to the value of `logQueries`; parameter values appear in the failure
  line only with `logParameters: true`.
- Without `logger`, sections `error` and `warn` go to `console.error` / `console.warn`, the rest to
  `console.log`.
- `db.query()`, `db.getClient().query()` and `FutureQueryRunner`'s multi-statement message are never
  logged. A `prepare()`d query's executions are, since 1.0.33 (before, never).

Every logging and diagnostics option: [Configuration](./guides/configuration.md).

## Manage the client lifecycle

A client owns a pool (PGlite: an instance). Create the client and the context once, share them, and
close them once, at shutdown: `db.dispose()` calls `client.end()`.

```ts
import { createServer } from 'node:http';
import { PostgresClient } from 'linkgress-orm';

const db = new AppDatabase(new PostgresClient(process.env.DATABASE_URL!));   // once, at startup

const server = createServer(async (_req, res) => {
  const users = await db.users.select(u => ({ id: u.id, username: u.username })).toList();
  res.end(JSON.stringify(users));
}).listen(3000);

process.on('SIGTERM', async () => {
  server.close();
  await db.dispose();   // closes the pool: the last call on db
  process.exit(0);
});
```

A script or CLI closes the pool when it is done; otherwise the open connections keep the process
alive (pg until `idleTimeoutMillis`, default 10 000 ms, closes them; postgres.js never, its
`idle_timeout` is unset by default):

```ts
import { eq, PgClient } from 'linkgress-orm';

async function main() {
  const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));
  try {
    await db.users.where(u => eq(u.isActive, false)).delete();
  } finally {
    await db.dispose();
  }
}
```

A test suite creates one context per suite, not per test:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createInMemoryDatabase, PgClient } from 'linkgress-orm';

describe('users', () => {
  const memory = createInMemoryDatabase();
  const db = new AppDatabase(new PgClient(memory.pgPoolConfig()));

  beforeAll(async () => {
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await db.dispose();
    memory.close();
  });

  test('insert returns the generated key', async () => {
    const { id } = await db.users
      .insert({ username: 'test', email: 'test@example.com' })
      .returning(u => ({ id: u.id }));
    expect(id).toBeGreaterThan(0);
  });
});
```

For dependency injection, construct in one factory and pass the context:

```ts
import { eq, PostgresClient } from 'linkgress-orm';

export function createDatabase(connectionString: string): AppDatabase {
  return new AppDatabase(new PostgresClient(connectionString));
}

export class UserService {
  constructor(private readonly db: AppDatabase) {}

  activeUsers() {
    return this.db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id, username: u.username })).toList();
  }
}
```

| Scenario | Call `dispose()`? | Reason |
|---|---|---|
| Web server startup | No | keep the pool for the process lifetime |
| After each request | Never | the pool is shared by all requests |
| Application shutdown | Yes | close the connections |
| End of a script or CLI | Yes | open connections keep the process alive |
| End of a test suite | Yes | release the test's connections |
| Serverless cold start | No | reuse the client across invocations |
| Serverless shutdown | Only when the runtime offers a shutdown hook | |

- `end()` closes only a pool or instance the client created; one you passed in stays open (observed:
  a `PostgresClient` over your `postgres()` instance still answered `SELECT 1` after `end()`).
- A transaction context's client `end()` does nothing; `dispose()` belongs to the root context.
- After `dispose()` the context is unusable: node-postgres rejects with
  `Cannot use a pool after calling end on the pool`.

**Pool size.** `max` defaults to 10 connections on `pg`, postgres.js and `Bun.SQL`. Each process
holds up to `max` connections, so `max` × processes must stay below the server's
`max_connections`. Every concurrent query holds one connection: `Promise.all` of N reads uses up to N,
and a transaction holds one for its whole callback. When all are busy, node-postgres queues the query
without limit; with `connectionTimeoutMillis` set, a queued query fails with
`timeout exceeded when trying to connect`.

## Write a custom client

Extend `DatabaseClient` and implement its five abstract members: `query`, `connect`, `end`,
`getDriverName` and `transaction`. This wrapper delegates to another client and counts statements:

```ts
import { DatabaseClient } from 'linkgress-orm';
import type { ClientQueryResult, PooledConnection, QueryExecutionOptions, TypedTextRead } from 'linkgress-orm';

class CountingClient extends DatabaseClient {
  statements = 0;

  constructor(private readonly inner: DatabaseClient) {
    super();
  }

  // the five abstract members
  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<ClientQueryResult<T>> {
    this.statements++;
    return this.inner.query<T>(sql, params, options);
  }

  connect(): Promise<PooledConnection> {
    return this.inner.connect();
  }

  end(): Promise<void> {
    return this.inner.end();
  }

  getDriverName(): string {
    return this.inner.getDriverName();
  }

  transaction<T>(
    callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<ClientQueryResult>) => Promise<T>,
  ): Promise<T> {
    return this.inner.transaction(query => callback((sql, params, options) => {
      this.statements++;
      return query(sql, params, options);
    }));
  }

  // capability hooks: report what the driver underneath does (defaults: false / false / true / false / 65 535)
  override supportsMultiStatementQueries(): boolean { return this.inner.supportsMultiStatementQueries(); }
  override supportsBinaryProtocol(): boolean { return this.inner.supportsBinaryProtocol(); }
  override supportsBinaryArrayResults(): boolean { return this.inner.supportsBinaryArrayResults(); }
  override losesNumericZeroScale(): boolean { return this.inner.losesNumericZeroScale(); }
  override maxParameters(): number { return this.inner.maxParameters(); }

  // how a QueryBatch turns a value it received as text back into what the driver delivers
  override parseTypedText(oid: number, text: string, read?: TypedTextRead): unknown { return this.inner.parseTypedText(oid, text, read); }
  override customParsedTypeOids(): readonly number[] { return this.inner.customParsedTypeOids(); }
}

const counting = new CountingClient(client);
const db = new AppDatabase(counting);
```

Observed: one `firstOrDefault()` plus a transaction with one `update()` counted 2 statements
(`BEGIN` / `COMMIT` are sent by the inner driver, not through `query`).

| Hook | Default | Meaning |
|---|---|---|
| `supportsMultiStatementQueries()` | `false` | the client has `querySimple()` / `querySimpleMulti()` and may receive scripts |
| `supportsBinaryProtocol()` | `false` | no built-in client returns `true` |
| `supportsBinaryArrayResults()` | `true` | `false`: collections aggregate with `json_agg` so no native array reaches the driver |
| `losesNumericZeroScale()` | `false` | `true`: the driver reads a scaled numeric zero as `"0"`; the builders restore declared scales |
| `maxParameters()` | 65 535 | parameters per statement; `MutationBatch` refuses a statement over it before sending, measures `ifFits` legs against it, and the standalone bulk writes size their chunks within it (since 1.0.32) |
| `parseTypedText(oid, text, read?)` | node-postgres's default parsing | the value the client delivers for a column of type `oid` whose wire text is `text` (`read.parameterized`: whether the statement binds parameters) |
| `customParsedTypeOids()` | `[]` | types the application parses with its own parsers; a `QueryBatch` sends their values as text |

The built-in clients answer `parseTypedText` through their driver's own parsers (node-postgres's
`types`, postgres.js's `parsers`, PGlite's `parsers`); `BunClient` reproduces Bun's decoding, as Bun
exposes no parsers. `parseTypedText` and `customParsedTypeOids` matter for `QueryBatch`, which moves
values as JSON and turns the ones JSON cannot carry back through them:
[Batching and prepared queries](./guides/batching-and-prepared-queries.md#get-the-values-the-query-reads-on-its-own).

## Round trips and performance per client

| Client | Parameterised statement | Several statements in one message | Notes |
|---|---|---|---|
| `PgClient` | 1 round trip; no describe step | no | node-postgres has no pipelining: one statement on the wire per connection at a time |
| `PostgresClient` | unnamed (default): 2 network round trips (Parse/Describe, then Bind/Execute); named (`preparedStatements`): 2 on first use per connection, then 1, and pipelined; without parameters: 1 (simple protocol) | `querySimple()` / `querySimpleMulti()` | `prepare: false` on the instance disables naming entirely; a new connection first reads the array types (`fetch_types`, default `true`): one more statement per connection |
| `BunClient` | prepared and binary by default | `querySimple()` / `querySimpleMulti()` | `prepare: false`: text results, a re-parse per query |
| `PGliteClient` | in-process call, no network; one statement at a time | `querySimple()` / `querySimpleMulti()` (`exec()`) | slower per statement than a native server, much faster where a server touches its disk (schema changes, `TRUNCATE`) |

The postgres.js and node-postgres facts come from [bench/querybatch](https://github.com/brunolau/linkgress-orm/blob/main/bench/querybatch/README.md)
(postgres.js 3.4.7, pg 8.16.3); the PGlite comparison from [bench/pglite](https://github.com/brunolau/linkgress-orm/blob/main/bench/pglite/README.md).
Independent of the client, `QueryBatch` sends several reads as one statement:
[Batching and prepared queries](./guides/batching-and-prepared-queries.md).

## Pitfalls

- **Don't** pass a schema as the second constructor argument (`new DbContext(client, schema)`) →
  **Do** subclass `DbContext` and call `new AppDatabase(client, queryOptions)`. `DbContext` is abstract.
- **Don't** expect `.withTimeout()` to cancel anything on `PgClient`, `BunClient` or `PGliteClient` →
  **Do** use `PostgresClient`, or a connection-level `statement_timeout` (`PgClient`; `BunClient`
  through `connection`), or `db.transaction(fn, { timeoutMs })`. A 300 ms statement under
  `.withTimeout(50)` ran to completion on `PgClient`, `BunClient` and `PGliteClient`.
- **Don't** catch `QueryTimeoutError` on `PgClient` → **Do** check `error.code === '57014'`; only
  `PostgresClient` throws `QueryTimeoutError`.
- **Don't** give postgres.js node-postgres option names (`idleTimeoutMillis`,
  `connectionTimeoutMillis`) → **Do** use `idle_timeout` and `connect_timeout`, in seconds.
- **Don't** keep a `tx` object, a leased connection or the transaction's query function past its
  callback or `release()` → **Do** return plain values. Late statements throw `TransactionEndedError`
  / `ConnectionReleasedError` and are never sent.
- **Don't** call `db.<table>` inside `db.transaction()` → **Do** use `tx.<table>`; `db` runs on
  another connection outside the transaction (and on PGlite throws at once).
- **Don't** call `dispose()` per request → **Do** call it once at shutdown; it closes the pool every
  context on that client shares.
- **Don't** send a semicolon-separated script through `query()` on `PGliteClient` → **Do** use
  `querySimple()` / `querySimpleMulti()`.
- **Don't** use the `temptable` collection strategy inside `db.transaction()` on `PostgresClient`,
  `BunClient` or `PGliteClient` → **Do** use `lateral` or `cte` there. The transaction's client has no
  `querySimpleMulti()`: a query without parameters threw `Fully optimized mode requires
  querySimpleMulti support` (all three); with a parameter PGlite threw `cannot insert multiple
  commands into a prepared statement`, and postgres.js and `BunClient` returned every collection as
  `[]` without an error. `PgClient` runs it correctly there (6 statements)
  ([Collection Strategies](./collection-strategies.md#run-the-temptable-strategy-safely-experimental)).
- **Don't** import `QueryResult` from linkgress-orm → **Do** import the type `ClientQueryResult`.

## See also

- [Installation](./installation.md) — the package to install for each client and runtime.
- [Getting Started](./getting-started.md) — a context and its first queries end to end.
- [Configuration](./guides/configuration.md) — every `QueryOptions` key, its default and scope.
- [Batching and prepared queries](./guides/batching-and-prepared-queries.md) — `QueryBatch`, futures, `PreparedQuery`: fewer round trips.
- [Insert, Update, Delete](./guides/insert-update-guide.md) — transactions, savepoints, writes.
- [Collection Strategies](./collection-strategies.md) — `lateral`, `cte`, `temptable` and their statement counts.
- [In-Memory Database](./guides/in-memory-database.md) — the bundled PostgreSQL-compatible engine for tests.
- Client tests with real usage (repository only, not in the npm package): [tests/database/pglite-client.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/pglite-client.test.ts), [tests/database/bun-client.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/bun-client.test.ts), [tests/database/released-connection.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/released-connection.test.ts), [tests/database/transaction-ended.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/transaction-ended.test.ts), [tests/database/prepared-statements.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/database/prepared-statements.test.ts).
