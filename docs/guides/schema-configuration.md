# Schema Configuration

> **For agents:** How do I declare tables, columns, keys, relations, indexes, constraints, enums, custom types, sequences and views so that linkgress creates them correctly, types every query, and backs each query with the index it needs?
> **Use this page when:** writing or changing a `DbEntity` class, a `DbContext` subclass or its `setupModel()`; choosing a column type, key, relation, index, enum, custom mapper, sequence or view. **Look elsewhere when:** creating or evolving a database from the model (`ensureCreated()`, `migrate()`, migration files) → [Migrations and Schema Management](./migrations.md); reading rows → [Querying](./querying.md); writing rows → [Inserts, Updates, Upserts and Deletes](./insert-update-guide.md)
> **Key APIs:** `DbEntity` · `DbColumn<T>` · `DbContext` · `setupModel()` · `model.entity()` · `property().hasType()` · `hasOne()` · `hasMany()` · `hasIndex()` · `hasStatistics()` · `hasCheckConstraint()` · `hasPartitioning()` · `pgEnum()` · `pgCollation()` · `createCustomType()` · `sequence()` · `runtimeSequence()` · `model.view()` · `isExternallyManaged()` · `model.hasDbSetting()`

The SQL under each example is what `db.getSchemaManager().ensureCreated()` (or the query shown) sent, captured
statement by statement on the in-memory PostgreSQL-compatible database. One statement is one round trip.

## Contents

- [Choose a schema feature](#choose-a-schema-feature)
- [Rules every model follows](#rules-every-model-follows)
- [Define a model: entity classes, a context and `setupModel()`](#define-a-model-entity-classes-a-context-and-setupmodel)
- [Declare an entity class: `DbEntity` and `DbColumn<T>`](#declare-an-entity-class-dbentity-and-dbcolumnt)
- [Declare the context: `DbContext`, table getters and `setupModel()`](#declare-the-context-dbcontext-table-getters-and-setupmodel)
- [Map properties to columns: `property().hasType()`](#map-properties-to-columns-propertyhastype)
- [Pick a column type](#pick-a-column-type)
- [Generate primary keys: identity columns](#generate-primary-keys-identity-columns)
- [Set column defaults: `hasDefaultValue()`](#set-column-defaults-hasdefaultvalue)
- [Link tables: `hasOne()` and `hasMany()`](#link-tables-hasone-and-hasmany)
- [Index what your queries filter, join and sort on: `hasIndex()`](#index-what-your-queries-filter-join-and-sort-on-hasindex)
- [Improve row estimates: `hasStatistics()`](#improve-row-estimates-hasstatistics)
- [Enforce row rules: `hasCheckConstraint()`](#enforce-row-rules-hascheckconstraint)
- [Partition a large table: `hasPartitioning()`](#partition-a-large-table-haspartitioning)
- [Store a fixed set of labels: `pgEnum()` and `enumColumn()`](#store-a-fixed-set-of-labels-pgenum-and-enumcolumn)
- [Compare text case- and accent-insensitively: `pgCollation()`](#compare-text-case--and-accent-insensitively-pgcollation)
- [Convert column values: `createCustomType()` and `hasCustomMapper()`](#convert-column-values-createcustomtype-and-hascustommapper)
- [Number documents: model sequences and `runtimeSequence()`](#number-documents-model-sequences-and-runtimesequence)
- [Expose a read-only view: `model.view()`](#expose-a-read-only-view-modelview)
- [Map a table another system owns: `isExternallyManaged()`](#map-a-table-another-system-owns-isexternallymanaged)
- [Persist a database setting: `model.hasDbSetting()`](#persist-a-database-setting-modelhasdbsetting)
- [Inspect the model at run time: `getColumns()`, `getColumnKeys()`, `props()`](#inspect-the-model-at-run-time-getcolumns-getcolumnkeys-props)
- [Complete example: the core of the docs' model](#complete-example-the-core-of-the-docs-model)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose a schema feature

| Need | Use | DDL it produces | Avoid |
|---|---|---|---|
| A table for a class | `model.entity(User, e => { e.toTable('users'); … })` | `CREATE TABLE IF NOT EXISTS "users" (…)` | omitting `toTable()`: the name is the class name lower-cased (`ProductTag` → `"producttag"`) |
| A NOT NULL column | `.isRequired()` | `"email" text NOT NULL` | `!` on the property alone: TypeScript only, the column stays nullable |
| A server-generated key | `integer('id').primaryKey().generatedAlwaysAsIdentity()` | `"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL` | `.autoIncrement()`: no DDL, and `insert()` drops the column's values |
| A composite key | `.isPrimaryKey()` on each key property | `PRIMARY KEY ("order_id", "task_id")` | — |
| A navigation (many-to-one) with a constraint | `hasOne(…).withForeignKey(…).withPrincipalKey(…)` on the table that holds the key | `CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY …` | `hasMany()` alone: it creates no constraint |
| A collection (one-to-many) | `hasMany(…)` on the parent, plus an index that starts with the foreign-key column | none; the collection's subquery filters `"user_id" = "users"."id"` | no index on the key column: PostgreSQL and linkgress create none |
| An index for a filter, join or sort | `hasIndex(name, e => [e.a, e.b])` | `CREATE INDEX IF NOT EXISTS …` | declaring it before the properties it names |
| Case- and accent-insensitive search | `hasIndex(name, e => [ixNormalized(e.email)])` + `normalizedEq()` | `(public.search_normalize("email") text_pattern_ops)` | `ixUnaccent()`: PostgreSQL refuses `unaccent()` in an index |
| A rule across columns | `hasCheckConstraint(name, sql)` | `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` | `hasDefaultValue()`: it sets a default and checks nothing |
| Better row estimates for correlated columns | `hasStatistics(name, e => [e.a, e.b])` | `CREATE STATISTICS …` + `ANALYZE` | `ensureCreated()` at every startup on large tables: it re-runs `ANALYZE` |
| A fixed set of labels | `pgEnum()` + `enumColumn()` | `CREATE TYPE "order_status" AS ENUM (…)` | label sets that shrink or get renamed |
| An application value type | `createCustomType()` + `hasCustomMapper()` | the mapper's `dataType()` | `customType()`: the expression builder, not a column mapper |
| Business numbers, a counter shared by tables | a model `sequence()` getter; `runtimeSequence()` for names known at run time | `CREATE SEQUENCE "order_number_seq" START WITH 1000 INCREMENT BY 1` | the identity `name` option: it is ignored |
| A reusable read model | `model.view()` + `this.view()` | `CREATE VIEW …` + `COMMENT ON VIEW …` | grants on the view itself: every `ensureCreated()` re-creates it |
| A table another system owns | `isExternallyManaged()` | none once the table exists | `ensureDeleted()` on that context |

## Rules every model follows

1. Expose every table through a getter that calls `this.table(Entity)`. A class field does not work on the context
   `db.transaction()` hands you.
2. Build one context per client at process start and reuse it. Construction sends no SQL, but entity metadata is
   process-wide: a schema manager creates the tables of every entity any context configured, and `hasStatistics()` /
   `hasCheckConstraint()` register again on every construction.
3. A column is NOT NULL only through `isRequired()`, `isPrimaryKey()` or the builder's `primaryKey()` / `notNull()`.
   `!` and `?` on the property change TypeScript only.
4. Name the database column in the builder (`varchar('display_name', 50)`). Do not use `hasColumnName()`.
5. Configure the properties before the indexes, `include()` lists, statistics and partition keys that name them
   (relations may come in any order: their keys are resolved after `setupModel()` returns).
6. Declare `hasOne()` where the foreign key lives (it creates the constraint) and `hasMany()` on the parent (it creates
   the collection). Index the foreign-key columns your collections and joins filter on.
7. Call `isRequired()` on a navigation only when its foreign key is NOT NULL: it makes every join through it an INNER
   JOIN.
8. Treat `bigint`, `bigserial`, `decimal` and `numeric` values as strings, or attach a mapper.
9. Write defaults as SQL text: `hasDefaultValue("'pending'")` for a string literal.
10. Derive every context class from `DbContext` directly; a subclass of a context whose getters are named like its
    tables throws at construction.

## Define a model: entity classes, a context and `setupModel()`

An entity class lists the columns of a table as `DbColumn<T>` properties and its relations as plain properties.
`setupModel()` maps each class to its table, and one getter per table exposes it on the context. Constructing the
context builds the model and sends no SQL.

```ts
import {
  DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, PgClient,
  integer, varchar, text, boolean, timestamp, jsonb,
} from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;      // `?`: nullable (no isRequired() below); a NULL reads back as null
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;
  metadata?: DbColumn<any>;

  posts?: Post[];              // collection: User hasMany Post
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  content?: DbColumn<string>;
  userId!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  views!: DbColumn<number>;

  user?: User;                 // navigation: Post hasOne User
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
      entity.property(e => e.age).hasType(integer('age'));
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
      entity.property(e => e.metadata).hasType(jsonb('metadata'));

      entity.hasMany(e => e.posts, () => Post)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);
    });

    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.content).hasType(text('content'));
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.publishedAt).hasType(timestamp('published_at')).hasDefaultValue('NOW()');
      entity.property(e => e.views).hasType(integer('views')).hasDefaultValue(0);

      entity.hasOne(e => e.user, () => User)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id)
        .onDelete('cascade')
        .isRequired();

      entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
    });
  }
}

// once per process: one client, one context
export const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));
await db.getSchemaManager().ensureCreated(); // tests and development; production: see the migrations guide
```

`ensureCreated()` sent 3 statements: one per table, one per index. The foreign key comes from the `hasOne()`:

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL UNIQUE,
  "email" text NOT NULL,
  "age" integer,
  "is_active" boolean DEFAULT TRUE,
  "created_at" timestamp DEFAULT NOW(),
  "metadata" jsonb,
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "content" text,
  "user_id" integer NOT NULL,
  "published_at" timestamp DEFAULT NOW(),
  "views" integer DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
)

CREATE INDEX IF NOT EXISTS "ix_posts_query" ON "posts" ("user_id", "published_at")
```

A row reads as its unwrapped columns (`DbColumn<number>` → `number`). The navigation and the collection become a join
and a correlated subquery:

```ts
// fragment: continues the example above; eq comes from 'linkgress-orm'
const alice = await db.users.where(u => eq(u.username, 'alice')).first();
// → { id: 1, username: 'alice', email: 'alice@example.com', age: 31, isActive: true, createdAt: Date, metadata: null }

const postCounts = await db.users.select(u => ({ name: u.username, postCount: u.posts!.count() })).toList();
// → [{ name: 'alice', postCount: 1 }]

const authors = await db.posts.select(p => ({ title: p.title, author: p.user!.username })).toList();
// → [{ title: 'Hello', author: 'alice' }]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age", "users"."is_active" as "isActive", "users"."created_at" as "createdAt", "users"."metadata" as "metadata"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: [ "alice" ]

SELECT "users"."username" as "name", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount"
FROM "users"

SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
```

> **Efficiency:** the collection subquery filters `posts.user_id`. `ix_posts_query ("user_id", "published_at")` serves
> it because `user_id` is its first column; without an index that starts with `user_id`, PostgreSQL scans `posts` for
> every user row. `isRequired()` on `Post.user` made the third query an INNER JOIN.

## Declare an entity class: `DbEntity` and `DbColumn<T>`

| Property | Declares | Example |
|---|---|---|
| `name!: DbColumn<T>` | a column typed `T` in rows | `username!: DbColumn<string>` |
| `name?: DbColumn<T>` | a column typed `T \| undefined` in rows; a NULL reads back as `null` (test with `== null`) | `age?: DbColumn<number>` |
| `name?: Entity` | a navigation (one row), configured with `hasOne()` | `user?: User` |
| `name?: Entity[]` | a collection (many rows), configured with `hasMany()` | `posts?: Post[]` |

- `!` and `?` change TypeScript only. A column is NOT NULL only when `setupModel()` says so (below, `sortOrder!` stays
  nullable).
- A NULL column reads back as `null`, in entity rows (`first()`, `toList()`) and in `select()` projections alike,
  although `?` types it `T | undefined`. Only a navigation column whose LEFT JOIN found no row reads as `undefined`.
- `T` is the type queries and inserts use. `hasType()` does not compare it with the builder's type: declare the type
  the driver returns (a string for `bigint` and `decimal` columns, see [Pick a column type](#pick-a-column-type)) or
  attach a mapper.
- Never wrap a navigation in `DbColumn`.
- Navigations are optional properties. Under `strict`, dereference them with `!` inside selectors: `u.posts!.count()`,
  `p.user!.username`. `u.posts.count()` does not compile (TS18048).

```ts
// fragment: an entity of the docs' model (debug/model/order.ts)
export class Order extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  status!: DbColumn<'pending' | 'processing' | 'completed' | 'cancelled' | 'refunded'>;
  totalAmount!: DbColumn<number>;   // decimal(10, 2): the driver returns a string ("99.50") unless mapped
  createdAt!: DbColumn<Date>;
  items?: DbColumn<any>;

  user?: User;                      // navigation
  orderTasks?: OrderTask[];         // collection
}
```

A `!` property without `isRequired()` is a nullable column, and a class without `toTable()` maps to its lower-cased
name:

```ts
// fragment
class ProductTag extends DbEntity {
  productId!: DbColumn<number>;
  tagId!: DbColumn<number>;
  sortOrder!: DbColumn<number>;      // `!` but no isRequired(): the column is nullable
}

// no toTable(): the table is named after the class, lower-cased
model.entity(ProductTag, entity => {
  entity.property(e => e.productId).hasType(integer('product_id')).isPrimaryKey();
  entity.property(e => e.tagId).hasType(integer('tag_id')).isPrimaryKey();
  entity.property(e => e.sortOrder).hasType(integer('sort_order'));
});

await db.productTags.insert({ productId: 1, tagId: 1, sortOrder: null as any }); // accepted
```

```sql
CREATE TABLE IF NOT EXISTS "producttag" (
  "product_id" integer NOT NULL,
  "tag_id" integer NOT NULL,
  "sort_order" integer,
  PRIMARY KEY ("product_id", "tag_id")
)

INSERT INTO "producttag" ("product_id", "tag_id", "sort_order") VALUES ($1, $2, $3)
-- params: [ 1, 1, null ]
```

Type helpers for code that handles rows of an entity:

| Type | What it is | Use it for |
|---|---|---|
| `UnwrapDbColumns<User>` | the row: each `DbColumn<T>` unwrapped to `T`; `age?` stays optional | typing rows you pass around |
| `InsertData<User>` | every column optional | insert payloads; a missing NOT NULL column fails in PostgreSQL (23502), not in the compiler |
| `UpdateData<User>` / `UpsertData<User>` | every column optional, a value or an `sql` fragment | update and upsert payloads |
| `ExtractDbColumns<User>` | the column properties only, unwrapped | |
| `ExtractDbColumnKeys<User>` | `'id' \| 'username' \| …`, no navigations | dynamic column lists |
| `ColumnRow<User>` | a row of column references (`DbColumn<T>` per column, no navigations) | the argument of index expression builders and upsert / bulk-update callbacks |

```ts
// fragment: compile-time facts
const insert: InsertData<User> = { email: 'x@example.com' };     // compiles; the INSERT fails: username is NOT NULL
type UserRow = UnwrapDbColumns<User>;                              // UserRow['age']: number | undefined
const picked: Pick<UserRow, 'id' | 'username'> = { id: 1, username: 'alice' };
// const full: UserRow = { … };  TS2741: an object literal lacks the DbEntity brand; Pick the columns instead
```

## Declare the context: `DbContext`, table getters and `setupModel()`

`DbContext` is abstract: subclass it and construct the subclass with `(client, queryOptions?)`.

| Member | Purpose |
|---|---|
| `new AppDatabase(client, queryOptions?)` | builds the model; sends no SQL |
| `protected override setupModel(model: DbModelConfig)` | declares entities, views and model settings; runs inside the constructor with a stand-in `this` |
| `get users(): DbEntityTable<User> { return this.table(User); }` | a table accessor; works on `db` and on the context `db.transaction()` hands you |
| `get userOrderTotals(): DbViewTable<UserOrderTotal> { return this.view(UserOrderTotal); }` | a read-only [view](#expose-a-read-only-view-modelview) accessor |
| `get orderNumberSeq(): DbSequence { return this.sequence(…); }` + `protected override setupSequences()` | a [model sequence](#number-documents-model-sequences-and-runtimesequence) |
| `protected override async onMigrationStart(client)` / `onMigrationComplete(client)` | raw SQL before / after schema work (extensions, partitions, grants) → [Migrations and Schema Management](./migrations.md) |
| `db.getSchemaManager(options?)` | `ensureCreated()`, `migrate()`, `analyze()`, `ensureDeleted()`; options `concurrentIndexes`, `recreateChangedIndexes` |
| `db.query(sql)` · `db.transaction(fn)` · `db.dispose()` | raw SQL, transactions, closing the client |

A table accessor must be a getter. The transaction's context is built from the getters:

```ts
// fragment
class AppDatabase extends DbContext {
  get posts(): DbEntityTable<Post> { return this.table(Post); }   // a getter: works everywhere
  postsField: DbEntityTable<Post> = this.table(Post);             // a class field: do not
  // …
}

await db.transaction(async tx => {
  tx.posts.isInTransaction();   // true (isInTransaction() since 1.0.30)
  tx.postsField;                // undefined
});
```

`setupModel()` runs with a stand-in `this`: instance fields and getters are not available there, so use only the
`model` argument and module-level values.

```ts
// fragment
class AppDatabase extends DbContext {
  readonly tablePrefix = 'shop_';
  protected override setupModel(model: DbModelConfig): void {
    (this as any).tablePrefix;      // undefined
  }
}
```

Entity metadata lives in a process-wide store keyed by entity class. Every schema manager therefore sees every entity
any context of the process configured:

```ts
// fragment: two contexts in one process
class AppDatabase extends DbContext {          // declares "users"
  get users(): DbEntityTable<User> { return this.table(User); }
  protected override setupModel(model: DbModelConfig): void { /* model.entity(User, …) */ }
}
class CatalogDatabase extends DbContext {      // declares only "products"
  get products(): DbEntityTable<Product> { return this.table(Product); }
  protected override setupModel(model: DbModelConfig): void { /* model.entity(Product, …) */ }
}

const app = new AppDatabase(client);
const catalog = new CatalogDatabase(client);
await catalog.getSchemaManager().ensureCreated();   // creates "users" too
```

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL,
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "products" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "name" varchar(200) NOT NULL,
  PRIMARY KEY ("id")
)
```

The schema manager writes its progress through `QueryOptions.logger`, and through `console.log` when no logger is set:
`new AppDatabase(client, { logger: (message, section) => … })`. Always written: index, statistics, CHECK, foreign-key
and view steps (`  Creating index "ix_posts_query" on "posts"...`), `analyze()`'s start line, and `migrate()`'s plan
and its other steps. Written only with `logQueries: true`: `CREATE TABLE` steps, and `ensureCreated()`'s schema,
enum, collation and sequence steps. Pass `logger: () => {}` to silence it.

> **Pitfall:** constructing the same context class twice registers its `hasStatistics()` objects twice: the next
> `ensureCreated()` sends each `CREATE STATISTICS` + `ANALYZE` pair twice. Construct contexts once per process.

> **Pitfall:** do not extend your context class (`class ReportingDatabase extends AppDatabase {}`). When an inherited
> getter has the name of a table (`get posts()` over `"posts"`), the subclass's constructor throws a `TypeError`
> (Bun: `Attempted to assign to readonly property.`). Derive every context from `DbContext` directly.

## Map properties to columns: `property().hasType()`

`entity.property(e => e.username)` selects the property; `.hasType(builder)` sets the SQL type and the column name (the
builder's first argument); the methods after it add constraints. Write the selector as `e => e.property`: the property
name is read from the selector's source text (its first `.name`).

| Method | Effect | DDL |
|---|---|---|
| `hasType(varchar('username', 100))` | SQL type and column name | `"username" varchar(100)` |
| `isRequired()` | NOT NULL | `"email" text NOT NULL` |
| `isUnique()` | inline UNIQUE constraint (PostgreSQL names it `users_username_key`); takes no name | `"username" varchar(100) NOT NULL UNIQUE` |
| `isPrimaryKey()` | primary key column; on several properties a composite key | `PRIMARY KEY ("product_id", "tag_id")` |
| `hasDefaultValue(value)` | DEFAULT, see [Set column defaults](#set-column-defaults-hasdefaultvalue) | `"views" integer DEFAULT 0` |
| `hasCollation(def)` | COLLATE, see [collations](#compare-text-case--and-accent-insensitively-pgcollation) | `"name" varchar(100) COLLATE "ci_ai" NOT NULL` |
| `hasCustomMapper(mapper)` | value conversion; the mapper's `dataType()` replaces the type name | `"publish_time" smallint` |
| `generatedAlwaysAsIdentity(options?)` | identity column | `GENERATED ALWAYS AS IDENTITY` |
| `hasColumnName(name)` | renames the column for indexes and foreign keys only; DDL and queries keep the builder's name | avoid |

Entity-level methods: `toTable(name)`, `toSchema(name)`, `isExternallyManaged()`, `hasOne()`, `hasMany()`,
`hasIndex()`, `hasStatistics()`, `hasCheckConstraint()`, `hasPartitioning()`. Model-level methods: `model.entity()`,
`model.view()`, `model.useSearchNormalize()`, `model.hasDbSetting()`.

`toSchema(name)` puts the table in another PostgreSQL schema. The schema manager creates the schema, and every query,
join and foreign key names it:

```ts
// fragment: inside setupModel(model)
model.entity(User, entity => {
  entity.toTable('users');
  entity.toSchema('auth');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
});

model.entity(Post, entity => {
  entity.toTable('posts');
  entity.toSchema('auth');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
  entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
  entity.hasOne(e => e.user, () => User).withForeignKey(p => p.userId).withPrincipalKey(u => u.id).isRequired();
});

await db.posts.select(p => ({ title: p.title, author: p.user!.username })).toList();
```

```sql
CREATE SCHEMA IF NOT EXISTS "auth"

CREATE TABLE IF NOT EXISTS "auth"."users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL,
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "auth"."posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "user_id" integer NOT NULL,
  "title" varchar(200) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id")
)

SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "auth"."posts"
INNER JOIN "auth"."users" AS "user" ON "posts"."user_id" = "user"."id"
```

> **Pitfall:** `ensureDeleted()` runs `DROP SCHEMA … CASCADE` for every schema the model names with `toSchema()`,
> which removes objects in it the model does not know. `toSchema('public')` included: it sent
> `DROP SCHEMA IF EXISTS "public" CASCADE`. Leave `toSchema()` out for tables in `public`.

`hasColumnName()` and an index declared before its properties both fail or degrade silently:

```ts
// fragment
model.entity(Tag, entity => {
  entity.toTable('tags');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  // name is configured AFTER this index: it is left out of the index silently
  entity.hasIndex('ix_tags_id_name', e => [e.id, e.name]);
  entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
  // hasColumnName() renames the column for indexes and FKs only
  entity.property(e => e.slug).hasType(varchar('slug', 100)).hasColumnName('url_slug');
  entity.hasIndex('ix_tags_slug', e => [e.slug]);
});
```

```sql
CREATE TABLE IF NOT EXISTS "tags" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "name" varchar(100) NOT NULL,
  "slug" varchar(100),
  PRIMARY KEY ("id")
)

CREATE INDEX IF NOT EXISTS "ix_tags_id_name" ON "tags" ("id")

CREATE INDEX IF NOT EXISTS "ix_tags_slug" ON "tags" ("url_slug")
-- error: column "url_slug" does not exist
```

An index whose only properties are all configured after it renders `ON "tags" ()` and fails with `syntax error at or
near ")"`.

### Change a property of an existing table

`ensureCreated()` creates what is missing (`CREATE TABLE IF NOT EXISTS`) and, on a table that exists, adds missing
indexes and CHECK constraints by name; it never adds or changes a column of an existing table. `migrate()` applies
some property changes and skips others without an error:

| Model change | `migrate()` sends |
|---|---|
| New property | `ALTER TABLE "products" ADD COLUMN "stock" integer NOT NULL DEFAULT 0` |
| Base type (`integer` → `bigint`) | `ALTER TABLE "products" ALTER COLUMN "views" TYPE bigint USING "views"::bigint` |
| `isRequired()` added / removed | `ALTER TABLE "products" ALTER COLUMN "sku" SET NOT NULL` / `… DROP NOT NULL` |
| Default added or changed / removed | `ALTER TABLE "products" ALTER COLUMN "sku" SET DEFAULT 'n/a'` / `… DROP DEFAULT` |
| Collation | `ALTER TABLE … ALTER COLUMN … TYPE … COLLATE "…"` |
| Length or precision (`varchar(100)` → `varchar(250)`, `decimal(10, 2)` → `decimal(12, 4)`) | nothing |
| Property removed | nothing: the column stays |
| Column renamed (a new name in the builder) | `ADD COLUMN` of the new name; the old column and its data stay |
| `isUnique()` added to an existing column | nothing |
| `onDelete()` / `onUpdate()` changed | nothing: foreign keys are matched by name |

Write a migration file for the "nothing" rows, see [Migrations and Schema Management](./migrations.md).

## Pick a column type

Each factory takes the column name first. The table shows the DDL, the TypeScript type the builder carries, and what
`PgClient` returned for the value (captured):

| Factory | DDL | Builder type | Value read back (`PgClient`) |
|---|---|---|---|
| `integer(name)` | `integer` | `number` | `number` |
| `smallint(name)` | `smallint` | `number` | `number` |
| `serial(name)` | `serial` | `number` | `number` |
| `bigint(name)` | `bigint` | `bigint` | `string`: `"9007199254740993"` |
| `bigserial(name)` | `bigserial` | `bigint` | `string`: `"1"` |
| `decimal(name, precision?, scale?)` | `decimal(10, 2)` | `number` | `string`: `"12.50"` |
| `numeric(name, precision?, scale?)` | `numeric` | `number` | `string`: `"1.25"` |
| `real(name)` | `real` | `number` | `number` |
| `doublePrecision(name)` | `double precision` | `number` | `number` |
| `varchar(name, length?)` | `varchar(100)` | `string` | `string` |
| `char(name, length?)` | `char(3)` | `string` | `string`, blank-padded: `"AB "` |
| `text(name)` | `text` | `string` | `string` |
| `boolean(name)` | `boolean` | `boolean` | `boolean` |
| `timestamp(name)` | `timestamp` | `Date` | `Date` |
| `timestamptz(name)` | `timestamptz` | `Date` | `Date` |
| `date(name)` | `date` | `Date` | `Date` at local midnight |
| `time(name)` | `time` | `string` | `string`: `"10:30:00"` |
| `uuid(name)` | `uuid` | `string` | `string` |
| `json(name)` / `jsonb(name)` | `json` / `jsonb` | `any` | the parsed value; prefer `jsonb` (indexable, PostgreSQL's recommendation) |
| `bytea(name)` | `bytea` | `Buffer` | `Buffer` |
| `enumColumn(name, enumDef)` | the enum type's name | `string` for a `pgEnum()` definition (declare the union on the property) | `string` |
| `<builder>.array()` | `text[]`, `integer[]` | `T[]` | an array |
| `new ColumnBuilder<T>(name, 'inet')` | `inet` (any SQL type you name) | `T` | the driver's value |

> **Pitfall:** `bigint`, `bigserial`, `decimal` and `numeric` columns read as strings on `PgClient`, `PostgresClient`
> and `PGliteClient` (all three captured), in entity rows and in projections alike. An `interval` reads as an object
> on `PgClient` and as text (`"1 day 02:03:04"`) on the other two. Declare such properties `DbColumn<string>`, or map
> them as below.

### Read `bigint` and `numeric` as JS values: a mapper

A column mapper converts both ways: `toDriver` on every bound value, `fromDriver` on every read.

```ts
// fragment
import { bigint, decimal, createCustomType, gt } from 'linkgress-orm';

// int8 text <-> JS bigint (exact)
export const int8AsBigInt = createCustomType<{ data: bigint; driverData: string }>({
  dataType: () => 'bigint',
  toDriver: value => (value == null ? null : value.toString()),
  fromDriver: value => (value == null ? null : BigInt(value)),
});

// numeric text <-> JS number (rounds beyond 15-17 significant digits)
// dataType() is the type NAME only: the builder's (10, 2) is appended to it
export const numericAsNumber = createCustomType<{ data: number; driverData: string }>({
  dataType: () => 'decimal',
  toDriver: value => (value == null ? null : String(value)),
  fromDriver: value => (value == null ? null : Number(value)),
});

model.entity(ProductPrice, entity => {
  entity.property(e => e.externalId).hasType(bigint('external_id')).isRequired().hasCustomMapper(int8AsBigInt);
  entity.property(e => e.price).hasType(decimal('price', 10, 2)).isRequired().hasCustomMapper(numericAsNumber);
});

await db.productPrices.insert({ externalId: 9007199254740993n, price: 12.5 });
const rows = await db.productPrices.where(p => gt(p.price, 10)).toList();
// → externalId: 9007199254740993n (bigint), price: 12.5 (number)
```

```sql
INSERT INTO "product_prices" ("external_id", "price") VALUES ($1, $2)
-- params: [ "9007199254740993", "12.5" ]

SELECT "product_prices"."id" as "id", "product_prices"."external_id" as "externalId", "product_prices"."price" as "price"
FROM "product_prices"
WHERE "product_prices"."price" > $1
-- params: [ "10" ]
```

> **Pitfall:** a mapper's `dataType()` replaces only the type name; the builder's length and precision are still
> appended. `dataType: () => 'decimal(10, 2)'` on `decimal('price', 10, 2)` rendered `"price" decimal(10, 2)(10, 2)`
> and failed with `syntax error at or near "("`.

### Store arrays: `.array()`

`.array()` turns a builder into a native PostgreSQL array column. A JS array written to it (insert, update, upsert,
merge, bulk operations, conditions) binds as one PostgreSQL array literal, the one form every driver accepts (Bun's SQL
client cannot bind a JS array to an array parameter). Elements are escaped as the literal needs: strings quoted, `null`
as NULL, a `Date` as its ISO instant, bytes in the bytea hex form, a plain object as its JSON text (for `jsonb[]`),
nested arrays as a multidimensional literal. A mapper of the column's own (`hasCustomMapper()`, `mapWith()`) replaces
this and binds the whole array itself. `.hasTypescriptType<T>()` retypes the builder only (here `Permission[]`):
`hasType()` ignores the builder's type, so the property's `DbColumn<Permission[]>` is what types queries.

```ts
// fragment
type Permission = 1 | 2 | 4;

class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  tags!: DbColumn<string[]>;
  scores?: DbColumn<number[]>;
  permissions?: DbColumn<Permission[]>;
}

model.entity(Post, entity => {
  entity.toTable('posts');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
  entity.property(e => e.tags).hasType(text('tags').array()).isRequired();
  entity.property(e => e.scores).hasType(integer('scores').array());
  entity.property(e => e.permissions).hasType(integer('permissions').array().hasTypescriptType<Permission[]>());
});

await db.posts.insert({ title: 'Arrays', tags: ['sql', 'a "quoted", tag'], scores: [3, 5], permissions: [1, 4] });
await db.posts.where(p => arrayContains(p.tags, 'sql')).select(p => ({ tags: p.tags, scores: p.scores, permissions: p.permissions })).toList();
// → [{ tags: ['sql', 'a "quoted", tag'], scores: [3, 5], permissions: [1, 4] }]
```

```sql
CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "tags" text[] NOT NULL,
  "scores" integer[],
  "permissions" integer[],
  PRIMARY KEY ("id")
)

INSERT INTO "posts" ("title", "tags", "scores", "permissions") VALUES ($1, $2, $3, $4)
-- params: [ "Arrays", "{\"sql\",\"a \\\"quoted\\\", tag\"}", "{3,5}", "{1,4}" ]

SELECT "posts"."tags" as "tags", "posts"."scores" as "scores", "posts"."permissions" as "permissions"
FROM "posts"
WHERE (CAST($1 AS text) = ANY("posts"."tags"))
-- params: [ "sql" ]
```

Filter on an array column with the array helpers (`arrayContains`, `arrayContainsAll`, `arrayOverlaps`, …) and add or
remove one value in an UPDATE with `arrayAppendUnique()` / `arrayRemove()` (since 1.0.31):
[Query array columns](./sql-expressions.md#query-array-columns).

### Name any other SQL type: `new ColumnBuilder<T>(name, sqlType)`

For types without a factory (`inet`, `interval`, `citext`, `vector(3)`, …) construct the builder yourself; `T` is the
TypeScript type. `TypeAliases` holds plain type-name strings (`int` → `'integer'`, `float` →
`'double precision'`, `datetime` → `'timestamp'`, `string` → `'text'`, `bool` → `'boolean'`).

```ts
// fragment
entity.property(e => e.ip).hasType(new ColumnBuilder<string>('ip', 'inet'));
entity.property(e => e.took).hasType(new ColumnBuilder<string>('took', 'interval'));
entity.property(e => e.rating).hasType(new ColumnBuilder<number>('rating', TypeAliases.float));
```

DDL: `"ip" inet`, `"took" interval`, `"rating" double precision`.

### Column builder methods

The builder carries constraints of its own; the property methods above call them.

| Builder method | Same as | Notes |
|---|---|---|
| `notNull()` | `isRequired()` | |
| `primaryKey()` | `isPrimaryKey()` | also NOT NULL |
| `unique()` | `isUnique()` | |
| `default(value)` | `hasDefaultValue(value)` | |
| `length(n)` / `precision(p, s?)` | the factory's arguments | `varchar('name').length(200)` = `varchar('name', 200)` |
| `mapWith(mapper)` | `hasCustomMapper(mapper)` | |
| `hasCollation(def)` | the property method of the same name | |
| `generatedAlwaysAsIdentity(options?)` | the property method of the same name | |
| `references(table, column = 'id')` | — | an unnamed inline foreign key to an unqualified table name, no navigation; prefer `hasOne()` |
| `autoIncrement()` | — | adds nothing to the DDL; `insert()` then drops the column's values. Use `generatedAlwaysAsIdentity()` |

```ts
// fragment
model.entity(Product, entity => {
  entity.toTable('products');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  // the builder methods do what the property methods do
  entity.property(e => e.name).hasType(varchar('name').length(200).notNull().unique());
  entity.property(e => e.price).hasType(decimal('price').precision(10, 2).notNull().default(0));
  // autoIncrement() adds nothing to the DDL; insert() then drops the column's values
  entity.property(e => e.legacyNo).hasType(integer('legacy_no').autoIncrement());
  // a TypeAliases constant is the type name as a string
  entity.property(e => e.rating).hasType(new ColumnBuilder<number>('rating', TypeAliases.float));
});

model.entity(ProductPrice, entity => {
  entity.toTable('product_prices');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  // a column-level foreign key: unnamed in the DDL, no navigation
  entity.property(e => e.productId).hasType(integer('product_id').notNull().references('products', 'id'));
  entity.property(e => e.price).hasType(decimal('price', 10, 2).notNull());
});

await db.products.insert({ name: 'Lamp', price: 10, legacyNo: 42, rating: 4.5 });   // legacyNo is not sent
```

```sql
CREATE TABLE IF NOT EXISTS "products" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "name" varchar(200) NOT NULL UNIQUE,
  "price" decimal(10, 2) NOT NULL DEFAULT 0,
  "legacy_no" integer,
  "rating" double precision,
  PRIMARY KEY ("id")
)

CREATE TABLE IF NOT EXISTS "product_prices" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "product_id" integer NOT NULL,
  "price" decimal(10, 2) NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
)

INSERT INTO "products" ("name", "price", "rating") VALUES ($1, $2, $3)
-- params: [ "Lamp", 10, 4.5 ]
```

## Generate primary keys: identity columns

| Key | Declare | DDL | Notes |
|---|---|---|---|
| Identity (use for new tables) | `integer('id').primaryKey().generatedAlwaysAsIdentity()` | `"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL` | the backing sequence is PostgreSQL's `<table>_<column>_seq` |
| Identity with start and step | `generatedAlwaysAsIdentity({ startWith: 1000, incrementBy: 1 })` | `GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 1)` | `IdentityOptions` has `startWith`, `incrementBy` and `name`; `name` is never emitted |
| Legacy auto-increment | `serial('id')` / `bigserial('id')` + `isPrimaryKey()` | `"id" serial` | `bigserial` reads as a string |
| Composite | `isPrimaryKey()` on each key property | `PRIMARY KEY ("order_id", "task_id")` | see [Composite keys](#composite-keys) |
| A counter shared by several tables | a [model sequence](#number-documents-model-sequences-and-runtimesequence) as the column default | `DEFAULT nextval('document_no_seq')` | identities cannot share a sequence |

`insert()` and `insertBulk()` leave identity and serial columns out of the INSERT, also when the row sets them. Read the
generated key back with `.returning()`; write explicit ids with `insertBulk(rows, { overridingSystemValue: true })`.

```ts
// fragment
model.entity(Order, entity => {
  entity.toTable('orders');
  entity.property(e => e.id)
    .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ startWith: 1000, incrementBy: 1 }));
  entity.property(e => e.status).hasType(varchar('status', 20)).isRequired().hasDefaultValue(`'pending'`);
  // … more columns: see the next section
});

await db.orders.insert({ id: 5, status: 'paid' });                                   // id 5 is dropped: the row gets 1000
const created = await db.orders.insert({ status: 'paid' }).returning(o => ({ id: o.id, status: o.status, items: o.items, isPaid: o.isPaid }));
// → { id: 1001, status: 'paid', items: [], isPaid: false }
await db.orders.insertBulk([{ id: 5, status: 'imported' }], { overridingSystemValue: true });   // id 5 is written
```

```sql
INSERT INTO "orders" ("status") VALUES ($1)
-- params: [ "paid" ]

INSERT INTO "orders" ("status") VALUES ($1) RETURNING "id" AS "id", "status" AS "status", "items" AS "items", "is_paid" AS "isPaid"
-- params: [ "paid" ]

INSERT INTO "orders" ("id", "status") OVERRIDING SYSTEM VALUE VALUES ($1, $2)
-- params: [ 5, "imported" ]
```

> **Pitfall:** there is no `generatedByDefaultAsIdentity()` (TS2551), and `IdentityOptions` has no `minValue`,
> `maxValue`, `cache` or `cycle` (TS2353). Use a model sequence for those options.

## Set column defaults: `hasDefaultValue()`

The value is written into the DDL as SQL. `insert()` leaves out a column that a row does not set, so the default
applies; `insertBulk()` lists every column that ANY row sets and binds NULL for the rows without it.

| Value passed | DDL | Use for |
|---|---|---|
| `'NOW()'`, `'gen_random_uuid()'` | `DEFAULT NOW()`: the string verbatim | SQL expressions |
| `"'pending'"` | `DEFAULT 'pending'` | string literals: include the SQL quotes |
| `'pending'` | `DEFAULT pending`: fails, `column "pending" does not exist` | never |
| `''` | `DEFAULT ''` | the empty string |
| `0` | `DEFAULT 0` | numbers |
| `true` / `false` | `DEFAULT TRUE` / `DEFAULT FALSE` | booleans |
| `null` | `DEFAULT NULL` | |
| `sql.raw("'[]'::jsonb")` | `DEFAULT '[]'::jsonb` | casts, arrays, jsonb |
| `new Date('2026-01-02T03:04:05Z')` | `DEFAULT '2026-01-02T03:04:05.000Z'` | `timestamptz` columns only |

```ts
// fragment: the whole orders table of the previous section
model.entity(Order, entity => {
  entity.toTable('orders');
  entity.property(e => e.id)
    .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ startWith: 1000, incrementBy: 1 }));
  entity.property(e => e.status).hasType(varchar('status', 20)).isRequired().hasDefaultValue(`'pending'`);
  entity.property(e => e.note).hasType(text('note')).hasDefaultValue('');
  entity.property(e => e.isPaid).hasType(boolean('is_paid')).isRequired().hasDefaultValue(false);
  entity.property(e => e.priority).hasType(integer('priority')).isRequired().hasDefaultValue(0);
  entity.property(e => e.createdAt).hasType(timestamptz('created_at')).isRequired().hasDefaultValue('NOW()');
  entity.property(e => e.publicId).hasType(uuid('public_id')).isRequired().hasDefaultValue('gen_random_uuid()');
  entity.property(e => e.items).hasType(jsonb('items')).isRequired().hasDefaultValue(sql.raw(`'[]'::jsonb`));
  entity.property(e => e.tags).hasType(text('tags').array()).hasDefaultValue(sql.raw(`'{}'::text[]`));
  entity.property(e => e.expiresAt).hasType(timestamp('expires_at')).hasDefaultValue(sql.raw(`NOW() + INTERVAL '30 days'`));
});
```

```sql
CREATE TABLE IF NOT EXISTS "orders" (
  "id" integer GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 1) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "note" text DEFAULT '',
  "is_paid" boolean NOT NULL DEFAULT FALSE,
  "priority" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "public_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tags" text[] DEFAULT '{}'::text[],
  "expires_at" timestamp DEFAULT NOW() + INTERVAL '30 days',
  PRIMARY KEY ("id")
)
```

A column given in some rows of an `insertBulk()` gets NULL in the others, not its default:

```ts
// fragment: orders.status is NOT NULL DEFAULT 'pending'
await db.orders.insertBulk([{ totalAmount: 10 }, { status: 'completed', totalAmount: 20 }]);   // fails
await db.orders.insertBulk([{ totalAmount: 10 }, { totalAmount: 15 }]);                         // both 'pending'
```

```sql
INSERT INTO "orders" ("status", "total_amount") VALUES ($1, $2), ($3, $4)
-- params: [ null, 10, "completed", 20 ]
-- error: null value in column "status" of relation "orders" violates not-null constraint

INSERT INTO "orders" ("total_amount") VALUES ($1), ($2)
-- params: [ 10, 15 ]
```

> **Pitfall:** a `Date` default is the ISO text of the instant (`'2026-01-02T03:04:05.000Z'`). A `timestamp` column
> (without time zone) stores it as the wall time 03:04:05 and reads it back shifted by the local offset (captured at
> UTC+1: `2026-01-02T02:04:05.000Z`); a `timestamptz` column reads it back exactly. Use `timestamptz`, or an SQL
> expression such as `'NOW()'`.

## Link tables: `hasOne()` and `hasMany()`

| Relation | Declare on | Call | Creates | Query SQL |
|---|---|---|---|---|
| Many-to-one (post → user) | the table holding the foreign key | `hasOne(e => e.user, () => User).withForeignKey(p => p.userId).withPrincipalKey(u => u.id)` | a FOREIGN KEY constraint | `LEFT JOIN "users" AS "user" ON …`; INNER JOIN with `isRequired()` |
| One-to-many (user → posts) | the parent | `hasMany(e => e.posts, () => Post).withForeignKey(p => p.userId).withPrincipalKey(u => u.id)` | no constraint | a subquery or LATERAL join filtered on `posts.user_id` |
| One-to-one, both directions | the key side: `hasOne()`; the other side: `hasOne(…).isInverseNavigation()` | see [below](#one-to-one-in-both-directions-isinversenavigation) | one constraint | `LEFT JOIN` |
| Composite key | either side | one selector returning an array: `withForeignKey(n => [n.orderId, n.taskId])` | on `hasOne()`, a multi-column constraint | `ON a = b AND c = d` |
| Filtered navigation or collection | either side | a constant in the key array: `withPrincipalKey(u => [u.id, 'pending'])` | on `hasOne()`, the constraint without the constant part | `… AND "x"."status" = 'pending'` |

`withForeignKey()` selects the foreign-key column(s) and `withPrincipalKey()` the referenced key: on `hasOne()` the
foreign key is on this entity, on `hasMany()` it is on the target (an `isInverseNavigation()` side swaps them,
[below](#one-to-one-in-both-directions-isinversenavigation)). Declare both sides when you query both directions.
Builder methods:

- `onDelete(action)` / `onUpdate(action)`: `'cascade'`, `'restrict'`, `'no action'`, `'set null'` or `'set default'`;
  without them the constraint has no `ON DELETE` / `ON UPDATE` clause (PostgreSQL's default, NO ACTION).
- `hasDbName(name)`: the constraint name; default `FK_<table>_<target table>_<first foreign-key column>`.
- `isRequired()`: INNER JOIN instead of LEFT JOIN ([below](#required-and-optional-navigations-isrequired)).
- `isInverseNavigation()`: no constraint from this side ([below](#one-to-one-in-both-directions-isinversenavigation)).

### Many-to-one and one-to-many

```ts
// fragment: inside setupModel(model)
model.entity(User, entity => {
  // … properties
  // one-to-many: the foreign key is on Post
  entity.hasMany(e => e.posts, () => Post)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id);
});

model.entity(Post, entity => {
  // … properties
  // many-to-one: the foreign key is on this table
  entity.hasOne(e => e.user, () => User)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id)
    .onDelete('cascade')
    .onUpdate('no action')
    .hasDbName('FK_posts_users_user_id')
    .isRequired();
});

model.entity(Task, entity => {
  // … properties; levelId is declared `levelId?: DbColumn<number>`
  // optional navigation (nullable foreign key): no isRequired();
  // `!` because levelId is declared optional (`levelId?:`) and the selector must return a column
  entity.hasOne(e => e.level, () => TaskLevel)
    .withForeignKey(t => t.levelId!)
    .withPrincipalKey(l => l.id)
    .onDelete('set null');
});

await db.posts.select(p => ({ title: p.title, author: p.user!.username })).toList();
await db.tasks.select(t => ({ title: t.title, level: t.level!.name })).toList();
// → [{ title: 'Pack', level: 'High' }, { title: 'Ship', level: undefined }]   (no level row: the LEFT JOIN found none)
```

```sql
CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "user_id" integer NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_posts_users_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
)

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "level_id" integer,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_tasks_task_levels_level_id" FOREIGN KEY ("level_id") REFERENCES "task_levels"("id") ON DELETE SET NULL
)

SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"

SELECT "tasks"."title" as "title", "level"."name" as "level"
FROM "tasks"
LEFT JOIN "task_levels" AS "level" ON "tasks"."level_id" = "level"."id"
```

- Under `strict`, a foreign key declared optional (`levelId?:`) needs `t => t.levelId!` (or the docs' model form
  `` t => sql`${t.levelId}` ``, the same key): `t => t.levelId` is TS2322. A `sql` fragment that reads no column is a
  constant key part.
- `hasMany()` alone creates no constraint, and neither does an `isInverseNavigation()` side.
- `ensureCreated()` creates tables in foreign-key order and builds each table's unique indexes right after it. A
  foreign key goes into its `CREATE TABLE` when the key it references exists at that point (a primary key, a UNIQUE
  column, or a unique index of a table created earlier). Otherwise (the referenced table comes later, as in a cycle;
  the key is a unique index of the same table) it is added with `ALTER TABLE … ADD CONSTRAINT` once every table and
  its unique indexes exist (since 1.0.20).

### Required and optional navigations: `isRequired()`

On a navigation, `isRequired()` makes every join through it an INNER JOIN. It adds no NOT NULL (put `isRequired()` on
the foreign-key property for that). On a nullable foreign key it drops rows:

```ts
// fragment: Task.levelId is nullable
entity.hasOne(e => e.level, () => TaskLevel)
  .withForeignKey(t => t.levelId!)
  .withPrincipalKey(l => l.id)
  .isRequired();                                                 // WRONG for a nullable key

await db.tasks.select(t => ({ title: t.title, level: t.level!.name })).toList();
// → [{ title: 'Pack', level: 'High' }]: the task without a level is gone
await db.tasks.select(t => ({ title: t.title })).toList();
// → [{ title: 'Pack' }, { title: 'Ship' }]
```

```sql
SELECT "tasks"."title" as "title", "level"."name" as "level"
FROM "tasks"
INNER JOIN "task_levels" AS "level" ON "tasks"."level_id" = "level"."id"
```

### One-to-one in both directions: `isInverseNavigation()`

Declare the foreign key once, on the table that holds it. The other side is a `hasOne()` marked
`isInverseNavigation()`: navigation only, no constraint. Its key selectors are swapped: `withForeignKey()` takes this
entity's key, `withPrincipalKey()` the other table's foreign key.

```ts
// fragment
model.entity(User, entity => {
  // the inverse side of a one-to-one: navigation only, no foreign key constraint
  entity.hasOne(e => e.profile, () => UserProfile)
    .withForeignKey(u => u.id)
    .withPrincipalKey(p => p.userId)
    .isInverseNavigation();
});

model.entity(UserProfile, entity => {
  entity.toTable('user_profiles');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.userId).hasType(integer('user_id')).isRequired().isUnique();
  entity.property(e => e.bio).hasType(text('bio'));

  // the owning side: this hasOne creates the foreign key
  entity.hasOne(e => e.user, () => User)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id)
    .onDelete('cascade');
});

await db.users.select(u => ({ username: u.username, bio: u.profile!.bio })).toList();
```

```sql
CREATE TABLE IF NOT EXISTS "user_profiles" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "user_id" integer NOT NULL UNIQUE,
  "bio" text,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_user_profiles_users_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
)

SELECT "users"."username" as "username", "profile"."bio" as "bio"
FROM "users"
LEFT JOIN "user_profiles" AS "profile" ON "users"."id" = "profile"."user_id"
```

### Composite keys

A composite key is ONE selector that returns an array; the parts are matched by position. `OrderTask` has the composite
primary key `(order_id, task_id)`; `OrderTaskNote` references it:

```ts
// fragment
model.entity(OrderTask, entity => {
  entity.toTable('order_task');
  // composite primary key: isPrimaryKey() on each column
  entity.property(e => e.orderId).hasType(integer('order_id')).isPrimaryKey();
  entity.property(e => e.taskId).hasType(integer('task_id')).isPrimaryKey();
  entity.property(e => e.sortOrder).hasType(integer('sort_order'));
  // … hasOne(order), hasOne(task)
  entity.hasMany(e => e.notes, () => OrderTaskNote)
    .withForeignKey(n => [n.orderId, n.taskId])
    .withPrincipalKey(ot => [ot.orderId, ot.taskId]);
});

model.entity(OrderTaskNote, entity => {
  entity.toTable('order_task_notes');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.orderId).hasType(integer('order_id')).isRequired();
  entity.property(e => e.taskId).hasType(integer('task_id')).isRequired();
  entity.property(e => e.note).hasType(text('note')).isRequired();

  // composite foreign key: ONE selector returning an array, matched by position
  entity.hasOne(e => e.orderTask, () => OrderTask)
    .withForeignKey(n => [n.orderId, n.taskId])
    .withPrincipalKey(ot => [ot.orderId, ot.taskId])
    .onDelete('cascade');
});

await db.orderTaskNotes.select(n => ({ note: n.note, sortOrder: n.orderTask!.sortOrder, task: n.orderTask!.task!.title })).toList();
await db.orderTasks.where(ot => eq(ot.orderId, 1)).select(ot => ({ taskId: ot.taskId, notes: ot.notes!.count() })).toList();
```

```sql
CREATE TABLE IF NOT EXISTS "order_task" (
  "order_id" integer NOT NULL,
  "task_id" integer NOT NULL,
  "sort_order" integer,
  PRIMARY KEY ("order_id", "task_id"),
  CONSTRAINT "FK_order_task_orders_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_order_task_tasks_task_id" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS "order_task_notes" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "order_id" integer NOT NULL,
  "task_id" integer NOT NULL,
  "note" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_order_task_notes_order_task_order_id" FOREIGN KEY ("order_id", "task_id") REFERENCES "order_task"("order_id", "task_id") ON DELETE CASCADE
)

SELECT "order_task_notes"."note" as "note", "orderTask"."sort_order" as "sortOrder", "task"."title" as "task"
FROM "order_task_notes"
LEFT JOIN "order_task" AS "orderTask" ON "order_task_notes"."order_id" = "orderTask"."order_id" AND "order_task_notes"."task_id" = "orderTask"."task_id"
LEFT JOIN "tasks" AS "task" ON "orderTask"."task_id" = "task"."id"

SELECT "order_task"."task_id" as "taskId", (SELECT COALESCE(COUNT(*), 0)
FROM "order_task_notes" "lateral_0_notes"
WHERE "lateral_0_notes"."order_id" = "order_task"."order_id" AND "lateral_0_notes"."task_id" = "order_task"."task_id") as "notes"
FROM "order_task"
WHERE "order_task"."order_id" = $1
-- params: [ 1 ]
```

> **Pitfall:** an ARRAY of selectors (`withForeignKey([n => n.orderId, n => n.taskId])`) does not compile (TS2345),
> and at run time only its first column is captured: the join and the constraint use one column, and where that column
> alone is not unique in the referenced table, `ensureCreated()` fails with `no unique constraint matching given keys`.

### Filtered relations: constant key parts

A number, boolean or string in the key array is a constant: the join or the collection keeps only the rows that match
it, and the foreign-key constraint leaves that part out.

```ts
// fragment
model.entity(User, entity => {
  // a constant key part filters the collection: only pending orders
  entity.hasMany(e => e.pendingOrders, () => Order)
    .withForeignKey(o => [o.userId, o.status])
    .withPrincipalKey(u => [u.id, 'pending']);
});

model.entity(CartItem, entity => {
  // a constant in the foreign-key array, matched against a principal column: only an ACTIVE product is found
  entity.hasOne(e => e.activeProduct, () => Product)
    .withForeignKey(ci => [ci.productId, true])
    .withPrincipalKey(p => [p.id, p.active]);
});

await db.users.select(u => ({ username: u.username, pending: u.pendingOrders!.count(), all: u.orders!.count() })).toList();
// → [{ username: 'alice', pending: 1, all: 2 }, { username: 'bob', pending: 1, all: 1 }]
await db.cartItems.select(ci => ({ id: ci.id, product: ci.activeProduct!.name })).toList();
// → [{ id: 1, product: 'Lamp' }, { id: 2, product: undefined }]   (cart item 2 holds an inactive product)
```

```sql
CREATE TABLE IF NOT EXISTS "cart_items" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "product_id" integer NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "FK_cart_items_products_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id")
)

SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "orders" "lateral_0_pendingOrders"
WHERE "lateral_0_pendingOrders"."user_id" = "users"."id" AND "lateral_0_pendingOrders"."status" = 'pending') as "pending", (SELECT COALESCE(COUNT(*), 0)
FROM "orders" "lateral_1_orders"
WHERE "lateral_1_orders"."user_id" = "users"."id") as "all"
FROM "users"

SELECT "cart_items"."id" as "id", "activeProduct"."name" as "product"
FROM "cart_items"
LEFT JOIN "products" AS "activeProduct" ON "cart_items"."product_id" = "activeProduct"."id" AND true = "activeProduct"."active"
```

A string constant is inlined between single quotes without escaping: use constants you write yourself, never input.

## Index what your queries filter, join and sort on: `hasIndex()`

| Query shape | Declare | DDL |
|---|---|---|
| `eq(col, v)`, a join or a collection on `col` | `hasIndex('ix_t_col', e => [e.col])` | `("col")` |
| `eq(a, v)` plus a range or sort on `b` | `hasIndex('ix_t_a_b', e => [e.a, e.b])`: equality column first | `("a", "b")` |
| A unique key | `isUnique()` on the property, or `hasIndex(…).isUnique()` for a named or composite one | inline `UNIQUE` / `CREATE UNIQUE INDEX …` |
| Unique among a subset of rows | `hasIndex(…).isUnique().where('"is_active" = true')` | `… WHERE "is_active" = true` |
| A filter that always includes the same predicate | `hasIndex(…).where('…')` (partial index) | `… WHERE …` |
| A seek that also reads a few more columns | `hasIndex(…).include(e => [e.c, e.d])` | `… INCLUDE ("c", "d")` |
| `lower(col) = v` and other expressions | `hasIndex(name).withExpression(e => lower(e.col))` or `[ixLower(e.col)]` | `(lower("col"))` |
| Case- and accent-insensitive `=` and prefix | `hasIndex(…, e => [ixNormalized(e.col)])` | `(public.search_normalize("col") text_pattern_ops)` |
| `ILIKE '%x%'` / `normalizedLike('%x%')` | `.using('gin').withOperatorClass('gin_trgm_ops')` / `ixNormalized(e.col, { gin: true })` | `USING gin (… gin_trgm_ops)` |
| Trigram search with a GiST index | `.using('gist').withOperatorClass('gist_trgm_ops')` | `USING gist ("title" gist_trgm_ops)` |
| Range scans on a large, append-only time column | `.using('brin')` | `USING brin ("created_at")` |
| Equality only | `.using('hash')` | `USING hash ("name")` |
| A unique column where NULL may occur once | `.isUnique().nullsNotDistinct()` (PostgreSQL 15+) | `… NULLS NOT DISTINCT` |

```ts
// fragment: inside setupModel(model), after the properties
model.entity(Post, entity => {
  // composite: equality column first, range/sort column second
  entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
  // trigram GIN for ILIKE '%x%' (needs the pg_trgm extension: see below)
  entity.hasIndex('ix_posts_title_trgm', e => [e.title]).using('gin').withOperatorClass('gin_trgm_ops');
});

model.entity(Order, entity => {
  // covering index: filter on the key, read total and date from the index alone
  entity.hasIndex('ix_orders_user_status', e => [e.userId, e.status])
    .include(e => [e.totalAmount, e.createdAt]);
  // BRIN for an append-only timestamp
  entity.hasIndex('ix_orders_created_brin', e => [e.createdAt]).using('brin');
  // built without blocking writes (outside a transaction only)
  entity.hasIndex('ix_orders_status', e => [e.status]).concurrent();
});

model.entity(Product, entity => {
  // unique, and at most ONE row may have sku = NULL (PostgreSQL 15+)
  entity.hasIndex('ux_products_sku', e => [e.sku]).isUnique().nullsNotDistinct();
  // hash: equality only
  entity.hasIndex('ix_products_name_hash', e => [e.name]).using('hash');
});

model.entity(User, entity => {
  // partial unique index: unique among active users only
  entity.hasIndex('ux_users_active_email', e => [e.email]).isUnique().where('"is_active" = true');
});
```

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "ux_users_active_email" ON "users" ("email") WHERE "is_active" = true

CREATE UNIQUE INDEX IF NOT EXISTS "ux_products_sku" ON "products" ("sku") NULLS NOT DISTINCT

CREATE INDEX IF NOT EXISTS "ix_posts_query" ON "posts" ("user_id", "published_at")

CREATE INDEX IF NOT EXISTS "ix_posts_title_trgm" ON "posts" USING gin ("title" gin_trgm_ops)

CREATE INDEX IF NOT EXISTS "ix_orders_user_status" ON "orders" ("user_id", "status") INCLUDE ("total_amount", "created_at")

CREATE INDEX IF NOT EXISTS "ix_orders_created_brin" ON "orders" USING brin ("created_at")

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_orders_status" ON "orders" ("status")

CREATE INDEX IF NOT EXISTS "ix_products_name_hash" ON "products" USING hash ("name")
```

| `IndexBuilder` method | Effect | Rules |
|---|---|---|
| `isUnique()` | `CREATE UNIQUE INDEX` | built right after its table, before foreign keys that reference it |
| `where(sql)` | partial index | raw SQL over quoted database column names; combines with expressions (`e => [ixLower(e.name)]` + `.where('"deleted_at" IS NULL')`) |
| `include(e => [...])` | `INCLUDE (…)` covering columns | plain columns only; `btree`, `gist`, `spgist` only |
| `nullsNotDistinct()` | `NULLS NOT DISTINCT` | emitted on unique indexes only; PostgreSQL 15+ |
| `using(method)` | `USING …` | `btree` (default), `gin`, `gist`, `hash`, `brin`, `spgist` |
| `withOperatorClass(name)` | appended to EVERY column: `("title" gin_trgm_ops, "subtitle" gin_trgm_ops)` | must be an identifier |
| `concurrent()` | `CREATE INDEX CONCURRENTLY` | cannot run inside a transaction; the schema manager option `concurrentIndexes: true` applies it to every index |
| `withExpression(...expressions)` | expression entries instead of the selector's columns | see [Index an expression](#index-an-expression-the-queries-use-withexpression-and-ixlower) |

- `hasIndex()` replaces an earlier index of the same name: the last declaration wins.
- `ensureCreated()` sends `CREATE INDEX IF NOT EXISTS` for every index on every call and never changes an existing
  index of the same name; `migrate()` recreates a changed one ([below](#change-an-index-under-the-same-name-migrate-recreates-it)).
- Refused while `setupModel()` runs (the context constructor throws): a bound value in an index expression
  (`index expression binds a parameter — inline constants with literal()`), an operator class that is no identifier,
  an expression in `include()`.
- Refused by the schema manager before the index is built: `isUnique()` on a GIN index (`cannot be both UNIQUE and a
  GIN index`), `include()` on `gin`, `hash` or `brin` (`cannot use INCLUDE with USING gin`).
- `gin_trgm_ops` and `gist_trgm_ops` come from the `pg_trgm` extension. The schema manager creates it only for
  `ixNormalized(…, { gin: true })`; for a plain trigram index create it yourself before the tables, in
  `onMigrationStart()`: `await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')`. Without it PostgreSQL refuses
  the index: `operator class "gin_trgm_ops" does not exist for access method "gin"` (checked on PostgreSQL 18).

> **Efficiency:** prefer `include()` over extra key columns for columns a query only reads, or filters after the seek.
> Key columns become usable as index conditions (PostgreSQL 18's skip scan reaches past a low-cardinality column), and
> the planner may then combine them, for example to answer an `OR`, into a bitmap scan, which always visits the table.
> INCLUDE columns can only be filtered, so the index-only scan stays the plan. On a unique index, INCLUDE columns take
> no part in the uniqueness check.

### Index an expression the queries use: `withExpression()` and `ixLower()`

An expression index serves only a query that spells the same expression. Write the expression once, as a builder over
the table's columns, and use it in the index and in the queries. `withExpression()` also takes raw SQL; `ixLower()`
wraps a column inside the selector.

```ts
// fragment
import { lower, literal, sql, eq, ixLower } from 'linkgress-orm';
import type { SqlOperand } from 'linkgress-orm';

// one definition for the index AND the queries that must use it
const viewsBucket = (views: SqlOperand<number>) => sql<number>`${views} / ${literal(100, 'integer')}`;

model.entity(User, entity => {
  // expression index from a builder: the query below spells the same expression
  entity.hasIndex('ix_users_email_lower').withExpression(e => lower(e.email));
  // expression index from raw SQL
  entity.hasIndex('ix_users_plan').withExpression(`("metadata"->>'plan')`);
  // ixLower() inside the selector
  entity.hasIndex('ix_users_username_lower', e => [ixLower(e.username)]);
});

model.entity(Post, entity => {
  entity.hasIndex('ix_posts_views_bucket').withExpression(e => viewsBucket(e.views));
  // plain column + expression in one index
  entity.hasIndex('ix_posts_id_title_lower', e => [e.id, ixLower(e.title)]);
});

await db.users.where(u => eq(lower(u.email), 'alice@example.com')).select(u => ({ id: u.id })).toList();
await db.posts.where(p => eq(viewsBucket(p.views), 3)).select(p => ({ id: p.id })).toList();
```

```sql
CREATE INDEX IF NOT EXISTS "ix_users_email_lower" ON "users" (lower("email"))

CREATE INDEX IF NOT EXISTS "ix_users_plan" ON "users" (("metadata"->>'plan'))

CREATE INDEX IF NOT EXISTS "ix_users_username_lower" ON "users" (lower("username"))

CREATE INDEX IF NOT EXISTS "ix_posts_views_bucket" ON "posts" (("views" / CAST(100 AS integer)))

CREATE INDEX IF NOT EXISTS "ix_posts_id_title_lower" ON "posts" ("id", lower("title"))

SELECT "users"."id" as "id"
FROM "users"
WHERE lower("users"."email") = $1
-- params: [ "alice@example.com" ]

SELECT "posts"."id" as "id"
FROM "posts"
WHERE "posts"."views" / CAST(100 AS integer) = $1
-- params: [ 3 ]
```

- The builder receives the table's columns UNQUALIFIED (`"views"`), carrying their mapper and SQL type, so
  type-dependent helpers render as they do in a query. Navigations are refused; declare the properties an expression
  reads before the index.
- Constants must be inline: `literal(…)`. An index is matched by its expression tree, and a bound parameter is no
  constant there: an expression that binds a parameter or a placeholder throws. (`jsonbPathText(e.metadata, 'plan')`
  inlines its key and is accepted: `("metadata"->>'plan')`.)
- Raw SQL is used as written: wrap an expression that is not one function call in its own parentheses.
  `` `(("metadata"->>'n')::int)` `` works; `` `("metadata"->>'n')::int` `` renders `ON "users" (("metadata"->>'n')::int)`,
  refused with `syntax error at or near "::"` (checked on PostgreSQL 18 and in memory).
- A builder's text is kept verbatim when it is one function call or one parenthesised group, and wrapped in `( … )`
  otherwise, a top-level `CAST(…)` included, which PostgreSQL prints as `((x)::t)`: the spelling of PostgreSQL's
  `pg_get_indexdef`, so `migrate()` recognises an existing index as unchanged. The comparison also treats
  `CAST(x AS t)` like `x::t`, keeping the grouping of a compound `x`: `CAST(a + b AS bigint) * 2` equals
  `(a + b)::bigint * 2` and differs from `a + b * 2`.
- `hasStatistics(…).withExpression(…)` takes the same builders.

> **Pitfall:** do not use `ixUnaccent()` in an index. PostgreSQL refuses `unaccent()` there (`functions in index
> expression must be marked IMMUTABLE`, checked on PostgreSQL 18), wrapped or not. The in-memory database accepts the
> wrapped form `ixLower(ixUnaccent(col))` (`lower(unaccent("col"))`), so tests of it pass while production fails. Use
> `ixNormalized()`.

### Search case- and accent-insensitively: `ixNormalized()`

`ixNormalized(col)` indexes `public.search_normalize(col)`, an accent- and case-insensitive normalization. Declaring one
makes the schema manager create the `unaccent` extension and the function (and `pg_trgm` for `{ gin: true }`) before
the tables. It pairs with the normalized query helpers (`normalizedEq`, `normalizedStartsWith`, `normalizedLike`, see
[Querying](./querying.md#normalized-accentcase-insensitive-search)).

```ts
// fragment
model.entity(User, entity => {
  // accent- and case-insensitive: btree for = and prefix LIKE, gin for substring search
  entity.hasIndex('ux_users_login', e => [ixNormalized(e.email)]).isUnique();
  entity.hasIndex('ix_users_username_search', e => [ixNormalized(e.username, { gin: true })]);
});

await db.users.where(u => normalizedEq(u.email, 'ZELJKO@example.com')).select(u => ({ id: u.id })).toList();
// → [{ id: 1 }]   (stored as 'Zeljko@Example.com')
await db.users.where(u => normalizedLike(u.username, '%zel%')).select(u => ({ id: u.id })).toList();
// → [{ id: 1 }]   (stored as 'Željko')
```

```sql
CREATE EXTENSION IF NOT EXISTS unaccent

CREATE EXTENSION IF NOT EXISTS pg_trgm

CREATE OR REPLACE FUNCTION public.search_normalize(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(public.unaccent('public.unaccent', value))
$$

CREATE UNIQUE INDEX IF NOT EXISTS "ux_users_login" ON "users" (public.search_normalize("email") text_pattern_ops)

CREATE INDEX IF NOT EXISTS "ix_users_username_search" ON "users" USING gin (public.search_normalize("username") gin_trgm_ops)

SELECT "users"."id" as "id"
FROM "users"
WHERE (public.search_normalize("users"."email") = public.search_normalize($1))
-- params: [ "ZELJKO@example.com" ]

SELECT "users"."id" as "id"
FROM "users"
WHERE (public.search_normalize("users"."username") LIKE public.search_normalize($1))
-- params: [ "%zel%" ]
```

- The btree form uses `text_pattern_ops`, so one index serves `normalizedEq` (`=`) and `normalizedStartsWith`
  (`LIKE 'prefix%'`) as index scans on databases of any locale, and enforces accent- and case-insensitive uniqueness.
  `{ gin: true }` builds a trigram GIN index for `normalizedLike('%x%')`; a UNIQUE GIN index is refused.
- `ixNormalized(e.email)` combines with plain columns: `e => [ixNormalized(e.email), e.hash]`.
- Keep `ixNormalized` the outermost helper; do not wrap it in `ixLower()` or another helper.
- The migrating role must be allowed to `CREATE EXTENSION unaccent` (and `pg_trgm` for `{ gin: true }`). The support
  statements (2, or 3 with `{ gin: true }`) run on every `ensureCreated()` and `migrate()`.
- Using the normalized helpers WITHOUT such an index: call `model.useSearchNormalize()` in `setupModel()` so the
  function exists:

```ts
// fragment
protected override setupModel(model: DbModelConfig): void {
  // normalized helpers in queries, no ixNormalized index on the table
  model.useSearchNormalize();
  // … model.entity(Tag, …)
}

await db.tags.where(t => normalizedStartsWith(t.name, 'CRE')).select(t => ({ name: t.name })).toList();
// → [{ name: 'Črepník' }]
```

```sql
CREATE EXTENSION IF NOT EXISTS unaccent

CREATE OR REPLACE FUNCTION public.search_normalize(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(public.unaccent('public.unaccent', value))
$$

SELECT "tags"."name" as "name"
FROM "tags"
WHERE (public.search_normalize("tags"."name") LIKE public.search_normalize($1) || '%')
-- params: [ "CRE" ]
```

### Change an index under the same name: `migrate()` recreates it

`migrate()` compares each model index with the one PostgreSQL stores under its name: uniqueness, method, columns or
expressions with operator classes, the `include()` list, the `where()` predicate and `NULLS NOT DISTINCT`. A changed
index is dropped and created again, without blocking writes (`DROP/CREATE INDEX CONCURRENTLY`) when the index is
`.concurrent()` or the schema manager runs with `concurrentIndexes: true`. A unique index that foreign keys rest on is
the exception: it is rebuilt blocking, with those foreign keys dropped and added back, in one transaction (since
1.0.20). On by default; `getSchemaManager({ recreateChangedIndexes: false })` restores the name-only behaviour, where a
same-named index is never touched.

```ts
// fragment: the database holds ix_users_email ON "users" ("email") from an older model
model.entity(User, entity => {
  // was: entity.hasIndex('ix_users_email', e => [e.email]);
  entity.hasIndex('ix_users_email', e => [ixNormalized(e.email)]);
});

await db.getSchemaManager({ concurrentIndexes: true }).migrate();
```

Before rebuilding, `migrate()` confirms the change with PostgreSQL itself: it builds the model's index on an empty
temporary mirror table (`_lkg_idxchk_<pid>_<n>`, so the migrating role needs the TEMP privilege) and compares
`pg_get_indexdef` of both. Of the 14 statements this migration sent for a one-table model (2 support statements, 5
catalog reads, 5 for the confirmation, 2 for the rebuild), these are the confirmation and the rebuild (`52976` is the
migrating process's id):

```sql
CREATE TEMP TABLE "_lkg_idxchk_52976_1" (LIKE "users")

CREATE INDEX "_lkg_idxchk_52976_1_ix0" ON "_lkg_idxchk_52976_1" (public.search_normalize("email") text_pattern_ops)

SELECT pg_get_indexdef(to_regclass($1)::oid, 0, true) AS d
-- params: [ "_lkg_idxchk_52976_1_ix0" ]

DROP INDEX IF EXISTS "_lkg_idxchk_52976_1_ix0"

DROP TABLE IF EXISTS "_lkg_idxchk_52976_1"

DROP INDEX CONCURRENTLY IF EXISTS "ix_users_email"

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_users_email" ON "users" (public.search_normalize("email") text_pattern_ops)
```

- An index is recreated only when PostgreSQL confirms the definition changed. A definition that only LOOKS different
  (an expanded timestamp literal, re-parenthesised arithmetic, a hidden default operator class, the `::text` cast
  PostgreSQL adds for `ixNormalized` on a `varchar` column) is left untouched. Partial-index predicates PostgreSQL
  rewrites at parse time (`active = true`, `deleted_at IS NULL`, `status IN ('a','b')`, `age BETWEEN 1 AND 10`,
  `created_at > '2020-01-01'`) compare correctly.
- When the confirmation cannot run (a read-only session, or the `search_normalize` support not yet created, as in an
  `analyze()` before the first `migrate()`), it fails closed: the index is left as it is. Captured: `analyze()` on
  the database above listed no `recreate_index` because the function did not exist yet; `migrate()` creates the support
  objects first and then recreated the index.
- A trailing clause the model cannot express (`WITH (…)` storage parameters, a tablespace) makes the stored definition
  incomparable: such an index is never recreated.
- A blocking recreate leaves the table without the index between the DROP and the CREATE; use the concurrent form on
  large tables.
- `ensureCreated()` never recreates or repairs an index: run `migrate()`.

### Repair an INVALID index

A failed `CREATE INDEX CONCURRENTLY` (a unique index over duplicate rows, an expression that raises for a row, a
timeout, a cancel) leaves the index INVALID (`pg_index.indisvalid = false`): PostgreSQL never reads it, and
`CREATE INDEX … IF NOT EXISTS` skips it because the name exists. `migrate()` treats it as missing and builds it again
from the model; `analyze()` lists the repair as `{ type: 'repair_index', indexName, previousDef, … }`.

```ts
// fragment: ux_users_username is INVALID (a concurrent unique build over duplicates failed)
import { IndexRepairError } from 'linkgress-orm';

try {
  await db.getSchemaManager({ concurrentIndexes: true }).migrate();
} catch (error) {
  if (error instanceof IndexRepairError) {
    // error.message: Could not repair INVALID index "ux_users_username" on "users": could not create unique index
    //   "ux_users_username" — Key (username)=(ann) is duplicated. Fix the cause and run the migration again.
    for (const failure of error.failures) {
      console.log(failure.indexName, failure.code, failure.reason);   // ux_users_username 23505 could not create …
    }
  }
  throw error;
}
```

```sql
DROP INDEX CONCURRENTLY IF EXISTS "ux_users_username"

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_users_username" ON "users" ("username")
-- error: could not create unique index "ux_users_username"
```

How it rebuilds:

- **Concurrent** (`.concurrent()` or `concurrentIndexes: true`): `DROP INDEX CONCURRENTLY IF EXISTS`, then
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; neither blocks writes. A failed build leaves a new INVALID index under
  the name: not ready when the build failed (the next migration repairs it again, and fails the same way until the
  cause is fixed), ready when it failed while validating a unique index (the next migration leaves it alone, below).
- **Blocking** (neither): the model's index is built beside the INVALID one under `<name>_lkgnew` (shortened to fit
  63 bytes) and swapped in once built: `DROP INDEX` of the INVALID one and `ALTER INDEX … RENAME` in one transaction.
  The build blocks writes as any `CREATE INDEX` does (a warning says so); the swap takes an ACCESS EXCLUSIVE lock
  briefly. A failed build leaves nothing behind, and the INVALID index stays as it was.
- Repairs run last, after every other operation (views re-created included), each on its own. Their failures are
  thrown together as one `IndexRepairError` after `onMigrationComplete` ran: the rest of the migration is done. A
  rebuild is never retried; remove the cause and migrate again. Until then every migration ends with the same
  `IndexRepairError`, never a raw database error.
- `IndexRepairError.failures` lists `indexName`, `tableName`, `schema`, `code` (the SQLSTATE), `cause` (the database
  error) and `reason` (its message with DETAIL and HINT); the error's own `indexName`, `code` and `cause` are the first
  failure's. A blocking repair's build error names the temporary index (`… "ux_users_username_lkgnew"`).
- The repair runs whatever `recreateChangedIndexes` says (an INVALID index is missing, not changed) and builds the
  model's current definition. The model index is validated first: one PostgreSQL cannot build (say `include()` on a GIN
  index) fails the repair and leaves the INVALID index as it was.
- Prefer the concurrent form for expression and partial indexes: a blocking `CREATE INDEX` also indexes row versions
  an older transaction can still see, so a row you just fixed with an `UPDATE` can fail the rebuild again until those
  transactions end. A concurrent build reads only live rows.

Left alone, with a warning naming the index and what to do (checked when planning and again right before the repair):

- an index whose table has an index build running (its own `CREATE INDEX CONCURRENTLY`, a `REINDEX INDEX CONCURRENTLY`
  building `<name>_ccnew`, or any other build): dropping it would queue behind the build and lock the table, or
  deadlock with it. `pg_stat_progress_create_index` shows the table of a build the migrating role may watch (a build
  run by a role it belongs to, or any build with `pg_read_all_stats`); for any other build the locks the build's
  backend holds (`pg_locks`, readable by every role) show the table. Migrate again once the build finished.
- a partitioned index: INVALID by design until every partition has an attached valid index (`CREATE INDEX … ON ONLY`,
  then each partition's index `CONCURRENTLY`, attached with `ALTER INDEX … ATTACH PARTITION`). The warning names the
  partitions without one.
- an index a constraint requires (`pg_constraint.conindid`): PostgreSQL refuses to drop it. Rebuild it in place with
  `REINDEX INDEX CONCURRENTLY`.
- a unique index that is still ready (`indisready`): it still rejects duplicates, which dropping it would stop.
  Rebuild it in place with `REINDEX INDEX CONCURRENTLY` (remove duplicate rows first if that fails).
- an index that is no longer INVALID when the repair runs; one dropped meanwhile is created.
- an INVALID index the model does not declare, like every index the model does not declare; a failed `REINDEX
  CONCURRENTLY`'s `<name>_ccnew` is one of them.

A scaffolded migration file (`MigrationScaffold`) drops the index in a `DO` block only where the schema manager would
repair it (INVALID, not partitioned, not required by a constraint, not a unique one still ready, no index build on its
table), then runs `CREATE INDEX … IF NOT EXISTS`, never `CONCURRENTLY`, because `MigrationRunner` runs each file in
one transaction: the drop's ACCESS EXCLUSIVE lock (reads and writes wait) is held until the file commits, and a failed
build rolls the drop back. Where the index is missing the file creates it; a healthy one is left alone.

## Improve row estimates: `hasStatistics()`

`hasStatistics(name, selector?)` declares a PostgreSQL extended-statistics object for planner misestimates: correlated
columns (multivariate, two or more entries, kinds narrowed with `withKinds()`), or one expression (univariate expression
statistics, no kinds).

```ts
// fragment: inside setupModel(model)
model.entity(User, entity => {
  // univariate expression statistics: row estimates for metadata->>'plan' predicates
  entity.hasStatistics('stx_users_plan').withExpression(`("metadata"->>'plan')`);
});

model.entity(Order, entity => {
  // multivariate statistics: user_id and status are correlated
  entity.hasStatistics('stx_orders_user_status', e => [e.userId, e.status]).withKinds('dependencies', 'ndistinct');
});
```

```sql
CREATE STATISTICS IF NOT EXISTS "stx_users_plan" ON ("metadata"->>'plan') FROM "users"

ANALYZE "users"

CREATE STATISTICS IF NOT EXISTS "stx_orders_user_status" (dependencies, ndistinct) ON "user_id", "status" FROM "orders"

ANALYZE "orders"
```

- Reconciled by NAME only: a missing object is created, an existing one is never compared or rebuilt. Rename it to
  change its definition.
- `ensureCreated()` sends `CREATE STATISTICS IF NOT EXISTS` and `ANALYZE <table>` for every object on EVERY call
  (captured on a second run): costly at startup on large tables. `migrate()` creates and analyzes only missing ones.
- `migrate()` plans statistics only for tables that existed before it ran: the run that creates a table creates no
  statistics for it. Captured on an empty database: the first `migrate()` created both tables and no statistics, the
  second created the two objects. Run `migrate()` twice on a fresh database, or `ensureCreated()` once.
- PostgreSQL refuses statistics on ONE plain column (`extended statistics require at least 2 columns`). `withKinds()`
  with a single entry is refused by the schema manager before any SQL (`… sets kinds (…) with a single ON entry`), as
  PostgreSQL would refuse it.
- `withExpression()` takes raw SQL or the [index expression builders](#index-an-expression-the-queries-use-withexpression-and-ixlower).
  A builder that renders one function call (`e => lower(e.email)` → `ON lower("email")`) is accepted by PostgreSQL 18
  but is a syntax error in the in-memory database; for tests in memory write it as raw SQL in parentheses:
  `` .withExpression(`(lower("email"))`) ``.
- Not de-duplicated: every construction of the context registers its objects again, and the next `ensureCreated()`
  sends each CREATE + ANALYZE pair once per registration.

## Enforce row rules: `hasCheckConstraint()`

`hasCheckConstraint(name, expression)` declares a table CHECK constraint. The expression is raw SQL over quoted
database column names. Use it for invariants PostgreSQL must enforce: ranges, a conditional NOT NULL across two
columns, allowed combinations.

```ts
// fragment
model.entity(Order, entity => {
  // raw SQL over quoted DATABASE column names
  entity.hasCheckConstraint('chk_orders_total_non_negative', '"total_amount" >= 0');
  // a conditional NOT NULL: a discount code needs an amount
  entity.hasCheckConstraint('chk_orders_discount_amount', '"discount_code" IS NULL OR "discount_amount" IS NOT NULL');
});

await db.orders.insert({ userId: 1, status: 'pending', totalAmount: 10, discountCode: 'SPRING' });
// error: new row for relation "orders" violates check constraint "chk_orders_discount_amount"
```

```sql
SELECT con.conname
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
AND c.relname = $2
AND con.contype = 'c'
-- params: [ "public", "orders" ]

SELECT con.conname
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
AND c.relname = $2
AND con.contype = 'c'
-- params: [ "public", "orders" ]

ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_total_non_negative" CHECK ("total_amount" >= 0)

SELECT con.conname
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
AND c.relname = $2
AND con.contype = 'c'
-- params: [ "public", "orders" ]

ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_discount_amount" CHECK ("discount_code" IS NULL OR "discount_amount" IS NOT NULL)

INSERT INTO "orders" ("user_id", "status", "total_amount", "discount_code") VALUES ($1, $2, $3, $4)
-- params: [ 1, "pending", 10, "SPRING" ]
-- error: new row for relation "orders" violates check constraint "chk_orders_discount_amount"
```

- `ensureCreated()` reads the table's CHECK names once per table, and once more before each constraint it adds (the 5
  statements above for two constraints, 1 on later runs). PostgreSQL validates existing rows in the `ALTER`: fix
  violating rows first.
- Reconciled by NAME only: rename a constraint to change it.

## Partition a large table: `hasPartitioning()`

`hasPartitioning({ strategy, columns })` or `hasPartitioning({ strategy, expression })` makes the table a partitioned
parent (`'range'`, `'list'` or `'hash'`). The model never creates partitions: create and rotate them in
`onMigrationComplete()` or a job. Every partition-key column must be part of the primary key; for column keys this is
checked before the table's `CREATE TABLE` is sent (`its PRIMARY KEY does not include partition-key column(s) …`).

```ts
// fragment
model.entity(OrderEvent, entity => {
  entity.toTable('order_events');
  // every partition-key column must be part of the primary key
  entity.property(e => e.id).hasType(bigint('id')).isPrimaryKey();
  entity.property(e => e.createdAt).hasType(timestamp('created_at')).isPrimaryKey();
  entity.property(e => e.orderId).hasType(integer('order_id')).isRequired();
  entity.property(e => e.payload).hasType(jsonb('payload'));
  entity.hasPartitioning({ strategy: 'range', columns: e => e.createdAt });
});

// the model declares the parent only; create the partitions yourself
protected override async onMigrationComplete(client: DatabaseClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "order_events_2026" PARTITION OF "order_events" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`
  );
}

// a 2025 row has no partition to go to
await db.orderEvents.insert({ id: 2n, createdAt: new Date('2025-05-01T12:00:00Z'), orderId: 1 });   // fails
```

```sql
CREATE TABLE IF NOT EXISTS "order_events" (
  "id" bigint NOT NULL,
  "created_at" timestamp NOT NULL,
  "order_id" integer NOT NULL,
  "payload" jsonb,
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at")

CREATE TABLE IF NOT EXISTS "order_events_2026" PARTITION OF "order_events" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')

INSERT INTO "order_events" ("id", "created_at", "order_id") VALUES ($1, $2, $3)
-- params: [ "2n", "2025-05-01T12:00:00.000Z", 1 ]
-- error: no partition of relation "order_events" found for row
```

(`"2n"` is how the capture prints the JS `bigint` 2n.)

- Composite keys: `columns: e => [e.region, e.createdAt]`. Expression keys:
  `expression: "date_trunc('month', created_at)"` (raw SQL, not checked against the primary key).
- `migrate()` never changes the partitioning of an existing table.

## Store a fixed set of labels: `pgEnum()` and `enumColumn()`

`pgEnum(name, labels)` declares a PostgreSQL ENUM type; `enumColumn(column, enumDef)` gives a column that type. The
TypeScript union comes from the entity property, not from `pgEnum()`: `pgEnum()` returns an `EnumTypeDefinition`
whose `values` is `string[]`, so `EnumValues<typeof def>` is `string` and `enumColumn()` builds a
`ColumnBuilder<string>`. Declare the labels once as a `const` tuple and derive both from it:

```ts
// fragment
import { pgEnum, enumColumn } from 'linkgress-orm';

// one const tuple: the TypeScript union AND the PostgreSQL labels
export const ORDER_STATUSES = ['pending', 'processing', 'completed', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// pgEnum() registers the type process-wide the moment this line runs
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);

class Order extends DbEntity {
  id!: DbColumn<number>;
  status!: DbColumn<OrderStatus>;      // the union types queries and inserts
  totalAmount!: DbColumn<number>;
}

model.entity(Order, entity => {
  entity.toTable('orders');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.status)
    .hasType(enumColumn('status', orderStatusEnum))
    .isRequired()
    .hasDefaultValue(`'pending'`);   // SQL text: quote the label
  entity.property(e => e.totalAmount).hasType(decimal('total_amount', 10, 2)).isRequired();
});

const statuses: OrderStatus[] = ['pending', 'processing'];
await db.orders.where(o => inArray(o.status, statuses)).select(o => ({ id: o.id, status: o.status })).toList();
```

```sql
SELECT EXISTS (
SELECT 1 FROM pg_type WHERE typname = $1
) as exists
-- params: [ "order_status" ]

CREATE TYPE "order_status" AS ENUM ('pending', 'processing', 'completed', 'cancelled', 'refunded')

CREATE TABLE IF NOT EXISTS "orders" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "status" order_status NOT NULL DEFAULT 'pending',
  "total_amount" decimal(10, 2) NOT NULL,
  PRIMARY KEY ("id")
)

SELECT "orders"."id" as "id", "orders"."status" as "status"
FROM "orders"
WHERE "orders"."status" IN ($1, $2)
-- params: [ "pending", "processing" ]
```

A value outside the type fails in PostgreSQL: `invalid input value for enum order_status: "shipped"`.

- The registry is process-wide: every schema manager creates EVERY enum `pgEnum()` registered in the process, used by
  its model or not, and `ensureDeleted()` drops every one of them with `CASCADE` (columns of other tables included).
  Captured: a context without enum columns sent `CREATE TYPE "ticket_priority" AS ENUM ('low', 'high')` and later
  `DROP TYPE IF EXISTS "ticket_priority" CASCADE`.
- The existence check reads `pg_type` by name in any schema. Labels are inlined between single quotes without
  escaping: keep `'` out of labels.
- Add labels by appending to the array: `migrate()` sends `ALTER TYPE … ADD VALUE IF NOT EXISTS '…'`, appended last.
  `ensureCreated()` never adds labels to an existing type: it checks the name only. PostgreSQL cannot drop a label;
  do not use `EnumMigrator` for that (its removal path fails on PostgreSQL).

## Compare text case- and accent-insensitively: `pgCollation()`

`pgCollation({ name, provider, locale, deterministic })` declares a collation; `.hasCollation(def)` attaches it to a
column. A nondeterministic ICU collation makes `=` ignore case and accents on that column.

```ts
// fragment
import { pgCollation } from 'linkgress-orm';

// an ICU collation: case- and accent-insensitive equality
export const caseAccentInsensitive = pgCollation({
  name: 'ci_ai',
  provider: 'icu',
  locale: 'und-u-ks-level1',
  deterministic: false,
});

model.entity(Tag, entity => {
  entity.toTable('tags');
  entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
  entity.property(e => e.name).hasType(varchar('name', 100)).isRequired().hasCollation(caseAccentInsensitive);
});

await db.tags.where(t => eq(t.name, 'JAN')).select(t => ({ name: t.name })).toList();
// → [{ name: 'Ján' }]
```

```sql
SELECT EXISTS (
SELECT 1 FROM pg_collation WHERE collname = $1
) as exists
-- params: [ "ci_ai" ]

CREATE COLLATION "ci_ai" (provider = 'icu', locale = 'und-u-ks-level1', deterministic = false)

CREATE TABLE IF NOT EXISTS "tags" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "name" varchar(100) COLLATE "ci_ai" NOT NULL,
  PRIMARY KEY ("id")
)

SELECT "tags"."name" as "name"
FROM "tags"
WHERE "tags"."name" = $1
-- params: [ "JAN" ]
```

- `ensureCreated()` creates collations before tables. `analyze()` reports missing collations and changed column
  collations; `migrate()` sends `CREATE COLLATION IF NOT EXISTS` and `ALTER TABLE … ALTER COLUMN … TYPE … COLLATE "…"`;
  a `MigrationScaffold` file gets `CREATE COLLATION IF NOT EXISTS` (and `DROP COLLATION IF EXISTS` in `down`).
- The registry is process-wide like `pgEnum()`'s. `ensureDeleted()` does not drop collations.
- PGlite has no ICU collations. For substring and prefix search use [`ixNormalized()`](#search-case--and-accent-insensitively-ixnormalized)
  and the normalized helpers; the collation serves equality and ordering.

## Convert column values: `createCustomType()` and `hasCustomMapper()`

`createCustomType<{ data; driverData }>({ dataType, toDriver, fromDriver, immutable? })` builds a column mapper
(`TypeMapper`); attach it with `.hasCustomMapper(mapper)` (or the builder's `.mapWith(mapper)`). `toDriver` runs on
every bound value (inserts, updates, conditions), `fromDriver` on every read (rows, projections, navigations,
collections, `.returning()`). `dataType()` returns the SQL type NAME, which replaces the builder's type in the DDL.

```ts
// fragment
import { createCustomType, applyFromDriver, eq, sql } from 'linkgress-orm';
import type { TypeMapper } from 'linkgress-orm';

export interface HourMinute {
  hour: number;
  minute: number;
}

// minutes since midnight in a smallint column <-> { hour, minute } in the application
export const pgHourMinute: TypeMapper<HourMinute, number> = createCustomType<{ data: HourMinute; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: value => (value == null ? null : value.hour * 60 + value.minute),
  fromDriver: value => (value == null ? null : { hour: Math.floor(value / 60), minute: value % 60 }),
});

class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  publishTime!: DbColumn<HourMinute>;
}

model.entity(Post, entity => {
  // the mapper's dataType() replaces the builder's type in the DDL: integer -> smallint
  entity.property(e => e.publishTime).hasType(integer('publish_time')).hasCustomMapper(pgHourMinute);
});

await db.posts.insertBulk([
  { title: 'Morning', publishTime: { hour: 9, minute: 30 } },
  { title: 'Noon', publishTime: { hour: 12, minute: 0 } },
]);
await db.posts
  .where(p => eq(p.publishTime, { hour: 9, minute: 30 }))
  .select(p => ({ title: p.title, publishTime: p.publishTime }))
  .toList();
// → [{ title: 'Morning', publishTime: { hour: 9, minute: 30 } }]

// raw SQL skips the mapper: apply it yourself
const raw = await db.query<{ publish_time: number }>(sql`SELECT "publish_time" FROM "posts" ORDER BY "id" LIMIT 1`);
applyFromDriver(pgHourMinute, raw[0].publish_time);   // 570 -> { hour: 9, minute: 30 }
```

```sql
CREATE TABLE IF NOT EXISTS "posts" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "title" varchar(200) NOT NULL,
  "publish_time" smallint,
  PRIMARY KEY ("id")
)

INSERT INTO "posts" ("title", "publish_time") VALUES ($1, $2), ($3, $4)
-- params: [ "Morning", 570, "Noon", 720 ]

SELECT "posts"."title" as "title", "posts"."publish_time" as "publishTime"
FROM "posts"
WHERE "posts"."publish_time" = $1
-- params: [ 570 ]

SELECT "publish_time" FROM "posts" ORDER BY "id" LIMIT 1
```

A mapped column of a collection's item (since 1.0.31): a value compared directly with the bare column inside the
collection's `where()` binds through `toDriver`, and the collection's `min()` / `max()` of the bare column read through
`fromDriver`. On the docs model, `u.posts!.where(p => eq(p.publishTime, { hour: 9, minute: 30 })).exists()` binds `570`
and `u.posts!.max(p => p.customDate)` reads a `Date`; before 1.0.31 the object was bound as written and the stored
number came back. An expression over an item column keeps no mapper (`gt(add(p.publishTime, 60), 1000)` inside the
collection binds `60` and `1000` as written), and `sum()` / `count()` read numbers. Collections in queries:
[Querying](./querying.md).

Helpers: `applyToDriver(mapper, value)`, `applyFromDriver(mapper, value)`, `applyFromDriverArray(mapper, values)`,
`identityMapper`.

> **Pitfall:** `customType()` and the converters built with it (`jsonType()`, `array()`, `enumType()`, `point()`,
> `vector()`, `interval()`) are for EXPRESSIONS (`` sql`…`.mapWith(type) ``, casts), see
> [SQL Expression Helpers](./sql-expressions.md). Passed to `hasCustomMapper()` they do not compile (TS2345), and
> through `as any` they throw `TypeError: mapper.dataType is not a function`. Column mappers come from
> `createCustomType()`.

### Share mapped values across rows: `immutable: true`

A type whose mapped values are never mutated (Temporal values, primitives, frozen objects) can declare
`immutable: true`. linkgress then calls its `fromDriver` once per distinct driver value of a column within one result
set and hands every row with that value the SAME mapped value. An expensive `fromDriver` (a Temporal parse, a date
library) runs once per distinct value instead of once per row.

```ts
// fragment: a frozen value object read from an integer column of days since 1970-01-01, shared per result set
export interface CalendarDay {
  readonly iso: string;
}
export const pgCalendarDay = createCustomType<{ data: CalendarDay; driverData: number }>({
  dataType: () => 'integer',
  toDriver: value => (value == null ? null : Math.round(Date.parse(value.iso) / 86_400_000)),
  fromDriver: value => (value == null ? null : Object.freeze({ iso: new Date(value * 86_400_000).toISOString().slice(0, 10) })),
  immutable: true,
});

entity.property(e => e.publishDay).hasType(integer('publish_day')).hasCustomMapper(pgCalendarDay);

const days = await db.posts.select(p => ({ id: p.id, day: p.publishDay })).toList();
// 3 rows with one distinct publish_day: fromDriver ran once; days[0].day === days[2].day
```

```sql
SELECT "posts"."id" as "id", "posts"."publish_day" as "day"
FROM "posts"
```

With Temporal (a runtime or polyfill that provides it):

```ts
// fragment: needs Temporal
const EPOCH = Temporal.PlainDate.from('1970-01-01');

// An integer column of days since 1970-01-01
export const epochDay = createCustomType<{ data: Temporal.PlainDate; driverData: number }>({
  dataType: () => 'integer',
  toDriver: value => (value == null ? null : EPOCH.until(value).days),
  fromDriver: value => (value == null ? null : EPOCH.add({ days: value })),
  immutable: true,
});

// The client hands this mapper the timestamp's text ('2026-09-28 10:00:00'): a text pass-through parser for 1114
export const plainDateTime = createCustomType<{ data: Temporal.PlainDateTime; driverData: string }>({
  dataType: () => 'timestamp',
  toDriver: value => (value == null ? null : value.toString().replace('T', ' ')),
  fromDriver: value => (value == null ? null : Temporal.PlainDateTime.from(value.replace(' ', 'T'))),
  immutable: true,
});
```

What is shared, and when:

- The key is the driver value when it is a string, a number, a bigint or a boolean. NULL / undefined and any other
  driver value (a `Date`, a `Buffer`, an array, a parsed json document) go through `fromDriver` every time, as without
  the flag; so does `-0`. Under a driver's default parsing a `timestamp` arrives as a `Date`, which is never shared
  (and a mapper written for the text fails on it): `plainDateTime` above needs a text pass-through parser for
  `timestamp` (node-postgres `pg.types.setTypeParser(1114, v => v)` or a pool's `types`, postgres.js `types`, PGlite
  `parsers`; see [Get the values the query reads on its own](./batching-and-prepared-queries.md#get-the-values-the-query-reads-on-its-own)).
- Within ONE result set (one query execution, one `QueryBatch` branch, one collection's items across its parent rows)
  and within one column: each value a projection reads through the type keeps its own memo. Never across queries,
  statements, batch branches or executions of one future or prepared query.
- Every read path: plain selects, navigation columns and navigation rows projected whole, nested objects, collections,
  `QueryBatch`, futures, prepared queries, grouped queries (keys, `min` / `max`) and their joins, unions, CTEs,
  `agg.arrayAgg()` elements, table `toList()`, and every mutation's `.returning()`.
- Bounded: at most 1,024 distinct values per column and result set. A column whose first distinct values bring no
  repeat stops sharing after 128 of them, or, for a result set of N values, after N / 2 (at most 1,024); where the count
  is not known (a collection nested in another's items, an `agg.arrayAgg()` list), after 128. An all-distinct column
  costs that many lookups, then nothing. A column that fills the 1,024 with fewer repeats than distinct values stops
  too; one with at least as many keeps what it holds. A result set of fewer than two values reads through the type
  itself.
- `customType({ …, immutable: true })` takes the flag too, and so does a hand-written mapper object
  (`TypeMapper.immutable`). An expression reads through such a type with `.mapWith(type)`; an inline function mapper
  (`.mapWith(fn)`) never shares.
- A `fromDriver` that throws fails the read as it always did.

Declare it only for values nothing mutates: sharing makes equal values IDENTICAL. Mutating one changes every row that
holds it, and code that tells values apart by identity (`===`, a `Set` / `Map` / `WeakMap` keyed by them) sees one value
where it saw several. Default: off.

## Number documents: model sequences and `runtimeSequence()`

| Need | Use | Created by | Statements per draw |
|---|---|---|---|
| A business number (orders, invoices) | a model sequence: getter + `this.sequence(…)` + `setupSequences()` | the schema manager | 1: `SELECT nextval($1::regclass)` |
| A counter several tables share | a model sequence as the column default `nextval('…')` | the schema manager | 0 extra: drawn inside the INSERT |
| One counter per tenant or period, named at run time | `db.runtimeSequence(config).nextValueCreatingIfMissing()` | the first draw | 1; the first draw 3 (one fails) |
| A row key | an [identity column](#generate-primary-keys-identity-columns) | the table | 0 extra |

```ts
// fragment
import { DbSequence, sequence } from 'linkgress-orm';

export class AppDatabase extends DbContext {
  // a model sequence: declared once, created by the schema manager
  get orderNumberSeq(): DbSequence {
    return this.sequence(sequence('order_number_seq').startWith(1000).incrementBy(1).build());
  }

  get customerCodeSeq(): DbSequence {
    return this.sequence(sequence('customer_code_seq').inSchema('public').startWith(100).incrementBy(5).cache(20).build());
  }

  // touch every sequence getter here: a getter registers its sequence when first read
  protected override setupSequences(): void {
    this.orderNumberSeq;
    this.customerCodeSeq;
  }
  // … table getters, setupModel()
}

const orderNumber = await db.orderNumberSeq.nextValue();          // 1000
await db.orders.insert({ orderNumber: `ORD-${orderNumber}` });
await db.orderNumberSeq.currentValue();                           // 1000: currval() of THIS session
await db.orderNumberSeq.resync(5000);
await db.orderNumberSeq.nextValueBigInt();                        // 5001n
db.customerCodeSeq.getQualifiedName();                            // '"public"."customer_code_seq"'
db.customerCodeSeq.getConfig();                                   // { name, schema, startWith, incrementBy, cache }
```

```sql
SELECT EXISTS (
SELECT 1 FROM information_schema.sequences
WHERE sequence_name = $1 AND sequence_schema = 'public'
) as exists
-- params: [ "order_number_seq" ]

CREATE SEQUENCE "order_number_seq" START WITH 1000 INCREMENT BY 1

SELECT EXISTS (
SELECT 1 FROM information_schema.sequences
WHERE sequence_schema = $1 AND sequence_name = $2
) as exists
-- params: [ "public", "customer_code_seq" ]

CREATE SEQUENCE "public"."customer_code_seq" START WITH 100 INCREMENT BY 5 CACHE 20

SELECT nextval($1::regclass) as value
-- params: [ "\"order_number_seq\"" ]

INSERT INTO "orders" ("order_number") VALUES ($1)
-- params: [ "ORD-1000" ]

SELECT currval($1::regclass) as value
-- params: [ "\"order_number_seq\"" ]

SELECT setval($1::regclass, $2, true)
-- params: [ "\"order_number_seq\"", "5000" ]

SELECT nextval($1::regclass) as value
-- params: [ "\"order_number_seq\"" ]
```

- A getter that `setupSequences()` does not touch registers its sequence only when first read, so a schema manager
  that ran before that never created it. Captured: the first draw failed with SQLSTATE 42P01 (PostgreSQL:
  `relation "invoice_no_seq" does not exist`; the in-memory engine doubles the quotes), and the next `ensureCreated()`
  created the sequence.
- `sequence(name)` builder: `inSchema()`, `startWith()`, `incrementBy()` (default 1), `minValue()`, `maxValue()`,
  `cache()`, `cycle()`, `build()`. Each numeric option is an integer within `bigint` (a number, or a JS `bigint` beyond
  2^53).
- `nextValue()`, `currentValue()` and `nextValueCreatingIfMissing()` return a JS number, exact within ±(2^53 − 1);
  beyond it they throw a `RangeError`, never a rounded number (a drawn value is consumed all the same). The `…BigInt()`
  variants return every int8 exactly. `resync()` takes a `bigint`, or a number within ±(2^53 − 1); anything else (2^53
  and beyond, a fraction, NaN) throws a `RangeError` before any SQL.
- `currentValue()` is PostgreSQL's `currval()`: the value THIS session drew. On a pool the next statement may run on
  another connection; read it in the same transaction as the draw.
- Model sequences are created by `ensureCreated()` and `migrate()`; `ensureDeleted()` drops them.

A counter shared by two tables is a model sequence as the column default:

```ts
// fragment
get documentNoSeq(): DbSequence {
  return this.sequence(sequence('document_no_seq').startWith(1).build());
}

protected override setupSequences(): void {
  this.documentNoSeq;
}

// inside setupModel(model)
model.entity(Order, entity => {
  entity.toTable('orders');
  entity.property(e => e.documentNo).hasType(bigint('document_no').primaryKey()).hasDefaultValue(`nextval('document_no_seq')`);
  entity.property(e => e.note).hasType(varchar('note', 100)).isRequired();
});
model.entity(Cart, entity => {
  entity.toTable('carts');
  entity.property(e => e.documentNo).hasType(bigint('document_no').primaryKey()).hasDefaultValue(`nextval('document_no_seq')`);
  entity.property(e => e.uuid).hasType(varchar('uuid', 36)).isRequired();
});

await db.orders.insert({ note: 'first' }).returning(o => ({ documentNo: o.documentNo }));   // → { documentNo: '1' }
await db.carts.insert({ uuid: '6f1c…' }).returning(c => ({ documentNo: c.documentNo }));    // → { documentNo: '2' }
```

```sql
CREATE SEQUENCE "document_no_seq" START WITH 1 INCREMENT BY 1

CREATE TABLE IF NOT EXISTS "orders" (
  "document_no" bigint NOT NULL DEFAULT nextval('document_no_seq'),
  "note" varchar(100) NOT NULL,
  PRIMARY KEY ("document_no")
)

CREATE TABLE IF NOT EXISTS "carts" (
  "document_no" bigint NOT NULL DEFAULT nextval('document_no_seq'),
  "uuid" varchar(36) NOT NULL,
  PRIMARY KEY ("document_no")
)

INSERT INTO "orders" ("note") VALUES ($1) RETURNING "document_no" AS "documentNo"
-- params: [ "first" ]
```

### Name a sequence at run time: `runtimeSequence()`

A sequence whose name is computed at run time (one per tenant and year, say) is declared by no model.
`db.runtimeSequence(config)` returns a `DbSequence` for it; `nextValueCreatingIfMissing()` creates it on first use
(`nextValueCreatingIfMissingBigInt()` returns an exact `bigint`).

```ts
// fragment: tenantId = 7, year = 2026
const docNo = db.runtimeSequence({ name: `doc_no_${tenantId}_${year}`, startWith: 1, incrementBy: 1, minValue: 1, cache: 1 });
await docNo.nextValueCreatingIfMissing();   // 1: creates the sequence
await docNo.nextValueCreatingIfMissing();   // 2
```

```sql
SELECT nextval($1::regclass) as value
-- params: [ "\"doc_no_7_2026\"" ]
-- error: relation ""doc_no_7_2026"" does not exist

CREATE SEQUENCE IF NOT EXISTS "doc_no_7_2026" START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1

SELECT nextval($1::regclass) as value
-- params: [ "\"doc_no_7_2026\"" ]

SELECT nextval($1::regclass) as value
-- params: [ "\"doc_no_7_2026\"" ]
```

The first `nextval` fails with SQLSTATE 42P01. PostgreSQL's message reads `relation "doc_no_7_2026" does not exist`;
the doubled quotes above are the in-memory engine's.

- The CREATE runs only on SQLSTATE 42P01. A concurrent first use that loses the race to create the sequence still
  draws: its CREATE fails with 23505 or 42P07 (or 42710), which are swallowed. Any other error propagates, and the
  second `nextval` is not retried.
- Not registered: the schema manager never creates, compares or drops a runtime sequence.
- The name is an identifier, never SQL: quoted (a `"` doubled, a NUL refused) and schema-qualified when `schema` is
  set. The options are inlined in the DDL, so each must be an integer within `bigint` (a number, a JS `bigint` or an
  integer string); anything else throws a `TypeError` when `runtimeSequence()` is called, before any SQL
  (`sequence "x": startWith must be an integer within bigint, got 1.5`).
- Its statements go to the client directly and are not logged, like `nextValue()`.
- Bound to the context's ROOT client, also when called on a transaction's context: a CREATE inside the caller's
  transaction would be undone by its rollback, and a failed first `nextval` would abort it. Call it on the root
  context, outside `transaction()`.

### Sequences inside `transaction()`

| On `tx` inside `db.transaction(async tx => …)` | Model sequence (`tx.orderNumberSeq`) | Runtime sequence (`tx.runtimeSequence(…)`) |
|---|---|---|
| Bound to | the transaction's client: `tx` has its own instance | the context's ROOT client |
| Statements run | inside the transaction, on its connection | on a second pool connection, outside the transaction |
| `currval()` / `lastval()` in the transaction | the value just drawn | not set by the draw |
| The transaction's session state (`SET LOCAL search_path`, …) | applies | does not apply |
| In a `READ ONLY` transaction | the draw is refused (25006), like any write | draws |
| A failed draw (an exhausted sequence, …) | aborts the transaction | leaves the transaction untouched |
| Connections needed | none beyond the transaction's | one more per call: concurrent transactions can exhaust the pool (a `pg.Pool` waits forever by default); draw before the transaction, or keep the pool larger than the number of concurrent drawing transactions and set `connectionTimeoutMillis` |
| PGlite (one session) | works | refused at once |
| Rollback of the transaction | the drawn value stays consumed | the drawn value stays consumed; a CREATE survives |
| `nextValueCreatingIfMissing()`, sequence missing | probed in the transaction (`to_regclass`, never aborts it), CREATEd on the ROOT client (a second connection; survives a rollback; PGlite refuses it), then drawn in the transaction | the steps above, on the root client |

```ts
// fragment
await db.transaction(async tx => {
  const n = await tx.orderNumberSeq.nextValue();   // on the transaction's connection
  await tx.orders.insert({ orderNumber: `ORD-${n}` });
});
```

```sql
SELECT nextval($1::regclass) as value
-- params: [ "\"order_number_seq\"" ]

INSERT INTO "orders" ("order_number") VALUES ($1)
-- params: [ "ORD-5002" ]
```

Sequences are not transactional: a value drawn in a transaction that rolls back is never handed out again, and
`resync()` (`setval`) is not undone by the rollback. `tx`'s instance belongs to the transaction, like `tx`'s tables:
kept past the callback, its statements are refused with `TransactionEndedError`. Use `db.<sequence>` outside the
transaction. (Before 1.0.11 a model sequence reached through `tx` was the root's instance.) For numbering many rows in
one INSERT, see [Inserts, Updates, Upserts and Deletes](./insert-update-guide.md).

## Expose a read-only view: `model.view()`

`model.view(Class, v => …)` declares a database VIEW the schema manager creates and keeps in sync; `this.view(Class)`
exposes it as a `DbViewTable`, the read surface of a table (`toList`, `first`, `firstOrDefault`, `count`, `exists`,
`where`, `select`, `selectDistinct`, `orderBy`, `limit`, `offset`, `with`, `leftJoin`, `innerJoin`, `getColumns`,
`getColumnKeys`, `props`, and since 1.0.30 `selectFromCte`, `selectFromSet`, `isInTransaction`, `getClient`). Define it
with SQL text or with a linkgress query.

```ts
// fragment
// a view class declares columns only: no keys, indexes or navigations
class UserOrderTotal extends DbEntity {
  userId!: DbColumn<number>;
  total!: DbColumn<number>;
}

class ActiveUserStat extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  orderCount!: DbColumn<number>;
}

export class AppDatabase extends DbContext {
  get userOrderTotals(): DbViewTable<UserOrderTotal> { return this.view(UserOrderTotal); }
  get activeUserStats(): DbViewTable<ActiveUserStat> { return this.view(ActiveUserStat); }

  protected override setupModel(model: DbModelConfig): void {
    // … users and orders
    // a view from SQL text: its column aliases must match the hasType() column names
    model.view(UserOrderTotal, view => {
      view.toView('user_order_totals');
      view.definedAs(`SELECT o."user_id", SUM(o."total_amount") AS "total" FROM "orders" o GROUP BY o."user_id"`);
      view.property(e => e.userId).hasType(integer('user_id'));
      view.property(e => e.total).hasType(decimal('total', 12, 2));
    });

    // a view from a linkgress query: checked by the compiler, bound values inlined as literals
    model.view(ActiveUserStat, view => {
      view.toView('active_user_stats');
      view.definedAs((db: AppDatabase) => db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({
          id: u.id,
          username: u.username,
          orderCount: sql<number>`${u.orders!.count()}::int`,
        })));
      view.property(e => e.id).hasType(integer('id'));
      view.property(e => e.username).hasType(varchar('username', 100));
      view.property(e => e.orderCount).hasType(integer('order_count'));
    });
  }
}

await db.userOrderTotals.where(t => gt(t.total, 10)).toList();
// → [{ userId: 1, total: '99.99' }, { userId: 2, total: '149.99' }]   (decimal: a string)
await db.activeUserStats.select(s => ({ username: s.username, orderCount: s.orderCount })).toList();
// → [{ username: 'alice', orderCount: 1 }, { username: 'bob', orderCount: 1 }]   (charlie is inactive)
```

```sql
DROP VIEW IF EXISTS "active_user_stats"

DROP VIEW IF EXISTS "user_order_totals"

CREATE VIEW "user_order_totals" AS SELECT o."user_id", SUM(o."total_amount") AS "total" FROM "orders" o GROUP BY o."user_id"

COMMENT ON VIEW "user_order_totals" IS 'linkgress:view:sha256:31adaf4f1f466b486a3c37f163ee9c28da3ddd5e11e4117d376f2b9e28f48fd2'

CREATE VIEW "active_user_stats" AS SELECT "q"."id" AS "id", "q"."username" AS "username", "q"."orderCount" AS "order_count" FROM (SELECT "users"."id" as "id", "users"."username" as "username", (SELECT COUNT(*) FROM "orders" "orders__count"
WHERE "orders__count"."user_id" = "users"."id")::int as "orderCount"
FROM "users"
WHERE "users"."is_active" = 'true') AS "q"

COMMENT ON VIEW "active_user_stats" IS 'linkgress:view:sha256:f4f1a8300f6e59d8e4700dae4c9d5f5a061f4e32b4cbcf9d4b84bb1fd2eb4f99'

SELECT "user_order_totals"."user_id" as "userId", "user_order_totals"."total" as "total"
FROM "user_order_totals"
WHERE "user_order_totals"."total" > $1
-- params: [ 10 ]

SELECT "active_user_stats"."username" as "username", "active_user_stats"."order_count" as "orderCount"
FROM "active_user_stats"
```

- `ensureCreated()` drops and re-creates EVERY view on every call, after the tables: 3 statements per view
  (`DROP VIEW IF EXISTS`, `CREATE VIEW`, `COMMENT ON VIEW`; a view with `toSchema()` adds `CREATE SCHEMA IF NOT
  EXISTS`). `ensureDeleted()` drops views first (`DROP VIEW IF EXISTS … CASCADE`). `migrate()` reads the
  `linkgress:view:sha256:<hash>` marker and re-creates a view only when its definition's hash changed, when it is
  missing, or when the migration alters a column (PostgreSQL refuses a column type change under a dependent view, so
  every managed view is then dropped first and re-created last). A migration that only adds tables or columns leaves
  the views alone.
- Declare a view AFTER the views it reads: a view that is dropped takes every view declared after it along (dropped
  before it, re-created after it). Removing a view from the model does not drop it: drop it in a migration.
- A re-create is `DROP VIEW` + `CREATE VIEW`: privileges granted on the view, a changed owner and any comment other than
  the marker are lost. Give read-only roles access through `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES` for the
  migrating role (views count as tables there), or re-grant in `onMigrationComplete()`.
- `update()` / `delete()` on a query over a view throw before any SQL: `Cannot delete from "user_order_totals": it is a
  model-managed view (read-only)`.
- Query-defined views: the projection's keys are the view's property names; the compiler checks that every property is
  projected, and at render time a missing, extra or nested key is refused by name. The context renders the query when a
  schema manager needs it: the projection is renamed to the column names in declaration order (`orderCount` →
  `order_count`), and bound values are inlined as SQL literals (`'true'` above): a view has no parameters, so
  `sql.placeholder()` is refused. Changing the query, a constant included, re-creates the view on the next `migrate()`.
  Array aggregations always render natively, whatever the driver, so the view's SQL does not depend on the client that
  ran the migration. A view can read another view through its `DbViewTable`; declare it after that view.

A view that joins the way hand-written SQL does (on a computed key) uses an explicit join. The joined row's navigations
and collections work like the root's: a navigation renders as a LEFT JOIN off the join's alias (`orders_0__user`,
also for an `isRequired()` navigation such as `Order.user`), a collection correlates to that alias. To keep a count
`integer` (`COUNT(*)` is `bigint`), cast it in a fragment:

```ts
// fragment: inside setupModel(model); the context exposes it as get commentedOrders(): DbViewTable<CommentedOrder>
class CommentedOrder extends DbEntity {
  commentId!: DbColumn<number>;
  customer!: DbColumn<string>;
  orderTaskCount!: DbColumn<number>;
  taskIds!: DbColumn<number[]>;
}

model.view(CommentedOrder, view => {
  view.toView('commented_orders');
  view.definedAs((db: AppDatabase) => db.postComments
    .innerJoin(db.orders, (comment, order) => eq(order.id, comment.orderId), (comment, order) => ({
      commentId: comment.id,
      customer: order.user!.username,                                    // a navigation of the joined order
      orderTaskCount: sql<number>`${order.orderTasks!.count()}::int`,   // a collection of it, cast to integer
      taskIds: order.orderTasks!.orderBy(t => t.taskId).select(t => ({ taskId: t.taskId })).toNumberList(),
    })));
  view.property(e => e.commentId).hasType(integer('comment_id'));
  view.property(e => e.customer).hasType(varchar('customer', 100));
  view.property(e => e.orderTaskCount).hasType(integer('order_task_count'));
  view.property(e => e.taskIds).hasType(integer('task_ids').array());
});

await db.commentedOrders.toList();
// → [{ commentId: 1, customer: 'alice', orderTaskCount: 1, taskIds: [1] }, { commentId: 2, customer: 'bob', … }, …]
```

```sql
CREATE VIEW "commented_orders" AS SELECT "q"."commentId" AS "comment_id", "q"."customer" AS "customer", "q"."orderTaskCount" AS "order_task_count", "q"."taskIds" AS "task_ids" FROM (SELECT "post_comments"."id" as "commentId", "orders_0__user"."username" as "customer", (SELECT COUNT(*) FROM "order_task" "orderTasks__count"
WHERE "orderTasks__count"."order_id" = "orders_0"."id")::int as "orderTaskCount", (SELECT COALESCE(array_agg("task_id" ORDER BY "lateral_0_orderTasks"."task_id" ASC), '{}')
FROM "order_task" "lateral_0_orderTasks"
WHERE "lateral_0_orderTasks"."order_id" = "orders_0"."id") as "taskIds"
FROM "post_comments"
INNER JOIN "orders" AS "orders_0" ON "orders_0"."id" = "post_comments"."order_id"
LEFT JOIN "users" AS "orders_0__user" ON "orders_0"."user_id" = "orders_0__user"."id") AS "q"
```

Put a join whose ON clause reads another join after it. Each join's selector sees the previous join's projection as
FLAT values, so project what later joins need (keys, finished columns) and list the view's columns in the last
selector.

## Map a table another system owns: `isExternallyManaged()`

`isExternallyManaged()` marks a table another team, an ETL job or a warehouse owns. The schema manager creates it only
when it is missing (a fresh or test database) and never compares or alters an existing one: no column, index,
statistics, CHECK or foreign-key operation. The model must still name the real columns.

```ts
// fragment
class SkiRun extends DbEntity {
  id!: DbColumn<string>;        // bigint: read as a string
  userId!: DbColumn<string>;
  km?: DbColumn<string>;        // numeric: read as a string
}

model.entity(SkiRun, entity => {
  entity.toTable('ski_runs');
  entity.toSchema('dwh');
  entity.isExternallyManaged();
  entity.property(e => e.id).hasType(bigint('id')).isPrimaryKey();
  entity.property(e => e.userId).hasType(bigint('user_id')).isRequired();
  entity.property(e => e.km).hasType(numeric('km'));
  entity.hasIndex('ix_ski_runs_user', e => [e.userId]);
});

await db.skiRuns.where(r => eq(r.userId, '7')).toList();   // → [{ id: '1', userId: '7', km: '12.5' }]
```

```sql
CREATE SCHEMA IF NOT EXISTS "dwh"

SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
-- params: [ "dwh" ]

SELECT "ski_runs"."id" as "id", "ski_runs"."user_id" as "userId", "ski_runs"."km" as "km"
FROM "dwh"."ski_runs"
WHERE "ski_runs"."user_id" = $1
-- params: [ "7" ]
```

The existing table got no `CREATE TABLE` and no `CREATE INDEX`; `ensureCreated()` paid one existence query per model
schema. `migrate()` skips the table's catalog reads.

> **Pitfall:** `ensureDeleted()` ignores the flag: it sent `DROP TABLE IF EXISTS "dwh"."ski_runs" CASCADE` and
> `DROP SCHEMA IF EXISTS "dwh" CASCADE`. Never run it on a context that maps tables it does not own.

## Persist a database setting: `model.hasDbSetting()`

`model.hasDbSetting(name, value)` persists `ALTER DATABASE <current> SET name = value`: every NEW session on the
database inherits it. Use it for settings every environment must share (`jit`, custom `app.*` parameters).

```ts
// fragment
protected override setupModel(model: DbModelConfig): void {
  // persisted with ALTER DATABASE: every new session inherits it
  model.hasDbSetting('jit', false);
  // … entities
}
```

```sql
SELECT entry
FROM pg_db_role_setting, LATERAL unnest(setconfig) AS entry
WHERE setrole = 0
AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())

DO $lnk_dbset$ BEGIN EXECUTE format('ALTER DATABASE %I SET %s = %L', current_database(), 'jit', 'off'); END $lnk_dbset$
```

- `ensureCreated()` and `migrate()` read the database's settings (1 statement) and send one `DO` block per missing or
  drifted setting; a later run with the setting in place sent only the read.
- Values: strings pass through verbatim (`'off'`, `'32MB'`, `'UTC'`), booleans become `on` / `off`, numbers their
  decimal text. Names: a core parameter (`jit`) or a two-part custom one (`app.tenant_mode`).
- Converge-only: removing the declaration never RESETs the value. The migrating role must own the database (or be a
  superuser). Pooled connections keep the old value until they reconnect.

## Inspect the model at run time: `getColumns()`, `getColumnKeys()`, `props()`

The table accessors describe the MODEL (not the live database) without SQL. Use them for generic code: exports,
audits, dynamic projections.

```ts
// fragment: users with id (identity), username (unique), email, and the collection posts
db.users.getColumns().map(c => `${c.propertyName} -> "${c.columnName}" ${c.type}`);
// → ['id -> "id" integer', 'username -> "username" varchar', 'email -> "email" text']
//   each ColumnInfo also has isPrimaryKey, isAutoIncrement, isNullable, isUnique, defaultValue
db.users.getColumns({ includeNavigation: true }).filter(c => c.isNavigation);
// → [{ propertyName: 'posts', type: 'collection', navigationType: 'many', targetTable: 'posts', … }]
db.users.getColumnKeys({ includePrimaryKey: false });   // → ['username', 'email']
Object.keys(db.users.props());                          // → ['id', 'username', 'email']
```

`getColumnKeys()` is typed `ExtractDbColumnKeys<User>[]`. `props()` returns the column references a selector receives;
`props({ excludeNavigation: false })` returns the whole row a selector receives, navigations included, whose
properties are not enumerable (`Object.keys()` gives `[]`). `EntityMetadataStore` (static, keyed by entity class)
holds the raw metadata every context of the process is built from.

## Complete example: the core of the docs' model

The other guides query this model. The repository's
[`debug/schema/appDatabase.ts`](https://github.com/brunolau/linkgress-orm/blob/main/debug/schema/appDatabase.ts) adds
`postComments`, `products`, `productPrices`, `productTags`, `tags`, `carts`, `cartItems` and test-only tables; every
table, column, relation, index and seed row of the full model is in [Example Model and Seed Data](../example-model.md).
`ensureCreated()` sends 17 statements for the part below: 4 enum checks and 4 `CREATE TYPE`, 6 tables, 3 indexes.

```ts
// fragment: self-contained; enums, a custom mapper, composite keys, required and optional navigations
export interface HourMinute { hour: number; minute: number }

export const pgHourMinute: TypeMapper<HourMinute, number> = createCustomType<{ data: HourMinute; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: value => (value == null ? null : value.hour * 60 + value.minute),
  fromDriver: value => (value == null ? null : { hour: Math.floor(value / 60), minute: value % 60 }),
});

export const orderStatusEnum = pgEnum('order_status', ['pending', 'processing', 'completed', 'cancelled', 'refunded'] as const);
export const postCategoryEnum = pgEnum('post_category', ['tech', 'lifestyle', 'business', 'entertainment'] as const);
export const taskStatusEnum = pgEnum('task_status', ['pending', 'processing', 'completed', 'cancelled'] as const);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high'] as const);

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;
  metadata?: DbColumn<any>;
  posts?: Post[];
  orders?: Order[];
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  subtitle?: DbColumn<string>;
  content?: DbColumn<string>;
  userId!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  views!: DbColumn<number>;
  publishTime!: DbColumn<HourMinute>;
  category!: DbColumn<'tech' | 'lifestyle' | 'business' | 'entertainment'>;
  user?: User;
}

export class Order extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  status!: DbColumn<'pending' | 'processing' | 'completed' | 'cancelled' | 'refunded'>;
  totalAmount!: DbColumn<number>;
  createdAt!: DbColumn<Date>;
  items?: DbColumn<any>;
  user?: User;
  orderTasks?: OrderTask[];
}

export class OrderTask extends DbEntity {
  orderId!: DbColumn<number>;
  taskId!: DbColumn<number>;
  sortOrder?: DbColumn<number>;
  order?: Order;
  task?: Task;
}

export class Task extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  status!: DbColumn<'pending' | 'processing' | 'completed' | 'cancelled'>;
  priority!: DbColumn<'low' | 'medium' | 'high'>;
  levelId?: DbColumn<number>;
  level?: TaskLevel;
}

export class TaskLevel extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  createdById!: DbColumn<number>;
  createdBy?: User;
}

export class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> { return this.table(User); }
  get posts(): DbEntityTable<Post> { return this.table(Post); }
  get orders(): DbEntityTable<Order> { return this.table(Order); }
  get orderTasks(): DbEntityTable<OrderTask> { return this.table(OrderTask); }
  get tasks(): DbEntityTable<Task> { return this.table(Task); }
  get taskLevels(): DbEntityTable<TaskLevel> { return this.table(TaskLevel); }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired().isUnique();
      entity.property(e => e.email).hasType(text('email')).isRequired();
      entity.property(e => e.age).hasType(integer('age'));
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
      entity.property(e => e.metadata).hasType(jsonb('metadata'));
      entity.hasMany(e => e.posts, () => Post).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
      entity.hasMany(e => e.orders, () => Order).withForeignKey(o => o.userId).withPrincipalKey(u => u.id);
    });

    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.subtitle).hasType(varchar('subtitle', 200));
      entity.property(e => e.content).hasType(text('content'));
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.publishedAt).hasType(timestamp('published_at')).hasDefaultValue('NOW()');
      entity.property(e => e.views).hasType(integer('views')).hasDefaultValue(0);
      entity.property(e => e.publishTime).hasType(smallint('publish_time')).hasCustomMapper(pgHourMinute);
      entity.property(e => e.category).hasType(enumColumn('category', postCategoryEnum)).hasDefaultValue(`'tech'`);
      entity.hasOne(e => e.user, () => User)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id)
        .onDelete('cascade')
        .isRequired();
      entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
    });

    model.entity(Order, entity => {
      entity.toTable('orders');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.status).hasType(enumColumn('status', orderStatusEnum)).hasDefaultValue(`'pending'`);
      entity.property(e => e.totalAmount).hasType(decimal('total_amount', 10, 2)).isRequired();
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
      entity.property(e => e.items).hasType(jsonb('items'));
      entity.hasOne(e => e.user, () => User)
        .withForeignKey(o => o.userId)
        .withPrincipalKey(u => u.id)
        .onDelete('cascade')
        .isRequired();
      entity.hasMany(e => e.orderTasks, () => OrderTask).withForeignKey(ot => ot.orderId).withPrincipalKey(o => o.id);
      entity.hasIndex('IX_Orders_UserId_Status', e => [e.userId, e.status]);
      entity.hasIndex('IX_Orders_CreatedAt', e => [e.createdAt]);
    });

    model.entity(OrderTask, entity => {
      entity.toTable('order_task');
      entity.property(e => e.orderId).hasType(integer('order_id')).isPrimaryKey();
      entity.property(e => e.taskId).hasType(integer('task_id')).isPrimaryKey();
      entity.property(e => e.sortOrder).hasType(integer('sort_order'));
      entity.hasOne(e => e.order, () => Order).withForeignKey(ot => ot.orderId).withPrincipalKey(o => o.id).onDelete('cascade');
      entity.hasOne(e => e.task, () => Task).withForeignKey(ot => ot.taskId).withPrincipalKey(t => t.id).onDelete('cascade');
    });

    model.entity(TaskLevel, entity => {
      entity.toTable('task_levels');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.createdById).hasType(integer('created_by_id')).isRequired();
      entity.hasOne(e => e.createdBy, () => User).withForeignKey(l => l.createdById).withPrincipalKey(u => u.id).onDelete('cascade');
    });

    model.entity(Task, entity => {
      entity.toTable('tasks');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.status).hasType(enumColumn('status', taskStatusEnum)).isRequired();
      entity.property(e => e.priority).hasType(enumColumn('priority', taskPriorityEnum)).isRequired();
      entity.property(e => e.levelId).hasType(integer('level_id'));
      entity.hasOne(e => e.level, () => TaskLevel).withForeignKey(t => t.levelId!).withPrincipalKey(l => l.id).onDelete('cascade');
    });
  }
}
```

The imports are those of the first example plus `smallint`, `decimal`, `pgEnum`, `enumColumn`, `createCustomType` and
the `TypeMapper` type. The repository's file also: passes identity `name` options (never emitted); writes the keys of
`User.posts`, `Post.user` and `Task.level` as `` sql`${…}` `` fragments (the same keys); adds
`.onUpdate('no action').hasDbName('FK_posts_users_user_id')` to `Post.user` (its constraint gains
`ON UPDATE NO ACTION`, PostgreSQL's default); declares the `Post.postComments` collection; and adds three mapped test
columns (`User.lastActiveAt`, `Post.customDate`, `Post.stringStampedAt`).

## Pitfalls

- **Don't** read `!` as NOT NULL → **Do** call `isRequired()`. A `!` column without it was created nullable and
  accepted NULL.
- **Don't** declare table accessors as class fields → **Do** use getters that call `this.table()`. A field is
  `undefined` on the context `db.transaction()` hands you.
- **Don't** construct a context per request → **Do** construct one per client at process start. Each construction
  re-runs `setupModel()` and registers `hasStatistics()` / `hasCheckConstraint()` again (duplicate CREATE STATISTICS +
  ANALYZE on the next `ensureCreated()`).
- **Don't** call `db.ensureCreated()` or `new DbContext(client, schema)` → **Do** call
  `db.getSchemaManager().ensureCreated()` on a subclass of `DbContext` (TS2339 and TS2511 otherwise).
- **Don't** use `this` inside `setupModel()` → **Do** use the `model` argument and module-level values; `this` is a
  stand-in there.
- **Don't** expect two contexts in one process to stay apart → **Do** remember entity metadata and `pgEnum()` /
  `pgCollation()` are process-wide: a schema manager created another context's `users` table and every registered enum.
- **Don't** extend your context class (`class ReportingDatabase extends AppDatabase`) → **Do** derive every context
  from `DbContext`. An inherited getter named like its table made the subclass's constructor throw a `TypeError`.
- **Don't** rename a column with `hasColumnName()` → **Do** pass the name to the builder. Indexes then named a column
  that did not exist (`column "url_slug" does not exist`).
- **Don't** declare an index before its properties → **Do** configure properties first. The early column was left out
  of the index silently, and an index with none failed (`syntax error at or near ")"`).
- **Don't** call `isRequired()` on a navigation with a nullable foreign key → **Do** keep it optional. The INNER JOIN
  dropped the task without a level.
- **Don't** pass a composite key as an array of selectors → **Do** write one selector returning an array:
  `withForeignKey(n => [n.orderId, n.taskId])`.
- **Don't** expect `hasMany()` to create a foreign key → **Do** declare the `hasOne()` on the table holding the key.
- **Don't** forget the index on a foreign-key column a collection filters → **Do** declare one whose first column is
  the key. Neither PostgreSQL nor linkgress creates it: in the example model `post_comments.post_id` (read by
  `Post.postComments`) has no index, while `posts.user_id` is served only because `ix_posts_query` starts with it.
- **Don't** use `ixUnaccent()` in an index → **Do** use `ixNormalized()`. PostgreSQL refuses `unaccent()` in an
  index; the in-memory database accepts `ixLower(ixUnaccent(col))`, so only production fails.
- **Don't** declare a `gin_trgm_ops` / `gist_trgm_ops` index on a plain column and expect `pg_trgm` to appear → **Do**
  run `CREATE EXTENSION IF NOT EXISTS pg_trgm` in `onMigrationStart()`. The schema manager creates it only for
  `ixNormalized(…, { gin: true })`; without it PostgreSQL refused the index.
- **Don't** bind a value inside an index expression → **Do** inline constants with `literal()`. The context
  constructor throws otherwise.
- **Don't** pass a name to `isUnique('uq_users_email')` → **Do** `hasIndex('uq_users_email', e => [e.email]).isUnique()`
  (TS2554).
- **Don't** look for `generatedByDefaultAsIdentity()` or identity `minValue` / `cache` / `cycle` → **Do** use
  `generatedAlwaysAsIdentity({ startWith, incrementBy })`, and a model sequence for the other options.
- **Don't** share a sequence through the identity `name` option → **Do** use a model sequence as the column default
  (`nextval('document_no_seq')`). `name` is never emitted.
- **Don't** mark a key `autoIncrement()` → **Do** use `generatedAlwaysAsIdentity()`. `autoIncrement()` produced a plain
  `integer` column and `insert()` dropped its value.
- **Don't** pass an identity value to `insert()` expecting it written → **Do**
  `insertBulk(rows, { overridingSystemValue: true })`. The value is left out silently.
- **Don't** write `hasDefaultValue('pending')` → **Do** `hasDefaultValue("'pending'")`. The unquoted form rendered
  `DEFAULT pending` and failed (`column "pending" does not exist`).
- **Don't** give a `timestamp` column a `Date` default → **Do** use `timestamptz` or an SQL expression. The value read
  back shifted by the local offset.
- **Don't** expect `insertBulk()` rows without a key to get the default when another row sets it → **Do** set the
  column in every row or in none. The missing cells were bound as NULL.
- **Don't** use `hasDefaultValue()` to enforce a rule → **Do** use `hasCheckConstraint()`.
- **Don't** read `bigint` / `decimal` columns as numbers → **Do** declare them `DbColumn<string>` or attach a mapper.
  All three captured clients returned strings.
- **Don't** return `'decimal(10, 2)'` from a mapper's `dataType()` on `decimal('price', 10, 2)` → **Do** return
  `'decimal'`. The DDL became `decimal(10, 2)(10, 2)`.
- **Don't** pass `customType()` to `hasCustomMapper()` → **Do** use `createCustomType()`.
- **Don't** type a status as `EnumValues<typeof myPgEnum>` → **Do** declare the labels as a `const` tuple and derive
  the union from it (`(typeof LABELS)[number]`). `pgEnum()` returns `values: string[]`, so `EnumValues<…>` is `string`
  and `'shipped'` compiled.
- **Don't** expect the first `migrate()` of a fresh database to create `hasStatistics()` objects → **Do** run
  `migrate()` again (or `ensureCreated()`). The run that creates a table plans no statistics for it.
- **Don't** declare `immutable: true` for values someone mutates → **Do** freeze them or leave the flag off: rows share
  one object.
- **Don't** forget a sequence getter in `setupSequences()` → **Do** touch every one there. An untouched getter
  registered its sequence only when first read, after `ensureCreated()` ran, and its first draw failed (42P01).
- **Don't** call `tx.runtimeSequence()` inside `transaction()` → **Do** draw on the root context before the
  transaction; the call needs a second pool connection, and PGlite refuses it.
- **Don't** expect the model to create partitions → **Do** create them in `onMigrationComplete()` or a job; inserts
  failed with `no partition of relation "order_events" found for row`.
- **Don't** run `ensureDeleted()` on a shared database → **Do** keep it for throwaway databases. It drops externally
  managed tables, every registered enum (CASCADE) and every schema named with `toSchema()` (CASCADE), `public`
  included when a table names it.
- **Don't** rely on `ensureCreated()` to change existing tables, indexes or enum labels → **Do** use `migrate()` or
  migration files ([Migrations and Schema Management](./migrations.md)).

## See also

- [Choosing the Right Query](../choosing-the-right-query.md): which read or write API to use, with SQL shapes and round
  trips.
- [Migrations and Schema Management](./migrations.md): `ensureCreated()`, `migrate()`, `analyze()`, `ensureDeleted()`,
  hooks and migration files that apply this model.
- [Querying](./querying.md): queries over the model: navigations, collections, normalized search.
- [Batching and Prepared Queries](./batching-and-prepared-queries.md): how mapped and driver-parsed values read in a
  batch, the client parsers a text-based mapper needs.
- [Inserts, Updates, Upserts and Deletes](./insert-update-guide.md): identity values, defaults in bulk inserts,
  sequence numbers in one statement.
- [SQL Expression Helpers](./sql-expressions.md): `lower()`, `literal()` and `sql` fragments for index expressions;
  `customType()` converters for expressions.
- [Collection Strategies](../collection-strategies.md): how collections are fetched, and the foreign-key filters they
  run.
- [Configuration and Options](./configuration.md): `QueryOptions`, including the `logger` the schema manager uses.
- [Database Clients](../database-clients.md): the clients, the value types they return, pooling.
- [In-Memory Database](./in-memory-database.md): testing the model without a server, and where it differs from
  PostgreSQL.
- [API Index](../api-index.md): every export, one line each.
