import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import * as linkgress from '../../src';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient,
  serial, integer, varchar,
  inArray, inArrayOpt, notInArray, notInArrayOpt, LinkgressConfig,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';

class PadWidget extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  slot?: DbColumn<number>;
}

class PadBucketTestDatabase extends DbContext {
  get widgets(): DbEntityTable<PadWidget> {
    return this.table(PadWidget);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(PadWidget, entity => {
      entity.toTable('pad_bucket_widgets');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
      entity.property(e => e.slot).hasType(integer('slot'));
    });
  }
}

/**
 * Tests for the opt-in bucket ladder behind `inArrayOpt` / `notInArrayOpt`.
 *
 * Below the threshold the operators render an `IN (…)` placeholder list whose
 * width is the list length, so a family whose lists range over 1…8 elements
 * leaves eight statement texts (and eight cached plans) on every pooled
 * connection. With a ladder configured, each list is instead widened to the
 * next rung and the tail filled by repeating its last element — four texts for
 * a 1/4/8 ladder, with the same rows returned.
 *
 * Repeating a value rather than padding with NULL is what makes this safe and
 * useful at once: `x IN (a, b, b)` selects exactly what `x IN (a, b)` does and
 * `x NOT IN (a, b, b)` exactly what `x NOT IN (a, b)` does, while PostgreSQL
 * still counts the placeholders when it estimates the predicate — a NULL fill
 * would be recognised as matching nothing and change that estimate.
 *
 * Off by default: a ladder trades an exact per-length row estimate for fewer
 * statement texts, and that is the consumer's call.
 */
describe('inArrayOpt bucket ladder', () => {
  const makeContext = (): SqlBuildContext => ({ paramCounter: 1, params: [] });

  /** Simulate the FieldRef a schema-aware mock row hands to a selector. */
  const ref = (sqlType?: string) => ({
    __dbColumnName: 'widget_id',
    __fieldName: 'widgetId',
    __tableAlias: 'w',
    __sqlType: sqlType,
  }) as any;

  const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');

  afterEach(() => {
    LinkgressConfig.resetToDefaults();
  });

  describe('configuration surface', () => {
    test('there is no ladder until one is configured', () => {
      expect(LinkgressConfig.inArrayPadBuckets).toBeNull();
    });

    test('a suggested ladder is published as a constant but is not applied by default', () => {
      expect(LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS).toEqual([1, 4, 8]);
      expect(LinkgressConfig.inArrayPadBuckets).toBeNull();
    });

    test('the ladder is configured through LinkgressConfig, not through package-level functions', () => {
      expect('setInArrayPadBuckets' in linkgress).toBe(false);
      expect('getInArrayPadBuckets' in linkgress).toBe(false);
      expect('DEFAULT_IN_ARRAY_PAD_BUCKETS' in linkgress).toBe(false);
    });

    test('the property setter installs a ladder and the getter reads it back', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);
    });

    test('the stored ladder is a copy the caller cannot mutate afterwards', () => {
      const mine = [1, 4, 8];

      LinkgressConfig.inArrayPadBuckets = mine;
      mine.push(2);

      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);
      expect(() => (LinkgressConfig.inArrayPadBuckets as number[]).push(16)).toThrow();
    });

    test('configure() applies the ladder and null switches it back off', () => {
      LinkgressConfig.configure({ inArrayPadBuckets: [1, 4, 8] });
      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);

      LinkgressConfig.configure({});
      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);

      LinkgressConfig.configure({ inArrayPadBuckets: null });
      expect(LinkgressConfig.inArrayPadBuckets).toBeNull();
    });

    test('resetToDefaults() switches the ladder back off', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      LinkgressConfig.resetToDefaults();

      expect(LinkgressConfig.inArrayPadBuckets).toBeNull();
    });

    test('rejects a malformed ladder and keeps the current one', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      expect(() => { LinkgressConfig.inArrayPadBuckets = []; }).toThrow(/at least one/);
      expect(() => { LinkgressConfig.inArrayPadBuckets = [0, 4]; }).toThrow(/positive integer/);
      expect(() => { LinkgressConfig.inArrayPadBuckets = [1, 2.5]; }).toThrow(/positive integer/);
      expect(() => { LinkgressConfig.inArrayPadBuckets = [4, 1]; }).toThrow(/ascending/);
      expect(() => { LinkgressConfig.inArrayPadBuckets = [1, 4, 4]; }).toThrow(/ascending/);
      expect(() => LinkgressConfig.configure({ inArrayPadBuckets: [-1] })).toThrow(/positive integer/);

      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);
    });
  });

  describe('emitted SQL', () => {
    test('without a ladder the placeholder count is the list length', () => {
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), [4, 8, 15]).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(3)})`);
      expect(ctx.params).toEqual([4, 8, 15]);
    });

    test('a 1/4/8 ladder widens a list to its rung by repeating the last element', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), [4, 8, 15]).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(4)})`);
      expect(ctx.params).toEqual([4, 8, 15, 15]);
    });

    test('a list already exactly on a rung is passed through untouched', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      for (const exact of [[7], [1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]]) {
        const ctx = makeContext();

        expect(inArrayOpt(ref('integer'), exact).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(exact.length)})`);
        expect(ctx.params).toEqual(exact);
      }
    });

    test('the whole 1..8 band collapses to one text per rung', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      const texts = new Set(
        [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
          inArrayOpt(ref('integer'), Array.from({ length: n }, (_, i) => i + 1)).buildSql(makeContext()))
      );

      expect(texts.size).toBe(3);
    });

    test('without a ladder the same band leaves one text per length', () => {
      const texts = new Set(
        [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
          inArrayOpt(ref('integer'), Array.from({ length: n }, (_, i) => i + 1)).buildSql(makeContext()))
      );

      expect(texts.size).toBe(8);
    });

    test('lists above the threshold still bind as one array parameter, unpadded', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const ctx = makeContext();
      const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];

      expect(inArrayOpt(ref('integer'), nine).buildSql(ctx)).toBe('"w"."widget_id" = ANY($1::integer[])');
      expect(ctx.params).toEqual(['{1,2,3,4,5,6,7,8,9}']);
    });

    test('an empty list keeps its constant — there is no element to repeat', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      expect(inArrayOpt(ref('integer'), []).buildSql(makeContext())).toBe('1=0');
      expect(notInArrayOpt(ref('integer'), []).buildSql(makeContext())).toBe('1=1');
    });

    test('notInArrayOpt pads the same way — repeating a value cannot change NOT IN', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const ctx = makeContext();

      expect(notInArrayOpt(ref('integer'), [4, 8, 15]).buildSql(ctx)).toBe(`"w"."widget_id" NOT IN (${placeholders(4)})`);
      expect(ctx.params).toEqual([4, 8, 15, 15]);
    });

    test('a ladder whose top rung is below the threshold still covers the band', () => {
      // Rungs stop at 4 but lists up to 8 take the IN branch; the threshold is
      // the implied final rung, so no length is left rendering at its own width.
      LinkgressConfig.inArrayPadBuckets = [1, 4];
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), [1, 2, 3, 4, 5, 6]).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(8)})`);
      expect(ctx.params).toEqual([1, 2, 3, 4, 5, 6, 6, 6]);
    });

    test('a raised threshold extends the ladder rather than dropping lengths out of it', () => {
      LinkgressConfig.configure({ inArrayOptThreshold: 12, inArrayPadBuckets: [1, 4, 8] });
      const ctx = makeContext();
      const ten = Array.from({ length: 10 }, (_, i) => i + 1);

      expect(inArrayOpt(ref('integer'), ten).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(12)})`);
      expect(ctx.params).toEqual([...ten, 10, 10]);
    });

    test('rungs above the threshold are simply never reached', () => {
      LinkgressConfig.configure({ inArrayOptThreshold: 4, inArrayPadBuckets: [1, 4, 8] });

      expect(inArrayOpt(ref('integer'), [1, 2, 3]).buildSql(makeContext())).toBe(`"w"."widget_id" IN (${placeholders(4)})`);
      expect(inArrayOpt(ref('integer'), [1, 2, 3, 4, 5]).buildSql(makeContext())).toBe('"w"."widget_id" = ANY($1::integer[])');
    });

    test('padding preserves duplicates already present in the list', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const ctx = makeContext();

      expect(inArrayOpt(ref('integer'), [7, 7]).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(4)})`);
      expect(ctx.params).toEqual([7, 7, 7, 7]);
    });

    test('a non-array value still degrades to the inArray constant with a ladder installed', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      expect(inArrayOpt(ref('integer'), undefined as any).buildSql(makeContext())).toBe('1=0');
      expect(notInArrayOpt(ref('integer'), undefined as any).buildSql(makeContext())).toBe('1=1');
    });

    test('the fill repeats the last element whatever its type', () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const ctx = makeContext();

      expect(inArrayOpt(ref('varchar'), ['alpha', 'beta']).buildSql(ctx)).toBe(`"w"."widget_id" IN (${placeholders(4)})`);
      expect(ctx.params).toEqual(['alpha', 'beta', 'beta', 'beta']);
    });
  });

  describe('against PostgreSQL', () => {
    let db: PadBucketTestDatabase;
    let client: DatabaseClient;
    let captured: string[];

    const labelsOf = (rows: Array<{ label: string }>) => rows.map(r => r.label).sort();
    const statementOf = () => captured.find(msg => msg.includes('FROM "pad_bucket_widgets"')) ?? '';

    beforeAll(async () => {
      (EntityMetadataStore as any).metadata.clear();

      client = createFreshClient();
      captured = [];
      db = new PadBucketTestDatabase(client, {
        logQueries: true,
        logParameters: false,
        logger: (msg: string) => captured.push(msg),
      });

      await client.query(`DROP TABLE IF EXISTS pad_bucket_widgets CASCADE`);
      await db.getSchemaManager().ensureCreated();

      for (let i = 1; i <= 12; i++) {
        await db.widgets.insert({ label: `widget-${String(i).padStart(2, '0')}`, slot: i === 12 ? undefined : i });
      }
    });

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS pad_bucket_widgets CASCADE`);
      await db.dispose();
      LinkgressConfig.resetToDefaults();
    });

    test('a padded lookup returns exactly what the unpadded one returns, at every length 1..8', async () => {
      for (let n = 1; n <= 8; n++) {
        const slots = Array.from({ length: n }, (_, i) => i + 1);

        LinkgressConfig.inArrayPadBuckets = null;
        const unpadded = labelsOf(await db.widgets.where(w => inArrayOpt(w.slot, slots)).toList());

        LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
        const padded = labelsOf(await db.widgets.where(w => inArrayOpt(w.slot, slots)).toList());

        expect(padded).toEqual(unpadded);
        expect(padded).toHaveLength(n);
      }
    });

    test('a padded NOT IN returns exactly what the unpadded one returns', async () => {
      const slots = [1, 2, 3];

      LinkgressConfig.inArrayPadBuckets = null;
      const unpadded = labelsOf(await db.widgets.where(w => notInArrayOpt(w.slot, slots)).toList());

      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      const padded = labelsOf(await db.widgets.where(w => notInArrayOpt(w.slot, slots)).toList());

      // widget-12 has a NULL slot: NOT IN over a NULL column drops it under both forms.
      expect(unpadded).toEqual(['widget-04', 'widget-05', 'widget-06', 'widget-07', 'widget-08', 'widget-09', 'widget-10', 'widget-11']);
      expect(padded).toEqual(unpadded);
      expect(padded).toEqual(labelsOf(await db.widgets.where(w => notInArray(w.slot, slots)).toList()));
    });

    test('a padded lookup agrees with a plain inArray on the same list', async () => {
      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];

      for (const slots of [[3], [3, 5], [2, 4, 6], [1, 2, 3, 4, 5]]) {
        expect(labelsOf(await db.widgets.where(w => inArrayOpt(w.slot, slots)).toList()))
          .toEqual(labelsOf(await db.widgets.where(w => inArray(w.slot, slots)).toList()));
      }
    });

    test('the 1..8 band really does collapse to three statement texts on the wire', async () => {
      const textsFor = async (): Promise<Set<string>> => {
        const texts = new Set<string>();

        for (let n = 1; n <= 8; n++) {
          captured.length = 0;
          await db.widgets.where(w => inArrayOpt(w.slot, Array.from({ length: n }, (_, i) => i + 1))).toList();
          texts.add(statementOf());
        }

        return texts;
      };

      LinkgressConfig.inArrayPadBuckets = null;
      expect((await textsFor()).size).toBe(8);

      LinkgressConfig.inArrayPadBuckets = [1, 4, 8];
      expect((await textsFor()).size).toBe(3);
    });

    test('the context option installs the ladder for the whole process', async () => {
      // A second context on the SAME client: never dispose() it — that would end the shared pool.
      const other = new PadBucketTestDatabase(client, { inArrayPadBuckets: [1, 4, 8] });

      expect(other).toBeDefined();
      expect(LinkgressConfig.inArrayPadBuckets).toEqual([1, 4, 8]);

      captured.length = 0;
      await db.widgets.where(w => inArrayOpt(w.slot, [1, 2])).toList();

      expect(statementOf()).toContain('IN ($1, $2, $3, $4)');
    });
  });
});
