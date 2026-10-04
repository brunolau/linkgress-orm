# CTE (Common Table Expression) Guide

This guide demonstrates how to use Common Table Expressions (CTEs) in Linkgress ORM for complex queries with reusable subqueries.

> **Note:** This guide covers the explicit `DbCteBuilder` API for creating custom CTEs in your queries. For information about how Linkgress automatically uses CTEs (or LATERAL joins) for collection navigation properties, see the [Collection Strategies](../collection-strategies.md) documentation.

## What are CTEs?

Common Table Expressions (CTEs) are temporary named result sets that you can reference within a SELECT, INSERT, UPDATE, or DELETE statement. They improve query readability and allow you to break down complex queries into manageable parts.

## Benefits of CTEs

- **Reusability** - Define a query once and reference it multiple times
- **Readability** - Break complex queries into logical, named steps
- **Performance** - PostgreSQL can optimize CTE execution
- **Type Safety** - Linkgress provides full TypeScript type inference for CTE columns

## Basic Usage

### Creating a CTE Builder

```typescript
import { DbCteBuilder } from 'linkgress-orm';

const cteBuilder = new DbCteBuilder();
```

### Creating a Simple CTE

Use the `with()` method to create a CTE from any query:

```typescript
const activeUsersCte = cteBuilder.with(
  'active_users',
  db.users
    .where(u => eq(u.isActive, true))
    .select(u => ({
      userId: u.id,
      username: u.username,
      createdAt: u.createdAt,
    }))
);
```

### Using a CTE in a Query

Attach CTEs to your query with `.with()` and join them like regular tables:

```typescript
const result = await db.users
  .where(u => eq(u.id, 1))
  .with(activeUsersCte.cte)
  .leftJoin(
    activeUsersCte.cte,
    (user, cte) => eq(user.id, cte.userId),
    (user, cte) => ({
      id: user.id,
      username: user.username,
      cteCreatedAt: cte.createdAt, // Access CTE columns!
    })
  )
  .toList();
```

`innerJoin` takes a CTE the same way, after a `select()` or straight off the table
(`db.users.innerJoin(cte, …)`, `db.users.leftJoin(cte, …)`). A joined CTE the query does not carry yet is
attached to its WITH list, as `.with(cte)` would — and one attached already is declared once. (An
`innerJoin` of a CTE, and any join of one straight off the table, used to throw
"rightTable._getSchema is not a function".)

## How a CTE's Columns Read Back

A column of a CTE body reads back — through a join, at a CTE root, in a comparison — the way the body's
own projection reads it:

```typescript
const times = cteBuilder.with('post_times', db.posts.select(p => ({
  postId: p.id,
  time: p.publishTime,                 // a mapped column
  meta: { title: p.title, views: p.views },
  author: p.user,                      // a navigation row
  kind: 'post',                        // a literal
  featured: true,
})));

const rows = await db.posts
  .innerJoin(times.cte,
    (p, t) => and(eq(p.id, t.postId), eq(t.time, { hour: 9, minute: 30 }), eq(t.featured, true)),
    (p, t) => ({ title: p.title, time: t.time, meta: t.meta, author: t.author!.username, kind: t.kind }))
  .toList();
```

- **Mapped columns** read — and compare — through the body column's OWN mapper: `t.time` is
  `{ hour, minute }`, and `eq(t.time, { hour: 9, minute: 30 })` converts the value like a comparison
  with `p.publishTime` would. (A CTE's columns used to carry an expression's `mapWith` and nothing
  else: a mapped column read through a CTE came back as its storage value; one named like a mapped
  column of the READING table went through THAT column's mapper.)
- **Text** stays text (`'01234'` used to read back as `1234`); a numeric column or an aggregate reads as
  a number.
- **Literals** render typed in the body — `CAST($1 AS boolean)`, an `integer` (a `bigint` beyond int4, a
  `double precision` for a fraction), `text`, a `timestamptz` for a `Date`, `jsonb` for a list of
  values — so the reading query compares them as their type (`gt(t.n, 5)` over a literal `42` used to
  compare TEXT and match nothing) and reads them back as their values, a `bigint` as a `bigint`. A
  grouped body's constants and a table subquery's literals render typed too.
- **A nested object or a navigation row** of the body is the object of its flattened columns:
  `t.meta` reads back as `{ title, views }`, `t.meta.views` and `t.author.username` are columns of their
  own, in a selection or a condition. At the type level such a value is one `FieldRef` — it cannot be
  told from a column whose mapped value is an object — so reach into it in a condition with a cast
  (`eq((t.meta as any).title, 'x')`).

A **table subquery** (`query.asSubquery('table')`, joined with an alias) reads its columns the same way.

`withAggregation()` items read through the aggregated query's own mappers (they used to be looked up by
NAME among the reading table's columns), nested objects and navigation rows key by key, literals as
themselves; a grouping key reads through its column's mapper.

## CTEs with Aggregations

Create CTEs that include collection aggregations:

```typescript
const userStatsCte = cteBuilder.with(
  'user_stats',
  db.users.select(u => ({
    userId: u.id,
    username: u.username,
    postCount: u.posts.count(),  // Aggregation works!
    maxViews: u.posts.max(p => p.views),
    totalViews: u.posts.sum(p => p.views),
  }))
);

const result = await db.users
  .with(userStatsCte.cte)
  .leftJoin(
    userStatsCte.cte,
    (user, cte) => eq(user.id, cte.userId),
    (user, cte) => ({
      id: user.id,
      postCount: cte.postCount,  // Type-safe: number
      maxViews: cte.maxViews,    // Type-safe: number | null
    })
  )
  .toList();
```

## Every Query Builder as a CTE Body

`with(name, query)` and `withAggregation(name, query, …)` take every query a statement can run (1.0.29): an
entity query (projected, whole rows, with navigations, carrying a CTE of its own), a grouped query, a union, a
CTE-rooted query — joined or not, `db.selectFromCte(a).where(…).select(…)` — and a set query, context-free or bound
(`fromSet(unnest(names, 'text'), 'n').select(…)`, `db.selectFromSet(unnestZip({…}))`, filtered, ordered, limited;
a union of sets). A set query used to throw `query._createMockRow is not a function`, a CTE-rooted one too. A
CTE-rooted body declares the CTEs it reads inside itself (a data-modifying one is read by name — see
[dependent data-modifying CTEs](#dependent-data-modifying-ctes-and-aftermutation)). The CTE's columns read the
way the body reads them: a set column as the driver delivers it (`'0042'` stays text), a mapped column through
its mapper.

## Grouped / Aggregate CTE Bodies

`with()` also accepts a **grouped** query body — a `.groupBy(...).select(...)` chain
that emits `SUM` / `COUNT` / `MIN` / `MAX` aggregates and a `GROUP BY` clause. The
result is a plain CTE with **one row per group** (this is distinct from
[`withAggregation()`](#aggregation-ctes-with-withaggregation), which folds the whole
group into a single JSONB array column):

```typescript
const spendByStatusCte = cteBuilder.with(
  'spend_by_status',
  db.orders
    .where(o => eq(o.userId, userId))
    .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
    .groupBy(o => ({ status: o.status }))
    .select(g => ({
      status: g.key.status,
      totalPrice: g.sum(o => o.totalPrice),  // SUM(...) aggregate
    }))
);
```

**Generated CTE body:**
```sql
SELECT "orders"."status" as "status",
       CAST(SUM("orders"."total_amount") AS DOUBLE PRECISION) as "totalPrice"
FROM "orders"
WHERE "orders"."user_id" = $1
GROUP BY "orders"."status"
```

The resulting `spendByStatusCte.cte` carries one column per projected alias
(`status`, `totalPrice`) and can be joined like any other CTE — including as the
FROM root of a [CTE-rooted query](#querying-from-a-cte-full-outer--right--cross-joins).

## Aggregation CTEs with `withAggregation()`

Create CTEs that group rows into JSONB arrays:

```typescript
const aggregatedPostsCte = cteBuilder.withAggregation(
  'aggregated_posts',
  db.posts.select(p => ({
    id: p.id,
    title: p.title,
    views: p.views,
    userId: p.userId,
  })),
  p => ({ userId: p.userId }),  // Group by userId
  'posts'  // Aggregation column name
);

const result = await db.users
  .with(aggregatedPostsCte)
  .leftJoin(
    aggregatedPostsCte,
    (user, cte) => eq(user.id, cte.userId),
    (user, cte) => ({
      id: user.id,
      username: user.username,
      posts: cte.posts,  // Type-safe: Array<{ id, title, views, userId }>
    })
  )
  .toList();
```

### Custom Aggregation Column Name

```typescript
const aggregatedCte = cteBuilder.withAggregation(
  'aggregated_orders',
  db.orders.select(o => ({
    orderId: o.id,
    status: o.status,
    totalAmount: o.totalAmount,
    userId: o.userId,
  })),
  o => ({ userId: o.userId }),
  'orderList'  // Custom name instead of default 'items'
);

// Access via cte.orderList
```

### Multiple Grouping Columns

```typescript
const aggregatedCte = cteBuilder.withAggregation(
  'grouped_data',
  db.posts.select(p => ({
    postId: p.id,
    title: p.title,
    userId: p.userId,
    status: p.status,
  })),
  p => ({
    userId: p.userId,
    status: p.status,  // Group by multiple columns
  }),
  'items'
);
```

## Multiple CTEs

Use multiple CTEs in a single query:

```typescript
const cteBuilder = new DbCteBuilder();

// Create first CTE
const userStatsCte = cteBuilder.with(
  'user_stats',
  db.users.select(u => ({
    userId: u.id,
    postCount: u.posts.count(),
  }))
);

// Create second CTE
const orderStatsCte = cteBuilder.with(
  'order_stats',
  db.users.select(u => ({
    userId: u.id,
    orderCount: u.orders.count(),
    totalSpent: u.orders.sum(o => o.totalAmount),
  }))
);

// Use both CTEs
const result = await db.users
  .with(...cteBuilder.getCtes())  // Spread all CTEs
  .leftJoin(
    userStatsCte.cte,
    (user, cte) => eq(user.id, cte.userId),
    (user, cte) => ({
      id: user.id,
      postCount: cte.postCount,
    })
  )
  .toList();
```

### Combining CTEs from Multiple Builders

```typescript
const builder1 = new DbCteBuilder();
const cte1 = builder1.with('cte1', query1);

const builder2 = new DbCteBuilder();
const cte2 = builder2.with('cte2', query2);

// Combine CTEs from both builders
const result = await db.users
  .with(...builder1.getCtes(), ...builder2.getCtes())
  .leftJoin(cte1.cte, ...)
  .leftJoin(cte2.cte, ...)
  .toList();
```

A builder numbers its CTEs' parameters as one block (`$1` for the first body, `$2`… after it). Each `DbCte`
remembers where its body starts (`paramBase`), and every statement renumbers each body from where **its**
parameters land: CTEs of several builders, a builder's second CTE on its own, or its CTEs in another order all
bind their own values. (Before 1.0.9 a builder's second CTE used without the first kept `$2`, and bound the next
value of the statement.)

## Querying from a CTE (FULL OUTER / RIGHT / CROSS joins)

The examples above attach a CTE to an **entity-rooted** query
(`db.users.with(cte).leftJoin(cte, …)`) — there the FROM root must be a real table
and joins are `INNER` / `LEFT` only.

When the FROM root should itself be a CTE — and when you need join flavours the
entity path cannot express (`FULL OUTER`, `RIGHT`, `CROSS`, or an `ON TRUE`
predicate) — start the query with `db.selectFromCte(rootCte)`:

```typescript
const rows = await db
  .selectFromCte(spend.cte)
  .fullOuterJoin(tier.cte, onTrue())
  .select((s, t) => ({
    status: s.status,
    totalPrice: s.totalPrice,
    currentTierId: t.currentTierId,
  }))
  .toList();
```

### Join methods

A CTE-rooted query exposes the full set of SQL join flavours, because both sides are
already materialized relations (the CTE bodies):

| Method | SQL |
| --- | --- |
| `.innerJoin(cte, condition)` | `INNER JOIN … ON …` |
| `.leftJoin(cte, condition)` | `LEFT JOIN … ON …` |
| `.rightJoin(cte, condition)` | `RIGHT JOIN … ON …` |
| `.fullOuterJoin(cte, condition)` | `FULL OUTER JOIN … ON …` |
| `.crossJoin(cte)` | `CROSS JOIN …` (no `ON`) |

After joining, call `.select((root, joined) => ({ … }))` — the selector receives one
FieldRef proxy per source, in FROM order (root first, then each joined CTE). You can
also `.select(root => ({ … }))` with no join to project the root CTE directly.
`.orderBy(...)`, `.limit(n)`, `.offset(n)`, `.toList()` and `.first()` round out the
query (`orderBy` matches the column **output aliases**, e.g. `r => [[r.status, 'DESC']]`).

The projection takes what a table's `select()` takes, and each value reads back as
[a CTE's columns read back](#how-a-ctes-columns-read-back):

```typescript
db.selectFromCte(times.cte).select(t => ({
  postId: t.postId,
  kind: 'post',                                   // a string is a value, not a column name
  meta: { time: t.time, loud: sql<string>`upper(${t.meta.title})` },   // flattened, rebuilt
  comments: db.postComments.where(c => eq(c.postId, t.postId)).select(() => ({ n: sql<number>`count(*)` })).asSubquery('scalar'),
}));

db.selectFromCte(times.cte).select(t => t.postId).orderBy(id => id).toList();   // number[]
```

A selector returning one value (a column, an expression, a literal) reads as the list of that value, and
`orderBy` orders by it. As a `table` subquery (`.asSubquery('table')`) the projection's literals render
typed for the enclosing query. An array of columns is refused. (A string used to render as a column of
that NAME, a nested object and a subquery were bound as parameters, and a one-value selector projected
the ref's own keys.)

### Filtering: `where()`

`.where(predicate)` filters a CTE-rooted query. The predicate receives one column ref per source, in FROM
order — the root CTE's row, then each joined CTE's — and renders as `WHERE <condition>` after the FROM and its
joins, before the ORDER BY. Repeated calls combine with AND; its parameters follow the CTE bodies' and the ON
predicates'. `where()` and `select()` can be called in either order.

```typescript
db.selectFromCte(older.cte)
  .where(r => gt(r.age, 32))
  .where(r => lt(r.age, 100))
  .select(r => ({ id: r.id }))
  .orderBy(r => [[r.id, 'DESC']]);
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age" FROM "users" WHERE "users"."age" > $1)
SELECT "older_users"."id" as "id"
FROM "older_users"
WHERE ("older_users"."age" > $2 AND "older_users"."age" < $3)
ORDER BY "id" DESC
-- params: [31, 32, 100]
```

A ref of any other query correlates: nested as a subquery (`.asSubquery(...)`), the query renders in the
enclosing statement's parameter sequence and reports the correlation, so the enclosing query joins the
navigations it reads:

```typescript
db.posts
  .with(older.cte)
  .select(p => ({
    title: p.title,
    authorOlderAge: db.selectFromCte(older.cte).where(r => eq(r.id, p.user!.id)).select(r => r.age).asSubquery('scalar'),
  }));
```

### Aliasing the root: `selectFromCte(cte, alias)`

`db.selectFromCte(cte, 'o')` renders `FROM "<cte>" AS "o"`; the root row's columns render `"o"."<column>"`.
A CTE-rooted subquery correlated to an enclosing query over the **same** CTE — another `selectFromCte(cte)`, or
an entity query that joined the CTE — needs it: both rows would otherwise be named after the CTE, and inside the
subquery the name reads its own row (`"older_users"."age" > "older_users"."age"`, true for every row). Such a
correlation is refused (`… Give one of them a distinct alias: selectFromCte(cte, '<alias>')`):

```typescript
db.selectFromCte(older.cte).select(o => ({
  id: o.id,
  olderCount: db.selectFromCte(older.cte, 'other')
    .where(r => gt(r.age, o.age))
    .select(() => sql<number>`count(*)`.mapWith(Number))
    .asSubquery('scalar'),
}));
// … (SELECT count(*) as "value" FROM "older_users" AS "other" WHERE "other"."age" > "older_users"."age") …
```

The rows of a CTE-rooted query carry its identity: an entity query nested in its `where()` reads them as
correlations, also when the CTE is named like one of that query's navigations (a CTE named `user` read by a
`db.posts` query that has a `user` navigation).

### UNION of CTE-rooted queries

`db.selectFromCte(a).select(…).unionAll(…)` / `.union(…)` (1.0.29): a CTE-rooted query is a union leg — beside
other CTE-rooted queries, entity queries and set queries projecting the same columns. Every leg's CTEs are
declared ONCE at the top of the statement (a data-modifying one after the CTEs it reads), every leg reads them by
name, and the union reads each row the way its FIRST leg's projection does: a column through its own mapper, a
text column's `'0042'` as text, a literal — a leg's tag — from the row. The union is a `UnionQueryBuilder`:
`orderBy()`, `limit()`, `count()`, `firstOrDefault()`, `asSubquery()` and a CTE body (`with(name, union)`).

### The `onTrue()` helper and `ON TRUE`

PostgreSQL requires an `ON` / `USING` clause on a `FULL OUTER JOIN` (a bare one is a
syntax error). Use the exported `onTrue()` helper for the cross-product
(`ON TRUE`) form that keeps **every** row of both sides while pairing them up:

```typescript
import { onTrue } from 'linkgress-orm';

db.selectFromCte(spend.cte)
  .fullOuterJoin(tier.cte, onTrue())   // … FULL OUTER JOIN "current_tier" ON TRUE
  .select((s, t) => ({ /* … */ }));
```

`onTrue()` simply renders the constant predicate `TRUE`; it can be passed to any of
the joins that take a condition.


`onFalse()` (1.0.29) renders a literal `FALSE`: `FULL OUTER JOIN … ON FALSE` keeps every row of both sides and
pairs none — two relations side by side. A FULL JOIN is planned only on merge- or hash-joinable conditions: an
equality between the two sides (beside which any other condition is fine), or constants. `IS NOT DISTINCT FROM`,
an inequality, an OR or a condition on one side alone raise 0A000 "FULL JOIN is only supported with merge-joinable
or hash-joinable join conditions" — on PostgreSQL and, since 1.0.29, in the in-memory database.

### Worked example: buyer spend + current tier

A complete, copy-pasteable example. Two CTEs are defined with the builder — a
**grouped** `spend` total (one row per order status) and a single-row `current_tier`
— then joined with `FULL OUTER JOIN … ON TRUE` so the result is preserved in all four
cases: both sides present, spend-only (tier `NULL`), tier-only (spend `NULL`), or
neither (zero rows).

```typescript
import { DbCteBuilder, eq, and, onTrue } from 'linkgress-orm';

const cteBuilder = new DbCteBuilder();

const spend = cteBuilder.with(
  'spend',
  db.orders
    .where(o => and(eq(o.userId, userId), eq(o.status, 'completed')))
    .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
    .groupBy(o => ({ status: o.status }))
    .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) }))
);

const tier = cteBuilder.with(
  'current_tier',
  db.users
    .where(u => and(eq(u.id, userId), eq(u.isActive, true)))
    .select(u => ({ currentTierId: u.id }))
    .limit(1)
);

const rows = await db
  .selectFromCte(spend.cte)
  .fullOuterJoin(tier.cte, onTrue())
  .select((s, t) => ({
    status: s.status,            // string | null
    totalPrice: s.totalPrice,    // number | null
    currentTierId: t.currentTierId, // number | null
  }))
  .toList();
```

**Generated SQL:**
```sql
WITH "spend" AS (
  SELECT "orders"."status" as "status",
         CAST(SUM("orders"."total_amount") AS DOUBLE PRECISION) as "totalPrice"
  FROM "orders"
  WHERE ("orders"."user_id" = $1 AND "orders"."status" = $2)
  GROUP BY "orders"."status"
), "current_tier" AS (
  SELECT "users"."id" as "currentTierId"
  FROM "users"
  WHERE ("users"."id" = $3 AND "users"."is_active" = $4)
  LIMIT 1
)
SELECT "spend"."status" as "status",
       "spend"."totalPrice" as "totalPrice",
       "current_tier"."currentTierId" as "currentTierId"
FROM "spend"
FULL OUTER JOIN "current_tier" ON TRUE
```

`-- params: [userId, 'completed', userId, true]`

Every CTE body's parameters are emitted first, in `WITH` declaration order (root CTE,
then each joined CTE), followed by any `ON`-predicate parameters — so the whole
statement keeps a single, sequential `$1..$n` numbering.

> **Tip:** Call `.toSql()` (or `.buildQuery()` for `{ sql, params }`) on a CTE-rooted
> query to inspect the generated SQL without executing it.

## CTEs Read from Nested Subqueries (statement-level declaration)

A CTE attached to the executing query with `.with(cte)` — or the CTEs of a CTE-rooted query — is declared
**once**, in the statement's `WITH`. Every nested build of that statement reads it **by name**: its WHERE, its
projected subqueries and fragments, its ORDER BY expressions, its collections, a UNION leg, a subquery nested
inside a subquery, a nested query that attaches the same CTE again. The body is not declared again and its
parameters are bound once.

```typescript
const older = new DbCteBuilder().with(
  'older_users',
  db.users.where(u => gt(u.age, 31)).select(u => ({ id: u.id, age: u.age }))
);

await db.users
  .where(u => inSubquery(u.id, db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array')))
  .with(older.cte)
  .select(u => ({
    name: u.username,
    olderAge: db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar'),
  }))
  .toList();
```

```sql
WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age" FROM "users" WHERE "users"."age" > $1)
SELECT "users"."username" as "name",
       (SELECT "older_users"."age" as "value" FROM "older_users" WHERE "older_users"."id" = "users"."id") as "olderAge"
FROM "users"
WHERE "users"."id" IN (SELECT "older_users"."id" as "id" FROM "older_users")
-- params: [31]
```

Before 1.0.9 every nested `selectFromCte(...)` re-declared the CTE inside its parentheses —
`IN (WITH "older_users" AS (… $2) SELECT …)` — and bound its body's parameters again.

A subquery that attaches a CTE the executing statement does **not** declare still declares it inside itself,
as `(WITH "cte" AS (…) SELECT …)`; the body's parameters are numbered after those the statement bound before
it. A subquery whose CTEs are only partly declared by the statement reads those from there and declares the
rest itself (a CTE-rooted subquery used to refuse that).

The statement's CTEs are matched by **content**, not by name: a nested query that attaches a CTE that is
**different** under a name the statement declares is refused — `The CTE "<name>" a nested query attaches is not
the CTE "<name>" its statement declares …` — because inside the statement that name reads the statement's CTE
(the nested query used to read the other one's rows silently). "Different" means different by content: the
same definition built twice — by a factory called for the statement and again for a nested query, also from
builders at other parameter offsets — is the same CTE when its body (numbered from `$1`), its `MATERIALIZED`
flag and its parameters **by value** are equal (a `Date` by its time, a `Buffer` / typed array by its bytes, an
array element by element, a JSON document by its JSON text; any other object only as the same instance). The
same rule decides whether two UNION legs attach one CTE. A data-modifying CTE (`withMutation`) is one execution
of its statement: it is the same only as the same `DbCte` instance.

`min()`, `max()` and `sum()` declare the query's `.with()` CTEs too (they used to drop them: a join to a CTE
met `relation "<cte>" does not exist`), as `count()`, `exists()` and `toList()` do.

## Data-Modifying CTEs: `withMutation()`

`DbCteBuilder.withMutation(name, statement)` attaches a compiled `UPDATE` / `DELETE` / `INSERT` — `.toStatement(selector)`
on an update, a delete, or an `insert(...)` / `insertBulk(...)` — as a data-modifying CTE. The selector is the statement's `RETURNING` list, and it
types the CTE's columns:

```typescript
const gate = new DbCteBuilder().withMutation(
  'gate',
  db.users
    .where(u => and(eq(u.id, userId), lt(u.age, 30)))     // a compare-and-set: the UPDATE matches 0 or 1 row
    .update(u => ({ age: add(u.age, 1) }))
    .toStatement(u => ({ id: u.id, age: u.age }))          // CompiledStatement<{ id: number; age: number }>
);

const rows = await db.users
  .where(u => inSubquery(u.id, db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery('array')))
  .with(gate.cte)
  .select(u => ({
    id: u.id,
    loadedAge: u.age,                                                                  // the pre-update snapshot
    newAge: db.selectFromCte(gate.cte).select(g => ({ age: g.age })).asSubquery('scalar'),   // RETURNING
  }))
  .toList();
```

```sql
WITH "gate" AS (UPDATE "users" SET "age" = ("users"."age" + $1) WHERE ("users"."id" = $2 AND "users"."age" < $3) RETURNING "id" AS "id", "age" AS "age")
SELECT "users"."id" as "id", "users"."age" as "loadedAge", (SELECT "gate"."age" as "age" FROM "gate") as "newAge"
FROM "users"
WHERE "users"."id" IN (SELECT "gate"."id" as "id" FROM "gate")
```

The UPDATE runs **once**, whatever number of places read the CTE; when the compare-and-set loses, the gate is
empty and so is the load.

- `toStatement(selector)` returns a `CompiledStatement<TRow>` — `{ sql, params }` typed by the RETURNING row.
  `withMutation(name, statement)` returns `{ cte: DbCte<TRow> }`, so
  `db.selectFromCte(gate.cte).select(g => ({ id: g.id }))` is typed — and each column reads the way its RETURNING
  value does: a text column stays text (`'0042'`), a column with a custom mapper reads through it, an expression
  as an expression. (The compiled statement carries its RETURNING selection as a non-enumerable property; a
  hand-written `{ sql, params }` has none, and its columns read like expressions.) The
  `withMutation(name, statement, columns)` overload keeps working.
- The `'temptable'` collection strategy runs a query's collections as statements of their own, after the
  statement that executes the mutation: a temp-table collection that READS the data-modifying CTE (through a
  `selectFromCte(…)` subquery, in its WHERE, its item or a collection nested in it) is refused before anything
  runs. Use the `'cte'` or `'lateral'` strategy for such a query (the UPDATE then runs once, in the one
  statement). Temp-table collections that never read the CTE run as before: the UPDATE runs once, in the base
  statement. (A raw `sql` fragment naming the CTE in such a collection is not recognised as a read: that
  statement fails with `relation "<cte>" does not exist`, after the base statement has run, as it did before.)
- **A data-modifying CTE is declared at statement level only**: attach it with `.with()` on the executing
  query. Declared inside a nested subquery — a `selectFromCte(gate.cte)…asSubquery()` in a query that does not
  carry it, a subquery that carries it itself — it is refused:
  `CTE "gate" is data-modifying: a data-modifying CTE must be declared at statement level — attach it with
  .with() on the executing query`. (PostgreSQL rejects a data-modifying `WITH` nested in a subquery; before
  1.0.9 the query builder emitted one per reading subquery, i.e. one UPDATE per occurrence.) An `insertFrom()`
  declares it through its `with` option — `insertFrom(source, map, { with: [ins.cte] })`, see
  [the insert guide](./insert-update-guide.md#one-statement-a-bulk-insert-feeding-another-insert).
- A body that executes nowhere itself — a CTE's (`with()`, `withAggregation()`) or a compiled statement
  (`toStatement()`) — reads a data-modifying CTE by NAME instead, and every statement that declares the CTE
  built over it declares that one first (1.0.29, next section).

## Dependent Data-Modifying CTEs and `afterMutation()`

A data-modifying statement compiled with `toStatement()` may read data-modifying CTEs created before it —
through its source, its WHERE, a subquery of its values. It reads them by name, the CTE `withMutation()` makes of
it records them (`DbCte.dependencies`), and every statement that declares that CTE declares them FIRST, each once
— whichever of them it reads, in whatever order its `.with()` lists them. A plain CTE whose body reads one
(`with(name, db.selectFromCte(closed.cte)…)`) works the same way.

**Order is not implied.** PostgreSQL runs the sub-statements of a WITH on ONE snapshot and in no order it
promises: a data-modifying CTE runs when the main query first reads it, the rest after the main query. They
cannot see each other's writes — RETURNING is the only way to pass rows on. A unique index over a SCOPE (one
current lease per unit) therefore sees a successor inserted BEFORE the close of its predecessor whenever the
main query reads the open leg first: 23505 — or, with `ON CONFLICT DO NOTHING`, the open silently skipped and the
unit left with no current lease. `afterMutation(cte)` orders the statement after `cte`: the condition
`((SELECT count(*) FROM "<cte>") >= 0)` holds only once `cte` has run to completion, so the statement yields no
row before (PostgreSQL plans it as a one-time filter evaluated before the first row; an `exists()` over the CTE
is no barrier — it stops at the first row).

```typescript
const builder = new DbCteBuilder();
const closed = builder.withMutation('closed', db.leases
  .where(l => and(eqAny(l.unitId, units), eq(l.isCurrent, true),
    notExists(fromRows(db.leases, desired, { columns: ['unitId', 'tenantId'], alias: 'd' })
      .where(d => and(eq(d.unitId, l.unitId), eq(d.tenantId, l.tenantId))).select(() => ({ one: literal(1) })).asSubquery())))
  .update({ validTo: now, isCurrent: false })
  .toStatement(l => ({ id: l.id, unitId: l.unitId })));

const opened = builder.withMutation('opened', db.leases.insertFrom(
  fromRows(db.leases, desired, { columns: ['unitId', 'tenantId'], alias: 'd' })
    .where(d => notExists(db.leases.where(c => and(eq(c.unitId, d.unitId), eq(c.tenantId, d.tenantId), eq(c.isCurrent, true)))
      .select(c => ({ id: c.id })).asSubquery()))
    .asSubquery('table'),
  src => ({ unitId: src.unitId, tenantId: src.tenantId, validFrom: now, isCurrent: true }),
  { where: () => afterMutation(closed.cte), onConflictDoNothing: true },
).toStatement(l => ({ id: l.id, unitId: l.unitId })));

// ONE statement: both legs, read back tagged — the close leg declared first
const rows = await db.selectFromCte(opened.cte).select(r => ({ leg: 'opened', id: r.id, unitId: r.unitId }))
  .unionAll(db.selectFromCte(closed.cte).select(r => ({ leg: 'closed', id: r.id, unitId: r.unitId })))
  .toList();
```

```sql
WITH "closed" AS (UPDATE "leases" SET … WHERE … RETURNING "id" AS "id", "unit_id" AS "unitId"),
     "opened" AS (INSERT INTO "leases" (…) SELECT … FROM (…) AS "src"
                  WHERE ((SELECT count(*) FROM "closed") >= 0) ON CONFLICT DO NOTHING RETURNING …)
(SELECT CAST($n AS text) as "leg", "opened"."id" as "id", … FROM "opened")
UNION ALL
(SELECT CAST($m AS text) as "leg", "closed"."id" as "id", … FROM "closed")
```

- The barrier orders what the statement WRITES, not what it SEES: the open leg's `notExists` still reads the
  snapshot the statement started with, where the row the close leg retires is current. Decide what to close and
  what to open on disjoint keys (as above), never on "is there a current row in the scope".
- Read several legs back with a UNION of CTE-rooted queries (next sections), never with a FULL JOIN on a null-safe
  key: PostgreSQL plans a FULL JOIN only on merge- or hash-joinable conditions (0A000).
- A statement that reads a data-modifying CTE it does not declare (and is no CTE body) is refused as before; so
  is `afterMutation()` there, and `afterMutation()` of a plain CTE. Two different CTEs under one name in one
  statement are refused.
- The in-memory database runs CTEs in the order the main query first reads them, as PostgreSQL does: a test
  that reads the open leg first exercises the dangerous order on both engines.

## Type Safety

Linkgress provides full TypeScript type inference for CTE columns:

```typescript
const typedCte = cteBuilder.with(
  'typed_cte',
  db.users.select(u => ({
    userId: u.id,      // number
    username: u.username,  // string
    email: u.email,    // string
    isActive: u.isActive,  // boolean
  }))
);

const result = await db.users
  .with(typedCte.cte)
  .leftJoin(
    typedCte.cte,
    (user, cte) => {
      // TypeScript knows all column types:
      const id: number = cte.userId;  // ✓
      const name: string = cte.username;  // ✓
      return eq(user.id, cte.userId);
    },
    (user, cte) => ({
      id: user.id,
      cteUsername: cte.username,  // Autocomplete works!
      cteEmail: cte.email,
      cteIsActive: cte.isActive,
    })
  )
  .toList();

// Result type is automatically inferred:
// Array<{
//   id: number;
//   cteUsername: string;
//   cteEmail: string;
//   cteIsActive: boolean;
// }>
```

## CTE Builder Management

### Get All CTEs

```typescript
const allCtes = cteBuilder.getCtes();
console.log(allCtes.length);  // Number of CTEs
```

### Clear the Builder

```typescript
cteBuilder.clear();  // Remove all CTEs
```

### Reuse the Builder

```typescript
const cteBuilder = new DbCteBuilder();

// First query
cteBuilder.with('cte1', query1);
await db.users.with(...cteBuilder.getCtes()).toList();

// Clear and reuse
cteBuilder.clear();

// Second query
cteBuilder.with('cte2', query2);
await db.posts.with(...cteBuilder.getCtes()).toList();
```

## Generated SQL

CTEs generate optimized SQL with the `WITH` clause:

```typescript
const cte = cteBuilder.with(
  'active_users',
  db.users
    .where(u => eq(u.isActive, true))
    .select(u => ({ userId: u.id, username: u.username }))
);

const result = await db.users
  .with(cte.cte)
  .leftJoin(cte.cte, ...)
  .toList();
```

**Generated SQL:**
```sql
WITH "active_users" AS (
  SELECT "users"."id" as "userId", "users"."username" as "username"
  FROM "users"
  WHERE "users"."is_active" = $1
)
SELECT ...
FROM "users"
LEFT JOIN "active_users" ON ...
```

## Common Patterns

### 1. Filter Once, Use Multiple Times

```typescript
const expensiveFilterCte = cteBuilder.with(
  'filtered_data',
  db.posts
    .where(p => and(
      gt(p.views, 1000),
      like(p.title, '%important%')
    ))
    .select(p => ({ postId: p.id, title: p.title }))
);

// Use the filtered data multiple times in different parts of the query
```

### 2. Pre-aggregate Data

```typescript
const statsCte = cteBuilder.with(
  'stats',
  db.users.select(u => ({
    userId: u.id,
    totalPosts: u.posts.count(),
    totalOrders: u.orders.count(),
    avgOrderAmount: u.orders.avg(o => o.totalAmount),
  }))
);

// Join with pre-aggregated statistics
```

### 3. Hierarchical Queries

```typescript
const parentCte = cteBuilder.with(
  'parents',
  db.categories
    .where(c => isNull(c.parentId))
    .select(c => ({ catId: c.id, name: c.name }))
);

const childrenCte = cteBuilder.with(
  'children',
  db.categories
    .select(c => ({
      catId: c.id,
      name: c.name,
      parentId: c.parentId,
    }))
);

// Join hierarchical data
```

## Best Practices

1. **Name CTEs Descriptively** - Use clear, meaningful names
2. **Keep CTEs Focused** - Each CTE should have a single purpose
3. **Reuse the Builder** - Create one builder and add multiple CTEs
4. **Clear After Use** - Clear the builder between unrelated queries
5. **Type Your Selections** - Explicit selections improve type safety

## Performance Considerations

- **PostgreSQL Optimization** - PostgreSQL can optimize CTE execution
- **Materialization** - CTEs are materialized once, not re-executed
- **Index Usage** - Ensure indexed columns are used in CTE joins
- **CTE vs Subqueries** - CTEs are clearer but may have different optimization

## Limitations

- CTEs must be defined before being referenced
- CTE names must be unique within a query
- Recursive CTEs are not yet supported (coming soon)

## Examples

See [tests/queries/cte.test.ts](../../tests/queries/cte.test.ts) for comprehensive examples including:
- Basic CTE creation and joining
- Aggregation CTEs
- Multiple CTEs
- Type safety verification
- Edge cases and error handling

## Next Steps

- **[Subquery Guide](./subquery-guide.md)** - Compare CTEs with subqueries
- **[Querying Guide](./querying.md)** - Advanced query techniques
- **[API Reference](../api/api-reference.md)** - Complete API documentation
