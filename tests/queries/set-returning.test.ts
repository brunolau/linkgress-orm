import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  agg, and, caseWhen, castAsInt, coalesce, DatabaseClient, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq,
  exists, fromSet, gt, inSubquery, integer, isNotNull, jsonb, jsonbArrayElements, jsonbEachText, jsonbPathText,
  literal, ne, notExists, serial, SetQueryBuilder, SetReturningFunction, sql, SqlFragment, text, unnest, unnestZip, upper, varchar,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Set-returning functions: `unnest`, `unnestZip`, `jsonbArrayElements`, `jsonbEachText` — as a projection
 * value (multiplying rows), as a context-free subquery source (`fromSet`), as a query of their own
 * (`db.selectFromSet`) and joined to every row of an entity query (`crossJoinLateral`, grouped too).
 *
 * Fixture (ids 1-based, in this order):
 *
 * | box | name | labels | sizes | items | props | group |
 * |---|---|---|---|---|---|---|
 * | 1 | alpha | {red,007,blue} | {3,1} | [{kind bolt, qty 2},{kind nut, qty 5},{kind bolt, qty 1}] | {color: red, code: "0042"} | North |
 * | 2 | beta | {} | {2} | [] | {color: blue} | South |
 * | 3 | gamma | NULL | NULL | NULL | NULL | North |
 *
 * groups: North (code '01', aliases {n,north}), South (code '02', aliases NULL)
 */

class SrfGroup extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  code!: DbColumn<string>;
  aliases?: DbColumn<string[] | null>;
}

interface BoxItem {
  kind: string;
  qty: number;
}

class SrfBox extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  labels?: DbColumn<string[] | null>;
  sizes?: DbColumn<number[] | null>;
  items?: DbColumn<BoxItem[] | null>;
  props?: DbColumn<Record<string, string> | null>;
  groupId!: DbColumn<number>;
  group?: SrfGroup;
}

class SetReturningDatabase extends DbContext {
  get groups(): DbEntityTable<SrfGroup> {
    return this.table(SrfGroup);
  }

  get boxes(): DbEntityTable<SrfBox> {
    return this.table(SrfBox);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SrfGroup, entity => {
      entity.toTable('srf_groups');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 8)).isRequired();
      entity.property(e => e.aliases).hasType(text('aliases').array());
    });

    model.entity(SrfBox, entity => {
      entity.toTable('srf_boxes');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
      entity.property(e => e.labels).hasType(text('labels').array());
      entity.property(e => e.sizes).hasType(integer('sizes').array());
      entity.property(e => e.items).hasType(jsonb('items'));
      entity.property(e => e.props).hasType(jsonb('props'));
      entity.property(e => e.groupId).hasType(integer('group_id')).isRequired();

      entity.hasOne(e => e.group, () => SrfGroup)
        .withForeignKey(b => b.groupId)
        .withPrincipalKey(g => g.id)
        .isRequired();
    });
  }
}

function build(fragment: SqlFragment<any>, start: number = 1): { sql: string; params: any[] } {
  const context: SqlBuildContext = { paramCounter: start, params: [] };
  return { sql: fragment.buildSql(context), params: context.params };
}

/** The SQL of a subquery rendered in an enclosing statement that already bound `bound` parameters. */
function buildSubquery(subquery: { buildSql(context: SqlBuildContext): string }, bound: number = 0): { sql: string; params: any[] } {
  const context: SqlBuildContext = { paramCounter: bound + 1, params: Array.from({ length: bound }, (_, i) => `outer${i + 1}`) };
  return { sql: subquery.buildSql(context), params: context.params.slice(bound) };
}

describe('set-returning functions', () => {
  let client: DatabaseClient;
  let db: SetReturningDatabase;
  const captured: string[] = [];
  const lastSelect = (): string => [...captured].reverse().find(statement => statement.includes('SELECT'))!;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new SetReturningDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });

    await client.query('DROP TABLE IF EXISTS srf_boxes CASCADE');
    await client.query('DROP TABLE IF EXISTS srf_groups CASCADE');
    await db.getSchemaManager().ensureCreated();

    await db.groups.insertBulk([
      { name: 'North', code: '01', aliases: ['n', 'north'] },
      { name: 'South', code: '02', aliases: null },
    ]);
    await db.boxes.insertBulk([
      { name: 'alpha', labels: ['red', '007', 'blue'], sizes: [3, 1], items: null, props: { color: 'red', code: '0042' }, groupId: 1 },
      { name: 'beta', labels: [], sizes: [2], items: null, props: { color: 'blue' }, groupId: 2 },
      { name: 'gamma', labels: null, sizes: null, items: null, props: null, groupId: 1 },
    ]);
    // The jsonb ARRAYS are written as raw SQL with an explicit ::jsonb cast: a bound JS array or JSON text
    // encodes differently per driver (pg sends an array as a PostgreSQL array literal, postgres.js sends a
    // string as a JSON string), and this test is about the read path only
    await client.query(`UPDATE srf_boxes SET items = '[{"kind":"bolt","qty":2},{"kind":"nut","qty":5},{"kind":"bolt","qty":1}]'::jsonb WHERE name = 'alpha'`);
    await client.query(`UPDATE srf_boxes SET items = '[]'::jsonb WHERE name = 'beta'`);
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS srf_boxes CASCADE');
    await client.query('DROP TABLE IF EXISTS srf_groups CASCADE');
    await db.dispose();
  });

  describe('the functions', () => {
    test('unnest over a column; over a JS array (ONE typed array parameter); over NULL', () => {
      const column = { __fieldName: 'labels', __dbColumnName: 'labels', __tableAlias: 'srf_boxes', __sqlType: 'text[]' };
      const set = unnest(column as any);
      expect(set).toBeInstanceOf(SetReturningFunction);
      expect(set.columns).toEqual(['value']);
      expect(set.renderCall({ paramCounter: 1, params: [] })).toBe('unnest("srf_boxes"."labels")');

      const context: SqlBuildContext = { paramCounter: 3, params: [] };
      expect(unnest(['a', "it's", '0'], 'text').renderCall(context)).toBe('unnest(CAST($3 AS text[]))');
      expect(context.params).toEqual(['{"a","it\'s","0"}']);

      expect(unnest(null, 'integer').renderCall({ paramCounter: 1, params: [] })).toBe('unnest(CAST(NULL AS integer[]))');
      expect(() => unnest(['a'])).toThrow(/needs its element type/);
      expect(() => unnest('abc' as any)).toThrow(/expected an array/);
      expect(() => unnest(['a'], 'text); DROP TABLE x; --' as any)).toThrow(/Invalid PostgreSQL type name/);
    });

    test('unnestZip: one typed array parameter per column, zipped by position', () => {
      const set = unnestZip<{ id: number; code: string }>({
        id: { values: [1, 2, 3], type: 'integer' },
        code: { values: ['01', '7'], type: 'text' },
      });
      const context: SqlBuildContext = { paramCounter: 1, params: [] };

      expect(set.columns).toEqual(['id', 'code']);
      expect(set.renderSource('z', context)).toBe('unnest(CAST($1 AS integer[]), CAST($2 AS text[])) AS "z"("id", "code")');
      expect(context.params).toEqual(['{1,2,3}', '{"01","7"}']);
      expect(() => unnestZip({})).toThrow(/at least one column/);
      expect(() => unnestZip({ 'bad name': { values: [1], type: 'integer' } } as any)).toThrow(/not a plain identifier/);
    });

    test('jsonbArrayElements / jsonbEachText: the call, and a plain JS value bound as jsonb', () => {
      const props = { __fieldName: 'props', __dbColumnName: 'props', __tableAlias: 'srf_boxes' };
      expect(jsonbEachText(props as any).renderSource('kv', { paramCounter: 1, params: [] }))
        .toBe('jsonb_each_text("srf_boxes"."props") AS "kv"("key", "value")');

      const context: SqlBuildContext = { paramCounter: 1, params: [] };
      expect(jsonbArrayElements([{ a: 1 }]).renderCall(context)).toBe('jsonb_array_elements(CAST(CAST($1 AS text) AS jsonb))');
      expect(context.params).toEqual(['[{"a":1}]']);
    });

    test('refused anywhere but as a projection value or a source — also after .as() / .mapWith()', () => {
      const labels = { __fieldName: 'labels', __dbColumnName: 'labels', __tableAlias: 'srf_boxes' } as any;

      expect(() => build(eq(unnest(labels), 'red') as any)).toThrow(/unnest\(\) returns a set of rows/);
      expect(() => build(caseWhen(isNotNull(labels), unnest(labels)).else(literal('x')))).toThrow(/returns a set of rows/);
      expect(() => build(unnest(labels).as('tag'))).toThrow(/returns a set of rows/);
      expect(() => build(coalesce(unnest(labels).mapWith(String), 'none'))).toThrow(/returns a set of rows/);
      expect(unnest(labels).as('tag')).toBeInstanceOf(SetReturningFunction);
      expect(unnest(labels).mapWith(String)).toBeInstanceOf(SetReturningFunction);
    });

    test('withReadType() keeps the set a set (and .as() keeps the read type)', () => {
      const labels = { __fieldName: 'labels', __dbColumnName: 'labels', __tableAlias: 'srf_boxes' } as any;
      const typed = unnest<string>(labels).withReadType<string>('text');

      expect(typed).toBeInstanceOf(SetReturningFunction);
      expect(typed.getReadType()).toBe('text');
      expect(typed.getMapper()).toBeFalsy();
      expect(typed.as('tag').getReadType()).toBe('text');
      expect(typed.as('tag')).toBeInstanceOf(SetReturningFunction);
      expect(() => build(typed)).toThrow(/returns a set of rows/);
    });

    test('a JS object or array holding column refs is refused (it would bind the refs as a value)', () => {
      const name = { __fieldName: 'name', __dbColumnName: 'name', __tableAlias: 'srf_boxes' } as any;

      expect(() => jsonbArrayElements({ n: name } as any)).toThrow(/holding column refs/);
      expect(() => jsonbEachText([name] as any)).toThrow(/holding column refs/);
      expect(() => unnest([name], 'text')).toThrow(/holding column refs/);
      // plain values still bind
      expect(() => jsonbArrayElements([{ n: 'x' }])).not.toThrow();
    });
  });

  describe('as a projection value', () => {
    test('multiplies the rows; each value reads as the driver delivers it (a digits-only text stays text)', async () => {
      const rows = await db.boxes.select(b => ({ name: b.name, label: unnest(b.labels) })).toList();

      expect(lastSelect()).toContain('unnest("srf_boxes"."labels") as "label"');
      expect([...rows].sort((a, b) => a.label.localeCompare(b.label))).toEqual([
        { name: 'alpha', label: '007' },
        { name: 'alpha', label: 'blue' },
        { name: 'alpha', label: 'red' },
      ]);
    });

    test('an integer array\'s elements read as numbers; one value as the whole selection', async () => {
      const sizes = await db.boxes.select(b => unnest(b.sizes)).toList();
      expect([...sizes].sort()).toEqual([1, 2, 3]);
    });

    test('withReadType(): the projection value still multiplies the rows, each value read as the given type', async () => {
      const texts = await db.boxes
        .where(b => eq(b.name, 'alpha'))
        .select(() => ({ v: unnest(['a', '007'], 'text').withReadType<string>('text') }))
        .toList();
      expect(texts.map(row => row.v).sort()).toEqual(['007', 'a']);

      // numeric elements arrive as text: the read type makes them numbers
      const numbers = await db.boxes
        .where(b => eq(b.name, 'alpha'))
        .select(() => ({ v: unnest([1.5, 2], 'numeric').withReadType<number>('numeric') }))
        .toList();
      expect(numbers.map(row => row.v).sort()).toEqual([1.5, 2]);
    });

    test('count(), exists() and countOver() of a projection holding one are refused: they cannot see the rows it multiplies', async () => {
      const labelled = db.boxes.select(b => ({ name: b.name, label: unnest(b.labels) }));

      await expectToReject(() => labelled.count(), /count\(\): the projection holds a set-returning function/);
      await expectToReject(() => labelled.exists(), /exists\(\): the projection holds a set-returning function/);
      await expectToReject(() => labelled.countOver(), /countOver\(\): the projection holds a set-returning function/);
      await expectToReject(() => db.boxes.select(b => unnest(b.sizes)).count(), /set-returning function/);

      // crossJoinLateral counts the rows its set multiplies
      expect(await db.boxes.crossJoinLateral(b => unnest(b.labels), (_b, l) => ({ label: l.value }), 'l').count()).toBe(3);
    });

    test('in a WHERE, an ORDER BY, a GROUP BY key or an aggregate it is refused', async () => {
      await expectToReject(db.boxes.where(b => eq(unnest(b.labels) as any, 'red')).toList(), /returns a set of rows/);
      await expectToReject(db.boxes.orderBy(b => [[unnest(b.labels), 'ASC']] as any).toList(), /returns a set of rows/);
      await expectToReject(
        db.boxes.select(b => ({ id: b.id, labels: b.labels })).groupBy(b => ({ tag: unnest(b.labels) })).select(g => ({ tag: g.key.tag })).toList(),
        /returns a set of rows/
      );
      await expectToReject(
        db.boxes.select(b => ({ groupId: b.groupId, sizes: b.sizes })).groupBy(b => ({ groupId: b.groupId }))
          .select(g => ({ groupId: g.key.groupId, total: g.sum(b => unnest(b.sizes) as any) })).toList(),
        /returns a set of rows/
      );
    });

    test('a set of several columns is no projection value', async () => {
      await expectToReject(db.boxes.select(b => ({ kv: jsonbEachText(b.props) })).toList(), /returns 2 columns/);
    });
  });

  describe('fromSet(): a context-free subquery source', () => {
    test('renders FROM <call> AS "<alias>"(<columns>), the row as "<alias>"."<column>", in the enclosing parameter sequence', () => {
      const subquery = fromSet(unnest(['a', 'b'], 'text'), 'n')
        .where(n => ne(n.value, 'b'))
        .select(n => n.value)
        .asSubquery('scalar');

      expect(buildSubquery(subquery, 2)).toEqual({
        sql: 'SELECT "n"."value" as "value"\nFROM unnest(CAST($3 AS text[])) AS "n"("value")\nWHERE "n"."value" != $4',
        params: ['{"a","b"}', 'b'],
      });
    });

    test('the alias defaults to the function\'s name; ORDER BY / LIMIT / OFFSET', () => {
      const props = { __fieldName: 'props', __dbColumnName: 'props', __tableAlias: 'srf_boxes' } as any;
      const subquery = fromSet(jsonbEachText(props))
        .orderBy(kv => [[kv.key, 'DESC']])
        .limit(1)
        .offset(1)
        .select(kv => kv.value)
        .asSubquery('scalar');

      expect(buildSubquery(subquery).sql).toBe(
        'SELECT "jsonb_each_text"."value" as "value"\nFROM jsonb_each_text("srf_boxes"."props") AS "jsonb_each_text"("key", "value")\n'
        + 'ORDER BY "jsonb_each_text"."key" DESC\nLIMIT 1\nOFFSET 1'
      );
      expect(() => fromSet(unnest(['a'], 'text')).limit(-1)).toThrow(/non-negative integer/);
    });

    test('outer refs — in the function\'s argument and in the WHERE — are reported; the set\'s own columns are not', () => {
      const labels = { __fieldName: 'labels', __dbColumnName: 'labels', __tableAlias: 'srf_boxes' } as any;
      const name = { __fieldName: 'name', __dbColumnName: 'name', __tableAlias: 'srf_boxes' } as any;
      const subquery = fromSet(unnest(labels), 'l').where(l => ne(l.value, name)).select(() => ({ one: literal(1) })).asSubquery('table');

      expect(subquery.getOuterFieldRefs()).toEqual([labels, name]);
    });

    test('a correlation to a row under the set\'s own alias is refused', () => {
      const labels = { __fieldName: 'labels', __dbColumnName: 'labels', __tableAlias: 'l' } as any;
      const subquery = fromSet(unnest(labels), 'l').where(l => eq(l.value, labels)).asSubquery('table');

      expect(() => buildSubquery(subquery)).toThrow(/the alias "l" is both the set's alias/);
    });

    test('in exists() / notExists(), correlated to the enclosing row', async () => {
      const red = await db.boxes
        .where(b => exists(fromSet(unnest(b.labels), 'l').where(l => eq(l.value, 'red')).select(() => ({ one: literal(1) })).asSubquery()))
        .select(b => b.name)
        .toList();
      const unlabelled = await db.boxes
        .where(b => notExists(fromSet(unnest(b.labels), 'l').select(() => ({ one: literal(1) })).asSubquery()))
        .select(b => b.name)
        .toList();

      expect(red).toEqual(['alpha']);
      expect([...unlabelled].sort()).toEqual(['beta', 'gamma']);
    });

    test('in inSubquery() over a JS array, and as the first leg of a UNION', async () => {
      const named = await db.boxes
        .where(b => inSubquery(b.name, fromSet(unnest(['alpha', 'gamma'], 'text')).select(n => n.value).asSubquery('array')))
        .select(b => b.name)
        .toList();
      expect([...named].sort()).toEqual(['alpha', 'gamma']);

      const household = fromSet(unnest([1], 'integer'), 'self')
        .select(s => s.value)
        .union(db.boxes.where(b => eq(b.name, 'beta')).select(b => b.id))
        .asSubquery('array');
      const ids = await db.boxes.where(b => inSubquery(b.id, household as any)).select(b => b.id).toList();
      expect([...ids].sort()).toEqual([1, 2]);
    });

    test('projected scalar, correlated through a NAVIGATION of the enclosing row (joined there); under coalesce()', async () => {
      const rows = await db.boxes
        .select(b => ({
          name: b.name,
          firstAlias: fromSet(unnest(b.group!.aliases), 'a').orderBy(a => a.value).limit(1).select(a => a.value).asSubquery('scalar'),
          color: coalesce(
            fromSet(jsonbEachText(b.props), 'kv').where(kv => eq(kv.key, 'color')).select(kv => kv.value).asSubquery('scalar'),
            'none'
          ),
        }))
        .toList();

      expect(lastSelect()).toContain('JOIN "srf_groups" AS "group"');
      expect(new Map(rows.map(row => [row.name, row]))).toEqual(new Map([
        ['alpha', { name: 'alpha', firstAlias: 'n', color: 'red' }],
        ['beta', { name: 'beta', firstAlias: undefined, color: 'blue' }],
        ['gamma', { name: 'gamma', firstAlias: 'n', color: 'none' }],
      ]) as any);
    });

    test('a context-free set query does not run on its own', async () => {
      await expectToReject(fromSet(unnest(['a'], 'text')).toList(), /db\.selectFromSet/);
    });
  });

  describe('db.selectFromSet(): a query of its own', () => {
    test('unnestZip rows: NULL-padded, each column read as the driver delivers it', async () => {
      const rows = await db
        .selectFromSet(unnestZip<{ id: number; code: string | null }>({
          id: { values: [1, 2, 3], type: 'integer' },
          code: { values: ['01', '7'], type: 'text' },
        }), 'z')
        .orderBy(z => z.id)
        .toList();

      expect(lastSelect()).toContain('FROM unnest(CAST($1 AS integer[]), CAST($2 AS text[])) AS "z"("id", "code")');
      expect(rows).toEqual([
        { id: 1, code: '01' },
        { id: 2, code: '7' },
        { id: 3, code: null },
      ]);
    });

    test('a projection over the set, ORDER BY, firstOrDefault()', async () => {
      const names = db.selectFromSet(unnest(['b', 'a', '007'], 'text'), 'n')
        .select(n => ({ name: n.value, loud: upper(n.value) }))
        .orderBy(n => [[n.value, 'DESC']]);

      expect(await names.toList()).toEqual([
        { name: 'b', loud: 'B' },
        { name: 'a', loud: 'A' },
        { name: '007', loud: '007' },
      ]);
      expect(await names.firstOrDefault()).toEqual({ name: 'b', loud: 'B' });
      expect(await db.selectFromSet(unnest([] as string[], 'text')).firstOrDefault()).toBeNull();
    });

    test('an entity subquery nested in the projection reads the set\'s row as a correlation, also under an alias it has a navigation of', async () => {
      // `group` is also the name of the boxes' navigation: the nested count used to join a "group" of its
      // own, bind `s.id` to it and count every box
      const rows = await db
        .selectFromSet(unnestZip<{ id: number }>({ id: { values: [2], type: 'integer' } }), 'group')
        .select(s => ({ id: s.id, boxes: db.boxes.where(b => eq(b.groupId, s.id)).select(() => sql<number>`count(*)`.mapWith(Number)).asSubquery('scalar') }))
        .toList();

      expect(rows).toEqual([{ id: 2, boxes: 1 }]);
      expect(lastSelect()).not.toContain('JOIN "srf_groups" AS "group"');
    });

    test('an array aggregate renders the way the context\'s client reads arrays', () => {
      const jsonArrayClient = { supportsBinaryArrayResults: () => false } as unknown as DatabaseClient;
      const statement = SetQueryBuilder.create(unnest([3, 1], 'integer'), 'n', jsonArrayClient)
        .select(n => ({ all: agg.arrayAgg(n.value) }))
        .toSql();

      expect(statement).toContain('json_agg("n"."value")');
    });

    test('as the first leg of an executed UNION ALL / UNION, every row reads the way that leg reads its own', async () => {
      // digits-only text stays text on EVERY leg: the union reads its rows through the first leg's readers
      const legA = () => db.selectFromSet(unnest(['0042', '007'], 'text'), 'a').select(a => ({ v: a.value }));
      const legB = () => db.selectFromSet(unnest(['007', '9'], 'text'), 'b').select(b => ({ v: b.value }));

      const all = await legA().unionAll(legB()).toList();
      expect(all.map(r => r.v).sort()).toEqual(['0042', '007', '007', '9']);

      const distinct = await legA().union(legB()).toList();
      expect(distinct.map(r => r.v).sort()).toEqual(['0042', '007', '9']);

      // one value as the whole selection: the union's rows ARE the values, as the leg's own rows are
      const values = await db.selectFromSet(unnest(['0042'], 'text'), 'a').select(a => a.value)
        .unionAll(db.selectFromSet(unnest(['007'], 'text'), 'b').select(b => b.value)).toList();
      expect([...values].sort()).toEqual(['0042', '007']);
    });

    test('jsonb elements read as the parsed JSON; one value as the whole selection', async () => {
      const elements = await db.selectFromSet(jsonbArrayElements<{ a: number }>([{ a: 1 }, { a: 2 }])).select(e => e.value).toList();
      expect(elements).toEqual([{ a: 1 }, { a: 2 }]);

      const keys = await db.selectFromSet(jsonbEachText({ b: '2', a: null } as any), 'kv').toList();
      expect([...keys].sort((x, y) => x.key.localeCompare(y.key))).toEqual([
        { key: 'a', value: null },
        { key: 'b', value: '2' },
      ]);
    });
  });

  describe('crossJoinLateral()', () => {
    test('CROSS JOIN LATERAL after FROM and its navigation joins, before WHERE; rows multiply, an empty set drops its row', async () => {
      const rows = await db.boxes
        .where(b => isNotNull(b.items))
        .crossJoinLateral(b => jsonbArrayElements<BoxItem>(b.items), (b, item) => ({
          box: b.name,
          group: b.group!.name,
          kind: jsonbPathText(item.value, 'kind'),
          qty: castAsInt(jsonbPathText(item.value, 'qty')),
        }), 'item')
        .toList();

      const sql = lastSelect();
      expect(sql).toContain('\nINNER JOIN "srf_groups" AS "group" ON "srf_boxes"."group_id" = "group"."id"\nCROSS JOIN LATERAL jsonb_array_elements("srf_boxes"."items") AS "item"("value")\nWHERE');
      expect([...rows].sort((a, b) => a.qty - b.qty)).toEqual([
        { box: 'alpha', group: 'North', kind: 'bolt', qty: 1 },
        { box: 'alpha', group: 'North', kind: 'bolt', qty: 2 },
        { box: 'alpha', group: 'North', kind: 'nut', qty: 5 },
      ]);
    });

    test('the function\'s argument reads a navigation: it is joined; count() counts the multiplied rows', async () => {
      const query = db.boxes.crossJoinLateral(b => unnest(b.group!.aliases), (b, a) => ({ box: b.name, alias: a.value }), 'ga');

      const rows = await query.toList();
      expect([...rows].sort((a, b) => `${a.box}${a.alias}`.localeCompare(`${b.box}${b.alias}`))).toEqual([
        { box: 'alpha', alias: 'n' },
        { box: 'alpha', alias: 'north' },
        { box: 'gamma', alias: 'n' },
        { box: 'gamma', alias: 'north' },
      ]);
      expect(await query.count()).toBe(4);
    });

    test('grouped over it: an expression-keyed group wraps the joined rows', async () => {
      const rows = await db.boxes
        .crossJoinLateral(b => jsonbArrayElements<BoxItem>(b.items), (b, item) => ({
          groupId: b.groupId,
          kind: jsonbPathText(item.value, 'kind'),
          qty: castAsInt(jsonbPathText(item.value, 'qty')),
        }), 'item')
        .groupBy(r => ({ groupId: r.groupId, kind: r.kind }))
        .select(g => ({ groupId: g.key.groupId, kind: g.key.kind, total: castAsInt(g.sum(r => r.qty)), lines: g.count() }))
        .toList();

      const sql = lastSelect();
      expect(sql).toContain('FROM "srf_boxes"\nCROSS JOIN LATERAL jsonb_array_elements("srf_boxes"."items") AS "item"("value")');
      expect(sql).toContain('GROUP BY "groupId", "kind"');
      expect([...rows].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
        { groupId: 1, kind: 'bolt', total: 3, lines: 2 },
        { groupId: 1, kind: 'nut', total: 5, lines: 1 },
      ]);
    });

    test('a WHERE over a value of the set, after the join', async () => {
      const labels = await db.boxes
        .crossJoinLateral(b => unnest(b.labels), (b, l) => ({ box: b.name, label: l.value }), 'l')
        .where(r => ne(r.label, 'red'))
        .toList();

      expect([...labels].map(r => r.label).sort()).toEqual(['007', 'blue']);
    });

    test('the alias may not name the table, a navigation or another set; no UPDATE / DELETE through it', async () => {
      expect(() => db.boxes.crossJoinLateral(b => unnest(b.labels), (_b, l) => ({ v: l.value }), 'srf_boxes')).toThrow(/already names/);
      expect(() => db.boxes.crossJoinLateral(b => unnest(b.labels), (_b, l) => ({ v: l.value }), 'group')).toThrow(/already names/);
      expect(() => db.boxes.crossJoinLateral(b => b.labels as any, (_b, l: any) => ({ v: l.value }), 'l')).toThrow(/must return a set-returning function/);

      const query = db.boxes.where(b => gt(b.id, 0)).crossJoinLateral(b => unnest(b.labels), (b, l) => ({ id: b.id, v: l.value }), 'l');
      await expectToReject(Promise.resolve().then(() => (query as any).update({ name: 'x' })), /cannot update or delete/);
      await expectToReject(Promise.resolve().then(() => (query as any).delete()), /cannot update or delete/);
    });

    test('an entity subquery in the projection reads the lateral set\'s row as a correlation, also under an alias it has a navigation of', async () => {
      const rows = await db.groups
        .crossJoinLateral(() => unnestZip<{ id: number }>({ id: { values: [2], type: 'integer' } }), (g, s) => ({
          name: g.name,
          boxes: db.boxes.where(b => eq(b.groupId, s.id)).select(() => sql<number>`count(*)`.mapWith(Number)).asSubquery('scalar'),
        }), 'group')
        .toList();

      // The set's one row names South (2), which holds one box — for either group row
      expect(rows.map(row => row.boxes)).toEqual([1, 1]);
    });

    test('a join added after it whose ON reads the set is refused: the joins render before the lateral sets', async () => {
      const readsTheSet = db.boxes
        .crossJoinLateral(b => unnest(b.labels), (b, l) => ({ id: b.id, label: l.value }), 'l')
        .leftJoin(db.groups, (r, g) => eq(g.name, r.label), (r, g) => ({ id: r.id, label: r.label, group: g.name }));

      await expectToReject(() => readsTheSet.toList(), /the ON predicate of the join "srf_groups_0" reads the set "l"/);

      // A join that does not read the set keeps working
      const rows = await db.boxes
        .crossJoinLateral(b => unnest(b.labels), (b, l) => ({ groupId: b.groupId, label: l.value }), 'l')
        .innerJoin(db.groups, (r, g) => eq(g.id, r.groupId), (r, g) => ({ label: r.label, group: g.name }))
        .toList();
      expect(rows.map(row => `${row.group}:${row.label}`).sort()).toEqual(['North:007', 'North:blue', 'North:red']);
    });

    test('as a correlated subquery: the set\'s columns stay its own, the correlation is reported', async () => {
      const groupsWithRed = await db.groups
        .where(g => exists(db.boxes
          .where(b => and(eq(b.groupId, g.id), isNotNull(b.labels)))
          .crossJoinLateral(b => unnest(b.labels), (_b, l) => ({ label: l.value }), 'l')
          .where(r => eq(r.label, 'red'))
          .select(() => ({ one: literal(1) }))
          .asSubquery('table')))
        .select(g => g.name)
        .toList();

      expect(groupsWithRed).toEqual(['North']);
    });
  });
});
