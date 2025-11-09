# Installation Guide

## Core Installation

Install the core ORM package:

```bash
npm install linkgress-orm
```

The core package has **no database client dependencies**. You choose which PostgreSQL client library you want to use.

## Database Client Installation

Linkgress ORM supports multiple PostgreSQL client libraries. Install **one** of the following based on your preference:

### Option 1: pg (node-postgres)

The traditional, battle-tested PostgreSQL client:

```bash
npm install pg
npm install --save-dev @types/pg  # For TypeScript types
```

**Pros:**
- Mature and widely used
- Extensive community support
- Well-documented
- Battle-tested in production

**Cons:**
- Larger bundle size (~20KB)
- More verbose API
- Traditional callback-based patterns (though promises are supported)

### Option 2: postgres

Modern, lightweight PostgreSQL client:

```bash
npm install postgres
```

**Pros:**
- Modern async/await first API
- Smaller bundle size (~7KB)
- Template literal syntax support
- Built-in transaction support
- Better TypeScript support
- No separate types package needed

**Cons:**
- Newer library (less battle-tested)
- Smaller community

## Minimal Setup Examples

### Using pg

```typescript
import { DbContext, DbEntityTable, DbModelConfig, PgClient, DbEntity, DbColumn, integer, varchar } from 'linkgress-orm';

// Define entity
class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
}

// Define database context
class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 50)).isRequired();
    });
  }
}

// Create client
const client = new PgClient({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
});

// Create database context
const db = new AppDatabase(client);

// Use it
await db.users.insert({ username: 'john_doe' });
```

### Using postgres

```typescript
import { DbContext, DbEntityTable, DbModelConfig, PostgresClient, DbEntity, DbColumn, integer, varchar } from 'linkgress-orm';

// Define entity (same as above)
class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
}

// Define database context (same as above)
class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 50)).isRequired();
    });
  }
}

// Create client with connection string
const client = new PostgresClient('postgres://postgres:password@localhost/mydb');

// Or with config object
const client = new PostgresClient({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
});

// Create database context (same API)
const db = new AppDatabase(client);

// Use it (same API)
await db.users.insert({ username: 'john_doe' });
```

## Development vs Production

### For Library Authors

If you're building a library that depends on linkgress-orm, you should **not** install any database client. Let your users choose:

```json
{
  "dependencies": {
    "linkgress-orm": "^0.1.0"
  },
  "peerDependencies": {
    "pg": "^8.0.0",
    "postgres": "^3.0.0"
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true },
    "postgres": { "optional": true }
  }
}
```

### For Applications

Install linkgress-orm plus your chosen client:

```bash
# Option 1: Using pg
npm install linkgress-orm pg
npm install --save-dev @types/pg

# Option 2: Using postgres
npm install linkgress-orm postgres
```

### For Development/Testing

If you're developing linkgress-orm itself or running tests, install as devDependencies:

```json
{
  "devDependencies": {
    "pg": "^8.11.0",
    "@types/pg": "^8.10.0",
    "postgres": "^3.0.0"
  }
}
```

## What Happens If Client Is Missing?

If you try to use a client without installing its package, you'll get a helpful error:

```typescript
// Without pg installed
const client = new PgClient(config);
// Error: PgClient requires the "pg" package to be installed.
// Install it with: npm install pg

// Without postgres installed
const client = new PostgresClient(config);
// Error: PostgresClient requires the "postgres" package to be installed.
// Install it with: npm install postgres
```

## Bundle Size Comparison

The core linkgress-orm package is lightweight. The actual bundle size depends on which client you choose:

| Package | Minified Size | Gzipped |
|---------|--------------|---------|
| linkgress-orm (core) | ~50KB | ~15KB |
| + pg | +20KB | +8KB |
| + postgres | +7KB | +3KB |

**Recommendation:** Use `postgres` for smaller bundle sizes in browser/serverless environments.

## TypeScript Configuration

No special TypeScript configuration is needed. Both clients are fully typed:

```typescript
// pg requires @types/pg
import type { PoolConfig } from 'pg';

// postgres has built-in types
import type { Options } from 'postgres';
```

## Environment-Specific Installations

### Node.js Applications

Both clients work great in Node.js:

```bash
npm install linkgress-orm pg
# or
npm install linkgress-orm postgres
```

### Serverless Functions (AWS Lambda, Vercel, etc.)

Use `postgres` for smaller cold start times:

```bash
npm install linkgress-orm postgres
```

### Edge Runtime (Cloudflare Workers, Vercel Edge)

Use `postgres` as it's more edge-compatible:

```bash
npm install linkgress-orm postgres
```

### Docker Containers

Either client works. Install in your Dockerfile:

```dockerfile
# Using pg
RUN npm install linkgress-orm pg

# Using postgres
RUN npm install linkgress-orm postgres
```

## Troubleshooting

### Error: Cannot find module 'pg'

You forgot to install pg:
```bash
npm install pg
npm install --save-dev @types/pg
```

### Error: Cannot find module 'postgres'

You forgot to install postgres:
```bash
npm install postgres
```

### TypeScript errors about PoolConfig

If you see TypeScript errors about `PoolConfig` not being found, install the types:
```bash
npm install --save-dev @types/pg
```

Or import from pg directly:
```typescript
import type { PoolConfig } from 'pg';
```

### Module resolution issues

Make sure your tsconfig.json has proper module resolution:

```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true
  }
}
```

## Recommended Setup

For most applications, we recommend:

1. **Use `postgres`** for new projects (modern API, smaller bundle)
2. **Use `pg`** if you need maximum stability or are migrating from other ORMs

**Quick start:**

```bash
npm install linkgress-orm postgres
```

```typescript
import { PostgresClient } from 'linkgress-orm';
import { AppDatabase } from './database/app-database';

const client = new PostgresClient(process.env.DATABASE_URL);
const db = new AppDatabase(client);
```

## Next Steps

- [Database Clients Guide](./database-clients.md) - Detailed client comparison
- [Getting Started Guide](./getting-started.md) - Complete walkthrough for beginners
- [Schema Configuration](./guides/schema-configuration.md) - Configure your entities and relationships
