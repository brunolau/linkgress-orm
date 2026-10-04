# CTEs (WITH queries)

> **For agents:** How do I name a derived row set once with `WITH` and read it — joined, as a FROM root or from subqueries — or run a write and read its rows back, all in one statement?
> **Use this page when:** joining per-key aggregates to entity rows, reading one derived set from several places of a statement, FULL / RIGHT / CROSS joins between derived sets, top N rows per group, candidate-set filters, writing and reading back in one round trip. **Look elsewhere when:** the set is read once in one place → [Subqueries](./subquery-guide.md); a JS list or JS rows as a relation → [Set-returning functions](./set-returning-functions.md); child lists through a navigation → [Collection strategies](../collection-strategies.md)
> **Key APIs:** `DbCteBuilder`, `with()`, `withAggregation()`, `withMutation()`, `db.selectFromCte()`, `<table>.selectFromCte()`, `joinFilter()`, `afterMutation()`, `onTrue()`, `onFalse()` · **Round trips:** 1 per executed statement — declaring a CTE, joining it or reading it from a nested subquery adds none

A CTE is built once with a `DbCteBuilder` and becomes a `DbCte`: a named relation that a statement declares in its
`WITH` clause. A `DbCte` is not executed on its own: it runs inside the statement that declares it — the query that
attaches it with `.with()`, joins it, reads it or is rooted on it.

This page covers the explicit CTE API. For the CTEs and LATERAL joins the ORM emits by itself for collection
navigations, see [Collection strategies](../collection-strategies.md).

## Contents

- [Decide: CTE, subquery, join or collection](#decide-cte-subquery-join-or-collection)
- [Join a per-key aggregate to entity rows: `with()` + `leftJoin()`](#join-a-per-key-aggregate-to-entity-rows-with--leftjoin)
- [Choose the CTE body: any query a statement can run](#choose-the-cte-body-any-query-a-statement-can-run)
- [How a CTE's columns read back](#how-a-ctes-columns-read-back)
- [Read a CTE as the FROM root: `db.selectFromCte()`](#read-a-cte-as-the-from-root-dbselectfromcte)
- [Join derived sets with FULL OUTER, RIGHT or CROSS joins](#join-derived-sets-with-full-outer-right-or-cross-joins)
- [Read one CTE from several subqueries: declare it once](#read-one-cte-from-several-subqueries-declare-it-once)
- [Keep the top N rows per group: rank in a CTE](#keep-the-top-n-rows-per-group-rank-in-a-cte)
- [Drive a query from a candidate set: `joinFilter()` and `materialized: true`](#drive-a-query-from-a-candidate-set-joinfilter-and-materialized-true)
- [Attach child rows as a JSON array per key: `withAggregation()`](#attach-child-rows-as-a-json-array-per-key-withaggregation)
- [Read a CTE from a raw `sql` fragment: `cte.as(alias)`](#read-a-cte-from-a-raw-sql-fragment-cteasalias)
- [Lock the rows a CTE reads: `.forUpdate()` in the body](#lock-the-rows-a-cte-reads-forupdate-in-the-body)
- [Write and read back in one statement: `withMutation()`](#write-and-read-back-in-one-statement-withmutation)
- [Order two writes in one statement: `afterMutation()`](#order-two-writes-in-one-statement-aftermutation)
- [Run CTE statements on a table's own connection: `<table>.selectFromCte()`](#run-cte-statements-on-a-tables-own-connection-tableselectfromcte)
- [Recursive queries: raw SQL](#recursive-queries-raw-sql)
- [Combine CTEs of several builders: `getCtes()`, `clear()`](#combine-ctes-of-several-builders-getctes-clear)
- [Type CTE columns](#type-cte-columns)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Decide: CTE, subquery, join or collection

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Per-key aggregates beside entity rows (totals per user) | a grouped body in `with()`, then `leftJoin(cte, on, select)` | `WITH "s" AS (… GROUP BY …) SELECT … LEFT JOIN "s" ON …` · 1 | a correlated scalar subquery per row over a large table |
| One derived set read in 2+ places of one statement | `.with(cte)` on the executing query + `db.selectFromCte(cte)….asSubquery()` | one `WITH`, every reader reads it by name · 1 | leaving out `.with()`: each reader declares its own copy |
| A derived set read once, in one place | a subquery or a table-subquery join — [Subqueries](./subquery-guide.md) | `(SELECT …)` inline · 1 | a CTE for this alone: PostgreSQL 12+ inlines a CTE read once into the same plan |
| FULL OUTER / RIGHT / CROSS join of derived sets | `db.selectFromCte(a).fullOuterJoin(b, onTrue())` | `FROM "a" FULL OUTER JOIN "b" ON TRUE` · 1 | two queries merged in JS (2 round trips) |
| Top N rows per group | a window value in the body, `db.selectFromCte(cte).where(…)` on it | `row_number() OVER (…)` inside the `WITH`, `WHERE "rank" <= $1` outside · 1 | `where()` on the window value in the query that computes it (refused) |
| Rows whose key is in a large candidate set | `with(…, { materialized: true })` + `joinFilter(cte, on)` | `AS MATERIALIZED (…)` + `INNER JOIN "c" ON …` · 1 | fetching the ids, then querying by them (2 round trips) |
| Child rows as a JSON list per parent, no navigation | `withAggregation(name, query, key, alias)` | `json_agg(json_build_object(…)) … GROUP BY` + `LEFT JOIN` · 1 | one query per parent (N+1) |
| Child rows through a navigation | `u.posts!.select(…).toList()` — [Collection strategies](../collection-strategies.md) | per strategy · 1 with `'lateral'` (default) or `'cte'`; `'temptable'`: 6 statements on `PgClient`, 2 round trips on multi-statement clients | `withAggregation()` |
| Write, then read the written rows | `withMutation(name, q.toStatement(sel))` + `db.selectFromCte(cte)` | `WITH "m" AS (UPDATE … RETURNING …) SELECT … FROM "m"` · 1 | write, then re-read: 2 round trips |
| Close a row and insert its successor | two `withMutation()` legs, `afterMutation()`, a `unionAll()` readback | `WITH "closed" AS (UPDATE …), "opened" AS (INSERT … WHERE ((SELECT count(*) FROM "closed") >= 0) …)` · 1 | a FULL JOIN readback on a null-safe key (0A000) |
| A plain write | `update()`, `insertBulk(…).returning()` — [Insert, update, delete](./insert-update-guide.md) | 1 | a data-modifying CTE |
| A JS list or JS rows as a relation | `unnest()`, `fromRows()` — [Set-returning functions](./set-returning-functions.md) | `unnest(CAST($1 AS type[]))` · 1 | a CTE of literals |
| A recursive walk (`WITH RECURSIVE`) | raw SQL through `` db.query(sql`…`) `` | as written · 1 | looking for a builder method: there is none |

## Join a per-key aggregate to entity rows: `with()` + `leftJoin()`

`builder.with(name, query)` returns `{ cte }`. Join it to an entity query with `leftJoin(cte, on, select)` or
`innerJoin(cte, on, select)`: the entity table stays the FROM root and the CTE's columns are read beside its
columns. This is the right choice for per-key aggregates of many parents: the body runs once, as one GROUP BY
pass, instead of one correlated subquery per parent row.

```ts
import { DbCteBuilder, eq } from 'linkgress-orm';

const builder = new DbCteBuilder();
const stats = builder.with('post_stats', db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(p => ({ userId: p.userId }))
  .select(g => ({ userId: g.key.userId, totalViews: g.sum(p => p.views), postCount: g.count() })));

const rows = await db.users
  .with(stats.cte)
  .leftJoin(
    stats.cte,
    (u, s) => eq(u.id, s.userId),
    (u, s) => ({ username: u.username, totalViews: s.totalViews, postCount: s.postCount }),
  )
  .orderBy(r => r.username)
  .toList();
```

```sql
WITH "post_stats" AS (SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "totalViews", CAST(COUNT(*) AS INTEGER) as "postCount"
  FROM "posts"
  GROUP BY "posts"."user_id")
SELECT "users"."username" as "username", "post_stats"."totalViews" as "totalViews", "post_stats"."postCount" as "postCount"
FROM "users"
LEFT JOIN "post_stats" ON "users"."id" = "post_stats"."userId"
ORDER BY "username" ASC
```

Result: `[{ username: 'alice', totalViews: 250, postCount: 2 }, { username: 'bob', totalViews: 200, postCount: 1 }, { username: 'charlie', totalViews: undefined, postCount: undefined }]`
— a LEFT JOIN miss reads the CTE's columns as `undefined`, not `null` (the keys are present; `JSON.stringify` drops them).

- `.with(cte)` is optional when the query joins the CTE: `db.users.innerJoin(stats.cte, …)` attaches a joined CTE
  to the statement's `WITH` itself, and a CTE attached twice is declared once. The join works straight off the
  table and after a `select()` (`db.users.select(…).innerJoin(cte, …)`).
- The ON callback receives the CTE's columns as column refs; the selector receives them typed as values.
- A `where()` after the join may filter on CTE columns: `.where(r => gt(r.totalViews, 150))` renders
  `WHERE "post_stats"."totalViews" > $1`.
- The terminals `count()`, `exists()`, `min()`, `max()` and `sum()` of such a query declare the `WITH` too:
  `db.users.innerJoin(stats.cte, …).count()` renders
  `WITH "post_stats" AS (…) SELECT COUNT(*) as count FROM "users" INNER JOIN "post_stats" AS "post_stats" ON …`
  and returns `2`; the `leftJoin` form renders `LEFT JOIN` and returns `3`.
- Entity-rooted queries join CTEs with INNER and LEFT joins only. For FULL OUTER, RIGHT or CROSS joins, root the
  query on a CTE: [Join derived sets with FULL OUTER, RIGHT or CROSS joins](#join-derived-sets-with-full-outer-right-or-cross-joins).

> **Pitfall:** a CTE whose key repeats (several rows per `userId`) duplicates the entity rows it joins. Group the
> body by the join key, or filter with `inSubquery()` / `exists()` instead of joining.

## Choose the CTE body: any query a statement can run

`with(name, query)` and `withAggregation(name, query, …)` take every query a statement can run:

| Body | Example |
|---|---|
| entity query (projection, navigations, collection aggregates, its own `.with()`) | `db.users.select(u => ({ userId: u.id, postCount: u.posts!.count() }))` |
| grouped query | `db.posts.select(…).groupBy(p => ({ userId: p.userId })).select(g => ({ … }))` |
| union | `q1.union(q2)`, `q1.unionAll(q2)` |
| CTE-rooted query (since 1.0.29) | `db.selectFromCte(a.cte).where(…).select(…)` |
| set query (since 1.0.29) | `fromSet(unnest(names, 'text'), 'n').select(…)`, `db.selectFromSet(unnestZip({…}))` |
| a locking query | `db.users.where(…).select(…).orderBy(…).forUpdate()` — see [Lock the rows a CTE reads](#lock-the-rows-a-cte-reads-forupdate-in-the-body) |

A CTE-rooted body declares the CTEs it reads inside itself:

```ts
import { DbCteBuilder, gt } from 'linkgress-orm';

const builder = new DbCteBuilder();
const older = builder.with('older_users', db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id, age: u.age })));
const oldest = builder.with('oldest', db.selectFromCte(older.cte).where(r => gt(r.age, 40)).select(r => ({ id: r.id })));

const ids = await db.selectFromCte(oldest.cte).select(r => r.id).toList();   // [3]
```

```sql
WITH "oldest" AS (WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
    FROM "users"
    WHERE "users"."age" > $1)
  SELECT "older_users"."id" as "id"
  FROM "older_users"
  WHERE "older_users"."age" > $2)
SELECT "oldest"."id" as "value"
FROM "oldest"
-- params: [30, 40]
```

> **Efficiency:** a collection aggregate in an entity body (`u.posts!.count()`) renders one correlated subquery
> per row of the body under the default `'lateral'` strategy —
> `(SELECT COALESCE(COUNT(*), 0) FROM "posts" "lateral_0_posts" WHERE "lateral_0_posts"."user_id" = "users"."id")`.
> For many parents, a grouped body over the child table (previous section) aggregates in one pass.

A body that reads a data-modifying CTE reads it by name; every statement that declares the body's CTE declares
the data-modifying one first (since 1.0.29). See [Order two writes in one statement](#order-two-writes-in-one-statement-aftermutation).

## How a CTE's columns read back

A column of a CTE body reads back — through a join, at a CTE root, in a comparison — the way the body's own
projection reads it.

```ts
import { DbCteBuilder, and, eq } from 'linkgress-orm';

const times = new DbCteBuilder().with('post_times', db.posts.select(p => ({
  postId: p.id,
  time: p.publishTime,                       // a column with a custom mapper (HourMinute <-> smallint)
  meta: { title: p.title, views: p.views },  // a nested object
  author: p.user,                            // a navigation row
  kind: 'post',                              // literals
  featured: true,
})));

const rows = await db.posts
  .innerJoin(
    times.cte,
    (p, t) => and(eq(p.id, t.postId), eq(t.time, { hour: 9, minute: 30 }), eq(t.featured, true)),
    (p, t) => ({ title: p.title, time: t.time, meta: t.meta, author: t.author!.username, kind: t.kind }),
  )
  .toList();
// [{ title: 'Alice Post 1', time: { hour: 9, minute: 30 }, meta: { title: 'Alice Post 1', views: 100 }, author: 'alice', kind: 'post' }]
```

```sql
WITH "post_times" AS (SELECT "posts"."id" as "postId", "posts"."publish_time" as "time", "posts"."title" as "__nested__meta__title", "posts"."views" as "__nested__meta__views", "user"."id" as "__nested__author__id", "user"."username" as "__nested__author__username", "user"."email" as "__nested__author__email", "user"."age" as "__nested__author__age", "user"."is_active" as "__nested__author__isActive", "user"."created_at" as "__nested__author__createdAt", "user"."metadata" as "__nested__author__metadata", "user"."last_active_at" as "__nested__author__lastActiveAt", CAST($1 AS text) as "kind", CAST($2 AS boolean) as "featured"
  FROM "posts"
  INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id")
SELECT "posts"."title" as "title", "post_times"."time" as "time", "post_times"."__nested__meta__title" as "__nested__meta__title", "post_times"."__nested__meta__views" as "__nested__meta__views", "post_times"."__nested__author__username" as "author", "post_times"."kind" as "kind"
FROM "posts"
INNER JOIN "post_times" ON ("posts"."id" = "post_times"."postId" AND "post_times"."time" = $3 AND "post_times"."featured" = $4)
-- params: ["post", true, 570, true]
```

- **Mapped columns** read and compare through the body column's own mapper: `t.time` is `{ hour, minute }`, and
  `eq(t.time, { hour: 9, minute: 30 })` binds `570`, as a comparison with `p.publishTime` would.
- **Text** stays text: a `varchar` value `'01234'` reads as `'01234'`, not `1234`. A numeric column or an aggregate
  reads as a number.
- **Literals** render typed in the body, so readers compare and read them as their type: a string as `text`, a
  boolean as `boolean`, an integer as `integer` (`bigint` beyond the int4 range), a fraction as
  `double precision`, a `Date` as `timestamptz`, a JS `bigint` as `bigint` (read back as a `bigint`), a list of
  values as `jsonb`.
- **A nested object or a navigation row** renders as flattened `__nested__<key>__<leaf>` columns and reads back as
  an object; `t.meta.views` and `t.author.username` are columns of their own. At the type level such a value is
  one `FieldRef`, so reach into it in a condition with a cast: `eq((t.meta as any).title, 'x')`.
- A table subquery (`query.asSubquery('table')`, joined with an alias) reads its columns the same way.

One exception: a collection's `min()` / `max()` of a mapped column. Since 1.0.31 the body's own query reads it
through the column's mapper (`{ hour: 9, minute: 30 }`); read back as a column of the CTE, or of a joined table
subquery, it is the stored value:

```ts
import { DbCteBuilder } from 'linkgress-orm';

const firstSlots = new DbCteBuilder().with('first_slots', db.users.select(u => ({
  userId: u.id,
  firstSlot: u.posts!.min(p => p.publishTime),   // at the root of this query: { hour: 9, minute: 30 }
})));

const rows = await db.selectFromCte(firstSlots.cte)
  .select(r => ({ userId: r.userId, firstSlot: r.firstSlot }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, firstSlot: 570 }, { userId: 2, firstSlot: 1125 }, { userId: 3, firstSlot: null }]: the stored minutes
```

```sql
WITH "first_slots" AS (SELECT "users"."id" as "userId", (SELECT COALESCE(MIN("lateral_0_posts"."publish_time"), null)
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id") as "firstSlot"
  FROM "users")
SELECT "first_slots"."userId" as "userId", "first_slots"."firstSlot" as "firstSlot"
FROM "first_slots"
ORDER BY "userId" ASC
```

Map such a column where it is read, or compute it in a grouped body, whose `g.min()` / `g.max()` keep their mapper
through the CTE: with
`db.posts.select(p => ({ userId: p.userId, t: p.publishTime })).groupBy(r => ({ userId: r.userId })).select(g => ({ userId: g.key.userId, first: g.min(r => r.t) }))`
as the body, `first` read back as `{ hour: 9, minute: 30 }` (see [Querying](./querying.md#aggregates-per-group)).

> **Efficiency:** a navigation row projected whole (`author: p.user`) renders every column of the target table
> into the body. Project the columns you read (`authorName: p.user!.username`).

## Read a CTE as the FROM root: `db.selectFromCte()`

`db.selectFromCte(cte, alias?)` starts a query whose FROM root is the CTE. Use it to read a CTE's rows — the
RETURNING rows of a data-modifying CTE, rank-filtered window results — or, nested with `.asSubquery()`, to read a
statement's CTE from a subquery. Methods: `where()`, `select()`, `orderBy()`, `limit()`, `offset()`,
`forUpdate()` (it locks no rows here, see [Lock the rows a CTE reads](#lock-the-rows-a-cte-reads-forupdate-in-the-body)),
`withTimeout(ms)`, `expectedExecutionTime(ms)`, the joins of the next section, `union()` / `unionAll()`,
`asSubquery()`; terminals `toList()`, `first()`, `toSql()`, `buildQuery()`.

```ts
import { DbCteBuilder, gt, lt } from 'linkgress-orm';

const older = new DbCteBuilder().with('older_users', db.users
  .where(u => gt(u.age, 20))
  .select(u => ({ id: u.id, username: u.username, age: u.age })));

const page = await db.selectFromCte(older.cte)
  .where(r => gt(r.age, 30))
  .where(r => lt(r.age, 100))
  .select(r => ({ id: r.id, name: r.username }))
  .orderBy(r => [[r.id, 'DESC']])
  .limit(10)
  .offset(0)
  .toList();
// [{ id: 3, name: 'charlie' }, { id: 2, name: 'bob' }]
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."username" as "username", "users"."age" as "age"
  FROM "users"
  WHERE "users"."age" > $1)
SELECT "older_users"."id" as "id", "older_users"."username" as "name"
FROM "older_users"
WHERE ("older_users"."age" > $2 AND "older_users"."age" < $3)
ORDER BY "id" DESC
LIMIT 10
OFFSET 0
-- params: [20, 30, 100]
```

- `select()` is required before a terminal. A selector returning one value reads as a list of values:
  `select(r => r.id).orderBy(id => id).toList()` returns `[1, 2, 3]` and renders `SELECT "older_users"."id" as "value" … ORDER BY "value" ASC`.
- `where()` calls combine with AND. Parameters are numbered CTE bodies first, then ON predicates, then the WHERE.
  `where()` and `select()` can be called in either order: the predicate reads the root CTE's row (after a join,
  every joined CTE's row too), whatever the projection holds.
- `orderBy()` names output aliases (`ORDER BY "id" DESC`); `limit()` / `offset()` are inlined integers.
- `first()` returns the first row or `null` and renders `LIMIT 1`.
- There is no `count()`: `db.selectFromCte(older.cte).where(r => gt(r.age, 30)).select(() => agg.count()).first()`
  renders `SELECT count(*) as "value" FROM "older_users" WHERE "older_users"."age" > $2 LIMIT 1` and returns `2`.
- `toSql()` / `buildQuery()` (`{ sql, params }`) build the statement without a round trip.
- A NULL column reads as `null` here; an entity projection reads it as `undefined`.
- The projection takes what an entity `select()` takes: a string literal is a value (`$1 as "kind"`), a nested
  object is flattened and rebuilt (`` { time: t.time, loud: sql`upper(${t.title})` } ``), a scalar subquery renders in
  place (`comments: db.postComments.where(c => eq(c.postId, t.postId)).select(() => agg.count()).asSubquery('scalar')`
  renders `(SELECT count(*) FROM "post_comments" WHERE "post_comments"."post_id" = "post_times"."postId") as "comments"`).
  Nested as a subquery (`asSubquery()`), the projection's literals render typed for the enclosing query
  (`CAST($2 AS text) as "kind"`).
  An array of columns is refused: `selectFromCte().select(): "pair" is an array of columns or expressions, which has no single SQL value to select — …`.

> **Pitfall:** a CTE-rooted builder is mutable. `where()`, `orderBy()`, `limit()`, `offset()`, `forUpdate()`,
> `withTimeout()` and `expectedExecutionTime()` change the builder and return it, and `first()` leaves `LIMIT 1`
> on it: `const q = db.selectFromCte(c).select(…); await q.first(); await q.toList()` returns one row. Build a new
> query for each use. (`select()` returns a new builder; set queries are immutable.)

## Join derived sets with FULL OUTER, RIGHT or CROSS joins

A CTE-rooted query joins further CTEs with every SQL join flavour. Use it when either side may be empty and both
must survive, or when two independently computed sets are combined.

| Method | SQL |
|---|---|
| `.innerJoin(cte, condition)` | `INNER JOIN "cte" ON …` |
| `.leftJoin(cte, condition)` | `LEFT JOIN "cte" ON …` |
| `.rightJoin(cte, condition)` | `RIGHT JOIN "cte" ON …` |
| `.fullOuterJoin(cte, condition)` | `FULL OUTER JOIN "cte" ON …` |
| `.crossJoin(cte)` | `CROSS JOIN "cte"` |

`condition` is a `Condition` value, not a callback: `onTrue()` (`ON TRUE`), `onFalse()` (`ON FALSE`, since 1.0.29),
or a comparison of column refs made with `cte.as()`. PostgreSQL requires an `ON` clause on a `FULL OUTER JOIN` (a bare
one is a syntax error): `onTrue()` is its cross-product form, which keeps every row of both sides. After a join,
`select((root, joined) => …)` and `where((root, joined) => …)` receive one row per source in FROM order.

Buyer spend beside the current tier — one row whatever side is empty:

```ts
import { DbCteBuilder, and, eq, onTrue } from 'linkgress-orm';

const userId = 1;
const builder = new DbCteBuilder();
const spend = builder.with('spend', db.orders
  .where(o => and(eq(o.userId, userId), eq(o.status, 'completed')))
  .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
  .groupBy(o => ({ status: o.status }))
  .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) })));
const tier = builder.with('current_tier', db.users
  .where(u => and(eq(u.id, userId), eq(u.isActive, true)))
  .select(u => ({ currentTierId: u.id }))
  .limit(1));

const rows = await db.selectFromCte(spend.cte)
  .fullOuterJoin(tier.cte, onTrue())
  .select((s, t) => ({ status: s.status, totalPrice: s.totalPrice, currentTierId: t.currentTierId }))
  .toList();
// userId 1: [{ status: 'completed', totalPrice: 99.99, currentTierId: 1 }]
// userId 2 (no completed order): [{ status: null, totalPrice: null, currentTierId: 2 }]
// userId 3 (no completed order, inactive): []   — both sides empty
```

```sql
WITH "spend" AS (SELECT "orders"."status" as "status", CAST(SUM("orders"."total_amount") AS DOUBLE PRECISION) as "totalPrice"
  FROM "orders"
  WHERE ("orders"."user_id" = $1 AND "orders"."status" = $2)
  GROUP BY "orders"."status"), "current_tier" AS (SELECT "users"."id" as "currentTierId"
  FROM "users"
  WHERE ("users"."id" = $3 AND "users"."is_active" = $4)
  LIMIT 1)
SELECT "spend"."status" as "status", "spend"."totalPrice" as "totalPrice", "current_tier"."currentTierId" as "currentTierId"
FROM "spend"
FULL OUTER JOIN "current_tier" ON TRUE
-- params: [1, "completed", 1, true]
```

`rightJoin(tier.cte, onTrue())` renders `RIGHT JOIN "current_tier" ON TRUE`, `crossJoin(tier.cte)` renders
`CROSS JOIN "current_tier"`, and `fullOuterJoin(tier.cte, onFalse())` renders `FULL OUTER JOIN "current_tier" ON FALSE`:
every row of both sides, paired with none (two relations side by side).

A column-to-column ON condition uses refs from `cte.as()` (they render `"<cte>"."<column>"`):

```ts
import { DbCteBuilder, eq, gt } from 'linkgress-orm';

const builder = new DbCteBuilder();
const authors = builder.with('authors', db.users.select(u => ({ id: u.id, name: u.username })));
const popular = builder.with('popular_posts', db.posts.where(p => gt(p.views, 120)).select(p => ({ authorId: p.userId, title: p.title })));
const a = authors.cte.as();
const p = popular.cte.as();

const rows = await db.selectFromCte(authors.cte)
  .fullOuterJoin(popular.cte, eq(a.id, p.authorId))
  .select((au, po) => ({ name: au.name, title: po.title }))
  .toList();
// [{ name: 'alice', title: 'Alice Post 2' }, { name: 'bob', title: 'Bob Post' }, { name: 'charlie', title: null }]
```

```sql
WITH "authors" AS (SELECT "users"."id" as "id", "users"."username" as "name"
  FROM "users"), "popular_posts" AS (SELECT "posts"."user_id" as "authorId", "posts"."title" as "title"
  FROM "posts"
  WHERE "posts"."views" > $1)
SELECT "authors"."name" as "name", "popular_posts"."title" as "title"
FROM "authors"
FULL OUTER JOIN "popular_posts" ON "authors"."id" = "popular_posts"."authorId"
-- params: [120]
```

- PostgreSQL plans a FULL JOIN only on merge- or hash-joinable conditions: an equality between the two sides
  (other conditions may stand beside it) or constants. An inequality, `IS NOT DISTINCT FROM`, an OR or a condition
  on one side alone fails with 0A000 "FULL JOIN is only supported with merge-joinable or hash-joinable join
  conditions" — on PostgreSQL and in the in-memory database.
- Joined CTEs render under their own names. Joining the root CTE to itself declares it twice and fails with 42712
  "WITH query name "older_users" specified more than once", also when the root has an alias. Use a second CTE, or a
  correlated `selectFromCte(cte, alias)` subquery (next section).
- The selector of the first join is fully typed `(root, right)`; with 3 or more sources the extra rows arrive as
  loosely typed rest arguments.

## Read one CTE from several subqueries: declare it once

Attach the CTE to the executing query with `.with(cte)`: the statement declares it once and every nested read —
WHERE subqueries, projected subqueries, ORDER BY expressions, collections, union legs, subqueries of subqueries —
reads it by name, with its parameters bound once.

```ts
import { DbCteBuilder, eq, gt, inSubquery } from 'linkgress-orm';

const older = new DbCteBuilder().with('older_users', db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, age: u.age })));

const rows = await db.users
  .with(older.cte)
  .where(u => inSubquery(u.id, db.selectFromCte(older.cte).select(r => r.id).asSubquery('array')))
  .select(u => ({
    name: u.username,
    olderAge: db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar'),
  }))
  .toList();
// [{ name: 'bob', olderAge: 35 }, { name: 'charlie', olderAge: 45 }]
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
  FROM "users"
  WHERE "users"."age" > $1)
SELECT "users"."username" as "name", (SELECT "older_users"."age" as "value"
  FROM "older_users"
  WHERE "older_users"."id" = "users"."id") as "olderAge"
FROM "users"
WHERE "users"."id" IN (SELECT "older_users"."id" as "value"
  FROM "older_users")
-- params: [30]
```

Without `.with(older.cte)` the same query runs, but each subquery declares its own copy and binds its own
parameters:

```sql
SELECT "users"."username" as "name", (WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
  FROM "users"
  WHERE "users"."age" > $1)
  SELECT "older_users"."age" as "value"
  FROM "older_users"
  WHERE "older_users"."id" = "users"."id") as "olderAge"
FROM "users"
WHERE "users"."id" IN (WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
  FROM "users"
  WHERE "users"."age" > $2)
  SELECT "older_users"."id" as "value"
  FROM "older_users")
-- params: [30, 30]
```

> **Efficiency:** declared once and read in two places, the CTE is computed once (PostgreSQL inlines only a CTE
> referenced once); undeclared, every reader carries its own copy, written, bound and computed separately. Measured
> in changelog v0.4.61 on one production workload (a visibility gate read by two union legs, 60k junction rows):
> the gate duplicated per leg took 9.97 ms and 3,720 shared buffers, one `MATERIALIZED` CTE read by both legs
> 4.43 ms and 2,074. A data-modifying CTE is never copied: reading one that the executing query does not declare is
> refused.

- A query that joins a CTE and reads it from a subquery declares it once too.
- A nested `selectFromCte()` that reads an outer navigation joins it in the enclosing query:
  `db.posts.with(older.cte).select(p => ({ authorOlderAge: db.selectFromCte(older.cte).where(r => eq(r.id, p.user!.id)).select(r => r.age).asSubquery('scalar') }))`
  renders `WHERE "older_users"."id" = "user"."id"` inside the subquery and `INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"` outside.
  The rows of a CTE-rooted query carry its identity: an entity query nested in its `where()` reads them as
  correlations, also when the CTE is named like one of that query's navigations.
- The statement's CTEs are matched by content, not by name. A nested query that attaches a different CTE under a
  declared name is refused: `The CTE "older_users" a nested query attaches is not the CTE "older_users" its
  statement declares …`. The same definition built twice — by a factory called for the statement and again for a
  nested query, also from builders at other parameter offsets — is one CTE when its body (numbered from `$1`), its
  `MATERIALIZED` flag and its parameters by value are equal (a `Date` by its time, a `Buffer` or typed array by its
  bytes, an array element by element, a JSON document by its JSON text; any other object only as the same
  instance). The same rule decides whether two union legs attach one CTE. A data-modifying CTE is the same only as
  the same `DbCte` instance.
- A subquery that attaches a CTE the statement does not declare declares it inside itself,
  `(WITH "cte" AS (…) SELECT …)`; a subquery whose CTEs are partly declared reads those by name and declares the
  rest.

A CTE-rooted subquery correlated to an enclosing query over the same CTE — another `selectFromCte(cte)`, or an
entity query that joined the CTE — needs an alias on one side; `selectFromCte(cte, alias)` renders
`FROM "<cte>" AS "<alias>"`:

```ts
import { DbCteBuilder, agg, gt } from 'linkgress-orm';

const older = new DbCteBuilder().with('older_users', db.users
  .where(u => gt(u.age, 30))
  .select(u => ({ id: u.id, age: u.age })));

const ranked = await db.selectFromCte(older.cte).select(o => ({
  id: o.id,
  olderCount: db.selectFromCte(older.cte, 'other')
    .where(r => gt(r.age, o.age))
    .select(() => agg.count())
    .asSubquery('scalar'),
})).toList();
// [{ id: 2, olderCount: 1 }, { id: 3, olderCount: 0 }]
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"
  FROM "users"
  WHERE "users"."age" > $1)
SELECT "older_users"."id" as "id", (SELECT count(*) as "value"
  FROM "older_users" AS "other"
  WHERE "other"."age" > "older_users"."age") as "olderCount"
FROM "older_users"
-- params: [30]
```

Without the alias both rows would be named `"older_users"` and the comparison would hold for every row; the
build refuses it: `selectFromCte(): the query correlates to the enclosing row "older_users"."age" under the alias
"older_users", which names its own CTE row too … Give one of them a distinct alias: selectFromCte(cte, '<alias>').`

## Keep the top N rows per group: rank in a CTE

PostgreSQL computes window functions after WHERE, so a rank cannot be filtered in the query that computes it.
Compute it in the CTE body with `win.rowNumber()`, `win.rank()` or `win.denseRank()` (since 1.0.21) and filter
where the CTE is read.

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
-- params: [1]
```

To keep entity rows instead, filter them by the ranked ids:
`db.posts.with(ranked.cte).where(p => inSubquery(p.id, db.selectFromCte(ranked.cte).where(r => eq(r.rank, 1)).select(r => r.id).asSubquery('array')))`
renders `WHERE "posts"."id" IN (SELECT "ranked_posts"."id" as "value" FROM "ranked_posts" WHERE "ranked_posts"."rank" = $1)`.

> **Pitfall:** `db.posts.select(p => ({ rank: win.rowNumber().over(…) })).where(r => eq(r.rank, 1))` throws a
> `TypeError` before running: "`rank` is a window function value: PostgreSQL computes window functions after WHERE
> and the joins, so it cannot be filtered in the query that computes it — compute it in a CTE …".

## Drive a query from a candidate set: `joinFilter()` and `materialized: true`

`joinFilter(cte, on, filter?)` is an INNER JOIN used only as a row filter: the query's projection stays as it is and
the CTE is attached to the `WITH` by itself. `with(name, query, { materialized: true })` emits
`AS MATERIALIZED`: PostgreSQL computes the CTE once as a separate relation instead of inlining it into the outer
plan. Together they keep a candidate set the driving side of the plan.

```ts
import { DbCteBuilder, eq, gt } from 'linkgress-orm';

const builder = new DbCteBuilder();
const candidates = builder.with(
  'candidates',
  db.posts.where(p => gt(p.views, 120)).select(p => ({ id: p.userId }))
    .union(db.orders.where(o => eq(o.status, 'pending')).select(o => ({ id: o.userId }))),
  { materialized: true },
);

const rows = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({ id: u.id, username: u.username }))
  .joinFilter(candidates.cte, (u, c) => eq(u.id, c.id))
  .orderBy(u => u.id)
  .toList();
// [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }]
```

```sql
WITH "candidates" AS MATERIALIZED ((SELECT "posts"."user_id" as "id"
    FROM "posts"
    WHERE "posts"."views" > $1)
  UNION
  (SELECT "orders"."user_id" as "id"
    FROM "orders"
    WHERE "orders"."status" = $2))
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
INNER JOIN "candidates" ON "users"."id" = "candidates"."id"
WHERE "users"."is_active" = $3
ORDER BY "id" ASC
-- params: [120, "pending", true]
```

> **Efficiency:** measured on a production-sized dataset (changelog v0.4.53: a 122M-row table, the worst-case
> candidate set): the same CTE inlined 6,400 ms, `MATERIALIZED` 161 ms; the semi-join spelling
> `WHERE id IN (SELECT id FROM candidates)` 3,339 ms against the join's 161 ms. Without the fence, PostgreSQL 12+
> inlines a CTE read once.

> **Pitfall:** the fence also blocks predicate pushdown into the body: a reader's filter on the CTE's columns no
> longer reaches the body's scan (no index on it can serve that filter). Use `materialized: true` where the candidate
> set must drive the join order, not on every CTE.

- `leftJoinFilter(cte, on, filter)` is the LEFT JOIN form; with an IS NULL filter it is an anti-join (rows without
  a candidate). Its callbacks receive the CTE's columns typed as values, so build the IS NULL ref with `cte.as()`:

  ```ts
  // fragment: continues the example above (candidates); isNull is imported from 'linkgress-orm'
  const c = candidates.cte.as();
  const none = await db.users
    .leftJoinFilter(candidates.cte, (u, cand) => eq(u.id, cand.id), () => isNull(c.id))
    .select(u => ({ username: u.username }))
    .toList();
  // [{ username: 'charlie' }]
  ```

  ```sql
  WITH "candidates" AS MATERIALIZED ((SELECT "posts"."user_id" as "id"
      FROM "posts"
      WHERE "posts"."views" > $1)
    UNION
    (SELECT "orders"."user_id" as "id"
      FROM "orders"
      WHERE "orders"."status" = $2))
  SELECT "users"."username" as "username"
  FROM "users"
  LEFT JOIN "candidates" ON "users"."id" = "candidates"."id"
  WHERE "candidates"."id" IS NULL
  -- params: [120, "pending"]
  ```

- The right side of `on` / `filter` is the CTE's row. The left side is the entity row when `joinFilter()` is called
  on the table, and the projection's row after a `select()` (typed so): compare only columns the projection holds
  (`u.id` above). In untyped code a column outside the projection renders unqualified — `ON "id" = "ids"."id"` —
  and the statement fails with `column reference "id" is ambiguous`.
- `materialized` is an option of `with()` only (not of `withAggregation()` or `withMutation()`), and part of the
  CTE's identity: the same body with another flag is a different CTE.

> **Pitfall:** `joinFilter()` against a CTE that holds several rows per key returns each entity row once per match
> (`alice` twice for a CTE of `posts.user_id`). Use `inSubquery()` or `exists()` for a semi-join there.

## Attach child rows as a JSON array per key: `withAggregation()`

`withAggregation(name, query, keySelector, alias = 'items')` groups the query's rows by the key columns and folds
the other columns into one JSON array per key. It returns the `DbCte` itself (not `{ cte }`). Use it to attach
child lists to parents that have no navigation for them; through a navigation, use a collection
(`u.posts!.select(…).toList()`), which lets you choose the strategy.

```ts
import { DbCteBuilder, eq } from 'linkgress-orm';

const postsByUser = new DbCteBuilder().withAggregation(
  'posts_by_user',
  db.posts.select(p => ({ id: p.id, title: p.title, views: p.views, userId: p.userId })),
  p => ({ userId: p.userId }),
  'posts',
);

const rows = await db.users
  .leftJoin(postsByUser, (u, a) => eq(u.id, a.userId), (u, a) => ({ username: u.username, posts: a.posts }))
  .orderBy(r => r.username)
  .toList();
// [{ username: 'alice', posts: [{ id: 1, title: 'Alice Post 1', views: 100 }, { id: 2, title: 'Alice Post 2', views: 150 }] },
//  { username: 'bob', posts: [{ id: 3, title: 'Bob Post', views: 200 }] },
//  { username: 'charlie', posts: [] }]
```

```sql
WITH "posts_by_user" AS (SELECT "userId",
    json_agg(json_build_object('id', "id", 'title', "title", 'views', "views")) as "posts"
  FROM (SELECT "posts"."id" as "id", "posts"."title" as "title", "posts"."views" as "views", "posts"."user_id" as "userId"
    FROM "posts") t
  GROUP BY "userId")
SELECT "users"."username" as "username", COALESCE("posts_by_user"."posts", '[]'::json) as "posts"
FROM "users"
LEFT JOIN "posts_by_user" ON "users"."id" = "posts_by_user"."userId"
ORDER BY "username" ASC
```

- The items hold the query's columns minus the grouping keys: `{ id, title, views }`, no `userId`.
- It aggregates with `json_agg` (JSON, not JSONB); a joined parent without rows reads `[]` (`COALESCE(…, '[]'::json)`).
- Items read through the aggregated query's own mappers (a `publishTime` item reads `{ hour, minute }`), nested
  objects and navigation rows key by key, literals as themselves; a grouping key reads through its column's mapper.
- `keySelector` maps output names to inner columns. Several keys group by all of them:
  `o => ({ userId: o.userId, status: o.status })` renders `GROUP BY "userId", "status"`. A renamed key
  (`p => ({ authorId: p.userId })`) renders `SELECT "userId" AS "authorId", …`.
- It aggregates the whole inner query: filter inside it (`db.orders.where(…).select(…)`), not on the join.

> **Pitfall:** with a renamed key, the item type still lists the inner column (`posts[0].userId` type-checks), but
> the items do not hold it at runtime (`undefined`). Keep the key's output name equal to the inner column name, or
> do not read it from the items.

## Read a CTE from a raw `sql` fragment: `cte.as(alias)`

`cte.as(alias?)` returns a typed reference for `sql` templates: the reference renders `"<cte>" AS "<alias>"`, each of
its columns `"<alias>"."<column>"`. Use it when a hand-written fragment must read a CTE the statement declares.

```ts
import { DbCteBuilder, sql } from 'linkgress-orm';

const stats = new DbCteBuilder().with('post_stats', db.posts.select(p => ({ postId: p.id, views: p.views, authorId: p.userId })));
const ps = stats.cte.as('ps');

const rows = await db.users
  .with(stats.cte)
  .select(u => ({
    username: u.username,
    totalViews: sql<number>`(SELECT COALESCE(SUM(${ps.views}), 0) FROM ${ps} WHERE ${ps.authorId} = ${u.id})`,
  }))
  .toList();
// [{ username: 'alice', totalViews: 250 }, { username: 'bob', totalViews: 200 }, { username: 'charlie', totalViews: 0 }]
```

```sql
WITH "post_stats" AS (SELECT "posts"."id" as "postId", "posts"."views" as "views", "posts"."user_id" as "authorId"
  FROM "posts")
SELECT "users"."username" as "username", (SELECT COALESCE(SUM("ps"."views"), 0) FROM "post_stats" AS "ps" WHERE "ps"."authorId" = "users"."id") as "totalViews"
FROM "users"
```

- The executing query must declare the CTE with `.with(cte)`: a raw fragment is not recognised as a CTE read.
- Without an alias the reference renders the CTE's own name.
- The fluent forms (`db.selectFromCte(cte)….asSubquery()`, joins, `joinFilter()`) are typed; prefer them where they fit.

## Lock the rows a CTE reads: `.forUpdate()` in the body

Put `.forUpdate()` (options `{ skipLocked: true }` or `{ noWait: true }`, mutually exclusive) on the query that is the
CTE's body: the body locks the rows it reads when the statement evaluates it. This is the lock leg of a fused
check-and-write statement — the check and the write in one round trip, without an application lock.

```ts
import { DbCteBuilder, eqAny } from 'linkgress-orm';

const locked = new DbCteBuilder().with('locked', db.users
  .where(u => eqAny(u.id, [1, 2]))
  .select(u => ({ id: u.id, age: u.age }))
  .orderBy(u => u.id)
  .forUpdate());

const rows = await db.selectFromCte(locked.cte).select(l => ({ id: l.id, age: l.age })).toList();
// [{ id: 1, age: 25 }, { id: 2, age: 35 }]
```

```sql
WITH "locked" AS (SELECT "users"."id" as "id", "users"."age" as "age"
  FROM "users"
  WHERE ("users"."id" = ANY($1::integer[]))
  ORDER BY "id" ASC
  FOR UPDATE)
SELECT "locked"."id" as "id", "locked"."age" as "age"
FROM "locked"
-- params: ["{1,2}"]
```

> **Pitfall:** `db.selectFromCte(cte).select(…).forUpdate()` appends `FOR UPDATE` to the outer SELECT, whose FROM
> holds only CTEs. PostgreSQL's locking clause does not apply to the `WITH` queries the primary query references
> (PostgreSQL manual, SELECT, "The Locking Clause"), so it locks no rows: while its transaction is open, another
> session's `FOR UPDATE NOWAIT` of the same row succeeds; with `.forUpdate()` in the body that statement fails with
> 55P03.
> Lock in the body. (The method's own JSDoc says it locks the root CTE's rows; it does not.)

> **Pitfall:** order the locked rows by a stable key (`orderBy(u => u.id)`) when a statement locks several rows:
> two statements locking the same rows in different orders can deadlock.

## Write and read back in one statement: `withMutation()`

`builder.withMutation(name, statement)` attaches a compiled `UPDATE`, `DELETE` or `INSERT` as a data-modifying CTE.
Compile the statement with `.toStatement(selector)`; the selector is its RETURNING list and types the CTE's
columns. Sources of a compiled statement: `where(…).update(…)`, `where(…).delete()`, and (since 1.0.22)
`insert(…)`, `insertBulk(…)`, `insertFrom(…)`. Use it to write and read the written rows in one round trip.

A compare-and-set gate: the UPDATE matches 0 or 1 row, and the load returns rows only when it matched.

```ts
import { DbCteBuilder, add, and, eq, inSubquery, lt } from 'linkgress-orm';

const userId = 1;
const gate = new DbCteBuilder().withMutation('gate', db.users
  .where(u => and(eq(u.id, userId), lt(u.age, 30)))
  .update(u => ({ age: add(u.age, 1) }))
  .toStatement(u => ({ id: u.id, age: u.age })));   // CompiledStatement<{ id: number; age: number }>

const rows = await db.users
  .with(gate.cte)
  .where(u => inSubquery(u.id, db.selectFromCte(gate.cte).select(g => g.id).asSubquery('array')))
  .select(u => ({
    id: u.id,
    loadedAge: u.age,                                                       // the statement's snapshot
    newAge: db.selectFromCte(gate.cte).select(g => g.age).asSubquery('scalar'),  // RETURNING
  }))
  .toList();
// [{ id: 1, loadedAge: 25, newAge: 26 }]
```

```sql
WITH "gate" AS (UPDATE "users" SET "age" = ("users"."age" + $1) WHERE ("users"."id" = $2 AND "users"."age" < $3) RETURNING "id" AS "id", "age" AS "age")
SELECT "users"."id" as "id", "users"."age" as "loadedAge", (SELECT "gate"."age" as "value"
  FROM "gate") as "newAge"
FROM "users"
WHERE "users"."id" IN (SELECT "gate"."id" as "value"
  FROM "gate")
-- params: [1, 1, 30]
```

A DELETE read back from its RETURNING rows:

```ts
import { DbCteBuilder, eq } from 'linkgress-orm';

const removed = new DbCteBuilder().withMutation('removed', db.postComments
  .where(c => eq(c.postId, 3))
  .delete()
  .toStatement(c => ({ id: c.id, comment: c.comment })));

const deleted = await db.selectFromCte(removed.cte).select(r => ({ id: r.id, comment: r.comment })).toList();
// [{ id: 3, comment: 'My order update' }]
```

```sql
WITH "removed" AS (DELETE FROM "post_comments" WHERE "post_comments"."post_id" = $1 RETURNING "id" AS "id", "comment" AS "comment")
SELECT "removed"."id" as "id", "removed"."comment" as "comment"
FROM "removed"
-- params: [3]
```

An insert feeding another insert (since 1.0.22): `insertFrom()` declares the CTE through its `with` option, since
PostgreSQL allows a data-modifying CTE only at the top level.

```ts
import { DbCteBuilder } from 'linkgress-orm';

const newTags = new DbCteBuilder().withMutation('new_tags', db.tags
  .insertBulk([{ name: 'Spring' }, { name: 'Autumn' }])
  .toStatement(t => ({ id: t.id, name: t.name })));

await db.productTags.insertFrom(
  db.selectFromCte(newTags.cte).select(r => ({ tagId: r.id })).asSubquery('table'),
  src => ({ productId: 1, tagId: src.tagId, sortOrder: 9 }),
  { with: [newTags.cte] },
);
```

```sql
WITH "new_tags" AS (INSERT INTO "tags" ("name") VALUES ($1), ($2) RETURNING "id" AS "id", "name" AS "name")
INSERT INTO "product_tags" ("product_id", "tag_id", "sort_order") SELECT CAST($3 AS integer), "src"."tagId", CAST($4 AS integer) FROM (SELECT "new_tags"."id" as "tagId"
  FROM "new_tags") AS "src"
-- params: ["Spring", "Autumn", 1, 9]
```

Rules PostgreSQL and the builder enforce:

- **One snapshot.** Every sub-statement and the main query read the snapshot the statement started with: the main
  query does not see the CTE's writes (`loadedAge: 25` above). Read the changed rows from RETURNING.
- **Exactly once.** A data-modifying CTE runs once per statement however often it is read — also when it is never
  read. With `touch = builder.withMutation('touch', db.users.where(u => eq(u.id, 3)).update({ age: 46 }).toStatement(u => ({ id: u.id })))`,
  `db.users.with(touch.cte).where(u => eq(u.id, 3)).select(u => ({ age: u.age }))` renders
  `WITH "touch" AS (UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2 RETURNING "id" AS "id") SELECT "users"."age" as "age" FROM "users" WHERE "users"."id" = $3`,
  returns the old age `45`, and the row holds `46` afterwards.
- **Statement level only.** Declare it on the executing query (`.with(cte)`, `insertFrom`'s `with`, or the root of
  `db.selectFromCte(cte)`). Read from a subquery of a query that does not declare it, the build refuses it:
  `CTE "g3" is data-modifying: a data-modifying CTE must be declared at statement level — attach it with .with() on the executing query`.
- **Typed RETURNING.** `toStatement(selector)` returns `CompiledStatement<TRow>` (`{ sql, params }`); each CTE column
  reads the way its RETURNING value does (a text column stays text, a mapped column goes through its mapper). A
  navigation or a collection in the selector is refused: `toStatement(): navigation RETURNING is not supported in compiled UPDATE statements — select plain or fragment columns only.`
  (`DELETE` and `INSERT` likewise). A hand-written `{ sql, params }` carries no RETURNING
  selection, and the older `withMutation(name, { sql, params }, columns)` overload types every column by name: their
  columns read like expressions.
- **No `'temptable'` reads.** The `'temptable'` collection strategy runs collections as statements of their own,
  after the one that executes the mutation. A query whose collection reads the CTE is refused before anything
  runs: `… the temptable collection strategy runs the collections as statements of their own, after the one that executes it — run this query with the 'cte' or 'lateral' collection strategy`.
  Temp-table collections that do not read the CTE run as usual (the mutation runs once, in the base statement). A
  raw `sql` fragment naming the CTE inside such a collection is not recognised as a read: that collection statement
  fails with 42P01 `relation "<cte>" does not exist`, after the base statement — and its write — has run.
- `insertFrom(…, { onConflictDoNothing: true })` (since 1.0.29) compiles into `toStatement()` too: a data-modifying
  CTE can insert-or-skip. See [Insert, update, delete](./insert-update-guide.md).

## Order two writes in one statement: `afterMutation()`

A statement compiled with `toStatement()` may read data-modifying CTEs created before it — in its source, its WHERE,
a subquery of its values. It reads them by name, its own CTE records them (`DbCte.dependencies`), and every
statement that declares it declares them first. PostgreSQL runs the sub-statements of a `WITH` in no promised
order: a data-modifying CTE runs when the main query first reads it. `afterMutation(cte)` (since 1.0.29) renders
`((SELECT count(*) FROM "<cte>") >= 0)`, a condition that holds only once `cte` has run to completion, so the
statement it guards yields no row before.

Close the current pending order of a user and insert its successor, both legs read back, tagged, in ONE statement:

```ts
import { DbCteBuilder, afterMutation, and, eq, fromRows } from 'linkgress-orm';

const userId = 2;
const builder = new DbCteBuilder();
const closed = builder.withMutation('closed', db.orders
  .where(o => and(eq(o.userId, userId), eq(o.status, 'pending')))
  .update({ status: 'cancelled' })
  .toStatement(o => ({ id: o.id, userId: o.userId })));
const opened = builder.withMutation('opened', db.orders.insertFrom(
  fromRows(db.orders, [{ userId, status: 'pending', totalAmount: 10.5 }], { columns: ['userId', 'status', 'totalAmount'], alias: 'd' })
    .asSubquery('table'),
  src => ({ userId: src.userId, status: src.status, totalAmount: src.totalAmount }),
  { where: () => afterMutation(closed.cte) },
).toStatement(o => ({ id: o.id, userId: o.userId })));

const legs = await db.selectFromCte(opened.cte).select(r => ({ leg: 'opened', id: r.id, userId: r.userId }))
  .unionAll(db.selectFromCte(closed.cte).select(r => ({ leg: 'closed', id: r.id, userId: r.userId })))
  .toList();
// [{ leg: 'opened', id: 3, userId: 2 }, { leg: 'closed', id: 2, userId: 2 }]
```

```sql
WITH "closed" AS (UPDATE "orders" SET "status" = $1 WHERE ("orders"."user_id" = $2 AND "orders"."status" = $3) RETURNING "id" AS "id", "user_id" AS "userId"), "opened" AS (INSERT INTO "orders" ("user_id", "status", "total_amount") SELECT "src"."userId", "src"."status", "src"."totalAmount" FROM (SELECT "d"."userId" as "userId", "d"."status" as "status", "d"."totalAmount" as "totalAmount"
  FROM unnest(CAST($4 AS integer[]), CAST($5 AS order_status[]), CAST($6 AS decimal(10, 2)[])) AS "d"("userId", "status", "totalAmount")) AS "src" WHERE ((SELECT count(*) FROM "closed") >= 0) RETURNING "id" AS "id", "user_id" AS "userId")
(SELECT CAST($7 AS text) as "leg", "opened"."id" as "id", "opened"."userId" as "userId"
  FROM "opened")
UNION ALL
(SELECT CAST($8 AS text) as "leg", "closed"."id" as "id", "closed"."userId" as "userId"
  FROM "closed")
-- params: ["cancelled", 2, "pending", "{2}", "{\"pending\"}", "{10.5}", "opened", "closed"]
```

- Under a unique index over the scope (one current row per key), without the barrier the insert may run first:
  23505 — or, with `onConflictDoNothing`, a silently skipped insert that leaves the key without a current row.
  PostgreSQL plans the barrier as a one-time filter evaluated before the first row. An `exists()` over the CTE is
  no barrier: it stops at the first row.
- The barrier orders what the statement writes, not what it sees: the insert still reads the snapshot in which the
  closed row is current. Decide what to close and what to open on disjoint keys.
- Reading only the open leg declares the close leg first: `db.selectFromCte(opened.cte).select(r => r.id).toList()`
  renders `WITH "closed" AS (UPDATE …), "opened" AS (INSERT … WHERE ((SELECT count(*) FROM "closed") >= 0) …) SELECT "opened"."id" as "value" FROM "opened"`.
- `union()` / `unionAll()` of CTE-rooted queries (since 1.0.29) take CTE-rooted, entity and set queries projecting
  the same columns as legs. They declare every leg's CTEs once at the top of the statement (a data-modifying one
  after the CTEs it reads) and read every row the way the FIRST leg's projection reads it; each leg's literal
  (`leg`) is read from the row. The union is a `UnionQueryBuilder`: `orderBy()`, `limit()`, `count()`,
  `firstOrDefault()`, `asSubquery()`, a CTE body.
- `count()` of such a union keeps the data-modifying `WITH` at the top (fixed in 1.0.30; it failed with 0A000
  before): `WITH "closed" AS (UPDATE …) SELECT COUNT(*) as count FROM ((…) UNION ALL (…)) as union_count`.
- Such a union does not join a `QueryBatch`. Its `futureCount()` / `futureFirstOrDefault()` (since 1.0.31) throw
  before anything is sent: `futureCount(): the union's legs declare the data-modifying CTE "closed" — a future is
  read as a subquery by a QueryBatch, where a data-modifying WITH is not allowed (it must lead its statement). Run
  count() for it: a statement of its own.` An `addList()` leg (`future()`) is sent and PostgreSQL refuses the batch
  (0A000). A union of CTE-rooted legs without a data-modifying CTE joins a batch like any union
  ([Batching](./batching-and-prepared-queries.md#count-a-union-or-read-its-first-row-in-a-batch)).
- Read legs back with a union, not a FULL JOIN on a null-safe key: PostgreSQL plans a FULL JOIN only on merge- or
  hash-joinable conditions (0A000).
- `afterMutation()` of a plain CTE throws: `afterMutation(): "plain" is not a data-modifying CTE — a barrier orders a statement after a mutation`.
  So does `afterMutation()` in a statement that neither declares the CTE nor is compiled as another CTE's body.
- The in-memory database runs CTEs in the order the main query first reads them, as PostgreSQL does: a test that
  reads the open leg first exercises the dangerous order on both engines.

## Run CTE statements on a table's own connection: `<table>.selectFromCte()`

Every table offers the query roots of its context (since 1.0.30): `<table>.selectFromCte(cte, alias?)`,
`<table>.selectFromSet(set, alias?)`, plus `<table>.isInTransaction()` and `<table>.getClient()`. They run on the
table's own client and executor — on `trx.orders`, inside that transaction. Use them in helpers that receive a
table (`db.orders` or a caller's `trx.orders`) and must execute and read back the CTEs they build on it.

```ts
import { DbCteBuilder, afterMutation, and, eq, fromRows } from 'linkgress-orm';
import type { DbEntityTable } from 'linkgress-orm';
import type { Order } from './model/order';   // the entity class of db.orders

const replacePendingOrder = async (orders: DbEntityTable<Order>, userId: number, totalAmount: number) => {
  const builder = new DbCteBuilder(orders.getClient());
  const closed = builder.withMutation('closed', orders
    .where(o => and(eq(o.userId, userId), eq(o.status, 'pending')))
    .update({ status: 'cancelled' })
    .toStatement(o => ({ id: o.id })));
  const opened = builder.withMutation('opened', orders.insertFrom(
    fromRows(orders, [{ userId, status: 'pending', totalAmount }], { columns: ['userId', 'status', 'totalAmount'], alias: 'd' })
      .asSubquery('table'),
    src => ({ userId: src.userId, status: src.status, totalAmount: src.totalAmount }),
    { where: () => afterMutation(closed.cte) },
  ).toStatement(o => ({ id: o.id })));

  // ONE statement on the table's connection: inside the caller's transaction when there is one
  const rows = await orders.selectFromCte(opened.cte).select(r => ({ leg: 'opened', id: r.id }))
    .unionAll(orders.selectFromCte(closed.cte).select(r => ({ leg: 'closed', id: r.id })))
    .toList();

  return { rows, ownsUnitOfWork: !orders.isInTransaction() };
};

const inTx = await db.transaction(async trx => replacePendingOrder(trx.orders, 2, 20));
// { rows: [{ leg: 'opened', id: 3 }, { leg: 'closed', id: 2 }], ownsUnitOfWork: false }
const outside = await replacePendingOrder(db.orders, 2, 30);
// ownsUnitOfWork: true
```

On `trx.orders` the statement goes through the transaction's connection:

```sql
WITH "closed" AS (UPDATE "orders" SET "status" = $1 WHERE ("orders"."user_id" = $2 AND "orders"."status" = $3) RETURNING "id" AS "id"), "opened" AS (INSERT INTO "orders" ("user_id", "status", "total_amount") SELECT "src"."userId", "src"."status", "src"."totalAmount" FROM (SELECT "d"."userId" as "userId", "d"."status" as "status", "d"."totalAmount" as "totalAmount"
  FROM unnest(CAST($4 AS integer[]), CAST($5 AS order_status[]), CAST($6 AS decimal(10, 2)[])) AS "d"("userId", "status", "totalAmount")) AS "src" WHERE ((SELECT count(*) FROM "closed") >= 0) RETURNING "id" AS "id")
(SELECT CAST($7 AS text) as "leg", "opened"."id" as "id"
  FROM "opened")
UNION ALL
(SELECT CAST($8 AS text) as "leg", "closed"."id" as "id"
  FROM "closed")
-- params: ["cancelled", 2, "pending", "{2}", "{\"pending\"}", "{20}", "opened", "closed"]
```

- The same signatures, typings and SQL as `db.selectFromCte()` / `db.selectFromSet()`. A table derived with
  `.withTimeout()`, `.withQueryOptions()`, `.withPreparedStatements()` or `.expectedExecutionTime()` runs them
  through its derived executor. Views (`DbViewTable`) have the four methods too.
- `isInTransaction()` is `true` on the tables of a transaction's context — also after it ended, when their statements
  are refused with `TransactionEndedError` — and `false` on the root's. Outside a caller's transaction the statement
  commits on its own and retrying it after 40P01 / 40001 is the helper's call; inside one, the failure aborts the
  caller's transaction. There are no nested transactions; a SAVEPOINT stays inside the transaction.
- `getClient()` returns the client of the table's context (the transaction's on `trx.<table>`).
  `new DbCteBuilder(client)` builds bodies with the driver's capabilities: on a driver without binary array
  results (BunClient in its default prepared mode), array aggregations in bodies emit `json_agg`.

> **Pitfall:** inside `db.transaction(async trx => …)`, a statement rooted on `db` runs on another connection,
> outside the transaction. It cannot see the transaction's uncommitted rows — an order inserted for a user that the
> same transaction inserted before fails with 23503 (`insert or update on table "orders" violates foreign key constraint "FK_orders_users_user_id"`) —
> and on a pool of one connection it waits for a second connection forever (`PGliteClient`, one session, refuses it
> at once). Root it on `trx` or on the table you were given.

## Recursive queries: raw SQL

There is no `WITH RECURSIVE` builder. For a hierarchy (a parent id column) or a generated series, write the
recursive CTE in raw SQL through `db.query()`; a `sql` template binds its interpolated values as parameters.

```ts
import { sql } from 'linkgress-orm';

const days = await db.query<{ n: number }>(sql`
  WITH RECURSIVE days(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM days WHERE n < ${3}
  )
  SELECT n FROM days`);
// [{ n: 1 }, { n: 2 }, { n: 3 }]
```

```sql
WITH RECURSIVE days(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM days WHERE n < $1
)
SELECT n FROM days
-- params: [3]
```

One level of parent/child needs no recursion: a collection navigation, or a correlated
[aliased scope](./aliased-scopes.md) over the same table (`db.<table>.as(alias)`).

## Combine CTEs of several builders: `getCtes()`, `clear()`

A statement declares CTEs of any number of builders: `.with(...b1.getCtes(), ...b2.getCtes())`. A builder numbers
its CTEs' parameters as one block (each `DbCte` records where its body starts: `paramBase`, `2` for a builder's
second one-parameter CTE); every statement renumbers each body from where its parameters land, so a builder's
second CTE used alone, or CTEs of several builders in one `WITH`, bind their own values.

```ts
import { DbCteBuilder, eq, gt } from 'linkgress-orm';

const first = new DbCteBuilder();
const active = first.with('active_users', db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id, name: u.username })));
const second = new DbCteBuilder();
const busyPosts = second.with('busy_posts', db.posts.where(p => gt(p.views, 120)).select(p => ({ userId: p.userId, title: p.title })));

const rows = await db.users
  .with(...first.getCtes(), ...second.getCtes())
  .innerJoin(active.cte, (u, a) => eq(u.id, a.id), (u, a) => ({ id: u.id, name: a.name }))
  .innerJoin(busyPosts.cte, (r, b) => eq(r.id, b.userId), (r, b) => ({ name: r.name, title: b.title }))
  .toList();
// [{ name: 'alice', title: 'Alice Post 2' }, { name: 'bob', title: 'Bob Post' }]
```

```sql
WITH "active_users" AS (SELECT "users"."id" as "id", "users"."username" as "name"
  FROM "users"
  WHERE "users"."is_active" = $1), "busy_posts" AS (SELECT "posts"."user_id" as "userId", "posts"."title" as "title"
  FROM "posts"
  WHERE "posts"."views" > $2)
SELECT "active_users"."name" as "name", "busy_posts"."title" as "title"
FROM "users"
INNER JOIN "active_users" ON "users"."id" = "active_users"."id"
INNER JOIN "busy_posts" ON "users"."id" = "busy_posts"."userId"
-- params: [true, 120]
```

- `getCtes()` returns the builder's CTEs in creation order; `clear()` removes them and resets the parameter
  numbering. A builder can be reused after `clear()`.

## Type CTE columns

The CTE's column types come from the body's projection. `InferCteColumns<typeof x.cte>` extracts them; `isCte(v)`
tells a `DbCte` at runtime.

```ts
import { DbCteBuilder, eq } from 'linkgress-orm';
import type { InferCteColumns } from 'linkgress-orm';

const active = new DbCteBuilder().with('active_users', db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({ userId: u.id, username: u.username, email: u.email })));

type ActiveRow = InferCteColumns<typeof active.cte>;   // { userId: number; username: string; email: string }

const rows = await db.users
  .leftJoin(
    active.cte,
    (u, a) => eq(u.id, a.userId),                       // ON: a.userId is a column ref (FieldRef)
    (u, a) => ({ id: u.id, activeName: a.username }),   // selector: a.username is typed string
  )
  .toList();
// Array<{ id: number; activeName: string }>; at runtime [{ id: 1, activeName: 'alice' }, { id: 2, activeName: 'bob' }, { id: 3, activeName: undefined }]
```

```sql
WITH "active_users" AS (SELECT "users"."id" as "userId", "users"."username" as "username", "users"."email" as "email"
  FROM "users"
  WHERE "users"."is_active" = $1)
SELECT "users"."id" as "id", "active_users"."username" as "activeName"
FROM "users"
LEFT JOIN "active_users" ON "users"."id" = "active_users"."userId"
-- params: [true]
```

- Inside the ON callback the CTE's columns are column refs: `const id: number = a.userId` there is a TypeScript
  error. Values are typed in the selector.
- A LEFT-joined CTE column is typed as non-optional, but a row without a match reads `undefined`
  (`{ id: 3, activeName: undefined }`).
- `withMutation(name, x.toStatement(sel))` types the CTE by the RETURNING selector.

## Pitfalls

- **Don't** read a CTE from subqueries without `.with(cte)` on the executing query → **Do** attach it there. Each
  reader otherwise declares, binds and evaluates its own copy (`params: [30, 30]` instead of `[30]`).
- **Don't** root a statement on `db` inside `db.transaction()` → **Do** root it on `trx` or on the table you were
  handed (`trx.orders.selectFromCte(…)`). Rooted on `db` it runs on another connection: 23503 for a parent the
  transaction inserted, a hang on a pool of one connection.
- **Don't** expect the main query to see a data-modifying CTE's changes → **Do** read its RETURNING rows. All parts of
  a statement share one snapshot.
- **Don't** rely on the order of two data-modifying CTEs → **Do** guard the second with `afterMutation(first)`.
  PostgreSQL promises no order between them.
- **Don't** call `forUpdate()` on a CTE-rooted query to lock rows → **Do** put `.forUpdate()` on the CTE body. A
  locking clause does not reach the WITH queries the main query reads.
- **Don't** reuse a CTE-rooted builder after `first()`, `where()` or `limit()` → **Do** build a new query per use.
  The builder is mutable; `first()` leaves `LIMIT 1` on it.
- **Don't** `joinFilter()` a CTE with several rows per key when you want one row per entity → **Do** use
  `inSubquery()` or `exists()`. The join returns each entity row once per match.
- **Don't** join a CTE-rooted query's root CTE to itself → **Do** use a second CTE or a `selectFromCte(cte, alias)`
  subquery. The statement would declare the name twice (42712).
- **Don't** filter a window value in the query that computes it → **Do** compute it in a CTE and filter where the CTE
  is read. The build throws a `TypeError`.
- **Don't** run a query whose collection reads a data-modifying CTE on the `'temptable'` strategy → **Do** use
  `'cte'` or `'lateral'`. It is refused before anything runs.
- **Don't** put a union whose legs read a data-modifying CTE into a `QueryBatch` → **Do** run its `count()`,
  `firstOrDefault()` or `toList()` on its own. A batch reads its legs as subqueries, where no data-modifying `WITH`
  is allowed: the count and first-row legs are refused (since 1.0.31), a list leg fails with 0A000.
- **Don't** expect a collection's `min()` / `max()` of a mapped column in a body to read mapped through the CTE →
  **Do** map it where it is read, or aggregate in a grouped body (`g.min()` / `g.max()` keep the mapper). The CTE
  column holds the stored value, although the body's own query reads it mapped since 1.0.31.
- **Don't** put a whole navigation row in a CTE body when one column is read → **Do** project the column. A
  navigation row renders every column of its table.
- **Don't** expect `materialized: true` to speed up every CTE → **Do** use it for candidate sets that must drive the
  plan. The fence blocks predicate pushdown into the body.
- **Don't** put two different CTEs under one name in a statement → **Do** rename one. The build refuses it, since
  the name would read the other one's rows.
- **Don't** treat a LEFT-joined CTE column as always present → **Do** handle `undefined`. Its type is not optional,
  but a row without a match reads `undefined` (not `null`).
- **Don't** rename a `withAggregation()` key and then read it from the items → **Do** keep the output name equal to
  the inner column. The items omit the inner key column although their type lists it.

## See also

- [Subqueries](./subquery-guide.md) — a derived value or set read once, in one place: `asSubquery()`, `exists()`, `inSubquery()`.
- [Set-returning functions](./set-returning-functions.md) — JS lists, JS rows and jsonb as relations: `unnest()`, `fromRows()`, `db.selectFromSet()`.
- [Insert, update, delete](./insert-update-guide.md) — `toStatement()`, `insertFrom()` options, upserts, `MutationBatch`.
- [Collection strategies](../collection-strategies.md) — the CTEs and LATERAL joins the ORM emits for collection navigations.
- [Aliased scopes](./aliased-scopes.md) — correlated subqueries over the same table: `db.<table>.as(alias)`.
- [SQL expressions](./sql-expressions.md) — `win`, `agg` and the other expression helpers used in CTE bodies.
- [Choosing the right query](../choosing-the-right-query.md) — data need → API → SQL shape → round trips.
- [API index](../api-index.md) — every public export and builder method, one line each.
- Tests with more cases (repository only, not in the npm package): [tests/queries/cte.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/queries/cte.test.ts), [tests/queries/cte-statement-hoisting.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/queries/cte-statement-hoisting.test.ts), [tests/queries/cte-union-readback.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/queries/cte-union-readback.test.ts).
