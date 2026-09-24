# Collection Strategies

This document explains the collection strategy pattern implemented in Linkgress ORM for handling navigation property queries.

## Overview

Linkgress ORM supports three strategies for loading collection navigation properties (one-to-many relationships):

1. **LATERAL Strategy** (default, recommended) - Uses `LEFT JOIN LATERAL` subqueries for per-row correlation
2. **CTE Strategy** - Uses CTEs with JSON aggregation in a single query
3. **Temp Table Strategy** (experimental) - Uses PostgreSQL temporary tables with optimized execution

**Strategy Selection Guide:**
- **LATERAL** (`'lateral'`): Default. One correlated subquery per parent row. Best for "top N per parent" queries and general use.
- **CTE** (`'cte'`): One aggregate per collection over all parents, grouped by the foreign key and joined back on it. LIMIT/OFFSET are applied per parent with `ROW_NUMBER()`.
- **Temp Table** (`'temptable'`): Experimental. Fetches the parent keys first, then runs the CTE strategy's aggregate for exactly those parents. Only for very large datasets (>100k rows) with benchmarked performance gains.

All strategies produce **identical results** — the same rows, order, limits and aggregates; they differ in the SQL they run and how it performs. You can configure the strategy globally at the database level or override it per-query using `withQueryOptions()`.

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
  collectionStrategy: 'temptable'  // ⚠️ Experimental: see "Temp Table Strategy" below
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

### CTE Strategy

```typescript
const users = await db.users
  .withQueryOptions({ collectionStrategy: 'cte' })
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!
      .orderBy(p => [[p.createdAt, 'DESC']])
      .select(p => ({
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
    "__fk_user_id" as parent_id,
    json_agg(
      json_build_object('title', "title", 'views', "views") ORDER BY "__order_0" DESC
    ) as data
  FROM (
    SELECT "posts"."user_id" as "__fk_user_id", "title", "views", "posts"."created_at" as "__order_0"
    FROM "posts"
  ) sub
  GROUP BY "__fk_user_id"
)
SELECT
  "users"."id",
  "users"."username",
  COALESCE("cte_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN "cte_0" ON "cte_0".parent_id = "users".id
```

`json_agg` orders by the columns of its subquery: an ORDER BY key the projection selects anyway is
ordered by that projected column, any other key by a hidden `"__order_<n>"` column. The aggregate
joins back on the parent's **principal key** — `id` by default, or the column a relation names with
`withPrincipalKey(...)`; for a collection hanging off a navigation (`ln.edition.book.editions`),
on that navigation's row.

### LATERAL Strategy

The LATERAL strategy uses `LEFT JOIN LATERAL` to fetch related records for each parent row, so LIMIT / OFFSET apply per parent by construction. A count, min / max / sum, exists or flat list without LIMIT / OFFSET renders as a correlated subquery in the SELECT list instead of a lateral join.

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
  SELECT json_agg(
    json_build_object('title', "title", 'views', "views")
  ) as data
  FROM (
    SELECT "lateral_0_posts"."title" as "title", "lateral_0_posts"."views" as "views"
    FROM "posts" "lateral_0_posts"
    WHERE "lateral_0_posts"."user_id" = "users"."id"
    ORDER BY "lateral_0_posts"."views" DESC
    LIMIT 3
  ) sub
) "lateral_0" ON true
```

**Key difference from CTE:** The LATERAL subquery references `"users"."id"` from the outer query, enabling per-row correlation. The LIMIT is applied within the subquery, so each user gets their top 3 posts. ORDER BY keys are qualified — a bare column name inside a lateral would bind to a projected alias of the same name, or to a column of the OUTER row when the collection's table has none.

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

The strategy runs in phases: the base query first (without the collections, plus each collection's
**parent key** — `"__pk_id"` for the root row's key, `"__pk_<n>"` for the key of a navigation a
collection hangs off), then, per collection, the CTE strategy's aggregation restricted to exactly
those parents, and finally merges the aggregates into the rows by that key. Whatever the CTE strategy
can aggregate, the temp table strategy aggregates the same way: navigations in the projection, WHERE
and ORDER BY, LIMIT / OFFSET per parent, counts and other scalars, `firstOrDefault()`, principal keys
other than `id`, and collections nested in it (those render as LATERAL inside the aggregation).

**SQL Pattern (`PgClient` — prepared statements, one round trip per statement):**

```sql
-- The base query, with the parent key of the collection
SELECT "users"."id" as "__pk_id", "users"."id" as "id", "users"."username" as "username"
FROM "users";

-- Per collection: the parents' keys into a temp table, then the aggregation over just those parents
CREATE TEMP TABLE IF NOT EXISTS tmp_parent_ids_0 (id integer PRIMARY KEY);
INSERT INTO tmp_parent_ids_0 VALUES ($1),($2),($3);

CREATE TEMP TABLE tmp_parent_ids_0_agg AS
SELECT
  "__fk_user_id" as parent_id,
  json_agg(json_build_object('title', "title", 'views', "views") ORDER BY "views" DESC) as data
FROM (
  SELECT "posts"."user_id" as "__fk_user_id", "title", "views"
  FROM "posts"
  WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0)
) sub
GROUP BY "__fk_user_id";

SELECT parent_id, data FROM tmp_parent_ids_0_agg;
DROP TABLE IF EXISTS tmp_parent_ids_0, tmp_parent_ids_0_agg;
```

The temp table's key column takes the type of the parent key (`integer`, `bigint`, `uuid`, `text`, …).

**SQL Pattern (multi-statement drivers — `PostgresClient`, `BunClient`, `PGliteClient`):**

These drivers send each collection's statements as ONE multi-statement script over the simple
protocol, which takes no bind parameters: every parameter of the aggregation is written into the
script as a SQL literal (see [Security Considerations](#security-considerations)).

```sql
CREATE TEMP TABLE tmp_parent_ids_0 (id integer PRIMARY KEY) ON COMMIT DROP;
INSERT INTO tmp_parent_ids_0 VALUES (1),(2),(3);
SELECT "__fk_user_id" as parent_id, json_agg(…) as data FROM (…) sub GROUP BY "__fk_user_id";
DROP TABLE IF EXISTS tmp_parent_ids_0;
```

When the base query has no parameters and every collection is a plain list of the item's own
columns — no WHERE, LIMIT / OFFSET, aggregate, DISTINCT, navigation, mapper, or principal key other
than `id`, and only column types whose JSON and driver values agree — the whole query runs in a
**single round trip**:

```sql
CREATE TEMP TABLE tmp_base_0 AS SELECT "users"."id" as "__pk_id", … FROM "users";
SELECT * FROM tmp_base_0;
SELECT "user_id" as parent_id, "title" as "title", "views" as "views"
FROM "posts" WHERE "user_id" IN (SELECT "__pk_id" FROM tmp_base_0) ORDER BY "posts"."views" DESC;
DROP TABLE IF EXISTS tmp_base_0;
```

A collection that cannot be aggregated apart from its parent row — one whose WHERE, projection or
ORDER BY reads a column of the enclosing row beyond the relation key — renders as LATERAL in the base
query instead. And a query built as ONE statement (`countOver()`, `prepare()`, a UNION leg, a future
of a batch) cannot run phases: its temp table collections take the CTE form, which is the very
aggregation the phases would run, over every parent.

## When to Use Each Strategy

### LATERAL Strategy (Default, Recommended)

**Pros:**
- ✅ **Default and recommended for most use cases**
- ✅ LIMIT/OFFSET per parent row by construction — each parent's subquery stops at its limit
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
- ❌ Aggregates every parent's children, even when the outer query keeps only a few parents
- ❌ LIMIT/OFFSET per parent needs a `ROW_NUMBER()` pass over all children

**Best for:**
- Collections without LIMIT/OFFSET, over most of the parents
- When you prefer one aggregate per collection to one subquery per parent row
- Moderate-sized datasets (< 100k rows)

### Temp Table Strategy (Experimental)

**⚠️ Experimental Notice:** Use only when benchmarks show the other strategies are insufficient for your specific large dataset scenario. On multi-statement drivers it writes parameters into the SQL as literals (see [Security Considerations](#security-considerations)).

**Pros:**
- ✅ Better performance for very large datasets (>100k rows)
- ✅ Aggregates only the parents the base query returned
- ✅ Indexed temp table JOIN can be faster
- ✅ Lower memory usage per operation
- ✅ **Single roundtrip** for plain lists on multi-statement drivers

**Cons:**
- ❌ Experimental status
- ❌ Several round trips: the base query, then the collections
- ❌ Temp table creation overhead
- ❌ More complex execution flow
- ❌ Not recommended for general use

**Best for:**
- Very large datasets (> 100k rows) where benchmarked
- Data warehouse scenarios with proven performance needs
- When using `PostgresClient` for maximum performance
- **Only after verifying the LATERAL and CTE strategies are insufficient**

## Supported Features

All three strategies support **all collection operations** and return the same results for them:

### Collection Queries
```typescript
// Select fields from collection
u.posts.select(p => ({ title: p.title, views: p.views })).toList()

// ...including columns of the item's navigations
u.posts.select(p => ({ title: p.title, category: p.category!.name })).toList()
```

### Filtering
```typescript
// Filter collection items — by their own columns or their navigations' columns
u.posts.where(p => gt(p.views, 100)).select(p => ({ title: p.title })).toList()
u.posts.where(p => eq(p.category!.name, 'News')).select(p => ({ title: p.title })).toList()
```

### Ordering
```typescript
// Order collection items — by a projected column, one the projection leaves out,
// or a column of a navigation of the item
u.posts.select(p => ({ title: p.title })).orderBy(p => [[p.views, 'DESC']]).toList()
u.posts.orderBy(p => p.category!.name).select(p => ({ title: p.title })).toList()

// ...or by an SQL expression: a `sql` fragment, a condition, a nested collection's count
u.posts.orderBy(p => [[sql<number>`length(${p.title})`, 'DESC']]).select(p => ({ title: p.title })).toList()
u.posts.orderBy(p => [[p.comments!.count(), 'DESC']]).select(p => ({ title: p.title })).toList()
```

A DISTINCT collection can only be ordered by values it selects — ordering by anything else has no
single answer (one listed value may stand for several rows). The build refuses it naming the key —
except a LATERAL list of objects, whose statement PostgreSQL refuses.

### Pagination
```typescript
// Limit and offset — per parent row, under every strategy
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

// Over the ordered, limited collection: counts at most 3 rows per user
u.posts.orderBy(p => [[p.views, 'DESC']]).limit(3).count()
```

### Array Aggregations
```typescript
// To array of strings (in the collection's ORDER BY)
u.posts.orderBy(p => p.title).select(p => p.title).toStringList()

// To array of numbers
u.posts.select(p => p.views).toNumberList()
```

### DISTINCT
```typescript
// Distinct values
u.posts.selectDistinct(p => ({ title: p.title })).toList()
```

### Collections off a navigation, and relations of a table to itself
```typescript
// The other loans of the same member, the editions of the loan's book
ln.member!.loans!.select(x => ({ note: x.note })).toList()
ln.edition!.book!.editions!.count()

// A tree: the children of each node, and the siblings through its parent
n.children!.select(c => ({ name: c.name })).toList()
n.parent!.children!.where(c => gt(c.id, n.id)).count()
```

A collection may be reached through any chain of navigations, may read the table of the row it
hangs off (`ed.book.editions` from an edition), and may compare its items with the enclosing row —
the root row or an enclosing collection's item (`ln.member.loans.where(x => gt(x.id, ln.id))`).
Relations keyed on a principal key other than `id` (`withPrincipalKey(c => c.code)`) join on that
key, and tables in another schema (`toSchema(...)`) are read schema-qualified.

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
- `CteCollectionStrategy` - CTE + JSON aggregation implementation
- `TempTableCollectionStrategy` - Temp table implementation (runs the CTE strategy's aggregation for its parents)
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

1. **Phase 1**: Execute the base query — the projection without the collections, plus each
   collection's parent key (the root row's, or that of the navigation the collection hangs off)
2. **Phase 2**: For each collection:
   - Create a temp table with the (distinct, non-null) parent keys
   - Run the CTE strategy's aggregation restricted to `fk IN (SELECT id FROM <temp table>)`
   - Read its `(parent_id, data)` rows (legacy drivers store them in an aggregation temp table first)
3. **Phase 3**: Merge each collection's data into the base rows by that parent key (a row whose key
   is NULL — its navigation is missing — gets the empty value)
4. **Cleanup**: Drop temp tables

Each aggregation runs as a statement of its own, so its parameters are numbered from `$1`.

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
- **PostgresClient (postgres.js)**: Returns `true` - uses `.simple()` mode (single round trip per script)
- **BunClient (Bun.sql)**: Returns `true` - simple-protocol scripts
- **PGliteClient (PGlite)**: Returns `true` - uses PGlite's `exec()` (simple protocol, one call in-process)

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
- `PgClient`: prepared statements with bound parameters, like the other strategies
- Multi-statement drivers: the simple protocol takes no bind parameters, so every `$n` of an
  aggregation is written into the script as a literal, by a tokenizer that knows what PostgreSQL does
  not read as a placeholder — quoted literals and identifiers, `E'…'` and dollar-quoted strings,
  `--` and `/* */` comments, a `$` inside an identifier — and refuses a placeholder without a value
- Each value type has dedicated handling: `NULL`, booleans, numbers (a negative one parenthesized so
  `a-$1` cannot turn into the comment `a--1`; `NaN` / `±Infinity` quoted), bigints, Dates (ISO
  strings), strings (quotes doubled; a string with a backslash written as `E'…'` with its backslashes
  doubled, so it reads the same whatever `standard_conforming_strings` is set to), arrays (array
  literals) and objects (JSON)
- Parent keys are the values the base query returned, written the same way

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

const timed = async (collectionStrategy: 'lateral' | 'cte' | 'temptable') => {
  const start = performance.now();
  await db.users
    .withQueryOptions({ collectionStrategy })
    .select(/* ... */)
    .toList();
  return performance.now() - start;
};

console.log('LATERAL:', await timed('lateral'), 'ms');
console.log('CTE:', await timed('cte'), 'ms');
console.log('Temp Table:', await timed('temptable'), 'ms');
```

### Tips for Optimization

1. **Use indexes** on foreign key columns
2. **Filter early** - apply WHERE clauses before aggregating
3. **Limit results** when possible
4. **Monitor query plans** using `EXPLAIN ANALYZE`
5. **Benchmark the strategies** for your specific dataset

## Examples

The suites under `tests/queries/` run the same queries under every strategy —
`collection-navigation-strategies.test.ts`, `collection-orderby.test.ts`,
`collection-same-table.test.ts` and `collection-schema-qualified.test.ts` show each feature above
with the rows it returns.

## API Reference

### QueryOptions

The options most relevant to collections. See
**[Configuration & Options](./guides/configuration.md#context-options--queryoptions)** for the
complete list with defaults — logging, prepared statements, slow-query detection, mappers and
process-wide settings.

```typescript
interface QueryOptions {
  /** Collection aggregation strategy (default: 'lateral') */
  collectionStrategy?: 'cte' | 'lateral' | 'temptable';

  /** Enable SQL query logging */
  logQueries?: boolean;
  /** Custom logger function (defaults to defaultLogger); second arg is the log section */
  logger?: (message: string, section?: LogSection) => void;
  /** Log query execution time */
  logExecutionTime?: boolean;
  /** Log query parameters */
  logParameters?: boolean;
  /** Report failed statements (with their SQL) even when logQueries is off (default: logQueries) */
  logFailedQueries?: boolean;
  /** Log a per-phase breakdown: build / execute / transform */
  traceTime?: boolean;

  /** Opt-in: run parameterised statements as NAMED prepared statements (PostgresClient only) */
  preparedStatements?: boolean;

  /** Slow-query detection (the query is reported, not cancelled) */
  onQueryTakingTooLong?: (info: SlowQueryInfo) => void;
  longRunningQueryThreshold?: number;   // default 10000 ms
  slowQueryStackTraceLimit?: number;    // default 50 frames; 0 = no capture

  /** Result handling */
  disableMappers?: boolean;   // skip fromDriver/toDriver
  rawResult?: boolean;        // driver rows, no ORM shaping
  useBinaryProtocol?: boolean;

  /** Process-wide when passed here — see LinkgressConfig */
  inArrayOptThreshold?: number;                  // default 8
  inArrayPadBuckets?: readonly number[] | null;  // default null (off)
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

1. Update `CteCollectionStrategy.buildAggregationSelect()` — the temp table strategy runs this very
   aggregation, restricted to its parents, so a CTE change carries over to it
2. Update `LateralCollectionStrategy.buildAggregation()` (and its LateralSqlCache shape key when the
   rendering reads a new config field)
3. Update `TempTableCollectionStrategy` only for what is its own: the temp tables, the parameter
   interpolation of the multi-statement path, and the single round-trip fast path
4. Test the feature under every strategy — the library fixture (`tests/utils/library-fixture.ts`,
   `LIBRARY_STRATEGIES`) gives every navigation path a different value, so a wrong join cannot pass
5. Update this documentation

## License

MIT
