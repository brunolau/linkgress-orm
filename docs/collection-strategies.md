# Collection Strategies

> **For agents:** Which `collectionStrategy` should render the collections of a query (`hasMany` lists, `count()` / `sum()` / `min()` / `max()` / `exists()`, value lists), and what SQL and how many round trips does each strategy cost?
> **Use this page when:** choosing or overriding `collectionStrategy`, predicting the SQL a collection emits, a query with collections is slow, deciding which foreign keys to index. **Look elsewhere when:** writing the collection itself (`select()`, `where()`, `orderBy()`, `limit()`, aggregates) → [Querying](./guides/querying.md); probing one reference navigation per row → [Lateral Navigation Joins](./guides/lateral-navigation-joins.md)
> **Key APIs:** `collectionStrategy` (`'lateral'` default, `'cte'`, `'temptable'`), `withQueryOptions()`, `entity.hasIndex()` · **Round trips:** `lateral` 1 · `cte` 1 · `temptable` 1 + 5 per collection on `PgClient`, 1 + 1 per collection on `PostgresClient` / `BunClient` / `PGliteClient` (1 in all on its fast path)

A collection is a `hasMany` navigation read inside a projection: `u.posts!.select(…).toList()`, `u.posts!.count()`. Every strategy returns it inside the parent row and never issues one query per parent row. The strategies differ in the SQL, the round trips and how much of the child table the server reads.

Examples run against `db`, an `AppDatabase` (the example model: [Example Model and Seed Data](./example-model.md)) seeded with the test data: users alice (2 posts), bob (1 post) and charlie (inactive, no posts). Every SQL block is the statement the library sent, captured on the in-memory PostgreSQL-compatible database.

## Contents

- [Pick a strategy](#pick-a-strategy)
- [Set the strategy for a context or for one query](#set-the-strategy-for-a-context-or-for-one-query)
- [Compare the statements of each strategy on one query](#compare-the-statements-of-each-strategy-on-one-query)
- [Read the SQL of the lateral strategy (default)](#read-the-sql-of-the-lateral-strategy-default)
- [Read the SQL of the cte strategy](#read-the-sql-of-the-cte-strategy)
- [Run the temptable strategy safely (experimental)](#run-the-temptable-strategy-safely-experimental)
- [Know when another strategy is rendered](#know-when-another-strategy-is-rendered)
- [Index the foreign keys collections read](#index-the-foreign-keys-collections-read)
- [Check what every strategy supports](#check-what-every-strategy-supports)
- [Measure the strategies on your own data](#measure-the-strategies-on-your-own-data)
- [Reference: options, types and exports](#reference-options-types-and-exports)
- [Internals for contributors](#internals-for-contributors)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Pick a strategy

Rules, in order:

1. **Keep the default `lateral`.** It is one statement, its cost grows with the parent rows the query returns (one foreign-key probe each), and in the measurements below it was within 3 % of `cte` or faster in every scenario but one.
2. **Index every foreign key a collection reads** with `entity.hasIndex()`. A `hasMany` / `hasOne` relation creates no index ([details](#index-the-foreign-keys-collections-read)).
3. **Switch one query, not the context,** to `cte` with `withQueryOptions()` when it returns most of the parent table with nested collections, and measure it.
4. **Do not use `temptable`** unless `lateral` and `cte` were both measured too slow. It runs 1 + 5 statements per collection on `PgClient` and fails under concurrency outside `db.transaction()` there; on `PostgresClient`, `BunClient` and `PGliteClient` it fails INSIDE `db.transaction()` (empty collections without an error, or an exception; see [Failures reproduced](#failures-reproduced-on-the-harness); `BunClient` was not run, but its transaction client lacks `querySimple()` / `querySimpleMulti()` the same way).

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Collections of a filtered or paged root: one parent, a page, a subset | `lateral` (default) | a `LEFT JOIN LATERAL` or a correlated subquery per parent row · 1 | `cte`: aggregates every parent's children (four aggregates for 100 of 2,000 users: 6.51 ms against 1.32 ms) |
| Top-N or one item per parent: `orderBy().limit(n)`, `firstOrDefault()` | `lateral` | `ORDER BY … LIMIT n` inside each parent's subquery · 1 | `cte` / `temptable`: one `ROW_NUMBER()` over all children (a limited `selectMany()`: 3.1 ms under LATERAL, 31 ms or more under `cte` / `temptable`) |
| A plain child list per parent row, no limits | `lateral` or `cte` (measured within 3 % for 100 of 2,000 users) | per-parent LATERAL, or one `GROUP BY` CTE · 1 | `temptable`: 11.7 ms against 1.22 / 1.19 ms |
| Nested collections (children with grandchildren) over many parents (measured: 100 of 200 products) | `cte` for that query via `withQueryOptions()`, after measuring | one CTE per collection, the inner one joined inside the outer · 1 | switching the whole context to `cte`: it loses on filtered roots |
| A collection of a table joined with `innerJoin()` / `leftJoin()` | `lateral` | a correlated subquery (`count()`) or a `LEFT JOIN LATERAL` (a list) on the joined alias · 1 | `cte` / `temptable`: refused with an error |
| A count or an existence test in `where()` / `orderBy()` | any strategy | the same `EXISTS (…)` / `(SELECT COUNT(*) …)` under all three · 1 | `count() > 0` where `exists()` does |
| Parent sets where `lateral` and `cte` were both measured too slow | `temptable`: inside `db.transaction()` on `PgClient`, outside one on `PostgresClient` / `BunClient` / `PGliteClient` | base query, then a temp table and an aggregate per collection · 1 + 5 per collection (`PgClient`), 1 + 1 (the others) | `PgClient` outside a transaction under concurrency: queries fail; `PostgresClient` / `BunClient` / `PGliteClient` inside one: empty collections or an exception (`BunClient` not run; its transaction client lacks the same multi-statement methods) |

### Measurements behind the table

End to end through `PgClient` (the `pg` driver), Node 26.8.1, PostgreSQL 18.3 on localhost, linkgress 1.0.17, 8 rounds: `bench/versions/results/1.0.16-vs-1.0.17.md`. The data and the scenario code are in `bench/versions/harness.ts` (setup in `bench/versions/README.md`): 2,000 users, 20,003 posts (`posts.user_id` is indexed through `ix_posts_query`), 200 products × 4 prices × 2 capacity groups.

| Scenario | `lateral` | `cte` | `temptable` |
|---|---|---|---|
| 100 of 2,000 users with their posts (about 1,000) as a `toList()` | 1.22 ms | 1.19 ms | 11.7 ms |
| 100 users with `count()`, `max()`, `toNumberList()` and `firstOrDefault()` of their posts | 1.32 ms | 6.51 ms | not measured |
| 100 products → prices → capacity groups (with a navigation), 2 nested levels | 5.43 ms | 2.70 ms | not measured |
| all 2,000 users with their 20,003 posts | not measured | 18.4 ms | not measured |

The nested scenario is the only one `cte` won, on a model whose `product_prices.product_id` has no index. From `changelog/v1.0.11.md` (PostgreSQL 18, 2,000 libraries / 40,000 shelves / 200,000 books, foreign keys indexed, 200 libraries per query): two limited `selectMany()` shapes (`l.shelves.orderBy(code).limit(1).selectMany(s => s.books).count()`, and `l.shelves.selectMany(s => s.books.orderBy(pages).limit(1)).count()`, each shelf's shortest book) ran in 3.1 ms and 13.8 ms under LATERAL, and in 31–71 ms under `cte` and `temptable`, which rank every parent's rows with one `ROW_NUMBER()`.

## Set the strategy for a context or for one query

`collectionStrategy` in the context options applies to every query of the context; `withQueryOptions({ collectionStrategy })` on a table overrides it for one query. Both take `'lateral'` (the default), `'cte'` or `'temptable'`.

```ts
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './schema/appDatabase'; // the example model

const client = new PgClient({ connectionString: process.env.DATABASE_URL });

const db = new AppDatabase(client);                                     // 'lateral' (the default)
const exportDb = new AppDatabase(client, { collectionStrategy: 'cte' }); // every query of this context
```

```ts
import { eq } from 'linkgress-orm';

const activeUsers = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' }) // this query only
  .where(u => eq(u.isActive, true))
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
```

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title", 'views', "views")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
  FROM "posts"
) sub
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
WHERE "users"."is_active" = $1
-- params: [ true ]
```

`withQueryOptions()` exists on the table (`db.users`, a `DbEntityTable`, and the untyped `TableAccessor`) only: call it first in the chain. It returns a new table object and accepts every other `QueryOptions` key in the same call (`{ collectionStrategy: 'cte', logQueries: true }`).

> **Pitfall:** a select builder has no `withQueryOptions()`; `db.users.select(…).withQueryOptions(…)` does not compile. Put the call before `where()` / `select()`.

## Compare the statements of each strategy on one query

The query below returns the same rows under every strategy. What changes is the SQL, the round trips, and which posts the server reads.

```ts
import { eq } from 'linkgress-orm';

const activeUsers = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// [{ username: 'alice', posts: [{ title: 'Alice Post 1', views: 100 }, { title: 'Alice Post 2', views: 150 }] },
//  { username: 'bob', posts: [{ title: 'Bob Post', views: 200 }] }]
```

| Strategy · driver | Statements = round trips | How `posts` is read |
|---|---|---|
| `lateral` | 1 | once per active user: `"lateral_0_posts"."user_id" = "users"."id"` |
| `cte` | 1 | one `GROUP BY` over all of `posts`; nothing restricts it to the 2 active users |
| `temptable` · `PgClient` | 6 | `"posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)`, the ids the base query returned |
| `temptable` · `PostgresClient` / `BunClient` / `PGliteClient` | 2 | the same, as one multi-statement script with the ids written as literals |

### lateral: one statement, a subquery per parent row

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
WHERE "users"."is_active" = $1
-- params: [ true ]
```

### cte: one statement, one aggregate over the child table

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title", 'views', "views")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
  FROM "posts"
) sub
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
WHERE "users"."is_active" = $1
-- params: [ true ]
```

### temptable on PgClient: six statements

```sql
-- #1 query
SELECT "users"."id" as "__pk_id", "users"."username" as "username"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
-- #2 query
CREATE TEMP TABLE IF NOT EXISTS tmp_parent_ids_0 (
  id integer PRIMARY KEY
)
-- #3 query
INSERT INTO tmp_parent_ids_0 VALUES ($1),($2)
-- params: [ 1, 2 ]
-- #4 query
CREATE TEMP TABLE tmp_parent_ids_0_agg AS
SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title", 'views', "views")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
  FROM "posts"
  WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)
) sub
GROUP BY "__fk_user_id"
-- #5 query
SELECT parent_id, data FROM tmp_parent_ids_0_agg
-- #6 query
DROP TABLE IF EXISTS tmp_parent_ids_0, tmp_parent_ids_0_agg
```

### temptable on PostgresClient, BunClient, PGliteClient: two round trips

The base query, then one simple-protocol script per collection (captured through `PostgresClient` over the in-memory database; the context is built as in [Run the temptable strategy safely](#run-the-temptable-strategy-safely-experimental)):

```sql
-- #1 query
SELECT "users"."id" as "__pk_id", "users"."username" as "username"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
-- #2 querySimple (one script = one round trip)
-- Create temporary table for parent IDs
CREATE TEMP TABLE tmp_parent_ids_0 (
  id integer PRIMARY KEY
) ON COMMIT DROP;

-- Insert parent IDs
INSERT INTO tmp_parent_ids_0 VALUES (1),(2);

-- Query and return the data
SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title", 'views', "views")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
  FROM "posts"
  WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)
) sub
GROUP BY "__fk_user_id";

-- Cleanup
DROP TABLE IF EXISTS tmp_parent_ids_0;
```

### Aggregates: one subquery or one CTE each

```ts
const stats = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),
    maxViews: u.posts!.max(p => p.views),
  }))
  .toList();
// [{ username: 'alice', postCount: 2, maxViews: 150 }, { username: 'bob', postCount: 1, maxViews: 200 }]
```

`lateral`, 1 statement:

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(MAX("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "maxViews"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
```

`cte`, 1 statement:

```sql
WITH "cte_0" AS (SELECT
  "user_id" as parent_id,
  COUNT(*) as data
FROM "posts"
GROUP BY "user_id"), "cte_1" AS (SELECT
  "user_id" as parent_id,
  MAX("views") as data
FROM "posts"
GROUP BY "user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, 0) as "postCount", COALESCE("cte_1".data, null) as "maxViews"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
LEFT JOIN "cte_1" ON "cte_1".parent_id = "users".id
WHERE "users"."is_active" = $1
-- params: [ true ]
```

`temptable` ran 11 statements on `PgClient` (the base query + 5 per aggregate) and 3 round trips on `PostgresClient` (the base query + one script per aggregate).

> **Efficiency:** every aggregate of a collection is a subquery (or a CTE) of its own: three aggregates read the children three times. When one parent row needs several aggregates of one child table for many parents, a grouped subquery joined once reads them in one pass; see [Join a derived table](./guides/subquery-guide.md#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery).

### Top-N per parent: LIMIT per parent or ROW_NUMBER over all

```ts
const topPosts = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({
    username: u.username,
    topPost: u.posts!.orderBy(p => [[p.views, 'DESC']]).limit(1).select(p => ({ title: p.title })).toList(),
  }))
  .toList();
// [{ username: 'alice', topPost: [{ title: 'Alice Post 2' }] }, { username: 'bob', topPost: [{ title: 'Bob Post' }] }]
```

`lateral` stops at the limit inside each parent's subquery:

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "topPost"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
  ORDER BY "lateral_0_posts"."views" DESC
  LIMIT 1
) sub) "lateral_0" ON true
WHERE "users"."is_active" = $1
-- params: [ true ]
```

`cte` numbers every post of every user and keeps the first of each (`temptable` runs the same aggregate over the ids of the base query, in 6 statements on `PgClient`):

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title") ORDER BY "__rn"
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_user_id" ORDER BY "__order_0" DESC) as "__rn"
  FROM (
    SELECT "posts"."user_id" as "__fk_user_id", "title", "posts"."views" as "__order_0"
    FROM "posts"
  ) inner_sub
) sub
WHERE "__rn" > 0 AND "__rn" <= 1
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, '[]'::json) as "topPost"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
WHERE "users"."is_active" = $1
-- params: [ true ]
```

## Read the SQL of the lateral strategy (default)

`lateral` correlates every collection to its parent row, so `limit()` / `offset()` apply per parent by construction.

| Collection in the projection | Renders as |
|---|---|
| `toList()`, `selectDistinct(…).toList()`, any list with `limit()` / `offset()` | `LEFT JOIN LATERAL (SELECT json_agg(json_build_object(…)) …) "lateral_<n>" ON true`, read as `COALESCE("lateral_<n>".data, '[]'::json)` |
| `firstOrDefault()` | `LEFT JOIN LATERAL (SELECT json_build_object(…) … LIMIT 1)`, `null` when the parent has no item |
| `count()`, `exists()`, `sum()`, `min()`, `max()`, `toNumberList()`, `toStringList()` without `limit()` / `offset()` | a correlated subquery in the SELECT list, `(SELECT COALESCE(COUNT(*), 0) FROM … WHERE <foreign key> = <parent key>)` |
| the same with `limit()` / `offset()` | `LEFT JOIN LATERAL` over the ordered, limited rows |
| a collection inside a collection's projection | the same forms inside the outer collection's subquery: a nested LATERAL for a list, a correlated subquery for an unlimited `count()` |

One item per parent, or `null`:

```ts
const best = await db.users
  .select(u => ({
    username: u.username,
    topPost: u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ title: p.title, views: p.views })).firstOrDefault(),
  }))
  .toList();
// [{ username: 'alice', topPost: { title: 'Alice Post 2', views: 150 } },
//  { username: 'bob', topPost: { title: 'Bob Post', views: 200 } },
//  { username: 'charlie', topPost: null }]
```

```sql
SELECT "users"."username" as "username", "lateral_0".data as "topPost"
FROM "users"
LEFT JOIN LATERAL (SELECT json_build_object('title', "title", 'views', "views") as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
  ORDER BY "lateral_0_posts"."views" DESC
  LIMIT 1
) sub) "lateral_0" ON true
```

A native array of one value per item, ordered inside the aggregate:

```ts
const ids = await db.users
  .select(u => ({
    username: u.username,
    postIds: u.posts!.orderBy(p => [[p.id, 'DESC']]).select(p => p.id).toNumberList(),
  }))
  .toList();
// [{ username: 'alice', postIds: [2, 1] }, { username: 'bob', postIds: [3] }, { username: 'charlie', postIds: [] }]
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(array_agg("lateral_0_posts"."id" ORDER BY "lateral_0_posts"."id" DESC), '{}')
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postIds"
FROM "users"
```

Nested collections nest the LATERAL:

```ts
const tree = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      comments: p.postComments!.select(c => c.comment).toList(),
    })).toList(),
  }))
  .toList();
// [{ username: 'alice', posts: [{ title: 'Alice Post 1', comments: ['Related to order'] },
//                               { title: 'Alice Post 2', comments: ['Mentions another order'] }] }]
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'comments', "comments")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", COALESCE("lateral_1".data, '[]'::json) as "comments"
  FROM "posts" "lateral_0_posts"
  LEFT JOIN LATERAL (SELECT json_agg(
    json_build_object('comment', "comment")
  ) as data
  FROM (
    SELECT "lateral_1_postComments"."comment" as "comment"
    FROM "post_comments" "lateral_1_postComments"
    WHERE "lateral_1_postComments"."post_id" = "lateral_0_posts"."id"
  ) sub) "lateral_1" ON true
  WHERE "lateral_0_posts"."user_id" = "users"."id"
) sub) "lateral_0" ON true
WHERE "users"."username" = $1
-- params: [ "alice" ]
```

ORDER BY keys inside a lateral are always qualified (`"lateral_0_posts"."views"`): a bare name there would bind to a projected alias of the same name, or to a column of the outer row when the collection's table has none.

> **Efficiency:** the work is one subquery per parent row and collection. Each probes the foreign key (`"lateral_0_posts"."user_id" = "users"."id"`): with an index that is an index lookup per parent, without one a scan of the child table per parent. `bench/versions/harness.ts` notes about 80 ms for 100 users reaching `post_comments` through its unindexed `post_id`.

## Read the SQL of the cte strategy

`cte` renders one `WITH "cte_<n>" AS (… GROUP BY <foreign key>)` per collection, over the whole child table, and `LEFT JOIN`s it to the parent row on `parent_id`.

- It joins back on the parent's principal key: `id` by default, or the column the relation names with `withPrincipalKey(…)`. A collection reached through navigations (`t.level!.createdBy!.posts`) joins on that navigation's row: `LEFT JOIN "cte_0" ON "cte_0".parent_id = "createdBy"."id"`.
- `json_agg` orders by the columns of its subquery: a key the projection selects anyway is ordered by that projected column (`ORDER BY "views" DESC`), any other key by a hidden `"__order_<n>"` column.
- `limit()`, `offset()` and `firstOrDefault()` number every child of every parent with `ROW_NUMBER() OVER (PARTITION BY <foreign key> ORDER BY …)` and keep `"__rn" > <offset> AND "__rn" <= <offset + limit>`, or `"__rn" = 1` (see [Top-N per parent](#top-n-per-parent-limit-per-parent-or-row_number-over-all)).
- A collection nested in a collection becomes a CTE of its own, joined inside the outer CTE.

The nested query of the previous section under `cte`:

```sql
WITH "cte_0" AS (SELECT
  "__fk_post_id" as parent_id,
  json_agg(
    json_build_object('comment', "comment")
  ) as data
FROM (
  SELECT "post_comments"."post_id" as "__fk_post_id", "comment"
  FROM "post_comments"
) sub
GROUP BY "__fk_post_id"), "cte_1" AS (SELECT
  "__fk_user_id" as parent_id,
  json_agg(
    json_build_object('title', "title", 'comments', "comments")
  ) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", COALESCE("cte_0".data, '[]'::json) as "comments"
  FROM "posts"
  LEFT JOIN "cte_0" ON "posts"."id" = "cte_0".parent_id
) sub
GROUP BY "__fk_user_id")
SELECT "users"."username" as "username", COALESCE("cte_1".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN "cte_1" ON "cte_1".parent_id = "users".id
WHERE "users"."username" = $1
-- params: [ "alice" ]
```

`firstOrDefault()` under `cte`, the query of the lateral section:

```sql
WITH "cte_0" AS (SELECT
  "__fk_user_id" as parent_id,
  json_build_object('title', "title", 'views', "views") as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_user_id" ORDER BY "views" DESC) as "__rn"
  FROM (
    SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
    FROM "posts"
  ) inner_sub
) sub
WHERE "__rn" = 1)
SELECT "users"."username" as "username", "cte_0".data as "topPost"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
```

> **Efficiency:** no CTE carries a filter for the parents the root query keeps (`WHERE "users"."username" = $1` stays outside). Whether PostgreSQL reads every child depends on its plan: a plain list of 100 of 2,000 users measured the same as `lateral` (1.19 ms against 1.22 ms), four aggregates of the same users 4.9 times slower (6.51 ms against 1.32 ms).

## Run the temptable strategy safely (experimental)

`temptable` runs in phases:

1. **The base query:** the projection without its collections, plus each collection's parent key: `"__pk_id"` for the root row's key, `"__pk_<n>"` for the key of a navigation a collection hangs off.
2. **Per collection:** the distinct, non-NULL parent keys go into a temp table (its key column takes the type of the parent key: `integer`, `bigint`, `uuid`, `text`, …), and the `cte` strategy's aggregation runs restricted to `<foreign key> IN (SELECT id FROM <temp table>)`, its parameters numbered from `$1`.
3. **Merge:** each collection's `(parent_id, data)` rows are merged into the base rows in JavaScript.

Whatever `cte` can aggregate, `temptable` aggregates the same way: navigations in the projection, `where()` and `orderBy()`, `limit()` / `offset()` per parent, counts and other scalars, `firstOrDefault()`, principal keys other than `id`. A collection nested in a collection renders as LATERAL inside the aggregation, in the same statement.

### Statements per driver

| Driver | Statements | Round trips for N top-level collections |
|---|---|---|
| `PgClient` (`supportsMultiStatementQueries()` = `false`) | base query; then per collection `CREATE TEMP TABLE IF NOT EXISTS`, `INSERT … VALUES ($1),($2),…`, `CREATE TEMP TABLE … AS <aggregation>`, `SELECT parent_id, data FROM …_agg`, `DROP TABLE IF EXISTS …` | 1 + 5 × N (one query with 10 collections: 51) |
| `PostgresClient`, `BunClient`, `PGliteClient` (`supportsMultiStatementQueries()` = `true`) | base query; then per collection one simple-protocol script (`CREATE TEMP TABLE … ON COMMIT DROP; INSERT …; <aggregation>; DROP TABLE IF EXISTS …`) | 1 + N |
| the same drivers, [fast path](#the-single-round-trip-fast-path) | one script for everything | 1 |

A base query that returns no rows ends the query there: 1 statement, `[]`. On `PgClient` the text of the `INSERT … VALUES ($1),($2),…` changes with the number of parent rows; the multi-statement scripts carry every value as a literal, so their text changes with the values.

### The single round trip fast path

On a multi-statement driver the whole query runs as ONE script when the base query has no parameters and every collection is a plain list of the item's own columns: no `where()`, `limit()` / `offset()`, aggregate, `toNumberList()` / `toStringList()`, `firstOrDefault()`, DISTINCT, navigation (in the projection or the `orderBy()`), `sql` fragment as an `orderBy()` key, mapper, composite or constant key part, principal key other than `id`, no projected field named `parent_id`, and only column types whose JSON and driver values agree (`smallint`, `integer`, `smallserial`, `serial`, `real`, `double precision`, `boolean`, `varchar`, `char`, `text`, `uuid`, `json`, `jsonb`). The conditions are `isNaiveCollectionFastPathSafe()` in `src/query/query-builder.ts`.

```ts
const everyone = await tempDb.users // tempDb: an AppDatabase on PostgresClient with collectionStrategy 'temptable'
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// [{ username: 'alice', posts: [{ title: 'Alice Post 2', views: 150 }, { title: 'Alice Post 1', views: 100 }] },
//  { username: 'bob', posts: [{ title: 'Bob Post', views: 200 }] },
//  { username: 'charlie', posts: [] }]
```

```sql
-- #1 querySimpleMulti (one script = one round trip)
CREATE TEMP TABLE tmp_base_0 AS SELECT "users"."id" as "__pk_id", "users"."username" as "username"
FROM "users";
SELECT * FROM tmp_base_0;
SELECT "user_id" as parent_id, "title" as "title", "views" as "views" FROM "posts" WHERE "user_id" IN (SELECT "__pk_id" FROM tmp_base_0) ORDER BY "posts"."id" DESC;
DROP TABLE IF EXISTS tmp_base_0
```

> **Pitfall:** without `orderBy()` the fast path lists items by primary key descending (`ORDER BY "posts"."id" DESC`, so Alice Post 2 comes first); the other forms leave the order to PostgreSQL. Give every collection whose order matters an `orderBy()`.

### Inside a transaction on PgClient, outside one on the other drivers

`PgClient.query()` runs each statement through `pool.query()`, on whichever pooled connection is free, and a temp table exists in one session only. On `PgClient`, run `temptable` queries inside `db.transaction()`, where every statement uses the transaction's connection:

```ts
import { PgClient, eq } from 'linkgress-orm';
import { AppDatabase } from './schema/appDatabase';

const client = new PgClient({ connectionString: process.env.DATABASE_URL });
const tempDb = new AppDatabase(client, { collectionStrategy: 'temptable' });

const activeUsers = await tempDb.transaction(async tx =>
  tx.users
    .where(u => eq(u.isActive, true))
    .select(u => ({
      username: u.username,
      posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
    }))
    .toList());
```

The 6 statements of [temptable on PgClient](#temptable-on-pgclient-six-statements) run on the transaction's connection, between a `BEGIN` and a `COMMIT` (8 round trips).

On `PostgresClient`, `BunClient` and `PGliteClient` it is the other way round: run `temptable` OUTSIDE `db.transaction()`. Each collection's script creates and drops its temp table within itself (`ON COMMIT DROP` and a closing `DROP TABLE`), so any pooled connection can run it. Inside a transaction the transaction's client has no `querySimple()` / `querySimpleMulti()`, and the query fails or comes back with empty collections ([table below](#failures-reproduced-on-the-harness); `PostgresClient` and `PGliteClient` were run, `BunClient`'s transaction client lacks both methods the same way). Use `lateral` or `cte` inside transactions on these drivers: both returned correct rows there.

For a multi-statement driver, construct the context over that client (`PostgresClient` takes a connection string, an options object or an existing `postgres` instance):

```ts
import { PostgresClient } from 'linkgress-orm';
import { AppDatabase } from './schema/appDatabase';

const pgjs = new PostgresClient(process.env.DATABASE_URL!);
const tempDb = new AppDatabase(pgjs, { collectionStrategy: 'temptable' });
```

### Failures reproduced on the harness

| Situation | Result | `lateral` / `cte` |
|---|---|---|
| 8 concurrent `temptable` queries on one `PgClient` pool, outside a transaction (each response delayed 0–3 ms, as a network would) | 8 of 8 failed: `relation "tmp_parent_ids_0" does not exist` (7), `duplicate key value violates unique constraint "tmp_parent_ids_0_pkey"` (1) | 8 of 8 succeeded |
| The same 8 queries, each inside `db.transaction()` | 8 of 8 succeeded | — |
| A collection hanging off a navigation that EVERY returned row lacks (`t.level!.createdBy!.posts` of tasks without a level): all parent keys NULL | Error: `relation "empty_agg_0" does not exist` (`PgClient` and `PostgresClient`) | `[]` |
| `temptable` inside `db.transaction()` on `PostgresClient` or `PGliteClient`, a query of the [single round trip](#the-single-round-trip-fast-path) shape | Error before any statement of the query is sent: `Fully optimized mode requires querySimpleMulti support` (`querySimpleMulti not supported by this client` when the context has `logQueries` on) | correct lists |
| `temptable` inside `db.transaction()` on `PostgresClient`, any other shape (the transaction's client has no `querySimple()`, so each script goes through `query()`, which hands the ORM the script's result sets as rows) | every collection `[]`, no error (on the in-memory database, through postgres.js) | correct lists |
| The same on `PGliteClient` | Error: `cannot insert multiple commands into a prepared statement` | correct lists |

While at least one returned row has the parent key, rows without it get the empty value (`[]`, `0`, `null`).

### Parameters written as literals

The simple protocol of the multi-statement drivers takes no bind parameters, so every `$n` of an aggregation is written into the script as a literal, and so are the parent keys. The tokenizer that does it knows what PostgreSQL does not read as a placeholder (quoted literals and identifiers, `E'…'` and dollar-quoted strings, `--` and `/* */` comments, a `$` inside an identifier) and refuses a placeholder without a value. Each value type is written explicitly:

- `NULL`, booleans (`TRUE` / `FALSE`), numbers (a negative one parenthesized, so `a-$1` cannot become the comment `a--1`; `NaN` / `±Infinity` quoted), bigints;
- Dates as ISO strings; strings with doubled quotes (a string with a backslash as `E'…'` with doubled backslashes, so it reads the same whatever `standard_conforming_strings` is);
- arrays as array literals, other objects as JSON.

`lateral` and `cte` bind the values of conditions as parameters (`$1`, `$2`, …) on every driver (a `limit()` / `offset()` is written as a number), and so does `temptable` on `PgClient`; only the multi-statement scripts of `temptable` write parameter values as literals.

## Know when another strategy is rendered

The configured strategy is a request. These shapes render differently, without an error unless stated:

| Situation | Configured | Rendered |
|---|---|---|
| A query built as one statement: `countOver()`, `prepare()`, `future()` / a `QueryBatch` leg, a `union()` leg | `temptable` | the `cte` form, in that one statement |
| A collection whose `where()`, projection or `orderBy()` reads the enclosing row beyond the relation key | `cte` / `temptable` | LATERAL (under `temptable`, inside the base query) |
| A collection that projects a window value (`win.rowNumber()`, `win.rank()`, `win.denseRank()`) (since 1.0.21) | `cte` / `temptable` | LATERAL, so the items are numbered per parent |
| A collection inside a collection | `cte` | a nested CTE |
| A collection inside a collection | `lateral` / `temptable` | LATERAL |
| A collection of a table joined with `innerJoin()` / `leftJoin()` | `cte` / `temptable` | refused: `The collection "posts" of the joined table "users_0" needs the 'lateral' collection strategy: the 'cte' strategy attaches a collection to the root row.` (the message names the configured strategy) |
| `exists()` / `count()` of a collection in `where()`, `orderBy()` or a `sql` fragment | any | the same correlated subquery |

`countOver()` under `temptable`, one statement:

```ts
import { eq, gt, ne, win, exists } from 'linkgress-orm';

const page = await tempDb.users
  .orderBy(u => u.id)
  .select(u => ({ username: u.username, postCount: u.posts!.count() }))
  .limit(2)
  .countOver();
// { data: [{ username: 'alice', postCount: 2 }, { username: 'bob', postCount: 1 }], totalCount: 3 }
```

```sql
WITH "cte_0" AS (SELECT
  "user_id" as parent_id,
  COUNT(*) as data
FROM "posts"
GROUP BY "user_id")
SELECT "users"."username" as "username", COALESCE("cte_0".data, 0) as "postCount", COUNT(*) OVER() as "__countOver"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
ORDER BY "users"."id" ASC
LIMIT 2
```

A collection compared with the enclosing row (the other posts of the same author) under `cte`:

```ts
const others = await cteDb.posts // cteDb: an AppDatabase with collectionStrategy 'cte'
  .select(p => ({
    title: p.title,
    otherTitles: p.user!.posts!.where(x => ne(x.id, p.id)).select(x => x.title).toList(),
  }))
  .toList();
// [{ title: 'Alice Post 1', otherTitles: ['Alice Post 2'] },
//  { title: 'Alice Post 2', otherTitles: ['Alice Post 1'] },
//  { title: 'Bob Post', otherTitles: [] }]
```

```sql
SELECT "posts"."title" as "title", COALESCE("lateral_0".data, '[]'::json) as "otherTitles"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title"
  FROM "posts" "lateral_0_posts"
  INNER JOIN "users" "user" ON "posts"."user_id" = "user"."id"
  WHERE "lateral_0_posts"."user_id" = "user"."id" AND "lateral_0_posts"."id" != "posts"."id"
) sub) "lateral_0" ON true
```

A window value in the items under `cte`, numbered per parent:

```ts
const ranked = await cteDb.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, rank: win.rowNumber().over({ orderBy: [[p.views, 'DESC']] }) })).toList(),
  }))
  .toList();
// [{ username: 'alice', posts: [{ title: 'Alice Post 2', rank: 1 }, { title: 'Alice Post 1', rank: 2 }] }]
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'rank', "rank")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", row_number() OVER (ORDER BY "lateral_0_posts"."views" DESC) as "rank"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
) sub) "lateral_0" ON true
WHERE "users"."username" = $1
-- params: [ "alice" ]
```

A collection of a joined table needs `lateral` (here the default context):

```ts
const orders = await db.orders
  .innerJoin(db.users, (o, u) => eq(o.userId, u.id), (o, u) => ({ orderId: o.id, postCount: u.posts!.count() }))
  .toList();
// [{ orderId: 1, postCount: 2 }, { orderId: 2, postCount: 1 }]
```

```sql
SELECT "orders"."id" as "orderId", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users_0"."id") as "postCount"
FROM "orders"
INNER JOIN "users" AS "users_0" ON "orders"."user_id" = "users_0"."id"
```

A collection in `where()` renders the same subquery under all three strategies:

```ts
const withPopularPost = await db.users
  .where(u => exists(u.posts!.where(p => gt(p.views, 120))))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'bob' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."views" > $1)
-- params: [ 120 ]
```

## Index the foreign keys collections read

A `hasMany` / `hasOne` pair creates the foreign-key constraint (`CONSTRAINT "FK_post_comments_posts_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE` for the `PostComment` → `Post` relation with `.onDelete('cascade')`) and no index: a model with only this relation gets `posts_pkey` and `post_comments_pkey` from `ensureCreated()`, nothing on `post_comments.post_id`. Declare an index per foreign key a collection reads:

```ts
// fragment: inside AppDatabase.setupModel(model)
model.entity(PostComment, entity => {
  entity.toTable('post_comments');
  // … properties and relations as before
  entity.hasIndex('ix_post_comments_post_id', e => [e.postId]);
});
```

```sql
CREATE INDEX IF NOT EXISTS "ix_post_comments_post_id" ON "post_comments" ("post_id")
```

A composite index whose FIRST column is the foreign key serves too: the example model's `ix_posts_query` on `(user_id, published_at)` serves `u.posts`, `IX_Orders_UserId_Status` on `(user_id, status)` serves `u.orders`, and the primary key `(order_id, task_id)` of `order_task` serves `o.orderTasks`. In the example model the collections `p.postComments`, `p.productPrices` and `c.cartItems` read unindexed foreign keys (`post_comments.post_id`, `product_prices.product_id`, `cart_items.cart_id`).

> **Efficiency:** `lateral` and every correlated `count()` / `exists()` probe the foreign key once per parent row; without an index each probe scans the child table. `cte` reads the whole child table once per collection, index or not; `temptable` filters it with `<foreign key> IN (SELECT id FROM <temp table>)`, which an index on the foreign key can serve.

## Check what every strategy supports

The three queries below exercise the collection operations and return identical results under `lateral`, `cte` and `temptable` (compared on the harness). Statements on `PgClient`: 1, 1 and 51 for the users query (10 collections), 1, 1 and 6 for each of the others.

```ts
import { gt, ne, sql } from 'linkgress-orm';

const users = await db.users
  .orderBy(u => u.id)
  .select(u => ({
    username: u.username,
    // filter, order and page each user's posts
    page: u.posts!
      .where(p => gt(p.views, 50))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(10)
      .offset(0)
      .select(p => ({ title: p.title, views: p.views }))
      .toList(),
    // order by an SQL expression, read one value per item
    byTitleLength: u.posts!.orderBy(p => [[sql<number>`length(${p.title})`, 'DESC'], p.id]).select(p => p.title).toStringList(),
    // order by a nested collection's count
    byComments: u.posts!.orderBy(p => [[p.postComments!.count(), 'DESC'], p.id]).select(p => ({ title: p.title })).toList(),
    // aggregates
    postCount: u.posts!.count(),
    totalViews: u.posts!.sum(p => p.views),
    minViews: u.posts!.min(p => p.views),
    maxViews: u.posts!.max(p => p.views),
    // an aggregate over the ordered, limited collection: at most 1 post per user
    top1Views: u.posts!.orderBy(p => [[p.views, 'DESC']]).limit(1).sum(p => p.views),
    // distinct values
    categories: u.posts!.selectDistinct(p => ({ category: p.category })).toList(),
    // a native array of numbers
    postIds: u.posts!.orderBy(p => p.id).select(p => p.id).toNumberList(),
  }))
  .toList();
// charlie (no posts): page [], byTitleLength [], postCount 0, totalViews / minViews / maxViews / top1Views null,
// categories [], postIds []

const orders = await db.orders
  .orderBy(o => o.id)
  .select(o => ({
    orderId: o.id,
    // columns of the items' navigations, a filter and an order through them
    tasks: o.orderTasks!
      .where(ot => ne(ot.task!.status, 'cancelled'))
      .orderBy(ot => ot.task!.title)
      .select(ot => ({ title: ot.task!.title, level: ot.task!.level!.name }))
      .toList(),
  }))
  .toList();
// [{ orderId: 1, tasks: [{ title: 'Important Task', level: 'High Priority' }] },
//  { orderId: 2, tasks: [{ title: 'Regular Task', level: 'Low Priority' }] }]

const comments = await db.postComments
  .orderBy(pc => pc.id)
  .select(pc => ({
    comment: pc.comment,
    // a collection reached through navigations
    authorPostCount: pc.post!.user!.posts!.count(),
    // items compared with the enclosing row: the author's other posts (rendered LATERAL under every strategy)
    authorOtherPosts: pc.post!.user!.posts!.where(x => ne(x.id, pc.postId)).select(x => x.title).toList(),
  }))
  .toList();
// [{ comment: 'Related to order', authorPostCount: 2, authorOtherPosts: ['Alice Post 2'] }, …]
```

Also supported under every strategy (pinned by `tests/queries/collection-navigation-strategies.test.ts`, `collection-orderby.test.ts`, `collection-same-table.test.ts` and `collection-schema-qualified.test.ts`, which run each case under all three):

- collections reached through any chain of navigations, reading the table of the row they hang off, and comparing their items with the root row or an enclosing collection's item;
- relations of a table to itself (a tree's children, the siblings through the parent);
- relations keyed on a principal key other than `id` (`withPrincipalKey(c => c.code)`), joined on that key;
- tables in another schema (`toSchema(…)`), read schema-qualified;
- mapped columns of the items (since 1.0.31, `tests/queries/collection-item-mappers.test.ts`): a value compared
  directly with the column in the collection's `where()` binds through `toDriver` (`gte(p.publishTime, { hour: 12,
  minute: 0 })` bound `720` under all three), and `min()` / `max()` of the column read through `fromDriver`
  ([Querying](./guides/querying.md#compare-and-aggregate-the-items-mapped-columns));
- a `sum()` over a nested `count()` reached through reference navigations of the item (since 1.0.31,
  `tests/queries/sum-nested-count.test.ts`), e.g. `c.cartDiscountCodes!.sum(cdc => cdc.discountCode!.discount!.discountProducts!.count())`:
  the summed collection joins the hops inside its own subquery, its CTE body or its temp-table aggregation
  ([Querying](./guides/querying.md#sum-a-count-over-each-items-related-rows)).

A DISTINCT collection can only be ordered by values it selects (`u.posts!.orderBy(p => p.views).selectDistinct(p => ({ category: p.category }))` is not). Another key is refused, naming it:

| Strategy | Refusal |
|---|---|
| `cte`, `temptable` (after running its base query) | `The distinct collection "posts" is ordered by "views", which it does not select: a distinct collection can only be ordered by values it selects.` |
| `lateral`, a value list (`toStringList()`) | `The distinct list "posts" is ordered by "views", which it does not select: a distinct list can only be ordered by the value it lists.` |
| `lateral`, a list of objects | sent to PostgreSQL, which refuses it: `for SELECT DISTINCT, ORDER BY expressions must appear in select list` |

### Where the results differ

- A collection of a table joined with `innerJoin()` / `leftJoin()`: `cte` / `temptable` refuse it.
- `temptable` fails when every parent key is NULL, races on a `PgClient` pool outside a transaction, and inside `db.transaction()` on `PostgresClient` / `BunClient` / `PGliteClient` returns empty collections or throws (see [Failures reproduced](#failures-reproduced-on-the-harness); `BunClient` was not run, but its transaction client lacks `querySimple()` / `querySimpleMulti()` the same way).
- Item order without `orderBy()` is unspecified under every strategy; `temptable`'s fast path lists by primary key descending.

> **Pitfall:** list items and `firstOrDefault()` objects travel as JSON under every strategy (`json_agg` / `json_build_object`). An unmapped `timestamp` / `date` column inside an item reads back as its text (`orders.created_at` in `u.orders!.select(o => ({ createdAt: o.createdAt })).toList()` came back as the string `'2026-10-04T15:51:42.018'`, though typed `Date`), a `decimal` as a JS number (`total_amount`: `99.99`; the same column at the top level reads as the driver's string `'99.99'`); columns with a custom mapper go through it, and so (since 1.0.31) does a collection's `min()` / `max()` of such a column. See [Querying](./guides/querying.md).

## Measure the strategies on your own data

The in-memory database shows the statements but not their cost. Measure on a PostgreSQL server with your data, after a warm-up (the first build of a query shape costs more):

```ts
import { performance } from 'perf_hooks';
import { eq, type CollectionStrategyType } from 'linkgress-orm';

const timed = async (collectionStrategy: CollectionStrategyType) => {
  const start = performance.now();
  await db.users
    .withQueryOptions({ collectionStrategy, logQueries: true })
    .where(u => eq(u.isActive, true))
    .select(u => ({
      username: u.username,
      posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
    }))
    .toList();
  return performance.now() - start;
};

for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
  await timed(strategy); // warm-up
  console.log(strategy, (await timed(strategy)).toFixed(2), 'ms');
}
```

Then:

1. Index the foreign keys the collections read.
2. Filter the root query before collections multiply the work: `lateral` does one probe per returned parent.
3. Limit what you load: `limit()` per collection, `count()` / `exists()` instead of a list you only measure.
4. Read the plans with `EXPLAIN (ANALYZE, BUFFERS)` on the logged statement (`logQueries: true` prints it).
5. Building a navigation- and collection-heavy query costs CPU in Node; `MockRowCache.setEnabled(true)` turns on the build caches (it also gates `NavigationPathCache` and the `LateralSqlCache` of the lateral strategy); the SQL does not change. See [Configuration](./guides/configuration.md).

## Reference: options, types and exports

```ts
// fragment: the QueryOptions keys that matter for collections (the full list: guides/configuration.md)
interface QueryOptions {
  /** Collection aggregation strategy (default: 'lateral') */
  collectionStrategy?: 'cte' | 'lateral' | 'temptable';
  /** Log every statement (default: false) */
  logQueries?: boolean;
  /** Log the parameters with each statement logQueries logs (default: false) */
  logParameters?: boolean;
  /** Log each statement's execution time (default: false) */
  logExecutionTime?: boolean;
  /** Log a per-phase breakdown of a query: build / execute / transform (default: false) */
  traceTime?: boolean;
  // … logger, logFailedQueries, preparedStatements, slow-query detection, mappers: guides/configuration.md
}
```

| API | Signature · notes |
|---|---|
| `collectionStrategy` | context option and per-query option; `'lateral'` when omitted |
| `withQueryOptions(options)` | `DbEntityTable<T>.withQueryOptions(options: QueryOptions): DbEntityTable<T>` (merged over the context's options); `TableAccessor.withQueryOptions(options): TableAccessor` (keeps the accessor's `collectionStrategy` when `options` sets none). Returns a new table object; the original is unchanged |
| `CollectionStrategyType` | `type CollectionStrategyType = 'cte' \| 'temptable' \| 'lateral'` (exported as a type; also as `CollectionStrategy`) |
| `LoggingOptions` | deprecated alias of `QueryOptions` |
| `ICollectionStrategy`, `CollectionAggregationConfig`, `CollectionAggregationResult` (types), `CollectionStrategyFactory` | the strategy internals, exported for tests and extensions; `CollectionStrategyFactory.getStrategy(type)` returns one shared instance per type, `clearCache()` drops them. The query builder fills their `QueryContext` (aliases, parameter numbering): application code selects a strategy with `collectionStrategy` and does not call them |

```ts
import type {
  QueryOptions,
  CollectionStrategyType,
  ICollectionStrategy,
  CollectionAggregationConfig,
  CollectionAggregationResult,
} from 'linkgress-orm';
import { CollectionStrategyFactory } from 'linkgress-orm';
```

The result type of a query does not depend on the strategy; it is inferred from the projection:

```ts
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList(),
  }))
  .toList();
// typeof users: { id: number; username: string; posts: { title: string; views: number }[] }[]
```

**Upgrading from 0.0.x:** the default changed from `'cte'` to `'lateral'` (LATERAL applies `limit()` / `offset()` per parent row). To keep the old behavior pass it explicitly: `new AppDatabase(client, { collectionStrategy: 'cte' })`.

## Internals for contributors

The strategies follow the strategy pattern: `CollectionStrategyFactory.getStrategy(type)` returns one instance per type of `LateralCollectionStrategy` (default), `CteCollectionStrategy` or `TempTableCollectionStrategy`, all implementing `ICollectionStrategy`. `QueryContext` carries the configured strategy through a build.

- **`lateral` and `cte` (one phase):** the query builder renders the main statement with its LATERAL joins or CTEs, executes it once and transforms the rows.
- **`temptable` (three phases):** see [Run the temptable strategy safely](#run-the-temptable-strategy-safely-experimental). Its aggregation is `CteCollectionStrategy.buildAggregationSelect()` with a parent filter.

How each client answers `supportsMultiStatementQueries()`:

| Client | Value | `temptable` per collection |
|---|---|---|
| `PgClient` (node-postgres) | `false` | 5 statements with bound parameters |
| `PostgresClient` (postgres.js) | `true` | one `.simple()` script |
| `BunClient` (Bun.SQL) | `true` | one simple-protocol script |
| `PGliteClient` (PGlite) | `true` | one `exec()` call, in-process |
| a `DatabaseClient` subclass that does not override it | `false` (the base class default) | 5 statements, as `PgClient` |
| the client of `db.transaction()` (`TransactionalClient`) | the value of the client it wraps | it has no `querySimple()` / `querySimpleMulti()`: see [Failures reproduced](#failures-reproduced-on-the-harness) |

`toNumberList()` / `toStringList()` aggregate with `array_agg`, except where the client cannot decode native arrays (`BunClient` in its default prepared mode reports `supportsBinaryArrayResults()` = `false`) and in the `temptable` multi-statement scripts: there `json_agg` lists the same values.

When adding a collection feature:

1. Update `CteCollectionStrategy.buildAggregationSelect()`: `temptable` runs this aggregation restricted to its parents, so a CTE change carries over to it.
2. Update `LateralCollectionStrategy.buildAggregation()`, and its `LateralSqlCache` shape key (`lateralShapeKey`) when the rendering reads a new config field.
3. Update `TempTableCollectionStrategy` only for what is its own: the temp tables, the parameter interpolation of the multi-statement path, the single round trip fast path (`isNaiveCollectionFastPathSafe`).
4. Test it under every strategy: the library fixture (`tests/utils/library-fixture.ts`, `LIBRARY_STRATEGIES`) gives every navigation path a different value, so a wrong join cannot pass.
5. Update this page.

## Pitfalls

- **Don't** load children with one query per parent row (`for (const u of users) await db.posts.where(…)`) → **Do** project the collection (`u.posts!.select(…).toList()`): 1 statement under `lateral` and `cte`.
- **Don't** switch a whole context to `cte` for one export query → **Do** use `db.<table>.withQueryOptions({ collectionStrategy: 'cte' })` on that query: `cte` aggregates every parent's children, which filtered and paged queries pay for (6.51 ms against 1.32 ms measured).
- **Don't** use `temptable` on `PgClient` outside `db.transaction()` → **Do** wrap the query in `db.transaction()`: outside one, 8 of 8 concurrent queries failed on the harness, because each statement may land on another pooled connection and a temp table lives in one session.
- **Don't** use `temptable` inside `db.transaction()` on `PostgresClient`, `BunClient` or `PGliteClient` → **Do** run it outside the transaction, or use `lateral` / `cte` there: inside one, postgres.js returned every collection `[]` without an error, PGlite threw `cannot insert multiple commands into a prepared statement`, and the single round trip shape threw `Fully optimized mode requires querySimpleMulti support` on both.
- **Don't** expect `temptable` to be faster on large data: no measurement shows it; it was about 10 times slower than `lateral` / `cte` (11.7 ms against 1.2 ms) → **Do** measure `lateral` and `cte` first.
- **Don't** project a collection of a table joined with `innerJoin()` / `leftJoin()` under `cte` / `temptable` → **Do** run that query with `withQueryOptions({ collectionStrategy: 'lateral' })` on its root table.
- **Don't** leave a collection's foreign key unindexed → **Do** declare `entity.hasIndex()` on it: `lateral` probes it once per parent row.
- **Don't** rely on item order without `orderBy()` → **Do** add an `orderBy()` to every collection whose order matters: `temptable`'s fast path lists by primary key descending, the other forms leave it to PostgreSQL.
- **Don't** pass a name to `toList('posts')` expecting it to name the field → **Do** name the field with the projection key: the `asName` argument of `toList()` / `toNumberList()` / `toStringList()` / `firstOrDefault()` does not change the result key.
- **Don't** call `withQueryOptions()` after `where()` / `select()` → **Do** call it on the table first: only `DbEntityTable` and `TableAccessor` have it.

## See also

- [Choosing the Right Query](./choosing-the-right-query.md): start here; data need → API → SQL shape → round trips.
- [Querying](./guides/querying.md): writing collections (`select()`, `where()`, `orderBy()`, `limit()`, aggregates, `selectMany()`) and navigations.
- [Lateral Navigation Joins](./guides/lateral-navigation-joins.md): `lateralJoin()` (since 1.0.23), a per-row key probe for one reference navigation, also inside collections.
- [Batching and Prepared Queries](./guides/batching-and-prepared-queries.md): `QueryBatch` legs with collections stay one round trip for the whole batch.
- [Subqueries](./guides/subquery-guide.md): a grouped subquery joined once when one row needs several aggregates of one child table.
- [Configuration](./guides/configuration.md): every `QueryOptions` key with its default and scope.
- [Database Clients](./database-clients.md): `PgClient`, `PostgresClient`, `BunClient`, `PGliteClient` and transactions.
- [Schema Configuration](./guides/schema-configuration.md): relations and `hasIndex()`.
