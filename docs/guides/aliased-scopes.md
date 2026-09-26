# Aliased Subquery Scopes — `db.<table>.as(alias)`

A correlated subquery over tables under **explicit aliases**, turned into ONE expression: a scalar
`(SELECT …)`, `EXISTS (…)` or `(NOT EXISTS (…))`. It is the typed spelling of the hand-written
`EXISTS (SELECT 1 FROM "t" x WHERE x."col" = …)` fragments, and it goes wherever a fragment goes:
a projection, a WHERE, a CASE, an `UPDATE … SET`/`WHERE`, a row guard, a CTE body, the projection of a
LATERAL collection, another scope.

```typescript
import { and, eq, gt } from 'linkgress-orm';

const rows = await db.posts
  .select(p => ({
    title: p.title,
    // Does another post of the same author have more views? — a same-table correlation
    outranked: db.posts.as('rival')
      .where(r => and(eq(r.userId, p.userId), gt(r.views, p.views)))
      .exists(),
  }))
  .toList();
```

```sql
SELECT "posts"."title" as "title",
       EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE ("rival"."user_id" = "posts"."user_id" AND "rival"."views" > "posts"."views")) as "outranked"
FROM "posts"
```

## The API

```typescript
class DbEntityTable<T> {
  as(alias: string): AliasedScope<[ColumnRow<T>]>;
}

class AliasedScope<TRows extends readonly unknown[]> {
  readonly row: TRows[0];
  innerJoin(source: AliasedScope<[TRow]>, on: (...rows: [...TRows, TRow]) => Condition): AliasedScope<[...TRows, TRow]>;
  leftJoin(source: AliasedScope<[TRow]>, on: (...rows: [...TRows, TRow]) => Condition): AliasedScope<[...TRows, TRow]>;
  where(predicate: (...rows: TRows) => Condition): AliasedScope<TRows>;        // repeated calls AND
  orderBy(keys: (...rows: TRows) => ReadonlyArray<readonly [SqlOperand | Condition, 'ASC' | 'DESC']>): AliasedScope<TRows>;
  limit(count: number): AliasedScope<TRows>;
  scalar<T>(selection: (...rows: TRows) => SqlOperand<T>): SqlFragment<T>;
  exists(): SqlFragment<boolean>;
  notExists(): SqlFragment<boolean>;
}
```

### Rendering

| Terminal | SQL |
|---|---|
| `scalar(s)` | `(SELECT <s> FROM "<t0>" AS "<a0>"[ INNER\|LEFT JOIN "<ti>" AS "<ai>" ON <on>]*[ WHERE <where>][ ORDER BY <k> ASC\|DESC, …][ LIMIT <n>])` |
| `exists()` | `EXISTS (SELECT 1 FROM … [ WHERE <where>])` |
| `notExists()` | `(NOT EXISTS (SELECT 1 FROM … [ WHERE <where>]))` — parenthesized, so it stays one operand under `IS`, a comparison, `IN` or `BETWEEN` |

- The table follows `FROM` / `JOIN` directly: `"<table>"`, schema-qualified (`"auth"."users"`) only when the
  entity lives in a schema.
- `<where>` is the predicate's own SQL (an `and(...)` brings its parentheses); several `where()` calls are
  AND-combined. A **condition** ORDER BY key renders parenthesised (`("a"."kind" = $3) DESC`); the direction is
  always written. `LIMIT` is an inline integer.
- Everything renders with the **enclosing statement's** build context: parameters continue its numbering, in
  textual order (the selection, the joins' ON predicates, the WHERE, the ORDER BY); an outer column renders the
  way it renders anywhere in that statement — a LATERAL collection's item under its lateral alias, the column of
  an `UPDATE` under its table.

```typescript
db.posts.as('p2')
  .innerJoin(db.users.as('au'), (p, a) => eq(a.id, p.userId))
  .where((_p, a) => eq(a.isActive, literal(true)))
  .where(p => gt(p.views, 50))
  .orderBy((p, a) => [[eq(a.username, 'bob'), 'DESC'], [p.views, 'ASC']])
  .limit(1)
  .scalar(p => p.title);
// (SELECT "p2"."title" FROM "posts" AS "p2" INNER JOIN "users" AS "au" ON "au"."id" = "p2"."user_id"
//   WHERE ("au"."is_active" = TRUE AND "p2"."views" > $1) ORDER BY ("au"."username" = $2) DESC, "p2"."views" ASC LIMIT 1)
```

### Rows

A scope's rows are **column-only** (`ColumnRow<T>`): each column renders `"<alias>"."<column>"` and carries
its column's mapper and SQL type; reading a navigation throws. Whatever else a callback reads is an **outer
ref** — a column of the enclosing query.

The rows carry an identity of their own: an entity query nested in the scope (`exists(db.posts.where(p =>
eq(p.userId, s.id))…)`) reads a scope column as a correlation — also when the scope's alias equals one of that
query's navigations (`db.users.as('user')` inside a `db.posts` query that has a `user` navigation). By alias
name alone it used to be that query's own navigation, joined inside it and compared with itself.

### Join detection

The fragment's `getFieldRefs()` reports exactly the outer refs (a nested scope contributes its own outer refs,
already filtered), so the enclosing query joins the navigations those refs need:

```typescript
db.tasks.select(t => ({
  title: t.title,
  creatorAge: db.users.as('u2').where(u => eq(u.id, t.level!.createdBy!.id)).scalar(u => u.age),
}));
// FROM "tasks" … JOIN "task_levels" AS "level" ON … JOIN "users" AS "createdBy" ON …
// … (SELECT "u2"."age" FROM "users" AS "u2" WHERE "u2"."id" = "createdBy"."id") …
```

The scope's own aliases never reach the enclosing query.

### Validation

- Aliases are plain identifiers (letters, digits, `_`, `$`) of at most 63 bytes, unique within a scope.
- The joined scope of `innerJoin` / `leftJoin` is a bare table scope (`db.<table>.as(alias)`); write its filters
  in the ON predicate or in `where()`.
- **An outer ref whose alias is one of the scope's aliases is refused** when the scope is built: inside the scope
  that alias names the scope's own row, so the correlation would compare the row with itself — true for every
  row, no SQL error. Give the scope another alias:

```typescript
db.posts.select(p => ({ x: db.posts.as('posts').where(r => eq(r.userId, p.userId)).exists() }))
// throws: the alias "posts" is both one of the scope's own aliases and the alias of the column "posts"."user_id" …
```

### Immutability

Every method returns a **new** scope. One scope can feed two probes, or both legs of an `or()`:

```typescript
const authored = db.posts.as('p2');

db.users.where(u => or(
  authored.where(p => and(eq(p.userId, u.id), gt(p.views, 180))).exists(),
  authored.where(p => and(eq(p.userId, u.id), lt(p.views, 120))).exists(),
));
```

## How a scope reads back

| Terminal | Read |
|---|---|
| `scalar(s)` | through `s`'s mapper: a column's custom type (a timestamp column reads as its mapped type), a helper's driver-value read (`castAsInt(...)` → number, text stays text). A **column** without a custom type (of the scope's rows, or an outer ref) reads as a column of its SQL type (`withReadType(<its type>)`): a text column's `'0042'` stays `'0042'`, an integer column reads as a number. Any other selection without a mapper — a raw `sql` fragment — reads like any mapper-less expression: a numeric string becomes a number (`count(*)`'s int8 text → `2`), NULL reads as `undefined` at the top level and `null` inside a nested object or a collection item. Chain `.mapWith(...)` / `.withReadType(...)` to read it otherwise. A row or an object of columns (`scalar(r => r)`, `scalar(r => ({ … }))`) has no one SQL value and is refused. |
| `exists()` / `notExists()` | the driver's boolean; never NULL; no mapper |

When no row qualifies, a scalar is NULL (an aggregate over no rows gives its own value: `count(*)` is `0`).

## Where it fits

- **Correlated to the enclosing row** under a private alias: no borrowing or shadowing of an alias of the
  enclosing query (a `<table>_0` join counter, a navigation named like the table), so the same scope renders
  correctly inside a LATERAL collection, a CTE body, an `UPDATE`, a row guard, a QueryBatch leg.
- **Same-table correlations** that a standalone `db.<table>.where(...).asSubquery()` refuses (both sides would
  render under the table's name): the scope names its side apart.
- **Nested**: a scope inside another scope's WHERE or selection.

```typescript
// In an UPDATE: correlated to the updated row, its parameters numbered with the statement's
await db.users
  .where(u => and(gt(u.age, 20), db.posts.as('p2').where(p => and(eq(p.userId, u.id), gt(p.views, 120))).exists()))
  .update({ age: 99 });
// UPDATE "users" SET "age" = $1 WHERE ("users"."age" > $2 AND EXISTS (SELECT 1 FROM "posts" AS "p2"
//   WHERE ("p2"."user_id" = "users"."id" AND "p2"."views" > $3)))
```
