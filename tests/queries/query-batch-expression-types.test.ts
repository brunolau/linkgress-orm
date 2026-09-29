import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import {
  agg,
  atTimeZone,
  bigint,
  bigserial,
  cast,
  castAsBigInt,
  castAsDate,
  coalesce,
  createCustomType,
  DatabaseClient,
  date,
  dateTrunc,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  FutureCountQuery,
  FutureQuery,
  FutureSingleQuery,
  integer,
  json,
  lower,
  numeric,
  QueryBatch,
  round,
  serial,
  sql,
  text,
  timestamp,
  timestamptz,
  unnest,
  varchar,
} from '../../src';
import type { BatchItemKey, BatchListKey } from '../../src';
import { createFreshClient } from '../utils/test-database';

/**
 * A plain select's values whose SQL type only PostgreSQL knows — an expression (`dateTrunc()`,
 * `castAsDate()`, `castAsBigInt()`, a raw `sql`, `coalesce()`, `atTimeZone()`, an `agg.min` / `agg.max`), a
 * scalar subquery, a collection's MIN / MAX, a column of a CTE or of a set — through a QueryBatch: the
 * batch reads each one exactly as the query's own `toList()` / `firstOrDefault()` reads it (value, JS
 * type, row shape), in ONE round trip. They used to arrive as their JSON form — a Date as its ISO
 * text, an int8 as a JSON number.
 *
 * The envelope pins: a branch with no value to send as its text (declared columns of types JSON carries,
 * declared date / timestamp columns — revived as in 1.0.10 — counts, sums, conditions, expressions read
 * as a type JSON carries as the drivers deliver it) is sent exactly as in 1.0.10, byte for byte; a branch
 * with any sends its rows as `row_to_json`, the texts of the values that need one alongside and their
 * types ONCE for the branch, over its query fenced by `OFFSET 0` (evaluated once per row). A read-typed
 * expression (`withReadType`) travels as a column of the type it declares: the client parses it as it
 * parses such a column. The json documents of such a branch — `\u0000`, a lone surrogate, their key order —
 * arrive as standalone.
 *
 * A small weather network (defined here):
 *
 *   station      altitude  serial no          commissioned on
 *   North Ridge  1250.50   9007199254740993   2019-04-01
 *   Harbor         12.25   42                 2021-09-15
 *
 *   reading  station      taken at             logged at (UTC)    pressure  pulses            note
 *   R1       North Ridge  2024-03-01 06:00:00  2024-03-01 05:00   1013.25   9007199254740993  calm
 *   R2       North Ridge  2024-03-01 18:30:00  2024-03-01 17:30   1009.50   12                gusty
 *   R3       Harbor       2024-03-02 07:15:00  2024-03-02 06:15   1016.00   7                 fog
 *   R4       Harbor       2024-03-03 12:00:00  -                  1011.75   12                -
 *
 * A reading's `details` is a `json` document (R1 `{"b":1,"a":2}`, R2 one holding `\u0000` and a lone
 * surrogate, R3 a nested one, R4 none). A gauge has a `bigserial` id, columns read through a pass-through
 * custom type of a parameterised or aliased type — `numeric(12,2)`, `timestamp(3)`, `timestamp with time
 * zone` — and of plain `timestamp`, and a `json` memo (the first gauge's `{"b":1,"a":2}`, the second's
 * holding `\u0000` and a lone surrogate). Two domains: `wxb_day` over date, `wxb_tally` over bigint.
 */

class WxbStation extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  altitude!: DbColumn<number>;
  serialNo!: DbColumn<string>;
  commissionedOn!: DbColumn<Date>;

  readings?: WxbReading[];
}

class WxbReading extends DbEntity {
  id!: DbColumn<number>;
  stationId!: DbColumn<number>;
  takenAt!: DbColumn<Date>;
  loggedAt?: DbColumn<Date | null>;
  pressure!: DbColumn<number>;
  pulses!: DbColumn<string>;
  note?: DbColumn<string | null>;
  details?: DbColumn<unknown>;

  station?: WxbStation;
}

/** A column's driver value, unchanged — what an app that configures parser pass-through reads. */
const passThrough = <T>(dataType: string) => createCustomType<{ data: T; driverData: T }>({
  dataType: () => dataType,
  toDriver: (value: T | null | undefined) => value as T,
  fromDriver: (value: T | null | undefined) => value as T,
});

class WxbGauge extends DbEntity {
  id!: DbColumn<string>;
  level!: DbColumn<string>;
  calibratedAt!: DbColumn<unknown>;
  syncedAt!: DbColumn<unknown>;
  checkedAt!: DbColumn<unknown>;
  memo?: DbColumn<unknown>;
}

class WeatherDatabase extends DbContext {
  get stations(): DbEntityTable<WxbStation> {
    return this.table(WxbStation);
  }

  get readings(): DbEntityTable<WxbReading> {
    return this.table(WxbReading);
  }

  get gauges(): DbEntityTable<WxbGauge> {
    return this.table(WxbGauge);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(WxbStation, entity => {
      entity.toTable('wxb_stations');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.altitude).hasType(numeric('altitude', 8, 2)).isRequired();
      entity.property(e => e.serialNo).hasType(bigint('serial_no')).isRequired();
      entity.property(e => e.commissionedOn).hasType(date('commissioned_on')).isRequired();

      entity.hasMany(e => e.readings, () => WxbReading)
        .withForeignKey(r => r.stationId)
        .withPrincipalKey(s => s.id);
    });

    model.entity(WxbReading, entity => {
      entity.toTable('wxb_readings');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.stationId).hasType(integer('station_id')).isRequired();
      entity.property(e => e.takenAt).hasType(timestamp('taken_at')).isRequired();
      entity.property(e => e.loggedAt).hasType(timestamptz('logged_at'));
      entity.property(e => e.pressure).hasType(numeric('pressure', 8, 2)).isRequired();
      entity.property(e => e.pulses).hasType(bigint('pulses')).isRequired();
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.details).hasType(json('details'));

      entity.hasOne(e => e.station, () => WxbStation)
        .withForeignKey(r => r.stationId)
        .withPrincipalKey(s => s.id);
    });

    model.entity(WxbGauge, entity => {
      entity.toTable('wxb_gauges');
      entity.property(e => e.id).hasType(bigserial('id')).isPrimaryKey();
      entity.property(e => e.level).hasType(numeric('level')).hasCustomMapper(passThrough<string>('numeric(12,2)')).isRequired();
      entity.property(e => e.calibratedAt).hasType(timestamp('calibrated_at')).hasCustomMapper(passThrough<unknown>('timestamp(3)')).isRequired();
      entity.property(e => e.syncedAt).hasType(timestamptz('synced_at')).hasCustomMapper(passThrough<unknown>('timestamp with time zone')).isRequired();
      entity.property(e => e.checkedAt).hasType(timestamp('checked_at')).hasCustomMapper(passThrough<unknown>('timestamp')).isRequired();
      entity.property(e => e.memo).hasType(json('memo'));
    });
  }
}

const TABLES = ['wxb_gauges', 'wxb_readings', 'wxb_stations'];
const DOMAINS = ['wxb_day', 'wxb_tally'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  for (const domain of DOMAINS) {
    await client.query(`DROP DOMAIN IF EXISTS ${domain} CASCADE`);
  }
};

interface WeatherIds {
  north: number;
  harbor: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
}

/**
 * R2's lone surrogate: PostgreSQL keeps it in a `json` document (json stores its text as given); the
 * in-memory engine refuses it (`invalid input syntax for type json`), so there R2 holds the \u0000 alone.
 */
const LONE_SURROGATE: { odd?: string } = process.env.LINKGRESS_TEST_DB === 'memory' ? {} : { odd: '\ud800' };

const seedWeather = async (db: WeatherDatabase): Promise<WeatherIds> => {
  // A date binds as its 'YYYY-MM-DD' text and a timestamp WITHOUT time zone as its wall-clock text,
  // so every driver stores exactly these values whatever the process time zone is
  const day = (value: string) => value as unknown as Date;

  const [north, harbor] = await db.stations.insertBulk([
    { name: 'North Ridge', altitude: 1250.5, serialNo: '9007199254740993', commissionedOn: day('2019-04-01') },
    { name: 'Harbor', altitude: 12.25, serialNo: '42', commissionedOn: day('2021-09-15') },
  ]).returning();

  const [r1, r2, r3, r4] = await db.readings.insertBulk([
    { stationId: north.id, takenAt: day('2024-03-01 06:00:00'), loggedAt: new Date('2024-03-01T05:00:00Z'), pressure: 1013.25, pulses: '9007199254740993', note: 'calm', details: { b: 1, a: 2 } },
    { stationId: north.id, takenAt: day('2024-03-01 18:30:00'), loggedAt: new Date('2024-03-01T17:30:00Z'), pressure: 1009.5, pulses: '12', note: 'gusty', details: { text: 'nul\u0000here', ...LONE_SURROGATE } },
    { stationId: harbor.id, takenAt: day('2024-03-02 07:15:00'), loggedAt: new Date('2024-03-02T06:15:00Z'), pressure: 1016, pulses: '7', note: 'fog', details: { nested: { z: 1, y: 2 } } },
    { stationId: harbor.id, takenAt: day('2024-03-03 12:00:00'), loggedAt: null, pressure: 1011.75, pulses: '12', note: null, details: null },
  ]).returning();

  await db.gauges.insertBulk([
    { level: '1250.50', calibratedAt: day('2024-03-01 06:00:00.123'), syncedAt: new Date('2024-03-01T05:00:00Z'), checkedAt: day('2024-03-01 06:00:00'), memo: { b: 1, a: 2 } },
    { level: '12.25', calibratedAt: day('2024-03-02 07:15:00.5'), syncedAt: new Date('2024-03-02T06:15:00Z'), checkedAt: day('2024-03-02 07:15:00'), memo: { text: 'nul\u0000here', ...LONE_SURROGATE } },
  ]);

  return { north: north.id, harbor: harbor.id, r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id };
};

/** A date as the drivers read it: local midnight of that day. */
const localDay = (value: string): Date => {
  const [year, month, dayOfMonth] = value.split('-').map(Number);

  return new Date(year, month - 1, dayOfMonth);
};

/** A timestamp-without-time-zone value as the drivers read it: that wall-clock time, local. */
const localTime = (value: string): Date => new Date(value.replace(' ', 'T'));

/**
 * Deep equality that also asserts every leaf's JS type (a Date stays a Date, text stays text) and the
 * key order of every row and of every object in it (a nested object, a json document, a collection's item).
 */
const expectSameShape = (batched: unknown, standalone: unknown, path = '$'): void => {
  if (standalone === null || standalone === undefined) {
    expect({ path, value: batched }).toEqual({ path, value: standalone });

    return;
  }

  expect({ path, type: typeof batched }).toEqual({ path, type: typeof standalone });

  if (typeof standalone !== 'object') {
    expect({ path, value: batched }).toEqual({ path, value: standalone });

    return;
  }

  expect({ path, constructor: (batched as object).constructor }).toEqual({ path, constructor: (standalone as object).constructor });

  if (standalone instanceof Date) {
    expect({ path, time: (batched as Date).getTime() }).toEqual({ path, time: standalone.getTime() });

    return;
  }

  if (Array.isArray(standalone)) {
    expect({ path, length: (batched as unknown[]).length }).toEqual({ path, length: standalone.length });
    standalone.forEach((item, ix) => expectSameShape((batched as unknown[])[ix], item, `${path}[${ix}]`));

    return;
  }

  if (standalone instanceof Uint8Array) {
    expect({ path, bytes: Array.from(batched as Uint8Array) }).toEqual({ path, bytes: Array.from(standalone) });

    return;
  }

  expect({ path, keys: Object.keys(batched as object) }).toEqual({ path, keys: Object.keys(standalone) });
  const standaloneKeys = Object.keys(standalone);

  for (const key of standaloneKeys) {
    expectSameShape((batched as any)[key], (standalone as any)[key], `${path}.${key}`);
  }
};

/** A query a batch lists (a select, a union). */
interface Listable {
  future(): FutureQuery<any>;
  toList(): Promise<any[]>;
}

/** A query a batch lists, reads the first row of, and counts. */
interface Batchable extends Listable {
  futureFirstOrDefault(): FutureSingleQuery<any>;
  futureCount(): FutureCountQuery;
  firstOrDefault(): Promise<any>;
}

/**
 * The pieces of the envelope of a branch that sends texts (spelled out in full once, in 'the envelope'):
 * the types whose values the server sends as their text for a client without parsers of its own (a date /
 * time / timestamp / interval, money, bytea, point and circle are rebuilt from their JSON form — a date /
 * timestamp / timestamptz only under DateStyle ISO), a column of the branch's row, the per-row test whether
 * its type needs the text (its FILTER asks for the DateStyle once per row), and the header of the branch's types.
 */
const TEXT_TYPES = '\'{20,1700,1182,1183,1270,1115,1185,1187,1016,1231,791,1001,1017,719}\'::oid[]';
const ISO_DATE_STYLE = '(SELECT current_setting(\'DateStyle\') LIKE \'ISO%\')';
const batchColumn = (name: string): string => `(__batch_q."${name}")`;
const needsServerText = (name: string): string => `pg_typeof(${batchColumn(name)})::oid = ANY(${TEXT_TYPES}) OR pg_typeof(${batchColumn(name)})::oid >= 16384`;
const dateStyled = (name: string): string => `pg_typeof(${batchColumn(name)})::oid = ANY('{1082,1114,1184}'::oid[])`;
const needsText = (name: string): string => `(${needsServerText(name)} OR (NOT ${ISO_DATE_STYLE} AND ${dateStyled(name)}))`;
// A value's texts, one per row: when its type needs them (its FILTER, constant for the value), or always (a text column)
const textWhenNeeded = (name: string): string => `json_agg(concat(${batchColumn(name)})) FILTER (WHERE ${needsText(name)})`;
const textAlways = (name: string): string => `json_agg(concat(${batchColumn(name)}))`;
// Each value's type, and the type each of them that is a domain the server sends the text of is over — a
// user-defined one, for a client without parsers of its own: one catalog lookup for the branch
const TYPE_HEADER = '\'t\', to_json(__batch_s.t::bigint[]), '
  + '\'d\', (SELECT json_object_agg(__batch_t.oid, __batch_t.typbasetype::bigint) FROM pg_catalog.pg_type __batch_t '
  + 'WHERE __batch_t.oid = ANY(__batch_s.t) AND __batch_t.typtype = \'d\' AND (__batch_t.oid >= 16384))';

/**
 * The fenced envelope of branch `ix` running `sql`: its rows (the whole row, `__batch_q.*`), `texts` — the
 * aggregate of each value's texts (see textWhenNeeded / textAlways), in ONE array — and the types of `columns`,
 * once, in another.
 */
const fencedEnvelope = (ix: number, sql: string, texts: string[], columns: string[]): string =>
  `SELECT ${ix} AS __batch_ix, json_build_object(${TYPE_HEADER}, 'r', __batch_s.r, 'x', to_json(__batch_s.x)) AS __batch_items `
  + `FROM (SELECT coalesce(json_agg(__batch_q.*), '[]'::json) AS r, ARRAY[${texts.join(', ')}] AS x, `
  + `ARRAY[${columns.map(name => `min(pg_typeof(${batchColumn(name)})::oid)`).join(', ')}] AS t `
  + `FROM (SELECT * FROM (\n${sql}\n) __batch_q0 OFFSET 0) __batch_q) __batch_s`;

describe('a plain select\'s untyped values in a QueryBatch', () => {
  let db: WeatherDatabase;
  let client: DatabaseClient;
  let ids: WeatherIds;
  const captured: string[] = [];

  beforeAll(async () => {
    client = createFreshClient();
    db = new WeatherDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });

    await dropTables(client);
    await client.query('CREATE DOMAIN wxb_day AS date');
    await client.query('CREATE DOMAIN wxb_tally AS bigint');
    await db.getSchemaManager().ensureCreated();
    ids = await seedWeather(db);
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  /** Executes the batch, asserting ONE round trip — one statement. Returns its SQL. */
  const executeInOneRoundTrip = async (batch: QueryBatch): Promise<string> => {
    const querySpy = jest.spyOn(client, 'query');
    captured.length = 0;

    try {
      await batch.executeBatch();

      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }

    const logged = captured.filter(entry => !entry.trimStart().startsWith('['));
    expect(logged).toHaveLength(1);

    return logged[0];
  };

  /**
   * Runs the query standalone, then — built afresh — through a batch of its own in one round trip:
   * identical values, JS types and row key order. Returns the standalone result, for the test to pin.
   */
  const expectBatchedLikeStandalone = async <T>(build: () => Listable, kind: 'list' | 'first' = 'list'): Promise<T> => {
    const standalone = kind === 'list' ? await build().toList() : await (build() as Batchable).firstOrDefault();

    const batch = new QueryBatch();
    const key = kind === 'list' ? batch.addList(build(), 'probe') : batch.addFirstOrDefault(build() as Batchable, 'probe');
    await executeInOneRoundTrip(batch);
    const batched = kind === 'list' ? batch.getList(key as BatchListKey<unknown>) : batch.getItem(key as BatchItemKey<unknown>);

    expect(batched).toEqual(standalone);
    expectSameShape(batched, standalone);

    return standalone as T;
  };

  describe('expressions of a known SQL type the batch could not see', () => {
    test('dateTrunc(): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, day: dateTrunc('day', r.takenAt) }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.day)).toEqual([
        localTime('2024-03-01 00:00:00'),
        localTime('2024-03-01 00:00:00'),
        localTime('2024-03-02 00:00:00'),
        localTime('2024-03-03 00:00:00'),
      ]);
    });

    test('castAsDate(): Dates (local midnight)', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, day: castAsDate(r.takenAt) }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.day)).toEqual([localDay('2024-03-01'), localDay('2024-03-01'), localDay('2024-03-02'), localDay('2024-03-03')]);
    });

    test('castAsBigInt(): the driver\'s exact int8 text, also beyond 2^53', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, big: castAsBigInt(r.id), pulses: castAsBigInt(sql`${r.pulses} + 0`) }))
        .orderBy(r => r.id));

      expect(rows.map(r => [r.big, r.pulses])).toEqual([
        [String(ids.r1), '9007199254740993'],
        [String(ids.r2), '12'],
        [String(ids.r3), '7'],
        [String(ids.r4), '12'],
      ]);
    });

    test('an untyped sql over a timestamp: Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, later: sql<Date>`${r.takenAt} + interval '1 hour'` }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.later)).toEqual([
        localTime('2024-03-01 07:00:00'),
        localTime('2024-03-01 19:30:00'),
        localTime('2024-03-02 08:15:00'),
        localTime('2024-03-03 13:00:00'),
      ]);
    });

    test('an untyped sql over a numeric: a number — as before', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, doubled: sql<number>`${r.pressure} * 2` }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.doubled)).toEqual([2026.5, 2019, 2032, 2023.5]);
    });

    test('an untyped sql over a bigint: a number — as before', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, next: sql<number>`${r.pulses} + 1` }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.next)).toEqual([9007199254740994, 13, 8, 13]);
    });

    test('coalesce() and atTimeZone() over timestamps: Dates, NULL kept', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, logged: coalesce(r.loggedAt, r.loggedAt), utcWall: atTimeZone(r.loggedAt, 'UTC') }))
        .orderBy(r => r.id));

      expect(rows.slice(0, 3).map(r => [(r.logged as Date).toISOString(), r.utcWall])).toEqual([
        ['2024-03-01T05:00:00.000Z', localTime('2024-03-01 05:00:00')],
        ['2024-03-01T17:30:00.000Z', localTime('2024-03-01 17:30:00')],
        ['2024-03-02T06:15:00.000Z', localTime('2024-03-02 06:15:00')],
      ]);
      expect([rows[3].logged ?? null, rows[3].utcWall ?? null]).toEqual([null, null]);
    });

    test('a nested object\'s expression: a Date in its place', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, when: { day: dateTrunc('day', r.takenAt), at: r.takenAt } }))
        .orderBy(r => r.id));

      expect(rows[0].when).toEqual({ day: localTime('2024-03-01 00:00:00'), at: localTime('2024-03-01 06:00:00') });
    });

    test('a selector returning ONE expression: its Dates', async () => {
      const days = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .where(r => eq(r.stationId, ids.harbor))
        .orderBy(r => r.id)
        .select(r => dateTrunc('day', r.takenAt)));

      expect(days).toEqual([localTime('2024-03-02 00:00:00'), localTime('2024-03-03 00:00:00')]);
    });

    test('selectDistinct() of an expression: Dates', async () => {
      const days = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .selectDistinct(r => ({ day: castAsDate(r.takenAt) }))
        .orderBy(r => r.day));

      expect(days).toEqual([{ day: localDay('2024-03-01') }, { day: localDay('2024-03-02') }, { day: localDay('2024-03-03') }]);
    });

    test('a UNION ALL of legs with expressions: Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .where(r => eq(r.stationId, ids.north))
        .select(r => ({ id: r.id, day: dateTrunc('day', r.takenAt) }))
        .unionAll(db.readings.where(r => eq(r.stationId, ids.harbor)).select(r => ({ id: r.id, day: dateTrunc('day', r.takenAt) })))
        .orderBy((r: any) => r.id));

      expect(rows.map(r => r.day)).toEqual([
        localTime('2024-03-01 00:00:00'),
        localTime('2024-03-01 00:00:00'),
        localTime('2024-03-02 00:00:00'),
        localTime('2024-03-03 00:00:00'),
      ]);
    });
  });

  describe('aggregates, subqueries and collections', () => {
    test('a correlated collection MAX / MIN of timestamps: Dates; its COUNT and SUM: numbers', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({
          id: s.id,
          lastTaken: s.readings!.max(r => r.takenAt),
          firstLogged: s.readings!.min(r => r.loggedAt),
          readings: s.readings!.count(),
          pulses: s.readings!.sum(r => r.pulses),
        }))
        .orderBy(s => s.id));

      expect(rows).toEqual([
        { id: ids.north, lastTaken: localTime('2024-03-01 18:30:00'), firstLogged: new Date('2024-03-01T05:00:00Z'), readings: 2, pulses: 9007199254741005 },
        { id: ids.harbor, lastTaken: localTime('2024-03-03 12:00:00'), firstLogged: new Date('2024-03-02T06:15:00Z'), readings: 2, pulses: 19 },
      ]);
    });

    test('a whole-set agg.max / agg.min of timestamps: Dates; agg.count / agg.sum: numbers', async () => {
      const row = await expectBatchedLikeStandalone<any>(() => db.readings
        .select(r => ({ last: agg.max(r.takenAt), first: agg.min(r.loggedAt), n: agg.count(), total: agg.sum(r.pulses) })), 'first');

      expect(row).toEqual({
        last: localTime('2024-03-03 12:00:00'),
        first: new Date('2024-03-01T05:00:00Z'),
        n: 4,
        total: 9007199254741024,
      });
    });

    test('agg.arrayAgg() of timestamps, int8s and numerics: each array as the client delivers it standalone', async () => {
      const row = await expectBatchedLikeStandalone<any>(() => db.readings
        .select(r => ({
          taken: agg.arrayAgg(r.takenAt, { orderBy: [[r.id, 'ASC']] }),
          pulses: agg.arrayAgg(r.pulses, { orderBy: [[r.id, 'ASC']] }),
          pressures: agg.arrayAgg(r.pressure, { orderBy: [[r.id, 'ASC']] }),
        })), 'first');

      expect([row.taken.length, row.pulses.length, row.pressures.length]).toEqual([4, 4, 4]);
    });

    test('a collection MAX in a nested object: a Date in its place, the nested object in its own key order', async () => {
      const build = () => db.stations
        .select(s => ({ id: s.id, stats: { lastTaken: s.readings!.max(r => r.takenAt), readings: s.readings!.count() } }))
        .orderBy(s => s.id);
      const rows = await expectBatchedLikeStandalone<any[]>(build);

      expect(rows).toEqual([
        { id: ids.north, stats: { lastTaken: localTime('2024-03-01 18:30:00'), readings: 2 } },
        { id: ids.harbor, stats: { lastTaken: localTime('2024-03-03 12:00:00'), readings: 2 } },
      ]);

      const batch = new QueryBatch();
      const key = batch.addList(build(), 'nested');
      await executeInOneRoundTrip(batch);
      expect(batch.getList(key).map(row => Object.keys(row.stats))).toEqual(rows.map(row => Object.keys(row.stats)));
      expect(Object.keys(rows[0].stats)).toEqual(['lastTaken', 'readings']);
    });

    test('a scalar subquery of an aggregate: Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({
          id: s.id,
          lastTaken: db.readings.where(r => eq(r.stationId, s.id)).select(r => agg.max(r.takenAt)).asSubquery('scalar'),
        }))
        .orderBy(s => s.id));

      expect(rows.map(r => r.lastTaken)).toEqual([localTime('2024-03-01 18:30:00'), localTime('2024-03-03 12:00:00')]);
    });

    test('a scalar subquery of a column: Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({
          id: s.id,
          firstLogged: db.readings.where(r => eq(r.stationId, s.id)).orderBy(r => r.id).limit(1).select(r => r.loggedAt).asSubquery('scalar'),
        }))
        .orderBy(s => s.id));

      expect(rows.map(r => (r.firstLogged as Date).toISOString())).toEqual(['2024-03-01T05:00:00.000Z', '2024-03-02T06:15:00.000Z']);
    });
  });

  describe('columns of a CTE and of a set', () => {
    test('a CTE\'s timestamp column: Dates', async () => {
      const takenTimes = () => new DbCteBuilder().with(
        'wxb_taken_times',
        db.readings.select(r => ({ timeStationId: r.stationId, lastAt: r.takenAt }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .leftJoin(takenTimes(), (s, t) => eq(s.id, t.timeStationId), (s, t) => ({ id: s.id, lastAt: t.lastAt }))
        .orderBy(r => [r.id, r.lastAt]));

      expect(rows.map(r => r.lastAt)).toEqual([
        localTime('2024-03-01 06:00:00'),
        localTime('2024-03-01 18:30:00'),
        localTime('2024-03-02 07:15:00'),
        localTime('2024-03-03 12:00:00'),
      ]);
    });

    test('a CTE\'s text column named like a timestamp column of the query\'s table: its text, never a Date', async () => {
      const labels = () => new DbCteBuilder().with(
        'wxb_station_labels',
        db.stations.select(s => ({ labelStationId: s.id, takenAt: s.name }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(labels(), (r, l) => eq(r.stationId, l.labelStationId), (r, l) => ({ id: r.id, takenAt: l.takenAt }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.takenAt)).toEqual(['North Ridge', 'North Ridge', 'Harbor', 'Harbor']);
    });

    test('a CTE\'s numeric and bigint columns, and cast(…, \'numeric\'): as standalone', async () => {
      const gauges = () => new DbCteBuilder().with(
        'wxb_station_gauges',
        db.stations.select(s => ({ gaugeStationId: s.id, altitude: s.altitude, serialNo: s.serialNo }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(gauges(), (r, g) => eq(r.stationId, g.gaugeStationId), (r, g) => ({
          id: r.id,
          altitude: g.altitude,
          serialNo: g.serialNo,
          exact: cast<string>(r.pressure, 'numeric'),
        }))
        .orderBy(r => r.id));

      expect(rows.map(r => [r.altitude, r.serialNo, r.exact])).toEqual([
        [1250.5, 9007199254740992, '1013.25'],
        [1250.5, 9007199254740992, '1009.50'],
        [12.25, 42, '1016.00'],
        [12.25, 42, '1011.75'],
      ]);
    });

    test('a CTE\'s bigint literal: the exact BigInt, also beyond 2^53', async () => {
      const marks = () => new DbCteBuilder().with(
        'wxb_station_marks',
        db.stations.select(s => ({ markStationId: s.id, mark: 9007199254740993n }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(marks(), (r, m) => eq(r.stationId, m.markStationId), (r, m) => ({ id: r.id, mark: m.mark }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.mark)).toEqual([9007199254740993n, 9007199254740993n, 9007199254740993n, 9007199254740993n]);
    });

    test('a set\'s date column (crossJoinLateral over unnest): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .crossJoinLateral(() => unnest(['2024-03-01', '2024-03-02'], 'date'), (s, d) => ({ id: s.id, day: d.value }), 'd')
        .orderBy(r => [r.id, r.day]));

      expect(rows.map(r => r.day)).toEqual([localDay('2024-03-01'), localDay('2024-03-02'), localDay('2024-03-01'), localDay('2024-03-02')]);
    });
  });

  describe('read-typed expressions (withReadType): parsed by the client as a column of the type they declare', () => {
    test('withReadType(\'date\'): Dates (local midnight)', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, day: sql<Date>`CAST(${r.takenAt} AS date)`.withReadType('date') }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.day)).toEqual([localDay('2024-03-01'), localDay('2024-03-01'), localDay('2024-03-02'), localDay('2024-03-03')]);
    });

    test('withReadType(\'timestamp\'): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, later: sql<Date>`${r.takenAt} + interval '1 hour'`.withReadType('timestamp') }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.later)).toEqual([
        localTime('2024-03-01 07:00:00'),
        localTime('2024-03-01 19:30:00'),
        localTime('2024-03-02 08:15:00'),
        localTime('2024-03-03 13:00:00'),
      ]);
    });

    test('withReadType(\'timestamptz\'): Dates, NULL kept', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, logged: sql<Date>`${r.loggedAt}`.withReadType('timestamptz') }))
        .orderBy(r => r.id));

      expect(rows.slice(0, 3).map(r => (r.logged as Date).toISOString())).toEqual([
        '2024-03-01T05:00:00.000Z',
        '2024-03-01T17:30:00.000Z',
        '2024-03-02T06:15:00.000Z',
      ]);
      expect(rows[3].logged ?? null).toBeNull();
    });

    test('withReadType(\'bytea\'): Buffers, NULL kept', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, raw: sql<Buffer>`CAST(${r.note} AS bytea)`.withReadType('bytea') }))
        .orderBy(r => r.id));

      expect(rows.slice(0, 3).map(r => Buffer.from(r.raw as Uint8Array).toString('utf8'))).toEqual(['calm', 'gusty', 'fog']);
      expect(rows[3].raw ?? null).toBeNull();
    });

    test('withReadType(\'bigint\') / (\'numeric\'): numbers, as standalone — sent as their exact text in the fenced envelope', async () => {
      const build = () => db.readings
        .select(r => ({ id: r.id, pulses: sql<number>`${r.pulses}`.withReadType('bigint'), pressure: sql<number>`${r.pressure}`.withReadType('numeric') }))
        .orderBy(r => r.id);
      const rows = await expectBatchedLikeStandalone<any[]>(build);

      expect(rows.map(r => [r.pulses, r.pressure])).toEqual([
        [9007199254740992, 1013.25],
        [12, 1009.5],
        [7, 1016],
        [12, 1011.75],
      ]);

      const batch = new QueryBatch();
      batch.addList(build(), 'numbers');
      const statement = await executeInOneRoundTrip(batch);
      expect(statement).toBe(fencedEnvelope(
        0,
        build().future().getSql(),
        [textWhenNeeded('pulses'), textWhenNeeded('pressure')],
        ['pulses', 'pressure']
      ));
      expect(statement).not.toContain('to_jsonb');
    });

    test('a selector returning ONE read-typed expression: its Dates', async () => {
      const days = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .where(r => eq(r.stationId, ids.harbor))
        .orderBy(r => r.id)
        .select(r => sql<Date>`CAST(${r.takenAt} AS date)`.withReadType('date')));

      expect(days).toEqual([localDay('2024-03-02'), localDay('2024-03-03')]);
    });

    test('a read-typed value in a nested object and in a UNION leg: Dates in their place', async () => {
      const nested = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, when: { day: sql<Date>`CAST(${r.takenAt} AS date)`.withReadType('date'), at: r.takenAt } }))
        .orderBy(r => r.id));

      expect(nested[0].when).toEqual({ day: localDay('2024-03-01'), at: localTime('2024-03-01 06:00:00') });

      const unioned = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .where(r => eq(r.stationId, ids.north))
        .select(r => ({ id: r.id, later: sql<Date>`${r.takenAt} + interval '1 hour'`.withReadType('timestamp') }))
        .unionAll(db.readings.where(r => eq(r.stationId, ids.harbor)).select(r => ({ id: r.id, later: sql<Date>`${r.takenAt} + interval '1 hour'`.withReadType('timestamp') })))
        .orderBy((r: any) => r.id));

      expect(unioned.map(r => r.later)).toEqual([
        localTime('2024-03-01 07:00:00'),
        localTime('2024-03-01 19:30:00'),
        localTime('2024-03-02 08:15:00'),
        localTime('2024-03-03 13:00:00'),
      ]);
    });

    test('a scalar subquery of a read-typed expression: Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({
          id: s.id,
          firstDay: db.readings.where(r => eq(r.stationId, s.id)).orderBy(r => r.id).limit(1)
            .select(r => sql<Date>`CAST(${r.takenAt} AS date)`.withReadType('date')).asSubquery('scalar'),
        }))
        .orderBy(s => s.id));

      expect(rows.map(r => r.firstDay)).toEqual([localDay('2024-03-01'), localDay('2024-03-02')]);
    });

    test('a CTE\'s read-typed expression column: Dates', async () => {
      const days = () => new DbCteBuilder().with(
        'wxb_reading_days',
        db.readings.select(r => ({ dayReadingId: r.id, day: sql<Date>`CAST(${r.takenAt} AS date)`.withReadType('date') }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(days(), (r, d) => eq(r.id, d.dayReadingId), (r, d) => ({ id: r.id, day: d.day }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.day)).toEqual([localDay('2024-03-01'), localDay('2024-03-01'), localDay('2024-03-02'), localDay('2024-03-03')]);
    });
  });

  describe('a branch with runtime-typed values sends each row as the row itself', () => {
    /** The standalone and the batched rows of one query (the batch in one round trip). */
    const readBoth = async (build: () => Listable): Promise<{ standalone: any[]; batched: any[] }> => {
      const standalone = await build().toList();
      const batch = new QueryBatch();
      const key = batch.addList(build(), 'probe');
      await executeInOneRoundTrip(batch);

      return { standalone, batched: batch.getList(key) };
    };

    test('a json value next to an untyped expression: \\u0000, a lone surrogate and its key order arrive as standalone', async () => {
      const build = () => db.readings
        .select(r => ({ id: r.id, details: r.details, quiet: lower(r.note) }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(build);
      expect([rows[0].details, rows[2].details, rows[3].details]).toEqual([{ b: 1, a: 2 }, { nested: { z: 1, y: 2 } }, null]);
      expect(rows[1].details).toEqual({ text: 'nul\u0000here', ...LONE_SURROGATE });
      expect(rows.map(r => r.quiet ?? null)).toEqual(['calm', 'gusty', 'fog', null]);

      const { standalone, batched } = await readBoth(build);
      expect(Object.keys(standalone[0].details)).toEqual(['b', 'a']);
      expect(Object.keys(batched[0].details)).toEqual(['b', 'a']);
      expect(Object.keys(batched[2].details.nested)).toEqual(['z', 'y']);
    });

    /** R1's, R2's and R3's `details` (or a gauge's memo) as standalone: key order, `\u0000`, the lone surrogate. */
    const expectDocumentsAsStandalone = (documents: unknown[]): void => {
      expect(Object.keys(documents[0] as object)).toEqual(['b', 'a']);
      expect(documents[1]).toEqual({ text: 'nul\u0000here', ...LONE_SURROGATE });
      expect(Object.keys(documents[1] as object)).toEqual(['text', ...Object.keys(LONE_SURROGATE)]);
    };

    test('json next to a manually joined table\'s int8 column: as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(db.stations, (r, s) => eq(r.stationId, s.id), (r, s) => ({ id: r.id, serialNo: s.serialNo, details: r.details }))
        .orderBy(r => r.id));

      // As a joined table's / a CTE's bigint column reads standalone: a number
      expect(rows.map(r => r.serialNo)).toEqual([9007199254740992, 9007199254740992, 42, 42]);
      expectDocumentsAsStandalone(rows.map(r => r.details));
      expect(Object.keys(rows[2].details.nested)).toEqual(['z', 'y']);
    });

    test('json next to a CTE\'s int8 column: as standalone', async () => {
      const serials = () => new DbCteBuilder().with(
        'wxb_station_serials',
        db.stations.select(s => ({ serialStationId: s.id, serialNo: s.serialNo }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .leftJoin(serials(), (r, s) => eq(r.stationId, s.serialStationId), (r, s) => ({ id: r.id, serialNo: s.serialNo, details: r.details }))
        .orderBy(r => r.id));

      // As a joined table's / a CTE's bigint column reads standalone: a number
      expect(rows.map(r => r.serialNo)).toEqual([9007199254740992, 9007199254740992, 42, 42]);
      expectDocumentsAsStandalone(rows.map(r => r.details));
    });

    test('json next to withReadType(\'bigint\'): as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, pulses: sql<number>`${r.pulses}`.withReadType('bigint'), details: r.details }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.pulses)).toEqual([9007199254740992, 12, 7, 12]);
      expectDocumentsAsStandalone(rows.map(r => r.details));
    });

    test('json next to a bigserial id, and next to a custom numeric(12,2) column: as standalone', async () => {
      const byId = await expectBatchedLikeStandalone<any[]>(() => db.gauges.select(g => ({ id: g.id, memo: g.memo })).orderBy(g => g.id));
      expect(byId.map(g => g.id)).toEqual(['1', '2']);
      expectDocumentsAsStandalone(byId.map(g => g.memo));

      const byLevel = await expectBatchedLikeStandalone<any[]>(() => db.gauges.orderBy(g => g.id).select(g => ({ level: g.level, memo: g.memo })));
      expect(byLevel.map(g => g.level)).toEqual(['1250.50', '12.25']);
      expectDocumentsAsStandalone(byLevel.map(g => g.memo));
    });

    test('a collection next to an int8 value: its items in their own key order, as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({
          id: s.id,
          serialNo: s.serialNo,
          readings: s.readings!.orderBy(r => r.id).select(r => ({ weight: r.pressure, label: r.note })).toList(),
        }))
        .orderBy(s => s.id));

      expect(rows[0].serialNo).toBe('9007199254740993');
      expect(rows.map(r => r.readings.map((item: object) => Object.keys(item)))).toEqual([[['weight', 'label'], ['weight', 'label']], [['weight', 'label'], ['weight', 'label']]]);
    });

    test('a nested object next to runtime-typed and int8 values keeps its key order; the int8 its exact text', async () => {
      const build = () => db.readings
        .select(r => ({ id: r.id, when: { zone: lower(r.note), day: dateTrunc('day', r.takenAt), big: castAsBigInt(r.pulses) } }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(build);
      expect(rows[0].when).toEqual({ zone: 'calm', day: localTime('2024-03-01 00:00:00'), big: '9007199254740993' });

      const { standalone, batched } = await readBoth(build);
      expect(batched.map(r => Object.keys(r.when))).toEqual(standalone.map(r => Object.keys(r.when)));
      expect(Object.keys(batched[0].when)).toEqual(['zone', 'day', 'big']);
    });

    /**
     * A branch as wide as 1.0.16 took: 1 662 values sent as text and the id — 1 663 columns, one fewer than the
     * 1 664 entries a PostgreSQL target list holds. The envelope may not hold more than a few entries per branch
     * of its own (one per value would halve the width; an array constructor, not a function: a function takes
     * at most 100 arguments). Seen by the lanes whose server enforces the limit — PostgreSQL through every driver,
     * and PGlite; the in-memory engine enforces neither limit, and reads the branch there as a check of its values.
     */
    test('a branch of 1 662 typed values — as wide as 1.0.16 took (a target list holds 1 664 entries, a function 100 arguments): every value as standalone, also with no rows', async () => {
      const wide = (r: any): Record<string, unknown> => {
        const row: Record<string, unknown> = { id: r.id };

        for (let i = 0; i < 1662; i++) {
          row[`v${i}`] = i % 2 === 0 ? dateTrunc('day', r.takenAt) : castAsBigInt(sql`${r.pulses} + ${i}`);
        }

        return row;
      };

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings.select(r => wide(r)).orderBy((r: any) => r.id));
      expect(rows).toHaveLength(4);
      expect(Object.keys(rows[0])).toHaveLength(1663);
      expect([rows[0].v0, rows[0].v1, rows[0].v1661]).toEqual([localTime('2024-03-01 00:00:00'), '9007199254740994', '9007199254742654']);

      const none = await expectBatchedLikeStandalone<any[]>(() => db.readings.where(r => eq(r.note, 'hail')).select(r => wide(r)));
      expect(none).toEqual([]);
    });
  });

  describe('a UNION column whose legs declare different types', () => {
    test('date ∪ timestamp: the resolved timestamp, as Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.stations
        .select(s => ({ id: s.id, at: s.commissionedOn }))
        .unionAll(db.readings.select(r => ({ id: r.id, at: r.takenAt })))
        .orderBy((r: any) => r.at));

      expect(rows.map(r => r.at)).toEqual([
        localTime('2019-04-01 00:00:00'),
        localTime('2021-09-15 00:00:00'),
        localTime('2024-03-01 06:00:00'),
        localTime('2024-03-01 18:30:00'),
        localTime('2024-03-02 07:15:00'),
        localTime('2024-03-03 12:00:00'),
      ]);
    });

    test('integer ∪ bigint: the resolved int8, as its exact text', async () => {
      const stationIds = () => db.stations.select(s => ({ n: s.id }));
      // An int8 leg: PostgreSQL resolves the union to bigint (the builder's typings want one TS type)
      const pulses = () => db.readings.select(r => ({ n: r.pulses })) as unknown as ReturnType<typeof stationIds>;

      const rows = await expectBatchedLikeStandalone<any[]>(() => stationIds()
        .unionAll(pulses())
        .orderBy((r: any) => r.n));

      expect(rows.map(r => r.n)).toEqual([String(ids.north), String(ids.harbor), '7', '12', '12', '9007199254740993']);
    });

    test('legs that agree are sent as before — no runtime type', async () => {
      const agreeing = () => db.readings
        .where(r => eq(r.stationId, ids.north))
        .select(r => ({ id: r.id, at: r.takenAt }))
        .unionAll(db.readings.where(r => eq(r.stationId, ids.harbor)).select(r => ({ id: r.id, at: r.takenAt })))
        .orderBy((r: any) => r.id);

      await expectBatchedLikeStandalone<any[]>(agreeing);

      const batch = new QueryBatch();
      batch.addList(agreeing(), 'agreeing');
      const statement = await executeInOneRoundTrip(batch);
      expect(statement).toBe(`SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${agreeing().future().getSql()}\n) __batch_q`);
    });
  });

  describe('declared columns of a parameterised or aliased type', () => {
    test('a bigserial id and a numeric(12,2) column read as their exact text, as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.gauges
        .select(g => ({ id: g.id, level: g.level }))
        .orderBy(g => g.id));

      expect(rows.map(r => [r.id, r.level])).toEqual([['1', '1250.50'], ['2', '12.25']]);
    });

    test('a timestamp(3) / timestamp with time zone column hands its mapper what the client delivers standalone; a timestamp column the text form a batch always handed it', async () => {
      const build = () => db.gauges.select(g => ({ id: g.id, calibratedAt: g.calibratedAt, syncedAt: g.syncedAt, checkedAt: g.checkedAt })).orderBy(g => g.id);
      const standalone = await build().toList();
      const batch = new QueryBatch();
      const key = batch.addList(build(), 'forms');
      await executeInOneRoundTrip(batch);
      const batched = batch.getList(key) as any[];

      // New to the batch: the client's own value, which the mapper passes through (a Date, for a client as configured by default)
      const newlyTyped = (rows: any[]) => rows.map(row => ({ id: row.id, calibratedAt: row.calibratedAt, syncedAt: row.syncedAt }));
      expectSameShape(newlyTyped(batched), newlyTyped(standalone));
      expect(batched[0].calibratedAt).toBeInstanceOf(Date);
      expect((batched[0].syncedAt as Date).toISOString()).toBe('2024-03-01T05:00:00.000Z');
      // A declared timestamp column: revived as in 1.0.10 — for a mapper, the driver's text form (the documented limit)
      expect(batched.map(row => row.checkedAt)).toEqual(['2024-03-01 06:00:00', '2024-03-02 07:15:00']);
    });
  });

  describe('a value of a domain type', () => {
    test('a domain over date and a domain over int8 read by their base type, as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, day: cast<Date>(r.takenAt, 'wxb_day'), tally: cast<string>(r.pulses, 'wxb_tally') }))
        .orderBy(r => r.id));

      expect(rows.map(r => [r.day, r.tally])).toEqual([
        [localDay('2024-03-01'), '9007199254740993'],
        [localDay('2024-03-01'), '12'],
        [localDay('2024-03-02'), '7'],
        [localDay('2024-03-03'), '12'],
      ]);
    });
  });

  describe('a mapped expression (mapWith) in a plain select', () => {
    test('its mapper gets the int8 as its exact text, as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.readings
        .select(r => ({ id: r.id, pulses: sql<bigint>`${r.pulses}`.mapWith((value: unknown) => BigInt(value as string)) }))
        .orderBy(r => r.id));

      expect(rows.map(r => r.pulses)).toEqual([9007199254740993n, 12n, 7n, 12n]);
    });

    test('its mapper gets a timestamp as the client delivers it standalone — in a grouped query\'s batch the same', async () => {
      const form = (value: unknown): string => (value instanceof Date ? `Date ${value.getTime()}` : `${typeof value} ${String(value)}`);
      const at = (takenAt: unknown) => sql<string>`${takenAt}`.withReadType('timestamp').mapWith(form);
      const plain = () => db.readings.select(r => ({ id: r.id, at: at(r.takenAt) })).orderBy(r => r.id);
      const grouped = () => db.readings
        .select(r => ({ id: r.id, at: at(r.takenAt) }))
        .groupBy(r => ({ id: r.id, at: r.at }))
        .select(g => ({ id: g.key.id, at: g.key.at }))
        .orderBy(r => r.id);

      const standalone = { plain: await plain().toList(), grouped: await grouped().toList() };
      const batch = new QueryBatch();
      const plainKey = batch.addList(plain(), 'plain');
      const groupedKey = batch.addList(grouped(), 'grouped');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(plainKey)).toEqual(standalone.plain);
      expect(batch.getList(groupedKey)).toEqual(standalone.grouped);
      // A client as configured by default delivers a timestamp as a Date
      expect((batch.getList(plainKey) as any[]).every(r => (r.at as string).startsWith('Date '))).toBe(true);
      expect((batch.getList(groupedKey) as any[]).map(r => r.at)).toEqual((batch.getList(plainKey) as any[]).map(r => r.at));
    });
  });

  describe('the envelope', () => {
    test('a branch with no value to send as its text is sent exactly as in 1.0.10, byte for byte', async () => {
      // Declared columns of types JSON carries, a declared timestamp (revived as in 1.0.10), a condition, a literal
      const build = () => db.readings
        .select(r => ({ id: r.id, at: r.takenAt, note: r.note, calm: eq(r.note, 'calm'), kind: 'reading' }))
        .orderBy(r => r.id);
      // A read type JSON carries as the drivers deliver it, and a numeric-result helper (read the same
      // from text and from a JSON number)
      const knownTyped = () => db.readings
        .select(r => ({ id: r.id, text: sql<string>`${r.note}`.withReadType('text'), rounded: round(r.pressure) }))
        .orderBy(r => r.id);

      const batch = new QueryBatch();
      const plainKey = batch.addList(build(), 'plain');
      const knownKey = batch.addList(knownTyped(), 'known');
      const statement = await executeInOneRoundTrip(batch);
      const [plainBranch, knownBranch] = statement.split('\nUNION ALL\n');

      expect(plainBranch).toBe(`SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${build().future().getSql()}\n) __batch_q`);
      expect(knownBranch).toBe(`SELECT 1 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${knownTyped().future().getSql()}\n) __batch_q`);
      expect(statement).not.toContain('pg_typeof');
      expect(statement).not.toContain('OFFSET 0');

      expect(batch.getList(plainKey)).toEqual(await build().toList());
      expect(batch.getList(knownKey)).toEqual(await knownTyped().toList());
    });

    /**
     * A value named like the envelope's own row alias. A bare `__batch_q` is that column wherever the branch has
     * one; the fenced envelope reads its rows as `__batch_q.*` — always the whole row — so such a branch reads as
     * standalone, where 1.0.16 raised `function row_to_json(integer) does not exist` (and 1.0.17's first envelope,
     * which aggregated `__batch_q`, read every row as `{}`). A branch with no value to send as its text keeps
     * 1.0.10's envelope byte for byte, and fails on the name as it always did.
     */
    test('a value named __batch_q: a branch that sends texts reads its rows whole, as standalone; one that sends none fails as it always did', async () => {
      const typed = () => db.readings.select(r => ({ __batch_q: r.id, day: dateTrunc('day', r.takenAt) })).orderBy(r => r.__batch_q);
      const rows = await expectBatchedLikeStandalone<any[]>(typed);

      expect(rows).toHaveLength(4);
      expect(rows.map(row => Object.keys(row).sort())).toEqual(new Array(4).fill(['__batch_q', 'day']));
      expect(rows[0].day).toEqual(localTime('2024-03-01 00:00:00'));

      const plain = new QueryBatch();
      plain.addList(db.readings.select(r => ({ __batch_q: r.id, note: r.note })).orderBy(r => r.__batch_q), 'plain');
      let failure: unknown;
      try {
        await plain.executeBatch();
      } catch (error) {
        failure = error;
      }
      expect(String((failure as Error | undefined)?.message)).toMatch(/row_to_json/);
    });

    test('a declared int8 / numeric column: its SQL is the fenced envelope now (1.0.10 merged its text into a jsonb row), its value unchanged — the exact text', async () => {
      const build = () => db.readings.select(r => ({ id: r.id, pressure: r.pressure, pulses: r.pulses, details: r.details })).orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(build);
      expect(rows.map(r => [r.pressure, r.pulses])).toEqual([['1013.25', '9007199254740993'], ['1009.50', '12'], ['1016.00', '7'], ['1011.75', '12']]);

      const batch = new QueryBatch();
      batch.addList(build(), 'exact');
      const statement = await executeInOneRoundTrip(batch);

      // Always sent as their text (no per-row test), their types once for the branch
      expect(statement).toBe(fencedEnvelope(
        0,
        build().future().getSql(),
        [textAlways('pressure'), textAlways('pulses')],
        ['pressure', 'pulses']
      ));
      expect(statement).not.toContain('to_jsonb');
    });

    test('a branch with an untyped value sends the row itself, the value\'s text when its type needs one, and its base type ONCE — over its query fenced to run once per row', async () => {
      const build = () => db.readings.select(r => ({ id: r.id, day: dateTrunc('day', r.takenAt) })).orderBy(r => r.id);

      const batch = new QueryBatch();
      batch.addList(build(), 'days');
      const statement = await executeInOneRoundTrip(batch);

      const day = '(__batch_q."day")';
      // The server sends the text of a type whose JSON form does not give it back; a date / timestamp /
      // timestamptz's only under a DateStyle other than ISO (asked once per row)
      const textTypes = '\'{20,1700,1182,1183,1270,1115,1185,1187,1016,1231,791,1001,1017,719}\'::oid[]';
      const isoDateStyle = '(SELECT current_setting(\'DateStyle\') LIKE \'ISO%\')';
      const needsServerText = `pg_typeof(${day})::oid = ANY(${textTypes}) OR pg_typeof(${day})::oid >= 16384`;
      const dateStyled = `pg_typeof(${day})::oid = ANY('{1082,1114,1184}'::oid[])`;
      const needsItsText = `(${needsServerText} OR (NOT ${isoDateStyle} AND ${dateStyled}))`;
      // Its type once; the type a domain is over when the server sends its text (a user-defined one), in one
      // catalog lookup for the branch; the rows aggregated as whole records; the value's texts, one per row,
      // when its type needs them (the test runs once per row, in the FILTER) — the texts in ONE array column,
      // the types in another, whatever the number of values
      expect(statement).toBe(
        'SELECT 0 AS __batch_ix, json_build_object(\'t\', to_json(__batch_s.t::bigint[]), '
        + '\'d\', (SELECT json_object_agg(__batch_t.oid, __batch_t.typbasetype::bigint) FROM pg_catalog.pg_type __batch_t '
        + 'WHERE __batch_t.oid = ANY(__batch_s.t) AND __batch_t.typtype = \'d\' AND (__batch_t.oid >= 16384)), '
        + '\'r\', __batch_s.r, \'x\', to_json(__batch_s.x)) AS __batch_items '
        + 'FROM (SELECT coalesce(json_agg(__batch_q.*), \'[]\'::json) AS r, '
        + `ARRAY[json_agg(concat(${day})) FILTER (WHERE ${needsItsText})] AS x, `
        + `ARRAY[min(pg_typeof(${day})::oid)] AS t FROM (SELECT * FROM (\n`
        + `${build().future().getSql()}\n) __batch_q0 OFFSET 0) __batch_q) __batch_s`
      );
      expect(statement).not.toContain('to_jsonb');
    });

    test('a selector returning ONE untyped expression: the fence names its column', async () => {
      const build = () => db.readings.where(r => eq(r.stationId, ids.harbor)).orderBy(r => r.id).select(r => dateTrunc('day', r.takenAt));

      const days = await expectBatchedLikeStandalone<any[]>(build);
      expect(days).toEqual([localTime('2024-03-02 00:00:00'), localTime('2024-03-03 00:00:00')]);

      const batch = new QueryBatch();
      batch.addList(build(), 'days');
      const statement = await executeInOneRoundTrip(batch);
      expect(statement).toContain(`\n) __batch_q0("__batch_value") OFFSET 0) __batch_q) __batch_s`);
      expect(statement).toContain(`ARRAY[min(pg_typeof(${batchColumn('__batch_value')})::oid)] AS t`);
    });

    test('a branch of untyped values with no rows reads [] and null', async () => {
      const none = () => db.readings.where(r => eq(r.note, 'hail')).select(r => ({ id: r.id, day: dateTrunc('day', r.takenAt) }));

      const batch = new QueryBatch();
      const listKey = batch.addList(none(), 'none');
      const itemKey = batch.addFirstOrDefault(none(), 'first');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(listKey)).toEqual([]);
      expect(batch.getItem(itemKey)).toBeNull();
    });

    test('typed and untyped branches together: one round trip, every result identical to standalone', async () => {
      const builders: Record<string, () => Batchable> = {
        days: () => db.readings.select(r => ({ id: r.id, day: castAsDate(r.takenAt), big: castAsBigInt(r.pulses) })).orderBy(r => r.id),
        plain: () => db.stations.select(s => ({ id: s.id, name: s.name, altitude: s.altitude, serialNo: s.serialNo })).orderBy(s => s.id),
        latest: () => db.stations.select(s => ({ id: s.id, lastTaken: s.readings!.max(r => r.takenAt) })).orderBy(s => s.id),
      };

      const expected: Record<string, any[]> = {};
      for (const [name, build] of Object.entries(builders)) {
        expected[name] = await build().toList();
      }

      const batch = new QueryBatch();
      const keys = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, batch.addList(build(), name)]));
      const statement = await executeInOneRoundTrip(batch);

      expect(statement.match(/UNION ALL/g)).toHaveLength(2);
      for (const name of Object.keys(builders)) {
        expect(batch.getList(keys[name])).toEqual(expected[name]);
        expectSameShape(batch.getList(keys[name]), expected[name]);
      }
      expect(expected.plain.map(s => s.serialNo)).toEqual(['9007199254740993', '42']);
    });
  });
});
