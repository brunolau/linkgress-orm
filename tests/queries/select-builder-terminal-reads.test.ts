import { describe, test, expect } from 'bun:test';
import { agg, eq, gt } from '../../src';
import type { UnwrapDbColumns } from '../../src';
import type { User } from '../../debug/model/user';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * The terminal reads of a query are typed and read like what they stand for (1.0.33):
 *
 * - `first()` after `where()` / `orderBy()` / `select()` is `firstOrDefault()`: it resolves to null when no row
 *   matches, and is typed `T | null` (it was typed `T`, so a missing row reached the caller as a null the compiler
 *   had promised away). The table's own `db.users.first()` still throws on an empty table and stays typed `T`.
 *   The typing half of these tests is checked by `tsc -p tests/tsconfig.json`: an unused `@ts-expect-error` fails it.
 * - The select builder's `sum()` / `min()` / `max()` read their one value like `agg.sum()` / `agg.min()` / `agg.max()`
 *   in a projection: `sum()` a number, `min()` / `max()` like the column — through its mapper, a numeric as a number.
 *   They returned the driver's raw value (the string '450' for an int column's SUM, the stored 1125 of a mapped
 *   column's MAX). The statement they send is unchanged.
 */
describe('terminal reads: first() typing, sum() / min() / max() values', () => {
  describe('first() after where() / select() resolves to null when no row matches, typed T | null', () => {
    test('a where() query: the entity or null', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const none = await db.users.where(u => eq(u.username, 'nobody')).first();
        // @ts-expect-error first() may resolve to null
        const unchecked: UnwrapDbColumns<User> = none;
        expect(unchecked).toBeNull();

        const alice: UnwrapDbColumns<User> | null = await db.users.where(u => eq(u.username, 'alice')).first();
        expect(alice?.username).toBe('alice');
      });
    });

    test('a select() query: the projection or null', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const none = await db.users.where(u => gt(u.age, 1000)).select(u => ({ id: u.id, name: u.username })).first();
        // @ts-expect-error first() may resolve to null
        const unchecked: { id: number; name: string } = none;
        expect(unchecked).toBeNull();

        const oldest: { id: number; name: string } | null = await db.users
          .select(u => ({ id: u.id, name: u.username }))
          .orderBy(u => [[u.id, 'DESC']])
          .first();
        expect(oldest?.name).toBe('charlie');
      });
    });

    test('the table\'s own first() stays typed T and throws when the table is empty', async () => {
      await withDatabase(async (db) => {
        // compiles only while the table's first() is typed non-null
        const tableFirst = (): Promise<UnwrapDbColumns<User>> => db.users.first();

        let message = '';
        try {
          await tableFirst();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe('Sequence contains no elements');
      });
    });
  });

  describe('sum() / min() / max() read like agg.sum() / agg.min() / agg.max()', () => {
    test('sum() of an int column is a number, as agg.sum() reads it', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const total = await db.posts.select(p => ({ views: p.views })).sum(r => r.views);
        const viaAgg = await db.posts.select(p => ({ total: agg.sum(p.views) })).firstOrDefault();

        expect(total).toBe(450);
        expect(total).toBe(viaAgg!.total);
      });
    });

    test('sum() / min() / max() of a decimal column are numbers', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        expect(await db.orders.select(o => ({ amount: o.totalAmount })).sum(r => r.amount)).toBe(249.98);
        expect(await db.orders.select(o => ({ amount: o.totalAmount })).max(r => r.amount)).toBe(149.99);
        expect(await db.orders.select(o => ({ amount: o.totalAmount })).min(r => r.amount)).toBe(99.99);
      });
    });

    test('min() / max() of a mapped column read through its mapper', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const latest = await db.posts.select(p => ({ at: p.publishTime })).max(r => r.at);
        const earliest = await db.posts.select(p => ({ at: p.publishTime })).min(r => r.at);
        const viaAgg = await db.posts.select(p => ({ latest: agg.max(p.publishTime), earliest: agg.min(p.publishTime) })).firstOrDefault();

        expect(latest).toEqual({ hour: 18, minute: 45 });
        expect(earliest).toEqual({ hour: 9, minute: 30 });
        expect({ latest, earliest }).toEqual(viaAgg!);
      });
    });

    test('an int column reads as before', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        expect(await db.users.select(u => ({ age: u.age })).min(r => r.age)).toBe(25);
        expect(await db.users.select(u => ({ age: u.age })).max(r => r.age)).toBe(45);
      });
    });

    test('no matching row: null', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const none = db.posts.where(p => gt(p.views, 1_000_000)).select(p => ({ views: p.views, at: p.publishTime }));

        expect(await none.sum(r => r.views)).toBeNull();
        expect(await none.max(r => r.views)).toBeNull();
        expect(await none.min(r => r.at)).toBeNull();
      });
    });

    test('disableMappers reads the stored value, rawResult the driver value', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // both options step outside the declared type on purpose: the value as stored / as the driver hands it
        const stored: unknown = await db.posts.withQueryOptions({ disableMappers: true }).select(p => ({ at: p.publishTime })).max(r => r.at);
        const driverValue: unknown = await db.posts.withQueryOptions({ rawResult: true }).select(p => ({ views: p.views })).sum(r => r.views);

        expect(stored).toBe(1125);
        expect(driverValue).toBe('450');
      });
    });

    test('the statement is unchanged: one SELECT of the aggregate', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);
        const statements: string[] = [];

        await db.posts
          .withQueryOptions({ logQueries: true, logger: (message, section) => { if (section === 'sql' && !message.startsWith('\n[')) statements.push(message); } })
          .where(p => gt(p.views, 0))
          .select(p => ({ views: p.views }))
          .sum(r => r.views);

        expect(statements).toHaveLength(1);
        expect(statements[0]).toStartWith('SELECT SUM("posts"."views") as result\nFROM "posts"');
        expect(statements[0]).toContain('WHERE "posts"."views" > $1');
      });
    });
  });
});
