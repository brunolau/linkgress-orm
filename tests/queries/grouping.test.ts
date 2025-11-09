import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';

describe('Grouping and Aggregation', () => {
  describe('Basic GROUP BY', () => {
    test('should group by single field with count', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            title: p.title,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify types are numbers
        result.forEach(r => {
          expect(typeof r.postCount).toBe('number');
          expect(r.postCount).toBeGreaterThan(0);
        });

        // Alice should have 2 posts
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.postCount).toBe(2);
      });
    });

    test('should group with sum aggregate', async () => {
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
            totalViews: g.sum(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify result types
        result.forEach(r => {
          expect(typeof r.totalViews).toBe('number');
          expect(r.totalViews).toBeGreaterThan(0);
        });

        // Alice should have 250 total views (100 + 150)
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.totalViews).toBe(250);
      });
    });

    test('should group with min and max aggregates', async () => {
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
            minViews: g.min(p => p.views),
            maxViews: g.max(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.minViews).toBe(100);
        expect(aliceStats?.maxViews).toBe(150);
      });
    });

    test('should group with avg aggregate', async () => {
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
            avgViews: g.avg(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify result type is number
        result.forEach(r => {
          expect(typeof r.avgViews).toBe('number');
        });

        // Alice's avg should be 125 (100 + 150) / 2
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.avgViews).toBe(125);
      });
    });

    test('should group with multiple aggregates', async () => {
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
            count: g.count(),
            totalViews: g.sum(p => p.views),
            avgViews: g.avg(p => p.views),
            minViews: g.min(p => p.views),
            maxViews: g.max(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats).toBeDefined();
        expect(aliceStats?.count).toBe(2);
        expect(aliceStats?.totalViews).toBe(250);
        expect(aliceStats?.avgViews).toBe(125);
        expect(aliceStats?.minViews).toBe(100);
        expect(aliceStats?.maxViews).toBe(150);
      });
    });
  });

  describe('GROUP BY with multiple keys', () => {
    test('should group by multiple fields', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create more posts with varying data
        await db.posts.insert({ title: 'Tech', content: 'Content', userId: users.alice.id, views: 50 });
        await db.posts.insert({ title: 'Tech', content: 'Content', userId: users.bob.id, views: 75 });

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            title: p.title,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
            title: p.title,
          }))
          .select(g => ({
            userId: g.key.userId,
            title: g.key.title,
            totalViews: g.sum(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(3);

        // Each combination of userId + title should be unique
        const uniqueKeys = new Set(result.map(r => `${r.userId}-${r.title}`));
        expect(uniqueKeys.size).toBe(result.length);
      });
    });
  });

  describe('HAVING clause', () => {
    test('should filter groups with HAVING', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .having(g => gt(g.count() as any, 1))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        // Only users with more than 1 post
        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.postCount).toBeGreaterThan(1);
        });
      });
    });

    test('should combine WHERE and HAVING', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .where(p => gt(p.views, 50))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .having(g => gt(g.count() as any, 1))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        // WHERE filters before grouping, HAVING filters after
        result.forEach(r => {
          expect(r.postCount).toBeGreaterThan(1);
        });
      });
    });
  });

  describe('Grouped queries as subqueries', () => {
    test('should use grouped query as table subquery in JOIN', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const statsSubquery = db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
            postCount: g.count(),
          }))
          .asSubquery('table');

        const result = await db.users
          .innerJoin(
            statsSubquery,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              username: user.username,
              totalViews: stats.totalViews,
              postCount: stats.postCount,
            }),
            'stats'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify aggregates are numbers
        result.forEach(r => {
          expect(typeof r.totalViews).toBe('number');
          expect(typeof r.postCount).toBe('number');
        });

        const aliceStats = result.find(r => r.username === 'alice');
        expect(aliceStats?.totalViews).toBe(250);
        expect(aliceStats?.postCount).toBe(2);
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle empty groups', async () => {
      await withDatabase(async (db) => {
        // Create DB but no data

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            count: g.count(),
          }))
          .toList();

        expect(result).toHaveLength(0);
      });
    });

    test('should handle NULL values in grouping', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create posts with no subtitle (NULL)
        await db.posts.insert({ title: 'Post 1', content: 'C', userId: users.alice.id, views: 10 });
        await db.posts.insert({ title: 'Post 2', content: 'C', userId: users.alice.id, views: 20 });

        const result = await db.posts
          .select(p => ({
            subtitle: p.subtitle,
            views: p.views,
          }))
          .groupBy(p => ({
            subtitle: p.subtitle,
          }))
          .select(g => ({
            subtitle: g.key.subtitle,
            count: g.count(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Should have a group for NULL subtitles
        const nullGroup = result.find(r => r.subtitle === null || r.subtitle === undefined);
        expect(nullGroup).toBeDefined();
      });
    });
  });
});
