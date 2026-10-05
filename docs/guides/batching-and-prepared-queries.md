# Batching and Prepared Queries

> **For agents:** How do I get several independent results in one round trip, and run one query shape many times without rebuilding it?
> **Use this page when:** a screen or endpoint needs two or more independent reads, a page plus its total count, a grouped read next to other reads, the same query with different values many times, or a read's SQL and parameters without running it. **Look elsewhere when:** one read needs another read's result (the posts of the users a search finds) → [Querying guide](./querying.md) (navigations and collections in one statement); several writes in one statement → [Inserts, updates, upserts and deletes](./insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch); named server-side statements → [Configuration](./configuration.md#send-statements-named-on-the-server-preparedstatements)
> **Key APIs:** `QueryBatch`, `future()`, `futureFirstOrDefault()`, `futureCount()`, `FutureQueryRunner.runAsync()`, `prepare()`, `sql.placeholder()`, `PreparedQuery`, `MutationBatch` · **Round trips:** `QueryBatch` 1 for any number of reads; N `await`s N; `FutureQueryRunner` 1 only when every future is parameter-free on `PostgresClient` / `BunClient` / `PGliteClient` outside a transaction, otherwise N; `PreparedQuery.execute()` 1 per call

## Contents

- [Choose the right tool](#choose-the-right-tool)
- [Read several independent results in one round trip: `QueryBatch`](#read-several-independent-results-in-one-round-trip-querybatch)
- [Read a batch's results: keys, ids and getters](#read-a-batchs-results-keys-ids-and-getters)
- [Load a page and its total count in one round trip](#load-a-page-and-its-total-count-in-one-round-trip)
- [Batch a grouped query with other reads](#batch-a-grouped-query-with-other-reads)
- [Count a union or read its first row in a batch](#count-a-union-or-read-its-first-row-in-a-batch)
- [Check which queries can be a batch leg](#check-which-queries-can-be-a-batch-leg)
- [Batch inside a transaction or under a timeout](#batch-inside-a-transaction-or-under-a-timeout)
- [Name or un-name the batch statement: `withPreparedStatements()`](#name-or-un-name-the-batch-statement-withpreparedstatements)
- [Fix batch refusals](#fix-batch-refusals)
- [Get the values the query reads on its own](#get-the-values-the-query-reads-on-its-own)
- [Build a read now and run it later: `future()`](#build-a-read-now-and-run-it-later-future)
- [Run several futures together: `FutureQueryRunner.runAsync()`](#run-several-futures-together-futurequeryrunnerrunasync)
- [Build a query once and execute it many times: `prepare()`](#build-a-query-once-and-execute-it-many-times-prepare)
- [Keep server-side prepared statements apart from `prepare()`](#keep-server-side-prepared-statements-apart-from-prepare)
- [Run one query shape many times: pick the tool by client](#run-one-query-shape-many-times-pick-the-tool-by-client)
- [Write several independent changes in one statement: `MutationBatch`](#write-several-independent-changes-in-one-statement-mutationbatch)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose the right tool

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Two or more independent reads for one screen (a row, lists, counts) | `QueryBatch`: `addFirstOrDefault()` / `addList()` / `addCount()`, then `executeBatch()` | one `UNION ALL` statement, one JSON envelope per read · 1 | N sequential `await`s (N round trips); `Promise.all` (N statements on up to N pooled connections) |
| A page of rows plus the total number of matches | `QueryBatch`: `addList(page)` + `addCount(page)` on the same builder (a select or a grouped query; a union's count counts its own paging: count the union without it) | page leg + `SELECT COUNT(*)` leg · 1; the total stays right past the last page | `Promise.all([page.toList(), q.count()])` (2 statements); `countOver()` when a page can be empty (it reports `totalCount: 0`) |
| A grouped read next to other reads | `addList()` / `addFirstOrDefault()` / `addCount()` of a grouped `select()` | a grouped leg; `addCount()` counts the groups · 1 | a bare `groupBy()` without its `select()` (not accepted) |
| The count or the first row of a union next to other reads | `addCount(union)` / `addFirstOrDefault(union)` (since 1.0.31) | `SELECT COUNT(*) as count FROM (<union>) as union_count` leg, or the union with `LIMIT 1` · 1 | `union.count()` beside the batch (a second round trip); `addList(union)` and `.length` in JS (ships every row) |
| One read needs another read's result | one query with navigations or collections ([Querying guide](./querying.md)) | one statement with joins / `LATERAL` / CTEs · 1 under the default `lateral` or the `cte` strategy (`temptable` sends several) | a chain of `await`s feeding ids into the next query |
| Independent lists of thousands of rows each, pool has free connections | `Promise.all` of `toList()` | N statements, run concurrently · N | `QueryBatch`: aggregating 20 000 rows into JSON cost more than the round trips it saved (see [Measured](#read-several-independent-results-in-one-round-trip-querybatch)) |
| The same query shape many times with different values | by client ([pick the tool by client](#run-one-query-shape-many-times-pick-the-tool-by-client)): `PgClient`, `BunClient`, `PGliteClient`: `prepare(name)` + `sql.placeholder(name)`, then `execute(values)`; `PostgresClient`: the ordinary builder on a `preparedStatements: true` context, plus `MockRowCache.setEnabled(true)` | the same text on every call · 1 per call | `prepare()` on `PostgresClient` (never named: 2 network round trips per call); rebuilding the builder per call on a hot path without `MockRowCache`; a placeholder in a query run with `toList()` (the server refuses it) or in a batch leg (it can take another leg's value) |
| Parameter-free reads as a typed tuple on `PostgresClient` / `BunClient` / `PGliteClient` | `FutureQueryRunner.runAsync([...] as const)` | one simple-protocol message with several statements · 1 | expecting 1 round trip when any future binds a value, on `PgClient`, or inside a transaction (N statements) |
| A read's SQL and parameters without running it | `future().getSql()` / `future().getParams()` | nothing sent · 0 | `logQueries` (it runs the query); `toSql()` on select builders (does not exist) |
| Several independent writes | `MutationBatch` ([Inserts, updates, upserts and deletes](./insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)) | one statement of data-modifying CTEs · 1 | N awaited writes |
| The server reuses a parsed statement between executions | `preparedStatements: true` or `.withPreparedStatements(true)`, `PostgresClient` only ([Configuration](./configuration.md#send-statements-named-on-the-server-preparedstatements)) | same statement count; after its first run on a connection a named statement skips parse and postgres.js's describe step, and PostgreSQL may switch it to a reused generic plan after 5 executions | expecting `prepare()` to name the statement (it never asks for that) |

Rules that hold across this page:

1. Independent reads go into one `QueryBatch`, not into N `await`s. The exception is lists of thousands of rows each (see the table above).
2. Reads that share a parent row can also be one projection: `db.users.where(...).select(u => ({ ..., posts: u.posts!.select(...).toList('posts'), orders: u.orders!.count() }))` is one statement without a batch under the default `lateral` or the `cte` strategy ([Querying guide](./querying.md)); under `temptable` it sends several (11 on `PgClient` for a username, that collection and that count). Use a batch for reads with different roots or filters.
3. `prepare()` saves query-build CPU, not round trips. Server-side statement reuse (named statements) is `preparedStatements` on `PostgresClient`, a separate switch. For a hot path the client decides which one to use: [Run one query shape many times](#run-one-query-shape-many-times-pick-the-tool-by-client).

## Read several independent results in one round trip: `QueryBatch`

`QueryBatch` sends independent reads (lists, first rows, counts) as ONE statement: a `UNION ALL` with one branch per registered query, a leg, each wrapping its query's rows in a JSON envelope. Use it whenever two or more reads do not depend on each other's results. Each leg's rows pass through the same result transform as the query on its own, so `getList()` / `getItem()` / `getCount()` return what `toList()` / `firstOrDefault()` / `count()` return (the exceptions are under [Known limitations of the JSON transport](#known-limitations-of-the-json-transport)).

Three reads awaited one after another:

```ts
import { eq } from 'linkgress-orm';

const userId = 1;
const user0 = await db.users
  .where(u => eq(u.id, userId))
  .select(u => ({ id: u.id, username: u.username, email: u.email }))
  .firstOrDefault();
const posts0 = await db.posts
  .where(p => eq(p.userId, userId))
  .select(p => ({ id: p.id, title: p.title, views: p.views }))
  .orderBy(p => [[p.views, 'DESC']])
  .toList();
const orderCount0 = await db.orders.where(o => eq(o.userId, userId)).count();
```

send three statements, three round trips:

```sql
-- #1 query
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [1]
-- #2 query
SELECT "posts"."id" as "id", "posts"."title" as "title", "posts"."views" as "views"
FROM "posts"
WHERE "posts"."user_id" = $1
ORDER BY "views" DESC
-- params: [1]
-- #3 query
SELECT COUNT(*) as count
FROM "orders"
WHERE "orders"."user_id" = $1
-- params: [1]
```

The same reads in a batch:

```ts
import { eq, QueryBatch } from 'linkgress-orm';

const userId = 1;
const batch = new QueryBatch();
const userKey = batch.addFirstOrDefault(
  db.users.where(u => eq(u.id, userId)).select(u => ({ id: u.id, username: u.username, email: u.email })),
  'user',
);
const postsKey = batch.addList(
  db.posts
    .where(p => eq(p.userId, userId))
    .select(p => ({ id: p.id, title: p.title, views: p.views }))
    .orderBy(p => [[p.views, 'DESC']]),
  'posts',
);
const ordersKey = batch.addCount(db.orders.where(o => eq(o.userId, userId)), 'orders');
await batch.executeBatch();

const user = batch.getItem(userKey);          // { id: number; username: string; email: string } | null
const posts = batch.getList(postsKey);        // { id: number; title: string; views: number }[]
const orderCount = batch.getCount(ordersKey); // number
```

send one statement:

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email"
  FROM "users"
  WHERE "users"."id" = $1
  LIMIT 1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."id" as "id", "posts"."title" as "title", "posts"."views" as "views"
  FROM "posts"
  WHERE "posts"."user_id" = $2
  ORDER BY "views" DESC
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count
  FROM "orders"
  WHERE "orders"."user_id" = $3
) __batch_q
-- params: [1, 1, 1]
```

Result: `user` is `{ id: 1, username: 'alice', email: 'alice@test.com' }`, `posts` holds two rows (views 150, then 100), `orderCount` is `1`, the same values the three awaits returned.

> **Efficiency:** PostgreSQL plans each `UNION ALL` branch on its own, so every leg keeps its indexes and its own `ORDER BY` / `LIMIT`. Parameters are renumbered across legs (`$1` … `$n`). The server aggregates each leg's rows into one JSON value and the client parses one JSON value per leg.

> **Efficiency:** the statement text is the legs' texts joined in registration order. It repeats only while the same legs come in the same order with the same texts, which matters for named statements (`preparedStatements`). A list whose length varies inside a leg changes the text: bound it with `inArrayOpt` / `eqAny` ([Querying guide](./querying.md)).

> **Pitfall:** `Promise.all` of the same three reads is not one round trip: it sent three statements, which `PgClient` runs on up to three pooled connections; inside `db.transaction()` they queue on the transaction's one connection.

**Measured** in `bench/querybatch`, which timed raw statements (written before `QueryBatch` existed, not calls through linkgress) on PostgreSQL through postgres.js with `prepare: false` (every unnamed parameterised statement costs two network round trips there: Parse/Describe, then Bind/Execute). The one-statement columns are the plain `UNION ALL` JSON envelope `QueryBatch` sends for legs without text-sent values. Medians:

| Scenario | Round-trip time | Sequential `await`s | `Promise.all` (pool of 10) | One statement, unnamed | One statement, named |
|---|---|---|---|---|---|
| 12 reads, about 185 rows (lists of 5–50 rows, first rows, counts) | 0.08 ms | 2.95 ms | 0.80 ms | 1.50 ms | 0.94 ms |
| 12 reads, about 185 rows (lists of 5–50 rows, first rows, counts) | 31 ms | 743 ms | 110 ms | 62 ms | 31 ms |
| 30 reads, about 2 400 rows | 0.08 ms | 11.5 ms | 4.05 ms | 7.48 ms | 6.75 ms |
| 30 reads, about 2 400 rows | 31 ms | 1 853 ms | 172 ms | 62 ms | 31 ms |
| 10 reads × 2 000 rows | 0.08 ms | 23.6 ms | 16.2 ms | 23.8 ms | 24.1 ms |
| 10 reads × 2 000 rows | 31 ms | 620 ms | 52 ms | 76 ms | 78 ms |

Reading the table: across a network, one statement wins for screen-sized reads; on a local server `Promise.all` has the lowest wall time but holds up to N pooled connections at once while the batch holds one; for lists of thousands of rows `Promise.all` wins at both round-trip times. On `PgClient` (node-postgres) an unnamed parameterised statement costs one network round trip, not two, so there N sequential awaits cost N round-trip times instead of 2N.

## Read a batch's results: keys, ids and getters

Each `add*()` call registers a leg under an id that is unique in the batch and returns a typed key; the matching getter reads the leg after `executeBatch()`. Use the key for the result type; a string id works as an untyped escape hatch (pass the row type as a generic).

| Register | Returns | Read with | Result | What the leg runs |
|---|---|---|---|---|
| `addList(query, id)` | `BatchListKey<T>` | `getList(key)` | `T[]`, `[]` when no row matches | the query as built |
| `addFirstOrDefault(query, id)` | `BatchItemKey<T>` | `getItem(key)` | `T \| null` | the query with `LIMIT 1` (the builder itself keeps its own limit; a union too, since 1.0.31) |
| `addCount(query, id)` | `BatchCountKey` | `getCount(key)` | `number` | `SELECT COUNT(*)` of the query without its `ORDER BY` / `LIMIT` / `OFFSET`; of a union (since 1.0.31) the statement its `count()` sends, its own `LIMIT` / `OFFSET` counted |

```ts
import { eq, QueryBatch } from 'linkgress-orm';

const lookups = new QueryBatch();
lookups.addFirstOrDefault(db.users.where(u => eq(u.username, 'nobody')).select(u => ({ id: u.id })), 'nobody');
lookups.addList(db.posts.where(p => eq(p.userId, 999)).select(p => ({ id: p.id })), 'none');
await lookups.executeBatch();

const nobody = lookups.getItem<{ id: number }>('nobody'); // null
const none = lookups.getList<{ id: number }>('none');     // []
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id"
  FROM "users"
  WHERE "users"."username" = $1
  LIMIT 1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."id" as "id"
  FROM "posts"
  WHERE "posts"."user_id" = $2
) __batch_q
-- params: ["nobody", 999]
```

> **Efficiency:** for an existence check inside a batch, register `addFirstOrDefault()` of a one-column projection and compare the result with `null`: the leg stops at the first row (`LIMIT 1`). `addCount()` counts every match. There is no batch form of `exists()`.

## Load a page and its total count in one round trip

Register the same paged builder twice: `addList()` reads the page, `addCount()` counts every match because the count leg drops `ORDER BY` / `LIMIT` / `OFFSET`. This is one statement, and the total stays right when the page lies past the end.

```ts
import { gt, QueryBatch } from 'linkgress-orm';

const pageSize = 2;
const pageIndex = 0;
const page = db.users
  .where(u => gt(u.age, 20))
  .select(u => ({ id: u.id, username: u.username }))
  .orderBy(u => u.username)
  .offset(pageIndex * pageSize)
  .limit(pageSize);

const batch = new QueryBatch();
const rowsKey = batch.addList(page, 'rows');
const totalKey = batch.addCount(page, 'total'); // COUNT(*) without ORDER BY / LIMIT / OFFSET
await batch.executeBatch();

const rows = batch.getList(rowsKey);    // { id: number; username: string }[]
const total = batch.getCount(totalKey); // number
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id", "users"."username" as "username"
  FROM "users"
  WHERE "users"."age" > $1
  ORDER BY "username" ASC
  LIMIT 2 OFFSET 0
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count
  FROM "users"
  WHERE "users"."age" > $2
) __batch_q
-- params: [20, 20]
```

Result: page 0 reads 2 rows and `total` 3; with `pageIndex = 5` (`OFFSET 10`) `rows` is `[]` and `total` is still 3.

The alternatives on the same data:

| Form | Statements | Total for a page past the end |
|---|---|---|
| `QueryBatch` `addList(page)` + `addCount(page)` | 1 | 3 (right) |
| `page.countOver()` → `{ data, totalCount }` | 1 | 0: `totalCount` is read from the first returned row |
| `Promise.all([page.toList(), db.users.where(u => gt(u.age, 20)).count()])` | 2 | 3 (right) |

`countOver()` adds a window aggregate to the page query:

```sql
SELECT "users"."id" as "id", "users"."username" as "username", COUNT(*) OVER() as "__countOver"
FROM "users"
WHERE "users"."age" > $1
ORDER BY "username" ASC
LIMIT 2 OFFSET 0
-- params: [20]
```

> **Pitfall:** `futureCount()` / `addCount()` of a paged builder counts every match, not the page size. That is what makes the total right; to count the rows of one page, use `getList(key).length`. A union is the exception (since 1.0.31): its count counts its own `LIMIT` / `OFFSET`, as its `count()` does, so register the union without them for the total ([below](#count-a-union-or-read-its-first-row-in-a-batch)).

## Batch a grouped query with other reads

A grouped query with its `select()` (and a grouped query joined to a CTE or a subquery) has the same future API as a plain select, so it joins a batch through `addList()`, `addFirstOrDefault()` and `addCount()`. Its `addCount()` counts the groups its `HAVING` keeps, its `ORDER BY` / `LIMIT` / `OFFSET` aside.

```ts
import { eq, QueryBatch } from 'linkgress-orm';

const perUser = db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, posts: g.count(), views: g.sum(r => r.views) }))
  .orderBy(r => [[r.views, 'DESC']]);

const batch = new QueryBatch();
const topKey = batch.addList(perUser.limit(1), 'top'); // { userId: number; posts: number; views: number }[]
const groupsKey = batch.addCount(perUser, 'groups');   // the number of groups, LIMIT aside
const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, 2)).select(u => ({ id: u.id, username: u.username })), 'user');
await batch.executeBatch();
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
  FROM "posts"
  GROUP BY "posts"."user_id"
  ORDER BY "views" DESC
  LIMIT 1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count FROM (SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
  FROM "posts"
  GROUP BY "posts"."user_id") AS "grouped_count"
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id", "users"."username" as "username"
  FROM "users"
  WHERE "users"."id" = $1
  LIMIT 1
) __batch_q
-- params: [2]
```

Result: `top` is `[{ userId: 1, posts: 2, views: 250 }]`, `groups` is 2, `user` is `{ id: 2, username: 'bob' }`.

A batched grouped query reads what its `toList()` / `firstOrDefault()` reads through the same client, in the same key order: an int8 / numeric key as the driver delivers it (its exact text, by default); a date or timestamp key, a column or an expression such as `dateTrunc()` / `castAsDate()`, as the client's parser makes it (a `Date` by default, its text under a pass-through parser; a `dateTrunc('day', p.publishedAt)` key was verified to read as a `Date`); bytea as a `Buffer`; a mapped column through its mapper.

> **Pitfall:** `limit()` on a builder changes that builder (`perUser.limit(1)` above). The count leg ignores the limit, so registering the limited builder for `addList()` and the same builder for `addCount()` is safe; a later `toList()` of `perUser` would read one row.

## Count a union or read its first row in a batch

Since 1.0.31 a union (`union()` / `unionAll()`, of entity, CTE-rooted or set queries) has all three future factories: `future()` for `addList()`, `futureFirstOrDefault()` for `addFirstOrDefault()` and `futureCount()` for `addCount()`. Its count and its first row then ride the batch's one round trip instead of a `count()` / `firstOrDefault()` of their own (before 1.0.31, `batch.addCount(union, id)` threw `query.futureCount is not a function`).

```ts
import { eq, QueryBatch } from 'linkgress-orm';

// users who wrote a post or placed an order, once each (UNION removes the duplicates)
const participants = () => db.posts
  .select(p => ({ userId: p.userId }))
  .union(db.orders.select(o => ({ userId: o.userId })));

const batch = new QueryBatch();
const totalKey = batch.addCount(participants(), 'participants');                                  // every row
const lastKey = batch.addFirstOrDefault(participants().orderBy(r => [[r.userId, 'DESC']]), 'last');
const pageCountKey = batch.addCount(participants().orderBy(r => r.userId).limit(1), 'pageCount'); // its LIMIT counted
const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, 2)).select(u => ({ id: u.id, username: u.username })), 'user');
await batch.executeBatch();

batch.getCount(totalKey);       // 2
batch.getItem(lastKey);         // { userId: 2 }
batch.getCount(pageCountKey);   // 1
batch.getItem(userKey);         // { id: 2, username: 'bob' }
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count FROM ((SELECT "posts"."user_id" as "userId"
  FROM "posts")
  UNION
  (SELECT "orders"."user_id" as "userId"
  FROM "orders")) as union_count
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  (SELECT "posts"."user_id" as "userId"
  FROM "posts")
  UNION
  (SELECT "orders"."user_id" as "userId"
  FROM "orders")
  ORDER BY "userId" DESC
  LIMIT 1
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count FROM ((SELECT "posts"."user_id" as "userId"
  FROM "posts")
  UNION
  (SELECT "orders"."user_id" as "userId"
  FROM "orders")
  ORDER BY "userId" ASC
  LIMIT 1) as union_count
) __batch_q
UNION ALL
SELECT 3 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id", "users"."username" as "username"
  FROM "users"
  WHERE "users"."id" = $1
  LIMIT 1
) __batch_q
-- params: [2]
```

- `futureCount()` (behind `addCount()`) is the statement the union's `count()` sends: `SELECT COUNT(*) as count FROM (<the union, its WITH included>) as union_count`, with the union's own `ORDER BY` / `LIMIT` / `OFFSET`, so a paged union counts its page (`pageCount` is `1`). A select's or a grouped query's count drops them; for the total of a paged union, register the union without `limit()` / `offset()`.
- `futureFirstOrDefault()` (behind `addFirstOrDefault()`) is `firstOrDefault()`: the `LIMIT 1` is the future's, the builder keeps its own paging, and the row reads as `future()`'s rows do (by the first leg's projection).
- Both run alone too (`execute()`) and through `FutureQueryRunner.runAsync()`; `getSql()` returns the statement without sending it (`participants().orderBy(r => r.userId).limit(1).futureCount().getSql()` is the count leg 2 above).
- A union of CTE-rooted or set legs is a leg like any union: the count of `db.selectFromCte(cte).select(…).unionAll(db.tags.select(…))` carries the CTE's `WITH` inside the count's subquery (verified, beside a `db.selectFromSet(…)` union read as a first row in the same batch).

A union whose legs declare a data-modifying CTE (`withMutation()`) is refused as a count and as a first row, before anything is sent: a batch reads every leg as a subquery, where PostgreSQL allows no data-modifying `WITH` (0A000), and the batch would run the write as a side effect of a read. Run its `count()` / `firstOrDefault()`, a statement of its own:

```ts
import { DbCteBuilder, eq, QueryBatch } from 'linkgress-orm';

const builder = new DbCteBuilder();
const touched = builder.withMutation('touched', db.users
  .where(u => eq(u.username, 'alice'))
  .update({ age: 26 })
  .toStatement(u => ({ id: u.id })));
const touchedIds = db.selectFromCte(touched.cte).select(r => ({ id: r.id }))
  .unionAll(db.selectFromCte(touched.cte).select(r => ({ id: r.id })));

new QueryBatch().addCount(touchedIds, 'touched');
// throws: futureCount(): the union's legs declare the data-modifying CTE "touched" — a future is read as a subquery
// by a QueryBatch, where a data-modifying WITH is not allowed (it must lead its statement). Run count() for it: a
// statement of its own.
const n = await touchedIds.count();   // 2: a statement of its own, the WITH at its top
```

```sql
WITH "touched" AS (UPDATE "users" SET "age" = $1 WHERE "users"."username" = $2 RETURNING "id" AS "id")
SELECT COUNT(*) as count FROM ((SELECT "touched"."id" as "id"
FROM "touched")
UNION ALL
(SELECT "touched"."id" as "id"
FROM "touched")) as union_count
-- params: [26, "alice"]
```

- `futureFirstOrDefault()` / `addFirstOrDefault()` throw the same way (`futureFirstOrDefault(): … Run firstOrDefault() for it: a statement of its own.`).
- `future()` (behind `addList()`) is not refused: the batch statement is sent, and PostgreSQL refuses it with 0A000 `WITH clause containing a data-modifying statement must be at the top level` (the in-memory database answers the same). Read such a union with `toList()`.

## Check which queries can be a batch leg

A leg is any query that has the future factory its adder calls: `future()` for `addList()`, `futureFirstOrDefault()` for `addFirstOrDefault()`, `futureCount()` for `addCount()`.

| Query | `addList` | `addFirstOrDefault` | `addCount` |
|---|---|---|---|
| A table (`db.tags`): every column of every row | yes | yes | yes |
| `where()` / `orderBy()` / `limit()` builders, `select()` projections, `innerJoin()` / `leftJoin()` | yes | yes | yes |
| A grouped `select()` (after `groupBy()`), a grouped join | yes | yes | yes |
| `union()` / `unionAll()`, also of CTE-rooted and set legs | yes | yes (since 1.0.31) | yes (since 1.0.31) |
| A bare `groupBy()` without its `select()` | no | no | no |
| `selectFromCte()` / `selectFromSet()` roots (no future API: run them on their own; their `union()` / `unionAll()` is a union, row above) | no | no | no |

```ts
import { eq, gt, QueryBatch } from 'linkgress-orm';

const batch = new QueryBatch();
const tagsKey = batch.addList(db.tags, 'tags'); // every column of every tag
const usersKey = batch.addCount(db.users, 'users');
const authorsKey = batch.addList(
  db.posts.innerJoin(db.users, (p, u) => eq(p.userId, u.id), (p, u) => ({ title: p.title, author: u.username })),
  'authors',
);
const namesKey = batch.addList(
  db.users.select(u => ({ name: u.username })).unionAll(db.tags.select(t => ({ name: t.name }))),
  'names',
);
const withPostsKey = batch.addList(
  db.users
    .where(u => gt(u.age, 30))
    .select(u => ({
      username: u.username,
      stats: { age: u.age, active: u.isActive },
      posts: u.posts!.select(p => ({ title: p.title })).toList('posts'),
    })),
  'withPosts',
);
await batch.executeBatch();
```

The type checker refuses the other sources:

```ts
// fragment: each line under a @ts-expect-error is a compile error (checked with tsc); do not run these
import { DbCteBuilder, gt, QueryBatch } from 'linkgress-orm';

const b2 = new QueryBatch();
// @ts-expect-error a bare groupBy() is not a source: project it with select() first
b2.addList(db.posts.select(p => ({ userId: p.userId })).groupBy(r => ({ userId: r.userId })), 'g');
const top = new DbCteBuilder().with('top_posts', db.posts.where(p => gt(p.views, 120)).select(p => ({ id: p.id, title: p.title })));
// @ts-expect-error a selectFromCte() root has no future API: run it on its own
b2.addList(db.selectFromCte(top.cte).select(r => ({ id: r.id })), 'cte');
```

A union compiles for all three adders since 1.0.31 (`b2.addCount(union, 'n')` and `b2.addFirstOrDefault(union, 'first')` were compile errors before; see [Count a union or read its first row in a batch](#count-a-union-or-read-its-first-row-in-a-batch)).

The five legs (a table, a count, a join, a union, a projection with a nested object and a collection) are one statement:

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "tags"."id" as "id", "tags"."name" as "name"
  FROM "tags"
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count
  FROM "users"
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."title" as "title", "users_0"."username" as "author"
  FROM "posts"
  INNER JOIN "users" AS "users_0" ON "posts"."user_id" = "users_0"."id"
) __batch_q
UNION ALL
SELECT 3 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  (SELECT "users"."username" as "name"
  FROM "users")
  UNION ALL
  (SELECT "tags"."name" as "name"
  FROM "tags")
) __batch_q
UNION ALL
SELECT 4 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."username" as "username", "users"."age" as "__nested__stats__age", "users"."is_active" as "__nested__stats__active", COALESCE("lateral_0".data, '[]'::json) as "posts"
  FROM "users"
  LEFT JOIN LATERAL (SELECT json_agg(
    json_build_object('title', "title")
  ) as data
  FROM (
    SELECT "lateral_0_posts"."title" as "title"
    FROM "posts" "lateral_0_posts"
    WHERE "lateral_0_posts"."user_id" = "users"."id"
  ) sub) "lateral_0" ON true
  WHERE "users"."age" > $1
) __batch_q
-- params: [30]
```

Result types: `getList(tagsKey)` is `UnwrapDbColumns<Tag>[]`; the projection leg reads `{ username: string; stats: { age: number | undefined; active: boolean }; posts: { title: string }[] }[]`, nested object and collection rebuilt as in the standalone query.

> **Efficiency:** a leg's collections render in one statement under every collection strategy: `lateral` (default) as `LEFT JOIN LATERAL`, `cte` as a `WITH` clause inside the leg, and `temptable` takes the CTE form too. The same `temptable` read run on its own on `PgClient` sent 6 statements (base query, `CREATE TEMP TABLE`, `INSERT`, aggregate, read, `DROP`); inside the batch it was part of the one statement. See [Collection strategies](../collection-strategies.md).

## Batch inside a transaction or under a timeout

Every leg of one batch must come from one context: all from `db`, or all from the same `tx`. Inside `db.transaction()` the batch runs on the transaction's connection and sees its uncommitted rows. A batch has no timeout of its own; the portable way to bound it is the transaction's `timeoutMs`, which sends `SET LOCAL statement_timeout` first, on every client.

```ts
import { gt, QueryBatch } from 'linkgress-orm';

const counts = await db.transaction(async tx => {
  const batch = new QueryBatch();
  const usersKey = batch.addCount(tx.users, 'users');
  const postsKey = batch.addList(tx.posts.where(p => gt(p.views, 100)).select(p => ({ id: p.id })), 'posts');
  await batch.executeBatch();
  return { users: batch.getCount(usersKey), posts: batch.getList(postsKey) };
}, { timeoutMs: 5000 });
// { users: 3, posts: [{ id: 2 }, { id: 3 }] }
```

On `PostgresClient`, every statement on the wire (captured through postgres.js's debug hook):

```sql
-- postgres.js #1
begin
-- postgres.js #2
SET LOCAL statement_timeout = 5000
-- postgres.js #3
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count
  FROM "users"
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."id" as "id"
  FROM "posts"
  WHERE "posts"."views" > $1
) __batch_q
-- params: [100]
-- postgres.js #4
commit
```

On `PgClient` the same code sends `BEGIN`, `SET LOCAL statement_timeout = 5000`, the batch statement and `COMMIT` on the transaction's connection.

On `PostgresClient` there is a second form: build every leg from ONE derived table. Its executor wraps the whole batch the way `withTimeout()` wraps one query.

```ts
import { eq, gt, QueryBatch } from 'linkgress-orm';

const posts = db.posts.withTimeout(5000); // one derived table = one executor
const timedBatch = new QueryBatch();
const popularKey = timedBatch.addCount(posts.where(p => gt(p.views, 100)), 'popular');
const mineKey = timedBatch.addList(posts.where(p => eq(p.userId, 1)).select(p => ({ id: p.id })), 'mine');
await timedBatch.executeBatch();
```

```sql
-- postgres.js #1
begin
-- postgres.js #2
SET LOCAL statement_timeout = 5000
-- postgres.js #3
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT COUNT(*) as count
  FROM "posts"
  WHERE "posts"."views" > $1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."id" as "id"
  FROM "posts"
  WHERE "posts"."user_id" = $2
) __batch_q
-- params: [100, 1]
-- postgres.js #4
commit
```

> **Pitfall:** `withTimeout()` is honored only by `PostgresClient`. On `PgClient`, `BunClient` and `PGliteClient` the derived-table form sends the batch alone, with no timeout (captured on `PgClient`). The transaction's `timeoutMs` is sent on every client; PGlite and the in-memory database never cancel a statement.

> **Efficiency:** on `PostgresClient` both forms add 3 statements to the batch's one (`begin`, `SET LOCAL statement_timeout`, `commit`); the transaction form adds the same 3 on `PgClient`. When one limit may cover every statement, a `statement_timeout` default in the `PostgresClient` / `PgClient` constructor bounds the batch with no extra statement ([Configuration](./configuration.md#cancel-statements-that-run-too-long-withtimeout-and-statement_timeout)).

> **Pitfall:** a batch built from a transaction's objects and executed after the transaction ended throws `TransactionEndedError` and sends nothing (verified). Return plain results from the callback, never the batch.

## Name or un-name the batch statement: `withPreparedStatements()`

`QueryBatch.withPreparedStatements(prepare)` sends the batch's one statement as a named server-side prepared statement (`true`) or unnamed (`false`), whatever the context's `preparedStatements` option says. Without it the batch follows the context. Only `PostgresClient` acts on it; the SQL text does not change.

```ts
// fragment: prepDb is an AppDatabase over a PostgresClient with { preparedStatements: true }
import { gt, QueryBatch } from 'linkgress-orm';

const batch = new QueryBatch().withPreparedStatements(false); // this batch only: unnamed
batch.addList(prepDb.users.where(u => gt(u.id, 0)).select(u => ({ id: u.id })), 'users');
await batch.executeBatch();
```

Verified on `PostgresClient` with `preparedStatements: true`: a plain batch and a `future().execute()` each left one entry in `pg_prepared_statements`; the batch above left none. `new QueryBatch().withPreparedStatements(true)` names the statement on a context without the option.

> **Efficiency:** the batch text is one per set of legs. A batch whose legs all bind array parameters (`= ANY($n::type[])`) tends to be re-planned on every call anyway, because a generic plan cannot see the array sizes; naming it then keeps an unused generic plan and query tree in every pooled connection. `withPreparedStatements(false)` costs that batch postgres.js's describe round trip and saves that cache.

## Fix batch refusals

Every refusal throws before anything is sent.

| Mistake | Message (verified) | Fix |
|---|---|---|
| `executeBatch()` twice, or `add*()` after it | `QueryBatch has already been executed — create a new batch for further queries` | a new `QueryBatch` per round |
| `executeBatch()` with no leg | `QueryBatch is empty — register queries before executing` | register at least one leg, or skip the call |
| Two legs under one id | `QueryBatch: identifier "n" is already registered` (thrown by the `add*()` call) | unique ids |
| A getter before `executeBatch()` | `QueryBatch results are not available — call executeBatch() first` | await `executeBatch()` first |
| An id never registered | `QueryBatch: unknown identifier "nope"` | use the key `add*()` returned |
| The wrong getter (`getList()` on a count leg) | `QueryBatch: "users" was registered as count, not list` | the getter of the adder |
| Legs of two contexts (`db` and `tx`), or a leg with its own executor: `withTimeout()`, `withPreparedStatements()`, `expectedExecutionTime()`, a `withQueryOptions()` that sets an executor option (`logQueries`, `logFailedQueries`, `logExecutionTime`, `onQueryTakingTooLong`, `preparedStatements`), or any `withQueryOptions()` on a context that has one | `QueryBatch: query "posts" uses a different database client or transaction than the rest of the batch — all queries must share one connection context` | build every leg from one context; for a timeout use the transaction's `timeoutMs` |

Legs built from ONE derived table share its executor and mix (`const posts = db.posts.withTimeout(5000)`, above). A `withQueryOptions({ collectionStrategy: 'cte' })` leg also mixes with plain legs on a context without executor options, because then that option creates no executor; on a context with `logQueries: true` the same leg was refused (both verified).

`QueryBatch` does not check the parameter total before sending: PostgreSQL accepts at most 65 535 bound parameters per statement, and `PGliteClient` refuses more than 32 767 before sending (since 1.0.29).

Not refused: a `sql.placeholder()` inside a leg. A placeholder binds only through `prepare()`, and a batch leg has no values for it. As the batch's only leg, the statement is sent and the server refuses it (`there is no parameter $1`); followed by a leg that binds values, the placeholder's `$1` silently takes that leg's first value:

```ts
import { eq, sql, QueryBatch } from 'linkgress-orm';

const b = new QueryBatch();
b.addList(db.users.where(u => eq(u.id, sql.placeholder('userId'))).select(u => ({ id: u.id, username: u.username })), 'byId');
b.addList(db.posts.where(p => eq(p.userId, 2)).select(p => ({ id: p.id })), 'posts');
await b.executeBatch();
b.getList('byId'); // [{ id: 2, username: 'bob' }]: the posts leg's value filled the placeholder
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "users"."id" as "id", "users"."username" as "username"
  FROM "users"
  WHERE "users"."id" = $1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
  SELECT "posts"."id" as "id"
  FROM "posts"
  WHERE "posts"."user_id" = $1
) __batch_q
-- params: [2]
```

Bind values in batch legs as plain values (`eq(u.id, userId)`).

## Get the values the query reads on its own

A batched leg returns what the same query returns on its own through the same client: the same values, of the same JS types, in the same key order, under the client's configuration (the driver's defaults, or the application's own parsers: a postgres.js `types` entry, a node-postgres pool's `types` or `pg.types.setTypeParser()`, PGlite `parsers`). Rows travel as JSON (`row_to_json`), which carries an integer, a text, a boolean or a `json` document as the drivers deliver it, but not a date, an int8 or bytea. For those values the client parses the value's PostgreSQL text, its type's output form as the wire protocol sends it, with the type's OID sent once per leg, exactly as its driver parses such a column (`DatabaseClient.parseTypedText()`; postgres.js, node-postgres and PGlite through their own parsers; `BunClient`, which exposes none, by reproducing Bun's decoding, `bigint: true` included, and its binary-protocol decoding for a leg that binds parameters). A client that reads timestamps as text reads a batched timestamp as that text; one that reads int8 as `BigInt` reads a batched int8 as `BigInt`.

```ts
import { eq, QueryBatch } from 'linkgress-orm';

const batch = new QueryBatch();
const ordersKey = batch.addList(
  db.orders.where(o => eq(o.userId, 1)).select(o => ({ id: o.id, totalAmount: o.totalAmount, createdAt: o.createdAt })),
  'orders',
);
await batch.executeBatch();
const batched = batch.getList(ordersKey);
// batched[0].totalAmount: '99.99' (a string, as toList() returns it on node-postgres); batched[0].createdAt: a Date
```

The declared `decimal` column travels as text beside the JSON row, so its leg takes the typed envelope:

```sql
SELECT 0 AS __batch_ix,
  json_build_object('t', to_json(__batch_s.t::bigint[]),
    'd', (SELECT json_object_agg(__batch_t.oid, __batch_t.typbasetype::bigint)
          FROM pg_catalog.pg_type __batch_t
          WHERE __batch_t.oid = ANY(__batch_s.t) AND __batch_t.typtype = 'd' AND (__batch_t.oid >= 16384)),
    'r', __batch_s.r, 'x', to_json(__batch_s.x)) AS __batch_items
FROM (SELECT coalesce(json_agg(__batch_q.*), '[]'::json) AS r,
             ARRAY[json_agg(concat((__batch_q."totalAmount")))] AS x,
             ARRAY[min(pg_typeof((__batch_q."totalAmount"))::oid)] AS t
      FROM (SELECT * FROM (
        SELECT "orders"."id" as "id", "orders"."total_amount" as "totalAmount", "orders"."created_at" as "createdAt"
        FROM "orders"
        WHERE "orders"."user_id" = $1
      ) __batch_q0 OFFSET 0) __batch_q) __batch_s
-- params: [1]
```

`r` holds the rows, `x` the texts of each text-sent value (one array per value), `t` each value's type OID, `d` the base type of each value that is a user-defined domain.

How each projected value travels:

| Value | How it travels |
|---|---|
| integer, text, boolean, `json` / `jsonb`; counts, sums, conditions; numeric results (`agg.count()` / `sum()` / `avg()`, `round()`, a numeric `literal()`); a `withReadType()` expression of a type JSON carries; a `UNION` column whose legs agree | in the JSON row. A leg made only of these and of the declared columns of the last row uses the plain envelope `coalesce(json_agg(row_to_json(__batch_q)), '[]'::json)` |
| A declared `bigint` / `numeric` / `decimal` column | always also as its text (a JSON number would lose precision); the client parses the driver's exact text unless it parses the type itself |
| A value only PostgreSQL knows the type of: an expression (`dateTrunc()`, `castAsDate()`, `castAsBigInt()`, `coalesce()`, `atTimeZone()`, `lower()`, `agg.arrayAgg()`, a raw `sql` value), a mapped expression (`mapWith()`: its mapper gets what the client delivers), `agg.min()` / `agg.max()`, a scalar subquery, a collection's MIN / MAX, a CTE's expression column, a `UNION` column whose legs declare different types | as text when its runtime type needs it, tested per row with `pg_typeof` |
| A `withReadType()` expression (also the one value of a scalar subquery or a CTE column); a column of a CTE, a table subquery, a set (`crossJoinLateral`) or a manually joined table | by the type it declares: a built-in type JSON carries (`integer`, `text`, `boolean`, `uuid`, `json`, …) rides in the JSON row; any other type is tested per row as in the row above (a `withReadType('timestamp')` value read as a `Date`, a `withReadType('text')` timestamp as its JSON text, verified) |
| A plain select's declared `timestamp` / `timestamptz` / `date` / `bytea` column (the query's table or a navigation) | in the JSON row, restored by the default drivers' rules: a `Date` (a `date` at local midnight), bytea a `Buffer`; a custom mapper of a `date` / `timestamp` / `timestamptz` column gets the driver's text form. See the limitations below |
| Such a column read through a CTE or a table subquery that projects it straight from its table (1.0.34) | as the row above, when that restoring gives what the client's driver gives for the type — a `Date` / `Buffer` for an unmapped column, the driver's text for a mapped one (an app that configures text passthrough for its timestamps); otherwise — the client parses the type otherwise, or hands a mapper something other than the text — as a column of a CTE above |
| A collection's `toList()` read through a table subquery (1.0.34) | in the JSON row, as its `json` list (as text when the client parses `json` itself) |

Declared types are recognised through their parameters and aliases (`bigserial`, `numeric(12,2)`, `timestamp(3)`, `timestamp with time zone`), and read through the column's mapper when it has one.

The types read from their text: `date`, `time`, `timetz`, `timestamp`, `timestamptz`, `interval`, `int8`, `numeric`, `money`, `bytea`, `point`, `circle` and their arrays; user-defined types (an enum, a composite, an extension's type; a domain as the type it is over, so a domain over `integer` keeps its JSON number); and every type the client parses with a parser of its own. For scalar `date`, `time`, `timetz`, `timestamp`, `timestamptz`, `interval`, `money`, `bytea`, `point` and `circle` values the JSON form already gives the text back, so the server sends no text and the client rebuilds it from the row; `date`, `timestamp` and `timestamptz` are sent as text when the session's `DateStyle` is not ISO.

> **Efficiency:** a leg with text-sent values costs a header of about 60 bytes plus about 10 bytes per text-sent value, one `pg_type` lookup for the values that are domains, and per row one type test per runtime-typed value plus the texts needed. The leg is wrapped as `(SELECT * FROM (…) OFFSET 0)` so PostgreSQL evaluates it once per row, as on its own. Measured on PostgreSQL 18: 400 rows each with a correlated scalar `max()` over 20 000 rows took 244 ms batched against 235 ms on its own; without the `OFFSET 0` fence PostgreSQL evaluated the subquery at every reference, 1 184 ms. 50 000 rows of one `lower(md5(…))` took 67 ms against 59 ms for the plain envelope (ordered: 63 ms and 61 ms).

> **Efficiency:** a text repeated within a leg's result is parsed once; every row still gets its own value (a `Date` is copied per row, even when the parser returned one `Date` shared between texts). A value its parser turns into anything but a string, number, boolean, bigint, null or plain `Date` (a `Buffer`, an interval object, a custom parser's object, a frozen `Date`) is parsed row by row, as is a text that a client's own json parser turned into something else.

A leg can send as many values as text in a batch as it selects on its own (a PostgreSQL target list holds 1 664 entries). The JSON rows keep a `json` value untouched (a `\u0000`, a lone surrogate) and every object's keys, a collection's items' included, in their order.

### Known limitations of the JSON transport

- A plain select's **declared `timestamp` / `timestamptz` / `date` / `bytea` column** is restored by the default drivers' rules, whatever the client's own parsers: a client with parsers of its own for these types (a text pass-through, say) reads such a column otherwise when the query runs on its own. A custom mapper of such a column (`hasCustomMapper()`) gets the driver's TEXT form in a batch (`'2024-03-01 06:00:00'`), the convention of applications that configure a timestamp pass-through; a client whose driver parses timestamps into `Date`s hands that mapper a `Date` when the query runs on its own. Read through an expression (`` sql`${column}` ``), such a column is parsed as the client parses it.
- A **collection's list** (`toList()`, `toNumberList()`, a `withAggregation()` list) travels as the JSON the query builds for it. Where the query on its own reads a list as a native array (`toNumberList()` on a client that decodes arrays), a date or timestamp element arrives as its ISO text and an int8 / numeric element as a JSON number.
- A **`withReadType()`** expression travels as the type it declares: declare the type the expression HAS. A value declared as a type JSON carries (text, integer, …) that is not of that type arrives in its JSON form.
- A **domain over a domain** is read by the type the outer domain is over (one level).

Run a leg on its own (`toList()`) when it depends on the client's own parsers for declared `timestamp` / `timestamptz` / `date` / `bytea` columns, or on native array decoding inside a collection.

## Build a read now and run it later: `future()`

`future()`, `futureFirstOrDefault()` and `futureCount()` build a read's final SQL and parameters immediately and return an object that runs it later: alone (`execute()`) or through `FutureQueryRunner`. A `QueryBatch` calls these factories itself: register the builder, not a future (`addList(q.future(), …)` does not compile). Building sends nothing, so `getSql()` / `getParams()` are also the way to see a select's exact statement without running it. To run one query once, call `toList()` / `firstOrDefault()` / `count()` directly: they send the same SQL, except under the `temptable` collection strategy, where a future renders its collections in the one-statement CTE form and `toList()` uses temp tables (6 statements on `PgClient` for one collection).

```ts
import { eq, gt } from 'linkgress-orm';

const activeUsers = db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, username: u.username }))
  .future(); // FutureQuery<{ id: number; username: string }>; nothing sent

activeUsers.getSql();    // 'SELECT "users"."id" as "id", "users"."username" as "username"\nFROM "users"\nWHERE "users"."age" > $1'
activeUsers.getParams(); // [30]

const users = await activeUsers.execute(); // { id: number; username: string }[]
const alice = db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ id: u.id, email: u.email }))
  .futureFirstOrDefault(); // FutureSingleQuery<{ id: number; email: string }>
const aliceRow = await alice.execute(); // { id: number; email: string } | null
const popular = db.posts.where(p => gt(p.views, 100)).futureCount(); // FutureCountQuery
const popularCount = await popular.execute(); // number
```

Each `execute()` is one statement through the executor the builder had (logged, timed, named and time-limited as the context's and the builder's options say; on `PostgresClient` a `withTimeout()` wraps it in `begin` / `SET LOCAL` / `commit`):

```sql
-- #1 query
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."age" > $1
-- params: [30]
-- #2 query
SELECT "users"."id" as "id", "users"."email" as "email"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: ["alice"]
-- #3 query
SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."views" > $1
-- params: [100]
```

| Factory | Class | `execute()` resolves to | SQL |
|---|---|---|---|
| `future()` | `FutureQuery<T>` | `T[]` | the query as built |
| `futureFirstOrDefault()` | `FutureSingleQuery<T>` | `T \| null` | the query with `LIMIT 1`; the builder keeps its own limit |
| `futureCount()` | `FutureCountQuery` | `number` | `SELECT COUNT(*)` without the query's `ORDER BY` / `LIMIT` / `OFFSET`; of a union, `SELECT COUNT(*) as count FROM (<the union>) as union_count` with its `LIMIT` / `OFFSET` |

All three have `getSql(): string` and `getParams(): any[]`. The type guards `isFutureQuery()`, `isFutureSingleQuery()` and `isFutureCountQuery()` tell them apart; the types `AnyFutureQuery`, `FutureQueryResult<F>` and `FutureQueryResults<Fs>` describe them. Tables (every column), `where()` / `select()` / join builders, grouped selects and unions have all three factories (a union's `futureFirstOrDefault()` and `futureCount()` since 1.0.31, refused when its legs declare a data-modifying CTE); CTE-rooted and set queries have none (use their `toSql()` / `toList()`).

> **Pitfall:** a future is frozen when it is built: a later `limit(1)` on its builder does not change it (verified). It is also bound to the context it was built on: a future built on `db` and executed inside `db.transaction()` runs OUTSIDE the transaction (it counted 3 tags while the transaction's own future counted 4, its uncommitted insert included); a future built on `tx` and executed after the transaction throws `TransactionEndedError` without sending anything.

> **Pitfall:** `sql.placeholder()` belongs to `prepare()`. In a future (as in `toList()`) the statement is sent with the placeholder's `$n` unbound and the server refuses it: `there is no parameter $1` when the query binds nothing else, `bind message supplies 1 parameters, but prepared statement "" requires 2` when it binds one other value (both verified).

## Run several futures together: `FutureQueryRunner.runAsync()`

`FutureQueryRunner.runAsync(futures)` executes futures of one context and returns their results as a tuple. It is one round trip only when the client supports multi-statement messages (`PostgresClient`, `BunClient`, `PGliteClient`), every future is parameter-free, and the call is outside a transaction; otherwise it executes each future as its own statement, concurrently. For one round trip WITH parameters, use `QueryBatch`.

```ts
import { FutureQueryRunner } from 'linkgress-orm';

const [allUsers, firstTag, postCount] = await FutureQueryRunner.runAsync([
  db.users.select(u => ({ id: u.id, username: u.username })).future(),
  db.tags.select(t => ({ name: t.name })).futureFirstOrDefault(),
  db.posts.futureCount(),
] as const);
// allUsers: { id: number; username: string }[]; firstTag: { name: string } | null; postCount: number
```

On `PostgresClient` the three parameter-free futures go out as one simple-protocol message (captured through postgres.js's debug hook):

```sql
-- postgres.js #1
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users";
SELECT "tags"."name" as "name"
FROM "tags"
LIMIT 1;
SELECT COUNT(*) as count
FROM "posts"
```

On `PgClient` the same call sends three statements:

```sql
-- #1 query
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
-- #2 query
SELECT "tags"."name" as "name"
FROM "tags"
LIMIT 1
-- #3 query
SELECT COUNT(*) as count
FROM "posts"
```

One bound value anywhere switches `PostgresClient` to one statement per future as well:

```ts
import { eq, FutureQueryRunner } from 'linkgress-orm';

const [alice, tagCount] = await FutureQueryRunner.runAsync([
  db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id })).futureFirstOrDefault(),
  db.tags.futureCount(),
] as const);
```

```sql
-- postgres.js #1
SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: ["alice"]
-- postgres.js #2
SELECT COUNT(*) as count
FROM "tags"
```

| Condition | What runs |
|---|---|
| `PostgresClient` / `BunClient` / `PGliteClient`, outside a transaction, every future parameter-free | one multi-statement message (simple protocol: no describe step, no plan caching) |
| Any future binds a value, or the client is `PgClient` | one statement per future via `Promise.all`, on up to N pooled connections |
| Inside `db.transaction()` | one statement per future, queued on the transaction's connection |
| `runAsync([])` | `[]`, no statement |
| Futures of two contexts | throws `FutureQueryRunner: future #1 uses a different database client or transaction than the rest of the batch — all futures must share one connection context`, nothing sent |

> **Pitfall:** pass the array `as const`. Without it every element of the result is typed as the union of all result types (`{ id: number }[] | number`).

> **Pitfall:** the multi-statement path calls the client directly: `logQueries`, `logFailedQueries`, `onQueryTakingTooLong`, `withTimeout()` and `preparedStatements` do not apply to it.

> **Efficiency:** `bench/querybatch` timed this form on postgres.js (`simple-multi`: the statements joined by `;` over the simple protocol, values inlined as literals): 12 reads took 0.86 ms locally and 31 ms at a 31 ms round-trip time, 10 × 2 000 rows 16.2 ms and 29 ms, the fastest or tied-fastest one-message transport in every scenario (the unnamed `UNION ALL` envelope: 1.50 / 62 ms and 23.8 / 76 ms). `FutureQueryRunner` sends it only when no future binds a value; it never inlines values.

## Build a query once and execute it many times: `prepare()`

`prepare(name)` builds the SQL once, in your process, and returns a `PreparedQuery`; each `execute(values)` binds the values of the `sql.placeholder(name)` slots and sends that same text. Use it on a hot path that re-runs one query shape where query-build CPU matters. It does not save round trips (one statement per `execute()`), and it never asks for a named server-side statement: `PostgresClient`, `PgClient` and `PGliteClient` send it unnamed (on `BunClient`, Bun.SQL's own `prepare` option decides, as for every statement).

```ts
import { eq, sql } from 'linkgress-orm';

const getUserById = db.users
  .where(u => eq(u.id, sql.placeholder('userId')))
  .select(u => ({ id: u.id, username: u.username }))
  .prepare<{ userId: number }>('getUserById'); // builds the SQL now, sends nothing

const alice = await getUserById.execute({ userId: 1 }); // { id: number; username: string }[]
const bob = await getUserById.execute({ userId: 2 });
```

```sql
-- #1 query
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
-- params: [1]
-- #2 query
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
-- params: [2]
```

- Pass the parameter type as the generic: with `prepare<{ userId: number }>(...)`, `execute({})` is a compile error. Without it `execute()` accepts any record, and a missing value throws at run time.
- `execute()` always resolves to an array, `[]` when nothing matches.
- `name` is a label for your code; it is not sent to the server.
- `prepare()` exists on tables (`db.tags.prepare('allTags')` selects every column), `where()` / `orderBy()` builders (every column), and `select()` / join builders. Grouped queries, unions, CTE-rooted and set queries have none.

### Use several placeholders

```ts
import { and, gt, lt, sql } from 'linkgress-orm';

const byAgeRange = db.users
  .where(u => and(gt(u.age, sql.placeholder('minAge')), lt(u.age, sql.placeholder('maxAge'))))
  .select(u => ({ id: u.id, username: u.username, age: u.age }))
  .orderBy(u => u.username)
  .prepare<{ minAge: number; maxAge: number }>('byAgeRange');

await byAgeRange.execute({ minAge: 20, maxAge: 40 }); // alice (25), bob (35)
await byAgeRange.execute({ minAge: 40, maxAge: 60 }); // charlie (45)
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."age" as "age"
FROM "users"
WHERE ("users"."age" > $1 AND "users"."age" < $2)
ORDER BY "username" ASC
-- params: [20, 40]
```

A placeholder also works in a `where()` placed after `select()`; the projected field resolves to its column (`.select(u => ({ id: u.id, ... })).where(u => eq(u.id, sql.placeholder('userId')))` renders `WHERE "users"."id" = $1`).

### Put placeholders in collections, subqueries and `sql` templates

Placeholders are numbered in the order they appear in the statement, wherever they sit.

```ts
import { eq, gt, sql } from 'linkgress-orm';

const withPopularPosts = db.users
  .where(u => eq(u.id, sql.placeholder('userId')))
  .select(u => ({
    id: u.id,
    username: u.username,
    popularPosts: u.posts!
      .where(p => gt(p.views, sql.placeholder('minViews')))
      .select(p => ({ title: p.title, views: p.views }))
      .toList('popularPosts'),
  }))
  .prepare<{ userId: number; minViews: number }>('withPopularPosts');

await withPopularPosts.execute({ userId: 1, minViews: 120 });
// [{ id: 1, username: 'alice', popularPosts: [{ title: 'Alice Post 2', views: 150 }] }]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "popularPosts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id" AND "lateral_0_posts"."views" > $1
) sub) "lateral_0" ON true
WHERE "users"."id" = $2
-- params: [120, 1]
```

In a subquery:

```ts
import { gte, inSubquery, sql } from 'linkgress-orm';

const authorIds = db.posts
  .where(p => gte(p.views, sql.placeholder('minViews')))
  .select(p => p.userId)
  .asSubquery('array');
const authors = db.users
  .where(u => inSubquery(u.id, authorIds))
  .select(u => ({ username: u.username }))
  .orderBy(u => u.username)
  .prepare<{ minViews: number }>('authors');

await authors.execute({ minViews: 150 }); // alice, bob
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."id" IN (SELECT "posts"."user_id"
FROM "posts"
WHERE "posts"."views" >= $1)
ORDER BY "username" ASC
-- params: [150]
```

In an `sql` template:

```ts
import { sql } from 'linkgress-orm';

const older = db.users
  .where(u => sql<boolean>`${u.age} > ${sql.placeholder('minAge')}`)
  .select(u => ({ username: u.username }))
  .prepare<{ minAge: number }>('older');

await older.execute({ minAge: 30 }); // bob, charlie
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."age" > $1
-- params: [30]
```

### Reuse one placeholder name

The same name used twice is one parameter:

```ts
import { eq, gt, or, sql } from 'linkgress-orm';

const atOrAbove = db.users
  .where(u => or(eq(u.age, sql.placeholder('age')), gt(u.age, sql.placeholder('age'))))
  .select(u => ({ username: u.username }))
  .prepare<{ age: number }>('atOrAbove');

atOrAbove.getPlaceholderNames(); // ['age']
await atOrAbove.execute({ age: 35 }); // bob, charlie
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE ("users"."age" = $1 OR "users"."age" > $1)
-- params: [35]
```

### Know which values stay fixed

Every other value the query binds (a literal operand such as `eq(u.isActive, true)`, a `param()`, a CTE's parameters) is bound on every execution with the value it had when the query was prepared; only the placeholders change.

```ts
import { and, eq, gte, param, sql } from 'linkgress-orm';

const activeFrom = db.users
  .where(u => and(eq(u.isActive, true), gte(u.age, sql.placeholder('minAge')), eq(u.email, param('bob@test.com', 'text'))))
  .select(u => ({ username: u.username }))
  .prepare<{ minAge: number }>('activeFrom'); // $1 = true and $3 = 'bob@test.com' fixed, $2 = minAge

await activeFrom.execute({ minAge: 30 }); // bob
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE ("users"."is_active" = $1 AND "users"."age" >= $2 AND "users"."email" = CAST($3 AS text))
-- params: [true, 30, "bob@test.com"]
```

### Inspect a prepared query

```ts
import { and, eq, gt, sql } from 'linkgress-orm';

const prepared = db.users
  .where(u => and(eq(u.id, sql.placeholder('userId')), gt(u.age, sql.placeholder('minAge'))))
  .prepare('myQuery');

prepared.name;                  // 'myQuery'
prepared.getPlaceholderNames(); // ['userId', 'minAge']
prepared.getSql();
// SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age",
// "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata",
// "users"."last_active_at" as "lastActiveAt"
// FROM "users"
// WHERE ("users"."id" = $1 AND "users"."age" > $2)
```

### Know what `execute()` checks and what it skips

| Situation | Result (verified) |
|---|---|
| A placeholder value is missing | throws `Missing parameter: userId`; nothing sent |
| An extra key | ignored |
| A placeholder compared with a column that has a custom mapper (`gt(u.lastActiveAt, sql.placeholder('since'))`, an integer column mapped to `Date`) | the raw JS value is bound, without the mapper's `toDriver`: the server refuses it (`invalid input syntax for type integer`). Pass the value the column stores, or use a plain value (`gt(u.lastActiveAt, date)` binds the converted integer) |
| The context logs (`logQueries`, `logFailedQueries`) or reports slow statements (`onQueryTakingTooLong`) | `execute()` is not logged or timed: it calls the client directly (no logger line, while the same query through `toList()` logged two) |
| The builder had `.withTimeout(5000)` | ignored: no `SET LOCAL statement_timeout` (captured on `PostgresClient`) |
| The context has `preparedStatements: true` | the statement is still sent unnamed on `PostgresClient` (no `pg_prepared_statements` entry) |
| The context has `rawResult: true` with an executor duty such as `logFailedQueries: true` | honored: raw driver rows (`publishTime: 570` instead of `{ hour: 9, minute: 30 }`) |
| Built on `db`, executed inside `db.transaction()` | runs outside the transaction (it did not see the transaction's uncommitted row; the same query prepared from `tx` did) |
| Built on `tx`, executed after the transaction | throws `TransactionEndedError`; nothing sent |

### A complete example

```ts
import { and, gt, like, lt, or, sql } from 'linkgress-orm';

const search = db.users
  .where(u => or(
    and(gt(u.age, sql.placeholder('minAge')), lt(u.age, sql.placeholder('maxAge'))),
    like(u.username, sql.placeholder('usernamePattern')),
  ))
  .select(u => ({
    id: u.id,
    username: u.username,
    age: u.age,
    postCount: u.posts!.count(),
    recentPosts: u.posts!
      .where(p => gt(p.views, sql.placeholder('minViews')))
      .orderBy(p => [[p.publishedAt, 'DESC']])
      .limit(5)
      .select(p => ({ title: p.title, views: p.views }))
      .toList('recentPosts'),
  }))
  .orderBy(u => u.username)
  .prepare<{ minAge: number; maxAge: number; usernamePattern: string; minViews: number }>('search');

const results = await search.execute({ minAge: 30, maxAge: 40, usernamePattern: 'a%', minViews: 50 });
// alice (matches 'a%', 2 posts) and bob (age 35, 1 post)
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."age" as "age", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", COALESCE("lateral_1".data, '[]'::json) as "recentPosts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_1_posts"."title" as "title", "lateral_1_posts"."views" as "views"
  FROM "posts" "lateral_1_posts"
  WHERE "lateral_1_posts"."user_id" = "users"."id" AND "lateral_1_posts"."views" > $1
  ORDER BY "lateral_1_posts"."published_at" DESC
  LIMIT 5
) sub) "lateral_1" ON true
WHERE (("users"."age" > $2 AND "users"."age" < $3) OR "users"."username" LIKE $4)
ORDER BY "username" ASC
-- params: [50, 30, 40, "a%"]
```

## Keep server-side prepared statements apart from `prepare()`

Two different mechanisms carry the word "prepared". They do not combine: `PreparedQuery.execute()` never asks for a named statement, whatever `preparedStatements` says. (On `BunClient` neither mechanism decides naming: Bun.SQL's own `prepare` constructor option, default `true`, applies to every statement it sends.)

| | `prepare()` + `sql.placeholder()` | `preparedStatements: true` / `.withPreparedStatements(true)` |
|---|---|---|
| What it saves | client-side query build per call | server-side parse per call (the plan too, once PostgreSQL switches the statement to a generic plan), and postgres.js's describe round trip |
| Clients | all | `PostgresClient` only (others ignore it) |
| On the wire | unnamed statement, every call (`PostgresClient`, `PgClient`, `PGliteClient`) | named statement, created once per distinct text per pooled connection |
| Applies to | `PreparedQuery.execute()` | builder terminals, `future().execute()`, `QueryBatch` (verified named) |
| Never applies to | builder terminals, futures, batches | `PreparedQuery.execute()`, `db.query()`, `FutureQueryRunner`'s multi-statement message, `MutationBatch`, statements without parameters |
| Configure in | the query | the context, a table, a builder or a batch ([Configuration](./configuration.md#send-statements-named-on-the-server-preparedstatements)) |

To get named statements and a cheaper build on `PostgresClient`, use the ordinary builder on a context with `preparedStatements: true` and reduce its build cost with the query-build caches (`MockRowCache.setEnabled(true)`, see [Configuration](./configuration.md#cut-query-build-cpu-mockrowcache)); the caches shorten each build, `prepare()` skips it, and only the builder's statements can be named.

## Run one query shape many times: pick the tool by client

For one query shape run thousands of times with new values, the client decides between the two mechanisms above. Each call is 1 statement either way; what differs is the build in your process, the parse on the server and, on postgres.js, the network round trips per statement.

| Client | Use | Network round trips per call | Why |
|---|---|---|---|
| `PostgresClient` | the ordinary builder on a context with `preparedStatements: true`, plus `MockRowCache.setEnabled(true)` once at startup | 2 on the first use of the text per pooled connection, then 1 | `prepare()` sends an unnamed statement: Parse/Describe, then Bind/Execute, 2 network round trips on EVERY call, and no logging or timeout |
| `PgClient` | `prepare(name)` + `sql.placeholder(name)`, then `execute(values)` | 1 | node-postgres sends an unnamed statement in one round trip; it ignores `preparedStatements` |
| `BunClient` | `prepare(name)` + `sql.placeholder(name)` | 1 statement; Bun.SQL decides how it prepares it | Bun.SQL names statements itself (its `prepare` option, default `true`), so `prepare()` only has to save the build |
| `PGliteClient` | `prepare(name)` + `sql.placeholder(name)` | none: in-process | it ignores `preparedStatements` |

On every client, keep the ordinary builder with `MockRowCache` when the query needs what `PreparedQuery.execute()` skips: logging, `onQueryTakingTooLong` reports, `.withTimeout()` (`PostgresClient`), or a value bound through a column's custom mapper (a placeholder value skips `toDriver`).

```ts
import { gt, MockRowCache, sql } from 'linkgress-orm';

// PgClient, BunClient, PGliteClient: build once, execute many times
const byMinViews = db.posts
  .where(p => gt(p.views, sql.placeholder('minViews')))
  .select(p => ({ id: p.id, title: p.title }))
  .prepare<{ minViews: number }>('byMinViews');
await byMinViews.execute({ minViews: 100 });   // [{ id: 2, title: 'Alice Post 2' }, { id: 3, title: 'Bob Post' }]
await byMinViews.execute({ minViews: 160 });   // [{ id: 3, title: 'Bob Post' }]

// PostgresClient: the ordinary builder, named on the server, cheaper to build
MockRowCache.setEnabled(true);                                   // once at startup
const preparedDb = new AppDatabase(client, { preparedStatements: true });
const popular = (minViews: number) =>
  preparedDb.posts.where(p => gt(p.views, minViews)).select(p => ({ id: p.id, title: p.title })).toList();
await popular(100);
await popular(160);
```

Both forms send this text, with `[100]` and then `[160]` (captured on `PgClient`, which names nothing; on `PostgresClient` the second form's text is a named statement, created once per pooled connection):

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [ 100 ]
```

> **Pitfall:** a named statement pays off only for a stable text. Under `preparedStatements`, `inArray()` lists of varying length, `limit()` / `offset()` values (written into the text) and optional filters each create another named statement per pooled connection: use `eqAny()` for lists and `.withPreparedStatements(false)` on paging queries ([Configuration](./configuration.md#opt-one-query-in-or-out-withpreparedstatements)).

## Write several independent changes in one statement: `MutationBatch`

`MutationBatch` is the write counterpart of `QueryBatch`: independent inserts, bulk updates, upserts and deletes as one statement of data-modifying CTEs. Its legs run against one snapshot (a leg does not see another leg's writes) and the statement is atomic. An `add*()` call with no rows registers nothing and returns `null`; a statement over 65 535 parameters (32 767 on PGlite) is refused before it is sent (since 1.0.29), and a leg registered `ifFits` (since 1.0.32) returns `null` instead of registering when the statement cannot carry it; the batch never asks for a named statement, whatever `preparedStatements` says. [Inserts, updates, upserts and deletes](./insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch) covers its leg types, `rowGuard`, `returning`, [`ifFits`](./insert-update-guide.md#register-a-leg-only-when-the-statement-can-carry-it-iffits-since-1032), the guarded `addUpdateWhereIn` and its rules.

```ts
import { MutationBatch } from 'linkgress-orm';

const batch = new MutationBatch();
batch.addInsertBulk(db.tags, [{ name: 'Autumn' }, { name: 'Spring' }], 'newTags');
batch.addBulkUpdate(db.posts, [{ id: 1, views: 101 }, { id: 2, views: 151 }], 'views');
batch.addDeleteWhereIn(db.postComments, 'id', [3], 'comments');
await batch.executeBatch();

batch.getAffectedCount('newTags');  // 2
batch.getAffectedCount('views');    // 2
batch.getAffectedCount('comments'); // 1
```

```sql
WITH "__mb_0" AS (
INSERT INTO "tags" ("name") VALUES ($1), ($2)
RETURNING 1
),
"__mb_1" AS (
UPDATE "posts" AS t
SET "views" = CASE WHEN v."views__provided" THEN v."views" ELSE t."views" END
FROM (VALUES ($3::integer, $4::integer, true), ($5::integer, $6::integer, true)) AS v("id", "views", "views__provided")
WHERE t."id" = v."id"
RETURNING 1
),
"__mb_2" AS (
DELETE FROM "post_comments" WHERE "id" IN ($7)
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT count(*)::int FROM "__mb_1") AS "1", (SELECT count(*)::int FROM "__mb_2") AS "2"
-- params: ["Autumn", "Spring", 1, 101, 2, 151, 3]
```

## Pitfalls

- **Don't** `await` independent reads one after another. **Do** register them in one `QueryBatch`: three reads went from three statements to one, and across a 31 ms network 12 reads went from 743 ms to 62 ms.
- **Don't** treat `Promise.all` as a batch. **Do** use `QueryBatch` when latency or pool pressure matters: `Promise.all` sends N statements on up to N pooled connections, and inside a transaction they queue on one connection. Keep `Promise.all` for independent lists of thousands of rows on a server with free connections.
- **Don't** batch reads where one needs another's result. **Do** write one query with navigations or collections; a batch only runs queries whose inputs are known before it is sent.
- **Don't** mix legs from `db` and `tx`, or add a leg with its own `withTimeout()` / `withPreparedStatements()` / `expectedExecutionTime()`, or a `withQueryOptions()` leg that gets an executor of its own (an executor option, or any `withQueryOptions()` on a context with logging, slow-query detection or `preparedStatements`). **Do** build every leg from one context; bound the batch with `db.transaction(fn, { timeoutMs })`. Mixed legs throw before anything is sent.
- **Don't** reuse a `QueryBatch` after `executeBatch()`. **Do** create a new batch per round: the second call throws.
- **Don't** use `countOver()` when a requested page can lie past the end. **Do** batch `addList(page)` + `addCount(page)`: `countOver()` read `totalCount: 0` for `OFFSET 10` while 3 rows matched.
- **Don't** register a paged union for `addCount()` expecting its total. **Do** count the union without `limit()` / `offset()`: a union's count (since 1.0.31) counts its own paging (`limit(1)` counted 1 of 2 rows), unlike a select's.
- **Don't** batch a union whose legs declare a data-modifying CTE. **Do** run its `count()`, `firstOrDefault()` or `toList()` on its own: `addCount()` / `addFirstOrDefault()` throw before anything is sent, and an `addList()` leg makes PostgreSQL refuse the whole batch statement (0A000).
- **Don't** expect `FutureQueryRunner.runAsync()` to be one round trip for parameterised futures, on `PgClient` or in a transaction. **Do** use `QueryBatch`, which is one statement with parameters on every client.
- **Don't** call `runAsync([...])` without `as const`. **Do** pass the array `as const` so each result keeps its own type.
- **Don't** put `sql.placeholder()` in a query run with `toList()`, `future()` or a batch: the statement is sent and refused (`there is no parameter $1`, or `bind message supplies … parameters` when the query binds other values), and in a batch whose later leg binds a value the placeholder silently takes that value. **Do** `prepare()` it and `execute()` it with values; in a batch, use plain values.
- **Don't** rely on `prepare()` for logging, timeouts or named server-side statements. **Do** use the ordinary builder with the context's options when they matter; `PreparedQuery.execute()` bypasses the executor.
- **Don't** compare a placeholder with a custom-mapped column. **Do** pass the stored value yourself or use a plain value, which goes through `toDriver`.
- **Don't** build a future or a `PreparedQuery` on `db` and execute it inside `db.transaction()`. **Do** build it from `tx`: the `db` one runs outside the transaction and misses its uncommitted rows.
- **Don't** batch a leg that depends on the client's own parsers for declared `timestamp` / `timestamptz` / `date` / `bytea` columns. **Do** run it on its own: in a batch those columns are restored by the default drivers' rules.

## See also

- [Choosing the right query](../choosing-the-right-query.md): start here to map a data need to an API and its round trips.
- [Querying guide](./querying.md): one query with navigations and collections; terminals `toList()`, `firstOrDefault()`, `count()`, `exists()`, `countOver()`.
- [Collection strategies](../collection-strategies.md): how the collections inside a leg render (`lateral`, `cte`, `temptable`).
- [Configuration](./configuration.md): `preparedStatements`, `withTimeout()`, logging, slow-query detection, the query-build caches.
- [Inserts, updates, upserts and deletes](./insert-update-guide.md): `MutationBatch`, transactions and `TransactionEndedError`.
- [Database clients](../database-clients.md): which clients support multi-statement messages, per-query timeouts and named statements.
- [CTEs (WITH queries)](./cte-guide.md): `selectFromCte()` reads, which run on their own.
