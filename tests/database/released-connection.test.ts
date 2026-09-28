import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as linkgress from '../../src';
import { BunClient, DatabaseClient, PgClient, PGliteClient, PostgresClient } from '../../src';
import type { PooledConnection } from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';

/**
 * A `PooledConnection` from `client.connect()` used after its `release()`. Every driver's connection object kept
 * running statements on the session it had handed back — which the pool may already have given to another caller,
 * in the middle of that caller's transaction (PGlite: on its one session, outside the session lock). A statement
 * issued after `release()` is now refused with a `ConnectionReleasedError` (exported; `.sql` = the refused text)
 * before it reaches the database. A statement issued before `release()` completes; a second `release()` behaves as
 * it always did per driver; leases in use, fresh leases and the client itself are untouched.
 *
 * `ConnectionReleasedError` is read from the package namespace, so that on a build without it the file still loads
 * and every test reports its own outcome.
 *
 * Domain: postcards and their stamps.
 */

const driver = (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase();

/** PGlite runs ONE session: two leases cannot be held at once there. */
const concurrentSessions = driver !== 'pglite';

/** Today's second release(): node-postgres's pool throws; postgres.js, Bun.SQL and PGlite ignore it. */
const DOUBLE_RELEASE_THROWS = driver === 'pg';

const RELEASED = 'this connection has already been released';

/** A client of the run's driver whose pool holds `max` connections (PGlite: its one session, by nature). */
function clientWithPoolOf(max: number): DatabaseClient {
  const { host, port, database, username, password } = testConnectionConfig();

  if (driver === 'pglite') {
    return createFreshClient();
  }

  if (driver === 'bun') {
    return new BunClient({ hostname: host, port, database, username, password, max, prepare: process.env.LINKGRESS_TEST_BUN_PREPARE !== 'false' });
  }

  if (driver === 'postgres') {
    return new PostgresClient({ host, port, database, username, password, max });
  }

  return new PgClient({ host, port, database, user: username, password, max });
}

/** `work` is refused with a ConnectionReleasedError. */
async function expectReleased(work: PromiseLike<unknown>): Promise<any> {
  const error = await expectToReject(work, RELEASED);
  expect(error.name).toBe('ConnectionReleasedError');
  expect(error).toBeInstanceOf((linkgress as any).ConnectionReleasedError);
  return error;
}

/** How a call ended: its value, or the error it threw (never rejects). */
async function outcomeOf<T>(work: () => T | PromiseLike<T>): Promise<{ value?: T; error?: any }> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Ends a client without waiting forever on a statement the old behaviour left queued. */
const endQuickly = (client: DatabaseClient) => Promise.race([client.end(), sleep(3000)]);

async function createPostcards(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS "relconn_postcards"');
  await client.query('CREATE TABLE "relconn_postcards" (note text NOT NULL)');
}

async function resetPostcards(client: DatabaseClient): Promise<void> {
  await client.query('TRUNCATE TABLE "relconn_postcards"');
  await client.query('DROP SEQUENCE IF EXISTS "relconn_stamp_seq"');
  await client.query('CREATE SEQUENCE "relconn_stamp_seq"');
}

async function notesOf(client: DatabaseClient): Promise<string[]> {
  const result = await client.query<{ note: string }>('SELECT note FROM "relconn_postcards" ORDER BY note');
  return result.rows.map(row => row.note);
}

describe('a pooled connection used after release()', () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createFreshClient();
    await createPostcards(client);
  });

  beforeEach(async () => {
    await resetPostcards(client);
  });

  afterAll(async () => {
    try {
      await client.query('DROP TABLE IF EXISTS "relconn_postcards"');
      await client.query('DROP SEQUENCE IF EXISTS "relconn_stamp_seq"');
    } finally {
      await client.end();
    }
  });

  describe('every statement is refused', () => {
    test('a SELECT: a ConnectionReleasedError carrying the statement', async () => {
      const connection = await client.connect();
      connection.release();

      const error = await expectReleased(connection.query('SELECT 1 AS late'));
      expect(error.sql).toBe('SELECT 1 AS late');
      expect(error.message).toContain('acquire a new one with connect()');
    });

    test('a write — and nothing is written', async () => {
      const connection = await client.connect();
      connection.release();

      await expectReleased(connection.query('INSERT INTO "relconn_postcards" (note) VALUES (\'late\')'));
      expect(await notesOf(client)).toEqual([]);
    });

    test('a statement with parameters: the SQL is carried, the values are not', async () => {
      const connection = await client.connect();
      connection.release();

      const error = await expectReleased(connection.query('INSERT INTO "relconn_postcards" (note) VALUES ($1)', ['private-value']));
      expect(error.sql).toBe('INSERT INTO "relconn_postcards" (note) VALUES ($1)');
      expect(error.message).not.toContain('private-value');
      expect(await notesOf(client)).toEqual([]);
    });

    test('every later statement too, not only the first', async () => {
      const connection = await client.connect();
      connection.release();

      await expectReleased(connection.query('SELECT 1 AS first'));
      await expectReleased(connection.query('SELECT 2 AS second'));
      await expectReleased(connection.query('SELECT 3 AS third', [], { timeoutMs: 1000 }));
    });

    test('the statement never reaches the database: a sequence it would draw from does not move', async () => {
      const connection = await client.connect();
      connection.release();

      await expectReleased(connection.query('SELECT nextval(\'"relconn_stamp_seq"\') AS stamp'));
      const drawn = await client.query<{ stamp: string }>('SELECT nextval(\'"relconn_stamp_seq"\')::text AS stamp');
      expect(drawn.rows).toEqual([{ stamp: '1' }]);
    });

    test('a transaction begun on it (BEGIN) is refused: the pool\'s next caller autocommits as usual', async () => {
      const pool = clientWithPoolOf(1);

      try {
        const kept = await pool.connect();
        kept.release();
        await expectReleased(kept.query('BEGIN'));

        // with a pool of one, the next lease is the same connection: it must not be inside a transaction
        const next = await pool.connect();
        await next.query('INSERT INTO "relconn_postcards" (note) VALUES (\'autocommitted\')');
        next.release();

        expect(await notesOf(client)).toEqual(['autocommitted']);
      } finally {
        await pool.query('ROLLBACK').catch(() => undefined);
        await endQuickly(pool);
      }
    });
  });

  describe('pool of ONE: a released connection can no longer reach the next caller', () => {
    test('a statement while another caller\'s transaction holds the connection is refused — not run inside it', async () => {
      const pool = clientWithPoolOf(1);

      try {
        const kept = await pool.connect();
        kept.release();

        let opened!: () => void;
        let finish!: () => void;
        const isOpen = new Promise<void>(resolve => {
          opened = resolve;
        });
        const finished = new Promise<void>(resolve => {
          finish = resolve;
        });
        const other = pool.transaction(async query => {
          await query('INSERT INTO "relconn_postcards" (note) VALUES (\'mine\')');
          opened();
          await finished;
          const seen = await query('SELECT note FROM "relconn_postcards" ORDER BY note');
          return seen.rows.map((row: any) => row.note);
        });
        other.catch(() => undefined);
        await isOpen;

        // beside the other caller's transaction (before the fix it ran inside it)
        const stray = outcomeOf(() => kept.query('INSERT INTO "relconn_postcards" (note) VALUES (\'stray\')'));
        const strayOutcome: { value?: unknown; error?: any } = await Promise.race([stray, sleep(300).then(() => ({ value: 'still waiting' }))]);
        finish();

        expect(await other).toEqual(['mine']);
        expect(strayOutcome.error?.name).toBe('ConnectionReleasedError');
        expect(await notesOf(client)).toEqual(['mine']);
      } finally {
        await endQuickly(pool);
      }
    });

    test('a SECOND release() never frees the session another caller holds: the next caller waits, that transaction stays intact', async () => {
      const pool = clientWithPoolOf(1);

      try {
        const a = await pool.connect();
        a.release();

        // B: the pool's one session, inside a transaction with an uncommitted row
        const b = await pool.connect();
        await b.query('BEGIN');
        await b.query('INSERT INTO "relconn_postcards" (note) VALUES (\'b uncommitted\')');

        const secondRelease = await outcomeOf(() => a.release());

        // C must wait for B — the second release of A must not have handed B's session on
        const c = pool.connect();
        const cOutcome = await Promise.race([c.then(() => 'got the session'), sleep(300).then(() => 'waiting')]);

        const bSees = await b.query<{ note: string }>('SELECT note FROM "relconn_postcards" ORDER BY note');
        await b.query('ROLLBACK');
        b.release();

        const cLease = await c;
        const cSees = await cLease.query<{ n: number }>('SELECT count(*)::int AS n FROM "relconn_postcards"');
        const cRelease = await outcomeOf(() => cLease.release());

        if (DOUBLE_RELEASE_THROWS) {
          expect(secondRelease.error?.message).toBe('Release called on client which has already been released to the pool.');
        } else {
          expect(secondRelease).toEqual({ value: undefined });
        }
        expect(cOutcome).toBe('waiting');
        expect(bSees.rows).toEqual([{ note: 'b uncommitted' }]);
        expect(cSees.rows).toEqual([{ n: 0 }]);
        expect(cRelease).toEqual({ value: undefined });
      } finally {
        await pool.query('ROLLBACK').catch(() => undefined);
        await endQuickly(pool);
      }
    });

    test('it cannot change the session state of the connection\'s next lease', async () => {
      const pool = clientWithPoolOf(1);

      try {
        const kept = await pool.connect();
        kept.release();

        const next = await pool.connect();
        await next.query('SET application_name = \'next_lease\'');
        const stray = await outcomeOf(() => kept.query('SET application_name = \'released_lease\''));
        const seen = await next.query<{ application_name: string }>('SHOW application_name');
        next.release();

        expect(stray.error?.name).toBe('ConnectionReleasedError');
        expect(seen.rows).toEqual([{ application_name: 'next_lease' }]);
      } finally {
        await endQuickly(pool);
      }
    });
  });

  describe('what stays as it was', () => {
    test('a statement issued before release() completes, also when it is still running at release()', async () => {
      const connection = await client.connect();
      const inFlight = connection.query<{ state: string }>('SELECT \'in flight\' AS state');
      connection.release();

      expect((await inFlight).rows).toEqual([{ state: 'in flight' }]);
    });

    test('a write issued before release() completes and commits', async () => {
      const connection = await client.connect();
      const inFlight = connection.query('INSERT INTO "relconn_postcards" (note) VALUES (\'posted\')');
      connection.release();

      expect((await inFlight).rowCount).toBe(1);
      expect(await notesOf(client)).toEqual(['posted']);
    });

    test('a second release() behaves as before (node-postgres throws, the other drivers ignore it); the pool works on', async () => {
      const connection = await client.connect();
      connection.release();

      const second = await outcomeOf(() => connection.release());

      if (DOUBLE_RELEASE_THROWS) {
        expect(second.error?.message).toBe('Release called on client which has already been released to the pool.');
      } else {
        expect(second).toEqual({ value: undefined });
      }

      const fresh = await client.connect();
      expect((await fresh.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      fresh.release();
      await expectReleased(connection.query('SELECT 1 AS after_double_release'));
    });

    test('in use, a lease\'s statements share one session', async () => {
      const connection = await client.connect();

      try {
        await connection.query('SET application_name = \'postcard_lease\'');
        await connection.query('CREATE TEMP TABLE "relconn_scratch" (n int)');
        await connection.query('INSERT INTO "relconn_scratch" VALUES (1), (2)');

        expect((await connection.query('SHOW application_name')).rows).toEqual([{ application_name: 'postcard_lease' }]);
        expect((await connection.query<{ n: number }>('SELECT count(*)::int AS n FROM "relconn_scratch"')).rows).toEqual([{ n: 2 }]);
        await connection.query('DROP TABLE "relconn_scratch"');
      } finally {
        connection.release();
      }
    });

    test('a fresh connect() after a release() leases a working connection', async () => {
      const first = await client.connect();
      first.release();

      const fresh = await client.connect();

      try {
        await fresh.query('INSERT INTO "relconn_postcards" (note) VALUES (\'fresh lease\')');
        // through the lease itself: on PGlite a client query would wait for this lease's release()
        expect((await fresh.query('SELECT note FROM "relconn_postcards"')).rows).toEqual([{ note: 'fresh lease' }]);
      } finally {
        fresh.release();
      }

      expect(await notesOf(client)).toEqual(['fresh lease']);
      await expectReleased(first.query('SELECT 1 AS still_released'));
    });

    test('the client itself — query() and transaction() — is unaffected', async () => {
      const connection = await client.connect();
      connection.release();
      await expectReleased(connection.query('SELECT 1 AS refused'));

      expect((await client.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      const inTransaction = await client.transaction(async query => {
        await query('INSERT INTO "relconn_postcards" (note) VALUES (\'in a transaction\')');
        return (await query('SELECT count(*)::int AS n FROM "relconn_postcards"')).rows;
      });
      expect(inTransaction).toEqual([{ n: 1 }]);
      expect(await notesOf(client)).toEqual(['in a transaction']);
    });

    test('a statement that failed before release(): the lease is released as usual and refused after', async () => {
      const connection = await client.connect();
      await expectToReject(connection.query('SELECT 1 / 0 AS impossible'), 'division by zero');
      connection.release();

      await expectReleased(connection.query('SELECT 1 AS after_failure'));
      expect((await client.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    });

    test.skipIf(!concurrentSessions)('two leases at once: releasing one leaves the other working', async () => {
      const pool = clientWithPoolOf(2);

      try {
        const first = await pool.connect();
        const second = await pool.connect();
        first.release();

        await expectReleased(first.query('SELECT 1 AS released'));
        expect((await second.query<{ two: number }>('SELECT 2 AS two')).rows).toEqual([{ two: 2 }]);
        second.release();
      } finally {
        await endQuickly(pool);
      }
    });
  });
});

describe('PGlite, one session: a lease used after release()', () => {
  let lite: PGliteClient;

  beforeAll(async () => {
    lite = new PGliteClient();
    await createPostcards(lite);
  });

  beforeEach(async () => {
    await resetPostcards(lite);
  });

  afterAll(async () => {
    await lite.end();
  });

  test('a released lease\'s statement is refused instead of running outside the session lock', async () => {
    const lease = await lite.connect();
    lease.release();

    await expectReleased(lease.query('INSERT INTO "relconn_postcards" (note) VALUES (\'late\')'));
    expect(await notesOf(lite)).toEqual([]);
  });

  test('it cannot run inside the next leaseholder\'s transaction', async () => {
    const kept = await lite.connect();
    kept.release();

    const next = await lite.connect();
    await next.query('BEGIN');
    await next.query('INSERT INTO "relconn_postcards" (note) VALUES (\'mine\')');
    const stray = await outcomeOf(() => kept.query('INSERT INTO "relconn_postcards" (note) VALUES (\'stray\')'));
    const seen = await next.query<{ note: string }>('SELECT note FROM "relconn_postcards" ORDER BY note');
    await next.query('COMMIT');
    next.release();

    expect(stray.error?.name).toBe('ConnectionReleasedError');
    expect(seen.rows).toEqual([{ note: 'mine' }]);
    expect(await notesOf(lite)).toEqual(['mine']);
  });

  test('a second release() stays a no-op; the next connect() works', async () => {
    const lease = await lite.connect();
    lease.release();

    expect(await outcomeOf(() => lease.release())).toEqual({ value: undefined });
    const fresh = await lite.connect();
    expect((await fresh.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    fresh.release();
  });

  test('a statement issued before release() completes', async () => {
    const lease = await lite.connect();
    const inFlight = lease.query<{ state: string }>('SELECT \'in flight\' AS state');
    lease.release();

    expect((await inFlight).rows).toEqual([{ state: 'in flight' }]);
  });
});
