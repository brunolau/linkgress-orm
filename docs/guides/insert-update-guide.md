# Insert/Update/Upsert/BULK

This guide covers inserting, updating, and deleting data in Linkgress ORM.

## Overview
Linkgress ORM provides type-safe methods for modifying data in your database. All operations maintain full TypeScript type inference and support both single-record and bulk operations.

## Insert Operations

### Simple Insert

Insert a single record into a table:

```typescript
// Insert a new user (resolves to nothing)
await db.users.insert({
  username: 'alice',
  email: 'alice@example.com',
  isActive: true
});

// ...or read the inserted row back
const newUser = await db.users.insert({ username: 'alice', email: 'alice@example.com' }).returning();
console.log(newUser); // { id: 1, username: 'alice', email: 'alice@example.com', isActive: true, ... }
```

**Type Safety:**
- TypeScript validates that all required fields are provided
- Only valid columns can be specified
- Auto-generated fields (like `id`) are optional in insert

### Insert with Returning Specific Columns

`.returning(selector)` returns what the selector selects from the inserted row:

```typescript
const user = await db.users
  .insert({ username: 'bob', email: 'bob@example.com' })
  .returning(u => ({ id: u.id, username: u.username }));

console.log(user); // { id: 2, username: 'bob' }

// One value on its own
const id = await db.users.insert({ username: 'cy', email: 'cy@example.com' }).returning(u => u.id); // 3
```

### What `.returning(selector)` can select

Every mutation's `.returning(selector)` — `insert`, `insertBulk`, `upsert` / `upsertBulk`, `mergeBulk`,
`bulkUpdate`, `.where(...).update()` / `.delete()`, `update()` / `delete()` over every row, and both
sides of `insertWithChildren` / `insertBulkWithChildren` — reads the written rows the way a `select()`
reads rows:

```typescript
const rows = await db.loans
  .where(ln => eq(ln.memberId, memberId))
  .update({ note: 'renewed' })
  .returning(ln => ({
    id: ln.id,
    due: ln.dueAt,                                    // a column, under any key, through its mapper
    label: sql<string>`upper(${ln.note})`,            // an sql expression over the row
    book: sql<string>`lower(${ln.book!.name})`,       // ... or over a navigation (joined for it)
    overdue: lt(ln.dueAt, today),                     // a condition: a boolean
    source: 'renewal',                                // a literal: returned as it is
    meta: { by: 'batch', member: ln.member!.name },   // nested objects, any mix of the above
    loans: ln.member!.loans!.count(),                 // collections, as in a select()
  }));
```

- **A column** reads back through its own mapper whatever key it is returned under — and a value
  returned under a mapped column's NAME (an expression, another column, a literal) keeps its own value.
- **An `sql` expression** reading only the row's own columns renders in the mutation's own `RETURNING`
  list; one reading a navigation — or anything reading a navigation or a collection — makes the
  mutation run as a data-modifying CTE (`"__mutation__"`) the navigations are joined onto, as below.
  Its parameters are bound like any other; its `mapWith` applies.
- **A condition** (`eq`, `and`, …) reads back as a boolean; a subquery as its value.
- **A literal** (`'renewal'`, `42`, `true`, `null`, a `Date`, a list of values) is returned as it is —
  it is not read from the database. An `undefined` field is left out, as a `select()` leaves it out.
- **One value** instead of an object (`ln => ln.id`, `ln => sql\`…\``, `ln => ln.book!.name`,
  `m => m.loans!.count()`): a single-row `insert` returns that value, every other mutation the list of
  them.
- **Collections** read their items through their columns' mappers, as a `select()` reads them.
- An array of columns or expressions (`[ln.id, ln.note]`) has no single SQL value to return and is
  refused — select an object, or build the array in SQL.
- `mergeBulk` and `bulkUpdate` qualify the row's columns by their target alias (`t."note"`): a bare
  name is ambiguous or out of scope there.
- `.toStatement(selector)` (the compiled `UPDATE` / `DELETE` for `DbCteBuilder.withMutation`) takes an
  object of columns, expressions and literals — a literal binds as a parameter there, since SQL reads
  the statement's columns. A selector returning one value, or reading a navigation, is refused.

### Navigations in `.returning()`

The selector of `.returning()` on `insert`, `insertBulk`, `upsert`, `upsertBulk`, `mergeBulk` and on
both sides of `insertWithChildren` / `insertBulkWithChildren` can read navigations, as a `select()`
does. The statement is then wrapped in a `"__mutation__"` CTE and the navigations are joined onto the
rows it wrote — for an upsert or a merge, the rows as they are after the insert or the update, so a
navigation follows the keys the update set.

```typescript
const loan = await db.loans
  .insert({ memberId, editionId, bookId, note: 'reserved' })
  .returning(ln => ({
    id: ln.id,
    ownBook: ln.book!.name,                              // "book"."name"
    printedBook: ln.edition!.book!.name,                 // "edition__book"."name"
    printedCategory: ln.edition!.book!.category!.name,   // "category"."name", joined on "edition__book"
    edition: ln.edition!,                                // the edition's row, as an object of its columns
  }));
```

- Every hop is joined on its own parent, so a path can be any number of hops deep and its middle
  hops need not be projected. Two paths that end in the same relation name get a join each, under
  the aliases a query gives them: the shallowest path keeps the plain name, every other one renders
  as `<parentAlias>__<relation>` (see
  [Navigation Joins and Their Aliases](./querying.md#navigation-joins-and-their-aliases)). When every
  path is one hop deep, the statement is the one earlier versions rendered.
- Nested object literals work as in a `select()`, and so does a navigation row projected whole: it
  comes back as an object of its columns (all `null` when the navigation is `NULL`).
- A column read through a navigation goes through its own column mapper, however deep the path.
- A collection hanging off a navigation (`toList()`, `firstOrDefault()`, `count()`, `min()`, `max()`,
  `sum()`, `exists()`, `toNumberList()`, `toStringList()`) is rendered with the `lateral` strategy and
  follows the path it hangs off from the written row, also when another path owns the relation name —
  with `limit()` / `offset()` too, and with a nested collection in its `where` (`ed.loans.exists()`).
- A collection selecting one value (`b.editions!.select(e => e.label).toList()`) returns the values
  (`string[]`), as it does in a `select()`.
- A collection reads the tables as of the statement's start: it does not see rows the statement
  itself inserts (PostgreSQL gives every part of one statement the same snapshot).
- `mergeBulk` runs the MERGE … RETURNING itself in the CTE (PostgreSQL 17+, as any MERGE RETURNING).
- In `insertWithChildren` / `insertBulkWithChildren`, a child's navigation to the parent TABLE reads
  the parents inserted by the same statement together with the table's other rows — a child can
  point at a new parent through one key and at an existing row of the same table through another.
- Their parent selector: one of the parent's own columns rides the same statement; one reading a
  navigation, a collection, a nested object or an expression is read back by the parents' keys with
  a SELECT once the statement ran — so a parent's collection of children includes the new ones. The
  parents keep their input order.

  ```typescript
  const { parents, children } = await db.categories.insertBulkWithChildren({
    rows: [{ name: 'Drama' }, { name: 'Essays' }],
    children: {
      table: db.books,
      foreignKey: 'categoryId',
      rows: [{ parentIndex: 0, row: { name: 'Hamlet' } }, { parentIndex: 1, row: { name: 'Essais' } }],
    },
    returning: {
      parents: c => ({ id: c.id, titles: c.books!.select(b => b.name).toList() }),  // read back
      children: b => ({ id: b.id, category: b.category!.name }),                    // same statement
    },
  });
  ```

Refused before anything is written, with an error naming the paths involved: a path alias longer
than PostgreSQL's 63-byte identifier limit — a truncated alias could collide with another one. Read
one of the paths in a separate query, or shorten a relation name.

### Bulk Insert

Insert multiple records in a single operation:

```typescript
const users = await db.users.insertBulk([
  { username: 'alice', email: 'alice@example.com' },
  { username: 'bob', email: 'bob@example.com' },
  { username: 'charlie', email: 'charlie@example.com' }
]);

console.log(users.length); // 3
// Returns array of inserted records with generated IDs
```

**Performance:**
- Bulk insert uses a single `INSERT` statement
- Significantly faster than individual inserts
- All inserts are atomic (all succeed or all fail)

### Insert from a Query (`insertFrom`)

`insertFrom(source, map, options?)` inserts the rows of a table subquery — `INSERT … SELECT` — in ONE
statement: compute a value from the table's current rows and write it in the same snapshot, without a
read round trip in between.

```typescript
import { add, between, coalesce, lte } from 'linkgress-orm';

// the next number of a band: COALESCE(MAX(number), MIN) + gap — an aggregate without GROUP BY, one row
const next = db.badges
  .where(b => between(b.number, MIN, MAX))
  .select(b => ({ number: b.number }))
  .groupBy(() => ({}))
  .select(g => ({ next: add(coalesce(g.max(b => b.number), MIN), gap) }))
  .asSubquery('table');

const minted = await db.badges
  .insertFrom(next, src => ({ number: src.next, holderId, tier: 'gold', active: true }), {
    where: src => lte(src.next, MAX),        // band exhausted → no row, [] from returning()
    expectedErrorCodes: ['23505'],           // a concurrent twin took the number: the caller retries
  })
  .returning(b => ({ id: b.id, number: b.number }));
// INSERT INTO "badges" ("number", "holder_id", "tier", "active")
// SELECT "src"."next", CAST($6 AS integer), CAST($7 AS smallint), CAST($8 AS boolean)
// FROM (SELECT (COALESCE(MAX("badges"."number"), $4) + $5) as "next" FROM "badges" WHERE …) AS "src"
// WHERE "src"."next" <= $9
// RETURNING "id" AS "id", "number" AS "number"
```

- `map` receives the source row — `src.<column>` renders `"src"."<column>"` — and returns the values by
  column, in its key order: a source ref, an `sql` expression or helper (inline, its parameters in
  sequence), or a plain value, bound through the column's mapper and CAST to the column's type (an untyped
  parameter in a SELECT list would resolve as text). The cast never carries a typmod — a `char(n)` column
  casts to `bpchar`, a `bit(n)` one to `varbit` (the bare `char` / `bit` mean `(1)` and would truncate
  silently) — so the assignment pads, or raises 22001 for an over-long value, exactly like
  `INSERT … VALUES`. `null` inserts a typed NULL; `undefined` leaves the column out (its default applies). A
  key that is no column, or a source column the subquery does not project, is refused.
- Parameters number in build order: the source's, the SELECT list's, then `where`'s.
- `.returning()` / `.returning(selector)` read the inserted rows as `insertBulk` does; awaiting the builder
  itself resolves `undefined`. Zero source rows — or a `where` that holds for none — insert nothing.
- It runs on the context's executor, so inside `db.transaction()` it is part of the transaction.
- `expectedErrorCodes`: SQLSTATEs the statement is expected to fail with. Such a failure is still thrown,
  but the failed-query logger ([`logFailedQueries`](./configuration.md)) does not report it; any other
  failure is reported as always.

## Update Operations

Linkgress ORM uses a **fluent API** for update operations. You first specify the condition using `.where()`, then call `.update()` with the data.

### Simple Update

Update records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Update a single user (fluent API: where -> update)
await db.users
  .where(u => eq(u.id, 1))
  .update({
    email: 'alice.new@example.com',
    isActive: false
  });
```

### Update with Multiple Conditions

```typescript
import { eq, gt, and } from 'linkgress-orm';

// Update all users with id > 10 and isActive = true
await db.users
  .where(u => and(
    gt(u.id, 10),
    eq(u.isActive, true)
  ))
  .update({
    isActive: false
  });
```

### Update with Returning Values

Use `.returning()` to get back the updated records:

```typescript
// Update and return all columns
const updatedUsers = await db.users
  .where(u => eq(u.username, 'alice'))
  .update({ email: 'alice.updated@example.com' })
  .returning();

console.log(updatedUsers);
// [{ id: 1, username: 'alice', email: 'alice.updated@example.com', isActive: true, ... }]

// Update and return specific columns
const results = await db.users
  .where(u => eq(u.id, 1))
  .update({ age: 30 })
  .returning(u => ({ id: u.id, age: u.age }));

console.log(results);
// [{ id: 1, age: 30 }]

// Navigations, collections, expressions and conditions, as in an insert's RETURNING
const renamed = await db.users
  .where(u => eq(u.company!.name, 'Acme'))   // a WHERE through a navigation...
  .update({ isActive: true })
  .returning(u => ({
    id: u.id,
    company: u.company!.name,                  // ...next to a RETURNING through one
    posts: u.posts!.count(),
    shouted: sql<string>`upper(${u.username})`,
  }));
```

The selector gets the updated row's columns, navigations and collections — typed like an insert's
(`EntityQuery`), so conditions and collection aggregates type-check. See
[What `.returning(selector)` can select](#what-returningselector-can-select).

### The Row Before the Update: `old` (PostgreSQL 18)

The selector's second argument is PostgreSQL 18's `old` row — the row's own columns BEFORE the update
(for a DELETE, the deleted row). Read through each column's own mapper, as `row.<column>` is:

```typescript
const [task] = await db.tasks
  .where(t => eq(t.id, taskId))
  .update({ status: TaskStatus.Done })
  .returning((t, old) => ({
    id: t.id,
    status: t.status,
    previousStatus: old.status,            // did THIS call make the transition?
    changed: ne(t.status, old.status),     // old columns work inside expressions too
  }));
// UPDATE "tasks" SET "status" = $1 WHERE "tasks"."id" = $2
// RETURNING "id" AS "id", "status" AS "status", old."status" AS "previousStatus", ("status" != old."status") AS "changed"

const removed = await db.tasks.where(t => eq(t.id, taskId)).delete().returning((t, old) => ({ id: t.id, note: old.note }));
```

- `old` has the table's own columns only; a navigation of it throws.
- `old` cannot be combined with navigations, collections or nested objects in one RETURNING (that
  RETURNING runs the mutation as a CTE, where the old row is out of scope) — it throws; read the old
  values in a flat RETURNING of the row's own columns.
- It is typed as the table's column row (`ColumnRow<TEntity>`).

### Update with Affected Count

Use `.affectedCount()` to get the number of rows affected without returning the actual records:

```typescript
// Get the count of updated rows
const count = await db.users
  .where(u => eq(u.isActive, true))
  .update({ lastLogin: new Date() })
  .affectedCount();

console.log(`Updated ${count} users`);
// Updated 42 users

// Update all records and get count
const totalUpdated = await db.users
  .update({ isActive: false })
  .affectedCount();

console.log(`Deactivated ${totalUpdated} users`);
```

**When to use:**
- When you only need to know how many rows were affected
- More efficient than `.returning()` when you don't need the actual data
- Useful for logging, metrics, or conditional logic based on affected count

## Upsert Operations

Upsert (INSERT ... ON CONFLICT) inserts a record or updates it if it already exists.

### Simple Upsert

```typescript
// Upsert on a unique key (e.g., username)
await db.users.upsert(
  [{ username: 'alice', email: 'alice@example.com', isActive: true }],
  {
    primaryKey: 'username',                // The conflict target (the table's primary key by default)
    updateColumns: ['email', 'isActive'],  // Columns to update on conflict (every other one by default)
  }
);

// If user 'alice' exists: updates email and isActive
// If user 'alice' doesn't exist: inserts new record
```

### Upsert with Custom Update Logic

```typescript
// Increment on conflict: the SET expression reads the existing row and the proposed one
await db.users.upsertBulk(
  [{ username: 'bob', email: 'bob@example.com', loginCount: 1 }],
  {
    primaryKey: 'username',
    updateSet: (existing, excluded) => ({ loginCount: add(existing.loginCount, excluded.loginCount) }),
  }
);
```

See [Upsert with SET Expressions](#upsert-with-set-expressions-updateset--updatewhere) for the full form.

### The `values()` Builder: `onConflict()` / `doUpdate()` / `doNothing()`

```typescript
const rows = await db.users
  .values([{ username: 'alice', email: 'alice@example.com', age: 30 }])
  .onConflict(['username'])                 // or { constraint: 'users_username_key' }
  .doUpdate({
    set: {
      email: 'renamed@example.com',         // a value — through the column's mapper
      age: sql<number>`"users"."age" + EXCLUDED."age"`,   // an sql expression: EXCLUDED is the proposed row
    },
    where: '"users"."is_active"',           // the DO UPDATE's condition, as SQL
  })
  .execute();                               // the written rows, read as entities
```

- `doUpdate()` with no options updates every inserted non-key column to the proposed row's value.
- `doUpdate({ updateColumns: ['email'] })` updates exactly those columns to the proposed row's values.
- `doUpdate({ set })` updates exactly its columns to its values (a column the insert does not carry
  too). A key that is no column is refused. (`set` used to name the columns only — they took the
  INSERTED values and the given ones were dropped.)
- `doNothing()` leaves a conflicting row alone (it is not returned).

### Bulk Upsert

Insert or update multiple records:

```typescript
const users = await db.users.upsertBulk(
  [
    { username: 'alice', email: 'alice@example.com' },
    { username: 'bob', email: 'bob@example.com' },
    { username: 'charlie', email: 'charlie@example.com' }
  ],
  {
    primaryKey: 'username',
    updateColumns: ['email']
  }
).returning();

console.log(`Upserted ${users.length} users`);
// Efficiently handles all records in a single operation
```

**Use Cases:**
- Syncing data from external sources
- Implementing "save or update" logic
- Handling duplicate key scenarios gracefully
- Bulk data imports with conflict resolution

### Upsert with SQL Expression Values

Upsert values may be [magic SQL strings](querying.md#magic-sql-strings) (`SqlFragment`),
not just literals. The fragment renders as a SQL expression inside the `VALUES` tuple —
e.g. a scalar subquery computed by the INSERT itself. On conflict the computed value
flows into the `DO UPDATE` arm via `EXCLUDED."col"`, so a read-fold-write cycle
(aggregate something, then persist the result) is a **single round trip**:

```typescript
import { sql } from 'linkgress-orm';

// Recompute a user's post-view total and upsert the accumulator row — one statement.
const rows = await db.userStats.upsertBulk(
  [
    {
      userId,
      totalViews: sql<number>`(
        SELECT COALESCE(SUM("views"), 0)::int
        FROM "posts"
        WHERE "user_id" = ${userId}
      )`,
      updatedAt: new Date(),
    },
  ],
  {
    primaryKey: 'userId',
    updateColumns: ['totalViews', 'updatedAt'],
  }
).returning(s => ({ totalViews: s.totalViews }));
```

Rules of the road:

- Fragments must be **self-contained SQL** — they render inside a `VALUES` tuple where
  no table alias is in scope, so entity column references are not resolvable there.
- Interpolated values bind as ordinary parameters (numbering stays consistent across
  mixed rows of fragment and plain values).
- Fragment values bypass the column's type mapper — the fragment IS the SQL.
- An aggregate-only scalar subquery always yields exactly one row, so the INSERT arm
  still materializes when the source has zero rows (`SUM → NULL → COALESCE(…, 0)`).
- The same holds for every write that takes row values: `insert`, `insertBulk`, `upsert`,
  `mergeBulk`, `values(…).execute()`, the rows of `insertWithChildren` / `insertBulkWithChildren`
  and the cells of `bulkUpdate` (where the fragment is cast to its column's type, as the plain
  cells are). A fragment used to be bound AS a parameter on several of these paths.
- PostgreSQL types each parameter from its context: `sql\`${a} + ${b}\`` with two plain values is
  `unknown + unknown` ("operator is not unique") — cast one of them (`sql\`${a}::int + ${b}\``).

### Upsert with SET Expressions (`updateSet` / `updateWhere`)

The conflict arm can compute each column from the row that is already there (`existing`) and
the row proposed for insertion (`excluded`) — accumulate, keep the first non-null value, only
accept a newer version — in the same single statement:

```typescript
import { add, coalesce, lt } from 'linkgress-orm';

await db.counters.upsertBulk(rows, {
  primaryKey: 'key',
  updateSet: (existing, excluded) => ({
    hits: add(existing.hits, excluded.hits),                  // accumulate
    firstSeen: coalesce(existing.firstSeen, excluded.firstSeen), // keep the first non-null
    note: 'merged',                                           // plain values bind through the column mapper
  }),
  updateWhere: (existing, excluded) => lt(existing.version, excluded.version),
});
// INSERT … ON CONFLICT ("key") DO UPDATE
//   SET "hits" = ("counters"."hits" + "excluded"."hits"), …
//   WHERE "counters"."version" < "excluded"."version"
```

- With `updateSet` alone, ONLY the columns it names are updated. Combined with
  `updateColumns` / `updateColumnFilter`, the listed columns keep `= EXCLUDED."col"` and the
  named ones take their expression (an expression wins over a list entry for the same column).
- `updateWhere` is ANDed with a raw `setWhere` when both are given.
- Values may be any [SQL expression helper](./sql-expressions.md), a `sql` fragment, a column of
  either row, a condition (as a boolean) or a plain value. Navigations are not in scope in an
  INSERT and throw.
- `MutationBatch.addUpsertBulk` accepts the same `updateSet` / `updateWhere`.

### Upsert onto a Partial Unique Index (`targetWhere`)

A PARTIAL unique index (`UNIQUE (owner_ref, slot) WHERE is_current = true`) is the conflict target only
when the `ON CONFLICT` names its predicate: `targetWhere` must IMPLY the index's predicate (equal or
stronger), or PostgreSQL raises 42P10 ("there is no unique or exclusion constraint matching the ON
CONFLICT specification").

```typescript
await db.links.upsertBulk(rows, {
  primaryKey: ['ownerRef', 'slot'],
  targetWhere: e => eq(e.isCurrent, literal(true)),
  updateColumns: ['note'],
});
// … ON CONFLICT ("owner_ref", "slot") WHERE "is_current" = TRUE DO UPDATE SET "note" = EXCLUDED."note"

await db.identities.upsertBulk(rows, {
  primaryKey: ['provider', 'subject'],
  targetWhere: e => and(eq(e.active, literal(true)), isNotNull(e.subject)),
  updateColumnFilter: () => false,          // DO NOTHING
});
// … ON CONFLICT ("provider", "subject") WHERE ("active" = TRUE AND "subject" IS NOT NULL) DO NOTHING
```

- The typed predicate receives the row's columns UNQUALIFIED (the table is the only relation in scope
  there); navigations throw.
- It must not bind anything — write constants with `literal()`. PostgreSQL infers the arbiter index at
  PLAN time; a bound `$n` is no constant in a generic plan (a prepared statement after its fifth
  execution), where the statement would then fail with 42P10. A predicate that binds a value or a
  placeholder throws before anything runs.
- SQL text keeps working (`targetWhere: 'is_current = true'`), unchecked.
- The same option: `values(…).onConflict(…).targetWhere(…)` and `MutationBatch.addUpsertBulk`'s config.
- The in-memory database infers the arbiter as PostgreSQL does for the usual spellings — `literal(v)` and
  `literal(v, pgType)`, `isNotNull(x)` and `not(isNull(x))`, a strict call such as `lower(x)` for an
  `x IS NOT NULL` predicate — so a wrong `targetWhere` fails there too (42P10). It proves less than the
  server in a few documented forms (OR, range proofs, general constant folding; see
  [In-Memory Database](./in-memory-database.md)): there a RIGHT predicate can fail in memory, never the
  reverse.

## Row-Guarded Inserts in a `MutationBatch` (`rowGuard`)

`MutationBatch.addInsertBulk(table, rows, id, { rowGuard })` writes each candidate row only when a
per-row predicate holds for it — the batch's leg becomes

```sql
INSERT INTO "t" (<cols>)
SELECT v."c1", … FROM (VALUES <cells>) AS v(<cols>)
WHERE <guard>
```

and the rows it blocked show up as a short `getAffectedCount(key)`. The guard is a typed condition over
the candidate row `v` (its refs render `"v"."<column>"`), or raw SQL over `v."<column>"`:

```typescript
const batch = new MutationBatch();
const key = batch.addInsertBulk(db.redemptions, rows, 'redemptions', {
  // insert a candidate only while its holder has no active grant for the code
  rowGuard: v => notExists(
    db.grants
      .where(g => and(eq(g.codeId, v.codeId), eq(g.holderId, v.holderId), eq(g.active, literal(true))))
      .select(() => ({ one: literal(1) }))
      .asSubquery()
  ),
});
await batch.executeBatch();
if (batch.getAffectedCount(key!) !== rows.length) { /* some candidates were refused */ }
```

- A typed guard may bind parameters: they continue the leg's VALUES numbering, and the batch renumbers
  them with the rest of the leg. Every `v.<column>` it reads must be a column some row provides (it
  throws otherwise), and navigations of `v` are not in scope. `v` is typed as the table's column row.
- A raw guard takes no parameters of its own (a bare `$N` throws); blank guards throw.
- The guard judges the rows committed before the statement (PostgreSQL snapshot rules): it cannot see
  the leg's own rows, and it is not a cross-transaction arbiter — serialize concurrent writers first
  (an advisory lock, a row lock).
- Not combinable with `onConflictDoNothing` / `overridingSystemValue`.

## Bulk Update with SET Expressions (`set` / `where`)

`bulkUpdate` matches rows by key and, by default, assigns each provided column
(`CASE WHEN v."col__provided" THEN v."col" ELSE t."col" END`). `set` replaces that assignment
with an expression over the row being updated (`target`, alias `t`) and the incoming values row
(`values`, alias `v`); `where` adds a guard to the key match:

```typescript
await db.tasks.bulkUpdate(changes, {
  set: (target, values) => ({
    label: coalesce(target.label, values.label),   // fill only where empty
    revision: add(target.revision, 1),              // a column no row provides
  }),
  where: (target) => eq(target.status, TaskStatus.Planned),
});
// UPDATE "tasks" AS t SET …, "label" = COALESCE("t"."label", "v"."label"), "revision" = ("t"."revision" + $n)
// FROM (VALUES …) AS v(…) WHERE t."id" = v."id" AND ("t"."status" = $m)
```

- Rows may carry only the key when `set` assigns everything.
- Reading `values.col` that no row provides, or assigning a match-key column, throws before
  anything is sent.
- `MutationBatch.addBulkUpdate` accepts the same `set` / `where`.

## Delete Operations

Linkgress ORM uses a **fluent API** for delete operations. You first specify the condition using `.where()`, then call `.delete()`.

### Simple Delete

Delete records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Delete a specific user (fluent API: where -> delete)
await db.users
  .where(u => eq(u.id, 1))
  .delete();
```

### Delete with Multiple Conditions

```typescript
import { and, lt, eq } from 'linkgress-orm';

// Delete inactive users with id < 100
await db.users
  .where(u => and(
    eq(u.isActive, false),
    lt(u.id, 100)
  ))
  .delete();
```

### Delete with Returning Values

Use `.returning()` to get back the deleted records:

```typescript
// Delete and return all columns
const deletedUsers = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .returning();

console.log(deletedUsers);
// Array of deleted user records with all columns

// Delete and return specific columns
const deletedIds = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .returning(u => ({ id: u.id, username: u.username }));

console.log(deletedIds);
// [{ id: 5, username: 'inactive_user' }, ...]
```

### Delete with Affected Count

Use `.affectedCount()` to get the number of rows deleted without returning the actual records:

```typescript
// Get the count of deleted rows
const count = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .affectedCount();

console.log(`Deleted ${count} inactive users`);
// Deleted 15 inactive users

// Delete all records and get count
const totalDeleted = await db.users
  .delete()
  .affectedCount();

console.log(`Deleted ${totalDeleted} users from table`);
```

**When to use:**
- When you only need to know how many rows were deleted
- More efficient than `.returning()` when you don't need the actual data
- Useful for logging, cleanup operations, or conditional logic

### Delete All Records

```typescript
// ⚠️ Warning: Deletes all records in the table
// Use with extreme caution!
await db.users.delete();
```

`db.table.update(data)` and `db.table.delete()` without a `where()` are the query update / delete over
a condition every row meets (`WHERE TRUE`): the same column mappers and `sql` values in `SET`, the same
`.returning(selector)` (navigations, collections, expressions — see
[What `.returning(selector)` can select](#what-returningselector-can-select)), `.affectedCount()` and
`.toStatement()`. The update-all used to bind its values without their column mappers and to read a
navigation in its RETURNING as the root table's column of the same name.

## Type Safety

All CRUD operations maintain full TypeScript type inference:

```typescript
// ✓ Type-safe: TypeScript knows all valid columns
await db.users.insert({
  username: 'alice',
  email: 'alice@example.com'
});

// ✗ Compile error: 'invalid' is not a valid column
await db.users.insert({
  username: 'alice',
  invalid: 'field'  // TypeScript error
});

// ✓ Type-safe: Update validates column types
await db.users.where(u => eq(u.id, 1)).update({
  email: 'new@example.com'  // Must be string
});

// ✗ Compile error: email must be string
await db.users.where(u => eq(u.id, 1)).update({
  email: 123  // TypeScript error
});
```

## Transactions

All CRUD operations can be wrapped in transactions for atomicity:

```typescript
await db.transaction(async (tx) => {
  // Insert user
  const user = await tx.users.insert({
    username: 'alice',
    email: 'alice@example.com'
  });

  // Insert related posts
  await tx.posts.insertBulk([
    { userId: user.id, title: 'First Post', content: 'Hello World' },
    { userId: user.id, title: 'Second Post', content: 'More content' }
  ]);

  // If any operation fails, all changes are rolled back
});
```

### Advisory Locks

Transaction-scoped advisory locks serialize concurrent units of work on a key that is not a
row — an order being settled, an import per partner — without a lock table. They are released
automatically at COMMIT / ROLLBACK:

```typescript
await db.transaction(async (tx) => {
  await tx.advisoryXactLock(LockClass.Invoice, invoiceId);   // wait for the lock
  // … check-then-write safely against every other holder of this lock
});

const got = await db.transaction(tx => tx.tryAdvisoryXactLock('import:partner-7')); // no waiting

await db.transaction(async (tx) => {
  await tx.advisoryXactLockAll(LockClass.Order, orderIds);   // many keys, one statement, fixed order
});
```

- Keys: one integer (int8 range), a `(classId, key)` pair (int4 each), or a string hashed with
  `hashtext()`. The pair form keeps unrelated lock families apart.
- The form follows the number of arguments passed: `(classId, key)` is always a pair, and a pair
  whose key is `null`, `undefined` or not an integer / string throws — it can never become a
  different lock (`(classId, null)` used to lock key 0, `(classId, undefined)` the single key
  `classId`).
- `tryAdvisoryXactLock` returns `true` when this transaction holds the lock (advisory locks are
  re-entrant) and `false` when another session holds it.
- `advisoryXactLockAll` deduplicates and sorts the keys (all integers or all strings), so two
  transactions locking overlapping sets cannot deadlock on each other. The order is an SQL
  guarantee: `SELECT pg_advisory_xact_lock($1, t.k) FROM unnest(CAST($2 AS integer[])) WITH
  ORDINALITY AS t(k, ord) ORDER BY t.ord` (strings: `hashtext(t.k)` over `text[]`).
- All three must be called on the context `db.transaction()` hands you: outside a transaction
  the lock would end with the statement, so they throw instead.

## Performance Tips

### Bulk Operations

Always prefer bulk operations when working with multiple records:

```typescript
// ❌ Slow: Multiple round trips
for (const user of users) {
  await db.users.insert(user);
}

// ✅ Fast: Single round trip
await db.users.insertBulk(users);
```

### Batch Size

For very large datasets, process in batches:

```typescript
const batchSize = 1000;
const users = [...]; // Large array of users

for (let i = 0; i < users.length; i += batchSize) {
  const batch = users.slice(i, i + batchSize);
  await db.users.insertBulk(batch);
}
```

### Use Upsert for Idempotent Operations

Upsert is safer than insert when re-running operations:

```typescript
// ❌ May fail on duplicate key
await db.users.insert({ username: 'alice', email: 'alice@example.com' });

// ✅ Safe: Updates if exists, inserts if not
await db.users.upsert(
  { username: 'alice', email: 'alice@example.com' },
  { conflictTarget: ['username'], update: ['email'] }
);
```

## Examples

### User Registration

```typescript
async function registerUser(username: string, email: string, password: string) {
  try {
    const user = await db.users.insert({
      username,
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
      isActive: true
    });

    return { success: true, user };
  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return { success: false, error: 'Username already exists' };
    }
    throw error;
  }
}
```

### Bulk Data Import

```typescript
async function importUsers(csvData: any[]) {
  const users = csvData.map(row => ({
    username: row.username,
    email: row.email,
    isActive: true
  }));

  // Use upsert to handle duplicates
  const result = await db.users.upsertMany(
    users,
    {
      conflictTarget: ['username'],
      update: ['email']
    }
  );

  return {
    imported: result.length,
    timestamp: new Date()
  };
}
```

### Update User Profile

```typescript
async function updateUserProfile(userId: number, updates: Partial<User>) {
  const updatedUsers = await db.users
    .where(u => eq(u.id, userId))
    .updateReturning({
      ...updates,
      updatedAt: new Date()
    });

  if (updatedUsers.length === 0) {
    throw new Error('User not found');
  }

  return updatedUsers[0];
}
```

### Soft Delete

```typescript
async function softDeleteUser(userId: number) {
  const deleted = await db.users
    .where(u => eq(u.id, userId))
    .update({
      isActive: false,
      deletedAt: new Date()
    });

  return deleted > 0;
}

// Later, permanently delete soft-deleted users
async function permanentlyDeleteInactiveUsers(daysOld: number) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  return await db.users
    .where(u => and(
      eq(u.isActive, false),
      lt(u.deletedAt, cutoffDate)
    ))
    .delete();
}
```

## API Reference

### Insert Methods

```typescript
// Insert single record (returns void by default)
insert(data: Partial<TEntity>): FluentInsert<TEntity>

// Insert with returning
insert(data: Partial<TEntity>).returning(): Promise<TEntity>
insert(data: Partial<TEntity>).returning(selector): Promise<Partial<TEntity>>

// Insert multiple records
insertBulk(data: Partial<TEntity>[]): FluentInsertMany<TEntity>
```

### Update Methods (Fluent API)

```typescript
// Fluent update: where -> update -> optional returning/affectedCount
db.table
  .where(condition)
  .update(data: Partial<TEntity>): FluentQueryUpdate<TEntity>

// With returning
db.table
  .where(condition)
  .update(data)
  .returning(): Promise<TEntity[]>

db.table
  .where(condition)
  .update(data)
  .returning(selector): Promise<Partial<TEntity>[]>

// With affected count
db.table
  .where(condition)
  .update(data)
  .affectedCount(): Promise<number>
```

### Upsert Methods

```typescript
// Upsert multiple records
upsertBulk(
  data: Partial<TEntity>[],
  options: {
    primaryKey: string[];
    updateColumns: string[];
  }
): FluentUpsert<TEntity>

// With returning
upsertBulk(data, options).returning(): Promise<TEntity[]>
upsertBulk(data, options).returning(selector): Promise<Partial<TEntity>[]>
```

### Delete Methods (Fluent API)

```typescript
// Fluent delete: where -> delete -> optional returning/affectedCount
db.table
  .where(condition)
  .delete(): FluentDelete<TEntity>

// With returning
db.table
  .where(condition)
  .delete()
  .returning(): Promise<TEntity[]>

db.table
  .where(condition)
  .delete()
  .returning(selector): Promise<Partial<TEntity>[]>

// With affected count
db.table
  .where(condition)
  .delete()
  .affectedCount(): Promise<number>

// Delete all (dangerous!)
db.table.delete(): FluentDelete<TEntity>
db.table.delete().affectedCount(): Promise<number>
```

## See Also

- [Schema Configuration](./schema-configuration.md) - Define entities and relationships
- [Getting Started](../getting-started.md) - Basic usage examples
- [Collection Strategies](../collection-strategies.md) - Querying related data

## License

MIT
