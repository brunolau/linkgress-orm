import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src/query/conditions';
import { sql } from '../../src';

/**
 * SqlFragment support in UPDATE/DELETE `.returning(selector)` — previously the
 * plain returning-clause builder recognised only `__dbColumnName` field refs and
 * SILENTLY DROPPED any fragment from the clause. Now a fragment renders into the
 * RETURNING list under its selector key, with its parameters appended AFTER the
 * SET and WHERE parameters (RETURNING is last in statement text, so positional
 * order stays correct) and its `mapWith` mapper applied to the returned value.
 *
 * Headline use case: PostgreSQL 18's `old.`/`new.` RETURNING qualifiers — e.g.
 * `RETURNING old."status"` lets a status-transition UPDATE report the
 * pre-update value without a separate pre-read (order-task completion fuse).
 *
 * v1 restriction: fragments in returning selectors must not embed entity
 * FieldRefs (`${p.col}`) — navigation detection skips fragments wholesale, so
 * column references belong in raw quoted SQL (`old."age"`), params via `${}`.
 */
describe('UPDATE/DELETE returning with SqlFragment', () => {
  test('update captures pre-update value via PG18 old. qualifier', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const rows = await db.users
        .where(u => eq(u.id, users.alice.id))
        .update({ age: 99 })
        .returning(u => ({ id: u.id, oldAge: sql<number>`old."age"` }));

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(users.alice.id);
      // Alice seeds at 25 — the fragment must surface the PRE-update value.
      expect(rows[0].oldAge).toBe(25);

      const fresh = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
      expect(fresh.age).toBe(99);
    });
  });

  test('fragment params renumber after SET and WHERE params', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      // SET consumes $1, WHERE consumes $2 — the fragment's three params must
      // land at $3+ and still bind correctly.
      const rows = await db.users
        .where(u => eq(u.username, 'bob'))
        .update({ age: 50 })
        .returning(u => ({
          id: u.id,
          tag: sql<string>`CASE WHEN old."age" > ${30}::int THEN ${'gt30'}::text ELSE ${'lte30'}::text END`,
        }));

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(users.bob.id);
      // Bob seeds at 35 (> 30).
      expect(rows[0].tag).toBe('gt30');
    });
  });

  test('fragment mapWith mapper is applied to the returned value', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const rows = await db.users
        .where(u => eq(u.id, users.alice.id))
        .update({ isActive: false })
        .returning(u => ({
          verdict: sql`old."is_active"`.mapWith((v: boolean) => (v ? 'YES' : 'NO')),
        }));

      expect(rows).toHaveLength(1);
      // Alice seeds active — mapper transforms the raw boolean.
      expect(rows[0].verdict).toBe('YES');
    });
  });

  test('delete returning renders computed fragments', async () => {
    await withDatabase(async (db) => {
      const { posts } = await seedTestData(db);

      const rows = await db.posts
        .where(p => eq(p.id, posts.alicePost1.id))
        .delete()
        .returning(p => ({ id: p.id, shout: sql<string>`upper("title")` }));

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(posts.alicePost1.id);
      expect(rows[0].shout).toBe('ALICE POST 1');

      const remaining = await db.posts.where(p => eq(p.id, posts.alicePost1.id)).toList();
      expect(remaining).toHaveLength(0);
    });
  });

  test('plain-column-only returning selectors keep working unchanged', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const rows = await db.users
        .where(u => eq(u.id, users.charlie.id))
        .update({ age: 46 })
        .returning(u => ({ id: u.id, age: u.age }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: users.charlie.id, age: 46 });
    });
  });
});
