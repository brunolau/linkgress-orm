import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import * as linkgress from '../../src';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient,
  serial, integer, varchar,
  inArrayOpt, notInArrayOpt, inArray, notInArray,
  LinkgressConfig,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * Tests for inArrayOpt / notInArrayOpt: `IN (…)` placeholders up to a configurable
 * list length, one array parameter (`= ANY(…)` / `<> ALL(…)`) above it. The point
 * is prepared-statement caches — one statement text per family instead of one per
 * list length — with results identical to inArray / notInArray (changelog/v0.4.72.md).
 * The threshold is configured through the LinkgressConfig static class.
 */

class OptItem extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  rank?: DbColumn<number>;
}

class InArrayOptTestDatabase extends DbContext {
  get optItems(): DbEntityTable<OptItem> {
    return this.table(OptItem);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(OptItem, entity => {
      entity.toTable('in_array_opt_items');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
      entity.property(e => e.rank).hasType(integer('rank'));
    });
  }
}

describe('inArrayOpt / notInArrayOpt', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  /** Simulate the FieldRef a schema-aware mock row hands to a selector. */
  const ref = (sqlType?: string) => ({
    __dbColumnName: 'product_id',
    __fieldName: 'productId',
    __tableAlias: 'p',
    __sqlType: sqlType,
  }) as any;

  afterEach(() => {
    LinkgressConfig.resetToDefaults();
  });

  describe('configuration surface', () => {
    test('the default threshold is 8', () => {
      expect(LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD).toBe(8);
      expect(LinkgressConfig.inArrayOptThreshold).toBe(8);
    });

    test('the threshold is configured through LinkgressConfig, not through package-level functions', () => {
      expect(typeof LinkgressConfig).toBe('function');
      expect('setInArrayOptThreshold' in linkgress).toBe(false);
      expect('getInArrayOptThreshold' in linkgress).toBe(false);
      expect('DEFAULT_IN_ARRAY_OPT_THRESHOLD' in linkgress).toBe(false);
    });

    test('the property setter moves the threshold and the getter reads it back', () => {
      LinkgressConfig.inArrayOptThreshold = 2;

      expect(LinkgressConfig.inArrayOptThreshold).toBe(2);
    });

    test('configure() applies the keys it is given and leaves the rest alone', () => {
      LinkgressConfig.configure({ inArrayOptThreshold: 3 });
      expect(LinkgressConfig.inArrayOptThreshold).toBe(3);

      LinkgressConfig.configure({});
      expect(LinkgressConfig.inArrayOptThreshold).toBe(3);
    });

    test('resetToDefaults() restores the default', () => {
      LinkgressConfig.inArrayOptThreshold = 1;
      LinkgressConfig.resetToDefaults();

      expect(LinkgressConfig.inArrayOptThreshold).toBe(LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD);
    });

    test('rejects a threshold that is not a non-negative integer and keeps the current value', () => {
      expect(() => { LinkgressConfig.inArrayOptThreshold = -1; }).toThrow(/non-negative integer/);
      expect(() => { LinkgressConfig.inArrayOptThreshold = 1.5; }).toThrow(/non-negative integer/);
      expect(() => { LinkgressConfig.inArrayOptThreshold = Number.NaN; }).toThrow(/non-negative integer/);
      expect(() => LinkgressConfig.configure({ inArrayOptThreshold: -2 })).toThrow(/non-negative integer/);
      expect(LinkgressConfig.inArrayOptThreshold).toBe(LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD);
    });
  });

  describe('emitted SQL', () => {
    test('a list up to the threshold renders inArray placeholders', () => {
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), [4, 8, 15]).buildSql(ctx)).toBe('"p"."product_id" IN ($1, $2, $3)');
      expect(ctx.params).toEqual([4, 8, 15]);
    });

    test('exactly the threshold still renders the IN list', () => {
      const ctx = makeContext();
      const eight = [1, 2, 3, 4, 5, 6, 7, 8];

      expect(inArrayOpt(ref('integer'), eight).buildSql(ctx))
        .toBe('"p"."product_id" IN ($1, $2, $3, $4, $5, $6, $7, $8)');
      expect(ctx.params).toEqual(eight);
    });

    test('one element past the threshold binds the whole list as one array parameter', () => {
      const ctx = makeContext();
      const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];

      expect(inArrayOpt(ref('integer'), nine).buildSql(ctx)).toBe('"p"."product_id" = ANY($1::integer[])');
      expect(ctx.params).toEqual(['{1,2,3,4,5,6,7,8,9}']);
      expect(ctx.paramCounter).toBe(2);
    });

    test('the statement text is the same for every list length above the threshold', () => {
      const texts = new Set(
        [9, 20, 150, 500].map(n => inArrayOpt(ref('integer'), Array.from({ length: n }, (_, i) => i)).buildSql(makeContext()))
      );

      expect(texts.size).toBe(1);
    });

    test('an empty list is the constant inArray renders', () => {
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), []).buildSql(ctx)).toBe('1=0');
      expect(ctx.params).toEqual([]);
      expect(notInArrayOpt(ref('integer'), []).buildSql(makeContext())).toBe('1=1');
    });

    test('notInArrayOpt mirrors the switch with NOT IN and <> ALL', () => {
      expect(notInArrayOpt(ref('integer'), [1, 2]).buildSql(makeContext())).toBe('"p"."product_id" NOT IN ($1, $2)');
      expect(notInArrayOpt(ref('integer'), Array.from({ length: 9 }, (_, i) => i)).buildSql(makeContext()))
        .toBe('"p"."product_id" <> ALL($1::integer[])');
    });

    test('the array form carries the column cast, uncast refs stay bare', () => {
      const nine = Array.from({ length: 9 }, (_, i) => i);

      expect(inArrayOpt(ref('uuid'), nine.map(String)).buildSql(makeContext())).toContain('::uuid[]');
      expect(inArrayOpt(ref(undefined), nine).buildSql(makeContext())).toBe('"p"."product_id" = ANY($1)');
    });

    test('a configured threshold moves the switch point for both operators', () => {
      LinkgressConfig.inArrayOptThreshold = 2;

      expect(inArrayOpt(ref('integer'), [1, 2]).buildSql(makeContext())).toBe('"p"."product_id" IN ($1, $2)');
      expect(inArrayOpt(ref('integer'), [1, 2, 3]).buildSql(makeContext())).toBe('"p"."product_id" = ANY($1::integer[])');
      expect(notInArrayOpt(ref('integer'), [1, 2, 3]).buildSql(makeContext())).toBe('"p"."product_id" <> ALL($1::integer[])');
    });

    test('threshold 0 sends every non-empty list to the array form, the empty list stays constant', () => {
      LinkgressConfig.inArrayOptThreshold = 0;

      expect(inArrayOpt(ref('integer'), [1]).buildSql(makeContext())).toBe('"p"."product_id" = ANY($1::integer[])');
      expect(inArrayOpt(ref('integer'), []).buildSql(makeContext())).toBe('1=0');
    });

    test('a non-array value degrades to the inArray constant instead of throwing', () => {
      expect(inArrayOpt(ref('integer'), undefined as any).buildSql(makeContext())).toBe('1=0');
    });
  });

  describe('inArrayUsesOpt — plain inArray routed through the opt rendering', () => {
    const nine = Array.from({ length: 9 }, (_, i) => i + 1);

    test('it is off by default, so inArray keeps its exact-length IN list', () => {
      expect(LinkgressConfig.inArrayUsesOpt).toBe(false);
      expect(inArray(ref('integer'), nine).buildSql(makeContext()))
        .toBe('"p"."product_id" IN ($1, $2, $3, $4, $5, $6, $7, $8, $9)');
      expect(notInArray(ref('integer'), nine).buildSql(makeContext()))
        .toBe('"p"."product_id" NOT IN ($1, $2, $3, $4, $5, $6, $7, $8, $9)');
    });

    test('switched on, inArray renders exactly what inArrayOpt renders at every length', () => {
      LinkgressConfig.inArrayUsesOpt = true;

      const lists = [[], [1], [1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8], nine, Array.from({ length: 40 }, (_, i) => i)];

      for (const values of lists) {
        const viaPlain = makeContext();
        const viaOpt = makeContext();

        expect(inArray(ref('integer'), values).buildSql(viaPlain))
          .toBe(inArrayOpt(ref('integer'), values).buildSql(viaOpt));
        expect(viaPlain.params).toEqual(viaOpt.params);

        const negPlain = makeContext();
        const negOpt = makeContext();

        expect(notInArray(ref('integer'), values).buildSql(negPlain))
          .toBe(notInArrayOpt(ref('integer'), values).buildSql(negOpt));
        expect(negPlain.params).toEqual(negOpt.params);
      }
    });

    test('switched on, a long list binds as one array parameter with the column cast', () => {
      LinkgressConfig.inArrayUsesOpt = true;
      const ctx = makeContext();

      expect(inArray(ref('integer'), nine).buildSql(ctx)).toBe('"p"."product_id" = ANY($1::integer[])');
      expect(ctx.params).toEqual(['{1,2,3,4,5,6,7,8,9}']);
      expect(notInArray(ref('integer'), nine).buildSql(makeContext()))
        .toBe('"p"."product_id" <> ALL($1::integer[])');
    });

    test('the threshold and the pad ladder apply to the routed inArray as well', () => {
      LinkgressConfig.configure({ inArrayUsesOpt: true, inArrayOptThreshold: 4, inArrayPadBuckets: [1, 4] });

      expect(inArray(ref('integer'), [1]).buildSql(makeContext())).toBe('"p"."product_id" IN ($1)');
      expect(inArray(ref('integer'), [1, 2]).buildSql(makeContext())).toBe('"p"."product_id" IN ($1, $2, $3, $4)');
      expect(inArray(ref('integer'), [1, 2, 3, 4, 5]).buildSql(makeContext())).toBe('"p"."product_id" = ANY($1::integer[])');
    });

    test('padding repeats the last element, so the routed inArray still selects the same rows', () => {
      LinkgressConfig.configure({ inArrayUsesOpt: true, inArrayPadBuckets: [4] });
      const ctx = makeContext();

      expect(inArray(ref('integer'), [7, 9]).buildSql(ctx)).toBe('"p"."product_id" IN ($1, $2, $3, $4)');
      expect(ctx.params).toEqual([7, 9, 9, 9]);
    });

    test('the empty list and a non-array value keep their constants with the switch on', () => {
      LinkgressConfig.inArrayUsesOpt = true;

      expect(inArray(ref('integer'), []).buildSql(makeContext())).toBe('1=0');
      expect(notInArray(ref('integer'), []).buildSql(makeContext())).toBe('1=1');
      expect(inArray(ref('integer'), undefined as any).buildSql(makeContext())).toBe('1=0');
      expect(notInArray(ref('integer'), undefined as any).buildSql(makeContext())).toBe('1=1');
    });

    test('inArray and inArrayOpt do not recurse into each other — a short list is one flat call', () => {
      // The regression this guards: routing inArray through the PUBLIC inArrayOpt (which used to
      // call inArray for the sub-threshold branch) makes the pair mutually recursive and blows the
      // stack on the very first short list. Both now bottom out in a private renderer instead.
      LinkgressConfig.inArrayUsesOpt = true;

      expect(() => inArray(ref('integer'), [1, 2, 3]).buildSql(makeContext())).not.toThrow();
      expect(() => notInArray(ref('integer'), [1, 2, 3]).buildSql(makeContext())).not.toThrow();
      expect(() => inArrayOpt(ref('integer'), [1, 2, 3]).buildSql(makeContext())).not.toThrow();
      expect(() => notInArrayOpt(ref('integer'), [1, 2, 3]).buildSql(makeContext())).not.toThrow();

      // …and it holds from a stack already deep, where the handful of frames a flat call adds is
      // survivable but an unbounded mutual recursion would not be.
      const deep = (depth: number): string =>
        depth === 0
          ? inArray(ref('integer'), [1, 2, 3]).buildSql(makeContext())
          : deep(depth - 1);

      expect(deep(500)).toBe('"p"."product_id" IN ($1, $2, $3)');
    });

    test('resetToDefaults() and configure() move the switch, and it rejects a non-boolean', () => {
      LinkgressConfig.inArrayUsesOpt = true;
      LinkgressConfig.resetToDefaults();
      expect(LinkgressConfig.inArrayUsesOpt).toBe(false);

      LinkgressConfig.configure({ inArrayUsesOpt: true });
      expect(LinkgressConfig.inArrayUsesOpt).toBe(true);

      LinkgressConfig.configure({});
      expect(LinkgressConfig.inArrayUsesOpt).toBe(true);

      expect(() => { (LinkgressConfig as any).inArrayUsesOpt = 'yes'; }).toThrow(/must be a boolean/);
      expect(LinkgressConfig.inArrayUsesOpt).toBe(true);

      expect('setInArrayUsesOpt' in linkgress).toBe(false);
      expect('getInArrayUsesOpt' in linkgress).toBe(false);
    });
  });

  describe('against PostgreSQL', () => {
    let db: InArrayOptTestDatabase;
    let client: DatabaseClient;
    let captured: string[];

    const labelsOf = (rows: Array<{ label: string }>) => rows.map(r => r.label).sort();

    beforeAll(async () => {
      (EntityMetadataStore as any).metadata.clear();

      client = createFreshClient();
      captured = [];
      db = new InArrayOptTestDatabase(client, {
        logQueries: true,
        logParameters: false,
        logger: (msg: string) => captured.push(msg),
      });

      await client.query(`DROP TABLE IF EXISTS in_array_opt_items CASCADE`);
      await db.getSchemaManager().ensureCreated();

      for (let i = 1; i <= 12; i++) {
        await db.optItems.insert({ label: `item-${String(i).padStart(2, '0')}`, rank: i === 12 ? undefined : i });
      }
    });

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS in_array_opt_items CASCADE`);
      await db.dispose();
      LinkgressConfig.resetToDefaults();
    });

    test('below and above the threshold, inArrayOpt returns exactly what inArray returns', async () => {
      const short = [1, 2, 3];
      const long = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

      expect(labelsOf(await db.optItems.where(i => inArrayOpt(i.rank, short)).toList()))
        .toEqual(labelsOf(await db.optItems.where(i => inArray(i.rank, short)).toList()));
      expect(labelsOf(await db.optItems.where(i => inArrayOpt(i.rank, long)).toList()))
        .toEqual(labelsOf(await db.optItems.where(i => inArray(i.rank, long)).toList()));
      expect(await db.optItems.where(i => inArrayOpt(i.rank, long)).toList()).toHaveLength(11);
    });

    test('notInArrayOpt returns what notInArray returns, NULL rows excluded by both', async () => {
      const long = [1, 2, 3, 4, 5, 6, 7, 8, 9];

      const viaOpt = labelsOf(await db.optItems.where(i => notInArrayOpt(i.rank, long)).toList());
      const viaNotIn = labelsOf(await db.optItems.where(i => notInArray(i.rank, long)).toList());

      // item-12 has a NULL rank: NULL <> ALL (…) is NULL, so both forms drop it.
      expect(viaOpt).toEqual(['item-10', 'item-11']);
      expect(viaOpt).toEqual(viaNotIn);
    });

    test('the context option writes LinkgressConfig.inArrayOptThreshold for the whole process', async () => {
      // A second context on the SAME client: never dispose() it — that would end the shared pool.
      const other = new InArrayOptTestDatabase(client, { inArrayOptThreshold: 1 });

      expect(other).toBeDefined();
      expect(LinkgressConfig.inArrayOptThreshold).toBe(1);

      captured.length = 0;
      await db.optItems.where(i => inArrayOpt(i.rank, [1, 2])).toList();

      expect(captured.some(msg => msg.includes('= ANY($1::integer[])'))).toBe(true);
    });

    test('above the threshold the statement text does not change with the list length', async () => {
      const textsFor = async (lengths: number[]): Promise<Set<string>> => {
        const texts = new Set<string>();

        for (const n of lengths) {
          captured.length = 0;
          await db.optItems.where(i => inArrayOpt(i.rank, Array.from({ length: n }, (_, k) => k + 1))).toList();
          texts.add(captured.find(msg => msg.includes('FROM "in_array_opt_items"')) ?? '');
        }

        return texts;
      };

      expect((await textsFor([9, 10, 11])).size).toBe(1);
      expect((await textsFor([1, 2, 3])).size).toBe(3);
    });

    test('inArrayUsesOpt makes a plain inArray query emit the array form and return the same rows', async () => {
      LinkgressConfig.resetToDefaults();
      const long = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

      const exact = labelsOf(await db.optItems.where(i => inArray(i.rank, long)).toList());

      LinkgressConfig.inArrayUsesOpt = true;
      captured.length = 0;

      const routed = labelsOf(await db.optItems.where(i => inArray(i.rank, long)).toList());

      expect(routed).toEqual(exact);
      expect(routed).toHaveLength(11);
      expect(captured.some(msg => msg.includes('= ANY($1::integer[])'))).toBe(true);

      // …and NOT IN mirrors it, NULL-ranked item-12 dropped by both forms.
      captured.length = 0;
      expect(labelsOf(await db.optItems.where(i => notInArray(i.rank, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toList()))
        .toEqual(['item-10', 'item-11']);
      expect(captured.some(msg => msg.includes('<> ALL($1::integer[])'))).toBe(true);
    });

    test('the context option writes the switch process-wide, like the other two', async () => {
      LinkgressConfig.resetToDefaults();
      expect(LinkgressConfig.inArrayUsesOpt).toBe(false);

      // A second context on the SAME client: never dispose() it — that would end the shared pool.
      const other = new InArrayOptTestDatabase(client, { inArrayUsesOpt: true });

      expect(other).toBeDefined();
      expect(LinkgressConfig.inArrayUsesOpt).toBe(true);

      captured.length = 0;
      await db.optItems.where(i => inArray(i.rank, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toList();

      expect(captured.some(msg => msg.includes('= ANY($1::integer[])'))).toBe(true);
    });
  });
});
