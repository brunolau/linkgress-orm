import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import * as linkgress from '../../src';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient, Condition,
  serial, integer, smallint, bigint, numeric, varchar, text, uuid, boolean,
  and, or, not, eq, gt, sql, add, exists, inArrayOpt, LinkgressConfig, QueryBatch,
} from '../../src';
import { ITEM_COLUMN_MAPPER, Placeholder, SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { HourMinute, pgHourMinute } from '../../debug/types/hour-minute';

/**
 * An `or()` whose arms are equalities of the SAME columns with plain values — a list of keys written longhand,
 * `or(...keys.map(k => and(eq(t.a, k.a), eq(t.b, k.b))))` — renders past `LinkgressConfig.inArrayOptThreshold` arms as
 * ONE array parameter per column: `(t.a, t.b) IN (SELECT … FROM unnest($1::a[], $2::b[]))`, and over one column as
 * `inArrayOpt` renders (`t.a = ANY($1::a[])`). Written longhand it binds one parameter per value: 40 000 two-column
 * keys bound 80 000 and every driver refused the statement (postgres.js at 65 534, pg and Bun past 65 535, PGlite past
 * 32 767). The row-constructor `IN` keeps the three-valued result of the OR — NULL where an arm is NULL and none is
 * TRUE — so `not()` of it, and a NULL column, read as they did.
 *
 * ORACLE: every database case runs twice — `LinkgressConfig.orUsesOpt` off (the or() as written) and on — and
 * returns the same rows; the second run must have emitted the array form, or the comparison proves nothing.
 */

class OrShelf extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

/** A slot is keyed by its shelf and its number on it; one column per type the rewrite has to bind */
class OrSlot extends DbEntity {
  id!: DbColumn<number>;                // serial
  shelfId!: DbColumn<number>;           // integer
  slotNo!: DbColumn<number>;            // smallint
  label!: DbColumn<string>;             // varchar(64)
  sku!: DbColumn<string>;               // text
  uid!: DbColumn<string>;               // uuid
  serialNo!: DbColumn<string>;          // bigint
  amount!: DbColumn<number>;            // numeric(12,2)
  open!: DbColumn<boolean>;             // boolean
  opensAt?: DbColumn<HourMinute>;       // smallint through pgHourMinute, NULLABLE
  note?: DbColumn<string>;              // text, NULLABLE
  touched!: DbColumn<number>;           // integer
  shelf?: OrShelf;
}

class OrEqualityDatabase extends DbContext {
  get shelves(): DbEntityTable<OrShelf> {
    return this.table(OrShelf);
  }

  get slots(): DbEntityTable<OrSlot> {
    return this.table(OrSlot);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(OrShelf, entity => {
      entity.toTable('or_eq_shelves');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
    });

    model.entity(OrSlot, entity => {
      entity.toTable('or_eq_slots');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.shelfId).hasType(integer('shelf_id')).isRequired();
      entity.property(e => e.slotNo).hasType(smallint('slot_no')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
      entity.property(e => e.sku).hasType(text('sku')).isRequired();
      entity.property(e => e.uid).hasType(uuid('uid')).isRequired();
      entity.property(e => e.serialNo).hasType(bigint('serial_no')).isRequired();
      entity.property(e => e.amount).hasType(numeric('amount', 12, 2)).isRequired();
      entity.property(e => e.open).hasType(boolean('open')).isRequired();
      entity.property(e => e.opensAt).hasType(smallint('opens_at')).hasCustomMapper(pgHourMinute);
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.touched).hasType(integer('touched')).isRequired();

      entity.hasOne(e => e.shelf, () => OrShelf)
        .withForeignKey(s => s.shelfId)
        .withPrincipalKey(s => s.id);
    });
  }
}

describe('or() of column equalities: one array parameter per column past the threshold', () => {
  const makeContext = (): SqlBuildContext => ({ paramCounter: 1, params: [] });

  /** The FieldRef a schema-aware mock row hands a selector */
  const ref = (column: string, sqlType?: string, extra: Record<string, unknown> = {}) => ({
    __dbColumnName: column,
    __fieldName: column,
    __tableAlias: 's',
    __sqlType: sqlType,
    ...extra,
  }) as any;

  const shelf = ref('shelf_id', 'integer');
  const slot = ref('slot_no', 'smallint');

  /** `count` (shelf, slot) keys: shelf 1…count, slot 0…6 */
  const keys = (count: number): Array<[number, number]> => Array.from({ length: count }, (_, i) => [i + 1, i % 7]);

  /** The keys as an or() of two-column equalities */
  const pairs = (count: number): Condition => or(...keys(count).map(([s, n]) => and(eq(shelf, s), eq(slot, n))));

  const render = (condition: Condition) => {
    const context = makeContext();
    const text = condition.buildSql(context);

    return { sql: text, params: context.params, next: context.paramCounter };
  };

  /** The condition as written: its rendering with the rewrite switched off */
  const asWritten = (condition: Condition) => {
    LinkgressConfig.orUsesOpt = false;

    try {
      return render(condition);
    } finally {
      LinkgressConfig.orUsesOpt = true;
    }
  };

  afterEach(() => {
    LinkgressConfig.resetToDefaults();
  });

  describe('emitted SQL', () => {
    test('up to the threshold (8 arms) an or() renders as written', () => {
      const eight = render(pairs(8));

      expect(eight).toEqual(asWritten(pairs(8)));
      expect(eight.sql).toContain(' OR ');
      expect(eight.params).toHaveLength(16);
    });

    test('past the threshold the keys bind as one array per column, matched as a row', () => {
      const nine = render(pairs(9));

      expect(nine.sql).toBe(
        '(("s"."shelf_id", "s"."slot_no") IN (SELECT "__keys"."k1", "__keys"."k2" FROM unnest($1::integer[], $2::smallint[]) AS "__keys"("k1", "k2")))'
      );
      expect(nine.params).toEqual(['{1,2,3,4,5,6,7,8,9}', '{0,1,2,3,4,5,6,0,1}']);
      expect(nine.next).toBe(3);
    });

    test('the text and its two parameters do not grow with the keys: 40 000 keys bind 2 parameters, not 80 000', () => {
      const texts = new Set<string>();

      for (const count of [9, 50, 40000]) {
        const rendered = render(pairs(count));

        texts.add(rendered.sql);
        expect(rendered.params).toHaveLength(2);
      }

      expect(texts.size).toBe(1);
    });

    test('over one column: exactly what inArrayOpt renders over the same values, bare or in a one-arm and()', () => {
      const values = keys(12).map(([s]) => s);
      const viaOpt = render(inArrayOpt(shelf, values));

      expect(viaOpt.sql).toBe('("s"."shelf_id" = ANY($1::integer[]))');
      expect(render(or(...values.map(v => eq(shelf, v))))).toEqual(viaOpt);
      expect(render(or(...values.map(v => and(eq(shelf, v)))))).toEqual(viaOpt);
    });

    test('three columns, listed in a different order by different arms: one array per column, in the first arm\'s order', () => {
      const label = ref('label', 'varchar');
      const arms = keys(9).map(([s, n], i) => (i % 2 === 0
        ? and(eq(shelf, s), eq(slot, n), eq(label, `l-${i}`))
        : and(eq(label, `l-${i}`), eq(slot, n), eq(shelf, s))));
      const rendered = render(or(...arms));

      expect(rendered.sql).toBe(
        '(("s"."shelf_id", "s"."slot_no", "s"."label") IN (SELECT "__keys"."k1", "__keys"."k2", "__keys"."k3" FROM unnest($1::integer[], $2::smallint[], $3::varchar[]) AS "__keys"("k1", "k2", "k3")))'
      );
      expect(rendered.params).toEqual([
        '{1,2,3,4,5,6,7,8,9}',
        '{0,1,2,3,4,5,6,0,1}',
        '{"l-0","l-1","l-2","l-3","l-4","l-5","l-6","l-7","l-8"}',
      ]);
    });

    test('the parameters continue the statement\'s numbering', () => {
      const context: SqlBuildContext = { paramCounter: 4, params: ['a', 'b', 'c'] };
      const text = pairs(9).buildSql(context);

      expect(text).toContain('unnest($4::integer[], $5::smallint[])');
      expect(context.params).toHaveLength(5);
      expect(context.paramCounter).toBe(6);
    });

    test('each value binds through its column\'s mapper — a collection item column through its item mapper', () => {
      const toMinutes = {
        toDriver: (value: HourMinute) => (value.hour * 60) + value.minute,
        fromDriver: (value: number) => ({ hour: Math.floor(value / 60), minute: value % 60 }),
      };
      const times = Array.from({ length: 9 }, (_, i) => ({ hour: 8 + i, minute: 15 }));

      for (const opens of [ref('opens_at', 'smallint', { __mapper: toMinutes }), ref('opens_at', 'smallint', { [ITEM_COLUMN_MAPPER]: toMinutes })]) {
        const rendered = render(or(...times.map((time, i) => and(eq(shelf, i + 1), eq(opens, time)))));

        expect(rendered.sql).toContain('unnest($1::integer[], $2::smallint[])');
        expect(rendered.params).toEqual(['{1,2,3,4,5,6,7,8,9}', '{495,555,615,675,735,795,855,915,975}']);
      }
    });

    test('a serial column casts to the integer it is stored as, a char column to bpchar — as eqAny casts them', () => {
      const id = ref('id', 'serial');
      const code = ref('code', 'char');
      const rendered = render(or(...keys(9).map(([s]) => and(eq(id, s), eq(code, `c${s}`)))));

      expect(rendered.sql).toContain('unnest($1::integer[], $2::bpchar[])');
    });

    test('not() of it negates the membership', () => {
      expect(render(not(pairs(9))).sql).toBe(
        'NOT ((("s"."shelf_id", "s"."slot_no") IN (SELECT "__keys"."k1", "__keys"."k2" FROM unnest($1::integer[], $2::smallint[]) AS "__keys"("k1", "k2"))))'
      );
    });

    test('every arm\'s refs are still reported, so a navigation column still registers its join', () => {
      const shelfName = ref('name', 'varchar', { __tableAlias: 'shelf', __navigationAliases: [] });
      const condition = or(...keys(9).map(([s, n]) => and(eq(shelfName, `shelf-${s}`), eq(slot, n))));

      expect(condition.getFieldRefs()).toHaveLength(18);
      expect(render(condition).sql).toContain('("shelf"."name", "s"."slot_no") IN');
    });
  });

  describe('what it leaves as written', () => {
    const seenAt = ref('seen_at', 'timestamp');
    const meta = ref('meta', 'jsonb');
    const tags = ref('tags', 'integer[]');
    const untypedShelf = ref('shelf_id', undefined);

    const cases: Array<[string, () => Condition]> = [
      ['an arm comparing to NULL (eq renders IS NULL)', () => or(...keys(9).map(([s, n], i) => and(eq(shelf, s), eq(slot, i === 4 ? null : n))))],
      ['an arm comparing two columns', () => or(...keys(9).map(([s, n], i) => and(eq(shelf, s), eq(slot, i === 4 ? shelf : n))))],
      ['an arm comparing to an sql fragment', () => or(...keys(9).map(([s, n], i) => and(eq(shelf, s), eq(slot, i === 4 ? sql`${n} + 1` : n))))],
      ['an arm comparing to a prepared-statement placeholder', () => or(...keys(9).map(([s, n], i) => and(eq(shelf, s), eq(slot, i === 4 ? new Placeholder('slot') : n))))],
      ['an arm that is not an equality', () => or(...keys(9).map(([s, n], i) => and(eq(shelf, s), i === 4 ? gt(slot, n) : eq(slot, n))))],
      ['arms over different columns', () => or(...keys(9).map(([s, n], i) => (i === 4 ? and(eq(shelf, s), eq(ref('label', 'varchar'), 'x')) : and(eq(shelf, s), eq(slot, n)))))],
      ['an arm with a column the others do not have', () => or(...keys(9).map(([s, n], i) => (i === 4 ? and(eq(shelf, s), eq(slot, n), eq(ref('label', 'varchar'), 'x')) : and(eq(shelf, s), eq(slot, n)))))],
      ['an arm naming one column twice', () => or(...keys(9).map(([s, n], i) => (i === 4 ? and(eq(shelf, s), eq(shelf, n)) : and(eq(shelf, s), eq(slot, n)))))],
      ['an arm that is itself an or()', () => or(...keys(9).map(([s, n], i) => (i === 4 ? or(eq(shelf, s), eq(slot, n)) : and(eq(shelf, s), eq(slot, n)))))],
      ['an arm that is an and() of an and()', () => or(...keys(9).map(([s, n], i) => (i === 4 ? and(and(eq(shelf, s), eq(slot, n))) : and(eq(shelf, s), eq(slot, n)))))],
      ['a column whose type is unknown', () => or(...keys(9).map(([s, n]) => and(eq(untypedShelf, s), eq(slot, n))))],
      ['a jsonb column', () => or(...keys(9).map(([s]) => and(eq(shelf, s), eq(meta, { s })))) ],
      ['an array column', () => or(...keys(9).map(([s, n]) => and(eq(shelf, s), eq(tags, [n])))) ],
      ['a Date bound without a mapper (pg binds it in local time, an array literal in UTC)', () => or(...keys(9).map(([s]) => and(eq(shelf, s), eq(seenAt, new Date(Date.UTC(2026, 0, s)))))) ],
      ['a value the column maps to an object', () => or(...keys(9).map(([s]) => and(eq(shelf, s), eq(ref('point', 'point', { __mapper: { toDriver: (v: unknown) => ({ v }), fromDriver: (v: unknown) => v } }), s))))],
      ['the switch off', () => {
        LinkgressConfig.orUsesOpt = false;

        return pairs(9);
      }],
    ];

    for (const [name, build] of cases) {
      test(name, () => {
        const rendered = render(build());

        expect(rendered).toEqual(asWritten(build()));
        expect(rendered.sql).not.toContain('unnest(');
        expect(rendered.sql).not.toContain('= ANY(');
      });
    }

    test('an and() of equalities is never rewritten: only or() lists keys', () => {
      const conjunction = and(...keys(9).map(([s]) => eq(shelf, s)));

      expect(render(conjunction).sql).not.toContain('= ANY(');
    });
  });

  describe('configuration', () => {
    test('on by default; LinkgressConfig.orUsesOpt reads and writes it', () => {
      expect(LinkgressConfig.orUsesOpt).toBe(true);
      LinkgressConfig.orUsesOpt = false;
      expect(LinkgressConfig.orUsesOpt).toBe(false);
      expect(render(pairs(40)).sql).not.toContain('unnest(');
    });

    test('the switch point is inArrayOptThreshold: 2 rewrites a third arm, 0 a single one', () => {
      LinkgressConfig.inArrayOptThreshold = 2;
      expect(render(pairs(2)).sql).not.toContain('unnest(');
      expect(render(pairs(3)).sql).toContain('unnest(');

      LinkgressConfig.inArrayOptThreshold = 0;
      expect(render(pairs(1)).sql).toContain('unnest(');
    });

    test('configure() and resetToDefaults() move it; a non-boolean is refused and the value kept', () => {
      LinkgressConfig.configure({ orUsesOpt: false });
      expect(LinkgressConfig.orUsesOpt).toBe(false);

      LinkgressConfig.configure({});
      expect(LinkgressConfig.orUsesOpt).toBe(false);

      LinkgressConfig.resetToDefaults();
      expect(LinkgressConfig.orUsesOpt).toBe(true);

      expect(() => { (LinkgressConfig as any).orUsesOpt = 'no'; }).toThrow(/must be a boolean/);
      expect(LinkgressConfig.orUsesOpt).toBe(true);
    });

    test('it is configured through LinkgressConfig, not through package-level functions', () => {
      expect('setOrUsesOpt' in linkgress).toBe(false);
      expect('getOrUsesOpt' in linkgress).toBe(false);
    });
  });

  describe('against the database: the rows the OR returns', () => {
    let db: OrEqualityDatabase;
    let client: DatabaseClient;
    const captured: string[] = [];

    const SHELVES = [1, 2, 3];
    const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    /** A row per (shelf, slot) with every value a function of the key */
    const slotRow = (shelfId: number, slotNo: number) => ({
      shelfId,
      slotNo,
      label: `L${shelfId}-${slotNo}`,
      sku: `sku-${shelfId}-${slotNo}`,
      uid: `00000000-0000-4000-8000-0000000${shelfId}${String(slotNo).padStart(4, '0')}`,
      serialNo: `900719925474${shelfId}${String(slotNo).padStart(3, '0')}`,
      amount: (shelfId * 10) + (slotNo / 4),
      open: slotNo % 2 === 0,
      opensAt: slotNo === 9 ? undefined : { hour: 7 + shelfId, minute: slotNo * 5 },
      note: slotNo % 3 === 0 ? undefined : `note-${shelfId}-${slotNo}`,
      touched: 0,
    });

    const ALL = SHELVES.flatMap(s => SLOTS.map(n => slotRow(s, n)));

    /** 20 keys of seeded rows, 5 of none, 3 repeated */
    const KEYS: Array<[number, number]> = [
      ...ALL.slice(0, 20).map(r => [r.shelfId, r.slotNo] as [number, number]),
      [1, 50], [2, 51], [3, 52], [4, 0], [9, 9],
      [1, 0], [2, 3], [2, 9],
    ];

    const labels = (rows: Array<{ label: string }>) => rows.map(r => r.label).sort();

    /**
     * `read` with the rewrite off and on: both results, the second checked to have emitted `rewritten`, the first not
     * to — without that the comparison compares a query with itself.
     */
    const both = async <T>(read: () => PromiseLike<T>, rewritten: string): Promise<{ written: T; rewritten: T }> => {
      LinkgressConfig.orUsesOpt = false;
      captured.length = 0;
      const written = await read();
      expect(captured.join('\n')).not.toContain(rewritten);

      LinkgressConfig.orUsesOpt = true;
      captured.length = 0;
      const viaArrays = await read();
      expect(captured.join('\n')).toContain(rewritten);

      return { written, rewritten: viaArrays };
    };

    const UNNEST = 'FROM unnest(';

    beforeAll(async () => {
      (EntityMetadataStore as any).metadata.clear();
      client = createFreshClient();
      db = new OrEqualityDatabase(client, {
        logQueries: true,
        logParameters: false,
        logger: (message: string) => {
          captured.push(message);
        },
      });

      await client.query('DROP TABLE IF EXISTS or_eq_slots CASCADE');
      await client.query('DROP TABLE IF EXISTS or_eq_shelves CASCADE');
      await db.getSchemaManager().ensureCreated();
      await db.shelves.insertBulk([{ id: 1, name: 'north' }, { id: 2, name: 'south' }, { id: 3, name: 'east' }]);
      await db.slots.insertBulk(ALL);
    });

    afterAll(async () => {
      await client.query('DROP TABLE IF EXISTS or_eq_slots CASCADE');
      await client.query('DROP TABLE IF EXISTS or_eq_shelves CASCADE');
      await db.dispose();
      LinkgressConfig.resetToDefaults();
    });

    test('composite keys — matching, missing and repeated — select the rows the OR selects', async () => {
      const { written, rewritten } = await both(
        () => db.slots.where(s => or(...KEYS.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).select(s => ({ label: s.label })).toList(),
        UNNEST
      );

      expect(labels(rewritten)).toEqual(labels(written));
      expect(rewritten).toHaveLength(20);
    });

    test('every column type of the matrix, beside the shelf and alone', async () => {
      const rows = ALL.filter(r => r.opensAt !== undefined).slice(0, 12);
      const columns: Array<{ name: string; pick: (s: any) => any; value: (r: typeof ALL[number]) => unknown }> = [
        { name: 'varchar', pick: s => s.label, value: r => r.label },
        { name: 'text', pick: s => s.sku, value: r => r.sku },
        { name: 'uuid', pick: s => s.uid, value: r => r.uid },
        { name: 'bigint', pick: s => s.serialNo, value: r => r.serialNo },
        { name: 'numeric', pick: s => s.amount, value: r => r.amount },
        { name: 'smallint through a mapper', pick: s => s.opensAt, value: r => r.opensAt },
      ];

      for (const column of columns) {
        const pairsRead = await both(
          () => db.slots.where(s => or(...rows.map(r => and(eq(s.shelfId, r.shelfId), eq(column.pick(s), column.value(r)))))).select(s => ({ label: s.label })).toList(),
          UNNEST
        );
        expect({ column: column.name, rows: labels(pairsRead.rewritten) }).toEqual({ column: column.name, rows: labels(pairsRead.written) });
        expect(pairsRead.rewritten).toHaveLength(12);

        const aloneRead = await both(
          () => db.slots.where(s => or(...rows.map(r => eq(column.pick(s), column.value(r))))).select(s => ({ label: s.label })).toList(),
          '= ANY('
        );
        expect({ column: column.name, rows: labels(aloneRead.rewritten) }).toEqual({ column: column.name, rows: labels(aloneRead.written) });
      }

      // boolean: nine arms over two values
      const flags = await both(
        () => db.slots.where(s => or(...[true, false, true, false, true, false, true, false, true].map((flag, i) => and(eq(s.shelfId, 1 + (i % 3)), eq(s.open, flag))))).select(s => ({ label: s.label })).toList(),
        UNNEST
      );
      expect(labels(flags.rewritten)).toEqual(labels(flags.written));
    });

    test('NULL in the row: the or() and not() of it keep the three-valued result of the OR', async () => {
      const noteKeys = ALL.filter(r => r.note !== undefined).slice(0, 10).map(r => [r.shelfId, r.note!] as [number, string]);
      const keysOr = (s: any) => or(...noteKeys.map(([a, note]) => and(eq(s.shelfId, a), eq(s.note, note))), and(eq(s.shelfId, 1), eq(s.note, 'missing')));

      const matched = await both(() => db.slots.where(s => keysOr(s)).select(s => ({ label: s.label })).toList(), UNNEST);
      expect(labels(matched.rewritten)).toEqual(labels(matched.written));
      expect(matched.rewritten).toHaveLength(10);

      // A note-less slot of shelf 1 or 2 is neither in nor out — an arm of its shelf compares its NULL note, NOT (NULL)
      // is NULL — so both forms leave it out; no key names shelf 3, every arm is FALSE there and both forms take its
      // 4 note-less slots: the 8 noted slots outside the keys, and those 4
      const others = await both(() => db.slots.where(s => not(keysOr(s))).select(s => ({ label: s.label })).toList(), UNNEST);
      expect(labels(others.rewritten)).toEqual(labels(others.written));
      expect(labels(others.rewritten)).toEqual(labels([
        ...ALL.filter(r => r.note !== undefined).slice(10),
        ...ALL.filter(r => r.note === undefined && r.shelfId === 3),
      ]));
    });

    test('the context option writes LinkgressConfig.orUsesOpt for the whole process', async () => {
      // A second context on the SAME client: never dispose() it — that would end the shared pool
      const other = new OrEqualityDatabase(client, { orUsesOpt: false });

      expect(other).toBeDefined();
      expect(LinkgressConfig.orUsesOpt).toBe(false);

      captured.length = 0;
      await db.slots.where(s => or(...KEYS.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).toList();
      expect(captured.join('\n')).not.toContain(UNNEST);

      LinkgressConfig.orUsesOpt = true;
    });

    test('a navigation column joins its table', async () => {
      const named = await both(
        () => db.slots.where(s => or(...KEYS.map(([a, b]) => and(eq(s.shelf!.name, ['north', 'south', 'east'][(a - 1) % 3] ?? 'none'), eq(s.slotNo, b))))).select(s => ({ label: s.label })).toList(),
        UNNEST
      );

      expect(labels(named.rewritten)).toEqual(labels(named.written));
      expect(captured.join('\n')).toContain('"or_eq_shelves"');
    });

    test('UPDATE … RETURNING and DELETE … RETURNING take the rows the OR takes', async () => {
      const updated = await both(
        () => db.slots.where(s => or(...KEYS.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).update(s => ({ touched: add(s.touched, 1) })).returning(s => ({ label: s.label })),
        UNNEST
      );
      expect(labels(updated.rewritten as any)).toEqual(labels(updated.written as any));
      expect(updated.rewritten as any).toHaveLength(20);

      // Throwaway slots 20–29 of shelf 3, inserted before each run and deleted by it
      const extra = SLOTS.map(n => slotRow(3, 20 + n));
      const deleted = await both(async () => {
        await db.slots.insertBulk(extra);

        return db.slots.where(s => or(...SLOTS.map(n => and(eq(s.shelfId, 3), eq(s.slotNo, 20 + n))))).delete().returning(s => ({ label: s.label }));
      }, UNNEST);
      expect(labels(deleted.rewritten as any)).toEqual(labels(deleted.written as any));
      expect(deleted.rewritten as any).toHaveLength(10);
    });

    test('inside a correlated subquery and in a later QueryBatch leg, numbered after what precedes it', async () => {
      const withSlots = await both(
        () => db.shelves.where(sh => exists(db.slots.where(s => and(eq(s.shelfId, sh.id), or(...KEYS.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b)))))).select(s => ({ id: s.id })).asSubquery())).select(sh => ({ name: sh.name })).toList(),
        UNNEST
      );
      expect(withSlots.rewritten.map(r => r.name).sort()).toEqual(withSlots.written.map(r => r.name).sort());

      const batched = await both(async () => {
        const batch = new QueryBatch();
        const first = batch.addList(db.slots.where(s => and(eq(s.open, true), eq(s.shelfId, 2))).select(s => ({ label: s.label })), 'open');
        const second = batch.addList(db.slots.where(s => or(...KEYS.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).select(s => ({ label: s.label })), 'keys');
        await batch.executeBatch();

        return { open: labels(batch.getList(first)), keys: labels(batch.getList(second)) };
      }, UNNEST);
      expect(batched.rewritten).toEqual(batched.written);
      expect(batched.rewritten.keys).toHaveLength(20);
    });

    test('40 000 composite keys in one or(): the statement binds 2 parameters and returns the matching rows', async () => {
      const many: Array<[number, number]> = [
        ...ALL.map(r => [r.shelfId, r.slotNo] as [number, number]),
        ...Array.from({ length: 40000 - ALL.length }, (_, i) => [1000 + i, i % 100] as [number, number]),
      ];

      captured.length = 0;
      const rows = await db.slots.where(s => or(...many.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).select(s => ({ label: s.label })).toList();

      expect(labels(rows)).toEqual(labels(ALL));
      expect(captured.join('\n')).toContain('unnest($1::integer[], $2::smallint[])');

      const touched = await db.slots.where(s => or(...many.map(([a, b]) => and(eq(s.shelfId, a), eq(s.slotNo, b))))).update({ touched: 0 }).returning(s => ({ label: s.label }));
      expect(touched).toHaveLength(ALL.length);
    }, 60000);
  });
});
