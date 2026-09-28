import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  BunClient,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  DbSequence,
  integer,
  MigrationJournal,
  MigrationRunner,
  PgClient,
  PGliteClient,
  PostgresClient,
  sequence,
  varchar,
} from '../../src';
import type { ClientQueryResult, PooledConnection, QueryExecutionOptions, SequenceConfig } from '../../src';
import { sqlStateOf } from '../../src/database/sql-state';
import { qualifiedSequenceName, renderCreateSequenceStatement } from '../../src/schema/sequence-builder';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';
import type { AssertType } from '../utils/type-tester';

/**
 * Model-declared sequences — `this.sequence(config)` behind a getter — reached through a transaction's context
 * (`db.transaction(trx => trx.<sequence>.nextValue())`).
 *
 * `createTransactionalContext()` used to hand the transaction the ROOT context's map of `DbSequence` instances, so
 * `trx.<sequence>` returned the root's instance, bound to the root client: its `nextval` ran on a second pool
 * connection, OUTSIDE the caller's transaction. currval() / lastval() in the transaction were not defined by the
 * draw, the transaction's session state (search_path, READ ONLY) did not apply, a failed draw did not abort it, N
 * concurrent transactions on a pool of N deadlocked, PGlite (one session) refused the call — and a sequence FIRST
 * reached inside a transaction was cached for the root, bound to that transaction's client.
 *
 * Every draw is checked on the server (currval() / lastval() / session state of the same transaction) or by the
 * path its statement took: `RoutingClient` records whether a statement went through the client's own `query()`
 * ("root") or through a transaction's query function ("transaction").
 *
 * `runtimeSequence()` keeps its documented ROOT binding; the block "runtimeSequence() keeps its ROOT binding" pins it.
 * The last block runs on a PGlite instance of its own, whatever the driver of the run.
 *
 * Domain: a greenhouse — harvests numbered by sequences.
 */

/** PGlite runs ONE session: nothing runs beside an open transaction there. */
const concurrentSessions = process.env.LINKGRESS_TEST_DRIVER !== 'pglite';

const GARDEN = 'txseq_garden';

const SEQ = {
  /** 1, 2, 3, … */
  harvestNo: sequence('txseq_harvest_no_seq').startWith(1).build(),
  /** 100, 105, 110, … */
  plantTag: sequence('txseq_plant_tag_seq').startWith(100).incrementBy(5).build(),
  /** 20 values cached per session */
  seedLot: sequence('txseq_seed_lot_seq').startWith(1).cache(20).build(),
  /** schema-qualified: "txseq_garden"."txseq_plot_seq", from 1000 */
  plot: sequence('txseq_plot_seq').inSchema(GARDEN).startWith(1000).build(),
  /** 10, 9, 8, … 1 */
  countdown: sequence('txseq_countdown_seq').startWith(10).incrementBy(-1).minValue(1).maxValue(10).build(),
  /** 1, 2, 3, 1, 2, … */
  rotation: sequence('txseq_rotation_seq').startWith(1).minValue(1).maxValue(3).cycle().build(),
  /** 1, 2 — then exhausted */
  tray: sequence('txseq_tray_seq').startWith(1).minValue(1).maxValue(2).build(),
  /** beyond int4, in steps of 10^9 */
  wide: sequence('txseq_wide_seq').startWith(5_000_000_000).incrementBy(1_000_000_000).build(),
  /** the last integers a JS number holds exactly */
  edge: sequence('txseq_edge_seq').startWith(Number.MAX_SAFE_INTEGER - 2).build(),
  /** options given as JS bigints */
  bigStep: sequence('txseq_big_step_seq').startWith(1_000_000_000_000n).incrementBy(7n).build(),
  /** -3, -2, -1, 0, … */
  belowZero: sequence('txseq_below_zero_seq').startWith(-3).minValue(-3).maxValue(3).build(),
  /** unqualified: public's (from 1), or — first on a search path — the one in txseq_garden (from 900) */
  shadow: sequence('txseq_shadow_seq').startWith(1).build(),
  /** created by the reset, but NOT reached in setupSequences: first reached wherever a test touches it */
  late: sequence('txseq_late_seq').startWith(1).build(),
  /** never created by the reset: a test creates it inside its transaction */
  fresh: sequence('txseq_fresh_seq').build(),
} satisfies Record<string, SequenceConfig>;

/** The other sequence named txseq_shadow_seq, in txseq_garden. */
const GARDEN_SHADOW = `"${GARDEN}"."txseq_shadow_seq"`;

/** Runtime-named sequences the runtimeSequence() pins create. */
const RUNTIME = [
  'txseq_rt_route_seq',
  'txseq_rt_rollback_seq',
  'txseq_rt_abort_seq',
  'txseq_rt_readonly_seq',
  'txseq_rt_side_seq',
  'txseq_rt_cache_seq',
  'txseq_rt_lite_seq',
];

class Harvest extends DbEntity {
  id!: DbColumn<number>;
  harvestNo!: DbColumn<number>;
  crop!: DbColumn<string>;
}

class GreenhouseDatabase extends DbContext {
  get harvests(): DbEntityTable<Harvest> {
    return this.table(Harvest);
  }

  get harvestNoSeq(): DbSequence {
    return this.sequence(SEQ.harvestNo);
  }

  get plantTagSeq(): DbSequence {
    return this.sequence(SEQ.plantTag);
  }

  get seedLotSeq(): DbSequence {
    return this.sequence(SEQ.seedLot);
  }

  get plotSeq(): DbSequence {
    return this.sequence(SEQ.plot);
  }

  get countdownSeq(): DbSequence {
    return this.sequence(SEQ.countdown);
  }

  get rotationSeq(): DbSequence {
    return this.sequence(SEQ.rotation);
  }

  get traySeq(): DbSequence {
    return this.sequence(SEQ.tray);
  }

  get wideSeq(): DbSequence {
    return this.sequence(SEQ.wide);
  }

  get edgeSeq(): DbSequence {
    return this.sequence(SEQ.edge);
  }

  get bigStepSeq(): DbSequence {
    return this.sequence(SEQ.bigStep);
  }

  get belowZeroSeq(): DbSequence {
    return this.sequence(SEQ.belowZero);
  }

  get shadowSeq(): DbSequence {
    return this.sequence(SEQ.shadow);
  }

  get lateSeq(): DbSequence {
    return this.sequence(SEQ.late);
  }

  get freshSeq(): DbSequence {
    return this.sequence(SEQ.fresh);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Harvest, entity => {
      entity.toTable('txseq_harvests');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'txseq_harvests_id_seq' }));
      entity.property(e => e.harvestNo).hasType(integer('harvest_no')).isRequired();
      entity.property(e => e.crop).hasType(varchar('crop', 40)).isRequired();
    });
  }

  protected override setupSequences(): void {
    // every model sequence but `late` and `fresh`
    this.harvestNoSeq;
    this.plantTagSeq;
    this.seedLotSeq;
    this.plotSeq;
    this.countdownSeq;
    this.rotationSeq;
    this.traySeq;
    this.wideSeq;
    this.edgeSeq;
    this.bigStepSeq;
    this.belowZeroSeq;
    this.shadowSeq;
  }
}

type Route = { via: 'root' | 'transaction'; sql: string };

/**
 * Forwards every call to `inner` and records which path each statement took: the client's own `query()` ("root")
 * or the query function a transaction hands out ("transaction").
 */
class RoutingClient extends DatabaseClient {
  readonly routes: Route[] = [];

  constructor(private readonly inner: DatabaseClient) {
    super();
  }

  query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<ClientQueryResult<T>> {
    this.routes.push({ via: 'root', sql });
    return this.inner.query<T>(sql, params, options);
  }

  connect(): Promise<PooledConnection> {
    return this.inner.connect();
  }

  end(): Promise<void> {
    return this.inner.end();
  }

  getDriverName(): string {
    return this.inner.getDriverName();
  }

  transaction<T>(callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<ClientQueryResult>) => Promise<T>): Promise<T> {
    return this.inner.transaction(query => callback((sql, params, options) => {
      this.routes.push({ via: 'transaction', sql });
      return query(sql, params, options);
    }));
  }

  supportsBinaryArrayResults(): boolean {
    return this.inner.supportsBinaryArrayResults();
  }

  losesNumericZeroScale(): boolean {
    return this.inner.losesNumericZeroScale();
  }

  /** `<via>: <sql>` of every statement that touched a sequence. */
  sequenceRoutes(): string[] {
    return this.routes.filter(route => /nextval|currval|setval|lastval|SEQUENCE/.test(route.sql)).map(route => `${route.via}: ${route.sql}`);
  }
}

/** A client of the run's driver whose pool holds `max` connections (PGlite: its one session, by nature). */
function clientWithPoolOf(max: number): DatabaseClient {
  const driver = (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase();
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

/** `promise`, or a rejection once `ms` pass — a draw that waits for a connection the pool will never free. */
async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });

  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ample for a draw that needs no second connection (they take a few ms). */
const DRAW_DEADLINE_MS = 5000;

/**
 * A transaction that runs `before`, then holds until `release()`, then runs `after` and commits with its result.
 * `ready` settles once `before` has run (also when it failed: `done` then rejects with its error).
 */
function holdTransaction<T>(
  ctx: GreenhouseDatabase,
  before: (trx: GreenhouseDatabase) => Promise<unknown>,
  after: (trx: GreenhouseDatabase) => Promise<T>
): { ready: Promise<void>; release: () => void; done: Promise<T> } {
  let release!: () => void;
  let markReady!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });

  const done = ctx.transaction(async trx => {
    try {
      await before(trx);
    } finally {
      markReady();
    }

    await released;
    return after(trx);
  });
  // a test that fails before awaiting `done` must not leave an unhandled rejection behind
  done.catch(() => undefined);

  return { ready, release, done };
}

/** The session's currval() of a sequence as text: exact beyond 2^53, and the same on every driver. */
async function currvalOf(ctx: DbContext, config: SequenceConfig): Promise<string> {
  const rows = await ctx.query<{ value: string }>('SELECT currval($1::regclass)::text AS value', [qualifiedSequenceName(config)]);
  return rows[0].value;
}

/** The session's lastval() as text. */
async function lastvalOf(ctx: DbContext): Promise<string> {
  const rows = await ctx.query<{ value: string }>('SELECT lastval()::text AS value');
  return rows[0].value;
}

async function dropGardenSequences(client: DatabaseClient): Promise<void> {
  const names = [...Object.values(SEQ).map(qualifiedSequenceName), GARDEN_SHADOW, ...RUNTIME.map(name => `"${name}"`)];
  await client.query(`DROP SEQUENCE IF EXISTS ${names.join(', ')}`);
}

/**
 * Every sequence recreated — a new OID each, so no pooled session keeps a currval() / lastval() of the one before —
 * `fresh` and the runtime sequences left absent, the table emptied.
 */
async function resetGarden(client: DatabaseClient): Promise<void> {
  await dropGardenSequences(client);

  for (const config of Object.values(SEQ)) {
    if (config !== SEQ.fresh) {
      await client.query(renderCreateSequenceStatement(config));
    }
  }

  await client.query(`CREATE SEQUENCE ${GARDEN_SHADOW} START WITH 900`);
  await client.query('TRUNCATE TABLE "txseq_harvests" RESTART IDENTITY');
}

/** Creates the schema of the greenhouse on the context's database. */
async function createGarden(ctx: GreenhouseDatabase): Promise<void> {
  await ctx.query('DROP TABLE IF EXISTS "txseq_harvests" CASCADE');
  await ctx.query(`CREATE SCHEMA IF NOT EXISTS "${GARDEN}"`);
  await ctx.getSchemaManager().ensureCreated();
}

async function dropGarden(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS "txseq_harvests" CASCADE');
  await dropGardenSequences(client);
  await client.query(`DROP SCHEMA IF EXISTS "${GARDEN}" CASCADE`);
}

const NEXTVAL = 'SELECT nextval($1::regclass) as value';

describe('model sequences reached through a transaction', () => {
  let routing: RoutingClient;
  let db: GreenhouseDatabase;
  const logged: string[] = [];

  beforeAll(async () => {
    routing = new RoutingClient(createFreshClient());
    db = new GreenhouseDatabase(routing, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        logged.push(message);
      },
    });
    await createGarden(db);
  });

  beforeEach(async () => {
    await resetGarden(routing);
    routing.routes.length = 0;
    logged.length = 0;
  });

  afterAll(async () => {
    try {
      await dropGarden(routing);
    } finally {
      await db.dispose();
    }
  });

  describe('a draw runs inside the transaction', () => {
    test('currval() in the transaction is the value the transaction drew', async () => {
      const seen = await db.transaction(async trx => {
        const drawn = await trx.harvestNoSeq.nextValue();
        return { drawn, current: await currvalOf(trx, SEQ.harvestNo) };
      });

      expect(seen).toEqual({ drawn: 1, current: '1' });
    });

    test('lastval() in the transaction is the value the transaction drew', async () => {
      const seen = await db.transaction(async trx => {
        const drawn = await trx.plantTagSeq.nextValue();
        return { drawn, last: await lastvalOf(trx) };
      });

      expect(seen).toEqual({ drawn: 100, last: '100' });
    });

    test('the nextval statement goes through the transaction\'s query function, never the root client', async () => {
      await db.transaction(async trx => {
        await trx.harvestNoSeq.nextValue();
      });

      expect(routing.sequenceRoutes()).toEqual([`transaction: ${NEXTVAL}`]);
    });

    test('currentValue() and resync() of the transaction\'s sequence run inside it as well', async () => {
      const seen = await db.transaction(async trx => [
        await trx.plantTagSeq.nextValue(),
        await trx.plantTagSeq.currentValue(),
        await trx.plantTagSeq.resync(500),
        await trx.plantTagSeq.currentValue(),
        await trx.plantTagSeq.nextValue(),
      ]);

      expect(seen).toEqual([100, 100, undefined, 500, 505]);
      expect(routing.sequenceRoutes()).toEqual([
        `transaction: ${NEXTVAL}`,
        'transaction: SELECT currval($1::regclass) as value',
        'transaction: SELECT setval($1::regclass, $2, true)',
        'transaction: SELECT currval($1::regclass) as value',
        `transaction: ${NEXTVAL}`,
      ]);
    });

    test('a sequence created in the still-uncommitted transaction is drawable through it, and gone after the rollback', async () => {
      // the root reaches the model sequence first, as an application would
      expect(db.freshSeq.getQualifiedName()).toBe('"txseq_fresh_seq"');

      await expectToReject(db.transaction(async trx => {
        await trx.query('CREATE SEQUENCE "txseq_fresh_seq" START WITH 7');
        expect([await trx.freshSeq.nextValue(), await trx.freshSeq.nextValue()]).toEqual([7, 8]);
        throw new Error('roll the new sequence back');
      }), 'roll the new sequence back');

      expect(await db.query('SELECT to_regclass(\'"txseq_fresh_seq"\') IS NULL AS gone')).toEqual([{ gone: true }]);
    });

    test('a draw in a READ ONLY transaction is refused, like every other write of that transaction', async () => {
      await expectToReject(db.transaction(async trx => {
        await trx.query('SET TRANSACTION READ ONLY');
        const refused = await expectToReject(trx.harvestNoSeq.nextValue(), 'cannot execute nextval() in a read-only transaction');
        expect(sqlStateOf(refused)).toBe('25006');
        throw new Error('leave the read-only transaction');
      }), 'leave the read-only transaction');

      // the refused draw consumed nothing
      expect(await db.harvestNoSeq.nextValue()).toBe(1);
    });

    test('a failed draw (an exhausted sequence) aborts the transaction, like any failed statement of it', async () => {
      await expectToReject(db.transaction(async trx => {
        expect([await trx.traySeq.nextValue(), await trx.traySeq.nextValue()]).toEqual([1, 2]);

        const exhausted = await expectToReject(trx.traySeq.nextValue(), 'nextval: reached maximum value of sequence "txseq_tray_seq" (2)');
        expect(sqlStateOf(exhausted)).toBe('2200H');

        const aborted = await expectToReject(trx.query('SELECT 1 AS one'), 'current transaction is aborted');
        expect(sqlStateOf(aborted)).toBe('25P02');
        throw new Error('leave the aborted transaction');
      }), 'leave the aborted transaction');
    });

    test('an unqualified sequence resolves through the TRANSACTION\'s search_path', async () => {
      const drawn = await db.transaction(async trx => {
        await trx.query(`SET LOCAL search_path TO "${GARDEN}", public`);
        return [await trx.shadowSeq.nextValue(), await trx.shadowSeq.nextValue()];
      });

      expect(drawn).toEqual([900, 901]);
      // SET LOCAL ended with the transaction: the root resolves public's
      expect(await db.shadowSeq.nextValue()).toBe(1);
    });
  });

  describe('draws in one transaction follow the sequence\'s options', () => {
    /** `count` draws of `pick(trx)` in one transaction, and its currval() after them. */
    const drawInTransaction = (pick: (trx: GreenhouseDatabase) => DbSequence, config: SequenceConfig, count: number) =>
      db.transaction(async trx => {
        const values: number[] = [];

        for (let i = 0; i < count; i++) {
          values.push(await pick(trx).nextValue());
        }

        return { values, current: await currvalOf(trx, config) };
      });

    test('consecutive draws are consecutive; currval() follows the last', async () => {
      expect(await drawInTransaction(trx => trx.harvestNoSeq, SEQ.harvestNo, 3)).toEqual({ values: [1, 2, 3], current: '3' });
    });

    test('INCREMENT BY 5 from 100', async () => {
      expect(await drawInTransaction(trx => trx.plantTagSeq, SEQ.plantTag, 3)).toEqual({ values: [100, 105, 110], current: '110' });
    });

    test('a descending sequence counts down', async () => {
      expect(await drawInTransaction(trx => trx.countdownSeq, SEQ.countdown, 3)).toEqual({ values: [10, 9, 8], current: '8' });
    });

    test('a CYCLE sequence wraps to its MINVALUE', async () => {
      expect(await drawInTransaction(trx => trx.rotationSeq, SEQ.rotation, 5)).toEqual({ values: [1, 2, 3, 1, 2], current: '2' });
    });

    test('a CACHE 20 sequence hands the one session consecutive values', async () => {
      expect(await drawInTransaction(trx => trx.seedLotSeq, SEQ.seedLot, 3)).toEqual({ values: [1, 2, 3], current: '3' });
    });

    test('a schema-qualified sequence', async () => {
      expect(await drawInTransaction(trx => trx.plotSeq, SEQ.plot, 2)).toEqual({ values: [1000, 1001], current: '1001' });
    });

    test('values beyond int4', async () => {
      expect(await drawInTransaction(trx => trx.wideSeq, SEQ.wide, 3)).toEqual({
        values: [5_000_000_000, 6_000_000_000, 7_000_000_000],
        current: '7000000000',
      });
    });

    test('values up to 2^53 - 1 arrive exact', async () => {
      expect(await drawInTransaction(trx => trx.edgeSeq, SEQ.edge, 3)).toEqual({
        values: [9007199254740989, 9007199254740990, 9007199254740991],
        current: '9007199254740991',
      });
    });

    test('options given as JS bigints', async () => {
      expect(await drawInTransaction(trx => trx.bigStepSeq, SEQ.bigStep, 2)).toEqual({
        values: [1_000_000_000_000, 1_000_000_000_007],
        current: '1000000000007',
      });
    });

    test('negative values', async () => {
      expect(await drawInTransaction(trx => trx.belowZeroSeq, SEQ.belowZero, 4)).toEqual({ values: [-3, -2, -1, 0], current: '0' });
    });

    test('draws issued in parallel inside one transaction share its one connection', async () => {
      const seen = await db.transaction(async trx => {
        const values = await Promise.all([trx.harvestNoSeq.nextValue(), trx.harvestNoSeq.nextValue(), trx.harvestNoSeq.nextValue()]);
        return { values, current: await currvalOf(trx, SEQ.harvestNo) };
      });

      expect(seen.values.sort((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(seen.current).toBe('3');
      expect(routing.sequenceRoutes()).toEqual([
        `transaction: ${NEXTVAL}`,
        `transaction: ${NEXTVAL}`,
        `transaction: ${NEXTVAL}`,
        'transaction: SELECT currval($1::regclass)::text AS value',
      ]);
    });
  });

  describe('which instance a context hands out', () => {
    test('one transaction hands out one instance per sequence', async () => {
      await db.transaction(async trx => {
        const first = trx.harvestNoSeq;
        expect(trx.harvestNoSeq).toBe(first);
        expect(first.getQualifiedName()).toBe('"txseq_harvest_no_seq"');
      });
    });

    test('the transaction\'s instance is its own, not the root\'s', async () => {
      const root = db.harvestNoSeq;

      await db.transaction(async trx => {
        expect(trx.harvestNoSeq).not.toBe(root);
      });
    });

    test('each transaction gets instances of its own', async () => {
      const first = await db.transaction(async trx => trx.harvestNoSeq);
      const second = await db.transaction(async trx => trx.harvestNoSeq);

      expect(second).not.toBe(first);
    });

    test('the transaction\'s instance names the same sequence with the same options', async () => {
      await db.transaction(async trx => {
        expect(trx.plotSeq.getQualifiedName()).toBe('"txseq_garden"."txseq_plot_seq"');
        expect(trx.plotSeq.getConfig()).toEqual({ name: 'txseq_plot_seq', schema: GARDEN, startWith: 1000, incrementBy: 1 });
        expect(trx.plotSeq.getConfig()).toEqual(db.plotSeq.getConfig());
      });
    });

    test('the root keeps its own instance across transactions', async () => {
      const before = db.harvestNoSeq;

      await db.transaction(async trx => {
        await trx.harvestNoSeq.nextValue();
      });

      expect(db.harvestNoSeq).toBe(before);
    });
  });

  describe('the root context', () => {
    test('draws on the root client, outside any transaction', async () => {
      expect([await db.harvestNoSeq.nextValue(), await db.harvestNoSeq.nextValue()]).toEqual([1, 2]);
      expect(routing.sequenceRoutes()).toEqual([`root: ${NEXTVAL}`, `root: ${NEXTVAL}`]);
    });

    test('draws from the same series as its transactions, each on its own path', async () => {
      const values = [await db.harvestNoSeq.nextValue()];
      values.push(...(await db.transaction(async trx => [await trx.harvestNoSeq.nextValue(), await trx.harvestNoSeq.nextValue()])));
      values.push(await db.harvestNoSeq.nextValue());

      expect(values).toEqual([1, 2, 3, 4]);
      expect(routing.sequenceRoutes()).toEqual([`root: ${NEXTVAL}`, `transaction: ${NEXTVAL}`, `transaction: ${NEXTVAL}`, `root: ${NEXTVAL}`]);
    });

    test('a sequence first reached inside a transaction leaves no transaction-bound instance behind for the root', async () => {
      const fresh = new GreenhouseDatabase(routing);
      const inTransaction = await fresh.transaction(async trx => {
        expect(await trx.lateSeq.nextValue()).toBe(1);
        return trx.lateSeq;
      });
      routing.routes.length = 0;

      expect(fresh.lateSeq).not.toBe(inTransaction);
      expect(await fresh.lateSeq.nextValue()).toBe(2);
      expect(routing.sequenceRoutes()).toEqual([`root: ${NEXTVAL}`]);
    });

    test('…nor for a root draw made while that transaction is still open', async () => {
      const fresh = new GreenhouseDatabase(routing);
      let inTransaction: DbSequence | undefined;
      const holder = holdTransaction(fresh, async trx => {
        inTransaction = trx.lateSeq;
      }, async () => undefined);
      await holder.ready;
      routing.routes.length = 0;

      // beside the open transaction; PGlite queues it behind the transaction instead
      const rootDraw = fresh.lateSeq.nextValue();
      let drawn = 0;

      try {
        if (concurrentSessions) {
          drawn = await rootDraw;
        }
      } finally {
        holder.release();
      }

      await holder.done;

      if (!concurrentSessions) {
        drawn = await rootDraw;
      }

      expect(drawn).toBe(1);
      expect(inTransaction).toBeInstanceOf(DbSequence);
      expect(fresh.lateSeq).not.toBe(inTransaction);
      expect(routing.sequenceRoutes()).toEqual([`root: ${NEXTVAL}`]);
    });

    test.skipIf(!concurrentSessions)('a root draw while a transaction is open leaves the transaction\'s session alone', async () => {
      const holder = holdTransaction(
        db,
        async trx => {
          expect(await trx.harvestNoSeq.nextValue()).toBe(1);
        },
        async trx => ({ current: await currvalOf(trx, SEQ.harvestNo), next: await trx.harvestNoSeq.nextValue() })
      );
      await holder.ready;
      let rootDrawn = 0;

      try {
        rootDrawn = await db.harvestNoSeq.nextValue();
      } finally {
        holder.release();
      }

      expect(rootDrawn).toBe(2);
      expect(await holder.done).toEqual({ current: '1', next: 3 });
    });
  });

  describe('commit and rollback', () => {
    test('a value drawn in a rolled-back transaction stays consumed', async () => {
      await expectToReject(db.transaction(async trx => {
        expect(await trx.harvestNoSeq.nextValue()).toBe(1);
        throw new Error('undo the transaction');
      }), 'undo the transaction');

      expect(await db.harvestNoSeq.nextValue()).toBe(2);
    });

    test('the transaction after a rollback draws on, in its own session', async () => {
      await expectToReject(db.transaction(async trx => {
        await trx.harvestNoSeq.nextValue();
        throw new Error('undo the transaction');
      }), 'undo the transaction');

      const seen = await db.transaction(async trx => {
        const drawn = await trx.harvestNoSeq.nextValue();
        return { drawn, current: await currvalOf(trx, SEQ.harvestNo) };
      });

      expect(seen).toEqual({ drawn: 2, current: '2' });
    });

    test('rows written with drawn numbers commit together with the draws', async () => {
      await db.transaction(async trx => {
        for (const crop of ['basil', 'thyme', 'sage']) {
          await trx.harvests.insert({ harvestNo: await trx.harvestNoSeq.nextValue(), crop });
        }

        // the last number written is the one this session drew last
        expect(await trx.query('SELECT max("harvest_no") = currval(\'"txseq_harvest_no_seq"\') AS same FROM "txseq_harvests"')).toEqual([{ same: true }]);
      });

      expect(await db.harvests.select(h => ({ harvestNo: h.harvestNo, crop: h.crop })).orderBy(h => h.harvestNo).toList()).toEqual([
        { harvestNo: 1, crop: 'basil' },
        { harvestNo: 2, crop: 'thyme' },
        { harvestNo: 3, crop: 'sage' },
      ]);
    });

    test('rows written with drawn numbers roll back with the transaction; the numbers stay consumed', async () => {
      await expectToReject(db.transaction(async trx => {
        await trx.harvests.insert({ harvestNo: await trx.harvestNoSeq.nextValue(), crop: 'fennel' });
        await trx.harvests.insert({ harvestNo: await trx.harvestNoSeq.nextValue(), crop: 'dill' });
        expect(await trx.harvests.count()).toBe(2);
        throw new Error('undo the harvest');
      }), 'undo the harvest');

      expect(await db.harvests.count()).toBe(0);
      expect(await db.harvestNoSeq.nextValue()).toBe(3);
    });

    test('a failing statement after a draw rolls the transaction back; the drawn value stays consumed', async () => {
      const failure = await expectToReject(db.transaction(async trx => {
        expect(await trx.harvestNoSeq.nextValue()).toBe(1);
        await trx.query('SELECT 1 / 0 AS impossible');
      }), 'division by zero');

      expect(sqlStateOf(failure)).toBe('22012');
      expect(await db.harvestNoSeq.nextValue()).toBe(2);
    });

    test('resync() in a transaction moves that session\'s currval() and the draws after it', async () => {
      const seen = await db.transaction(async trx => {
        await trx.harvestNoSeq.resync(40);
        const afterResync = await currvalOf(trx, SEQ.harvestNo);
        return { afterResync, next: await trx.harvestNoSeq.nextValue() };
      });

      expect(seen).toEqual({ afterResync: '40', next: 41 });
    });

    test('resync() is not undone by a rollback: setval() is not transactional', async () => {
      await expectToReject(db.transaction(async trx => {
        await trx.harvestNoSeq.resync(70);
        throw new Error('undo the transaction');
      }), 'undo the transaction');

      expect(await db.harvestNoSeq.nextValue()).toBe(71);
    });

    test('a savepoint rolled back to keeps the drawn value consumed and the session\'s currval()', async () => {
      const seen = await db.transaction(async trx => {
        await trx.query('SAVEPOINT before_draw');
        const inSavepoint = await trx.harvestNoSeq.nextValue();
        await trx.query('ROLLBACK TO SAVEPOINT before_draw');
        const current = await currvalOf(trx, SEQ.harvestNo);
        return { inSavepoint, current, next: await trx.harvestNoSeq.nextValue() };
      });

      expect(seen).toEqual({ inSavepoint: 1, current: '1', next: 2 });
    });

    test('a nested transaction() is still refused on a transaction\'s context (a savepoint is the way)', async () => {
      await db.transaction(async trx => {
        await expectToReject(trx.transaction(async inner => inner.harvestNoSeq.nextValue()), 'Nested transactions are not supported');
      });

      expect(routing.sequenceRoutes()).toEqual([]);
    });
  });

  describe('connections', () => {
    test('a pool of ONE connection: a transaction draws from its model sequence without a second connection', async () => {
      const single = new GreenhouseDatabase(clientWithPoolOf(1));

      try {
        const drawn = await single.transaction(trx => withinMs(trx.harvestNoSeq.nextValue(), DRAW_DEADLINE_MS, 'a draw inside a transaction on a pool of one'));
        expect(drawn).toBe(1);
        // the transaction gave its connection back: the root draws on
        expect(await single.harvestNoSeq.nextValue()).toBe(2);
      } finally {
        await single.dispose();
      }
    });

    test('a pool of one: several draws and writes in one transaction complete and commit', async () => {
      const single = new GreenhouseDatabase(clientWithPoolOf(1));

      try {
        await single.transaction(trx => withinMs((async () => {
          for (const crop of ['kale', 'leek']) {
            await trx.harvests.insert({ harvestNo: await trx.harvestNoSeq.nextValue(), crop });
          }
          await trx.plantTagSeq.nextValue();
        })(), DRAW_DEADLINE_MS, 'draws and writes inside a transaction on a pool of one'));

        expect(await single.harvests.select(h => ({ harvestNo: h.harvestNo, crop: h.crop })).orderBy(h => h.harvestNo).toList()).toEqual([
          { harvestNo: 1, crop: 'kale' },
          { harvestNo: 2, crop: 'leek' },
        ]);
        expect(await single.plantTagSeq.nextValue()).toBe(105);
      } finally {
        await single.dispose();
      }
    });

    test('a pool of three: three concurrent transactions that each draw all complete, with distinct values', async () => {
      const three = new GreenhouseDatabase(clientWithPoolOf(3));

      try {
        const outcomes = await Promise.allSettled([0, 1, 2].map(() => three.transaction(trx => withinMs(
          (async () => [await trx.harvestNoSeq.nextValue(), await trx.harvestNoSeq.nextValue()])(),
          DRAW_DEADLINE_MS,
          'draws of three concurrent transactions on a pool of three'
        ))));

        expect(outcomes.map(outcome => (outcome.status === 'rejected' ? String(outcome.reason) : outcome.status))).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
        const drawn = outcomes.flatMap(outcome => (outcome.status === 'fulfilled' ? outcome.value : []));
        expect(drawn.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      } finally {
        await three.dispose();
      }
    });

    test('concurrent transactions each draw in their own session: distinct values, each its own currval()', async () => {
      const seen = await Promise.all([0, 1, 2, 3, 4].map(() => db.transaction(async trx => {
        const values: number[] = [];

        for (let i = 0; i < 3; i++) {
          values.push(await trx.harvestNoSeq.nextValue());
        }

        return { values, current: await currvalOf(trx, SEQ.harvestNo) };
      })));

      expect(seen.flatMap(one => one.values).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(seen.map(one => one.current)).toEqual(seen.map(one => String(one.values[2])));
    });

    test.skipIf(!concurrentSessions)('two interleaved transactions each read their own currval()', async () => {
      const first = holdTransaction(db, trx => trx.harvestNoSeq.nextValue(), trx => currvalOf(trx, SEQ.harvestNo));
      await first.ready;
      const second = holdTransaction(
        db,
        async trx => [await trx.harvestNoSeq.nextValue(), await trx.harvestNoSeq.nextValue()],
        trx => currvalOf(trx, SEQ.harvestNo)
      );
      await second.ready;

      first.release();
      second.release();

      expect([await first.done, await second.done]).toEqual(['1', '3']);
    });
  });

  describe('runtimeSequence() keeps its ROOT binding', () => {
    test('on a transaction\'s context its statements go to the root client (PGlite, with one session, refuses at once)', async () => {
      await db.transaction(async trx => {
        const runtime = trx.runtimeSequence({ name: 'txseq_rt_route_seq', startWith: 1 });

        if (concurrentSessions) {
          expect(await runtime.nextValueCreatingIfMissing()).toBe(1);
        } else {
          await expectToReject(runtime.nextValueCreatingIfMissing(), 'PGliteClient: PGlite has a single session');
        }
      });

      expect(routing.sequenceRoutes()).toEqual(
        concurrentSessions
          ? [`root: ${NEXTVAL}`, 'root: CREATE SEQUENCE IF NOT EXISTS "txseq_rt_route_seq" START WITH 1', `root: ${NEXTVAL}`]
          : [`root: ${NEXTVAL}`]
      );
    });

    test.skipIf(!concurrentSessions)('a runtime sequence created from inside a transaction survives the caller\'s rollback', async () => {
      await expectToReject(db.transaction(async trx => {
        expect(await trx.runtimeSequence({ name: 'txseq_rt_rollback_seq', startWith: 1 }).nextValueCreatingIfMissing()).toBe(1);
        throw new Error('undo the caller');
      }), 'undo the caller');

      expect(await db.runtimeSequence({ name: 'txseq_rt_rollback_seq' }).nextValueCreatingIfMissing()).toBe(2);
    });

    test.skipIf(!concurrentSessions)('its failed first nextval (42P01, then the CREATE) does not abort the caller\'s transaction', async () => {
      const seen = await db.transaction(async trx => {
        const drawn = await trx.runtimeSequence({ name: 'txseq_rt_abort_seq', startWith: 1 }).nextValueCreatingIfMissing();
        // the 42P01 of the first nextval happened on the root: this transaction is still usable
        return { drawn, still: await trx.query<{ one: number }>('SELECT 1 AS one') };
      });

      expect(seen).toEqual({ drawn: 1, still: [{ one: 1 }] });
    });

    test.skipIf(!concurrentSessions)('in a READ ONLY transaction the runtime sequence still draws (on the root) while the model sequence is refused (inside)', async () => {
      await expectToReject(db.transaction(async trx => {
        await trx.query('SET TRANSACTION READ ONLY');
        expect(await trx.runtimeSequence({ name: 'txseq_rt_readonly_seq', startWith: 1 }).nextValueCreatingIfMissing()).toBe(1);
        await expectToReject(trx.harvestNoSeq.nextValue(), 'cannot execute nextval() in a read-only transaction');
        throw new Error('leave the read-only transaction');
      }), 'leave the read-only transaction');
    });

    test('side by side in one transaction: the model sequence draws inside it, the runtime sequence on the root', async () => {
      const seen = await db.transaction(async trx => {
        const model = await trx.harvestNoSeq.nextValue();
        const runtime = trx.runtimeSequence({ name: 'txseq_rt_side_seq', startWith: 50 });
        const runtimeValue = concurrentSessions ? await runtime.nextValueCreatingIfMissing() : null;
        return { model, runtime: runtimeValue, current: await currvalOf(trx, SEQ.harvestNo) };
      });

      expect(seen).toEqual({ model: 1, runtime: concurrentSessions ? 50 : null, current: '1' });
      expect(routing.sequenceRoutes()).toEqual([
        `transaction: ${NEXTVAL}`,
        ...(concurrentSessions ? [`root: ${NEXTVAL}`, 'root: CREATE SEQUENCE IF NOT EXISTS "txseq_rt_side_seq" START WITH 50', `root: ${NEXTVAL}`] : []),
        'transaction: SELECT currval($1::regclass)::text AS value',
      ]);
    });

    test('runtimeSequence() is neither cached nor registered, on a transaction\'s context either', async () => {
      const registered = [...db.getSequenceRegistry().keys()];

      await db.transaction(async trx => {
        const config = { name: 'txseq_rt_cache_seq' };
        expect(trx.runtimeSequence(config)).not.toBe(trx.runtimeSequence(config));
        expect(trx.runtimeSequence(config).getQualifiedName()).toBe('"txseq_rt_cache_seq"');
      });

      expect([...db.getSequenceRegistry().keys()]).toEqual(registered);
      expect(db.getSequenceRegistry().has('txseq_rt_cache_seq')).toBe(false);
    });
  });

  describe('nextValueCreatingIfMissing() on a transaction\'s instance: 1.0.10\'s outcome, without aborting the transaction', () => {
    const PROBE = 'SELECT to_regclass($1)::oid::text AS oid';
    const CREATE_FRESH = 'CREATE SEQUENCE IF NOT EXISTS "txseq_fresh_seq" INCREMENT BY 1';
    const ladderRoutes = () => routing.routes.filter(route => /to_regclass\(\$1\)|nextval|CREATE SEQUENCE/.test(route.sql)).map(route => `${route.via}: ${route.sql}`);

    test.skipIf(!concurrentSessions)('a MISSING model sequence is created and its first value drawn; the transaction stays usable', async () => {
      // the root reached the model sequence first, as setupSequences() does
      expect(db.freshSeq.getQualifiedName()).toBe('"txseq_fresh_seq"');

      const seen = await db.transaction(async trx => {
        const first = await trx.freshSeq.nextValueCreatingIfMissing();
        const next = await trx.freshSeq.nextValue();
        return { first, next, current: await currvalOf(trx, SEQ.fresh), usable: await trx.query('SELECT 1 AS one') };
      });

      expect(seen).toEqual({ first: 1, next: 2, current: '2', usable: [{ one: 1 }] });
      expect(await db.query('SELECT to_regclass(\'"txseq_fresh_seq"\') IS NOT NULL AS present')).toEqual([{ present: true }]);
    });

    test.skipIf(!concurrentSessions)('its CREATE runs on the ROOT client, so the caller\'s rollback does not undo it (as runtimeSequence())', async () => {
      await expectToReject(db.transaction(async trx => {
        expect(await trx.freshSeq.nextValueCreatingIfMissing()).toBe(1);
        throw new Error('undo the caller');
      }), 'undo the caller');

      expect(await db.freshSeq.nextValue()).toBe(2);
    });

    test.skipIf(!concurrentSessions)('the statements: the probe and the draw in the transaction, the CREATE and the OID lookup on the root', async () => {
      await db.transaction(async trx => {
        await trx.freshSeq.nextValueCreatingIfMissing();
      });

      expect(ladderRoutes()).toEqual([`transaction: ${PROBE}`, `root: ${CREATE_FRESH}`, `root: ${PROBE}`, `transaction: ${NEXTVAL}`]);
    });

    test.skipIf(!concurrentSessions)('the bigint variant does the same', async () => {
      const first = await db.transaction(async trx => trx.freshSeq.nextValueCreatingIfMissingBigInt());

      expect(first).toBe(1n);
      expect(await db.freshSeq.nextValue()).toBe(2);
    });

    test('an EXISTING model sequence: the probe finds it and the draw runs in the transaction — nothing on the root', async () => {
      const seen = await db.transaction(async trx => ({ drawn: await trx.harvestNoSeq.nextValueCreatingIfMissing(), current: await currvalOf(trx, SEQ.harvestNo) }));

      expect(seen).toEqual({ drawn: 1, current: '1' });
      expect(ladderRoutes()).toEqual([`transaction: ${PROBE}`, `transaction: ${NEXTVAL}`]);
    });

    test('on the ROOT context the ladder is unchanged: nextval, then on 42P01 the CREATE and nextval again', async () => {
      expect(await db.freshSeq.nextValueCreatingIfMissing()).toBe(1);

      expect(ladderRoutes()).toEqual([`root: ${NEXTVAL}`, `root: ${CREATE_FRESH}`, `root: ${NEXTVAL}`]);
    });
  });

  describe('what the transaction shares with the root', () => {
    test('the sequence registry — configuration, read by the schema manager — is the root\'s', async () => {
      await db.transaction(async trx => {
        expect(trx.getSequenceRegistry()).toBe(db.getSequenceRegistry());
      });
    });

    test('a sequence first reached inside a transaction is registered for the schema manager', async () => {
      const fresh = new GreenhouseDatabase(routing);
      expect(fresh.getSequenceRegistry().has('txseq_late_seq')).toBe(false);

      await fresh.transaction(async trx => {
        expect(trx.lateSeq.getQualifiedName()).toBe('"txseq_late_seq"');
      });

      expect(fresh.getSequenceRegistry().get('txseq_late_seq')).toBe(SEQ.late);
    });

    test('a draw through the transaction stays unlogged, like a draw on the root', async () => {
      await db.transaction(async trx => {
        await trx.harvestNoSeq.nextValue();
        await trx.harvests.count();
      });

      expect(logged.filter(line => /nextval|currval|setval/.test(line))).toEqual([]);
      expect(logged.filter(line => line.includes('"txseq_harvests"'))).toHaveLength(1);
    });

    test('transaction options run first; the draw after them still runs inside the transaction', async () => {
      await db.transaction(async trx => {
        await trx.harvestNoSeq.nextValue();
      }, { timeoutMs: 5000 });

      expect(routing.routes.map(route => `${route.via}: ${route.sql}`)).toEqual([
        'transaction: SET LOCAL statement_timeout = 5000',
        `transaction: ${NEXTVAL}`,
      ]);
    });
  });

  describe('migrations: MigrationRunner runs up() on a transaction\'s context', () => {
    const JOURNAL = 'txseq_journal';
    let dir = '';

    /** A migration file whose `up(db)` is `body` (TypeScript, no imports — the runner require()s it). */
    const writeMigration = (filename: string, body: string[]) => {
      writeFileSync(
        path.join(dir, filename),
        `export default class {\n  async up(db: any): Promise<void> {\n${body.map(line => `    ${line}`).join('\n')}\n  }\n\n  async down(): Promise<void> {}\n}\n`
      );
    };

    const runMigrations = () => new MigrationRunner(db, { migrationsDirectory: dir, journalTable: JOURNAL, logger: () => undefined }).up();

    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'linkgress-txseq-'));
      await routing.query(`DROP TABLE IF EXISTS "${JOURNAL}"`);
      // an existing journal: the runner applies the pending files (a fresh database would baseline them)
      await new MigrationJournal(routing, { journalTable: JOURNAL }).ensureTable();
    });

    afterEach(async () => {
      rmSync(dir, { recursive: true, force: true });
      await routing.query(`DROP TABLE IF EXISTS "${JOURNAL}"`);
    });

    test('a migration that creates a model sequence and numbers its seed rows from it applies as one transaction', async () => {
      // the root reached the model sequence first, as an application's setupSequences() does
      expect(db.freshSeq.getQualifiedName()).toBe('"txseq_fresh_seq"');
      writeMigration('20260928-000001.ts', [
        'await db.query(\'CREATE SEQUENCE "txseq_fresh_seq" START WITH 7\');',
        'for (const crop of [\'rye\', \'oat\']) {',
        '  await db.harvests.insert({ harvestNo: await db.freshSeq.nextValue(), crop });',
        '}',
      ]);

      const result = await runMigrations();

      expect(result.failed?.error.message).toBeUndefined();
      expect(result.applied).toEqual(['20260928-000001.ts']);
      expect(await db.harvests.select(h => ({ harvestNo: h.harvestNo, crop: h.crop })).orderBy(h => h.harvestNo).toList()).toEqual([
        { harvestNo: 7, crop: 'rye' },
        { harvestNo: 8, crop: 'oat' },
      ]);
      expect(await db.freshSeq.nextValue()).toBe(9);
    });

    test('a failing migration rolls its numbered rows back; the numbers it drew stay consumed', async () => {
      writeMigration('20260928-000002.ts', [
        'for (const crop of [\'barley\', \'millet\']) {',
        '  await db.harvests.insert({ harvestNo: await db.harvestNoSeq.nextValue(), crop });',
        '}',
        'throw new Error(\'the seeding migration fails\');',
      ]);

      const result = await runMigrations();

      expect(result.failed?.filename).toBe('20260928-000002.ts');
      expect(result.failed?.error.message).toBe('the seeding migration fails');
      expect(result.applied).toEqual([]);
      expect(await db.harvests.count()).toBe(0);
      expect(await db.harvestNoSeq.nextValue()).toBe(3);
    });
  });

  test('a transaction\'s context keeps the model\'s typed sequence accessors', async () => {
    await db.transaction(async trx => {
      const accessor: AssertType<typeof trx.harvestNoSeq, DbSequence> = trx.harvestNoSeq;
      const drawn: AssertType<Awaited<ReturnType<DbSequence['nextValue']>>, number> = await accessor.nextValue();

      expect(drawn).toBe(1);
    });
  });
});

describe('PGlite, one session: model sequences inside transaction()', () => {
  let lite: GreenhouseDatabase;

  beforeAll(async () => {
    lite = new GreenhouseDatabase(new PGliteClient());
    await createGarden(lite);
  });

  beforeEach(async () => {
    await resetGarden(lite.getClient());
  });

  afterAll(async () => {
    await lite.dispose();
  });

  test('transaction(trx => trx.<sequence>.nextValue()) draws — a root call there would be refused', async () => {
    expect(await lite.transaction(trx => trx.harvestNoSeq.nextValue())).toBe(1);
    expect(await lite.harvestNoSeq.nextValue()).toBe(2);
  });

  test('nextValueCreatingIfMissing() on a transaction\'s instance of a MISSING sequence is refused at once — its CREATE needs the root session — and the transaction stays usable', async () => {
    expect(lite.freshSeq.getQualifiedName()).toBe('"txseq_fresh_seq"');

    const usable = await lite.transaction(async trx => {
      await expectToReject(trx.freshSeq.nextValueCreatingIfMissing(), 'PGliteClient: PGlite has a single session');
      return trx.query('SELECT 1 AS one');
    });

    expect(usable).toEqual([{ one: 1 }]);
    expect(await lite.query('SELECT to_regclass(\'"txseq_fresh_seq"\') IS NULL AS gone')).toEqual([{ gone: true }]);
  });

  test('nextValueCreatingIfMissing() on a transaction\'s instance of an EXISTING sequence draws in the transaction', async () => {
    const seen = await lite.transaction(async trx => ({ drawn: await trx.harvestNoSeq.nextValueCreatingIfMissing(), current: await currvalOf(trx, SEQ.harvestNo) }));

    expect(seen).toEqual({ drawn: 1, current: '1' });
  });

  test('currval() and lastval() in the transaction are the drawn value', async () => {
    const seen = await lite.transaction(async trx => {
      const drawn = await trx.plantTagSeq.nextValue();
      return { drawn, current: await currvalOf(trx, SEQ.plantTag), last: await lastvalOf(trx) };
    });

    expect(seen).toEqual({ drawn: 100, current: '100', last: '100' });
  });

  test('draws and the rows written with them commit together', async () => {
    await lite.transaction(async trx => {
      for (const crop of ['chive', 'mint']) {
        await trx.harvests.insert({ harvestNo: await trx.harvestNoSeq.nextValue(), crop });
      }
    });

    expect(await lite.harvests.select(h => ({ harvestNo: h.harvestNo, crop: h.crop })).orderBy(h => h.harvestNo).toList()).toEqual([
      { harvestNo: 1, crop: 'chive' },
      { harvestNo: 2, crop: 'mint' },
    ]);
  });

  test('a rolled-back draw stays consumed; the next transaction draws on', async () => {
    await expectToReject(lite.transaction(async trx => {
      expect(await trx.harvestNoSeq.nextValue()).toBe(1);
      throw new Error('undo the transaction');
    }), 'undo the transaction');

    expect(await lite.transaction(trx => trx.harvestNoSeq.nextValue())).toBe(2);
  });

  test('transactions queued on the one session each draw in turn', async () => {
    const drawn = await Promise.all([0, 1, 2].map(() => lite.transaction(async trx => [await trx.harvestNoSeq.nextValue(), await trx.harvestNoSeq.nextValue()])));

    // the session lock runs them one after another, in call order
    expect(drawn).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  test('resync() and currentValue() inside a transaction', async () => {
    const seen = await lite.transaction(async trx => {
      await trx.countdownSeq.resync(5);
      return [await trx.countdownSeq.currentValue(), await trx.countdownSeq.nextValue()];
    });

    expect(seen).toEqual([5, 4]);
  });

  test('runtimeSequence() on the transaction\'s context is still refused at once — its documented root binding', async () => {
    await lite.transaction(async trx => {
      await expectToReject(
        trx.runtimeSequence({ name: 'txseq_rt_lite_seq' }).nextValueCreatingIfMissing(),
        'PGliteClient: PGlite has a single session, and the transaction running this callback holds it'
      );
    });

    expect(await lite.runtimeSequence({ name: 'txseq_rt_lite_seq' }).nextValueCreatingIfMissing()).toBe(1);
  });
});
