# SQL Expression Helpers

Built-in, type-safe spellings of the SQL expressions that otherwise end up hand-written in
`sql` templates: casts, literals, bound parameters, `CASE`, `GREATEST` / `LEAST` / `NULLIF`,
`IS DISTINCT FROM`, string, math and date/time functions, JSON paths, builders and mutations,
array-column operators and aggregates.

```typescript
import {
  cast, castAsInt, caseWhen, caseOf, literal, literalOf, param, typedNull, asBoolean,
  greatest, least, nullIf, isDistinctFrom, lower, concatWs, concatStrict, round, modulo,
  atTimeZone, dateTrunc, datePart, addInterval, jsonbPathText, jsonbValueText, jsonbSet,
  jsonBuildObject, arrayContains, agg,
} from 'linkgress-orm';
```

Every helper returns a `SqlFragment` (predicates return a fragment that is also a `Condition`),
so helpers nest in each other, in `sql` templates, in `select`, `where`, `orderBy`, UPDATE
assignments and upsert values. Column references inside them keep their navigation
information: `lower(book.author.name)` joins `author` exactly as `book.author.name` alone would,
at any depth of nesting.

## Composing helpers: every helper is ONE operand

A helper splices its operands into its own SQL as they render, so every helper renders ONE
self-delimited expression — a function call, `CAST(… AS …)`, `CASE … END`, a subquery, `EXISTS (…)`
or a parenthesized group — and no operator it is composed with can take part of it:

```typescript
jsonbRemoveKey(jsonbMerge(doc, patch), 'k')        // ((COALESCE(doc, '{}'::jsonb) || (patch)::jsonb) - 'k')
concatStrict(jsonbPathText(doc, 'first'), literal(' '), jsonbPathText(doc, 'last'))
                                                    // ((doc->>'first') || ' ' || (doc->>'last'))
isDistinctFrom(notExists(sub), flag)               // ((NOT EXISTS (…)) IS DISTINCT FROM flag)
eq(book.featured, eqAny(book.id, featuredIds))     // "featured" = ("id" = ANY($1::integer[]))
sql<number>`${jsonbPathText(doc, 'qty')}::int`      // (doc->>'qty')::int
```

(Before 1.0.9 the JSON paths, `jsonbMerge`, `eqAny` / `neAll`, the `flagHas*` predicates, the
`normalized*` predicates, `notExists`, `eqAnySubquery` / `neAllSubquery` and a `jsonbArraySome`
element path rendered their operator bare: the first line above removed `'k'` from the patch only,
the second failed with `operator does not exist: text ->> unknown`, the third negated the whole
`IS DISTINCT FROM`.) Conditions built by the comparison helpers (`eq`, `like`, `isNull`, `and`, …)
are no fragments: a fragment they are interpolated into parenthesizes them. A raw `sql` template is
the caller's text and composes as written — `and()` / `or()` parenthesize it.

## How plain values are sent

A plain JS value is always a **bind parameter** — never inlined into the statement text — except
through [`literal()`](#literals-typed-nulls-and-conditions-as-values). Where PostgreSQL cannot
infer a parameter's type from context (every branch of a CASE is a literal, the VARIADIC
`concat` / `jsonb_build_object`, a function argument), the helper types it from its JS type:

| JS value | Bound as |
|---|---|
| boolean | `boolean` |
| integer in int4 range | `integer` |
| other safe integer, bigint | `bigint` |
| other number | `double precision` |
| string | `text` |
| Date | `timestamptz` |
| plain object / array | `jsonb` (serialized with `JSON.stringify`) |

Where a column or expression already fixes the type (a CASE with one column branch, the right
side of `IS DISTINCT FROM`), literals stay untyped and PostgreSQL resolves them against it — the
same way `eq(column, value)` binds. A column's custom mapper (`toDriver`) is applied to plain
values compared or unified with it.

## How results are read

Helpers whose result type is explicit — casts, string functions, JSON paths, literals, CASE —
return the driver's value **exactly** (NULL stays `null`): a text result such as `'01234'` stays
a string. (A fragment without one of these goes through the generic result conversion, which
turns numeric-looking strings into numbers.) Math helpers (`round`, `floor`, `ceil`, `abs`, `mod`,
`modulo`) and `datePart` read back as JS numbers.

### Reading a fragment as a column type: `withReadType()`

A fragment that carries no mapper — a raw `sql` template, a subquery expression
(`asExpression()`), a `coalesce` over such operands — reads through the generic conversion: a
text value `'007'` comes back as the number `7`, and a top-level NULL as `undefined`.
`.withReadType(pgType)` makes the projection read it the way a COLUMN of that type reads, with no
change to the SQL:

```typescript
db.books.select(b => ({
  title: sql<string>`${b.titles}->>${lang}`.withReadType('text'),  // '007' stays '007'
  weight: sql<number>`${b.meta}->>'weight'`.withReadType('numeric'), // '1.50' → 1.5
}))
```

- a numeric string becomes a number only for a numeric type (`integer`, `bigint`, `numeric`, …);
  `text`, `uuid`, `json`, … keep what the driver delivers;
- SQL NULL reads `undefined` at the top level of a projection and `null` inside a nested object
  (a grouped select keeps NULL as `null`, as it does for every field); inside a collection's items
  the value stays as the JSON delivers it;
- the fragment's mapper is dropped — a later `.mapWith()` sets one again and wins;
- the read type is kept by `.as()`, by `selectDistinct`, by UNION legs (they read through the first
  leg), by QueryBatch parts, by a grouped select, by the columns of a CTE or a table subquery that
  projects it, and by a projected `asSubquery('scalar')` whose one value it is.

The type name is validated like a cast's.

## Casts

```typescript
cast<T>(value, pgType)       // CAST(value AS pgType)
castAsInt(value)             // integer          → number
castAsSmallInt(value)        // smallint         → number
castAsBigInt(value)          // bigint           → string (exact int8 text)
castAsNumeric(value, p?, s?) // numeric(p, s)    → number
castAsDouble(value)          // double precision → number
castAsString(value)          // text
castAsVarchar(value, n?)     // varchar(n)
castAsBoolean(value)
castAsDate(value) / castAsTimestamp(value) / castAsTimestamptz(value)
castAsJsonb<T>(value) / castAsJson<T>(value)
castAsUuid(value)
```

Every fragment has the same casts as methods:

```typescript
db.orders.select(o => ({
  qty: jsonbPathText(o.payload, 'qty').castAsInt(),
  total: sql`${o.net} + ${o.tax}`.castAsNumeric(12, 2),
  day: castAsString(castAsDate(o.placedAt)),
}));

db.orders.where(o => gt(jsonbPathText(o.payload, 'qty').cast<number>('integer'), 5));
```

- A column or fragment is cast as an expression; a plain value becomes ONE typed parameter
  (`cast(42, 'bigint')` → `CAST($1 AS bigint)`); `null` becomes a typed NULL.
- The type name is inlined, so it is validated: any real type name passes — `numeric(12, 2)`,
  `varchar(64)[]`, `timestamp with time zone`, `my_schema.my_enum`, `"MyEnum"` — anything else
  throws.
- JS objects and arrays cast to `json` / `jsonb` are serialized with `JSON.stringify`; a string
  is taken as JSON text. JSON text is bound as `text` and parsed by the cast —
  `CAST(CAST($1 AS text) AS jsonb)` — so every driver sends it as it is (a parameter typed `jsonb`
  would be JSON-encoded once more by postgres.js and stored as a JSON string). A JS array cast to an
  SQL array type (`cast(ids, 'integer[]')`) is bound as its array literal (`'{1,2,3}'`), which every
  driver accepts — Bun's SQL client cannot bind a JS array to an array parameter itself.
- `CAST(x AS t)` is the same expression tree as `x::t`, so it matches expression indexes written
  either way.
- `castAsBigInt` keeps int8 exact as a string (chain `.mapWith(Number)` or `.mapWith(BigInt)`);
  `castAsNumeric` reads a JS number — use `cast<string>(x, 'numeric')` for the exact decimal
  text.

## Literals, typed NULLs and conditions as values

```typescript
literal('book')                 // 'book' — inlined, quoted safely
literal(-5)                     // (-5)
literal(true)                   // TRUE
literal('x', 'varchar(8)')      // CAST('x' AS varchar(8))
literalOf<'book' | 'film'>('book')  // 'book' — typed as the union, not as string
typedNull<string>('text')       // CAST(NULL AS text)
asBoolean(gte(member.age, 18))  // a condition as a boolean value
quoteSqlLiteral("it's")         // "'it''s'" — the quoting behind literal()
```

A condition placed directly in a projection needs no wrapper: `select(m => ({ isAdult: gte(m.age, 18) }))`
selects a boolean column (at the top level or inside a nested object literal), and `jsonbBuildObject`
accepts conditions as values too. `asBoolean()` is for when you need a condition as a
`SqlFragment<boolean>` — to call a fragment method on it (`.cast(...)`, `.mapWith(...)`, `.as(...)`)
or to pass it where a fragment is expected.

`literal()` is the one helper that writes the value into the statement TEXT. Use it where that
matters: a constant a partial / expression index must see literally, a discriminator in UNION
legs, a value that must not grow the parameter list. It accepts strings (quoted, escape-string
form when they contain a backslash), numbers, bigints, booleans and null only.

UNION legs line up with `literal` discriminators and `typedNull` pads:

```typescript
const rows = await db.books
  .select(b => ({ kind: literal('book'), title: b.title, isbn: b.isbn }))
  .unionAll(db.films.select(f => ({ kind: literal('film'), title: f.title, isbn: typedNull<string>('text') })))
  .toList();
```

`literal('book')` is a `SqlFragment<string>`. When the legs' discriminators should share a declared
union type, use `literalOf`: it renders and reads exactly like `literal()`, but
`literalOf<'book' | 'film'>('book')` is a `SqlFragment<'book' | 'film'>` (and a value outside the
union is a compile error), so `rows[i].kind` is typed `'book' | 'film'`.

## Bound parameters: `param()`

```typescript
param(value)                 // $1 — the value bound as given
param(value, 'integer')      // CAST($1 AS integer)
param([1, 2], 'integer[]')   // CAST($1 AS integer[]) — ONE array-literal parameter
```

`param()` is a parameter as an expression. It ALWAYS binds exactly one parameter — `null` and
`undefined` bind as NULL — and never inlines, so the statement text does not depend on the value:

```typescript
// One text for every lookup form: unused keys bind NULL, which matches nothing
db.accounts.where(a => and(
  or(eq(a.id, param(byId, 'integer')), eq(a.ownerId, param(byOwner, 'integer'))),
  or(param(anyOwner, 'boolean'), eq(a.ownerId, param(owner, 'integer'))),
))

// A JSON key bound instead of inlined: one statement text for every language
db.pages.select(p => ({ title: jsonbPathText(p.titles, param(language)) }))   // "titles"->>$1
```

- Inside `eq()` it is compared, never rewritten: `eq(col, param(null, 'integer'))` is
  `col = CAST($1 AS integer)` (no row matches), where `eq(col, null)` is `col IS NULL`, and
  `castAsInt(null)` inlines `CAST(NULL AS integer)` (a different statement text).
- The value binds as given — the compared column's `toDriver` mapper does not apply.
- A JS array needs an array type and binds as its array literal (every driver accepts it); a JSON
  document goes through `castAsJsonb` / `castAsJson`, which serialize it. A column or an expression
  is refused (use it directly).
- Reads back as the driver delivers the value. The type name is validated like a cast's.

## CASE

```typescript
// Searched CASE — branches tested in order, lazily
caseWhen(isNotNull(loan.returnedAt), 'returned')
  .when(lt(loan.dueAt, today), 'overdue')
  .else('open')

// Simple CASE — the subject compared with `=`
caseOf(book.formatCode).when(1, 'hardcover').when(2, 'paperback').else('other')
```

- Without `.else()` an unmatched row gives NULL.
- PostgreSQL evaluates CASE lazily, so a branch can guard a later one:
  `caseWhen(gt(s.qty, 0), div(total, s.qty)).else(null)` never divides by zero.
- Results unify into one type. A column branch fixes it (its mapper applies to the result);
  when every result is a plain value each is typed from its JS type, so `1` / `0` come back as
  numbers, not text.
- A condition is a valid result: `caseWhen(isNull(x), false).else(gt(x, 3))`.
- The builders are immutable — every `.when()` / `.else()` returns a new expression.

CASE works everywhere a fragment does — including one-statement conditional updates:

```typescript
await db.books.where(b => eq(b.id, id)).update(b => ({
  copies: caseWhen(gt(b.copies, 0), sub(b.copies, 1)).else(0),
}));
```

## GREATEST / LEAST / NULLIF / IS DISTINCT FROM

```typescript
greatest(period.openedAt, closedAt)   // NULL operands are ignored
least(card.balance, card.limit)
nullIf(member.nickname, '')           // '' → NULL
isDistinctFrom(book.subtitle, next)   // NULL-safe "not equal" — a condition and a value
isNotDistinctFrom(book.subtitle, null)
```

## Strings

```typescript
lower(x)   upper(x)   trim(x, chars?)   trimStart(x, chars?)   trimEnd(x, chars?)
length(x)                        // char_length
concat(a, b, …)                  // NULL counts as ''
concatWs(separator, a, b, …)     // skips NULLs
concatStrict(a, b, …)            // (a || b || …) — NULL when ANY operand is NULL
substring(x, start, count?)      // 1-based
substring(x, pattern)            // POSIX regex: the first group's match, NULL without a match
replace(x, from, to)
regexpReplace(x, pattern, replacement, flags?)
```

To match an expression index written with literal arguments, pass them through `literal()`:
`regexpReplace(card.number, literal('[^0-9]'), literal(''), literal('g'))`.

- `concatStrict` renders `(a || ' ' || b)`: columns and fragments as they are, `literal(' ')`
  inline, a plain value bound as text (`CAST($1 AS text)`), `null` / `undefined` a typed NULL.
  It needs at least two operands and reads the text as delivered (a digits-only result stays a
  string, NULL stays null). `concat()` is unchanged (NULL counts as `''`).
- `substring(x, pattern)` always renders the function-call form `substring(x, 'pattern')` — the
  expression an index written that way holds — never `SUBSTRING(x FROM …)`.

## Math

```typescript
round(x)  round(x, digits)  floor(x)  ceil(x)  abs(x)  mod(dividend, divisor)
modulo(dividend, divisor)        // (dividend % divisor) — the operator, not mod()
```

`round(x, digits)` casts `x` to numeric first (PostgreSQL has no `round(double precision,
integer)`). Results read back as JS numbers.

`modulo` computes what `mod` does, as the `%` OPERATOR: an expression index written with `%`
(`CREATE INDEX … ((code % 10000000))`) is only used by a query spelling the same operator, never by
`mod()`. Keep a constant divisor inline so a generic plan can still match the index:
`eq(modulo(account.number, literal(10000000, 'bigint')), lastDigits)`. A value compared with it binds
unchanged.

## Date and time

```typescript
currentTimestamp()   // CURRENT_TIMESTAMP (timestamptz)
localTimestamp()     // LOCALTIMESTAMP (timestamp, session time zone)
currentDate()        // CURRENT_DATE
utcTimestamp()       // (now() AT TIME ZONE 'UTC') — for timestamp columns that hold UTC

atTimeZone(value, zone)              // (value AT TIME ZONE zone) — zone name or zone column
dateTrunc('day', value, zone?)       // date_trunc('day', value[, zone])
datePart('isodow', value)            // EXTRACT(ISODOW FROM value) → number
toChar(value, 'YYYY-MM-DD')          // to_char(value, template)
toInterval('90 minutes')             // CAST($1 AS interval)
toInterval({ days: 1, hours: 2 })
addInterval(value, { minutes: 30 })  // (value + interval)
subInterval(value, '1 day')          // (value - interval)
```

- A zone column is cast to text, so enum-typed zone columns work: `atTimeZone(x, branch.timeZone)`.
- A UTC `timestamp` column as local wall-clock time:
  `atTimeZone(atTimeZone(visit.startedAtUtc, 'UTC'), branch.timeZone)`.
- Units (`dateTrunc`) and fields (`datePart`) are allow-listed; the interval text / parts bind
  as one parameter.

## JSONB

```typescript
jsonbPath(doc, 'dims', 'w')          // (doc->'dims'->'w')   (jsonb)
jsonbPathText(doc, 'dims', 'w')      // (doc->'dims'->>'w')  (text)
jsonbPathText(doc, 'tags', 0)        // integers are array indexes (negative: from the end)
jsonbPathText(doc, param(lang))      // a bound key — (doc->>$1), one statement text for every key
jsonbValueText(doc)                  // (doc #>> '{}') — the whole value as text

jsonbSet(doc, ['dims', 'w'], 99, { createMissing? })
jsonbRemoveKey(doc, 'a', 'b')        // doc - key(s)
jsonbRemovePath(doc, ['dims', 'h'])  // doc #- path
jsonbContains(doc, { genre: 'poetry' })   // @>  (GIN-indexable)
jsonbContainedBy(doc, value)              // <@
jsonbHasKey(doc, 'rating')                // ?   (GIN-indexable)
jsonbHasAnyKey(doc, ['a', 'b'])           // ?|
jsonbHasAllKeys(doc, ['a', 'b'])          // ?&
jsonbArrayLength(x)   jsonbTypeOf(x)   toJsonb(x)
jsonbBuildObject({ id: book.id, author: { name: book.author.name }, fixed: 'v1' })
jsonbBuildArray(a, b, …)
jsonBuildObject({ … })   jsonBuildArray(a, b, …)   // the json twins
jsonbPathExists(doc, '$.slots[*] ? (@.from <= $day)', { vars: { day }, silent? })
jsonbPathExists(doc, literal('$.slots[*] ? (@.from <= $d)', 'jsonpath'), { vars: jsonbBuildObject({ d: row.day }) })
```

- Unlike `jsonbSelect`, `jsonbPath` / `jsonbPathText` read the column as the jsonb it is — no
  `#>> '{}'` text round trip, which re-parses the whole document per row and fails on a JSON
  string value.
- String keys are inlined as quoted literals (so are `jsonbSelect` / `jsonbSelectText` keys and
  `jsonbArraySome` paths — a quote in a key can no longer break out of it).
- Values given to `jsonbSet` / `jsonbContains` are serialized to JSON: `'x'` sets the JSON string
  `"x"`, `null` sets JSON null. A NULL document stays NULL through `jsonb_set` — start from
  `coalesce(doc, literal('{}', 'jsonb'))` to create one.
- `jsonbBuildObject` recurses into nested plain objects and arrays, so column refs anywhere in
  the tree stay live; conditions become boolean values.
- `jsonb_array_length` raises for a non-array; guard it where the column can hold other shapes:
  `caseWhen(eq(jsonbTypeOf(x), 'array'), jsonbArrayLength(x))`.
- With `silent: true`, a strict path's structural error yields NULL instead of aborting the
  statement.
- `jsonbPathExists` takes the path as a string — bound as ONE parameter, `CAST($1 AS jsonpath)` —
  or as a fragment rendered verbatim: `literal(path, 'jsonpath')` keeps it INLINE, so a statement
  repeating the predicate binds nothing for it. `vars` is a plain object (serialized to jsonb) or
  a fragment rendered verbatim — `jsonbBuildObject({ d: expr })` passes per-row SQL values. A plain
  `vars` object holding columns or expressions is refused (build it with `jsonbBuildObject`).
- `jsonbValueText(doc)` is the whole value as text: a JSON string unquoted (`"x"` → `x`), a number
  or boolean as its text, an object or array as its JSON text; SQL NULL and JSON `null` give NULL.
  (`castAsString(doc)` — `jsonb::text` — keeps a string's quotes.)
- `jsonBuildObject` / `jsonBuildArray` build `json` with exactly the operand rules of the `jsonb`
  builders. `json` keeps the keys in the written order (jsonb sorts them) and is cheaper to build
  when the value only travels to the client. Both read back as the driver-parsed JSON.

## Array columns

```typescript
arrayContains(book.tags, 'poetry')          // (CAST($1 AS text) = ANY(tags)) — element-typed
arrayContainsAll(book.tags, ['a', 'b'])     // (tags @> CAST($1 AS text[]))
arrayOverlaps(book.tags, ['a', 'b'])        // (tags && CAST($1 AS text[]))
arrayContainedBy(book.slots, [1, 2, 3])     // (slots <@ CAST($1 AS integer[]))
arrayLength(book.tags)                      // cardinality(tags)
arrayIsEmpty(book.tags)                     // cardinality(tags) = 0 — a NULL array is not empty
arrayIsNotEmpty(book.tags)
```

A JS list binds as ONE array-literal parameter cast to the column's declared array type, so the
statement text does not change with the list length. (`eqAny(column, list)` is the reverse
shape: a scalar column against a list.)

## Aggregates (`agg`)

```typescript
agg.count()                          // count(*)
agg.count(x)                         // count(x) — the non-NULL values
agg.countDistinct(x)                 // count(DISTINCT x)
agg.sum(x, { distinct? })            // sum([DISTINCT] x)
agg.avg(x, { distinct? })            // avg([DISTINCT] x)
agg.min(x)   agg.max(x)              // min(x) / max(x)
agg.bitOr(x) agg.bitAnd(x)           // bit_or(x) / bit_and(x)
agg.arrayAgg(x, { distinct?, orderBy? })   // array_agg([DISTINCT] x [ORDER BY …])
agg.jsonAgg(x, { distinct?, orderBy? })    // json_agg(…)
agg.jsonbAgg(x, { distinct?, orderBy? })   // jsonb_agg(…)
agg.count().filter(condition)        // count(*) FILTER (WHERE condition)
```

Aggregates as fragments. A select of them WITHOUT `groupBy()` aggregates the whole filtered set
into ONE row — also over zero input rows, where a count is 0 and every other aggregate NULL:

```typescript
const [stats] = await db.loans
  .where(l => eq(l.memberId, memberId))
  .select(l => ({
    loans: agg.count(),
    open: agg.count().filter(isNull(l.returnedAt)),
    books: agg.countDistinct(l.bookId),
    lastDue: agg.max(l.dueAt),                          // read through the column's mapper
    titles: agg.arrayAgg(l.book.title, { distinct: true, orderBy: [[l.book.title, 'ASC']] }),
  }))
  .toList();
```

Such a select is one row, so its `count()` is refused (a COUNT over the input rows would say
otherwise) — count the rows of a select without aggregates.

Inside `asSubquery('scalar')` they make an aggregate per enclosing row — projected, such a
subquery of ONE aggregate reads like the aggregate itself (`agg.max(text)` keeps `'007'`, a mapped
column's MIN / MAX goes through its mapper) — and inside a grouped select
(`groupBy(...).select(g => …)`) an aggregate per group, over the keys it reads through `g.key` — in
the plain `GROUP BY` form and in the subquery form of an expression-keyed grouping alike:

```typescript
db.members.select(m => ({
  loans: db.loans.where(l => eq(l.memberId, m.id)).select(() => agg.count()).asSubquery('scalar'),
  items: db.loans.where(l => eq(l.memberId, m.id))
    .select(l => coalesce(agg.jsonAgg(jsonBuildArray(l.id, l.dueAt), { orderBy: [[l.dueAt, 'DESC']] }), literal('[]', 'json')))
    .asSubquery('scalar'),
}))
```

- Function names render lower-case; an ORDER BY key always carries its direction (`ASC` by
  default). A key is a column or an expression, optionally `[key, 'ASC' | 'DESC']`; a plain JS value
  is refused.
- `.filter(condition)` appends ` FILTER (WHERE <condition>)`, the condition rendered bare
  (`and()` / `or()` keep their own parentheses, a raw `sql` operand of them gets its own). A second
  `.filter()` is ANDed with the first. A collection's `exists()` is a condition here too. The
  fragments are immutable: `.filter()` returns a new one.
- Parameters number in textual order: the argument, the ORDER BY keys, the FILTER.
- With `distinct`, PostgreSQL requires every ORDER BY key to render exactly as the argument: a key
  that binds a parameter (`sql\`${x} || ${'!'}\``) renders a new `$n` each time and is refused up
  front — inline its constants with `literal()`.
- A list aggregate over zero rows is NULL, not `[]`. For an always-array wrap `jsonAgg` / `jsonbAgg`
  in `coalesce(…, literal('[]', 'json'))` (or `'jsonb'`), and `arrayAgg` in
  `coalesce(…, literal('{}', 'integer[]'))` — the array type of its elements.
- Reads: `count`, `countDistinct`, `sum`, `avg`, `bitOr`, `bitAnd` → JS numbers (int8 / numeric text
  converted; NULL stays null); `min` / `max` → like `g.min()` / `g.max()`: through the operand's
  mapper (a mapped timestamp column reads as its mapped type), as a JS number for an unmapped
  numeric / int8 operand, else as the driver delivers the value; `arrayAgg` → an array whose
  ELEMENTS go through the operand's mapper; `jsonAgg` / `jsonbAgg` → the driver-parsed JSON, no
  per-element mapping (timestamps inside stay the JSON strings PostgreSQL produced; a column behind
  a custom mapper stays its stored value, although the element type names the mapped type —
  aggregate a `jsonBuildObject` / `jsonBuildArray` of the values you want, typed explicitly).
- The unmapped ELEMENTS of an `arrayAgg` are what the driver's native array decoding makes of them:
  an int8 is a string everywhere, a numeric a JS number on node-postgres and in memory but a string
  (`'1.50'`) on postgres.js, Bun and PGlite. Map them (`.mapWith(…)`) if the type must not depend on
  the driver.
- On a driver that cannot decode native array results (Bun's binary protocol,
  `supportsBinaryArrayResults() === false`) the list the driver reads directly — a projected
  `arrayAgg` (through `.as()` / `.mapWith()` / `.withReadType()`), a nested object's, a grouped or
  CTE-rooted select's, a UNION ALL leg's, and that of a projected `asSubquery('scalar')` of one —
  renders as JSON: `json_agg(…)` with the same arguments, and for int8 / numeric / money elements
  `to_json(CAST(array_agg(…) AS text[]))`, so each element arrives as its exact text in the
  aggregate's own DISTINCT / ORDER BY order (a JSON number would lose an int8's precision). A
  date / timestamp element then arrives as its JSON text (`'2024-03-10T23:30:00'`), as inside a
  collection, where the native array read a `Date`. Wherever SQL consumes the list — a function
  argument (`cardinality(…)`), an operand, a `coalesce` / CASE, a WHERE or HAVING, a CTE body, a
  UNION / INTERSECT / EXCEPT leg (their rows are compared; json has no equality) — it stays
  `array_agg`: the value reaching the driver there is a native array.
- postgres.js decodes a NULL ELEMENT of a native array wrongly (`'NULL'` in a `text[]`, `NaN` in an
  `int4[]`) — a known driver defect, for every native-array read on it, `arrayAgg` included.
  Filter NULLs out (`.filter(isNotNull(x))`) or use `jsonAgg` where elements can be NULL on that
  driver.

## Conditions nested in fragments

A condition interpolated into a fragment — `sql\`${eq(book.author.name, x)}\``, a CASE branch,
`asBoolean(...)` — reports its column references, and a subquery its outer references, so JOIN
detection sees through any nesting. (Before 1.0.7 a navigation used only inside such a nested
condition was never joined.)

A fragment that renders its own way — `exists(...)`, `notExists(...)`, an aggregate, a CASE —
keeps its SQL and its references through `.as()`, `.mapWith()`, `.withReadType()` and
`sql.join(...)`. (Before 1.0.9 `exists(sub).as('x')` rendered an empty expression, `,  as "x"`, and
dropped the subquery's outer references.)

## See Also

- [Querying](./querying.md) — the query builder and the condition operators
- [Subquery Guide](./subquery-guide.md) — `eqAnySubquery` / `neAllSubquery`, `asExpression()`,
  subqueries as comparison operands
- [Insert/Update/Upsert/BULK](./insert-update-guide.md) — expressions as UPDATE / upsert values,
  `updateSet` / `set`, advisory locks
