import { describe, test, expect } from 'bun:test';
import { eq } from '../../src';
import type { LogSection } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * `disableMappers`, `rawResult` and `traceTime` work on their own (1.0.33).
 *
 * The query builders read them from the context's executor, and an executor was only created for a logging,
 * timing, slow-query or prepared-statement option — so `withQueryOptions({ disableMappers: true })` alone, or a
 * context constructed with it alone, still mapped every value. And the table's own `toList()` / `first()` /
 * `firstOrDefault()` mapped every row whatever the options said.
 *
 * Seed (tests/utils/test-database.ts): 'Alice Post 1' has publishTime { hour: 9, minute: 30 }, stored as 570.
 */
const alicePost1 = 'Alice Post 1';

describe('read options without a logging option', () => {
  describe('disableMappers', () => {
    test('withQueryOptions({ disableMappers }) alone: a select reads the stored value', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const rows = await db.posts
          .withQueryOptions({ disableMappers: true })
          .where(p => eq(p.title, alicePost1))
          .select(p => ({ at: p.publishTime }))
          .toList();

        expect(rows as unknown).toEqual([{ at: 570 }]);
      });
    });

    test('withQueryOptions({ disableMappers }) alone: the table\'s own toList() and firstOrDefault() too', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const all = await db.posts.withQueryOptions({ disableMappers: true }).toList();
        expect(all.find(p => p.title === alicePost1)!.publishTime as unknown).toBe(570);

        const one = await db.posts.withQueryOptions({ disableMappers: true }).firstOrDefault();
        expect(typeof (one!.publishTime as unknown)).toBe('number');

        // without the option the same rows read through the mapper
        const mapped = (await db.posts.toList()).find(p => p.title === alicePost1)!;
        expect(mapped.publishTime as unknown).toEqual({ hour: 9, minute: 30 });
      });
    });

    test('a context constructed with disableMappers alone', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);
        const unmapped = new AppDatabase(db.getClient(), { disableMappers: true });

        const rows = await unmapped.posts.where(p => eq(p.title, alicePost1)).select(p => ({ at: p.publishTime })).toList();

        expect(rows as unknown).toEqual([{ at: 570 }]);
      });
    });
  });

  describe('rawResult', () => {
    test('withQueryOptions({ rawResult }) alone: a select returns the driver rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const rows = await db.posts
          .withQueryOptions({ rawResult: true })
          .where(p => eq(p.title, alicePost1))
          .select(p => ({ at: p.publishTime }))
          .toList();

        expect(rows as unknown).toEqual([{ at: 570 }]);
      });
    });

    test('withQueryOptions({ rawResult }) alone: the table\'s own toList() returns the driver rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const rows = (await db.posts.withQueryOptions({ rawResult: true }).toList()) as unknown as Array<Record<string, unknown>>;
        const row = rows.find(r => r.title === alicePost1)!;

        // the database's column names, values as the driver read them
        expect(row.publish_time).toBe(570);
        expect('publishTime' in row).toBe(false);
      });
    });
  });

  test('traceTime alone reports the phases through the logger', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const sections: Array<LogSection | undefined> = [];

      await db.users
        .withQueryOptions({ traceTime: true, logger: (_message, section) => { sections.push(section); } })
        .select(u => ({ id: u.id }))
        .toList();

      expect(sections).toContain('timing');
    });
  });
});
