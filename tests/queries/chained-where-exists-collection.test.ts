import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, exists } from '../../src';

describe('chained .where() with exists(collection.where(...))', () => {
  test('second .where() with exists() over hasMany collection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // First .where() returns a SelectQueryBuilder (via DbEntityTable.where()
      // wrapper which appends an allColumnsSelector .select()). Second .where()
      // therefore goes through SelectQueryBuilder.where(), which wraps the
      // selected mock row in createFieldRefProxy. The proxy must still expose
      // CollectionQueryBuilder methods (.where, .exists) on hasMany navigation
      // getters — otherwise exists(p.postComments.where(...)) blows up with
      // "TypeError: p.postComments.where is not a function".
      let q = db.posts.where(p => eq(p.userId, 1));
      q = q.where(p => exists(p.postComments!.where(pc => eq(pc.comment, 'Great post!'))));
      const result = await q
        .select(p => ({ id: p.id, title: p.title }))
        .toList();

      expect(Array.isArray(result)).toBe(true);
    });
  });
});
