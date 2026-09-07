import { describe, test, expect, afterEach } from '@jest/globals';
import { MockRowCache } from '../../src';
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

  test('a collection ordered by a column whose property name differs from its db name keeps both ORDER BY forms (CTE strategy)', async () => {
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
