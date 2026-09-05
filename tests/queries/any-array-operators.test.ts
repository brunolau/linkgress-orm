import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient,
  serial, integer, smallint, bigint, numeric, varchar, char, text, uuid, timestamptz,
  eqAny, neAll, inArray, notInArray,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { HourMinute, pgHourMinute } from '../../debug/types/hour-minute';

/**
 * Tests for the ANY/ALL array combinators (eqAny / neAll).
 *
 * Unlike `inArray`, which renders one placeholder per element, these bind the
 * WHOLE list as a single parameter — a PostgreSQL array literal cast to the
 * column's declared element type. The statement text is therefore independent
 * of the list length, which is what makes it reusable as a prepared statement
 * (see changelog/v0.4.70.md).
 */

class AnyGroup extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

/** One column per cast the operators have to get right, plus a nullable one. */
class AnyItem extends DbEntity {
  id!: DbColumn<number>;              // serial     -> ::integer[]
  label!: DbColumn<string>;           // varchar(64)
  code!: DbColumn<string>;            // char(8)    -> ::bpchar[]
  sku!: DbColumn<string>;             // text
  uid!: DbColumn<string>;             // uuid
  amount!: DbColumn<number>;          // numeric(12,2)
  serialNo!: DbColumn<string>;        // bigint
  seenAt!: DbColumn<Date>;            // timestamptz
  ratio?: DbColumn<number>;           // smallint, NULLABLE
  startAt?: DbColumn<HourMinute>;     // smallint through pgHourMinute
  groupId!: DbColumn<number>;
  group?: AnyGroup;
}

class AnyArrayTestDatabase extends DbContext {
  get anyItems(): DbEntityTable<AnyItem> {
    return this.table(AnyItem);
  }

  get anyGroups(): DbEntityTable<AnyGroup> {
    return this.table(AnyGroup);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(AnyGroup, entity => {
      entity.toTable('any_array_groups');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
    });

    model.entity(AnyItem, entity => {
      entity.toTable('any_array_items');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
      entity.property(e => e.code).hasType(char('code', 8)).isRequired();
      entity.property(e => e.sku).hasType(text('sku')).isRequired();
      entity.property(e => e.uid).hasType(uuid('uid')).isRequired();
      entity.property(e => e.amount).hasType(numeric('amount', 12, 2)).isRequired();
      entity.property(e => e.serialNo).hasType(bigint('serial_no')).isRequired();
      entity.property(e => e.seenAt).hasType(timestamptz('seen_at')).isRequired();
      entity.property(e => e.ratio).hasType(smallint('ratio'));
      entity.property(e => e.startAt).hasType(smallint('start_at')).hasCustomMapper(pgHourMinute);
      entity.property(e => e.groupId).hasType(integer('group_id')).isRequired();

      entity.hasOne(e => e.group, () => AnyGroup)
        .withForeignKey(i => i.groupId)
        .withPrincipalKey(g => g.id);
    });
  }
}

describe('ANY/ALL array operators', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  /** Simulate the FieldRef a schema-aware mock row hands to a selector. */
  const ref = (sqlType?: string, extra: Record<string, unknown> = {}) => ({
    __dbColumnName: 'product_price_id',
    __fieldName: 'productPriceId',
    __tableAlias: 'oi',
    __sqlType: sqlType,
    ...extra,
  }) as any;

  describe('emitted SQL', () => {
    test('eqAny binds the whole list as one parameter cast to the column array type', () => {
      const ctx = makeContext();

      expect(eqAny(ref('integer'), [4, 8, 15]).buildSql(ctx))
        .toBe('"oi"."product_price_id" = ANY($1::integer[])');
      expect(ctx.params).toEqual(['{4,8,15}']);
    });

    test('neAll emits the negated form over the same single parameter', () => {
      const ctx = makeContext();

      expect(neAll(ref('integer'), [4, 8, 15]).buildSql(ctx))
        .toBe('"oi"."product_price_id" <> ALL($1::integer[])');
      expect(ctx.params).toEqual(['{4,8,15}']);
    });

    test('the parameter count is one regardless of list length', () => {
      const ctx = makeContext();

      eqAny(ref('integer'), Array.from({ length: 500 }, (_, i) => i)).buildSql(ctx);

      expect(ctx.params).toHaveLength(1);
      expect(ctx.paramCounter).toBe(2);
    });

    test('serial pseudo-types normalize to the integer type they are stored as', () => {
      expect(eqAny(ref('serial'), [1]).buildSql(makeContext())).toContain('::integer[]');
      expect(eqAny(ref('smallserial'), [1]).buildSql(makeContext())).toContain('::smallint[]');
      expect(eqAny(ref('bigserial'), [1]).buildSql(makeContext())).toContain('::bigint[]');
    });

    test('char normalizes to bpchar, which does not truncate values to one character', () => {
      // `char[]` is `character(1)[]`: 'abcdefgh' would be cut to 'a' and never match.
      expect(eqAny(ref('char'), ['abcdefgh']).buildSql(makeContext())).toContain('::bpchar[]');
    });

    test('declared types pass through unchanged, modifiers and all', () => {
      const cast = (sqlType: string) => eqAny(ref(sqlType), ['x']).buildSql(makeContext());

      expect(cast('varchar')).toContain('::varchar[]');
      expect(cast('text')).toContain('::text[]');
      expect(cast('uuid')).toContain('::uuid[]');
      expect(cast('numeric')).toContain('::numeric[]');
      expect(cast('double precision')).toContain('::double precision[]');
      expect(cast('timestamptz')).toContain('::timestamptz[]');
      // Custom mappers overwrite the column type with their own dataType()
      expect(cast('order_status')).toContain('::order_status[]');
      expect(cast('vector(3)')).toContain('::vector(3)[]');
    });

    test('refs carrying no type information stay uncast', () => {
      // CTE columns and post-select shapes have no __sqlType. Postgres still
      // infers the array type from the ANY context, so bare is correct there.
      expect(eqAny(ref(undefined), [1]).buildSql(makeContext()))
        .toBe('"oi"."product_price_id" = ANY($1)');
      expect(neAll(ref(undefined), [1]).buildSql(makeContext()))
        .toBe('"oi"."product_price_id" <> ALL($1)');
    });

    test('the untyped "array" column type stays uncast', () => {
      // ColumnType 'array' names no element type — there is nothing to cast to.
      expect(eqAny(ref('array'), [1]).buildSql(makeContext())).not.toContain('::');
    });

    test('the column mapper is applied per element before serialization', () => {
      const mapper = {
        toDriver: (value: { hour: number; minute: number }) => value.hour * 60 + value.minute,
        fromDriver: (value: number) => ({ hour: Math.floor(value / 60), minute: value % 60 }),
      };
      const ctx = makeContext();

      const fragment = eqAny(ref('smallint', { __mapper: mapper }), [
        { hour: 9, minute: 30 },
        { hour: 17, minute: 0 },
      ]);

      expect(fragment.buildSql(ctx)).toBe('"oi"."product_price_id" = ANY($1::smallint[])');
      expect(ctx.params).toEqual(['{570,1020}']);
    });

    test('an empty list keeps the ANY form instead of a constant predicate', () => {
      // `= ANY('{}')` is already FALSE and `<> ALL('{}')` already TRUE, so the
      // semantics match inArray/notInArray while the statement text stays stable.
      const anyCtx = makeContext();
      expect(eqAny(ref('integer'), []).buildSql(anyCtx))
        .toBe('"oi"."product_price_id" = ANY($1::integer[])');
      expect(anyCtx.params).toEqual(['{}']);

      const allCtx = makeContext();
      expect(neAll(ref('integer'), []).buildSql(allCtx))
        .toBe('"oi"."product_price_id" <> ALL($1::integer[])');
      expect(allCtx.params).toEqual(['{}']);
    });

    test('nulls, quotes and backslashes are escaped in the array literal', () => {
      const ctx = makeContext();

      eqAny(ref('text'), ['plain', 'say "hi"', 'back\\slash', null as any]).buildSql(ctx);

      expect(ctx.params).toEqual(['{"plain","say \\"hi\\"","back\\\\slash",NULL}']);
    });

    test('exposes the column so JOIN detection can resolve navigation aliases', () => {
      const navRef = ref('integer', { __navigationAliases: ['task', 'level'] });

      expect(eqAny(navRef, [1]).getFieldRefs()).toEqual([navRef]);
      expect(neAll(navRef, [1]).getFieldRefs()).toEqual([navRef]);
    });
  });

  describe('against PostgreSQL', () => {
    let db: AnyArrayTestDatabase;
    let client: DatabaseClient;
    let captured: string[];

    // Fixed values so every column can be matched by an exact list.
    const UIDS = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const SEEN = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-02-02T00:00:00.000Z'),
      new Date('2026-03-03T00:00:00.000Z'),
    ];

    const labelsOf = (rows: Array<{ label: string }>) => rows.map(r => r.label).sort();

    beforeAll(async () => {
      (EntityMetadataStore as any).metadata.clear();

      client = createFreshClient();
      captured = [];
      db = new AnyArrayTestDatabase(client, {
        logQueries: true,
        logParameters: false,
        logger: (msg: string) => captured.push(msg),
      });

      await client.query(`DROP TABLE IF EXISTS any_array_items CASCADE`);
      await client.query(`DROP TABLE IF EXISTS any_array_groups CASCADE`);
      await db.getSchemaManager().ensureCreated();

      await db.anyGroups.insert({ name: 'alpha' });
      await db.anyGroups.insert({ name: 'beta' });

      // 'aa' pads to 'aa      ' in char(8) — the value bpchar[] must preserve.
      await db.anyItems.insert({
        label: 'one', code: 'aa', sku: 'sku-one', uid: UIDS[0], amount: 10.5,
        serialNo: '9007199254740993', seenAt: SEEN[0], ratio: 1,
        startAt: { hour: 9, minute: 30 }, groupId: 1,
      });
      await db.anyItems.insert({
        label: 'two', code: 'bbbbbbbb', sku: 'sku-two', uid: UIDS[1], amount: 20.25,
        serialNo: '9007199254740994', seenAt: SEEN[1], ratio: 2,
        startAt: { hour: 17, minute: 0 }, groupId: 2,
      });
      await db.anyItems.insert({
        label: 'three', code: 'cc', sku: 'sku-three', uid: UIDS[2], amount: 30,
        serialNo: '9007199254740995', seenAt: SEEN[2], ratio: undefined,
        startAt: { hour: 0, minute: 5 }, groupId: 2,
      });
    });

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS any_array_items CASCADE`);
      await client.query(`DROP TABLE IF EXISTS any_array_groups CASCADE`);
      await db.dispose();
    });

    test('eqAny matches exactly the rows inArray matches', async () => {
      const viaAny = await db.anyItems.where(i => eqAny(i.ratio, [1, 2])).toList();
      const viaIn = await db.anyItems.where(i => inArray(i.ratio, [1, 2])).toList();

      expect(labelsOf(viaAny)).toEqual(['one', 'two']);
      expect(labelsOf(viaAny)).toEqual(labelsOf(viaIn));
    });

    test('neAll matches exactly the rows notInArray matches, NULLs excluded by both', async () => {
      const viaAll = await db.anyItems.where(i => neAll(i.ratio, [1])).toList();
      const viaNotIn = await db.anyItems.where(i => notInArray(i.ratio, [1])).toList();

      // 'three' has a NULL ratio: NULL <> ALL (…) is NULL, so it is filtered out.
      expect(labelsOf(viaAll)).toEqual(['two']);
      expect(labelsOf(viaAll)).toEqual(labelsOf(viaNotIn));
    });

    test('an empty list matches nothing for eqAny and everything for neAll', async () => {
      expect(await db.anyItems.where(i => eqAny(i.ratio, [])).toList()).toHaveLength(0);
      expect(labelsOf(await db.anyItems.where(i => neAll(i.ratio, [])).toList()))
        .toEqual(['one', 'three', 'two']);
    });

    test('a char(n) column matches its untruncated values', async () => {
      // With a `char[]` cast Postgres would compare against 'a'/'b' and match nothing.
      const rows = await db.anyItems.where(i => eqAny(i.code, ['aa', 'bbbbbbbb'])).toList();

      expect(labelsOf(rows)).toEqual(['one', 'two']);
    });

    test('every declared column type casts to an array type the server accepts', async () => {
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.id, [1, 3])).toList()))
        .toEqual(['one', 'three']);                                  // serial -> integer[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.sku, ['sku-two'])).toList()))
        .toEqual(['two']);                                           // text[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.label, ['one'])).toList()))
        .toEqual(['one']);                                           // varchar[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.uid, [UIDS[1], UIDS[2]])).toList()))
        .toEqual(['three', 'two']);                                  // uuid[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.amount, [20.25])).toList()))
        .toEqual(['two']);                                           // numeric[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.serialNo, ['9007199254740995'])).toList()))
        .toEqual(['three']);                                         // bigint[]
      expect(labelsOf(await db.anyItems.where(i => eqAny(i.seenAt, [SEEN[0]])).toList()))
        .toEqual(['one']);                                           // timestamptz[]
    });

    test('a custom-mapper column matches on the mapped driver values', async () => {
      const rows = await db.anyItems
        .where(i => eqAny(i.startAt, [{ hour: 9, minute: 30 }, { hour: 0, minute: 5 }]))
        .toList();

      expect(labelsOf(rows)).toEqual(['one', 'three']);
    });

    test('resolves a navigation-property field and joins its table', async () => {
      const rows = await db.anyItems.where(i => eqAny(i.group!.name, ['beta'])).toList();

      expect(labelsOf(rows)).toEqual(['three', 'two']);
    });

    test('the statement text is identical across list lengths, unlike inArray', async () => {
      const textsFor = async (
        run: (lengths: number) => Promise<unknown>
      ): Promise<string[]> => {
        const texts: string[] = [];
        for (const length of [1, 3, 200]) {
          captured.length = 0;
          await run(length);
          texts.push(captured.join('\n'));
        }
        return texts;
      };

      const ids = (length: number) => Array.from({ length }, (_, i) => i + 1);

      const anyTexts = await textsFor(n => db.anyItems.where(i => eqAny(i.id, ids(n))).toList());
      expect(anyTexts[0]).toContain('= ANY($1::integer[])');
      expect(new Set(anyTexts).size).toBe(1);

      const inTexts = await textsFor(n => db.anyItems.where(i => inArray(i.id, ids(n))).toList());
      expect(new Set(inTexts).size).toBe(3);
    });
  });
});
