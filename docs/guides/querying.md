# Querying Guide

This guide covers querying data in Linkgress ORM with type-safe, LINQ-inspired syntax.

## Overview

Linkgress ORM provides a powerful, type-safe query API inspired by C# LINQ. All queries maintain full TypeScript type inference, ensuring compile-time safety and excellent IDE support.

## Basic Queries

### Simple SELECT

Query all records from a table:

```typescript
// Get all users
const users = await db.users.toList();

console.log(users);
// Array of User objects with all columns
```

### Selecting Specific Columns

Project specific columns using `select()`:

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username
  }))
  .toList();

// Result type is automatically inferred:
// Array<{ id: number; username: string }>
```

### WHERE Filtering

Filter records using type-safe condition functions:

```typescript
import { eq, gt, lt, and, or } from 'linkgress-orm';

// Single condition
const activeUsers = await db.users
  .where(u => eq(u.isActive, true))
  .toList();

// Multiple conditions with AND
const filteredUsers = await db.users
  .where(u => and(
    eq(u.isActive, true),
    gt(u.loginCount, 10)
  ))
  .toList();

// Multiple conditions with OR
const users = await db.users
  .where(u => or(
    eq(u.role, 'admin'),
    eq(u.role, 'moderator')
  ))
  .toList();
```

**Available Condition Functions:**
- Comparison: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
- Logical: `and`, `or`, `not`
- Pattern matching: `like`, `ilike`, `startsWith`
- Regex: `regexMatches`, `regexMatchesCaseInsensitive`, `regexNoMatch`, `regexNoMatchCaseInsensitive`
- Array: `inArray`, `notInArray`
- Null checking: `isNull`, `isNotNull`
- JSONB: `jsonbSelect`, `jsonbSelectText`
- Utility: `coalesce`
- Bitmask/Flags: `flagHas`, `flagHasAll`, `flagHasAny`, `flagHasNone`

### Ordering Results

Sort results using `orderBy()`:

```typescript
// Single column ascending
const users = await db.users
  .orderBy(u => u.username)
  .toList();

// Single column descending
const users = await db.users
  .orderBy(u => [[u.loginCount, 'DESC']])
  .toList();

// Multiple columns
const users = await db.users
  .orderBy(u => [
    [u.isActive, 'DESC'],
    [u.username, 'ASC']
  ])
  .toList();
```

### Pagination

Limit and offset results:

```typescript
// Get first 10 users
const users = await db.users
  .limit(10)
  .toList();

// Skip 20, take 10 (page 3)
const users = await db.users
  .offset(20)
  .limit(10)
  .toList();

// Combined with ordering
const users = await db.users
  .orderBy(u => u.createdAt)
  .offset(0)
  .limit(25)
  .toList();
```

### DISTINCT

Get unique values:

```typescript
// Distinct users by role
const uniqueRoles = await db.users
  .selectDistinct(u => ({ role: u.role }))
  .toList();
```

## Aggregations

### Count

```typescript
// Count all users
const totalUsers = await db.users.count();

// Count with condition
const activeCount = await db.users
  .where(u => eq(u.isActive, true))
  .count();
```

### Sum, Min, Max, Average

```typescript
import { sum, min, max, avg } from 'linkgress-orm';

// Sum of all post views
const totalViews = await db.posts
  .sum(p => p.views);

// Min and max
const minViews = await db.posts.min(p => p.views);
const maxViews = await db.posts.max(p => p.views);

// Average (if supported)
const avgViews = await db.posts.avg(p => p.views);
```

## Nested Collections

### Loading Related Data

Query one-to-many relationships with automatic optimization:

```typescript
const usersWithPosts = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      views: p.views
    })).toList('posts')
  }))
  .toList();

// Result type:
// Array<{
//   id: number;
//   username: string;
//   posts: Array<{ title: string; views: number }>;
// }>
```

### Filtering Collections

Apply WHERE conditions to nested collections:

```typescript
const usersWithPopularPosts = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    popularPosts: u.posts!
      .where(p => gt(p.views, 1000))
      .select(p => ({
        title: p.title,
        views: p.views
      }))
      .toList('popularPosts')
  }))
  .toList();
```

### Ordering Collections

Order nested collection results:

```typescript
const usersWithTopPosts = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    topPosts: u.posts!
      .select(p => ({ title: p.title, views: p.views }))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(5)
      .toList('topPosts')
  }))
  .toList();
```

### Collection Aggregations

Aggregate data in nested collections:

```typescript
const usersWithStats = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    postCount: u.posts!.count(),
    totalViews: u.posts!.sum(p => p.views),
    maxViews: u.posts!.max(p => p.views),
    topTitles: u.posts!
      .select(p => p.title)
      .toStringList()  // Array of strings
  }))
  .toList();
```

## GROUP BY

Group results and aggregate data:

```typescript
// Group posts by user and count
const postsByUser = await db.posts
  .groupBy(p => p.userId)
  .select(g => ({
    userId: g.key,
    postCount: g.count(),
    totalViews: g.sum(p => p.views),
    avgViews: g.avg(p => p.views)
  }))
  .toList();

// Group with HAVING clause
const activePosters = await db.posts
  .groupBy(p => p.userId)
  .having(g => gt(g.count(), 5))  // Only users with > 5 posts
  .select(g => ({
    userId: g.key,
    postCount: g.count()
  }))
  .toList();
```

## JOINs

### Inner Join

Join two tables:

```typescript
const postsWithUsers = await db.posts
  .join(db.users, (post, user) => eq(post.userId, user.id))
  .select((post, user) => ({
    postTitle: post.title,
    postViews: post.views,
    authorName: user.username,
    authorEmail: user.email
  }))
  .toList();
```

### Left Join

```typescript
const usersWithPosts = await db.users
  .leftJoin(db.posts, (user, post) => eq(user.id, post.userId))
  .select((user, post) => ({
    username: user.username,
    postTitle: post.title,  // Can be null
    postViews: post.views   // Can be null
  }))
  .toList();
```

### Multiple Joins

```typescript
const data = await db.posts
  .join(db.users, (post, user) => eq(post.userId, user.id))
  .join(db.categories, (post, user, category) =>
    eq(post.categoryId, category.id)
  )
  .select((post, user, category) => ({
    postTitle: post.title,
    authorName: user.username,
    categoryName: category.name
  }))
  .toList();
```

## Subqueries

For detailed subquery examples, see the [Subquery Guide](./subquery-guide.md).

### Scalar Subquery

Use a subquery to compute a single value:

```typescript
import { sql } from 'linkgress-orm';

const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    postCount: sql<number>`(
      SELECT COUNT(*)
      FROM posts
      WHERE user_id = ${u.id}
    )`
  }))
  .toList();
```

### IN Subquery

Filter using a subquery:

```typescript
// Users who have posts
const activeUsers = await db.users
  .where(u => inSubquery(
    u.id,
    sql`SELECT user_id FROM posts WHERE views > 100`
  ))
  .toList();
```

### EXISTS Subquery

Check for existence:

```typescript
// Users with at least one post
const usersWithPosts = await db.users
  .where(u => exists(
    sql`SELECT 1 FROM posts WHERE user_id = ${u.id}`
  ))
  .toList();
```

## CTEs (Common Table Expressions)

For detailed CTE examples, see the [CTE Guide](./CTE-GUIDE.md).

### Simple CTE

Define reusable query fragments:

```typescript
import { cte } from 'linkgress-orm';

// Define a CTE
const popularPosts = cte('popular_posts', db.posts
  .where(p => gt(p.views, 1000))
  .select(p => ({
    id: p.id,
    title: p.title,
    userId: p.userId,
    views: p.views
  }))
);

// Use the CTE
const results = await db.users
  .join(popularPosts, (user, post) => eq(user.id, post.userId))
  .select((user, post) => ({
    username: user.username,
    postTitle: post.title,
    views: post.views
  }))
  .toList();
```

### Recursive CTE

Build hierarchical queries:

```typescript
// Organizational hierarchy
const hierarchy = cte('hierarchy',
  // Anchor member: top-level employees
  db.employees
    .where(e => isNull(e.managerId))
    .select(e => ({
      id: e.id,
      name: e.name,
      managerId: e.managerId,
      level: sql<number>`1`
    })),
  // Recursive member: employees reporting to previous level
  (self) => db.employees
    .join(self, (emp, manager) => eq(emp.managerId, manager.id))
    .select((emp, manager) => ({
      id: emp.id,
      name: emp.name,
      managerId: emp.managerId,
      level: sql<number>`${manager.level} + 1`
    }))
);

const orgChart = await hierarchy.toList();
```

## Magic SQL Strings

Use raw SQL when needed, with type safety:

### Basic Usage

```typescript
import { sql } from 'linkgress-orm';

// Embed SQL expressions
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    fullName: sql<string>`${u.firstName} || ' ' || ${u.lastName}`,
    accountAge: sql<number>`EXTRACT(YEAR FROM AGE(CURRENT_DATE, ${u.createdAt}))`
  }))
  .toList();
```

### Type-Safe Parameters

Magic SQL strings automatically handle parameter binding:

```typescript
const searchTerm = 'john';
const minAge = 18;

const results = await db.users
  .where(u => and(
    sql<boolean>`${u.username} ILIKE ${'%' + searchTerm + '%'}`,
    sql<boolean>`EXTRACT(YEAR FROM AGE(CURRENT_DATE, ${u.birthDate})) >= ${minAge}`
  ))
  .toList();
```

### Custom Formatters

Create custom SQL formatters for complex types:

```typescript
import { sql, SqlFormatter } from 'linkgress-orm';

// Custom formatter for JSON columns
class JsonFormatter implements SqlFormatter {
  format(value: any): string {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
}

// Use custom formatter
const metadata = { tags: ['typescript', 'orm'], featured: true };

const post = await db.posts
  .where(p => sql<boolean>`
    ${p.metadata} @> ${sql.custom(metadata, new JsonFormatter())}
  `)
  .toList();
```

### Array Operations

```typescript
import { sql } from 'linkgress-orm';

// Check if array contains value
const tags = ['typescript', 'database'];

const posts = await db.posts
  .where(p => sql<boolean>`${p.tags} && ${tags}`)  // Array overlap
  .toList();

// Array length
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    roleCount: sql<number>`array_length(${u.roles}, 1)`
  }))
  .toList();
```

### PostgreSQL-Specific Functions

```typescript
// Full-text search
const searchResults = await db.posts
  .where(p => sql<boolean>`
    to_tsvector('english', ${p.title} || ' ' || ${p.content}) @@
    to_tsquery('english', ${'typescript & orm'})
  `)
  .toList();

// JSON operations
const posts = await db.posts
  .select(p => ({
    id: p.id,
    title: p.title,
    firstTag: sql<string>`${p.metadata}->>'tags'->0`
  }))
  .toList();
```

## Built-in Operators

Linkgress provides type-safe operators for common SQL operations.

### Coalesce

Return the first non-null value:

```typescript
import { coalesce } from 'linkgress-orm';

// Return age or default to 0 if null
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    effectiveAge: coalesce(u.age, 0),
  }))
  .toList();

// Chain with other columns
const posts = await db.posts
  .select(p => ({
    id: p.id,
    displayTitle: coalesce(p.subtitle, p.title),  // subtitle first, fallback to title
  }))
  .toList();
```

### JSONB Operators

Extract values from JSONB columns with type safety:

```typescript
import { jsonbSelect, jsonbSelectText } from 'linkgress-orm';

// Define your JSONB structure type
type OrderItems = {
  productName: string;
  quantity: number;
  price: number;
};

// jsonbSelect: Extract property as JSONB (-> operator)
const orders = await db.orders
  .select(o => ({
    id: o.id,
    productName: jsonbSelect<OrderItems>(o.items, 'productName'),
    quantity: jsonbSelect<OrderItems>(o.items, 'quantity'),
  }))
  .toList();

// jsonbSelectText: Extract property as text (->> operator)
const orders = await db.orders
  .select(o => ({
    id: o.id,
    productNameText: jsonbSelectText<OrderItems>(o.items, 'productName'),
  }))
  .toList();

// Combine with coalesce for null safety
const orders = await db.orders
  .select(o => ({
    id: o.id,
    displayName: coalesce(
      jsonbSelectText<OrderItems>(o.items, 'productName'),
      'Unknown Product'
    ),
  }))
  .toList();
```

### Flag/Bitmask Operators

Work with bitmask/flag columns efficiently:

```typescript
import { flagHas, flagHasAll, flagHasAny, flagHasNone } from 'linkgress-orm';

// Define your flags as a TypeScript enum
enum Permission {
  None = 0,
  Read = 1,
  Write = 2,
  Delete = 4,
  Admin = 8,
  ReadWrite = Read | Write,  // 3
  All = Read | Write | Delete | Admin,  // 15
}

// flagHas: Check if a specific flag is set (column & flag) != 0
const readableUsers = await db.users
  .where(u => flagHas(u.permissions, Permission.Read))
  .toList();

// flagHasAll: Check if ALL specified flags are set (column & flags) = flags
const admins = await db.users
  .where(u => flagHasAll(u.permissions, Permission.ReadWrite))  // Must have both Read AND Write
  .toList();

// flagHasAny: Check if ANY of the specified flags are set (column & flags) != 0
const usersWithAnyAccess = await db.users
  .where(u => flagHasAny(u.permissions, Permission.Read | Permission.Write))
  .toList();

// flagHasNone: Check that a flag is NOT set (column & flag) = 0
const nonAdmins = await db.users
  .where(u => flagHasNone(u.permissions, Permission.Admin))
  .toList();
```

**Flag Operator Reference:**
- `flagHas(column, flag)` - Check if flag is set: `(column & flag) != 0`
- `flagHasAll(column, flags)` - Check if ALL flags are set: `(column & flags) = flags`
- `flagHasAny(column, flags)` - Check if ANY flag is set: `(column & flags) != 0`
- `flagHasNone(column, flag)` - Check if flag is NOT set: `(column & flag) = 0`

### startsWith Operator

The `startsWith` function uses PostgreSQL's `^@` operator for efficient prefix matching. Unlike `LIKE 'prefix%'`, `^@` is optimized to always use btree indexes:

```typescript
import { startsWith } from 'linkgress-orm';

const users = await db.users
  .where(u => startsWith(u.name, 'Joh'))
  .toList();
// → WHERE "name" ^@ $1
```

### Regex Operators

PostgreSQL POSIX regular expression matching:

```typescript
import {
  regexMatches,
  regexMatchesCaseInsensitive,
  regexNoMatch,
  regexNoMatchCaseInsensitive
} from 'linkgress-orm';

// ~ operator: case-sensitive regex match
const users = await db.users
  .where(u => regexMatches(u.name, '^Joh'))
  .toList();

// ~* operator: case-insensitive regex match
const gmailUsers = await db.users
  .where(u => regexMatchesCaseInsensitive(u.email, 'gmail\\.com$'))
  .toList();

// !~ operator: does not match regex
const noDigitStart = await db.users
  .where(u => regexNoMatch(u.name, '^[0-9]'))
  .toList();

// !~* operator: does not match regex (case-insensitive)
const noSecret = await db.users
  .where(u => regexNoMatchCaseInsensitive(u.name, 'secret'))
  .toList();
```

**Regex Operator Reference:**

| Function | SQL Operator | Description |
|----------|-------------|-------------|
| `regexMatches` | `~` | Matches regex (respects collation) |
| `regexMatchesCaseInsensitive` | `~*` | Matches regex (case-insensitive) |
| `regexNoMatch` | `!~` | Does not match regex |
| `regexNoMatchCaseInsensitive` | `!~*` | Does not match regex (case-insensitive) |

## Advanced Patterns

### Conditional Queries

Build queries dynamically:

```typescript
function searchUsers(filters: {
  username?: string;
  isActive?: boolean;
  minLoginCount?: number;
}) {
  let query = db.users.select(u => ({
    id: u.id,
    username: u.username,
    isActive: u.isActive,
    loginCount: u.loginCount
  }));

  // Apply filters conditionally
  if (filters.username) {
    query = query.where(u => like(u.username, `%${filters.username}%`));
  }

  if (filters.isActive !== undefined) {
    query = query.where(u => eq(u.isActive, filters.isActive));
  }

  if (filters.minLoginCount !== undefined) {
    query = query.where(u => gte(u.loginCount, filters.minLoginCount));
  }

  return query.toList();
}

// Usage
const results = await searchUsers({
  username: 'john',
  isActive: true
});
```

### First, Single, or Default

```typescript
// Get first result or null
const user = await db.users
  .where(u => eq(u.username, 'alice'))
  .firstOrDefault();

// Get single result (throws if multiple)
const user = await db.users
  .where(u => eq(u.id, 1))
  .single();

// Get first result (throws if empty)
const user = await db.users
  .orderBy(u => u.createdAt)
  .first();
```

### Any / None

```typescript
// Check if any records match
const hasActiveUsers = await db.users
  .where(u => eq(u.isActive, true))
  .any();

// Check if no records match
const noInactiveUsers = await db.users
  .where(u => eq(u.isActive, false))
  .none();
```

### Window Functions

```typescript
import { sql } from 'linkgress-orm';

// Row number partitioned by category
const rankedPosts = await db.posts
  .select(p => ({
    id: p.id,
    title: p.title,
    categoryId: p.categoryId,
    views: p.views,
    rank: sql<number>`ROW_NUMBER() OVER (
      PARTITION BY ${p.categoryId}
      ORDER BY ${p.views} DESC
    )`
  }))
  .toList();

// Running total
const postsWithTotal = await db.posts
  .select(p => ({
    id: p.id,
    views: p.views,
    runningTotal: sql<number>`SUM(${p.views}) OVER (
      ORDER BY ${p.createdAt}
    )`
  }))
  .toList();
```

## Prepared Statements

Prepared statements allow you to build a query once and execute it multiple times with different parameter values. This is useful for:
- **Query building optimization** - Build SQL once, execute many times
- **Type-safe placeholders** - Named parameters with validation
- **Developer ergonomics** - Cleaner API for reusable queries

### Basic Usage

Create a prepared query using `sql.placeholder()` and `.prepare()`:

```typescript
import { eq, sql } from 'linkgress-orm';

// Create a prepared query with a named placeholder
const getUserById = db.users
  .where(u => eq(u.id, sql.placeholder('userId')))
  .prepare('getUserById');

// Execute with different values
const alice = await getUserById.execute({ userId: 1 });
const bob = await getUserById.execute({ userId: 2 });
const charlie = await getUserById.execute({ userId: 3 });
```

### Multiple Placeholders

Use multiple placeholders for complex queries:

```typescript
import { and, gt, lt, sql } from 'linkgress-orm';

const searchUsers = db.users
  .where(u => and(
    gt(u.age, sql.placeholder('minAge')),
    lt(u.age, sql.placeholder('maxAge'))
  ))
  .orderBy(u => u.username)
  .prepare('searchUsers');

// Find users aged 20-40
const youngAdults = await searchUsers.execute({ minAge: 20, maxAge: 40 });

// Find users aged 40-60
const middleAged = await searchUsers.execute({ minAge: 40, maxAge: 60 });
```

### With Select Projections

Prepared queries work with custom projections:

```typescript
const getUserProfile = db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }))
  .where(u => eq(u.id, sql.placeholder('userId')))
  .prepare('getUserProfile');

const profile = await getUserProfile.execute({ userId: 10 });
// Result type: Array<{ id: number; username: string; email: string }>
```

### Placeholders in Collections

Use placeholders within nested collection queries:

```typescript
const getUserHighViewPosts = db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    highViewPosts: u.posts!
      .where(p => gt(p.views!, sql.placeholder('minViews')))
      .select(p => ({
        title: p.title,
        views: p.views,
      }))
      .toList(),
  }))
  .where(u => eq(u.id, sql.placeholder('userId')))
  .prepare('getUserHighViewPosts');

// Get alice's posts with over 100 views
const result = await getUserHighViewPosts.execute({ userId: 1, minViews: 100 });
```

### Placeholders in Subqueries

Prepared statements also work with subqueries:

```typescript
import { gte, inSubquery, sql } from 'linkgress-orm';

// Find users who have posts with views >= minViews
const postsSubquery = db.posts
  .where(p => gte(p.views!, sql.placeholder('minViews')))
  .select(p => p.userId)
  .asSubquery('array');

const usersWithHighViewPosts = db.users
  .where(u => inSubquery(u.id, postsSubquery))
  .orderBy(u => u.username)
  .prepare('usersWithHighViewPosts');

const result = await usersWithHighViewPosts.execute({ minViews: 100 });
```

### Reusing Same Placeholder Name

When the same placeholder name is used multiple times in a query, it references the same parameter value:

```typescript
const searchByAge = db.users
  .where(u => or(
    eq(u.age, sql.placeholder('targetAge')),      // Uses same parameter
    gt(u.age, sql.placeholder('targetAge'))       // Uses same parameter
  ))
  .prepare('searchByAge');

// Both conditions use targetAge = 35
const result = await searchByAge.execute({ targetAge: 35 });
```

### PreparedQuery Utilities

Access information about prepared queries:

```typescript
const prepared = db.users
  .where(u => and(
    eq(u.id, sql.placeholder('userId')),
    gt(u.age, sql.placeholder('minAge'))
  ))
  .prepare('myQuery');

// Get the SQL string (for debugging)
console.log(prepared.getSql());
// SELECT ... FROM "users" WHERE "id" = $1 AND "age" > $2

// Get placeholder names
console.log(prepared.getPlaceholderNames());
// ['userId', 'minAge']

// Query name
console.log(prepared.name);
// 'myQuery'
```

### Error Handling

If a required placeholder parameter is missing, an error is thrown:

```typescript
const getUserById = db.users
  .where(u => eq(u.id, sql.placeholder('userId')))
  .prepare('getUserById');

// This throws an error: "Missing parameter: userId"
await getUserById.execute({});
```

### Complex Example

Here's a comprehensive example combining multiple features:

```typescript
import { and, gt, like, or, sql } from 'linkgress-orm';

// Complex search with multiple optional filters
const advancedSearch = db.users
  .where(u => or(
    and(
      gt(u.age, sql.placeholder('minAge')),
      lt(u.age, sql.placeholder('maxAge'))
    ),
    like(u.username, sql.placeholder('usernamePattern'))
  ))
  .select(u => ({
    id: u.id,
    username: u.username,
    age: u.age,
    postCount: u.posts!.count(),
    recentPosts: u.posts!
      .where(p => gt(p.views!, sql.placeholder('minViews')))
      .orderBy(p => [[p.createdAt, 'DESC']])
      .limit(5)
      .select(p => ({
        title: p.title,
        views: p.views,
      }))
      .toList(),
  }))
  .orderBy(u => u.username)
  .prepare('advancedSearch');

// Execute with specific parameters
const results = await advancedSearch.execute({
  minAge: 25,
  maxAge: 45,
  usernamePattern: 'a%',
  minViews: 50,
});
```

## Performance Tips

### Use Select Projections

Only query the columns you need:

```typescript
// ❌ Fetches all columns
const users = await db.users.toList();

// ✅ Only fetches needed columns
const users = await db.users
  .select(u => ({ id: u.id, username: u.username }))
  .toList();
```

### Index Foreign Keys

Ensure foreign key columns are indexed for efficient JOINs:

```typescript
model.entity(Post, entity => {
  // ...
  entity.property(e => e.userId)
    .hasType(integer('user_id'))
    .hasIndex();  // Creates index for efficient JOINs
});
```

### Use Collection Strategies Wisely

Choose the right strategy for your dataset size. See [Collection Strategies](../collection-strategies.md) for details.

### Limit Collection Results

When loading collections, always consider limiting:

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    recentPosts: u.posts!
      .orderBy(p => [[p.createdAt, 'DESC']])
      .limit(10)  // Only get 10 most recent
      .select(p => ({ title: p.title }))
      .toList('recentPosts')
  }))
  .toList();
```

### Use EXPLAIN ANALYZE

Profile your queries:

```typescript
const query = db.users
  .join(db.posts, (u, p) => eq(u.id, p.userId))
  .select((u, p) => ({ username: u.username, postTitle: p.title }));

// Get the SQL
const sql = query.toSql();
console.log(sql);

// Run EXPLAIN ANALYZE in psql
// EXPLAIN ANALYZE <paste sql here>
```

## Type Safety

All queries maintain full TypeScript type inference:

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    postCount: u.posts!.count()
  }))
  .toList();

// Result type is automatically inferred:
// Array<{
//   id: number;
//   username: string;
//   postCount: number;
// }>

// TypeScript prevents accessing non-existent columns
const invalid = await db.users
  .select(u => ({
    nonExistent: u.invalidColumn  // ✗ TypeScript error
  }))
  .toList();
```

## Examples

### Pagination with Total Count

```typescript
async function getPaginatedUsers(page: number, pageSize: number) {
  const offset = page * pageSize;

  const [users, total] = await Promise.all([
    db.users
      .select(u => ({ id: u.id, username: u.username }))
      .orderBy(u => u.username)
      .offset(offset)
      .limit(pageSize)
      .toList(),
    db.users.count()
  ]);

  return {
    users,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}
```

### Search with Filters

```typescript
async function searchPosts(filters: {
  search?: string;
  categoryId?: number;
  minViews?: number;
  sortBy?: 'recent' | 'popular';
}) {
  let query = db.posts.select(p => ({
    id: p.id,
    title: p.title,
    views: p.views,
    createdAt: p.createdAt
  }));

  if (filters.search) {
    query = query.where(p =>
      like(p.title, `%${filters.search}%`)
    );
  }

  if (filters.categoryId) {
    query = query.where(p => eq(p.categoryId, filters.categoryId));
  }

  if (filters.minViews) {
    query = query.where(p => gte(p.views, filters.minViews));
  }

  if (filters.sortBy === 'recent') {
    query = query.orderBy(p => [[p.createdAt, 'DESC']]);
  } else if (filters.sortBy === 'popular') {
    query = query.orderBy(p => [[p.views, 'DESC']]);
  }

  return query.toList();
}
```

### Dashboard Statistics

```typescript
async function getDashboardStats(userId: number) {
  const user = await db.users
    .where(u => eq(u.id, userId))
    .select(u => ({
      username: u.username,
      totalPosts: u.posts!.count(),
      totalViews: u.posts!.sum(p => p.views),
      avgViews: u.posts!.avg(p => p.views),
      maxViews: u.posts!.max(p => p.views),
      recentPosts: u.posts!
        .orderBy(p => [[p.createdAt, 'DESC']])
        .limit(5)
        .select(p => ({
          title: p.title,
          views: p.views,
          createdAt: p.createdAt
        }))
        .toList('recentPosts'),
      topPosts: u.posts!
        .orderBy(p => [[p.views, 'DESC']])
        .limit(5)
        .select(p => ({
          title: p.title,
          views: p.views
        }))
        .toList('topPosts')
    }))
    .single();

  return user;
}
```

## See Also

- [Data Modification](./data-modification.md) - Insert, update, and delete operations
- [Collection Strategies](../collection-strategies.md) - Optimize collection loading
- [Subquery Guide](./subquery-guide.md) - Advanced subquery patterns
- [CTE Guide](./CTE-GUIDE.md) - Common Table Expressions
- [Schema Configuration](./schema-configuration.md) - Define entities and relationships
- [Prepared Statements](#prepared-statements) - Reusable parameterized queries

## License

MIT
