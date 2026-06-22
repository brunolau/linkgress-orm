import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getSharedDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { DbCteBuilder, eq, and, sql, onTrue } from '../../src';
import { assertType } from '../utils/type-tester';

/**
 * Bulletproof coverage for CTE-rooted queries: a query whose FROM root is a CTE
 * (not an entity table), supporting FULL OUTER / RIGHT / CROSS joins and
 * `ON TRUE` predicates between two CTEs.
 *
 * The marquee shape is the QA_AT-108 "buyer spend + current tier" read:
 *
 *   WITH spend AS (
 *     SELECT status, SUM(total) AS totalPrice FROM orders
 *     WHERE user_id = $1 AND status = $2 GROUP BY status
 *   ), current_tier AS (
 *     SELECT id AS currentTierId FROM users
 *     WHERE id = $3 AND is_active = $4 LIMIT 1
 *   )
 *   SELECT spend.status, spend.totalPrice, current_tier.currentTierId
 *   FROM spend FULL OUTER JOIN current_tier ON TRUE
 *
 * which must preserve all four FULL-OUTER-ON-TRUE cases:
 *   - spend + tier   (both sides present)
 *   - tier only      (spend columns NULL)
 *   - spend only     (tier column NULL)
 *   - neither        (zero rows)
 */
describe('CTE-rooted queries (FROM a CTE; FULL OUTER / RIGHT / CROSS joins)', () => {
  let db: AppDatabase;

  // ---- helpers --------------------------------------------------------------

  /** Build the QA_AT-108-shaped spend+tier query for one buyer. */
  const buildSpendTierQuery = (userId: number, tierActive: boolean) => {
    const b = new DbCteBuilder();
    const spend = b.with(
      'spend',
      db.orders
        .where(o => and(eq(o.userId, userId), eq(o.status, 'completed' as any)))
        .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
        .groupBy(o => ({ status: o.status }))
        .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) }))
    );
    const tier = b.with(
      'current_tier',
      db.users
        .where(u => and(eq(u.id, userId), eq(u.isActive, tierActive)))
        .select(u => ({ currentTierId: u.id }))
        .limit(1)
    );

    return db
      .selectFromCte(spend.cte)
      .fullOuterJoin(tier.cte, onTrue())
      .select((s, t) => ({
        status: s.status,
        totalPrice: s.totalPrice,
        currentTierId: t.currentTierId,
      }));
  };

  beforeAll(async () => {
    db = getSharedDatabase();
    await setupDatabase(db);

    // Deterministic fixture (independent of the shared seed) so spend math and
    // the four FULL-OUTER cases are exactly assertable.
    const [u1, u2, u3, u4] = await db.users
      .insertBulk([
        { username: 'fo_u1', email: 'fo_u1@test.com', age: 21, isActive: true },
        { username: 'fo_u2', email: 'fo_u2@test.com', age: 22, isActive: true },
        { username: 'fo_u3', email: 'fo_u3@test.com', age: 23, isActive: true },
        { username: 'fo_u4', email: 'fo_u4@test.com', age: 24, isActive: true },
      ])
      .returning();

    await db.orders.insertBulk([
      // u1: two completed + one pending (pending must be excluded) → SUM 15.00
      { userId: u1.id, status: 'completed', totalAmount: 10.5 },
      { userId: u1.id, status: 'completed', totalAmount: 4.5 },
      { userId: u1.id, status: 'pending', totalAmount: 999 },
      // u3: a single completed order → SUM 7.00 (used for the spend-only case)
      { userId: u3.id, status: 'completed', totalAmount: 7.0 },
      // u4: two statuses, both completed-ish across groups (multi-row spend)
      { userId: u4.id, status: 'completed', totalAmount: 3.25 },
      { userId: u4.id, status: 'completed', totalAmount: 6.75 },
    ]);

    (db as any).__fo = { u1, u2, u3, u4 };
  });

  afterAll(async () => {
    await cleanupDatabase(db);
  });

  // ---- generated SQL --------------------------------------------------------

  describe('generated SQL', () => {
    test('FULL OUTER JOIN ON TRUE between two CTEs (the QA_AT-108 shape)', () => {
      const q = buildSpendTierQuery(42, true);
      const { sql: text, params } = (q as any).buildQuery();

      // WITH both CTE bodies, then the FULL OUTER JOIN ON TRUE envelope.
      expect(text).toContain('WITH "spend" AS (');
      expect(text).toContain('"current_tier" AS (');
      expect(text).toContain('SUM("orders"."total_amount")');
      expect(text).toContain('GROUP BY "orders"."status"');
      expect(text).toContain('LIMIT 1');
      expect(text).toContain(
        'SELECT "spend"."status" as "status", "spend"."totalPrice" as "totalPrice", "current_tier"."currentTierId" as "currentTierId"'
      );
      expect(text).toContain('FROM "spend"');
      expect(text).toContain('FULL OUTER JOIN "current_tier" ON TRUE');

      // Params: spend body ($1 userId, $2 status), then current_tier body
      // ($3 userId, $4 is_active). ON TRUE contributes none.
      expect(params).toEqual([42, 'completed', 42, true]);
      // Placeholders are sequential $1..$4 in one statement.
      expect(text).toContain('"orders"."user_id" = $1');
      expect(text).toContain('"orders"."status" = $2');
      expect(text).toContain('"users"."id" = $3');
      expect(text).toContain('"users"."is_active" = $4');
      expect(text).not.toContain('$5');
    });

    test('parameters of every CTE body precede ON-predicate params, sequentially', () => {
      // Use an ON predicate that carries its OWN parameter, to prove ordering:
      // CTE-body params first ($1..$4), then the ON param ($5).
      const b = new DbCteBuilder();
      const spend = b.with(
        'spend',
        db.orders
          .where(o => and(eq(o.userId, 7), eq(o.status, 'completed' as any)))
          .select(o => ({ uid: o.userId, totalPrice: o.totalAmount }))
          .groupBy(o => ({ uid: o.uid }))
          .select(g => ({ uid: g.key.uid, totalPrice: g.sum(o => o.totalPrice) }))
      );
      const tier = b.with(
        'current_tier',
        db.users
          .where(u => and(eq(u.id, 7), eq(u.isActive, true)))
          .select(u => ({ tierUserId: u.id }))
          .limit(1)
      );

      const q = db
        .selectFromCte(spend.cte)
        .innerJoin(tier.cte, sql<boolean>`"spend"."uid" = "current_tier"."tierUserId" AND ${1} = ${1}`)
        .select((s, t) => ({ uid: s.uid, totalPrice: s.totalPrice, tierUserId: t.tierUserId }));

      const { sql: text, params } = (q as any).buildQuery();
      // 4 CTE-body params ($1..$4), then the two ON literals → $5, $6.
      expect(params).toEqual([7, 'completed', 7, true, 1, 1]);
      expect(text).toContain('AND $5 = $6');
      expect(text).toContain('INNER JOIN "current_tier" ON');
      // CTE-body placeholders precede the ON placeholders.
      expect(text.indexOf('$4')).toBeLessThan(text.indexOf('$5'));
    });

    test('each join keyword renders correctly', () => {
      const make = (kind: 'inner' | 'left' | 'right' | 'full' | 'cross') => {
        const b = new DbCteBuilder();
        const a = b.with('a', db.users.where(u => eq(u.id, 1)).select(u => ({ aid: u.id })));
        const c = b.with('c', db.users.where(u => eq(u.id, 2)).select(u => ({ cid: u.id })));
        const root = db.selectFromCte(a.cte);
        switch (kind) {
          case 'inner':
            return root.innerJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`).select((x, y) => ({ aid: x.aid, cid: y.cid }));
          case 'left':
            return root.leftJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`).select((x, y) => ({ aid: x.aid, cid: y.cid }));
          case 'right':
            return root.rightJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`).select((x, y) => ({ aid: x.aid, cid: y.cid }));
          case 'full':
            return root.fullOuterJoin(c.cte, onTrue()).select((x, y) => ({ aid: x.aid, cid: y.cid }));
          case 'cross':
            return root.crossJoin(c.cte).select((x, y) => ({ aid: x.aid, cid: y.cid }));
        }
      };

      expect((make('inner') as any).toSql()).toContain('INNER JOIN "c" ON');
      expect((make('left') as any).toSql()).toContain('LEFT JOIN "c" ON');
      expect((make('right') as any).toSql()).toContain('RIGHT JOIN "c" ON');
      expect((make('full') as any).toSql()).toContain('FULL OUTER JOIN "c" ON TRUE');
      const crossSql = (make('cross') as any).toSql();
      expect(crossSql).toContain('CROSS JOIN "c"');
      expect(crossSql).not.toContain('CROSS JOIN "c" ON');
    });

    test('select-only (no join) projects the root CTE', () => {
      const b = new DbCteBuilder();
      const spend = b.with(
        'spend',
        db.orders
          .where(o => eq(o.status, 'completed' as any))
          .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
          .groupBy(o => ({ status: o.status }))
          .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) }))
      );
      const q = db.selectFromCte(spend.cte).select(s => ({ status: s.status, totalPrice: s.totalPrice }));
      const text = (q as any).toSql();
      expect(text).toContain('WITH "spend" AS (');
      expect(text).toContain('FROM "spend"');
      expect(text).not.toContain('JOIN');
    });

    test('orderBy / limit / offset render against output aliases', () => {
      const b = new DbCteBuilder();
      const a = b.with('a', db.users.select(u => ({ aid: u.id, nm: u.username })));
      const c = b.with('c', db.users.select(u => ({ cid: u.id })));
      const q = db
        .selectFromCte(a.cte)
        .leftJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`)
        .select((x, y) => ({ aid: x.aid, nm: x.nm, cid: y.cid }))
        .orderBy(r => [[r.nm, 'DESC']])
        .limit(5)
        .offset(2);
      const text = (q as any).toSql();
      expect(text).toContain('ORDER BY "nm" DESC');
      expect(text).toContain('LIMIT 5');
      expect(text).toContain('OFFSET 2');
    });

    test('throws when executed without a selection', () => {
      const b = new DbCteBuilder();
      const a = b.with('a', db.users.select(u => ({ aid: u.id })));
      expect(() => (db.selectFromCte(a.cte) as any).buildQuery()).toThrow(/selection is required/i);
    });
  });

  // ---- execution: the four FULL-OUTER-ON-TRUE cases -------------------------

  describe('FULL OUTER JOIN ON TRUE execution — all four cases', () => {
    test('case 1: spend + tier (both sides present)', async () => {
      const { u1 } = (db as any).__fo;
      const rows = await buildSpendTierQuery(u1.id, true).toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].totalPrice).toBe(15); // 10.5 + 4.5 (pending excluded)
      expect(typeof rows[0].totalPrice).toBe('number');
      expect(rows[0].currentTierId).toBe(u1.id);
    });

    test('case 2: tier only — spend columns NULL', async () => {
      const { u2 } = (db as any).__fo;
      const rows = await buildSpendTierQuery(u2.id, true).toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBeNull();
      expect(rows[0].totalPrice).toBeNull();
      expect(rows[0].currentTierId).toBe(u2.id);
    });

    test('case 3: spend only — tier column NULL', async () => {
      const { u3 } = (db as any).__fo;
      // tierActive=false makes current_tier empty for the always-active u3.
      const rows = await buildSpendTierQuery(u3.id, false).toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].totalPrice).toBe(7);
      expect(rows[0].currentTierId).toBeNull();
    });

    test('case 4: neither — zero rows', async () => {
      const { u2 } = (db as any).__fo;
      // u2 has no completed orders AND (tierActive=false) no current_tier row.
      const rows = await buildSpendTierQuery(u2.id, false).toList();
      expect(rows).toHaveLength(0);
    });
  });

  // ---- execution: aggregation / multi-row / ordering ------------------------

  describe('aggregation, multi-row spend, and result typing', () => {
    test('multi-currency-style multi-group SUM pairs every spend row with the tier', async () => {
      // Emulate the multi-currency SUM: group spend by status so a buyer with
      // rows across two groups yields TWO spend rows, each carrying the tier id
      // via the FULL OUTER JOIN ON TRUE.
      const u4 = (db as any).__fo.u4;
      const extra = await db.users
        .insert({ username: 'fo_multi', email: 'fo_multi@test.com', age: 33, isActive: true })
        .returning();
      await db.orders.insertBulk([
        { userId: extra.id, status: 'completed', totalAmount: 2.0 },
        { userId: extra.id, status: 'completed', totalAmount: 3.0 },
        { userId: extra.id, status: 'processing', totalAmount: 4.0 },
      ]);

      const b = new DbCteBuilder();
      const spend = b.with(
        'spend',
        db.orders
          .where(o => eq(o.userId, extra.id))
          .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
          .groupBy(o => ({ status: o.status }))
          .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) }))
      );
      const tier = b.with(
        'current_tier',
        db.users.where(u => eq(u.id, extra.id)).select(u => ({ currentTierId: u.id })).limit(1)
      );

      const rows = await db
        .selectFromCte(spend.cte)
        .fullOuterJoin(tier.cte, onTrue())
        .select((s, t) => ({ status: s.status, totalPrice: s.totalPrice, currentTierId: t.currentTierId }))
        .orderBy(r => r.status)
        .toList();

      // Two spend groups → two rows, BOTH carrying the same tier id.
      expect(rows).toHaveLength(2);
      const byStatus = Object.fromEntries(rows.map(r => [r.status, r]));
      expect(byStatus['completed'].totalPrice).toBe(5); // 2 + 3
      expect(byStatus['processing'].totalPrice).toBe(4);
      expect(rows.every(r => r.currentTierId === extra.id)).toBe(true);

      // Compile-time result shape.
      rows.forEach(r => {
        assertType<string | null, typeof r.status>(r.status);
        assertType<number | null, typeof r.currentTierId>(r.currentTierId);
      });

      void u4;
    });

    test('LIMIT 1 in the tier CTE returns at most one tier row regardless of matches', async () => {
      const u1 = (db as any).__fo.u1;
      // Two users would match `is_active = true`, but LIMIT 1 keeps a single
      // current_tier row (and the cross-join with spend never multiplies it).
      const b = new DbCteBuilder();
      const spend = b.with(
        'spend',
        db.orders
          .where(o => and(eq(o.userId, u1.id), eq(o.status, 'completed' as any)))
          .select(o => ({ status: o.status, totalPrice: o.totalAmount }))
          .groupBy(o => ({ status: o.status }))
          .select(g => ({ status: g.key.status, totalPrice: g.sum(o => o.totalPrice) }))
      );
      const tier = b.with(
        'current_tier',
        db.users.where(u => eq(u.isActive, true)).select(u => ({ currentTierId: u.id })).limit(1)
      );

      const rows = await db
        .selectFromCte(spend.cte)
        .fullOuterJoin(tier.cte, onTrue())
        .select((s, t) => ({ status: s.status, totalPrice: s.totalPrice, currentTierId: t.currentTierId }))
        .toList();

      // One spend group × one (LIMIT 1) tier row = exactly one row.
      expect(rows).toHaveLength(1);
      expect(rows[0].totalPrice).toBe(15);
      expect(rows[0].currentTierId).not.toBeNull();
    });
  });

  // ---- execution: other join flavours ---------------------------------------

  describe('INNER / LEFT / RIGHT / CROSS execution', () => {
    test('INNER JOIN keeps only matching pairs', async () => {
      const { u1 } = (db as any).__fo;
      const b = new DbCteBuilder();
      const a = b.with('a', db.users.where(u => eq(u.id, u1.id)).select(u => ({ aid: u.id, nm: u.username })));
      const c = b.with('c', db.users.where(u => eq(u.id, u1.id)).select(u => ({ cid: u.id })));
      const rows = await db
        .selectFromCte(a.cte)
        .innerJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`)
        .select((x, y) => ({ aid: x.aid, nm: x.nm, cid: y.cid }))
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0].aid).toBe(u1.id);
      expect(rows[0].cid).toBe(u1.id);
    });

    test('LEFT JOIN keeps the left CTE rows even with no match (NULL right)', async () => {
      const { u1 } = (db as any).__fo;
      const b = new DbCteBuilder();
      const a = b.with('a', db.users.where(u => eq(u.id, u1.id)).select(u => ({ aid: u.id })));
      const c = b.with('c', db.users.where(u => eq(u.id, -999)).select(u => ({ cid: u.id }))); // empty
      const rows = await db
        .selectFromCte(a.cte)
        .leftJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`)
        .select((x, y) => ({ aid: x.aid, cid: y.cid }))
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0].aid).toBe(u1.id);
      expect(rows[0].cid).toBeNull();
    });

    test('RIGHT JOIN keeps the right CTE rows even with no match (NULL left)', async () => {
      const { u1 } = (db as any).__fo;
      const b = new DbCteBuilder();
      const a = b.with('a', db.users.where(u => eq(u.id, -999)).select(u => ({ aid: u.id }))); // empty
      const c = b.with('c', db.users.where(u => eq(u.id, u1.id)).select(u => ({ cid: u.id })));
      const rows = await db
        .selectFromCte(a.cte)
        .rightJoin(c.cte, sql<boolean>`"a"."aid" = "c"."cid"`)
        .select((x, y) => ({ aid: x.aid, cid: y.cid }))
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0].aid).toBeNull();
      expect(rows[0].cid).toBe(u1.id);
    });

    test('CROSS JOIN produces the cartesian product', async () => {
      const { u1, u2 } = (db as any).__fo;
      const b = new DbCteBuilder();
      const a = b.with(
        'a',
        db.users.where(u => eq(u.isActive, true)).select(u => ({ aid: u.id })).orderBy(u => u.aid).limit(2)
      );
      const c = b.with(
        'c',
        db.users.where(u => eq(u.isActive, true)).select(u => ({ cid: u.id })).orderBy(u => u.cid).limit(3)
      );
      const rows = await db
        .selectFromCte(a.cte)
        .crossJoin(c.cte)
        .select((x, y) => ({ aid: x.aid, cid: y.cid }))
        .toList();
      // 2 × 3 = 6 pairs.
      expect(rows).toHaveLength(6);
      void u1;
      void u2;
    });

    test('first() returns a single row or null', async () => {
      const { u1 } = (db as any).__fo;
      const single = await buildSpendTierQuery(u1.id, true).first();
      expect(single).not.toBeNull();
      expect(single!.totalPrice).toBe(15);

      const none = await buildSpendTierQuery(u1.id === 1 ? 2 : 1, false).first();
      // u-without-completed-orders and no tier → null
      const { u2 } = (db as any).__fo;
      const noneStrict = await buildSpendTierQuery(u2.id, false).first();
      expect(noneStrict).toBeNull();
      void none;
    });
  });

  // ---- onTrue() vs equality predicate equivalence ---------------------------

  describe('onTrue() predicate', () => {
    test('onTrue() renders ON TRUE and equals a CROSS join row-count', async () => {
      const b1 = new DbCteBuilder();
      const a1 = b1.with('a', db.users.where(u => eq(u.isActive, true)).select(u => ({ aid: u.id })).limit(2));
      const c1 = b1.with('c', db.users.where(u => eq(u.isActive, true)).select(u => ({ cid: u.id })).limit(2));
      const fullRows = await db
        .selectFromCte(a1.cte)
        .fullOuterJoin(c1.cte, onTrue())
        .select((x, y) => ({ aid: x.aid, cid: y.cid }))
        .toList();

      // With both sides non-empty, FULL OUTER JOIN ON TRUE == CROSS JOIN: 2×2.
      expect(fullRows).toHaveLength(4);
    });
  });
});
