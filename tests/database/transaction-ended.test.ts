import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as linkgress from '../../src';
import {
  BunClient,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  DbSequence,
  eq,
  FutureQueryRunner,
  integer,
  MutationBatch,
  PgClient,
  PGliteClient,
  PostgresClient,
  QueryBatch,
  sequence,
  sql,
  unnest,
  varchar,
} from '../../src';
import type { ClientQueryResult, PooledConnection, QueryExecutionOptions } from '../../src';
import { qualifiedSequenceName, renderCreateSequenceStatement } from '../../src/schema/sequence-builder';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';

/**
 * Objects obtained from a transaction's context — table accessors, sequences, query builders, futures, batches,
 * prepared queries, its schema manager, its client — used AFTER that transaction ended (committed, rolled back or
 * failed). They route their statements through the transaction's query function, which holds the pooled
 * connection the transaction has since released: the statement used to run silently on that connection — outside
 * any transaction, or inside ANOTHER transaction that holds it by then. It is now refused with a
 * `TransactionEndedError` before it reaches the database; inside the transaction (also in parallel) and on the
 * root context nothing changes.
 *
 * `TransactionEndedError` is read from the package namespace, so that on a build without it the file still loads
 * and every test reports its own outcome.
 *
 * Domain: a workshop's tools.
 */

/** PGlite runs ONE session: nothing runs beside an open transaction there. */
const concurrentSessions = process.env.LINKGRESS_TEST_DRIVER !== 'pglite';

class Tool extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  weight!: DbColumn<number>;
}

const REPAIR_NO = sequence('txend_repair_no_seq').startWith(1).build();

class WorkshopDatabase extends DbContext {
  get tools(): DbEntityTable<Tool> {
    return this.table(Tool);
  }

  get repairNoSeq(): DbSequence {
    return this.sequence(REPAIR_NO);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Tool, entity => {
      entity.toTable('txend_tools');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'txend_tools_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 60)).isRequired();
      entity.property(e => e.weight).hasType(integer('weight')).isRequired();
      entity.hasIndex('ux_txend_tools_name', e => [e.name]).isUnique();
    });
  }

  protected override setupSequences(): void {
    this.repairNoSeq;
  }
}

type Route = { via: 'root' | 'transaction'; sql: string };

/** Records which path each statement took: the client's own `query()` or a transaction's query function. */
class RoutingClient extends DatabaseClient {
  readonly routes: Route[] = [];

  constructor(private readonly inner: DatabaseClient) {
    super();
  }

  query<T = any>(text: string, params?: any[], options?: QueryExecutionOptions): Promise<ClientQueryResult<T>> {
    this.routes.push({ via: 'root', sql: text });
    return this.inner.query<T>(text, params, options);
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
    return this.inner.transaction(query => callback((text, params, options) => {
      this.routes.push({ via: 'transaction', sql: text });
      return query(text, params, options);
    }));
  }

  supportsBinaryArrayResults(): boolean {
    return this.inner.supportsBinaryArrayResults();
  }

  losesNumericZeroScale(): boolean {
    return this.inner.losesNumericZeroScale();
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

/** A transaction that runs `before`, holds until `release()`, then runs `after` and commits with its result. */
function holdTransaction<T>(
  ctx: WorkshopDatabase,
  before: (trx: WorkshopDatabase) => Promise<unknown>,
  after: (trx: WorkshopDatabase) => Promise<T>
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
  done.catch(() => undefined);

  return { ready, release, done };
}

const ENDED = 'this transaction has already ended';

/** `work` is refused with a TransactionEndedError, before any statement reaches the database. */
async function expectRefused(work: PromiseLike<unknown> | (() => PromiseLike<unknown>)): Promise<any> {
  const error = await expectToReject(work, ENDED);
  expect(error.name).toBe('TransactionEndedError');
  expect(error).toBeInstanceOf((linkgress as any).TransactionEndedError);
  return error;
}

async function createWorkshop(ctx: WorkshopDatabase): Promise<void> {
  await ctx.query('DROP TABLE IF EXISTS "txend_tools" CASCADE');
  await ctx.query(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName(REPAIR_NO)}`);
  await ctx.getSchemaManager().ensureCreated();
}

async function resetWorkshop(client: DatabaseClient): Promise<void> {
  await client.query('TRUNCATE TABLE "txend_tools" RESTART IDENTITY');
  await client.query(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName(REPAIR_NO)}`);
  await client.query(renderCreateSequenceStatement(REPAIR_NO));
}

describe('a transaction\'s objects after the transaction ended', () => {
  let routing: RoutingClient;
  let db: WorkshopDatabase;

  /** A context whose transaction has committed. */
  const committedContext = () => db.transaction(async trx => trx);

  /** How many tools the ROOT sees. */
  const toolCount = () => db.tools.count();

  beforeAll(async () => {
    routing = new RoutingClient(createFreshClient());
    db = new WorkshopDatabase(routing);
    await createWorkshop(db);
  });

  beforeEach(async () => {
    await resetWorkshop(routing);
    await db.tools.insertBulk([{ name: 'saw', weight: 3 }, { name: 'plane', weight: 2 }]);
    routing.routes.length = 0;
  });

  afterAll(async () => {
    try {
      await routing.query('DROP TABLE IF EXISTS "txend_tools" CASCADE');
      await routing.query(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName(REPAIR_NO)}`);
    } finally {
      await db.dispose();
    }
  });

  describe('reads are refused', () => {
    test('toList()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.toList());
    });

    test('count() and exists()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.count());
      await expectRefused(kept.tools.exists());
    });

    test('a filtered, projected, ordered query', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.where(t => eq(t.name, 'saw')).select(t => ({ name: t.name, weight: t.weight })).orderBy(t => t.name).toList());
    });

    test('a query built inside the transaction but awaited after it', async () => {
      const { query } = await db.transaction(async trx => ({ query: trx.tools.where(t => eq(t.weight, 3)).select(t => ({ name: t.name })) }));
      await expectRefused(query.toList());
    });

    test('firstOrDefault()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.where(t => eq(t.name, 'plane')).firstOrDefault());
    });

    test('a set-returning query (selectFromSet)', async () => {
      const kept = await committedContext();
      await expectRefused(kept.selectFromSet(unnest([1, 2], 'integer'), 'n').select(n => ({ v: n.value })).toList());
    });
  });

  describe('writes are refused — and change nothing', () => {
    test('insert()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.insert({ name: 'chisel', weight: 1 }));
      expect(await toolCount()).toBe(2);
    });

    test('insertBulk()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.insertBulk([{ name: 'chisel', weight: 1 }, { name: 'rasp', weight: 1 }]));
      expect(await toolCount()).toBe(2);
    });

    test('upsert()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.upsert([{ name: 'saw', weight: 9 }], { primaryKey: 'name' }));
      expect(await db.tools.where(t => eq(t.name, 'saw')).select(t => ({ weight: t.weight })).toList()).toEqual([{ weight: 3 }]);
    });

    test('where(…).update(…)', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.where(t => eq(t.name, 'plane')).update({ weight: 7 }));
      expect(await db.tools.where(t => eq(t.name, 'plane')).select(t => ({ weight: t.weight })).toList()).toEqual([{ weight: 2 }]);
    });

    test('bulkUpdate()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.bulkUpdate([{ name: 'plane', weight: 8 }], { primaryKey: 'name' }));
      expect(await db.tools.where(t => eq(t.name, 'plane')).select(t => ({ weight: t.weight })).toList()).toEqual([{ weight: 2 }]);
    });

    test('where(…).delete()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.where(t => eq(t.name, 'saw')).delete());
      expect(await toolCount()).toBe(2);
    });
  });

  describe('sequences are refused', () => {
    test('nextValue() / nextValueBigInt() — nothing is drawn', async () => {
      const kept = await committedContext();
      await expectRefused(kept.repairNoSeq.nextValue());
      await expectRefused(kept.repairNoSeq.nextValueBigInt());
      expect(await db.repairNoSeq.nextValue()).toBe(1);
    });

    test('currentValue() and resync()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.repairNoSeq.currentValue());
      await expectRefused(kept.repairNoSeq.resync(50));
      expect(await db.repairNoSeq.nextValue()).toBe(1);
    });
  });

  describe('raw statements are refused', () => {
    test('query(text)', async () => {
      const kept = await committedContext();
      await expectRefused(kept.query('SELECT 1 AS one'));
    });

    test('query(sql fragment)', async () => {
      const kept = await committedContext();
      await expectRefused(kept.query(sql`SELECT ${1} AS one`));
    });

    test('the context\'s client (getClient().query)', async () => {
      const kept = await committedContext();
      await expectRefused(kept.getClient().query('SELECT 1 AS one'));
    });

    test('a transaction-scoped advisory lock', async () => {
      const kept = await committedContext();
      await expectRefused(kept.advisoryXactLock(4242));
    });
  });

  describe('deferred and batched execution is refused', () => {
    test('a future built inside the transaction, executed after it', async () => {
      const { future } = await db.transaction(async trx => ({ future: trx.tools.select(t => ({ name: t.name })).future() }));
      await expectRefused(future.execute());
    });

    test('FutureQueryRunner.runAsync()', async () => {
      const kept = await committedContext();
      await expectRefused(FutureQueryRunner.runAsync([kept.tools.select(t => ({ name: t.name })).future(), kept.tools.futureCount()]));
    });

    test('QueryBatch.executeBatch()', async () => {
      const kept = await committedContext();
      const batch = new QueryBatch();
      batch.addList(kept.tools.select(t => ({ name: t.name })), 'tools');
      batch.addCount(kept.tools, 'count');
      await expectRefused(batch.executeBatch());
    });

    test('MutationBatch.executeBatch() — nothing is written', async () => {
      const kept = await committedContext();
      const batch = new MutationBatch();
      batch.addInsertBulk(kept.tools, [{ name: 'mallet', weight: 2 }], 'inserted');
      await expectRefused(batch.executeBatch());
      expect(await toolCount()).toBe(2);
    });

    test('a prepared query built inside the transaction, executed after it', async () => {
      const { prepared } = await db.transaction(async trx => ({
        prepared: trx.tools.where(t => eq(t.name, sql.placeholder('name'))).select(t => ({ weight: t.weight })).prepare('txend_tool_weight'),
      }));
      await expectRefused(prepared.execute({ name: 'saw' }));
    });
  });

  describe('FutureQueryRunner refuses futures of different connection contexts, like QueryBatch', () => {
    const MIXED = 'uses a different database client or transaction than the rest of the batch — all futures must share one connection context';

    test('an ENDED transaction\'s future next to a root future: refused before either runs', async () => {
      const kept = await committedContext();
      routing.routes.length = 0;

      await expectToReject(FutureQueryRunner.runAsync([db.tools.select(t => ({ name: t.name })).future(), kept.tools.futureCount()]), `FutureQueryRunner: future #1 ${MIXED}`);
      expect(routing.routes).toEqual([]);
    });

    test('a root future next to a LIVE transaction\'s future: refused — the transaction\'s would run outside it', async () => {
      await db.transaction(async trx => {
        await trx.tools.insert({ name: 'file', weight: 1 });
        routing.routes.length = 0;

        await expectToReject(FutureQueryRunner.runAsync([db.tools.futureCount(), trx.tools.futureCount()]), `FutureQueryRunner: future #1 ${MIXED}`);
        await expectToReject(FutureQueryRunner.runAsync([trx.tools.futureCount(), db.tools.futureCount()]), `FutureQueryRunner: future #1 ${MIXED}`);
        expect(routing.routes).toEqual([]);
      });
    });

    test('futures of ONE transaction all run inside it (its uncommitted row counts)', async () => {
      const seen = await db.transaction(async trx => {
        await trx.tools.insert({ name: 'file', weight: 1 });
        return FutureQueryRunner.runAsync([trx.tools.select(t => ({ name: t.name })).orderBy(t => t.name).future(), trx.tools.futureCount()] as const);
      });

      expect(seen).toEqual([[{ name: 'file' }, { name: 'plane' }, { name: 'saw' }], 3]);
    });

    test('futures of the root all run, as before', async () => {
      const seen = await FutureQueryRunner.runAsync([db.tools.select(t => ({ name: t.name })).orderBy(t => t.name).future(), db.tools.futureCount()] as const);

      expect(seen).toEqual([[{ name: 'plane' }, { name: 'saw' }], 2]);
    });

    test('futures of ONE ended transaction are refused as ended', async () => {
      const kept = await committedContext();

      await expectRefused(FutureQueryRunner.runAsync([kept.tools.futureCount(), kept.tools.futureCount()]));
    });

    test('on the driver\'s own client — postgres.js, Bun and PGlite run a parameterless batch as ONE multi-statement round trip on the first future\'s client — a live transaction\'s future is refused, not run outside it', async () => {
      const plain = new WorkshopDatabase(createFreshClient());

      try {
        const inside = await plain.transaction(async trx => {
          await trx.tools.insert({ name: 'file', weight: 1 });
          await expectToReject(FutureQueryRunner.runAsync([plain.tools.futureCount(), trx.tools.futureCount()]), `FutureQueryRunner: future #1 ${MIXED}`);

          return FutureQueryRunner.runAsync([trx.tools.futureCount(), trx.tools.where(t => eq(t.name, 'file')).futureCount()] as const);
        });

        expect(inside).toEqual([3, 1]);
      } finally {
        await plain.dispose();
      }
    });

    test('a future built with per-query options carries an executor of its own: another context, as in QueryBatch', async () => {
      await expectToReject(FutureQueryRunner.runAsync([db.tools.futureCount(), db.tools.withTimeout(5000).futureCount()]), `FutureQueryRunner: future #1 ${MIXED}`);
      expect(routing.routes).toEqual([]);

      const timed = db.tools.withTimeout(5000);
      expect(await FutureQueryRunner.runAsync([timed.futureCount(), timed.where(t => eq(t.name, 'saw')).futureCount()] as const)).toEqual([2, 1]);
    });
  });

  describe('the transaction\'s schema manager is refused', () => {
    test('ensureCreated()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.getSchemaManager().ensureCreated());
    });

    test('a schema manager obtained inside the transaction, used after it', async () => {
      const { manager } = await db.transaction(async trx => ({ manager: trx.getSchemaManager() }));
      await expectRefused(manager.ensureCreated());
    });

    test('migrate()', async () => {
      const kept = await committedContext();
      await expectRefused(kept.getSchemaManager().migrate());
    });
  });

  describe('however the transaction ended', () => {
    test('committed', async () => {
      const kept = await db.transaction(async trx => {
        await trx.tools.insert({ name: 'file', weight: 1 });
        return trx;
      });
      await expectRefused(kept.tools.count());
      expect(await toolCount()).toBe(3);
    });

    test('rolled back (the callback threw)', async () => {
      let kept: WorkshopDatabase | undefined;
      await expectToReject(db.transaction(async trx => {
        kept = trx;
        await trx.tools.insert({ name: 'file', weight: 1 });
        throw new Error('undo the work');
      }), 'undo the work');

      await expectRefused(kept!.tools.count());
      expect(await toolCount()).toBe(2);
    });

    test('failed (a statement of it failed)', async () => {
      let kept: WorkshopDatabase | undefined;
      await expectToReject(db.transaction(async trx => {
        kept = trx;
        await trx.tools.insert({ name: 'saw', weight: 1 }); // the unique name is taken
      }), 'duplicate key');

      await expectRefused(kept!.query('SELECT 1 AS one'));
    });
  });

  describe('what the refusal looks like', () => {
    test('a TransactionEndedError carrying the refused statement, which never reaches the database', async () => {
      const kept = await committedContext();
      routing.routes.length = 0;

      const error = await expectRefused(kept.query('SELECT 1 AS refused_statement'));

      expect(error.sql).toBe('SELECT 1 AS refused_statement');
      expect(error.message).toContain('only valid inside transaction()');
      expect(routing.routes).toEqual([]);
    });

    test('an ENDED context\'s transaction() is refused as ended — the real cause — not as nested', async () => {
      const kept = await committedContext();

      const error = await expectRefused(kept.transaction(async inner => inner.query('SELECT 1')));
      expect(error.sql).toBe('BEGIN');
      expect(routing.routes).toEqual([]);
    });

    test('a LIVE transaction\'s context still refuses a nested transaction() as nested', async () => {
      await db.transaction(async trx => {
        await expectToReject(trx.transaction(async inner => inner.query('SELECT 1')), 'Nested transactions are not supported');
      });
    });
  });

  describe('it can no longer mix into another transaction', () => {
    test('on a pool of ONE: a kept write while a second transaction holds the connection is refused — not run inside it', async () => {
      const single = new WorkshopDatabase(clientWithPoolOf(1));

      try {
        const kept = await single.transaction(async trx => trx);
        const second = holdTransaction(single, async () => undefined, async trx => trx.tools.count());
        await second.ready;

        // started beside the second transaction (PGlite: queued behind it, before the fix run on its session)
        const stray = kept.tools.insert({ name: 'stray chisel', weight: 1 });
        const strayOutcome = stray.then(() => 'ran', (error: any) => error);
        await new Promise(resolve => setTimeout(resolve, 50));
        second.release();

        expect(await second.done).toBe(2);
        const outcome = await strayOutcome;
        expect(outcome?.name).toBe('TransactionEndedError');
        expect(await single.tools.count()).toBe(2);
      } finally {
        await single.dispose();
      }
    });

    test('a query function leaked out of the driver\'s transaction() is refused too', async () => {
      const client = createFreshClient();

      try {
        let leaked: ((text: string, params?: any[]) => Promise<ClientQueryResult>) | undefined;
        await client.transaction(async query => {
          leaked = query;
          await query('SELECT 1 AS inside');
        });

        const error = await expectRefused(leaked!('SELECT 1 AS outside'));
        expect(error.sql).toBe('SELECT 1 AS outside');
      } finally {
        await client.end();
      }
    });
  });

  describe('inside the transaction and on the root nothing changes', () => {
    test('inside, every path works', async () => {
      const seen = await db.transaction(async trx => {
        const batch = new QueryBatch();
        const listKey = batch.addList(trx.tools.select(t => ({ name: t.name })).orderBy(t => t.name), 'tools');
        const mutations = new MutationBatch();
        mutations.addInsertBulk(trx.tools, [{ name: 'mallet', weight: 2 }], 'inserted');
        const prepared = trx.tools.where(t => eq(t.name, sql.placeholder('name'))).select(t => ({ weight: t.weight })).prepare('txend_inside_weight');

        await trx.tools.insert({ name: 'file', weight: 1 });
        await trx.tools.where(t => eq(t.name, 'plane')).update({ weight: 5 });
        await batch.executeBatch();
        await mutations.executeBatch();
        await trx.advisoryXactLock(4242);

        return {
          count: await trx.tools.count(),
          drawn: await trx.repairNoSeq.nextValue(),
          raw: await trx.query<{ one: number }>('SELECT 1 AS one'),
          list: batch.getList(listKey),
          future: await trx.tools.futureCount().execute(),
          prepared: await prepared.execute({ name: 'plane' }),
        };
      });

      expect(seen).toEqual({
        count: 4,
        drawn: 1,
        raw: [{ one: 1 }],
        list: [{ name: 'file' }, { name: 'plane' }, { name: 'saw' }],
        future: 4,
        prepared: [{ weight: 5 }],
      });
    });

    test('inside, in parallel: reads, writes and draws of one transaction', async () => {
      const seen = await db.transaction(async trx => {
        // every result is independent of the order the statements reach the server in
        const [sawWeight, drawn, inserted, raw] = await Promise.all([
          trx.tools.where(t => eq(t.name, 'saw')).select(t => ({ weight: t.weight })).toList(),
          trx.repairNoSeq.nextValue(),
          trx.tools.insert({ name: 'awl', weight: 1 }).returning(),
          trx.query<{ one: number }>('SELECT 1 AS one'),
        ]);
        return { sawWeight, drawn, insertedName: inserted.name, raw, after: await trx.tools.count() };
      });

      expect(seen).toEqual({ sawWeight: [{ weight: 3 }], drawn: 1, insertedName: 'awl', raw: [{ one: 1 }], after: 3 });
      expect(await db.tools.count()).toBe(3);
    });

    test('the root context works on after a transaction ended', async () => {
      await db.transaction(async trx => trx.tools.insert({ name: 'file', weight: 1 }));

      expect(await db.tools.count()).toBe(3);
      expect(await db.repairNoSeq.nextValue()).toBe(1);
      expect(await db.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      const batch = new QueryBatch();
      const key = batch.addCount(db.tools, 'count');
      await batch.executeBatch();
      expect(batch.getCount(key)).toBe(3);
    });

    test('the next transaction works with objects of its own', async () => {
      const kept = await committedContext();
      await expectRefused(kept.tools.count());

      expect(await db.transaction(async trx => trx.tools.count())).toBe(2);
    });

    test.skipIf(!concurrentSessions)('two concurrent transactions: the one that ended is refused, the one still open works on', async () => {
      const open = holdTransaction(db, async trx => trx.tools.insert({ name: 'file', weight: 1 }), async trx => trx.tools.count());
      await open.ready;

      try {
        const ended = await committedContext();
        await expectRefused(ended.tools.count());
      } finally {
        open.release();
      }

      expect(await open.done).toBe(3);
    });
  });
});

describe('PGlite, one session: a transaction\'s objects after the transaction ended', () => {
  let lite: WorkshopDatabase;

  beforeAll(async () => {
    lite = new WorkshopDatabase(new PGliteClient());
    await createWorkshop(lite);
  });

  beforeEach(async () => {
    await resetWorkshop(lite.getClient());
    await lite.tools.insertBulk([{ name: 'saw', weight: 3 }, { name: 'plane', weight: 2 }]);
  });

  afterAll(async () => {
    await lite.dispose();
  });

  test('a kept table read and write are refused; the session is untouched', async () => {
    const kept = await lite.transaction(async trx => trx);

    await expectRefused(kept.tools.count());
    await expectRefused(kept.tools.insert({ name: 'chisel', weight: 1 }));
    expect(await lite.tools.count()).toBe(2);
  });

  test('a kept sequence is refused', async () => {
    const kept = await lite.transaction(async trx => trx);

    await expectRefused(kept.repairNoSeq.nextValue());
    expect(await lite.repairNoSeq.nextValue()).toBe(1);
  });

  test('a query function leaked out of PGliteClient.transaction() is refused', async () => {
    let leaked: ((text: string) => Promise<ClientQueryResult>) | undefined;
    await lite.getClient().transaction(async query => {
      leaked = query;
    });

    await expectRefused(leaked!('SELECT 1 AS outside'));
  });

  test('inside, in parallel, everything works', async () => {
    const seen = await lite.transaction(async trx => {
      const [count, drawn, raw] = await Promise.all([trx.tools.count(), trx.repairNoSeq.nextValue(), trx.query<{ one: number }>('SELECT 1 AS one')]);
      return { count, drawn, raw };
    });

    expect(seen).toEqual({ count: 2, drawn: 1, raw: [{ one: 1 }] });
  });
});
