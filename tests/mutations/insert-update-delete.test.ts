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

    test('should insert multiple records with insertBulk when rows have different optional fields', async () => {
      await withDatabase(async (db) => {
        const users = await db.users.insertBulk([
          {
            username: 'alice_jones',
            email: 'alice@example.com',
            age: 25,
            isActive: true,
          },
          {
            username: 'bob_wilson',
            email: 'bob@example.com',
            age: 32,
            isActive: false,
          },
          {
            username: 'charlie_brown',
            email: 'charlie@example.com',
            isActive: true,
            // age is optional, can be omitted
          },
        ]).returning(p => ({
          id: p.id,
          username: p.username,
          age: p.age,
        }));

        expect(users).toHaveLength(3);
        expect(users[0].username).toBe('alice_jones');
        expect(users[0].age).toBe(25);
        expect(users[1].username).toBe('bob_wilson');
        expect(users[1].age).toBe(32);
        expect(users[2].username).toBe('charlie_brown');
        expect(users[2].age).toBeNull(); // Should be null, not undefined
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

    test('should use database default when field is undefined (not provided)', async () => {
      await withDatabase(async (db) => {
        // Insert user without providing isActive (has default: true) and createdAt (has default: NOW())
        const user = await db.users.insert({
          username: 'default_test',
          email: 'default@test.com',
        }).returning();

        // Database defaults should be applied
        expect(user.isActive).toBe(true); // Default is true
        expect(user.createdAt).toBeDefined(); // Default is NOW()
        expect(user.createdAt instanceof Date).toBe(true);
      });
    });

    test('should use database default when field is explicitly undefined', async () => {
      await withDatabase(async (db) => {
        // Explicitly pass undefined for fields with defaults - should use DB default, not NULL
        const user = await db.users.insert({
          username: 'explicit_undefined',
          email: 'explicit@test.com',
          isActive: undefined, // Has default: true - should NOT become NULL
          age: undefined, // No default - nullable column
        }).returning();

        // isActive should use DB default (true), not be NULL
        expect(user.isActive).toBe(true);
        // age has no default, so undefined becomes NULL
        expect(user.age).toBeNull();
      });
    });

    test('should allow overriding default value with explicit value', async () => {
      await withDatabase(async (db) => {
        const user = await db.users.insert({
          username: 'override_default',
          email: 'override@test.com',
          isActive: false, // Override the default of true
        }).returning();

        expect(user.isActive).toBe(false); // Explicitly set to false
      });
    });

    test('should allow overriding default value with NULL', async () => {
      await withDatabase(async (db) => {
        // For nullable columns with defaults, NULL should be inserted explicitly
        const user = await db.users.insert({
          username: 'null_override',
          email: 'null_override@test.com',
          metadata: null, // Explicitly set to NULL
        }).returning();

        expect(user.metadata).toBeNull();
      });
    });

    test('should handle undefined vs null differently in bulk insert', async () => {
      await withDatabase(async (db) => {
        // When ALL rows have undefined for a column with a default, the column is skipped
        // and all rows get the database default value
        const allUndefinedUsers = await db.users.insertBulk([
          {
            username: 'all_undefined_1',
            email: 'all_undefined_1@test.com',
            isActive: undefined, // Has default: true
          },
          {
            username: 'all_undefined_2',
            email: 'all_undefined_2@test.com',
            isActive: undefined, // Has default: true
          },
        ]).returning();

        expect(allUndefinedUsers).toHaveLength(2);
        // Both should use DB default since ALL rows had undefined
        expect(allUndefinedUsers[0].isActive).toBe(true);
        expect(allUndefinedUsers[1].isActive).toBe(true);

        // When SOME rows have defined values and others have undefined,
        // the undefined rows get NULL (because column must be included for consistent schema)
        const mixedUsers = await db.users.insertBulk([
          {
            username: 'mixed_explicit_true',
            email: 'mixed_true@test.com',
            isActive: true, // Explicit true
          },
          {
            username: 'mixed_explicit_false',
            email: 'mixed_false@test.com',
            isActive: false, // Explicit false
          },
        ]).returning();

        expect(mixedUsers).toHaveLength(2);
        const trueUser = mixedUsers.find(u => u.username === 'mixed_explicit_true');
        const falseUser = mixedUsers.find(u => u.username === 'mixed_explicit_false');
        expect(trueUser?.isActive).toBe(true); // Explicit
        expect(falseUser?.isActive).toBe(false); // Explicit
      });
    });

    test('should use database default for identity columns (auto-increment)', async () => {
      await withDatabase(async (db) => {
        // Insert without providing id - should be auto-generated
        const user1 = await db.users.insert({
          username: 'auto_id_1',
          email: 'auto1@test.com',
        }).returning();

        const user2 = await db.users.insert({
          username: 'auto_id_2',
          email: 'auto2@test.com',
        }).returning();

        // IDs should be auto-generated and sequential
        expect(user1.id).toBeDefined();
        expect(user2.id).toBeDefined();
        expect(user2.id).toBeGreaterThan(user1.id);
      });
    });

    test('should use database defaults for Post with multiple default columns', async () => {
      await withDatabase(async (db) => {
        // First create a user since posts need userId
        const user = await db.users.insert({
          username: 'post_owner',
          email: 'owner@test.com',
        }).returning();

        // Insert post with only required fields - others should use defaults
        const post = await db.posts.insert({
          title: 'Test Post',
          userId: user.id,
        }).returning();

        expect(post.id).toBeDefined(); // Identity column
        expect(post.views).toBe(0); // Default is 0
        expect(post.publishedAt).toBeDefined(); // Default is NOW()
        expect(post.category).toBe('tech'); // Default is 'tech'
      });
    });

    test('should apply custom mapper in returning() with selector', async () => {
      await withDatabase(async (db) => {
        // First create a user since posts need userId
        const user = await db.users.insert({
          username: 'mapper_test_user',
          email: 'mapper@test.com',
        }).returning();

        const testDate = new Date('2024-06-15T10:30:00Z');

        // Insert post with customDate (uses pgIntDatetime mapper)
        // The mapper stores Date as integer (seconds since custom epoch)
        const post = await db.posts.insert({
          title: 'Mapper Test Post',
          userId: user.id,
          customDate: testDate,
        }).returning();

        // Full returning() should apply mapper
        expect(post.customDate).toBeInstanceOf(Date);
        expect(post.customDate?.getTime()).toBe(testDate.getTime());
      });
    });

    test('should apply custom mapper in returning() with aliased selector', async () => {
      await withDatabase(async (db) => {
        // First create a user since posts need userId
        const user = await db.users.insert({
          username: 'alias_mapper_user',
          email: 'alias_mapper@test.com',
        }).returning();

        const testDate = new Date('2024-07-20T14:45:00Z');

        // Insert with returning selector using alias
        // This tests that mapper is applied when alias != property name
        const result = await db.posts.insert({
          title: 'Aliased Mapper Test',
          userId: user.id,
          customDate: testDate,
        }).returning(p => ({
          id: p.id,
          myDate: p.customDate, // Alias 'myDate' for property 'customDate'
          postTitle: p.title,
        }));

        expect(result.id).toBeDefined();
        expect(result.postTitle).toBe('Aliased Mapper Test');
        // Custom mapper should be applied to aliased column
        expect(result.myDate).toBeInstanceOf(Date);
        expect(result.myDate?.getTime()).toBe(testDate.getTime());
      });
    });

    test('should apply custom mapper in insertBulk returning() with aliased selector', async () => {
      await withDatabase(async (db) => {
        // First create a user since posts need userId
        const user = await db.users.insert({
          username: 'bulk_mapper_user',
          email: 'bulk_mapper@test.com',
        }).returning();

        const date1 = new Date('2024-08-10T09:00:00Z');
        const date2 = new Date('2024-08-11T10:00:00Z');

        // Bulk insert with returning selector using aliases
        const results = await db.posts.insertBulk([
          { title: 'Bulk Post 1', userId: user.id, customDate: date1 },
          { title: 'Bulk Post 2', userId: user.id, customDate: date2 },
        ]).returning(p => ({
          id: p.id,
          postDate: p.customDate, // Aliased
          name: p.title,
        }));

        expect(results).toHaveLength(2);

        // Both should have custom mapper applied
        expect(results[0].postDate).toBeInstanceOf(Date);
        expect(results[0].postDate?.getTime()).toBe(date1.getTime());
        expect(results[0].name).toBe('Bulk Post 1');

        expect(results[1].postDate).toBeInstanceOf(Date);
        expect(results[1].postDate?.getTime()).toBe(date2.getTime());
        expect(results[1].name).toBe('Bulk Post 2');
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

        const updated = await db.users
          .where(u => eq(u.id, users.alice.id))
          .update({ age: 26, isActive: false })
          .returning();

        expect(updated).toHaveLength(1);
        expect(updated[0].age).toBe(26);
        expect(updated[0].isActive).toBe(false);
        expect(updated[0].username).toBe('alice'); // Unchanged fields preserved
      });
    });

    test('should update multiple records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const updated = await db.users
          .where(u => eq(u.isActive, true))
          .update({ isActive: false })
          .returning();

        expect(updated.length).toBeGreaterThanOrEqual(2);
        updated.forEach(u => {
          expect(u.isActive).toBe(false);
        });
      });
    });

    test('should update with NULL value', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users
          .where(u => eq(u.id, users.alice.id))
          .update({ age: null })
          .returning();

        expect(updated[0].age).toBeNull();
      });
    });

    test('should return empty array when no records match update condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const updated = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .update({ age: 99 })
          .returning();

        expect(updated).toHaveLength(0);
      });
    });

    test('should return affected count with affectedCount()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Update multiple users
        const count = await db.users
          .where(u => eq(u.isActive, true))
          .update({ age: 99 })
          .affectedCount();

        expect(count).toBeGreaterThanOrEqual(2);
        expect(typeof count).toBe('number');
      });
    });

    test('should return 0 affected count when no records match', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .update({ age: 99 })
          .affectedCount();

        expect(count).toBe(0);
      });
    });

    test('should return affected count for table-level update (all records)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const totalUsers = await db.users.count();

        const count = await db.users
          .update({ age: 50 })
          .affectedCount();

        expect(count).toBe(totalUsers);
      });
    });
  });

  describe('DELETE operations', () => {
    test('should delete a single record', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const countBefore = await db.users.count();

        await db.users.where(u => eq(u.id, users.charlie.id)).delete();

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

        await db.users.where(u => eq(u.isActive, true)).delete();

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

        await db.users.where(u =>
          sql`${u.age} > 30 AND ${u.isActive} = true`
        ).delete();

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

        await db.users.where(u => eq(u.username, 'nonexistent')).delete();

        const countAfter = await db.users.count();
        expect(countAfter).toBe(countBefore);
      });
    });

    test('should return affected count with affectedCount()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const countBefore = await db.users.where(u => eq(u.isActive, true)).count();

        const deletedCount = await db.users
          .where(u => eq(u.isActive, true))
          .delete()
          .affectedCount();

        expect(deletedCount).toBe(countBefore);
        expect(typeof deletedCount).toBe('number');
      });
    });

    test('should return 0 affected count when no records match delete', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const deletedCount = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .delete()
          .affectedCount();

        expect(deletedCount).toBe(0);
      });
    });

    test('should return affected count for table-level delete (all records)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const totalUsers = await db.users.count();

        const deletedCount = await db.users
          .delete()
          .affectedCount();

        expect(deletedCount).toBe(totalUsers);

        // Verify all users deleted
        const remaining = await db.users.count();
        expect(remaining).toBe(0);
      });
    });

    test('should cascade delete when foreign key is set to cascade', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Delete user should cascade to posts
        await db.users.where(u => eq(u.id, users.alice.id)).delete();

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
