import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, lte, like, and, or, not } from '../../src';
import { assertType } from '../utils/type-tester';

describe('Basic Query Operations (Fixed)', () => {
  describe('SELECT queries', () => {
    test('should select all users with toList()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users.toList();

        expect(users).toHaveLength(3);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<string, typeof u.username>(u.username);
          assertType<string, typeof u.email>(u.email);
          assertType<number | undefined, typeof u.age>(u.age);
          assertType<boolean, typeof u.isActive>(u.isActive);
        });
        expect(users[0]).toHaveProperty('username');
        expect(users[0]).toHaveProperty('email');
        // Verify types are unwrapped
        expect(typeof users[0].username).toBe('string');
        expect(typeof users[0].age).toBe('number');
      });
    });

    test('should select with projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .select(u => ({
            name: u.username,
            userEmail: u.email,
          }))
          .toList();

        expect(users).toHaveLength(3);
        users.forEach(u => {
          // Type assertions
          assertType<string, typeof u.name>(u.name);
          assertType<string, typeof u.userEmail>(u.userEmail);
        });
        expect(users[0]).toHaveProperty('name');
        expect(users[0]).toHaveProperty('userEmail');
        expect(users[0]).not.toHaveProperty('username');
      });
    });
  });

  describe('WHERE conditions', () => {
    test('should filter with eq condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => eq(u.username, 'alice'))
          .toList();

        expect(users).toHaveLength(1);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<string, typeof u.username>(u.username);
        });
        expect(users[0].username).toBe('alice');
      });
    });

    test('should filter with gt condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .select(u => ({
            username: u.username,
            age: u.age,
          }))
          .where(u => gt(u.age!, 30))
          .toList();

        expect(users.length).toBeGreaterThanOrEqual(2);
        users.forEach(u => {
          // Type assertions
          assertType<string, typeof u.username>(u.username);
          assertType<number | undefined, typeof u.age>(u.age);
          expect(u.age).toBeGreaterThan(30);
        });
      });
    });

    test('should filter with multiple conditions using and', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .select(u => ({
            username: u.username,
            age: u.age,
            isActive: u.isActive,
          }))
          .where(u => and(
            gt(u.age!, 20),
            eq(u.isActive, true)
          ))
          .toList();

        expect(users.length).toBeGreaterThan(0);
        users.forEach(u => {
          // Type assertions
          assertType<string, typeof u.username>(u.username);
          assertType<number | undefined, typeof u.age>(u.age);
          assertType<boolean, typeof u.isActive>(u.isActive);
          expect(u.age).toBeGreaterThan(20);
          expect(u.isActive).toBe(true);
        });
      });
    });

    test('should filter with or condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => or(
            eq(u.username, 'alice'),
            eq(u.username, 'bob')
          ))
          .toList();

        expect(users).toHaveLength(2);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<string, typeof u.username>(u.username);
        });
      });
    });
  });

  describe('Ordering and Pagination', () => {
    test('should order by field ascending', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .orderBy(u => u.age)
          .toList();

        expect(users).toHaveLength(3);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<number | undefined, typeof u.age>(u.age);
        });
        expect(users[0].age).toBeLessThanOrEqual(users[1].age!);
        expect(users[1].age).toBeLessThanOrEqual(users[2].age!);
      });
    });

    test('should order by field descending', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .orderBy(u => [[u.age, 'DESC']])
          .toList();

        expect(users).toHaveLength(3);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<number | undefined, typeof u.age>(u.age);
        });
        expect(users[0].age).toBeGreaterThanOrEqual(users[1].age!);
        expect(users[1].age).toBeGreaterThanOrEqual(users[2].age!);
      });
    });

    test('should limit results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .limit(2)
          .toList();

        expect(users).toHaveLength(2);
        users.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
          assertType<string, typeof u.username>(u.username);
        });
      });
    });

    test('should offset results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const allUsers = await db.users.orderBy(u => u.id).toList();
        const offsetUsers = await db.users
          .orderBy(u => u.id)
          .offset(1)
          .toList();

        expect(offsetUsers).toHaveLength(2);
        allUsers.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
        });
        offsetUsers.forEach(u => {
          // Type assertions
          assertType<number, typeof u.id>(u.id);
        });
        expect(offsetUsers[0].id).toBe(allUsers[1].id);
      });
    });
  });

  describe('First operations', () => {
    test('should get first record', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .orderBy(u => u.username)
          .first();

        expect(user).toBeDefined();
        // Type assertions
        assertType<number, typeof user.id>(user.id);
        assertType<string, typeof user.username>(user.username);
        assertType<string, typeof user.email>(user.email);
        expect(user.username).toBe('alice');
      });
    });

    test('should get firstOrDefault when record exists', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'alice'))
          .firstOrDefault();

        expect(user).not.toBeNull();
        if (user) {
          // Type assertions
          assertType<number, typeof user.id>(user.id);
          assertType<string, typeof user.username>(user.username);
        }
        expect(user?.username).toBe('alice');
      });
    });

    test('should return null for firstOrDefault when no record exists', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .firstOrDefault();

        expect(user).toBeNull();
      });
    });
  });

  describe('Count operations', () => {
    test('should count all records with count()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users.count();

        expect(count).toBe(3);
      });
    });

    test('should count filtered records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users
          .where(u => eq(u.isActive, true))
          .count();

        expect(count).toBe(2);
      });
    });

    test('should count selected ', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users.select(p => ({
          id: p.id
        })).where(p => gt(p.id, -1)).count();

        expect(count).toBe(3);
      });
    });
  });
});
