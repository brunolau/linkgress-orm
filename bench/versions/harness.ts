/**
 * One side of a version comparison (bench/versions/compare.mjs): the same scenarios, compiled against
 * one version's source tree — `../../src` and `../../debug/schema` resolve to that tree's copies.
 *
 *   node <tree>/build/bench/versions/harness.js --mode setup|verify|bench|list [--out file.json]
 *
 * `createBench()` exposes the scenarios to bench/versions/interleave.mjs, which loads BOTH versions'
 * harnesses into one process and alternates their samples — the comparison the report is built from.
 * `--mode bench` measures this version alone.
 *
 * Every scenario is measured in up to three tiers:
 *
 * - `e2e`      — against PostgreSQL through `pg` (PgClient): what an application waits for.
 * - `overhead` — the scenario's statements answered from memory with the rows PostgreSQL returned for
 *                them (recorded once, a fresh deep copy handed out per iteration outside the timed region):
 *                the time spent inside linkgress — building, dispatching, reading the rows back.
 * - `build`    — every statement answered with zero rows: building and dispatching alone.
 *
 * Database: VERBENCH_DB (default linkgress_verbench) on DB_HOST / DB_PORT / DB_USER / DB_PASSWORD.
 * `--mode setup` drops and re-creates the AppDatabase schema there and seeds it (~2k users, ~20k posts).
 */
import { writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { AppDatabase } from '../../debug/schema/appDatabase';
import {
  and, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, decimal, eq, exists,
  gt, integer, jsonb, like, lt, lte, PgClient, timestamp, varchar,
} from '../../src';

type Tier = 'e2e' | 'overhead' | 'build';
type ClientMode = 'live' | 'record' | 'replay' | 'empty';

interface QueryResultLike {
  rows: any[];
  rowCount: number | null;
}

interface TapeEntry {
  sql: string;
  params?: any[];
  result: QueryResultLike;
}

/** A deep copy of a driver value: plain objects, arrays, Dates and Buffers — what `pg` hands back. */
function cloneValue(value: any): any {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (Array.isArray(value)) {
    const copy = new Array(value.length);

    for (let i = 0; i < value.length; i++) {
      copy[i] = cloneValue(value[i]);
    }

    return copy;
  }

  const copy: Record<string, any> = {};

  for (const key of Object.keys(value)) {
    copy[key] = cloneValue(value[key]);
  }

  return copy;
}

function cloneResult(result: QueryResultLike): QueryResultLike {
  return { rows: cloneValue(result.rows), rowCount: result.rowCount };
}

/**
 * PgClient that can record what the server answered and replay it: `live` passes through, `record`
 * passes through and keeps a pristine copy of every result (linkgress may rewrite the rows it is given),
 * `replay` answers from a loaded tape in order, `empty` answers every statement with zero rows.
 */
class BenchClient extends PgClient {
  mode: ClientMode = 'live';
  private recorded: TapeEntry[] = [];
  private queue: QueryResultLike[] = [];

  startRecording(): void {
    this.recorded = [];
    this.mode = 'record';
  }

  stopRecording(): TapeEntry[] {
    this.mode = 'live';
    return this.recorded;
  }

  /** Untimed: a fresh copy of the tape for the next iteration to consume. */
  load(tape: TapeEntry[]): void {
    this.queue = tape.map(entry => cloneResult(entry.result));
  }

  assertConsumed(scenario: string): void {
    if (this.queue.length > 0) {
      throw new Error(`${scenario}: ${this.queue.length} recorded result(s) left over — the statement sequence changed`);
    }
  }

  private capture(sql: string, params: any[] | undefined, result: QueryResultLike): any {
    this.recorded.push({ sql, params, result: cloneResult(result) });
    return result;
  }

  private answer(sql: string): any {
    if (this.mode === 'empty') {
      return { rows: [], rowCount: 0 };
    }

    const next = this.queue.shift();

    if (!next) {
      throw new Error(`replay tape exhausted at: ${sql.slice(0, 160)}`);
    }

    return next;
  }

  override async query(sql: string, params?: any[], options?: any): Promise<any> {
    if (this.mode === 'live') {
      return super.query(sql, params, options);
    }

    if (this.mode === 'record') {
      return this.capture(sql, params, await super.query(sql, params, options));
    }

    return this.answer(sql);
  }

  override async connect(): Promise<any> {
    if (this.mode === 'live') {
      return super.connect();
    }

    if (this.mode === 'record') {
      const connection = await super.connect();

      return {
        query: async (sql: string, params?: any[], options?: any) =>
          this.capture(sql, params, await connection.query(sql, params, options)),
        release: () => connection.release(),
      };
    }

    return {
      query: async (sql: string) => this.answer(sql),
      release: () => undefined,
    };
  }

  override async transaction<T>(callback: (query: (sql: string, params?: any[], options?: any) => Promise<any>) => Promise<T>): Promise<T> {
    if (this.mode === 'live') {
      return super.transaction(callback as any);
    }

    if (this.mode === 'record') {
      return super.transaction(query => callback(async (sql: string, params?: any[]) =>
        this.capture(sql, params, await query(sql, params))));
    }

    return callback(async (sql: string) => this.answer(sql));
  }
}

// ---------------------------------------------------------------------------------------------------
// A table of its own for the write scenarios, so the read dataset never changes under the reads.
// ---------------------------------------------------------------------------------------------------

class BenchItem extends DbEntity {
  id!: DbColumn<number>;
  key!: DbColumn<string>;
  grp!: DbColumn<number>;
  name!: DbColumn<string>;
  qty!: DbColumn<number>;
  price?: DbColumn<number>;
  updatedAt?: DbColumn<Date>;
  payload?: DbColumn<any>;
}

/** The write scenarios' table: each side of an interleaved run writes to its own (see createBench). */
let itemsTable = 'verbench_items';

class MutationDb extends DbContext {
  get items(): DbEntityTable<BenchItem> {
    return this.table(BenchItem);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(BenchItem, entity => {
      entity.toTable(itemsTable);
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'verbench_items_id_seq' }));
      entity.property(e => e.key).hasType(varchar('key', 64)).isRequired().isUnique();
      entity.property(e => e.grp).hasType(integer('grp')).isRequired().hasDefaultValue(0);
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.qty).hasType(integer('qty')).isRequired().hasDefaultValue(0);
      entity.property(e => e.price).hasType(decimal('price', 10, 2));
      entity.property(e => e.updatedAt).hasType(timestamp('updated_at'));
      entity.property(e => e.payload).hasType(jsonb('payload'));
    });
  }
}

const ITEMS_TABLES = ['verbench_items', 'verbench_items_base', 'verbench_items_head'];

const itemsDdl = (table: string) => `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key varchar(64) NOT NULL UNIQUE,
  grp integer NOT NULL DEFAULT 0,
  name varchar(200) NOT NULL,
  qty integer NOT NULL DEFAULT 0,
  price numeric(10, 2),
  updated_at timestamp,
  payload jsonb
);
CREATE INDEX ${table}_grp ON ${table} (grp);
`;

/** Deterministic, ~2k users / ~20k posts / 10k orders / ~30k comments; ids follow insertion order. */
const SEED_STATEMENTS = [
  `INSERT INTO users (username, email, age, is_active, created_at, metadata, last_active_at)
   SELECT 'user_' || lpad(k::text, 5, '0'), 'user' || k || '@bench.test', 18 + (k * 7) % 60, k % 3 <> 0,
          timestamp '2024-01-01 00:00:00' + k * interval '1 minute',
          CASE WHEN k % 2 = 0 THEN jsonb_build_object('tier', (ARRAY['free', 'pro', 'team'])[1 + k % 3], 'score', k % 100) END,
          (k * 3607) % 20000000
   FROM generate_series(1, 2000) AS k ORDER BY k`,
  `INSERT INTO posts (title, subtitle, content, user_id, published_at, views, publish_time, custom_date, string_stamped_at, category)
   SELECT 'Post ' || k || '.' || j, CASE WHEN j % 4 = 0 THEN 'Subtitle ' || k || '.' || j END,
          'Content of post ' || k || '.' || j || ': ' || repeat('lorem ipsum ', 1 + (k + j) % 8), k,
          timestamp '2024-01-01 00:00:00' + (k * 19 + j) * interval '1 hour',
          (k * 131 + j * 977) % 5000, ((k + j) * 37) % 1440, (k * 86400 + j * 3600) % 30000000,
          CASE WHEN j % 3 = 0 THEN timestamp '2024-06-01 12:00:00' + (k * 19 + j) * interval '1 minute' END,
          (ARRAY['tech', 'lifestyle', 'business', 'entertainment'])[1 + (k + j) % 4]::post_category
   FROM generate_series(1, 2000) AS k CROSS JOIN LATERAL generate_series(1, 1 + (k * 7) % 19) AS j ORDER BY k, j`,
  `INSERT INTO orders (user_id, status, total_amount, created_at, items)
   SELECT k, (ARRAY['pending', 'processing', 'completed', 'cancelled', 'refunded'])[1 + (k + j) % 5]::order_status,
          ((k * 1301 + j * 7919) % 100000) / 100.0, timestamp '2024-01-01 00:00:00' + (k * 5 + j) * interval '37 minutes',
          jsonb_build_array(jsonb_build_object('sku', 'SKU-' || j, 'qty', 1 + j % 3))
   FROM generate_series(1, 2000) AS k CROSS JOIN generate_series(1, 5) AS j ORDER BY k, j`,
  `INSERT INTO task_levels (name, created_by_id) SELECT 'Level ' || n, 1 + (n * 37) % 2000 FROM generate_series(1, 50) AS n ORDER BY n`,
  `INSERT INTO tasks (title, status, priority, level_id)
   SELECT 'Task ' || n, (ARRAY['pending', 'processing', 'completed', 'cancelled'])[1 + n % 4]::task_status,
          (ARRAY['low', 'medium', 'high'])[1 + n % 3]::task_priority, 1 + n % 50
   FROM generate_series(1, 2000) AS n ORDER BY n`,
  `INSERT INTO order_task (order_id, task_id, sort_order) SELECT n, 1 + (n * 17) % 2000, n % 5 FROM generate_series(1, 10000) AS n`,
  `INSERT INTO post_comments (post_id, order_id, comment)
   SELECT p.id, 1 + (p.id * 3 + j) % 10000,
          CASE WHEN (p.id + j) % 23 = 0 THEN 'urgent: please review ' || p.id ELSE 'Comment ' || j || ' on post ' || p.id END
   FROM posts p CROSS JOIN LATERAL generate_series(1, p.id % 4) AS j ORDER BY p.id, j`,
  `INSERT INTO products (name, active) SELECT 'Product ' || n, n % 10 <> 0 FROM generate_series(1, 200) AS n ORDER BY n`,
  `INSERT INTO product_prices (product_id, season_id, price)
   SELECT n, j, ((n * 97 + j * 13) % 20000) / 100.0 FROM generate_series(1, 200) AS n CROSS JOIN generate_series(1, 4) AS j ORDER BY n, j`,
  `INSERT INTO capacity_groups (name) SELECT 'Group ' || n FROM generate_series(1, 10) AS n ORDER BY n`,
  `INSERT INTO product_price_capacity_groups (product_price_id, capacity_group_id)
   SELECT pp.id, 1 + (pp.id + j * 3) % 10 FROM product_prices pp CROSS JOIN generate_series(1, 2) AS j`,
  `INSERT INTO tags (name) SELECT 'Tag ' || n FROM generate_series(1, 30) AS n ORDER BY n`,
  `INSERT INTO product_tags (product_id, tag_id, sort_order)
   SELECT n, 1 + (n * 7 + j * 5) % 30, j FROM generate_series(1, 200) AS n CROSS JOIN generate_series(1, 3) AS j`,
];

// ---------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------

interface Ctx {
  client: BenchClient;
  lateral: AppDatabase;
  cte: AppDatabase;
  temptable: AppDatabase;
  m: MutationDb;
}

interface Scenario {
  id: string;
  group: 'control' | 'read' | 'navigation' | 'collection' | 'aggregate' | 'write';
  title: string;
  tiers: Tier[];
  /** Untimed, live: the database state the scenario starts from (before every tier). */
  prepare?: (ctx: Ctx) => Promise<void>;
  /** Untimed, live, e2e only: per-iteration state (e.g. the rows a DELETE removes). */
  setup?: (ctx: Ctx, i: number) => Promise<void>;
  /** Builders are lazy thenables: awaiting one is what executes it. */
  run: (ctx: Ctx, i: number) => PromiseLike<unknown>;
}

const ALL: Tier[] = ['e2e', 'overhead', 'build'];
const NO_BUILD: Tier[] = ['e2e', 'overhead'];
const USERS = 2000;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

let keySeq = 0;

const item = (n: number, grp = 0) => ({
  key: `k${n}`,
  grp,
  name: `Item ${n}`,
  qty: n % 100,
  price: (n % 1000) / 4,
  updatedAt: new Date(Date.UTC(2024, 0, 1) + n * 60_000),
  payload: { n, tags: ['a', 'b'] },
});

const truncateItems = async (ctx: Ctx) => {
  await ctx.client.query(`TRUNCATE ${itemsTable} RESTART IDENTITY`);
  keySeq = 0;
};

const seedItems = (count: number) => async (ctx: Ctx) => {
  await truncateItems(ctx);
  await ctx.client.query(
    `INSERT INTO ${itemsTable} (key, grp, name, qty, price, updated_at)
     SELECT 's' || n, 0, 'Seed ' || n, n % 100, n / 4.0, timestamp '2024-01-01' + n * interval '1 minute'
     FROM generate_series(1, ${count}) AS n ORDER BY n`);
};

const usersWithPosts = (db: AppDatabase, maxUserId: number) => db.users
  .where(u => lte(u.id, maxUserId))
  .select(u => ({
    id: u.id,
    username: u.username,
    posts: u.posts!.select(p => ({ id: p.id, title: p.title, views: p.views })).toList('posts'),
  }))
  .toList();

const userAggregates = (db: AppDatabase) => db.users
  .where(u => lte(u.id, 100))
  .select(u => ({
    id: u.id,
    postCount: u.posts!.count(),
    maxViews: u.posts!.max(p => p.views),
    postIds: u.posts!.select(p => ({ id: p.id })).toNumberList(),
    latest: u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ id: p.id, title: p.title })).firstOrDefault(),
  }))
  .toList();

const productTree = (db: AppDatabase) => db.products
  .where(p => lte(p.id, 100))
  .select(p => ({
    id: p.id,
    name: p.name,
    prices: p.productPrices!.select(pp => ({
      id: pp.id,
      price: pp.price,
      groups: pp.productPriceCapacityGroups!.select(g => ({ id: g.capacityGroupId, name: g.capacityGroup!.name })).toList('groups'),
    })).toList('prices'),
  }))
  .toList();

const scenarios: Scenario[] = [
  // PgClient is byte-identical in both versions: these two only measure the machine and the server.
  {
    id: 'ctl-select-1', group: 'control', title: 'SELECT $1 through PgClient (no query building)', tiers: ['e2e'],
    run: (c, i) => c.client.query('SELECT $1::int AS x', [i]),
  },
  {
    id: 'ctl-raw-1k', group: 'control', title: '1,000 raw rows through PgClient (no query building)', tiers: ['e2e'],
    run: c => c.client.query('SELECT id, title, views, user_id FROM posts WHERE id <= 1000'),
  },
  {
    id: 'raw-via-context', group: 'read', title: 'db.query(): raw SQL through the context, 100 rows', tiers: NO_BUILD,
    run: c => c.lateral.query('SELECT id, title FROM posts WHERE id <= 100'),
  },

  // ---- plain reads
  {
    id: 'pk-lookup', group: 'read', title: 'Primary-key lookup, firstOrDefault()', tiers: ALL,
    run: (c, i) => c.lateral.users.where(u => eq(u.id, 1 + (i % USERS))).firstOrDefault(),
  },
  {
    id: 'filter-order-limit', group: 'read', title: 'where + orderBy + limit 50, 4-column projection', tiers: ALL,
    run: c => c.lateral.posts
      .where(p => and(gt(p.views, 2500), eq(p.category, 'tech')))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(50)
      .select(p => ({ id: p.id, title: p.title, views: p.views, publishedAt: p.publishedAt }))
      .toList(),
  },
  {
    id: 'count-where', group: 'read', title: 'count() with a filter', tiers: ALL,
    run: c => c.lateral.posts.where(p => gt(p.views, 2500)).count(),
  },
  {
    id: 'entity-1k', group: 'read', title: 'Whole entities (all columns, jsonb, a custom mapper), 1,000 rows', tiers: ALL,
    run: c => c.lateral.users.orderBy(u => u.id).limit(1000).toList(),
  },
  {
    id: 'projection-20k', group: 'read', title: 'Projection with 2 custom mappers, ~20,000 rows', tiers: ALL,
    run: c => c.lateral.posts
      .select(p => ({ id: p.id, title: p.title, views: p.views, userId: p.userId, publishTime: p.publishTime, customDate: p.customDate }))
      .toList(),
  },

  // ---- reference navigations
  {
    id: 'nav-1hop', group: 'navigation', title: '1-hop navigation columns, 1,000 rows', tiers: ALL,
    run: c => c.lateral.posts
      .where(p => lte(p.id, 1000))
      .select(p => ({ id: p.id, title: p.title, author: p.user!.username, email: p.user!.email }))
      .toList(),
  },
  {
    id: 'nav-3hop', group: 'navigation', title: '3-hop navigation chain, 1,000 rows', tiers: ALL,
    run: c => c.lateral.orderTasks
      .where(ot => lte(ot.orderId, 1000))
      .select(ot => ({
        orderId: ot.orderId,
        task: ot.task!.title,
        level: ot.task!.level!.name,
        creator: ot.task!.level!.createdBy!.username,
      }))
      .toList(),
  },
  {
    id: 'nav-where', group: 'navigation', title: 'Filter through a navigation, ~500 rows', tiers: ALL,
    run: c => c.lateral.posts
      .where(p => and(eq(p.user!.isActive, true), gt(p.views, 4800)))
      .select(p => ({ id: p.id, title: p.title }))
      .toList(),
  },
  {
    id: 'nav-whole-row', group: 'navigation', title: 'Navigation row projected whole, 500 rows', tiers: ALL,
    run: c => c.lateral.posts.where(p => lte(p.id, 500)).select(p => ({ id: p.id, author: p.user })).toList(),
  },

  // ---- collections (100 users ≈ 1,000 posts unless stated)
  {
    id: 'coll-cte', group: 'collection', title: 'Users with their posts — CTE strategy', tiers: ALL,
    run: c => usersWithPosts(c.cte, 100),
  },
  {
    id: 'coll-lateral', group: 'collection', title: 'Users with their posts — LATERAL strategy', tiers: ALL,
    run: c => usersWithPosts(c.lateral, 100),
  },
  {
    id: 'coll-temptable', group: 'collection', title: 'Users with their posts — temp-table strategy', tiers: NO_BUILD,
    run: c => usersWithPosts(c.temptable, 100),
  },
  {
    id: 'coll-large-cte', group: 'collection', title: '2,000 users with ~20,000 posts — CTE strategy', tiers: ALL,
    run: c => usersWithPosts(c.cte, USERS),
  },
  {
    id: 'coll-aggregates-lateral', group: 'collection', title: 'count / max / number list / firstOrDefault — LATERAL', tiers: ALL,
    run: c => userAggregates(c.lateral),
  },
  {
    id: 'coll-aggregates-cte', group: 'collection', title: 'count / max / number list / firstOrDefault — CTE', tiers: ALL,
    run: c => userAggregates(c.cte),
  },
  {
    id: 'coll-nested-lateral', group: 'collection', title: 'Two nested collection levels + navigation — LATERAL', tiers: ALL,
    run: c => productTree(c.lateral),
  },
  {
    id: 'coll-nested-cte', group: 'collection', title: 'Two nested collection levels + navigation — CTE', tiers: ALL,
    run: c => productTree(c.cte),
  },
  {
    id: 'coll-exists-where', group: 'collection', title: 'where(collection.where(…).exists())', tiers: ALL,
    run: c => c.lateral.posts
      .where(p => lte(p.id, 5000))
      .where(p => p.postComments!.where(pc => like(pc.comment, '%urgent%')).exists())
      .select(p => ({ id: p.id, title: p.title }))
      .toList(),
  },

  // ---- grouping, joins, unions, subqueries, CTEs
  {
    id: 'groupby-having', group: 'aggregate', title: 'groupBy + having + count/sum, ~1,500 groups', tiers: ALL,
    run: c => c.lateral.posts
      .select(p => ({ userId: p.userId, views: p.views }))
      .groupBy(p => ({ userId: p.userId }))
      .having(g => gt(g.count() as any, 5))
      .select(g => ({ userId: g.key.userId, postCount: g.count(), totalViews: g.sum(p => p.views) }))
      .toList(),
  },
  {
    id: 'groupby-small', group: 'aggregate', title: 'groupBy over the whole table, 4 groups', tiers: ALL,
    run: c => c.lateral.posts
      .select(p => ({ category: p.category, views: p.views }))
      .groupBy(p => ({ category: p.category }))
      .select(g => ({ category: g.key.category, posts: g.count(), maxViews: g.max(p => p.views) }))
      .toList(),
  },
  {
    id: 'left-join', group: 'aggregate', title: 'Explicit leftJoin, 1,000 rows', tiers: ALL,
    run: c => c.lateral.orders
      .where(o => lte(o.id, 1000))
      .leftJoin(
        c.lateral.users,
        (o, u) => eq(o.userId, u.id),
        (o, u) => ({ id: o.id, total: o.totalAmount, status: o.status, username: u.username }),
      )
      .toList(),
  },
  {
    id: 'union', group: 'aggregate', title: 'UNION of two filtered projections', tiers: ALL,
    run: c => c.lateral.users
      .where(u => lt(u.age, 22))
      .select(u => ({ id: u.id, name: u.username }))
      .union(c.lateral.users.where(u => gt(u.age, 73)).select(u => ({ id: u.id, name: u.username })))
      .toList(),
  },
  {
    id: 'subquery-exists', group: 'aggregate', title: 'where(exists(correlated subquery))', tiers: ALL,
    run: c => c.lateral.users
      .where(u => exists(c.lateral.posts
        .where(p => and(eq(p.userId, u.id), gt(p.views, 4950)))
        .select(p => ({ id: p.id }))
        .asSubquery('table')))
      .select(u => ({ id: u.id, username: u.username }))
      .toList(),
  },
  {
    id: 'cte-aggregation', group: 'aggregate', title: 'DbCteBuilder.withAggregation + leftJoin, 100 users', tiers: ALL,
    run: c => {
      const builder = new DbCteBuilder();
      const perUser = builder.withAggregation(
        'user_posts',
        c.lateral.posts.where(p => lte(p.userId, 100)).select(p => ({ userId: p.userId, id: p.id, views: p.views })),
        p => ({ userId: p.userId }),
        'posts',
      );

      return c.lateral.users
        .where(u => lte(u.id, 100))
        .with(...builder.getCtes())
        .leftJoin(perUser, (u, x) => eq(u.id, x.userId), (u, x) => ({ id: u.id, username: u.username, posts: x.posts }))
        .toList();
    },
  },

  // ---- writes (own table; reset before every tier)
  {
    id: 'insert-one', group: 'write', title: 'insert(row).returning()', tiers: NO_BUILD, prepare: truncateItems,
    run: c => c.m.items.insert(item(++keySeq)).returning(),
  },
  {
    id: 'insert-bulk-100', group: 'write', title: 'insertBulk, 100 rows', tiers: ALL, prepare: truncateItems,
    run: c => c.m.items.insertBulk(range(100).map(() => item(++keySeq))),
  },
  {
    id: 'insert-bulk-1000-ret', group: 'write', title: 'insertBulk, 1,000 rows, .returning()', tiers: NO_BUILD, prepare: truncateItems,
    run: c => c.m.items.insertBulk(range(1000).map(() => item(++keySeq))).returning(),
  },
  {
    id: 'upsert-bulk-100', group: 'write', title: 'upsertBulk, 100 rows (conflict → update)', tiers: ALL, prepare: truncateItems,
    run: (c, i) => c.m.items.upsertBulk(
      range(100).map(k => ({ ...item(k), qty: i % 1000 })),
      { primaryKey: ['key'], updateColumns: ['qty', 'name'] },
    ),
  },
  {
    id: 'bulk-update-100', group: 'write', title: 'bulkUpdate, 100 rows by primary key', tiers: ALL, prepare: seedItems(100),
    run: (c, i) => c.m.items.bulkUpdate(range(100).map(k => ({ id: k + 1, qty: (i + k) % 1000, name: `Item ${k} v${i % 7}` }))),
  },
  {
    id: 'update-where-ret', group: 'write', title: 'where(…).update({…}).returning(), 50 rows', tiers: NO_BUILD, prepare: seedItems(100),
    run: (c, i) => c.m.items.where(it => lte(it.id, 50)).update({ qty: i % 1000 }).returning(),
  },
  {
    id: 'delete-where', group: 'write', title: 'where(…).delete(), 20 rows', tiers: ALL, prepare: truncateItems,
    setup: (c, i) => c.client.query(
      `INSERT INTO ${itemsTable} (key, grp, name) SELECT 'd' || $1::int || '_' || g, $1::int, 'doomed' FROM generate_series(1, 20) AS g`,
      [i + 1]).then(() => undefined),
    run: (c, i) => c.m.items.where(it => eq(it.grp, i + 1)).delete(),
  },
  {
    id: 'transaction', group: 'write', title: 'transaction: insert + update', tiers: NO_BUILD, prepare: seedItems(10),
    run: (c, i) => c.m.transaction(async (tx: MutationDb) => {
      await tx.items.insert(item(1_000_000 + (++keySeq)));
      await tx.items.where(it => eq(it.id, 1 + (i % 10))).update({ qty: i % 1000 });
    }),
  },
];

// ---------------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------------

interface MeasureOptions {
  warmupMs: number;
  minWarmupIterations: number;
  samples: number;
  sampleMs: number;
}

interface TierResult {
  /** Mean time per operation of each sample, in ms */
  samples?: number[];
  iterations?: number;
  statements?: number;
  error?: string;
}

/** One scenario in one tier, ready to iterate: its database state prepared, its tape recorded. */
interface TierState {
  scenario: Scenario;
  tier: Tier;
  tape?: TapeEntry[];
  /** Iterations run so far (the next iteration's index) */
  next: number;
}

async function begin(ctx: Ctx, scenario: Scenario, tier: Tier): Promise<TierState> {
  const { client } = ctx;
  client.mode = 'live';
  await scenario.prepare?.(ctx);

  let tape: TapeEntry[] | undefined;

  if (tier === 'overhead') {
    client.startRecording();

    try {
      await scenario.run(ctx, 0);
    } finally {
      tape = client.stopRecording();
    }

    await scenario.prepare?.(ctx);
  }

  return { scenario, tier, tape, next: 0 };
}

/** One iteration; only `run` is on the clock (not the e2e setup, not copying the tape). */
async function iterate(ctx: Ctx, state: TierState): Promise<number> {
  const { client } = ctx;
  const { scenario, tier, tape } = state;
  const i = state.next++;

  if (tier === 'e2e' && scenario.setup) {
    await scenario.setup(ctx, i);
  }

  if (tape) {
    client.load(tape);
  }

  client.mode = tier === 'e2e' ? 'live' : tier === 'overhead' ? 'replay' : 'empty';

  try {
    const start = performance.now();
    await scenario.run(ctx, i);
    const elapsed = performance.now() - start;

    if (tape) {
      client.assertConsumed(scenario.id);
    }

    return elapsed;
  } finally {
    client.mode = 'live';
  }
}

/** Iterations until `ms` of timed work (at least `minIterations`): the mean time of one, in ms. */
async function sample(ctx: Ctx, state: TierState, ms: number, minIterations = 1): Promise<number> {
  let timed = 0;
  let count = 0;

  while (count < minIterations || timed < ms) {
    timed += await iterate(ctx, state);
    count++;
  }

  return timed / count;
}

/** Start a measurement from a collected heap (node needs --expose-gc; Bun has Bun.gc). */
function collectGarbage(): void {
  const bun = (globalThis as any).Bun;
  bun ? bun.gc(true) : (globalThis as any).gc?.();
}

async function measure(ctx: Ctx, scenario: Scenario, tier: Tier, options: MeasureOptions): Promise<TierResult> {
  const state = await begin(ctx, scenario, tier);
  collectGarbage();
  await sample(ctx, state, options.warmupMs, options.minWarmupIterations);

  const samples: number[] = [];

  for (let s = 0; s < options.samples; s++) {
    samples.push(await sample(ctx, state, options.sampleMs));
  }

  return { samples, iterations: state.next, statements: state.tape?.length };
}

// ---------------------------------------------------------------------------------------------------
// Verification: one execution per scenario, its statements and a digest of what came back
// ---------------------------------------------------------------------------------------------------

/** Key-order-independent, JSON-safe form of a result; `undefined` properties are dropped. */
function canonical(value: any): any {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  }

  if (Buffer.isBuffer(value)) {
    return { $bytes: value.toString('hex') };
  }

  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  const result: Record<string, any> = {};

  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      result[key] = canonical(value[key]);
    }
  }

  return result;
}

/** The same with every array sorted: equal when only row / element order differs. */
function unordered(value: any): any {
  if (Array.isArray(value)) {
    return value.map(unordered).map(v => JSON.stringify(v)).sort().map(v => JSON.parse(v));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};

    for (const key of Object.keys(value)) {
      result[key] = unordered(value[key]);
    }

    return result;
  }

  return value;
}

const digest = (value: any): string => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function verify(ctx: Ctx, selected: Scenario[]): Promise<Record<string, any>> {
  const report: Record<string, any> = {};

  for (const scenario of selected) {
    ctx.client.mode = 'live';

    try {
      await scenario.prepare?.(ctx);
      await scenario.setup?.(ctx, 0);
      ctx.client.startRecording();
      const result = await scenario.run(ctx, 0);
      const tape = ctx.client.stopRecording();
      const value = canonical(result);

      report[scenario.id] = {
        statements: tape.map(entry => ({ sql: entry.sql, params: canonical(entry.params ?? []) })),
        rows: Array.isArray(result) ? result.length : undefined,
        ordered: digest(value),
        unordered: digest(unordered(value)),
        sample: JSON.stringify(Array.isArray(value) ? value.slice(0, 2) : value).slice(0, 1500),
      };
    } catch (error: any) {
      ctx.client.stopRecording();
      report[scenario.id] = { error: String(error?.message ?? error) };
    }
  }

  return report;
}

// ---------------------------------------------------------------------------------------------------

/** The schema manager logs what it creates; keep the output readable. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;

  try {
    return await work();
  } finally {
    console.log = log;
  }
}

async function setup(ctx: Ctx): Promise<void> {
  const schema = ctx.lateral.getSchemaManager();

  await quietly(async () => {
    await schema.ensureDeleted();
    await schema.ensureCreated();
  });

  for (const statement of SEED_STATEMENTS) {
    await ctx.client.query(statement);
  }

  for (const table of ITEMS_TABLES) {
    await ctx.client.query(itemsDdl(table));
  }

  await ctx.client.query('VACUUM ANALYZE');

  const counts = await ctx.client.query(
    `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM posts) AS posts,
            (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM post_comments) AS comments`);
  process.stderr.write(`seeded: ${JSON.stringify(counts.rows[0])}\n`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      args[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? 'true' : (i++, next);
    }
  }

  return args;
}

const runtimeName = (): string =>
  (globalThis as any).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;

function createContext(): Ctx {
  const client = new BenchClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.VERBENCH_DB || 'linkgress_verbench',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    max: 4,
  });

  return {
    client,
    lateral: new AppDatabase(client, { logQueries: false, collectionStrategy: 'lateral' }),
    cte: new AppDatabase(client, { logQueries: false, collectionStrategy: 'cte' }),
    temptable: new AppDatabase(client, { logQueries: false, collectionStrategy: 'temptable' }),
    m: new MutationDb(client, { logQueries: false }),
  };
}

/**
 * This version's scenarios for bench/versions/interleave.mjs. The write scenarios use `itemsTable`
 * (`--mode setup` creates verbench_items, verbench_items_base and verbench_items_head).
 */
export function createBench(options: { itemsTable?: string } = {}) {
  itemsTable = options.itemsTable ?? itemsTable;
  const ctx = createContext();
  const byId = new Map(scenarios.map(s => [s.id, s]));

  return {
    runtime: runtimeName(),
    scenarios: scenarios.map(({ id, group, title, tiers }) => ({ id, group, title, tiers })),
    begin: (id: string, tier: Tier) => begin(ctx, byId.get(id)!, tier),
    sample: (state: TierState, ms: number, minIterations = 1) => sample(ctx, state, ms, minIterations),
    close: async () => {
      ctx.client.mode = 'live';
      await ctx.client.end();
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? 'bench';

  if (mode === 'list') {
    for (const scenario of scenarios) {
      console.log(`${scenario.id.padEnd(26)} ${scenario.tiers.join(',').padEnd(18)} ${scenario.title}`);
    }

    return;
  }

  const ctx = createContext();
  const { client } = ctx;
  const filter = args.filter ? new RegExp(args.filter) : undefined;
  const selected = scenarios.filter(s => !filter || filter.test(s.id));

  try {
    if (mode === 'setup') {
      await setup(ctx);
      return;
    }

    if (mode === 'verify') {
      const report = await verify(ctx, selected);
      writeFileSync(args.out ?? 'verify.json', JSON.stringify(report, null, 1));
      return;
    }

    const quick = args.quick === 'true';
    const options: MeasureOptions = {
      warmupMs: Number(args['warmup-ms'] ?? (quick ? 100 : 400)),
      minWarmupIterations: 3,
      samples: Number(args.samples ?? (quick ? 3 : 8)),
      sampleMs: Number(args['sample-ms'] ?? (quick ? 15 : 40)),
    };
    const tiers = (args.tiers ?? 'e2e,overhead,build').split(',') as Tier[];
    const results: Record<string, Partial<Record<Tier, TierResult>>> = {};
    const started = performance.now();

    for (const scenario of selected) {
      results[scenario.id] = {};

      for (const tier of tiers.filter(t => scenario.tiers.includes(t))) {
        try {
          results[scenario.id][tier] = await measure(ctx, scenario, tier, options);
        } catch (error: any) {
          results[scenario.id][tier] = { error: String(error?.message ?? error) };
        }
      }

      if (args.progress === 'true') {
        const line = Object.entries(results[scenario.id])
          .map(([tier, r]) => r?.error ? `${tier} ERROR` : `${tier} ${(median(r!.samples!) * 1000).toFixed(1)}µs`)
          .join('  ');
        process.stderr.write(`  ${scenario.id.padEnd(26)} ${line}\n`);
      }
    }

    const output = {
      runtime: runtimeName(),
      options,
      durationMs: performance.now() - started,
      scenarios: Object.fromEntries(scenarios.map(s => [s.id, { group: s.group, title: s.title }])),
      results,
    };

    writeFileSync(args.out ?? 'bench.json', JSON.stringify(output));
  } finally {
    client.mode = 'live';
    await client.end();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Run as a script; required by interleave.mjs, it only exports createBench.
if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
