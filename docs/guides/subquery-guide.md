# Subqueries

> **For agents:** How to embed one query in another statement (`EXISTS`, `IN`, a scalar value, a derived table) so PostgreSQL does the work in one round trip, and when a join, a collection or a CTE is the better tool.
> **Use this page when:** filtering rows by related rows, excluding rows that have related rows, matching keys against keys another query computes, comparing with an aggregate, projecting a per-row value, joining a grouped or filtered derived table. **Look elsewhere when:** the subquery reads the outer row's own table, or its tables must render under aliases you choose → [Aliased subquery scopes](./aliased-scopes.md); one derived set is read in several places of a statement → [CTE guide](./cte-guide.md); the values are already in JS → [Querying guide](./querying.md#matching-a-list-of-values) (`eqAny`, `inArrayOpt`).
> **Key APIs:** `asSubquery()`, `exists`, `notExists`, `inSubquery`, `notInSubquery`, `eqAnySubquery`, `neAllSubquery`, `eqSubquery` … `lteSubquery`, `Subquery.asExpression()`, `innerJoin` / `leftJoin` with a `'table'` subquery · **Round trips:** 0 of their own: a subquery renders inside the statement that embeds it, so the whole read is 1 round trip.

## Contents

- [Choose the right tool](#choose-the-right-tool)
- [Build a subquery: `asSubquery(mode)`](#build-a-subquery-assubquerymode)
- [Keep rows that have related rows: `exists()`](#keep-rows-that-have-related-rows-exists)
- [Keep rows without related rows: `notExists()`](#keep-rows-without-related-rows-notexists)
- [Project a has-related-rows flag](#project-a-has-related-rows-flag)
- [Filter by keys another query computes: `inSubquery()`](#filter-by-keys-another-query-computes-insubquery)
- [Exclude keys another query computes: `notInSubquery()`](#exclude-keys-another-query-computes-notinsubquery)
- [Match against one array: `eqAnySubquery()` / `neAllSubquery()`](#match-against-one-array-eqanysubquery--neallsubquery)
- [Compare a column with a computed value](#compare-a-column-with-a-computed-value)
- [Project a per-row value: a scalar subquery in `select()`](#project-a-per-row-value-a-scalar-subquery-in-select)
- [Read several columns of the same related row: use a collection](#read-several-columns-of-the-same-related-row-use-a-collection)
- [Use a scalar subquery inside an expression: `asExpression()`](#use-a-scalar-subquery-inside-an-expression-asexpression)
- [Join a derived table: `innerJoin()` / `leftJoin()` with a `'table'` subquery](#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)
- [Correlate with the outer row](#correlate-with-the-outer-row)
- [Subqueries over the outer row's own table](#subqueries-over-the-outer-rows-own-table)
- [Subqueries over unions, CTEs and sets](#subqueries-over-unions-ctes-and-sets)
- [Reuse a subquery, or put it in raw SQL](#reuse-a-subquery-or-put-it-in-raw-sql)
- [How PostgreSQL runs each form](#how-postgresql-runs-each-form)
- [API signatures](#api-signatures)
- [Type safety and its limits](#type-safety-and-its-limits)
- [Behavior changes by version](#behavior-changes-by-version)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose the right tool

Three rules decide most cases:

1. **Filter with a subquery, join for columns.** `exists` / `inSubquery` keep each outer row once. A join to the many side of a relation returns the outer row once per match.
2. **Use the navigation form when the model has the relation:** `exists(u.posts!…)`, `u.posts!.count()`. The SQL is shorter, and collection aggregates follow the [collection strategy](../collection-strategies.md).
3. **Never fetch keys to send them back.** Embed the query that computes them (`inSubquery`): one round trip, and one statement text whatever the number of keys.

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Rows that have a related row | `exists(u.posts!.where(…))`; without a navigation `exists(q.select(() => ({ one: literal(1) })).asSubquery())` | `WHERE EXISTS (SELECT 1 …)` · 1 | a join to the child table (one output row per match) |
| Rows without a related row | `notExists(…)` | `WHERE (NOT EXISTS (…))` · 1 | `notInSubquery` over a column that can be NULL |
| Keys another query computes | `inSubquery(col, q.select(x => x.key).asSubquery('array'))` | `col IN (SELECT …)` · 1 | `toList()` of the keys, then `inArray`: 2 round trips |
| The same, few keys, indexed outer column | `eqAnySubquery(col, sub)` | `(col = ANY (ARRAY(SELECT …)))` · 1 | a correlated subquery (one array per outer row) |
| Compare with an aggregate or a looked-up value | `gtSubquery(col, sub)` or `gt(col, sub)` with a `'scalar'` subquery | `col > (SELECT AVG(…) …)` · 1 | reading the value first: 2 round trips |
| A per-row count / sum / min / max over a navigation | `u.posts!.count()`, `u.posts!.max(p => p.views)` | correlated subquery (`lateral`) or `GROUP BY` CTE (`cte`) · 1 | a hand-built scalar subquery |
| A per-row value no navigation models, a top-1 value | `q.where(…).orderBy(…).limit(1).select(x => x.col).asSubquery('scalar')` | `(SELECT … LIMIT 1) as "x"` · 1 | one scalar subquery per column of the same row |
| Several columns of the top related row | `u.posts!.orderBy(…).select(…).firstOrDefault()` | `LEFT JOIN LATERAL (… LIMIT 1)` (`lateral`), a `ROW_NUMBER()` CTE (`cte`) · 1 | one scalar subquery per column |
| The related rows themselves | a collection: `u.posts!.select(…).toList()` | see [Collection strategies](../collection-strategies.md) · 1 (`temptable`: more) | `exists` (yes / no only) |
| Per-parent aggregates for many or all parents | join a grouped `'table'` subquery | `INNER JOIN (SELECT … GROUP BY …) AS "x" ON …` · 1 | a correlated scalar subquery per row over a whole table |
| A subquery over the outer row's own table | `db.posts.as('rival')` ([aliased scope](./aliased-scopes.md)) or a collection of a navigation | `EXISTS (SELECT 1 FROM "posts" AS "rival" …)` · 1 | `db.posts.where(…).asSubquery()` (refused) |
| One derived set read in several places | a CTE declared once with `.with()` | `WITH "x" AS (…) … IN (SELECT … FROM "x")` · 1 | the same subquery embedded twice (rendered and run twice) |
| Whether a whole query has any row | the terminal `q.exists()` | `SELECT EXISTS(SELECT 1 …)` · 1 | `count() > 0`, `toList().length` |

## Build a subquery: `asSubquery(mode)`

`asSubquery(mode)` turns a query with a projection into a `Subquery` value. Building it sends nothing: it renders in parentheses where it is embedded, as the sections below show. The mode decides its type and where it fits.

```ts
import { eq, sql } from 'linkgress-orm';

// 'scalar': one value from at most one row
const avgAge = db.users.select(u => sql<number>`AVG(${u.age})`).asSubquery('scalar');          // Subquery<number, 'scalar'>
// 'array': one column, any number of rows
const activeIds = db.users.where(u => eq(u.isActive, true)).select(u => u.id).asSubquery('array'); // Subquery<number[], 'array'>
// 'table' (the default): rows of any shape
const people = db.users.select(u => ({ id: u.id, name: u.username })).asSubquery('table');         // Subquery<{ id: number; name: string }, 'table'>
```

| Mode | Type | Project | Use it in |
|---|---|---|---|
| `'table'` (default) | `Subquery<Row, 'table'>` | any object | `exists` / `notExists`, `innerJoin` / `leftJoin`, `insertFrom` sources, `eqAnySubquery` |
| `'array'` | `Subquery<T[], 'array'>` | ONE value: `select(u => u.id)` | `inSubquery`, `notInSubquery`, `eqAnySubquery`, `neAllSubquery` |
| `'scalar'` | `Subquery<T, 'scalar'>` | ONE value or one aggregate, at most one row | comparisons, projections; `asExpression()` for `coalesce`, arithmetic, ORDER BY, UPDATE SET |

- **Where it exists:** on every query with a projection: `db.<table>.select(…)`, `.where(…).select(…)`, `selectDistinct(…)`, joins, grouped selects (`groupBy(…).select(…)`), unions, CTE-rooted queries (`db.selectFromCte(cte).select(…)`) and set queries (`fromSet(…)`, `db.selectFromSet(…)`). A table or a `where()` without `select()` has no `asSubquery()` (TypeScript error).
- **Typing of `'array'` and `'scalar'`:** entity, grouped and union subqueries are typed by the projection itself. Project ONE value: `select(u => u.id)` gives `number[]`; `select(u => ({ id: u.id }))` gives `{ id: number }[]`, which `inSubquery` rejects at compile time (`eqAnySubquery` accepts it). CTE-rooted and set subqueries are typed by their single column, so an object of one column works there.
- **Rendering:** values bind as parameters that continue the enclosing statement's numbering; `limit()` / `offset()` render as inline integers; the outer columns the subquery reads (its correlations) are reported, so the enclosing query joins the navigations they need (see [Correlate with the outer row](#correlate-with-the-outer-row)).

## Keep rows that have related rows: `exists()`

`exists(source)` renders `EXISTS (…)`. The source is a collection navigation (the shortest form: no projection needed) or a subquery of any query. Use the subquery form when no navigation models the relation, or the condition needs a table the model does not link.

```ts
import { and, eq, gt, literal, exists } from 'linkgress-orm';

// A collection navigation: users with a post above 120 views
const withPopularPosts = await db.users
  .where(u => exists(u.posts!.where(p => gt(p.views, 120))))
  .select(u => ({ id: u.id, username: u.username }))
  .toList();
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."views" > $1)
-- params: [120]
```

```ts
// A subquery: User has no navigation to TaskLevel; correlate through the outer row's column
const levelCreators = await db.users
  .where(u => exists(
    db.taskLevels
      .where(l => eq(l.createdById, u.id))
      .select(() => ({ one: literal(1) }))
      .asSubquery(),
  ))
  .select(u => ({ username: u.username }))
  .toList();
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 as "one"
FROM "task_levels"
WHERE "task_levels"."created_by_id" = "users"."id")
```

Several conditions go in the subquery's `where()`: `.where(o => and(eq(o.userId, u.id), eq(o.status, 'completed')))` renders `WHERE ("orders"."user_id" = "users"."id" AND "orders"."status" = $1)`.

> **Efficiency:** `EXISTS` stops at the first matching row, and PostgreSQL can plan an `EXISTS` that is a top-level (AND-ed) WHERE condition as a semi-join. The subquery's projection is never read: select a literal (`select(() => ({ one: literal(1) }))`).

**Why not a join.** A join to the many side returns the outer row once per match; `EXISTS` returns it once:

```ts
// One output row per matching post: alice twice
const viaJoin = await db.users
  .innerJoin(db.posts, (u, p) => and(eq(u.id, p.userId), gt(p.views, 50)), u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'alice' }, { username: 'bob' }]

// One output row per user
const viaExists = await db.users
  .where(u => exists(u.posts!.where(p => gt(p.views, 50))))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'bob' }]
```

The join:

```sql
SELECT "users"."username" as "username"
FROM "users"
INNER JOIN "posts" AS "posts_0" ON ("users"."id" = "posts_0"."user_id" AND "posts_0"."views" > $1)
```

`EXISTS`:

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id" AND "posts"."views" > $1)
```

> **Pitfall:** `selectDistinct()` removes the duplicates of the join, but PostgreSQL first produces every joined row and then sorts or hashes them; `EXISTS` never produces them. Join only when you need the other side's columns.

`exists()` here is the condition function. To ask whether a whole query has any row, use the terminal method: `await db.posts.where(p => gt(p.views, 180)).exists()` runs `SELECT EXISTS(SELECT 1 FROM "posts" WHERE "posts"."views" > $1)` and returns `true` / `false` (see the [Querying guide](./querying.md#check-whether-rows-exist-exists)).

## Keep rows without related rows: `notExists()`

`notExists(source)` renders `(NOT EXISTS (…))`, parenthesized so it stays one operand under `isNull`, a comparison, `IN` or `BETWEEN`. It is the NULL-safe anti-join: prefer it to `notInSubquery`.

```ts
import { eq, literal, notExists } from 'linkgress-orm';

const withoutPosts = await db.users
  .where(u => notExists(u.posts!))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'charlie' }]

const neverCreatedALevel = await db.users
  .where(u => notExists(db.taskLevels.where(l => eq(l.createdById, u.id)).select(() => ({ one: literal(1) })).asSubquery()))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'charlie' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (NOT EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id"))
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (NOT EXISTS (SELECT 1 as "one"
FROM "task_levels"
WHERE "task_levels"."created_by_id" = "users"."id"))
```

> **Efficiency:** PostgreSQL can plan a `NOT EXISTS` that is a top-level (AND-ed) WHERE condition as an anti-join. The NULL semantics of `NOT IN (SELECT …)` keep PostgreSQL (through version 18) from planning it as one, and it returns no row at all once the subquery yields a NULL; see [Exclude keys another query computes](#exclude-keys-another-query-computes-notinsubquery).

## Project a has-related-rows flag

`exists()` and `notExists()` are `SqlFragment<boolean>` values: project them as columns. They read as booleans, never NULL. `.mapWith(fn)` converts the read value; `.as(name)` and `.mapWith(fn)` keep the expression a projected column.

```ts
import { eq, literal, exists, notExists } from 'linkgress-orm';

const flags = await db.users
  .select(u => ({
    username: u.username,
    hasPosts: exists(u.posts!),
    createdALevel: exists(db.taskLevels.where(l => eq(l.createdById, u.id)).select(() => ({ one: literal(1) })).asSubquery()),
    label: notExists(u.posts!).mapWith((none: boolean) => (none ? 'no posts' : 'author')),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', hasPosts: true, createdALevel: true, label: 'author' }, …,
//  { username: 'charlie', hasPosts: false, createdALevel: false, label: 'no posts' }]
```

```sql
SELECT "users"."username" as "username", EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "hasPosts", EXISTS (SELECT 1 as "one"
FROM "task_levels"
WHERE "task_levels"."created_by_id" = "users"."id") as "createdALevel", (NOT EXISTS (SELECT 1 FROM "posts"
WHERE "posts"."user_id" = "users"."id")) as "label"
FROM "users"
ORDER BY "username" ASC
```

## Filter by keys another query computes: `inSubquery()`

`inSubquery(column, subquery)` renders `column IN (SELECT …)`. The subquery is an `'array'` subquery of ONE value. It replaces the two-phase read that fetches keys and sends them back:

```ts
import { eq, inArray, inSubquery } from 'linkgress-orm';

// Anti-pattern: 2 round trips, and one placeholder per key in the second statement
const ids = await db.users.where(u => eq(u.isActive, true)).select(u => u.id).toList();
const postsTwoTrips = await db.posts.where(p => inArray(p.userId, ids)).select(p => ({ title: p.title })).toList();

// 1 round trip
const activeUserIds = db.users.where(u => eq(u.isActive, true)).select(u => u.id).asSubquery('array');
const posts = await db.posts
  .where(p => inSubquery(p.userId, activeUserIds))
  .select(p => ({ title: p.title }))
  .toList();
```

The anti-pattern, 2 statements:

```sql
-- #1 query
SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1
-- #2 query
SELECT "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" IN ($1, $2)
-- params: [1, 2]
```

`inSubquery`, 1 statement:

```sql
SELECT "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" IN (SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1)
-- params: [true]
```

> **Efficiency:** one round trip; the keys never travel to the client and back; the statement text does not depend on how many keys match (the two-phase form has one placeholder per key, so a new text per key count). PostgreSQL can plan `IN (SELECT …)` as a semi-join.

An optional column needs `!`: `inSubquery(u.age!, ages)`.

## Exclude keys another query computes: `notInSubquery()`

`notInSubquery(column, subquery)` renders `column NOT IN (SELECT …)`. Use it only when neither the column nor the subquery's column can be NULL.

```ts
import { gt, notInSubquery } from 'linkgress-orm';

// Users without a post above 120 views (posts.user_id is NOT NULL)
const busyAuthors = db.posts.where(p => gt(p.views, 120)).select(p => p.userId).asSubquery('array');
const quiet = await db.users
  .where(u => notInSubquery(u.id, busyAuthors))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'charlie' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."id" NOT IN (SELECT "posts"."user_id"
FROM "posts"
WHERE "posts"."views" > $1)
-- params: [120]
```

> **Pitfall:** `x NOT IN (…)` is NULL, not TRUE, as soon as the subquery yields one NULL, so the WHERE drops every row. `posts.subtitle` is nullable and NULL in the seed data:

```ts
import { eq, literal, notExists, notInSubquery } from 'linkgress-orm';

// Wrong: no rows at all
const none = await db.users
  .where(u => notInSubquery(u.username, db.posts.select(p => p.subtitle!).asSubquery('array')))
  .select(u => ({ username: u.username }))
  .toList();
// []

// Right: NOT EXISTS is NULL-safe
const all = await db.users
  .where(u => notExists(db.posts.where(p => eq(p.subtitle!, u.username)).select(() => ({ one: literal(1) })).asSubquery()))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'bob' }, { username: 'charlie' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."username" NOT IN (SELECT "posts"."subtitle"
FROM "posts")
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (NOT EXISTS (SELECT 1 as "one"
FROM "posts"
WHERE "posts"."subtitle" = "users"."username"))
```

## Match against one array: `eqAnySubquery()` / `neAllSubquery()`

`eqAnySubquery(field, subquery)` renders `(field = ANY (ARRAY(<subquery>)))`; `neAllSubquery` renders `(field <> ALL (ARRAY(<subquery>)))`. The subquery's one column is collected into ONE array instead of being semi-joined. Choose it over `inSubquery` when the subquery is uncorrelated, returns few values and the outer column is indexed: PostgreSQL builds the array once (an InitPlan) and can use it as an index condition.

```ts
import { eq, eqAnySubquery, neAllSubquery } from 'linkgress-orm';

const activeUserIds = db.users.where(u => eq(u.isActive, true)).select(u => u.id).asSubquery('array');
const byActiveUsers = await db.posts
  .where(p => eqAnySubquery(p.userId, activeUserIds))
  .select(p => ({ title: p.title }))
  .toList();

const notByInactiveUsers = await db.posts
  .where(p => neAllSubquery(p.userId, db.users.where(u => eq(u.isActive, false)).select(u => u.id).asSubquery('array')))
  .select(p => ({ title: p.title }))
  .toList();
```

```sql
SELECT "posts"."title" as "title"
FROM "posts"
WHERE ("posts"."user_id" = ANY (ARRAY(SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1)))
```

```sql
SELECT "posts"."title" as "title"
FROM "posts"
WHERE ("posts"."user_id" <> ALL (ARRAY(SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $1)))
```

Semantics:

| Case | `eqAnySubquery` | `neAllSubquery` |
|---|---|---|
| Empty subquery result | FALSE (for every row, a NULL field included) | TRUE (a NULL field included) |
| NULL field, non-empty result | NULL | NULL |
| Result holds a NULL and no element equals the field | NULL | NULL (the row is dropped, like `NOT IN`) |

The subquery must have exactly one column; it may be an `'array'` or a `'table'` subquery. Its typing accepts any `'array'` or `'table'` subquery whatever its element type, so it is the typed way to test against a grouped or union subquery that projects an object of one column:

```ts
import { gt, eqAnySubquery } from 'linkgress-orm';

// Users with more than one post
const prolific = db.posts
  .select(p => ({ userId: p.userId }))
  .groupBy(p => ({ userId: p.userId }))
  .having(g => gt(g.count(), 1))
  .select(g => ({ userId: g.key.userId }))
  .asSubquery('array');
const prolificUsers = await db.users
  .where(u => eqAnySubquery(u.id, prolific))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE ("users"."id" = ANY (ARRAY(SELECT "posts"."user_id" as "userId"
FROM "posts"
GROUP BY "posts"."user_id"
HAVING COUNT(*) > $1)))
-- params: [1]
```

- The whole expression is parenthesized, so it stays one operand: `eq(eqAnySubquery(p.userId, activeUserIds), true)` renders `WHERE ("posts"."user_id" = ANY (ARRAY(SELECT … WHERE "users"."is_active" = $1))) = $2`. It is a `SqlFragment<boolean>`: project it as a flag the same way.
- Only the subquery's own parameters are bound; the field's refs and the subquery's correlation refs are reported, so the navigations they read are joined.
- The compiler does not count the subquery's columns: a two-column `'table'` subquery compiles and fails on the server with `subquery must return only one column`.

> **Pitfall:** a correlated `eqAnySubquery` builds one array per outer row; use `exists` there. A large result is materialized as one array; `inSubquery` scales better.

## Compare a column with a computed value

`eqSubquery`, `neSubquery`, `gtSubquery`, `gteSubquery`, `ltSubquery`, `lteSubquery` compare a column with a `'scalar'` subquery (`=`, `!=`, `>`, `>=`, `<`, `<=`). The operators `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `startsWith`, the regex operators, `isNull`, `isNotNull`, `between` and `inArray` / `notInArray` take a `'scalar'` subquery as an operand too: either side of a comparison, the field or a bound of `between`, the field of `inArray`. It renders `(<subquery>)` with its parameters in textual order.

```ts
import { agg, eq, gt, gtSubquery, sql } from 'linkgress-orm';

// Posts with more views than the average post
const avgViews = db.posts.select(p => sql<number>`AVG(${p.views})`).asSubquery('scalar');
const popular = await db.posts
  .where(p => gtSubquery(p.views, avgViews))
  .select(p => ({ title: p.title, views: p.views }))
  .toList();
// [{ title: 'Bob Post', views: 200 }]

// An optional column: gt() takes it as it is (gtSubquery needs u.age!)
const avgAge = db.users.select(u => agg.avg(u.age)).asSubquery('scalar');
const olderThanAverage = await db.users
  .where(u => gt(u.age, avgAge))
  .select(u => ({ username: u.username, age: u.age }))
  .toList();
// [{ username: 'charlie', age: 45 }]

// A key looked up by another query
const authorOfBobPost = await db.users
  .where(u => eq(u.id, db.posts.where(p => eq(p.title, 'Bob Post')).select(p => p.userId).asSubquery('scalar')))
  .select(u => ({ username: u.username }))
  .toList();
```

```sql
SELECT "posts"."title" as "title", "posts"."views" as "views"
FROM "posts"
WHERE "posts"."views" > (SELECT AVG("posts"."views")
FROM "posts")
```

```sql
SELECT "users"."username" as "username", "users"."age" as "age"
FROM "users"
WHERE "users"."age" > (SELECT avg("users"."age")
FROM "users")
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."id" = (SELECT "posts"."user_id"
FROM "posts"
WHERE "posts"."title" = $1)
-- params: ["Bob Post"]
```

The other operators render the same way: `like(<subquery>, 'Alice%')` → `WHERE (SELECT "posts"."title" FROM "posts" WHERE … LIMIT 1) LIKE $1`; `isNull(<subquery>)` → `WHERE (SELECT …) IS NULL`; `between(<subquery>, 90, 160)` → `WHERE (SELECT …) BETWEEN $1 AND $2`.

A collection's `count()` compares the same way; its `min()` / `max()` / `sum()` do not (they throw `buildSql() on CollectionQueryBuilder is only supported for EXISTS and COUNT aggregations`). Compare a per-row MAX through a scalar subquery:

```ts
import { agg, eq, gt } from 'linkgress-orm';

const prolific = await db.users.where(u => gt(u.posts!.count(), 1)).select(u => ({ username: u.username })).toList();

const hasHit = await db.users
  .where(u => gt(db.posts.where(p => eq(p.userId, u.id)).select(p => agg.max(p.views)).asSubquery('scalar'), 120))
  .select(u => ({ username: u.username }))
  .toList();
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (SELECT COUNT(*) FROM "posts" "posts__count"
WHERE "posts__count"."user_id" = "users"."id") > $1
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (SELECT max("posts"."views")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") > $1
```

> **Efficiency:** an uncorrelated scalar subquery (the averages above) is evaluated once per statement; a correlated one once per outer row.

> **Pitfall:** no `LIMIT` is added. A scalar subquery that returns two or more rows fails with `more than one row returned by a subquery used as an expression` (SQLSTATE 21000): aggregate, or add `.limit(1)` with an `orderBy()`. Two projected columns fail with `subquery must return only one column`.

## Project a per-row value: a scalar subquery in `select()`

A `'scalar'` subquery as a projection value renders `(SELECT …) as "name"`, correlated through the outer columns it reads. When a navigation models the relation, use the collection aggregates instead: the same result, and the [collection strategy](../collection-strategies.md) chooses the shape.

```ts
import { agg, eq } from 'linkgress-orm';

// Hand-built scalar subqueries
const stats = await db.users
  .select(u => ({
    username: u.username,
    postCount: db.posts.where(p => eq(p.userId, u.id)).select(() => agg.count()).asSubquery('scalar'),
    maxViews: db.posts.where(p => eq(p.userId, u.id)).select(p => agg.max(p.views)).asSubquery('scalar'),
  }))
  .orderBy(u => u.username)
  .toList();

// Preferred when the navigation exists: collection aggregates
const viaCollections = await db.users
  .select(u => ({ username: u.username, postCount: u.posts!.count(), maxViews: u.posts!.max(p => p.views) }))
  .orderBy(u => u.username)
  .toList();

// The same under the 'cte' collection strategy, chosen for this query
const viaCte = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .select(u => ({ username: u.username, postCount: u.posts!.count(), maxViews: u.posts!.max(p => p.views) }))
  .orderBy(u => u.username)
  .toList();
// All three: [{ username: 'alice', postCount: 2, maxViews: 150 }, { username: 'bob', postCount: 1, maxViews: 200 },
//             { username: 'charlie', postCount: 0, maxViews: null }]
```

Scalar subqueries:

```sql
SELECT "users"."username" as "username", (SELECT count(*)
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "postCount", (SELECT max("posts"."views")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "maxViews"
FROM "users"
ORDER BY "username" ASC
```

Collection aggregates under the default `lateral` strategy, the same correlated subqueries:

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(MAX("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "maxViews"
FROM "users"
ORDER BY "username" ASC
```

Under the `cte` strategy, one `GROUP BY` pass per aggregate, joined back:

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
ORDER BY "username" ASC
```

> **Efficiency:** a correlated scalar subquery runs once per outer row: fine for a page of rows, costly over a whole table. For all rows of a large table, join a grouped `'table'` subquery ([Join a derived table](#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)) or use the `cte` strategy.

Use a scalar subquery when no navigation models the value, or for a top-1 value (ORDER BY + LIMIT 1):

```ts
import { eq } from 'linkgress-orm';

const topPost = await db.users
  .select(u => ({
    username: u.username,
    topPost: db.posts
      .where(p => eq(p.userId, u.id))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(1)
      .select(p => p.title)
      .asSubquery('scalar'),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', topPost: 'Alice Post 2' }, { username: 'bob', topPost: 'Bob Post' }, { username: 'charlie', topPost: undefined }]
```

```sql
SELECT "users"."username" as "username", (SELECT "posts"."title"
FROM "posts"
WHERE "posts"."user_id" = "users"."id"
ORDER BY "posts"."views" DESC
LIMIT 1) as "topPost"
FROM "users"
ORDER BY "username" ASC
```

**How the value reads back** (one column: since 1.0.29):

| The subquery projects | Reads as | NULL (no row, or a NULL value) at the top level |
|---|---|---|
| ONE column with a mapper (`p.publishTime`) | through the column's mapper (`{ hour: 9, minute: 30 }`) | `null` |
| ONE column without a mapper | a value of its SQL type: a text column's `'007'` stays `'007'`, an integer column reads a number | `undefined` (`charlie` above) |
| ONE aggregate (`agg.count()`, `agg.max(p.views)`) | like the aggregate: `agg.max` of a text column keeps `'007'`, of a mapped column goes through its mapper | `null` (`count` gives `0`) |
| ONE read-typed fragment (`` sql<string>`…`.withReadType('text') ``) | as that type | `undefined` |
| Any other expression (an `` sql`…` `` fragment without a read type) | raw: a numeric-looking string becomes a number (`'007'` → `7`) | `undefined` |

The one-column rule applies to a column of a table, a navigation, a CTE, a set, a grouped query's key or MIN / MAX, and a union's first leg, wherever the subquery is projected: an entity query, a nested object, a CTE-rooted query, a set query, a [`QueryBatch`](./batching-and-prepared-queries.md) leg, a CTE body read back through `selectFromCte`. Inside a nested object or a collection item a NULL reads `null`. Type any other value yourself with `.asExpression<string>().withReadType('text')` or `.mapWith(…)` ([asExpression](#use-a-scalar-subquery-inside-an-expression-asexpression)), or use [`AliasedScope.scalar()`](./aliased-scopes.md) for a column of an aliased scope.

## Read several columns of the same related row: use a collection

Each scalar subquery is evaluated on its own: two columns of the top post cost two probes. A collection's `firstOrDefault()` reads the whole row once and returns an object or `null`: one LATERAL probe under the default `lateral` strategy, one `ROW_NUMBER()` CTE under `cte` (still 1 statement).

```ts
import { eq } from 'linkgress-orm';

// Two probes for two columns of the same row
const twice = await db.users
  .select(u => ({
    username: u.username,
    topTitle: db.posts.where(p => eq(p.userId, u.id)).orderBy(p => [[p.views, 'DESC']]).limit(1).select(p => p.title).asSubquery('scalar'),
    topViews: db.posts.where(p => eq(p.userId, u.id)).orderBy(p => [[p.views, 'DESC']]).limit(1).select(p => p.views).asSubquery('scalar'),
  }))
  .toList();

// One probe for the whole row
const once = await db.users
  .select(u => ({
    username: u.username,
    topPost: u.posts!
      .orderBy(p => [[p.views, 'DESC']])
      .select(p => ({ title: p.title, views: p.views }))
      .firstOrDefault('topPost'),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', topPost: { title: 'Alice Post 2', views: 150 } }, …, { username: 'charlie', topPost: null }]
```

The collection form under the default `lateral` strategy:

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
ORDER BY "username" ASC
```

For every related row, use `u.posts!.select(…).toList()` (see the [Querying guide](./querying.md) and [Collection strategies](../collection-strategies.md)). For a reference navigation read through a LATERAL probe, see [Lateral navigation joins](./lateral-navigation-joins.md).

## Use a scalar subquery inside an expression: `asExpression()`

A `Subquery` is a value, not a fragment: it has no fragment methods (`.mapWith()`, `.withReadType()`; its `.as()` sets an alias nothing reads), `orderBy()` refuses it as a key, and as an UPDATE SET value it compiles but is bound as a parameter (see the pitfall below). As an operand of `coalesce`, CASE or arithmetic it renders `(<subquery>)` too, but `coalesce` and CASE then type the value as `T | <the Subquery object>` (`coalesce(<bare string subquery>, 'none')` is not a `string`). `.asExpression<T>()` turns a `'scalar'` subquery into a `SqlFragment<T>` that renders `(<subquery>)`, with its parameters in the enclosing statement's sequence and its correlation refs reported (outer navigations are joined). Use it for defaults (`coalesce`), arithmetic, `isNull` / CASE conditions, sort keys and UPDATE SET values.

```ts
import { add, agg, coalesce, eq } from 'linkgress-orm';

const derived = await db.users
  .select(u => ({
    username: u.username,
    firstTitle: coalesce(
      db.posts.where(p => eq(p.userId, u.id)).orderBy(p => p.id).limit(1).select(p => p.title).asSubquery('scalar').asExpression<string>(),
      'none',
    ),
    postsPlusOne: add(db.posts.where(p => eq(p.userId, u.id)).select(() => agg.count()).asSubquery('scalar').asExpression<number>(), 1),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', firstTitle: 'Alice Post 1', postsPlusOne: 3 }, …, { username: 'charlie', firstTitle: 'none', postsPlusOne: 1 }]
```

```sql
SELECT "users"."username" as "username", COALESCE((SELECT "posts"."title"
FROM "posts"
WHERE "posts"."user_id" = "users"."id"
ORDER BY "posts"."id" ASC
LIMIT 1), $1) as "firstTitle", ((SELECT count(*)
FROM "posts"
WHERE "posts"."user_id" = "users"."id") + $2) as "postsPlusOne"
FROM "users"
ORDER BY "username" ASC
-- params: ["none", 1]
```

As a sort key, and as an UPDATE SET value (read-modify-write in one statement instead of a read and a write):

```ts
import { agg, coalesce, eq } from 'linkgress-orm';

const byPostCount = await db.users
  .orderBy(u => [[db.posts.where(p => eq(p.userId, u.id)).select(() => agg.count()).asSubquery('scalar').asExpression<number>(), 'DESC']])
  .select(u => ({ username: u.username }))
  .toList();

await db.users
  .where(u => eq(u.username, 'charlie'))
  .update(u => ({
    age: coalesce(db.posts.where(p => eq(p.userId, u.id)).select(p => agg.max(p.views)).asSubquery('scalar').asExpression<number>(), 0),
  }));
```

```sql
SELECT "users"."username" as "username"
FROM "users"
ORDER BY ((SELECT count(*)
FROM "posts"
WHERE "posts"."user_id" = "users"."id")) DESC
```

```sql
UPDATE "users" SET "age" = COALESCE((SELECT max("posts"."views")
FROM "posts"
WHERE "posts"."user_id" = "users"."id"), $1) WHERE "users"."username" = $2
-- params: [0, "charlie"]
```

A helper that returns the expression gives one definition for SELECT, WHERE and UPDATE SET:

```ts
import { coalesce, eq } from 'linkgress-orm';
import type { SqlOperand } from 'linkgress-orm';

const authorName = (userId: SqlOperand<number>) =>
  db.users.where(u => eq(u.id, userId)).select(u => u.username).asSubquery('scalar').asExpression<string>();

await db.posts.select(p => ({ title: p.title, author: coalesce(authorName(p.userId), 'unknown') })).toList();
await db.posts.where(p => eq(authorName(p.userId), 'bob')).select(p => ({ title: p.title })).toList();
await db.posts.where(p => eq(p.title, 'Bob Post')).update(p => ({ subtitle: authorName(p.userId) }));
```

```sql
-- #1 query
SELECT "posts"."title" as "title", COALESCE((SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "posts"."user_id"), $1) as "author"
FROM "posts"
-- #2 query
SELECT "posts"."title" as "title"
FROM "posts"
WHERE (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "posts"."user_id") = $1
-- #3 query
UPDATE "posts" SET "subtitle" = (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "posts"."user_id") WHERE "posts"."title" = $1
```

- **Reads raw.** The expression carries no mapper: projected, it reads like a raw `sql` fragment (a numeric-looking string becomes a number, NULL reads `undefined` at the top level). Chain `.withReadType('text')` or `.mapWith(…)` to type the read. In a plain projection or comparison keep the `Subquery` itself: it keeps its one-column read.
- **Scalar only.** `asExpression()` on an `'array'` or `'table'` subquery throws `asExpression(): only a scalar subquery is an expression — build it with .asSubquery('scalar') (this one is 'array')`.

> **Pitfall:** `coalesce(<subquery of an enum column>, 'none')` fails with `invalid input value for enum order_status: "none"`: the bound default takes the enum type. Cast the subquery to text first: `coalesce(cast<string>(sub.asExpression(), 'text'), 'none')` renders `COALESCE(CAST((SELECT "orders"."status" …) AS text), $1)`.

> **Pitfall:** an UPDATE SET value must be `.asExpression()`. A bare `Subquery` there compiles, but the statement binds the Subquery object itself as a parameter: a text column silently stores its JSON (`{"outerFieldRefs":[…],…,"__mode":"scalar"}`), an integer column fails with `invalid input syntax for type integer`.

```ts
import { eq } from 'linkgress-orm';

// Wrong: compiles, but the Subquery object itself is bound as $1
await db.posts
  .where(p => eq(p.title, 'Bob Post'))
  .update(p => ({ subtitle: db.users.where(u => eq(u.id, p.userId)).select(u => u.username).asSubquery('scalar') }));

// Right: asExpression() renders the subquery
await db.posts
  .where(p => eq(p.title, 'Bob Post'))
  .update(p => ({ subtitle: db.users.where(u => eq(u.id, p.userId)).select(u => u.username).asSubquery('scalar').asExpression<string>() }));
```

```sql
-- #1 query
UPDATE "posts" SET "subtitle" = $1 WHERE "posts"."title" = $2
-- #2 query
UPDATE "posts" SET "subtitle" = (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "posts"."user_id") WHERE "posts"."title" = $1
-- params: ["Bob Post"]
```

## Join a derived table: `innerJoin()` / `leftJoin()` with a `'table'` subquery

`innerJoin(subquery, on, select, alias)` / `leftJoin(…)` join a `'table'` subquery as a derived table: a grouped query, a filtered query, a CTE-rooted query or a set. Use it for per-parent aggregates over many or all parents (one `GROUP BY` pass, hash- or merge-joined, instead of a correlated subquery per row) and whenever you need the derived rows' columns.

```ts
import { eq } from 'linkgress-orm';

const perUser = db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(p => ({ userId: p.userId }))
  .select(g => ({ userId: g.key.userId, totalViews: g.sum(p => p.views), postCount: g.count() }))
  .asSubquery('table');

const totals = await db.users
  .innerJoin(
    perUser,
    (u, s) => eq(u.id, s.userId),
    (u, s) => ({ username: u.username, totalViews: s.totalViews, postCount: s.postCount }),
    'per_user',
  )
  .orderBy(r => r.username)
  .toList();
// [{ username: 'alice', totalViews: 250, postCount: 2 }, { username: 'bob', totalViews: 200, postCount: 1 }]
```

```sql
SELECT "users"."username" as "username", "per_user"."totalViews" as "totalViews", "per_user"."postCount" as "postCount"
FROM "users"
INNER JOIN (SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "totalViews", CAST(COUNT(*) AS INTEGER) as "postCount"
FROM "posts"
GROUP BY "posts"."user_id") AS "per_user" ON "users"."id" = "per_user"."userId"
ORDER BY "username" ASC
```

`leftJoin` keeps outer rows without a match; their derived columns read `undefined`, not `null`:

```ts
const all = await db.users
  .leftJoin(perUser, (u, s) => eq(u.id, s.userId), (u, s) => ({ username: u.username, totalViews: s.totalViews }), 'per_user')
  .orderBy(r => r.username)
  .toList();
// [{ username: 'alice', totalViews: 250 }, { username: 'bob', totalViews: 200 }, { username: 'charlie', totalViews: undefined }]
```

```sql
SELECT "users"."username" as "username", "per_user"."totalViews" as "totalViews"
FROM "users"
LEFT JOIN (SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "totalViews", CAST(COUNT(*) AS INTEGER) as "postCount"
FROM "posts"
GROUP BY "posts"."user_id") AS "per_user" ON "users"."id" = "per_user"."userId"
ORDER BY "username" ASC
```

A filtered body renders its WHERE inside the derived table:

```ts
import { eq, gt } from 'linkgress-orm';

const popular = db.posts.where(p => gt(p.views, 120)).select(p => ({ userId: p.userId, title: p.title })).asSubquery('table');
const rows = await db.users
  .innerJoin(popular, (u, p) => eq(u.id, p.userId), (u, p) => ({ username: u.username, title: p.title }), 'popular')
  .toList();
```

```sql
SELECT "users"."username" as "username", "popular"."title" as "title"
FROM "users"
INNER JOIN (SELECT "posts"."user_id" as "userId", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."views" > $1) AS "popular" ON "users"."id" = "popular"."userId"
-- params: [120]
```

- **The alias is the 4th argument** and is required (the typings demand it; without it the call throws `Alias is required when joining a subquery`). `Subquery.as(alias)` sets an alias no join reads.
- **Columns read through the body's own mappers.** A CTE-rooted body declares its `WITH` inside the parentheses, or once at statement level when the executing query declares the CTE with `.with(cte)` ([CTE guide](./cte-guide.md)); a set body (`fromSet(unnestZip(…), 'z').asSubquery('table')`) joins JS tuples bound as one array parameter per column ([Set-returning functions](./set-returning-functions.md)).
- **A 1:N derived table duplicates outer rows**, like any join. To filter only, use `exists` / `inSubquery`.
- **No subquery as the FROM root.** For a query rooted at a derived relation use a CTE and `db.selectFromCte()`, or `db.selectFromSet()` for a set.

## Correlate with the outer row

A subquery correlates by reading the outer row's columns in its callbacks (`eq(p.userId, u.id)`). When it reads a **navigation** of the outer row, the enclosing query joins that navigation, through several navigation levels and at any depth of the projection, whether the subquery sits in the projection, the WHERE, a nested object, a UNION leg or a collection's item:

```ts
import { and, eq, gt, literal, exists } from 'linkgress-orm';

// In a projection: the next older user than each post's author
const nextOlder = await db.posts
  .select(p => ({
    title: p.title,
    nextOlder: db.users.where(u => gt(u.age, p.user!.age)).orderBy(u => u.age).limit(1).select(u => u.username).asSubquery('scalar'),
  }))
  .toList();

// In a WHERE: comments on posts whose author has a pending order
const comments = await db.postComments
  .where(c => exists(
    db.orders
      .where(o => and(eq(o.userId, c.post!.userId), eq(o.status, 'pending')))
      .select(() => ({ one: literal(1) }))
      .asSubquery(),
  ))
  .select(c => ({ comment: c.comment }))
  .toList();
```

```sql
SELECT "posts"."title" as "title", (SELECT "users"."username"
FROM "users"
WHERE "users"."age" > "user"."age"
ORDER BY "users"."age" ASC
LIMIT 1) as "nextOlder"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
```

```sql
SELECT "post_comments"."comment" as "comment"
FROM "post_comments"
LEFT JOIN "posts" AS "post" ON "post_comments"."post_id" = "post"."id"
WHERE EXISTS (SELECT 1 as "one"
FROM "orders"
WHERE ("orders"."user_id" = "post"."user_id" AND "orders"."status" = $1))
-- params: ["pending"]
```

In a collection's item, the collection joins the item's navigations the subquery reads, under every strategy (`lateral`, `cte`, `temptable`). Under the default `lateral` strategy:

```ts
import { eq } from 'linkgress-orm';

const rows = await db.posts
  .select(p => ({
    title: p.title,
    comments: p.postComments!.select(c => ({
      comment: c.comment,
      orderOwner: db.users.where(u => eq(u.id, c.order!.userId)).select(u => u.username).asSubquery('scalar'),
    })).toList('comments'),
  }))
  .toList();
```

```sql
SELECT "posts"."title" as "title", COALESCE("lateral_0".data, '[]'::json) as "comments"
FROM "posts"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('comment', "comment", 'orderOwner', "orderOwner")
) as data
FROM (
  SELECT "lateral_0_postComments"."comment" as "comment", (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "order"."user_id") as "orderOwner"
  FROM "post_comments" "lateral_0_postComments"
  LEFT JOIN "orders" "order" ON "lateral_0_postComments"."order_id" = "order"."id"
  WHERE "lateral_0_postComments"."post_id" = "posts"."id"
) sub) "lateral_0" ON true
```

**Two paths ending in the same relation name.** Each navigation path is its own join. The paths the query reads itself (its projection, WHERE, ORDER BY, the path a collection hangs off) keep the aliases they render under without the subquery; the subquery's path takes the path alias `<parent>__<relation>` (`"order__user"` below `order`; a first hop renders `"<table>__<relation>"`). A raw `sql` fragment naming `"user"` therefore reads the query's own join:

```ts
import { eq, sql } from 'linkgress-orm';

const paths = await db.postComments
  .select(c => ({
    comment: c.comment,
    postAuthor: c.post!.user!.username,                                                                   // "user"
    orderOwner: db.users.where(u => eq(u.id, c.order!.user!.id)).select(u => u.username).asSubquery('scalar'), // "order__user"
    raw: sql<string>`"user"."username"`,                                                                  // the post's author
  }))
  .toList();
```

```sql
SELECT "post_comments"."comment" as "comment", "user"."username" as "postAuthor", (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "order__user"."id") as "orderOwner", "user"."username" as "raw"
FROM "post_comments"
LEFT JOIN "posts" AS "post" ON "post_comments"."post_id" = "post"."id"
LEFT JOIN "orders" AS "order" ON "post_comments"."order_id" = "order"."id"
INNER JOIN "users" AS "user" ON "post"."user_id" = "user"."id"
INNER JOIN "users" AS "order__user" ON "order"."user_id" = "order__user"."id"
```

- **Grouped subqueries** (`groupBy(…).select(…).asSubquery()`) report no outer refs: they may correlate on the outer row's own columns (`eq(c.postId, p.id)`), but an outer navigation they read is not joined and the statement fails with `missing FROM-clause entry for table "user"`. Read the navigation's key column instead, or move the navigation into the outer query.
- **A raw correlation** names the outer alias by hand: ``eq(p.userId, sql<number>`"users"."id"`)`` renders `WHERE "posts"."user_id" = "users"."id"`. It breaks where the outer row renders under another alias: in a collection item the row is `"lateral_0_posts"`, and a hand-written `"posts"."id"` fails with `invalid reference to FROM-clause entry for table "posts"`. Pass the column (`u.id`, `p.id`) instead; it renders under whatever alias the row has.
- **Correlation is resolved by chain identity, not by name:** a subquery correlates to an outer table even when one of its own navigations carries the same name (common with singular table names, where a child's `library` navigation points at a table also called `library`).

## Subqueries over the outer row's own table

A subquery over the same table as the outer row cannot be correlated through `db.<table>.where(…).asSubquery()`: inner and outer FROM would share the alias, and the correlation would compare the inner row with itself. `asSubquery()` throws as soon as it is called (here inside the `where()` callback), before anything is sent:

```ts
import { and, eq, gt, literal, exists } from 'linkgress-orm';

db.posts.where(p => exists(
  db.posts
    .where(p2 => and(eq(p2.userId, p.userId), gt(p2.views, p.views)))
    .select(() => ({ one: literal(1) }))
    .asSubquery(),
));
// throws: Correlated standalone subquery over table "posts" references the same table from the outer query. …
```

Two ways that work, both 1 round trip:

```ts
import { and, eq, gt, exists } from 'linkgress-orm';

// 1. An aliased scope names its side apart (no join): see aliased-scopes.md
const outranked = await db.posts
  .where(p => db.posts.as('rival').where(r => and(eq(r.userId, p.userId), gt(r.views, p.views))).exists())
  .select(p => ({ title: p.title }))
  .toList();

// 2. A collection of a navigation over the same table
const outranked2 = await db.posts
  .where(p => exists(p.user!.posts!.where(p2 => gt(p2.views, p.views))))
  .select(p => ({ title: p.title }))
  .toList();
// Both: [{ title: 'Alice Post 1' }]
```

The aliased scope:

```sql
SELECT "posts"."title" as "title"
FROM "posts"
WHERE EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE ("rival"."user_id" = "posts"."user_id" AND "rival"."views" > "posts"."views"))
```

The collection of a navigation:

```sql
SELECT "posts"."title" as "title"
FROM "posts"
WHERE EXISTS (SELECT 1 FROM "posts" "posts__exists"
JOIN "users" "user" ON "posts"."user_id" = "user"."id"
WHERE "posts__exists"."user_id" = "user"."id" AND "posts__exists"."views" > "posts"."views")
```

A table's relation to itself (a tree's `n.children`) works the same way: see [Collections reached through navigations](./querying.md#collections-reached-through-navigations).

The second refused shape: a subquery that correlates to an outer alias AND joins a navigation of its own under the same alias. Here the outer `p.user` and the orders' own `o.user` both render as `"user"`; the statement is refused when it is built, before anything is sent:

```ts
import { and, eq, literal, exists } from 'linkgress-orm';

await db.posts
  .where(p => exists(
    db.orders
      .where(o => and(eq(o.userId, p.user!.id), eq(o.user!.isActive, true)))
      .select(() => ({ one: literal(1) }))
      .asSubquery(),
  ))
  .toList();
// throws: Correlated subquery over table "orders" both correlates to an outer "user" and joins its own "user" navigation. …
```

Fix it by traversing the navigation in the outer query, by correlating on a plain key column (`eq(o.userId, p.userId)`), or by renaming the navigation property.

## Subqueries over unions, CTEs and sets

A union is a subquery source like any query; its legs' correlations are all reported:

```ts
import { eq, notInSubquery } from 'linkgress-orm';

const excluded = db.users.where(u => eq(u.username, 'alice')).select(u => u.id)
  .union(db.users.where(u => eq(u.isActive, false)).select(u => u.id))
  .asSubquery('array');
const rest = await db.users.where(u => notInSubquery(u.id, excluded)).select(u => ({ username: u.username })).toList();
// [{ username: 'bob' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE "users"."id" NOT IN ((SELECT "users"."id"
FROM "users"
WHERE "users"."username" = $1)
UNION
(SELECT "users"."id"
FROM "users"
WHERE "users"."is_active" = $2))
-- params: ["alice", false]
```

A CTE read by a subquery: declare it on the executing query with `.with(cte)`, then read it with `db.selectFromCte(cte)…asSubquery()`. The body is declared once in the statement's `WITH`, however many subqueries read it:

```ts
import { DbCteBuilder, gt, inSubquery } from 'linkgress-orm';

const cteBuilder = new DbCteBuilder();
const olderUsers = cteBuilder.with('older_users', db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id, age: u.age })));
const postsOfOlder = await db.posts
  .with(olderUsers.cte)
  .where(p => inSubquery(p.userId, db.selectFromCte(olderUsers.cte).select(o => ({ id: o.id })).asSubquery('array')))
  .select(p => ({ title: p.title }))
  .toList();
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
FROM "users"
WHERE "users"."age" > $1)
SELECT "posts"."title" as "title"
FROM "posts"
WHERE "posts"."user_id" IN (SELECT "older_users"."id" as "id"
FROM "older_users")
-- params: [30]
```

> **Pitfall:** without `.with(cte)` on the executing query, every subquery that reads the CTE declares its own copy (text, parameters and work duplicated). See [Read one CTE from several subqueries](./cte-guide.md#read-one-cte-from-several-subqueries-declare-it-once).

Sets: `fromSet(set, alias).…asSubquery()` embeds a set of JS values or of a jsonb column's elements in `exists`, `inSubquery`, a scalar subquery or a join. For plain membership against a JS list, `inArrayOpt(col, list)` (data-driven lists) or `eqAny(col, list)` (one statement text for every length) is shorter: [Matching a list of values](./querying.md#matching-a-list-of-values). See [`fromSet()` subqueries](./set-returning-functions.md#test-each-row-against-a-list-or-a-jsonb-document-fromset-subqueries).

## Reuse a subquery, or put it in raw SQL

A `Subquery` is a value: build it once and embed it in several queries, or several times in one statement. Each embedding renders the full subquery text and binds its parameters again; for one set read in several places of a statement, a CTE is evaluated once.

```ts
import { and, eq, literal, sql, exists, gtSubquery } from 'linkgress-orm';

const avgViews = db.posts.select(p => sql<number>`AVG(${p.views})`).asSubquery('scalar');

// Used twice in one statement: in the projection and nested in an EXISTS
const above = await db.users
  .where(u => exists(
    db.posts
      .where(p => and(eq(p.userId, u.id), gtSubquery(p.views, avgViews)))
      .select(() => ({ one: literal(1) }))
      .asSubquery(),
  ))
  .select(u => ({ username: u.username, avgViews }))
  .toList();
// [{ username: 'bob', avgViews: 150 }]
```

```sql
SELECT "users"."username" as "username", (SELECT AVG("posts"."views")
FROM "posts") as "avgViews"
FROM "users"
WHERE EXISTS (SELECT 1 as "one"
FROM "posts"
WHERE ("posts"."user_id" = "users"."id" AND "posts"."views" > (SELECT AVG("posts"."views")
FROM "posts")))
```

A `Subquery` interpolated into a `sql` template renders `(<subquery>)` with its parameters in the statement's sequence:

```ts
import { sql } from 'linkgress-orm';

const maxViews = db.posts.select(p => sql<number>`MAX(${p.views})`).asSubquery('scalar');
const flagged = await db.users
  .select(u => ({
    username: u.username,
    hasTopPost: sql<boolean>`EXISTS (SELECT 1 FROM "posts" WHERE "posts"."user_id" = ${u.id} AND "posts"."views" = ${maxViews})`,
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', hasTopPost: false }, { username: 'bob', hasTopPost: true }, { username: 'charlie', hasTopPost: false }]
```

```sql
SELECT "users"."username" as "username", EXISTS (SELECT 1 FROM "posts" WHERE "posts"."user_id" = "users"."id" AND "posts"."views" = (SELECT MAX("posts"."views")
FROM "posts")) as "hasTopPost"
FROM "users"
ORDER BY "username" ASC
```

`exists()` and `notExists()` do not take a `sql` fragment (they throw a `TypeError`); a raw `EXISTS` is written inside the template, as above.

## How PostgreSQL runs each form

| Form | Evaluated | Cost driver |
|---|---|---|
| Uncorrelated scalar `(SELECT AVG(…) …)` | once per statement (InitPlan) | the subquery |
| `EXISTS` / `NOT EXISTS` in a WHERE | as a semi- / anti-join when the planner can pull it up; otherwise per outer row, stopping at the first match | an index on the correlation column |
| `IN (SELECT …)` | as a semi-join (hash, merge or nested loop, chosen by cost) | the subquery's rows |
| `NOT IN (SELECT …)` | as a subplan (hashed when it fits in memory); through PostgreSQL 18 its NULL semantics keep it from being planned as an anti-join | NULL semantics (see the pitfall above) |
| `= ANY (ARRAY(SELECT …))`, uncorrelated | the array once (InitPlan), usable as an index condition | the array's size |
| Correlated scalar subquery in a projection | once per outer row (SubPlan) | outer rows × subquery cost |

- Index the correlation columns. In the example model, `posts` has the index `ix_posts_query` on `(user_id, published_at)`.
- Check a plan with `EXPLAIN (ANALYZE)` on a real server. The in-memory database answers `EXPLAIN` with the plan shape PostgreSQL typically chooses (an `IN (SELECT …)` reads `Hash Semi Join`, a `NOT EXISTS` `Hash Anti Join`), without costs or real timings: it has no cost-based planner ([In-memory database](./in-memory-database.md)).

## API signatures

```ts
// fragment: declared in src/query/subquery.ts, and asSubquery() on every query builder with a projection
asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(mode?: TMode): Subquery<…, TMode>;

class Subquery<TResult = any, TMode extends 'scalar' | 'array' | 'table' = 'table'> {
  asExpression<T = TResult>(): SqlFragment<T>;      // 'scalar' only; throws for 'array' / 'table'
  as(alias: string): Subquery<TResult, TMode>;      // an alias no join reads
  isScalar(): this is Subquery<TResult, 'scalar'>;
  isArray(): this is Subquery<TResult, 'array'>;
  isTable(): this is Subquery<TResult, 'table'>;
}

function exists(source: Subquery | CollectionSubquerySource): ExistsCondition;          // a SqlFragment<boolean>
function notExists(source: Subquery | CollectionSubquerySource): NotExistsCondition;    // a SqlFragment<boolean>
function inSubquery<T>(field: FieldRef<any, NonUndefined<T>>, subquery: Subquery<NonUndefined<T>[], 'array'>): InSubqueryCondition<NonUndefined<T>>;
function notInSubquery<T>(field: FieldRef<any, NonUndefined<T>>, subquery: Subquery<NonUndefined<T>[], 'array'>): NotInSubqueryCondition<NonUndefined<T>>;
function eqSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>;
// neSubquery (!=), gtSubquery (>), gteSubquery (>=), ltSubquery (<), lteSubquery (<=): the same signature
function eqAnySubquery<V>(field: FieldLike<V> | DbColumn<V> | SqlFragment<V> | undefined, subquery: Subquery<any, 'array' | 'table'>): SqlFragment<boolean>;
function neAllSubquery<V>(field: FieldLike<V> | DbColumn<V> | SqlFragment<V> | undefined, subquery: Subquery<any, 'array' | 'table'>): SqlFragment<boolean>;

// on db.<table> and on where() builders; a select builder has the same overload with column refs in `condition`;
// leftJoin has the same overloads
innerJoin<TRight extends Record<string, any>, TSelection>(
  rightTable: Subquery<TRight, 'table'>,
  condition: (left: EntityQuery<TEntity>, right: TRight) => Condition,
  selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection,
  alias: string,
): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;

function isSubquery(value: any): value is Subquery;
type SubqueryResult<T> = T extends Subquery<infer R, any> ? R : never;
type SubqueryMode<T> = T extends Subquery<any, infer M> ? M : never;
type ScalarSubqueryOperand<V> = Subquery<V, 'scalar'>;   // the subquery operand eq / gt / like / isNull / … accept
```

`isSubquery`, `SubqueryResult`, `SubqueryMode`, `ScalarSubqueryOperand` and `CollectionSubquerySource` are exported for helpers that accept either a subquery or a value.

## Type safety and its limits

Compiled against this repository's `src/`, the compiler checks subqueries:

```ts
import { gt, gtSubquery, inSubquery, sql } from 'linkgress-orm';

const avgAge = db.users.select(u => sql<number>`AVG(${u.age})`).asSubquery('scalar');

db.users.where(u => gtSubquery(u.age!, avgAge));                                             // number vs number
db.users.where(u => gt(u.age, avgAge));                                                      // gt() takes the optional column
db.posts.where(p => inSubquery(p.userId, db.users.select(u => u.id).asSubquery('array')));    // number vs number[]

// @ts-expect-error: u.age is optional; gtSubquery needs u.age!
db.users.where(u => gtSubquery(u.age, avgAge));
// @ts-expect-error: a string subquery against a number column
db.users.where(u => gtSubquery(u.age!, db.users.select(v => v.username).asSubquery('scalar')));
// @ts-expect-error: string[] against a number column
db.posts.where(p => inSubquery(p.userId, db.users.select(u => u.username).asSubquery('array')));
// @ts-expect-error: { id: number }[] is not number[]; project one value
db.posts.where(p => inSubquery(p.userId, db.users.select(u => ({ id: u.id })).asSubquery('array')));
```

A projected scalar subquery is typed by its value: `db.users.select(u => ({ id: u.id, avgAge })).toList()` returns `{ id: number; avgAge: number }[]`.

> **Pitfall:** the published typings (`dist/*.d.ts`) erase `Subquery`'s result and mode types: TypeScript emits its private marker fields without types. In an application that imports the npm package, `exists(<'array' subquery>)`, `inSubquery` with a mismatched element type and `gtSubquery(<number column>, <string subquery>)` compile. Match modes and element types yourself; the runtime does not check them either.

## Behavior changes by version

| Version | Change |
|---|---|
| 1.0.29 | A projected scalar subquery of ONE column reads like that column: a text column's `'0042'` stays text, a mapped column goes through its mapper (before: `'0042'` read as `42`, a mapped column as its stored value). |
| 1.0.9 | Added `eqAnySubquery` / `neAllSubquery`, `Subquery.asExpression()`, [aliased scopes](./aliased-scopes.md), and a `'scalar'` Subquery operand for the comparison operators (before: `isNull(subquery)` rendered `"[object Object]" IS NULL`, `eq(column, subquery)` bound the Subquery object as a parameter, and `gt(u.posts!.count(), 1)` rendered `"[object Object]" > $1`). |
| 1.0.9 | A projected subquery's outer navigations are joined (before: `missing FROM-clause entry for table "user"`); a subquery in a collection's item renders in parentheses (before: it was bound as a parameter and the item read back the serialized Subquery object); a subquery's navigation path takes its own alias (before: it read the query's join of the same name, silently). |
| 1.0.9 | `exists()` / `notExists()` refuse a query builder or a table with a `TypeError` before anything runs (before: they started that query, then failed with `this.resolved.getFieldRefs is not a function`); `exists(…).as(name)` renders the expression (before: an empty expression). |

## Pitfalls

- **Don't** pass a query builder or a table to `exists()` / `notExists()` (`exists(db.posts.where(…))`): it throws `exists() expects a subquery — db.<table>.where(…).select(…).asSubquery() — or a collection navigation (row.items.where(…)). …`. **Do** pass `u.posts!.where(…)` or `….select(() => ({ one: literal(1) })).asSubquery()`.
- **Don't** pass an `'array'` subquery to `exists()`: it runs, but it is a type error against `src/`. **Do** use the default `'table'` mode.
- **Don't** use `notInSubquery` / `neAllSubquery` over a column that can be NULL: one NULL in the subquery's result drops every row. **Do** use `notExists`.
- **Don't** join the many side of a relation to filter parents: the parent repeats once per match. **Do** filter with `exists` or `inSubquery`; join only for the other side's columns.
- **Don't** fetch keys with `toList()` and send them back with `inArray`: 2 round trips and a statement text per key count. **Do** embed the query with `inSubquery` or `eqAnySubquery`.
- **Don't** let a scalar subquery return several rows: `more than one row returned by a subquery used as an expression`. **Do** aggregate, or `orderBy(…).limit(1)`.
- **Don't** write one scalar subquery per column of the same related row. **Do** read the row once with a collection's `firstOrDefault()`.
- **Don't** compare a collection's `max()` / `min()` / `sum()` in a WHERE (it throws). **Do** compare a scalar subquery of `agg.max(…)`, or use `count()` / `exists()`, which compare directly.
- **Don't** project an object of one column for an entity, grouped or union `'array'` subquery used with `inSubquery`. **Do** project the value (`select(u => u.id)`), or use `eqAnySubquery`.
- **Don't** write `select(g => g.key.userId)` (a bare grouping key) in a grouped subquery: it projects the key ref's internal fields (`"__fieldName"`, `"__dbColumnName"`, `"__tableAlias"`) and `IN` fails with `subquery has too many columns`. **Do** write `select(g => ({ userId: g.key.userId }))` and test it with `eqAnySubquery`.
- **Don't** read an outer navigation inside a grouped subquery: it is not joined (`missing FROM-clause entry`). **Do** correlate on the outer row's own columns.
- **Don't** correlate `db.<table>.where(…).asSubquery()` with a row of the same table (refused). **Do** use `db.<table>.as(alias)` or a collection of a navigation.
- **Don't** `coalesce` an enum-column subquery with a text default (`invalid input value for enum`). **Do** `cast(…, 'text')` first.
- **Don't** pass a bare `Subquery` as an UPDATE SET value: it compiles, but the Subquery object is bound as a parameter (a text column stores its JSON). **Do** write `….asSubquery('scalar').asExpression<T>()`.
- **Don't** pass the join alias through `Subquery.as(alias)`. **Do** pass it as the 4th argument of `innerJoin` / `leftJoin`.
- **Don't** rely on compile errors for subquery modes in an application that uses the npm package (the typings erase them). **Do** follow the mode table above.

## See also

- [Choosing the right query](../choosing-the-right-query.md): start here; every data need mapped to its API, SQL shape and round trips.
- [Aliased subquery scopes](./aliased-scopes.md): same-table correlations, top-1 lookups with joins, probes inside UPDATE, CTE bodies and collection items.
- [CTE guide](./cte-guide.md): a derived set declared once and read in several places; `db.selectFromCte()`; data-modifying CTEs.
- [Querying guide](./querying.md): collections, joins, grouping, the terminal `exists()` / `count()`, `eqAny` / `inArrayOpt` for lists already in JS.
- [Collection strategies](../collection-strategies.md): how `lateral`, `cte` and `temptable` render collections and their aggregates.
- [Set-returning functions](./set-returning-functions.md): `fromSet`, `unnest`, `unnestZip` as subquery sources.
- [SQL expressions](./sql-expressions.md): `agg`, `coalesce`, `cast` and arithmetic helpers to combine with `asExpression()`.
- [Insert, update and delete](./insert-update-guide.md): `'table'` subqueries as [`insertFrom()`](./insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom) sources, subqueries in UPDATE SET and WHERE.
- [Batching and prepared queries](./batching-and-prepared-queries.md): several independent reads in one round trip (`QueryBatch`) when they cannot be one statement.
- [Lateral navigation joins](./lateral-navigation-joins.md): `lateralJoin()` for reference navigations read through LATERAL probes.
- Tests with more cases: `tests/queries/subqueries.test.ts`, `tests/queries/subquery-operands.test.ts`, `tests/queries/scalar-subquery-read-type.test.ts`.
