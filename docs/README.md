# Linkgress ORM Documentation

> **For agents:** Which page answers the task at hand, and in which order should these docs be read?
> **Use this page when:** you need the page for a task (reading, writing, schema, migrations, clients, configuration, tests without a server) or an overview of every page. **Look elsewhere when:** you know the data a task needs and want the call with the fewest statements → [Choosing the Right Query](./choosing-the-right-query.md); you need one method's exact spelling or the object that has it → [API Index](./api-index.md)
> **Key pages:** [Choosing the Right Query](./choosing-the-right-query.md), [API Index](./api-index.md), [Getting Started](./getting-started.md) · **Machine-readable index:** [llms.txt](../llms.txt)

Linkgress is the ORM built for agents, AI-first by design, and these docs are written for AI coding agents first:
each page answers one kind of task and, where an example sends SQL, shows the statements and counts the round
trips. They ship inside the npm package and match the installed version: `node_modules/linkgress-orm/docs/`,
indexed by `node_modules/linkgress-orm/llms.txt`.

Read in this order: [Choosing the Right Query](./choosing-the-right-query.md) for the call, the guide section its
table row links for every option, the [API Index](./api-index.md) to confirm a method exists on the object you hold.

## Find the right page

| I want to… | Page |
|---|---|
| set up linkgress-orm: install, entities, a context, the schema, the first queries | [Getting Started](./getting-started.md) |
| install the right driver package, or fix a setup error | [Installation](./installation.md) |
| pick the call that reads or writes a data need in the fewest statements | [Choosing the Right Query](./choosing-the-right-query.md) |
| check a method's exact name and signature, or which object has it | [API Index](./api-index.md#which-object-has-which-method) |
| look up a table, column, relation or seed row of the docs' example model | [Example Model and Seed Data](./example-model.md) |
| read rows, chosen columns, one row, a count or an existence test | [Querying](./guides/querying.md#choose-the-call-that-returns-what-you-need) |
| filter by a list of values without one statement text per list length | [Querying: matching a list of values](./guides/querying.md#matching-a-list-of-values) |
| read a page of rows, with or without the total count | [Querying: page through results](./guides/querying.md#page-through-results) |
| read a related row's columns (a navigation) | [Querying: navigations](./guides/querying.md#read-a-related-rows-columns-navigations) |
| load each row's children in the same statement (a collection) | [Querying: collections](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections) |
| choose `lateral`, `cte` or `temptable` for collections, or speed up a slow collection read | [Collection Strategies](./collection-strategies.md#pick-a-strategy) |
| read few rows through a foreign key into a large table | [Lateral Navigation Joins](./guides/lateral-navigation-joins.md#decide-whether-a-navigation-needs-the-probe) |
| compute totals, statistics per key, or row numbers and ranks | [Querying: `agg`](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg), [`groupBy()`](./guides/querying.md#group-rows-groupby), [window functions](./guides/querying.md#number-and-rank-rows-window-functions) |
| keep rows that have (or lack) related rows, or whose key another query computes | [Subqueries](./guides/subquery-guide.md#choose-the-right-tool) |
| correlate a subquery with the row's own table, or look up a top-1 row through joins | [Aliased Subquery Scopes](./guides/aliased-scopes.md#choose-a-scope-or-another-tool) |
| compute a derived set once and read it in several places, or keep the top N rows per group | [CTEs](./guides/cte-guide.md#decide-cte-subquery-join-or-collection) |
| turn a JS list, JS rows or a jsonb document into rows | [Set-returning Functions](./guides/set-returning-functions.md#decide-which-function-which-source) |
| write a cast, CASE, a NULL default, a string, date, JSONB or array expression | [SQL Expression Helpers](./guides/sql-expressions.md#pick-a-helper-for-the-job) |
| send several independent reads, or a page and its total, in one round trip | [Batching and Prepared Queries](./guides/batching-and-prepared-queries.md#choose-the-right-tool) |
| run one query shape many times with new values (a hot path) | [Batching and Prepared Queries: pick the tool by client](./guides/batching-and-prepared-queries.md#run-one-query-shape-many-times-pick-the-tool-by-client) (`prepare()` or `preparedStatements`) |
| insert, upsert, update or delete rows, or replace a per-row write loop | [Inserts, Updates, Upserts and Deletes](./guides/insert-update-guide.md#choose-a-write) |
| read back what a write changed in the same statement | [Inserts, Updates, Upserts and Deletes: `.returning()`](./guides/insert-update-guide.md#read-back-what-a-write-changed-returningselector) |
| make several statements atomic, or lock the rows I read | [Inserts, Updates, Upserts and Deletes: transactions](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction) |
| run SQL no builder expresses | [Querying: `sql`](./guides/querying.md#write-sql-the-helpers-do-not-cover-sql) |
| see the SQL a query sends, without running it or while it runs | [Choosing the Right Query: see the SQL](./choosing-the-right-query.md#see-the-sql-a-query-emits) |
| declare entities, columns, relations, indexes, enums, custom types or views | [Schema Configuration](./guides/schema-configuration.md#choose-a-schema-feature) |
| create the schema, apply model changes, or run migration files | [Migrations and Schema Management](./guides/migrations.md#pick-the-right-tool) |
| choose and configure a driver: pool, timeouts, sessions, transactions | [Database Clients](./database-clients.md#choose-a-client) |
| log statements, report slow ones, set timeouts or prepared statements, tune `LinkgressConfig` | [Configuration and Options](./guides/configuration.md#pick-the-setting-for-the-job) |
| run code or tests without a PostgreSQL server | [In-Memory Database](./guides/in-memory-database.md#choose-an-in-process-database), [`PGliteClient`](./database-clients.md#pgliteclient-pglite) |

## Start here

- [Choosing the Right Query](./choosing-the-right-query.md) — golden rules, reading and writing decision tables and recipes: the call with the fewest statements for each data need, its SQL, and the alternative it replaces.
- [API Index](./api-index.md) — every export and builder method, one line each: abridged signature, guide link, `since` version; which object has which method; `QueryOptions` defaults; error messages.
- [Getting Started](./getting-started.md) — from `npm install` to typed queries on a `User` / `Post` model, every statement shown.
- [Installation](./installation.md) — packages per driver and runtime, a verified install program, library peer dependencies, TypeScript settings, setup errors.
- [Example Model and Seed Data](./example-model.md) — the `AppDatabase` every example queries: tables, columns, relations, indexes, seed rows, and how to rebuild it.

## Reading data

- [Querying](./guides/querying.md) — terminals, projections, `where()` and NULL semantics, list matching, text search, ordering, paging, navigations, collections, joins, `agg`, `groupBy()`, window functions, unions, row locks, raw SQL.
- [Batching and Prepared Queries](./guides/batching-and-prepared-queries.md) — `QueryBatch` (several reads, or a page and its total, in one round trip), `future()`, `FutureQueryRunner`, `prepare()` with `sql.placeholder()`.
- [Collection Strategies](./collection-strategies.md) — how collections render under `lateral` (default), `cte` and `temptable`: SQL, round trips per driver, measurements, foreign-key indexes.
- [Lateral Navigation Joins](./guides/lateral-navigation-joins.md) — `lateralJoin()` (since 1.0.23): one reference navigation as a per-row key probe instead of a plain join.
- [Subqueries](./guides/subquery-guide.md) — `exists()` / `notExists()`, `inSubquery()`, `eqAnySubquery()`, scalar subqueries, derived-table joins, and when a join, a collection or a CTE fits better.
- [Aliased Subquery Scopes](./guides/aliased-scopes.md) — `db.<table>.as(alias)`: correlated subqueries over the row's own table, with joins, ORDER BY and LIMIT, usable wherever a fragment goes.
- [CTEs (WITH queries)](./guides/cte-guide.md) — derived sets joined, read as a FROM root or from several subqueries; top N per group; data-modifying CTEs with typed RETURNING; recursive queries in raw SQL.
- [Set-returning Functions](./guides/set-returning-functions.md) — JS lists, JS rows and jsonb as relations: `unnest()`, `unnestZip()`, `unnestRows()` / `fromRows()`, `jsonbArrayElements()`, `crossJoinLateral()`.
- [SQL Expression Helpers](./guides/sql-expressions.md) — casts, literals and parameters, CASE, NULL handling, string, math, date/time, JSONB and array-column helpers, `agg`, `win`, the `sql` template.

## Writing data

- [Inserts, Updates, Upserts and Deletes](./guides/insert-update-guide.md) — every write API with its SQL and round trips: `insert()`, `insertBulk()`, `fromRows()`, `insertFrom()`, `upsertBulk()`, `mergeBulk()`, `where().update()`, `bulkUpdate()`, `where().delete()`, `.returning()`, `insertWithChildren()`, `MutationBatch`, data-modifying CTEs, sequences, transactions and locks.

## Schema and migrations

- [Schema Configuration](./guides/schema-configuration.md) — entity classes, the `DbContext`, column types and what each driver returns, keys, defaults, relations, indexes for the queries you run, constraints, partitioning, enums, collations, custom mappers, sequences, views.
- [Migrations and Schema Management](./guides/migrations.md) — `ensureCreated()`, `migrate()` and `analyze()` with the SQL they send, migration hooks, migration files (`MigrationRunner`, `MigrationJournal`, `MigrationLoader`, `MigrationScaffold`), scripts and a CI drift gate.

## Runtime and configuration

- [Database Clients](./database-clients.md) — `PgClient`, `PostgresClient`, `BunClient` and `PGliteClient` compared: capabilities, options, timeouts, prepared statements, multi-statement round trips, pinned sessions, transactions, lifecycle, custom clients.
- [Configuration and Options](./guides/configuration.md) — every `QueryOptions` key, `TransactionOptions`, per-query overrides, `LinkgressConfig` and the query-build caches: default, scope, which value wins.

## Testing without a server

- [In-Memory Database](./guides/in-memory-database.md) — the bundled PostgreSQL-compatible engine reached through the real `pg` / `postgres` drivers: snapshots per test, TCP, worker threads, and every known difference from PostgreSQL.
- [`PGliteClient`](./database-clients.md#pgliteclient-pglite) — PostgreSQL itself compiled to WebAssembly, in-process: one session, in memory or persisted to a directory.

## How every page is built

- **The "For agents" block** under the title: the question the page answers, **Use this page when** / **Look elsewhere when**, its **Key APIs** and, on most pages, the **Round trips** they cost.
- **Sections named after tasks** ("Read a page and its total in one statement"), so a section title is a searchable need. Decision tables have the columns **Need · Use · SQL shape · round trips · Avoid**.
- **SQL blocks** are the statements the library sent when the example ran, captured, not written by hand: one statement is one round trip (on `PostgresClient` an unnamed statement with parameters takes 2 network exchanges; see [Database Clients](./database-clients.md#round-trips-and-performance-per-client)), `$n` are bound parameters, `-- params:` lists their values. A block that could not be captured says so in its first comment line, with the reason (postgres.js's own timeout statements, a server's `EXPLAIN` plan).
- **The example model** is `AppDatabase` (`debug/schema/appDatabase.ts` in the repository, not shipped in the package): users, posts, post comments, orders, tasks, products, tags and carts. The examples run on it with test data seeded for the users alice, bob and charlie; every table, column, relation, index and seed row is in [Example Model and Seed Data](./example-model.md).
- **Version marks:** `(since 1.0.N)` names the version that added an API.
- **Pitfalls** are listed as **Don't** → **Do**; **See also** ends every page.

## See also

- [README](../README.md) — what linkgress-orm is, the Quick Start, the feature list.
- [llms.txt](../llms.txt) — the machine-readable index of these pages, with when to read each one.
- [Contributing](https://github.com/brunolau/linkgress-orm/blob/main/CONTRIBUTING.md) — work on linkgress-orm itself, and how to update these docs.
- [Changelog](https://github.com/brunolau/linkgress-orm/tree/main/changelog) — one file per version: what was added or fixed when.
- [GitHub Issues](https://github.com/brunolau/linkgress-orm/issues) and [Discussions](https://github.com/brunolau/linkgress-orm/discussions) — report bugs, ask questions.
