# Configuration and Options

> **For agents:** Which setting controls a behaviour, what it defaults to, where it is set (connection, context, transaction, query, statement or process), and which value wins when several apply.
> **Use this page when:** you turn on statement logging, failure logging or slow-statement notices; send statements named (server-side prepared); cancel statements that run too long; switch the collection strategy; bound the statement texts of list filters; enable the query-build caches; read the SQL a query sends. **Look elsewhere when:** you choose how to fetch data → [Choosing the right query](../choosing-the-right-query.md); you want fewer round trips → [Batching and prepared queries](./batching-and-prepared-queries.md)
> **Key APIs:** `QueryOptions` · `withQueryOptions()` · `withPreparedStatements()` · `withTimeout()` · `expectedExecutionTime()` · `TransactionOptions` · `LinkgressConfig` · `MockRowCache` · **Round trips:** no option adds a statement, except `withTimeout()` on `PostgresClient` (+3 per query), `TransactionOptions.timeoutMs` (+1 per transaction) and `collectionStrategy: 'temptable'` (+5 per collection on `PgClient`, up to +1 per collection on the other clients); `preparedStatements` removes postgres.js's describe exchange from the second execution of a text on a connection

## Contents

- [Pick the setting for the job](#pick-the-setting-for-the-job)
- [Where settings live and which value wins](#where-settings-live-and-which-value-wins)
- [Configure a context: `QueryOptions`](#configure-a-context-queryoptions)
- [Log every statement while debugging: `logQueries`](#log-every-statement-while-debugging-logqueries)
- [Record failed statements in production: `logFailedQueries`](#record-failed-statements-in-production-logfailedqueries)
- [Route log lines: `logger` and `LogSection`](#route-log-lines-logger-and-logsection)
- [Get notified about slow statements: `onQueryTakingTooLong`](#get-notified-about-slow-statements-onquerytakingtoolong)
- [Cancel statements that run too long: `withTimeout()` and `statement_timeout`](#cancel-statements-that-run-too-long-withtimeout-and-statement_timeout)
- [Send statements named on the server: `preparedStatements`](#send-statements-named-on-the-server-preparedstatements)
- [Choose how collections load: `collectionStrategy`](#choose-how-collections-load-collectionstrategy)
- [Override options for one table or query](#override-options-for-one-table-or-query)
- [Bound the statement texts of list filters: `LinkgressConfig`](#bound-the-statement-texts-of-list-filters-linkgressconfig)
- [Cut query-build CPU: `MockRowCache`](#cut-query-build-cpu-mockrowcache)
- [Read raw driver values or time one query](#read-raw-driver-values-or-time-one-query)
- [See the SQL a query sends](#see-the-sql-a-query-sends)
- [Recipes](#recipes)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Pick the setting for the job

Most settings change logging, timing, statement naming or caching, not the rows a query returns.
`collectionStrategy` and `LinkgressConfig` change the SQL text and return the same data;
`disableMappers` and `rawResult` return raw driver values.

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| See each statement a context sends, with parameters and duration | `logQueries`, `logParameters`, `logExecutionTime` | unchanged · +0 | expecting `db.query()` or `FutureQueryRunner`'s multi-statement message in the log: they bypass the executor (a `prepare()`d query's executions are logged since 1.0.33) |
| Record every failed statement in production | `logFailedQueries: true`, `logQueries` off | unchanged · +0 | `logQueries: true` in production: two `'sql'` lines per statement |
| Learn which call site ran a slow statement | `onQueryTakingTooLong` + `longRunningQueryThreshold` (default 10000 ms) | unchanged · +0 | expecting a cancellation: it is a notice after the statement finished |
| Give one known-slow query a larger budget | `.expectedExecutionTime(ms)`; for a transaction `{ expectedExecutionMs }` | unchanged · +0 | raising `longRunningQueryThreshold` for every query |
| Cancel a statement after N ms | `statement_timeout` on the client; `db.transaction(fn, { timeoutMs })`; `.withTimeout(ms)` on `PostgresClient` | `.withTimeout()`: `begin`, `SET LOCAL statement_timeout = N`, the statement, `commit` · +3; transaction: `SET LOCAL` · +1; client option · +0 | `.withTimeout()` on `PgClient`, `BunClient`, `PGliteClient`: ignored |
| Skip parse and plan of repeated statements (postgres.js) | `preparedStatements: true`; per query `.withPreparedStatements(bool)`; a `prepare()`d query follows both (since 1.0.33) | same text, sent named · 2 network round trips on first use per connection, then 1 (unnamed with parameters: 2 every time) | statements whose text varies per call; `PgClient`, `BunClient`, `PGliteClient` (ignored) |
| Change how collections in a projection are aggregated | `collectionStrategy: 'lateral' \| 'cte' \| 'temptable'` | `lateral`, `cte`: 1 statement; `temptable` on `PgClient`: 1 + 5 per collection, on the other clients 1 to 1 + 1 per collection | `temptable` without measuring it first; `temptable` inside `db.transaction()` on `PostgresClient`, `BunClient`, `PGliteClient` |
| Fewer distinct statement texts for list filters of varying length | `inArrayOpt()` (or plain `inArray` under `LinkgressConfig.inArrayUsesOpt`), tuned by `LinkgressConfig.inArrayOptThreshold` and `inArrayPadBuckets`; `eqAny()` for one text at every length | `IN ($1, …)` up to the threshold (default 8), `= ANY($1::type[])` above it · +0 | per-context values: these are process-wide |
| Cut CPU spent building queries | `MockRowCache.setEnabled(true)` | identical SQL · +0 | processes that build mostly one-off query shapes |
| Find where one query's time goes | `traceTime: true`, on its own since 1.0.33 (before, only beside an executor duty) | unchanged · +0 | expecting a trace from `count()`, `exists()`, `sum()` / `min()` / `max()`, unions, futures, a `prepare()`d query or a table's own reads: only a select builder's `toList()`, `first()`, `firstOrDefault()` and `countOver()` report one |
| Raw driver values for an export | `disableMappers: true` or `rawResult: true`, on their own since 1.0.33 (before, only beside an executor duty) | unchanged · +0 | typed application code: `rawResult` keeps the mapped TypeScript type |
| The SQL of a query without running it | `future().getSql()`, `toSql()`, `toStatement()` | 0 statements | `logQueries` for this: it shows statements only as they run |

## Where settings live and which value wins

| Scope | Set through | Applies to |
|---|---|---|
| Connection | the client constructor: `statement_timeout`, pool size `max`, `max_lifetime` (postgres.js), `BunClient`'s `prepare` and `datesAsStrings`, `PGliteClient`'s `parsers` and `serializers` | every statement of that client → [Database clients](../database-clients.md) |
| Context | `new AppDatabase(client, options)`: `QueryOptions` | every query of that context and of the transactions it opens |
| Transaction | `db.transaction(fn, { timeoutMs, expectedExecutionMs })`: `TransactionOptions` | every statement of that transaction |
| Query | `withQueryOptions()` (tables), `withPreparedStatements()`, `withTimeout()`, `expectedExecutionTime()` | the derived table, or the one builder |
| Statement | `new QueryBatch().withPreparedStatements(bool)`; `insertFrom(source, map, { expectedErrorCodes })`; `client.query(text, params, { timeoutMs, prepare })` | one statement |
| Process | `LinkgressConfig`, `MockRowCache.setEnabled()` | every context in the process; the last write wins |

For each statement the first match in this order wins: the per-call value, the query's override, the
transaction, the context option, the connection, the library default (for the named-statement flag the
context's executor resolves it, internally `QueryExecutor.buildExecutionOptions()`):

| Setting | First match wins |
|---|---|
| Named statement | statement: `QueryBatch.withPreparedStatements()`, and a built-in `false` for `insertWithChildren`, `insertBulkWithChildren` and `MutationBatch` → query: `.withPreparedStatements()` → context: `preparedStatements` → `false` |
| Statement timeout | query: `.withTimeout()` (`PostgresClient`) → transaction: `timeoutMs` → connection: `statement_timeout` → none |
| Slow-statement threshold | query: `.expectedExecutionTime()` → transaction: `expectedExecutionMs`, else its `timeoutMs` → context: `longRunningQueryThreshold` → 10000 ms |
| Collection strategy | query: `withQueryOptions({ collectionStrategy })` → context: `collectionStrategy` → `'lateral'` |
| Any other `QueryOptions` key | query: `withQueryOptions()`, merged over the context's options (read only when the merged options contain an executor duty) → context → default |
| `inArrayOptThreshold`, `inArrayPadBuckets`, `inArrayUsesOpt` | the last write in the process, through `LinkgressConfig` or through any context constructed with the key |

## Configure a context: `QueryOptions`

`QueryOptions` is the second constructor argument of your `DbContext` subclass (`AppDatabase` in
these examples, see [Schema configuration](./schema-configuration.md)). It applies to every query of
the context and of the transactions it opens. Several contexts with different options can share one
client and its pool.

```ts
import { PostgresClient } from 'linkgress-orm';
import type { LogSection, QueryOptions, SlowQueryInfo } from 'linkgress-orm';
import { AppDatabase } from './app-database'; // your DbContext subclass

const client = new PostgresClient({
  host: 'localhost',
  database: 'app',
  user: 'app',
  password: 'secret',
  max: 10,                   // pool size
  statement_timeout: 10_000, // ms: server-side default for every statement of this client
});

const options: QueryOptions = {
  logFailedQueries: true,
  logger: (message: string, section?: LogSection) =>
    section === 'error' ? console.error(message) : console.log(message),
  onQueryTakingTooLong: (info: SlowQueryInfo) =>
    console.warn(`slow: ${info.durationMs.toFixed(0)} ms > ${info.thresholdMs} ms\n${info.sql}\n${info.stack}`),
  longRunningQueryThreshold: 2000,
};

const db = new AppDatabase(client, options);
```

Every key of `QueryOptions` (`src/entity/db-context.ts`):

| Key | Type · default | Effect | Takes effect when |
|---|---|---|---|
| `logQueries` | `boolean` · `false` | Logs each statement the executor sends: `'\n[SQL Query]'`, then the text, on `'sql'`. Also turns on the schema manager's progress lines | always (creates the executor) |
| `logParameters` | `boolean` · `false` | Adds `[Parameters] [...]` on `'params'` after each logged statement that has parameters, and appends them to the failure line | with `logQueries` / `logFailedQueries` |
| `logExecutionTime` | `boolean` · `false` | `[Execution Time] 1.81ms` on `'timing'` after each statement that succeeds | always (creates the executor) |
| `logFailedQueries` | `boolean` · value of `logQueries` | `[SQL Error] <driver message>` plus the statement on `'error'` for each failed statement | always (creates the executor) |
| `logger` | `(message: string, section?: LogSection) => void` · `defaultLogger` | Receives every line above. `defaultLogger`: `'error'` → `console.error`, `'warn'` → `console.warn`, anything else → `console.log` | with a logging duty or `traceTime`; the schema manager uses it whatever the duties (without one it falls back to `console.log`, not `defaultLogger`) |
| `onQueryTakingTooLong` | `(info: SlowQueryInfo) => void` · unset | Called after a statement that succeeded and ran longer than its threshold | always (creates the executor) |
| `longRunningQueryThreshold` | `number` (ms) · `10000` | The threshold for `onQueryTakingTooLong` | with `onQueryTakingTooLong` |
| `slowQueryStackTraceLimit` | `number` (frames) · `50` | Stack frames captured per statement while slow-statement detection is on; `0` captures none (`stack: ''`) | with `onQueryTakingTooLong` |
| `preparedStatements` | `boolean` · `false` | Sends parameterised statements named (`PostgresClient` only) | always (creates the executor) |
| `collectionStrategy` | `'lateral' \| 'cte' \| 'temptable'` · `'lateral'` | How collections in a projection are aggregated | always (read by the context) |
| `inArrayOptThreshold` | `number` · `8` | Writes `LinkgressConfig.inArrayOptThreshold`, process-wide | at construction |
| `inArrayPadBuckets` | `readonly number[] \| null` · `null` | Writes `LinkgressConfig.inArrayPadBuckets`, process-wide | at construction |
| `inArrayUsesOpt` | `boolean` · `false` | Writes `LinkgressConfig.inArrayUsesOpt`, process-wide | at construction |
| `traceTime` | `boolean` · `false` | Per-phase timing of one query (build, execution, result processing) on `'timing'` | always (creates the executor since 1.0.33; before, only beside an executor duty); [not on every read path](#read-raw-driver-values-or-time-one-query) |
| `disableMappers` | `boolean` · `false` | Results skip `fromDriver` (raw driver values); `toDriver` still converts bound values | always (creates the executor since 1.0.33; before, only beside an executor duty); [not on every read path](#read-raw-driver-values-or-time-one-query) |
| `rawResult` | `boolean` · `false` | Returns the driver's rows without any shaping | always (creates the executor since 1.0.33; before, only beside an executor duty); [not on every read path](#read-raw-driver-values-or-time-one-query) |
| `useBinaryProtocol` | `boolean` · `false` | Asks the client for a binary result protocol. Inert: no shipped client reads it (each one's `supportsBinaryProtocol()` is `false`) | never today; since 1.0.33 it creates the executor |

**Executor duty.** The context creates its executor (the object that logs, times and names
statements, and that the query builders read the result options from) only when one of
`logQueries`, `logFailedQueries`, `logExecutionTime`, `onQueryTakingTooLong`, `preparedStatements`
or, since 1.0.33, `disableMappers`, `rawResult`, `traceTime` or `useBinaryProtocol` is set. Without
one, statements go straight to the client. Before 1.0.33 the last four created no executor, so set
alone they were never read: `{ traceTime: true }` printed nothing and `{ disableMappers: true }` still
mapped. On an older install add `logFailedQueries: true`, which only acts when a statement fails.

`LoggingOptions` (an alias of `QueryOptions`) and `LogLevel` (an alias of `LogSection`) are deprecated.

## Log every statement while debugging: `logQueries`

`logQueries` reports each statement the context's executor sends; `logParameters` adds the bound
values and `logExecutionTime` the duration measured around the driver call. Use it to read the SQL a
code path runs and to count its round trips. To see SQL without running it, see
[See the SQL a query sends](#see-the-sql-a-query-sends).

```ts
import { eq } from 'linkgress-orm';

const lines: string[] = [];
const debugDb = new AppDatabase(client, {
  logQueries: true,
  logParameters: true,
  logExecutionTime: true,
  logger: (message: string, section?: LogSection) => {
    lines.push(`${section}: ${message}`);
  },
});

const alice = await debugDb.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ id: u.id, email: u.email }))
  .toList();
```

```sql
SELECT "users"."id" as "id", "users"."email" as "email"
FROM "users"
WHERE "users"."username" = $1
-- params: ["alice"]
```

The logger is called four times for this one statement:

| Call | `section` | `message` |
|---|---|---|
| 1 | `'sql'` | `'\n[SQL Query]'` |
| 2 | `'sql'` | the statement text, trimmed |
| 3 | `'params'` | `'[Parameters] ["alice"]'` (only with `logParameters`, only when there are parameters) |
| 4 | `'timing'` | `'[Execution Time] 2.56ms'` (only with `logExecutionTime`) |

> **Efficiency:** logging adds no statement. One `'\n[SQL Query]'` line is one statement the executor
> sent, so counting those lines counts its round trips; the statements listed below are not among them.

> **Pitfall:** never logged, because they do not go through the executor: `db.query()` and
> `client.query()`, `FutureQueryRunner.runAsync()`'s multi-statement message (and, before 1.0.33,
> `PreparedQuery.execute()`), statements on a `connect()` lease, the `BEGIN` / `COMMIT` of
> `db.transaction()`, the `begin` / `SET LOCAL` / `commit` that `PostgresClient` wraps around
> `.withTimeout()` (inside a transaction: `SHOW statement_timeout`, `SET LOCAL` and the restoring
> `SET LOCAL`), the `SET LOCAL` of `TransactionOptions.timeoutMs`, and the closing `DROP TABLE` of the
> `temptable` strategy on `PgClient` (6 statements, 5 logged).

## Record failed statements in production: `logFailedQueries`

`logFailedQueries` reports each statement that fails, on `'error'`, independently of `logQueries`, so a
production context can keep per-statement logging off and still record what broke. The default is the
value of `logQueries`.

```ts
const prodDb = new AppDatabase(client, {
  logFailedQueries: true, // logQueries stays off: nothing is logged for statements that succeed
  logger: (message: string, section?: LogSection) =>
    section === 'error' ? console.error(message) : console.log(message),
});

try {
  await prodDb.users.insert({ username: 'alice', email: 'alice2@example.com' }); // username is unique
} catch (error) {
  // still thrown: the logger received one 'error' line before
}
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2)
-- params: ["alice", "alice2@example.com"]
-- error: duplicate key value violates unique constraint "users_username_key"
```

The logger receives one call, section `'error'`:

```text
[SQL Error] duplicate key value violates unique constraint "users_username_key"
INSERT INTO "users" ("username", "email") VALUES ($1, $2)
```

With `logParameters: true` the same call ends with a third line, `[Parameters] ["alice","alice2@example.com"]`.

| `logQueries` | `logFailedQueries` | Statement succeeds | Statement fails |
|---|---|---|---|
| `false` | unset | nothing | nothing |
| `false` | `true` | nothing | the `[SQL Error]` line |
| `true` | unset (= `true`) | `[SQL Query]` + text | `[SQL Query]` + text, then the `[SQL Error]` line: the text twice |
| `true` | `false` | `[SQL Query]` + text | `[SQL Query]` + text only |

A statement that is expected to fail now and then, such as a unique violation the caller retries, can
name its SQLSTATEs: `insertFrom(source, map, { expectedErrorCodes: ['23505'] })` still throws such a
failure but does not report it; any other failure is reported. The option travels with the one
statement (`StatementExecutionOptions.expectedErrorCodes`). See
[Insert, update, delete](./insert-update-guide.md).

## Route log lines: `logger` and `LogSection`

The second argument of `logger` says what is being logged, so one function can route or drop whole
categories. The schema manager (`db.getSchemaManager()`) logs through the same `logger`; on a context
without a `logger` it writes every line, whatever its section, with `console.log`.

```ts
const routedDb = new AppDatabase(client, {
  logQueries: true,
  logFailedQueries: true,
  logger: (message: string, section?: LogSection) => {
    switch (section) {
      case 'error': console.error(message); break;
      case 'warn': console.warn(message); break;
      case 'sql': case 'params': case 'timing': console.debug(message); break;
      default: console.info(message); // schema-manager progress lines have no section
    }
  },
});
```

| `LogSection` | Lines | Sent when |
|---|---|---|
| `'sql'` | `'\n[SQL Query]'` then the text; `'\n[SQL Query - Multi-Statement]'` / `'\n[SQL Query - Fully Optimized Multi-Statement]'` before the multi-statement messages of the `temptable` strategy | `logQueries` |
| `'params'` | `'[Parameters] [...]'` | `logQueries` and `logParameters`, statement with parameters |
| `'timing'` | `'[Execution Time] …ms'`; the `traceTime` summary | `logExecutionTime`; `traceTime` |
| `'error'` | `'[SQL Error] <message>\n<statement>'`, plus `'\n[Parameters] [...]'` with `logParameters` | `logFailedQueries` |
| `'warn'` | schema-manager warnings (skipped drops, an INVALID index left alone) | schema manager |
| `'info'` | progress of `MigrationRunner` (its own `logger` and `verbose` options) and `EnumMigrator` | those tools, not the context |
| `'slow'` | declared, never sent: slow statements reach only `onQueryTakingTooLong` | never |
| none | schema-manager progress: the `ensureCreated()` / `ensureDeleted()` lines (`Creating table …`) only while `logQueries` is on, the `analyze()` / `migrate()` lines always | schema manager |

## Get notified about slow statements: `onQueryTakingTooLong`

Setting the callback turns detection on. It runs after a statement that succeeded and took longer than
its threshold (a statement that fails, a cancelled one included, is never reported) and receives the
user call stack that started it (library frames removed, so the top frame is the line that called
`toList()`, `firstOrDefault()`, `count()`, …). It never cancels anything: to cancel, see the next section.

```ts
import { gt } from 'linkgress-orm';

const watchedDb = new AppDatabase(client, {
  onQueryTakingTooLong: (info: SlowQueryInfo) => {
    console.warn(`slow statement: ${info.durationMs.toFixed(0)} ms (budget ${info.thresholdMs} ms)`, info.sql, info.params, info.stack);
  },
  longRunningQueryThreshold: 2000, // ms; default 10000
  slowQueryStackTraceLimit: 10,    // frames; default 50; 0 = no stack capture
});

// this report may run 30 s before the callback fires
const report = await watchedDb.orders
  .expectedExecutionTime(30_000)
  .where(o => gt(o.totalAmount, 100))
  .select(o => ({ id: o.id, status: o.status, totalAmount: o.totalAmount }))
  .toList();
```

```sql
SELECT "orders"."id" as "id", "orders"."status" as "status", "orders"."total_amount" as "totalAmount"
FROM "orders"
WHERE "orders"."total_amount" > $1
-- params: [100]
```

`SlowQueryInfo`:

| Field | Type | Content |
|---|---|---|
| `sql` | `string` | the statement text |
| `params` | `any[] \| undefined` | its parameters |
| `durationMs` | `number` | measured around the driver call (network included) |
| `thresholdMs` | `number` | the threshold it exceeded |
| `stack` | `string` | user frames, top frame first; `''` when `slowQueryStackTraceLimit` is `0` |

The threshold of a statement: `.expectedExecutionTime(ms)` on its table or builder, else the
transaction's `expectedExecutionMs` (which defaults to the transaction's `timeoutMs`), else
`longRunningQueryThreshold`, else 10000 ms. `expectedExecutionTime()` exists on tables and on the
select, join, grouped, union and CTE-rooted builders.

> **Efficiency:** while the callback is set, a stack is captured for every statement (about 1 ms per 50
> statements at depth 50 on a deep async chain); the string is formatted only for a slow one. Lower
> `slowQueryStackTraceLimit` on hot paths.

> **Pitfall:** only statements that go through the executor are timed: `db.query()` and
> `FutureQueryRunner`'s multi-statement message are not (a `prepare()`d query's executions are, since
> 1.0.33). An error thrown by the callback is swallowed.

## Cancel statements that run too long: `withTimeout()` and `statement_timeout`

PostgreSQL cancels a statement that exceeds `statement_timeout`. Set a default for every statement of
a client in its constructor, raise or lower it for one transaction with
`TransactionOptions.timeoutMs`, or for one query with `.withTimeout(ms)` (`PostgresClient` only).

| Tool | Scope | Added statements | Error on cancellation | Clients |
|---|---|---|---|---|
| `statement_timeout` (ms) in the client constructor | every statement of the client | 0 | `QueryTimeoutError` on `PostgresClient`; the driver's error (code `57014`) on `PgClient` | `PostgresClient`, `PgClient` |
| `db.transaction(fn, { timeoutMs })` | every statement of the transaction, bulk writes included; `0` lifts the limit for the transaction | +1: `SET LOCAL statement_timeout = N` after `begin` | `QueryTimeoutError` on `PostgresClient`; the driver's error (`57014`) on `PgClient`, `BunClient` | every client sends it; `PGliteClient` cannot cancel |
| `.withTimeout(ms)` on a table or builder | that query, or every query and write started from the derived table | +3 | `QueryTimeoutError` | `PostgresClient`; ignored by `PgClient`, `BunClient`, `PGliteClient` |

```ts
import { QueryTimeoutError } from 'linkgress-orm';

try {
  const popular = await db.posts
    .where(p => gt(p.views, 100))
    .select(p => ({ id: p.id, title: p.title }))
    .withTimeout(5000) // ms; PostgresClient only; 0 lifts the connection default for this query
    .toList();
} catch (error) {
  if (error instanceof QueryTimeoutError) {
    console.warn(`cancelled after ${error.timeoutMs} ms`, error.sql, error.cause);
  }
  throw error;
}
```

On `PostgresClient` the query sends four statements. `SET LOCAL` ends with the wrapping transaction,
so the limit cannot leak to other queries on the pooled connection:

```sql
-- illustrative (not captured): PostgresClient's wrapper; the harness runs PgClient, which ignores withTimeout(). Statements as postgres.js's debug hook printed them
begin
SET LOCAL statement_timeout = 5000
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [100]
commit
```

Inside a transaction `PostgresClient` cannot open a transaction of its own to scope `SET LOCAL`, so it
reads the current value first and restores it after the statement:

```ts
await db.transaction(async tx => {
  await tx.posts.where(p => gt(p.views, 100)).select(p => ({ id: p.id })).withTimeout(1000).toList();
});
```

```sql
-- illustrative (not captured): PostgresClient only, as postgres.js's debug hook printed it; the restored value is what SHOW returned ('0' here, '30s' under a transaction timeoutMs of 30000)
begin
SHOW statement_timeout
SET LOCAL statement_timeout = 1000
SELECT "posts"."id" as "id"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [100]
SET LOCAL statement_timeout = '0'
commit
```

A cancelled statement aborts the transaction it runs in, as any failed statement does: catching the
`QueryTimeoutError` inside the callback does not let the transaction continue.

A transaction-wide limit covers every statement, including bulk writes that have no `.withTimeout()`
and `QueryBatch` statements:

```ts
await db.transaction(async tx => {
  await tx.posts.where(p => gt(p.views, 100)).select(p => ({ id: p.id })).toList();
  await tx.tags.insert({ name: 'Autumn' });
}, { timeoutMs: 30_000 }); // every statement of the transaction; expectedExecutionMs defaults to it
```

The transaction's statements, after the `BEGIN` the driver sends (and before its `COMMIT`; neither is
captured):

```sql
SET LOCAL statement_timeout = 30000
SELECT "posts"."id" as "id"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [100]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: ["Autumn"]
```

`QueryTimeoutError` carries `timeoutMs` (the limit that was exceeded; for a cancellation by the
connection default or by a transaction's `timeoutMs`, the client's `statement_timeout`, `0` when the
client cannot read it), `sql` and `cause` (the driver error). The raw client takes the same option per
call: `db.getClient().query(text, params, { timeoutMs: 2000 })` (`PostgresClient` wraps it the same way).

> **Efficiency:** the client-level `statement_timeout` costs nothing per query. `.withTimeout()` costs 3
> extra statements and, at the root, a transaction per execution. Prefer the client default and use
> `.withTimeout()` for the exceptions.

> **Pitfall:** a `QueryBatch` refuses a leg that has its own `.withTimeout()` next to plain legs. To limit
> a batch, start every leg from one derived table (`const timed = db.posts.withTimeout(5000)`) or run the
> batch inside `db.transaction(fn, { timeoutMs })`. See
> [Override options for one table or query](#override-options-for-one-table-or-query).

## Send statements named on the server: `preparedStatements`

postgres.js sends `unsafe()` statements unnamed, and `PostgresClient` runs every statement through
`unsafe()`, so by default each parameterised statement is parsed, described (an extra round trip
before Bind/Execute) and planned on every execution. `preparedStatements: true` sends them named: the
server parses each distinct text once per connection and can reuse its plan (a generic plan, after
five executions; see [Measure before turning it on](#measure-before-turning-it-on)), and every
execution after the first skips the describe round trip. A 16 KB cart read measured 7.35 ms
unprepared and 0.95 ms prepared on one connection (planning was 5.3 ms of it).

```ts
const preparedDb = new AppDatabase(client, { preparedStatements: true }); // PostgresClient; default false

await preparedDb.users.where(u => eq(u.id, 1)).select(u => ({ id: u.id, username: u.username })).toList();
await preparedDb.users.where(u => eq(u.id, 2)).select(u => ({ id: u.id, username: u.username })).toList();
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
-- params: [1]
```

The second call sends the same text with `[2]`. Afterwards `pg_prepared_statements` on that connection
holds this text once, besides postgres.js's own named statements.

`.prepare('name')` with `sql.placeholder()` is a different thing: a client-side query object built once
and executed with new values ([Batching and prepared queries](./batching-and-prepared-queries.md)).
Since 1.0.33 the two combine: a prepared query's executions run through the context's executor, so on a
`preparedStatements: true` context each execution is the named statement, the hot-path form on
`PostgresClient` ([Run one query shape many times](./batching-and-prepared-queries.md#run-one-query-shape-many-times-prepare-and-preparedstatements)).
Before 1.0.33 `PreparedQuery.execute()` bypassed the executor and was always sent unnamed.

### Opt one query in or out: `withPreparedStatements()`

The override works both ways: `false` keeps a statement whose text varies per request unnamed on a
prepared context, `true` names one hot lookup on an unprepared context.

```ts
import type { IEntityQueryable } from 'linkgress-orm';
import type { Order } from './model/order'; // an entity class of your model

// prepared context: this paging text varies per request, so keep it unnamed
const page = await preparedDb.orders
  .where(o => gt(o.totalAmount, 10))
  .select(o => ({ id: o.id, status: o.status }))
  .orderBy(o => o.id)
  .limit(25)
  .offset(0)
  .withPreparedStatements(false)
  .toList();

// unprepared context: name this one hot lookup
const summer = await db.tags.withPreparedStatements(true).where(t => eq(t.name, 'Summer')).firstOrDefault();

// a helper that receives a built query
function readPage(query: IEntityQueryable<Order>, pageNo: number) {
  return query
    .orderBy(o => o.createdAt)
    .limit(25)
    .offset(pageNo * 25)
    .withPreparedStatements(false)
    .toList();
}
```

```sql
SELECT "orders"."id" as "id", "orders"."status" as "status"
FROM "orders"
WHERE "orders"."total_amount" > $1
ORDER BY "id" ASC
LIMIT 25 OFFSET 0
-- params: [10]
```

```sql
SELECT "tags"."id" as "id", "tags"."name" as "name"
FROM "tags"
WHERE "tags"."name" = $1
LIMIT 1
-- params: ["Summer"]
```

Verified with `pg_prepared_statements`: the orders page was not named, the tags lookup was.

| Where | Form | Covers |
|---|---|---|
| `DbEntityTable` | `db.users.withPreparedStatements(false)` | a derived table: every query and write started from it |
| `QueryBuilder`, `SelectQueryBuilder` (what a table's `where()`, `select()`, `innerJoin()` and `leftJoin()` return, typed `IEntityQueryable` / `EntitySelectQueryBuilder`); the exported `JoinQueryBuilder` has it too | `query.withPreparedStatements(false)` | that builder (changed in place): `toList()`, `count()`, `countOver()`, `firstOrDefault()`, …, and (since 1.0.33) a `prepare()` called after it |
| grouped queries | set it before `.groupBy()` | carried into the grouped query (verified) |
| unions | set it on the first leg before `.union()` / `.unionAll()` | the union runs on its first leg's executor (verified) |
| `QueryBatch` | `new QueryBatch().withPreparedStatements(false)` | the batch's one statement, whatever the legs' context says |

`withPreparedStatements()`, `withTimeout()` and `expectedExecutionTime()` combine in any order: each
keeps the values the others set. A paging grid is the typical `false` case: its text changes with
offsets (`LIMIT` and `OFFSET` are written into the text as literals, `LIMIT 25 OFFSET 0` above), sort
columns and filter combinations, it runs a few times a minute, and every distinct text of a named
statement is one more cached plan on every pooled connection.

### Statements that are never named

- Clients other than `PostgresClient`: `PgClient` and `PGliteClient` ignore the option; `BunClient`
  ignores it too (Bun.SQL's own `prepare` constructor option decides, default `true`). A postgres.js
  instance created with `prepare: false` ignores it.
- `insertWithChildren`, `insertBulkWithChildren` and the fused `MutationBatch` statement: their text
  embeds a per-call `VALUES` list, so a named statement would be created per variant and never reused.
- Statements without parameters: postgres.js sends them over the simple protocol (verified).
- Paths that bypass the executor: `db.query()`, `FutureQueryRunner`'s multi-statement message. A
  `QueryBatch`, `future().execute()` and (since 1.0.33) `PreparedQuery.execute()` go through it and are
  named; before 1.0.33 `PreparedQuery.execute()` bypassed it and was never named.

### Measure before turning it on

After five executions PostgreSQL may switch a named statement to a generic plan
(`plan_cache_mode = auto`). That suits statements with uniform selectivity (primary-key and foreign-key
lookups) and can hurt wide analytical shapes: a 19 KB catalogue query with 1,560 parameters ran slower
prepared than unprepared, because the generic plan lost to the hand-tuned custom plan. Opt those out
with `.withPreparedStatements(false)`.

- Read `pg_prepared_statements` (`generic_plans`, `custom_plans`) and `pg_stat_statements` (`calls`
  against `plans`, with `track_planning = on`) on the target database before and after.
- Pair the option with a connection `max_lifetime` so per-connection statement caches are recycled.
- Bound statement-text variety: an `IN ($1, $2, …)` list is one text per length. That is what
  [`LinkgressConfig`](#bound-the-statement-texts-of-list-filters-linkgressconfig) bounds.
- Prefer explicit column lists in statements that run inside transactions. A cached plan whose result
  shape changed (`SELECT *` over a table that gained a column) is rejected once and re-prepared by
  postgres.js; inside an explicit transaction that retry lands on an aborted transaction. The builders
  already emit explicit columns.

## Choose how collections load: `collectionStrategy`

`collectionStrategy` decides how a collection inside a projection (`u.posts!.select(...).toList()`) is
aggregated, and with it how many statements a read sends. Set it per context, or per query with
`withQueryOptions()`; [Collection strategies](../collection-strategies.md) compares the plans.

```ts
const cteDb = new AppDatabase(client, { collectionStrategy: 'cte' }); // every query of this context

// one query of the default (lateral) context
const usersWithPosts = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .where(u => gt(u.id, 0))
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title })).toList('posts'),
  }))
  .toList();
```

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title"
  FROM "posts"
) sub
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
WHERE "users"."id" > $1
-- params: [0]
```

| Strategy | Statements per read |
|---|---|
| `'lateral'` (default) | 1: a `LEFT JOIN LATERAL` per collection list; a scalar aggregate such as `count()` renders as a correlated subquery |
| `'cte'` | 1: a `WITH` per collection, joined on `parent_id` |
| `'temptable'` | `PgClient`: 1 + 5 per collection when the base query returns rows (6 for the query above); `PostgresClient`, `BunClient`, `PGliteClient`: 1 multi-statement message when the base query binds no parameters and every collection is a plain `toList()` of its own unmapped integer, floating-point, boolean, text, uuid or json columns (no `where()`, `limit()`, aggregate or navigation), else the base query + 1 multi-statement message per collection |

> **Pitfall:** do not use `temptable` inside `db.transaction()` on `PostgresClient`, `BunClient` or
> `PGliteClient`. A base query without parameters fails with `Fully optimized mode requires
> querySimpleMulti support` (with `querySimpleMulti not supported by this client` when the context has
> an executor duty); on `PostgresClient` a base query with parameters returned every collection empty,
> without an error (both verified with postgres.js over the in-memory database). Use `lateral` or `cte`
> inside transactions.

## Override options for one table or query

| Method | Available on | Returns | Effect |
|---|---|---|---|
| `withQueryOptions(options)` | `DbEntityTable` only | a derived table | `options` merged over the context's `QueryOptions`; a new executor only when the merged options contain an executor duty (see the pitfalls below) |
| `withPreparedStatements(bool)` | `DbEntityTable`; `QueryBuilder`, `SelectQueryBuilder` (join chains included), `JoinQueryBuilder`; `QueryBatch` | derived table / the same builder | named or unnamed statement |
| `withTimeout(ms)` | `DbEntityTable`; `QueryBuilder`, `SelectQueryBuilder`, `JoinQueryBuilder`, `GroupedQueryBuilder`, `GroupedSelectQueryBuilder`, `GroupedJoinedQueryBuilder`, `UnionQueryBuilder`, `CteRootQueryBuilder` | derived table / the same builder | `SET LOCAL statement_timeout` around the statement (`PostgresClient`); `0` lifts the connection default |
| `expectedExecutionTime(ms)` | the same as `withTimeout()` | derived table / the same builder | the slow-statement threshold; never cancels |

On a table the method returns a new derived table and `db.<table>` itself is unchanged; every query and
write started from the derived table, and (since 1.0.30) its `selectFromCte()` and `selectFromSet()`,
use the derived executor. On a builder the method changes the builder and returns it.

```ts
const verboseUsers = db.users.withQueryOptions({ logQueries: true }); // a derived table; db.users is unchanged
await verboseUsers.where(u => eq(u.id, 2)).select(u => ({ id: u.id })).toList(); // logged
await db.posts.where(p => eq(p.id, 1)).select(p => ({ id: p.id })).toList();     // not logged

const query = db.users.where(u => gt(u.id, 0)).select(u => ({ id: u.id }));
const same = query.withTimeout(5000) === query; // true: a builder override changes the builder itself
```

`withQueryOptions()` merges: on a context with `logFailedQueries: true` and a `logger`, the derived table
above logs its statements through that logger (verified).

A derived executor is a different execution context, so a `QueryBatch` (and
`FutureQueryRunner.runAsync()`) refuses a leg that has one next to plain legs, before sending anything.
The message names the first leg whose context differs from the first leg's (here a plain `users` leg
was added first, then a `posts` leg of `db.posts.withTimeout(5000)`):

```text
QueryBatch: query "posts" uses a different database client or transaction than the rest of the batch — all queries must share one connection context
```

Legs started from one derived table share its executor, so the batch below runs as one
`SELECT … UNION ALL …` statement:

```ts
import { QueryBatch } from 'linkgress-orm';

const timedPosts = db.posts.withTimeout(5000);
const batch = new QueryBatch();
const popular = batch.addList(timedPosts.where(p => gt(p.views, 100)).select(p => ({ id: p.id })), 'popular');
const total = batch.addCount(timedPosts, 'total');
await batch.executeBatch();
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "posts"."id" as "id"
FROM "posts"
WHERE "posts"."views" > $1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count
FROM "posts"
) __batch_q
-- params: [100]
```

On `PostgresClient` that statement runs between `begin`, `SET LOCAL statement_timeout = 5000` and
`commit`: the derived table's timeout covers the whole batch (verified with postgres.js's `debug` hook).

> **Pitfall:** call `withQueryOptions()` before the other three. When the merged options contain an
> executor duty, it builds a fresh executor and drops a `withTimeout()`, `withPreparedStatements()` or
> `expectedExecutionTime()` set before it on the same table (verified:
> `db.users.withTimeout(5000).withQueryOptions({ logFailedQueries: true })` sent no `SET LOCAL`;
> `db.users.withQueryOptions({ logFailedQueries: true }).withTimeout(5000)` did). Since 1.0.33 a result
> option alone does the same: after `db.users.withTimeout(5000).withQueryOptions({ disableMappers: true })`
> the executor handed the client no timeout, in the other order `timeoutMs: 5000`.

> **Pitfall:** `withQueryOptions({ logQueries: false })` cannot mute a context whose only executor duty is
> `logQueries`: the merged options then have no duty, and the context's logging executor is kept
> (verified: both lines still logged). Pass another duty with it
> (`{ logQueries: false, logFailedQueries: true }` logs nothing for a statement that succeeds), or build a
> second context without logging.

## Bound the statement texts of list filters: `LinkgressConfig`

`inArrayOpt` and its siblings are plain functions used inside `where()` lambdas with no context in
reach, so their settings are process-wide. `LinkgressConfig` is the only exported way to set them (each
setting is a static property you can also read back); a context constructed with the `QueryOptions`
keys of the same names writes the same values. The rows are identical under every setting; only the
statement text changes. List matching itself is covered in
[Querying](./querying.md).

```ts
import { LinkgressConfig, inArray, inArrayOpt } from 'linkgress-orm';

LinkgressConfig.inArrayOptThreshold = 8;                // default 8
LinkgressConfig.inArrayPadBuckets = [1, 2, 8];          // opt-in; default null
LinkgressConfig.inArrayUsesOpt = true;                  // opt-in; default false
LinkgressConfig.configure({ inArrayOptThreshold: 12 }); // several at once; omitted keys keep their value
LinkgressConfig.resetToDefaults();                      // back to 8, null, false

const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const products = await db.products
  .where(p => inArrayOpt(p.id, nine))
  .select(p => ({ id: p.id, name: p.name }))
  .toList();
```

```sql
SELECT "products"."id" as "id", "products"."name" as "name"
FROM "products"
WHERE ("products"."id" = ANY($1::integer[]))
-- params: ["{1,2,3,4,5,6,7,8,9}"]
```

At or below the threshold `inArrayOpt` renders an exact-length list (`[1, 2, 3]` gives
`WHERE "products"."id" IN ($1, $2, $3)`); above it, one array parameter bound as a PostgreSQL array
literal. `eqAny()` / `neAll()` always render the array form; use them to decide at the call site
instead of through these settings.

| Setting | Default | Effect | Valid values |
|---|---|---|---|
| `inArrayOptThreshold` | `8` (`LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD`) | list length up to which `inArrayOpt` / `notInArrayOpt` render `IN (…)`; above it `= ANY($1::type[])` / `<> ALL($1::type[])`. `0` sends every non-empty list to the array form | a non-negative integer |
| `inArrayPadBuckets` | `null` (one text per length) | rounds a list that renders as `IN (…)` up to the next rung, repeating its last element; a list longer than the top rung is widened to the threshold. `LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS` is `[1, 4, 8]`, a ladder to assign, not applied by default | positive integers, strictly ascending, stored as a frozen copy (changing the array you passed changes nothing); `null` switches padding off |
| `inArrayUsesOpt` | `false` | plain `inArray` / `notInArray` render what `inArrayOpt` / `notInArrayOpt` render | a boolean |

With `inArrayPadBuckets = [1, 2, 8]` three ids fill the rung of 8:

```ts
LinkgressConfig.inArrayPadBuckets = [1, 2, 8];
await db.products.where(p => inArrayOpt(p.id, [1, 2, 3])).select(p => ({ id: p.id, name: p.name })).toList();
```

```sql
SELECT "products"."id" as "id", "products"."name" as "name"
FROM "products"
WHERE "products"."id" IN ($1, $2, $3, $4, $5, $6, $7, $8)
-- params: [1, 2, 3, 3, 3, 3, 3, 3]
```

With `inArrayUsesOpt = true` a plain `inArray` call site you did not touch renders the opt form:

```ts
LinkgressConfig.inArrayUsesOpt = true;
await db.products.where(p => inArray(p.id, [1, 2, 3, 4, 5, 6, 7, 8, 9])).select(p => ({ id: p.id, name: p.name })).toList();
```

```sql
SELECT "products"."id" as "id", "products"."name" as "name"
FROM "products"
WHERE ("products"."id" = ANY($1::integer[]))
-- params: ["{1,2,3,4,5,6,7,8,9}"]
```

An invalid value throws and keeps the current one, for example
`inArrayOpt threshold must be a non-negative integer, got -1` and
`inArrayOpt pad buckets must be in strictly ascending order, got [4, 2]`.

> **Efficiency:** an `IN` list gives the planner an exact row estimate and, under `preparedStatements`,
> one cached plan per length; the array form is one text for every length. A padded statement is planned
> for its rung: measured on PostgreSQL 18 that is free from three elements up and costs about 32 % on
> one-element and 26 % on two-element lists, so keep the low rungs tight. `[1, 2, 8]` pays nothing and
> gives as many texts as `[1, 4, 8]`.

> **Pitfall:** the last write wins for the whole process. `new AppDatabase(client, { inArrayOptThreshold: 2 })`
> changed the SQL of every other context too (verified). Set these once at boot.

## Cut query-build CPU: `MockRowCache`

Building a query (the mock rows a selector lambda walks, the navigation-path search behind them, the
lateral SQL of collections) can be memoised because schemas do not change after registration. One
switch, off by default, turns on all three caches. The SQL and the results are identical either way
(verified); the CPU and garbage per query build drop.

A mock-row prototype holds what its builder read of the model: column names, relations, mappers. Since 1.0.31 its
cache key carries the model, the `DbContext` subclass, besides the table (and the navigation path): every instance of
one context class shares the prototypes, and two context classes that name a table alike each build their own. Before
1.0.31 the key was the table name, so with the cache on the second class's rows read the first class's columns,
relations and mappers. Verified with two context classes whose `members` entity maps the property `name` to different
columns: with `ShopA`'s prototypes cached, `ShopA` rendered `"members"."name"` and `ShopB` `"members"."full_name"`, and a
second `ShopB` instance added no entry. A context built on the internal schema-first `DataContext` still shares by
table name.

```ts
import { LateralSqlCache, MockRowCache, NavigationPathCache } from 'linkgress-orm';

MockRowCache.setEnabled(true); // once at boot: switches on all three caches

MockRowCache.diagnostics();        // { enabled, entries, maxEntries: 2000 }
NavigationPathCache.diagnostics(); // { enabled, entries, maxEntries: 5000 }
LateralSqlCache.diagnostics();     // { enabled, entries, maxEntries: 2000 }

MockRowCache.reset();              // tests: drop its entries AND switch all three off
```

| Cache | Memoises | Bound (beyond it, builds run uncached) | `reset()` |
|---|---|---|---|
| `MockRowCache` | mock-row prototypes per signature: the model (the `DbContext` class, since 1.0.31), the table, the navigation path | 2,000 entries | drops entries and switches all three caches off |
| `NavigationPathCache` | the navigation-path search | 5,000 entries across all contexts; the count falls only on `NavigationPathCache.reset()` (a dropped context's entries are garbage-collected but stay counted) | drops entries only |
| `LateralSqlCache` | the rendered SQL of each lateral collection shape | 2,000 entries | drops entries only |

`NavigationPathCache` and `LateralSqlCache` have no switch of their own: their `diagnostics()` and
`LateralSqlCache.isEnabled()` report `MockRowCache`'s.

> **Efficiency:** on a checkout burst (30 to 100 concurrent order writes, one process) the switch moved
> throughput from 42–45 to 92–104 orders/s, sequential p50 from 99 to 76 ms, and GC self time down
> 77 % (measured in 0.4.67, when it switched the mock-row cache alone). It never changes round trips or
> database time. The cost is retained memory within the bounds
> above; leave it off when the process builds mostly one-off query shapes.

## Read raw driver values or time one query

`disableMappers`, `rawResult` and `traceTime` are read from the executor, and since 1.0.33 each of them
creates it on its own, in the context's options and in `withQueryOptions()`. Before 1.0.33 they took
effect only next to an executor duty (`logFailedQueries: true` was enough) and were ignored alone. The
select-query builder (`where()`, `select()`, join chains) reads them, though not on every one of its
terminal methods, and since 1.0.33 a table's own `toList()`, `first()` and `firstOrDefault()` read
`rawResult` and `disableMappers` too: the table below says which read paths apply each key (each path
verified on the harness, with the key set alone).

```ts
const exportDb = new AppDatabase(client, { disableMappers: true });
const rows = await exportDb.posts
  .where(p => eq(p.id, 1))
  .select(p => ({ id: p.id, publishTime: p.publishTime }))
  .toList();
```

```sql
SELECT "posts"."id" as "id", "posts"."publish_time" as "publishTime"
FROM "posts"
WHERE "posts"."id" = $1
-- params: [1]
```

Result: `[{ id: 1, publishTime: 570 }]`, the stored `smallint`. Without `disableMappers` the column's
custom mapper returns `{ hour: 9, minute: 30 }`.

| Key | Returns | Applied by | Not applied by |
|---|---|---|---|
| `disableMappers` | raw driver values, collection items included, and a collection's `min()` / `max()` of a mapped column (which reads through the mapper since 1.0.31); bound values still go through `toDriver` (`eq(p.publishTime, { hour: 9, minute: 30 })` still binds `570`) | `toList()`, `first()`, `firstOrDefault()`, `countOver()`; the select builder's `min()` / `max()` (the stored value, `1125`, since 1.0.33); a union (through its first leg); `future()` and `QueryBatch` legs; a `prepare()`d query's `execute()`; a table's own `toList()`, `first()`, `firstOrDefault()` (since 1.0.33: stored values under the property names) | grouped selects; CTE- and set-rooted queries |
| `rawResult` | the driver's rows: no mapping, no nested-object reconstruction (a collection stays what the driver made of its JSON); the TypeScript result type stays the mapped one | `toList()`, `first()`, `firstOrDefault()`, `countOver()`; the select builder's `sum()` / `min()` / `max()` (the driver's value, `'450'`); a `prepare()`d query's `execute()`; a table's own `toList()`, `first()`, `firstOrDefault()` (since 1.0.33: the driver's rows, keyed by the database column names) | unions; `future()` and `QueryBatch` legs; grouped selects; CTE- and set-rooted queries |
| `traceTime` | a per-phase summary on `'timing'`: total, query build, query execution, result processing, rows, and detailed entries over 0.1 ms | `toList()`, `first()`, `firstOrDefault()`, `countOver()` | `count()`, `exists()`, `sum()` / `min()` / `max()`, a `prepare()`d query's `execute()`, unions, futures, grouped selects, CTE- and set-rooted queries, a table's own reads |

A table's own reads keep their own column naming under `rawResult` (since 1.0.33):

```ts
const raw = await db.posts.withQueryOptions({ rawResult: true }).firstOrDefault();
// { id: 1, title: 'Alice Post 1', …, user_id: 1, …, publish_time: 570, … }: database column names
const stored = await db.posts.withQueryOptions({ disableMappers: true }).first();
// { id: 1, title: 'Alice Post 1', …, userId: 1, …, publishTime: 570, … }: property names, stored values
```

```sql
SELECT "id", "title", "subtitle", "content", "user_id", "published_at", "views", "publish_time", "custom_date", "string_stamped_at", "category" FROM "posts" LIMIT 1

SELECT "id", "title", "subtitle", "content", "user_id", "published_at", "views", "publish_time", "custom_date", "string_stamped_at", "category" FROM "posts" LIMIT 1
```

Per query, pass them through `withQueryOptions()`:

```ts
const lines: string[] = [];
await db.posts
  .withQueryOptions({ traceTime: true, logger: (message: string) => { lines.push(message); } })
  .where(p => eq(p.id, 1))
  .select(p => ({ id: p.id, title: p.title }))
  .toList();
```

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."id" = $1
-- params: [1]
```

`lines` then holds `'timing'` messages (shown trimmed): the summary `[Time Trace Summary]`,
`Total: …ms`, `Query Build: …ms`, `Query Execution: …ms`, `Result Processing: …ms` and `Rows: 1`, then
`[Detailed Trace]` with one line per operation that took over 0.1 ms; on the harness that was one line,
`[queryExecution] executeQuery: …ms ({"rowCount":"pending"})` (eight messages in all; the detailed
part varies with timing). Use it to decide whether time goes to building (→ `MockRowCache`), to the
database, or to result processing (→ `disableMappers` for an export). `TimeTracer`, `QueryTimeTrace`
and `TimeTraceEntry` are exported for the same data.

`useBinaryProtocol` asks the client for a binary result protocol. No shipped client supports one
(`pg`'s `rowMode: 'array'` is not a binary protocol and would break name-based result mapping), so
the key is inert; `BunClient`'s binary or text decoding is chosen by its own `prepare` option. Since
1.0.33 it creates the executor like the keys above, so a `withQueryOptions({ useBinaryProtocol: true })`
leg cannot share a `QueryBatch` with plain legs.

## See the SQL a query sends

Read a query's text and parameters without running it, or log the statements as they run.

| What | Call | Statements sent |
|---|---|---|
| a select, where, join, grouped select or union | `query.future().getSql()`, `query.future().getParams()` | 0 |
| a union, a `selectFromCte()` or `selectFromSet()` root | `.toSql()` (text only) | 0 |
| `insert()`, `insertBulk()`, `insertFrom()`, `where(…).update(…)`, `where(…).delete()` | `.toStatement(selector?)` → `{ sql, params }` | 0 |
| a `prepare()`d query | `prepared.getSql()` | 0 |
| everything the executor sends, as it runs | `logQueries: true` (+ `logParameters`) | the statements themselves |

```ts
const query = db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, username: u.username, postCount: u.posts!.count() }));
const text = query.future().getSql();      // nothing is sent
const params = query.future().getParams(); // [30]

const insert = db.tags.insert({ name: 'Spring' }).toStatement(t => ({ id: t.id })); // { sql, params }
```

`text`:

```sql
SELECT "users"."id" as "id", "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount"
FROM "users"
WHERE "users"."age" > $1
```

`insert`: `{ sql: 'INSERT INTO "tags" ("name") VALUES ($1) RETURNING "id" AS "id"', params: ['Spring'] }`.

Select builders have no `toSql()` / `getSql()` of their own; go through `future()`. For a plan, run
``db.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params)`` against a real server. `EXPLAIN (ANALYZE …)` executes the
statement: for an insert, update or delete use plain `EXPLAIN`, or run the `ANALYZE` form inside a transaction you
roll back. A `QueryBatch`, a
`temptable` read or a `.withTimeout()` wrapper sends other statements than a leg's `getSql()` shows:
observe those with `logQueries` (the batch, and the `temptable` statements except the closing
`DROP TABLE` on `PgClient`) or with postgres.js's `debug` option (`begin`, `SET LOCAL`, `commit`).

## Recipes

**Production web app**: quiet logs, failures and slow statements still reported.

```ts
const prod = new AppDatabase(client, {
  logFailedQueries: true,
  onQueryTakingTooLong: info => console.warn(`slow ${info.durationMs.toFixed(0)} ms\n${info.sql}\n${info.stack}`),
  longRunningQueryThreshold: 2000,
  slowQueryStackTraceLimit: 10,
});
```

**Hot OLTP path on postgres.js** with stable statement texts:

```ts
MockRowCache.setEnabled(true);
LinkgressConfig.configure({ inArrayPadBuckets: [1, 2, 8], inArrayUsesOpt: true });

const oltp = new AppDatabase(
  new PostgresClient({ host: 'localhost', database: 'app', max: 20, max_lifetime: 1800 }), // max_lifetime in s
  { preparedStatements: true, logFailedQueries: true },
);

// variable-text paging stays unnamed
const page = await oltp.orders
  .where(o => eq(o.status, 'pending'))
  .select(o => ({ id: o.id, totalAmount: o.totalAmount }))
  .orderBy(o => o.id)
  .limit(25)
  .offset(50)
  .withPreparedStatements(false)
  .toList();
```

**Reporting query on the same context**: same pool, different policy for one query.

```ts
const report = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .withPreparedStatements(false)
  .withTimeout(120_000)
  .expectedExecutionTime(120_000)
  .select(u => ({
    username: u.username,
    orders: u.orders!.select(o => ({ id: o.id, totalAmount: o.totalAmount })).toList('orders'),
  }))
  .toList();
```

One statement (captured on `PgClient`, which ignores the timeout; `PostgresClient` wraps it in `begin`,
`SET LOCAL statement_timeout = 120000` and `commit`):

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('id', "id", 'totalAmount', "totalAmount")
  ) as data
FROM (
  SELECT "orders"."user_id" as "__fk_user_id", "id", "total_amount" as "totalAmount"
  FROM "orders"
) sub
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, '[]'::json) as "orders"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
```

**Count the round trips of a code path** while debugging:

```ts
let statements = 0;
const countingDb = new AppDatabase(client, {
  logQueries: true,
  logger: (message: string, section?: LogSection) => {
    if (section === 'sql' && message.startsWith('\n[SQL Query')) statements++;
  },
});
await countingDb.users.select(u => ({ id: u.id, posts: u.posts!.select(p => ({ title: p.title })).toList('posts') })).toList();
// statements === 1 with the default lateral strategy
```

## Pitfalls

- **Don't** rely on `.withTimeout()` with `PgClient`, `BunClient` or `PGliteClient` → **Do** set
  `statement_timeout` on `PgClient`'s pool, or use `db.transaction(fn, { timeoutMs })` (`PgClient`,
  `BunClient`). Only `PostgresClient` honors the per-query option; the others ignore it, and only the
  connection default, if any, applies. `PGliteClient` cannot cancel a statement at all.
- **Don't** call `withQueryOptions()` after `withTimeout()`, `withPreparedStatements()` or
  `expectedExecutionTime()` on a table → **Do** call it first. With an executor duty in the merged
  options (since 1.0.33 `disableMappers`, `rawResult` or `traceTime` alone is one) it builds a fresh
  executor and the earlier override is lost (verified: no `SET LOCAL` was sent).
- **Don't** mix a leg with its own override (`withTimeout()`, `withPreparedStatements()`,
  `expectedExecutionTime()`, `withQueryOptions()` with a duty, since 1.0.33 `{ rawResult: true }` alone
  included) into a `QueryBatch` with plain legs → **Do** start every leg from one derived table, or set
  the policy on the context or the transaction. The batch throws before sending anything.
- **Don't** set `withTimeout()`, `withPreparedStatements()` or `expectedExecutionTime()` on a builder after
  its `prepare()` → **Do** set them before: since 1.0.33 a prepared query's executions run through the
  executor its builder had at `prepare()` time (a later `withTimeout(5000)` on the builder handed the
  client no timeout). Before 1.0.33 `PreparedQuery.execute()` bypassed the executor: never named, never
  logged, no timeout.
- **Don't** expect `db.query()` to be logged, timed or named → **Do** use the builders for ordinary reads
  and writes; keep `db.query()` for statements they do not cover (`EXPLAIN`, `SET TRANSACTION`,
  `SAVEPOINT`).
- **Don't** set `LinkgressConfig` values per request or per context → **Do** set them once at boot. A
  context constructed with `inArrayOptThreshold`, `inArrayPadBuckets` or `inArrayUsesOpt` rewrites them
  for every context in the process.
- **Don't** use `collectionStrategy: 'temptable'` inside `db.transaction()` on `PostgresClient`,
  `BunClient` or `PGliteClient` → **Do** use `lateral` or `cte` there. A parameterless base query fails
  (`Fully optimized mode requires querySimpleMulti support`, or `querySimpleMulti not supported by this
  client` on a context with an executor duty), and on `PostgresClient` a base query with parameters
  returned every collection empty, without an error (verified).
- **Don't** expect `rawResult` or `disableMappers` on grouped selects or CTE- and set-rooted queries, nor
  `rawResult` on unions, futures and `QueryBatch` legs → **Do** go through `where()` / `select()` and a
  terminal method of the select builder. Those paths always map (verified on 1.0.33). A table's own
  `toList()`, `first()` and `firstOrDefault()` honour both since 1.0.33; before, they always mapped.
- **Don't** wait for `'slow'` lines in the logger → **Do** set `onQueryTakingTooLong`. Nothing sends the
  `'slow'` section.

## See also

- [Choosing the right query](../choosing-the-right-query.md): which API fits a data need, with its SQL shape and round trips.
- [Batching and prepared queries](./batching-and-prepared-queries.md): `QueryBatch`, future queries, `.prepare()` with placeholders.
- [Database clients](../database-clients.md): connection options (`statement_timeout`, `max`, `max_lifetime`), per-driver behaviour, pooling.
- [Collection strategies](../collection-strategies.md): the plans behind `lateral`, `cte` and `temptable`.
- [Querying](./querying.md): `inArrayOpt`, `eqAny` and list matching at the call site.
- [Insert, update, delete](./insert-update-guide.md): transactions, `insertFrom(…, { expectedErrorCodes })`.
- [Migrations](./migrations.md): the schema manager and `MigrationRunner` logging.
- [API index](../api-index.md): every export, one line each.
