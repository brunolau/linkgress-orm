import * as A from './ast';
import { Analyzer, AnalyzerEnv } from './analyze/analyzer';
import { transformExpr } from './analyze/expr';
import { addRelationRte } from './analyze/from';
import { emptyQuery, Query, TExpr } from './analyze/nodes';
import { ParseState } from './analyze/parse-state';
import { analyzeStatementAsSubquery } from './analyze/select';
import { quoteIdentifier, TypeUtil } from './analyze/typeutil';
import { forEachChild } from './analyze/walk';
import { Catalog, Column, Constraint, NS_PG_CATALOG, PgType, ProcDef, Relation, StoredExpr, TypeOid } from './catalog/catalog';
import { CompileEnv, compileExpr } from './exec/compile';
import type { Evaluator } from './exec/runtime';
import { CatalogFunctionsImpl } from './catalog/deparse';
import { catalogRelationRows } from './catalog/system-views';
import type { Database } from './database';
import { describeUtility, executeUtility, UtilityResult } from './ddl/ddl';
import { checkGeneratedExprFolding } from './ddl/generated-expr';
import { PgError, PgErrorFields, SqlState } from './errors';
import { DmlExecutor } from './exec/exec-dml';
import { Executor } from './exec/executor';
import { CatalogFunctions, EvalCtx, ExecSession, StatementState, TransitionCapture } from './exec/runtime';
import { Collations, TypeOps } from './exec/typeops';
import { SqlParser } from './parser-ddl';
import { callPlpgsqlFunction, callSqlFunction, fireStatementTrigger, fireTrigger } from './plpgsql/functions';
import { displaySettingValue, normalizeSettingValue, settingDef } from './settings';
import { Heap, INVALID_XID, SleepRequest, Snapshot, UndoLog, WaitForTransaction } from './storage/mvcc';
import { DateTimeContext, EPOCH_DIFF_US, resolveZone, ZoneSpec } from './types/datetime';
import { receiveBinary } from './types/binary';
import { inputValue, IoContext } from './types/io';

/** executor parameter slot `VALUE` occupies while a domain CHECK constraint is evaluated */
export const DOMAIN_VALUE_SLOT = 1_000_000;

/** compiled domain CHECK constraints, per catalog (and its version) */
const compiledDomainChecks = new WeakMap<Catalog, { version: number; checks: Map<object, { name: string; ev: Evaluator; slot: number }> }>();

/** reusable analyses of query statements, per parse tree (Session.analyzeQueryStmt) */
const analyzedStatements = new WeakMap<A.Statement, { catalog: Catalog; version: number; key: string; query: Query; paramTypes: number[] }[]>();
/** analyses kept per parse tree (parameter types / search paths it runs under) */
const ANALYZED_VARIANTS_MAX = 4;

/** compiled bodies of `SELECT <expression>` SQL functions, per analysis of the body (Session.sqlFunctionExpression) */
const compiledSqlFunctions = new WeakMap<Query, { ev: Evaluator; type: number } | null>();

/** node kinds an inlined SQL function body must not contain: they need a FROM clause, a query level or a sub-select */
const NOT_INLINABLE = new Set(['sublink', 'var', 'agg', 'window', 'groupkey', 'grouping', 'execparam']);

function selfContainedExpr(e: TExpr): boolean {
  if (NOT_INLINABLE.has(e.k)) {
    return false;
  }
  let ok = true;
  forEachChild(e, (child) => {
    if (ok && !selfContainedExpr(child)) {
      ok = false;
    }
  });
  return ok;
}

export interface FieldInfo {
  name: string;
  typeOid: number;
  typmod: number;
  tableOid: number;
  columnAttnum: number;
}

export interface NamedPreparedStatement {
  /** SQL text as reported by pg_prepared_statements.statement */
  text: string;
  argTypes: number[];
  resultTypes: number[];
  fromSql: boolean;
  prepareTime: number;
  /** SQL PREPARE: the prepared query */
  stmt?: A.Statement;
  /** protocol-level statement */
  info?: PreparedInfo;
}

export interface PreparedInfo {
  /** null for an empty query string */
  ps: A.ParsedStatement | null;
  paramTypes: number[];
  /** row description, or null when the statement returns no rows (NoData) */
  fields: FieldInfo[] | null;
  name?: string;
  /** for plan revalidation of cached (named) statements */
  sql?: string;
  declaredTypes?: number[];
  catalog?: Catalog;
  catalogVersion?: number;
}

export interface StatementResult {
  command: string;
  rowCount: number | null;
  fields: FieldInfo[];
  rows: unknown[][];
  /** raw SQL of the statement (for adapters) */
  hasRows: boolean;
}

interface Savepoint {
  name: string;
  xid: number;
  catalog: Catalog | null;
  localSettings: Map<string, string | null>;
  /** deferred constraint checks queued before the savepoint (the rest are dropped by ROLLBACK TO) */
  deferredChecks?: number;
}

/** A constraint check deferred to COMMIT / SET CONSTRAINTS ... IMMEDIATE (an AFTER trigger event). */
export interface DeferredConstraintCheck {
  constraint: Constraint;
  run: (dml: DmlExecutor) => void;
}

export interface TxnState {
  topXid: number;
  explicit: boolean;
  failed: boolean;
  isolation: string;
  readOnly: boolean;
  startTs: number;
  snapshot: Snapshot | null;
  /** a statement of this transaction ran with a snapshot (PostgreSQL's FirstSnapshotSet) */
  snapshotTaken?: boolean;
  cid: number;
  catalog: Catalog | null;
  catalogFrozen: boolean;
  holdsDdlLock: boolean;
  savepoints: Savepoint[];
  localSettings: Map<string, string | null>;
  createdStorage: number[];
  droppedStorage: number[];
  /**
   * Actions that run AS PART of the commit, inside the committing transaction (PostgreSQL's
   * PreCommit_on_commit_actions): `ON COMMIT DROP` drops its temp table here, so the drop is in the
   * catalog the commit publishes. Run as an after-commit hook, the drop had no transaction left.
   */
  preCommit: (() => void)[];
  onCommit: (() => void)[];
  onAbort: (() => void)[];
  /** checks of DEFERRABLE constraints currently deferred */
  deferredChecks: DeferredConstraintCheck[];
  /** SET CONSTRAINTS: per-constraint mode (true = deferred), over the ALL mode, over the declared default */
  constraintModes: Map<number, boolean>;
  constraintAllMode: boolean | null;
  /** tuples inserted per heap (dead versions when the transaction aborts), for autovacuum */
  inserts?: Map<Heap, number>;
}

const COMMAND_TAGS: Record<string, string> = {
  SelectStmt: 'SELECT',
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
};

let processRandomSeed = Date.now() % 2147483647;

export class Session implements ExecSession, AnalyzerEnv {
  readonly db: Database;
  readonly backendPid: number;
  private settings = new Map<string, string>();
  txn: TxnState | null = null;
  private tempNsOid = 0;
  private lastSeqValue: bigint | null = null;
  readonly currvals = new Map<number, bigint>();
  readonly typeOps: TypeOps;
  readonly collations: Collations;
  readonly io: IoContext & DateTimeContext;
  readonly catalogFns: CatalogFunctions;
  private stmtTs = 0;
  private randState = processRandomSeed++;
  /** named prepared statements: SQL PREPARE (fromSql) and protocol-level Parse share one namespace */
  readonly preparedStatements = new Map<string, NamedPreparedStatement>();
  closed = false;
  /** xid this session's current statement waits on (deadlock detection) */
  waitingFor = 0;
  notifications: { channel: string; payload: string; pid: number }[] = [];
  listening = new Set<string>();
  /** called when a notification is queued for this session */
  onNotify: (() => void) | null = null;
  /** receives NOTICE / WARNING / INFO (...) messages that pass client_min_messages */
  onNotice: ((notice: PgError) => void) | null = null;
  /** set by a cancel request while a statement is running */
  private statementRunning = false;
  /** the statement runs inside a multi-statement simple query (an implicit transaction block) */
  private inImplicitBlock = false;
  /** pg_stat_activity: text and start of the current (or last) statement, and when the state last changed */
  activityQuery = '';
  activityQueryStart = 0;
  activityStateChange = 0;
  readonly activityBackendStart = Date.now();

  get isStatementRunning(): boolean {
    return this.statementRunning;
  }
  private cancelWaiters = new Set<() => void>();
  private cancelPending = false;
  private zoneCache: { name: string; spec: ZoneSpec } | null = null;
  /** reads of the transaction timestamp through `io.now` (literal input such as 'now'): an analysis that made one is not reused */
  private nowReads = 0;

  constructor(db: Database) {
    this.db = db;
    this.backendPid = db.allocatePid();
    this.collations = new Collations(() => this.catalog(), db.options.collation);
    this.typeOps = new TypeOps(() => this.catalog(), this.collations, () => this.zone());
    this.catalogFns = new CatalogFunctionsImpl(this);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.io = {
      get catalog() {
        return self.catalog();
      },
      get zone() {
        return self.zone();
      },
      now: () => {
        self.nowReads++;
        return self.transactionTimestamp();
      },
      get extraFloatDigits() {
        return parseInt(self.getSetting('extra_float_digits', false) ?? '1', 10);
      },
      get byteaOutput() {
        return (self.getSetting('bytea_output', false) ?? 'hex') as 'hex' | 'escape';
      },
      get intervalStyle() {
        return self.getSetting('IntervalStyle', false) ?? 'postgres';
      },
      resolveRelationName: (name: string) => self.resolveRelation(name),
      resolveTypeName: (name: string) => self.resolveType(name),
      resolveProcName: (name: string) => self.resolveProc(name),
      relationDisplayName: (oid: number) => self.relationDisplayName(oid),
      formatType: (oid: number, typmod: number) => new TypeUtil(self.catalog()).formatType(oid, typmod, false, false, self.searchPathNamespaces()),
      procDisplayName: (oid: number) => {
        const p = self.catalog().getProc(oid);
        return p ? p.name : String(oid);
      },
    } as IoContext & DateTimeContext;
    for (const [k, v] of Object.entries(db.options.settings)) {
      this.settings.set(k.toLowerCase(), normalizeSettingValue(k, v));
    }
    if (!this.settings.has('timezone')) {
      this.settings.set('timezone', db.options.timeZone);
    }
  }

  /** database name given by the client at connect (one in-memory database answers to any name) */
  connectedDatabaseName: string | null = null;

  get databaseName(): string {
    return this.connectedDatabaseName ?? this.db.options.databaseName;
  }

  get userName(): string {
    return this.db.options.userName;
  }

  // -------------------------------------------------------------------------
  // Catalog / name resolution
  // -------------------------------------------------------------------------

  catalog(): Catalog {
    return this.txn?.catalog ?? this.db.catalog;
  }

  zone(): ZoneSpec {
    const name = this.getSetting('TimeZone', false) ?? 'UTC';
    if (this.zoneCache && this.zoneCache.name === name) {
      return this.zoneCache.spec;
    }
    const spec = resolveZone(name) ?? resolveZone('UTC')!;
    this.zoneCache = { name, spec };
    return spec;
  }

  private searchPathNames(): string[] {
    const raw = this.getSetting('search_path', false) ?? '"$user", public';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase()));
  }

  private searchPathMemo: { catalog: Catalog; version: number; raw: string | undefined; tempNsOid: number; namespaces: number[] } | null = null;

  searchPathNamespaces(): number[] {
    // resolved once per search_path setting, catalog version and temp schema (analysis asks per name lookup)
    const cat = this.catalog();
    const raw = this.getSetting('search_path', false) ?? undefined;
    const memo = this.searchPathMemo;
    if (memo && memo.catalog === cat && memo.version === cat.version && memo.raw === raw && memo.tempNsOid === this.tempNsOid) {
      return memo.namespaces.slice();
    }
    const namespaces = this.resolveSearchPath();
    this.searchPathMemo = { catalog: cat, version: cat.version, raw, tempNsOid: this.tempNsOid, namespaces };
    return namespaces.slice();
  }

  private resolveSearchPath(): number[] {
    const cat = this.catalog();
    const out: number[] = [];
    const names = this.searchPathNames();
    if (this.tempNsOid && cat.getNamespace(this.tempNsOid)) {
      if (!names.includes('pg_temp')) {
        out.push(this.tempNsOid);
      }
    }
    if (!names.includes('pg_catalog')) {
      out.push(NS_PG_CATALOG);
    }
    for (const n of names) {
      if (n === '$user') {
        const ns = cat.findNamespace(this.userName);
        if (ns) {
          out.push(ns.oid);
        }
        continue;
      }
      if (n === 'pg_temp') {
        if (this.tempNsOid) {
          out.push(this.tempNsOid);
        }
        continue;
      }
      const ns = cat.findNamespace(n);
      if (ns && !out.includes(ns.oid)) {
        out.push(ns.oid);
      }
    }
    return out;
  }

  relationSearchPath(): number[] {
    return this.searchPathNamespaces();
  }

  functionSearchPath(): number[] {
    return this.searchPathNamespaces().filter((n) => n !== this.tempNsOid);
  }

  creationNamespace(): number {
    const cat = this.catalog();
    for (const n of this.searchPathNames()) {
      if (n === '$user') {
        const ns = cat.findNamespace(this.userName);
        if (ns) {
          return ns.oid;
        }
        continue;
      }
      if (n === 'pg_temp') {
        return this.tempNamespace(true);
      }
      const ns = cat.findNamespace(n);
      if (ns && ns.oid !== NS_PG_CATALOG) {
        return ns.oid;
      }
    }
    throw new PgError(SqlState.INVALID_SCHEMA_NAME, 'no schema has been selected to create in');
  }

  tempNamespace(create: boolean): number {
    if (this.tempNsOid && this.catalog().getNamespace(this.tempNsOid)) {
      return this.tempNsOid;
    }
    if (!create) {
      return 0;
    }
    const cat = this.ddlCatalog();
    const oid = this.db.oids.allocate();
    cat.namespaces.set(oid, { oid, name: `pg_temp_${this.backendPid % 1000}`, ownerSessionId: this.backendPid });
    cat.invalidate();
    this.tempNsOid = oid;
    return oid;
  }

  get io_(): IoContext {
    return this.io;
  }

  private parseQualifiedName(text: string): string[] {
    const parts: string[] = [];
    let i = 0;
    const s = text.trim();
    while (i < s.length) {
      if (s[i] === '"') {
        let j = i + 1;
        let name = '';
        while (j < s.length) {
          if (s[j] === '"') {
            if (s[j + 1] === '"') {
              name += '"';
              j += 2;
              continue;
            }
            break;
          }
          name += s[j];
          j++;
        }
        parts.push(name);
        i = j + 1;
      } else {
        let j = i;
        while (j < s.length && s[j] !== '.') {
          j++;
        }
        parts.push(s.slice(i, j).trim().toLowerCase());
        i = j;
      }
      if (s[i] === '.') {
        i++;
      }
    }
    return parts;
  }

  resolveRelation(name: string): number | null {
    const parts = this.parseQualifiedName(name);
    const cat = this.catalog();
    if (parts.length === 0) {
      return null;
    }
    if (parts.length >= 2) {
      const ns = cat.findNamespace(parts[parts.length - 2]);
      if (!ns) {
        return null;
      }
      return cat.findRelationInNamespace(ns.oid, parts[parts.length - 1])?.oid ?? null;
    }
    for (const ns of this.searchPathNamespaces()) {
      const rel = cat.findRelationInNamespace(ns, parts[0]);
      if (rel) {
        return rel.oid;
      }
    }
    return null;
  }

  resolveType(name: string): number | null {
    try {
      const tn = new SqlParser(name).parseTypeName();
      return new TypeUtil(this.catalog()).lookupTypeName(tn, this.relationSearchPath()).oid;
    } catch {
      return null;
    }
  }

  resolveProc(name: string): number | null {
    const parts = this.parseQualifiedName(name.replace(/\(.*\)$/, ''));
    const procs = this.catalog().findProcsByName(parts[parts.length - 1]);
    return procs.length > 0 ? procs[0].oid : null;
  }

  relationDisplayName(oid: number): string {
    const cat = this.catalog();
    const rel = cat.getRelation(oid);
    if (!rel) {
      return String(oid);
    }
    const visible = this.searchPathNamespaces();
    let name = quoteIdentifier(rel.name);
    // qualify when not the first match in the search path
    const firstMatch = visible.map((n) => cat.findRelationInNamespace(n, rel.name)).find((r) => r);
    if (!visible.includes(rel.nspOid) || (firstMatch && firstMatch.oid !== rel.oid)) {
      name = quoteIdentifier(cat.namespaceName(rel.nspOid)) + '.' + name;
    }
    return name;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  getSetting(name: string, missingOk: boolean): string | null {
    const key = name.toLowerCase();
    if (key === '__current_schema') {
      const nsps = this.searchPathNamespaces().filter((n) => n !== NS_PG_CATALOG && n !== this.tempNsOid);
      return nsps.length ? this.catalog().namespaceName(nsps[0]) : null;
    }
    if (this.txn) {
      if (this.txn.localSettings.has(key)) {
        const v = this.txn.localSettings.get(key)!;
        if (v !== null) {
          return v;
        }
      }
    }
    if (this.settings.has(key)) {
      return this.settings.get(key)!;
    }
    const dbValue = this.catalog().dbSettings.get(key);
    if (dbValue !== undefined) {
      return dbValue;
    }
    const def = settingDef(key);
    if (def) {
      if (key === 'transaction_isolation') {
        return this.txn?.isolation ?? this.getSetting('default_transaction_isolation', false);
      }
      if (key === 'transaction_read_only') {
        return this.txn ? (this.txn.readOnly ? 'on' : 'off') : this.getSetting('default_transaction_read_only', false);
      }
      if (key === 'server_encoding' || key === 'client_encoding') {
        return 'UTF8';
      }
      if (key === 'lc_collate' || key === 'lc_ctype') {
        return this.db.options.collation;
      }
      return def.boot;
    }
    if (key.includes('.')) {
      if (missingOk) {
        return null;
      }
    }
    if (missingOk) {
      return null;
    }
    throw new PgError(SqlState.UNDEFINED_OBJECT, `unrecognized configuration parameter "${name}"`);
  }

  // -------------------------------------------------------------------------
  // Read-only transactions (PreventCommandIfReadOnly / ExecCheckXactReadOnly)
  // -------------------------------------------------------------------------

  private readOnlyError(what: string): PgError {
    return new PgError(SqlState.READ_ONLY_SQL_TRANSACTION, `cannot execute ${what} in a read-only transaction`);
  }

  /** Relations in a session's temporary schema may be written in a read-only transaction. */
  isTempRelation(rel: Relation): boolean {
    return !!this.catalog().getNamespace(rel.nspOid)?.ownerSessionId;
  }

  /** Data-modifying queries and row locks on regular tables are refused (tag of the top-level statement). */
  checkReadOnlyQuery(query: Query, tag: string): void {
    if (!this.txn?.readOnly) {
      return;
    }
    const cat = this.catalog();
    const writesRegular = (q: Query): boolean => {
      if (q.commandType !== 'select' && q.resultRelation >= 0) {
        const rte = q.rtable[q.resultRelation];
        const needsWrite = q.commandType !== 'merge' || (q.mergeActions ?? []).some((a) => a.command !== 'NOTHING');
        if (needsWrite && rte && rte.kind === 'relation') {
          const rel = cat.getRelation(rte.relOid);
          if (rel && !this.isTempRelation(rel)) {
            return true;
          }
        }
      }
      return q.cteList.some((c) => c.isModifying && writesRegular(c.query));
    };
    if (writesRegular(query)) {
      throw this.readOnlyError(tag);
    }
    for (const mark of query.rowMarks) {
      const rte = query.rtable[mark.rtIndex];
      const rel = rte && rte.kind === 'relation' ? cat.getRelation(rte.relOid) : undefined;
      if (rel && !this.isTempRelation(rel)) {
        throw this.readOnlyError(`SELECT FOR ${mark.strength}`);
      }
    }
  }

  /** Utility commands that change the database are refused; SET, SHOW, LOCK, LISTEN/NOTIFY, DO, ... are not. */
  checkReadOnlyUtility(stmt: A.Statement): void {
    if (!this.txn?.readOnly) {
      return;
    }
    let tag: string | null;
    switch (stmt.kind) {
      case 'VariableSetStmt':
      case 'VariableShowStmt':
      case 'TransactionStmt':
      case 'DoStmt':
      case 'ExplainStmt':
      case 'LockStmt':
      case 'CallStmt':
      case 'PrepareStmt':
      case 'ExecuteStmt':
      case 'DeallocateStmt':
      case 'NotifyStmt':
      case 'ListenStmt':
      case 'CopyStmt':
        tag = null;
        break;
      case 'NoopStmt':
        tag = /^(DISCARD|ANALYZE|CHECKPOINT|DECLARE|CLOSE|FETCH|MOVE|SET CONSTRAINTS|LOAD|UNLISTEN|VACUUM)/.test(stmt.tag) ? null : stmt.tag;
        break;
      case 'CreateTableStmt':
        tag = 'CREATE TABLE';
        break;
      case 'CreateTableAsStmt':
        tag = stmt.isMaterializedView ? 'CREATE MATERIALIZED VIEW' : 'CREATE TABLE AS';
        break;
      case 'CreateIndexStmt':
        tag = 'CREATE INDEX';
        break;
      case 'CreateSequenceStmt':
        tag = 'CREATE SEQUENCE';
        break;
      case 'AlterSequenceStmt':
        tag = 'ALTER SEQUENCE';
        break;
      case 'AlterTableStmt':
        tag = `ALTER ${stmt.objectType}`;
        break;
      case 'DropStmt':
        tag = `DROP ${stmt.objectType}`;
        break;
      case 'TruncateStmt':
        tag = 'TRUNCATE TABLE';
        break;
      case 'CreateSchemaStmt':
        tag = 'CREATE SCHEMA';
        break;
      case 'CreateEnumStmt':
      case 'CreateCompositeTypeStmt':
        tag = 'CREATE TYPE';
        break;
      case 'CreateDomainStmt':
        tag = 'CREATE DOMAIN';
        break;
      case 'AlterEnumStmt':
      case 'AlterTypeStmt':
        tag = 'ALTER TYPE';
        break;
      case 'CreateFunctionStmt':
        tag = stmt.isProcedure ? 'CREATE PROCEDURE' : 'CREATE FUNCTION';
        break;
      case 'CreateTriggerStmt':
        tag = 'CREATE TRIGGER';
        break;
      case 'ViewStmt':
        tag = 'CREATE VIEW';
        break;
      case 'CreateExtensionStmt':
        tag = 'CREATE EXTENSION';
        break;
      case 'CreateCollationStmt':
        tag = 'CREATE COLLATION';
        break;
      case 'CreateStatsStmt':
        tag = 'CREATE STATISTICS';
        break;
      case 'CommentStmt':
        tag = 'COMMENT';
        break;
      case 'AlterDatabaseSetStmt':
        tag = 'ALTER DATABASE';
        break;
      case 'RenameStmt':
        tag = stmt.objectType === 'COLUMN' || stmt.objectType === 'CONSTRAINT' ? 'ALTER TABLE' : `ALTER ${stmt.objectType}`;
        break;
      case 'RefreshMatViewStmt':
        tag = 'REFRESH MATERIALIZED VIEW';
        break;
      default:
        tag = null;
    }
    if (tag) {
      throw this.readOnlyError(tag);
    }
  }

  /** session_replication_role = replica disables ordinary triggers, foreign-key checks included. */
  replicationRoleReplica(): boolean {
    return this.getSetting('session_replication_role', true) === 'replica';
  }

  showSetting(name: string): string {
    const v = this.getSetting(name, false);
    return displaySettingValue(name, v ?? '');
  }

  setSetting(name: string, value: string | null, isLocal: boolean): void {
    const key = name.toLowerCase();
    const def = settingDef(key);
    if (!def && !key.includes('.')) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `unrecognized configuration parameter "${name}"`);
    }
    if (def && (def.context === 'internal' || def.context === 'postmaster')) {
      throw new PgError(SqlState.CANT_CHANGE_RUNTIME_PARAM, `parameter "${def.name}" cannot be changed without restarting the server`);
    }
    let normalized = value === null ? null : normalizeSettingValue(key, value);
    if (key === 'timezone' && normalized !== null) {
      if (!resolveZone(normalized)) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid value for parameter "TimeZone": "${normalized}"`);
      }
    }
    if (key === 'transaction_isolation' && normalized !== null) {
      if (this.txn) {
        // check_transaction_isolation
        if (normalized !== this.txn.isolation && this.txn.snapshotTaken) {
          throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'SET TRANSACTION ISOLATION LEVEL must be called before any query');
        }
        if (normalized !== this.txn.isolation && this.txn.savepoints.length > 0) {
          throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'SET TRANSACTION ISOLATION LEVEL must not be called in a subtransaction');
        }
        this.txn.isolation = normalized;
      }
      return;
    }
    if (key === 'transaction_read_only' && normalized !== null) {
      if (this.txn) {
        // check_transaction_read_only
        if (normalized === 'off' && this.txn.readOnly) {
          if (this.txn.savepoints.length > 0) {
            throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'cannot set transaction read-write mode inside a read-only transaction');
          }
          if (this.txn.snapshotTaken) {
            throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'transaction read-write mode must be set before any query');
          }
        }
        this.txn.readOnly = normalized === 'on';
      }
      return;
    }
    if (isLocal) {
      if (!this.txn || !this.txn.explicit) {
        // SET LOCAL outside a transaction block only lasts for the implicit transaction
      }
      if (this.txn) {
        this.txn.localSettings.set(key, normalized);
      }
      return;
    }
    if (normalized === null) {
      this.settings.delete(key);
      if (this.txn) {
        this.txn.localSettings.delete(key);
      }
      return;
    }
    // non-local SET inside a transaction is rolled back on abort
    if (this.txn) {
      const prev = this.settings.get(key);
      this.txn.onAbort.push(() => {
        if (prev === undefined) {
          this.settings.delete(key);
        } else {
          this.settings.set(key, prev);
        }
      });
      this.txn.localSettings.delete(key);
    }
    this.settings.set(key, normalized);
    void normalized;
    normalized = null;
  }

  resetAllSettings(): void {
    this.settings.clear();
    this.settings.set('timezone', this.db.options.timeZone);
    for (const [k, v] of Object.entries(this.db.options.settings)) {
      this.settings.set(k.toLowerCase(), normalizeSettingValue(k, v));
    }
  }

  // -------------------------------------------------------------------------
  // Time / random / sequences
  // -------------------------------------------------------------------------

  transactionTimestamp(): number {
    return this.txn ? this.txn.startTs : this.clockTimestamp();
  }

  statementTimestamp(): number {
    return this.stmtTs || this.clockTimestamp();
  }

  clockTimestamp(): number {
    const ms = Date.now();
    const hr = typeof process !== 'undefined' && process.hrtime ? Number(process.hrtime.bigint() % 1000n) / 1000 : 0;
    return Math.floor(ms * 1000 + hr) - EPOCH_DIFF_US;
  }

  random(): number {
    // xorshift-ish deterministic per session
    let x = this.randState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randState = x;
    return ((x >>> 0) % 1000000007) / 1000000007;
  }

  setSeed(seed: number): void {
    this.randState = Math.floor(seed * 2147483647) || 1;
  }

  private sequence(seqOid: number): Relation {
    const rel = this.catalog().getRelation(seqOid);
    if (!rel || rel.kind !== 'S' || !rel.sequence) {
      if (rel) {
        throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is not a sequence`);
      }
      throw new PgError(SqlState.UNDEFINED_TABLE, `could not open relation with OID ${seqOid}`);
    }
    return rel;
  }

  nextval(seqOid: number): bigint {
    const rel = this.sequence(seqOid);
    if (this.txn?.readOnly && !this.isTempRelation(rel)) {
      throw this.readOnlyError('nextval()');
    }
    const s = rel.sequence!;
    const st = s.state;
    let next: bigint;
    if (!st.isCalled) {
      next = st.lastValue;
    } else {
      next = st.lastValue + s.increment;
      if ((s.increment > 0n && next > s.max) || (s.increment < 0n && next < s.min)) {
        if (!s.cycle) {
          const typeName = s.typeOid === TypeOid.int2 ? 'smallint' : s.typeOid === TypeOid.int4 ? 'integer' : 'bigint';
          void typeName;
          throw new PgError(SqlState.SEQUENCE_GENERATOR_LIMIT_EXCEEDED, `nextval: reached ${s.increment > 0n ? 'maximum' : 'minimum'} value of sequence "${rel.name}" (${s.increment > 0n ? s.max : s.min})`);
        }
        next = s.increment > 0n ? s.min : s.max;
      }
    }
    // log_cnt as nextval_internal maintains it: a record pre-logs SEQ_LOG_VALS (32) values
    const cache = Number(s.cache);
    let log = st.logCnt ?? 0;
    if (log < cache || !st.isCalled) {
      log = cache + 32;
    }
    st.logCnt = log - cache;
    st.lastValue = next;
    st.isCalled = true;
    this.currvals.set(seqOid, next);
    this.lastSeqValue = next;
    return next;
  }

  currval(seqOid: number): bigint {
    const rel = this.sequence(seqOid);
    const v = this.currvals.get(seqOid);
    if (v === undefined) {
      throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `currval of sequence "${rel.name}" is not yet defined in this session`);
    }
    return v;
  }

  setval(seqOid: number, value: bigint, isCalled: boolean): bigint {
    const rel = this.sequence(seqOid);
    if (this.txn?.readOnly && !this.isTempRelation(rel)) {
      throw this.readOnlyError('setval()');
    }
    const s = rel.sequence!;
    if (value < s.min || value > s.max) {
      throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `setval: value ${value} is out of bounds for sequence "${rel.name}" (${s.min}..${s.max})`);
    }
    s.state.lastValue = value;
    s.state.isCalled = isCalled;
    s.state.logCnt = 0;
    if (isCalled) {
      this.currvals.set(seqOid, value);
      this.lastSeqValue = value;
    }
    return value;
  }

  lastval(): bigint {
    if (this.lastSeqValue === null) {
      throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, 'lastval is not yet defined in this session');
    }
    return this.lastSeqValue;
  }

  // -------------------------------------------------------------------------
  // Misc ExecSession services
  // -------------------------------------------------------------------------

  requestSleep(ms: number, st: StatementState): void {
    if (st.sleepCounter++ < st.sleepsServed) {
      return;
    }
    throw new SleepRequest(ms);
  }

  advisoryLock(key: string, shared: boolean, wait: boolean, xactScope: boolean): boolean {
    void shared;
    const existing = this.db.advisoryLocks.get(key);
    if (existing && existing.pid !== this.backendPid) {
      if (!wait) {
        return false;
      }
      const holder = [...this.db.sessions].find((s) => s.backendPid === existing.pid);
      throw new WaitForTransaction(holder?.txn?.topXid || 0);
    }
    if (existing) {
      existing.count++;
    } else {
      this.db.advisoryLocks.set(key, { pid: this.backendPid, count: 1, xact: xactScope ? this.ensureTopXid() : 0 });
    }
    return true;
  }

  advisoryUnlock(key: string, shared: boolean): boolean {
    void shared;
    const existing = this.db.advisoryLocks.get(key);
    if (!existing || existing.pid !== this.backendPid) {
      return false;
    }
    existing.count--;
    if (existing.count <= 0) {
      this.db.advisoryLocks.delete(key);
    }
    return true;
  }

  notify(channel: string, payload: string): void {
    const txn = this.txn;
    const send = () => {
      const listeners = this.db.listeners.get(channel);
      if (listeners) {
        for (const s of listeners) {
          s.notifications.push({ channel, payload, pid: this.backendPid });
          s.onNotify?.();
        }
      }
    };
    if (txn) {
      txn.onCommit.push(send);
    } else {
      send();
    }
  }

  currentXid(): number {
    return this.ensureTopXid();
  }

  txnStatus(xid: number): string {
    const s = this.db.store.txns.getStatus(xid);
    return s === 'running' ? 'in progress' : s === 'committed' ? 'committed' : 'aborted';
  }

  relationRowCount(relOid: number): number {
    const rel = this.catalog().getRelation(relOid);
    if (!rel || !rel.storageId) {
      return 0;
    }
    return this.db.store.getHeap(rel.storageId).tuples.length;
  }

  /**
   * A SQL function whose body is a single `SELECT <expression>` — no FROM, WHERE, grouping, ordering,
   * DISTINCT, LIMIT, set operation, sub-select, aggregate or set-returning call — returning one scalar:
   * the expression, compiled once per analysis of the body, which the caller evaluates with the arguments
   * as parameters (what PostgreSQL's inline_function achieves) instead of running a nested statement for
   * every call. null for any other function. `nested` is the call's statement state (parameter types and
   * names).
   */
  sqlFunctionExpression(proc: ProcDef, nested: StatementState): { ev: Evaluator; type: number } | null {
    // like inline_function: not volatile, no SET options or SECURITY DEFINER, one scalar result
    if (
      proc.lang !== 'sql' ||
      proc.kind !== 'f' ||
      proc.volatile === 'v' ||
      proc.retset ||
      proc.rettype === TypeOid.void ||
      proc.rettype === TypeOid.record ||
      proc.returnsTable ||
      proc.outParams?.length ||
      proc.setOptions?.length ||
      proc.securityDefiner
    ) {
      return null;
    }
    let stmt: A.Statement;
    if (proc.sqlBody) {
      if (proc.sqlBody.length !== 1) {
        return null;
      }
      stmt = proc.sqlBody[0];
    } else {
      const parsed = this.db.parse(proc.body ?? '');
      if (parsed.length !== 1) {
        return null;
      }
      stmt = parsed[0].stmt;
    }
    if (stmt.kind !== 'SelectStmt') {
      return null;
    }
    const catalog = this.catalog();
    if (catalog.getType(proc.rettype)?.typtype === 'c') {
      return null;
    }
    const { query: q } = this.analyzeQueryStmt(stmt, nested.paramTypes.slice(), true, nested);
    if (compiledSqlFunctions.has(q)) {
      return compiledSqlFunctions.get(q)!;
    }
    const visible = q.targetList.filter((t) => !t.resjunk);
    const simple =
      q.commandType === 'select' &&
      q.rtable.length === 0 &&
      q.cteList.length === 0 &&
      !q.where &&
      q.groupClause.length === 0 &&
      !q.groupingSets &&
      !q.havingQual &&
      !q.distinctClause &&
      q.sortClause.length === 0 &&
      !q.limitCount &&
      !q.limitOffset &&
      q.rowMarks.length === 0 &&
      !q.setOperations &&
      !q.hasAggs &&
      !q.hasWindowFuncs &&
      !q.hasTargetSRFs &&
      visible.length === 1 &&
      q.targetList.length === 1 &&
      selfContainedExpr(visible[0].expr);
    let compiled: { ev: Evaluator; type: number } | null = null;
    if (simple) {
      const env: CompileEnv = {
        catalog,
        typeOps: this.typeOps,
        runner: {
          run: () => {
            throw new PgError(SqlState.INTERNAL_ERROR, 'a sub-select in an inlined SQL function');
          },
        } as unknown as CompileEnv['runner'],
        rtInfo: () => undefined,
      };
      compiled = { ev: compileExpr(visible[0].expr, env), type: visible[0].expr.type };
    }
    compiledSqlFunctions.set(q, compiled);
    return compiled;
  }

  callUserFunction(proc: ProcDef, args: unknown[], argTypes: number[], st: StatementState): { value: unknown; rows?: unknown[][] } {
    if (proc.lang === 'sql') {
      return callSqlFunction(this, proc, args, argTypes, st);
    }
    if (proc.lang === 'plpgsql') {
      return callPlpgsqlFunction(this, proc, args, argTypes, st);
    }
    if (proc.lang === 'internal' || proc.lang === 'c') {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: function ${proc.name} (${proc.lang}) is not implemented`);
    }
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: language "${proc.lang}" is not supported`);
  }

  runNestedSql(sql: string, params: unknown[], st: StatementState): { rows: unknown[][]; fields: { name: string; type: number }[]; rowCount: number } {
    const stmts = this.db.parse(sql);
    let last: StatementResult | null = null;
    for (const ps of stmts) {
      last = this.executeParsedSync(ps, params, null, st);
    }
    if (!last) {
      return { rows: [], fields: [], rowCount: 0 };
    }
    return { rows: last.rows, fields: last.fields.map((f) => ({ name: f.name, type: f.typeOid })), rowCount: last.rowCount ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  private newTxn(explicit: boolean): TxnState {
    return {
      topXid: 0,
      explicit,
      failed: false,
      isolation: this.getSettingNoTxn('default_transaction_isolation') ?? 'read committed',
      readOnly: (this.getSetting('default_transaction_read_only', true) ?? 'off') === 'on',
      startTs: this.clockTimestamp(),
      snapshot: null,
      cid: 0,
      catalog: null,
      catalogFrozen: false,
      holdsDdlLock: false,
      savepoints: [],
      localSettings: new Map(),
      createdStorage: [],
      droppedStorage: [],
      preCommit: [],
      onCommit: [],
      onAbort: [],
      deferredChecks: [],
      constraintModes: new Map(),
      constraintAllMode: null,
    };
  }

  // -------------------------------------------------------------------------
  // Deferred constraints
  // -------------------------------------------------------------------------

  /** Whether checks of a DEFERRABLE constraint are currently deferred in this transaction. */
  isConstraintDeferred(con: Constraint): boolean {
    if (!con.deferrable) {
      return false;
    }
    const txn = this.txn;
    const explicit = txn?.constraintModes.get(con.oid);
    if (explicit !== undefined) {
      return explicit;
    }
    if (txn && txn.constraintAllMode !== null) {
      return txn.constraintAllMode;
    }
    return con.initiallyDeferred;
  }

  deferConstraintCheck(check: DeferredConstraintCheck): void {
    this.txn!.deferredChecks.push(check);
  }

  /** SET CONSTRAINTS: change modes, then run the queued checks of constraints that became immediate. */
  setConstraints(spec: { all: boolean; names: string[][]; deferred: boolean }): void {
    const txn = this.txn;
    if (!txn || !txn.explicit) {
      this.notice('WARNING', SqlState.NO_ACTIVE_SQL_TRANSACTION, 'SET CONSTRAINTS can only be used in transaction blocks');
      return;
    }
    if (spec.all) {
      txn.constraintModes.clear();
      txn.constraintAllMode = spec.deferred;
    } else {
      const cat = this.catalog();
      for (const name of spec.names) {
        const conName = name[name.length - 1];
        const nspOids = name.length > 1 ? [cat.findNamespace(name[name.length - 2])?.oid ?? -1] : this.searchPathNamespaces();
        let found: Constraint[] = [];
        for (const nsp of nspOids) {
          found = [...cat.constraints.values()].filter((c) => c.name === conName && c.nspOid === nsp && (c.type === 'f' || c.type === 'u' || c.type === 'p' || c.type === 'x' || c.type === 't'));
          if (found.length > 0) {
            break;
          }
        }
        if (found.length === 0) {
          throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${name.join('.')}" does not exist`);
        }
        for (const c of found) {
          if (!c.deferrable) {
            throw new PgError(SqlState.WRONG_OBJECT_TYPE, `constraint "${name.join('.')}" is not deferrable`);
          }
          txn.constraintModes.set(c.oid, spec.deferred);
        }
      }
    }
    if (!spec.deferred) {
      this.runDeferredChecks(false);
    }
  }

  /** Run queued deferred checks: all of them (COMMIT), or those whose constraint is no longer deferred. */
  runDeferredChecks(all: boolean): void {
    const txn = this.txn;
    if (!txn || txn.deferredChecks.length === 0) {
      return;
    }
    const due = all ? txn.deferredChecks : txn.deferredChecks.filter((c) => !this.isConstraintDeferred(c.constraint));
    if (due.length === 0) {
      return;
    }
    const st = new StatementState(this, this.catalog(), [], [], this.takeSnapshot());
    st.cid = txn.cid;
    const host = new SessionHost(this, st);
    const executor = new Executor(st, host);
    host.executor = executor;
    const dml = new DmlExecutor(host, executor);
    for (const check of due) {
      check.run(dml);
    }
    // dequeued only once all fired: a failure leaves the queue as it was (for ROLLBACK TO SAVEPOINT)
    txn.deferredChecks = all ? [] : txn.deferredChecks.filter((c) => !due.includes(c));
  }

  private getSettingNoTxn(name: string): string | null {
    return this.settings.get(name) ?? settingDef(name)?.boot ?? null;
  }

  ensureTopXid(): number {
    const txn = this.txn!;
    if (!txn.topXid) {
      txn.topXid = this.db.store.txns.begin();
      for (const sp of txn.savepoints) {
        if (!sp.xid) {
          sp.xid = this.db.store.txns.begin(txn.topXid);
        }
      }
    }
    return txn.topXid;
  }

  /** xid used for writes (innermost subtransaction). */
  currentWriteXid(): number {
    const txn = this.txn!;
    this.ensureTopXid();
    const sp = txn.savepoints[txn.savepoints.length - 1];
    if (sp) {
      if (!sp.xid) {
        sp.xid = this.db.store.txns.begin(txn.topXid);
      }
      return sp.xid;
    }
    return txn.topXid;
  }

  /** The snapshot this session's transaction keeps across statements (REPEATABLE READ / SERIALIZABLE), if any. */
  heldSnapshot(): Snapshot | null {
    return this.txn?.snapshot ?? null;
  }

  /** A statement wrote to `heap` (`inserted`: a new tuple version): candidates for autovacuum at transaction end. */
  noteHeapWrite(heap: Heap, inserted: boolean): void {
    this.db.store.noteWrite(heap);
    const txn = this.txn;
    if (inserted && txn) {
      const inserts = (txn.inserts ??= new Map());
      inserts.set(heap, (inserts.get(heap) ?? 0) + 1);
    }
  }

  takeSnapshot(): Snapshot {
    const txns = this.db.store.txns;
    const txn = this.txn!;
    txn.snapshotTaken = true;
    if ((txn.isolation === 'repeatable read' || txn.isolation === 'serializable') && txn.snapshot) {
      return { ...txn.snapshot, ownXid: txn.topXid, curCid: txn.cid };
    }
    const xip = new Set<number>();
    for (const x of txns.running) {
      if (x !== txn.topXid) {
        xip.add(x);
      }
    }
    const snap: Snapshot = { xmax: txns.nextXid, xip, ownXid: txn.topXid, curCid: txn.cid };
    if (txn.isolation === 'repeatable read' || txn.isolation === 'serializable') {
      txn.snapshot = snap;
    }
    return snap;
  }

  /** Get a writable catalog for DDL (acquires the database DDL lock). */
  ddlCatalog(): Catalog {
    const txn = this.txn;
    if (!txn) {
      throw new PgError(SqlState.INTERNAL_ERROR, 'DDL outside a transaction');
    }
    if (!txn.holdsDdlLock) {
      const xid = this.ensureTopXid();
      const holder = this.db.ddlLockHolder;
      if (holder && holder !== xid && this.db.store.txns.isRunning(holder)) {
        throw new WaitForTransaction(holder);
      }
      this.db.ddlLockHolder = xid;
      txn.holdsDdlLock = true;
    }
    if (!txn.catalog) {
      txn.catalog = this.db.catalog.clone();
    } else if (txn.catalogFrozen) {
      txn.catalog = txn.catalog.clone();
      txn.catalogFrozen = false;
    }
    return txn.catalog;
  }

  private beginImplicit(): void {
    if (!this.txn) {
      this.txn = this.newTxn(false);
    }
  }

  commitTxn(): void {
    const txn = this.txn;
    if (!txn) {
      return;
    }
    if (txn.preCommit.length > 0) {
      // ON COMMIT actions run inside the committing transaction; a failing one aborts it instead
      try {
        for (const fn of txn.preCommit.splice(0)) {
          fn();
        }
      } catch (e) {
        this.abortTxn();
        throw e;
      }
    }
    if (txn.deferredChecks.length > 0) {
      // deferred constraint checks fire before the commit; a violation aborts the transaction instead
      try {
        this.runDeferredChecks(true);
      } catch (e) {
        this.abortTxn();
        throw e;
      }
    }
    if (txn.catalog) {
      this.db.catalog = txn.catalog;
    }
    const txns = this.db.store.txns;
    for (const sp of txn.savepoints) {
      if (sp.xid) {
        txns.commitSub(sp.xid);
      }
    }
    if (txn.topXid) {
      txns.commit(txn.topXid);
    }
    if (txn.holdsDdlLock && this.db.ddlLockHolder === txn.topXid) {
      this.db.ddlLockHolder = 0;
    }
    for (const id of txn.droppedStorage) {
      this.db.store.dropHeap(id);
    }
    this.releaseXactAdvisoryLocks(txn.topXid);
    this.txn = null;
    for (const fn of txn.onCommit) {
      fn();
    }
    if (txn.topXid) {
      this.db.autovacuum();
    }
  }

  abortTxn(): void {
    const txn = this.txn;
    if (!txn) {
      return;
    }
    const txns = this.db.store.txns;
    for (const sp of txn.savepoints) {
      if (sp.xid) {
        txns.abortSub(sp.xid);
      }
    }
    if (txn.topXid) {
      txns.abort(txn.topXid);
    }
    if (txn.holdsDdlLock && this.db.ddlLockHolder === txn.topXid) {
      this.db.ddlLockHolder = 0;
    }
    for (const id of txn.createdStorage) {
      this.db.store.dropHeap(id);
    }
    if (txn.catalog && this.tempNsOid && !this.db.catalog.getNamespace(this.tempNsOid)) {
      this.tempNsOid = 0;
    }
    this.releaseXactAdvisoryLocks(txn.topXid);
    this.txn = null;
    for (const fn of txn.onAbort.reverse()) {
      fn();
    }
    if (txn.topXid) {
      // the transaction's inserts are dead versions now
      for (const [heap, count] of txn.inserts ?? []) {
        heap.deadCount += count;
      }
      this.db.autovacuum();
    }
  }

  private releaseXactAdvisoryLocks(xid: number): void {
    if (!xid) {
      return;
    }
    for (const [k, v] of this.db.advisoryLocks) {
      if (v.xact === xid) {
        this.db.advisoryLocks.delete(k);
      }
    }
  }

  private executeTransactionStmt(stmt: A.TransactionStmt): StatementResult {
    const empty = (command: string): StatementResult => ({ command, rowCount: null, fields: [], rows: [], hasRows: false });
    switch (stmt.op) {
      case 'BEGIN':
      case 'START': {
        if (this.txn && this.txn.explicit) {
          this.notice('WARNING', SqlState.ACTIVE_SQL_TRANSACTION, 'there is already a transaction in progress');
          return empty(stmt.op === 'START' ? 'START TRANSACTION' : 'BEGIN');
        }
        if (!this.txn) {
          this.txn = this.newTxn(true);
        }
        this.txn.explicit = true;
        if (stmt.options.isolation) {
          this.txn.isolation = stmt.options.isolation;
        }
        if (stmt.options.readOnly !== undefined) {
          this.txn.readOnly = stmt.options.readOnly;
        }
        return empty(stmt.op === 'START' ? 'START TRANSACTION' : 'BEGIN');
      }
      case 'COMMIT': {
        if (!this.txn || !this.txn.explicit) {
          this.notice('WARNING', SqlState.NO_ACTIVE_SQL_TRANSACTION, 'there is no transaction in progress');
          if (this.txn) {
            this.commitTxn();
          }
          return empty('COMMIT');
        }
        if (this.txn.failed) {
          this.abortTxn();
          return empty('ROLLBACK');
        }
        this.commitTxn();
        return empty('COMMIT');
      }
      case 'ROLLBACK': {
        if (!this.txn || !this.txn.explicit) {
          this.notice('WARNING', SqlState.NO_ACTIVE_SQL_TRANSACTION, 'there is no transaction in progress');
        }
        if (this.txn) {
          this.abortTxn();
        }
        return empty('ROLLBACK');
      }
      case 'SAVEPOINT': {
        const txn = this.requireTxnBlock('SAVEPOINT');
        const sp: Savepoint = {
          name: stmt.savepointName!,
          xid: txn.topXid ? this.db.store.txns.begin(txn.topXid) : 0,
          catalog: txn.catalog,
          localSettings: new Map(txn.localSettings),
          deferredChecks: txn.deferredChecks.length,
        };
        if (txn.catalog) {
          txn.catalogFrozen = true;
        }
        txn.savepoints.push(sp);
        return empty('SAVEPOINT');
      }
      case 'RELEASE': {
        const txn = this.requireTxnBlock('RELEASE SAVEPOINT');
        const idx = this.findSavepoint(txn, stmt.savepointName!);
        const released = txn.savepoints.splice(idx);
        for (const sp of released) {
          if (sp.xid) {
            this.db.store.txns.commitSub(sp.xid);
          }
        }
        // subcommitted xids: re-parent tuples to the enclosing (sub)transaction is implicit via parent chain
        return empty('RELEASE');
      }
      case 'ROLLBACK_TO': {
        const txn = this.requireTxnBlock('ROLLBACK TO SAVEPOINT');
        const idx = this.findSavepoint(txn, stmt.savepointName!);
        const sp = txn.savepoints[idx];
        const removed = txn.savepoints.splice(idx);
        for (const r of removed.reverse()) {
          if (r.xid) {
            this.db.store.txns.abortSub(r.xid);
          }
        }
        txn.catalog = sp.catalog;
        txn.catalogFrozen = !!sp.catalog;
        txn.localSettings = new Map(sp.localSettings);
        txn.failed = false;
        if (sp.deferredChecks !== undefined && txn.deferredChecks.length > sp.deferredChecks) {
          txn.deferredChecks.length = sp.deferredChecks;
        }
        // re-establish the savepoint
        txn.savepoints.push({ name: sp.name, xid: txn.topXid ? this.db.store.txns.begin(txn.topXid) : 0, catalog: txn.catalog, localSettings: new Map(txn.localSettings), deferredChecks: txn.deferredChecks.length });
        return empty('ROLLBACK');
      }
      default:
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: ${stmt.op} is not supported`);
    }
  }

  private requireTxnBlock(what: string): TxnState {
    if (!this.txn || !this.txn.explicit) {
      throw new PgError(SqlState.NO_ACTIVE_SQL_TRANSACTION, `${what} can only be used in transaction blocks`);
    }
    return this.txn;
  }

  private findSavepoint(txn: TxnState, name: string): number {
    for (let i = txn.savepoints.length - 1; i >= 0; i--) {
      if (txn.savepoints[i].name === name) {
        return i;
      }
    }
    throw new PgError('3B001', `savepoint "${name}" does not exist`);
  }

  // -------------------------------------------------------------------------
  // Statement execution
  // -------------------------------------------------------------------------

  /**
   * Execute SQL. `params === undefined` uses the simple protocol (multiple statements allowed);
   * otherwise the extended protocol with text parameters (exactly one statement).
   */
  async execute(sql: string, params?: (string | Uint8Array | null)[], options: { timeoutMs?: number } = {}): Promise<StatementResult[]> {
    if (this.closed) {
      throw new PgError(SqlState.ADMIN_SHUTDOWN, 'terminating connection due to administrator command');
    }
    const parsed = this.db.parse(sql);
    const extended = params !== undefined;
    if (extended && parsed.length > 1) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'cannot insert multiple commands into a prepared statement');
    }
    const results: StatementResult[] = [];
    if (parsed.length === 0) {
      return [{ command: '', rowCount: null, fields: [], rows: [], hasRows: false }];
    }
    const multi = parsed.length > 1;
    for (const ps of parsed) {
      results.push(await this.executeStatement(ps, extended ? params! : [], multi, options.timeoutMs));
    }
    // implicit transaction of a multi-statement simple query commits at the end
    if (multi && this.txn && !this.txn.explicit) {
      if (this.txn.failed) {
        this.abortTxn();
      } else {
        this.commitTxn();
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Extended protocol phases (Parse / Bind / Execute / Sync)
  // -------------------------------------------------------------------------

  private checkNotFailed(stmt: A.Statement | null): void {
    if (this.txn && this.txn.failed) {
      if (stmt && stmt.kind === 'TransactionStmt' && (stmt.op === 'ROLLBACK' || stmt.op === 'ROLLBACK_TO' || stmt.op === 'COMMIT')) {
        return;
      }
      throw new PgError(SqlState.IN_FAILED_SQL_TRANSACTION, 'current transaction is aborted, commands ignored until end of transaction block');
    }
  }

  /** Parse message: analyze one statement with client-declared parameter types (0 = infer). */
  prepare(sql: string, declaredTypes: number[]): PreparedInfo {
    const catalog = this.catalog();
    const catalogVersion = catalog.version;
    const info = this.prepareInner(sql, declaredTypes);
    return { ...info, sql, declaredTypes: declaredTypes.slice(), catalog, catalogVersion };
  }

  /**
   * RevalidateCachedQuery: a cached statement whose catalog changed is re-analyzed; a changed result
   * row shape is an error (clients such as postgres.js re-prepare on it).
   */
  revalidate(info: PreparedInfo): PreparedInfo {
    const catalog = this.catalog();
    if (!info.sql || (info.catalog === catalog && info.catalogVersion === catalog.version)) {
      return info;
    }
    const fresh = this.prepare(info.sql, info.declaredTypes ?? []);
    const a = info.fields;
    const b = fresh.fields;
    const same = (a === null && b === null) || (!!a && !!b && a.length === b.length && a.every((f, i) => f.typeOid === b[i].typeOid && f.typmod === b[i].typmod));
    if (!same) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'cached plan must not change result type', { routine: 'RevalidateCachedQuery' });
    }
    return { ...fresh, name: info.name, paramTypes: info.paramTypes };
  }

  private prepareInner(sql: string, declaredTypes: number[]): PreparedInfo {
    if (this.closed) {
      throw new PgError(SqlState.ADMIN_SHUTDOWN, 'terminating connection due to administrator command');
    }
    const parsed = this.db.parse(sql);
    if (parsed.length > 1) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'cannot insert multiple commands into a prepared statement');
    }
    if (parsed.length === 0) {
      this.checkNotFailed(null);
      return { ps: null, paramTypes: declaredTypes.slice(), fields: null };
    }
    const ps = parsed[0];
    const stmt = ps.stmt;
    this.checkNotFailed(stmt);
    switch (stmt.kind) {
      case 'SelectStmt':
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
      case 'MergeStmt':
        return { ps, ...this.describePreparable(stmt, declaredTypes) };
      case 'CreateTableAsStmt':
      case 'ExplainStmt': {
        // utility statements wrapping an analyzable query infer parameter types from it
        const inner = stmt.query;
        const an = this.makeAnalyzer(declaredTypes, false);
        if (inner.kind === 'SelectStmt' || inner.kind === 'InsertStmt' || inner.kind === 'UpdateStmt' || inner.kind === 'DeleteStmt' || inner.kind === 'MergeStmt') {
          analyzeStatementAsSubquery(an, inner, null, true);
        }
        for (let i = 0; i < an.paramTypes.length; i++) {
          if (!an.paramTypes[i] || an.paramTypes[i] === TypeOid.unknown) {
            throw new PgError(SqlState.INDETERMINATE_DATATYPE, `could not determine data type of parameter $${i + 1}`);
          }
        }
        return { ps, paramTypes: an.paramTypes.slice(), fields: describeUtility(this, stmt) };
      }
      default:
        return { ps, paramTypes: declaredTypes.slice(), fields: describeUtility(this, stmt) };
    }
  }

  /**
   * Analyze a preparable statement (SELECT / INSERT / UPDATE / DELETE / MERGE) with declared parameter
   * types (0 = infer): every parameter type must be determined; fields is null when no rows are returned.
   */
  describePreparable(stmt: A.Statement, declaredTypes: number[]): { paramTypes: number[]; fields: FieldInfo[] | null } {
    const an = this.makeAnalyzer(declaredTypes, false);
    const { query } = analyzeStatementAsSubquery(an, stmt, null, true);
    for (let i = 0; i < an.paramTypes.length; i++) {
      if (!an.paramTypes[i] || an.paramTypes[i] === TypeOid.unknown) {
        throw new PgError(SqlState.INDETERMINATE_DATATYPE, `could not determine data type of parameter $${i + 1}`);
      }
    }
    const hasRows = query.commandType === 'select' || query.returningList.length > 0;
    const list = query.commandType === 'select' ? query.targetList : query.returningList;
    const fields = hasRows ? list.filter((t) => !t.resjunk).map((t) => ({ name: t.name, typeOid: t.expr.type, typmod: t.expr.typmod, tableOid: t.origTable, columnAttnum: t.origColumn })) : null;
    return { paramTypes: an.paramTypes.slice(), fields };
  }

  /** Bind message: convert wire parameter values into typed datums. */
  bindParams(info: PreparedInfo, values: (Uint8Array | null)[], formats: number[]): unknown[] {
    this.checkNotFailed(info.ps?.stmt ?? null);
    if (values.length !== info.paramTypes.length) {
      throw new PgError(SqlState.PROTOCOL_VIOLATION, `bind message supplies ${values.length} parameters, but prepared statement "${info.name ?? ''}" requires ${info.paramTypes.length}`);
    }
    return values.map((v, i) => {
      if (v === null) {
        return null;
      }
      const type = info.paramTypes[i];
      const format = formats.length === 0 ? 0 : formats.length === 1 ? formats[0] : formats[i];
      if (format === 1) {
        return receiveBinary(type, v, this.io, i + 1);
      }
      if (format !== 0) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unsupported format code: ${format}`);
      }
      return inputValue(type, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8'), -1, this.io);
    });
  }

  /** Execute message: run a bound statement inside the pipeline's implicit transaction. */
  async executeBound(info: PreparedInfo, typedParams: unknown[]): Promise<StatementResult> {
    if (!info.ps) {
      return { command: '', rowCount: null, fields: [], rows: [], hasRows: false };
    }
    return this.executeStatement(info.ps, typedParams, true, undefined, info.paramTypes);
  }

  /** Simple query protocol: run one statement of a (possibly multi-statement) query string. */
  async executeSimple(ps: A.ParsedStatement, multi: boolean): Promise<StatementResult> {
    this.inImplicitBlock = multi;
    try {
      // exec_simple_query analyzes with no parameters: `$1` is "there is no parameter $1"
      return await this.executeStatement(ps, [], multi, undefined, []);
    } finally {
      this.inImplicitBlock = false;
    }
  }

  /**
   * ExecuteCallStmt / ExecuteDoStmt `atomic`: a top-level CALL or DO outside a transaction block
   * (and outside a multi-statement query string, an implicit block) may COMMIT / ROLLBACK; nested
   * ones inherit the flag of the statement that runs them.
   */
  nonAtomicContext(parentSt: StatementState | null): boolean {
    if (parentSt) {
      return parentSt.nonAtomic;
    }
    return !this.txn?.explicit && !this.inImplicitBlock;
  }

  /** COMMIT / ROLLBACK [AND CHAIN] inside a procedure: finish the transaction and start the next one. */
  procedureTransactionEnd(commit: boolean, chain: boolean, st: StatementState): void {
    const txn = this.txn!;
    const { isolation, readOnly } = txn;
    if (commit && !txn.failed) {
      st.runAfterQueue();
      this.commitTxn();
    } else {
      this.abortTxn();
    }
    // committed / aborted changes are final: a later statement restart must not undo them
    st.undo?.clear();
    this.txn = this.newTxn(false);
    if (chain) {
      this.txn.isolation = isolation;
      this.txn.readOnly = readOnly;
    }
  }

  /** Run a procedure; returns its INOUT / OUT values as a row, or null when it has none. */
  callProcedure(proc: ProcDef, args: unknown[], argTypes: number[], st: StatementState): { fields: FieldInfo[]; values: unknown[] } | null {
    if (proc.lang === 'plpgsql') {
      const r = callPlpgsqlFunction(this, proc, args, argTypes, st);
      return r.outputs ?? null;
    }
    this.callUserFunction(proc, args, argTypes, st);
    return null;
  }

  /** Sync message / end of a simple query: finish the implicit transaction. */
  sync(): void {
    if (this.txn && !this.txn.explicit) {
      if (this.txn.failed) {
        this.abortTxn();
      } else {
        this.commitTxn();
      }
    }
  }

  /** ReadyForQuery transaction status indicator. */
  transactionStatus(): 'I' | 'T' | 'E' {
    if (!this.txn || !this.txn.explicit) {
      return 'I';
    }
    return this.txn.failed ? 'E' : 'T';
  }

  private async executeStatement(ps: A.ParsedStatement, params: unknown[], inMulti: boolean, timeoutOverride?: number, boundTypes?: number[]): Promise<StatementResult> {
    const stmt = ps.stmt;
    this.activityQuery = ps.text;
    this.activityQueryStart = this.activityStateChange = this.clockTimestamp();
    if (stmt.kind === 'TransactionStmt') {
      if (this.txn && this.txn.failed && stmt.op !== 'ROLLBACK' && stmt.op !== 'ROLLBACK_TO' && stmt.op !== 'COMMIT') {
        throw new PgError(SqlState.IN_FAILED_SQL_TRANSACTION, 'current transaction is aborted, commands ignored until end of transaction block');
      }
      return this.executeTransactionStmt(stmt);
    }
    if (this.txn && this.txn.failed) {
      throw new PgError(SqlState.IN_FAILED_SQL_TRANSACTION, 'current transaction is aborted, commands ignored until end of transaction block');
    }
    const implicit = !this.txn;
    this.beginImplicit();
    const txn = this.txn!;
    this.stmtTs = this.clockTimestamp();
    const started = Date.now();
    const timeoutSetting = timeoutOverride ?? parseInt(this.getSetting('statement_timeout', false) ?? '0', 10);
    let sleepsServed = 0;
    this.statementRunning = true;
    this.cancelPending = false;
    try {
      for (;;) {
        const undo = new UndoLog();
        const cidBefore = txn.cid;
        try {
          const result = this.executeParsedSync(ps, params, undo, null, sleepsServed, boundTypes);
          if (implicit && !inMulti && this.txn && !this.txn.explicit) {
            this.commitTxn();
          }
          return result;
        } catch (e) {
          if (e instanceof WaitForTransaction) {
            undo.rollback();
            txn.cid = cidBefore;
            await this.waitForXid(e.xid, started, timeoutSetting);
            continue;
          }
          if (e instanceof SleepRequest) {
            undo.rollback();
            txn.cid = cidBefore;
            const elapsed = Date.now() - started;
            const remaining = timeoutSetting > 0 ? timeoutSetting - elapsed : Infinity;
            if (e.ms >= remaining) {
              await this.interruptible(delay(Math.max(0, remaining)));
              throw new PgError(SqlState.QUERY_CANCELED, 'canceling statement due to statement timeout');
            }
            await this.interruptible(delay(e.ms));
            sleepsServed++;
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (this.txn) {
        if (this.txn.explicit || inMulti) {
          this.txn.failed = true;
        } else {
          this.abortTxn();
        }
      }
      throw e;
    } finally {
      this.statementRunning = false;
      this.cancelPending = false;
      this.activityStateChange = this.clockTimestamp();
    }
  }

  /**
   * ereport below ERROR: delivered to the client when the level reaches client_min_messages
   * (INFO always is). Levels: DEBUG[1-5], LOG, INFO, NOTICE, WARNING.
   */
  notice(level: string, code: string, message: string, fields?: PgErrorFields): void {
    if (!this.onNotice) {
      return;
    }
    const rank = (l: string): number => {
      const u = l.toUpperCase();
      const m = /^DEBUG([1-5])?$/.exec(u);
      if (m) {
        return 15 - Number(m[1] ?? 2);
      }
      return u === 'LOG' ? 15 : u === 'INFO' ? 17 : u === 'NOTICE' ? 18 : u === 'WARNING' ? 19 : 20;
    };
    const upper = level.toUpperCase();
    if (upper !== 'INFO' && rank(upper) < rank(this.getSetting('client_min_messages', true) ?? 'notice')) {
      return;
    }
    const severity = upper.startsWith('DEBUG') ? 'DEBUG' : upper;
    this.onNotice(new PgError(code, message, fields, severity));
  }

  /** Cancel request (protocol CancelRequest / pg_cancel_backend) for the running statement. */
  requestCancel(): void {
    if (!this.statementRunning) {
      return;
    }
    this.cancelPending = true;
    for (const w of [...this.cancelWaiters]) {
      w();
    }
  }

  private async interruptible<T>(p: Promise<T>): Promise<T> {
    if (this.cancelPending) {
      throw new PgError(SqlState.QUERY_CANCELED, 'canceling statement due to user request');
    }
    let waiter: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      waiter = () => reject(new PgError(SqlState.QUERY_CANCELED, 'canceling statement due to user request'));
      this.cancelWaiters.add(waiter);
    });
    try {
      return await Promise.race([p, cancelled]);
    } finally {
      this.cancelWaiters.delete(waiter!);
    }
  }

  private async waitForXid(xid: number, started: number, timeoutMs: number): Promise<void> {
    const txns = this.db.store.txns;
    if (!xid || txns.getStatus(xid) !== 'running') {
      await delay(0);
      return;
    }
    const top = txns.topLevel(xid);
    // deadlock detection
    const myXid = this.txn?.topXid ?? 0;
    if (top === myXid) {
      // waiting on ourselves can never end: an engine visibility bug, reported instead of hanging
      throw new PgError(SqlState.INTERNAL_ERROR, `in-memory engine: statement waits on its own transaction ${top}`);
    }
    let cur = top;
    const seen = new Set<number>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const holder = [...this.db.sessions].find((s) => s.txn?.topXid === cur);
      if (!holder) {
        break;
      }
      if (holder.waitingFor === myXid && myXid) {
        throw new PgError(SqlState.DEADLOCK_DETECTED, 'deadlock detected', {
          detail: `Process ${this.backendPid} waits for ShareLock on transaction ${top}; blocked by process ${holder.backendPid}.`,
          hint: 'See server log for query details.',
        });
      }
      cur = holder.waitingFor;
    }
    this.waitingFor = top;
    try {
      const wait = txns.waitFor(top);
      if (timeoutMs > 0) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) {
          throw new PgError(SqlState.QUERY_CANCELED, 'canceling statement due to statement timeout');
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          const timedOut = await this.interruptible(
            Promise.race([
              wait.then(() => false),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), remaining);
              }),
            ])
          );
          if (timedOut) {
            throw new PgError(SqlState.QUERY_CANCELED, 'canceling statement due to statement timeout');
          }
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
      } else {
        await this.interruptible(wait);
      }
    } finally {
      this.waitingFor = 0;
    }
  }

  /** Synchronous execution of one statement within the current transaction. */
  executeParsedSync(ps: A.ParsedStatement, params: unknown[], undo: UndoLog | null, parentSt: StatementState | null, sleepsServed = 0, boundTypes?: number[]): StatementResult {
    const stmt = ps.stmt;
    const txn = this.txn!;
    switch (stmt.kind) {
      case 'SelectStmt':
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
      case 'MergeStmt':
        return this.executeQueryStmt(stmt, ps.text, params, undo, parentSt, sleepsServed, boundTypes);
      case 'TransactionStmt':
        return this.executeTransactionStmt(stmt);
      default: {
        // PlannedStmtRequiresSnapshot: every utility statement but these runs with a snapshot
        if (stmt.kind !== 'VariableSetStmt' && stmt.kind !== 'VariableShowStmt' && stmt.kind !== 'LockStmt' && !(stmt.kind === 'NoopStmt' && stmt.tag === 'SET CONSTRAINTS')) {
          txn.snapshotTaken = true;
        }
        this.checkReadOnlyUtility(stmt);
        const r: UtilityResult = executeUtility(this, stmt, ps.text, params, parentSt, boundTypes, undo);
        txn.cid++;
        return { command: r.command, rowCount: r.rowCount ?? null, fields: r.fields ?? [], rows: r.rows ?? [], hasRows: !!r.fields && r.fields.length > 0 };
      }
    }
  }

  makeAnalyzer(paramTypes: number[] = [], fixed = false): Analyzer {
    return new Analyzer(this, paramTypes, fixed);
  }

  /** The CHECK constraints of a domain, compiled; `VALUE` is executor parameter `slot` (per catalog). */
  domainChecks(domain: PgType): { name: string; ev: Evaluator; slot: number }[] {
    const checks = domain.domainChecks ?? [];
    if (checks.length === 0) {
      return [];
    }
    const cat = this.catalog();
    let perCatalog = compiledDomainChecks.get(cat);
    if (!perCatalog || perCatalog.version !== cat.version) {
      perCatalog = { version: cat.version, checks: new Map() };
      compiledDomainChecks.set(cat, perCatalog);
    }
    return checks.map((chk) => {
      let entry = perCatalog!.checks.get(chk);
      if (!entry) {
        const an = this.makeAnalyzer();
        an.domainValue = { slot: DOMAIN_VALUE_SLOT, type: domain.baseType, typmod: domain.typmod, collation: domain.collation };
        const pstate = new ParseState(null, emptyQuery());
        const expr = an.coerceToBoolean(pstate, transformExpr(an, pstate, chk.expr.raw, 'domain_check'), 'CHECK');
        const env: CompileEnv = {
          catalog: cat,
          typeOps: this.typeOps,
          runner: {
            run: () => {
              throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'cannot use subquery in check constraint');
            },
          } as unknown as CompileEnv['runner'],
          rtInfo: () => undefined,
        };
        entry = { name: chk.name, ev: compileExpr(expr, env), slot: DOMAIN_VALUE_SLOT };
        perCatalog!.checks.set(chk, entry);
      }
      return entry;
    });
  }

  /**
   * The analyzed form of a SELECT / INSERT / UPDATE / DELETE / MERGE, reused while nothing it depends on
   * changed (like PostgreSQL's plan cache for prepared statements and PL/pgSQL statements): the parse tree,
   * the catalog (object and version), the parameter types and names, the trigger transition tables in
   * scope, the search path and the settings literal input reads. An analysis that read the transaction
   * timestamp (a 'now' literal) is not reused.
   */
  private analyzeQueryStmt(stmt: A.Statement, paramTypesIn: number[], fixed: boolean, parentSt: StatementState | null): { query: Query; paramTypes: number[] } {
    const catalog = this.catalog();
    const transition = parentSt?.transitionTables;
    const key =
      (fixed ? 'f' : 'v') +
      paramTypesIn.join(',') +
      '|' +
      (parentSt ? parentSt.paramNames.join(',') + '|' + parentSt.functionName : '') +
      '|' +
      (transition ? transition.map((t) => t.name + ':' + t.rel.oid).join(',') : '') +
      '|' +
      this.searchPathNamespaces().join(',') +
      '|' +
      (this.getSetting('TimeZone', false) ?? '') +
      '|' +
      (this.getSetting('DateStyle', false) ?? '') +
      '|' +
      (this.getSetting('IntervalStyle', false) ?? '');
    let entries = analyzedStatements.get(stmt);
    const hit = entries?.find((e) => e.catalog === catalog && e.version === catalog.version && e.key === key);
    if (hit) {
      return hit;
    }
    const an = this.makeAnalyzer(paramTypesIn, fixed);
    if (parentSt) {
      an.paramNames = parentSt.paramNames;
      an.paramFunctionName = parentSt.functionName;
      an.transitionTables = parentSt.transitionTables;
    }
    const nowReads = this.nowReads;
    const version = catalog.version;
    const { query } = analyzeStatementAsSubquery(an, stmt, null, true);
    const analyzed = { query, paramTypes: an.paramTypes };
    if (this.nowReads === nowReads && catalog === this.catalog() && catalog.version === version) {
      entries = (entries ?? []).filter((e) => e.catalog === catalog && e.version === catalog.version);
      if (entries.length >= ANALYZED_VARIANTS_MAX) {
        entries.shift();
      }
      entries.push({ catalog, version: catalog.version, key, ...analyzed });
      analyzedStatements.set(stmt, entries);
    }
    return analyzed;
  }

  private executeQueryStmt(stmt: A.Statement, text: string, params: unknown[], undo: UndoLog | null, parentSt: StatementState | null, sleepsServed: number, boundTypes?: number[]): StatementResult {
    const txn = this.txn!;
    const paramTypesIn = parentSt ? parentSt.paramTypes.slice() : (boundTypes ?? []);
    const an = this.analyzeQueryStmt(stmt, paramTypesIn, !!parentSt || !!boundTypes, parentSt);
    const query = an.query;
    // parameters
    let typedParams: unknown[];
    if (parentSt) {
      typedParams = parentSt.params;
    } else if (boundTypes) {
      typedParams = params;
    } else {
      const needed = an.paramTypes.length;
      if (params.length < needed) {
        throw new PgError(SqlState.PROTOCOL_VIOLATION ?? '08P01', `bind message supplies ${params.length} parameters, but prepared statement "" requires ${needed}`);
      }
      for (let i = 0; i < an.paramTypes.length; i++) {
        if (!an.paramTypes[i] || an.paramTypes[i] === TypeOid.unknown) {
          if (params[i] === undefined) {
            continue;
          }
          throw new PgError(SqlState.INDETERMINATE_DATATYPE, `could not determine data type of parameter $${i + 1}`);
        }
      }
      if (params.length > needed && needed === 0 && params.length > 0) {
        throw new PgError('08P01', `bind message supplies ${params.length} parameters, but prepared statement "" requires ${needed}`);
      }
      typedParams = an.paramTypes.map((t, i) => {
        const p = params[i];
        if (p === null || p === undefined) {
          return null;
        }
        if (p instanceof Uint8Array) {
          if (t === TypeOid.bytea) {
            return p;
          }
          return inputValue(t, Buffer.from(p).toString('utf8'), -1, this.io);
        }
        return inputValue(t, String(p), -1, this.io);
      });
    }
    this.checkReadOnlyQuery(query, COMMAND_TAGS[stmt.kind] ?? 'SELECT');
    const snapshot = this.takeSnapshot();
    const st = new StatementState(this, this.catalog(), typedParams, an.paramTypes, snapshot);
    st.cid = txn.cid;
    st.undo = undo;
    st.sleepsServed = sleepsServed;
    if (parentSt) {
      st.sleepsServed = Infinity;
      // the transition tables the statement was analyzed with: its scans read their rows
      st.transitionTables = parentSt.transitionTables;
    }
    const host = new SessionHost(this, st);
    const executor = new Executor(st, host);
    host.executor = executor;
    const res = executor.executeQuery(query, null);
    st.runAfterQueue();
    txn.cid++;
    const list = query.commandType === 'select' ? query.targetList : query.returningList;
    const visible = list.filter((t) => !t.resjunk);
    const fields: FieldInfo[] = visible.map((t) => ({ name: t.name, typeOid: t.expr.type, typmod: t.expr.typmod, tableOid: t.origTable, columnAttnum: t.origColumn }));
    const kind = stmt.kind;
    let command = COMMAND_TAGS[kind] ?? 'SELECT';
    if (kind === 'InsertStmt') {
      command = 'INSERT';
    }
    const hasRows = query.commandType === 'select' || query.returningList.length > 0;
    void text;
    return { command, rowCount: res.rowCount, fields, rows: res.rows, hasRows };
  }

  terminate(): void {
    if (this.txn) {
      this.abortTxn();
    }
    // drop temp namespace objects
    if (this.tempNsOid) {
      const cat = this.db.catalog;
      const next = cat.clone();
      for (const rel of [...next.relations.values()]) {
        if (rel.nspOid === this.tempNsOid) {
          next.relations.delete(rel.oid);
        }
      }
      for (const t of [...next.types.values()]) {
        if (t.nspOid === this.tempNsOid) {
          next.types.delete(t.oid);
        }
      }
      next.namespaces.delete(this.tempNsOid);
      next.invalidate();
      this.db.catalog = next;
    }
    for (const [k, v] of [...this.db.advisoryLocks]) {
      if (v.pid === this.backendPid) {
        this.db.advisoryLocks.delete(k);
      }
    }
    for (const set of this.db.listeners.values()) {
      set.delete(this);
    }
    this.closed = true;
  }
}

/** Executor/DML host bound to one statement. */
export class SessionHost {
  executor!: Executor;
  private dml: DmlExecutor | null = null;

  constructor(
    readonly session: Session,
    readonly st: StatementState
  ) {}

  get store() {
    return this.session.db.store;
  }

  ensureXid(st: StatementState): number {
    const xid = this.session.currentWriteXid();
    st.xid = xid;
    st.snapshot.ownXid = this.session.txn!.topXid;
    return xid;
  }

  catalogRows(relOid: number, st: StatementState): unknown[][] {
    return catalogRelationRows(this.session, relOid, st);
  }

  executeModify(q: Query, ctx: EvalCtx, executor: Executor): { rows: unknown[][]; rowCount: number } {
    if (!this.dml || this.dml.executor !== executor) {
      this.dml = new DmlExecutor(this, executor);
    }
    let res: { rows: unknown[][]; rowCount: number };
    switch (q.commandType) {
      case 'insert':
        res = this.dml.executeInsert(q, ctx);
        break;
      case 'update':
        res = this.dml.executeUpdate(q, ctx);
        break;
      case 'delete':
        res = this.dml.executeDelete(q, ctx);
        break;
      case 'merge':
        res = this.dml.executeMerge(q, ctx);
        break;
      default:
        throw new PgError(SqlState.INTERNAL_ERROR, 'not a modify query');
    }
    executor.runPendingModifyingCtes(executor.planFor(q, null), ctx);
    return res;
  }

  relationHeaps(rel: Relation, inh: boolean, st: StatementState): { heap: Heap; rel: Relation }[] {
    const cat = st.catalog;
    const out: { heap: Heap; rel: Relation }[] = [];
    const visit = (r: Relation) => {
      if (r.kind !== 'p' && r.storageId) {
        out.push({ heap: this.store.getHeap(r.storageId), rel: r });
      }
      if (inh || r.kind === 'p') {
        const direct = cat.childrenOf(r.oid);
        if (direct.length === 0) {
          return;
        }
        const children = direct.slice();
        children.sort((a, b) => partitionSortKey(a, b));
        for (const c of children) {
          visit(c);
        }
      }
    };
    visit(rel);
    return out;
  }

  isConstraintDeferred(con: Constraint): boolean {
    return this.session.isConstraintDeferred(con);
  }

  deferConstraintCheck(con: Constraint, run: (dml: DmlExecutor) => void): void {
    this.session.deferConstraintCheck({ constraint: con, run });
  }

  noteHeapWrite(heap: Heap, inserted: boolean): void {
    this.session.noteHeapWrite(heap, inserted);
  }

  analyzeRelationExpr(rel: Relation, stored: StoredExpr, kind: 'check' | 'index' | 'generated' | 'predicate'): { q: Query; expr: TExpr } {
    const version = this.st.catalog.version;
    const cacheKey = 'rel:' + kind + ':' + version + ':' + rel.oid;
    const cache = (stored.cache ??= {});
    const hit = cache[cacheKey] as { q: Query; expr: TExpr } | undefined;
    if (hit) {
      return hit;
    }
    // The key carries the catalog version, so every DDL leaves the previous analyses of this
    // expression behind — dead, but reachable from the catalog. A workload that issues DDL keeps
    // adding versions, and each entry holds an analyzed Query + TExpr: a downstream test suite
    // reached 5 008 entries in one database (catalog version 4 400 -> 4 449). Only the current
    // version can ever be read again, so drop the rest before filling this one.
    for (const key of Object.keys(cache)) {
      if (!key.startsWith('rel:') || key.split(':')[2] !== String(version)) {
        delete cache[key];
      }
    }
    const an = this.session.makeAnalyzer();
    const q = emptyQuery();
    const pstate = new ParseState(null, q);
    const rtIndex = addRelationRte(an, pstate, rel, undefined, false, rel.name);
    pstate.namespace.push({ rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true });
    const exprKind = kind === 'check' ? 'check_constraint' : kind === 'generated' ? 'generated_column' : kind === 'predicate' ? 'index_predicate' : 'index_expression';
    let expr = transformExpr(an, pstate, stored.raw, exprKind);
    if (kind === 'check' || kind === 'predicate') {
      expr = an.coerceToBoolean(pstate, expr, kind === 'check' ? 'CHECK' : 'WHERE');
    } else if (kind === 'generated') {
      checkGeneratedExprFolding(this.st.catalog, expr);
    }
    const r = { q, expr };
    cache[cacheKey] = r;
    return r;
  }

  /**
   * The default of a column: its DEFAULT, else the DEFAULT of its domain (or of a base domain), else — for
   * a domain column — NULL coerced to the domain, which checks the domain's NOT NULL constraint
   * (build_column_default).
   */
  analyzeDefault(rel: Relation, col: Column): { q: Query; expr: TExpr } {
    const stored = col.defaultExpr ?? this.domainDefaultOf(col.typeOid);
    const cacheKey = 'default:' + this.st.catalog.version + ':' + rel.oid + ':' + col.attnum;
    const cache = stored ? (stored.cache ??= {}) : ((col as Column & { nullDefaultCache?: Record<string, unknown> }).nullDefaultCache ??= {});
    const hit = cache[cacheKey] as { q: Query; expr: TExpr } | undefined;
    if (hit) {
      return hit;
    }
    const an = this.session.makeAnalyzer();
    const q = emptyQuery();
    const pstate = new ParseState(null, q);
    let expr: TExpr = stored
      ? transformExpr(an, pstate, stored.raw, 'column_default')
      : { k: 'const', type: TypeOid.unknown, typmod: -1, collation: 0, value: null, isNull: true };
    expr = an.coerceForAssignment(expr, col.typeOid, col.typmod, col.name);
    const r = { q, expr };
    cache[cacheKey] = r;
    return r;
  }

  /** The DEFAULT a domain (or a domain it is based on) declares. */
  private domainDefaultOf(typeOid: number): StoredExpr | undefined {
    let t = this.st.catalog.getType(typeOid);
    for (let guard = 0; t && t.typtype === 'd' && guard < 32; guard++) {
      if (t.domainDefault) {
        return t.domainDefault;
      }
      t = this.st.catalog.getType(t.baseType);
    }
    return undefined;
  }

  partitionKeyValues(parent: Relation, data: unknown[], st: StatementState, executor: Executor): unknown[] {
    const keys = parent.partitionKey?.keys ?? [];
    return keys.map((k) => {
      if (k.attnum > 0) {
        return data[k.attnum - 1] ?? null;
      }
      const { q, expr } = this.analyzeRelationExpr(parent, k.expr!, 'index');
      const plan = executor.planFor(q, null);
      return plan.ev(expr)(new EvalCtx([data, null], null, st));
    });
  }

  partitionAccepts(parent: Relation, part: Relation, keyValues: unknown[], st: StatementState): boolean {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./ddl/partition').partitionAccepts(this.session, parent, part, keyValues, st);
  }

  fireRowTriggers(
    rel: Relation,
    timing: 'BEFORE' | 'AFTER',
    event: 'INSERT' | 'UPDATE' | 'DELETE',
    newData: unknown[] | null,
    oldData: unknown[] | null,
    st: StatementState,
    transition?: TransitionCapture
  ): unknown[] | null | undefined {
    // session_replication_role = replica: ordinary (ENABLE / ORIGIN) triggers do not fire
    if (this.session.replicationRoleReplica()) {
      return undefined;
    }
    return fireTrigger(this.session, rel, timing, event, newData, oldData, st, transition);
  }

  fireStatementTriggers(rel: Relation, timing: 'BEFORE' | 'AFTER', event: 'INSERT' | 'UPDATE' | 'DELETE', st: StatementState, transition?: TransitionCapture): void {
    if (this.session.replicationRoleReplica()) {
      return;
    }
    fireStatementTrigger(this.session, rel, timing, event, st, transition);
  }
}

function partitionSortKey(a: Relation, b: Relation): number {
  return a.oid - b.oid;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { PgError };
