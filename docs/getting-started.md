# Getting Started with Linkgress ORM

Linkgress ORM is a type-safe ORM for PostgreSQL and TypeScript with automatic type inference and powerful query capabilities.

## Quick Overview

Linkgress uses an **Entity-First** approach where you:
1. Define entity classes with `DbColumn<T>` properties
2. Extend `DbContext` to configure your database
3. Write fully type-safe queries with automatic inference

## Installation

```bash
npm install linkgress-orm postgres
```

See [Installation Guide](./installation.md) for detailed setup instructions.

## Your First Database

### Step 1: Define Entity Classes

Create entity classes that extend `DbEntity`:

```typescript
import { DbEntity, DbColumn } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;

  // Navigation properties (one-to-many)
  posts?: Post[];
  orders?: Order[];
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  content?: DbColumn<string>;
  userId!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  views!: DbColumn<number>;

  // Navigation property (many-to-one)
  user?: User;
}

export class Order extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  status!: DbColumn<string>;
  totalAmount!: DbColumn<number>;
  createdAt!: DbColumn<Date>;

  // Navigation property (many-to-one)
  user?: User;
}
```

**Key Points:**
- Use `DbColumn<T>` for database columns
- Use `!` for required properties, `?` for optional
- Navigation properties are plain TypeScript types (no `DbColumn` wrapper)

### Step 2: Create Your DbContext

Extend `DbContext` to configure your database schema:

```typescript
import {
  DbContext,
  DbEntityTable,
  DbModelConfig,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  decimal
} from 'linkgress-orm';

export class AppDatabase extends DbContext {
  // Define table accessors
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  get posts(): DbEntityTable<Post> {
    return this.table(Post);
  }

  get orders(): DbEntityTable<Order> {
    return this.table(Order);
  }

  // Configure schema in setupModel
  protected override setupModel(model: DbModelConfig): void {
    // Configure User entity
    model.entity(User, entity => {
      entity.toTable('users');

      // Configure properties (columns)
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired().isUnique();
      entity.property(e => e.email).hasType(text('email')).isRequired();
      entity.property(e => e.age).hasType(integer('age'));
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');

      // Configure relationships
      entity.hasMany(e => e.posts, () => Post)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);

      entity.hasMany(e => e.orders, () => Order)
        .withForeignKey(o => o.userId)
        .withPrincipalKey(u => u.id);
    });

    // Configure Post entity
    model.entity(Post, entity => {
      entity.toTable('posts');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'posts_id_seq' }));
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

      // Add index for better performance
      entity.hasIndex('ix_posts_user_published', e => [e.userId, e.publishedAt]);
    });

    // Configure Order entity
    model.entity(Order, entity => {
      entity.toTable('orders');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'orders_id_seq' }));
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
      entity.property(e => e.status).hasType(varchar('status', 20)).hasDefaultValue('pending');
      entity.property(e => e.totalAmount).hasType(decimal('total_amount', 10, 2)).isRequired();
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');

      entity.hasOne(e => e.user, () => User)
        .withForeignKey(o => o.userId)
        .withPrincipalKey(u => u.id)
        .onDelete('cascade')
        .isRequired();

      // Add composite index
      entity.hasIndex('ix_orders_user_status', e => [e.userId, e.status]);
    });
  }
}
```

See [Schema Configuration Guide](./guides/schema-configuration.md) for detailed configuration options.

### Step 3: Initialize Database

```typescript
import { PostgresClient } from 'linkgress-orm';
import { AppDatabase } from './database/app-database';

// Create database client
const client = new PostgresClient({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'postgres',
});

// Create database context
const db = new AppDatabase(client, {
  logQueries: true,  // Optional: log SQL queries
  logParameters: true,  // Optional: log query parameters
});

// Create database schema
await db.getSchemaManager().ensureCreated();
```

See [Migrations Guide](./guides/migrations.md) for automatic migrations, schema management, and integrating migrations into your workflow.

### Step 4: Query Your Data

```typescript
import { eq, and, gt } from 'linkgress-orm';

// Insert data
const newUser = await db.users.insert({
  username: 'alice',
  email: 'alice@example.com',
  age: 30,
  isActive: true,
});

// Simple query
const activeUsers = await db.users
  .where(u => eq(u.isActive, true))
  .toList();

// Query with navigation properties
const usersWithPosts = await db.users
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts
      .select(p => ({
        id: p.id,
        title: p.title,
        views: p.views,
      }))
      .where(p => gt(p.views, 10))
      .orderBy(p => [p.views, 'DESC'])
      .toList('posts'),
  }))
  .toList();

// Result is fully typed:
// usersWithPosts: Array<{
//   id: number;
//   username: string;
//   posts: Array<{ id: number; title: string; views: number }>;
// }>
```

See [Collection Strategies](./collection-strategies.md) to learn about CTE, LATERAL, and temp table strategies for loading collections.

## Key Features

### 1. Automatic Type Inference

No manual type annotations needed - TypeScript infers everything from your entities:

```typescript
const users = await db.users
  .select(u => ({
    id: u.id,  // TypeScript knows this is number
    username: u.username,  // TypeScript knows this is string
    postCount: u.posts.count(),  // TypeScript knows this is number (no casting!)
  }))
  .toList();

// Result is automatically typed:
// Array<{ id: number; username: string; postCount: number }>
```

### 2. Nested Collection Queries

Query one-to-many relationships with automatic optimization (CTE, LATERAL, or temp table strategies):

```typescript
const usersWithOrders = await db.users
  .select(u => ({
    username: u.username,
    orders: u.orders
      .select(o => ({
        status: o.status,
        total: o.totalAmount,
      }))
      .where(o => eq(o.status, 'completed'))
      .toList('orders'),
  }))
  .toList();

// Single optimized SQL query with CTE - not N+1!
```

### 3. Collection Aggregations

Aggregate nested collections without type casting:

```typescript
const stats = await db.users
  .select(u => ({
    username: u.username,
    totalOrders: u.orders.count(),  // number (no 'as unknown as number')
    totalSpent: u.orders.sum(o => o.totalAmount),  // number | null
    maxOrder: u.orders.max(o => o.totalAmount),  // number | null
    avgOrder: u.orders.avg(o => o.totalAmount),  // number | null
  }))
  .toList();
```

### 4. Type-Safe Conditions

All query conditions are fully type-checked:

```typescript
import { eq, gt, like, and, or } from 'linkgress-orm';

const results = await db.users
  .where(u => and(
    eq(u.isActive, true),  // Type-checked: must be boolean
    gt(u.age, 18),  // Type-checked: must be number
    like(u.username, '%alice%')  // Type-checked: must be string
  ))
  .toList();
```

## Next Steps

- **[Schema Configuration](./guides/schema-configuration.md)** - Learn about entity configuration, relations, and indexes
- **[Migrations](./guides/migrations.md)** - Database migrations, schema management, and workflow integration
- **[Querying](./guides/querying.md)** - Master type-safe queries, joins, aggregations, and advanced patterns
- **[Insert/Update/Upsert/BULK](./guides/insert-update-guide.md)** - Master insert, update, delete, and bulk operations
- **[Collection Strategies](./collection-strategies.md)** - Understand CTE, LATERAL, and temp table strategies for loading collections
- **[Subqueries](./guides/subquery-guide.md)** - Using subqueries in your queries

## Examples

See the [examples directory](../examples/) for complete working examples.
