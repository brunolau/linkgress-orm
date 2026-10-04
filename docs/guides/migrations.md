# Migrations and Schema Management

> **For agents:** Which API creates or changes the database schema from the model (`ensureCreated()`, `migrate()`, or migration files run by `MigrationRunner`), what SQL each one sends, and what each one never does.
> **Use this page when:** creating tables for tests or a new database, applying model changes to an existing database, previewing a schema diff in CI, writing, running or reverting migration files, running SQL before or after schema work. **Look elsewhere when:** declaring tables, columns, keys, indexes, views, enums or sequences → [Schema configuration](./schema-configuration.md); giving each test its own database → [In-memory database](./in-memory-database.md)
> **Key APIs:** `getSchemaManager()`, `ensureCreated()`, `migrate()`, `analyze()`, `ensureDeleted()`, `onMigrationStart`, `onMigrationComplete`, `MigrationRunner`, `MigrationScaffold`, `MigrationJournal`, `MigrationLoader`, `IndexRepairError` · **Round trips:** one per statement; `migrate()` and `analyze()` first read the catalog (9 statements for the two-table slice in sync: 1 table list + 4 per table, +1 per table that declares a CHECK); `ensureCreated()` and `migrate()` commit statement by statement, a migration file runs in one transaction

## Contents

- [Pick the right tool](#pick-the-right-tool)
- [Create the schema of an empty database: ensureCreated()](#create-the-schema-of-an-empty-database-ensurecreated)
- [Configure and log the schema manager: getSchemaManager()](#configure-and-log-the-schema-manager-getschemamanager)
- [Apply model changes to an existing database: migrate()](#apply-model-changes-to-an-existing-database-migrate)
- [Preview the plan without changing anything: analyze()](#preview-the-plan-without-changing-anything-analyze)
- [Know what migrate() never changes](#know-what-migrate-never-changes)
- [Run SQL before and after schema work: onMigrationStart and onMigrationComplete](#run-sql-before-and-after-schema-work-onmigrationstart-and-onmigrationcomplete)
- [Map tables another owner manages: isExternallyManaged()](#map-tables-another-owner-manages-isexternallymanaged)
- [Repair INVALID indexes: IndexRepairError](#repair-invalid-indexes-indexrepairerror)
- [Version schema changes in migration files: MigrationRunner](#version-schema-changes-in-migration-files-migrationrunner)
- [Draft a migration file from the model diff: MigrationScaffold](#draft-a-migration-file-from-the-model-diff-migrationscaffold)
- [Drop every model object in a throwaway database: ensureDeleted()](#drop-every-model-object-in-a-throwaway-database-ensuredeleted)
- [Run schema tasks from scripts and CI](#run-schema-tasks-from-scripts-and-ci)
- [Add enum labels: migrate(), not EnumMigrator](#add-enum-labels-migrate-not-enummigrator)
- [Migration operations reference](#migration-operations-reference)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Pick the right tool

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Tables for tests, local development or a new empty database | `db.getSchemaManager().ensureCreated()` | `CREATE … IF NOT EXISTS` per object, sent again on every call · 3 for the `users` / `posts` slice (2 tables, 1 index) | a database whose tables changed: it never adds or alters a column |
| Apply additive model changes (development, CI, simple deploys) | `db.getSchemaManager().migrate()` | catalog reads (9 for the two-table slice in sync), then one `ALTER` / `CREATE` per change, each committed on its own | drops, renames, length changes (never planned); `serial()` keys (it drops their default) |
| See what `migrate()` would do | `db.getSchemaManager().analyze()` | the same catalog reads, no schema change · 15 for the example change | calling `migrate()` right after it: `migrate()` reads everything again |
| Reviewed, versioned production changes; drops, renames, backfills, `CONCURRENTLY` | migration files + `new MigrationRunner(db, config).up()` | 5 journal statements, then per file: its statements inside `BEGIN … COMMIT` + 1 journal `INSERT` | a database that has tables but no journal table: the files are recorded, not run |
| A first draft of a migration file | `new MigrationScaffold(db, config).scaffold()` | the reads of `analyze()`; writes a `.ts` file | committing it unread: it misses a new table's foreign keys and indexes |
| Undo the newest files | `runner.down(n)` | 4 journal statements, then per file: its `down()` + 1 journal `DELETE` | files the running build no longer contains |
| Remove every model object from a throwaway database | `db.getSchemaManager().ensureDeleted()` | `DROP … CASCADE` per view, table, sequence, enum, schema | shared databases: `DROP SCHEMA … CASCADE` removes objects the model does not know |
| SQL the model cannot describe (extensions, roles, functions, triggers, grants, partitions) | `onMigrationStart` / `onMigrationComplete` overrides | whatever the hook sends, outside any transaction | data backfills: `onMigrationStart` runs again on every `ensureCreated()`, `migrate()` and `up()`, `onMigrationComplete` on every `ensureCreated()` and every `migrate()` that changed something |

Golden rules:

1. **The model is the source of truth.** A migration file brings an existing database up to the model; a fresh database is built from the model and the files are only recorded. Every schema change a file makes must also be declared in the model; what the model cannot hold (rows, storage parameters) needs `runOnBaseline = true`.
2. **`MigrationRunner.up()` and `down()` resolve when a file fails.** Check `result.failed`.
3. **After `up()` on a database at the previous release's schema, `analyze()` must return `[]`.** Anything else is a model change no file makes.
4. **Run schema changes from one process at a time.** No API takes a lock.

<a id="ensurecreated"></a>

## Create the schema of an empty database: `ensureCreated()`

`ensureCreated()` creates every object the model declares that is missing, one statement per object, then runs `onMigrationComplete`. It sends the same `IF NOT EXISTS` statements again on every call. Use it for tests, local development and new databases; for a database whose tables exist, use `migrate()` or migration files: `ensureCreated()` never adds or changes a column.

The examples on this page use this two-table slice of the example model:

```ts
// src/database.ts
import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, text, boolean, timestamp } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;
  posts?: Post[];
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;
  views!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  user?: User;
}

export class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  get posts(): DbEntityTable<Post> {
    return this.table(Post);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired().isUnique();
      entity.property(e => e.email).hasType(text('email')).isRequired();
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
      entity.hasMany(e => e.posts, () => Post).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
    });

    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.views).hasType(integer('views')).hasDefaultValue(0);
      entity.property(e => e.publishedAt).hasType(timestamp('published_at')).hasDefaultValue('NOW()');
      entity.hasOne(e => e.user, () => User).withForeignKey(p => p.userId).withPrincipalKey(u => u.id).onDelete('cascade');
      entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
    });
  }
}
```

```ts
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './src/database';

const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));
await db.getSchemaManager().ensureCreated();
```

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL UNIQUE,
  "email" text NOT NULL,
  "is_active" boolean DEFAULT TRUE,
  "created_at" timestamp DEFAULT NOW(),
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "user_id" integer NOT NULL,
  "views" integer DEFAULT 0,
  "published_at" timestamp DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
)

CREATE INDEX IF NOT EXISTS "ix_posts_query" ON "posts" ("user_id", "published_at")
```

3 statements = 3 round trips, each committed on its own; a second call sends the same 3.

The order, for a model that uses every feature:

1. `onMigrationStart`
2. `CREATE SCHEMA IF NOT EXISTS` for each schema a table names with `toSchema()`
3. collations, enums, sequences: an existence check each (`SELECT EXISTS (…)`), then `CREATE` when missing. Collations and enums: every `pgCollation()` / `pgEnum()` registered in the process, used by this model or not
4. the `search_normalize` support (`CREATE EXTENSION IF NOT EXISTS unaccent`, …) when the model needs it
5. tables in foreign-key order: `CREATE TABLE IF NOT EXISTS` with the foreign keys whose referenced key already exists inline, each table followed by its unique indexes
6. the other foreign keys (a cycle, a key on a unique index built later): a lookup, then `ALTER TABLE … ADD CONSTRAINT` when missing
7. the other indexes: `CREATE INDEX IF NOT EXISTS`
8. CHECK constraints: a lookup per table that declares one, and another before each missing one's `ALTER TABLE … ADD CONSTRAINT … CHECK (…)`
9. extended statistics: `CREATE STATISTICS IF NOT EXISTS` + `ANALYZE <table>` per object, on every call
10. database settings (`model.hasDbSetting()`), when declared: one read, then one `DO` block per missing or drifted value
11. views (`model.view()`): `DROP VIEW IF EXISTS` for every model view, then `CREATE VIEW` + `COMMENT ON VIEW` (the definition's hash), on every call
12. `onMigrationComplete`

On a database whose tables exist, `ensureCreated()` with the changed model of the [migrate() section](#apply-model-changes-to-an-existing-database-migrate) sent 7 statements: both `CREATE TABLE IF NOT EXISTS` (no-ops), `CREATE INDEX IF NOT EXISTS` for `ix_posts_query` (no-op: the name exists with the old definition) and for the new `ix_posts_title`, the CHECK lookup (twice) and `ALTER TABLE "posts" ADD CONSTRAINT "chk_posts_views" …`. The new columns `users.age` and `posts.subtitle` were not added, `posts.views` stayed nullable and `users.email` stayed `text`.

> **Efficiency:** every call sends every statement again, re-runs `ANALYZE` for each `hasStatistics()` object and drops and re-creates every model view (which loses its grants). Run it for a new database, not on every application start.

> **Pitfall:** `ensureCreated()` is not atomic. A failure leaves the statements before it committed; fix the cause and call it again.

## Configure and log the schema manager: `getSchemaManager()`

`db.getSchemaManager(options?)` returns a `DbSchemaManager` over the context's client and model. It sends no SQL; create one per task.

```ts
const schema = db.getSchemaManager({
  concurrentIndexes: true,      // default false: every index this manager builds uses CREATE INDEX CONCURRENTLY
  recreateChangedIndexes: true, // default true: rebuild a same-named index whose definition changed
});
await schema.migrate();
```

| Method | Does | Fires |
|---|---|---|
| `ensureCreated()` | creates what is missing; on an existing table adds missing indexes and CHECK constraints by name, never adds or changes a column; re-creates every view | `onMigrationStart`, `onMigrationComplete` |
| `migrate()` | applies the difference between model and catalog | `onMigrationStart`; `onMigrationComplete` when it ran an operation |
| `analyze()` | returns the plan (`MigrationOperation[]`), changes nothing | nothing |
| `ensureDeleted()` | drops the model's views, tables and sequences, every registered enum and every schema a table names | nothing |
| `runPreMigrationHook()` | runs `onMigrationStart` only | `onMigrationStart` |
| `ensureSearchNormalizeSupport()` | creates the `unaccent` extension (and `pg_trgm` for a GIN `ixNormalized` index) and `public.search_normalize(text)` when an `ixNormalized` index or `model.useSearchNormalize()` needs them | nothing |

`concurrentIndexes: true` cannot be used inside a transaction (PostgreSQL refuses `CONCURRENTLY` there).

**Logging.** Progress lines go to `QueryOptions.logger` (default `console.log`). `logQueries` adds progress lines but never prints the schema manager's SQL, which goes to the client directly. Without `logQueries`: `analyze()` and `migrate()` always log (`Analyzing database schema...`, the plan, each operation), `ensureCreated()` logs its index, CHECK, statistics, deferred foreign-key and view lines, `ensureDeleted()` logs nothing. Progress lines have no `LogSection`; warnings come as `'warn'`:

```ts
// progress lines have no section; warnings come as 'warn'
const migratingDb = new AppDatabase(client, {
  logger: (message, section) => {
    if (section === 'warn' || section === 'error') console.warn(message);
  },
});
await migratingDb.getSchemaManager().migrate();
```

<a id="automatic-migrations"></a>

## Apply model changes to an existing database: `migrate()`

`migrate()` runs `onMigrationStart`, reads the catalog (the plan `analyze()` returns) and applies the difference in a fixed order, each statement on its own (no transaction around them: a failure leaves the earlier statements applied). It never drops what the model no longer declares, never renames and never narrows a type ([what it never changes](#know-what-migrate-never-changes)). Use it in development, CI and for deploys whose changes are additive; use migration files for changes that need review, a rename, a drop or a backfill.

The slice above, changed:

```ts
// fragment: changed lines of setupModel() — users
entity.property(e => e.email).hasType(varchar('email', 320)).isRequired();                // was text('email')
entity.property(e => e.age).hasType(integer('age'));                                        // new column
// posts
entity.property(e => e.subtitle).hasType(varchar('subtitle', 200));                        // new column
entity.property(e => e.views).hasType(integer('views')).isRequired().hasDefaultValue(0);   // now NOT NULL
entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]).include(e => [e.views]); // + INCLUDE ("views")
entity.hasIndex('ix_posts_title', e => [e.title]);                                           // new index
entity.hasCheckConstraint('chk_posts_views', '"views" >= 0');                               // new CHECK
```

```ts
await db.getSchemaManager().migrate();
```

After 15 catalog reads (listed under [analyze()](#preview-the-plan-without-changing-anything-analyze)), it sends:

```sql
ALTER TABLE "users" ADD COLUMN "age" integer

ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar(320) USING "email"::varchar(320)

ALTER TABLE "posts" ADD COLUMN "subtitle" varchar(200)

ALTER TABLE "posts" ALTER COLUMN "views" SET NOT NULL

CREATE INDEX IF NOT EXISTS "ix_posts_title" ON "posts" ("title")

DROP INDEX IF EXISTS "ix_posts_query"

CREATE INDEX IF NOT EXISTS "ix_posts_query" ON "posts" ("user_id", "published_at") INCLUDE ("views")

SELECT con.conname
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relname = $2
  AND con.contype = 'c'
-- params: [ "public", "posts" ]

ALTER TABLE "posts" ADD CONSTRAINT "chk_posts_views" CHECK ("views" >= 0)
```

24 statements = 24 round trips. A second `migrate()` sends the 10 catalog reads only (1 table list + 4 per table + 1 CHECK lookup for `posts`), logs `Database schema is already in sync with model` and does not fire `onMigrationComplete`.

The order `migrate()` runs operations in:

| Step | What runs |
|---|---|
| 1 | `onMigrationStart`; the `search_normalize` support when the model needs it |
| 2 | the catalog reads of `analyze()`; an empty plan ends the call here |
| 3 | `DROP VIEW` of every existing model view when the plan alters a column; otherwise of each view whose definition changed and every view declared after it |
| Phase 1 | schemas, collations, enums and new enum labels, sequences, new tables (without foreign keys), added and altered columns |
| Phase 2 | new or recreated UNIQUE indexes, then foreign keys: new ones on existing tables and every foreign key of a new table, as `ALTER TABLE … ADD CONSTRAINT` |
| Phase 3 | the other indexes (new and recreated), CHECK constraints, extended statistics (+ `ANALYZE`), database settings |
| Views | `CREATE VIEW` + `COMMENT ON VIEW` |
| Phase 4 | repairs of INVALID indexes, each on its own ([below](#repair-invalid-indexes-indexrepairerror)) |
| Last | `onMigrationComplete`; then `IndexRepairError` if a repair failed |

What each model change becomes:

| Model change | `analyze()` operation | SQL `migrate()` sends |
|---|---|---|
| new table | `create_table` | `CREATE TABLE IF NOT EXISTS` without foreign keys; its foreign keys, indexes and CHECKs in later phases; its extended statistics (`hasStatistics()`) only on the next `migrate()` |
| new column | `add_column` | `ALTER TABLE … ADD COLUMN "c" <type>[(n)] [COLLATE …] [NOT NULL] [UNIQUE] [DEFAULT …]` (never `IDENTITY`) |
| base type changed (`text` → `varchar`, `integer` → `bigint`) | `alter_column` | `ALTER COLUMN "c" TYPE <type>[(n)] USING "c"::<type>[(n)]` |
| `isRequired()` added or removed | `alter_column` | `ALTER COLUMN "c" SET NOT NULL` / `DROP NOT NULL` |
| default added, changed or removed | `alter_column` | `ALTER COLUMN "c" SET DEFAULT …` / `DROP DEFAULT` |
| collation set or changed on a column | `alter_column` | `ALTER COLUMN "c" TYPE <type>[(n)] COLLATE "<collation>"` |
| new index | `create_index` | `CREATE [UNIQUE] INDEX [CONCURRENTLY] IF NOT EXISTS …` |
| same-named index, changed columns, `INCLUDE`, `WHERE`, method, operator class, expressions or uniqueness | `recreate_index` | `DROP INDEX IF EXISTS` + `CREATE INDEX …`; both `CONCURRENTLY` with `.concurrent()` or `concurrentIndexes`. A unique index a foreign key rests on (since 1.0.20): 1 lookup, then in one transaction `DROP CONSTRAINT`, `DROP INDEX`, a blocking `CREATE UNIQUE INDEX` (also for `.concurrent()`, with a `'warn'` line) and `ADD CONSTRAINT` |
| new foreign key (`hasOne`) | `create_foreign_key` | `ALTER TABLE … ADD CONSTRAINT "<name>" FOREIGN KEY (…) REFERENCES …` |
| new CHECK name | `create_check_constraint` | a lookup, then `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` |
| new statistics name | `create_statistics` | `CREATE STATISTICS IF NOT EXISTS …` + `ANALYZE <table>` |
| new schema, collation, enum, sequence | `create_schema`, `create_collation`, `create_enum`, `create_sequence` | `CREATE SCHEMA IF NOT EXISTS`, `CREATE COLLATION IF NOT EXISTS`, `CREATE TYPE … AS ENUM`, `CREATE SEQUENCE` |
| new enum label | `add_enum_value` | `ALTER TYPE … ADD VALUE IF NOT EXISTS '<label>'`, appended after the existing labels |
| `hasDbSetting()` missing or drifted | `set_database_setting` | `DO … ALTER DATABASE <current> SET …` |
| new view | `create_view` | `CREATE VIEW` + `COMMENT ON VIEW`, after every table operation |
| changed view definition, or any altered column | `drop_view` + `create_view` | `DROP VIEW IF EXISTS` first, `CREATE VIEW` + `COMMENT ON VIEW` last |

> **Efficiency:** a same-named index whose definition looks changed is first built on an empty temporary copy of the table and compared with `pg_get_indexdef()` (5 statements for one index, 3 more for each further index of the same table), so an index PostgreSQL stores in another spelling is never rebuilt. A recreate is a blocking `DROP INDEX` + `CREATE INDEX` unless the index is `.concurrent()` or the manager runs with `concurrentIndexes: true`; on large tables use the concurrent form. A unique index a foreign key rests on is always rebuilt blocking.

> **Pitfall:** PostgreSQL validates existing rows: `SET NOT NULL` fails while a row holds NULL, `ADD COLUMN … NOT NULL` without a default fails on a non-empty table, `TYPE … USING` fails for a value that does not convert, `ADD CONSTRAINT … CHECK` fails for a violating row. Backfill in a migration file first; the statements `migrate()` ran before the failure stay applied.

<a id="operation-analysis"></a>

## Preview the plan without changing anything: `analyze()`

`analyze()` returns the plan `migrate()` would apply, without changing the schema. `migrate()` runs it in the phase order above, not in list order, and a `create_table` also stands for that table's foreign keys, indexes and CHECK constraints, which `migrate()` adds in later phases. Use it to review a deploy, or as a CI gate. It reads the catalog exactly as `migrate()` does, so calling `migrate()` afterwards repeats every read. It runs no hook.

```ts
const plan = await db.getSchemaManager().analyze();
console.log(plan.map(op => op.type));
// ['add_column', 'alter_column', 'add_column', 'alter_column', 'create_index', 'recreate_index', 'create_check_constraint']
```

Result type: `MigrationOperation[]` ([reference](#migration-operations-reference)). For the change above it sent 15 statements:

| Read | Statements |
|---|---|
| tables of each model schema: `SELECT c.relname AS table_name FROM pg_class c …` | 1 per schema |
| columns: `information_schema.columns` | 1 per existing table |
| indexes: `pg_index` with `pg_get_indexdef(…, 0, true)` | 1 per existing table |
| extended statistics: `pg_statistic_ext` | 1 per existing table |
| CHECK names: `pg_constraint … contype = 'c'` | 1 per existing table that declares a CHECK |
| foreign keys: a join over `information_schema.table_constraints` | 1 per existing table |
| schema existence: `information_schema.schemata` | 1 per schema a table names with `toSchema()` |
| collations, enum labels, sequences | 1 per registered collation / enum / model sequence |
| database settings: `pg_db_role_setting` | 1 when the model declares `hasDbSetting()` |
| view markers: `pg_class … relkind = 'v'` | 1 per schema holding a model view |
| index builds: `pg_stat_progress_create_index` | when a table holds an INVALID index |

An index whose definition looks changed adds the comparison on a temporary copy of the table (here `ix_posts_query`):

```sql
CREATE TEMP TABLE "_lkg_idxchk_49600_1" (LIKE "posts")

CREATE INDEX "_lkg_idxchk_49600_1_ix0" ON "_lkg_idxchk_49600_1" ("user_id", "published_at") INCLUDE ("views")

SELECT pg_get_indexdef(to_regclass($1)::oid, 0, true) AS d
-- params: [ "_lkg_idxchk_49600_1_ix0" ]

DROP INDEX IF EXISTS "_lkg_idxchk_49600_1_ix0"

DROP TABLE IF EXISTS "_lkg_idxchk_49600_1"
```

A role without the TEMP privilege cannot run this comparison: the index is then left as it is, with a warning. Tables marked `isExternallyManaged()` that exist get no per-table reads.

A CI gate: on a database at the previous release's schema, run the pending files, then fail when the model still differs:

```ts
const plan = await db.getSchemaManager().analyze();
if (plan.length > 0) {
  throw new Error(`the model has changes no migration file makes: ${plan.map(op => op.type).join(', ')}`);
}
```

> **Pitfall:** `analyze()` does not create the `search_normalize` function; on a database without it, a changed `ixNormalized` index cannot be confirmed on the temporary copy and is reported unchanged. `migrate()` creates the function before its own analysis.

## Know what `migrate()` never changes

`migrate()` only adds and alters. Removed, renamed and narrowed things stay in the database, and several changes are compared by name only. Make those changes in a migration file.

Starting from the slice above, this model changes six things, and `analyze()` plans one operation:

```ts
// fragment: users
entity.property(e => e.username).hasType(varchar('username', 150)).isRequired().isUnique(); // length 100 -> 150
entity.property(e => e.email).hasType(text('email')).isRequired().isUnique();               // + UNIQUE
// posts: title removed from the model, "views" renamed, the foreign key action changed, ix_posts_query removed
entity.property(e => e.viewCount).hasType(integer('view_count')).hasDefaultValue(0);
entity.hasOne(e => e.user, () => User).withForeignKey(p => p.userId).withPrincipalKey(u => u.id).onDelete('restrict');
```

```ts
const plan = await db.getSchemaManager().analyze();
console.log(plan.map(op => `${op.type} ${'tableName' in op ? op.tableName : ''}.${'columnName' in op ? op.columnName : ''}`));
// ['add_column posts.view_count']
```

After `migrate()`, `posts` has the columns `id, title, user_id, views, published_at, view_count`: the old `views` keeps its data (a row with `views` = 5 kept it), the new `view_count` holds its default (`0`) in existing rows, not the old values, and `db.posts.insert({ userId: 1, viewCount: 0 })` fails with `null value in column "title" of relation "posts" violates not-null constraint` (23502), because the model no longer sends `title`. `username` stays `varchar(100)`, `email` gets no unique index, the foreign key keeps `ON DELETE CASCADE` and `ix_posts_query` stays.

| Model change | `migrate()` does | Do instead (migration file) |
|---|---|---|
| table, column, index, foreign key, CHECK, statistics, view, enum label or `hasDbSetting()` removed | nothing: the object stays | `DROP …` in a file; drop or relax a NOT NULL column in the release that removes it from the model |
| column renamed (new DB name) | adds a new column under the new name (NULL, or its default, in existing rows) | `ALTER TABLE … RENAME COLUMN` |
| `varchar` length, `decimal`/`numeric` precision or scale changed | nothing (only the base type is compared) | `ALTER COLUMN … TYPE varchar(150)` |
| `isUnique()` added to an existing column | nothing | `hasIndex('uq_…', e => [e.col]).isUnique()`, which `migrate()` creates |
| foreign key action (`onDelete`, `onUpdate`) or columns changed under the same name | nothing (compared by name) | `DROP CONSTRAINT` + `ADD CONSTRAINT` |
| CHECK expression or statistics definition changed under the same name | nothing (compared by name) | rename it in the model (`migrate()` creates the new one) and drop the old one in a file |
| `generatedAlwaysAsIdentity()` column added to an existing table | `ADD COLUMN` without `IDENTITY` | `ADD COLUMN … GENERATED ALWAYS AS IDENTITY` |
| `hasPartitioning()` added or changed on an existing table | nothing | rebuild the table |
| an `isExternallyManaged()` table that exists | nothing, ever | — |
| a `serial()` / `bigserial()` column | the first `migrate()` after the table was created (by `ensureCreated()` or `migrate()`) plans `alter_column` and sends `ALTER COLUMN "id" DROP DEFAULT`; from then on inserts without the key fail with 23502 (later runs plan nothing for it) | declare keys with `generatedAlwaysAsIdentity()`; do not run `migrate()` on a model with a serial column |
| a foreign key to a table in another schema | `create_foreign_key` on every run; `migrate()` fails with `constraint "…" for relation "…" already exists` | `.isInverseNavigation()` on that `hasOne` (the model then creates no constraint; joins are unchanged) and the constraint in a file with `runOnBaseline = true` |

The serial default drop was verified on PostgreSQL 18.3 (PGlite) and on the in-memory database: right after `ensureCreated()` built a table with a `serial('id').primaryKey()` key (default `nextval('tickets_id_seq'::regclass)`), `analyze()` planned `alter_column` for it; after `migrate()` (`ALTER TABLE "tickets" ALTER COLUMN "id" DROP DEFAULT`) the column had no default, the next `analyze()` returned `[]`, and an insert without the key failed with `null value in column "id" of relation "tickets" violates not-null constraint`. The model has no default for the column and the catalog does, so the first comparison drops it.

<a id="pre-migration-hooks"></a><a id="post-migration-hooks"></a>

## Run SQL before and after schema work: `onMigrationStart` and `onMigrationComplete`

Override these two methods of your context class for SQL the model cannot describe: extensions, roles, functions, triggers, materialized views, grants, table partitions. `onMigrationStart` runs before any schema statement; `onMigrationComplete` runs after the schema statements. Both receive the context's `DatabaseClient`; called through the root context (not a `db.transaction()` context) they run outside any transaction, so `CREATE INDEX CONCURRENTLY` works in them.

```ts
// fragment: methods of the AppDatabase class above (import DatabaseClient from 'linkgress-orm')
protected override async onMigrationStart(client: DatabaseClient): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}

protected override async onMigrationComplete(client: DatabaseClient): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION posts_touch_published_at() RETURNS trigger AS $$
    BEGIN
      NEW.published_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await client.query(`DROP TRIGGER IF EXISTS trg_posts_touch ON "posts"`);
  await client.query(`CREATE TRIGGER trg_posts_touch BEFORE UPDATE OF "title" ON "posts" FOR EACH ROW EXECUTE FUNCTION posts_touch_published_at()`);
}
```

`ensureCreated()` on an empty database then sends the start hook's statement, the 3 statements of the slice, and the complete hook's statements:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm

CREATE OR REPLACE FUNCTION posts_touch_published_at() RETURNS trigger AS $$
BEGIN
  NEW.published_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql

DROP TRIGGER IF EXISTS trg_posts_touch ON "posts"

CREATE TRIGGER trg_posts_touch BEFORE UPDATE OF "title" ON "posts" FOR EACH ROW EXECUTE FUNCTION posts_touch_published_at()
```

7 statements = 7 round trips (the two `CREATE TABLE` and the `CREATE INDEX` run between the first and the second statement above).

When each hook fires (verified):

| Call | `onMigrationStart` | `onMigrationComplete` |
|---|---|---|
| `ensureCreated()` | first | last, on every call |
| `migrate()` that runs at least one operation | first, before the catalog reads | after the last operation, before an `IndexRepairError` is thrown |
| `migrate()` with nothing to do | first | never |
| `MigrationRunner.up()` without a journal table (fresh database) | first (through `migrate()`) | when that `migrate()` ran an operation |
| `MigrationRunner.up()` with a journal table | after the journal-existence check, before the files | never |
| `analyze()`, `ensureDeleted()`, `down()`, `status()`, `getPending()`, `getApplied()`, `MigrationScaffold` | never | never |

- Make both idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS` before `CREATE`): they run on every call listed above.
- An error in `onMigrationStart` stops the call before any schema statement. An error in `onMigrationComplete` rejects the call after its schema statements have committed.
- Send one statement per `client.query()` call: `PGliteClient` refuses several statements in one call (`cannot insert multiple commands into a prepared statement`).
- A view the model can own belongs in `model.view()` ([Schema configuration](./schema-configuration.md#expose-a-read-only-view-modelview)): it is created on fresh databases and re-created when its definition changes. A dropped and re-created view loses its grants, a changed owner and any comment other than the marker; keep readers' access with `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES` for the migrating role, or re-grant in `onMigrationComplete`.
- `hasPartitioning()` creates only the partitioned parent table; create and rotate its partitions in `onMigrationComplete` or a scheduled job, or inserts fail with `no partition of relation … found for row`.

> **Pitfall:** put the overrides in the class that declares the table getters. A subclass of such a class (`class MigratingDb extends AppDatabase { onMigrationStart… }`) throws a `TypeError` when constructed (`Attempted to assign to readonly property.` under Bun) as soon as one of the inherited getters has its table's name (`get users()` for table `users`): the context looks for table getters on the instance's direct prototype only, and assigns to the inherited getter. A subclass whose getter names differ from the table names (`get members()` for table `app_members`) constructs and runs.

<a id="tables-owned-elsewhere-isexternallymanaged"></a>

## Map tables another owner manages: `isExternallyManaged()`

Some tables a context reads belong to someone else: a data warehouse loads them, or another service owns their DDL and the migrating role may not even own them. As ordinary entities, every difference between the mapping and their DDL becomes a migration, and `migrate()` fails with `must be owner of table …` where the role does not own them. Mark such an entity with `isExternallyManaged()`: when the table exists, the schema manager never compares or alters it; when it is missing (a fresh, local or test database), it is created from the model with its indexes, CHECK constraints and foreign keys, and left alone from then on.

```ts
// fragment: inside setupModel()
model.entity(SkiRun, entity => {
  entity.toTable('skied_kilometers');
  entity.toSchema('dwh');
  entity.isExternallyManaged();

  entity.property(e => e.id).hasType(bigint('id')).isPrimaryKey();
  entity.property(e => e.userId).hasType(bigint('user_id')).isRequired();
  entity.property(e => e.kilometers).hasType(integer('kilometers')).isRequired();
  entity.hasIndex('ix_skied_kilometers_user_id', e => [e.userId]);
});
```

With `dwh.skied_kilometers` already created by its owner (an extra column, no index), `ensureCreated()` sends 2 statements and creates nothing for it:

```sql
CREATE SCHEMA IF NOT EXISTS "dwh"

SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
-- params: [ "dwh" ]
```

`analyze()` returns `[]` for it (2 reads: the schema check and the `pg_class` read). With the table missing, `ensureCreated()` sends `CREATE TABLE IF NOT EXISTS "dwh"."skied_kilometers" (…)` and `CREATE INDEX IF NOT EXISTS "ix_skied_kilometers_user_id" …` after the same 2 statements.

- The model must still name the real columns, or queries fail. The flag removes the migration, not the need for a correct mapping.
- Existing tables are read from `pg_class`, which lists every table whatever the role's privileges (before 1.0.18 they came from `information_schema.tables`, which hides tables the role cannot access, so such a table looked missing).
- `ensureCreated()` adds 1 existence read per model schema when any table is externally managed.

> **Pitfall:** `ensureDeleted()` ignores the flag: it sends `DROP TABLE IF EXISTS "dwh"."skied_kilometers" CASCADE` and `DROP SCHEMA IF EXISTS "dwh" CASCADE`, which removes everything else in that schema too.

## Repair INVALID indexes: `IndexRepairError`

A failed or cancelled `CREATE INDEX CONCURRENTLY` leaves an INVALID index under its name: PostgreSQL never reads it, and `CREATE INDEX … IF NOT EXISTS` skips it. `analyze()` plans a `repair_index` for a model index present only INVALID, and `migrate()` rebuilds it from the model after every other operation, each repair on its own (`ensureCreated()` does not repair). The details, and the INVALID indexes left alone with a warning, are in [Schema configuration](./schema-configuration.md#repair-an-invalid-index).

The blocking repair of a unique index `uq_users_email` (no `.concurrent()`, no `concurrentIndexes`) builds the model's index under a temporary name, then swaps it in; the last two statements run in one transaction:

```sql
CREATE UNIQUE INDEX "uq_users_email_lkgnew" ON "users" ("email")

DROP INDEX IF EXISTS "uq_users_email"

ALTER INDEX "uq_users_email_lkgnew" RENAME TO "uq_users_email"
```

That `migrate()` sent 12 statements (+2 for `BEGIN` / `COMMIT`): the catalog reads (an INVALID index adds a `pg_stat_progress_create_index` read per read of the table's indexes), a re-read of the table's indexes before the rebuild, the 3 statements above, and a re-read after it, which checks that the index is now valid.

With `.concurrent()` or `concurrentIndexes: true` it sends `DROP INDEX CONCURRENTLY IF EXISTS` + `CREATE INDEX CONCURRENTLY IF NOT EXISTS` instead. A repair that fails does not stop the migration: `migrate()` finishes every other operation, runs `onMigrationComplete`, then throws one `IndexRepairError` naming every failed index:

```ts
import { IndexRepairError } from 'linkgress-orm';

try {
  await db.getSchemaManager().migrate();
} catch (error) {
  if (error instanceof IndexRepairError) {
    // every other operation ran; these index rebuilds failed
    for (const failure of error.failures) {
      console.error(failure.indexName, failure.code, failure.reason); // uq_users_email 23505 could not create unique index …
    }
  }
  throw error;
}
```

Captured with duplicate e-mails still in the table: `Could not repair INVALID index "uq_users_email" on "users": could not create unique index "uq_users_email_lkgnew" — Key (email)=(a@example.com) is duplicated. Fix the cause and run the migration again.` (`failures[0].code` = `'23505'`). Every later `migrate()` ends with the same error until the duplicates are gone.

<a id="manual-migrations-file-based"></a><a id="migrationrunner"></a>

## Version schema changes in migration files: `MigrationRunner`

Migration files are TypeScript files with an `up()` and a `down()`; `MigrationRunner` runs the pending ones in name order, each in its own transaction unless the file opts out, and records each in the journal table `__migrations`. Use them for production schema changes: they are reviewed, versioned and run once per database, and they can do what `migrate()` never does (drops, renames, backfills, `CONCURRENTLY`).

### Write a migration file

The runner loads every `*.ts` file of `migrationsDirectory` (relative paths resolve against `process.cwd()`), except `*.d.ts`, with `require()`: run it under Bun, ts-node or tsx. The default export is a class (instantiated with `new`) or an object with `up(db)` and `down(db)`; both are required. `db` is the runner's context, inside a transaction its transaction context.

```ts
// migrations/20261001-090000.ts
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  async up(db: AppDatabase): Promise<void> {
    await db.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" varchar(100)`);
    await db.query(`UPDATE "users" SET "display_name" = "username" WHERE "display_name" IS NULL`);
  }

  async down(db: AppDatabase): Promise<void> {
    await db.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "display_name"`);
  }
}
```

- Write SQL with `db.query()`, one statement per call. A file must keep working after the model changes again; typed table accessors follow the current model.
- Make statements re-runnable (`IF NOT EXISTS`, `IF EXISTS`, `ON CONFLICT DO NOTHING`): the journal row is written after the file's transaction commits, in a separate statement, so a crash between the two runs the file again on the next `up()`.
- Name files `YYYYMMDD-HHMMSS.ts` (what `MigrationLoader.generateFilename()` and the scaffold produce). Files run in name order.
- Declare the same change in the model ([golden rule 1](#pick-the-right-tool)):

```ts
// fragment: the model declares what the files create
entity.property(e => e.displayName).hasType(varchar('display_name', 100));
entity.hasIndex('ix_users_display_name', e => [e.displayName]).concurrent();
```

<a id="migrations-that-cannot-run-in-a-transaction-transaction--false"></a>

### Run a file outside a transaction: `transaction = false`

PostgreSQL refuses some statements inside a transaction block: `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM` (and `ALTER TYPE … ADD VALUE` before PostgreSQL 12). A long backfill may also need to commit in batches. Declare `transaction = false` (default `true`):

```ts
// migrations/20261002-090000.ts
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  // CREATE / DROP INDEX CONCURRENTLY cannot run inside a transaction block
  transaction = false;

  async up(db: AppDatabase): Promise<void> {
    await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_users_display_name" ON "users" ("display_name")`);
  }

  async down(db: AppDatabase): Promise<void> {
    await db.query(`DROP INDEX CONCURRENTLY IF EXISTS "ix_users_display_name"`);
  }
}
```

- `up()` / `down()` receive the runner's own context and each statement commits on its own. The file is not atomic: a failure part-way keeps the statements that already ran.
- It is recorded only after `up()` resolves (and removed only after `down()` resolves), so a failed file stays pending and the next `up()` runs it again. A failed concurrent build leaves an INVALID index: drop it before building again (`IF NOT EXISTS` skips it).
- On a pooled client, statements may run on different connections: session state (`SET`, temp tables, advisory locks) does not carry over. Open `db.transaction()` inside the file for the parts that need it.
- The flag applies on every path that runs a file: pending `up()`, `runOnBaseline` on a fresh database, and `down()`.

### Run a file on fresh databases too: `runOnBaseline`

On a fresh database the files are recorded without running ([below](#start-a-fresh-database-from-the-model-the-baseline)). Effects the model cannot describe (seed or configuration rows, backfills, storage parameters such as per-table autovacuum settings) would then be missing. Declare `runOnBaseline = true` (default `false`) so the fresh-database path runs the file:

```ts
// migrations/20261003-090000.ts
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  // Rows are not part of the model: run this file on a fresh database too
  runOnBaseline = true;

  async up(db: AppDatabase): Promise<void> {
    await db.query(
      `INSERT INTO "users" ("username", "email") VALUES ('system', 'system@example.com') ON CONFLICT ("username") DO NOTHING`,
    );
  }

  async down(db: AppDatabase): Promise<void> {
    await db.query(`DELETE FROM "users" WHERE "username" = 'system'`);
  }
}
```

On the fresh path such files run in name order after the model build, each in its own transaction, and are recorded with `baselined = false`. A failure stops the run like any file failure: the failed file and the `runOnBaseline` files after it stay pending and run through the normal path on the next `up()`. On a database with a journal the flag changes nothing. The file must work against a schema built from the current model.

### Run pending files: `up()`

```ts
import { MigrationRunner } from 'linkgress-orm';

const runner = new MigrationRunner(db, {
  migrationsDirectory: './migrations',   // resolved against process.cwd()
  appliedBy: 'release-2026.10.04',       // stored in __migrations.applied_by
});

const result = await runner.up();
if (result.failed) throw result.failed.error; // up() resolves even when a file fails
```

`MigrationConfig`: `migrationsDirectory` (required), `journalTable` (default `'__migrations'`), `journalSchema` (default `'public'`), `verbose` (default `false`: only failures are logged), `logger` (default `console.log`), `appliedBy` (default unset: `NULL`).

On a database that has a journal table, with the three files above pending, `up()` reads and prepares the journal:

```sql
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = $1 AND table_name = $2
) as exists
-- params: [ "public", "__migrations" ]

CREATE TABLE IF NOT EXISTS "public"."__migrations" (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baselined BOOLEAN NOT NULL DEFAULT FALSE,
  applied_by TEXT
)

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS baselined BOOLEAN NOT NULL DEFAULT FALSE

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS applied_by TEXT

SELECT id, filename, applied_at, baselined, applied_by FROM "public"."__migrations" ORDER BY filename ASC
```

then runs each file and records it: the first and third file inside `BEGIN … COMMIT` (2 more round trips each, not in the capture), the second alone (`transaction = false`):

```sql
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" varchar(100)

UPDATE "users" SET "display_name" = "username" WHERE "display_name" IS NULL

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261001-090000.ts", false, "release-2026.10.04" ]

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_users_display_name" ON "users" ("display_name")

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261002-090000.ts", false, "release-2026.10.04" ]

INSERT INTO "users" ("username", "email") VALUES ('system', 'system@example.com') ON CONFLICT ("username") DO NOTHING

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261003-090000.ts", false, "release-2026.10.04" ]
```

12 statements captured (+4 for the two transactions). Result (`MigrationRunResult`): `{ applied: ['20261001-090000.ts', '20261002-090000.ts', '20261003-090000.ts'], skipped: [] }`.

- `applied`: files run now; `skipped`: files already in the journal; `baselined`: only on the fresh path; `failed`: `{ filename, error }` of the file that failed. The run stops at the first failure; that file's transaction is rolled back and it stays pending.
- An error outside a file (the journal statements, `onMigrationStart`, the fresh path's `migrate()`, a file that cannot be loaded or lacks `up` / `down`) rejects `up()` instead.
- On this path `up()` runs `onMigrationStart` but never `migrate()` and never `onMigrationComplete`: a model change without a file is not applied. After this run, `analyze()` returned `[]`.

### Start a fresh database from the model: the baseline

When the journal table does not exist, `up()` treats the database as fresh: it runs `migrate()` (which builds the schema from the model), creates the journal, records every file without `runOnBaseline` as applied with `baselined = true` without running it, then runs the `runOnBaseline` files. On an empty database with the model that declares `display_name` and its index:

```sql
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = $1 AND table_name = $2
) as exists
-- params: [ "public", "__migrations" ]

SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
-- params: [ "public" ]

CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL UNIQUE,
  "email" text NOT NULL,
  "display_name" varchar(100),
  "is_active" boolean DEFAULT TRUE,
  "created_at" timestamp DEFAULT NOW(),
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "user_id" integer NOT NULL,
  "views" integer DEFAULT 0,
  "published_at" timestamp DEFAULT NOW(),
  PRIMARY KEY ("id")
)

ALTER TABLE "posts" ADD CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_users_display_name" ON "users" ("display_name")

CREATE INDEX IF NOT EXISTS "ix_posts_query" ON "posts" ("user_id", "published_at")

CREATE TABLE IF NOT EXISTS "public"."__migrations" (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baselined BOOLEAN NOT NULL DEFAULT FALSE,
  applied_by TEXT
)

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS baselined BOOLEAN NOT NULL DEFAULT FALSE

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS applied_by TEXT

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261001-090000.ts", true, "release-2026.10.04" ]

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261002-090000.ts", true, "release-2026.10.04" ]

INSERT INTO "users" ("username", "email") VALUES ('system', 'system@example.com') ON CONFLICT ("username") DO NOTHING

INSERT INTO "public"."__migrations" (filename, baselined, applied_by) VALUES ($1, $2, $3)
-- params: [ "20261003-090000.ts", false, "release-2026.10.04" ]
```

14 statements captured (+2 for the `runOnBaseline` file's transaction). Result: `{ applied: ['20261003-090000.ts'], skipped: ['20261001-090000.ts', '20261002-090000.ts'], baselined: ['20261001-090000.ts', '20261002-090000.ts'] }`. Here the model built `display_name` and its index; file 1's `UPDATE` never ran, which is why golden rule 1 matters.

- Naming a file to sort first does not make it run first on a fresh database. Use `onMigrationStart` for "before everything", `runOnBaseline` for effects the model cannot hold.
- `migrate()` creates a new table without inline foreign keys and adds them with `ALTER TABLE … ADD CONSTRAINT`, unlike `ensureCreated()`.
- The `hasStatistics()` objects of the tables this `migrate()` creates are not built in the same run (a second `migrate()` plans `create_statistics`), and later `up()` calls never run `migrate()`: run `migrate()` once more after the baseline, or create them in a `runOnBaseline` file.

### Adopt migration files on an existing database

A database whose tables were built by `ensureCreated()` or `migrate()` has no journal table, so its first `up()` takes the fresh path: it runs `migrate()` and records every file without running it (only `runOnBaseline` files run). Create the journal before the first `up()`, and record the files the database already reflects as baselined:

```ts
// fragment
await runner.getJournal().ensureTable();
await runner.getJournal().recordApplied('20261001-090000.ts', true); // already reflected by this database
```

From then on `up()` runs the files the journal does not list.

### Revert the newest files: `down()`

```ts
const runner = new MigrationRunner(db, { migrationsDirectory: './migrations' });
const result = await runner.down(1);           // the newest journal row by filename
if (result.failed) throw result.failed.error;
console.log(result.applied);                   // ['20261003-090000.ts'] — the reverted files
```

```sql
CREATE TABLE IF NOT EXISTS "public"."__migrations" (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baselined BOOLEAN NOT NULL DEFAULT FALSE,
  applied_by TEXT
)

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS baselined BOOLEAN NOT NULL DEFAULT FALSE

ALTER TABLE "public"."__migrations" ADD COLUMN IF NOT EXISTS applied_by TEXT

SELECT id, filename, applied_at, baselined, applied_by FROM "public"."__migrations" ORDER BY filename ASC

DELETE FROM "users" WHERE "username" = 'system'

DELETE FROM "public"."__migrations" WHERE filename = $1
-- params: [ "20261003-090000.ts" ]
```

6 statements captured (+2 for the transaction around the file's `down()`).

- `down(count = 1)` reverts the last `count` journal rows in `ORDER BY filename` order, newest name first, not the most recently applied ones. Baselined rows count too.
- Each `down()` runs in a transaction unless the file sets `transaction = false`; the journal row is deleted after it resolves. The run stops at the first failure (`result.failed`).
- A row whose file is missing (a build that no longer ships it) is not deleted: nothing was undone, so it is reported in `result.failed` and the run stops there. Run `down()` from a build that contains the file, or, after reverting its effects by hand, delete the row with `MigrationJournal.recordReverted()`.
- `result.applied` lists the reverted files; `skipped` is empty.

### See which files ran: `status()`

```ts
const runner = new MigrationRunner(db, { migrationsDirectory: './migrations' });
for (const entry of await runner.status()) {
  console.log(entry.filename, entry.applied ? entry.appliedAt?.toISOString() : 'pending', entry.baselined, entry.appliedBy);
}
```

`status()` returns one entry per file: `{ filename, applied, appliedAt?, baselined?, appliedBy? }` (the last three are `undefined` for pending files; `appliedBy` is `null` for rows recorded without a label). It sends the same 4 journal statements as `down()` (3 DDL + 1 read). `getPending()` and `getApplied()` return `LoadedMigration` objects (`{ filename, timestamp, migration, filePath }`) after the same 4 statements. A journal row whose file is gone appears in none of them.

<a id="journal-table"></a>

### Read or repair the journal: `MigrationJournal`

The journal table (default `"public"."__migrations"`; `journalTable` / `journalSchema` change it, and a schema other than `public` gets `CREATE SCHEMA IF NOT EXISTS`) holds one row per recorded file:

| Column | Type | Meaning |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | |
| `filename` | `VARCHAR(255) NOT NULL UNIQUE` | the key: a renamed file is a new, pending file |
| `applied_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | when it was recorded |
| `baselined` | `BOOLEAN NOT NULL DEFAULT FALSE` | `true`: recorded by the fresh-database path without running; `false`: its `up()` ran (`runOnBaseline` files included) |
| `applied_by` | `TEXT` | `MigrationConfig.appliedBy` of the recording runner (a release or image tag, so a later rollback can pick the build that contains the files), `NULL` when unset; linkgress never reads it from the environment |

Journals created before `baselined` / `applied_by` existed are upgraded by the `ADD COLUMN IF NOT EXISTS` statements every runner call sends; old rows keep `false` / `NULL`. `runner.getJournal()` returns the runner's journal; `new MigrationJournal(client, { journalTable?, journalSchema?, appliedBy? })` builds one:

```ts
import { MigrationJournal } from 'linkgress-orm';

const journal = new MigrationJournal(db.getClient(), { appliedBy: 'manual-fix' });
if (await journal.isApplied('20261003-090000.ts')) {
  await journal.recordReverted('20261003-090000.ts'); // the file's effects were reverted by hand
}
```

```sql
SELECT 1 FROM "public"."__migrations" WHERE filename = $1
-- params: [ "20261003-090000.ts" ]

DELETE FROM "public"."__migrations" WHERE filename = $1
-- params: [ "20261003-090000.ts" ]
```

| Method | SQL | Returns |
|---|---|---|
| `tableExists()` | `SELECT EXISTS (… information_schema.tables …)` | `boolean` |
| `ensureTable()` | `CREATE TABLE IF NOT EXISTS` + 2 × `ADD COLUMN IF NOT EXISTS` (+ `CREATE SCHEMA IF NOT EXISTS`) | `void` |
| `getApplied()` | `SELECT … ORDER BY filename ASC` | `MigrationJournalEntry[]` (`id`, `filename`, `applied_at`, `baselined`, `applied_by`) |
| `isApplied(filename)` | `SELECT 1 … WHERE filename = $1` | `boolean` |
| `recordApplied(filename, baselined = false)` | `INSERT … (filename, baselined, applied_by)` | `void` |
| `recordReverted(filename)` | `DELETE … WHERE filename = $1` | `void` |
| `getQualifiedName()`, `getTableName()`, `getSchemaName()` | none | `string` |

### Find and name files: `MigrationLoader`

`runner.getLoader()` returns the runner's loader; `new MigrationLoader(directory)` builds one. It reads the file system only.

```ts
import { MigrationLoader } from 'linkgress-orm';

const loader = new MigrationLoader('./migrations');
console.log(await loader.getMigrationFiles()); // sorted names of the *.ts files
console.log(loader.generateFilename());        // '20261004-153419.ts' (local time)
```

For a directory holding `9_seed.ts`, `10_add_index.ts`, `20261003-090000.ts`, `Zeta.ts`, `alpha.ts`, `compiled.js` and `types.d.ts`, `getMigrationFiles()` returned `['10_add_index.ts', '20261003-090000.ts', '9_seed.ts', 'alpha.ts', 'Zeta.ts']`: names compare as text (`localeCompare`), `.js` and `.d.ts` files are ignored, and a directory that does not exist returns `[]` without an error.

| Method | Does |
|---|---|
| `getMigrationFiles()` | the sorted `*.ts` names (not `*.d.ts`) |
| `loadMigration(filename)` / `loadAllMigrations()` | `require()` the file(s), instantiate a default-exported class, check `up` and `down`; `LoadedMigration` (`filename`, `timestamp` = the name's sort key, `migration`, `filePath`) |
| `generateFilename()` | `YYYYMMDD-HHMMSS.ts` from the local clock |
| `getAbsoluteDirectory()`, `ensureDirectory()` | the resolved directory; create it |

<a id="migrationscaffold"></a>

## Draft a migration file from the model diff: `MigrationScaffold`

`scaffold(contextImportPath?)` runs `analyze()` and writes a file with an `up()` that applies the plan and a best-effort `down()`. Treat the output as a draft: read and fix it before committing.

```ts
import { MigrationScaffold } from 'linkgress-orm';

const scaffold = new MigrationScaffold(db, { migrationsDirectory: './migrations' });
try {
  const file = await scaffold.scaffold('../src/database'); // the import path written into the file
  console.log(file.path, file.operations);                 // …/migrations/20261004-153205.ts 7
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('No schema differences detected')) throw error;
}
```

For the change of the [migrate() section](#apply-model-changes-to-an-existing-database-migrate) it wrote:

```ts
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  async up(db: AppDatabase): Promise<void> {
    // Execute each statement separately for compatibility with all database clients
    await db.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "age" integer`);
    await db.query(`ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar`);
    await db.query(`ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "subtitle" varchar(200)`);
    await db.query(`ALTER TABLE "posts" ALTER COLUMN "views" SET NOT NULL`);
    await db.query(`DROP INDEX IF EXISTS "ix_posts_title"`);
    await db.query(`CREATE INDEX "ix_posts_title" ON "posts" ("title")`);
    await db.query(`DROP INDEX IF EXISTS "ix_posts_query"`);
    await db.query(`CREATE INDEX "ix_posts_query" ON "posts" ("user_id", "published_at") INCLUDE ("views")`);
    await db.query(`ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "chk_posts_views"`);
    await db.query(`ALTER TABLE "posts" ADD CONSTRAINT "chk_posts_views" CHECK ("views" >= 0)`);
  }

  async down(db: AppDatabase): Promise<void> {
    // Execute each statement separately for compatibility with all database clients
    await db.query(`ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "chk_posts_views"`);
    await db.query(`DROP INDEX IF EXISTS "ix_posts_query"`);
    await db.query(`CREATE INDEX ix_posts_query ON posts USING btree (user_id, published_at)`);
    await db.query(`DROP INDEX IF EXISTS "ix_posts_title"`);
    await db.query(`-- Cannot auto-generate: revert column "views" changes on table "posts"`);
    await db.query(`ALTER TABLE "posts" DROP COLUMN IF EXISTS "subtitle"`);
    await db.query(`-- Cannot auto-generate: revert column "email" changes on table "users"`);
    await db.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "age"`);
  }
}
```

Compared with what `migrate()` sends for the same plan, check these by hand:

| Plan operation | The scaffolded file | Fix |
|---|---|---|
| `alter_column` with a type change | `TYPE varchar`: the length (`320`) and the `USING` clause are lost | write `TYPE varchar(320) USING "email"::varchar(320)` |
| `alter_column` of a column whose `information_schema` type name differs from the model's spelling: `varchar`, `timestamp` (both captured), also `decimal`, `timestamptz`, `time`, `char` | a spurious `TYPE <type>` with no length or precision, so a `varchar(n)` or `decimal(p, s)` column loses it; with a nullability change it shares one `db.query()` with `SET NOT NULL` / `DROP NOT NULL`, which `PGliteClient` refuses | delete the `TYPE` statement |
| `alter_column` that changes only a default or a collation | `-- No changes for column "c"` (a comment, no SQL) | add `ALTER COLUMN … SET DEFAULT …` / `TYPE … COLLATE …` |
| `create_table` | `CREATE TABLE IF NOT EXISTS` with the key columns + one `ADD COLUMN IF NOT EXISTS` per other column; the table's foreign keys, indexes and CHECK constraints are missing | add them (`migrate()` adds them from the model) |
| `add_enum_value` | `-- Unknown operation: add_enum_value` (a comment, no SQL) | `ALTER TYPE "<enum>" ADD VALUE IF NOT EXISTS '<label>'` |
| `create_foreign_key` | `REFERENCES "<table>"` without its schema | qualify a table outside `public` |
| `create_index` / `recreate_index` of a `.concurrent()` index | `DROP INDEX CONCURRENTLY IF EXISTS` + `CREATE INDEX CONCURRENTLY` in a file without `transaction = false`: `up()` fails with `DROP INDEX CONCURRENTLY cannot run inside a transaction block` | add `transaction = false`, or move those statements to a file of their own |
| `recreate_index` of a unique index a foreign key rests on | plain `DROP INDEX`, which fails with `2BP01` | drop and re-add the foreign key around it |
| `repair_index` | a `DO` block that drops the index only where the schema manager would repair it, then `CREATE INDEX IF NOT EXISTS`, never `CONCURRENTLY`: the table stays locked (ACCESS EXCLUSIVE) through the build, until the file commits | repair with `migrate()` and `concurrentIndexes: true` instead |

- A statement it cannot write becomes a comment-only `db.query()` (`-- Cannot auto-generate: revert column "email" changes …`, `-- Unknown operation: …`), which runs as a no-op (one round trip each): the file applies or reverts without it.
- `contextImportPath` is written into `import type { AppDatabase } from '<path>'` (relative to the migrations directory) whatever your class is named; without it the file types `db` as `DbContext`.
- `scaffold()` throws `No schema differences detected. Database is in sync with model.` when the plan is empty. `scaffoldEmpty(contextImportPath?)` writes a template whose `up()` / `down()` hold a placeholder `db.query()`.
- File names have one-second resolution: a second file generated in the same second overwrites the first (`writeFileSync`).

<a id="ensuredeleted"></a>

## Drop every model object in a throwaway database: `ensureDeleted()`

`ensureDeleted()` drops what the model declares, each statement on its own: views (in reverse declaration order), tables, sequences, every enum registered in the process, then every schema a table names with `toSchema()`. Use it only on a database a test or a developer owns.

For the slice plus a `post_category` enum column (`pgEnum()` + `enumColumn()`), an `invoice_no` model sequence and a `user_post_counts` view (`model.view()`):

```ts
await db.getSchemaManager().ensureDeleted();
```

```sql
DROP VIEW IF EXISTS "user_post_counts" CASCADE

DROP TABLE IF EXISTS "users" CASCADE

DROP TABLE IF EXISTS "posts" CASCADE

DROP SEQUENCE IF EXISTS "invoice_no" CASCADE

DROP TYPE IF EXISTS "post_category" CASCADE
```

5 statements = 5 round trips, no hooks, no log lines (without `logQueries`). It leaves collations, database settings and the migration journal in place. Tables are dropped in model order with `CASCADE`, not in foreign-key order.

> **Pitfall:** `DROP SCHEMA … CASCADE` removes every object in the schema, including objects the model does not know; externally managed tables are dropped; `DROP TYPE … CASCADE` of every registered enum also drops other tables' columns of that type. An entity that names `toSchema('public')` explicitly makes it send `DROP SCHEMA IF EXISTS "public" CASCADE` (captured): leave `toSchema()` out for `public` tables. Never call it on a shared or production database.

## Run schema tasks from scripts and CI

One script covers every task; the migration files and the script run under ts-node, tsx or Bun.

```ts
// scripts/db.ts — one entry point for every schema task: `ts-node scripts/db.ts <command>`
import { IndexRepairError, MigrationRunner, MigrationScaffold, PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function main(command: string | undefined, arg: string | undefined): Promise<void> {
  const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));
  const config = {
    migrationsDirectory: './migrations',
    appliedBy: process.env.RELEASE_TAG, // e.g. the image tag; stored in __migrations.applied_by
    verbose: true,
  };

  try {
    switch (command) {
      case 'create': // empty database, development and tests
        await db.getSchemaManager().ensureCreated();
        break;

      case 'sync': // apply additive model changes directly (development)
        await db.getSchemaManager().migrate();
        break;

      case 'plan': { // print what `sync` would do; exit 1 when the database differs from the model
        const plan = await db.getSchemaManager().analyze();
        console.log(plan.map(op => op.type));
        if (plan.length > 0) process.exitCode = 1;
        break;
      }

      case 'up': { // production: run pending migration files
        const result = await new MigrationRunner(db, config).up();
        if (result.failed) throw result.failed.error; // up() resolves even when a file fails
        console.log(`applied ${result.applied.length}, baselined ${result.baselined?.length ?? 0}`);
        break;
      }

      case 'down': {
        const result = await new MigrationRunner(db, config).down(Number(arg ?? 1));
        if (result.failed) throw result.failed.error;
        console.log(`reverted ${result.applied.join(', ') || 'nothing'}`);
        break;
      }

      case 'status':
        console.table(await new MigrationRunner(db, config).status());
        break;

      case 'scaffold': { // draft a file from the model diff; review it before committing
        const file = await new MigrationScaffold(db, config).scaffold('../src/database');
        console.log(`wrote ${file.path} (${file.operations} operations)`);
        break;
      }

      case 'drop': // throwaway databases only
        if (process.env.NODE_ENV === 'production') throw new Error('refusing to drop a production schema');
        await db.getSchemaManager().ensureDeleted();
        break;

      default:
        throw new Error(`unknown command "${command}": create | sync | plan | up | down [n] | status | scaffold | drop`);
    }
  } catch (error) {
    if (error instanceof IndexRepairError) {
      // migrate() finished every other operation; only these index rebuilds failed
      for (const failure of error.failures) console.error(failure.indexName, failure.code, failure.reason);
    }
    throw error;
  } finally {
    await db.dispose();
  }
}

main(process.argv[2], process.argv[3]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

```json
{
  "scripts": {
    "db:create": "ts-node scripts/db.ts create",
    "db:sync": "ts-node scripts/db.ts sync",
    "db:plan": "ts-node scripts/db.ts plan",
    "db:up": "ts-node scripts/db.ts up",
    "db:down": "ts-node scripts/db.ts down",
    "db:status": "ts-node scripts/db.ts status",
    "db:scaffold": "ts-node scripts/db.ts scaffold",
    "db:drop": "ts-node scripts/db.ts drop"
  }
}
```

A CI job that checks a branch against the released schema: build the database with the main branch, run the branch's pending files, then fail when the branch's model still differs (`db:plan` exits 1):

```yaml
# .github/workflows/schema.yml
name: Schema
on: [pull_request]
jobs:
  migrations:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci && npm run db:up      # the released schema
      - uses: actions/checkout@v4         # this branch
      - run: npm ci && npm run db:up      # its pending files
      - run: npm run db:plan              # exit 1: a model change no file makes
```

For tests, build a database once with `ensureCreated()` and drop it with `ensureDeleted()` only when the test owns it; with the in-memory database, build and seed once and start every test from a [snapshot](./in-memory-database.md#start-every-test-from-a-seeded-state-snapshot-restoreinmemorydatabase-fork).

## Add enum labels: `migrate()`, not `EnumMigrator`

`migrate()` creates missing enum types and appends each new label of a `pgEnum()` after the existing ones (`ALTER TYPE … ADD VALUE IF NOT EXISTS '<label>'`); labels removed from the model stay. To place a new label at a position, or to retire one, write a migration file (`ALTER TYPE "<enum>" ADD VALUE '<label>' BEFORE '<label>'`; removing a label means re-creating the type).

Do not call `new EnumMigrator(client, { logQueries?, logger? }).migrateEnums()`. It syncs every `pgEnum()` registered in the process: it creates missing types, adds a missing label after the label declared before it (`ALTER TYPE … ADD VALUE '…' AFTER '…'`), and removes labels the model no longer lists with `ALTER TYPE … DROP VALUE`, a statement PostgreSQL does not implement (PostgreSQL 18: `dropping an enum value is not implemented`).

## Migration operations reference

`analyze()` returns `MigrationOperation[]`; `migrate()` and `MigrationScaffold` consume it. `drop_table`, `drop_column`, `drop_index` and `drop_foreign_key` exist in the type but are never produced. A `switch` over `MigrationOperation['type']` with a `never` check must handle `repair_index` (added in 1.0.11).

| `type` | Fields beyond `type` | Produced when |
|---|---|---|
| `create_schema` | `schemaName` | a model schema is missing |
| `create_collation` | `collation` | a registered collation is missing |
| `create_enum` | `enumName`, `values` | a registered enum type is missing |
| `add_enum_value` | `enumName`, `values` (the missing labels) | an enum type lacks model labels |
| `create_sequence` | `config` | a model sequence is missing |
| `create_table` | `tableName`, `schema` (the `TableSchema`) | a model table is missing |
| `add_column` | `tableName`, `schema?`, `columnName`, `config` | a model column is missing |
| `alter_column` | `tableName`, `schema?`, `columnName`, `from` (catalog row), `to` (model config) | base type, nullability, default or declared collation differ |
| `create_index` | `tableName`, `schema?`, `indexName`, `columns`, `isUnique?`, `using?`, `operatorClass?`, `concurrent?`, `expressions?`, `where?`, `nullsNotDistinct?`, `include?` | a model index is missing |
| `recreate_index` | the index fields + `reason?`, `previousDef?` | a same-named index differs (confirmed on a temp copy); not with `recreateChangedIndexes: false` |
| `repair_index` | the index fields + `previousDef?` | a model index exists only INVALID |
| `create_statistics` | `tableName`, `schema?`, `statisticsName`, `expressions`, `kinds?` | a statistics name is missing |
| `create_check_constraint` | `tableName`, `schema?`, `constraintName`, `expression` | a CHECK name is missing |
| `set_database_setting` | `name`, `value` | a `hasDbSetting()` value is missing or differs |
| `create_foreign_key` | `tableName`, `schema?`, `constraint` | a foreign-key name is missing on an existing table |
| `drop_view` | `viewName`, `schema?` | a model view must be re-created (listed first) |
| `create_view` | `viewName`, `schema?`, `definition` | a model view is missing or re-created (listed last) |

## Pitfalls

- **Don't** call `db.ensureCreated()` or `db.migrate()` → **Do** `db.getSchemaManager().ensureCreated()` / `.migrate()`. The context has no such methods (`TypeError: db.ensureCreated is not a function`; TS2339).
- **Don't** use `ensureCreated()` to evolve an existing database → **Do** `migrate()` or migration files. It sends `CREATE TABLE IF NOT EXISTS`, which never adds a column, and keeps a changed same-named index as it is.
- **Don't** run `migrate()` on a model with `serial()` / `bigserial()` columns → **Do** declare keys with `integer('id').primaryKey().generatedAlwaysAsIdentity()`. The first `migrate()` after such a table was created plans `alter_column` for the serial column and sends `ALTER COLUMN … DROP DEFAULT`; inserts without the key then fail with 23502 (verified on PostgreSQL 18.3 and the in-memory database).
- **Don't** let the model own a foreign key between tables of different schemas when you run `migrate()` → **Do** `.isInverseNavigation()` on that `hasOne` and create the constraint in a migration file (`runOnBaseline = true`). The existing constraint is not found, so every run plans it again and fails with `constraint "…" already exists`.
- **Don't** remove a NOT NULL column or rename a column only in the model → **Do** the matching `DROP COLUMN` / `RENAME COLUMN` in a migration file of the same release. `migrate()` keeps the old column; inserts through the new model fail with 23502 when it was NOT NULL.
- **Don't** treat a resolved `up()` / `down()` as success → **Do** `if (result.failed) throw result.failed.error`. A failing file is reported in the result; only errors outside the files reject.
- **Don't** call `up()` for the first time on a database that has tables but no journal → **Do** `runner.getJournal().ensureTable()` first, and `recordApplied(filename, true)` for the files the database already reflects. Without a journal, `up()` runs `migrate()` and records every file without `runOnBaseline` as baselined without running it.
- **Don't** ship compiled `.js` migrations or a `migrationsDirectory` that does not resolve from `process.cwd()` → **Do** ship the `.ts` files and run the runner under Bun, ts-node or tsx. The loader reads only `*.ts`, and a missing directory reads as empty: on a database with a journal `up()` then reports nothing and runs no file; on one without, it still runs `migrate()` and creates the journal, with no file recorded.
- **Don't** name files `9_seed.ts`, `10_add.ts` or mix letter case → **Do** `YYYYMMDD-HHMMSS.ts`. Names sort as text (`10_add.ts` before `9_seed.ts`), the journal is read in SQL `ORDER BY filename` order for `down()`, and generated names use the local clock.
- **Don't** rename a migration file that ran → **Do** leave applied files as they are. The journal is keyed by file name: the renamed file is pending and runs again.
- **Don't** run `up()` (or `migrate()`) from several processes at once → **Do** run schema changes in one deploy step or job. Nothing takes a lock, and a file's journal row is written after its transaction commits.
- **Don't** subclass your context to add hooks → **Do** override `onMigrationStart` / `onMigrationComplete` in the class that declares the table getters. The subclass throws a `TypeError` at construction when an inherited getter has its table's name (`get users()` for table `users`).
- **Don't** put backfills or seed rows in `onMigrationComplete` → **Do** use a migration file (`runOnBaseline = true` when fresh databases need the rows). The hook runs after every `ensureCreated()` and every `migrate()` that changed something, and never on `MigrationRunner`'s existing-database path.
- **Don't** construct several contexts with different models in one process and expect separate schemas → **Do** one model per process for schema work. Entity configuration is process-wide: a context built after another one includes its tables, so its `ensureCreated()` created and its `ensureDeleted()` dropped the other context's table too.
- **Don't** send several statements in one `client.query()` / `db.query()` in hooks and files → **Do** one statement per call. `PGliteClient` refuses several (`cannot insert multiple commands into a prepared statement`).
- **Don't** commit a scaffolded file unread → **Do** fix it against [the defect table](#draft-a-migration-file-from-the-model-diff-migrationscaffold). A new table comes without its foreign keys, indexes and CHECKs; type changes lose their length; enum labels are not added.
- **Don't** test `migrate()` idempotence on the in-memory database with a string default on a `varchar(n)` column → **Do** confirm on PostgreSQL or PGlite. The in-memory engine prints the default as `'n/a'::character varying(20)`, so every `migrate()` sends `SET DEFAULT` again and fires `onMigrationComplete`; PostgreSQL prints `'n/a'::character varying` and converges ([In-memory database](./in-memory-database.md#found-while-writing-these-docs)).
- **Don't** use `EnumMigrator` → **Do** `migrate()` for new labels, a migration file for positions and removals. Its label removal sends `ALTER TYPE … DROP VALUE`, which PostgreSQL does not implement.
- **Don't** write `toSchema('public')` on an entity → **Do** leave `toSchema()` out for tables in `public`. With it, `ensureCreated()` sends `CREATE SCHEMA IF NOT EXISTS "public"` and `ensureDeleted()` sends `DROP SCHEMA IF EXISTS "public" CASCADE`, which drops everything in `public`.

## See also

- [Schema configuration](./schema-configuration.md): declaring the tables, columns, keys, indexes, CHECKs, views, enums and sequences this page creates and migrates.
- [Configuration](./configuration.md#route-log-lines-logger-and-logsection): `QueryOptions.logger`, `logQueries` and log sections, which the schema manager writes through.
- [In-memory database](./in-memory-database.md): a PostgreSQL-compatible database for tests; build once, snapshot, restore per test.
- [Database clients](../database-clients.md): `PgClient`, `PostgresClient`, `BunClient`, `PGliteClient`, transactions and `dispose()`.
- [Getting started](../getting-started.md): from install to the first query, including the first `ensureCreated()`.
