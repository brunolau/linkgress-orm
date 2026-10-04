import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as linkgress from '../../src';
import {
  addInterval, agg, and, boolean as pgBoolean, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, eq, eqAny, fromSet,
  greatest, gt, inSubquery, integer, literal, notExists, serial, text, timestamp, unnestZip,
} from '../../src';
import type { DatabaseClient, DbCte } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * A data-modifying statement compiled with `toStatement()` may READ data-modifying CTEs registered before it —
 * through its source, its WHERE, a subquery of its map — and `afterMutation(cte)` orders it after one:
 *
 *   WITH "closed" AS (UPDATE … RETURNING …),
 *        "opened" AS (INSERT … SELECT … FROM (…) AS "src" WHERE (SELECT count(*) FROM "closed") >= 0 RETURNING …)
 *   SELECT … FROM "opened"
 *
 * Every statement that executes declares the CTEs its CTEs read first, each once, whichever of them it reads.
 *
 * PostgreSQL runs the sub-statements of a WITH on ONE snapshot, in no order it promises: a data-modifying CTE runs
 * when the main query first pulls it (the rest after the main query). A unique index over a SCOPE (one current row
 * per unit) therefore sees the new row before the close of the old one when the main query reads the open leg
 * first: 23505 — or, with ON CONFLICT DO NOTHING, the open silently skipped and the unit left with no current row.
 * `(SELECT count(*) FROM "closed") >= 0` is a data dependency: the open produces no row before the close has run
 * to completion. The in-memory engine runs CTEs in the order they are first read, as PostgreSQL does, so the
 * dangerous order is the one the matrix reads with.
 *
 * The matrix: scenarios (a move, several moves with a fresh unit and a removal, a close only, an open only, a
 * no-op) × the unique index (over the scope, over the key, none) × the barrier (none, in insertFrom's where, after
 * other quals, inside the source) × ON CONFLICT DO NOTHING or not × how the statement reads its CTEs — every
 * statement declares both: an entity query reading the open leg only, the close leg only, both (the open first),
 * an executed insertFrom reading the open leg, and — with a barrier, which makes the open leg declare the close
 * leg — `db.selectFromCte(opened)` alone. The ORACLE: PostgreSQL's rule above, applied to the scenario in JS —
 * the final rows, or the 23505.
 */

class DmUnit extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  touched!: DbColumn<boolean>;
}

class DmScoped extends DbEntity {
  id!: DbColumn<number>;
  unitId!: DbColumn<number>;
  tenantId!: DbColumn<number>;
  rent!: DbColumn<number>;
  validFrom!: DbColumn<Date>;
  validTo?: DbColumn<Date | null>;
  isCurrent!: DbColumn<boolean>;
}

class DmKeyed extends DmScoped {}
class DmPlain extends DmScoped {}

class DmAudit extends DbEntity {
  id!: DbColumn<number>;
  unitId!: DbColumn<number>;
  tenantId!: DbColumn<number>;
  action!: DbColumn<string>;
}

class DependentCteDatabase extends DbContext {
  get units(): DbEntityTable<DmUnit> {
    return this.table(DmUnit);
  }

  get scoped(): DbEntityTable<DmScoped> {
    return this.table(DmScoped);
  }

  get keyed(): DbEntityTable<DmKeyed> {
    return this.table(DmKeyed);
  }

  get plain(): DbEntityTable<DmPlain> {
    return this.table(DmPlain);
  }

  get audits(): DbEntityTable<DmAudit> {
    return this.table(DmAudit);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(DmUnit, entity => {
      entity.toTable('dm_units');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
      entity.property(e => e.touched).hasType(pgBoolean('touched')).isRequired();
    });

    const tenancy = (cls: typeof DmScoped, table: string, index?: 'scope' | 'key') => model.entity(cls, entity => {
      entity.toTable(table);
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.unitId).hasType(integer('unit_id')).isRequired();
      entity.property(e => e.tenantId).hasType(integer('tenant_id')).isRequired();
      entity.property(e => e.rent).hasType(integer('rent')).isRequired();
      entity.property(e => e.validFrom).hasType(timestamp('valid_from')).isRequired();
      entity.property(e => e.validTo).hasType(timestamp('valid_to'));
      entity.property(e => e.isCurrent).hasType(pgBoolean('is_current')).isRequired();

      if (index === 'scope') {
        entity.hasIndex(`ux_${table}_unit_current`, e => [e.unitId]).isUnique().where('is_current = true');
      } else if (index === 'key') {
        entity.hasIndex(`ux_${table}_key_current`, e => [e.unitId, e.tenantId]).isUnique().where('is_current = true');
      }
    });

    tenancy(DmScoped, 'dm_scoped', 'scope');
    tenancy(DmKeyed, 'dm_keyed', 'key');
    tenancy(DmPlain, 'dm_plain');

    model.entity(DmAudit, entity => {
      entity.toTable('dm_audits');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.unitId).hasType(integer('unit_id')).isRequired();
      entity.property(e => e.tenantId).hasType(integer('tenant_id')).isRequired();
      entity.property(e => e.action).hasType(text('action')).isRequired();
    });
  }
}

const ENGINE = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory' ? 'memory' : process.env.LINKGRESS_TEST_DRIVER === 'pglite' ? 'pglite' : 'postgres';

/** `afterMutation` read off the module, so that every case fails on its own (not the file) where it is missing */
const afterMutation = (cte: DbCte<any>) => (linkgress as any).afterMutation(cte);

const CLOSED_AT = new Date(2026, 4, 1, 12, 0, 0);
const OPENED_AT = new Date(2026, 4, 1, 12, 0, 0);
const HISTORY_FROM = new Date(2020, 0, 1);

interface Desired {
  unitId: number;
  tenantId: number;
  rent: number;
}

interface Scenario {
  name: string;
  scope: number[];
  desired: Desired[];
}

/** The current rows before every case: unit 1 → tenant 10, unit 2 → 20, unit 4 → 40; units 3 and 5 have none */
const CURRENT: Desired[] = [{ unitId: 1, tenantId: 10, rent: 100 }, { unitId: 2, tenantId: 20, rent: 200 }, { unitId: 4, tenantId: 40, rent: 400 }];

const SCENARIOS: Scenario[] = [
  { name: 'a move', scope: [1, 2], desired: [{ unitId: 1, tenantId: 11, rent: 110 }, { unitId: 2, tenantId: 20, rent: 200 }] },
  {
    name: 'moves, a fresh unit and a removal',
    scope: [1, 2, 3, 4],
    desired: [{ unitId: 1, tenantId: 11, rent: 110 }, { unitId: 2, tenantId: 21, rent: 210 }, { unitId: 3, tenantId: 31, rent: 310 }],
  },
  { name: 'a close only', scope: [1], desired: [] },
  { name: 'an open only', scope: [3], desired: [{ unitId: 3, tenantId: 31, rent: 310 }] },
  { name: 'a no-op', scope: [2], desired: [{ unitId: 2, tenantId: 20, rent: 200 }] },
];

type TableKind = 'scope-unique' | 'key-unique' | 'no-unique';
type Barrier = 'none' | 'where' | 'where-after-quals' | 'source';
type Readback = 'opened-first' | 'closed-first' | 'both, opened first' | 'executed-insert' | 'cte-root';

const TABLES: TableKind[] = ['scope-unique', 'key-unique', 'no-unique'];
const BARRIERS: Barrier[] = ['none', 'where', 'where-after-quals', 'source'];
const READBACKS: Readback[] = ['opened-first', 'closed-first', 'both, opened first', 'executed-insert', 'cte-root'];

interface StateRow {
  unitId: number;
  tenantId: number;
  rent: number;
  isCurrent: boolean;
  closed: boolean;
}

const stateKey = (r: StateRow) => `${r.unitId}|${r.tenantId}|${r.isCurrent}|${r.closed}`;

/** The oracle: PostgreSQL's rule applied in JS — the rows after the statement, or the 23505 it raises */
function expectedOutcome(
  scenario: Scenario,
  table: TableKind,
  barrier: Barrier,
  readback: Readback,
  onConflict: boolean
): { error: true } | { error: false; state: StateRow[]; opened: Desired[]; closed: Desired[] } {
  const inScope = (unitId: number) => scenario.scope.includes(unitId);
  const desiredKeys = new Set(scenario.desired.map(d => `${d.unitId}|${d.tenantId}`));
  const closes = CURRENT.filter(c => inScope(c.unitId) && !desiredKeys.has(`${c.unitId}|${c.tenantId}`));
  let opens = scenario.desired.filter(d => !CURRENT.some(c => c.unitId === d.unitId && c.tenantId === d.tenantId));

  // The open leg runs before the close when nothing orders it and the main query pulls it first
  const openFirst = barrier === 'none' && readback !== 'closed-first';
  const collide = table === 'scope-unique' && openFirst ? opens.filter(o => closes.some(c => c.unitId === o.unitId)) : [];

  if (collide.length > 0) {
    if (!onConflict) {
      return { error: true };
    }

    // ON CONFLICT DO NOTHING skips the colliding opens; their closes still run: no current row left
    opens = opens.filter(o => !collide.includes(o));
  }

  const state: StateRow[] = [
    { unitId: 1, tenantId: 9, rent: 90, isCurrent: false, closed: false },
    ...CURRENT.map(c => ({ ...c, isCurrent: !closes.includes(c), closed: closes.includes(c) })),
    ...opens.map(o => ({ ...o, isCurrent: true, closed: false })),
  ];

  return { error: false, state, opened: opens, closed: closes };
}

describe('dependent mutation CTEs and the close-before-open barrier', () => {
  let client: DatabaseClient;
  let db: DependentCteDatabase;
  const captured: string[] = [];

  const tableOf = (kind: TableKind, t: DependentCteDatabase = db): DbEntityTable<DmScoped> => (kind === 'scope-unique' ? t.scoped : kind === 'key-unique' ? t.keyed : t.plain);
  const tableName = (kind: TableKind) => (kind === 'scope-unique' ? 'dm_scoped' : kind === 'key-unique' ? 'dm_keyed' : 'dm_plain');

  /** The rows every case starts from, inside a transaction (a matrix case runs in one it rolls back) */
  const seed = async (t: DependentCteDatabase) => {
    await t.units.insertBulk([1, 2, 3, 4, 5].map(id => ({ id, name: `unit-${id}`, touched: false })));

    for (const target of [t.scoped, t.keyed, t.plain]) {
      await target.insertBulk([
        { unitId: 1, tenantId: 9, rent: 90, validFrom: HISTORY_FROM, validTo: new Date(2021, 0, 1), isCurrent: false },
        ...CURRENT.map(c => ({ ...c, validFrom: HISTORY_FROM, isCurrent: true })),
      ]);
    }

    captured.length = 0;
  };

  const ROLLBACK = new Error('rolled back');

  const inRolledBackTransaction = async (body: (tx: DependentCteDatabase) => Promise<void>): Promise<void> => {
    try {
      await db.transaction(async tx => {
        await body(tx as DependentCteDatabase);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
  };

  const reset = async () => {
    for (const table of ['dm_scoped', 'dm_keyed', 'dm_plain', 'dm_audits', 'dm_units']) {
      await client.query(`DELETE FROM ${table}`);
    }
    await db.units.insertBulk([1, 2, 3, 4, 5].map(id => ({ id, name: `unit-${id}`, touched: false })));

    for (const target of [db.scoped, db.keyed, db.plain]) {
      await target.insertBulk([
        { unitId: 1, tenantId: 9, rent: 90, validFrom: HISTORY_FROM, validTo: new Date(2021, 0, 1), isCurrent: false },
        ...CURRENT.map(c => ({ ...c, validFrom: HISTORY_FROM, isCurrent: true })),
      ]);
    }

    captured.length = 0;
  };

  const stateOf = async (kind: TableKind, context: DependentCteDatabase = db): Promise<StateRow[]> => (await tableOf(kind, context).select(t => ({
    unitId: t.unitId, tenantId: t.tenantId, rent: t.rent, isCurrent: t.isCurrent, validTo: t.validTo,
  })).toList()).map(r => ({
    unitId: r.unitId, tenantId: r.tenantId, rent: r.rent, isCurrent: r.isCurrent,
    closed: r.validTo != null && r.validTo.getTime() === CLOSED_AT.getTime(),
  })).sort((a, b) => stateKey(a).localeCompare(stateKey(b)));

  /** The SCD2 fold of `scenario` on `table`: the close leg, then the open leg reading it */
  const fold = (kind: TableKind, scenario: Scenario, barrier: Barrier, onConflict: boolean, context: DependentCteDatabase = db) => {
    const table = tableOf(kind, context);
    const builder = new DbCteBuilder();
    const desired = (alias: string) => fromSet(unnestZip({
      unitId: { values: scenario.desired.map(d => d.unitId), type: 'integer' },
      tenantId: { values: scenario.desired.map(d => d.tenantId), type: 'integer' },
      rent: { values: scenario.desired.map(d => d.rent), type: 'integer' },
    }), alias);

    const closed = builder.withMutation('dm_closed', table
      .where(t => and(
        eqAny(t.unitId, scenario.scope),
        eq(t.isCurrent, true),
        notExists(desired('k').where(k => and(eq(k.unitId, t.unitId), eq(k.tenantId, t.tenantId))).select(() => ({ one: literal(1) })).asSubquery())
      ))
      .update({ validTo: CLOSED_AT, isCurrent: false })
      .toStatement(t => ({ id: t.id, unitId: t.unitId, tenantId: t.tenantId, validTo: t.validTo })));

    const notCurrent = (d: any) => notExists(table.where(c => and(eq(c.unitId, d.unitId), eq(c.tenantId, d.tenantId), eq(c.isCurrent, true))).select(c => ({ id: c.id })).asSubquery());
    const source = desired('d')
      .where(d => (barrier === 'source' ? and(notCurrent(d), afterMutation(closed.cte)) : notCurrent(d)))
      .select(d => ({ unitId: d.unitId, tenantId: d.tenantId, rent: d.rent }))
      .asSubquery('table');

    const opened = builder.withMutation('dm_opened', table.insertFrom(
      source,
      src => ({ unitId: src.unitId, tenantId: src.tenantId, rent: src.rent, validFrom: OPENED_AT, isCurrent: true }),
      {
        ...(barrier === 'where' ? { where: () => afterMutation(closed.cte) } : {}),
        ...(barrier === 'where-after-quals' ? { where: (src: any) => and(gt(src.rent, 0), afterMutation(closed.cte)) } : {}),
        ...(onConflict ? { onConflictDoNothing: true } : {}),
      }
    ).toStatement(t => ({ id: t.id, unitId: t.unitId, tenantId: t.tenantId })));

    return { closed, opened };
  };

  /**
   * Executes the statement that declares both legs and reads them as `readback` says; the rows it read of each
   * leg. A data-modifying CTE the main query does not read runs after the main query (PostgreSQL and the in-memory
   * engine alike): the leg the main query reads runs first.
   */
  const execute = async (readback: Readback, closed: { cte: DbCte<any> }, opened: { cte: DbCte<any> }, t: DependentCteDatabase = db) => {
    const tenants = (cte: DbCte<any>) => t.selectFromCte(cte).select(r => agg.arrayAgg(r.tenantId)).asSubquery('scalar');

    switch (readback) {
      case 'opened-first': {
        const [row] = await t.units.with(closed.cte, opened.cte).where(u => eq(u.id, 1)).select(() => ({ opened: tenants(opened.cte) })).toList();
        return { openedTenants: row.opened ?? [] };
      }
      case 'closed-first': {
        const [row] = await t.units.with(closed.cte, opened.cte).where(u => eq(u.id, 1)).select(() => ({ closed: tenants(closed.cte) })).toList();
        return { closedTenants: row.closed ?? [] };
      }
      case 'both, opened first': {
        const [row] = await t.units.with(closed.cte, opened.cte).where(u => eq(u.id, 1)).select(() => ({
          opened: tenants(opened.cte),
          closed: tenants(closed.cte),
        })).toList();

        return { openedTenants: row.opened ?? [], closedTenants: row.closed ?? [] };
      }
      case 'executed-insert':
        await t.audits.insertFrom(
          t.selectFromCte(opened.cte).select(r => ({ unitId: r.unitId, tenantId: r.tenantId })).asSubquery('table'),
          src => ({ unitId: src.unitId, tenantId: src.tenantId, action: 'opened' }),
          { with: [closed.cte, opened.cte] }
        );

        return { audited: await t.audits.select(a => ({ unitId: a.unitId, tenantId: a.tenantId })).toList() };
      case 'cte-root':
        // The open leg reads the close leg (the barrier): reading the open leg declares both
        return { opened: await t.selectFromCte(opened.cte).select(r => ({ unitId: r.unitId, tenantId: r.tenantId })).toList() };
    }
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new DependentCteDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS dm_scoped, dm_keyed, dm_plain, dm_audits, dm_units CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS dm_scoped, dm_keyed, dm_plain, dm_audits, dm_units CASCADE');
    await db.dispose();
  });

  const pairs = (rows: Array<{ unitId: number; tenantId: number }>) => rows.map(r => `${r.unitId}:${r.tenantId}`).sort();

  describe('matrix: scenario × unique index × barrier × ON CONFLICT × readback', () => {
    for (const scenario of SCENARIOS) {
      for (const table of TABLES) {
        for (const barrier of BARRIERS) {
          for (const onConflict of [false, true]) {
            // Without a barrier the open leg does not read the close leg: a statement reading the open leg alone
            // would not declare the close leg — it is not the fold
            for (const readback of READBACKS.filter(r => barrier !== 'none' || r !== 'cte-root')) {
              test(`${scenario.name} | ${table} | barrier ${barrier}${onConflict ? ' | on conflict' : ''} | ${readback}`, async () => {
                await inRolledBackTransaction(async tx => {
                  await seed(tx);
                  const before = await stateOf(table, tx);
                  const { closed, opened } = fold(table, scenario, barrier, onConflict, tx);
                  const outcome = expectedOutcome(scenario, table, barrier, readback, onConflict);

                  if (outcome.error) {
                    // The statement fails as a whole: back to the savepoint, the rows are as they were
                    await tx.query('SAVEPOINT dm_case');
                    const error = await expectToReject(execute(readback, closed, opened, tx));
                    await tx.query('ROLLBACK TO SAVEPOINT dm_case');
                    expect(sqlStateOf(error)).toBe('23505');
                    expect(await stateOf(table, tx)).toEqual(before);
                  } else {
                    const read = await execute(readback, closed, opened, tx);
                    expect(await stateOf(table, tx)).toEqual([...outcome.state].sort((a, b) => stateKey(a).localeCompare(stateKey(b))));

                    if (read.opened) {
                      expect(pairs(read.opened)).toEqual(pairs(outcome.opened));
                    }
                    if (read.openedTenants) {
                      expect([...read.openedTenants].sort()).toEqual(outcome.opened.map(o => o.tenantId).sort());
                    }
                    if (read.closedTenants) {
                      expect([...read.closedTenants].sort()).toEqual(outcome.closed.map(c => c.tenantId).sort());
                    }
                    if (read.audited) {
                      expect(pairs(read.audited)).toEqual(pairs(outcome.opened));
                    }
                  }

                  // ONE statement declares the close leg before the open leg, each once, the barrier where asked for (the
                  // failed-query log repeats a failed statement: the statement itself is the entry it starts)
                  const statements = captured.filter(entry => entry.startsWith('WITH ') && entry.includes('"dm_opened" AS ('));
                  expect(statements).toHaveLength(1);
                  const [statement] = statements;
                  expect(statement.match(/"dm_closed" AS \(/g)).toHaveLength(1);
                  expect(statement.match(/"dm_opened" AS \(/g)).toHaveLength(1);
                  // every statement here lists the close leg first; with a barrier it must come first, however listed
                  expect(statement.indexOf('"dm_closed" AS (')).toBeLessThan(statement.indexOf('"dm_opened" AS ('));
                  expect(statement.includes('(SELECT count(*) FROM "dm_closed") >= 0')).toBe(barrier !== 'none');
                  expect(statement).toContain(`UPDATE "${tableName(table)}" SET`);
                });
              });
            }
          }
        }
      }
    }
  });

  describe('semantics', () => {
    test('ONE snapshot: with the barrier the open leg still sees the row the close leg retired as current', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('dm_closed', db.scoped
        .where(t => and(eq(t.unitId, 1), eq(t.isCurrent, true)))
        .update({ validTo: CLOSED_AT, isCurrent: false })
        .toStatement(t => ({ id: t.id, unitId: t.unitId })));
      // A guard over the whole SCOPE: "no current row for the unit"
      const opened = builder.withMutation('dm_opened', db.scoped.insertFrom(
        fromSet(unnestZip({ unitId: { values: [1], type: 'integer' }, tenantId: { values: [11], type: 'integer' } }), 'd')
          .where(d => notExists(db.scoped.where(c => and(eq(c.unitId, d.unitId), eq(c.isCurrent, true))).select(c => ({ id: c.id })).asSubquery()))
          .select(d => ({ unitId: d.unitId, tenantId: d.tenantId }))
          .asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: src.tenantId, rent: 1, validFrom: OPENED_AT, isCurrent: true }),
        { where: () => afterMutation(closed.cte) }
      ).toStatement(t => ({ id: t.id })));

      const rows = await db.selectFromCte(opened.cte).select(r => ({ id: r.id })).toList();

      expect(rows).toEqual([]);
      expect((await stateOf('scope-unique')).filter(r => r.unitId === 1 && r.isCurrent)).toEqual([]);
    });

    test('the barrier is a one-time filter over the close leg\'s count in the plan', async () => {
      await reset();
      const { closed, opened } = fold('scope-unique', SCENARIOS[0], 'where', false);
      const statement = db.selectFromCte(opened.cte).select(r => ({ id: r.id }));
      const { sql, params } = (statement as any).buildQuery();
      const plan = (await client.query(`EXPLAIN ${sql}`, params)).rows.map((r: any) => r['QUERY PLAN']).join('\n');

      // The plan PostgreSQL makes of the barrier is PostgreSQL's: the in-memory engine explains plans of its own
      if (ENGINE !== 'memory') {
        expect(plan).toMatch(/One-Time Filter: \(\(InitPlan \d+\)\.col1 >= 0\)|One-Time Filter: \(\$\d+ >= 0\)/);
        expect(plan).toContain('CTE Scan on dm_closed');
      }
      expect(plan.length).toBeGreaterThan(0);
      void closed;
    });

    test('a chain: each statement reads the one before it, the main query only the last — all declared in order', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('dm_closed', db.scoped
        .where(t => and(eqAny(t.unitId, [1, 2]), eq(t.isCurrent, true)))
        .update({ validTo: CLOSED_AT, isCurrent: false })
        .toStatement(t => ({ unitId: t.unitId, tenantId: t.tenantId })));
      const audited = builder.withMutation('dm_audited', db.audits.insertFrom(
        db.selectFromCte(closed.cte).select(r => ({ unitId: r.unitId, tenantId: r.tenantId })).asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: src.tenantId, action: 'closed' })
      ).toStatement(a => ({ unitId: a.unitId })));
      const touched = builder.withMutation('dm_touched', db.units
        .where(u => inSubquery(u.id, db.selectFromCte(audited.cte).select(r => r.unitId).asSubquery('array')))
        .update({ touched: true })
        .toStatement(u => ({ id: u.id })));

      const rows = await db.selectFromCte(touched.cte).select(r => ({ id: r.id })).toList();

      expect(rows.map(r => r.id).sort()).toEqual([1, 2]);
      expect((await db.audits.select(a => ({ unitId: a.unitId, action: a.action })).toList()).map(r => `${r.unitId}:${r.action}`).sort()).toEqual(['1:closed', '2:closed']);
      const [statement] = captured.filter(entry => entry.includes('"dm_touched" AS ('));
      expect(statement.indexOf('"dm_closed" AS (')).toBeLessThan(statement.indexOf('"dm_audited" AS ('));
      expect(statement.indexOf('"dm_audited" AS (')).toBeLessThan(statement.indexOf('"dm_touched" AS ('));
      expect(statement.match(/"dm_closed" AS \(/g)).toHaveLength(1);
    });

    test('a diamond: two statements read the same one, a third reads both — it is declared once, first', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('dm_closed', db.scoped
        .where(t => and(eq(t.unitId, 1), eq(t.isCurrent, true)))
        .update({ validTo: CLOSED_AT, isCurrent: false })
        .toStatement(t => ({ unitId: t.unitId, tenantId: t.tenantId })));
      const left = builder.withMutation('dm_left', db.audits.insertFrom(
        db.selectFromCte(closed.cte).select(r => ({ unitId: r.unitId, tenantId: r.tenantId })).asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: src.tenantId, action: 'left' })
      ).toStatement(a => ({ unitId: a.unitId })));
      const right = builder.withMutation('dm_right', db.audits.insertFrom(
        db.selectFromCte(closed.cte).select(r => ({ unitId: r.unitId, tenantId: r.tenantId })).asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: src.tenantId, action: 'right' })
      ).toStatement(a => ({ unitId: a.unitId })));
      const both = builder.withMutation('dm_both', db.units
        .where(u => and(
          inSubquery(u.id, db.selectFromCte(left.cte).select(r => r.unitId).asSubquery('array')),
          inSubquery(u.id, db.selectFromCte(right.cte).select(r => r.unitId).asSubquery('array'))
        ))
        .update({ touched: true })
        .toStatement(u => ({ id: u.id })));

      expect((await db.selectFromCte(both.cte).select(r => ({ id: r.id })).toList()).map(r => r.id)).toEqual([1]);
      const [statement] = captured.filter(entry => entry.includes('"dm_both" AS ('));
      expect(statement.match(/"dm_closed" AS \(/g)).toHaveLength(1);
      expect(statement.indexOf('"dm_closed" AS (')).toBeLessThan(statement.indexOf('"dm_left" AS ('));
      expect(statement.indexOf('"dm_closed" AS (')).toBeLessThan(statement.indexOf('"dm_right" AS ('));
      expect((await db.audits.count())).toBe(2);
    });

    test('a plain CTE over a data-modifying one: the plain CTE reads it by name, the statement declares it first', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('dm_closed', db.scoped
        .where(t => and(eqAny(t.unitId, [1, 4]), eq(t.isCurrent, true)))
        .update({ validTo: CLOSED_AT, isCurrent: false })
        .toStatement(t => ({ unitId: t.unitId, rent: t.rent })));
      const summary = builder.with('dm_summary', db.selectFromCte(closed.cte).where(r => gt(r.rent, 150)).select(r => ({ unitId: r.unitId })));

      const rows = await db.selectFromCte(summary.cte).select(r => ({ unitId: r.unitId })).toList();

      expect(rows).toEqual([{ unitId: 4 }]);
      const [statement] = captured.filter(entry => entry.includes('"dm_summary" AS ('));
      expect(statement.indexOf('"dm_closed" AS (')).toBeLessThan(statement.indexOf('"dm_summary" AS ('));
      expect(statement.match(/"dm_closed" AS \(/g)).toHaveLength(1);
      expect((await stateOf('scope-unique')).filter(r => r.closed).map(r => r.unitId).sort()).toEqual([1, 4]);
    });

    test('a delete reading an earlier insert: the rows it inserted are deleted in the same statement', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const added = builder.withMutation('dm_added', db.audits.insertBulk([
        { unitId: 1, tenantId: 1, action: 'a' }, { unitId: 2, tenantId: 2, action: 'b' },
      ]).toStatement(a => ({ id: a.id, unitId: a.unitId })));
      const removed = builder.withMutation('dm_removed', db.units
        .where(u => inSubquery(u.id, db.selectFromCte(added.cte).select(r => r.unitId).asSubquery('array')))
        .delete()
        .toStatement(u => ({ id: u.id })));

      const rows = await db.selectFromCte(removed.cte).select(r => ({ id: r.id })).toList();

      expect(rows.map(r => r.id).sort()).toEqual([1, 2]);
      expect(await db.units.count()).toBe(3);
      expect(await db.audits.count()).toBe(2);
    });

    test('a successor starts 1 ms after the close it follows: a map subquery aggregating the close leg', async () => {
      await reset();
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('dm_closed', db.scoped
        .where(t => and(eqAny(t.unitId, [1]), eq(t.isCurrent, true)))
        .update({ validTo: CLOSED_AT, isCurrent: false })
        .toStatement(t => ({ unitId: t.unitId, validTo: t.validTo })));
      const opened = builder.withMutation('dm_opened', db.scoped.insertFrom(
        fromSet(unnestZip({ unitId: { values: [1, 3], type: 'integer' }, tenantId: { values: [11, 31], type: 'integer' } }), 'd')
          .select(d => ({ unitId: d.unitId, tenantId: d.tenantId }))
          .asSubquery('table'),
        src => ({
          unitId: src.unitId,
          tenantId: src.tenantId,
          rent: 1,
          isCurrent: true,
          validFrom: greatest(
            OPENED_AT,
            addInterval(db.selectFromCte(closed.cte, 'c').where(c => eq(c.unitId, src.unitId)).select(c => agg.max(c.validTo)).asSubquery('scalar').asExpression(), { milliseconds: 1 })
          ),
        }),
        { where: () => afterMutation(closed.cte) }
      ).toStatement(t => ({ unitId: t.unitId, validFrom: t.validFrom })));

      const rows = await db.selectFromCte(opened.cte).select(r => ({ unitId: r.unitId, validFrom: r.validFrom })).toList();

      expect(rows.map(r => [r.unitId, (r.validFrom as Date).getTime()]).sort()).toEqual([
        [1, CLOSED_AT.getTime() + 1],
        [3, OPENED_AT.getTime()],
      ]);
    });
  });

  describe('refusals', () => {
    test('afterMutation() takes a data-modifying CTE', () => {
      const plain = new DbCteBuilder().with('dm_plain_cte', db.units.select(u => ({ id: u.id })));

      expect(() => afterMutation(plain.cte)).toThrow('afterMutation(): "dm_plain_cte" is not a data-modifying CTE');
    });

    test('an executed statement that reads a data-modifying CTE it does not declare is refused, the barrier too', async () => {
      await reset();
      const closed = new DbCteBuilder().withMutation('dm_closed', db.scoped.where(t => eq(t.unitId, 1)).update({ rent: 1 }).toStatement(t => ({ unitId: t.unitId })));

      await expectToReject(
        db.audits.insertFrom(
          fromSet(unnestZip({ unitId: { values: [1], type: 'integer' } }), 'd').select(d => ({ unitId: d.unitId })).asSubquery('table'),
          src => ({ unitId: src.unitId, tenantId: 1, action: 'x' }),
          { where: () => afterMutation(closed.cte) }
        ),
        'insertFrom: the statement reads the data-modifying CTE "dm_closed"'
      );
      expect(captured.filter(entry => entry.includes('dm_closed'))).toHaveLength(0);
    });

    test('two different data-modifying CTEs under one name in one statement are refused', () => {
      const first = new DbCteBuilder().withMutation('dm_twice', db.scoped.where(t => eq(t.unitId, 1)).update({ rent: 1 }).toStatement(t => ({ unitId: t.unitId })));
      const second = new DbCteBuilder().withMutation('dm_twice', db.scoped.where(t => eq(t.unitId, 2)).update({ rent: 2 }).toStatement(t => ({ unitId: t.unitId })));
      const read = () => {
        const reader = new DbCteBuilder().withMutation('dm_reader', db.units
          .where(u => and(
            inSubquery(u.id, db.selectFromCte(first.cte).select(r => r.unitId).asSubquery('array')),
            inSubquery(u.id, db.selectFromCte(second.cte).select(r => r.unitId).asSubquery('array'))
          ))
          .update({ touched: true })
          .toStatement(u => ({ id: u.id })));

        return db.selectFromCte(reader.cte).select(r => ({ id: r.id })).toSql();
      };

      expect(read).toThrow('two different CTEs named "dm_twice"');
    });
  });

  describe('typings', () => {
    test('afterMutation() is a condition over a data-modifying CTE', () => {
      const typed = (cte: DbCte<{ id: number }>) => {
        const condition: linkgress.Condition = linkgress.afterMutation(cte);
        return condition;
      };

      expect(typeof typed).toBe('function');
    });
  });
});
