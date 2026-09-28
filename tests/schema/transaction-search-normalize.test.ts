import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DatabaseClient, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, integer, ixNormalized, varchar } from '../../src';
import type { ClientQueryResult, PooledConnection, QueryExecutionOptions } from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';

/**
 * `model.useSearchNormalize()` on a transaction's context. `createTransactionalContext()` did not copy the
 * context's `searchNormalizeRequired`, so `trx.getSchemaManager()` saw it `undefined` and skipped the
 * `search_normalize` support (the `unaccent` extension and `public.search_normalize(text)`) that the root context's
 * schema manager creates for the same model — `ensureSearchNormalizeSupport()`, `ensureCreated()`, `migrate()`.
 *
 * `RoutingClient` records which path each statement took: the client's own `query()` ("root") or a transaction's
 * query function ("transaction").
 *
 * Domain: a herbarium's specimen labels.
 */

// one entity class per model: entity metadata is per class, so models sharing a class would share its indexes
class Specimen extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class PlainSpecimen extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class IndexedSpecimen extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

const specimenColumns = (entity: any, table: string): void => {
  entity.toTable(table);
  entity.property((e: Specimen) => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${table}_id_seq` }));
  entity.property((e: Specimen) => e.label).hasType(varchar('label', 120)).isRequired();
};

/** Queries the labels with the normalized helpers, without an index: opts in with useSearchNormalize(). */
class HerbariumDatabase extends DbContext {
  get specimens(): DbEntityTable<Specimen> {
    return this.table(Specimen);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.useSearchNormalize();
    model.entity(Specimen, entity => specimenColumns(entity, 'tsn_specimens'));
  }
}

/** Neither the opt-in nor a normalized index. */
class PlainHerbariumDatabase extends DbContext {
  get specimens(): DbEntityTable<PlainSpecimen> {
    return this.table(PlainSpecimen);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(PlainSpecimen, entity => specimenColumns(entity, 'tsn_plain_specimens'));
  }
}

/** An ixNormalized index, no opt-in. */
class IndexedHerbariumDatabase extends DbContext {
  get specimens(): DbEntityTable<IndexedSpecimen> {
    return this.table(IndexedSpecimen);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(IndexedSpecimen, entity => {
      specimenColumns(entity, 'tsn_indexed_specimens');
      entity.hasIndex('ix_tsn_indexed_label', e => [ixNormalized(e.label)]);
    });
  }
}

type Route = { via: 'root' | 'transaction'; sql: string };

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

  /** `<via>: <first line>` of every statement that creates search_normalize support. */
  supportRoutes(): string[] {
    return this.routes
      .filter(route => /EXTENSION IF NOT EXISTS (unaccent|pg_trgm)|FUNCTION public\.search_normalize/.test(route.sql))
      .map(route => `${route.via}: ${route.sql.trim().split('\n')[0]}`);
  }
}

const EXTENSION = 'CREATE EXTENSION IF NOT EXISTS unaccent';
const FUNCTION = 'CREATE OR REPLACE FUNCTION public.search_normalize(value text)';
const DROP_FUNCTION = 'DROP FUNCTION IF EXISTS public.search_normalize(text) CASCADE';
/** How many search_normalize functions exist (pg_proc, which every engine the suite runs on has). */
const FUNCTION_COUNT = "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'search_normalize'";

describe('search_normalize support from a transaction\'s schema manager', () => {
  let routing: RoutingClient;
  let herbarium: HerbariumDatabase;
  let plain: PlainHerbariumDatabase;
  let indexed: IndexedHerbariumDatabase;
  const logged: string[] = [];

  beforeAll(async () => {
    routing = new RoutingClient(createFreshClient());
    herbarium = new HerbariumDatabase(routing, { logQueries: true, logParameters: false, logger: (message: string) => void logged.push(message) });
    plain = new PlainHerbariumDatabase(routing);
    indexed = new IndexedHerbariumDatabase(routing);

    for (const table of ['tsn_specimens', 'tsn_plain_specimens', 'tsn_indexed_specimens']) {
      await routing.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await herbarium.getSchemaManager().ensureCreated();
    await plain.getSchemaManager().ensureCreated();
    await indexed.getSchemaManager().ensureCreated();
  });

  beforeEach(() => {
    routing.routes.length = 0;
    logged.length = 0;
  });

  afterAll(async () => {
    try {
      for (const table of ['tsn_specimens', 'tsn_plain_specimens', 'tsn_indexed_specimens']) {
        await routing.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
    } finally {
      await routing.end();
    }
  });

  test('ensureSearchNormalizeSupport() on trx.getSchemaManager() creates the support — inside the transaction', async () => {
    await herbarium.transaction(async trx => {
      await trx.getSchemaManager().ensureSearchNormalizeSupport();
    });

    expect(routing.supportRoutes()).toEqual([`transaction: ${EXTENSION}`, `transaction: ${FUNCTION}`]);
  });

  test('…and so recreates the function when the transaction dropped it', async () => {
    const seen = await expectToReject(herbarium.transaction(async trx => {
      await trx.query(DROP_FUNCTION);
      const dropped = await trx.query<{ n: number }>(FUNCTION_COUNT);
      await trx.getSchemaManager().ensureSearchNormalizeSupport();
      const recreated = await trx.query<{ n: number }>(FUNCTION_COUNT);
      const normalized = await trx.query<{ value: string }>("SELECT public.search_normalize('Čerešňa Vtáčia') AS value");
      throw Object.assign(new Error('roll back'), { seen: { dropped, recreated, normalized } });
    }), 'roll back');

    expect(seen.seen).toEqual({ dropped: [{ n: 0 }], recreated: [{ n: 1 }], normalized: [{ value: 'ceresna vtacia' }] });
  });

  test('ensureCreated() on the transaction\'s schema manager creates the support as well', async () => {
    await expectToReject(herbarium.transaction(async trx => {
      await trx.query(DROP_FUNCTION);
      await trx.getSchemaManager().ensureCreated();
      expect(await trx.query(FUNCTION_COUNT)).toEqual([{ n: 1 }]);
      throw new Error('roll back');
    }), 'roll back');

    expect(routing.supportRoutes()).toEqual([`transaction: ${EXTENSION}`, `transaction: ${FUNCTION}`]);
  });

  test('the transaction\'s schema manager reports it through the context\'s logger', async () => {
    await herbarium.transaction(async trx => {
      await trx.getSchemaManager().ensureSearchNormalizeSupport();
    });

    expect(logged.filter(line => line.includes('search_normalize support'))).toEqual([
      'Creating search_normalize support (unaccent extension + function)...\n',
      '✓ search_normalize support created\n',
    ]);
  });

  test('the root context\'s schema manager does the same — unchanged', async () => {
    await herbarium.getSchemaManager().ensureSearchNormalizeSupport();

    expect(routing.supportRoutes()).toEqual([`root: ${EXTENSION}`, `root: ${FUNCTION}`]);
  });

  test('a model with neither the opt-in nor a normalized index: nothing runs, in a transaction either', async () => {
    await plain.getSchemaManager().ensureSearchNormalizeSupport();
    await plain.transaction(async trx => {
      await trx.getSchemaManager().ensureSearchNormalizeSupport();
    });

    expect(routing.supportRoutes()).toEqual([]);
  });

  test('a model with an ixNormalized index and no opt-in: the transaction\'s schema manager creates the support', async () => {
    await indexed.transaction(async trx => {
      await trx.getSchemaManager().ensureSearchNormalizeSupport();
    });

    expect(routing.supportRoutes()).toEqual([`transaction: ${EXTENSION}`, `transaction: ${FUNCTION}`]);
  });

  test('for every model, the root and its transactions run the same support statements', async () => {
    const shapes: Record<string, { root: string[]; transaction: string[] }> = {};

    for (const [name, ctx] of [['opt-in', herbarium], ['plain', plain], ['indexed', indexed]] as const) {
      routing.routes.length = 0;
      await ctx.getSchemaManager().ensureSearchNormalizeSupport();
      const root = routing.supportRoutes().map(route => route.replace(/^root: /, ''));

      routing.routes.length = 0;
      await (ctx as DbContext).transaction(async trx => {
        await trx.getSchemaManager().ensureSearchNormalizeSupport();
      });
      const transaction = routing.supportRoutes().map(route => route.replace(/^transaction: /, ''));

      shapes[name] = { root, transaction };
    }

    expect(shapes).toEqual({
      'opt-in': { root: [EXTENSION, FUNCTION], transaction: [EXTENSION, FUNCTION] },
      plain: { root: [], transaction: [] },
      indexed: { root: [EXTENSION, FUNCTION], transaction: [EXTENSION, FUNCTION] },
    });
  });
});
