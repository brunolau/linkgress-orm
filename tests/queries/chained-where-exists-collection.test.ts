import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, exists, notExists } from '../../src';

/**
 * Regression coverage for the chained-`.where()` proxy bug.
 *
 * `DbEntityTable.where()` appends an implicit `.select(allColumnsSelector)`, so
 * the FIRST `.where()` returns a `SelectQueryBuilder`. A chained SECOND
 * `.where()` therefore runs its selector through `createFieldRefProxy`, which
 * used to recursively wrap EVERY object value — including the
 * `CollectionQueryBuilder` returned by a hasMany navigation getter. The wrapping
 * proxy turned `.where` / `.exists` / `.select` into FieldRef objects, so any
 * collection navigation method in the second `.where()` threw
 * "TypeError: p.<navProp>.where is not a function".
 *
 * Every test below drives a chained `.where()` (the proxy path) and asserts the
 * ACTUAL rows returned — not merely that the call doesn't throw — so a future
 * regression that silently produced wrong SQL (lost correlation, dropped the
 * first predicate) would still be caught.
 *
 * Seed reference (from seedTestData):
 *   posts:        alicePost1(id1,user1,views100) alicePost2(id2,user1,views150) bobPost(id3,user2,views200)
 *   postComments: c1(post1,'Related to order') c2(post2,'Mentions another order') c3(post3,'My order update')
 *   orders→tasks: order1 & order2 each have an orderTask with sortOrder=1
 */
describe('chained .where() with collection navigation (exists/notExists)', () => {
  const ids = (rows: Array<{ id: number }>) => rows.map(r => r.id).sort((a, b) => a - b);

  test('exists(collection.where) — correlated, returns the matching row only', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      let q = db.posts.where(p => eq(p.userId, 1));            // alice's posts: 1, 2
      q = q.where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Related to order'))));
      const result = await q.select(p => ({ id: p.id, title: p.title })).toList();

      // Only post 1 carries the 'Related to order' comment.
      expect(ids(result)).toEqual([1]);
      expect(result[0].title).toBe('Alice Post 1');
    });
  });

  test('exists(collection.where) — per-row correlation + first predicate preserved', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      let q = db.posts.where(p => eq(p.userId, 1));            // alice's posts: 1, 2
      // 'My order update' belongs to bobPost(3); it must NOT leak into alice's
      // result set. Empty proves the EXISTS correlates per row AND that the
      // first .where(userId=1) is still ANDed in.
      q = q.where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'My order update'))));
      const result = await q.select(p => ({ id: p.id })).toList();

      expect(result).toEqual([]);
    });
  });

  test('exists(collection.where) — chained path equals single-.where() path', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Single .where() goes through the raw mock-row path (always worked).
      const single = await db.posts
        .where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Related to order'))))
        .select(p => ({ id: p.id }))
        .toList();

      // Chained .where() goes through the proxy path (the bug). gt(views,0)
      // matches every post, so the two queries must return the same rows.
      let q = db.posts.where(p => gt(p.views!, 0));
      q = q.where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Related to order'))));
      const chained = await q.select(p => ({ id: p.id })).toList();

      expect(ids(chained)).toEqual([1]);
      expect(ids(chained)).toEqual(ids(single));
    });
  });

  test('notExists(collection.where) in second .where()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      let q = db.posts.where(p => eq(p.userId, 1));            // alice's posts: 1, 2
      // Exclude posts that have the 'Related to order' comment (post 1) -> post 2.
      q = q.where(p => notExists(p.postComments!.where(pc => eq(pc.comment, 'Related to order'))));
      const result = await q.select(p => ({ id: p.id })).toList();

      expect(ids(result)).toEqual([2]);
    });
  });

  test('collection.where().exists() method form in second .where()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      let q = db.posts.where(p => eq(p.userId, 1));            // alice's posts: 1, 2
      q = q.where(p => p.postComments!.where(pc => eq(pc.comment, 'Related to order')).exists());
      const result = await q.select(p => ({ id: p.id })).toList();

      expect(ids(result)).toEqual([1]);
    });
  });

  test('nested exists (collection -> reference -> collection) in second .where()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      let q = db.posts.where(p => gt(p.views!, 0));            // all posts
      q = q.where(p => exists(
        p.postComments!.where(pc =>
          pc.order!.orderTasks!.where(ot => eq(ot.sortOrder, 1)).exists()
        )
      ));
      const result = await q.select(p => ({ id: p.id })).toList();

      // Every post's comment maps to an order that has an orderTask sortOrder=1.
      expect(ids(result)).toEqual([1, 2, 3]);
    });
  });

  test('hasOne/reference column ref in second .where()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // hasOne navigation surfaces a mock target row (not a builder), so it goes
      // through the recursive-wrap path rather than the new guard. Covered here
      // because the chained-.where() + reference-column shape was untested.
      let q = db.posts.where(p => gt(p.views!, 90));           // all posts
      q = q.where(p => eq(p.user!.username, 'alice'));         // author is alice -> posts 1, 2
      const result = await q.select(p => ({ id: p.id })).toList();

      expect(ids(result)).toEqual([1, 2]);
    });
  });
});
