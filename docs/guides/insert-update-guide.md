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
const users = await db.users.insertMany([
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

### Simple Update

Update records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Update a single user
const updated = await db.users
  .where(u => eq(u.id, 1))
  .update({
    email: 'alice.new@example.com',
    isActive: false
  });

console.log(updated); // Number of rows updated: 1
```

### Update with Multiple Conditions

```typescript
import { eq, gt } from 'linkgress-orm';

// Update all users with id > 10 and isActive = true
const count = await db.users
  .where(u => and(
    gt(u.id, 10),
    eq(u.isActive, true)
  ))
  .update({
    isActive: false
  });

console.log(`Updated ${count} users`);
```

### Update with Returning Values

```typescript
// Update and return the updated records
const updatedUsers = await db.users
  .where(u => eq(u.username, 'alice'))
  .updateReturning({
    email: 'alice.updated@example.com'
  });

console.log(updatedUsers);
// [{ id: 1, username: 'alice', email: 'alice.updated@example.com', isActive: false }]
```

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

## Delete Operations

### Simple Delete

Delete records matching a condition:

```typescript
import { eq } from 'linkgress-orm';

// Delete a specific user
const deleted = await db.users
  .where(u => eq(u.id, 1))
  .delete();

console.log(deleted); // Number of rows deleted: 1
```

### Delete with Multiple Conditions

```typescript
import { and, lt, eq } from 'linkgress-orm';

// Delete inactive users with id < 100
const count = await db.users
  .where(u => and(
    eq(u.isActive, false),
    lt(u.id, 100)
  ))
  .delete();

console.log(`Deleted ${count} users`);
```

### Delete with Returning Values

```typescript
// Delete and return the deleted records
const deletedUsers = await db.users
  .where(u => eq(u.isActive, false))
  .deleteReturning();

console.log(deletedUsers);
// Array of deleted user records
```

### Delete All Records

```typescript
// ⚠️ Warning: Deletes all records in the table
const count = await db.users.delete();

console.log(`Deleted ${count} users`);
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
  await tx.posts.insertMany([
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
await db.users.insertMany(users);
```

### Batch Size

For very large datasets, process in batches:

```typescript
const batchSize = 1000;
const users = [...]; // Large array of users

for (let i = 0; i < users.length; i += batchSize) {
  const batch = users.slice(i, i + batchSize);
  await db.users.insertMany(batch);
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
// Insert single record
insert(data: Partial<TEntity>): Promise<TEntity>
insert(data: Partial<TEntity>, returning: string[]): Promise<Partial<TEntity>>

// Insert multiple records
insertMany(data: Partial<TEntity>[]): Promise<TEntity[]>
```

### Update Methods

```typescript
// Update with count
update(data: Partial<TEntity>): Promise<number>

// Update with returning
updateReturning(data: Partial<TEntity>): Promise<TEntity[]>
```

### Upsert Methods

```typescript
// Upsert single record
upsert(
  data: Partial<TEntity>,
  options: {
    conflictTarget: string[];
    update: string[] | Partial<TEntity>;
  }
): Promise<TEntity>

// Upsert multiple records
upsertMany(
  data: Partial<TEntity>[],
  options: {
    conflictTarget: string[];
    update: string[] | Partial<TEntity>;
  }
): Promise<TEntity[]>
```

### Delete Methods

```typescript
// Delete with count
delete(): Promise<number>

// Delete with returning
deleteReturning(): Promise<TEntity[]>
```

## See Also

- [Schema Configuration](./schema-configuration.md) - Define entities and relationships
- [Getting Started](../getting-started.md) - Basic usage examples
- [Collection Strategies](../collection-strategies.md) - Querying related data

## License

MIT
