import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * Tests for deep navigation properties in grouped queries.
 *
 * Bug: GroupedQueryBuilder and GroupedSelectQueryBuilder don't pass
 * schemaRegistry to ReferenceQueryBuilder, causing multi-level navigation
 * (e.g., p.product.resort.timezone) to fail with "cannot read property
 * X of undefined" when the schema registry is needed to resolve
 * nested navigation targets.
 */
describe('Deep navigation in grouped queries', () => {
  test('should handle 2-level navigation in grouped select', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern: orderTasks.select(ot => ({ ... ot.task!.level!.name ... })).groupBy(...)
      // This accesses task -> level (2-level navigation) in the original selector
      const result = await db.orderTasks
        .select(ot => ({
          orderId: ot.orderId,
          taskTitle: ot.task!.title,
          levelName: ot.task!.level!.name,
        }))
        .groupBy(p => ({
          orderId: p.orderId,
          levelName: p.levelName,
        }))
        .select(g => ({
          orderId: g.key.orderId,
          levelName: g.key.levelName,
          count: g.count(),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(typeof row.orderId).toBe('number');
        expect(typeof row.levelName).toBe('string');
        expect(typeof row.count).toBe('number');
      }
    });
  });

  test('should handle 3-level navigation in grouped select', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern: orderTasks.select(ot => ({ ... ot.task!.level!.createdBy!.email ... })).groupBy(...)
      // This accesses task -> level -> createdBy (3-level navigation)
      const result = await db.orderTasks
        .select(ot => ({
          orderId: ot.orderId,
          taskTitle: ot.task!.title,
          creatorEmail: ot.task!.level!.createdBy!.email,
        }))
        .groupBy(p => ({
          creatorEmail: p.creatorEmail,
        }))
        .select(g => ({
          creatorEmail: g.key.creatorEmail,
          count: g.count(),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(typeof row.creatorEmail).toBe('string');
        expect(typeof row.count).toBe('number');
      }
    });
  });

  test('should handle navigation in grouped select with aggregation', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern similar to user's: select with navigation, groupBy, second select with min/max
      const result = await db.productPrices
        .select(pp => ({
          productId: pp.productId,
          productName: pp.product!.name,
          price: pp.price,
          seasonId: pp.seasonId,
        }))
        .groupBy(p => ({
          productId: p.productId,
          productName: p.productName,
        }))
        .select(g => ({
          productId: g.key.productId,
          productName: g.key.productName,
          minPrice: g.min(p => p.price),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
      const skiPass = result.find(r => r.productName === 'Ski Pass');
      expect(skiPass).toBeDefined();
      expect(skiPass?.minPrice).toBe(50);
    });
  });
});
