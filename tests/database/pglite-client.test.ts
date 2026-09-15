import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { PGlite } from '@electric-sql/pglite';
import { PGliteClient } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { expectToReject } from '../utils/expect-rejects';
import { seedTestData } from '../utils/test-database';

/**
 * PGlite loads its WASM and data bundles through dynamic `import()`, which jest's vm
 * context only allows under `--experimental-vm-modules` (`pnpm test:pglite` passes it;
 * Bun runs it natively). Without the flag these specs are skipped, not failed.
 */
const canLoadPGlite =
  typeof (globalThis as any).Bun !== 'undefined' ||
  process.execArgv.includes('--experimental-vm-modules') ||
  (process.env.NODE_OPTIONS ?? '').includes('--experimental-vm-modules');

const describePGlite = canLoadPGlite ? describe : describe.skip;

/** Ample time for a query that is NOT held back to run to completion (they take < 1 ms). */
const letUnblockedQueriesRun = () => new Promise(resolve => setTimeout(resolve, 50));

let emptyDatabase: Promise<Blob> | undefined;

/**
 * The data directory of an empty database. Throwaway instances boot from it in ~0.15 s instead of
 * running initdb each (~0.8 s); one spec below keeps the initdb path.
 */
const emptyDataDir = (): Promise<Blob> =>
  (emptyDatabase ??= (async () => {
    const pglite = new PGlite();

    try {
      return await pglite.dumpDataDir('none');
    } finally {
      await pglite.close();
    }
  })());

describePGlite('PGliteClient', () => {
  let client: PGliteClient;

  beforeAll(async () => {
    client = new PGliteClient({ loadDataDir: await emptyDataDir() });
  });

  afterAll(async () => {
    await client.end();
  });

  test('rowCount follows pg: rows returned for SELECT, rows affected for DML, null for DDL', async () => {
    const ddl = await client.query('CREATE TABLE rowcount_probe (id int)');
    expect(ddl.rowCount).toBeNull();

    expect((await client.query('INSERT INTO rowcount_probe VALUES (1), (2), (3)')).rowCount).toBe(3);
    expect((await client.query('UPDATE rowcount_probe SET id = id + 10 WHERE id > $1', [1])).rowCount).toBe(2);

    const selected = await client.query('SELECT id FROM rowcount_probe ORDER BY id');
    expect(selected.rows).toEqual([{ id: 1 }, { id: 12 }, { id: 13 }]);
    expect(selected.rowCount).toBe(3);
  });

  test('int8 values arrive as strings, like pg / postgres.js / Bun, exact beyond 2^53', async () => {
    const result = await client.query(
      `SELECT 3::int8 AS small, 9007199254740993::int8 AS unsafe, ARRAY[1, 2]::int8[] AS list, count(*) AS n
       FROM (VALUES (1), (2)) AS v(x)`
    );

    expect(result.rows).toEqual([{ small: '3', unsafe: '9007199254740993', list: ['1', '2'], n: '2' }]);
  });

  test('bytea arrives as a Buffer, like pg and postgres.js', async () => {
    const result = await client.query(`SELECT '\\x00ff48'::bytea AS bin, ARRAY['\\x01'::bytea] AS list, $1::bytea AS param`, [
      Buffer.from([7, 8]),
    ]);
    const { bin, list, param } = result.rows[0];

    expect(Buffer.isBuffer(bin)).toBe(true);
    expect([...bin]).toEqual([0, 255, 72]);
    expect(Buffer.isBuffer(list[0])).toBe(true);
    expect([...list[0]]).toEqual([1]);
    expect(Buffer.isBuffer(param)).toBe(true);
    expect([...param]).toEqual([7, 8]);
  });

  test('a Date parameter lands as its LOCAL calendar day and wall-clock time, like pg and postgres.js', async () => {
    // Off UTC one of these crosses the UTC day boundary: 00:30 local is still the previous
    // UTC day east of Greenwich, 23:30 local already the next one west of it. (On a UTC host
    // local and UTC coincide, so this cannot fail there.)
    const early = new Date(2026, 7, 11, 0, 30);
    const late = new Date(2026, 7, 11, 23, 30, 15, 250);

    const { rows } = await client.query(
      `SELECT $1::date::text AS early_day, $2::date::text AS late_day,
              $3::timestamp::text AS early_wall_clock, $4::timestamp AS late_timestamp, $5::timestamptz AS late_instant`,
      [early, late, early, late, late]
    );

    expect(rows[0].early_day).toBe('2026-08-11');
    expect(rows[0].late_day).toBe('2026-08-11');
    expect(rows[0].early_wall_clock).toBe('2026-08-11 00:30:00');
    expect(rows[0].late_timestamp.getTime()).toBe(late.getTime());
    expect(rows[0].late_instant.getTime()).toBe(late.getTime());
  });

  test('int8 parity also covers the simple-protocol path (querySimple)', async () => {
    const result = await client.querySimple('SELECT 7::int8 AS v');

    expect(result.rows).toEqual([{ v: '7' }]);
  });

  test('querySimpleMulti returns one result set per statement, row-less statements included', async () => {
    const sets = await client.querySimpleMulti(`
      CREATE TEMP TABLE multi_probe (x int);
      INSERT INTO multi_probe VALUES (2), (1);
      SELECT x FROM multi_probe ORDER BY x;
      DROP TABLE multi_probe
    `);

    // The fully-optimized path indexes these positionally: [0]=CREATE, [1]=base, ..., [N]=DROP.
    expect(sets.map(set => set.rows)).toEqual([[], [], [{ x: 1 }, { x: 2 }], []]);
  });

  test('querySimple returns the last row-bearing result set, not the trailing cleanup', async () => {
    const result = await client.querySimple(`
      CREATE TEMP TABLE simple_probe (x int);
      INSERT INTO simple_probe VALUES (5);
      SELECT x FROM simple_probe;
      DROP TABLE simple_probe
    `);

    expect(result.rows).toEqual([{ x: 5 }]);
  });

  test('transaction() commits when the callback resolves', async () => {
    await client.query('CREATE TABLE tx_commit_probe (id int)');

    const returned = await client.transaction(async query => {
      await query('INSERT INTO tx_commit_probe VALUES ($1)', [1]);
      return 'done';
    });

    expect(returned).toBe('done');
    expect((await client.query('SELECT id FROM tx_commit_probe')).rows).toEqual([{ id: 1 }]);
  });

  test('transaction() rolls back and rethrows when the callback throws', async () => {
    await client.query('CREATE TABLE tx_rollback_probe (id int)');

    await expectToReject(
      client.transaction(async query => {
        await query('INSERT INTO tx_rollback_probe VALUES (1)');
        throw new Error('abort unit of work');
      }),
      'abort unit of work'
    );

    expect((await client.query('SELECT id FROM tx_rollback_probe')).rows).toEqual([]);
  });

  test('connect() leases the single session: other queries wait for release()', async () => {
    await client.query('CREATE TABLE lease_probe (id int)');

    const conn = await client.connect();
    await conn.query('BEGIN');
    await conn.query('INSERT INTO lease_probe VALUES (1)');

    // Issued while the lease is held. Were it to run now it would land INSIDE the open
    // transaction (PGlite has exactly one session) and count the uncommitted row.
    const outside = client.query('SELECT count(*)::int AS n FROM lease_probe');
    await letUnblockedQueriesRun();

    await conn.query('ROLLBACK');
    conn.release();

    expect((await outside).rows).toEqual([{ n: 0 }]);
  });

  test('a call that would queue behind its own transaction fails at once instead of waiting forever', async () => {
    // One session: inside a transaction callback a root-level call can only run once the
    // transaction ends — which it never does while the callback awaits that very call.
    await expectToReject(
      client.transaction(async () => {
        await client.query('SELECT 1');
      }),
      'single session'
    );

    expect((await client.query('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
  }, 5000);

  test('errors keep their PostgreSQL SQLSTATE', async () => {
    const error = await expectToReject(client.query('SELECT * FROM no_such_table_probe'), 'does not exist');

    expect(error.code).toBe('42P01');
  });
});

describePGlite('PGliteClient instance ownership', () => {
  test('end() closes an instance the client created', async () => {
    const client = new PGliteClient();
    await client.query('SELECT 1');

    await client.end();

    expect(client.getPGlite().closed).toBe(true);
  });

  test('a caller-supplied instance keeps its own parsers and stays open after end()', async () => {
    const pglite = new PGlite({ loadDataDir: await emptyDataDir(), parsers: { 20: (value: string) => BigInt(value) } });

    try {
      const client = new PGliteClient(pglite);
      expect((await client.query('SELECT 3::int8 AS v')).rows).toEqual([{ v: 3n }]);

      await client.end();

      expect(pglite.closed).toBe(false);
      expect((await pglite.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      await pglite.close();
    }
  });

  test('clients over one PGlite instance share its session lease', async () => {
    const pglite = new PGlite({ loadDataDir: await emptyDataDir() });

    try {
      const leaseholder = new PGliteClient(pglite);
      const other = new PGliteClient(pglite);
      await other.query('CREATE TABLE shared_lease_probe (id int)');

      const conn = await leaseholder.connect();
      await conn.query('BEGIN');
      await conn.query('INSERT INTO shared_lease_probe VALUES (1)');

      // Another client, same session: it must wait for the lease just the same.
      const outside = other.query('SELECT count(*)::int AS n FROM shared_lease_probe');
      await letUnblockedQueriesRun();

      await conn.query('ROLLBACK');
      conn.release();

      expect((await outside).rows).toEqual([{ n: 0 }]);
    } finally {
      await pglite.close();
    }
  });

  test('a second transaction over the same instance, opened inside the first, fails at once', async () => {
    const pglite = new PGlite({ loadDataDir: await emptyDataDir() });

    try {
      const first = new PGliteClient(pglite);
      const second = new PGliteClient(pglite);

      await expectToReject(
        first.transaction(async () => {
          await second.transaction(async () => undefined);
        }),
        'single session'
      );
    } finally {
      await pglite.close();
    }
  }, 5000);

  test('parsers passed in the options override the int8-as-string default', async () => {
    const client = new PGliteClient({ loadDataDir: await emptyDataDir(), parsers: { 20: (value: string) => BigInt(value) } });

    try {
      expect((await client.query('SELECT 3::int8 AS v')).rows).toEqual([{ v: 3n }]);
    } finally {
      await client.end();
    }
  });
});

describePGlite('PGliteClient under a DbContext', () => {
  test('a collection read through the multi-statement path returns the seeded rows', async () => {
    const db = new AppDatabase(new PGliteClient({ loadDataDir: await emptyDataDir() }), { collectionStrategy: 'temptable' });

    try {
      await db.getSchemaManager().ensureCreated();
      await seedTestData(db);

      const users = await db.users
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({ title: p.title, views: p.views }))
            .orderBy(p => [[p.views, 'DESC']])
            .toList('posts'),
        }))
        .orderBy(u => [[u.username, 'ASC']])
        .toList();

      expect(users).toEqual([
        { username: 'alice', posts: [{ title: 'Alice Post 2', views: 150 }, { title: 'Alice Post 1', views: 100 }] },
        { username: 'bob', posts: [{ title: 'Bob Post', views: 200 }] },
        { username: 'charlie', posts: [] },
      ]);
    } finally {
      await db.dispose();
    }
  });
});
