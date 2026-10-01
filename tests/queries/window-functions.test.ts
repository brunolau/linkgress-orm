import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  atTimeZone, castAsDate, DatabaseClient, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, eq, gt,
  inSubquery, integer, lower, lte, serial, sql, timestamp, win, WindowFragment,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { build, ClubFixture, createClubFixture, disposeClubFixture, ref } from '../utils/club-fixture';
import { createFreshClient } from '../utils/test-database';
import { assertType } from '../utils/type-tester';

const points = ref('points', { sqlType: 'integer' });
const id = ref('id', { sqlType: 'integer' });
const clubId = ref('club_id', { sqlType: 'integer' });

describe('win — window ranking functions', () => {
  describe('rendering', () => {
    test('without over(): the empty window', () => {
      expect(build(win.rowNumber())).toEqual({ sql: 'row_number() OVER ()', params: [] });
      expect(build(win.rank()).sql).toBe('rank() OVER ()');
      expect(build(win.denseRank()).sql).toBe('dense_rank() OVER ()');
    });

    test('PARTITION BY and ORDER BY — every ORDER BY key carries its direction', () => {
      expect(build(win.rowNumber().over({ partitionBy: clubId, orderBy: [[points, 'DESC'], id] })).sql)
        .toBe('row_number() OVER (PARTITION BY "fx_members"."club_id" ORDER BY "fx_members"."points" DESC, "fx_members"."id" ASC)');
      expect(build(win.rank().over({ partitionBy: [clubId, lower(ref('name'))] })).sql)
        .toBe('rank() OVER (PARTITION BY "fx_members"."club_id", lower("fx_members"."name"))');
      expect(build(win.denseRank().over({ orderBy: points })).sql)
        .toBe('dense_rank() OVER (ORDER BY "fx_members"."points" ASC)');
      expect(build(win.rowNumber().over({})).sql).toBe('row_number() OVER ()');
    });

    test('parameters in textual order: the PARTITION BY keys, then the ORDER BY keys', () => {
      const fragment = win.rowNumber().over({ partitionBy: sql`${points} / ${10}`, orderBy: [[sql`${id} * ${2}`, 'DESC']] });

      expect(build(fragment, { paramCounter: 3 })).toEqual({
        sql: 'row_number() OVER (PARTITION BY "fx_members"."points" / $3 ORDER BY "fx_members"."id" * $4 DESC)',
        params: [10, 2],
      });
    });

    test('immutable: over() returns a new fragment over the window it is given', () => {
      const base = win.rowNumber();
      const ordered = base.over({ orderBy: id });

      expect(ordered).not.toBe(base);
      expect(ordered).toBeInstanceOf(WindowFragment);
      expect(build(base).sql).toBe('row_number() OVER ()');
      expect(build(ordered.over({ partitionBy: clubId })).sql).toBe('row_number() OVER (PARTITION BY "fx_members"."club_id")');
    });

    test('a plain JS value as a key is refused', () => {
      expect(() => win.rowNumber().over({ partitionBy: 1 as any })).toThrow(/rowNumber\(\)\.over\(\): a PARTITION BY key must be a column or an expression — got number/);
      expect(() => win.rank().over({ orderBy: ['x' as any, 'DESC'] })).toThrow(/rank\(\)\.over\(\): an ORDER BY key must be a column or an expression/);
    });

    test('reads a JS number', () => {
      expect(win.rowNumber().getMapper().fromDriver('3')).toBe(3);
      expect(win.rank().over({ orderBy: id }).getMapper().fromDriver(null)).toBeNull();
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

    test('one row per input row: numbering per partition, ties ranked', async () => {
      const rows = await fixture.db.members
        .select(m => ({
          name: m.name,
          rowInClub: win.rowNumber().over({ partitionBy: m.clubId, orderBy: [[m.points, 'DESC'], m.id] }),
          byPoints: win.rank().over({ orderBy: m.points }),
          denseByPoints: win.denseRank().over({ orderBy: m.points }),
        }))
        .orderBy(r => r.name)
        .toList();

      // points: ann 10, bob 20, cyd 10 (club 1); dee NULL (club 2) — NULL sorts last ascending
      expect(rows).toEqual([
        { name: 'ann', rowInClub: 2, byPoints: 1, denseByPoints: 1 },
        { name: 'bob', rowInClub: 1, byPoints: 3, denseByPoints: 2 },
        { name: 'cyd', rowInClub: 3, byPoints: 1, denseByPoints: 1 },
        { name: 'dee', rowInClub: 1, byPoints: 4, denseByPoints: 3 },
      ]);
      expect(fixture.lastStatement()).not.toContain('GROUP BY');
      assertType<number, typeof rows[0]['rowInClub']>(rows[0].rowInClub);
    });

    test('a navigation used only in a PARTITION BY key is joined', async () => {
      const rows = await fixture.db.members
        .select(m => ({ name: m.name, inCity: win.rowNumber().over({ partitionBy: m.club!.city, orderBy: m.id }) }))
        .orderBy(r => r.name)
        .toList();

      expect(rows.map(r => r.inCity)).toEqual([1, 2, 3, 1]);
      expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);
    });

    test('computed in a CTE body, filtered by the query that reads the CTE — also as an IN subquery', async () => {
      const ranked = new DbCteBuilder().with(
        'win_ranked_members',
        fixture.db.members.select(m => ({
          memberId: m.id,
          rowInClub: win.rowNumber().over({ partitionBy: m.clubId, orderBy: [[m.points, 'DESC'], m.id] }),
        })),
      );

      const firsts = await fixture.db
        .selectFromCte(ranked.cte)
        .where(r => eq(r.rowInClub, 1))
        .select(r => ({ memberId: r.memberId, rowInClub: r.rowInClub }))
        .orderBy(r => [[r.memberId, 'ASC']])
        .toList();
      expect(firsts).toEqual([{ memberId: 2, rowInClub: 1 }, { memberId: 4, rowInClub: 1 }]);

      const others = await fixture.db.members
        .where(m => inSubquery(m.id, fixture.db.selectFromCte(ranked.cte).where(r => gt(r.rowInClub, 1)).select(r => ({ id: r.memberId })).asSubquery('array')))
        .select(m => ({ name: m.name }))
        .orderBy(r => r.name)
        .toList();
      expect(others.map(r => r.name)).toEqual(['ann', 'cyd']);
      expect(fixture.lastStatement()).toContain('WITH "win_ranked_members" AS (');
    });

    test('filtered in the query that computes it: refused — also under an alias a column of the table has', () => {
      // A later where() can only reach a computed projection by its alias: the query computing it has
      // no such column (an error at best), or the table has one by that name (`points`), which the
      // condition would filter instead — the wrong rows, silently. The CTE above is the way.
      expect(() => fixture.db.members
        .select(m => ({ memberId: m.id, rowInClub: win.rowNumber().over({ partitionBy: m.clubId, orderBy: m.id }) }))
        .where(r => eq(r.rowInClub, 1))).toThrow(/`rowInClub` is a window function value: .* cannot be filtered in the query that computes it/);
      expect(() => fixture.db.members
        .select(m => ({ name: m.name, points: win.rowNumber().over({ orderBy: m.id }).as('points') }))
        .where(r => eq(r.points, 10))).toThrow(/`points` is a window function value/);
    });

    test('inside a collection navigation: numbered per parent under every collection strategy', async () => {
      for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
        const clubs = await fixture.db.clubs
          .withQueryOptions({ collectionStrategy: strategy })
          .where(c => lte(c.id, 2))
          .select(c => ({
            name: c.name,
            members: c.members!
              .orderBy(m => m.id)
              .select(m => ({ name: m.name, nthInClub: win.rowNumber().over({ orderBy: m.id }) }))
              .toList('members'),
          }))
          .orderBy(r => r.name)
          .toList();

        expect({ strategy, clubs }).toEqual({
          strategy,
          clubs: [
            { name: 'North', members: [{ name: 'ann', nthInClub: 1 }, { name: 'bob', nthInClub: 2 }, { name: 'cyd', nthInClub: 3 }] },
            { name: 'South', members: [{ name: 'dee', nthInClub: 1 }] },
          ],
        });
      }
    });
  });

  describe('a time-zone-shifted date as a PARTITION BY key', () => {
    class WinReading extends DbEntity {
      id!: DbColumn<number>;
      sensorId!: DbColumn<number>;
      takenAtUtc!: DbColumn<Date>;
    }

    class WinReadingDatabase extends DbContext {
      get readings(): DbEntityTable<WinReading> {
        return this.table(WinReading);
      }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(WinReading, entity => {
          entity.toTable('win_readings');
          entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
          entity.property(e => e.sensorId).hasType(integer('sensor_id')).isRequired();
          entity.property(e => e.takenAtUtc).hasType(timestamp('taken_at_utc')).isRequired();
        });
      }
    }

    let client: DatabaseClient;
    let db: WinReadingDatabase;

    beforeAll(async () => {
      (EntityMetadataStore as any).metadata.clear();
      client = createFreshClient();
      db = new WinReadingDatabase(client);
      await client.query('DROP TABLE IF EXISTS win_readings CASCADE');
      await db.getSchemaManager().ensureCreated();
      // Europe/Oslo switches to summer time on 2025-03-30 at 01:00 UTC.
      await client.query(`INSERT INTO win_readings (sensor_id, taken_at_utc) VALUES
        (1, '2025-03-29 22:30:00'),
        (1, '2025-03-29 23:30:00'),
        (1, '2025-03-30 21:30:00'),
        (1, '2025-03-30 22:30:00'),
        (2, '2025-03-30 10:00:00')`);
    });

    afterAll(async () => {
      await client.query('DROP TABLE IF EXISTS win_readings CASCADE');
      await db.dispose();
    });

    test('numbers the readings per sensor and LOCAL day, across the DST switch', async () => {
      const rows = await db.readings
        .select(r => ({
          id: r.id,
          nthOfLocalDay: win.rowNumber().over({
            partitionBy: [r.sensorId, castAsDate(atTimeZone(atTimeZone(r.takenAtUtc, 'UTC'), 'Europe/Oslo'))],
            orderBy: [r.takenAtUtc, r.id],
          }),
        }))
        .orderBy(r => r.id)
        .toList();

      // local: 03-29 23:30 | 03-30 00:30, 03-30 23:30 | 03-31 00:30 | sensor 2 03-30 12:00
      expect(rows.map(r => r.nthOfLocalDay)).toEqual([1, 1, 2, 1, 1]);
    });
  });
});
