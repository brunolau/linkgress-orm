import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';

/**
 * Defect-proving tests for collection-navigation projections inside UNION ALL legs.
 *
 * BEFORE the Phase C fix:
 *   `buildQueryCore` explicitly skips collection fields (see line 4746 in the
 *   unmodified linkgress-orm/src/query/query-builder.ts):
 *
 *     ```ts
 *     if (value instanceof CollectionQueryBuilder || ...) {
 *       // Collection fields are not supported in UNION queries for simplicity
 *       // Skip them - they would need complex handling
 *       continue;
 *     }
 *     ```
 *
 *   When a UNION leg projects `posts: u.posts.toList('posts')`, the column is
 *   silently dropped from the emitted SQL — the resulting rows do NOT have a
 *   `posts` field. Worse, since the dropped column doesn't appear, the column
 *   count across legs MAY accidentally match (no Postgres error) but the
 *   business logic gets garbage. Sometimes ALSO produces a column-count
 *   mismatch when only one leg has the collection.
 *
 * AFTER the Phase C fix:
 *   `buildQueryCore` invokes the collection strategy (default LATERAL) to
 *   emit a per-row correlated subquery (`LEFT JOIN LATERAL (...) ON true`)
 *   inside each UNION leg. The `selectExpression` (e.g.
 *   `COALESCE("lateral_0".data, '[]'::json) as "posts"`) is added to
 *   selectParts; the `joinClause` is appended to the leg's FROM clause. Both
 *   legs project the same `jsonb` (or `json`) column at the same position so
 *   the UNION ALL is valid.
 *
 *   The collection's row-level result mapping (json_agg → JS array) is
 *   handled by the existing `transformResults` path, which `UnionQueryBuilder.toList`
 *   now invokes when collection fields are present.
 */
describe('UNION ALL — collection-navigation projections (defect-proving)', () => {
  test('UNION ALL where each leg projects p.posts.toList(...) returns populated arrays', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Seed users: alice (2 posts), bob (1 post), charlie (0 posts).
      //   active = {alice, bob}, age>30 = {bob, charlie}, UNION ALL → 4 rows.
      //
      // FAILURE MODE BEFORE FIX: `posts` is missing from every row, OR the SQL
      // throws a column-count mismatch error.
      const left = db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({
          id: u.id,
          name: u.username,
          posts: u.posts!
            .select(p => ({
              postId: p.id,
              title: p.title,
            }))
            .toList('posts'),
        }));

      const right = db.users
        .where(u => gt(u.age, 30))
        .select(u => ({
          id: u.id,
          name: u.username,
          posts: u.posts!
            .select(p => ({
              postId: p.id,
              title: p.title,
            }))
            .toList('posts'),
        }));

      const rows = await left.unionAll(right).toList();
      expect(rows.length).toBe(4);

      // Group by user id to verify each user has the correct post count.
      const byUser = new Map<number, number[]>();
      for (const row of rows) {
        expect(row).toHaveProperty('posts');
        expect(Array.isArray(row.posts)).toBe(true);
        const prev = byUser.get(row.id) ?? [];
        prev.push(row.posts.length);
        byUser.set(row.id, prev);
      }

      // The same id can appear twice (UNION ALL keeps duplicates) — every row's
      // `posts` array MUST be populated with the correct user's posts.
      for (const [, postCounts] of byUser) {
        // Every occurrence of the same user must report the SAME post count
        // (the collection correlates per-row, not per-leg).
        const distinct = new Set(postCounts);
        expect(distinct.size).toBe(1);
      }

      // Alice and bob should each have at least one row with non-empty posts.
      const aliceRows = rows.filter(r => r.name === 'alice');
      expect(aliceRows.length).toBeGreaterThan(0);
      for (const row of aliceRows) {
        expect(row.posts.length).toBe(2);
        for (const post of row.posts) {
          expect(typeof post.postId).toBe('number');
          expect(typeof post.title).toBe('string');
        }
      }

      const bobRows = rows.filter(r => r.name === 'bob');
      expect(bobRows.length).toBeGreaterThan(0);
      for (const row of bobRows) {
        expect(row.posts.length).toBe(1);
      }

      const charlieRows = rows.filter(r => r.name === 'charlie');
      expect(charlieRows.length).toBeGreaterThan(0);
      for (const row of charlieRows) {
        expect(row.posts.length).toBe(0);
      }
    });
  });

  test('UNION ALL with collection projection on BOTH legs handles empty collections', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Restrict each leg to just charlie (0 posts) to prove that empty
      // collections come back as [] (not null, not undefined).
      const left = db.users
        .where(u => eq(u.username, 'charlie'))
        .select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));

      const right = db.users
        .where(u => eq(u.isActive, false))
        .select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));

      const rows = await left.unionAll(right).toList();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Array.isArray(row.posts)).toBe(true);
        expect(row.posts.length).toBe(0);
      }
    });
  });
});
