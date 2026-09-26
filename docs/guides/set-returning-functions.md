# Set-Returning Functions

`unnest`, `jsonb_array_elements` and `jsonb_each_text` return a **set of rows**. linkgress models them as
`SetReturningFunction` values, used in two places only:

- **as a projection value** — a set-returning select-list item that multiplies the rows of the projection;
- **as a row source** — `fromSet()` (a context-free subquery), `db.selectFromSet()` (a query of its own) and
  `crossJoinLateral()` (joined to every row of an entity query).

Anywhere else — a WHERE, a HAVING, an ORDER BY, a GROUP BY key, a CASE, an aggregate's argument, inside another
expression — building the query throws `<fn>() returns a set of rows: …`. PostgreSQL rejects most of those, and
the rest multiply rows in places no one expects.

```typescript
import { unnest, unnestZip, jsonbArrayElements, jsonbEachText, fromSet } from 'linkgress-orm';
```

## The functions

| Function | SQL | Columns |
|---|---|---|
| `unnest(array, elementType?)` | `unnest(<array>)` | `value` |
| `unnestZip({ c1: { values, type }, … })` | `unnest(CAST($1 AS t1[]), CAST($2 AS t2[]), …)` | `c1`, `c2`, … |
| `jsonbArrayElements(target)` | `jsonb_array_elements(<target>)` | `value` (jsonb) |
| `jsonbEachText(target)` | `jsonb_each_text(<target>)` | `key`, `value` (text) |

- `unnest`'s `array` is an array column or expression (`unnest(r.tags)`), or a **JS array**, which binds as ONE
  parameter — the array literal cast to `<elementType>[]`: `unnest(CAST($1 AS text[]))`. A JS array (or `null`)
  needs its `elementType`; a column's element type comes from its SQL type. NULL and an empty array give no rows.
- `unnestZip` zips its arrays **by position** — a shorter array is padded with NULL — one typed array parameter
  per column (or an array column / expression, cast to `<type>[]`). Column names are plain identifiers.
- `jsonbArrayElements` / `jsonbEachText` take a jsonb column or expression, or a plain JS value (serialized and
  cast to jsonb). A NULL target gives no rows; a non-array (non-object) raises PostgreSQL's own error.
- A JS array or object that holds column refs or expressions (`unnest([r.a, r.b], 'int')`,
  `jsonbArrayElements({ n: r.name })`) is refused: bound as ONE parameter, the refs would be serialized into it.
  Build such a value in SQL (`sql\`ARRAY[…]\``, `jsonb_build_object(…)`), or use `unnestZip`.

### How a set column reads back

Exactly as the driver delivers it: text stays text (`'007'` is not the number `7`), an integer array's
elements are numbers, jsonb is the parsed JSON, NULL is `null`. It never goes through the numeric-text coercion
a mapper-less expression gets. Chain `.mapWith(...)` on a projection value to read it otherwise, or
`.withReadType('<type>')` to read it as a column of that type (`unnest(prices).withReadType<number>('numeric')`
turns the driver's numeric text into numbers); either way it stays a set.

## As a projection value

```typescript
const rows = await db.boxes.select(b => ({ name: b.name, label: unnest(b.labels) })).toList();
// SELECT "srf_boxes"."name" as "name", unnest("srf_boxes"."labels") as "label" FROM "srf_boxes"
// → one row per label: [{ name: 'alpha', label: 'red' }, { name: 'alpha', label: 'blue' }, { name: 'alpha', label: '007' }]

const sizes = await db.boxes.select(b => unnest(b.sizes)).toList();   // [1, 2, 3]
```

Only a **single-column** set is a projection value; `jsonbEachText(...)` (two columns) is read through a source.

`count()`, `exists()` and `countOver()` of a query whose projection holds a set-returning value are **refused**:
they count the rows of the FROM, before the set multiplies them (or drops a row whose set is empty), so they would
answer for other rows than `toList()` returns. Join the set with `crossJoinLateral()` to count its rows.

## `fromSet(set, alias?)` — a context-free subquery source

Needs no `DbContext`: for helpers that build expressions without one. Embed it with `.asSubquery('scalar' |
'array' | 'table')` — in `exists`, `notExists`, `inSubquery`, `coalesce`, a projection — or as the first leg of a
UNION. The alias defaults to the function's name.

```typescript
fromSet(set, alias?)
  .where(row => Condition)                  // repeated calls AND
  .select(row => selection)                 // an object of fields, or one value (`n => n.value`)
  .orderBy(row => key | key[] | [key, 'ASC' | 'DESC'][])   // replaces a previous orderBy()
  .limit(n).offset(n)                       // inline non-negative integers
  .asSubquery(mode)                         // or .union(q) / .unionAll(q)
```

It renders `SELECT <selection> FROM <call> AS "<alias>"("<c1>", …) [WHERE …] [ORDER BY …] [LIMIT n] [OFFSET m]`
in the **enclosing statement's** parameter sequence:

```typescript
exists(fromSet(unnest(b.labels), 'l').where(l => eq(l.value, 'red')).select(() => ({ one: literal(1) })).asSubquery())
// EXISTS (SELECT 1 as "one" FROM unnest("srf_boxes"."labels") AS "l"("value") WHERE "l"."value" = $1)

fromSet(unnest(['a', 'b'], 'text'), 'n').where(n => ne(n.value, 'b')).select(n => n.value).asSubquery('scalar')
// SELECT "n"."value" as "value" FROM unnest(CAST($3 AS text[])) AS "n"("value") WHERE "n"."value" != $4
//   (two parameters already bound by the enclosing statement)
```

- The set's row renders `"<alias>"."<column>"`. Anything else the callbacks read — a column of the enclosing
  query, also inside the function's argument — is a **correlation**: it renders as that column and is reported by
  the subquery (`getOuterFieldRefs()`), so the enclosing query joins the navigations it reads:

  ```typescript
  db.boxes.select(b => ({
    firstAlias: fromSet(unnest(b.group!.aliases), 'a').orderBy(a => a.value).limit(1).select(a => a.value).asSubquery('scalar'),
  }))
  // … FROM "srf_boxes" … JOIN "srf_groups" AS "group" ON …
  ```

- A correlation to a column under the set's **own alias** is refused (inside the subquery that alias names the
  set's row): `fromSet(): the alias "l" is both the set's alias and the alias of the column …`.
- The set's row carries an identity of its own: an entity query nested in the set query reads its columns as
  correlations, also when the set's alias equals one of that query's navigations (a set aliased `group` read by a
  `db.boxes` query that has a `group` navigation) — by alias name alone it used to be that query's own join.
- A context-free set query cannot run: `.toList()` throws and points to `db.selectFromSet()`.

## `db.selectFromSet(set, alias?)` — a query of its own

The same builder, bound to the context: `.toList()`, `.firstOrDefault()`, `.toSql()`.

```typescript
const rows = await db
  .selectFromSet(unnestZip<{ id: number; code: string | null }>({
    id: { values: [1, 2, 3], type: 'integer' },
    code: { values: ['01', '7'], type: 'text' },
  }), 'z')
  .orderBy(z => z.id)
  .toList();
// SELECT "z"."id" as "id", "z"."code" as "code"
// FROM unnest(CAST($1 AS integer[]), CAST($2 AS text[])) AS "z"("id", "code")
// ORDER BY "z"."id" ASC
// → [{ id: 1, code: '01' }, { id: 2, code: '7' }, { id: 3, code: null }]

await db.selectFromSet(jsonbArrayElements<{ a: number }>([{ a: 1 }, { a: 2 }])).select(e => e.value).toList();
// → [{ a: 1 }, { a: 2 }]
```

## `crossJoinLateral(source, selector, alias)` — a set per row of an entity query

```typescript
crossJoinLateral<TSetRow, TSelection>(
  source: (row) => SetReturningFunction<TSetRow>,
  selector: (row, set: SetRow<TSetRow>) => TSelection,
  alias: string,
)
```

Available on `db.<table>` and on an entity select query. `CROSS JOIN LATERAL <call> AS "<alias>"(…)` is rendered
after `FROM`, the query's joins and the navigation joins, before the collection joins and the WHERE. Each row of
the query is repeated once per row of its set; a row whose set is empty (or NULL) drops out.

The **join order is fixed**, whatever order the calls were made in: the lateral sets (in the order added) render
after every join of the query — its `innerJoin` / `leftJoin` / `joinFilter` joins (in the order added) and its
navigation joins. A join added after `crossJoinLateral()` therefore cannot read the set in its ON predicate — it is
refused (`crossJoinLateral(): the ON predicate of the join "<alias>" reads the set "<set>" …`); filter on the set's
values with `where()` instead. A join that does not read the set works in either order.

```typescript
const lines = await db.boxes
  .where(b => isNotNull(b.items))
  .crossJoinLateral(b => jsonbArrayElements<BoxItem>(b.items), (b, item) => ({
    box: b.name,
    group: b.group!.name,
    kind: jsonbPathText(item.value, 'kind'),
    qty: castAsInt(jsonbPathText(item.value, 'qty')),
  }), 'item')
  .toList();
// FROM "srf_boxes"
// INNER JOIN "srf_groups" AS "group" ON "srf_boxes"."group_id" = "group"."id"
// CROSS JOIN LATERAL jsonb_array_elements("srf_boxes"."items") AS "item"("value")
// WHERE "srf_boxes"."items" IS NOT NULL
```

- The function's argument may read navigations of the row; they are joined.
- A query nested in the projection (an entity subquery reading `set.value`) reads the set's columns as
  correlations, whatever the alias is called.
- The result is an ordinary select query: `where()` over its values, `orderBy()`, `count()` (it counts the
  multiplied rows), `groupBy()` (the joined rows are grouped), `asSubquery()` (a correlated subquery — the set's
  columns stay its own), `toList()`:

  ```typescript
  db.boxes
    .crossJoinLateral(b => jsonbArrayElements<BoxItem>(b.items), (b, item) => ({
      groupId: b.groupId,
      kind: jsonbPathText(item.value, 'kind'),
      qty: castAsInt(jsonbPathText(item.value, 'qty')),
    }), 'item')
    .groupBy(r => ({ groupId: r.groupId, kind: r.kind }))
    .select(g => ({ groupId: g.key.groupId, kind: g.key.kind, total: castAsInt(g.sum(r => r.qty)), lines: g.count() }))
  ```

- The alias is a plain identifier that may not name the query's table, one of its navigations, a joined table or
  CTE, or another lateral set.
- A query over a set-returning join cannot `update()` or `delete()`: filter the target rows with an `exists(...)`
  over a `fromSet(...)` subquery instead.
