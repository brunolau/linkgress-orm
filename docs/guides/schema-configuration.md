# Schema Configuration Guide

This guide covers how to configure your database schema using Linkgress ORM's fluent configuration API.

## Table of Contents

- [Entity Classes](#entity-classes)
- [DbContext Configuration](#dbcontext-configuration)
- [Column Types](#column-types)
- [Relationships](#relationships)
  - [One-to-Many](#one-to-many-hasmany)
  - [Many-to-One](#many-to-one-hasone)
  - [Composite Foreign Keys](#composite-foreign-keys)
- [Indexes](#indexes)
- [Constraints](#constraints)
- [Sequences](#sequences)
- [Default Values](#default-values)
- [Custom Types](#custom-types)

## Entity Classes

Entity classes represent your database tables. They must extend the `DbEntity` base class and use `DbColumn<T>` for database columns.

### Basic Entity

```typescript
import { DbEntity, DbColumn } from 'linkgress-orm';

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;  // Optional column
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;
}
```

**Rules:**
- Extend `DbEntity` base class
- Use `DbColumn<T>` for database columns
- Use `!` for required properties (NOT NULL)
- Use `?` for optional properties (NULL allowed)
- Don't wrap navigation properties with `DbColumn`

### Entity with Navigation Properties

```typescript
export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;

  // One-to-many: User has many posts
  posts?: Post[];

  // One-to-many: User has many orders
  orders?: Order[];
}

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;

  // Many-to-one: Post belongs to one user
  user?: User;
}

export class Order extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  status!: DbColumn<'pending' | 'processing' | 'completed' | 'cancelled' | 'refunded'>;
  totalAmount!: DbColumn<number>;
  createdAt!: DbColumn<Date>;
  items?: DbColumn<any>;

  // Navigation property
  user?: User;
}
```

## DbContext Configuration

Your `DbContext` class configures the database schema and provides table accessors.

### Basic DbContext

```typescript
import { DbContext, DbEntityTable, DbModelConfig } from 'linkgress-orm';

export class AppDatabase extends DbContext {
  // Table accessors
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  get posts(): DbEntityTable<Post> {
    return this.table(Post);
  }

  // Schema configuration
  protected override setupModel(model: DbModelConfig): void {
    // Configure entities here
  }
}
```

### Property Configuration

Configure each entity property with column type, constraints, and defaults:

```typescript
protected override setupModel(model: DbModelConfig): void {
  model.entity(User, entity => {
    entity.toTable('users');  // Set table name

    // Primary key with identity column
    entity.property(e => e.id)
      .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));

    // Required unique column
    entity.property(e => e.username)
      .hasType(varchar('username', 100))
      .isRequired()
      .isUnique();

    // Required column
    entity.property(e => e.email)
      .hasType(text('email'))
      .isRequired();

    // Optional column (nullable)
    entity.property(e => e.age)
      .hasType(integer('age'));

    // Column with default value
    entity.property(e => e.isActive)
      .hasType(boolean('is_active'))
      .hasDefaultValue(true);

    // Timestamp with default
    entity.property(e => e.createdAt)
      .hasType(timestamp('created_at'))
      .hasDefaultValue('NOW()');
  });
}
```

## Column Types

Linkgress provides type builders for all PostgreSQL types:

### Numeric Types

```typescript
import {
  integer,
  serial,
  bigint,
  bigserial,
  smallint,
  decimal,
  numeric,
  real,
  doublePrecision
} from 'linkgress-orm';

entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'table_id_seq' }));  // Auto-increment identity
entity.property(e => e.age).hasType(integer('age'));
entity.property(e => e.bigNumber).hasType(bigint('big_number'));
entity.property(e => e.price).hasType(decimal('price', 10, 2));  // precision, scale
entity.property(e => e.rating).hasType(real('rating'));
```

### String Types

```typescript
import { varchar, char, text } from 'linkgress-orm';

entity.property(e => e.username).hasType(varchar('username', 100));  // max length
entity.property(e => e.code).hasType(char('code', 10));  // fixed length
entity.property(e => e.description).hasType(text('description'));  // unlimited
```

### Date/Time Types

```typescript
import { timestamp, timestamptz, date, time } from 'linkgress-orm';

entity.property(e => e.createdAt).hasType(timestamp('created_at'));
entity.property(e => e.modifiedAt).hasType(timestamptz('modified_at'));  // with timezone
entity.property(e => e.birthDate).hasType(date('birth_date'));
entity.property(e => e.appointmentTime).hasType(time('appointment_time'));
```

### Other Types

```typescript
import { boolean, uuid, json, jsonb, bytea } from 'linkgress-orm';

entity.property(e => e.isActive).hasType(boolean('is_active'));
entity.property(e => e.guid).hasType(uuid('guid'));
entity.property(e => e.metadata).hasType(jsonb('metadata'));  // recommended over json
entity.property(e => e.config).hasType(json('config'));
entity.property(e => e.fileData).hasType(bytea('file_data'));
```

## Relationships

Linkgress supports three types of relationships:

### One-to-Many (hasMany)

A user has many posts:

```typescript
// Entity class
export class User extends DbEntity {
  id!: DbColumn<number>;
  posts?: Post[];  // Navigation property
}

// DbContext configuration
model.entity(User, entity => {
  entity.hasMany(e => e.posts, () => Post)
    .withForeignKey(p => p.userId)  // Foreign key in Post table (lambda syntax)
    .withPrincipalKey(u => u.id);   // Primary key in User table (lambda syntax)
});
```

### Many-to-One (hasOne)

A post belongs to one user:

```typescript
// Entity class
export class Post extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;  // Foreign key column
  user?: User;  // Navigation property
}

// DbContext configuration
model.entity(Post, entity => {
  entity.hasOne(e => e.user, () => User)
    .withForeignKey(p => p.userId)    // Foreign key in this table (lambda syntax)
    .withPrincipalKey(u => u.id)      // Primary key in User table (lambda syntax)
    .onDelete('cascade')              // Optional: cascade delete
    .onUpdate('no action')            // Optional: update action
    .hasDbName('FK_posts_users')      // Optional: constraint name
    .isRequired();                    // Optional: NOT NULL foreign key
});
```

### Relationship Actions

Control what happens on delete/update:

```typescript
entity.hasOne(e => e.user, () => User)
  .withForeignKey(p => p.userId)
  .withPrincipalKey(u => u.id)
  .onDelete('cascade')      // cascade | restrict | set null | set default | no action
  .onUpdate('cascade')      // cascade | restrict | set null | set default | no action
  .isRequired();
```

### Bidirectional Relationships

Configure both sides of the relationship:

```typescript
// User entity - one side
model.entity(User, entity => {
  entity.hasMany(e => e.posts, () => Post)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id);
});

// Post entity - many side
model.entity(Post, entity => {
  entity.hasOne(e => e.user, () => User)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id)
    .onDelete('cascade')
    .isRequired();
});
```

### Composite Foreign Keys

You can define relationships with multiple join keys (composite foreign keys):

```typescript
// Entity with composite key
export class OrderItem extends DbEntity {
  orderId!: DbColumn<number>;
  productId!: DbColumn<number>;
  quantity!: DbColumn<number>;

  order?: Order;
}

export class Order extends DbEntity {
  id!: DbColumn<number>;
  customerId!: DbColumn<number>;
  items?: OrderItem[];
}

// DbContext configuration with composite keys
model.entity(OrderItem, entity => {
  entity.toTable('order_items');

  // Define composite foreign key using arrays
  entity.hasOne(e => e.order, () => Order)
    .withForeignKey([
      oi => oi.orderId,
      oi => oi.productId
    ])
    .withPrincipalKey([
      o => o.id,
      o => o.customerId
    ])
    .onDelete('cascade')
    .isRequired();
});

// One-to-many side with composite keys
model.entity(Order, entity => {
  entity.hasMany(e => e.items, () => OrderItem)
    .withForeignKey([
      oi => oi.orderId,
      oi => oi.productId
    ])
    .withPrincipalKey([
      o => o.id,
      o => o.customerId
    ]);
});
```

**Note:** When using composite foreign keys, both `withForeignKey()` and `withPrincipalKey()` must receive arrays with the same number of lambda expressions, and they are matched by position.

## Indexes

Add indexes for better query performance:

### Single Column Index

```typescript
model.entity(User, entity => {
  entity.hasIndex('ix_users_email', e => [e.email]);
});
```

### Composite Index

```typescript
model.entity(Post, entity => {
  entity.hasIndex('ix_posts_user_published', e => [e.userId, e.publishedAt]);
});
```

### Multiple Indexes

```typescript
model.entity(Order, entity => {
  // Index on user and status for filtering
  entity.hasIndex('ix_orders_user_status', e => [e.userId, e.status]);

  // Index on createdAt for date-based queries
  entity.hasIndex('ix_orders_created', e => [e.createdAt]);
});
```

## Constraints

### Primary Key

```typescript
// Modern identity column (preferred)
entity.property(e => e.id)
  .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'table_id_seq' }));
```

### Unique Constraint

```typescript
entity.property(e => e.username)
  .hasType(varchar('username', 100))
  .isUnique();

// Or with custom constraint name
entity.property(e => e.email)
  .hasType(text('email'))
  .isUnique('UQ_users_email');
```

### Not Null

```typescript
entity.property(e => e.email)
  .hasType(text('email'))
  .isRequired();  // Adds NOT NULL constraint
```

### Check Constraints

Use default values to enforce constraints:

```typescript
entity.property(e => e.age)
  .hasType(integer('age'))
  .hasDefaultValue(0);
```

## Sequences

PostgreSQL sequences are used for auto-incrementing columns. Linkgress ORM provides full support for creating and managing sequences.

### Identity Columns (Recommended)

Modern PostgreSQL uses identity columns, which automatically create and manage sequences:

```typescript
// GENERATED ALWAYS AS IDENTITY (recommended)
entity.property(e => e.id)
  .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({
    name: 'users_id_seq'
  }));

// GENERATED BY DEFAULT AS IDENTITY (allows manual values)
entity.property(e => e.id)
  .hasType(integer('id').primaryKey().generatedByDefaultAsIdentity({
    name: 'users_id_seq'
  }));
```

### Sequence Configuration Options

You can configure sequence behavior with various options:

```typescript
entity.property(e => e.id)
  .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({
    name: 'users_id_seq',
    startWith: 1000,        // Start sequence at 1000
    incrementBy: 1,         // Increment by 1 (default)
    minValue: 1,            // Minimum value
    maxValue: 2147483647,   // Maximum value (int max)
    cache: 1,               // Cache size
    cycle: false            // Don't cycle when reaching max
  }));
```

### Shared Sequences

Multiple tables can share the same sequence:

```typescript
// Create a shared sequence
model.entity(User, entity => {
  entity.property(e => e.id)
    .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({
      name: 'shared_id_seq'
    }));
});

model.entity(Post, entity => {
  entity.property(e => e.id)
    .hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({
      name: 'shared_id_seq'  // Same sequence name
    }));
});
```

### Working with Sequences

You can interact with sequences directly through the DbContext:

```typescript
// Get current sequence value
const currentValue = await db.getCurrentSequenceValue('users_id_seq');

// Get next sequence value
const nextValue = await db.getNextSequenceValue('users_id_seq');

// Set sequence value
await db.setSequenceValue('users_id_seq', 5000);

// Reset sequence to start value
await db.resetSequence('users_id_seq');
```

**Note:** The sequence methods are available on your DbContext instance and can be used for managing sequences programmatically.

## Default Values

Set default values for columns:

### Static Defaults

```typescript
entity.property(e => e.isActive)
  .hasType(boolean('is_active'))
  .hasDefaultValue(true);

entity.property(e => e.status)
  .hasType(varchar('status', 20))
  .hasDefaultValue('pending');

entity.property(e => e.count)
  .hasType(integer('count'))
  .hasDefaultValue(0);
```

### SQL Function Defaults

```typescript
entity.property(e => e.createdAt)
  .hasType(timestamp('created_at'))
  .hasDefaultValue('NOW()');

entity.property(e => e.guid)
  .hasType(uuid('guid'))
  .hasDefaultValue('gen_random_uuid()');
```

## Custom Types

Create custom type mappers for complex types:

### Define Custom Type

```typescript
import { customType, CustomType } from 'linkgress-orm';

// Custom type for time as "HH:MM" string
export interface HourMinute {
  hours: number;
  minutes: number;
}

export const pgHourMinute: CustomType<HourMinute, number> = customType<HourMinute, number>({
  // Convert from app (HourMinute) to database (number - minutes since midnight)
  toDriver: (value: HourMinute): number => {
    return value.hours * 60 + value.minutes;
  },

  // Convert from database (number) to app (HourMinute)
  fromDriver: (value: number): HourMinute => {
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return { hours, minutes };
  }
});
```

### Use Custom Type in Entity

```typescript
export class Post extends DbEntity {
  id!: DbColumn<number>;
  publishTime!: DbColumn<HourMinute>;  // App sees HourMinute type
}
```

### Configure Custom Type

```typescript
model.entity(Post, entity => {
  entity.property(e => e.publishTime)
    .hasType(smallint('publish_time'))  // Database stores as smallint
    .hasCustomMapper(pgHourMinute);     // Use custom mapper
});
```

## Complete Example

Here's a complete schema configuration:

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
  decimal,
  jsonb,
} from 'linkgress-orm';

export class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> { return this.table(User); }
  get posts(): DbEntityTable<Post> { return this.table(Post); }
  get orders(): DbEntityTable<Order> { return this.table(Order); }

  protected override setupModel(model: DbModelConfig): void {
    // Configure User
    model.entity(User, entity => {
      entity.toTable('users');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired().isUnique();
      entity.property(e => e.email).hasType(text('email')).isRequired();
      entity.property(e => e.age).hasType(integer('age'));
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
      entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
      entity.property(e => e.metadata).hasType(jsonb('metadata'));

      entity.hasMany(e => e.posts, () => Post).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
      entity.hasMany(e => e.orders, () => Order).withForeignKey(o => o.userId).withPrincipalKey(u => u.id);
    });

    // Configure Post
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

      entity.hasIndex('ix_posts_user_published', e => [e.userId, e.publishedAt]);
    });

    // Configure Order
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

      entity.hasIndex('ix_orders_user_status', e => [e.userId, e.status]);
      entity.hasIndex('ix_orders_created', e => [e.createdAt]);
    });
  }
}
```

## Next Steps

- **[Querying Guide](./querying.md)** - Learn how to query your configured schema
- **[Insert/Update/Upsert/BULK](./insert-update-guide.md)** - Insert, update, and delete operations
