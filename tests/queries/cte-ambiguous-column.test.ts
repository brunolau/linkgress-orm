import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, sql, and } from '../../src';
import { DbCteBuilder } from '../../src/query/cte-builder';

/**
 * Test for ambiguous column reference bug when using CTE with navigation properties
 *
 * Bug scenario:
 * 1. Create a CTE aggregation from a table with navigation properties
 * 2. Use groupBy on the query
 * 3. Join with another CTE
 * 4. The final SELECT has unqualified column names causing "ambiguous column reference"
 *
 * This reproduces the issue from:
 * - productPriceAdvanceDiscounts with productPriceId FK
 * - productPrice with product navigation
 * - groupBy + leftJoin with another CTE
 */
describe('CTE with Navigation and GroupBy - Ambiguous Column Bug', () => {
  test('should not produce ambiguous column reference when joining CTEs with navigation', async () => {
    await withDatabase(async (db) => {
      const { users, posts } = await seedTestData(db);

      // This simulates the pattern:
      // 1. First CTE: aggregate posts grouped by userId
      const cteBuilder = new DbCteBuilder();

      // CTE 1: Aggregate post views by user (similar to productPriceAdvanceDiscount aggregation)
      const postViewsCte = cteBuilder.withAggregation(
        'post_views_cte',
        db.posts.select(p => ({
          postUserId: p.userId,
          postViews: p.views,
        })),
        p => ({ postUserId: p.postUserId }),
        'postStats',
      );

      // CTE 2: Select posts with navigation to user, then groupBy
      // This is where the bug occurs - the navigation creates a JOIN,
      // and when we later join with another CTE, column names become ambiguous
      const postWithUserCte = cteBuilder.withAggregation(
        'post_with_user_cte',
        db.posts.select(p => ({
          id: p.id,
          title: p.title,
          userId: p.userId,
          views: p.views,
          // Navigation property - this creates a JOIN internally
          authorName: p.user!.username,
        })).groupBy(p => ({
          postId: p.id,
          userId: p.userId,
          authorName: p.authorName,
        })).select(p => ({
          postId: p.key.postId,
          userId: p.key.userId,
          authorName: p.key.authorName,
          maxViews: p.max(pr => pr.views),
        })).leftJoin(
          postViewsCte,
          (post, stats) => eq(post.userId, stats.postUserId),
          (post, stats) => ({
            postId: post.postId,
            userId: post.userId,
            authorName: post.authorName,
            maxViews: post.maxViews,
            postStats: stats.postStats,
          }),
        ),
        p => ({ userId: p.userId }),
        'userPosts',
      );

      // Final query: join users with the CTE
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(...cteBuilder.getCtes())
        .leftJoin(
          postWithUserCte,
          (user, cte) => eq(user.id, cte.userId),
          (user, cte) => ({
            userId: user.id,
            username: user.username,
            userPosts: cte.userPosts,
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        expect(r.userId).toBeDefined();
        expect(r.username).toBeDefined();
      });
    });
  });

  test('should handle navigation in grouped CTE without ambiguity', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();

      // Create a CTE with navigation property in selection
      // Then group by and join with the main query
      const postsByCategoryCte = cteBuilder.withAggregation(
        'posts_by_category_cte',
        db.posts.select(p => ({
          postId: p.id,
          postTitle: p.title,
          postUserId: p.userId,
          // Navigation to user - this causes the join
          authorUsername: p.user!.username,
          authorEmail: p.user!.email,
        })).groupBy(p => ({
          userId: p.postUserId,
          authorUsername: p.authorUsername,
        })).select(p => ({
          userId: p.key.userId,
          authorUsername: p.key.authorUsername,
          postCount: p.count(),
        })),
        p => ({ userId: p.userId }),
        'categoryStats',
      );

      // Join with users table
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(...cteBuilder.getCtes())
        .leftJoin(
          postsByCategoryCte,
          (user, cte) => eq(user.id, cte.userId),
          (user, cte) => ({
            id: user.id,
            username: user.username,
            categoryStats: cte.categoryStats,
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
    });
  });

  test('should qualify column names when CTE inner query has navigation joins', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Simple case: posts with navigation, grouped, then used in main query
      const result = await db.posts
        .where(p => gt(p.id, 0))
        .select(p => ({
          id: p.id,
          title: p.title,
          userId: p.userId,
          // Navigation creates JOIN with users table
          // Both posts and users have 'id' column - potential ambiguity
          authorName: p.user!.username,
        }))
        .groupBy(p => ({
          postId: p.id,
          postUserId: p.userId,
          authorName: p.authorName,
        }))
        .select(p => ({
          postId: p.key.postId,
          userId: p.key.postUserId,
          authorName: p.key.authorName,
          maxId: p.max(pr => pr.id), // This references 'id' which exists in both tables
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        expect(r.postId).toBeDefined();
        expect(r.userId).toBeDefined();
        expect(r.authorName).toBeDefined();
      });
    });
  });

  test('should handle complex CTE chain with multiple navigation joins', async () => {
    await withDatabase(async (db) => {
      const { orders } = await seedTestData(db);

      const cteBuilder = new DbCteBuilder();

      // CTE: Orders with user navigation, grouped by user
      const orderStatsCte = cteBuilder.withAggregation(
        'order_stats_cte',
        db.orders.select(o => ({
          orderId: o.id,
          orderUserId: o.userId,
          orderAmount: o.totalAmount,
          // Navigation to user
          customerName: o.user!.username,
          customerEmail: o.user!.email,
        })).groupBy(o => ({
          userId: o.orderUserId,
          customerName: o.customerName,
        })).select(o => ({
          userId: o.key.userId,
          customerName: o.key.customerName,
          orderCount: o.count(),
          // totalAmount is a decimal field
        })),
        o => ({ userId: o.userId }),
        'orderStats',
      );

      // Main query: users joined with order stats CTE
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(...cteBuilder.getCtes())
        .leftJoin(
          orderStatsCte,
          (user, cte) => eq(user.id, cte.userId),
          (user, cte) => ({
            userId: user.id,
            username: user.username,
            email: user.email,
            orderStats: cte.orderStats,
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        expect(r.userId).toBeDefined();
        expect(r.username).toBeDefined();
      });
    });
  });

  /**
   * This test reproduces the exact pattern from the gopass-eshop query:
   * 1. First CTE aggregates one table
   * 2. Second CTE has navigation property in SQL expression, then groupBy, then leftJoin with first CTE
   * 3. Main query joins with second CTE
   */
  test('should handle navigation in sql expression with groupBy and CTE join (exact reproduction)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();

      // First CTE: aggregate posts by userId (like productPriceAdvanceDiscounts)
      const postStatsCte = cteBuilder.withAggregation(
        'post_stats_cte',
        db.posts.select(p => ({
          postUserId: p.userId,
          postViews: p.views,
          postTitle: p.title,
        })),
        p => ({ postUserId: p.postUserId }),
        'postStats',
      );

      // Second CTE: Complex query with navigation in SQL expression
      // This mimics: sql`CASE WHEN ${p.product.priceMode} = ... THEN ${p.id} ELSE -1 END`
      const postGroupedCte = cteBuilder.withAggregation(
        'post_grouped_cte',
        db.posts.select(p => ({
          // SQL expression with navigation property - THIS IS THE KEY PART
          computedId: sql<number>`CASE WHEN ${p.user!.isActive} = true THEN ${p.id} ELSE -1 END`.as('computedId'),
          postId: p.id,
          views: p.views,
          userId: p.user!.id,
        })).groupBy(p => ({
          computedId: p.computedId,
          postId: p.postId,
          userId: p.userId,
        })).select(p => ({
          computedId: p.key.computedId,
          postId: p.key.postId,
          userId: p.key.userId,
          minViews: p.min(pr => pr.views),
        })).leftJoin(
          // Join with first CTE
          postStatsCte,
          (post, stats) => eq(post.userId, stats.postUserId),
          (post, stats) => ({
            computedId: post.computedId,
            postIdOfPost: post.postId,
            userId: post.userId,
            minViews: post.minViews,
            postStats: stats.postStats,
          }),
        ).orderBy(p => [p.postIdOfPost, p.userId]),
        p => ({ postIdOfPost: p.postIdOfPost }),
        'groupedPosts',
      );

      // Main query: join users with the second CTE
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(...cteBuilder.getCtes())
        .leftJoin(
          postGroupedCte,
          (user, cte) => eq(user.id, cte.postIdOfPost),
          (user, cte) => ({
            id: user.id,
            username: user.username,
            groupedPosts: cte.groupedPosts,
            orderIds: user.orders!.select(od => ({
              id: od.id
            })).toNumberList(),
            ordersOne: user.orders!.select(od => ({
              id: od.id,
              tasksHeavy: od.orderTasks!.select(ot => ({
                id: ot.task!.id,
                hard: ot.task!.level!.createdBy!.email
              })).toList('tasksHeavy'),
              tasks: od.orderTasks!.select(ot => ({
                id: ot.task!.id
              })).toNumberList()
            })),
            postIds: user.posts!.select(p => ({
              ds: p.id
            }))
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        expect(r.id).toBeDefined();
        expect(r.username).toBeDefined();
      });
    });
  });

  /**
   * Simpler version: navigation in sql expression inside a collection
   */
  test('should handle navigation in sql expression inside collection select', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Query users with posts collection, where posts have navigation in SQL expression
      const result = await db.users
        .where(u => gt(u.id, 0))
        .select(u => ({
          id: u.id,
          username: u.username,
          posts: u.posts?.select(p => ({
            postId: p.id,
            title: p.title,
            // SQL expression referencing navigation property
            isFromActiveUser: sql<boolean>`${p.user!.isActive} = true`.as('isFromActiveUser'),
          })).toList('posts'),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
    });
  });

  /**
   * BUG: CTE join AND collection with navigation - gopass pattern
   * The collection inside the join result uses navigation which should create a JOIN
   *
   * This test combines:
   * 1. Main query with CTE join
   * 2. Collection that uses navigation property (p.user!.id)
   *
   * The toNumberList() doesn't detect the navigation and generate the JOIN.
   */
  test('should handle CTE join combined with collection navigation (gopass pattern)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();

      // First CTE: aggregate orders (similar to productPriceAdvanceDiscounts CTE)
      const orderStatsCte = cteBuilder.withAggregation(
        'order_stats_cte',
        db.orders.select(o => ({
          orderUserId: o.userId,
          orderAmount: o.totalAmount,
          orderStatus: o.status,
        })),
        o => ({ orderUserId: o.orderUserId }),
        'orderStats',
      );

      // Helper function for collection query (like buildTagQuery in gopass)
      // This navigates from post -> user -> id, causing a join
      const buildPostUserIdQuery = (user: any) => user.posts?.select((p: any) => ({
        userId: p.user!.id, // BUG: Navigation to p.user.id should create JOIN
      })).toNumberList();

      // Main query: users joined with CTE, with collection that has navigation
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(...cteBuilder.getCtes())
        .leftJoin(
          orderStatsCte,
          (user, cte) => eq(user.id, cte.orderUserId),
          (user, cte) => ({
            id: user.id,
            username: user.username,
            email: user.email,
            // Collection with navigation inside
            postUserIds: buildPostUserIdQuery(user),
            orderStats: cte.orderStats,
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        expect(r.id).toBeDefined();
        expect(r.username).toBeDefined();
      });
    });
  });

  /**
   * The exact gopass pattern - collection with navigation selecting 'id' field
   * which exists in both the main table and the joined table
   */
  /**
   * BUG: toNumberList() with navigation property doesn't generate JOIN
   *
   * Expected SQL:
   *   SELECT "user_id" as "__fk_user_id", "user"."id" as "authorId"
   *   FROM "posts"
   *   LEFT JOIN "users" "user" ON "posts"."user_id" = "user"."id"
   *
   * Actual SQL:
   *   SELECT "user_id" as "__fk_user_id", "authorId"
   *   FROM "posts"
   *
   * The navigation JOIN is missing and the column isn't qualified.
   */
  test('should handle collection with navigation selecting id field (toNumberList bug)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // This is the exact pattern causing the issue:
      // posts.select(p => ({ authorId: p.user!.id })).toNumberList()
      // The navigation to user.id should generate a JOIN
      const result = await db.users
        .where(u => gt(u.id, 0))
        .select(u => ({
          id: u.id,
          username: u.username,
          // Collection that navigates and selects 'id' from related table
          postAuthorIds: u.posts?.select(p => ({
            authorId: p.user!.id, // BUG: This should create a JOIN with users
          })).toNumberList(),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
    });
  });

  /**
   * Collection with multi-level navigation selecting fields
   */
  test('should handle collection with multi-level navigation', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Deep navigation: order -> orderTasks -> task -> level -> id
      const result = await db.users
        .where(u => gt(u.id, 0))
        .select(u => ({
          id: u.id,
          username: u.username,
          // Collection with deep navigation
          orderTaskLevelIds: u.orders?.select(o => ({
            orderTasks: o.orderTasks?.select(ot => ({
              levelId: ot.task!.level!.id, // Multi-level navigation
            })).toList('tasks'),
          })).toList('orders'),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);
    });
  });
});
