import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';

describe('ORDER BY Column Name Mapping', () => {
  describe('Basic queries with mapped column names', () => {
    test('should order by column with different property name (isActive -> is_active)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // isActive property maps to is_active column
        const users = await db.users
          .orderBy(u => u.isActive)
          .toList();

        expect(users).toHaveLength(3);
        // Should not throw "column users.isActive does not exist"
        // isActive=false should come before isActive=true (ASC order)
        expect(users[0].isActive).toBe(false);
      });
    });

    test('should order by column with different property name DESC (isActive -> is_active)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .orderBy(u => [[u.isActive, 'DESC']])
          .toList();

        expect(users).toHaveLength(3);
        // isActive=true should come first in DESC order
        expect(users[0].isActive).toBe(true);
      });
    });

    test('should order by userId which maps to user_id', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const posts = await db.posts
          .orderBy(p => p.userId)
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        // Should not throw "column posts.userId does not exist"
        // Verify ordering is correct (ascending by user_id)
        for (let i = 1; i < posts.length; i++) {
          expect(posts[i].userId).toBeGreaterThanOrEqual(posts[i - 1].userId);
        }
      });
    });

    test('should order by multiple columns with different property names', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const posts = await db.posts
          .orderBy(p => [[p.userId, 'ASC'], [p.views, 'DESC']])
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        // Should not throw any errors about column names
      });
    });
  });

  describe('Collection queries with mapped column names', () => {
    test('should order collection by sortOrder which maps to sort_order', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);
        const orders = await db.orders
          .select(o => ({
            id: o.id,
            orderTasks: o.orderTasks!
              .orderBy(ot => ot.sortOrder)
              .select(ot => ({
                taskId: ot.taskId,
                sortOrder: ot.sortOrder,
              }))
              .toList(),
          }))
          .toList();

        expect(orders.length).toBeGreaterThan(0);
        // Should not throw "column order_task.sortOrder does not exist"
      });
    });

    test('should order collection by sortOrder DESC', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const orders = await db.orders
          .select(o => ({
            id: o.id,
            orderTasks: o.orderTasks!
              .orderBy(ot => [[ot.sortOrder, 'DESC']])
              .select(ot => ({
                taskId: ot.taskId,
                sortOrder: ot.sortOrder,
              }))
              .toList(),
          }))
          .toList();

        expect(orders.length).toBeGreaterThan(0);
      });
    });

    test('should order posts collection by views', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .select(u => ({
            id: u.id,
            username: u.username,
            posts: u.posts!
              .orderBy(p => p.views)
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList(),
          }))
          .toList();

        expect(users.length).toBeGreaterThan(0);
        // For users with posts, verify ordering
        const usersWithPosts = users.filter(u => u.posts.length > 1);
        for (const user of usersWithPosts) {
          for (let i = 1; i < user.posts.length; i++) {
            expect(user.posts[i].views).toBeGreaterThanOrEqual(user.posts[i - 1].views!);
          }
        }
      });
    });
  });

  describe('Select with orderBy on mapped columns', () => {
    test('should order by totalAmount which maps to total_amount', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const orders = await db.orders
          .orderBy(o => [[o.totalAmount, 'DESC']])
          .select(o => ({
            id: o.id,
            total: o.totalAmount,
          }))
          .toList();

        expect(orders.length).toBeGreaterThan(0);
        // Verify descending order
        for (let i = 1; i < orders.length; i++) {
          expect(Number(orders[i].total)).toBeLessThanOrEqual(Number(orders[i - 1].total));
        }
      });
    });

    test('should order by createdById which maps to created_by_id', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const levels = await db.taskLevels
          .orderBy(l => l.createdById)
          .toList();

        expect(levels.length).toBeGreaterThan(0);
        // Should not throw "column task_levels.createdById does not exist"
      });
    });
  });
});
