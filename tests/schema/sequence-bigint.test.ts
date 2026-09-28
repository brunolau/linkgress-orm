import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DatabaseClient, DbContext, DbModelConfig, DbSequence, sequence } from '../../src';
import type { SequenceConfig } from '../../src';
import { sqlStateOf } from '../../src/database/sql-state';
import { qualifiedSequenceName, renderCreateSequenceStatement } from '../../src/schema/sequence-builder';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import type { AssertType } from '../utils/type-tester';

/**
 * `DbSequence` values beyond Number's safe integer range (±(2^53 − 1)).
 *
 * `nextValue()` / `currentValue()` / `nextValueCreatingIfMissing()` returned `Number(value)`: above 2^53 a
 * different number than the database drew (2^53 + 1 came back as 2^53). They now throw a RangeError there — never a
 * wrong number — and `nextValueBigInt()` / `currentValueBigInt()` / `nextValueCreatingIfMissingBigInt()` return
 * every int8 exactly; `resync()` also takes a bigint. Every value within the safe range reads exactly as before.
 *
 * Every driver delivers int8 as its exact decimal text; the conversion is also pinned against scripted clients for
 * the other shapes a driver can be configured to deliver (a JS bigint, a number).
 *
 * Domain: a star catalogue.
 */

const MAX = Number.MAX_SAFE_INTEGER; // 2^53 − 1 = 9007199254740991

const SEQ = {
  /** …990, …991 (= 2^53 − 1), then 2^53, 2^53 + 1, … */
  catalogNo: sequence('bigseq_catalog_no_seq').startWith(MAX - 1).build(),
  /** from 2^62 */
  deepSky: sequence('bigseq_deep_sky_seq').startWith(2n ** 62n).build(),
  /** −(2^53 − 2), −(2^53 − 1), −2^53, … */
  southern: sequence('bigseq_southern_seq').startWith(-(MAX - 1)).incrementBy(-1).minValue(-(2n ** 63n)).maxValue(0).build(),
  /** the int8 maximum: 2^63 − 2, 2^63 − 1, then exhausted */
  rim: sequence('bigseq_rim_seq').startWith(2n ** 63n - 2n).maxValue(2n ** 63n - 1n).build(),
  /** the int8 minimum, descending: −2^63 + 2, −2^63 + 1, −2^63, then exhausted */
  floor: sequence('bigseq_floor_seq').startWith(-(2n ** 63n) + 2n).incrementBy(-1).minValue(-(2n ** 63n)).maxValue(0).build(),
  /** 1, 2, 3, … */
  small: sequence('bigseq_small_seq').startWith(1).build(),
} satisfies Record<string, SequenceConfig>;

const RUNTIME = ['bigseq_rt_first_seq', 'bigseq_rt_exact_seq', 'bigseq_rt_sweep_seq'];

class StarCatalogDatabase extends DbContext {
  get catalogNoSeq(): DbSequence {
    return this.sequence(SEQ.catalogNo);
  }

  get deepSkySeq(): DbSequence {
    return this.sequence(SEQ.deepSky);
  }

  get southernSeq(): DbSequence {
    return this.sequence(SEQ.southern);
  }

  get rimSeq(): DbSequence {
    return this.sequence(SEQ.rim);
  }

  get floorSeq(): DbSequence {
    return this.sequence(SEQ.floor);
  }

  get smallSeq(): DbSequence {
    return this.sequence(SEQ.small);
  }

  protected override setupModel(_model: DbModelConfig): void {}

  protected override setupSequences(): void {
    this.catalogNoSeq;
    this.deepSkySeq;
    this.southernSeq;
    this.rimSeq;
    this.floorSeq;
    this.smallSeq;
  }
}

/** A client that answers every statement from a script and records the statements it is sent. */
function scriptedClient(values: unknown[]): { client: DatabaseClient; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (values.length === 0) {
        throw new Error(`unscripted statement: ${sql}`);
      }
      return { rows: [{ value: values.shift() }], rowCount: 1 };
    },
  } as unknown as DatabaseClient;

  return { client, statements };
}

describe('DbSequence beyond the safe integer range of a JS number', () => {
  let db: StarCatalogDatabase;

  const dropAll = async () => {
    const names = [...Object.values(SEQ).map(qualifiedSequenceName), ...RUNTIME.map(name => `"${name}"`)];
    await db.getClient().query(`DROP SEQUENCE IF EXISTS ${names.join(', ')}`);
  };

  beforeAll(() => {
    db = new StarCatalogDatabase(createFreshClient());
  });

  beforeEach(async () => {
    await dropAll();
    for (const config of Object.values(SEQ)) {
      await db.getClient().query(renderCreateSequenceStatement(config));
    }
  });

  afterAll(async () => {
    try {
      await dropAll();
    } finally {
      await db.dispose();
    }
  });

  describe('the number-returning methods: exact within ±(2^53 − 1), a RangeError beyond', () => {
    test('nextValue() returns Number.MAX_SAFE_INTEGER itself', async () => {
      expect([await db.catalogNoSeq.nextValue(), await db.catalogNoSeq.nextValue()]).toEqual([MAX - 1, MAX]);
    });

    test('nextValue() refuses 2^53 with a RangeError; the drawn value is consumed — the bigint variant draws on', async () => {
      await db.catalogNoSeq.nextValue();
      await db.catalogNoSeq.nextValue();

      const refused = await expectToReject(db.catalogNoSeq.nextValue(), 'sequence "bigseq_catalog_no_seq": nextValue() drew 9007199254740992');
      expect(refused).toBeInstanceOf(RangeError);
      expect(await db.catalogNoSeq.nextValueBigInt()).toBe(9007199254740993n);
    });

    test('nextValue() refuses 2^53 + 1 — the value a Number would have rounded to 2^53', async () => {
      await db.catalogNoSeq.resync(9007199254740992n);

      const refused = await expectToReject(db.catalogNoSeq.nextValue(), 'nextValue() drew 9007199254740993');
      expect(refused).toBeInstanceOf(RangeError);
    });

    test('nextValue() refuses a value far beyond: 2^62', async () => {
      const refused = await expectToReject(db.deepSkySeq.nextValue(), 'sequence "bigseq_deep_sky_seq": nextValue() drew 4611686018427387904');
      expect(refused).toBeInstanceOf(RangeError);
    });

    test('the negative side: −(2^53 − 1) is returned, −2^53 refused', async () => {
      expect([await db.southernSeq.nextValue(), await db.southernSeq.nextValue()]).toEqual([-(MAX - 1), -MAX]);

      const refused = await expectToReject(db.southernSeq.nextValue(), 'nextValue() drew -9007199254740992');
      expect(refused).toBeInstanceOf(RangeError);
    });

    test('currentValue() returns a safe current value and refuses an unsafe one', async () => {
      // currval() is per session: the transaction pins one
      await db.transaction(async trx => {
        await trx.catalogNoSeq.nextValue();
        await trx.catalogNoSeq.nextValue();
        expect(await trx.catalogNoSeq.currentValue()).toBe(MAX);

        await trx.catalogNoSeq.nextValueBigInt();
        const refused = await expectToReject(trx.catalogNoSeq.currentValue(), 'sequence "bigseq_catalog_no_seq": currentValue() is 9007199254740992');
        expect(refused).toBeInstanceOf(RangeError);
      });
    });

    test('nextValueCreatingIfMissing() creates the sequence, then refuses its unsafe first value — consumed', async () => {
      const runtime = db.runtimeSequence({ name: 'bigseq_rt_first_seq', startWith: 2n ** 60n });

      const refused = await expectToReject(runtime.nextValueCreatingIfMissing(), 'sequence "bigseq_rt_first_seq": nextValueCreatingIfMissing() drew 1152921504606846976');
      expect(refused).toBeInstanceOf(RangeError);
      expect(await runtime.nextValueCreatingIfMissingBigInt()).toBe(1152921504606846977n);
    });

    test('the RangeError names the bigint method that reads the value exactly', async () => {
      const { next, current } = await db.transaction(async trx => ({
        next: await expectToReject(trx.deepSkySeq.nextValue()),
        current: await expectToReject(trx.deepSkySeq.currentValue()),
      }));

      expect(next.message).toContain('draw it with nextValueBigInt()');
      expect(current.message).toContain('read it with currentValueBigInt()');
      expect(next.message).toContain('the safe integer range of a JS number (±9007199254740991)');
    });

    test('backward compatible: every value within ±(2^53 − 1) reads as the same number as before', async () => {
      const values = [0, 1, -1, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 10 ** 15, 2 ** 53 - 2, MAX, -MAX];
      const drawn: number[] = [];
      const current: number[] = [];

      for (const value of values) {
        const [next, now] = await db.transaction(async trx => {
          await trx.query('DROP SEQUENCE IF EXISTS "bigseq_rt_sweep_seq"');
          await trx.query(renderCreateSequenceStatement({ name: 'bigseq_rt_sweep_seq', startWith: value, minValue: -MAX, maxValue: MAX }));
          const swept = new DbSequence(trx.getClient(), { name: 'bigseq_rt_sweep_seq' });
          return [await swept.nextValue(), await swept.currentValue()];
        });
        drawn.push(next);
        current.push(now);
      }

      expect(drawn).toEqual(values);
      expect(current).toEqual(values);
    });
  });

  describe('the bigint-returning variants: every int8 exactly', () => {
    test('nextValueBigInt() draws exactly across 2^53', async () => {
      expect([await db.catalogNoSeq.nextValueBigInt(), await db.catalogNoSeq.nextValueBigInt(), await db.catalogNoSeq.nextValueBigInt(), await db.catalogNoSeq.nextValueBigInt()])
        .toEqual([9007199254740990n, 9007199254740991n, 9007199254740992n, 9007199254740993n]);
    });

    test('up to the int8 maximum, then the sequence\'s own limit (2200H)', async () => {
      expect([await db.rimSeq.nextValueBigInt(), await db.rimSeq.nextValueBigInt()]).toEqual([9223372036854775806n, 9223372036854775807n]);

      const exhausted = await expectToReject(db.rimSeq.nextValueBigInt(), 'reached maximum value of sequence "bigseq_rim_seq" (9223372036854775807)');
      expect(sqlStateOf(exhausted)).toBe('2200H');
    });

    test('down to the int8 minimum, descending', async () => {
      expect([await db.floorSeq.nextValueBigInt(), await db.floorSeq.nextValueBigInt(), await db.floorSeq.nextValueBigInt()])
        .toEqual([-9223372036854775806n, -9223372036854775807n, -9223372036854775808n]);

      const exhausted = await expectToReject(db.floorSeq.nextValueBigInt(), 'reached minimum value of sequence "bigseq_floor_seq" (-9223372036854775808)');
      expect(sqlStateOf(exhausted)).toBe('2200H');
    });

    test('currentValueBigInt() reads the value just drawn, exactly', async () => {
      const current = await db.transaction(async trx => {
        await trx.deepSkySeq.nextValueBigInt();
        await trx.deepSkySeq.nextValueBigInt();
        return trx.deepSkySeq.currentValueBigInt();
      });

      expect(current).toBe(4611686018427387905n);
    });

    test('small values are bigints too, and both variants draw from one series', async () => {
      const seen = await db.transaction(async trx => [
        await trx.smallSeq.nextValue(),
        await trx.smallSeq.nextValueBigInt(),
        await trx.smallSeq.nextValue(),
        await trx.smallSeq.currentValueBigInt(),
        await trx.smallSeq.currentValue(),
      ]);

      expect(seen).toEqual([1, 2n, 3, 3n, 3]);
    });

    test('nextValueCreatingIfMissingBigInt() creates a runtime sequence and draws exactly', async () => {
      const runtime = db.runtimeSequence({ name: 'bigseq_rt_exact_seq', startWith: 2n ** 60n + 1n, incrementBy: 3n });

      expect(await runtime.nextValueCreatingIfMissingBigInt()).toBe(1152921504606846977n);
      expect(await runtime.nextValueCreatingIfMissingBigInt()).toBe(1152921504606846980n);
    });

    test('resync() takes a bigint beyond 2^53: the current value and the next draw are exact', async () => {
      const seen = await db.transaction(async trx => {
        await trx.smallSeq.resync(9007199254740993n);
        return [await trx.smallSeq.currentValueBigInt(), await trx.smallSeq.nextValueBigInt()];
      });

      expect(seen).toEqual([9007199254740993n, 9007199254740994n]);
    });

    test('resync() refuses a NUMBER beyond the safe range — 2^53 — before any SQL, pointing to the bigint overload', async () => {
      const { client, statements } = scriptedClient([]);
      const seq = new DbSequence(client, { name: 'bigseq_scripted_seq' });

      const refused = await expectToReject(seq.resync(2 ** 53), 'sequence "bigseq_scripted_seq": resync() takes a number only within the safe integer range (±9007199254740991), got 9007199254740992 — pass the exact value as a bigint');
      expect(refused).toBeInstanceOf(RangeError);
      expect(statements).toEqual([]);
    });

    test('…2^60, which would have been stored as its shortest decimal (…847000) instead of …846976', async () => {
      const refused = await db.transaction(async trx => {
        const error = await expectToReject(trx.smallSeq.resync(2 ** 60), 'got 1152921504606846976 — pass the exact value as a bigint');
        return { error, current: await trx.smallSeq.nextValue() };
      });

      expect(refused.error).toBeInstanceOf(RangeError);
      // nothing was set: the sequence draws its first value
      expect(refused.current).toBe(1);
    });

    test('…and any other number that is no safe integer: −2^53, a fraction, NaN, Infinity', async () => {
      const { client, statements } = scriptedClient([]);
      const seq = new DbSequence(client, { name: 'bigseq_scripted_seq' });

      for (const [value, shown] of [[-(2 ** 53), '-9007199254740992'], [1.5, '1.5'], [Number.NaN, 'NaN'], [Number.POSITIVE_INFINITY, 'Infinity']] as const) {
        const refused = await expectToReject(seq.resync(value), `resync() takes a number only within the safe integer range (±9007199254740991), got ${shown}`);
        expect(refused).toBeInstanceOf(RangeError);
      }
      expect(statements).toEqual([]);
    });

    test('resync() takes Number.MAX_SAFE_INTEGER itself as a number', async () => {
      const seen = await db.transaction(async trx => {
        await trx.smallSeq.resync(MAX);
        return trx.smallSeq.currentValue();
      });

      expect(seen).toBe(MAX);
    });

    test('resync() still takes a number', async () => {
      const seen = await db.transaction(async trx => {
        await trx.smallSeq.resync(41);
        return [await trx.smallSeq.currentValue(), await trx.smallSeq.nextValue()];
      });

      expect(seen).toEqual([41, 42]);
    });

    test('inside a transaction, the bigint variants draw on the transaction\'s session', async () => {
      const seen = await db.transaction(async trx => {
        const drawn = await trx.catalogNoSeq.nextValueBigInt();
        await trx.catalogNoSeq.nextValueBigInt();
        await trx.catalogNoSeq.nextValueBigInt();
        const rows = await trx.query<{ value: string }>('SELECT currval(\'"bigseq_catalog_no_seq"\')::text AS value');
        return { drawn, current: await trx.catalogNoSeq.currentValueBigInt(), currval: rows[0].value };
      });

      expect(seen).toEqual({ drawn: 9007199254740990n, current: 9007199254740992n, currval: '9007199254740992' });
    });
  });

  describe('the value the driver delivers (scripted clients)', () => {
    const config: SequenceConfig = { name: 'bigseq_scripted_seq' };

    test('a decimal string beyond 2^53: exact as a bigint, refused as a number', async () => {
      const { client } = scriptedClient(['9007199254740993', '9007199254740993']);
      const seq = new DbSequence(client, config);

      expect(await seq.nextValueBigInt()).toBe(9007199254740993n);
      const refused = await expectToReject(seq.nextValue(), 'nextValue() drew 9007199254740993');
      expect(refused).toBeInstanceOf(RangeError);
    });

    test('a JS bigint (a driver configured to deliver them) as it is', async () => {
      const { client } = scriptedClient([9223372036854775807n, 12n]);
      const seq = new DbSequence(client, config);

      expect(await seq.nextValueBigInt()).toBe(9223372036854775807n);
      expect(await seq.nextValue()).toBe(12);
    });

    test('a safe JS number as it is, in both variants', async () => {
      const { client } = scriptedClient([42, 42, -7]);
      const seq = new DbSequence(client, config);

      expect(await seq.nextValue()).toBe(42);
      expect(await seq.nextValueBigInt()).toBe(42n);
      expect(await seq.currentValue()).toBe(-7);
    });

    test('an UNSAFE JS number (a driver that reads int8 as a double) is refused by both variants: its exact value is lost', async () => {
      const { client } = scriptedClient([2 ** 60, 2 ** 60]);
      const seq = new DbSequence(client, config);

      const asBigInt = await expectToReject(seq.nextValueBigInt(), 'the driver delivered the inexact number 1152921504606846976');
      const asNumber = await expectToReject(seq.nextValue(), 'the driver delivered the inexact number 1152921504606846976');
      expect(asBigInt).toBeInstanceOf(RangeError);
      expect(asNumber).toBeInstanceOf(RangeError);
    });

    test('a value that is no integer is refused — never read as 0, NaN or a fraction', async () => {
      const { client } = scriptedClient([null, '12.5', 'abc']);
      const seq = new DbSequence(client, config);

      await expectToReject(seq.nextValue(), 'sequence "bigseq_scripted_seq": nextValue() drew null, which is no integer');
      await expectToReject(seq.nextValueBigInt(), 'sequence "bigseq_scripted_seq": nextValueBigInt() drew 12.5, which is no integer');
      await expectToReject(seq.currentValue(), 'sequence "bigseq_scripted_seq": currentValue() read abc, which is no integer');
    });

    test('both variants send the same statements', async () => {
      const { client, statements } = scriptedClient(['1', '1', '1', '1']);
      const seq = new DbSequence(client, config);

      await seq.nextValue();
      await seq.nextValueBigInt();
      await seq.currentValue();
      await seq.currentValueBigInt();

      expect(statements).toEqual([
        'SELECT nextval($1::regclass) as value',
        'SELECT nextval($1::regclass) as value',
        'SELECT currval($1::regclass) as value',
        'SELECT currval($1::regclass) as value',
      ]);
    });
  });

  test('typing: the bigint variants return bigint, the number methods number, resync() takes both', async () => {
    const seen = await db.transaction(async trx => {
      const seq = trx.smallSeq;
      const next: AssertType<Awaited<ReturnType<DbSequence['nextValueBigInt']>>, bigint> = await seq.nextValueBigInt();
      const current: AssertType<Awaited<ReturnType<DbSequence['currentValueBigInt']>>, bigint> = await seq.currentValueBigInt();
      const created: AssertType<Awaited<ReturnType<DbSequence['nextValueCreatingIfMissingBigInt']>>, bigint> = await seq.nextValueCreatingIfMissingBigInt();
      const asNumber: AssertType<Awaited<ReturnType<DbSequence['nextValue']>>, number> = await seq.nextValue();
      const resyncTo: AssertType<Parameters<DbSequence['resync']>[0], number | bigint> = 10n;
      await seq.resync(resyncTo);
      return [next, current, created, asNumber, await seq.currentValueBigInt()];
    });

    expect(seen).toEqual([1n, 1n, 2n, 3, 10n]);
  });
});
