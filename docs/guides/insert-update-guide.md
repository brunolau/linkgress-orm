# Inserts, Updates, Upserts and Deletes

> **For agents:** Which write API changes the rows you need in the fewest statements, and what SQL does each one send?
> **Use this page when:** inserting, upserting, merging, updating or deleting rows; reading back generated keys or the written rows; replacing a per-row loop with one set-based statement; making several writes atomic. **Look elsewhere when:** reading rows → [Querying](./querying.md); data-modifying CTEs in depth → [CTE Guide](./cte-guide.md); unique indexes, partial indexes and sequences → [Schema Configuration](./schema-configuration.md)
> **Key APIs:** `insert` · `insertBulk` · `insertFrom` · `fromRows` · `upsertBulk` · `mergeBulk` · `where().update()` · `bulkUpdate` · `where().delete()` · `.returning()` · `.affectedCount()` · `insertWithChildren` · `MutationBatch` · `toStatement()` · `db.transaction()` · **Round trips:** 1 per statement; `insertBulk`, `upsertBulk`, `mergeBulk` and `bulkUpdate` send 1 statement per chunk (a chunk is `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows: 39 321 for one column); `insertFrom(fromRows(…))` and a `MutationBatch` are 1 for any row count; `db.transaction()` adds BEGIN and COMMIT

The examples use the test model `AppDatabase` ([Example Model and Seed Data](../example-model.md)), seeded with the
users `alice`, `bob` and `charlie` and their posts, orders and tasks. Three features need a table the test model lacks:
the partial unique index examples use a `leases` table and the sequence examples an `invoices` table, both defined where
they are used, and the array-column examples the `books` table of
[SQL Expression Helpers](./sql-expressions.md#query-array-columns).
Each SQL block is what its example sent, captured on the in-memory PostgreSQL-compatible database; one statement is
one round trip. Result comments show the captured run's values: generated ids depend on the statements that ran
before.

## Contents

- [Choose a write](#choose-a-write)
- [How a write runs: lazy builders and what `await` returns](#how-a-write-runs-lazy-builders-and-what-await-returns)
- [Insert one row: `insert()`](#insert-one-row-insert)
- [Insert many rows in one statement: `insertBulk()`](#insert-many-rows-in-one-statement-insertbulk)
- [Insert a large or variable-size set in one fixed statement: `fromRows()`](#insert-a-large-or-variable-size-set-in-one-fixed-statement-fromrows)
- [Insert the rows that are new and skip the rest](#insert-the-rows-that-are-new-and-skip-the-rest)
- [Insert rows computed from the database: `insertFrom()`](#insert-rows-computed-from-the-database-insertfrom)
- [Insert or update by a unique key: `upsertBulk()`](#insert-or-update-by-a-unique-key-upsertbulk)
- [Insert or update without a unique index: `mergeBulk()`](#insert-or-update-without-a-unique-index-mergebulk)
- [Update the rows that match a condition: `where().update()`](#update-the-rows-that-match-a-condition-whereupdate)
- [Update many rows, each with its own values: `bulkUpdate()`](#update-many-rows-each-with-its-own-values-bulkupdate)
- [Delete rows: `where().delete()`](#delete-rows-wheredelete)
- [Read back what a write changed: `.returning(selector)`](#read-back-what-a-write-changed-returningselector)
- [Insert a parent and its children in one statement: `insertWithChildren()`](#insert-a-parent-and-its-children-in-one-statement-insertwithchildren)
- [Run independent writes in one round trip: `MutationBatch`](#run-independent-writes-in-one-round-trip-mutationbatch)
- [Feed one write into another in one statement: data-modifying CTEs](#feed-one-write-into-another-in-one-statement-data-modifying-ctes)
- [Number many rows from a sequence in one statement](#number-many-rows-from-a-sequence-in-one-statement)
- [Make several statements atomic: `db.transaction()`](#make-several-statements-atomic-dbtransaction)
- [Keep the statement text stable](#keep-the-statement-text-stable)
- [What the typings check](#what-the-typings-check)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose a write

Find the row that matches the data you hold and the result you need. The **Avoid** column is the slower or unsafe
pattern the **Use** column replaces; the linked sections show the SQL of both where it applies.

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| One row | [`insert(row)`](#insert-one-row-insert) | `INSERT … VALUES (…)` · 1 | — |
| One row and its generated id | [`insert(row).returning(r => ({ id: r.id }))`](#insert-one-row-insert) | `INSERT … RETURNING "id" AS "id"` · 1 | a `SELECT` after the insert (2) |
| Many rows built in JS | [`insertBulk(rows)`](#insert-many-rows-in-one-statement-insertbulk) | `INSERT INTO "tags" ("name") VALUES ($1), ($2), ($3)` · 1 per chunk | `await insert()` in a loop (n) |
| Generated keys of many rows | [`insertBulk(rows).returning(r => ({ id: r.id, username: r.username }))`](#insert-many-rows-in-one-statement-insertbulk) | `… RETURNING "id" AS "id", "username" AS "username"` · 1 per chunk | `insert().returning()` per row (n) |
| A large or variable-size set as one fixed statement | [`insertFrom(fromRows(table, rows, { columns }).asSubquery('table'), map)`](#insert-a-large-or-variable-size-set-in-one-fixed-statement-fromrows) (since 1.0.29) | `INSERT … SELECT … FROM unnest(CAST($1 AS varchar[]), …)` · 1, one parameter per column | `insertBulk` of 70 000 rows: 2 statements, 70 000 parameters |
| Insert-or-skip on any unique index | [`insertBulk(rows, { onConflictDoNothing: true })`](#insert-the-rows-that-are-new-and-skip-the-rest) | `… ON CONFLICT DO NOTHING` · 1 | `exists()` then `insert()` (2 per row, racy) |
| Insert-or-skip on one key (or a partial index) | [`upsertBulk(rows, { primaryKey, updateColumnFilter: () => false })`](#insert-the-rows-that-are-new-and-skip-the-rest) | `… ON CONFLICT ("username") DO NOTHING` · 1 | the same check-then-insert loop |
| Insert or update by a unique key | [`upsertBulk(rows, { primaryKey, updateColumns })`](#insert-or-update-by-a-unique-key-upsertbulk) | `… ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email"` · 1 per chunk | read, then update or insert (2 per row, racy) |
| Insert, or update only when a condition holds; computed assignments | [`upsertBulk(rows, { primaryKey, updateWhere: (existing, excluded) => …, updateSet: (existing, excluded) => ({ … }) })`](#compute-the-update-from-the-stored-and-the-proposed-row-updateset--updatewhere) | `… DO UPDATE SET … WHERE "product_tags"."sort_order" < "excluded"."sort_order"` · 1 per chunk | read, compare in JS, then write (2 per row, racy) |
| Upsert onto a partial unique index | [`upsertBulk(rows, { primaryKey, targetWhere: e => eq(e.isCurrent, literal(true)) })`](#upsert-onto-a-partial-unique-index-targetwhere) | `ON CONFLICT ("unit_id") WHERE "is_current" = TRUE DO UPDATE …` · 1 per chunk | no `targetWhere` (42P10) |
| A conflict on a constraint name, or explicit SET values | [`values(rows).onConflict({ constraint }).doUpdate({ set, where })`](#conflict-on-a-constraint-name-or-set-explicit-values-values) | `ON CONFLICT ON CONSTRAINT users_username_key DO UPDATE SET …` · 1 | `values()` where `upsertBulk()` fits (no chunking, every column returned) |
| Insert or update without a unique index | [`mergeBulk(rows, { on })`](#insert-or-update-without-a-unique-index-mergebulk) (PostgreSQL 15+) | `MERGE INTO … AS t USING (VALUES …) AS s … WHEN MATCHED … WHEN NOT MATCHED …` · 1 per chunk | `mergeBulk` under concurrent writers of the same keys |
| Rows computed from data in the database | [`insertFrom(subquery, map)`](#insert-rows-computed-from-the-database-insertfrom) | `INSERT … SELECT … FROM (…) AS "src"` · 1 | read, compute in JS, insert (2, racy) |
| The same change to every matching row | [`where(cond).update(values)`](#update-the-rows-that-match-a-condition-whereupdate) | `UPDATE … SET … WHERE …` · 1 | `where(id).update()` per id (n) |
| Update or delete by a list of ids | [`where(r => eqAny(r.id, ids))`](#update-the-rows-that-match-a-condition-whereupdate) then `.update()` / `.delete()` | `WHERE ("users"."id" = ANY($2::integer[]))` · 1, one text for any list length | `inArray` with varying lengths (one placeholder per element) |
| Add one value to (or remove one from) an array column, in place | [`update(b => ({ tags: arrayAppendUnique(b.tags, v) }))` / `arrayRemove(b.tags, v)`](#add-or-remove-one-value-of-an-array-column-arrayappendunique-arrayremove-since-1031) (since 1.0.31) | `SET "tags" = (CASE WHEN CAST($1 AS text) = ANY("books"."tags") THEN "books"."tags" ELSE array_append(…) END)` · 1 | read the array, change it in JS, write it back (2, racy) |
| Each row its own values, matched by key | [`bulkUpdate(rows)`](#update-many-rows-each-with-its-own-values-bulkupdate) | `UPDATE "users" AS t SET … FROM (VALUES …) AS v(…) WHERE t."id" = v."id"` · 1 per chunk | `where(id).update()` per row (n) |
| Delete by a condition | [`where(cond).delete()`](#delete-rows-wheredelete) | `DELETE FROM … WHERE …` · 1 | a delete per id (n) |
| The rows a write changed | [`.returning(selector)`](#read-back-what-a-write-changed-returningselector) | `… RETURNING …`; a navigation or collection: `WITH "__mutation__" AS (…) SELECT …` · 1 | a `SELECT` after the write |
| How many rows changed | [`.affectedCount()`](#update-the-rows-that-match-a-condition-whereupdate) (update, delete) | no RETURNING; the row count · 1 | `.returning()` and `.length` |
| The value a row had before the update | [`.returning((row, old) => …)`](#read-the-row-as-it-was-before-the-update-old-postgresql-18) (PostgreSQL 18) | `RETURNING … old."status" AS "previous"` · 1 | `SELECT … FOR UPDATE`, then `UPDATE` (2) |
| A parent and children that need its key | [`insertWithChildren()` / `insertBulkWithChildren()`](#insert-a-parent-and-its-children-in-one-statement-insertwithchildren) | `WITH "__iwc_parent__" AS (INSERT … RETURNING *), "__mutation__" AS (INSERT INTO "posts" … SELECT p."id", … ) SELECT …` · 1 | insert the parent, read its id, insert the children (2, not atomic) |
| Several independent writes in one round trip | [`MutationBatch`](#run-independent-writes-in-one-round-trip-mutationbatch) | `WITH "__mb_0" AS (…), "__mb_1" AS (…) SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", …` · 1, atomic | sequential awaits (n round trips, n commits) |
| A write whose RETURNING feeds a read or another write | [`toStatement()` + `DbCteBuilder.withMutation()`](#feed-one-write-into-another-in-one-statement-data-modifying-ctes) | `WITH "claimed" AS (UPDATE … RETURNING …) SELECT …` · 1 | 2 or more statements with a race between them |
| Sequence numbers for many rows | [``sql`nextval('seq')` `` as a value of `insertBulk` / `insertFrom`](#number-many-rows-from-a-sequence-in-one-statement) | `VALUES ((nextval('invoice_number_seq')), $1), …` · 1 | `nextValue()` per row, then the insert (n + 1) |
| Several dependent statements, all or nothing | [`db.transaction(async tx => …)`](#make-several-statements-atomic-dbtransaction) with `tx.<table>` | the statements, plus BEGIN and COMMIT | `db.<table>` inside the callback (another connection) |

Rules for every write:

1. Await (or return) every write builder. Nothing is sent before that, and a second `await` sends the statement again.
2. Write a set in one statement. A loop of awaited writes costs one round trip per row and commits each row on its own.
3. Read back in the same statement with `.returning(selector)`, count with `.affectedCount()`. A bare `await` resolves
   `undefined`.
4. Let a unique index decide races (`onConflictDoNothing`, `upsertBulk`). A check before the write (`exists()`,
   `notExists()`, a `rowGuard`) reads a snapshot and lets a concurrent duplicate through (23505).
5. Filter id lists with `eqAny(column, ids)`: one array parameter, one statement text for any list length. Reads
   default to `inArrayOpt()` (an exact `IN ($1, …)` text per length up to 8 values, for the planner's per-element
   estimate under a generic plan; one array parameter above). A write by a key list uses `eqAny()` so that every list
   length shares one statement text and one cached plan
   ([Keep the statement text stable](#keep-the-statement-text-stable)); `inArrayOpt()` matches the same rows.
6. Statements that must commit together: `db.transaction()` with `tx.<table>`. Independent writes: one `MutationBatch`
   statement, which is atomic by itself.

## How a write runs: lazy builders and what `await` returns

`insert`, `insertBulk`, `insertFrom`, `upsert`, `upsertBulk`, `mergeBulk`, `bulkUpdate`, `where().update()`,
`where().delete()` and their `.returning()` / `.affectedCount()` return lazy `PromiseLike` builders: `then()` builds and
sends the statement. Await the builder, return it, or pass it to `Promise.all`.

```ts
import { eq } from 'linkgress-orm';

db.tags.insert({ name: 'never-sent' });                    // not awaited: nothing is sent
db.tags.where(t => eq(t.name, 'Summer')).delete();         // not awaited: nothing is sent

const result = await db.tags.insert({ name: 'Autumn' });   // sent; result is undefined

const write = db.tags.insert({ name: 'Spring' });
await write;
await write;                                               // sent again: 2 rows named Spring
```

```sql
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Autumn" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Spring" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Spring" ]
```

What each call resolves to:

| Call | Resolves to |
|---|---|
| `await <builder>` | `undefined` (the statement has no RETURNING) |
| `insert(row).returning()` | the inserted row, every column, read as an entity |
| `insert(row).returning(selector)` | one row of the selector's shape; a selector returning one value (`u => u.id`) gives that value |
| `.returning()` / `.returning(selector)` of every other write | an array, `[]` when nothing was written |
| `.affectedCount()` of `where().update()` / `where().delete()` (and `update()` / `delete()` without `where()`) | `number` |
| `values(rows)…execute()` | every column of the written rows, as entities |
| `insertWithChildren(…)` | `{ parent, children }`; `parent` is `null` when `unlessExists` matched |
| `insertBulkWithChildren(…)` | `{ parents, children }`, each in input order |
| `batch.executeBatch()` | `void`; then `batch.getAffectedCount(id)` and `batch.getLegRows(id)` |

- `Promise.all([db.tags.insert(a), db.tags.insert(b)])` sends one statement per builder, each committing on its own:
  2 statements, not atomic. Use a [`MutationBatch`](#run-independent-writes-in-one-round-trip-mutationbatch) (one
  statement) or [`db.transaction()`](#make-several-statements-atomic-dbtransaction).
- `insertWithChildren()`, `insertBulkWithChildren()`, `values(…).execute()` and `MutationBatch.executeBatch()` return
  Promises that send their statement when they are CALLED, awaited or not. `insertWithChildren()` and
  `insertBulkWithChildren()` check their rows synchronously (empty children, a child row carrying the foreign key, the
  size limit): such a call throws at the call itself, not from the returned Promise.

> **Pitfall:** The builders are `PromiseLike`, not `Promise`: `.catch()` and `.finally()` do not exist on them (a
> compile error). Use `try { await builder } catch (e) { … }` or `Promise.resolve(builder).catch(…)`.

## Insert one row: `insert()`

`insert(row)` sends `INSERT … VALUES (…)` with the columns the row sets; omitted columns take their DEFAULT. Chain
`.returning(selector)` to read generated keys and defaults in the same statement. For more than one row use
[`insertBulk()`](#insert-many-rows-in-one-statement-insertbulk); for insert-or-skip use
`insertBulk([row], { onConflictDoNothing: true })`, because `insert()` takes no options.

```ts
await db.users.insert({ username: 'dave', email: 'dave@test.com', age: 30 });

const { id } = await db.users
  .insert({ username: 'erin', email: 'erin@test.com' })
  .returning(u => ({ id: u.id }));   // { id: number }
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3)
-- params: [ "dave", "dave@test.com", 30 ]
INSERT INTO "users" ("username", "email") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: [ "erin", "erin@test.com" ]
```

| Form | RETURNING it sends | Resolves to |
|---|---|---|
| `.returning()` | `RETURNING "id", "username", "email", "age", "is_active", "created_at", "metadata", "last_active_at"` | the row with every column (`isActive: true`, `createdAt` filled by their defaults) |
| `.returning(u => ({ id: u.id }))` | `RETURNING "id" AS "id"` | `{ id: number }` |
| `.returning(u => u.id)` | `RETURNING "id" AS "__value"` | `number` (the value itself) |

A selector that reads a navigation or a collection wraps the insert in a `"__mutation__"` CTE, still one statement:

```ts
const post = await db.posts
  .insert({ title: 'Hello', userId: id })
  .returning(p => ({ id: p.id, author: p.user!.username }));   // { id: 4, author: 'erin' }
```

```sql
WITH "__mutation__" AS (
  INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2) RETURNING "id", "user_id"
)
SELECT "__mutation__"."id" AS "id", "user"."username" AS "author"
FROM "__mutation__"
INNER JOIN "users" AS "user" ON "__mutation__"."user_id" = "user"."id"
-- params: [ "Hello", 5 ]
```

> **Pitfall:** Insert rows are typed `InsertData<T>`, a `Partial` of the columns. A row missing a NOT NULL column
> compiles and fails at run time: `db.users.insert({ age: 3 })` sends `INSERT INTO "users" ("age") VALUES ($1)` and
> fails with 23502 `null value in column "username" of relation "users" violates not-null constraint`. Unknown keys and
> wrong value types are compile errors.

> **Pitfall:** A value for an identity column is left out without an error:
> `db.tags.insert({ id: 4242, name: 'Explicit' }).returning()` sends `INSERT INTO "tags" ("name") VALUES ($1) RETURNING
> "id", "name"` and the row gets the next generated id (`{ id: 4, name: 'Explicit' }`). Write explicit identity values
> with `insertBulk(rows, { overridingSystemValue: true })`.

An `sql` fragment value renders inline, and must be self-contained SQL (no table is in scope inside `VALUES`). Insert
rows do not type fragments, so cast it:

```ts
await db.users.insert({ username: 'hal', email: sql<string>`lower(${'HAL@TEST.COM'})` as unknown as string });
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, (lower($2)))
-- params: [ "hal", "HAL@TEST.COM" ]
```

## Insert many rows in one statement: `insertBulk()`

`insertBulk(rows, options?)` writes JS rows as one multi-row `INSERT … VALUES (…), (…)`, every value through its column's
mapper. Use it whenever you hold more than one row. Rows the database can compute belong in
[`insertFrom()`](#insert-rows-computed-from-the-database-insertfrom); a very large or variable-size set that must stay
one fixed statement belongs in [`fromRows()`](#insert-a-large-or-variable-size-set-in-one-fixed-statement-fromrows).

The loop it replaces, one round trip per row:

```ts
const names = ['Autumn', 'Spring', 'Outdoor'];

for (const name of names) {
  await db.tags.insert({ name });
}
```

```sql
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Autumn" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Spring" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "Outdoor" ]
```

The same rows in one statement:

```ts
await db.tags.insertBulk(names.map(name => ({ name })));
```

```sql
INSERT INTO "tags" ("name") VALUES ($1), ($2), ($3)
-- params: [ "Autumn", "Spring", "Outdoor" ]
```

Generated keys of every row, in the same statement:

```ts
const created = await db.users
  .insertBulk([
    { username: 'dave', email: 'dave@test.com', age: 30 },
    { username: 'erin', email: 'erin@test.com', age: 41 },
  ])
  .returning(u => ({ id: u.id, username: u.username }));
// [{ id: 4, username: 'dave' }, { id: 5, username: 'erin' }]
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3), ($4, $5, $6) RETURNING "id" AS "id", "username" AS "username"
-- params: [ "dave", "dave@test.com", 30, "erin", "erin@test.com", 41 ]
```

PostgreSQL does not document the order of RETURNING rows as a guarantee: to map keys back to inputs, return a natural
key with the id (`username` above).

| Option | Default | Effect |
|---|---|---|
| `chunkSize` | `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows | rows per statement; more rows are sent as further statements |
| `onConflictDoNothing` | `false` | `ON CONFLICT DO NOTHING`: rows any unique index rejects are skipped |
| `overridingSystemValue` | `false` | sends identity columns (otherwise left out) with `OVERRIDING SYSTEM VALUE` |

```ts
await db.tags.insertBulk(
  ['t1', 't2', 't3', 't4', 't5'].map(name => ({ name })),
  { chunkSize: 2 },
);

await db.tags.insertBulk([{ id: 900, name: 'Imported' }], { overridingSystemValue: true });
```

```sql
INSERT INTO "tags" ("name") VALUES ($1), ($2)
-- params: [ "t1", "t2" ]
INSERT INTO "tags" ("name") VALUES ($1), ($2)
-- params: [ "t3", "t4" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "t5" ]
INSERT INTO "tags" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ($1, $2)
-- params: [ 900, "Imported" ]
```

- An empty array sends nothing; `.returning()` then gives `[]`.
- The column list is the union of the rows' keys. A column no row sets is left out, so its DEFAULT applies; a column any
  row sets is sent for every row, as NULL where a row lacks it:

```ts
await db.users.insertBulk([
  { username: 'mia', email: 'mia@test.com', isActive: false },
  { username: 'noah', email: 'noah@test.com' },    // isActive is stored as NULL, not the DEFAULT true
]);
```

```sql
INSERT INTO "users" ("username", "email", "is_active") VALUES ($1, $2, $3), ($4, $5, $6)
-- params: [ "mia", "mia@test.com", false, "noah", "noah@test.com", null ]
```

> **Pitfall:** Chunks are separate statements. Outside a transaction each chunk commits on its own, so a failure in a
> later chunk leaves the earlier ones written. Wrap the call in `db.transaction()` for all-or-nothing, or use
> `fromRows()` for one statement:

```ts
await db.users.insertBulk(
  [{ username: 'olga', email: 'olga@test.com' }, { username: 'alice', email: 'dup@test.com' }],
  { chunkSize: 1 },
);
// throws 23505 on the second chunk; olga's row stays. Inside db.transaction() both chunks roll back.
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2)
-- params: [ "olga", "olga@test.com" ]
INSERT INTO "users" ("username", "email") VALUES ($1, $2)
-- params: [ "alice", "dup@test.com" ]
-- error: duplicate key value violates unique constraint "users_username_key"
```

> **Efficiency:** n rows cost `ceil(n ÷ chunk)` round trips instead of n. A statement binds rows × columns parameters,
> and its text changes with the row count (see [Keep the statement text stable](#keep-the-statement-text-stable)).
> PGlite refuses a statement over 32 767 parameters, but the default chunk follows PostgreSQL's 65 535 and binds up to
> 39 321 whatever the row width: on PGlite pass a `chunkSize` with rows × columns ≤ 32 767, or use `fromRows()`.

## Insert a large or variable-size set in one fixed statement: `fromRows()`

`fromRows(table, rows, { columns })` (since 1.0.29) binds JS rows as ONE array parameter per column, typed by the
table's columns and passed through their mappers. As the source of `insertFrom()` it inserts any number of rows in one
statement whose text does not depend on the row count. Use it for large or variable-size sets, and when the rows must be
joined or compared inside a write; for a handful of rows `insertBulk()` is simpler.

```ts
import { fromRows } from 'linkgress-orm';

await db.users.insertFrom(
  fromRows(db.users, [
    { username: 'dave', email: 'dave@test.com', age: 30 },
    { username: 'erin', email: 'erin@test.com' },
    { username: 'finn', email: 'finn@test.com', age: 52 },
  ], { columns: ['username', 'email', 'age'] }).asSubquery('table'),
  src => ({ username: src.username, email: src.email, age: src.age }),
);

await db.users.insertFrom(
  fromRows(db.users, [{ username: 'gina', email: 'gina@test.com', age: 19 }], { columns: ['username', 'email', 'age'] })
    .asSubquery('table'),
  src => ({ username: src.username, email: src.email, age: src.age }),
);
```

```sql
INSERT INTO "users" ("username", "email", "age") SELECT "src"."username", "src"."email", "src"."age"
FROM (SELECT "rows"."username" as "username", "rows"."email" as "email", "rows"."age" as "age"
FROM unnest(CAST($1 AS varchar[]), CAST($2 AS text[]), CAST($3 AS integer[])) AS "rows"("username", "email", "age")) AS "src"
-- params: [ "{\"dave\",\"erin\",\"finn\"}", "{\"dave@test.com\",\"erin@test.com\",\"finn@test.com\"}", "{30,NULL,52}" ]
INSERT INTO "users" ("username", "email", "age") SELECT "src"."username", "src"."email", "src"."age"
FROM (SELECT "rows"."username" as "username", "rows"."email" as "email", "rows"."age" as "age"
FROM unnest(CAST($1 AS varchar[]), CAST($2 AS text[]), CAST($3 AS integer[])) AS "rows"("username", "email", "age")) AS "src"
-- params: [ "{\"gina\"}", "{\"gina@test.com\"}", "{19}" ]
```

Measured with 70 000 one-column rows (`db.tags`):

| Call | Statements | Parameters | Statement text |
|---|---|---|---|
| `insertBulk(rows)` | 2 (chunks of 39 321 and 30 679 rows) | 39 321 + 30 679 | 382 137 + 295 717 characters |
| `insertFrom(fromRows(db.tags, rows, { columns: ['name'] }).asSubquery('table'), map)` | 1 | 1 | 147 characters |

When to switch from `insertBulk()`: it is ONE statement up to one chunk (39 321 rows of one column, 13 107 of three;
measured: 10 000 one-column rows with `.returning()` in 1 statement, 13 108 three-column rows in 2). Above one chunk,
or when the statement text must not depend on the row count (prepared statements), use `fromRows()`. It reads the
generated keys with `.returning()` too (40 000 rows with `.returning()`: 1 statement); return a natural key with the id,
as the order of RETURNING rows is not guaranteed:

```ts
const keyed = await db.tags
  .insertFrom(fromRows(db.tags, [{ name: 'Ski' }, { name: 'Snowboard' }], { columns: ['name'] }).asSubquery('table'), src => ({ name: src.name }))
  .returning(t => ({ id: t.id, name: t.name }));
// [{ id: 4, name: 'Ski' }, { id: 5, name: 'Snowboard' }]
```

```sql
INSERT INTO "tags" ("name") SELECT "src"."name" FROM (SELECT "rows"."name" as "name"
FROM unnest(CAST($1 AS varchar[])) AS "rows"("name")) AS "src" RETURNING "id" AS "id", "name" AS "name"
-- params: [ "{\"Ski\",\"Snowboard\"}" ]
```

- Pass `columns` to keep the text fixed; without it the set has the columns any row holds.
- A cell a row lacks is NULL, not the column's DEFAULT (`erin`'s `age` above).
- Zero rows are a legal empty set: the statement is still sent and inserts nothing.
- Conflicts: only `insertFrom`'s `onConflictDoNothing`. For insert-or-update use `upsertBulk()`.
- `fromRows()` and `unnestRows()` as read sources: [Set-Returning Functions](./set-returning-functions.md).

> **Efficiency:** one statement and one parameter per column for any row count, no chunking, and one prepared plan for
> every size.

## Insert the rows that are new and skip the rest

Let a unique index decide in the INSERT itself: `ON CONFLICT DO NOTHING`. A concurrent insert of the same key makes the
statement wait and then skip the row, where a check before the insert lets the duplicate through and fails with 23505.

The loop it replaces, racy and 2 round trips per new row:

```ts
const incoming = [
  { username: 'alice', email: 'alice@new.com' },   // exists
  { username: 'dave', email: 'dave@test.com' },    // new
];

for (const row of incoming) {
  const exists = await db.users.where(u => eq(u.username, row.username)).exists();
  if (!exists) await db.users.insert(row);
}
```

```sql
SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."username" = $1)
-- params: [ "alice" ]
SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."username" = $1)
-- params: [ "dave" ]
INSERT INTO "users" ("username", "email") VALUES ($1, $2)
-- params: [ "dave", "dave@test.com" ]
```

One statement:

```ts
const inserted = await db.users
  .insertBulk(incoming, { onConflictDoNothing: true })
  .returning(u => ({ id: u.id, username: u.username }));
// [{ id: 6, username: 'dave' }]: only the inserted row; alice was skipped
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING RETURNING "id" AS "id", "username" AS "username"
-- params: [ "alice", "alice@new.com", "dave", "dave@test.com" ]
```

| Form | Conflict target | SQL |
|---|---|---|
| `insertBulk(rows, { onConflictDoNothing: true })` | any unique index or the primary key | `… VALUES … ON CONFLICT DO NOTHING` |
| `insertFrom(source, map, { onConflictDoNothing: true })` (since 1.0.29) | any unique index or the primary key | `INSERT … SELECT … ON CONFLICT DO NOTHING` |
| `upsertBulk(rows, { primaryKey, updateColumnFilter: () => false })` | the named key; add `targetWhere` for a partial index | `… ON CONFLICT ("username") DO NOTHING` |
| `values(rows).onConflict(target).doNothing().execute()` | database column names, or `{ constraint: 'name' }` | `… ON CONFLICT ON CONSTRAINT users_username_key DO NOTHING RETURNING …` |

```ts
const targeted = await db.users
  .upsertBulk(
    [{ username: 'alice', email: 'ignored@test.com' }, { username: 'erin', email: 'erin@test.com' }],
    { primaryKey: 'username', updateColumnFilter: () => false },
  )
  .returning(u => ({ id: u.id, username: u.username }));   // [{ id: 8, username: 'erin' }]

const copied = await db.users
  .insertFrom(
    db.users.where(u => eqAny(u.username, ['alice', 'bob'])).select(u => ({ username: u.username, email: u.email })).asSubquery('table'),
    src => ({ username: src.username, email: src.email }),
    { onConflictDoNothing: true },
  )
  .returning(u => ({ id: u.id }));   // []: both usernames exist
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT ("username") DO NOTHING RETURNING "id" AS "id", "username" AS "username"
-- params: [ "alice", "ignored@test.com", "erin", "erin@test.com" ]
INSERT INTO "users" ("username", "email") SELECT "src"."username", "src"."email" FROM (SELECT "users"."username" as "username", "users"."email" as "email"
FROM "users"
WHERE ("users"."username" = ANY($1::varchar[]))) AS "src" ON CONFLICT DO NOTHING RETURNING "id" AS "id"
-- params: [ "{\"alice\",\"bob\"}" ]
```

- One row: `insertBulk([row], { onConflictDoNothing: true }).returning(…)` gives `[]` when the row was skipped.
- RETURNING yields only the inserted rows; compare lengths to detect skips.
- Two input rows with the same key: the first is inserted, the second skipped (`ON CONFLICT DO NOTHING` also skips a
  row the statement itself inserted before it). `DO UPDATE` refuses the same input instead (see
  [`upsertBulk()`](#insert-or-update-by-a-unique-key-upsertbulk)).
- `toStatement()` compiles the option too (`… ON CONFLICT DO NOTHING RETURNING …` inside a data-modifying CTE).
- A skipped row has already drawn its identity value, so ids have gaps: in the captured run every skipped `alice` row
  drew an id that no row holds.
- `values(rows).execute()` without `onConflict()` also renders `ON CONFLICT DO NOTHING`: it never fails on a duplicate.

> **Pitfall:** A `where: src => notExists(…)` guard on `insertFrom`, or a `MutationBatch` `rowGuard`, is not an
> insert-or-skip: it judges the statement's snapshot, so a row a concurrent transaction inserts passes it and then
> fails with 23505.

## Insert rows computed from the database: `insertFrom()`

`insertFrom(source, map, options?)` sends `INSERT … SELECT` from a table subquery: the database computes the rows from
its current data and writes them in the same statement, with no read round trip in between. Use it for next-number
inserts, copies, rows derived from other tables, and as the consumer of a data-modifying CTE. For rows you hold in JS
use `insertBulk()` or `fromRows()`.

The sequence it replaces: read the maximum, compute in JS, insert (2 round trips, and the number can be stale by the
time it is written):

```ts
const orderId = 1;

const top = await db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .select(ot => ({ sortOrder: ot.sortOrder }))
  .groupBy(() => ({}))
  .select(g => ({ max: g.max(ot => ot.sortOrder) }))
  .firstOrDefault();
await db.orderTasks.insert({ orderId, taskId: 2, sortOrder: (top?.max ?? 0) + 1 });
```

```sql
SELECT MAX("order_task"."sort_order") as "max"
FROM "order_task"
WHERE "order_task"."order_id" = $1
LIMIT 1
-- params: [ 1 ]
INSERT INTO "order_task" ("order_id", "task_id", "sort_order") VALUES ($1, $2, $3)
-- params: [ 1, 2, 2 ]
```

One statement, appending a task at the next sort position:

```ts
import { add, coalesce, eq, lte } from 'linkgress-orm';

const next = db.orderTasks
  .where(ot => eq(ot.orderId, orderId))
  .select(ot => ({ sortOrder: ot.sortOrder }))
  .groupBy(() => ({}))
  .select(g => ({ next: add(coalesce(g.max(ot => ot.sortOrder), 0), 1) }))
  .asSubquery('table');

const appended = await db.orderTasks
  .insertFrom(next, src => ({ orderId, taskId: 2, sortOrder: src.next }), {
    where: src => lte(src.next, 100),   // at most 100 tasks per order: no row inserted past that
  })
  .returning(ot => ({ orderId: ot.orderId, taskId: ot.taskId, sortOrder: ot.sortOrder }));
// [{ orderId: 1, taskId: 2, sortOrder: 2 }]
```

```sql
INSERT INTO "order_task" ("order_id", "task_id", "sort_order")
SELECT CAST($4 AS integer), CAST($5 AS integer), "src"."next"
FROM (SELECT (COALESCE(MAX("order_task"."sort_order"), $2) + $3) as "next"
FROM "order_task"
WHERE "order_task"."order_id" = $1) AS "src"
WHERE "src"."next" <= $6
RETURNING "order_id" AS "orderId", "task_id" AS "taskId", "sort_order" AS "sortOrder"
-- params: [ 1, 0, 1, 1, 2, 100 ]
```

An aggregate without GROUP BY (`groupBy(() => ({}))`) always yields one row, so the insert happens for an order without
tasks too (`COALESCE` gives 0). Rows derived from another table, one statement instead of a read plus one insert per
row:

```ts
// Avoid: read the users, insert one post per user (1 + n round trips)
const active = await db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id, name: u.username })).toList();
for (const u of active) {
  await db.posts.insert({ userId: u.id, title: `Welcome, ${u.name}` });
}

// Do: one statement
await db.posts.insertFrom(
  db.users.where(u => eq(u.isActive, true)).select(u => ({ userId: u.id, name: u.username })).asSubquery('table'),
  src => ({ userId: src.userId, title: concat('Welcome, ', src.name) }),
);
```

```sql
SELECT "users"."id" as "id", "users"."username" as "name"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2)
-- params: [ "Welcome, alice", 1 ]
INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2)
-- params: [ "Welcome, bob", 2 ]
INSERT INTO "posts" ("user_id", "title") SELECT "src"."userId", concat(CAST($2 AS text), "src"."name") FROM (SELECT "users"."id" as "userId", "users"."username" as "name"
FROM "users"
WHERE "users"."is_active" = $1) AS "src"
-- params: [ true, "Welcome, " ]
```

`map` receives the source row (`src.<column>` renders `"src"."<column>"`) and returns values by column, in its key
order:

| Map value | Renders as |
|---|---|
| a source ref `src.col` | the ref, as is |
| an expression (a helper, `sql`, `caseWhen`) for a non-string column | the expression cast to the column type (since 1.0.29): `CAST(CASE WHEN … END AS order_status)` |
| an expression for a string column (`text`, `varchar`, `char`) | the expression, as is: `concat(CAST($2 AS text), "src"."name")` above |
| a plain value | a parameter through the column's mapper, cast to the column type without a typmod: `CAST($5 AS decimal)` (an untyped parameter in a SELECT list would resolve as `text`) |
| `null` | a typed NULL: `CAST(NULL AS jsonb)` |
| `undefined` | the column is left out; its DEFAULT applies |

```ts
await db.orders.insertFrom(
  db.users.where(u => eq(u.username, 'alice')).select(u => ({ uid: u.id, active: u.isActive })).asSubquery('table'),
  src => ({
    userId: src.uid,                                                       // a source ref: as is
    status: caseWhen(eq(src.active, true), 'processing').else('pending'), // an expression: cast to the column type
    totalAmount: 0,                                                        // a plain value: CAST($n AS decimal)
    items: null,                                                           // null: a typed NULL
    createdAt: undefined,                                                  // undefined: left out, DEFAULT applies
  }),
);
```

```sql
INSERT INTO "orders" ("user_id", "status", "total_amount", "items")
SELECT "src"."uid", CAST(CASE WHEN "src"."active" = $2 THEN CAST($3 AS text) ELSE CAST($4 AS text) END AS order_status), CAST($5 AS decimal), CAST(NULL AS jsonb)
FROM (SELECT "users"."id" as "uid", "users"."is_active" as "active"
FROM "users"
WHERE "users"."username" = $1) AS "src"
-- params: [ "alice", true, "processing", "pending", 0 ]
```

A cast never carries a typmod (a `char(n)` column casts to `bpchar`, a `bit(n)` one to `varbit`: the bare `char` / `bit`
mean `(1)` and would truncate silently), so the assignment pads, rounds or raises 22001 exactly as `INSERT … VALUES`
does. Without the expression cast a `CASE` of string values is
`text`, which a timestamp, uuid, enum, number, jsonb or array column refuses (42804).

| Option | Effect |
|---|---|
| `where: src => condition` | `WHERE <condition>` over `"src"`; rows it rejects are not inserted |
| `with: [cte, …]` (since 1.0.22) | CTEs declared at the top of the statement, `WITH <ctes> INSERT …`; a data-modifying CTE the source reads must be declared here |
| `onConflictDoNothing: true` (since 1.0.29) | `ON CONFLICT DO NOTHING`, after `where` and before RETURNING |
| `expectedErrorCodes: ['23505']` | SQLSTATEs the statement may fail with: still thrown, but not reported by the [`logFailedQueries`](./configuration.md#record-failed-statements-in-production-logfailedqueries) logger |

- The source must be built with `.asSubquery('table')`. A map key that is not a column, or a `src.<column>` the source
  does not project, throws before anything is sent.
- Parameters are numbered in build order: the `with` CTEs', the source's, the SELECT list's, `where`'s, then RETURNING's
  (`$1`–`$3` source, `$4`–`$5` SELECT list, `$6` `where` above).
- Zero source rows, or a `where` that holds for none: the statement is sent and inserts nothing; `.returning()` gives
  `[]`.
- It runs on its table's context: `tx.<table>.insertFrom(…)` is part of the transaction.
- Two concurrent next-number writers compute the same value. With a unique index on the number, set
  `expectedErrorCodes: ['23505']` and retry, or serialize them with an
  [advisory lock](#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks).
- `.toStatement(selector)` (since 1.0.22) compiles the statement for a
  [data-modifying CTE](#feed-one-write-into-another-in-one-statement-data-modifying-ctes).

## Insert or update by a unique key: `upsertBulk()`

`upsertBulk(rows, config?)` sends `INSERT … ON CONFLICT (<key>) DO UPDATE`: new keys are inserted and existing ones
updated in one statement, arbitrated by a unique index or the primary key, race-safe. The key needs a unique index;
without one use [`mergeBulk()`](#insert-or-update-without-a-unique-index-mergebulk). `upsert(rows, config?)` is the same
call with rows typed `InsertData` (no `sql` fragments).

The loop it replaces, 2 round trips per row and racy:

```ts
const incoming = [
  { username: 'alice', email: 'alice@new.com', age: 26 },   // exists: update
  { username: 'dave', email: 'dave@test.com', age: 30 },    // new: insert
];

for (const row of incoming) {
  const existing = await db.users.where(u => eq(u.username, row.username)).select(u => ({ id: u.id })).firstOrDefault();
  if (existing) {
    await db.users.where(u => eq(u.id, existing.id)).update({ email: row.email, age: row.age });
  } else {
    await db.users.insert(row);
  }
}
```

```sql
SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]
UPDATE "users" SET "email" = $1, "age" = $2 WHERE "users"."id" = $3
-- params: [ "alice@new.com", 26, 1 ]
SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "dave" ]
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3)
-- params: [ "dave", "dave@test.com", 30 ]
```

One statement:

```ts
await db.users.upsertBulk(incoming, { primaryKey: 'username' });
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age"
-- params: [ "alice", "alice@new.com", 26, "dave", "dave@test.com", 30 ]
```

`updateColumns` limits the update; `.returning()` gives the inserted AND the updated rows:

```ts
const saved = await db.users
  .upsertBulk(
    [{ username: 'bob', email: 'bob@new.com', age: 99 }, { username: 'erin', email: 'erin@test.com', age: 41 }],
    { primaryKey: 'username', updateColumns: ['email'] },
  )
  .returning(u => ({ id: u.id, username: u.username, email: u.email, age: u.age }));
// [{ id: 2, username: 'bob', email: 'bob@new.com', age: 35 },     updated: age kept
//  { id: 8, username: 'erin', email: 'erin@test.com', age: 41 }]  inserted
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email" RETURNING "id" AS "id", "username" AS "username", "email" AS "email", "age" AS "age"
-- params: [ "bob", "bob@new.com", 99, "erin", "erin@test.com", 41 ]
```

| Config key | Default | Effect |
|---|---|---|
| `primaryKey` | the table's primary key | the conflict target: a property, an array of properties, or a lambda (`u => u.username`, parsed from the function's source text) |
| `updateColumns` | every column the rows carry except the key | the columns set to `EXCLUDED."col"`; `[]` renders `DO NOTHING` |
| `updateColumnFilter` | — | `(property) => boolean` over the rows' columns; `() => false` renders `DO NOTHING` |
| `updateSet` | — | `(existing, excluded) => ({ col: value })`: computed assignments ([below](#compute-the-update-from-the-stored-and-the-proposed-row-updateset--updatewhere)) |
| `updateWhere` | — | `(existing, excluded) => condition`: the `DO UPDATE … WHERE` |
| `setWhere` | — | the same condition as raw SQL; ANDed with `updateWhere` |
| `targetWhere` | — | the arbiter predicate of a partial unique index ([below](#upsert-onto-a-partial-unique-index-targetwhere)) |
| `chunkSize` | `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows | rows per statement |
| `overridingSystemValue` | `true` when the first row (or `referenceItem`) carries an identity primary key | `OVERRIDING SYSTEM VALUE` |
| `referenceItem` | the first row | the row whose keys decide `overridingSystemValue` |

Without `primaryKey` the target is the table's primary key. A row carrying the identity key then upserts by it (with
`OVERRIDING SYSTEM VALUE`); rows without it never conflict, so every row is inserted:

```ts
await db.tags.upsertBulk([{ id: 1, name: 'Summer (renamed)' }]);
await db.tags.upsertBulk([{ name: 'Summer' }]);   // a second 'Summer' row: nothing to conflict with
```

```sql
INSERT INTO "tags" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"
-- params: [ 1, "Summer (renamed)" ]
INSERT INTO "tags" ("name") VALUES ($1) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"
-- params: [ "Summer" ]
```

> **Pitfall:** Every row is sent with the union of the rows' columns. A column some rows lack is sent as NULL for them
> and, on conflict, overwrites the stored value. Give every row the same columns, or update partial rows with
> [`bulkUpdate()`](#update-many-rows-each-with-its-own-values-bulkupdate):

```ts
await db.users.upsertBulk(
  [{ username: 'alice', email: 'a@test.com', age: 50 }, { username: 'bob', email: 'b@test.com' }],
  { primaryKey: 'username' },
);
// bob's age was 35; it is now NULL
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email", "age" = EXCLUDED."age"
-- params: [ "alice", "a@test.com", 50, "bob", "b@test.com", null ]
```

A key whose value is `undefined` (`{ age: undefined }`) is a carried column too: it is sent as NULL and overwrites the
stored value on conflict. Leave such keys out of the row.

> **Pitfall:** One call may name each key once. Two rows with the same conflict key fail the whole statement with 21000
> (DO UPDATE cannot change the row it just inserted or updated); deduplicate the input by the key first:

```ts
await db.users.upsertBulk(
  [{ username: 'dave', email: 'dave@test.com' }, { username: 'dave', email: 'dave@new.com' }],
  { primaryKey: 'username' },
);
// throws 21000: ON CONFLICT DO UPDATE command cannot affect row a second time
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT ("username") DO UPDATE SET "email" = EXCLUDED."email"
-- params: [ "dave", "dave@test.com", "dave", "dave@new.com" ]
-- error: ON CONFLICT DO UPDATE command cannot affect row a second time
```

> **Efficiency:** 1 statement per chunk instead of 2 per row (2 rows: 1 statement against 4). With DO UPDATE, RETURNING
> covers inserted and updated rows, so no read-back is needed.

### Compute the update from the stored and the proposed row: `updateSet` / `updateWhere`

`updateSet(existing, excluded)` assigns expressions over the stored row (`existing`, rendered by the table name) and the
proposed row (`excluded`): accumulate, keep the first non-null value, accept only a newer version. `updateWhere` adds
the `DO UPDATE … WHERE`. The whole read-modify-write cycle is one atomic statement.

```ts
import { add, coalesce, lt } from 'linkgress-orm';

await db.productTags.upsertBulk(
  [{ productId: 1, tagId: 2, sortOrder: 5 }],
  {
    primaryKey: ['productId', 'tagId'],
    updateSet: (existing, excluded) => ({ sortOrder: add(existing.sortOrder, excluded.sortOrder) }),
    updateWhere: (existing, excluded) => lt(existing.sortOrder, excluded.sortOrder),
  },
);

await db.users.upsertBulk(
  [{ username: 'alice', email: 'ignored@test.com', age: 77 }],
  {
    primaryKey: 'username',
    updateSet: (existing, excluded) => ({ age: coalesce(existing.age, excluded.age), email: 'fixed@test.com' }),
  },
);
```

```sql
INSERT INTO "product_tags" ("product_id", "tag_id", "sort_order") VALUES ($1, $2, $3) ON CONFLICT ("product_id", "tag_id") DO UPDATE SET "sort_order" = ("product_tags"."sort_order" + "excluded"."sort_order") WHERE "product_tags"."sort_order" < "excluded"."sort_order"
-- params: [ 1, 2, 5 ]
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3) ON CONFLICT ("username") DO UPDATE SET "age" = COALESCE("users"."age", "excluded"."age"), "email" = $4
-- params: [ "alice", "ignored@test.com", 77, "fixed@test.com" ]
```

- `updateSet` alone updates ONLY the columns it names. With `updateColumns` / `updateColumnFilter`, the listed columns
  keep `= EXCLUDED."col"` and the named ones take their expression (an expression wins on overlap).
- Values: an [SQL expression helper](./sql-expressions.md), an `sql` fragment, a column of either row, a condition (a
  boolean) or a plain value, which binds through the column's mapper after the VALUES parameters (`$4` above).
- Navigations are not in scope in an INSERT and throw. An unknown column throws.
- `setWhere` (raw SQL) is ANDed with `updateWhere`:
  `{ updateColumns: ['email'], setWhere: '"users"."is_active" = true' }` renders
  `… DO UPDATE SET "email" = EXCLUDED."email" WHERE "users"."is_active" = true`.
- `MutationBatch.addUpsertBulk` takes the same `updateSet` / `updateWhere`.

### Compute a value inside the INSERT: `sql` fragments in upsert rows

An upsert row value can be an `sql` fragment, rendered inside the `VALUES` tuple: for example a scalar subquery the
INSERT computes. On conflict the computed value reaches the DO UPDATE arm through `EXCLUDED."col"`, so aggregate-then-
persist is one round trip.

```ts
const productId = 2;
await db.productTags.upsertBulk(
  [{
    productId,
    tagId: 3,
    sortOrder: sql<number>`(SELECT COUNT(*)::int FROM "product_tags" WHERE "product_id" = ${productId})`,
  }],
  { primaryKey: ['productId', 'tagId'], updateColumns: ['sortOrder'] },
);
```

```sql
INSERT INTO "product_tags" ("product_id", "tag_id", "sort_order") VALUES ($1, $2, (SELECT COUNT(*)::int FROM "product_tags" WHERE "product_id" = $3)) ON CONFLICT ("product_id", "tag_id") DO UPDATE SET "sort_order" = EXCLUDED."sort_order"
-- params: [ 2, 3, 2 ]
```

- A fragment must be self-contained SQL: no table alias is in scope inside `VALUES`, so entity column refs do not
  resolve there.
- Its interpolated values bind as ordinary parameters, numbered with the plain values; they bypass the column's mapper.
- An aggregate-only scalar subquery yields exactly one row, so the value exists even over zero source rows
  (`SUM` → NULL → `COALESCE(…, 0)`).
- PostgreSQL types a parameter from its context: ``sql`${a} + ${b}` `` with two plain values is `unknown + unknown`
  ("operator is not unique"); cast one of them: ``sql`${a}::int + ${b}` ``.
- Fragments render inline in every write that takes row values (`insert`, `insertBulk`, `upsert`, `mergeBulk`,
  `values(…).execute()`, the rows of `insertWithChildren` / `insertBulkWithChildren`, and `bulkUpdate` cells, which cast
  them to the column type). The typings accept them only in `upsertBulk`, `mergeBulk`, `update()` and the child rows of
  the `*WithChildren` calls; elsewhere cast the fragment (see [What the typings check](#what-the-typings-check)).

### Upsert onto a partial unique index: `targetWhere`

A PARTIAL unique index is the conflict arbiter only when `ON CONFLICT` names a predicate that implies the index's own
(equal or stronger); otherwise PostgreSQL raises 42P10. The test model has no partial unique index, so these examples
use a `leases` table (one row per tenancy, at most one CURRENT row per unit) on a context whose model declares it:

```ts
// fragment: the Lease entity in setupModel() (class Lease: id, unitId, tenantId, validFrom, validTo?, isCurrent)
model.entity(Lease, entity => {
  entity.toTable('leases');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'leases_id_seq' }));
  entity.property(e => e.unitId).hasType(integer('unit_id')).isRequired();
  entity.property(e => e.tenantId).hasType(integer('tenant_id')).isRequired();
  entity.property(e => e.validFrom).hasType(timestamp('valid_from')).isRequired();
  entity.property(e => e.validTo).hasType(timestamp('valid_to'));
  entity.property(e => e.isCurrent).hasType(boolean('is_current')).isRequired();
  // at most one CURRENT lease per unit: UNIQUE (unit_id) WHERE is_current = true
  entity.hasIndex('ux_leases_current_unit', e => [e.unitId]).isUnique().where('is_current = true');
});
```

```ts
import { eq, literal } from 'linkgress-orm';

const t0 = new Date('2026-01-01T00:00:00Z');

await db.leases.upsertBulk(
  [{ unitId: 1, tenantId: 11, validFrom: t0, isCurrent: true }],
  {
    primaryKey: ['unitId'],
    targetWhere: e => eq(e.isCurrent, literal(true)),
    updateColumns: ['tenantId'],
  },
);

// the same arbiter as insert-or-skip
await db.leases.upsertBulk(
  [{ unitId: 2, tenantId: 99, validFrom: t0, isCurrent: true }],
  { primaryKey: ['unitId'], targetWhere: e => eq(e.isCurrent, literal(true)), updateColumnFilter: () => false },
);
```

```sql
INSERT INTO "leases" ("unit_id", "tenant_id", "valid_from", "is_current") VALUES ($1, $2, $3, $4) ON CONFLICT ("unit_id") WHERE "is_current" = TRUE DO UPDATE SET "tenant_id" = EXCLUDED."tenant_id"
-- params: [ 1, 11, "2026-01-01T00:00:00.000Z", true ]
INSERT INTO "leases" ("unit_id", "tenant_id", "valid_from", "is_current") VALUES ($1, $2, $3, $4) ON CONFLICT ("unit_id") WHERE "is_current" = TRUE DO NOTHING
-- params: [ 2, 99, "2026-01-01T00:00:00.000Z", true ]
```

- Without `targetWhere` the same upsert fails: 42P10 `there is no unique or exclusion constraint matching the ON CONFLICT specification`.
- A stronger predicate is an arbiter too: `targetWhere: e => and(eq(e.isCurrent, literal(true)), isNotNull(e.validFrom))`
  renders `ON CONFLICT ("unit_id") WHERE ("is_current" = TRUE AND "valid_from" IS NOT NULL)` and updates the row.
- The typed predicate receives the row's columns UNQUALIFIED (the table is the only relation in scope); navigations
  throw.
- It must not bind anything: write constants with `literal()`. PostgreSQL infers the arbiter at PLAN time, and a bound
  `$n` is no constant in a generic plan (a prepared statement after its fifth execution), which would then fail with
  42P10. `targetWhere: e => eq(e.isCurrent, true)` is refused before anything is sent: `upsert targetWhere: the
  conflict-arbiter predicate must not bind parameters — PostgreSQL infers the partial unique index from it at plan time;
  write constants with literal()`.
- SQL text works too (`targetWhere: 'is_current = true'`), unchecked.
- The same option: `values(…).onConflict(…).targetWhere(…)` and `MutationBatch.addUpsertBulk`'s config.
- The in-memory database infers the arbiter as PostgreSQL does for the usual spellings (`literal(v)` and
  `literal(v, pgType)`, `isNotNull(x)` and `not(isNull(x))`, a strict call such as `lower(x)` for an `x IS NOT NULL`
  predicate), so a wrong `targetWhere` fails there too (42P10). It proves less than the server in a few forms (OR, range
  proofs, general constant folding; see [In-Memory Database](./in-memory-database.md)): there a RIGHT predicate can fail
  in memory, never the reverse.

### Conflict on a constraint name, or SET explicit values: `values()`

`values(rows).onConflict(target).doUpdate(options).execute()` is the explicit `INSERT … ON CONFLICT` builder. Use it for
`ON CONFLICT ON CONSTRAINT <name>`, or for a DO UPDATE that sets given values or expressions instead of the proposed
row. For everything else prefer `upsertBulk()`: it maps property names, chunks large inputs and selects its RETURNING.

```ts
const rows = await db.users
  .values([{ username: 'alice', email: 'alice@test.com', age: 30 }])
  .onConflict(['username'])
  .doUpdate({
    set: {
      email: 'renamed@test.com',                                    // a value, through the column's mapper
      age: sql<number>`"users"."age" + EXCLUDED."age"`,             // an expression; EXCLUDED = the proposed row
    },
    where: '"users"."is_active"',                                  // the DO UPDATE condition, raw SQL
  })
  .execute();
// [{ id: 1, username: 'alice', email: 'renamed@test.com', age: 55, … }]: every column, as entities
```

```sql
INSERT INTO "users" ("username", "email", "age")
      VALUES ($1, $2, $3)
      ON CONFLICT ("username") DO UPDATE SET "email" = $4, "age" = ("users"."age" + EXCLUDED."age") WHERE "users"."is_active"
      RETURNING "id", "username", "email", "age", "is_active", "created_at", "metadata", "last_active_at"
-- params: [ "alice", "alice@test.com", 30, "renamed@test.com" ]
```

| Call | DO clause |
|---|---|
| `doUpdate()` | every inserted non-PRIMARY-key column to the proposed value, the conflict column too: `SET "username" = EXCLUDED."username", "email" = EXCLUDED."email"` |
| `doUpdate({ updateColumns: ['email'] })` | exactly those columns to the proposed values: `SET "email" = EXCLUDED."email"` |
| `doUpdate({ set })` | exactly the `set` columns to its values or expressions (a column the insert does not carry too); a key that is not a column throws |
| `doUpdate({ where })` | `DO UPDATE … WHERE <raw SQL>` |
| `doNothing()` | `DO NOTHING`; a conflicting row is not returned |
| no `onConflict()` call | `ON CONFLICT DO NOTHING` |

- `onConflict([...])` takes DATABASE column names, rendered verbatim: `onConflict(['productId', 'tagId'])` renders
  `ON CONFLICT ("productId", "tagId")` and fails with 42703 `column "productId" of relation "product_tags" does not
  exist`; write `onConflict(['product_id', 'tag_id'])`. `{ constraint: 'users_username_key' }` is rendered unquoted.
- Identity columns are always left out of `VALUES`; there is no `overridingSystemValue` here.
- RETURNING is always every column. No chunking: the whole input is one statement.

## Insert or update without a unique index: `mergeBulk()`

`mergeBulk(rows, { on, … })` sends a PostgreSQL `MERGE` (15+): rows matching on the columns `on` names are updated, the
others inserted. No unique index is consulted, and `matchWhere` can scope the match. Use it for single-writer syncs
whose identity has no unique index or must be scoped (for example, only active rows). With concurrent writers of the same
keys use `upsertBulk()` on a unique index: MERGE has no speculative insertion, so two writers can both insert.

`products.name` has no unique index, so `upsertBulk` cannot target it:

```ts
await db.products.upsertBulk([{ name: 'Hardback', active: false }], { primaryKey: 'name' });
```

```sql
INSERT INTO "products" ("name", "active") VALUES ($1, $2) ON CONFLICT ("name") DO UPDATE SET "active" = EXCLUDED."active"
-- params: [ "Hardback", false ]
-- error: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

`mergeBulk` matches without an index:

```ts
await db.products.mergeBulk(
  [{ name: 'Hardback', active: false }, { name: 'Sled', active: true }],
  { on: 'name', matchWhere: 't."active" = TRUE', updateColumns: ['active'] },
);

const merged = await db.products
  .mergeBulk([{ name: 'Lift Ticket', active: false }, { name: 'Skates', active: true }], { on: 'name' })
  .returning(p => ({ id: p.id, name: p.name, active: p.active }));   // PostgreSQL 17+
// [{ id: 2, name: 'Lift Ticket', active: false }, { id: 4, name: 'Skates', active: true }]
```

```sql
MERGE INTO "products" AS t USING (VALUES ($1::varchar, $2::boolean), ($3, $4)) AS s ("name", "active") ON t."name" = s."name" AND (t."active" = TRUE) WHEN MATCHED THEN UPDATE SET "active" = s."active" WHEN NOT MATCHED THEN INSERT ("name", "active") VALUES (s."name", s."active")
-- params: [ "Hardback", false, "Sled", true ]
MERGE INTO "products" AS t USING (VALUES ($1::varchar, $2::boolean), ($3, $4)) AS s ("name", "active") ON t."name" = s."name" WHEN MATCHED THEN UPDATE SET "active" = s."active" WHEN NOT MATCHED THEN INSERT ("name", "active") VALUES (s."name", s."active") RETURNING t."id" AS "id", t."name" AS "name", t."active" AS "active"
-- params: [ "Lift Ticket", false, "Skates", true ]
```

| Config key | Default | Effect |
|---|---|---|
| `on` (required) | — | the match columns: a property, an array of properties, or a lambda; `ON t."col" = s."col"` |
| `matchWhere` | — | raw SQL ANDed into the match; the target row is `t`, the source row `s` |
| `updateColumns` | every column the rows carry except `on` | the `WHEN MATCHED THEN UPDATE SET` list; `[]` renders `WHEN MATCHED THEN DO NOTHING` (insert only the unmatched) |
| `updateColumnFilter` | — | `(property) => boolean` over the rows' columns |
| `chunkSize` | `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows | rows per statement |

- A target row may be matched by only one source row: two input rows with the same `on` key fail with 21000
  `MERGE command cannot affect row a second time`. Deduplicate the input by `on`.
- Only the first VALUES row is cast to the column types (`$1::varchar`); the others take their types from it.
- A column some rows lack is sent as NULL for them and overwrites the stored value on match.
- An `on` key missing from the rows throws before anything is sent. `.returning()` needs PostgreSQL 17+ and qualifies
  columns with `t.`; a navigation or collection in its selector runs the MERGE in a `"__mutation__"` CTE.

## Update the rows that match a condition: `where().update()`

`db.<table>.where(cond).update(values)` sends one `UPDATE … SET … WHERE …` for every matching row. Plain values bind
through the column mappers; `sql` fragments and expression helpers render inline. Use it when every matching row gets
the same change, or a change computed from its own columns. Different values per row: `bulkUpdate()`.

```ts
await db.users.where(u => eq(u.username, 'alice')).update({ email: 'alice@new.com', age: 26 });
```

```sql
UPDATE "users" SET "email" = $1, "age" = $2 WHERE "users"."username" = $3
-- params: [ "alice@new.com", 26, "alice" ]
```

The per-id loop it replaces, and the set-based form:

```ts
const ids = [1, 2, 3];

// Avoid: one round trip per id
for (const id of ids) {
  await db.users.where(u => eq(u.id, id)).update({ isActive: true });
}

// Do: one statement; eqAny binds the list as ONE array parameter
await db.users.where(u => eqAny(u.id, ids)).update({ isActive: true });

// inArray renders one placeholder per element: the text changes with the list length
await db.users.where(u => inArray(u.id, ids)).update({ isActive: true });
```

```sql
UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 1 ]
UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 2 ]
UPDATE "users" SET "is_active" = $1 WHERE "users"."id" = $2
-- params: [ true, 3 ]
UPDATE "users" SET "is_active" = $1 WHERE ("users"."id" = ANY($2::integer[]))
-- params: [ true, "{1,2,3}" ]
UPDATE "users" SET "is_active" = $1 WHERE "users"."id" IN ($2, $3, $4)
-- params: [ true, 1, 2, 3 ]
```

`.affectedCount()` returns the number of updated rows without RETURNING; `.returning()` returns the rows:

```ts
const n = await db.users.where(u => eq(u.isActive, true)).update({ age: 40 }).affectedCount();   // 3
const rows = await db.users.where(u => eq(u.username, 'bob')).update({ email: 'bob@new.com' }).returning();
```

```sql
UPDATE "users" SET "age" = $1 WHERE "users"."is_active" = $2
-- params: [ 40, true ]
UPDATE "users" SET "email" = $1 WHERE "users"."username" = $2 RETURNING "id", "username", "email", "age", "is_active", "created_at", "metadata", "last_active_at"
-- params: [ "bob@new.com", "bob" ]
```

The function form computes values from the row itself:

```ts
await db.posts.where(p => eq(p.userId, 1)).update(p => ({
  views: add(p.views, 1),            // an expression helper renders inline
  content: sql<string>`${p.title}`,  // another column: wrap it in sql``
}));

await db.users.where(u => eq(u.username, 'bob')).update(u => ({ metadata: jsonbMerge(u.metadata, { plan: 'pro' }) }));
```

```sql
UPDATE "posts" SET "views" = ("posts"."views" + $1), "content" = "posts"."title" WHERE "posts"."user_id" = $2
-- params: [ 1, 1 ]
UPDATE "users" SET "metadata" = (COALESCE("users"."metadata", '{}'::jsonb) || ($1)::jsonb) WHERE "users"."username" = $2
-- params: [ { "plan": "pro" }, "bob" ]
```

> **Pitfall:** In `update(row => ({ … }))` only `sql` fragments and expression helpers render as SQL. A bare column
> (`content: p.title`) or a condition (`isActive: gt(u.age, 30)`) compiles but is bound as a PARAMETER: the column ref
> is written as its JSON text (`UPDATE "posts" SET "content" = $1 …` stored
> `{"__fieldName":"title","__dbColumnName":"title",…}`), and the condition fails with 22P02. Wrap them:
> ``sql`${p.title}` `` renders `"content" = "posts"."title"`, ``sql`${gt(u.age, 30)}` `` renders
> `"is_active" = ("users"."age" > $1)`. (`upsertBulk`'s `updateSet` and `bulkUpdate`'s `set` render columns and
> conditions directly.)

A condition through a navigation renders `UPDATE … FROM`:

```ts
const touched = await db.posts
  .where(p => eq(p.user!.username, 'alice'))
  .update({ subtitle: 'by alice' })
  .affectedCount();   // 2
```

```sql
UPDATE "posts" SET "subtitle" = $1 FROM "users" AS "user" WHERE "posts"."user_id" = "user"."id" AND "user"."username" = $2
-- params: [ "by alice", "alice" ]
```

`db.<table>.update(values)` without `where()` updates EVERY row (`WHERE TRUE`), with the same mappers, RETURNING,
`affectedCount()` and `toStatement()`:

```ts
const all = await db.tags.update(t => ({ name: sql<string>`upper(${t.name})` })).affectedCount();   // 3
```

```sql
UPDATE "tags" SET "name" = upper("tags"."name") WHERE TRUE
```

- Keys that are not columns are ignored; with no column at all it throws `No valid columns to update` before sending.
- A key whose value is `undefined` is still assigned: `update({ email, age: undefined })` sends `"age" = $2` with
  `null` and clears the column. Leave the key out to keep the stored value.
- `lateralJoin()` (since 1.0.23) and `crossJoinLateral()` cannot be combined with `update()` / `delete()` (refused).
- A bare `await` resolves `undefined`, not a count: use `.affectedCount()`.

### Add or remove one value of an array column: `arrayAppendUnique()`, `arrayRemove()` (since 1.0.31)

`arrayAppendUnique(column, value)` and `arrayRemove(column, value)` are UPDATE values that change an array column inside
the statement, from each row's current array: no read-modify-write, and running the statement again changes nothing
more. The example model has no array column; these use the `books` table (`tags text[]`) and its `library` context
from [SQL Expression Helpers](./sql-expressions.md#query-array-columns).

```ts
import { arrayAppendUnique, arrayContainsAll, arrayRemove, eqAny } from 'linkgress-orm';

// Dune (id 1): tags ['novel', 'classic'] · Odes (2): ['poetry'] · Draft (3): NULL
await library.books.where(b => eqAny(b.id, [1, 3])).update(b => ({ tags: arrayAppendUnique(b.tags, 'classic') }));
await library.books.where(b => arrayContainsAll(b.tags, ['novel'])).update(b => ({ tags: arrayRemove(b.tags, 'novel') }));
// Dune: ['classic'] (it held 'classic' already) · Odes: ['poetry'] · Draft: ['classic'] (a NULL array counts as empty)
```

```sql
UPDATE "books" SET "tags" = (CASE WHEN CAST($1 AS text) = ANY("books"."tags") THEN "books"."tags" ELSE array_append(COALESCE("books"."tags", CAST('{}' AS text[])), CAST($2 AS text)) END) WHERE ("books"."id" = ANY($3::integer[]))
-- params: [ "classic", "classic", "{1,3}" ]
UPDATE "books" SET "tags" = array_remove("books"."tags", CAST($1 AS text)) WHERE ("books"."tags" @> CAST($2 AS text[]))
-- params: [ "novel", "{\"novel\"}" ]
```

- `arrayAppendUnique` appends the value unless the array holds it, and treats a NULL array as empty. A `null` value
  throws before anything is sent (NULL equals nothing, so it would be appended on every run).
- `arrayRemove` removes every occurrence of the value; an array without it, and a NULL array, stay as they are.
- Select the rows by key (`eqAny`), or for a removal by `arrayContainsAll(col, [v])` (`@>`, which a GIN index
  serves): without `where()` the UPDATE rewrites every row of the table. Both directions in one statement (a
  `caseWhen` over the two), `null` elements and the element cast:
  [Change an array in place](./sql-expressions.md#change-an-array-in-place-arrayappendunique-arrayremove-since-1031).

### Read the row as it was before the update: `old` (PostgreSQL 18)

The `.returning()` selector's second argument is PostgreSQL 18's `old` row: the row's own columns BEFORE the update (for
a delete, the deleted row), each read through its column's mapper. Use it to learn whether THIS call made a transition,
without a `SELECT … FOR UPDATE` first.

```ts
const [task] = await db.tasks
  .where(t => eq(t.title, 'Important Task'))
  .update({ status: 'completed' })
  .returning((t, old) => ({
    id: t.id,
    status: t.status,
    previous: old.status,
    changed: ne(t.status, old.status),
  }));
// { id: 1, status: 'completed', previous: 'pending', changed: true }
```

```sql
UPDATE "tasks" SET "status" = $1 WHERE "tasks"."title" = $2 RETURNING "id" AS "id", "status" AS "status", old."status" AS "previous", ("status" != old."status") AS "changed"
-- params: [ "completed", "Important Task" ]
```

- `old` has the table's own columns only (typed `ColumnRow<T>`); a navigation off `old` throws.
- `old` cannot be combined with navigations, collections or nested objects in one RETURNING (those run the write as a
  CTE, where `old` is out of scope): it throws `RETURNING old cannot be combined with navigations or collections (nor
  nested objects) in one RETURNING …`. Read the old values in a flat RETURNING.
- `toStatement()` renders `old` too, but its selector is typed with one argument.

## Update many rows, each with its own values: `bulkUpdate()`

`bulkUpdate(rows, config?)` matches rows by key (default: the primary key) and gives each its own values in one
`UPDATE … AS t SET … FROM (VALUES …) AS v WHERE t.<key> = v.<key>`. A column a row omits keeps its stored value, so
rows can be sparse. Use it for per-row values; the same value for all rows is `where().update()`, rows that may not
exist yet are `upsertBulk()`.

The loop it replaces:

```ts
const changes = [
  { id: 1, age: 26, email: 'alice@new.com' },
  { id: 2, age: 36 },                          // email not provided: kept
  { id: 3, email: 'charlie@new.com' },         // age not provided: kept
];

for (const { id, ...values } of changes) {
  await db.users.where(u => eq(u.id, id)).update(values);
}
```

```sql
UPDATE "users" SET "age" = $1, "email" = $2 WHERE "users"."id" = $3
-- params: [ 26, "alice@new.com", 1 ]
UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [ 36, 2 ]
UPDATE "users" SET "email" = $1 WHERE "users"."id" = $2
-- params: [ "charlie@new.com", 3 ]
```

One statement:

```ts
await db.users.bulkUpdate(changes);
```

```sql
UPDATE "users" AS t
SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END, "email" = CASE WHEN v."email__provided" THEN v."email" ELSE t."email" END
FROM (VALUES ($1::integer, $2::integer, true, $3::text, true), ($4::integer, $5::integer, true, NULL::text, false), ($6::integer, NULL::integer, false, $7::text, true)) AS v("id", "age", "age__provided", "email", "email__provided")
WHERE t."id" = v."id"
-- params: [ 1, 26, "alice@new.com", 2, 36, 3, "charlie@new.com" ]
```

| A row's value for a column | Result |
|---|---|
| key absent | stored value kept (`<col>__provided` is `false`) |
| `null` | NULL written (provided) |
| `undefined` with the key present (`{ id: 3, age: undefined }`) | NULL written: the key counts as provided |
| a value | written, through the column's mapper and cast to its type |

```ts
const patch: { id: number; age?: number; email?: string } = { id: 3, age: undefined, email: 'charlie@new.com' };
await db.users.bulkUpdate([patch]);   // age is written as NULL: the key is present
```

```sql
UPDATE "users" AS t
SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END, "email" = CASE WHEN v."email__provided" THEN v."email" ELSE t."email" END
FROM (VALUES ($1::integer, NULL::integer, true, $2::text, true)) AS v("id", "age", "age__provided", "email", "email__provided")
WHERE t."id" = v."id"
-- params: [ 3, "charlie@new.com" ]
```

```ts
const updated = await db.users
  .bulkUpdate([{ id: 1, age: 27 }, { id: 999, age: 1 }])
  .returning(u => ({ id: u.id, age: u.age }));
// [{ id: 1, age: 27 }]: id 999 does not exist, no row and no error

await db.users.bulkUpdate([{ username: 'bob', age: null }], { primaryKey: 'username' });
```

```sql
UPDATE "users" AS t
SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END
FROM (VALUES ($1::integer, $2::integer, true), ($3::integer, $4::integer, true)) AS v("id", "age", "age__provided")
WHERE t."id" = v."id" RETURNING t."id" AS "id", t."age" AS "age"
-- params: [ 1, 27, 999, 1 ]
UPDATE "users" AS t
SET "age" = CASE WHEN v."age__provided" THEN v."age" ELSE t."age" END
FROM (VALUES ($1::varchar, NULL::integer, true)) AS v("username", "age", "age__provided")
WHERE t."username" = v."username"
-- params: [ "bob" ]
```

`set` replaces a column's assignment with an expression over the target row (`target`, alias `t`) and the incoming row
(`values`, alias `v`); `where` adds a guard to the key match:

```ts
await db.productTags.bulkUpdate(
  [{ productId: 1, tagId: 2, sortOrder: 10 }, { productId: 2, tagId: 1, sortOrder: 20 }],
  {
    primaryKey: ['productId', 'tagId'],
    set: (target, values) => ({ sortOrder: add(coalesce(target.sortOrder, 0), values.sortOrder) }),
    where: target => ne(target.sortOrder, 0),
  },
);

// rows may carry only the key when set assigns everything
await db.posts.bulkUpdate([{ id: 1 }, { id: 2 }], { set: target => ({ views: add(target.views, 1) }) });
```

```sql
UPDATE "product_tags" AS t
SET "sort_order" = (COALESCE("t"."sort_order", $7) + "v"."sort_order")
FROM (VALUES ($1::integer, $2::integer, $3::integer, true), ($4::integer, $5::integer, $6::integer, true)) AS v("product_id", "tag_id", "sort_order", "sort_order__provided")
WHERE t."product_id" = v."product_id" AND t."tag_id" = v."tag_id" AND ("t"."sort_order" != $8)
-- params: [ 1, 2, 10, 2, 1, 20, 0, 0 ]
UPDATE "posts" AS t
SET "views" = ("t"."views" + $3)
FROM (VALUES ($1::integer), ($2::integer)) AS v("id")
WHERE t."id" = v."id"
-- params: [ 1, 2, 1 ]
```

- Every row must carry the key: `Record at index 1 is missing primary key "id"` is thrown before sending.
- `set` cannot assign a key column, and `values.<col>` must be a column some row provides; both throw before sending.
  Rows with only the key and no `set` throw `No columns to update (only primary keys provided)`.
- RETURNING columns are qualified `t."col"`. A navigation or collection in the selector runs the UPDATE in a
  `"__mutation__"` CTE.
- Chunking follows the `insertBulk` rule (keys of the first row); `chunkSize` overrides it.
- `MutationBatch.addBulkUpdate` takes the same `primaryKey` / `set` / `where`.

> **Efficiency:** 1 statement per chunk instead of n. Every cell is cast and every non-key cell carries a provided
> flag (`$2::integer, true`), and the text changes with the row count.

## Delete rows: `where().delete()`

`db.<table>.where(cond).delete()` sends one `DELETE … WHERE …`. Read the removed rows with `.returning(selector)`, count
them with `.affectedCount()`. A list of ids is one `eqAny` delete, not a loop. Foreign-key cascades run on the server
and cost no round trip.

```ts
const removed = await db.postComments
  .where(c => eq(c.comment, 'My order update'))
  .delete()
  .returning(c => ({ id: c.id, postId: c.postId }));   // [{ id: 3, postId: 3 }]

const count = await db.postComments.where(c => eqAny(c.id, [1, 2])).delete().affectedCount();   // 2
```

```sql
DELETE FROM "post_comments" WHERE "post_comments"."comment" = $1 RETURNING "id" AS "id", "post_id" AS "postId"
-- params: [ "My order update" ]
DELETE FROM "post_comments" WHERE ("post_comments"."id" = ANY($1::integer[]))
-- params: [ "{1,2}" ]
```

The loop the `eqAny` delete replaces:

```ts
for (const id of [1, 2]) {
  await db.postComments.where(c => eq(c.id, id)).delete();
}
```

```sql
DELETE FROM "post_comments" WHERE "post_comments"."id" = $1
-- params: [ 1 ]
DELETE FROM "post_comments" WHERE "post_comments"."id" = $1
-- params: [ 2 ]
```

A condition through a navigation renders `DELETE … USING`; `old` works as in an update; `delete()` without `where()`
deletes every row:

```ts
const viaNav = await db.posts.where(p => eq(p.user!.username, 'bob')).delete().affectedCount();   // 1

const gone = await db.orderTasks
  .where(ot => gt(ot.sortOrder, 0))
  .delete()
  .returning((ot, old) => ({ orderId: ot.orderId, oldSort: old.sortOrder }));

const all = await db.cartDiscountCodes.delete().affectedCount();   // 3
```

```sql
DELETE FROM "posts" USING "users" AS "user" WHERE "posts"."user_id" = "user"."id" AND "user"."username" = $1
-- params: [ "bob" ]
DELETE FROM "order_task" WHERE "order_task"."sort_order" > $1 RETURNING "order_id" AS "orderId", old."sort_order" AS "oldSort"
-- params: [ 0 ]
DELETE FROM "cart_discount_codes" WHERE TRUE
```

- With `USING` joins, RETURNING columns are qualified by the table name.
- `db.users.delete()` has no safety guard: it deletes every user.
- To empty a table, a raw `TRUNCATE` (`db.query('TRUNCATE …')`) skips the per-row work of `DELETE … WHERE TRUE`, but
  it takes an ACCESS EXCLUSIVE lock and refuses a table another table's foreign key references:
  `db.query('TRUNCATE "users"')` fails with 0A000 `cannot truncate a table referenced in a foreign key constraint`
  (name the referencing tables too, or add CASCADE).
- `.toStatement(selector)` compiles the DELETE for a [data-modifying CTE](#feed-one-write-into-another-in-one-statement-data-modifying-ctes)
  (an archive in one statement).

## Read back what a write changed: `.returning(selector)`

Every write's `.returning(selector)` (`insert`, `insertBulk`, `insertFrom`, `upsert`, `upsertBulk`, `mergeBulk`,
`bulkUpdate`, `where().update()`, `where().delete()`, `update()` / `delete()` over every row, and both sides of
`insertWithChildren` / `insertBulkWithChildren`) reads the written rows the way a `select()` reads rows, in the write's
own statement (one exception: a `*WithChildren` parent selector that reads more than the parent's own columns is read
back by a second `SELECT`, [below](#insert-a-parent-and-its-children-in-one-statement-insertwithchildren)). Use it
instead of a follow-up `SELECT`; use `.affectedCount()` when a count is enough.

A selector of the row's own columns, expressions over them, conditions and literals renders the write's own RETURNING
list:

```ts
const flat = await db.posts
  .where(p => eq(p.title, 'Alice Post 1'))
  .update({ subtitle: 'edited' })
  .returning(p => ({
    id: p.id,
    at: p.publishTime,                     // a mapped column: read through its mapper
    shouted: sql<string>`upper(${p.title})`, // an sql expression over the row
    popular: gt(p.views, 100),             // a condition: a boolean
    source: 'edit',                         // a literal: returned as is, not read from the database
  }));
// [{ id: 1, at: { hour: 9, minute: 30 }, shouted: 'ALICE POST 1', popular: false, source: 'edit' }]
```

```sql
UPDATE "posts" SET "subtitle" = $1 WHERE "posts"."title" = $2 RETURNING "id" AS "id", "publish_time" AS "at", upper("title") AS "shouted", ("views" > $3) AS "popular"
-- params: [ "edited", "Alice Post 1", 100 ]
```

A navigation, a collection or a nested object reading one runs the write as a `"__mutation__"` CTE the navigations are
joined onto, still one statement:

```ts
const rich = await db.posts
  .where(p => eq(p.title, 'Alice Post 1'))
  .update({ subtitle: 'edited again' })
  .returning(p => ({
    id: p.id,
    author: p.user!.username,                          // a navigation, joined onto the written row
    meta: { by: 'batch', email: p.user!.email },        // a nested object
    comments: p.postComments!.count(),                 // a collection aggregate
  }));
// [{ id: 1, author: 'alice', meta: { by: 'batch', email: 'alice@test.com' }, comments: 1 }]
```

```sql
WITH "__mutation__" AS (
  UPDATE "posts" SET "subtitle" = $1 WHERE "posts"."title" = $2 RETURNING "posts"."id", "posts"."user_id"
)
SELECT "__mutation__"."id" AS "id", "user"."username" AS "author", "user"."email" AS "meta.email", (SELECT COALESCE(COUNT(*), 0)
FROM "post_comments" "lateral_0_postComments"
WHERE "lateral_0_postComments"."post_id" = "__mutation__"."id") AS "comments"
FROM "__mutation__"
INNER JOIN "users" AS "user" ON "__mutation__"."user_id" = "user"."id"
-- params: [ "edited again", "Alice Post 1" ]
```

| Selector element | Reads back as |
|---|---|
| a column, under any key | its value through its own column mapper; a value returned under a mapped column's NAME (another column, an expression, a literal) keeps its own value |
| an `sql` expression | its value; over the row's own columns it stays in the write's RETURNING, over a navigation it makes the write a CTE; its parameters bind like any other and its `mapWith` applies |
| a condition (`eq`, `and`, …) | a boolean |
| a subquery | its value |
| a literal (`'edit'`, `42`, `true`, `null`, a `Date`, a list of values) | itself, not read from the database |
| `undefined` | the key is left out |
| one value instead of an object (`u => u.id`, `p => p.user!.username`) | `insert()`: that value; every other write: the list of values |
| a navigation (`p.user!.username`), any number of hops deep | joined onto the written row; each hop on its own parent, middle hops need not be projected; the column reads through its own column's mapper |
| a navigation row projected whole (`post: c.post!`) | an object of its columns, all `null` when the navigation is NULL |
| a collection (`toList()`, `firstOrDefault()`, `count()`, `min()`, `max()`, `sum()`, `exists()`, `toNumberList()`, `toStringList()`) | as in a `select()`, items through their columns' mappers; a collection selecting one value returns the values (`string[]`) |
| an array of columns (`[u.id, u.username]`) | refused: it has no single SQL value; select an object, or build the array in SQL |

```ts
const comment = await db.postComments
  .insert({ postId: 1, orderId: 1, comment: 'Shipped' })
  .returning(c => ({
    id: c.id,
    author: c.post!.user!.username,
    post: c.post!,
  }));
// { id: 4, author: 'alice', post: { id: 1, title: 'Alice Post 1', …, publishTime: { hour: 9, minute: 30 }, … } }
```

```sql
WITH "__mutation__" AS (
  INSERT INTO "post_comments" ("post_id", "order_id", "comment") VALUES ($1, $2, $3) RETURNING "id", "post_id"
)
SELECT "__mutation__"."id" AS "id", "user"."username" AS "author", "post"."id" AS "post.id", "post"."title" AS "post.title", "post"."subtitle" AS "post.subtitle", "post"."content" AS "post.content", "post"."user_id" AS "post.userId", "post"."published_at" AS "post.publishedAt", "post"."views" AS "post.views", "post"."publish_time" AS "post.publishTime", "post"."custom_date" AS "post.customDate", "post"."string_stamped_at" AS "post.stringStampedAt", "post"."category" AS "post.category"
FROM "__mutation__"
LEFT JOIN "posts" AS "post" ON "__mutation__"."post_id" = "post"."id"
INNER JOIN "users" AS "user" ON "post"."user_id" = "user"."id"
-- params: [ 1, 1, "Shipped" ]
```

A collection in RETURNING reads the tables as of the statement's start: it does not see rows the statement itself
writes (PostgreSQL gives every part of one statement one snapshot):

```ts
const fresh = await db.posts
  .insert({ title: 'Third', userId: 1 })
  .returning(p => ({ id: p.id, authorPosts: p.user!.posts!.count() }));
// { id: 4, authorPosts: 2 }: alice has 3 posts after the insert
```

```sql
WITH "__mutation__" AS (
  INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2) RETURNING "id", "user_id"
)
SELECT "__mutation__"."id" AS "id", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "user"."id") AS "authorPosts"
FROM "__mutation__"
INNER JOIN "users" AS "user" ON "__mutation__"."user_id" = "user"."id"
-- params: [ "Third", 1 ]
```

- `.returning()` with no selector sends every column; a selector sends only what it names.
- For an upsert or a merge, navigations read the rows as they are after the insert or the update, so a navigation
  follows a key the update set.
- Two paths ending in the same relation name get a join each: the shallowest keeps the plain name, every other renders
  `<parentAlias>__<relation>` (see [Navigation joins and their aliases](./querying.md#navigation-joins-and-their-aliases)). A path alias longer than PostgreSQL's 63-byte identifier
  limit is refused before anything is written, naming the paths: read one of them in a separate query, or shorten a
  relation name.
- A collection hanging off a navigation renders with the `lateral` strategy and follows its path from the written row,
  with `limit()` / `offset()` and with a nested collection in its `where` too.
- `mergeBulk` and `bulkUpdate` qualify the row's columns by the target alias (`t."col"`).
- `insertFrom`'s `with` CTEs are declared ahead of the `"__mutation__"` CTE in the one `WITH`.
- `.toStatement(selector)` takes an object of columns, expressions and literals; there a literal binds as a parameter
  (`RETURNING "id" AS "id", $3 AS "tag"`). A selector returning one value, or reading a navigation or collection, is
  refused.

## Insert a parent and its children in one statement: `insertWithChildren()`

`insertWithChildren({ row, children, returning })` inserts one parent and its child rows in ONE statement: the children
receive the new parent key through a CTE. `insertBulkWithChildren()` does the same for N parents, each child naming its
parent by `parentIndex`. Use them when children need a generated parent id; a childless parent is a plain `insert()`.

The sequence it replaces, 2 round trips and not atomic outside a transaction:

```ts
const parent = await db.users.insert({ username: 'dave', email: 'dave@test.com' }).returning(u => ({ id: u.id }));
await db.posts.insertBulk([
  { userId: parent.id, title: 'Draft 1' },
  { userId: parent.id, title: 'Draft 2' },
]);
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: [ "dave", "dave@test.com" ]
INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2), ($3, $4)
-- params: [ "Draft 1", 4, "Draft 2", 4 ]
```

One statement:

```ts
const { parent: user, children: posts } = await db.users.insertWithChildren({
  row: { username: 'erin', email: 'erin@test.com' },
  children: {
    table: db.posts,
    foreignKey: 'userId',                       // the child property that receives the parent key
    rows: [{ title: 'Hello' }, { title: 'World' }],
  },
  returning: {
    parent: u => ({ id: u.id, username: u.username }),
    children: p => ({ id: p.id, title: p.title }),
  },
});
// user: { id: 5, username: 'erin' }; posts: [{ id: 6, title: 'Hello' }, { id: 7, title: 'World' }]
```

```sql
WITH "__iwc_parent__" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES ($1::varchar, $2::text)) AS v("username", "email")
RETURNING *
),
"__mutation__" AS (
INSERT INTO "posts" ("user_id", "title")
SELECT p."id", v."title" FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, $3::varchar), (1, $4::varchar)) AS v("__iwc_ord", "title")
ORDER BY v."__iwc_ord"
RETURNING "id" AS "id", "title" AS "title", "id" AS "__iwc_child_pk__"
)
SELECT "__mutation__".*, "__iwc_parent_j__"."id" AS "__iwc_parent__.id", "__iwc_parent_j__"."username" AS "__iwc_parent__.username"
FROM "__mutation__"
CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"
ORDER BY "__mutation__"."__iwc_child_pk__"
-- params: [ "erin", "erin@test.com", "Hello", "World" ]
```

`unlessExists` suppresses the whole insert when a query yields a row, in the same snapshot:

```ts
const guarded = await db.users.insertWithChildren({
  row: { username: 'erin2', email: 'erin@test.com' },
  unlessExists: { future: () => db.users.where(u => eq(u.email, 'erin@test.com')).select(u => ({ id: u.id })).future() },
  children: { table: db.posts, foreignKey: 'userId', rows: [{ title: 'never written' }] },
  returning: { parent: u => ({ id: u.id }), children: p => ({ id: p.id }) },
});
// { parent: null, children: [] }
```

```sql
WITH "__iwc_parent__" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES ($1::varchar, $2::text)) AS v("username", "email")
WHERE NOT EXISTS (SELECT 1 FROM (
SELECT "users"."id" as "id"
FROM "users"
WHERE "users"."email" = $3
) "__iwc_guard__")
RETURNING *
),
"__mutation__" AS (
INSERT INTO "posts" ("user_id", "title")
SELECT p."id", v."title" FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, $4::varchar)) AS v("__iwc_ord", "title")
ORDER BY v."__iwc_ord"
RETURNING "id" AS "id", "id" AS "__iwc_child_pk__"
)
SELECT "__mutation__".*, "__iwc_parent_j__"."id" AS "__iwc_parent__.id"
FROM "__mutation__"
CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"
ORDER BY "__mutation__"."__iwc_child_pk__"
-- params: [ "erin2", "erin@test.com", "erin@test.com", "never written" ]
```

N parents in one statement:

```ts
const { parents, children } = await db.users.insertBulkWithChildren({
  rows: [{ username: 'gina', email: 'gina@test.com' }, { username: 'hugo', email: 'hugo@test.com' }],
  children: {
    table: db.posts,
    foreignKey: 'userId',
    rows: [
      { parentIndex: 0, row: { title: 'Gina 1' } },
      { parentIndex: 1, row: { title: 'Hugo 1' } },
      { parentIndex: 1, row: { title: 'Hugo 2' } },
    ],
  },
  returning: {
    parents: u => ({ id: u.id, username: u.username }),
    children: p => ({ id: p.id, userId: p.userId, title: p.title }),
  },
});
// parents: [{ id: 6, username: 'gina' }, { id: 7, username: 'hugo' }]
// children: [{ id: 8, userId: 6, title: 'Gina 1' }, { id: 9, userId: 7, … }, { id: 10, userId: 7, … }]
```

```sql
WITH "__ibwc_parent__" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES (0, $1::varchar, $2::text), (1, $3::varchar, $4::text)) AS v("__ibwc_ord", "username", "email")
ORDER BY v."__ibwc_ord"
RETURNING *
),
"__ibwc_pord__" AS (
  SELECT p.*, row_number() OVER (ORDER BY p."id") - 1 AS "__ibwc_ord"
  FROM "__ibwc_parent__" p
),
"__mutation__" AS (
INSERT INTO "posts" ("user_id", "title")
SELECT p."id", v."title"
FROM (VALUES (0, 0, $5::varchar), (1, 1, $6::varchar), (2, 1, $7::varchar)) AS v("__ibwc_cord", "__ibwc_pix", "title")
JOIN "__ibwc_pord__" p ON p."__ibwc_ord" = v."__ibwc_pix"
ORDER BY v."__ibwc_cord"
RETURNING "id" AS "id", "user_id" AS "userId", "title" AS "title", "user_id" AS "__ibwc_child_fk__", "id" AS "__ibwc_child_pk__"
)
SELECT "__mutation__".*, "__ibwc_pj__"."__ibwc_ord" AS "__ibwc_parent__.__ord", "__ibwc_pj__"."id" AS "__ibwc_parent__.id", "__ibwc_pj__"."username" AS "__ibwc_parent__.username"
FROM "__mutation__"
JOIN "__ibwc_pord__" "__ibwc_pj__" ON "__ibwc_pj__"."id" = "__mutation__"."__ibwc_child_fk__"
ORDER BY "__mutation__"."__ibwc_child_pk__"
-- params: [ "gina", "gina@test.com", "hugo", "hugo@test.com", "Gina 1", "Hugo 1", "Hugo 2" ]
```

| Rule | `insertWithChildren` | `insertBulkWithChildren` |
|---|---|---|
| Child rows | non-empty; must not carry the foreign key (thrown: `child row at index 0 carries the foreign-key property "userId" — it is sourced from the inserted parent`) | the same, and every parent needs at least one child (`parent at index 1 has no child row …`); `parentIndex` must be in range |
| Primary key | the parent's: one auto-generated column | both tables: one auto-generated column each |
| Size limit | child rows ≤ `floor(floor(65 535 ÷ (child columns + 1)) × 0.6)` | parents + children ≤ `floor(floor(65 535 ÷ (child columns + 2)) × 0.6)` |
| Order | child ids ascend in input order; `children` comes back in input order | parents and children come back in input order (serial ids ascend in input order, recovered with `row_number()`) |
| Guard | `unlessExists`: same snapshot, not race-safe; a match gives `{ parent: null, children: [] }` | none |

- The child selector supports navigations and collections in the same statement; a child's navigation to the parent
  TABLE reads the parents inserted by the statement together with the table's other rows.
- A parent selector of the parent's own columns rides the statement. One reading a navigation, a collection, a nested
  object or an expression is read back by the parents' keys with one more `SELECT` after the statement (2 round trips),
  so a parent's collection of children includes the new ones:

```ts
const readBack = await db.users.insertWithChildren({
  row: { username: 'finn', email: 'finn@test.com' },
  children: { table: db.posts, foreignKey: 'userId', rows: [{ title: 'Only post' }] },
  returning: {
    parent: u => ({ id: u.id, postCount: u.posts!.count() }),
    children: p => ({ id: p.id, author: p.user!.username }),
  },
});
// { parent: { postCount: 1, id: 8 }, children: [{ id: 11, author: 'finn' }] }
```

```sql
WITH "__iwc_parent__" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES ($1::varchar, $2::text)) AS v("username", "email")
RETURNING *
),
"__mutation__" AS (
  INSERT INTO "posts" ("user_id", "title")
SELECT p."id", v."title" FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, $3::varchar)) AS v("__iwc_ord", "title")
ORDER BY v."__iwc_ord" RETURNING "id", "user_id"
)
SELECT "__mutation__"."id" AS "id", "user"."username" AS "author", "__iwc_parent_j__"."id" AS "__iwc_parent__.__pk"
FROM "__mutation__"
CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"
INNER JOIN (SELECT * FROM "__iwc_parent__" UNION ALL SELECT * FROM "users") AS "user" ON "__mutation__"."user_id" = "user"."id"
ORDER BY "__mutation__"."id"
-- params: [ "finn", "finn@test.com", "Only post" ]
SELECT "users"."id" as "id", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount"
FROM "users"
WHERE "users"."id" IN ($1)
ORDER BY "id" ASC
-- params: [ 8 ]
```

> **Efficiency:** atomic, 1 statement instead of 2 per parent. Both calls are sent unprepared (their VALUES lists make
> every text unique). To combine them with other writes, or to allow childless parents, use the `MutationBatch` leg
> `addInsertBulkWithChildren`.

## Run independent writes in one round trip: `MutationBatch`

`MutationBatch` composes independent writes on any tables (insert, bulk update, upsert, delete and update-by-list legs)
into ONE data-modifying-CTE statement: one round trip, atomic, with a count per leg. Use it for the writes of one unit
of work that do not depend on each other. Writes that must see each other's rows need
[`addDependentInsert()`](#write-an-audit-row-only-when-a-value-really-changed-adddependentinsert) or a
[CTE chain](#feed-one-write-into-another-in-one-statement-data-modifying-ctes).

The sequence it replaces, 3 round trips and 3 commits:

```ts
await db.tags.insertBulk([{ name: 'Autumn' }, { name: 'Spring' }]);
await db.products.bulkUpdate([{ id: 1, name: 'Hardback (2nd ed.)' }]);
await db.postComments.where(c => eq(c.id, 3)).delete();
```

```sql
INSERT INTO "tags" ("name") VALUES ($1), ($2)
-- params: [ "Autumn", "Spring" ]
UPDATE "products" AS t
SET "name" = CASE WHEN v."name__provided" THEN v."name" ELSE t."name" END
FROM (VALUES ($1::integer, $2::varchar, true)) AS v("id", "name", "name__provided")
WHERE t."id" = v."id"
-- params: [ 1, "Hardback (2nd ed.)" ]
DELETE FROM "post_comments" WHERE "post_comments"."id" = $1
-- params: [ 3 ]
```

One statement:

```ts
import { MutationBatch } from 'linkgress-orm';

const batch = new MutationBatch();
const tags = batch.addInsertBulk(db.tags, [{ name: 'Winter sale' }, { name: 'Gift' }], 'tags', { returning: ['id', 'name'] });
batch.addBulkUpdate(db.products, [{ id: 2, name: 'Lift Ticket (day)' }], 'products');
batch.addDeleteWhereIn(db.postComments, 'id', [1, 2], 'comments');
batch.addUpdateWhereIn(db.users, 'id', [1, 2], { age: 18 }, 'users');
const skipped = batch.addInsertBulk(db.tags, [], 'nothing');   // empty rows: registers nothing, returns null

await batch.executeBatch();
batch.getAffectedCount(tags!);          // 2
batch.getLegRows('tags');               // [{ id: 6, name: 'Winter sale' }, { id: 7, name: 'Gift' }]
batch.getAffectedCount('products');     // 1
batch.getAffectedCount('comments');     // 2
batch.getAffectedCount('users');        // 2
```

```sql
WITH "__mb_0" AS (
INSERT INTO "tags" ("name") VALUES ($1), ($2)
RETURNING "id" AS "id", "name" AS "name"
),
"__mb_1" AS (
UPDATE "products" AS t
SET "name" = CASE WHEN v."name__provided" THEN v."name" ELSE t."name" END
FROM (VALUES ($3::integer, $4::varchar, true)) AS v("id", "name", "name__provided")
WHERE t."id" = v."id"
RETURNING 1
),
"__mb_2" AS (
DELETE FROM "post_comments" WHERE "id" IN ($5, $6)
RETURNING 1
),
"__mb_3" AS (
UPDATE "users" SET "age" = $7 WHERE "id" IN ($8, $9)
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT COALESCE(json_agg(row_to_json("__mb_0")), '[]'::json) FROM "__mb_0") AS "0__rows", (SELECT count(*)::int FROM "__mb_1") AS "1", (SELECT count(*)::int FROM "__mb_2") AS "2", (SELECT count(*)::int FROM "__mb_3") AS "3"
-- params: [ "Winter sale", "Gift", 2, "Lift Ticket (day)", 1, 2, 18, 1, 2 ]
```

| Leg | Signature | Statement |
|---|---|---|
| insert | `addInsertBulk(table, rows, id, { onConflictDoNothing?, overridingSystemValue?, rowGuard?, returning? })` | `INSERT … VALUES …` |
| bulk update | `addBulkUpdate(table, rows, id, { primaryKey?, set?, where? })` | `UPDATE … FROM (VALUES …)` |
| upsert | `addUpsertBulk(table, rows, { primaryKey, updateColumns?, updateSet?, updateWhere?, targetWhere? }, id, { returning? })` | `INSERT … ON CONFLICT …` |
| delete by list | `addDeleteWhereIn(table, property, values, id)` | `DELETE FROM … WHERE "col" IN (…)` |
| update by list | `addUpdateWhereIn(table, property, values, set, id, { exposeColumns?, exposeOldColumns? })` | `UPDATE … SET … WHERE "col" IN (…)` |
| dependent insert | `addDependentInsert(table, row, { onLeg, whereColumn, whereNotEquals }, id)` | `INSERT … SELECT … FROM "<parent leg>" WHERE "<col>" <> $n` |
| parents with children | `addInsertBulkWithChildren(table, { rows, children }, id, { parentReturning? })` | three CTEs |

Members: `size` (registered legs), `parameterCount` (since 1.0.29; the statement's parameters), `executeBatch()`,
`getAffectedCount(key)` and `getLegRows(key)` (both only after `executeBatch()`).

- An insert, bulk-update or upsert leg sends the SQL its standalone call sends (same mappers, same provided flags), so
  its result is the standalone result, under PostgreSQL's data-modifying-CTE rules below. The list legs render
  `"col" IN ($1, …)`, one parameter per value, through the column's mapper.
- All legs run on ONE snapshot: a leg does not see another leg's writes. Never point two legs at the same row (one
  silently wins).
- A registration with empty input registers nothing and returns `null`; a batch whose legs were all empty sends nothing.
- Leg ids must be unique (`MutationBatch: duplicate leg identifier "a"`). A batch is one-shot: executing or registering
  after `executeBatch()` throws.
- Every leg must come from the same context: legs of `db` and of a transaction's `tx` in one batch are refused
  (`MutationBatch: leg "tx" uses a different database client or transaction than the rest of the batch …`). Inside a
  transaction, build every leg from `tx.<table>`.
- A leg above `floor(floor(65 535 ÷ columns) × 0.6)` rows throws at registration: run it standalone (it needs chunking).
  `executeBatch()` refuses a statement over 65 535 parameters (the client's `maxParameters()` when lower: PGlite 32 767)
  before sending: `MutationBatch: the statement binds 70000 parameters — over PostgreSQL's 65 535: execute some of its
  legs in another batch ("a": 35000, "b": 35000)`. Check `parameterCount` before adding an optional leg.
- Delete legs for a parent and its children work when the child's foreign key is NO ACTION (PostgreSQL's default,
  checked at the end of the statement); a RESTRICT key rejects the parent leg, so keep such pairs in separate
  statements.
- The statement is sent unprepared: its text follows the legs' VALUES lists.

> **Pitfall:** Legs share one snapshot. An update leg does not see the row an insert leg of the same batch writes:

```ts
const blind = new MutationBatch();
blind.addInsertBulk(db.tags, [{ name: 'Fresh' }], 'insert');
blind.addUpdateWhereIn(db.tags, 'name', ['Fresh'], { name: 'Renamed' }, 'update');
await blind.executeBatch();
// insert: 1, update: 0
```

```sql
WITH "__mb_0" AS (
INSERT INTO "tags" ("name") VALUES ($1)
RETURNING 1
),
"__mb_1" AS (
UPDATE "tags" SET "name" = $2 WHERE "name" IN ($3)
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT count(*)::int FROM "__mb_1") AS "1"
-- params: [ "Fresh", "Renamed", "Fresh" ]
```

### Insert only the rows that pass a per-row check: `rowGuard`

`addInsertBulk(table, rows, id, { rowGuard })` inserts each candidate row only when a per-row predicate holds:
`INSERT … SELECT … FROM (VALUES …) AS v(…) WHERE <guard>`. Blocked rows show up as a short `getAffectedCount(id)`. The
guard is a typed condition over the candidate row `v`, or raw SQL over `v."<column>"`.

```ts
import { and, eq, gt, literal, notExists } from 'linkgress-orm';

const guarded = new MutationBatch();
const posts = guarded.addInsertBulk(db.posts, [
  { title: 'Alice Post 1', userId: 1, views: 50 },   // a post of that title exists: blocked
  { title: 'Fresh post', userId: 1, views: 50 },
  { title: 'Low views', userId: 2, views: 5 },       // views <= 10: blocked
], 'posts', {
  rowGuard: v => and(
    gt(v.views, 10),
    notExists(db.posts.where(p => and(eq(p.userId, v.userId), eq(p.title, v.title))).select(() => ({ one: literal(1) })).asSubquery()),
  ),
});
await guarded.executeBatch();
guarded.getAffectedCount(posts!);   // 1 of 3
```

```sql
WITH "__mb_0" AS (
INSERT INTO "posts" ("title", "user_id", "views")
SELECT v."title", v."user_id", v."views" FROM (VALUES ($1::varchar, $2::integer, $3::integer), ($4::varchar, $5::integer, $6::integer), ($7::varchar, $8::integer, $9::integer)) AS v("title", "user_id", "views")
WHERE ("v"."views" > $10 AND (NOT EXISTS (SELECT 1 as "one"
FROM "posts"
WHERE ("posts"."user_id" = "v"."user_id" AND "posts"."title" = "v"."title"))))
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0"
-- params: [ "Alice Post 1", 1, 50, "Fresh post", 1, 50, "Low views", 2, 5, 10 ]
```

- A typed guard may bind parameters (they continue the leg's numbering). `v` is typed as the table's column row
  (`ColumnRow`); every `v.<column>` it reads must be a column some row provides, and navigations of `v` are not in
  scope; both throw.
- A raw guard (``rowGuard: `length(v."name") > 0` ``) takes no parameters: a bare `$N` throws, and so does a blank guard.
- The guard judges the rows committed before the statement: it does not see the leg's own rows, and it is not a
  cross-transaction arbiter. Serialize concurrent writers first (an advisory or row lock earlier in the transaction), or
  use a unique index with `onConflictDoNothing`.
- Not combinable with `onConflictDoNothing` or `overridingSystemValue` (thrown at registration).

### Read back the rows an insert leg wrote: `returning` and `getLegRows()`

`addInsertBulk(…, { returning: ['id', …] })` (since 1.0.29) and `addUpsertBulk(…, { returning: [...] })` read back the
written rows in the batch's one statement; `getLegRows(id)` returns them after `executeBatch()`.

```ts
const ub = new MutationBatch();
ub.addUpsertBulk(db.productTags, [{ productId: 1, tagId: 2, sortOrder: 3 }], {
  primaryKey: ['productId', 'tagId'],
  updateSet: (existing, excluded) => ({ sortOrder: add(existing.sortOrder, excluded.sortOrder) }),
}, 'productTags', { returning: ['productId', 'tagId', 'sortOrder'] });
ub.addInsertBulk(db.users, [{ username: 'alice', email: 'dup@test.com' }, { username: 'dave', email: 'dave@test.com' }], 'users', {
  onConflictDoNothing: true,
  returning: ['id', 'username'],
});
await ub.executeBatch();
ub.getLegRows('productTags');    // [{ productId: 1, tagId: 2, sortOrder: 4 }]
ub.getLegRows('users');          // [{ id: 5, username: 'dave' }]: the skipped row is absent
ub.getAffectedCount('users');    // 1
```

```sql
WITH "__mb_0" AS (
INSERT INTO "product_tags" ("product_id", "tag_id", "sort_order") VALUES ($1, $2, $3) ON CONFLICT ("product_id", "tag_id") DO UPDATE SET "sort_order" = ("product_tags"."sort_order" + "excluded"."sort_order")
RETURNING "product_id" AS "productId", "tag_id" AS "tagId", "sort_order" AS "sortOrder"
),
"__mb_1" AS (
INSERT INTO "users" ("username", "email") VALUES ($4, $5), ($6, $7) ON CONFLICT DO NOTHING
RETURNING "id" AS "id", "username" AS "username"
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT COALESCE(json_agg(row_to_json("__mb_0")), '[]'::json) FROM "__mb_0") AS "0__rows", (SELECT count(*)::int FROM "__mb_1") AS "1", (SELECT COALESCE(json_agg(row_to_json("__mb_1")), '[]'::json) FROM "__mb_1") AS "1__rows"
-- params: [ 1, 2, 3, "alice", "dup@test.com", "dave", "dave@test.com" ]
```

- The rows are raw JSON (a `json_agg` readback, no mapper pass): a numeric arrives as a JSON number, a timestamp as its
  JSON text, a mapped column as its stored value. They come in no particular order.
- Only rows the leg wrote: a row `onConflictDoNothing` skipped or the `rowGuard` blocked is absent.
- `getLegRows` throws for a leg registered without `returning`, and before `executeBatch()`. An unknown column throws
  at registration.
- The upsert leg requires `primaryKey`; it does not take `setWhere`, `chunkSize`, `updateColumnFilter` or
  `overridingSystemValue` (use the standalone `upsertBulk()` for those).

### Write an audit row only when a value really changed: `addDependentInsert()`

`addUpdateWhereIn(…, { exposeOldColumns: ['status'] })` publishes PostgreSQL 18's pre-update value on the leg's CTE as
`old__status`; `addDependentInsert(table, row, { onLeg, whereColumn, whereNotEquals }, id)` inserts ONE row only when
that value differs from the sentinel. A replay of the same transition writes no second audit row.

```ts
const audit = new MutationBatch();
const task = audit.addUpdateWhereIn(db.tasks, 'id', [1], { status: 'completed' }, 'task', { exposeOldColumns: ['status'] });
audit.addDependentInsert(db.tags, { name: 'task-1-completed' }, { onLeg: task!, whereColumn: 'old__status', whereNotEquals: 'completed' }, 'audit');
await audit.executeBatch();
// task: 1, audit: 1. Run again: task: 1, audit: 0 (the status already was 'completed')
```

```sql
WITH "__mb_0" AS (
UPDATE "tasks" SET "status" = $1 WHERE "id" IN ($2)
RETURNING old."status" AS "old__status"
),
"__mb_1" AS (
INSERT INTO "tags" ("name") SELECT $3::varchar FROM "__mb_0" WHERE "__mb_0"."old__status" <> $4
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", (SELECT count(*)::int FROM "__mb_1") AS "1"
-- params: [ "completed", 1, "task-1-completed", "completed" ]
```

- Register the parent leg first and expose the column the dependent leg reads (`exposeColumns` for current values under
  their property name, `exposeOldColumns` for `old__<property>`); otherwise registration throws.
- The comparison is `<>` on non-null values; a NULL sentinel is not supported.
- Exposed legs report counts, but `getLegRows` does not work on them.

### Insert parents and children as a leg: `addInsertBulkWithChildren()`

The `insertBulkWithChildren` persist as one leg (three CTEs). Unlike the standalone call, parents without children are
allowed. `getAffectedCount` reports the PARENT rows; `parentReturning` reads the parents back in input order (raw JSON).

```ts
const wc = new MutationBatch();
wc.addInsertBulkWithChildren(db.users, {
  rows: [{ username: 'p1', email: 'p1@test.com' }, { username: 'p2', email: 'p2@test.com' }],
  children: { table: db.posts, foreignKey: 'userId', rows: [{ parentIndex: 0, row: { title: 'c1' } }] },
}, 'parents', { parentReturning: ['id', 'username'] });
await wc.executeBatch();
// getAffectedCount('parents'): 2; getLegRows('parents'): [{ id: 6, username: 'p1' }, { id: 7, username: 'p2' }]
```

```sql
WITH "__mb_0_p" AS (
INSERT INTO "users" ("username", "email")
SELECT v."username", v."email" FROM (VALUES (0, $1::varchar, $2::text), (1, $3::varchar, $4::text)) AS v("__mbw_ord", "username", "email")
ORDER BY v."__mbw_ord"
RETURNING *
),
"__mb_0_o" AS (
SELECT p.*, row_number() OVER (ORDER BY p."id") - 1 AS "__mbw_ord"
FROM "__mb_0_p" p
),
"__mb_0_c" AS (
INSERT INTO "posts" ("user_id", "title")
SELECT o."id", v."title"
FROM (VALUES (0, 0, $5::varchar)) AS v("__mbw_cord", "__mbw_pix", "title")
JOIN "__mb_0_o" o ON o."__mbw_ord" = v."__mbw_pix"
ORDER BY v."__mbw_cord"
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0_p") AS "0", (SELECT COALESCE(json_agg(json_build_object('id', o."id", 'username', o."username") ORDER BY o."__mbw_ord"), '[]'::json) FROM "__mb_0_o" o) AS "0__rows"
-- params: [ "p1", "p1@test.com", "p2", "p2@test.com", "c1" ]
```

The parent primary key must be one auto-generated column, the child table must share the parent's context, and an
out-of-range `parentIndex` throws at registration. Child rows are not read back.

## Feed one write into another in one statement: data-modifying CTEs

`.toStatement(selector)` compiles a write without running it (`insert`, `insertBulk`, `insertFrom` since 1.0.22;
`where().update()`, `where().delete()`), with the selector as its RETURNING. `new DbCteBuilder().withMutation(name,
statement)` turns it into a typed data-modifying CTE that a read (`db.selectFromCte(cte)`) or another write
(`insertFrom(…, { with: [cte] })`) consumes in ONE statement. Use it when a write's RETURNING drives a read or a
dependent write: claim and load, delete and archive, insert and audit. Independent writes are simpler as a
`MutationBatch`. The full rules are in the CTE Guide:
[Write and read back in one statement](./cte-guide.md#write-and-read-back-in-one-statement-withmutation).

The sequence it replaces, 2 round trips with a race between them:

```ts
const pending = await db.tasks
  .where(t => and(eq(t.status, 'pending'), eq(t.priority, 'high')))
  .select(t => ({ id: t.id }))
  .toList();
await db.tasks.where(t => eq(t.id, pending[0].id)).update({ status: 'processing' });
```

```sql
SELECT "tasks"."id" as "id"
FROM "tasks"
WHERE ("tasks"."status" = $1 AND "tasks"."priority" = $2)
-- params: [ "pending", "high" ]
UPDATE "tasks" SET "status" = $1 WHERE "tasks"."id" = $2
-- params: [ "processing", 1 ]
```

Claim and load in one statement:

```ts
import { DbCteBuilder, and, eq } from 'linkgress-orm';

const claim = new DbCteBuilder().withMutation(
  'claimed',
  db.tasks
    .where(t => and(eq(t.status, 'pending'), eq(t.priority, 'high')))
    .update({ status: 'processing' })
    .toStatement(t => ({ id: t.id, title: t.title, status: t.status })),
);
const claimed = await db.selectFromCte(claim.cte)
  .select(r => ({ id: r.id, title: r.title, status: r.status }))
  .toList();
// [{ id: 1, title: 'Important Task', status: 'processing' }]
```

```sql
WITH "claimed" AS (UPDATE "tasks" SET "status" = $1 WHERE ("tasks"."status" = $2 AND "tasks"."priority" = $3) RETURNING "id" AS "id", "title" AS "title", "status" AS "status")
SELECT "claimed"."id" as "id", "claimed"."title" as "title", "claimed"."status" as "status"
FROM "claimed"
-- params: [ "processing", "pending", "high" ]
```

A bulk insert feeding a dependent insert: every new user gets a welcome post, and a username that already exists (ON
CONFLICT DO NOTHING) is not in the CTE's RETURNING, so it gets none:

```ts
const ins = new DbCteBuilder().withMutation(
  'ins',
  db.users
    .insertBulk(
      [{ username: 'alice', email: 'alice@test.com' }, { username: 'dave', email: 'dave@test.com' }],
      { onConflictDoNothing: true },
    )
    .toStatement(u => ({ id: u.id, username: u.username })),
);
await db.posts.insertFrom(
  db.selectFromCte(ins.cte).select(r => ({ id: r.id, username: r.username })).asSubquery('table'),
  src => ({ userId: src.id, title: concat('Welcome, ', src.username) }),
  { with: [ins.cte] },
);
```

```sql
WITH "ins" AS (INSERT INTO "users" ("username", "email") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING RETURNING "id" AS "id", "username" AS "username")
INSERT INTO "posts" ("user_id", "title") SELECT "src"."id", concat(CAST($5 AS text), "src"."username") FROM (SELECT "ins"."id" as "id", "ins"."username" as "username"
FROM "ins") AS "src"
-- params: [ "alice", "alice@test.com", "dave", "dave@test.com", "Welcome, " ]
```

- Each data-modifying CTE runs once, however often it is read, and the statement is atomic.
- The statement that executes must declare the CTE: `.with(cte)` on a query, `with: [cte]` on `insertFrom`. Otherwise
  it is refused before sending: `insertFrom: the statement reads the data-modifying CTE "upd", which PostgreSQL allows
  only at the top level of the statement — pass it in insertFrom's options: { with: [updCte] }`.
- The parts of one statement share one snapshot and cannot see each other's writes; pass rows only through RETURNING.
  The other parts do not see the CTE's rows in the TABLE: read them from the CTE.
- `toStatement()` compiles ONE statement: zero rows, rows above one chunk, and a navigation, collection or single-value
  selector are refused (`toStatement(): 2 rows exceed the 1-row chunk of one insert into "users" — …`). For a set larger
  than one chunk compile `insertFrom(fromRows(…))`: one statement with one parameter per column (70 000 rows captured).
- A compiled statement may read a data-modifying CTE created before it, through its source, `where` or `with` (since
  1.0.29): it reads it by name, and every statement that declares the later CTE declares the earlier one first, also
  when it reads only the later one. The `afterMutation()` example below relies on it.
- The `temptable` collection strategy cannot read a data-modifying CTE in a collection; use `cte` or `lateral` there.

### Close the current version and open the next in one statement: `afterMutation()`

A versioned row changes by closing the current row and inserting its successor. The examples use the `leases` table of
[the `targetWhere` section](#upsert-onto-a-partial-unique-index-targetwhere) (entity class `Lease`, one CURRENT lease
per unit). PostgreSQL runs the parts of a WITH in no promised order, so the insert can hit the unique index before the
close ran (23505). `afterMutation(closed.cte)` (since 1.0.29) in the insert's `where` makes it run after the close; the
details are in [Order two writes in one statement](./cte-guide.md#order-two-writes-in-one-statement-aftermutation).
The loop it replaces took 6 statements for 3 units (plus BEGIN and COMMIT):

```ts
const now = new Date('2026-06-01T00:00:00Z');
const desired = [{ unitId: 1, tenantId: 12 }, { unitId: 2, tenantId: 20 }, { unitId: 3, tenantId: 30 }];

await db.transaction(async tx => {
  for (const d of desired) {
    const current = await tx.leases.where(l => and(eq(l.unitId, d.unitId), eq(l.isCurrent, true))).firstOrDefault();
    if (current && current.tenantId === d.tenantId) continue;
    if (current) await tx.leases.where(l => eq(l.id, current.id)).update({ validTo: now, isCurrent: false });
    await tx.leases.insert({ unitId: d.unitId, tenantId: d.tenantId, validFrom: now, isCurrent: true });
  }
});
```

```sql
SELECT "leases"."id" as "id", "leases"."unit_id" as "unitId", "leases"."tenant_id" as "tenantId", "leases"."valid_from" as "validFrom", "leases"."valid_to" as "validTo", "leases"."is_current" as "isCurrent"
FROM "leases"
WHERE ("leases"."unit_id" = $1 AND "leases"."is_current" = $2)
LIMIT 1
-- params: [ 1, true ]
UPDATE "leases" SET "valid_to" = $1, "is_current" = $2 WHERE "leases"."id" = $3
-- params: [ "2026-06-01T00:00:00.000Z", false, 1 ]
INSERT INTO "leases" ("unit_id", "tenant_id", "valid_from", "is_current") VALUES ($1, $2, $3, $4)
-- params: [ 1, 12, "2026-06-01T00:00:00.000Z", true ]
SELECT "leases"."id" as "id", "leases"."unit_id" as "unitId", "leases"."tenant_id" as "tenantId", "leases"."valid_from" as "validFrom", "leases"."valid_to" as "validTo", "leases"."is_current" as "isCurrent"
FROM "leases"
WHERE ("leases"."unit_id" = $1 AND "leases"."is_current" = $2)
LIMIT 1
-- params: [ 2, true ]
SELECT "leases"."id" as "id", "leases"."unit_id" as "unitId", "leases"."tenant_id" as "tenantId", "leases"."valid_from" as "validFrom", "leases"."valid_to" as "validTo", "leases"."is_current" as "isCurrent"
FROM "leases"
WHERE ("leases"."unit_id" = $1 AND "leases"."is_current" = $2)
LIMIT 1
-- params: [ 3, true ]
INSERT INTO "leases" ("unit_id", "tenant_id", "valid_from", "is_current") VALUES ($1, $2, $3, $4)
-- params: [ 3, 30, "2026-06-01T00:00:00.000Z", true ]
```

One statement. The helper takes a TABLE, so it runs on the caller's connection, inside the caller's transaction when
`tx.leases` is passed:

```ts
import { DbCteBuilder, afterMutation, and, eq, eqAny, fromRows, literal, notExists } from 'linkgress-orm';
import type { DbEntityTable } from 'linkgress-orm';

type Desired = { unitId: number; tenantId: number };

async function applyLeases(leases: DbEntityTable<Lease>, desired: Desired[], now: Date) {
  const units = desired.map(d => d.unitId);
  const builder = new DbCteBuilder(leases.getClient());

  const closed = builder.withMutation('closed', leases
    .where(l => and(
      eqAny(l.unitId, units),
      eq(l.isCurrent, true),
      notExists(fromRows(leases, desired, { columns: ['unitId', 'tenantId'], alias: 'd' })
        .where(d => and(eq(d.unitId, l.unitId), eq(d.tenantId, l.tenantId)))
        .select(() => ({ one: literal(1) }))
        .asSubquery()),
    ))
    .update({ validTo: now, isCurrent: false })
    .toStatement(l => ({ id: l.id, unitId: l.unitId })));

  const opened = builder.withMutation('opened', leases.insertFrom(
    fromRows(leases, desired, { columns: ['unitId', 'tenantId'], alias: 'd' })
      .where(d => notExists(leases
        .where(c => and(eq(c.unitId, d.unitId), eq(c.tenantId, d.tenantId), eq(c.isCurrent, true)))
        .select(c => ({ id: c.id }))
        .asSubquery()))
      .asSubquery('table'),
    src => ({ unitId: src.unitId, tenantId: src.tenantId, validFrom: now, isCurrent: true }),
    { where: () => afterMutation(closed.cte) },   // the insert runs only after the close completed
  ).toStatement(l => ({ id: l.id, unitId: l.unitId })));

  return leases.selectFromCte(opened.cte).select(r => ({ leg: 'opened', id: r.id, unitId: r.unitId }))
    .unionAll(leases.selectFromCte(closed.cte).select(r => ({ leg: 'closed', id: r.id, unitId: r.unitId })))
    .toList();
}

const rows = await applyLeases(db.leases, desired, now);
// [{ leg: 'opened', id: 5, unitId: 1 }, { leg: 'opened', id: 6, unitId: 3 }, { leg: 'closed', id: 1, unitId: 1 }]
```

```sql
WITH "closed" AS (UPDATE "leases" SET "valid_to" = $1, "is_current" = $2 WHERE (("leases"."unit_id" = ANY($3::integer[])) AND "leases"."is_current" = $4 AND (NOT EXISTS (SELECT 1 as "one"
FROM unnest(CAST($5 AS integer[]), CAST($6 AS integer[])) AS "d"("unitId", "tenantId")
WHERE ("d"."unitId" = "leases"."unit_id" AND "d"."tenantId" = "leases"."tenant_id")))) RETURNING "id" AS "id", "unit_id" AS "unitId"), "opened" AS (INSERT INTO "leases" ("unit_id", "tenant_id", "valid_from", "is_current") SELECT "src"."unitId", "src"."tenantId", CAST($10 AS timestamp), CAST($11 AS boolean) FROM (SELECT "d"."unitId" as "unitId", "d"."tenantId" as "tenantId"
FROM unnest(CAST($7 AS integer[]), CAST($8 AS integer[])) AS "d"("unitId", "tenantId")
WHERE (NOT EXISTS (SELECT "leases"."id" as "id"
FROM "leases"
WHERE ("leases"."unit_id" = "d"."unitId" AND "leases"."tenant_id" = "d"."tenantId" AND "leases"."is_current" = $9)))) AS "src" WHERE ((SELECT count(*) FROM "closed") >= 0) RETURNING "id" AS "id", "unit_id" AS "unitId")
(SELECT CAST($12 AS text) as "leg", "opened"."id" as "id", "opened"."unitId" as "unitId"
FROM "opened")
UNION ALL
(SELECT CAST($13 AS text) as "leg", "closed"."id" as "id", "closed"."unitId" as "unitId"
FROM "closed")
-- params: [ "2026-06-01T00:00:00.000Z", false, "{1,2,3}", true, "{1,2,3}", "{12,20,30}", "{1,2,3}", "{12,20,30}", true, "2026-06-01T00:00:00.000Z", true, "opened", "closed" ]
```

- The barrier orders what the statement WRITES, not what it SEES: the open leg still reads the snapshot in which the
  retired row is current. Decide what to close and what to open on disjoint keys (as above), never on "is there a
  current row".
- Read several legs back with a UNION ALL of CTE-rooted queries (`unionAll()` on them since 1.0.29), never a FULL JOIN
  (PostgreSQL plans that only on merge- or hash-joinable conditions: 0A000).
- `<table>.selectFromCte(cte)`, `<table>.selectFromSet(set)`, `<table>.isInTransaction()` and `<table>.getClient()`
  (since 1.0.30) let a helper that receives a table run on that table's context
  ([Run CTE statements on a table's own connection](./cte-guide.md#run-cte-statements-on-a-tables-own-connection-tableselectfromcte)). `isInTransaction()` is `true` on
  `tx.leases` and `false` on `db.leases`: outside a transaction the statement commits on its own and the helper may
  retry it after 40P01 / 40001; inside one, the failure aborts the caller's transaction. Rooted on `db` inside a
  transaction, the statement would run on another connection: it would not see the transaction's uncommitted rows
  (23503 on a foreign key to them), and on a pool of one connection it would wait forever (PGlite refuses it).

## Number many rows from a sequence in one statement

A `nextval()` call inside the INSERT draws one number per row in the statement itself. Use it instead of a `nextValue()`
round trip per row; draw numbers with `nextValue()` only when you need them before the rows are built. These examples
use an `invoices` table and a model sequence that the test model lacks (see
[Schema Configuration](./schema-configuration.md)):

```ts
// fragment: members of the examples' DbContext subclass (class Invoice: id, number, label)
get invoices(): DbEntityTable<Invoice> {
  return this.table(Invoice);
}

get invoiceNumbers(): DbSequence {
  return this.sequence(sequence('invoice_number_seq').startWith(1000).build());
}

protected override setupModel(model: DbModelConfig): void {
  model.entity(Invoice, entity => {
    entity.toTable('invoices');
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'invoices_id_seq' }));
    entity.property(e => e.number).hasType(integer('number')).isRequired();
    entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
  });
}

protected override setupSequences(): void {
  this.invoiceNumbers;   // registers the sequence, so ensureCreated() creates it
}
```

The loop it replaces, n + 1 round trips:

```ts
const labels = ['a', 'b', 'c'];

const numbered = [];
for (const label of labels) {
  numbered.push({ label, number: await db.invoiceNumbers.nextValue() });
}
await db.invoices.insertBulk(numbered);
```

```sql
SELECT nextval($1::regclass) as value
-- params: [ "\"invoice_number_seq\"" ]
SELECT nextval($1::regclass) as value
-- params: [ "\"invoice_number_seq\"" ]
SELECT nextval($1::regclass) as value
-- params: [ "\"invoice_number_seq\"" ]
INSERT INTO "invoices" ("number", "label") VALUES ($1, $2), ($3, $4), ($5, $6)
-- params: [ 1000, "a", 1001, "b", 1002, "c" ]
```

One statement, with `insertBulk` or with `insertFrom` over `fromRows` (one fixed text for any row count):

```ts
const viaBulk = await db.invoices
  .insertBulk(labels.map(label => ({
    label,
    number: sql<number>`nextval('invoice_number_seq')` as unknown as number,
  })))
  .returning(i => ({ id: i.id, number: i.number }));   // numbers 1003, 1004, 1005

const viaRows = await db.invoices
  .insertFrom(
    fromRows(db.invoices, labels.map(label => ({ label })), { columns: ['label'] }).asSubquery('table'),
    src => ({ label: src.label, number: sql<number>`nextval('invoice_number_seq')` }),
  )
  .returning(i => ({ id: i.id, number: i.number }));   // numbers 1006, 1007, 1008
```

```sql
INSERT INTO "invoices" ("number", "label") VALUES ((nextval('invoice_number_seq')), $1), ((nextval('invoice_number_seq')), $2), ((nextval('invoice_number_seq')), $3) RETURNING "id" AS "id", "number" AS "number"
-- params: [ "a", "b", "c" ]
INSERT INTO "invoices" ("label", "number") SELECT "src"."label", CAST(nextval('invoice_number_seq') AS integer) FROM (SELECT "rows"."label" as "label"
FROM unnest(CAST($1 AS varchar[])) AS "rows"("label")) AS "src" RETURNING "id" AS "id", "number" AS "number"
-- params: [ "{\"a\",\"b\",\"c\"}" ]
```

- `insertBulk` rows are typed `InsertData`, so the fragment needs `as unknown as number`; `insertFrom`'s map does not.
- The sequence name is SQL text inside the fragment. Numbers drawn by a failed or rolled-back insert are consumed.
- A column DEFAULT numbers rows without naming the sequence in any insert: declare the property with
  ``.hasDefaultValue(`nextval('invoice_number_seq')`)`` (the schema manager creates the sequence before the table) and
  leave `number` out of the rows.

## Make several statements atomic: `db.transaction()`

`db.transaction(async tx => …, options?)` runs its callback on one pooled connection between BEGIN and COMMIT (ROLLBACK
when the callback throws) and resolves to the callback's result. Use it when several statements must commit together:
chunked `insertBulk`, a read followed by a dependent write, advisory or row locks. One statement (a write, a
`MutationBatch`, a CTE chain) is already atomic and does not need the 2 extra round trips.

```ts
const userId = await db.transaction(async tx => {
  const user = await tx.users.insert({ username: 'dave', email: 'dave@test.com' }).returning(u => ({ id: u.id }));
  await tx.posts.insertBulk([
    { userId: user.id, title: 'First post' },
    { userId: user.id, title: 'Second post' },
  ]);
  return user.id;
});
```

```sql
INSERT INTO "users" ("username", "email") VALUES ($1, $2) RETURNING "id" AS "id"
-- params: [ "dave", "dave@test.com" ]
INSERT INTO "posts" ("title", "user_id") VALUES ($1, $2), ($3, $4)
-- params: [ "First post", 4, "Second post", 4 ]
```

The driver also sends BEGIN before and COMMIT after these statements (`PgClient.transaction()`), 2 more round trips.
This parent-and-children case is also one statement with
[`insertWithChildren()`](#insert-a-parent-and-its-children-in-one-statement-insertwithchildren).

| Option | Default | Effect |
|---|---|---|
| `timeoutMs` | none (the connection default) | `SET LOCAL statement_timeout = <ms>` first: every statement of the transaction, bulk writes included, gets the timeout (milliseconds; `0` disables it). A cancellation throws `QueryTimeoutError` on `PostgresClient` only; `PgClient` raises node-postgres's error with `code: '57014'`, `BunClient` Bun's `PostgresError` with `errno: '57014'`; `PGliteClient` cannot cancel |
| `expectedExecutionMs` | `timeoutMs` | the slow-query threshold (milliseconds) for `onQueryTakingTooLong` inside the transaction; diagnostic only |

```ts
await db.transaction(async tx => {
  await tx.tags.insertBulk([{ name: 'Bulk 1' }, { name: 'Bulk 2' }]);
}, { timeoutMs: 5000 });
```

```sql
SET LOCAL statement_timeout = 5000
INSERT INTO "tags" ("name") VALUES ($1), ($2)
-- params: [ "Bulk 1", "Bulk 2" ]
```

A single write outside a transaction gets a timeout from its table: `db.users.withTimeout(5000).insertBulk(rows)` passes
`timeoutMs: 5000` to the client for the write (captured for `insertBulk`, `upsertBulk`, `mergeBulk`, `bulkUpdate`,
`where().update()` and `where().delete()`); see
[Cancel statements that run too long](./configuration.md#cancel-statements-that-run-too-long-withtimeout-and-statement_timeout).
PGlite cannot cancel a running statement.

> **Pitfall:** Inside the callback use `tx.<table>`. `db.<table>` runs on another pooled connection, outside the
> transaction, and commits on its own:

```ts
await db.transaction(async tx => {
  await tx.tags.insert({ name: 'inside' });   // in the transaction
  await db.tags.insert({ name: 'outside' });  // another pooled connection, commits on its own
});
```

```sql
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "inside" ]
INSERT INTO "tags" ("name") VALUES ($1)
-- params: [ "outside" ]
```

(The first statement ran on the transaction's connection, the second on another one.)

- `tx` and everything obtained from it (tables, model sequences, query builders, futures, `QueryBatch` /
  `MutationBatch` legs, prepared queries, `tx.getSchemaManager()`, `tx.getClient()`) is valid only until the callback
  settles. Used afterwards, each statement is refused with `TransactionEndedError` before it reaches the database (its
  `sql` is the refused text): `this transaction has already ended — objects obtained from its context (tables,
  sequences, queries, batches, its schema manager, its client) are only valid inside transaction(); use the root
  context or a new transaction instead. The statement was not run.` By then the connection is back in the pool and may
  belong to another transaction. Return results from the callback, never `tx` or objects built from it.
- The query function a driver's own `client.transaction(query => …)` hands its callback is refused the same way once
  the callback settled. The deprecated `PostgresClient.begin()` is not guarded: use `transaction()`.
- There are no nested transactions: `tx.transaction(…)` throws `Nested transactions are not supported`. A SAVEPOINT
  stays inside the transaction.
- `QueryBatch` and `FutureQueryRunner.runAsync()` take the futures of ONE context; mixing `tx`'s futures with `db`'s (or
  with an ended transaction's) is refused before anything runs
  ([Batching and Prepared Queries](./batching-and-prepared-queries.md#batch-inside-a-transaction-or-under-a-timeout)).

### Serialize check-then-write on a key that is not a row: advisory locks

Transaction-scoped advisory locks serialize units of work on a key that is not a row (an order being settled, an import
per partner) without a lock table. They are released at COMMIT or ROLLBACK. Use them before a check-then-write
(`rowGuard`, `notExists`, a MAX + 1 number); when a unique index plus ON CONFLICT already decides, no lock is needed.

| Keys | Wait until the lock is free | Do not wait: `true` when taken, `false` when another session holds it |
|---|---|---|
| one key, or one `(classId, key)` pair | `advisoryXactLock(key)` · `advisoryXactLock(classId, key)` | `tryAdvisoryXactLock(key)` · `tryAdvisoryXactLock(classId, key)` |
| many keys of one class, one statement | `advisoryXactLockAll(classId, keys)` | [`tryAdvisoryXactLockAll(classId, keys)`](#try-many-keys-without-waiting-tryadvisoryxactlockall-since-1031) (since 1.0.31) |

```ts
await db.transaction(async tx => {
  await tx.advisoryXactLock(7, 1001);                  // (classId, key): waits for the lock
  const got = await tx.tryAdvisoryXactLock('import:partner-7');  // a string key, no waiting
  await tx.advisoryXactLockAll(7, [5, 3, 5, 1]);       // many keys, deduplicated and sorted, one statement
  await tx.users.where(u => eq(u.id, 1)).update({ age: sql<number>`"age" + 1` });
});
```

```sql
SELECT pg_advisory_xact_lock($1, $2)
-- params: [ 7, 1001 ]
SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "acquired"
-- params: [ "import:partner-7" ]
SELECT pg_advisory_xact_lock($1, t.k) FROM unnest(CAST($2 AS integer[])) WITH ORDINALITY AS t(k, ord) ORDER BY t.ord
-- params: [ 7, "{1,3,5}" ]
UPDATE "users" SET "age" = "age" + 1 WHERE "users"."id" = $1
-- params: [ 1 ]
```

- Keys: one integer (int8 range, `CAST($1 AS bigint)`), a `(classId, key)` pair (int4 each), or a string hashed with
  `hashtext()`. The pair form keeps unrelated lock families apart.
- The form follows the number of arguments: `(classId, key)` is always a pair, and a pair whose key is `null`,
  `undefined` or not an integer or string throws, so it can never become a different lock.
- `tryAdvisoryXactLock` returns `true` when this transaction holds the lock (advisory locks are re-entrant) and `false`
  when another session holds it.
- `advisoryXactLockAll(classId, keys)` always takes the class id (int4; there is no one-argument form). It
  deduplicates and sorts the keys (all integers or all strings; strings use `hashtext(t.k)` over `text[]`), so two
  transactions locking overlapping sets cannot deadlock on each other; the order is an SQL guarantee
  (`WITH ORDINALITY … ORDER BY t.ord`). An empty list sends nothing. One round trip for any number of keys.
- Call all four on the context `db.transaction()` hands you; on the root context they throw before sending
  (`advisoryXactLock() takes a TRANSACTION-scoped lock — call it on the context db.transaction() hands you. …`): the
  lock would end with the statement.

#### Try many keys without waiting: `tryAdvisoryXactLockAll()` (since 1.0.31)

`tryAdvisoryXactLockAll(classId, keys)` tries every key without waiting, in ONE statement, and returns whether the
transaction now holds them all. Use it where a busy key means "leave this unit of work to whoever holds it" (a
settlement another worker is running) instead of waiting; it replaces one `tryAdvisoryXactLock()` round trip per key.

```ts
const orderIds = [5, 3, 5, 1];
const settled = await db.transaction(async tx => {
  if (!await tx.tryAdvisoryXactLockAll(7, orderIds)) {   // many keys, one statement, no waiting
    return false;   // another transaction holds one of them
  }
  await tx.orders.where(o => eq(o.id, 1)).update({ status: 'processing' });   // every key is ours until COMMIT
  return true;
});
// true
```

```sql
WITH RECURSIVE walk(ord, ok) AS (SELECT 1, pg_try_advisory_xact_lock($1, (CAST($2 AS integer[]))[1])
UNION ALL SELECT walk.ord + 1, pg_try_advisory_xact_lock($1, (CAST($2 AS integer[]))[walk.ord + 1])
FROM walk WHERE walk.ok AND walk.ord < cardinality(CAST($2 AS integer[]))) SELECT bool_and(walk.ok) AS "acquired" FROM walk
-- params: [ 7, "{1,3,5}" ]
UPDATE "orders" SET "status" = $1 WHERE "orders"."id" = $2
-- params: [ "processing", 1 ]
```

- Returns `true` when the transaction holds every key afterwards (keys it already held count: advisory locks are
  re-entrant), `false` as soon as another session holds one. It never waits.
- The keys are tried in the order `advisoryXactLockAll` takes them (deduplicated, numbers ascending, strings in
  code-unit order, each hashed with `hashtext()` in the statement), and the statement stops at the first busy key. The
  keys tried before it STAY held until the transaction ends (advisory locks are not given back one by one); the keys
  after it are never tried. Observed with another transaction holding key 3:
  `tryAdvisoryXactLockAll(7, [1, 3, 5])` returned `false`, and a third session's `tryAdvisoryXactLock(7, 1)` returned
  `false` (held by the trying transaction) while its `tryAdvisoryXactLock(7, 5)` returned `true`. On `false`, end the
  transaction (return or throw) unless holding that prefix is harmless.
- An empty list returns `true` without sending a statement.
- The statement is a recursive walk over the keys: one step per key, a next step only while the last try succeeded.
  A shorter `… FROM unnest(…) WHERE NOT pg_try_advisory_xact_lock(…) LIMIT 1` stops at the busy key only through the
  executor's laziness, which SQL does not promise (the in-memory database evaluates every row before the LIMIT and
  took the keys after the busy one).
- Same validation and transaction requirement as `advisoryXactLockAll`: an int4 class id, all keys integers or all
  strings (`tryAdvisoryXactLockAll: keys must be all integers or all strings`).

### Lock the rows you read before writing them: `forUpdate()`

`forUpdate({ skipLocked?, noWait? })` after `select()` appends `FOR UPDATE` and locks the rows the read returns until
the transaction ends. Use it for a read-then-write on existing rows, and with `skipLocked` to claim work-queue rows
other workers have not locked. Rows that do not exist yet cannot be locked: use an advisory lock. A single-statement
alternative is an `UPDATE … RETURNING old`.

```ts
await db.transaction(async tx => {
  const row = await tx.users.where(u => eq(u.id, 1)).select(u => ({ id: u.id, age: u.age })).forUpdate().firstOrDefault();
  if (row) await tx.users.where(u => eq(u.id, row.id)).update({ age: (row.age ?? 0) + 1 });
});

await db.transaction(async tx => {
  const claimed = await tx.tasks
    .where(t => eq(t.status, 'pending'))
    .select(t => ({ id: t.id }))
    .orderBy(t => t.id)
    .limit(5)
    .forUpdate({ skipLocked: true })
    .toList();
});
```

```sql
SELECT "users"."id" as "id", "users"."age" as "age"
FROM "users"
WHERE "users"."id" = $1
LIMIT 1
FOR UPDATE
-- params: [ 1 ]
UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [ 27, 1 ]
SELECT "tasks"."id" as "id"
FROM "tasks"
WHERE "tasks"."status" = $1
ORDER BY "id" ASC
LIMIT 5
FOR UPDATE SKIP LOCKED
-- params: [ "pending" ]
```

- Outside a transaction the lock ends with the statement, and nothing refuses the call.
- `forUpdate()` exists after `select()` (not on the `where()` result), including on a select builder that is a CTE's
  body. `skipLocked` and `noWait` together throw. It mutates the builder (returns `this`).
- A CTE-rooted query also has `forUpdate()` (`db.selectFromCte(cte).select(…).forUpdate()`), but it locks NO rows:
  it appends `FOR UPDATE` to an outer SELECT whose FROM holds only CTEs, which PostgreSQL's locking clause does not
  reach. Put `.forUpdate()` on the CTE body instead
  ([Lock the rows a CTE reads](./cte-guide.md#lock-the-rows-a-cte-reads-forupdate-in-the-body)).
- Lock several rows in a stable order (`orderBy` a key) so two transactions cannot deadlock.

## Keep the statement text stable

With `preparedStatements: true` (honored by `PostgresClient` only) every distinct statement text is a cached plan per
pooled connection. Writes whose text follows the input size create one plan per size:

| Write | Text changes with | Stable alternative |
|---|---|---|
| `insertBulk`, `upsertBulk`, `bulkUpdate`, `mergeBulk`, `values()` | the row count (one VALUES tuple per row) | `insertFrom(fromRows(table, rows, { columns }))`: one text for any row count |
| `where(r => inArray(r.id, ids))` | the list length (one placeholder per element) | `eqAny(r.id, ids)`: one array parameter |
| `fromRows(table, rows)` without `columns` | the columns the rows hold | pass `columns` |
| `insertWithChildren`, `insertBulkWithChildren`, the `MutationBatch` statement | every call (VALUES lists) | always sent unprepared, regardless of the option |

Opt a bulk write out with `db.<table>.withPreparedStatements(false)`, which covers every query and write started from
the returned table. The option: [Send statements named on the server](./configuration.md#send-statements-named-on-the-server-preparedstatements);
`inArrayOpt` and the process-wide list settings:
[Bound the statement texts of list filters](./configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig).

## What the typings check

Verified with `tsc --strict` against the source:

| Code | Compiles? |
|---|---|
| `insert({ username: 'a', email: 'a@test.com', nickname: 'x' })` (unknown key) | no |
| `insert({ username: 'a', email: 123 })`, `update({ email: 123 })` (wrong value type) | no |
| `insert({ age: 3 })` (missing NOT NULL columns) | yes; fails at run time with 23502 |
| `const v: void = await db.users.insert(row)` | yes: a bare await is `void` |
| `db.users.insert(row).catch(…)` | no: builders are `PromiseLike` |
| an `sql` fragment value in `update()`, `upsertBulk()`, `mergeBulk()` | yes |
| an `sql` fragment value in `insert()`, `insertBulk()`, `upsert()`, `values()`, `bulkUpdate()`, the parent row of `insertWithChildren()` | no: cast it (`as unknown as T`); it renders inline at run time |
| an `sql` fragment value in a `*WithChildren` child row | yes (child rows are `Record<string, any>`) |
| `update(p => ({ content: p.title }))` (a bare column), `update(u => ({ isActive: eq(u.age, 30) }))` (a condition) | yes, but each is bound as a parameter: wrap it in `sql` |
| `update({ age: undefined })` on an optional column | yes, and it writes NULL |
| `upsert(rows, { conflictTarget: [...], update: [...] })` | no: the keys are `primaryKey` and `updateColumns` |
| `.affectedCount()` | `number` |
| `insert(row).returning(sel)` / `insertBulk(rows).returning(sel)` / `where().delete().returning(sel)` | one row / an array / an array |

## Pitfalls

- **Don't** `const user = await db.users.insert(row)` and read `user.id` → **Do** `.returning(u => ({ id: u.id }))`: a
  bare await resolves `undefined`.
- **Don't** leave a write builder un-awaited → **Do** `await` or return it: nothing is sent until then, with no error.
- **Don't** await the same builder object twice → **Do** build it once per execution: the second await sends the
  statement again.
- **Don't** `await` a write per row in a loop → **Do** `insertBulk`, `bulkUpdate`, an `eqAny` update or delete, or
  `insertFrom`: 1 round trip instead of n, and one commit.
- **Don't** check with `exists()` (or `notExists()`, a `rowGuard`) and then insert → **Do** `onConflictDoNothing` or
  `upsertBulk` on a unique index: the check reads a snapshot, a concurrent duplicate passes it and fails with 23505.
- **Don't** give `upsertBulk` (or `mergeBulk`) rows with different column sets → **Do** one column set per call, or
  `bulkUpdate` for partial rows: a missing column is written as NULL on conflict (`bob.age` 35 → NULL).
- **Don't** expect `insertBulk` rows without a key to get the column DEFAULT when another row sets it → **Do** set the
  value in every row: the missing cells are NULL.
- **Don't** pass a key whose value is `undefined` (`{ ...row, age: maybeAge }`) to `update()`, `upsertBulk()` or
  `bulkUpdate()` to keep a column → **Do** leave the key out: a present key is written, `undefined` as NULL.
- **Don't** send the same conflict key twice in one `upsertBulk` (or `on` key in one `mergeBulk`) → **Do** deduplicate
  the input first: the statement fails with 21000 (`ON CONFLICT DO UPDATE command cannot affect row a second time`,
  `MERGE command cannot affect row a second time`).
- **Don't** assign a bare column or a condition in `update(row => ({ … }))` → **Do** wrap it in
  ``sql`${row.col}` ``: it is bound as a parameter, so a column's JSON text is written and a condition fails with 22P02.
- **Don't** call `db.<table>.update()` / `.delete()` without `where()` unless every row is meant → **Do** add `where()`:
  it renders `WHERE TRUE`.
- **Don't** use `db.<table>` inside `db.transaction()` → **Do** use `tx.<table>`: `db` runs on another connection,
  outside the transaction.
- **Don't** rely on `insertBulk` chunks being atomic → **Do** wrap the call in `db.transaction()`, or use
  `insertFrom(fromRows(…))` (one statement): outside a transaction each chunk commits on its own.
- **Don't** pass property names to `values().onConflict([...])` → **Do** pass database column names, or use
  `upsertBulk` with `primaryKey`: `"productId"` fails with 42703.
- **Don't** bind a value in `targetWhere` (`eq(e.isCurrent, true)`) → **Do** `eq(e.isCurrent, literal(true))`: a bound
  predicate is refused (a generic plan could not infer the arbiter).
- **Don't** make one `MutationBatch` leg depend on another leg's rows → **Do** `addDependentInsert`, a CTE chain, or
  separate statements: legs share one snapshot (the update leg matched 0 rows).
- **Don't** use `mergeBulk` with concurrent writers of the same keys → **Do** `upsertBulk` on a unique index: MERGE has
  no speculative insertion, so both writers can take the insert arm (duplicate rows, or 23505 when a unique index
  exists).
- **Don't** pass an identity id to `insert()` expecting it to be written → **Do**
  `insertBulk(rows, { overridingSystemValue: true })`: the id is silently left out.
- **Don't** number rows with a `nextValue()` round trip each → **Do** put ``sql`nextval('seq')` `` in the INSERT: 1
  statement instead of n + 1.
- **Don't** expect a collection in RETURNING to count the rows the same statement wrote → **Do** read it in a later
  statement: one statement reads one snapshot.
- **Don't** read an array column, change it in JS and write it back → **Do**
  `update(b => ({ tags: arrayAppendUnique(b.tags, v) }))` or `arrayRemove(b.tags, v)`: one statement on the row's
  current array, and a second run changes nothing.
- **Don't** call `tryAdvisoryXactLock()` once per key of a set → **Do** `tryAdvisoryXactLockAll(classId, keys)`: one
  statement, the keys in a fixed order; on `false`, end the transaction, as the keys before the busy one stay held.
- **Don't** call `.catch()` on a builder → **Do** `try { await builder } catch {}` or `Promise.resolve(builder).catch()`.

## See also

- [Choosing the Right Query](../choosing-the-right-query.md): the decision guide for reads and writes, with round trips.
- [Querying](./querying.md): reads, filters, list matching (`eqAny`, `inArray`, `inArrayOpt`) and navigations.
- [CTE Guide](./cte-guide.md): data-modifying CTEs, `afterMutation()`, table-rooted queries, in depth.
- [Set-Returning Functions](./set-returning-functions.md): `fromRows()` / `unnestRows()` as read sources and in joins.
- [Batching and Prepared Queries](./batching-and-prepared-queries.md): fewer round trips for reads.
- [SQL Expressions](./sql-expressions.md): the helpers usable as write values (`add`, `coalesce`, `caseWhen`,
  `jsonbMerge`, `arrayAppendUnique`, `arrayRemove`, …).
- [Schema Configuration](./schema-configuration.md): unique and partial indexes, identity columns, sequences, custom
  types and mappers.
- [Configuration](./configuration.md): `preparedStatements`, `logFailedQueries`, timeouts and other options.
- [Database Clients](../database-clients.md): drivers, pooling and their parameter limits.
- [In-Memory Database](./in-memory-database.md): what the in-memory engine proves about ON CONFLICT arbiters.
