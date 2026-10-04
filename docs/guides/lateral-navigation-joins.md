# Lateral Navigation Joins: `lateralJoin()`

> **For agents:** When should one reference navigation of a query be joined as a per-row key probe (`lateralJoin()`) instead of a plain join, and what SQL does that emit?
> **Use this page when:** a query reads FEW rows (one parent's lines, one page) through a foreign key into a LARGE table, a plan merge-joins or scans a large target for a handful of rows, or you need to know where `lateralJoin()` is accepted and what it refuses. **Look elsewhere when:** loading `hasMany` collections per row → [Collection Strategies](../collection-strategies.md); reading navigations in general → [Querying](./querying.md)
> **Key APIs:** `lateralJoin()` (since 1.0.23), `LateralNavigation<T>` (since 1.0.28) · **Round trips:** none added: the probe is part of the query's own statement (1 for a root query), whose text is the same on every build

A reference navigation (`hasOne`, many-to-one or one-to-one) read by a query renders as a plain join, and PostgreSQL picks how to run it. `lateralJoin(row => row.<navigation>)` renders that ONE navigation, in that ONE query, as a LATERAL subquery that looks up the target's key once per row. The rows are the same; only the join method is fixed.

The rule for agents: **do not add `lateralJoin()` by default.** Add it to a navigation that reads values for rows the query already found by other means, when those rows are few and the target is large. Never add it to a navigation the `where()` filters by.

Examples run against `db`, an `AppDatabase` (the example model: [Example Model and Seed Data](../example-model.md)) seeded with the test data. Every SQL block was captured from the statement the library sent.

## Contents

- [Probe one navigation instead of joining it](#probe-one-navigation-instead-of-joining-it)
- [Decide whether a navigation needs the probe](#decide-whether-a-navigation-needs-the-probe)
- [Why a plain join can read the whole target index](#why-a-plain-join-can-read-the-whole-target-index)
- [Probe a navigation reached through other navigations](#probe-a-navigation-reached-through-other-navigations)
- [Probe the path of a collection](#probe-the-path-of-a-collection)
- [Call it after select(), on a collection, or on any builder](#call-it-after-select-on-a-collection-or-on-any-builder)
- [Read what the probe renders](#read-what-the-probe-renders)
- [Know what lateralJoin() refuses](#know-what-lateraljoin-refuses)
- [Check the plan on PostgreSQL](#check-the-plan-on-postgresql)
- [Coverage](#coverage)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Probe one navigation instead of joining it

The lines of one order with their task and its level. `ot.task` is optional (no `.isRequired()`), so the plain query LEFT JOINs it:

```ts
import { eq } from 'linkgress-orm';

const orderId = 1;
const lines = await db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .lateralJoin(ot => ot.task)
  .select(ot => ({ taskId: ot.taskId, task: ot.task!.title, level: ot.task!.level!.name }))
  .toList();
// [{ taskId: 1, task: 'Important Task', level: 'High Priority' }]
```

Without `lateralJoin()`:

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task", "level"."name" as "level"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

With `lateralJoin(ot => ot.task)`:

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task", "level"."name" as "level"
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

- The rows are the plain join's: an unmatched or NULL foreign key keeps its row with NULLs (`LEFT JOIN LATERAL … ON true`).
- The probe keeps the navigation's alias (`"task"`), so navigations reached through it (`ot.task!.level`) join off it as before.
- `OFFSET 0` keeps PostgreSQL from pulling the subquery back up into a plain join. (`LIMIT 1` would too, but would drop rows for a principal key that is not unique.)

A required navigation (`.isRequired()`) probes with `INNER JOIN LATERAL`, and drops the row whose target is missing, as its INNER join did:

```ts
const alicePosts = await db.posts
  .where(p => eq(p.userId, 1))
  .lateralJoin(p => p.user)
  .select(p => ({ title: p.title, author: p.user!.username }))
  .toList();
// [{ title: 'Alice Post 1', author: 'alice' }, { title: 'Alice Post 2', author: 'alice' }]
```

```sql
SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN LATERAL (SELECT "user__probe".* FROM "users" "user__probe" WHERE "user__probe"."id" = "posts"."user_id" OFFSET 0) "user" ON true
WHERE "posts"."user_id" = $1
-- params: [ 1 ]
```

## Decide whether a navigation needs the probe

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Read columns of a large target for FEW rows the query found by other means (one order's lines, one page) | `lateralJoin(row => row.<navigation>)` | `LEFT` / `INNER JOIN LATERAL (SELECT … WHERE <key> = <foreign key> OFFSET 0) … ON true` · 1 | the plain join, when its plan merge-joins or scans the target |
| Filter rows by a navigation's column (`where(p => eq(p.user!.username, …))`) | the plain navigation | `JOIN … ON <foreign key> = <key>` plus the WHERE · 1 | `lateralJoin()`: PostgreSQL can no longer start from the target's matching rows |
| Join thousands of rows to a target of similar size | the plain navigation | a hash or merge join PostgreSQL picks · 1 | `lateralJoin()`: one index lookup per row |
| Read a related value in `update()` / `delete()` | the plain navigation, or a correlated scalar subquery (`asSubquery('scalar')`) | `UPDATE … FROM` / `SET … = (SELECT …)` · 1 | `lateralJoin()`: refused |
| A grouped query (`groupBy()`) | the plain navigation | `JOIN … GROUP BY …` · 1 | `lateralJoin()`: refused |
| The children of a row (`hasMany`) | a collection: [Collection Strategies](../collection-strategies.md) | LATERAL / CTE per collection · 1 | `lateralJoin()` on a collection navigation: refused (a compile error on typed builders) |

The opt-in is per navigation and per query, never model-wide: `lateralJoin(ot => ot.task)` changes the task's join of this query and nothing else. Every other navigation, and every other query, renders as before. No benchmark in `bench/` measures the probe; [check the plan](#check-the-plan-on-postgresql) of the statement on your server.

## Why a plain join can read the whole target index

PostgreSQL estimates how much of the target's primary-key index a merge join reads from the statistics of the foreign-key column: the range of keys its histogram has seen. When the rows being joined hold keys far above that range (the newest rows of the target, rarely in a statistics sample), the planner believes a merge join stops after a sliver of the index, picks it, and then reads the WHOLE index for a handful of rows. Whether it does depends on the sample the last `ANALYZE` drew: the same statement can be fast for weeks and slow after an autoanalyze, and a pooled connection keeps the plan it cached.

The probe takes that choice away. A LATERAL subquery that reads the outer row's foreign key can only run once per outer row, through the target's key index, whatever the statistics say. The same property makes it the wrong choice for many rows (no hash join is possible) and for a navigation the query filters by (no plan can start from the target).

## Probe a navigation reached through other navigations

The selector may name a reference reached through other references (since 1.0.25). The probe replaces the join of the path's LAST hop and reads the foreign key off the join of the hop before it, which keeps its plain join:

```ts
const lines = await db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .lateralJoin(ot => ot.task!.level)
  .select(ot => ({ taskId: ot.taskId, task: ot.task!.title, level: ot.task!.level!.name }))
  .toList();
```

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task", "level"."name" as "level"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN LATERAL (SELECT "level__probe".* FROM "task_levels" "level__probe" WHERE "level__probe"."id" = "task"."level_id" OFFSET 0) "level" ON true
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

This is the case of rows that reach a large table through a smaller one: the statistics that decide the last hop's join are those of the INTERMEDIATE table's foreign-key column, which can end far below the newest keys it holds when that table references only a slice of the target. Opt in each hop that needs it; the second probe reads the first one's alias:

```ts
const lines = await db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .lateralJoin(ot => ot.task)
  .lateralJoin(ot => ot.task!.level)
  .select(ot => ({ taskId: ot.taskId, task: ot.task!.title, level: ot.task!.level!.name }))
  .toList();
```

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task", "level"."name" as "level"
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
LEFT JOIN LATERAL (SELECT "level__probe".* FROM "task_levels" "level__probe" WHERE "level__probe"."id" = "task"."level_id" OFFSET 0) "level" ON true
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

A path is told apart from another path that ends in the same relation. A comment reaches a user through its post and through its order; the second path renders under `"order__user"`, and only the join of the path the selector names becomes a probe:

```ts
const comments = await db.postComments
  .where(pc => eq(pc.postId, 1))
  .lateralJoin(pc => pc.order!.user)
  .select(pc => ({ comment: pc.comment, postAuthor: pc.post!.user!.username, orderOwner: pc.order!.user!.username }))
  .toList();
// [{ comment: 'Related to order', postAuthor: 'alice', orderOwner: 'alice' }]
```

```sql
SELECT "post_comments"."comment" as "comment", "user"."username" as "postAuthor", "order__user"."username" as "orderOwner"
FROM "post_comments"
LEFT JOIN "posts" AS "post" ON "post_comments"."post_id" = "post"."id"
LEFT JOIN "orders" AS "order" ON "post_comments"."order_id" = "order"."id"
INNER JOIN "users" AS "user" ON "post"."user_id" = "user"."id"
INNER JOIN LATERAL (SELECT "order__user__probe".* FROM "users" "order__user__probe" WHERE "order__user__probe"."id" = "order"."user_id" OFFSET 0) "order__user" ON true
WHERE "post_comments"."post_id" = $1
-- params: [ 1 ]
```

> **Pitfall:** a required hop after an optional one joins INNER, probed or not: `user` is required, so a comment whose post (or order) is missing is DROPPED here, by the plain join and the probe alike.

## Probe the path of a collection

A collection reached through navigations (`pc.order!.orderTasks`) is correlated through that path. Where its subquery joins the path anew, from the row the path starts from (the LATERAL of a list, a `limit()`ed list or `firstOrDefault()`; the subquery of a `count()` / `exists()` written in a `where()` or a `sql` fragment), a hop the query probes is probed there too (since 1.0.26). Nothing is called on the collection. A plain join of that hop inside the subquery would leave PostgreSQL the very merge join the probe takes away, decided by the same statistics, for the same few rows.

A list re-joins the path inside its LATERAL, with the probe:

```ts
const withTasks = await db.postComments
  .where(pc => eq(pc.postId, 1))
  .lateralJoin(pc => pc.order)
  .select(pc => ({
    comment: pc.comment,
    orderTaskIds: pc.order!.orderTasks!.select(ot => ({ taskId: ot.taskId })).toList(),
  }))
  .toList();
// [{ comment: 'Related to order', orderTaskIds: [{ taskId: 1 }] }]
```

```sql
SELECT "post_comments"."comment" as "comment", COALESCE("lateral_0".data, '[]'::json) as "orderTaskIds"
FROM "post_comments"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('taskId', "taskId")
) as data
FROM (
  SELECT "lateral_0_orderTasks"."task_id" as "taskId"
  FROM "order_task" "lateral_0_orderTasks"
  LEFT JOIN LATERAL (SELECT "order__probe".* FROM "orders" "order__probe" WHERE "order__probe"."id" = "post_comments"."order_id" OFFSET 0) "order" ON true
  WHERE "lateral_0_orderTasks"."order_id" = "order"."id"
) sub) "lateral_0" ON true
WHERE "post_comments"."post_id" = $1
-- params: [ 1 ]
```

A `count()` in a `where()` re-joins the path in its subquery, with the probe:

```ts
import { gt } from 'linkgress-orm';

const commented = await db.postComments
  .lateralJoin(pc => pc.order)
  .where(pc => gt(pc.order!.orderTasks!.count(), 0))
  .select(pc => ({ comment: pc.comment }))
  .toList();
```

```sql
SELECT "post_comments"."comment" as "comment"
FROM "post_comments"
WHERE (SELECT COUNT(*) FROM "order_task" "orderTasks__count"
LEFT JOIN LATERAL (SELECT "order__probe".* FROM "orders" "order__probe" WHERE "order__probe"."id" = "post_comments"."order_id" OFFSET 0) "order" ON true
WHERE "orderTasks__count"."order_id" = "order"."id") > $1
-- params: [ 0 ]
```

What joins nothing of the path is unchanged. A projected `count()` (and `toStringList()` / `toNumberList()`) correlates to the row's own join, which is the probe:

```ts
const counted = await db.postComments
  .where(pc => eq(pc.postId, 1))
  .lateralJoin(pc => pc.order)
  .select(pc => ({ comment: pc.comment, orderTaskCount: pc.order!.orderTasks!.count() }))
  .toList();
// [{ comment: 'Related to order', orderTaskCount: 1 }]
```

```sql
SELECT "post_comments"."comment" as "comment", (SELECT COALESCE(COUNT(*), 0)
FROM "order_task" "lateral_0_orderTasks"
WHERE "lateral_0_orderTasks"."order_id" = "order"."id") as "orderTaskCount"
FROM "post_comments"
LEFT JOIN LATERAL (SELECT "order__probe".* FROM "orders" "order__probe" WHERE "order__probe"."id" = "post_comments"."order_id" OFFSET 0) "order" ON true
WHERE "post_comments"."post_id" = $1
-- params: [ 1 ]
```

The `cte` and `temptable` aggregations also correlate to the row's own, probed join. Under `cte`, the list of the first example joins its CTE to the probed `"order"` (below); `temptable` selects `"order"."id" as "__pk_0"` from the probed row in its base query. A LATERAL nested in a `temptable` aggregation joins the path anew and probes it.

```sql
WITH "cte_0" AS (SELECT
  "__fk_order_id" as parent_id,
  json_agg(
    json_build_object('taskId', "taskId")
  ) as data
FROM (
  SELECT "order_task"."order_id" as "__fk_order_id", "task_id" as "taskId"
  FROM "order_task"
) sub
GROUP BY "__fk_order_id")
SELECT "post_comments"."comment" as "comment", COALESCE("cte_0".data, '[]'::json) as "orderTaskIds"
FROM "post_comments"
LEFT JOIN LATERAL (SELECT "order__probe".* FROM "orders" "order__probe" WHERE "order__probe"."id" = "post_comments"."order_id" OFFSET 0) "order" ON true
LEFT JOIN "cte_0" ON "cte_0".parent_id = "order"."id"
WHERE "post_comments"."post_id" = $1
-- params: [ 1 ]
```

A hop of a collection's path is probed when the query whose row the path starts from probes the same path: `lateralJoin(pc => pc.order)` probes the order hop of `pc.order!.orderTasks`, in a root query and in a collection whose items the path starts from. The other hops keep their plain joins; a path the query does not probe, and a query without `lateralJoin()`, render as before.

## Call it after select(), on a collection, or on any builder

| Where | Notes |
|---|---|
| A table: `db.orderTasks.lateralJoin(…)` | returns an `IEntityQueryable`; call it once per navigation to probe several |
| After `where()`, after `with(cte)` | the selector names a navigation of the row (or a path of them) |
| After `select()` (since 1.0.24) and on every other select builder: `selectDistinct()`, `innerJoin()` / `leftJoin()`, the end of a chain, a builder taken as an `IEntityQueryable` | the selector names a navigation of the query's ROOT row, whatever the projection; the projection and the chain are kept |
| The untyped builders: `QueryBuilder` (`db.getTable('posts').where(…)`), `SelectQueryBuilder` | not on the untyped `TableAccessor` itself (`db.getTable('posts')`): call it after `where()` or `select()` |
| A collection, BEFORE its `select()`: `o.orderTasks!.lateralJoin(ot => ot.task).select(…)` | under `lateral`, `cte` and `temptable`; a collection's `count()` / `exists()`, projected or in a `where()`, probes too. Not available after the collection's `select()` |
| Every terminal and form that renders the query | `toList()`, `first()`, `firstOrDefault()`, `count()`, `exists()`, `min()` / `max()` / `sum()`, `countOver()`, `future()`, `prepare()`, `QueryBatch` legs, `union()` / `unionAll()` legs |

After `select()` the statement is the one `lateralJoin()` renders before `select()`, because the navigation joins are rendered when the query is built:

```ts
const lines = await db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .select(ot => ({ taskId: ot.taskId, task: ot.task!.title, level: ot.task!.level!.name }))
  .lateralJoin(ot => ot.task) // the same statement as .lateralJoin(ot => ot.task).select(…)
  .toList();
```

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task", "level"."name" as "level"
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

On a collection, the collection's rows (one parent's) drive, and the probe reads the foreign key of the row the strategy renders the item as:

```ts
const orders = await db.orders
  .where(o => eq(o.id, 1))
  .select(o => ({
    orderId: o.id,
    tasks: o.orderTasks!
      .lateralJoin(ot => ot.task)
      .select(ot => ({ taskId: ot.taskId, title: ot.task!.title }))
      .toList(),
  }))
  .toList();
// [{ orderId: 1, tasks: [{ taskId: 1, title: 'Important Task' }] }]
```

`lateral` (the default strategy):

```sql
SELECT "orders"."id" as "orderId", COALESCE("lateral_0".data, '[]'::json) as "tasks"
FROM "orders"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('taskId', "taskId", 'title', "title")
) as data
FROM (
  SELECT "lateral_0_orderTasks"."task_id" as "taskId", "task"."title" as "title"
  FROM "order_task" "lateral_0_orderTasks"
  LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "lateral_0_orderTasks"."task_id" OFFSET 0) "task" ON true
  WHERE "lateral_0_orderTasks"."order_id" = "orders"."id"
) sub) "lateral_0" ON true
WHERE "orders"."id" = $1
-- params: [ 1 ]
```

`cte` (`temptable` renders the same aggregation inside its `CREATE TEMP TABLE … AS`):

```sql
WITH "cte_0" AS (SELECT
  "__fk_order_id" as parent_id,
  json_agg(
    json_build_object('taskId', "taskId", 'title', "title")
  ) as data
FROM (
  SELECT "order_task"."order_id" as "__fk_order_id", "order_task"."task_id" as "taskId", "task"."title" as "title"
  FROM "order_task"
  LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
) sub
GROUP BY "__fk_order_id")
SELECT "orders"."id" as "orderId", COALESCE("cte_0".data, '[]'::json) as "tasks"
FROM "orders"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "orders".id
WHERE "orders"."id" = $1
-- params: [ 1 ]
```

A collection's `count()` filtering through its item's probe:

```ts
const pending = await db.orders
  .select(o => ({
    orderId: o.id,
    pendingTasks: o.orderTasks!.lateralJoin(ot => ot.task).where(ot => eq(ot.task!.status, 'pending')).count(),
  }))
  .toList();
// [{ orderId: 1, pendingTasks: 1 }, { orderId: 2, pendingTasks: 0 }]
```

```sql
SELECT "orders"."id" as "orderId", (SELECT COALESCE(COUNT(*), 0)
FROM "order_task" "lateral_0_orderTasks"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "lateral_0_orderTasks"."task_id" OFFSET 0) "task" ON true
WHERE "lateral_0_orderTasks"."order_id" = "orders"."id" AND "task"."status" = $1) as "pendingTasks"
FROM "orders"
-- params: [ "pending" ]
```

The text is the same every time the query is built, so a prepared statement keeps ONE cached plan. A `prepare()`d query executed twice sent this statement twice, byte for byte:

```ts
const orderLines = db.orderTasks
  .where(ot => eq(ot.orderId, 1))
  .lateralJoin(ot => ot.task)
  .select(ot => ({ taskId: ot.taskId, task: ot.task!.title }))
  .prepare('orderLines');
await orderLines.execute({});
await orderLines.execute({});
```

```sql
SELECT "order_task"."task_id" as "taskId", "task"."title" as "task"
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

Each `union()` / `unionAll()` leg is a query of its own: only the leg that calls `lateralJoin()` probes.

```ts
const both = await db.posts
  .where(p => eq(p.userId, 1))
  .lateralJoin(p => p.user)
  .select(p => ({ title: p.title, author: p.user!.username }))
  .unionAll(db.posts.where(p => eq(p.userId, 2)).select(p => ({ title: p.title, author: p.user!.username })))
  .toList();
```

```sql
(SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN LATERAL (SELECT "user__probe".* FROM "users" "user__probe" WHERE "user__probe"."id" = "posts"."user_id" OFFSET 0) "user" ON true
WHERE "posts"."user_id" = $1)
UNION ALL
(SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE "posts"."user_id" = $2)
-- params: [ 1, 2 ]
```

A `QueryBatch` leg keeps its probe inside the batch's one statement:

```ts
import { QueryBatch } from 'linkgress-orm';

const batch = new QueryBatch();
const linesLeg = batch.addList(
  db.orderTasks.where(ot => eq(ot.orderId, 1)).lateralJoin(ot => ot.task).select(ot => ({ task: ot.task!.title })),
  'lines',
);
const popularLeg = batch.addCount(db.posts.where(p => gt(p.views, 120)), 'popular');
await batch.executeBatch();
// batch.getList(linesLeg): [{ task: 'Important Task' }], batch.getCount(popularLeg): 2
```

```sql
SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT "task"."title" as "task"
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
WHERE "order_task"."order_id" = $1
) __batch_q
UNION ALL
SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (
SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."views" > $2
) __batch_q
-- params: [ 1, 120 ]
```

A navigation the statement never joins renders nothing. `count()` reads nothing of the task, so its statement is the one without the probe; `max()` over a probed column joins it:

```ts
const lineCount = await db.orderTasks.where(ot => eq(ot.orderId, orderId)).lateralJoin(ot => ot.task).count();
// 1
const lastTitle = await db.orderTasks.lateralJoin(ot => ot.task).select(ot => ({ title: ot.task!.title })).max(r => r.title);
// 'Regular Task'
```

```sql
SELECT COUNT(*) as count
FROM "order_task"
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

```sql
SELECT MAX("task"."title") as result
FROM "order_task"
LEFT JOIN LATERAL (SELECT "task__probe".* FROM "tasks" "task__probe" WHERE "task__probe"."id" = "order_task"."task_id" OFFSET 0) "task" ON true
```

## Read what the probe renders

The example model has no constant key part and no relation of a table to itself: those two rows use the names of the fixture in `tests/queries/lateral-navigation-join.test.ts` (books, authors), whose exact SQL that file pins.

| Navigation | Rendering |
|---|---|
| optional (`hasOne` without `.isRequired()`, `ot.task`) | `LEFT JOIN LATERAL (…) "task" ON true` |
| required (`.isRequired()`, `p.user`) | `INNER JOIN LATERAL (…) "user" ON true` |
| composite key | every key pair in the probe's WHERE, joined by `AND` |
| constant key part (`withForeignKey(b => [b.authorId, true])` / `withPrincipalKey(a => [a.id, a.active])`) | `… AND "<alias>__probe"."active" = true` in the probe's WHERE |
| of a table to itself (`a.mentor`) | the probe reads its table under `"<alias>__probe"`, so the outer row's foreign key is never read off the probed row |
| a path (`ot.task!.level`) | the probe of the last hop, its WHERE reading the foreign key off the hop before it (`"task"."level_id"`); the earlier hops keep their joins |
| a second path ending in the same relation (`pc.order!.user`) | the probe under that path's alias (`"order__user"`, read as `"order__user__probe"`) |
| a collection hanging off a probed hop (`pc.order!.orderTasks`) | its subquery's own join of that hop is the same probe, reading the foreign key off the hop before it as joined there (or off the row, for the first hop) |

Columns of the target nothing reads cost nothing: PostgreSQL drops them from the subquery's output, so the `SELECT "<alias>__probe".*` of the probe needs no column list.

## Know what lateralJoin() refuses

Each refusal throws synchronously at the call itself (`lateralJoin()`, `update()`, `delete()`, `groupBy()`, `selectMany()`; inside a projection, when the projection's selector runs), before any statement is sent; none silently renders a plain join. On the typed builders (a table, `IEntityQueryable`, every select builder, a collection) the selector's return type is checked through `LateralNavigation<T>` (since 1.0.28), which is `never` for a column, a collection, a value or nothing, so those selectors do not compile either. An untyped (`any`) row is taken as it is.

| Call | Compile time | At run time (the call throws) |
|---|---|---|
| a column: `db.posts.lateralJoin(p => p.title)` | `Type 'DbColumn<string>' is not assignable to type 'never'.` | `lateralJoin() takes a reference navigation of the "posts" row (row => row.<relation>, a many-to-one or one-to-one relation of that table), or one reached through such navigations (row => row.<relation>.<relation>) — not a column` |
| a column through a navigation: `p => p.user!.username` | the same | the same |
| a collection: `db.users.lateralJoin(u => u.posts)` | `Type 'EntityCollectionQuery<Post> \| undefined' is not assignable to type 'never'.` | `lateralJoin(): "posts" is a collection of "users" — a LATERAL probe joins a reference (many-to-one / one-to-one) navigation` |
| a path ending in a collection: `p => p.user!.posts` | the same | `lateralJoin(): "user.posts" is a collection of "users" — …` |
| a path through a collection (untyped row): `(u: any) => u.posts.user` | compiles | `lateralJoin(): "posts" is a collection of "users" — a LATERAL probe joins a reference (many-to-one / one-to-one) navigation, reached through reference navigations only` |
| `….lateralJoin(p => p.user).update({…})` / `.delete()` | compiles | `lateralJoin() cannot be combined with update(): PostgreSQL lets no LATERAL subquery read the row an UPDATE or DELETE writes. Read the value through a correlated scalar subquery instead — db.<target>.where(t => eq(t.<key>, row.<foreignKey>)).select(t => t.<column>).asSubquery('scalar')` (`delete()` likewise) |
| a grouped query: `….lateralJoin(p => p.user).select(…).groupBy(…)` | compiles | `lateralJoin() is not supported on a grouped query (groupBy()): "user" would join there as a plain join — drop lateralJoin() from this query` |
| `selectMany()` on a collection that calls `lateralJoin()`, in either order | compiles | `lateralJoin() is not supported on a collection flattened by selectMany() ("productPrices") — join the navigation plainly there` |

`update()` / `delete()` join their navigations as `FROM` / `USING` items, where PostgreSQL lets no LATERAL subquery read the row the statement writes. Drop `lateralJoin()` there, and read a related value through a correlated scalar subquery:

```ts
import { sql } from 'linkgress-orm';

await db.posts
  .where(p => eq(p.id, 1))
  .update(p => ({
    subtitle: sql<string>`${db.users.where(u => eq(u.id, p.userId)).select(u => u.username).asSubquery('scalar')}`,
  }));
```

```sql
UPDATE "posts" SET "subtitle" = (SELECT "users"."username"
FROM "users"
WHERE "users"."id" = "posts"."user_id") WHERE "posts"."id" = $1
-- params: [ 1 ]
```

or filter through the plain navigation:

```ts
await db.posts.where(p => eq(p.user!.username, 'alice')).update({ views: 101 });
```

```sql
UPDATE "posts" SET "views" = $1 FROM "users" AS "user" WHERE "posts"."user_id" = "user"."id" AND "user"."username" = $2
-- params: [ 101, "alice" ]
```

`lateralJoin()` is not offered on the untyped table accessor itself (`db.getTable('posts')` has no such method: call it after `where()` or `select()`), nor on a collection after its `select()` (the type `select()` returns, `EntityCollectionQueryWithSelect`, has no `lateralJoin()`: a compile error; call it before).

## Check the plan on PostgreSQL

The planner cannot turn the probe back into a merge join. With hash joins, nested loops and sequential scans switched off, the plain join falls back to a merge join while the probe stays a nested loop over an index lookup of the target's key:

```sql
-- illustrative (not captured): EXPLAIN needs a PostgreSQL server; tests/queries/lateral-navigation-join.test.ts asserts these plan shapes
BEGIN;
SET LOCAL enable_hashjoin = off; SET LOCAL enable_nestloop = off; SET LOCAL enable_seqscan = off;
EXPLAIN (COSTS OFF) <the plain statement>;   -- a Merge Join (Left or Right) on the foreign key
EXPLAIN (COSTS OFF) <the probed statement>;  -- no Merge Join: a Nested Loop over an Index Scan (or Index Only Scan) of the target's key, on "<alias>__probe"
ROLLBACK;
```

To see what your server does for a real query, log the statement (`logQueries: true`) and run `EXPLAIN (ANALYZE, BUFFERS)` on it with and without `lateralJoin()`. The in-memory database runs both shapes and returns the same rows; it has no planner to ask.

## Coverage

`tests/queries/lateral-join-matrix.test.ts` (since 1.0.28) generates its cases from the dimensions below (4,572 cases, `changelog/v1.0.28.md`) and runs every one on PostgreSQL, PGlite and in memory, against two oracles: the same query without `lateralJoin()` reads the same rows (in the same order where the query orders them), and every statement is the plain query's statement with each plain join of a probed hop (the row's own and every re-join a subquery makes of it) replaced by its probe, on every key pair, and nothing else changed (the parameters included). Where the fixture decides the rows (the key shapes), they are pinned as well. The examples in the table use the test fixture's books, authors and regions.

| Dimension | Covered |
|---|---|
| Where `lateralJoin()` is called | a table (`db.books.lateralJoin(…)`); after `where()`; after `with(cte)` (of a table, typed or untyped, before or after the probe); after `select()`, `selectDistinct()`, `innerJoin()` / `leftJoin()` of a table or of a table subquery; at the end of a chain; a builder taken as an `IEntityQueryable`; the untyped `QueryBuilder` / `SelectQueryBuilder`; `withPreparedStatements(true)`; a collection, before its `select()` |
| The path | one, two and three hops; optional and required hops; a table navigating to itself, once and twice in one path; the same table reached by two paths; a prefix and the full path, in either call order; every hop of a three-hop path; independent paths; the same path named twice; a navigation whose probe alias passes PostgreSQL's 63-byte identifier limit |
| The key | one column; a composite key; a constant key part on the principal side (`withPrincipalKey(a => [a.id, a.active])`) and on the foreign-key side (`withForeignKey(b => [b.authorId, b.isCurrent])` / `withPrincipalKey(a => [a.id, true])`); a principal key that is not `id`, custom-typed; a NULL and a dangling foreign key |
| What reads the probed row | its columns along the path; the row projected whole, at the root and in a collection's projection; a nested object; mapped columns (a custom type, an enum, a date, JSON); a WHERE on it, `isNull()` / `isNotNull()` of it (a row whose probed row is missing keeps its row, as with the LEFT join); an ORDER BY; `min()` / `max()` / `sum()` over it |
| What renders the query | `toList()`, `first()`, `firstOrDefault()`, `firstOrThrow()`, `count()`, `exists()`, `min()` / `max()` / `sum()`, LIMIT / OFFSET, DISTINCT, `countOver()`, a window function, `future()` / `futureFirstOrDefault()` / `futureCount()`, `FutureQueryRunner.runAsync()`, `QueryBatch` legs (a list, a first row, a count), `union()` / `unionAll()` legs, `prepare()`, a scalar / array / table subquery (`inSubquery()`, `notInSubquery()`, `exists()`, `notExists()`), a CTE body, the source of `insertFrom()`, a subquery in the WHERE of `update()` / `delete()`, `forUpdate()` (of a required navigation), `crossJoinLateral()`, `joinFilter()`, `with()` |
| Collections | the item's own probe, and collections hanging off a probed path (of the root row and of a collection's item, off the probed hop, a hop before it and a hop beyond it): lists, filtered / ordered / limited lists, an offset, `firstOrDefault()`, DISTINCT, `count()` / `exists()` / `min()` / `max()` / `sum()`, `toStringList()` / `toNumberList()`, a `count()` in a `sql` fragment, `exists()` / `notExists()` / a `count()` in a WHERE, collections nested three deep with a probe at each level, a `selectMany()` of the root row; each under the `lateral`, `cte` and `temptable` strategies |
| Other chains | a collection or a subquery of another row that joins the same alias keeps its plain join |
| Caches | with `MockRowCache.setEnabled(true)` (which also gates `NavigationPathCache` and the `LateralSqlCache`), a probed and a plain shape built in either order each render the text a fresh build renders |
| Planner | PostgreSQL / PGlite, hash joins and nested loops off: a probed target is read through the probe's key lookups only, never scanned under the hop's own alias, where a merge join could read it |
| Typing | every builder keeps its type through `lateralJoin()`, and every one is an `IEntityQueryable` |

`tests/queries/lateral-navigation-join.test.ts` pins the exact SQL of each shape, the refusals and the planner cases.

## Pitfalls

- **Don't** add `lateralJoin()` to a navigation the `where()` filters by (`where(p => gt(p.user!.age, 30))`) → **Do** keep that navigation plain: the plain join lets PostgreSQL start from the matching targets; the probe forces a visit of every row and one probe each.
- **Don't** add `lateralJoin()` to every navigation of a query, or to queries returning thousands of rows → **Do** opt in the one navigation whose plan reads a large target for few rows, and compare `EXPLAIN (ANALYZE, BUFFERS)` with and without it.
- **Don't** expect `lateralJoin(ot => ot.task!.level)` to probe the task hop → **Do** call it once per hop: `.lateralJoin(ot => ot.task).lateralJoin(ot => ot.task!.level)`.
- **Don't** call `lateralJoin()` on a collection after its `select()` (`o.orderTasks!.select(…).lateralJoin(…)` does not compile: `Property 'lateralJoin' does not exist on type 'EntityCollectionQueryWithSelect<…>'`) → **Do** call it before: `o.orderTasks!.lateralJoin(ot => ot.task).select(…)`.
- **Don't** combine it with `update()`, `delete()`, `groupBy()` or `selectMany()`: they throw → **Do** use the plain navigation there, or a correlated scalar subquery for a value in `update()`.
- **Don't** expect a probe in a statement that never joins the navigation: `db.orderTasks.lateralJoin(ot => ot.task).count()` reads nothing of the task and renders the statement without it → **Do** read the plan of the statement that actually reads the navigation.
- **Don't** pass `lateralJoin()` a column or a collection to make a query "lateral" → **Do** use [Collection Strategies](../collection-strategies.md) for `hasMany` data: collections are LATERAL by default already.

## See also

- [Choosing the Right Query](../choosing-the-right-query.md): start here; data need → API → SQL shape → round trips.
- [Collection Strategies](../collection-strategies.md): how `hasMany` collections render (`lateral`, `cte`, `temptable`) and which to pick.
- [Querying](./querying.md): navigations, their join types and aliases, filtering and projecting through them.
- [Subqueries](./subquery-guide.md): correlated scalar subqueries (`asSubquery('scalar')`), the alternative inside `update()` / `delete()`.
- [Batching and Prepared Queries](./batching-and-prepared-queries.md): `QueryBatch`, `future()` and `prepare()`, which keep the probe.
- [Configuration](./configuration.md): `logQueries` to capture the statement for `EXPLAIN`, `MockRowCache`.
