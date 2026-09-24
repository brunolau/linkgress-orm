# SQL Expression Helpers

Built-in, type-safe spellings of the SQL expressions that otherwise end up hand-written in
`sql` templates: casts, literals, `CASE`, `GREATEST` / `LEAST` / `NULLIF`, `IS DISTINCT FROM`,
string, math and date/time functions, JSONB paths and mutations, and array-column operators.

```typescript
import {
  cast, castAsInt, caseWhen, caseOf, literal, typedNull, asBoolean,
  greatest, least, nullIf, isDistinctFrom, lower, concatWs, round,
  atTimeZone, dateTrunc, datePart, addInterval, jsonbPathText, jsonbSet, arrayContains,
} from 'linkgress-orm';
```

Every helper returns a `SqlFragment` (predicates return a fragment that is also a `Condition`),
so helpers nest in each other, in `sql` templates, in `select`, `where`, `orderBy`, UPDATE
assignments and upsert values. Column references inside them keep their navigation
information: `lower(book.author.name)` joins `author` exactly as `book.author.name` alone would,
at any depth of nesting.

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
turns numeric-looking strings into numbers.) Math helpers (`round`, `floor`, `ceil`, `abs`, `mod`)
and `datePart` read back as JS numbers.

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
substring(x, start, count?)      // 1-based
replace(x, from, to)
regexpReplace(x, pattern, replacement, flags?)
```

To match an expression index written with literal arguments, pass them through `literal()`:
`regexpReplace(card.number, literal('[^0-9]'), literal(''), literal('g'))`.

## Math

```typescript
round(x)  round(x, digits)  floor(x)  ceil(x)  abs(x)  mod(dividend, divisor)
```

`round(x, digits)` casts `x` to numeric first (PostgreSQL has no `round(double precision,
integer)`). Results read back as JS numbers.

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
jsonbPath(doc, 'dims', 'w')          // doc->'dims'->'w'   (jsonb)
jsonbPathText(doc, 'dims', 'w')      // doc->'dims'->>'w'  (text)
jsonbPathText(doc, 'tags', 0)        // integers are array indexes (negative: from the end)
jsonbPathText(doc, sql`${lang}`)     // a fragment key binds — one statement text for every key

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
jsonbPathExists(doc, '$.slots[*] ? (@.from <= $day)', { vars: { day }, silent? })
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

## Conditions nested in fragments

A condition interpolated into a fragment — `sql\`${eq(book.author.name, x)}\``, a CASE branch,
`asBoolean(...)` — reports its column references, and a subquery its outer references, so JOIN
detection sees through any nesting. (Before 1.0.7 a navigation used only inside such a nested
condition was never joined.)

## See Also

- [Querying](./querying.md) — the query builder and the condition operators
- [Insert/Update/Upsert/BULK](./insert-update-guide.md) — expressions as UPDATE / upsert values,
  `updateSet` / `set`, advisory locks
