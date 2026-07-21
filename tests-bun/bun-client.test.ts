/**
 * BunClient contract tests — run with `bun test tests-bun` (Bun runtime only).
 *
 * These cannot live in the jest suite: jest runs under Node, where Bun's SQL
 * client does not exist. The suite proves BunClient satisfies the same
 * DatabaseClient contract the jest suite exercises through PgClient.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BunClient } from '../src';

const DB_CONFIG = {
  hostname: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
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
    // Consequence: linkgress `array()` columns are unsupported on BunClient
    // until the array() mapper serializes to a PG array literal itself.
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
