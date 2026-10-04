import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as linkgress from '../../src';
import {
  and, boolean as pgBoolean, createCustomType, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, eq, eqAny,
  fromSet, gt, integer, isNotDistinctFrom, literal, lt, serial, smallint, sql, text, timestamp, unnestZip, varchar,
} from '../../src';
import type { DatabaseClient, DbCte } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Reading several CTEs back as ONE result: `db.selectFromCte(a).select(…).unionAll(db.selectFromCte(b).select(…))`
 * — a CTE-rooted query is a UNION / UNION ALL leg (beside other CTE-rooted queries, entity queries and set
 * queries), the union declares every leg's CTEs once at statement level (a data-modifying one with the CTEs it
 * reads before it), each leg tags its rows with a literal read back from the row, and every column reads the way
 * the FIRST leg's projection reads it (a mapped column through its mapper, a text column's '0042' as text, a
 * timestamp as a Date, NULL as null).
 *
 * The readback of mutation CTEs must never be a FULL JOIN on a null-safe key: PostgreSQL plans a FULL JOIN only
 * with merge- or hash-joinable conditions (0A000 otherwise). The in-memory engine accepted any condition — it
 * now refuses what PostgreSQL refuses, by PostgreSQL's rule (an equality between the two sides makes any other
 * condition legal; constants are legal; a WHERE that makes a side non-nullable turns the FULL JOIN into another
 * join). `onFalse()` beside `onTrue()`: the full join that pairs nothing.
 *
 * The matrix: leg builders × the number of legs × UNION / UNION ALL × rows per leg (0, 1, n) × how the union is
 * read (toList, ordered and limited, counted, first row, a table subquery feeding insertFrom, a CTE body). The ORACLE: each leg run on its own — the union's rows are their concatenation (deduplicated for
 * UNION), read the same way.
 */

type Kind = 'small' | 'large';

const kindMapper = createCustomType<{ data: Kind; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Kind | null | undefined) => (value == null ? null : value === 'large' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'large' : 'small'),
});

class UrStock extends DbEntity {
  id!: DbColumn<number>;
  sku!: DbColumn<string>;
  qty!: DbColumn<number>;
  code!: DbColumn<string>;
  kind!: DbColumn<Kind>;
  at!: DbColumn<Date>;
  bin?: DbColumn<number | null>;
}

class UrSlot extends DbEntity {
  id!: DbColumn<number>;
  unitId!: DbColumn<number>;
  tenantId!: DbColumn<number>;
  bin?: DbColumn<number | null>;
  isCurrent!: DbColumn<boolean>;
}

class UrSink extends DbEntity {
  id!: DbColumn<number>;
  tag!: DbColumn<string>;
  sku!: DbColumn<string>;
}

class UnionReadbackDatabase extends DbContext {
  get stock(): DbEntityTable<UrStock> {
    return this.table(UrStock);
  }

  get slots(): DbEntityTable<UrSlot> {
    return this.table(UrSlot);
  }

  get sinks(): DbEntityTable<UrSink> {
    return this.table(UrSink);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UrStock, entity => {
      entity.toTable('ur_stock');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.sku).hasType(varchar('sku', 20)).isRequired();
      entity.property(e => e.qty).hasType(integer('qty')).isRequired();
      entity.property(e => e.code).hasType(text('code')).isRequired();
      entity.property(e => e.kind).hasType(smallint('kind')).isRequired().hasCustomMapper(kindMapper);
      entity.property(e => e.at).hasType(timestamp('at')).isRequired();
      entity.property(e => e.bin).hasType(integer('bin'));
    });

    model.entity(UrSlot, entity => {
      entity.toTable('ur_slots');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.unitId).hasType(integer('unit_id')).isRequired();
      entity.property(e => e.tenantId).hasType(integer('tenant_id')).isRequired();
      entity.property(e => e.bin).hasType(integer('bin'));
      entity.property(e => e.isCurrent).hasType(pgBoolean('is_current')).isRequired();
      entity.hasIndex('ux_ur_slots_unit_current', e => [e.unitId]).isUnique().where('is_current = true');
    });

    model.entity(UrSink, entity => {
      entity.toTable('ur_sinks');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.tag).hasType(text('tag')).isRequired();
      entity.property(e => e.sku).hasType(varchar('sku', 20)).isRequired();
    });
  }
}

const onFalse = () => (linkgress as any).onFalse();
const afterMutation = (cte: DbCte<any>) => (linkgress as any).afterMutation(cte);

const STOCK = [
  { sku: 'A-1', qty: 5, code: '0042', kind: 'large' as Kind, at: new Date(2026, 0, 2, 3, 4, 5), bin: 7 },
  { sku: 'A-2', qty: 50, code: '0007', kind: 'small' as Kind, at: new Date(2026, 1, 3, 4, 5, 6), bin: null },
  { sku: 'B-1', qty: 500, code: 'b', kind: 'large' as Kind, at: new Date(2026, 2, 4, 5, 6, 7), bin: 9 },
  { sku: 'B-2', qty: 5, code: '0042', kind: 'small' as Kind, at: new Date(2026, 3, 5, 6, 7, 8), bin: null },
];

type LegBuilder = 'cte-root' | 'cte-joined' | 'entity' | 'set';
type Rows = 0 | 1 | 'n';
type Reader = 'toList' | 'ordered-limited' | 'count' | 'first' | 'insert-from' | 'cte-body';

const LEG_BUILDERS: LegBuilder[] = ['cte-root', 'cte-joined', 'entity', 'set'];
const READERS: Reader[] = ['toList', 'ordered-limited', 'count', 'first', 'insert-from', 'cte-body'];

/** The SKUs a leg with `rows` reads, by tag */
const SKUS: Record<string, Record<string, string[]>> = {
  x: { 0: [], 1: ['A-1'], n: ['A-1', 'A-2', 'B-1'] },
  y: { 0: [], 1: ['A-2'], n: ['A-2', 'B-2'] },
  z: { 0: [], 1: ['B-1'], n: ['B-1', 'B-2'] },
};

const pad = (n: number) => String(n).padStart(2, '0');
/** A Date as the wall-clock text a timestamp column stores for it */
const wallClock = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const canonical = (row: any): string => JSON.stringify(Object.keys(row).sort().map(k => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]]));
const sortRows = (rows: any[]): any[] => [...rows].map(r => ({ ...r })).sort((a, b) => canonical(a).localeCompare(canonical(b)));

describe('typed UNION readback of CTE-rooted queries, and FULL JOIN parity', () => {
  let client: DatabaseClient;
  let db: UnionReadbackDatabase;
  const captured: string[] = [];

  /**
   * A leg tagged `tag` over the rows of `skus`, built by `builder`. A set leg is context-free (`fromSet`) — bound
   * to the context (`db.selectFromSet`) when it is the FIRST leg: the union runs on its first leg's context.
   */
  const legOf = (builder: LegBuilder, tag: string, skus: string[], first = false): any => {
    const project = (r: any) => ({ tag, sku: r.sku, qty: r.qty, code: r.code, kind: r.kind, at: r.at, bin: r.bin });

    switch (builder) {
      case 'cte-root': {
        const all = new DbCteBuilder().with(`ur_all_${tag}`, db.stock.select(s => ({ sku: s.sku, qty: s.qty, code: s.code, kind: s.kind, at: s.at, bin: s.bin })));
        return db.selectFromCte(all.cte).where(r => eqAny(r.sku, skus)).select(project);
      }
      case 'cte-joined': {
        const builderOfLeg = new DbCteBuilder();
        const all = builderOfLeg.with(`ur_j_${tag}`, db.stock.select(s => ({ sku: s.sku, qty: s.qty, code: s.code, kind: s.kind, at: s.at, bin: s.bin })));
        const picked = builderOfLeg.with(`ur_p_${tag}`, db.stock.where(s => eqAny(s.sku, skus)).select(s => ({ pick: s.sku })));
        return db.selectFromCte(all.cte).innerJoin(picked.cte, eq((all.cte.as() as any).sku, (picked.cte.as() as any).pick)).select(project);
      }
      case 'entity':
        return db.stock.where(s => eqAny(s.sku, skus)).select(project);
      case 'set': {
        const rows = STOCK.filter(s => skus.includes(s.sku));
        const source = (set: any, alias: string) => (first ? db.selectFromSet(set, alias) : fromSet(set, alias));
        return source(unnestZip({
          sku: { values: rows.map(r => r.sku), type: 'varchar' },
          qty: { values: rows.map(r => r.qty), type: 'integer' },
          code: { values: rows.map(r => r.code), type: 'text' },
          kind: { values: rows.map(r => kindMapper.toDriver(r.kind)), type: 'smallint' },
          at: { values: rows.map(r => wallClock(r.at)), type: 'timestamp' },
          bin: { values: rows.map(r => r.bin), type: 'integer' },
        }), `ur_s_${tag}`).select((r: any) => ({ tag, sku: r.sku, qty: r.qty, code: r.code, kind: sql`${r.kind}`.mapWith(kindMapper), at: r.at, bin: r.bin }));
      }
    }
  };

  /** The oracle row of a stock row tagged `tag`: read as the first leg's projection reads it */
  const expectedRow = (tag: string, sku: string) => {
    const s = STOCK.find(r => r.sku === sku)!;

    return { tag, sku: s.sku, qty: s.qty, code: s.code, kind: s.kind, at: s.at, bin: s.bin };
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new UnionReadbackDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS ur_stock, ur_slots, ur_sinks CASCADE');
    await db.getSchemaManager().ensureCreated();
    await db.stock.insertBulk(STOCK.map(s => ({ ...s })));
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS ur_stock, ur_slots, ur_sinks CASCADE');
    await db.dispose();
  });

  describe('matrix: first leg × other legs × UNION ALL / UNION × rows per leg × reader', () => {
    for (const first of LEG_BUILDERS) {
      for (const second of LEG_BUILDERS) {
        for (const legs of [2, 3]) {
          for (const kind of ['UNION ALL', 'UNION'] as const) {
            for (const rows of [0, 1, 'n'] as Rows[]) {
              for (const reader of READERS) {
                test(`${first} + ${second}${legs === 3 ? ' + cte-root' : ''} | ${kind} | ${rows} rows | ${reader}`, async () => {
                  const tags = legs === 3 ? ['x', 'y', 'z'] : ['x', 'y'];
                  // UNION removes nothing here (the tag differs per leg); a duplicated leg shows the deduplication
                  const legTags = kind === 'UNION' ? [...tags, tags[0]] : tags;
                  const builders = legTags.map((_, i) => (i === 0 ? first : i === 1 ? second : 'cte-root'));
                  const legQueries = legTags.map((tag, i) => legOf(builders[i], tag, SKUS[tag][String(rows)], i === 0));
                  let union = legQueries[0][kind === 'UNION' ? 'union' : 'unionAll'](legQueries[1]);
                  for (const leg of legQueries.slice(2)) {
                    union = kind === 'UNION' ? union.union(leg) : union.unionAll(leg);
                  }

                  const all = tags.flatMap(tag => SKUS[tag][String(rows)].map(sku => expectedRow(tag, sku)));
                  const expected = sortRows(kind === 'UNION' ? all : all);
                  captured.length = 0;

                  switch (reader) {
                    case 'toList':
                      expect(sortRows(await union.toList())).toEqual(expected);
                      break;
                    case 'ordered-limited': {
                      const page = await union.orderBy((r: any) => [r.sku, r.tag]).limit(2).toList();
                      const ordered = [...all].sort((a, b) => (a.sku === b.sku ? a.tag.localeCompare(b.tag) : a.sku.localeCompare(b.sku)));
                      expect(page.map((r: any) => ({ ...r }))).toEqual(ordered.slice(0, 2));
                      break;
                    }
                    case 'count':
                      expect(await union.count()).toBe(all.length);
                      break;
                    case 'first': {
                      const row = await union.orderBy((r: any) => [r.sku, r.tag]).firstOrDefault();
                      const ordered = [...all].sort((a, b) => (a.sku === b.sku ? a.tag.localeCompare(b.tag) : a.sku.localeCompare(b.sku)));
                      expect(row === null ? null : { ...row }).toEqual(ordered[0] ?? null);
                      break;
                    }
                    case 'insert-from': {
                      await client.query('DELETE FROM ur_sinks');
                      const inserted = await db.sinks.insertFrom(union.asSubquery('table'), (src: any) => ({ tag: src.tag, sku: src.sku })).returning(s => ({ tag: s.tag, sku: s.sku }));
                      expect(sortRows(inserted)).toEqual(sortRows(all.map(r => ({ tag: r.tag, sku: r.sku }))));
                      break;
                    }
                    case 'cte-body': {
                      const body = new DbCteBuilder().with('ur_union', union);
                      const read = await db.selectFromCte(body.cte).select((r: any) => ({ tag: r.tag, sku: r.sku, qty: r.qty, code: r.code, kind: r.kind, at: r.at, bin: r.bin })).toList();
                      expect(sortRows(read)).toEqual(expected);
                      break;
                    }
                  }

                  // ONE statement, every leg's CTEs declared once at its top
                  const statements = captured.filter(entry => entry.includes(kind === 'UNION' ? '\nUNION\n' : '\nUNION ALL\n'));
                  expect(statements).toHaveLength(1);
                  for (const tag of tags) {
                    if (builders[tags.indexOf(tag)] === 'cte-root') {
                      expect(statements[0].match(new RegExp(`"ur_all_${tag}" AS \\(`, 'g'))).toHaveLength(1);
                    }
                  }
                });
              }
            }
          }
        }
      }
    }
  });

  describe('the legs of mutation CTEs', () => {
    const reset = async () => {
      await client.query('TRUNCATE ur_slots RESTART IDENTITY');
      await db.slots.insertBulk([
        { unitId: 1, tenantId: 10, bin: null, isCurrent: true },
        { unitId: 2, tenantId: 20, bin: 3, isCurrent: true },
      ]);
    };

    /** Unit 1 and 2 move: the close leg and the open leg, ordered by the barrier or not */
    const legs = (units: number[], barrier: boolean) => {
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('ur_closed', db.slots
        .where(s => and(eqAny(s.unitId, units), eq(s.isCurrent, true)))
        .update({ isCurrent: false })
        .toStatement(s => ({ id: s.id, unitId: s.unitId, tenantId: s.tenantId, bin: s.bin })));
      const opened = builder.withMutation('ur_opened', db.slots.insertFrom(
        fromSet(unnestZip({ unitId: { values: units, type: 'integer' } }), 'd').select(d => ({ unitId: d.unitId })).asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: 99, isCurrent: true }),
        barrier ? { where: () => afterMutation(closed.cte) } : undefined
      ).toStatement(s => ({ id: s.id, unitId: s.unitId, tenantId: s.tenantId, bin: s.bin })));

      return { closed, opened };
    };

    for (const units of [[], [1], [1, 2]]) {
      for (const order of ['closed first', 'opened first'] as const) {
        for (const barrier of [true, false]) {
          test(`${units.length} units | ${order} | ${barrier ? 'barrier' : 'no barrier'}`, async () => {
            await reset();
            const { closed, opened } = legs(units, barrier);
            const closedLeg = db.selectFromCte(closed.cte).select(r => ({ leg: 'c', id: r.id, unitId: r.unitId, tenantId: r.tenantId, bin: r.bin }));
            const openedLeg = db.selectFromCte(opened.cte).select(r => ({ leg: 'o', id: r.id, unitId: r.unitId, tenantId: r.tenantId, bin: r.bin }));
            const union = order === 'closed first' ? (closedLeg as any).unionAll(openedLeg) : (openedLeg as any).unionAll(closedLeg);
            captured.length = 0;

            // The Append runs its first leg first: opened first without the barrier collides with the live row
            if (order === 'opened first' && !barrier && units.length > 0) {
              const error = await expectToReject(union.toList());
              expect(sqlStateOf(error)).toBe('23505');
              return;
            }

            const rows = (await union.toList()).map((r: any) => ({ ...r }));
            const expected = [
              ...units.map(u => ({ leg: 'c', unitId: u, tenantId: u * 10, bin: u === 2 ? 3 : null })),
              ...units.map(u => ({ leg: 'o', unitId: u, tenantId: 99, bin: null })),
            ];
            expect(sortRows(rows.map((r: any) => ({ leg: r.leg, unitId: r.unitId, tenantId: r.tenantId, bin: r.bin })))).toEqual(sortRows(expected));
            expect(rows.every((r: any) => typeof r.id === 'number')).toBe(true);

            const [statement] = captured.filter(entry => entry.includes('\nUNION ALL\n'));
            expect(statement.match(/"ur_closed" AS \(/g)).toHaveLength(1);
            expect(statement.match(/"ur_opened" AS \(/g)).toHaveLength(1);
            if (barrier) {
              // the open leg reads the close leg: declared after it, whichever leg the union reads first
              expect(statement.indexOf('"ur_closed" AS (')).toBeLessThan(statement.indexOf('"ur_opened" AS ('));
            }
            expect(await db.slots.where(s => eq(s.isCurrent, true)).count()).toBe(2);
          });
        }
      }
    }
  });

  describe('FULL JOIN: the in-memory engine refuses what PostgreSQL refuses', () => {
    const WITH = 'WITH a AS (SELECT * FROM (VALUES (1, 2), (NULL, 3)) v(k, j)), b AS (SELECT * FROM (VALUES (1, 2), (NULL, 4)) v(k, j)) ';
    const CASES: Array<{ name: string; sql: string; refused: boolean }> = [
      { name: 'IS NOT DISTINCT FROM alone', sql: 'SELECT * FROM a FULL JOIN b ON a.k IS NOT DISTINCT FROM b.k', refused: true },
      { name: '= between the sides', sql: 'SELECT * FROM a FULL JOIN b ON a.k = b.k', refused: false },
      { name: '= beside IS NOT DISTINCT FROM', sql: 'SELECT * FROM a FULL JOIN b ON a.k = b.k AND a.j IS NOT DISTINCT FROM b.j', refused: false },
      { name: 'an inequality', sql: 'SELECT * FROM a FULL JOIN b ON a.k < b.k', refused: true },
      { name: 'an OR of equalities', sql: 'SELECT * FROM a FULL JOIN b ON a.k = b.k OR a.j = b.j', refused: true },
      { name: 'a condition on one side alone', sql: 'SELECT * FROM a FULL JOIN b ON a.k = 1', refused: true },
      { name: '= beside a condition on one side', sql: 'SELECT * FROM a FULL JOIN b ON a.k = b.k AND a.j = 2', refused: false },
      { name: 'ON TRUE', sql: 'SELECT * FROM a FULL JOIN b ON TRUE', refused: false },
      { name: 'ON FALSE', sql: 'SELECT * FROM a FULL JOIN b ON FALSE', refused: false },
      { name: '= between expressions of each side', sql: 'SELECT * FROM a FULL JOIN b ON a.k + 1 = b.k + 1', refused: false },
      { name: '= between coalesced sides', sql: 'SELECT * FROM a FULL JOIN b ON coalesce(a.k, 0) = coalesce(b.k, 0)', refused: false },
      { name: 'a volatile equality', sql: 'SELECT * FROM a FULL JOIN b ON a.k = b.k + (random() * 0)::int', refused: true },
      { name: 'USING', sql: 'SELECT * FROM a FULL JOIN b USING (k)', refused: false },
      { name: 'an unreferenced CTE that would be refused', sql: ', z AS (SELECT * FROM a FULL JOIN b ON a.k IS NOT DISTINCT FROM b.k) SELECT 1 AS one', refused: false },
      { name: 'a WHERE that makes both sides non-nullable (an inner join)', sql: 'SELECT * FROM a FULL JOIN b ON a.k IS NOT DISTINCT FROM b.k WHERE a.j > 0 AND b.j > 0', refused: false },
      { name: 'a WHERE that makes one side non-nullable (a left join)', sql: 'SELECT * FROM a FULL JOIN b ON a.k IS NOT DISTINCT FROM b.k WHERE a.j > 0', refused: false },
      { name: 'LEFT JOIN on IS NOT DISTINCT FROM', sql: 'SELECT * FROM a LEFT JOIN b ON a.k IS NOT DISTINCT FROM b.k', refused: false },
      { name: 'RIGHT JOIN on IS NOT DISTINCT FROM', sql: 'SELECT * FROM a RIGHT JOIN b ON a.k IS NOT DISTINCT FROM b.k', refused: false },
      { name: 'a FULL JOIN of a FULL JOIN, the inner refused', sql: 'SELECT * FROM (a FULL JOIN b ON a.k < b.k) FULL JOIN b c ON a.k = c.k', refused: true },
      { name: 'a FULL JOIN in a subquery', sql: 'SELECT (SELECT count(*) FROM a FULL JOIN b ON a.k IS NOT DISTINCT FROM b.k) AS n', refused: true },
    ];

    for (const c of CASES) {
      test(`${c.refused ? 'refused' : 'planned'}: ${c.name}`, async () => {
        const text = c.sql.startsWith(',') ? `${WITH.trimEnd()}${c.sql}` : `${WITH}${c.sql}`;

        if (c.refused) {
          const error = await expectToReject(client.query(text));
          expect(sqlStateOf(error)).toBe('0A000');
          expect(String(error.message)).toContain('FULL JOIN is only supported with merge-joinable or hash-joinable join conditions');
        } else {
          await client.query(text);
        }
      });
    }

    test('the builder: a FULL JOIN of two CTEs on a null-safe key is refused, on an equality it runs', async () => {
      const builder = new DbCteBuilder();
      const left = builder.with('ur_left', db.stock.select(s => ({ sku: s.sku, bin: s.bin })));
      const right = builder.with('ur_right', db.stock.where(s => gt(s.qty, 10)).select(s => ({ sku: s.sku, bin: s.bin })));
      const l = left.cte.as() as any;
      const r = right.cte.as() as any;

      const refused = await expectToReject(db.selectFromCte(left.cte).fullOuterJoin(right.cte, isNotDistinctFrom(l.bin, r.bin)).select((a: any, b: any) => ({ a: a.sku, b: b.sku })).toList());
      expect(sqlStateOf(refused)).toBe('0A000');

      const rows = await db.selectFromCte(left.cte).fullOuterJoin(right.cte, eq(l.sku, r.sku)).select((a: any, b: any) => ({ a: a.sku, b: b.sku })).toList();
      expect(rows.map(row => `${row.a}|${row.b}`).sort()).toEqual(['A-1|null', 'A-2|A-2', 'B-1|B-1', 'B-2|null']);
    });

    test('onFalse(): a FULL JOIN that pairs nothing — every row of both sides, unmatched', async () => {
      const builder = new DbCteBuilder();
      const left = builder.with('ur_left', db.stock.where(s => lt(s.qty, 10)).select(s => ({ sku: s.sku })));
      const right = builder.with('ur_right', db.stock.where(s => gt(s.qty, 10)).select(s => ({ sku: s.sku })));

      const query = db.selectFromCte(left.cte).fullOuterJoin(right.cte, onFalse()).select((a: any, b: any) => ({ a: a.sku, b: b.sku }));
      expect(query.toSql()).toContain('FULL OUTER JOIN "ur_right" ON FALSE');
      expect((await query.toList()).map(row => `${row.a}|${row.b}`).sort()).toEqual(['A-1|null', 'B-2|null', 'null|A-2', 'null|B-1']);
      void literal;
    });
  });

  /**
   * The legs of mutation CTEs counted, and their first row: the union's WITH declares data-modifying CTEs, which
   * PostgreSQL accepts only in the statement's own WITH (0A000 "WITH clause containing a data-modifying statement
   * must be at the top level"). `count()` wrapped the whole union — its WITH included — in its subquery.
   */
  describe('the legs of mutation CTEs, counted and paged', () => {
    const reset = async () => {
      await client.query('TRUNCATE ur_slots RESTART IDENTITY');
      await db.slots.insertBulk([
        { unitId: 1, tenantId: 10, bin: null, isCurrent: true },
        { unitId: 2, tenantId: 20, bin: 3, isCurrent: true },
      ]);
    };

    const legsOf = (units: number[]) => {
      const builder = new DbCteBuilder();
      const closed = builder.withMutation('ur_closed', db.slots
        .where(s => and(eqAny(s.unitId, units), eq(s.isCurrent, true)))
        .update({ isCurrent: false })
        .toStatement(s => ({ id: s.id, unitId: s.unitId, tenantId: s.tenantId })));
      const opened = builder.withMutation('ur_opened', db.slots.insertFrom(
        fromSet(unnestZip({ unitId: { values: units, type: 'integer' } }), 'd').select(d => ({ unitId: d.unitId })).asSubquery('table'),
        src => ({ unitId: src.unitId, tenantId: 99, isCurrent: true }),
        { where: () => afterMutation(closed.cte) }
      ).toStatement(s => ({ id: s.id, unitId: s.unitId, tenantId: s.tenantId })));

      return { closed, opened };
    };

    for (const units of [[], [1], [1, 2]]) {
      for (const order of ['closed first', 'opened first'] as const) {
        for (const reader of ['count', 'first row'] as const) {
          test(`${units.length} units | ${order} | ${reader}`, async () => {
            await reset();
            const { closed, opened } = legsOf(units);
            const closedLeg = db.selectFromCte(closed.cte).select(r => ({ leg: 'c', id: r.id, unitId: r.unitId, tenantId: r.tenantId }));
            const openedLeg = db.selectFromCte(opened.cte).select(r => ({ leg: 'o', id: r.id, unitId: r.unitId, tenantId: r.tenantId }));
            const union = order === 'closed first' ? (closedLeg as any).unionAll(openedLeg) : (openedLeg as any).unionAll(closedLeg);
            captured.length = 0;

            if (reader === 'count') {
              expect(await union.count()).toBe(units.length * 2);
            } else {
              const row = await union.orderBy((r: any) => [r.unitId, r.leg]).firstOrDefault();
              expect(row === null ? null : { leg: row.leg, unitId: row.unitId, tenantId: row.tenantId }).toEqual(units.length > 0 ? { leg: 'c', unitId: 1, tenantId: 10 } : null);
            }

            // ONE statement, whose own WITH declares the close leg before the open leg; both legs ran to completion
            const statements = captured.filter(entry => entry.includes('\nUNION ALL\n'));
            expect(statements).toHaveLength(1);
            expect(statements[0].startsWith('WITH "ur_closed" AS (')).toBe(true);
            expect(statements[0].match(/"ur_opened" AS \(/g)).toHaveLength(1);
            expect(await db.slots.where(s => eq(s.isCurrent, true)).count()).toBe(2);
            expect((await db.slots.where(s => eq(s.tenantId, 99)).count())).toBe(units.length);
          });
        }
      }
    }
  });
});
