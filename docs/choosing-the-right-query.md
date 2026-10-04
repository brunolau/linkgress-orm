# Choosing the Right Query

> **For agents:** Which linkgress-orm call reads or writes the data a task needs in the fewest statements, and what SQL does it send?
> **Use this page when:** you know what data a task needs but not which call gets or changes it; before writing a loop that awaits a query or a write per row; when reviewing data-access code for extra round trips. **Look elsewhere when:** you know the call and need all its options → the guide linked in each table row, or the [API index](./api-index.md); setting up a project → [Getting Started](./getting-started.md)
> **Key APIs:** `select()`, `firstOrDefault()`, `exists()`, `count()`, `agg`, `groupBy()`, navigations (`p.user!.username`), collections (`u.posts!.select(…).toList()`), `joinFilter()`, `asSubquery()`, `QueryBatch`, `prepare()` / `preparedStatements`, `inArrayOpt()`, `eqAny()`, `insertBulk()`, `fromRows()`, `upsertBulk()` (`updateWhere`), `bulkUpdate()`, `.returning()`, `MutationBatch`, `db.transaction()` · **Round trips:** every call this page recommends is 1 statement; costs above that are named where they occur (`db.transaction()` adds BEGIN and COMMIT, the `temptable` collection strategy sends 1 + 5 statements per collection on `PgClient`)

This page is the entry point for AI coding agents that read or write data with linkgress-orm. Start with the
[golden rules](#golden-rules), look the need up in the [reading](#reading-data-decision-table) or
[writing](#writing-data-decision-table) decision table, then copy the matching [recipe](#recipes): each one shows the
efficient call, the SQL it sends, the tempting alternative and what that alternative cost.

The examples use `db`, the example model `AppDatabase`, seeded with the users `alice`
(age 25), `bob` (35) and `charlie` (45, inactive); alice wrote two posts (100 and 150 views), bob one (200 views),
charlie none. Every table, column, relation and seed row: [Example Model and Seed Data](./example-model.md). Every SQL block was captured on the in-memory PostgreSQL-compatible database through `PgClient`: each
statement is one round trip and `$n` are bound parameters. Timings come from the benchmarks in `bench/`, run on
PostgreSQL. On `PostgresClient` an unnamed statement with parameters costs two network round trips (Parse/Describe,
then Bind/Execute), so each such statement a recipe saves is two round trips there
([Database clients](./database-clients.md#round-trips-and-performance-per-client)).

```ts
// fragment: how the examples build `db`
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './schema/appDatabase'; // the example model

const client = new PgClient({ connectionString: process.env.DATABASE_URL });
const db = new AppDatabase(client);
```

## Contents

- [Golden rules](#golden-rules)
- [Reading data: decision table](#reading-data-decision-table)
- [Writing data: decision table](#writing-data-decision-table)
- [Recipes](#recipes)
  - [Load each row's children in one statement: collections](#load-each-rows-children-in-one-statement-collections)
  - [Read a related row's columns: navigations](#read-a-related-rows-columns-navigations)
  - [Count, test existence and total without loading rows: `count()`, `exists()`, `agg`](#count-test-existence-and-total-without-loading-rows-count-exists-agg)
  - [Aggregate per parent row: collection `count()` and `sum()`](#aggregate-per-parent-row-collection-count-and-sum)
  - [Compute statistics per key: `groupBy()` and `having()`](#compute-statistics-per-key-groupby-and-having)
  - [Read a page and its total in one statement](#read-a-page-and-its-total-in-one-statement)
  - [Read several independent results in one round trip: `QueryBatch`](#read-several-independent-results-in-one-round-trip-querybatch)
  - [Run one query shape many times: pick the tool by client](#run-one-query-shape-many-times-pick-the-tool-by-client)
  - [Filter by rows of another table: `exists()` and `inSubquery()`](#filter-by-rows-of-another-table-exists-and-insubquery)
  - [Match a list of values: `inArrayOpt()` and `eqAny()`](#match-a-list-of-values-inarrayopt-and-eqany)
  - [Keep the top N rows per parent or per group](#keep-the-top-n-rows-per-parent-or-per-group)
  - [Insert many rows: `insertBulk()` and `fromRows()`](#insert-many-rows-insertbulk-and-fromrows)
  - [Insert rows the database computes: `insertFrom()`](#insert-rows-the-database-computes-insertfrom)
  - [Insert or skip, insert or update: `onConflictDoNothing` and `upsertBulk()`](#insert-or-skip-insert-or-update-onconflictdonothing-and-upsertbulk)
  - [Update many rows: `eqAny()` and `bulkUpdate()`](#update-many-rows-eqany-and-bulkupdate)
  - [Read back what a write changed: `.returning()` and `.affectedCount()`](#read-back-what-a-write-changed-returning-and-affectedcount)
  - [Insert a parent and its children: `insertWithChildren()`](#insert-a-parent-and-its-children-insertwithchildren)
  - [Write several independent changes in one round trip: `MutationBatch`](#write-several-independent-changes-in-one-round-trip-mutationbatch)
  - [Read and write inside a transaction: `tx.<table>`](#read-and-write-inside-a-transaction-txtable)
- [See the SQL a query emits](#see-the-sql-a-query-emits)
- [Collection strategies at a glance](#collection-strategies-at-a-glance)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Golden rules

Each rule names the anti-pattern it prevents and the difference measured on the example data (statements are round
trips).

1. **Read related rows in the same statement.** A navigation (`p.user!.username`) or a collection
   (`u.posts!.select(…).toList()`) inside `select()` replaces a query per row (N+1). Measured: 3 users with their
   posts, 1 statement instead of 4; 3 posts with their author's name, 1 instead of 4. Entity rows from `toList()` never
   carry navigations: there is no lazy and no eager loading.
2. **Ask the database for the answer, not for the rows.** `count()`, `exists()`, one `agg` select and `groupBy()`
   replace `(await q.toList()).length`, `count() > 0`, the builder's `sum()` / `min()` / `max()` and grouping in JS.
   Measured: `count()` returned 1 row of 1 column where `toList().length` read 2 rows of 8 columns; a count, a sum, a
   minimum, a maximum and a filtered count came back in 1 statement, where `sum()`, `min()` and `max()` took 3
   statements and returned the sum as the string `'450'`.
3. **Select only the columns you use.** `select(u => ({ id: u.id, username: u.username }))` replaces entity rows read
   for two fields. Measured: 2 columns per row instead of the 8 of `users`, in the same 1 statement.
4. **Batch independent reads.** `QueryBatch` (`addFirstOrDefault()`, `addList()`, `addCount()`, `executeBatch()`)
   replaces N awaited reads. Measured: a user, their posts and their order count in 1 statement instead of 3;
   `bench/querybatch` (raw statements of that shape through postgres.js), 12 reads over a ~31 ms round trip: 62 ms as
   one statement, 743 ms awaited one by one, 110 ms with `Promise.all` on a pool of 10.
5. **Read a page and its total in one statement.** `QueryBatch` with `addList(page)` + `addCount(page)` (or
   `countOver()` when the page always exists) replaces `Promise.all([page.toList(), q.count()])`. Measured: 1 statement
   instead of 2; past the last page `countOver()` returned `{ data: [], totalCount: 0 }`, the batch the right total, 3.
6. **Never fetch keys to send them back.** Embed the query that computes them: `inSubquery()`, `exists()`, a
   navigation, `insertFrom()`. Measured: the posts of active users in 1 statement instead of 2; the next sort position
   inserted in 1 statement instead of 2 (read the maximum, then insert).
7. **Match lists with a bounded number of statement texts.** `inArrayOpt()` for data-driven lists, `eqAny()` for one
   text at any length, replace a query per value and `inArray()` with lists of varying length. Measured: 3 ids in 1
   statement instead of 3; `inArray()` with 1, 2 and 3 ids sent 3 different texts, while `eqAny()` binds 1 array
   parameter for any length.
8. **Write a set in one statement.** `insertBulk()`, `bulkUpdate()`, `where(r => eqAny(r.id, ids)).update()` and
   `insertFrom()` replace an awaited write per row. Measured: 3 inserts in 1 statement instead of 3; 3 updates by id in 1
   instead of 3; 2 rows with their own values in 1 instead of 2.
9. **Let a unique index decide insert-or-skip and upsert.** `insertBulk(rows, { onConflictDoNothing: true })` and
   `upsertBulk(rows, { primaryKey, updateColumns })` replace check-then-write, which a concurrent writer passes (23505).
   Measured, 2 incoming rows: insert-or-skip in 1 statement instead of 3, upsert in 1 instead of 4.
10. **Read back what a write changed in the same statement.** `.returning(selector)` and `.affectedCount()` replace a
    SELECT after the write. Measured: 1 statement instead of 2, for an update and for an insert's generated key.
11. **Send independent writes as one `MutationBatch`.** It replaces awaited writes, each a statement and a commit of its
    own. Measured: an insert, a bulk update and a delete in 1 atomic statement instead of 3.
12. **Keep the default `lateral` collection strategy and index the foreign keys collections read.** It avoids the
    `temptable` strategy and child lookups without an index. Measured: one collection, 1 statement under `lateral` and
    `cte`, 6 under `temptable` on `PgClient`; `bench/versions` (1.0.17), 100 of 2,000 users with four collection
    reads: 1.32 ms under `lateral`, 6.51 ms under `cte`.

## Reading data: decision table

Every row is one statement unless its **SQL shape · round trips** cell says otherwise (the number after the `·`). The
**Avoid** column is the slower or wrong pattern the **Use** column replaces; the **Need** cell links to the guide
section with every option of the call.

### Rows, existence and counts

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [One row by key](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first) | `where(u => eq(u.id, id)).select(…).firstOrDefault()` | `… WHERE "users"."id" = $1 LIMIT 1` · 1 | `(await q.toList())[0]`: no LIMIT, every column; builder `first()`, which returns `null` although typed non-null |
| [One row, an error when it is missing](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first) | `select(…).firstOrThrow()` | `… LIMIT 1` · 1 | a one-value select whose value can be `false`, `0`, `''` or `null` (it throws for an existing row) |
| [Whether any row matches](./guides/querying.md#check-whether-rows-exist-exists) | `exists()` | `SELECT EXISTS(SELECT 1 FROM "users" WHERE …)` · 1 | `count() > 0`; `any()` / `none()`, which do not exist |
| [How many rows match](./guides/querying.md#count-rows-without-loading-them-count) | `count()` | `SELECT COUNT(*) as count FROM "users" WHERE …` · 1 | `(await q.toList()).length`; `count()` of a paged or DISTINCT query (it ignores LIMIT, OFFSET and DISTINCT) |
| [How many distinct values](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg) | `select(p => ({ n: agg.countDistinct(p.userId) })).firstOrDefault()` | `SELECT count(DISTINCT "posts"."user_id") as "n" FROM "posts" LIMIT 1` · 1 | `selectDistinct(…).count()`: it counts every row (3 instead of 2) |
| [Some columns of the matching rows](./guides/querying.md#select-only-the-columns-you-need-select) | `where(…).select(u => ({ id: u.id, username: u.username })).toList()` | `SELECT "users"."id" as "id", "users"."username" as "username" FROM "users" WHERE …` · 1 | entity rows read for a few fields (all 8 columns of `users`) |
| [Whole entity rows](./guides/querying.md#read-whole-rows-tolist) | `where(…).toList()` | `SELECT "users"."id" as "id", "users"."username" as "username", …` (all 8 columns) `FROM "users" WHERE "users"."is_active" = $1` · 1 | filtering or counting the rows in JS |
| [Unique values](./guides/querying.md#return-unique-rows-selectdistinct) | `db.orders.selectDistinct(o => ({ status: o.status }))` | `SELECT DISTINCT "orders"."status" as "status" FROM "orders"` · 1 | an ORDER BY on a column the projection lacks (PostgreSQL rejects it) |
| [Rows matching optional filters](./guides/querying.md#build-a-query-from-optional-filters) | `let q: IEntityQueryable<User> = db.users;` then `q = q.where(…)` per present filter | `WHERE ("users"."age" >= $1 AND "users"."is_active" = $2)` · 1 | `eq(c, filter.value)` with an unset value (renders `IS NULL`); two queries branched off one builder (builders are mutable) |
| [Text search](./guides/querying.md#search-text-patterns-regular-expressions-accent-insensitive) | `ilike(p.title, containsSearch('alice'))`, `startsWith()`, `normalizedEq()` | `"posts"."title" ILIKE $1` with `'%alice%'` · 1 | an unindexed `ILIKE '%x%'` on a large table (needs a pg_trgm GIN index); user input with `%` and `_` unescaped; `normalizedEq()` without an `ixNormalized` index or `model.useSearchNormalize()` (the SQL function it calls does not exist then) |

### Pages

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [A page of rows](./guides/querying.md#page-through-results) | `orderBy(…).offset(n).limit(m)` | `ORDER BY "username" ASC LIMIT 2 OFFSET 2` (inlined literals) · 1 | an unordered page; request input passed to `limit()` / `offset()` unvalidated (the values are inlined) |
| [A deep page (infinite scroll)](./guides/querying.md#deep-pages-keyset-pagination) | keyset: `where(u => gt(u.id, lastId)).orderBy(u => u.id).limit(m)` | `WHERE "users"."id" > $1 ORDER BY "id" ASC LIMIT 2` · 1 | a large `offset()`: PostgreSQL reads and discards every skipped row |
| [A page and the total count](./guides/batching-and-prepared-queries.md#load-a-page-and-its-total-count-in-one-round-trip) | `QueryBatch`: `addList(page)` + `addCount(page)` on the same builder | one `UNION ALL`: the page leg and a `SELECT COUNT(*) as count …` leg · 1 | `Promise.all([page.toList(), q.count()])` (2); `countOver()` when the page can be empty |
| [A page and the total, the page always exists](./guides/querying.md#a-page-and-the-total-in-one-round-trip) | `countOver()` → `{ data, totalCount }` | `COUNT(*) OVER() as "__countOver"` beside the page columns · 1 | a page past the end: `totalCount` is read from the first row, so it reports 0 |

### Related rows

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [A referenced row's columns](./guides/querying.md#read-a-related-rows-columns-navigations) | a navigation in `select()` / `where()` / `orderBy()`: `p.user!.username` | `INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"` (required relation), `LEFT JOIN` (optional) · 1 | a lookup per row (1 + N); a second query with the collected ids (2); `innerJoin()` repeating a modeled foreign key |
| [A referenced row for FEW rows of a LARGE target](./guides/lateral-navigation-joins.md#decide-whether-a-navigation-needs-the-probe) | `lateralJoin(p => p.user)` (since 1.0.23) | `INNER JOIN LATERAL (SELECT "user__probe".* FROM "users" "user__probe" WHERE "user__probe"."id" = "posts"."user_id" OFFSET 0) "user" ON true` · 1 | `lateralJoin()` on a navigation the WHERE filters by, or for thousands of rows (one index probe per row) |
| [Each row's children](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections) | a collection: `u.posts!.select(p => ({ … })).toList()` | `lateral`: `LEFT JOIN LATERAL (SELECT json_agg(json_build_object(…)) …)`; `cte`: `WITH "cte_0" AS (… GROUP BY …)`; `temptable`: the base query, then a temp table per collection · `lateral` 1, `cte` 1, `temptable` 1 + 5 per collection on `PgClient` (compare: [strategies](#collection-strategies-at-a-glance)) | a query per parent (N+1); `toList()` without `select()` (every column of the child as JSON) |
| [One value per child](./guides/querying.md#value-lists-and-one-child-per-parent) | `u.posts!.select(p => p.id).toNumberList()` / `toStringList()` | `(SELECT COALESCE(array_agg("lateral_0_posts"."id"), '{}') FROM "posts" "lateral_0_posts" WHERE …)` · 1 | objects when ids are enough |
| [The first N children of each parent](./guides/querying.md#filter-order-and-limit-each-parents-children) | `u.posts!.orderBy(…).limit(n).select(…).toList()` | `ORDER BY "lateral_0_posts"."views" DESC LIMIT 1` inside each parent's LATERAL · 1 | loading every child and slicing in JS |
| [One related object per parent (the top post, the latest order)](./guides/querying.md#value-lists-and-one-child-per-parent) | `u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ title: p.title, views: p.views })).firstOrDefault()`: an object, or `null` without a child | `LEFT JOIN LATERAL (SELECT json_build_object('title', "title", 'views', "views") as data FROM (… ORDER BY "lateral_0_posts"."views" DESC LIMIT 1) sub)` · 1 | one scalar subquery per column of the same row (a probe each); an unordered pick; `toList()` and `[0]` in JS (every child travels) |
| [Many-to-many](./guides/querying.md#many-to-many-and-grandchildren-selectmany) | the join entity's navigation: `p.productTags!.select(pt => pt.tag!.name).toList()` | `FROM "product_tags" "lateral_0_productTags" LEFT JOIN "tags" "tag" …` inside a LATERAL · 1 | two queries joined in JS |
| [Grandchildren, flattened](./guides/querying.md#many-to-many-and-grandchildren-selectmany) | `u.posts!.selectMany(p => p.postComments!).count()` | `INNER JOIN "posts" "posts__bridge1" ON …` inside one subquery · 1 | nested lists flattened in JS |
| [A count, sum, min or max per parent](./guides/querying.md#count-sum-min-and-max-per-parent) | `u.posts!.count()`, `.sum(p => p.views)`, `.min(…)`, `.max(…)`, `.exists()` | `lateral`: `(SELECT COALESCE(COUNT(*), 0) FROM "posts" "lateral_0_posts" WHERE "lateral_0_posts"."user_id" = "users"."id")`, one subquery per aggregate · 1 | a `count()` per parent (1 + N); loading lists to count them; a collection `avg()` (it does not exist) |
| [Several aggregates per parent, for many or all parents](./guides/querying.md#join-per-key-aggregates-computed-once) | one grouped subquery joined once: `leftJoin(grouped.asSubquery('table'), on, select, 'stats')` | `LEFT JOIN (SELECT … GROUP BY "posts"."user_id") AS "stats" ON "users"."id" = "stats"."userId"` · 1 | one correlated subquery per aggregate, each reading the children again |
| [Columns of an unmodeled relation](./guides/querying.md#join-tables-without-a-navigation-innerjoin-leftjoin) | `innerJoin(db.posts, on, select)` / `leftJoin(…)` | `INNER JOIN "posts" AS "posts_0" ON "users"."id" = "posts_0"."user_id"` · 1 | a 1:N join where one row per parent is wanted (it repeats the parent per match) |
| [One value per row from a table no navigation reaches](./guides/subquery-guide.md#project-a-per-row-value-a-scalar-subquery-in-select) | a scalar subquery in `select()`: `product: db.products.where(p => eq(p.id, ci.productId)).select(p => p.name).asSubquery('scalar')` (`cartItems.productId` has no navigation); inside `coalesce()`, arithmetic or an order key: `.asSubquery('scalar').asExpression<T>()` | `(SELECT "products"."name" FROM "products" WHERE "products"."id" = "cart_items"."product_id") as "product"` · 1 | a lookup per row (1 + N); a subquery that can return 2+ rows (fails with 21000: aggregate, or `orderBy()` + `limit(1)`); a hand-built subquery where a navigation or a collection aggregate exists |
| [A probe over the row's own table](./guides/aliased-scopes.md#test-for-another-row-of-the-same-table-exists) | an aliased scope: `db.posts.as('rival').where(…).exists()` | `EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE ("rival"."user_id" = "posts"."user_id" AND …))` · 1 | `db.posts.where(…).asSubquery()` correlated to `posts` (refused) |

### Aggregates, groups and ranks

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [Several totals of one set](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg) | `select(p => ({ posts: agg.count(), totalViews: agg.sum(p.views), … })).firstOrDefault()` | `SELECT count(*) as "posts", sum("posts"."views") as "totalViews", … count(*) FILTER (WHERE …) … LIMIT 1` · 1 | the builder's `sum()` / `min()` / `max()`: 1 statement each, raw driver values (`'450'`) |
| [Statistics per key](./guides/querying.md#group-rows-groupby) | `select(…).groupBy(r => ({ userId: r.userId })).select(g => ({ … }))` | `… GROUP BY "posts"."user_id"` · 1 | loading every row and grouping in JS |
| [Only the groups that pass a condition](./guides/querying.md#filter-groups-having) | `.having(g => gt(g.count(), 1))` | `HAVING COUNT(*) > $1` · 1 | filtering groups in JS; row conditions in `having()` (put them in `where()` before `select()`) |
| [Statistics per day, month or another expression](./guides/querying.md#group-by-a-column-a-navigation-or-an-expression) | `.groupBy(r => ({ day: dateTrunc('day', r.publishedAt) }))` | `FROM (SELECT date_trunc('day', "posts"."published_at") as "day", "posts"."views" as "__arg0" FROM "posts") "q1" GROUP BY "day"` · 1 | loading the rows and bucketing them in JS |
| [A conditional count or sum per group](./guides/querying.md#aggregates-per-group) | `g.sum(r => caseWhen(eq(r.status, 'completed'), 1).else(0))` | `SUM(CASE WHEN "orders"."status" = $1 THEN CAST($2 AS integer) ELSE CAST($3 AS integer) END)` · 1 | one grouped query per status; `agg.*` over a non-key column inside a grouped select (only `g.key` is readable there) |
| [A list of child rows per key](./guides/cte-guide.md#attach-child-rows-as-a-json-array-per-key-withaggregation) | through a navigation: a collection (`u.posts!.select(…).toList()`); without one: `new DbCteBuilder().withAggregation(name, query, keySelector, 'posts')`, read with `db.selectFromCte(cte)` or joined with `leftJoin(cte, …)` | `WITH "posts_by_user" AS (SELECT "userId", json_agg(json_build_object('id', "id", 'title', "title")) as "posts" … GROUP BY "userId")` · 1 | a query per key; `agg.arrayAgg()` of a non-key column in a grouped select (the group exposes only `g.key` and `count()` / `sum()` / `avg()` / `min()` / `max()`) |
| [Row numbers or ranks](./guides/querying.md#number-and-rank-rows-window-functions) | `win.rowNumber()`, `win.rank()`, `win.denseRank()` with `.over({ partitionBy, orderBy })` (since 1.0.21) | `row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY …)` · 1 | numbering rows in JS |
| [The top N rows of each group, as flat rows](./guides/cte-guide.md#keep-the-top-n-rows-per-group-rank-in-a-cte) | a window value in a CTE body, filtered where the CTE is read | `WITH "ranked_posts" AS (… row_number() OVER (…) as "rank" …) SELECT … WHERE "ranked_posts"."rank" <= $1` · 1 | `where()` on the window value in the query that computes it (throws before sending) |

### Filters by other rows and by lists

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [Rows that have related rows](./guides/querying.md#filter-or-order-parents-by-their-children) | `where(u => exists(u.posts!.where(…)))` | `WHERE EXISTS (SELECT 1 FROM "posts" WHERE "posts"."user_id" = "users"."id" AND …)` · 1 | a join to the children (it returned alice twice) |
| [Rows without related rows](./guides/subquery-guide.md#keep-rows-without-related-rows-notexists) | `where(u => notExists(u.posts!))` | `WHERE (NOT EXISTS (SELECT 1 FROM "posts" WHERE "posts"."user_id" = "users"."id"))` · 1 | `notInSubquery()` / `notInArray()` over values that may be NULL: one NULL makes NOT IN return no row |
| [Rows whose key another query computes](./guides/subquery-guide.md#filter-by-keys-another-query-computes-insubquery) | `inSubquery(p.userId, db.users.where(…).select(u => u.id).asSubquery('array'))` | `"posts"."user_id" IN (SELECT "users"."id" FROM "users" WHERE …)` · 1 | fetching the ids, then querying by them (2) |
| [The same, a short uncorrelated list and an indexed outer column](./guides/subquery-guide.md#match-against-one-array-eqanysubquery--neallsubquery) | `eqAnySubquery(p.userId, db.users.where(…).select(u => u.id).asSubquery('array'))` | `("posts"."user_id" = ANY (ARRAY(SELECT "users"."id" FROM "users" WHERE "users"."is_active" = $1)))`: the list collected once · 1 | a correlated subquery here (one array per outer row: use `exists()`); a large result (one array in memory: use `inSubquery()`) |
| [Filter by another table, keep the row shape](./guides/querying.md#filter-by-a-joined-table-joinfilter-leftjoinfilter) | `joinFilter(db.users, (p, u) => eq(p.userId, u.id), (p, u) => eq(u.isActive, true))`; rows WITHOUT a match: `leftJoinFilter(db.posts, (u, p) => eq(u.id, p.userId), (u, p) => isNull(p.id))` | `INNER JOIN "users" AS "users_0" ON "posts"."user_id" = "users_0"."id" WHERE "users_0"."is_active" = $1` · 1 | a right side with several rows per left row (it repeats the left row: use `exists()` / `notExists()`) |
| [Rows whose key is in a large computed candidate set](./guides/cte-guide.md#drive-a-query-from-a-candidate-set-joinfilter-and-materialized-true) | `new DbCteBuilder().with('candidates', query, { materialized: true })`, then `joinFilter(candidates.cte, (u, c) => eq(u.id, c.id))` | `WITH "candidates" AS MATERIALIZED (…) … INNER JOIN "candidates" ON "users"."id" = "candidates"."id"` · 1 | fetching the ids first (2); a candidate CTE with several rows per key (duplicates) |
| [Compare a column with an aggregate or a looked-up value](./guides/subquery-guide.md#compare-a-column-with-a-computed-value) | `where(p => gt(p.views, db.posts.select(x => agg.avg(x.views)).asSubquery('scalar')))`; also `gtSubquery()`, `eq()`, `lt()` … with a `'scalar'` subquery | `WHERE "posts"."views" > (SELECT avg("posts"."views") FROM "posts")` · 1 | reading the value first, then filtering (2) |
| [A data-driven list of values (the default)](./guides/querying.md#letting-the-list-length-decide-inarrayopt--notinarrayopt) | `inArrayOpt(u.id, ids)` | up to 8 values `"users"."id" IN ($1, $2, $3)`, above `("users"."id" = ANY($1::integer[]))` · 1 | a query per value; `inArray()` with lists of varying length (one statement text per length) |
| [One statement text for any list length, or a long list](./guides/querying.md#one-parameter-for-every-length-eqany--neall) | `eqAny(u.id, ids)` | `("users"."id" = ANY($1::integer[]))` with `'{1,2,3}'`: 1 parameter · 1 | `inArray()` with thousands of values: one parameter each, at most 65,535 per statement (32,767 on PGlite) |
| [A short constant list](./guides/querying.md#exact-placeholders-inarray--notinarray) | `inArray(u.id, [1, 2, 3])` | `"users"."id" IN ($1, $2, $3)` · 1 | data-driven lists |
| [Rows matching a list of composite keys (tuples)](./guides/set-returning-functions.md#match-rows-against-a-list-of-composite-keys-join-fromrows) | `innerJoin(fromRows(db.orderTasks, keys, { columns: ['orderId', 'taskId'], alias: 'k' }).asSubquery('table'), (ot, k) => and(eq(ot.orderId, k.orderId), eq(ot.taskId, k.taskId)), select, 'keys')` (since 1.0.29) | `INNER JOIN (SELECT … FROM unnest(CAST($1 AS integer[]), CAST($2 AS integer[])) AS "k"("orderId", "taskId")) AS "keys" ON (…)`: 1 parameter per column · 1 | `or(...keys.map(k => and(eq(…), eq(…))))`: 2 parameters per key, a text that grows with the list |
| [Rows whose jsonb document holds given keys and values](./guides/sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome) | `jsonbContains(u.metadata, { genre: 'poetry' })` | `("users"."metadata" @> CAST(CAST($1 AS text) AS jsonb))` · 1 | loading the documents and filtering in JS; `jsonbPathExists()` where containment is enough (a GIN index serves `@>`, not the function) |
| [Rows with a jsonb array element that matches several conditions](./guides/sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome) | `jsonbArraySome<Item>(o.items, it => and(eq(it.productName, 'Book'), …))`; element values compare as text, so pass numbers through `jsonbConditionUnwrap()` | `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("orders"."items") = 'array' …) AS __elem WHERE …)` · 1 | loading the documents and filtering in JS; for an exact element match, `jsonbContains(col, [{ productName: 'Book' }])` is GIN-indexable |
| [An array of JS rows as a relation (to read, join, anti-join or insert)](./guides/set-returning-functions.md#decide-which-function-which-source) | rows shaped like a table's: `db.selectFromSet(unnestRows(table, rows, columns), alias)`, or `fromRows(table, rows, { columns })` to embed (since 1.0.29); tuples that match no table: `unnestZip({ col: { values, type }, … })` | `FROM unnest(CAST($1 AS integer[]), CAST($2 AS order_status[]), CAST($3 AS decimal(10, 2)[])) AS "r"("userId", "status", "totalAmount")` · 1 | a query per row; `VALUES` lists whose text grows with the row count |

### Several reads, repeated reads, special shapes

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [Several independent reads (a screen, an endpoint)](./guides/batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch) | `QueryBatch` | one `UNION ALL` of per-read JSON envelopes · 1 for any number of reads | sequential `await`s (N); `Promise.all` (N statements on up to N pooled connections); `FutureQueryRunner.runAsync()`, which is 1 round trip only for parameter-free futures on `PostgresClient` / `BunClient` / `PGliteClient` outside a transaction |
| [Independent lists of thousands of rows each, free pool connections](./guides/batching-and-prepared-queries.md#choose-the-right-tool) | `Promise.all` of `toList()` | N statements, run concurrently · N | `QueryBatch`: `bench/querybatch`, 10 lists of 2,000 rows on a local server, 16 ms with `Promise.all`, 24 ms as one statement |
| [Run one query shape many times with new values (a hot path)](./guides/batching-and-prepared-queries.md#run-one-query-shape-many-times-pick-the-tool-by-client) | by client ([recipe](#run-one-query-shape-many-times-pick-the-tool-by-client)): on `PostgresClient` the ordinary builder on a context with `preparedStatements: true`, plus `MockRowCache.setEnabled(true)` once at startup; on `PgClient`, `BunClient`, `PGliteClient` `prepare(name)` with `sql.placeholder(name)`, then `execute(values)` | the same text on every call · 1 statement per call; on `PostgresClient` the named statement costs 2 network round trips on its first use per connection, then 1 (unnamed with parameters: 2 every time) | `prepare()` on `PostgresClient` (never named: 2 network round trips per call) or wherever the query needs logging, a timeout or slow-query reports (it bypasses the executor); texts that vary per call (`inArray()` lengths, `limit()` / `offset()` values) under `preparedStatements` |
| [Less query-build CPU on a hot path with many query shapes](./guides/configuration.md#cut-query-build-cpu-mockrowcache) | `MockRowCache.setEnabled(true)` once at startup; keep the ordinary builders | unchanged SQL · unchanged round trips | `prepare()` when the query also needs logging or a timeout; the switch in a process that builds mostly one-off shapes (it retains memory: up to 2,000 mock-row and 2,000 lateral-SQL entries, 5,000 navigation paths) |
| [A derived set read in several places of one statement](./guides/cte-guide.md#read-one-cte-from-several-subqueries-declare-it-once) | a CTE: `new DbCteBuilder().with(name, query)` and `.with(cte)` on the executing query | `WITH "older_users" AS (…)`, every reader reads it by name · 1 | the same CTE without `.with()`: each reader declares and binds its own copy (params `[30, 30]`) |
| [A read model (joins, aggregates) many queries share](./guides/schema-configuration.md#expose-a-read-only-view-modelview) | a model-managed view: `model.view(…)` in `setupModel()`, read through a `this.view(Class)` getter | the view's own query, which PostgreSQL inlines into the reading statement · 1 | repeating the same joins in every query; writes to the view (refused) |
| [One list over several tables](./guides/querying.md#combine-result-sets-union-unionall) | `a.select(…).unionAll(b.select(…))` | `(SELECT …) UNION ALL (SELECT …) ORDER BY "label" ASC LIMIT 4` · 1 | two queries merged in JS; legs that list their keys in different orders (columns match by position) |
| [Two derived sets combined where either side may be empty](./guides/cte-guide.md#join-derived-sets-with-full-outer-right-or-cross-joins) | CTE roots: `db.selectFromCte(authors.cte).fullOuterJoin(popular.cte, eq(a.id, p.authorId))` (`a = authors.cte.as()`, `p = popular.cte.as()`); also `rightJoin()`, `crossJoin()`, `onTrue()` / `onFalse()` | `FROM "authors" FULL OUTER JOIN "popular_posts" ON "authors"."id" = "popular_posts"."authorId"` · 1 | two queries merged in JS (2); an entity-rooted query (it joins CTEs INNER or LEFT only) |
| [The elements of an array or jsonb column as rows](./guides/set-returning-functions.md#join-a-set-to-every-row-crossjoinlateral) | `crossJoinLateral(u => unnest(…), select, alias)` | `CROSS JOIN LATERAL unnest(string_to_array("users"."email", '@')) AS "part"("value")` · 1 | fetching the documents and looping in JS |
| [A recursive walk (`WITH RECURSIVE`, hierarchies)](./guides/cte-guide.md#recursive-queries-raw-sql) | raw SQL: `` db.query(sql`WITH RECURSIVE …`) `` | the statement as written, `${value}` bound as `$n` · 1 | a builder method (there is none); a query per level |
| [SQL no builder expresses](./guides/querying.md#run-a-raw-statement-dbquery) | `` db.query<T>(sql`… ${value} …`) `` | the statement as written, `${value}` bound as `$n` · 1 | concatenating values into the text; `db.query()` for ordinary reads (no mappers, no logging, no timeouts) |
| [Raw SQL with the affected-row count or a per-call timeout](./database-clients.md#run-raw-sql) | `db.getClient().query(text, params, { timeoutMs })` → `{ rows, rowCount }` | the statement as written · 1; `timeoutMs` is honored by `PostgresClient` only (`PgClient`, `BunClient` and `PGliteClient` ignore it: run it in `db.transaction(fn, { timeoutMs })` there) | `db.query()` when the row count matters (it resolves the rows only) |

### Inside a transaction

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [Reads and writes that commit together](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction) | `db.transaction(async tx => …)` with `tx.<table>` | the statements on the transaction's connection, between BEGIN and COMMIT · statements + 2 | `db.<table>` inside the callback: another connection, which did not see the transaction's uncommitted row |
| [Lock the rows you read before writing them](./guides/insert-update-guide.md#lock-the-rows-you-read-before-writing-them-forupdate) | `tx.users.where(…).select(…).forUpdate().firstOrDefault()` | `… LIMIT 1 FOR UPDATE` · 1 | `forUpdate()` outside a transaction (the lock ends with the statement) |
| [Claim work-queue rows other workers have not locked](./guides/insert-update-guide.md#lock-the-rows-you-read-before-writing-them-forupdate) | `.orderBy(t => t.id).limit(n).forUpdate({ skipLocked: true })` | `ORDER BY "id" ASC LIMIT 5 FOR UPDATE SKIP LOCKED` · 1 | an unordered claim (two workers can deadlock); `skipLocked` with `noWait` (throws); `forUpdate()` on a CTE-rooted query (`db.selectFromCte(…)`): it locks no rows, put it on the CTE body |
| [Serialize check-then-write on a key that is not a row (an import per partner, a number series)](./guides/insert-update-guide.md#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks) | `tx.advisoryXactLock(classId, key)` (waits), `tx.tryAdvisoryXactLock(key)` (`true` / `false`), `tx.advisoryXactLockAll(classId, keys)` | `SELECT pg_advisory_xact_lock($1, $2)` · 1; released at COMMIT or ROLLBACK | a lock table; `forUpdate()` (rows that do not exist yet cannot be locked); calling it on `db` (throws: the lock would end with the statement); a lock where a unique index plus `ON CONFLICT` already decides |
| [Several reads inside the transaction in one round trip](./guides/batching-and-prepared-queries.md#batch-inside-a-transaction-or-under-a-timeout) | a `QueryBatch` whose legs all start from `tx` | one `UNION ALL` statement on the transaction's connection · 1 | legs from `db` and `tx` in one batch (refused before sending) |

## Writing data: decision table

Every write builder is lazy: nothing is sent until it is awaited, a bare `await` resolves `undefined`, and a second
`await` of the same builder sends the statement again. `insertWithChildren()` and `MutationBatch.executeBatch()` are
Promises instead: they send when called
([How a write runs](./guides/insert-update-guide.md#how-a-write-runs-lazy-builders-and-what-await-returns)).

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| [One row](./guides/insert-update-guide.md#insert-one-row-insert) | `insert(row)` | `INSERT INTO "tags" ("name") VALUES ($1)` · 1 | `const t = await db.tags.insert(row)` expecting the row (it is `undefined`) |
| [One row and its generated key](./guides/insert-update-guide.md#insert-one-row-insert) | `insert(row).returning(t => ({ id: t.id }))` | `INSERT INTO "tags" ("name") VALUES ($1) RETURNING "id" AS "id"` · 1 | insert, then a SELECT for the key (2) |
| [Many rows](./guides/insert-update-guide.md#insert-many-rows-in-one-statement-insertbulk) | `insertBulk(rows)` | `INSERT INTO "tags" ("name") VALUES ($1), ($2), ($3)` · 1 per chunk of `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows | an awaited `insert()` per row (n) |
| [Generated keys of many rows](./guides/insert-update-guide.md#insert-many-rows-in-one-statement-insertbulk) | `insertBulk(rows).returning(t => ({ id: t.id, name: t.name }))`; return a natural key with the id (the order of RETURNING rows is not guaranteed) | `… RETURNING "id" AS "id", "name" AS "name"` · 1 up to one chunk (39,321 rows of 1 column, 13,107 of 3; 10,000 one-column rows measured: 1 statement), then 1 per chunk | `insert().returning()` per row (n) |
| [More rows than one chunk, or one statement text for any row count](./guides/insert-update-guide.md#insert-a-large-or-variable-size-set-in-one-fixed-statement-fromrows) | `insertFrom(fromRows(table, rows, { columns }).asSubquery('table'), map)` (since 1.0.29), `.returning(t => ({ id: t.id, name: t.name }))` for the keys | `INSERT INTO "tags" ("name") SELECT "src"."name" FROM (… unnest(CAST($1 AS varchar[])) …) AS "src" RETURNING "id" AS "id", "name" AS "name"`: 1 parameter per column · 1 (40,000 rows with RETURNING measured: 1) | `insertBulk()` of 70,000 rows: 2 statements, 70,000 parameters, a text that changes with the row count |
| [Insert the new rows, skip the rest](./guides/insert-update-guide.md#insert-the-rows-that-are-new-and-skip-the-rest) | `insertBulk(rows, { onConflictDoNothing: true })` (any unique index) | `… VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING` · 1 per chunk | `exists()`, then `insert()`, per row (2 per new row, racy: 23505) |
| [Insert-or-skip on ONE key (or a partial unique index)](./guides/insert-update-guide.md#insert-the-rows-that-are-new-and-skip-the-rest) | `upsertBulk(rows, { primaryKey: 'username', updateColumnFilter: () => false })` (+ `targetWhere` for a partial index) | `… VALUES ($1, $2), ($3, $4) ON CONFLICT ("username") DO NOTHING` · 1 per chunk | `onConflictDoNothing`, which skips a conflict on ANY unique index |
| [Insert-or-skip with one statement text for any row count](./guides/insert-update-guide.md#insert-the-rows-that-are-new-and-skip-the-rest) | `insertFrom(fromRows(…).asSubquery('table'), map, { onConflictDoNothing: true })` (since 1.0.29) | `INSERT INTO "users" ("username", "email") SELECT … FROM unnest(CAST($1 AS varchar[]), CAST($2 AS text[])) … ON CONFLICT DO NOTHING` · 1 | a `where: src => notExists(…)` guard (it passes a row a concurrent transaction inserts: 23505) |
| [Insert or update by a unique key](./guides/insert-update-guide.md#insert-or-update-by-a-unique-key-upsertbulk) | `upsertBulk(rows, { primaryKey, updateColumns })` | `… ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age"` · 1 per chunk | a read, then an update or an insert, per row (2 per row, racy); rows with different column sets (a missing column is written as NULL) |
| [Insert, or update only when a condition holds (newer data wins)](./guides/insert-update-guide.md#compute-the-update-from-the-stored-and-the-proposed-row-updateset--updatewhere) | `upsertBulk(rows, { primaryKey: 'username', updateWhere: (existing, excluded) => lt(existing.age, excluded.age) })`; computed assignments with `updateSet: (existing, excluded) => ({ … })`; raw SQL with `setWhere` | `… ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age" WHERE "users"."age" < "excluded"."age"` · 1 per chunk | a read, a comparison in JS, then a write (2 per row, racy) |
| [Upsert onto a partial unique index](./guides/insert-update-guide.md#upsert-onto-a-partial-unique-index-targetwhere) | `upsertBulk(rows, { primaryKey: ['unitId'], targetWhere: e => eq(e.isCurrent, literal(true)), updateColumns: ['tenantId'] })` | `ON CONFLICT ("unit_id") WHERE "is_current" = TRUE DO UPDATE SET "tenant_id" = EXCLUDED."tenant_id"` · 1 per chunk | leaving `targetWhere` out (42P10); a bound value in it (refused: write constants with `literal()`) |
| [Conflict on a constraint name, or SET explicit values](./guides/insert-update-guide.md#conflict-on-a-constraint-name-or-set-explicit-values-values) | `values(rows).onConflict({ constraint: 'users_username_key' }).doUpdate({ set: { email: 'bob@renamed.com' } }).execute()` | `ON CONFLICT ON CONSTRAINT users_username_key DO UPDATE SET "email" = $3 RETURNING "id", "username", …` (every column) · 1 | `values()` where `upsertBulk()` fits: no chunking, RETURNING every column, `onConflict([...])` takes database column names |
| [Insert or update without a unique index](./guides/insert-update-guide.md#insert-or-update-without-a-unique-index-mergebulk) | `mergeBulk(rows, { on })` (PostgreSQL 15+) | `MERGE INTO "registry_items" AS t USING (VALUES …) AS s (…) ON t."crm_id" = s."crm_id" WHEN MATCHED … WHEN NOT MATCHED …` · 1 per chunk | `mergeBulk()` with concurrent writers of the same keys (no speculative insertion: duplicates or 23505) |
| [The same change to every matching row](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate) | `where(cond).update(values)`; values may be expressions over the row | `UPDATE "posts" SET "views" = "posts"."views" + $1 WHERE "posts"."user_id" = $2` · 1 | an update per row |
| [Update or delete by a list of ids](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate) | `where(r => eqAny(r.id, ids)).update(…)` / `.delete()` | `UPDATE "users" SET "is_active" = $1 WHERE ("users"."id" = ANY($2::integer[]))` · 1 | an update per id (n); `inArray()` (one statement text per list length) |
| [Many rows, each with its own values](./guides/insert-update-guide.md#update-many-rows-each-with-its-own-values-bulkupdate) | `bulkUpdate(rows)`; a row may carry only the columns it changes | `UPDATE "users" AS t SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END, … FROM (VALUES …) AS v(…) WHERE t."id" = v."id"` · 1 per chunk | `where(id).update()` per row (n) |
| [Delete by a condition](./guides/insert-update-guide.md#delete-rows-wheredelete) | `where(cond).delete()` | `DELETE FROM "post_comments" WHERE "post_comments"."id" > $1` · 1 | a delete per id; `db.<table>.delete()` without `where()` (it deletes every row) |
| [Rows computed from data in the database](./guides/insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom) | `insertFrom(query.asSubquery('table'), map)` | `INSERT INTO "order_task" (…) SELECT … FROM (SELECT (COALESCE(MAX(…), $2) + $3) as "next" …) AS "src"` · 1 | read, compute in JS, insert (2; the value can be stale when it is written) |
| [A parent and children that need its key](./guides/insert-update-guide.md#insert-a-parent-and-its-children-in-one-statement-insertwithchildren) | `insertWithChildren({ row, children, returning })` | `WITH "__iwc_parent__" AS (INSERT … RETURNING *), "__mutation__" AS (INSERT INTO "posts" … SELECT p."id", …) SELECT …` · 1; 2 when the parent selector reads a navigation or a collection (read back by a SELECT after the statement) | insert the parent, read its id, insert the children (2, not atomic) |
| [Several independent writes in one round trip](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch) | `MutationBatch`: `addInsertBulk()`, `addBulkUpdate()`, `addUpsertBulk()`, `addDeleteWhereIn()`, `addUpdateWhereIn()`, then `executeBatch()` | `WITH "__mb_0" AS (INSERT …), "__mb_1" AS (UPDATE …), … SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", …` · 1, atomic | awaited writes one by one (n statements, n commits); legs that depend on each other's rows (they share one snapshot) |
| [Generated keys of a batch's insert leg](./guides/insert-update-guide.md#read-back-the-rows-an-insert-leg-wrote-returning-and-getlegrows) | `addInsertBulk(table, rows, id, { returning: ['id', 'name'] })`, then `getLegRows(id)` (since 1.0.29) | `… RETURNING "id" AS "id", "name" AS "name"` and `(SELECT COALESCE(json_agg(row_to_json("__mb_0")), '[]'::json) FROM "__mb_0") AS "0__rows"` · 1 | a SELECT after the batch |
| [The rows a write changed](./guides/insert-update-guide.md#read-back-what-a-write-changed-returningselector) | `.returning(selector)` | `UPDATE … RETURNING "id" AS "id", "age" AS "age"` · 1 | a SELECT after the write (2) |
| [How many rows changed](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate) | `.affectedCount()` on `where().update()` / `where().delete()` | no RETURNING; the driver's row count · 1 | `.returning()` and `.length` |
| [The value a row had before the update](./guides/insert-update-guide.md#read-the-row-as-it-was-before-the-update-old-postgresql-18) | `.returning((row, old) => ({ id: row.id, status: row.status, previous: old.status }))` (PostgreSQL 18) | `RETURNING "id" AS "id", "status" AS "status", old."status" AS "previous"` · 1 | `SELECT … FOR UPDATE`, then `UPDATE` (2) |
| [A write whose rows feed a read or another write](./guides/insert-update-guide.md#feed-one-write-into-another-in-one-statement-data-modifying-ctes) | `toStatement(selector)` (on inserts since 1.0.22) + `new DbCteBuilder().withMutation(name, statement)`, read with `db.selectFromCte(cte)` | `WITH "claimed" AS (UPDATE "tasks" … RETURNING …) SELECT … FROM "claimed"` · 1 | a read, then a write by the ids it found (2, with a race between them) |
| [Close the current version and open the next](./guides/insert-update-guide.md#close-the-current-version-and-open-the-next-in-one-statement-aftermutation) | two `withMutation()` legs, `afterMutation(closed.cte)` in the insert's `where` (since 1.0.29), read back with `unionAll()` | `… "opened" AS (INSERT … WHERE ((SELECT count(*) FROM "closed") >= 0) RETURNING …)` · 1 | a read per key, then an update and an insert where it changed (6 statements for 3 units in the guide's example, plus BEGIN and COMMIT) |
| [Sequence numbers for many rows](./guides/insert-update-guide.md#number-many-rows-from-a-sequence-in-one-statement) | `` sql`nextval('invoice_number_seq')` `` as a value of `insertBulk()` or `insertFrom()` | `VALUES ((nextval('invoice_number_seq')), $1), ((nextval('invoice_number_seq')), $2), …` · 1 | `nextValue()` per row, then the insert (n + 1) |
| [Several dependent statements, all or nothing](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction) | `db.transaction(async tx => …)` with `tx.<table>` | the statements between BEGIN and COMMIT · statements + 2 | `db.<table>` inside the callback (another connection, which commits on its own) |

## Recipes

### Load each row's children in one statement: collections

A collection (a `hasMany` list such as `u.posts`) inside `select()` returns each parent row with its children in the
same statement. Use it whenever a result needs parents and their children; never loop a query per parent row.

```ts
const usersWithPosts = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// [{ id: 1, username: 'alice', posts: [{ title: 'Alice Post 1', views: 100 }, { title: 'Alice Post 2', views: 150 }] },
//  { id: 2, username: 'bob', posts: [{ title: 'Bob Post', views: 200 }] },
//  { id: 3, username: 'charlie', posts: [] }]
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

The tempting alternative, a query per user, sent 4 statements for 3 users (1 + N):

```ts
import { eq } from 'linkgress-orm';

const users = await db.users.orderBy(u => u.id).select(u => ({ id: u.id, username: u.username })).toList();
const loaded = [];
for (const u of users) {
  const posts = await db.posts
    .where(p => eq(p.userId, u.id))
    .select(p => ({ title: p.title, views: p.views }))
    .toList();
  loaded.push({ ...u, posts });
}
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
ORDER BY "id" ASC

SELECT "posts"."title" as "title", "posts"."views" as "views"
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 1 ]

SELECT "posts"."title" as "title", "posts"."views" as "views"
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 2 ]

SELECT "posts"."title" as "title", "posts"."views" as "views"
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 3 ]
```

> **Efficiency:** the collection costs 1 statement for any number of parents; the loop costs 1 + N round trips. Under
> the default `lateral` strategy each parent's children are read through the foreign key (`posts.user_id`), so index it:
> a relation creates no index.

> **Pitfall:** entity rows never carry navigations. `(await db.users.toList())[0].posts` compiles (the property is
> declared optional) but is `undefined`: there is no lazy and no eager loading. Collection items travel as JSON: an
> unmapped timestamp arrives as text (typed `Date`) and a `numeric` value as a JS number; mapped columns go through
> their mapper. Without `orderBy()` on the collection the order of its items is not guaranteed (the lists above came
> back in insertion order): order the collection when the order matters.

Guide: [Load each row's children in the same statement](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections).

### Read a related row's columns: navigations

A navigation (a `hasOne` reference such as `p.user`) read in `select()`, `where()` or `orderBy()` joins the related
row in the same statement: `INNER JOIN` for a relation declared `.isRequired()`, `LEFT JOIN` otherwise. Use it instead
of looking related rows up afterwards.

```ts
const postsWithAuthor = await db.posts
  .orderBy(p => p.id)
  .select(p => ({ title: p.title, author: p.user!.username }))
  .toList();
// [{ title: 'Alice Post 1', author: 'alice' }, { title: 'Alice Post 2', author: 'alice' }, { title: 'Bob Post', author: 'bob' }]
```

```sql
SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
ORDER BY "posts"."id" ASC
```

The tempting alternative, a lookup per post, sent 4 statements for 3 posts:

```ts
import { eq } from 'linkgress-orm';

const posts = await db.posts.orderBy(p => p.id).select(p => ({ title: p.title, userId: p.userId })).toList();
const withAuthors = [];
for (const p of posts) {
  const author = await db.users.where(u => eq(u.id, p.userId)).select(u => u.username).firstOrDefault();
  withAuthors.push({ title: p.title, author });
}
```

```sql
SELECT "posts"."title" as "title", "posts"."user_id" as "userId"
FROM "posts"
ORDER BY "posts"."id" ASC

SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 2 ]
```

Collecting the ids and sending them back in a second query (`… WHERE "users"."id" IN ($1, $2)`) still takes 2
statements and a join in JS.

> **Efficiency:** one join per navigation hop, on the target's principal key (its primary key here); a navigation the
> query never reads adds no join. When the query reads FEW rows through a foreign key into a LARGE table and the plan
> scans the target, `lateralJoin(p => p.user)` (since 1.0.23) turns that one join into a per-row key probe; never add
> it to a navigation the WHERE filters by ([Lateral navigation joins](./guides/lateral-navigation-joins.md)).

> **Pitfall:** an optional navigation whose row is missing reads `undefined`, although typed non-null. A filter on its
> column (`eq(t.level!.name, …)`) drops the rows without it: NULL matches nothing.

Guide: [Read a related row's columns](./guides/querying.md#read-a-related-rows-columns-navigations).

### Count, test existence and total without loading rows: `count()`, `exists()`, `agg`

`count()` returns a number, `exists()` a boolean, and a select of `agg` aggregates one row of totals: the database
computes the answer and only the answer travels. Use them whenever the task needs a number or a yes/no, not rows.

```ts
import { agg, eq, gt, gte } from 'linkgress-orm';

const adults = await db.users.where(u => gt(u.age, 30)).count();                 // 2
const hasInactive = await db.users.where(u => eq(u.isActive, false)).exists();   // true
const totals = await db.posts
  .where(p => gte(p.views, 0))
  .select(p => ({
    posts: agg.count(),
    totalViews: agg.sum(p.views),
    minViews: agg.min(p.views),
    maxViews: agg.max(p.views),
    popular: agg.count().filter(gt(p.views, 120)),
  }))
  .firstOrDefault();
// { posts: 3, totalViews: 450, minViews: 100, maxViews: 200, popular: 2 }
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" > $1
-- params: [ 30 ]

SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."is_active" = $1)
-- params: [ false ]

SELECT count(*) as "posts", sum("posts"."views") as "totalViews", min("posts"."views") as "minViews", max("posts"."views") as "maxViews", count(*) FILTER (WHERE "posts"."views" > $1) as "popular"
FROM "posts"
WHERE "posts"."views" >= $2
LIMIT 1
-- params: [ 120, 0 ]
```

The tempting alternatives: loading the rows to count them, counting to test existence, and the select builder's
`sum()` / `min()` / `max()`, one statement each:

```ts
const adultsLoaded = (await db.users.where(u => gt(u.age, 30)).toList()).length;           // 2
const hasInactiveByCount = (await db.users.where(u => eq(u.isActive, false)).count()) > 0; // true
const total = await db.posts.select(p => ({ views: p.views })).sum(r => r.views);          // '450' (a string)
const min = await db.posts.select(p => ({ views: p.views })).min(r => r.views);            // 100
const max = await db.posts.select(p => ({ views: p.views })).max(r => r.views);            // 200
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age", "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata", "users"."last_active_at" as "lastActiveAt"
FROM "users"
WHERE "users"."age" > $1
-- params: [ 30 ]

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ false ]

SELECT SUM("posts"."views") as result
FROM "posts"

SELECT MIN("posts"."views") as result
FROM "posts"

SELECT MAX("posts"."views") as result
FROM "posts"
```

> **Efficiency:** `toList().length` transferred every column of both matching rows to count them; `count()` returns one
> value. `EXISTS` stops at the first matching row, while `COUNT(*)` visits every match. One `agg` select computes any
> number of aggregates and `FILTER` counts in one scan and reads them as numbers; the builder's `sum()` / `min()` /
> `max()` cost a statement each and return the raw driver value (`SUM` of an integer column: `'450'`).

> **Pitfall:** `count()` ignores `orderBy()`, `limit()`, `offset()` and `selectDistinct()`; to count distinct values
> use `agg.countDistinct(col)`. There is no `any()`, `none()` or `avg()` on a table: use `exists()`,
> `!(await q.exists())` and `agg.avg()`.

Guides: [Count rows](./guides/querying.md#count-rows-without-loading-them-count),
[Check whether rows exist](./guides/querying.md#check-whether-rows-exist-exists),
[Aggregate the whole set](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg).

### Aggregate per parent row: collection `count()` and `sum()`

`count()`, `sum()`, `min()`, `max()` and `exists()` of a collection return one value per parent row in the same
statement. Use them for lists of parents with child counts or totals.

```ts
const stats = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),
    totalViews: u.posts!.sum(p => p.views),
  }))
  .toList();
// [{ username: 'alice', postCount: 2, totalViews: 250 }, { username: 'bob', postCount: 1, totalViews: 200 },
//  { username: 'charlie', postCount: 0, totalViews: null }]
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(SUM("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "totalViews"
FROM "users"
ORDER BY "users"."id" ASC
```

The tempting alternative, a `count()` per user, sent 4 statements for 3 users:

```ts
import { eq } from 'linkgress-orm';

const users = await db.users.orderBy(u => u.id).select(u => ({ id: u.id, username: u.username })).toList();
const counts = [];
for (const u of users) {
  counts.push({ username: u.username, postCount: await db.posts.where(p => eq(p.userId, u.id)).count() });
}
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
ORDER BY "id" ASC

SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 1 ]

SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 2 ]

SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."user_id" = $1
-- params: [ 3 ]
```

Each collection aggregate is a subquery of its own, so two aggregates read the children twice. For several aggregates
over many or all parents, compute them in one grouped subquery and join it once:

```ts
import { coalesce, eq } from 'linkgress-orm';

const perUser = db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, posts: g.count(), views: g.sum(r => r.views) }))
  .asSubquery('table');
const withStats = await db.users
  .leftJoin(perUser, (u, s) => eq(u.id, s.userId), (u, s) => ({ username: u.username, posts: coalesce(s.posts, 0), views: s.views }), 'stats')
  .orderBy(r => r.username)
  .toList();
// [{ username: 'alice', posts: 2, views: 250 }, { username: 'bob', posts: 1, views: 200 }, { username: 'charlie', posts: 0, views: undefined }]
```

```sql
SELECT "users"."username" as "username", COALESCE("stats"."posts", $1) as "posts", "stats"."views" as "views"
FROM "users"
LEFT JOIN (SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
GROUP BY "posts"."user_id") AS "stats" ON "users"."id" = "stats"."userId"
ORDER BY "username" ASC
-- params: [ 0 ]
```

> **Efficiency:** under the default `lateral` strategy a collection aggregate probes the foreign key once per parent row
> the query returns: the cheaper form for a page or a lookup. The grouped join reads the child table once for all
> parents: the cheaper form for many parents and several aggregates.

> **Pitfall:** a collection has no `avg()`; use `g.avg()` in a grouped subquery or a correlated `agg.avg()` scalar
> subquery. A user without a group reads the joined columns as `undefined` (`views` above); wrap counts in `coalesce()`.

Guides: [Count, sum, min and max per parent](./guides/querying.md#count-sum-min-and-max-per-parent),
[Join per-key aggregates computed once](./guides/querying.md#join-per-key-aggregates-computed-once).

### Compute statistics per key: `groupBy()` and `having()`

Project the rows, group the projection by a key object, filter the groups with `having()` and select the key with its
aggregates. Use it for counts and totals per user, status or day; it returns one row per group.

```ts
import { gt } from 'linkgress-orm';

const perUser = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .having(g => gt(g.count(), 1))
  .select(g => ({ userId: g.key.userId, posts: g.count(), views: g.sum(r => r.views) }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, posts: 2, views: 250 }]
```

```sql
SELECT "posts"."user_id" as "userId", CAST(COUNT(*) AS INTEGER) as "posts", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "views"
FROM "posts"
GROUP BY "posts"."user_id"
HAVING COUNT(*) > $1
ORDER BY "userId" ASC
-- params: [ 1 ]
```

The tempting alternative, loading every row and grouping in JS, is also 1 statement but transfers every row (3 rows
here, against 1 group row):

```ts
const rows = await db.posts.select(p => ({ userId: p.userId, views: p.views })).toList();
const grouped = new Map<number, { posts: number; views: number }>();
for (const r of rows) {
  const g = grouped.get(r.userId) ?? { posts: 0, views: 0 };
  g.posts++;
  g.views += r.views;
  grouped.set(r.userId, g);
}
```

```sql
SELECT "posts"."user_id" as "userId", "posts"."views" as "views"
FROM "posts"
```

> **Efficiency:** the payload is one row per group, whatever the number of rows grouped. Filter rows with `where()`
> before `select()` (an index can serve it) and keep `having()` for conditions on aggregates.

> **Pitfall:** `groupBy()` exists only after `select()`, and its callbacks see the projection: project every key and
> every aggregate argument first. `COUNT` reads as a number, `SUM` and `AVG` are cast to `DOUBLE PRECISION`.

Guide: [Group rows](./guides/querying.md#group-rows-groupby).

### Read a page and its total in one statement

Register the same paged builder twice in a `QueryBatch`: `addList()` reads the page, `addCount()` counts every match
(its leg drops ORDER BY, LIMIT and OFFSET). It is one statement, and the total stays right past the last page.

```ts
import { gt, QueryBatch } from 'linkgress-orm';

const page = db.users
  .where(u => gt(u.age, 20))
  .select(u => ({ id: u.id, username: u.username }))
  .orderBy(u => u.username)
  .offset(0)
  .limit(2);
const pageBatch = new QueryBatch();
const rowsKey = pageBatch.addList(page, 'rows');
const totalKey = pageBatch.addCount(page, 'total');
await pageBatch.executeBatch();
const rows = pageBatch.getList(rowsKey);    // [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }]
const total = pageBatch.getCount(totalKey); // 3
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
-- params: [ 20, 20 ]
```

The tempting alternative, `Promise.all` of the page and a count, sent 2 statements:

```ts
const [rows2, total2] = await Promise.all([
  db.users.where(u => gt(u.age, 20)).select(u => ({ id: u.id, username: u.username })).orderBy(u => u.username).offset(0).limit(2).toList(),
  db.users.where(u => gt(u.age, 20)).count(),
]);
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."age" > $1
ORDER BY "username" ASC
LIMIT 2 OFFSET 0
-- params: [ 20 ]

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" > $1
-- params: [ 20 ]
```

`countOver()` is also one statement, but reads the total from the first returned row. Past the last page it returned
`{ data: [], totalCount: 0 }` although 3 rows match:

```ts
const past = await db.users
  .where(u => gt(u.age, 20))
  .select(u => ({ id: u.id, username: u.username }))
  .orderBy(u => u.username)
  .offset(10)
  .limit(2)
  .countOver();
// { data: [], totalCount: 0 }
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", COUNT(*) OVER() as "__countOver"
FROM "users"
WHERE "users"."age" > $1
ORDER BY "username" ASC
LIMIT 2 OFFSET 10
-- params: [ 20 ]
```

> **Efficiency:** for deep pages, keyset pagination (`where(u => gt(u.id, lastId)).orderBy(u => u.id).limit(n)`) reads
> only the rows it returns; OFFSET reads and discards every skipped row, and every distinct `limit()` / `offset()` value
> is another statement text (the values are inlined).

Guides: [Load a page and its total](./guides/batching-and-prepared-queries.md#load-a-page-and-its-total-count-in-one-round-trip),
[Page through results](./guides/querying.md#page-through-results).

### Read several independent results in one round trip: `QueryBatch`

`QueryBatch` sends reads that do not depend on each other — lists, first rows, counts — as ONE `UNION ALL` statement;
each leg keeps its own plan and reads back what it reads on its own (the exceptions:
[known limitations of the JSON transport](./guides/batching-and-prepared-queries.md#known-limitations-of-the-json-transport)).
Use it for every screen or endpoint that needs two or more independent reads.

```ts
import { eq, QueryBatch } from 'linkgress-orm';

const userId = 1;
const batch = new QueryBatch();
const userKey = batch.addFirstOrDefault(
  db.users.where(u => eq(u.id, userId)).select(u => ({ id: u.id, username: u.username })),
  'user',
);
const postsKey = batch.addList(
  db.posts.where(p => eq(p.userId, userId)).select(p => ({ id: p.id, title: p.title })).orderBy(p => p.id),
  'posts',
);
const ordersKey = batch.addCount(db.orders.where(o => eq(o.userId, userId)), 'orders');
await batch.executeBatch();
const user = batch.getItem(userKey);          // { id: 1, username: 'alice' } | null
const posts = batch.getList(postsKey);        // [{ id: 1, title: 'Alice Post 1' }, { id: 2, title: 'Alice Post 2' }]
const orderCount = batch.getCount(ordersKey); // 1
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" = $2
ORDER BY "id" ASC
) __batch_q
UNION ALL
SELECT 2 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count
FROM "orders"
WHERE "orders"."user_id" = $3
) __batch_q
-- params: [ 1, 1, 1 ]
```

The tempting alternative, the same reads awaited one by one, sent 3 statements:

```ts
const user0 = await db.users.where(u => eq(u.id, userId)).select(u => ({ id: u.id, username: u.username })).firstOrDefault();
const posts0 = await db.posts.where(p => eq(p.userId, userId)).select(p => ({ id: p.id, title: p.title })).orderBy(p => p.id).toList();
const orderCount0 = await db.orders.where(o => eq(o.userId, userId)).count();
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]

SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" = $1
ORDER BY "id" ASC
-- params: [ 1 ]

SELECT COUNT(*) as count
FROM "orders"
WHERE "orders"."user_id" = $1
-- params: [ 1 ]
```

> **Efficiency:** measured in `bench/querybatch` (raw statements of the shape `QueryBatch` sends, on PostgreSQL through
> postgres.js, medians): 12 reads of about 185 rows over a ~31 ms round trip took 62 ms as one statement (31 ms
> named), 743 ms awaited one by one and 110 ms with `Promise.all` on a pool of 10, which also holds up to 10
> connections at once. For independent lists of thousands of rows each on a local server, `Promise.all` was faster
> (10 × 2,000 rows: 16 ms against 24 ms).

> **Pitfall:** every leg must share the first leg's client and executor. A leg derived with `withTimeout()`,
> `withPreparedStatements()` or `expectedExecutionTime()` next to legs built on `db`, or a leg of `tx` next to one of
> `db`, is refused before anything is sent; inside a transaction, build every leg from `tx`. Reads that depend on
> each other's results belong in one query with navigations or collections, not in a batch.

Guide: [Read several independent results in one round trip](./guides/batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch).

### Run one query shape many times: pick the tool by client

A hot path that runs one query shape thousands of times with new values (a lookup per request, a filter per job)
costs a query build in your process and a parse and plan on the server per call. Two mechanisms cut them, and they do
not combine: `prepare(name)` + `sql.placeholder()` builds the SQL once but always sends an unnamed statement and
bypasses the executor; `preparedStatements: true` names the statement on the server, honored by `PostgresClient`
only. The client decides:

| Client | Use | Statements per call | Why |
|---|---|---|---|
| `PostgresClient` | the ordinary builder on a context with `preparedStatements: true`, plus `MockRowCache.setEnabled(true)` once at startup | 1: a named statement, 2 network round trips on its first use per pooled connection, then 1 | `prepare()` is never named there: Parse/Describe, then Bind/Execute, 2 network round trips on every call |
| `PgClient` | `prepare(name)` + `sql.placeholder(name)`, then `execute(values)` | 1 network round trip | node-postgres sends an unnamed statement in one round trip; `preparedStatements` is ignored |
| `BunClient` | `prepare(name)` + `sql.placeholder(name)` | 1 | Bun.SQL names statements itself (its `prepare` option, default `true`); `prepare()` saves the build |
| `PGliteClient` | `prepare(name)` + `sql.placeholder(name)` | 1 (in-process, no network) | ignores `preparedStatements`; `prepare()` saves the build |

On every client, keep the ordinary builder (with `MockRowCache` for the build cost) when the query needs logging,
`onQueryTakingTooLong` reports, a timeout or a value bound through a column's custom mapper: `PreparedQuery.execute()`
gets none of them (a placeholder value skips the mapper's `toDriver`).

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

Both forms send the same text with a new value per call (captured on `PgClient`, which does not name statements;
on `PostgresClient` the second form's text is a named statement):

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [ 100 ]

SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."views" > $1
-- params: [ 160 ]
```

> **Efficiency:** neither form saves statements: each call is 1. `prepare()` skips the build, `MockRowCache` shortens
> it (a checkout burst measured in 0.4.67: 42–45 to 92–104 orders/s), and a named statement skips the server's parse
> and postgres.js's describe round trip (a 16 KB cart read: 7.35 ms unnamed, 0.95 ms named, on one connection).

> **Pitfall:** under `preparedStatements` every distinct text is one cached statement per pooled connection. Keep the
> text stable: `eqAny()` instead of `inArray()` for lists, `.withPreparedStatements(false)` on paging queries whose
> `limit()` / `offset()` values are written into the text. After five executions PostgreSQL may switch to a generic
> plan; measure wide analytical shapes before naming them.

Guides: [Run one query shape many times](./guides/batching-and-prepared-queries.md#run-one-query-shape-many-times-pick-the-tool-by-client),
[Send statements named on the server](./guides/configuration.md#send-statements-named-on-the-server-preparedstatements),
[Cut query-build CPU](./guides/configuration.md#cut-query-build-cpu-mockrowcache).

### Filter by rows of another table: `exists()` and `inSubquery()`

Embed the other query in the WHERE: `exists()` keeps each row that has a related row, once; `inSubquery()` matches
keys another query computes. Use them instead of joining to the many side or fetching keys first.

```ts
import { eq, exists, gt, inSubquery } from 'linkgress-orm';

const withPopular = await db.users
  .where(u => exists(u.posts!.where(p => gt(p.views, 50))))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'bob' }]

const ofActive = await db.posts
  .where(p => inSubquery(p.userId, db.users.where(u => eq(u.isActive, true)).select(u => u.id).asSubquery('array')))
  .select(p => ({ title: p.title }))
  .toList();
// [{ title: 'Alice Post 1' }, { title: 'Alice Post 2' }, { title: 'Bob Post' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."views" > $1)
-- params: [ 50 ]

SELECT "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" IN (SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1)
-- params: [ true ]
```

The tempting alternatives: a join to the posts returned alice twice (once per matching post), and fetching the ids
first took 2 statements:

```ts
import { inArrayOpt } from 'linkgress-orm';

const viaJoin = await db.users
  .innerJoin(db.posts, (u, p) => eq(u.id, p.userId), (u, p) => ({ username: u.username, views: p.views }))
  .where(r => gt(r.views, 50))
  .select(r => ({ username: r.username }))
  .toList();
// [{ username: 'alice' }, { username: 'alice' }, { username: 'bob' }]

const activeIds = await db.users.where(u => eq(u.isActive, true)).select(u => u.id).toList();
const ofActive2 = await db.posts.where(p => inArrayOpt(p.userId, activeIds)).select(p => ({ title: p.title })).toList();
```

```sql
SELECT "users"."username" as "username"
FROM "users"
INNER JOIN "posts" AS "posts_0" ON "users"."id" = "posts_0"."user_id"
WHERE "posts_0"."views" > $1
-- params: [ 50 ]

SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]

SELECT "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" IN ($1, $2)
-- params: [ 1, 2 ]
```

> **Efficiency:** `EXISTS` stops at the first matching row and PostgreSQL can plan it as a semi-join; `IN (SELECT …)`
> keeps one statement text however many keys match. Rows WITHOUT related rows: `notExists(u.posts!)`, which is NULL-safe
> where `notInSubquery()` is not.

> **Pitfall:** of a collection's aggregates only `count()` and `exists()` work in `where()` and `orderBy()`; `max()`,
> `min()` and `sum()` there throw. Write "max(views) > v" as `exists(u.posts!.where(p => gt(p.views, v)))`.

Guides: [Filter or order parents by their children](./guides/querying.md#filter-or-order-parents-by-their-children),
[Subqueries](./guides/subquery-guide.md).

### Match a list of values: `inArrayOpt()` and `eqAny()`

For a list that comes from data (ids, cart items), use `inArrayOpt()`: up to 8 values it renders `IN ($1, …)`, above
it one array parameter. Use `eqAny()` when every length must share one statement text, or the list is long.

```ts
import { eqAny, inArrayOpt } from 'linkgress-orm';

const three = await db.users.where(u => inArrayOpt(u.id, [1, 2, 3])).select(u => u.username).toList();
const nine = await db.users.where(u => inArrayOpt(u.id, [1, 2, 3, 4, 5, 6, 7, 8, 9])).select(u => u.username).toList();
const anyLength = await db.users.where(u => eqAny(u.id, [1, 2, 3])).select(u => u.username).toList();
// ['alice', 'bob', 'charlie'] each
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
WHERE ("users"."id" = ANY($1::integer[]))
-- params: [ "{1,2,3}" ]
```

The tempting alternatives: a query per id sent 3 statements, and `inArray()` sent a different statement text for each
list length:

```ts
import { eq, inArray } from 'linkgress-orm';

const byId = [];
for (const id of [1, 2, 3]) {
  byId.push(await db.users.where(u => eq(u.id, id)).select(u => u.username).firstOrDefault());
}

const a = await db.users.where(u => inArray(u.id, [1])).select(u => u.username).toList();
const b = await db.users.where(u => inArray(u.id, [1, 2])).select(u => u.username).toList();
const c = await db.users.where(u => inArray(u.id, [1, 2, 3])).select(u => u.username).toList();
```

```sql
SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 1 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 2 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
-- params: [ 3 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN ($1)
-- params: [ 1 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN ($1, $2)
-- params: [ 1, 2 ]

SELECT "users"."username"
FROM "users"
WHERE "users"."id" IN ($1, $2, $3)
-- params: [ 1, 2, 3 ]
```

> **Efficiency:** under named prepared statements every distinct text is one cached plan per pooled connection;
> `inArrayOpt()` bounds a list family to 8 `IN` texts, 1 array text and the `WHERE 1=0` of an empty list; `eqAny()` to
> 1 (an empty list binds `'{}'`). `IN` binds one parameter per value, capped at 65,535 per statement (32,767 on
> PGlite); `eqAny()` binds one. The threshold (8) is process-wide:
> `LinkgressConfig.inArrayOptThreshold` ([Configuration](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)).

> **Pitfall:** `notInArray()` / `neAll()` with a NULL element return no row; use `notExists()` there. A list of
> composite keys is a set, not a list: join `fromRows(table, keys, { columns })` (since 1.0.29), one array parameter per
> column ([Match rows against a list of composite keys](./guides/set-returning-functions.md#match-rows-against-a-list-of-composite-keys-join-fromrows)).

Guide: [Matching a list of values](./guides/querying.md#matching-a-list-of-values).

### Keep the top N rows per parent or per group

Nested under each parent, the first N children are a collection with `orderBy()` and `limit()`: under `lateral` each
parent's subquery stops at its limit. As flat rows, the top N per group come from a window value (`win`, since 1.0.21)
computed in a CTE and filtered where the CTE is read.

```ts
const topPosts = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    topPost: u.posts!.orderBy(p => [[p.views, 'DESC']]).limit(1).select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// [{ username: 'alice', topPost: [{ title: 'Alice Post 2', views: 150 }] },
//  { username: 'bob', topPost: [{ title: 'Bob Post', views: 200 }] }, { username: 'charlie', topPost: [] }]
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "topPost"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
  ORDER BY "lateral_0_posts"."views" DESC
  LIMIT 1
) sub) "lateral_0" ON true
ORDER BY "users"."id" ASC
```

```ts
import { DbCteBuilder, lte, win } from 'linkgress-orm';

const ranked = new DbCteBuilder().with('ranked_posts', db.posts.select(p => ({
  id: p.id,
  userId: p.userId,
  title: p.title,
  rank: win.rowNumber().over({ partitionBy: p.userId, orderBy: [[p.views, 'DESC'], p.id] }),
})));
const top = await db.selectFromCte(ranked.cte)
  .where(r => lte(r.rank, 1))
  .select(r => ({ userId: r.userId, title: r.title }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, title: 'Alice Post 2' }, { userId: 2, title: 'Bob Post' }]
```

```sql
WITH "ranked_posts" AS (SELECT "posts"."id" as "id", "posts"."user_id" as "userId", "posts"."title" as "title", row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC) as "rank"
FROM "posts")
SELECT "ranked_posts"."userId" as "userId", "ranked_posts"."title" as "title"
FROM "ranked_posts"
WHERE "ranked_posts"."rank" <= $1
ORDER BY "userId" ASC
-- params: [ 1 ]
```

The tempting alternatives: loading every child and slicing in JS is 1 statement without the `LIMIT` (every post of
every user travels):

```ts
const all = await db.users
  .orderBy(u => u.id)
  .select(u => ({ username: u.username, posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList() }))
  .toList();
const sliced = all.map(u => ({ username: u.username, topPost: [...u.posts].sort((x, y) => y.views - x.views).slice(0, 1) }));
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
) sub) "lateral_0" ON true
ORDER BY "users"."id" ASC
```

and filtering the window value in the query that computes it,
`db.posts.select(p => ({ id: p.id, rank: win.rowNumber().over(…) })).where(r => eq(r.rank, 1))`, throws before
anything is sent: `` `rank` is a window function value: PostgreSQL computes window functions after WHERE and the joins,
so it cannot be filtered in the query that computes it — compute it in a CTE (DbCteBuilder.with) and filter where the
CTE is read: db.selectFromCte(cte).where(…) ``.

> **Efficiency:** under `lateral` the LIMIT applies inside each parent's subquery: with an index on the foreign key and
> the order column, PostgreSQL reads N rows per parent. Under `cte` the collection numbers every child of every parent
> with `ROW_NUMBER()`. The window CTE ranks every row of its body: filter the body with `where()` to shrink it. Add a
> unique tie-breaker (`p.id`) to the order.

Guides: [Filter, order and limit each parent's children](./guides/querying.md#filter-order-and-limit-each-parents-children),
[Keep the top N rows per group](./guides/cte-guide.md#keep-the-top-n-rows-per-group-rank-in-a-cte).

### Insert many rows: `insertBulk()` and `fromRows()`

`insertBulk(rows)` writes all rows as one multi-row `INSERT`, and `.returning(selector)` reads their generated keys in
the same statement. For a large or variable-size set, `insertFrom(fromRows(…))` (since 1.0.29) keeps one statement
text for any row count.

```ts
const created = await db.tags
  .insertBulk([{ name: 'Autumn' }, { name: 'Spring' }, { name: 'Outdoor' }])
  .returning(t => ({ id: t.id, name: t.name }));
// [{ id: 4, name: 'Autumn' }, { id: 5, name: 'Spring' }, { id: 6, name: 'Outdoor' }]
```

```sql
INSERT INTO "tags" ("name") VALUES ($1), ($2), ($3) RETURNING "id" AS "id", "name" AS "name"
-- params: [ "Autumn", "Spring", "Outdoor" ]
```

The tempting alternative, an awaited insert per row, sent 3 statements, each committing on its own:

```ts
for (const name of ['Indoor', 'Kids', 'Senior']) {
  await db.tags.insert({ name });
}
```

```sql
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Indoor" ]

INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Kids" ]

INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Senior" ]
```

`fromRows()` binds one array parameter per column, so 2 rows and 4 rows send the same text:

```ts
import { fromRows } from 'linkgress-orm';

const names = ['Ski', 'Snowboard'];
await db.tags.insertFrom(
  fromRows(db.tags, names.map(name => ({ name })), { columns: ['name'] }).asSubquery('table'),
  src => ({ name: src.name }),
);
const moreNames = ['Hike', 'Bike', 'Climb', 'Swim'];
await db.tags.insertFrom(
  fromRows(db.tags, moreNames.map(name => ({ name })), { columns: ['name'] }).asSubquery('table'),
  src => ({ name: src.name }),
);
```

```sql
INSERT INTO "tags" ("name") SELECT "src"."name" FROM (SELECT "rows"."name" as "name"
FROM unnest(CAST($1 AS varchar[])) AS "rows"("name")) AS "src"
-- params: [ "{\"Ski\",\"Snowboard\"}" ]

INSERT INTO "tags" ("name") SELECT "src"."name" FROM (SELECT "rows"."name" as "name"
FROM unnest(CAST($1 AS varchar[])) AS "rows"("name")) AS "src"
-- params: [ "{\"Hike\",\"Bike\",\"Climb\",\"Swim\"}" ]
```

When to switch from `insertBulk()` to `fromRows()`: `insertBulk()` stays ONE statement up to one chunk of
`floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows: 39,321 rows of 1 column, 13,107 rows of 3 (measured:
10,000 one-column rows with `.returning()` were 1 statement, 13,108 three-column rows 2). Above one chunk, or when the
statement text must not depend on the row count (prepared statements), use `insertFrom(fromRows(…))`; it reads the
generated keys with `.returning()` too (40,000 rows with `.returning()` measured: 1 statement):

```ts
import { fromRows } from 'linkgress-orm';

const keyed = await db.tags
  .insertFrom(fromRows(db.tags, [{ name: 'Ski' }, { name: 'Snowboard' }], { columns: ['name'] }).asSubquery('table'), src => ({ name: src.name }))
  .returning(t => ({ id: t.id, name: t.name }));
// [{ id: 4, name: 'Ski' }, { id: 5, name: 'Snowboard' }]
```

```sql
INSERT INTO "tags" ("name") SELECT "src"."name" FROM (SELECT "rows"."name" as "name"
FROM unnest(CAST($1 AS varchar[])) AS "rows"("name")) AS "src" RETURNING "id" AS "id", "name" AS "name"
-- params: [ "{\"Ski\",\"Snowboard\"}" ]
```

> **Efficiency:** `insertBulk()` sends one statement per chunk and its text changes with the row count;
> `insertFrom(fromRows(…))` is one statement with one parameter per column for any number of rows (70,000 rows: 1
> statement instead of 2).

> **Pitfall:** PostgreSQL does not guarantee the order of RETURNING rows: to map generated keys back to the input rows,
> return a natural key with the id (`name` above), in both forms.

> **Pitfall:** chunks are separate statements: outside `db.transaction()` a failure in a later chunk leaves the earlier
> ones written. A column that some rows set and others omit is written as NULL for the others, not as its DEFAULT.

Guides: [Insert many rows](./guides/insert-update-guide.md#insert-many-rows-in-one-statement-insertbulk),
[Insert a large or variable-size set](./guides/insert-update-guide.md#insert-a-large-or-variable-size-set-in-one-fixed-statement-fromrows).

### Insert rows the database computes: `insertFrom()`

`insertFrom(source, map)` sends `INSERT … SELECT` from a table subquery: the database computes the rows from its current
data and writes them in the same statement. Use it for next-number inserts, copies and rows derived from other tables.

```ts
import { add, coalesce, eq } from 'linkgress-orm';

const next = db.orderTasks
  .where(ot => eq(ot.orderId, 1))
  .select(ot => ({ sortOrder: ot.sortOrder }))
  .groupBy(() => ({}))
  .select(g => ({ next: add(coalesce(g.max(ot => ot.sortOrder), 0), 1) }))
  .asSubquery('table');
const appended = await db.orderTasks
  .insertFrom(next, src => ({ orderId: 1, taskId: 2, sortOrder: src.next }))
  .returning(ot => ({ orderId: ot.orderId, taskId: ot.taskId, sortOrder: ot.sortOrder }));
// [{ orderId: 1, taskId: 2, sortOrder: 2 }]
```

```sql
INSERT INTO "order_task" ("order_id", "task_id", "sort_order") SELECT CAST($4 AS integer), CAST($5 AS integer), "src"."next" FROM (SELECT (COALESCE(MAX("order_task"."sort_order"), $2) + $3) as "next"
FROM "order_task"
WHERE "order_task"."order_id" = $1) AS "src" RETURNING "order_id" AS "orderId", "task_id" AS "taskId", "sort_order" AS "sortOrder"
-- params: [ 1, 0, 1, 1, 2 ]
```

The tempting alternative, reading the maximum, computing in JS and inserting, sent 2 statements, and the number can be
stale by the time it is written:

```ts
const top = await db.orderTasks
  .where(ot => eq(ot.orderId, 2))
  .select(ot => ({ sortOrder: ot.sortOrder }))
  .groupBy(() => ({}))
  .select(g => ({ max: g.max(ot => ot.sortOrder) }))
  .firstOrDefault();
await db.orderTasks.insert({ orderId: 2, taskId: 1, sortOrder: (top?.max ?? 0) + 1 });
```

```sql
SELECT MAX("order_task"."sort_order") as "max"
FROM "order_task"
WHERE "order_task"."order_id" = $1
LIMIT 1
-- params: [ 2 ]

INSERT INTO "order_task" ("order_id", "task_id", "sort_order") VALUES ($1, $2, $3)
-- params: [ 2, 1, 2 ]
```

> **Pitfall:** two concurrent next-number writers still compute the same value. With a unique index on the number,
> pass `expectedErrorCodes: ['23505']` and retry, or serialize the writers with a transaction-scoped advisory lock
> ([Inserts, updates and deletes](./guides/insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom)).

Guide: [Insert rows computed from the database](./guides/insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom).

### Insert or skip, insert or update: `onConflictDoNothing` and `upsertBulk()`

Let a unique index decide in the INSERT itself. `insertBulk(rows, { onConflictDoNothing: true })` skips rows any unique
index rejects; `upsertBulk(rows, { primaryKey, updateColumns })` updates the rows whose key exists. Both are one
statement and safe against concurrent writers.

```ts
const inserted = await db.users
  .insertBulk(
    [{ username: 'alice', email: 'alice@new.com' }, { username: 'dave', email: 'dave@test.com' }],
    { onConflictDoNothing: true },
  )
  .returning(u => ({ id: u.id, username: u.username }));
// [{ id: 5, username: 'dave' }]: alice exists and was skipped

const upserted = await db.users
  .upsertBulk(
    [
      { username: 'charlie', email: 'charlie@new.com', age: 46 },
      { username: 'frank', email: 'frank@test.com', age: 52 },
    ],
    { primaryKey: 'username', updateColumns: ['email', 'age'] },
  )
  .returning(u => ({ id: u.id, username: u.username, email: u.email }));
// [{ id: 3, username: 'charlie', email: 'charlie@new.com' }, { id: 7, username: 'frank', email: 'frank@test.com' }]
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING RETURNING "id" AS "id", "username" AS "username"
-- params: [ "alice", "alice@new.com", "dave", "dave@test.com" ]

INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age" RETURNING "id" AS "id", "username" AS "username", "email" AS "email"
-- params: [ "charlie", "charlie@new.com", 46, "frank", "frank@test.com", 52 ]
```

The tempting alternatives check first and then write: 3 statements to insert-or-skip 2 rows, 4 to upsert 2 rows, and a
concurrent writer passes the check and fails with 23505:

```ts
import { eq } from 'linkgress-orm';

for (const row of [{ username: 'bob', email: 'bob@new.com' }, { username: 'erin', email: 'erin@test.com' }]) {
  const exists = await db.users.where(u => eq(u.username, row.username)).exists();
  if (!exists) await db.users.insert(row);
}

for (const row of [{ username: 'alice', email: 'alice@upd.com', age: 26 }, { username: 'gina', email: 'gina@test.com', age: 33 }]) {
  const current = await db.users.where(u => eq(u.username, row.username)).select(u => ({ id: u.id })).firstOrDefault();
  if (current) await db.users.where(u => eq(u.id, current.id)).update({ email: row.email, age: row.age });
  else await db.users.insert(row);
}
```

```sql
SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."username" = $1)
-- params: [ "bob" ]

SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."username" = $1)
-- params: [ "erin" ]

INSERT INTO "users" ("username", "email") VALUES ($1, $2)
-- params: [ "erin", "erin@test.com" ]

SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]

UPDATE "users" SET "email" = $1, "age" = $2 WHERE "users"."id" = $3
-- params: [ "alice@upd.com", 26, 1 ]

SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "gina" ]

INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3)
-- params: [ "gina", "gina@test.com", 33 ]
```

`onConflictDoNothing` skips a conflict on ANY unique index. To skip only on one key, name it and update nothing; to
update only when a condition holds (a newer version, a larger value), add `updateWhere`. Both stay one statement:

```ts
import { lt } from 'linkgress-orm';

const onlyNew = await db.users
  .upsertBulk([{ username: 'bob', email: 'ignored@test.com' }, { username: 'erin', email: 'erin@test.com' }], {
    primaryKey: 'username',
    updateColumnFilter: () => false,
  })
  .returning(u => ({ id: u.id, username: u.username }));
// [{ id: 5, username: 'erin' }]: bob exists and was skipped

const newer = await db.users
  .upsertBulk([{ username: 'alice', email: 'alice@new.com', age: 26 }], {
    primaryKey: 'username',
    updateWhere: (existing, excluded) => lt(existing.age, excluded.age),   // update only when the new age is larger
  })
  .returning(u => ({ id: u.id, email: u.email, age: u.age }));
// [{ id: 1, email: 'alice@new.com', age: 26 }]: 25 < 26, so the row was updated; [] when the condition is false
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT ("username") DO NOTHING RETURNING "id" AS "id", "username" AS "username"
-- params: [ "bob", "ignored@test.com", "erin", "erin@test.com" ]

INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age" WHERE "users"."age" < "excluded"."age" RETURNING "id" AS "id", "email" AS "email", "age" AS "age"
-- params: [ "alice", "alice@new.com", 26 ]
```

`updateSet: (existing, excluded) => ({ … })` computes the assignments (accumulate, keep the first non-null value),
`setWhere` adds the condition as raw SQL, `targetWhere` names a partial unique index as the arbiter, and
`values(rows).onConflict({ constraint }).doUpdate({ set, where })` covers `ON CONFLICT ON CONSTRAINT` and explicit SET
values ([Insert or update by a unique key](./guides/insert-update-guide.md#insert-or-update-by-a-unique-key-upsertbulk)).

> **Pitfall:** give `upsertBulk()` rows with one column set: a column some rows lack is sent as NULL for them and
> overwrites the stored value on conflict. For partial rows use `bulkUpdate()`. Without a unique index on the key, use
> `mergeBulk(rows, { on })` (PostgreSQL 15+), which has no protection against concurrent writers of the same keys.

Guides: [Insert the rows that are new](./guides/insert-update-guide.md#insert-the-rows-that-are-new-and-skip-the-rest),
[Insert or update by a unique key](./guides/insert-update-guide.md#insert-or-update-by-a-unique-key-upsertbulk),
[Compute the update from the stored and the proposed row](./guides/insert-update-guide.md#compute-the-update-from-the-stored-and-the-proposed-row-updateset--updatewhere).

### Update many rows: `eqAny()` and `bulkUpdate()`

The same change to many rows is one `where(…).update()`; filter a list of ids with `eqAny()`, which gives every list
length one statement text (`inArrayOpt()`, the default for reads, matches the same rows with one `IN` text per length
up to 8). Rows
that each get their own values are one `bulkUpdate(rows)`, and a row may carry only the columns it changes.

```ts
import { eqAny } from 'linkgress-orm';

const touched = await db.users.where(u => eqAny(u.id, [1, 2, 3])).update({ isActive: true }).affectedCount(); // 3

await db.users.bulkUpdate([
  { id: 1, age: 27 },
  { id: 2, email: 'bob@bulk.com' },
]);
```

```sql
UPDATE "users" SET "is_active" = $1 WHERE ("users"."id" = ANY($2::integer[]))
-- params: [ true, "{1,2,3}" ]

UPDATE "users" AS t
SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END, "email" = CASE WHEN v."email__provided" THEN v."email" ELSE t."email" END
FROM (VALUES ($1::integer, $2::integer, true, NULL::text, false), ($3::integer, NULL::integer, false, $4::text, true)) AS v("id", "age", "age__provided", "email", "email__provided")
WHERE t."id" = v."id"
-- params: [ 1, 27, 2, "bob@bulk.com" ]
```

The tempting alternative, an update per row, sent one statement per row (3 and 2 here):

```ts
import { eq } from 'linkgress-orm';

for (const id of [1, 2, 3]) {
  await db.users.where(u => eq(u.id, id)).update({ isActive: true });
}
for (const row of [{ id: 1, age: 28 }, { id: 2, age: 36 }]) {
  await db.users.where(u => eq(u.id, row.id)).update({ age: row.age });
}
```

```sql
UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 1 ]

UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 2 ]

UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 3 ]

UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [ 28, 1 ]

UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [ 36, 2 ]
```

> **Efficiency:** `eqAny()` binds the list as one array parameter: one statement text for any number of ids.
> `bulkUpdate()` sends one statement per chunk; a key that matches no row updates nothing, without an error.

> **Pitfall:** a key present with the value `undefined` is written as NULL (`update({ age: undefined })`); leave the key
> out to keep a column. `db.users.update(…)` without `where()` updates every row.

Guides: [Update the rows that match a condition](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate),
[Update many rows, each with its own values](./guides/insert-update-guide.md#update-many-rows-each-with-its-own-values-bulkupdate).

### Read back what a write changed: `.returning()` and `.affectedCount()`

`.returning(selector)` reads the written rows — generated keys, defaults, new values — in the write's own statement;
`.affectedCount()` returns the number of rows an update or delete changed. A bare `await` of a write resolves
`undefined`.

```ts
import { eq, sql } from 'linkgress-orm';

const updated = await db.users
  .where(u => eq(u.username, 'bob'))
  .update({ age: 37 })
  .returning(u => ({ id: u.id, age: u.age }));
// [{ id: 2, age: 37 }]

const gift = await db.tags.insert({ name: 'Gift' }).returning(t => ({ id: t.id }));   // { id: 4 }

const changed = await db.posts
  .where(p => eq(p.userId, 1))
  .update(p => ({ views: sql<number>`${p.views} + ${1}` }))
  .affectedCount();                                                                    // 2
```

```sql
UPDATE "users" SET "age" = $1 WHERE "users"."username" = $2 RETURNING "id" AS "id", "age" AS "age"
-- params: [ 37, "bob" ]

INSERT INTO "tags" ("name") VALUES ($1) RETURNING "id" AS "id"
-- params: [ "Gift" ]

UPDATE "posts" SET "views" = "posts"."views" + $1 WHERE "posts"."user_id" = $2
-- params: [ 1, 1 ]
```

The tempting alternatives, a write followed by a SELECT, sent 2 statements each:

```ts
await db.users.where(u => eq(u.username, 'bob')).update({ age: 38 });
const reread = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, age: u.age })).toList();

await db.tags.insert({ name: 'Sale' });
const sale = await db.tags.where(t => eq(t.name, 'Sale')).select(t => ({ id: t.id })).firstOrDefault();
```

```sql
UPDATE "users" SET "age" = $1 WHERE "users"."username" = $2
-- params: [ 38, "bob" ]

SELECT "users"."id" as "id", "users"."age" as "age"
FROM "users"
WHERE "users"."username" = $1
-- params: [ "bob" ]

INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Sale" ]

SELECT "tags"."id" as "id"
FROM "tags"
WHERE "tags"."name" = $1
LIMIT 1
-- params: [ "Sale" ]
```

> **Efficiency:** a selector returns only the columns it names; `.returning()` without one returns every column. A
> selector that reads a navigation or a collection wraps the write in a `"__mutation__"` CTE, still one statement. On
> PostgreSQL 18, `.returning((row, old) => ({ previous: old.status }))` also reads the value before the update.

Guide: [Read back what a write changed](./guides/insert-update-guide.md#read-back-what-a-write-changed-returningselector).

### Insert a parent and its children: `insertWithChildren()`

`insertWithChildren({ row, children, returning })` inserts one parent and its child rows in ONE statement; the children
receive the new parent key through a CTE. `insertBulkWithChildren()` does the same for many parents.

```ts
const { parent, children } = await db.users.insertWithChildren({
  row: { username: 'erin', email: 'erin@test.com' },
  children: {
    table: db.posts,
    foreignKey: 'userId',
    rows: [{ title: 'Hello' }, { title: 'World' }],
  },
  returning: {
    parent: u => ({ id: u.id, username: u.username }),
    children: p => ({ id: p.id, title: p.title }),
  },
});
// parent: { id: 4, username: 'erin' }; children: [{ id: 4, title: 'Hello' }, { id: 5, title: 'World' }]
```

```sql
WITH "__iwc_parent__" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES ($1::varchar, $2::text)) AS v("username", "email")
RETURNING *
),
"__mutation__" AS (
INSERT INTO "posts" ("user_id", "title")
SELECT p."id", v."title" FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, $3::varchar), (1, $4::varchar)) AS v("__iwc_ord", "title")
ORDER BY v."__iwc_ord"
RETURNING "id" AS "id", "title" AS "title", "id" AS "__iwc_child_pk__"
)
SELECT "__mutation__".*, "__iwc_parent_j__"."id" AS "__iwc_parent__.id", "__iwc_parent_j__"."username" AS "__iwc_parent__.username"
FROM "__mutation__"
CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"
ORDER BY "__mutation__"."__iwc_child_pk__"
-- params: [ "erin", "erin@test.com", "Hello", "World" ]
```

The tempting alternative, insert the parent, read its id, insert the children, sent 2 statements and is not atomic
outside a transaction:

```ts
const dave = await db.users.insert({ username: 'dave', email: 'dave@test.com' }).returning(u => ({ id: u.id }));
await db.posts.insertBulk([
  { userId: dave.id, title: 'Draft 1' },
  { userId: dave.id, title: 'Draft 2' },
]);
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: [ "dave", "dave@test.com" ]

INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2), ($3, $4)
-- params: [ "Draft 1", 5, "Draft 2", 5 ]
```

> **Pitfall:** `children.rows` must not be empty (a childless parent is a plain `insert()`), child rows must not carry
> the foreign key, they must fit one statement (no chunking), and the parent needs a single-column generated key;
> otherwise it throws before sending anything. A `returning.parent` selector that reads more than the parent's own
> columns (a navigation, a collection) is read back by a SELECT after the statement: 2 statements (measured with
> `u => ({ id: u.id, postCount: u.posts!.count() })`).

Guide: [Insert a parent and its children](./guides/insert-update-guide.md#insert-a-parent-and-its-children-in-one-statement-insertwithchildren).

### Write several independent changes in one round trip: `MutationBatch`

`MutationBatch` composes independent writes on any tables — inserts, bulk updates, upserts, deletes and updates by a
list — into ONE data-modifying-CTE statement: one round trip, atomic, with a row count per leg. An insert leg can return
its rows (`returning`, since 1.0.29).

```ts
import { MutationBatch } from 'linkgress-orm';

const batch = new MutationBatch();
batch.addInsertBulk(db.tags, [{ name: 'Winter sale' }, { name: 'Gift' }], 'tags', { returning: ['id', 'name'] });
batch.addBulkUpdate(db.products, [{ id: 2, name: 'Lift Ticket (day)' }], 'products');
batch.addDeleteWhereIn(db.postComments, 'id', [1, 2], 'comments');
await batch.executeBatch();
batch.getAffectedCount('tags');       // 2
batch.getLegRows('tags');             // [{ id: 4, name: 'Winter sale' }, { id: 5, name: 'Gift' }]
batch.getAffectedCount('products');   // 1
batch.getAffectedCount('comments');   // 2
```

```sql
WITH "__mb_0" AS (
INSERT INTO "tags" ("name") VALUES ($1), ($2)
RETURNING "id" AS "id", "name" AS "name"
),
"__mb_1" AS (
UPDATE "products" AS t
SET "name" = CASE WHEN v."name__provided" THEN v."name" ELSE t."name" END
FROM (VALUES ($3::integer, $4::varchar, true)) AS v("id", "name", "name__provided")
WHERE t."id" = v."id"
RETURNING 1
),
"__mb_2" AS (
DELETE FROM "post_comments" WHERE "id" IN ($5, $6)
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT COALESCE(json_agg(row_to_json("__mb_0")), '[]'::json) FROM "__mb_0") AS "0__rows", (SELECT count(*)::int FROM "__mb_1") AS "1", (SELECT count(*)::int FROM "__mb_2") AS "2"
-- params: [ "Winter sale", "Gift", 2, "Lift Ticket (day)", 1, 2 ]
```

The tempting alternative, the writes awaited one by one, sent 3 statements, each committing on its own:

```ts
import { eq } from 'linkgress-orm';

await db.tags.insertBulk([{ name: 'Autumn' }, { name: 'Spring' }]);
await db.products.bulkUpdate([{ id: 1, name: 'Hardback (2nd ed.)' }]);
await db.postComments.where(c => eq(c.id, 3)).delete();
```

```sql
INSERT INTO "tags" ("name") VALUES ($1), ($2)
-- params: [ "Autumn", "Spring" ]

UPDATE "products" AS t
SET "name" = CASE WHEN v."name__provided" THEN v."name" ELSE t."name" END
FROM (VALUES ($1::integer, $2::varchar, true)) AS v("id", "name", "name__provided")
WHERE t."id" = v."id"
-- params: [ 1, "Hardback (2nd ed.)" ]

DELETE FROM "post_comments" WHERE "post_comments"."id" = $1
-- params: [ 3 ]
```

> **Pitfall:** all legs run on one snapshot: a leg does not see another leg's rows, and two legs must never touch the
> same row. A write that needs another write's RETURNING is a data-modifying CTE
> ([Feed one write into another](./guides/insert-update-guide.md#feed-one-write-into-another-in-one-statement-data-modifying-ctes)).
> `getLegRows()` returns raw JSON values, without column mappers, in no particular order.

Guide: [Run independent writes in one round trip](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch).

### Read and write inside a transaction: `tx.<table>`

`db.transaction(async tx => …)` runs its callback on one pooled connection between BEGIN and COMMIT (ROLLBACK when it
throws). Inside it, read and write through `tx.<table>`; `forUpdate()` locks the rows a read returns until the
transaction ends.

```ts
import { eq } from 'linkgress-orm';

const newAge = await db.transaction(async tx => {
  const row = await tx.users
    .where(u => eq(u.id, 1))
    .select(u => ({ id: u.id, age: u.age }))
    .forUpdate()
    .firstOrDefault();
  if (!row) return null;
  await tx.users.where(u => eq(u.id, row.id)).update({ age: (row.age ?? 0) + 1 });
  return (row.age ?? 0) + 1;
});
// 26
```

```sql
SELECT "users"."id" as "id", "users"."age" as "age"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
FOR UPDATE
-- params: [ 1 ]

UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [ 26, 1 ]
```

The driver also sends BEGIN before and COMMIT after these statements: 2 more round trips, which the capture does not
show. The tempting mistake is `db.<table>` inside the callback: it runs on another pooled connection, outside the
transaction, and did not see the row the transaction had inserted (the markers show which connection ran each
statement):

```ts
await db.transaction(async tx => {
  await tx.tags.insert({ name: 'inside' });
  const seenOutside = await db.tags.where(t => eq(t.name, 'inside')).exists();   // false
  const seenInside = await tx.tags.where(t => eq(t.name, 'inside')).exists();    // true
});
```

```sql
-- #1 in-transaction
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "inside" ]
-- #2 query
SELECT EXISTS(SELECT 1
FROM "tags"
WHERE "tags"."name" = $1)
-- params: [ "inside" ]
-- #3 in-transaction
SELECT EXISTS(SELECT 1
FROM "tags"
WHERE "tags"."name" = $1)
-- params: [ "inside" ]
```

> **Efficiency:** one statement — a write, a `MutationBatch`, a data-modifying CTE — is already atomic and needs no
> transaction and its 2 extra round trips. Inside a transaction every statement queues on its one connection:
> `Promise.all` there does not run them in parallel.

> **Pitfall:** return values from the callback, never `tx` or objects built from it: after the callback settles they
> throw `TransactionEndedError`. A future or prepared query built on `db` and run inside the callback runs outside the
> transaction.

Guides: [Make several statements atomic](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction),
[Run a transaction](./database-clients.md#run-a-transaction).

## See the SQL a query emits

Verify the statement and the round trips of a code path before trusting it. Read a query's text without running it,
or log every statement as it runs.

| To see | Call | Statements sent |
|---|---|---|
| a select, a join or a grouped select, without running it | `q.future().getSql()`, `q.future().getParams()` | 0 |
| a union, a `selectFromCte()` or a `selectFromSet()` query | `.toSql()` (text only) | 0 |
| an insert (since 1.0.22), an update or a delete | `.toStatement(selector?)` → `{ sql, params }` | 0 |
| a `prepare()`d query | `prepared.getSql()` | 0 |
| every statement a code path sends, while it runs | `logQueries: true` (+ `logParameters`) with a `logger` | the statements themselves |

```ts
import { gt } from 'linkgress-orm';

const query = db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, postCount: u.posts!.count() }));
const future = query.future();
const text = future.getSql();      // nothing is sent
const params = future.getParams(); // [30]
const statement = db.tags.insert({ name: 'Spring' }).toStatement(t => ({ id: t.id }));
// { sql: 'INSERT INTO "tags" ("name") VALUES ($1) RETURNING "id" AS "id"', params: ['Spring'] }
// On a real server: await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params)
// EXPLAIN (ANALYZE …) RUNS the statement: for statement.sql (a write) use plain EXPLAIN,
// or run the ANALYZE form inside a transaction you roll back
```

`text`:

```sql
SELECT "users"."id" as "id", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount"
FROM "users"
WHERE "users"."age" > $1
```

To count the round trips of a code path, give a context a `logger` and count the `'sql'` messages that start with
`'\n[SQL Query'`: one per round trip the executor makes (`'\n[SQL Query]'` for one statement;
`'\n[SQL Query - Multi-Statement]'` and `'\n[SQL Query - Fully Optimized Multi-Statement]'` for the scripts the
`temptable` strategy sends in one round trip on `PostgresClient`, `BunClient` and `PGliteClient`).

```ts
import { eq } from 'linkgress-orm';
import type { LogSection } from 'linkgress-orm';

const lines: Array<{ section?: LogSection; message: string }> = [];
const debugDb = new AppDatabase(client, {
  logQueries: true,
  logParameters: true,
  logger: (message: string, section?: LogSection) => {
    lines.push({ section, message });
  },
});
await debugDb.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ id: u.id, posts: u.posts!.select(p => ({ title: p.title })).toList() }))
  .toList();
const statements = lines.filter(l => l.section === 'sql' && l.message.startsWith('\n[SQL Query')).length;   // 1
```

The logger received three calls for that one statement:

| `section` | `message` |
|---|---|
| `'sql'` | `'\n[SQL Query]'` |
| `'sql'` | the statement text: `SELECT "users"."id" as "id", COALESCE("lateral_0".data, '[]'::json) as "posts" FROM "users" LEFT JOIN LATERAL (…) "lateral_0" ON true WHERE "users"."username" = $1` |
| `'params'` | `'[Parameters] ["alice"]'` |

- Logging misses what bypasses the executor: `db.query()` (verified: `debugDb.query('SELECT 1 AS one')` added no log
  line), `PreparedQuery.execute()`, the multi-statement message of `FutureQueryRunner.runAsync()`, statements on a
  `connect()` lease, the BEGIN / COMMIT of `db.transaction()` and the statements `PostgresClient` wraps around
  `.withTimeout()`.
- A `QueryBatch` and the `temptable` strategy send other statements than one leg's `getSql()` shows: observe those
  with `logQueries`.
- Plans come from a real server only; the in-memory database used for this page shows the statements, not PostgreSQL's
  plans or timings.

Details: [See the SQL a query sends](./guides/configuration.md#see-the-sql-a-query-sends),
[Log every statement while debugging](./guides/configuration.md#log-every-statement-while-debugging-logqueries).

## Collection strategies at a glance

The context option `collectionStrategy` decides how collections render. The default is `'lateral'`; override it for one
query with `db.<table>.withQueryOptions({ collectionStrategy })`, first in the chain.

| Strategy | SQL shape | Statements | Wins when | Measured (`bench/versions`, 1.0.17, PostgreSQL 18.3, `PgClient`) |
|---|---|---|---|---|
| `lateral` (default) | `LEFT JOIN LATERAL (… WHERE "lateral_0_posts"."user_id" = "users"."id" …)` per list, a correlated subquery per aggregate | 1 | the query returns a fraction of the parents (a page, a lookup); top N per parent; collections of a joined table | 100 of 2,000 users, four collection reads: 1.32 ms (`cte`: 6.51 ms) |
| `cte` | `WITH "cte_0" AS (SELECT "__fk_user_id" as parent_id, json_agg(…) … GROUP BY "__fk_user_id") … LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id` | 1 | the query returns most parents, with nested collections | 100 products with prices and their groups, 2 nested levels: 2.70 ms (`lateral`: 5.43 ms) |
| `temptable` (experimental) | the base query, then per collection a temp table of parent ids, an aggregate, a read and a DROP | `PgClient`: 1 + 5 per collection; `PostgresClient`, `BunClient`, `PGliteClient`: 1 + 1 per collection (1 in all when the base query binds no parameter and every collection is a plain list of its own columns) | only after `lateral` and `cte` were both measured too slow | 100 users with their posts: 11.7 ms (`lateral` 1.22 ms, `cte` 1.19 ms) |

The same query under `cte`, set for this query only:

```ts
import { eq } from 'linkgress-orm';

const viaCte = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .where(u => eq(u.isActive, true))
  .select(u => ({ username: u.username, posts: u.posts!.select(p => ({ title: p.title })).toList() }))
  .toList();
// [{ username: 'alice', posts: [{ title: 'Alice Post 1' }, { title: 'Alice Post 2' }] }, { username: 'bob', posts: [{ title: 'Bob Post' }] }]
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
WHERE "users"."is_active" = $1
-- params: [ true ]
```

Under `temptable` on `PgClient` (a context built with `{ collectionStrategy: 'temptable' }`) the same query sent 6
statements:

```sql
SELECT "users"."id" as "__pk_id", "users"."username" as "username"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]

CREATE TEMP TABLE IF NOT EXISTS tmp_parent_ids_0 (
  id integer PRIMARY KEY
)

INSERT INTO tmp_parent_ids_0 VALUES ($1),($2)
-- params: [ 1, 2 ]

CREATE TEMP TABLE tmp_parent_ids_0_agg AS
SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title"
  FROM "posts"
  WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)
) sub
GROUP BY "__fk_user_id"

SELECT parent_id, data FROM tmp_parent_ids_0_agg

DROP TABLE IF EXISTS tmp_parent_ids_0, tmp_parent_ids_0_agg
```

- `lateral` costs about one foreign-key probe per parent row the query returns; `cte` aggregates every row of the child
  table, whatever the query's WHERE and LIMIT. Neither creates an index: declare one on every foreign key a collection
  reads (`entity.hasIndex('ix_post_comments_post_id', e => [e.postId])`).
- `temptable` races on a `PgClient` pool outside a transaction (its statements can land on different pooled
  connections, and a temp table lives in one session). Inside `db.transaction()` on `PostgresClient`, `BunClient` and
  `PGliteClient` it fails or returns empty collections: the transaction's client has no multi-statement method. A
  collection of a table joined with `innerJoin()` / `leftJoin()` needs `lateral` (`cte` and `temptable` refuse it).
- A count or an existence test of a collection in `where()` / `orderBy()` renders the same `EXISTS (…)` /
  `(SELECT COUNT(*) …)` under every strategy.

Details and the SQL of every shape: [Collection strategies](./collection-strategies.md#pick-a-strategy).

## Pitfalls

- **Don't** await a query per parent row to load children or related rows → **Do** project a collection or a
  navigation in `select()`: 1 statement instead of 1 + N (4 for 3 users).
- **Don't** read `user.posts` from an entity row → **Do** project `u.posts!.select(…).toList()`: navigation properties
  are never loaded, the property is `undefined` at run time.
- **Don't** write `(await q.toList()).length` → **Do** call `q.count()`: one number travels instead of every column of
  every match.
- **Don't** write `(await q.count()) > 0` → **Do** call `q.exists()`: `EXISTS` stops at the first matching row.
- **Don't** call the builder's `sum()`, `min()` and `max()` one after another → **Do** select `agg.*` aggregates in one
  `select()`: 1 statement instead of 3, values read as numbers (`sum()` returned `'450'`).
- **Don't** treat top-level `decimal` / `numeric` / `bigint` values as numbers → **Do** convert them where you read
  them, or aggregate with `agg.sum()`: the drivers deliver them as strings (`orders.totalAmount`, typed `number`,
  arrived as `'99.99'`).
- **Don't** await independent reads one by one → **Do** send them as one `QueryBatch`: 1 statement instead of N.
- **Don't** write `Promise.all([page.toList(), q.count()])` → **Do** use a `QueryBatch` with `addList(page)` +
  `addCount(page)`: 1 statement instead of 2, and the total stays right past the last page (`countOver()` reports 0
  there).
- **Don't** fetch ids, then query by them → **Do** use `inSubquery()`, `exists()` or a navigation: 1 statement instead
  of 2.
- **Don't** use `prepare()` for a hot path on `PostgresClient` → **Do** run the ordinary builder on a
  `preparedStatements: true` context, with `MockRowCache.setEnabled(true)`: `PreparedQuery.execute()` is never named
  (2 network round trips per call there) and skips logging and timeouts. On `PgClient`, `BunClient` and
  `PGliteClient`, `prepare()` is the choice.
- **Don't** send a query per id, or `inArray()` with lists of varying length → **Do** use `inArrayOpt()` or `eqAny()`:
  1 statement, and at most 8 `IN` texts, 1 array text and 1 empty-list text (`eqAny()`: 1 text) instead of one text
  per length.
- **Don't** join to the children to filter parents → **Do** use `exists(u.posts!.where(…))`: the join repeats the
  parent per match (alice twice).
- **Don't** use `notInArray()` / `notInSubquery()` over values that may be NULL → **Do** use `notExists()`: one NULL
  makes NOT IN return no row.
- **Don't** call `where()` on a projected window value → **Do** compute it in a CTE and filter where the CTE is read:
  the build throws before sending.
- **Don't** read a CTE from several subqueries without `.with(cte)` → **Do** attach it to the executing query with
  `.with(cte)`: otherwise each reader declares, binds and computes its own copy (params `[30, 30]`).
- **Don't** pass request input to `limit()` / `offset()` unvalidated → **Do** coerce it to an integer first: the
  values are inlined, `'1 OFFSET 2'` rendered `LIMIT 1 OFFSET 2`.
- **Don't** write `eq(col, filter.value)` when the value can be unset → **Do** skip the condition: `eq(col, undefined)`
  renders `IS NULL` and matches only NULL rows.
- **Don't** reuse a builder after `first()` / `firstOrDefault()`, or branch two queries off one `where()` → **Do**
  build each query in a function: builders are mutable, `first*()` leaves `LIMIT 1` on the builder and
  `base.where(x)` changes `base`.
- **Don't** await a write per row → **Do** use `insertBulk()`, `bulkUpdate()`, an `eqAny()` update or delete, or
  `insertFrom()`: 1 statement and one commit instead of n.
- **Don't** call `exists()`, then `insert()` → **Do** use `insertBulk(rows, { onConflictDoNothing: true })` or
  `upsertBulk()`: race-safe through the unique index, 1 statement instead of up to 2 per row.
- **Don't** read a row, compare in JS, then upsert → **Do** pass `updateWhere: (existing, excluded) => …` (or
  `updateSet`) to `upsertBulk()`: the comparison runs in the `DO UPDATE … WHERE` of the same statement.
- **Don't** write `const user = await db.users.insert(row)`, then read `user.id` → **Do** chain
  `.returning(u => ({ id: u.id }))`: a bare `await` resolves `undefined`.
- **Don't** send a SELECT after a write → **Do** use `.returning(selector)` or `.affectedCount()`: 1 statement instead
  of 2.
- **Don't** insert a parent, read its id, then insert its children → **Do** use `insertWithChildren()`: 1 atomic
  statement instead of 2.
- **Don't** await independent writes one by one → **Do** send them as one `MutationBatch`: 1 atomic statement instead
  of n.
- **Don't** give `upsertBulk()` rows with different column sets → **Do** keep one column set per call, or use
  `bulkUpdate()` for partial rows: a missing column is written as NULL and overwrites the stored value on conflict.
- **Don't** use `db.<table>` inside `db.transaction()` → **Do** use `tx.<table>`: `db` runs on another connection, which
  did not see the transaction's uncommitted row.
- **Don't** call `forUpdate()` on a `db.selectFromCte(…)` query to lock rows → **Do** put `.forUpdate()` on the query
  that is the CTE's body: the outer `FOR UPDATE` reads only CTEs, and PostgreSQL locks no row through it.
- **Don't** make `collectionStrategy: 'temptable'` the default → **Do** keep `lateral`, and use `cte` per query for
  nested trees over most parents: 6 statements instead of 1 for one collection on `PgClient`.
- **Don't** rely on `.withTimeout()` with `PgClient`, `BunClient` or `PGliteClient` → **Do** set `statement_timeout`
  on the pool, or use `db.transaction(fn, { timeoutMs })` (`SET LOCAL statement_timeout`): only `PostgresClient`
  applies a per-query timeout, the other clients ignore it, and PGlite cannot cancel a statement at all.

## See also

- [Querying](./guides/querying.md) — every read in detail: projections, filters, list matching, paging, navigations, collections, joins, `agg`, `groupBy()`, windows, unions, raw SQL.
- [Batching and Prepared Queries](./guides/batching-and-prepared-queries.md) — `QueryBatch` rules and limits, futures, `FutureQueryRunner`, `prepare()` with placeholders.
- [Collection Strategies](./collection-strategies.md) — when a collection read is slow, or to choose between `lateral`, `cte` and `temptable`.
- [Lateral Navigation Joins](./guides/lateral-navigation-joins.md) — when few rows read through a foreign key into a large table (`lateralJoin()`).
- [Subqueries](./guides/subquery-guide.md) — `exists()`, `inSubquery()`, scalar subqueries and derived-table joins in one statement.
- [Aliased Subquery Scopes](./guides/aliased-scopes.md) — correlated subqueries over the row's own table: `db.<table>.as(alias)`.
- [CTEs](./guides/cte-guide.md) — a derived set read in several places, top N per group, data-modifying CTEs, `afterMutation()`.
- [Set-returning Functions](./guides/set-returning-functions.md) — JS lists and JS rows as relations: `unnest()`, `fromRows()`, `crossJoinLateral()`.
- [SQL Expression Helpers](./guides/sql-expressions.md) — casts, CASE, string, date and JSONB functions, `agg`, `win`.
- [Inserts, Updates, Upserts and Deletes](./guides/insert-update-guide.md) — every write API, `MutationBatch`, transactions and locks.
- [Configuration](./guides/configuration.md) — logging, prepared statements, timeouts, `LinkgressConfig`, `collectionStrategy`.
- [Database Clients](./database-clients.md) — round trips per driver, timeouts, sessions and transactions per client.
- [Schema Configuration](./guides/schema-configuration.md) — indexes on the foreign keys and filter columns these queries read.
- [Getting Started](./getting-started.md) — a context, the schema and the first typed queries.
- [API index](./api-index.md) — one export or builder method, one line each.
