import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, caseWhen, DbCteBuilder, eq, exists, FieldRef, gt, literal, ne, notExists, QueryBatch, searchNormalize, sql,
  SqlFragment, Subquery,
} from '../../src';
import { DRIVER_VALUE_MAPPER, SqlBuildContext } from '../../src/query/conditions';
import { build, ClubFixture, createClubFixture, disposeClubFixture, ref } from '../utils/club-fixture';

/** A Subquery stub: renders `SELECT 1 …` and reports the given outer refs. */
function stubSubquery(text: string, outerRefs: FieldRef[] = []): Subquery<any, 'table'> {
  return new Subquery((ctx: SqlBuildContext) => {
    ctx.params.push('p');
    return `${text} $${ctx.paramCounter++}`;
  }, 'table', undefined, outerRefs);
}

/** A fragment subclass that renders and reports its refs its own way (like ExistsCondition does). */
class ProbeFragment extends SqlFragment<string> {
  constructor(private readonly probeRef: FieldRef) {
    super([], []);
  }

  override buildSql(context: SqlBuildContext): string {
    return `probe(${this.probeRef.__dbColumnName}, ${context.paramCounter})`;
  }

  override getFieldRefs(): FieldRef[] {
    return [this.probeRef];
  }
}

describe('SqlFragment subclasses keep their SQL and refs through .as() / .mapWith()', () => {
  const outer = ref('city', { alias: 'club' });

  test('exists(sub).as() renders the EXISTS and reports the subquery outer refs', () => {
    const aliased = exists(stubSubquery('SELECT 1 FROM "t" WHERE x =', [outer])).as('flag');

    expect(build(aliased)).toEqual({ sql: 'EXISTS (SELECT 1 FROM "t" WHERE x = $1)', params: ['p'] });
    expect(aliased.getAlias()).toBe('flag');
    expect(aliased.getFieldRefs()).toEqual([outer]);
  });

  test('notExists(sub).mapWith() renders the NOT EXISTS and reads through the mapper', () => {
    const mapped = notExists(stubSubquery('SELECT 1 FROM "t" WHERE y =', [outer])).mapWith((v: boolean) => (v ? 'none' : 'some'));

    expect(build(mapped)).toEqual({ sql: '(NOT EXISTS (SELECT 1 FROM "t" WHERE y = $1))', params: ['p'] });
    expect(mapped.getFieldRefs()).toEqual([outer]);
    expect(mapped.getMapper().fromDriver(true)).toBe('none');
  });

  test('.as() then .mapWith() on a subclass keep both the SQL and the alias', () => {
    const fragment = exists(stubSubquery('SELECT 2')).as('a').mapWith(Number);

    expect(build(fragment).sql).toBe('EXISTS (SELECT 2 $1)');
    expect(fragment.getAlias()).toBe('a');
  });

  test('any subclass overriding buildSql / getFieldRefs survives .as() and .mapWith()', () => {
    const probeRef = ref('nickname');
    const probe = new ProbeFragment(probeRef);

    expect(build(probe.as('x'), { paramCounter: 7 }).sql).toBe('probe(nickname, 7)');
    expect(probe.as('x').getFieldRefs()).toEqual([probeRef]);
    expect(build(probe.mapWith(String)).sql).toBe('probe(nickname, 1)');
    expect(probe.mapWith(String).getFieldRefs()).toEqual([probeRef]);
  });

  test('a plain fragment and a CASE expression render exactly as before', () => {
    const plain = sql<number>`${ref('points')} + ${5}`;
    expect(build(plain.as('x'))).toEqual({ sql: '"fx_members"."points" + $1', params: [5] });
    expect(build(plain.mapWith(Number))).toEqual({ sql: '"fx_members"."points" + $1', params: [5] });

    const kase = caseWhen(gt(ref('points'), 10), literal('high')).else(literal('low'));
    expect(build(kase.as('level'))).toEqual({ sql: `CASE WHEN "fx_members"."points" > $1 THEN 'high' ELSE 'low' END`, params: [10] });
  });

  test('sql.join over subclass fragments renders each of them', () => {
    const joined = sql.join([
      exists(stubSubquery('SELECT a')),
      notExists(stubSubquery('SELECT b')),
    ], sql` AND `);

    expect(build(joined)).toEqual({ sql: 'EXISTS (SELECT a $1) AND (NOT EXISTS (SELECT b $2))', params: ['p', 'p'] });
  });

  describe('against the database', () => {
    let fixture: ClubFixture;

    beforeAll(async () => {
      fixture = await createClubFixture();
    });

    afterAll(async () => {
      await disposeClubFixture(fixture);
    });

    test('exists(...).as() projects a boolean column', async () => {
      const db = fixture.db;
      const rows = await db.clubs
        .select(c => ({
          id: c.id,
          hasMembers: exists(db.members.where(m => eq(m.clubId, c.id)).select(() => ({ one: literal(1) })).asSubquery()).as('hasMembers'),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, hasMembers: true },
        { id: 2, hasMembers: true },
        { id: 3, hasMembers: false },
      ]);
      expect(fixture.lastStatement()).toContain('EXISTS (SELECT 1 as "one"');
    });

    test('notExists(...).mapWith() projects through the mapper', async () => {
      const db = fixture.db;
      const rows = await db.clubs
        .select(c => ({
          id: c.id,
          state: notExists(db.members.where(m => eq(m.clubId, c.id)).select(() => ({ one: literal(1) })).asSubquery())
            .mapWith((empty: boolean) => (empty ? 'empty' : 'active')),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.id - b.id).map(r => r.state)).toEqual(['active', 'active', 'empty']);
    });

    test('a navigation read only inside exists(...).as() is joined', async () => {
      const db = fixture.db;
      const rows = await db.members
        .select(m => ({
          id: m.id,
          sharesCity: exists(db.clubs
            .where(c => and(eq(c.city, m.club!.city), ne(c.id, m.clubId)))
            .select(() => ({ one: literal(1) }))
            .asSubquery()).as('sharesCity'),
        }))
        .toList();

      expect(rows.map(r => r.sharesCity)).toEqual([false, false, false, false]);
      expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);
    });
  });
});

describe('searchNormalize() reads back as text', () => {
  test('carries the driver-value mapper', () => {
    expect(searchNormalize(ref('nickname')).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    expect(build(searchNormalize(ref('nickname'))).sql).toBe('public.search_normalize("fx_members"."nickname")');
  });

  describe('against the database', () => {
    let fixture: ClubFixture;

    beforeAll(async () => {
      fixture = await createClubFixture();
    });

    afterAll(async () => {
      await disposeClubFixture(fixture);
    });

    test('a digits-only value stays a string, NULL reads null', async () => {
      const rows = await fixture.db.members
        .select(m => ({ id: m.id, normalized: searchNormalize(m.nickname!) }))
        .toList();
      const byId = new Map(rows.map(r => [r.id, r.normalized]));

      expect(byId.get(4)).toBe('007');
      expect(byId.get(2)).toBeNull();
    });
  });
});

describe('SqlFragment.withReadType()', () => {
  test('changes no SQL and no parameter', () => {
    const raw = sql<string>`upper(${ref('nickname')}) || ${'x'}`;
    const typed = raw.withReadType('text');

    expect(build(typed)).toEqual(build(raw));
    expect(build(typed)).toEqual({ sql: 'upper("fx_members"."nickname") || $1', params: ['x'] });
  });

  test('drops the mapper and records the read type', () => {
    const typed = sql<number>`1`.mapWith(Number).withReadType<string>('text');

    expect(typed.getMapper()).toBeUndefined();
    expect(typed.getReadType()).toBe('text');
  });

  test('.as() keeps the read type; .mapWith() replaces it with the mapper', () => {
    const typed = sql<string>`x`.withReadType('text');

    expect(typed.as('n').getReadType()).toBe('text');
    expect(typed.as('n').getAlias()).toBe('n');
    expect(typed.mapWith(String).getReadType()).toBeUndefined();
  });

  test('a subclass keeps its SQL under a read type', () => {
    const typed = exists(stubSubquery('SELECT 1')).withReadType<boolean>('boolean');

    expect(build(typed).sql).toBe('EXISTS (SELECT 1 $1)');
    expect(typed.getReadType()).toBe('boolean');
  });

  test('validates the type name', () => {
    expect(() => sql`x`.withReadType('text); DROP TABLE t; --')).toThrow(/Invalid PostgreSQL type name/);
  });

  describe('against the database', () => {
    let fixture: ClubFixture;

    beforeAll(async () => {
      fixture = await createClubFixture();
    });

    afterAll(async () => {
      await disposeClubFixture(fixture);
    });

    const nick = (m: any) => sql<string | null>`${m.nickname}`;

    test('a mapper-less fragment reads digits-only text as a number (why the read type exists)', async () => {
      const row = await fixture.db.members.where(m => eq(m.id, 4)).select(m => ({ n: nick(m) })).firstOrDefault();

      expect(row!.n as unknown).toBe(7);
    });

    test('text: a digits-only value stays a string; NULL reads undefined at the top level', async () => {
      const rows = await fixture.db.members
        .select(m => ({ id: m.id, n: nick(m).withReadType('text') }))
        .toList();
      const byId = new Map(rows.map(r => [r.id, r]));

      expect(byId.get(4)!.n).toBe('007');
      expect(byId.get(1)!.n).toBe('A');
      expect(byId.get(2)!.n).toBeUndefined();
      expect('n' in byId.get(2)!).toBe(true);
    });

    test('text inside a nested object: NULL reads null', async () => {
      const rows = await fixture.db.members
        .select(m => ({ id: m.id, info: { n: nick(m).withReadType('text') } }))
        .toList();
      const byId = new Map(rows.map(r => [r.id, r]));

      expect(byId.get(4)!.info).toEqual({ n: '007' });
      expect(byId.get(2)!.info).toEqual({ n: null });
    });

    test('numeric: numeric text becomes a number; integer reads as a number', async () => {
      const row = await fixture.db.members
        .where(m => eq(m.id, 1))
        .select(m => ({
          score: sql<number>`${m.score}`.withReadType('numeric'),
          points: sql<number>`${m.points}`.withReadType('integer'),
        }))
        .firstOrDefault();

      expect(row).toEqual({ score: 1.5, points: 10 });
    });

    test('.as() keeps the read', async () => {
      const row = await fixture.db.members
        .where(m => eq(m.id, 4))
        .select(m => ({ n: nick(m).withReadType('text').as('n') }))
        .firstOrDefault();

      expect(row).toEqual({ n: '007' });
    });

    test('selectDistinct re-projection keeps the read', async () => {
      const rows = await fixture.db.members
        .selectDistinct(m => ({ n: nick(m).withReadType('text') }))
        .toList();

      expect(rows.map(r => r.n).filter(n => n !== undefined).sort()).toEqual(['007', 'A', 'C']);
    });

    test('a UNION reads every leg through the read-typed first leg', async () => {
      const rows = await fixture.db.members
        .where(m => eq(m.id, 3))
        .select(m => ({ n: nick(m).withReadType('text') }))
        .unionAll(fixture.db.members.where(m => eq(m.id, 4)).select(m => ({ n: nick(m) })))
        .toList();

      // '007' comes from the SECOND leg, which carries no read type of its own
      expect(rows.map(r => r.n).sort()).toEqual(['007', 'C']);
    });

    test('a grouped select reads a read-typed fragment as that type', async () => {
      const rows = await fixture.db.members
        .select(m => ({ clubId: m.clubId, score: m.score, nickname: m.nickname }))
        .groupBy(r => ({ clubId: r.clubId }))
        .select(g => ({
          clubId: g.key.clubId,
          total: sql<number>`${g.sum(r => r.score)}`.withReadType('numeric'),
          nick: sql<string>`${g.max(r => r.nickname)}`.withReadType('text'),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.clubId - b.clubId)).toEqual([
        { clubId: 1, total: 3.75, nick: 'C' },
        { clubId: 2, total: 3, nick: '007' },
      ]);
    });

    test('a QueryBatch part reads like the standalone query', async () => {
      const query = () => fixture.db.members
        .where(m => eq(m.id, 4))
        .select(m => ({ n: nick(m).withReadType('text'), raw: nick(m) }));
      const standalone = await query().firstOrDefault();

      const batch = new QueryBatch();
      const key = batch.addFirstOrDefault(query(), 'probe');
      await batch.executeBatch();

      expect(standalone).toEqual({ n: '007', raw: 7 as unknown as string });
      expect(batch.getItem(key)).toEqual(standalone);
    });

    test('a CTE column projected from a read-typed fragment reads as that type', async () => {
      const db = fixture.db;
      const nicknames = new DbCteBuilder().with(
        'member_nicknames',
        db.members.select(m => ({ memberId: m.id, n: nick(m).withReadType('text'), raw: nick(m) })),
      );

      const rows = await db.members
        .where(m => eq(m.id, 4))
        .with(nicknames.cte)
        .leftJoin(nicknames.cte, (m, cte) => eq(m.id, cte.memberId), (m, cte) => ({ id: m.id, n: cte.n, raw: cte.raw }))
        .toList();

      expect(rows).toEqual([{ id: 4, n: '007', raw: 7 as unknown as string }]);
    });

    test('selectFromCte reads a read-typed column as that type', async () => {
      const db = fixture.db;
      const nicknames = new DbCteBuilder().with(
        'member_nicknames_root',
        db.members.where(m => eq(m.id, 4)).select(m => ({ n: nick(m).withReadType('text'), raw: nick(m) })),
      );

      const rows = await db.selectFromCte(nicknames.cte).select(r => ({ n: r.n, raw: r.raw })).toList();

      expect(rows).toEqual([{ n: '007', raw: 7 as unknown as string }]);
    });

    test('a table-subquery column projected from a read-typed fragment reads as that type', async () => {
      const db = fixture.db;
      const sub = db.members
        .where(m => eq(m.id, 4))
        .select(m => ({ memberId: m.id, n: nick(m).withReadType('text'), raw: nick(m) }))
        .asSubquery('table');

      const rows = await db.members
        .innerJoin(sub, (m, s) => eq(m.id, s.memberId), (m, s) => ({ id: m.id, n: s.n, raw: s.raw }), 'nick_sub')
        .toList();

      expect(rows).toEqual([{ id: 4, n: '007', raw: 7 as unknown as string }]);
    });

    test('collection items keep the value as delivered', async () => {
      const row = await fixture.db.clubs
        .where(c => eq(c.id, 2))
        .select(c => ({ nicks: c.members!.select(m => ({ n: nick(m).withReadType('text') })).toList() }))
        .firstOrDefault();

      expect(row).toEqual({ nicks: [{ n: '007' }] });
    });
  });
});
