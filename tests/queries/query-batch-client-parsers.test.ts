import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import {
  bigint,
  BunClient,
  cast,
  castAsBigInt,
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
  integer,
  PgClient,
  PGliteClient,
  PostgresClient,
  QueryBatch,
  serial,
  sql,
  timestamp,
  timestamptz,
  varchar,
} from '../../src';
import { isMemoryTestDatabase, memoryTcpEndpoint } from '../memory/shared-memory-db';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';

/**
 * A batch delivers every value exactly as THIS client delivers it for the same query on its own — under
 * whatever parsers its driver is configured with. The batch sends the values its JSON envelope cannot
 * carry as the driver delivers them as their PostgreSQL text and parses each with the client's own parser
 * for its type (`DatabaseClient.parseTypedText`). It used to revive them by the DEFAULT drivers' rules: a
 * client configured with text passthrough for timestamps read a batched collection MAX() of a timestamp as
 * a Date where the same query read the driver's text on its own.
 *
 * An observatory (defined here):
 *
 *   instrument  installed at         commissioned on
 *   Refractor   2019-04-01 08:30:00  2019-03-15
 *   Reflector   2021-09-15 20:00:00  2021-09-01
 *
 *   observation  instrument  observed at          recorded at (UTC)    observed on  exposure
 *   O1           Refractor   2024-03-01 21:15:00  2024-03-01 20:15:00  2024-03-01   9007199254740993
 *   O2           Refractor   2024-03-02 22:00:00  2024-03-02 21:00:00  2024-03-02   12
 *   O3           Reflector   2024-03-02 23:30:00  2024-03-02 22:30:00  2024-03-02   7
 */

class CpxInstrument extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  installedAt!: DbColumn<Date>;
  commissionedOn!: DbColumn<Date>;

  observations?: CpxObservation[];
}

class CpxObservation extends DbEntity {
  id!: DbColumn<number>;
  instrumentId!: DbColumn<number>;
  observedAt!: DbColumn<Date>;
  recordedAt!: DbColumn<Date>;
  observedOn!: DbColumn<Date>;
  exposure!: DbColumn<string>;

  instrument?: CpxInstrument;
}

class ObservatoryDatabase extends DbContext {
  get instruments(): DbEntityTable<CpxInstrument> {
    return this.table(CpxInstrument);
  }

  get observations(): DbEntityTable<CpxObservation> {
    return this.table(CpxObservation);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CpxInstrument, entity => {
      entity.toTable('cpx_instruments');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.installedAt).hasType(timestamp('installed_at')).isRequired();
      entity.property(e => e.commissionedOn).hasType(date('commissioned_on')).isRequired();

      entity.hasMany(e => e.observations, () => CpxObservation)
        .withForeignKey(o => o.instrumentId)
        .withPrincipalKey(i => i.id);
    });

    model.entity(CpxObservation, entity => {
      entity.toTable('cpx_observations');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.instrumentId).hasType(integer('instrument_id')).isRequired();
      entity.property(e => e.observedAt).hasType(timestamp('observed_at')).isRequired();
      entity.property(e => e.recordedAt).hasType(timestamptz('recorded_at')).isRequired();
      entity.property(e => e.observedOn).hasType(date('observed_on')).isRequired();
      entity.property(e => e.exposure).hasType(bigint('exposure')).isRequired();

      entity.hasOne(e => e.instrument, () => CpxInstrument)
        .withForeignKey(o => o.instrumentId)
        .withPrincipalKey(i => i.id);
    });
  }
}

const TABLES = ['cpx_observations', 'cpx_instruments'];

const createSchema = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  const db = new ObservatoryDatabase(client);
  await db.getSchemaManager().ensureCreated();
  // A date / timestamp binds as its text: every driver stores exactly these values
  const at = (value: string) => value as unknown as Date;
  const [refractor, reflector] = await db.instruments.insertBulk([
    { name: 'Refractor', installedAt: at('2019-04-01 08:30:00'), commissionedOn: at('2019-03-15') },
    { name: 'Reflector', installedAt: at('2021-09-15 20:00:00'), commissionedOn: at('2021-09-01') },
  ]).returning();
  await db.observations.insertBulk([
    { instrumentId: refractor.id, observedAt: at('2024-03-01 21:15:00'), recordedAt: new Date('2024-03-01T20:15:00Z'), observedOn: at('2024-03-01'), exposure: '9007199254740993' },
    { instrumentId: refractor.id, observedAt: at('2024-03-02 22:00:00'), recordedAt: new Date('2024-03-02T21:00:00Z'), observedOn: at('2024-03-02'), exposure: '12' },
    { instrumentId: reflector.id, observedAt: at('2024-03-02 23:30:00'), recordedAt: new Date('2024-03-02T22:30:00Z'), observedOn: at('2024-03-02'), exposure: '7' },
  ]);
};

const dropSchema = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

/** Deep equality that also asserts every leaf's JS type (a Date stays a Date, text stays text, a BigInt a BigInt). */
const expectSameValues = (actual: unknown, expected: unknown, path = '$'): void => {
  if (expected === null || expected === undefined || typeof expected !== 'object') {
    expect({ path, type: typeof actual, value: actual }).toEqual({ path, type: typeof expected, value: expected });

    return;
  }

  expect({ path, constructor: (actual as object)?.constructor }).toEqual({ path, constructor: (expected as object).constructor });

  if (expected instanceof Date) {
    expect({ path, time: (actual as Date).getTime() }).toEqual({ path, time: expected.getTime() });

    return;
  }

  for (const key of Object.keys(expected)) {
    expectSameValues((actual as any)[key], (expected as any)[key], `${path}.${key}`);
  }
};

/** The query shapes whose values the batch sends as their text, by name. */
const shapes = (db: ObservatoryDatabase) => {
  const observedTimes = () => new DbCteBuilder().with(
    'cpx_observed_times',
    db.observations.select(o => ({ cteId: o.id, at: o.observedAt }))
  ).cte;

  return {
    'a collection MAX() of a timestamp': () => db.instruments
      .select(i => ({ id: i.id, last: i.observations!.max(o => o.observedAt) }))
      .orderBy(i => i.id),
    'a grouped dateTrunc() key': () => db.observations
      .select(o => ({ day: dateTrunc('day', o.observedAt), id: o.id }))
      .groupBy(r => ({ day: r.day }))
      .select(g => ({ day: g.key.day, n: g.count() }))
      .orderBy(r => r.day),
    'a CTE\'s timestamp column': () => db.observations
      .leftJoin(observedTimes(), (o, t) => eq(o.id, t.cteId), (o, t) => ({ id: o.id, at: t.at }))
      .orderBy(r => r.id),
    'a joined table\'s timestamp column': () => db.observations
      .leftJoin(db.instruments, (o, i) => eq(o.instrumentId, i.id), (o, i) => ({ id: o.id, since: i.installedAt }))
      .orderBy(r => r.id),
    'a scalar subquery of a date': () => db.instruments
      .select(i => ({
        id: i.id,
        firstOn: db.observations.where(o => eq(o.instrumentId, i.id)).orderBy(o => o.id).limit(1).select(o => o.observedOn).asSubquery('scalar'),
      }))
      .orderBy(i => i.id),
    'an int8 column and an int8 expression': () => db.observations
      .select(o => ({ id: o.id, exposure: o.exposure, doubled: castAsBigInt(o.exposure) }))
      .orderBy(o => o.id),
  } as const;
};

type ShapeName = keyof ReturnType<typeof shapes>;

/** Every shape standalone and in ONE batch on `db`'s client: each batched list equals its standalone read. */
const expectBatchLikeStandalone = async (db: ObservatoryDatabase): Promise<Record<ShapeName, any[]>> => {
  const builders = shapes(db);
  const standalone = {} as Record<ShapeName, any[]>;

  for (const [name, build] of Object.entries(builders) as Array<[ShapeName, () => any]>) {
    standalone[name] = await build().toList();
  }

  const batch = new QueryBatch();
  const keys = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, batch.addList((build as () => any)(), name)]));
  await batch.executeBatch();

  for (const name of Object.keys(builders) as ShapeName[]) {
    const batched = batch.getList(keys[name]);
    expect({ name, rows: batched }).toEqual({ name, rows: standalone[name] });
    expectSameValues(batched, standalone[name], name);
  }

  return standalone;
};

const driver = (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase();
// A client of its own reaches the suite's server — which a PGlite run has not (its database is in process)
const reachesServer = driver !== 'pglite';

/**
 * A Bun SQL client of its own, on the suite's database: Bun's client cannot use a custom socket, so in memory
 * mode it connects to the TCP endpoint of the file's in-memory database.
 */
const bunClient = async (options: Record<string, unknown>): Promise<BunClient> => {
  const endpoint = isMemoryTestDatabase() ? await memoryTcpEndpoint() : undefined;
  const { host, port, database, username, password } = testConnectionConfig();

  return new BunClient({ hostname: endpoint?.host ?? host, port: endpoint?.port ?? port, database, username, password, max: 1, ...options } as any);
};

describe('a batched value is what THIS client delivers standalone, whatever its parsers', () => {
  let defaultClient: DatabaseClient;

  beforeAll(async () => {
    defaultClient = createFreshClient();
    await createSchema(defaultClient);
  });

  afterAll(async () => {
    await dropSchema(defaultClient);
    await defaultClient.end();
  });

  test('the suite\'s client, as configured by default: Dates, as ever', async () => {
    const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(defaultClient));

    expect(standalone['a collection MAX() of a timestamp'][0].last).toBeInstanceOf(Date);
    expect(standalone['a grouped dateTrunc() key'][0].day).toBeInstanceOf(Date);
    expect(standalone['a scalar subquery of a date'][0].firstOn).toBeInstanceOf(Date);
    expect(standalone['an int8 column and an int8 expression'][0].exposure).toBe('9007199254740993');
  });

  test.skipIf(!reachesServer)('postgres.js with text passthrough for timestamp / timestamptz / date: the driver\'s text', async () => {
    const instance = postgres({
      ...testConnectionConfig(),
      max: 1,
      types: {
        timestamp: { to: 1114, from: [1114], serialize: (x: string) => x, parse: (x: string) => x },
        timestamptz: { to: 1184, from: [1184], serialize: (x: string) => x, parse: (x: string) => x },
        date: { to: 25, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      },
    });
    const client = new PostgresClient(instance);

    try {
      const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(client));

      expect(standalone['a collection MAX() of a timestamp'][0].last).toBe('2024-03-02 22:00:00');
      expect(standalone['a grouped dateTrunc() key'][0].day).toBe('2024-03-01 00:00:00');
      expect(standalone['a CTE\'s timestamp column'][0].at).toBe('2024-03-01 21:15:00');
      expect(standalone['a joined table\'s timestamp column'][0].since).toBe('2019-04-01 08:30:00');
      expect(standalone['a scalar subquery of a date'][0].firstOn).toBe('2024-03-01');
    } finally {
      await client.end();
    }
  });

  test.skipIf(!reachesServer)('node-postgres with parsers of its own (timestamp as text, int8 as a BigInt): those values', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pgTypes = require('pg').types;
    const { host, port, database, username, password } = testConnectionConfig();
    const client = new PgClient({
      host,
      port,
      database,
      user: username,
      password,
      max: 1,
      types: {
        getTypeParser: (oid: number, format?: string) => {
          if (oid === 1114) {
            return (value: string) => value;
          }

          if (oid === 20) {
            return (value: string) => BigInt(value);
          }

          return pgTypes.getTypeParser(oid, format);
        },
      },
    } as any);

    try {
      const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(client));

      expect(standalone['a collection MAX() of a timestamp'][0].last).toBe('2024-03-02 22:00:00');
      expect(standalone['a CTE\'s timestamp column'][0].at).toBe('2024-03-01 21:15:00');
      expect(standalone['an int8 column and an int8 expression'][0]).toEqual({ id: 1, exposure: 9007199254740993n, doubled: 9007199254740993n });
    } finally {
      await client.end();
    }
  });

  test('PGlite with text passthrough parsers for timestamp / timestamptz / date: the driver\'s text', async () => {
    const client = new PGliteClient({
      parsers: { 1114: (value: string) => value, 1184: (value: string) => value, 1082: (value: string) => value },
    });

    try {
      await createSchema(client);
      const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(client));

      expect(standalone['a collection MAX() of a timestamp'][0].last).toBe('2024-03-02 22:00:00');
      expect(standalone['a scalar subquery of a date'][0].firstOn).toBe('2024-03-01');
    } finally {
      await client.end();
    }
  });

  test.skipIf(!reachesServer)('Bun\'s SQL client with datesAsStrings: the text it makes of its Dates', async () => {
    const client = await bunClient({ datesAsStrings: true });

    try {
      const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(client));

      expect(typeof standalone['a collection MAX() of a timestamp'][0].last).toBe('string');
      expect(typeof standalone['a scalar subquery of a date'][0].firstOn).toBe('string');
    } finally {
      await client.end();
    }
  });

  test.skipIf(!reachesServer)('Bun\'s SQL client with bigint: true: its int8 BigInts', async () => {
    const client = await bunClient({ bigint: true });

    try {
      const standalone = await expectBatchLikeStandalone(new ObservatoryDatabase(client));

      expect(standalone['an int8 column and an int8 expression'][0].doubled).toBe(9007199254740993n);
    } finally {
      await client.end();
    }
  });

  test.skipIf(!reachesServer)('postgres.js with a parser of its own for boolean: a batched boolean goes through it', async () => {
    const client = new PostgresClient(postgres({
      ...testConnectionConfig(),
      max: 1,
      types: { flag: { to: 16, from: [16], serialize: (x: unknown) => (x === 'yes' ? 't' : 'f'), parse: (x: string) => (x === 't' ? 'yes' : 'no') } },
    }));

    try {
      const db = new ObservatoryDatabase(client);
      const build = () => db.observations.select(o => ({ id: o.id, late: sql<string>`${o.observedAt} > TIMESTAMP '2024-03-02 00:00:00'` })).orderBy(o => o.id);
      const standalone = await build().toList();
      const batch = new QueryBatch();
      const key = batch.addList(build(), 'flags');
      await batch.executeBatch();

      expect(standalone.map(row => row.late)).toEqual(['no', 'yes', 'yes']);
      expect(batch.getList(key)).toEqual(standalone);
    } finally {
      await client.end();
    }
  });

  test.skipIf(!reachesServer)('a plain select\'s declared timestamp column: revived as a batch always revived it (the documented limitation)', async () => {
    const instance = postgres({
      ...testConnectionConfig(),
      max: 1,
      types: { timestamp: { to: 1114, from: [1114], serialize: (x: string) => x, parse: (x: string) => x } },
    });
    const client = new PostgresClient(instance);

    try {
      const db = new ObservatoryDatabase(client);
      const build = () => db.observations.select(o => ({ id: o.id, at: o.observedAt })).orderBy(o => o.id);
      const standalone = await build().toList();
      const batch = new QueryBatch();
      const key = batch.addList(build(), 'declared');
      await batch.executeBatch();

      // The client's parser makes the column text standalone (typed Date by the entity)
      expect(standalone[0].at as unknown).toBe('2024-03-01 21:15:00');
      expect(batch.getList(key)[0].at).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });
});

/**
 * Values of every type a batch sends as its text — and of the builtins JSON carries, which a batch sends
 * as text when the client parses them itself — as `<literal>::<type>`: each client's
 * `parseTypedText(<its type's OID>, <its text as the wire sends it>)` must be exactly the value the client
 * reads for the column standalone — through a statement without parameters and through one with (Bun
 * decodes the latter's results through the binary protocol).
 */
const TYPED_TEXTS: ReadonlyArray<readonly [literal: string, type: string]> = [
  ['t', 'boolean'],
  ['false', 'boolean'],
  ['-42', 'smallint'],
  ['7', 'integer'],
  ['4000000000', 'oid'],
  ['1.5', 'real'],
  ['-2.25', 'double precision'],
  ['NaN', 'double precision'],
  ['-Infinity', 'double precision'],
  ['{"b":1,"a":[2]}', 'json'],
  ['{"b":1,"a":[2]}', 'jsonb'],
  ['null', 'json'],
  ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'uuid'],
  ['192.168.0.1', 'inet'],
  ['10.0.0.0/8', 'cidr'],
  ['a', 'char(3)'],
  ['x', '"char"'],
  ['plain text', 'text'],
  ['{t,f,NULL}', 'boolean[]'],
  ['{1,-2}', 'integer[]'],
  ['{1,2}', 'smallint[]'],
  ['{1.5,NaN}', 'double precision[]'],
  ['{"{\\"a\\":1}"}', 'json[]'],
  ['{a,"b c",NULL}', 'text[]'],
  ['{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}', 'uuid[]'],
  ['{"a  "}', 'char(3)[]'],
  ['{12.50}', 'money[]'],
  ['{"(1.5,2)"}', 'point[]'],
  ['{06:00:00+05:30}', 'timetz[]'],
  ['2024-03-01', 'date'],
  ['1969-12-31', 'date'],
  ['0044-03-15 BC', 'date'],
  ['12024-01-01', 'date'],
  ['infinity', 'date'],
  ['-infinity', 'date'],
  ['06:00:00.123', 'time'],
  ['06:00:00+05:30', 'timetz'],
  ['2024-03-01 06:00:00.123', 'timestamp'],
  ['2024-03-01 06:00:00.9999', 'timestamp'],
  ['1969-12-31 23:59:59.9995', 'timestamp'],
  ['0044-03-15 06:00:00 BC', 'timestamp'],
  ['12024-01-01 00:00:00', 'timestamp'],
  ['-infinity', 'timestamp'],
  ['2024-03-01 06:00:00.5+01', 'timestamptz'],
  ['2024-03-01 06:00:00.123456+05:45', 'timestamptz'],
  ['0044-03-15 06:00:00+00 BC', 'timestamptz'],
  ['infinity', 'timestamptz'],
  ['1 day 01:30:00', 'interval'],
  ['9007199254740993', 'bigint'],
  ['-9007199254740993', 'bigint'],
  ['1013.250', 'numeric'],
  ['0.00', 'numeric'],
  ['-0.000', 'numeric'],
  ['12.50', 'money'],
  ['\\x00ff10', 'bytea'],
  ['(1.5,2)', 'point'],
  ['<(1,2),3>', 'circle'],
  ['{2024-03-01,NULL,infinity}', 'date[]'],
  ['{"2024-03-01 06:00:00.9999",-infinity}', 'timestamp[]'],
  ['{"2024-03-01 06:00:00+00"}', 'timestamptz[]'],
  ['{1,9007199254740993}', 'bigint[]'],
  ['{1.5,2.25,0.00}', 'numeric[]'],
  ['{"\\\\x01ff"}', 'bytea[]'],
  ['{"1 day"}', 'interval[]'],
  ['{06:00:00}', 'time[]'],
  ['{{1,2},{3,4}}', 'bigint[]'],
];

describe('each client parses a value\'s text exactly as its driver parses the column', () => {
  let client: DatabaseClient;

  beforeAll(() => {
    client = createFreshClient();
  });

  afterAll(async () => {
    await client.end();
  });

  test.each(TYPED_TEXTS.map(([literal, type]) => [`${literal}::${type}`, literal, type] as const))('%s', async (name, literal, type) => {
    const value = `CAST('${literal.replace(/'/g, "''")}' AS ${type})`;
    // Its text as the batch sends it: the type's output function (a CAST to text differs for a boolean, an inet, a char(n))
    const select = `SELECT ${value} AS v, concat(${value}) AS t, CAST(CAST(pg_typeof(${value}) AS oid) AS integer) AS oid`;

    const { rows: [plain] } = await client.query(select);
    expectSameValues(client.parseTypedText(Number(plain.oid), plain.t, { parameterized: false }), plain.v, name);

    const { rows: [bound] } = await client.query(`${select}, CAST($1 AS integer) AS p`, [1]);
    expectSameValues(client.parseTypedText(Number(bound.oid), bound.t, { parameterized: true }), bound.v, `${name} (a parameterised statement)`);
  });

  test('a client with parsers of its own parses with them — and names their types for the batch to send as text', async () => {
    const pgTypes = require('pg').types;
    const parsers = {
      getTypeParser: (oid: number, format?: string) => (oid === 1114 || oid === 16 ? (value: string) => `own:${value}` : pgTypes.getTypeParser(oid, format)),
    };
    const pg = new PgClient({ ...testConnectionConfig(), user: testConnectionConfig().username, max: 1, types: parsers } as any);
    const postgresJs = new PostgresClient(postgres({
      ...testConnectionConfig(),
      max: 1,
      types: { flag: { to: 16, from: [16], serialize: (x: unknown) => String(x), parse: (x: string) => `own:${x}` } },
    }));

    try {
      expect([pg.parseTypedText(1114, '2024-03-01 06:00:00'), pg.parseTypedText(16, 't'), pg.parseTypedText(20, '12')])
        .toEqual(['own:2024-03-01 06:00:00', 'own:t', '12']);
      // A builtin the batch would not send as text otherwise: named (this pool parses boolean[] as pg-types does)
      expect([...pg.customParsedTypeOids()].sort((a, b) => a - b)).toEqual([16]);
      expect([postgresJs.parseTypedText(16, 't'), postgresJs.parseTypedText(20, '12')]).toEqual(['own:t', '12']);
      // postgres.js derives an array type's parser from its element's: boolean[] too
      expect([...postgresJs.customParsedTypeOids()].sort((a, b) => a - b)).toEqual([16, 1000]);
    } finally {
      await pg.end();
      await postgresJs.end();
    }
  });

  test('a client as configured by default names no type of its own', async () => {
    const pg = new PgClient({ ...testConnectionConfig(), user: testConnectionConfig().username, max: 1 } as any);
    const postgresJs = new PostgresClient(postgres({ ...testConnectionConfig(), max: 1 }));

    try {
      expect([pg.customParsedTypeOids(), postgresJs.customParsedTypeOids(), client.customParsedTypeOids()]).toEqual([[], [], []]);
    } finally {
      await pg.end();
      await postgresJs.end();
    }
  });
});

/**
 * Values of user-defined types: a domain over integer / boolean (read by the type it is over, which JSON
 * carries as the drivers deliver it — the batch keeps the JSON value), a domain over date (its text parsed
 * by the client as a date), an enum and a composite (their text: the drivers know no parser for them), a
 * NULL of a domain.
 */
describe('values of user-defined types in a batch: as the client reads them standalone', () => {
  let client: DatabaseClient;
  const TYPES = ['cpx_level', 'cpx_flag', 'cpx_day', 'cpx_mood', 'cpx_pair'];

  beforeAll(async () => {
    client = createFreshClient();
    await createSchema(client);
    for (const type of TYPES) {
      await client.query(`DROP TYPE IF EXISTS ${type} CASCADE`);
    }
    await client.query('CREATE DOMAIN cpx_level AS integer');
    await client.query('CREATE DOMAIN cpx_flag AS boolean');
    await client.query('CREATE DOMAIN cpx_day AS date');
    await client.query('CREATE TYPE cpx_mood AS ENUM (\'calm\', \'gusty\')');
    await client.query('CREATE TYPE cpx_pair AS (a integer, b integer)');
  });

  afterAll(async () => {
    await dropSchema(client);
    for (const type of TYPES) {
      await client.query(`DROP TYPE IF EXISTS ${type} CASCADE`);
    }
    await client.end();
  });

  const readBoth = async (db: ObservatoryDatabase): Promise<{ standalone: any[]; batched: any[] }> => {
    const build = () => db.observations
      .select(o => ({
        id: o.id,
        level: cast<number>(o.id, 'cpx_level'),
        flag: sql<boolean>`CAST(${o.id} > 1 AS cpx_flag)`,
        day: cast<Date>(o.observedOn, 'cpx_day'),
        mood: sql<string>`CAST(CASE WHEN ${o.id} = 1 THEN 'calm' ELSE 'gusty' END AS cpx_mood)`,
        pair: sql<string>`CAST(ROW(${o.id}, NULL) AS cpx_pair)`,
        none: sql<Date | null>`CAST(NULL AS cpx_day)`,
      }))
      .orderBy(o => o.id);
    const standalone = await build().toList();
    const batch = new QueryBatch();
    const key = batch.addList(build(), 'user-defined');
    await batch.executeBatch();

    return { standalone, batched: batch.getList(key) };
  };

  test('through the suite\'s client, as configured by default', async () => {
    const { standalone, batched } = await readBoth(new ObservatoryDatabase(client));

    expectSameValues(batched, standalone, 'user-defined');
    expect(standalone.map(row => [row.level, row.flag, row.mood, row.pair, row.none ?? null]))
      .toEqual([[1, false, 'calm', '(1,)', null], [2, true, 'gusty', '(2,)', null], [3, true, 'gusty', '(3,)', null]]);
    expect(standalone[0].day).toBeInstanceOf(Date);
  });

  test.skipIf(!reachesServer)('through postgres.js with text passthrough for date', async () => {
    const passthrough = new PostgresClient(postgres({
      ...testConnectionConfig(),
      max: 1,
      types: { date: { to: 25, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
    }));

    try {
      const { standalone, batched } = await readBoth(new ObservatoryDatabase(passthrough));

      expectSameValues(batched, standalone, 'user-defined');
      expect(standalone.map(row => [row.level, row.flag, row.day])).toEqual([[1, false, '2024-03-01'], [2, true, '2024-03-02'], [3, true, '2024-03-02']]);
    } finally {
      await passthrough.end();
    }
  });
});
