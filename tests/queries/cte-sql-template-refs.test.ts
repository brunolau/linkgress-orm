import { describe, test, expect } from '@jest/globals';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { withDatabase, seedTestData, createTestDatabase } from '../utils/test-database';
import { gt, sql, DbCteBuilder } from '../../src';

/**
 * DbCte.as(alias?) — typed CTE references for raw sql`` templates.
 *
 * Motivation (gopass-eshop internalProductDataProvider): a correlated scalar
 * subquery over a CTE had to hard-code every identifier as a string literal:
 *
 *   sql`(SELECT ... json_build_array("gp"."seasonId", ...) FROM "product_price_grouped_cte" AS "gp" WHERE "gp"."productIdOfPrice" = ${product.id})`
 *
 * `${entityQuery.column}` interpolation already renders as a qualified
 * identifier (FieldRef support in SqlFragment.buildSql), but there was no way
 * to obtain such references for CTE columns, nor to interpolate the CTE itself
 * into a FROM clause. `cte.as('gp')` provides both:
 *   - `${ref.column}`  -> `"gp"."column"`
 *   - `${ref}`         -> `"cte_name" AS "gp"` (or `"cte_name"` when unaliased)
 */
describe('CTE references in sql`` templates (DbCte.as)', () => {
  const buildPostStatsCte = (db: AppDatabase, cteBuilder: DbCteBuilder) =>
    cteBuilder.with(
      'post_stats',
      db.posts.select(p => ({
        postId: p.id,
        postViews: p.views,
        postUserId: p.userId,
      }))
    );

  describe('SQL rendering', () => {
    test('renders aliased column refs and the FROM table ref', () => {
      const db = createTestDatabase();
      const cteBuilder = new DbCteBuilder();
      const postStats = buildPostStatsCte(db, cteBuilder);

      const ps = postStats.cte.as('ps');
      const fragment = sql`SELECT ${ps.postViews} FROM ${ps} WHERE ${ps.postUserId} = ${42}`;
      const context = { paramCounter: 1, params: [] as any[] };

      expect(fragment.buildSql(context)).toBe('SELECT "ps"."postViews" FROM "post_stats" AS "ps" WHERE "ps"."postUserId" = $1');
      expect(context.params).toEqual([42]);
    });

    test('renders unaliased refs qualified by the CTE name', () => {
      const db = createTestDatabase();
      const cteBuilder = new DbCteBuilder();
      const postStats = buildPostStatsCte(db, cteBuilder);

      const ps = postStats.cte.as();
      const fragment = sql`SELECT ${ps.postViews} FROM ${ps} WHERE ${ps.postUserId} = ${42}`;
      const context = { paramCounter: 1, params: [] as any[] };

      expect(fragment.buildSql(context)).toBe('SELECT "post_stats"."postViews" FROM "post_stats" WHERE "post_stats"."postUserId" = $1');
      expect(context.params).toEqual([42]);
    });

    test('renders the correlated json_build_array aggregate byte-identically to hand-written SQL', () => {
      const db = createTestDatabase();
      const cteBuilder = new DbCteBuilder();
      const postStats = buildPostStatsCte(db, cteBuilder);

      const gp = postStats.cte.as('gp');
      const fragment = sql`(SELECT COALESCE(json_agg(json_build_array(${gp.postId}, ${gp.postViews}) ORDER BY ${gp.postViews} ASC, ${gp.postId} ASC), '[]'::json) FROM ${gp} WHERE ${gp.postUserId} = ${7})`;
      const context = { paramCounter: 1, params: [] as any[] };

      expect(fragment.buildSql(context)).toBe(
        '(SELECT COALESCE(json_agg(json_build_array("gp"."postId", "gp"."postViews") ORDER BY "gp"."postViews" ASC, "gp"."postId" ASC), \'[]\'::json) FROM "post_stats" AS "gp" WHERE "gp"."postUserId" = $1)'
      );
      expect(context.params).toEqual([7]);
    });

    test('table ref is not mistaken for a FieldRef or bound as a parameter', () => {
      const db = createTestDatabase();
      const cteBuilder = new DbCteBuilder();
      const postStats = buildPostStatsCte(db, cteBuilder);

      const ps = postStats.cte.as('ps');
      const fragment = sql`SELECT COUNT(*) FROM ${ps}`;
      const context = { paramCounter: 1, params: [] as any[] };

      expect(fragment.buildSql(context)).toBe('SELECT COUNT(*) FROM "post_stats" AS "ps"');
      expect(context.params).toEqual([]);
    });
  });

  describe('query execution', () => {
    test('correlated scalar subquery over an aliased CTE with mapWith', async () => {
      await withDatabase(async (db) => {
        const { posts } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const postStats = buildPostStatsCte(db, cteBuilder);
        const ps = postStats.cte.as('ps');

        const result = await db.users
          .with(...cteBuilder.getCtes())
          .select(u => ({
            id: u.id,
            username: u.username,
            postTuples: sql<[number, number][]>`(SELECT COALESCE(json_agg(json_build_array(${ps.postId}, ${ps.postViews}) ORDER BY ${ps.postViews} DESC), '[]'::json) FROM ${ps} WHERE ${ps.postUserId} = ${u.id})`
              .mapWith((value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as [number, number][])
              .as('postTuples'),
          }))
          .toList();

        const alice = result.find(r => r.username === 'alice')!;
        const bob = result.find(r => r.username === 'bob')!;
        const charlie = result.find(r => r.username === 'charlie')!;

        expect(alice.postTuples).toEqual([
          [posts.alicePost2.id, 150],
          [posts.alicePost1.id, 100],
        ]);
        expect(bob.postTuples).toEqual([[posts.bobPost.id, 200]]);
        // Zero matching CTE rows must hit the COALESCE fallback, not NULL
        expect(charlie.postTuples).toEqual([]);
      });
    });

    test('parameter numbering survives CTE params + fragment literals + outer where params', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        // CTE carrying its own parameter ($1): only posts with > 50 views
        const postStats = cteBuilder.with(
          'post_stats',
          db.posts
            .where(p => gt(p.views, 50))
            .select(p => ({
              postId: p.id,
              postViews: p.views,
              postUserId: p.userId,
            }))
        );
        const ps = postStats.cte.as('ps');

        const result = await db.users
          .with(...cteBuilder.getCtes())
          .where(u => gt(u.age, 30))
          .select(u => ({
            id: u.id,
            username: u.username,
            bigPostCount: sql<number>`(SELECT COUNT(*) FROM ${ps} WHERE ${ps.postUserId} = ${u.id} AND ${ps.postViews} >= ${150})`
              .mapWith(Number)
              .as('bigPostCount'),
          }))
          .toList();

        expect(result).toHaveLength(2);

        const bob = result.find(r => r.username === 'bob')!;
        const charlie = result.find(r => r.username === 'charlie')!;

        expect(bob.id).toBe(users.bob.id);
        expect(bob.bigPostCount).toBe(1);
        expect(charlie.bigPostCount).toBe(0);
      });
    });
  });
});
