import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { agg, eq, MockRowCache, SelectQueryBuilder } from '../../src';
import { LscDatabase, makeLscDb } from '../utils/lateral-shape-model';

/**
 * Regression guards around the query-build shape caches (v0.4.77): the mock-row prototype
 * cache key is interned per navigation path, and the ORDER BY property-name map a collection
 * build needs is cached per schema. Neither change may move the observable surface — the
 * prototype sharing with the switch on, the fresh prototypes with it off, and the emitted SQL.
 */

const captureProfileMock = async (db: LscDatabase): Promise<any> => {
  let captured: any;

  await db.lscUsers.select((u: any) => {
    captured = u.profile;

    return { a: u.id, bio: u.profile.bio };
  }).toList();

  return captured;
};

describe('query-build shape caches — regression guards', () => {
  afterEach(() => {
    MockRowCache.reset();
  });

  test('with the switch on, reference mocks of the same signature share one prototype across builds', async () => {
    MockRowCache.setEnabled(true);
    const { db } = makeLscDb();

    const first = await captureProfileMock(db);
    const second = await captureProfileMock(db);

    expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second));
    expect(first).not.toBe(second);
  });

  test('with the switch off, every reference mock gets a fresh prototype', async () => {
    const { db } = makeLscDb();

    const first = await captureProfileMock(db);
    const second = await captureProfileMock(db);

    expect(Object.getPrototypeOf(first)).not.toBe(Object.getPrototypeOf(second));
  });

  test('a reference reached through a collection (posts → user) shares its prototype across builds too', async () => {
    MockRowCache.setEnabled(true);
    const { db } = makeLscDb();
    const captured: any[] = [];

    for (let i = 0; i < 2; i++) {
      await db.lscUsers.select(u => ({
        id: u.id,
        posts: u.posts!.select((p: any) => {
          captured.push(p.user);

          return { author: p.user.name };
        }).toList('posts'),
      })).toList();
    }

    expect(captured).toHaveLength(2);
    expect(Object.getPrototypeOf(captured[0])).toBe(Object.getPrototypeOf(captured[1]));
  });

  test('a collection ordered by a column whose property name differs from its db name orders json_agg by the projected alias of that column (CTE strategy)', async () => {
    const { client, db } = makeLscDb('cte');

    await db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.orderBy(x => [[x.userId, 'DESC']]).select(x => ({ id: x.id, userId: x.userId })).toList('posts'),
    })).toList();

    expect(client.last!.sql).toMatchSnapshot();
  });

  test('the same ordered collection under the lateral strategy', async () => {
    const { client, db } = makeLscDb('lateral');

    await db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.orderBy(x => [[x.userId, 'DESC']]).select(x => ({ id: x.id, userId: x.userId })).toList('posts'),
    })).toList();

    expect(client.last!.sql).toMatchSnapshot();
  });
});

/**
 * count() / exists() evaluate a query's projection only to refuse one that would miscount (a set-returning
 * value, a whole-set aggregate). A table's select-all projection — `db.t.where(…)`, `db.t.orderBy(…)` — holds
 * only its columns: it is not evaluated for them, which built a mock row (and, with the mock-row cache off,
 * its prototype) for nothing. The statements are the same; a projection of the chain's own is still checked.
 */
describe('count() / exists() over a table\'s select-all projection', () => {
  test('evaluate no projection for their checks — the statements unchanged', async () => {
    const { client, db } = makeLscDb();
    const mockRows = spyOn(SelectQueryBuilder.prototype, '_createMockRow');

    try {
      expect(await db.lscUsers.where(u => eq(u.active, true)).count()).toBe(0);
      expect(client.last).toEqual({ sql: 'SELECT COUNT(*) as count\nFROM "lsc_users"\nWHERE "lsc_users"."active" = $1', params: [true] });
      expect(await db.lscUsers.where(u => eq(u.active, true)).exists()).toBe(false);
      expect(client.last!.sql.startsWith('SELECT EXISTS(')).toBe(true);
      expect(db.lscPosts.where(p => eq(p.published, true)).futureCount().getSql())
        .toBe('SELECT COUNT(*) as count\nFROM "lsc_posts"\nWHERE "lsc_posts"."published" = $1');
      expect(db.lscPosts.futureCount().getSql()).toBe('SELECT COUNT(*) as count\nFROM "lsc_posts"');
      expect(mockRows).toHaveBeenCalledTimes(0);

      // orderBy() reads the projection (one mock row); count() then reads none
      await db.lscUsers.orderBy(u => u.name).count();
      expect(mockRows).toHaveBeenCalledTimes(1);
    } finally {
      mockRows.mockRestore();
    }
  });

  test('a projection of the chain\'s own is still evaluated — and refused when it would miscount', async () => {
    const { db } = makeLscDb();
    const mockRows = spyOn(SelectQueryBuilder.prototype, '_createMockRow');

    try {
      await db.lscUsers.where(u => eq(u.active, true)).select(u => ({ id: u.id, name: u.name })).count();
      expect(mockRows).toHaveBeenCalledTimes(1);

      let refusal: unknown;
      try {
        await db.lscUsers.where(u => eq(u.active, true)).select(() => ({ n: agg.count() })).count();
      } catch (error) {
        refusal = error;
      }
      expect(String((refusal as Error)?.message)).toContain('count(): this select projects aggregates (agg.*) without groupBy()');
    } finally {
      mockRows.mockRestore();
    }
  });
});
