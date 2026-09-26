import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Transaction-scoped advisory locks: advisoryXactLock / tryAdvisoryXactLock /
 * advisoryXactLockAll. The concurrency cases run two real transactions on two pooled
 * connections: one holds a lock while the other probes or waits for it.
 *
 * PGlite runs ONE session: a second transaction waits for the first to end, so a lock can never be
 * probed from another transaction while it is held. Those cases are skipped there; everything a
 * single session can show still runs.
 */
const concurrentSessions = process.env.LINKGRESS_TEST_DRIVER !== 'pglite';

describe('advisory transaction locks', () => {
  let db: AppDatabase;
  let captured: string[];

  beforeAll(() => {
    captured = [];
    db = new AppDatabase(createFreshClient(), {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
  });

  afterAll(async () => {
    await db.dispose();
  });

  /** Run `body` inside a transaction that holds until `release()` is called. */
  function holdInTransaction(body: (tx: AppDatabase) => Promise<void>) {
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const ready = new Promise<void>(resolve => {
      acquired = resolve;
    });

    const done = db.transaction(async (tx) => {
      await body(tx);
      acquired();
      await released;
    });

    return { ready, release, done };
  }

  describe('outside a transaction', () => {
    test('every form refuses to run — the lock would end with the statement', async () => {
      await expectToReject(db.advisoryXactLock(1), /TRANSACTION-scoped lock/);
      await expectToReject(db.tryAdvisoryXactLock(1, 2), /TRANSACTION-scoped lock/);
      await expectToReject(db.advisoryXactLockAll(1, [1, 2]), /TRANSACTION-scoped lock/);
    });
  });

  describe('key validation', () => {
    test('rejects keys outside their ranges and mixed key kinds', async () => {
      await db.transaction(async (tx) => {
        await expectToReject(tx.advisoryXactLock(1.5), /safe integer/);
        await expectToReject(tx.advisoryXactLock(2n ** 63n), /int8 range/);
        await expectToReject(tx.advisoryXactLock(2 ** 31, 1), /classId must be an integer in the int4 range/);
        await expectToReject(tx.advisoryXactLock(1, 2 ** 31), /key must be an integer in the int4 range/);
        await expectToReject(tx.tryAdvisoryXactLock('class' as any, 1), /class id of a key pair must be an integer/);
        await expectToReject(tx.advisoryXactLockAll(1, [1, 'a']), /all integers or all strings/);
        await expectToReject(tx.advisoryXactLockAll(1, [2 ** 40]), /int4 range/);
      });
    });

    test('accepts the int8 extremes as single keys', async () => {
      await db.transaction(async (tx) => {
        await tx.advisoryXactLock(-(2n ** 63n));
        await tx.advisoryXactLock(2n ** 63n - 1n);
        expect(await tx.tryAdvisoryXactLock(Number.MAX_SAFE_INTEGER)).toBe(true);
      });
    });

    test('the overload follows the argument count: an undefined or null key of a pair is refused, never another lock', async () => {
      await db.transaction(async (tx) => {
        captured.length = 0;

        // `(cls, null)` used to lock key 0, `(cls, undefined)` the single key `cls` — both silently a different lock
        await expectToReject(tx.advisoryXactLock(7, null as any), 'advisoryXactLock: the key of a key pair must be an integer or a string, got null');
        await expectToReject(tx.advisoryXactLock(7, undefined as any), 'advisoryXactLock: the key of a key pair must be an integer or a string, got undefined');
        await expectToReject(tx.tryAdvisoryXactLock(7, undefined as any), 'tryAdvisoryXactLock: the key of a key pair must be an integer or a string, got undefined');
        await expectToReject(tx.tryAdvisoryXactLock(7, true as any), 'tryAdvisoryXactLock: the key of a key pair must be an integer or a string, got true');
        await expectToReject(tx.advisoryXactLock(7, 2n ** 40n), /key must be an integer in the int4 range/);
        await expectToReject(tx.advisoryXactLock(null as any, 7), 'advisoryXactLock: the class id of a key pair must be an integer');

        // the single-key form refuses them too
        await expectToReject(tx.advisoryXactLock(null as any), 'advisoryXactLock: key must be a safe integer, a bigint or a string, got null');
        await expectToReject(tx.tryAdvisoryXactLock(undefined as any), 'tryAdvisoryXactLock: key must be a safe integer, a bigint or a string, got undefined');
        await expectToReject(tx.advisoryXactLockAll(7, [1, null as any]), /all integers or all strings/);

        // no statement ran for any of them
        expect(captured.some(line => line.includes('pg_advisory'))).toBe(false);

        // a bigint pair key inside the int4 range is a key like the number
        await tx.advisoryXactLock(7, 5n);
        expect(await tx.tryAdvisoryXactLock(7, 5)).toBe(true);
      });
    });
  });

  describe('holding and probing', () => {
    test.skipIf(!concurrentSessions)('a held single-key lock is not free for another transaction until COMMIT', async () => {
      const holder = holdInTransaction(async (tx) => {
        await tx.advisoryXactLock(424242);
      });
      await holder.ready;

      try {
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(424242))).toBe(false);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(424243))).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }

      expect(await db.transaction(tx => tx.tryAdvisoryXactLock(424242))).toBe(true);
    });

    test.skipIf(!concurrentSessions)('pair keys and string keys lock exactly their own (class, key)', async () => {
      const holder = holdInTransaction(async (tx) => {
        await tx.advisoryXactLock(7, 'invoice-15');
        await tx.advisoryXactLock('natural-key-A');
      });
      await holder.ready;

      try {
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(7, 'invoice-15'))).toBe(false);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(7, 'invoice-16'))).toBe(true);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(8, 'invoice-15'))).toBe(true);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock('natural-key-A'))).toBe(false);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock('natural-key-B'))).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
    });

    test('the same transaction may take its own lock again (re-entrant)', async () => {
      await db.transaction(async (tx) => {
        await tx.advisoryXactLock(5, 5);
        expect(await tx.tryAdvisoryXactLock(5, 5)).toBe(true);
        await tx.advisoryXactLock(5, 5);
      });
    });

    test.skipIf(!concurrentSessions)('a blocking lock waits for the holder to finish', async () => {
      const events: string[] = [];
      const holder = holdInTransaction(async (tx) => {
        await tx.advisoryXactLock(11, 1);
        events.push('holder locked');
      });
      await holder.ready;

      const waiter = db.transaction(async (tx) => {
        await tx.advisoryXactLock(11, 1);
        events.push('waiter locked');
      });

      // give the waiter time to reach the server and block
      await new Promise(resolve => setTimeout(resolve, 150));
      events.push('holder releasing');
      holder.release();
      await holder.done;
      await waiter;

      expect(events).toEqual(['holder locked', 'holder releasing', 'waiter locked']);
    });

    test('a rolled-back transaction releases its lock too', async () => {
      await expectToReject(
        db.transaction(async (tx) => {
          await tx.advisoryXactLock(12, 1);
          throw new Error('abort on purpose');
        }),
        /abort on purpose/
      );

      expect(await db.transaction(tx => tx.tryAdvisoryXactLock(12, 1))).toBe(true);
    });
  });

  describe('advisoryXactLockAll', () => {
    test('takes every key in one statement, sorted and deduplicated, in ordinality order', async () => {
      captured.length = 0;
      await db.transaction(tx => tx.advisoryXactLockAll(9, [3, 1, 2, 2, 3]));

      const lockStatements = captured.filter(line => line.includes('unnest'));
      expect(lockStatements).toHaveLength(1);
      // ORDER BY the array ordinal makes the acquisition order an SQL guarantee (the volatile lock call
      // is evaluated after the sort), not the executor's scan order
      expect(lockStatements[0]).toBe(
        'SELECT pg_advisory_xact_lock($1, t.k) FROM unnest(CAST($2 AS integer[])) WITH ORDINALITY AS t(k, ord) ORDER BY t.ord'
      );
      expect(captured.join('\n')).toContain('[Parameters] [9,"{1,2,3}"]');
    });

    test('string keys: hashtext of each, in code-unit order', async () => {
      captured.length = 0;
      await db.transaction(tx => tx.advisoryXactLockAll(10, ['b:7', 'a:12', 'b:7']));

      const lockStatements = captured.filter(line => line.includes('unnest'));
      expect(lockStatements).toEqual([
        'SELECT pg_advisory_xact_lock($1, hashtext(t.k)) FROM unnest(CAST($2 AS text[])) WITH ORDINALITY AS t(k, ord) ORDER BY t.ord',
      ]);
      expect(captured.join('\n')).toContain('[Parameters] [10,"{\\"a:12\\",\\"b:7\\"}"]');
    });

    test.skipIf(!concurrentSessions)('holds every key it took until the transaction ends', async () => {
      const holder = holdInTransaction(async (tx) => {
        await tx.advisoryXactLockAll(9, [3, 1, 2, 2, 3]);
      });
      await holder.ready;

      try {
        for (const key of [1, 2, 3]) {
          expect(await db.transaction(tx => tx.tryAdvisoryXactLock(9, key))).toBe(false);
        }
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(9, 4))).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
    });

    test.skipIf(!concurrentSessions)('string keys hash per key', async () => {
      const holder = holdInTransaction(async (tx) => {
        await tx.advisoryXactLockAll(10, ['b', 'a', 'b']);
      });
      await holder.ready;

      try {
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(10, 'a'))).toBe(false);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(10, 'b'))).toBe(false);
        expect(await db.transaction(tx => tx.tryAdvisoryXactLock(10, 'c'))).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
    });

    test('an empty key list is a no-op', async () => {
      captured.length = 0;
      await db.transaction(tx => tx.advisoryXactLockAll(1, []));
      expect(captured.some(line => line.includes('unnest'))).toBe(false);
    });

    test('overlapping key sets taken in opposite input order do not deadlock', async () => {
      const first = db.transaction(async (tx) => {
        await tx.advisoryXactLockAll(13, [1, 2, 3, 4]);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      const second = db.transaction(async (tx) => {
        await tx.advisoryXactLockAll(13, [4, 3, 2, 1]);
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      await first;
      await second;
    });
  });
});
