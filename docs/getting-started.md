# Getting Started

> **For agents:** What is the shortest correct path from `npm install` to a typed query that runs?
> **Use this page when:** setting up linkgress-orm in a project, declaring the first entities and context, creating the schema, writing and reading the first rows. **Look elsewhere when:** choosing which query API fits a data need → [Choosing the right query](./choosing-the-right-query.md)
> **Key APIs:** `DbEntity`, `DbColumn<T>`, `DbContext`, `DbModelConfig`, `getSchemaManager().ensureCreated()`, `insert().returning()`, `where()`, `select()`, `toList()` · **Round trips:** constructing a context 0; `ensureCreated()` for this page's model 3 (1 per table, 1 per index); every query on this page 1

linkgress-orm is a type-safe ORM for PostgreSQL and TypeScript: entities are classes, queries are
lambdas, and every query on this page is one SQL statement whose result type TypeScript infers from
the projection.

## Contents

- [The steps at a glance](#the-steps-at-a-glance)
- [Install the package and one driver](#install-the-package-and-one-driver)
- [Declare entities: `DbEntity` and `DbColumn<T>`](#declare-entities-dbentity-and-dbcolumnt)
- [Map entities to tables: a `DbContext` subclass](#map-entities-to-tables-a-dbcontext-subclass)
- [Connect and create the schema](#connect-and-create-the-schema)
- [Insert rows and read generated keys: `insert().returning()`](#insert-rows-and-read-generated-keys-insertreturning)
- [Read typed rows: `where()` + `select()` + `toList()`](#read-typed-rows-where--select--tolist)
- [Load users with their posts in one statement](#load-users-with-their-posts-in-one-statement)
- [Filter and project through a navigation](#filter-and-project-through-a-navigation)
- [Combine conditions: `and()`, `gt()`, `like()`, `coalesce()`](#combine-conditions-and-gt-like-coalesce)
- [Aggregate per group: `select().groupBy().select()`](#aggregate-per-group-selectgroupbyselect)
- [Fetch one row, count, test existence](#fetch-one-row-count-test-existence)
- [Update and delete through `where()`](#update-and-delete-through-where)
- [Pick the next API](#pick-the-next-api)
- [Defaults and switches](#defaults-and-switches)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## The steps at a glance

| Step | Code | Statements sent |
|---|---|---|
| 1. Install | `npm install linkgress-orm pg` | – |
| 2. Declare entities | `class User extends DbEntity { id!: DbColumn<number>; … }` | 0 |
| 3. Map them in a context | `class AppDatabase extends DbContext { … setupModel(model) { … } }` | 0 |
| 4. Connect | `new AppDatabase(new PgClient({ connectionString }))` | 0 |
| 5. Create the schema (development, tests) | `await db.getSchemaManager().ensureCreated()` | 1 per table and per index (3 here) |
| 6. Query | `await db.users.where(…).select(…).toList()` | 1 |

The `User` and `Post` classes below are a subset of the example model every other page uses
([Example Model and Seed Data](./example-model.md)): the same field names and column
names, so code from other pages that reads only these fields runs on this context unchanged. The
full model gives both entities more columns (`metadata`, `lastActiveAt`; `subtitle`, `category`, …)
and adds `orders`, `postComments`, `tasks`, `products`, `tags`, `carts` and more.

## Install the package and one driver

```bash
npm install linkgress-orm pg
```

linkgress-orm declares its drivers as optional peer dependencies; install the one you construct a
client for. `pg` (node-postgres) is used on this page. `postgres` (postgres.js), Bun's built-in
`Bun.SQL` and `@electric-sql/pglite` work with the same context and the same queries — see
[Installation](./installation.md) for the choice and [Database Clients](./database-clients.md) for
what each driver supports.

## Declare entities: `DbEntity` and `DbColumn<T>`

An entity class describes one table's row in TypeScript. A `DbColumn<T>` property is a column; a
property typed as another entity is a navigation (`hasOne`), one typed as an array of entities is a
collection (`hasMany`).

```ts
import { DbColumn, DbEntity } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;

  posts?: Post[];          // collection: hasMany, configured in the context
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  content?: DbColumn<string>;
  userId!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  views!: DbColumn<number>;

  user?: User;             // navigation: hasOne, configured in the context
}
```

- `!` and `?` affect TypeScript only. A column is `NOT NULL` only through `.isRequired()`, the
  column builder's `.notNull()` (`varchar('title', 200).notNull()`) or a primary key in `setupModel`
  (next step).
- Declare navigations and collections optional (`user?: User`, `posts?: Post[]`) and dereference them
  with `!` inside query lambdas: `u.posts!.count()`. Under `strict`, `u.posts.count()` is error TS18048.
- No decorators, no `reflect-metadata`, no code generation: the mapping is written in `setupModel`.

## Map entities to tables: a `DbContext` subclass

`DbContext` is abstract: subclass it, expose every table as a getter that returns
`this.table(Entity)`, and map columns, keys and relations in `setupModel`.

```ts
import { DbContext, DbEntityTable, DbModelConfig, boolean, integer, text, timestamp, varchar } from 'linkgress-orm';
import { Post, User } from './model';

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
```

- The first argument of a column builder is the database column name: `boolean('is_active')` maps
  `isActive` to `"is_active"`.
- `hasOne(...)` creates the `FOREIGN KEY` constraint; `hasMany(...)` alone creates none. Declare both
  sides: `hasOne` for joins from the child, `hasMany` for collections from the parent.
- `.isRequired()` on a navigation makes every join through it an `INNER JOIN`; use it only when the
  foreign key column is `NOT NULL`, or rows without a parent disappear from results.
- String defaults are raw SQL: `hasDefaultValue('NOW()')` emits `DEFAULT NOW()`; a text literal needs
  its quotes, `hasDefaultValue("'pending'")`.

Every option of entities, columns, relations, indexes, enums, views and sequences:
[Schema Configuration](./guides/schema-configuration.md).

## Connect and create the schema

The constructor is `new AppDatabase(client, queryOptions?)`. It runs `setupModel`, opens no
connection and sends no statement. Construct one context per client at process start and reuse it.

```ts
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './app-database';

const client = new PgClient({ connectionString: process.env.DATABASE_URL });
const db = new AppDatabase(client, {
  logQueries: true,        // print every statement (development)
  logParameters: true,     // ...with its parameter values
  logFailedQueries: true,  // report failing statements even when logQueries is off
});

await db.getSchemaManager().ensureCreated();   // creates the missing tables and indexes
```

```sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "username" varchar(100) NOT NULL UNIQUE,
  "email" text NOT NULL,
  "age" integer,
  "is_active" boolean DEFAULT TRUE,
  "created_at" timestamp DEFAULT NOW(),
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

- 3 statements, 3 round trips, no transaction around them. Enums, sequences, check constraints,
  statistics and views of a larger model add statements of their own.
- `ensureCreated()` creates what is missing (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
  EXISTS`). On a table that already exists it adds only what is missing by name (indexes, check
  constraints), never a column, and changes nothing that exists. To evolve a schema use `migrate()`
  or migration files: [Migrations](./guides/migrations.md).
- It prints a progress line per index (`Creating index "ix_posts_query" on "posts"...`), and with
  `logQueries` one per table, through the context's `logger` option, or `console.log` when none is
  set.
- `ensureCreated()` is a method of the schema manager, not of the context: `db.ensureCreated()` does
  not exist.

No server at hand (tests, a demo, a CLI)? Both of these run the whole flow of this page unchanged:

```ts
import { createInMemoryDatabase, PgClient, PGliteClient } from 'linkgress-orm';

// PostgreSQL 18 compiled to WebAssembly, in-process (npm install @electric-sql/pglite)
const onPglite = new AppDatabase(new PGliteClient());

// The bundled in-memory PostgreSQL-compatible engine, reached through the real pg driver
const memory = createInMemoryDatabase();
const inMemory = new AppDatabase(new PgClient(memory.pgPoolConfig()));
```

How the two differ: [In-Memory Database](./guides/in-memory-database.md) and
[PGliteClient](./database-clients.md#pgliteclient-pglite).

## Insert rows and read generated keys: `insert().returning()`

`insert(row)` sends one `INSERT`; chain `.returning(selector)` to read server-generated values in the
same statement. `insertBulk(rows)` writes many rows in one statement per chunk: by default a chunk
is as many rows as fit 60 % of PostgreSQL's 65 535 parameters (13 107 rows of 3 columns);
`insertBulk(rows, { chunkSize })` sets it.

```ts
const alice = await db.users
  .insert({ username: 'alice', email: 'alice@example.com', age: 30 })
  .returning(u => ({ id: u.id }));            // { id: number }

await db.users.insert({ username: 'bob', email: 'bob@example.com', age: 17 });   // undefined: no RETURNING

await db.posts.insertBulk([
  { userId: alice.id, title: 'Hello', views: 50 },
  { userId: alice.id, title: 'Draft', views: 3 },
]);
```

```sql
INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3) RETURNING "id" AS "id"
-- params: ["alice", "alice@example.com", 30]

INSERT INTO "users" ("username", "email", "age") VALUES ($1, $2, $3)
-- params: ["bob", "bob@example.com", 17]

INSERT INTO "posts" ("title", "user_id", "views") VALUES ($1, $2, $3), ($4, $5, $6)
-- params: ["Hello", 1, 50, "Draft", 1, 3]
```

- Columns left `undefined` in every row are omitted, so their `DEFAULT` applies (`is_active`,
  `created_at`, `published_at` above).
- Without `.returning()` the call resolves to `undefined` (type `void`).
- A value given for an identity column is dropped from the `INSERT` without an error; the server
  generates it (`insertBulk(rows, { overridingSystemValue: true })` keeps it).

Upserts, bulk updates, deletes with `RETURNING`, `MutationBatch`:
[Insert, Update, Delete](./guides/insert-update-guide.md).

## Read typed rows: `where()` + `select()` + `toList()`

`where()` adds a `WHERE` predicate; `select()` names the columns to read. The result type is the
projection's type.

```ts
import { eq } from 'linkgress-orm';

const active = await db.users
  .where(u => eq(u.isActive, true))
  .select(u => ({ id: u.id, username: u.username }))
  .toList();
// active: { id: number; username: string }[]
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [true]
```

> **Efficiency:** select only the columns you use. Without `select()`, `where(...).toList()` reads
> every mapped column.

## Load users with their posts in one statement

A collection used inside `select()` becomes part of the same statement: its aggregates as correlated
subqueries and its list as a `LEFT JOIN LATERAL` with `json_agg` (the default `lateral` strategy).
No query per parent row.

```ts
import { gt } from 'linkgress-orm';

const authors = await db.users
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),
    maxViews: u.posts!.max(p => p.views),
    popular: u.posts!
      .where(p => gt(p.views, 10))
      .select(p => ({ title: p.title, views: p.views }))
      .orderBy(p => [[p.views, 'DESC']])
      .toList('popular'),
  }))
  .toList();
// authors: {
//   username: string;
//   postCount: number;
//   maxViews: number | null;
//   popular: { title: string; views: number }[];
// }[]
```

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(MAX("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "maxViews", COALESCE("lateral_2".data, '[]'::json) as "popular"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_2_posts"."title" as "title", "lateral_2_posts"."views" as "views"
  FROM "posts" "lateral_2_posts"
  WHERE "lateral_2_posts"."user_id" = "users"."id" AND "lateral_2_posts"."views" > $1
  ORDER BY "lateral_2_posts"."views" DESC
) sub) "lateral_2" ON true
-- params: [10]
```

Result for alice (2 posts) and bob (none):
`[{ username: 'alice', postCount: 2, maxViews: 50, popular: [{ title: 'Hello', views: 50 }] }, { username: 'bob', postCount: 0, maxViews: null, popular: [] }]`.

- A collection offers `count()`, `sum()`, `min()`, `max()`, `exists()` and the lists `toList()`,
  `toNumberList()`, `toStringList()`, `firstOrDefault()` (each takes an optional name, as in
  `toList('popular')`). It has no `avg()`: see the next sections.
- An empty collection reads as `0` (`count()`), `null` (`sum()`, `min()`, `max()`,
  `firstOrDefault()`), `false` (`exists()`) or `[]` (`toList()`, `toNumberList()`, `toStringList()`).
- The `cte` and `temptable` strategies render the same result differently:
  [Collection Strategies](./collection-strategies.md).

## Filter and project through a navigation

A navigation used in `where()` or `select()` adds a join, `INNER JOIN` here because the `hasOne` is
`.isRequired()`.

```ts
const titles = await db.posts
  .where(p => eq(p.user!.username, 'alice'))
  .select(p => ({ title: p.title, author: p.user!.username }))
  .toList();
// titles: { title: string; author: string }[]
```

```sql
SELECT "posts"."title" as "title", "user"."username" as "author"
FROM "posts"
INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"
WHERE "user"."username" = $1
-- params: ["alice"]
```

## Combine conditions: `and()`, `gt()`, `like()`, `coalesce()`

Conditions are functions imported from `linkgress-orm`; every JavaScript value except `null` and
`undefined` becomes a bound parameter (`eq(col, null)` renders `IS NULL`, `ne(col, null)` `IS NOT NULL`).

```ts
import { and, coalesce, gt, like } from 'linkgress-orm';

const matches = await db.users
  .where(u => and(eq(u.isActive, true), gt(u.age, 18), like(u.username, '%li%')))
  .select(u => ({ username: u.username, age: coalesce(u.age, 0) }))
  .toList();
// matches: { username: string; age: number }[]
```

```sql
SELECT "users"."username" as "username", COALESCE("users"."age", $1) as "age"
FROM "users"
WHERE ("users"."is_active" = $2 AND "users"."age" > $3 AND "users"."username" LIKE $4)
-- params: [0, true, 18, "%li%"]
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `and`, `or`, `not`, `isNull`,
`isNotNull`, `like`, `ilike`, `startsWith`, the `regex*` family, `inArray`, `notInArray`,
`inArrayOpt`, `notInArrayOpt`, `eqAny`, `neAll`, the `normalized*` family, `jsonbSelect`,
`jsonbSelectText`, `flagHas`, `flagHasAll`, `flagHasAny`, `flagHasNone`; `coalesce` is an expression.
Their SQL and NULL rules: [Querying](./guides/querying.md).

> **Pitfall:** `eq(col, undefined)` renders `IS NULL`. Skip a filter whose value is unset instead of
> passing `undefined`.

> **Efficiency:** for a list that comes from data (ids, a cart), prefer `inArrayOpt` /
> `notInArrayOpt`: a plain `IN (…)` up to `LinkgressConfig.inArrayOptThreshold` values (default 8),
> one array parameter (`= ANY($1::type[])`) above it, which bounds the number of distinct statement
> texts. Use `eqAny` / `neAll` when every length must share ONE statement text (long lists, writes by
> an id list): they always bind the list as one array parameter.

## Aggregate per group: `select().groupBy().select()`

`groupBy()` is called on a projection; the second `select()` reads the key and the aggregates
(`count()`, `sum()`, `min()`, `max()`, `avg()`, and since 1.0.31 `countDistinct()` and the list `arrayAgg()`).
This is also the way to an average per parent row.

```ts
const avgViews = await db.posts
  .select(p => ({ userId: p.userId, views: p.views }))
  .groupBy(p => ({ userId: p.userId }))
  .select(g => ({ userId: g.key.userId, avgViews: g.avg(p => p.views) }))
  .toList();
// avgViews: { userId: number; avgViews: number }[]  →  [{ userId: 1, avgViews: 26.5 }]
```

```sql
SELECT "posts"."user_id" as "userId", CAST(AVG("posts"."views") AS DOUBLE PRECISION) as "avgViews"
FROM "posts"
GROUP BY "posts"."user_id"
```

## Fetch one row, count, test existence

Each of these is one statement and reads only what it returns.

```ts
const user = await db.users.where(u => eq(u.username, 'alice')).firstOrDefault();   // UnwrapDbColumns<User> | null
const popularPosts = await db.posts.where(p => gt(p.views, 10)).count();            // number
const taken = await db.users.where(u => eq(u.username, 'nobody')).exists();         // boolean
```

```sql
SELECT "users"."id" as "id", "users"."username" as "username", "users"."email" as "email", "users"."age" as "age", "users"."is_active" as "isActive", "users"."created_at" as "createdAt"
FROM "users"
WHERE "users"."username" = $1
LIMIT 1
-- params: ["alice"]

SELECT COUNT(*) as count
FROM "posts"
WHERE "posts"."views" > $1
-- params: [10]

SELECT EXISTS(SELECT 1
FROM "users"
WHERE "users"."username" = $1)
-- params: ["nobody"]
```

- `firstOrDefault()` without `orderBy()` returns an arbitrary matching row.
- `count()` ignores `orderBy()`, `limit()` and `offset()`.

## Update and delete through `where()`

Start a write from `where()`: the condition becomes the statement's `WHERE`.

```ts
await db.users.where(u => eq(u.id, alice.id)).update({ age: 31 });
await db.posts.where(p => eq(p.views, 3)).delete();
```

```sql
UPDATE "users" SET "age" = $1 WHERE "users"."id" = $2
-- params: [31, 1]

DELETE FROM "posts" WHERE "posts"."views" = $1
-- params: [3]
```

> **Pitfall:** `db.users.update({...})` and `db.users.delete()` without `where()` change every row of
> the table.

## Pick the next API

The full decision guide is [Choosing the right query](./choosing-the-right-query.md). The most
common needs:

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| Rows with chosen columns | `where(…).select(…).toList()` | `SELECT <columns> … WHERE …` · 1 | `toList()` of the table, then filtering in JS |
| One row or nothing | `firstOrDefault()` | `… LIMIT 1` · 1 | `(await toList())[0]` |
| A total | `count()` | `SELECT COUNT(*) …` · 1 | `(await toList()).length` |
| Whether any row matches | `exists()` | `SELECT EXISTS(SELECT 1 …)` · 1 | `count() > 0` |
| A page plus the total | `QueryBatch`: `addList(page)` + `addCount(page)` (`countOver()` when the page always exists) | one `UNION ALL` statement · 1 | `Promise.all([toList(), count()])` · 2; `countOver()` when the page can be empty |
| Parents with their children | a collection in `select()` | `LEFT JOIN LATERAL (… json_agg …)` · 1 | one query per parent row (N + 1) |
| Columns of a referenced row | a navigation in `select()` / `where()` | `INNER JOIN` / `LEFT JOIN` · 1 | a second query for the referenced row |
| Several independent reads | `QueryBatch` | one `UNION ALL` statement · 1 | sequential `await`s · N |
| Aggregates per group | `select().groupBy().select()` | `GROUP BY` · 1 | loading rows and grouping in JS |

`countOver()` reads the total from the first returned row, so a page past the end returns
`{ data: [], totalCount: 0 }`; a `QueryBatch` with `addList()` + `addCount()` on the same query keeps
the total there, still in one statement (its count leg drops `orderBy()`, `limit()` and `offset()`):
[Load a page and its total count in one round trip](./guides/batching-and-prepared-queries.md#load-a-page-and-its-total-count-in-one-round-trip).

Reference pages: [Querying](./guides/querying.md),
[Batching and prepared queries](./guides/batching-and-prepared-queries.md),
[Insert, Update, Delete](./guides/insert-update-guide.md).

## Defaults and switches

Each row is off or at its default unless you set it; details and trade-offs in
[Configuration](./guides/configuration.md).

| Feature | Default | Set with | Scope |
|---|---|---|---|
| Collection aggregation strategy | `'lateral'` | `collectionStrategy: 'lateral' \| 'cte' \| 'temptable'` | context option, or per table with `withQueryOptions()` |
| Statement logging | off | `logQueries`, `logParameters`, `logExecutionTime`, `logger` | context option |
| Failed-statement logging | same as `logQueries` | `logFailedQueries: true` | context option |
| Slow-query reports with the calling stack | off | `onQueryTakingTooLong` + `longRunningQueryThreshold` (default 10 000 ms) | context option; `.expectedExecutionTime(ms)` per query |
| Named server-side prepared statements | off | `preparedStatements: true`, or `.withPreparedStatements(true \| false)` per query | `PostgresClient` only |
| Per-query timeout | none | `.withTimeout(ms)` | `PostgresClient` only; other clients ignore it |
| Stable statement text for list lookups | `inArray` renders one placeholder per value | `inArrayOpt` + `LinkgressConfig.inArrayOptThreshold` / `inArrayPadBuckets` | process-wide |
| Query-build caching on hot paths | off | `MockRowCache.setEnabled(true)` | process-wide |

## Pitfalls

- **Don't** call `db.ensureCreated()` → **Do** `await db.getSchemaManager().ensureCreated()`.
  `DbContext` has no `ensureCreated()` (TS2339 at compile time, TypeError at run time).
- **Don't** read a key from `await db.users.insert({...})` → **Do** chain
  `.returning(u => ({ id: u.id }))`. Without it the call resolves to `undefined`; with it, it is still
  one statement.
- **Don't** write `u.posts.count()` under `strict` → **Do** write `u.posts!.count()`. The navigation
  is declared optional, so TypeScript reports TS18048; the `!` changes nothing at run time.
- **Don't** look for `avg()` on a collection → **Do** use `select().groupBy().select(g => ({ avg: g.avg(...) }))`.
  Collections offer `count`, `sum`, `min`, `max` and `exists` only.
- **Don't** rely on `!` to make a column `NOT NULL` → **Do** call `.isRequired()` (or `.notNull()` on
  the column builder, or make it the primary key). `title!: DbColumn<string>` without them creates a
  nullable column.
- **Don't** declare tables as class fields (`users = this.table(User)`) → **Do** use getters. Inside
  `transaction()` a field named like its table is a raw `TableAccessor` and a field with any other
  name is `undefined`.
- **Don't** construct a context per request → **Do** construct one per client at startup. Every
  construction runs `setupModel` and builds the model again (about 0.2 ms for the 23 tables of the
  example model, measured under Bun 1.4.2), and `hasStatistics()` / `hasCheckConstraint()`
  declarations are appended again to the entity's class-level metadata (indexes are de-duplicated by
  name, these are not).
- **Don't** call `update()` or `delete()` on a table without `where()` unless you mean every row →
  **Do** start from `where(...)`.
- **Don't** use `ensureCreated()` to change an existing schema → **Do** use `migrate()` or migration
  files ([Migrations](./guides/migrations.md)); `ensureCreated()` never adds or changes a column of an
  existing table (a `users` table created with 2 of the 6 columns kept its 2).

## See also

- [Choosing the right query](./choosing-the-right-query.md) — map a data need to the API with the fewest statements.
- [Installation](./installation.md) — packages per driver and runtime, TypeScript settings.
- [Database Clients](./database-clients.md) — `PgClient`, `PostgresClient`, `BunClient`, `PGliteClient`: options, sessions, transactions, lifecycle.
- [Schema Configuration](./guides/schema-configuration.md) — columns, relations, indexes, enums, views, sequences.
- [Migrations](./guides/migrations.md) — `ensureCreated()`, `migrate()`, migration files.
- [Querying](./guides/querying.md) — filters, ordering, pagination, aggregates, joins, grouping.
- [Insert, Update, Delete](./guides/insert-update-guide.md) — writes, upserts, bulk operations, transactions.
- [Collection Strategies](./collection-strategies.md) — how collections become SQL (`lateral`, `cte`, `temptable`).
- [Subqueries](./guides/subquery-guide.md) — `EXISTS`, `IN`, scalar and derived-table subqueries in one statement.
- [Configuration](./guides/configuration.md) — every option with its default and scope.
- [In-Memory Database](./guides/in-memory-database.md) — tests without a server.
- [API index](./api-index.md) — every public export, one line each.
