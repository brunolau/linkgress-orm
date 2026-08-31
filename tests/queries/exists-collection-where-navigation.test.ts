import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, exists, not, notExists, or, sql } from '../../src';

/**
 * exists()/notExists() over a collection whose `.where()` navigates a REFERENCE
 * of the collection target (e.g. `pc.order.status`) must emit the JOIN that
 * navigation requires inside the EXISTS subquery.
 *
 * Before the fix, subquery JOINs were derived from selectors only — a
 * reference-navigating `.where()` under `exists()` (which has no selector)
 * rendered a column of an unjoined alias and the statement failed with
 * `missing FROM-clause entry for table "order"`.
 *
 * Shape mirror of a campaign-publication condition:
 * discount → campaign_links (collection) → campaign (reference) → `is_public`,
 * here spelled post → post_comments (collection) → order (reference) → `status`.
 *
 * Seeded truth table: alicePost1's comment references aliceOrder
 * (status 'completed'); alicePost2's and bobPost's comments reference bobOrder
 * (status 'pending').
 */
describe('exists() collection with reference-navigating where', () => {
  test('exists(collection.where(ref.column)) in WHERE filters by the joined column', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      const rows = await db.posts
        .where(p => exists(p.postComments!.where(pc => eq(pc.order!.status, 'completed'))))
        .select(p => ({ id: p.id }))
        .toList();

      expect(rows.map(r => r.id)).toEqual([seed.posts.alicePost1.id]);
    });
  });

  test('or(notExists(collection), exists(collection.where(ref.column))) — the publication-gate shape', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);
      const [lonely] = await db.posts.insertBulk([
        { title: 'No comments', content: 'no comments here', userId: seed.users.alice.id, views: 0 },
      ]).returning();

      const rows = await db.posts
        .where(p => or(
          notExists(p.postComments!),
          exists(p.postComments!.where(pc => eq(pc.order!.status, 'completed'))),
        ))
        .select(p => ({ id: p.id }))
        .toList();

      const ids = rows.map(r => r.id).sort((a, b) => a - b);
      const expected = [seed.posts.alicePost1.id, lonely.id].sort((a, b) => a - b);
      expect(ids).toEqual(expected);
    });
  });

  test('projected verdict: sql`${not(or(notExists(...), exists(...where(ref))))}` per row', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      const rows = await db.posts
        .select(p => ({
          id: p.id,
          gateBlocked: sql<boolean>`${not(or(
            notExists(p.postComments!),
            exists(p.postComments!.where(pc => eq(pc.order!.status, 'completed'))),
          ))}`,
        }))
        .toList();

      const byId = new Map(rows.map(r => [r.id, r.gateBlocked]));
      expect(byId.get(seed.posts.alicePost1.id)).toBe(false);
      expect(byId.get(seed.posts.alicePost2.id)).toBe(true);
      expect(byId.get(seed.posts.bobPost.id)).toBe(true);
    });
  });

  test('reference-rooted collection source with a ref-navigating where', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      // post_comments → order (reference) → order_task (collection) → task (reference) → status
      const rows = await db.postComments
        .where(pc => exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending'))))
        .select(pc => ({ id: pc.id }))
        .toList();

      // aliceOrder carries task1 ('pending'); bobOrder carries task2 ('processing').
      expect(rows.map(r => r.id)).toEqual([seed.postComments.alicePostComment1.id]);
    });
  });

  test('lateral projection: exists over a reference chain anchors on the lateral alias', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      // Mirrors a cart-load shape: a LATERAL collection over
      // post_comments (aliased `lateral_N_postComments` by the strategy) whose
      // selection projects an EXISTS over a reference chain rooted on the
      // lateral's own row (`pc.order.orderTasks`). Before the fix the bridge
      // join anchored on the raw table name and failed with
      // `invalid reference to FROM-clause entry for table "post_comments"`.
      const rows = await db.posts
        .select(p => ({
          id: p.id,
          comments: p.postComments!
            .select(pc => ({
              id: pc.id,
              hasPendingTask: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending')))}`,
            }))
            .toList('comments'),
        }))
        .toList();

      const verdictByCommentId = new Map<number, boolean>();
      for (const row of rows) {
        for (const comment of (row.comments ?? []) as { id: number; hasPendingTask: boolean }[]) {
          verdictByCommentId.set(comment.id, comment.hasPendingTask);
        }
      }
      expect(verdictByCommentId.get(seed.postComments.alicePostComment1.id)).toBe(true);
      expect(verdictByCommentId.get(seed.postComments.alicePostComment2.id)).toBe(false);
      expect(verdictByCommentId.get(seed.postComments.bobPostComment.id)).toBe(false);
    }, { collectionStrategy: 'lateral' });
  });

  test('chained builder keeps the where-navigation join', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      let query = db.posts.where(p => eq(p.userId, seed.users.alice.id));
      query = query.where(p => exists(p.postComments!.where(pc => eq(pc.order!.status, 'completed'))));

      const rows = await query.select(p => ({ id: p.id })).toList();

      expect(rows.map(r => r.id)).toEqual([seed.posts.alicePost1.id]);
    });
  });
});
