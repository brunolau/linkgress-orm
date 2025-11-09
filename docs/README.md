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
  - Indexes and constraints
  - Default values
  - Custom types

- **[Querying](./guides/querying.md)** - Query data with type-safe filters, joins, and aggregations
  - Basic queries (SELECT, WHERE, ORDER BY)
  - Nested collections
  - Aggregations (count, sum, min, max)
  - GROUP BY and HAVING
  - JOINs (inner, left, multiple)
  - Subqueries
  - CTEs (Common Table Expressions)
  - Magic SQL strings with custom formatters
  - Advanced patterns and type safety

- **[Insert/Update/Upsert/BULK](./guides/insert-update-guide.md)** - Insert, update, and delete operations
  - Simple insert and update
  - Bulk insert and update
  - Upsert (INSERT ... ON CONFLICT)
  - Delete operations
  - Type safety and performance tips

### 🚀 Advanced Topics

- **[Collection Strategies](./collection-strategies.md)** - Collection loading and performance
  - JSONB/CTE strategy (default, recommended)
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
3. Read [Querying](./guides/querying.md) to master queries
4. Explore [Collection Strategies](./collection-strategies.md)

## Contributing to Documentation

Found an issue or want to improve the docs? Contributions are welcome!

1. Fork the repository
2. Make your changes
3. Submit a pull request

## Need Help?

- **[GitHub Issues](https://github.com/brunolau/linkgress-orm/issues)** - Report bugs or request features
- **[Discussions](https://github.com/brunolau/linkgress-orm/discussions)** - Ask questions and share ideas
