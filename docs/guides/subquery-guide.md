# Subquery Guide - Strongly Typed Subqueries

This guide demonstrates how to use strongly-typed subqueries in Linkgress ORM. Subqueries allow you to nest queries within other queries while maintaining full type safety.

## Table of Contents

1. [Overview](#overview)
2. [Basic Concepts](#basic-concepts)
3. [Subquery Modes](#subquery-modes)
4. [Usage Examples](#usage-examples)
5. [Type Safety](#type-safety)
6. [Advanced Patterns](#advanced-patterns)

## Overview

Subqueries in Linkgress ORM are created using the `.asSubquery()` method on any query. The subquery maintains full type information and can be used in:

- **WHERE clauses** - EXISTS, IN, scalar comparisons
- **SELECT clauses** - Computed columns, aggregations
- **JOIN conditions** - Join on subquery results
- **FROM clauses** - Query from subquery results

## Basic Concepts

### Creating a Subquery

Any query can be converted to a subquery using `.asSubquery(mode)`:

```typescript
const subquery = db.users
  .where(u => eq(u.isActive, true))
  .select(u => u.id)
  .asSubquery('array');
```

The resulting subquery:
- Maintains the type information from the query
- Can be used in other queries
- Generates efficient SQL when executed
- Shares parameters with the outer query

### Subquery Modes

There are three subquery modes:

1. **`'scalar'`** - Returns a single value
2. **`'array'`** - Returns a list of values (for IN clauses)
3. **`'table'`** - Returns full rows (for FROM/JOIN)

## Subquery Modes

### Scalar Subqueries

Used when you need a single value (aggregations, lookups):

```typescript
const avgAge = db.users
  .select(u => sql<number>`AVG(${u.age})`)
  .asSubquery('scalar');

// Use in WHERE
const olderThanAverage = await db.users
  .where(u => gtSubquery(u.age, avgAge))
  .toList();

// Use in SELECT
const usersWithAvg = await db.users
  .select(u => ({
    name: u.username,
    age: u.age,
    avgAge: avgAge  // Type: number
  }))
  .toList();
```

**Generated SQL:**
```sql
SELECT "username", "age", (SELECT AVG(age) FROM users) as avgAge
FROM users
WHERE age > (SELECT AVG(age) FROM users)
```

### Array Subqueries

Used for IN/NOT IN clauses:

```typescript
const activeUserIds = db.users
  .where(u => eq(u.isActive, true))
  .select(u => u.id)
  .asSubquery('array');

const posts = await db.posts
  .where(p => inSubquery(p.userId, activeUserIds))
  .toList();
```

**Generated SQL:**
```sql
SELECT * FROM posts
WHERE user_id IN (
  SELECT id FROM users WHERE is_active = true
)
```

### Table Subqueries

Used for FROM clauses or JOINs (coming soon):

```typescript
const activeUsers = db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({ id: u.id, name: u.username }))
  .asSubquery('table');

// Can be used as a table source (future feature)
```

## Usage Examples

### 1. EXISTS - Check for Related Records

Find users who have at least one post:

```typescript
const usersWithPosts = await db.users
  .where(u => exists(
    db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => p.id)
      .asSubquery('array')
  ))
  .select(u => ({
    id: u.id,
    username: u.username
  }))
  .toList();
```

**Type:** `{ id: number, username: string }[]`

### 2. NOT EXISTS - Inverse Check

Find users who have NO posts:

```typescript
const usersWithoutPosts = await db.users
  .where(u => notExists(
    db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => p.id)
      .asSubquery('array')
  ))
  .toList();
```

### 3. IN Subquery - Filter by Set

Find posts by active users:

```typescript
const activeUserIds = db.users
  .where(u => eq(u.isActive, true))
  .select(u => u.id)
  .asSubquery('array');

const posts = await db.posts
  .where(p => inSubquery(p.userId, activeUserIds))
  .toList();
```

### 4. NOT IN Subquery

Find posts by inactive users:

```typescript
const inactivePosts = await db.posts
  .where(p => notInSubquery(
    p.userId,
    db.users
      .where(u => eq(u.isActive, true))
      .select(u => u.id)
      .asSubquery('array')
  ))
  .toList();
```

### 5. Scalar Subquery in SELECT

Add computed columns using subqueries:

```typescript
const usersWithStats = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    postCount: db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => sql<number>`COUNT(*)`)
      .asSubquery('scalar'),
    totalViews: db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => sql<number>`COALESCE(SUM(${p.views}), 0)`)
      .asSubquery('scalar'),
  }))
  .toList();
```

**Result Type:**
```typescript
{
  id: number;
  username: string;
  postCount: number;
  totalViews: number;
}[]
```

### 6. Scalar Comparisons

Compare fields with subquery results:

```typescript
// Users older than average
const olderThanAvg = await db.users
  .where(u => gtSubquery(
    u.age,
    db.users.select(u => sql<number>`AVG(${u.age})`).asSubquery('scalar')
  ))
  .toList();

// Posts with more views than average
const popularPosts = await db.posts
  .where(p => gtSubquery(
    p.views,
    db.posts.select(p => sql<number>`AVG(${p.views})`).asSubquery('scalar')
  ))
  .toList();
```

### 7. Correlated Subqueries

Subqueries that reference the outer query:

```typescript
const usersWithPopularPosts = await db.users
  .where(u => exists(
    db.posts
      .where(p => and(
        eq(p.userId, u.id),  // Correlation - references outer query
        gt(p.views, 1000)
      ))
      .select(p => p.id)
      .asSubquery('array')
  ))
  .toList();
```

For raw SQL correlation, use `sql` template:

```typescript
const usersWithPosts = await db.users
  .where(u => exists(
    db.posts
      .where(p => eq(p.userId, sql`users.id`))  // Raw correlation
      .select(p => p.id)
      .asSubquery('array')
  ))
  .toList();
```

## Type Safety

### Full Type Inference

The type system knows what each subquery returns:

```typescript
// Scalar subquery returns a number
const avgAge = db.users
  .select(u => sql<number>`AVG(${u.age})`)
  .asSubquery('scalar');
// Type: Subquery<number, 'scalar'>

// Array subquery returns number[]
const userIds = db.users
  .select(u => u.id)
  .asSubquery('array');
// Type: Subquery<number[], 'array'>

// Table subquery returns the full shape
const userInfo = db.users
  .select(u => ({ id: u.id, name: u.username }))
  .asSubquery('table');
// Type: Subquery<{ id: number, name: string }, 'table'>
```

### Type-Safe Comparisons

Comparison functions enforce type compatibility:

```typescript
// ✓ Correct - comparing number with number subquery
gtSubquery(u.age, avgAgeSubquery)

// ✗ Type error - comparing number with string subquery
gtSubquery(u.age, avgNameSubquery)  // TypeScript error!

// ✓ Correct - IN with matching types
inSubquery(p.userId, userIdSubquery)

// ✗ Type error - IN with wrong type
inSubquery(p.userId, usernameSubquery)  // TypeScript error!
```

### Result Type Resolution

When using subqueries in SELECT, types are properly resolved:

```typescript
const result = await db.users
  .select(u => ({
    id: u.id,                    // number (from FieldRef<'id', number>)
    name: u.username,            // string (from FieldRef<'username', string>)
    postCount: postCountSubquery // number (from Subquery<number, 'scalar'>)
  }))
  .first();

// TypeScript knows:
result.id        // number
result.name      // string
result.postCount // number
```

## Advanced Patterns

### 1. Nested Subqueries

Subqueries can contain other subqueries:

```typescript
const avgViews = db.posts
  .select(p => sql<number>`AVG(${p.views})`)
  .asSubquery('scalar');

const usersWithPopularPosts = await db.users
  .where(u => exists(
    db.posts
      .where(p => and(
        eq(p.userId, u.id),
        gtSubquery(p.views, avgViews)  // Nested subquery!
      ))
      .select(p => p.id)
      .asSubquery('array')
  ))
  .select(u => ({
    id: u.id,
    username: u.username,
    popularCount: db.posts
      .where(p => and(
        eq(p.userId, u.id),
        gtSubquery(p.views, avgViews)  // Same subquery reused!
      ))
      .select(p => sql<number>`COUNT(*)`)
      .asSubquery('scalar')
  }))
  .toList();
```

### 2. Reusable Subqueries

Define subqueries once, use them multiple times:

```typescript
// Define reusable subqueries
const activeUserIds = db.users
  .where(u => eq(u.isActive, true))
  .select(u => u.id)
  .asSubquery('array');

const avgPostViews = db.posts
  .select(p => sql<number>`AVG(${p.views})`)
  .asSubquery('scalar');

// Use in multiple queries
const query1 = db.posts
  .where(p => inSubquery(p.userId, activeUserIds))
  .toList();

const query2 = db.posts
  .where(p => and(
    inSubquery(p.userId, activeUserIds),
    gtSubquery(p.views, avgPostViews)
  ))
  .toList();
```

### 3. Complex Aggregations

Use subqueries for complex calculations:

```typescript
const userStats = await db.users
  .select(u => ({
    username: u.username,

    // Total posts
    totalPosts: db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => sql<number>`COUNT(*)`)
      .asSubquery('scalar'),

    // Average views per post
    avgViews: db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => sql<number>`AVG(${p.views})`)
      .asSubquery('scalar'),

    // Max views
    maxViews: db.posts
      .where(p => eq(p.userId, u.id))
      .select(p => sql<number>`MAX(${p.views})`)
      .asSubquery('scalar'),

    // Has viral post (>10k views)
    hasViralPost: exists(
      db.posts
        .where(p => and(
          eq(p.userId, u.id),
          gt(p.views, 10000)
        ))
        .select(p => p.id)
        .asSubquery('array')
    )
  }))
  .toList();
```

### 4. Combining with SQL Template

Mix subqueries with raw SQL for maximum flexibility:

```typescript
const topPostViews = db.posts
  .select(p => sql<number>`MAX(${p.views})`)
  .asSubquery('scalar');

const usersWithTopPosts = await db.users
  .select(u => ({
    username: u.username,
    hasTopPost: sql<boolean>`EXISTS(
      SELECT 1 FROM posts
      WHERE user_id = ${u.id}
      AND views = ${topPostViews}
    )`
  }))
  .toList();
```

## Available Subquery Functions

### WHERE Clause Functions

```typescript
// EXISTS
exists(subquery: Subquery): ExistsCondition
notExists(subquery: Subquery): NotExistsCondition

// IN clauses
inSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T[], 'array'>): InSubqueryCondition<T>
notInSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T[], 'array'>): NotInSubqueryCondition<T>

// Scalar comparisons
eqSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
neSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
gtSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
gteSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
ltSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
lteSubquery<T>(field: FieldRef<any, T>, subquery: Subquery<T, 'scalar'>): ScalarSubqueryComparison<T>
```

### Query Builder Methods

```typescript
// Convert query to subquery
SelectQueryBuilder.asSubquery<TMode>(mode?: TMode): Subquery<TResult, TMode>
```

## Performance Considerations

### Correlated vs Non-Correlated

**Non-correlated subqueries** (independent) are evaluated once:
```typescript
// Evaluated once, result reused
const avgAge = db.users.select(u => sql`AVG(${u.age})`).asSubquery('scalar');
```

**Correlated subqueries** (reference outer query) are evaluated per row:
```typescript
// Evaluated for each user
exists(db.posts.where(p => eq(p.userId, u.id)).select(p => p.id).asSubquery('array'))
```

### Optimization Tips

1. **Use JOINs when possible** - JOINs are often faster than correlated subqueries
2. **Reuse subqueries** - Define once, use multiple times
3. **Limit subquery results** - Use `.limit()` when appropriate
4. **Index correlation columns** - Ensure foreign keys are indexed
5. **Test query plans** - Use `EXPLAIN ANALYZE` to check performance

## Summary

Subqueries in Linkgress ORM provide:

✓ **Full type safety** - TypeScript knows the return types
✓ **Composability** - Nest queries arbitrarily deep
✓ **Performance** - Single database round trip
✓ **Flexibility** - Use in WHERE, SELECT, JOIN, FROM
✓ **Readability** - Fluent, chainable API

For more examples, see [debug/subquery-examples.ts](./debug/subquery-examples.ts).
