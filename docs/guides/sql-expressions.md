# SQL Expression Helpers

> **For agents:** Which typed helper writes a given SQL expression (cast, literal, bound parameter, CASE, NULL handling, string, math, date/time, JSONB, array column, aggregate, window), what SQL does it render, and what JS value comes back?
> **Use this page when:** a projection, filter, sort key, group key or UPDATE value needs more than a plain column, or you are about to write a raw `sql` template. **Look elsewhere when:** comparing a column with values (`eq`, `inArray`, `like`, regex, flags, accent-insensitive search) → [Querying](./querying.md); turning an array or a JSON document into rows → [Set-returning functions](./set-returning-functions.md)
> **Key APIs:** `cast` · `castAsInt` · `literal` · `param` · `caseWhen` · `coalesce` · `concatWs` · `round` · `add` · `dateTrunc` · `jsonbPathText` · `jsonbContains` · `jsonbSet` · `arrayContainsAll` · `arrayAppendUnique` · `agg` · `win` · `withReadType` · **Round trips:** none of their own: a helper renders inside the statement that uses it.

Every helper is exported from `linkgress-orm`. The expression helpers return an `SqlFragment`; `jsonbArraySome()`
returns a `Condition`, and `caseOf()` returns a builder that becomes a fragment at its first `.when()`. The examples run
on the example model (`AppDatabase`: `users`, `posts`, `orders`, …; users alice 25, bob 35, charlie 45; posts with 100,
150 and 200 views; orders of 99.99 and 149.99; every column and seed row in
[Example Model and Seed Data](../example-model.md)). The seed leaves `users.metadata`, `orders.items` and `posts.subtitle`
NULL and stamps `posts.published_at` with the insert time: an example that reads them first sets the values its
comment or table header states. Each SQL block is the
statement the example sent. Table cells quote the same captured statements, so a `$n` in a cell keeps the parameter
number it had there.

## Contents

- [Pick a helper for the job](#pick-a-helper-for-the-job)
- [Combine helpers: each renders one operand](#combine-helpers-each-renders-one-operand)
- [Know how plain values are bound](#know-how-plain-values-are-bound)
- [Read results with the right type: withReadType(), mapWith()](#read-results-with-the-right-type-withreadtype-mapwith)
- [Cast a value: cast(), castAs*()](#cast-a-value-cast-castas)
- [Write constants, parameters and typed NULLs: literal(), param(), typedNull()](#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- [Choose a value by condition: caseWhen(), caseOf()](#choose-a-value-by-condition-casewhen-caseof)
- [Handle NULLs and compare NULL-safely: coalesce(), nullIf(), greatest(), isDistinctFrom()](#handle-nulls-and-compare-null-safely-coalesce-nullif-greatest-isdistinctfrom)
- [Transform text](#transform-text)
- [Compute numbers](#compute-numbers)
- [Work with dates, times and intervals](#work-with-dates-times-and-intervals)
- [Read, filter, build and change JSONB](#read-filter-build-and-change-jsonb)
- [Query array columns](#query-array-columns)
- [Aggregate inside an expression: agg](#aggregate-inside-an-expression-agg)
- [Number and rank rows: win (since 1.0.21)](#number-and-rank-rows-win-since-1021)
- [Write SQL no helper covers: the sql template](#write-sql-no-helper-covers-the-sql-template)
- [Pitfalls](#pitfalls)
- [Version notes](#version-notes)
- [See also](#see-also)

## Pick a helper for the job

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| A JSON field as text, or as a number | `jsonbPathText(doc, 'k')`, then `.castAsInt()` | `("users"."metadata"->>'score')`, `CAST(("users"."metadata"->>'score') AS integer)` · 0 extra | `jsonbSelectText()` or a raw `->>` template: both read `'007'` as `7` |
| A constant the statement text must contain (an index predicate, a UNION discriminator) | `literal(v)` | `'user'`, `(-5)`, `TRUE` inline · 0 extra | `literal()` for user input or varying values: every value is another statement text |
| One statement text for every value, NULL included | `param(v, 'integer')` | `CAST($1 AS integer)` · 0 extra | `eq(col, value)` with a value that can be `null`: `null` renders `IS NULL`, another text and another meaning |
| A value chosen by condition | `caseWhen(cond, a).when(…).else(b)` · `caseOf(x).when(v, a)` | `CASE WHEN … THEN … ELSE … END` · 0 extra | computing it in JS when you filter, sort or group by it |
| A default for NULL | `coalesce(a, b)` | `COALESCE("posts"."subtitle", $2)` · 0 extra | `caseWhen(isNull(a), b).else(a)` |
| NULL-safe "differs from" / "equals" | `isDistinctFrom(a, b)` · `isNotDistinctFrom(a, b)` | `("posts"."subtitle" IS DISTINCT FROM $9)` · 0 extra | `ne(col, value)` (`"posts"."subtitle" != $1`): a row whose `col` is NULL never matches; `ne(col, null)` renders `IS NOT NULL` |
| Change a stored value in place | `add` / `sub` / `caseWhen` / `jsonbSet` / `jsonbMerge` in `update(r => …)` | `UPDATE "posts" SET "views" = ("posts"."views" + $1) WHERE "posts"."id" = $2` · 1 round trip | SELECT, change in JS, UPDATE: 2 round trips and a lost-update window |
| Rows relative to the server clock | `subInterval(currentTimestamp(), { days: 7 })` | `(CURRENT_TIMESTAMP - CAST($1 AS interval))` · 0 extra | interval text spliced into an `sql` template |
| Filter JSON documents by content | `jsonbContains(doc, { plan: 'pro' })` · `jsonbHasKey(doc, 'k')` | `@>`, `?` · GIN-indexable | `jsonbArraySome()` / `jsonbPathExists()` for what `@>` expresses: no index use |
| Filter an array column by its elements | `arrayContainsAll(col, [v])` · `arrayOverlaps(col, list)` | `@>`, `&&` · GIN-indexable | `arrayContains(col, v)` on a large table: `= ANY(col)` uses no GIN index |
| Add one value to an array column, or remove one, in place | `arrayAppendUnique(col, v)` · `arrayRemove(col, v)` in `update(r => …)` (since 1.0.31) | `(CASE WHEN … = ANY("books"."tags") THEN "books"."tags" ELSE array_append(COALESCE("books"."tags", CAST('{}' AS text[])), …) END)` · `array_remove(…)` · 1 round trip | SELECT the array, change it in JS, UPDATE: 2 round trips and a lost-update window |
| Several statistics of one filtered set | one `select()` of `agg.*` fragments | 1 statement, 1 row | one `count()` / `sum()` call per number: 1 round trip each |
| Number or rank rows, top N per group | `win.rowNumber().over({ partitionBy, orderBy })`, filtered through a CTE | `row_number() OVER (…)` · 1 statement | loading every row to rank it in JS |
| An expression no helper covers | an `sql` template + `.withReadType()` / `.mapWith()` | as written · 0 extra | `sql.raw()` with user input: SQL injection |

## Combine helpers: each renders one operand

Helpers nest in each other and in `sql` templates, and they work in `select()`, `where()`, `orderBy()`, `groupBy()`
keys, `having()`, `update()` values and upsert values; a predicate helper's fragment is also a `Condition`, so it goes
straight into `where()`. Each renders ONE self-delimited expression (a function call, `CAST(… AS …)`, `CASE … END`,
`EXISTS (…)` or a parenthesized group), so an operator around it never takes part of it.

```ts
import { eq, sql, literal, coalesce, add, concatStrict, jsonbPathText, jsonbMerge, jsonbRemoveKey } from 'linkgress-orm';

// alice's metadata: { first: 'Alice', last: 'Liddell', qty: '3', draft: true }
const row = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    withoutDraft: jsonbRemoveKey(jsonbMerge(u.metadata, { seen: true }), 'draft'),
    fullName: concatStrict(jsonbPathText(u.metadata, 'first'), literal(' '), jsonbPathText(u.metadata, 'last')),
    qty: sql<number>`${jsonbPathText(u.metadata, 'qty')}::int`,
    nextAge: add(coalesce(u.age, 0), 1),
  }))
  .firstOrDefault();
// { withoutDraft: { qty: '3', last: 'Liddell', seen: true, first: 'Alice' }, fullName: 'Alice Liddell', qty: 3, nextAge: 26 }
```

```sql
SELECT ((COALESCE("users"."metadata", '{}'::jsonb) || ($1)::jsonb) - CAST($2 AS text)) as "withoutDraft",
  (("users"."metadata"->>'first') || ' ' || ("users"."metadata"->>'last')) as "fullName",
  ("users"."metadata"->>'qty')::int as "qty",
  (COALESCE("users"."age", $3) + $4) as "nextAge"
FROM "users"
WHERE "users"."username" = $5
LIMIT 1
-- params: [ { "seen": true }, "draft", 0, 1, "alice" ]
```

- The operator helpers of other pages follow the same rule: `eqAny` / `neAll`, `flagHas*`, `normalized*`,
  `notExists`, `eqAnySubquery` / `neAllSubquery` and a `jsonbArraySome` element path each render as one operand.
- A condition built by a comparison helper (`eq`, `like`, `isNull`, `and`, …) is not a fragment; a fragment it is
  interpolated into parenthesizes it. An `sql` template is your own text and composes as written; `and()` / `or()`
  parenthesize it as an operand.

A column reference inside a helper keeps its navigation path, so a navigation used only inside a helper, a CASE
branch or a condition nested in an `sql` template is joined like a directly selected one:

```ts
const posts = await db.posts
  .select(p => ({
    title: p.title,
    byAlice: caseWhen(eq(lower(p.user!.username), 'alice'), 'yes').else('no'),
    popularActive: sql<boolean>`${eq(p.user!.isActive, true)} AND ${gt(p.views, 120)}`,
  }))
  .orderBy(p => p.title)
  .toList();
```

```sql
SELECT "posts"."title" as "title",
  CASE WHEN lower("user"."username") = $1 THEN CAST($2 AS text) ELSE CAST($3 AS text) END as "byAlice",
  ("user"."is_active" = $4) AND ("posts"."views" > $5) as "popularActive"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
ORDER BY "title" ASC
-- params: [ "alice", "yes", "no", true, 120 ]
```

A subquery inside a fragment reports its outer references the same way. A fragment that renders its own way
(`exists()`, `notExists()`, an aggregate, a CASE) keeps its SQL and its references through `.as()`, `.mapWith()`,
`.withReadType()` and `sql.join()`.

## Know how plain values are bound

A plain JS value is always a bind parameter, never inlined, except through [`literal()`](#write-constants-parameters-and-typed-nulls-literal-param-typednull).
Where PostgreSQL cannot infer a parameter's type (every CASE result is a plain value, a VARIADIC function such as
`concat` or `jsonb_build_object`, a function argument, an aggregate argument), the helper types it from its JS type.
`pgTypeOfValue(value)` returns the type it picks:

| JS value | Bound as |
|---|---|
| boolean | `boolean` |
| integer in the int4 range | `integer` |
| other safe integer, bigint | `bigint` |
| other number | `double precision` |
| string | `text` |
| Date | `timestamptz` |
| plain object / array | `jsonb` (serialized with `JSON.stringify`) |

Where a column or an expression fixes the type (`eq(column, value)`, a CASE with a column branch, the right side of
`IS DISTINCT FROM`, `coalesce`, the arithmetic helpers), the parameter stays untyped and PostgreSQL resolves it
against that operand. A column's custom mapper converts a plain value compared or unified with it:
`coalesce(p.customDate, new Date('2024-01-01T00:00:00Z'))` binds `-31622400`, the stored form of the mapped
`custom_date` column.

> **Pitfall:** two plain operands of an arithmetic helper are two untyped parameters, which PostgreSQL rejects.
> Compute constants in JS, or type one operand:

```ts
await db.orders.where(o => eq(o.id, 1)).select(() => ({ n: add(1, 2) })).toList();                           // fails
await db.orders.where(o => eq(o.id, 1)).select(() => ({ n: add(param(1, 'integer'), 2) })).firstOrDefault(); // { n: 3 }
```

```sql
SELECT ($1 + $2) as "n"
FROM "orders"
WHERE "orders"."id" = $3
-- params: [ 1, 2, 1 ]
-- error: operator is not unique: unknown + unknown

SELECT (CAST($1 AS integer) + $2) as "n"
FROM "orders"
WHERE "orders"."id" = $3
LIMIT 1
-- params: [ 1, 2, 1 ]
```

## Read results with the right type: withReadType(), mapWith()

A projected value reads back by one of these rules; the helper decides which:

| The projected value | Reads as |
|---|---|
| A helper with an explicit result type: casts (except `castAsNumeric`), `literal()` of a string / boolean / bigint, `param()`, `typedNull()`, string helpers, JSON paths and builders, `jsonbSet` / `jsonbRemoveKey` / `jsonbRemovePath`, `jsonbTypeOf`, `jsonbArrayLength`, `atTimeZone`, `dateTrunc`, `toChar`, `toInterval`, `addInterval`, `subInterval`, `arrayLength()`, CASE, `nullIf`, `greatest`, `least` | the driver's value as delivered: `'007'` stays a string, NULL is `null` |
| A numeric helper: `castAsNumeric`, `literal(<number>)`, `round`, `floor`, `ceil`, `abs`, `mod`, `modulo`, `datePart`, `agg.count` / `countDistinct` / `sum` / `avg` / `bitOr` / `bitAnd`, `win.*` | a JS `number` (numeric and int8 text converted with `Number()`); NULL is `null` |
| CASE, `coalesce`, `greatest`, `least`, `nullIf` or an arithmetic helper with an operand that carries a custom mapper | through that mapper: `caseWhen(…, p.customDate)` reads a `Date` |
| `agg.min()` / `agg.max()` | through the operand's mapper; a JS number for a numeric or int8 operand; else as delivered |
| `agg.arrayAgg()` | an array; each element through the operand's mapper |
| `agg.jsonAgg()` / `agg.jsonbAgg()`, the JSON builders | the driver-parsed JSON, no per-element mapping |
| A fragment without a mapper: an `sql` template, a scalar subquery's `asExpression()`, a predicate helper (`jsonbContains`, `arrayIsEmpty`, `isDistinctFrom`, …), `jsonbSelect` / `jsonbSelectText`, `jsonbMerge`, `arrayAppendUnique` / `arrayRemove`, `currentTimestamp()` and its siblings, `coalesce` and the arithmetic helpers when no operand carries a mapper | the generic conversion: a numeric-looking string becomes a number (`'007'` → `7`); NULL is `undefined` at the top level of a projection and `null` inside a nested object |
| The same fragment in a grouped select (`groupBy(…).select(…)`) | the driver's value as delivered: int8 / numeric as strings, NULL as `null` |

`.withReadType(pgType)` makes a fragment read the way a COLUMN of `pgType` reads, with no change to the SQL.
`.mapWith(fn)` runs `fn` on each non-NULL value; `.mapWith(mapper)` reads through a type mapper's `fromDriver`:

```ts
const row = await db.users
  .where(u => eq(u.username, 'bob'))   // metadata: { code: '007', weight: '1.50' }
  .select(u => ({
    generic: sql<string>`${u.metadata}->>'code'`,
    asText: sql<string>`${u.metadata}->>'code'`.withReadType('text'),
    asNumeric: sql<number>`${u.metadata}->>'weight'`.withReadType('numeric'),
    helper: jsonbPathText(u.metadata, 'code'),
    mapped: sql<string>`upper(${u.username})`.mapWith((v: string) => `#${v}`),
    missingGeneric: sql<string | null>`${u.metadata}->>'nothing'`,
    missingHelper: jsonbPathText(u.metadata, 'nothing'),
    nested: { missing: sql<string | null>`${u.metadata}->>'nothing'`.withReadType('text') },
  }))
  .firstOrDefault();
// { generic: 7, asText: '007', asNumeric: 1.5, helper: '007', mapped: '#BOB',
//   missingGeneric: undefined, missingHelper: null, nested: { missing: null } }
```

```sql
SELECT "users"."metadata"->>'code' as "generic",
  "users"."metadata"->>'code' as "asText",
  "users"."metadata"->>'weight' as "asNumeric",
  ("users"."metadata"->>'code') as "helper",
  upper("users"."username") as "mapped",
  "users"."metadata"->>'nothing' as "missingGeneric",
  ("users"."metadata"->>'nothing') as "missingHelper",
  "users"."metadata"->>'nothing' as "__nested__nested__missing"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "bob" ]
```

In a grouped select an unmapped `sql` expression reads the driver's text, so type it explicitly:

```ts
const perUser = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    raw: sql<number>`${g.sum(r => r.views)} / ${g.count()}`,                          // '125' (string)
    mapped: sql<number>`${g.sum(r => r.views)} / ${g.count()}`.mapWith(Number),         // 125
    readType: sql<number>`${g.sum(r => r.views)} / ${g.count()}`.withReadType('bigint'), // 125
  }))
  .orderBy(r => r.userId)
  .toList();
```

```sql
SELECT "posts"."user_id" as "userId",
  SUM("posts"."views") / COUNT(*) as "raw",
  SUM("posts"."views") / COUNT(*) as "mapped",
  SUM("posts"."views") / COUNT(*) as "readType"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "userId" ASC
```

`withReadType(pgType)`:

- turns a numeric string into a number only for a numeric type (`integer`, `bigint`, `numeric`, …); `text`, `uuid`,
  `json`, … keep what the driver delivers;
- reads SQL NULL as `undefined` at the top level of a projection and `null` inside a nested object (a grouped select
  keeps `null`); inside a collection's items the value stays as the JSON delivers it;
- drops the fragment's mapper; a later `.mapWith()` sets one again and wins;
- is kept by `.as()`, `selectDistinct`, UNION legs (they read through the first leg), QueryBatch parts, grouped
  selects, the columns of a CTE or table subquery that projects the fragment, and a projected
  `asSubquery('scalar')` whose one value it is;
- validates the type name like a cast.

`mapWith(fn)` is null-safe (the function never sees NULL). A mapper object declared `immutable: true` is evaluated once
per distinct value per result set. `mapWith` returns a plain `SqlFragment`: call `agg` `.filter()` and `win` `.over()`
before it. `.as(alias)` does not rename a projected field: the key of the projection object wins.

## Cast a value: cast(), castAs*()

`cast(x, pgType)` renders `CAST(x AS pgType)` over a column, an expression or a plain value (one typed parameter).
The `castAs*` shorthands fix the type and the JS read; every fragment has the same casts as methods
(`.castAsInt()`, `.cast<T>(pgType)`). Use a cast to compare JSON text as a number, to type a parameter PostgreSQL cannot
infer, or to match an expression index written `x::type`.

| Helper (over `orders` id 1, total 99.99) | Renders | Reads as |
|---|---|---|
| `cast<T>(x, pgType)` | `CAST("orders"."total_amount" AS numeric)` | the driver's value for `pgType`: `'99.99'` (string); `T` only sets the TypeScript type |
| `castAsInt(x)` | `CAST("orders"."total_amount" AS integer)` | `number`: `100` |
| `castAsSmallInt(x)` | `CAST("orders"."user_id" AS smallint)` | `number`: `1` |
| `castAsBigInt(x)` | `CAST("orders"."user_id" AS bigint)` | `string`: `'1'`, exact int8; `.mapWith(Number)` / `.mapWith(BigInt)` converts |
| `castAsNumeric(x, p?, s?)` | `CAST("orders"."total_amount" AS numeric(12, 2))` | `number`: `99.99` (through `Number()`) |
| `castAsDouble(x)` | `CAST("orders"."total_amount" AS double precision)` | `number`: `99.99` |
| `castAsString(x)` | `CAST("orders"."total_amount" AS text)` | `string`: `'99.99'` |
| `castAsVarchar(x, n?)` | `CAST("orders"."status" AS varchar(4))` | `string`: `'comp'` (an explicit cast truncates to n) |
| `castAsBoolean(x)` | `CAST($1 AS boolean)` | `boolean`: `'yes'` → `true` |
| `castAsDate(x)` | `CAST($2 AS date)` | `Date` (node-postgres parses a `date` at local midnight) |
| `castAsTimestamp(x)` | `CAST($3 AS timestamp)` | `Date` |
| `castAsTimestamptz(x)` | `CAST("orders"."created_at" AS timestamptz)` | `Date` |
| `castAsJsonb(x)` / `castAsJson(x)` | `CAST(CAST($4 AS text) AS jsonb)` · `CAST(CAST($5 AS text) AS json)` | the parsed JSON: `{ gift: true }`, `[1, 2]` |
| `castAsUuid(x)` | `CAST($6 AS uuid)` | `string` |
| `cast(42, 'bigint')` | `CAST($7 AS bigint)` | `string`: `'42'` |
| `cast(null, 'text')` | `CAST(NULL AS text)`, no parameter | `null` |
| `cast([1, 2, 3], 'integer[]')` | `CAST($8 AS integer[])`, parameter `'{1,2,3}'` | `number[]`: `[1, 2, 3]` |

The method form, in a filter and a projection:

```ts
const scores = await db.users
  .where(u => gt(jsonbPathText(u.metadata, 'score').castAsInt(), 10))  // alice '120', bob '007'
  .select(u => ({
    username: u.username,
    score: jsonbPathText(u.metadata, 'score').castAsInt(),
    scoreText: jsonbPathText(u.metadata, 'score'),
    typed: sql<string>`${u.age} * 2`.cast<number>('numeric(6, 1)'),
  }))
  .toList();
// [{ username: 'alice', score: 120, scoreText: '120', typed: '50.0' }]
```

```sql
SELECT "users"."username" as "username",
  CAST(("users"."metadata"->>'score') AS integer) as "score",
  ("users"."metadata"->>'score') as "scoreText",
  CAST("users"."age" * 2 AS numeric(6, 1)) as "typed"
FROM "users"
WHERE CAST(("users"."metadata"->>'score') AS integer) > $1
-- params: [ 10 ]
```

- The type name is inlined, so it is validated: real names pass (`numeric(12, 2)`, `varchar(64)[]`,
  `timestamp with time zone`, `my_schema.my_enum`, `"MyEnum"`); anything else throws
  `Invalid PostgreSQL type name for a cast: …` before a statement is sent.
- A JS object or array cast to `json` / `jsonb` is serialized with `JSON.stringify`; a string is taken as JSON text.
  JSON text binds as `text` and the cast parses it (`CAST(CAST($1 AS text) AS jsonb)`), the same on every driver; a
  parameter typed `jsonb` would be JSON-encoded once more by postgres.js and stored as a JSON string.
- A JS array cast to an array type binds as its array literal (`'{1,2,3}'`), which every driver accepts; Bun's SQL
  client cannot bind a JS array to an array parameter.
- `CAST(x AS t)` is the same expression tree as `x::t`, so it matches expression indexes written either way.
- `.cast()` and the `castAs*` methods keep the fragment's alias and drop its mapper (it described the value before the
  cast).

> **Pitfall:** `cast<number>(x, 'numeric(6, 1)')` reads the string `'50.0'`: the type parameter is not a conversion. Use
> `castAsNumeric()` for a JS number, or keep the string for exact decimals.

## Write constants, parameters and typed NULLs: literal(), param(), typedNull()

`literal()` writes a constant INTO the statement text (quoted safely); use it where PostgreSQL must see the value
literally: a partial or expression index predicate, a UNION discriminator, a constant that must not add a parameter.
`param()` guarantees the opposite: exactly one bound parameter, whatever the value, so the statement text never
changes. A condition placed in a projection reads as a boolean.

| Helper | Renders | Reads as |
|---|---|---|
| `literal('user')` | `'user'` | `'user'` |
| `literal(-5)` | `(-5)` | `-5` |
| `literal(1.5)` | `1.5` | `1.5` (a number) |
| `literal(true)` | `TRUE` | `true` |
| `literal('x', 'varchar(8)')` | `CAST('x' AS varchar(8))` | `'x'` |
| `literal(9007199254740993n)` | `9007199254740993` | `'9007199254740993'` (exact string) |
| `literalOf<'user' \| 'admin'>('user')` | `'user'` | `'user'`, typed `'user' \| 'admin'` |
| `typedNull<string>('text')` | `CAST(NULL AS text)` | `null` |
| `param(7, 'integer')` | `CAST($1 AS integer)` | `7` (as the driver delivers it) |
| `param('007')` | `$2` | `'007'` |
| `asBoolean(gte(u.age, 18))` | `("users"."age" >= $3)` | `true` |
| `gte(u.age, 30)` placed directly in `select()` | `("users"."age" >= $4)` | `false` |

UNION ALL legs line up with `literalOf()` discriminators and `typedNull()` pads for the columns a leg lacks:

```ts
const feed = await db.posts
  .select(p => ({ kind: literalOf<'post' | 'order'>('post'), id: p.id, userId: p.userId, title: p.title, amount: typedNull<number>('numeric') }))
  .unionAll(db.orders.select(o => ({ kind: literalOf<'post' | 'order'>('order'), id: o.id, userId: o.userId, title: typedNull<string>('text'), amount: o.totalAmount })))
  .toList();
// rows[i].kind is typed 'post' | 'order'; an order's amount reads '99.99' (numeric as the driver delivers it)
```

```sql
(SELECT 'post' as "kind", "posts"."id" as "id", "posts"."user_id" as "userId", "posts"."title" as "title", CAST(NULL AS numeric) as "amount"
FROM "posts")
UNION ALL
(SELECT 'order' as "kind", "orders"."id" as "id", "orders"."user_id" as "userId", CAST(NULL AS text) as "title", "orders"."total_amount" as "amount"
FROM "orders")
```

`param()` keeps one statement text for every lookup form; unused keys bind NULL, which matches nothing:

```ts
const findPosts = (byId: number | null, byUser: number | null) =>
  db.posts
    .where(p => or(eq(p.id, param(byId, 'integer')), eq(p.userId, param(byUser, 'integer'))))
    .select(p => ({ id: p.id, title: p.title }))
    .toList();

await findPosts(1, null);   // [{ id: 1, title: 'Alice Post 1' }]
await findPosts(null, 2);   // [{ id: 3, title: 'Bob Post' }]
```

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE ("posts"."id" = CAST($1 AS integer) OR "posts"."user_id" = CAST($2 AS integer))
-- params: [ 1, null ]

SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE ("posts"."id" = CAST($1 AS integer) OR "posts"."user_id" = CAST($2 AS integer))
-- params: [ null, 2 ]
```

> **Efficiency:** one statement text per query shape is what server-side prepared statements reuse: with
> `preparedStatements: true` (postgres.js only; default `false`) each distinct text is prepared once per connection
> ([Configuration](./configuration.md#send-statements-named-on-the-server-preparedstatements)). Every distinct
> `literal()` value, by contrast, is another statement text.

NULL has three spellings with three meanings:

```ts
await db.users.where(u => eq(u.age, param(null, 'integer'))).count(); // = NULL: matches no row, same text for every value
await db.users.where(u => eq(u.age, null)).count();                   // IS NULL
await db.users.where(u => eq(u.age, castAsInt(null))).count();        // typed NULL inlined: the text depends on null-ness
```

```sql
SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" = CAST($1 AS integer)
-- params: [ null ]

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" IS NULL

SELECT COUNT(*) as count
FROM "users"
WHERE "users"."age" = CAST(NULL AS integer)
```

- `literal()` accepts strings (a backslash switches to the escape-string form `E'…'`), numbers (negative ones in
  parentheses, `NaN` / `Infinity` quoted), bigints, booleans and `null`. A Date throws
  (`literal() inlines strings, numbers, bigints, booleans and null only — got a Date…`): bind it with
  `cast(value, 'timestamptz')`. `literalOf<T>()` renders and reads like `literal()` and only changes the TypeScript type;
  a value outside `T` is a compile error.
- `param()` binds the value as given: the compared column's `toDriver` mapper does not apply. A JS array needs an array
  type (`param([1, 2], 'integer[]')` binds one array literal); a plain object throws (use `castAsJsonb()`); a column
  or expression throws (use it directly). It works as a comparison operand, a JSON path key
  (`jsonbPathText(col, param(key))` renders `(col->>$1)`), a CASE arm, a function argument and a boolean operand of
  `or()` (`or(param(showAll, 'boolean'), …)`).
- `quoteSqlLiteral(text)` is the quoting behind `literal()`: `quoteSqlLiteral("it's")` returns `'it''s'`,
  `quoteSqlLiteral('a\\b')` returns `E'a\\b'`; it refuses NUL and non-strings. Use it for trusted SQL text you
  assemble yourself (`sql.raw()`, migrations).
- A condition placed directly in a projection, at the top level or in a nested object, reads as a boolean column, and
  `jsonbBuildObject()` accepts conditions as values. Use `asBoolean(condition)` when you need a
  `SqlFragment<boolean>`: to call `.cast()` / `.mapWith()` / `.as()` on it or to pass it where a fragment is required.

## Choose a value by condition: caseWhen(), caseOf()

`caseWhen(cond, value)` builds a searched CASE, `caseOf(subject)` a simple CASE (the subject compared with `=`).
Branches are tested in order; without `.else()` an unmatched row gives NULL. The builders are immutable: every
`.when()` / `.else()` returns a new expression.

| Form (over `posts`) | Renders | Reads as |
|---|---|---|
| `caseWhen(gt(p.views, 150), 'high').when(gt(p.views, 100), 'mid').else('low')` | `CASE WHEN "posts"."views" > $1 THEN CAST($2 AS text) WHEN "posts"."views" > $3 THEN CAST($4 AS text) ELSE CAST($5 AS text) END` | `'low'`, `'mid'`, `'high'` |
| `caseWhen(gt(p.views, 150), 1)`, no `.else()` | `CASE WHEN "posts"."views" > $6 THEN CAST($7 AS integer) END` | `1` or `null` |
| `caseWhen(gt(p.views, 150), 150).else(p.views)` | `CASE WHEN "posts"."views" > $11 THEN $12 ELSE "posts"."views" END` | `number`; with a column branch the plain value stays untyped |
| `caseOf(p.userId).when(1, 'alice').when(2, 'bob').else('other')` | `CASE "posts"."user_id" WHEN $13 THEN CAST($14 AS text) WHEN $15 THEN CAST($16 AS text) ELSE CAST($17 AS text) END` | `'alice'`, `'bob'`, `'other'` |
| `caseWhen(isNull(p.subtitle), false).else(gt(p.views, 3))` | `CASE WHEN "posts"."subtitle" IS NULL THEN $18 ELSE ("posts"."views" > $19) END` | `boolean`: a condition is a valid result |
| `caseWhen(gt(p.views, 120), p.customDate).else(null)` | `CASE WHEN "posts"."views" > $20 THEN "posts"."custom_date" ELSE NULL END` | `Date`: the column's mapper reads the result |

PostgreSQL evaluates CASE branches lazily, so a branch can guard a later one (a division by zero, a cast that would
fail):

```ts
// metadata.score: alice '120', bob 'n/a', charlie no document
const scores = await db.users
  .select(u => ({
    username: u.username,
    score: caseWhen(regexMatches(jsonbPathText(u.metadata, 'score'), '^[0-9]+$'), castAsInt(jsonbPathText(u.metadata, 'score'))).else(null),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', score: 120 }, { username: 'bob', score: null }, { username: 'charlie', score: null }]
```

```sql
SELECT "users"."username" as "username",
  CASE WHEN ("users"."metadata"->>'score') ~ $1 THEN CAST(("users"."metadata"->>'score') AS integer) ELSE NULL END as "score"
FROM "users"
ORDER BY "username" ASC
-- params: [ "^[0-9]+$" ]
```

CASE works as an UPDATE value: one statement, no read.

```ts
await db.posts.where(p => eq(p.id, 1)).update(p => ({ views: caseWhen(gt(p.views, 0), sub(p.views, 1)).else(0) }));
```

```sql
UPDATE "posts" SET "views" = CASE WHEN "posts"."views" > $1 THEN ("posts"."views" - $2) ELSE $3 END WHERE "posts"."id" = $4
-- params: [ 0, 1, 0, 1 ]
```

- Results unify into one type. A column branch fixes it (and its mapper reads the result); when every result is a
  plain value, each is typed from its JS type, so `1` / `0` read as numbers, not text.
- `caseOf()` match values bind like `eq()` (the subject's mapper applies); a NULL subject matches no branch.
- For a conditional sum over a group, put the CASE in the aggregate: `g.sum(r => caseWhen(eq(r.status, 'completed'), 1).else(0))`
  (see [Aggregate inside an expression](#aggregate-inside-an-expression-agg)).

## Handle NULLs and compare NULL-safely: coalesce(), nullIf(), greatest(), isDistinctFrom()

`coalesce()` returns its first non-NULL operand, `nullIf()` turns one value into NULL, `greatest()` / `least()` pick
an extreme while ignoring NULLs, and `isDistinctFrom()` / `isNotDistinctFrom()` compare with NULL treated as a value.
For a plain NULL test use `isNull()` / `isNotNull()` ([Querying](./querying.md)).

| Helper (over `posts`) | Renders | Reads as |
|---|---|---|
| `coalesce(nullIf(p.subtitle, ''), p.title)` | `COALESCE(NULLIF("posts"."subtitle", $1), "posts"."title")` | the first non-NULL operand |
| `coalesce(p.subtitle, 'none')` | `COALESCE("posts"."subtitle", $2)` | generic conversion: see the pitfall below |
| `coalesce(p.customDate, new Date(…))` | `COALESCE("posts"."custom_date", $3)`, parameter `-31622400` | `Date`: the mapper converts the fallback and the result |
| `greatest(p.views, 120)` | `GREATEST("posts"."views", $4)` | the largest operand; NULL operands are ignored |
| `least(p.views, 120, 130)` | `LEAST("posts"."views", $5, $6)` | the smallest operand |
| `greatest(3, 7)` | `GREATEST(CAST($7 AS integer), CAST($8 AS integer))` | `7`: all-plain operands are typed |
| `nullIf(x, '')` | `NULLIF("posts"."subtitle", $1)` | `null` when the two are equal, else `x` |
| `isDistinctFrom(p.subtitle, 'Weekly')` | `("posts"."subtitle" IS DISTINCT FROM $9)` | `boolean`: NULL vs a value is distinct, two NULLs are not |
| `isNotDistinctFrom(p.subtitle, null)` | `("posts"."subtitle" IS NOT DISTINCT FROM NULL)` | `boolean`: NULL-safe equality |

`isDistinctFrom()` is a condition and a value. As a filter it finds the rows a write would really change, NULL
included; a `null` operand renders inline `NULL`:

```ts
const next: string | null = null;
const toChange = await db.posts
  .where(p => isDistinctFrom(p.subtitle, next))
  .select(p => ({ id: p.id, subtitle: p.subtitle }))
  .toList();
```

```sql
SELECT "posts"."id" as "id", "posts"."subtitle" as "subtitle"
FROM "posts"
WHERE ("posts"."subtitle" IS DISTINCT FROM NULL)
```

`coalesce()` without an operand that carries a mapper reads through the generic conversion, so a digits-only text
value comes back as a number. Keep the text with a `literal()` fallback, `.withReadType('text')` or a cast:

```ts
// posts.subtitle of post 1 is '007'
const codes = await db.posts
  .where(p => eq(p.id, 1))
  .select(p => ({
    generic: coalesce(p.subtitle, 'none'),                        // 7
    literalFallback: coalesce(p.subtitle, literal('none')),       // '007'
    readAsText: coalesce(p.subtitle, 'none').withReadType('text'), // '007'
    cast: castAsString(coalesce(p.subtitle, 'none')),             // '007'
    nullIfKeeps: nullIf(p.subtitle, ''),                          // '007'
  }))
  .firstOrDefault();
```

```sql
SELECT COALESCE("posts"."subtitle", $1) as "generic",
  COALESCE("posts"."subtitle", 'none') as "literalFallback",
  COALESCE("posts"."subtitle", $2) as "readAsText",
  CAST(COALESCE("posts"."subtitle", $3) AS text) as "cast",
  NULLIF("posts"."subtitle", $4) as "nullIfKeeps"
FROM "posts"
WHERE "posts"."id" = $5
LIMIT 1
-- params: [ "none", "none", "none", "", 1 ]
```

- `coalesce()` takes two or more operands. The first operand mapper wins (a mapped column reads as its mapped type),
  and its `toDriver` converts the plain fallbacks; the fallbacks bind untyped.
- `greatest()` / `least()` need at least two operands and type plain operands only when every operand is plain;
  `nullIf()`, `greatest()` and `least()` read the driver's value (or through a mapped operand's mapper).
- `IS [NOT] DISTINCT FROM` is not served by a btree index. For a plain NULL test use `isNull()` / `isNotNull()`; for
  known non-NULL values use `eq()` / `ne()`.

## Transform text

String helpers render the PostgreSQL functions; plain arguments bind typed (`CAST($n AS text)` /
`CAST($n AS integer)`), `literal()` arguments stay inline. Results read as the driver delivers them.

| Helper (alice: `alice@test.com`, 25) | Renders | Reads as |
|---|---|---|
| `lower(u.email)` | `lower("users"."email")` | `'alice@test.com'` |
| `upper(u.username)` | `upper("users"."username")` | `'ALICE'` |
| `trim(x)` · `trim(x, chars)` | `btrim('  x  ')` · `btrim("users"."username", CAST($1 AS text))` | `'x'` · `'lic'` (strips `a` and `e`) |
| `trimStart(x, chars?)` · `trimEnd(x, chars?)` | `ltrim('  x')` · `rtrim('x  ')` | `'x'` |
| `length(x)` | `char_length("users"."email")` | `14`: characters, not bytes |
| `concat(a, b, …)` | `concat("users"."username", CAST($2 AS text), "users"."age", CAST($3 AS text))` | `'alice (25)'`; NULL counts as `''` |
| `concatWs(sep, a, b, …)` | `concat_ws(CAST($4 AS text), "users"."username", NULL, "users"."email")` | `'alice, alice@test.com'`; NULLs are skipped |
| `concatStrict(a, b, …)` | `("users"."username" \|\| ' <' \|\| "users"."email" \|\| '>')` | `'alice <alice@test.com>'`; NULL when any operand is NULL |
| `substring(x, start, count?)` | `substring("users"."email", CAST($5 AS integer), CAST($6 AS integer))` | `'alice'` (1-based start) |
| `substring(x, pattern)` | `substring("users"."email", '^([a-z]+)@')` | `'alice'`: the first group's match, `null` without a match |
| `replace(x, from, to)` | `replace("users"."email", CAST($7 AS text), CAST($8 AS text))` | `'alice@example.org'` |
| `regexpReplace(x, pattern, replacement, flags?)` | `regexp_replace("users"."email", '[^a-z]', '', 'g')` | `'alicetestcom'` |
| `searchNormalize(x)` | `public.search_normalize("titles"."title")` | `'jose saramago'` for `'José Saramago'`: lower-case, accents removed |

Helpers work in `where()` and `orderBy()` too, and a navigation inside them is joined:

```ts
const posts = await db.posts
  .where(p => eq(lower(p.user!.username), 'alice'))
  .select(p => ({ title: upper(p.title), author: concatWs(' / ', p.user!.username, p.user!.email) }))
  .orderBy(p => p.title)
  .toList();
// [{ title: 'ALICE POST 1', author: 'alice / alice@test.com' }, { title: 'ALICE POST 2', author: 'alice / alice@test.com' }]
```

```sql
SELECT upper("posts"."title") as "title", concat_ws(CAST($1 AS text), "user"."username", "user"."email") as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE lower("user"."username") = $2
ORDER BY "title" ASC
-- params: [ " / ", "alice" ]
```

- To match an expression index written with constant arguments, pass the constants through `literal()`:
  `regexpReplace(u.email, literal('[^a-z]'), literal(''), literal('g'))`. A bound argument is a different expression to
  the planner.
- `concatStrict()` needs at least two operands; a plain value binds as `CAST($n AS text)`, `null` / `undefined` as
  `CAST(NULL AS text)`. A digits-only result stays a string.
- `substring(x, pattern)` always renders the function-call form `substring(x, 'pattern')`, never
  `SUBSTRING(x FROM …)`, which is the expression an index written that way holds.
- `searchNormalize()` calls `public.search_normalize()` (`lower(unaccent(x))`), which the schema manager creates for an
  `ixNormalized` index or after `model.useSearchNormalize()`. The comparison helpers built on it (`normalizedEq`,
  `normalizedLike`, `normalizedStartsWith`) are in [Querying](./querying.md).
- `lower()` / `upper()` take text; an enum column needs a cast first (`lower(castAsString(p.category))`).

## Compute numbers

Math helpers read as JS numbers. The arithmetic helpers `add`, `sub`, `mul`, `div` render parenthesized operators
usable in projections, filters, sort keys and UPDATE values; `sub` and `div` take two operands, `add` and `mul` two or
more.

| Helper (order 1: total 99.99, user 1) | Renders | Reads as |
|---|---|---|
| `round(x)` | `round("orders"."total_amount")` | `100` |
| `round(x, digits)` | `round(CAST("orders"."total_amount" AS numeric), CAST($1 AS integer))` | `100` (`100.0`) |
| `floor(x)` · `ceil(x)` | `floor("orders"."total_amount")` · `ceil("orders"."total_amount")` | `99` · `100` |
| `abs(x)` | `abs(("orders"."total_amount" - $2))` | `20.01` |
| `mod(a, b)` | `mod("orders"."user_id", $3)` | `1` |
| `modulo(a, literal(2))` | `("orders"."user_id" % 2)` | `1`: the `%` operator |
| `add(a, b, …)` | `("orders"."total_amount" + $4 + $5)` | `110` |
| `sub(a, b)` | `("orders"."total_amount" - $6)` | `99` |
| `mul(a, b, …)` | `("orders"."total_amount" * $7)` | `199.98` |
| `div(a, b)` | `("orders"."user_id" / $8)` | `0`: integer division truncates |
| `div(castAsDouble(a), b)` | `(CAST("orders"."user_id" AS double precision) / $9)` | `0.5` |
| `add(a, coalesce(b, 0))` | `("orders"."user_id" + COALESCE("orders"."total_amount", $10))` | `100.99` |

An increment is one UPDATE, with no read and no lost-update window:

```ts
await db.posts.where(p => eq(p.id, 3)).update(p => ({ views: add(p.views, 1) }));
```

```sql
UPDATE "posts" SET "views" = ("posts"."views" + $1) WHERE "posts"."id" = $2
-- params: [ 1, 3 ]
```

- NULL propagates through arithmetic: wrap a nullable operand in `coalesce(x, 0)`.
- `round(x, digits)` casts `x` to numeric first (PostgreSQL has no `round(double precision, integer)`).
- `modulo()` computes what `mod()` does as the `%` OPERATOR. An expression index written with `%`
  (`CREATE INDEX … ((code % 10000000))`) is used only by a query spelling the same operator, never by `mod()`; keep a
  constant divisor inline so a generic plan can still match it: `modulo(o.id, literal(10000000, 'bigint'))` renders
  `("orders"."id" % CAST(10000000 AS bigint))`. A value compared with it binds unchanged.
- `mod()` / `modulo()` type plain operands only when both are plain. The arithmetic helpers bind plain operands
  untyped; the first operand mapper wins and converts the plain operands; without one the result reads through the
  generic conversion (a JS number).

## Work with dates, times and intervals

| Helper (post 1: `published_at` = `2024-03-10 08:30:00`, a `timestamp`) | Renders | Reads as |
|---|---|---|
| `currentTimestamp()` | `CURRENT_TIMESTAMP` | `Date`: the transaction's start |
| `localTimestamp()` | `LOCALTIMESTAMP` | `Date`: the transaction's start in the session time zone, without zone |
| `currentDate()` | `CURRENT_DATE` | `Date`: today in the session time zone |
| `utcTimestamp()` | `(now() AT TIME ZONE 'UTC')` | `Date`: for `timestamp` columns that hold UTC |
| `atTimeZone(x, zone)` | `("posts"."published_at" AT TIME ZONE CAST($3 AS text))` | `Date` |
| `atTimeZone(atTimeZone(x, 'UTC'), 'Europe/Vienna')` | `(("posts"."published_at" AT TIME ZONE CAST($1 AS text)) AT TIME ZONE CAST($2 AS text))` | as text `'2024-03-10 09:30:00'`: a UTC `timestamp` as Vienna wall-clock time |
| `dateTrunc('day', x)` | `date_trunc('day', "posts"."published_at")` | `Date`; as text `'2024-03-10 00:00:00'` |
| `dateTrunc('day', atTimeZone(x, 'UTC'), 'Europe/Vienna')` | `date_trunc('day', ("posts"."published_at" AT TIME ZONE CAST($3 AS text)), CAST($4 AS text))` | `Date`: `2024-03-09T23:00:00.000Z`, midnight in Vienna (the zone form truncates a `timestamptz`) |
| `datePart('isodow', x)` | `EXTRACT(ISODOW FROM "posts"."published_at")` | `number`: `7` (Sunday) |
| `toChar(x, 'YYYY-MM-DD HH24:MI')` | `to_char("posts"."published_at", CAST($5 AS text))` | `'2024-03-10 08:30'` |
| `toInterval({ days: 1, hours: 2 })` · `toInterval('90 minutes')` | `CAST($1 AS interval)`, parameter `'1 days 2 hours'` | typed `string`; node-postgres reads `{ days: 1, hours: 2 }`; as text `'1 day 02:00:00'` |
| `addInterval(x, { minutes: 30 })` | `("posts"."published_at" + CAST($2 AS interval))` | `Date`; as text `'2024-03-10 09:00:00'` |
| `subInterval(x, '1 day')` | `("posts"."published_at" - CAST($9 AS interval))` | `Date`; as text `'2024-03-09 08:30:00'` |

"Published in the last 7 days", measured by the server clock:

```ts
const recent = await db.posts
  .where(p => gt(p.publishedAt, subInterval(currentTimestamp(), { days: 7 })))
  .select(p => ({ id: p.id }))
  .toList();
```

```sql
SELECT "posts"."id" as "id"
FROM "posts"
WHERE "posts"."published_at" > (CURRENT_TIMESTAMP - CAST($1 AS interval))
-- params: [ "7 days" ]
```

> **Efficiency:** the interval is ONE bound text parameter, so every amount shares one statement text; the clock
> keywords are inline and bind nothing.

- `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`, `CURRENT_DATE` and `now()` all return the TRANSACTION's start time. Bind a JS
  `Date` instead when the application clock must decide.
- A zone is an IANA name or a column; a zone column is cast to text, so an enum-typed zone column works
  (`atTimeZone(x, zoneColumn)` renders `(x AT TIME ZONE CAST(zoneColumn AS text))`).
- `dateTrunc()` units and `datePart()` fields are allow-listed and inlined (`dateTrunc('fortnight', …)` throws
  `dateTrunc: unknown unit "fortnight"`); zones, formats and intervals bind as parameters.
- A JS `Date` argument binds as `timestamptz` (`datePart('year', new Date(…))` renders
  `EXTRACT(YEAR FROM CAST($1 AS timestamptz))`); a string argument stays untyped, and PostgreSQL parses it as the type
  the function needs.
- A date or timestamp result is a JS `Date` as the driver parses it (node-postgres reads a `timestamp` and a `date`
  in the process's local time zone). Wrap it in `castAsString()` for the exact text, as the "as text" values above
  were read.

## Read, filter, build and change JSONB

The examples read `users.metadata` (jsonb) and `orders.items` (jsonb), set to:

| Row | Value |
|---|---|
| alice's `metadata` | `{ "plan": "pro", "score": "120", "tags": ["admin", "beta"], "address": { "city": "Vienna", "zip": "1010" } }` |
| bob's `metadata` | `{ "plan": "free", "score": "007", "tags": [], "address": { "city": "Graz" } }` |
| charlie's `metadata` | SQL NULL |
| order 1's `items` | `[{ "productName": "Book", "quantity": 2, "price": 10 }, { "productName": "Pen", "quantity": 1, "price": 2 }]` |
| order 2's `items` | `[{ "productName": "Lamp", "quantity": 1, "price": 149.99 }]` |

### Read a value from a document: jsonbPath(), jsonbPathText()

`jsonbPath()` follows `->` steps and reads parsed JSON; `jsonbPathText()` ends in `->>` and reads the text exactly.
String keys are inlined as quoted literals, integers are array indexes (negative ones count from the end), and a
fragment key such as `param(key)` binds one parameter.

| Helper | Renders | bob reads |
|---|---|---|
| `jsonbPath(doc, 'address')` | `("users"."metadata"->'address')` | `{ city: 'Graz' }` |
| `jsonbPathText(doc, 'address', 'city')` | `("users"."metadata"->'address'->>'city')` | `'Graz'` |
| `jsonbPathText(doc, 'tags', 0)` | `("users"."metadata"->'tags'->>0)` | `null` (alice: `'admin'`) |
| `jsonbPath(doc, 'tags', -1)` | `("users"."metadata"->'tags'->(-1))` | `null` (alice: `'beta'`) |
| `jsonbPathText(doc, param(key))` | `("users"."metadata"->>$1)` | `'free'` (key `'plan'` bound) |
| `jsonbValueText(x)` | `(("users"."metadata"->'plan') #>> '{}')` | `'free'`: the whole value as text, a string unquoted |
| `jsonbPathText(doc, 'score')` | `("users"."metadata"->>'score')` | `'007'` |
| `jsonbSelectText<T>(doc, 'score')` (older) | `("users"."metadata"->>'score')` | `7`: no mapper, digits-only text becomes a number |
| `jsonbSelect<T>(doc, 'plan')` (older) | `(("users"."metadata" #>> '{}')::jsonb->'plan')` | `'free'`, after re-parsing the whole document |

```ts
type UserMeta = { plan: string; score: string; tags: string[]; address: { city: string; zip?: string } };

const key = 'plan';
const reads = await db.users
  .select(u => ({
    username: u.username,
    address: jsonbPath(u.metadata, 'address'),
    city: jsonbPathText(u.metadata, 'address', 'city'),
    firstTag: jsonbPathText(u.metadata, 'tags', 0),
    lastTag: jsonbPath(u.metadata, 'tags', -1),
    boundKey: jsonbPathText(u.metadata, param(key)),
    plan: jsonbValueText(jsonbPath(u.metadata, 'plan')),
    score: jsonbPathText(u.metadata, 'score'),
    legacyScore: jsonbSelectText<UserMeta>(u.metadata, 'score'),
    legacyPlan: jsonbSelect<UserMeta>(u.metadata, 'plan'),
  }))
  .orderBy(u => u.username)
  .toList();
// charlie (NULL document): every path reads null; legacyScore and legacyPlan read undefined
```

```sql
SELECT "users"."username" as "username",
  ("users"."metadata"->'address') as "address",
  ("users"."metadata"->'address'->>'city') as "city",
  ("users"."metadata"->'tags'->>0) as "firstTag",
  ("users"."metadata"->'tags'->(-1)) as "lastTag",
  ("users"."metadata"->>$1) as "boundKey",
  (("users"."metadata"->'plan') #>> '{}') as "plan",
  ("users"."metadata"->>'score') as "score",
  ("users"."metadata"->>'score') as "legacyScore",
  (("users"."metadata" #>> '{}')::jsonb->'plan') as "legacyPlan"
FROM "users"
ORDER BY "username" ASC
-- params: [ "plan" ]
```

- Compare a JSON number as a number with a cast: `gt(castAsInt(jsonbPathText(u.metadata, 'score')), 100)` renders
  `CAST(("users"."metadata"->>'score') AS integer) > $1`.
- An inline string key matches a btree expression index on `(metadata->>'k')`; a bound key (`param(key)`) keeps one
  statement text for every key but cannot match such an index. In a prepared query a key can be
  `sql.placeholder('key')`.
- `jsonbSelect()` / `jsonbSelectText()` take a `keyof T` key but carry no mapper, and `jsonbSelect()` re-parses the
  document per row (`#>> '{}'` then `::jsonb`), which fails on a document that is a JSON string. Use `jsonbPath()` /
  `jsonbPathText()` in new code.
- `jsonbValueText(x)` reads a JSON string unquoted (`"x"` → `x`), a number or boolean as its text, an object or array
  as its JSON text; SQL NULL and JSON `null` give NULL. `castAsString(x)` (`jsonb::text`) keeps a string's quotes.
- A key containing a quote is escaped (`'it''s'`), in every JSON helper and in `jsonbArraySome` element paths.

### Filter documents: jsonbContains(), jsonbHasKey(), jsonbPathExists(), jsonbArraySome()

| Helper | Renders | GIN index on the column / notes |
|---|---|---|
| `jsonbContains(doc, { plan: 'pro' })` | `("users"."metadata" @> CAST(CAST($6 AS text) AS jsonb))` | yes (`jsonb_ops` and `jsonb_path_ops`) |
| `jsonbHasKey(doc, 'address')` | `("users"."metadata" ? CAST($7 AS text))` | yes (`jsonb_ops`) |
| `jsonbHasAnyKey(doc, ['score', 'rating'])` | `("users"."metadata" ?\| CAST($1 AS text[]))` | yes (`jsonb_ops`) |
| `jsonbHasAllKeys(doc, ['plan', 'rating'])` | `("users"."metadata" ?& CAST($2 AS text[]))` | yes (`jsonb_ops`) |
| `jsonbContainedBy(x, ['admin', 'beta', 'staff'])` | `(("users"."metadata"->'tags') <@ CAST(CAST($3 AS text) AS jsonb))` | no |
| `jsonbPathExists(doc, path, { vars })` | `jsonb_path_exists("users"."metadata", CAST($1 AS jsonpath), CAST(CAST($2 AS text) AS jsonb), false)` | no: a function call (GIN serves the `@?` / `@@` operators, which are not emitted) |
| `jsonbArraySome<T>(doc, el => cond)` | `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("orders"."items") = 'array' THEN "orders"."items" ELSE '[]'::jsonb END) AS __elem WHERE …)` | no: a per-row EXISTS |
| `jsonbTypeOf(x)` | `jsonb_typeof(("users"."metadata"->'tags'))` | reads `'object' \| 'array' \| 'string' \| 'number' \| 'boolean' \| 'null'` |
| `jsonbArrayLength(x)` | `jsonb_array_length(("users"."metadata"->'tags'))` | reads a number; raises for a non-array |

```ts
const pro = await db.users
  .where(u => and(jsonbContains(u.metadata, { plan: 'pro' }), jsonbHasKey(u.metadata, 'address')))
  .select(u => ({
    username: u.username,
    anyKey: jsonbHasAnyKey(u.metadata, ['score', 'rating']),
    allKeys: jsonbHasAllKeys(u.metadata, ['plan', 'rating']),
    tagsWithin: jsonbContainedBy(jsonbPath(u.metadata, 'tags'), ['admin', 'beta', 'staff']),
    tagsType: jsonbTypeOf(jsonbPath(u.metadata, 'tags')),
    tagCount: jsonbArrayLength(jsonbPath(u.metadata, 'tags')),
    safeCount: caseWhen(eq(jsonbTypeOf(u.metadata), 'array'), jsonbArrayLength(u.metadata)).else(0),
  }))
  .toList();
// [{ username: 'alice', anyKey: true, allKeys: false, tagsWithin: true, tagsType: 'array', tagCount: 2, safeCount: 0 }]
```

```sql
SELECT "users"."username" as "username",
  ("users"."metadata" ?| CAST($1 AS text[])) as "anyKey",
  ("users"."metadata" ?& CAST($2 AS text[])) as "allKeys",
  (("users"."metadata"->'tags') <@ CAST(CAST($3 AS text) AS jsonb)) as "tagsWithin",
  jsonb_typeof(("users"."metadata"->'tags')) as "tagsType",
  jsonb_array_length(("users"."metadata"->'tags')) as "tagCount",
  CASE WHEN jsonb_typeof("users"."metadata") = $4 THEN jsonb_array_length("users"."metadata") ELSE $5 END as "safeCount"
FROM "users"
WHERE (("users"."metadata" @> CAST(CAST($6 AS text) AS jsonb)) AND ("users"."metadata" ? CAST($7 AS text)))
-- params: [ "{\"score\",\"rating\"}", "{\"plan\",\"rating\"}", "[\"admin\",\"beta\",\"staff\"]", "array", 0, "{\"plan\":\"pro\"}", "address" ]
```

`jsonbPathExists()` evaluates an SQL/JSON path. A string path binds as one parameter and plain `vars` are serialized;
`literal(path, 'jsonpath')` keeps the path inline, and `jsonbBuildObject()` passes per-row values as `vars`:

```ts
await db.users
  .where(u => jsonbPathExists(u.metadata, '$.tags[*] ? (@ == $tag)', { vars: { tag: 'beta' } }))
  .select(u => ({ username: u.username }))
  .toList();   // [{ username: 'alice' }]

await db.users
  .where(u => jsonbPathExists(u.metadata, literal('strict $.address ? (@.city == $city)', 'jsonpath'), {
    vars: jsonbBuildObject({ city: literal('Graz') }),
    silent: true,
  }))
  .select(u => ({ username: u.username }))
  .toList();   // [{ username: 'bob' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE jsonb_path_exists("users"."metadata", CAST($1 AS jsonpath), CAST(CAST($2 AS text) AS jsonb), false)
-- params: [ "$.tags[*] ? (@ == $tag)", "{\"tag\":\"beta\"}" ]

SELECT "users"."username" as "username"
FROM "users"
WHERE jsonb_path_exists("users"."metadata", CAST('strict $.address ? (@.city == $city)' AS jsonpath), jsonb_build_object('city', 'Graz'), true)
```

`jsonbArraySome()` matches an array element on several of its fields. Element values are compared as TEXT (`->>`),
so pass numbers, booleans and numeric enum members through `jsonbConditionUnwrap()` (`String(value)`): node-postgres
sends a number or boolean as untyped text and it matches, but postgres.js types a boolean and Bun's SQL client types
both, and PostgreSQL then fails with `operator does not exist: text = boolean` / `text = integer`. When the condition
is an exact match, array containment does the same and is GIN-indexable:

```ts
type OrderItem = { productName: string; quantity: number; price: number };

await db.orders
  .where(o => jsonbArraySome<OrderItem>(o.items, it => and(eq(it.productName, 'Book'), eq(it.quantity, jsonbConditionUnwrap(2)))))
  .select(o => ({ id: o.id }))
  .toList();   // [{ id: 1 }]

await db.orders
  .where(o => jsonbContains(o.items, [{ productName: 'Book', quantity: 2 }]))
  .select(o => ({ id: o.id }))
  .toList();   // [{ id: 1 }]
```

```sql
SELECT "orders"."id" as "id"
FROM "orders"
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("orders"."items") = 'array' THEN "orders"."items" ELSE '[]'::jsonb END) AS __elem WHERE ((__elem->>'productName') = $1 AND (__elem->>'quantity') = $2))
-- params: [ "Book", "2" ]

SELECT "orders"."id" as "id"
FROM "orders"
WHERE ("orders"."items" @> CAST(CAST($1 AS text) AS jsonb))
-- params: [ "[{\"productName\":\"Book\",\"quantity\":2}]" ]
```

- Values given to `jsonbContains()` / `jsonbContainedBy()` are JSON-serialized: `'x'` is the JSON string `"x"`. One
  bound parameter per value or key list, so the statement text does not depend on it.
- `jsonbPathExists()` with `vars` or `silent` renders all four arguments (`…, false)` when not silent). `silent: true`
  turns a strict path's structural error (a missing key) into NULL instead of failing the statement. A plain `vars`
  object holding a column or an expression throws; build it with `jsonbBuildObject()`.
- `jsonbArraySome()` skips rows whose value is not an array (an object, a scalar, NULL) instead of failing. Nested
  element fields navigate with `->`: `it.meta.ref` renders `(__elem->'meta'->>'ref')`.
- Guard `jsonbArrayLength()` with `caseWhen(eq(jsonbTypeOf(x), 'array'), jsonbArrayLength(x))` where the column can
  hold other shapes.

### Build JSON in SQL: jsonbBuildObject(), jsonBuildArray(), toJsonb()

The builders turn columns, navigations, conditions and constants into one JSON value: keys are inlined, plain values
bind typed, nested plain objects and arrays become nested builder calls, and conditions become booleans.

| Helper (post 1) | Renders | Reads as |
|---|---|---|
| `jsonbBuildObject({ id: p.id, author: { name: p.user!.username }, version: 'v1', popular: gt(p.views, 120) })` | `jsonb_build_object('id', "posts"."id", 'author', jsonb_build_object('name', "user"."username"), 'version', CAST($1 AS text), 'popular', ("posts"."views" > $2))` | `{ id: 1, author: { name: 'alice' }, popular: false, version: 'v1' }` |
| `jsonbBuildArray(p.id, p.title, 1)` | `jsonb_build_array("posts"."id", "posts"."title", CAST($3 AS integer))` | `[1, 'Alice Post 1', 1]` |
| `jsonBuildObject({ z: p.id, a: p.title })` | `json_build_object('z', "posts"."id", 'a', "posts"."title")` | `{ z: 1, a: 'Alice Post 1' }`: `json` keeps the written key order |
| `jsonBuildArray(p.id, p.customDate)` | `json_build_array("posts"."id", "posts"."custom_date")` | `[1, -30376800]`: a mapped column is its stored value |
| `toJsonb(p.title)` | `to_jsonb("posts"."title")` | `'Alice Post 1'` |
| `jsonbBuildObject({})` | `jsonb_build_object()` | `{}` |

```ts
const built = await db.posts
  .where(p => eq(p.id, 1))
  .select(p => ({
    summary: jsonbBuildObject({ id: p.id, author: { name: p.user!.username }, version: 'v1', popular: gt(p.views, 120) }),
    pair: jsonbBuildArray(p.id, p.title, 1),
    ordered: jsonBuildObject({ z: p.id, a: p.title }),
    tuple: jsonBuildArray(p.id, p.customDate),
    title: toJsonb(p.title),
    empty: jsonbBuildObject({}),
  }))
  .firstOrDefault();
```

```sql
SELECT jsonb_build_object('id', "posts"."id", 'author', jsonb_build_object('name', "user"."username"), 'version', CAST($1 AS text), 'popular', ("posts"."views" > $2)) as "summary",
  jsonb_build_array("posts"."id", "posts"."title", CAST($3 AS integer)) as "pair",
  json_build_object('z', "posts"."id", 'a', "posts"."title") as "ordered",
  json_build_array("posts"."id", "posts"."custom_date") as "tuple",
  to_jsonb("posts"."title") as "title",
  jsonb_build_object() as "empty"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE "posts"."id" = $4
LIMIT 1
-- params: [ "v1", 120, 1, 1 ]
```

- No mapper applies inside JSON: a `timestamp` arrives as JSON text (`'2024-03-10T08:30:00'`, no zone), a mapped column
  as its stored value. To get typed values, project the columns themselves; a nested object in `select()` renders as
  columns read through their mappers.
- `json` keeps the written key order and is cheaper to build when the value only travels to the client; `jsonb` does
  not keep the order.

### Change part of a document in one UPDATE: jsonbSet(), jsonbMerge(), jsonbRemoveKey()

These helpers change a document inside the UPDATE, without reading it first. Each call below is one statement.

| Helper (in `update(u => ({ metadata: … }))`) | Renders | Effect |
|---|---|---|
| `jsonbSet(u.metadata, ['address', 'city'], 'Linz')` | `jsonb_set("users"."metadata", CAST($1 AS text[]), CAST(CAST($2 AS text) AS jsonb), true)` | sets the value at the path; `createMissing` (default `true`) adds a missing key |
| `jsonbRemoveKey(u.metadata, 'score')` | `("users"."metadata" - CAST($1 AS text))` | removes a top-level key |
| `jsonbRemoveKey(u.metadata, 'a', 'b')` | `("users"."metadata" - CAST($1 AS text[]))` | removes several top-level keys |
| `jsonbRemovePath(u.metadata, ['address', 'zip'])` | `("users"."metadata" #- CAST($1 AS text[]))` | removes a nested value |
| `jsonbMerge(u.metadata, { seen: true })` | `(COALESCE("users"."metadata", '{}'::jsonb) \|\| ($1)::jsonb)` | merges top-level keys; a NULL document starts from `{}` |
| `jsonbSet(coalesce(u.metadata, literal('{}', 'jsonb')), ['plan'], 'trial')` | `jsonb_set(COALESCE("users"."metadata", CAST('{}' AS jsonb)), CAST($1 AS text[]), CAST(CAST($2 AS text) AS jsonb), true)` | sets a key on a NULL document too |

```ts
await db.users.where(u => eq(u.username, 'alice')).update(u => ({ metadata: jsonbSet(u.metadata, ['address', 'city'], 'Linz') }));
await db.users.where(u => eq(u.username, 'alice')).update(u => ({ metadata: jsonbRemovePath(u.metadata, ['address', 'zip']) }));
await db.users.where(u => eq(u.username, 'bob')).update(u => ({ metadata: jsonbMerge(u.metadata, { seen: true }) }));
await db.users.where(u => eq(u.username, 'charlie')).update(u => ({ metadata: jsonbSet(coalesce(u.metadata, literal('{}', 'jsonb')), ['plan'], 'trial') }));
// alice: { plan: 'pro', tags: [...], score: '120', address: { city: 'Linz' } } · bob: { …, seen: true } · charlie: { plan: 'trial' }
```

```sql
UPDATE "users" SET "metadata" = jsonb_set("users"."metadata", CAST($1 AS text[]), CAST(CAST($2 AS text) AS jsonb), true) WHERE "users"."username" = $3
-- params: [ "{\"address\",\"city\"}", "\"Linz\"", "alice" ]

UPDATE "users" SET "metadata" = ("users"."metadata" #- CAST($1 AS text[])) WHERE "users"."username" = $2
-- params: [ "{\"address\",\"zip\"}", "alice" ]

UPDATE "users" SET "metadata" = (COALESCE("users"."metadata", '{}'::jsonb) || ($1)::jsonb) WHERE "users"."username" = $2
-- params: [ { "seen": true }, "bob" ]

UPDATE "users" SET "metadata" = jsonb_set(COALESCE("users"."metadata", CAST('{}' AS jsonb)), CAST($1 AS text[]), CAST(CAST($2 AS text) AS jsonb), true) WHERE "users"."username" = $3
-- params: [ "{\"plan\"}", "\"trial\"", "charlie" ]
```

- `jsonbSet()` on a NULL document leaves it NULL (PostgreSQL semantics): start from
  `coalesce(col, literal('{}', 'jsonb'))`, as above.
- Values are JSON-serialized: `'Linz'` binds `"Linz"`, `null` sets JSON null; `undefined` throws. An expression value
  must already be jsonb (wrap others in `toJsonb()`). The path and the value are one parameter each.
- `jsonbMerge()` replaces whole top-level values (`||`); change a nested key with `jsonbSet()`. Its plain patch binds
  raw and the driver serializes it: a JS ARRAY patch fails on node-postgres (`invalid input syntax for type json`, it
  is sent as a PostgreSQL array literal). Wrap the patch in `castAsJsonb(patch)` to be driver-neutral:
  `jsonbMerge(o.items, castAsJsonb([{ productName: 'Cable', quantity: 1, price: 5 }]))` renders
  `(COALESCE("orders"."items", '{}'::jsonb) || (CAST(CAST($1 AS text) AS jsonb))::jsonb)`.

## Query array columns

Array helpers work on native array columns (`text('tags').array()`) and bind a JS list as ONE array-literal parameter
cast to the column's declared type, so the statement text does not change with the list length. The example model has
no array column; this example declares one:

```ts
import {
  DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, text,
  arrayContains, arrayContainsAll, arrayOverlaps, arrayContainedBy, arrayLength, arrayIsEmpty, arrayIsNotEmpty,
} from 'linkgress-orm';

class Book extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  tags?: DbColumn<string[] | null>;
  ratings?: DbColumn<number[] | null>;
}

class Library extends DbContext {
  get books(): DbEntityTable<Book> {
    return this.table(Book);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Book, entity => {
      entity.toTable('books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'books_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.ratings).hasType(integer('ratings').array());
    });
  }
}

const library = new Library(client);   // client: any DatabaseClient (PgClient, PostgresClient, …)

// Dune: tags ['novel', 'classic'], ratings [5, 4, 4] · Odes: ['poetry'], [] · Draft: NULL, NULL
const rows = await library.books
  .where(b => arrayOverlaps(b.tags, ['novel', 'poetry']))
  .select(b => ({
    title: b.title,
    isNovel: arrayContains(b.tags, 'novel'),
    hasFive: arrayContains(b.ratings, 5),
    classicNovel: arrayContainsAll(b.tags, ['novel', 'classic']),
    validRatings: arrayContainedBy(b.ratings, [1, 2, 3, 4, 5]),
    tagCount: arrayLength(b.tags),
    unrated: arrayIsEmpty(b.ratings),
    rated: arrayIsNotEmpty(b.ratings),
  }))
  .toList();
// Dune: isNovel true, hasFive true, classicNovel true, validRatings true, tagCount 2, unrated false, rated true
// Odes: isNovel false, hasFive false, classicNovel false, validRatings true, tagCount 1, unrated true, rated false
```

```sql
SELECT "books"."title" as "title",
  (CAST($1 AS text) = ANY("books"."tags")) as "isNovel",
  (CAST($2 AS integer) = ANY("books"."ratings")) as "hasFive",
  ("books"."tags" @> CAST($3 AS text[])) as "classicNovel",
  ("books"."ratings" <@ CAST($4 AS integer[])) as "validRatings",
  cardinality("books"."tags") as "tagCount",
  (cardinality("books"."ratings") = 0) as "unrated",
  (cardinality("books"."ratings") > 0) as "rated"
FROM "books"
WHERE ("books"."tags" && CAST($5 AS text[]))
-- params: [ "novel", 5, "{\"novel\",\"classic\"}", "{1,2,3,4,5}", "{\"novel\",\"poetry\"}" ]
```

| Helper | SQL | True when | GIN index (`array_ops`) |
|---|---|---|---|
| `arrayContains(col, v)` | `(CAST($1 AS text) = ANY("books"."tags"))` | the array holds `v` | no |
| `arrayContainsAll(col, list)` | `("books"."tags" @> CAST($3 AS text[]))` | the array holds every listed value | yes |
| `arrayOverlaps(col, list)` | `("books"."tags" && CAST($5 AS text[]))` | the array holds at least one listed value | yes |
| `arrayContainedBy(col, list)` | `("books"."ratings" <@ CAST($4 AS integer[]))` | every element is in the list (an empty array always) | yes |
| `arrayLength(col)` | `cardinality("books"."tags")` | reads the element count: `0` for `{}`, `null` for NULL | — |
| `arrayIsEmpty(col)` · `arrayIsNotEmpty(col)` | `(cardinality("books"."ratings") = 0)` · `(cardinality("books"."ratings") > 0)` | NULL for a NULL array (read as `undefined`), not `true` | — |

> **Efficiency:** to find rows holding one value in a large table, write `arrayContainsAll(col, [v])` (`@>`, served by a
> GIN index) instead of `arrayContains(col, v)` (`= ANY(col)`, which no GIN index serves).

- The element cast comes from the column's declared type; a column without type information (a CTE column) leaves the
  value for PostgreSQL to resolve.
- `arrayLength()` is `cardinality()`, so an empty array has length `0`; `array_length(x, 1)` would be NULL.
- A scalar column against a JS list is the reverse shape: `eqAny(column, list)` / `inArray()` in
  [Querying](./querying.md). To read an array's elements as rows, use `unnest` in
  [Set-returning functions](./set-returning-functions.md).

### Change an array in place: arrayAppendUnique(), arrayRemove() (since 1.0.31)

`arrayAppendUnique(col, value)` and `arrayRemove(col, value)` are values for the SET of an UPDATE: the statement computes
the new array from each row's current one, so there is no read-modify-write, and running it twice changes nothing more.
In a `select()` they preview the change without writing.

| Helper (over `books`) | Renders | Result |
|---|---|---|
| `arrayAppendUnique(b.tags, 'classic')` | `(CASE WHEN CAST($1 AS text) = ANY("books"."tags") THEN "books"."tags" ELSE array_append(COALESCE("books"."tags", CAST('{}' AS text[])), CAST($2 AS text)) END)` | the array with the value appended, unless it holds it already; a NULL array counts as empty (`{classic}`) |
| `arrayRemove(b.ratings, 4)` | `array_remove("books"."ratings", CAST($1 AS integer))` | every element equal to the value removed; an array without it unchanged; a NULL array stays NULL |
| `arrayRemove(b.tags, null)` | `array_remove("books"."tags", CAST(NULL AS text))` | the NULL elements removed |

```ts
import { arrayAppendUnique, arrayRemove, eqAny } from 'linkgress-orm';

// Dune: tags ['novel', 'classic'], ratings [5, 4, 4] · Odes: ['poetry'], [] · Draft: NULL, NULL
const bookIds = [1, 2, 3];
await library.books.where(b => eqAny(b.id, bookIds)).update(b => ({ tags: arrayAppendUnique(b.tags, 'classic') }));
await library.books.where(b => eqAny(b.id, bookIds)).update(b => ({ ratings: arrayRemove(b.ratings, 4) }));
// tags:    Dune ['novel', 'classic'] (held it) · Odes ['poetry', 'classic'] · Draft ['classic'] (NULL counts as empty)
// ratings: Dune [5] (both 4s removed) · Odes [] · Draft NULL (stays NULL)
// the first statement once more: every row keeps its tags
```

```sql
UPDATE "books" SET "tags" = (CASE WHEN CAST($1 AS text) = ANY("books"."tags") THEN "books"."tags" ELSE array_append(COALESCE("books"."tags", CAST('{}' AS text[])), CAST($2 AS text)) END) WHERE ("books"."id" = ANY($3::integer[]))
-- params: [ "classic", "classic", "{1,2,3}" ]

UPDATE "books" SET "ratings" = array_remove("books"."ratings", CAST($1 AS integer)) WHERE ("books"."id" = ANY($2::integer[]))
-- params: [ 4, "{1,2,3}" ]
```

Both directions in one UPDATE: a `caseWhen` picks the helper per row.

```ts
// from the rows above as seeded: Dune ['novel', 'classic'] → ['novel'] · Odes ['poetry'] → ['poetry', 'classic']
await library.books
  .where(b => eqAny(b.id, [1, 2]))
  .update(b => ({ tags: caseWhen(eq(b.id, 1), arrayRemove(b.tags, 'classic')).else(arrayAppendUnique(b.tags, 'classic')) }));
```

```sql
UPDATE "books" SET "tags" = CASE WHEN "books"."id" = $1 THEN array_remove("books"."tags", CAST($2 AS text)) ELSE (CASE WHEN CAST($3 AS text) = ANY("books"."tags") THEN "books"."tags" ELSE array_append(COALESCE("books"."tags", CAST('{}' AS text[])), CAST($4 AS text)) END) END WHERE ("books"."id" = ANY($5::integer[]))
-- params: [ 1, "classic", "classic", "classic", "{1,2}" ]
```

- A plain value is ONE parameter cast to the column's element type when the column ref carries its type
  (`CAST($1 AS text)`); `arrayAppendUnique` binds it twice (the test and the append) and casts the empty array to the
  column's type (`CAST('{}' AS text[])`).
- `arrayAppendUnique(col, null)` throws before anything is sent: `arrayAppendUnique(): the value is null — NULL equals
  nothing, so it would be appended on every call`.
- In a projection the result reads as the driver delivers the array, and a NULL array as `undefined` at the top level,
  like any fragment without a mapper.
- Select the rows to change by key, or for a removal with `arrayContainsAll(col, [v])` (`@>`, GIN-indexable): without
  `where()` the UPDATE rewrites every row of the table ([Inserts, updates and upserts](./insert-update-guide.md#add-or-remove-one-value-of-an-array-column-arrayappendunique-arrayremove-since-1031)).

## Aggregate inside an expression: agg

`agg.*` returns aggregates as fragments. A `select()` of them without `groupBy()` aggregates the whole filtered set
into ONE row, also over zero input rows; every aggregate is computed in the same scan. Inside `asSubquery('scalar')`
they give one aggregate per outer row, and inside a grouped select one per group.

| Helper (over `posts`) | Renders | Reads as |
|---|---|---|
| `agg.count()` | `count(*)` | `number` (`0` over no rows) |
| `agg.count(x)` | `count("posts"."subtitle")` | `number`: the non-NULL values |
| `agg.countDistinct(x)` | `count(DISTINCT "posts"."user_id")` | `number` |
| `agg.sum(x, { distinct? })` | `sum("posts"."views")` · `sum(DISTINCT "posts"."views")` | `number \| null` (numeric / int8 text converted) |
| `agg.avg(x, { distinct? })` | `avg("posts"."views")` | `number \| null` |
| `agg.min(x)` · `agg.max(x)` | `min("posts"."title")` · `max("posts"."custom_date")` | through `x`'s mapper (`max` of `custom_date` reads a `Date`); a JS number for a numeric / int8 operand; else as delivered |
| `agg.bitOr(x)` · `agg.bitAnd(x)` | `bit_or("posts"."views")` · `bit_and("posts"."views")` | `number \| null` |
| `agg.arrayAgg(x, { distinct?, orderBy? })` | `array_agg("posts"."id" ORDER BY "posts"."views" DESC)` | an array, elements through `x`'s mapper; `null` over no rows |
| `agg.jsonAgg(x, { distinct?, orderBy? })` | `json_agg("posts"."title" ORDER BY "posts"."title" ASC)` | the parsed JSON array, no per-element mapping; `null` over no rows |
| `agg.jsonbAgg(x, { distinct?, orderBy? })` | `jsonb_agg(DISTINCT "posts"."category")` | as `jsonAgg` |
| `<aggregate>.filter(cond)` | `count(*) FILTER (WHERE "posts"."views" > $1)` | as the aggregate |

A KPI row, one statement:

```ts
const stats = await db.posts
  .where(p => gte(p.views, 0))
  .select(p => ({
    posts: agg.count(),
    withSubtitle: agg.count(p.subtitle),
    authors: agg.countDistinct(p.userId),
    views: agg.sum(p.views),
    distinctViews: agg.sum(p.views, { distinct: true }),
    avgViews: agg.avg(p.views),
    popular: agg.count().filter(gt(p.views, 120)),
    firstTitle: agg.min(p.title),
    lastCustomDate: agg.max(p.customDate),
    anyBits: agg.bitOr(p.views),
    allBits: agg.bitAnd(p.views),
    ids: agg.arrayAgg(p.id, { orderBy: [[p.views, 'DESC']] }),
    titles: agg.jsonAgg(p.title, { orderBy: p.title }),
    categories: agg.jsonbAgg(p.category, { distinct: true }),
    names: agg.arrayAgg(lower(p.title), { distinct: true, orderBy: [[lower(p.title), 'DESC']] }),
  }))
  .firstOrDefault();
// { posts: 3, withSubtitle: 0, authors: 2, views: 450, distinctViews: 450, avgViews: 150, popular: 2,
//   firstTitle: 'Alice Post 1', lastCustomDate: Date(2024-01-16T10:00:00.000Z), anyBits: 254, allBits: 0,
//   ids: [3, 2, 1], titles: ['Alice Post 1', 'Alice Post 2', 'Bob Post'], categories: ['tech'],
//   names: ['bob post', 'alice post 2', 'alice post 1'] }
```

```sql
SELECT count(*) as "posts",
  count("posts"."subtitle") as "withSubtitle",
  count(DISTINCT "posts"."user_id") as "authors",
  sum("posts"."views") as "views",
  sum(DISTINCT "posts"."views") as "distinctViews",
  avg("posts"."views") as "avgViews",
  count(*) FILTER (WHERE "posts"."views" > $1) as "popular",
  min("posts"."title") as "firstTitle",
  max("posts"."custom_date") as "lastCustomDate",
  bit_or("posts"."views") as "anyBits",
  bit_and("posts"."views") as "allBits",
  array_agg("posts"."id" ORDER BY "posts"."views" DESC) as "ids",
  json_agg("posts"."title" ORDER BY "posts"."title" ASC) as "titles",
  jsonb_agg(DISTINCT "posts"."category") as "categories",
  array_agg(DISTINCT lower("posts"."title") ORDER BY lower("posts"."title") DESC) as "names"
FROM "posts"
WHERE "posts"."views" >= $2
LIMIT 1
-- params: [ 120, 0 ]
```

> **Efficiency:** one scan computes every aggregate and one row travels. Separate `count()` / `sum()` calls cost one
> round trip each; a `select()` of aggregates is also a `QueryBatch` item (`batch.addFirstOrDefault(…)`), so a KPI row
> and the page's lists share one round trip ([Batching and prepared queries](./batching-and-prepared-queries.md)).

Over zero rows a count is `0` and every other aggregate NULL, a list aggregate included. Wrap a list in `coalesce()`
for an always-array value:

```ts
const empty = await db.posts
  .where(p => gt(p.views, 100000))
  .select(p => ({
    posts: agg.count(),
    views: agg.sum(p.views),
    ids: agg.arrayAgg(p.id),
    idsOrEmpty: coalesce(agg.arrayAgg(p.id), literal('{}', 'integer[]')),
    titlesOrEmpty: coalesce(agg.jsonAgg(p.title), literal('[]', 'json')),
  }))
  .firstOrDefault();
// { posts: 0, views: null, ids: null, idsOrEmpty: [], titlesOrEmpty: [] }
```

```sql
SELECT count(*) as "posts",
  sum("posts"."views") as "views",
  array_agg("posts"."id") as "ids",
  COALESCE(array_agg("posts"."id"), CAST('{}' AS integer[])) as "idsOrEmpty",
  COALESCE(json_agg("posts"."title"), CAST('[]' AS json)) as "titlesOrEmpty"
FROM "posts"
WHERE "posts"."views" > $1
LIMIT 1
-- params: [ 100000 ]
```

An aggregate per outer row for any correlation, no navigation needed. A projected scalar subquery of one aggregate
reads like the aggregate (`agg.max()` of a text column keeps `'007'`, of a mapped column reads through its mapper);
its `.asExpression()` carries no mapper and reads through the generic conversion (`'007'` → `7`) unless typed with
`.withReadType()` / `.mapWith()`:

```ts
const perUser = await db.users
  .select(u => ({
    username: u.username,
    posts: db.posts.where(p => eq(p.userId, u.id)).select(() => agg.count()).asSubquery('scalar'),
    avgViews: db.posts.where(p => eq(p.userId, u.id)).select(p => agg.avg(p.views)).asSubquery('scalar'),
    titles: db.posts.where(p => eq(p.userId, u.id)).select(p => coalesce(agg.jsonAgg(p.title, { orderBy: p.id }), literal('[]', 'json'))).asSubquery('scalar'),
  }))
  .orderBy(u => u.username)
  .toList();
// alice: posts 2, avgViews 125, titles ['Alice Post 1', 'Alice Post 2'] · bob: 1, 200, ['Bob Post'] · charlie: 0, null, []
```

```sql
SELECT "users"."username" as "username", (SELECT count(*)
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "posts", (SELECT avg("posts"."views")
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "avgViews", (SELECT COALESCE(json_agg("posts"."title" ORDER BY "posts"."id" ASC), CAST('[]' AS json))
FROM "posts"
WHERE "posts"."user_id" = "users"."id") as "titles"
FROM "users"
ORDER BY "username" ASC
```

> **Efficiency:** each correlated subquery runs once per outer row; an index on the correlation column
> (`posts.user_id`) keeps it cheap. With a navigation, `u.posts!.count()` / `.sum()` compute the same values without a
> written correlation, in the SQL the collection strategy chooses ([Collection strategies](../collection-strategies.md));
> for many outer rows and a heavy aggregate, join a grouped table subquery instead (each group aggregated once).

In a grouped select, `agg.*` aggregates each group (also when the grouping key is an expression) but can read only the
keys (`g.key`); aggregate a non-key column conditionally with a CASE inside `g.sum()`:

```ts
const completedPerUser = await db.orders
  .select(o => ({ userId: o.userId, status: o.status, total: o.totalAmount }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({
    userId: g.key.userId,
    orders: agg.count(),
    completed: g.sum(r => caseWhen(eq(r.status, 'completed'), 1).else(0)),
  }))
  .orderBy(r => r.userId)
  .toList();
// [{ userId: 1, orders: 1, completed: 1 }, { userId: 2, orders: 1, completed: 0 }]
```

```sql
SELECT "orders"."user_id" as "userId",
  count(*) as "orders",
  CAST(SUM(CASE WHEN "orders"."status" = $1 THEN CAST($2 AS integer) ELSE CAST($3 AS integer) END) AS DOUBLE PRECISION) as "completed"
FROM "orders"
GROUP BY "orders"."user_id"
ORDER BY "userId" ASC
-- params: [ "completed", 1, 0 ]
```

To list a non-key column's values per group, or count its distinct values, use the grouped row's own aggregates
(since 1.0.31): `g.arrayAgg(r => r.col, { distinct?, orderBy? })` and `g.countDistinct(r => r.col)`. Over
`groupBy(r => ({ userId: r.userId }))`, `g.arrayAgg(r => r.id, { orderBy: [[r => r.id, 'DESC']] })` renders
`array_agg("posts"."id" ORDER BY "posts"."id" DESC)` (each element read through the column's mapper) and
`g.countDistinct(r => r.customDate)` renders `count(DISTINCT "posts"."custom_date")`, in a projection and in
`having()`. They are described with GROUP BY in [Querying](./querying.md).

- `.filter(cond)` appends `FILTER (WHERE …)` with the condition bare (`and()` / `or()` keep their own parentheses); a
  second `.filter()` is ANDed with the first, and a collection's `exists()` is a valid condition
  (`agg.count().filter(u.posts!.exists())`). The fragments are immutable: `.filter()` returns a new one. Call it
  BEFORE `.mapWith()` / `.as()`, which return a plain `SqlFragment`:
  `agg.sum(o.totalAmount).filter(eq(o.status, 'completed')).mapWith(String)` reads the exact text `'99.99'`.
- Function names render lower-case and every ORDER BY key carries its direction (`ASC` by default). A key is a column
  or an expression, optionally `[key, 'ASC' | 'DESC']` (no `NULLS FIRST` / `LAST`); a plain JS value is refused.
- Parameters number in textual order: the argument, the ORDER BY keys, the FILTER.
- With `distinct: true`, PostgreSQL requires every ORDER BY key to render exactly as the argument. A key that binds a
  parameter renders a new `$n` each time, so it is refused up front: `agg.arrayAgg(): with DISTINCT, an ORDER BY key
  must render exactly as the argument …`. Inline its constants with `literal()`.
- Project only aggregates and constants: a plain column next to them is not refused by the builder, and PostgreSQL
  fails with 42803 (`column "posts.user_id" must appear in the GROUP BY clause or be used in an aggregate function`).
  For per-key rows use `groupBy()` ([Querying](./querying.md)).
- `count()` of such a select is refused (`count(): this select projects aggregates (agg.*) without groupBy() — a
  whole-set aggregate, always ONE row. …`).
- `count`, `sum`, `avg` read through `Number()`: inexact past 2^53 and for long numerics. `.mapWith(String)` keeps the
  driver's text.
- `jsonAgg` / `jsonbAgg` elements are not mapped: a timestamp stays PostgreSQL's JSON text and a mapped column its
  stored value, although the element type names the mapped type. Aggregate a `jsonBuildObject()` /
  `jsonBuildArray()` of the values you want, typed explicitly, or use `arrayAgg` (elements through the mapper).
- Exclude NULL elements from a list with `.filter(isNotNull(x))`. postgres.js decodes a NULL element of a native array
  wrongly (`'NULL'` in a `text[]`, `NaN` in an `int4[]`), a driver defect that affects every native-array read on it:
  filter NULLs out or use `jsonAgg` where elements can be NULL on that driver.
- The unmapped elements of an `arrayAgg` are what the driver's native array decoding makes of them (over the
  in-memory database too): an int8 is a string everywhere, a numeric a JS number on node-postgres but a string
  (`'1.50'`) on postgres.js, Bun and PGlite. Map them (`.mapWith(…)`) when the type must not depend on the driver.
- On a driver without native array results (Bun's binary protocol, `supportsBinaryArrayResults() === false`), a
  projected `arrayAgg` (also through `.as()`, `.mapWith()`, `.withReadType()`, in a nested object, a grouped or
  CTE-rooted select, a UNION ALL leg, a projected `asSubquery('scalar')` of one) renders as `json_agg(…)` with the same
  arguments, and as `to_json(CAST(array_agg(…) AS text[]))` for int8 / numeric / money elements of a known SQL type (a
  column, or a fragment typed with `.withReadType()`), so each element arrives as its exact text; an `sql` template of
  unknown type takes the `json_agg` form, and an int8 there arrives as a JSON number. A date or timestamp element
  arrives as its JSON text. Wherever SQL consumes the list (a function argument, `coalesce`, CASE, WHERE, HAVING, a CTE
  body, a compared UNION / INTERSECT / EXCEPT leg, whose rows are compared and json has no equality) it stays
  `array_agg`.

## Number and rank rows: win (since 1.0.21)

`win.rowNumber()`, `win.rank()` and `win.denseRank()` are window ranking functions; `.over({ partitionBy, orderBy })`
gives the window. Unlike an aggregate, a window value keeps every input row.

| Helper (over `posts`: 100, 150, 200 views; user 1 has the first two) | Renders | Reads as |
|---|---|---|
| `win.rowNumber()` | `row_number() OVER ()` | `number`: 1, 2, 3 in the order the rows are produced |
| `win.rowNumber().over({ partitionBy: p.userId, orderBy: [[p.views, 'DESC'], p.id] })` | `row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC)` | `number`: 2, 1, 1 (restarts per user) |
| `win.rank().over({ orderBy: [[p.views, 'DESC']] })` | `rank() OVER (ORDER BY "posts"."views" DESC)` | `number`: 3, 2, 1; ties share a rank, then a gap (1, 1, 3) |
| `win.denseRank().over({ partitionBy: [p.userId, lower(p.title)], orderBy: p.views })` | `dense_rank() OVER (PARTITION BY "posts"."user_id", lower("posts"."title") ORDER BY "posts"."views" ASC)` | `number`: 1, 1, 1 (each partition holds one post); ties share a rank, no gap (1, 1, 2) |

PostgreSQL computes window functions after WHERE, GROUP BY and HAVING, so filter a window value where a CTE that
computes it is read. The top post per user, one statement:

```ts
const ranked = new DbCteBuilder().with('ranked_posts', db.posts.select(p => ({
  postId: p.id,
  userId: p.userId,
  title: p.title,
  rn: win.rowNumber().over({ partitionBy: p.userId, orderBy: [[p.views, 'DESC'], p.id] }),
})));

const topPerUser = await db.selectFromCte(ranked.cte)
  .where(r => lte(r.rn, 1))
  .select(r => ({ userId: r.userId, title: r.title }))
  .toList();
// [{ userId: 1, title: 'Alice Post 2' }, { userId: 2, title: 'Bob Post' }]
```

```sql
WITH "ranked_posts" AS (SELECT "posts"."id" as "postId", "posts"."user_id" as "userId", "posts"."title" as "title", row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC) as "rn"
FROM "posts")
SELECT "ranked_posts"."userId" as "userId", "ranked_posts"."title" as "title"
FROM "ranked_posts"
WHERE "ranked_posts"."rn" <= $1
-- params: [ 1 ]
```

The same CTE filters an entity query as an IN subquery (the subquery declares the CTE itself):

```ts
const topPosts = await db.posts
  .where(p => inSubquery(p.id, db.selectFromCte(ranked.cte).where(r => eq(r.rn, 1)).select(r => ({ id: r.postId })).asSubquery('array')))
  .select(p => ({ id: p.id, title: p.title }))
  .toList();
```

```sql
SELECT "posts"."id" as "id", "posts"."title" as "title"
FROM "posts"
WHERE "posts"."id" IN (WITH "ranked_posts" AS (SELECT "posts"."id" as "postId", "posts"."user_id" as "userId", "posts"."title" as "title", row_number() OVER (PARTITION BY "posts"."user_id" ORDER BY "posts"."views" DESC, "posts"."id" ASC) as "rn"
FROM "posts")
SELECT "ranked_posts"."postId" as "id"
FROM "ranked_posts"
WHERE "ranked_posts"."rn" = $1)
-- params: [ 1 ]
```

A window over aggregates ranks groups in a grouped select:

```ts
const leaderboard = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(r => ({ userId: r.userId }))
  .select(g => ({ userId: g.key.userId, total: g.sum(r => r.views), rank: win.rank().over({ orderBy: [[g.sum(r => r.views), 'DESC']] }) }))
  .orderBy(r => r.rank)
  .toList();
// [{ userId: 1, total: 250, rank: 1 }, { userId: 2, total: 200, rank: 2 }]
```

```sql
SELECT "posts"."user_id" as "userId", CAST(SUM("posts"."views") AS DOUBLE PRECISION) as "total", rank() OVER (ORDER BY SUM("posts"."views") DESC) as "rank"
FROM "posts"
GROUP BY "posts"."user_id"
ORDER BY "rank" ASC
```

- A `where()` on a window value in the query that computes it throws a `TypeError`
  (`` `rn` is a window function value: PostgreSQL computes window functions after WHERE and the joins, so it cannot be
  filtered in the query that computes it …``), also when the alias names a column of the table and also in a `where()`
  after a join. `orderBy()` on it works.
- A join's `on` condition over a window value is NOT caught by the builder: it inlines the window function, and
  PostgreSQL fails with `window functions are not allowed in JOIN conditions`. Join the CTE that computes it instead.
- `partitionBy` takes a column or an expression, or a list of them; `orderBy` takes the ORDER BY keys of the list
  aggregates (`'ASC' | 'DESC'` only). A plain JS value as a key is refused. `over({})` and no `over()` both render
  `OVER ()`.
- `.over()` returns a new fragment over the window it is given; a window given before is replaced, not merged.
- A navigation used only in a key is joined. Parameters number in textual order: the PARTITION BY keys, then the
  ORDER BY keys. A partition key can be any expression, such as the local day of a UTC timestamp:
  `partitionBy: castAsDate(atTimeZone(atTimeZone(p.publishedAt, 'UTC'), 'Europe/Vienna'))` renders
  `PARTITION BY CAST((("posts"."published_at" AT TIME ZONE CAST($1 AS text)) AT TIME ZONE CAST($2 AS text)) AS date)`.
- A value reads as a JS number (the drivers deliver the int8 as text).
- In a collection navigation's select a window numbers each parent's items: such a collection renders as LATERAL
  whatever the collection strategy (the CTE and temp-table strategies aggregate the items of every parent in one pass,
  which would number them together).
- `rn <= N` over `row_number()` keeps at most N rows per group; `rank()` / `denseRank()` keep ties, so a group can
  return more. Add a unique tie-breaker (`p.id`) to `orderBy` for a deterministic pick. For the top N children of each
  parent through a navigation, a collection `orderBy().limit(n)` under the lateral strategy runs `ORDER BY … LIMIT n`
  inside each parent's subquery
  ([Top-N per parent](../collection-strategies.md#top-n-per-parent-limit-per-parent-or-row_number-over-all)).
- Other window functions (`lag`, `lead`, aggregates with `OVER`, frames) have no helper: write an `sql` template, as in
  the next section.

## Write SQL no helper covers: the sql template

`` sql`…` `` builds a fragment from text, column references (their navigations are joined) and values (each bound as an
untyped parameter). Prefer a helper when one exists: helpers type their parameters and carry read mappers.

```ts
const running = await db.posts
  .select(p => ({ id: p.id, views: p.views, runningViews: sql<number>`sum(${p.views}) OVER (ORDER BY ${p.id})`.mapWith(Number) }))
  .orderBy(r => r.id)
  .toList();
// [{ id: 1, views: 100, runningViews: 100 }, { id: 2, views: 150, runningViews: 250 }, { id: 3, views: 200, runningViews: 450 }]
```

```sql
SELECT "posts"."id" as "id", "posts"."views" as "views", sum("posts"."views") OVER (ORDER BY "posts"."id") as "runningViews"
FROM "posts"
ORDER BY "id" ASC
```

`sql.join(fragments, separator?)` joins fragments (default separator `, `), `sql.raw(text)` inlines trusted text,
`sql.empty` renders nothing, and `fragment.toString()` prints a fragment's SQL for debugging:

```ts
const parts = [sql`${'a'}::text`, sql`${'b'}::text`, sql`'c'`];
const row = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({
    joined: sql<string>`concat_ws(',', ${sql.join(parts, sql`, `)})`,
    raw: sql<number>`${sql.raw('42')}`,
    same: sql<string>`${u.username}${sql.empty}`,
  }))
  .firstOrDefault();
// { joined: 'a,b,c', raw: 42, same: 'alice' }

castAsInt(jsonbPathText(sql`doc`, 'qty')).toString();       // "CAST((doc->>'qty') AS integer)"
agg.count().filter(sql<boolean>`x > ${1}`).toString();       // "count(*) FILTER (WHERE x > $1)"
```

```sql
SELECT concat_ws(',', $1::text, $2::text, 'c') as "joined", 42 as "raw", "users"."username" as "same"
FROM "users"
WHERE "users"."username" = $3
LIMIT 1
-- params: [ "a", "b", "alice" ]
```

An untyped parameter fails where PostgreSQL cannot infer its type (a variadic or polymorphic function argument). Type
it with `param(v, type)`, a `${v}::text` cast or `literal()`, or use the helper (`concatWs()`):

```ts
await db.users.where(u => eq(u.username, 'alice')).select(() => ({ v: sql<string>`concat_ws(',', ${'a'}, ${'b'})` })).toList();
// fails: could not determine data type of parameter $1
await db.users.where(u => eq(u.username, 'alice')).select(() => ({ v: sql<string>`concat_ws(',', ${param('a', 'text')}, ${literal('b')})` })).firstOrDefault();
// { v: 'a,b' }
```

```sql
SELECT concat_ws(',', $1, $2) as "v"
FROM "users"
WHERE "users"."username" = $3
-- params: [ "a", "b", "alice" ]
-- error: could not determine data type of parameter $1

SELECT concat_ws(',', CAST($1 AS text), 'b') as "v"
FROM "users"
WHERE "users"."username" = $2
LIMIT 1
-- params: [ "a", "alice" ]
```

`db.query(fragment)` runs a fragment as a whole statement, with one parameter numbering across nested fragments. It
returns raw driver rows (no mappers); `sql.placeholder()` is refused there (it belongs to prepared queries):

```ts
const rows = await db.query<{ username: string; email: string }>(sql`SELECT username, email FROM users WHERE age >= ${30} ORDER BY id`);
// [{ username: 'bob', email: 'bob@test.com' }, { username: 'charlie', email: 'charlie@test.com' }]
```

```sql
SELECT username, email FROM users WHERE age >= $1 ORDER BY id
-- params: [ 30 ]
```

- A template reads through the generic conversion (`'007'` → `7`, NULL → `undefined` at the top level); in a grouped
  select it reads raw driver values. Type it with `.withReadType()` or `.mapWith()`
  ([Read results with the right type](#read-results-with-the-right-type-withreadtype-mapwith)).
- An aggregate in a template next to a plain column without `groupBy()` fails with 42803, as for `agg.*`.
- `sql.raw()` text is inlined: never pass user input (SQL injection), and every distinct text is another statement.

## Pitfalls

- **Don't** read JSON fields with `jsonbSelectText()` or a raw `` sql`…->>…` `` template when the text can look
  numeric → **Do** use `jsonbPathText()`. Mapper-less fragments read `'007'` as `7`.
- **Don't** expect `cast<number>(x, 'numeric')` to return a number → **Do** use `castAsNumeric()`, or keep the string
  for exact decimals. The type parameter only types the result; the value is the driver's string (`'50.0'`).
- **Don't** `coalesce(textColumn, 'none')` when the text can be digits only → **Do**
  `coalesce(textColumn, literal('none'))`, `.withReadType('text')` or `castAsString(…)`. Without a mapped or typed
  operand the result reads `'007'` as `7`.
- **Don't** pass two plain values to `add` / `sub` / `mul` / `div` → **Do** compute them in JS or type one with
  `param(v, 'integer')`. Two untyped parameters fail: `operator is not unique: unknown + unknown`.
- **Don't** divide two integers expecting a fraction → **Do** `div(castAsDouble(a), b)`. `div(userId, 2)` reads `0`.
- **Don't** use `param(null, type)` to find NULLs → **Do** use `eq(col, null)` or `isNull(col)` (`IS NULL`).
  `= CAST($1 AS integer)` with NULL matches no row.
- **Don't** put user input or varying values in `literal()` or `sql.raw()` → **Do** bind them (a plain value or
  `param()`). Every literal value is another statement text, and `sql.raw()` with user input is SQL injection.
- **Don't** `jsonbSet()` a column that can be NULL → **Do** `jsonbSet(coalesce(col, literal('{}', 'jsonb')), …)` or
  `jsonbMerge()`. `jsonb_set` on NULL stays NULL.
- **Don't** pass a JS array as a `jsonbMerge()` patch → **Do** wrap it: `jsonbMerge(col, castAsJsonb(patch))`.
  node-postgres sends a JS array as a PostgreSQL array literal: `invalid input syntax for type json`.
- **Don't** filter a large table with `arrayContains(col, v)` → **Do** `arrayContainsAll(col, [v])`. `= ANY(col)` is
  not GIN-indexable; `@>` is.
- **Don't** read an array column, add or remove a value in JS and write the array back → **Do**
  `update(r => ({ col: arrayAppendUnique(r.col, v) }))` / `arrayRemove(r.col, v)`: one statement on the row's current
  array, and a second run changes nothing. `arrayAppendUnique(col, null)` throws: remove NULL elements with
  `arrayRemove(col, null)`.
- **Don't** use `jsonbArraySome()` / `jsonbPathExists()` for exact matches → **Do** `jsonbContains()`. Of the operators
  these helpers emit, only `@>` / `?` / `?|` / `?&` are served by a GIN index.
- **Don't** project a plain column next to `agg.*` without `groupBy()` → **Do** project only aggregates, or group.
  PostgreSQL fails with 42803; the builder does not catch it.
- **Don't** expect `agg.arrayAgg()` / `agg.jsonAgg()` to return `[]` over no rows → **Do**
  `coalesce(agg.arrayAgg(x), literal('{}', 'integer[]'))` / `coalesce(agg.jsonAgg(x), literal('[]', 'json'))`.
- **Don't** call `.mapWith()` before `.filter()` / `.over()` → **Do** filter and set the window first. `mapWith()`
  returns a plain `SqlFragment` without them.
- **Don't** `where()` on a window value, or join on it, in the query that computes it → **Do** compute it in a CTE and
  filter (or join) where the CTE is read. The `where()` throws a `TypeError`; the join reaches PostgreSQL and fails
  (`window functions are not allowed in JOIN conditions`).
- **Don't** compare `jsonbArraySome()` element fields with plain numbers or booleans → **Do** `jsonbConditionUnwrap(2)`.
  Elements compare as text (`->>`): it works on node-postgres, but Bun's SQL client fails on a number
  (`operator does not exist: text = integer`) and Bun and postgres.js on a boolean (`text = boolean`).

## Version notes

- 1.0.31 added `arrayAppendUnique()` and `arrayRemove()`, and the grouped row's `g.arrayAgg()` / `g.countDistinct()`
  ([Querying](./querying.md)).
- 1.0.21 added `win.rowNumber()`, `win.rank()`, `win.denseRank()`.
- 1.0.9 added `param`, `literalOf`, `concatStrict`, `modulo`, `jsonbValueText`, `jsonBuildObject` /
  `jsonBuildArray`, `agg`, `withReadType()` and the regex form of `substring()`, and made every helper render as one
  operand. Before it, the JSON paths, `jsonbMerge`, `eqAny` / `neAll`, the `flagHas*` and `normalized*` predicates,
  `notExists`, `eqAnySubquery` / `neAllSubquery` and `jsonbArraySome` element paths rendered their operator bare
  (`jsonbRemoveKey(jsonbMerge(t, p), 'k')` removed the key from the patch only;
  `concatStrict(x, jsonbPathText(t, 'k'))` failed with `operator does not exist: text ->> unknown`), and
  `exists(sub).as('x')` rendered an empty expression.
- 1.0.7 added the casts, `literal`, `typedNull`, `asBoolean`, CASE, `greatest` / `least` / `nullIf`,
  `isDistinctFrom`, the string, math and date/time functions, `jsonbPath` / `jsonbPathText`, the JSONB predicates,
  builders and mutations, and the array-column helpers. Before it, a navigation used only inside a condition nested in
  a fragment was not joined. (`coalesce`, `jsonbMerge`, `jsonbSelect` / `jsonbSelectText`, `jsonbArraySome` and the
  arithmetic helpers are older.)

## See also

- [Choosing the right query](../choosing-the-right-query.md): start here; data need → API → SQL shape → round trips.
- [Querying](./querying.md): conditions (`eq`, `inArray`, `like`, regex, flags, normalized search), projections,
  GROUP BY with `g.*` aggregates, collection aggregates.
- [Subqueries](./subquery-guide.md): `exists()`, `inSubquery()`, `eqAnySubquery()`, scalar subqueries and
  `asExpression()` as operands of these helpers.
- [CTEs](./cte-guide.md): compute window values in a CTE body and filter them; CTE-rooted queries.
- [Set-returning functions](./set-returning-functions.md): `unnest`, `jsonbArrayElements`, rows from arrays and JSON.
- [Inserts, updates and upserts](./insert-update-guide.md): helpers as UPDATE, upsert and `insertFrom` values.
- [Schema configuration](./schema-configuration.md): array columns (`.array()`), custom type mappers, GIN and
  expression indexes, `ixNormalized`.
- [Batching and prepared queries](./batching-and-prepared-queries.md): aggregate rows in a `QueryBatch`,
  `sql.placeholder()`.
- [Collection strategies](../collection-strategies.md): per-parent aggregates and top-N children per strategy.
- [API index](../api-index.md): every export, one line each.
