# Collection Strategies

This document explains the collection strategy pattern implemented in Linkgress ORM for handling navigation property queries.

## Overview

Linkgress ORM supports three strategies for loading collection navigation properties (one-to-many relationships):

1. **LATERAL Strategy** (default, recommended) - Uses `LEFT JOIN LATERAL` subqueries for per-row correlation
2. **CTE Strategy** - Uses CTEs with JSONB aggregation in a single query
3. **Temp Table Strategy** (experimental) - Uses PostgreSQL temporary tables with optimized execution

**Strategy Selection Guide:**
- **LATERAL** (`'lateral'`): Default. Correctly applies LIMIT/OFFSET per parent row. Best for "top N per parent" queries and general use.
- **CTE** (`'cte'`): Single query with GROUP BY. Slightly simpler SQL but LIMIT/OFFSET applies globally, not per parent.
- **Temp Table** (`'temptable'`): Experimental. Only for very large datasets (>100k rows) with benchmarked performance gains.

All strategies produce **identical results** for basic queries, but LATERAL handles LIMIT/OFFSET differently (correctly per-parent). You can configure the strategy globally at the database level or override it per-query using `withQueryOptions()`.

## Usage

### Global Configuration

Configure the strategy when creating your database context:

```typescript
import { AppDatabase } from './database';
import { PostgresClient } from 'linkgress-orm';

const client = new PostgresClient('postgres://user:pass@localhost/db');

// Option 1: Use LATERAL strategy (default, recommended)
const db = new AppDatabase(client, {
  collectionStrategy: 'lateral'  // Optional - this is the default
});

// Option 2: Use CTE strategy
const db = new AppDatabase(client, {
  collectionStrategy: 'cte'  // Single query with GROUP BY
});

// Option 3: Use temp table strategy globally (experimental - only for very large datasets)
const db = new AppDatabase(client, {
  collectionStrategy: 'temptable'  // ⚠️ Experimental: requires manual parameter escaping
});
```

### Per-Query Override with `withQueryOptions()`

You can override the collection strategy for specific queries using `withQueryOptions()`:

```typescript
// Database configured with LATERAL strategy (default)
const db = new AppDatabase(client, {
  collectionStrategy: 'lateral'
});

// Override to use CTE strategy for this specific query
const users = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      views: p.views
    })).toList('posts')
  }))
  .toList();

// This query uses the global LATERAL strategy
const otherUsers = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({ title: p.title })).toList('posts')
  }))
  .toList();
```

You can also enable query logging per-query:

```typescript
const users = await db.users
  .withQueryOptions({
    logQueries: true,
    logParameters: true,
    collectionStrategy: 'temptable'
  })
  .select(u => ({
    id: u.id,
    posts: u.posts!.select(p => ({ title: p.title })).toList('posts')
  }))
  .toList();
```

### CTE Strategy (Default)

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      views: p.views
    })).toList('posts')
  }))
  .toList();
```

**SQL Pattern:**
```sql
WITH "cte_0" AS (
  SELECT
    "user_id" as parent_id,
    jsonb_agg(
      jsonb_build_object('title', "title", 'views', "views")
      ORDER BY "views" DESC
    ) as data
  FROM "posts"
  GROUP BY "user_id"
)
SELECT
  "users"."id",
  "users"."username",
  COALESCE("cte_0".data, '[]'::jsonb) as "posts"
FROM "users"
LEFT JOIN "cte_0" ON "users"."id" = "cte_0".parent_id
```

### LATERAL Strategy

The LATERAL strategy uses `LEFT JOIN LATERAL` to fetch related records for each parent row. This is the **only strategy that correctly applies LIMIT/OFFSET per parent**.

```typescript
// Get top 3 posts per user
const users = await db.users
  .withQueryOptions({ collectionStrategy: 'lateral' })
  .select(u => ({
    id: u.id,
    username: u.username,
    topPosts: u.posts!.select(p => ({
      title: p.title,
      views: p.views
    }))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(3)
      .toList('topPosts')
  }))
  .toList();
```

**SQL Pattern:**
```sql
SELECT
  "users"."id",
  "users"."username",
  COALESCE("lateral_0".data, '[]'::jsonb) as "topPosts"
FROM "users"
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('title', "title", 'views', "views")
  ) as data
  FROM (
    SELECT "title", "views"
    FROM "posts"
    WHERE "posts"."user_id" = "users"."id"
    ORDER BY "views" DESC
    LIMIT 3
  ) sub
) "lateral_0" ON true
```

**Key difference from CTE:** The LATERAL subquery references `"users"."id"` from the outer query, enabling per-row correlation. The LIMIT is applied within the subquery, so each user gets their top 3 posts.

### Temp Table Strategy

```typescript
const users = await db.users
  .withQueryOptions({ collectionStrategy: 'temptable' })
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      views: p.views
    })).toList('posts')
  }))
  .toList();
```

**SQL Pattern (with multi-statement optimization):**

When using `PostgresClient` (postgres.js library), the temp table strategy can execute everything in a **single roundtrip** (experimental - requires manual parameter escaping):

```sql
-- All statements executed in one round trip
CREATE TEMP TABLE tmp_base_0 AS
  SELECT "users"."id" as "__pk_id", "users"."id" as "id", "users"."username" as "username"
  FROM "users";

SELECT * FROM tmp_base_0;

SELECT "user_id" as parent_id, "id" as "id", "title" as "title", "views" as "views"
FROM "posts"
WHERE "user_id" IN (SELECT "__pk_id" FROM tmp_base_0)
ORDER BY "views" DESC;

DROP TABLE IF EXISTS tmp_base_0;
```

**Performance Impact:**
- PostgresClient: 1 round trip per collection (60-70% faster than legacy mode)
- Reduces latency from ~5ms to ~2ms for single collection queries
- With 3 collections: reduces from ~13ms to ~4ms

**SQL Pattern (legacy mode with prepared statements):**

When using `PgClient` (pg library) - uses safe prepared statements with multiple round trips:

```sql
-- Round trip 1: Get parent IDs
SELECT "id", "username" FROM "users"

-- Round trip 2: Multiple statements for collection aggregation
CREATE TEMP TABLE tmp_parent_ids_0 (id integer PRIMARY KEY);
INSERT INTO tmp_parent_ids_0 VALUES (1),(2),(3);

CREATE TEMP TABLE tmp_parent_ids_0_agg AS
SELECT
  t."user_id" as parent_id,
  jsonb_agg(
    jsonb_build_object('title', t."title", 'views', t."views")
    ORDER BY t."views" DESC
  ) as data
FROM "posts" t
WHERE t."user_id" IN (SELECT id FROM tmp_parent_ids_0)
GROUP BY t."user_id";

SELECT parent_id, data FROM "tmp_parent_ids_0_agg";
DROP TABLE IF EXISTS tmp_parent_ids_0, tmp_parent_ids_0_agg;
```

## When to Use Each Strategy

### LATERAL Strategy (Default, Recommended)

**Pros:**
- ✅ **Default and recommended for most use cases**
- ✅ **Correctly applies LIMIT/OFFSET per parent row** (the only strategy that does this)
- ✅ Single query execution
- ✅ Uses PostgreSQL's native prepared statements (safe parameter binding)
- ✅ Natural support for correlated subqueries
- ✅ Production-ready and thoroughly vetted

**Cons:**
- ❌ May be slightly slower than CTE for simple queries without LIMIT
- ❌ Query plan depends on indexes (ensure foreign keys are indexed)
- ❌ Slightly more complex generated SQL

**Best for:**
- **Most applications (recommended default)**
- **"Top N per parent" queries** (e.g., "top 5 posts per user", "latest 3 orders per customer")
- Queries with `.limit()` or `.offset()` on collections
- When you need per-row subquery correlation

### CTE Strategy

**Pros:**
- ✅ Single query execution
- ✅ No temp table management overhead
- ✅ Works well for moderate data sizes
- ✅ Simpler query plan
- ✅ Uses PostgreSQL's native prepared statements (safe parameter binding)
- ✅ Production-ready

**Cons:**
- ❌ Can be slower for very large datasets (>100k rows)
- ❌ Higher memory usage for large result sets
- ❌ LIMIT/OFFSET applies globally, not per parent row

**Best for:**
- Simple aggregations without LIMIT/OFFSET on collections
- When you prefer simpler generated SQL
- Moderate-sized datasets (< 100k rows)

### Temp Table Strategy (Experimental)

**⚠️ Experimental Notice:** This strategy requires manual parameter escaping due to PostgreSQL's multi-statement execution design. Use only when JSONB performance is insufficient for your specific large dataset scenario.

**Pros:**
- ✅ Better performance for very large datasets (>100k rows)
- ✅ Indexed temp table JOIN can be faster
- ✅ More control over query execution
- ✅ Lower memory usage per operation
- ✅ **Single roundtrip** when using `PostgresClient` with multi-statement optimization

**Cons:**
- ❌ **Experimental status - requires manual parameter escaping**
- ❌ Requires multiple round trips when using `PgClient` (pg library)
- ❌ Temp table creation overhead
- ❌ More complex execution flow
- ❌ Not recommended for general use

**Best for:**
- Very large datasets (> 100k rows) where benchmarked
- Data warehouse scenarios with proven performance needs
- When using `PostgresClient` for maximum performance
- **Only after verifying JSONB strategy is insufficient**

## Supported Features

All three strategies support **all collection operations**:

### Collection Queries
```typescript
// Select fields from collection
u.posts.select(p => ({ title: p.title, views: p.views })).toList()
```

### Filtering
```typescript
// Filter collection items
u.posts.where(p => gt(p.views, 100)).select(p => ({ title: p.title })).toList()
```

### Ordering
```typescript
// Order collection items
u.posts.select(p => ({ title: p.title })).orderBy(p => [[p.views, 'DESC']]).toList()
```

### Pagination
```typescript
// Limit and offset
u.posts.select(p => ({ title: p.title })).orderBy(p => p.views).limit(10).offset(5).toList()
```

### Aggregations
```typescript
// Count
u.posts.count()

// Min/Max/Sum
u.posts.max(p => p.views)
u.posts.min(p => p.views)
u.posts.sum(p => p.views)
```

### Array Aggregations
```typescript
// To array of strings
u.posts.select(p => p.title).toStringList()

// To array of numbers
u.posts.select(p => p.views).toNumberList()
```

### DISTINCT
```typescript
// Distinct values
u.posts.selectDistinct(p => ({ title: p.title })).toList()
```

## Implementation Details

### Architecture

The implementation follows the **Strategy Pattern**:

```
CollectionStrategyFactory
  ├── LateralCollectionStrategy (default)
  ├── CteCollectionStrategy
  └── TempTableCollectionStrategy
```

**Key Classes:**

- `CollectionStrategyFactory` - Creates strategy instances
- `ICollectionStrategy` - Strategy interface
- `LateralCollectionStrategy` - LEFT JOIN LATERAL implementation (default)
- `CteCollectionStrategy` - CTE + JSONB implementation
- `TempTableCollectionStrategy` - Temp table implementation
- `QueryContext` - Carries strategy configuration through query building

### Query Execution Flow

#### LATERAL Strategy (Single-Phase, Default)

1. Build main query with LEFT JOIN LATERAL subqueries
2. Execute single query (subqueries correlate with each parent row)
3. Transform results

#### CTE Strategy (Single-Phase)

1. Build main query with CTEs
2. Execute single query
3. Transform results

#### Temp Table Strategy (Two-Phase)

1. **Phase 1**: Execute base query to get parent IDs
2. **Phase 2**: For each collection:
   - Create temp table with parent IDs
   - Execute aggregation query
   - Store results in aggregation temp table
3. **Phase 3**: Merge base results with collection results
4. **Cleanup**: Drop temp tables

## Implementation Details

### DatabaseClient Interface

The ORM uses the `supportsMultiStatementQueries()` method to detect client capabilities:

```typescript
/**
 * Check if the driver supports executing multiple SQL statements in a single query
 * and returning multiple result sets.
 */
supportsMultiStatementQueries(): boolean {
  return false; // Default: false for safety
}
```

**Client Implementations:**
- **PgClient (node-postgres)**: Returns `false` - uses prepared statements (safe, multiple round trips)
- **PostgresClient (postgres.js)**: Returns `true` - uses `.simple()` mode (experimental, single round trip)

### Security Considerations

**LATERAL Strategy (Default):**
- ✅ Uses PostgreSQL's native prepared statements
- ✅ Automatic parameter binding (safe by default)
- ✅ No manual escaping required
- ✅ Production-ready

**CTE Strategy:**
- ✅ Uses PostgreSQL's native prepared statements
- ✅ Automatic parameter binding (safe by default)
- ✅ No manual escaping required
- ✅ Production-ready

**Temp Table Strategy:**
- ⚠️ PostgresClient mode requires manual parameter escaping
- Integer parent IDs are safe to interpolate
- String parameters use PostgreSQL standard escaping (doubling single quotes)
- Each value type (number, boolean, Date, NULL) has dedicated handling
- Experimental status due to manual escaping requirement

### Type Safety

All three strategies maintain full TypeScript type safety:

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts.select(p => ({
      title: p.title,  // ✓ Type-safe
      views: p.views,  // ✓ Type-safe
    })).toList(),
  }))
  .toList();

// Result type is inferred correctly:
// Array<{
//   id: number;
//   username: string;
//   posts: Array<{ title: string; views: number }>;
// }>
```

## Performance Considerations

### Benchmarking

For accurate performance comparison:

```typescript
import { performance } from 'perf_hooks';

// Test JSONB strategy
const start1 = performance.now();
const jsonbResults = await dbJsonb.users.select(/* ... */).toList();
const time1 = performance.now() - start1;

// Test temp table strategy
const start2 = performance.now();
const tempTableResults = await dbTempTable.users.select(/* ... */).toList();
const time2 = performance.now() - start2;

console.log('JSONB:', time1, 'ms');
console.log('Temp Table:', time2, 'ms');
```

### Tips for Optimization

1. **Use indexes** on foreign key columns
2. **Filter early** - apply WHERE clauses before aggregating
3. **Limit results** when possible
4. **Monitor query plans** using `EXPLAIN ANALYZE`
5. **Benchmark both strategies** for your specific dataset

## Examples

See [examples/temp-table-strategy-demo.ts](examples/temp-table-strategy-demo.ts) for a complete working example.

## API Reference

### QueryOptions

```typescript
interface QueryOptions {
  /** Enable SQL query logging */
  logQueries?: boolean;
  /** Custom logger function (defaults to console.log) */
  logger?: (message: string) => void;
  /** Log query execution time */
  logExecutionTime?: boolean;
  /** Log query parameters */
  logParameters?: boolean;
  /** Collection aggregation strategy (default: 'lateral') */
  collectionStrategy?: 'cte' | 'lateral' | 'temptable';
}
```

### withQueryOptions Method

```typescript
// Available on both DbEntityTable and TableAccessor
withQueryOptions(options: QueryOptions): this

// Example usage
const results = await db.users
  .withQueryOptions({
    logQueries: true,
    collectionStrategy: 'temptable'
  })
  .select(u => ({
    id: u.id,
    posts: u.posts!.select(p => ({ title: p.title })).toList('posts')
  }))
  .toList();
```

### CollectionStrategyType

```typescript
type CollectionStrategyType = 'cte' | 'lateral' | 'temptable';
```

### Legacy Type Alias

```typescript
// @deprecated Use QueryOptions instead
type LoggingOptions = QueryOptions;
```

### Exports

```typescript
import {
  QueryOptions,
  CollectionStrategyType,
  ICollectionStrategy,
  CollectionAggregationConfig,
  CollectionAggregationResult,
  CollectionStrategyFactory,
} from 'linkgress-orm';
```

## Migration Guide

### Upgrading from Previous Versions

**Note:** The default collection strategy changed from `'cte'` to `'lateral'`. LATERAL correctly applies LIMIT/OFFSET per parent row, which is the expected behavior for most use cases.

**Before (CTE was default):**
```typescript
const db = new DbContext(pool, schema);
```

**After (LATERAL is now default):**
```typescript
const db = new DbContext(pool, schema, {
  collectionStrategy: 'lateral'  // Optional - this is the new default
});
```

**To keep using CTE (previous default):**
```typescript
const db = new DbContext(pool, schema, {
  collectionStrategy: 'cte'  // Explicitly use CTE strategy
});
```

**To use temp tables:**
```typescript
const db = new DbContext(pool, schema, {
  collectionStrategy: 'temptable'  // Enable temp table strategy
});
```

## Contributing

When adding new collection features, ensure all three strategies are updated:

1. Update `CteCollectionStrategy.buildAggregation()`
2. Update `LateralCollectionStrategy.buildAggregation()`
3. Update `TempTableCollectionStrategy.buildAggregation()`
4. Update this documentation

## License

MIT
