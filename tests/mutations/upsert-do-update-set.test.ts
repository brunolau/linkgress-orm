import { describe, expect, test } from 'bun:test';
import { eq, sql } from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * `values(...).onConflict(...).doUpdate({ set })` updates the conflicting row to the values `set`
 * gives — a value through its column's mapper, or an `sql` expression that can read the proposed
 * row as `EXCLUDED."column"`. `set` used to name the columns only: `"col" = EXCLUDED."col"` — the
 * conflicting row took the values being INSERTED, and the values given were silently dropped.
 */
describe('upsert: doUpdate({ set })', () => {
  test('the conflicting row takes the values set gives, not the proposed ones', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'alice', email: 'proposed@x', age: 1 })
        .onConflict(['username'])
        .doUpdate({ set: { email: 'set@x', age: 77 } })
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('set@x');
      expect(rows[0].age).toBe(77);

      const stored = await db.users.where(u => eq(u.username, 'alice')).select(u => ({ email: u.email, age: u.age })).first();
      expect(stored).toEqual({ email: 'set@x', age: 77 });
    });
  });

  test('a value goes through its column mapper, and the row reads back through it', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const seen = new Date('2030-05-05T05:05:00Z');

      const rows = await db.users
        .values({ username: 'bob', email: 'bob@test.com' })
        .onConflict(['username'])
        .doUpdate({ set: { lastActiveAt: seen } })
        .execute();

      expect(rows[0].lastActiveAt).toEqual(seen);
      const stored = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ seen: u.lastActiveAt })).first();
      expect(stored).toEqual({ seen });
    });
  });

  test('an sql expression can read the proposed row as EXCLUDED and the current one by its table', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'charlie', email: 'charlie@test.com', age: 5 })
        .onConflict(['username'])
        .doUpdate({ set: { age: sql<number>`"users"."age" + EXCLUDED."age"`, email: sql<string>`upper(EXCLUDED."email")` } })
        .execute();

      expect(rows[0].age).toBe(50);
      expect(rows[0].email).toBe('CHARLIE@TEST.COM');
    });
  });

  test('set may name a column the insert does not carry', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'alice', email: 'alice@test.com' })
        .onConflict(['username'])
        .doUpdate({ set: { isActive: false } })
        .execute();

      expect(rows[0].isActive).toBe(false);
    });
  });

  test('a row without a conflict is inserted as proposed', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'dora', email: 'dora@test.com', age: 20 })
        .onConflict(['username'])
        .doUpdate({ set: { age: 99 } })
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe('dora');
      expect(rows[0].age).toBe(20);
    });
  });

  test('several rows: each conflicting one takes the set values, a new one is inserted', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values([
          { username: 'alice', email: 'a@x', age: 1 },
          { username: 'bob', email: 'b@x', age: 2 },
          { username: 'erin', email: 'e@x', age: 3 },
        ])
        .onConflict(['username'])
        .doUpdate({ set: { age: 60 } })
        .execute();

      const byName = Object.fromEntries(rows.map(r => [r.username, r.age]));
      expect(byName).toEqual({ alice: 60, bob: 60, erin: 3 });
    });
  });

  test('where limits which conflicting rows are updated', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values([
          { username: 'alice', email: 'a@x' },
          { username: 'charlie', email: 'c@x' },
        ])
        .onConflict(['username'])
        .doUpdate({ set: { email: 'updated@x' }, where: '"users"."age" > 40' })
        .execute();

      // alice (25) is left alone — and not returned; charlie (45) is updated
      expect(rows.map(r => [r.username, r.email])).toEqual([['charlie', 'updated@x']]);
      const alice = await db.users.where(u => eq(u.username, 'alice')).select(u => ({ email: u.email })).first();
      expect(alice).toEqual({ email: 'alice@test.com' });
    });
  });

  test('without set every proposed non-key column is taken, as before', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'alice', email: 'proposed@x', age: 31 })
        .onConflict(['username'])
        .doUpdate()
        .execute();

      expect(rows[0].email).toBe('proposed@x');
      expect(rows[0].age).toBe(31);
    });
  });

  test('updateColumns takes exactly those columns from the proposed row', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values({ username: 'bob', email: 'proposed@x', age: 99 })
        .onConflict(['username'])
        .doUpdate({ updateColumns: ['age'] })
        .execute();

      expect(rows[0].age).toBe(99);
      expect(rows[0].email).toBe('bob@test.com');
    });
  });

  test('a set key that is no column is refused', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      await expectToReject(
        () => db.users
          .values({ username: 'alice', email: 'x@x' })
          .onConflict(['username'])
          .doUpdate({ set: { nope: 1 } as any })
          .execute(),
        /doUpdate\(\): "nope" is not a column of "users"/
      );
    });
  });
});
