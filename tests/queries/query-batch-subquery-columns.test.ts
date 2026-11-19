import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import postgres from 'postgres';
import {
  bytea,
  createCustomType,
  DatabaseClient,
  date,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  integer,
  PostgresClient,
  QueryBatch,
  serial,
  timestamp,
  timestamptz,
  varchar,
} from '../../src';
import type { BatchListKey } from '../../src';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';

/**
 * A column a table subquery or a CTE projects straight from a table — a `timestamp`, `timestamptz`, `date` or
 * `bytea` column, mapped or not — and a collection list (`toList()`) such a subquery projects travel through a
 * QueryBatch as they travel when the query reads them from the table itself: a declared column revived from its
 * JSON form, a list as its JSON. Their branch keeps the plain envelope (`row_to_json` of the branch's rows),
 * never the runtime-typed one (rows, texts and types, `pg_typeof` per row, an `OFFSET 0` fence) — that envelope
 * stays for the values only PostgreSQL knows the type of, and for a column whose JSON revival is NOT what the
 * client's driver delivers (a client that parses the type otherwise, a mapped column on a client that does not
 * hand its mapper the driver's text).
 *
 * A small timetable (defined here):
 *
 *   route  name
 *   L1     Lakeside
 *   L2     Hillside
 *
 *   trip  route  departs at           arrives at (UTC)     travel day  ticket   boarded at (mapped)  stops
 *   T1    L1     2024-03-01 06:00:00  2024-03-01 07:30:00  2024-03-01  \x00ff   2024-03-01 05:55:00  Pier, Mill
 *   T2    L1     2024-03-02 18:30:00  -                    2024-03-02  -        2024-03-02 18:25:00  -
 *   T3    L2     2024-03-03 07:15:00  2024-03-03 08:00:00  2024-03-03  \x0a0b   2024-03-03 07:10:00  Ridge
 */

class SqbRoute extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class SqbTrip extends DbEntity {
  id!: DbColumn<number>;
  routeId!: DbColumn<number>;
  departsAt!: DbColumn<Date>;
  arrivesAt?: DbColumn<Date | null>;
  travelDay!: DbColumn<Date>;
  ticket?: DbColumn<Buffer | null>;
  boardedAt!: DbColumn<unknown>;

  stops?: SqbStop[];
}

class SqbStop extends DbEntity {
  id!: DbColumn<number>;
  tripId!: DbColumn<number>;
  label!: DbColumn<string>;
}

/** A column's driver value, unchanged — what an app that configures parser pass-through maps its columns with. */
const passThrough = <T>(dataType: string) => createCustomType<{ data: T; driverData: T }>({
  dataType: () => dataType,
  toDriver: (value: T | null | undefined) => value as T,
  fromDriver: (value: T | null | undefined) => value as T,
});

class TimetableDatabase extends DbContext {
  get routes(): DbEntityTable<SqbRoute> {
    return this.table(SqbRoute);
  }

  get trips(): DbEntityTable<SqbTrip> {
    return this.table(SqbTrip);
  }

  get stops(): DbEntityTable<SqbStop> {
    return this.table(SqbStop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SqbRoute, entity => {
      entity.toTable('sqb_routes');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
    });

    model.entity(SqbTrip, entity => {
      entity.toTable('sqb_trips');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.routeId).hasType(integer('route_id')).isRequired();
      entity.property(e => e.departsAt).hasType(timestamp('departs_at')).isRequired();
      entity.property(e => e.arrivesAt).hasType(timestamptz('arrives_at'));
      entity.property(e => e.travelDay).hasType(date('travel_day')).isRequired();
      entity.property(e => e.ticket).hasType(bytea('ticket'));
      entity.property(e => e.boardedAt).hasType(timestamp('boarded_at')).hasCustomMapper(passThrough<unknown>('timestamp')).isRequired();

      entity.hasMany(e => e.stops, () => SqbStop)
        .withForeignKey(s => s.tripId)
        .withPrincipalKey(t => t.id);
    });

    model.entity(SqbStop, entity => {
      entity.toTable('sqb_stops');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.tripId).hasType(integer('trip_id')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
    });
  }
}

const TABLES = ['sqb_stops', 'sqb_trips', 'sqb_routes'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

const seedTimetable = async (db: TimetableDatabase): Promise<void> => {
  // A date binds as its 'YYYY-MM-DD' text and a timestamp WITHOUT time zone as its wall-clock text,
  // so every driver stores exactly these values whatever the process time zone is
  const text = (value: string) => value as unknown as Date;

  const [lakeside, hillside] = await db.routes.insertBulk([{ name: 'Lakeside' }, { name: 'Hillside' }]).returning();

  const [t1, , t3] = await db.trips.insertBulk([
    {
      routeId: lakeside.id, departsAt: text('2024-03-01 06:00:00'), arrivesAt: new Date('2024-03-01T07:30:00Z'), travelDay: text('2024-03-01'),
      ticket: Buffer.from([0x00, 0xff]), boardedAt: '2024-03-01 05:55:00',
    },
    {
      routeId: lakeside.id, departsAt: text('2024-03-02 18:30:00'), arrivesAt: null, travelDay: text('2024-03-02'),
      ticket: null, boardedAt: '2024-03-02 18:25:00',
    },
    {
      routeId: hillside.id, departsAt: text('2024-03-03 07:15:00'), arrivesAt: new Date('2024-03-03T08:00:00Z'), travelDay: text('2024-03-03'),
      ticket: Buffer.from([0x0a, 0x0b]), boardedAt: '2024-03-03 07:10:00',
    },
  ]).returning();

  await db.stops.insertBulk([
    { tripId: t1.id, label: 'Pier' },
    { tripId: t1.id, label: 'Mill' },
    { tripId: t3.id, label: 'Ridge' },
  ]);
};

/** A timestamp-without-time-zone value as the drivers read it: that wall-clock time, local. */
const localTime = (value: string): Date => new Date(value.replace(' ', 'T'));

/** A date as the drivers read it: local midnight of that day. */
const localDay = (value: string): Date => {
  const [year, month, dayOfMonth] = value.split('-').map(Number);

  return new Date(year, month - 1, dayOfMonth);
};

/**
 * Deep equality that also asserts every leaf's JS type (a Date stays a Date, a Buffer a Buffer, text stays text).
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

  if (standalone instanceof Uint8Array) {
    expect({ path, bytes: Array.from(batched as Uint8Array) }).toEqual({ path, bytes: Array.from(standalone) });

    return;
  }

  if (Array.isArray(standalone)) {
    expect({ path, length: (batched as unknown[]).length }).toEqual({ path, length: standalone.length });
    standalone.forEach((item, ix) => expectSameShape((batched as unknown[])[ix], item, `${path}[${ix}]`));

    return;
  }

  expect({ path, keys: Object.keys(batched as object) }).toEqual({ path, keys: Object.keys(standalone) });

  for (const key of Object.keys(standalone)) {
    expectSameShape((batched as any)[key], (standalone as any)[key], `${path}.${key}`);
  }
};

/** The plain envelope of branch 0 running `sql` — the one a branch of declared columns has always had. */
const plainEnvelope = (sql: string): string =>
  `SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${sql}\n) __batch_q`;

interface Listable {
  future(): { _sql: string };
  toList(): Promise<any[]>;
}

/**
 * Runs the query standalone, then — built afresh — through a batch of its own in one round trip, on `db`:
 * identical values, JS types and key order. Returns the standalone rows and the batch's statement.
 */
const readBoth = async (
  db: TimetableDatabase,
  client: DatabaseClient,
  build: () => Listable,
): Promise<{ rows: any[]; batchSql: string; standaloneSql: string }> => {
  const rows = await build().toList();
  const standaloneSql = build().future()._sql;
  const batch = new QueryBatch();
  const key = batch.addList(build() as any, 'probe') as BatchListKey<unknown>;
  const querySpy = jest.spyOn(client, 'query');
  let batchSql: string;

  try {
    await batch.executeBatch();

    expect(querySpy).toHaveBeenCalledTimes(1);
    batchSql = String(querySpy.mock.calls[0][0]);
  } finally {
    querySpy.mockRestore();
  }

  const batched = batch.getList(key);

  expect(batched).toEqual(rows);
  expectSameShape(batched, rows);

  return { rows, batchSql, standaloneSql };
};

/** The shapes under test: a fenced table subquery of trips joined to its route, and the same read through a CTE. */
const shapes = (db: TimetableDatabase) => ({
  subquery: () => db.routes
    .innerJoin(
      db.trips
        .select(t => ({
          tripId: t.id,
          tripRouteId: t.routeId,
          departsAt: t.departsAt,
          arrivesAt: t.arrivesAt,
          ticket: t.ticket,
          stops: t.stops!.orderBy(s => s.id).select(s => ({ label: s.label })).toList(),
        }))
        .offset(0)
        .asSubquery('table'),
      (r, trip) => eq(r.id, trip.tripRouteId),
      (r, trip) => ({
        route: r.name,
        tripId: trip.tripId,
        departsAt: trip.departsAt,
        arrivesAt: trip.arrivesAt,
        ticket: trip.ticket,
        stops: trip.stops,
      }),
      'route_trips',
    )
    .orderBy(r => r.tripId),
  cte: () => {
    const cte = new DbCteBuilder().with(
      'sqb_trip_times',
      db.trips.select(t => ({ cteTripId: t.id, cteRouteId: t.routeId, departsAt: t.departsAt, arrivesAt: t.arrivesAt, ticket: t.ticket })),
    ).cte;

    return db.routes
      .innerJoin(cte, (r, t) => eq(r.id, t.cteRouteId), (r, t) => ({
        route: r.name,
        tripId: t.cteTripId,
        departsAt: t.departsAt,
        arrivesAt: t.arrivesAt,
        ticket: t.ticket,
      }))
      .orderBy(r => r.tripId);
  },
  travelDays: () => db.routes
    .innerJoin(
      db.trips.select(t => ({ dayRouteId: t.routeId, dayTripId: t.id, travelDay: t.travelDay })).asSubquery('table'),
      (r, d) => eq(r.id, d.dayRouteId),
      (r, d) => ({ route: r.name, tripId: d.dayTripId, travelDay: d.travelDay }),
      'route_days',
    )
    .orderBy(r => r.tripId),
  mappedBoarding: () => db.routes
    .innerJoin(
      db.trips.select(t => ({ boardRouteId: t.routeId, boardTripId: t.id, boardedAt: t.boardedAt })).asSubquery('table'),
      (r, b) => eq(r.id, b.boardRouteId),
      (r, b) => ({ route: r.name, tripId: b.boardTripId, boardedAt: b.boardedAt }),
      'route_boardings',
    )
    .orderBy(r => r.tripId),
});

describe('a table subquery\'s / CTE\'s declared columns and collection lists in a QueryBatch', () => {
  let client: DatabaseClient;
  let db: TimetableDatabase;

  beforeAll(async () => {
    client = createFreshClient();
    db = new TimetableDatabase(client);
    await dropTables(client);
    await db.getSchemaManager().ensureCreated();
    await seedTimetable(db);
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  test('a table subquery\'s timestamp / timestamptz / bytea columns and its toList(): as standalone, in the plain envelope', async () => {
    const { rows, batchSql, standaloneSql } = await readBoth(db, client, shapes(db).subquery);

    expect(batchSql).toBe(plainEnvelope(standaloneSql));
    expect(batchSql).not.toContain('pg_typeof');

    expect(rows.map(r => [r.departsAt, r.arrivesAt, r.ticket, r.stops])).toEqual([
      [localTime('2024-03-01 06:00:00'), new Date('2024-03-01T07:30:00Z'), Buffer.from([0x00, 0xff]), [{ label: 'Pier' }, { label: 'Mill' }]],
      [localTime('2024-03-02 18:30:00'), undefined, undefined, []],
      [localTime('2024-03-03 07:15:00'), new Date('2024-03-03T08:00:00Z'), Buffer.from([0x0a, 0x0b]), [{ label: 'Ridge' }]],
    ]);
    expect(rows[0].departsAt).toBeInstanceOf(Date);
    expect(rows[0].ticket).toBeInstanceOf(Buffer);
  });

  test('a CTE\'s timestamp / timestamptz / bytea columns: as standalone, in the plain envelope', async () => {
    const { rows, batchSql, standaloneSql } = await readBoth(db, client, shapes(db).cte);

    expect(batchSql).toBe(plainEnvelope(standaloneSql));

    expect(rows.map(r => [r.departsAt, r.arrivesAt, r.ticket])).toEqual([
      [localTime('2024-03-01 06:00:00'), new Date('2024-03-01T07:30:00Z'), Buffer.from([0x00, 0xff])],
      [localTime('2024-03-02 18:30:00'), undefined, undefined],
      [localTime('2024-03-03 07:15:00'), new Date('2024-03-03T08:00:00Z'), Buffer.from([0x0a, 0x0b])],
    ]);
  });

  test('a table subquery\'s date column: Dates at local midnight, as standalone', async () => {
    const { rows } = await readBoth(db, client, shapes(db).travelDays);

    expect(rows.map(r => r.travelDay)).toEqual([localDay('2024-03-01'), localDay('2024-03-02'), localDay('2024-03-03')]);
  });

  test('a subquery\'s mapped timestamp column on a client that hands its mapper a Date: as standalone, its text sent as before', async () => {
    const { rows, batchSql } = await readBoth(db, client, shapes(db).mappedBoarding);

    expect(batchSql).toContain('pg_typeof((__batch_q."boardedAt"))');
    expect(rows.map(r => r.boardedAt)).toEqual([localTime('2024-03-01 05:55:00'), localTime('2024-03-02 18:25:00'), localTime('2024-03-03 07:10:00')]);
  });

  /**
   * An app that maps its timestamps itself configures the driver to hand it their text (as gopass does):
   * the mapped column of a subquery reaches the mapper as that text, standalone and batched, in the plain envelope.
   */
  test.skipIf((process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase() === 'pglite')(
    'postgres.js with text passthrough for timestamps: a subquery\'s mapped timestamp column as the driver\'s text, in the plain envelope',
    async () => {
      const passthrough = new PostgresClient(postgres({
        ...testConnectionConfig(),
        max: 1,
        types: {
          timestamp: { to: 1114, from: [1114], serialize: (x: string) => x, parse: (x: string) => x },
          timestamptz: { to: 1184, from: [1184], serialize: (x: string) => x, parse: (x: string) => x },
          date: { to: 25, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
        },
      }));
      const passthroughDb = new TimetableDatabase(passthrough);

      try {
        const build = () => passthroughDb.routes
          .innerJoin(
            passthroughDb.trips
              .select(t => ({
                tripId: t.id,
                tripRouteId: t.routeId,
                boardedAt: t.boardedAt,
                stops: t.stops!.orderBy(s => s.id).select(s => ({ label: s.label })).toList(),
              }))
              .offset(0)
              .asSubquery('table'),
            (r, trip) => eq(r.id, trip.tripRouteId),
            (_r, trip) => ({ tripId: trip.tripId, boardedAt: trip.boardedAt, stops: trip.stops }),
            'route_trips',
          )
          .orderBy(r => r.tripId);

        const { rows, batchSql, standaloneSql } = await readBoth(passthroughDb, passthrough, build);

        expect(batchSql).toBe(plainEnvelope(standaloneSql));
        expect(rows.map(r => r.boardedAt)).toEqual(['2024-03-01 05:55:00', '2024-03-02 18:25:00', '2024-03-03 07:10:00']);
      } finally {
        await passthrough.end();
      }
    },
  );
});
