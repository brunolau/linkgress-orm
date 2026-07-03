# Insert/Update/Upsert/BULK

This guide covers inserting, updating, and deleting data in Linkgress ORM.

## Overview
Linkgress ORM provides type-safe methods for modifying data in your database. All operations maintain full TypeScript type inference and support both single-record and bulk operations.

## Insert Operations

### Simple Insert

Insert a single record into a table:

```typescript
// Insert a new user
const newUser = await db.users.insert({
  username: 'alice',
  email: 'alice@example.com',
  isActive: true
});

console.log(newUser); // Returns the inserted record with generated ID
// { id: 1, username: 'alice', email: 'alice@example.com', isActive: true }
```

**Type Safety:**
- TypeScript validates that all required fields are provided
- Only valid columns can be specified
- Auto-generated fields (like `id`) are optional in insert

### Insert with Returning Specific Columns

You can specify which columns to return after insert:

```typescript
const user = await db.users.insert({
  username: 'bob',
  email: 'bob@example.com'
}, ['id', 'username']); // Only return id and username

console.log(user); // { id: 2, username: 'bob' }
```

### Bulk Insert

Insert multiple records in a single operation:

```typescript
const users = await db.users.insertBulk([
  { username: 'alice', email: 'alice@example.com' },
  { username: 'bob', email: 'bob@example.com' },
  { username: 'charlie', email: 'charlie@example.com' }
]);

console.log(users.length); // 3
// Returns array of inserted records with generated IDs
```

**Performance:**
- Bulk insert uses a single `INSERT` statement
- Significantly faster than individual inserts
- All inserts are atomic (all succeed or all fail)

## Update Operations

Linkgress ORM uses a **fluent API** for update operations. You first specify the condition using `.where()`, then call `.update()` with the data.

### Simple Update

Update records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Update a single user (fluent API: where -> update)
await db.users
  .where(u => eq(u.id, 1))
  .update({
    email: 'alice.new@example.com',
    isActive: false
  });
```

### Update with Multiple Conditions

```typescript
import { eq, gt, and } from 'linkgress-orm';

// Update all users with id > 10 and isActive = true
await db.users
  .where(u => and(
    gt(u.id, 10),
    eq(u.isActive, true)
  ))
  .update({
    isActive: false
  });
```

### Update with Returning Values

Use `.returning()` to get back the updated records:

```typescript
// Update and return all columns
const updatedUsers = await db.users
  .where(u => eq(u.username, 'alice'))
  .update({ email: 'alice.updated@example.com' })
  .returning();

console.log(updatedUsers);
// [{ id: 1, username: 'alice', email: 'alice.updated@example.com', isActive: true, ... }]

// Update and return specific columns
const results = await db.users
  .where(u => eq(u.id, 1))
  .update({ age: 30 })
  .returning(u => ({ id: u.id, age: u.age }));

console.log(results);
// [{ id: 1, age: 30 }]
```

### Update with Affected Count

Use `.affectedCount()` to get the number of rows affected without returning the actual records:

```typescript
// Get the count of updated rows
const count = await db.users
  .where(u => eq(u.isActive, true))
  .update({ lastLogin: new Date() })
  .affectedCount();

console.log(`Updated ${count} users`);
// Updated 42 users

// Update all records and get count
const totalUpdated = await db.users
  .update({ isActive: false })
  .affectedCount();

console.log(`Deactivated ${totalUpdated} users`);
```

**When to use:**
- When you only need to know how many rows were affected
- More efficient than `.returning()` when you don't need the actual data
- Useful for logging, metrics, or conditional logic based on affected count

## Upsert Operations

Upsert (INSERT ... ON CONFLICT) inserts a record or updates it if it already exists.

### Simple Upsert

```typescript
// Upsert based on unique constraint (e.g., username)
const user = await db.users.upsert(
  {
    username: 'alice',
    email: 'alice@example.com',
    isActive: true
  },
  {
    conflictTarget: ['username'], // Columns that define uniqueness
    update: ['email', 'isActive']  // Columns to update on conflict
  }
);

// If user 'alice' exists: updates email and isActive
// If user 'alice' doesn't exist: inserts new record
```

### Upsert with Custom Update Logic

```typescript
// Upsert with conditional update
const user = await db.users.upsert(
  {
    username: 'bob',
    email: 'bob@example.com',
    loginCount: 1
  },
  {
    conflictTarget: ['username'],
    update: {
      email: 'bob@example.com',
      loginCount: sql`${db.users.loginCount} + 1` // Increment on conflict
    }
  }
);
```

### Bulk Upsert

Insert or update multiple records:

```typescript
const users = await db.users.upsertMany(
  [
    { username: 'alice', email: 'alice@example.com' },
    { username: 'bob', email: 'bob@example.com' },
    { username: 'charlie', email: 'charlie@example.com' }
  ],
  {
    conflictTarget: ['username'],
    update: ['email']
  }
);

console.log(`Upserted ${users.length} users`);
// Efficiently handles all records in a single operation
```

**Use Cases:**
- Syncing data from external sources
- Implementing "save or update" logic
- Handling duplicate key scenarios gracefully
- Bulk data imports with conflict resolution

### Upsert with SQL Expression Values

Upsert values may be [magic SQL strings](querying.md#magic-sql-strings) (`SqlFragment`),
not just literals. The fragment renders as a SQL expression inside the `VALUES` tuple —
e.g. a scalar subquery computed by the INSERT itself. On conflict the computed value
flows into the `DO UPDATE` arm via `EXCLUDED."col"`, so a read-fold-write cycle
(aggregate something, then persist the result) is a **single round trip**:

```typescript
import { sql } from 'linkgress-orm';

// Recompute a user's post-view total and upsert the accumulator row — one statement.
const rows = await db.userStats.upsertBulk(
  [
    {
      userId,
      totalViews: sql<number>`(
        SELECT COALESCE(SUM("views"), 0)::int
        FROM "posts"
        WHERE "user_id" = ${userId}
      )`,
      updatedAt: new Date(),
    },
  ],
  {
    primaryKey: 'userId',
    updateColumns: ['totalViews', 'updatedAt'],
  }
).returning(s => ({ totalViews: s.totalViews }));
```

Rules of the road:

- Fragments must be **self-contained SQL** — they render inside a `VALUES` tuple where
  no table alias is in scope, so entity column references are not resolvable there.
- Interpolated values bind as ordinary parameters (numbering stays consistent across
  mixed rows of fragment and plain values).
- Fragment values bypass the column's type mapper — the fragment IS the SQL.
- An aggregate-only scalar subquery always yields exactly one row, so the INSERT arm
  still materializes when the source has zero rows (`SUM → NULL → COALESCE(…, 0)`).

## Delete Operations

Linkgress ORM uses a **fluent API** for delete operations. You first specify the condition using `.where()`, then call `.delete()`.

### Simple Delete

Delete records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Delete a specific user (fluent API: where -> delete)
await db.users
  .where(u => eq(u.id, 1))
  .delete();
```

### Delete with Multiple Conditions

```typescript
import { and, lt, eq } from 'linkgress-orm';

// Delete inactive users with id < 100
await db.users
  .where(u => and(
    eq(u.isActive, false),
    lt(u.id, 100)
  ))
  .delete();
```

### Delete with Returning Values

Use `.returning()` to get back the deleted records:

```typescript
// Delete and return all columns
const deletedUsers = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .returning();

console.log(deletedUsers);
// Array of deleted user records with all columns

// Delete and return specific columns
const deletedIds = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .returning(u => ({ id: u.id, username: u.username }));

console.log(deletedIds);
// [{ id: 5, username: 'inactive_user' }, ...]
```

### Delete with Affected Count

Use `.affectedCount()` to get the number of rows deleted without returning the actual records:

```typescript
// Get the count of deleted rows
const count = await db.users
  .where(u => eq(u.isActive, false))
  .delete()
  .affectedCount();

console.log(`Deleted ${count} inactive users`);
// Deleted 15 inactive users

// Delete all records and get count
const totalDeleted = await db.users
  .delete()
  .affectedCount();

console.log(`Deleted ${totalDeleted} users from table`);
```

**When to use:**
- When you only need to know how many rows were deleted
- More efficient than `.returning()` when you don't need the actual data
- Useful for logging, cleanup operations, or conditional logic

### Delete All Records

```typescript
// ⚠️ Warning: Deletes all records in the table
// Use with extreme caution!
await db.users.delete();
```

## Type Safety

All CRUD operations maintain full TypeScript type inference:

```typescript
// ✓ Type-safe: TypeScript knows all valid columns
await db.users.insert({
  username: 'alice',
  email: 'alice@example.com'
});

// ✗ Compile error: 'invalid' is not a valid column
await db.users.insert({
  username: 'alice',
  invalid: 'field'  // TypeScript error
});

// ✓ Type-safe: Update validates column types
await db.users.where(u => eq(u.id, 1)).update({
  email: 'new@example.com'  // Must be string
});

// ✗ Compile error: email must be string
await db.users.where(u => eq(u.id, 1)).update({
  email: 123  // TypeScript error
});
```

## Transactions

All CRUD operations can be wrapped in transactions for atomicity:

```typescript
await db.transaction(async (tx) => {
  // Insert user
  const user = await tx.users.insert({
    username: 'alice',
    email: 'alice@example.com'
  });

  // Insert related posts
  await tx.posts.insertBulk([
    { userId: user.id, title: 'First Post', content: 'Hello World' },
    { userId: user.id, title: 'Second Post', content: 'More content' }
  ]);

  // If any operation fails, all changes are rolled back
});
```

## Performance Tips

### Bulk Operations

Always prefer bulk operations when working with multiple records:

```typescript
// ❌ Slow: Multiple round trips
for (const user of users) {
  await db.users.insert(user);
}

// ✅ Fast: Single round trip
await db.users.insertBulk(users);
```

### Batch Size

For very large datasets, process in batches:

```typescript
const batchSize = 1000;
const users = [...]; // Large array of users

for (let i = 0; i < users.length; i += batchSize) {
  const batch = users.slice(i, i + batchSize);
  await db.users.insertBulk(batch);
}
```

### Use Upsert for Idempotent Operations

Upsert is safer than insert when re-running operations:

```typescript
// ❌ May fail on duplicate key
await db.users.insert({ username: 'alice', email: 'alice@example.com' });

// ✅ Safe: Updates if exists, inserts if not
await db.users.upsert(
  { username: 'alice', email: 'alice@example.com' },
  { conflictTarget: ['username'], update: ['email'] }
);
```

## Examples

### User Registration

```typescript
async function registerUser(username: string, email: string, password: string) {
  try {
    const user = await db.users.insert({
      username,
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
      isActive: true
    });

    return { success: true, user };
  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return { success: false, error: 'Username already exists' };
    }
    throw error;
  }
}
```

### Bulk Data Import

```typescript
async function importUsers(csvData: any[]) {
  const users = csvData.map(row => ({
    username: row.username,
    email: row.email,
    isActive: true
  }));

  // Use upsert to handle duplicates
  const result = await db.users.upsertMany(
    users,
    {
      conflictTarget: ['username'],
      update: ['email']
    }
  );

  return {
    imported: result.length,
    timestamp: new Date()
  };
}
```

### Update User Profile

```typescript
async function updateUserProfile(userId: number, updates: Partial<User>) {
  const updatedUsers = await db.users
    .where(u => eq(u.id, userId))
    .updateReturning({
      ...updates,
      updatedAt: new Date()
    });

  if (updatedUsers.length === 0) {
    throw new Error('User not found');
  }

  return updatedUsers[0];
}
```

### Soft Delete

```typescript
async function softDeleteUser(userId: number) {
  const deleted = await db.users
    .where(u => eq(u.id, userId))
    .update({
      isActive: false,
      deletedAt: new Date()
    });

  return deleted > 0;
}

// Later, permanently delete soft-deleted users
async function permanentlyDeleteInactiveUsers(daysOld: number) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  return await db.users
    .where(u => and(
      eq(u.isActive, false),
      lt(u.deletedAt, cutoffDate)
    ))
    .delete();
}
```

## API Reference

### Insert Methods

```typescript
// Insert single record (returns void by default)
insert(data: Partial<TEntity>): FluentInsert<TEntity>

// Insert with returning
insert(data: Partial<TEntity>).returning(): Promise<TEntity>
insert(data: Partial<TEntity>).returning(selector): Promise<Partial<TEntity>>

// Insert multiple records
insertBulk(data: Partial<TEntity>[]): FluentInsertMany<TEntity>
```

### Update Methods (Fluent API)

```typescript
// Fluent update: where -> update -> optional returning/affectedCount
db.table
  .where(condition)
  .update(data: Partial<TEntity>): FluentQueryUpdate<TEntity>

// With returning
db.table
  .where(condition)
  .update(data)
  .returning(): Promise<TEntity[]>

db.table
  .where(condition)
  .update(data)
  .returning(selector): Promise<Partial<TEntity>[]>

// With affected count
db.table
  .where(condition)
  .update(data)
  .affectedCount(): Promise<number>
```

### Upsert Methods

```typescript
// Upsert multiple records
upsertBulk(
  data: Partial<TEntity>[],
  options: {
    primaryKey: string[];
    updateColumns: string[];
  }
): FluentUpsert<TEntity>

// With returning
upsertBulk(data, options).returning(): Promise<TEntity[]>
upsertBulk(data, options).returning(selector): Promise<Partial<TEntity>[]>
```

### Delete Methods (Fluent API)

```typescript
// Fluent delete: where -> delete -> optional returning/affectedCount
db.table
  .where(condition)
  .delete(): FluentDelete<TEntity>

// With returning
db.table
  .where(condition)
  .delete()
  .returning(): Promise<TEntity[]>

db.table
  .where(condition)
  .delete()
  .returning(selector): Promise<Partial<TEntity>[]>

// With affected count
db.table
  .where(condition)
  .delete()
  .affectedCount(): Promise<number>

// Delete all (dangerous!)
db.table.delete(): FluentDelete<TEntity>
db.table.delete().affectedCount(): Promise<number>
```

## See Also

- [Schema Configuration](./schema-configuration.md) - Define entities and relationships
- [Getting Started](../getting-started.md) - Basic usage examples
- [Collection Strategies](../collection-strategies.md) - Querying related data

## License

MIT
