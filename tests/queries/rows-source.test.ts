import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as linkgress from '../../src';
import {
  bigint, boolean as pgBoolean, createCustomType, date, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig,
  enumColumn, eq, integer, jsonb, literal, notExists, numeric, pgEnum, serial, smallint, text, timestamp, timestamptz, uuid, varchar,
} from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * A typed rows source — `unnestRows(table, rows, columns?)` and `fromRows(table, rows, { columns?, alias? })`:
 * JS rows bound through the TABLE's column types and mappers, ONE array parameter per column,
 *
 *   unnest(CAST($1 AS varchar[]), CAST($2 AS integer[]), CAST($3 AS numeric(8, 2)[]), …) AS "rows"("code", "route", "weight", …)
 *
 * so the statement's text does not depend on the number of rows (it can be prepared), an empty list is a legal
 * empty set (never an empty VALUES), and the row reads — and compares, in a condition — through the columns'
 * mappers. An array column, which unnest would flatten, rides as the text of its array literal, cast back in a
 * derived table. It is an insertFrom source and a set a notExists can correlate to inside a mutation CTE.
 *
 * The ORACLE is the table: the same rows inserted with `insertBulk` read back equal to the rows source read
 * back, and to the rows the source inserts through `insertFrom` — every column type (varchar, integer, numeric,
 * timestamp, timestamptz, date, boolean, uuid, jsonb, an integer[] array, an enum, a mapped smallint, a mapped
 * value class over a timestamp, text, bigint), NULL and absent cells, strings with quotes / backslashes / braces /
 * commas, for 0, 1, 3 and 500 rows.
 */

type Tier = 'bronze' | 'gold';

const tierMapper = createCustomType<{ data: Tier; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Tier | null | undefined) => (value == null ? null : value === 'gold' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'gold' : 'bronze'),
});

/** A value class over a timestamp — the way a Temporal value maps — written as its wall-clock text */
class Stamp {
  constructor(readonly text: string) {}
}

const pad = (n: number, d = 2) => String(n).padStart(d, '0');
const wallClock = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const stampMapper = createCustomType<{ data: Stamp; driverData: string }>({
  dataType: () => 'timestamp',
  toDriver: (value: Stamp | null | undefined) => (value == null ? null : value.text) as string,
  fromDriver: (value: any) => (value == null ? value : new Stamp(value instanceof Date ? wallClock(value) : String(value).replace('T', ' ').slice(0, 19))),
});

const shadeEnum = pgEnum('rs_shade', ['light', 'dark'] as const);

class RsShipment extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  route!: DbColumn<number>;
  weight?: DbColumn<string | null>;
  departs?: DbColumn<Date | null>;
  departsTz?: DbColumn<Date | null>;
  day?: DbColumn<Date | null>;
  active!: DbColumn<boolean>;
  token?: DbColumn<string | null>;
  meta?: DbColumn<unknown>;
  tags?: DbColumn<number[] | null>;
  shade?: DbColumn<'light' | 'dark' | null>;
  tier!: DbColumn<Tier>;
  stamp?: DbColumn<Stamp | null>;
  note?: DbColumn<string | null>;
  big?: DbColumn<string | null>;
}

class RowsSourceDatabase extends DbContext {
  get shipments(): DbEntityTable<RsShipment> {
    return this.table(RsShipment);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(RsShipment, entity => {
      entity.toTable('rs_shipments');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.code).hasType(varchar('code', 40)).isRequired();
      entity.property(e => e.route).hasType(integer('route')).isRequired();
      entity.property(e => e.weight).hasType(numeric('weight', 8, 2));
      entity.property(e => e.departs).hasType(timestamp('departs'));
      entity.property(e => e.departsTz).hasType(timestamptz('departs_tz'));
      entity.property(e => e.day).hasType(date('day'));
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.property(e => e.token).hasType(uuid('token'));
      entity.property(e => e.meta).hasType(jsonb('meta'));
      entity.property(e => e.tags).hasType(integer('tags').array());
      entity.property(e => e.shade).hasType(enumColumn('shade', shadeEnum));
      entity.property(e => e.tier).hasType(smallint('tier')).isRequired().hasCustomMapper(tierMapper);
      entity.property(e => e.stamp).hasType(timestamp('stamp')).hasCustomMapper(stampMapper);
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.big).hasType(bigint('big'));
      entity.hasIndex('ux_rs_shipments_code', e => [e.code]).isUnique();
    });
  }
}

type ShipmentRow = {
  code: string;
  route: number;
  weight?: number | string | null;
  departs?: Date | null;
  departsTz?: Date | null;
  day?: Date | null;
  active: boolean;
  token?: string | null;
  meta?: unknown;
  tags?: number[] | null;
  shade?: 'light' | 'dark' | null;
  tier: Tier;
  stamp?: Stamp | null;
  note?: string | null;
  big?: string | null;
};

const PROPS: Array<keyof ShipmentRow> = ['code', 'route', 'weight', 'departs', 'departsTz', 'day', 'active', 'token', 'meta', 'tags', 'shade', 'tier', 'stamp', 'note', 'big'];

const SAMPLE: ShipmentRow[] = [
  {
    code: 'A "quoted", {braced} \\ back',
    route: 1,
    weight: 12.5,
    departs: new Date(2026, 2, 4, 5, 6, 7),
    departsTz: new Date(Date.UTC(2026, 6, 1, 12, 0, 0)),
    day: new Date(2026, 0, 31),
    active: true,
    token: '6f1c2a5e-8f3b-4c2d-9e1a-2b3c4d5e6f70',
    meta: { name: 'O\'Brien "x"', list: [1, 'two', null], nested: { ok: true } },
    tags: [3, 1, 2],
    shade: 'dark',
    tier: 'gold',
    stamp: new Stamp('2026-05-06 07:08:09'),
    note: 'ünïcödé, NULL, {}',
    big: '9007199254740993',
  },
  { code: '0042', route: 2, weight: '0.10', active: false, tier: 'bronze', tags: [], meta: { list: [1, 2, 3] }, note: '' },
  { code: 'nulls', route: 3, weight: null, departs: null, departsTz: null, day: null, active: true, token: null, meta: null, tags: null, shade: null, tier: 'gold', stamp: null, note: null, big: null },
];

const generated = (count: number): ShipmentRow[] => Array.from({ length: count }, (_, i) => ({
  code: `gen-${pad(i, 4)}`,
  route: i % 7,
  weight: i % 3 === 0 ? null : (i % 100) + 0.25,
  departs: new Date(2025, i % 12, (i % 27) + 1, i % 24, i % 60, 0),
  day: new Date(2024, i % 12, (i % 27) + 1),
  active: i % 2 === 0,
  meta: i % 5 === 0 ? null : { i, label: `row ${i}` },
  tags: i % 4 === 0 ? null : [i, i + 1],
  shade: i % 3 === 0 ? 'light' : i % 3 === 1 ? 'dark' : null,
  tier: i % 2 === 0 ? 'gold' : 'bronze',
  stamp: i % 6 === 0 ? null : new Stamp(`2025-0${(i % 9) + 1}-1${i % 10} 0${i % 10}:00:00`),
  note: i % 10 === 0 ? null : `n${i}`,
}));

const CASES: Array<{ name: string; rows: ShipmentRow[] }> = [
  { name: '0 rows', rows: [] },
  { name: '1 row', rows: [SAMPLE[0]] },
  { name: '3 rows', rows: SAMPLE },
  { name: '500 rows', rows: generated(500) },
];

const { unnestRows, fromRows } = linkgress as any as {
  unnestRows: (table: any, rows: readonly any[], columns?: readonly string[]) => any;
  fromRows: (table: any, rows: readonly any[], options?: { columns?: readonly string[]; alias?: string }) => any;
};

const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

describe('a typed rows source: unnestRows() / fromRows()', () => {
  let client: DatabaseClient;
  let db: RowsSourceDatabase;
  const captured: string[] = [];

  /** Every column of the table's rows, read the table's way: the oracle */
  const tableRows = async (props: ReadonlyArray<keyof ShipmentRow> = PROPS) =>
    (await db.shipments.select((s: any) => Object.fromEntries(props.map(p => [p, s[p]]))).toList()).map(r => ({ ...r })).sort(byCode as any);

  const oracle = async (rows: ShipmentRow[], props: ReadonlyArray<keyof ShipmentRow> = PROPS) => {
    await client.query('TRUNCATE rs_shipments RESTART IDENTITY');

    if (rows.length > 0) {
      await db.shipments.insertBulk(rows.map(r => ({ ...r })) as any);
    }

    const expected = await tableRows(props);
    await client.query('TRUNCATE rs_shipments RESTART IDENTITY');

    return expected;
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new RowsSourceDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS rs_shipments CASCADE');
    await client.query('DROP TYPE IF EXISTS rs_shade CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS rs_shipments CASCADE');
    await client.query('DROP TYPE IF EXISTS rs_shade CASCADE');
    await db.dispose();
  });

  describe('matrix: rows × consumer × columns', () => {
    // `insertable`: the set holds every NOT NULL column, so an insertFrom can write it alone
    const COLUMN_SETS: Array<{ name: string; columns?: Array<keyof ShipmentRow>; insertable: boolean }> = [
      { name: 'every column the rows hold', insertable: true },
      { name: 'explicit: the required columns', columns: ['code', 'route', 'active', 'tier'], insertable: true },
      { name: 'explicit: code, tier, tags, departs', columns: ['code', 'tier', 'tags', 'departs'], insertable: false },
      { name: 'explicit: code only', columns: ['code'], insertable: false },
    ];

    for (const { name, rows } of CASES) {
      for (const { name: columnsName, columns, insertable } of COLUMN_SETS) {
        // By default the set has the columns the rows hold (every column for no rows)
        const props = columns ?? PROPS.filter(p => rows.length === 0 || rows.some(r => p in r));

        test(`${name} | read back | ${columnsName}`, async () => {
          const expected = await oracle(rows, props);
          const read = await db.selectFromSet(unnestRows(db.shipments, rows, columns), 'r')
            .select((r: any) => Object.fromEntries(props.map(p => [p, r[p]])))
            .toList();

          expect(read.map(r => ({ ...r })).sort(byCode as any)).toEqual(expected);
        });

        if (insertable) {
          test(`${name} | insertFrom | ${columnsName}`, async () => {
            const expected = await oracle(rows.map(r => Object.fromEntries(props.map(p => [p, r[p]])) as ShipmentRow), props);
            const inserted = await db.shipments.insertFrom(
              fromRows(db.shipments, rows, columns ? { columns } : undefined).asSubquery('table'),
              (src: any) => Object.fromEntries(props.map(p => [p, src[p]])) as any
            ).returning(s => ({ id: s.id }));

            expect(inserted).toHaveLength(rows.length);
            expect(await tableRows(props)).toEqual(expected);
            await client.query('TRUNCATE rs_shipments RESTART IDENTITY');
          });
        }

        test(`${name} | statement text | ${columnsName}`, () => {
          const text = (source: any[]) => {
            const context = { paramCounter: 1, params: [] as any[] };
            return { sql: fromRows(db.shipments, source, { columns: columns ?? PROPS }).asSubquery('table').buildSql(context), params: context.params };
          };
          const one = text(SAMPLE.slice(0, 1));
          const these = text(rows);

          // One parameter per column, whatever the number of rows: the same text for 0, 1 and 500 rows
          expect(these.sql).toBe(one.sql);
          expect(these.params).toHaveLength((columns ?? PROPS).length);
          expect(these.sql).toContain('unnest(CAST($1 AS ');
          expect(these.sql).not.toContain('VALUES');
        });
      }
    }
  });

  describe('the source', () => {
    test('renders unnest over the columns\' types, one array per column; an array column rides as text, cast back', () => {
      const context = { paramCounter: 1, params: [] as any[] };
      const sql = fromRows(db.shipments, SAMPLE, { columns: ['code', 'route', 'weight', 'tier', 'stamp', 'departsTz', 'shade'] })
        .select((r: any) => ({ code: r.code }))
        .asSubquery('table')
        .buildSql(context);

      expect(sql).toBe(
        'SELECT "rows"."code" as "code"\nFROM unnest(CAST($1 AS varchar[]), CAST($2 AS integer[]), CAST($3 AS numeric(8, 2)[]), CAST($4 AS smallint[]), '
        + 'CAST($5 AS timestamp[]), CAST($6 AS timestamptz[]), CAST($7 AS rs_shade[])) AS "rows"("code", "route", "weight", "tier", "stamp", "departsTz", "shade")'
      );
      // through the mappers: tier → smallint, stamp → its text; NULL cells as NULL
      expect(context.params[3]).toBe('{2,1,2}');
      expect(context.params[4]).toBe('{"2026-05-06 07:08:09",NULL,NULL}');

      const withArray = fromRows(db.shipments, SAMPLE, { columns: ['code', 'tags'] }).asSubquery('table').buildSql({ paramCounter: 1, params: [] });
      expect(withArray).toContain('FROM (SELECT "rows"."code", CAST("rows"."tags" AS integer[]) AS "tags" FROM unnest(CAST($1 AS varchar[]), CAST($2 AS text[])) AS "rows"("code", "tags")) AS "rows"');
    });

    test('a condition over the rows compares through the column\'s mapper', async () => {
      const gold = await db.selectFromSet(unnestRows(db.shipments, SAMPLE), 'r')
        .where((r: any) => eq(r.tier, 'gold'))
        .select((r: any) => ({ code: r.code, tier: r.tier }))
        .toList();

      expect(gold.map(r => ({ ...r })).sort(byCode as any)).toEqual([
        { code: 'A "quoted", {braced} \\ back', tier: 'gold' },
        { code: 'nulls', tier: 'gold' },
      ]);
    });

    test('empty rows without columns are a legal empty set over every column', async () => {
      const rows = await db.selectFromSet(unnestRows(db.shipments, []), 'r').select((r: any) => ({ code: r.code, tags: r.tags })).toList();

      expect(rows).toEqual([]);
    });

    test('a notExists over the rows inside a data-modifying CTE: delete what the list no longer holds', async () => {
      await client.query('TRUNCATE rs_shipments RESTART IDENTITY');
      await db.shipments.insertBulk(SAMPLE.map(r => ({ ...r })) as any);
      const keep = [{ code: '0042' }, { code: 'gone-already' }];

      const removed = new DbCteBuilder().withMutation(
        'rs_removed',
        db.shipments
          .where(s => notExists(fromRows(db.shipments, keep, { columns: ['code'], alias: 'k' }).where((k: any) => eq(k.code, s.code)).select(() => ({ one: literal(1) })).asSubquery()))
          .delete()
          .toStatement(s => ({ code: s.code }))
      );
      const rows = await db.selectFromCte(removed.cte).select(r => ({ code: r.code })).toList();

      expect(rows.map(r => r.code).sort()).toEqual(['A "quoted", {braced} \\ back', 'nulls']);
      expect((await tableRows(['code'])).map(r => r.code)).toEqual(['0042']);
    });

    test('a correlated set per row of an entity query: crossJoinLateral over the rows', async () => {
      await client.query('TRUNCATE rs_shipments RESTART IDENTITY');
      await db.shipments.insertBulk(SAMPLE.map(r => ({ ...r })) as any);

      const rows = await db.shipments
        .crossJoinLateral(() => unnestRows(db.shipments, [{ code: 'x', route: 9 }], ['code', 'route']), (s: any, r: any) => ({ code: s.code, extra: r.route }), 'r')
        .toList();

      expect(rows.map((r: any) => r.extra)).toEqual([9, 9, 9]);
    });

    test('refuses a column the table does not have and a source that is not a table', () => {
      expect(() => unnestRows(db.shipments, SAMPLE, ['code', 'nope'])).toThrow('unnestRows(): "nope" is not a column of "rs_shipments"');
      expect(() => unnestRows({} as any, SAMPLE)).toThrow('unnestRows(): expected an entity table');
    });
  });

  describe('typings', () => {
    test('the row is typed by the table\'s columns', () => {
      const typed = () => {
        const source = linkgress.fromRows(db.shipments, [{ code: 'a', route: 1, active: true, tier: 'gold' as Tier }], { columns: ['code', 'tier'] });
        const projected = source.select(r => ({ code: r.code, tier: r.tier }));
        const reads: linkgress.SetQueryBuilder<any, { code: string; tier: Tier }> = projected;
        // @ts-expect-error — not a column of the table
        linkgress.unnestRows(db.shipments, [], ['nope']);

        return reads;
      };

      expect(typeof typed).toBe('function');
    });
  });
});
