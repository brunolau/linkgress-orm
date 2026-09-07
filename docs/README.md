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
  - Database client options (`pg` vs `postgres`)
  - Environment-specific setup
  - Troubleshooting

- **[Database Clients](./database-clients.md)** - PostgreSQL client architecture
  - Client comparison
  - PgClient setup
  - PostgresClient setup
  - Custom client implementation

### 📖 Guides

#### Core Concepts
- **[Schema Configuration](./guides/schema-configuration.md)** - Configure your database schema
  - Entity classes
  - DbContext setup
  - Column types
  - Relationships (one-to-many, many-to-one)
  - Indexes and constraints (including unique indexes with `.isUnique()`)
  - Default values
  - Custom types

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

- **[Insert/Update/Upsert/BULK](./guides/insert-update-guide.md)** - Insert, update, and delete operations
  - Fluent API for update and delete (`.where().update()`, `.where().delete()`)
  - RETURNING clause support with selectors
  - Bulk insert and update
  - Upsert (INSERT ... ON CONFLICT)
  - Type safety and performance tips

- **[Configuration & Options](./guides/configuration.md)** - Every option, and when to turn it on
  - Context options (`QueryOptions`) with defaults
  - Logging in production (`logFailedQueries`) and slow-query detection
  - Server-side prepared statements (`preparedStatements`, `.withPreparedStatements()`)
  - Statement-text economy (`inArrayOptThreshold`, `inArrayPadBuckets`, `inArrayUsesOpt`)
  - Per-query overrides (`.withQueryOptions()`, `.withTimeout()`, `.expectedExecutionTime()`)
  - Process-wide settings (`LinkgressConfig`) and opt-in query-build caches

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
  - Subqueries in JOINs


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
