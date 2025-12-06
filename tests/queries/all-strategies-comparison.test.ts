import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { gt, eq, like } from '../../src/query/conditions';
import { assertType } from '../utils/type-tester';

/**
 * Comprehensive comparison tests for all three collection strategies:
 * - CTE (Common Table Expression with jsonb_agg)
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

  // Note: Limit and Offset tests moved to lateral-strategy.test.ts
  // CTE and temp table strategies have different behavior for LIMIT/OFFSET
  // (they apply globally instead of per-parent, which is a known limitation)
  // LATERAL strategy correctly applies LIMIT/OFFSET per parent row

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
            })).toList('orders'),
          }))
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
