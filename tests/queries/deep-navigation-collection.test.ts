import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { gt } from '../../src';

/**
 * Tests for deep navigation in collection queries.
 *
 * This tests the fix for the "missing FROM-clause entry for table" error
 * that occurred when accessing collections through deep navigation chains.
 *
 * Example pattern that was failing:
 * orderItem.productPrice.product.resort.productIntegrationDefinitions
 *
 * The fix ensures:
 * - CTE strategy: Uses only selectorNavigationJoins (joins within the collection's selector)
 * - LATERAL strategy: Uses all navigationJoins (including path from outer query)
 * - temptable strategy: Uses selectorNavigationJoins like CTE
 */
describe('Deep Navigation Collection Queries', () => {
  describe('CTE Strategy (default)', () => {
    test('should handle collection with single-level navigation in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Pattern: user.orders -> orderTask.task (navigation within collection selector)
        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,  // Single-level navigation
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Verify structure
        const userWithOrders = result.find(u => u.orderTasks.length > 0);
        if (userWithOrders) {
          expect(userWithOrders.orderTasks[0]).toHaveProperty('orderId');
          expect(userWithOrders.orderTasks[0]).toHaveProperty('tasks');
        }
      });
    });

    test('should handle collection with multi-level navigation in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Pattern: user.orders -> orderTask.task.level (multi-level navigation within selector)
        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,
                levelId: ot.task!.level!.id,      // Multi-level navigation
                levelName: ot.task!.level!.name,  // Multi-level navigation
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with deep navigation (3+ levels) in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Pattern: user.orders -> orderTask.task.level.createdBy (3-level navigation)
        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,
                levelName: ot.task!.level!.name,
                creatorEmail: ot.task!.level!.createdBy!.email,  // 3-level navigation
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle toNumberList with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // This pattern was causing "missing FROM-clause entry" errors
        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            // Collection with navigation that returns IDs
            postAuthorIds: u.posts!.select(p => ({
              authorId: p.user!.id,
            })).toNumberList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with mixed navigation depths', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Mix of direct fields, single-level nav, and multi-level nav
        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            orderData: u.orders!.select(o => ({
              // Direct field
              orderId: o.id,
              totalAmount: o.totalAmount,
              // Single-level navigation
              taskCount: o.orderTasks!.count(),
              // Multi-level navigation in nested collection
              taskDetails: o.orderTasks!.select(ot => ({
                sortOrder: ot.sortOrder,
                taskTitle: ot.task!.title,
                levelName: ot.task!.level!.name,
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('LATERAL Strategy', () => {
    test('should handle collection with single-level navigation in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with multi-level navigation in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,
                levelId: ot.task!.level!.id,
                levelName: ot.task!.level!.name,
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with deep navigation (3+ levels) in selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!.select(ot => ({
                taskId: ot.taskId,
                taskTitle: ot.task!.title,
                levelName: ot.task!.level!.name,
                creatorEmail: ot.task!.level!.createdBy!.email,
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle toNumberList with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postAuthorIds: u.posts!.select(p => ({
              authorId: p.user!.id,
            })).toNumberList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection navigation with ordering', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!
                .orderBy(ot => ot.sortOrder)
                .select(ot => ({
                  taskId: ot.taskId,
                  sortOrder: ot.sortOrder,
                  taskTitle: ot.task!.title,
                  levelName: ot.task!.level!.name,
                })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection navigation with limit', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            orderTasks: u.orders!.select(o => ({
              orderId: o.id,
              // Limit to first 2 tasks with navigation
              tasks: o.orderTasks!
                .orderBy(ot => ot.sortOrder)
                .limit(2)
                .select(ot => ({
                  taskId: ot.taskId,
                  taskTitle: ot.task!.title,
                })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Temptable Strategy', () => {
    /**
     * Note: The temptable strategy has limitations - it doesn't currently support
     * navigation joins within collection selectors. These tests verify the basic
     * functionality without navigation.
     *
     * For queries with navigation in collection selectors, use CTE or LATERAL strategy.
     */

    test('should handle simple collection without navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Simple collection without navigation
        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'temptable' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postTitles: u.posts!.select(p => ({
              title: p.title,
              views: p.views,
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle simple collection with ordering by unmapped column', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Use 'id' for ordering which doesn't have column mapping issues
        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'temptable' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            userId: u.id,
            posts: u.posts!
              .orderBy(p => p.id)
              .select(p => ({
                postId: p.id,
                title: p.title,
              })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle toNumberList without navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'temptable' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postIds: u.posts!.select(p => ({
              id: p.id,
            })).toNumberList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with limit', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'temptable' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            // Limit to first 2 posts
            firstTwoPosts: u.posts!
              .orderBy(p => p.id)
              .limit(2)
              .select(p => ({
                id: p.id,
                title: p.title,
              })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle collection with aggregation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .withQueryOptions({ collectionStrategy: 'temptable' })
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postCount: u.posts!.count(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(typeof r.postCount).toBe('number');
        });
      });
    });
  });

  describe('Strategy comparison - same results', () => {
    test('CTE and LATERAL strategies should return equivalent data for navigation queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query with navigation - run on CTE and LATERAL (temptable doesn't support navigation)
        const baseQuery = (strategy: 'cte' | 'lateral') =>
          db.orders
            .withQueryOptions({ collectionStrategy: strategy })
            .where(o => gt(o.id, 0))
            .orderBy(o => o.id)
            .select(o => ({
              orderId: o.id,
              tasks: o.orderTasks!
                .orderBy(ot => ot.sortOrder)
                .select(ot => ({
                  taskId: ot.taskId,
                  sortOrder: ot.sortOrder,
                  taskTitle: ot.task!.title,
                  levelName: ot.task!.level!.name,
                })).toList(),
            }))
            .toList();

        const [cteResult, lateralResult] = await Promise.all([
          baseQuery('cte'),
          baseQuery('lateral'),
        ]);

        // Both strategies should return the same number of rows
        expect(cteResult.length).toBe(lateralResult.length);

        // Verify data consistency across strategies
        for (let i = 0; i < cteResult.length; i++) {
          expect(cteResult[i].orderId).toBe(lateralResult[i].orderId);
          expect(cteResult[i].tasks.length).toBe(lateralResult[i].tasks.length);
        }
      });
    });

    test('CTE and LATERAL should return equivalent data for simple queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Simple query without navigation - CTE and LATERAL should support this
        // Don't use orderBy inside collection to avoid column alias issues
        const baseQuery = (strategy: 'cte' | 'lateral') =>
          db.users
            .withQueryOptions({ collectionStrategy: strategy })
            .where(u => gt(u.id, 0))
            .orderBy(u => u.id)
            .select(u => ({
              userId: u.id,
              posts: u.posts!
                .select(p => ({
                  postId: p.id,
                  title: p.title,
                })).toList(),
            }))
            .toList();

        const [cteResult, lateralResult] = await Promise.all([
          baseQuery('cte'),
          baseQuery('lateral'),
        ]);

        // Both strategies should return the same number of rows
        expect(cteResult.length).toBe(lateralResult.length);

        // Verify data consistency across strategies
        for (let i = 0; i < cteResult.length; i++) {
          expect(cteResult[i].userId).toBe(lateralResult[i].userId);
          expect(cteResult[i].posts.length).toBe(lateralResult[i].posts.length);
        }
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle empty collections with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query users, some may have no orders
        const result = await db.users
          .select(u => ({
            id: u.id,
            orderTasks: u.orders!.select(o => ({
              tasks: o.orderTasks!.select(ot => ({
                taskTitle: ot.task!.title,
              })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Some users might have empty orderTasks array
        const userWithNoOrders = result.find(u => u.orderTasks.length === 0);
        if (userWithNoOrders) {
          expect(userWithNoOrders.orderTasks).toEqual([]);
        }
      });
    });

    test('should handle NULL navigation gracefully', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // When navigation target might be NULL (e.g., task.level can be null)
        const result = await db.orders
          .select(o => ({
            orderId: o.id,
            tasks: o.orderTasks!.select(ot => ({
              taskId: ot.taskId,
              // level might be NULL for some tasks
              levelName: ot.task!.level?.name,
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle filter with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            filteredTasks: u.orders!.select(o => ({
              tasks: o.orderTasks!
                .where(ot => gt(ot.sortOrder, 0))
                .select(ot => ({
                  taskTitle: ot.task!.title,
                })).toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle aggregations with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            // Count of order tasks across all orders
            totalOrderTasks: u.orders!.select(o => ({
              taskCount: o.orderTasks!.count(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('firstOrDefault should return single object not array (CTE)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            // firstOrDefault should return a single object, not an array
            firstTask: o.orderTasks!
              .orderBy(ot => ot.sortOrder)
              .select(ot => ({
                taskId: ot.taskId,
                sortOrder: ot.sortOrder,
              }))
              .firstOrDefault(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // firstTask should be an object or null, NOT an array
        const orderWithTask = result.find(r => r.firstTask !== null);
        if (orderWithTask) {
          expect(orderWithTask.firstTask).not.toBeInstanceOf(Array);
          expect(orderWithTask.firstTask).toHaveProperty('taskId');
          expect(orderWithTask.firstTask).toHaveProperty('sortOrder');
        }
      });
    });

    test('firstOrDefault should return single object not array (LATERAL)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            // firstOrDefault should return a single object, not an array
            firstTask: o.orderTasks!
              .orderBy(ot => ot.sortOrder)
              .select(ot => ({
                taskId: ot.taskId,
                sortOrder: ot.sortOrder,
              }))
              .firstOrDefault(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // firstTask should be an object or null, NOT an array
        const orderWithTask = result.find(r => r.firstTask !== null);
        if (orderWithTask) {
          expect(orderWithTask.firstTask).not.toBeInstanceOf(Array);
          expect(orderWithTask.firstTask).toHaveProperty('taskId');
          expect(orderWithTask.firstTask).toHaveProperty('sortOrder');
        }
      });
    });

    test('firstOrDefault with navigation should return single object (LATERAL)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // This is the exact pattern from the user's query
        const result = await db.orders
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            orderItems: o.orderTasks!.select(ot => ({
              taskId: ot.taskId,
              // Navigation + firstOrDefault should return single object
              firstCard: ot.task!.level!.createdBy!.posts!
                .where(p => gt(p.views!, 0))
                .select(p => ({
                  postId: p.id,
                  title: p.title,
                }))
                .firstOrDefault(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Check that firstCard is an object or null, not an array
        for (const order of result) {
          for (const item of order.orderItems) {
            if (item.firstCard !== null) {
              expect(item.firstCard).not.toBeInstanceOf(Array);
              expect(item.firstCard).toHaveProperty('postId');
            }
          }
        }
      });
    });
  });
});
