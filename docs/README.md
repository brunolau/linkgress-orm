# Linkgress ORM Documentation

Complete documentation for Linkgress ORM - A type-safe ORM for PostgreSQL and TypeScript with automatic type inference.

## Table of Contents

### 📚 Getting Started
- **[Getting Started Guide](./getting-started.md)** - Complete walkthrough for beginners
  - Installation and setup
  - Your first database
  - Basic queries
  - Key features overview

- **[Installation](./installation.md)** - Detailed installation instructions
  - Core installation
  - Database client options (`pg`, `postgres`, PGlite)
  - Environment-specific setup
  - Troubleshooting

- **[Database Clients](./database-clients.md)** - PostgreSQL client architecture
  - Client comparison
  - PgClient setup
  - PostgresClient setup
  - PGliteClient setup (PostgreSQL in WASM, in-process — no server)
  - Custom client implementation

### 📖 Guides

#### Core Concepts
- **[Schema Configuration](./guides/schema-configuration.md)** - Configure your database schema
  - Entity classes
  - DbContext setup
  - Column types
  - Relationships (one-to-many, many-to-one)
  - Indexes and constraints (including unique indexes with `.isUnique()`)
  - Expression indexes from query builders (`withExpression(e => …)`)
  - Default values
  - Custom types
  - Sequences, including runtime-named ones (`runtimeSequence`, `nextValueCreatingIfMissing`)

- **[Migrations](./guides/migrations.md)** - Database migrations and schema management
  - Automatic migrations (currently supported)
  - Schema creation with `ensureCreated()`
  - Schema deletion with `ensureDeleted()`
  - Post-migration hooks for custom SQL
  - NPM script integration
  - CI/CD workflow examples
  - Future: Planned migrations with journal

- **[Querying](./guides/querying.md)** - Query data with type-safe filters, joins, and aggregations
  - Basic queries (SELECT, WHERE, ORDER BY)
  - Nested collections
  - Aggregations (count, sum, min, max)
  - GROUP BY and HAVING
  - JOINs (inner, left, multiple)
  - Subqueries
  - CTEs (Common Table Expressions)
  - Magic SQL strings with custom formatters
  - Built-in operators: coalesce, JSONB extraction, flag/bitmask operations
  - Advanced patterns and type safety

- **[SQL Expression Helpers](./guides/sql-expressions.md)** - Built-in spellings of common SQL expressions
  - Casts (`cast`, `castAsInt`, `castAsString`, … and `.cast*()` on every fragment)
  - Literals (`literal`, `literalOf`), bound parameters (`param`), typed NULLs, conditions as values
  - Reading a fragment as a column type (`.withReadType()`)
  - CASE (`caseWhen`, `caseOf`), GREATEST / LEAST / NULLIF, IS DISTINCT FROM
  - String, math and date/time functions, intervals (`concatStrict`, `modulo`, regex `substring`)
  - JSON paths, builders (`jsonbBuildObject`, `jsonBuildObject`), mutations and predicates; array-column operators
  - Aggregates as expressions (`agg.count().filter(…)`, `agg.arrayAgg(x, { distinct, orderBy })`, …)

- **[Insert/Update/Upsert/BULK](./guides/insert-update-guide.md)** - Insert, update, and delete operations
  - Fluent API for update and delete (`.where().update()`, `.where().delete()`)
  - RETURNING clause support with selectors, and PostgreSQL 18's `old` row (`.returning((row, old) => …)`)
  - Bulk insert and update, with SET expressions (`bulkUpdate` `set` / `where`)
  - INSERT … SELECT (`insertFrom`), with expected SQLSTATEs kept out of the failure log
  - Upsert (INSERT ... ON CONFLICT), with SET expressions (`updateSet` / `updateWhere`) and partial-index
    arbiters (`targetWhere`)
  - Row-guarded inserts in a `MutationBatch` (`rowGuard`)
  - Advisory transaction locks
  - Type safety and performance tips

- **[Configuration & Options](./guides/configuration.md)** - Every option, and when to turn it on
  - Context options (`QueryOptions`) with defaults
  - Logging in production (`logFailedQueries`) and slow-query detection
  - Server-side prepared statements (`preparedStatements`, `.withPreparedStatements()`)
  - Statement-text economy (`inArrayOptThreshold`, `inArrayPadBuckets`, `inArrayUsesOpt`)
  - Per-query overrides (`.withQueryOptions()`, `.withTimeout()`, `.expectedExecutionTime()`)
  - Process-wide settings (`LinkgressConfig`) and opt-in query-build caches

#### Testing Without a Server
- **[In-Memory Database](./guides/in-memory-database.md)** - PostgreSQL-compatible database reached through the real drivers
  - Snapshots, worker threads, a TCP endpoint for other processes
  - Running an existing suite in memory
- **[PGlite](./database-clients.md#3-pgliteclient-pglite)** - PostgreSQL itself compiled to WASM, in-process through `PGliteClient`
  - In-memory or persisted to a directory, extensions, browsers
  - This repository's suite on it: `pnpm test:pglite`

### 🚀 Advanced Topics

- **[Collection Strategies](./collection-strategies.md)** - Collection loading and performance
  - LATERAL strategy (default, recommended)
  - CTE strategy (alternative)
  - Temp table strategy (experimental)
  - Multi-statement optimization
  - Global and per-query configuration
  - Performance comparison and benchmarking
  - Security considerations

- **[Subqueries](./guides/subquery-guide.md)** - Using subqueries in queries
  - Scalar subqueries
  - Array subqueries
  - EXISTS/NOT EXISTS
  - IN/NOT IN with subqueries
  - Array membership (`eqAnySubquery` / `neAllSubquery`)
  - A scalar subquery as an expression (`asExpression()`) and as a comparison operand
  - Subqueries in JOINs

- **[Aliased Subquery Scopes](./guides/aliased-scopes.md)** - `db.<table>.as(alias)`: correlated subqueries under explicit aliases
  - Scalar `(SELECT …)`, `EXISTS` / `NOT EXISTS` as fragments
  - Joins, WHERE, ORDER BY, LIMIT; same-table correlations
  - Usable in projections, WHERE, UPDATE, CTE bodies, collections, other scopes

- **[Set-Returning Functions](./guides/set-returning-functions.md)** - `unnest`, `unnestZip`, `jsonbArrayElements`, `jsonbEachText`
  - As projection values that multiply rows
  - As row sources: `fromSet()`, `db.selectFromSet()`, `crossJoinLateral()`

- **[CTE Guide](./guides/cte-guide.md)** - Common Table Expressions
  - CTE-rooted queries (`db.selectFromCte`) with every join flavour and `where()`
  - CTEs declared once per statement, read by name from nested subqueries
  - Data-modifying CTEs (`withMutation`) with typed `toStatement()` rows


## Quick Links

### For Beginners
1. Start with [Getting Started Guide](./getting-started.md)
2. Learn [Schema Configuration](./guides/schema-configuration.md)
3. Set up [Migrations](./guides/migrations.md) in your workflow
4. Read [Querying](./guides/querying.md) to master queries
5. Explore [Collection Strategies](./collection-strategies.md)

### Tuning an Existing App
1. [Configuration & Options](./guides/configuration.md) - the complete list of switches and their defaults
2. [Prepared statements](./guides/configuration.md#server-side-prepared-statements-opt-in) - `preparedStatements` and per-query `.withPreparedStatements()`
3. [Matching a list of values](./guides/querying.md#matching-a-list-of-values) - `inArrayOpt`, `eqAny`, and bounding statement-text variety
4. [Collection Strategies](./collection-strategies.md) - pick the right aggregation strategy

## Contributing to Documentation

Found an issue or want to improve the docs? Contributions are welcome!

1. Fork the repository
2. Make your changes
3. Submit a pull request

## Need Help?

- **[GitHub Issues](https://github.com/brunolau/linkgress-orm/issues)** - Report bugs or request features
- **[Discussions](https://github.com/brunolau/linkgress-orm/discussions)** - Ask questions and share ideas
