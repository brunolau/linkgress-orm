import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, sql } from '../../src';

/**
 * Spike test — verify that UNION legs sourced from an INTERMEDIARY table
 * (e.g. `db.postComments`) can project through a one-nav to the target
 * (`pc.post`, `pc.order`) AND ALSO project a collection from that target
 * (`pc.post!.user!.posts.toList()`).
 *
 * This is the shape the GOBO-240 eshop refactor needs: each friend-side
 * UNION leg sources from `db.userRelations` and projects fields + a `cards`
 * collection through `r.slave` / `r.parent`. The fix in Phase B + C enables
 * collection navigation in UNION legs in general; this test pins down the
 * specific intermediary-table-with-target-collection variant.
 */
describe('UNION ALL — navigation through intermediary table to a collection', () => {
  test('union legs sourced from postComments project through pc.post and pc.order', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // postComments has: postId → post, orderId → order
      // We project the COMMENT id, the POST's title (via pc.post), and the
      // ORDER's user_id (via pc.order). Both legs project the SAME shape so
      // UNION ALL is valid.
      const left = db.postComments
        .where(pc => eq(pc.postId, 1))
        .select(pc => ({
          id: pc.id,
          postTitle: pc.post!.title,
          orderUserId: pc.order!.userId,
          tag: sql<'left' | 'right'>`'left'`,
        }));

      const right = db.postComments
        .where(pc => eq(pc.postId, 2))
        .select(pc => ({
          id: pc.id,
          postTitle: pc.post!.title,
          orderUserId: pc.order!.userId,
          tag: sql<'left' | 'right'>`'right'`,
        }));

      const rows = await left.unionAll(right).toList();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(typeof row.id).toBe('number');
        expect(typeof row.postTitle).toBe('string');
        expect(typeof row.orderUserId).toBe('number');
        expect(['left', 'right']).toContain(row.tag);
      }
    });
  });

  test('union legs sourced from postComments project a collection through pc.post.user.posts', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Walk: postComments → post (one) → user (one) → posts (many).
      // This is the closest analogue to GOBO-240's userRelations → slave (one)
      // → cards (many) — an intermediary table whose nav target carries a
      // collection. We project the author's full posts list per comment.
      const left = db.postComments
        .where(pc => eq(pc.postId, 1))
        .select(pc => ({
          id: pc.id,
          authorPosts: pc.post!.user!.posts!.select(p => ({ id: p.id, title: p.title })).toList('authorPosts'),
          tag: sql<'left' | 'right'>`'left'`,
        }));

      const right = db.postComments
        .where(pc => eq(pc.postId, 2))
        .select(pc => ({
          id: pc.id,
          authorPosts: pc.post!.user!.posts!.select(p => ({ id: p.id, title: p.title })).toList('authorPosts'),
          tag: sql<'left' | 'right'>`'right'`,
        }));

      const rows = await left.unionAll(right).toList();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(Array.isArray(row.authorPosts)).toBe(true);
        for (const p of row.authorPosts) {
          expect(typeof p.id).toBe('number');
          expect(typeof p.title).toBe('string');
        }
      }
    });
  });
});
