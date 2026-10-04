# Querying

> **For agents:** Which builder call reads exactly the rows, values or numbers a task needs, which SQL it sends, and in how many round trips?
> **Use this page when:** reading rows or projections, filtering, matching lists, searching text, ordering, paging, counting, testing existence, loading related rows (navigations and collections), joining, aggregating, grouping, ranking, combining result sets, or running raw SQL. **Look elsewhere when:** several independent reads should share one round trip → [Batching and prepared queries](./batching-and-prepared-queries.md); writing rows → [Inserts, updates and deletes](./insert-update-guide.md)
> **Key APIs:** `select()`, `where()`, `orderBy()`, `limit()`, `toList()`, `firstOrDefault()`, `exists()`, `count()`, `countOver()`, `inArrayOpt()`, `groupBy()`, `agg`, `innerJoin()` · **Round trips:** every terminal call is 1 statement, related rows included (default `lateral` collection strategy); the exceptions are the `temptable` strategy (on PgClient 1 + 5 statements per collection) and `withTimeout()` on PostgresClient (3 more)

The examples use the example model `AppDatabase` (`debug/schema/appDatabase.ts`) as `db`, with its seed
data: users `alice` (age 25), `bob` (35) and `charlie` (45, inactive); alice wrote two posts (100 and 150
views), bob one (200 views), charlie none. Navigations used below: `posts.user` (required),
`tasks.level` → `taskLevels.createdBy` (optional), `postComments.post` / `.order`, `orderTasks.task` /
`.order`. Collections: `users.posts`, `users.orders`, `posts.postComments`, `orders.orderTasks`,
`products.productPrices` / `.productTags`, and `carts.cartDiscountCodes`, whose items reach
`discountCode` → `discount` → the collection `discountProducts`. Mapped columns: `posts.publishTime`
(`{ hour, minute }` stored as minutes, `{ hour: 9, minute: 30 }` is `570`) and `posts.customDate` (a `Date`
stored as seconds); every table, column and seed row:
[Example Model and Seed Data](../example-model.md). Every SQL block was captured from the in-memory
PostgreSQL-compatible database; each statement in a block is one round trip and `$n` are bound parameters.

## Contents

- [Choose the call that returns what you need](#choose-the-call-that-returns-what-you-need)
- [Read whole rows: `toList()`](#read-whole-rows-tolist)
- [Select only the columns you need: `select()`](#select-only-the-columns-you-need-select)
- [Get one row: `firstOrDefault()`, `firstOrThrow()`, `first()`](#get-one-row-firstordefault-firstorthrow-first)
- [Check whether rows exist: `exists()`](#check-whether-rows-exist-exists)
- [Count rows without loading them: `count()`](#count-rows-without-loading-them-count)
- [Filter rows: `where()`](#filter-rows-where)
- [Matching a list of values](#matching-a-list-of-values)
- [Search text: patterns, regular expressions, accent-insensitive](#search-text-patterns-regular-expressions-accent-insensitive)
- [Order results: `orderBy()`](#order-results-orderby)
- [Page through results](#page-through-results)
- [Return unique rows: `selectDistinct()`](#return-unique-rows-selectdistinct)
- [Build a query from optional filters](#build-a-query-from-optional-filters)
- [Read a related row's columns: navigations](#read-a-related-rows-columns-navigations)
- [Load each row's children in the same statement: collections](#load-each-rows-children-in-the-same-statement-collections)
- [Join tables without a navigation: `innerJoin()`, `leftJoin()`](#join-tables-without-a-navigation-innerjoin-leftjoin)
- [Aggregate the whole set in one statement: `agg`](#aggregate-the-whole-set-in-one-statement-agg)
- [Group rows: `groupBy()`](#group-rows-groupby)
- [Number and rank rows: window functions](#number-and-rank-rows-window-functions)
- [Combine result sets: `union()`, `unionAll()`](#combine-result-sets-union-unionall)
- [Lock the rows you read: `forUpdate()`](#lock-the-rows-you-read-forupdate)
- [Filter or compute with a subquery](#filter-or-compute-with-a-subquery)
- [Name a derived set once: CTEs](#name-a-derived-set-once-ctes)
- [Write SQL the helpers do not cover: `sql`](#write-sql-the-helpers-do-not-cover-sql)
- [Built-in operators: `coalesce()`, JSONB, flags](#built-in-operators-coalesce-jsonb-flags)
- [See the SQL a query sends](#see-the-sql-a-query-sends)
- [Tune execution per query](#tune-execution-per-query)
- [Efficiency checklist](#efficiency-checklist)
- [Check result types at compile time](#check-result-types-at-compile-time)
- [Example: a user dashboard in one statement](#example-a-user-dashboard-in-one-statement)
- [Read several independent results in one round trip: `QueryBatch`](#read-several-independent-results-in-one-round-trip-querybatch)
- [Build a query once, run it with new values: `prepare()`](#build-a-query-once-run-it-with-new-values-prepare)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose the call that returns what you need

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Every column of the matching rows | `db.users.where(…).toList()` | `SELECT <every column> … WHERE …` · 1 | filtering or counting in JS after `toList()` |
| Some columns, values or expressions | `select(u => ({ id: u.id }))` | `SELECT "users"."id" as "id" …` · 1 | entity rows when two fields are used |
| One row or `null` | `firstOrDefault()` | `… LIMIT 1` · 1 | `(await toList())[0]` |
| One row, an error when there is none | `select(…).firstOrThrow()` | `… LIMIT 1` · 1 | a one-value select whose value can be falsy |
| Whether any row matches | `exists()` | `SELECT EXISTS(SELECT 1 …)` · 1 | `count() > 0`; `any()` / `none()` (do not exist) |
| The number of matching rows | `count()` | `SELECT COUNT(*) as count …` · 1 | `(await toList()).length` |
| A page and the total | `countOver()` or a `QueryBatch` | `COUNT(*) OVER()` or one `UNION ALL` · 1 | `Promise.all([toList(), count()])` · 2 |
| Several totals of one set | `select(p => ({ n: agg.count(), total: agg.sum(p.views) })).firstOrDefault()` | one aggregate row · 1 | builder `sum()` / `min()` / `max()` · 1 each |
| Statistics per key | `select(…).groupBy(…).select(…)` | `GROUP BY` · 1 | grouping rows in JS |
| Each group's members as a list, a distinct count per key | `g.arrayAgg(r => r.id)`, `g.countDistinct(r => r.userId)` in the grouped `select()` (since 1.0.31) | `array_agg(…)`, `count(DISTINCT …)` per group · 1 | folding the grouped rows into lists in JS |
| A related row's columns | `p.user!.username` inside `select()` | one `JOIN` per hop · 1 | a lookup per row |
| Each row's children | `u.posts!.select(…).toList()` inside `select()` | `LEFT JOIN LATERAL (… json_agg …)` · 1 | a query per parent row (N+1) |
| Several independent reads | `QueryBatch` | one `UNION ALL` statement · 1 | sequential `await`s · N |

A chain passes through three builder types: the table (`db.users`, a `DbEntityTable`), a query
(`IEntityQueryable`, returned by `where()`, `orderBy()`, `limit()` and `offset()` of a table) and a select
builder (`EntitySelectQueryBuilder`, returned by `select()`, `selectDistinct()`, `innerJoin()` and
`leftJoin()`). `firstOrThrow()`, `forUpdate()`, `groupBy()`, `union()` / `unionAll()`, `sum()` / `min()` /
`max()` and `asSubquery()` exist only on a select builder: call `select()` first. `selectDistinct()` exists on
the table and on a select builder, not after `where()`. Builders are mutable — see
[Build a query from optional filters](#build-a-query-from-optional-filters).

<a id="basic-queries"></a><a id="simple-select"></a>

## Read whole rows: `toList()`

`toList()` on a table returns every row with every mapped column; on a query it returns the rows its
`where()`, `orderBy()` and `limit()` select. Use it when the task needs the entity rows themselves; use
`select()` when it needs fewer columns.

```ts
import { eq } from 'linkgress-orm';

const users = await db.users.toList();
const active = await db.users.where(u => eq(u.isActive, true)).toList();
// { id, username, email, age, isActive, createdAt, metadata, lastActiveAt }[]
```

```sql
SELECT "id", "username", "email", "age", "is_active", "created_at", "metadata", "last_active_at" FROM "users"

SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age",
  "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata",
  "users"."last_active_at" as "lastActiveAt"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
```

> **Efficiency:** every column of every matching row travels. Without `orderBy()` the row order is unspecified.

> **Pitfall:** navigation properties are never loaded. `alice.posts` compiles (the property is declared
> optional) but is `undefined` at runtime: there is no lazy and no eager loading. Read related rows in the
> same statement through a [navigation](#read-a-related-rows-columns-navigations) or a
> [collection](#load-each-rows-children-in-the-same-statement-collections) in `select()`.

> **Pitfall:** the table-level `toList()`, `first()` and `firstOrDefault()` build their own statement and
> ignore the result options `disableMappers`, `rawResult` and `traceTime` of `withQueryOptions()`.

<a id="selecting-specific-columns"></a>

## Select only the columns you need: `select()`

`select()` returns a new builder whose rows have the shape the selector returns. Only the projected values
travel, and a navigation column (`p.user!.username`) adds the join it needs. Use it for every read that does
not need every column.

```ts
const rows = await db.users
  .select(u => ({ id: u.id, name: u.username }))
  .toList();
// { id: number; name: string }[]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "name"
FROM "users"
```

### Project one value, a condition, a literal or a nested object

A selector that returns ONE column or expression — not an object — reads as the list of that value, and
`firstOrDefault()` reads the value or `null`:

```ts
const names = await db.users.orderBy(u => u.username).select(u => u.username).toList();
// string[]: ['alice', 'bob', 'charlie']
const email = await db.users.where(u => eq(u.id, 1)).select(u => u.email).firstOrDefault();
// string | null: 'alice@test.com'
```

```sql
SELECT "users"."username"
FROM "users"
ORDER BY "users"."username" ASC

SELECT "users"."email"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]
```

The value may be a navigation's column (`db.posts.select(p => p.user!.username).toList()` joins `users` and
reads `['alice', 'alice', 'bob']`) or an `sql` expression. The same holds in a collection
(`u.posts!.select(p => p.title).toList()` is a `string[]`, `.firstOrDefault()` a `string | null`), in a union,
a batch, `countOver()` and a mutation's RETURNING. The value reads through its column's mapper, and the
statement names the column by its own name, so such a query also serves as a subquery or CTE body.

A condition reads as a boolean, a nested object is flattened into `__nested__<key>__<field>` columns, and a
literal — `'member'`, `42`, `true`, `null`, a `Date`, a list of values — reads back as exactly that value
(at the top level, in a nested object, in a collection's items, in a grouped query and in a join of one):

```ts
import { gte, isNotNull } from 'linkgress-orm';

const flags = await db.users.orderBy(u => u.id).limit(2).select(u => ({
  id: u.id,
  isAdult: gte(u.age, 18),                              // boolean
  contact: { hasEmail: isNotNull(u.email), tier: 2 },   // { hasEmail: boolean; tier: number }
  kind: 'member',                                       // a bound parameter; reads 'member'
  since: new Date('2020-01-01T00:00:00Z'),              // reads the Date
})).toList();
```

```sql
SELECT "users"."id" as "id", ("users"."age" >= $1) as "isAdult", ("users"."email" IS NOT NULL) as "__nested__contact__hasEmail",
  $2 as "__nested__contact__tier", $3 as "kind", $4 as "since"
FROM "users"
ORDER BY "id" ASC
LIMIT 2
-- params: [ 18, 2, "member", "2020-01-01T00:00:00.000Z" ]
```

- A string is a value, never a column name: `kind: 'email'` reads the string `'email'`. Use the column
  (`u.email`) to read a column.
- A selector that returns only a literal reads that literal on every row — at the root, in a collection
  (`toList()`, `firstOrDefault()`, `toNumberList()`, `toStringList()`) and in UNION legs:
  `db.users.select(() => 'x').toList()` is `['x', 'x', 'x']` (`SELECT $1 as "value" FROM "users"`).
- In a CTE body and a subquery a literal renders typed from its JS type (`CAST($1 AS boolean)`, an
  integer, a double, text, `timestamptz` for a `Date`, `jsonb` for a list of values), so the query reading it
  sees a boolean, a number, a date (see the [CTE guide](./cte-guide.md#how-a-ctes-columns-read-back)). A UNION
  leg binds it untyped and PostgreSQL returns such a parameter as text: a union reads `42` as `42` but `true`
  as `"true"`. For a discriminator the database should see typed and inline, use
  [`literal('book')`](./sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull).
- An array of COLUMNS (`{ pair: [u.id, u.username] }`, `[p.user]`) has no single SQL value and is refused
  before anything is sent, naming the field: build the array in SQL (``sql`ARRAY[...]` ``,
  `jsonbBuildArray(...)`) or select the columns as an object. An array of values (`tags: ['a', 'b']`) reads
  back as itself.

A navigation column is joined; a navigation row projected whole renders one column per target column:

```ts
const posts = await db.posts.orderBy(p => p.id).limit(1).select(p => ({
  title: p.title,
  author: p.user!.username,   // a column of the related row
  authorRow: p.user,          // the related row: typed and mapped, like the user's own query reads it
})).toList();
```

```sql
SELECT "posts"."title" as "title", "user"."username" as "author", "user"."id" as "__nested__authorRow__id",
  "user"."username" as "__nested__authorRow__username", "user"."email" as "__nested__authorRow__email",
  "user"."age" as "__nested__authorRow__age", "user"."is_active" as "__nested__authorRow__isActive",
  "user"."created_at" as "__nested__authorRow__createdAt", "user"."metadata" as "__nested__authorRow__metadata",
  "user"."last_active_at" as "__nested__authorRow__lastActiveAt"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
ORDER BY "posts"."id" ASC
LIMIT 1
```

> **Efficiency:** a navigation row projected whole reads every column of the target; project the columns
> you use (`author: p.user!.username`) when you do not need the row.

### How projected values read back

Every value of a projection reads back the way it reads at the top level of its own table's query — through
its column's mapper, typed as the driver types its column — wherever the projection puts it:

```ts
import { sql } from 'linkgress-orm';

const read = await db.posts.orderBy(p => p.id).limit(1).select(p => ({
  meta: {
    time: p.publishTime,                                           // a mapped column: { hour: 9, minute: 30 }
    name: p.user!.username,                                        // text stays text
    loud: sql<string>`upper(${p.title})`.mapWith(v => `<${v}>`),   // '<ALICE POST 1>'
    comments: p.postComments!.count(),                             // a count: the number 1
  },
  author: p.user,                                                  // the navigation row, as its columns
})).toList();
```

```sql
SELECT "posts"."publish_time" as "__nested__meta__time", "user"."username" as "__nested__meta__name",
  upper("posts"."title") as "__nested__meta__loud", "user"."id" as "__nested__author__id",
  "user"."username" as "__nested__author__username", "user"."email" as "__nested__author__email",
  "user"."age" as "__nested__author__age", "user"."is_active" as "__nested__author__isActive",
  "user"."created_at" as "__nested__author__createdAt", "user"."metadata" as "__nested__author__metadata",
  "user"."last_active_at" as "__nested__author__lastActiveAt", (SELECT COALESCE(COUNT(*), 0)
FROM "post_comments" "lateral_0_postComments"
WHERE "lateral_0_postComments"."post_id" = "posts"."id") as "__nested__meta__comments"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
ORDER BY "posts"."id" ASC
LIMIT 1
```

- **Nested objects** read each value its own way: a column through its mapper, an `sql` expression through
  its `mapWith()` (an expression's numeric string — a count, a SUM — as a number), NULL as `null`.
- **A navigation row projected whole** (`author: p.user`, `creator: t.level!.createdBy`, even the root row,
  `me: u`) renders as its columns and reads back typed and mapped: timestamps as `Date`s, mapped columns
  mapped. It works in `selectDistinct()`, UNION legs, futures, prepared queries and next to collections under
  every strategy. A missing row (a LEFT JOIN that found none) reads as an object of nulls.
- **A column read through a navigation** keeps its type: a text or uuid column holding digits stays text, a
  jsonb string stays a string. A numeric column (`decimal`, `bigint`) read through a navigation reads as a
  number; at the top level of its own table it reads as the driver delivers it (node-postgres: a string).
- **A column of a CTE or a subquery** reads through the body column's own mapper — see the
  [CTE guide](./cte-guide.md#how-a-ctes-columns-read-back).
- **An `sql` fragment without a mapper** reads through the generic conversion: numeric-looking text becomes
  a number (`'01234'` → `1234`) and NULL reads as `undefined` (the key is present). `.mapWith(String)` or
  `.withReadType('text')` keeps the text. In a grouped select such a fragment reads as the driver delivers it
  (see [Aggregates per group](#aggregates-per-group)).

```ts
const own = await db.orders.orderBy(o => o.id).select(o => ({ id: o.id, total: o.totalAmount })).toList();
// [{ id: 1, total: '99.99' }, …]   decimal at the top level of its table: the driver's string
const viaNavigation = await db.orderTasks
  .orderBy(ot => ot.orderId)
  .select(ot => ({ orderId: ot.orderId, total: ot.order!.totalAmount }))
  .toList();
// [{ orderId: 1, total: 99.99 }, …] the same column through a navigation: a number
```

```sql
SELECT "orders"."id" as "id", "orders"."total_amount" as "total"
FROM "orders"
ORDER BY "id" ASC

SELECT "order_task"."order_id" as "orderId", "order"."total_amount" as "total"
FROM "order_task"
LEFT JOIN "orders" AS "order" ON "order_task"."order_id" = "order"."id"
ORDER BY "orderId" ASC
```

> **Pitfall:** `decimal`, `numeric` and `bigint` columns are typed `number` but arrive at the top level as the
> driver's string (`'99.99'` on node-postgres). Convert them where you read them, or aggregate with
> `agg.sum()`, which reads a number.

<a id="first-single-or-default"></a>

## Get one row: `firstOrDefault()`, `firstOrThrow()`, `first()`

All three add `LIMIT 1`. Pick by what a missing row means to the caller.

| Need | Use | No row matches | Notes |
|---|---|---|---|
| A row or `null` | `firstOrDefault()` | `null` | on tables, queries and select builders |
| A row, an error when missing | `select(…).firstOrThrow()` | throws `Error('No results found')` | only after `select()` or a join |
| — | `first()` on a query or select builder | `null`, typed non-null | behaves as `firstOrDefault()` |
| — | `db.<table>.first()` | throws `Error('Sequence contains no elements')` | no WHERE, no ORDER BY |
| Exactly one row (uniqueness) | `limit(2).toList()` and a length check | `[]` | there is no `single()` |

```ts
const alice = await db.users.where(u => eq(u.username, 'alice')).firstOrDefault();   // User row | null

const latest = await db.posts
  .orderBy(p => [[p.publishedAt, 'DESC'], [p.id, 'DESC']])
  .select(p => ({ id: p.id, title: p.title }))
  .firstOrDefault();                                                             // { id; title } | null

const aliceId = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ id: u.id }))
  .firstOrThrow();                         // { id: number }; throws 'No results found' when no row matches
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age",
  "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata",
  "users"."last_active_at" as "lastActiveAt"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]

SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
ORDER BY "posts"."published_at" DESC, "id" DESC
LIMIT 1

SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]
```

To enforce uniqueness, read two rows:

```ts
const matches = await db.users.where(u => eq(u.email, 'bob@test.com')).limit(2).toList();
if (matches.length > 1) throw new Error('email is not unique');
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age",
  "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata",
  "users"."last_active_at" as "lastActiveAt"
FROM "users"
WHERE "users"."email" = $1
LIMIT 2
-- params: [ "bob@test.com" ]
```

> **Pitfall:** `first()`, `firstOrDefault()` and `firstOrThrow()` call `limit(1)` on the builder they are called
> on: a later `toList()` of the same builder also renders `LIMIT 1` and returns one row. Build the query in a
> function when it runs more than once.

> **Pitfall:** `firstOrThrow()` tests the value, not the row count: a one-value select whose value is `false`,
> `0`, `''` or `null` throws `No results found` although a row exists (verified with
> `select(u => u.isActive)` for charlie). Select an object (`select(u => ({ active: u.isActive }))`). For the
> same reason a one-value `firstOrDefault()` cannot tell a NULL value from a missing row.

> **Pitfall:** without `orderBy()` the "first" row is arbitrary.

<a id="any--none"></a>

## Check whether rows exist: `exists()`

`exists()` returns a boolean from `SELECT EXISTS(…)`. It is the cheapest existence test: PostgreSQL stops at
the first matching row. There is no `any()` or `none()`; negate `exists()`.

```ts
import { gt } from 'linkgress-orm';

const hasInactive = await db.users.where(u => eq(u.isActive, false)).exists();   // true
const hasPosts = await db.posts.exists();                                        // true
const noneOver100 = !(await db.users.where(u => gt(u.age, 100)).exists());       // true
```

```sql
SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."is_active" = $1)
-- params: [ false ]

SELECT EXISTS(SELECT 1 FROM "posts")

SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."age" > $1)
-- params: [ 100 ]
```

> **Efficiency:** one boolean travels, and the scan ends at the first match — cheaper than `count() > 0` or
> fetching a row. `exists()` ignores `orderBy()`, `limit()` and `offset()`.

Per parent row, test children with `u.posts!.exists()` in a projection or `exists(u.posts!)` in `where()`
(see [Filter or order parents by their children](#filter-or-order-parents-by-their-children)).

<a id="count"></a>

## Count rows without loading them: `count()`

`count()` returns the number of rows of FROM, joins and WHERE as a JS number. The projection is not
rendered, and only the navigations the WHERE reads are joined.

```ts
const total = await db.users.count();                                            // 3
const adults = await db.users.where(u => gt(u.age, 30)).count();                 // 2
const byActiveAuthors = await db.posts.where(p => eq(p.user!.isActive, true)).count();   // 3
```

```sql
SELECT COUNT(*) as count FROM "users"

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" > $1
-- params: [ 30 ]

SELECT COUNT(*) as count
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE "user"."is_active" = $1
-- params: [ true ]
```

`count()` ignores `orderBy()`, `limit()`, `offset()` and `selectDistinct()`:

```ts
const ignoresPaging = await db.users.orderBy(u => u.id).limit(1).offset(1).count();   // 3, not 1
const distinctAuthors = db.posts.selectDistinct(p => ({ userId: p.userId }));
const rowsReturned = (await distinctAuthors.toList()).length;                          // 2
const counted = await distinctAuthors.count();                                         // 3
```

```sql
SELECT COUNT(*) as count
FROM "users"

SELECT DISTINCT "posts"."user_id" as "userId"
FROM "posts"

SELECT COUNT(*) as count
FROM "posts"
```

| Need | Use | Avoid |
|---|---|---|
| A page and the total | [`countOver()` or a `QueryBatch`](#a-page-and-the-total-in-one-round-trip) | `count()` of the paged query (ignores the paging) |
| The number of distinct values | `select(p => ({ n: agg.countDistinct(p.userId) })).firstOrDefault()` | `selectDistinct(…).count()` |
| The rows of a limited or DISTINCT query | make the query a [CTE](#name-a-derived-set-once-ctes) and select `agg.count()` from it (below) | `count()` on it; `count()` on the CTE root (it has none) |
| Per-parent counts | `u.posts!.count()` in `select()` | one `count()` per parent |

`count()` is refused for a select of `agg.*` aggregates without `groupBy()` (always one row) and for a
projection holding a set-returning value.

To count the rows a limited or DISTINCT query returns, declare it as a CTE and aggregate the CTE. A
CTE-rooted query (`db.selectFromCte()`) has no `count()`; its `first()` reads the one aggregate row:

```ts
import { agg, DbCteBuilder } from 'linkgress-orm';

const firstTwo = new DbCteBuilder().with('first_two', db.users.orderBy(u => u.id).select(u => ({ id: u.id })).limit(2));
const firstTwoCount = await db.selectFromCte(firstTwo.cte).select(() => ({ n: agg.count() })).first();   // { n: 2 }
```

```sql
WITH "first_two" AS (SELECT "users"."id" as "id"
FROM "users"
ORDER BY "id" ASC
LIMIT 2)
SELECT count(*) as "n"
FROM "first_two"
LIMIT 1
```

<a id="where-filtering"></a>

## Filter rows: `where()`

`where()` adds a WHERE predicate; repeated calls are ANDed. Each JS value becomes a bound parameter, column
operands stay column references, and a navigation the predicate reads is joined.

```ts
import { and, not, or } from 'linkgress-orm';

const activeUsers = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({ id: u.id, name: u.username }))
  .toList();

const picked = await db.users
  .where(u => or(and(eq(u.isActive, true), gt(u.age, 30)), not(eq(u.isActive, true))))
  .select(u => u.username)
  .toList();                                                      // ['bob', 'charlie']
```

```sql
SELECT "users"."id" as "id", "users"."username" as "name"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]

SELECT "users"."username"
FROM "users"
WHERE (("users"."is_active" = $1 AND "users"."age" > $2) OR NOT ("users"."is_active" = $3))
-- params: [ true, 30, true ]
```

A raw `sql` condition used as an operand of `and()` / `or()` — or of chained `where()` calls — renders in
parentheses of its own, so its text keeps its grouping:

```ts
const chained = await db.users
  .where(u => sql<boolean>`${u.age} > ${40} OR ${u.age} < ${30}`)
  .where(u => eq(u.isActive, true))
  .select(u => u.username)
  .toList();                                                      // ['alice']
```

```sql
SELECT "users"."username"
FROM "users"
WHERE (("users"."age" > $1 OR "users"."age" < $2) AND "users"."is_active" = $3)
-- params: [ 40, 30, true ]
```

### Condition functions

| Function | SQL | Notes |
|---|---|---|
| `eq(a, b)`, `ne(a, b)` | `=`, `!=` | either side: a column, a value, an `sql` fragment, a scalar subquery, a placeholder |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` | `gt(p.views, p.userId)` compares two columns |
| `between(c, min, max)` | `c BETWEEN $1 AND $2` (inclusive) | for a half-open range use `and(gte(c, a), lt(c, b))` |
| `isNull(c)`, `isNotNull(c)` | `IS NULL`, `IS NOT NULL` | no parameter |
| `and(…)`, `or(…)`, `not(c)` | `(… AND …)`, `(… OR …)`, `NOT (…)` | one operand renders without parentheses |
| `inArrayOpt`, `eqAny`, `inArray` and their negations | `IN (…)`, `= ANY(…)` | see [Matching a list of values](#matching-a-list-of-values) |
| `like`, `ilike`, `startsWith`, `regexMatches`, `normalizedEq`, … | `LIKE`, `ILIKE`, `^@`, `~`, … | see [Search text](#search-text-patterns-regular-expressions-accent-insensitive) |
| `exists`, `notExists`, `inSubquery`, `gtSubquery`, … | `EXISTS (…)`, `IN (SELECT …)` | see [collections](#filter-or-order-parents-by-their-children) and [subqueries](#filter-or-compute-with-a-subquery) |
| `flagHas`, `flagHasAll`, `flagHasAny`, `flagHasNone` | `((c & $1) != 0)`, … | see [Test bitmask flags](#test-bitmask-flags) |
| `jsonbSelect`, `jsonbSelectText`, `jsonbPath*`, `jsonbContains`, … | `->`, `->>`, `@>`, … | see [Read JSONB fields](#read-jsonb-fields) and [SQL expression helpers](./sql-expressions.md#read-filter-build-and-change-jsonb) |

A value for a column with a custom mapper is bound through the mapper's `toDriver()`: on the integer-backed
`lastActiveAt`, `gt(u.lastActiveAt, new Date('2025-03-01T00:00:00Z'))` renders
`"users"."last_active_at" > $1` with the parameter `5097600`.

### NULL and `undefined` in conditions

| Call | Renders | Effect |
|---|---|---|
| `eq(c, null)`, `eq(c, undefined)` | `c IS NULL` | an unset optional filter value matches only NULL rows |
| `ne(c, null)`, `ne(c, undefined)` | `c IS NOT NULL` | |
| `gt` / `gte` / `lt` / `lte` / `like` / … with `undefined` | throws before anything is sent | `Cannot use > operator with undefined value on field "users"."age". Pass an explicit value or use eq()/ne() which treat undefined as NULL.` |
| `between(c, undefined, 50)` | `BETWEEN $1 AND $2` with `[null, 50]` | no error, no rows |
| `and()`, `or()` with no operands | `WHERE 1=1` | every row |
| `and(…, undefined, …)` | throws a `TypeError` | filter unset conditions out first |

```ts
const filter: { name?: string } = {};
const nullNames = await db.users.where(u => eq(u.username, filter.name)).count();   // 0: IS NULL
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."username" IS NULL
```

### Filter after `select()`

After `select()` the `where()` callback receives the projected shape; a projected column resolves to its
column. A projected `sql` expression renders its output alias, which WHERE cannot see — put such a filter
before `select()`:

```ts
const afterSelect = await db.users
  .select(u => ({ id: u.id, name: u.username }))
  .where(r => eq(r.name, 'bob'))                          // works: name is the username column
  .toList();

const beforeSelect = await db.users
  .where(u => eq(sql<string>`upper(${u.username})`, 'BOB'))   // the expression, before select()
  .select(u => ({ id: u.id, loud: sql<string>`upper(${u.username})` }))
  .toList();
```

```sql
SELECT "users"."id" as "id", "users"."username" as "name"
FROM "users"
WHERE "users"."username" = $1
-- params: [ "bob" ]

SELECT "users"."id" as "id", upper("users"."username") as "loud"
FROM "users"
WHERE upper("users"."username") = $1
-- params: [ "BOB" ]
```

The same filter written after `select()` (`.where(r => eq(r.loud, 'BOB'))`) reaches PostgreSQL and fails:

```sql
SELECT "users"."id" as "id", upper("users"."username") as "loud"
FROM "users"
WHERE "loud" = $1
-- params: [ "BOB" ]
-- error: column "loud" does not exist
```

## Matching a list of values

The three operator pairs below return the same rows for the same list and differ only in how the list
reaches the server; a subquery computes the list in the database instead.

| Need | Use | SQL shape | Avoid |
|---|---|---|---|
| A data-driven list (ids, cart items): the default | `inArrayOpt(col, list)`, `notInArrayOpt` | `IN ($1, …)` up to 8 elements, `= ANY($1::integer[])` above · bounded statement texts | — |
| One statement text for every length; long lists | `eqAny(col, list)`, `neAll` | `= ANY($1::integer[])` · 1 parameter | constant short lists whose exact estimate matters under a generic plan |
| Short constant lists (enum members) | `inArray(col, list)`, `notInArray` | `IN ($1, $2, $3)` · 1 parameter per element | data-driven lists (one text per length); more than 65,535 elements (32,767 on PGlite) |
| Values another query computes | `inSubquery()`, `eqAnySubquery()` | `IN (SELECT …)` | fetching the ids first (2 round trips) |

### Letting the list length decide: `inArrayOpt` / `notInArrayOpt`

`inArrayOpt` renders `inArray` up to a threshold and `eqAny` above it; `notInArrayOpt` does the same with
`notInArray` / `neAll`. Use it wherever the list comes from data.

```ts
import { inArrayOpt, notInArrayOpt } from 'linkgress-orm';

const userIds = [1, 2, 3];
const users = await db.users.where(u => inArrayOpt(u.id, userIds)).select(u => u.username).toList();

const manyIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const many = await db.users.where(u => inArrayOpt(u.id, manyIds)).select(u => u.username).toList();
const others = await db.users.where(u => notInArrayOpt(u.id, manyIds)).select(u => u.username).toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN ($1, $2, $3)
-- params: [ 1, 2, 3 ]

SELECT "users"."username"
FROM "users"
WHERE ("users"."id" = ANY($1::integer[]))
-- params: [ "{1,2,3,4,5,6,7,8,9}" ]

SELECT "users"."username"
FROM "users"
WHERE ("users"."id" <> ALL($1::integer[]))
-- params: [ "{1,2,3,4,5,6,7,8,9}" ]
```

Why a threshold: under named prepared statements PostgreSQL gives a short fixed-length `IN` text a cached
generic plan after five executions, while `= ANY($1)` is re-planned on every call for arrays of up to about
ten elements (its generic plan assumes ~10 elements, so the custom plan keeps winning) and settles on a
generic plan only from roughly 30 elements on. Above the threshold every extra `IN` length would be one more
statement text and one more cached plan per pooled connection.

The threshold defaults to `8` (`LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD`) and is process-wide, because
the operators are plain functions with no context in reach inside a `where()` callback. Set it through
`LinkgressConfig`, the public surface for library-wide settings:

```ts
import { LinkgressConfig } from 'linkgress-orm';

LinkgressConfig.inArrayOptThreshold = 12;                // property setter
LinkgressConfig.configure({ inArrayOptThreshold: 12 });  // or several settings at once
LinkgressConfig.inArrayOptThreshold;                     // -> 12
new AppDatabase(client, { inArrayOptThreshold: 12 });    // QueryOptions writes the same process-wide value
LinkgressConfig.resetToDefaults();                       // 8, no padding, inArrayUsesOpt off
```

`0` sends every non-empty list to the array form (`("users"."id" = ANY($1::integer[]))` with `'{1}'`). An
invalid value (negative, not an integer) throws and keeps the current one.

> **Pitfall:** the threshold, the pad ladder and `inArrayUsesOpt` are process-wide. Constructing ANY context
> with `inArrayOptThreshold: 2` in its options changed the SQL of an already constructed context to
> `= ANY($1::integer[])` for a 3-element list (verified).

### One parameter for every length: `eqAny` / `neAll`

`eqAny` / `neAll` bind the whole list as ONE parameter — a PostgreSQL array literal string, so it binds on
every driver, Bun included — cast to the column's declared element type, and render parenthesized so the
predicate stays one operand wherever it is composed:

```ts
import { eqAny, neAll } from 'linkgress-orm';

const some = await db.users.where(u => eqAny(u.id, [1, 2, 3])).select(u => u.username).toList();
const rest = await db.users.where(u => neAll(u.id, [1, 2])).select(u => u.username).toList();    // ['charlie']
const open = await db.orders.where(o => eqAny(o.status, ['pending', 'completed'])).select(o => o.id).toList();
const named = await db.users.where(u => eqAny(u.username, ['alice', 'bob'])).select(u => u.id).toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE ("users"."id" = ANY($1::integer[]))
-- params: [ "{1,2,3}" ]

SELECT "users"."username"
FROM "users"
WHERE ("users"."id" <> ALL($1::integer[]))
-- params: [ "{1,2}" ]

SELECT "orders"."id"
FROM "orders"
WHERE ("orders"."status" = ANY($1::order_status[]))
-- params: [ "{\"pending\",\"completed\"}" ]

SELECT "users"."id"
FROM "users"
WHERE ("users"."username" = ANY($1::varchar[]))
-- params: [ "{\"alice\",\"bob\"}" ]
```

The cast comes from the column, through custom mappers too: a `uuid` column yields `::uuid[]`, an enum
column `::order_status[]`, a `serial` column `::integer[]`, a `char(n)` column `::bpchar[]` (a literal
`char[]` would truncate every value to one character). Columns whose refs carry no type information, such
as CTE columns, stay uncast and PostgreSQL infers the array type. An empty list binds `'{}'`:
`= ANY('{}')` is FALSE, `<> ALL('{}')` TRUE.

| | `inArray` / `notInArray` | `eqAny` / `neAll` |
|---|---|---|
| Parameters | one per element (at most 65,535 per statement; 32,767 on PGlite) | always one |
| Statement text | changes with the list length | fixed |
| Row estimate under a generic plan (`preparedStatements`, after five executions) | exact per element | default selectivity |

Unnamed statements (the default) and custom plans are planned with the bound array, so the estimate differs
only under a generic plan.

### Exact placeholders: `inArray` / `notInArray`

`inArray` / `notInArray` render one placeholder per element. Keep them for short constant lists in queries
hand-tuned around the planner's exact estimate.

```ts
import { inArray, notInArray } from 'linkgress-orm';

const three = await db.users.where(u => inArray(u.id, [1, 2, 3])).select(u => u.username).toList();
const notTwo = await db.users.where(u => notInArray(u.id, [1, 2])).select(u => u.username).toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN ($1, $2, $3)
-- params: [ 1, 2, 3 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" NOT IN ($1, $2)
-- params: [ 1, 2 ]
```

- An empty list is a constant: `inArray(c, [])` renders `WHERE 1=0` (no row, a NULL operand included) and
  `notInArray(c, [])` `WHERE 1=1` (every row). It binds nothing: the operand never reaches the statement, so
  the parameters of an expression operand (`coalesce(jsonbPathText(…, param('tier', 'text')), '')`) are left
  out with it. `inArrayOpt` / `notInArrayOpt` behave the same.
- A value that is not an array (a comma-separated string, say) silently degrades to the same constants.
- NOT IN with a NULL element filters every row out: `notInArray(u.age, [25, null])` returned no row. A row
  whose own column is NULL never passes NOT IN either. `neAll` behaves the same.
- The column's `toDriver()` mapper is applied to each element.

### Collapsing the short band too: `inArrayPadBuckets` (opt-in)

The threshold only collapses lengths above it. Below it every list still gets one placeholder per element,
so a family whose lists range over 1…8 elements leaves eight statement texts on each pooled connection. A
bucket ladder rounds each list up to the next rung and fills the gap by repeating its last element:

```ts
LinkgressConfig.inArrayPadBuckets = [1, 4, 8];   // off (null) by default; DEFAULT_IN_ARRAY_PAD_BUCKETS is [1, 4, 8]

const padded3 = await db.users.where(u => inArrayOpt(u.id, [1, 2, 3])).count();
const padded5 = await db.users.where(u => inArrayOpt(u.id, [1, 2, 3, 4, 5])).count();
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."id" IN ($1, $2, $3, $4)
-- params: [ 1, 2, 3, 3 ]

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."id" IN ($1, $2, $3, $4, $5, $6, $7, $8)
-- params: [ 1, 2, 3, 4, 5, 5, 5, 5 ]
```

Repeating a value keeps the results identical — `x IN (a, b, b)` selects what `x IN (a, b)` does, and the
same holds for `NOT IN`, so `notInArrayOpt` pads the same way. Padding with NULL would not: PostgreSQL treats
a NULL element as matching nothing, which changes the row estimate and, for `NOT IN`, the result.

A widened statement is planned for its rung rather than for the list that arrives. Measured on PostgreSQL 18
that is free from three elements up but costs about 32 % on single-element lists and 26 % on two-element
ones: keep the low rungs tight. `[1, 2, 8]` pays nothing; `[1, 4, 8]` accepts the two-element cost for the
same number of texts. An empty list keeps its constant (there is no element to repeat), and a list longer
than the top rung is widened to the threshold, so raising the threshold extends the ladder. The rungs must
be positive integers in strictly ascending order; anything else throws and keeps the current ladder.

### Applying it to plain `inArray`: `inArrayUsesOpt` (opt-in)

The ladder and the threshold reach only call sites written as `inArrayOpt`. In a codebase that calls
`inArray` in hundreds of places, one switch gives every call the same rendering:

```ts
LinkgressConfig.inArrayPadBuckets = null;            // no pad ladder (the default)
LinkgressConfig.inArrayUsesOpt = true;               // off by default

const viaOpt3 = await db.users.where(u => inArray(u.id, [1, 2, 3])).count();
const viaOpt9 = await db.users.where(u => inArray(u.id, [1, 2, 3, 4, 5, 6, 7, 8, 9])).count();
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."id" IN ($1, $2, $3)
-- params: [ 1, 2, 3 ]

SELECT COUNT(*) as count
FROM "users"
WHERE ("users"."id" = ANY($1::integer[]))
-- params: [ "{1,2,3,4,5,6,7,8,9}" ]
```

With it on, `inArray` and `notInArray` render exactly what `inArrayOpt` and `notInArrayOpt` render — same
threshold, same ladder, same array form above it. The rows never change, only the statement text, which is
why it is safe to flip for a whole process. Leave it off when hand-tuned queries depend on the planner seeing
an exact-length `IN` list; explicit `inArrayOpt` calls keep their rendering either way. It is also set by
`LinkgressConfig.configure({ inArrayUsesOpt: true })` and by `new AppDatabase(client, { inArrayUsesOpt: true })`.

<a id="startswith-operator"></a><a id="regex-operators"></a>

## Search text: patterns, regular expressions, accent-insensitive

| Need | Use | SQL | Index that can serve it |
|---|---|---|---|
| Case-sensitive prefix | `startsWith(c, 'al')` or `like(c, startsWithSearch('al'))` | `c ^@ $1`, `c LIKE $1` | btree only under the C collation (`^@`: PostgreSQL 15+) or, for LIKE, a `text_pattern_ops` btree; SP-GiST for `^@` |
| Case-insensitive substring | `ilike(c, containsSearch('bob'))` | `c ILIKE $1` with `'%bob%'` | pg_trgm GIN / GiST |
| Patterns LIKE cannot express | `regexMatches`, `regexMatchesCaseInsensitive`, `regexNoMatch`, `regexNoMatchCaseInsensitive` | `~`, `~*`, `!~`, `!~*` | pg_trgm GIN / GiST |
| Accent- and case-insensitive match | `normalizedEq`, `normalizedStartsWith`, `normalizedLike` | `public.search_normalize(c) = public.search_normalize($1)` | `ixNormalized(col)` (btree), `ixNormalized(col, { gin: true })` (trigram) |

### Match a pattern: `like`, `ilike`, `startsWith`

`containsSearch(v)`, `startsWithSearch(v)` and `endsWithSearch(v)` build the pattern strings `'%v%'`, `'v%'`
and `'%v'`; the pattern is always a bound parameter.

```ts
import { containsSearch, endsWithSearch, ilike, like, startsWith, startsWithSearch } from 'linkgress-orm';

const found = await db.users
  .where(u => or(
    like(u.username, startsWithSearch('al')),   // 'al%'
    ilike(u.email, containsSearch('BOB')),       // '%BOB%'
    like(u.email, endsWithSearch('@x.com')),     // '%@x.com'
    startsWith(u.username, 'ch'),                // ^@
  ))
  .select(u => u.username)
  .toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE ("users"."username" LIKE $1 OR "users"."email" ILIKE $2 OR "users"."email" LIKE $3 OR "users"."username" ^@ $4)
-- params: [ "al%", "%BOB%", "%@x.com", "ch" ]
```

> **Pitfall:** the pattern builders do not escape `%` and `_` in their input: `like(u.username, containsSearch('_'))`
> matched every user. Escape user input first:

```ts
const input = '_';
const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`);
const literalUnderscore = await db.users.where(u => like(u.username, containsSearch(escapeLike(input)))).count();   // 0
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."username" LIKE $1
-- params: [ "%\\_%" ]
```

> **Efficiency:** PostgreSQL decides index use. A btree serves a prefix pattern (`LIKE 'p%'`, `^@`) only under
> the C collation (`^@` since PostgreSQL 15) or, for LIKE, with a `text_pattern_ops` index; otherwise the
> predicate scans. A leading `%` needs a pg_trgm GIN or GiST index. The in-memory database cannot show plans.

### Match a regular expression

`regexMatches` (`~`), `regexMatchesCaseInsensitive` (`~*`), `regexNoMatch` (`!~`) and
`regexNoMatchCaseInsensitive` (`!~*`) take POSIX regular expressions and respect the column's collation.

```ts
import { regexMatches, regexMatchesCaseInsensitive, regexNoMatch, regexNoMatchCaseInsensitive } from 'linkgress-orm';

const matching = await db.users
  .where(u => or(regexMatches(u.username, '^[a-b]'), regexMatchesCaseInsensitive(u.email, 'CHARLIE@TEST\\.COM$')))
  .select(u => u.username)
  .toList();

const notMatching = await db.users
  .where(u => regexNoMatch(u.username, '^[0-9]'))
  .where(u => regexNoMatchCaseInsensitive(u.username, 'BOB'))
  .select(u => u.username)
  .toList();                                        // ['alice', 'charlie']
```

```sql
SELECT "users"."username"
FROM "users"
WHERE ("users"."username" ~ $1 OR "users"."email" ~* $2)
-- params: [ "^[a-b]", "CHARLIE@TEST\\.COM$" ]

SELECT "users"."username"
FROM "users"
WHERE ("users"."username" !~ $1 AND "users"."username" !~* $2)
-- params: [ "^[0-9]", "BOB" ]
```

> **Pitfall:** escape regex metacharacters of user input; in a JS string a literal dot is `'\\.'`.

### Normalized (accent/case-insensitive) search

`normalizedEq`, `normalizedStartsWith` and `normalizedLike` wrap both operands in
`public.search_normalize()` — `lower(public.unaccent(…))` — so `'José'`, `'jose'` and `'JOSÉ'` match. The
function exists only when the model declares an `ixNormalized` index or calls `model.useSearchNormalize()`
in `setupModel`; the schema manager then creates it. Without it the query fails with
`function public.search_normalize(character varying) does not exist` (the example model declares none).
Back the column with an [`ixNormalized` index](./schema-configuration.md#search-case--and-accent-insensitively-ixnormalized):

```ts
// fragment: inside setupModel(), in model.entity(User, entity => { … })
entity.hasIndex('ix_users_username_norm', e => [ixNormalized(e.username)]);
```

```sql
CREATE EXTENSION IF NOT EXISTS unaccent

CREATE OR REPLACE FUNCTION public.search_normalize(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(public.unaccent('public.unaccent', value))
$$

CREATE INDEX IF NOT EXISTS "ix_users_username_norm" ON "users" (public.search_normalize("username") text_pattern_ops)
```

```ts
import { normalizedEq, normalizedLike, normalizedStartsWith, searchNormalize } from 'linkgress-orm';

// users: 'José', 'JOSEPH', 'Zoë'
const jose = await db.users.where(u => normalizedEq(u.username, 'jose')).select(u => u.username).toList();
// ['José']
const jos = await db.users.where(u => normalizedStartsWith(u.username, 'JOS')).select(u => u.username).toList();
// ['José', 'JOSEPH']: '%' is appended after normalization
const oe = await db.users.where(u => normalizedLike(u.username, containsSearch('OE'))).select(u => u.username).toList();
// ['Zoë']: normalizedLike adds no wildcards of its own

const query = 'zo';
const building = await db.users
  .where(u => sql<boolean>`${searchNormalize(u.username)} LIKE ${searchNormalize(containsSearch(query))}`)
  .select(u => ({ name: u.username, normalized: searchNormalize(u.username) }))
  .toList();
// [{ name: 'Zoë', normalized: 'zoe' }]
```

```sql
SELECT "users"."username"
FROM "users"
WHERE (public.search_normalize("users"."username") = public.search_normalize($1))
-- params: [ "jose" ]

SELECT "users"."username"
FROM "users"
WHERE (public.search_normalize("users"."username") LIKE public.search_normalize($1) || '%')
-- params: [ "JOS" ]

SELECT "users"."username"
FROM "users"
WHERE (public.search_normalize("users"."username") LIKE public.search_normalize($1))
-- params: [ "%OE%" ]

SELECT "users"."username" as "name", public.search_normalize("users"."username") as "normalized"
FROM "users"
WHERE public.search_normalize("users"."username") LIKE public.search_normalize($1)
-- params: [ "%zo%" ]
```

| Function | SQL |
|---|---|
| `normalizedEq(field, value)` | `(search_normalize(field) = search_normalize(value))` |
| `normalizedLike(field, pattern)` | `(search_normalize(field) LIKE search_normalize(pattern))` — pass your own wildcards |
| `normalizedStartsWith(field, value)` | prefix match; `'%'` appended after normalization |
| `searchNormalize(fieldOrValue)` | `public.search_normalize(…)` as a composable `SqlFragment` |
| `containsSearch` / `startsWithSearch` / `endsWithSearch` | build `%x%` / `x%` / `%x` patterns |

> **Efficiency:** `ixNormalized(col)` (btree, `text_pattern_ops`) serves `normalizedEq` and
> `normalizedStartsWith`; a `%contains%` `normalizedLike` needs `ixNormalized(col, { gin: true })`. Without an
> index on the same expression every row is normalized.

<a id="ordering-results"></a>

## Order results: `orderBy()`

`orderBy()` takes a key, keys, or `[key, direction]` pairs. Every `orderBy()` — of a table, a projection, a
collection, a grouped query, a union — takes the same forms:

| Form | Example | Orders by |
|---|---|---|
| one key | `u => u.username` | `username ASC` |
| keys | `u => [u.isActive, u.username]` | each ascending |
| `[key, direction]` pairs | `u => [[u.isActive, 'DESC'], [u.username, 'ASC']]` | as given |
| one flat pair | `u => [u.age, 'DESC']` | `age DESC` |
| pairs and keys mixed | `u => [[u.isActive, 'DESC'], u.username]` | `is_active DESC, username ASC` |
| a pair without direction | `u => [[u.username]]` | `username ASC` |

```ts
const byName = await db.users.orderBy(u => u.username).select(u => u.username).toList();
const oldestFirst = await db.users.orderBy(u => [[u.age, 'DESC']]).select(u => u.username).toList();
const mixed = await db.users.orderBy(u => [[u.isActive, 'DESC'], u.username]).select(u => u.username).toList();
```

```sql
SELECT "users"."username"
FROM "users"
ORDER BY "users"."username" ASC

SELECT "users"."username"
FROM "users"
ORDER BY "users"."age" DESC

SELECT "users"."username"
FROM "users"
ORDER BY "users"."is_active" DESC, "users"."username" ASC
```

A direction is `ASC` or `DESC`, optionally followed by `NULLS FIRST` / `NULLS LAST` (`'DESC NULLS LAST'`), in
any case and spacing. PostgreSQL's defaults apply otherwise: NULLs sort last ascending and first descending.
A key that is `false`, `null` or `undefined` is left out, so a key can depend on a condition:

```ts
const posts = await db.posts
  .orderBy(p => [[p.subtitle, 'ASC NULLS FIRST'], p.title])
  .select(p => p.title)
  .toList();

const byActivity = false;
const conditional = await db.users
  .orderBy(u => [byActivity && [u.isActive, 'DESC'], u.username])
  .select(u => u.username)
  .toList();
```

```sql
SELECT "posts"."title"
FROM "posts"
ORDER BY "posts"."subtitle" ASC NULLS FIRST, "posts"."title" ASC

SELECT "users"."username"
FROM "users"
ORDER BY "users"."username" ASC
```

Anything else that is not a key is refused before anything is sent, with the reason: a string (a column NAME
— `'username'` — or a direction on its own), a number (an ORDER BY position), `true`, a function, a whole
navigation row (`p => p.user` — order by one of its columns), a direction that is none, a pair of more than
two values. For example `orderBy(() => 'username')` throws `orderBy(): "username" is a string, not a key: a key
is a column read off the row (row => row.name) or an SQL expression.`

A key can be a column of a navigation, before or after `select()`. Before it, the navigation is joined for
the ORDER BY alone; after it, a key can be a projected column, a leaf of a nested object, an `sql` fragment,
or a column of a navigation row projected whole:

```ts
const tasks = await db.orderTasks
  .orderBy(ot => [[ot.task!.level!.name, 'ASC'], [ot.sortOrder, 'DESC']])
  .select(ot => ({ orderId: ot.orderId, taskId: ot.taskId }))
  .toList();

const rows = await db.orderTasks
  .select(ot => ({ orderId: ot.orderId, level: { name: ot.task!.level!.name }, task: ot.task }))
  .orderBy(r => [r.level.name, r.task!.title])
  .toList();
```

```sql
SELECT "order_task"."order_id" as "orderId", "order_task"."task_id" as "taskId"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
ORDER BY "level"."name" ASC, "order_task"."sort_order" DESC

SELECT "order_task"."order_id" as "orderId", "level"."name" as "__nested__level__name", "task"."id" as "__nested__task__id",
  "task"."title" as "__nested__task__title", "task"."status" as "__nested__task__status",
  "task"."priority" as "__nested__task__priority", "task"."level_id" as "__nested__task__levelId"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
ORDER BY "level"."name" ASC, "task"."title" ASC
```

A key keeps meaning the column it was written against: when a later `select()` renames or drops it, the query
still orders by that column (and joins its navigation). A navigation keyed on a principal key other than
`id` joins on that key; a missing (NULL) navigation sorts like NULL. Each `orderBy()` of a query REPLACES the
previous one — only the last one's navigations are joined (a collection's `orderBy()` appends instead, see
[collections](#filter-order-and-limit-each-parents-children)).

```ts
const replaced = await db.users.orderBy(u => u.age).orderBy(u => [[u.username, 'DESC']]).select(u => u.username).toList();
const droppedKey = await db.users.orderBy(u => [[u.age, 'DESC']]).select(u => ({ name: u.username })).toList();
```

```sql
SELECT "users"."username"
FROM "users"
ORDER BY "users"."username" DESC

SELECT "users"."username" as "name"
FROM "users"
ORDER BY "users"."age" DESC
```

A key can also be an SQL expression — an `sql` fragment, a condition, or a collection's `count()` /
`exists()`. It renders parenthesized, its parameters numbered with the query's, and the navigations it reads
are joined:

```ts
const users = await db.users
  .orderBy(u => [
    [sql<number>`position(${'a'} in ${u.username})`, 'DESC'],   // a bound parameter
    [eq(u.username, 'charlie'), 'DESC'],                         // a condition: TRUE first
    [u.id, 'ASC'],
  ])
  .select(u => u.username)
  .toList();

const busiest = await db.users
  .orderBy(u => [[u.posts!.count(), 'DESC'], u.username])
  .select(u => ({ name: u.username }))
  .toList();

// After select(), a fragment reads a projected COLUMN as that column, also under a navigation alias
const authors = await db.posts
  .select(p => ({ id: p.id, author: p.user!.username }))
  .orderBy(r => [[sql<string>`lower(${r.author})`, 'DESC'], r.id])
  .toList();
```

```sql
SELECT "users"."username"
FROM "users"
ORDER BY (position($1 in "users"."username")) DESC, ("users"."username" = $2) DESC, "users"."id" ASC
-- params: [ "a", "charlie" ]

SELECT "users"."username" as "name"
FROM "users"
ORDER BY (SELECT COUNT(*) FROM "posts" "posts__count"
WHERE "posts__count"."user_id" = "users"."id") DESC, "users"."username" ASC

SELECT "posts"."id" as "id", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
ORDER BY (lower("user"."username")) DESC, "id" ASC
```

A fragment written after `select()` cannot read a projected fragment or literal — there is no column behind
it, and an output alias is visible to ORDER BY only standing alone. Order by that value itself
(`orderBy(r => [[r.shout, 'DESC']])` renders `ORDER BY "shout" DESC`) or build the expression from its
columns; otherwise `orderBy()` throws `orderBy(): an expression cannot read the projected value "shout", which is
not a column — order by that value itself, or build the expression from the columns it is computed from.`

> **Efficiency:** an index on the ORDER BY key plus `limit()` lets PostgreSQL stop early instead of sorting
> every matching row. Order by a unique key last (`p.id`) for a deterministic page order.

<a id="pagination"></a><a id="pagination-with-total-count"></a>

## Page through results

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| A shallow page | `orderBy(…).offset(n).limit(m)` | `LIMIT m OFFSET n` (inlined literals) · 1 | an unordered page |
| A deep page / infinite scroll | keyset: `where(u => gt(u.id, lastId)).orderBy(u => u.id).limit(m)` | `WHERE "id" > $1 ORDER BY "id" LIMIT m` · 1 | large `offset()` values (reads and discards every skipped row) |
| A page and the total | `countOver()` | `COUNT(*) OVER()` column · 1 | a page past the end (reports total 0) |
| A page and the total, any page | `QueryBatch` with `addList()` + `addCount()` | one `UNION ALL` statement · 1 | `Promise.all([toList(), count()])` · 2 |

### Offset pages: `limit()` and `offset()`

```ts
const pageSize = 2;
const page = 1;   // zero-based
const second = await db.users
  .orderBy(u => u.username)
  .select(u => ({ id: u.id, username: u.username }))
  .offset(page * pageSize)
  .limit(pageSize)
  .toList();      // [{ id: 3, username: 'charlie' }]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
ORDER BY "username" ASC
LIMIT 2 OFFSET 2
```

> **Pitfall:** `limit()` and `offset()` are inlined as literals without validation: `limit('1 OFFSET 2' as any)`
> rendered `LIMIT 1 OFFSET 2`. Coerce request input to an integer first. Every distinct value is also a
> distinct statement text (one cached plan each under `preparedStatements`).

### Deep pages: keyset pagination

Remember the last key of the previous page and filter past it; the cursor is a parameter and an index on the
key serves a range scan.

```ts
const lastSeenId = 1;
const next = await db.users
  .where(u => gt(u.id, lastSeenId))
  .orderBy(u => u.id)
  .select(u => ({ id: u.id, username: u.username }))
  .limit(2)
  .toList();
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" > $1
ORDER BY "id" ASC
LIMIT 2
-- params: [ 1 ]
```

### A page and the total in one round trip

`countOver()` returns `{ data, totalCount }` from one statement that adds `COUNT(*) OVER()` to every row.

```ts
const result = await db.users
  .orderBy(u => u.username)
  .select(u => ({ id: u.id, username: u.username }))
  .offset(0)
  .limit(2)
  .countOver();
// { data: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }], totalCount: 3 }
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", COUNT(*) OVER() as "__countOver"
FROM "users"
ORDER BY "username" ASC
LIMIT 2 OFFSET 0
```

> **Pitfall:** `totalCount` is read from the first returned row, so a page past the end reports
> `{ data: [], totalCount: 0 }` although rows match (verified with `offset(10)`). PostgreSQL still visits
> every matching row to count it, as `count()` does. `countOver()` is refused for set-returning projections
> and does not exist on a view table itself (call it after `where()` or `select()`).

When a requested page may be empty (deep links, deleted rows), read the page and the count in one
[`QueryBatch`](#read-several-independent-results-in-one-round-trip-querybatch): the count leg ignores the page's ORDER BY,
LIMIT and OFFSET, so the same builder serves both legs. (Not for a union: its count counts its own LIMIT / OFFSET,
so register the union without them for the count.)

```ts
import { QueryBatch } from 'linkgress-orm';

async function getPaginatedUsers(page: number, pageSize: number) {
  const pageQuery = db.users
    .select(u => ({ id: u.id, username: u.username }))
    .orderBy(u => u.username)
    .offset(page * pageSize)
    .limit(pageSize);

  const batch = new QueryBatch();
  const rowsKey = batch.addList(pageQuery, 'users');
  const totalKey = batch.addCount(pageQuery, 'total');
  await batch.executeBatch();

  const total = batch.getCount(totalKey);
  return { users: batch.getList(rowsKey), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

await getPaginatedUsers(0, 2);
// { users: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }], total: 3, page: 0, pageSize: 2, totalPages: 2 }
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
ORDER BY "username" ASC
LIMIT 2 OFFSET 0
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count
FROM "users"
) __batch_q
```

`getPaginatedUsers(5, 2)` (`LIMIT 2 OFFSET 10`, past the end) returned
`{ users: [], total: 3, page: 5, pageSize: 2, totalPages: 2 }`.

<a id="distinct"></a>

## Return unique rows: `selectDistinct()`

`selectDistinct()` renders `SELECT DISTINCT` over the projection. It exists on the table and on a select
builder; filter after it with `where()`.

```ts
const statuses = await db.orders.selectDistinct(o => ({ status: o.status })).orderBy(r => r.status).toList();
// [{ status: 'pending' }, { status: 'completed' }]: an enum sorts in its declaration order

const authorIds = await db.posts.selectDistinct(p => ({ userId: p.userId })).where(r => gt(r.userId, 1)).toList();
```

```sql
SELECT DISTINCT "orders"."status" as "status"
FROM "orders"
ORDER BY "status" ASC

SELECT DISTINCT "posts"."user_id" as "userId"
FROM "posts"
WHERE "posts"."user_id" > $1
-- params: [ 1 ]
```

> **Efficiency:** DISTINCT sorts or hashes the projected rows: project only the columns that define
> uniqueness. To count distinct values use `agg.countDistinct()`; `count()` ignores DISTINCT.

> **Pitfall:** ORDER BY a column that is not projected fails in PostgreSQL (`for SELECT DISTINCT, ORDER BY
> expressions must appear in select list`). `db.posts.where(…).selectDistinct(…)` does not compile: call
> `selectDistinct()` first.

<a id="conditional-queries"></a><a id="search-with-filters"></a><a id="advanced-patterns"></a>

## Build a query from optional filters

Reassign the query per present filter, typed `IEntityQueryable<T>` so a table and a filtered query fit the
same variable, then project at the end:

```ts
import type { IEntityQueryable } from 'linkgress-orm';
import type { User } from './model/user';   // the entity class behind db.users

const filters: { minAge?: number; active?: boolean; name?: string } = { minAge: 30, active: true };

let q: IEntityQueryable<User> = db.users;
if (filters.minAge !== undefined) q = q.where(u => gte(u.age, filters.minAge));
if (filters.active !== undefined) q = q.where(u => eq(u.isActive, filters.active));
if (filters.name) q = q.where(u => like(u.username, containsSearch(filters.name!)));

const matching = await q.select(u => ({ id: u.id, username: u.username })).toList();   // [{ id: 2, username: 'bob' }]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE ("users"."age" >= $1 AND "users"."is_active" = $2)
-- params: [ 30, true ]
```

Or collect the present conditions and AND them once:

```ts
import type { Condition } from 'linkgress-orm';

const search = { minAge: 30 as number | undefined, active: true as boolean | undefined };
const names = await db.users
  .where(u => {
    const conditions: Condition[] = [];
    if (search.minAge !== undefined) conditions.push(gte(u.age, search.minAge));
    if (search.active !== undefined) conditions.push(eq(u.isActive, search.active));
    return and(...conditions);
  })
  .select(u => u.username)
  .toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE ("users"."age" >= $1 AND "users"."is_active" = $2)
-- params: [ 30, true ]
```

Builders are mutable. `where()`, `orderBy()`, `limit()`, `offset()` and `first*()` change the builder they are
called on and return it (on a table, `where()` starts a new query); `select()` returns a new builder. To branch
two queries from one base, build the base in a function:

```ts
const base = db.users.where(u => eq(u.isActive, true));
const older = base.where(u => gt(u.age, 30));
// base === older: base now also filters age > 30

const activeUsersQuery = () => db.users.where(u => eq(u.isActive, true));
const olderActive = await activeUsersQuery().where(u => gt(u.age, 30)).count();   // 1
const allActive = await activeUsersQuery().count();                               // 2
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE ("users"."is_active" = $1 AND "users"."age" > $2)
-- params: [ true, 30 ]

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
```

A search with optional filters and a chosen sort order, written this way:

```ts
import type { Post } from './model/post';   // the entity class behind db.posts

async function searchPosts(filters: { search?: string; userId?: number; minViews?: number; sortBy?: 'recent' | 'popular' }) {
  let query: IEntityQueryable<Post> = db.posts;

  if (filters.search) query = query.where(p => ilike(p.title, containsSearch(filters.search!)));
  if (filters.userId !== undefined) query = query.where(p => eq(p.userId, filters.userId!));
  if (filters.minViews !== undefined) query = query.where(p => gte(p.views, filters.minViews!));

  if (filters.sortBy === 'recent') query = query.orderBy(p => [[p.publishedAt, 'DESC'], [p.id, 'DESC']]);
  else if (filters.sortBy === 'popular') query = query.orderBy(p => [[p.views, 'DESC'], [p.id, 'DESC']]);

  return query
    .select(p => ({ id: p.id, title: p.title, views: p.views, publishedAt: p.publishedAt }))
    .toList();
}

await searchPosts({ search: 'alice', minViews: 120, sortBy: 'popular' });
```

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title", "posts"."views" as "views", "posts"."published_at" as "publishedAt"
FROM "posts"
WHERE ("posts"."title" ILIKE $1 AND "posts"."views" >= $2)
ORDER BY "views" DESC, "id" DESC
-- params: [ "%alice%", 120 ]
```

> **Efficiency:** every combination of present filters is its own statement text.

> **Pitfall:** skip unset filter values instead of passing them: `eq(col, undefined)` renders `IS NULL`. After
> `select()`, `where()` sees only the projected fields, so apply filters on columns you do not project before
> `select()`.

## Read a related row's columns: navigations

A navigation is a modeled `hasOne` reference (`p.user`, `t.level`). Reading its columns in `select()`,
`where()` or `orderBy()` joins it: one join per hop, on the target's principal key, in the same statement.

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| A column of a modeled reference | `p.user!.username` | `INNER JOIN` (required) / `LEFT JOIN` (optional) per hop · 1 | `innerJoin()` repeating the foreign key |
| The whole related row | `p.user` in `select()` | one column per target column · 1 | when two columns are used |
| Filter or order by the related row | `where(p => eq(p.user!.username, …))` | the join, for WHERE / ORDER BY | a separate lookup |
| Few rows into a huge target with stale foreign-key statistics | `lateralJoin(p => p.user)` (since 1.0.23) | `INNER JOIN LATERAL (… OFFSET 0) … ON true` · 1 | the WHERE filters by that navigation |
| An unmodeled relation | [`innerJoin()` / `leftJoin()`](#join-tables-without-a-navigation-innerjoin-leftjoin) | `JOIN "users" AS "users_0" ON …` | — |

### Required and optional navigations

A navigation declared with `.isRequired()` renders `INNER JOIN`; any other renders `LEFT JOIN`. A navigation
the query never reads adds no join.

```ts
const posts = await db.posts
  .select(p => ({ title: p.title, author: p.user!.username }))   // posts.user is required
  .toList();

const tasks = await db.tasks
  .orderBy(t => t.id)
  .select(t => ({
    title: t.title,
    level: t.level!.name,               // tasks.level is optional: absent when there is no level
    nested: { level: t.level!.name },   // null inside a nested object
    levelRow: t.level,                  // an object of nulls
  }))
  .toList();
```

```sql
SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"

SELECT "tasks"."title" as "title", "level"."name" as "level", "level"."name" as "__nested__nested__level",
  "level"."id" as "__nested__levelRow__id", "level"."name" as "__nested__levelRow__name",
  "level"."created_by_id" as "__nested__levelRow__createdById"
FROM "tasks"
LEFT JOIN "task_levels" AS "level" ON "tasks"."level_id" = "level"."id"
ORDER BY "tasks"."id" ASC
```

For a task inserted without a level (the seed has none), the row read `{ title: 'Unassigned Task', level:
undefined, nested: { level: null }, levelRow: { id: null, name: null, createdById: null } }`: the top-level
`level` reads `undefined`, although the types say `string`.

> **Efficiency:** one plain join per hop on the target's primary key; statement text is stable. Bench
> (`bench/versions`, 1.0.17, PostgreSQL, PgClient): 1,000 rows reading two columns of a 1-hop navigation
> 1.15 ms; 500 rows with the navigation row projected whole 1.86 ms.

### Paths of several hops

Each hop joins on the alias of the hop before it, LEFT or INNER by its own declaration; intermediate hops are
joined even when none of their columns is selected:

```ts
const creators = await db.orderTasks
  .select(ot => ({ orderId: ot.orderId, createdBy: ot.task!.level!.createdBy!.username }))
  .toList();
```

```sql
SELECT "order_task"."order_id" as "orderId", "createdBy"."username" as "createdBy"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
LEFT JOIN "users" AS "createdBy" ON "level"."created_by_id" = "createdBy"."id"
```

> **Pitfall:** a required hop after an optional one renders `INNER JOIN`, which drops every row whose
> optional hop is missing (below, `postComments.post` is optional and `posts.user` required).

### Navigation joins and their aliases

A hop renders under its relation name (`"task"`, `"level"`), which is also the alias a raw `sql` fragment
would see. When two navigation paths in one query end in the same relation name — `pc.post!.user` and
`pc.order!.user` — each still gets its own join: the shallowest path keeps the plain name (on a tie, the one
that appears first, projection before `where`), and every other path renders as `<parentAlias>__<relation>`:

```ts
const comments = await db.postComments
  .orderBy(pc => pc.id)
  .select(pc => ({
    comment: pc.comment,
    postAuthor: pc.post!.user!.username,    // "user"
    orderOwner: pc.order!.user!.username,   // "order__user"
  }))
  .toList();
```

```sql
SELECT "post_comments"."comment" as "comment", "user"."username" as "postAuthor", "order__user"."username" as "orderOwner"
FROM "post_comments"
LEFT JOIN "posts" AS "post" ON "post_comments"."post_id" = "post"."id"
LEFT JOIN "orders" AS "order" ON "post_comments"."order_id" = "order"."id"
INNER JOIN "users" AS "user" ON "post"."user_id" = "user"."id"
INNER JOIN "users" AS "order__user" ON "order"."user_id" = "order__user"."id"
ORDER BY "post_comments"."id" ASC
```

The alias depends on the other paths of the query: alone, `pc.order!.user` renders as `"user"`. Interpolate
the column (`` sql`upper(${pc.order!.user!.username})` ``) instead of writing an alias into raw SQL:

```ts
const owners = await db.postComments
  .orderBy(pc => pc.id)
  .select(pc => ({ owner: sql<string>`upper(${pc.order!.user!.username})` }))
  .toList();
```

```sql
SELECT upper("user"."username") as "owner"
FROM "post_comments"
LEFT JOIN "orders" AS "order" ON "post_comments"."order_id" = "order"."id"
INNER JOIN "users" AS "user" ON "order"."user_id" = "user"."id"
ORDER BY "post_comments"."id" ASC
```

Inside a collection the same rule applies within the collection's own subquery, under every collection
strategy. A name the collection reads from an enclosing row (the hops of the path it hangs off, or a
navigation the enclosing row's own columns are read through) is never reused for one of the collection's own
navigations: that navigation renders under a path alias instead. An alias over 63 bytes is refused.

### Filter and order by a related row

```ts
const alicePosts = await db.posts
  .where(p => eq(p.user!.username, 'alice'))
  .select(p => p.title)
  .toList();
```

```sql
SELECT "posts"."title"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE "user"."username" = $1
-- params: [ "alice" ]
```

> **Pitfall:** a comparison on an optional (LEFT-joined) navigation drops the rows without the related row,
> because NULL matches nothing. Keep them with `isNull()` on the foreign key:

```ts
import { isNull } from 'linkgress-orm';

const highOrUnassigned = await db.tasks
  .where(t => or(eq(t.level!.name, 'High Priority'), isNull(t.levelId)))
  .select(t => t.title)
  .toList();          // ['Important Task', 'Unassigned Task']
```

```sql
SELECT "tasks"."title"
FROM "tasks"
LEFT JOIN "task_levels" AS "level" ON "tasks"."level_id" = "level"."id"
WHERE ("level"."name" = $1 OR "tasks"."level_id" IS NULL)
-- params: [ "High Priority" ]
```

`lateralJoin(nav)` (since 1.0.23; paths since 1.0.25) renders one navigation as a per-row key probe instead
of a plain join, for few rows over a large target whose statistics mislead the planner — see
[Lateral navigation joins](./lateral-navigation-joins.md).

<a id="nested-collections"></a><a id="loading-related-data"></a>

## Load each row's children in the same statement: collections

A collection is a modeled `hasMany` list (`u.posts`, `o.orderTasks`). Used inside `select()`, it loads each
parent row's children in the same statement — never one query per parent.

| Need | Use | SQL shape (default `lateral`) · round trips | Avoid |
|---|---|---|---|
| Children as objects | `u.posts!.select(p => ({ … })).toList()` | `LEFT JOIN LATERAL (SELECT json_agg(json_build_object(…)) …)` · 1 | a query per parent (N+1); `toList()` without `select()` (every column as JSON) |
| One value per child | `u.posts!.select(p => p.id).toNumberList()` / `toStringList()` | `(SELECT COALESCE(array_agg(…), '{}') …)` · 1 | objects when ids are enough |
| The first N children | `u.posts!.orderBy(…).limit(n).select(…).toList()` | `ORDER BY … LIMIT n` per parent · 1 | loading every child and slicing in JS |
| One child per parent | `u.posts!.orderBy(…).select(…).firstOrDefault()` | `json_build_object … LIMIT 1` · 1 | an unordered pick |
| A number or flag per parent | `count()`, `sum()`, `min()`, `max()`, `exists()` | `(SELECT COALESCE(COUNT(*), 0) …)` · 1 | loading lists to count them |
| Parents that have / lack children | `where(u => exists(u.posts!.where(…)))`, `notExists(u.posts!)` | `WHERE EXISTS (SELECT 1 …)` · 1 | a join to the children (duplicates parents) |
| Grandchildren through an intermediate collection | `p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!)` | `INNER JOIN` per hop · 1 | nested lists flattened in JS |

```ts
const usersWithPosts = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// { id: number; username: string; posts: { title: string; views: number }[] }[]
// charlie: posts []
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
) sub) "lateral_0" ON true
ORDER BY "id" ASC
```

A parent without children gets `[]` (a list), `0` (a count), `false` (`exists()`) or `null` (`sum()`, `min()`,
`max()`, `firstOrDefault()`). The optional name argument of `toList()`, `toNumberList()`, `toStringList()` and
`firstOrDefault()` does not change the result key; the projection key does.

<a id="filtering-collections"></a><a id="ordering-collections"></a>

### Filter, order and limit each parent's children

`where()`, `orderBy()`, `limit()` and `offset()` of a collection apply per parent row:

```ts
const topPosts = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    topPosts: u.posts!
      .where(p => gt(p.views, 100))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(1)
      .select(p => ({ title: p.title, views: p.views }))
      .toList(),
  }))
  .toList();
// alice: [{ title: 'Alice Post 2', views: 150 }], bob: [{ title: 'Bob Post', views: 200 }], charlie: []
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "topPosts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id" AND "lateral_0_posts"."views" > $1
  ORDER BY "lateral_0_posts"."views" DESC
  LIMIT 1
) sub) "lateral_0" ON true
ORDER BY "users"."id" ASC
-- params: [ 100 ]
```

The keys are columns of the item — projected or not, under the same name or another — or of its navigations
(`p.user!.username`), or SQL expressions over them (``sql`lower(${p.title})` ``, a condition, a nested
collection's `count()`). Written after `select()`, `orderBy()` reads the projection: a field reads as the value
it projects, so `select(p => ({ heading: p.title })).orderBy(p => p.heading)` orders by `title`, a projected
expression by that expression, and a name the projection does not select still reads the item's column.
`where()` reads the item even after `select()`.

```ts
const renamed = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    posts: u.posts!.select(p => ({ heading: p.title })).orderBy(p => [[p.heading, 'DESC']]).toList(),
  }))
  .toList();
// [{ posts: [{ heading: 'Alice Post 2' }, { heading: 'Alice Post 1' }] }]
```

```sql
SELECT COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('heading', "heading")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "heading"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
  ORDER BY "lateral_0_posts"."title" DESC
) sub) "lateral_0" ON true
WHERE "users"."username" = $1
-- params: [ "alice" ]
```

- A second `orderBy()` on a collection APPENDS its keys after the first one's (verified:
  `orderBy(p => p.userId).orderBy(p => [[p.views, 'DESC']])` ordered by `user_id` ASC, then `views` DESC); on
  a root query it replaces them.
- A count, sum, min / max or flat list of a limited collection aggregates the rows the ordered, limited
  collection yields. Every collection strategy returns the same order.
- A `selectDistinct()` collection can only be ordered by values it selects; ordering it by anything else is
  refused naming the key, or, for a LATERAL list of objects, refused by PostgreSQL.
- Without `orderBy()` the item order is unspecified.

### Value lists and one child per parent

```ts
const lists = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    postIds: u.posts!.orderBy(p => [[p.id, 'DESC']]).select(p => p.id).toNumberList(),   // number[]
    titles: u.posts!.select(p => p.title).toStringList(),                                 // string[]
    topPost: u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ title: p.title })).firstOrDefault(),
  }))
  .toList();
// alice: { postIds: [2, 1], titles: ['Alice Post 1', 'Alice Post 2'], topPost: { title: 'Alice Post 2' } }
// charlie: { postIds: [], titles: [], topPost: null }
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(array_agg("lateral_0_posts"."id" ORDER BY "lateral_0_posts"."id" DESC), '{}')
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postIds", (SELECT COALESCE(array_agg("lateral_1_posts"."title"), '{}')
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "titles", "lateral_2".data as "topPost"
FROM "users"
LEFT JOIN LATERAL (SELECT json_build_object('title', "title") as data
FROM (
  SELECT "lateral_2_posts"."title" as "title"
  FROM "posts" "lateral_2_posts"
  WHERE "lateral_2_posts"."user_id" = "users"."id"
  ORDER BY "lateral_2_posts"."views" DESC
  LIMIT 1
) sub) "lateral_2" ON true
ORDER BY "users"."id" ASC
```

> **Efficiency:** `toNumberList()` / `toStringList()` travel as native arrays, the smallest list payload.
> BunClient in its default (prepared) mode and the `temptable` strategy's multi-statement path aggregate with
> `json_agg` instead of `array_agg`.

<a id="collection-aggregations"></a>

### Count, sum, min and max per parent

`count()`, `sum()`, `min()`, `max()` and `exists()` of a collection return one value per parent. There is no
`avg()`: compute an average from `sum()` and `count()`, with a correlated `agg.avg()` scalar subquery (see the
[dashboard example](#example-a-user-dashboard-in-one-statement)) or with `g.avg()` in a grouped subquery.

```ts
const stats = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),                                 // number (0 without children)
    totalViews: u.posts!.sum(p => p.views),                      // number | null
    maxViews: u.posts!.max(p => p.views),                        // number | null
    hasPopular: u.posts!.where(p => gt(p.views, 120)).exists(),  // boolean
  }))
  .toList();
// alice: { postCount: 2, totalViews: 250, maxViews: 150, hasPopular: true }
// charlie: { postCount: 0, totalViews: null, maxViews: null, hasPopular: false }
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(SUM("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "totalViews", (SELECT COALESCE(MAX("lateral_2_posts"."views"), null)
FROM "posts" "lateral_2_posts"
WHERE "lateral_2_posts"."user_id" = "users"."id") as "maxViews", (SELECT EXISTS(SELECT 1
FROM "posts" "lateral_3_posts"
WHERE "lateral_3_posts"."user_id" = "users"."id" AND "lateral_3_posts"."views" > $1)) as "hasPopular"
FROM "users"
ORDER BY "users"."id" ASC
-- params: [ 120 ]
```

`min()`, `max()` and `sum()` also aggregate an `sql` expression of the item — with its parameters, the
navigations it reads joined, the collection's `where()` / `orderBy()` / `limit()` applied, under every
strategy, nested in another collection and in a mutation's RETURNING:

```ts
const longest = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    longestTitle: u.posts!.max(p => sql<number>`length(${p.title})`),
    weighted: u.posts!.where(p => gt(p.views, 0)).sum(p => sql<number>`${p.views} * ${2}`),
  }))
  .toList();
// alice: { longestTitle: 12, weighted: 500 }
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(MAX(length("lateral_0_posts"."title")), null)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "longestTitle", (SELECT COALESCE(SUM("lateral_1_posts"."views" * $2), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id" AND "lateral_1_posts"."views" > $1) as "weighted"
FROM "users"
ORDER BY "users"."id" ASC
-- params: [ 0, 2 ]
```

> **Efficiency:** each aggregate is its own subquery (or CTE under `cte`): three aggregates read the children
> three times. For several aggregates of one child table over many parents, join one grouped subquery
> instead ([Join per-key aggregates computed once](#join-per-key-aggregates-computed-once)).

> **Pitfall:** `sum()` / `min()` / `max()` are typed `number | null` for every column: `max()` of a timestamp
> reads a `Date`, of a text column a string, of a column with a custom mapper the mapped value (since 1.0.31,
> [below](#compare-and-aggregate-the-items-mapped-columns)). After `select()` on a collection, `count()`,
> `exists()`, `min()`, `max()` and `sum()` are typed `Promise<…>` although they produce plain values: call them
> before `select()`.

### Compare and aggregate the items' mapped columns

A column of a collection's item with a custom mapper (`hasCustomMapper()`; in the example model `Post.publishTime`,
`{ hour, minute }` stored as minutes, and `Post.customDate`, a `Date` stored as seconds) goes through its mapper in
two places (since 1.0.31): a value compared directly with the bare column in the collection's `where()` is bound
through `toDriver`, and `min()` / `max()` of the bare column read back through `fromDriver`.

```ts
import { between, exists, gte } from 'linkgress-orm';

const schedule = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    afternoonPosts: u.posts!.where(p => gte(p.publishTime, { hour: 12, minute: 0 })).count(),   // binds 720
    firstSlot: u.posts!.min(p => p.publishTime),   // { hour: 9, minute: 30 }; typed number | null
    lastDate: u.posts!.max(p => p.customDate),     // a Date
  }))
  .toList();
// alice: { afternoonPosts: 1, firstSlot: { hour: 9, minute: 30 }, lastDate: new Date('2024-01-16T10:00:00.000Z') }
// charlie: { afternoonPosts: 0, firstSlot: null, lastDate: null }

const onTheSixteenth = await db.users
  .where(u => exists(u.posts!.where(p => between(p.customDate, new Date('2024-01-16T00:00:00Z'), new Date('2024-01-17T00:00:00Z')))))
  .select(u => u.username)
  .toList();   // ['alice']
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id" AND "lateral_0_posts"."publish_time" >= $1) as "afternoonPosts", (SELECT COALESCE(MIN("lateral_1_posts"."publish_time"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "firstSlot", (SELECT COALESCE(MAX("lateral_2_posts"."custom_date"), null)
FROM "posts" "lateral_2_posts"
WHERE "lateral_2_posts"."user_id" = "users"."id") as "lastDate"
FROM "users"
ORDER BY "users"."id" ASC
-- params: [ 720 ]

SELECT "users"."username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."custom_date" BETWEEN $1 AND $2)
-- params: [ -30326400, -30240000 ]
```

| Written over a mapped column of the item | Through the mapper | Example (alice's posts: 570 and 840 stored) |
|---|---|---|
| A value compared directly with the bare column in the collection's `where()`: `eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `like` …, `between`, `inArray` / `notInArray`, `eqAny` / `neAll` and the `…Opt` forms; in `exists()` / `notExists()`, a projected collection, a collection reached through navigations or nested in another, under every strategy | bound through `toDriver` | `gte(p.publishTime, { hour: 12, minute: 0 })` binds `720` |
| `min()` / `max()` of the bare column, also of one reached through the item's navigation (`max(p => p.user!.lastActiveAt)`) | read through `fromDriver`: in a root projection, in a collection's items, in a mutation's RETURNING, in a `QueryBatch` | `{ hour: 9, minute: 30 }`, a `Date` |
| A list of the bare column (`select(p => p.publishTime).toList()`) | read through `fromDriver`, as before 1.0.31 | `[{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }]` |
| An expression over the column (`coalesce`, `add` / `sub` / `mul` / `div`, `greatest` / `least` / `nullIf`, `caseOf`, `caseWhen`, an `sql` template), in the filter or in the projection; `min()` / `max()` of an expression | no: its plain operands bind as written, it reads the stored value | ``max(p => sql`${p.publishTime} + 60`)`` reads `900` |
| `sum()` / `count()` | no: numbers | `sum(p => p.publishTime)` reads `1410` |
| A `min()` / `max()` read as a column of a CTE or of a joined table subquery | no: the stored value | `570` ([CTE guide](./cte-guide.md#how-a-ctes-columns-read-back)) |

Captured: an expression, a sum and a filter over an expression read and bind the stored values; the list of the
bare column reads mapped.

```ts
import { eq, gt, sql } from 'linkgress-orm';

const alice = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    shifted: u.posts!.max(p => sql<number>`${p.publishTime} + 60`),                   // 900: the stored 840 + 60
    total: u.posts!.sum(p => p.publishTime),                                          // 1410: 570 + 840
    late: u.posts!.where(p => gt(sql<number>`${p.publishTime} + 60`, 700)).count(),   // 700 bound as written
    times: u.posts!.orderBy(p => p.id).select(p => p.publishTime).toList(),           // mapped, as before 1.0.31
  }))
  .firstOrDefault();
// { shifted: 900, total: 1410, late: 1, times: [{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }] }
```

```sql
SELECT (SELECT COALESCE(MAX("lateral_0_posts"."publish_time" + 60), null)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "shifted", (SELECT COALESCE(SUM("lateral_1_posts"."publish_time"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "total", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_2_posts"
WHERE "lateral_2_posts"."user_id" = "users"."id" AND "lateral_2_posts"."publish_time" + 60 > $1) as "late", COALESCE("lateral_3".data, '[]'::json) as "times"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('publish_time', "publish_time")
) as data
FROM (
  SELECT "lateral_3_posts"."publish_time" as "publish_time"
  FROM "posts" "lateral_3_posts"
  WHERE "lateral_3_posts"."user_id" = "users"."id"
  ORDER BY "lateral_3_posts"."id" ASC
) sub) "lateral_3" ON true
WHERE "users"."username" = $2
LIMIT 1
-- params: [ 700, "alice" ]
```

At the root an expression over a mapped column does inherit its mapper (see [`coalesce()`](#default-a-null-coalesce));
in a collection's item it does not, a difference older than 1.0.31 and kept by it. `disableMappers` turns both
conversions off, as it does every read.

> **Pitfall:** pass the application value, never the stored one. Since 1.0.31 `eq(p.publishTime, 570)` in a
> collection's `where()` (the stored minutes, which 1.0.30 bound as written) goes through `toDriver` and fails:
> `invalid input syntax for type smallint: "NaN"`. Before 1.0.31 the comparison above bound the object itself and
> failed (`invalid input syntax for type smallint: "{"hour":12,"minute":0}"`), and `min()` / `max()` read the
> stored value (`570`, `-30290400`): drop any mapping of the raw extreme done by hand.

> **Pitfall:** `min()` / `max()` stay typed `number | null` whatever the column holds; type the mapped value
> yourself (`firstSlot as unknown as { hour: number; minute: number } | null`).

### Sum a count over each item's related rows

`sum()` also sums a count of a collection of the item: reached directly (`u.posts!.sum(p => p.postComments!.count())`)
or through reference navigations of the item (since 1.0.31), with a filter of its own:

```ts
import { eq } from 'linkgress-orm';

const carts = await db.carts
  .orderBy(c => c.id)
  .select(c => ({
    uuid: c.uuid,
    // per applied code: the products its discount covers (code → discount, two reference hops)
    coveredProducts: c.cartDiscountCodes!.sum(cdc => cdc.discountCode!.discount!.discountProducts!.count()),
    // the summand's own filter
    hardbackCover: c.cartDiscountCodes!.sum(cdc => cdc.discountCode!.discount!.discountProducts!.where(dp => eq(dp.productId, 1)).count()),
  }))
  .toList();
// [{ uuid: 'cart-uuid-a', coveredProducts: 3, hardbackCover: 2 }, { uuid: 'cart-uuid-b', coveredProducts: 1, hardbackCover: 1 }]
```

```sql
SELECT "carts"."uuid" as "uuid", (SELECT COALESCE(SUM((SELECT COALESCE(COUNT(*), 0)
FROM "discount_products" "lateral_1_discountProducts"
WHERE "lateral_1_discountProducts"."discount_id" = "discount"."id")), null)
FROM "cart_discount_codes" "lateral_0_cartDiscountCodes"
LEFT JOIN "discount_codes" "discountCode" ON "lateral_0_cartDiscountCodes"."discount_code_id" = "discountCode"."id"
  LEFT JOIN "discounts" "discount" ON "discountCode"."discount_id" = "discount"."id"
WHERE "lateral_0_cartDiscountCodes"."cart_id" = "carts"."id") as "coveredProducts", (SELECT COALESCE(SUM((SELECT COALESCE(COUNT(*), 0)
FROM "discount_products" "lateral_3_discountProducts"
WHERE "lateral_3_discountProducts"."discount_id" = "discount"."id" AND "lateral_3_discountProducts"."product_id" = $1)), null)
FROM "cart_discount_codes" "lateral_2_cartDiscountCodes"
LEFT JOIN "discount_codes" "discountCode" ON "lateral_2_cartDiscountCodes"."discount_code_id" = "discountCode"."id"
  LEFT JOIN "discounts" "discount" ON "discountCode"."discount_id" = "discount"."id"
WHERE "lateral_2_cartDiscountCodes"."cart_id" = "carts"."id") as "hardbackCover"
FROM "carts"
ORDER BY "carts"."id" ASC
-- params: [ 1 ]
```

The count is a correlated subquery reading the hop it hangs off (`"discount"."id"`); the summed collection joins the
summand's hops inside its own subquery, under the `lateral`, `cte` and `temptable` strategies, at the top level and
nested in a list. A parent without items reads `null`, as any `sum()`.

> **Pitfall:** before 1.0.31 the hop was never joined: the statement above failed with `missing FROM-clause entry
> for table "discount"` (42P01, captured on 1.0.30). A summand directly on the item always worked.

### Filter or order parents by their children

`exists()` / `notExists()` of a collection, and its `count()`, work in `where()` and `orderBy()` and render
the same SQL under every collection strategy:

```ts
import { exists, notExists } from 'linkgress-orm';

const withPopular = await db.users.where(u => exists(u.posts!.where(p => gt(p.views, 120)))).select(u => u.username).toList();
const withoutPosts = await db.users.where(u => notExists(u.posts!)).select(u => u.username).toList();
const prolific = await db.users.where(u => gt(u.posts!.count(), 1)).select(u => u.username).toList();
// ['alice', 'bob'], ['charlie'], ['alice']
```

```sql
SELECT "users"."username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."views" > $1)
-- params: [ 120 ]

SELECT "users"."username"
FROM "users"
WHERE (NOT EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id"))

SELECT "users"."username"
FROM "users"
WHERE (SELECT COUNT(*) FROM "posts" "posts__count"
WHERE "posts__count"."user_id" = "users"."id") > $1
-- params: [ 1 ]
```

> **Efficiency:** EXISTS stops at the first match — prefer it to `gt(count(), 0)`. Both are correlated per
> parent row: index the foreign key.

> **Pitfall:** only `count()` and `exists()` work in `where()`, `orderBy()` and `sql` fragments; `max()` /
> `min()` / `sum()` there throw. Express "max(views) > v" as `exists(u.posts!.where(p => gt(p.views, v)))`.
> `exists()` takes a collection or an `asSubquery()`, never a table query (see
> [subqueries](#filter-or-compute-with-a-subquery)).

### Collections reached through navigations

A collection may hang off any chain of reference navigations — including one leading back to the table the
query reads, and a relation of a table to itself:

```ts
const comments = await db.postComments
  .orderBy(pc => pc.id)
  .select(pc => ({
    comment: pc.comment,
    authorPostCount: pc.post!.user!.posts!.count(),                           // the post author's posts
    orderTasks: pc.order!.orderTasks!.select(ot => ot.taskId).toNumberList(), // the order's tasks
  }))
  .toList();
```

```sql
SELECT "post_comments"."comment" as "comment", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "user"."id") as "authorPostCount", (SELECT COALESCE(array_agg("lateral_1_orderTasks"."task_id"), '{}')
FROM "order_task" "lateral_1_orderTasks"
WHERE "lateral_1_orderTasks"."order_id" = "order"."id") as "orderTasks"
FROM "post_comments"
LEFT JOIN "posts" AS "post" ON "post_comments"."post_id" = "post"."id"
INNER JOIN "users" AS "user" ON "post"."user_id" = "user"."id"
LEFT JOIN "orders" AS "order" ON "post_comments"."order_id" = "order"."id"
ORDER BY "post_comments"."id" ASC
```

A row whose navigation is missing gets the empty value (`[]`, `0`, `null`) — except under the `temptable`
strategy when every returned row lacks it (`relation "empty_agg_0" does not exist`). A relation keyed on a
principal key other than `id` joins on that key, and a table in another schema is read schema-qualified.

### Comparing items with the enclosing row

A collection's `where()`, projection and ORDER BY may read the row it hangs off — the root row, or the item
of an enclosing collection:

```ts
import { ne } from 'linkgress-orm';

const others = await db.posts
  .orderBy(p => p.id)
  .select(p => ({
    title: p.title,
    otherPostsByAuthor: p.user!.posts!.where(x => ne(x.id, p.id)).select(x => x.title).toList(),
  }))
  .toList();
// Alice Post 1: ['Alice Post 2'], Bob Post: []
```

```sql
SELECT "posts"."title" as "title", COALESCE("lateral_0".data, '[]'::json) as "otherPostsByAuthor"
FROM "posts"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title"
  FROM "posts" "lateral_0_posts"
  INNER JOIN "users" "user" ON "posts"."user_id" = "user"."id"
  WHERE "lateral_0_posts"."user_id" = "user"."id" AND "lateral_0_posts"."id" != "posts"."id"
) sub) "lateral_0" ON true
ORDER BY "posts"."id" ASC
```

Such a collection cannot be aggregated apart from that row, so under the `cte` and `temptable` strategies it
renders as a LATERAL subquery, with the same results (as does a collection that projects a window value).

### Many-to-many and grandchildren: `selectMany()`

A many-to-many relation goes through its join entity: project the join row's navigation.

```ts
const products = await db.products
  .orderBy(p => p.id)
  .select(p => ({
    name: p.name,
    tags: p.productTags!.orderBy(pt => pt.sortOrder).select(pt => pt.tag!.name).toList(),   // string[]
  }))
  .toList();
// Hardback: ['Winter', 'Family'], Lift Ticket: ['Summer']
```

```sql
SELECT "products"."name" as "name", COALESCE("lateral_0".data, '[]'::json) as "tags"
FROM "products"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('name', "name")
) as data
FROM (
  SELECT "tag"."name" as "name"
  FROM "product_tags" "lateral_0_productTags"
  LEFT JOIN "tags" "tag" ON "lateral_0_productTags"."tag_id" = "tag"."id"
  WHERE "lateral_0_productTags"."product_id" = "products"."id"
  ORDER BY "lateral_0_productTags"."sort_order" ASC
) sub) "lateral_0" ON true
ORDER BY "products"."id" ASC
```

`selectMany()` flattens grandchildren through an intermediate collection (LINQ `SelectMany`), then takes
`count()`, `select(…).toList()` and the other collection terminals; each level keeps its own `where()`,
`orderBy()` and `limit()`:

```ts
const groups = await db.products
  .orderBy(p => p.id)
  .select(p => ({
    name: p.name,
    capacityGroups: p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!).count(),
  }))
  .toList();
// Hardback: 3, Lift Ticket: 1
```

```sql
SELECT "products"."name" as "name", (SELECT COALESCE(COUNT(*), 0)
FROM "product_price_capacity_groups" "lateral_0_productPrices"
INNER JOIN "product_prices" "productPrices__bridge1" ON "lateral_0_productPrices"."product_price_id" = "productPrices__bridge1"."id"
WHERE "productPrices__bridge1"."product_id" = "products"."id") as "capacityGroups"
FROM "products"
ORDER BY "products"."id" ASC
```

Each hop renders as `<relation>__bridge<n>`. Refused: `selectDistinct()` or a terminal before `selectMany()`,
a selector returning something other than the item's own collection, `lateralJoin()` on either side, a limit
on a table without a primary key, and a negative or non-integer limit.

### How collection values read back

Items travel as JSON. A mapped column reads through its mapper and an `sql` expression through its
`mapWith()`, as at the top level, but an unmapped timestamp or date arrives as its text and a numeric column as
a JS number:

```ts
const typed = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ orders: u.orders!.select(o => ({ total: o.totalAmount, createdAt: o.createdAt })).toList() }))
  .firstOrDefault();
// typed.orders[0].total: 99.99 (a number; at the top level '99.99')
// typed.orders[0].createdAt: '2026-10-04T15:24:33.546' (a string without zone, typed Date)
```

```sql
SELECT COALESCE("lateral_0".data, '[]'::json) as "orders"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('total', "total", 'createdAt', "createdAt")
) as data
FROM (
  SELECT "lateral_0_orders"."total_amount" as "total", "lateral_0_orders"."created_at" as "createdAt"
  FROM "orders" "lateral_0_orders"
  WHERE "lateral_0_orders"."user_id" = "users"."id"
) sub) "lateral_0" ON true
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]
```

> **Pitfall:** convert unmapped timestamp values of collection items with `new Date(…)` where you read them.
> A collection terminal without `select()` (`u.orders!.toList()`) serializes every column of the item into
> the JSON — project the fields you use.

### Choose a collection strategy

The context option `collectionStrategy` (default `'lateral'`) decides how collections render;
`db.<table>.withQueryOptions({ collectionStrategy })` overrides it for one query (at the start of the chain).

| Strategy | SQL shape | Round trips | Use when | Measured (`bench/versions`, 1.0.17, PostgreSQL, PgClient) |
|---|---|---|---|---|
| `lateral` (default) | a correlated subquery or `LEFT JOIN LATERAL` per collection | 1 | the root returns a fraction of the parents (pages, lookups); top-N per parent; collections of joined tables | 100 of 2,000 users, 4 collection reads: 1.32 ms (`cte` 6.51 ms) |
| `cte` | one `GROUP BY` CTE per collection over the whole child table, LEFT JOINed on the parent key | 1 | the root returns most parents; nested multi-level trees | 100 products, 2 nested levels: 2.70 ms (`lateral` 5.43 ms) |
| `temptable` | the base query, then a temp table of parent ids per collection | PgClient: 1 + 5 per collection; postgres.js / Bun / PGlite: 1 + 1 per collection (1 in all when the base query binds no parameter and every collection is a plain list of its own columns) | only after measuring both others | 100 users' post lists: 11.7 ms (`lateral` 1.22 ms, `cte` 1.19 ms) |

```ts
const viaCte = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .select(u => ({ username: u.username, postCount: u.posts!.count() }))
  .toList();
```

```sql
WITH "cte_0" AS (SELECT
  "user_id" as parent_id,
  COUNT(*) as data
FROM "posts"
GROUP BY "user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, 0) as "postCount"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
```

Under `temptable` on PgClient, a query with a post count and a post list takes 11 statements:

```ts
const tempDb = new AppDatabase(client, { collectionStrategy: 'temptable' });
const withTemp = await tempDb.users
  .where(u => gt(u.age, 20))
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),
    posts: u.posts!.select(p => ({ title: p.title })).toList(),
  }))
  .toList();
```

The first six (the base query and the count's cycle; statements 7 to 11 repeat the cycle for the list):

```sql
SELECT "users"."id" as "__pk_id", "users"."username" as "username"
FROM "users"
WHERE "users"."age" > $1
-- params: [ 20 ]

CREATE TEMP TABLE IF NOT EXISTS tmp_parent_ids_0 (
  id integer PRIMARY KEY
)

INSERT INTO tmp_parent_ids_0 VALUES ($1),($2),($3)
-- params: [ 1, 2, 3 ]

CREATE TEMP TABLE tmp_parent_ids_0_agg AS
SELECT
  "user_id" as parent_id,
  COUNT(*) as data
FROM "posts"
WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)
GROUP BY "user_id"

SELECT parent_id, data FROM tmp_parent_ids_0_agg

DROP TABLE IF EXISTS tmp_parent_ids_0, tmp_parent_ids_0_agg
```

> **Efficiency:** `lateral` costs about one foreign-key index probe per parent row the root returns; `cte`
> aggregates every row of each child table whatever the root's WHERE and LIMIT. Neither creates an index:
> declare one on every foreign key a collection reads (`entity.hasIndex('ix_post_comments_post_id', e => [e.postId])`).

> **Pitfall:** a collection of a manually joined table requires `lateral` (`cte` and `temptable` throw). The
> `temptable` strategy races on a PgClient pool outside a transaction and fails when every returned parent key
> is NULL. Details per strategy: [Collection strategies](../collection-strategies.md).

<a id="joins"></a><a id="inner-join"></a><a id="left-join"></a><a id="multiple-joins"></a>

## Join tables without a navigation: `innerJoin()`, `leftJoin()`

`innerJoin(table, on, selector)` and `leftJoin(table, on, selector)` join any table on any condition — an
unmodeled relation, a computed key, the same table twice — and project from both sides. The selector is
required; there is no `join()`. For a modeled `hasOne`, read the [navigation](#read-a-related-rows-columns-navigations)
instead: it renders the same join.

| Need | Use | SQL shape | Avoid |
|---|---|---|---|
| Columns of an unmodeled relation | `innerJoin()` / `leftJoin()` | `INNER JOIN "users" AS "users_0" ON …` | a 1:N join when one row per parent is wanted (multiplies rows) |
| Filter by another table, keep the shape | `joinFilter()`; anti-join: `leftJoinFilter()` + `isNull()` | `INNER JOIN … WHERE …` | a 1:N right side (duplicates) → `exists()` |
| Per-key aggregates for many parents | `leftJoin(grouped.asSubquery('table'), on, select, alias)` | `LEFT JOIN (SELECT … GROUP BY …) AS "stats"` | one correlated subquery per aggregate |
| A derived set read in several places | a [CTE](#name-a-derived-set-once-ctes): `innerJoin(userStats.cte, on, select)` | `WITH "user_stats" AS (…) … INNER JOIN "user_stats"` | the same subquery written twice |

```ts
const postsWithAuthors = await db.posts
  .innerJoin(
    db.users,
    (post, user) => eq(post.userId, user.id),
    (post, user) => ({ title: post.title, author: user.username }),
  )
  .toList();

const usersWithTitles = await db.users
  .leftJoin(
    db.posts,
    (user, post) => eq(user.id, post.userId),
    (user, post) => ({ username: user.username, title: post.title }),
  )
  .orderBy(r => r.username)
  .toList();
// …, { username: 'charlie', title: undefined }: no matching post
```

```sql
SELECT "posts"."title" as "title", "users_0"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "users_0" ON "posts"."user_id" = "users_0"."id"

SELECT "users"."username" as "username", "posts_0"."title" as "title"
FROM "users"
LEFT JOIN "posts" AS "posts_0" ON "users"."id" = "posts_0"."user_id"
ORDER BY "username" ASC
```

> **Pitfall:** an unmatched `leftJoin()` column reads as `undefined`, not `null`, although the type says
> `string`. A 1:N join multiplies the left rows, and `count()` counts the multiplied rows (users
> left-joined to posts: 4).

### Chain joins

After a join, the next join's callbacks receive the previous projection and the new table: keep in the first
projection every field a later join or filter needs.

```ts
const commentAuthors = await db.postComments
  .innerJoin(db.posts, (c, p) => eq(c.postId, p.id), (c, p) => ({ comment: c.comment, userId: p.userId }))
  .innerJoin(db.users, (r, u) => eq(r.userId, u.id), (r, u) => ({ comment: r.comment, author: u.username }))
  .where(r => eq(r.author, 'alice'))
  .toList();
```

```sql
SELECT "post_comments"."comment" as "comment", "users_1"."username" as "author"
FROM "post_comments"
INNER JOIN "posts" AS "posts_0" ON "post_comments"."post_id" = "posts_0"."id"
INNER JOIN "users" AS "users_1" ON "posts_0"."user_id" = "users_1"."id"
WHERE "users_1"."username" = $1
-- params: [ "alice" ]
```

A joined table renders as `<table>_<n>`; the optional fourth argument (an alias) is ignored for a table and
required for a subquery.

### How a joined table's columns read

A column of a manually joined table — also of the queried table itself, also joined twice, also inside a CTE
— reads as a column of ITS table, exactly as the same column read through a navigation: through its own mapper
(`hasCustomMapper()`), as its own SQL type (a text of digits stays text, a date or timestamp is what the
client's parser makes of one, through a `QueryBatch` too). A condition on it binds its value through that
mapper. A helper that types its SQL by a column's declared type (the `eqAny()` / `neAll()` array cast, the
`flag*` mask casts, `agg.arrayAgg()` / `unnest()` element types) renders for it as for a column of the queried
table.

```ts
const times = await db.users
  .innerJoin(db.posts, (u, p) => eq(u.id, p.userId), (u, p) => ({ username: u.username, publishTime: p.publishTime }))
  .where(r => gt(r.publishTime, { hour: 12, minute: 0 }))   // bound through the HourMinute mapper: 720
  .toList();
// [{ username: 'alice', publishTime: { hour: 14, minute: 0 } }, { username: 'bob', publishTime: { hour: 18, minute: 45 } }]
```

```sql
SELECT "users"."username" as "username", "posts_0"."publish_time" as "publishTime"
FROM "users"
INNER JOIN "posts" AS "posts_0" ON "users"."id" = "posts_0"."user_id"
WHERE "posts_0"."publish_time" > $1
-- params: [ 720 ]
```

A joined table's own navigations and collections are readable too. Its navigations always render
`LEFT JOIN … AS "<join alias>__<relation>"`, even a required one; its collections need the `lateral` strategy:

```ts
const viaJoin = await db.orders
  .innerJoin(db.posts, (o, p) => eq(o.userId, p.userId), (o, p) => ({ orderId: o.id, title: p.title, author: p.user!.username }))
  .orderBy(r => [r.orderId, r.title])
  .toList();
```

```sql
SELECT "orders"."id" as "orderId", "posts_0"."title" as "title", "posts_0__user"."username" as "author"
FROM "orders"
INNER JOIN "posts" AS "posts_0" ON "orders"."user_id" = "posts_0"."user_id"
LEFT JOIN "users" AS "posts_0__user" ON "posts_0"."user_id" = "posts_0__user"."id"
ORDER BY "orderId" ASC, "title" ASC
```

### Filter by a joined table: `joinFilter()`, `leftJoinFilter()`

`joinFilter(table, on, filter?)` is an INNER JOIN used purely as a row filter: the entity or projection shape
is kept and the optional third callback adds a WHERE predicate. `leftJoinFilter()` renders a LEFT JOIN; with
an `isNull()` filter on the right side's key it is an anti-join. Only the right table's columns are
addressable (no navigations).

```ts
const activeAuthorsPosts = await db.posts
  .joinFilter(db.users, (p, u) => eq(p.userId, u.id), (p, u) => eq(u.isActive, true))
  .select(p => p.title)
  .toList();

const usersWithoutPosts = await db.users
  .leftJoinFilter(db.posts, (u, p) => eq(u.id, p.userId), (u, p) => isNull(p.id))
  .select(u => u.username)
  .toList();          // ['charlie']
```

```sql
SELECT "posts"."title"
FROM "posts"
INNER JOIN "users" AS "users_0" ON "posts"."user_id" = "users_0"."id"
WHERE "users_0"."is_active" = $1
-- params: [ true ]

SELECT "users"."username"
FROM "users"
LEFT JOIN "posts" AS "posts_0" ON "users"."id" = "posts_0"."user_id"
WHERE "posts_0"."id" IS NULL
```

> **Pitfall:** a right side with several rows per left row duplicates the left rows; use `exists()` /
> `notExists()` for a semi- or anti-join there. For a modeled collection, `notExists(u.posts!)` renders the
> canonical NOT EXISTS.

### Join per-key aggregates computed once

When many parents need several aggregates of one child table, compute them in one grouped subquery and join
it once:

```ts
const perUser = db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, posts: g.count(), views: g.sum(r => r.views) }))
  .asSubquery('table');

const withStats = await db.users
  .leftJoin(perUser, (u, s) => eq(u.id, s.userId), (u, s) => ({ username: u.username, posts: s.posts, views: s.views }), 'stats')
  .orderBy(r => r.username)
  .toList();
// alice: { posts: 2, views: 250 }, bob: { posts: 1, views: 200 }, charlie: { posts: undefined, views: undefined }
```

```sql
SELECT "users"."username" as "username", "stats"."posts" as "posts", "stats"."views" as "views"
FROM "users"
LEFT JOIN (SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
GROUP BY "posts"."user_id") AS "stats" ON "users"."id" = "stats"."userId"
ORDER BY "username" ASC
```

> **Efficiency:** the derived table aggregates every child row once, then joins — one pass however many
> aggregates it holds. For few parents a collection aggregate (an index probe per parent) is cheaper. Wrap
> counts in `coalesce()` when a missing group must read `0`: `posts: coalesce(s.posts, 0)` read charlie's `0`.

<a id="aggregations"></a><a id="sum-min-max-average"></a>

## Aggregate the whole set in one statement: `agg`

A select of `agg.*` fragments without `groupBy()` is ONE row over the filtered set: any number of aggregates
in one scan, `FILTER (WHERE …)` for conditional ones.

| Need | Use | SQL · round trips | Reads as |
|---|---|---|---|
| Several aggregates of one set | `select(p => ({ n: agg.count(), total: agg.sum(p.views) })).firstOrDefault()` | one row · 1 | numbers (count, sum, avg via `Number()`); `min` / `max` through the column's mapper |
| One `SUM` / `MIN` / `MAX` where the raw driver value is fine | `select(p => ({ v: p.views })).sum(r => r.v)` | `SELECT SUM(…) as result` · 1 per call | the raw driver value: `SUM(integer)` is `'450'` |
| Aggregates per key | [`groupBy()`](#group-rows-groupby) | `GROUP BY` · 1 | |
| Aggregates per parent row | collection [`count()` / `sum()` / …](#count-sum-min-and-max-per-parent) | correlated subquery · 1 | |

```ts
import { agg } from 'linkgress-orm';

const postStats = await db.posts
  .where(p => gte(p.views, 0))
  .select(p => ({
    posts: agg.count(),
    authors: agg.countDistinct(p.userId),
    totalViews: agg.sum(p.views),
    avgViews: agg.avg(p.views),
    minViews: agg.min(p.views),
    maxViews: agg.max(p.views),
    popular: agg.count().filter(gt(p.views, 120)),
  }))
  .firstOrDefault();
// { posts: 3, authors: 2, totalViews: 450, avgViews: 150, minViews: 100, maxViews: 200, popular: 2 }
```

```sql
SELECT count(*) as "posts", count(DISTINCT "posts"."user_id") as "authors", sum("posts"."views") as "totalViews",
  avg("posts"."views") as "avgViews", min("posts"."views") as "minViews", max("posts"."views") as "maxViews",
  count(*) FILTER (WHERE "posts"."views" > $1) as "popular"
FROM "posts"
WHERE "posts"."views" >= $2
LIMIT 1
-- params: [ 120, 0 ]
```

The select builder's `sum()`, `min()` and `max()` run one statement each and return the raw driver value
whatever the declared type; a table has none of them, and no `avg()` exists anywhere but `agg.avg()` and
`g.avg()`:

```ts
const total = await db.posts.select(p => ({ views: p.views })).sum(r => r.views);          // '450' (a string)
const min = await db.posts.select(p => ({ views: p.views })).min(r => r.views);            // 100
const maxTitle = await db.posts.select(p => p.title).max();                                // 'Bob Post'
const revenue = await db.orders.select(o => ({ amount: o.totalAmount })).sum(r => r.amount);   // '249.98'
const revenueTyped = await db.orders.select(o => ({ revenue: agg.sum(o.totalAmount) })).firstOrDefault();
// { revenue: 249.98 } (a number)
```

```sql
SELECT SUM("posts"."views") as result
FROM "posts"

SELECT MIN("posts"."views") as result
FROM "posts"

SELECT MAX("posts"."title") as result
FROM "posts"

SELECT SUM("orders"."total_amount") as result
FROM "orders"

SELECT sum("orders"."total_amount") as "revenue"
FROM "orders"
LIMIT 1
```

- The select builder's `sum()` / `min()` / `max()` ignore `orderBy()`, `limit()`, `offset()` and DISTINCT
  (`.orderBy(…).limit(1).sum(…)` still summed all three posts: `'450'`) but honour `where()`. Their selector must
  return a column: an `sql` expression throws `Aggregation selector must return a field reference`. A mapped
  column's MAX comes back unmapped (`db.posts.select(p => ({ t: p.publishTime })).max(r => r.t)` read `1125`, still
  on 1.0.31), unlike a collection's `max()`, which reads through the mapper since 1.0.31.
- Project only aggregates and constants: a plain column next to them fails in PostgreSQL
  (`column "posts.user_id" must appear in the GROUP BY clause or be used in an aggregate function`). Group by
  it instead.
- The row comes back over zero rows too (count `0`, the others `null`), and `count()` of such a select is
  refused.
- `count` / `sum` / `avg` read through `Number()` (inexact past 2^53 or for long numerics);
  `.mapWith(String)` keeps the text. More `agg` functions (`arrayAgg`, `jsonAgg`, `bitOr`, ordered and
  distinct options): [SQL expression helpers](./sql-expressions.md#aggregate-inside-an-expression-agg).

<a id="group-by"></a>

## Group rows: `groupBy()`

Project the rows, group the projection by a key object, then select the key and aggregates. `groupBy()` exists
only after `select()`, and its callbacks see the projection: project every key and every aggregate argument
first. Row filters go in `where()` before `select()`; groups are filtered with `having()`.

```ts
const postsByUser = await db.posts
  .select(p => ({ userId: p.userId, views: p.views, title: p.title, author: p.user!.username }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    postCount: g.count(),             // number
    totalViews: g.sum(r => r.views),  // number
    avgViews: g.avg(r => r.views),    // number
    lastTitle: g.max(r => r.title),   // string
    author: g.max(r => r.author),     // string
  }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, postCount: 2, totalViews: 250, avgViews: 125, lastTitle: 'Alice Post 2', author: 'alice' }, …]
```

```sql
SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "postCount", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "totalViews",
  CAST(AVG("posts"."views") AS DOUBLE PRECISION) as "avgViews", MAX("posts"."title") as "lastTitle", MAX("user"."username") as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
GROUP BY "posts"."user_id"
ORDER BY "userId" ASC
```

<a id="keys"></a>

### Group by a column, a navigation or an expression

A key is a column of the projection — also one read through a navigation, which is joined — several columns,
or an SQL expression:

```ts
import { dateTrunc } from 'linkgress-orm';

const byAuthor = await db.posts
  .select(p => ({ author: p.user!.username, views: p.views }))
  .groupBy(r => ({ author: r.author }))
  .select(g => ({ author: g.key.author, views: g.sum(r => r.views) }))
  .toList();

const perDay = await db.posts
  .select(p => ({ publishedAt: p.publishedAt, views: p.views }))
  .groupBy(r => ({ day: dateTrunc('day', r.publishedAt) }))
  .select(g => ({ day: g.key.day, posts: g.count(), views: g.sum(r => r.views) }))   // day: a Date
  .orderBy(r => r.day)
  .toList();
```

```sql
SELECT "user"."username" as "author", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
GROUP BY "user"."username"

SELECT "q1"."day" as "day", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("q1"."__arg0") AS DOUBLE PRECISION) as "views"
FROM (SELECT date_trunc('day', "posts"."published_at") as "day", "posts"."views" as "__arg0"
FROM "posts") "q1"
GROUP BY "day"
ORDER BY "day" ASC
```

Grouping by an expression wraps the rows in a subquery (`"q1"`) that computes each key once and projects
each aggregate argument once (`"__arg<n>"`); HAVING and ORDER BY read its columns, and everything below works
the same over it.

<a id="aggregates"></a>

### Aggregates per group

`g.count()`, `g.sum()`, `g.avg()`, `g.min()` and `g.max()`; the argument is a column of the projection or an
SQL expression over it (``g.max(r => sql`length(${r.title})`)``, ``g.sum(r => sql`${r.views} * 2`)``). The list
and distinct aggregates `g.arrayAgg()` / `g.countDistinct()` (since 1.0.31) have a
[section of their own](#list-a-groups-members-and-count-distinct-values-garrayagg-gcountdistinct).

- COUNT reads as a number (`CAST(COUNT(*) AS INTEGER)`: a group of more than 2,147,483,647 rows fails with
  `integer out of range`); SUM and AVG read as numbers, cast to `DOUBLE PRECISION` (inexact for large
  `numeric` / `bigint` totals).
- MIN / MAX read as a value of their column: text as a string, a timestamp as a `Date`, a mapped column
  through its mapper (a grouped CTE or subquery keeps that mapper), a numeric column as a number. Of an SQL
  expression, a number-looking value reads as a number, anything else as it is.
- A projected value may also be an SQL expression over keys and aggregates, a constant, or `null`. Such an
  expression reads as the driver delivers it — an int8 or numeric as a string — so give it a mapper:

```ts
const ratios = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    perPostRaw: sql<number>`${g.sum(r => r.views)} / ${g.count()}`,                // '125': a string
    perPost: sql<number>`${g.sum(r => r.views)} / ${g.count()}`.mapWith(Number),   // 125
    kind: 'author-stats',
  }))
  .orderBy(r => r.userId)
  .toList();
```

```sql
SELECT "posts"."user_id" as "userId", SUM("posts"."views") / COUNT(*) as "perPostRaw", SUM("posts"."views") / COUNT(*) as "perPost", $1 as "kind"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "userId" ASC
-- params: [ "author-stats" ]
```

Inside an `sql` template the aggregates render uncast: `SUM(integer)` is a `bigint` and `/` is integer
division — cast an operand for a fractional ratio. A nested object, a collection or any other value in a
grouped projection is refused naming the field.

A conditional aggregate over a non-key column puts a `caseWhen` inside `g.sum()`; an exact `numeric` total
reads the bare SUM through an `sql` template:

```ts
import { caseWhen } from 'linkgress-orm';

const completed = await db.orders
  .select(o => ({ userId: o.userId, status: o.status }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, completed: g.sum(r => caseWhen(eq(r.status, 'completed'), 1).else(0)) }))
  .orderBy(r => r.userId)
  .toList();

const exact = await db.orders
  .select(o => ({ userId: o.userId, amount: o.totalAmount }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, cast: g.sum(r => r.amount), exact: sql<string>`${g.sum(r => r.amount)}` }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, cast: 99.99, exact: '99.99' }, …]
```

```sql
SELECT "orders"."user_id" as "userId", CAST(SUM(CASE WHEN "orders"."status" = $1 THEN CAST($2 AS integer) ELSE CAST($3 AS integer) END) AS DOUBLE PRECISION) as "completed"
FROM "orders"
GROUP BY "orders"."user_id"
ORDER BY "userId" ASC
-- params: [ "completed", 1, 0 ]

SELECT "orders"."user_id" as "userId", CAST(SUM("orders"."total_amount") AS DOUBLE PRECISION) as "cast", SUM("orders"."total_amount") as "exact"
FROM "orders"
GROUP BY "orders"."user_id"
ORDER BY "userId" ASC
```

### List a group's members and count distinct values: `g.arrayAgg()`, `g.countDistinct()`

`g.arrayAgg(r => …, { distinct?, orderBy? })` and `g.countDistinct(r => …)` (since 1.0.31) aggregate a column or
expression of the grouped row: the members of each group as a list, and the number of distinct values. Use them
instead of reading the rows and folding them per key in JS. (`agg.arrayAgg()` in a grouped select reads the grouping
key only.)

```ts
const perAuthor = await db.posts
  .select(p => ({ userId: p.userId, id: p.id, views: p.views, category: p.category, time: p.publishTime }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    postIds: g.arrayAgg(r => r.id, { orderBy: [[r => r.views, 'DESC']] }),   // number[]
    slots: g.arrayAgg(r => r.time, { orderBy: [r => r.time] }),              // { hour, minute }[]: through the mapper
    categories: g.countDistinct(r => r.category),                            // number
    posts: g.count(),
  }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, postIds: [2, 1], slots: [{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }], categories: 1, posts: 2 },
//  { userId: 2, postIds: [3], slots: [{ hour: 18, minute: 45 }], categories: 1, posts: 1 }]
```

```sql
SELECT "posts"."user_id" as "userId", array_agg("posts"."id" ORDER BY "posts"."views" DESC) as "postIds",
  array_agg("posts"."publish_time" ORDER BY "posts"."publish_time" ASC) as "slots", count(DISTINCT "posts"."category") as "categories",
  CAST(COUNT(*) AS INTEGER) as "posts"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "userId" ASC
```

Over an expression key the operands become columns of the subquery that computes the key (`"__arg<n>"`, one per
column or expression however many selectors select it):

```ts
const perDay = await db.posts
  .select(p => ({ publishedAt: p.publishedAt, title: p.title, views: p.views, userId: p.userId }))
  .groupBy(r => ({ day: dateTrunc('day', r.publishedAt) }))
  .select(g => ({
    day: g.key.day,
    titles: g.arrayAgg(r => r.title, { orderBy: [[r => r.views, 'DESC']] }),
    authors: g.countDistinct(r => r.userId),
  }))
  .toList();
// [{ day: <the seed day, a Date>, titles: ['Bob Post', 'Alice Post 2', 'Alice Post 1'], authors: 2 }]
```

```sql
SELECT "q1"."day" as "day", array_agg("q1"."__arg0" ORDER BY "q1"."__arg1" DESC) as "titles", count(DISTINCT "q1"."__arg2") as "authors"
FROM (SELECT date_trunc('day', "posts"."published_at") as "day", "posts"."title" as "__arg0", "posts"."views" as "__arg1", "posts"."user_id" as "__arg2"
FROM "posts") "q1"
GROUP BY "day"
```

Both work in `having()`; `distinct: true` lists each value once:

```ts
const shared = await db.posts
  .select(p => ({ category: p.category, userId: p.userId, id: p.id }))
  .groupBy(r => ({ category: r.category }))
  .having(g => gt(g.countDistinct(r => r.userId), 1))
  .select(g => ({
    category: g.key.category,
    authorIds: g.arrayAgg(r => r.userId, { distinct: true, orderBy: [[r => r.userId, 'DESC']] }),
    postIds: g.arrayAgg(r => r.id, { orderBy: [r => r.id] }),
  }))
  .toList();
// [{ category: 'tech', authorIds: [2, 1], postIds: [1, 2, 3] }]
```

```sql
SELECT "posts"."category" as "category", array_agg(DISTINCT "posts"."user_id" ORDER BY "posts"."user_id" DESC) as "authorIds",
  array_agg("posts"."id" ORDER BY "posts"."id" ASC) as "postIds"
FROM "posts"
GROUP BY "posts"."category"
HAVING count(DISTINCT "posts"."user_id") > $1
-- params: [ 1 ]
```

- `g.arrayAgg()` renders `array_agg([DISTINCT] … [ORDER BY …])`: one element per row of the group, a NULL value
  too (`g.arrayAgg(r => r.subtitle)` read `[null, null]` for alice), each read like the column, through its mapper.
  A group has at least one row, so the list is never NULL.
- `orderBy` takes selectors over the grouped row, each alone (ascending) or as `[selector, 'ASC' | 'DESC']`; without
  it the list is in no particular order.
- `g.countDistinct()` renders `count(DISTINCT …)`: the distinct non-NULL values, a number.
- The selector returns a column of the grouped row (also one read through a navigation) or an `sql` expression of
  it. A constant or a nested aggregate is refused where the call is written: `g.arrayAgg(): the selector returned the
  constant 5 — it must return a column or an sql expression of the grouped row.`, `g.countDistinct(): the selector
  returned an aggregate — aggregate function calls cannot be nested.`
- With `distinct: true` the list can be ordered by the aggregated value only: `g.arrayAgg(r => r.userId, { distinct:
  true, orderBy: [r => r.views] })` (with `views` projected) throws `g.arrayAgg(): with distinct, the list can be
  ordered by the aggregated value only — …` before anything is sent (PostgreSQL would answer 42P10).
- They also work inside `sql` expressions of the projection, as a CTE body, a joined table subquery and a
  `QueryBatch` member (`future()`, `futureFirstOrDefault()`, `futureCount()`).
- A grouping key named `__arg<n>` no longer collides with a generated operand column (42702 before 1.0.31): the
  generated names skip it.

> **Pitfall:** postgres.js hands an unquoted NULL element of any native array to the element's parser (`'NULL'`,
> `NaN`) where node-postgres, Bun, PGlite and the in-memory database read `null`. On `PostgresClient`, aggregate a
> nullable column with `g.arrayAgg()` only when its NULLs are filtered out before grouping (`agg.arrayAgg()` has the
> same caveat).

<a id="having"></a>

### Filter groups: `having()`

`having()` filters the groups. Its callback receives the group as columns, so aggregates and keys go into
conditions as they are — no cast:

```ts
import { lt } from 'linkgress-orm';

const prolific = await db.posts
  .select(p => ({ userId: p.userId, views: p.views, title: p.title }))
  .groupBy(r => ({ userId: r.userId }))
  .having(g => and(
    gt(g.count(), 1),
    or(gt(g.sum(r => r.views), 200), lt(g.min(r => r.title), 'B')),
  ))
  .select(g => ({ userId: g.key.userId, posts: g.count() }))
  .toList();
// [{ userId: 1, posts: 2 }]
```

```sql
SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts"
FROM "posts"
GROUP BY "posts"."user_id"
HAVING (COUNT(*) > $1 AND (SUM("posts"."views") > $2 OR MIN("posts"."title") < $3))
-- params: [ 1, 200, "B" ]
```

Any condition works: `and` / `or` / `not`, `between`, `inArray`, `isNull`, an aggregate on either side of a
comparison (`gt(g.max(r => r.views), g.min(r => r.views))`), a grouping key (`eq(g.key.userId, 7)`), an `sql`
fragment (``sql`${g.count()} > ${5}` ``), an aggregate of a navigation column, a distinct count
(`gt(g.countDistinct(r => r.userId), 1)`, since 1.0.31, [above](#list-a-groups-members-and-count-distinct-values-garrayagg-gcountdistinct)). `having()` can be called before
or after `select()`, and repeatedly: the conditions are ANDed. Its callback runs when the query is built, over
the same group the projection reads.

> **Efficiency:** keep `having()` for conditions on aggregates and filter rows with `where()` before
> `select()`. A key condition in `having()` renders `HAVING "posts"."user_id" = $1`; PostgreSQL's planner moves
> a HAVING condition that holds no aggregate (and no volatile function) into WHERE, where an index can serve it.

<a id="order-by-limit"></a>

### Order and limit groups

A grouped query orders by what it projects — a key or an aggregate by its output alias:

```ts
const top = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, total: g.sum(r => r.views) }))
  .orderBy(r => [[r.total, 'DESC NULLS LAST'], r.userId])
  .limit(10)
  .toList();
```

```sql
SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "total"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "total" DESC NULLS LAST, "userId" ASC
LIMIT 10
```

An `sql` expression written inside `orderBy()` is refused — project it and order by that field. `LIMIT` and
`OFFSET` are inlined literals. `first()` / `firstOrDefault()` leave `LIMIT 1` on the grouped builder, as on
plain builders.

### Aggregate the whole set through `groupBy(() => ({}))`

An empty key renders no GROUP BY clause and always one row. Use it when grouped aggregates must sit inside
expressions — an `insertFrom()` source, a scalar subquery — such as `COALESCE(MAX(…), 0) + 1`:

```ts
import { add, coalesce } from 'linkgress-orm';

const next = await db.posts
  .select(p => ({ views: p.views }))
  .groupBy(() => ({}))
  .select(g => ({ posts: g.count(), nextViews: add(coalesce(g.max(r => r.views), 0), 1) }))
  .firstOrDefault();
// { posts: 3, nextViews: 201 }
```

```sql
SELECT CAST(COUNT(*) AS INTEGER) as "posts", (COALESCE(MAX("posts"."views"), $1) + $2) as "nextViews"
FROM "posts"
LIMIT 1
-- params: [ 0, 1 ]
```

For a plain whole-set read, the `agg` select above is shorter and adds FILTER, DISTINCT and list aggregates.

<a id="in-a-querybatch"></a>

### Read a grouped query in a QueryBatch

A grouped query — and a grouped query joined to a CTE or a table subquery — has the future API of a plain
select (`future()`, `futureFirstOrDefault()`, `futureCount()`), so it joins a `QueryBatch`:

```ts
const grouped = db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, posts: g.count(), views: g.sum(r => r.views) }))
  .orderBy(r => r.userId);

const batch = new QueryBatch();
const pageKey = batch.addList(grouped, 'perUser');
const groupsKey = batch.addCount(grouped, 'groups');   // the number of groups HAVING keeps
await batch.executeBatch();
// batch.getList(pageKey): [{ userId: 1, posts: 2, views: 250 }, …]; batch.getCount(groupsKey): 2
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "userId" ASC
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count FROM (SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
GROUP BY "posts"."user_id") AS "grouped_count"
) __batch_q
```

A batched grouped query reads exactly what its `toList()` / `firstOrDefault()` reads through the same client:
the same values of the same JS types, in the same key order (an int8 / numeric key as the driver delivers it,
a date key as the client's parser makes it). `futureCount()` counts every group HAVING keeps, ignoring the query's
ORDER BY, LIMIT and OFFSET (the count leg above has none of them).
What travels how: [Batch a grouped query with other reads](./batching-and-prepared-queries.md#batch-a-grouped-query-with-other-reads).

A grouped query also serves as a table subquery (`asSubquery('table')`, joined above), a membership list
(`eqAnySubquery(u.id, grouped.asSubquery('array'))`) and a CTE body whose aggregate columns later queries
filter with `where()` — see the [CTE guide](./cte-guide.md) and the [subquery guide](./subquery-guide.md).
`lateralJoin()` combined with `groupBy()` throws.

<a id="window-functions"></a>

## Number and rank rows: window functions

`win.rowNumber()`, `win.rank()` and `win.denseRank()` (since 1.0.21), each with
`.over({ partitionBy, orderBy })`, number or rank rows while keeping every row; they read as JS numbers.

```ts
import { win } from 'linkgress-orm';

const ranked = await db.posts
  .orderBy(p => p.id)
  .select(p => ({
    id: p.id,
    userId: p.userId,
    views: p.views,
    rowInUser: win.rowNumber().over({ partitionBy: p.userId, orderBy: [[p.views, 'DESC'], p.id] }),
    rankByViews: win.rank().over({ orderBy: [[p.views, 'DESC']] }),
  }))
  .toList();
```

```sql
SELECT "posts"."id" as "id", "posts"."user_id" as "userId", "posts"."views" as "views",
  row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC) as "rowInUser",
  rank() OVER (ORDER BY "posts"."views" DESC) as "rankByViews"
FROM "posts"
ORDER BY "id" ASC
```

A window value cannot be filtered by the query that computes it (PostgreSQL computes windows after WHERE):
`where()` on it throws before anything is sent. Compute it in a CTE and filter where the CTE is read:

```ts
import { DbCteBuilder, lte } from 'linkgress-orm';

const rankedPosts = new DbCteBuilder().with(
  'ranked_posts',
  db.posts.select(p => ({
    postId: p.id,
    userId: p.userId,
    title: p.title,
    rn: win.rowNumber().over({ partitionBy: p.userId, orderBy: [[p.views, 'DESC'], p.id] }),
  })),
);
const topPerAuthor = await db.selectFromCte(rankedPosts.cte)
  .where(r => lte(r.rn, 1))
  .select(r => ({ userId: r.userId, title: r.title }))
  .toList();
// [{ userId: 1, title: 'Alice Post 2' }, { userId: 2, title: 'Bob Post' }]
```

```sql
WITH "ranked_posts" AS (SELECT "posts"."id" as "postId", "posts"."user_id" as "userId", "posts"."title" as "title",
  row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC) as "rn"
FROM "posts")
SELECT "ranked_posts"."userId" as "userId", "ranked_posts"."title" as "title"
FROM "ranked_posts"
WHERE "ranked_posts"."rn" <= $1
-- params: [ 1 ]
```

| Need | Use | SQL shape | Note |
|---|---|---|---|
| The first N children nested in each parent row | collection `orderBy(…).limit(n).toList()` | `ORDER BY … LIMIT n` per parent (lateral) | reads at most N rows per parent through a foreign-key index |
| The first N rows per group as flat rows | `win.rowNumber()` in a CTE + `where(r => lte(r.rn, n))` | `row_number() OVER (PARTITION BY …)` then `WHERE "rn" <= $1` | `win.rank()` / `denseRank()` keep ties |
| The top N groups by an aggregate | grouped `orderBy(r => [[r.total, 'DESC']]).limit(n)` | `GROUP BY … ORDER BY "total" DESC LIMIT n` | |

Any other window expression — an aggregate with `OVER`, `lag` / `lead`, a frame — is a raw `sql` template:

```ts
const running = await db.posts
  .orderBy(p => p.id)
  .select(p => ({
    id: p.id,
    views: p.views,
    runningTotal: sql<number>`SUM(${p.views}) OVER (ORDER BY ${p.id})`,
  }))
  .toList();
// runningTotal: 100, 250, 450
```

```sql
SELECT "posts"."id" as "id", "posts"."views" as "views", SUM("posts"."views") OVER (ORDER BY "posts"."id") as "runningTotal"
FROM "posts"
ORDER BY "id" ASC
```

Window ORDER BY directions are only `'ASC'` and `'DESC'` (no NULLS FIRST / LAST); `over()` replaces an earlier
window. More: [SQL expression helpers](./sql-expressions.md#number-and-rank-rows-win-since-1021).

## Combine result sets: `union()`, `unionAll()`

`union()` and `unionAll()` combine same-shaped projections into one statement; `orderBy()`, `limit()`,
`offset()`, `count()`, `firstOrDefault()` and `toList()` then apply to the whole result. Use `unionAll()` unless
duplicates must go; tag the legs with `literal()`.

```ts
import { literal } from 'linkgress-orm';

const labels = await db.users
  .select(u => ({ id: u.id, label: u.username, kind: literal('user') }))
  .unionAll(db.tags.select(t => ({ id: t.id, label: t.name, kind: literal('tag') })))
  .orderBy(r => r.label)
  .limit(4)
  .toList();

const names = db.users
  .select(u => ({ name: u.username }))
  .union(db.users.select(u => ({ name: u.username })));
const distinctNames = await names.toList();   // 3 rows: UNION removed the duplicates
const nameCount = await names.count();        // 3
```

```sql
(SELECT "users"."id" as "id", "users"."username" as "label", 'user' as "kind"
FROM "users")
UNION ALL
(SELECT "tags"."id" as "id", "tags"."name" as "label", 'tag' as "kind"
FROM "tags")
ORDER BY "label" ASC
LIMIT 4

(SELECT "users"."username" as "name"
FROM "users")
UNION
(SELECT "users"."username" as "name"
FROM "users")

SELECT COUNT(*) as count FROM ((SELECT "users"."username" as "name"
FROM "users")
UNION
(SELECT "users"."username" as "name"
FROM "users")) as union_count
```

A union also joins a `QueryBatch` as a list (`future()`), a first row (`futureFirstOrDefault()`) or a count
(`futureCount()`), the last two since 1.0.31: its count is the statement `count()` sends above, the union's own
`LIMIT` / `OFFSET` counted, and both are refused when the legs declare a data-modifying CTE. See
[Count a union or read its first row in a batch](./batching-and-prepared-queries.md#count-a-union-or-read-its-first-row-in-a-batch).

> **Efficiency:** `UNION` sorts or hashes to remove duplicates; `UNION ALL` appends.

> **Pitfall:** legs match by POSITION, not by key: a leg written `{ b: u.email, a: u.username }` after a leg
> `{ a: u.username, b: u.email }` swapped the values of the second leg's rows (verified). Write every leg's
> keys in the same order.

> **Pitfall:** a leg's own `orderBy()` / `limit()` / `offset()` are dropped (a leg with `limit(1)` still
> returned all its rows); wrap such a leg in a CTE or subquery. The union's `orderBy()` takes projected fields
> only. A plain JS literal in a leg binds untyped, so a boolean reads back as `"true"`: use `literal()`. There is no
> `withPreparedStatements()` on a union — set it on the first leg. CTE-rooted queries take `union()` /
> `unionAll()` too (since 1.0.29).

## Lock the rows you read: `forUpdate()`

`forUpdate({ skipLocked?, noWait? })` appends `FOR UPDATE [SKIP LOCKED | NOWAIT]` to a select builder. Use it
for a read-then-write inside ONE transaction (`tx.<table>`), and with `skipLocked` for job queues. Outside a
transaction the lock ends with the statement.

```ts
await db.transaction(async tx => {
  const order = await tx.orders
    .where(o => eq(o.id, 1))
    .select(o => ({ id: o.id, status: o.status }))
    .forUpdate()
    .firstOrDefault();
  // … decide and write through tx …
});

await db.transaction(async tx => {
  const jobs = await tx.orders
    .where(o => eq(o.status, 'pending'))
    .orderBy(o => o.id)
    .select(o => ({ id: o.id }))
    .limit(10)
    .forUpdate({ skipLocked: true })
    .toList();
});
```

```sql
SELECT "orders"."id" as "id", "orders"."status" as "status"
FROM "orders"
WHERE "orders"."id" = $1
LIMIT 1
FOR UPDATE
-- params: [ 1 ]

SELECT "orders"."id" as "id"
FROM "orders"
WHERE "orders"."status" = $1
ORDER BY "id" ASC
LIMIT 10
FOR UPDATE SKIP LOCKED
-- params: [ "pending" ]
```

> **Pitfall:** `skipLocked` and `noWait` together throw `forUpdate: skipLocked and noWait are mutually exclusive`.
> Union and collection legs drop the lock. Order locked rows by a stable key to avoid deadlocks between
> concurrent lockers. A CTE-rooted query's `forUpdate()` locks no rows; put it on the CTE body
> ([CTE guide](./cte-guide.md#lock-the-rows-a-cte-reads-forupdate-in-the-body)).

<a id="subqueries"></a><a id="scalar-subquery"></a><a id="in-subquery"></a><a id="exists-subquery"></a>

## Filter or compute with a subquery

`<query>.select(…).asSubquery(mode)` embeds a query in another statement: `'array'` for `inSubquery()` /
`eqAnySubquery()`, `'table'` (the default) for `exists()` / `notExists()` and joins, `'scalar'` for comparisons and
projected values. It replaces a fetch-ids-then-query second round trip. Prefer a collection
(`exists(u.posts!)`, `u.posts!.count()`) when a navigation models the relation.

```ts
import { gtSubquery, inSubquery } from 'linkgress-orm';

const usersWithPopularPosts = await db.users
  .where(u => inSubquery(u.id, db.posts.where(p => gt(p.views, 120)).select(p => p.userId).asSubquery('array')))
  .select(u => u.username)
  .toList();

const withOrders = await db.users
  .where(u => exists(db.orders.where(o => eq(o.userId, u.id)).select(() => ({ one: literal(1) })).asSubquery()))
  .select(u => u.username)
  .toList();

const aboveAverage = await db.posts
  .where(p => gtSubquery(p.views, db.posts.select(x => agg.avg(x.views)).asSubquery('scalar')))
  .select(p => p.title)
  .toList();      // ['Bob Post']

const lastTitles = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    lastTitle: db.posts.where(p => eq(p.userId, u.id)).select(p => agg.max(p.title)).asSubquery('scalar'),
  }))
  .toList();      // charlie: lastTitle null
```

```sql
SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN (SELECT "posts"."user_id"
FROM "posts"
WHERE "posts"."views" > $1)
-- params: [ 120 ]

SELECT "users"."username"
FROM "users"
WHERE EXISTS (SELECT 1 as "one"
FROM "orders"
WHERE "orders"."user_id" = "users"."id")

SELECT "posts"."title"
FROM "posts"
WHERE "posts"."views" > (SELECT avg("posts"."views")
FROM "posts")

SELECT "users"."username" as "username", (SELECT max("posts"."title")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "lastTitle"
FROM "users"
ORDER BY "users"."id" ASC
```

> **Pitfall:** `exists()` takes a `Subquery` or a collection: a query builder (`exists(db.posts.where(…))`) or an
> `sql` fragment throws a `TypeError` before anything is sent. `inSubquery()` needs an `'array'` subquery that
> projects ONE value (`select(p => p.userId)`). A scalar subquery adds no LIMIT: two rows fail with
> `more than one row returned by a subquery used as an expression`. `notInSubquery()` returns no row once the
> subquery yields a NULL — `notExists()` is NULL-safe.

A projected scalar subquery of one column reads like that column (since 1.0.29). Correlated subqueries over the
same table (`db.posts.as('p2')`), `eqAnySubquery()`, `asExpression()` and the full list:
[Subquery guide](./subquery-guide.md) and [Aliased scopes](./aliased-scopes.md).

<a id="ctes-common-table-expressions"></a><a id="simple-cte"></a><a id="recursive-cte"></a>

## Name a derived set once: CTEs

`new DbCteBuilder().with(name, query)` returns `{ cte }`; join it with `innerJoin()` / `leftJoin()`, filter by it
with `joinFilter()`, or read it as a query root with `db.selectFromCte(cte)`. Use a CTE when one derived set is
read in several places of a statement, for window results filtered by rank, and for data-modifying CTEs. There
is no `cte()` export and no recursive CTE builder: `WITH RECURSIVE` needs raw SQL through `db.query()`.

```ts
const userStats = new DbCteBuilder().with(
  'user_stats',
  db.posts
    .select(p => ({ userId: p.userId, views: p.views }))
    .groupBy(r => ({ userId: r.userId }))
    .select(g => ({ userId: g.key.userId, totalViews: g.sum(r => r.views) })),
);

const withTotals = await db.users
  .innerJoin(userStats.cte, (u, s) => eq(u.id, s.userId), (u, s) => ({ username: u.username, totalViews: s.totalViews }))
  .toList();
// [{ username: 'alice', totalViews: 250 }, { username: 'bob', totalViews: 200 }]
```

```sql
WITH "user_stats" AS (SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "totalViews"
FROM "posts"
GROUP BY "posts"."user_id")
SELECT "users"."username" as "username", "user_stats"."totalViews" as "totalViews"
FROM "users"
INNER JOIN "user_stats" ON "users"."id" = "user_stats"."userId"
```

A CTE read once in one place costs the same as a subquery (PostgreSQL 12+ inlines it);
`with(name, query, { materialized: true })` fences it. Statement-level declaration, `withAggregation()`,
FULL / RIGHT / CROSS joins from a CTE root, `withMutation()`, `afterMutation()` and `<table>.selectFromCte()`
(since 1.0.30): [CTE guide](./cte-guide.md). Rows from JS arrays and `unnest`: [Set-returning
functions](./set-returning-functions.md).

<a id="magic-sql-strings"></a><a id="basic-usage"></a>

## Write SQL the helpers do not cover: `sql`

`` sql<T>`…` `` builds a fragment usable as a projected value, a `where()` condition, an `orderBy()` key or a
`db.query()` statement. Interpolated column refs render qualified (their navigations joined) and interpolated
JS values become bound parameters. Prefer a built-in helper when one exists ([SQL expression
helpers](./sql-expressions.md): casts, CASE, strings, dates, JSONB, arrays, `agg`, `win`): helpers type their
parameters and their reads.

```ts
const labelled = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    id: u.id,
    label: sql<string>`${u.username} || ' <' || ${u.email} || '>'`,
    accountAgeYears: sql<number>`EXTRACT(YEAR FROM AGE(CURRENT_DATE, ${u.createdAt}))`,
  }))
  .toList();
// [{ id: 1, label: 'alice <alice@test.com>', accountAgeYears: 0 }, …]
```

```sql
SELECT "users"."id" as "id", "users"."username" || ' <' || "users"."email" || '>' as "label",
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, "users"."created_at")) as "accountAgeYears"
FROM "users"
ORDER BY "id" ASC
```

<a id="type-safe-parameters"></a>

### Values are bound parameters

```ts
const searchTerm = 'li';
const minAge = 18;
const results = await db.users
  .where(u => and(
    sql<boolean>`${u.username} ILIKE ${'%' + searchTerm + '%'}`,
    sql<boolean>`${u.age} >= ${minAge}`,
  ))
  .select(u => u.username)
  .toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE (("users"."username" ILIKE $1) AND ("users"."age" >= $2))
-- params: [ "%li%", 18 ]
```

Interpolated values are untyped parameters: where PostgreSQL cannot infer a type (variadic or polymorphic
function arguments such as `concat_ws`) cast them in the template (`${x}::text`) or use a helper. `sql.raw(text)`
inlines text verbatim — never pass user input to it.

### Reading a fragment's value: `mapWith`

`.mapWith(fn)` reads the fragment's driver value through `fn` (null stays null) — at the top level, inside
nested objects, in a collection's items, in a grouped query and in any mutation's `.returning()`. The
fragment's value type is what `fn` returns; `.mapWith(customType)` takes a mapper object with `fromDriver` /
`toDriver` instead — one declared `immutable: true` shares each distinct value's mapped value within the
result set (see [Share mapped values across rows](./schema-configuration.md#share-mapped-values-across-rows-immutable-true)), which an inline
`fn` never does. `.withReadType('text' | 'numeric' | …)` reads the value the way a column of that type reads,
without changing the SQL.

```ts
const read = await db.users
  .where(u => eq(u.id, 1))
  .select(u => ({
    ageText: sql<string>`${u.age}::text`.mapWith(Number),            // 25
    tag: sql<string>`upper(${u.username})`.mapWith(v => `#${v}`),    // '#ALICE'
    zipRaw: sql<string>`'01234'`,                                    // 1234: the generic conversion
    zipText: sql<string>`'01234'`.withReadType('text'),              // '01234'
  }))
  .firstOrDefault();
```

```sql
SELECT "users"."age"::text as "ageText", upper("users"."username") as "tag", '01234' as "zipRaw", '01234' as "zipText"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]
```

In a plain select a fragment WITHOUT a mapper reads through the generic conversion of untyped values: a
numeric-looking string becomes a number and NULL `undefined`. In a grouped select it reads as the driver
delivers it. A mutation's `.returning()` hands such a value over as the driver delivers it. Call `agg`
`.filter()` and `win` `.over()` before `.mapWith()`: the fragment `.mapWith()` returns has neither method.

<a id="custom-formatters"></a><a id="array-operations"></a><a id="postgresql-specific-functions"></a>

### JSON paths, arrays and full-text search

JSON fields: `jsonbPathText(col, 'tags', 0)` renders `->` / `->>` paths and reads the text exactly;
`jsonbPath()` reads the JSON value. A hand-written `->>'tags'->0` fails, because `->>` returns text:

```ts
import { jsonbPath, jsonbPathText } from 'linkgress-orm';

// alice's metadata: { tags: ['admin', 'beta'], genre: 'poetry' }
const tags = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ firstTag: jsonbPathText(u.metadata, 'tags', 0), tags: jsonbPath<string[]>(u.metadata, 'tags') }))
  .toList();
// [{ firstTag: 'admin', tags: ['admin', 'beta'] }]
```

```sql
SELECT ("users"."metadata"->'tags'->>0) as "firstTag", ("users"."metadata"->'tags') as "tags"
FROM "users"
WHERE "users"."username" = $1
-- params: [ "alice" ]
```

```sql
SELECT "users"."metadata"->>'tags'->0 as "firstTag"
FROM "users"
-- error: operator does not exist: text -> integer
```

Native array columns: `arrayOverlaps(col, list)` (`&&`), `arrayContainsAll(col, list)` (`@>`) and
`arrayContainedBy(col, list)` (`<@`) bind the JS list as ONE typed array literal, which works on every driver;
`arrayContains(col, v)` renders `(v = ANY(col))` and `arrayLength(col)` renders `cardinality(col)` (`0` for an
empty array). A raw `` sql`${p.tags} && ${tags}` `` with a bare JS array fails on Bun, and `array_length(x, 1)`
is NULL for an empty array. The example model has no array column; with a
`posts.tags` column declared `text('tags').array()`:

```ts
import { arrayLength, arrayOverlaps } from 'linkgress-orm';

const tagged = await db.posts.where(p => arrayOverlaps(p.tags, ['typescript', 'database'])).select(p => p.title).toList();
const counts = await db.posts.select(p => ({ title: p.title, tagCount: arrayLength(p.tags) })).toList();
```

```sql
SELECT "posts"."title"
FROM "posts"
WHERE ("posts"."tags" && CAST($1 AS text[]))
-- params: [ "{\"typescript\",\"database\"}" ]

SELECT "posts"."title" as "title", cardinality("posts"."tags") as "tagCount"
FROM "posts"
```

Full-text search has no helper; write the condition as a template. The in-memory database does not implement
`@@` (`in-memory engine: operator @@ (ts_match_vq) is not implemented`); PostgreSQL runs the statement as
captured:

```ts
const matches = await db.posts
  .where(p => sql<boolean>`to_tsvector('english', ${p.title} || ' ' || coalesce(${p.content}, '')) @@ to_tsquery('english', ${'alice & content'})`)
  .select(p => p.title)
  .toList();
```

```sql
SELECT "posts"."title"
FROM "posts"
WHERE to_tsvector('english', "posts"."title" || ' ' || coalesce("posts"."content", '')) @@ to_tsquery('english', $1)
-- params: [ "alice & content" ]
```

<a id="executing-a-fragment"></a>

### Run a raw statement: `db.query()`

`db.query(fragment)` and `db.query(text, params)` run a statement on the context's client (on `tx`, the
transaction's) and return the driver rows. In the fragment form interpolated values are parameters, nested
fragments and `sql.join()` share one parameter numbering, `sql.raw()` text is inlined and `sql.empty` renders
nothing, so a raw statement needs no hand-numbered `$1`, `$2`.

```ts
const minAge2 = 30;
const adults = await db.query<{ id: number; username: string }>(
  sql`SELECT id, username FROM users WHERE age >= ${minAge2} ORDER BY id`,
);

const conditions = [sql`age > ${20}`, sql`is_active = ${true}`];
const order = sql.raw('id DESC');
const onlyWithEmail = false;
const rows = await db.query(
  sql`SELECT id, username FROM "users" WHERE ${sql.join(conditions, sql` AND `)} ${onlyWithEmail ? sql`AND email IS NOT NULL` : sql.empty} ORDER BY ${order}`,
);

await db.transaction(async tx => {
  await tx.query(sql`UPDATE users SET age = age + ${1} WHERE id = ${adults[0].id}`);
});
```

```sql
SELECT id, username FROM users WHERE age >= $1 ORDER BY id
-- params: [ 30 ]

SELECT id, username FROM "users" WHERE age > $1 AND is_active = $2  ORDER BY id DESC
-- params: [ 20, true ]

UPDATE users SET age = age + $1 WHERE id = $2
-- params: [ 1, 2 ]
```

Bind a list with an explicit cast — `${cast(ids, 'int[]')}` renders `CAST($1 AS int[])` with the array
literal `'{1,3}'`, which every driver binds (a bare JS array fails on Bun). Bind a JSON document with
`castAsJsonb(doc)`:

```ts
import { cast } from 'linkgress-orm';

const ids = [1, 3];
const picked = await db.query(sql`SELECT id, username FROM users WHERE id = ANY(${cast(ids, 'int[]')}) ORDER BY id`);
```

```sql
SELECT id, username FROM users WHERE id = ANY(CAST($1 AS int[])) ORDER BY id
-- params: [ "{1,3}" ]
```

- Rows are raw: no mappers, an int8 such as `count(*)` arrives as `'1'`, a mapped column as its stored value.
- `db.query()` bypasses the context's executor: no `logQueries` line, no `onQueryTakingTooLong`, no
  `withTimeout()`, never a named prepared statement. `db.getClient().query(text, params)` returns the whole
  driver result (`{ rows, rowCount }`).
- A named `sql.placeholder()` is refused here: it binds only inside a [prepared query](#build-a-query-once-run-it-with-new-values-prepare).
  The client-level `querySimple()` / `querySimpleMulti()` (PostgresClient, BunClient, PGliteClient; not
  PgClient) take text only, because the simple protocol that runs several statements in one call carries no
  parameters.

<a id="built-in-operators"></a>

## Built-in operators: `coalesce()`, JSONB, flags

The operators below sit next to the condition functions in the package root. The rest of the expression
vocabulary — casts (`castAsInt()`, `.cast('numeric(12, 2)')`), `caseWhen` / `caseOf`, `greatest` / `least` /
`nullIf`, `isDistinctFrom`, string, math and date functions, JSONB paths and mutations (`jsonbPathText`,
`jsonbSet`, `jsonbContains`, …), array-column operators — is in [SQL expression helpers](./sql-expressions.md).

<a id="coalesce"></a>

### Default a NULL: `coalesce()`

```ts
const ages = await db.users.orderBy(u => u.id).select(u => ({ id: u.id, effectiveAge: coalesce(u.age, 0) })).toList();
const titles = await db.posts.orderBy(p => p.id).select(p => ({ id: p.id, displayTitle: coalesce(p.subtitle, p.title) })).toList();
```

```sql
SELECT "users"."id" as "id", COALESCE("users"."age", $1) as "effectiveAge"
FROM "users"
ORDER BY "id" ASC
-- params: [ 0 ]

SELECT "posts"."id" as "id", COALESCE("posts"."subtitle", "posts"."title") as "displayTitle"
FROM "posts"
ORDER BY "id" ASC
```

The first real mapper among the operands reads the result (a mapped `Date` column stays a `Date`, and a
plain fallback is bound through that mapper's `toDriver()`).

<a id="jsonb-operators"></a>

### Read JSONB fields

`jsonbSelect<T>(col, key)` (`->`) and `jsonbSelectText<T>(col, key)` (`->>`) type the key by `keyof T`. They
carry no result mapper: a digits-only value reads as a NUMBER (`'007'` → `7`) and a top-level NULL reads as
`undefined`; `jsonbSelect` also re-parses the document per row (`#>> '{}'` then `::jsonb`). For new code use
`jsonbPath()` / `jsonbPathText()`, which read the exact value:

```ts
import { jsonbSelect, jsonbSelectText } from 'linkgress-orm';

type OrderItems = { productName: string; quantity: number; sku: string };

// order 1 items: { productName: 'Book', quantity: 2, sku: '007' }; order 2 items: NULL
const orders = await db.orders
  .orderBy(o => o.id)
  .select(o => ({
    id: o.id,
    quantity: jsonbSelect<OrderItems>(o.items, 'quantity'),                  // 2
    productName: jsonbSelectText<OrderItems>(o.items, 'productName'),        // 'Book'
    skuText: jsonbSelectText<OrderItems>(o.items, 'sku'),                    // 7, not '007'
    displayName: coalesce(jsonbSelectText<OrderItems>(o.items, 'productName'), 'Unknown Product'),
  }))
  .toList();

const exact = await db.orders
  .orderBy(o => o.id)
  .select(o => ({ id: o.id, sku: jsonbPathText(o.items, 'sku') }))          // '007'; order 2: null
  .toList();
```

```sql
SELECT "orders"."id" as "id", (("orders"."items" #>> '{}')::jsonb->'quantity') as "quantity", ("orders"."items"->>'productName') as "productName",
  ("orders"."items"->>'sku') as "skuText", COALESCE(("orders"."items"->>'productName'), $1) as "displayName"
FROM "orders"
ORDER BY "id" ASC
-- params: [ "Unknown Product" ]

SELECT "orders"."id" as "id", ("orders"."items"->>'sku') as "sku"
FROM "orders"
ORDER BY "id" ASC
```

Containment and key tests (`jsonbContains` → `@>`, `jsonbHasKey` → `?`, GIN-indexable), `jsonbPathExists`,
`jsonbArraySome` and `jsonbMerge` / `jsonbSet` updates: [SQL expression helpers](./sql-expressions.md#read-filter-build-and-change-jsonb).

<a id="flagbitmask-operators"></a>

### Test bitmask flags

`flagHas`, `flagHasAll`, `flagHasAny` and `flagHasNone` test bits of an integer flag column; each renders as ONE
parenthesized expression, so it can be compared, combined, or projected as a boolean
(`select(u => ({ isAdmin: flagHas(u.permissions, Permission.Admin) }))`). The mask is bound, cast to the column width for
`smallint` (`::smallint`) and `bigint` (`::bigint`) columns. The example model has no flag column; with a
`users.permissions` column declared `integer('permissions')`:

```ts
import { flagHas, flagHasAll, flagHasAny, flagHasNone } from 'linkgress-orm';

enum Permission {
  None = 0,
  Read = 1,
  Write = 2,
  Delete = 4,
  Admin = 8,
  ReadWrite = Read | Write,   // 3
}

const readers = await db.users.where(u => flagHas(u.permissions, Permission.Read)).select(u => u.username).toList();
const editors = await db.users.where(u => flagHasAll(u.permissions, Permission.ReadWrite)).select(u => u.username).toList();
const privileged = await db.users.where(u => flagHasAny(u.permissions, Permission.Delete | Permission.Admin)).select(u => u.username).toList();
const nonAdmins = await db.users.where(u => flagHasNone(u.permissions, Permission.Admin)).select(u => u.username).toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE (("users"."permissions" & $1) != 0)
-- params: [ 1 ]

SELECT "users"."username"
FROM "users"
WHERE (("users"."permissions" & $1) = $2)
-- params: [ 3, 3 ]

SELECT "users"."username"
FROM "users"
WHERE (("users"."permissions" & $1) != 0)
-- params: [ 12 ]

SELECT "users"."username"
FROM "users"
WHERE (("users"."permissions" & $1) = 0)
-- params: [ 8 ]
```

| Function | SQL |
|---|---|
| `flagHas(column, flag)` | `((column & flag) != 0)` — the flag is set |
| `flagHasAll(column, flags)` | `((column & flags) = flags)` — every flag is set (the mask binds twice) |
| `flagHasAny(column, flags)` | `((column & flags) != 0)` — any flag is set |
| `flagHasNone(column, flag)` | `((column & flag) = 0)` — the flag is not set |

> **Efficiency:** a bit test cannot use a plain btree index; a selective lookup on one flag needs an
> expression or partial index on the exact expression. `flagSet()` / `flagUnset()` flip bits in one UPDATE
> (see [Inserts, updates and deletes](./insert-update-guide.md)).

<a id="use-explain-analyze"></a>

## See the SQL a query sends

Select and join builders have no `toSql()`. `future()` builds the final statement and its parameters without
sending anything; `getSql()` and `getParams()` read them. Unions, CTE-rooted and set queries have `toSql()`,
a prepared query `getSql()`, an insert / update / delete `toStatement()`.

```ts
const query = db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, postCount: u.posts!.count() }));
const future = query.future();
const text = future.getSql();        // nothing is sent
const params = future.getParams();   // [30]
// On a real server: const plan = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params);
```

```sql
SELECT "users"."id" as "id", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount"
FROM "users"
WHERE "users"."age" > $1
```

`EXPLAIN (ANALYZE …)` executes the statement it explains: for an insert, update or delete use plain `EXPLAIN`, or
run the `ANALYZE` form inside a transaction you roll back.

To see every statement while it runs, construct the context with
`{ logQueries: true, logParameters: true, logger: (message, section) => … }` (sections `'sql'`, `'params'`,
`'timing'`, …). Logging misses `db.query()`, `PreparedQuery.execute()` and `FutureQueryRunner`'s
multi-statement path, which bypass the executor. A `QueryBatch`, the `temptable` strategy and a `withTimeout()`
wrap send other statements than one query's `getSql()`. Options: [Configuration](./configuration.md).

## Tune execution per query

Any query — including one a helper receives already built — can override the context's execution policy:

```ts
// Named server-side prepared statement off for a query whose text varies per call, on for a hot lookup
await db.orders.orderBy(o => o.createdAt).limit(25).offset(250).withPreparedStatements(false).toList();
await db.users.withPreparedStatements(true).where(u => eq(u.username, 'alice')).firstOrDefault();

// Cancel server-side after 5 s (PostgresClient only: QueryTimeoutError); 0 disables the connection default
await db.orders.withTimeout(5000).toList();

// Not a cancellation: a budget for the onQueryTakingTooLong callback
await db.orders.expectedExecutionTime(30000).toList();

// QueryOptions for this chain only
await db.users.withQueryOptions({ collectionStrategy: 'cte' }).select(u => ({ n: u.posts!.count() })).toList();
```

| Override | Where | Effect and limits |
|---|---|---|
| `withPreparedStatements(bool)` | tables, `where()` chains, select builders and join results; on a grouped chain before `groupBy()`; on a union, its first leg | named statement (PostgresClient only; others ignore it); covers every terminal of that builder |
| `withTimeout(ms)` | tables, queries, select, grouped, union and CTE-root builders | PostgresClient only: `BEGIN; SET LOCAL statement_timeout = …; …; COMMIT` at the root, `SHOW` / `SET LOCAL` / restoring `SET LOCAL` inside a transaction (3 extra round trips either way); PgClient, BunClient and PGlite ignore it — set `statement_timeout` on the pool or use `db.transaction(fn, { timeoutMs })` (PGlite cannot cancel a statement at all) |
| `expectedExecutionTime(ms)` | tables and builders | only the `onQueryTakingTooLong` threshold |
| `withQueryOptions(options)` | `db.<table>` only (the start of a chain) | `collectionStrategy` always applies; logging and result options (`traceTime`, `rawResult`, `disableMappers`) apply only when the context or these options give the query an executor (`logQueries`, `logFailedQueries`, `logExecutionTime`, `onQueryTakingTooLong` or `preparedStatements`) |

Builder overrides change the builder they are called on and give the query its own executor: such a query
cannot share a `QueryBatch` with plain legs. Defaults and trade-offs: [Configuration](./configuration.md).

<a id="performance-tips"></a><a id="keep-statement-text-stable"></a><a id="use-select-projections"></a><a id="index-foreign-keys"></a><a id="use-collection-strategies-wisely"></a><a id="limit-collection-results"></a>

## Efficiency checklist

| Do | Why (verified or measured) | Instead of |
|---|---|---|
| Project the columns you use with `select()` | only projected columns travel; `db.users.toList()` reads all 8 columns of `users` | entity rows for a few fields |
| Read related rows in the same statement: navigations and collections in `select()` | 1 statement for any number of navigations and collections (default `lateral`) | a query per parent row (N+1) |
| Test existence with `exists()` | `SELECT EXISTS(SELECT 1 …)` stops at the first match and returns one boolean | `count() > 0`, fetching a row |
| Count with `count()` | `SELECT COUNT(*)`: no projection; only the joins the WHERE needs | `(await toList()).length` |
| Read several totals with one `agg` select | any number of aggregates and `FILTER` counts in 1 statement, read as numbers | builder `sum()` / `min()` / `max()`: 1 statement each, raw driver values |
| Batch independent reads with `QueryBatch` | 1 statement; `bench/querybatch` S (12 queries, ~31 ms round trip, median): 62 ms vs 743 ms sequential and 110 ms with `Promise.all` on a pool of 10 | sequential `await`s |
| Read a page and the total with `countOver()` or a `QueryBatch` | 1 statement | `Promise.all([toList(), count()])`: 2 statements on 2 connections |
| Match data-driven lists with `inArrayOpt()`, long lists with `eqAny()` | at most 8 `IN` texts plus 1 array text per column; `eqAny` is 1 parameter (IN is capped at 65,535 parameters, 32,767 on PGlite) | `inArray()` with lists of varying length |
| Page deep with keyset pagination | the cursor is a parameter and an index range scan; OFFSET reads and discards every skipped row, and each offset is another statement text | large `offset()` values |
| Index every foreign key a collection or `exists()` reads | foreign keys are not indexed automatically; `lateral` probes the key once per parent row | relying on the primary key index |
| Keep `lateral` for pages and lookups, use `cte` for full nested trees, avoid `temptable` | 100 of 2,000 users: `lateral` 1.32 ms vs `cte` 6.51 ms; nested tree: `cte` 2.70 ms vs `lateral` 5.43 ms; `temptable` 11.7 ms vs 1.2 ms | `temptable` (1 + 5 statements per collection on PgClient) |
| Filter parents by children with `exists()` / `notExists()` | semi- / anti-join, no duplicate parents | a join to the children plus DISTINCT |
| Limit child lists with `orderBy().limit(n)` per parent | `lateral` reads at most n rows per parent through the foreign-key index | loading every child and slicing in JS |
| Join one grouped subquery for several aggregates of one child table over many parents | one GROUP BY pass | one correlated subquery per aggregate, each reading the children again |
| Keep statement text stable under `preparedStatements` | each distinct text is one cached plan per pooled connection; `limit()` / `offset()` are inlined literals; `eq(c, null)` and `eq(c, v)` are different texts | per-call shapes; use `inArrayPadBuckets` for list lengths |
| Back text search with an index | prefix: btree under the C collation or `text_pattern_ops` (`ixNormalized`); `%contains%`: pg_trgm GIN | an unindexed `ILIKE '%x%'` on a large table |
| Cache query building on hot paths: `MockRowCache.setEnabled(true)` | memoises mock rows, navigation paths and lateral SQL per shape; SQL and results unchanged | rebuilding the same shapes cold |

<a id="type-safety"></a>

## Check result types at compile time

Results are inferred from the selector; selecting a column that does not exist does not compile. Navigation
properties are declared optional on entity classes (`posts?: Post[]`), so under `strict` they need `!` inside
selectors:

```ts
const typedRows = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    postCount: u.posts!.count(),
  }))
  .toList();
// { id: number; username: string; postCount: number }[]

// @ts-expect-error -- no such column
db.users.select(u => ({ x: u.invalidColumn }));
```

The types do not cover everything the runtime does: an unmatched `leftJoin()` column and a missing optional
navigation column read as `undefined` though typed non-null, builder `first()` returns `null` though typed
non-null, and top-level `decimal` / `bigint` columns typed `number` arrive as strings.

<a id="examples"></a><a id="dashboard-statistics"></a>

## Example: a user dashboard in one statement

Counts, totals, an average and two top-five lists of one user, in one statement. Collections have no `avg()`,
so the average is a correlated `agg.avg()` scalar subquery:

```ts
async function getDashboardStats(userId: number) {
  return db.users
    .where(u => eq(u.id, userId))
    .select(u => ({
      username: u.username,
      totalPosts: u.posts!.count(),
      totalViews: u.posts!.sum(p => p.views),
      maxViews: u.posts!.max(p => p.views),
      avgViews: db.posts.where(p => eq(p.userId, u.id)).select(p => agg.avg(p.views)).asSubquery('scalar'),
      recentPosts: u.posts!
        .orderBy(p => [[p.publishedAt, 'DESC'], [p.id, 'DESC']])
        .limit(5)
        .select(p => ({ title: p.title, views: p.views }))
        .toList(),
      topPosts: u.posts!
        .orderBy(p => [[p.views, 'DESC']])
        .limit(5)
        .select(p => ({ title: p.title, views: p.views }))
        .toList(),
    }))
    .firstOrDefault();
}

await getDashboardStats(1);
// { username: 'alice', totalPosts: 2, totalViews: 250, maxViews: 150, avgViews: 125,
//   recentPosts: [{ title: 'Alice Post 2', views: 150 }, …], topPosts: [{ title: 'Alice Post 2', views: 150 }, …] }
```

```sql
SELECT "users"."username" as "username", (SELECT avg("posts"."views")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "avgViews", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "totalPosts", (SELECT COALESCE(SUM("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "totalViews", (SELECT COALESCE(MAX("lateral_2_posts"."views"), null)
FROM "posts" "lateral_2_posts"
WHERE "lateral_2_posts"."user_id" = "users"."id") as "maxViews", COALESCE("lateral_3".data, '[]'::json) as "recentPosts",
  COALESCE("lateral_4".data, '[]'::json) as "topPosts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_3_posts"."title" as "title", "lateral_3_posts"."views" as "views"
  FROM "posts" "lateral_3_posts"
  WHERE "lateral_3_posts"."user_id" = "users"."id"
  ORDER BY "lateral_3_posts"."published_at" DESC, "lateral_3_posts"."id" DESC
  LIMIT 5
) sub) "lateral_3" ON true
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_4_posts"."title" as "title", "lateral_4_posts"."views" as "views"
  FROM "posts" "lateral_4_posts"
  WHERE "lateral_4_posts"."user_id" = "users"."id"
  ORDER BY "lateral_4_posts"."views" DESC
  LIMIT 5
) sub) "lateral_4" ON true
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]
```

To add independent reads (the user's orders, a global count) without another round trip, put this query and
the others in a [`QueryBatch`](#read-several-independent-results-in-one-round-trip-querybatch).

<a id="querybatch-several-reads-in-one-round-trip"></a><a id="what-a-batched-query-reads"></a><a id="known-limitations-of-the-json-transport"></a>

## Read several independent results in one round trip: `QueryBatch`

`QueryBatch` runs independent reads of one context — lists (`addList`), first rows (`addFirstOrDefault`) and
counts (`addCount`) of selects, grouped queries and unions (a union as a first row or a count since 1.0.31) — as
ONE `UNION ALL` statement of per-query JSON envelopes; each read is planned on its own and reads back the values it
reads on its own. A union's count counts its own `LIMIT` / `OFFSET`, as its `count()` does; a select's or a grouped
query's count leaves them out. A union whose legs declare a data-modifying CTE is refused as a first row or a
count ([details](./batching-and-prepared-queries.md#count-a-union-or-read-its-first-row-in-a-batch)). Every leg
must run on the same context: a leg with an executor of its own (`withTimeout()`,
`withPreparedStatements()`, `expectedExecutionTime()`) is refused — set prepared-statement use for the whole
statement with `batch.withPreparedStatements(bool)`. A batch executes once: `executeBatch()` twice, or `add*()`
after it, throws. Rules, futures and `FutureQueryRunner`:
[Batching and prepared queries](./batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch);
what a batched query reads: [Get the values the query reads on its own](./batching-and-prepared-queries.md#get-the-values-the-query-reads-on-its-own)
and the JSON transport's [known limitations](./batching-and-prepared-queries.md#known-limitations-of-the-json-transport).

```ts
const reads = new QueryBatch();
const postsKey = reads.addList(db.posts.where(p => eq(p.userId, 1)).select(p => ({ id: p.id, title: p.title })), 'posts');
const userKey = reads.addFirstOrDefault(db.users.where(u => eq(u.id, 1)).select(u => ({ id: u.id, username: u.username })), 'user');
const ordersKey = reads.addCount(db.orders.where(o => eq(o.userId, 1)), 'orders');
await reads.executeBatch();
reads.getList(postsKey);     // { id: number; title: string }[]
reads.getItem(userKey);      // { id: number; username: string } | null
reads.getCount(ordersKey);   // number
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" = $1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $2
LIMIT 1
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count
FROM "orders"
WHERE "orders"."user_id" = $3
) __batch_q
-- params: [ 1, 1, 1 ]
```

<a id="prepared-statements"></a>

## Build a query once, run it with new values: `prepare()`

`.prepare(name)` with `sql.placeholder(name)` values builds the SQL once in your process; each
`execute(params)` sends it with the placeholder values (every other value keeps the value it had at
`prepare()` time). It bypasses the context's executor: no logging, slow-query callback or timeout, and it is
always sent UNNAMED, even on a `preparedStatements: true` context — server-side named statements come from that
option and `withPreparedStatements()` on ordinary builders. Placeholders in collections and subqueries, the
`PreparedQuery` utilities and the trade-offs:
[Build a query once and execute it many times](./batching-and-prepared-queries.md#build-a-query-once-and-execute-it-many-times-prepare).

```ts
const userById = db.users
  .where(u => eq(u.id, sql.placeholder('userId')))
  .select(u => ({ id: u.id, username: u.username }))
  .prepare<{ userId: number }>('userById');

const first = await userById.execute({ userId: 1 });    // [{ id: 1, username: 'alice' }]
const second = await userById.execute({ userId: 2 });   // [{ id: 2, username: 'bob' }]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
-- params: [ 1 ]

SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
-- params: [ 2 ]
```

## Pitfalls

- **Don't** call `any()`, `none()`, `single()`, `db.posts.join()`, a select builder's `toSql()`, `db.posts.sum()` /
  `avg()`, a collection's `avg()`, or import `sum` / `min` / `max` / `avg` / `cte` / `SqlFormatter` → **Do** use
  `exists()`, `!(await q.exists())`, `limit(2).toList()`, `innerJoin()` / `leftJoin()`, `future().getSql()`,
  `agg.*` or `select(…).sum()`, and `new DbCteBuilder()`. None of the former exist; most are compile errors.
- **Don't** reuse a builder after `first()` / `firstOrDefault()` / `firstOrThrow()` → **Do** build it in a
  function. They leave `LIMIT 1` on the builder.
- **Don't** branch two queries off one `where()` result → **Do** build the base in a function. `base.where(x)`
  returns `base` itself, now filtered by `x`.
- **Don't** pass an unset filter value to `eq()` / `ne()` → **Do** skip the condition. `eq(col, undefined)`
  renders `IS NULL`; `gt()` & co. throw; `between()` binds NULL and returns no rows.
- **Don't** spread a possibly empty condition list into `or()` → **Do** check its length. `or()` of nothing renders
  `WHERE 1=1` and matches every row.
- **Don't** filter a projected `sql` expression after `select()` → **Do** filter before `select()`. WHERE cannot
  see the output alias: `column "loud" does not exist`.
- **Don't** `count()` a paged or DISTINCT query to count its rows → **Do** use `countOver()`, a `QueryBatch`
  count, or count a CTE. `count()` ignores LIMIT, OFFSET and DISTINCT.
- **Don't** trust `countOver()`'s total on a page past the end → **Do** use a `QueryBatch` with `addList()` +
  `addCount()`. The total is read from the first row, so an empty page reports 0.
- **Don't** call `firstOrThrow()` on a one-value select whose value can be `false`, `0`, `''` or `null` → **Do**
  select an object. It throws `No results found` for a row that exists.
- **Don't** pass request input to `limit()` / `offset()` unvalidated → **Do** coerce it to an integer. The values
  are inlined: `'1 OFFSET 2'` rendered `LIMIT 1 OFFSET 2`.
- **Don't** build LIKE patterns from raw input → **Do** escape `\`, `%` and `_` first. `containsSearch('_')`
  matched every row.
- **Don't** read `user.posts` from an entity row or loop one query per parent → **Do** project a collection.
  Navigation properties are never loaded; a collection costs no extra round trip.
- **Don't** compare an optional navigation's column expecting rows without the related row → **Do** add
  `or(…, isNull(fk))`. NULL matches nothing, so those rows drop out.
- **Don't** expect `decimal` / `numeric` / `bigint` columns as numbers at the top level → **Do** convert them or
  use `agg.sum()`. node-postgres delivers `'99.99'`; the builder's `sum()` returns `'450'`.
- **Don't** list union legs' keys in different orders → **Do** write every leg in the same order. Legs match by
  position and silently swap same-typed values.
- **Don't** register one paged union for both `addList()` and `addCount()` of a `QueryBatch` expecting the total →
  **Do** count the union without its `limit()` / `offset()`. A union's count counts them (a select's ignores them).
- **Don't** compare a mapped column of a collection's item with its stored value (`eq(p.publishTime, 570)`) →
  **Do** pass the application value (`{ hour: 9, minute: 30 }`). Since 1.0.31 it is bound through `toDriver`, and
  the stored value becomes `NaN` (`invalid input syntax for type smallint: "NaN"`).
- **Don't** map a collection's `min()` / `max()` of a mapped column by hand → **Do** read it as it comes: since
  1.0.31 it arrives mapped. A CTE or table-subquery column computed from it still holds the stored value.
- **Don't** put an aggregate next to a plain column without `groupBy()` → **Do** group by the column. PostgreSQL
  rejects it (`must appear in the GROUP BY clause`).
- **Don't** read a grouped `sql` expression over aggregates without a mapper → **Do** add `.mapWith(Number)`. It
  reads the driver's string (`'125'`).
- **Don't** pass `inArrayOptThreshold` / `inArrayPadBuckets` / `inArrayUsesOpt` to one context expecting isolation →
  **Do** set them once at startup through `LinkgressConfig`. They are process-wide.
- **Don't** use `notInArray()` / `neAll()` / `notInSubquery()` over values that may be NULL → **Do** use
  `notExists()`. One NULL makes NOT IN return no row.
- **Don't** read codes such as `'007'` with `jsonbSelectText()` → **Do** use `jsonbPathText()`. The former reads
  the number 7.
- **Don't** rely on `withTimeout()` with PgClient, BunClient or PGlite → **Do** set `statement_timeout` on the
  pool or use `db.transaction(fn, { timeoutMs })`. Only PostgresClient honours it; PGlite cannot cancel a
  statement at all.

## See also

- [Choosing the right query](../choosing-the-right-query.md) — when you know the data you need but not the API: need → API → SQL shape → round trips.
- [Batching and prepared queries](./batching-and-prepared-queries.md) — when a screen needs several independent reads in one round trip (`QueryBatch`, futures) or a hot query should be built once (`PreparedQuery`).
- [Collection strategies](../collection-strategies.md) — when collection reads are slow or you choose between `lateral`, `cte` and `temptable`.
- [Lateral navigation joins](./lateral-navigation-joins.md) — when few rows read through a foreign key into a large table and the planner picks a whole-index join (`lateralJoin()`).
- [Subquery guide](./subquery-guide.md) — when a filter or value comes from another query: `exists`, `inSubquery`, scalar subqueries, `eqAnySubquery`, `asExpression()`.
- [Aliased scopes](./aliased-scopes.md) — when a correlated subquery reads the same table as the outer query (`db.<table>.as(alias)`).
- [CTE guide](./cte-guide.md) — when a derived set is read several times, is the query root, or writes rows (data-modifying CTEs).
- [Set-returning functions](./set-returning-functions.md) — when JS arrays or JSON arrays should become rows: `unnest`, `fromSet`, `selectFromSet`, `unnestRows` / `fromRows` (since 1.0.29).
- [SQL expression helpers](./sql-expressions.md) — when a projection or condition needs casts, CASE, string, date, JSONB or array functions, `agg` or `win`.
- [Inserts, updates and deletes](./insert-update-guide.md) — when the task writes rows: inserts, upserts, bulk writes, transactions.
- [Schema configuration](./schema-configuration.md) — when you declare entities, relations, indexes (`ixNormalized`), custom types or views.
- [Configuration](./configuration.md) — when you need an option's default or scope: logging, prepared statements, timeouts, `LinkgressConfig`.
- [API index](../api-index.md) — when you look up one export or builder method.
