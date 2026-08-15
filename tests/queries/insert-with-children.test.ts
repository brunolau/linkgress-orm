import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { eq } from '../../src/query/conditions';

/**
 * insertWithChildren — a guarded parent insert plus its dependent child bulk
 * insert executed as ONE statement:
 *
 *   WITH "__iwc_parent__" AS (
 *     INSERT INTO "users" (...) SELECT v.* FROM (VALUES (...)) v
 *     [WHERE NOT EXISTS (SELECT 1 FROM (<guard>) "__iwc_guard__")]
 *     RETURNING ...
 *   ),
 *   "__mutation__" AS (
 *     INSERT INTO "posts" ("user_id", ...)
 *     SELECT p."id", v.* FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, ...), (1, ...)) v("__iwc_ord", ...)
 *     ORDER BY v."__iwc_ord"
 *     RETURNING ...
 *   )
 *   SELECT <child projection>, p.<parent cols> FROM "__mutation__" CROSS JOIN "__iwc_parent__" p ...
 *
 * Contracts under test:
 *  - one round trip; child rows receive the fresh parent PK via the FK column;
 *  - the ordinal ORDER BY makes serial child ids ascend in INPUT-ROW order, and
 *    the returned children come back in that order;
 *  - a matching `unlessExists` guard suppresses the WHOLE insert and resolves
 *    `{ parent: null, children: [] }` with zero rows written;
 *  - single-statement atomicity — a failing child leg rolls the parent back;
 *  - column mappers and quote-aware cross-leg parameter renumbering hold.
 */
describe('insertWithChildren', () => {
  test('inserts parent + children in ONE statement, children in input order with the parent FK', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const client = (db as any).client;
      const querySpy = jest.spyOn(client, 'query');

      let result;
      try {
        result = await db.users.insertWithChildren({
          row: { username: 'iwc-parent', email: 'iwc-parent@test.com', age: 30, isActive: true },
          children: {
            table: db.posts,
            foreignKey: 'userId',
            rows: [
              { title: 'IWC First', content: 'one', views: 1, publishTime: { hour: 8, minute: 5 } },
              { title: 'IWC Second', content: 'two', views: 2, publishTime: { hour: 9, minute: 10 } },
              { title: 'IWC Third', content: 'three', views: 3, publishTime: { hour: 10, minute: 15 } },
            ],
          },
          returning: {
            parent: p => ({ id: p.id, username: p.username }),
            children: c => ({ id: c.id, title: c.title, views: c.views }),
          },
        });

        expect(querySpy).toHaveBeenCalledTimes(1);
      } finally {
        querySpy.mockRestore();
      }

      expect(result.parent).toBeTruthy();
      expect(result.parent!.username).toBe('iwc-parent');
      expect(result.parent!.id).toBeGreaterThan(0);

      expect(result.children.map(c => c.title)).toEqual(['IWC First', 'IWC Second', 'IWC Third']);
      // Serial ids ascend in input order (the ordinal ORDER BY guarantee).
      expect(result.children[0].id).toBeLessThan(result.children[1].id);
      expect(result.children[1].id).toBeLessThan(result.children[2].id);

      // The FK landed on every child row.
      const persisted = await db.posts.where(p => eq(p.userId, result.parent!.id)).toList();
      expect(persisted).toHaveLength(3);
    });
  });

  test('child returning supports navigation projections (flat nav fields)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users.insertWithChildren({
        row: { username: 'iwc-nav', email: 'iwc-nav@test.com', age: 41, isActive: true },
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: 'IWC Nav Post', content: 'nav', views: 7, publishTime: { hour: 11, minute: 30 } },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id, title: c.title, authorName: c.user!.username }),
        },
      });

      expect(result.children).toHaveLength(1);
      expect(result.children[0].authorName).toBe('iwc-nav');
      // Custom-mapped child column round-trips like a standalone insert.
      const persisted = (await db.posts.where(p => eq(p.id, result.children[0].id)).toList())[0];
      expect(persisted.publishTime).toEqual({ hour: 11, minute: 30 });
    });
  });

  test('a matching unlessExists guard suppresses the whole insert and returns parent: null', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const blocked = await db.users.insertWithChildren({
        row: { username: 'iwc-guarded', email: 'iwc-guarded@test.com', age: 20, isActive: true },
        unlessExists: db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id })),
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: 'never inserted', content: 'no', views: 0, publishTime: { hour: 0, minute: 1 } },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id }),
        },
      });

      expect(blocked.parent).toBeNull();
      expect(blocked.children).toEqual([]);

      const stray = await db.users.where(u => eq(u.username, 'iwc-guarded')).toList();
      expect(stray).toEqual([]);

      // A NON-matching guard lets the insert through.
      const allowed = await db.users.insertWithChildren({
        row: { username: 'iwc-unguarded', email: 'iwc-unguarded@test.com', age: 21, isActive: true },
        unlessExists: db.users.where(u => eq(u.username, 'nobody-has-this-name')).select(u => ({ id: u.id })),
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: 'guarded but allowed', content: 'yes', views: 1, publishTime: { hour: 1, minute: 2 } },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id, title: c.title }),
        },
      });

      expect(allowed.parent).toBeTruthy();
      expect(allowed.children).toHaveLength(1);
      expect(users.alice.id).toBeGreaterThan(0);
    });
  });

  test('a failing child leg rolls the parent back (single-statement atomicity)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      await expectToReject(db.users.insertWithChildren({
        row: { username: 'iwc-atomic', email: 'iwc-atomic@test.com', age: 33, isActive: true },
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: null as unknown as string, content: 'boom', views: 0, publishTime: { hour: 2, minute: 3 } },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id }),
        },
      }));

      const stray = await db.users.where(u => eq(u.username, 'iwc-atomic')).toList();
      expect(stray).toEqual([]);
    });
  });

  test('quote-aware renumbering: "$1" inside child values and a parameterized guard coexist', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users.insertWithChildren({
        row: { username: 'iwc-renumber', email: 'iwc-renumber@test.com', age: 55, isActive: true },
        unlessExists: db.users.where(u => eq(u.username, 'no-such-user-here')).select(u => ({ id: u.id })),
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: 'price: $1 and $2 stay literal', content: 'renumber probe', views: 9, publishTime: { hour: 3, minute: 4 } },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id, title: c.title }),
        },
      });

      expect(result.children[0].title).toBe('price: $1 and $2 stay literal');
    });
  });

  test('rejects child rows that carry the foreign-key column, and empty child row arrays', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      expect(() => db.users.insertWithChildren({
        row: { username: 'iwc-invalid', email: 'iwc-invalid@test.com', age: 18, isActive: true },
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: 'has fk', content: 'x', views: 0, publishTime: { hour: 4, minute: 5 }, userId: users.alice.id },
          ],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id }),
        },
      })).toThrow(/foreign.?key/i);

      expect(() => db.users.insertWithChildren({
        row: { username: 'iwc-empty', email: 'iwc-empty@test.com', age: 19, isActive: true },
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [],
        },
        returning: {
          parent: p => ({ id: p.id }),
          children: c => ({ id: c.id }),
        },
      })).toThrow(/non-empty/i);
    });
  });
});
