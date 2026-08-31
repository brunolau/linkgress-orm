import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src/query/conditions';
import { MutationBatch } from '../../src/query/mutation-batch';

/**
 * MutationBatch `rowGuard` — a bulk INSERT leg whose rows each carry a per-row
 * WHERE guard, compiled as
 *
 *   INSERT INTO t (cols) SELECT v.cols FROM (VALUES ..) AS v(cols) WHERE <guard>
 *
 * so PostgreSQL itself arbitrates which candidate rows are written. The guard
 * cannot see the leg's own inserted rows (snapshot rules), and the caller
 * detects blocked rows through the leg's affected count.
 */
describe('MutationBatch rowGuard', () => {
  test('inserts only the candidate rows whose guard predicate holds', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      // Alice already has 2 posts from the seed, Bob has 1. The guard admits a
      // candidate only while its author is below a 2-post ceiling, so Bob's row
      // lands and Alice's is silently skipped.
      const batch = new MutationBatch();
      const key = batch.addInsertBulk(db.posts, [
        {
          title: 'Guarded — Alice (blocked)',
          content: 'over the ceiling',
          userId: users.alice.id,
          views: 1,
          publishTime: { hour: 8, minute: 0 },
        },
        {
          title: 'Guarded — Bob (allowed)',
          content: 'under the ceiling',
          userId: users.bob.id,
          views: 2,
          publishTime: { hour: 9, minute: 0 },
        },
      ], 'guarded', { rowGuard: '(SELECT count(*) FROM "posts" p WHERE p."user_id" = v."user_id") < 2' });

      await batch.executeBatch();

      expect(batch.getAffectedCount(key!)).toBe(1);

      const alicePosts = await db.posts.where(p => eq(p.userId, users.alice.id)).count();
      const bobPosts = await db.posts.where(p => eq(p.userId, users.bob.id)).count();

      expect(alicePosts).toBe(2);
      expect(bobPosts).toBe(2);
    });
  });

  test('a guard that holds for no row inserts nothing and reports zero', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const batch = new MutationBatch();
      const key = batch.addInsertBulk(db.posts, [
        {
          title: 'Never written',
          content: 'guard is false',
          userId: users.charlie.id,
          views: 0,
          publishTime: { hour: 10, minute: 0 },
        },
      ], 'guarded', { rowGuard: 'FALSE' });

      await batch.executeBatch();

      expect(batch.getAffectedCount(key!)).toBe(0);
      expect(await db.posts.where(p => eq(p.userId, users.charlie.id)).count()).toBe(0);
    });
  });

  test('without the option the leg compiles to the unchanged VALUES insert', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const rows = [
        {
          title: 'Plain',
          content: 'no guard',
          userId: users.charlie.id,
          views: 5,
          publishTime: { hour: 11, minute: 0 },
        },
      ];

      // The guarded and unguarded builders are different compiles; pin that the
      // absent option still produces today's plain `INSERT .. VALUES` SQL.
      const plain = (db.posts as any)._buildInsertBulkStatement(rows);
      const guarded = (db.posts as any)._buildGuardedInsertBulkStatement(rows, 'TRUE');

      expect(plain.sql).toContain('VALUES');
      expect(plain.sql).not.toContain('SELECT');
      expect(guarded.sql).toContain('AS v(');
      expect(guarded.sql.trimEnd().endsWith('WHERE TRUE')).toBe(true);
    });
  });

  test('rowGuard cannot be combined with onConflictDoNothing', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);
      const batch = new MutationBatch();

      expect(() => batch.addInsertBulk(db.posts, [
        {
          title: 'Conflicting options',
          content: 'x',
          userId: users.alice.id,
          views: 0,
          publishTime: { hour: 12, minute: 0 },
        },
      ], 'guarded', { rowGuard: 'TRUE', onConflictDoNothing: true })).toThrow(/rowGuard/);
    });
  });
});
