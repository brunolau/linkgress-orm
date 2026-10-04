import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, boolean as pgBoolean, createCustomType, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, eqAny, exists, integer,
  jsonb, MutationBatch, numeric, serial, smallint, sql, text, timestamp, varchar,
} from '../../src';
import type { BulkUpdateLegConfig, DatabaseClient, InsertLegOptions, LegFitOptions, MutationBatchKey } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * `MutationBatch.addInsertBulk(table, rows, id, { returning: [...] })` → `getLegRows(id)`: the rows an insert leg
 * inserted, read back in the batch's ONE statement — the contract `addUpsertBulk(…, { returning })` has (raw JSON
 * values: json_agg readback, no fromDriver pass; rows unordered). With `onConflictDoNothing` only the inserted
 * rows come back, with a `rowGuard` only the admitted ones.
 *
 * And `executeBatch()` refuses a statement whose parameters total more than PostgreSQL's 65 535 BEFORE it is sent
 * (each leg is checked against its own budget at registration; the sum was not checked) — `parameterCount` tells
 * a caller how many the registered legs bind.
 *
 * And `ifFits` (every leg kind with a standalone form): a leg registers only when the statement can carry it — its
 * own budget AND the statement's parameter limit — or is declined (null, nothing registered). The matrix: 8 leg kinds
 * (the plain insert with an SQL fragment cell; the row-guarded insert; the upsert; the bulk update; the where-in
 * delete; the where-in update, plain and guarded by `where`; the insert with children — each with its readback or
 * exposure) × 7 situations (no input; a leg that fits, alone and between other legs; at its own budget and one unit
 * over; the leg that brings the statement to exactly its limit and one parameter over) × 2 limits (the client's own;
 * PGlite's 32 767, simulated on a client that takes more). Two ORACLES: the same leg registered without the option —
 * it throws as it registers, or `executeBatch()` refuses the statement, exactly when `ifFits` declines, and compiles
 * to the same statement when it fits; and the leg's input written STANDALONE (what a caller does with a declined
 * leg) — the same rows, count and readback as the leg, each statement within the limit.
 *
 * The matrix: RETURNING lists (the key, plain columns, a mapped / jsonb / timestamp / numeric / boolean column) ×
 * leg kinds (plain, ON CONFLICT DO NOTHING with conflicts against the table and inside the leg, a raw-SQL and a
 * typed row guard, OVERRIDING SYSTEM VALUE) × batch compositions (alone, beside a second insert leg with RETURNING,
 * beside update and delete legs, beside an upsert leg with RETURNING). The ORACLE is the table itself: the rows
 * a leg returns are exactly the rows it inserted — the same JSON a `row_to_json` of the stored rows renders.
 */

type Kind = 'letter' | 'box';

const kindMapper = createCustomType<{ data: Kind; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Kind | null | undefined) => (value == null ? null : value === 'box' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'box' : 'letter'),
});

class MbrRoute extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  open!: DbColumn<boolean>;
}

class MbrParcel extends DbEntity {
  id!: DbColumn<number>;
  route!: DbColumn<number>;
  label!: DbColumn<string>;
  weight?: DbColumn<string | null>;
  sentAt?: DbColumn<Date | null>;
  kind!: DbColumn<Kind>;
  meta?: DbColumn<Record<string, unknown> | null>;
  urgent!: DbColumn<boolean>;
}

class MbrTally extends DbEntity {
  route!: DbColumn<number>;
  total!: DbColumn<number>;
}

/** A parcel's child row — the child of an insert-with-children leg (`ifFits` covers every leg kind) */
class MbrScan extends DbEntity {
  id!: DbColumn<number>;
  parcelId!: DbColumn<number>;
  note!: DbColumn<string>;
}

class InsertReturningDatabase extends DbContext {
  get routes(): DbEntityTable<MbrRoute> {
    return this.table(MbrRoute);
  }

  get parcels(): DbEntityTable<MbrParcel> {
    return this.table(MbrParcel);
  }

  get tallies(): DbEntityTable<MbrTally> {
    return this.table(MbrTally);
  }

  get scans(): DbEntityTable<MbrScan> {
    return this.table(MbrScan);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MbrRoute, entity => {
      entity.toTable('mbr_routes');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
      entity.property(e => e.open).hasType(pgBoolean('open')).isRequired();
    });

    model.entity(MbrParcel, entity => {
      entity.toTable('mbr_parcels');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.route).hasType(integer('route')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 40)).isRequired();
      entity.property(e => e.weight).hasType(numeric('weight', 8, 2));
      entity.property(e => e.sentAt).hasType(timestamp('sent_at'));
      entity.property(e => e.kind).hasType(smallint('kind')).isRequired().hasCustomMapper(kindMapper);
      entity.property(e => e.meta).hasType(jsonb('meta'));
      entity.property(e => e.urgent).hasType(pgBoolean('urgent')).isRequired();
      entity.hasIndex('ux_mbr_parcels_label', e => [e.label]).isUnique();
    });

    model.entity(MbrTally, entity => {
      entity.toTable('mbr_tallies');
      entity.property(e => e.route).hasType(integer('route')).isPrimaryKey();
      entity.property(e => e.total).hasType(integer('total')).isRequired();
    });

    model.entity(MbrScan, entity => {
      entity.toTable('mbr_scans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mbr_scans_id_seq' }));
      entity.property(e => e.parcelId).hasType(integer('parcel_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 40)).isRequired();
    });
  }
}

type ParcelInput = { id?: number; route: number; label: string; weight: number | null; sentAt: Date | null; kind: Kind; meta: Record<string, unknown> | null; urgent: boolean };

const parcel = (label: string, route: number, extra: Partial<ParcelInput> = {}): ParcelInput => ({
  route, label, weight: 12.5, sentAt: new Date(2026, 2, 4, 5, 6, 7), kind: 'box', meta: { tags: ['a', 'b'], n: 1 }, urgent: false, ...extra,
});

type ReturningKind = 'key' | 'plain' | 'typed';

const RETURNING: Record<ReturningKind, Array<keyof MbrParcel & string>> = {
  key: ['id'],
  plain: ['id', 'route', 'label'],
  typed: ['id', 'label', 'kind', 'meta', 'sentAt', 'weight', 'urgent'],
};

/** The stored columns of each property, for the oracle's row_to_json */
const DB_NAMES: Record<string, string> = { id: 'id', route: 'route', label: 'label', weight: 'weight', sentAt: 'sent_at', kind: 'kind', meta: 'meta', urgent: 'urgent' };

type LegKind = 'plain' | 'on-conflict' | 'guard-sql' | 'guard-typed' | 'overriding';
type Composition = 'alone' | 'second-insert' | 'update-delete' | 'upsert';

const LEGS: LegKind[] = ['plain', 'on-conflict', 'guard-sql', 'guard-typed', 'overriding'];
const COMPOSITIONS: Composition[] = ['alone', 'second-insert', 'update-delete', 'upsert'];

describe('MutationBatch: insert-leg RETURNING and the statement parameter guard', () => {
  let client: DatabaseClient;
  let db: InsertReturningDatabase;
  const captured: string[] = [];

  /** The stored rows of `ids`, as row_to_json renders them — the JSON contract of a leg's readback */
  const storedJson = async (props: readonly string[], ids: number[]): Promise<Array<Record<string, unknown>>> => {
    const columns = props.map(p => `"${DB_NAMES[p]}" AS "${p}"`).join(', ');
    const result = await client.query(
      `SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p."id"), '[]'::json) AS rows FROM (SELECT ${columns}${props.includes('id') ? '' : ', "id"'} FROM mbr_parcels WHERE "id" = ANY($1::integer[])) p`,
      [`{${ids.join(',')}}`]
    );
    const raw = result.rows[0].rows;
    const rows: Array<Record<string, unknown>> = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return rows.map(r => Object.fromEntries(props.map(p => [p, r[p]])));
  };

  const sortById = (rows: Array<Record<string, unknown>>) => [...rows].sort((a, b) => Number(a.id) - Number(b.id));

  /** The most parameters a statement binds through the client: PostgreSQL's 65 535, PGlite's 32 767 */
  const limitText = () => (client.maxParameters() === 65535 ? "PostgreSQL's 65 535" : 'the 32 767 this client takes');

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new InsertReturningDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS mbr_scans, mbr_parcels, mbr_routes, mbr_tallies CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS mbr_scans, mbr_parcels, mbr_routes, mbr_tallies CASCADE');
    await db.dispose();
  });

  const reset = async () => {
    await client.query('TRUNCATE mbr_scans, mbr_parcels, mbr_routes, mbr_tallies RESTART IDENTITY');
    await db.routes.insertBulk([{ id: 1, name: 'north', open: true }, { id: 2, name: 'south', open: false }, { id: 3, name: 'east', open: true }]);
    await db.parcels.insertBulk([parcel('P-old', 1, { kind: 'letter' })]);
    await db.tallies.insertBulk([{ route: 1, total: 5 }]);
    captured.length = 0;
  };

  /** The leg's rows and options — and which labels the oracle expects it to insert */
  const legOf = (kind: LegKind): { rows: ParcelInput[]; options: InsertLegOptions<MbrParcel>; expected: string[] } => {
    switch (kind) {
      case 'plain':
        return { rows: [parcel('P-1', 1), parcel('P-2', 2, { meta: null, sentAt: null, weight: null, urgent: true })], options: {}, expected: ['P-1', 'P-2'] };
      case 'on-conflict':
        return {
          rows: [parcel('P-old', 1), parcel('P-1', 1), parcel('P-1', 3), parcel('P-2', 2)],
          options: { onConflictDoNothing: true },
          expected: ['P-1', 'P-2'],
        };
      case 'guard-sql':
        return { rows: [parcel('P-1', 1), parcel('P-2', 2), parcel('P-3', 3)], options: { rowGuard: 'v."route" <> 2' }, expected: ['P-1', 'P-3'] };
      case 'guard-typed':
        return {
          rows: [parcel('P-1', 1), parcel('P-2', 2), parcel('P-3', 3)],
          options: { rowGuard: v => exists(db.routes.where(r => and(eq(r.id, v.route), eq(r.open, true))).select(r => ({ id: r.id })).asSubquery()) },
          expected: ['P-1', 'P-3'],
        };
      case 'overriding':
        return { rows: [parcel('P-1', 1, { id: 101 }), parcel('P-2', 2, { id: 102 })], options: { overridingSystemValue: true }, expected: ['P-1', 'P-2'] };
    }
  };

  describe('matrix: RETURNING list × leg kind × composition', () => {
    for (const returningKind of ['key', 'plain', 'typed'] as ReturningKind[]) {
      for (const legKind of LEGS) {
        for (const composition of COMPOSITIONS) {
          test(`${returningKind} | ${legKind} | ${composition}`, async () => {
            await reset();
            const leg = legOf(legKind);
            const props = RETURNING[returningKind];
            const batch = new MutationBatch();

            const key = batch.addInsertBulk(db.parcels, leg.rows, 'parcels', { ...leg.options, returning: props });
            expect(key).toEqual({ id: 'parcels' });

            if (composition === 'second-insert') {
              batch.addInsertBulk(db.routes, [{ id: 4, name: 'west', open: true }], 'routes', { returning: ['id', 'name'] });
            } else if (composition === 'update-delete') {
              batch.addUpdateWhereIn(db.routes as any, 'id', [3], { name: 'east-2' }, 'rename');
              batch.addDeleteWhereIn(db.tallies as any, 'route', [1], 'drop');
            } else if (composition === 'upsert') {
              batch.addUpsertBulk(db.tallies, [{ route: 1, total: 7 }, { route: 3, total: 1 }], { primaryKey: 'route', updateColumns: ['total'] }, 'tally', { returning: ['route', 'total'] });
            }

            await batch.executeBatch();

            // ONE statement
            expect(captured.filter(entry => entry.startsWith('WITH '))).toHaveLength(1);

            // The oracle: the leg's rows are exactly the rows it inserted, as the table stores them
            const inserted = await db.parcels.select(p => ({ id: p.id, label: p.label })).toList();
            const insertedIds = inserted.filter(p => p.label !== 'P-old').map(p => p.id);
            expect(inserted.filter(p => p.label !== 'P-old').map(p => p.label).sort()).toEqual(leg.expected);

            const legRows = batch.getLegRows('parcels');
            expect(sortById(legRows)).toEqual(await storedJson(props, insertedIds));
            expect(batch.getAffectedCount('parcels')).toBe(leg.expected.length);
            expect(legRows.every(r => Object.keys(r).sort().join() === [...props].sort().join())).toBe(true);

            if (legKind === 'overriding') {
              expect(legRows.map(r => r.id).sort()).toEqual([101, 102]);
            }

            if (composition === 'second-insert') {
              expect(batch.getLegRows('routes')).toEqual([{ id: 4, name: 'west' }]);
            } else if (composition === 'update-delete') {
              expect(batch.getAffectedCount('rename')).toBe(1);
              expect(batch.getAffectedCount('drop')).toBe(1);
              expect(() => batch.getLegRows('rename')).toThrow('was not registered with a returning list');
            } else if (composition === 'upsert') {
              expect([...batch.getLegRows('tally')].sort((a: any, b: any) => a.route - b.route)).toEqual([{ route: 1, total: 7 }, { route: 3, total: 1 }]);
            }
          });
        }
      }
    }
  });

  describe('the readback', () => {
    test('raw JSON values, the same on every engine: no fromDriver pass, numeric and timestamp as JSON renders them', async () => {
      await reset();
      const batch = new MutationBatch();
      batch.addInsertBulk(db.parcels, [parcel('P-1', 3, { weight: 7.25 })], 'p', { returning: RETURNING.typed });
      await batch.executeBatch();

      const [rowRead] = batch.getLegRows('p');
      expect(rowRead).toEqual({
        id: 2,
        label: 'P-1',
        kind: 2,
        meta: { tags: ['a', 'b'], n: 1 },
        sentAt: '2026-03-04T05:06:07',
        weight: 7.25,
        urgent: false,
      });
    });

    test('a leg registered without returning still has no rows to read; an unknown column is refused at registration', async () => {
      await reset();
      const batch = new MutationBatch();
      batch.addInsertBulk(db.parcels, [parcel('P-1', 1)], 'p');

      expect(() => batch.addInsertBulk(db.parcels, [parcel('P-2', 1)], 'q', { returning: ['id', 'nope' as any] })).toThrow('Unknown column property "nope"');

      await batch.executeBatch();
      expect(batch.getAffectedCount('p')).toBe(1);
      expect(() => batch.getLegRows('p')).toThrow('MutationBatch: leg "p" was not registered with a returning list — no rows to read');
    });

    test('an empty leg registers nothing and has no rows; a leg whose every row is skipped returns []', async () => {
      await reset();
      const batch = new MutationBatch();

      expect(batch.addInsertBulk(db.parcels, [], 'none', { returning: ['id'] })).toBeNull();
      batch.addInsertBulk(db.parcels, [parcel('P-old', 1)], 'skipped', { onConflictDoNothing: true, returning: ['id', 'label'] });
      await batch.executeBatch();

      expect(batch.getLegRows('skipped')).toEqual([]);
      expect(batch.getAffectedCount('skipped')).toBe(0);
      expect(() => batch.getLegRows('none')).toThrow('was not registered with a returning list');
    });

    test('typings: the returning list names the entity\'s columns', () => {
      const typed = (target: InsertReturningDatabase) => {
        const batch = new MutationBatch();
        batch.addInsertBulk(target.parcels, [parcel('P-1', 1)], 'p', { returning: ['id', 'label', 'sentAt'] });
        // @ts-expect-error — not a column of the entity
        batch.addInsertBulk(target.parcels, [parcel('P-2', 1)], 'q', { returning: ['id', 'nope'] });

        return batch;
      };

      expect(typeof typed).toBe('function');
    });
  });

  describe('the statement parameter guard', () => {
    /** 5 parameters per row (route, label, weight, kind, urgent): the per-leg budget is ⌊⌊65535 / 5⌋ · 0.6⌋ = 7 864 rows */
    const rows = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ route: 1, label: `${prefix}-${i}`, weight: 1, kind: 'letter' as Kind, urgent: false }));

    test('parameterCount is the parameters the registered legs bind', async () => {
      await reset();
      const batch = new MutationBatch();
      expect(batch.parameterCount).toBe(0);

      batch.addInsertBulk(db.parcels, rows('a', 3), 'a', { returning: ['id'] });
      expect(batch.parameterCount).toBe(15);
      batch.addDeleteWhereIn(db.tallies as any, 'route', [1, 2], 'd');
      expect(batch.parameterCount).toBe(17);
      batch.addUpsertBulk(db.tallies, [{ route: 9, total: 1 }], { primaryKey: 'route', updateColumns: ['total'] }, 'u');
      expect(batch.parameterCount).toBe(19);
    });

    test('a statement over the limit is refused before it is sent — legs each within their own budget', async () => {
      await reset();
      const batch = new MutationBatch();
      batch.addInsertBulk(db.parcels, rows('a', 7000), 'a', { returning: ['id'] });
      batch.addInsertBulk(db.parcels, rows('b', 7000), 'b');
      expect(batch.parameterCount).toBe(70000);

      await expectToReject(batch.executeBatch(), `MutationBatch: the statement binds 70000 parameters — over ${limitText()}`);
      expect(captured.filter(entry => entry.startsWith('WITH '))).toHaveLength(0);
      expect(await db.parcels.count()).toBe(1);
    });

    test('a statement of exactly the limit runs; one more is refused', async () => {
      const limit = client.maxParameters();
      // the first leg within its own budget, the second the rest of the 5-parameter rows, a delete leg the remainder
      const first = Math.min(7864, Math.floor(limit / 5));
      const second = Math.floor((limit - first * 5) / 5);
      const remainder = limit - (first + second) * 5;
      const build = (extra: number) => {
        const batch = new MutationBatch();
        batch.addInsertBulk(db.parcels, rows('a', first), 'a', { returning: ['id'] });
        if (second > 0) {
          batch.addInsertBulk(db.parcels, rows('b', second), 'b');
        }
        if (remainder + extra > 0) {
          batch.addDeleteWhereIn(db.tallies as any, 'route', Array.from({ length: remainder + extra }, (_, i) => 100 + i), 'd');
        }
        return batch;
      };

      await reset();
      const full = build(0);
      expect(full.parameterCount).toBe(limit);
      await full.executeBatch();
      expect(full.getLegRows('a')).toHaveLength(first);
      expect(await db.parcels.count()).toBe(1 + first + second);

      await reset();
      const over = build(1);
      expect(over.parameterCount).toBe(limit + 1);
      await expectToReject(over.executeBatch(), `MutationBatch: the statement binds ${limit + 1} parameters — over ${limitText()}`);
      expect(await db.parcels.count()).toBe(1);
      expect(await db.tallies.count()).toBe(1);
    }, 120000);
  });

  describe('ifFits: a leg registers only when the statement can carry it — every leg kind with a standalone form', () => {
    type FitKind = 'insert' | 'insert-guarded' | 'upsert' | 'bulk-update' | 'delete-where-in' | 'update-where-in' | 'update-where-in-guarded' | 'insert-with-children';
    type Situation = 'zero' | 'fit' | 'fit-composed' | 'at-own-budget' | 'over-own-budget' | 'at-statement-limit' | 'over-statement-limit';
    /** The most parameters a statement binds: the client's own (PostgreSQL's 65 535, PGlite's 32 767) — or PGlite's on a client that takes more */
    type Limit = 'client' | 'pglite';

    const FIT_KINDS: FitKind[] = ['insert', 'insert-guarded', 'upsert', 'bulk-update', 'delete-where-in', 'update-where-in', 'update-where-in-guarded', 'insert-with-children'];
    const SITUATIONS: Situation[] = ['zero', 'fit', 'fit-composed', 'at-own-budget', 'over-own-budget', 'at-statement-limit', 'over-statement-limit'];
    const LIMITS: Limit[] = ['client', 'pglite'];
    const PGLITE_LIMIT = 32767;

    /**
     * A leg's own budget in the units {@link register} takes — the rows a standalone mutation sends in one chunk on
     * PostgreSQL, ⌊⌊65 535 / columns⌋ · 0.6⌋ of the leg's first row: 5 columns for a parcel, 2 for a tally or a renamed
     * route, 1 for a where-in value; an insert with children counts its parents AND their children (one each).
     */
    const OWN_BUDGET: Record<FitKind, number> = {
      'insert': 7864,
      'insert-guarded': 7864,
      'upsert': 19660,
      'bulk-update': 19660,
      'delete-where-in': 39321,
      'update-where-in': 39321,
      'update-where-in-guarded': 39321,
      'insert-with-children': 3932,
    };

    /** The rows a leg of `units` units of each kind writes over the seeded rows (routes 1–3, 2 closed; tally 1) */
    const affectedBy = (kind: FitKind, units: number): number => {
      switch (kind) {
        case 'bulk-update':
        case 'update-where-in':
          return Math.min(units, 3);
        case 'update-where-in-guarded':
          return units >= 3 ? 2 : 1;
        case 'delete-where-in':
          return 1;
        default:
          return units;
      }
    };

    /** The leg kinds read back by getLegRows */
    const READBACK: FitKind[] = ['insert', 'insert-guarded', 'upsert', 'insert-with-children'];

    const keysOf = (units: number) => Array.from({ length: units }, (_, i) => 1 + i);

    /** `count` parcels of route 1 (open), labelled after `prefix` — 5 cells, each bound */
    const parcelRows = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ route: 1, label: `${prefix}-${i}`, weight: 1, kind: 'letter' as Kind, urgent: false }));

    /** The plain insert's rows: its `weight` is an SQL fragment — inline, it binds nothing (4 parameters for 5 cells) */
    const fragmentRows = (prefix: string, count: number) => keysOf(count).map(key => ({ route: 1, label: `${prefix}-${key}`, weight: sql`2.5`, kind: 'box' as Kind, urgent: true }));

    /** The guarded insert's typed row guard: it binds a parameter of its own */
    const routeOpen = (v: any) => exists(db.routes.where(r => and(eq(r.id, v.route), eq(r.open, true))).select(r => ({ id: r.id })).asSubquery());

    const withChildren = (id: string, units: number) => ({
      rows: parcelRows(id, units),
      children: { table: db.scans, foreignKey: 'parcelId', rows: keysOf(units).map((key, parentIndex) => ({ parentIndex, row: { note: `n-${key}` } })) },
    });

    /**
     * `units` of a leg of `kind` registered on `batch` as `id` — rows, values, or parents with one child each — with
     * the leg's readback or exposure; `fit` adds the option.
     */
    const register = (kind: FitKind, batch: MutationBatch, units: number, id: string, fit: LegFitOptions = {}): MutationBatchKey | null => {
      const keys = keysOf(units);

      switch (kind) {
        case 'insert':
          return batch.addInsertBulk(db.parcels, fragmentRows(id, units), id, { returning: ['id', 'label'], ...fit });
        case 'insert-guarded':
          return batch.addInsertBulk(db.parcels, parcelRows(id, units), id, { rowGuard: routeOpen, returning: ['id', 'label'], ...fit });
        case 'upsert':
          return batch.addUpsertBulk(db.tallies, keys.map(key => ({ route: key, total: 1 })), { primaryKey: 'route', updateColumns: ['total'] }, id, { returning: ['route', 'total'], ...fit });
        case 'bulk-update':
          return batch.addBulkUpdate(db.routes, keys.map(key => ({ id: key, name: `r-${key}` })), id, fit);
        case 'delete-where-in':
          return batch.addDeleteWhereIn(db.tallies as any, 'route', keys, id, fit);
        case 'update-where-in':
          return batch.addUpdateWhereIn(db.routes, 'id', keys, { open: false }, id, { exposeColumns: ['open'], ...fit });
        case 'update-where-in-guarded':
          return batch.addUpdateWhereIn(db.routes, 'id', keys, { open: false }, id, { where: r => eq(r.open, true), exposeOldColumns: ['open'], ...fit });
        case 'insert-with-children':
          return batch.addInsertBulkWithChildren(db.parcels as any, withChildren(id, units), id, { parentReturning: ['id', 'label'], ...fit });
      }
    };

    /**
     * What a caller does with the leg's input when `ifFits` declines it: the standalone mutation — chunked where it
     * chunks; the where-in legs as `where(eqAny(…))` (ONE array parameter); an insert with children as
     * `insertBulkWithChildren` (one statement, its own budget); a row-guarded insert, which has no standalone form, in
     * batches of its own, each registered `ifFits` and split in halves until it registers. Its readback as the leg's.
     */
    const standalone = async (kind: FitKind, units: number, id: string): Promise<{ affected: number; rows: Array<Record<string, unknown>> | null }> => {
      const keys = keysOf(units);

      switch (kind) {
        case 'insert': {
          const rows = await db.parcels.insertBulk(fragmentRows(id, units) as any).returning(p => ({ id: p.id, label: p.label }));

          return { affected: rows.length, rows };
        }
        case 'insert-guarded': {
          const rows: Array<Record<string, unknown>> = [];
          const write = async (part: ReturnType<typeof parcelRows>, partId: string): Promise<void> => {
            const batch = new MutationBatch();

            if (batch.addInsertBulk(db.parcels, part, partId, { rowGuard: routeOpen, returning: ['id', 'label'], ifFits: true }) == null) {
              const half = Math.ceil(part.length / 2);

              await write(part.slice(0, half), `${partId}a`);
              await write(part.slice(half), `${partId}b`);

              return;
            }

            await batch.executeBatch();
            rows.push(...batch.getLegRows(partId));
          };

          await write(parcelRows(id, units), id);

          return { affected: rows.length, rows };
        }
        case 'upsert': {
          const rows = await db.tallies.upsertBulk(keys.map(key => ({ route: key, total: 1 })), { primaryKey: 'route', updateColumns: ['total'] }).returning(t => ({ route: t.route, total: t.total }));

          return { affected: rows.length, rows };
        }
        case 'bulk-update': {
          const rows = await db.routes.bulkUpdate(keys.map(key => ({ id: key, name: `r-${key}` }))).returning(r => ({ id: r.id }));

          return { affected: rows.length, rows: null };
        }
        case 'delete-where-in':
          return { affected: await db.tallies.where(t => eqAny(t.route, keys)).delete().affectedCount(), rows: null };
        case 'update-where-in':
          return { affected: await db.routes.where(r => eqAny(r.id, keys)).update({ open: false }).affectedCount(), rows: null };
        case 'update-where-in-guarded':
          return { affected: await db.routes.where(r => and(eqAny(r.id, keys), eq(r.open, true))).update({ open: false }).affectedCount(), rows: null };
        case 'insert-with-children': {
          const { rows, children } = withChildren(id, units);
          const written = await db.parcels.insertBulkWithChildren({
            rows: rows as any,
            children,
            returning: { parents: p => ({ id: p.id, label: p.label }), children: s => ({ id: s.id }) },
          });

          return { affected: written.parents.length, rows: written.parents as any };
        }
      }
    };

    /**
     * A readback in a comparable form: its rows' generated keys checked against the table — the key of the row of that
     * label — then left out, the rows sorted (a readback is unordered, and a guarded insert numbers its rows in the
     * order its plan yields them)
     */
    const normalize = async (rows: Array<Record<string, unknown>> | null) => {
      if (rows == null) {
        return null;
      }

      if (rows.some(row => 'id' in row)) {
        const result = await client.query('SELECT COALESCE(json_object_agg("label", "id"), \'{}\'::json) AS ids FROM mbr_parcels');
        const raw = result.rows[0].ids;
        const ids: Record<string, number> = typeof raw === 'string' ? JSON.parse(raw) : raw;

        expect(rows.map(row => Number(row.id))).toEqual(rows.map(row => ids[row.label as string]));
      }

      return rows.map(({ id: _id, ...row }) => JSON.stringify(row)).sort();
    };

    /** The leg as registered — its statement, parameters and readback — without executing it */
    const compiled = (batch: MutationBatch) => (batch as any).legs.map((leg: any) => ({ sql: leg.sql, params: leg.params, returningSql: leg.returningSql, multi: leg.multi }));

    /** Delete legs matching no row, binding exactly `count` parameters between them (one leg takes at most 39 321 values) */
    const fill = (batch: MutationBatch, count: number) => {
      for (let offset = 0; offset < count; offset += 39321) {
        const size = Math.min(39321, count - offset);
        batch.addDeleteWhereIn(db.tallies as any, 'route', Array.from({ length: size }, (_, i) => 1000000 + offset + i), `fill-${offset}`);
      }
    };

    /**
     * Every row of the four tables — what a batch wrote. Without the generated keys: a guarded insert numbers its rows in
     * the order its plan yields them, which two runs need not share (a scan is read with its parcel's label).
     */
    const stored = async () => {
      const queries: Record<string, string> = {
        routes: 'SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."id"), \'[]\'::json) AS rows FROM mbr_routes t',
        parcels: 'SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."label"), \'[]\'::json) AS rows FROM (SELECT "route", "label", "weight", "sent_at", "kind", "meta", "urgent" FROM mbr_parcels) t',
        tallies: 'SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."route"), \'[]\'::json) AS rows FROM mbr_tallies t',
        scans: 'SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."parcel", t."note"), \'[]\'::json) AS rows FROM (SELECT p."label" AS "parcel", s."note" FROM mbr_scans s LEFT JOIN mbr_parcels p ON p."id" = s."parcel_id") t',
      };
      const out: Record<string, unknown> = {};

      for (const [table, query] of Object.entries(queries)) {
        const raw = (await client.query(query)).rows[0].rows;
        out[table] = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }

      return out;
    };

    /** The highest placeholder of each statement sent — the parameters it binds */
    const bound = (statements: string[]) => statements.map(statement => Math.max(0, ...Array.from(statement.matchAll(/\$(\d+)/g), match => Number(match[1]))));

    /** Run with the statement limit `limit` names: PGlite's 32 767 is simulated on a client that takes more */
    const withLimit = async (limit: Limit, run: () => Promise<void>) => {
      const simulated = limit === 'pglite' && client.maxParameters() !== PGLITE_LIMIT;

      if (simulated) {
        (client as any).maxParameters = () => PGLITE_LIMIT;
      }

      try {
        await run();
      } finally {
        if (simulated) {
          delete (client as any).maxParameters;
        }
      }
    };

    /** A batch holding one leg of 3 units (the oracle of the declined legs): what it wrote, read back and counted */
    const alone = async (kind: FitKind, fit: LegFitOptions = {}) => {
      await reset();
      const batch = new MutationBatch();

      expect(register(kind, batch, 3, 'leg', fit)).toEqual({ id: 'leg' });
      const parameters = batch.parameterCount;
      await batch.executeBatch();

      return {
        parameters,
        affected: batch.getAffectedCount('leg'),
        legRows: await normalize(READBACK.includes(kind) ? batch.getLegRows('leg') : null),
        statements: captured.filter(entry => entry.startsWith('WITH ')),
        rows: await stored(),
      };
    };

    /** The parameters a leg of 3 units binds as compiled — the verdict's count, not rows × columns */
    const ownParameters = (kind: FitKind) => {
      const probe = new MutationBatch();

      register(kind, probe, 3, 'leg');

      return probe.parameterCount;
    };

    const SITUATION_TESTS: Record<Situation, (kind: FitKind) => Promise<void>> = {
      // No input: null with the option and without — nothing registered either way
      'zero': async kind => {
        const fitted = new MutationBatch();

        expect(register(kind, fitted, 0, 'leg', { ifFits: true })).toBeNull();
        expect([fitted.size, fitted.parameterCount]).toEqual([0, 0]);
        expect(register(kind, new MutationBatch(), 0, 'leg')).toBeNull();
      },

      // A leg that fits registers as it does without the option — the same statement, parameters, rows, count,
      // readback — and writes what its standalone form writes
      'fit': async kind => {
        const plain = await alone(kind);

        expect(plain.statements).toHaveLength(1);
        expect(plain.affected).toBe(affectedBy(kind, 3));
        expect(await alone(kind, { ifFits: true })).toEqual(plain);

        await reset();
        const written = await standalone(kind, 3, 'leg');

        expect({ affected: written.affected, legRows: await normalize(written.rows), rows: await stored() }).toEqual({ affected: plain.affected, legRows: plain.legRows, rows: plain.rows });
      },

      // The same between other legs: its parameters renumbered after theirs, the verdict counting theirs
      'fit-composed': async kind => {
        const run = async (fit: LegFitOptions) => {
          await reset();
          const batch = new MutationBatch();

          batch.addInsertBulk(db.scans, [{ parcelId: 999, note: 'before' }], 'before');
          expect(register(kind, batch, 3, 'leg', fit)).toEqual({ id: 'leg' });
          batch.addDeleteWhereIn(db.scans as any, 'note', ['never'], 'after');
          await batch.executeBatch();

          return {
            counts: ['before', 'leg', 'after'].map(id => batch.getAffectedCount(id)),
            legRows: await normalize(READBACK.includes(kind) ? batch.getLegRows('leg') : null),
            statements: captured.filter(entry => entry.startsWith('WITH ')),
            rows: await stored(),
          };
        };

        const plain = await run({});

        expect(plain.counts).toEqual([1, affectedBy(kind, 3), 0]);
        expect(await run({ ifFits: true })).toEqual(plain);
      },

      // At its own budget the leg registers without the option; with it, exactly when its statement stays within the
      // limit — compiled as without it — and when it does not, `executeBatch()` refuses the plain leg's statement
      'at-own-budget': async kind => {
        const plain = new MutationBatch();

        expect(register(kind, plain, OWN_BUDGET[kind], 'leg')).toEqual({ id: 'leg' });

        const fitted = new MutationBatch();
        const key = register(kind, fitted, OWN_BUDGET[kind], 'leg', { ifFits: true });
        const carries = plain.parameterCount <= client.maxParameters();

        expect(key).toEqual(carries ? { id: 'leg' } : null);

        if (carries) {
          expect(compiled(fitted)).toEqual(compiled(plain));
        } else {
          expect([fitted.size, fitted.parameterCount]).toEqual([0, 0]);
          await expectToReject(plain.executeBatch(), `MutationBatch: the statement binds ${plain.parameterCount} parameters — over ${limitText()}`);
        }
      },

      // One unit over its own budget: declined, nothing registered, where without the option it throws as it
      // registers — and the standalone form writes it, each statement within the limit
      'over-own-budget': async kind => {
        const over = OWN_BUDGET[kind] + 1;
        const fitted = new MutationBatch();

        expect(register(kind, fitted, over, 'leg', { ifFits: true })).toBeNull();
        expect([fitted.size, fitted.parameterCount]).toEqual([0, 0]);
        expect(() => register(kind, new MutationBatch(), over, 'leg')).toThrow(/single statement budget/);

        await reset();
        const written = await standalone(kind, over, 'leg');
        const sent = captured.filter(entry => /^\s*(WITH|INSERT|UPDATE|DELETE)\b/.test(entry));

        expect(written.affected).toBe(affectedBy(kind, over));
        expect(sent.length).toBeGreaterThan(0);
        expect(Math.max(...bound(sent))).toBeLessThanOrEqual(client.maxParameters());
      },

      // The leg that brings the statement to EXACTLY the limit registers and runs — as it does without the option
      'at-statement-limit': async kind => {
        const own = ownParameters(kind);
        const limit = client.maxParameters();
        const run = async (fit: LegFitOptions) => {
          await reset();
          const batch = new MutationBatch();

          fill(batch, limit - own);
          expect(register(kind, batch, 3, 'leg', fit)).toEqual({ id: 'leg' });
          expect(batch.parameterCount).toBe(limit);
          await batch.executeBatch();

          return {
            affected: batch.getAffectedCount('leg'),
            legRows: await normalize(READBACK.includes(kind) ? batch.getLegRows('leg') : null),
            statements: captured.filter(entry => entry.startsWith('WITH ')),
            rows: await stored(),
          };
        };

        const plain = await run({});

        expect(plain.affected).toBe(affectedBy(kind, 3));
        expect(await run({ ifFits: true })).toEqual(plain);
      },

      // One parameter more: declined, the batch as it was — where without the option executeBatch() refuses the
      // statement; the caller runs the batch, then the leg's input standalone: the rows the leg writes when it fits
      'over-statement-limit': async kind => {
        const own = ownParameters(kind);
        const limit = client.maxParameters();
        const reference = await alone(kind);

        await reset();
        const fitted = new MutationBatch();

        fill(fitted, limit - own + 1);
        const before = { size: fitted.size, parameters: fitted.parameterCount };

        expect(register(kind, fitted, 3, 'leg', { ifFits: true })).toBeNull();
        expect({ size: fitted.size, parameters: fitted.parameterCount }).toEqual(before);
        await fitted.executeBatch();

        const written = await standalone(kind, 3, 'leg');

        expect({ affected: written.affected, legRows: await normalize(written.rows), rows: await stored() }).toEqual({ affected: reference.affected, legRows: reference.legRows, rows: reference.rows });

        const plain = new MutationBatch();

        fill(plain, limit - own + 1);
        expect(register(kind, plain, 3, 'leg')).toEqual({ id: 'leg' });
        await expectToReject(plain.executeBatch(), `MutationBatch: the statement binds ${limit + 1} parameters — over ${limitText()}`);
      },
    };

    for (const limit of LIMITS) {
      describe(limit === 'client' ? 'the client\'s own limit' : 'PGlite\'s 32 767 (simulated on a client that takes more)', () => {
        for (const kind of FIT_KINDS) {
          for (const situation of SITUATIONS) {
            test(`${kind} · ${situation}`, () => withLimit(limit, () => SITUATION_TESTS[situation](kind)), 120000);
          }
        }
      });
    }

    test('the parameters it counts are the leg\'s as compiled: an SQL fragment cell binds none, a typed row guard and an update guard bind their own', () => {
      expect(ownParameters('insert')).toBe(3 * 4);
      expect(ownParameters('insert-guarded')).toBe(3 * 5 + 1);
      expect(ownParameters('update-where-in')).toBe(1 + 3);
      expect(ownParameters('update-where-in-guarded')).toBe(1 + 3 + 1);
    });

    test('a duplicate identifier and an executed batch are refused — not declined — with the option as without it', async () => {
      for (const kind of FIT_KINDS) {
        const batch = new MutationBatch();

        register(kind, batch, 3, 'leg');
        expect(() => register(kind, batch, 3, 'leg', { ifFits: true })).toThrow('MutationBatch: duplicate leg identifier "leg"');
        expect(() => register(kind, batch, OWN_BUDGET[kind] + 1, 'leg', { ifFits: true })).toThrow('MutationBatch: duplicate leg identifier "leg"');
      }

      await reset();
      const executed = new MutationBatch();

      await executed.executeBatch();
      expect(() => register('insert', executed, 3, 'late', { ifFits: true })).toThrow('MutationBatch has already been executed');
    });

    test('a declined leg leaves its identifier free; `ifFits: false` is the option absent', () => {
      for (const kind of FIT_KINDS) {
        const batch = new MutationBatch();

        expect(register(kind, batch, OWN_BUDGET[kind] + 1, 'leg', { ifFits: true })).toBeNull();
        expect(register(kind, batch, 3, 'leg', { ifFits: true })).toEqual({ id: 'leg' });
        expect(() => register(kind, new MutationBatch(), OWN_BUDGET[kind] + 1, 'leg', { ifFits: false })).toThrow(/single statement budget/);
      }
    });

    test('the verdict counts the legs registered BEFORE it: a leg registered after it without the option is held to the limit by executeBatch() alone', async () => {
      const limit = client.maxParameters();
      const batch = new MutationBatch();

      fill(batch, limit - ownParameters('update-where-in') - 1);
      expect(register('update-where-in', batch, 3, 'leg', { ifFits: true })).toEqual({ id: 'leg' });
      expect(batch.parameterCount).toBe(limit - 1);
      // Two more parameters, registered without the option: accepted here, refused by executeBatch()
      expect(batch.addDeleteWhereIn(db.tallies as any, 'route', [-1, -2], 'late')).toEqual({ id: 'late' });
      await expectToReject(batch.executeBatch(), `MutationBatch: the statement binds ${limit + 1} parameters — over ${limitText()}`);
    });

    test('typings: every leg kind with a standalone form takes ifFits; the dependent insert does not', () => {
      const typed = (batch: MutationBatch) => {
        batch.addInsertBulk(db.parcels, [], 'a', { ifFits: true, returning: ['id'] });
        batch.addUpsertBulk(db.tallies, [], { primaryKey: 'route' }, 'b', { ifFits: true, returning: ['total'] });
        batch.addBulkUpdate(db.routes, [], 'c', { ifFits: true, primaryKey: 'id' });
        batch.addDeleteWhereIn(db.tallies as any, 'route', [], 'd', { ifFits: true });
        batch.addUpdateWhereIn(db.routes, 'id', [], { open: true }, 'e', { ifFits: true, exposeColumns: ['open'], where: r => eq(r.open, false) });
        batch.addInsertBulkWithChildren(db.parcels as any, { rows: [], children: { table: db.scans, foreignKey: 'parcelId', rows: [] } }, 'f', { ifFits: true, parentReturning: ['id'] });
        // @ts-expect-error — a dependent insert reads its parent's CTE: it has no standalone form to be declined to
        batch.addDependentInsert(db.scans as any, { note: 'x' }, { onLeg: 'e', whereColumn: 'open', whereNotEquals: true }, 'g', { ifFits: true });
        // @ts-expect-error — a flag
        batch.addDeleteWhereIn(db.tallies as any, 'route', [], 'h', { ifFits: 'yes' });

        const fit: LegFitOptions = { ifFits: true };
        const insert: InsertLegOptions<MbrParcel> = { ...fit, returning: ['label'] };
        const update: BulkUpdateLegConfig = { ...fit, primaryKey: 'id' };

        return [batch, insert, update];
      };

      expect(typeof typed).toBe('function');
    });
  });
});
