/**
 * BunClient contract tests against Bun's native SQL client. They prove BunClient satisfies the same
 * DatabaseClient contract the rest of the suite exercises through PgClient.
 *
 * Bun's SQL client cannot use a custom socket, so in memory mode (LINKGRESS_TEST_DB=memory) it connects
 * to the TCP endpoint of the file's in-memory database.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BunClient } from '../../src';
import { isMemoryTestDatabase, memoryTcpEndpoint } from '../memory/shared-memory-db';

const memoryEndpoint = isMemoryTestDatabase() ? await memoryTcpEndpoint() : null;

const DB_CONFIG = {
  hostname: memoryEndpoint?.host ?? (process.env.DB_HOST || 'localhost'),
  port: memoryEndpoint?.port ?? parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'linkgress_test',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

const CONNECTION_STRING =
  `postgres://${DB_CONFIG.username}:${DB_CONFIG.password}@${DB_CONFIG.hostname}:${DB_CONFIG.port}/${DB_CONFIG.database}`;

/** Unique per-run scratch table so concurrent/aborted runs never collide. */
const PROBE_TABLE = `bun_client_probe_${process.pid}`;

describe('BunClient construction', () => {
  test('constructs from a config object and executes a query', async () => {
    // Proves the constructor resolves Bun's SQL under the Bun runtime.
    // Defect: `require('bun:sql')` is not a real module, so this threw
    // "BunClient requires Bun runtime" even when running under Bun.
    const client = new BunClient(DB_CONFIG);

    try {
      const result = await client.query('SELECT 1 AS one');
      expect(result.rows).toEqual([{ one: 1 }]);
      expect(result.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('constructs from a connection string', async () => {
    const client = new BunClient(CONNECTION_STRING);

    try {
      const result = await client.query('SELECT 2 AS two');
      expect(result.rows).toEqual([{ two: 2 }]);
    } finally {
      await client.end();
    }
  });

  test('wraps an existing Bun SQL instance without owning it', async () => {
    const sql = new (Bun as any).SQL(CONNECTION_STRING);
    const client = new BunClient(sql);

    try {
      const result = await client.query('SELECT 3 AS three');
      expect(result.rows).toEqual([{ three: 3 }]);

      // end() must NOT close a connection the client does not own
      await client.end();
      const afterEnd = await sql.unsafe('SELECT 4 AS four');
      expect(afterEnd[0].four).toBe(4);
    } finally {
      await sql.close();
    }
  });

  test('getDriverName identifies the driver', () => {
    const sql = new (Bun as any).SQL(CONNECTION_STRING);
    const client = new BunClient(sql);
    expect(client.getDriverName()).toBe('bun');
  });
});

describe('BunClient text-results mode (prepare: false)', () => {
  test('decodes native array result columns correctly and reports the capability', async () => {
    const client = new BunClient({ ...DB_CONFIG, prepare: false });

    try {
      expect(client.supportsBinaryArrayResults()).toBe(true);

      // The exact shape that PANICS the runtime in binary mode: a text column
      // whose byte length is not a multiple of 4, followed by an int[] column.
      const result = await client.query(`SELECT 'x'::text AS t, ARRAY[1,2,3] AS a WHERE $1::int = 1`, [1]);
      expect(result.rows).toEqual([{ t: 'x', a: [1, 2, 3] }]);
      expect(Array.isArray(result.rows[0].a)).toBe(true);

      const empty = await client.query(`SELECT '{}'::int[] AS a WHERE $1::int = 1`, [1]);
      expect(empty.rows[0].a).toEqual([]);

      // Value-shape parity with the postgres driver must hold in text mode too
      const shapes = await client.query(
        `SELECT 9007199254740993::bigint AS b, 12.34::numeric AS n WHERE $1::int = 1`,
        [1]
      );
      expect(shapes.rows[0].b).toBe('9007199254740993');
      expect(shapes.rows[0].n).toBe('12.34');

      // Object params must arrive as jsonb objects — Bun's text mode
      // stringifies objects as "[object Object]" without the client's
      // param normalization.
      const jsonbParam = await client.query(
        `SELECT jsonb_typeof($1::jsonb) AS t, $1::jsonb->>'nested' AS v WHERE $2::int = 1`,
        [{ nested: true }, 1]
      );
      expect(jsonbParam.rows[0].t).toBe('object');
      expect(jsonbParam.rows[0].v).toBe('true');
    } finally {
      await client.end();
    }
  });

  test('default (binary) mode reports no native-array support', async () => {
    const client = new BunClient(DB_CONFIG);

    try {
      expect(client.supportsBinaryArrayResults()).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('BunClient datesAsStrings option', () => {
  test('converts Date results to PG-text strings (timestamps) and date-only strings (DATE)', async () => {
    const client = new BunClient({ ...DB_CONFIG, datesAsStrings: true });

    try {
      const result = await client.query(
        `SELECT TIMESTAMPTZ '2024-01-15T10:30:45.123Z' AS ts, DATE '2024-01-15' AS d WHERE $1::int = 1`,
        [1]
      );

      expect(result.rows[0].ts).toBe('2024-01-15 10:30:45.123');
      expect(result.rows[0].d).toBe('2024-01-15');
    } finally {
      await client.end();
    }
  });

  test('default mode keeps Date objects', async () => {
    const client = new BunClient(DB_CONFIG);

    try {
      const result = await client.query(`SELECT TIMESTAMPTZ '2024-01-15T10:30:45.123Z' AS ts WHERE $1::int = 1`, [1]);
      expect(result.rows[0].ts).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });
});

describe('BunClient query contract', () => {
  let client: BunClient;

  beforeAll(async () => {
    client = new BunClient(DB_CONFIG);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (
        id serial PRIMARY KEY,
        label text NOT NULL,
        amount numeric(10, 2),
        payload jsonb
      )
    `);
  });

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    await client.end();
  });

  test('executes parameterized queries with $n placeholders', async () => {
    // jsonb params are passed as raw objects — that is what linkgress sends
    // (no JSON.stringify in the ORM write path; the driver serializes).
    const result = await client.query(
      `INSERT INTO ${PROBE_TABLE} (label, amount, payload) VALUES ($1, $2, $3) RETURNING label, amount, payload`,
      ['param-probe', '12.34', { nested: true }]
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].label).toBe('param-probe');
    expect(result.rows[0].amount).toBe('12.34');
    expect(result.rows[0].payload).toEqual({ nested: true });
  });

  test('pre-stringified JSON into jsonb stays a string scalar (matches postgres.js)', async () => {
    // Both Bun.SQL and postgres.js store a STRING param as a jsonb string
    // scalar — the double-encode trap. Locked in as contract parity: raw-SQL
    // callers must pass objects (or use the driver's json helper), never
    // JSON.stringify the param themselves.
    const result = await client.query(
      `INSERT INTO ${PROBE_TABLE} (label, payload) VALUES ($1, $2) RETURNING jsonb_typeof(payload) AS t`,
      ['double-encode-probe', JSON.stringify({ nested: true })]
    );

    expect(result.rows[0].t).toBe('string');
  });

  test('KNOWN DIVERGENCE: JS array param bound to a native array column fails', async () => {
    // Bun.SQL serializes JS arrays as JSON. That is correct for jsonb targets
    // (covered below) but the server rejects it for native array columns
    // ("insufficient data left in message", 08P01). postgres.js handles this
    // via Describe-informed per-OID serialization, which Bun.SQL lacks.
    // The client cannot tell the two targets apart, so a raw array stays as it is
    // here; linkgress binds a native array COLUMN (`integer('ids').array()`) as a
    // PG array literal instead, which every driver accepts (see
    // array-column-binding.test.ts).
    await client.query(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE}_arr (nums int[])`);

    try {
      let failed = false;

      try {
        await client.query(`INSERT INTO ${PROBE_TABLE}_arr (nums) VALUES ($1)`, [[1, 2, 3]]);
      } catch {
        failed = true;
      }

      expect(failed).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}_arr`);
    }
  });

  test('JS array param into a jsonb column arrives as a jsonb array', async () => {
    const result = await client.query(
      `INSERT INTO ${PROBE_TABLE} (label, payload) VALUES ($1, $2) RETURNING jsonb_typeof(payload) AS t, payload`,
      ['array-to-jsonb', [1, 2, 3]]
    );

    expect(result.rows[0].t).toBe('array');
    expect(result.rows[0].payload).toEqual([1, 2, 3]);
  });

  test('decodes PostgreSQL types the same way the postgres driver does', async () => {
    const result = await client.query(`
      SELECT
        1::int AS int_val,
        9007199254740993::bigint AS bigint_val,
        12.34::numeric AS numeric_val,
        TIMESTAMPTZ '2024-01-15T10:00:00Z' AS tstz_val,
        '{"k": 1}'::jsonb AS jsonb_val,
        ARRAY[1, 2, 3] AS arr_val,
        true AS bool_val,
        NULL::text AS null_val
    `);

    const row = result.rows[0];
    expect(row.int_val).toBe(1);
    // int8 exceeds Number.MAX_SAFE_INTEGER — must arrive as string, not a rounded number
    expect(row.bigint_val).toBe('9007199254740993');
    expect(row.numeric_val).toBe('12.34');
    expect(row.tstz_val).toBeInstanceOf(Date);
    expect((row.tstz_val as Date).toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(row.jsonb_val).toEqual({ k: 1 });
    expect(Array.isArray(row.arr_val)).toBe(true);
    expect(row.arr_val).toEqual([1, 2, 3]);
    expect(row.bool_val).toBe(true);
    expect(row.null_val).toBeNull();
  });

  test('rows are plain arrays/objects (Array.isArray, JSON-safe)', async () => {
    const result = await client.query(`SELECT 1 AS a`);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(JSON.parse(JSON.stringify(result.rows))).toEqual([{ a: 1 }]);
  });
});

/**
 * What BunClient sends for the parameters Bun's SQL client cannot bind itself, in both modes. Bun
 * serializes a Date with Date.prototype.toString() wherever the server does not describe the
 * parameter as a timestamp (a `date` column, a text or untyped parameter) and everywhere in text
 * mode — "Sun Mar 10 2024 01:00:00 GMT+0100 (…)" — and BunClient's text-mode JSON pass used to
 * stringify bytes as `{"0":1,"1":2}`. BunClient sends a Date as its ISO instant (what postgres.js
 * sends) and leaves bytes to Bun.
 */
describe.each([
  ['prepared', true],
  ['text mode', false],
] as const)('BunClient parameters (%s)', (_mode, prepare) => {
  let client: BunClient;

  beforeAll(() => {
    client = new BunClient({ ...DB_CONFIG, prepare });
  });

  afterAll(async () => {
    await client.end();
  });

  const one = async (sql: string, params: unknown[]): Promise<any> => (await client.query(sql, params)).rows[0].v;
  const instant = new Date('2024-03-10T23:30:00.000Z');

  test('a Date into timestamptz is its instant', async () => {
    expect(await one('SELECT CAST($1 AS timestamptz) = TIMESTAMPTZ \'2024-03-10T23:30:00Z\' AS v', [instant])).toBe(true);
  });

  test('a Date into timestamp is its UTC wall time', async () => {
    expect(await one('SELECT CAST(CAST($1 AS timestamp) AS text) AS v', [instant])).toBe('2024-03-10 23:30:00');
  });

  test('a Date into date is its UTC date', async () => {
    expect(await one('SELECT CAST(CAST($1 AS date) AS text) AS v', [new Date('2024-03-10T00:00:00.000Z')])).toBe('2024-03-10');
  });

  test('a Date into text is its ISO instant', async () => {
    expect(await one('SELECT CAST($1 AS text) AS v', [instant])).toBe('2024-03-10T23:30:00.000Z');
  });

  test('bytes into bytea are the bytes', async () => {
    expect(await one('SELECT encode(CAST($1 AS bytea), \'hex\') AS v', [new Uint8Array([0, 1, 255])])).toBe('0001ff');
    expect(await one('SELECT encode(CAST($1 AS bytea), \'hex\') AS v', [Buffer.from([7, 8])])).toBe('0708');
  });

  test('a plain object and an array into jsonb', async () => {
    expect(await one('SELECT CAST($1 AS jsonb) AS v', [{ a: [1, 'x'], b: null }])).toEqual({ a: [1, 'x'], b: null });
    expect(await one('SELECT jsonb_typeof(CAST($1 AS jsonb)) AS v', [[1, 2]])).toBe('array');
  });

  test('a PG array literal into a native array', async () => {
    expect(await one('SELECT CAST(CAST($1 AS int[]) AS text) AS v', ['{1,2,3}'])).toBe('{1,2,3}');
    expect(await one('SELECT array_length(CAST($1 AS text[]), 1) AS v', ['{"a","b,c","d\\"e"}'])).toBe(3);
  });

  test('scalars pass through', async () => {
    expect(await one('SELECT CAST(CAST($1 AS bigint) AS text) AS v', [9007199254740993n])).toBe('9007199254740993');
    expect(await one('SELECT CAST($1 AS boolean) AS v', [true])).toBe(true);
    expect(await one('SELECT CAST($1 AS text) AS v', ['plain'])).toBe('plain');
  });

  test('array result columns read as plain arrays (the binary protocol decodes int4[] / float4[] as typed arrays)', async () => {
    const row = (await client.query(`SELECT
        CAST('{1,2}' AS int4[]) AS i4,
        CAST('{1.5,2}' AS float4[]) AS f4,
        CAST('{9007199254740993,2}' AS int8[]) AS i8,
        CAST('{}' AS int4[]) AS empty,
        CAST(NULL AS int4[]) AS nothing,
        CAST('\\x0102' AS bytea) AS bytes
      WHERE CAST($1 AS integer) = 1`, [1])).rows[0];

    expect(row.i4).toEqual([1, 2]);
    expect(Array.isArray(row.i4)).toBe(true);
    expect(row.f4).toEqual([1.5, 2]);
    expect(row.i8).toEqual(['9007199254740993', '2']);
    expect(row.empty).toEqual([]);
    expect(row.nothing).toBeNull();
    // bytea stays bytes
    expect(Array.from(row.bytes as Uint8Array)).toEqual([1, 2]);
    expect(Array.isArray(row.bytes)).toBe(false);
  });

  test('KNOWN DIVERGENCE: a multidimensional array result cannot be decoded through the binary protocol', async () => {
    // Bun fails the read ("ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET"); text mode decodes it.
    // Writing one works in both (a PG array literal); read it back as text, or use prepare: false.
    let result: unknown;
    let failed = false;

    try {
      result = (await client.query('SELECT CAST(\'{{1,2},{3,4}}\' AS int4[]) AS v WHERE CAST($1 AS integer) = 1', [1])).rows[0].v;
    } catch {
      failed = true;
    }

    if (prepare) {
      expect(failed).toBe(true);
    } else {
      expect(result).toEqual([[1, 2], [3, 4]]);
    }
  });

  test('KNOWN DIVERGENCE: a numeric zero read back through the binary protocol loses its scale', async () => {
    // Bun's binary numeric decoder returns "0" for any zero with a scale ("0.0000", "0.00"); its
    // text decoding, pg and postgres.js keep the digits. Non-zero values keep their scale too.
    // Pinned so a Bun that fixes it shows up here.
    const zero = await one('SELECT CAST(\'0.0000\' AS numeric(20, 4)) AS v WHERE CAST($1 AS integer) = 1', [1]);
    const half = await one('SELECT CAST(\'0.5000\' AS numeric(20, 4)) AS v WHERE CAST($1 AS integer) = 1', [1]);

    expect(zero).toBe(prepare ? '0' : '0.0000');
    expect(half).toBe('0.5000');
  });
});

describe('BunClient transactions', () => {
  let client: BunClient;

  beforeAll(async () => {
    client = new BunClient(DB_CONFIG);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${PROBE_TABLE}_tx (
        id serial PRIMARY KEY,
        label text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}_tx`);
    await client.end();
  });

  test('commits on success', async () => {
    const returned = await client.transaction(async (query) => {
      await query(`INSERT INTO ${PROBE_TABLE}_tx (label) VALUES ($1)`, ['committed']);
      const inTx = await query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}_tx WHERE label = $1`, ['committed']);
      return inTx.rows[0].n;
    });

    expect(returned).toBe(1);

    const after = await client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}_tx WHERE label = $1`, ['committed']);
    expect(after.rows[0].n).toBe(1);
  });

  test('rolls back when the callback throws', async () => {
    let thrown: Error | null = null;

    try {
      await client.transaction(async (query) => {
        await query(`INSERT INTO ${PROBE_TABLE}_tx (label) VALUES ($1)`, ['rolled-back']);
        throw new Error('trigger rollback');
      });
    } catch (error: any) {
      thrown = error;
    }

    expect(thrown?.message).toBe('trigger rollback');

    const after = await client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}_tx WHERE label = $1`, ['rolled-back']);
    expect(after.rows[0].n).toBe(0);
  });
});

describe('BunClient pooled connections', () => {
  test('connect() returns a connection pinned to one session', async () => {
    const client = new BunClient(DB_CONFIG);

    try {
      const conn = await client.connect();
      // TEMP tables are session-scoped: visible on the second query only if
      // both queries really run on the same reserved connection.
      await conn.query(`CREATE TEMP TABLE bun_reserved_probe (id int)`);
      await conn.query(`INSERT INTO bun_reserved_probe VALUES (42)`);
      const result = await conn.query(`SELECT id FROM bun_reserved_probe`);
      expect(result.rows).toEqual([{ id: 42 }]);
      await conn.query(`DROP TABLE bun_reserved_probe`);
      conn.release();
    } finally {
      await client.end();
    }
  });
});

describe('BunClient multi-statement queries', () => {
  let client: BunClient;

  beforeAll(() => {
    client = new BunClient(DB_CONFIG);
  });

  afterAll(async () => {
    await client.end();
  });

  test('supportsMultiStatementQueries is true', () => {
    expect(client.supportsMultiStatementQueries()).toBe(true);
  });

  test('querySimple returns the last result set', async () => {
    const result = await client.querySimple(`SELECT 1 AS a; SELECT 2 AS b`);
    expect(result.rows).toEqual([{ b: 2 }]);
  });

  test('querySimpleMulti returns all result sets in order', async () => {
    const results = await client.querySimpleMulti(`SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c`);
    expect(results.length).toBe(3);
    expect(results[0].rows).toEqual([{ a: 1 }]);
    expect(results[1].rows).toEqual([{ b: 2 }]);
    expect(results[2].rows).toEqual([{ c: 3 }]);
  });
});
