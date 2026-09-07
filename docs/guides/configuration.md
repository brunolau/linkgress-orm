# Configuration & Options

Every switch Linkgress exposes, where it is set, what it defaults to, and when it is worth
turning on. Nothing here changes the *results* of a query — these are performance, logging and
diagnostics knobs. The features that do change the SQL you get (`inArrayOpt`, `eqAny`,
collection strategies) are cross-linked to their guides.

## Where settings live

| Scope | Set through | Applies to |
|---|---|---|
| **Connection** | the client constructor (`PostgresClient`, `PgClient`, `BunClient`) | pooling, `statement_timeout`, driver flags — see [Database Clients](../database-clients.md) |
| **Context** | `QueryOptions`: `new AppDatabase(client, { … })` | every query that context runs |
| **Query** | `.withQueryOptions()`, `.withPreparedStatements()`, `.withTimeout()`, `.expectedExecutionTime()` | the one chain they are called on |
| **Process** | `LinkgressConfig` | operators used inside `where(...)` lambdas, which have no context in reach |

A per-query override always wins over the context default, and the context default over the
library default.

## Context options — `QueryOptions`

```typescript
const db = new AppDatabase(client, {
  logQueries: false,
  logFailedQueries: true,
  preparedStatements: true,
  collectionStrategy: 'lateral',
});
```

The same object is accepted by `.withQueryOptions()` on a table, where it is merged over the
context's options for that chain only.

| Option | Default | What it does |
|---|---|---|
| `logQueries` | `false` | Log every statement on the `'sql'` section |
| `logParameters` | `false` | Log parameter values (`'params'`, and in the failure line) |
| `logExecutionTime` | `false` | Log per-statement duration on `'timing'` |
| `logFailedQueries` | value of `logQueries` | Report **failed** statements on `'error'` regardless of `logQueries` |
| `logger` | `defaultLogger` | `(message, section?) => void`; section is `'sql' \| 'params' \| 'timing' \| 'slow' \| 'info' \| 'warn' \| 'error'` |
| `preparedStatements` | `false` | **Opt-in.** Run parameterised statements as NAMED server-side prepared statements (postgres.js only) |
| `inArrayOptThreshold` | `8` | List length up to which `inArrayOpt` renders `IN (…)`. **Process-wide** — see [LinkgressConfig](#process-wide-settings--linkgressconfig) |
| `inArrayPadBuckets` | `null` | **Opt-in.** Bucket ladder collapsing the sub-threshold band. **Process-wide** |
| `inArrayUsesOpt` | `false` | **Opt-in.** Make plain `inArray` / `notInArray` render what `inArrayOpt` renders. **Process-wide** |
| `collectionStrategy` | `'lateral'` | `'cte' \| 'lateral' \| 'temptable'` — see [Collection Strategies](../collection-strategies.md) |
| `disableMappers` | `false` | Skip `fromDriver` / `toDriver` transformations; raw driver values are returned |
| `rawResult` | `false` | Return the driver's raw rows with no ORM shaping at all |
| `useBinaryProtocol` | `false` | Requests a binary result protocol. No shipped client reports support, so it is inert today |
| `traceTime` | `false` | Log a per-phase breakdown: build, execute, transform |
| `onQueryTakingTooLong` | *(unset)* | Callback enabling slow-query detection (costs a stack capture per query) |
| `longRunningQueryThreshold` | `10000` | Milliseconds above which that callback fires |
| `slowQueryStackTraceLimit` | `50` | Frames captured per query while detection is on; `0` skips the capture |

### Logging in production

The per-statement channel and the failure channel are separate duties, so a production context
can keep the firehose off without losing the record of what broke:

```typescript
const db = new AppDatabase(client, {
  logQueries: false,        // no '[SQL Query]' / '[Parameters]' lines
  logFailedQueries: true,   // '[SQL Error] <driver message>' + the statement, on the 'error' section
  logParameters: false,     // keep parameter values out of the failure line too
  logger: (message, section) => myLogger.route(message, section),
});
```

`logFailedQueries` defaults to the value of `logQueries`, so a context that never sets it keeps
its current behaviour. The failure line always carries the statement text, which means a context
with `logQueries: true` sees the SQL twice on a failure — once as debug output, once in the
self-contained error line.

### Slow-query detection

Providing `onQueryTakingTooLong` turns detection on. The query is **not** cancelled — this is a
notice, not a timeout (use [`.withTimeout()`](#per-query-overrides) to actually cancel):

```typescript
const db = new AppDatabase(client, {
  onQueryTakingTooLong: info => {
    // info: { sql, params, durationMs, thresholdMs, stack }
    metrics.slowQuery(info.durationMs, info.stack);
  },
  longRunningQueryThreshold: 2000,   // default 10000
  slowQueryStackTraceLimit: 10,      // default 50; 0 = no capture, empty stack
});

// Per-query budget — this report is allowed to be slow:
await db.reports.expectedExecutionTime(30000).where(r => eq(r.heavy, true)).toList();
```

The stack is captured on **every** query while detection is active (that is the price of knowing
the caller when one turns out slow), so on hot paths lower `slowQueryStackTraceLimit` or leave
the callback unset.

## Server-side prepared statements (opt-in)

> **Not the same thing as [`.prepare()`](./querying.md#prepared-statements).** `.prepare('name')`
> plus `sql.placeholder()` is a *client-side* reusable query object: build the SQL once, execute
> it with different values. `preparedStatements` is a *server-side* setting: it decides whether
> the statement reaches PostgreSQL NAMED, so the server can keep its parse tree and plan. They
> are independent and can be used together.

postgres.js sends `unsafe()` statements unnamed, and `PostgresClient` runs every statement through
`unsafe()`. So by default each statement is parsed, described (an extra round trip before
Bind/Execute) and planned again on every execution. For planning-heavy OLTP statements that is
most of the server time — a 16 KB cart read measured 7.35 ms unprepared against 0.95 ms prepared
on one connection.

```typescript
const db = new AppDatabase(client, {
  preparedStatements: true,   // opt-in; default false
});
```

### Overriding per query — `withPreparedStatements()`

The override works in both directions: `false` keeps a wide analytical query on custom plans
inside a prepared context, `true` prepares a single hot lookup on an unprepared one.

```typescript
// On the table accessor — mirrors .withTimeout()
await db.catalogue.withPreparedStatements(false).where(p => eq(p.active, true)).toList();
await db.tokens.withPreparedStatements(true).where(t => eq(t.value, token)).firstOrDefault();

// On an already-built query, at any point of the chain — for code that RECEIVES a query
function readPage(query: IEntityQueryable<Order>, page: number) {
  return query
    .orderBy(o => o.createdAt)
    .limit(25)
    .offset(page * 25)
    .withPreparedStatements(false)   // paging/sort/filter text varies per request
    .toList();
}
```

| Where | Example |
|---|---|
| `DbEntityTable` / `TableAccessor` | `db.users.withPreparedStatements(false)` |
| `QueryBuilder` / `SelectQueryBuilder` (an already-built query) | `query.withPreparedStatements(false)` |
| `JoinQueryBuilder` | `joined.withPreparedStatements(false)` |
| Grouped chains (`.groupBy()`) | set it **before** `.groupBy()`; the setting carries through |

The override covers every execution of that builder — `toList()`, `count()`, `countOver()`,
`firstOrDefault()`, … — and survives `.withTimeout()` / `.expectedExecutionTime()` chaining.

A paginated-grid helper is the archetypal case for `false`: its statement text changes with the
request (offsets, sort columns, filter combinations) and it runs a few times a minute, so every
distinct text would be another cached plan in every pooled connection for nothing.

### What it does and does not touch

- **Driver**: only `PostgresClient` honors it. `PgClient` and `BunClient` ignore it, as does a
  postgres.js instance that was constructed with `prepare: false`.
- **Exempt regardless of the option**: `insertWithChildren`, `insertBulkWithChildren` and the
  fused `MutationBatch` statement. Their text embeds a per-call VALUES list, so preparing them
  would create one statement per variant and never reuse it.
- **Zero-parameter statements** are unaffected — postgres.js already sends them over the simple
  protocol.

### Measure before turning it on

After five executions PostgreSQL may switch a prepared statement to a GENERIC plan
(`plan_cache_mode = auto`). That is right for statements whose parameters have uniform
selectivity (primary-key and foreign-key lookups) and wrong for some wide analytical shapes: a
19 KB catalogue query with 1,560 parameters measured *slower* prepared, because the generic plan
lost to the hand-tuned custom plan. Opt those out with `.withPreparedStatements(false)`.

Checklist before and after enabling:

- Read `pg_prepared_statements` (`generic_plans` / `custom_plans`) and `pg_stat_statements`
  (`calls` vs `plans`, with `track_planning = on`) on the target database.
- Pair the option with a connection `max_lifetime` so per-connection statement caches are recycled.
- Watch statement-text variety: `IN ($1, $2, …)` lists are cached once per list length. That is
  what [`inArrayOpt`](#statement-text-economy) exists to bound.
- Prefer explicit column lists in statements that run inside transactions. A cached plan whose
  result shape changed (`SELECT *` over a table that gained a column) is rejected once and
  re-prepared transparently — but inside an explicit transaction that retry lands on an aborted
  transaction. Linkgress's own builders already emit explicit columns.

## Statement-text economy

Under `preparedStatements` every distinct statement text is a cached plan in every pooled
connection, so it is worth bounding how many texts one query family produces. Three settings do
that, all process-wide, all covered in depth in the
[Querying guide](./querying.md#matching-a-list-of-values):

```typescript
import { LinkgressConfig, inArrayOpt } from 'linkgress-orm';

LinkgressConfig.inArrayOptThreshold = 8;         // default: IN (…) up to 8, = ANY($1::int[]) above
LinkgressConfig.inArrayPadBuckets = [1, 2, 8];   // opt-in: collapse the band BELOW the threshold
LinkgressConfig.inArrayUsesOpt = true;           // opt-in: plain inArray renders the same way

db.products.where(p => inArrayOpt(p.id, productIds));
```

- `inArrayOpt` / `notInArrayOpt` pick per call: an exact-length `IN` list up to the threshold
  (best row estimate, and a cached generic plan after five executions), one array parameter above
  it (a single text for any length).
- `inArrayPadBuckets` rounds a short list up to the next rung and fills the gap by repeating its
  last element, so a whole band of lengths shares one text. Same rows either way; it costs a
  slightly wider row estimate, which is free from three elements up and about 32 % / 26 % on one-
  and two-element lists — so keep the low rungs tight.
- `inArrayUsesOpt` applies the two above to the plain `inArray` / `notInArray` as well, so a
  codebase that never adopted the opt operators gets the same economy without a rewrite. Off by
  default; results are identical either way, only the statement text changes.
- `eqAny` / `neAll` are the unconditional array forms, when you want to decide at the call site.

## Result handling and diagnostics

```typescript
// Skip mapper transformations for a bulk export you will map yourself
await db.events.withQueryOptions({ disableMappers: true }).toList();

// The driver's raw rows, no ORM shaping — debugging
await db.events.withQueryOptions({ rawResult: true }).toList();

// Per-phase timing: build / execute / transform
await db.events.withQueryOptions({ traceTime: true }).toList();
```

`useBinaryProtocol` requests a binary result protocol from the client. No shipped client reports
support for one today (`pg`'s `rowMode: 'array'` is not a binary protocol and would corrupt
name-based result mapping), so the option is inert — it exists for future drivers.

## Per-query overrides

| Method | Effect | Available on |
|---|---|---|
| `.withQueryOptions(options)` | Merge any `QueryOptions` over the context's, for this chain | `DbEntityTable`, `TableAccessor` |
| `.withPreparedStatements(bool)` | Named / unnamed server-side statement | tables, query builders, select builders, join builders |
| `.withTimeout(ms)` | Cancel the statement server-side after `ms`; `0` disables the connection default. Throws `QueryTimeoutError` | tables, query builders, select builders, grouped builders |
| `.expectedExecutionTime(ms)` | Budget for `onQueryTakingTooLong`; does **not** cancel | tables, query builders, select builders, grouped builders |

```typescript
import { QueryTimeoutError } from 'linkgress-orm';

try {
  await db.reports.withTimeout(5000).withPreparedStatements(false).toList();
} catch (err) {
  if (err instanceof QueryTimeoutError) {
    // err.timeoutMs, err.sql, err.cause (driver error, code 57014)
  }
}
```

`.withTimeout()` wraps only that one query (`BEGIN; SET LOCAL statement_timeout = …; …; COMMIT;`),
so it cannot leak to other queries on the pooled connection. A connection-wide default is cheaper
still — pass `statement_timeout` to the client constructor.

## Process-wide settings — `LinkgressConfig`

`inArrayOpt` and its siblings are plain functions used inside `where(...)` lambdas, with no
context in reach. Their settings are therefore process-wide, and `LinkgressConfig` is the public
surface for them — and for every library-wide setting from here on:

```typescript
import { LinkgressConfig } from 'linkgress-orm';

LinkgressConfig.inArrayOptThreshold = 12;                  // property setter
LinkgressConfig.inArrayPadBuckets = [1, 2, 8];             // opt-in ladder; null switches it off
LinkgressConfig.inArrayUsesOpt = true;                     // opt-in; plain inArray renders as inArrayOpt
LinkgressConfig.configure({ inArrayOptThreshold: 12 });    // several settings at once
LinkgressConfig.inArrayOptThreshold;                       // -> 12
LinkgressConfig.resetToDefaults();                         // test isolation

LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD;            // 8
LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS;              // [1, 4, 8] — a ladder to hand it, not the default state
```

Constructing a context with the matching `QueryOptions` keys writes the same process-wide values:

```typescript
new AppDatabase(client, { inArrayOptThreshold: 12, inArrayPadBuckets: [1, 2, 8], inArrayUsesOpt: true });
```

The last write wins, whichever path it came through. Invalid values throw and leave the current
setting in place: the threshold must be a non-negative integer, the ladder must be positive
integers in strictly ascending order, and `inArrayUsesOpt` must be a boolean. The stored ladder is
a frozen copy, so mutating the array you passed cannot change it afterwards.

`inArrayUsesOpt` is the one setting here that changes the SQL a call site you did not touch emits:
with it on, `inArray` / `notInArray` render exactly what `inArrayOpt` / `notInArrayOpt` render.
The rows are identical — see
[Applying it to plain `inArray`](./querying.md#applying-it-to-plain-inarray-inarrayusesopt-opt-in) for
when to reach for it.

## Query-build caches (opt-in)

Query *building* — the mock rows a selector lambda walks, and the navigation-path search behind
them — is memoisable because schemas are immutable after registration. One switch turns on both
caches:

```typescript
import { MockRowCache, NavigationPathCache } from 'linkgress-orm';

MockRowCache.setEnabled(true);   // also enables NavigationPathCache

MockRowCache.diagnostics();      // { enabled, entries, maxEntries }
NavigationPathCache.diagnostics();
MockRowCache.reset();            // drop cached prototypes (tests)
```

Results are identical either way; what changes is the CPU and garbage per query build. On a
checkout burst (30–100 concurrent order writes, one process) enabling it moved throughput from
42–45 to 92–104 orders/s, with GC self time down 77 %. The cost is retained memory: mock-row
prototypes are bounded at 2,000 entries, navigation paths at 5,000 per schema registry. Leave it
off if you build a large variety of one-off query shapes and never repeat them.

## Recipes

**Production web app** — quiet logs, failures and slow queries still visible:

```typescript
const db = new AppDatabase(client, {
  logQueries: false,
  logFailedQueries: true,
  onQueryTakingTooLong: info => metrics.slowQuery(info),
  longRunningQueryThreshold: 2000,
  slowQueryStackTraceLimit: 10,
});
```

**Hot OLTP path** (postgres.js, stable statement texts):

```typescript
MockRowCache.setEnabled(true);
LinkgressConfig.inArrayPadBuckets = [1, 2, 8];

const db = new AppDatabase(client, {
  preparedStatements: true,
  inArrayOptThreshold: 8,
  inArrayUsesOpt: true,     // existing inArray call sites get the same treatment
});

// …and opt the variable-text queries back out where they are built:
grid.withPreparedStatements(false).limit(25).offset(offset).toList();
```

**Reporting query** on the same context — same pool, different policy:

```typescript
await db.reports
  .withQueryOptions({ collectionStrategy: 'temptable' })
  .withPreparedStatements(false)
  .withTimeout(120000)
  .toList();
```

## See Also

- **[Database Clients](../database-clients.md)** — connection options, pooling, driver differences
- **[Querying](./querying.md)** — `inArrayOpt` / `eqAny`, and `.prepare()` placeholder queries
- **[Collection Strategies](../collection-strategies.md)** — `collectionStrategy` in depth
