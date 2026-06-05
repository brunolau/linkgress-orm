# Database Migrations Guide

This guide covers database migrations using Linkgress ORM, including automatic migrations, manual file-based migrations with journal tracking, schema creation/deletion, and integration with your development workflow.

## Table of Contents

- [Overview](#overview)
- [DbSchemaManager](#dbschemamanager)
- [Automatic Migrations](#automatic-migrations)
  - [How It Works](#how-it-works)
  - [Running Migrations](#running-migrations)
  - [Interactive Confirmations](#interactive-confirmations)
- [Manual Migrations (File-Based)](#manual-migrations-file-based)
  - [Overview](#manual-migrations-overview)
  - [Migration Files](#migration-files)
  - [MigrationRunner](#migrationrunner)
  - [MigrationScaffold](#migrationscaffold)
  - [Migration Status](#migration-status)
  - [Rolling Back Migrations](#rolling-back-migrations)
- [Schema Creation and Deletion](#schema-creation-and-deletion)
  - [ensureCreated](#ensurecreated)
  - [ensureDeleted](#ensuredeleted)
- [Post-Migration Hooks](#post-migration-hooks)
- [NPM Script Integration](#npm-script-integration)
- [Migration Operations](#migration-operations)

## Overview

Linkgress ORM provides a powerful schema management system with two approaches to database migrations:

1. **Automatic Migrations** - Analyze your entity models and automatically synchronize them with your database schema
2. **Manual Migrations** - File-based migrations with journal tracking, up/down support, and scaffolding

**Features:**
- Automatic migrations based on model comparison
- Manual file-based migrations with journal tracking
- Migration scaffolding from schema differences
- Up/down migration support with rollback capabilities
- Interactive confirmations for destructive operations
- Schema creation from scratch
- Complete schema deletion
- Post-migration hooks for custom SQL

## DbSchemaManager

The `DbSchemaManager` is the core class responsible for all schema operations. You access it through your `DbContext`:

```typescript
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'postgres',
});

const db = new AppDatabase(client);

// Get the schema manager
const schemaManager = db.getSchemaManager();
```

## Automatic Migrations

Automatic migrations analyze your entity model definitions and compare them with your actual database schema, then generate and apply the necessary changes.

### How It Works

The migration process follows these steps:

1. **Schema Analysis** - Reads your current database schema
2. **Model Comparison** - Compares database schema with entity models
3. **Operation Generation** - Creates a list of migration operations
4. **User Review** - Displays all planned operations
5. **Confirmation** - Prompts for confirmation on destructive operations (drops)
6. **Execution** - Applies changes sequentially
7. **Post-Migration** - Executes optional post-migration hooks

### Running Migrations

```typescript
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

async function migrate() {
  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client);

  try {
    const schemaManager = db.getSchemaManager();

    // Run automatic migration
    await schemaManager.migrate();

    console.log('✓ Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await db.dispose();
  }
}

migrate().catch(console.error);
```

### Interactive Confirmations

When the migration includes destructive operations (dropping tables or columns), you'll be prompted for confirmation:

```
Pending migrations:
  1. Add column 'users.phone_number' (VARCHAR(20))
  2. Drop column 'users.old_field'
  3. Create index 'ix_users_email'

⚠️  Warning: This migration includes destructive operations that will result in data loss:
  - Drop column 'users.old_field'

Do you want to continue? (y/N): _
```

**Non-Interactive Mode:**
In non-TTY environments (CI/CD pipelines), the migration will default to the safe option (abort if destructive operations are detected).

### Migration Operations

The automatic migrator can detect and handle the following changes:

**Schema Level:**
- Create PostgreSQL schemas
- Create ENUM types
- Create sequences

**Table Level:**
- Create new tables
- Drop existing tables

**Column Level:**
- Add new columns
- Drop columns
- Alter column types
- Change column nullability
- Modify default values

**Index Level:**
- Create indexes
- Drop indexes

**Constraint Level:**
- Create foreign keys
- Drop foreign keys
- Modify foreign key actions (CASCADE, SET NULL, etc.)

## Schema Creation and Deletion

For development and testing, you can create or drop entire schemas programmatically.

### ensureCreated()

Creates all database objects from your entity models. This is useful for:
- Initial development setup
- Automated testing (create fresh schema for each test)
- Seeding new environments

```typescript
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

async function setupDatabase() {
  const client = new PgClient({
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'postgres',
    password: 'postgres',
  });

  const db = new AppDatabase(client);

  try {
    const schemaManager = db.getSchemaManager();

    // Create all schemas, tables, indexes, and constraints
    await schemaManager.ensureCreated();

    console.log('✓ Database schema created successfully');
  } catch (error) {
    console.error('Schema creation failed:', error);
    throw error;
  } finally {
    await db.dispose();
  }
}

setupDatabase().catch(console.error);
```

**Creation Order:**
1. PostgreSQL schemas (e.g., `CREATE SCHEMA auth`)
2. ENUM types
3. Sequences
4. Tables with columns and constraints
5. Foreign keys
6. Indexes
7. Post-migration hooks (if configured)

### ensureDeleted()

Drops all database objects managed by the ORM. Use with caution - this is a destructive operation!

```typescript
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

async function teardownDatabase() {
  const client = new PgClient({
    host: 'localhost',
    port: 5432,
    database: 'myapp_test',
    user: 'postgres',
    password: 'postgres',
  });

  const db = new AppDatabase(client);

  try {
    const schemaManager = db.getSchemaManager();

    // Drop all tables, sequences, enums, and schemas
    await schemaManager.ensureDeleted();

    console.log('✓ Database schema deleted successfully');
  } catch (error) {
    console.error('Schema deletion failed:', error);
    throw error;
  } finally {
    await db.dispose();
  }
}

teardownDatabase().catch(console.error);
```

**Deletion Order (reverse of creation):**
1. Foreign keys
2. Indexes
3. Tables (with CASCADE)
4. Sequences
5. ENUM types
6. PostgreSQL schemas

**Use Cases:**
- Test cleanup (tear down test databases)
- Development reset (start fresh)
- CI/CD pipeline cleanup

## Pre-Migration Hooks

You can execute custom SQL **before** any schema changes are applied by overriding the `onMigrationStart` method in your `DbContext`. This is the symmetric counterpart to `onMigrationComplete` and is useful for things that must exist *before* tables are created or altered:

- Installing required extensions (`CREATE EXTENSION IF NOT EXISTS ...`)
- Setting session/database GUCs needed during migration
- Seeding prerequisite schemas, roles, or lookup data
- Any one-off script that must run first

### Example: Ensure an extension exists before migrating

```typescript
import { DbContext, DbEntityTable, DbModelConfig, DatabaseClient } from 'linkgress-orm';

export class AppDatabase extends DbContext {
  protected override setupModel(model: DbModelConfig): void {
    // ... your entity configurations
  }

  /**
   * Called before the ORM analyzes or changes the schema, and before any
   * file-based migration runs. On a fresh database (where MigrationRunner
   * triggers auto-migration) this still runs first.
   */
  protected override async onMigrationStart(client: DatabaseClient): Promise<void> {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  }
}
```

**When it fires:**
- At the start of `getSchemaManager().migrate()` (auto-migration) — even when the schema is already in sync.
- At the start of `getSchemaManager().ensureCreated()`.
- Via `MigrationRunner.up()`: on a fresh database the runner calls auto-migration (so the hook runs first); on an existing database the runner fires the hook before applying any pending migration files.

**Important Notes:**
- Make the script idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`) — it may run on every migration.
- The hook receives a `DatabaseClient` for executing raw SQL.
- It runs **outside** the per-file migration transaction, so statements that cannot run inside a transaction (e.g. `CREATE INDEX CONCURRENTLY`) are allowed.
- Errors thrown in the hook abort the migration before any schema change is made.

> **Note:** Naming a migration file to "sort first" does **not** guarantee it runs first on a fresh database. On a fresh DB the runner builds the schema from the model via auto-migration and records all existing migration files as already applied **without executing them**. Use `onMigrationStart` for "run this before everything" logic.

## Post-Migration Hooks

You can execute custom SQL after migrations complete by overriding the `onMigrationComplete` method in your `DbContext`. This is useful for:

- Creating custom PostgreSQL functions
- Creating database views
- Setting up triggers
- Creating specialized indexes (GIN, GiST, etc.)
- Executing database-specific initialization

### Example: Custom Functions and Views

```typescript
import { DbContext, DbEntityTable, DbModelConfig, DatabaseClient } from 'linkgress-orm';
import { User } from './entities/user';
import { Post } from './entities/post';

export class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  get posts(): DbEntityTable<Post> {
    return this.table(Post);
  }

  protected override setupModel(model: DbModelConfig): void {
    // ... your entity configurations
  }

  /**
   * This hook is called automatically after ensureCreated() completes
   * and after automatic migrations finish
   */
  protected override async onMigrationComplete(client: DatabaseClient): Promise<void> {
    // Create a custom PostgreSQL function
    await client.query(`
      CREATE OR REPLACE FUNCTION get_user_by_username(p_username VARCHAR)
      RETURNS TABLE (
        id INTEGER,
        username VARCHAR,
        email TEXT
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT u.id, u.username, u.email
        FROM users u
        WHERE u.username = p_username;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create a materialized view
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS user_post_stats AS
      SELECT
        u.id,
        u.username,
        COUNT(p.id) as post_count,
        MAX(p.published_at) as last_post_date
      FROM users u
      LEFT JOIN posts p ON p.user_id = u.id
      GROUP BY u.id, u.username;
    `);

    // Create a full-text search index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_content_fts
      ON posts USING gin(to_tsvector('english', content));
    `);

    // Create a trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION update_modified_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS set_updated_at ON users;
      CREATE TRIGGER set_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION update_modified_timestamp();
    `);

    console.log('✓ Post-migration hooks executed successfully');
  }
}
```

**Important Notes:**
- Use `CREATE OR REPLACE` for functions/views to make the hook idempotent
- Use `IF NOT EXISTS` for indexes and triggers
- The hook receives a `DatabaseClient` instance for executing raw SQL
- Errors in the hook will cause the entire migration to fail
- The hook is called AFTER all schema objects are created

## NPM Script Integration

Integrate migrations into your development workflow using NPM scripts.

### package.json

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "db:migrate": "ts-node scripts/migrate.ts",
    "db:create": "ts-node scripts/create-schema.ts",
    "db:drop": "ts-node scripts/drop-schema.ts",
    "db:reset": "npm run db:drop && npm run db:create",
    "db:seed": "npm run db:create && ts-node scripts/seed.ts"
  }
}
```

### scripts/migrate.ts

```typescript
import 'dotenv/config';
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function migrate() {
  console.log('Running database migration...\n');

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client, {
    logQueries: false, // Disable query logging for cleaner output
  });

  try {
    const schemaManager = db.getSchemaManager();
    await schemaManager.migrate();

    console.log('\n✓ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

migrate();
```

### scripts/create-schema.ts

```typescript
import 'dotenv/config';
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function createSchema() {
  console.log('Creating database schema...\n');

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client);

  try {
    await db.getSchemaManager().ensureCreated();

    console.log('✓ Schema created successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Schema creation failed:', error);
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

createSchema();
```

### scripts/drop-schema.ts

```typescript
import 'dotenv/config';
import { PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function dropSchema() {
  // Safety check: prevent accidental production drops
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Cannot drop schema in production environment');
    process.exit(1);
  }

  console.log('⚠️  WARNING: This will drop all database objects!');
  console.log(`Database: ${process.env.DB_NAME || 'myapp'}\n`);

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client);

  try {
    await db.getSchemaManager().ensureDeleted();

    console.log('✓ Schema dropped successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Schema deletion failed:', error);
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

dropSchema();
```

### Usage Examples

```bash
# Run automatic migration
npm run db:migrate

# Create schema from scratch
npm run db:create

# Drop entire schema (development only)
npm run db:drop

# Reset database (drop + create)
npm run db:reset

# Create schema and seed data
npm run db:seed
```

### CI/CD Integration

```yaml
# Example GitHub Actions workflow
name: Database Migration

on:
  push:
    branches: [main, develop]

jobs:
  migrate:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run migrations
        env:
          DB_HOST: localhost
          DB_PORT: 5432
          DB_NAME: testdb
          DB_USER: postgres
          DB_PASSWORD: postgres
        run: npm run db:migrate
```

## Migration Operations

### Supported Operations

The `DbSchemaManager` analyzes and generates the following migration operations:

#### Schema Operations
```typescript
{ type: 'create_schema', schemaName: 'auth' }
```

#### ENUM Operations
```typescript
{
  type: 'create_enum',
  enumName: 'order_status',
  values: ['pending', 'processing', 'completed']
}
```

#### Table Operations
```typescript
{ type: 'create_table', tableName: 'users', schema: TableSchema }
{ type: 'drop_table', tableName: 'old_users' }
```

#### Column Operations
```typescript
{
  type: 'add_column',
  tableName: 'users',
  columnName: 'phone_number',
  config: ColumnConfig
}
{
  type: 'drop_column',
  tableName: 'users',
  columnName: 'deprecated_field'
}
{
  type: 'alter_column',
  tableName: 'users',
  columnName: 'age',
  from: DbColumnInfo,
  to: ColumnConfig
}
```

#### Index Operations
```typescript
{
  type: 'create_index',
  tableName: 'users',
  indexName: 'ix_users_email',
  columns: ['email']
}
{
  type: 'drop_index',
  tableName: 'users',
  indexName: 'ix_users_old_field'
}
```

#### Foreign Key Operations
```typescript
{
  type: 'create_foreign_key',
  tableName: 'posts',
  constraint: ForeignKeyConstraint
}
{
  type: 'drop_foreign_key',
  tableName: 'posts',
  constraintName: 'FK_posts_users'
}
```

### Operation Analysis

Before executing, you can analyze what changes are needed:

```typescript
const schemaManager = db.getSchemaManager();

// Get list of pending operations without executing
const operations = await schemaManager.analyze();

console.log('Pending operations:');
operations.forEach((op, index) => {
  console.log(`  ${index + 1}. ${op.type} - ${JSON.stringify(op)}`);
});

// Decide whether to proceed
if (operations.length === 0) {
  console.log('Schema is up to date');
} else {
  await schemaManager.migrate();
}
```

## Manual Migrations (File-Based)

<a name="manual-migrations-overview"></a>
### Overview

Manual migrations provide explicit control over database schema changes with:
- **Migration files** stored in a directory (TypeScript files)
- **Journal table** tracking which migrations have been applied
- **Up/down methods** for applying and reverting changes
- **Scaffold generator** to create migrations from schema differences

This approach is recommended for production environments where you need:
- Version-controlled, reviewable schema changes
- Rollback capabilities
- Team collaboration on database changes
- CI/CD integration with predictable migrations

### Migration Files

Migration files are TypeScript files placed in your migrations directory. Any `.ts` file is accepted (except `.d.ts` declaration files). The recommended naming convention is `YYYYMMDD-HHMMSS.ts` for automatic chronological ordering:

```
migrations/
├── 20240115-093000.ts
├── 20240120-143052.ts
└── 20240125-110000.ts
```

You can also use other naming conventions - files are sorted lexicographically:
```
migrations/
├── 001_create_users.ts
├── 002_add_posts.ts
└── 003_add_indexes.ts
```

Each migration file must export a default class implementing the `Migration` interface:

```typescript
// migrations/20240115-093000.ts
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  async up(db: AppDatabase): Promise<void> {
    await db.query(`
      ALTER TABLE "users" ADD COLUMN "phone_number" VARCHAR(20)
    `);
  }

  async down(db: AppDatabase): Promise<void> {
    await db.query(`
      ALTER TABLE "users" DROP COLUMN "phone_number"
    `);
  }
}
```

### MigrationRunner

The `MigrationRunner` executes migrations and manages the journal.

```typescript
import { MigrationRunner, PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'postgres',
});

const db = new AppDatabase(client);

const runner = new MigrationRunner(db, {
  migrationsDirectory: './migrations',
  journalTable: '__migrations',     // default
  journalSchema: 'public',          // default
  verbose: true,                    // log progress
  logger: console.log,              // custom logger
});

// Run all pending migrations
const result = await runner.up();
console.log(`Applied: ${result.applied.join(', ')}`);
console.log(`Skipped: ${result.skipped.join(', ')}`);

// Check for failures
if (result.failed) {
  console.error(`Failed: ${result.failed.filename} - ${result.failed.error.message}`);
}

await db.dispose();
```

**Key Methods:**

| Method | Description |
|--------|-------------|
| `up()` | Run all pending migrations in order |
| `down(count)` | Revert the last N migrations |
| `getPending()` | Get list of pending migration filenames |
| `getApplied()` | Get list of applied migration filenames |
| `status()` | Get detailed status of all migrations |

**Transaction Safety:**
Each migration runs inside a database transaction. If a migration fails, it is automatically rolled back, and subsequent migrations are not executed.

### MigrationScaffold

The `MigrationScaffold` generates migration files from schema differences.

```typescript
import { MigrationScaffold, PgClient } from 'linkgress-orm';
import { AppDatabase } from './database';

const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'postgres',
});

const db = new AppDatabase(client);

const scaffold = new MigrationScaffold(db, {
  migrationsDirectory: './migrations',
});

// Generate migration from schema differences
try {
  const result = await scaffold.scaffold('../src/database');
  console.log(`Created: ${result.filename}`);
  console.log(`Path: ${result.path}`);
  console.log(`Operations: ${result.operations}`);
} catch (error) {
  if (error.message.includes('No schema differences')) {
    console.log('Database is in sync with model');
  } else {
    throw error;
  }
}

// Generate empty migration template
const empty = await scaffold.scaffoldEmpty('../src/database');
console.log(`Created empty migration: ${empty.filename}`);

await db.dispose();
```

The scaffold compares your database schema to your `DbContext` model and generates SQL for:
- Creating/dropping schemas
- Creating/dropping ENUM types
- Creating/dropping sequences
- Creating/dropping tables
- Adding/dropping/altering columns
- Creating/dropping indexes
- Creating/dropping foreign keys

**Generated Migration Example:**
```typescript
import type { Migration } from 'linkgress-orm';
import type { AppDatabase } from '../src/database';

export default class implements Migration {
  async up(db: AppDatabase): Promise<void> {
    await db.query(`CREATE SCHEMA IF NOT EXISTS "auth"`);
    await db.query(`ALTER TABLE "users" ADD COLUMN "phone_number" VARCHAR(20)`);
    await db.query(`CREATE INDEX "ix_users_email" ON "users" ("email")`);
  }

  async down(db: AppDatabase): Promise<void> {
    await db.query(`DROP INDEX IF EXISTS "ix_users_email"`);
    await db.query(`ALTER TABLE "users" DROP COLUMN "phone_number"`);
    await db.query(`DROP SCHEMA IF EXISTS "auth" CASCADE`);
  }
}
```

### Migration Status

Check the status of all migrations:

```typescript
const runner = new MigrationRunner(db, {
  migrationsDirectory: './migrations',
});

const status = await runner.status();

console.log('Migration Status:');
for (const entry of status) {
  const mark = entry.applied ? '✓' : '○';
  const appliedAt = entry.appliedAt
    ? entry.appliedAt.toISOString()
    : 'pending';
  console.log(`  ${mark} ${entry.filename} (${appliedAt})`);
}
```

**Output:**
```
Migration Status:
  ✓ 20240115-093000.ts (2024-01-15T09:30:05.123Z)
  ✓ 20240120-143052.ts (2024-01-20T14:31:00.456Z)
  ○ 20240125-110000.ts (pending)
```

### Rolling Back Migrations

Revert migrations using the `down()` method:

```typescript
const runner = new MigrationRunner(db, {
  migrationsDirectory: './migrations',
  verbose: true,
});

// Revert the last migration
const result = await runner.down(1);
console.log(`Reverted: ${result.applied.join(', ')}`);

// Revert the last 3 migrations
const result3 = await runner.down(3);
console.log(`Reverted: ${result3.applied.join(', ')}`);
```

**Important Notes:**
- The `down()` method runs migrations in reverse order (most recent first)
- Each rollback runs in a transaction for safety
- Some operations cannot be auto-generated for `down()` (marked with comments in scaffolded files)

### NPM Scripts for Manual Migrations

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "migrate": "ts-node scripts/migrate.ts",
    "migrate:down": "ts-node scripts/migrate-down.ts",
    "migrate:status": "ts-node scripts/migrate-status.ts",
    "migrate:scaffold": "ts-node scripts/migrate-scaffold.ts"
  }
}
```

**scripts/migrate.ts:**
```typescript
import 'dotenv/config';
import { MigrationRunner, PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function migrate() {
  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client);
  const runner = new MigrationRunner(db, {
    migrationsDirectory: './migrations',
    verbose: true,
  });

  try {
    const result = await runner.up();
    if (result.applied.length > 0) {
      console.log(`\n✓ Applied ${result.applied.length} migration(s)`);
    } else {
      console.log('\n✓ Database is up to date');
    }
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

migrate();
```

**scripts/migrate-scaffold.ts:**
```typescript
import 'dotenv/config';
import { MigrationScaffold, PgClient } from 'linkgress-orm';
import { AppDatabase } from '../src/database';

async function scaffold() {
  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'myapp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client);
  const scaffold = new MigrationScaffold(db, {
    migrationsDirectory: './migrations',
  });

  try {
    const result = await scaffold.scaffold('../src/database');
    console.log(`✓ Created migration: ${result.filename}`);
    console.log(`  Path: ${result.path}`);
    console.log(`  Operations: ${result.operations}`);
    process.exit(0);
  } catch (error: any) {
    if (error.message?.includes('No schema differences')) {
      console.log('✓ Database is in sync with model - no migration needed');
      process.exit(0);
    }
    console.error('❌ Scaffold failed:', error);
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

scaffold();
```

### Journal Table

The migration journal is stored in a database table (default: `__migrations`):

```sql
CREATE TABLE "__migrations" (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The table is created automatically when you first run migrations. You can customize the table name and schema:

```typescript
const runner = new MigrationRunner(db, {
  migrationsDirectory: './migrations',
  journalTable: 'schema_migrations',  // custom table name
  journalSchema: 'admin',             // custom schema
});
```

## Best Practices

### Development Workflow

1. **Make model changes** in your entity classes
2. **Run migration** to sync database: `npm run db:migrate`
3. **Review changes** carefully before confirming destructive operations
4. **Test thoroughly** after migration completes
5. **Commit** model changes and any related code together

### Testing

```typescript
// test/setup.ts
beforeAll(async () => {
  const db = new AppDatabase(testClient);
  await db.getSchemaManager().ensureCreated();
});

afterAll(async () => {
  const db = new AppDatabase(testClient);
  await db.getSchemaManager().ensureDeleted();
  await testClient.end();
});
```

### Safety Guidelines

1. **Always backup production** before migrations
2. **Test migrations** on staging environment first
3. **Avoid dropping columns** with data - consider soft deletes
4. **Be cautious with type changes** that may cause data loss
5. **Use post-migration hooks** for data migrations
6. **Set NODE_ENV** to prevent accidental production drops

### Performance Tips

1. **Create indexes** for foreign keys and frequently queried columns
2. **Use post-migration hooks** for creating specialized indexes
3. **Run migrations** during low-traffic periods
4. **Monitor query performance** after schema changes
5. **Consider table partitioning** for large tables (via hooks)

## See Also

- [Schema Configuration Guide](./schema-configuration.md) - Entity and relationship setup
- [Database Clients](../database-clients.md) - Connecting to PostgreSQL
- [Getting Started](../getting-started.md) - Quick start guide
