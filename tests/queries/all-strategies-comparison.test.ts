import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { gt, eq, like } from '../../src/query/conditions';
import { assertType } from '../utils/type-tester';

/**
 * Comprehensive comparison tests for all three collection strategies:
 * - CTE (Common Table Expression with json_agg)
 * - Temp Table (temporary table with separate queries)
 * - Lateral (LEFT JOIN LATERAL subqueries)
 *
 * All strategies should produce identical results.
 */
describe('All Collection Strategies Comparison', () => {
  // Helper to run the same query with all strategies and compare results
  async function runWithAllStrategies<T>(
    queryFn: (db: any) => Promise<T[]>,
    compareFn?: (cte: T[], temp: T[], lateral: T[]) => void
  ): Promise<{ cte: T[]; temp: T[]; lateral: T[] }> {
    // CTE Strategy
    const cteDb = createTestDatabase({ collectionStrategy: 'cte' });
    await setupDatabase(cteDb);
    await seedTestData(cteDb);
    const cteResults = await queryFn(cteDb);
    await cleanupDatabase(cteDb);

    // Temp Table Strategy
    const tempDb = createTestDatabase({ collectionStrategy: 'temptable' });
    await setupDatabase(tempDb);
    await seedTestData(tempDb);
    const tempResults = await queryFn(tempDb);
    await cleanupDatabase(tempDb);

    // Lateral Strategy
    const lateralDb = createTestDatabase({ collectionStrategy: 'lateral' });
    await setupDatabase(lateralDb);
    await seedTestData(lateralDb);
    const lateralResults = await queryFn(lateralDb);
    await cleanupDatabase(lateralDb);

    if (compareFn) {
      compareFn(cteResults, tempResults, lateralResults);
    }

    return { cte: cteResults, temp: tempResults, lateral: lateralResults };
  }

  describe('Basic collection queries', () => {
    test('should return identical results for users with posts', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            posts: u.posts!.select((p: any) => ({
              postId: p.id,
              title: p.title,
              views: p.views,
            }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .toList('posts'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);
          expect(cte.length).toBe(3);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i].userId).toBe(temp[i].userId);
            expect(cte[i].userId).toBe(lateral[i].userId);
            expect(cte[i].username).toBe(temp[i].username);
            expect(cte[i].username).toBe(lateral[i].username);
            expect(cte[i].posts.length).toBe(temp[i].posts.length);
            expect(cte[i].posts.length).toBe(lateral[i].posts.length);

            for (let j = 0; j < cte[i].posts.length; j++) {
              expect(cte[i].posts[j]).toEqual(temp[i].posts[j]);
              expect(cte[i].posts[j]).toEqual(lateral[i].posts[j]);
            }
          }
        }
      );
    });

    test('should return identical results for filtered collections', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            highViewPosts: u.posts!
              .where((p: any) => gt(p.views!, 100))
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .toList('highViewPosts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i]).toEqual(temp[i]);
            expect(cte[i]).toEqual(lateral[i]);
          }
        }
      );
    });

    test('should return identical empty collections', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .where((u: any) => eq(u.username, 'charlie'))
          .select((u: any) => ({
            username: u.username,
            posts: u.posts!.select((p: any) => ({
              title: p.title,
            })).toList('posts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
          expect(cte[0].posts).toEqual([]);
        }
      );
    });
  });

  describe('Aggregations', () => {
    test('should return identical count results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            postCount: u.posts!.count(),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);

          // Verify specific counts
          const aliceCte = cte.find(u => u.username === 'alice');
          expect(aliceCte!.postCount).toBe(2);

          const charlieCte = cte.find(u => u.username === 'charlie');
          expect(charlieCte!.postCount).toBe(0);
        }
      );
    });

    test('should return identical filtered count results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            highViewCount: u.posts!.where((p: any) => gt(p.views!, 100)).count(),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });

    test('should return identical max results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            maxViews: u.posts!.max((p: any) => p.views!),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });

    test('should return identical min results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            minViews: u.posts!.min((p: any) => p.views!),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });

    test('should return identical sum results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            totalViews: u.posts!.sum((p: any) => p.views!),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });
  });

  describe('LIMIT and OFFSET (per-parent pagination)', () => {
    test('should return identical results with LIMIT on collections', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            topPosts: u.posts!
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .limit(1)
              .toList('topPosts'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          // All strategies should return same result
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i].userId).toBe(temp[i].userId);
            expect(cte[i].userId).toBe(lateral[i].userId);

            // Each user should have at most 1 post (LIMIT 1 PER PARENT)
            expect(cte[i].topPosts.length).toBeLessThanOrEqual(1);
            expect(temp[i].topPosts.length).toBeLessThanOrEqual(1);
            expect(lateral[i].topPosts.length).toBeLessThanOrEqual(1);

            // Results should be identical
            expect(cte[i].topPosts).toEqual(temp[i].topPosts);
            expect(cte[i].topPosts).toEqual(lateral[i].topPosts);
          }

          // Verify specific results:
          // Alice has 2 posts, should get 1 (the one with highest views)
          const aliceCte = cte.find(u => u.username === 'alice');
          expect(aliceCte!.topPosts.length).toBe(1);

          // Bob has 1 post, should get 1
          const bobCte = cte.find(u => u.username === 'bob');
          expect(bobCte!.topPosts.length).toBe(1);

          // Charlie has 0 posts, should get 0
          const charlieCte = cte.find(u => u.username === 'charlie');
          expect(charlieCte!.topPosts.length).toBe(0);
        }
      );
    });

    test('should return identical results with OFFSET on collections', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            skipFirstPost: u.posts!
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .offset(1)
              .toList('skipFirstPost'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i]).toEqual(temp[i]);
            expect(cte[i]).toEqual(lateral[i]);
          }

          // Verify specific results:
          // Alice has 2 posts, offset 1 should give 1 remaining post
          const aliceCte = cte.find(u => u.username === 'alice');
          expect(aliceCte!.skipFirstPost.length).toBe(1);

          // Bob has 1 post, offset 1 should give 0
          const bobCte = cte.find(u => u.username === 'bob');
          expect(bobCte!.skipFirstPost.length).toBe(0);

          // Charlie has 0 posts, offset 1 should still give 0
          const charlieCte = cte.find(u => u.username === 'charlie');
          expect(charlieCte!.skipFirstPost.length).toBe(0);
        }
      );
    });

    test('should return identical results with LIMIT and OFFSET combined', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            paginatedPosts: u.posts!
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .offset(1)
              .limit(1)
              .toList('paginatedPosts'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i]).toEqual(temp[i]);
            expect(cte[i]).toEqual(lateral[i]);
          }

          // Alice: 2 posts, offset 1 limit 1 = 1 post (second highest)
          const aliceCte = cte.find(u => u.username === 'alice');
          expect(aliceCte!.paginatedPosts.length).toBe(1);

          // Bob: 1 post, offset 1 limit 1 = 0 posts
          const bobCte = cte.find(u => u.username === 'bob');
          expect(bobCte!.paginatedPosts.length).toBe(0);

          // Charlie: 0 posts, offset 1 limit 1 = 0 posts
          const charlieCte = cte.find(u => u.username === 'charlie');
          expect(charlieCte!.paginatedPosts.length).toBe(0);
        }
      );
    });

    test('should return identical results with LIMIT and filter combined', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            topHighViewPosts: u.posts!
              .where((p: any) => gt(p.views!, 50))
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .limit(1)
              .toList('topHighViewPosts'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte.length).toBe(temp.length);
          expect(cte.length).toBe(lateral.length);

          for (let i = 0; i < cte.length; i++) {
            expect(cte[i]).toEqual(temp[i]);
            expect(cte[i]).toEqual(lateral[i]);

            // Each user should have at most 1 post after filter and limit
            expect(cte[i].topHighViewPosts.length).toBeLessThanOrEqual(1);
          }
        }
      );
    });

    test('LIMIT should be applied per-parent, not globally', async () => {
      // This test specifically verifies that LIMIT 1 returns 1 post PER USER, not 1 post total
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            topPost: u.posts!
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .limit(1)
              .toList('topPost'),
          }))
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          // Count total posts across all users
          const cteTotal = cte.reduce((sum, u) => sum + u.topPost.length, 0);
          const tempTotal = temp.reduce((sum, u) => sum + u.topPost.length, 0);
          const lateralTotal = lateral.reduce((sum, u) => sum + u.topPost.length, 0);

          // Should be > 1 because LIMIT is per-parent (Alice gets 1, Bob gets 1 = 2 total)
          // If it were global, we'd only get 1 total
          expect(cteTotal).toBeGreaterThan(1);
          expect(tempTotal).toBeGreaterThan(1);
          expect(lateralTotal).toBeGreaterThan(1);

          // All strategies should have the same total
          expect(cteTotal).toBe(tempTotal);
          expect(cteTotal).toBe(lateralTotal);
        }
      );
    });
  });

  describe('Array aggregations', () => {
    test('should return identical toStringList results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            postTitles: u.posts!.select((p: any) => p.title!).toStringList('postTitles'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          // Sort arrays for comparison since order may vary
          const sortArrays = (results: any[]) => {
            return results.map(r => ({
              ...r,
              postTitles: [...r.postTitles].sort(),
            }));
          };

          expect(sortArrays(cte)).toEqual(sortArrays(temp));
          expect(sortArrays(cte)).toEqual(sortArrays(lateral));
        }
      );
    });

    test('should return identical toNumberList results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            viewCounts: u.posts!.select((p: any) => p.views!).toNumberList('viewCounts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          // Sort arrays for comparison
          const sortArrays = (results: any[]) => {
            return results.map(r => ({
              ...r,
              viewCounts: [...r.viewCounts].sort((a: number, b: number) => a - b),
            }));
          };

          expect(sortArrays(cte)).toEqual(sortArrays(temp));
          expect(sortArrays(cte)).toEqual(sortArrays(lateral));
        }
      );
    });
  });

  describe('Multiple collections', () => {
    test('should return identical results with multiple collections', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            posts: u.posts!.select((p: any) => ({
              title: p.title,
            })).orderBy((p: any) => [[p.title, 'ASC']]).toList('posts'),
            orders: u.orders!.select((o: any) => ({
              status: o.status,
              totalAmount: o.totalAmount,
            })).orderBy((o: any) => [[o.status, 'ASC'], [o.totalAmount, 'ASC']]).toList('orders'),
          }))
          // Without an explicit order the strategies may return the users in different orders (was flaky)
          .orderBy((u: any) => [[u.userId, 'ASC']])
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });
  });

  describe('Complex WHERE conditions', () => {
    test('should return identical results with LIKE filter', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            alicePosts: u.posts!
              .where((p: any) => like(p.title!, 'Alice%'))
              .select((p: any) => ({
                title: p.title,
              }))
              .orderBy((p: any) => [[p.title, 'ASC']])
              .toList('alicePosts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });

    test('should return identical results with chained WHERE', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            filteredPosts: u.posts!
              .where((p: any) => gt(p.views!, 50))
              .where((p: any) => like(p.title!, '%Post%'))
              .select((p: any) => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .toList('filteredPosts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });
  });

  describe('DISTINCT collections', () => {
    test('should return identical selectDistinct results', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            distinctTitles: u.posts!.selectDistinct((p: any) => ({
              title: p.title,
            })).orderBy((p: any) => [[p.title, 'ASC']]).toList('distinctTitles'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);
        }
      );
    });
  });

  describe('Edge cases', () => {
    test('should handle users with no related records', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            username: u.username,
            postCount: u.posts!.count(),
            maxViews: u.posts!.max((p: any) => p.views!),
            posts: u.posts!.select((p: any) => ({ title: p.title })).orderBy((p: any) => [[p.title, 'ASC']]).toList('posts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);

          // Charlie should have 0 posts, null max
          const charlie = cte.find(u => u.username === 'charlie');
          expect(charlie!.postCount).toBe(0);
          expect(charlie!.maxViews).toBeNull();
          expect(charlie!.posts).toEqual([]);
        }
      );
    });

    test('should handle empty result set when all filtered out', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            username: u.username,
            impossiblePosts: u.posts!
              .where((p: any) => gt(p.views!, 1000000))
              .select((p: any) => ({ title: p.title }))
              .toList('impossiblePosts'),
          }))
          .toList(),
        (cte: any[], temp: any[], lateral: any[]) => {
          expect(cte).toEqual(temp);
          expect(cte).toEqual(lateral);

          // All users should have empty posts
          cte.forEach(u => {
            expect(u.impossiblePosts).toEqual([]);
          });
        }
      );
    });
  });
});
