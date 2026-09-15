import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';
import { assertType } from '../utils/type-tester';

describe('firstOrDefault()', () => {
  describe('Navigation Collections', () => {
    test('should return first item from collection with firstOrDefault()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithTopPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            topPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .firstOrDefault(),
          }))
          .toList();

        expect(usersWithTopPost.length).toBeGreaterThan(0);

        // Alice should have her highest viewed post
        const alice = usersWithTopPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.topPost).not.toBeNull();
        expect(alice!.topPost!.title).toBeDefined();
        expect(alice!.topPost!.views).toBe(150); // Alice Post 2 has 150 views

        // Verify it's a single object or null, not an array
        expect(Array.isArray(alice!.topPost)).toBe(false);
      });
    });

    test('should return null when collection is empty with firstOrDefault()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithFilteredPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            // Filter for posts with impossible view count
            impossiblePost: u.posts!
              .where(p => gt(p.views!, 999999))
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .firstOrDefault(),
          }))
          .toList();

        expect(usersWithFilteredPost.length).toBeGreaterThan(0);

        // All users should have null for impossiblePost
        usersWithFilteredPost.forEach(u => {
          expect(u.impossiblePost).toBeNull();
        });
      });
    });

    test('should return null for users without any posts', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithFirstPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            firstPost: u.posts!
              .select(p => ({
                title: p.title,
              }))
              .firstOrDefault(),
          }))
          .toList();

        // Charlie has no posts, so his firstPost should be null
        const charlie = usersWithFirstPost.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.firstPost).toBeNull();

        // Alice has posts, so she should have a firstPost
        const alice = usersWithFirstPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.firstPost).not.toBeNull();
      });
    });

    test('should work with where clause before firstOrDefault()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithHighViewPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            highViewPost: u.posts!
              .where(p => gt(p.views!, 100))
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .firstOrDefault(),
          }))
          .toList();

        const alice = usersWithHighViewPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        // Alice's highest viewed post > 100 is "Alice Post 2" with 150 views
        expect(alice!.highViewPost).not.toBeNull();
        expect(alice!.highViewPost!.views).toBe(150);
      });
    });

    test('should work with firstOrDefault() on full entity (no select)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithLatestPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            latestPost: u.posts!
              .orderBy(p => [[p.id, 'DESC']])
              .firstOrDefault(),
          }))
          .toList();

        const alice = usersWithLatestPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.latestPost).not.toBeNull();
        expect(alice!.latestPost!.title).toBeDefined();
        expect(alice!.latestPost!.userId).toBe(alice!.userId);
      });
    });
  });

  describe('GroupBy Queries', () => {
    test('should use firstOrDefault() on grouped query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .orderBy(g => [[g.userId, 'DESC']])
          .firstOrDefault();

        // Should return a single result or null, not an array
        expect(result).not.toBeNull();
        if (result !== null) {
          expect(typeof result.userId).toBe('number');
          expect(typeof result.postCount).toBe('number');
          assertType<{ userId: number; postCount: number }, typeof result>(result);
        }
      });
    });

    test('should return null from grouped query when no results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .where(p => gt(p.views!, 999999)) // No posts with this many views
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .firstOrDefault();

        expect(result).toBeNull();
      });
    });

    test('should use firstOrDefault() with aggregates', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
            totalViews: g.sum(p => p.views),
          }))
          .firstOrDefault();

        expect(result).not.toBeNull();
        expect(typeof result!.postCount).toBe('number');
        expect(typeof result!.totalViews).toBe('number');
      });
    });
  });

  describe('Custom Mappers with firstOrDefault()', () => {
    test('should apply custom mapper (pgHourMinute) on firstOrDefault result', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithTopPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            topPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({
                title: p.title,
                views: p.views,
                publishTime: p.publishTime,  // Custom mapper: pgHourMinute
              }))
              .firstOrDefault(),
          }))
          .toList();

        // Alice's top post (150 views) has publishTime: { hour: 14, minute: 0 }
        const alice = usersWithTopPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.topPost).not.toBeNull();
        expect(alice!.topPost!.publishTime).toBeDefined();
        // Verify the mapper converted the integer to HourMinute object
        expect(alice!.topPost!.publishTime).toEqual({ hour: 14, minute: 0 });

        // Bob's post has publishTime: { hour: 18, minute: 45 }
        const bob = usersWithTopPost.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.topPost).not.toBeNull();
        expect(bob!.topPost!.publishTime).toEqual({ hour: 18, minute: 45 });
      });
    });

    test('should apply custom mapper (pgIntDatetime) on firstOrDefault result', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithTopPost = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            topPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({
                title: p.title,
                views: p.views,  // Include views since we're ordering by it
                customDate: p.customDate,  // Custom mapper: pgIntDatetime
              }))
              .firstOrDefault(),
          }))
          .toList();

        // Alice's top post (150 views) has customDate: new Date('2024-01-16T10:00:00Z')
        const alice = usersWithTopPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.topPost).not.toBeNull();
        expect(alice!.topPost!.customDate).toBeDefined();
        // Verify the mapper converted the integer to Date object
        expect(alice!.topPost!.customDate).toBeInstanceOf(Date);
        expect(alice!.topPost!.customDate!.toISOString()).toBe('2024-01-16T10:00:00.000Z');
      });
    });

    test('should apply custom mappers with LATERAL strategy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithTopPost = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .select(u => ({
            userId: u.id,
            username: u.username,
            topPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({
                title: p.title,
                publishTime: p.publishTime,
                customDate: p.customDate,
              }))
              .firstOrDefault(),
          }))
          .toList();

        const alice = usersWithTopPost.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.topPost).not.toBeNull();
        // Verify both mappers work with LATERAL
        expect(alice!.topPost!.publishTime).toEqual({ hour: 14, minute: 0 });
        expect(alice!.topPost!.customDate).toBeInstanceOf(Date);
      });
    });

    test('should apply custom mappers in nested collections with firstOrDefault', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Nested collection: orders -> orderTasks -> task -> level -> createdBy -> posts
        const result = await db.orders
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            orderItems: o.orderTasks!.select(ot => ({
              taskId: ot.taskId,
              // Deep navigation with firstOrDefault and custom mapper
              firstPost: ot.task!.level!.createdBy!.posts!
                .orderBy(p => [[p.views, 'DESC']])
                .select(p => ({
                  title: p.title,
                  views: p.views,  // Include views since we're ordering by it
                  publishTime: p.publishTime,  // Custom mapper
                }))
                .firstOrDefault(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Find an order with tasks that have posts
        let foundPostWithMapper = false;
        for (const order of result) {
          for (const item of order.orderItems) {
            if (item.firstPost !== null) {
              foundPostWithMapper = true;
              // Verify custom mapper was applied
              expect(item.firstPost.publishTime).toBeDefined();
              expect(typeof item.firstPost.publishTime.hour).toBe('number');
              expect(typeof item.firstPost.publishTime.minute).toBe('number');
            }
          }
        }
        // Make sure we actually tested at least one post
        expect(foundPostWithMapper).toBe(true);
      });
    });

    test('should handle null values with custom mappers in firstOrDefault', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Charlie has no posts, so firstPost should be null
        const users = await db.users
          .where(u => eq(u.username, 'charlie'))
          .select(u => ({
            userId: u.id,
            username: u.username,
            firstPost: u.posts!
              .select(p => ({
                title: p.title,
                publishTime: p.publishTime,
              }))
              .firstOrDefault(),
          }))
          .toList();

        expect(users.length).toBe(1);
        const charlie = users[0];
        expect(charlie.firstPost).toBeNull();
      });
    });
  });

  describe('Nested Collections with Mappers', () => {
    test('should apply mappers in regular nested collections (toList)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            userId: u.id,
            username: u.username,
            posts: u.posts!
              .orderBy(p => p.id)
              .select(p => ({
                title: p.title,
                publishTime: p.publishTime,
                customDate: p.customDate,
              }))
              .toList(),
          }))
          .toList();

        expect(users.length).toBe(1);
        const alice = users[0];
        expect(alice.posts.length).toBe(2);

        // First post: publishTime: { hour: 9, minute: 30 }
        expect(alice.posts[0].publishTime).toEqual({ hour: 9, minute: 30 });
        expect(alice.posts[0].customDate).toBeInstanceOf(Date);

        // Second post: publishTime: { hour: 14, minute: 0 }
        expect(alice.posts[1].publishTime).toEqual({ hour: 14, minute: 0 });
        expect(alice.posts[1].customDate).toBeInstanceOf(Date);
      });
    });

    test('should apply mappers in deeply nested collections', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // orders -> orderTasks -> task -> level -> createdBy -> posts
        const result = await db.orders
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .where(o => gt(o.id, 0))
          .select(o => ({
            orderId: o.id,
            tasks: o.orderTasks!.select(ot => ({
              taskId: ot.taskId,
              creatorPosts: ot.task!.level!.createdBy!.posts!
                .select(p => ({
                  title: p.title,
                  publishTime: p.publishTime,
                }))
                .toList(),
            })).toList(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Verify mappers work in deeply nested collections
        for (const order of result) {
          for (const task of order.tasks) {
            for (const post of task.creatorPosts) {
              expect(post.publishTime).toBeDefined();
              expect(typeof post.publishTime.hour).toBe('number');
              expect(typeof post.publishTime.minute).toBe('number');
            }
          }
        }
      });
    });
  });

  describe('Regular Queries (existing behavior)', () => {
    test('should work on regular entity query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'alice'))
          .firstOrDefault();

        expect(user).not.toBeNull();
        expect(user!.username).toBe('alice');
      });
    });

    test('should return null when no match found', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .firstOrDefault();

        expect(user).toBeNull();
      });
    });
  });
});
