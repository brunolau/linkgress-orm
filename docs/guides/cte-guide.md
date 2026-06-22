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
