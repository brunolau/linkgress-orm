import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  addInterval, atTimeZone, castAsString, currentDate, currentTimestamp, datePart, dateTrunc, eq, isNotNull,
  localTimestamp, lt, SqlFragment, subInterval, toChar, toInterval, utcTimestamp, gt,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('date / time helpers', () => {
  const placedAt = fieldRef('placed_at', { sqlType: 'timestamp' });
  const placedTz = fieldRef('placed_tz', { sqlType: 'timestamptz' });
  const zone = fieldRef('time_zone', { alias: 'library', sqlType: 'varchar' });

  describe('rendering', () => {
    test('clock keywords', () => {
      expect(build(currentTimestamp())).toEqual({ sql: 'CURRENT_TIMESTAMP', params: [] });
      expect(build(localTimestamp())).toEqual({ sql: 'LOCALTIMESTAMP', params: [] });
      expect(build(currentDate())).toEqual({ sql: 'CURRENT_DATE', params: [] });
      expect(build(utcTimestamp())).toEqual({ sql: "(now() AT TIME ZONE 'UTC')", params: [] });
    });

    test('AT TIME ZONE with a name and with a zone column (cast to text, enum-safe)', () => {
      expect(build(atTimeZone(placedTz, 'Europe/Vienna'))).toEqual({
        sql: '("expr_shelves"."placed_tz" AT TIME ZONE CAST($1 AS text))',
        params: ['Europe/Vienna'],
      });
      expect(build(atTimeZone(placedTz, zone)).sql).toBe('("expr_shelves"."placed_tz" AT TIME ZONE CAST("library"."time_zone" AS text))');
    });

    test('a JS Date binds as timestamptz; a string stays for PostgreSQL to parse', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      expect(build(atTimeZone(date, 'UTC'))).toEqual({
        sql: '(CAST($1 AS timestamptz) AT TIME ZONE CAST($2 AS text))',
        params: [date, 'UTC'],
      });
      expect(build(dateTrunc('day', '2024-01-01 10:00'))).toEqual({ sql: "date_trunc('day', $1)", params: ['2024-01-01 10:00'] });
    });

    test('date_trunc with and without a zone', () => {
      expect(build(dateTrunc('month', placedAt)).sql).toBe(`date_trunc('month', "expr_shelves"."placed_at")`);
      expect(build(dateTrunc('day', placedTz, 'Europe/Vienna'))).toEqual({
        sql: `date_trunc('day', "expr_shelves"."placed_tz", CAST($1 AS text))`,
        params: ['Europe/Vienna'],
      });
    });

    test('EXTRACT', () => {
      expect(build(datePart('isodow', placedAt)).sql).toBe('EXTRACT(ISODOW FROM "expr_shelves"."placed_at")');
      expect(build(datePart('epoch', placedTz)).sql).toBe('EXTRACT(EPOCH FROM "expr_shelves"."placed_tz")');
    });

    test('unit and field names are allow-listed (they are inlined)', () => {
      expect(() => dateTrunc("day') --" as any, placedAt)).toThrow(/unknown unit/);
      expect(() => datePart('hour FROM x) --' as any, placedAt)).toThrow(/unknown field/);
    });

    test('to_char binds its template', () => {
      expect(build(toChar(placedAt, 'YYYY'))).toEqual({
        sql: 'to_char("expr_shelves"."placed_at", CAST($1 AS text))',
        params: ['YYYY'],
      });
    });

    test('intervals from text, from parts and from a fragment', () => {
      expect(build(toInterval('90 minutes'))).toEqual({ sql: 'CAST($1 AS interval)', params: ['90 minutes'] });
      expect(build(toInterval({ days: 1, hours: 2, minutes: 30 }))).toEqual({
        sql: 'CAST($1 AS interval)',
        params: ['1 days 2 hours 30 minutes'],
      });
      expect(build(toInterval({ years: 1, months: -2, weeks: 1, seconds: 1.5, milliseconds: 250 })).params)
        .toEqual(['1 years -2 months 1 weeks 1.5 seconds 250 milliseconds']);
      expect(build(toInterval(castAsString(placedAt))).sql).toBe('CAST(CAST("expr_shelves"."placed_at" AS text) AS interval)');
    });

    test('interval specs are validated', () => {
      expect(() => toInterval('')).toThrow(/empty interval/);
      expect(() => toInterval({})).toThrow(/no parts/);
      expect(() => toInterval({ days: NaN })).toThrow(/finite number/);
      expect(() => toInterval(5 as any)).toThrow(/expects interval text/);
    });

    test('adding and subtracting intervals', () => {
      expect(build(addInterval(placedAt, '1 day'))).toEqual({
        sql: '("expr_shelves"."placed_at" + CAST($1 AS interval))',
        params: ['1 day'],
      });
      expect(build(subInterval(placedAt, { hours: 2 }))).toEqual({
        sql: '("expr_shelves"."placed_at" - CAST($1 AS interval))',
        params: ['2 hours'],
      });
    });

    test('refs stay visible', () => {
      expect(atTimeZone(placedTz, zone).getFieldRefs()).toEqual([placedTz, zone]);
    });
  });

  describe('against the database', () => {
    let fixture: ExpressionFixture;

    beforeAll(async () => {
      fixture = await createExpressionFixture();
    });

    afterAll(async () => {
      await disposeExpressionFixture(fixture);
    });

    const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
    const minute = 'YYYY-MM-DD HH24:MI';

    test('to_char, date_trunc and EXTRACT on a timestamp', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          text: toChar(s.placedAt, minute),
          month: toChar(dateTrunc('month', s.placedAt), minute),
          week: toChar(dateTrunc('week', s.placedAt), minute),
          isoDow: datePart('isodow', s.placedAt),
          hour: datePart('hour', s.placedAt),
          epoch: datePart('epoch', s.placedAt),
        }))
        .toList());

      expect(rows).toEqual([
        {
          id: 1, text: '2024-03-10 23:30', month: '2024-03-01 00:00', week: '2024-03-04 00:00',
          isoDow: 7, hour: 23, epoch: Date.UTC(2024, 2, 10, 23, 30) / 1000,
        },
        {
          id: 2, text: '2024-07-01 08:15', month: '2024-07-01 00:00', week: '2024-07-01 00:00',
          isoDow: 1, hour: 8, epoch: Date.UTC(2024, 6, 1, 8, 15) / 1000,
        },
        { id: 3, text: null, month: null, week: null, isoDow: null, hour: null, epoch: null },
      ] as any);
    });

    test('UTC wall time → local wall time in a named zone (DST-aware)', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.placedAt))
        .select(s => ({ id: s.id, vienna: toChar(atTimeZone(atTimeZone(s.placedAt, 'UTC'), 'Europe/Vienna'), minute) }))
        .toList());

      // March: CET (+1); July: CEST (+2)
      expect(rows.map(r => r.vienna)).toEqual(['2024-03-11 00:30', '2024-07-01 10:15']);
    });

    test('the zone can come from a navigation column', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.placedAt))
        .select(s => ({ id: s.id, local: toChar(atTimeZone(atTimeZone(s.placedAt, 'UTC'), s.library!.timeZone), minute) }))
        .toList());

      // Vienna in March (+1), Lisbon in July (WEST, +1)
      expect(rows.map(r => r.local)).toEqual(['2024-03-11 00:30', '2024-07-01 09:15']);
      expect(fixture.lastStatement()).toContain('JOIN "expr_libraries"');
    });

    test('date_trunc in a zone', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.placedTz))
        .select(s => ({ id: s.id, startOfLocalDay: toChar(atTimeZone(dateTrunc('day', s.placedTz, 'Europe/Vienna'), 'UTC'), minute) }))
        .toList());

      expect(rows.map(r => r.startOfLocalDay)).toEqual(['2024-03-10 23:00', '2024-06-30 22:00']);
    });

    test('interval arithmetic', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.placedAt))
        .select(s => ({
          id: s.id,
          later: toChar(addInterval(s.placedAt, '1 day 2 hours'), minute),
          earlier: toChar(subInterval(s.placedAt, { minutes: 30 }), minute),
          nextMonth: toChar(addInterval(s.placedAt, { months: 1 }), minute),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, later: '2024-03-12 01:30', earlier: '2024-03-10 23:00', nextMonth: '2024-04-10 23:30' },
        { id: 2, later: '2024-07-02 10:15', earlier: '2024-07-01 07:45', nextMonth: '2024-08-01 08:15' },
      ] as any);
    });

    test('interval values', async () => {
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(() => ({
          hours: castAsString(toInterval({ hours: 36 })),
          mixed: castAsString(toInterval('1 day 2 hours')),
        }))
        .firstOrDefault();

      expect(row).toEqual({ hours: '36:00:00', mixed: '1 day 02:00:00' } as any);
    });

    test('the database clock', async () => {
      const before = Date.now() / 1000;
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(() => ({
          nowEpoch: datePart('epoch', currentTimestamp()),
          utcEpoch: datePart('epoch', atTimeZone(utcTimestamp(), 'UTC')),
          today: currentDate(),
          local: localTimestamp(),
        }))
        .firstOrDefault();
      const after = Date.now() / 1000;

      expect(row!.nowEpoch).toBeGreaterThan(before - 120);
      expect(row!.nowEpoch).toBeLessThan(after + 120);
      expect(Math.abs(row!.utcEpoch - row!.nowEpoch)).toBeLessThan(1);
      expect(row!.today).toBeInstanceOf(Date);
      expect(row!.local).toBeInstanceOf(Date);
    });

    test('in WHERE: older than a day before now', async () => {
      const rows = await fixture.db.shelves
        .where(s => lt(s.placedAt, subInterval(utcTimestamp(), { days: 1 })))
        .select(s => ({ name: s.name }))
        .toList();

      expect(rows.map(r => r.name).sort()).toEqual(['History', 'Poetry']);
    });

    test('in WHERE: by local weekday', async () => {
      const rows = await fixture.db.shelves
        .where(s => eq(datePart('isodow', atTimeZone(atTimeZone(s.placedAt, 'UTC'), 'Europe/Vienna')), 1))
        .select(s => ({ name: s.name }))
        .toList();

      // 2024-03-10 23:30 UTC is Monday 00:30 in Vienna; 2024-07-01 is a Monday as well
      expect(rows.map(r => r.name).sort()).toEqual(['History', 'Poetry']);
    });

    test('as an UPDATE value', async () => {
      await fixture.db.shelves
        .where(s => eq(s.id, 2))
        .update(s => ({ placedAt: addInterval(s.placedAt, { hours: 1 }) }));

      const row = await fixture.db.shelves.where(s => eq(s.id, 2)).select(s => ({ t: toChar(s.placedAt, minute) })).firstOrDefault();
      expect(row).toEqual({ t: '2024-07-01 09:15' } as any);

      await fixture.db.shelves
        .where(s => gt(s.id, 1))
        .update(s => ({ placedAt: subInterval(s.placedAt, { hours: 1 }) }));
    });
  });
});
