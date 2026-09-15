import { Column, Constraint, Relation, StoredExpr, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { Query, RelationRTE, TExpr } from '../analyze/nodes';
import { Heap, Snapshot, Tuple, UndoLog, WaitForTransaction } from '../storage/mvcc';
import { lockTuple } from '../storage/store';
import { outputValue } from '../types/io';
import { EvalCtx, Evaluator, StatementState } from './runtime';
import { Executor, ExecutorHost, hashFamilyKey, QueryPlan, Row } from './executor';

export interface DmlHost extends ExecutorHost {
  /** analyze a catalog expression over a single relation (checks, index expressions, generated columns) */
  analyzeRelationExpr(rel: Relation, stored: StoredExpr, kind: 'check' | 'index' | 'generated' | 'predicate'): { q: Query; expr: TExpr };
  /** analyze a column default (no column references), coerced to the column type */
  analyzeDefault(rel: Relation, col: Column): { q: Query; expr: TExpr };
  /** partition bound check for routing */
  partitionAccepts(parent: Relation, part: Relation, keyValues: unknown[], st: StatementState): boolean;
  partitionKeyValues(parent: Relation, data: unknown[], st: StatementState, executor: Executor): unknown[];
  /** row-level triggers (BEFORE/AFTER) — returns possibly modified data, or null to skip */
  fireRowTriggers(rel: Relation, timing: 'BEFORE' | 'AFTER', event: 'INSERT' | 'UPDATE' | 'DELETE', newData: unknown[] | null, oldData: unknown[] | null, st: StatementState): unknown[] | null | undefined;
}

interface UniqueIndexInfo {
  indexOid: number;
  name: string;
  keyTypes: number[];
  /** key values for a data row, or null when the row is not indexed (NULL key / partial predicate false) */
  keyOf: (data: unknown[], t: Tuple | null, st?: StatementState) => unknown[] | null;
  keyDisplay: string;
  heapSpec: string;
  nullsNotDistinct: boolean;
  /** key or predicate evaluates expressions (needs a live statement) */
  needsContext: boolean;
}

interface TableInfo {
  rel: Relation;
  live: Column[];
  width: number;
  defaultEvs: Map<number, Evaluator & { plan: QueryPlan }>;
  checks: { name: string; ev: Evaluator; plan: QueryPlan }[];
  uniques: UniqueIndexInfo[];
  fksOut: Constraint[];
  fksIn: Constraint[];
  generated: { col: Column; ev: Evaluator; plan: QueryPlan }[];
  partitions: Relation[];
}

export class DmlExecutor {
  constructor(
    readonly host: DmlHost,
    readonly executor: Executor
  ) {}

  get st(): StatementState {
    return this.executor.st;
  }

  /** session_replication_role = replica: foreign-key triggers (like all ordinary triggers) do not fire */
  private replicaRole(): boolean {
    return this.st.session.getSetting('session_replication_role', true) === 'replica';
  }

  private undo(): UndoLog {
    if (!this.st.undo) {
      this.st.undo = new UndoLog();
    }
    return this.st.undo;
  }

  // -------------------------------------------------------------------------
  // Relation metadata
  // -------------------------------------------------------------------------

  tableInfo(relOid: number): TableInfo {
    const key = 'tableinfo:' + relOid;
    const cached = this.st.scratch.get(key) as TableInfo | undefined;
    if (cached) {
      return cached;
    }
    const catalog = this.st.catalog;
    const rel = catalog.getRelation(relOid)!;
    const live = rel.columns.filter((c) => !c.isDropped);
    const constraints = catalog.constraintsOf(rel.oid);
    const checks = constraints
      .filter((c) => c.type === 'c' && c.check)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => {
        const { q, expr } = this.host.analyzeRelationExpr(rel, c.check!, 'check');
        const plan = this.executor.planFor(q, null);
        return { name: c.name, ev: plan.ev(expr), plan };
      });
    const uniques: UniqueIndexInfo[] = [];
    for (const ix of catalog.indexesOf(rel.oid)) {
      const info = ix.index!;
      if (!info.unique || !info.valid) {
        continue;
      }
      const parts: { phys: number; type: number; ev?: Evaluator; plan?: QueryPlan }[] = info.keys.map((k) => {
        if (k.attnum > 0) {
          const col = rel.columns[k.attnum - 1];
          return { phys: k.attnum - 1, type: col.typeOid };
        }
        const { q, expr } = this.host.analyzeRelationExpr(rel, k.expr!, 'index');
        const plan = this.executor.planFor(q, null);
        return { phys: -1, type: expr.type, ev: plan.ev(expr), plan };
      });
      let predicate: { ev: Evaluator; plan: QueryPlan } | null = null;
      if (info.predicate) {
        const { q, expr } = this.host.analyzeRelationExpr(rel, info.predicate, 'predicate');
        const plan = this.executor.planFor(q, null);
        predicate = { ev: plan.ev(expr), plan };
      }
      const nnd = info.nullsNotDistinct;
      // evaluated with the calling statement: heap indexes outlive the statement that built them
      const keyOf = (data: unknown[], t: Tuple | null, stArg?: StatementState): unknown[] | null => {
        const st = stArg ?? this.st;
        if (predicate) {
          const c = new EvalCtx([data, t], null, st);
          if (predicate.ev(c) !== true) {
            return null;
          }
        }
        const vals: unknown[] = [];
        for (const p of parts) {
          let v: unknown;
          if (p.phys >= 0) {
            v = p.phys < data.length ? data[p.phys] : rel.columns[p.phys].hasMissing ? rel.columns[p.phys].missingValue : null;
          } else {
            const c = new EvalCtx([data, t], null, st);
            v = p.ev!(c);
          }
          if (v === null || v === undefined) {
            if (!nnd) {
              return null;
            }
            v = null;
          }
          vals.push(v);
        }
        return vals;
      };
      const display = info.keys
        .map((k) => (k.attnum > 0 ? rel.columns[k.attnum - 1].name : k.expr ? this.displayIndexExpr(k.expr.text) : '?'))
        .join(', ');
      const needsContext = !!predicate || parts.some((p) => p.phys < 0);
      uniques.push({ indexOid: ix.oid, name: ix.name, keyTypes: parts.map((p) => p.type), keyOf, keyDisplay: display, heapSpec: 'uniq:' + ix.oid, nullsNotDistinct: nnd, needsContext });
    }
    const fksOut = constraints.filter((c) => c.type === 'f');
    const fksIn: Constraint[] = catalog.foreignKeysReferencing(rel.oid);
    const generated = live
      .filter((c) => c.generated === 's' && c.defaultExpr)
      .map((col) => {
        const { q, expr } = this.host.analyzeRelationExpr(rel, col.defaultExpr!, 'generated');
        const plan = this.executor.planFor(q, null);
        return { col, ev: plan.ev(expr), plan };
      });
    const partitions: Relation[] = [];
    if (rel.kind === 'p') {
      for (const r of catalog.relations.values()) {
        if (r.parentOid === rel.oid) {
          partitions.push(r);
        }
      }
      partitions.sort((a, b) => a.oid - b.oid);
    }
    const info: TableInfo = { rel, live, width: rel.columns.length, defaultEvs: new Map(), checks, uniques, fksOut, fksIn, generated, partitions };
    this.st.scratch.set(key, info);
    return info;
  }

  private displayIndexExpr(text: string): string {
    return text.trim();
  }

  private heapOf(rel: Relation): Heap {
    return this.host.store.getHeap(rel.storageId);
  }

  private defaultValue(info: TableInfo, col: Column): unknown {
    if (col.identity) {
      if (!col.identitySeqOid) {
        return null;
      }
      return this.coerceIdentity(col, this.st.session.nextval(col.identitySeqOid));
    }
    if (!col.defaultExpr) {
      if (col.generated) {
        return null;
      }
      const dom = this.st.catalog.getType(col.typeOid);
      if (dom && dom.typtype === 'd' && dom.domainDefault) {
        // domain default
      }
      return null;
    }
    if (col.generated) {
      return null;
    }
    let ev = info.defaultEvs.get(col.attnum);
    if (!ev) {
      const { q, expr } = this.host.analyzeDefault(info.rel, col);
      const plan = this.executor.planFor(q, null);
      const e = plan.ev(expr) as Evaluator & { plan: QueryPlan };
      e.plan = plan;
      ev = e;
      info.defaultEvs.set(col.attnum, ev);
    }
    const c = new EvalCtx([], null, this.st);
    return ev(c);
  }

  private coerceIdentity(col: Column, v: bigint): unknown {
    switch (col.typeOid) {
      case TypeOid.int2:
      case TypeOid.int4:
        return Number(v);
      case TypeOid.int8:
        return v;
      default:
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../types/numeric').PgNumeric.fromBigInt(v);
    }
  }

  // -------------------------------------------------------------------------
  // Constraint checks
  // -------------------------------------------------------------------------

  failingRow(info: TableInfo, data: unknown[]): string {
    const io = this.st.session.io;
    const vals = info.live.map((c) => {
      const v = c.attnum - 1 < data.length ? data[c.attnum - 1] : c.hasMissing ? c.missingValue : null;
      return v === null || v === undefined ? 'null' : outputValue(c.typeOid, v, io);
    });
    return `Failing row contains (${vals.join(', ')}).`;
  }

  private checkRow(info: TableInfo, data: unknown[], relForMessages: Relation): void {
    for (const col of info.live) {
      const v = data[col.attnum - 1];
      if (col.notNull && (v === null || v === undefined)) {
        throw new PgError(SqlState.NOT_NULL_VIOLATION, `null value in column "${col.name}" of relation "${relForMessages.name}" violates not-null constraint`, {
          detail: this.failingRow(info, data),
          schema: this.st.catalog.namespaceName(relForMessages.nspOid),
          table: relForMessages.name,
          column: col.name,
        });
      }
    }
    for (const chk of info.checks) {
      const c = new EvalCtx([data, null], null, this.st);
      if (chk.ev(c) === false) {
        throw new PgError(SqlState.CHECK_VIOLATION, `new row for relation "${relForMessages.name}" violates check constraint "${chk.name}"`, {
          detail: this.failingRow(info, data),
          schema: this.st.catalog.namespaceName(relForMessages.nspOid),
          table: relForMessages.name,
          constraint: chk.name,
        });
      }
    }
  }

  private uniqueMap(heap: Heap, u: UniqueIndexInfo): Map<unknown, Tuple[]> {
    const typeOps = this.st.session.typeOps;
    return heap.getIndex(
      u.heapSpec,
      (t, ctx) => {
        const k = u.keyOf(t.data, t, ctx as StatementState | undefined);
        return k === null ? undefined : this.compositeKey(u.keyTypes, k, typeOps);
      },
      u.needsContext
    );
  }

  private compositeKey(types: number[], vals: unknown[], typeOps: import('./typeops').TypeOps): unknown {
    if (vals.length === 1) {
      return vals[0] === null ? '\u0000null' : hashFamilyKey(types[0], vals[0], typeOps);
    }
    return vals.map((v, i) => (v === null ? '\u0000null' : String(hashFamilyKey(types[i], v, typeOps)))).join('');
  }

  /** The transaction whose tuples count as our own: the statement's write xid, or (before this statement wrote) the transaction's. */
  private ownXid(): number {
    return this.st.xid || this.st.snapshot.ownXid;
  }

  /** Find a live conflicting tuple for a unique index (excluding `self`). Throws WaitForTransaction if undecided. */
  private findConflict(heap: Heap, u: UniqueIndexInfo, keyVals: unknown[], self: Tuple | null): Tuple | null {
    const typeOps = this.st.session.typeOps;
    const map = this.uniqueMap(heap, u);
    const candidates = map.get(this.compositeKey(u.keyTypes, keyVals, typeOps));
    if (!candidates) {
      return null;
    }
    const vis = this.host.store.vis;
    const own = this.ownXid();
    for (const t of candidates) {
      if (t === self || t.vacuumed) {
        continue;
      }
      const l = vis.liveness(t, own);
      if (l === 'dead') {
        continue;
      }
      if (l === 'live') {
        return t;
      }
      throw new WaitForTransaction(l.waitFor, this.st.catalog.getRelation(u.indexOid)?.name);
    }
    return null;
  }

  private checkUniques(info: TableInfo, heap: Heap, data: unknown[], self: Tuple, relForMessages: Relation): void {
    for (const u of info.uniques) {
      const k = u.keyOf(data, self);
      if (k === null) {
        continue;
      }
      const conflict = this.findConflict(heap, u, k, self);
      if (conflict) {
        const io = this.st.session.io;
        const vals = k.map((v, i) => (v === null ? 'null' : outputValue(u.keyTypes[i], v, io))).join(', ');
        throw new PgError(SqlState.UNIQUE_VIOLATION, `duplicate key value violates unique constraint "${u.name}"`, {
          detail: `Key (${u.keyDisplay})=(${vals}) already exists.`,
          schema: this.st.catalog.namespaceName(relForMessages.nspOid),
          table: relForMessages.name,
          constraint: u.name,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Foreign keys
  // -------------------------------------------------------------------------

  private fkSnapshot(): Snapshot {
    return { ...this.st.snapshot, curCid: this.st.cid + 1 };
  }

  private refRowExists(con: Constraint, keyVals: unknown[]): boolean {
    const refRel = this.st.catalog.getRelation(con.fk!.refRelOid)!;
    const heaps = this.host.relationHeaps(refRel, true, this.st);
    const snap = this.fkSnapshot();
    const vis = this.host.store.vis;
    const typeOps = this.st.session.typeOps;
    const refCols = con.fk!.refColumns;
    const types = refCols.map((a) => refRel.columns[a - 1].typeOid);
    for (const { heap, rel } of heaps) {
      const physs = refCols.map((a) => {
        const name = refRel.columns[a - 1].name;
        return rel.columns.findIndex((c) => !c.isDropped && c.name === name);
      });
      const spec = 'fkref:' + physs.join(',') + ':' + types.join(',');
      const index = heap.getIndex(spec, (t) => {
        const vals = physs.map((p) => (p < t.data.length ? t.data[p] : null));
        if (vals.some((v) => v === null || v === undefined)) {
          return undefined;
        }
        return this.compositeKey(types, vals, typeOps);
      });
      const key = this.compositeKey(types, keyVals, typeOps);
      for (const t of index.get(key) ?? []) {
        if (vis.visible(t, snap)) {
          return true;
        }
        const l = vis.liveness(t, this.ownXid());
        if (typeof l === 'object') {
          throw new WaitForTransaction(l.waitFor, refRel.name);
        }
      }
    }
    return false;
  }

  checkForeignKeysOut(info: TableInfo, data: unknown[], relForMessages: Relation, changedOnly?: unknown[] | null): void {
    if (info.fksOut.length === 0 || this.replicaRole()) {
      return;
    }
    for (const con of info.fksOut) {
      const cols = con.columns;
      const vals = cols.map((a) => data[a - 1] ?? null);
      if (changedOnly) {
        const old = cols.map((a) => changedOnly[a - 1] ?? null);
        const typeOps = this.st.session.typeOps;
        const types = cols.map((a) => info.rel.columns[a - 1].typeOid);
        if (this.compositeKey(types, old, typeOps) === this.compositeKey(types, vals, typeOps) && !old.some((v) => v === null)) {
          continue;
        }
      }
      const anyNull = vals.some((v) => v === null);
      if (anyNull) {
        if (con.fk!.matchType === 'FULL' && !vals.every((v) => v === null)) {
          throw new PgError(SqlState.FOREIGN_KEY_VIOLATION, `insert or update on table "${relForMessages.name}" violates foreign key constraint "${con.name}"`, {
            detail: 'MATCH FULL does not allow mixing of null and nonnull key values.',
            constraint: con.name,
            table: relForMessages.name,
          });
        }
        continue;
      }
      // coerce to referenced column types when they differ (e.g. int4 -> int8)
      const refRel = this.st.catalog.getRelation(con.fk!.refRelOid)!;
      if (!this.refRowExists(con, vals)) {
        const io = this.st.session.io;
        const colNames = cols.map((a) => info.rel.columns[a - 1].name).join(', ');
        const valText = vals.map((v, i) => outputValue(info.rel.columns[cols[i] - 1].typeOid, v, io)).join(', ');
        throw new PgError(SqlState.FOREIGN_KEY_VIOLATION, `insert or update on table "${relForMessages.name}" violates foreign key constraint "${con.name}"`, {
          detail: `Key (${colNames})=(${valText}) is not present in table "${refRel.name}".`,
          schema: this.st.catalog.namespaceName(relForMessages.nspOid),
          table: relForMessages.name,
          constraint: con.name,
        });
      }
    }
  }

  /** Referencing rows (visible to the RI snapshot) for a referenced key. */
  private referencingRows(con: Constraint, keyVals: unknown[]): { heap: Heap; rel: Relation; tuple: Tuple }[] {
    const rel = this.st.catalog.getRelation(con.relOid)!;
    const heaps = this.host.relationHeaps(rel, true, this.st);
    const snap = this.fkSnapshot();
    const vis = this.host.store.vis;
    const typeOps = this.st.session.typeOps;
    const out: { heap: Heap; rel: Relation; tuple: Tuple }[] = [];
    const types = con.columns.map((a) => rel.columns[a - 1].typeOid);
    for (const part of heaps) {
      const physs = con.columns.map((a) => {
        const name = rel.columns[a - 1].name;
        return part.rel.columns.findIndex((c) => !c.isDropped && c.name === name);
      });
      const spec = 'fkin:' + physs.join(',') + ':' + types.join(',');
      const index = part.heap.getIndex(spec, (t) => {
        const vals = physs.map((p) => (p < t.data.length ? t.data[p] : null));
        if (vals.some((v) => v === null || v === undefined)) {
          return undefined;
        }
        return this.compositeKey(types, vals, typeOps);
      });
      for (const t of index.get(this.compositeKey(types, keyVals, typeOps)) ?? []) {
        if (vis.visible(t, snap)) {
          out.push({ heap: part.heap, rel: part.rel, tuple: t });
        } else {
          const l = vis.liveness(t, this.ownXid());
          if (typeof l === 'object') {
            throw new WaitForTransaction(l.waitFor, rel.name);
          }
        }
      }
    }
    return out;
  }

  /** ON DELETE / ON UPDATE handling for rows of `info.rel` whose referenced key disappeared or changed. */
  private handleReferencedChange(info: TableInfo, oldData: unknown[], newData: unknown[] | null): void {
    if (info.fksIn.length === 0 || this.replicaRole()) {
      return;
    }
    for (const con of info.fksIn) {
      const refCols = con.fk!.refColumns;
      const oldKey = refCols.map((a) => oldData[a - 1] ?? null);
      if (oldKey.some((v) => v === null)) {
        continue;
      }
      if (newData) {
        const newKey = refCols.map((a) => newData[a - 1] ?? null);
        const typeOps = this.st.session.typeOps;
        const types = refCols.map((a) => info.rel.columns[a - 1].typeOid);
        if (this.compositeKey(types, oldKey, typeOps) === this.compositeKey(types, newKey, typeOps)) {
          continue;
        }
      }
      // another row with the same key may still satisfy the reference (e.g. unique updated then reinserted)
      if (this.refRowExists(con, oldKey)) {
        continue;
      }
      const rows = this.referencingRows(con, oldKey);
      if (rows.length === 0) {
        continue;
      }
      const action = newData ? con.fk!.onUpdate : con.fk!.onDelete;
      const referencingRel = this.st.catalog.getRelation(con.relOid)!;
      if (action === 'NO ACTION' || action === 'RESTRICT') {
        const io = this.st.session.io;
        const colNames = refCols.map((a) => info.rel.columns[a - 1].name).join(', ');
        const valText = oldKey.map((v, i) => outputValue(info.rel.columns[refCols[i] - 1].typeOid, v, io)).join(', ');
        throw new PgError(SqlState.FOREIGN_KEY_VIOLATION, `update or delete on table "${info.rel.name}" violates foreign key constraint "${con.name}" on table "${referencingRel.name}"`, {
          detail: `Key (${colNames})=(${valText}) is still referenced from table "${referencingRel.name}".`,
          schema: this.st.catalog.namespaceName(referencingRel.nspOid),
          table: referencingRel.name,
          constraint: con.name,
        });
      }
      const refInfo = this.tableInfo(referencingRel.oid);
      for (const r of rows) {
        if (action === 'CASCADE' && !newData) {
          this.deleteTuple(this.tableInfo(r.rel.oid), r.heap, r.tuple, r.rel, true);
        } else {
          const data = r.tuple.data.slice();
          const targetCols = action === 'SET NULL' || action === 'SET DEFAULT' ? con.fk!.deleteSetColumns ?? con.columns : con.columns;
          if (action === 'CASCADE' && newData) {
            con.columns.forEach((a, i) => {
              data[a - 1] = newData[refCols[i] - 1];
            });
          } else {
            for (const a of targetCols) {
              const col = r.rel.columns[a - 1];
              data[a - 1] = action === 'SET NULL' ? null : this.defaultValue(refInfo, col);
            }
          }
          this.updateTuple(this.tableInfo(r.rel.oid), r.heap, r.tuple, data, r.rel, true);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Primitive writes
  // -------------------------------------------------------------------------

  private routeInsert(info: TableInfo, data: unknown[]): { rel: Relation; info: TableInfo; data: unknown[] } {
    if (info.rel.kind !== 'p') {
      return { rel: info.rel, info, data };
    }
    const keyVals = this.host.partitionKeyValues(info.rel, data, this.st, this.executor);
    let defaultPart: Relation | null = null;
    for (const part of info.partitions) {
      if (part.partitionBound?.kind === 'DEFAULT') {
        defaultPart = part;
        continue;
      }
      if (this.host.partitionAccepts(info.rel, part, keyVals, this.st)) {
        const mapped = this.mapToChild(info.rel, part, data);
        return this.routeInsert(this.tableInfo(part.oid), mapped);
      }
    }
    if (defaultPart) {
      return this.routeInsert(this.tableInfo(defaultPart.oid), this.mapToChild(info.rel, defaultPart, data));
    }
    const io = this.st.session.io;
    const keyCols = (info.rel.partitionKey?.keys ?? []).map((k) => (k.attnum > 0 ? info.rel.columns[k.attnum - 1].name : k.expr?.text ?? '?'));
    const keyText = keyVals.map((v, i) => (v === null ? 'null' : outputValue(k2type(info.rel, i), v, io))).join(', ');
    throw new PgError(SqlState.CHECK_VIOLATION, `no partition of relation "${info.rel.name}" found for row`, {
      detail: `Partition key of the failing row contains (${keyCols.join(', ')}) = (${keyText}).`,
      table: info.rel.name,
    });
  }

  private mapToChild(parent: Relation, child: Relation, data: unknown[]): unknown[] {
    const out = new Array(child.columns.length).fill(null);
    child.columns.forEach((c, i) => {
      if (c.isDropped) {
        return;
      }
      const pi = parent.columns.findIndex((pc) => !pc.isDropped && pc.name === c.name);
      out[i] = pi >= 0 ? data[pi] : null;
    });
    return out;
  }

  insertRow(info: TableInfo, data: unknown[]): { tuple: Tuple; rel: Relation; data: unknown[] } {
    const routed = this.routeInsert(info, data);
    const tinfo = routed.info;
    let rowData = routed.data;
    if (routed.rel.hasTriggers) {
      const r = this.host.fireRowTriggers(routed.rel, 'BEFORE', 'INSERT', rowData, null, this.st);
      if (r === null) {
        return { tuple: null as unknown as Tuple, rel: routed.rel, data: rowData };
      }
      if (r) {
        rowData = r;
      }
    }
    this.computeGenerated(tinfo, rowData);
    this.checkRow(tinfo, rowData, routed.rel);
    const heap = this.heapOf(routed.rel);
    const xid = this.host.ensureXid(this.st);
    const t = heap.insert(rowData, xid, this.st.cid, this.st);
    this.undo().recordInsert(heap, t);
    this.st.modifiedRelations.add(routed.rel.oid);
    this.checkUniques(tinfo, heap, rowData, t, routed.rel);
    return { tuple: t, rel: routed.rel, data: rowData };
  }

  private computeGenerated(info: TableInfo, data: unknown[]): void {
    for (const g of info.generated) {
      const c = new EvalCtx([data, null], null, this.st);
      data[g.col.attnum - 1] = g.ev(c);
    }
  }

  updateTuple(info: TableInfo, heap: Heap, old: Tuple, newData: unknown[], rel: Relation, fromRi: boolean): Tuple | null {
    const xid = this.host.ensureXid(this.st);
    const outcome = lockTuple(this.host.store, old, xid, 'NO KEY UPDATE', 'BLOCK', rel.name, false);
    if (outcome === 'deleted' || outcome === 'skip') {
      return null;
    }
    if (typeof outcome === 'object') {
      return null;
    }
    if (old.xmax === xid && old.cmax === this.st.cid) {
      return null;
    }
    let data = newData;
    if (rel.hasTriggers) {
      const r = this.host.fireRowTriggers(rel, 'BEFORE', 'UPDATE', data, old.data, this.st);
      if (r === null) {
        return null;
      }
      if (r) {
        data = r;
      }
    }
    this.computeGenerated(info, data);
    this.checkRow(info, data, rel);
    this.undo().recordXmax(heap, old);
    const t = heap.update(old, data, xid, this.st.cid, this.st);
    this.undo().recordInsert(heap, t);
    this.st.modifiedRelations.add(rel.oid);
    this.checkUniques(info, heap, data, t, rel);
    if (!fromRi) {
      // referencing side checked at end of statement by caller
    } else {
      this.checkForeignKeysOut(info, data, rel, old.data);
      this.handleReferencedChange(info, old.data, data);
    }
    return t;
  }

  deleteTuple(info: TableInfo, heap: Heap, t: Tuple, rel: Relation, fromRi: boolean): boolean {
    const xid = this.host.ensureXid(this.st);
    const outcome = lockTuple(this.host.store, t, xid, 'UPDATE', 'BLOCK', rel.name, false);
    if (outcome !== 'ok') {
      return false;
    }
    if (t.xmax === xid) {
      return false;
    }
    if (rel.hasTriggers) {
      const r = this.host.fireRowTriggers(rel, 'BEFORE', 'DELETE', null, t.data, this.st);
      if (r === null) {
        return false;
      }
    }
    this.undo().recordXmax(heap, t);
    heap.delete(t, xid, this.st.cid);
    this.st.modifiedRelations.add(rel.oid);
    if (fromRi) {
      this.handleReferencedChange(info, t.data, null);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // INSERT
  // -------------------------------------------------------------------------

  executeInsert(q: Query, base: EvalCtx): { rows: unknown[][]; rowCount: number } {
    const plan = this.executor.planFor(q, base.parent && base.parent.inst ? (base.parent.inst as { plan: QueryPlan }).plan : null);
    const rte = q.rtable[q.resultRelation] as RelationRTE;
    const info = this.tableInfo(rte.relOid);
    const live = info.live;
    const cols = q.insertColumns ?? [];
    const src = q.insertSource!;
    let sourceRows: (unknown[] | null)[][];
    const sourceIsDefault: boolean[][] = [];
    if (src.kind === 'default') {
      sourceRows = [[]];
      sourceIsDefault.push([]);
    } else if (src.kind === 'values') {
      sourceRows = [];
      for (const row of src.rows) {
        const vals: unknown[] = [];
        const defs: boolean[] = [];
        row.forEach((e) => {
          if (e === null) {
            vals.push(undefined);
            defs.push(true);
          } else {
            vals.push(plan.ev(e)(base));
            defs.push(false);
          }
        });
        sourceRows.push(vals as (unknown[] | null)[]);
        sourceIsDefault.push(defs);
      }
    } else {
      const sub = q.rtable[src.rtIndex];
      if (sub.kind !== 'subquery') {
        throw new PgError(SqlState.INTERNAL_ERROR, 'INSERT source is not a subquery');
      }
      sourceRows = this.executor.executeQuery(sub.subquery, base).rows as (unknown[] | null)[][];
      for (const r of sourceRows) {
        sourceIsDefault.push(r.map(() => false));
      }
    }

    const returning: unknown[][] = [];
    const retEvs = q.returningList.map((te) => plan.ev(te.expr));
    const inserted: { data: unknown[]; rel: Relation; info: TableInfo }[] = [];
    let rowCount = 0;
    const onConflict = q.onConflict;
    const nrt = plan.nrt;
    const overrideUser = q.override === 'USER';

    for (let ri = 0; ri < sourceRows.length; ri++) {
      const srcRow = sourceRows[ri];
      const defs = sourceIsDefault[ri];
      const data: unknown[] = new Array(info.width).fill(null);
      for (let li = 0; li < live.length; li++) {
        const col = live[li];
        const pos = cols.indexOf(li);
        let provided = pos >= 0 && pos < (srcRow as unknown[]).length && !defs[pos];
        if (provided && col.identity && overrideUser) {
          provided = false;
        }
        if (provided) {
          data[col.attnum - 1] = (srcRow as unknown[])[pos];
        } else {
          data[col.attnum - 1] = this.defaultValue(info, col);
        }
      }

      if (onConflict) {
        const handled = this.handleOnConflict(q, plan, base, info, data, returning, retEvs);
        if (handled !== 'insert') {
          if (handled === 'updated') {
            rowCount++;
          }
          continue;
        }
      }
      const res = this.insertRow(info, data);
      if (!res.tuple) {
        continue;
      }
      rowCount++;
      inserted.push({ data: res.data, rel: res.rel, info: this.tableInfo(res.rel.oid) });
      if (retEvs.length > 0) {
        const row = base.row.slice();
        row[q.resultRelation] = res.rel === info.rel ? res.data : this.mapFromChild(info.rel, res.rel, res.data);
        row[nrt + q.resultRelation] = res.tuple;
        setReturningOldNew(q, row, null, row[q.resultRelation] as unknown[]);
        const c = this.executor.rowCtx(row, base);
        returning.push(retEvs.map((ev) => ev(c)));
      }
    }
    // foreign keys and AFTER triggers fire at the end of the whole query
    this.st.afterQueue.push(() => {
      for (const ins of inserted) {
        if (ins.info.fksOut.length > 0) {
          this.checkForeignKeysOut(ins.info, ins.data, ins.rel);
        }
      }
      this.fireAfterRowTriggers(inserted.map((i) => ({ rel: i.rel, newData: i.data, oldData: null })), 'INSERT');
    });
    return { rows: returning, rowCount };
  }

  private mapFromChild(parent: Relation, child: Relation, data: unknown[]): unknown[] {
    return parent.columns.map((c) => {
      if (c.isDropped) {
        return null;
      }
      const ci = child.columns.findIndex((cc) => !cc.isDropped && cc.name === c.name);
      return ci >= 0 ? data[ci] : null;
    });
  }

  private fireAfterRowTriggers(events: { rel: Relation; newData: unknown[] | null; oldData: unknown[] | null }[], event: 'INSERT' | 'UPDATE' | 'DELETE'): void {
    for (const e of events) {
      if (e.rel.hasTriggers) {
        this.host.fireRowTriggers(e.rel, 'AFTER', event, e.newData, e.oldData, this.st);
      }
    }
  }

  private handleOnConflict(q: Query, plan: QueryPlan, base: EvalCtx, info: TableInfo, data: unknown[], returning: unknown[][], retEvs: Evaluator[]): 'insert' | 'skipped' | 'updated' {
    const oc = q.onConflict!;
    const arbiters = oc.arbiterIndexes.length > 0 ? info.uniques.filter((u) => oc.arbiterIndexes.includes(u.indexOid)) : info.uniques;
    const heap = this.heapOf(info.rel);
    let conflict: Tuple | null = null;
    for (const u of arbiters) {
      const k = u.keyOf(data, null);
      if (k === null) {
        continue;
      }
      conflict = this.findConflict(heap, u, k, null);
      if (conflict) {
        break;
      }
    }
    if (!conflict) {
      return 'insert';
    }
    if (oc.action === 'NOTHING') {
      return 'skipped';
    }
    const xid = this.host.ensureXid(this.st);
    if (conflict.xmin === xid && conflict.cmin === this.st.cid) {
      throw new PgError(SqlState.CARDINALITY_VIOLATION, 'ON CONFLICT DO UPDATE command cannot affect row a second time', {
        hint: 'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.',
      });
    }
    const outcome = lockTuple(this.host.store, conflict, xid, 'UPDATE', 'BLOCK', info.rel.name, true);
    if (outcome !== 'ok') {
      return 'skipped';
    }
    const nrt = plan.nrt;
    const row = base.row.slice();
    row[q.resultRelation] = conflict.data;
    row[nrt + q.resultRelation] = conflict;
    row[oc.exclRtIndex] = data;
    const c = this.executor.rowCtx(row, base);
    if (oc.where && plan.ev(oc.where)(c) !== true) {
      return 'skipped';
    }
    const newData = conflict.data.slice();
    while (newData.length < info.width) {
      const col = info.rel.columns[newData.length];
      newData.push(col && col.hasMissing ? col.missingValue : null);
    }
    for (const s of oc.setList) {
      const col = info.live[s.attIndex];
      newData[col.attnum - 1] = s.expr.k === 'default' ? this.defaultValue(info, col) : plan.ev(s.expr)(c);
    }
    const t = this.updateTuple(info, heap, conflict, newData, info.rel, false);
    if (!t) {
      return 'skipped';
    }
    const oldData = conflict.data;
    this.st.afterQueue.push(() => {
      if (info.fksOut.length > 0) {
        this.checkForeignKeysOut(info, newData, info.rel, oldData);
      }
      if (info.fksIn.length > 0) {
        this.handleReferencedChange(info, oldData, newData);
      }
    });
    if (retEvs.length > 0) {
      const r2 = base.row.slice();
      r2[q.resultRelation] = newData;
      r2[nrt + q.resultRelation] = t;
      setReturningOldNew(q, r2, conflict.data, newData);
      const c2 = this.executor.rowCtx(r2, base);
      returning.push(retEvs.map((ev) => ev(c2)));
    }
    return 'updated';
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  executeUpdate(q: Query, base: EvalCtx): { rows: unknown[][]; rowCount: number } {
    const plan = this.executor.planFor(q, base.parent && base.parent.inst ? (base.parent.inst as { plan: QueryPlan }).plan : null);
    const rt = q.resultRelation;
    const rte = q.rtable[rt] as RelationRTE;
    const info = this.tableInfo(rte.relOid);
    const nrt = plan.nrt;
    const rows = this.executor.executeFromWhere(plan, base);
    const seen = new Set<Tuple>();
    const setEvs = q.updateSet!.map((s) => ({ col: info.live[s.attIndex], expr: s.expr, ev: s.expr.k === 'default' ? null : plan.ev(s.expr) }));
    const retEvs = q.returningList.map((te) => plan.ev(te.expr));
    const returning: unknown[][] = [];
    const updates: { rel: Relation; info: TableInfo; oldData: unknown[]; newData: unknown[] }[] = [];
    let rowCount = 0;
    for (const row of rows) {
      const t = row[nrt + rt] as Tuple;
      if (!t || seen.has(t)) {
        continue;
      }
      seen.add(t);
      const ctx = this.executor.rowCtx(row, base);
      const partRel = this.relationOfTuple(info.rel, t);
      const partInfo = partRel === info.rel ? info : this.tableInfo(partRel.oid);
      const newData = t.data.slice();
      while (newData.length < partRel.columns.length) {
        const col = partRel.columns[newData.length];
        newData.push(col && col.hasMissing ? col.missingValue : null);
      }
      for (const s of setEvs) {
        const phys = partRel === info.rel ? s.col.attnum - 1 : partRel.columns.findIndex((c) => !c.isDropped && c.name === s.col.name);
        newData[phys] = s.ev ? s.ev(ctx) : this.defaultValue(partInfo, partRel.columns[phys]);
      }
      const heap = this.heapOf(partRel);
      const nt = this.updateTuple(partInfo, heap, t, newData, partRel, false);
      if (!nt) {
        continue;
      }
      rowCount++;
      updates.push({ rel: partRel, info: partInfo, oldData: t.data, newData });
      if (retEvs.length > 0) {
        const r2 = row.slice();
        r2[rt] = partRel === info.rel ? newData : this.mapFromChild(info.rel, partRel, newData);
        r2[nrt + rt] = nt;
        setReturningOldNew(q, r2, partRel === info.rel ? t.data : this.mapFromChild(info.rel, partRel, t.data), r2[rt] as unknown[]);
        const c2 = this.executor.rowCtx(r2, base);
        returning.push(retEvs.map((ev) => ev(c2)));
      }
    }
    this.st.afterQueue.push(() => {
      for (const u of updates) {
        if (u.info.fksOut.length > 0) {
          this.checkForeignKeysOut(u.info, u.newData, u.rel, u.oldData);
        }
        if (u.info.fksIn.length > 0) {
          this.handleReferencedChange(u.info, u.oldData, u.newData);
        }
      }
      this.fireAfterRowTriggers(updates.map((u) => ({ rel: u.rel, newData: u.newData, oldData: u.oldData })), 'UPDATE');
    });
    return { rows: returning, rowCount };
  }

  private relationOfTuple(rel: Relation, t: Tuple): Relation {
    if (rel.kind !== 'p' && !this.st.catalog.relations.size) {
      return rel;
    }
    const heaps = this.host.relationHeaps(rel, true, this.st);
    if (heaps.length === 1) {
      return heaps[0].rel;
    }
    for (const h of heaps) {
      if (h.heap.tuples.includes(t)) {
        return h.rel;
      }
    }
    return rel;
  }

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  executeDelete(q: Query, base: EvalCtx): { rows: unknown[][]; rowCount: number } {
    const plan = this.executor.planFor(q, base.parent && base.parent.inst ? (base.parent.inst as { plan: QueryPlan }).plan : null);
    const rt = q.resultRelation;
    const rte = q.rtable[rt] as RelationRTE;
    const info = this.tableInfo(rte.relOid);
    const nrt = plan.nrt;
    const rows = this.executor.executeFromWhere(plan, base);
    const seen = new Set<Tuple>();
    const retEvs = q.returningList.map((te) => plan.ev(te.expr));
    const returning: unknown[][] = [];
    const deleted: { rel: Relation; info: TableInfo; oldData: unknown[] }[] = [];
    let rowCount = 0;
    for (const row of rows) {
      const t = row[nrt + rt] as Tuple;
      if (!t || seen.has(t)) {
        continue;
      }
      seen.add(t);
      const partRel = this.relationOfTuple(info.rel, t);
      const partInfo = partRel === info.rel ? info : this.tableInfo(partRel.oid);
      if (!this.deleteTuple(partInfo, this.heapOf(partRel), t, partRel, false)) {
        continue;
      }
      rowCount++;
      deleted.push({ rel: partRel, info: partInfo, oldData: t.data });
      if (retEvs.length > 0) {
        let r = row;
        if (q.returningOldRt !== undefined || q.returningNewRt !== undefined) {
          r = row.slice();
          setReturningOldNew(q, r, row[rt] as unknown[], null);
        }
        const c = this.executor.rowCtx(r, base);
        returning.push(retEvs.map((ev) => ev(c)));
      }
    }
    this.st.afterQueue.push(() => {
      for (const d of deleted) {
        if (d.info.fksIn.length > 0) {
          this.handleReferencedChange(d.info, d.oldData, null);
        }
      }
      this.fireAfterRowTriggers(deleted.map((d) => ({ rel: d.rel, newData: null, oldData: d.oldData })), 'DELETE');
    });
    return { rows: returning, rowCount };
  }

  // -------------------------------------------------------------------------
  // MERGE
  // -------------------------------------------------------------------------

  executeMerge(q: Query, base: EvalCtx): { rows: unknown[][]; rowCount: number } {
    const plan = this.executor.planFor(q, base.parent && base.parent.inst ? (base.parent.inst as { plan: QueryPlan }).plan : null);
    const rt = q.resultRelation;
    const rte = q.rtable[rt] as RelationRTE;
    const info = this.tableInfo(rte.relOid);
    const nrt = plan.nrt;
    const heap = this.heapOf(info.rel);
    // source rows
    const sourceRows = this.executor.executeFromWhere(plan, base);
    // target tuples visible
    const vis = this.host.store.vis;
    const targets = heap.tuples.filter((t) => vis.visible(t, this.st.snapshot));
    const cond = q.mergeJoinCondition ? plan.ev(q.mergeJoinCondition) : () => true;
    const actions = q.mergeActions!;
    const retEvs = q.returningList.map((te) => plan.ev(te.expr));
    const returning: unknown[][] = [];
    const matchedTargets = new Set<Tuple>();
    const touched = new Set<Tuple>();
    let rowCount = 0;
    const hasBySource = actions.some((a) => a.matchKind === 'NOT_MATCHED_BY_SOURCE');
    const inserted: { data: unknown[]; rel: Relation; info: TableInfo }[] = [];

    for (const srow of sourceRows) {
      const matches: Tuple[] = [];
      for (const t of targets) {
        const row = srow.slice();
        row[rt] = t.data;
        row[nrt + rt] = t;
        if (cond(this.executor.rowCtx(row, base)) === true) {
          matches.push(t);
        }
      }
      if (matches.length === 0) {
        const row = srow.slice();
        row[rt] = null;
        const ctx = this.executor.rowCtx(row, base);
        for (const a of actions) {
          if (a.matchKind !== 'NOT_MATCHED_BY_TARGET') {
            continue;
          }
          if (a.condition && plan.ev(a.condition)(ctx) !== true) {
            continue;
          }
          if (a.command === 'INSERT') {
            const data: unknown[] = new Array(info.width).fill(null);
            const provided = new Map<number, TExpr>();
            for (const tl of a.targetList) {
              provided.set(tl.attIndex, tl.expr);
            }
            info.live.forEach((col, li) => {
              const e = provided.get(li);
              data[col.attnum - 1] = e && e.k !== 'default' ? plan.ev(e)(ctx) : this.defaultValue(info, col);
            });
            const res = this.insertRow(info, data);
            if (res.tuple) {
              rowCount++;
              inserted.push({ data: res.data, rel: res.rel, info: this.tableInfo(res.rel.oid) });
              if (retEvs.length > 0) {
                const r2 = srow.slice();
                r2[rt] = res.data;
                r2[nrt + rt] = res.tuple;
                setReturningOldNew(q, r2, null, res.data);
                returning.push(retEvs.map((ev) => ev(this.executor.rowCtx(r2, base))));
              }
            }
          }
          break;
        }
        continue;
      }
      for (const t of matches) {
        matchedTargets.add(t);
        if (touched.has(t)) {
          throw new PgError(SqlState.CARDINALITY_VIOLATION, 'MERGE command cannot affect row a second time', {
            hint: 'Ensure that not more than one source row matches any one target row.',
          });
        }
        const row = srow.slice();
        row[rt] = t.data;
        row[nrt + rt] = t;
        const ctx = this.executor.rowCtx(row, base);
        for (const a of actions) {
          if (a.matchKind !== 'MATCHED') {
            continue;
          }
          if (a.condition && plan.ev(a.condition)(ctx) !== true) {
            continue;
          }
          if (a.command === 'NOTHING') {
            touched.add(t);
            break;
          }
          if (a.command === 'DELETE') {
            touched.add(t);
            if (this.deleteTuple(info, heap, t, info.rel, false)) {
              rowCount++;
              if (retEvs.length > 0) {
                const r2 = row.slice();
                setReturningOldNew(q, r2, t.data, null);
                returning.push(retEvs.map((ev) => ev(this.executor.rowCtx(r2, base))));
              }
              if (info.fksIn.length > 0) {
                const oldData = t.data;
                this.st.afterQueue.push(() => this.handleReferencedChange(info, oldData, null));
              }
            }
            break;
          }
          if (a.command === 'UPDATE') {
            touched.add(t);
            const newData = t.data.slice();
            for (const s of a.targetList) {
              const col = info.live[s.attIndex];
              newData[col.attnum - 1] = s.expr.k === 'default' ? this.defaultValue(info, col) : plan.ev(s.expr)(ctx);
            }
            const nt = this.updateTuple(info, heap, t, newData, info.rel, false);
            if (nt) {
              rowCount++;
              const oldData = t.data;
              this.st.afterQueue.push(() => {
                if (info.fksOut.length > 0) {
                  this.checkForeignKeysOut(info, newData, info.rel, oldData);
                }
                if (info.fksIn.length > 0) {
                  this.handleReferencedChange(info, oldData, newData);
                }
              });
              if (retEvs.length > 0) {
                const r2 = srow.slice();
                r2[rt] = newData;
                r2[nrt + rt] = nt;
                setReturningOldNew(q, r2, t.data, newData);
                returning.push(retEvs.map((ev) => ev(this.executor.rowCtx(r2, base))));
              }
            }
            break;
          }
        }
      }
    }
    if (hasBySource) {
      for (const t of targets) {
        if (matchedTargets.has(t)) {
          continue;
        }
        const row = base.row.slice();
        row[rt] = t.data;
        row[nrt + rt] = t;
        const ctx = this.executor.rowCtx(row, base);
        for (const a of actions) {
          if (a.matchKind !== 'NOT_MATCHED_BY_SOURCE') {
            continue;
          }
          if (a.condition && plan.ev(a.condition)(ctx) !== true) {
            continue;
          }
          if (a.command === 'DELETE') {
            if (this.deleteTuple(info, heap, t, info.rel, false)) {
              rowCount++;
              if (retEvs.length > 0) {
                const r2 = row.slice();
                setReturningOldNew(q, r2, t.data, null);
                returning.push(retEvs.map((ev) => ev(this.executor.rowCtx(r2, base))));
              }
              if (info.fksIn.length > 0) {
                const oldData = t.data;
                this.st.afterQueue.push(() => this.handleReferencedChange(info, oldData, null));
              }
            }
          } else if (a.command === 'UPDATE') {
            const newData = t.data.slice();
            for (const s of a.targetList) {
              const col = info.live[s.attIndex];
              newData[col.attnum - 1] = s.expr.k === 'default' ? this.defaultValue(info, col) : plan.ev(s.expr)(ctx);
            }
            const nt = this.updateTuple(info, heap, t, newData, info.rel, false);
            if (nt) {
              rowCount++;
              const oldData = t.data;
              this.st.afterQueue.push(() => {
                if (info.fksOut.length > 0) {
                  this.checkForeignKeysOut(info, newData, info.rel, oldData);
                }
                if (info.fksIn.length > 0) {
                  this.handleReferencedChange(info, oldData, newData);
                }
              });
              if (retEvs.length > 0) {
                const r2 = row.slice();
                r2[rt] = newData;
                r2[nrt + rt] = nt;
                setReturningOldNew(q, r2, t.data, newData);
                returning.push(retEvs.map((ev) => ev(this.executor.rowCtx(r2, base))));
              }
            }
          }
          break;
        }
      }
    }
    this.st.afterQueue.push(() => {
      for (const ins of inserted) {
        if (ins.info.fksOut.length > 0) {
          this.checkForeignKeysOut(ins.info, ins.data, ins.rel);
        }
      }
    });
    return { rows: returning, rowCount };
  }
}

/** PG 18 RETURNING OLD/NEW: expose the pre- and post-change row under their range table entries. */
function setReturningOldNew(q: Query, row: unknown[], oldData: unknown[] | null, newData: unknown[] | null): void {
  if (q.returningOldRt !== undefined) {
    row[q.returningOldRt] = oldData;
  }
  if (q.returningNewRt !== undefined) {
    row[q.returningNewRt] = newData;
  }
}

function k2type(rel: Relation, i: number): number {
  const k = rel.partitionKey?.keys[i];
  if (k && k.attnum > 0) {
    return rel.columns[k.attnum - 1].typeOid;
  }
  return TypeOid.text;
}

export type { Row };
