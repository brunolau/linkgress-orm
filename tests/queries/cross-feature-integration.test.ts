import { describe, test, expect } from 'bun:test';
import {
  add, agg, and, castAsInt, coalesce, DbCteBuilder, eq, eqAnySubquery, fromSet, gt, inArray, inSubquery, literal, lt, lte,
  MutationBatch, ne, param, unnest, unnestZip,
} from '../../src';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * The 1.0.9 features in the combinations real callers build them in: aliased scopes carrying aggregate fragments,
 * set-returning sources read as scalar expressions, a statement-level data-modifying CTE read from WHERE and
 * SELECT, bound parameters inside scopes. Each lane tested its own feature alone; this file pins the seams.
 *
 * Seed (tests/utils/test-database.ts): users alice (25), bob (35), charlie (45, inactive); posts alice 100 + 150
 * views, bob 200; orders alice 'completed' 99.99, bob 'pending' 149.99.
 */
describe('1.0.9 cross-feature integration', () => {
  test('an aliased-scope scalar of FILTERed aggregates, correlated to the outer row', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const rows = await db.users
        .select(u => ({
          username: u.username,
          mixed: db.posts.as('p2')
            .where(p2 => eq(p2.userId, u.id))
            .scalar(p2 => castAsInt(add(
              agg.count().filter(gt(p2.views, 120)),
              agg.countDistinct(p2.title).filter(lte(p2.views, 120)),
            ))),
        }))
        .orderBy(u => u.username)
        .toList();

      // alice: 1 post > 120 + 1 distinct title ≤ 120; bob: 1 + 0; charlie: no rows → count 0 + 0
      expect(rows).toEqual([
        { username: 'alice', mixed: 2 },
        { username: 'bob', mixed: 1 },
        { username: 'charlie', mixed: 0 },
      ]);
    });
  });

  test('agg.jsonAgg ORDER BY inside a scope scalar, under coalesce with an empty-array literal', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const rows = await db.users
        .select(u => ({
          username: u.username,
          views: coalesce(
            db.posts.as('p3').where(p3 => eq(p3.userId, u.id)).scalar(p3 => agg.jsonAgg(p3.views, { orderBy: [[p3.views, 'DESC']] })),
            literal('[]', 'json'),
          ),
        }))
        .orderBy(u => u.username)
        .toList();

      expect(rows).toEqual([
        { username: 'alice', views: [150, 100] },
        { username: 'bob', views: [200] },
        { username: 'charlie', views: [] },
      ] as any);
    });
  });

  test('a scope with a bound param() keeps one statement text for a null and a non-null value', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const build = (minViews: number | null) => db.users
        .select(u => ({
          username: u.username,
          hits: db.posts.as('p4')
            .where(p4 => eq(p4.userId, u.id))
            .where(p4 => gt(p4.views, coalesce(param(minViews, 'integer'), literal(0))))
            .scalar(() => castAsInt(agg.count())),
        }))
        .orderBy(u => u.username);

      const rendered = (minViews: number | null) => {
        const ctx = { paramCounter: 1, params: [] as unknown[] };
        const text = build(minViews).asSubquery('table').buildSql(ctx);

        return { text, params: ctx.params };
      };

      const nullRender = rendered(null);
      const valueRender = rendered(120);
      expect(nullRender.text).toBe(valueRender.text);
      expect(nullRender.text).toContain('COALESCE(CAST($1 AS integer), 0)');
      expect(nullRender.params).toEqual([null]);
      expect(valueRender.params).toEqual([120]);

      const withNull = await build(null).toList();
      const with120 = await build(120).toList();
      expect(withNull.map(r => r.hits)).toEqual([2, 1, 0]);
      expect(with120.map(r => r.hits)).toEqual([1, 1, 0]);
    });
  });

  test('fromSet(unnestZip(...)) as a correlated scalar expression in an UPDATE SET', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const bumps = unnestZip<{ id: number; bump: number }>({
        id: { values: [users.alice.id, users.bob.id], type: 'integer' },
        bump: { values: [10, 20], type: 'integer' },
      });

      const affected = await db.users
        .where(u => inSubquery(u.id, fromSet(bumps, 't').select(t => t.id).asSubquery('array')))
        .update(u => ({
          age: fromSet(bumps, 't')
            .where(t => eq(t.id, u.id))
            .select(t => add(u.age, t.bump))
            .asSubquery('scalar')
            .asExpression<number>(),
        }))
        .affectedCount();

      expect(affected).toBe(2);

      const ages = await db.users.select(u => ({ username: u.username, age: u.age })).orderBy(u => u.username).toList();
      expect(ages).toEqual([
        { username: 'alice', age: 35 },
        { username: 'bob', age: 55 },
        { username: 'charlie', age: 45 },
      ]);
    });
  });

  test('eqAnySubquery over a fromSet(unnest(...)) array subquery', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const ids = fromSet(unnest([users.alice.id, users.charlie.id], 'integer'), 'ids').select(r => r.value).asSubquery('array');
      const rows = await db.users.where(u => eqAnySubquery(u.id, ids)).select(u => u.username).orderBy(u => u).toList();

      expect(rows).toEqual(['alice', 'charlie']);
    });
  });

  test('an asExpression() subquery reading a navigation of the outer row gets that join', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const rows = await db.posts
        .select(p => ({
          title: p.title,
          authorEmail: db.users.where(u => eq(u.id, p.user!.id)).select(u => u.email).asSubquery('scalar').asExpression<string>(),
        }))
        .orderBy(p => p.title)
        .toList();

      expect(rows).toEqual([
        { title: 'Alice Post 1', authorEmail: 'alice@test.com' },
        { title: 'Alice Post 2', authorEmail: 'alice@test.com' },
        { title: 'Bob Post', authorEmail: 'bob@test.com' },
      ]);
    });
  });

  test('a typed MutationBatch rowGuard built from an aliased-scope aggregate admits each candidate on its own count', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);
      const newPost = (userId: number, title: string) => ({ title, content: 'x', userId, views: 1, publishTime: { hour: 8, minute: 0 } });

      const batch = new MutationBatch();
      batch.addInsertBulk(db.posts, [
        newPost(users.alice.id, 'A3'),
        newPost(users.bob.id, 'B2'),
        newPost(users.charlie.id, 'C1'),
      ], 'capped', {
        // "at most two posts per user": alice already has two — blocked; bob (1) and charlie (0) pass
        rowGuard: v => lt(db.posts.as('gp').where(gp => eq(gp.userId, v.userId)).scalar(() => castAsInt(agg.count())), 2),
      });
      batch.addInsertBulk(db.posts, [
        newPost(users.alice.id, 'Alice Post 1'),
        newPost(users.alice.id, 'Alice Post 3'),
      ], 'unique', {
        // the NOT EXISTS shape: a title the user already has is refused
        rowGuard: v => db.posts.as('dup').where(dup => and(eq(dup.userId, v.userId), eq(dup.title, v.title))).notExists(),
      });

      await batch.executeBatch();

      expect(batch.getAffectedCount('capped')).toBe(2);
      expect(batch.getAffectedCount('unique')).toBe(1);

      const titles = await db.posts
        .where(p => inArray(p.title, ['A3', 'B2', 'C1', 'Alice Post 3']))
        .select(p => p.title)
        .orderBy(t => t)
        .toList();
      expect(titles).toEqual(['Alice Post 3', 'B2', 'C1']);
    });
  });

  test('a statement-level data-modifying CTE gates the load (WHERE) and exposes its RETURNING value (SELECT)', async () => {
    await withDatabase(async (db) => {
      const { orders } = await seedTestData(db);

      const casStatement = db.orders
        .where(o => and(eq(o.id, orders.aliceOrder.id), ne(o.status, 'refunded')))
        .update({ status: 'refunded' })
        .toStatement(o => ({ id: o.id, status: o.status }));
      const gate = new DbCteBuilder().withMutation('refund_gate', casStatement).cte;

      const loaded = await db.orders
        .where(o => inSubquery(o.id, db.selectFromCte(gate).select(g => g.id).asSubquery('array')))
        .with(gate)
        .select(o => ({
          id: o.id,
          statusBefore: o.status,
          statusAfter: db.selectFromCte(gate).select(g => g.status).asSubquery('scalar').asExpression<string>(),
        }))
        .toList();

      // the table read keeps the PRE-update snapshot; the CTE's RETURNING carries the new value; the UPDATE ran once
      expect(loaded).toEqual([{ id: orders.aliceOrder.id, statusBefore: 'completed', statusAfter: 'refunded' }]);

      const after = await db.orders.where(o => eq(o.id, orders.aliceOrder.id)).select(o => o.status).toList();
      expect(after).toEqual(['refunded']);

      // the CAS lost: a second run loads nothing
      const again = await db.orders
        .where(o => inSubquery(o.id, db.selectFromCte(gate).select(g => g.id).asSubquery('array')))
        .with(gate)
        .select(o => ({ id: o.id }))
        .toList();
      expect(again).toEqual([]);
    });
  });
});

