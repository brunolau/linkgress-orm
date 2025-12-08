import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { DbCteBuilder, eq, gt, sql } from '../../src';

describe('CTE with Aggregation and Join', () => {
  test('should handle complex CTE with aggregation, groupBy, leftJoin, and orderBy', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const reproBuilder = new DbCteBuilder();
      const groupingCte = reproBuilder.withAggregation(
        'product_price_advance_cte',
        db.posts
          .where(u => gt(u.id, -1))
          .select(u => ({
            postId: u.id,
            userId: u.userId,
            username: u.content,
            createdAt: u.customDate,
          })),
        p => ({ advancePriceId: p.userId }),
        'advancePrices',
      );

      const failingCte = reproBuilder.withAggregation(
        'order_stats',
        db.posts.select(p => ({
          postId: p.id,
          userId: p.userId,
          identifier: sql<number>`CASE WHEN ${p.user!.id} < ${10} THEN ${p.id} ELSE -1 END`.as('id'),
          kekes: p.content,
          distinctDay: p.customDate
        })).groupBy(p => ({
          userId: p.userId,
          identifier: p.identifier,
          distinctDay: p.distinctDay,
        })).select(p => ({
          userId: p.key.userId,
          identifier: p.key.identifier,
          distinctDay: p.key.distinctDay,
          minId: p.min(pr => pr.postId),
        })).leftJoin(
          groupingCte,
          (secondCte, firstCte) => eq(secondCte.userId, firstCte.advancePriceId),
          (secondCte, firstCte) => ({
            userIdOfPost: secondCte.userId,
            distinctDay: secondCte.distinctDay,
            customerCategoryId: secondCte.identifier,
            advancePrices: firstCte.advancePrices,
          }),
        ).orderBy(p => [
          p.userIdOfPost,
          p.distinctDay,
          p.customerCategoryId,
        ]),
        p => ({ userIdOfPost: p.userIdOfPost }),
        'orders',
      );

      const searchProducts = await db.users.where(p => gt(p.id, -1)).with(...reproBuilder.getCtes()).leftJoin(
        failingCte,
        (user, cte) => eq(user.id, cte.userIdOfPost),
        (user, cte) => ({
          id: user.id,
          age: user.age,
          email: user.email,
          username: user.username,
          orders: cte.orders
        }),
      ).toList();

      expect(searchProducts).toBeDefined();
      expect(Array.isArray(searchProducts)).toBe(true);

      // Verify that column mappers are preserved through groupBy and CTE joins
      // distinctDay should be a Date (mapped from integer), not a number
      const userWithOrders = searchProducts.find(u => u.orders && u.orders.length > 0);
      if (userWithOrders && userWithOrders.orders.length > 0) {
        const order = userWithOrders.orders[0];
        expect(order.distinctDay).toBeInstanceOf(Date);
      }
    });
  });

  test('should preserve column mappers through groupBy select', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Test that customDate (mapped via pgIntDatetime) is preserved through groupBy
      const results = await db.posts.select(p => ({
        postId: p.id,
        userId: p.userId,
        distinctDay: p.customDate
      })).groupBy(p => ({
        distinctDay: p.distinctDay,
      })).select(p => ({
        distinctDay: p.key.distinctDay,
        count: p.count(),
      })).toList();

      expect(results.length).toBeGreaterThan(0);
      // distinctDay should be a Date, not a number
      results.forEach(r => {
        if (r.distinctDay !== null) {
          expect(r.distinctDay).toBeInstanceOf(Date);
        }
      });
    });
  });

  test('should preserve column mappers in simple select', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Basic test - customDate should be Date
      const posts = await db.posts.select(p => ({
        id: p.id,
        customDate: p.customDate
      })).toList();

      expect(posts.length).toBeGreaterThan(0);
      posts.forEach(p => {
        if (p.customDate !== null) {
          expect(p.customDate).toBeInstanceOf(Date);
        }
      });
    });
  });
});
