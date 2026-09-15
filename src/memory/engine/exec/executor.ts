import { IndexElemDef, Relation, StoredExpr, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import {
  CteEntry,
  CteRTE,
  FunctionRTE,
  JoinNode,
  JoinTreeNode,
  Query,
  RelationRTE,
  RTE,
  SetOpTree,
  SortGroupClause,
  TExpr,
  ValuesRTE,
} from '../analyze/nodes';
import { forEachChild } from '../analyze/walk';
import { Heap, Tuple } from '../storage/mvcc';
import { lockTuple, Store } from '../storage/store';
import { PgNumeric } from '../types/numeric';
import { PgRecord } from '../types/values';
import { CompileEnv, compileExpr, RtInfo } from './compile';
import { groupAndAggregate, computeWindowFunctions } from './exec-agg';
import { JSON_TO_RECORD_FUNCS, jsonToRecordRows } from './functions/json-fns';
import { lookupSrf } from './functions/registry';
import { pgQsort } from './pgsort';
import { pushQualsIntoSubquery, queryHasVolatile } from './pushdown';
import { containsVolatile, exprRelids, joinTreeRelids, nonNullableRels, splitConjuncts } from './relids';
import { EvalCtx, Evaluator, ExecSession, FnCall, StatementState, SubqueryRunner } from './runtime';
import { NULL_KEY } from './typeops';

export interface ExecutorHost {
  store: Store;
  session: ExecSession;
  /** assign (if needed) and return the statement's transaction id */
  ensureXid(st: StatementState): number;
  /** rows of a builtin catalog relation, in the relation's column order */
  catalogRows(relOid: number, st: StatementState): unknown[][];
  /** execute a data-modifying query (top-level or CTE); returns RETURNING rows */
  executeModify(q: Query, ctx: EvalCtx, executor: Executor): { rows: unknown[][]; rowCount: number };
  /** heaps (with column mapping) that make up a relation scan (partitions / inheritance children) */
  relationHeaps(rel: Relation, inh: boolean, st: StatementState): { heap: Heap; rel: Relation }[];
  /** analyze a catalog expression over a single relation (index expressions for lookups) */
  analyzeRelationExpr?(rel: Relation, stored: StoredExpr, kind: 'check' | 'index' | 'generated' | 'predicate'): { q: Query; expr: TExpr };
}

/** An equality restriction a scan answers from a hash index over the heap. */
interface IndexLookup {
  physIndex: number;
  colType: number;
  value: Evaluator;
  valueType: number;
  /** col = ANY(array): the value is an array of keys */
  any?: boolean;
  /** the key is an index expression (`search_normalize(internal_id) = $1`), not a column */
  expr?: { spec: string; ev: Evaluator };
}

/** index expression keys that failed to evaluate for some tuple: such an index is not used */
const POISONED_EXPR_INDEX = Symbol('poisoned expression index');
const poisonedExprIndexes = new WeakMap<Heap, Set<string>>();

const lookupVolatility = new WeakMap<TExpr, { catalog: object; version: number; volatile: boolean }>();

/** the catalog index expression a conjunct's side matches, per conjunct and catalog version */
const exprIndexMatches = new WeakMap<TExpr, { catalog: object; version: number; match: { side: number; ix: Relation; key: IndexElemDef } | null }>();

export type Row = unknown[];

/** Compiled, cached information about one query level. */
export class QueryPlan {
  readonly nrt: number;
  private evCache = new Map<TExpr, Evaluator>();
  readonly compileEnv: CompileEnv;
  rtInfos: (RtInfo | undefined)[] = [];

  constructor(
    readonly q: Query,
    readonly parent: QueryPlan | null,
    readonly executor: Executor
  ) {
    this.nrt = q.rtable.length;
    this.compileEnv = {
      catalog: executor.st.catalog,
      typeOps: executor.host.session.typeOps,
      runner: executor,
      rtInfo: (levelsUp, rtIndex) => {
        let p: QueryPlan | null = this;
        for (let i = 0; i < levelsUp && p; i++) {
          p = p.parent;
        }
        return p ? p.rtInfo(rtIndex) : undefined;
      },
    };
  }

  rtInfo(rtIndex: number): RtInfo | undefined {
    if (this.rtInfos[rtIndex] !== undefined) {
      return this.rtInfos[rtIndex];
    }
    const rte = this.q.rtable[rtIndex];
    if (!rte) {
      return undefined;
    }
    let info: RtInfo;
    if (rte.kind === 'relation') {
      const rel = this.executor.st.catalog.getRelation(rte.relOid)!;
      const live = rel.columns.filter((c) => !c.isDropped);
      info = {
        physical: rte.attnums.map((a) => a - 1),
        missing: rte.attnums.map((a) => {
          const col = rel.columns[a - 1];
          return col && col.hasMissing ? col.missingValue : null;
        }),
        colTypes: rte.colTypes.map((c) => c.type),
        colNames: live.map((c) => c.name),
        rowType: rel.rowTypeOid || TypeOid.record,
        nrt: this.nrt,
        relOid: rel.oid,
      };
    } else {
      const rowType = rte.kind === 'catalog' && rte.rowTypeOid ? rte.rowTypeOid : TypeOid.record;
      info = { colTypes: rte.colTypes.map((c) => c.type), colNames: rte.eref.colnames, rowType, nrt: this.nrt };
    }
    this.rtInfos[rtIndex] = info;
    return info;
  }

  ev(e: TExpr): Evaluator {
    let f = this.evCache.get(e);
    if (!f) {
      f = compileExpr(e, this.compileEnv);
      this.evCache.set(e, f);
    }
    return f;
  }
}

/** Per-execution state of one query level. */
export class QueryInstance {
  cteResults = new Map<number, unknown[][]>();
  constructor(readonly plan: QueryPlan) {}
}

interface Conjunct {
  expr: TExpr;
  relids: Set<number>;
  volatile: boolean;
  used: boolean;
}

export class Executor implements SubqueryRunner {
  private plans = new WeakMap<Query, QueryPlan>();
  /** hash indexes over heaps, valid while heap.version unchanged */
  private depth = 0;

  constructor(
    readonly st: StatementState,
    readonly host: ExecutorHost
  ) {}

  planFor(q: Query, parent: QueryPlan | null): QueryPlan {
    let p = this.plans.get(q);
    if (!p) {
      p = new QueryPlan(q, parent, this);
      this.plans.set(q, p);
    }
    return p;
  }

  private planFromCtx(q: Query, outer: EvalCtx | null): QueryPlan {
    const parentPlan = outer && outer.inst ? (outer.inst as QueryInstance).plan : null;
    return this.planFor(q, parentPlan);
  }

  /** SubqueryRunner: run a sub-query with `outer` as its parent context. */
  run(query: Query, outer: EvalCtx, limit?: number): unknown[][] {
    return this.executeQuery(query, outer, limit).rows;
  }

  executeQuery(q: Query, outer: EvalCtx | null, limit?: number): { rows: unknown[][]; rowCount: number } {
    if (++this.depth > 400) {
      this.depth = 0;
      throw new PgError(SqlState.STATEMENT_TOO_COMPLEX, 'stack depth limit exceeded', { hint: 'Increase the configuration parameter "max_stack_depth".' });
    }
    try {
      const plan = this.planFromCtx(q, outer);
      const inst = new QueryInstance(plan);
      const base = new EvalCtx(new Array(plan.nrt * 2), outer, this.st);
      base.inst = inst;
      if (q.commandType !== 'select') {
        return this.host.executeModify(q, base, this);
      }
      const rows = this.executeSelect(plan, base, limit);
      // run data-modifying CTEs that were never referenced
      this.runPendingModifyingCtes(plan, base);
      return { rows, rowCount: rows.length };
    } finally {
      this.depth--;
    }
  }

  runPendingModifyingCtes(plan: QueryPlan, base: EvalCtx): void {
    const inst = base.inst as QueryInstance;
    for (const cte of plan.q.cteList) {
      if (cte.isModifying && !inst.cteResults.has(cte.id)) {
        this.materializeCte(cte, base);
      }
    }
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  private executeSelect(plan: QueryPlan, base: EvalCtx, limit?: number): unknown[][] {
    const q = plan.q;
    if (q.setOperations) {
      return this.executeSetOp(plan, base, limit);
    }
    // FROM + WHERE; when the rows go straight to a LIMIT (nothing groups, sorts, deduplicates, expands
    // or locks them), only the first ones are needed — like the Limit node that stops pulling rows
    let rowLimit: number | undefined;
    if (
      !q.hasAggs &&
      q.groupClause.length === 0 &&
      !q.havingQual &&
      !q.groupingSets &&
      !q.hasWindowFuncs &&
      !q.hasTargetSRFs &&
      !q.distinctClause &&
      q.sortClause.length === 0 &&
      q.rowMarks.length === 0
    ) {
      if (!q.limitWithTies && (limit !== undefined || q.limitCount)) {
        const offset = q.limitOffset ? this.evalLimit(plan.ev(q.limitOffset)(base), 'OFFSET') : 0;
        const count = q.limitCount ? this.evalLimit(plan.ev(q.limitCount)(base), 'LIMIT') : Infinity;
        const n = offset + Math.min(count, limit ?? Infinity);
        if (n !== Infinity) {
          rowLimit = n;
        }
      }
    }
    let rows = this.executeFromWhere(plan, base, [], rowLimit);
    if (rowLimit !== undefined && rows.length > rowLimit) {
      // the target list is evaluated for the rows the LIMIT returns only
      rows = rows.slice(0, rowLimit);
    }

    let ctxRows: EvalCtx[];
    if (q.hasAggs || q.groupClause.length > 0 || q.havingQual || q.groupingSets) {
      ctxRows = groupAndAggregate(this, plan, rows, base);
    } else {
      ctxRows = rows.map((r) => {
        const c = new EvalCtx(r, base.parent, this.st);
        c.inst = base.inst;
        return c;
      });
    }
    rows = [];
    let windowOrder: SortGroupClause[] | null = null;
    if (q.hasWindowFuncs) {
      const res = computeWindowFunctions(this, plan, ctxRows);
      ctxRows = res.rows;
      windowOrder = res.finalOrder;
    }

    // projection
    const tlist = q.targetList;
    const evs = tlist.map((te) => plan.ev(te.expr));
    let projected: { out: unknown[]; ctx: EvalCtx }[] = [];
    if (q.hasTargetSRFs) {
      projected = this.projectWithSrfs(plan, ctxRows);
    } else {
      projected = new Array(ctxRows.length);
      for (let i = 0; i < ctxRows.length; i++) {
        const c = ctxRows[i];
        const out = new Array(evs.length);
        for (let j = 0; j < evs.length; j++) {
          out[j] = evs[j](c);
        }
        projected[i] = { out, ctx: c };
      }
    }
    void windowOrder;

    // DISTINCT
    if (q.distinctClause) {
      projected = this.applyDistinct(plan, projected);
    }

    // ORDER BY
    if (q.sortClause.length > 0) {
      const cmp = this.makeRowComparator(plan, q.sortClause);
      pgQsort(projected, (a, b) => cmp(a.out, b.out));
    }

    // LIMIT / OFFSET (+ row locks)
    const offset = q.limitOffset ? this.evalLimit(plan.ev(q.limitOffset)(base), 'OFFSET') : 0;
    let count = q.limitCount ? this.evalLimit(plan.ev(q.limitCount)(base), 'LIMIT') : Infinity;
    if (q.limitCount && plan.ev(q.limitCount)(base) === null) {
      count = Infinity;
    }
    let result: { out: unknown[]; ctx: EvalCtx }[];
    if (q.rowMarks.length > 0) {
      result = this.applyRowLocks(plan, projected, offset, count);
    } else if (offset > 0 || count !== Infinity) {
      let end = count === Infinity ? projected.length : offset + count;
      if (q.limitWithTies && count !== Infinity && end < projected.length && end > offset) {
        const cmp = this.makeRowComparator(plan, q.sortClause);
        while (end < projected.length && cmp(projected[end - 1].out, projected[end].out) === 0) {
          end++;
        }
      }
      result = projected.slice(offset, end);
    } else {
      result = projected;
    }
    if (limit !== undefined && result.length > limit) {
      result = result.slice(0, limit);
    }
    const visibleIdx: number[] = [];
    tlist.forEach((te, i) => {
      if (!te.resjunk) {
        visibleIdx.push(i);
      }
    });
    if (visibleIdx.length === tlist.length) {
      return result.map((r) => r.out);
    }
    return result.map((r) => visibleIdx.map((i) => r.out[i]));
  }

  evalLimit(v: unknown, what: string): number {
    if (v === null) {
      return what === 'OFFSET' ? 0 : Infinity;
    }
    const n = Number(v);
    if (n < 0) {
      if (what === 'LIMIT') {
        throw new PgError(SqlState.INVALID_ROW_COUNT_IN_LIMIT_CLAUSE, 'LIMIT must not be negative');
      }
      throw new PgError(SqlState.INVALID_ROW_COUNT_IN_RESULT_OFFSET_CLAUSE, 'OFFSET must not be negative');
    }
    return n;
  }

  /** Comparator over projected output rows for a sort clause. */
  makeRowComparator(plan: QueryPlan, clauses: SortGroupClause[]): (a: unknown[], b: unknown[]) => number {
    const q = plan.q;
    const keys = clauses.map((sc) => {
      const idx = q.targetList.findIndex((t) => t.sortGroupRef === sc.tleSortGroupRef);
      const te = q.targetList[idx];
      let cmp = this.host.session.typeOps.comparator(te.expr.type, te.expr.collation);
      if (sc.useOpName && sc.useOpName !== '<' && sc.useOpName !== '>') {
        cmp = this.host.session.typeOps.comparator(te.expr.type, te.expr.collation);
      }
      return { idx, desc: sc.desc, nullsFirst: sc.nullsFirst, cmp };
    });
    return (a, b) => {
      for (const k of keys) {
        const x = a[k.idx];
        const y = b[k.idx];
        if (x === null || y === null) {
          if (x === null && y === null) {
            continue;
          }
          const r = x === null ? 1 : -1;
          return k.nullsFirst ? -r : r;
        }
        let r = k.cmp(x, y);
        if (r !== 0) {
          if (k.desc) {
            r = -r;
          }
          return r;
        }
      }
      return 0;
    };
  }

  private applyDistinct(plan: QueryPlan, rows: { out: unknown[]; ctx: EvalCtx }[]): { out: unknown[]; ctx: EvalCtx }[] {
    const q = plan.q;
    const clauses = q.distinctClause!;
    const idxs = clauses.map((sc) => q.targetList.findIndex((t) => t.sortGroupRef === sc.tleSortGroupRef));
    const types = idxs.map((i) => q.targetList[i].expr.type);
    const typeOps = this.host.session.typeOps;
    if (q.hasDistinctOn) {
      // DISTINCT ON: keep the first row of each group in ORDER BY order
      if (q.sortClause.length > 0) {
        const cmp = this.makeRowComparator(plan, q.sortClause);
        pgQsort(rows, (a, b) => cmp(a.out, b.out));
      }
      const seen = new Set<unknown>();
      const out: { out: unknown[]; ctx: EvalCtx }[] = [];
      for (const r of rows) {
        const key = typeOps.multiKey(
          types,
          idxs.map((i) => r.out[i])
        );
        if (!seen.has(key)) {
          seen.add(key);
          out.push(r);
        }
      }
      return out;
    }
    const seen = new Set<unknown>();
    const out: { out: unknown[]; ctx: EvalCtx }[] = [];
    for (const r of rows) {
      const key = typeOps.multiKey(
        types,
        idxs.map((i) => r.out[i])
      );
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
    return out;
  }

  private projectWithSrfs(plan: QueryPlan, ctxRows: EvalCtx[]): { out: unknown[]; ctx: EvalCtx }[] {
    const tlist = plan.q.targetList;
    const out: { out: unknown[]; ctx: EvalCtx }[] = [];
    const srfCols: (null | ((c: EvalCtx) => unknown[]))[] = tlist.map((te) => this.srfEvaluator(plan, te.expr));
    const evs = tlist.map((te) => plan.ev(te.expr));
    for (const c of ctxRows) {
      const srfResults: (unknown[] | null)[] = srfCols.map((s) => (s ? s(c) : null));
      let n = 0;
      let anySrf = false;
      for (const r of srfResults) {
        if (r) {
          anySrf = true;
          n = Math.max(n, r.length);
        }
      }
      if (!anySrf) {
        out.push({ out: evs.map((e) => e(c)), ctx: c });
        continue;
      }
      for (let i = 0; i < n; i++) {
        const row = tlist.map((te, j) => {
          const r = srfResults[j];
          if (r) {
            return i < r.length ? r[i] : null;
          }
          return evs[j](c);
        });
        out.push({ out: row, ctx: c });
      }
    }
    return out;
  }

  /** If the expression is (or wraps) a set-returning function call, return an evaluator yielding all values. */
  private srfEvaluator(plan: QueryPlan, e: TExpr): ((c: EvalCtx) => unknown[]) | null {
    if (e.k === 'func' && e.retset) {
      const argEvs = e.args.map((a) => plan.ev(a));
      const impl = this.srfImpl(e);
      const argTypes = e.args.map((a) => a.type);
      return (c) => {
        const args = argEvs.map((a) => a(c));
        if (e.strict && args.some((a) => a === null)) {
          return [];
        }
        const vals = impl(args, { st: this.st, argTypes, resultType: e.type, resultTypmod: e.typmod, collation: e.inputCollation, node: e });
        return vals.map((v) => (Array.isArray(v) && this.isCompositeResult(e) ? new PgRecord(v, e.type, [], []) : v));
      };
    }
    // SRF nested inside a scalar expression, e.g. unnest(x) + 1
    let nested: TExpr | null = null;
    const find = (x: TExpr) => {
      if (nested) {
        return;
      }
      if (x.k === 'func' && x.retset) {
        nested = x;
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../analyze/walk').forEachChild(x, find);
    };
    find(e);
    if (!nested) {
      return null;
    }
    const inner = this.srfEvaluator(plan, nested)!;
    const slot = -1000 - this.st.execParams.length;
    void slot;
    const replaced = replaceNode(e, nested, { k: 'execparam', slot: 9999, type: (nested as TExpr).type, typmod: -1, collation: 0 });
    const outerEv = plan.ev(replaced);
    return (c) => {
      const vals = inner(c);
      return vals.map((v) => {
        const saved = this.st.execParams[9999];
        this.st.execParams[9999] = v;
        try {
          return outerEv(c);
        } finally {
          this.st.execParams[9999] = saved;
        }
      });
    };
  }

  private isCompositeResult(e: TExpr & { k: 'func' }): boolean {
    const proc = this.st.catalog.getProc(e.funcOid);
    return !!proc && !!proc.argmodes && proc.argmodes.filter((m) => m === 'o' || m === 'b' || m === 't').length > 1;
  }

  srfImpl(e: TExpr & { k: 'func' }): (args: unknown[], fc: FnCall) => unknown[] {
    if (e.isUser) {
      const proc = this.st.catalog.getProc(e.funcOid)!;
      return (args, fc) => {
        const r = fc.st.session.callUserFunction(proc, args, e.args.map((a) => a.type), fc.st);
        return r.rows ?? [];
      };
    }
    const impl = lookupSrf(e.funcSrc, e.funcName);
    if (!impl) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: set-returning function ${e.funcName} (${e.funcSrc}) is not implemented`);
    }
    return impl as (args: unknown[], fc: FnCall) => unknown[];
  }

  // -------------------------------------------------------------------------
  // Row locking (FOR UPDATE / SHARE)
  // -------------------------------------------------------------------------

  private applyRowLocks(plan: QueryPlan, rows: { out: unknown[]; ctx: EvalCtx }[], offset: number, count: number): { out: unknown[]; ctx: EvalCtx }[] {
    const q = plan.q;
    const xid = this.host.ensureXid(this.st);
    const result: { out: unknown[]; ctx: EvalCtx }[] = [];
    let skipped = 0;
    for (const r of rows) {
      if (result.length >= count) {
        break;
      }
      let skip = false;
      for (const mark of q.rowMarks) {
        const rte = q.rtable[mark.rtIndex];
        if (rte.kind !== 'relation') {
          continue;
        }
        const tuple = r.ctx.row[plan.nrt + mark.rtIndex] as Tuple | undefined;
        if (!tuple) {
          continue;
        }
        const outcome = lockTuple(this.host.store, tuple, xid, mark.strength, mark.waitPolicy, rte.eref.aliasname === rte.relname ? rte.relname : this.st.catalog.getRelation(rte.relOid)!.name, true);
        if (outcome === 'skip' || outcome === 'deleted') {
          skip = true;
          break;
        }
      }
      if (skip) {
        continue;
      }
      if (skipped < offset) {
        skipped++;
        continue;
      }
      result.push(r);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Set operations
  // -------------------------------------------------------------------------

  private executeSetOp(plan: QueryPlan, base: EvalCtx, limit?: number): unknown[][] {
    const q = plan.q;
    const typeOps = this.host.session.typeOps;
    const tree = q.setOperations!;
    const colTypes = tree.k === 'setop' ? tree.colTypes.map((c) => c.type) : [];
    const evalTree = (t: SetOpTree): unknown[][] => {
      if (t.k === 'leaf') {
        const rte = q.rtable[t.rtIndex];
        if (rte.kind !== 'subquery') {
          throw new PgError(SqlState.INTERNAL_ERROR, 'set operation leaf is not a subquery');
        }
        return this.executeQuery(rte.subquery, base).rows;
      }
      const left = evalTree(t.larg);
      const right = evalTree(t.rarg);
      const types = t.colTypes.map((c) => c.type);
      const key = (r: unknown[]) => typeOps.multiKey(types, r);
      switch (t.op) {
        case 'UNION': {
          if (t.all) {
            return left.concat(right);
          }
          const seen = new Set<unknown>();
          const out: unknown[][] = [];
          for (const r of left.concat(right)) {
            const k = key(r);
            if (!seen.has(k)) {
              seen.add(k);
              out.push(r);
            }
          }
          return out;
        }
        case 'INTERSECT': {
          const counts = new Map<unknown, number>();
          for (const r of right) {
            const k = key(r);
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          const out: unknown[][] = [];
          const emitted = new Set<unknown>();
          for (const r of left) {
            const k = key(r);
            const c = counts.get(k) ?? 0;
            if (c > 0) {
              if (t.all) {
                out.push(r);
                counts.set(k, c - 1);
              } else if (!emitted.has(k)) {
                emitted.add(k);
                out.push(r);
              }
            }
          }
          return out;
        }
        case 'EXCEPT': {
          const counts = new Map<unknown, number>();
          for (const r of right) {
            const k = key(r);
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          const out: unknown[][] = [];
          const emitted = new Set<unknown>();
          for (const r of left) {
            const k = key(r);
            const c = counts.get(k) ?? 0;
            if (t.all) {
              if (c > 0) {
                counts.set(k, c - 1);
              } else {
                out.push(r);
              }
            } else if (c === 0 && !emitted.has(k)) {
              emitted.add(k);
              out.push(r);
            }
          }
          return out;
        }
      }
    };
    void colTypes;
    let rows = evalTree(tree);
    let projected = rows.map((r) => {
      const c = new EvalCtx([], base.parent, this.st);
      c.setOpRow = r;
      c.inst = base.inst;
      return { out: r, ctx: c };
    });
    if (q.sortClause.length > 0) {
      const cmp = this.makeRowComparator(plan, q.sortClause);
      pgQsort(projected, (a, b) => cmp(a.out, b.out));
    }
    const offset = q.limitOffset ? this.evalLimit(plan.ev(q.limitOffset)(base), 'OFFSET') : 0;
    const count = q.limitCount ? this.evalLimit(plan.ev(q.limitCount)(base), 'LIMIT') : Infinity;
    if (offset > 0 || count !== Infinity) {
      projected = projected.slice(offset, count === Infinity ? undefined : offset + count);
    }
    rows = projected.map((p) => p.out);
    if (limit !== undefined && rows.length > limit) {
      rows = rows.slice(0, limit);
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // FROM / WHERE
  // -------------------------------------------------------------------------

  /** `rowLimit`: only that many rows are needed, in scan order (LIMIT with nothing in between) */
  executeFromWhere(plan: QueryPlan, base: EvalCtx, extraConjuncts: TExpr[] = [], rowLimit?: number): Row[] {
    const q = plan.q;
    const conjuncts: Conjunct[] = [...splitConjuncts(q.where), ...extraConjuncts].map((expr) => ({
      expr,
      relids: exprRelids(expr),
      volatile: containsVolatile(expr),
      used: false,
    }));
    if (rowLimit !== undefined && q.fromlist.length === 1 && q.fromlist[0].k === 'ref') {
      // a single table whose restrictions the scan applies itself: stop reading once enough rows matched
      const rtIndex = q.fromlist[0].rtIndex;
      const rte = q.rtable[rtIndex];
      if (rte.kind === 'relation' && conjuncts.every((c) => c.relids.size === 1 && c.relids.has(rtIndex))) {
        for (const c of conjuncts) {
          c.used = true;
        }
        return this.scanRelation(plan, base, rtIndex, rte, conjuncts, rowLimit);
      }
    }
    let rows: Row[] = [base.row.slice()];
    const available = new Set<number>();
    for (const item of q.fromlist) {
      rows = this.joinFromItem(plan, base, rows, available, item, conjuncts);
    }
    // remaining conjuncts (no relids or not yet applied)
    const remaining = conjuncts.filter((c) => !c.used);
    if (remaining.length > 0) {
      const evs = remaining.map((c) => plan.ev(c.expr));
      rows = rows.filter((r) => {
        const c = this.rowCtx(r, base);
        for (const ev of evs) {
          if (ev(c) !== true) {
            return false;
          }
        }
        return true;
      });
      for (const c of remaining) {
        c.used = true;
      }
    }
    return rows;
  }

  rowCtx(row: Row, base: EvalCtx): EvalCtx {
    const c = new EvalCtx(row, base.parent, this.st);
    c.inst = base.inst;
    return c;
  }

  /** Relids an item's own expressions depend on (for LATERAL detection). */
  private itemDependsOn(plan: QueryPlan, item: JoinTreeNode, available: Set<number>): boolean {
    if (available.size === 0) {
      return false;
    }
    const check = (j: JoinTreeNode): boolean => {
      if (j.k === 'join') {
        return check(j.larg) || check(j.rarg);
      }
      const rte = plan.q.rtable[j.rtIndex];
      if (!rte.lateral) {
        return false;
      }
      let rel: Set<number>;
      if (rte.kind === 'subquery') {
        rel = new Set<number>();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const refs = collectSubqueryOuterRelids(rte.subquery);
        refs.forEach((r) => rel.add(r));
      } else if (rte.kind === 'function') {
        rel = new Set<number>();
        for (const f of rte.functions) {
          exprRelids(f.expr).forEach((r) => rel.add(r));
        }
      } else if (rte.kind === 'values') {
        rel = new Set<number>();
        for (const row of rte.lists) {
          for (const v of row) {
            exprRelids(v).forEach((r) => rel.add(r));
          }
        }
      } else {
        return false;
      }
      for (const r of rel) {
        if (available.has(r)) {
          return true;
        }
      }
      return false;
    };
    return check(item);
  }

  private joinFromItem(plan: QueryPlan, base: EvalCtx, leftRows: Row[], available: Set<number>, item: JoinTreeNode, conjuncts: Conjunct[]): Row[] {
    const itemRels = joinTreeRelids(item);
    const lateral = this.itemDependsOn(plan, item, available);
    // conjuncts that can be pushed into this item alone
    const pushable = conjuncts.filter((c) => !c.used && c.relids.size > 0 && [...c.relids].every((r) => itemRels.has(r)));
    // conjuncts joining left and this item
    const joinConj = conjuncts.filter((c) => !c.used && !pushable.includes(c) && [...c.relids].every((r) => itemRels.has(r) || available.has(r)) && [...c.relids].some((r) => itemRels.has(r)));
    let out: Row[];
    if (!lateral) {
      let itemRows = this.produceItem(plan, base, item, pushable);
      for (const p of pushable) {
        p.used = true;
      }
      if (leftRows.length === 1 && available.size === 0) {
        // first item: merge the base row
        const b = leftRows[0];
        itemRows = itemRows.map((r) => mergeRows(b, r, itemRels, plan.nrt));
        out = itemRows;
      } else {
        out = this.innerJoin(plan, base, leftRows, itemRows, available, itemRels, joinConj);
      }
    } else {
      out = [];
      for (const left of leftRows) {
        const ctx = this.rowCtx(left, base);
        const itemRows = this.produceItem(plan, ctx, item, pushable);
        for (const r of itemRows) {
          out.push(mergeRows(left, r, itemRels, plan.nrt));
        }
      }
      for (const p of pushable) {
        p.used = true;
      }
    }
    for (const r of itemRels) {
      available.add(r);
    }
    // apply conjuncts now fully available
    const nowReady = conjuncts.filter((c) => !c.used && c.relids.size > 0 && [...c.relids].every((r) => available.has(r)));
    if (nowReady.length > 0) {
      const evs = nowReady.map((c) => plan.ev(c.expr));
      out = out.filter((r) => {
        const c = this.rowCtx(r, base);
        for (const ev of evs) {
          if (ev(c) !== true) {
            return false;
          }
        }
        return true;
      });
      for (const c of nowReady) {
        c.used = true;
      }
    }
    return out;
  }

  /** Inner join (cross join + conjuncts) preserving nested-loop order, using hashing for equality conjuncts. */
  private innerJoin(plan: QueryPlan, base: EvalCtx, leftRows: Row[], rightRows: Row[], leftRels: Set<number>, rightRels: Set<number>, joinConj: Conjunct[]): Row[] {
    const hashKeys = this.findHashKeys(plan, joinConj, leftRels, rightRels);
    const out: Row[] = [];
    if (hashKeys.length > 0) {
      for (const hk of hashKeys) {
        hk.conj.used = true;
      }
      const residual = joinConj.filter((c) => !c.used);
      const residualEvs = residual.map((c) => plan.ev(c.expr));
      const buckets = new Map<unknown, Row[]>();
      for (const r of rightRows) {
        const c = this.rowCtx(r, base);
        const key = this.compositeHashKey(hashKeys.map((h) => [h.rightType, h.right(c)]));
        if (key === NULL_KEY) {
          continue;
        }
        let b = buckets.get(key);
        if (!b) {
          b = [];
          buckets.set(key, b);
        }
        b.push(r);
      }
      for (const l of leftRows) {
        const lc = this.rowCtx(l, base);
        const key = this.compositeHashKey(hashKeys.map((h) => [h.leftType, h.left(lc)]));
        if (key === NULL_KEY) {
          continue;
        }
        const matches = buckets.get(key);
        if (!matches) {
          continue;
        }
        for (const r of matches) {
          const merged = mergeRows(l, r, rightRels, plan.nrt);
          if (residualEvs.length > 0) {
            const c = this.rowCtx(merged, base);
            if (!residualEvs.every((ev) => ev(c) === true)) {
              continue;
            }
          }
          out.push(merged);
        }
      }
      for (const c of residual) {
        c.used = true;
      }
      return out;
    }
    const evs = joinConj.map((c) => plan.ev(c.expr));
    for (const c of joinConj) {
      c.used = true;
    }
    for (const l of leftRows) {
      for (const r of rightRows) {
        const merged = mergeRows(l, r, rightRels, plan.nrt);
        if (evs.length > 0) {
          const c = this.rowCtx(merged, base);
          let ok = true;
          for (const ev of evs) {
            if (ev(c) !== true) {
              ok = false;
              break;
            }
          }
          if (!ok) {
            continue;
          }
        }
        out.push(merged);
      }
    }
    return out;
  }

  private compositeHashKey(parts: [number, unknown][]): unknown {
    const typeOps = this.host.session.typeOps;
    if (parts.length === 1) {
      const [t, v] = parts[0];
      if (v === null) {
        return NULL_KEY;
      }
      return hashFamilyKey(t, v, typeOps);
    }
    let s = '';
    for (const [t, v] of parts) {
      if (v === null) {
        return NULL_KEY;
      }
      const k = hashFamilyKey(t, v, typeOps);
      s += typeof k + ':' + String(k).length + ':' + String(k) + '|';
    }
    return s;
  }

  /** Equality conjuncts of the form f(left) = g(right) usable for hashing. */
  private findHashKeys(
    plan: QueryPlan,
    conj: Conjunct[],
    leftRels: Set<number>,
    rightRels: Set<number>
  ): { conj: Conjunct; left: Evaluator; right: Evaluator; leftType: number; rightType: number }[] {
    const out: { conj: Conjunct; left: Evaluator; right: Evaluator; leftType: number; rightType: number }[] = [];
    for (const c of conj) {
      const e = c.expr;
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2 || c.volatile) {
        continue;
      }
      if (!isHashableEquality(e.funcSrc, e.args[0].type, e.args[1].type, plan, e.inputCollation)) {
        continue;
      }
      const r0 = exprRelids(e.args[0]);
      const r1 = exprRelids(e.args[1]);
      const subset = (s: Set<number>, of: Set<number>) => s.size > 0 && [...s].every((x) => of.has(x));
      if (subset(r0, leftRels) && subset(r1, rightRels)) {
        out.push({ conj: c, left: plan.ev(e.args[0]), right: plan.ev(e.args[1]), leftType: e.args[0].type, rightType: e.args[1].type });
      } else if (subset(r1, leftRels) && subset(r0, rightRels)) {
        out.push({ conj: c, left: plan.ev(e.args[1]), right: plan.ev(e.args[0]), leftType: e.args[1].type, rightType: e.args[0].type });
      }
    }
    return out;
  }

  /**
   * Index nested loop for `left JOIN relation ON relation.col = f(left) [AND ...]` (INNER / LEFT, right
   * side a plain table): probes the heap's column index per left row instead of producing and hashing
   * the whole table. Output order equals the hash join's: left order, then heap order per match.
   * Returns null when the shape does not apply.
   */
  private indexNestLoop(
    plan: QueryPlan,
    ctx: EvalCtx,
    j: JoinNode,
    leftRows: Row[],
    leftRels: Set<number>,
    rightRels: Set<number>,
    rightFilters: Conjunct[],
    quals: Conjunct[],
    isLeft: boolean
  ): Row[] | null {
    if (j.rarg.k !== 'ref') {
      return null;
    }
    const rtIndex = j.rarg.rtIndex;
    const rte = plan.q.rtable[rtIndex];
    if (rte.kind !== 'relation') {
      return null;
    }
    const rel = this.st.catalog.getRelation(rte.relOid);
    if (!rel || rel.kind === 'S' || rel.kind === 'p') {
      return null;
    }
    const parts = this.host.relationHeaps(rel, rte.inh, this.st);
    if (parts.length !== 1 || parts[0].rel !== rel) {
      return null;
    }
    let probe: { conj: Conjunct; physIndex: number; colType: number; value: Evaluator; valueType: number } | null = null;
    for (const c of quals) {
      const e = c.expr;
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2 || c.volatile) {
        continue;
      }
      for (const [colSide, valSide] of [
        [0, 1],
        [1, 0],
      ]) {
        const col = stripRelabel(e.args[colSide]);
        const val = e.args[valSide];
        if (col.k !== 'var' || col.levelsUp !== 0 || col.rtIndex !== rtIndex || col.attno < 0) {
          continue;
        }
        const valRels = exprRelids(val);
        if (valRels.size === 0 || ![...valRels].every((r) => leftRels.has(r)) || containsVolatile(val)) {
          continue;
        }
        const phys = rte.attnums[col.attno] - 1;
        if (phys < 0 || rel.columns[phys]?.hasMissing || !isHashableEquality(e.funcSrc, col.type, val.type, plan, e.inputCollation)) {
          continue;
        }
        probe = { conj: c, physIndex: phys, colType: col.type, value: plan.ev(val), valueType: val.type };
        break;
      }
      if (probe) {
        break;
      }
    }
    if (!probe) {
      return null;
    }
    const nrt = plan.nrt;
    const heap = parts[0].heap;
    const index = this.heapIndex(heap, probe.physIndex, probe.colType);
    const vis = this.host.store.vis;
    const snap = this.st.snapshot;
    const typeOps = this.host.session.typeOps;
    const checks = [...rightFilters, ...quals.filter((c) => c !== probe!.conj)].map((c) => plan.ev(c.expr));
    const out: Row[] = [];
    for (const l of leftRows) {
      let matched = false;
      const value = probe.value(this.rowCtx(l, ctx));
      const candidates = value === null ? undefined : index.get(hashFamilyKey(probe.valueType, value, typeOps));
      if (candidates) {
        for (const t of candidates) {
          if (!vis.visible(t, snap)) {
            continue;
          }
          // the left rows belong to this join alone: the first output row of each reuses its array
          // (only the right relation's slots change, and a later match overwrites them in a copy)
          const m = matched ? l.slice() : l;
          m[rtIndex] = t.data;
          m[nrt + rtIndex] = t;
          if (checks.length > 0) {
            const mc = this.rowCtx(m, ctx);
            let ok = true;
            for (const ev of checks) {
              if (ev(mc) !== true) {
                ok = false;
                break;
              }
            }
            if (!ok) {
              continue;
            }
          }
          matched = true;
          out.push(m);
        }
      }
      if (!matched && isLeft) {
        // (a candidate that failed the checks may have been written into the reused left row)
        l[rtIndex] = null;
        l[nrt + rtIndex] = undefined;
        out.push(l);
      }
    }
    for (const c of quals) {
      c.used = true;
    }
    return out;
  }

  /**
   * produceItem plus join quals restricted to that item: handed down so a scan can use them for index
   * lookups, and always enforced on the produced rows (a join child may not apply them itself).
   */
  private produceWithQuals(plan: QueryPlan, ctx: EvalCtx, item: JoinTreeNode, push: Conjunct[], quals: Conjunct[]): Row[] {
    if (quals.length === 0) {
      return this.produceItem(plan, ctx, item, push);
    }
    const handed = item.k === 'ref' ? quals.filter((c) => c.relids.size === 1 && c.relids.has(item.rtIndex)) : [];
    let rows = this.produceItem(plan, ctx, item, [...push, ...handed]);
    const leftover = quals.filter((c) => !handed.includes(c));
    if (leftover.length > 0) {
      const evs = leftover.map((c) => plan.ev(c.expr));
      rows = rows.filter((r) => {
        const rc = this.rowCtx(r, ctx);
        for (const ev of evs) {
          if (ev(rc) !== true) {
            return false;
          }
        }
        return true;
      });
    }
    return rows;
  }

  /** Rows of a join tree item (independent of any left rows unless `ctx` carries a lateral row). */
  private produceItem(plan: QueryPlan, ctx: EvalCtx, item: JoinTreeNode, pushable: Conjunct[]): Row[] {
    if (item.k === 'ref') {
      return this.scanRte(plan, ctx, item.rtIndex, pushable);
    }
    return this.executeJoin(plan, ctx, item, pushable);
  }

  private executeJoin(plan: QueryPlan, ctx: EvalCtx, j: JoinNode, pushable: Conjunct[]): Row[] {
    const leftRels = joinTreeRelids(j.larg);
    const rightRels = joinTreeRelids(j.rarg);
    const joinType = this.reducedJoinType(j, pushable, rightRels);
    // push filters into children when semantically safe
    const leftPush = pushable.filter((c) => (joinType === 'INNER' || joinType === 'CROSS' || joinType === 'LEFT') && [...c.relids].every((r) => leftRels.has(r)));
    const rightPush = pushable.filter((c) => (joinType === 'INNER' || joinType === 'CROSS' || joinType === 'RIGHT') && [...c.relids].every((r) => rightRels.has(r)));
    let quals = splitConjuncts(j.quals).map((expr) => ({ expr, relids: exprRelids(expr), volatile: containsVolatile(expr), used: false }));
    // join quals that only constrain one input (or only outer columns / parameters) filter that input
    // before joining — on the nullable side of an outer join too, which cannot change the result:
    // a filtered-out row could not have matched anyway
    const onlyFrom = (c: Conjunct, rels: Set<number>) => !c.volatile && [...c.relids].every((r) => rels.has(r));
    const qualToRight = joinType === 'INNER' || joinType === 'CROSS' || joinType === 'LEFT';
    const qualToLeft = joinType === 'INNER' || joinType === 'CROSS' || joinType === 'RIGHT';
    const leftQuals: Conjunct[] = [];
    const rightQuals: Conjunct[] = [];
    for (const c of quals) {
      if (qualToRight && onlyFrom(c, rightRels)) {
        rightQuals.push(c);
      } else if (qualToLeft && c.relids.size > 0 && onlyFrom(c, leftRels)) {
        leftQuals.push(c);
      }
    }
    quals = quals.filter((c) => !leftQuals.includes(c) && !rightQuals.includes(c));
    const lateral = this.itemDependsOn(plan, j.rarg, leftRels);
    if ((joinType === 'INNER' || joinType === 'CROSS') && !lateral) {
      // restrictions from above that relate both inputs are join clauses of an inner join: they can
      // drive hashing / index probes instead of filtering a cross product
      for (const c of pushable) {
        if (!c.used && !c.volatile && [...c.relids].some((r) => leftRels.has(r)) && [...c.relids].some((r) => rightRels.has(r)) && [...c.relids].every((r) => leftRels.has(r) || rightRels.has(r))) {
          quals.push(c);
        }
      }
      const probed = this.probeLeftRelation(plan, ctx, j, leftRels, rightRels, leftPush, leftQuals, rightPush, rightQuals, quals);
      if (probed) {
        for (const c of [...leftPush, ...rightPush, ...quals]) {
          c.used = true;
        }
        return this.applyRemaining(plan, ctx, probed, quals, pushable, j);
      }
    }
    const leftRows = this.produceWithQuals(plan, ctx, j.larg, leftPush, leftQuals);
    for (const c of leftPush) {
      c.used = true;
    }
    const out: Row[] = [];
    const nrt = plan.nrt;
    if (joinType === 'INNER' || joinType === 'CROSS') {
      if (!lateral) {
        const inl = this.indexNestLoop(plan, ctx, j, leftRows, leftRels, rightRels, [...rightPush, ...rightQuals], quals, false);
        if (inl) {
          for (const c of rightPush) {
            c.used = true;
          }
          return this.applyRemaining(plan, ctx, inl, quals, pushable, j);
        }
        const rightRows = this.produceWithQuals(plan, ctx, j.rarg, rightPush, rightQuals);
        for (const c of rightPush) {
          c.used = true;
        }
        const rows = this.innerJoin(plan, ctx, leftRows, rightRows, leftRels, rightRels, quals);
        return this.applyRemaining(plan, ctx, rows, quals, pushable, j);
      }
      for (const l of leftRows) {
        const lc = this.rowCtx(l, ctx);
        const rightRows = this.produceWithQuals(plan, lc, j.rarg, rightPush, rightQuals);
        const merged = rightRows.map((r) => mergeRows(l, r, rightRels, nrt));
        const evs = quals.map((c) => plan.ev(c.expr));
        for (const m of merged) {
          const mc = this.rowCtx(m, ctx);
          if (evs.every((ev) => ev(mc) === true)) {
            out.push(m);
          }
        }
      }
      for (const c of rightPush) {
        c.used = true;
      }
      return this.applyRemaining(plan, ctx, out, [], pushable, j);
    }

    const qualEvs = quals.map((c) => plan.ev(c.expr));
    const matchesFn = (m: Row): boolean => {
      if (qualEvs.length === 0) {
        return true;
      }
      const mc = this.rowCtx(m, ctx);
      for (const ev of qualEvs) {
        if (ev(mc) !== true) {
          return false;
        }
      }
      return true;
    };

    if (joinType === 'LEFT') {
      const inl = lateral ? null : this.indexNestLoop(plan, ctx, j, leftRows, leftRels, rightRels, [...rightPush, ...rightQuals], quals, true);
      if (inl) {
        for (const c of rightPush) {
          c.used = true;
        }
        return this.applyRemaining(plan, ctx, inl, [], pushable, j);
      }
      if (!lateral) {
        const rightRows = this.produceWithQuals(plan, ctx, j.rarg, rightPush, rightQuals);
        const hashKeys = this.findHashKeys(plan, quals, leftRels, rightRels);
        if (hashKeys.length > 0) {
          const residual = quals.filter((c) => !hashKeys.some((h) => h.conj === c)).map((c) => plan.ev(c.expr));
          const buckets = new Map<unknown, Row[]>();
          for (const r of rightRows) {
            const rc = this.rowCtx(r, ctx);
            const key = this.compositeHashKey(hashKeys.map((h) => [h.rightType, h.right(rc)]));
            if (key === NULL_KEY) {
              continue;
            }
            let b = buckets.get(key);
            if (!b) {
              b = [];
              buckets.set(key, b);
            }
            b.push(r);
          }
          for (const l of leftRows) {
            const lc = this.rowCtx(l, ctx);
            const key = this.compositeHashKey(hashKeys.map((h) => [h.leftType, h.left(lc)]));
            let matched = false;
            if (key !== NULL_KEY) {
              for (const r of buckets.get(key) ?? []) {
                const m = mergeRows(l, r, rightRels, nrt);
                if (residual.length > 0) {
                  const mc = this.rowCtx(m, ctx);
                  if (!residual.every((ev) => ev(mc) === true)) {
                    continue;
                  }
                }
                matched = true;
                out.push(m);
              }
            }
            if (!matched) {
              out.push(nullExtend(l, rightRels, nrt));
            }
          }
        } else {
          for (const l of leftRows) {
            let matched = false;
            for (const r of rightRows) {
              const m = mergeRows(l, r, rightRels, nrt);
              if (matchesFn(m)) {
                matched = true;
                out.push(m);
              }
            }
            if (!matched) {
              out.push(nullExtend(l, rightRels, nrt));
            }
          }
        }
      } else {
        for (const l of leftRows) {
          const lc = this.rowCtx(l, ctx);
          const rightRows = this.produceWithQuals(plan, lc, j.rarg, rightPush, rightQuals);
          let matched = false;
          for (const r of rightRows) {
            const m = mergeRows(l, r, rightRels, nrt);
            if (matchesFn(m)) {
              matched = true;
              out.push(m);
            }
          }
          if (!matched) {
            out.push(nullExtend(l, rightRels, nrt));
          }
        }
      }
      for (const c of rightPush) {
        c.used = true;
      }
      return this.applyRemaining(plan, ctx, out, [], pushable, j);
    }

    // RIGHT / FULL
    const rightRows = this.produceItem(plan, ctx, j.rarg, rightPush);
    for (const c of rightPush) {
      c.used = true;
    }
    const rightMatched = new Array(rightRows.length).fill(false);
    if (joinType === 'RIGHT') {
      for (let ri = 0; ri < rightRows.length; ri++) {
        const r = rightRows[ri];
        let matched = false;
        for (const l of leftRows) {
          const m = mergeRows(l, r, rightRels, nrt);
          if (matchesFn(m)) {
            matched = true;
            out.push(m);
          }
        }
        if (!matched) {
          out.push(mergeRows(nullExtend(ctx.row.slice(), leftRels, nrt), r, rightRels, nrt));
        }
      }
      return this.applyRemaining(plan, ctx, out, [], pushable, j);
    }
    for (const l of leftRows) {
      let matched = false;
      for (let ri = 0; ri < rightRows.length; ri++) {
        const m = mergeRows(l, rightRows[ri], rightRels, nrt);
        if (matchesFn(m)) {
          matched = true;
          rightMatched[ri] = true;
          out.push(m);
        }
      }
      if (!matched) {
        out.push(nullExtend(l, rightRels, nrt));
      }
    }
    for (let ri = 0; ri < rightRows.length; ri++) {
      if (!rightMatched[ri]) {
        out.push(mergeRows(nullExtend(ctx.row.slice(), leftRels, nrt), rightRows[ri], rightRels, nrt));
      }
    }
    return this.applyRemaining(plan, ctx, out, [], pushable, j);
  }

  /**
   * Inner join whose left input is a table with no usable restriction of its own, when a join clause
   * equates one of its columns to the right input (`product_external JOIN product ON
   * product_external.product_id = product.id`, product narrowed to one row): the right side is
   * produced first and the left table's column index probed per right row, instead of reading the
   * whole table. Rows come back in the order the left-first join yields (left heap order, then right
   * order). Returns null when the shape does not apply.
   */
  private probeLeftRelation(
    plan: QueryPlan,
    ctx: EvalCtx,
    j: JoinNode,
    leftRels: Set<number>,
    rightRels: Set<number>,
    leftPush: Conjunct[],
    leftQuals: Conjunct[],
    rightPush: Conjunct[],
    rightQuals: Conjunct[],
    quals: Conjunct[]
  ): Row[] | null {
    if (j.larg.k !== 'ref') {
      return null;
    }
    const rtIndex = j.larg.rtIndex;
    const rte = plan.q.rtable[rtIndex];
    if (rte.kind !== 'relation') {
      return null;
    }
    const rel = this.st.catalog.getRelation(rte.relOid);
    if (!rel || rel.kind === 'S' || rel.kind === 'p') {
      return null;
    }
    const parts = this.host.relationHeaps(rel, rte.inh, this.st);
    if (parts.length !== 1 || parts[0].rel !== rel || parts[0].heap.tuples.length < 64) {
      return null;
    }
    const leftFilters = [...leftPush, ...leftQuals];
    if (this.findIndexLookups(plan, rtIndex, rte, leftFilters).length > 0) {
      // the left table is read through an index already
      return null;
    }
    let probe: { conj: Conjunct; physIndex: number; colType: number; value: Evaluator; valueType: number } | null = null;
    for (const c of quals) {
      const e = c.expr;
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2 || c.volatile) {
        continue;
      }
      for (const [colSide, valSide] of [
        [0, 1],
        [1, 0],
      ]) {
        const col = stripRelabel(e.args[colSide]);
        const val = e.args[valSide];
        if (col.k !== 'var' || col.levelsUp !== 0 || col.rtIndex !== rtIndex || col.attno < 0) {
          continue;
        }
        const valRels = exprRelids(val);
        if (valRels.size === 0 || ![...valRels].every((r) => rightRels.has(r)) || containsVolatile(val)) {
          continue;
        }
        const phys = rte.attnums[col.attno] - 1;
        if (phys < 0 || rel.columns[phys]?.hasMissing || !isHashableEquality(e.funcSrc, col.type, val.type, plan, e.inputCollation)) {
          continue;
        }
        probe = { conj: c, physIndex: phys, colType: col.type, value: plan.ev(val), valueType: val.type };
        break;
      }
      if (probe) {
        break;
      }
    }
    if (!probe) {
      return null;
    }
    const heap = parts[0].heap;
    const rightRows = this.produceWithQuals(plan, ctx, j.rarg, rightPush, rightQuals);
    if (rightRows.length * 8 > heap.tuples.length) {
      // a large right side: the ordinary hash join, reusing the rows already produced
      const leftRows = this.produceWithQuals(plan, ctx, j.larg, leftPush, leftQuals);
      return this.innerJoin(plan, ctx, leftRows, rightRows, leftRels, rightRels, quals);
    }
    const nrt = plan.nrt;
    const index = this.heapIndex(heap, probe.physIndex, probe.colType);
    const vis = this.host.store.vis;
    const snap = this.st.snapshot;
    const typeOps = this.host.session.typeOps;
    const checks = [...leftFilters, ...quals.filter((c) => c !== probe!.conj)].map((c) => plan.ev(c.expr));
    const matches: { seq: number; ri: number; row: Row }[] = [];
    for (let ri = 0; ri < rightRows.length; ri++) {
      const r = rightRows[ri];
      const value = probe.value(this.rowCtx(r, ctx));
      const candidates = value === null ? undefined : index.get(hashFamilyKey(probe.valueType, value, typeOps));
      if (!candidates) {
        continue;
      }
      for (const t of candidates) {
        if (!vis.visible(t, snap)) {
          continue;
        }
        const leftRow = ctx.row.slice();
        leftRow[rtIndex] = t.data;
        leftRow[nrt + rtIndex] = t;
        const merged = mergeRows(leftRow, r, rightRels, nrt);
        if (checks.length > 0) {
          const mc = this.rowCtx(merged, ctx);
          let ok = true;
          for (const ev of checks) {
            if (ev(mc) !== true) {
              ok = false;
              break;
            }
          }
          if (!ok) {
            continue;
          }
        }
        matches.push({ seq: t.seq, ri, row: merged });
      }
    }
    matches.sort((a, b) => a.seq - b.seq || a.ri - b.ri);
    return matches.map((m) => m.row);
  }

  /**
   * reduce_outer_joins: a LEFT JOIN whose nullable side a qual from above requires to be non-NULL
   * (`LEFT JOIN cart ... WHERE cart.uuid = $1`) returns exactly its inner join's rows, in the same
   * order — so it runs as one, and those quals can reach the scan (index lookups) instead of
   * filtering the joined result.
   */
  private reducedJoinType(j: JoinNode, pushable: Conjunct[], rightRels: Set<number>): JoinNode['joinType'] {
    if (j.joinType !== 'LEFT' || pushable.length === 0) {
      return j.joinType;
    }
    const catalog = this.st.catalog;
    const isStrict = (oid: number) => catalog.getProc(oid)?.strict ?? false;
    for (const c of pushable) {
      if (c.volatile) {
        continue;
      }
      for (const r of nonNullableRels(c.expr, isStrict)) {
        if (rightRels.has(r)) {
          return 'INNER';
        }
      }
    }
    return j.joinType;
  }

  private applyRemaining(plan: QueryPlan, ctx: EvalCtx, rows: Row[], quals: Conjunct[], pushable: Conjunct[], j: JoinNode): Row[] {
    const rels = joinTreeRelids(j);
    const rest = [...quals.filter((c) => !c.used), ...pushable.filter((c) => !c.used && [...c.relids].every((r) => rels.has(r)))];
    if (rest.length === 0) {
      return rows;
    }
    const evs = rest.map((c) => plan.ev(c.expr));
    for (const c of rest) {
      c.used = true;
    }
    return rows.filter((r) => {
      const c = this.rowCtx(r, ctx);
      return evs.every((ev) => ev(c) === true);
    });
  }

  // -------------------------------------------------------------------------
  // Scans
  // -------------------------------------------------------------------------

  private scanRte(plan: QueryPlan, ctx: EvalCtx, rtIndex: number, pushable: Conjunct[]): Row[] {
    const rte = plan.q.rtable[rtIndex];
    const nrt = plan.nrt;
    const mine = pushable.filter((c) => c.relids.size === 1 && c.relids.has(rtIndex));
    let rows: Row[];
    switch (rte.kind) {
      case 'relation':
        rows = this.scanRelation(plan, ctx, rtIndex, rte, mine);
        break;
      case 'subquery': {
        const narrowed = pushQualsIntoSubquery(
          rte.subquery,
          rtIndex,
          0,
          mine.map((c) => c.expr)
        );
        const sub = this.executeQuery(narrowed ?? rte.subquery, ctx);
        rows = sub.rows.map((r) => {
          const row = ctx.row.slice();
          row[rtIndex] = r;
          return row;
        });
        break;
      }
      case 'function':
        rows = this.scanFunction(plan, ctx, rtIndex, rte);
        break;
      case 'values':
        rows = this.scanValues(plan, ctx, rtIndex, rte);
        break;
      case 'cte':
        rows = this.scanCte(plan, ctx, rtIndex, rte, mine);
        break;
      case 'catalog': {
        const data = rte.transitionRows ?? this.host.catalogRows(rte.relOid, this.st);
        rows = data.map((r) => {
          const row = ctx.row.slice();
          row[rtIndex] = r;
          return row;
        });
        break;
      }
      case 'join':
        throw new PgError(SqlState.INTERNAL_ERROR, 'unexpected join RTE scan');
    }
    if (mine.length > 0 && rte.kind !== 'relation') {
      const evs = mine.map((c) => plan.ev(c.expr));
      rows = rows.filter((r) => {
        const c = this.rowCtx(r, ctx);
        return evs.every((ev) => ev(c) === true);
      });
    }
    for (const c of mine) {
      c.used = true;
    }
    void nrt;
    return rows;
  }

  /** `limit`: stop after that many matching rows (a LIMIT the scan's rows go straight to) */
  private scanRelation(plan: QueryPlan, ctx: EvalCtx, rtIndex: number, rte: RelationRTE, filters: Conjunct[], limit = Infinity): Row[] {
    const rel = this.st.catalog.getRelation(rte.relOid)!;
    const nrt = plan.nrt;
    if (rel.kind === 'S' && rel.sequence) {
      // a sequence reads as its single state row (non-transactional)
      const state = rel.sequence.state;
      const row = ctx.row.slice();
      row[rtIndex] = [state.lastValue, BigInt(state.logCnt ?? 0), state.isCalled];
      row[nrt + rtIndex] = { xmin: 2, cmin: 0, xmax: 0, cmax: 0, data: row[rtIndex], next: null, seq: 0 } as Tuple;
      const c = this.rowCtx(row, ctx);
      return filters.every((f) => plan.ev(f.expr)(c) === true) ? [row] : [];
    }
    const vis = this.host.store.vis;
    const snap = this.st.snapshot;
    const parts = this.host.relationHeaps(rel, rte.inh, this.st);
    const filterEvs = filters.map((c) => plan.ev(c.expr));
    const out: Row[] = [];
    // equality lookup via hash index: col = <expr without local rels>
    const lookups = parts.length === 1 && parts[0].rel === rel ? this.findIndexLookups(plan, rtIndex, rte, filters) : [];
    // filters are evaluated on one scratch row / context (evaluation does not keep them): a row is
    // allocated only for the tuples that pass
    const scratchRow = ctx.row.slice();
    const scratch = this.rowCtx(scratchRow, ctx);
    // `tableOid`: the child relation a row read through an inheritance parent comes from (system
    // column tableoid), kept at `2 * nrt + rtIndex`
    const emit = (t: Tuple, data: unknown[], tableOid?: number) => {
      if (filterEvs.length > 0) {
        scratchRow[rtIndex] = data;
        scratchRow[nrt + rtIndex] = t;
        if (tableOid !== undefined) {
          scratchRow[2 * nrt + rtIndex] = tableOid;
        }
        for (const ev of filterEvs) {
          if (ev(scratch) !== true) {
            return;
          }
        }
      }
      const row = ctx.row.slice();
      row[rtIndex] = data;
      row[nrt + rtIndex] = t;
      if (tableOid !== undefined) {
        row[2 * nrt + rtIndex] = tableOid;
      }
      out.push(row);
    };
    const heap = parts.length === 1 ? parts[0].heap : null;
    const indexes = heap ? lookups.map((lookup) => this.lookupIndex(heap, lookup)) : [];
    if (indexes.some((index) => index !== null)) {
      // several equalities: probe with the one matching the fewest tuple versions
      const typeOps = this.host.session.typeOps;
      let candidates: Tuple[] | undefined;
      let buckets: Tuple[][] | undefined;
      let size = Infinity;
      for (let li = 0; li < lookups.length; li++) {
        const lookup = lookups[li];
        const index = indexes[li];
        if (!index) {
          continue;
        }
        const value = lookup.value(ctx);
        if (value === null) {
          return out;
        }
        if (!lookup.any) {
          const bucket = index.get(hashFamilyKey(lookup.valueType, value, typeOps));
          if (!bucket) {
            return out;
          }
          if (bucket.length < size) {
            candidates = bucket;
            buckets = undefined;
            size = bucket.length;
          }
          continue;
        }
        // col = ANY(array): the union of the buckets of the distinct element keys
        let elems = value as unknown[];
        if (elems.length > 0 && Array.isArray(elems[0])) {
          elems = (elems as unknown[][]).flat(Infinity as 1);
        }
        const keys = new Set<unknown>();
        const found: Tuple[][] = [];
        let total = 0;
        for (const el of elems) {
          if (el === null) {
            continue;
          }
          const key = hashFamilyKey(lookup.valueType, el, typeOps);
          if (keys.has(key)) {
            continue;
          }
          keys.add(key);
          const bucket = index.get(key);
          if (bucket) {
            found.push(bucket);
            total += bucket.length;
          }
        }
        if (total === 0) {
          return out;
        }
        if (total < size) {
          candidates = undefined;
          buckets = found;
          size = total;
        }
      }
      if (buckets) {
        // heap order, as a sequential scan returns them
        candidates = buckets.length === 1 ? buckets[0] : buckets.flat().sort((a, b) => a.seq - b.seq);
      }
      for (const t of candidates!) {
        if (vis.visible(t, snap)) {
          emit(t, t.data);
          if (out.length >= limit) {
            break;
          }
        }
      }
      return out;
    }
    for (const part of parts) {
      if (out.length >= limit) {
        break;
      }
      const tuples = part.heap.tuples;
      if (part.rel === rel) {
        for (let i = 0; i < tuples.length; i++) {
          const t = tuples[i];
          if (vis.visible(t, snap)) {
            emit(t, t.data);
            if (out.length >= limit) {
              break;
            }
          }
        }
      } else {
        // child partition / inheritance child: map columns by name to the parent's physical layout
        const map = rel.columns.map((c) => (c.isDropped ? -1 : part.rel.columns.findIndex((pc) => !pc.isDropped && pc.name === c.name)));
        for (const t of tuples) {
          if (vis.visible(t, snap)) {
            const data = map.map((m, i) => {
              if (m < 0) {
                return null;
              }
              const v = m < t.data.length ? t.data[m] : part.rel.columns[m].hasMissing ? part.rel.columns[m].missingValue : null;
              void i;
              return v;
            });
            emit(t, data, part.rel.oid);
            if (out.length >= limit) {
              break;
            }
          }
        }
      }
    }
    return out;
  }

  private findIndexLookups(plan: QueryPlan, rtIndex: number, rte: RelationRTE, filters: Conjunct[]): IndexLookup[] {
    // Candidates are conjuncts that reference this relation plus only outer levels / params (relids == {rtIndex}).
    const out: IndexLookup[] = [];
    for (const c of filters) {
      const e = c.expr;
      if (e.k === 'saop' && e.useOr && e.opName === '=') {
        // col = ANY(<array without local rels>)
        const col = stripRelabel(e.args[0]);
        const val = e.args[1];
        if (col.k !== 'var' || col.levelsUp !== 0 || col.rtIndex !== rtIndex || col.attno < 0) {
          continue;
        }
        if (exprRelids(val).size > 0 || this.volatileForLookup(val)) {
          continue;
        }
        if (this.st.catalog.getRelation(rte.relOid)?.columns[rte.attnums[col.attno] - 1]?.hasMissing) {
          continue;
        }
        const elemType = this.st.catalog.getType(val.type)?.elem;
        if (!elemType || !isHashableEquality(e.opSrc, col.type, elemType, plan, e.inputCollation)) {
          continue;
        }
        out.push({ physIndex: rte.attnums[col.attno] - 1, colType: col.type, value: plan.ev(val), valueType: elemType, any: true });
        continue;
      }
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2) {
        continue;
      }
      let found = false;
      for (const [colSide, valSide] of [
        [0, 1],
        [1, 0],
      ]) {
        const col = stripRelabel(e.args[colSide]);
        const val = e.args[valSide];
        if (col.k !== 'var' || col.levelsUp !== 0 || col.rtIndex !== rtIndex || col.attno < 0) {
          continue;
        }
        if (exprRelids(val).size > 0 || this.volatileForLookup(val)) {
          continue;
        }
        // rows stored before an ADD COLUMN ... DEFAULT carry the value implicitly: not in the heap index
        if (this.st.catalog.getRelation(rte.relOid)?.columns[rte.attnums[col.attno] - 1]?.hasMissing) {
          continue;
        }
        if (!isHashableEquality(e.funcSrc, col.type, val.type, plan, e.inputCollation)) {
          continue;
        }
        out.push({ physIndex: rte.attnums[col.attno] - 1, colType: col.type, value: plan.ev(val), valueType: val.type });
        found = true;
        break;
      }
      if (!found) {
        const lookup = this.expressionIndexLookup(plan, rtIndex, rte, e);
        if (lookup) {
          out.push(lookup);
        }
      }
    }
    return out;
  }

  /**
   * `<index expression> = <value>` where the relation has a (non-partial) index on exactly that
   * expression, like `public.search_normalize(product.internal_id) = public.search_normalize($1)`: the
   * scan probes a heap index keyed by the expression. PostgreSQL computed that expression for every row
   * when it was indexed, so evaluating it for all tuple versions cannot raise what a scan would not.
   */
  private expressionIndexLookup(plan: QueryPlan, rtIndex: number, rte: RelationRTE, e: TExpr & { k: 'op' }): IndexLookup | null {
    const catalog = this.st.catalog;
    const host = this.host;
    if (!host.analyzeRelationExpr) {
      return null;
    }
    const rel = catalog.getRelation(rte.relOid);
    if (!rel) {
      return null;
    }
    let memo = exprIndexMatches.get(e);
    if (!memo || memo.catalog !== catalog || memo.version !== catalog.version) {
      memo = { catalog, version: catalog.version, match: null };
      exprIndexMatches.set(e, memo);
      const indexes = catalog.indexesOf(rel.oid).filter((ix) => {
        const info = ix.index;
        return info && info.valid && !info.exclusion && !info.predicate && (info.method === 'btree' || info.method === 'hash') && info.keys.some((k) => k.attnum <= 0 && k.expr);
      });
      if (indexes.length > 0) {
        search: for (const sideIndex of [0, 1]) {
          // (an index expression is immutable by definition: a structural match needs no volatility check)
          const side = stripRelabel(e.args[sideIndex]);
          if (side.k === 'var' || side.k === 'const') {
            continue;
          }
          const sideRels = exprRelids(side);
          if (sideRels.size !== 1 || !sideRels.has(rtIndex)) {
            continue;
          }
          for (const ix of indexes) {
            for (const key of ix.index!.keys) {
              if (key.attnum > 0 || !key.expr) {
                continue;
              }
              const analyzed = host.analyzeRelationExpr(rel, key.expr, 'index');
              if (sameIndexExpr(side, stripRelabel(analyzed.expr), rtIndex, rte, analyzed.q)) {
                memo.match = { side: sideIndex, ix, key };
                break search;
              }
            }
          }
        }
      }
    }
    const match = memo.match;
    if (!match) {
      return null;
    }
    const side = stripRelabel(e.args[match.side]);
    const val = e.args[1 - match.side];
    if (exprRelids(val).size > 0 || this.volatileForLookup(val) || !isHashableEquality(e.funcSrc, side.type, val.type, plan, e.inputCollation)) {
      return null;
    }
    const spec = 'expr:' + match.ix.oid + ':' + side.type;
    const heaps = host.relationHeaps(rel, rte.inh, this.st);
    if (heaps.length === 1 && poisonedExprIndexes.get(heaps[0].heap)?.has(spec)) {
      return null;
    }
    const analyzed = host.analyzeRelationExpr(rel, match.key.expr!, 'index');
    const ev = this.planFor(analyzed.q, null).ev(analyzed.expr);
    return { physIndex: -1, colType: side.type, value: plan.ev(val), valueType: val.type, expr: { spec, ev } };
  }

  /**
   * containsVolatile, except that user functions declared IMMUTABLE or STABLE are not: their value
   * does not change within a statement, so an index probe may compute it once.
   */
  private volatileForLookup(e: TExpr): boolean {
    if (!containsVolatile(e)) {
      return false;
    }
    const catalog = this.st.catalog;
    const memo = lookupVolatility.get(e);
    if (memo && memo.catalog === catalog && memo.version === catalog.version) {
      return memo.volatile;
    }
    let volatile = false;
    const visit = (x: TExpr) => {
      if (volatile) {
        return;
      }
      if (x.k === 'func') {
        if (x.isUser) {
          const proc = catalog.getProc(x.funcOid);
          if (!proc || proc.volatile === 'v') {
            volatile = true;
            return;
          }
        } else if (containsVolatile({ ...x, args: [] })) {
          volatile = true;
          return;
        }
      }
      forEachChild(x, visit);
    };
    visit(e);
    lookupVolatility.set(e, { catalog, version: catalog.version, volatile });
    return volatile;
  }

  /** The heap index a lookup probes (null when an expression index turned out unusable). */
  private lookupIndex(heap: Heap, lookup: IndexLookup): Map<unknown, Tuple[]> | null {
    if (!lookup.expr) {
      return this.heapIndex(heap, lookup.physIndex, lookup.colType);
    }
    const { spec, ev } = lookup.expr;
    const colType = lookup.colType;
    const typeOps = this.host.session.typeOps;
    const buildSt = this.st;
    let poisoned = false;
    const index = heap.getIndex(
      spec,
      (t, stArg) => {
        try {
          const v = ev(new EvalCtx([t.data, t], null, (stArg as StatementState | undefined) ?? buildSt));
          return v === null || v === undefined ? undefined : hashFamilyKey(colType, v, typeOps);
        } catch {
          poisoned = true;
          let set = poisonedExprIndexes.get(heap);
          if (!set) {
            set = new Set();
            poisonedExprIndexes.set(heap, set);
          }
          set.add(spec);
          return POISONED_EXPR_INDEX;
        }
      },
      true
    );
    if (poisoned || poisonedExprIndexes.get(heap)?.has(spec)) {
      heap.indexCache.delete(spec);
      return null;
    }
    return index;
  }

  /** Hash index over a heap column (all tuple versions, heap order), rebuilt when the heap changes. */
  heapIndex(heap: Heap, physIndex: number, colType: number): Map<unknown, Tuple[]> {
    const typeOps = this.host.session.typeOps;
    return heap.getIndex('col:' + physIndex + ':' + colType, (t) => {
      const v = physIndex < t.data.length ? t.data[physIndex] : null;
      if (v === null || v === undefined) {
        return undefined;
      }
      return hashFamilyKey(colType, v, typeOps);
    });
  }

  private scanFunction(plan: QueryPlan, ctx: EvalCtx, rtIndex: number, rte: FunctionRTE): Row[] {
    const perFunction: unknown[][][] = [];
    let maxRows = 0;
    for (const f of rte.functions) {
      const e = f.expr;
      let values: unknown[];
      if (e.k === 'func' && !e.isUser && JSON_TO_RECORD_FUNCS.has(e.funcSrc)) {
        const argVals = e.args.map((a) => plan.ev(a)(ctx));
        const fc = { st: this.st, argTypes: e.args.map((a) => a.type), resultType: e.type, resultTypmod: e.typmod, collation: e.inputCollation, node: e };
        values = argVals[0] === null ? (e.retset ? [] : [null]) : jsonToRecordRows(e.funcSrc, argVals[0], f.colTypes, f.colNames, fc);
      } else if (e.k === 'func' && e.retset) {
        const argVals = e.args.map((a) => plan.ev(a)(ctx));
        if (e.strict && argVals.some((v) => v === null)) {
          values = [];
        } else {
          values = this.srfImpl(e)(argVals, { st: this.st, argTypes: e.args.map((a) => a.type), resultType: e.type, resultTypmod: e.typmod, collation: e.inputCollation, node: e });
        }
      } else {
        const v = plan.ev(e)(ctx);
        values = [v];
      }
      const rows = values.map((v) => {
        if (f.expandComposite) {
          if (v instanceof PgRecord) {
            return v.values;
          }
          if (Array.isArray(v)) {
            return v;
          }
          if (v === null) {
            return new Array(f.colCount).fill(null);
          }
        }
        return [v];
      });
      perFunction.push(rows);
      maxRows = Math.max(maxRows, rows.length);
    }
    const out: Row[] = [];
    for (let i = 0; i < maxRows; i++) {
      const data: unknown[] = [];
      rte.functions.forEach((f, fi) => {
        const r = perFunction[fi][i];
        for (let k = 0; k < f.colCount; k++) {
          data.push(r ? r[k] ?? null : null);
        }
      });
      if (rte.ordinality) {
        data.push(BigInt(i + 1));
      }
      const row = ctx.row.slice();
      row[rtIndex] = data;
      out.push(row);
    }
    return out;
  }

  private scanValues(plan: QueryPlan, ctx: EvalCtx, rtIndex: number, rte: ValuesRTE): Row[] {
    return rte.lists.map((list) => {
      const row = ctx.row.slice();
      row[rtIndex] = list.map((e) => plan.ev(e)(ctx));
      return row;
    });
  }

  private scanCte(plan: QueryPlan, ctx: EvalCtx, rtIndex: number, rte: CteRTE, quals: Conjunct[] = []): Row[] {
    let data: unknown[][];
    if (rte.selfReference) {
      data = (this.st.scratch.get('cte-working:' + rte.cte.id) as unknown[][]) ?? [];
    } else {
      // find the context of the query level owning the CTE
      let owner: EvalCtx | null = ctx;
      for (let i = 0; i < rte.levelsUp && owner; i++) {
        owner = owner.parent;
      }
      if (!owner) {
        throw new PgError(SqlState.INTERNAL_ERROR, `could not find CTE "${rte.ctename}"`);
      }
      const cte = rte.cte;
      // a side-effect-free CTE PostgreSQL would inline (referenced once, not MATERIALIZED) runs as a
      // subquery when restrictions on it can be pushed down
      const inlinable = !cte.recursive && !cte.isModifying && cte.materialized !== 'ALWAYS' && (cte.refCount === 1 || cte.materialized === 'NEVER') && !queryHasVolatile(cte.query);
      const narrowed = inlinable
        ? pushQualsIntoSubquery(
            cte.query,
            rtIndex,
            rte.levelsUp,
            quals.map((c) => c.expr)
          )
        : null;
      if (narrowed) {
        const levelCtx = new EvalCtx(owner.row, owner.parent, this.st);
        levelCtx.inst = owner.inst;
        data = this.executeQuery(narrowed, levelCtx).rows;
      } else {
        data = this.materializeCte(cte, owner);
      }
    }
    return data.map((r) => {
      const row = ctx.row.slice();
      row[rtIndex] = r;
      return row;
    });
  }

  materializeCte(cte: CteEntry, owner: EvalCtx): unknown[][] {
    const inst = owner.inst as QueryInstance;
    const cached = inst.cteResults.get(cte.id);
    if (cached) {
      return cached;
    }
    const levelCtx = new EvalCtx(owner.row, owner.parent, this.st);
    levelCtx.inst = owner.inst;
    let rows: unknown[][];
    if (cte.recursiveParts) {
      rows = this.evaluateRecursiveCte(cte, levelCtx);
    } else {
      rows = this.executeQuery(cte.query, levelCtx).rows;
    }
    inst.cteResults.set(cte.id, rows);
    return rows;
  }

  private evaluateRecursiveCte(cte: CteEntry, ctx: EvalCtx): unknown[][] {
    const parts = cte.recursiveParts!;
    const typeOps = this.host.session.typeOps;
    const types = cte.colTypes.map((c) => c.type);
    const result: unknown[][] = [];
    const seen = new Set<unknown>();
    const addRows = (rows: unknown[][]): unknown[][] => {
      if (parts.unionAll) {
        result.push(...rows);
        return rows;
      }
      const fresh: unknown[][] = [];
      for (const r of rows) {
        const k = typeOps.multiKey(types, r);
        if (!seen.has(k)) {
          seen.add(k);
          fresh.push(r);
          result.push(r);
        }
      }
      return fresh;
    };
    // SEARCH / CYCLE columns (rewriteSearchAndCycle), computed from the row and the working-table row it came from
    const baseCount = cte.colTypes.length - (cte.search ? 1 : 0) - (cte.cycle ? 2 : 0);
    const constValue = (e: TExpr): unknown => (e.k === 'const' ? (e.isNull ? null : e.value) : null);
    const rowOf = (r: unknown[], cols: number[], prefix: unknown[] = []): PgRecord =>
      new PgRecord([...prefix, ...cols.map((i) => r[i])], TypeOid.record, [...prefix.map(() => TypeOid.int8), ...cols.map((i) => types[i])], []);
    const cycleCmps = cte.cycle ? cte.cycle.columns.map((i) => typeOps.comparator(types[i], cte.colTypes[i].collation)) : [];
    const augment = (rows: unknown[][], fromWorking: boolean): unknown[][] => {
      if (!cte.search && !cte.cycle) {
        return rows;
      }
      const out: unknown[][] = [];
      for (const r of rows) {
        const parent = fromWorking ? r.slice(baseCount) : null;
        let p = 0;
        const extra: unknown[] = [];
        if (cte.search) {
          const cols = cte.search.columns;
          const prev = parent ? parent[p++] : null;
          if (cte.search.breadthFirst) {
            const depth = prev instanceof PgRecord ? (prev.values[0] as bigint) + 1n : 0n;
            extra.push(rowOf(r, cols, [depth]));
          } else {
            extra.push([...((prev as unknown[] | null) ?? []), rowOf(r, cols)]);
          }
        }
        if (cte.cycle) {
          const cyc = cte.cycle;
          const markValue = constValue(cyc.markValue);
          const prevMark = parent ? parent[p++] : null;
          const prevPath = parent ? ((parent[p++] as PgRecord[] | null) ?? []) : [];
          if (parent && prevMark !== null && typeOps.comparator(cyc.markValue.type, 0)(prevMark, markValue) === 0) {
            continue;
          }
          const isCycle = prevPath.some((rec) => cyc.columns.every((ci, j) => rec.values[j] !== null && r[ci] !== null && cycleCmps[j](rec.values[j], r[ci]) === 0));
          extra.push(isCycle ? markValue : constValue(cyc.markDefault), [...prevPath, rowOf(r, cyc.columns)]);
        }
        out.push([...r.slice(0, baseCount), ...extra]);
      }
      return out;
    };
    let working = addRows(augment(this.executeQuery(parts.nonRecursive, ctx).rows, false));
    let guard = 0;
    const key = 'cte-working:' + cte.id;
    while (working.length > 0) {
      if (++guard > 100000) {
        throw new PgError(SqlState.PROGRAM_LIMIT_EXCEEDED, 'recursive query did not terminate');
      }
      const saved = this.st.scratch.get(key);
      this.st.scratch.set(key, working);
      let next: unknown[][];
      try {
        next = this.executeQuery(parts.recursive, ctx).rows;
      } finally {
        this.st.scratch.set(key, saved);
      }
      working = addRows(augment(next, true));
    }
    return result;
  }
}

function collectSubqueryOuterRelids(q: Query): Set<number> {
  // relids of level-1 references inside q (q is a lateral subquery)
  const out = new Set<number>();
  // reuse exprRelids by wrapping q in a fake sublink
  const fake: TExpr = {
    k: 'sublink',
    linkType: 'EXISTS',
    testLeft: [],
    operators: [],
    subquery: q,
    correlated: true,
    id: -1,
    type: TypeOid.bool,
    typmod: -1,
    collation: 0,
  };
  exprRelids(fake).forEach((r) => out.add(r));
  return out;
}

export function mergeRows(left: Row, right: Row, rightRels: Set<number>, nrt: number): Row {
  const out = left.slice();
  for (const r of rightRels) {
    out[r] = right[r];
    out[nrt + r] = right[nrt + r];
    if (right.length > 2 * nrt) {
      // tableoid of a row read through an inheritance parent
      out[2 * nrt + r] = right[2 * nrt + r];
    }
  }
  return out;
}

export function nullExtend(row: Row, rels: Set<number>, nrt: number): Row {
  const out = row.slice();
  for (const r of rels) {
    out[r] = null;
    out[nrt + r] = undefined;
    if (out.length > 2 * nrt) {
      out[2 * nrt + r] = undefined;
    }
  }
  return out;
}

function stripRelabel(e: TExpr): TExpr {
  let x = e;
  while (x.k === 'relabel') {
    x = x.arg;
  }
  return x;
}

const INT_TYPES = new Set<number>([TypeOid.int2, TypeOid.int4, TypeOid.int8, TypeOid.oid]);
const TEXT_TYPES = new Set<number>([TypeOid.text, TypeOid.varchar, TypeOid.name]);

const SAME_EXPR_SKIP_KEYS = new Set(['location', 'id', 'aggIndex', 'winIndex', 'testSlot', 'elemSlot', 'correlated']);

/**
 * Structural equality of a query expression over relation `rt` (range table entry `rte`) and an
 * analyzed index expression (over the single relation of `indexQuery`): Vars match by table column.
 */
function sameIndexExpr(a: unknown, b: unknown, rt: number, rte: RelationRTE, indexQuery: Query): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameIndexExpr(x, b[i], rt, rte, indexQuery));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // binary-compatible relabelings (`internal_id::text` of a varchar column) do not change a value
  if (ao.k === 'relabel' || bo.k === 'relabel') {
    return sameIndexExpr(ao.k === 'relabel' ? ao.arg : a, bo.k === 'relabel' ? bo.arg : b, rt, rte, indexQuery);
  }
  if (ao.k === 'var' || bo.k === 'var') {
    if (ao.k !== 'var' || bo.k !== 'var' || ao.levelsUp !== 0 || ao.rtIndex !== rt || bo.levelsUp !== 0 || ao.type !== bo.type) {
      return false;
    }
    const indexRte = indexQuery.rtable[bo.rtIndex as number];
    const aAttno = ao.attno as number;
    const bAttno = bo.attno as number;
    return indexRte?.kind === 'relation' && aAttno >= 0 && bAttno >= 0 && rte.attnums[aAttno] === indexRte.attnums[bAttno];
  }
  if (ao.constructor !== bo.constructor) {
    return false;
  }
  if (a instanceof PgNumeric) {
    return String(a) === String(b);
  }
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!SAME_EXPR_SKIP_KEYS.has(k) && !sameIndexExpr(ao[k], bo[k], rt, rte, indexQuery)) {
      return false;
    }
  }
  return true;
}

function isHashableEquality(funcSrc: string, l: number, r: number, plan: QueryPlan, collation: number): boolean {
  const typeOps = plan.executor.host.session.typeOps;
  if (collation && !typeOps.collations.isDeterministic(collation)) {
    return false;
  }
  if (INT_TYPES.has(l) && INT_TYPES.has(r)) {
    return true;
  }
  if (TEXT_TYPES.has(l) && TEXT_TYPES.has(r)) {
    return true;
  }
  if (l !== r) {
    return false;
  }
  switch (l) {
    case TypeOid.bool:
    case TypeOid.uuid:
    case TypeOid.date:
    case TypeOid.timestamp:
    case TypeOid.timestamptz:
    case TypeOid.numeric:
    case TypeOid.bpchar:
    case TypeOid.float8:
    case TypeOid.float4:
    case TypeOid.jsonb:
    case TypeOid.bytea:
    case TypeOid.interval:
      return true;
  }
  const t = plan.executor.st.catalog.getType(l);
  void funcSrc;
  return !!t && (t.typtype === 'e');
}

/** Hash key that is consistent across the types of one hash family (all ints share keys). */
export function hashFamilyKey(type: number, v: unknown, typeOps: import('./typeops').TypeOps): unknown {
  if (INT_TYPES.has(type)) {
    if (typeof v === 'bigint') {
      return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
    }
    return v;
  }
  return typeOps.hashKey(type, v);
}

function replaceNode(e: TExpr, target: TExpr, replacement: TExpr): TExpr {
  if (e === target) {
    return replacement;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../analyze/walk').mapChildren(e, (c: TExpr) => replaceNode(c, target, replacement));
}

export type { RTE };
