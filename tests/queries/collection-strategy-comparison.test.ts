import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { gt, and, eq } from '../../src/query/conditions';

describe('Collection Strategy Comparison', () => {
  describe('Basic collection queries', () => {
    test('should return identical results for users with posts (JSONB vs Temp Table)', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            postId: p.id,
            title: p.title,
            views: p.views,
          }))
            .orderBy(p => [[p.views, 'DESC']])
            .toList('posts'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            postId: p.id,
            title: p.title,
            views: p.views,
          }))
            .orderBy(p => [[p.views, 'DESC']])
            .toList('posts'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults.length).toBe(tempTableResults.length);
      expect(jsonbResults.length).toBeGreaterThan(0);

      for (let i = 0; i < jsonbResults.length; i++) {
        const jsonbUser = jsonbResults[i];
        const tempTableUser = tempTableResults[i];

        expect(jsonbUser.userId).toBe(tempTableUser.userId);
        expect(jsonbUser.username).toBe(tempTableUser.username);
        expect(jsonbUser.posts.length).toBe(tempTableUser.posts.length);

        for (let j = 0; j < jsonbUser.posts.length; j++) {
          expect(jsonbUser.posts[j]).toEqual(tempTableUser.posts[j]);
        }
      }
    });

    test('should return identical results for filtered collections', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          highViewPosts: u.posts!
            .where(p => gt(p.views!, 100))
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('highViewPosts'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          highViewPosts: u.posts!
            .where(p => gt(p.views!, 100))
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('highViewPosts'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });

  describe('Collection aggregations', () => {
    test('should return identical count results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          postCount: u.posts!.count(),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          postCount: u.posts!.count(),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });

    test('should return identical max/min results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          maxViews: u.posts!.max(p => p.views!),
          minViews: u.posts!.min(p => p.views!),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          maxViews: u.posts!.max(p => p.views!),
          minViews: u.posts!.min(p => p.views!),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });

    test('should return identical sum results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          totalViews: u.posts!.sum(p => p.views!),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          totalViews: u.posts!.sum(p => p.views!),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });

  describe('Collection with limit/offset', () => {
    test('should return identical results with limit', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          topPost: u.posts!
            .orderBy(p => [[p.views, 'DESC']])
            .limit(1)
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('topPost'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          topPost: u.posts!
            .orderBy(p => [[p.views, 'DESC']])
            .limit(1)
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('topPost'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });

    test('should return identical results with offset', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          secondPost: u.posts!
            .orderBy(p => [[p.views, 'DESC']])
            .offset(1)
            .limit(1)
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('secondPost'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          secondPost: u.posts!
            .orderBy(p => [[p.views, 'DESC']])
            .offset(1)
            .limit(1)
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList('secondPost'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });

  describe('Array aggregations', () => {
    test('should return identical toStringList results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          postTitles: u.posts!.select(p => p.title!).toStringList('postTitles'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          postTitles: u.posts!.select(p => p.title!).toStringList('postTitles'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Sort arrays to ensure consistent ordering for comparison
      jsonbResults.forEach(u => u.postTitles.sort());
      tempTableResults.forEach(u => u.postTitles.sort());

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });

    test('should return identical toNumberList results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          allViews: u.posts!.select(p => p.views!).toNumberList('allViews'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          allViews: u.posts!.select(p => p.views!).toNumberList('allViews'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Sort arrays to ensure consistent ordering for comparison
      jsonbResults.forEach(u => u.allViews.sort((a, b) => a - b));
      tempTableResults.forEach(u => u.allViews.sort((a, b) => a - b));

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });

  describe('Multiple collections', () => {
    test('should return identical results with multiple collections', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            title: p.title,
          })).toList('posts'),
          orders: u.orders!.select(o => ({
            status: o.status,
            totalAmount: o.totalAmount,
          })).toList('orders'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            title: p.title,
          })).toList('posts'),
          orders: u.orders!.select(o => ({
            status: o.status,
            totalAmount: o.totalAmount,
          })).toList('orders'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Sort arrays to ensure consistent ordering for comparison
      jsonbResults.forEach(u => {
        u.posts.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        u.orders.sort((a, b) => a.totalAmount - b.totalAmount);
      });
      tempTableResults.forEach(u => {
        u.posts.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        u.orders.sort((a, b) => a.totalAmount - b.totalAmount);
      });

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });

  describe('Empty collections', () => {
    test('should return identical results for users with no posts', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            title: p.title,
          })).orderBy(p => [[p.title, 'ASC']]).toList('posts'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          posts: u.posts!.select(p => ({
            title: p.title,
          })).orderBy(p => [[p.title, 'ASC']]).toList('posts'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);

      // Charlie (user 3) should have no posts
      const charlie = jsonbResults.find(u => u.username === 'charlie');
      expect(charlie).toBeDefined();
      expect(charlie!.posts).toEqual([]);
    });
  });

  describe('DISTINCT collections', () => {
    test('should return identical selectDistinct results', async () => {
      // Test with JSONB strategy
      const jsonbDb = createTestDatabase({ collectionStrategy: 'jsonb' });
      await setupDatabase(jsonbDb);
      await seedTestData(jsonbDb);

      const jsonbResults = await jsonbDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          distinctTitles: u.posts!.selectDistinct(p => ({
            title: p.title,
          })).orderBy(p => [[p.title, 'ASC']]).toList('distinctTitles'),
        }))
        .toList();

      await cleanupDatabase(jsonbDb);

      // Test with Temp Table strategy
      const tempTableDb = createTestDatabase({ collectionStrategy: 'temptable' });
      await setupDatabase(tempTableDb);
      await seedTestData(tempTableDb);

      const tempTableResults = await tempTableDb.users
        .select(u => ({
          userId: u.id,
          username: u.username,
          distinctTitles: u.posts!.selectDistinct(p => ({
            title: p.title,
          })).orderBy(p => [[p.title, 'ASC']]).toList('distinctTitles'),
        }))
        .toList();

      await cleanupDatabase(tempTableDb);

      // Verify results are identical
      expect(jsonbResults).toEqual(tempTableResults);
    });
  });
});
