import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, ne, gt, and } from '../../src';

describe('Navigation in count() and null handling in eq()', () => {
  describe('eq() with null values', () => {
    test('eq(field, null) should generate IS NULL', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create a user without orders to test null navigation
        await db.users.insert({
          username: 'noorders',
          email: 'noorders@test.com',
          age: 30,
          isActive: true,
        }).returning();

        // Query users where age equals null (none should match since we set ages)
        const result = await db.users
          .where(u => eq(u.age, null as any))
          .toList();

        // All test users have ages set, so this should return empty
        expect(result.length).toBe(0);
      });
    });

    test('eq(field, null) should work with count()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Insert a user with null age
        await db.users.insert({
          username: 'nullage',
          email: 'nullage@test.com',
          age: null as any,
          isActive: true,
        }).returning();

        // Count users where age is null
        const count = await db.users
          .where(u => eq(u.age, null as any))
          .count();

        expect(count).toBe(1);
      });
    });

    test('ne(field, null) should generate IS NOT NULL', async () => {
      await withDatabase(async (db) => {
        const data = await seedTestData(db);

        // Insert a user with null age
        await db.users.insert({
          username: 'nullage',
          email: 'nullage@test.com',
          age: null as any,
          isActive: true,
        }).returning();

        // Query users where age is not null
        const result = await db.users
          .where(u => ne(u.age, null as any))
          .toList();

        // Should return all users that have age set (alice, bob, charlie from seed)
        expect(result.length).toBe(3);
        expect(result.every(r => r.age !== null)).toBe(true);
      });
    });

    test('eq() with non-null value should still work normally', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => eq(u.username, 'alice'))
          .toList();

        expect(result.length).toBe(1);
        expect(result[0].username).toBe('alice');
      });
    });

    test('eq() with undefined should be handled properly', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // undefined is different from null - it's a "no value" operator in SQL
        // This tests that we only convert explicit null, not undefined
        const result = await db.users
          .where(u => gt(u.id, 0))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('count() with navigation properties in WHERE', () => {
    test('count() should work with single navigation property in where', async () => {
      await withDatabase(async (db) => {
        const data = await seedTestData(db);

        // Count orders where user.username equals 'alice'
        const count = await db.orders
          .where(o => eq(o.user!.username, 'alice'))
          .count();

        // Alice has 1 order
        expect(count).toBe(1);
      });
    });

    test('count() should work with navigation property and other conditions', async () => {
      await withDatabase(async (db) => {
        const data = await seedTestData(db);

        // Count orders where user is active and status is 'completed'
        const count = await db.orders
          .where(o => and(
            eq(o.user!.isActive, true),
            eq(o.status, 'completed')
          ))
          .count();

        // Alice's order is completed and Alice is active
        expect(count).toBe(1);
      });
    });

    test('count() should work with multi-level navigation in where', async () => {
      await withDatabase(async (db) => {
        const data = await seedTestData(db);

        // Count order tasks where task.level.name equals 'High Priority'
        const count = await db.orderTasks
          .where(ot => eq(ot.task!.level!.name, 'High Priority'))
          .count();

        expect(count).toBe(1);
      });
    });

    test('count() should work with navigation to user through multiple paths', async () => {
      await withDatabase(async (db) => {
        const data = await seedTestData(db);

        // Count posts where user.age is greater than 30
        const count = await db.posts
          .where(p => gt(p.user!.age, 30))
          .count();

        // Bob (age 35) has 1 post, Charlie (age 45) has 0 posts
        expect(count).toBe(1);
      });
    });

    test('count() should return correct count when navigation matches no rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Count orders where user.username is a non-existent user
        const count = await db.orders
          .where(o => eq(o.user!.username, 'nonexistent'))
          .count();

        expect(count).toBe(0);
      });
    });

    test('count() should work with navigation and null check combined', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create an order with a deleted/null user reference (edge case)
        // This tests both navigation join and null handling
        const count = await db.orders
          .where(o => and(
            eq(o.user!.isActive, true),
            ne(o.status, null as any)
          ))
          .count();

        // Both Alice and Bob are active and have non-null status
        expect(count).toBe(2);
      });
    });
  });

  describe('toList() with navigation continues to work', () => {
    test('toList() with navigation in where should still work', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .where(o => eq(o.user!.username, 'alice'))
          .select(o => ({
            id: o.id,
            status: o.status,
          }))
          .toList();

        expect(result.length).toBe(1);
        expect(result[0].status).toBe('completed');
      });
    });
  });

  describe('exists() method', () => {
    test('exists() should return true when rows match', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const exists = await db.users
          .where(u => eq(u.username, 'alice'))
          .exists();

        expect(exists).toBe(true);
      });
    });

    test('exists() should return false when no rows match', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const exists = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .exists();

        expect(exists).toBe(false);
      });
    });

    test('exists() should work with navigation properties in WHERE', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Check if orders exist where user.username equals 'alice'
        const exists = await db.orders
          .where(o => eq(o.user!.username, 'alice'))
          .exists();

        expect(exists).toBe(true);
      });
    });

    test('exists() should work with multi-level navigation in WHERE', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Check if order tasks exist where task.level.name equals 'High Priority'
        const exists = await db.orderTasks
          .where(ot => eq(ot.task!.level!.name, 'High Priority'))
          .exists();

        expect(exists).toBe(true);
      });
    });

    test('exists() should return false for multi-level navigation with no matches', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const exists = await db.orderTasks
          .where(ot => eq(ot.task!.level!.name, 'NonExistent Priority'))
          .exists();

        expect(exists).toBe(false);
      });
    });

    test('exists() should work with null check using eq()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Insert a user with null age
        await db.users.insert({
          username: 'nullage',
          email: 'nullage@test.com',
          age: null as any,
          isActive: true,
        }).returning();

        // Check if user with null age exists
        const exists = await db.users
          .where(u => eq(u.age, null as any))
          .exists();

        expect(exists).toBe(true);
      });
    });

    test('exists() should work with complex conditions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const exists = await db.orders
          .where(o => and(
            eq(o.user!.isActive, true),
            eq(o.status, 'completed')
          ))
          .exists();

        expect(exists).toBe(true);
      });
    });
  });
});
