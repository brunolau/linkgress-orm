import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  add, agg, boolean as pgBoolean, concat, createCustomType, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig,
  eq, fromSet, gt, integer, notExists, serial, smallint, sql, text, unnestZip, varchar,
} from '../../src';
import type { DatabaseClient, InsertFromOptions } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * `insertFrom(source, map, { onConflictDoNothing: true })` — `INSERT … SELECT … ON CONFLICT DO NOTHING`:
 *
 *   INSERT INTO <table> (<cols>) SELECT <values> FROM (<source>) AS "src" [WHERE <cond>] ON CONFLICT DO NOTHING [RETURNING …]
 *
 * The matrix runs every source a table subquery can come from (an entity query, a grouped query, a CTE declared
 * by the statement or by the subquery itself, a set of JS arrays, a union) × the ways the map writes the row
 * (source refs and a typed NULL, plain values through the columns' mappers, expressions) × every way the
 * statement ends (awaited bare, RETURNING a selection, RETURNING whole rows, RETURNING a navigation, compiled as
 * a data-modifying CTE that the main query reads back) × with and without a `where` × the conflict scenarios of
 * every kind of unique index (one column, composite, nullable, partial, the primary key), duplicates inside the
 * source and empty sources. Every case is checked against an ORACLE — the same insertion simulated in JS, row by
 * row against every unique index — on the table's final rows and on the rows RETURNING yields, and its SQL is
 * the SQL without the option plus ` ON CONFLICT DO NOTHING` before RETURNING (the option off renders the
 * statement byte for byte as it rendered before).
 */

type Size = 'small' | 'large';

/** smallint ↔ size name: the plain values of the map bind through toDriver, RETURNING reads through fromDriver */
const sizeMapper = createCustomType<{ data: Size; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Size | null | undefined) => (value == null ? null : value === 'large' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'large' : 'small'),
});

class IcBank extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class IcLocker extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  bank!: DbColumn<number>;
  slot!: DbColumn<number>;
  tag?: DbColumn<string | null>;
  holderId?: DbColumn<number | null>;
  active!: DbColumn<boolean>;
  size!: DbColumn<Size>;
  note?: DbColumn<string | null>;

  bankRow?: IcBank;
}

class IcCandidate extends DbEntity {
  id!: DbColumn<number>;
  batch!: DbColumn<number>;
  code!: DbColumn<string>;
  bank!: DbColumn<number>;
  slot!: DbColumn<number>;
  tag?: DbColumn<string | null>;
  holderId?: DbColumn<number | null>;
  active!: DbColumn<boolean>;
  size!: DbColumn<Size>;
}

class IcLedger extends DbEntity {
  id!: DbColumn<number>;
  amount!: DbColumn<number>;
}

class OnConflictDatabase extends DbContext {
  get banks(): DbEntityTable<IcBank> {
    return this.table(IcBank);
  }

  get lockers(): DbEntityTable<IcLocker> {
    return this.table(IcLocker);
  }

  get candidates(): DbEntityTable<IcCandidate> {
    return this.table(IcCandidate);
  }

  get ledger(): DbEntityTable<IcLedger> {
    return this.table(IcLedger);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(IcBank, entity => {
      entity.toTable('ic_banks');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
    });

    model.entity(IcLocker, entity => {
      entity.toTable('ic_lockers');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.code).hasType(varchar('code', 32)).isRequired();
      entity.property(e => e.bank).hasType(integer('bank')).isRequired();
      entity.property(e => e.slot).hasType(integer('slot')).isRequired();
      entity.property(e => e.tag).hasType(text('tag'));
      entity.property(e => e.holderId).hasType(integer('holder_id'));
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.property(e => e.size).hasType(smallint('size')).isRequired().hasCustomMapper(sizeMapper);
      entity.property(e => e.note).hasType(text('note'));
      entity.hasIndex('ux_ic_lockers_code', e => [e.code]).isUnique();
      entity.hasIndex('ux_ic_lockers_bank_slot', e => [e.bank, e.slot]).isUnique();
      entity.hasIndex('ux_ic_lockers_tag', e => [e.tag]).isUnique();
      entity.hasIndex('ux_ic_lockers_holder_active', e => [e.holderId]).isUnique().where('active = true');
      entity.hasOne(e => e.bankRow, () => IcBank).withForeignKey(l => l.bank).withPrincipalKey(b => b.id);
    });

    model.entity(IcCandidate, entity => {
      entity.toTable('ic_candidates');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.batch).hasType(integer('batch')).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 32)).isRequired();
      entity.property(e => e.bank).hasType(integer('bank')).isRequired();
      entity.property(e => e.slot).hasType(integer('slot')).isRequired();
      entity.property(e => e.tag).hasType(text('tag'));
      entity.property(e => e.holderId).hasType(integer('holder_id'));
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.property(e => e.size).hasType(smallint('size')).isRequired().hasCustomMapper(sizeMapper);
    });

    model.entity(IcLedger, entity => {
      entity.toTable('ic_ledger');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.amount).hasType(integer('amount')).isRequired();
    });
  }
}

const PGLITE = process.env.LINKGRESS_TEST_DRIVER === 'pglite';

interface LockerRow {
  code: string;
  bank: number;
  slot: number;
  tag: string | null;
  holderId: number | null;
  active: boolean;
  size: Size;
}

const row = (code: string, bank: number, slot: number, extra: Partial<LockerRow> = {}): LockerRow => ({
  code, bank, slot, tag: null, holderId: null, active: true, size: 'small', ...extra,
});

interface Scenario {
  name: string;
  existing: LockerRow[];
  candidates: LockerRow[];
}

/** Conflicts on every kind of unique index, duplicates inside the source, empty sources */
const SCENARIOS: Scenario[] = [
  { name: 'all fresh', existing: [], candidates: [row('A', 1, 1), row('B', 1, 2, { size: 'large' }), row('C', 2, 1, { tag: 't-c', holderId: 3 })] },
  { name: 'all conflicting (one column)', existing: [row('A', 1, 1), row('B', 1, 2)], candidates: [row('A', 9, 9), row('B', 9, 8)] },
  { name: 'one column', existing: [row('A', 1, 1)], candidates: [row('A', 5, 5), row('N', 5, 6, { size: 'large' })] },
  { name: 'composite key', existing: [row('A', 1, 1)], candidates: [row('X', 1, 1), row('Y', 1, 2)] },
  {
    name: 'nullable key: NULLs never conflict',
    existing: [row('A', 1, 1), row('B', 1, 2, { tag: 't' })],
    candidates: [row('X', 2, 1), row('Y', 2, 2, { tag: 't' }), row('Z', 2, 3, { tag: 'u' })],
  },
  {
    name: 'partial key: only rows its predicate holds for',
    existing: [row('A', 1, 1, { holderId: 7 }), row('B', 1, 2, { holderId: 8, active: false })],
    candidates: [row('X', 2, 1, { holderId: 7 }), row('Y', 2, 2, { holderId: 7, active: false }), row('Z', 2, 3, { holderId: 8 })],
  },
  { name: 'duplicates inside the source', existing: [], candidates: [row('D', 3, 1), row('D', 3, 1), row('E', 3, 2)] },
  {
    name: 'every index at once',
    existing: [row('A', 1, 1, { tag: 'ta', holderId: 1 })],
    candidates: [row('A', 8, 8), row('M', 1, 1), row('N', 8, 9, { tag: 'ta' }), row('O', 8, 7, { holderId: 1 }), row('P', 8, 6), row('P', 8, 6)],
  },
  { name: 'empty source', existing: [row('A', 1, 1)], candidates: [] },
  { name: 'filtered by where (slot 0)', existing: [row('A', 1, 1)], candidates: [row('W', 4, 0), row('V', 4, 1), row('A', 4, 0)] },
];

/** The oracle: the candidates inserted one by one, each skipped when any unique index already holds its key */
function simulate(scenario: Scenario, filtered: boolean): { inserted: LockerRow[]; processed: number } {
  const table = scenario.existing.map(r => ({ ...r }));
  const inserted: LockerRow[] = [];
  const candidates = scenario.candidates.filter(c => !filtered || c.slot > 0);

  for (const c of candidates) {
    const conflict = table.some(r => r.code === c.code
      || (r.bank === c.bank && r.slot === c.slot)
      || (c.tag !== null && r.tag === c.tag)
      || (c.holderId !== null && c.active && r.active && r.holderId === c.holderId));

    if (!conflict) {
      table.push({ ...c });
      inserted.push({ ...c });
    }
  }

  return { inserted, processed: candidates.length };
}

const key = (r: { code: string; bank: number; slot: number }) => `${r.code}|${r.bank}|${r.slot}`;
const sortRows = <T extends { code: string; bank: number; slot: number }>(rows: T[]): T[] => [...rows].sort((a, b) => key(a).localeCompare(key(b)));

type SourceKind = 'entity' | 'grouped' | 'cte-declared' | 'cte-nested' | 'set' | 'union';
type MapKind = 'refs' | 'constants' | 'expressions';
type Terminal = 'await' | 'returning' | 'returning-all' | 'returning-navigation' | 'statement';

const SOURCES: SourceKind[] = ['entity', 'grouped', 'cte-declared', 'cte-nested', 'set', 'union'];
const MAPS: MapKind[] = ['refs', 'constants', 'expressions'];
const TERMINALS: Terminal[] = ['await', 'returning', 'returning-all', 'returning-navigation', 'statement'];

/** The note each map writes, per inserted row */
const noteOf = (map: MapKind, r: LockerRow): string | null => (map === 'refs' ? null : map === 'constants' ? 'imported' : `n-${r.code}`);

describe('insertFrom(…, { onConflictDoNothing: true })', () => {
  let client: DatabaseClient;
  let db: OnConflictDatabase;
  const captured: string[] = [];

  const insertStatements = (): string[] => captured.filter(entry => entry.includes('INSERT INTO "ic_lockers"'));

  /** The scenario's rows; `restartIdentity` resets the sequences too (a TRUNCATE — slow on PostgreSQL, so only where ids matter) */
  const reset = async (scenario: Scenario, batch: number, restartIdentity = false): Promise<void> => {
    if (restartIdentity) {
      await client.query('TRUNCATE ic_lockers, ic_candidates, ic_ledger RESTART IDENTITY');
    } else {
      await client.query('DELETE FROM ic_lockers');
    }

    if (scenario.existing.length > 0) {
      await db.lockers.insertBulk(scenario.existing.map(r => ({ ...r })));
    }

    if (scenario.candidates.length > 0) {
      await db.candidates.insertBulk(scenario.candidates.map(r => ({ ...r, batch })));
    }

    captured.length = 0;
  };

  /** The scenario's rows inside a transaction (a case runs in one it rolls back: no commit per statement) */
  const seed = async (target: OnConflictDatabase, scenario: Scenario, batch: number): Promise<void> => {
    if (scenario.existing.length > 0) {
      await target.lockers.insertBulk(scenario.existing.map(r => ({ ...r })));
    }

    if (scenario.candidates.length > 0) {
      await target.candidates.insertBulk(scenario.candidates.map(r => ({ ...r, batch })));
    }

    captured.length = 0;
  };

  const ROLLBACK = new Error('rolled back');

  /** Runs `body` in a transaction that is rolled back — the case leaves nothing behind */
  const inRolledBackTransaction = async (body: (tx: OnConflictDatabase) => Promise<void>): Promise<void> => {
    try {
      await db.transaction(async tx => {
        await body(tx as OnConflictDatabase);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
  };

  /** The candidates of `batch` as a table subquery built by `kind`, and the CTEs the statement must declare */
  const sourceOf = (target: OnConflictDatabase, kind: SourceKind, scenario: Scenario, batch: number): { source: any; with?: any[] } => {
    const project = (c: any) => ({ code: c.code, bank: c.bank, slot: c.slot, tag: c.tag, holderId: c.holderId, active: c.active, size: c.size });

    switch (kind) {
      case 'entity':
        return { source: target.candidates.where(c => eq(c.batch, batch)).select(project).asSubquery('table') };
      case 'grouped':
        return {
          source: target.candidates
            .where(c => eq(c.batch, batch))
            .select(c => ({ id: c.id, ...project(c) }))
            .groupBy(c => ({ id: c.id, code: c.code, bank: c.bank, slot: c.slot, tag: c.tag, holderId: c.holderId, active: c.active, size: c.size }))
            .select(g => ({ code: g.key.code, bank: g.key.bank, slot: g.key.slot, tag: g.key.tag, holderId: g.key.holderId, active: g.key.active, size: g.key.size }))
            .asSubquery('table'),
        };
      case 'cte-declared':
      case 'cte-nested': {
        const pending = new DbCteBuilder().with('ic_pending', target.candidates.where(c => eq(c.batch, batch)).select(project));
        const source = target.selectFromCte(pending.cte).select(project).asSubquery('table');

        return kind === 'cte-declared' ? { source, with: [pending.cte] } : { source };
      }
      case 'set': {
        const c = scenario.candidates;

        return {
          source: fromSet(unnestZip({
            code: { values: c.map(r => r.code), type: 'varchar' },
            bank: { values: c.map(r => r.bank), type: 'integer' },
            slot: { values: c.map(r => r.slot), type: 'integer' },
            tag: { values: c.map(r => r.tag), type: 'text' },
            holderId: { values: c.map(r => r.holderId), type: 'integer' },
            active: { values: c.map(r => r.active), type: 'boolean' },
            size: { values: c.map(r => sizeMapper.toDriver(r.size)), type: 'smallint' },
          }), 'cand').select(project).asSubquery('table'),
        };
      }
      case 'union':
        return {
          source: target.candidates.where(c => eq(c.batch, batch)).where(c => eq(sql<number>`${c.id} % 2`, 1)).select(project)
            .unionAll(target.candidates.where(c => eq(c.batch, batch)).where(c => eq(sql<number>`${c.id} % 2`, 0)).select(project))
            .asSubquery('table'),
        };
    }
  };

  const mapOf = (kind: MapKind) => (src: any): any => {
    const base = { code: src.code, bank: src.bank, slot: src.slot, tag: src.tag, holderId: src.holderId, active: src.active, size: src.size };

    switch (kind) {
      case 'refs':
        return { ...base, note: null };
      case 'constants':
        return { ...base, note: 'imported' };
      case 'expressions':
        return { ...base, slot: add(src.slot, 0), note: concat('n-', src.code) };
    }
  };

  const optionsOf = (sourceWith: any[] | undefined, filtered: boolean, onConflictDoNothing: boolean | undefined): InsertFromOptions<any> => ({
    ...(sourceWith ? { with: sourceWith } : {}),
    ...(filtered ? { where: (src: any) => gt(src.slot, 0) } : {}),
    ...(onConflictDoNothing === undefined ? {} : { onConflictDoNothing }),
  });

  const tableRows = async (target: OnConflictDatabase = db) => sortRows((await target.lockers.select(l => ({
    code: l.code, bank: l.bank, slot: l.slot, tag: l.tag, holderId: l.holderId, active: l.active, size: l.size, note: l.note,
  })).toList()).map(r => ({ ...r })));

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new OnConflictDatabase(client, {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS ic_lockers, ic_candidates, ic_ledger, ic_banks CASCADE');
    await db.getSchemaManager().ensureCreated();
    await db.banks.insertBulk(Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `bank-${i + 1}` })));
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS ic_lockers, ic_candidates, ic_ledger, ic_banks CASCADE');
    await db.dispose();
  });

  let batch = 0;

  describe('matrix: scenario × source × map × terminal × where', () => {
    for (const scenario of SCENARIOS) {
      for (const sourceKind of SOURCES) {
        for (const mapKind of MAPS) {
          for (const terminal of TERMINALS) {
            for (const filtered of [false, true]) {
              test(`${scenario.name} | ${sourceKind} | ${mapKind} | ${terminal}${filtered ? ' | where' : ''}`, async () => {
                const currentBatch = ++batch;

                await inRolledBackTransaction(async tx => {
                  await seed(tx, scenario, currentBatch);

                  const { source, with: sourceWith } = sourceOf(tx, sourceKind, scenario, currentBatch);
                  const insert = tx.lockers.insertFrom(source, mapOf(mapKind), optionsOf(sourceWith, filtered, true));
                  const oracle = simulate(scenario, filtered);
                  const expectedInserted = sortRows(oracle.inserted).map(r => ({ code: r.code, size: r.size, note: noteOf(mapKind, r) }));

                  let returned: Array<{ id: number; code: string; size: Size; note: string | null }> | undefined;

                  switch (terminal) {
                    case 'await':
                      expect(await insert).toBeUndefined();
                      break;
                    case 'returning':
                      returned = (await insert.returning(l => ({ id: l.id, code: l.code, size: l.size, note: l.note }))).map(r => ({ ...r, note: r.note ?? null }));
                      break;
                    case 'returning-all':
                      returned = (await insert.returning()).map(r => ({ id: r.id, code: r.code, size: r.size, note: r.note ?? null }));
                      break;
                    case 'returning-navigation': {
                      const rows = await insert.returning(l => ({ id: l.id, code: l.code, size: l.size, note: l.note, bankName: l.bankRow!.name }));
                      // The navigation reads the inserted row's bank, for exactly the inserted rows
                      for (const r of rows) {
                        const expected = oracle.inserted.find(i => i.code === r.code)!;
                        expect(r.bankName).toBe(`bank-${expected.bank}`);
                      }
                      returned = rows.map(r => ({ id: r.id, code: r.code, size: r.size, note: r.note ?? null }));
                      break;
                    }
                    case 'statement': {
                      if (sourceWith) {
                        // A plain CTE the compiled statement declares in its own WITH
                        expect(insert.toStatement(l => ({ id: l.id })).sql.startsWith('WITH "ic_pending" AS (')).toBe(true);
                      }
                      const ins = new DbCteBuilder().withMutation('ic_ins', insert.toStatement(l => ({ id: l.id, code: l.code, size: l.size, note: l.note })));
                      returned = (await tx.selectFromCte(ins.cte).select(r => ({ id: r.id, code: r.code, size: r.size, note: r.note })).toList())
                        .map(r => ({ ...r, note: r.note ?? null }));
                      break;
                    }
                  }

                  // The table: exactly the oracle's rows
                  expect(await tableRows(tx)).toEqual(sortRows([
                    ...scenario.existing.map(r => ({ ...r, note: null as string | null })),
                    ...oracle.inserted.map(r => ({ ...r, note: noteOf(mapKind, r) })),
                  ]));

                  if (returned !== undefined) {
                    // RETURNING yields the inserted rows only — read through the columns' mappers — and their ids are theirs
                    expect([...returned].sort((a, b) => a.code.localeCompare(b.code)).map(r => ({ code: r.code, size: r.size, note: r.note })))
                      .toEqual(expectedInserted.sort((a, b) => a.code.localeCompare(b.code)));
                    const ids = new Map((await tx.lockers.select(l => ({ id: l.id, code: l.code })).toList()).map(r => [r.code, r.id]));
                    for (const r of returned) {
                      expect(ids.get(r.code)).toBe(r.id);
                    }
                  }

                  // The SQL: the statement without the option, plus ON CONFLICT DO NOTHING before RETURNING
                  const statements = insertStatements();
                  expect(statements).toHaveLength(1);
                  const executed = statements[0];
                  const plain = tx.lockers.insertFrom(sourceOf(tx, sourceKind, scenario, currentBatch).source, mapOf(mapKind), optionsOf(sourceWith, filtered, undefined));
                  const plainSql = plain.toStatement().sql;
                  const withOption = tx.lockers.insertFrom(sourceOf(tx, sourceKind, scenario, currentBatch).source, mapOf(mapKind), optionsOf(sourceWith, filtered, true));
                  const optionOff = tx.lockers.insertFrom(sourceOf(tx, sourceKind, scenario, currentBatch).source, mapOf(mapKind), optionsOf(sourceWith, filtered, false));

                  expect(withOption.toStatement().sql).toBe(`${plainSql} ON CONFLICT DO NOTHING`);
                  expect(optionOff.toStatement().sql).toBe(plainSql);
                  expect(withOption.toStatement(l => ({ id: l.id })).sql).toBe(
                    plain.toStatement(l => ({ id: l.id })).sql.replace(' RETURNING "id" AS "id"', ' ON CONFLICT DO NOTHING RETURNING "id" AS "id"')
                  );

                  if (terminal === 'await') {
                    expect(executed.endsWith(' ON CONFLICT DO NOTHING')).toBe(true);
                  } else {
                    expect(executed).toContain(' ON CONFLICT DO NOTHING RETURNING ');
                    expect(executed.indexOf(' ON CONFLICT DO NOTHING')).toBe(executed.lastIndexOf(' ON CONFLICT DO NOTHING'));
                  }

                  if (filtered) {
                    expect(executed).toContain('WHERE "src"."slot" > ');
                    expect(executed.indexOf('WHERE "src"."slot" > ')).toBeLessThan(executed.indexOf(' ON CONFLICT DO NOTHING'));
                  }
                });
              });
            }
          }
        }
      }
    }
  });

  describe('semantics', () => {
    test('without the option a conflicting row raises 23505 (the control), with it the statement inserts the rest', async () => {
      const scenario = SCENARIOS.find(s => s.name === 'every index at once')!;

      for (const sourceKind of SOURCES) {
        const currentBatch = ++batch;
        await reset(scenario, currentBatch);
        const { source, with: sourceWith } = sourceOf(db, sourceKind, scenario, currentBatch);

        const error = await expectToReject(db.lockers.insertFrom(source, mapOf('refs'), optionsOf(sourceWith, false, undefined)));
        expect(sqlStateOf(error)).toBe('23505');
        expect(await db.lockers.count()).toBe(1);

        await db.lockers.insertFrom(source, mapOf('refs'), optionsOf(sourceWith, false, true));
        expect((await tableRows()).map(r => r.code)).toEqual(['A', 'P']);
      }
    });

    test('a primary-key conflict is skipped like any other unique index', async () => {
      await client.query('TRUNCATE ic_ledger');
      await db.ledger.insertBulk([{ id: 1, amount: 10 }, { id: 2, amount: 20 }]);

      const source = fromSet(unnestZip({
        id: { values: [2, 3, 3, 4], type: 'integer' },
        amount: { values: [200, 300, 300, 400], type: 'integer' },
      }), 'l').select(l => ({ id: l.id, amount: l.amount })).asSubquery('table');

      const rows = await db.ledger.insertFrom(source, src => ({ id: src.id, amount: src.amount }), { onConflictDoNothing: true })
        .returning(l => ({ id: l.id, amount: l.amount }));

      expect(rows.map(r => ({ ...r })).sort((a, b) => a.id - b.id)).toEqual([{ id: 3, amount: 300 }, { id: 4, amount: 400 }]);
      expect((await db.ledger.orderBy(l => l.id).select(l => ({ id: l.id, amount: l.amount })).toList()).map(r => ({ ...r })))
        .toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 300 }, { id: 4, amount: 400 }]);
    });

    test('every row that reached the insertion took a sequence value, skipped or not — a row the where filtered took none', async () => {
      for (const scenario of SCENARIOS) {
        for (const filtered of [false, true]) {
          const currentBatch = ++batch;
          await reset(scenario, currentBatch, true);
          const start = scenario.existing.length;
          const { source } = sourceOf(db, 'entity', scenario, currentBatch);

          await db.lockers.insertFrom(source, mapOf('refs'), optionsOf(undefined, filtered, true));

          const [fresh] = await db.lockers.insertBulk([row(`fresh-${currentBatch}`, 9, 1000 + currentBatch)]).returning(l => ({ id: l.id }));
          expect(fresh.id).toBe(start + simulate(scenario, filtered).processed + 1);
        }
      }
    });

    test('the inserted rows of a compiled statement feed the main query: a skipped row is in no RETURNING', async () => {
      const scenario = SCENARIOS.find(s => s.name === 'every index at once')!;
      const currentBatch = ++batch;
      await reset(scenario, currentBatch);

      const ins = new DbCteBuilder().withMutation(
        'ic_ins',
        db.lockers.insertFrom(sourceOf(db, 'entity', scenario, currentBatch).source, mapOf('constants'), { onConflictDoNothing: true })
          .toStatement(l => ({ id: l.id, code: l.code }))
      );
      const audited = await db.banks
        .with(ins.cte)
        .where(b => eq(b.id, 8))
        .select(b => ({
          bank: b.name,
          inserted: db.selectFromCte(ins.cte).select(r => agg.arrayAgg(r.code)).asSubquery('scalar'),
        }))
        .toList();

      expect(audited.map(r => ({ ...r })) as unknown).toEqual([{ bank: 'bank-8', inserted: ['P'] }]);
      expect(await db.lockers.count()).toBe(2);
    });

    // Needs a second session beside an open transaction — PGlite runs one
    test.skipIf(PGLITE)('a concurrent insert of the same key is absorbed: the waiter skips it once the holder commits, inserts it after a rollback', async () => {
      const client2 = createFreshClient();
      const db2 = new OnConflictDatabase(client2, { logQueries: false });
      const pause = () => new Promise(resolve => setTimeout(resolve, 250));
      const setSource = (codes: string[], bank: number) => fromSet(unnestZip({
        code: { values: codes, type: 'varchar' },
        slot: { values: codes.map((_, i) => i + 1), type: 'integer' },
      }), 'k').select(k => ({ code: k.code, slot: k.slot })).asSubquery('table');
      const waiter = (codes: string[], bank: number, options: InsertFromOptions<any>) => Promise.resolve(db2.lockers.insertFrom(
        setSource(codes, bank),
        src => ({ code: src.code, bank, slot: src.slot, active: false, size: 'small' as Size }),
        options
      ).returning(l => ({ code: l.code })));

      try {
        for (const outcome of ['commit', 'rollback'] as const) {
          await client.query('TRUNCATE ic_lockers RESTART IDENTITY');
          let pending!: Promise<Array<{ code: string }>>;

          const holder = client.transaction(async query => {
            await query(`INSERT INTO ic_lockers (code, bank, slot, active, size) VALUES ('K', 1, 1, false, 1)`);
            pending = waiter(['K', 'L'], 7, { onConflictDoNothing: true });
            await pause();

            if (outcome === 'rollback') {
              throw new Error('roll back');
            }
          });

          if (outcome === 'rollback') {
            await expectToReject(holder, 'roll back');
          } else {
            await holder;
          }

          const rows = await pending;
          expect(rows.map(r => r.code).sort()).toEqual(outcome === 'commit' ? ['L'] : ['K', 'L']);
          expect((await tableRows()).map(r => r.code)).toEqual(['K', 'L']);
        }

        // A notExists guard is not the same: the waiter's snapshot did not see the holder's row, so its insert
        // collides with it once the holder commits
        await client.query('TRUNCATE ic_lockers RESTART IDENTITY');
        let guarded!: Promise<unknown>;

        await client.transaction(async query => {
          await query(`INSERT INTO ic_lockers (code, bank, slot, active, size) VALUES ('K', 1, 1, false, 1)`);
          guarded = waiter(['K', 'L'], 7, {
            where: (src: any) => notExists(db2.lockers.where(l => eq(l.code, src.code)).select(l => ({ id: l.id })).asSubquery()),
          }).catch(error => error);
          await pause();
        });

        expect(sqlStateOf(await guarded)).toBe('23505');
      } finally {
        await db2.dispose();
      }
    });
  });

  describe('typings', () => {
    test('the option is a boolean of InsertFromOptions, the statement types its RETURNING as before', () => {
      const typed = (target: OnConflictDatabase) => {
        const source = target.candidates.select(c => ({ code: c.code, bank: c.bank, slot: c.slot })).asSubquery('table');
        const insert = target.lockers.insertFrom(source, src => ({ code: src.code, bank: src.bank, slot: src.slot, active: true, size: 'large' }), {
          onConflictDoNothing: true,
          where: src => gt(src.slot, 0),
        });
        const returned: PromiseLike<Array<{ id: number; size: Size }>> = insert.returning(l => ({ id: l.id, size: l.size }));

        // @ts-expect-error — a boolean, nothing else
        target.lockers.insertFrom(source, src => ({ code: src.code, bank: src.bank, slot: src.slot, active: true, size: 'large' }), { onConflictDoNothing: 'yes' });

        return returned;
      };

      expect(typeof typed).toBe('function');
    });
  });
});
