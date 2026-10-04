import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  afterMutation, and, boolean as pgBoolean, BunClient, createCustomType, DatabaseClient, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable,
  DbModelConfig, eq, eqAny, exists, fromRows, integer, jsonbArrayElements, jsonbEachText, literal, notExists, PgClient, PostgresClient, serial,
  smallint, sql, text, timestamp, unnest, unnestRows, unnestZip,
} from '../../src';
import type {
  ClientQueryResult, CteRootQueryBuilder, DbCte, DbViewTable, PooledConnection, QueryExecutionOptions, SetQueryBuilder, UnionQueryBuilder,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import type { Equals } from '../utils/type-tester';

/**
 * The query roots of a context — `selectFromCte(cte)`, `selectFromSet(set)` — on a TABLE: `table.selectFromCte(cte)` /
 * `table.selectFromSet(set)` run on the table's OWN context (its client, its executor, its transaction), and
 * `table.isInTransaction()` / `table.getClient()` say which. A helper that is handed a table — the root's or a
 * transaction's — can build data-modifying CTEs on it AND execute and read them back in ONE statement inside the
 * caller's transaction; rooted on the root context instead, the whole statement ran on another connection, outside
 * the transaction: it could not see the transaction's own uncommitted rows (an FK to a parent the transaction just
 * inserted failed with 23503) and, on a pool of one, waited for a second connection forever.
 *
 * The matrix: table kinds (an entity table; the tables `.withTimeout()`, `.withQueryOptions()`,
 * `.withPreparedStatements()`, `.expectedExecutionTime()` derive; a view) × context kinds (the root, a transaction) ×
 * source shapes (a plain CTE — aliased, joined —, the close leg of a versioned-row fold (UPDATE … RETURNING), its open
 * leg (INSERT … SELECT … RETURNING ordered by `afterMutation`), the typed UNION ALL readback of both — opened first and
 * closed first —, a set of every producer (unnest, unnestZip, unnestRows, jsonb_array_elements, jsonb_each_text), a set
 * correlated to the table, a set leg first in a union) × 0 / 1 / n rows × readers (toList, first, count, a builder
 * timeout). The ORACLE: the same query rooted on the context the table belongs to — the same statements (text and
 * parameters) on the same channel (the transaction's or the root's), the same rows, the same state afterwards; plus
 * the row count the scenario implies, so neither side can be empty by accident. A derived table's executor is
 * observed where it shows: its timeout and prepared-statement flag on the client call, its logger, its expected time.
 *
 * Domain: a marina — piers, and the moorings of vessels at them, versioned (one current mooring per pier).
 */

type Hull = 'sail' | 'motor';

const hullMapper = createCustomType<{ data: Hull; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Hull | null | undefined) => (value == null ? null : value === 'motor' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'motor' : 'sail'),
});

class TrqPier extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class TrqMooring extends DbEntity {
  id!: DbColumn<number>;
  pierId!: DbColumn<number>;
  vesselId!: DbColumn<number>;
  fee!: DbColumn<number>;
  code!: DbColumn<string>;
  hull!: DbColumn<Hull>;
  validFrom!: DbColumn<Date>;
  validTo?: DbColumn<Date | null>;
  isCurrent!: DbColumn<boolean>;
  pier?: TrqPier;
}

/** The view of the current moorings */
class TrqBerth extends DbEntity {
  pierId!: DbColumn<number>;
  vesselId!: DbColumn<number>;
  fee!: DbColumn<number>;
  code!: DbColumn<string>;
  hull!: DbColumn<Hull>;
}

class MarinaDatabase extends DbContext {
  get piers(): DbEntityTable<TrqPier> {
    return this.table(TrqPier);
  }

  get moorings(): DbEntityTable<TrqMooring> {
    return this.table(TrqMooring);
  }

  get berths(): DbViewTable<TrqBerth> {
    return this.view(TrqBerth);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(TrqPier, entity => {
      entity.toTable('trq_piers');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
    });

    model.entity(TrqMooring, entity => {
      entity.toTable('trq_moorings');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.pierId).hasType(integer('pier_id')).isRequired();
      entity.property(e => e.vesselId).hasType(integer('vessel_id')).isRequired();
      entity.property(e => e.fee).hasType(integer('fee')).isRequired();
      entity.property(e => e.code).hasType(text('code')).isRequired();
      entity.property(e => e.hull).hasType(smallint('hull')).isRequired().hasCustomMapper(hullMapper);
      entity.property(e => e.validFrom).hasType(timestamp('valid_from')).isRequired();
      entity.property(e => e.validTo).hasType(timestamp('valid_to'));
      entity.property(e => e.isCurrent).hasType(pgBoolean('is_current')).isRequired();
      entity.hasOne(e => e.pier, () => TrqPier).withForeignKey(m => m.pierId).withPrincipalKey(p => p.id);
      // one CURRENT mooring per pier
      entity.hasIndex('ux_trq_moorings_pier_current', e => [e.pierId]).isUnique().where('is_current = true');
    });

    model.view(TrqBerth, view => {
      view.toView('trq_berths');
      view.definedAs('SELECT pier_id, vessel_id, fee, code, hull FROM trq_moorings WHERE is_current');
      view.property(e => e.pierId).hasType(integer('pier_id'));
      view.property(e => e.vesselId).hasType(integer('vessel_id'));
      view.property(e => e.fee).hasType(integer('fee'));
      view.property(e => e.code).hasType(text('code'));
      view.property(e => e.hull).hasType(smallint('hull')).hasCustomMapper(hullMapper);
    });
  }
}

const ENGINE = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory' ? 'memory' : process.env.LINKGRESS_TEST_DRIVER === 'pglite' ? 'pglite' : 'postgres';
const PGLITE_SINGLE_SESSION = 'PGlite has a single session';

type Route = { via: 'root' | 'transaction'; sql: string; params?: unknown[]; options?: QueryExecutionOptions };

/** Records which path each statement took — the client's own `query()` or a transaction's query function — and with which options. */
class RoutingClient extends DatabaseClient {
  readonly routes: Route[] = [];

  constructor(readonly inner: DatabaseClient) {
    super();
  }

  query<T = any>(text: string, params?: any[], options?: QueryExecutionOptions): Promise<ClientQueryResult<T>> {
    this.routes.push({ via: 'root', sql: text, params, options });
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
      this.routes.push({ via: 'transaction', sql: text, params, options });
      return query(text, params, options);
    }));
  }

  supportsMultiStatementQueries(): boolean {
    return this.inner.supportsMultiStatementQueries();
  }

  supportsBinaryProtocol(): boolean {
    return this.inner.supportsBinaryProtocol();
  }

  supportsBinaryArrayResults(): boolean {
    return this.inner.supportsBinaryArrayResults();
  }

  losesNumericZeroScale(): boolean {
    return this.inner.losesNumericZeroScale();
  }

  maxParameters(): number {
    return this.inner.maxParameters();
  }

  parseTypedText(oid: number, value: string, read?: any): unknown {
    return this.inner.parseTypedText(oid, value, read);
  }

  typedTextParser(oid: number, read?: any): (value: string) => unknown {
    return this.inner.typedTextParser(oid, read);
  }

  customParsedTypeOids(): readonly number[] {
    return this.inner.customParsedTypeOids();
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

const PENDING = Symbol('pending');

/** What `work` settled with within `ms` — its value, the error it rejected with, or PENDING. */
const settleWithin = async (work: PromiseLike<unknown>, ms: number): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise(resolve => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });

  try {
    return await Promise.race([Promise.resolve(work).then(value => value, error => error), pending]);
  } finally {
    clearTimeout(timer);
  }
};

const HISTORY_FROM = new Date(2020, 0, 1);
const HISTORY_TO = new Date(2021, 0, 1);
const CLOSED_AT = new Date(2026, 4, 1, 12, 0, 0);
const OPENED_AT = new Date(2026, 4, 1, 12, 0, 0);

const PIERS = [1, 2, 3, 4, 5].map(id => ({ id, name: `pier-${id}` }));

/** Pier 1 has a past mooring and a current one, piers 2 and 3 a current one, piers 4 and 5 none */
const MOORINGS = [
  { pierId: 1, vesselId: 9, fee: 90, code: '0009', hull: 'sail' as Hull, validFrom: HISTORY_FROM, validTo: HISTORY_TO, isCurrent: false },
  { pierId: 1, vesselId: 10, fee: 100, code: '0042', hull: 'sail' as Hull, validFrom: HISTORY_FROM, validTo: null, isCurrent: true },
  { pierId: 2, vesselId: 20, fee: 200, code: '0007', hull: 'motor' as Hull, validFrom: HISTORY_FROM, validTo: null, isCurrent: true },
  { pierId: 3, vesselId: 30, fee: 300, code: 'x30', hull: 'sail' as Hull, validFrom: HISTORY_FROM, validTo: null, isCurrent: true },
];

interface Change {
  pierId: number;
  vesselId: number;
  fee: number;
  code: string;
  hull: Hull;
}

const CHANGE_COLUMNS = ['pierId', 'vesselId', 'fee', 'code', 'hull'] as const;

type Rows = 0 | 1 | 'n';
const ROWS: Rows[] = [0, 1, 'n'];

/**
 * The fold of each size: the piers in scope, and the moorings they should have. 'n': a move (pier 1), a new version
 * of the SAME key (pier 2, vessel 20, a new fee), a removal (pier 3), a fresh pier (4).
 */
const FOLDS: Record<string, { scope: number[]; desired: Change[] }> = {
  0: { scope: [], desired: [] },
  1: { scope: [1], desired: [{ pierId: 1, vesselId: 11, fee: 110, code: '0011', hull: 'motor' }] },
  n: {
    scope: [1, 2, 3, 4],
    desired: [
      { pierId: 1, vesselId: 11, fee: 110, code: '0011', hull: 'motor' },
      { pierId: 2, vesselId: 20, fee: 220, code: '0007', hull: 'motor' },
      { pierId: 4, vesselId: 41, fee: 410, code: '0041', hull: 'sail' },
    ],
  },
};

/** The piers whose current moorings a plain CTE reads */
const CTE_PIERS: Record<string, number[]> = { 0: [], 1: [2], n: [1, 2, 3] };
/** The piers a correlated set probes: none of them has a current mooring / one has / three have */
const CORRELATED_PIERS: Record<string, number[]> = { 0: [4, 5], 1: [3, 4], n: [1, 2, 3, 4, 5] };
const SET_VALUES: Record<string, number[]> = { 0: [], 1: [20], n: [10, 20, 30] };
const SET_CODES: Record<string, string[]> = { 0: [], 1: ['0042'], n: ['0042', '0007', 'x30'] };
const JSON_OBJECTS: Record<string, Record<string, string>> = { 0: {}, 1: { a: '0042' }, n: { a: '0042', b: '7', c: 'x' } };
const ROW_SOURCES: Record<string, Array<Change & { validFrom: Date }>> = {
  0: [],
  1: [{ pierId: 5, vesselId: 50, fee: 500, code: '0050', hull: 'motor', validFrom: OPENED_AT }],
  n: [
    { pierId: 5, vesselId: 50, fee: 500, code: '0050', hull: 'motor', validFrom: OPENED_AT },
    { pierId: 4, vesselId: 40, fee: 400, code: '0040', hull: 'sail', validFrom: HISTORY_FROM },
    { pierId: 3, vesselId: 31, fee: 310, code: 'x31', hull: 'motor', validFrom: CLOSED_AT },
  ],
};

type TableKind = 'table' | 'withTimeout' | 'withQueryOptions' | 'withPreparedStatements' | 'expectedExecutionTime' | 'view';
type ContextKind = 'root' | 'transaction';
type Shape =
  | 'cte' | 'cte-aliased' | 'cte-joined' | 'close-leg' | 'open-leg' | 'union-opened-first' | 'union-closed-first'
  | 'set-unnest' | 'set-unnestZip' | 'set-unnestRows' | 'set-jsonbArrayElements' | 'set-jsonbEachText' | 'set-correlated' | 'set-first-union';
type Reader = 'toList' | 'first' | 'count' | 'builder-timeout';

const TABLE_KINDS: TableKind[] = ['table', 'withTimeout', 'withQueryOptions', 'withPreparedStatements', 'expectedExecutionTime', 'view'];
const CONTEXT_KINDS: ContextKind[] = ['root', 'transaction'];
const CTE_SHAPES: Shape[] = ['cte', 'cte-aliased', 'cte-joined', 'close-leg', 'open-leg'];
const UNION_SHAPES: Shape[] = ['union-opened-first', 'union-closed-first', 'set-first-union'];
const SET_SHAPES: Shape[] = ['set-unnest', 'set-unnestZip', 'set-unnestRows', 'set-jsonbArrayElements', 'set-jsonbEachText', 'set-correlated'];
const SHAPES: Shape[] = [...CTE_SHAPES, ...UNION_SHAPES, ...SET_SHAPES];

const readersOf = (shape: Shape): Reader[] => (CTE_SHAPES.includes(shape)
  ? ['toList', 'first', 'builder-timeout']
  : UNION_SHAPES.includes(shape) ? ['toList', 'first', 'count'] : ['toList', 'first']);

/** The rows the scenario implies for a shape: the union of the legs, the set's elements, the CTE's current moorings */
const expectedCount = (shape: Shape, rows: Rows): number => {
  const n = rows === 0 ? 0 : rows === 1 ? 1 : 3;

  switch (shape) {
    case 'union-opened-first':
    case 'union-closed-first':
    case 'set-first-union':
      return 2 * n;
    default:
      return n;
  }
};

const canonical = (row: unknown): string => JSON.stringify(row);
const sortRows = (rows: unknown[]): unknown[] => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));

/** A read row without its generated key (a serial value: the oracle runs after a rollback, on later values) */
const normalizeRow = (row: any): any => {
  if (row === null || typeof row !== 'object') {
    return row;
  }

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(row).sort()) {
    if (key === 'id') {
      expect(typeof row.id).toBe('number');
      continue;
    }

    const value = row[key];
    out[key] = value instanceof Date ? value.toISOString() : value;
  }

  return out;
};

const normalize = (value: unknown): unknown => (Array.isArray(value) ? sortRows(value.map(normalizeRow)) : normalizeRow(value));
const paramsKey = (params: unknown[] | undefined): string => JSON.stringify(params ?? [], (_key, value) => (typeof value === 'bigint' ? `${value}n` : value));

const ROLLBACK = new Error('rolled back');

describe('query roots on a table run on the table\'s own context', () => {
  let base: DatabaseClient;
  let routing: RoutingClient;
  let db: MarinaDatabase;
  const contextLog: string[] = [];
  const derivedLog: string[] = [];
  const slow: string[] = [];

  const inRolledBackTransaction = async (body: (trx: MarinaDatabase) => Promise<void>, context: MarinaDatabase = db): Promise<void> => {
    try {
      await context.transaction(async trx => {
        await body(trx);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
  };

  const seed = async (context: MarinaDatabase) => {
    await context.piers.insertBulk(PIERS.map(p => ({ ...p })));
    await context.moorings.insertBulk(MOORINGS.map(m => ({ ...m })));
  };

  const clear = async (client: DatabaseClient = base) => {
    await client.query('DELETE FROM trq_moorings');
    await client.query('DELETE FROM trq_piers');
  };

  const stateOf = async (context: MarinaDatabase) => sortRows((await context.moorings.select(m => ({
    pierId: m.pierId, vesselId: m.vesselId, fee: m.fee, code: m.code, hull: m.hull, isCurrent: m.isCurrent, validTo: m.validTo,
  })).toList()).map(r => ({ ...r, validTo: r.validTo == null ? null : r.validTo.getTime() })));

  const currentOf = async (context: MarinaDatabase, pierId: number) => (await context.moorings
    .where(m => and(eq(m.pierId, pierId), eq(m.isCurrent, true)))
    .select(m => ({ vesselId: m.vesselId, fee: m.fee }))
    .toList()).map(r => ({ ...r }));

  /** The table-like root under test, the entity table its legs write through, and the one its plain reads read */
  const holderOf = (kind: TableKind, context: MarinaDatabase): { holder: any; writer: DbEntityTable<TrqMooring>; reader: any } => {
    switch (kind) {
      case 'table':
        return { holder: context.moorings, writer: context.moorings, reader: context.moorings };
      case 'withTimeout': {
        const derived = context.moorings.withTimeout(30000);
        return { holder: derived, writer: derived, reader: derived };
      }
      case 'withQueryOptions': {
        const derived = context.moorings.withQueryOptions({ logger: (message: string) => derivedLog.push(message) });
        return { holder: derived, writer: derived, reader: derived };
      }
      case 'withPreparedStatements': {
        const derived = context.moorings.withPreparedStatements(true);
        return { holder: derived, writer: derived, reader: derived };
      }
      case 'expectedExecutionTime': {
        const derived = context.moorings.expectedExecutionTime(60000);
        return { holder: derived, writer: derived, reader: derived };
      }
      case 'view':
        return { holder: context.berths, writer: context.moorings, reader: context.berths };
    }
  };

  /** Current moorings of `piers` — a view is current-only */
  const currentWhere = (reader: any, view: boolean, piers: number[]) => reader.where((m: any) => (view
    ? eqAny(m.pierId, piers)
    : and(eq(m.isCurrent, true), eqAny(m.pierId, piers))));

  /** The fold's legs on `writer`: the close leg, and the open leg ordered after it (or not) */
  const foldLegs = (writer: DbEntityTable<TrqMooring>, fold: { scope: number[]; desired: Change[] }, barrier = true) => {
    const builder = new DbCteBuilder(writer.getClient());
    const closed = builder.withMutation('trq_closed', writer
      .where(m => and(
        eqAny(m.pierId, fold.scope),
        eq(m.isCurrent, true),
        notExists(fromRows(writer, fold.desired, { columns: CHANGE_COLUMNS, alias: 'k' })
          .where(k => and(eq(k.pierId, m.pierId), eq(k.vesselId, m.vesselId), eq(k.fee, m.fee)))
          .select(() => ({ one: literal(1) }))
          .asSubquery())
      ))
      .update({ validTo: CLOSED_AT, isCurrent: false })
      .toStatement(m => ({ id: m.id, pierId: m.pierId, vesselId: m.vesselId, fee: m.fee, code: m.code, hull: m.hull })));
    const opened = builder.withMutation('trq_opened', writer.insertFrom(
      fromRows(writer, fold.desired, { columns: CHANGE_COLUMNS, alias: 'd' })
        .where(d => notExists(writer
          .where(c => and(eq(c.pierId, d.pierId), eq(c.vesselId, d.vesselId), eq(c.fee, d.fee), eq(c.isCurrent, true)))
          .select(c => ({ id: c.id }))
          .asSubquery()))
        .select(d => ({ pierId: d.pierId, vesselId: d.vesselId, fee: d.fee, code: d.code, hull: d.hull }))
        .asSubquery('table'),
      src => ({ pierId: src.pierId, vesselId: src.vesselId, fee: src.fee, code: src.code, hull: src.hull, validFrom: OPENED_AT, isCurrent: true }),
      barrier ? { where: () => afterMutation(closed.cte) } : undefined
    ).toStatement(m => ({ id: m.id, pierId: m.pierId, vesselId: m.vesselId, fee: m.fee, code: m.code, hull: m.hull })));

    return { closed: closed.cte, opened: opened.cte };
  };

  /**
   * The helper a consumer writes versioned rows with: it is handed a TABLE — the root's or a transaction's — and
   * nothing else. ONE statement: the close leg, the open leg ordered after it, both read back typed (opened first).
   * Whether it may retry the unit on a deadlock / serialization failure depends on who owns the transaction.
   */
  const foldThroughTable = async (moorings: DbEntityTable<TrqMooring>, scope: number[], desired: Change[]) => {
    const { closed, opened } = foldLegs(moorings, { scope, desired });
    const rows = await moorings.selectFromCte(opened)
      .select(r => ({ leg: 'opened', id: r.id, pierId: r.pierId, vesselId: r.vesselId, fee: r.fee, hull: r.hull }))
      .unionAll(moorings.selectFromCte(closed).select(r => ({ leg: 'closed', id: r.id, pierId: r.pierId, vesselId: r.vesselId, fee: r.fee, hull: r.hull })))
      .toList();

    return { rows, ownsBoundary: !moorings.isInTransaction() };
  };

  /** Every CTE and set a case may read, built once on the case's tables (the statements are text: both roots read the same) */
  const partsOf = (kind: TableKind, context: MarinaDatabase, rows: Rows) => {
    const { writer, reader } = holderOf(kind, context);
    const view = kind === 'view';
    const plain = new DbCteBuilder(writer.getClient());
    const cur = plain.with('trq_cur', currentWhere(reader, view, CTE_PIERS[String(rows)])
      .select((m: any) => ({ pierId: m.pierId, vesselId: m.vesselId, fee: m.fee, code: m.code, hull: m.hull })));
    const fees = plain.with('trq_fees', currentWhere(reader, view, CTE_PIERS[String(rows)])
      .select((m: any) => ({ pid: m.pierId, doubled: sql<number>`${m.fee} * 2` })));
    const legs = foldLegs(writer, FOLDS[String(rows)]);

    return { writer, reader, view, cur: cur.cte as DbCte<any>, fees: fees.cte as DbCte<any>, ...legs };
  };

  /** The query of `shape` rooted on `root` — a table under test, or the context itself (the oracle) */
  const queryOf = (shape: Shape, rows: Rows, root: any, parts: ReturnType<typeof partsOf>, context: MarinaDatabase): any => {
    const leg = (cte: DbCte<any>, tag: string) => root.selectFromCte(cte)
      .select((r: any) => ({ leg: tag, id: r.id, pierId: r.pierId, vesselId: r.vesselId, fee: r.fee, code: r.code, hull: r.hull }));
    const projectCurrent = (r: any) => ({ pierId: r.pierId, vesselId: r.vesselId, fee: r.fee, code: r.code, hull: r.hull });
    const r = String(rows);

    switch (shape) {
      case 'cte':
        return root.selectFromCte(parts.cur).select(projectCurrent);
      case 'cte-aliased':
        return root.selectFromCte(parts.cur, 'c').select(projectCurrent);
      case 'cte-joined':
        return root.selectFromCte(parts.cur)
          .innerJoin(parts.fees, eq((parts.cur.as() as any).pierId, (parts.fees.as() as any).pid))
          .select((c: any, f: any) => ({ pierId: c.pierId, vesselId: c.vesselId, doubled: f.doubled }));
      case 'close-leg':
        return leg(parts.closed, 'closed');
      case 'open-leg':
        return leg(parts.opened, 'opened');
      case 'union-opened-first':
        return leg(parts.opened, 'opened').unionAll(leg(parts.closed, 'closed'));
      case 'union-closed-first':
        return leg(parts.closed, 'closed').unionAll(leg(parts.opened, 'opened'));
      case 'set-unnest':
        return root.selectFromSet(unnest(SET_VALUES[r], 'integer'), 'v').select((v: any) => ({ vesselId: v.value }));
      case 'set-unnestZip':
        return root.selectFromSet(unnestZip({
          pierId: { values: SET_VALUES[r].map(v => v / 10), type: 'integer' },
          code: { values: SET_CODES[r], type: 'text' },
        }), 'z').select((z: any) => ({ pierId: z.pierId, code: z.code }));
      case 'set-unnestRows':
        return root.selectFromSet(unnestRows(context.moorings, ROW_SOURCES[r], ['pierId', 'vesselId', 'fee', 'code', 'hull', 'validFrom']), 'rs')
          .select((s: any) => ({ pierId: s.pierId, vesselId: s.vesselId, fee: s.fee, code: s.code, hull: s.hull, validFrom: s.validFrom }));
      case 'set-jsonbArrayElements':
        return root.selectFromSet(jsonbArrayElements(SET_VALUES[r]), 'e').select((e: any) => ({ value: e.value }));
      case 'set-jsonbEachText':
        return root.selectFromSet(jsonbEachText(JSON_OBJECTS[r]), 'kv').select((kv: any) => ({ key: kv.key, value: kv.value }));
      case 'set-correlated':
        return root.selectFromSet(unnest(CORRELATED_PIERS[r], 'integer'), 'p')
          .where((p: any) => exists(currentWhere(parts.reader, parts.view, CORRELATED_PIERS[r])
            .where((m: any) => eq(m.pierId, p.value))
            .select(() => ({ one: literal(1) }))
            .asSubquery()))
          .select((p: any) => ({ pierId: p.value }));
      case 'set-first-union':
        return root.selectFromSet(unnestZip({
          pierId: { values: SET_VALUES[r].map(v => v / 10), type: 'integer' },
          vesselId: { values: SET_VALUES[r], type: 'integer' },
        }), 's')
          .select((s: any) => ({ src: 'set', pierId: s.pierId, vesselId: s.vesselId }))
          .unionAll(root.selectFromCte(parts.cur).select((c: any) => ({ src: 'cte', pierId: c.pierId, vesselId: c.vesselId })));
    }
  };

  const read = async (shape: Shape, reader: Reader, query: any): Promise<unknown> => {
    const set = SET_SHAPES.includes(shape);
    const union = UNION_SHAPES.includes(shape);

    switch (reader) {
      case 'toList':
        return await query.toList();
      case 'count':
        return await query.count();
      case 'builder-timeout':
        return await query.withTimeout(30000).toList();
      case 'first':
        if (union) {
          // the legs carry the same pier and vessel (a close and the open of the same key, a set row and a CTE row)
          return await query.orderBy((r: any) => [r.pierId, r.vesselId, shape === 'set-first-union' ? r.src : r.leg]).firstOrDefault();
        }
        if (set) {
          // a set orders by its own row
          const ordered = shape === 'set-jsonbEachText' ? query.orderBy((kv: any) => kv.key) : shape === 'set-jsonbArrayElements' || shape === 'set-unnest' ? query.orderBy((v: any) => v.value)
            : shape === 'set-unnestRows' ? query.orderBy((s: any) => [s.pierId, s.vesselId]) : shape === 'set-unnestZip' ? query.orderBy((z: any) => z.pierId) : query.orderBy((p: any) => p.value);
          return await ordered.firstOrDefault();
        }
        return await query.orderBy((r: any) => (shape === 'cte-joined' ? [r.pierId] : [r.pierId, r.vesselId, r.fee])).first();
    }
  };

  interface Window {
    result: unknown;
    routes: Route[];
    derived: string[];
    contextual: string[];
    slow: string[];
    state: unknown[];
  }

  /** Runs `work`, recording what reached the client and the loggers meanwhile */
  const observe = async (work: () => Promise<unknown>, context: MarinaDatabase): Promise<Window> => {
    const mark = routing.routes.length;
    derivedLog.length = 0;
    contextLog.length = 0;
    slow.length = 0;
    const result = await work();
    const window = { result, routes: routing.routes.slice(mark), derived: [...derivedLog], contextual: [...contextLog], slow: [...slow] };

    return { ...window, state: await stateOf(context) };
  };

  const statementsOf = (window: Window) => window.routes.map(r => ({ via: r.via, sql: r.sql, params: paramsKey(r.params) }));
  const logged = (lines: string[], statement: string) => lines.some(line => line.includes(statement.trim()));

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    base = createFreshClient();
    routing = new RoutingClient(base);
    db = new MarinaDatabase(routing, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        contextLog.push(message);
      },
      onQueryTakingTooLong: info => {
        slow.push(info.sql);
      },
      longRunningQueryThreshold: 0,
      slowQueryStackTraceLimit: 0,
    });
    await base.query('DROP VIEW IF EXISTS trq_berths');
    await base.query('DROP TABLE IF EXISTS trq_moorings, trq_piers CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await base.query('DROP VIEW IF EXISTS trq_berths');
    await base.query('DROP TABLE IF EXISTS trq_moorings, trq_piers CASCADE');
    await db.dispose();
  });

  describe('matrix: table kind × context kind × source shape × rows × reader — oracle: the query rooted on the context', () => {
    for (const kind of TABLE_KINDS) {
      for (const contextKind of CONTEXT_KINDS) {
        for (const shape of SHAPES) {
          for (const rows of ROWS) {
            for (const reader of readersOf(shape)) {
              test(`${kind} | ${contextKind} | ${shape} | ${rows} rows | ${reader}`, async () => {
                let subject!: Window;
                let oracle!: Window;

                const runBoth = async (context: MarinaDatabase, between: () => Promise<void>) => {
                  const parts = partsOf(kind, context, rows);
                  const { holder } = holderOf(kind, context);
                  subject = await observe(() => read(shape, reader, queryOf(shape, rows, holder, parts, context)), context);
                  await between();
                  oracle = await observe(() => read(shape, reader, queryOf(shape, rows, context, parts, context)), context);
                };

                if (contextKind === 'transaction') {
                  await inRolledBackTransaction(async trx => {
                    await seed(trx);
                    await trx.query('SAVEPOINT trq_case');
                    await runBoth(trx, async () => {
                      await trx.query('ROLLBACK TO SAVEPOINT trq_case');
                    });
                  });
                } else {
                  await clear();
                  await seed(db);

                  try {
                    await runBoth(db, async () => {
                      await clear();
                      await seed(db);
                    });
                  } finally {
                    await clear();
                  }
                }

                // the same rows, the same state, the rows the scenario implies
                expect(normalize(subject.result)).toEqual(normalize(oracle.result));
                expect(subject.state).toEqual(oracle.state);
                const count = expectedCount(shape, rows);
                if (reader === 'count') {
                  expect(subject.result).toBe(count);
                } else if (reader === 'first') {
                  expect(subject.result === null ? 0 : 1).toBe(Math.min(count, 1));
                } else {
                  expect((subject.result as unknown[]).length).toBe(count);
                }

                // the same statements, on the same channel: the transaction's inside a transaction
                expect(subject.routes.length).toBeGreaterThan(0);
                expect(statementsOf(subject)).toEqual(statementsOf(oracle));
                expect(new Set(subject.routes.map(r => r.via))).toEqual(new Set([contextKind === 'transaction' ? 'transaction' : 'root']));

                // the table's executor ran them
                const builderTimeout = reader === 'builder-timeout' ? 30000 : undefined;
                for (const route of subject.routes) {
                  expect(route.options?.timeoutMs).toBe(kind === 'withTimeout' ? (builderTimeout ?? 30000) : builderTimeout);
                  expect(route.options?.prepare).toBe(kind === 'withPreparedStatements' ? true : undefined);
                }
                for (const route of oracle.routes) {
                  expect(route.options?.timeoutMs).toBe(builderTimeout);
                  expect(route.options?.prepare).toBe(undefined);
                }
                for (const route of subject.routes) {
                  expect(logged(subject.derived, route.sql)).toBe(kind === 'withQueryOptions');
                  expect(logged(subject.contextual, route.sql)).toBe(kind !== 'withQueryOptions');
                  expect(subject.slow.includes(route.sql)).toBe(kind !== 'expectedExecutionTime');
                }
                for (const route of oracle.routes) {
                  expect(logged(oracle.contextual, route.sql)).toBe(true);
                  expect(oracle.slow.includes(route.sql)).toBe(true);
                }
              });
            }
          }
        }
      }
    }
  });

  describe('a transaction\'s table: the decisive cases', () => {
    test('its query roots see the transaction\'s uncommitted rows — the root context does not (PGlite: refused at once)', async () => {
      await clear();
      await seed(db);

      try {
        await inRolledBackTransaction(async trx => {
          await trx.piers.insert({ id: 7, name: 'pier-7' });
          await trx.moorings.insert({ pierId: 7, vesselId: 70, fee: 700, code: '0070', hull: 'sail', validFrom: OPENED_AT, isCurrent: true });

          const cur = new DbCteBuilder(trx.moorings.getClient()).with('trq_cur', trx.moorings
            .where(m => and(eqAny(m.pierId, [6, 7]), eq(m.isCurrent, true)))
            .select(m => ({ pierId: m.pierId, vesselId: m.vesselId, code: m.code })));
          const fromTable = await trx.moorings.selectFromCte(cur.cte).select(r => ({ pierId: r.pierId, vesselId: r.vesselId, code: r.code })).toList();
          expect(fromTable.map(r => ({ ...r }))).toEqual([{ pierId: 7, vesselId: 70, code: '0070' }]);

          const fromView = await trx.berths.selectFromCte(cur.cte).select(r => ({ pierId: r.pierId })).toList();
          expect(fromView.map(r => r.pierId)).toEqual([7]);

          const probed = await trx.moorings.selectFromSet(unnest([6, 7], 'integer'), 'p')
            .where(p => exists(trx.moorings.where(m => eq(m.pierId, p.value)).select(() => ({ one: literal(1) })).asSubquery()))
            .select(p => ({ pierId: p.value }))
            .toList();
          expect(probed.map(r => ({ ...r }))).toEqual([{ pierId: 7 }]);

          // rooted on the root context: another session, which cannot see an uncommitted row (PGlite has one session)
          const fromRoot = db.selectFromCte(cur.cte).select(r => ({ pierId: r.pierId })).toList();
          if (ENGINE === 'pglite') {
            await expectToReject(fromRoot, PGLITE_SINGLE_SESSION);
          } else {
            expect(await fromRoot).toEqual([]);
          }
        });
      } finally {
        await clear();
      }
    });

    test('they run on the transaction\'s session — the same backend, every statement through the transaction', async () => {
      await clear();
      await seed(db);

      try {
        await inRolledBackTransaction(async trx => {
          const pidOf = async (root: any): Promise<number> => (await root.selectFromSet(unnest([1], 'integer'), 'one')
            .select(() => ({ pid: sql<number>`pg_backend_pid()` }))
            .firstOrDefault()).pid;
          const [{ pid: own }] = await trx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

          const mark = routing.routes.length;
          for (const root of [trx.moorings, trx.berths, trx.moorings.withTimeout(30000), trx.moorings.withPreparedStatements(true)]) {
            expect(await pidOf(root)).toBe(own);
          }
          // a write assigns the transaction its id: a table-rooted statement reports the same transaction
          await trx.piers.insert({ id: 8, name: 'pier-8' });
          const [{ xid }] = await trx.query<{ xid: string }>('SELECT pg_current_xact_id_if_assigned()::text AS xid');
          const seen = await trx.moorings.selectFromSet(unnest([1], 'integer'), 'one')
            .select(() => ({ xid: sql<string>`pg_current_xact_id_if_assigned()::text` }))
            .firstOrDefault();
          expect(String(seen!.xid)).toBe(String(xid));
          expect(new Set(routing.routes.slice(mark).map(r => r.via))).toEqual(new Set(['transaction']));

          if (ENGINE !== 'pglite') {
            expect(await pidOf(db)).not.toBe(own);
          }
        });
      } finally {
        await clear();
      }
    });

    test('on a pool of ONE connection the whole fold completes inside the transaction; rooted on the root it would need a second one', async () => {
      const single = new MarinaDatabase(clientWithPoolOf(1));

      try {
        await clear();
        await seed(single);
        let stray: Promise<unknown> | undefined;

        await inRolledBackTransaction(async trx => {
          await trx.piers.insert({ id: 7, name: 'pier-7' });
          const desired: Change[] = [
            { pierId: 1, vesselId: 11, fee: 110, code: '0011', hull: 'motor' },
            { pierId: 7, vesselId: 70, fee: 700, code: '0070', hull: 'sail' },
          ];

          const outcome = await settleWithin(foldThroughTable(trx.moorings, [1, 7], desired), 15000);
          expect(outcome).not.toBe(PENDING);
          const { rows, ownsBoundary } = outcome as Awaited<ReturnType<typeof foldThroughTable>>;
          expect(ownsBoundary).toBe(false);
          expect(sortRows(rows.map(r => normalizeRow(r)))).toEqual(sortRows([
            { leg: 'opened', pierId: 1, vesselId: 11, fee: 110, hull: 'motor' },
            { leg: 'opened', pierId: 7, vesselId: 70, fee: 700, hull: 'sail' },
            { leg: 'closed', pierId: 1, vesselId: 10, fee: 100, hull: 'sail' },
          ]));
          expect(await currentOf(trx, 7)).toEqual([{ vesselId: 70, fee: 700 }]);

          // the same statement rooted on the root context needs a connection the transaction holds
          const { opened } = foldLegs(trx.moorings, { scope: [7], desired: [{ pierId: 7, vesselId: 71, fee: 710, code: '0071', hull: 'sail' }] });
          if (ENGINE === 'pglite') {
            await expectToReject(single.selectFromCte(opened).select(r => ({ id: r.id })).toList(), PGLITE_SINGLE_SESSION);
            return;
          }
          stray = single.selectFromCte(opened).select(r => ({ id: r.id })).toList().then(() => 'ran', error => error);
          expect(await settleWithin(stray, 300)).toBe(PENDING);
        }, single);

        if (stray) {
          // it ran once the transaction gave the connection back — outside it: pier 7 was rolled back
          expect(sqlStateOf(await stray)).toBe('23503');
        }
        expect(await currentOf(single, 1)).toEqual([{ vesselId: 10, fee: 100 }]);
        expect(await single.piers.count()).toBe(5);
      } finally {
        await clear();
        await single.dispose();
      }
    });

    test('a rollback discards everything the table-rooted statement wrote', async () => {
      await clear();
      await seed(db);

      try {
        const before = await stateOf(db);
        let inside: unknown[] = [];

        await inRolledBackTransaction(async trx => {
          await trx.piers.insert({ id: 7, name: 'pier-7' });
          const { rows, ownsBoundary } = await foldThroughTable(trx.moorings, [1, 2, 3, 7], [
            { pierId: 1, vesselId: 11, fee: 110, code: '0011', hull: 'motor' },
            { pierId: 2, vesselId: 20, fee: 220, code: '0007', hull: 'motor' },
            { pierId: 7, vesselId: 70, fee: 700, code: '0070', hull: 'sail' },
          ]);
          expect(ownsBoundary).toBe(false);
          expect(rows.length).toBe(6);
          inside = await stateOf(trx);
        });

        expect(inside).not.toEqual(before);
        expect(await stateOf(db)).toEqual(before);
        expect(await db.piers.count()).toBe(5);
      } finally {
        await clear();
      }
    });

    test('close-then-open of the SAME key under the partial unique index, in one statement through a transaction table', async () => {
      await clear();
      await seed(db);

      try {
        // pier 2's current mooring gets a new version: the same vessel, a new fee
        await inRolledBackTransaction(async trx => {
          const { rows } = await foldThroughTable(trx.moorings, [2], [{ pierId: 2, vesselId: 20, fee: 220, code: '0007', hull: 'motor' }]);

          expect(sortRows(rows.map(r => normalizeRow(r)))).toEqual(sortRows([
            { leg: 'opened', pierId: 2, vesselId: 20, fee: 220, hull: 'motor' },
            { leg: 'closed', pierId: 2, vesselId: 20, fee: 200, hull: 'motor' },
          ]));
          expect(await currentOf(trx, 2)).toEqual([{ vesselId: 20, fee: 220 }]);
        });

        // the barrier's negative control: without it the union reads the open leg first, and its insert meets the row
        // the close leg has not retired yet
        await inRolledBackTransaction(async trx => {
          const { closed, opened } = foldLegs(trx.moorings, { scope: [2], desired: [{ pierId: 2, vesselId: 20, fee: 220, code: '0007', hull: 'motor' }] }, false);
          const error = await expectToReject(trx.moorings.selectFromCte(opened)
            .select(r => ({ leg: 'opened', pierId: r.pierId }))
            .unionAll(trx.moorings.selectFromCte(closed).select(r => ({ leg: 'closed', pierId: r.pierId })))
            .toList());
          expect(sqlStateOf(error)).toBe('23505');
        });

        expect(await currentOf(db, 2)).toEqual([{ vesselId: 20, fee: 200 }]);
      } finally {
        await clear();
      }
    });

    test('rooted on the ROOT context the fold runs outside the transaction: 23503 at once — never a wait (PGlite: refused at once)', async () => {
      await clear();
      await seed(db);

      try {
        await inRolledBackTransaction(async trx => {
          await trx.piers.insert({ id: 7, name: 'pier-7' });
          const { opened } = foldLegs(trx.moorings, { scope: [7], desired: [{ pierId: 7, vesselId: 70, fee: 700, code: '0070', hull: 'sail' }] });
          const fromRoot = db.selectFromCte(opened).select(r => ({ pierId: r.pierId })).toList();

          if (ENGINE === 'pglite') {
            await expectToReject(fromRoot, PGLITE_SINGLE_SESSION);
          } else {
            // the other session cannot see pier 7: its foreign-key check finds no parent — PostgreSQL does not wait for
            // a row another transaction has not committed
            const outcome = await settleWithin(fromRoot.then(() => 'ran', error => error), 5000);
            expect(outcome).not.toBe(PENDING);
            expect(sqlStateOf(outcome)).toBe('23503');
          }

          // rooted on the transaction's table, the same statement runs inside the transaction
          const rows = await trx.moorings.selectFromCte(opened).select(r => ({ pierId: r.pierId, vesselId: r.vesselId })).toList();
          expect(rows.map(r => ({ ...r }))).toEqual([{ pierId: 7, vesselId: 70 }]);
        });
      } finally {
        await clear();
      }
    });

    test('inside a SAVEPOINT: ROLLBACK TO SAVEPOINT undoes the table-rooted statement, the table still reports its transaction', async () => {
      await clear();
      await seed(db);

      try {
        await inRolledBackTransaction(async trx => {
          await trx.query('SAVEPOINT trq_sp');
          expect(trx.moorings.isInTransaction()).toBe(true);
          await foldThroughTable(trx.moorings, [1], [{ pierId: 1, vesselId: 11, fee: 110, code: '0011', hull: 'motor' }]);
          expect(await currentOf(trx, 1)).toEqual([{ vesselId: 11, fee: 110 }]);

          await trx.query('ROLLBACK TO SAVEPOINT trq_sp');
          expect(await currentOf(trx, 1)).toEqual([{ vesselId: 10, fee: 100 }]);
          expect(trx.moorings.isInTransaction()).toBe(true);

          // and it still works there
          await foldThroughTable(trx.moorings, [1], [{ pierId: 1, vesselId: 12, fee: 120, code: '0012', hull: 'sail' }]);
          expect(await currentOf(trx, 1)).toEqual([{ vesselId: 12, fee: 120 }]);
        });
      } finally {
        await clear();
      }
    });

    test('the helper that holds only a table: on the root it owns its boundary (one autocommitted statement), in a transaction it does not', async () => {
      await clear();
      await seed(db);

      try {
        const onRoot = await foldThroughTable(db.moorings, [3], [{ pierId: 3, vesselId: 31, fee: 310, code: 'x31', hull: 'motor' }]);
        expect(onRoot.ownsBoundary).toBe(true);
        expect(sortRows(onRoot.rows.map(r => normalizeRow(r)))).toEqual(sortRows([
          { leg: 'opened', pierId: 3, vesselId: 31, fee: 310, hull: 'motor' },
          { leg: 'closed', pierId: 3, vesselId: 30, fee: 300, hull: 'sail' },
        ]));
        expect(await currentOf(db, 3)).toEqual([{ vesselId: 31, fee: 310 }]);

        await db.transaction(async trx => {
          await trx.piers.insert({ id: 9, name: 'pier-9' });
          const inTransaction = await foldThroughTable(trx.moorings, [9], [{ pierId: 9, vesselId: 90, fee: 900, code: '0090', hull: 'sail' }]);
          expect(inTransaction.ownsBoundary).toBe(false);
          expect(inTransaction.rows.map(r => normalizeRow(r))).toEqual([{ leg: 'opened', pierId: 9, vesselId: 90, fee: 900, hull: 'sail' }]);
        });

        // committed with the caller's transaction
        expect(await currentOf(db, 9)).toEqual([{ vesselId: 90, fee: 900 }]);
      } finally {
        await clear();
      }
    });
  });

  describe('isInTransaction() and getClient()', () => {
    /** Every table kind a context hands out */
    const tablesOf = (context: MarinaDatabase): Array<[string, any]> => [
      ['table', context.moorings],
      ['another table', context.piers],
      ['view', context.berths],
      ['withTimeout', context.moorings.withTimeout(1000)],
      ['withQueryOptions', context.moorings.withQueryOptions({ logQueries: false })],
      ['withPreparedStatements', context.moorings.withPreparedStatements(false)],
      ['expectedExecutionTime', context.moorings.expectedExecutionTime(1000)],
      ['derived twice', context.moorings.withTimeout(1000).expectedExecutionTime(1000)],
    ];

    test('a root context\'s tables: false — the context\'s own client', () => {
      for (const [name, table] of tablesOf(db)) {
        expect([name, table.isInTransaction()]).toEqual([name, false]);
        expect([name, table.getClient() === db.getClient()]).toEqual([name, true]);
      }
      expect(db.getClient().isInTransaction()).toBe(false);
    });

    test('a transaction\'s tables: true — the transaction\'s client, never the root\'s', async () => {
      await db.transaction(async trx => {
        for (const [name, table] of tablesOf(trx)) {
          expect([name, table.isInTransaction()]).toEqual([name, true]);
          expect([name, table.getClient() === trx.getClient()]).toEqual([name, true]);
          expect([name, table.getClient() === db.getClient()]).toEqual([name, false]);
        }
        expect(trx.getClient().isInTransaction()).toBe(true);
      });
    });

    test('a pool of one, a fresh client: the same answers', async () => {
      const single = new MarinaDatabase(clientWithPoolOf(1));

      try {
        expect(single.moorings.isInTransaction()).toBe(false);
        await single.transaction(async trx => {
          expect(trx.moorings.isInTransaction()).toBe(true);
          expect(trx.berths.isInTransaction()).toBe(true);
        });
      } finally {
        await single.dispose();
      }
    });

    test('a table kept past its transaction still reports it; its query roots are refused, nothing runs', async () => {
      const kept = await db.transaction(async trx => trx);
      const mark = routing.routes.length;

      for (const [name, table] of tablesOf(kept)) {
        expect([name, table.isInTransaction()]).toEqual([name, true]);
      }

      const cur = new DbCteBuilder().with('trq_cur', kept.moorings.select(m => ({ pierId: m.pierId })));
      const refusedCte = await expectToReject(kept.moorings.selectFromCte(cur.cte).select(r => ({ pierId: r.pierId })).toList(), 'this transaction has already ended');
      expect(refusedCte.name).toBe('TransactionEndedError');
      const refusedSet = await expectToReject(kept.berths.selectFromSet(unnest([1], 'integer'), 'one').select(o => ({ value: o.value })).toList(), 'this transaction has already ended');
      expect(refusedSet.name).toBe('TransactionEndedError');
      expect(routing.routes.slice(mark)).toEqual([]);
    });

    test('there is no nested transaction (no third kind): a transaction\'s context refuses one', async () => {
      await db.transaction(async trx => {
        await expectToReject(trx.transaction(async inner => inner.moorings.isInTransaction()), 'Nested transactions are not supported');
        expect(trx.moorings.isInTransaction()).toBe(true);
      });
    });
  });

  describe('typings', () => {
    test('a table\'s query roots type exactly as the context\'s', async () => {
      const builder = new DbCteBuilder();
      const cur = builder.with('trq_cur', db.moorings.select(m => ({ pierId: m.pierId, code: m.code, hull: m.hull, validFrom: m.validFrom })));
      const { closed } = foldLegs(db.moorings, FOLDS['0']);

      const fromTable = db.moorings.selectFromCte(cur.cte);
      const fromContext = db.selectFromCte(cur.cte);
      const tableRoot: Equals<typeof fromTable, typeof fromContext> = true;
      const aliased: Equals<ReturnType<typeof db.moorings.selectFromCte<{ pierId: number }>>, CteRootQueryBuilder<{ pierId: number }>> = true;

      const tableRows = await fromTable.select(r => ({ pierId: r.pierId, hull: r.hull, at: r.validFrom })).toList();
      const contextRows = await fromContext.select(r => ({ pierId: r.pierId, hull: r.hull, at: r.validFrom })).toList();
      const rows: Equals<typeof tableRows, typeof contextRows> = true;
      const hull: Equals<(typeof tableRows)[number]['hull'], Hull> = true;

      const tableLegs = db.moorings.selectFromCte(closed).select(r => ({ id: r.id, fee: r.fee })).unionAll(db.moorings.selectFromCte(closed).select(r => ({ id: r.id, fee: r.fee })));
      const contextLegs = db.selectFromCte(closed).select(r => ({ id: r.id, fee: r.fee })).unionAll(db.selectFromCte(closed).select(r => ({ id: r.id, fee: r.fee })));
      const union: Equals<typeof tableLegs, typeof contextLegs> = true;
      const unionOf: Equals<typeof tableLegs, UnionQueryBuilder<{ id: number; fee: number }>> = true;

      const tableSet = db.moorings.selectFromSet(unnestZip<{ a: number; b: string }>({ a: { values: [1], type: 'integer' }, b: { values: ['x'], type: 'text' } }), 'z');
      const contextSet = db.selectFromSet(unnestZip<{ a: number; b: string }>({ a: { values: [1], type: 'integer' }, b: { values: ['x'], type: 'text' } }), 'z');
      const set: Equals<typeof tableSet, typeof contextSet> = true;
      const typedSet: Equals<typeof tableSet, SetQueryBuilder<{ a: number; b: string }, { a: number; b: string }>> = true;
      const tableRowSet = db.moorings.selectFromSet(unnestRows(db.moorings, [], ['pierId', 'hull']));
      const contextRowSet = db.selectFromSet(unnestRows(db.moorings, [], ['pierId', 'hull']));
      const rowSet: Equals<typeof tableRowSet, typeof contextRowSet> = true;
      const tableEach = db.moorings.selectFromSet(jsonbEachText({ a: '1' }));
      const contextEach = db.selectFromSet(jsonbEachText({ a: '1' }));
      const each: Equals<typeof tableEach, typeof contextEach> = true;

      // a view and a derived table: the same roots
      const viewRoot = db.berths.selectFromCte(cur.cte);
      const view: Equals<typeof viewRoot, typeof fromContext> = true;
      const viewSet = db.berths.selectFromSet(unnest([1], 'integer'));
      const viewSetOf: Equals<typeof viewSet, SetQueryBuilder<{ value: number }, { value: number }>> = true;
      const derivedRoot = db.moorings.withTimeout(5).selectFromCte(cur.cte);
      const derived: Equals<typeof derivedRoot, typeof fromContext> = true;

      const answer = db.moorings.isInTransaction();
      const inTransaction: Equals<typeof answer, boolean> = true;
      const viewAnswer = db.berths.isInTransaction();
      const viewInTransaction: Equals<typeof viewAnswer, boolean> = true;
      const client = db.moorings.getClient();
      const clientOf: Equals<typeof client, DatabaseClient> = true;
      const viewClient = db.berths.getClient();
      const viewClientOf: Equals<typeof viewClient, DatabaseClient> = true;

      const typed = (table: DbEntityTable<TrqMooring>, cte: DbCte<{ pierId: number }>) => {
        // @ts-expect-error — a CTE, not a name
        table.selectFromCte('trq_cur');
        // @ts-expect-error — a set-returning function, not an array
        table.selectFromSet([1, 2]);
        // @ts-expect-error — the root reads the CTE's columns only
        table.selectFromCte(cte).select(r => ({ x: r.vesselId }));
        return table.selectFromCte(cte, 'c');
      };

      expect([tableRoot, aliased, rows, hull, union, unionOf, set, typedSet, rowSet, each, view, viewSetOf, derived, inTransaction, viewInTransaction, clientOf, viewClientOf].every(Boolean)).toBe(true);
      expect(typeof typed).toBe('function');
      void fromRows;
    });
  });
});
