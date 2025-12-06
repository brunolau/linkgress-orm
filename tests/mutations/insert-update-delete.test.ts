import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { eq, sql } from '../../src';

describe('Insert, Update, Delete Operations', () => {
  describe('INSERT operations', () => {
    test('should insert a single record', async () => {
      await withDatabase(async (db) => {
        const user = await db.users.insert({
          username: 'newuser',
          email: 'new@test.com',
          age: 30,
          isActive: true,
        }).returning();

        expect(user).toBeDefined();
        expect(user.id).toBeDefined();
        expect(user.username).toBe('newuser');
        expect(user.email).toBe('new@test.com');
        expect(user.age).toBe(30);
      });
    });

    test('should insert with default values', async () => {
      await withDatabase(async (db) => {
        const user = await db.users.insert({
          username: 'minimal',
          email: 'minimal@test.com',
        }).returning();

        expect(user).toBeDefined();
        expect(user.isActive).toBe(true); // Default value
        expect(user.createdAt).toBeDefined();
      });
    });

    test('should insert multiple records with insertBulk', async () => {
      await withDatabase(async (db) => {
        const users = await db.users.insertBulk([
          { username: 'user1', email: 'user1@test.com' },
          { username: 'user2', email: 'user2@test.com' },
          { username: 'user3', email: 'user3@test.com' },
        ]).returning();

        expect(users).toHaveLength(3);
        users.forEach(u => {
          expect(u.id).toBeDefined();
        });
      });
    });

    test('should handle insert with NULL values', async () => {
      await withDatabase(async (db) => {
        const user = await db.users.insert({
          username: 'nullable',
          email: 'nullable@test.com',
          age: null,
          metadata: null,
        }).returning();

        expect(user.age).toBeNull();
        expect(user.metadata).toBeNull();
      });
    });

    test('should reject insert with duplicate unique key', async () => {
      await withDatabase(async (db) => {
        await db.users.insert({
          username: 'unique',
          email: 'unique@test.com',
        });

        // Try to insert with same username (unique constraint)
        await expect(
          db.users.insert({
            username: 'unique',
            email: 'different@test.com',
          })
        ).rejects.toThrow();
      });
    });
  });

  describe('UPDATE operations', () => {
    test('should update a single record', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.update(
          { age: 26, isActive: false },
          u => eq(u.id, users.alice.id)
        ).returning();

        expect(updated).toHaveLength(1);
        expect(updated[0].age).toBe(26);
        expect(updated[0].isActive).toBe(false);
        expect(updated[0].username).toBe('alice'); // Unchanged fields preserved
      });
    });

    test('should update multiple records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const updated = await db.users.update(
          { isActive: false },
          u => eq(u.isActive, true)
        ).returning();

        expect(updated.length).toBeGreaterThanOrEqual(2);
        updated.forEach(u => {
          expect(u.isActive).toBe(false);
        });
      });
    });

    test('should update with NULL value', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.update(
          { age: null },
          u => eq(u.id, users.alice.id)
        ).returning();

        expect(updated[0].age).toBeNull();
      });
    });

    test('should return empty array when no records match update condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const updated = await db.users.update(
          { age: 99 },
          u => eq(u.username, 'nonexistent')
        ).returning();

        expect(updated).toHaveLength(0);
      });
    });
  });

  describe('DELETE operations', () => {
    test('should delete a single record', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const countBefore = await db.users.count();

        await db.users.delete(u => eq(u.id, users.charlie.id));

        const countAfter = await db.users.count();
        expect(countAfter).toBe(countBefore - 1);

        // Verify deleted
        const deleted = await db.users
          .where(u => eq(u.id, users.charlie.id))
          .firstOrDefault();
        expect(deleted).toBeNull();
      });
    });

    test('should delete multiple records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const countBefore = await db.users.count();

        await db.users.delete(u => eq(u.isActive, true));

        const countAfter = await db.users.count();
        expect(countAfter).toBeLessThan(countBefore);

        // Verify only inactive users remain
        const remaining = await db.users.toList();
        remaining.forEach(u => {
          expect(u.isActive).toBe(false);
        });
      });
    });

    test('should delete with complex condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await db.users.delete(u =>
          sql`${u.age} > 30 AND ${u.isActive} = true`
        );

        const remaining = await db.users.select(p => ({
          id: p.id,
          age: p.age,
          isActive: p.isActive
        })).toList();

        expect(remaining.length).toBeGreaterThan(0);

        // No users should match the deleted criteria
        const shouldBeDeleted = remaining.filter(u => u.age! > 30 && u.isActive);
        expect(shouldBeDeleted).toHaveLength(0);
      });
    });

    test('should not delete when condition matches nothing', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const countBefore = await db.users.count();

        await db.users.delete(u => eq(u.username, 'nonexistent'));

        const countAfter = await db.users.count();
        expect(countAfter).toBe(countBefore);
      });
    });

    test('should cascade delete when foreign key is set to cascade', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Delete user should cascade to posts
        await db.users.delete(u => eq(u.id, users.alice.id));

        // Alice's posts should be deleted
        const alicePosts = await db.posts
          .where(p => eq(p.userId, users.alice.id))
          .toList();

        expect(alicePosts).toHaveLength(0);
      });
    });
  });

  describe('UPSERT (INSERT ON CONFLICT) operations', () => {
    test('should insert when no conflict', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.upsertBulk(
          [{ username: 'upsertuser', email: 'upsert@test.com', age: 25 }],
          {
            primaryKey: ['username'],
            updateColumns: ['email', 'age'],
          }
        ).returning();

        expect(result).toHaveLength(1);
        expect(result[0].username).toBe('upsertuser');
      });
    });

    test('should update when conflict exists', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.upsertBulk(
          [{ username: 'alice', email: 'newalice@test.com', age: 30 }],
          {
            primaryKey: ['username'],
            updateColumns: ['email', 'age'],
          }
        ).returning();

        expect(result).toHaveLength(1);
        expect(result[0].email).toBe('newalice@test.com');
        expect(result[0].age).toBe(30);
      });
    });

    test('should upsert multiple records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users.upsertBulk(
          [
            { username: 'alice', email: 'updated@test.com', age: 26 },
            { username: 'newuser', email: 'new@test.com', age: 22 },
          ],
          {
            primaryKey: ['username'],
            updateColumns: ['email', 'age'],
          }
        ).returning();

        expect(result).toHaveLength(2);
        const alice = result.find(u => u.username === 'alice');
        const newUser = result.find(u => u.username === 'newuser');

        expect(alice?.email).toBe('updated@test.com');
        expect(newUser).toBeDefined();
      });
    });
  });

  describe('Transaction-like behavior', () => {
    test('should rollback on error', async () => {
      const db = createTestDatabase();
      try {
        await setupDatabase(db);

        const countBefore = await db.users.count();

        try {
          // Try to insert invalid data (violates NOT NULL)
          await db.users.insert({
            username: 'baduser',
            email: null as any, // This should fail
          });
        } catch (error) {
          // Expected to fail
        }

        const countAfter = await db.users.count();
        expect(countAfter).toBe(countBefore); // No change due to rollback
      } finally {
        await cleanupDatabase(db);
      }
    });
  });
});
