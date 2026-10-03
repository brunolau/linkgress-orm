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

A selector that returns ONE column or expression — not an object — reads as the list of that value:

```typescript
const names = await db.users.orderBy(u => u.username).select(u => u.username).toList();
// string[] — ['alice', 'bob']

const cities = await db.users.select(u => u.address!.city).toList();        // a navigation's column, joined
const loud = await db.users.select(u => sql<string>`upper(${u.username})`).toList();
const first = await db.users.orderBy(u => u.id).select(u => u.email).firstOrDefault();  // string | null
```

The same holds in a collection (`u.posts!.select(p => p.title).toList()` is a `string[]`,
`.firstOrDefault()` a `string | null`), in a union, a batch, `countOver()` and a mutation's RETURNING.
The value reads through its column's mapper. Such a query's SQL still names its column by the column's
name, so it can serve as a subquery or CTE body as before. (A root query used to return empty objects
here, and a collection `{ column: value }` objects.)

A selector returning ONE literal reads as that literal on every row — at the root, in a collection
(`toList()`, `firstOrDefault()`, `toNumberList()`, `toStringList()`) and in UNION legs:

```typescript
await db.users.select(() => 'x').toList();                        // ['x', 'x', 'x']
await db.users.select(u => ({ flags: u.posts!.select(() => 1).toNumberList() })).toList();
```

(A string used to be walked as an object of its characters — `[{ "0": "x" }]` — and a number projected no
column at all.)

A condition placed in a projection selects as a boolean column, at the top level or inside a nested
object:

```typescript
const users = await db.users
  .select(u => ({
    username: u.username,
    isAdult: gte(u.age, 18),                          // boolean
    flags: { hasEmail: isNotNull(u.email) },          // { hasEmail: boolean }
  }))
  .toList();
```

A literal in a projection — `'member'`, `42`, `true`, `null`, a `Date`, a list of values — is a value,
as its type says, and reads back as exactly that value: at the top level, inside a nested object, in a
collection's items, in a grouped query and in a join of one.

```typescript
const rows = await db.users.select(u => ({
  id: u.id,
  kind: 'member',                       // 'member' — bound as a parameter
  since: new Date('2020-01-01'),        // the Date itself
  flags: { vip: false, tier: 2 },       // { vip: false, tier: 2 }
  posts: u.posts!.select(p => ({ title: p.title, source: 'blog' })).toList(),
})).toList();
```

- A **string** is a value too. It used to be taken for a COLUMN NAME: `kind: 'member'` failed
  ("column users.member does not exist") and `kind: 'email'` silently returned the email column. Use
  the column itself (`u.email`) to read one.
- The statement still carries the literal as a parameter, so a query used as a subquery, a CTE body or
  a UNION leg exposes it as a column. In a CTE body and a subquery it renders typed from its JS type
  (`CAST($1 AS boolean)`, an integer, a double, text, a `timestamptz` for a `Date`, jsonb for a list of
  values), so the query reading it sees a boolean, a number, a date (see the
  [CTE guide](./cte-guide.md#how-a-ctes-columns-read-back)). A UNION leg binds it untyped: the database
  hands such a parameter back as TEXT, so a UNION reads each leg's literal from its rows (`42` as `42`,
  `true` as `"true"`) — every leg may project its own. For a discriminator the database should see typed
  and inline, use [`literal('book')`](./sql-expressions.md#literals-typed-nulls-and-conditions-as-values).
- A literal inside a nested object that also holds a `Date` or any other value object stays on the
  flat path (the whole object used to be bound as one JSON parameter, mock column refs and all).
- An array of COLUMNS (`{ pair: [u.id, u.username] }`, `[p.user]`) has no single SQL value and is
  refused, naming the field — build the array in SQL (`sql\`ARRAY[...]\``, `jsonbBuildArray(...)`) or
  select the columns as an object. (It used to vanish from the result, or — nested — be bound as a
  parameter with the column refs serialized into it.) An array of values reads back as itself.

### How Projected Values Read Back

Every value of a projection reads back the way it would at the top level of its own table's query —
through its column's mapper, typed as the driver types its column — wherever the projection puts it:

```typescript
const rows = await db.posts.select(p => ({
  meta: {
    time: p.publishTime,                                   // a mapped column: through its mapper
    name: p.user!.username,                                // text stays text ('01234', not 1234)
    loud: sql<string>`upper(${p.title})`.mapWith(v => `<${v}>`),
    comments: p.postComments!.count(),                     // a count: a number
  },
  author: p.user,                                          // the navigation row, as its columns
})).toList();
```

- **Nested objects** read each value its own way: a column through its mapper, an `sql` expression
  through its `mapWith` (an expression's numeric string — a count, a SUM — as a number), NULL as null.
  (Every numeric-looking string of a nested object used to become a number, and no mapper ran.)
- **A navigation row projected whole** (`author: p.user`, `creator: t.level!.createdBy`, even the
  root row, `me: u`) renders as its columns — flattened like a nested object — and reads back typed and
  mapped: timestamps as `Date`s, mapped columns mapped. It works in `selectDistinct()`, UNION legs,
  futures, prepared statements and next to collections under every strategy. A missing row (a LEFT
  JOIN that found none) reads as an object of nulls. (It used to be ONE `json_build_object`: timestamps
  came back as strings, mappers never ran, a DISTINCT over it failed and a UNION leg read back `"{}"`.)
- **A column read through a navigation** keeps its type: a text or uuid column holding digits stays
  text, a jsonb string stays a string. A numeric column read through a navigation (a decimal, an int8)
  reads as a number, as it always has — at the top level of its own table the driver's string.
- **A column of a CTE or a subquery** reads through the body column's own mapper — see the
  [CTE guide](./cte-guide.md#how-a-ctes-columns-read-back).

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

Chained `.where()` calls are ANDed. A raw `sql` condition as an operand of `and()` / `or()` — or of
that chaining — renders in parentheses of its own, so its text keeps its grouping:
`.where(u => sql\`${u.age} > 40 OR ${u.age} < 30\`).where(u => eq(u.isActive, true))` is
`(("age" > 40 OR "age" < 30) AND "is_active" = $1)`. (Before 1.0.9 it rendered without them, and
AND bound tighter than the fragment's OR.)

**Available Condition Functions:**
- Comparison: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
- Logical: `and`, `or`, `not`
- Pattern matching: `like`, `ilike`, `startsWith`
- Regex: `regexMatches`, `regexMatchesCaseInsensitive`, `regexNoMatch`, `regexNoMatchCaseInsensitive`
- Array: `inArray`, `notInArray`, `eqAny`, `neAll`, `inArrayOpt`, `notInArrayOpt`
- Null checking: `isNull`, `isNotNull`
- JSONB: `jsonbSelect`, `jsonbSelectText`
- Utility: `coalesce`
- Bitmask/Flags: `flagHas`, `flagHasAll`, `flagHasAny`, `flagHasNone`

### Matching a List of Values

Two forms, differing only in how the list reaches the server.

`inArray` / `notInArray` render one placeholder per element:

```typescript
db.orderItems.where(oi => inArray(oi.productPriceId, priceIds));
// "oi"."product_price_id" IN ($1, $2, $3)
```

`eqAny` / `neAll` bind the whole list as a **single** parameter, cast to the
column's declared element type (parenthesized, like every helper, so the predicate stays one operand
wherever it is composed):

```typescript
db.orderItems.where(oi => eqAny(oi.productPriceId, priceIds));
// ("oi"."product_price_id" = ANY($1::integer[]))

db.orderItems.where(oi => neAll(oi.productPriceId, excludedIds));
// ("oi"."product_price_id" <> ALL($1::integer[]))
```

The cast is resolved from the column itself, including through custom mappers —
a `uuid` column yields `::uuid[]`, an enum column `::order_status[]`, a
`serial` column `::integer[]`, and a `char(n)` column `::bpchar[]` (a literal
`char[]` would truncate every value to one character). Columns whose refs carry
no type information, such as CTE columns, stay uncast; PostgreSQL infers the
array type from context there.

Semantics are identical to `inArray` / `notInArray` in every case, empty lists
and NULLs included. An empty list — or a value that is not an array — is a
constant for `inArray` / `notInArray`: `1=0` (no row, a NULL operand included)
and `1=1` (every row). It binds nothing: the operand never reaches the statement,
so the parameters of an expression operand
(`coalesce(jsonbPathText(w.attributes, param('tier', 'text')), '')`) are left out
with it. `eqAny` / `neAll` bind the empty array instead (`= ANY('{}')` is FALSE,
`<> ALL('{}')` TRUE). **Choose on planning:**

| | `inArray` / `notInArray` | `eqAny` / `neAll` |
|---|---|---|
| Parameters | one per element | always one |
| Statement text | changes with list length | fixed |
| Planner estimate | exact row count from the literal list | default selectivity |

So `eqAny` is the better fit for hot lookups whose list length varies and for
lists long enough that the parameter count is itself a cost — it is what makes
such a query reusable as a prepared statement (see
[`preparedStatements`](../database-clients.md)). Keep `inArray` for short lists
in queries you have hand-tuned around the planner's exact estimate.

#### Letting the list length decide: `inArrayOpt` / `notInArrayOpt`

Under `preparedStatements` the choice is really about list length. PostgreSQL
gives a short fixed-length `IN` text a cached generic plan after five
executions, while `= ANY($1)` is re-planned on every call for arrays of up to
about ten elements (its generic plan assumes ~10 elements, so the custom plan
keeps winning) and only settles on a generic plan from roughly 30 elements on.
Above that, every extra `IN` length is one more statement text and one more
cached plan per pooled connection.

`inArrayOpt` picks per call — `inArray` up to a threshold, `eqAny` above it —
and `notInArrayOpt` does the same with `notInArray` / `neAll`:

```typescript
db.widgets.where(w => inArrayOpt(w.slotId, slotIds));
// slotIds.length <= threshold:  "w"."slot_id" IN ($1, $2, $3)
// slotIds.length  > threshold:  ("w"."slot_id" = ANY($1::integer[]))
```

Results match `inArray` / `notInArray` for every list, the empty one included.
The threshold defaults to `8` (`LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD`)
and is process-wide, because the operators are plain functions with no context
in reach inside a `where(...)` lambda. It is set through the `LinkgressConfig`
static class, the public surface for every library-wide setting:

```typescript
import { LinkgressConfig } from 'linkgress-orm';

LinkgressConfig.inArrayOptThreshold = 12;                // property setter
LinkgressConfig.configure({ inArrayOptThreshold: 12 });  // or several settings at once
LinkgressConfig.inArrayOptThreshold;                     // -> 12
new AppDatabase(client, { inArrayOptThreshold: 12 });    // QueryOptions writes the same value
```

`0` sends every non-empty list to the array form. Use `inArrayOpt` wherever the
list comes from data; constant lists (enum members) stay under any sane
threshold and keep their exact-length `IN` text and planner estimate.

#### Collapsing the short band too: `inArrayPadBuckets` (opt-in)

The threshold only collapses lengths *above* it. Below it every list still gets
one placeholder per element, so a family whose lists range over 1…8 elements
leaves eight statement texts on each pooled connection. A bucket ladder rounds
each list up to the next rung and fills the gap by repeating its last element:

```typescript
LinkgressConfig.inArrayPadBuckets = [1, 4, 8];   // off (null) by default

db.widgets.where(w => inArrayOpt(w.slotId, [4, 8, 15]));
// off:            "w"."slot_id" IN ($1, $2, $3)         params [4, 8, 15]
// with [1, 4, 8]: "w"."slot_id" IN ($1, $2, $3, $4)     params [4, 8, 15, 15]
```

Repeating a value keeps the results identical — `x IN (a, b, b)` selects what
`x IN (a, b)` does, and the same holds for `NOT IN`, so `notInArrayOpt` pads
the same way. Padding with `NULL` would not: PostgreSQL recognises that a NULL
element matches nothing, which changes the row estimate and, for `NOT IN`, the
result.

Pick the rungs knowing that a widened statement is planned for its rung rather
than for the list that arrives. Measured on PostgreSQL 18, that is free from
three elements up but costs about 32 % on single-element lists and 26 % on
two-element ones — so keep the low rungs tight and collapse the rest. `[1, 2, 8]`
pays nothing; `[1, 4, 8]` accepts the two-element case for the same text count.

An empty list keeps its constant, since there is no element to repeat, and a
list longer than the top rung is widened to the threshold — raising the
threshold extends the ladder instead of dropping lengths out of it.

#### Applying it to plain `inArray`: `inArrayUsesOpt` (opt-in)

Everything above only reaches the call sites that were written as `inArrayOpt`.
In a codebase that already calls `inArray` in hundreds of places, that is a
rewrite standing between you and the statement-text economy — and a rewrite that
never quite finishes, because the next feature branch reaches for `inArray`
again.

One switch closes that gap:

```typescript
LinkgressConfig.inArrayUsesOpt = true;               // off by default

db.widgets.where(w => inArray(w.slotId, slotIds));   // plain inArray…
// slotIds.length <= threshold:  "w"."slot_id" IN ($1, $2, $3)
// slotIds.length  > threshold:  ("w"."slot_id" = ANY($1::integer[]))
```

With it on, `inArray` and `notInArray` render exactly what `inArrayOpt` and
`notInArrayOpt` render — same threshold, same bucket ladder, same array form
above it. The rows a query returns never change; only its statement text does,
which is why this is safe to flip for a whole process rather than per call site.

Leave it off when hand-tuned queries depend on the planner seeing an exact-length
`IN` list — with the switch off, `inArray` is the literal exact-length operator
it has always been, and explicit `inArrayOpt` calls keep working either way. The
two operators stay distinct in the source, so a query you want pinned to exact
placeholders can be moved back by turning the switch off and adopting
`inArrayOpt` per call site instead.

```typescript
LinkgressConfig.inArrayUsesOpt;                          // -> true
LinkgressConfig.configure({ inArrayUsesOpt: true });     // or several settings at once
new AppDatabase(client, { inArrayUsesOpt: true });       // QueryOptions writes the same value
```

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

Every `orderBy()` — of a table, a projection, a collection, a grouped query, a union — takes the same
forms:

| Form | Example | Orders by |
|---|---|---|
| one key | `u => u.name` | `name ASC` |
| keys | `u => [u.role, u.name]` | each ascending |
| `[key, direction]` pairs | `u => [[u.role, 'DESC'], [u.name, 'ASC']]` | as given |
| one flat pair | `u => [u.name, 'DESC']` | `name DESC` |
| pairs and keys mixed | `u => [[u.role, 'DESC'], u.name]` | `role DESC, name ASC` |
| a pair without direction | `u => [[u.name]]` | `name ASC` |

A direction is `ASC` or `DESC`, optionally followed by `NULLS FIRST` / `NULLS LAST` (`'DESC NULLS LAST'`),
in any case and spacing. PostgreSQL's defaults apply otherwise: NULLs sort last ascending and first
descending.

```typescript
const members = await db.members
  .orderBy(m => [[m.favoriteBookId, 'ASC NULLS FIRST'], m.name])
  .toList();
```

A key that is `false`, `null` or `undefined` is left out, so a key can depend on a condition:

```typescript
const users = await db.users
  .orderBy(u => [byRole && [u.role, 'DESC'], u.name])
  .toList();
```

Anything else that is not a key is refused with the reason, where it used to be dropped from the
ORDER BY without a word: a string (a column NAME — `'name'` — or a direction on its own), a number (an
ORDER BY position), `true`, a function, a whole navigation row (`u => u.company` — order by one of its
columns), a direction that is none, a pair of more than two values.

A key can be a column of a navigation, before or after `select()`. Before it, the navigation is
joined for the ORDER BY alone; after it, a key can be a projected column, a leaf of a nested object,
a `sql` fragment, or a column of a navigation row projected whole:

```typescript
// Before select(): ordered by the book the loan's edition prints, then by the note
const loans = await db.loans
  .orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.note, 'DESC']])
  .select(ln => ({ note: ln.note }))
  .toList();

// After select()
const rows = await db.loans
  .select(ln => ({ note: ln.note, printed: { book: ln.edition!.book!.name }, own: ln.book }))
  .orderBy(r => [r.printed.book, r.own.name])
  .toList();
```

A key keeps meaning the column it was written against: when a later `select()` renames or drops
it, the query still orders by that column (and joins its navigation). A navigation keyed on a
principal key other than `id` joins on that key; a missing (NULL) navigation sorts like NULL. Each
`orderBy()` replaces the previous ordering — only the last one's navigations are joined.

A key can also be an SQL expression — a `sql` fragment, a condition, or a collection's `count()` /
`exists()`. It renders parenthesized, its parameters numbered with the query's, and the navigations it
reads are joined:

```typescript
const loans = await db.loans
  .orderBy(ln => [
    [sql<number>`position(${'x'} in ${ln.note})`, 'DESC'],  // a bound parameter
    [eq(ln.note, 'urgent'), 'DESC'],                         // a condition: TRUE first
    [ln.id, 'ASC'],
  ])
  .toList();

const busiest = await db.members
  .orderBy(m => [[m.loans!.count(), 'DESC']])
  .select(m => ({ name: m.name }))
  .toList();

// After select(), a fragment reads a projected COLUMN as that column — also under a path alias
const rows = await db.loans
  .select(ln => ({ id: ln.id, printed: ln.edition!.book!.name }))
  .orderBy(r => [[sql<string>`lower(${r.printed})`, 'ASC']])
  .toList();
```

A fragment written after `select()` cannot read a projected fragment or literal — there is no column
behind it, and an output alias is visible to ORDER BY only standing alone. Order by that value itself
(`orderBy(r => r.shout)`), or build the expression from its columns; `orderBy()` throws, naming the value.

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

`count()` counts the rows the query selects. A select of aggregate fragments without `groupBy()`
(`select(() => ({ n: agg.count() }))`) is always ONE row, so its `count()` is refused.

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

The keys are columns of the collection's item — whether the projection selects them or not, under
the same name or another — or of its navigations (`p.category!.name`), or SQL expressions over them
(`sql\`lower(${p.title})\``, a condition, a nested collection's `count()`). Written after `select()`, as
above, the selector reads the projection: a field reads as the value it projects, so one that renames a
column (`select(p => ({ heading: p.title })).orderBy(p => p.heading)`) orders by that column and a
projected expression by that expression, while a name the projection does not select still reads the
item's column. (Before 1.0.19 a key written after `select()` read the item: a renamed field was dropped
from the ORDER BY without a word, or read the item's own column of that name.) `limit()` / `offset()` apply
per parent row, and a count, sum, min / max or flat list of a limited collection aggregates the rows
the ordered, limited collection yields. Every collection strategy returns the same order. A
`selectDistinct()` collection can only be ordered by values it selects; ordering it by anything else
fails — linkgress refuses it naming the key, or, for a LATERAL list of objects, PostgreSQL refuses the
statement.

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

`min()`, `max()` and `sum()` also aggregate an `sql` expression of the item — with its parameters, the
navigations it reads joined, the collection's `where()` / `orderBy()` / `limit()` applied, under every
strategy, nested in another collection, and in a mutation's RETURNING:

```typescript
db.users.select(u => ({
  longestTitle: u.posts!.max(p => sql<number>`length(${p.title})`),
  weighted: u.posts!.where(p => gt(p.views, 0)).sum(p => sql<number>`${p.views} * ${2}`),
}));
```

(Such a selector used to throw "MAX requires an aggregate field".) An `sql` expression in a collection's
items reads through its `mapWith`, as it does at the top level.

### Collections Reached Through Navigations

A collection may hang off any chain of reference navigations — including one leading back to the
table the query reads, and a relation of a table to itself:

```typescript
const loans = await db.loans
  .select(ln => ({
    note: ln.note,
    printedBookEditions: ln.edition!.book!.editions!.count(),  // editions of the edition's book
    memberLoans: ln.member!.loans!                             // every loan of the same member
      .select(x => ({ note: x.note }))
      .toList('memberLoans'),
  }))
  .toList();

const nodes = await db.nodes
  .select(n => ({
    name: n.name,
    children: n.children!.select(c => ({ name: c.name })).toList('children'),
    siblings: n.parent!.children!.select(c => ({ name: c.name })).toList('siblings'),
  }))
  .toList();
```

A row whose navigation is missing gets the empty value (`[]`, `0`, `null`). A relation keyed on a
principal key other than `id` joins on that key, and a table in another schema is read
schema-qualified.

### Comparing Items With the Enclosing Row

A collection's `where()`, projection and ORDER BY may read the row it hangs off — the root row, or
the item of an enclosing collection:

```typescript
const members = await db.members
  .select(m => ({
    name: m.name,
    loans: m.loans!.select(ln => ({
      note: ln.note,
      // the member's loans made after this one
      laterLoans: ln.member!.loans!.where(x => gt(x.id, ln.id)).count(),
    })).toList('loans'),
  }))
  .toList();
```

Such a collection cannot be aggregated apart from that row, so under the `cte` and `temptable`
strategies it renders as a LATERAL subquery, with the same results.

## GROUP BY

Project the rows, group the projection by a key object, then select the key and aggregates:

```typescript
const postsByUser = await db.posts
  .select(p => ({ userId: p.userId, views: p.views, title: p.title, author: p.user!.username }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    postCount: g.count(),          // number
    totalViews: g.sum(r => r.views),
    avgViews: g.avg(r => r.views),
    lastTitle: g.max(r => r.title), // string
    author: g.max(r => r.author),
  }))
  .toList();
```

### Keys

A key is a column of the projection — also one read through a navigation — or an SQL expression
(`sql\`date_trunc('day', ${p.createdAt})\``). Grouping by an expression groups the rows of a subquery
that computes it once; everything below works the same over it.

### Aggregates

`count()`, `sum()`, `avg()`, `min()` and `max()`. The argument is a column of the projection or an SQL
expression over it — `g.max(r => sql\`length(${r.title})\`)`, `g.sum(r => sql\`${r.views} * 2\`)`.

- COUNT reads as a number, SUM and AVG as numbers (cast to double precision).
- MIN / MAX read as a value of their column: text as a string, a timestamp as a Date, a mapped column
  through its mapper (a grouped CTE or subquery keeps that mapper), a numeric column as a number. Of
  an SQL expression, a number-looking value reads as a number, anything else as it is. (They all
  used to go through `Number()`: a text or timestamp extreme came back `NaN` / epoch milliseconds.)

A projected value can also be an SQL expression over keys and aggregates, a constant, or `null`:

```typescript
.select(g => ({
  userId: g.key.userId,
  perPost: sql<number>`${g.sum(r => r.views)} / ${g.count()}`,
  kind: 'author-stats',
}))
```

A nested object, or any other value, is refused naming the field — it used to be left out of the
result without a word.

### HAVING

`having()` filters the groups. Its callback receives the group as columns, so aggregates and keys go
into conditions as they are — no cast:

```typescript
const prolific = await db.posts
  .select(p => ({ userId: p.userId, views: p.views, title: p.title }))
  .groupBy(r => ({ userId: r.userId }))
  .having(g => and(
    gt(g.count(), 5),
    or(gt(g.sum(r => r.views), 1000), lt(g.min(r => r.title), 'B')),
  ))
  .select(g => ({ userId: g.key.userId, posts: g.count() }))
  .toList();
```

Any condition works: `and` / `or` / `not`, `between`, `inArray`, `isNull`, an aggregate on either side
of a comparison (`gt(g.max(r => r.views), g.min(r => r.views))`), a grouping key (`eq(g.key.userId, 7)`),
an `sql` fragment (`sql\`${g.count()} > ${5}\``), an aggregate of a navigation column. `having()` can be
called before or after `select()`, and repeatedly: the conditions are combined with AND. Its callback
runs when the query is built, over the same group the projection reads.

### ORDER BY, LIMIT

A grouped query orders by what it projects — a key or an aggregate by its output alias:

```typescript
const top = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, total: g.sum(r => r.views) }))
  .orderBy(r => [[r.total, 'DESC NULLS LAST'], r.userId])
  .limit(10)
  .toList();
```

An `sql` expression written inside `orderBy()` is refused — project it and order by that field.

### In a QueryBatch

A grouped query — and a grouped query joined to a CTE or a subquery — has the future API of a plain
select: `future()`, `futureFirstOrDefault()` and `futureCount()`. So it joins a `QueryBatch` and is read
in the batch's one round trip, next to everything else:

```typescript
const perDay = db.posts
  .select(p => ({ day: dateTrunc('day', p.createdAt), views: p.views }))
  .groupBy(r => ({ day: r.day }))
  .select(g => ({ day: g.key.day, posts: g.count(), views: g.sum(r => r.views) }))
  .orderBy(r => r.day);

const batch = new QueryBatch();
const pageKey = batch.addList(perDay.limit(10), 'perDay');  // { day: Date; posts: number; views: number }[]
const daysKey = batch.addCount(perDay, 'days');             // the number of groups
const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, id)).select(u => u), 'user');
await batch.executeBatch();
```

A batched grouped query reads exactly what its `toList()` / `firstOrDefault()` reads through the same
client — the same values of the same JS types, in the same key order: an int8 / numeric key as the driver
delivers it (its exact text, by default), a date or timestamp key (a column, or an expression such as
`dateTrunc()` / `castAsDate()`) as the client's parser makes it (a Date, by default; its text under a
pass-through parser), bytea as a Buffer, a mapped column through its mapper. The batch sends each such value
as its text with its type, which the client parses as its driver parses the type, so an untyped `sql`
expression reads as it does standalone too (see [QueryBatch](#querybatch-several-reads-in-one-round-trip),
with its known limitations).
`futureCount()` counts the groups the HAVING keeps, past the query's ORDER BY / LIMIT / OFFSET — as a plain
select's `futureCount()` counts its rows past its paging.

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

### How a Joined Table's Columns Read

A column of a manually joined table (`leftJoin` / `innerJoin` of a table — also of the queried table itself,
also joined twice, also inside a CTE) reads as a column of ITS table, exactly as the same column read through a
navigation: through its own mapper (`hasCustomMapper()`), as its own SQL type (a text of digits stays text, a
date / timestamp is what the client's parser makes of one — through a `QueryBatch` too). A condition on it
binds its value through that mapper. A plain comparison or an ORDER BY on it renders as before; a helper that
types its SQL by a column's declared type (the `eqAny()` / `neAll()` array cast, the `flag*` mask casts,
`agg.arrayAgg()` / `unnest()` element types) renders for it as for a column of the queried table.

```typescript
const jobs = await db.jobs
  .leftJoin(db.machines, (job, machine) => eq(job.machineId, machine.id), (job, machine) => ({
    title: job.title,
    serviceInterval: machine.service,   // the machine column's mapper — { hours: 1, minutes: 30 }
    installedAt: machine.installedAt,   // a Date
  }))
  .where(r => gt(r.serviceInterval, { hours: 1, minutes: 0 }))  // bound through that mapper: 60
  .toList();
```

### Navigation Joins and Their Aliases

A reference navigation (`ln.edition.book.name`) is joined for you: one `LEFT JOIN` per hop (an
`INNER JOIN` for a required relation), each on its own parent table. A hop renders under its
relation name (`"edition"`, `"book"`), which is also the alias to use in a raw `sql` fragment. When
two navigation paths in one query end in the same relation name, such as `ln.book` (the loan's own
book) and `ln.edition.book` (the book the edition prints), each still gets its own join. The
shallowest path keeps the plain name (on a tie, the one that appears first, projection before
`where`), and every other path renders as `<parentAlias>__<relation>`:

```typescript
const rows = await db.loans
  .select(ln => ({
    ownBook: ln.book!.name,                              // "book"."name"
    printedBook: ln.edition!.book!.name,                 // "edition__book"."name"
    printedCategory: ln.edition!.book!.category!.name,   // "category"."name", joined on "edition__book"
  }))
  .toList();
```

A raw fragment naming `"book"` therefore always means the shallowest `book` path. Inside a
collection the same rule applies within the collection's own subquery, under every collection
strategy. A name the collection reads from an enclosing row (the hops of the path it hangs off, or a
navigation the enclosing row's own columns are read through) is never reused for one of the
collection's own navigations: that navigation renders under a path alias instead.

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

### Reading a Fragment's Value: `mapWith`

`.mapWith(fn)` reads the fragment's driver value through `fn` (null stays null) — at the top level,
inside nested objects, in a collection's items, in a grouped query and in any mutation's
`.returning()`. The fragment's value type is what `fn` returns; `.mapWith(customType)` takes a
mapper object with `fromDriver` / `toDriver` instead — one declared `immutable: true` shares each
distinct value's mapped value within the result set (see [Immutable Values](./schema-configuration.md#immutable-values-immutable-true)),
which an inline `fn` never does:

```typescript
const rows = await db.orders.select(o => ({
  total: sql<string>`sum(${o.amount})`.mapWith(Number),                 // SqlFragment<number>
  tag: sql`upper(${o.code})`.mapWith(value => `#${value}`),              // SqlFragment<string>
})).toList();
```

In a SELECT, a fragment WITHOUT a mapper reads through the generic conversion of untyped values: a
numeric-looking string becomes a number and NULL `undefined` — `.mapWith(String)` keeps text as text.
(A mutation's `.returning()` hands such a fragment's value over as the driver delivers it.)

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

### Executing a Fragment

`db.query()` takes a fragment as well as SQL text. Interpolated values are sent as parameters, nested
fragments and `sql.join()` share one parameter numbering, and `sql.raw()` text is inlined as written, so a
raw statement needs no hand-numbered `$1`, `$2`. It returns the rows, like the text form:

```typescript
import { sql } from 'linkgress-orm';

const minAge = 18;
const adults = await db.query<{ id: number; username: string }>(
  sql`SELECT id, username FROM users WHERE age >= ${minAge} ORDER BY id`
);

// The transactional context takes fragments too
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE users SET age = age + ${1} WHERE id = ${adults[0].id}`);
});
```

Pass arrays and JSON as ordinary values with an explicit cast (`${ids}::int[]`,
`${JSON.stringify(doc)}::jsonb`). A named `sql.placeholder()` is refused here: it only binds inside a
prepared query (see [Prepared Statements](#prepared-statements)). The client-level `querySimple()` /
`querySimpleMulti()` still take text only, because the simple protocol that runs several statements in
one call cannot carry parameters.

## Built-in Operators

Linkgress provides type-safe operators for common SQL operations. The
[SQL Expression Helpers](./sql-expressions.md) guide covers the rest of the built-in
expression vocabulary: casts (`castAsInt()`, `.cast('numeric(12, 2)')`), `caseWhen` / `caseOf`,
`greatest` / `least` / `nullIf`, `isDistinctFrom`, string / math / date-time functions, JSONB
paths and mutations (`jsonbPathText`, `jsonbSet`, `jsonbContains`, …) and array-column operators
(`arrayContains`, `arrayOverlaps`, …).

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

**Flag Operator Reference** (each predicate renders as ONE parenthesized expression, so it can be
compared or combined like a column — `eq(u.isAdmin, flagHas(u.permissions, Permission.Admin))`):
- `flagHas(column, flag)` - Check if flag is set: `((column & flag) != 0)`
- `flagHasAll(column, flags)` - Check if ALL flags are set: `((column & flags) = flags)`
- `flagHasAny(column, flags)` - Check if ANY flag is set: `((column & flags) != 0)`
- `flagHasNone(column, flag)` - Check if flag is NOT set: `((column & flag) = 0)`

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

### Normalized (accent/case-insensitive) search

These helpers wrap both operands in `public.search_normalize()` — a `lower(unaccent(...))`
function the ORM creates during migration — so `"José"`, `"jose"` and `"JOSÉ"` all match.
For best performance, back the column with an [`ixNormalized` index](./schema-configuration.md#normalized-accentcase-insensitive-indexes);
if you query without one, call `model.useSearchNormalize()` in `setupModel` so the function exists.

```typescript
import { normalizedEq, normalizedLike, normalizedStartsWith, searchNormalize, containsSearch } from 'linkgress-orm';

// equality, ignoring accents and case
await db.users.where(u => normalizedEq(u.email, 'José')).toList();
// → WHERE (public.search_normalize("email") = public.search_normalize($1))

// prefix match (the wildcard is appended after normalization)
await db.users.where(u => normalizedStartsWith(u.name, 'jo')).toList();
// → WHERE (public.search_normalize("name") LIKE public.search_normalize($1) || '%')

// substring search — build the pattern with containsSearch / startsWithSearch / endsWithSearch
await db.users.where(u => normalizedLike(u.name, containsSearch(query))).toList();
// → WHERE (public.search_normalize("name") LIKE public.search_normalize($1))   -- $1 = '%query%'

// low-level building blocks inside a sql`` template
await db.users
  .where(u => sql<boolean>`
    ${searchNormalize(u.name)} LIKE ${searchNormalize(containsSearch(query))}
  `)
  .toList();
```

| Function | Description |
|----------|-------------|
| `normalizedEq(field, value)` | `(search_normalize(field) = search_normalize(value))` |
| `normalizedLike(field, pattern)` | `(search_normalize(field) LIKE search_normalize(pattern))` (pass your own wildcards) |
| `normalizedStartsWith(field, value)` | prefix match; `'%'` appended after normalization |
| `searchNormalize(fieldOrValue)` | `public.search_normalize(...)` as a composable `SqlFragment` |
| `containsSearch` / `startsWithSearch` / `endsWithSearch` | build `%x%` / `x%` / `%x` LIKE patterns |

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

The ranking functions are built in — `win.rowNumber()`, `win.rank()`, `win.denseRank()`, each with
`.over({ partitionBy, orderBy })` (see [SQL Expression Helpers](./sql-expressions.md#window-functions-win)):

```typescript
import { win } from 'linkgress-orm';

// Row number partitioned by category
const rankedPosts = await db.posts
  .select(p => ({
    id: p.id,
    title: p.title,
    categoryId: p.categoryId,
    views: p.views,
    rank: win.rowNumber().over({ partitionBy: p.categoryId, orderBy: [[p.views, 'DESC']] }),
  }))
  .toList();
```

A window value cannot be filtered by the query that computes it (PostgreSQL computes it after WHERE):
compute it in a CTE and filter where the CTE is read — `db.selectFromCte(cte).where(r => eq(r.rank, 1))`.

Any other window expression — an aggregate with `OVER`, `lag` / `lead`, a frame — is a raw `sql` template:

```typescript
import { sql } from 'linkgress-orm';

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

## QueryBatch: Several Reads in One Round Trip

`QueryBatch` runs independent reads — lists, first rows, counts — as ONE statement (a `UNION ALL` of JSON
envelopes, each query planned on its own), so a screen that needs five reads pays one round trip:

```typescript
import { QueryBatch } from 'linkgress-orm';

const batch = new QueryBatch();
const postsKey = batch.addList(db.posts.where(p => eq(p.userId, id)).select(p => ({ id: p.id, title: p.title })), 'posts');
const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, id)).select(u => u), 'user');
const perDayKey = batch.addList(postsPerDay, 'perDay');               // a grouped query
const commentsKey = batch.addCount(db.comments.where(c => eq(c.userId, id)), 'comments');
await batch.executeBatch();

batch.getList(postsKey);       // { id: number; title: string }[]
batch.getItem(userKey);        // the user, or null
batch.getCount(commentsKey);   // number
```

A select (`future()` / `futureFirstOrDefault()` / `futureCount()`), a union (`future()`), a grouped query and
a grouped join (see [GROUP BY › In a QueryBatch](#in-a-querybatch)) join a batch. Every query of one batch
runs on one context — one client, or one transaction; a query with a `withTimeout()` of its own runs on its
own executor and is refused. A batch is executed once.

### What a batched query reads

What the same query reads on its own THROUGH THIS CLIENT: the same values of the same JS types, as its
driver delivers them under the client's configuration — the driver's defaults, or parsers of the
application's own (a postgres.js `types` entry, a node-postgres pool's `types` or `pg.types.setTypeParser()`,
PGlite `parsers`). The rows travel as JSON, which carries an integer, a text, a boolean or a `json` document
as the drivers deliver it, but not a date, an int8 or bytea. So the batch sends each value it cannot carry
that way as its PostgreSQL TEXT — as the wire protocol sends it, its type's output — alongside the row, with
its type once for the query, and the client parses that text exactly as its driver parses a column of the
type (`DatabaseClient.parseTypedText()`: postgres.js, node-postgres and PGlite through their own parsers;
Bun, which exposes none, by reproducing its decoding — `bigint: true` included, and through its binary
protocol for a query that binds parameters, as Bun reads one). A client that reads timestamps as their text
(a pass-through parser) reads a batched timestamp as that text; one that reads an int8 as a `BigInt` reads a
batched int8 as a `BigInt`.

The values sent as their text are those of the types JSON cannot carry as the drivers deliver them — `date`,
`time`, `timetz`, `timestamp`, `timestamptz`, `interval`, `int8`, `numeric`, `money`, `bytea`, `point`,
`circle` and their arrays — of a user-defined type (an enum, a composite, an extension's type; a domain as
the type it is over, so a domain over integer keeps its JSON number), and of every type the client parses
with a parser of its own. Which values those are:

- a value only PostgreSQL knows the type of — an expression (`dateTrunc()`, `castAsDate()`, `castAsBigInt()`,
  `coalesce()`, `atTimeZone()`, `lower()`, `agg.arrayAgg()`, a raw `sql`), a mapped expression (`mapWith()`:
  its mapper gets what the client delivers), an `agg.min` / `agg.max`, a scalar subquery, a collection's
  MIN / MAX, a CTE's expression column, a UNION column whose legs declare different types (a date in one, a
  timestamp in another) — by its runtime type (`pg_typeof`), tested row by row;
- a read-typed expression (`withReadType()`) — also as the one value of a scalar subquery or a CTE's column —
  and a column of a CTE, a table subquery, a set (`crossJoinLateral`) or a manually joined table, by the type
  it declares;
- a column of a parameterised or aliased declared type (`bigserial`, `numeric(12,2)`, `timestamp(3)`,
  `timestamp with time zone`), through its mapper when it has one;
- a declared `bigint` / `numeric` / `decimal` column: always as its text (a JSON number would lose its
  precision), which the client parses — the driver's exact text, unless the client parses the type itself.

A plain select's declared `timestamp`, `timestamptz`, `date` or `bytea` column (of the query's table or a
navigation) is restored from its JSON form as 1.0.10 restored it: a Date by the DEFAULT drivers' rules, bytea
as a Buffer, and for a custom mapper the driver's text form — whatever the client's parsers (see the known
limitations).

A query with no value to send as its text — columns of the types JSON carries, those declared date /
timestamp / bytea columns, counts, sums, conditions, numeric results (`agg.count()` / `sum()` / `avg()`,
`round()`, a numeric `literal()`), `withReadType()` expressions of a type JSON carries (text, integer,
boolean, json, …), a UNION whose legs agree — is sent exactly as in 1.0.10, byte for byte. A query with one
sends its rows as such a query does (`row_to_json`: a `json` value untouched — a `\u0000`, a lone surrogate
— and every object's keys, a collection's items' included, in their order), the texts of the values that need
one alongside each row, and each such value's type once, over its query wrapped as
`(SELECT * FROM (…) OFFSET 0)` so that PostgreSQL evaluates the query once per row as on its own. (A query
with declared int8 / numeric columns is one of these now: 1.0.10 merged their texts into a `jsonb` row; the
values are the same.)

That costs, per query, a header of about 60 bytes plus about 10 per value sent as text, and one catalog
lookup (for the values that are domains); per row, one type test per runtime-typed value, and the texts that
are needed. A text a value repeats is parsed once for the query's result: every row still gets a value of its
own — a Date is copied for each row, even when the parser returned one Date it shares between texts (a parser
that caches its results) — and a value its parser makes into anything but a string, a number, a boolean, a
bigint, null or a plain Date (a Buffer, an interval object, a custom parser's object, a frozen Date) is parsed
row by row, as is a text a client's own json parser made into something else. Measured on PostgreSQL 18: a
correlated scalar subquery per row (400 rows over 20 000) runs once per row, 244 ms, as on its own (235 ms;
without the `OFFSET 0` wrapper PostgreSQL would evaluate it at every reference, 1 184 ms); 50 000 rows of one
`lower(md5(…))` take 67 ms where 1.0.10's envelope took 59 ms (ordered: 63 ms and 61 ms). A query sends as
many values as text in a batch as it selects on its own (a PostgreSQL target list holds 1 664 entries).

### Known limitations of the JSON transport

- A plain select's **declared `timestamp` / `timestamptz` / `date` / `bytea` column** is restored by the
  default drivers' rules, as in 1.0.10 (see above): a client with parsers of its own for these types — a text
  pass-through, say — reads such a column otherwise on its own. A custom mapper of such a column
  (`hasCustomMapper()`) gets the driver's TEXT form in a batch (`'2024-03-01 06:00:00'`), the convention of
  apps that configure timestamp pass-through; a client whose driver parses timestamps into Dates hands that
  mapper a Date when the query runs on its own. Read through an expression (``sql`${column}` ``), such a
  column is parsed as the client parses it.
- A **collection's list** — `toList()`, `toNumberList()`, a `withAggregation()` list — travels as the JSON the
  query builds for it; where the query itself reads a list as a native array (`toNumberList()` on a client
  that decodes arrays), a date or timestamp element arrives as its ISO text and an int8 / numeric element as
  a JSON number.
- A **`withReadType()`** travels as the type it declares: declare the type the expression HAS. A value declared
  as a type JSON carries (text, integer, …) that is not of that type arrives as its JSON form.
- A **domain** over a domain is read by the type the outer domain is over (one level).

## Prepared Statements

Prepared statements allow you to build a query once and execute it multiple times with different parameter values. This is useful for:
- **Query building optimization** - Build SQL once, execute many times
- **Type-safe placeholders** - Named parameters with validation
- **Developer ergonomics** - Cleaner API for reusable queries

> **This is the client-side form.** `.prepare('name')` + `sql.placeholder()` builds the SQL once
> in your process. Whether that statement is then sent to PostgreSQL as a NAMED server-side
> prepared statement (so the server keeps its parse tree and plan) is a separate, opt-in setting:
> `preparedStatements` on the context, `.withPreparedStatements(true | false)` per query — see
> [Configuration & Options](./configuration.md#server-side-prepared-statements-opt-in). The two
> are independent and work together.

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

### Values That Are Not Placeholders

Every other value the query binds — a literal operand (`eq(u.isActive, true)`), a `param()`, a
CTE's parameters — is bound on every execution with the value it had when the query was prepared;
only the placeholders change:

```typescript
const activeFrom = db.users
  .where(u => and(eq(u.isActive, true), gte(u.age, sql.placeholder('minAge'))))
  .prepare('activeFrom');   // $1 = true (fixed), $2 = minAge

await activeFrom.execute({ minAge: 30 });
```

(Before 1.0.9 those values were sent as NULL: `eq(u.isActive, true)` in a prepared query matched no
row.)

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

### Tune Execution Per Query

Any query — including one a helper receives already built — can override the context's execution
policy at any point of the chain:

```typescript
// Server-side prepared statements: off for this one (variable text), on for a hot lookup
await grid.orderBy(o => o.createdAt).limit(25).offset(250).withPreparedStatements(false).toList();
await db.tokens.withPreparedStatements(true).where(t => eq(t.value, token)).firstOrDefault();

// Cancel after 5s (throws QueryTimeoutError); 0 disables the connection default
await db.reports.withTimeout(5000).toList();

// Not a cancellation: just a budget for the onQueryTakingTooLong callback
await db.reports.expectedExecutionTime(30000).toList();

// Any QueryOptions for this chain only
await db.users.withQueryOptions({ collectionStrategy: 'temptable' }).select(/* … */).toList();
```

`.withPreparedStatements()` is available on the table, on `QueryBuilder` / `SelectQueryBuilder`,
and on `JoinQueryBuilder`; on a grouped chain, set it before `.groupBy()`. It covers every
execution of that builder (`toList`, `count`, `countOver`, `firstOrDefault`, …).

See [Configuration & Options](./configuration.md) for defaults and trade-offs.

### Keep Statement Text Stable

Under `preparedStatements`, every distinct statement text is another cached plan in every pooled
connection. `inArrayOpt` / `notInArrayOpt` bound how many texts a list lookup produces, and
`LinkgressConfig.inArrayPadBuckets` collapses the short band on top of that — see
[Matching a List of Values](#matching-a-list-of-values).

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

- [Insert/Update/Upsert/BULK](./insert-update-guide.md) - Insert, update, and delete operations
- [Configuration & Options](./configuration.md) - Prepared statements, timeouts, logging, and every other switch
- [Collection Strategies](../collection-strategies.md) - Optimize collection loading
- [Subquery Guide](./subquery-guide.md) - Advanced subquery patterns
- [CTE Guide](./cte-guide.md) - Common Table Expressions
- [Schema Configuration](./schema-configuration.md) - Define entities and relationships
- [Prepared Statements](#prepared-statements) - Reusable parameterized queries (`sql.placeholder()`)

## License

MIT
