import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { eq } from '../../src/query/conditions';
import { MutationBatch } from '../../src/query/mutation-batch';

/**
 * MutationBatch — heterogeneous INDEPENDENT mutations (insertBulk / bulkUpdate)
 * composed into ONE data-modifying-CTE statement:
 *
 *   WITH "__mb_0" AS (INSERT ... RETURNING 1), "__mb_1" AS (UPDATE ... RETURNING 1)
 *   SELECT (SELECT count(*) FROM "__mb_0") AS "0", ...
 *
 * Legs must be independent (PostgreSQL data-modifying CTEs all run against the
 * SAME snapshot; one leg's writes are invisible to the others, and touching the
 * same row from two legs is undefined). Batched legs must be value-identical to
 * running each mutation standalone — same column mappers, same provided-flag
 * semantics for bulkUpdate.
 */
describe('MutationBatch', () => {
  describe('single round trip + fidelity', () => {
    test('executes an insert leg and an update leg in ONE statement with per-leg affected counts', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        const postsKey = batch.addInsertBulk(db.posts, [
          {
            title: 'Batched Post 1',
            content: 'from mutation batch',
            userId: users.alice.id,
            views: 10,
            publishTime: { hour: 7, minute: 15 },
          },
          {
            title: 'Batched Post 2',
            content: 'also from mutation batch',
            userId: users.bob.id,
            views: 20,
            publishTime: { hour: 21, minute: 45 },
          },
        ], 'posts');
        const usersKey = batch.addBulkUpdate(db.users, [
          { id: users.alice.id, age: 111 },
          { id: users.bob.id, age: 222 },
        ], 'users');

        const client = (db as any).client;
        const querySpy = jest.spyOn(client, 'query');

        try {
          await batch.executeBatch();

          expect(querySpy).toHaveBeenCalledTimes(1);
        } finally {
          querySpy.mockRestore();
        }

        expect(batch.getAffectedCount(postsKey!)).toBe(2);
        expect(batch.getAffectedCount(usersKey!)).toBe(2);
        // string identifiers work as an escape hatch
        expect(batch.getAffectedCount('posts')).toBe(2);

        // Insert-leg fidelity: rows persisted with mapper columns intact
        // (publishTime rides a custom HourMinute mapper).
        const persistedPosts = await db.posts
          .where(p => eq(p.userId, users.alice.id))
          .toList();
        const batched = persistedPosts.find(p => p.title === 'Batched Post 1');
        expect(batched).toBeTruthy();
        expect(batched!.publishTime).toEqual({ hour: 7, minute: 15 });

        const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
        expect(alice.age).toBe(111);
      });
    });

    test('bulkUpdate legs keep provided-flag semantics — absent columns stay untouched', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        batch.addBulkUpdate(db.users, [
          { id: users.bob.id, age: 77 },
          { id: users.charlie.id, isActive: true },
        ], 'users');

        await batch.executeBatch();

        const bob = (await db.users.where(u => eq(u.id, users.bob.id)).toList())[0];
        const charlie = (await db.users.where(u => eq(u.id, users.charlie.id)).toList())[0];

        expect(bob.age).toBe(77);
        // bob's row carried no isActive — the seeded true must survive.
        expect(bob.isActive).toBe(true);
        expect(charlie.isActive).toBe(true);
        // charlie's row carried no age — the seeded 45 must survive.
        expect(charlie.age).toBe(45);
      });
    });

    test('cross-leg parameter renumbering is quote-aware — "$1" inside a value stays verbatim', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        // First leg consumes parameter slots so the second leg gets renumbered.
        batch.addBulkUpdate(db.users, [{ id: users.alice.id, age: 33 }], 'users');
        batch.addInsertBulk(db.posts, [
          {
            title: 'price: $1 and $2 stay literal',
            content: 'renumber probe',
            userId: users.alice.id,
            views: 1,
            publishTime: { hour: 1, minute: 2 },
          },
        ], 'posts');

        await batch.executeBatch();

        const probe = (await db.posts.where(p => eq(p.userId, users.alice.id)).toList())
          .find(p => p.content === 'renumber probe');
        expect(probe?.title).toBe('price: $1 and $2 stay literal');
      });
    });
  });

  describe('atomicity', () => {
    test('a failing leg rolls back every other leg (single-statement atomicity)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        batch.addBulkUpdate(db.users, [{ id: users.alice.id, age: 999 }], 'users');
        batch.addInsertBulk(db.posts, [
          {
            title: null as unknown as string, // NOT NULL violation
            content: 'must never persist',
            userId: users.alice.id,
            views: 0,
            publishTime: { hour: 0, minute: 0 },
          },
        ], 'posts');

        await expectToReject(batch.executeBatch());

        const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
        expect(alice.age).toBe(25); // seeded value — the update leg rolled back
        const strays = (await db.posts.where(p => eq(p.userId, users.alice.id)).toList())
          .filter(p => p.content === 'must never persist');
        expect(strays).toEqual([]);
      });
    });
  });

  describe('registration + lifecycle semantics', () => {
    test('empty row arrays register nothing; an empty batch executes as a no-op', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new MutationBatch();
        const insertKey = batch.addInsertBulk(db.posts, [], 'posts');
        const updateKey = batch.addBulkUpdate(db.users, [], 'users');

        expect(insertKey).toBeNull();
        expect(updateKey).toBeNull();
        expect(batch.size).toBe(0);

        const client = (db as any).client;
        const querySpy = jest.spyOn(client, 'query');

        try {
          await batch.executeBatch(); // no legs — must not touch the database
          expect(querySpy).not.toHaveBeenCalled();
        } finally {
          querySpy.mockRestore();
        }
      });
    });

    test('an update leg matching no rows reports an affected count of 0', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        const missKey = batch.addBulkUpdate(db.users, [{ id: 99_999_999, age: 1 }], 'miss');
        const hitKey = batch.addBulkUpdate(db.posts, [], 'noop')
          ?? batch.addInsertBulk(db.posts, [
            {
              title: 'count probe',
              content: 'count probe',
              userId: users.alice.id,
              views: 1,
              publishTime: { hour: 3, minute: 4 },
            },
          ], 'hit');

        await batch.executeBatch();

        expect(batch.getAffectedCount(missKey!)).toBe(0);
        expect(batch.getAffectedCount(hitKey!)).toBe(1);
      });
    });

    test('reading counts before execution and re-executing both throw', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const batch = new MutationBatch();
        const key = batch.addBulkUpdate(db.users, [{ id: users.alice.id, age: 50 }], 'users');

        expect(() => batch.getAffectedCount(key!)).toThrow();

        await batch.executeBatch();

        await expectToReject(batch.executeBatch());
      });
    });

    test('a leg exceeding the single-statement parameter budget is rejected at registration', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const oversized = Array.from({ length: 8000 }, (_, i) => ({
          title: `bulk ${i}`,
          content: 'x',
          userId: users.alice.id,
          views: i,
          publishTime: { hour: 1, minute: 1 },
          customDate: new Date('2024-01-01T00:00:00Z'),
        }));

        const batch = new MutationBatch();

        expect(() => batch.addInsertBulk(db.posts, oversized, 'posts')).toThrow(/single statement|chunk/i);
      });
    });
  });
});
