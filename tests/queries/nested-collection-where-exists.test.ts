import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src';

describe('nested collection.where().exists() in WHERE clause', () => {
  test('collection.where(item => item.ref.collection.where(...).exists()).exists() in WHERE', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern: collection → reference navigation → collection → .where().exists()
      // This mirrors the user's query:
      //   p.b2bGroupProducts.where(gp => gp.b2bGroup.b2bPartnerGroups.where(pg => eq(pg.b2bPartnerId, value)).exists()).exists()
      //
      // Using existing entities:
      //   Post → postComments (many) → order (one) → orderTasks (many)
      const result = await db.posts
        .where(p =>
          p.postComments!
            .where(pc => pc.order!.orderTasks!.where(ot => eq(ot.sortOrder, 1)).exists())
            .exists()
        )
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      // We just need the query to build and execute without "where is not a function" error
      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('collection.where(item => item.ref.collection.exists()).exists() in WHERE (no inner where)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Simpler variant: no inner .where(), just .exists() on the nested collection
      const result = await db.posts
        .where(p =>
          p.postComments!
            .where(pc => pc.order!.orderTasks!.exists())
            .exists()
        )
        .select(p => ({
          id: p.id,
          title: p.title,
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });

  test('nested collection.where().exists() in SELECT projection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Same pattern but in SELECT instead of WHERE
      const result = await db.posts
        .select(p => ({
          title: p.title,
          hasOrdersWithTasks: p.postComments!
            .where(pc => pc.order!.orderTasks!.where(ot => eq(ot.sortOrder, 1)).exists())
            .exists(),
        }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });
});
