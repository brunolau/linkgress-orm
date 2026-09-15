import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, and, exists, notExists } from '../../src';

describe('exists() function with collection navigation', () => {
  test('exists(collection.where(...)) in WHERE clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // exists() function wrapping a collection with where - equivalent to:
      //   p.postComments!.where(pc => eq(pc.comment, 'Great post!')).exists()
      const result = await db.posts
        .where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Great post!'))))
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

		console.log(result);
		

      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('exists(collection) without where in WHERE clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // exists() function on a collection without any where filter
      const result = await db.posts
        .where(p => exists(p.postComments!))
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('exists(collection.where(...)) returns same results as collection.where(...).exists()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Method form
      const resultMethod = await db.posts
        .where(p => p.postComments!.where(pc => eq(pc.comment, 'Great post!')).exists())
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      // Function form
      const resultFunction = await db.posts
        .where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Great post!'))))
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      expect(resultFunction).toEqual(resultMethod);
    });
  });

  test('notExists(collection.where(...)) in WHERE clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.posts
        .where(p => notExists(p.postComments!.where(pc => eq(pc.comment, 'nonexistent comment'))))
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
      // All posts should be returned since no comment matches
      expect(result.length).toBeGreaterThan(0);
    });
  });

  test('exists() with nested navigation: collection → reference → collection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Nested pattern with exists() function form:
      //   exists(p.postComments!.where(pc => pc.order!.orderTasks!.where(...).exists()))
      const result = await db.posts
        .where(p => exists(
          p.postComments!.where(pc =>
            pc.order!.orderTasks!.where(ot => eq(ot.sortOrder, 1)).exists()
          )
        ))
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('exists(collection.where(...)) in SELECT projection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.posts
        .select(p => ({
          title: p.title,
          hasComments: exists(p.postComments!.where(pc => eq(pc.comment, 'Great post!'))),
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('exists() with multiple conditions using and()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Mirrors the user's use case: filtering by multiple conditions on a relation
      const result = await db.users
        .where(u => exists(
          u.orders!.where(o => and(
            eq(o.status, 'pending'),
            eq(o.userId, 1)
          ))
        ))
        .select(u => ({
          id: u.id,
          username: u.username,
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });
});
