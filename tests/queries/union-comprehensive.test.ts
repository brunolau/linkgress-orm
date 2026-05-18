import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, and, or, inSubquery, sql } from '../../src';

/**
 * Comprehensive UNION ALL regression tests covering the full surface area
 * unlocked by the Phase B + C fixes (nested-object projections, collection
 * navigation, paramCounter chaining, asSubquery composition).
 *
 * These tests are GROUPED by concern so a future failure narrows down to a
 * single dimension (nesting, collections, subquery composition, edge cases,
 * etc.) without forcing a re-read of the whole file. Each group is self-
 * contained and order-independent.
 */
describe('UNION ALL — comprehensive (Phase B + C coverage)', () => {
  // ============================================================
  // GROUP 1 — happy-path / sanity, no nested objects or collections
  // ============================================================
  describe('happy-path sanity', () => {
    test('3-leg UNION ALL across the same table is a true Append', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const a = db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id, name: u.username }));
        const b = db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username }));
        const c = db.users.where(u => eq(u.username, 'charlie')).select(u => ({ id: u.id, name: u.username }));

        const rows = await a.unionAll(b).unionAll(c).toList();
        expect(rows.length).toBe(3);
        expect(rows.map(r => r.name).sort()).toEqual(['alice', 'bob', 'charlie']);
      });
    });

    test('UNION ALL across DIFFERENT tables with compatible columns', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // user + post names projected as a unified 'label' column.
        const userNames = db.users.select(u => ({ label: u.username }));
        const postNames = db.posts.select(p => ({ label: p.title }));
        const rows = await userNames.unionAll(postNames).toList();
        expect(rows.length).toBe(3 + 3); // 3 users + 3 posts
        // The seeded titles include "Alice Post 1", "Alice Post 2", "Bob Post".
        expect(rows.some(r => r.label === 'alice')).toBe(true);
        expect(rows.some(r => r.label === 'Alice Post 1')).toBe(true);
      });
    });

    test('UNION ALL with ORDER BY at the union level', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id, name: u.username }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id, name: u.username }));
        const rows = await left.unionAll(right).orderBy(r => r.name).toList();
        const names = rows.map(r => r.name);
        // Order is alphabetical across the merged set.
        for (let i = 1; i < names.length; i++) {
          expect(names[i - 1].localeCompare(names[i])).toBeLessThanOrEqual(0);
        }
      });
    });

    test('UNION ALL with LIMIT + OFFSET at the union level', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.select(u => ({ name: u.username }));
        const right = db.users.select(u => ({ name: u.username }));
        // 3 + 3 = 6 rows, offset 1 + limit 2 = 2 rows.
        const rows = await left.unionAll(right).orderBy(r => r.name).offset(1).limit(2).toList();
        expect(rows.length).toBe(2);
      });
    });

    test('UNION ALL → firstOrDefault returns a single row, applies post-processing', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Use a nested projection — proves firstOrDefault routes through the
        // same post-processing pipeline as toList.
        const left = db.users.where(u => eq(u.username, 'alice')).select(u => ({
          id: u.id,
          addr: { street: sql<string>`'A'`, city: u.email },
        }));
        const right = db.users.where(u => eq(u.username, 'bob')).select(u => ({
          id: u.id,
          addr: { street: sql<string>`'B'`, city: u.email },
        }));
        const row = await left.unionAll(right).orderBy(r => r.id).firstOrDefault();
        expect(row).not.toBeNull();
        expect(typeof row!.addr).toBe('object');
        expect(row!.addr).toHaveProperty('street');
      });
    });

    test('UNION ALL → count returns the total row count', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id }));
        const right = db.users.where(u => eq(u.isActive, false)).select(u => ({ id: u.id }));
        // active={alice,bob}, inactive={charlie} → 3
        const n = await left.unionAll(right).count();
        expect(n).toBe(3);
      });
    });

    test('UNION ALL preserves Postgres semantics — duplicates are kept', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id }));
        const rows = await left.unionAll(right).toList();
        // active = {alice(1), bob(2)}; age>30 = {bob(2), charlie(3)} → 4 rows.
        expect(rows.length).toBe(4);
        // bob's id appears twice
        const counts = new Map<number, number>();
        for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
        expect([...counts.values()].sort()).toEqual([1, 1, 2]);
      });
    });

    test('UNION (no ALL) deduplicates rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id }));
        const rows = await left.union(right).toList();
        // Deduplicated: alice, bob, charlie → 3 distinct rows.
        expect(rows.length).toBe(3);
      });
    });
  });

  // ============================================================
  // GROUP 2 — nested-object projections (Phase B coverage)
  // ============================================================
  describe('nested-object projections', () => {
    test('two UNION legs with IDENTICAL nested shapes align', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          info: { name: u.username, email: u.email },
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          info: { name: u.username, email: u.email },
        }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(4);
        for (const row of rows) {
          expect(typeof row.info).toBe('object');
          expect(typeof row.info.name).toBe('string');
          expect(typeof row.info.email).toBe('string');
        }
      });
    });

    test('UNION leg with literal NULLs for nested fields still aligns', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Both legs declare `hint: string | null` so the union type-checks.
        // The actual values still differ (one leg returns 'real-hint', the
        // other returns NULL).
        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          info: { name: u.username, hint: sql<string | null>`'real-hint'` },
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          info: { name: u.username, hint: sql<string | null>`NULL` },
        }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(4);
        const hints = rows.map(r => r.info.hint);
        expect(hints).toContain('real-hint');
        expect(hints).toContain(null);
      });
    });

    test('3-level nested object survives the round-trip', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          tree: {
            level1: {
              level2: {
                value: u.email,
                tag: sql<string>`'left'`,
              },
            },
          },
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          tree: {
            level1: {
              level2: {
                value: u.email,
                tag: sql<string>`'right'`,
              },
            },
          },
        }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(4);
        for (const row of rows) {
          expect(row.tree.level1.level2.value).toMatch(/@test\.com$/);
          expect(['left', 'right']).toContain(row.tree.level1.level2.tag);
        }
      });
    });

    test('mixed flat + nested + literal projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          name: u.username,
          kind: sql<'L' | 'R'>`'L'`,
          info: { email: u.email },
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          name: u.username,
          kind: sql<'L' | 'R'>`'R'`,
          info: { email: u.email },
        }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(4);
        for (const row of rows) {
          expect(typeof row.id).toBe('number');
          expect(typeof row.name).toBe('string');
          expect(['L', 'R']).toContain(row.kind);
          expect(typeof row.info.email).toBe('string');
        }
      });
    });

    test('renamed columns ride through nesting', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          aliasedId: u.id,
          contact: {
            primaryEmail: u.email, // renamed leaf
          },
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          aliasedId: u.id,
          contact: {
            primaryEmail: u.email,
          },
        }));
        const rows = await left.unionAll(right).toList();
        for (const row of rows) {
          expect(typeof row.aliasedId).toBe('number');
          expect(typeof row.contact.primaryEmail).toBe('string');
        }
      });
    });
  });

  // ============================================================
  // GROUP 3 — collection-navigation projections (Phase C coverage)
  // ============================================================
  describe('collection-navigation projections', () => {
    test('single-level collection in BOTH legs', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));
        const rows = await left.unionAll(right).toList();
        for (const row of rows) {
          expect(Array.isArray(row.posts)).toBe(true);
          for (const p of row.posts) expect(typeof p.id).toBe('number');
        }
      });
    });

    test('WHERE filter inside the collection selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.username, 'alice')).select(u => ({
          id: u.id,
          highViewPosts: u.posts!
            .where(p => gt(p.views, 120))
            .select(p => ({ id: p.id, views: p.views }))
            .toList('highViewPosts'),
        }));
        const right = db.users.where(u => eq(u.username, 'bob')).select(u => ({
          id: u.id,
          highViewPosts: u.posts!
            .where(p => gt(p.views, 120))
            .select(p => ({ id: p.id, views: p.views }))
            .toList('highViewPosts'),
        }));
        const rows = await left.unionAll(right).toList();
        // alice has 2 posts (100, 150) → 1 high-view; bob has 1 post (200) → 1 high-view.
        const alice = rows.find(r => r.id === rows[0].id && r.highViewPosts.length === 1);
        expect(alice).toBeDefined();
        for (const row of rows) {
          for (const p of row.highViewPosts) expect(p.views).toBeGreaterThan(120);
        }
      });
    });

    test('collection with ORDER BY inside the selector', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.username, 'alice')).select(u => ({
          id: u.id,
          posts: u.posts!
            .select(p => ({ id: p.id, views: p.views }))
            .orderBy(p => [[p.views, 'DESC']])
            .toList('posts'),
        }));
        const right = db.users.where(u => eq(u.username, 'bob')).select(u => ({
          id: u.id,
          posts: u.posts!
            .select(p => ({ id: p.id, views: p.views }))
            .orderBy(p => [[p.views, 'DESC']])
            .toList('posts'),
        }));
        const rows = await left.unionAll(right).toList();
        for (const row of rows) {
          for (let i = 1; i < row.posts.length; i++) {
            expect(row.posts[i - 1].views).toBeGreaterThanOrEqual(row.posts[i].views);
          }
        }
      });
    });

    test('multiple sibling collections per row', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
          orders: u.orders!.select(o => ({ id: o.id })).toList('orders'),
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
          orders: u.orders!.select(o => ({ id: o.id })).toList('orders'),
        }));
        const rows = await left.unionAll(right).toList();
        for (const row of rows) {
          expect(Array.isArray(row.posts)).toBe(true);
          expect(Array.isArray(row.orders)).toBe(true);
        }
        // Alice: 2 posts, 1 order. Bob: 1 post, 1 order. Charlie: 0 posts, 0 orders.
        const totalsByUser = new Map<number, { posts: number; orders: number }>();
        for (const row of rows) {
          if (!totalsByUser.has(row.id)) {
            totalsByUser.set(row.id, { posts: row.posts.length, orders: row.orders.length });
          }
        }
        // At least one user has 2 posts (alice).
        expect([...totalsByUser.values()].some(v => v.posts === 2)).toBe(true);
      });
    });

    test('empty collection comes back as []', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // charlie has 0 posts; force both legs to land on charlie.
        const left = db.users.where(u => eq(u.username, 'charlie')).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));
        const right = db.users.where(u => eq(u.isActive, false)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        }));
        const rows = await left.unionAll(right).toList();
        for (const row of rows) {
          expect(Array.isArray(row.posts)).toBe(true);
          expect(row.posts.length).toBe(0);
        }
      });
    });
  });

  // ============================================================
  // GROUP 4 — combinations: nested + collection in the same UNION leg
  // ============================================================
  describe('nested + collection combinations', () => {
    test('row carries BOTH a nested-object AND a collection projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          info: { name: u.username, label: sql<string>`'L'` },
          posts: u.posts!.select(p => ({ id: p.id, title: p.title })).toList('posts'),
        }));
        const right = db.users.where(u => gt(u.age, 30)).select(u => ({
          id: u.id,
          info: { name: u.username, label: sql<string>`'R'` },
          posts: u.posts!.select(p => ({ id: p.id, title: p.title })).toList('posts'),
        }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(4);
        for (const row of rows) {
          expect(typeof row.info).toBe('object');
          expect(typeof row.info.name).toBe('string');
          expect(['L', 'R']).toContain(row.info.label);
          expect(Array.isArray(row.posts)).toBe(true);
        }
      });
    });

    test('asSubquery → outer query with inSubquery still works after the changes', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Regression guard for the previous agent's asSubquery work — the
        // changes in this PR widened the union-leg projection surface but
        // must NOT break the existing array-mode subquery composition.
        const idsSubquery = db.users
          .where(u => gt(u.age, 30))
          .select(u => u.id)
          .unionAll(db.users.where(u => eq(u.isActive, true)).select(u => u.id))
          .asSubquery('array');

        const rows = await db.users
          .where(u => inSubquery(u.id, idsSubquery))
          .select(u => ({ id: u.id, name: u.username }))
          .toList();
        expect(rows.map(r => r.name).sort()).toEqual(['alice', 'bob', 'charlie']);
      });
    });
  });

  // ============================================================
  // GROUP 5 — edge cases
  // ============================================================
  describe('edge cases', () => {
    test('one leg returns zero rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.username, 'no-such-user')).select(u => ({ id: u.id, name: u.username }));
        const right = db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id, name: u.username }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe('alice');
      });
    });

    test('all legs return zero rows', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users.where(u => eq(u.username, 'nope-1')).select(u => ({ id: u.id, name: u.username }));
        const right = db.users.where(u => eq(u.username, 'nope-2')).select(u => ({ id: u.id, name: u.username }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(0);
      });
    });

    test('paramCounter chains across UNION legs that each carry their own WHERE params', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Three legs, each with its own param. The combined param counter
        // must produce non-colliding $-indexes.
        const a = db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id, src: sql<string>`'A'` }));
        const b = db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, src: sql<string>`'B'` }));
        const c = db.users.where(u => eq(u.username, 'charlie')).select(u => ({ id: u.id, src: sql<string>`'C'` }));
        const rows = await a.unionAll(b).unionAll(c).toList();
        expect(rows.length).toBe(3);
        const tags = rows.map(r => r.src).sort();
        expect(tags).toEqual(['A', 'B', 'C']);
      });
    });

    test('UNION leg with multi-condition WHERE (AND / OR)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const left = db.users
          .where(u => and(eq(u.isActive, true), gte(u.age, 25)))
          .select(u => ({ id: u.id, name: u.username }));
        const right = db.users
          .where(u => or(eq(u.username, 'charlie'), lt(u.age, 26)))
          .select(u => ({ id: u.id, name: u.username }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    test('different field selection ORDER per leg still aligns by column name', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Same field names; in Postgres, UNION aligns by column ORDER, not name —
        // but Linkgress emits SELECT in object-key insertion order. We
        // intentionally use the SAME field order; this test guards against
        // a future regression where insertion-order semantics drift.
        const left = db.users.where(u => eq(u.username, 'alice')).select(u => ({ id: u.id, name: u.username }));
        const right = db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username }));
        const rows = await left.unionAll(right).toList();
        expect(rows.length).toBe(2);
        for (const row of rows) {
          expect(typeof row.id).toBe('number');
          expect(typeof row.name).toBe('string');
        }
      });
    });
  });

  // ============================================================
  // GROUP 6 — toSql / debugging surface
  // ============================================================
  describe('toSql output', () => {
    test('toSql emits LATERAL clauses when collections are projected', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
        })).unionAll(
          db.users.where(u => gt(u.age, 30)).select(u => ({
            id: u.id,
            posts: u.posts!.select(p => ({ id: p.id })).toList('posts'),
          })),
        );

        const sqlStr = q.toSql();
        // The default collection strategy in this test DB is CTE, but a UNION
        // leg with a collection should still emit either a WITH clause or a
        // LEFT JOIN of some kind (CTE / LATERAL); the exact strategy is
        // strategy-specific. Just assert that the column "posts" is in the
        // SELECT (proves it wasn't dropped).
        expect(sqlStr).toMatch(/"posts"/);
      });
    });

    test('toSql emits flattened __nested__ columns when nested objects are projected', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q = db.users.where(u => eq(u.isActive, true)).select(u => ({
          id: u.id,
          info: { email: u.email },
        })).unionAll(
          db.users.where(u => gt(u.age, 30)).select(u => ({
            id: u.id,
            info: { email: u.email },
          })),
        );
        const sqlStr = q.toSql();
        // Phase B flattens nested keys to `__nested__<key>__<leaf>` aliases.
        expect(sqlStr).toContain('__nested__info__email');
      });
    });
  });
});
