import { describe, test, expect, beforeAll } from 'bun:test';
import { getSharedDatabase, setupDatabase, seedTestData } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { and, caseWhen, eq, exists, gt, isNull, lt, not, or, sql, SqlFragment } from '../../src';
import { projectConditionValues, selectorProjectingConditions } from '../../src/query/sql-functions';

/**
 * A condition placed directly in a projection selects as a boolean column:
 * `select(p => ({ popular: gt(p.views, 120) }))`. It used to be walked as a nested object.
 */
describe('conditions projected as boolean columns', () => {
  describe('projectConditionValues()', () => {
    const ref = { __dbColumnName: 'views', __fieldName: 'views', __tableAlias: 'posts' };

    test('turns top-level and nested conditions into fragments', () => {
      const projected: any = projectConditionValues({ a: gt(ref, 1), nested: { b: isNull(ref) }, keep: ref });

      expect(projected.a).toBeInstanceOf(SqlFragment);
      expect(projected.nested.b).toBeInstanceOf(SqlFragment);
      expect(projected.keep).toBe(ref);
    });

    test('returns the very same object when there is nothing to project', () => {
      const selection = { a: ref, nested: { b: ref }, list: [1, 2], when: new Date(0) };
      expect(projectConditionValues(selection)).toBe(selection);
    });

    test('leaves fragments, arrays, class instances and accessor-built objects alone', () => {
      const fragment = sql<boolean>`${ref} > 1`;
      const accessorRow = Object.defineProperty({}, 'views', { get: () => ref, enumerable: true });
      const array = [gt(ref, 1)];

      expect(projectConditionValues(fragment)).toBe(fragment);
      expect(projectConditionValues(accessorRow)).toBe(accessorRow);
      expect(projectConditionValues(array)).toBe(array);
    });

    test('a single condition as the whole selection becomes a fragment', () => {
      expect(projectConditionValues(gt(ref, 1) as any)).toBeInstanceOf(SqlFragment);
    });

    test('selector wrapping is idempotent', () => {
      const selector = (row: any) => ({ x: row });
      const once = selectorProjectingConditions(selector);
      expect(selectorProjectingConditions(once)).toBe(once);
    });
  });

  describe('in queries', () => {
    let db: AppDatabase;
    let seed: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      db = getSharedDatabase();
      await setupDatabase(db);
      seed = await seedTestData(db);
    });

    test('a comparison and a logical tree select as booleans', async () => {
      const rows = await db.posts
        .select(p => ({
          title: p.title,
          popular: gt(p.views, 120),
          band: and(gt(p.views, 100), lt(p.views, 200)),
          either: or(eq(p.views, 100), eq(p.views, 200)),
          notPopular: not(gt(p.views, 120)),
        }))
        .orderBy(p => p.title)
        .toList();

      const typed: boolean = rows[0].popular;
      expect(typed).toBe(false);
      expect(rows).toEqual([
        { title: 'Alice Post 1', popular: false, band: false, either: true, notPopular: true },
        { title: 'Alice Post 2', popular: true, band: true, either: false, notPopular: false },
        { title: 'Bob Post', popular: true, band: false, either: true, notPopular: false },
      ]);
    });

    test('a navigation inside a projected condition is joined', async () => {
      const rows = await db.posts
        .select(p => ({ title: p.title, byAlice: eq(p.user!.username, 'alice') }))
        .orderBy(p => p.title)
        .toList();

      expect(rows.map(r => r.byAlice)).toEqual([true, true, false]);
    });

    test('conditions in nested object literals', async () => {
      const rows = await db.posts
        .select(p => ({ title: p.title, flags: { popular: gt(p.views, 120), long: gt(p.views, 1000) } }))
        .orderBy(p => p.title)
        .toList();

      expect(rows[2]).toEqual({ title: 'Bob Post', flags: { popular: true, long: false } });
    });

    test('exists() keeps working as before', async () => {
      const rows = await db.users
        .select(u => ({ username: u.username, posted: exists(u.posts!.where(p => gt(p.views, 0))) }))
        .orderBy(u => u.username)
        .toList();

      expect(rows.map(r => r.posted)).toEqual([true, true, false]);
    });

    test('inside a collection projection', async () => {
      const rows = await db.users
        .where(u => eq(u.username, 'alice'))
        .select(u => ({
          posts: u.posts!.orderBy(p => p.title).select(p => ({ title: p.title, popular: gt(p.views, 120) })).toList('posts'),
        }))
        .toList();

      expect(rows[0].posts).toEqual([
        { title: 'Alice Post 1', popular: false },
        { title: 'Alice Post 2', popular: true },
      ]);
    });

    test('ordered by a projected condition', async () => {
      const rows = await db.posts
        .select(p => ({ title: p.title, popular: gt(p.views, 120) }))
        .orderBy(p => [[p.popular, 'DESC'], [p.title, 'ASC']])
        .toList();

      expect(rows.map(r => r.title)).toEqual(['Alice Post 2', 'Bob Post', 'Alice Post 1']);
    });

    test('in a grouped select, over the grouping key — and a CASE beside it', async () => {
      const rows = await db.posts
        .select(p => ({ userId: p.userId, views: p.views }))
        .groupBy(p => ({ userId: p.userId }))
        .select(g => ({
          userId: g.key.userId,
          // grouping keys are typed as their values; at runtime they are column refs
          isAlice: eq(g.key.userId as any, seed.users.alice.id),
          label: caseWhen(eq(g.key.userId as any, seed.users.alice.id), 'alice').else('other'),
          count: g.count(),
        }))
        .toList();

      const sorted = [...rows].sort((a, b) => a.userId - b.userId);
      // the grouped result type unwraps conditions and fragments to their values
      const typedFlag: boolean = sorted[0].isAlice;
      const typedLabel: string = sorted[0].label;
      expect([typedFlag, typedLabel]).toEqual([true, 'alice']);
      expect(sorted).toEqual([
        { userId: seed.users.alice.id, isAlice: true, label: 'alice', count: 2 },
        { userId: seed.users.bob.id, isAlice: false, label: 'other', count: 1 },
      ]);
    });
  });
});
