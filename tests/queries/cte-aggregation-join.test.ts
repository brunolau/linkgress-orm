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
    });
  });
});
