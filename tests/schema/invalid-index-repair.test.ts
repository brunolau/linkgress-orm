import { beforeEach, describe, test, expect } from 'bun:test';
import * as os from 'node:os';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { isMemoryTestDatabase } from '../memory/shared-memory-db';
import * as linkgress from '../../src';
import {
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  EntityConfigBuilder,
  MigrationScaffold,
  boolean as boolColumn,
  integer,
  text,
  varchar,
} from '../../src';
import type { MigrationOperation } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';

const { IndexRepairError } = linkgress;

/**
 * The schema manager treats an INVALID index as MISSING: the reconcile (`analyze()` / `migrate()`) plans a
 * `repair_index` for it and rebuilds it from the model. A `.concurrent()` index (or any, with `concurrentIndexes`) is
 * rebuilt with `DROP INDEX CONCURRENTLY … IF EXISTS` + `CREATE INDEX CONCURRENTLY … IF NOT EXISTS`; any other is built
 * first under a temporary name and then swapped in, so a build that fails leaves the INVALID index as it was. Repairs
 * run last, after every other operation of the migration, and their failures come as ONE IndexRepairError.
 *
 * Such an index is what a failed or cancelled `CREATE INDEX CONCURRENTLY` leaves behind (see
 * tests/schema/failed-concurrent-index-build.test.ts); PostgreSQL never uses it for reads, so without the repair an
 * application runs, silently, without the index its model declares. Some INVALID indexes are left alone, with a
 * warning: one whose table has an index build running, a partitioned one, one a constraint requires, and a unique one
 * that is still ready (it enforces uniqueness).
 *
 * Every INVALID index here comes from a real failed concurrent build, or from `UPDATE pg_index SET indisvalid =
 * false` (a superuser's write, which the in-memory engine maps onto the same index state) — on PostgreSQL,
 * PGlite and the in-memory engine alike.
 */

/**
 * The ONE engine guard of this file (grep: SESSIONS_SEE_BUILDS). Three cases stage what only a PostgreSQL server
 * with several sessions shows:
 * - a CREATE INDEX CONCURRENTLY, and a REINDEX INDEX CONCURRENTLY, that another session sees in progress. The
 *   in-memory engine builds an index within its statement, so no build is ever observable, and PGlite has one
 *   session: there the reconcile's read of running builds is injected instead — the same rows, the same planning
 *   decision under test;
 * - a blocking build that visits the row versions an older snapshot still sees. The in-memory engine builds over
 *   its own snapshot's rows (docs/guides/in-memory-database.md): there the test asserts that documented outcome
 *   (PGlite, with no second session to hold the snapshot, skips it).
 */
const SESSIONS_SEE_BUILDS = !isMemoryTestDatabase() && (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase() !== 'pglite';

// Entity metadata is process-wide, and every model is built from all of it: each test starts from its own models only.
beforeEach(() => (EntityMetadataStore as unknown as { metadata: Map<unknown, unknown> }).metadata.clear());

const BOOK = 'ivx_book';
const LOAN = 'ivx_loan';
const ARCHIVE = 'ivx_archive';
const SCROLL = 'ivx_scroll';
const LEDGER = 'IvxLedger';
/** partitioned by `floor`: `ivx_rack_1` holds floors 0–9, `ivx_rack_2` floors 10–19 */
const RACK = 'ivx_rack';
/** a model-managed view over `ivx_book` */
const BOOK_COUNTS = 'ivx_book_counts';

// ---------------------------------------------------------------------------
// neutral model: a library's books, an archive's scrolls (own schema), a ledger (quoted, mixed case)
// ---------------------------------------------------------------------------

class Book extends DbEntity {
  id!: DbColumn<number>;
  isbn!: DbColumn<string>;
  title!: DbColumn<string>;
  shelf!: DbColumn<string>;
  copies!: DbColumn<number>;
  archived!: DbColumn<boolean>;
}

class Scroll extends DbEntity {
  id!: DbColumn<number>;
  catalogNo!: DbColumn<string>;
  era!: DbColumn<string>;
}

class Ledger extends DbEntity {
  id!: DbColumn<number>;
  entryCode!: DbColumn<string>;
  volume!: DbColumn<number>;
}

interface Logged {
  message: string;
  section?: string;
}

type BookIndexes = (book: EntityConfigBuilder<Book>) => void;

/** A context over `ivx_book` with the given indexes — a class per call, so no two models share entity metadata. */
function library(client: DatabaseClient, indexes: BookIndexes, logs: Logged[]) {
  class BookRow extends Book {}
  class LibraryDb extends DbContext {
    get books(): DbEntityTable<BookRow> {
      return this.table(BookRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(BookRow, e => {
        e.toTable(BOOK);
        e.property(b => b.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${BOOK}_id_seq` }));
        e.property(b => b.isbn).hasType(varchar('isbn', 20)).isRequired();
        e.property(b => b.title).hasType(text('title')).isRequired();
        e.property(b => b.shelf).hasType(varchar('shelf', 20));
        e.property(b => b.copies).hasType(integer('copies')).isRequired();
        e.property(b => b.archived).hasType(boolColumn('archived')).isRequired();
        indexes(e as unknown as EntityConfigBuilder<Book>);
      });
    }
  }

  return new LibraryDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

function archive(client: DatabaseClient, indexes: (scroll: EntityConfigBuilder<Scroll>) => void, logs: Logged[]) {
  class ScrollRow extends Scroll {}
  class ArchiveDb extends DbContext {
    get scrolls(): DbEntityTable<ScrollRow> {
      return this.table(ScrollRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(ScrollRow, e => {
        e.toTable(SCROLL);
        e.toSchema(ARCHIVE);
        e.property(s => s.id).hasType(integer('id').primaryKey());
        e.property(s => s.catalogNo).hasType(varchar('catalog_no', 20)).isRequired();
        e.property(s => s.era).hasType(text('era'));
        indexes(e as unknown as EntityConfigBuilder<Scroll>);
      });
    }
  }

  return new ArchiveDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

function ledger(client: DatabaseClient, indexes: (entry: EntityConfigBuilder<Ledger>) => void, logs: Logged[]) {
  class LedgerRow extends Ledger {}
  class LedgerDb extends DbContext {
    get entries(): DbEntityTable<LedgerRow> {
      return this.table(LedgerRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(LedgerRow, e => {
        e.toTable(LEDGER);
        e.property(l => l.id).hasType(integer('Id').primaryKey());
        e.property(l => l.entryCode).hasType(varchar('EntryCode', 30)).isRequired();
        e.property(l => l.volume).hasType(integer('Volume'));
        indexes(e as unknown as EntityConfigBuilder<Ledger>);
      });
    }
  }

  return new LedgerDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

class Rack extends DbEntity {
  id!: DbColumn<number>;
  floor!: DbColumn<number>;
  label!: DbColumn<string>;
}

/** `ivx_rack`, partitioned by `floor`, with the model index `ivx_rack_label_ix`. */
function racks(client: DatabaseClient, logs: Logged[]) {
  class RackRow extends Rack {}
  class RackDb extends DbContext {
    get racks(): DbEntityTable<RackRow> {
      return this.table(RackRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(RackRow, e => {
        e.toTable(RACK);
        e.property(r => r.id).hasType(integer('id').primaryKey());
        e.property(r => r.floor).hasType(integer('floor').primaryKey());
        e.property(r => r.label).hasType(text('label'));
        e.hasPartitioning({ strategy: 'range', columns: r => r.floor });
        e.hasIndex('ivx_rack_label_ix', r => [r.label]);
      });
    }
  }

  return new RackDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

class BookCount extends DbEntity {
  id!: DbColumn<number>;
  isbn!: DbColumn<string>;
  copies!: DbColumn<number>;
}

/**
 * `ivx_book` with the model-managed view `ivx_book_counts` over it and the unique `ivx_book_isbn_uq`; `copiesRequired`
 * makes `copies` NOT NULL, `copiesIndexed` adds `ivx_book_copies_ix`. Each run of its onMigrationComplete hook is
 * recorded in `hookRuns`.
 */
function catalogue(client: DatabaseClient, logs: Logged[], shape: { copiesRequired: boolean; copiesIndexed: boolean }, hookRuns: string[]) {
  class BookRow extends Book {}
  class CountRow extends BookCount {}
  class CatalogueDb extends DbContext {
    get books(): DbEntityTable<BookRow> {
      return this.table(BookRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(BookRow, e => {
        e.toTable(BOOK);
        e.property(b => b.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${BOOK}_id_seq` }));
        e.property(b => b.isbn).hasType(varchar('isbn', 20)).isRequired();
        e.property(b => b.title).hasType(text('title')).isRequired();
        e.property(b => b.shelf).hasType(varchar('shelf', 20));
        if (shape.copiesRequired) {
          e.property(b => b.copies).hasType(integer('copies')).isRequired();
        } else {
          e.property(b => b.copies).hasType(integer('copies'));
        }
        e.property(b => b.archived).hasType(boolColumn('archived')).isRequired();
        e.hasIndex('ivx_book_isbn_uq', b => [b.isbn]).isUnique();
        if (shape.copiesIndexed) {
          e.hasIndex('ivx_book_copies_ix', b => [b.copies]);
        }
      });
      model.view(CountRow, v => {
        v.toView(BOOK_COUNTS);
        v.definedAs(`SELECT b."id", b."isbn", b."copies" FROM "${BOOK}" b`);
        v.property(c => c.id).hasType(integer('id'));
        v.property(c => c.isbn).hasType(varchar('isbn', 20));
        v.property(c => c.copies).hasType(integer('copies'));
      });
    }

    protected override async onMigrationComplete(): Promise<void> {
      hookRuns.push('onMigrationComplete');
    }
  }

  return new CatalogueDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

class Loan extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;
  renewedFromId!: DbColumn<number>;
  book?: Book;
  renewedFrom?: Loan;
}

/** Books and their loans: a loan references its book (ON DELETE CASCADE) and the loan it renewed (itself a loan). */
function lending(client: DatabaseClient, logs: Logged[]) {
  class BookRow extends Book {}
  class LoanRow extends Loan {}
  class LendingDb extends DbContext {
    get books(): DbEntityTable<BookRow> {
      return this.table(BookRow);
    }

    get loans(): DbEntityTable<LoanRow> {
      return this.table(LoanRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(BookRow, e => {
        e.toTable(BOOK);
        e.property(b => b.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${BOOK}_id_seq` }));
        e.property(b => b.isbn).hasType(varchar('isbn', 20)).isRequired();
        e.property(b => b.title).hasType(text('title')).isRequired();
        e.property(b => b.shelf).hasType(varchar('shelf', 20));
        e.property(b => b.copies).hasType(integer('copies')).isRequired();
        e.property(b => b.archived).hasType(boolColumn('archived')).isRequired();
      });
      model.entity(LoanRow, e => {
        e.toTable(LOAN);
        e.property(l => l.id).hasType(integer('id').primaryKey());
        e.property(l => l.bookId).hasType(integer('book_id')).isRequired();
        e.property(l => l.renewedFromId).hasType(integer('renewed_from'));
        e.hasOne(l => l.book, () => BookRow).withForeignKey(l => l.bookId).withPrincipalKey(b => b.id).onDelete('cascade').hasDbName('ivx_loan_book_fk');
        e.hasOne(l => l.renewedFrom, () => LoanRow).withForeignKey(l => l.renewedFromId).withPrincipalKey(l => l.id).hasDbName('ivx_loan_renewal_fk');
      });
    }
  }

  return new LendingDb(client, { logger: (message, section) => logs.push({ message, section }) });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface IndexState {
  valid: boolean;
  ready: boolean;
  def: string;
  oid: string;
}

/** A row of the schema manager's (private) `getExistingIndexes`. */
interface ExistingIndex {
  index_name: string;
  column_names: string[];
  canonical_def: string;
  is_valid: boolean;
  is_ready: boolean;
  is_unique: boolean;
  is_partitioned: boolean;
  required_by: { constraint: string; table: string } | null;
  build_in_progress: boolean;
}

/** A row of the schema manager's read of running index builds, as a test injects it. */
interface BuildRow {
  pid: number;
  relid: string | null;
  index_relid: string | null;
  locked_relations: string[];
}

interface ExistingForeignKey {
  constraint_name: string;
  column_names: string[];
  referenced_table: string;
  referenced_column_names: string[];
  on_delete: string | null;
  on_update: string | null;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

async function dropAll(client: DatabaseClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${LOAN} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${BOOK} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${quoteIdent(LEDGER)} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${RACK} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${ARCHIVE} CASCADE`);
}

/** A relation's oid, as text. */
async function oidOf(client: DatabaseClient, relation: string): Promise<string> {
  const { rows } = await client.query<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [relation]);

  return rows[0].oid;
}

async function indexState(client: DatabaseClient, name: string, schema = 'public'): Promise<IndexState | null> {
  const { rows } = await client.query<IndexState>(
    `SELECT x.indisvalid AS valid, x.indisready AS ready, pg_get_indexdef(x.indexrelid, 0, true) AS def, x.indexrelid::text AS oid
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  );

  return rows[0] ?? null;
}

async function insertBooks(client: DatabaseClient, rows: string): Promise<void> {
  await client.query(`INSERT INTO ${BOOK} (isbn, title, shelf, copies, archived) VALUES ${rows}`);
}

/**
 * 150 more books with distinct isbns: a plan has a real choice only on a table that is not tiny — the in-memory
 * engine, like PostgreSQL by cost, reads a table under 100 rows sequentially.
 */
async function insertBulkBooks(client: DatabaseClient): Promise<void> {
  await client.query(`INSERT INTO ${BOOK} (isbn, title, shelf, copies, archived) SELECT 'bulk-' || g, 'Volume ' || g, 'S' || (g % 10), 1 + g % 5, false FROM generate_series(1, 150) g`);
}

/** Run a build that must fail with `code` (it leaves an INVALID index behind when it was CONCURRENTLY). */
async function failBuild(client: DatabaseClient, sql: string, code = '23505'): Promise<void> {
  expect(sqlStateOf(await expectToReject(client.query(sql)))).toBe(code);
}

/** Flip `pg_index.indisvalid`, as a superuser may: an index still maintained on writes but never used for reads. */
async function invalidate(client: DatabaseClient, name: string, schema = 'public'): Promise<void> {
  await client.query('UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass($1)', [`${quoteIdent(schema)}.${quoteIdent(name)}`]);
}

/** Every statement the client runs from here on, in transactions too (the schema manager talks to its client directly). */
function recordStatements(client: DatabaseClient): string[] {
  const statements: string[] = [];
  const query = client.query.bind(client);
  client.query = ((sql: string, params?: unknown[], options?: unknown) => {
    statements.push(sql);
    return query(sql, params as never, options as never);
  }) as typeof client.query;
  const transaction = client.transaction.bind(client);
  client.transaction = (callback => transaction(inner => callback((sql: string, params?: unknown[], options?: unknown) => {
    statements.push(sql);
    return inner(sql, params as never, options as never);
  }))) as typeof client.transaction;

  return statements;
}

/** The index DDL among `statements` (without the mirror comparison's scratch indexes). */
function indexDdl(statements: string[]): string[] {
  return statements.filter(s => /^(CREATE (UNIQUE )?INDEX|DROP INDEX|ALTER INDEX)\b/.test(s) && !s.includes('_lkg_idxchk_'));
}

type IndexOperation = Extract<MigrationOperation, { type: 'create_index' | 'recreate_index' | 'repair_index' | 'drop_index' }>;

function indexOperations(operations: MigrationOperation[]): IndexOperation[] {
  return operations.filter((op): op is IndexOperation =>
    op.type === 'create_index' || op.type === 'recreate_index' || op.type === 'repair_index' || op.type === 'drop_index');
}

const planned = (operations: MigrationOperation[]): Array<[string, string]> => indexOperations(operations).map(op => [op.type, op.indexName]);

const warnings = (logs: Logged[]): string[] => logs.filter(l => l.section === 'warn').map(l => l.message);

/** The plan of `sql` with sequential scans disabled — it names every index the planner can use. */
async function planWithoutSeqScan(client: DatabaseClient, sql: string): Promise<string> {
  return client.transaction(async query => {
    await query('SET LOCAL enable_seqscan = off');
    const { rows } = await query(`EXPLAIN (COSTS OFF) ${sql}`);

    return rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
  });
}

/**
 * Run `hook` after every read of `ivx_book`'s indexes by the schema manager (the query that returns `canonical_def`),
 * with its 1-based ordinal: the plan's read is #1, a repair's re-read right before it rebuilds #2, its check after the
 * rebuild #3. The hook may change the database (through ANOTHER client) before the manager goes on.
 */
function onIndexRead(client: DatabaseClient, hook: (read: number) => Promise<void>): void {
  const query = client.query.bind(client);
  let reads = 0;
  client.query = (async (sql: string, params?: unknown[], options?: unknown) => {
    const result = await query(sql, params as never, options as never);
    if (sql.includes('canonical_def') && params?.[1] === BOOK) {
      await hook(++reads);
    }

    return result;
  }) as typeof client.query;
}

/** Run `change` once, right after the plan's index read — between `analyze()` and the execution of its operations. */
function afterPlanRead(client: DatabaseClient, change: () => Promise<void>): void {
  onIndexRead(client, async read => {
    if (read === 1) {
      await change();
    }
  });
}

/**
 * Answer the schema manager's reads of the index builds running in the database (pg_stat_progress_create_index, with
 * the tables each build's backend has locked — the query that returns `locked_relations`) with `builds(read)`, `read`
 * counting those reads from 1; `undefined` leaves a read as the database answered it. The manager reads them only
 * for a table with an INVALID index: in the plan, then right before each repair.
 */
function injectBuilds(client: DatabaseClient, builds: (read: number) => BuildRow[] | undefined): void {
  const query = client.query.bind(client);
  let reads = 0;
  client.query = (async (sql: string, params?: unknown[], options?: unknown) => {
    const result = await query(sql, params as never, options as never);
    if (sql.includes('pg_stat_progress_create_index') && sql.includes('locked_relations')) {
      const injected = builds(++reads);
      if (injected) {
        result.rows = injected;
      }
    }

    return result;
  }) as typeof client.query;
}

/** A build running on `table` (another session's CREATE INDEX CONCURRENTLY of `index`), as its progress row shows it. */
const buildOn = (table: string, index: string): BuildRow => ({ pid: 4242, relid: table, index_relid: index, locked_relations: [table] });

/** Statements run by a client of their own (not recorded as the migration's). */
async function onAnotherClient(...statements: string[]): Promise<void> {
  const other = createFreshClient();
  try {
    for (const statement of statements) {
      await other.query(statement);
    }
  } finally {
    await other.end();
  }
}

/** Swallow every DROP INDEX of `indexName` — a rebuild whose drop removed nothing. */
function ignoreDropIndex(client: DatabaseClient, indexName: string): void {
  const query = client.query.bind(client);
  client.query = (async (sql: string, params?: unknown[], options?: unknown) => {
    if (/^DROP INDEX\b/.test(sql) && sql.includes(quoteIdent(indexName))) {
      return { rows: [], rowCount: 0 };
    }

    return query(sql, params as never, options as never);
  }) as typeof client.query;
}

interface Harness<TDb> {
  client: DatabaseClient;
  db: TDb;
  logs: Logged[];
  statements: string[];
}

/** A fresh client and model; the schema is created from the model first and dropped before and after. */
async function withModel<TDb extends DbContext>(
  build: (client: DatabaseClient, logs: Logged[]) => TDb,
  body: (harness: Harness<TDb>) => Promise<void>,
  wrap?: (client: DatabaseClient) => void
): Promise<void> {
  const client = createFreshClient();
  const statements = recordStatements(client);
  wrap?.(client);
  const logs: Logged[] = [];
  const db = build(client, logs);
  try {
    await dropAll(client);
    await db.getSchemaManager().ensureCreated();
    statements.length = 0;
    logs.length = 0;
    await body({ client, db, logs, statements });
  } finally {
    await dropAll(client);
    await db.dispose();
  }
}

const withLibrary = (indexes: BookIndexes, body: (harness: Harness<ReturnType<typeof library>>) => Promise<void>, wrap?: (client: DatabaseClient) => void) =>
  withModel((client, logs) => library(client, indexes, logs), body, wrap);

const ISBN_UQ_DEF = 'CREATE UNIQUE INDEX ivx_book_isbn_uq ON ivx_book USING btree (isbn)';
const IN_PROGRESS_WARNING = '  ⊘ INVALID index "ivx_book_isbn_uq" on "ivx_book" left alone: an index is being built on "ivx_book" (pg_stat_progress_create_index) — run the migration again once that build has finished.\n';
const BLOCKING_WARNING = '    (blocking repair — enable concurrentIndexes or .concurrent() for non-blocking)\n';
/** The blocking repair of `ivx_book_isbn_uq`: the model's index built beside the INVALID one, then swapped in. */
const ISBN_UQ_REBUILT_BESIDE = [
  'CREATE UNIQUE INDEX "ivx_book_isbn_uq_lkgnew" ON "ivx_book" ("isbn")',
  'DROP INDEX IF EXISTS "ivx_book_isbn_uq"',
  'ALTER INDEX "ivx_book_isbn_uq_lkgnew" RENAME TO "ivx_book_isbn_uq"',
];
const ISBN_UQ_PLAN_BLOCKING = '1. Repair INVALID index "ivx_book_isbn_uq" on "ivx_book" (build from the model as "ivx_book_isbn_uq_lkgnew", then swap it in)';
const READY_UNIQUE_WARNING = '  ⊘ INVALID unique index "ivx_book_isbn_uq" on "ivx_book" left alone: it is still ready (indisready), so it keeps rejecting duplicates, and dropping it to rebuild would stop that — rebuild it in place with REINDEX INDEX CONCURRENTLY "ivx_book_isbn_uq" (remove duplicate rows first if that fails).\n';

/** `ivx_book_isbn_uq` INVALID after a failed unique concurrent build: two books share an isbn. */
async function leaveIsbnIndexInvalid(client: DatabaseClient): Promise<void> {
  await client.query('DROP INDEX ivx_book_isbn_uq');
  await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('111', 'Emma', 'A2', 1, false), ('222', 'Iliad', 'B1', 3, false)`);
  await failBuild(client, `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_isbn_uq ON ${BOOK} (isbn)`);
  expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false, ready: false, def: ISBN_UQ_DEF });
}

/** A build of `ivx_book_isbn_uq` in progress: `finish()` lets it complete, `cleanup()` releases what it holds. */
interface StagedBuild {
  finish(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * A real `CREATE UNIQUE INDEX CONCURRENTLY` another session runs, held in "waiting for writers before build" by a
 * writer's open transaction until `finish()`; returns once `pg_stat_progress_create_index` shows the build.
 */
async function startWaitingBuild(client: DatabaseClient): Promise<StagedBuild> {
  await client.query('DROP INDEX ivx_book_isbn_uq');
  await insertBooks(client, `('111', 'Dune', 'A1', 2, false)`);
  const writer = createFreshClient();
  const builder = createFreshClient();
  let releaseWriter!: () => void;
  const writerHolds = new Promise<void>(resolve => (releaseWriter = resolve));
  let writerStarted!: () => void;
  const writerOpen = new Promise<void>(resolve => (writerStarted = resolve));
  const writing = writer.transaction(async query => {
    await query(`INSERT INTO ${BOOK} (isbn, title, shelf, copies, archived) VALUES ('222', 'Emma', 'A2', 1, false)`);
    writerStarted();
    await writerHolds;
  });
  writing.catch(() => writerStarted());
  // never hold the write lock past the test's own budget, whatever happens
  const safety = setTimeout(releaseWriter, 10000);
  let building: Promise<unknown> = Promise.resolve();
  const staged: StagedBuild = {
    finish: async () => {
      releaseWriter();
      await writing;
      await building;
    },
    cleanup: async () => {
      clearTimeout(safety);
      releaseWriter();
      await writing.catch(() => undefined);
      await building.catch(() => undefined);
      await writer.end();
      await builder.end();
    },
  };
  try {
    await writerOpen;
    building = builder.query(`CREATE UNIQUE INDEX CONCURRENTLY ivx_book_isbn_uq ON ${BOOK} (isbn)`);
    building.catch(() => undefined);
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_stat_progress_create_index WHERE index_relid = to_regclass('ivx_book_isbn_uq')`);
      waiting = rows[0].n === 1;
      if (!waiting) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    expect(waiting).toBe(true);
  } catch (error) {
    await staged.cleanup();
    throw error;
  }

  return staged;
}

/** What a staged build makes the injected read of running builds answer (`undefined`: the database's own answer). */
interface InjectedBuilds {
  rows?: BuildRow[];
}

/**
 * The same state staged without a second session: an INVALID index whose table the manager's (injected) read of running
 * builds shows `rows` on, until `finish()` ends the build as a concurrent build ends — the index, valid.
 */
async function injectBuild(client: DatabaseClient, injected: InjectedBuilds, rows: (table: string, index: string) => BuildRow[]): Promise<StagedBuild> {
  await leaveIsbnIndexInvalid(client);
  await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
  injected.rows = rows(await oidOf(client, BOOK), await oidOf(client, 'ivx_book_isbn_uq'));

  return {
    finish: async () => {
      injected.rows = undefined;
      await onAnotherClient('DROP INDEX ivx_book_isbn_uq', `CREATE UNIQUE INDEX ivx_book_isbn_uq ON ${BOOK} (isbn)`);
    },
    cleanup: async () => {
      injected.rows = undefined;
    },
  };
}

/**
 * A real `REINDEX INDEX CONCURRENTLY` of the INVALID `ivx_book_isbn_uq`, held in "waiting for old snapshots" by a
 * reader's REPEATABLE READ snapshot until `finish()`: past its first phase its progress row names the table and the new
 * `ivx_book_isbn_uq_ccnew` index — never the INVALID one.
 */
async function startReindex(client: DatabaseClient): Promise<StagedBuild> {
  await leaveIsbnIndexInvalid(client);
  await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
  const reader = createFreshClient();
  const builder = createFreshClient();
  let releaseReader!: () => void;
  const readerHolds = new Promise<void>(resolve => (releaseReader = resolve));
  let snapshotTaken!: () => void;
  const readerOpen = new Promise<void>(resolve => (snapshotTaken = resolve));
  // a snapshot older than the rebuild, over no table: the REINDEX waits for it before swapping the new index in
  const reading = reader.transaction(async query => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('SELECT 1');
    snapshotTaken();
    await readerHolds;
  });
  reading.catch(() => snapshotTaken());
  // never hold the snapshot past the test's own budget, whatever happens
  const safety = setTimeout(releaseReader, 10000);
  let reindexing: Promise<unknown> = Promise.resolve();
  const staged: StagedBuild = {
    finish: async () => {
      releaseReader();
      await reading;
      await reindexing;
    },
    cleanup: async () => {
      clearTimeout(safety);
      releaseReader();
      await reading.catch(() => undefined);
      await reindexing.catch(() => undefined);
      await reader.end();
      await builder.end();
    },
  };
  try {
    await readerOpen;
    reindexing = builder.query('REINDEX INDEX CONCURRENTLY ivx_book_isbn_uq');
    reindexing.catch(() => undefined);
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_progress_create_index
          WHERE relid = to_regclass('${BOOK}') AND index_relid = to_regclass('ivx_book_isbn_uq_ccnew') AND phase = 'waiting for old snapshots'`
      );
      waiting = rows[0].n === 1;
      if (!waiting) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    expect(waiting).toBe(true);
  } catch (error) {
    await staged.cleanup();
    throw error;
  }

  return staged;
}

const isbnUnique: BookIndexes = b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn]).isUnique();
const isbnUniqueConcurrent: BookIndexes = b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn]).isUnique().concurrent();

// ---------------------------------------------------------------------------

describe('INVALID indexes: the reconcile treats them as missing and rebuilds them', () => {
  describe('reading the database', () => {
    test('getExistingIndexes reports every non-primary index with its state flags, what requires it, and build_in_progress', async () => {
      await withLibrary(b => {
        isbnUnique(b);
        b.hasIndex('ivx_book_title_ix', x => [x.title]);
        b.hasIndex('ivx_book_title_lower_ix').withExpression('lower("title")');
        b.hasIndex('ivx_book_shelf_cover_ix', x => [x.shelf]).include(x => [x.copies, x.title]);
      }, async ({ client, db }) => {
        await client.query(`ALTER TABLE ${BOOK} ADD CONSTRAINT ivx_book_title_key UNIQUE (title)`);
        const existing: ExistingIndex[] = await (db.getSchemaManager() as any).getExistingIndexes(BOOK, undefined);

        const flags = { is_valid: true, is_ready: true, is_partitioned: false, build_in_progress: false };
        // column_names: the key columns then the INCLUDE columns, in index order; an expression key has none
        expect(existing.sort((a, z) => a.index_name.localeCompare(z.index_name))).toEqual([
          { index_name: 'ivx_book_isbn_uq', column_names: ['isbn'], canonical_def: ISBN_UQ_DEF, ...flags, is_unique: true, required_by: null },
          {
            index_name: 'ivx_book_shelf_cover_ix',
            column_names: ['shelf', 'copies', 'title'],
            canonical_def: 'CREATE INDEX ivx_book_shelf_cover_ix ON ivx_book USING btree (shelf) INCLUDE (copies, title)',
            ...flags,
            is_unique: false,
            required_by: null,
          },
          { index_name: 'ivx_book_title_ix', column_names: ['title'], canonical_def: 'CREATE INDEX ivx_book_title_ix ON ivx_book USING btree (title)', ...flags, is_unique: false, required_by: null },
          {
            index_name: 'ivx_book_title_key',
            column_names: ['title'],
            canonical_def: 'CREATE UNIQUE INDEX ivx_book_title_key ON ivx_book USING btree (title)',
            ...flags,
            is_unique: true,
            required_by: { constraint: 'ivx_book_title_key', table: BOOK },
          },
          { index_name: 'ivx_book_title_lower_ix', column_names: [], canonical_def: 'CREATE INDEX ivx_book_title_lower_ix ON ivx_book USING btree (lower(title))', ...flags, is_unique: false, required_by: null },
        ]);
      });
    });

    test('getExistingIndexes reports the INVALID index a failed concurrent build left, with its definition', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);

        const existing = await (db.getSchemaManager() as any).getExistingIndexes(BOOK, undefined);

        expect(existing).toEqual([{
          index_name: 'ivx_book_isbn_uq',
          column_names: ['isbn'],
          canonical_def: ISBN_UQ_DEF,
          is_valid: false,
          is_ready: false,
          is_unique: true,
          is_partitioned: false,
          required_by: null,
          build_in_progress: false,
        }]);
      });
    });

    test('getExistingIndexes reports a partitioned index as such, INVALID and ready while partitions lack an attached index', async () => {
      await withModel((client, logs) => racks(client, logs), async ({ client, db }) => {
        await client.query(`CREATE TABLE ${RACK}_1 PARTITION OF ${RACK} FOR VALUES FROM (0) TO (10)`);
        await client.query('DROP INDEX ivx_rack_label_ix');
        await client.query(`CREATE INDEX ivx_rack_label_ix ON ONLY ${RACK} (label)`);

        const existing: ExistingIndex[] = await (db.getSchemaManager() as any).getExistingIndexes(RACK, undefined);

        expect(existing).toEqual([{
          index_name: 'ivx_rack_label_ix',
          column_names: ['label'],
          canonical_def: 'CREATE INDEX ivx_rack_label_ix ON ONLY ivx_rack USING btree (label)',
          is_valid: false,
          is_ready: true,
          is_unique: false,
          is_partitioned: true,
          required_by: null,
          build_in_progress: false,
        }]);
      });
    });

    test('getExistingForeignKeys reports each foreign key\'s column lists as arrays', async () => {
      await withModel((client, logs) => lending(client, logs), async ({ db }) => {
        const existing: ExistingForeignKey[] = await (db.getSchemaManager() as any).getExistingForeignKeys(LOAN, undefined);

        expect(existing.sort((a, z) => a.constraint_name.localeCompare(z.constraint_name))).toEqual([
          { constraint_name: 'ivx_loan_book_fk', column_names: ['book_id'], referenced_table: BOOK, referenced_column_names: ['id'], on_delete: 'CASCADE', on_update: 'NO ACTION' },
          { constraint_name: 'ivx_loan_renewal_fk', column_names: ['renewed_from'], referenced_table: LOAN, referenced_column_names: ['id'], on_delete: 'NO ACTION', on_update: 'NO ACTION' },
        ]);
      });
    });
  });

  describe('a unique index whose concurrent build failed over duplicates', () => {
    test('analyze() plans a repair_index operation carrying the model definition and the INVALID one', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);

        const operations = await db.getSchemaManager().analyze();

        expect(indexOperations(operations)).toEqual([{
          type: 'repair_index',
          tableName: BOOK,
          schema: undefined,
          indexName: 'ivx_book_isbn_uq',
          columns: ['isbn'],
          isUnique: true,
          using: undefined,
          operatorClass: undefined,
          concurrent: undefined,
          expressions: undefined,
          where: undefined,
          nullsNotDistinct: undefined,
          include: undefined,
          previousDef: ISBN_UQ_DEF,
        }]);
      });
    });

    test('migrate() rebuilds it once the duplicates are gone: valid, the model definition, a new index', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const before = await indexState(client, 'ivx_book_isbn_uq');

        await db.getSchemaManager().migrate();

        const after = await indexState(client, 'ivx_book_isbn_uq');
        expect(before).toMatchObject({ valid: false, ready: false, def: ISBN_UQ_DEF });
        expect(after).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
        expect(after!.oid).not.toBe(before!.oid);
      });
    });

    test('before the repair a duplicate isbn is accepted; after it the index rejects one', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const sharing222 = `SELECT count(*)::int AS n FROM ${BOOK} WHERE isbn = '222'`;

        // the INVALID index enforces nothing: the application silently stores a duplicate
        await insertBooks(client, `('222', 'Odyssey', 'B2', 1, false)`);
        expect((await client.query(sharing222)).rows).toEqual([{ n: 2 }]);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Odyssey'`);

        await db.getSchemaManager().migrate();

        const duplicate = await expectToReject(insertBooks(client, `('222', 'Odyssey', 'B2', 1, false)`));
        expect(sqlStateOf(duplicate)).toBe('23505');
        expect(duplicate.message).toBe('duplicate key value violates unique constraint "ivx_book_isbn_uq"');
        expect((await client.query(sharing222)).rows).toEqual([{ n: 1 }]);
      });
    });

    test('the repaired index serves reads: the plan uses it', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await insertBulkBooks(client);
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const lookup = `SELECT id FROM ${BOOK} WHERE isbn = '222'`;
        const planBefore = await planWithoutSeqScan(client, lookup);

        await db.getSchemaManager().migrate();

        expect(planBefore).not.toContain('ivx_book_isbn_uq');
        expect(await planWithoutSeqScan(client, lookup)).toContain('ivx_book_isbn_uq');
      });
    });

    test('a second reconcile after the repair is a no-op', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        await db.getSchemaManager().migrate();
        const repaired = await indexState(client, 'ivx_book_isbn_uq');
        expect(repaired).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
        statements.length = 0;
        logs.length = 0;

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect(logs.map(l => l.message)).toContain('✓ Database schema is already in sync with model\n');
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(repaired);
      });
    });

    test('analyze() alone — the dry run — changes nothing: the index stays INVALID and in place', async () => {
      await withLibrary(isbnUnique, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        statements.length = 0;

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);

        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      });
    });

    test('migrate() lists the repair in its operations and logs it as it runs', async () => {
      await withLibrary(isbnUniqueConcurrent, async ({ client, db, logs }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);

        await db.getSchemaManager().migrate();

        const messages = logs.map(l => l.message);
        expect(messages).toContain('📋 Found 1 operations to perform:\n');
        expect(messages).toContain('1. Repair INVALID index "ivx_book_isbn_uq" on "ivx_book" (drop + create CONCURRENTLY from the model)');
        expect(messages).toContain('  Repairing INVALID index "ivx_book_isbn_uq" on "ivx_book"...\n');
      });
    });
  });

  describe('the repair path: concurrent or blocking, reusing the create path', () => {
    test('.concurrent(): DROP INDEX CONCURRENTLY IF EXISTS, then CREATE … CONCURRENTLY IF NOT EXISTS, no warning', async () => {
      await withLibrary(isbnUniqueConcurrent, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([
          'DROP INDEX CONCURRENTLY IF EXISTS "ivx_book_isbn_uq"',
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ivx_book_isbn_uq" ON "ivx_book" ("isbn")',
        ]);
        expect(warnings(logs)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
      });
    });

    test('concurrentIndexes: true makes the repair of an index without .concurrent() concurrent', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager({ concurrentIndexes: true }).migrate();

        expect(indexDdl(statements)).toEqual([
          'DROP INDEX CONCURRENTLY IF EXISTS "ivx_book_isbn_uq"',
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ivx_book_isbn_uq" ON "ivx_book" ("isbn")',
        ]);
        expect(warnings(logs)).toEqual([]);
        expect(logs.map(l => l.message)).toContain('1. Repair INVALID index "ivx_book_isbn_uq" on "ivx_book" (drop + create CONCURRENTLY from the model)');
      });
    });

    test('neither: built beside the INVALID index under a temporary name, then swapped in — announced as blocking', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual(ISBN_UQ_REBUILT_BESIDE);
        expect(warnings(logs)).toEqual([BLOCKING_WARNING]);
        expect(logs.map(l => l.message)).toContain(ISBN_UQ_PLAN_BLOCKING);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
        expect(await indexState(client, 'ivx_book_isbn_uq_lkgnew')).toBeNull();
      });
    });

    test('the swap runs in one transaction: DROP of the INVALID index and RENAME of the new one', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const transactions: string[][] = [];
        const transaction = client.transaction.bind(client);
        client.transaction = (callback => transaction(inner => {
          const statements: string[] = [];
          transactions.push(statements);
          return callback((sql: string, params?: unknown[], options?: unknown) => {
            statements.push(sql);
            return inner(sql, params as never, options as never);
          });
        })) as typeof client.transaction;

        await db.getSchemaManager().migrate();

        expect(transactions).toEqual([ISBN_UQ_REBUILT_BESIDE.slice(1)]);
      });
    });

    test('a name of the full 63 bytes is shortened, by whole characters, so that its temporary name fits too', async () => {
      // 63 bytes, the most PostgreSQL keeps of a name: ASCII, and two-byte characters
      const ASCII = `ivx_book_isbn_${'x'.repeat(49)}`;
      const WIDE = `ivx_book_${'é'.repeat(27)}`;
      await withLibrary(b => {
        b.hasIndex(ASCII, x => [x.isbn]);
        b.hasIndex(WIDE, x => [x.title]);
      }, async ({ client, db, statements }) => {
        await invalidate(client, ASCII);
        await invalidate(client, WIDE);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        const asciiTemp = `ivx_book_isbn_${'x'.repeat(42)}_lkgnew`;
        const wideTemp = `ivx_book_${'é'.repeat(23)}_lkgnew`;
        expect([ASCII, WIDE, asciiTemp, wideTemp].map(name => Buffer.byteLength(name))).toEqual([63, 63, 63, 62]);
        expect(indexDdl(statements)).toEqual([
          `CREATE INDEX "${asciiTemp}" ON "ivx_book" ("isbn")`,
          `DROP INDEX IF EXISTS "${ASCII}"`,
          `ALTER INDEX "${asciiTemp}" RENAME TO "${ASCII}"`,
          `CREATE INDEX "${wideTemp}" ON "ivx_book" ("title")`,
          `DROP INDEX IF EXISTS "${WIDE}"`,
          `ALTER INDEX "${wideTemp}" RENAME TO "${WIDE}"`,
        ]);
        expect([await indexState(client, ASCII), await indexState(client, WIDE)]).toEqual([
          expect.objectContaining({ valid: true, ready: true }),
          expect.objectContaining({ valid: true, ready: true }),
        ]);
      });
    });

    test('recreateChangedIndexes: false still repairs an INVALID index (it is missing, not changed)', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const manager = db.getSchemaManager({ recreateChangedIndexes: false });

        expect(planned(await manager.analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
        await manager.migrate();

        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
      });
    });

    test('recreateChangedIndexes: false still leaves a VALID changed index alone', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn, x.shelf]), async ({ client, db }) => {
        await client.query('DROP INDEX ivx_book_isbn_uq');
        await client.query(`CREATE UNIQUE INDEX ivx_book_isbn_uq ON ${BOOK} (isbn)`);
        const manager = db.getSchemaManager({ recreateChangedIndexes: false });
        const before = await indexState(client, 'ivx_book_isbn_uq');

        expect(indexOperations(await manager.analyze())).toEqual([]);
        await manager.migrate();

        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      });
    });

    test('an INVALID index whose model definition also changed is rebuilt from the model in ONE repair', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn, x.shelf]), async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        statements.length = 0;

        const operations = await db.getSchemaManager().analyze();
        await db.getSchemaManager().migrate();

        expect(indexOperations(operations)).toEqual([expect.objectContaining({
          type: 'repair_index',
          indexName: 'ivx_book_isbn_uq',
          columns: ['isbn', 'shelf'],
          previousDef: ISBN_UQ_DEF,
        })]);
        expect(indexDdl(statements)).toEqual([
          'CREATE INDEX "ivx_book_isbn_uq_lkgnew" ON "ivx_book" ("isbn", "shelf")',
          'DROP INDEX IF EXISTS "ivx_book_isbn_uq"',
          'ALTER INDEX "ivx_book_isbn_uq_lkgnew" RENAME TO "ivx_book_isbn_uq"',
        ]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({
          valid: true,
          def: 'CREATE INDEX ivx_book_isbn_uq ON ivx_book USING btree (isbn, shelf)',
        });
        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      });
    });

    test('… and with recreateChangedIndexes: false the rebuild still takes the model definition', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn, x.shelf]), async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        const manager = db.getSchemaManager({ recreateChangedIndexes: false });

        expect(planned(await manager.analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
        await manager.migrate();

        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({
          valid: true,
          def: 'CREATE INDEX ivx_book_isbn_uq ON ivx_book USING btree (isbn, shelf)',
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // shapes left INVALID by a real failed build — every engine
  // -------------------------------------------------------------------------

  interface FailedBuildCase {
    name: string;
    index: string;
    indexes: BookIndexes;
    /** rows that make the concurrent build fail */
    rows: string;
    build: string;
    code: string;
    /** removes the cause */
    fix: string;
    /** pg_get_indexdef after the repair */
    def: string;
  }

  const FAILED_BUILDS: FailedBuildCase[] = [
    {
      name: 'multi-column unique',
      index: 'ivx_book_shelf_title_uq',
      indexes: b => b.hasIndex('ivx_book_shelf_title_uq', x => [x.shelf, x.title]).isUnique(),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'Dune', 'A1', 1, false), ('113', 'Dune', 'A2', 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_shelf_title_uq ON ${BOOK} (shelf, title)`,
      code: '23505',
      fix: `DELETE FROM ${BOOK} WHERE isbn = '112'`,
      def: 'CREATE UNIQUE INDEX ivx_book_shelf_title_uq ON ivx_book USING btree (shelf, title)',
    },
    {
      name: 'partial unique (WHERE)',
      index: 'ivx_book_isbn_stocked_uq',
      indexes: b => b.hasIndex('ivx_book_isbn_stocked_uq', x => [x.isbn]).isUnique().where('copies > 0'),
      rows: `('111', 'Dune', 'A1', 2, false), ('111', 'Emma', 'A2', 1, false), ('222', 'Iliad', 'B1', 0, false), ('222', 'Odyssey', 'B2', 0, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_isbn_stocked_uq ON ${BOOK} (isbn) WHERE copies > 0`,
      code: '23505',
      fix: `UPDATE ${BOOK} SET copies = 0 WHERE title = 'Emma'`,
      def: 'CREATE UNIQUE INDEX ivx_book_isbn_stocked_uq ON ivx_book USING btree (isbn) WHERE copies > 0',
    },
    {
      name: 'expression unique (lower(title))',
      index: 'ivx_book_title_lower_uq',
      indexes: b => b.hasIndex('ivx_book_title_lower_uq').withExpression('lower("title")').isUnique(),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'DUNE', 'A2', 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_title_lower_uq ON ${BOOK} (lower(title))`,
      code: '23505',
      fix: `UPDATE ${BOOK} SET title = 'Dune Messiah' WHERE isbn = '112'`,
      def: 'CREATE UNIQUE INDEX ivx_book_title_lower_uq ON ivx_book USING btree (lower(title))',
    },
    {
      name: 'unique with INCLUDE columns',
      index: 'ivx_book_isbn_cover_uq',
      indexes: b => b.hasIndex('ivx_book_isbn_cover_uq', x => [x.isbn]).isUnique().include(x => [x.title, x.copies]),
      rows: `('111', 'Dune', 'A1', 2, false), ('111', 'Emma', 'A2', 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_isbn_cover_uq ON ${BOOK} (isbn) INCLUDE (title, copies)`,
      code: '23505',
      fix: `UPDATE ${BOOK} SET isbn = '112' WHERE title = 'Emma'`,
      def: 'CREATE UNIQUE INDEX ivx_book_isbn_cover_uq ON ivx_book USING btree (isbn) INCLUDE (title, copies)',
    },
    {
      name: 'unique DESC NULLS LAST',
      index: 'ivx_book_shelf_desc_uq',
      indexes: b => b.hasIndex('ivx_book_shelf_desc_uq').withExpression('"shelf" DESC NULLS LAST').isUnique(),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'Emma', 'A1', 1, false), ('113', 'Iliad', NULL, 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_shelf_desc_uq ON ${BOOK} (shelf DESC NULLS LAST)`,
      code: '23505',
      fix: `UPDATE ${BOOK} SET shelf = 'A2' WHERE isbn = '112'`,
      def: 'CREATE UNIQUE INDEX ivx_book_shelf_desc_uq ON ivx_book USING btree (shelf DESC NULLS LAST)',
    },
    {
      name: 'unique with an operator class (text_pattern_ops)',
      index: 'ivx_book_title_pattern_uq',
      indexes: b => b.hasIndex('ivx_book_title_pattern_uq', x => [x.title]).isUnique().withOperatorClass('text_pattern_ops'),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'Dune', 'A2', 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_title_pattern_uq ON ${BOOK} (title text_pattern_ops)`,
      code: '23505',
      fix: `DELETE FROM ${BOOK} WHERE isbn = '112'`,
      def: 'CREATE UNIQUE INDEX ivx_book_title_pattern_uq ON ivx_book USING btree (title text_pattern_ops)',
    },
    {
      name: 'unique NULLS NOT DISTINCT',
      index: 'ivx_book_shelf_nnd_uq',
      indexes: b => b.hasIndex('ivx_book_shelf_nnd_uq', x => [x.shelf]).isUnique().nullsNotDistinct(),
      rows: `('111', 'Dune', NULL, 2, false), ('112', 'Emma', NULL, 1, false), ('113', 'Iliad', 'B1', 1, false)`,
      build: `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_shelf_nnd_uq ON ${BOOK} (shelf) NULLS NOT DISTINCT`,
      code: '23505',
      fix: `UPDATE ${BOOK} SET shelf = 'A2' WHERE isbn = '112'`,
      def: 'CREATE UNIQUE INDEX ivx_book_shelf_nnd_uq ON ivx_book USING btree (shelf) NULLS NOT DISTINCT',
    },
    // The two below repair CONCURRENTLY: the fix (an UPDATE) leaves the old row version behind, and while any older
    // transaction in the same database can still see it, a blocking CREATE INDEX indexes it too — evaluating the
    // expression on `copies = 0` again — whereas a concurrent build reads an MVCC snapshot of the live rows only.
    {
      name: 'expression index whose expression raised for a row',
      index: 'ivx_book_ratio_ix',
      indexes: b => b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")').concurrent(),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'Emma', 'A2', 0, false)`,
      build: `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`,
      code: '22012',
      fix: `UPDATE ${BOOK} SET copies = 1 WHERE copies = 0`,
      def: 'CREATE INDEX ivx_book_ratio_ix ON ivx_book USING btree ((100 / copies))',
    },
    {
      name: 'partial index whose predicate raised for a row',
      index: 'ivx_book_shelf_ratio_ix',
      indexes: b => b.hasIndex('ivx_book_shelf_ratio_ix', x => [x.shelf]).where('(100 / copies) > 1').concurrent(),
      rows: `('111', 'Dune', 'A1', 2, false), ('112', 'Emma', 'A2', 0, false)`,
      build: `CREATE INDEX CONCURRENTLY ivx_book_shelf_ratio_ix ON ${BOOK} (shelf) WHERE (100 / copies) > 1`,
      code: '22012',
      fix: `UPDATE ${BOOK} SET copies = 1 WHERE copies = 0`,
      def: 'CREATE INDEX ivx_book_shelf_ratio_ix ON ivx_book USING btree (shelf) WHERE (100 / copies) > 1',
    },
  ];

  describe('every shape a failed build leaves INVALID is rebuilt to the model definition, then converges', () => {
    for (const c of FAILED_BUILDS) {
      test(c.name, async () => {
        await withLibrary(c.indexes, async ({ client, db }) => {
          await client.query(`DROP INDEX ${c.index}`);
          await insertBooks(client, c.rows);
          await failBuild(client, c.build, c.code);
          expect(await indexState(client, c.index)).toMatchObject({ valid: false, ready: false });
          await client.query(c.fix);

          expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', c.index]]);
          await db.getSchemaManager().migrate();

          expect(await indexState(client, c.index)).toMatchObject({ valid: true, ready: true, def: c.def });
          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        });
      });
    }

    test('unique index on a schema-qualified table', async () => {
      await withModel((client, logs) => archive(client, s => s.hasIndex('ivx_scroll_catalog_uq', x => [x.catalogNo]).isUnique().concurrent(), logs), async ({ client, db, statements }) => {
        await client.query(`DROP INDEX ${ARCHIVE}.ivx_scroll_catalog_uq`);
        await client.query(`INSERT INTO ${ARCHIVE}.${SCROLL} (id, catalog_no, era) VALUES (1, 'S-1', 'bronze'), (2, 'S-1', 'iron')`);
        await failBuild(client, `CREATE UNIQUE INDEX CONCURRENTLY ivx_scroll_catalog_uq ON ${ARCHIVE}.${SCROLL} (catalog_no)`);
        await client.query(`UPDATE ${ARCHIVE}.${SCROLL} SET catalog_no = 'S-2' WHERE id = 2`);
        statements.length = 0;

        const operations = await db.getSchemaManager().analyze();
        await db.getSchemaManager().migrate();

        expect(indexOperations(operations)).toEqual([expect.objectContaining({ type: 'repair_index', tableName: SCROLL, schema: ARCHIVE, indexName: 'ivx_scroll_catalog_uq' })]);
        expect(indexDdl(statements)).toEqual([
          'DROP INDEX CONCURRENTLY IF EXISTS "ivx_archive"."ivx_scroll_catalog_uq"',
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ivx_scroll_catalog_uq" ON "ivx_archive"."ivx_scroll" ("catalog_no")',
        ]);
        expect(await indexState(client, 'ivx_scroll_catalog_uq', ARCHIVE)).toMatchObject({
          valid: true,
          def: 'CREATE UNIQUE INDEX ivx_scroll_catalog_uq ON ivx_archive.ivx_scroll USING btree (catalog_no)',
        });
        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      });
    });

    test('unique index with quoted, mixed-case table, column and index names', async () => {
      await withModel((client, logs) => ledger(client, l => l.hasIndex('IvxLedger_EntryCode_UQ', x => [x.entryCode]).isUnique(), logs), async ({ client, db, statements }) => {
        await client.query('DROP INDEX "IvxLedger_EntryCode_UQ"');
        await client.query(`INSERT INTO "IvxLedger" ("Id", "EntryCode", "Volume") VALUES (1, 'E-1', 1), (2, 'E-1', 2)`);
        await failBuild(client, 'CREATE UNIQUE INDEX CONCURRENTLY "IvxLedger_EntryCode_UQ" ON "IvxLedger" ("EntryCode")');
        await client.query(`DELETE FROM "IvxLedger" WHERE "Id" = 2`);
        statements.length = 0;

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'IvxLedger_EntryCode_UQ']]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([
          'CREATE UNIQUE INDEX "IvxLedger_EntryCode_UQ_lkgnew" ON "IvxLedger" ("EntryCode")',
          'DROP INDEX IF EXISTS "IvxLedger_EntryCode_UQ"',
          'ALTER INDEX "IvxLedger_EntryCode_UQ_lkgnew" RENAME TO "IvxLedger_EntryCode_UQ"',
        ]);
        expect(await indexState(client, 'IvxLedger_EntryCode_UQ')).toMatchObject({
          valid: true,
          def: 'CREATE UNIQUE INDEX "IvxLedger_EntryCode_UQ" ON "IvxLedger" USING btree ("EntryCode")',
        });
        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // shapes made INVALID directly (UPDATE pg_index) — every engine
  // -------------------------------------------------------------------------

  interface DirectCase {
    name: string;
    index: string;
    indexes: BookIndexes;
    def: string;
    setup?: string;
  }

  const DIRECT: DirectCase[] = [
    { name: 'plain column', index: 'ivx_book_title_ix', indexes: b => b.hasIndex('ivx_book_title_ix', x => [x.title]), def: 'CREATE INDEX ivx_book_title_ix ON ivx_book USING btree (title)' },
    { name: 'multi-column', index: 'ivx_book_shelf_copies_ix', indexes: b => b.hasIndex('ivx_book_shelf_copies_ix', x => [x.shelf, x.copies]), def: 'CREATE INDEX ivx_book_shelf_copies_ix ON ivx_book USING btree (shelf, copies)' },
    { name: 'INCLUDE columns', index: 'ivx_book_isbn_cover_ix', indexes: b => b.hasIndex('ivx_book_isbn_cover_ix', x => [x.isbn]).include(x => [x.title]), def: 'CREATE INDEX ivx_book_isbn_cover_ix ON ivx_book USING btree (isbn) INCLUDE (title)' },
    // DESC NULLS FIRST is DESC's default: PostgreSQL prints only "DESC", so convergence rests on the mirror comparison
    { name: 'DESC NULLS FIRST', index: 'ivx_book_copies_desc_ix', indexes: b => b.hasIndex('ivx_book_copies_desc_ix').withExpression('"copies" DESC NULLS FIRST'), def: 'CREATE INDEX ivx_book_copies_desc_ix ON ivx_book USING btree (copies DESC)' },
    { name: 'operator class', index: 'ivx_book_title_pattern_ix', indexes: b => b.hasIndex('ivx_book_title_pattern_ix', x => [x.title]).withOperatorClass('text_pattern_ops'), def: 'CREATE INDEX ivx_book_title_pattern_ix ON ivx_book USING btree (title text_pattern_ops)' },
    { name: 'partial (WHERE)', index: 'ivx_book_isbn_stocked_ix', indexes: b => b.hasIndex('ivx_book_isbn_stocked_ix', x => [x.isbn]).where('copies > 0'), def: 'CREATE INDEX ivx_book_isbn_stocked_ix ON ivx_book USING btree (isbn) WHERE copies > 0' },
    { name: 'expression', index: 'ivx_book_title_lower_ix', indexes: b => b.hasIndex('ivx_book_title_lower_ix').withExpression('lower("title")'), def: 'CREATE INDEX ivx_book_title_lower_ix ON ivx_book USING btree (lower(title))' },
    { name: 'hash method', index: 'ivx_book_isbn_hash_ix', indexes: b => b.hasIndex('ivx_book_isbn_hash_ix', x => [x.isbn]).using('hash'), def: 'CREATE INDEX ivx_book_isbn_hash_ix ON ivx_book USING hash (isbn)' },
    {
      name: 'GIN trigram',
      index: 'ivx_book_title_trgm_ix',
      indexes: b => b.hasIndex('ivx_book_title_trgm_ix', x => [x.title]).using('gin').withOperatorClass('gin_trgm_ops'),
      def: 'CREATE INDEX ivx_book_title_trgm_ix ON ivx_book USING gin (title gin_trgm_ops)',
      setup: 'CREATE EXTENSION IF NOT EXISTS pg_trgm',
    },
  ];

  describe('shapes made INVALID directly (UPDATE pg_index: the index stays ready — maintained on writes, unused for reads)', () => {
    for (const c of DIRECT) {
      test(c.name, async () => {
        if (c.setup) {
          const setupClient = createFreshClient();
          await setupClient.query(c.setup);
          await setupClient.end();
        }
        await withLibrary(c.indexes, async ({ client, db }) => {
          await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('222', 'Emma', NULL, 0, true)`);
          const before = await indexState(client, c.index);
          await invalidate(client, c.index);
          expect(await indexState(client, c.index)).toMatchObject({ valid: false, ready: true, def: c.def });

          expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', c.index]]);
          await db.getSchemaManager().migrate();

          const after = await indexState(client, c.index);
          expect(after).toMatchObject({ valid: true, ready: true, def: c.def });
          expect(after!.oid).not.toBe(before!.oid);
          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        });
      });
    }

    test('schema-qualified table', async () => {
      await withModel((client, logs) => archive(client, s => s.hasIndex('ivx_scroll_era_ix', x => [x.era]), logs), async ({ client, db }) => {
        await invalidate(client, 'ivx_scroll_era_ix', ARCHIVE);

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([expect.objectContaining({ type: 'repair_index', schema: ARCHIVE, indexName: 'ivx_scroll_era_ix' })]);
        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'ivx_scroll_era_ix', ARCHIVE)).toMatchObject({
          valid: true,
          def: 'CREATE INDEX ivx_scroll_era_ix ON ivx_archive.ivx_scroll USING btree (era)',
        });
      });
    });

    test('quoted, mixed-case names', async () => {
      await withModel((client, logs) => ledger(client, l => l.hasIndex('IvxLedger_Volume_IX', x => [x.volume]), logs), async ({ client, db }) => {
        await invalidate(client, 'IvxLedger_Volume_IX');

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'IvxLedger_Volume_IX']]);
        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'IvxLedger_Volume_IX')).toMatchObject({
          valid: true,
          def: 'CREATE INDEX "IvxLedger_Volume_IX" ON "IvxLedger" USING btree ("Volume")',
        });
      });
    });
  });

  describe('VALID indexes are never touched', () => {
    test('a table of valid indexes of many shapes: no index operation planned, no index DDL run', async () => {
      await withLibrary(b => {
        isbnUniqueConcurrent(b);
        b.hasIndex('ivx_book_shelf_copies_ix', x => [x.shelf, x.copies]);
        b.hasIndex('ivx_book_isbn_stocked_ix', x => [x.isbn]).where('copies > 0');
        b.hasIndex('ivx_book_title_lower_ix').withExpression('lower("title")');
        b.hasIndex('ivx_book_isbn_cover_ix', x => [x.isbn]).include(x => [x.title]);
        b.hasIndex('ivx_book_shelf_nnd_uq', x => [x.shelf]).isUnique().nullsNotDistinct();
      }, async ({ client, db, statements }) => {
        await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('222', 'Emma', 'A2', 1, false)`);

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        await db.getSchemaManager({ concurrentIndexes: true }).migrate();

        expect(indexDdl(statements)).toEqual([]);
      });
    });

    test('a valid index whose model spelling differs from the stored definition is left alone', async () => {
      await withLibrary(b => {
        b.hasIndex('ivx_book_title_lower_ix').withExpression('LOWER( "title" )');
        b.hasIndex('ivx_book_isbn_stocked_ix', x => [x.isbn]).where('copies>0');
        b.hasIndex('ivx_book_unshelved_ix', x => [x.isbn]).where('archived = false');
      }, async ({ client, db, statements }) => {
        const before = [await indexState(client, 'ivx_book_title_lower_ix'), await indexState(client, 'ivx_book_isbn_stocked_ix'), await indexState(client, 'ivx_book_unshelved_ix')];

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect([await indexState(client, 'ivx_book_title_lower_ix'), await indexState(client, 'ivx_book_isbn_stocked_ix'), await indexState(client, 'ivx_book_unshelved_ix')]).toEqual(before);
      });
    });

    test('one INVALID and one valid index on the same table: only the INVALID one is rebuilt', async () => {
      await withLibrary(b => {
        isbnUnique(b);
        b.hasIndex('ivx_book_title_ix', x => [x.title]);
      }, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const valid = await indexState(client, 'ivx_book_title_ix');
        statements.length = 0;

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements).filter(s => s.includes('ivx_book_title_ix'))).toEqual([]);
        expect(await indexState(client, 'ivx_book_title_ix')).toEqual(valid);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true });
      });
    });

    test('two INVALID indexes on the same table are both repaired, in model order, each by its own path', async () => {
      await withLibrary(b => {
        isbnUnique(b);
        // concurrent: see "expression index whose expression raised for a row"
        b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")').concurrent();
      }, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query('DROP INDEX ivx_book_ratio_ix');
        await insertBooks(client, `('333', 'Odyssey', 'C1', 0, false)`);
        await failBuild(client, `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`, '22012');
        await client.query(`DELETE FROM ${BOOK} WHERE title IN ('Emma', 'Odyssey')`);
        statements.length = 0;

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq'], ['repair_index', 'ivx_book_ratio_ix']]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([
          ...ISBN_UQ_REBUILT_BESIDE,
          'DROP INDEX CONCURRENTLY IF EXISTS "ivx_book_ratio_ix"',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ivx_book_ratio_ix" ON "ivx_book" ((100 / "copies"))',
        ]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true });
        expect(await indexState(client, 'ivx_book_ratio_ix')).toMatchObject({ valid: true });
      });
    });

    test('a model index missing from the database is still created with create_index (not a repair)', async () => {
      await withLibrary(b => {
        isbnUnique(b);
        b.hasIndex('ivx_book_title_ix', x => [x.title]);
      }, async ({ client, db }) => {
        await client.query('DROP INDEX ivx_book_title_ix');

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['create_index', 'ivx_book_title_ix']]);
        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'ivx_book_title_ix')).toMatchObject({ valid: true });
      });
    });
  });

  describe('an INVALID index the model does not declare follows the policy for unknown indexes', () => {
    test('it is left alone: no repair, no drop — it stays INVALID', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_title_ix', x => [x.title]), async ({ client, db, statements }) => {
        await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('111', 'Emma', 'A2', 1, false)`);
        await failBuild(client, `CREATE UNIQUE INDEX CONCURRENTLY ivx_book_stray_uq ON ${BOOK} (isbn)`);
        const stray = await indexState(client, 'ivx_book_stray_uq');
        statements.length = 0;

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect(stray).toMatchObject({ valid: false, ready: false });
        expect(await indexState(client, 'ivx_book_stray_uq')).toEqual(stray);
      });
    });

    test('a VALID index the model does not declare is left alone too', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_title_ix', x => [x.title]), async ({ client, db }) => {
        await client.query(`CREATE INDEX ivx_book_stray_ix ON ${BOOK} (shelf)`);
        const stray = await indexState(client, 'ivx_book_stray_ix');

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'ivx_book_stray_ix')).toEqual(stray);
      });
    });
  });

  describe('a repair that fails again raises an error naming the index and the cause', () => {
    const CONCURRENT_DUPLICATE = 'Could not repair INVALID index "ivx_book_isbn_uq" on "ivx_book": could not create unique index "ivx_book_isbn_uq" — Key (isbn)=(111) is duplicated. Fix the cause and run the migration again.';
    const BLOCKING_DUPLICATE = 'Could not repair INVALID index "ivx_book_isbn_uq" on "ivx_book": could not create unique index "ivx_book_isbn_uq_lkgnew" — Key (isbn)=(111) is duplicated. Fix the cause and run the migration again.';

    test('concurrent: IndexRepairError (23505, the duplicated key); PostgreSQL leaves the index INVALID again', async () => {
      await withLibrary(isbnUniqueConcurrent, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        statements.length = 0;

        const error = await expectToReject(db.getSchemaManager().migrate());

        expect(error).toBeInstanceOf(IndexRepairError);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(CONCURRENT_DUPLICATE);
        expect([error.name, error.indexName, error.tableName, error.schema, error.code]).toEqual(['IndexRepairError', 'ivx_book_isbn_uq', BOOK, undefined, '23505']);
        expect(sqlStateOf(error.cause)).toBe('23505');
        expect(error.failures).toEqual([{
          indexName: 'ivx_book_isbn_uq',
          tableName: BOOK,
          schema: undefined,
          code: '23505',
          cause: error.cause,
          reason: 'could not create unique index "ivx_book_isbn_uq" — Key (isbn)=(111) is duplicated.',
        }]);
        expect(indexDdl(statements)).toEqual([
          'DROP INDEX CONCURRENTLY IF EXISTS "ivx_book_isbn_uq"',
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ivx_book_isbn_uq" ON "ivx_book" ("isbn")',
        ]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false, ready: false });
      });
    });

    test('blocking: IndexRepairError; the build failed beside the INVALID index, which is as it was — the next run fails the same way', async () => {
      await withLibrary(isbnUnique, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        statements.length = 0;

        const first = await expectToReject(db.getSchemaManager().migrate());
        const after = await indexState(client, 'ivx_book_isbn_uq');
        const replanned = planned(await db.getSchemaManager().analyze());
        const second = await expectToReject(db.getSchemaManager().migrate());

        expect(first).toBeInstanceOf(IndexRepairError);
        expect(first.message).toBe(BLOCKING_DUPLICATE);
        expect(after).toEqual(before);
        expect(await indexState(client, 'ivx_book_isbn_uq_lkgnew')).toBeNull();
        expect(replanned).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
        expect(second).toBeInstanceOf(IndexRepairError);
        expect(second.message).toBe(BLOCKING_DUPLICATE);
        expect(indexDdl(statements)).toEqual([ISBN_UQ_REBUILT_BESIDE[0], ISBN_UQ_REBUILT_BESIDE[0]]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      });
    });

    test('an expression that still raises: IndexRepairError with 22012', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")').concurrent(), async ({ client, db }) => {
        await client.query('DROP INDEX ivx_book_ratio_ix');
        await insertBooks(client, `('111', 'Dune', 'A1', 0, false)`);
        await failBuild(client, `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`, '22012');

        const error = await expectToReject(db.getSchemaManager().migrate());

        expect(error).toBeInstanceOf(IndexRepairError);
        expect(error.message).toBe('Could not repair INVALID index "ivx_book_ratio_ix" on "ivx_book": division by zero. Fix the cause and run the migration again.');
        expect(error.code).toBe('22012');
      });
    });

    // PGlite has no second session to hold the older snapshot
    test.skipIf(process.env.LINKGRESS_TEST_DRIVER === 'pglite')('blocking: while an older snapshot still sees the replaced poison row, PostgreSQL\'s rebuild meets it again', async () => {
      await withLibrary(b => b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")'), async ({ client, db }) => {
        await client.query('DROP INDEX ivx_book_ratio_ix');
        await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('112', 'Emma', 'A2', 0, false)`);
        await failBuild(client, `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`, '22012');
        const reader = createFreshClient();
        let releaseReader!: () => void;
        const readerHolds = new Promise<void>(resolve => (releaseReader = resolve));
        let snapshotTaken!: () => void;
        const readerOpen = new Promise<void>(resolve => (snapshotTaken = resolve));
        // a REPEATABLE READ snapshot taken before the fix keeps the replaced row version "recently dead"; it reads
        // no table, so it holds no lock the rebuild's DROP INDEX would wait for
        const reading = reader.transaction(async query => {
          await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await query('SELECT 1');
          snapshotTaken();
          await readerHolds;
        });
        reading.catch(() => snapshotTaken());
        // never hold the snapshot past the test's own budget, whatever happens below
        const safety = setTimeout(releaseReader, 10000);
        try {
          await readerOpen;
          await client.query(`UPDATE ${BOOK} SET copies = 1 WHERE copies = 0`);
          expect((await client.query(`SELECT count(*)::int AS n FROM ${BOOK} WHERE copies = 0`)).rows).toEqual([{ n: 0 }]);

          if (SESSIONS_SEE_BUILDS) {
            const error = await expectToReject(db.getSchemaManager().migrate());

            expect(error).toBeInstanceOf(IndexRepairError);
            expect(error.message).toBe('Could not repair INVALID index "ivx_book_ratio_ix" on "ivx_book": division by zero. Fix the cause and run the migration again.');
            // the failed build ran beside it: the INVALID index is as it was, and no temporary one is left
            expect(await indexState(client, 'ivx_book_ratio_ix')).toMatchObject({ valid: false, ready: false });
            expect(await indexState(client, 'ivx_book_ratio_ix_lkgnew')).toBeNull();
          } else {
            // the in-memory engine builds over its own snapshot's rows only: the same repair succeeds
            await db.getSchemaManager().migrate();

            expect(await indexState(client, 'ivx_book_ratio_ix')).toMatchObject({ valid: true, ready: true, def: 'CREATE INDEX ivx_book_ratio_ix ON ivx_book USING btree ((100 / copies))' });
          }
        } finally {
          clearTimeout(safety);
          releaseReader();
          await reading.catch(() => undefined);
          await reader.end();
        }
      });
    });

    test('no loop: one build attempt — and the index created after it in the plan is created first', async () => {
      await withLibrary(b => {
        isbnUnique(b);
        b.hasIndex('ivx_book_title_ix', x => [x.title]);
      }, async ({ client, db, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query('DROP INDEX ivx_book_title_ix');
        statements.length = 0;

        const operations = await db.getSchemaManager().analyze();
        await expectToReject(db.getSchemaManager().migrate(), /Could not repair INVALID index "ivx_book_isbn_uq"/);

        expect(planned(operations)).toEqual([['repair_index', 'ivx_book_isbn_uq'], ['create_index', 'ivx_book_title_ix']]);
        expect(indexDdl(statements)).toEqual([
          'CREATE INDEX IF NOT EXISTS "ivx_book_title_ix" ON "ivx_book" ("title")',
          ISBN_UQ_REBUILT_BESIDE[0],
        ]);
        expect(await indexState(client, 'ivx_book_title_ix')).toMatchObject({ valid: true, ready: true });
      });
    });

    test('once the cause is fixed the next migrate() repairs it', async () => {
      await withLibrary(isbnUniqueConcurrent, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await expectToReject(db.getSchemaManager().migrate(), /^Could not repair INVALID index "ivx_book_isbn_uq" on "ivx_book": /);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);

        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
      });
    });

    test('a rebuild that leaves the index INVALID is an error, not a silent skip', async () => {
      // concurrent: a drop that removed nothing makes the CREATE … IF NOT EXISTS skip the INVALID index
      await withLibrary(isbnUniqueConcurrent, async ({ client, db }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);

        const error = await expectToReject(db.getSchemaManager().migrate());

        expect(error).toBeInstanceOf(IndexRepairError);
        expect(error.message).toBe('Could not repair INVALID index "ivx_book_isbn_uq" on "ivx_book": the index is still INVALID after the rebuild. Fix the cause and run the migration again.');
        expect([error.code, error.cause]).toEqual([undefined, undefined]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false });
      }, client => ignoreDropIndex(client, 'ivx_book_isbn_uq'));
    });
  });

  describe('an INVALID index whose table has an index build running is left alone', () => {
    test('no repair is planned, a warning names the index, migrate() leaves it in place', async () => {
      const table = { oid: '' };
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        table.oid = await oidOf(client, BOOK);
        statements.length = 0;

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        expect(warnings(logs)).toEqual([IN_PROGRESS_WARNING]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      }, client => injectBuilds(client, () => [buildOn(table.oid, '4243')]));
    });

    test('a build on the table leaves every INVALID index of that table alone — whichever index it builds', async () => {
      const table = { oid: '' };
      await withLibrary(b => {
        isbnUnique(b);
        // concurrent: see "expression index whose expression raised for a row"
        b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")').concurrent();
      }, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query('DROP INDEX ivx_book_ratio_ix');
        await insertBooks(client, `('333', 'Odyssey', 'C1', 0, false)`);
        await failBuild(client, `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`, '22012');
        await client.query(`DELETE FROM ${BOOK} WHERE title IN ('Emma', 'Odyssey')`);
        table.oid = await oidOf(client, BOOK);
        statements.length = 0;

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        expect(warnings(logs)).toEqual([
          IN_PROGRESS_WARNING,
          '  ⊘ INVALID index "ivx_book_ratio_ix" on "ivx_book" left alone: an index is being built on "ivx_book" (pg_stat_progress_create_index) — run the migration again once that build has finished.\n',
        ]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect([(await indexState(client, 'ivx_book_isbn_uq'))?.valid, (await indexState(client, 'ivx_book_ratio_ix'))?.valid]).toEqual([false, false]);
      }, client => injectBuilds(client, () => [buildOn(table.oid, '4243')]));
    });

    test('a build another session is running is left alone, until it has finished valid', async () => {
      // SESSIONS_SEE_BUILDS: a real CREATE INDEX CONCURRENTLY held in "waiting for writers before build" by a
      // writer's open transaction; elsewhere the read of running builds shows it
      const injected: InjectedBuilds = {};
      await withLibrary(isbnUnique, async ({ client, db, logs }) => {
        const build = SESSIONS_SEE_BUILDS ? await startWaitingBuild(client) : await injectBuild(client, injected, (table, index) => [buildOn(table, index)]);
        try {
          expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false, ready: false });

          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
          expect(warnings(logs)).toEqual([IN_PROGRESS_WARNING]);

          await build.finish();
          expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        } finally {
          await build.cleanup();
        }
      }, SESSIONS_SEE_BUILDS ? undefined : client => injectBuilds(client, () => injected.rows));
    });

    test('a REINDEX INDEX CONCURRENTLY of the INVALID index builds a new one on its table: left alone until it has finished', async () => {
      // SESSIONS_SEE_BUILDS: a real REINDEX … CONCURRENTLY held in "waiting for old snapshots" by a reader — its progress
      // row names the table and "ivx_book_isbn_uq_ccnew"; elsewhere the read of running builds shows exactly that
      const injected: InjectedBuilds = {};
      await withLibrary(isbnUnique, async ({ client, db, logs }) => {
        const build = SESSIONS_SEE_BUILDS
          ? await startReindex(client)
          : await injectBuild(client, injected, table => [{ pid: 4242, relid: table, index_relid: '4243', locked_relations: [table] }]);
        try {
          expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false });

          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
          expect(warnings(logs)).toEqual([IN_PROGRESS_WARNING]);

          await build.finish();
          expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
          expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        } finally {
          await build.cleanup();
        }
      }, SESSIONS_SEE_BUILDS ? undefined : client => injectBuilds(client, () => injected.rows));
    });

    test('a build whose progress row hides its table (another role\'s) is found through the locks its backend holds', async () => {
      const table = { oid: '' };
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        table.oid = await oidOf(client, BOOK);
        statements.length = 0;

        expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
        expect(warnings(logs)).toEqual([IN_PROGRESS_WARNING]);
        await db.getSchemaManager().migrate();

        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      }, client => injectBuilds(client, () => [{ pid: 4242, relid: null, index_relid: null, locked_relations: [table.oid] }]));
    });

    test('builds on other tables — seen, or hidden and locking another table — do not hold the repair back', async () => {
      const other = { oid: '' };
      await withLibrary(isbnUnique, async ({ client, db, logs }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        other.oid = await oidOf(client, 'ivx_book_pkey');

        expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
        expect(warnings(logs)).toEqual([]);
        await db.getSchemaManager().migrate();

        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
      }, client => injectBuilds(client, () => [
        { pid: 4242, relid: other.oid, index_relid: '4243', locked_relations: [other.oid] },
        { pid: 4244, relid: null, index_relid: null, locked_relations: [other.oid] },
      ]));
    });
  });

  describe('the repair re-reads the index right before it rebuilds it', () => {
    const NO_LONGER_INVALID = '  ⊘ Index "ivx_book_isbn_uq" on "ivx_book" is no longer INVALID (rebuilt or validated since the migration was planned): left alone.\n';

    test('rebuilt by hand after the plan: left alone, with a warning — the manual build survives', async () => {
      let manual: IndexState | null = null;
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(logs.map(l => l.message)).toContain(ISBN_UQ_PLAN_BLOCKING);
        expect(warnings(logs)).toEqual([NO_LONGER_INVALID]);
        expect(indexDdl(statements)).toEqual([]);
        expect(manual).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(manual);
      }, client => afterPlanRead(client, async () => {
        await onAnotherClient('DROP INDEX ivx_book_isbn_uq', `CREATE UNIQUE INDEX ivx_book_isbn_uq ON ${BOOK} (isbn)`);
        const other = createFreshClient();
        manual = await indexState(other, 'ivx_book_isbn_uq');
        await other.end();
      }));
    });

    test('flagged valid after the plan (UPDATE pg_index): left alone, with a warning', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await insertBooks(client, `('111', 'Dune', 'A1', 2, false)`);
        // INVALID and not ready — enforcing nothing, so the plan repairs it
        await client.query(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = to_regclass('ivx_book_isbn_uq')`);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(before).toMatchObject({ valid: false, ready: false });
        expect(warnings(logs)).toEqual([NO_LONGER_INVALID]);
        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual({ ...before!, valid: true, ready: true });
      }, client => afterPlanRead(client, () =>
        onAnotherClient(`UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = to_regclass('ivx_book_isbn_uq')`)));
    });

    test('an index build started on the table since the plan: left alone, with a warning', async () => {
      const table = { oid: '' };
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const before = await indexState(client, 'ivx_book_isbn_uq');
        table.oid = await oidOf(client, BOOK);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(warnings(logs)).toEqual([IN_PROGRESS_WARNING]);
        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      }, client => injectBuilds(client, read => (read === 2 ? [buildOn(table.oid, '4243')] : undefined)));
    });

    test('made a ready unique index since the plan: left alone, as analyze() would have', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(warnings(logs)).toEqual([READY_UNIQUE_WARNING]);
        expect(indexDdl(statements)).toEqual([]);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: false, ready: true });
      }, client => afterPlanRead(client, () =>
        onAnotherClient(`UPDATE pg_index SET indisready = true WHERE indexrelid = to_regclass('ivx_book_isbn_uq')`)));
    });

    test('dropped since the plan: the repair creates it', async () => {
      await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        statements.length = 0;

        await db.getSchemaManager().migrate();

        expect(warnings(logs)).toEqual([BLOCKING_WARNING]);
        expect(indexDdl(statements)).toEqual(['CREATE UNIQUE INDEX IF NOT EXISTS "ivx_book_isbn_uq" ON "ivx_book" ("isbn")']);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
      }, client => afterPlanRead(client, () => onAnotherClient('DROP INDEX ivx_book_isbn_uq')));
    });
  });

  describe('MigrationScaffold renders a repair that is safe on every database the file runs on', () => {
    const repairOperation = (schema?: string, concurrent?: boolean): MigrationOperation => ({
      type: 'repair_index',
      tableName: schema ? SCROLL : BOOK,
      schema,
      indexName: schema ? 'ivx_scroll_catalog_uq' : 'ivx_book_isbn_uq',
      columns: [schema ? 'catalog_no' : 'isbn'],
      isUnique: true,
      concurrent,
      previousDef: schema ? 'CREATE UNIQUE INDEX ivx_scroll_catalog_uq ON ivx_archive.ivx_scroll USING btree (catalog_no)' : ISBN_UQ_DEF,
    });
    /** The scaffold's guarded drop: only an INVALID plain index the schema manager would repair — see analyze(). */
    const guardedDrop = (literal: string, qualified: string) =>
      `DO $lkg$ BEGIN IF EXISTS (SELECT 1 FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid WHERE x.indexrelid = to_regclass('${literal}') AND NOT x.indisvalid AND c.relkind = 'i' AND NOT (x.indisunique AND x.indisready) AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid) AND NOT EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.datid = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AND (p.index_relid = x.indexrelid OR p.relid = x.indrelid OR (p.relid IS NULL AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = p.pid AND l.locktype = 'relation' AND l.database = p.datid AND l.relation = x.indrelid))))) THEN DROP INDEX ${qualified}; END IF; END $lkg$`;

    test('up: a DROP guarded to an INVALID index it would repair, then a plain CREATE … IF NOT EXISTS; down: nothing to revert', async () => {
      await withLibrary(isbnUnique, async ({ db }) => {
        const scaffold = new MigrationScaffold(db, { migrationsDirectory: os.tmpdir() }) as any;

        expect(scaffold.generateUpSql(repairOperation())).toEqual([
          guardedDrop('"ivx_book_isbn_uq"', '"ivx_book_isbn_uq"'),
          'CREATE UNIQUE INDEX IF NOT EXISTS "ivx_book_isbn_uq" ON "ivx_book" ("isbn")',
        ]);
        expect(scaffold.generateUpSql(repairOperation(ARCHIVE))).toEqual([
          guardedDrop('"ivx_archive"."ivx_scroll_catalog_uq"', '"ivx_archive"."ivx_scroll_catalog_uq"'),
          'CREATE UNIQUE INDEX IF NOT EXISTS "ivx_scroll_catalog_uq" ON "ivx_archive"."ivx_scroll" ("catalog_no")',
        ]);
        // the file runs in one transaction (MigrationRunner): never CONCURRENTLY, even for a .concurrent() index
        expect(scaffold.generateUpSql(repairOperation(undefined, true))).toEqual(scaffold.generateUpSql(repairOperation()));
        expect(scaffold.generateDownSql(repairOperation())).toEqual(['-- Nothing to revert: INVALID index "ivx_book_isbn_uq" was rebuilt from the model']);
      });
    });

    test('run in one transaction, as MigrationRunner runs a file: rebuilds an INVALID index, creates a missing one, leaves a valid one alone', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        // a .concurrent() index: its scaffolded repair must still run inside the file's transaction
        const up: string[] = (new MigrationScaffold(db, { migrationsDirectory: os.tmpdir() }) as any).generateUpSql(repairOperation(undefined, true));
        const runUp = () => client.transaction(async query => {
          for (const statement of up) {
            await query(statement);
          }
        });

        const valid = await indexState(client, 'ivx_book_isbn_uq');
        await runUp();
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(valid);

        await leaveIsbnIndexInvalid(client);
        await client.query(`DELETE FROM ${BOOK} WHERE title = 'Emma'`);
        const invalid = await indexState(client, 'ivx_book_isbn_uq');
        await runUp();
        const rebuilt = await indexState(client, 'ivx_book_isbn_uq');
        expect(invalid).toMatchObject({ valid: false });
        expect(rebuilt).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
        expect(rebuilt!.oid).not.toBe(invalid!.oid);

        await client.query('DROP INDEX ivx_book_isbn_uq');
        await runUp();
        expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, def: ISBN_UQ_DEF });
      });
    });

    test('in one transaction, a rebuild that fails rolls the drop back: the INVALID index is as it was', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        const up: string[] = (new MigrationScaffold(db, { migrationsDirectory: os.tmpdir() }) as any).generateUpSql(repairOperation());
        await leaveIsbnIndexInvalid(client);
        const invalid = await indexState(client, 'ivx_book_isbn_uq');

        const error = await expectToReject(client.transaction(async query => {
          for (const statement of up) {
            await query(statement);
          }
        }));

        expect([sqlStateOf(error), error.message]).toEqual(['23505', 'could not create unique index "ivx_book_isbn_uq"']);
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(invalid);
      });
    });

    test('the guard leaves alone what the schema manager leaves alone: an INVALID unique index that is still ready', async () => {
      await withLibrary(isbnUnique, async ({ client, db }) => {
        const up: string[] = (new MigrationScaffold(db, { migrationsDirectory: os.tmpdir() }) as any).generateUpSql(repairOperation());
        await insertBooks(client, `('111', 'Dune', 'A1', 2, false)`);
        await invalidate(client, 'ivx_book_isbn_uq');
        const ready = await indexState(client, 'ivx_book_isbn_uq');

        await client.transaction(async query => {
          for (const statement of up) {
            await query(statement);
          }
        });

        expect(ready).toMatchObject({ valid: false, ready: true });
        expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(ready);
      });
    });
  });
});

describe('a failing repair never leaves the migration half done', () => {
  const BLOCKING_DUPLICATE = 'Could not repair INVALID index "ivx_book_isbn_uq" on "ivx_book": could not create unique index "ivx_book_isbn_uq_lkgnew" — Key (isbn)=(111) is duplicated. Fix the cause and run the migration again.';

  test('a view, a changed column, a new index and a repair that fails: all but the repair is done, the hook runs, then ONE IndexRepairError — and the next run fails the same way', async () => {
    const client = createFreshClient();
    const logs: Logged[] = [];
    const hookRuns: string[] = [];
    const before = catalogue(client, logs, { copiesRequired: false, copiesIndexed: false }, []);
    const after = catalogue(client, logs, { copiesRequired: true, copiesIndexed: true }, hookRuns);
    try {
      await dropAll(client);
      await before.getSchemaManager().ensureCreated();
      await leaveIsbnIndexInvalid(client);
      const invalid = await indexState(client, 'ivx_book_isbn_uq');
      logs.length = 0;

      const first = await expectToReject(after.getSchemaManager().migrate());
      const listed = logs.map(l => l.message).filter(m => /^\d+\. /.test(m));
      const counts = (await client.query(`SELECT count(*)::int AS n FROM ${BOOK_COUNTS}`)).rows;
      const copies = (await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = '${BOOK}' AND column_name = 'copies'`)).rows;
      const copiesIndex = await indexState(client, 'ivx_book_copies_ix');
      const second = await expectToReject(after.getSchemaManager().migrate());

      expect(listed).toEqual([
        `1. Drop view "${BOOK_COUNTS}" (re-created from the model)`,
        `2. Alter column "${BOOK}"."copies"`,
        `3. Create index "ivx_book_copies_ix" on "${BOOK}" (copies)`,
        `4. Create view "${BOOK_COUNTS}"`,
        ISBN_UQ_PLAN_BLOCKING.replace(/^1\./, '5.'),
      ]);
      expect(first).toBeInstanceOf(IndexRepairError);
      expect(first.message).toBe(BLOCKING_DUPLICATE);
      expect(counts).toEqual([{ n: 3 }]);
      expect(copies).toEqual([{ is_nullable: 'NO' }]);
      expect(copiesIndex).toMatchObject({ valid: true, ready: true });
      expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(invalid);
      expect(second).toBeInstanceOf(IndexRepairError);
      expect(second.message).toBe(BLOCKING_DUPLICATE);
      expect(hookRuns).toEqual(['onMigrationComplete', 'onMigrationComplete']);
    } finally {
      await dropAll(client);
      await client.end();
    }
  });

  test('several repairs that fail: each is tried, and ONE IndexRepairError names them all', async () => {
    await withLibrary(b => {
      isbnUnique(b);
      b.hasIndex('ivx_book_ratio_ix').withExpression('(100 / "copies")');
    }, async ({ client, db, statements }) => {
      await leaveIsbnIndexInvalid(client);
      await client.query('DROP INDEX ivx_book_ratio_ix');
      await insertBooks(client, `('333', 'Odyssey', 'C1', 0, false)`);
      await failBuild(client, `CREATE INDEX CONCURRENTLY ivx_book_ratio_ix ON ${BOOK} ((100 / copies))`, '22012');
      statements.length = 0;

      const error = await expectToReject(db.getSchemaManager().migrate());

      expect(error).toBeInstanceOf(IndexRepairError);
      expect(error.message).toBe(
        'Could not repair 2 INVALID indexes: "ivx_book_isbn_uq" on "ivx_book": could not create unique index "ivx_book_isbn_uq_lkgnew" — Key (isbn)=(111) is duplicated; '
        + '"ivx_book_ratio_ix" on "ivx_book": division by zero. Fix the causes and run the migration again.'
      );
      expect(error.failures.map((f: { indexName: string; code?: string }) => [f.indexName, f.code])).toEqual([['ivx_book_isbn_uq', '23505'], ['ivx_book_ratio_ix', '22012']]);
      expect([error.indexName, error.code]).toEqual(['ivx_book_isbn_uq', '23505']);
      expect(indexDdl(statements)).toEqual([
        ISBN_UQ_REBUILT_BESIDE[0],
        'CREATE INDEX "ivx_book_ratio_ix_lkgnew" ON "ivx_book" ((100 / "copies"))',
      ]);
      expect([(await indexState(client, 'ivx_book_isbn_uq'))?.valid, (await indexState(client, 'ivx_book_ratio_ix'))?.valid]).toEqual([false, false]);
    });
  });
});

describe('an INVALID partitioned index is never repaired: PostgreSQL\'s online procedure leaves it INVALID until it is attached everywhere', () => {
  test('mid-attach (one of two partitions has its index attached): nothing is planned, the warning names the partition still without one', async () => {
    await withModel((client, logs) => racks(client, logs), async ({ client, db, logs, statements }) => {
      await client.query(`CREATE TABLE ${RACK}_1 PARTITION OF ${RACK} FOR VALUES FROM (0) TO (10)`);
      await client.query(`CREATE TABLE ${RACK}_2 PARTITION OF ${RACK} FOR VALUES FROM (10) TO (20)`);
      await client.query(`INSERT INTO ${RACK} VALUES (1, 1, 'oak'), (2, 12, 'pine')`);
      // the online procedure: the partitioned index ON ONLY, each partition's index CONCURRENTLY, attached one by one
      await client.query('DROP INDEX ivx_rack_label_ix');
      await client.query(`CREATE INDEX ivx_rack_label_ix ON ONLY ${RACK} (label)`);
      await client.query(`CREATE INDEX CONCURRENTLY ivx_rack_1_label_ix ON ${RACK}_1 (label)`);
      await client.query('ALTER INDEX ivx_rack_label_ix ATTACH PARTITION ivx_rack_1_label_ix');
      const midway = await indexState(client, 'ivx_rack_label_ix');
      statements.length = 0;

      expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      expect(warnings(logs)).toEqual([
        '  ⊘ INVALID partitioned index "ivx_rack_label_ix" on "ivx_rack" left alone: the migration never rebuilds a partitioned index — it turns valid once every partition has an attached valid index (partitions without one: "ivx_rack_2"); create those CONCURRENTLY and attach them with ALTER INDEX "ivx_rack_label_ix" ATTACH PARTITION.\n',
      ]);
      await db.getSchemaManager({ concurrentIndexes: true }).migrate();

      expect(midway).toMatchObject({ valid: false, ready: true });
      expect(indexDdl(statements)).toEqual([]);
      expect(await indexState(client, 'ivx_rack_label_ix')).toEqual(midway);
      expect(await indexState(client, 'ivx_rack_1_label_ix')).toMatchObject({ valid: true });
    });
  });

  test('once the last partition\'s index is attached it is valid, and nothing is planned', async () => {
    await withModel((client, logs) => racks(client, logs), async ({ client, db, logs }) => {
      await client.query(`CREATE TABLE ${RACK}_1 PARTITION OF ${RACK} FOR VALUES FROM (0) TO (10)`);
      await client.query('DROP INDEX ivx_rack_label_ix');
      await client.query(`CREATE INDEX ivx_rack_label_ix ON ONLY ${RACK} (label)`);
      await client.query(`CREATE INDEX ivx_rack_1_label_ix ON ${RACK}_1 (label)`);

      await client.query('ALTER INDEX ivx_rack_label_ix ATTACH PARTITION ivx_rack_1_label_ix');

      expect(await indexState(client, 'ivx_rack_label_ix')).toMatchObject({ valid: true, ready: true });
      expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      expect(warnings(logs)).toEqual([]);
    });
  });
});

describe('an INVALID unique index that is still ready is left alone: it keeps rejecting duplicates', () => {
  test('nothing is planned, a warning names it and the remedy, and a duplicate is still rejected afterwards', async () => {
    await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
      await insertBooks(client, `('111', 'Dune', 'A1', 2, false)`);
      await invalidate(client, 'ivx_book_isbn_uq');
      const before = await indexState(client, 'ivx_book_isbn_uq');
      statements.length = 0;

      expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      expect(warnings(logs)).toEqual([READY_UNIQUE_WARNING]);
      await db.getSchemaManager().migrate();

      expect(before).toMatchObject({ valid: false, ready: true });
      expect(indexDdl(statements)).toEqual([]);
      expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
      const duplicate = await expectToReject(insertBooks(client, `('111', 'Emma', 'A2', 1, false)`));
      expect([sqlStateOf(duplicate), duplicate.message]).toEqual(['23505', 'duplicate key value violates unique constraint "ivx_book_isbn_uq"']);
    });
  });

  test('… also when the model changed its definition: it is still left alone', async () => {
    await withLibrary(b => b.hasIndex('ivx_book_isbn_uq', x => [x.isbn, x.shelf]).isUnique(), async ({ client, db, logs }) => {
      await client.query('DROP INDEX ivx_book_isbn_uq');
      await client.query(`CREATE UNIQUE INDEX ivx_book_isbn_uq ON ${BOOK} (isbn)`);
      await invalidate(client, 'ivx_book_isbn_uq');

      expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      expect(warnings(logs)).toEqual([READY_UNIQUE_WARNING]);
    });
  });

  test('a unique index that is not ready enforces nothing: it is repaired', async () => {
    await withLibrary(isbnUnique, async ({ client, db, logs }) => {
      await client.query(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = to_regclass('ivx_book_isbn_uq')`);

      expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_isbn_uq']]);
      await db.getSchemaManager().migrate();

      expect(warnings(logs)).toEqual([BLOCKING_WARNING]);
      expect(await indexState(client, 'ivx_book_isbn_uq')).toMatchObject({ valid: true, ready: true, def: ISBN_UQ_DEF });
    });
  });

  test('a non-unique index that is still ready is repaired: an INVALID index serves no read, so dropping it loses nothing', async () => {
    await withLibrary(b => b.hasIndex('ivx_book_title_ix', x => [x.title]), async ({ client, db }) => {
      await invalidate(client, 'ivx_book_title_ix');

      expect(planned(await db.getSchemaManager().analyze())).toEqual([['repair_index', 'ivx_book_title_ix']]);
      await db.getSchemaManager().migrate();

      expect(await indexState(client, 'ivx_book_title_ix')).toMatchObject({ valid: true, ready: true });
    });
  });
});

describe('an INVALID index a constraint requires is left alone: PostgreSQL does not drop it', () => {
  test('nothing is planned; a warning names the constraint and the remedy', async () => {
    await withLibrary(isbnUnique, async ({ client, db, logs, statements }) => {
      await client.query('DROP INDEX ivx_book_isbn_uq');
      await client.query(`ALTER TABLE ${BOOK} ADD CONSTRAINT ivx_book_isbn_uq UNIQUE (isbn)`);
      await client.query(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = to_regclass('ivx_book_isbn_uq')`);
      const before = await indexState(client, 'ivx_book_isbn_uq');
      statements.length = 0;

      expect(indexOperations(await db.getSchemaManager().analyze())).toEqual([]);
      expect(warnings(logs)).toEqual([
        '  ⊘ INVALID index "ivx_book_isbn_uq" on "ivx_book" left alone: constraint "ivx_book_isbn_uq" on "ivx_book" requires it, so it cannot be dropped — rebuild it in place with REINDEX INDEX CONCURRENTLY "ivx_book_isbn_uq".\n',
      ]);
      await db.getSchemaManager().migrate();

      expect(before).toMatchObject({ valid: false, ready: false });
      expect(indexDdl(statements)).toEqual([]);
      expect(await indexState(client, 'ivx_book_isbn_uq')).toEqual(before);
    });
  });

  test('the database\'s HINT is part of a repair error: a model expression naming a missing function', async () => {
    await withLibrary(b => b.hasIndex('ivx_book_fn_ix', x => [x.title]), async ({ client }) => {
      await invalidate(client, 'ivx_book_fn_ix');
      const before = await indexState(client, 'ivx_book_fn_ix');
      const broken = library(client, b => b.hasIndex('ivx_book_fn_ix').withExpression('no_such_fn("title")'), []);

      const error = await expectToReject(broken.getSchemaManager().migrate());

      expect(error).toBeInstanceOf(IndexRepairError);
      expect(error.message).toBe('Could not repair INVALID index "ivx_book_fn_ix" on "ivx_book": function no_such_fn(text) does not exist — No function matches the given name and argument types. You might need to add explicit type casts. Fix the cause and run the migration again.');
      expect(error.code).toBe('42883');
      expect(await indexState(client, 'ivx_book_fn_ix')).toEqual(before);
    });
  });
});

describe('the model index is validated before anything is dropped', () => {
  const INCLUDE_ON_GIN = 'Index "ivx_book_title_ix" cannot use INCLUDE with USING gin: PostgreSQL stores INCLUDE columns only in btree, gist, spgist indexes. Drop .include() or pick one of those methods.';

  test('repair: an invalid model index (INCLUDE on a GIN index) fails the repair; the INVALID index stays', async () => {
    await withLibrary(b => b.hasIndex('ivx_book_title_ix', x => [x.title]), async ({ client, statements }) => {
      await invalidate(client, 'ivx_book_title_ix');
      const before = await indexState(client, 'ivx_book_title_ix');
      const invalidSpec = library(client, b => b.hasIndex('ivx_book_title_ix', x => [x.title]).using('gin').include(x => [x.copies]), []);
      statements.length = 0;

      const error = await expectToReject(invalidSpec.getSchemaManager().migrate());

      expect(error).toBeInstanceOf(IndexRepairError);
      expect(error.message).toBe(`Could not repair INVALID index "ivx_book_title_ix" on "ivx_book": ${INCLUDE_ON_GIN} Fix the cause and run the migration again.`);
      expect(error.code).toBeUndefined();
      expect(indexDdl(statements)).toEqual([]);
      expect(await indexState(client, 'ivx_book_title_ix')).toEqual(before);
    });
  });

  test('recreate: an invalid changed definition throws before the drop; the index stays', async () => {
    await withLibrary(b => b.hasIndex('ivx_book_title_ix', x => [x.title]), async ({ client, db, statements }) => {
      const before = await indexState(client, 'ivx_book_title_ix');
      statements.length = 0;

      const error = await expectToReject((db.getSchemaManager() as any).executeOperation({
        type: 'recreate_index',
        tableName: BOOK,
        indexName: 'ivx_book_title_ix',
        columns: ['title'],
        using: 'gin',
        include: ['copies'],
        reason: 'method btree → gin',
      }));

      expect(error.message).toBe(INCLUDE_ON_GIN);
      expect(indexDdl(statements)).toEqual([]);
      expect(await indexState(client, 'ivx_book_title_ix')).toEqual(before);
    });
  });
});

describe('a full-text model index', () => {
  test('.concurrent() GIN over to_tsvector on a populated table: migrate() creates it valid, and plans nothing after', async () => {
    await withLibrary(isbnUnique, async ({ client }) => {
      await insertBooks(client, `('111', 'Dune', 'A1', 2, false), ('222', 'Emma', 'A2', 1, false)`);
      const fullText = library(client, b => {
        isbnUnique(b);
        b.hasIndex('ivx_book_title_fts_ix').withExpression(`to_tsvector('english', "title")`).using('gin').concurrent();
      }, []);

      await fullText.getSchemaManager().migrate();

      expect(await indexState(client, 'ivx_book_title_fts_ix')).toMatchObject({ valid: true, ready: true });
      expect(indexOperations(await fullText.getSchemaManager().analyze())).toEqual([]);
    });
  });
});
