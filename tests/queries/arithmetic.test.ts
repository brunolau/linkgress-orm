import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getSharedDatabase, setupDatabase, cleanupDatabase, seedTestData } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { add, sub, mul, div, coalesce, eq, lt, sql, SqlFragment } from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';

/**
 * Tests for the arithmetic combinators (add / sub / mul / div).
 *
 * The emitted SQL is always parenthesised so operators of different precedence
 * nest safely, and literals bind as parameters instead of being inlined.
 */
describe('Arithmetic operators', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  // Simulate FieldRefs (what p.views / p.userId would be at runtime)
  const views = {
    __dbColumnName: 'views',
    __fieldName: 'views',
    __tableAlias: 'posts',
  } as any;

  const userId = {
    __dbColumnName: 'user_id',
    __fieldName: 'userId',
    __tableAlias: 'posts',
  } as any;

  describe('emitted SQL', () => {
    test('add emits a parenthesised sum of column and literal', () => {
      const ctx = makeContext();

      expect(add(views, 5).buildSql(ctx)).toBe('("posts"."views" + $1)');
      expect(ctx.params).toEqual([5]);
    });

    test('sub emits a parenthesised difference of two columns', () => {
      const ctx = makeContext();

      expect(sub(views, userId).buildSql(ctx)).toBe('("posts"."views" - "posts"."user_id")');
      expect(ctx.params).toEqual([]);
    });

    test('mul emits a parenthesised product of column and literal', () => {
      const ctx = makeContext();

      expect(mul(views, 2).buildSql(ctx)).toBe('("posts"."views" * $1)');
      expect(ctx.params).toEqual([2]);
    });

    test('div emits a parenthesised quotient of column and literal', () => {
      const ctx = makeContext();

      expect(div(views, 10).buildSql(ctx)).toBe('("posts"."views" / $1)');
      expect(ctx.params).toEqual([10]);
    });

    test('add is variadic across three operands', () => {
      const ctx = makeContext();

      expect(add(views, userId, 7).buildSql(ctx)).toBe('("posts"."views" + "posts"."user_id" + $1)');
      expect(ctx.params).toEqual([7]);
    });

    test('mul is variadic across three operands', () => {
      const ctx = makeContext();

      expect(mul(views, userId, 3).buildSql(ctx)).toBe('("posts"."views" * "posts"."user_id" * $1)');
      expect(ctx.params).toEqual([3]);
    });

    test('accepts a SqlFragment as an operand', () => {
      const ctx = makeContext();
      const fragment = new SqlFragment(['', '::numeric'], [views]);

      expect(add(fragment, 1.5).buildSql(ctx)).toBe('("posts"."views"::numeric + $1)');
      expect(ctx.params).toEqual([1.5]);
    });

    test('nests with correct parentheses so precedence is explicit', () => {
      const ctx = makeContext();

      expect(add(views, mul(userId, 3)).buildSql(ctx)).toBe('("posts"."views" + ("posts"."user_id" * $1))');
      expect(ctx.params).toEqual([3]);
    });

    test('sub and div nest explicitly for left-associative chains', () => {
      const ctx = makeContext();

      expect(div(sub(views, 10), 2).buildSql(ctx)).toBe('(("posts"."views" - $1) / $2)');
      expect(ctx.params).toEqual([10, 2]);
    });

    test('composes with coalesce for null-safe operands', () => {
      const ctx = makeContext();

      expect(add(views, coalesce(userId, 0)).buildSql(ctx)).toBe('("posts"."views" + COALESCE("posts"."user_id", $1))');
      expect(ctx.params).toEqual([0]);
    });

    test('works as the left-hand operand of a comparison', () => {
      const ctx = makeContext();

      expect(lt(add(views, 1), 100).buildSql(ctx)).toBe('("posts"."views" + $1) < $2');
      expect(ctx.params).toEqual([1, 100]);
    });

    test('works on both sides of a comparison', () => {
      const ctx = makeContext();
      // Note: WhereComparisonBase.getRightSide() binds any SqlFragment value as a
      // parameter rather than inlining its SQL — a pre-existing limitation shared
      // with coalesce and raw sql`` fragments. Build the whole comparison as a
      // fragment when both sides are expressions.
      const comparison = sql`${add(views, 1)} < ${mul(userId, 2)}`;

      expect(comparison.buildSql(ctx)).toBe('("posts"."views" + $1) < ("posts"."user_id" * $2)');
      expect(ctx.params).toEqual([1, 2]);
    });

    test('binds literals as parameters instead of inlining them', () => {
      const ctx = makeContext();
      const built = add(views, 41, 1).buildSql(ctx);

      expect(built).toBe('("posts"."views" + $1 + $2)');
      expect(built).not.toContain('41');
      expect(ctx.params).toEqual([41, 1]);
    });

    test('applies the operand mapper to literal values (same as coalesce)', () => {
      const mapper = {
        toDriver: (value: Date) => value.getTime(),
        fromDriver: (value: number) => new Date(value),
      };
      const mappedColumn = {
        __dbColumnName: 'start_at',
        __fieldName: 'startAt',
        __tableAlias: 'events',
        __mapper: mapper,
      } as any;
      const literal = new Date('2026-07-07T00:00:00.000Z');
      const ctx = makeContext();

      expect(sub(mappedColumn, literal).buildSql(ctx)).toBe('("events"."start_at" - $1)');
      expect(ctx.params).toEqual([literal.getTime()]);
    });
  });

  describe('in queries', () => {
    let db: AppDatabase;

    beforeAll(async () => {
      db = getSharedDatabase();
      await setupDatabase(db);
      await seedTestData(db);
    });

    afterAll(async () => {
      await cleanupDatabase(db);
    });

    test('should compute arithmetic in select', async () => {
      const results = await db.posts
        .select(p => ({
          id: p.id,
          views: p.views,
          doubled: mul(p.views, 2),
          plusTen: add(p.views, 10),
          minusOne: sub(p.views, 1),
          halved: div(p.views, 2),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.doubled).toBe(r.views! * 2);
        expect(r.plusTen).toBe(r.views! + 10);
        expect(r.minusOne).toBe(r.views! - 1);
        expect(r.halved).toBe(Math.trunc(r.views! / 2));
      });
    });

    test('should nest arithmetic with correct precedence in select', async () => {
      const results = await db.posts
        .select(p => ({
          views: p.views,
          // (views + (views * 2)) — NOT ((views + views) * 2)
          nested: add(p.views, mul(p.views, 2)),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.nested).toBe(r.views! + r.views! * 2);
      });
    });

    test('should compose with coalesce over a nullable column', async () => {
      await db.users.insert({
        username: 'arith_null_age',
        email: 'arith_null_age@test.com',
        isActive: true,
      });

      const results = await db.users
        .where(u => eq(u.username, 'arith_null_age'))
        .select(u => ({
          // age is NULL — coalesce keeps the sum defined
          total: add(100, coalesce(u.age, 0)),
        }))
        .toList();

      expect(results.length).toBe(1);
      expect(results[0].total).toBe(100);
    });

    test('should be usable as a comparison operand in where', async () => {
      const results = await db.posts
        .where(p => lt(mul(p.views, 2), 300))
        .select(p => ({
          id: p.id,
          views: p.views,
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.views! * 2).toBeLessThan(300);
      });
    });

    test('should conditionally increment a counter in update', async () => {
      const post = (await db.posts.toList())[0];
      const before = post.views!;

      await db.posts
        .where(p => eq(p.id, post.id))
        .update(p => ({ views: add(p.views, 5) }));

      const after = await db.posts.where(p => eq(p.id, post.id)).firstOrDefault();

      expect(after!.views).toBe(before + 5);
    });

    test('should decrement a counter in update', async () => {
      const post = (await db.posts.toList())[0];
      const before = post.views!;

      await db.posts
        .where(p => eq(p.id, post.id))
        .update(p => ({ views: sub(p.views, 3) }));

      const after = await db.posts.where(p => eq(p.id, post.id)).firstOrDefault();

      expect(after!.views).toBe(before - 3);
    });

    test('should emit parenthesised SQL in the executed update statement', async () => {
      const post = (await db.posts.toList())[0];

      const queries: string[] = [];
      const client = (db as any).client;
      const originalQuery = client.query.bind(client);
      client.query = async (sqlText: string, params: any[]) => {
        queries.push(sqlText);

        return originalQuery(sqlText, params);
      };

      try {
        await db.posts
          .where(p => eq(p.id, post.id))
          .update(p => ({ views: add(p.views, mul(p.views, 0)) }));
      } finally {
        client.query = originalQuery;
      }

      const updateSql = queries.find(q => q.startsWith('UPDATE'));

      expect(updateSql).toBeDefined();
      expect(updateSql).toContain('("posts"."views" + ("posts"."views" * $1))');
    });

    test('should keep NULL semantics — NULL + 1 stays NULL', async () => {
      await db.users.insert({
        username: 'arith_null_semantics',
        email: 'arith_null_semantics@test.com',
        isActive: true,
      });

      const results = await db.users
        .where(u => eq(u.username, 'arith_null_semantics'))
        .select(u => ({
          bumped: add(u.age, 1),
        }))
        .toList();

      expect(results.length).toBe(1);
      // NULL + 1 is NULL in SQL — these helpers compose with coalesce, they do
      // not replace it. (The materialiser surfaces a NULL column as undefined.)
      expect(results[0].bumped == null).toBe(true);
    });

    test('should still allow the raw sql template for the same expression', async () => {
      const results = await db.posts
        .select(p => ({
          viaHelper: add(p.views, 1),
          viaRawSql: sql<number>`(${p.views} + 1)`,
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.viaHelper).toBe(r.viaRawSql);
      });
    });
  });
});
