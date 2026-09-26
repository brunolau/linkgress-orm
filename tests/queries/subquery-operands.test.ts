import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  add, and, between, caseWhen, coalesce, eq, eqAnySubquery, exists, FieldRef, gt, inArray, isNotNull, isNull, like, literal,
  lower, ne, neAllSubquery, not, notExists, sql, Subquery,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { build, ClubFixture, createClubFixture, disposeClubFixture, ref } from '../utils/club-fixture';

/** A Subquery stub rendering `<text> $n` with one bound parameter, reporting the given outer refs. */
function stub<M extends 'scalar' | 'array' | 'table'>(text: string, mode: M, outerRefs: FieldRef[] = [], value: unknown = 'p'): Subquery<any, M> {
  return new Subquery((ctx: SqlBuildContext) => {
    ctx.params.push(value);
    return `${text} $${ctx.paramCounter++}`;
  }, mode, undefined, outerRefs);
}

const outer = ref('city', { alias: 'club' });

describe('eqAnySubquery() / neAllSubquery()', () => {
  test('render (<field> = ANY (ARRAY(<subquery>))) and (<field> <> ALL (ARRAY(<subquery>)))', () => {
    expect(build(eqAnySubquery(ref('club_id'), stub('SELECT "fx_clubs"."id" FROM "fx_clubs" WHERE "fx_clubs"."city" =', 'array'))))
      .toEqual({ sql: '("fx_members"."club_id" = ANY (ARRAY(SELECT "fx_clubs"."id" FROM "fx_clubs" WHERE "fx_clubs"."city" = $1)))', params: ['p'] });
    expect(build(neAllSubquery(ref('club_id'), stub('SELECT 1', 'table'))))
      .toEqual({ sql: '("fx_members"."club_id" <> ALL (ARRAY(SELECT 1 $1)))', params: ['p'] });
  });

  test('binds only the subquery parameters, in sequence', () => {
    expect(build(eqAnySubquery(ref('club_id'), stub('SELECT x', 'array')), { paramCounter: 3 }))
      .toEqual({ sql: '("fx_members"."club_id" = ANY (ARRAY(SELECT x $3)))', params: ['p'] });
  });

  test('an expression field renders as itself', () => {
    expect(build(eqAnySubquery(lower(ref('name')), stub('SELECT n', 'array'))).sql)
      .toBe('(lower("fx_members"."name") = ANY (ARRAY(SELECT n $1)))');
  });

  test('reports the field refs and the subquery outer refs', () => {
    const clubId = ref('club_id');
    expect(eqAnySubquery(clubId, stub('SELECT 1', 'array', [outer])).getFieldRefs()).toEqual([clubId, outer]);
    expect(neAllSubquery(clubId, stub('SELECT 1', 'array', [outer])).getFieldRefs()).toEqual([clubId, outer]);
  });

  test('refuses anything but a subquery', () => {
    expect(() => eqAnySubquery(ref('club_id'), [1, 2] as any)).toThrow(/eqAnySubquery\(\).*asSubquery/);
    expect(() => neAllSubquery(ref('club_id'), sql`SELECT 1` as any)).toThrow(/neAllSubquery\(\).*asSubquery/);
  });
});

describe('Subquery.asExpression()', () => {
  test('renders (<subquery>) with its parameters and outer refs, and no mapper', () => {
    const expression = stub('SELECT n FROM t WHERE x =', 'scalar', [outer]).asExpression<string>();

    expect(build(expression, { paramCounter: 2 })).toEqual({ sql: '(SELECT n FROM t WHERE x = $2)', params: ['p'] });
    expect(expression.getFieldRefs()).toEqual([outer]);
    expect(expression.getMapper()).toBeUndefined();
  });

  test('is a fragment: coalesce, CASE, isNull, eq, arithmetic', () => {
    const expression = () => stub('SELECT v', 'scalar').asExpression<number>();

    expect(build(coalesce(expression(), literal(0))).sql).toBe('COALESCE((SELECT v $1), 0)');
    expect(build(caseWhen(isNull(expression()), literal('none')).else(literal('some'))).sql)
      .toBe(`CASE WHEN (SELECT v $1) IS NULL THEN 'none' ELSE 'some' END`);
    expect(build(eq(ref('points'), expression()))).toEqual({ sql: '"fx_members"."points" = (SELECT v $1)', params: ['p'] });
    expect(build(add(expression(), 1))).toEqual({ sql: '((SELECT v $1) + $2)', params: ['p', 1] });
  });

  test('scalar mode only', () => {
    expect(() => stub('SELECT v', 'array').asExpression()).toThrow(/scalar/);
    expect(() => stub('SELECT v', 'table').asExpression()).toThrow(/scalar/);
  });
});

describe('Subquery.as()', () => {
  test('a clone under the alias: same SQL, mode, selection metadata, outer refs and scalar read; the original keeps no alias', () => {
    const selection = { n: ref('name') };
    const scalarRead = { mapper: undefined, readType: 'text' } as any;
    const original = new Subquery((ctx: SqlBuildContext) => `SELECT n $${ctx.paramCounter++}`, 'scalar', selection, [outer], scalarRead);
    const aliased = original.as('sq');

    expect(aliased).not.toBe(original);
    expect(aliased.getAlias()).toBe('sq');
    expect(original.getAlias()).toBeUndefined();
    expect(aliased.isScalar()).toBe(true);
    expect(aliased.getSelectionMetadata()).toBe(selection);
    expect(aliased.getOuterFieldRefs()).toEqual([outer]);
    expect(aliased.getScalarRead()).toBe(scalarRead);
    expect(build(aliased.asExpression(), { paramCounter: 4 })).toEqual({ sql: '(SELECT n $4)', params: [] });
  });
});

describe('a Subquery operand in comparisons', () => {
  const scalar = () => stub('SELECT v FROM t WHERE k =', 'scalar', [outer], 'k');

  test('isNull / isNotNull render the subquery in parentheses', () => {
    expect(build(isNull(scalar()))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) IS NULL', params: ['k'] });
    expect(build(isNotNull(scalar()))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) IS NOT NULL', params: ['k'] });
  });

  test('eq / ne / gt / like: either side, parameters in textual order', () => {
    expect(build(eq(ref('points'), scalar()))).toEqual({ sql: '"fx_members"."points" = (SELECT v FROM t WHERE k = $1)', params: ['k'] });
    expect(build(eq(scalar(), 5))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) = $2', params: ['k', 5] });
    expect(build(ne(scalar(), ref('points')))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) != "fx_members"."points"', params: ['k'] });
    expect(build(gt(scalar(), scalar()))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) > (SELECT v FROM t WHERE k = $2)', params: ['k', 'k'] });
    expect(build(like(scalar(), 'a%'))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) LIKE $2', params: ['k', 'a%'] });
  });

  test('between and inArray', () => {
    expect(build(between(scalar(), 1, 5))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) BETWEEN $2 AND $3', params: ['k', 1, 5] });
    expect(build(between(ref('points'), scalar(), scalar())))
      .toEqual({ sql: '"fx_members"."points" BETWEEN (SELECT v FROM t WHERE k = $1) AND (SELECT v FROM t WHERE k = $2)', params: ['k', 'k'] });
    expect(build(inArray(scalar(), [1, 2]))).toEqual({ sql: '(SELECT v FROM t WHERE k = $1) IN ($2, $3)', params: ['k', 1, 2] });
  });

  test('report the subquery outer refs', () => {
    const points = ref('points');
    expect(isNull(scalar()).getFieldRefs()).toEqual([outer]);
    expect(eq(points, scalar()).getFieldRefs()).toEqual([points, outer]);
    expect(between(points, scalar(), 3).getFieldRefs()).toEqual([points, outer]);
  });
});

describe('exists() / notExists() refuse a query builder', () => {
  test('an object without exists() is refused with a pointer to asSubquery()', () => {
    expect(() => exists({} as any)).toThrow(/asSubquery/);
    expect(() => notExists(null as any)).toThrow(/asSubquery/);
  });

  test('a collection-like source (synchronous exists()) still works', () => {
    const source = { exists: () => sql<boolean>`EXISTS (SELECT 1)` };
    expect(build(exists(source)).sql).toBe('EXISTS (SELECT 1)');
    expect(build(notExists(source)).sql).toBe('(NOT EXISTS (SELECT 1))');
  });

  describe('against the database', () => {
    let fixture: ClubFixture;

    beforeAll(async () => {
      fixture = await createClubFixture();
    });

    afterAll(async () => {
      await disposeClubFixture(fixture);
    });

    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    test('a standalone query builder is refused before it runs anything', async () => {
      const db = fixture.db;
      const before = fixture.captured.length;

      expect(() => exists(db.members.where(m => eq(m.clubId, 1)) as any)).toThrow(/select\(.*\)\.asSubquery\(\)/);
      expect(() => notExists(db.members.where(m => eq(m.clubId, 1)).select(m => ({ id: m.id })) as any)).toThrow(/asSubquery/);
      expect(() => exists(db.members as any)).toThrow(/asSubquery/);

      await settle();
      expect(fixture.captured.length).toBe(before);
    });

    test('a collection navigation is still accepted', async () => {
      const rows = await fixture.db.clubs
        .where(c => exists(c.members!.where(m => eq(m.active, false))))
        .select(c => ({ id: c.id }))
        .toList();

      expect(rows).toEqual([{ id: 1 }]);
    });
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

  const ids = (rows: Array<{ id: number }>): number[] => rows.map(r => r.id).sort((a, b) => a - b);

  test('eqAnySubquery(): membership in an uncorrelated set', async () => {
    const db = fixture.db;
    const oslo = db.clubs.where(c => eq(c.city, 'Oslo')).select(c => c.id).asSubquery('array');

    expect(ids(await db.members.where(m => eqAnySubquery(m.clubId, oslo)).select(m => ({ id: m.id })).toList())).toEqual([1, 2, 3]);
    expect(ids(await db.members.where(m => neAllSubquery(m.clubId, oslo)).select(m => ({ id: m.id })).toList())).toEqual([4]);
    expect(fixture.lastStatement()).toContain('"fx_members"."club_id" <> ALL (ARRAY(SELECT');
  });

  test('eqAnySubquery(): a NULL field is NULL (neither true nor false), an empty set is FALSE', async () => {
    const db = fixture.db;
    const tens = db.members.where(m => eq(m.points, 10)).select(m => m.points).asSubquery('array');
    const none = db.members.where(m => eq(m.points, -1)).select(m => m.points).asSubquery('array');

    expect(ids(await db.members.where(m => eqAnySubquery(m.points, tens)).select(m => ({ id: m.id })).toList())).toEqual([1, 3]);
    // member 4 (points NULL) is in neither answer
    expect(ids(await db.members.where(m => not(eqAnySubquery(m.points, tens))).select(m => ({ id: m.id })).toList())).toEqual([2]);
    // an empty set: FALSE for every row, the NULL one included
    expect(ids(await db.members.where(m => eqAnySubquery(m.points, none)).select(m => ({ id: m.id })).toList())).toEqual([]);
    expect(ids(await db.members.where(m => not(eqAnySubquery(m.points, none))).select(m => ({ id: m.id })).toList())).toEqual([1, 2, 3, 4]);
    expect(ids(await db.members.where(m => neAllSubquery(m.points, none)).select(m => ({ id: m.id })).toList())).toEqual([1, 2, 3, 4]);
  });

  test('eqAnySubquery(): a correlated set joins the navigation it reads', async () => {
    const db = fixture.db;
    const rows = await db.members
      .where(m => eqAnySubquery(m.clubId, db.clubs.where(c => eq(c.city, m.club!.city)).select(c => c.id).asSubquery('array')))
      .select(m => ({ id: m.id }))
      .toList();

    expect(ids(rows)).toEqual([1, 2, 3, 4]);
    expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);
  });

  test('asExpression(): projects like a raw fragment; mapWith / withReadType type the read', async () => {
    const db = fixture.db;
    const nick = (id: number) => db.members.where(o => eq(o.id, id)).select(o => o.nickname).asSubquery('scalar');

    const row = await db.clubs
      .where(c => eq(c.id, 2))
      .select(c => ({
        raw: nick(4).asExpression<string>(),
        typed: nick(4).asExpression<string>().withReadType('text'),
        mapped: nick(4).asExpression<string>().mapWith((v: string) => `#${v}`),
        missing: nick(99).asExpression<string>(),
        fallback: coalesce(nick(99).asExpression<string>(), literal('none')),
      }))
      .firstOrDefault();

    expect(row!.raw as unknown).toBe(7);
    expect(row!.typed).toBe('007');
    expect(row!.mapped).toBe('#007');
    expect(row!.missing).toBeUndefined();
    expect(row!.fallback).toBe('none');
  });

  test('asExpression(): a correlated scalar in WHERE, arithmetic and an UPDATE SET value', async () => {
    const db = fixture.db;
    const clubCity = (m: any) => db.clubs.where(c => eq(c.id, m.clubId)).select(c => c.city).asSubquery('scalar').asExpression<string>();

    expect(ids(await db.members.where(m => eq(clubCity(m), 'Lima')).select(m => ({ id: m.id })).toList())).toEqual([4]);

    const plusOne = await db.members
      .where(m => eq(m.id, 2))
      .select(m => ({ id: m.id, next: add(db.members.where(o => eq(o.id, 1)).select(o => o.points).asSubquery('scalar').asExpression<number>(), 1) }))
      .toList();
    expect(plusOne).toEqual([{ id: 2, next: 11 }]);

    await db.members.where(m => eq(m.id, 3)).update(m => ({ nickname: clubCity(m) }));
    const updated = await db.members.where(m => eq(m.id, 3)).select(m => ({ nickname: m.nickname })).firstOrDefault();
    expect(updated).toEqual({ nickname: 'Oslo' });
    expect(fixture.lastStatement('UPDATE')).toContain('SET "nickname" = (SELECT "fx_clubs"."city"');

    await db.members.where(m => eq(m.id, 3)).update({ nickname: 'C' });
  });

  test('a Subquery compared with eq / isNull renders and runs (it used to bind the Subquery object)', async () => {
    const db = fixture.db;
    const bobPoints = db.members.where(o => eq(o.id, 2)).select(o => o.points).asSubquery('scalar');

    expect(ids(await db.members.where(m => eq(m.points, bobPoints)).select(m => ({ id: m.id })).toList())).toEqual([2]);

    const inLima = (m: any) => db.clubs.where(c => and(eq(c.id, m.clubId), eq(c.city, 'Lima'))).select(c => c.id).asSubquery('scalar');
    expect(ids(await db.members.where(m => isNull(inLima(m))).select(m => ({ id: m.id })).toList())).toEqual([1, 2, 3]);
    expect(ids(await db.members.where(m => isNotNull(inLima(m))).select(m => ({ id: m.id })).toList())).toEqual([4]);
  });

  test('a collection count compared in WHERE renders its correlated count (it used to render "[object Object]")', async () => {
    const db = fixture.db;
    const rows = await db.clubs.where(c => gt(c.members!.count(), 1)).select(c => ({ id: c.id })).toList();

    expect(ids(rows)).toEqual([1]);
    expect(fixture.lastStatement()).toMatch(/WHERE \(SELECT COUNT\(\*\) FROM "fx_members"/);
  });

  test('a Subquery operand reading an outer navigation joins it', async () => {
    const db = fixture.db;
    const rows = await db.members
      .where(m => eq(db.clubs.where(c => eq(c.city, m.club!.city)).select(c => c.name).asSubquery('scalar'), 'South'))
      .select(m => ({ id: m.id }))
      .toList();

    expect(ids(rows)).toEqual([4]);
    expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);
  });
});
