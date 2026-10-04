# Set-returning functions

> **For agents:** How do I turn a JS list, JS rows or a jsonb document into rows that one SQL statement joins, filters, groups or inserts — with statement text that does not grow with the data?
> **Use this page when:** a JS list or JS rows must become a relation (join, insert, anti-join, correlate), jsonb arrays or objects must become rows, or each row must repeat per element of an array. **Look elsewhere when:** testing a column against a JS list → `inArrayOpt()` or `eqAny()` in [Querying](./querying.md#matching-a-list-of-values); does a jsonb array hold a matching element → `jsonbArraySome()` in [SQL expressions](./sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome); a derived set from tables read in several places → [CTEs](./cte-guide.md)
> **Key APIs:** `unnest()`, `unnestZip()`, `unnestRows()`, `fromRows()`, `jsonbArrayElements()`, `jsonbEachText()`, `fromSet()`, `db.selectFromSet()`, `<table>.selectFromSet()`, `crossJoinLateral()` · **Round trips:** 1 per executed set query; 0 of its own when embedded (a subquery, a join source, a CTE body, a lateral join)

`unnest`, `jsonb_array_elements` and `jsonb_each_text` return a set of rows. linkgress models them as
`SetReturningFunction` values, usable in two places only:

- **as a row source** — `fromSet()` (a context-free query to embed), `db.selectFromSet()` / `<table>.selectFromSet()`
  (a query of its own) and `crossJoinLateral()` (joined to every row of an entity query);
- **as a projection value** — a set-returning select-list item that multiplies the rows of the projection.

Anywhere else — a WHERE, a HAVING, an ORDER BY, a GROUP BY key, a CASE, an aggregate's argument, inside another
expression — the build throws `<fn>() returns a set of rows: …`: PostgreSQL rejects most of those places, and the
rest would multiply rows where no one expects it.

> **Efficiency:** a JS list binds as ONE array parameter per column (`unnest(CAST($1 AS text[]))`), so the statement
> text depends only on the column set, never on the number of values: it can be prepared, and it stays far below
> PostgreSQL's 65,535-parameter limit whatever the list length.

## Contents

- [Decide: which function, which source](#decide-which-function-which-source)
- [The functions](#the-functions)
- [Turn a JS list into rows: `db.selectFromSet(unnest(…))`](#turn-a-js-list-into-rows-dbselectfromsetunnest)
- [Zip JS arrays into typed rows: `unnestZip()`](#zip-js-arrays-into-typed-rows-unnestzip)
- [Bind JS rows typed by a table: `unnestRows()` / `fromRows()`](#bind-js-rows-typed-by-a-table-unnestrows--fromrows)
- [Match rows against a list of composite keys: join `fromRows()`](#match-rows-against-a-list-of-composite-keys-join-fromrows)
- [Turn jsonb into rows: `jsonbArrayElements()` / `jsonbEachText()`](#turn-jsonb-into-rows-jsonbarrayelements--jsonbeachtext)
- [Test each row against a list or a jsonb document: `fromSet()` subqueries](#test-each-row-against-a-list-or-a-jsonb-document-fromset-subqueries)
- [Join a set to every row: `crossJoinLateral()`](#join-a-set-to-every-row-crossjoinlateral)
- [Repeat each row per element: a set as a projection value](#repeat-each-row-per-element-a-set-as-a-projection-value)
- [How set columns read back](#how-set-columns-read-back)
- [Combine sets with other queries: joins, unions, CTE bodies](#combine-sets-with-other-queries-joins-unions-cte-bodies)
- [Run a set query on a table's own connection: `<table>.selectFromSet()`](#run-a-set-query-on-a-tables-own-connection-tableselectfromset)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Decide: which function, which source

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Is a column's value in a JS list? | `inArrayOpt(col, list)` for data-driven lists, `eqAny(col, list)` when every length must share one statement text — [Querying](./querying.md#matching-a-list-of-values) | `inArrayOpt`: `"t"."c" IN ($1, …)` up to 8 values, `("t"."c" = ANY($1::<column type>[]))` above; `eqAny`: always the `= ANY` form · 1 | a set: more SQL, same rows |
| A JS list as rows (transform, return, join) | `db.selectFromSet(unnest(list, 'type'), alias)` | `FROM unnest(CAST($1 AS type[])) AS "a"("value")` · 1 | one statement per value |
| JS tuples with explicit SQL types | `unnestZip({ col: { values, type }, … })` | `unnest(CAST($1 AS t1[]), CAST($2 AS t2[]))` · 1 | a `VALUES` list whose text grows with the row count |
| JS rows shaped like a table's rows | `unnestRows(table, rows, columns)` / `fromRows(table, rows, { columns })` | one array per column, cast to the column types, cells through the mappers · 1 | `unnestZip()` (raw values, types spelled by hand) |
| Table rows matching a list of composite keys | [`innerJoin(fromRows(table, keys, { columns, alias }).asSubquery('table'), on, select, alias)`](#match-rows-against-a-list-of-composite-keys-join-fromrows) | `INNER JOIN (SELECT … FROM unnest(CAST($1 AS integer[]), CAST($2 AS integer[])) AS "k"(…)) AS "keys" ON (…)` · 1 | `or()` of `and(eq(), eq())` per key: 2 parameters per key, a text per list length |
| Insert JS rows with a fixed statement text, or filtered by a `where` | `insertFrom(fromRows(…).asSubquery('table'), map, options)` | `INSERT … SELECT … FROM (SELECT … FROM unnest(…)) AS "src"` · 1 | `insertBulk()` here: its `VALUES ($1), ($2)…` text grows with the rows (for a plain bulk insert it is the simpler call — [Insert, update, delete](./insert-update-guide.md)) |
| Delete or close the rows a JS list no longer holds | `notExists(fromRows(…).where(…)….asSubquery())` | `WHERE (NOT EXISTS (SELECT 1 … FROM unnest(…) … WHERE … = "t"."c"))` · 1 | reading the rows and diffing in JS (2+ round trips) |
| Each row against JS pairs (name + threshold) | `exists(fromSet(unnestZip(…)).where(…)….asSubquery())` | `WHERE EXISTS (SELECT 1 … FROM unnest(…) AS "r"(…) WHERE …)` · 1 | one query per pair |
| Does a jsonb array column hold a matching element? | `jsonbArraySome(col, e => …)` — [SQL expressions](./sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome) | `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(…) = 'array' …))` · 1 | `fromSet(jsonbArrayElements(col))`: a non-array value aborts the statement |
| Elements of per-row arrays or jsonb as rows, filtered, counted or grouped | `crossJoinLateral(row => set, select, alias)` | `CROSS JOIN LATERAL jsonb_array_elements("t"."c") AS "e"("value")` · 1 | fetching the documents and looping in JS |
| One value per row picked from its jsonb or array (first, max) | `fromSet(…).where(…).orderBy(…).limit(1).asSubquery('scalar')` | `(SELECT … FROM jsonb_each_text("t"."c") AS "kv"(…) … LIMIT 1)` · 1 | `crossJoinLateral()` + grouping |
| Each output row repeated per element | a set as a projection value | `SELECT unnest(…) as "v" FROM …` · 1 | `count()` of that query (refused) |

## The functions

| Function | SQL | Columns |
|---|---|---|
| `unnest(array, elementType?)` | `unnest(<array>)` | `value` |
| `unnestZip({ c1: { values, type }, … })` | `unnest(CAST($1 AS t1[]), CAST($2 AS t2[]), …)` | `c1`, `c2`, … |
| `unnestRows(table, rows, columns?)` (since 1.0.29) | `unnest(CAST($1 AS <col type>[]), …)` | the table's property names |
| `jsonbArrayElements(target)` | `jsonb_array_elements(<target>)` | `value` (jsonb) |
| `jsonbEachText(target)` | `jsonb_each_text(<target>)` | `key`, `value` (text) |

- `unnest`'s `array` is an array column or expression (`` unnest(sql<string[]>`string_to_array(${u.email}, '@')`) ``),
  or a JS array, which binds as ONE parameter cast to `<elementType>[]`. A JS array (or `null`) needs its
  `elementType`; a column's element type comes from its SQL type. NULL and an empty array give no rows.
- `unnestZip` zips its arrays by position; a shorter array is padded with NULL. One typed array parameter per
  column (or an array column / expression, cast to `<type>[]`). Column names are plain identifiers; at least one
  column. Values bind raw (no column mappers).
- `jsonbArrayElements` / `jsonbEachText` take a jsonb column or expression, or a plain JS value (serialized and cast
  to jsonb). A NULL target gives no rows; a non-array (non-object) target raises PostgreSQL's error.
- A JS array or object that holds column refs or expressions (`unnest([r.a, r.b], 'int')`,
  `jsonbArrayElements({ n: r.name })`) is refused: bound as ONE parameter, the refs would be serialized into it.
  Build such a value in SQL (`` sql`ARRAY[…]` ``, `jsonb_build_object(…)`), or use `unnestZip`.
- The alias of a source defaults to the function's name (`unnest`, `jsonb_array_elements`, `jsonb_each_text`);
  `fromRows()` defaults to `"rows"`.

## Turn a JS list into rows: `db.selectFromSet(unnest(…))`

`db.selectFromSet(set, alias?)` runs a query over a set: `.where()`, `.select()`, `.orderBy()`, `.limit()`,
`.offset()`, `.union()` / `.unionAll()`, then `.toList()`, `.firstOrDefault()`, `.toSql()` or `.asSubquery()`.
Use it to transform a JS list in SQL or to return it as rows; for a membership test use `inArrayOpt()` or `eqAny()`
([Matching a list of values](./querying.md#matching-a-list-of-values)).

```ts
import { lower, unnest } from 'linkgress-orm';

const names = await db.selectFromSet(unnest(['Alice', 'Bob', '007'], 'text'), 'n')
  .select(n => ({ name: n.value, key: lower(n.value) }))
  .toList();
// [{ name: 'Alice', key: 'alice' }, { name: 'Bob', key: 'bob' }, { name: '007', key: '007' }]
```

```sql
SELECT "n"."value" as "name", lower("n"."value") as "key"
FROM unnest(CAST($1 AS text[])) AS "n"("value")
-- params: ["{\"Alice\",\"Bob\",\"007\"}"]
```

- It renders `SELECT <selection> FROM <call> AS "<alias>"("<c1>", …) [WHERE …] [ORDER BY …] [LIMIT n] [OFFSET m]`;
  repeated `where()` calls combine with AND.
- Without `select()` the rows are the set's rows (`{ value }` for `unnest`); a one-value `select(n => n.value)`
  reads as a list of values.
- `orderBy()` takes a key, a list of keys or `[key, 'ASC' | 'DESC']` pairs and replaces an earlier `orderBy()`;
  `limit()` / `offset()` are inlined non-negative integers.
- A set query is immutable: every method returns a new query, so a base query can be reused.
  `firstOrDefault()` renders `LIMIT 1` on its own copy:

```ts
import { unnest } from 'linkgress-orm';

const q = db.selectFromSet(unnest([3, 1, 2], 'integer'), 'n').orderBy(n => [[n.value, 'DESC']]);
const top = await q.firstOrDefault();              // { value: 3 }
const all = await q.select(n => n.value).toList(); // [3, 2, 1]
```

```sql
SELECT "n"."value" as "value"
FROM unnest(CAST($1 AS integer[])) AS "n"("value")
ORDER BY "n"."value" DESC
LIMIT 1
-- params: ["{3,1,2}"]

SELECT "n"."value" as "value"
FROM unnest(CAST($1 AS integer[])) AS "n"("value")
ORDER BY "n"."value" DESC
-- params: ["{3,1,2}"]
```

- There is no `count()`: `db.selectFromSet(unnest([1, 2, 3], 'integer'), 'n').where(x => gt(x.value, 1)).select(() => agg.count()).firstOrDefault()`
  renders `SELECT count(*) as "value" FROM unnest(CAST($1 AS integer[])) AS "n"("value") WHERE "n"."value" > $2 LIMIT 1`
  and returns `2`.

## Zip JS arrays into typed rows: `unnestZip()`

`unnestZip()` turns parallel JS arrays into rows with explicit SQL types — one typed array parameter per column. Use
it for tuples that match no table; for rows shaped like a table's rows use `unnestRows()` (next section).

```ts
import { unnestZip } from 'linkgress-orm';

const rows = await db.selectFromSet(unnestZip<{ id: number; code: string | null }>({
  id: { values: [1, 2, 3], type: 'integer' },
  code: { values: ['01', '7'], type: 'text' },
}), 'z')
  .orderBy(z => z.id)
  .toList();
// [{ id: 1, code: '01' }, { id: 2, code: '7' }, { id: 3, code: null }]
```

```sql
SELECT "z"."id" as "id", "z"."code" as "code"
FROM unnest(CAST($1 AS integer[]), CAST($2 AS text[])) AS "z"("id", "code")
ORDER BY "z"."id" ASC
-- params: ["{1,2,3}", "{\"01\",\"7\"}"]
```

> **Pitfall:** arrays of different lengths do not fail: the shorter one is padded with NULL (`{ id: 3, code: null }`).
> Check the lengths in JS when they must match.

## Bind JS rows typed by a table: `unnestRows()` / `fromRows()`

`unnestRows(table, rows, columns?)` (since 1.0.29) is a set typed by a table's columns: one array parameter per
column, cast to the column's SQL type, every cell bound through the column's mapper. `fromRows(table, rows, { columns?, alias? })`
is `fromSet(unnestRows(…), alias ?? 'rows')`, ready to embed. The statement text does not depend on the number of
rows, and zero rows are a legal empty set.

```ts
import { unnestRows } from 'linkgress-orm';

const columns = ['userId', 'status', 'totalAmount'] as const;
const rows = await db.selectFromSet(unnestRows(db.orders, [
  { userId: 1, status: 'pending', totalAmount: 5 },
  { userId: 2, status: 'completed', totalAmount: 7.255 },
  { userId: 3, status: 'refunded', totalAmount: 9 },
], columns), 'r').toList();
// [{ userId: 1, status: 'pending', totalAmount: '5.00' },
//  { userId: 2, status: 'completed', totalAmount: '7.26' },
//  { userId: 3, status: 'refunded', totalAmount: '9.00' }]
```

```sql
SELECT "r"."userId" as "userId", "r"."status" as "status", "r"."totalAmount" as "totalAmount"
FROM unnest(CAST($1 AS integer[]), CAST($2 AS order_status[]), CAST($3 AS decimal(10, 2)[])) AS "r"("userId", "status", "totalAmount")
-- params: ["{1,2,3}", "{\"pending\",\"completed\",\"refunded\"}", "{5,7.255,9}"]
```

With zero rows the text is the same and the parameters are `["{}", "{}", "{}"]`; with one row, `["{1}", "{\"pending\"}", "{5}"]`.

- `columns` fixes the set's columns and their order. Without it the set holds the table's columns that any row
  holds, in table order (every column for zero rows): `unnestRows(db.orders, [{ userId: 1, totalAmount: 5 }])`
  renders `unnest(CAST($1 AS integer[]), CAST($2 AS decimal(10, 2)[])) AS "r"("userId", "totalAmount")`. Pass
  `columns` to keep the text the same whatever the rows hold.
- A row without a value for a column holds NULL there, not the column's default.
- Cells bind as the drivers bind a value of the column: a `Date` in local time with its offset (a `timestamp` stores
  the wall time), a json value as its JSON text, a numeric column's precision and scale applied (`decimal(10, 2)`
  rounds `7.255` to `7.26`). An array column — which `unnest` would flatten — rides as the text of its array
  literal and is cast back: `(SELECT "rows"."code", CAST("rows"."tags" AS integer[]) AS "tags" FROM unnest(…) AS "rows"("code", "tags")) AS "rows"`.
- The row reads — and compares, in a condition — through the columns' mappers. A `decimal` column without a
  mapper reads as a string (`'5.00'`), as it does from the table.
- A column the table does not have is refused: `unnestRows(): "<prop>" is not a column of "<table>"`.

Insert JS rows through `insertFrom()` — the same statement text for 1 row and 500:

```ts
import { fromRows } from 'linkgress-orm';

const incoming = [
  { userId: 1, status: 'pending' as const, totalAmount: 12.5 },
  { userId: 3, status: 'pending' as const, totalAmount: 40 },
];
await db.orders.insertFrom(
  fromRows(db.orders, incoming, { columns: ['userId', 'status', 'totalAmount'] }).asSubquery('table'),
  src => ({ userId: src.userId, status: src.status, totalAmount: src.totalAmount }),
);
```

```sql
INSERT INTO "orders" ("user_id", "status", "total_amount") SELECT "src"."userId", "src"."status", "src"."totalAmount" FROM (SELECT "rows"."userId" as "userId", "rows"."status" as "status", "rows"."totalAmount" as "totalAmount"
  FROM unnest(CAST($1 AS integer[]), CAST($2 AS order_status[]), CAST($3 AS decimal(10, 2)[])) AS "rows"("userId", "status", "totalAmount")) AS "src"
-- params: ["{1,3}", "{\"pending\",\"pending\"}", "{12.5,40}"]
```

`insertFrom()` options (`where`, `onConflictDoNothing`, `with`) and `toStatement()` apply as to any source; see
[Insert, update, delete](./insert-update-guide.md). Inside a data-modifying CTE the same source feeds a
close-then-open fold: see [CTEs](./cte-guide.md#order-two-writes-in-one-statement-aftermutation).

Delete the rows a list no longer holds — an anti-join correlated to the target table:

```ts
import { eq, fromRows, literal, notExists } from 'linkgress-orm';

const keep = [{ name: 'Summer' }, { name: 'Winter' }];
await db.tags
  .where(t => notExists(fromRows(db.tags, keep, { columns: ['name'], alias: 'k' })
    .where(k => eq(k.name, t.name))
    .select(() => ({ one: literal(1) }))
    .asSubquery()))
  .delete();
```

```sql
DELETE FROM "tags" WHERE (NOT EXISTS (SELECT 1 as "one"
  FROM unnest(CAST($1 AS varchar[])) AS "k"("name")
  WHERE "k"."name" = "tags"."name"))
-- params: ["{\"Summer\",\"Winter\"}"]
```

A column with a custom mapper binds its driver value: `fromRows(db.posts, [{ publishTime: { hour: 9, minute: 30 } }], { columns: ['publishTime'], alias: 'w' })`
in an `exists()` correlated to `posts.publish_time` renders `FROM unnest(CAST($1 AS smallint[])) AS "w"("publishTime") WHERE "w"."publishTime" = "posts"."publish_time"`
with `params: ["{570}"]`.

## Match rows against a list of composite keys: join `fromRows()`

A list of `(orderId, taskId)` pairs is a set of rows, not a list of values: `eqAny()` and `inArrayOpt()` match one
column. Join the pairs as a table subquery (since 1.0.29): one array parameter per key column, and the statement text
does not grow with the number of pairs.

```ts
import { and, eq, fromRows } from 'linkgress-orm';

const keys = [{ orderId: 1, taskId: 1 }, { orderId: 2, taskId: 2 }, { orderId: 2, taskId: 9 }];
const matched = await db.orderTasks
  .innerJoin(
    fromRows(db.orderTasks, keys, { columns: ['orderId', 'taskId'], alias: 'k' }).asSubquery('table'),
    (ot, k) => and(eq(ot.orderId, k.orderId), eq(ot.taskId, k.taskId)),
    (ot, k) => ({ orderId: ot.orderId, taskId: ot.taskId, sortOrder: ot.sortOrder }),
    'keys',
  )
  .toList();
// [{ orderId: 1, taskId: 1, sortOrder: 1 }, { orderId: 2, taskId: 2, sortOrder: 1 }]   (2, 9 matches no row)
```

```sql
SELECT "order_task"."order_id" as "orderId", "order_task"."task_id" as "taskId", "order_task"."sort_order" as "sortOrder"
FROM "order_task"
INNER JOIN (SELECT "k"."orderId" as "orderId", "k"."taskId" as "taskId"
FROM unnest(CAST($1 AS integer[]), CAST($2 AS integer[])) AS "k"("orderId", "taskId")) AS "keys" ON ("order_task"."order_id" = "keys"."orderId" AND "order_task"."task_id" = "keys"."taskId")
-- params: [ "{1,2,2}", "{1,2,9}" ]
```

- The alias (4th argument, `'keys'`) is required for a subquery join; `alias` inside `fromRows()` names the set's own
  rows (`"k"`).
- A duplicated pair in the list returns its row twice (an INNER JOIN per match). Deduplicate the pairs in JS, or test
  each row with `exists(fromRows(…).where(k => and(eq(k.orderId, ot.orderId), eq(k.taskId, ot.taskId))).select(() => ({ one: literal(1) })).asSubquery())`,
  which keeps each row once.
- The same set deletes or updates by composite key: `db.orderTasks.where(ot => exists(…)).delete()`.

> **Pitfall:** `or(...keys.map(k => and(eq(ot.orderId, k.orderId), eq(ot.taskId, k.taskId))))` binds 2 parameters
> per pair and changes the statement text with every list length; a long list reaches the 65,535-parameter limit.

## Turn jsonb into rows: `jsonbArrayElements()` / `jsonbEachText()`

`jsonbArrayElements(target)` yields one row per element of a jsonb array, the element (jsonb, parsed) in `value`.
`jsonbEachText(target)` yields one row per key of a jsonb object: `key` and the value as text (a JSON null is SQL
NULL). Over a JS value, the value binds as one jsonb parameter.

```ts
import { jsonbArrayElements, jsonbEachText } from 'linkgress-orm';

const items = await db.selectFromSet(jsonbArrayElements<{ sku: string; qty: number }>([{ sku: 'A-1', qty: 2 }, { sku: 'B-7', qty: 1 }]), 'e')
  .select(e => e.value)
  .toList();
// [{ sku: 'A-1', qty: 2 }, { sku: 'B-7', qty: 1 }]

const pairs = await db.selectFromSet(jsonbEachText({ color: 'red', size: null }), 'kv')
  .select(kv => ({ key: kv.key, value: kv.value }))
  .toList();
// [{ key: 'size', value: null }, { key: 'color', value: 'red' }]
```

```sql
SELECT "e"."value" as "value"
FROM jsonb_array_elements(CAST(CAST($1 AS text) AS jsonb)) AS "e"("value")
-- params: ["[{\"sku\":\"A-1\",\"qty\":2},{\"sku\":\"B-7\",\"qty\":1}]"]

SELECT "kv"."key" as "key", "kv"."value" as "value"
FROM jsonb_each_text(CAST(CAST($1 AS text) AS jsonb)) AS "kv"("key", "value")
-- params: ["{\"color\":\"red\",\"size\":null}"]
```

- `jsonbEachText` returns keys in the order jsonb stores them (sorted, shorter keys first: `size` before `color`),
  not in the JS object's order: add `orderBy(kv => kv.key)` when the order matters.
- Over a jsonb column, use the set per row: `crossJoinLateral()` to get the elements as rows,
  `fromSet(…).asSubquery()` to test or pick one value per row (next sections).
- For "does the array hold an element matching X", `jsonbArraySome(col, e => eq(e.sku, 'B-7'))` needs no set and
  guards rows whose value is not an array (`CASE WHEN jsonb_typeof(…) = 'array' THEN … ELSE '[]'::jsonb END`).

## Test each row against a list or a jsonb document: `fromSet()` subqueries

`fromSet(set, alias?)` builds the same query as `db.selectFromSet()` without a context, to embed: `exists()`,
`notExists()`, `inSubquery()`, a scalar subquery in a projection, a table subquery (a join, an `insertFrom` source),
a union leg, a CTE body. It renders in the enclosing statement's parameter sequence. Anything its callbacks read
that is not a column of the set — a column of the enclosing query, also inside the function's argument — is a
correlation: it renders as that column, and the enclosing query joins the navigations it reads.

Users whose (name, minimum age) pair is in a JS list — a test `eqAny()` cannot express:

```ts
import { and, eq, exists, fromSet, gte, literal, unnestZip } from 'linkgress-orm';

const rules = unnestZip<{ name: string; minAge: number }>({
  name: { values: ['alice', 'bob'], type: 'text' },
  minAge: { values: [20, 40], type: 'integer' },
});

const matching = await db.users
  .where(u => exists(fromSet(rules, 'r')
    .where(r => and(eq(r.name, u.username), gte(u.age!, r.minAge)))
    .select(() => ({ one: literal(1) }))
    .asSubquery()))
  .select(u => ({ name: u.username, age: u.age }))
  .toList();
// [{ name: 'alice', age: 25 }]   (bob is 35, below 40)
```

```sql
SELECT "users"."username" as "name", "users"."age" as "age"
FROM "users"
WHERE EXISTS (SELECT 1 as "one"
  FROM unnest(CAST($1 AS text[]), CAST($2 AS integer[])) AS "r"("name", "minAge")
  WHERE ("r"."name" = "users"."username" AND "users"."age" >= "r"."minAge"))
-- params: ["{\"alice\",\"bob\"}", "{20,40}"]
```

One value per row from its jsonb column — the first non-NULL value by key (for this example alice's
`users.metadata` holds `{ a: null, b: 'x', c: 'y' }`):

```ts
import { eq, fromSet, isNotNull, jsonbEachText } from 'linkgress-orm';

const rows = await db.users
  .where(u => eq(u.id, 1))
  .select(u => ({
    name: u.username,
    first: fromSet(jsonbEachText(u.metadata), 'kv')
      .where(kv => isNotNull(kv.value))
      .orderBy(kv => kv.key)
      .select(kv => kv.value)
      .limit(1)
      .asSubquery('scalar'),
  }))
  .toList();
// [{ name: 'alice', first: 'x' }]
```

```sql
SELECT "users"."username" as "name", (SELECT "kv"."value" as "value"
  FROM jsonb_each_text("users"."metadata") AS "kv"("key", "value")
  WHERE "kv"."value" IS NOT NULL
  ORDER BY "kv"."key" ASC
  LIMIT 1) as "first"
FROM "users"
WHERE "users"."id" = $1
-- params: [1]
```

- `asSubquery('array')` and `asSubquery('scalar')` are typed by the one projected column: `select(n => n.value)` or
  `select(n => ({ v: n.value }))`. `'table'` (the default) keeps the row.
- `inSubquery(u.username, fromSet(unnest(names, 'text'), 'n').select(n => n.value).asSubquery('array'))` renders
  `"users"."username" IN (SELECT "n"."value" as "value" FROM unnest(CAST($1 AS text[])) AS "n"("value"))` — the
  same rows as `eqAny(u.username, names)`, which renders `("users"."username" = ANY($1::varchar[]))`. Use
  `inArrayOpt()` (data-driven lists) or `eqAny()` (one statement text for every length) for plain membership.
- A context-free set query cannot run: `.toList()` throws `fromSet(): a context-free set query cannot run on its own — run it through db.selectFromSet(...) or <table>.selectFromSet(...), or embed it with .asSubquery()`.
- A correlation to a column under the set's own alias is refused (inside the subquery the alias names the set's
  row): `fromSet(): the alias "users" is both the set's alias and the alias of the column "users"."username" it correlates to — give the set another alias (fromSet(set, '<alias>'))`.
- The set's row carries an identity of its own: an entity query nested in the set query reads the set's columns as
  correlations, also when the set's alias equals one of that query's navigation names.

## Join a set to every row: `crossJoinLateral()`

`crossJoinLateral(row => set, (row, setRow) => selection, alias)` on `db.<table>` or on an entity select query renders
`CROSS JOIN LATERAL <call> AS "<alias>"(…)` after the FROM, the query's joins and its navigation joins, before its
collection joins and the WHERE: each row repeats once per row of its set, and a row whose set is empty or NULL drops
out. The result is an ordinary select query: `where()` over the set's values, `orderBy()`, `count()`, `groupBy()`
(the joined rows are grouped), `asSubquery()` (a correlated subquery; the set's columns stay its own), `toList()`.

```ts
// fragment: the signature
crossJoinLateral<TSetRow, TSelection>(
  source: (row) => SetReturningFunction<TSetRow>,
  selector: (row, set: SetRow<TSetRow>) => TSelection,
  alias: string,
): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>
```

With `orders.items` (jsonb) holding `[{ sku: 'A-1', qty: 2 }, { sku: 'B-7', qty: 1 }]` (order 1) and
`[{ sku: 'A-1', qty: 5 }]` (order 2) — written as JSON text, since on `PgClient` a JS array value binds as a
PostgreSQL array literal (`invalid input syntax for type json`; see [SQL expressions](./sql-expressions.md)):

```ts
import { castAsInt, isNotNull, jsonbArrayElements, jsonbPathText } from 'linkgress-orm';

type LineItem = { sku: string; qty: number };

const lines = await db.orders
  .where(o => isNotNull(o.items))
  .crossJoinLateral(
    o => jsonbArrayElements<LineItem>(o.items),
    (o, item) => ({
      orderId: o.id,
      customer: o.user!.username,
      sku: jsonbPathText(item.value, 'sku'),
      qty: castAsInt(jsonbPathText(item.value, 'qty')),
    }),
    'item',
  )
  .orderBy(r => [r.orderId, r.sku])
  .toList();
// [{ orderId: 1, customer: 'alice', sku: 'A-1', qty: 2 },
//  { orderId: 1, customer: 'alice', sku: 'B-7', qty: 1 },
//  { orderId: 2, customer: 'bob', sku: 'A-1', qty: 5 }]
```

```sql
SELECT "orders"."id" as "orderId", "user"."username" as "customer", ("item"."value"->>'sku') as "sku", CAST(("item"."value"->>'qty') AS integer) as "qty"
FROM "orders"
INNER JOIN "users" AS "user" ON "orders"."user_id" = "user"."id"
CROSS JOIN LATERAL jsonb_array_elements("orders"."items") AS "item"("value")
WHERE "orders"."items" IS NOT NULL
ORDER BY "orderId" ASC, "sku" ASC
```

Group the exploded rows — total quantity per SKU, in SQL:

```ts
import { castAsInt, jsonbArrayElements, jsonbPathText } from 'linkgress-orm';

type LineItem = { sku: string; qty: number };

const perSku = await db.orders
  .crossJoinLateral(
    o => jsonbArrayElements<LineItem>(o.items),
    (o, item) => ({ sku: jsonbPathText(item.value, 'sku'), qty: castAsInt(jsonbPathText(item.value, 'qty')) }),
    'item',
  )
  .groupBy(r => ({ sku: r.sku }))
  .select(g => ({ sku: g.key.sku, total: castAsInt(g.sum(r => r.qty)), lines: g.count() }))
  .orderBy(r => r.sku)
  .toList();
// [{ sku: 'A-1', total: 7, lines: 2 }, { sku: 'B-7', total: 1, lines: 1 }]
```

```sql
SELECT "q1"."sku" as "sku", CAST(SUM("q1"."__arg0") AS integer) as "total", CAST(COUNT(*) AS INTEGER) as "lines"
FROM (SELECT ("item"."value"->>'sku') as "sku", CAST(("item"."value"->>'qty') AS integer) as "__arg0"
  FROM "orders"
  CROSS JOIN LATERAL jsonb_array_elements("orders"."items") AS "item"("value")) "q1"
GROUP BY "sku"
ORDER BY "sku" ASC
```

> **Efficiency:** the elements are produced and aggregated inside the one statement; no document travels to the
> client. The argument may read navigations of the row; they are joined.

- `count()` counts the multiplied rows: the same lateral join with `.count()` renders
  `SELECT COUNT(*) as count FROM "orders" CROSS JOIN LATERAL jsonb_array_elements("orders"."items") AS "item"("value")` and returns `3`.
- `where()` after the lateral join filters on the set's values: on `db.posts.where(p => gt(p.views, 100)).select(…)`,
  `.crossJoinLateral(() => unnest([10, 20], 'integer'), (p, x) => ({ id: p.id, title: p.title, x: x.value }), 'x').where(row => gt(row.x, 10))`
  renders `CROSS JOIN LATERAL unnest(CAST($3 AS integer[])) AS "x"("value") WHERE ("posts"."views" > $1 AND "x"."value" > $2)`.
- The join order is fixed: the lateral sets (several in the order added) render after every join of the query
  (its `innerJoin` / `leftJoin` / `joinFilter` joins in the order added, and its navigation joins), whatever order
  the calls were made in. A join that does not read the set works in either order; a join whose ON predicate
  reads the set is refused: `crossJoinLateral(): the ON predicate of the join "users_0" reads the set "xx" — a query's joins render before its lateral sets, so the set is not in scope there. Filter on the set's values with where() instead.`
- The alias is a plain identifier that may not name the query's table, a navigation, a joined table, a CTE or
  another lateral set: `crossJoinLateral(): the alias "user" already names the table, a navigation, a join or a CTE of this query — pick another`.
- A query nested in the projection (an entity subquery reading `item.value`) reads the set's columns as
  correlations, whatever the alias is.
- `update()` and `delete()` of a query over a lateral set are refused (`… a query over a set-returning join cannot update or delete — filter the table itself (e.g. with exists(fromSet(...)...))`):
  filter the target rows with `exists(fromSet(…)…)` instead.

## Repeat each row per element: a set as a projection value

A single-column set in a projection is a set-returning select-list item: PostgreSQL emits one output row per
element. Use it to repeat rows per element; to filter, count or group the elements use `crossJoinLateral()`.

```ts
import { eq, sql, unnest } from 'linkgress-orm';

const parts = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ name: u.username, part: unnest(sql<string[]>`string_to_array(${u.email}, '@')`) }))
  .toList();
// [{ name: 'alice', part: 'alice' }, { name: 'alice', part: 'test.com' }]
```

```sql
SELECT "users"."username" as "name", unnest(string_to_array("users"."email", '@')) as "part"
FROM "users"
WHERE "users"."username" = $1
-- params: ["alice"]
```

- A selector returning the set itself reads as a list of values:
  `db.users.where(u => eq(u.id, 1)).select(() => unnest([1, 2, 3], 'integer')).toList()` returns `[1, 2, 3]`.
- `count()`, `exists()` and `countOver()` of a query whose projection holds a set are refused: they count the rows
  of the FROM, before the set multiplies them (or drops a row whose set is empty). `count()` throws
  `count(): the projection holds a set-returning function (unnest(…), jsonbArrayElements(…), …), which multiplies the rows after COUNT(*) sees them — join the set with crossJoinLateral(…) to count its rows`.
- Only a single-column set is a projection value: `jsonbEachText(…)` there throws
  `jsonb_each_text() returns 2 columns (key, value): a projection value is one column — read them through a source: fromSet(), db.selectFromSet() or crossJoinLateral()`.
- In a WHERE (or any other expression) a set throws: `unnest() returns a set of rows: use it as a projection value (select(r => ({ v: unnest(…) }))) or as a row source (fromSet(), db.selectFromSet(), crossJoinLateral()) — not inside a WHERE, HAVING, ORDER BY, GROUP BY key, CASE, an aggregate's argument or another expression`.
- `.as(alias)`, `.withReadType(type)` and `.mapWith(fn)` keep a projected set a set (next section).

## How set columns read back

A set column reads as the driver delivers it: text stays text (`'007'` is not the number `7`), an integer array's
elements are numbers, jsonb is the parsed JSON, NULL is `null`. It never goes through the numeric-text coercion a
mapper-less expression gets. `unnestRows()` columns read through the table columns' mappers. On a projected set,
`.withReadType('<type>')` reads it as a column of that type and `.mapWith(fn)` through a function.

```ts
import { eq, unnest } from 'linkgress-orm';

const raw = await db.users.where(u => eq(u.id, 1))
  .select(() => ({ v: unnest(['1.50', '007'], 'text') })).toList();
// [{ v: '1.50' }, { v: '007' }]
const typed = await db.users.where(u => eq(u.id, 1))
  .select(() => ({ v: unnest(['1.50', '2'], 'text').withReadType<number>('numeric') })).toList();
// [{ v: 1.5 }, { v: 2 }]
const mapped = await db.users.where(u => eq(u.id, 1))
  .select(() => ({ v: unnest(['1.50', '2'], 'text').mapWith((x: string) => Number(x) * 2) })).toList();
// [{ v: 3 }, { v: 4 }]
```

```sql
SELECT unnest(CAST($1 AS text[])) as "v"
FROM "users"
WHERE "users"."id" = $2
-- params: ["{\"1.50\",\"007\"}", 1]
```

The three statements share this text (the second and third bind `["{\"1.50\",\"2\"}", 1]`); the reads differ only
in the client.

## Combine sets with other queries: joins, unions, CTE bodies

A set query embeds wherever a query does. As a table subquery it joins an entity query (the alias is the 4th
argument):

```ts
import { eq, fromSet, unnestZip } from 'linkgress-orm';

const labels = unnestZip<{ id: number; label: string }>({
  id: { values: [1, 2], type: 'integer' },
  label: { values: ['gold', 'silver'], type: 'text' },
});

const rows = await db.users
  .innerJoin(
    fromSet(labels, 'z').select(z => ({ id: z.id, label: z.label })).asSubquery('table'),
    (u, z) => eq(u.id, z.id),
    (u, z) => ({ username: u.username, label: z.label }),
    'zz',
  )
  .toList();
// [{ username: 'alice', label: 'gold' }, { username: 'bob', label: 'silver' }]
```

```sql
SELECT "users"."username" as "username", "zz"."label" as "label"
FROM "users"
INNER JOIN (SELECT "z"."id" as "id", "z"."label" as "label"
  FROM unnest(CAST($1 AS integer[]), CAST($2 AS text[])) AS "z"("id", "label")) AS "zz" ON "users"."id" = "zz"."id"
-- params: ["{1,2}", "{\"gold\",\"silver\"}"]
```

A union of set queries — the first leg bound to the context — reads each leg's literal from its rows:

```ts
import { fromSet, unnest } from 'linkgress-orm';

const tagged = await db.selectFromSet(unnest(['x', 'y'], 'text'), 'a').select(r => ({ tag: 'a', v: r.value }))
  .unionAll(fromSet(unnest(['z'], 'text'), 'b').select(r => ({ tag: 'b', v: r.value })))
  .toList();
// [{ tag: 'a', v: 'x' }, { tag: 'a', v: 'y' }, { tag: 'b', v: 'z' }]
```

```sql
(SELECT $1 as "tag", "a"."value" as "v"
  FROM unnest(CAST($2 AS text[])) AS "a"("value"))
UNION ALL
(SELECT $3 as "tag", "b"."value" as "v"
  FROM unnest(CAST($4 AS text[])) AS "b"("value"))
-- params: ["a", "{\"x\",\"y\"}", "b", "{\"z\"}"]
```

- A union whose first leg is a context-free `fromSet()` cannot run (it throws the `fromSet(): a context-free set query cannot run on its own …` error):
  start it with `db.selectFromSet()`, or embed it. Entity legs mix with set legs:
  `db.selectFromSet(unnest(['dave'], 'text'), 'n').select(n => ({ name: n.value })).union(db.users.where(u => eq(u.id, 1)).select(u => ({ name: u.username })))`
  returns `[{ name: 'dave' }, { name: 'alice' }]`.
- A set query is a CTE body (since 1.0.29):
  `new DbCteBuilder().with('wanted', fromSet(unnest(['alice', 'bob'], 'text'), 'n').select(n => ({ name: n.value })))`
  renders `WITH "wanted" AS (SELECT "n"."value" as "name" FROM unnest(CAST($1 AS text[])) AS "n"("value"))`. See
  [CTEs](./cte-guide.md).

## Run a set query on a table's own connection: `<table>.selectFromSet()`

`<table>.selectFromSet(set, alias?)` (since 1.0.30) is `db.selectFromSet()` bound to the table's context: on a
transaction's table (`trx.users`) it runs on the transaction's connection, so a set correlated to the table sees the
transaction's uncommitted rows. Same signature, typing and SQL as `db.selectFromSet()`. Use it in helpers that
receive a table rather than the context.

```ts
import { unnest } from 'linkgress-orm';

const ids = await db.transaction(async trx =>
  trx.users.selectFromSet(unnest([1, 2], 'integer'), 'n').select(n => n.value).toList());
// [1, 2]
```

```sql
SELECT "n"."value" as "value"
FROM unnest(CAST($1 AS integer[])) AS "n"("value")
-- params: ["{1,2}"]
```

The statement runs inside the transaction. `<table>.isInTransaction()` and `<table>.getClient()` come with it; see
[CTEs](./cte-guide.md#run-cte-statements-on-a-tables-own-connection-tableselectfromcte).

## Pitfalls

- **Don't** build a set for a plain membership test → **Do** use `inArrayOpt(col, list)` for data-driven lists, or
  `eqAny(col, list)` when every length must share one statement text. Both are the shortest SQL (`IN ($1, …)` /
  `= ANY($1::type[])`); `inSubquery(…, fromSet(unnest(…)))` returns the same rows with more text.
- **Don't** pass a JS array to `unnest()` without its element type → **Do** write `unnest(list, 'text')`. A JS array
  (or `null`) has no SQL type of its own: the build throws `unnest: a JS array needs its element type — unnest(values, 'text')`.
- **Don't** put column refs into a JS array or object (`unnest([r.a, r.b], 'int')`) → **Do** build the value in SQL
  (`` sql`ARRAY[…]` ``, `jsonb_build_object(…)`) or use `unnestZip()`. Bound as one parameter, the refs would be
  serialized; the build refuses it.
- **Don't** run `fromSet(…).toList()` → **Do** run `db.selectFromSet(…)` or `<table>.selectFromSet(…)`, or embed the
  `fromSet()` query. A context-free query has no connection.
- **Don't** call `count()` on a query that projects a set → **Do** join the set with `crossJoinLateral()` and count
  that. COUNT(*) sees the rows before the set multiplies them; the build refuses it.
- **Don't** filter a lateral set in a later join's ON → **Do** filter it in `where()`. Lateral sets render after
  every join; such a join is refused.
- **Don't** rely on `unnestZip()` arrays having equal lengths → **Do** check them in JS. The shorter array is padded
  with NULL silently.
- **Don't** leave `columns` out of `unnestRows()` / `fromRows()` when the rows differ in shape → **Do** pass
  `columns`. The default follows the columns the rows hold, so the statement text (and a prepared plan) changes
  with the data.
- **Don't** expect `unnestRows()` to apply column defaults → **Do** fill the values in JS. A missing cell is NULL.
- **Don't** pass a jsonb column to `jsonbArrayElements()` when some rows may hold an object or a scalar → **Do** use
  `jsonbArraySome()` for existence tests, or guard the argument:
  `` jsonbArrayElements(sql`CASE WHEN jsonb_typeof(${o.items}) = 'array' THEN ${o.items} ELSE '[]'::jsonb END`) ``.
  One such row aborts the whole statement with 22023 "cannot extract elements from an object" (NULL is fine: no rows).
- **Don't** expect `jsonbEachText()` to keep the JS object's key order → **Do** `orderBy(kv => kv.key)`. jsonb stores
  keys in its own order.

## See also

- [CTEs](./cte-guide.md) — sets as CTE bodies, `fromRows()` inside data-modifying CTEs, `<table>.selectFromCte()`.
- [Subqueries](./subquery-guide.md) — `exists()`, `inSubquery()`, scalar and table subqueries the set queries plug into.
- [Querying](./querying.md#matching-a-list-of-values) — `inArrayOpt()`, `eqAny()` and the other list operators for membership tests.
- [Insert, update, delete](./insert-update-guide.md) — `insertFrom()` with a set source, `onConflictDoNothing`, `toStatement()`.
- [SQL expressions](./sql-expressions.md) — `jsonbPathText()`, `jsonbArraySome()`, `castAsInt()`, `agg` used over set rows.
- [Choosing the right query](../choosing-the-right-query.md) — data need → API → SQL shape → round trips.
- [API index](../api-index.md) — every public export and builder method, one line each.
- Tests with more cases (repository only, not in the npm package): [tests/queries/set-returning.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/queries/set-returning.test.ts), [tests/queries/rows-source.test.ts](https://github.com/brunolau/linkgress-orm/blob/main/tests/queries/rows-source.test.ts).
