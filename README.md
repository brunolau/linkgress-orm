# Linkgress ORM

[![npm version](https://img.shields.io/npm/v/linkgress-orm.svg)](https://www.npmjs.com/package/linkgress-orm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12+-blue.svg)](https://www.postgresql.org/)

A type-safe ORM for PostgreSQL and TypeScript with automatic type inference and powerful query capabilities.

**LINQ-Inspired Query Syntax:** The query API is designed to feel familiar to developers coming from C# LINQ, with chainable methods like `select()`, `where()`, `orderBy()`, and `groupBy()`. You also get magic SQL string interpolation for when you need raw SQL power without sacrificing type safety.

**PostgreSQL-First Philosophy:** While other ORMs aim high and try to support all platforms, Linkgress is built exclusively for PostgreSQL. This allows it to leverage PostgreSQL's advanced features to the maximum—particularly in how collections and aggregations are retrieved using CTEs, LATERAL joins, JSON aggregations, and native PostgreSQL optimizations.

## Features

- **Entity-First Approach** - Define entities with `DbColumn<T>`, no decorators needed
- **Fluent Configuration API** - Intuitive `DbContext` pattern with method chaining
- **Automatic Type Inference** - Full TypeScript support without manual type annotations
- **Nested Collection Queries** - Query one-to-many relationships with CTE, LATERAL, or temp table strategies
- **Type-Safe Aggregations** - `count()`, `sum()`, `max()`, `min()` return proper types
- **Powerful Filtering** - Type-checked query conditions
- **Transaction Support** - Safe, type-checked transactions
- **Multiple Clients** - Works with both `pg` and `postgres` npm packages

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## Quick Start

### Installation

```bash
npm install linkgress-orm postgres
```

See [Installation Guide](./docs/installation.md) for detailed setup.

### Define Entities

```typescript
import { DbEntity, DbColumn } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  posts?: Post[];  // Navigation property
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;
  views!: DbColumn<number>;
  user?: User;  // Navigation property
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
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();

      entity.hasMany(e => e.posts, () => Post)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);
    });

    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'posts_id_seq' }));
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
import { eq, gt } from 'linkgress-orm';
import { PostgresClient } from 'linkgress-orm';

// Create a database client with connection pooling
const client = new PostgresClient('postgres://user:pass@localhost/db');

// Create a DbContext instance - reuse this across your application!
const db = new AppDatabase(client);

// Create schema
await db.ensureCreated();

// Insert
await db.users.insert({ username: 'alice', email: 'alice@example.com' });

// Query with filters
const activeUsers = await db.users
  .where(u => eq(u.username, 'alice'))
  .toList();

// Nested collection query with aggregations
const usersWithStats = await db.users
  .select(u => ({
    username: u.username,
    postCount: u.posts.count(),  // Automatic type inference - no casting!
    maxViews: u.posts.max(p => p.views),  // Returns number | null
    posts: u.posts
      .select(p => ({ title: p.title, views: p.views }))
      .where(p => gt(p.views, 10))
      .toList('posts'),
  }))
  .toList();

// Note: Only call dispose() when shutting down your application
// For long-running apps (servers), keep the db instance alive
// and dispose on process exit (see Connection Lifecycle docs)
```

**Result is fully typed:**
```typescript
Array<{
  username: string;
  postCount: number;
  maxViews: number | null;
  posts: Array<{ title: string; views: number }>;
}>
```

## Documentation

### Getting Started
- **[Getting Started Guide](./docs/getting-started.md)** - Complete walkthrough for beginners
- **[Installation](./docs/installation.md)** - Setup and installation instructions
- **[Database Clients](./docs/database-clients.md)** - Choose between `pg` and `postgres`, connection pooling, and lifecycle management

### Guides
- **[Schema Configuration](./docs/guides/schema-configuration.md)** - Entity configuration, relationships, and indexes
- **[Querying](./docs/guides/querying.md)** - Query data with type-safe filters, joins, aggregations, and more
- **[Insert/Update/Upsert/BULK](./docs/guides/insert-update-guide.md)** - Insert, update, delete, and bulk operations

### Advanced
- **[Collection Strategies](./docs/collection-strategies.md)** - CTE, LATERAL, and temp table strategies for one-to-many queries
- **[Subqueries](./docs/guides/subquery-guide.md)** - Using subqueries in your queries
- **[Custom Types](./docs/guides/schema-configuration.md#custom-types)** - Create custom type mappers

## Requirements

- Node.js 16+
- TypeScript 5.0+
- PostgreSQL 12+

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Support

- **[GitHub Issues](https://github.com/brunolau/linkgress-orm/issues)** - Report bugs or request features
- **[Discussions](https://github.com/brunolau/linkgress-orm/discussions)** - Ask questions and share ideas

---

Crafted with ❤️ for developers who love type safety and clean APIs.
