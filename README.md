# Linkgress ORM

**The ORM built for agents — AI-first by design.** Linkgress is a type-safe PostgreSQL ORM for TypeScript. Its query API, inferred result types and documentation are built so that an AI coding agent picks the most efficient query for a data need on the first try, and the TypeScript compiler checks every query it writes.

> **For agents:** start with [llms.txt](./llms.txt) and [Choosing the Right Query](./docs/choosing-the-right-query.md). The docs ship inside the npm package and match the installed version: read them under `node_modules/linkgress-orm/docs/`, indexed by `node_modules/linkgress-orm/llms.txt`.

[![npm version](https://img.shields.io/npm/v/linkgress-orm.svg)](https://www.npmjs.com/package/linkgress-orm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12+-blue.svg)](https://www.postgresql.org/)

**LINQ-Inspired Query Syntax:** The query API is designed to feel familiar to developers coming from C# LINQ, with chainable methods like `select()`, `where()`, `orderBy()`, and `groupBy()`. When you need raw SQL, the `sql` template tag renders interpolated columns qualified and binds interpolated JS values as parameters.

**PostgreSQL-First Philosophy:** While other ORMs aim high and try to support all platforms, Linkgress is built exclusively for PostgreSQL. This allows it to leverage PostgreSQL's advanced features to the maximum—particularly in how collections and aggregations are retrieved using CTEs, LATERAL joins, JSON aggregations, and native PostgreSQL optimizations.

## Built for agents

- **Decision guides, not just reference.** [Choosing the Right Query](./docs/choosing-the-right-query.md) maps a data need to the call that serves it in the fewest statements: decision tables (need → call → SQL shape → round trips → what to avoid) and recipes that set the efficient call beside the tempting alternative, each with its SQL and statement count. Every page opens with a "For agents" block (the question it answers, when to read it, its key APIs and, on most pages, their round trips) and ends with See also; pitfalls are listed as Don't → Do.
- **SQL from real runs.** The SQL blocks in the docs are the statements the library sent when the example ran, with their bound parameters: one statement is one round trip (on `PostgresClient` an unnamed statement with parameters takes 2 network exchanges; see [Database Clients](./docs/database-clients.md#round-trips-and-performance-per-client)). They are captured, not written by hand; the few that could not be captured that way (postgres.js's own timeout statements, a server's `EXPLAIN` plan) are labeled `illustrative (not captured)`.
- **Docs that match the installed version.** `docs/` and `llms.txt` ship in the npm package, so an agent reads the docs of the version it codes against under `node_modules/linkgress-orm/`, offline. [llms.txt](./llms.txt) lists every page with when to read it; the [API index](./docs/api-index.md) lists every export and builder method, one line each, and which object has which method.
- **The compiler checks the query.** Result types are inferred from the projection, with no annotations, decorators or code generation. A column that does not exist or a method the builder does not have does not compile. The few places where run-time values differ from the types are listed in [Check result types at compile time](./docs/guides/querying.md#check-result-types-at-compile-time).
- **Predictable SQL and round trips.** Builder steps send nothing; a terminal call (`toList()`, `firstOrDefault()`, `count()`, `exists()`) sends one statement, related rows included: a navigation becomes a join, a collection a `LEFT JOIN LATERAL` or a correlated subquery under the default strategy (the guides name the few exceptions, such as the experimental `temptable` strategy). There is no lazy loading, so no hidden N+1 queries, and `future().getSql()` shows a query's SQL without sending it ([See the SQL a query emits](./docs/choosing-the-right-query.md#see-the-sql-a-query-emits)).

## Features

- **Built for Agents** - Decision guides with captured SQL and round-trip counts, an API index, `llms.txt`, and docs that ship in the package ([details](#built-for-agents))
- **Entity-First Approach** - Define entities with `DbColumn<T>`, no decorators needed
- **Fluent Configuration API** - Intuitive `DbContext` pattern with method chaining
- **Automatic Type Inference** - Full TypeScript support without manual type annotations
- **Related Rows in One Statement** - Navigations become joins; one-to-many collections nest in the parent row (LATERAL by default, CTE or temp table strategies per query)
- **Aggregations in the Same Statement** - Per-parent `count()` / `sum()` / `min()` / `max()` / `exists()`, `agg` totals, `groupBy()` / `having()`, window functions (`win`)
- **Powerful Filtering** - Type-checked query conditions, `exists()` / `inSubquery()`, and list membership that keeps the statement text stable (`inArrayOpt`, `eqAny`)
- **SQL Expression Helpers** - Casts (`castAsInt()`, `.cast('numeric(12, 2)')`), `caseWhen` / `caseOf`, `greatest` / `least` / `nullIf`, string / math / date-time functions, JSONB paths and mutations, array-column operators — no raw `sql` templates needed
- **Bulk Writes** - `insertBulk()`, `upsertBulk()` with `updateSet` / `updateWhere` expressions, `bulkUpdate()` with `set` / `where`, `insertFrom()`, `insertWithChildren()`
- **Fluent Update/Delete** - Chain `.where().update()` and `.where().delete()` with RETURNING support
- **Batching** - `QueryBatch` sends several independent reads in one round trip; `MutationBatch` several writes in one atomic statement
- **Prepared Queries** - Build queries once, execute many times with named placeholders (`sql.placeholder()` + `.prepare()`)
- **Server-Side Prepared Statements** - Opt-in named statements on the `postgres` driver, overridable per query with `.withPreparedStatements()`
- **Transactions and Locks** - `db.transaction()`, row locks with `forUpdate()`, transaction-scoped advisory locks
- **Production Diagnostics** - Failed-statement logging, slow-query reports with the calling stack, per-query timeouts (`postgres` driver)
- **Migrations** - `migrate()` applies the model diff; file-based migrations with journal tracking, up/down support, and scaffolding
- **Model-Managed Views** - Declare a database view with `model.view()` — as SQL, or as a typed linkgress query; migrate creates it and re-creates it on change, and it is read-only in queries
- **Multiple Clients** - Works with the `pg` and `postgres` npm packages, Bun's built-in SQL, and PGlite (PostgreSQL in WASM, in-process — no server); a bundled in-memory PostgreSQL-compatible database for tests

## Table of Contents

- [Built for agents](#built-for-agents)
- [Features](#features)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## Quick Start

### Installation

```bash
npm install linkgress-orm pg
```

`pg` is one of four drivers: see the [Installation Guide](./docs/installation.md) for `postgres`, Bun and PGlite.

### Define Entities

```typescript
import { DbColumn, DbEntity } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  posts?: Post[];   // collection (hasMany)
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;
  views!: DbColumn<number>;
  user?: User;      // navigation (hasOne)
}
```

### Create DbContext

```typescript
import { DbContext, DbEntityTable, DbModelConfig, integer, varchar } from 'linkgress-orm';

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
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();

      entity.hasMany(e => e.posts, () => Post)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);
    });

    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.views).hasType(integer('views')).hasDefaultValue(0);

      entity.hasOne(e => e.user, () => User)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);
    });
  }
}
```

### Query with Type Safety

```typescript
import { PgClient, eq, gt } from 'linkgress-orm';

// One context per client: construct it at startup and reuse it
const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));

// Create the missing tables (development, tests); evolve a schema with migrate() or migration files
await db.getSchemaManager().ensureCreated();

// Insert, reading the generated key in the same statement
const alice = await db.users
  .insert({ username: 'alice', email: 'alice@example.com' })
  .returning(u => ({ id: u.id }));

// Many rows in one statement
await db.posts.insertBulk([
  { userId: alice.id, title: 'Hello', views: 50 },
  { userId: alice.id, title: 'Draft', views: 3 },
]);

// Filter and project
const found = await db.users
  .where(u => eq(u.username, 'alice'))
  .select(u => ({ id: u.id, email: u.email }))
  .toList();

// Each user with per-user aggregates and a filtered list of posts: one statement
const usersWithStats = await db.users
  .select(u => ({
    username: u.username,
    postCount: u.posts!.count(),
    maxViews: u.posts!.max(p => p.views),
    posts: u.posts!
      .where(p => gt(p.views, 10))
      .select(p => ({ title: p.title, views: p.views }))
      .toList('posts'),
  }))
  .toList();

// A navigation becomes a join
const titles = await db.posts
  .select(p => ({ title: p.title, author: p.user!.username }))
  .toList();

// Update and read the changed rows back in the same statement
const updated = await db.users
  .where(u => eq(u.username, 'alice'))
  .update({ email: 'alice.new@example.com' })
  .returning(u => ({ id: u.id, email: u.email }));

// Delete
await db.posts.where(p => eq(p.title, 'Draft')).delete();

// At shutdown only: close the connection pool
await db.dispose();
```

Each call above sends one SQL statement, `ensureCreated()` one per table (2 here); `dispose()` sends none.
Navigations and collections are declared optional, so under `strict` they are dereferenced with `!` in query
lambdas (`u.posts!.count()`); `ensureCreated()` belongs to the schema manager (`db.ensureCreated()` does not exist).
Top-level `await` needs an ES module; [Verify the installation](./docs/installation.md#verify-the-installation) shows a
complete program inside `async function main()`.

**Results are fully typed**, inferred from the projections:

```typescript
alice:          { id: number }
found:          Array<{ id: number; email: string }>
usersWithStats: Array<{
  username: string;
  postCount: number;
  maxViews: number | null;
  posts: Array<{ title: string; views: number }>;
}>
titles:         Array<{ title: string; author: string }>
updated:        Array<{ id: number; email: string }>
```

**The statement `usersWithStats` sends** (default `lateral` collection strategy), and its result:

```sql
SELECT "users"."username" as "username", (SELECT COALESCE(COUNT(*), 0)
FROM "posts" "lateral_0_posts"
WHERE "lateral_0_posts"."user_id" = "users"."id") as "postCount", (SELECT COALESCE(MAX("lateral_1_posts"."views"), null)
FROM "posts" "lateral_1_posts"
WHERE "lateral_1_posts"."user_id" = "users"."id") as "maxViews", COALESCE("lateral_2".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'views', "views")
) as data
FROM (
  SELECT "lateral_2_posts"."title" as "title", "lateral_2_posts"."views" as "views"
  FROM "posts" "lateral_2_posts"
  WHERE "lateral_2_posts"."user_id" = "users"."id" AND "lateral_2_posts"."views" > $1
) sub) "lateral_2" ON true
-- params: [10]
```

`[{ username: 'alice', postCount: 2, maxViews: 50, posts: [{ title: 'Hello', views: 50 }] }]`

Next: [Getting Started](./docs/getting-started.md) walks through these steps with every statement shown, and
[Choosing the Right Query](./docs/choosing-the-right-query.md) maps each data need to the call with the fewest statements.

## Documentation

The docs are written for AI coding agents first and read just as well by people. Each page answers one kind of
task; where an example sends SQL, the page shows the statements and counts the round trips. Index:
[docs/README.md](./docs/README.md) · for agents: [llms.txt](./llms.txt).

### Start Here
- **[Choosing the Right Query](./docs/choosing-the-right-query.md)** - The call that reads or writes a data need in the fewest statements: golden rules, decision tables, recipes with captured SQL
- **[API Index](./docs/api-index.md)** - Every export and builder method, one line each, and which object has which method
- **[Getting Started Guide](./docs/getting-started.md)** - From `npm install` to typed queries, every statement shown
- **[Installation](./docs/installation.md)** - Packages per driver and runtime, a verified install program, TypeScript settings, setup errors
- **[Example Model and Seed Data](./docs/example-model.md)** - The `AppDatabase` every example queries: tables, columns, relations, indexes and seed rows

### Reading Data
- **[Querying](./docs/guides/querying.md)** - Rows, projections, filters, list matching, paging, navigations, collections, joins, aggregates, groups, windows, unions, raw SQL
- **[Batching and Prepared Queries](./docs/guides/batching-and-prepared-queries.md)** - Several reads in one round trip (`QueryBatch`), a page with its total, futures, `prepare()` with placeholders
- **[Collection Strategies](./docs/collection-strategies.md)** - LATERAL, CTE and temp table strategies for one-to-many queries: SQL, round trips, measurements
- **[Lateral Navigation Joins](./docs/guides/lateral-navigation-joins.md)** - `lateralJoin()`: one reference navigation as a key probe per row
- **[Subqueries](./docs/guides/subquery-guide.md)** - `exists()`, `inSubquery()`, scalar subqueries and derived-table joins in one statement
- **[Aliased Subquery Scopes](./docs/guides/aliased-scopes.md)** - Correlated subqueries over the row's own table: `db.<table>.as(alias)`
- **[CTEs (Common Table Expressions)](./docs/guides/cte-guide.md)** - Derived sets read in several places, CTE-rooted queries with FULL OUTER / RIGHT / CROSS joins, data-modifying CTEs
- **[Set-Returning Functions](./docs/guides/set-returning-functions.md)** - JS lists, JS rows and jsonb as relations: `unnest()`, `fromRows()`, `crossJoinLateral()`
- **[SQL Expression Helpers](./docs/guides/sql-expressions.md)** - Casts, CASE, scalar / string / math / date-time functions, JSONB and array operators, `agg`, `win`

### Writing Data
- **[Inserts, Updates, Upserts and Deletes](./docs/guides/insert-update-guide.md)** - Every write API with its SQL: bulk inserts, upserts, bulk updates, RETURNING, `MutationBatch`, transactions and locks

### Schema and Migrations
- **[Schema Configuration](./docs/guides/schema-configuration.md)** - Entities, column types, relationships, indexes, enums, sequences, views
- **[Custom Types](./docs/guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)** - Create custom type mappers; `immutable: true` maps each distinct value of a column once per result set and shares it
- **[Migrations](./docs/guides/migrations.md)** - `ensureCreated()`, `migrate()` and migration files with journal tracking

### Runtime and Configuration
- **[Database Clients](./docs/database-clients.md)** - Choose between `pg`, `postgres`, Bun's SQL and PGlite (in-process, no server), connection pooling, and lifecycle management
- **[Configuration & Options](./docs/guides/configuration.md)** - Every option with its default: logging, prepared statements (`preparedStatements`, `.withPreparedStatements()`), timeouts, slow-query detection, `LinkgressConfig`

### Testing Without a Server
- **[In-Memory Database](./docs/guides/in-memory-database.md)** - PostgreSQL-compatible in-memory database for fast, isolated tests (real drivers, snapshots)
- **[PGlite](./docs/database-clients.md#pgliteclient-pglite)** - PostgreSQL itself compiled to WASM, in-process through `PGliteClient`: tests without a server, local-first apps, browsers

## Requirements

- Node.js 16+ (or Bun)
- TypeScript 5.0+
- PostgreSQL 12+ (a few features need a newer server and say so in the guides, for example `mergeBulk()`: 15+, `.returning((row, old) => …)`: 18)

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](https://github.com/brunolau/linkgress-orm/blob/main/CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Support

- **[GitHub Issues](https://github.com/brunolau/linkgress-orm/issues)** - Report bugs or request features
- **[Discussions](https://github.com/brunolau/linkgress-orm/discussions)** - Ask questions and share ideas

---

Crafted with ❤️ for developers, and the agents that write code with them, who love type safety and clean APIs.
