import { describe, test, expect, afterEach, beforeEach } from '@jest/globals';
import { eq, gt, sql, MockRowCache, LateralSqlCache } from '../../src';
import { LscDatabase, makeLscDb } from '../utils/lateral-shape-model';

/**
 * v0.4.77 — the lateral collection strategy memoises its RENDERED SQL per shape.
 *
 * Everything `LateralCollectionStrategy.buildAggregation` assembles is a pure function of the
 * aggregation config (aliases, field expressions, the WHERE/ORDER BY text with its `$n`
 * placeholders, limits, flags, navigation joins, nested join clauses) plus the enclosing lateral
 * alias map. The same query shape therefore renders the same text on every build, and only the
 * parameter VALUES differ. The memo is gated by the same opt-in switch as the mock-row and
 * navigation-path caches (`MockRowCache.setEnabled`).
 *
 * The contract pinned here: with the switch ON, the SQL a shape renders on its second build is
 * byte-identical to the SQL the same shape renders with the switch OFF (a fresh build) — for a
 * set of shapes that exercise every input the key must cover — and the parameters still reflect
 * the values of the CURRENT call.
 */

type ShapeParams = { minViews: number; authorId: number; published: boolean; limit: number };

interface Shape {
  name: string;
  /** Number of lateral aggregations the shape renders (memo entries a first build adds). */
  laterals: number;
  build: (db: LscDatabase, p: ShapeParams) => Promise<unknown>;
}

const shapes: Shape[] = [
  {
    name: 'plain list',
    laterals: 1,
    build: (db) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.select(p => ({ id: p.id, title: p.title })).toList('posts'),
    })).toList(),
  },
  {
    name: 'where with a parameter, ordered, limited, offset',
    laterals: 1,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!
        .where(x => gt(x.views, p.minViews))
        .orderBy(x => [[x.views, 'DESC']])
        .limit(p.limit)
        .offset(2)
        .select(x => ({ id: x.id, views: x.views }))
        .toList('posts'),
    })).toList(),
  },
  {
    name: 'same shape, a different limit (the key must see the limit)',
    laterals: 1,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!
        .where(x => gt(x.views, p.minViews))
        .orderBy(x => [[x.views, 'DESC']])
        .limit(p.limit + 5)
        .offset(2)
        .select(x => ({ id: x.id, views: x.views }))
        .toList('posts'),
    })).toList(),
  },
  {
    name: 'distinct number list (correlated subquery form)',
    laterals: 1,
    build: (db) => db.lscUsers.select(u => ({
      id: u.id,
      views: u.posts!.selectDistinct(x => x.views).toNumberList(),
    })).toList(),
  },
  {
    name: 'firstOrDefault (single-object form)',
    laterals: 1,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      latest: u.posts!
        .where(x => eq(x.published, p.published))
        .orderBy(x => [[x.id, 'DESC']])
        .select(x => ({ id: x.id, title: x.title }))
        .firstOrDefault('latest'),
    })).toList(),
  },
  {
    name: 'count with a where parameter',
    laterals: 1,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      published: u.posts!.where(x => eq(x.published, p.published)).count(),
    })).toList(),
  },
  {
    name: 'collection targeting the OUTER table (posts.user.posts — the marker rewrite)',
    laterals: 1,
    build: (db, p) => db.lscPosts.select(post => ({
      id: post.id,
      siblings: post.user!.posts!
        .where(s => eq(s.published, p.published))
        .select(s => ({ id: s.id, title: s.title }))
        .toList('siblings'),
    })).toList(),
  },
  {
    name: 'nested collection with a navigation join and a parameter in the inner where',
    laterals: 2,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.select(post => ({
        id: post.id,
        comments: post.comments!
          .where(c => eq(c.authorId, p.authorId))
          .select(c => ({ body: c.body, author: c.author!.name }))
          .toList('comments'),
      })).toList('posts'),
    })).toList(),
  },
  {
    name: 'sql fragment field carrying a bound parameter',
    laterals: 1,
    build: (db, p) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.select(x => ({
        id: x.id,
        popular: sql<boolean>`(${x.views} > ${p.minViews})`,
      })).toList('posts'),
    })).toList(),
  },
  {
    name: 'nested object projection inside the collection',
    laterals: 1,
    build: (db) => db.lscUsers.select(u => ({
      id: u.id,
      posts: u.posts!.select(x => ({
        id: x.id,
        meta: { title: x.title, views: x.views, author: x.user!.name },
      })).toList('posts'),
    })).toList(),
  },
];

const paramsA: ShapeParams = { minViews: 10, authorId: 7, published: true, limit: 5 };
const paramsB: ShapeParams = { minViews: 99, authorId: 8, published: false, limit: 5 };

describe('LateralSqlCache — rendered lateral SQL is memoised per shape', () => {
  beforeEach(() => {
    MockRowCache.reset();
    LateralSqlCache.reset();
  });

  afterEach(() => {
    MockRowCache.reset();
    LateralSqlCache.reset();
  });

  test('is off by default and reports no entries', () => {
    expect(LateralSqlCache.diagnostics()).toEqual({ enabled: false, entries: 0, maxEntries: LateralSqlCache.MAX_ENTRIES });
  });

  test('with the switch off every build renders afresh and retains nothing', async () => {
    const { client, db } = makeLscDb();

    await shapes[0].build(db, paramsA);
    const first = client.last!.sql;
    await shapes[0].build(db, paramsA);

    expect(client.last!.sql).toBe(first);
    expect(LateralSqlCache.diagnostics().entries).toBe(0);
  });

  test('with the switch on, a second build of every shape renders the SQL a fresh build renders', async () => {
    const fresh = new Map<string, string>();

    for (const shape of shapes) {
      const { client, db } = makeLscDb();
      await shape.build(db, paramsA);
      fresh.set(shape.name, client.last!.sql);
    }

    MockRowCache.setEnabled(true);
    const { client, db } = makeLscDb();
    let expectedEntries = 0;

    for (const shape of shapes) {
      await shape.build(db, paramsA);
      expectedEntries += shape.laterals;
      expect({ shape: shape.name, sql: client.last!.sql }).toEqual({ shape: shape.name, sql: fresh.get(shape.name) });
      expect({ shape: shape.name, entries: LateralSqlCache.diagnostics().entries }).toEqual({ shape: shape.name, entries: expectedEntries });
    }

    for (const shape of shapes) {
      await shape.build(db, paramsA);
      expect({ shape: shape.name, sql: client.last!.sql }).toEqual({ shape: shape.name, sql: fresh.get(shape.name) });
    }

    expect(LateralSqlCache.diagnostics()).toEqual({ enabled: true, entries: expectedEntries, maxEntries: LateralSqlCache.MAX_ENTRIES });
  });

  test('a memo hit still binds the parameter values of the current call', async () => {
    MockRowCache.setEnabled(true);
    const { client, db } = makeLscDb();
    const parametrised = shapes.filter(s => /parameter/.test(s.name));
    expect(parametrised.length).toBeGreaterThanOrEqual(3);

    for (const shape of parametrised) {
      await shape.build(db, paramsA);
      const sqlA = client.last!.sql;
      const boundA = client.last!.params;
      await shape.build(db, paramsB);

      expect({ shape: shape.name, sql: client.last!.sql }).toEqual({ shape: shape.name, sql: sqlA });
      expect({ shape: shape.name, params: client.last!.params }).not.toEqual({ shape: shape.name, params: boundA });
      expect(client.last!.params.length).toBe(boundA.length);
    }
  });

  test('two shapes that differ only in one input never share an entry', async () => {
    MockRowCache.setEnabled(true);
    const { client, db } = makeLscDb();

    await shapes[1].build(db, paramsA);
    const limited = client.last!.sql;
    await shapes[2].build(db, paramsA);

    expect(client.last!.sql).not.toBe(limited);
    expect(client.last!.sql).toContain('LIMIT 10');
    expect(limited).toContain('LIMIT 5');
    expect(LateralSqlCache.diagnostics().entries).toBe(2);
  });

  test('reset() drops every entry; the switch is owned by MockRowCache', async () => {
    MockRowCache.setEnabled(true);
    const { db } = makeLscDb();
    await shapes[0].build(db, paramsA);
    expect(LateralSqlCache.diagnostics().entries).toBe(1);

    LateralSqlCache.reset();

    expect(LateralSqlCache.diagnostics()).toEqual({ enabled: true, entries: 0, maxEntries: LateralSqlCache.MAX_ENTRIES });
  });
});
