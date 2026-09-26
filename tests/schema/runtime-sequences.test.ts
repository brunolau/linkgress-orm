import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { DbSequence, sequence } from '../../src';
import type { DatabaseClient, SequenceConfig } from '../../src';
import { renderSequenceOptions } from '../../src/schema/sequence-builder';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Runtime-named sequences: `db.runtimeSequence(config)` + `DbSequence.nextValueCreatingIfMissing()` — a
 * sequence whose name is computed at run time (one per tenant and year), created on first use:
 *
 *   SELECT nextval($1::regclass) as value                        -- $1 = the quoted, qualified name
 *   CREATE SEQUENCE IF NOT EXISTS "<name>" <options>             -- only on SQLSTATE 42P01
 *   SELECT nextval($1::regclass) as value
 *
 * Not registered with the model, bound to the ROOT client even on a transaction's context, and run
 * through the client directly (never the logging executor).
 */

/** PGlite runs ONE session: a root-client statement from inside a transaction callback cannot run there. */
const concurrentSessions = process.env.LINKGRESS_TEST_DRIVER !== 'pglite';

const RUNTIME_SEQUENCES = ['rt_seq_first', 'MixedCase_seq', 'we"ird_seq', 'rt_seq_options', 'rt_seq_schema', 'rt_seq_wide', 'rt_seq_tx', 'rt_seq_silent'];

/** A client that answers from a script (for the error ladder) and records every statement it is sent. */
function scriptedClient(script: Array<(sql: string) => { rows: any[] } | Error>): { client: DatabaseClient; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      const step = script.shift();
      if (!step) {
        throw new Error(`unscripted statement: ${sql}`);
      }
      const outcome = step(sql);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return { rows: outcome.rows, rowCount: outcome.rows.length };
    },
  } as unknown as DatabaseClient;

  return { client, statements };
}

const dbError = (fields: Record<string, unknown>): Error => Object.assign(new Error(String(fields.message ?? 'database error')), fields);

describe('runtime sequences', () => {
  let db: AppDatabase;
  const captured: string[] = [];

  const dropRuntimeSequences = async () => {
    for (const name of RUNTIME_SEQUENCES) {
      await db.getClient().query(`DROP SEQUENCE IF EXISTS "public"."${name.replace(/"/g, '""')}"`);
    }
  };

  const sequenceExists = async (name: string): Promise<boolean> => {
    const result = await db.getClient().query(`SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname = $1`, [name]);
    return Number(result.rows[0].n) === 1;
  };

  beforeAll(async () => {
    db = new AppDatabase(createFreshClient(), {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await dropRuntimeSequences();
  });

  afterAll(async () => {
    await dropRuntimeSequences();
    await db.dispose();
  });

  describe('against the database', () => {
    test('the first call creates the sequence and returns its first value; later calls just draw', async () => {
      const sequence = db.runtimeSequence({ name: 'rt_seq_first', startWith: 1, incrementBy: 1, minValue: 1, cache: 1 });

      expect(await sequenceExists('rt_seq_first')).toBe(false);
      expect(await sequence.nextValueCreatingIfMissing()).toBe(1);
      expect(await sequenceExists('rt_seq_first')).toBe(true);
      expect(await sequence.nextValueCreatingIfMissing()).toBe(2);
      expect(await db.runtimeSequence({ name: 'rt_seq_first' }).nextValueCreatingIfMissing()).toBe(3);
    });

    test('the name is an identifier, not SQL: a mixed-case name is created verbatim, a double quote is escaped', async () => {
      expect(await db.runtimeSequence({ name: 'MixedCase_seq' }).nextValueCreatingIfMissing()).toBe(1);
      expect(await sequenceExists('MixedCase_seq')).toBe(true);
      expect(await sequenceExists('mixedcase_seq')).toBe(false);

      expect(await db.runtimeSequence({ name: 'we"ird_seq' }).nextValueCreatingIfMissing()).toBe(1);
      expect(await db.runtimeSequence({ name: 'we"ird_seq' }).nextValueCreatingIfMissing()).toBe(2);
      expect(await sequenceExists('we"ird_seq')).toBe(true);
    });

    test('the options shape the created sequence; a schema qualifies it', async () => {
      const options = db.runtimeSequence({ name: 'rt_seq_options', startWith: 100, incrementBy: 5, minValue: 1, maxValue: 110, cache: 1, cycle: true });
      const values: number[] = [];
      for (let i = 0; i < 4; i++) {
        values.push(await options.nextValueCreatingIfMissing());
      }
      expect(values).toEqual([100, 105, 110, 1]);

      const qualified = db.runtimeSequence({ name: 'rt_seq_schema', schema: 'public', startWith: 7 });
      expect(qualified.getQualifiedName()).toBe('"public"."rt_seq_schema"');
      expect(await qualified.nextValueCreatingIfMissing()).toBe(7);
      expect(await sequenceExists('rt_seq_schema')).toBe(true);
    });

    test('bounds above 2^53 are valid bigint options: the sequence is created and draws', async () => {
      const wide = db.runtimeSequence({ name: 'rt_seq_wide', startWith: 1e16, minValue: 1e16, maxValue: 2 ** 60, incrementBy: 2n });

      expect(await wide.nextValueCreatingIfMissing()).toBe(1e16);
      expect(await wide.nextValueCreatingIfMissing()).toBe(1e16 + 2);
    });

    test.skipIf(!concurrentSessions)('bound to the ROOT client: a CREATE made from a transaction survives its rollback', async () => {
      await expectToReject(db.transaction(async tx => {
        expect(await tx.runtimeSequence({ name: 'rt_seq_tx' }).nextValueCreatingIfMissing()).toBe(1);
        throw new Error('roll back');
      }), 'roll back');

      expect(await sequenceExists('rt_seq_tx')).toBe(true);
      expect(await db.runtimeSequence({ name: 'rt_seq_tx' }).nextValueCreatingIfMissing()).toBe(2);
    });

    test('runs unlogged, and never registers with the model', async () => {
      captured.length = 0;
      expect(await db.runtimeSequence({ name: 'rt_seq_silent' }).nextValueCreatingIfMissing()).toBe(1);

      expect(captured).toEqual([]);
      expect([...db.getSequenceRegistry().values()].some(config => config.name === 'rt_seq_silent')).toBe(false);
    });
  });

  describe('the create-on-first-use ladder', () => {
    const config: SequenceConfig = { name: 'seq_doc_00001_2026', startWith: 1, incrementBy: 1, minValue: 1, cache: 1 };
    const drawn = (value: string) => () => ({ rows: [{ value }] });

    test('42P01 → CREATE SEQUENCE IF NOT EXISTS with the options → nextval once more; the value as a number', async () => {
      const { client, statements } = scriptedClient([
        () => dbError({ code: '42P01', message: 'relation "seq_doc_00001_2026" does not exist' }),
        () => ({ rows: [] }),
        drawn('1'),
      ]);

      expect(await new DbSequence(client, config).nextValueCreatingIfMissing()).toBe(1);
      expect(statements).toEqual([
        'SELECT nextval($1::regclass) as value',
        'CREATE SEQUENCE IF NOT EXISTS "seq_doc_00001_2026" START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1',
        'SELECT nextval($1::regclass) as value',
      ]);
    });

    test('a concurrent first use that loses the catalog race (23505 on the CREATE) still draws', async () => {
      const { client, statements } = scriptedClient([
        () => dbError({ code: '42P01' }),
        () => dbError({ code: '23505', message: 'duplicate key value violates unique constraint "pg_type_typname_nsp_index"' }),
        drawn('2'),
      ]);

      expect(await new DbSequence(client, config).nextValueCreatingIfMissing()).toBe(2);
      expect(statements).toHaveLength(3);
    });

    test('a concurrent first use whose winner committed between the IF NOT EXISTS probe and the insert (42P07) still draws', async () => {
      const { client, statements } = scriptedClient([
        () => dbError({ code: '42P01' }),
        () => dbError({ code: '42P07', message: 'relation "seq_doc_00001_2026" already exists' }),
        drawn('4'),
      ]);

      expect(await new DbSequence(client, config).nextValueCreatingIfMissing()).toBe(4);
      expect(statements).toEqual([
        'SELECT nextval($1::regclass) as value',
        'CREATE SEQUENCE IF NOT EXISTS "seq_doc_00001_2026" START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1',
        'SELECT nextval($1::regclass) as value',
      ]);
    });

    test('a duplicate_object (42710) on the CREATE draws the same way', async () => {
      const { client, statements } = scriptedClient([
        () => dbError({ code: '42P01' }),
        () => dbError({ code: '42710', message: 'type "seq_doc_00001_2026" already exists' }),
        drawn('5'),
      ]);

      expect(await new DbSequence(client, config).nextValueCreatingIfMissing()).toBe(5);
      expect(statements).toHaveLength(3);
    });

    test('Bun\'s SQL errors carry the SQLSTATE in errno', async () => {
      const { client } = scriptedClient([
        () => dbError({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '42P01' }),
        () => dbError({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' }),
        drawn('3'),
      ]);

      expect(await new DbSequence(client, config).nextValueCreatingIfMissing()).toBe(3);
    });

    test('any other error of the CREATE propagates', async () => {
      const { client, statements } = scriptedClient([() => dbError({ code: '42P01' }), () => dbError({ code: '42501', message: 'permission denied for schema public' })]);

      await expectToReject(new DbSequence(client, config).nextValueCreatingIfMissing(), 'permission denied for schema public');
      expect(statements).toHaveLength(2);
    });

    test('a first error other than 42P01 propagates without a CREATE', async () => {
      const { client, statements } = scriptedClient([() => dbError({ code: '42501', message: 'permission denied for sequence' })]);

      await expectToReject(new DbSequence(client, config).nextValueCreatingIfMissing(), 'permission denied for sequence');
      expect(statements).toEqual(['SELECT nextval($1::regclass) as value']);
    });

    test('the second nextval is not retried', async () => {
      const { client, statements } = scriptedClient([
        () => dbError({ code: '42P01' }),
        () => ({ rows: [] }),
        () => dbError({ code: '42P01', message: 'dropped again' }),
      ]);

      await expectToReject(new DbSequence(client, config).nextValueCreatingIfMissing(), 'dropped again');
      expect(statements).toHaveLength(3);
    });
  });

  describe('names and options', () => {
    test('the options render in the schema manager\'s order, from ONE renderer', () => {
      expect(renderSequenceOptions({ name: 's', startWith: 100, incrementBy: 5, minValue: 1, maxValue: 1000, cache: 20, cycle: true }))
        .toBe('START WITH 100 INCREMENT BY 5 MINVALUE 1 MAXVALUE 1000 CACHE 20 CYCLE');
      expect(renderSequenceOptions({ name: 's' })).toBe('');
    });

    test('the fluent builder carries every option — its bounds included — into the rendered DDL', () => {
      const config = sequence('bounded_seq').startWith(10).incrementBy(2).minValue(5).maxValue(9223372036854775807n).cache(3).cycle().build();

      expect(config).toMatchObject({ name: 'bounded_seq', minValue: 5, maxValue: 9223372036854775807n });
      expect(renderSequenceOptions(config)).toBe('START WITH 10 INCREMENT BY 2 MINVALUE 5 MAXVALUE 9223372036854775807 CACHE 3 CYCLE');
    });

    test('any integer within bigint renders — also above 2^53, and as a JS bigint', () => {
      // 9_999_999_999_999_999 is 1e16 in JS: a valid PostgreSQL bound all the same
      expect(renderSequenceOptions({ name: 's', maxValue: 9_999_999_999_999_999 })).toBe('MAXVALUE 10000000000000000');
      expect(renderSequenceOptions({ name: 's', maxValue: 2 ** 60, minValue: -(2 ** 63) })).toBe('MINVALUE -9223372036854775808 MAXVALUE 1152921504606846976');
      expect(renderSequenceOptions({ name: 's', startWith: 9223372036854775807n, minValue: -9223372036854775808n, incrementBy: -1n }))
        .toBe('START WITH 9223372036854775807 INCREMENT BY -1 MINVALUE -9223372036854775808');
    });

    test('a fraction, NaN, Infinity or a value outside bigint is refused before any SQL', async () => {
      expect(() => renderSequenceOptions({ name: 's', startWith: 1.5 })).toThrow('sequence "s": startWith must be an integer within bigint, got 1.5');
      expect(() => db.runtimeSequence({ name: 's', cache: Number.NaN })).toThrow('sequence "s": cache must be an integer within bigint, got NaN');
      expect(() => db.runtimeSequence({ name: 's', maxValue: Number.POSITIVE_INFINITY })).toThrow('sequence "s": maxValue must be an integer within bigint, got Infinity');
      expect(() => db.runtimeSequence({ name: 's', maxValue: 2 ** 63 })).toThrow('sequence "s": maxValue must be an integer within bigint, got 9223372036854776000');
      expect(() => db.runtimeSequence({ name: 's', minValue: -9223372036854775809n })).toThrow('sequence "s": minValue must be an integer within bigint, got -9223372036854775809');
      // a string that is not an integer within bigint is refused too
      expect(() => renderSequenceOptions({ name: 's', startWith: '1.5' as any })).toThrow('sequence "s": startWith must be an integer within bigint, got 1.5');
      expect(() => renderSequenceOptions({ name: 's', startWith: 'ten' as any })).toThrow('sequence "s": startWith must be an integer within bigint, got ten');
      expect(() => renderSequenceOptions({ name: 's', startWith: '' as any })).toThrow('sequence "s": startWith must be an integer within bigint, got ');
      expect(() => renderSequenceOptions({ name: 's', maxValue: '9223372036854775808' as any })).toThrow('sequence "s": maxValue must be an integer within bigint, got 9223372036854775808');
    });

    test('an integer STRING within bigint (a JSON / env config value) renders as its integer, as before 1.0.9', () => {
      expect(renderSequenceOptions({ name: 's', startWith: '10' as any, incrementBy: '-2' as any, maxValue: '9223372036854775807' as any }))
        .toBe('START WITH 10 INCREMENT BY -2 MAXVALUE 9223372036854775807');
      expect(renderSequenceOptions({ name: 's', startWith: ' 7 ' as any, cache: '+5' as any })).toBe('START WITH 7 CACHE 5');
    });

    test('a NUL in the name or the schema is refused; a double quote is doubled', () => {
      expect(() => db.runtimeSequence({ name: 'bad\u0000name' })).toThrow('sequence name must not contain a NUL character');
      expect(() => db.runtimeSequence({ name: 'ok', schema: 'b\u0000ad' })).toThrow('sequence name must not contain a NUL character');
      expect(new DbSequence(db.getClient(), { name: 'a"b' }).getQualifiedName()).toBe('"a""b"');
      expect(new DbSequence(db.getClient(), { name: 'plain_seq', schema: 'public' }).getQualifiedName()).toBe('"public"."plain_seq"');
    });
  });
});
