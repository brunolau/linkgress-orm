import type { Catalog, ProcDef } from '../catalog/catalog';
import type { Query, TExpr } from '../analyze/nodes';
import type { Snapshot } from '../storage/mvcc';
import type { IoContext } from '../types/io';
import type { Collations, TypeOps } from './typeops';

/** Services the executor needs from the owning session / database. */
export interface ExecSession {
  readonly io: IoContext;
  readonly typeOps: TypeOps;
  readonly collations: Collations;
  catalog(): Catalog;
  getSetting(name: string, missingOk: boolean): string | null;
  setSetting(name: string, value: string | null, isLocal: boolean): void;
  transactionTimestamp(): number;
  statementTimestamp(): number;
  clockTimestamp(): number;
  nextval(seqOid: number): bigint;
  currval(seqOid: number): bigint;
  setval(seqOid: number, value: bigint, isCalled: boolean): bigint;
  lastval(): bigint;
  readonly databaseName: string;
  readonly userName: string;
  readonly backendPid: number;
  /** the compiled CHECK constraints of a domain (`VALUE` is executor parameter `slot`) */
  domainChecks(domain: import('../catalog/catalog').PgType): { name: string; ev: Evaluator; slot: number }[];
  /** execute a user-defined (SQL / plpgsql) function */
  callUserFunction(proc: ProcDef, args: unknown[], argTypes: number[], st: StatementState): { value: unknown; rows?: unknown[][] };
  /** run arbitrary SQL from inside an executing statement (plpgsql EXECUTE, DO) */
  runNestedSql(sql: string, params: unknown[], st: StatementState): { rows: unknown[][]; fields: { name: string; type: number }[]; rowCount: number };
  /** random number source */
  random(): number;
  setSeed(seed: number): void;
  /** pg_sleep support */
  requestSleep(ms: number, st: StatementState): void;
  /** pg_advisory locks, pg_notify ... */
  advisoryLock(key: string, shared: boolean, wait: boolean, xactScope: boolean): boolean;
  advisoryUnlock(key: string, shared: boolean): boolean;
  notify(channel: string, payload: string): void;
  currentXid(): number;
  txnStatus(xid: number): string;
  /** relation size estimates for pg_relation_size etc */
  relationRowCount(relOid: number): number;
  /** name resolution helpers */
  resolveRelation(name: string): number | null;
  resolveType(name: string): number | null;
  /** catalog introspection functions (deparse etc.) */
  readonly catalogFns: CatalogFunctions;
  /** visible namespaces for format_type / regclass output */
  searchPathNamespaces(): number[];
}

/** pg_get_* and friends, implemented against the in-memory catalog. */
export interface CatalogFunctions {
  indexDef(indexOid: number, column: number, pretty: boolean): string | null;
  constraintDef(constraintOid: number, pretty: boolean): string | null;
  viewDef(viewOid: number, pretty: boolean, wrapColumn?: number): string | null;
  partKeyDef(relOid: number): string | null;
  statisticsObjDef(statOid: number): string | null;
  expr(exprText: unknown, relOid: number, pretty: boolean): string | null;
  objDescription(objOid: number, catalogName: string | null): string | null;
  colDescription(relOid: number, attnum: number): string | null;
  serialSequence(table: string, column: string): string | null;
  functionDef(procOid: number): string | null;
  identifyObject?(classOid: number, objOid: number): string | null;
}

/** A trigger's transition table (REFERENCING NEW / OLD TABLE): the rows a statement changed, as the table stores them. */
export interface TransitionTable {
  name: string;
  rel: import('../catalog/catalog').Relation;
  rows: unknown[][];
}

/** Transition rows captured by one data-modifying statement, per event (in the target table's layout). */
export interface TransitionCapture {
  insertNew: unknown[][];
  updateOld: unknown[][];
  updateNew: unknown[][];
  deleteOld: unknown[][];
}

/** Per-statement execution state. */
export class StatementState {
  /** typed parameter values */
  params: unknown[];
  paramTypes: number[];
  /** exec-param slots (CASE test values, array coercion elements, ...) */
  execParams: unknown[] = [];
  /** uncorrelated sublink results keyed by sublink id */
  initPlans = new Map<number, unknown>();
  /** materialized CTE results keyed by CTE id */
  cteResults = new Map<number, unknown[][]>();
  /** cache for per-statement data (e.g. hash indexes over relations) */
  scratch = new Map<string, unknown>();
  snapshot: Snapshot;
  /** transaction id for writes (0 until assigned) */
  xid = 0;
  cid = 0;
  /** number of pg_sleep calls already served for this statement (restart emulation) */
  sleepsServed = 0;
  sleepCounter = 0;
  /** nesting depth for recursion safety */
  depth = 0;
  /** physical changes made by this statement (undone when the statement restarts after a lock wait) */
  undo: import('../storage/mvcc').UndoLog | null = null;
  /** relation oids modified by this statement (for AFTER-statement work) */
  modifiedRelations = new Set<number>();
  /**
   * AFTER events (foreign key checks, referential actions, AFTER ROW triggers) queued by the
   * statement and all its data-modifying CTEs; fired once the whole query has run (AfterTriggerEndQuery).
   */
  afterQueue: (() => void)[] = [];
  /** columns assigned by the UPDATE being executed (UPDATE OF column triggers) */
  updateTargetColumns: Set<string> | null = null;

  runAfterQueue(): void {
    while (this.afterQueue.length > 0) {
      this.afterQueue.shift()!();
    }
  }
  /** names of parameters for SQL-function bodies */
  paramNames: string[] = [];
  functionName = '';
  /** transition tables visible to the statements of the trigger function running them (named, in the table's layout) */
  transitionTables: TransitionTable[] | null = null;
  /**
   * Transaction control (COMMIT / ROLLBACK) is allowed: a procedure CALLed, or a DO block run, at
   * top level outside a transaction block (and not inside a multi-statement query string).
   */
  nonAtomic = false;

  constructor(
    readonly session: ExecSession,
    readonly catalog: Catalog,
    params: unknown[],
    paramTypes: number[],
    snapshot: Snapshot
  ) {
    this.params = params;
    this.paramTypes = paramTypes;
    this.snapshot = snapshot;
  }
}

/** Evaluation context: current row of a query level plus links to outer levels. */
export class EvalCtx {
  /** tuples indexed by range table index (null for null-extended) */
  row: unknown[];
  parent: EvalCtx | null;
  st: StatementState;
  aggValues: unknown[] | null = null;
  winValues: unknown[] | null = null;
  groupKeys: unknown[] | null = null;
  /** bitmask of grouping columns NOT in the current grouping set */
  groupingMask = 0;
  /** outputs of the set-operation / values pseudo RTE (rtIndex -1) */
  setOpRow: unknown[] | null = null;
  /** per-execution state of the query level this context belongs to (CTE results, plan) */
  inst: unknown = null;

  constructor(row: unknown[], parent: EvalCtx | null, st: StatementState) {
    this.row = row;
    this.parent = parent;
    this.st = st;
  }
}

export type Evaluator = (c: EvalCtx) => unknown;

/** Call information passed to builtin function implementations. */
export interface FnCall {
  st: StatementState;
  argTypes: number[];
  resultType: number;
  resultTypmod: number;
  collation: number;
  node: TExpr;
}

export type FnImpl = (args: unknown[], fc: FnCall) => unknown;

export interface AggImpl {
  init(fc: FnCall): unknown;
  step(state: unknown, args: unknown[], fc: FnCall): unknown;
  final(state: unknown, fc: FnCall): unknown;
  /** false => called even when an argument is NULL (default strict: rows with NULL args skipped) */
  strict?: boolean;
}

/** Callback used by compiled sublinks to run a subquery. */
export interface SubqueryRunner {
  run(query: Query, outer: EvalCtx, limit?: number): unknown[][];
}
