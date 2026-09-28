import { describe, test, expect, afterEach } from 'bun:test';
import type { DatabaseClient, PooledConnection } from '../../src';
import { sqlStateOf } from '../../src/database/sql-state';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';

/**
 * A session's sequence state — `lastval()` and `currval()` — as PostgreSQL keeps it, on every engine the suite runs
 * (PostgreSQL, the in-memory engine, PGlite):
 *
 * - `lastval()` is the session's value of the sequence its last `nextval()` drew from (`setval()` never makes a
 *   sequence the "last used" one, but moves the value `currval()` / `lastval()` read for it);
 * - it is looked up at call time: once that sequence is gone — dropped, also by `DROP TABLE` of its owner or a
 *   CASCADE, or by the caller's own uncommitted DROP — `lastval()` fails with 55000 `lastval is not yet defined in
 *   this session`, even when another sequence drawn earlier still exists;
 * - `DISCARD SEQUENCES` / `DISCARD ALL` forget all of it.
 *
 * The in-memory engine kept one value, set by `nextval()` AND `setval()`, never checked against the catalog nor
 * reset by DISCARD. Every test runs its statements on ONE pinned session (`client.connect()`); `--parity` compares
 * the engines test by test.
 *
 * Domain: an observatory's catalogue numbers.
 */

/** PGlite runs ONE session: a second session cannot be shown there. */
const concurrentSessions = process.env.LINKGRESS_TEST_DRIVER !== 'pglite';

const COMET = '"sss_comet_seq"';
const METEOR = '"sss_meteor_seq"';
const RENAMED = '"sss_renamed_seq"';
const SIGHTINGS = '"sss_sightings"';

const NOT_YET_DEFINED = 'lastval is not yet defined in this session';

let client: DatabaseClient | null = null;
const sessions: PooledConnection[] = [];

/** A pinned session on a client of its own: a fresh session state (PGlite: its one shared session). */
async function openSession(): Promise<PooledConnection> {
  client ??= createFreshClient();
  const session = await client.connect();
  sessions.push(session);
  return session;
}

afterEach(async () => {
  const cleanup = sessions[0];

  if (cleanup) {
    await cleanup.query('ROLLBACK').catch(() => undefined);
    await cleanup.query(`DROP TABLE IF EXISTS ${SIGHTINGS}`);
    await cleanup.query(`DROP SEQUENCE IF EXISTS ${COMET}, ${METEOR}, ${RENAMED}`);
  }

  for (const session of sessions.splice(0)) {
    session.release();
  }

  if (client) {
    await client.end();
    client = null;
  }
});

/** The single value of a one-row, one-column statement, as text. */
async function valueOf(session: PooledConnection, sql: string): Promise<string> {
  const result = await session.query(sql);
  return String(Object.values(result.rows[0])[0]);
}

/** `SELECT lastval()` fails with PostgreSQL's 55000. */
async function expectNoLastval(session: PooledConnection): Promise<void> {
  const error = await expectToReject(session.query('SELECT lastval()::text AS value'), NOT_YET_DEFINED);
  expect(sqlStateOf(error)).toBe('55000');
}

/** `SELECT currval(<name>)` fails with PostgreSQL's 55000 for that sequence. */
async function expectNoCurrval(session: PooledConnection, quotedName: string): Promise<void> {
  const error = await expectToReject(
    session.query(`SELECT currval('${quotedName}')::text AS value`),
    `currval of sequence "${quotedName.replace(/"/g, '')}" is not yet defined in this session`
  );
  expect(sqlStateOf(error)).toBe('55000');
}

describe('a session\'s sequence state: lastval() and currval()', () => {
  describe('lastval() follows the last nextval()', () => {
    test('a fresh session has none: 55000', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);

      await expectNoLastval(session);
    });

    test('it is the value the session\'s last nextval() drew, whichever sequence', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET} START WITH 10`);
      await session.query(`CREATE SEQUENCE ${METEOR} START WITH 500`);

      expect(await valueOf(session, `SELECT nextval('${COMET}')`)).toBe('10');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('10');
      expect(await valueOf(session, `SELECT nextval('${METEOR}')`)).toBe('500');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('500');
      expect(await valueOf(session, `SELECT nextval('${COMET}')`)).toBe('11');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('11');
    });

    test('a nextval() that fails (an exhausted sequence) leaves lastval() at the last good draw', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET} MINVALUE 1 MAXVALUE 2`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT nextval('${COMET}')`);

      const exhausted = await expectToReject(session.query(`SELECT nextval('${COMET}')`), 'reached maximum value of sequence "sss_comet_seq" (2)');
      expect(sqlStateOf(exhausted)).toBe('2200H');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('2');
    });

    test('a nextval() in a transaction that rolls back still counts: sequences are not transactional', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query('BEGIN');
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('ROLLBACK');

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
    });

    test('lastval() reads in a READ ONLY transaction', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('BEGIN READ ONLY');

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      await session.query('COMMIT');
    });

    test.skipIf(!concurrentSessions)('lastval() is per session: another session\'s draws neither define nor move it', async () => {
      const first = await openSession();
      const second = await openSession();
      await first.query(`CREATE SEQUENCE ${COMET}`);

      expect(await valueOf(first, `SELECT nextval('${COMET}')`)).toBe('1');
      await expectNoLastval(second);
      expect(await valueOf(second, `SELECT nextval('${COMET}')`)).toBe('2');
      expect(await valueOf(first, 'SELECT lastval()')).toBe('1');
      expect(await valueOf(second, 'SELECT lastval()')).toBe('2');
    });
  });

  describe('setval() moves a sequence\'s value but never makes it the last used one', () => {
    test('setval(…, true) on ANOTHER sequence leaves lastval() alone and sets that sequence\'s currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`CREATE SEQUENCE ${METEOR}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT setval('${METEOR}', 50, true)`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      expect(await valueOf(session, `SELECT currval('${METEOR}')`)).toBe('50');
    });

    test('setval(…, true) on the last-used sequence moves lastval() with its currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT setval('${COMET}', 50, true)`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('50');
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('50');
    });

    test('setval(…, false) leaves lastval() and currval() at the last draw', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT setval('${COMET}', 50, false)`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('1');
      expect(await valueOf(session, `SELECT nextval('${COMET}')`)).toBe('50');
    });

    test('setval() alone never defines lastval() (55000), though it defines currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT setval('${COMET}', 5, true)`);

      await expectNoLastval(session);
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('5');
    });
  });

  describe('a dropped sequence takes its lastval() along', () => {
    test('DROP SEQUENCE of the last-used sequence: 55000', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`DROP SEQUENCE ${COMET}`);

      await expectNoLastval(session);
    });

    test('…also when a sequence drawn earlier still exists — its currval() still reads', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`CREATE SEQUENCE ${METEOR} START WITH 70`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT nextval('${METEOR}')`);
      await session.query(`DROP SEQUENCE ${METEOR}`);

      await expectNoLastval(session);
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('1');
    });

    test('dropping an OLDER sequence leaves lastval() alone', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`CREATE SEQUENCE ${METEOR} START WITH 70`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT nextval('${METEOR}')`);
      await session.query(`DROP SEQUENCE ${COMET}`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('70');
    });

    test('a sequence recreated under the same name is a NEW sequence: no lastval(), no currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`DROP SEQUENCE ${COMET}`);
      await session.query(`CREATE SEQUENCE ${COMET}`);

      await expectNoLastval(session);
      await expectNoCurrval(session, COMET);
    });

    test('the session\'s own uncommitted DROP hides lastval() inside the transaction; the ROLLBACK brings it back', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('BEGIN');
      await session.query(`DROP SEQUENCE ${COMET}`);

      await expectNoLastval(session);
      await session.query('ROLLBACK');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
    });

    test('DROP TABLE drops its serial sequence, and lastval() with it', async () => {
      const session = await openSession();
      await session.query(`CREATE TABLE ${SIGHTINGS} (id serial, note text)`);
      await session.query(`INSERT INTO ${SIGHTINGS} (note) VALUES ('first light')`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      await session.query(`DROP TABLE ${SIGHTINGS}`);
      await expectNoLastval(session);
    });

    test('DROP TABLE drops its identity sequence, and lastval() with it', async () => {
      const session = await openSession();
      await session.query(`CREATE TABLE ${SIGHTINGS} (id integer GENERATED ALWAYS AS IDENTITY, note text)`);
      await session.query(`INSERT INTO ${SIGHTINGS} (note) VALUES ('first light')`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      await session.query(`DROP TABLE ${SIGHTINGS}`);
      await expectNoLastval(session);
    });

    test('DROP SEQUENCE … CASCADE of a column default: 55000', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`CREATE TABLE ${SIGHTINGS} (id bigint DEFAULT nextval('${COMET}'), note text)`);
      await session.query(`INSERT INTO ${SIGHTINGS} (note) VALUES ('first light')`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      await session.query(`DROP SEQUENCE ${COMET} CASCADE`);
      await expectNoLastval(session);
    });

    test('a RENAMED last-used sequence keeps lastval() — it is the same sequence', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`ALTER SEQUENCE ${COMET} RENAME TO ${RENAMED}`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
      expect(await valueOf(session, `SELECT currval('${RENAMED}')`)).toBe('1');
    });

    test('ALTER SEQUENCE … RESTART keeps the session\'s lastval() and currval() until the next draw', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query(`ALTER SEQUENCE ${COMET} RESTART`);

      expect(await valueOf(session, 'SELECT lastval()')).toBe('2');
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('2');
      expect(await valueOf(session, `SELECT nextval('${COMET}')`)).toBe('1');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('1');
    });
  });

  describe('DISCARD forgets the session\'s sequence state', () => {
    test('DISCARD SEQUENCES: no lastval(), no currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('DISCARD SEQUENCES');

      await expectNoLastval(session);
      await expectNoCurrval(session, COMET);
    });

    test('DISCARD ALL: no lastval(), no currval()', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('DISCARD ALL');

      await expectNoLastval(session);
      await expectNoCurrval(session, COMET);
    });

    test('the next nextval() after a DISCARD defines both again — the sequence itself moved on', async () => {
      const session = await openSession();
      await session.query(`CREATE SEQUENCE ${COMET}`);
      await session.query(`SELECT nextval('${COMET}')`);
      await session.query('DISCARD SEQUENCES');

      expect(await valueOf(session, `SELECT nextval('${COMET}')`)).toBe('2');
      expect(await valueOf(session, 'SELECT lastval()')).toBe('2');
      expect(await valueOf(session, `SELECT currval('${COMET}')`)).toBe('2');
    });
  });
});
