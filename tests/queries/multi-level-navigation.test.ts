import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { gt } from '../../src';

describe('Multi-Level Navigation', () => {
  describe('Direct queries with multi-level navigation', () => {
    test('should navigate two levels: task.level', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.tasks
          .where(t => gt(t.id, 0))
          .select(t => ({
            id: t.id,
            title: t.title,
            levelName: t.level!.name,
            levelCreatorId: t.level!.createdById,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.id).toBeDefined();
          expect(r.title).toBeDefined();
          expect(r.levelName).toBeDefined();
          expect(r.levelCreatorId).toBeDefined();
        });
      });
    });

    test('should navigate three levels: task.level.createdBy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.tasks
          .where(t => gt(t.id, 0))
          .select(t => ({
            id: t.id,
            title: t.title,
            levelName: t.level!.name,
            creatorEmail: t.level!.createdBy!.email,
            creatorUsername: t.level!.createdBy!.username,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.id).toBeDefined();
          expect(r.title).toBeDefined();
          expect(r.levelName).toBeDefined();
          expect(r.creatorEmail).toBeDefined();
          expect(r.creatorEmail).toContain('@');
          expect(r.creatorUsername).toBeDefined();
        });
      });
    });

    test('should navigate four levels: orderTask.task.level.createdBy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orderTasks
          .where(ot => gt(ot.orderId, 0))
          .select(ot => ({
            orderId: ot.orderId,
            taskId: ot.taskId,
            taskTitle: ot.task!.title,
            levelName: ot.task!.level!.name,
            creatorEmail: ot.task!.level!.createdBy!.email,
            creatorUsername: ot.task!.level!.createdBy!.username,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.orderId).toBeDefined();
          expect(r.taskId).toBeDefined();
          expect(r.taskTitle).toBeDefined();
          expect(r.levelName).toBeDefined();
          expect(r.creatorEmail).toBeDefined();
          expect(r.creatorEmail).toContain('@');
          expect(r.creatorUsername).toBeDefined();
        });
      });
    });
  });

  describe('Collection queries with multi-level navigation', () => {
    test('should navigate multi-level in collection: order.orderTasks.task.level.createdBy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .where(o => gt(o.id, 0))
          .select(o => ({
            id: o.id,
            status: o.status,
            tasks: o.orderTasks?.select(ot => ({
              taskId: ot.task!.id,
              taskTitle: ot.task!.title,
              levelName: ot.task!.level!.name,
              creatorEmail: ot.task!.level!.createdBy!.email,
            })).toList('orderTasks'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.id).toBeDefined();
          expect(r.status).toBeDefined();
          expect(Array.isArray(r.tasks)).toBe(true);
          r.tasks?.forEach((t: any) => {
            expect(t.taskId).toBeDefined();
            expect(t.taskTitle).toBeDefined();
            expect(t.levelName).toBeDefined();
            expect(t.creatorEmail).toBeDefined();
            expect(t.creatorEmail).toContain('@');
          });
        });
      });
    });

    test('should handle navigation back to parent in collection: user.orders.user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orderInfo: u.orders?.select(o => ({
              orderId: o.id,
              orderStatus: o.status,
              userName: o.user!.username,
            })).toList('orders'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.id).toBeDefined();
          expect(r.username).toBeDefined();
          expect(Array.isArray(r.orderInfo)).toBe(true);
          r.orderInfo?.forEach((o: any) => {
            expect(o.orderId).toBeDefined();
            expect(o.orderStatus).toBeDefined();
            expect(o.userName).toBeDefined();
            // The userName should match the parent username
            expect(o.userName).toBe(r.username);
          });
        });
      });
    });

    test('should handle two-level navigation in collection: user.orders with order.user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            posts: u.posts?.select(p => ({
              postId: p.id,
              postTitle: p.title,
              authorName: p.user!.username,
              authorEmail: p.user!.email,
            })).toList('posts'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        const usersWithPosts = result.filter(r => (r.posts?.length ?? 0) > 0);
        expect(usersWithPosts.length).toBeGreaterThan(0);

        usersWithPosts.forEach(r => {
          r.posts?.forEach((p: any) => {
            expect(p.postId).toBeDefined();
            expect(p.postTitle).toBeDefined();
            expect(p.authorName).toBe(r.username);
            expect(p.authorEmail).toContain('@');
          });
        });
      });
    });
  });

  describe('Multi-level navigation with different strategies', () => {
    test('should work with CTE strategy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .where(o => gt(o.id, 0))
          .select(o => ({
            id: o.id,
            tasks: o.orderTasks?.select(ot => ({
              taskTitle: ot.task!.title,
              levelName: ot.task!.level!.name,
            })).toList('orderTasks'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      }, { collectionStrategy: 'cte' });
    });

    test('should work with LATERAL strategy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.orders
          .where(o => gt(o.id, 0))
          .select(o => ({
            id: o.id,
            tasks: o.orderTasks?.select(ot => ({
              taskTitle: ot.task!.title,
              levelName: ot.task!.level!.name,
            })).toList('orderTasks'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Deep navigation without intermediate field selection', () => {
    test('should select only from deepest navigation level (2 levels deep)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Bug: when selecting ONLY from the deepest navigation (no intermediate fields),
        // the intermediate JOINs are missing because collectTableAliasesFromSelection
        // only collects __tableAlias (leaf) but not __navigationAliases (intermediates).
        const result = await db.tasks
          .where(t => gt(t.id, 0))
          .select(t => ({
            creatorEmail: t.level!.createdBy!.email,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.creatorEmail).toBeDefined();
          expect(r.creatorEmail).toContain('@');
        });
      });
    });

    test('should select only from deepest navigation level (3 levels deep)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Select ONLY the deepest level field (createdBy.username) from orderTask,
        // without selecting any intermediate fields from task or level
        const result = await db.orderTasks
          .where(ot => gt(ot.orderId, 0))
          .select(ot => ({
            creatorUsername: ot.task!.level!.createdBy!.username,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.creatorUsername).toBeDefined();
          expect(typeof r.creatorUsername).toBe('string');
        });
      });
    });

    test('should select from deepest level with base table field only', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Select a base table field + deepest navigation field, skipping intermediates
        const result = await db.orderTasks
          .where(ot => gt(ot.orderId, 0))
          .select(ot => ({
            orderId: ot.orderId,
            creatorEmail: ot.task!.level!.createdBy!.email,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.orderId).toBeDefined();
          expect(r.creatorEmail).toBeDefined();
          expect(r.creatorEmail).toContain('@');
        });
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle null navigation at intermediate level', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create a task without a level
        await db.tasks.insert({
          title: 'Task Without Level',
          status: 'pending',
          priority: 'low',
          levelId: null as any,
        }).returning();

        const result = await db.tasks
          .where(t => gt(t.id, 0))
          .select(t => ({
            id: t.id,
            title: t.title,
            levelName: t.level!.name,
          }))
          .toList();

        // Should still return results - nulls are handled by LEFT JOIN
        expect(result.length).toBeGreaterThan(0);
        // Verify the task without level is in the results with null/undefined levelName
        const taskWithoutLevel = result.find(r => r.title === 'Task Without Level');
        expect(taskWithoutLevel).toBeDefined();
        // LEFT JOIN returns null for non-matching rows
        expect(taskWithoutLevel?.levelName).toBeFalsy();
      });
    });

    test('should correctly join same table from different starting points', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Test that we can navigate to users from different tables
        // First: from orders
        const ordersWithUser = await db.orders
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            userName: o.user!.username,
            userEmail: o.user!.email,
          }))
          .toList();

        expect(ordersWithUser.length).toBeGreaterThan(0);
        ordersWithUser.forEach(r => {
          expect(r.userName).toBeDefined();
          expect(r.userEmail).toContain('@');
        });

        // Second: from posts to user
        const postsWithUser = await db.posts
          .where(p => gt(p.id, 0))
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            authorName: p.user!.username,
            authorEmail: p.user!.email,
          }))
          .toList();

        expect(postsWithUser.length).toBeGreaterThan(0);
        postsWithUser.forEach(r => {
          expect(r.authorName).toBeDefined();
          expect(r.authorEmail).toContain('@');
        });
      });
    });
  });
});
