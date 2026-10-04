import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, boolean as pgBoolean, createCustomType, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, exists, integer, jsonb,
  MutationBatch, numeric, serial, smallint, text, timestamp, varchar,
} from '../../src';
import type { DatabaseClient, InsertLegOptions } from '../../src';
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
    await client.query('DROP TABLE IF EXISTS mbr_parcels, mbr_routes, mbr_tallies CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS mbr_parcels, mbr_routes, mbr_tallies CASCADE');
    await db.dispose();
  });

  const reset = async () => {
    await client.query('TRUNCATE mbr_parcels, mbr_routes, mbr_tallies RESTART IDENTITY');
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

    /** The most parameters a statement binds through the client: PostgreSQL's 65 535, PGlite's 32 767 */
    const limitText = () => (client.maxParameters() === 65535 ? "PostgreSQL's 65 535" : 'the 32 767 this client takes');

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
});
