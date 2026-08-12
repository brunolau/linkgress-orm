import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { DbCteBuilder, QueryBatch, eq, gt } from '../../src';

// The candidate-CTE read shape: a (deduplicating) UNION of cheap id-only legs
// fenced as a MATERIALIZED CTE, inner-joined back to the entity purely as a row
// filter (selection shape preserved). Born from a production tickets read where
// this exact composition kept a 122M-row join plannable: the fence forces
// "candidates first", the join carries the full projection per candidate.
//
// Covers three additions:
//   1. `UnionQueryBuilder` as a CTE body (param chaining through the outer
//      context included),
//   2. `DbCteBuilder.with(..., { materialized: true })` emitting
//      `AS MATERIALIZED`,
//   3. `joinFilter` accepting a `DbCte` (auto-attaching it when the caller did
//      not `.with()` it explicitly).
describe('Union CTE + materialized fence + joinFilter(cte)', () => {
  test('a UNION query is usable as a CTE body and joinFilter keeps the selection shape', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      // Overlapping legs — bob is active AND older than 30, so a UNION ALL
      // would emit him twice; the deduplicating UNION must not.
      const candidates = cteBuilder.with('candidate_users', db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({ id: u.id }))
        .union(db.users
          .where(u => gt(u.age, 30))
          .select(u => ({ id: u.id }))), { materialized: true });

      const rows = await db.users
        .select(u => ({ id: u.id, username: u.username }))
        .with(candidates.cte)
        .joinFilter(candidates.cte, (row, c) => eq(row.id, c.id))
        .toList();

      // Selection shape preserved: exactly the projected columns.
      expect(Object.keys(rows[0]).sort()).toEqual(['id', 'username']);

      // Every candidate exactly once (UNION dedupe + PK join).
      const ids = rows.map(r => r.id);
      expect(ids.length).toBe(new Set(ids).size);
      const names = rows.map(r => r.username).sort();
      expect(names).toContain('bob');
      expect(names.filter(n => n === 'bob')).toHaveLength(1);
      expect(rows.length).toBeGreaterThanOrEqual(3); // alice + bob + charlie at minimum
    });
  });

  test('materialized: true emits AS MATERIALIZED; the default stays unfenced', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const build = (materialized: boolean) => {
        const cteBuilder = new DbCteBuilder();
        const candidates = cteBuilder.with('cand_emit', db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id }))
          .union(db.users
            .where(u => gt(u.age, 30))
            .select(u => ({ id: u.id }))), materialized ? { materialized: true } : undefined);

        return db.users
          .select(u => ({ id: u.id }))
          .with(candidates.cte)
          .joinFilter(candidates.cte, (row, c) => eq(row.id, c.id))
          .future() as unknown as { _sql: string };
      };

      expect(build(true)._sql).toContain('"cand_emit" AS MATERIALIZED (');
      expect(build(false)._sql).toContain('"cand_emit" AS (');
      expect(build(false)._sql).not.toContain('MATERIALIZED');
    });
  });

  test('joinFilter(cte) auto-attaches a CTE the caller did not .with()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const candidates = cteBuilder.with('cand_auto', db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({ id: u.id })), { materialized: true });

      const rows = await db.users
        .select(u => ({ id: u.id, username: u.username }))
        .joinFilter(candidates.cte, (row, c) => eq(row.id, c.id))
        .toList();

      expect(rows.length).toBeGreaterThan(0);
      expect(Object.keys(rows[0]).sort()).toEqual(['id', 'username']);
    });
  });

  test('the composed query rides a QueryBatch round trip', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const candidates = cteBuilder.with('cand_batch', db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({ id: u.id }))
        .union(db.users
          .where(u => gt(u.age, 30))
          .select(u => ({ id: u.id }))), { materialized: true });

      const query = db.users
        .select(u => ({ id: u.id, username: u.username }))
        .with(candidates.cte)
        .joinFilter(candidates.cte, (row, c) => eq(row.id, c.id));

      const standalone = await db.users
        .select(u => ({ id: u.id, username: u.username }))
        .with(candidates.cte)
        .joinFilter(candidates.cte, (row, c) => eq(row.id, c.id))
        .toList();

      const batch = new QueryBatch();
      const key = batch.addList(query, 'cte-union:candidates');
      await batch.executeBatch();
      const batched = batch.getList(key);

      const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
      expect([...batched].sort(byId)).toEqual([...standalone].sort(byId));
    });
  });
});
