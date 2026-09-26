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
  - [Expression Indexes](#expression-indexes)
  - [Normalized (accent/case-insensitive) Indexes](#normalized-accentcase-insensitive-indexes)
  - [Partial Indexes](#partial-indexes)
  - [GIN/GiST Indexes](#gingist-indexes)
- [Collations](#collations)
- [Constraints](#constraints)
- [Views](#views)
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

### Array Types

PostgreSQL array columns can be defined using the `.array()` method:

```typescript
// String array
entity.property(e => e.tags)
  .hasType(varchar('tags', 50).array());

// Integer array
entity.property(e => e.scores)
  .hasType(integer('scores').array());

// With TypeScript type override for better type inference
entity.property(e => e.permissions)
  .hasType(integer('permissions').array().hasTypescriptType<Permission[]>());
```

A JS array written to such a column — by an insert, update, upsert, merge, bulk operation, or compared
in a condition — binds as a PostgreSQL array LITERAL (`{"a","b,c"}`), the one form every driver
accepts (Bun's SQL client cannot bind a JS array to an array parameter). Elements are escaped as the
literal needs: strings quoted, `null` as NULL, a `Date` as its ISO instant, bytes in the bytea hex form,
a plain object as its JSON text (for `jsonb[]`), nested arrays as a multidimensional literal. A mapper
of the column's own (`hasCustomMapper`, `mapWith`) replaces this and then binds the whole array itself.

The entity property should be typed as an array:

```typescript
export class Post extends DbEntity {
  id!: DbColumn<number>;
  tags!: DbColumn<string[]>;
  scores?: DbColumn<number[]>;
  permissions!: DbColumn<Permission[]>;
}
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

### One-to-One Relationships with Inverse Navigation

For one-to-one relationships where you want navigation from both sides but only one foreign key constraint, use `isInverseNavigation()`:

```typescript
// Entity classes
export class UserProfile extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;  // FK to User
  bio!: DbColumn<string>;
  user?: User;
}

export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  profile?: UserProfile;  // Inverse navigation
}

// DbContext configuration
model.entity(UserProfile, entity => {
  entity.toTable('user_profiles');

  // This side has the FK constraint
  entity.hasOne(e => e.user, () => User)
    .withForeignKey(p => p.userId)
    .withPrincipalKey(u => u.id)
    .onDelete('cascade');
});

model.entity(User, entity => {
  entity.toTable('users');

  // This is the inverse side - no FK constraint created
  entity.hasOne(e => e.profile, () => UserProfile)
    .withForeignKey(u => u.id)
    .withPrincipalKey(p => p.userId)
    .isInverseNavigation();  // <-- Marks as inverse, no FK created
});
```

**When to use `isInverseNavigation()`:**
- One-to-one relationships where both entities need navigation properties
- The FK constraint should only exist on one side
- Prevents duplicate foreign key constraints in the database

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
  entity.toTable('order_lines');

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

### Unique Index

Use `.isUnique()` to create a unique constraint index:

```typescript
model.entity(Product, entity => {
  // Unique composite index - enforces uniqueness across multiple columns
  entity.hasIndex('ix_product_unique', e => [
    e.productSource,
    e.productSubtype,
    e.entityId,
  ]).isUnique();

  // Regular non-unique index for query optimization
  entity.hasIndex('ix_product_name', e => [e.name]);
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

### Expression Indexes

Use `ixLower` and `ixUnaccent` helpers inside the selector to create expression-based indexes. The helpers compose naturally:

```typescript
import { ixLower, ixUnaccent } from 'linkgress-orm';

model.entity(Member, entity => {
  // lower("name")
  entity.hasIndex('ix_name_lower', e => [ixLower(e.name)]);

  // lower(unaccent("name")) — composable
  entity.hasIndex('ix_name_ci_ai', e => [ixLower(ixUnaccent(e.name))]);

  // Multiple expression columns
  entity.hasIndex('ix_multi', e => [ixLower(e.name), ixLower(e.email)]);

  // Mixed: plain column + expression
  entity.hasIndex('ix_mixed', e => [e.id, ixLower(e.name)]);
});
```

For other expressions use `.withExpression()` — raw SQL as an escape hatch, or, better, a builder over
the table's columns, so the index and the queries that must use it share ONE definition:

```typescript
import { literal, lower, regexpReplace, sql } from 'linkgress-orm';

// raw SQL, kept as written
entity.hasIndex('ix_jsonb_key')
  .withExpression('(data->>\'key\')::int');

// builders — declare them once, use them in the index AND in the query
const tailKey = (n: SqlOperand<number>) => sql<number>`${n} % ${literal(10000000, 'bigint')}`;
const digitsKey = (code: SqlOperand<string>) => regexpReplace(code, literal('[^0-9]'), literal(''), literal('g'));

entity.hasIndex('ix_shipment_serial_tail').withExpression(e => tailKey(e.serial));
// → CREATE INDEX "ix_shipment_serial_tail" ON … (("serial" % CAST(10000000 AS bigint)))
entity.hasIndex('ix_shipment_label_digits').withExpression(e => digitsKey(e.labelCode));
// → CREATE INDEX "ix_shipment_label_digits" ON … (regexp_replace("label_code", '[^0-9]', '', 'g'))

// the same builder in a query matches the index expression, so the planner uses the index
db.shipments.where(s => eq(tailKey(s.serial), 1234567)).toList();
```

- The builder receives the table's columns UNQUALIFIED (`"serial"`), carrying their mapper and SQL type
  so type-dependent helpers render as they do in a query. Navigations are not in scope; declare the
  properties an expression reads before the index.
- Constants must be inline — `literal(…)`: an index is matched by its expression TREE, and a bound
  parameter is no constant there. An expression that binds a parameter (or a placeholder) throws.
- The text is kept verbatim when it is one function call or one parenthesised group, and wrapped in
  `( … )` otherwise — a top-level `CAST(…)` included, which PostgreSQL prints as `((x)::t)` — the
  spelling PostgreSQL's `pg_get_indexdef` prints, so `migrate()` recognises an existing index as unchanged
  without rebuilding it. The reconcile also treats `CAST(x AS t)` like `x::t`, keeping the grouping of a
  compound `x`: `CAST(a + b AS bigint) * 2` compares equal to `(a + b)::bigint * 2`, and differs from
  `a + b * 2`.
- `hasStatistics(…).withExpression(…)` takes the same builders.

### Normalized (accent/case-insensitive) Indexes

`ixNormalized` wraps a column in `public.search_normalize()` — an accent- and
case-insensitive normalization function the ORM creates for you (along with the
`unaccent` extension) during migration. It pairs with the
[normalized query helpers](./querying.md#normalized-accentcase-insensitive-search).

```typescript
import { ixNormalized } from 'linkgress-orm';

model.entity(User, entity => {
  // Unique normalized lookup — btree expression index
  entity.hasIndex('member_login_query', e => [ixNormalized(e.email), e.hash]).isUnique();
  // → CREATE UNIQUE INDEX ... (public.search_normalize(email), hash)

  // Fuzzy substring search — trigram GIN index (installs pg_trgm, defaults gin_trgm_ops)
  entity.hasIndex('user_name_search', e => [ixNormalized(e.username, { gin: true })]);
  // → CREATE INDEX ... USING gin (public.search_normalize(username) gin_trgm_ops)
});
```

- Declaring any `ixNormalized` index auto-creates the `unaccent` extension and
  the `search_normalize` function before the index is built — no manual SQL.
- The btree form uses `text_pattern_ops`, so a single index serves both
  `normalizedEq` (`=`) and `normalizedStartsWith` (`LIKE 'prefix%'`) as index
  scans even on non-`C`-locale databases — and still enforces accent/case-insensitive
  uniqueness. `{ gin: true }` opts into a trigram GIN index for substring search
  (`normalizedLike('%x%')`). A **UNIQUE** GIN index is rejected — GIN can't be unique.
- Keep `ixNormalized` the outermost helper (don't wrap it with `ixLower` etc.).
- If you use the normalized query helpers **without** an `ixNormalized` index,
  call `model.useSearchNormalize()` in `setupModel` so the function is created.

### Partial Indexes

Add `.where()` to create a partial index — the index only covers rows matching the condition:

```typescript
model.entity(User, entity => {
  // Unique email only among active users
  entity.hasIndex('ix_active_users_email', e => [e.email])
    .isUnique()
    .where('active = true');

  // Expression + WHERE combined
  entity.hasIndex('ix_active_name', e => [ixLower(e.name)])
    .where('deleted_at IS NULL');
});
```

### Covering Indexes (INCLUDE)

Use `.include()` to add non-key columns to an index. They are stored in the index entries but
are not part of the key, so a query that filters on the key columns can read them without
touching the table (an index-only scan):

```typescript
model.entity(Loan, entity => {
  // Key: (book_id, is_active). Covering: the loan window and the reader.
  entity.hasIndex('ix_loans_book', e => [e.bookId, e.isActive])
    .include(e => [e.loanedAt, e.returnedAt, e.readerId]);
  // → CREATE INDEX ... ("book_id", "is_active") INCLUDE ("loaned_at", "returned_at", "reader_id")

  // One active loan per book; the reader rides along without joining the unique key.
  entity.hasIndex('uq_loans_active_book', e => [e.bookId])
    .isUnique()
    .include(e => [e.readerId])
    .where('is_active');
});
```

- Prefer `.include()` over extra key columns for columns a query only reads, or filters on after
  the seek. Key columns become usable as index conditions (PostgreSQL 18's skip scan reaches past a
  low-cardinality column), and the planner may then combine them — for example to answer an `OR`
  — into a bitmap scan, which always visits the table. INCLUDE columns can only be filtered, so
  the index-only scan stays the plan.
- On a unique index, INCLUDE columns take no part in the uniqueness check.
- Plain columns only (no expressions), and only on `btree`, `gist` and `spgist` indexes; `gin`,
  `hash` and `brin` are rejected with an error.
- The INCLUDE list is part of the definition the migrator compares (see
  [Changing an Index](#changing-an-index-same-name-different-definition)): adding, removing or
  changing it recreates the index.

### GIN/GiST Indexes

Use `.using()` to set the index method and `.withOperatorClass()` for operator classes:

```typescript
model.entity(User, entity => {
  // GIN trigram index for ILIKE substring search
  entity.hasIndex('ix_users_gin_email', e => [e.email])
    .using('gin')
    .withOperatorClass('gin_trgm_ops');

  // GiST index
  entity.hasIndex('ix_users_gist_name', e => [e.name])
    .using('gist')
    .withOperatorClass('gist_trgm_ops');

  // BRIN index (good for naturally ordered data like timestamps)
  entity.hasIndex('ix_users_brin_created', e => [e.createdAt])
    .using('brin');
});
```

Supported index methods: `btree`, `gin`, `gist`, `hash`, `brin`, `spgist`.

### Changing an Index (same name, different definition)

Automatic migration (`migrate()`) compares the **full definition** of each index
against what PostgreSQL actually stores. If you change *how* a column is indexed
— operator class, expression, method (`btree`→`gin`), uniqueness, columns, the
`.include()` list, or the partial `where` predicate — while keeping the **same index
name**, the migrator
drops and recreates it so the change takes effect:

```typescript
// before: entity.hasIndex('ix_users_email', e => [e.email]);
// after — same name, now accent/case-insensitive + prefix-searchable:
entity.hasIndex('ix_users_email', e => [ixNormalized(e.email)]);

await db.getSchemaManager().migrate();
// → Recreate index "ix_users_email" on "users" (changed: columns (...) -> (...))
```

This is **on by default**. The recreate is **non-blocking**
(`DROP/CREATE INDEX CONCURRENTLY`) when the index opts into concurrency — either
per-index with `.concurrent()` or globally:

```typescript
// non-blocking recreate of any changed index
await db.getSchemaManager({ concurrentIndexes: true }).migrate();

// opt out entirely — legacy behavior, a same-named index is never touched
await db.getSchemaManager({ recreateChangedIndexes: false }).migrate();
```

This works for `.where()` **partial indexes** too, including predicates
PostgreSQL rewrites at parse time (`active = true`, `deleted_at IS NULL`,
`status IN ('a','b')`, `age BETWEEN 1 AND 10`, `created_at > '2020-01-01'`, …).

**An index is recreated only when PostgreSQL itself confirms the definition
changed.** A fast string comparison flags *candidates*; before any rebuild, the
model's index is re-created on an empty mirror table and PostgreSQL's own
`pg_get_indexdef` of both sides is compared. Because both forms come from
PostgreSQL's deparser, a definition that merely *looks* different — an expanded
timestamp literal, re-parenthesized arithmetic, a hidden default operator class —
is recognized as identical and **left untouched**.

Notes:

- An **unchanged** index is never rebuilt, even when the model's SQL is spelled
  differently from what PostgreSQL stores (e.g. the `::text` cast it injects for
  `ixNormalized` indexes on `varchar` columns).
- If the confirmation step can't run (a read-only session, or `search_normalize`
  support not yet created outside `migrate()`), it fails *closed* — the index is
  left as-is rather than rebuilt.
- `INCLUDE`/`COLLATE`/storage-parameter clauses the model can't express are left
  alone (so a change to one of those isn't auto-detected).
- The recreate has a brief window with no index while it rebuilds; prefer the
  `concurrent` form on large production tables.

## Collations

Define custom PostgreSQL collations for locale-aware or case/accent-insensitive text handling.

### Defining a Collation

```typescript
import { pgCollation } from 'linkgress-orm';

// Case-insensitive, accent-insensitive collation using ICU
const ndCiAi = pgCollation({
  name: 'nd_ci_ai',
  provider: 'icu',
  locale: 'und-u-ks-level1',
  deterministic: false,
});
```

This produces:
```sql
CREATE COLLATION "nd_ci_ai" (provider = 'icu', locale = 'und-u-ks-level1', deterministic = false);
```

### Using a Collation on Columns

Attach a collation to a column with `.hasCollation()`:

```typescript
model.entity(Member, entity => {
  entity.toTable('member');

  entity.property(e => e.name)
    .hasType(varchar('name', 200))
    .isRequired()
    .hasCollation(ndCiAi);  // Case & accent insensitive

  entity.property(e => e.email)
    .hasType(varchar('email', 255))
    .isRequired();  // Uses database default collation
});
```

The column definition becomes:
```sql
"name" varchar(200) COLLATE "nd_ci_ai" NOT NULL
```

With `nd_ci_ai`, queries like `WHERE name = 'jan'` will match `'Ján'`, `'JAN'`, `'ján'`, etc.

### Collation Lifecycle

- **`ensureCreated()`** — creates collations before tables
- **`analyze()`** — detects missing collations and collation mismatches on existing columns
- **`migrate()`** — applies `CREATE COLLATION` and `ALTER COLUMN ... COLLATE` automatically
- **`MigrationScaffold`** — generates `CREATE COLLATION IF NOT EXISTS` / `DROP COLLATION IF EXISTS`

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

## Views

Declare a database VIEW in the model and linkgress keeps it in sync:

```typescript
class OrderSummary extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  amountEur!: DbColumn<number>;
}

model.view(OrderSummary, view => {
  view.toView('order_summary');
  view.definedAs(`SELECT o."id", o."label", o."amount" / 100 AS "amount_eur" FROM "orders" o`);
  view.property(e => e.id).hasType(integer('id'));
  view.property(e => e.label).hasType(varchar('label', 50));
  view.property(e => e.amountEur).hasType(integer('amount_eur'));
});

// on the context — read-only:
get orderSummaries(): DbViewTable<OrderSummary> {
  return this.view(OrderSummary);
}
```

- `ensureCreated()` creates views after the tables; `ensureDeleted()` drops them first.
- `migrate()` stamps each view with `COMMENT ON VIEW … IS 'linkgress:view:sha256:<hash>'` and re-creates it
  when the definition's hash changes, when the view is missing, or when the migration changes any column or
  table — PostgreSQL refuses a column type change under a dependent view, so every managed view is dropped
  first and re-created last.
- Declare a view AFTER the views it reads: when a view has to be dropped, every view declared after it is
  dropped before it and re-created after it (PostgreSQL refuses to drop a view another view reads). Removing
  a view from the model does not drop it — drop it in a migration.
- A re-create is a `DROP VIEW` + `CREATE VIEW`, so everything attached to the old view object goes with it:
  privileges granted on it, a changed owner, and any comment other than the linkgress marker (which is
  written again). `ensureCreated()` re-creates every view. A role that only READS the view — a read-replica
  user, a reporting tool — should get its access from `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES`
  for the migrating role (views count as tables there), or from a grant your `onMigrationComplete` re-applies.
- `DbViewTable` has no insert / update / delete, and `update()` / `delete()` on a query over a view throw.

### Defining a view with a linkgress query

Instead of SQL text, `definedAs` takes the view's query written with the query builder — joins,
navigations, aggregates, `groupBy`, unions, CTEs and `sql` fragments included:

```typescript
model.view(OrderStats, view => {
  view.toView('order_stats');
  view.definedAs((db: AppDatabase) => db.orders
    .where(o => gt(o.amount, 0))
    .select(o => ({
      id: o.id,
      label: o.label,
      amountEur: sql<number>`${o.amount} / 100`,
      lineCount: o.lines.count(),
    })));
  view.property(e => e.id).hasType(integer('id'));
  view.property(e => e.label).hasType(varchar('label', 50));
  view.property(e => e.amountEur).hasType(integer('amount_eur'));
  view.property(e => e.lineCount).hasType(integer('line_count'));
});
```

- The projection's keys are the view's property names. The compiler checks that every property is
  projected; at render time a missing, an extra or a nested key is refused with its name.
- The context renders the query when a schema manager needs it (`getSchemaManager()`, so
  `ensureCreated()` / `analyze()` / `migrate()`): the projection is renamed to the properties' column
  names, in declaration order (`"amountEur"` becomes the `amount_eur` column), and the query's bound
  values are inlined as SQL literals — a view cannot carry parameters, so `sql.placeholder()` is refused.
- The rendered SQL is what the marker hashes: changing the query — a constant included — re-creates
  the view on the next migrate. Array aggregations always render natively, whatever the driver, so
  the view's SQL does not depend on which client ran the migration.
- A view can read another view through its `DbViewTable` (`db.orderStats.where(…).select(…)`); declare
  it after the view it reads.
- A view that joins the way hand-written SQL does — on a computed key — uses explicit joins. The joined
  row's navigations and collections work like the root's: a navigation renders as a LEFT JOIN off the
  join's alias (`posts_0__user`), a collection correlates to that alias. Put a join whose ON clause reads
  another join after it; to keep a count `integer` (`COUNT(*)` is `bigint`), cast it in a fragment:

  ```typescript
  view.definedAs((db: AppDatabase) => db.lines
    .innerJoin(db.orders, (line, order) => eq(order.id, line.orderId), (line, order) => ({
      lineId: line.id,
      customer: order.customer.name,                           // a navigation of the joined order
      orderLineCount: sql<number>`${order.lines.count()}::int`, // a collection of it, cast
      orderLineQtys: order.lines.orderBy(l => l.qty).select(l => ({ qty: l.qty })).toNumberList(),
    })));
  ```

  Each join's selector sees the previous join's projection as FLAT values, so project what later joins
  need (keys, finished columns) and list the view's columns in the last selector.

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

### Custom Sequences (DbSequence)

You can define custom sequences in your DbContext for generating unique IDs, order numbers, or any sequential values:

```typescript
import { DbContext, DbSequence, sequence } from 'linkgress-orm';

export class AppDatabase extends DbContext {
  // Sequence accessors - similar to table accessors
  get orderNumberSeq(): DbSequence {
    return this.sequence(
      sequence('order_number_seq')
        .startWith(1000)
        .incrementBy(1)
        .build()
    );
  }

  get customerCodeSeq(): DbSequence {
    return this.sequence(
      sequence('customer_code_seq')
        .inSchema('public')
        .startWith(100)
        .incrementBy(5)
        .cache(20)  // Cache 20 values for performance
        .build()
    );
  }

  // Register sequences in setupSequences
  protected override setupSequences(): void {
    this.orderNumberSeq;
    this.customerCodeSeq;
  }
}
```

### Using Sequences

```typescript
// Get next value (increments the sequence)
const orderNum = await db.orderNumberSeq.nextValue();
console.log(`Order: ORD-${orderNum}`);  // ORD-1000, ORD-1001, ...

// Get current value (without incrementing)
const current = await db.orderNumberSeq.currentValue();

// Resync sequence to a specific value
await db.orderNumberSeq.resync(5000);

// Get sequence configuration
const config = db.orderNumberSeq.getConfig();
console.log(config.name, config.startWith, config.incrementBy);

// Get qualified name (with schema if applicable)
const name = db.customerCodeSeq.getQualifiedName();  // "public"."customer_code_seq"
```

### Sequence Builder Options

```typescript
sequence('my_sequence')
  .inSchema('public')      // Schema name (optional)
  .startWith(1000)         // Starting value
  .incrementBy(5)          // Increment step
  .minValue(1)             // Minimum value
  .maxValue(999999)        // Maximum value
  .cache(20)               // Number of values to cache
  .cycle()                 // Restart when reaching max/min
  .build()
```

**Note:** Custom sequences are automatically created during `ensureCreated()` and `migrate()` operations.

### Runtime-Named Sequences (`runtimeSequence`)

A sequence whose name is computed at run time — one per tenant and year, say — is declared by no model.
`db.runtimeSequence(config)` gives a `DbSequence` for it, and `nextValueCreatingIfMissing()` creates it
on first use:

```typescript
const number = await db
  .runtimeSequence({ name: `seq_doc_${tenantId}_${year}`, startWith: 1, incrementBy: 1, minValue: 1, cache: 1 })
  .nextValueCreatingIfMissing();
// SELECT nextval($1::regclass) as value                         -- $1 = '"seq_doc_7_2026"'
// only when that fails with 42P01 (no such relation):
// CREATE SEQUENCE IF NOT EXISTS "seq_doc_7_2026" START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1
// SELECT nextval($1::regclass) as value
```

- The CREATE runs only on SQLSTATE 42P01. A concurrent first use that loses the race to create the
  sequence still draws: PostgreSQL reports the loser's CREATE as 23505 (it waited on the winner's
  uncommitted catalog row) or 42P07 (the winner committed between the loser's `IF NOT EXISTS` check and
  its own insert), and both — and 42710 — are swallowed. Any other error propagates, and the second
  `nextval` is not retried. Any other error of the first `nextval` propagates without a CREATE.
- Not registered: the schema manager never creates, compares or drops a runtime sequence.
- Bound to the context's ROOT client, also when called on a transaction's context: a CREATE made inside a
  caller's transaction would be undone by its rollback (restarting the numbering), and a failed first
  `nextval` would abort the transaction. A drawn value is consumed whatever the caller does next.
- …which has two consequences when you call it on a transaction's context (`tx.runtimeSequence(…)`):
  - **A second pool connection per call.** The transaction holds one connection and the sequence needs
    another from the same pool. When as many transactions as the pool has connections each wait for
    one, none gets it — and a `pg.Pool` has no connection timeout by default, so they wait forever.
    Draw before opening the transaction, or keep the pool larger than the number of concurrent
    transactions that draw (and set `connectionTimeoutMillis`).
  - **PGlite refuses it.** PGlite has a single session, held by the transaction, so the call fails at
    once (`PGliteClient: PGlite has a single session, and the transaction running this callback holds
    it — …`). Call `db.runtimeSequence(…)` outside `transaction()`.
- Unlogged: the statements go to the client directly, like `nextValue()`.
- The name is an identifier, never SQL: quoted (a `"` is doubled, a NUL refused) and schema-qualified
  when `schema` is set. The options are inlined in the DDL, so each must be an integer within `bigint`
  (-2^63 … 2^63-1): a number — also above 2^53 — or a JS `bigint`; a fraction, NaN, ±Infinity or a
  value outside that range throws before any SQL. The same rule applies to the sequences the schema
  manager creates, which share the options renderer.

## Default Values

Set default values for columns. The `hasDefaultValue()` method passes string values directly to PostgreSQL as raw SQL, giving you full control over the default expression.

### Numeric and Boolean Defaults

```typescript
entity.property(e => e.isActive)
  .hasType(boolean('is_active'))
  .hasDefaultValue(true);

entity.property(e => e.count)
  .hasType(integer('count'))
  .hasDefaultValue(0);
```

### String Literal Defaults

Since strings are passed through as raw SQL, you must include SQL quotes for string literals:

```typescript
// IMPORTANT: Include single quotes for string literals
entity.property(e => e.status)
  .hasType(varchar('status', 20))
  .hasDefaultValue("'pending'");

// For enum columns, include the quotes
entity.property(e => e.category)
  .hasType(enumColumn('category', categoryEnum))
  .hasDefaultValue("'tech'");
```

### SQL Function Defaults

SQL functions and expressions work directly:

```typescript
entity.property(e => e.createdAt)
  .hasType(timestamp('created_at'))
  .hasDefaultValue('NOW()');

entity.property(e => e.guid)
  .hasType(uuid('guid'))
  .hasDefaultValue('gen_random_uuid()');

entity.property(e => e.updatedAt)
  .hasType(timestamptz('updated_at'))
  .hasDefaultValue('CURRENT_TIMESTAMP');
```

### Using sql.raw() for Complex Defaults

For complex SQL expressions, you can use `sql.raw()` which also passes through without formatting:

```typescript
import { sql } from 'linkgress-orm';

// Array default
entity.property(e => e.tags)
  .hasType(varchar('tags', 50).array())
  .hasDefaultValue(sql.raw("'{}'::varchar[]"));

// JSONB default
entity.property(e => e.metadata)
  .hasType(jsonb('metadata'))
  .hasDefaultValue(sql.raw("'{}'::jsonb"));

// Complex expression
entity.property(e => e.expiredAt)
  .hasType(timestamp('expired_at'))
  .hasDefaultValue(sql.raw("NOW() + INTERVAL '30 days'"));
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
      entity.property(e => e.status).hasType(varchar('status', 20)).hasDefaultValue("'pending'");
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
