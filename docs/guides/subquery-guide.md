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

**How the value reads.** A projected scalar subquery reads through the generic conversion, like a
raw `sql` fragment: a numeric-looking string becomes a number (a digits-only text `'007'` reads
`7`) and a NULL reads `undefined`. Two kinds read like the value they project instead:

- ONE aggregate fragment — `select(p => agg.max(p.title))` keeps `'007'`, `agg.max` of a mapped
  column goes through its mapper, and a NULL reads `null`, as the aggregate reads at the top level;
- ONE read-typed fragment — `select(p => sql<string>\`…\`.withReadType('text'))`.

For any other value, type the read yourself: `.asExpression<string>().withReadType('text')` or
`.mapWith(…)` (section 9) — or, for a column of an aliased scope, `AliasedScope.scalar()`.

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

### Alias collisions in correlated subqueries

A correlation is resolved by chain identity, not by name, so a subquery may correlate to an
outer table even when its own navigation happens to carry the same name — common with singular
table names, where a child's `library` navigation points at a table also called `library`.

Two shapes cannot be rendered and are refused at build time rather than returning wrong rows:

```typescript
// 1. Same-table self-correlation — inner and outer FROM would share the alias.
db.posts.where(p => exists(db.posts
  .where(p2 => and(eq(p2.userId, p.userId), gt(p2.views, p.views)))
  .select(p2 => ({ id: p2.id }))
  .asSubquery()));                       // throws: references the same table

// 2. Correlating to an outer table AND traversing a navigation of the same name.
db.libraries.where(l => exists(db.shelves
  .where(s => and(eq(s.libraryId, l.id), eq(s.library!.name, 'Central')))
  .select(s => ({ id: s.id }))
  .asSubquery()));                       // throws: inner join would shadow the outer table
```

For the second, traverse the navigation in the outer query, correlate on a plain key column, or
rename the navigation property.

For the first, a navigation collection is the way out when the model has the relation: a collection
over the same table as the outer row — `exists(p.user!.posts!.where(p2 => gt(p2.views, p.views)))`,
a tree's `n.children` — names its own table apart from the outer row and is not refused (see
[Collections Reached Through Navigations](./querying.md#collections-reached-through-navigations)).

Without such a relation, name the inner side yourself with an **aliased scope** — `db.<table>.as(alias)`
renders its table under the alias you give it, so neither shape can collide (see
[Aliased Subquery Scopes](./aliased-scopes.md)):

```typescript
db.posts.where(p => db.posts.as('rival')
  .where(r => and(eq(r.userId, p.userId), gt(r.views, p.views)))
  .exists());
// EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE ("rival"."user_id" = "posts"."user_id" AND "rival"."views" > "posts"."views"))
```

### Navigations read by a projected subquery

A subquery **projected** by a query reads the enclosing row's navigations the way a WHERE `exists(...)` does:
the enclosing query joins them.

```typescript
db.posts.select(p => ({
  title: p.title,
  nextOlder: db.users.where(u => gt(u.age, p.user!.age)).orderBy(u => u.age).limit(1).select(u => u.username).asSubquery('scalar'),
}));
// SELECT "posts"."title" as "title", (SELECT "users"."username" FROM "users" WHERE "users"."age" > "user"."age" ORDER BY "users"."age" ASC LIMIT 1) as "nextOlder"
// FROM "posts"
// INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
```

(Before 1.0.9 the join was missing — `missing FROM-clause entry for table "user"`.) This holds at any depth of
the projection, through several navigation levels, and in a UNION leg — and in a **collection's item**
(`u.posts.select(p => ({ author: db.users.where(v => eq(v.id, p.userId))…asSubquery('scalar') }))`, every
collection strategy): the subquery renders in parentheses and the collection joins the item's navigations it
reads. (Before 1.0.9 a subquery in a collection's item was bound as a parameter: the item read back the
serialized Subquery object.)

When the subquery reads a navigation PATH that ends in the same relation name as another path the query reads
itself — a loan's own `ln.book` and its `ln.edition.book` — each path is its own join, and the query's own
paths (its projection, WHERE, ORDER BY, the path a collection hangs off) keep the aliases they render under
without the subquery: the subquery's path is the one that takes the path alias (`<parent>__<relation>`, e.g.
`"lib_loans__book"` for a first hop, `"edition__book"` below one). So a raw `sql` fragment naming `"book"` reads
the same join as it did before, and the subquery reads its own path:

```typescript
db.libLoans.select(ln => ({
  printed: ln.edition!.book!.name,                                                           // "book"
  own: db.libBooks.where(b => eq(b.id, ln.book!.id)).select(b => b.name).asSubquery('scalar'),  // "lib_loans__book"
  raw: sql<string>`"book"."name"`,                                                            // the edition's book
}));
```

(Before 1.0.9 such a subquery read the query's join of that name — here the edition's book — without an error.)

### What `exists()` / `notExists()` accept

A subquery (`.select(...).asSubquery()`) or a collection navigation (`u.posts.where(...)`). A
query builder or a table (`db.posts.where(...)`, `db.posts`) is a query of its own and is refused
before anything runs — it used to START that query, then fail with
`this.resolved.getFieldRefs is not a function`:

```typescript
exists(db.posts.where(p => eq(p.userId, u.id)))                                    // throws
exists(db.posts.where(p => eq(p.userId, u.id)).select(() => ({ one: literal(1) })).asSubquery())  // ✓
exists(u.posts!.where(p => gt(p.views, 1000)))                                     // ✓
```

`exists(...)` and `notExists(...)` are fragments: `.as('flag')` / `.mapWith(...)` project them as
columns (before 1.0.9 `.as()` rendered an empty expression).

### 8. Array Membership: `eqAnySubquery` / `neAllSubquery`

`(<field> = ANY (ARRAY(<subquery>)))` — membership in a one-column subquery computed as ONE array
(an uncorrelated subquery is an InitPlan whose array can drive an index condition), not as the
`IN (SELECT …)` semi-join `inSubquery` renders. Parenthesized like every helper, so it stays one
operand when it is compared or combined (`eq(flag, eqAnySubquery(…))`):

```typescript
const activeGenres = db.genres.where(g => eq(g.active, true)).select(g => g.id).asSubquery('array');

db.books.where(b => eqAnySubquery(b.genreId, activeGenres))
// ("books"."genre_id" = ANY (ARRAY(SELECT "genres"."id" FROM "genres" WHERE "genres"."active" = $1)))

db.books.where(b => neAllSubquery(b.genreId, activeGenres))
// ("books"."genre_id" <> ALL (ARRAY(SELECT …)))
```

A NULL field gives NULL; an empty result gives FALSE for `eqAnySubquery` (every row, a NULL field
included) and TRUE for `neAllSubquery`. Only the subquery's own parameters are bound; the field's
references and the subquery's correlation references are reported, so the navigations they read
are joined.

### 9. A Scalar Subquery as an Expression: `asExpression()`

A projected `Subquery` is a value, but not a fragment: it cannot be an operand of `coalesce`, CASE,
arithmetic or a fragment method. `.asExpression()` turns a SCALAR subquery into one —
`(<subquery sql>)` with its parameters in the enclosing statement's sequence and its correlation
references reported:

```typescript
const cityOf = (o: any) => db.addresses.where(a => eq(a.id, o.addressId)).select(a => a.city)
  .asSubquery('scalar').asExpression<string>();

db.orders.select(o => ({ city: coalesce(cityOf(o), 'n/a') }))
db.orders.where(o => isNull(cityOf(o)))
db.orders.where(o => eq(o.id, id)).update(o => ({ shipCity: cityOf(o) }))   // SET "ship_city" = (SELECT …)
```

It carries no mapper: projected, it reads like a raw `sql` fragment (a numeric-looking string
becomes a number, NULL reads `undefined` at the top level). Chain `.withReadType('text')` or
`.mapWith(...)` to type the read. An `'array'` / `'table'` subquery is refused.

### 10. A Subquery as a Comparison Operand

A scalar subquery can stand on either side of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`,
`isNull`, `isNotNull`, `between`, `inArray`, …: it renders `(<subquery sql>)` with its parameters
in textual order, and its correlation references are joined like any other operand's:

```typescript
db.users.where(u => isNull(db.posts.where(p => eq(p.userId, u.id)).select(p => p.id).asSubquery('scalar')))
db.users.where(u => eq(u.id, db.posts.where(p => eq(p.id, 1)).select(p => p.userId).asSubquery('scalar')))
```

(Before 1.0.9 `isNull(subquery)` rendered `"[object Object]" IS NULL`, and `eq(column, subquery)`
bound the Subquery object as a parameter. A collection `count()` compared the same way —
`gt(u.posts!.count(), 1)` — now renders its correlated count too.)

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
