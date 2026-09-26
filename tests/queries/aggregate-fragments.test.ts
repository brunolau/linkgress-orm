import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  agg, AggregateFragment, and, coalesce, DbCteBuilder, eq, flagHas, gt, isNotNull, jsonBuildArray, jsonbBuildObject, literal, lower,
  modulo, ne, or, sql,
} from '../../src';
import { DRIVER_VALUE_MAPPER } from '../../src/query/conditions';
import { projectedValueRoot } from '../../src/query/sql-functions';
import { pgIntDatetime } from '../../debug/types/int-datetime';
import { build, ClubFixture, createClubFixture, disposeClubFixture, JOINED, ref } from '../utils/club-fixture';
import { expectToReject } from '../utils/expect-rejects';
import { assertType } from '../utils/type-tester';

const points = ref('points', { sqlType: 'integer' });
const id = ref('id', { sqlType: 'integer' });
const active = ref('active', { sqlType: 'boolean' });
const flags = ref('flags', { sqlType: 'smallint' });

/** A grouping key used as a condition operand: the projection types it as its value. */
const keyRef = (key: unknown): any => key;

describe('agg — aggregate fragments', () => {
  describe('rendering', () => {
    test('count(*), count(v), count(DISTINCT v)', () => {
      expect(build(agg.count())).toEqual({ sql: 'count(*)', params: [] });
      expect(build(agg.count(points))).toEqual({ sql: 'count("fx_members"."points")', params: [] });
      expect(build(agg.countDistinct(points))).toEqual({ sql: 'count(DISTINCT "fx_members"."points")', params: [] });
    });

    test('sum / avg (optionally DISTINCT), min / max, bit_or / bit_and', () => {
      expect(build(agg.sum(points)).sql).toBe('sum("fx_members"."points")');
      expect(build(agg.sum(points, { distinct: true })).sql).toBe('sum(DISTINCT "fx_members"."points")');
      expect(build(agg.avg(points)).sql).toBe('avg("fx_members"."points")');
      expect(build(agg.avg(points, { distinct: true })).sql).toBe('avg(DISTINCT "fx_members"."points")');
      expect(build(agg.min(points)).sql).toBe('min("fx_members"."points")');
      expect(build(agg.max(lower(ref('name')))).sql).toBe('max(lower("fx_members"."name"))');
      expect(build(agg.bitOr(flags)).sql).toBe('bit_or("fx_members"."flags")');
      expect(build(agg.bitAnd(flags)).sql).toBe('bit_and("fx_members"."flags")');
    });

    test('array_agg / json_agg / jsonb_agg with DISTINCT and ORDER BY — the direction always rendered', () => {
      expect(build(agg.arrayAgg(points, { distinct: true, orderBy: [[points, 'DESC']] })).sql)
        .toBe('array_agg(DISTINCT "fx_members"."points" ORDER BY "fx_members"."points" DESC)');
      expect(build(agg.arrayAgg(points, { orderBy: id })).sql)
        .toBe('array_agg("fx_members"."points" ORDER BY "fx_members"."id" ASC)');
      expect(build(agg.jsonAgg(jsonBuildArray(id, ref('name')), { orderBy: [[points, 'ASC'], [id, 'DESC']] })).sql)
        .toBe('json_agg(json_build_array("fx_members"."id", "fx_members"."name") ORDER BY "fx_members"."points" ASC, "fx_members"."id" DESC)');
      expect(build(agg.jsonbAgg(id, { orderBy: [id, 'DESC'] })).sql)
        .toBe('jsonb_agg("fx_members"."id" ORDER BY "fx_members"."id" DESC)');
      expect(build(agg.jsonAgg(id)).sql).toBe('json_agg("fx_members"."id")');
    });

    test('filter() appends FILTER (WHERE <condition>), the condition bare', () => {
      expect(build(agg.count().filter(eq(active, literal(true))))).toEqual({ sql: 'count(*) FILTER (WHERE "fx_members"."active" = TRUE)', params: [] });
      expect(build(agg.countDistinct(id).filter(gt(points, 5)))).toEqual({ sql: 'count(DISTINCT "fx_members"."id") FILTER (WHERE "fx_members"."points" > $1)', params: [5] });
      // and / or keep their own parentheses; a fragment condition renders as itself
      expect(build(agg.count().filter(and(eq(active, literal(true)), gt(points, 5)))).sql)
        .toBe('count(*) FILTER (WHERE ("fx_members"."active" = TRUE AND "fx_members"."points" > $1))');
      expect(build(agg.count().filter(or(eq(active, literal(true)), gt(points, 5)))).sql)
        .toBe('count(*) FILTER (WHERE ("fx_members"."active" = TRUE OR "fx_members"."points" > $1))');
      expect(build(agg.count().filter(flagHas(flags, 4))).sql)
        .toBe('count(*) FILTER (WHERE (("fx_members"."flags" & $1::smallint) != 0))');
    });

    test('a second filter() is ANDed with the first', () => {
      expect(build(agg.count().filter(eq(active, literal(true))).filter(gt(points, 5))).sql)
        .toBe('count(*) FILTER (WHERE ("fx_members"."active" = TRUE AND "fx_members"."points" > $1))');
    });

    test('parameters in textual order: argument, ORDER BY keys, FILTER', () => {
      const fragment = agg.arrayAgg(sql<number>`${points} + ${1}`, { orderBy: [[sql`${id} * ${2}`, 'DESC']] }).filter(gt(points, 3));
      expect(build(fragment, { paramCounter: 4 })).toEqual({
        sql: 'array_agg("fx_members"."points" + $4 ORDER BY "fx_members"."id" * $5 DESC) FILTER (WHERE "fx_members"."points" > $6)',
        params: [1, 2, 3],
      });
    });

    test('plain operands bind typed; a null operand renders NULL', () => {
      expect(build(agg.sum(5))).toEqual({ sql: 'sum(CAST($1 AS integer))', params: [5] });
      expect(build(agg.count(null))).toEqual({ sql: 'count(NULL)', params: [] });
    });

    test('immutable: filter() returns a new fragment', () => {
      const base = agg.count();
      const filtered = base.filter(eq(active, literal(true)));

      expect(filtered).not.toBe(base);
      expect(filtered).toBeInstanceOf(AggregateFragment);
      expect(build(base).sql).toBe('count(*)');
    });

    test('array_agg renders json_agg only as the decoded root it is marked as — through .as() / .mapWith() / .withReadType()', () => {
      const root = agg.arrayAgg(points, { distinct: true, orderBy: [[points, 'DESC']] });

      expect(build(root, { jsonArrayRoot: projectedValueRoot(root) }).sql)
        .toBe('json_agg(DISTINCT "fx_members"."points" ORDER BY "fx_members"."points" DESC)');

      const filtered = agg.arrayAgg(points).filter(isNotNull(points));
      for (const wrapper of [filtered.as('p'), filtered.mapWith((v: unknown) => v), filtered.withReadType('integer[]'), filtered.as('p').mapWith((v: unknown) => v)]) {
        expect(projectedValueRoot(wrapper)).toBe(filtered);
        expect(build(wrapper, { jsonArrayRoot: projectedValueRoot(wrapper) }).sql)
          .toBe('json_agg("fx_members"."points") FILTER (WHERE "fx_members"."points" IS NOT NULL)');
      }

      const jsonb = agg.jsonbAgg(points);
      expect(build(jsonb, { jsonArrayRoot: jsonb }).sql).toBe('jsonb_agg("fx_members"."points")');
    });

    test('array_agg stays array_agg wherever SQL consumes the list: the flag alone, an operand, an argument', () => {
      const flagOn = { useJsonArrayAggregation: true };

      expect(build(agg.arrayAgg(id), flagOn).sql).toBe('array_agg("fx_members"."id")');

      // The root of an expression is the expression — the aggregate inside it is consumed by SQL
      for (const [value, expected] of [
        [sql<number>`cardinality(${agg.arrayAgg(id)})`, 'cardinality(array_agg("fx_members"."id"))'],
        [coalesce(agg.arrayAgg(id), literal('{}', 'integer[]')), 'COALESCE(array_agg("fx_members"."id"), CAST(\'{}\' AS integer[]))'],
        [sql<boolean>`${literal(1)} = ANY(${agg.arrayAgg(id)})`, '1 = ANY(array_agg("fx_members"."id"))'],
      ] as const) {
        expect(build(value, { ...flagOn, jsonArrayRoot: projectedValueRoot(value) }).sql).toBe(expected);
      }
    });

    test('the decoded root of an int8 / numeric / money list delivers each element as its text, in the native order', () => {
      const big = ref('big', { sqlType: 'bigint' });
      const bigList = agg.arrayAgg(big, { distinct: true, orderBy: [[big, 'DESC']] }).filter(isNotNull(big));

      expect(build(bigList, { jsonArrayRoot: bigList }).sql).toBe(
        'to_json(CAST(array_agg(DISTINCT "fx_members"."big" ORDER BY "fx_members"."big" DESC) FILTER (WHERE "fx_members"."big" IS NOT NULL) AS text[]))'
      );

      for (const sqlType of ['numeric', 'numeric(10, 2)', 'decimal', 'int8', 'money']) {
        const list = agg.arrayAgg(ref('v', { sqlType }));
        expect(build(list, { jsonArrayRoot: list }).sql).toBe('to_json(CAST(array_agg("fx_members"."v") AS text[]))');
      }

      // Any other element type keeps json_agg; off the root nothing changes
      const ints = agg.arrayAgg(points);
      expect(build(ints, { jsonArrayRoot: ints }).sql).toBe('json_agg("fx_members"."points")');
      expect(build(bigList).sql).toBe('array_agg(DISTINCT "fx_members"."big" ORDER BY "fx_members"."big" DESC) FILTER (WHERE "fx_members"."big" IS NOT NULL)');
    });

    test('a chained filter() keeps the grouping of a raw OR fragment', () => {
      const nullOrTwenty = sql<boolean>`${points} = 20 OR ${points} IS NULL`;

      expect(build(agg.count().filter(nullOrTwenty).filter(sql<boolean>`${active}`)).sql)
        .toBe('count(*) FILTER (WHERE (("fx_members"."points" = 20 OR "fx_members"."points" IS NULL) AND ("fx_members"."active")))');
      // A helper condition renders as it always did
      expect(build(agg.count().filter(eq(active, literal(true))).filter(gt(points, 5))).sql)
        .toBe('count(*) FILTER (WHERE ("fx_members"."active" = TRUE AND "fx_members"."points" > $1))');
    });

    test('DISTINCT with an ORDER BY key that binds a parameter is refused up front', () => {
      const name = ref('name');
      const bound = sql<string>`${name} || ${'!'}`;

      expect(() => agg.arrayAgg(bound, { distinct: true, orderBy: [[bound, 'DESC']] })).toThrow(/literal\(\)/);
      expect(() => agg.jsonAgg(name, { distinct: true, orderBy: [[sql`${name} || ${'!'}`, 'ASC']] })).toThrow(/literal\(\)/);

      // Inline constants render the same text twice; without DISTINCT a bound key is fine
      const inline = sql<string>`${name} || ${literal('!')}`;
      expect(build(agg.arrayAgg(inline, { distinct: true, orderBy: [[inline, 'DESC']] })).sql)
        .toBe('array_agg(DISTINCT "fx_members"."name" || \'!\' ORDER BY "fx_members"."name" || \'!\' DESC)');
      expect(build(agg.arrayAgg(bound, { orderBy: [[bound, 'DESC']] })).params).toEqual(['!', '!']);
    });

    test('min / max read an unmapped numeric or int8 operand as a JS number, like g.min() / g.max()', () => {
      expect(agg.max(ref('score', { sqlType: 'numeric' })).getMapper().fromDriver('3.00')).toBe(3);
      expect(agg.min(ref('big', { sqlType: 'bigint' })).getMapper().fromDriver('5')).toBe(5);
      expect(agg.max(ref('score', { sqlType: 'numeric' })).getMapper().fromDriver(null)).toBeNull();
      // text, a money amount, an expression of unknown type: as delivered
      expect(agg.max(ref('nickname', { sqlType: 'text' })).getMapper().fromDriver('007')).toBe('007');
      expect(agg.max(ref('amount', { sqlType: 'money' })).getMapper().fromDriver('$1.50')).toBe('$1.50');
      expect(agg.max(lower(ref('name'))).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    });

    test('reports the refs of the argument, the ORDER BY keys and the FILTER', () => {
      const city = ref('city', { alias: 'club' });
      const name = ref('name');
      expect(agg.arrayAgg(name, { orderBy: city }).filter(eq(points, 1)).getFieldRefs()).toEqual([name, city, points]);
    });

    test('refusals', () => {
      expect(() => agg.arrayAgg(points, { orderBy: [['x', 'ASC']] })).toThrow(/ORDER BY key/);
      expect(() => agg.jsonAgg(points, { orderBy: 3 as any })).toThrow(/ORDER BY key/);
      expect(() => agg.arrayAgg(points, { orderBy: [points, 'UP'] as any })).toThrow(/ORDER BY key/);
      expect(() => agg.max(undefined as any)).toThrow(/agg\.max\(\)/);
      expect(() => agg.count().filter(true as any)).toThrow(/filter\(\) expects a condition/);
      // A subquery is a value, not a condition
      expect(() => agg.count().filter({ buildSql: () => 'x', getOuterFieldRefs: () => [] } as any)).toThrow(/filter\(\) expects a condition/);
    });
  });

  describe('reads', () => {
    test('count / countDistinct / sum / avg / bitOr / bitAnd read numbers, NULL stays null', () => {
      for (const fragment of [agg.count(), agg.countDistinct(id), agg.sum(points), agg.avg(points), agg.bitOr(flags), agg.bitAnd(flags)]) {
        expect(fragment.getMapper().fromDriver('42')).toBe(42);
        expect(fragment.getMapper().fromDriver(null)).toBeNull();
        expect(fragment.getMapper().toDriver).toBeUndefined();
      }
    });

    test('min / max read through the operand mapper, else the driver value', () => {
      const joinedAt = ref('joined_at', { sqlType: 'integer', mapper: pgIntDatetime });
      expect(agg.max(joinedAt).getMapper().fromDriver(0)).toEqual(new Date('2025-01-01T00:00:00.000Z'));
      expect(agg.min(ref('nickname')).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    });

    test('arrayAgg maps each element through the operand mapper; a NULL aggregate stays null', () => {
      const joinedAt = ref('joined_at', { sqlType: 'integer', mapper: pgIntDatetime });
      const mapper = agg.arrayAgg(joinedAt).getMapper();

      expect(mapper.fromDriver([0, null])).toEqual([new Date('2025-01-01T00:00:00.000Z'), null]);
      expect(mapper.fromDriver(null)).toBeNull();
      expect(agg.arrayAgg(ref('nickname')).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    });

    test('jsonAgg / jsonbAgg read the driver-parsed JSON', () => {
      expect(agg.jsonAgg(id).getMapper()).toBe(DRIVER_VALUE_MAPPER);
      expect(agg.jsonbAgg(id).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    });
  });

  describe('against the database', () => {
    let fixture: ClubFixture;

    beforeAll(async () => {
      fixture = await createClubFixture();
    });

    afterAll(async () => {
      await disposeClubFixture(fixture);
    });

    const arrayAggSpelling = () => (fixture.client.supportsBinaryArrayResults() ? 'array_agg(' : 'json_agg(');

    test('a select of aggregates is a whole-set aggregate: one row', async () => {
      const rows = await fixture.db.members
        .select(m => ({
          n: agg.count(),
          withPoints: agg.count(m.points),
          withNickname: agg.count(m.nickname),
          distinctPoints: agg.countDistinct(m.points),
          active: agg.count().filter(eq(m.active, literal(true))),
          activeClubs: agg.countDistinct(m.clubId).filter(eq(m.active, literal(true))),
          total: agg.sum(m.points),
          distinctTotal: agg.sum(m.points, { distinct: true }),
          avgScore: agg.avg(m.score),
          lastJoined: agg.max(m.joinedAt),
          firstName: agg.min(m.name),
          minNick: agg.min(m.nickname),
          anyFlag: agg.bitOr(m.flags),
          everyFlag: agg.bitAnd(m.flags),
        }))
        .toList();

      expect(rows).toEqual([{
        n: 4,
        withPoints: 3,
        withNickname: 3,
        distinctPoints: 2,
        active: 3,
        activeClubs: 2,
        total: 40,
        distinctTotal: 30,
        avgScore: 2.25,
        lastJoined: JOINED.dee,
        firstName: 'ann',
        minNick: '007',
        anyFlag: 7,
        everyFlag: 0,
      }]);
      expect(fixture.lastStatement()).not.toContain('GROUP BY');

      // Typed as they read
      const [first] = rows;
      assertType<number, typeof first.n>(first.n);
      assertType<number | null, typeof first.total>(first.total);
      assertType<Date | null | undefined, typeof first.lastJoined>(first.lastJoined);
      assertType<string | null, typeof first.firstName>(first.firstName);
    });

    test('over zero rows: COUNT 0, the others NULL (array_agg / json_agg NULL, not [])', async () => {
      const row = await fixture.db.members
        .where(m => eq(m.id, -1))
        .select(m => ({
          n: agg.count(),
          total: agg.sum(m.points),
          last: agg.max(m.joinedAt),
          flags: agg.bitOr(m.flags),
          ids: agg.arrayAgg(m.id),
          items: agg.jsonAgg(m.id),
          docs: agg.jsonbAgg(m.id),
          listed: coalesce(agg.jsonAgg(m.id), literal('[]', 'json')),
        }))
        .firstOrDefault();

      expect(row).toEqual({ n: 0, total: null, last: null, flags: null, ids: null, items: null, docs: null, listed: [] });
    });

    test('arrayAgg: DISTINCT + ORDER BY + FILTER, elements through the column mapper', async () => {
      const row = await fixture.db.members
        .select(m => ({
          points: agg.arrayAgg(m.points, { distinct: true, orderBy: [[m.points, 'DESC']] }).filter(isNotNull(m.points)),
          joined: agg.arrayAgg(m.joinedAt, { orderBy: m.joinedAt }).filter(isNotNull(m.joinedAt)),
          names: agg.arrayAgg(m.name, { orderBy: [[m.name, 'ASC']] }),
          nicknames: agg.arrayAgg(m.nickname, { orderBy: m.id }).filter(isNotNull(m.nickname)),
          allPoints: agg.arrayAgg(m.points, { orderBy: m.id }).filter(isNotNull(m.points)),
        }))
        .firstOrDefault();

      expect(row).toEqual({
        points: [20, 10],
        joined: [JOINED.bob, JOINED.ann, JOINED.dee],
        names: ['ann', 'bob', 'cyd', 'dee'],
        nicknames: ['A', 'C', '007'],
        allPoints: [10, 20, 10],
      });
      const { points: pointList, joined } = row!;
      assertType<Array<number | null | undefined> | null, typeof pointList>(pointList);
      assertType<Array<Date | null | undefined> | null, typeof joined>(joined);
      expect(fixture.lastStatement()).toContain(arrayAggSpelling());
    });

    // postgres.js decodes a NULL element of a NATIVE array wrongly — the string 'NULL' in a text[],
    // NaN in an int4[] — a driver defect every native-array read on it shares (json_agg is unaffected)
    test.skipIf(process.env.LINKGRESS_TEST_DRIVER === 'postgres')('arrayAgg: a NULL element reads null', async () => {
      const row = await fixture.db.members
        .select(m => ({
          points: agg.arrayAgg(m.points, { orderBy: m.id }),
          nicknames: agg.arrayAgg(m.nickname, { orderBy: m.id }),
        }))
        .firstOrDefault();

      expect(row).toEqual({ points: [10, 20, 10, null], nicknames: ['A', null, 'C', '007'] });
    });

    test('jsonAgg / jsonbAgg keep their ORDER BY and read the driver-parsed JSON', async () => {
      const row = await fixture.db.members
        .select(m => ({
          tuples: agg.jsonAgg(jsonBuildArray(m.id, m.name), { orderBy: [[m.id, 'DESC']] }),
          docs: agg.jsonbAgg(jsonbBuildObject({ id: m.id, nick: m.nickname }), { orderBy: m.id }).filter(eq(m.clubId, 1)),
          // no per-element mapping: a mapped column stays its stored value, a timestamp PostgreSQL's JSON text
          joined: agg.jsonAgg(m.joinedAt).filter(eq(m.id, 1)),
          stamps: agg.jsonbAgg(literal('2024-03-10 23:30:00', 'timestamp')).filter(eq(m.id, 1)),
        }))
        .firstOrDefault();

      const { joined, ...rest } = row!;

      expect(rest).toEqual({
        tuples: [[4, 'dee'], [3, 'cyd'], [2, 'bob'], [1, 'ann']],
        docs: [{ id: 1, nick: 'A' }, { id: 2, nick: null }, { id: 3, nick: 'C' }],
        stamps: ['2024-03-10T23:30:00'],
      });
      // The element type follows the operand (Date here), but the JSON carries the STORED value: seconds
      expect(joined as unknown).toEqual([(JOINED.ann.getTime() - Date.UTC(2025, 0, 1)) / 1000]);
    });

    test('an aggregate over a navigation joins it', async () => {
      const row = await fixture.db.members
        .select(m => ({ cities: agg.arrayAgg(m.club!.city, { distinct: true, orderBy: m.club!.city }) }))
        .firstOrDefault();

      expect(row).toEqual({ cities: ['Lima', 'Oslo'] });
      expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);
    });

    test('inside asSubquery(\'scalar\'): a correlated aggregate subquery per row', async () => {
      const db = fixture.db;
      const rows = await db.clubs
        .select(c => ({
          id: c.id,
          members: db.members.where(m => eq(m.clubId, c.id)).select(() => agg.count()).asSubquery('scalar'),
          active: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.count().filter(eq(m.active, literal(true)))).asSubquery('scalar'),
          points: db.members.where(m => eq(m.clubId, c.id)).select(m => coalesce(agg.jsonAgg(m.points, { orderBy: m.id }), literal('[]', 'json'))).asSubquery('scalar'),
          typed: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.max(m.nickname)).asSubquery('scalar').asExpression<string>().withReadType('text'),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, members: 3, active: 2, points: [10, 20, 10], typed: 'C' },
        { id: 2, members: 1, active: 1, points: [null], typed: '007' },
        { id: 3, members: 0, active: 0, points: [], typed: undefined },
      ] as any);
    });

    test('arrayAgg in a scalar subquery follows the driver array capability', async () => {
      const db = fixture.db;
      const row = await db.clubs
        .where(c => eq(c.id, 1))
        .select(c => ({
          ids: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.arrayAgg(m.id, { orderBy: [[m.id, 'DESC']] })).asSubquery('scalar'),
        }))
        .firstOrDefault();

      expect(row).toEqual({ ids: [3, 2, 1] });
      expect(fixture.lastStatement()).toContain(arrayAggSpelling());
    });

    test('arrayAgg in a CTE-rooted select — standalone and as a projected subquery — follows the driver array capability', async () => {
      const db = fixture.db;
      const members = new DbCteBuilder().with('agg_member_ids', db.members.select(m => ({ memberId: m.id })));

      const standalone = await db.selectFromCte(members.cte)
        .select(r => ({ ids: agg.arrayAgg(r.memberId, { orderBy: [[r.memberId, 'DESC']] }) }))
        .first();
      expect(standalone).toEqual({ ids: [4, 3, 2, 1] });
      expect(fixture.lastStatement()).toContain(arrayAggSpelling());

      const nested = await db.clubs
        .where(c => eq(c.id, 1))
        .select(() => ({ ids: db.selectFromCte(members.cte).select(r => ({ ids: agg.arrayAgg(r.memberId, { orderBy: r.memberId }) })).asSubquery('scalar') }))
        .firstOrDefault();
      expect(nested).toEqual({ ids: [1, 2, 3, 4] } as any);
      expect(fixture.lastStatement()).toContain(arrayAggSpelling());
    });

    test('grouped by columns: aggregates render in the grouped select and HAVING', async () => {
      const rows = await fixture.db.members
        .select(m => ({ clubId: m.clubId, points: m.points }))
        .groupBy(r => ({ clubId: r.clubId }))
        .having(g => gt(agg.count(), 0))
        .select(g => ({
          clubId: g.key.clubId,
          n: agg.count(),
          // At runtime a grouping key is its column ref (typed as its value for the projection)
          laterClubs: agg.count().filter(gt(keyRef(g.key.clubId), 1)),
          keys: agg.arrayAgg(g.key.clubId),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.clubId - b.clubId)).toEqual([
        { clubId: 1, n: 3, laterClubs: 0, keys: [1, 1, 1] },
        { clubId: 2, n: 1, laterClubs: 1, keys: [2] },
      ]);
      const statement = fixture.lastStatement();
      expect(statement).toContain('GROUP BY "fx_members"."club_id"');
      expect(statement).toMatch(/HAVING count\(\*\) > \$2/);
      expect(statement).toContain(arrayAggSpelling());
    });

    test('grouped by an expression (subquery-wrapped form): aggregates read the grouped subquery', async () => {
      const rows = await fixture.db.members
        .select(m => ({ clubId: m.clubId }))
        .groupBy(r => ({ parity: modulo(r.clubId, literal(2)) }))
        .select(g => ({
          parity: g.key.parity,
          n: agg.count(),
          odd: agg.count().filter(eq(keyRef(g.key.parity), literal(1))),
          parities: agg.arrayAgg(g.key.parity),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.parity - b.parity)).toEqual([
        { parity: 0, n: 1, odd: 0, parities: [0] },
        { parity: 1, n: 3, odd: 3, parities: [1, 1, 1] },
      ]);
      const statement = fixture.lastStatement();
      expect(statement).toContain('FROM (SELECT');
      // The key reads the grouped subquery's column, qualified
      expect(statement).toContain('count(*) FILTER (WHERE "q1"."parity" = 1)');
    });

    test('an aggregate projected through asSubquery(\'scalar\') reads like the aggregate itself', async () => {
      const db = fixture.db;
      const rows = await db.clubs
        .where(c => ne(c.id, 1))
        .select(c => ({
          id: c.id,
          nick: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.max(m.nickname)).asSubquery('scalar'),
          joined: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.max(m.joinedAt)).asSubquery('scalar'),
          score: db.members.where(m => eq(m.clubId, c.id)).select(m => ({ total: agg.sum(m.score) })).asSubquery('scalar'),
          typed: db.members.where(m => eq(m.clubId, c.id)).select(m => sql<string | null>`max(${m.nickname})`.withReadType('text')).asSubquery('scalar'),
          // Any other scalar subquery reads as before: the generic conversion
          raw: db.members.where(m => eq(m.clubId, c.id)).select(m => m.nickname).asSubquery('scalar'),
        }))
        .toList();

      // (a one-key object selection is typed as the object; the value is its one column)
      const total = (value: number | null) => value as unknown as { total: number | null };

      expect([...rows].sort((a, b) => a.id - b.id)).toEqual([
        { id: 2, nick: '007', joined: JOINED.dee, score: total(3), typed: '007', raw: 7 as unknown as string },
        { id: 3, nick: null, joined: null, score: total(null), typed: undefined as unknown as string, raw: undefined as unknown as string },
      ]);
    });

    test('min / max of an unmapped numeric or int8 column read as JS numbers', async () => {
      const row = await fixture.db.members
        .select(m => ({ maxScore: agg.max(m.score), minScore: agg.min(m.score), minBig: agg.min(m.big), maxPoints: agg.max(m.points) }))
        .firstOrDefault();

      expect(row).toEqual({ maxScore: 3, minScore: 1.5, minBig: 5 as unknown as string, maxPoints: 20 });
    });

    test('filter() takes a collection exists() snapshot, and chains after it', async () => {
      const row = await fixture.db.clubs
        .select(c => ({
          withMembers: agg.count().filter(c.members!.exists()),
          northWithMembers: agg.count().filter(c.members!.exists()).filter(eq(c.city, 'Oslo')),
        }))
        .firstOrDefault();

      expect(row).toEqual({ withMembers: 2, northWithMembers: 1 });
    });

    test('a chained filter() keeps the grouping of a raw OR fragment', async () => {
      const row = await fixture.db.members
        .select(m => ({ n: agg.count().filter(sql<boolean>`${m.points} = 20 OR ${m.points} IS NULL`).filter(sql<boolean>`${m.active}`) }))
        .firstOrDefault();

      // dee (points NULL, active) only — bob (points 20) is not active
      expect(row).toEqual({ n: 1 });
    });

    test('count() of a whole-set aggregate select is refused: that select is always one row', async () => {
      await expectToReject(fixture.db.members.select(() => ({ n: agg.count() })).count(), /one row/i);
      await expectToReject(fixture.db.members.select(m => sql<number>`${agg.sum(m.points)} + 1`).count(), /one row/i);
      // A select without aggregates counts its rows as before
      expect(await fixture.db.members.select(m => ({ id: m.id })).count()).toBe(4);
    });

    test('count() / exists() evaluate the projection once, for the guards only: a selector that cannot run on the mock row counts as before', async () => {
      // Before 1.0.9 count() / exists() never evaluated the projection. A selector that cannot run on the
      // mock row (a column ref has no toFixed) runs fine on real rows — its guards cannot apply to it
      const formatted = () => fixture.db.members.select((m: any) => ({ label: m.points.toFixed(1) }));
      expect(await formatted().count()).toBe(4);
      expect(await formatted().exists()).toBe(true);

      let evaluations = 0;
      const counted = fixture.db.members.select(m => {
        evaluations++;
        return { id: m.id };
      });
      const before = evaluations;
      expect(await counted.count()).toBe(4);
      expect(evaluations - before).toBe(1);
    });

    describe('on a driver without native array results: json_agg only where the driver reads the list', () => {
      /** Runs `run` with the client reporting no native array results — what Bun's binary protocol reports. */
      const withoutNativeArrays = async (run: () => Promise<void>): Promise<void> => {
        const client = fixture.client as any;
        const own = Object.prototype.hasOwnProperty.call(client, 'supportsBinaryArrayResults');
        const previous = client.supportsBinaryArrayResults;
        client.supportsBinaryArrayResults = () => false;

        try {
          await run();
        } finally {
          if (own) {
            client.supportsBinaryArrayResults = previous;
          } else {
            delete client.supportsBinaryArrayResults;
          }
        }
      };
      const count = (text: string, part: string): number => text.split(part).length - 1;

      test('the projected list itself — bare, through .as(), in a nested object, a scalar subquery — is json_agg', () => withoutNativeArrays(async () => {
        const db = fixture.db;
        const row = await db.members
          .select(m => ({
            ids: agg.arrayAgg(m.id, { orderBy: m.id }),
            aliased: agg.arrayAgg(m.id, { orderBy: [[m.id, 'DESC']] }).as('aliased'),
            nested: { clubs: agg.arrayAgg(m.clubId, { orderBy: m.id }) },
          }))
          .firstOrDefault();

        expect(row).toEqual({ ids: [1, 2, 3, 4], aliased: [4, 3, 2, 1], nested: { clubs: [1, 1, 1, 2] } });
        expect(count(fixture.lastStatement(), 'json_agg(')).toBe(3);
        expect(fixture.lastStatement()).not.toContain('array_agg(');

        const club = await db.clubs
          .where(c => eq(c.id, 1))
          .select(c => ({
            ids: db.members.where(m => eq(m.clubId, c.id)).select(m => agg.arrayAgg(m.id, { orderBy: m.id })).asSubquery('scalar'),
            // A scalar subquery SQL consumes keeps array_agg
            n: sql<number>`cardinality(${db.members.where(m => eq(m.clubId, c.id)).select(m => agg.arrayAgg(m.id)).asSubquery('scalar')})`,
          }))
          .firstOrDefault();

        expect(club).toEqual({ ids: [1, 2, 3], n: 3 });
        expect(count(fixture.lastStatement(), 'json_agg(')).toBe(1);
        expect(fixture.lastStatement()).toContain('cardinality((SELECT array_agg(');
      }));

      test('an argument of a function, a COALESCE operand and a WHERE subquery keep array_agg', () => withoutNativeArrays(async () => {
        const db = fixture.db;

        const cardinality = await db.members.select(m => ({ n: sql<number>`cardinality(${agg.arrayAgg(m.id)})` })).firstOrDefault();
        expect(cardinality).toEqual({ n: 4 });
        expect(fixture.lastStatement()).toContain('cardinality(array_agg("fx_members"."id"))');

        const empty = await db.members
          .where(m => eq(m.id, -1))
          .select(m => ({ ids: coalesce(agg.arrayAgg(m.id), literal('{}', 'integer[]')) }))
          .firstOrDefault();
        expect(empty).toEqual({ ids: [] });
        expect(fixture.lastStatement()).toContain('COALESCE(array_agg(');

        const clubs = await db.clubs
          .where(c => sql<boolean>`${c.id} = ANY(CAST(${db.members.select(m => agg.arrayAgg(m.clubId)).asSubquery('scalar')} AS integer[]))`)
          .select(c => ({ id: c.id }))
          .toList();
        expect(clubs.map(c => c.id).sort()).toEqual([1, 2]);
        expect(fixture.lastStatement()).not.toContain('json_agg(');
      }));

      test('a HAVING keeps array_agg; the grouped select reads json_agg', () => withoutNativeArrays(async () => {
        const rows = await fixture.db.members
          .select(m => ({ clubId: m.clubId }))
          .groupBy(r => ({ clubId: r.clubId }))
          .having(g => sql<boolean>`${literal(1)} = ANY(${agg.arrayAgg(keyRef(g.key.clubId))})`)
          .select(g => ({ clubId: g.key.clubId, n: agg.count(), keys: agg.arrayAgg(g.key.clubId) }))
          .toList();

        expect(rows).toEqual([{ clubId: 1, n: 3, keys: [1, 1, 1] }]);
        const statement = fixture.lastStatement();
        expect(statement).toContain('HAVING 1 = ANY(array_agg("fx_members"."club_id"))');
        expect(count(statement, 'json_agg(')).toBe(1);
      }));

      test('UNION legs keep array_agg (their rows are compared); UNION ALL legs read json_agg', () => withoutNativeArrays(async () => {
        const leg = (memberId: number) => fixture.db.members.where(m => eq(m.id, memberId)).select(m => ({ ids: agg.arrayAgg(m.id) }));

        const distinct = await leg(1).union(leg(2)).toList();
        expect(distinct.map(r => r.ids).sort()).toEqual([[1], [2]]);
        expect(fixture.lastStatement()).not.toContain('json_agg(');

        const all = await leg(1).unionAll(leg(1)).toList();
        expect(all).toEqual([{ ids: [1] }, { ids: [1] }]);
        expect(count(fixture.lastStatement(), 'json_agg(')).toBe(2);
      }));

      test('a CTE body and a joined table subquery keep array_agg; a CTE-rooted select and its scalar subquery read json_agg', () => withoutNativeArrays(async () => {
        const db = fixture.db;
        // A builder that knows the client (so it knows the driver's array capability)
        const lists = new DbCteBuilder(fixture.client).with('agg_member_id_lists', db.members.select(m => ({ ids: agg.arrayAgg(m.id, { orderBy: m.id }) })));

        const fromBody = await db.selectFromCte(lists.cte).select(r => ({ n: sql<number>`cardinality(${r.ids})` })).first();
        expect(fromBody).toEqual({ n: 4 });
        expect(fixture.lastStatement()).not.toContain('json_agg(');

        const joined = await db.clubs
          .where(c => eq(c.id, 1))
          .innerJoin(
            db.members.select(m => ({ ids: agg.arrayAgg(m.id) })).asSubquery('table'),
            () => sql<boolean>`TRUE`,
            (c, s) => ({ id: c.id, n: sql<number>`cardinality(${s.ids})` }),
            'member_id_lists'
          )
          .toList();
        expect(joined).toEqual([{ id: 1, n: 4 }]);
        expect(fixture.lastStatement()).not.toContain('json_agg(');

        const members = new DbCteBuilder().with('agg_member_ids_json', db.members.select(m => ({ memberId: m.id })));
        const rooted = await db.selectFromCte(members.cte).select(r => ({ ids: agg.arrayAgg(r.memberId, { orderBy: r.memberId }) })).first();
        expect(rooted).toEqual({ ids: [1, 2, 3, 4] });
        expect(count(fixture.lastStatement(), 'json_agg(')).toBe(1);

        const nested = await db.clubs
          .where(c => eq(c.id, 1))
          .select(() => ({ ids: db.selectFromCte(members.cte).select(r => ({ ids: agg.arrayAgg(r.memberId, { orderBy: r.memberId }) })).asSubquery('scalar') }))
          .firstOrDefault();
        expect(nested).toEqual({ ids: [1, 2, 3, 4] } as any);
        expect(count(fixture.lastStatement(), 'json_agg(')).toBe(1);
      }));

      test('int8 / numeric elements read as their text — lossless, in the native order; a timestamp as its JSON text', () => withoutNativeArrays(async () => {
        const row = await fixture.db.members
          .select(m => ({
            big: agg.arrayAgg(m.big, { orderBy: m.id }).filter(isNotNull(m.big)),
            bigDesc: agg.arrayAgg(m.big, { distinct: true, orderBy: [[m.big, 'DESC']] }).filter(isNotNull(m.big)),
            scores: agg.arrayAgg(m.score, { orderBy: m.id }).filter(isNotNull(m.score)),
            stamps: agg.arrayAgg(literal('2024-03-10 23:30:00', 'timestamp')).filter(eq(m.id, 1)),
          }))
          .firstOrDefault();

        expect(row).toEqual({
          big: ['9007199254740993', '5', '7'],
          bigDesc: ['9007199254740993', '7', '5'],
          scores: ['1.50', '2.25', '3.00'] as unknown as number[],
          stamps: ['2024-03-10T23:30:00'],
        });
        expect(fixture.lastStatement()).toContain('to_json(CAST(array_agg(DISTINCT "fx_members"."big" ORDER BY "fx_members"."big" DESC)');
      }));
    });

    test('an int8 list reads the same strings on the native path', async () => {
      const row = await fixture.db.members
        .select(m => ({ big: agg.arrayAgg(m.big, { orderBy: m.id }).filter(isNotNull(m.big)) }))
        .firstOrDefault();

      expect(row).toEqual({ big: ['9007199254740993', '5', '7'] });
    });
  });
});
