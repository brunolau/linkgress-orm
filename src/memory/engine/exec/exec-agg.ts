import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { AggNode, GroupKeyNode, Query, SortGroupClause, TExpr, WindowFuncNode } from '../analyze/nodes';
import { exprEqual } from '../analyze/walk';
import { lookupAggregate } from './functions/aggregates';
import { pgQsort } from './pgsort';
import { EvalCtx, Evaluator, FnCall } from './runtime';
import type { Executor, QueryPlan, Row } from './executor';

// ---------------------------------------------------------------------------
// Group key rewriting
// ---------------------------------------------------------------------------

const rewritten = new WeakSet<Query>();

function rewriteGroupRefs(q: Query): void {
  if (rewritten.has(q)) {
    return;
  }
  rewritten.add(q);
  const groupExprs = q.groupClause.map((g) => q.targetList.find((t) => t.sortGroupRef === g.tleSortGroupRef)!.expr);
  if (groupExprs.length === 0) {
    return;
  }
  const rewrite = (e: TExpr): TExpr => {
    for (let i = 0; i < groupExprs.length; i++) {
      if (exprEqual(groupExprs[i], e)) {
        const g: GroupKeyNode = { k: 'groupkey', index: i, type: e.type, typmod: e.typmod, collation: e.collation };
        return g;
      }
    }
    if (e.k === 'agg') {
      return e;
    }
    if (e.k === 'window') {
      const w = e as WindowFuncNode;
      w.args = w.args.map(rewrite);
      if (w.filter) {
        w.filter = rewrite(w.filter);
      }
      return w;
    }
    if (e.k === 'sublink') {
      e.testLeft = e.testLeft.map(rewrite);
      return e;
    }
    if (e.k === 'grouping') {
      const args = (e as unknown as { __args?: TExpr[] }).__args ?? [];
      e.refs = args.map((a) => {
        const idx = groupExprs.findIndex((g) => exprEqual(g, a));
        if (idx < 0) {
          throw new PgError(SqlState.GROUPING_ERROR, 'arguments to GROUPING must be grouping expressions of the associated query level');
        }
        return idx;
      });
      return e;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../analyze/walk').mapChildren(e, rewrite);
  };
  // group key TLEs themselves must keep their original expression for key computation; we store keys separately
  for (const te of q.targetList) {
    te.expr = rewrite(te.expr);
  }
  if (q.havingQual) {
    q.havingQual = rewrite(q.havingQual);
  }
  (q as unknown as { __groupExprs: TExpr[] }).__groupExprs = groupExprs;
}

function groupExprsOf(q: Query): TExpr[] {
  return (q as unknown as { __groupExprs?: TExpr[] }).__groupExprs ?? [];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Group {
  keyValues: unknown[];
  /** indexes of the input rows */
  rows: number[];
  mask: number;
}

export function groupAndAggregate(executor: Executor, plan: QueryPlan, rows: Row[], base: EvalCtx): EvalCtx[] {
  const q = plan.q;
  rewriteGroupRefs(q);
  const groupExprs = groupExprsOf(q);
  const keyEvs = groupExprs.map((e) => plan.ev(e));
  const keyTypes = groupExprs.map((e) => e.type);
  const typeOps = executor.host.session.typeOps;

  const groups: Group[] = [];
  const sets = q.groupingSets ?? [groupExprs.map((_, i) => i)];
  const inputCtxs = rows.map((r) => executor.rowCtx(r, base));
  const keyValuesPerRow = keyEvs.length > 0 ? inputCtxs.map((c) => keyEvs.map((ev) => ev(c))) : [];

  for (const set of sets) {
    const mask = groupExprs.reduce((m, _e, i) => (set.includes(i) ? m : m | (1 << i)), 0);
    if (set.length === 0) {
      groups.push({ keyValues: groupExprs.map(() => null), rows: rows.map((_r, i) => i), mask });
      continue;
    }
    const map = new Map<unknown, Group>();
    const setGroups: Group[] = [];
    const setTypes = set.map((s) => keyTypes[s]);
    const single = set.length === 1 ? set[0] : -1;
    const setValues: unknown[] = new Array(set.length);
    void setValues;
    for (let i = 0; i < rows.length; i++) {
      const kv = keyValuesPerRow[i];
      // a tree of maps, one level per key column (hash keys are primitives): no composite key strings
      let level: Map<unknown, unknown> = map;
      const last = single >= 0 ? 0 : set.length - 1;
      for (let s = 0; s < last; s++) {
        const k = typeOps.hashKey(setTypes[s], kv[set[s]]);
        let next = level.get(k) as Map<unknown, unknown> | undefined;
        if (!next) {
          next = new Map();
          level.set(k, next);
        }
        level = next;
      }
      const leafKey = typeOps.hashKey(setTypes[last], kv[set[last]]);
      let g = level.get(leafKey) as Group | undefined;
      if (!g) {
        g = { keyValues: groupExprs.map((_, gi) => (set.includes(gi) ? kv[gi] : null)), rows: [], mask };
        level.set(leafKey, g);
        setGroups.push(g);
      }
      g.rows.push(i);
    }
    groups.push(...setGroups);
  }
  if (groups.length === 0 && q.groupClause.length === 0) {
    groups.push({ keyValues: [], rows: [], mask: 0 });
  }

  const aggs = q.aggs;
  const aggImpls = aggs.map((a) => {
    const impl = lookupAggregate(a, typeOps);
    if (!impl) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: aggregate ${a.aggName} is not implemented`);
    }
    return impl;
  });
  const aggArgEvs = aggs.map((a) => a.args.map((x) => plan.ev(x)));
  const aggDirectEvs = aggs.map((a) => a.directArgs.map((x) => plan.ev(x)));
  const aggFilterEvs = aggs.map((a) => (a.filter ? plan.ev(a.filter) : null));
  const aggOrderEvs = aggs.map((a) => a.order.map((o) => plan.ev(o.expr)));

  const having = q.havingQual ? plan.ev(q.havingQual) : null;
  const out: EvalCtx[] = [];
  for (const g of groups) {
    const rep = g.rows.length > 0 ? rows[g.rows[0]] : base.row.slice();
    const ctx = executor.rowCtx(rep, base);
    ctx.groupKeys = g.keyValues;
    ctx.groupingMask = g.mask;
    const rowCtxs = g.rows.map((i) => inputCtxs[i]);
    ctx.aggValues = aggs.map((agg, ai) => computeAggregate(executor, agg, aggImpls[ai], aggArgEvs[ai], aggDirectEvs[ai], aggFilterEvs[ai], aggOrderEvs[ai], rowCtxs, ctx));
    if (having && having(ctx) !== true) {
      continue;
    }
    out.push(ctx);
  }
  return out;
}

function computeAggregate(
  executor: Executor,
  agg: AggNode,
  impl: ReturnType<typeof lookupAggregate> & object,
  argEvs: Evaluator[],
  directEvs: Evaluator[],
  filterEv: Evaluator | null,
  orderEvs: Evaluator[],
  rowCtxs: EvalCtx[],
  groupCtx: EvalCtx
): unknown {
  const typeOps = executor.host.session.typeOps;
  const fc: FnCall & { directArgs?: unknown[] } = {
    st: executor.st,
    argTypes: agg.args.map((a) => a.type),
    resultType: agg.type,
    resultTypmod: agg.typmod,
    collation: agg.inputCollation,
    node: agg,
  };
  if (directEvs.length > 0) {
    fc.directArgs = directEvs.map((ev) => ev(groupCtx));
  }
  const strict = impl.strict !== false;
  if (agg.order.length === 0 && !agg.distinct) {
    // plain aggregate: feed the transition function row by row
    let state = impl.init(fc);
    for (const c of rowCtxs) {
      if (filterEv && filterEv(c) !== true) {
        continue;
      }
      const args = argEvs.length === 1 ? [argEvs[0](c)] : argEvs.map((ev) => ev(c));
      if (strict && !agg.star && args.some((a) => a === null)) {
        continue;
      }
      state = impl.step(state, args, fc);
    }
    return impl.final(state, fc);
  }
  let inputs: { args: unknown[]; order: unknown[] }[] = [];
  for (const c of rowCtxs) {
    if (filterEv && filterEv(c) !== true) {
      continue;
    }
    const args = argEvs.map((ev) => ev(c));
    if (strict && !agg.star && args.some((a) => a === null)) {
      continue;
    }
    inputs.push({ args, order: orderEvs.map((ev) => ev(c)) });
  }
  if (agg.order.length > 0 || agg.distinct) {
    const keys = agg.order.length > 0 ? agg.order.map((o, i) => ({ i, useOrder: true, desc: o.desc, nullsFirst: o.nullsFirst, cmp: typeOps.comparator(o.expr.type, o.expr.collation) })) : agg.args.map((a, i) => ({ i, useOrder: false, desc: false, nullsFirst: false, cmp: typeOps.comparator(a.type, a.collation || agg.inputCollation) }));
    const cmp = (x: { args: unknown[]; order: unknown[] }, y: { args: unknown[]; order: unknown[] }): number => {
      for (const k of keys) {
        const a = k.useOrder ? x.order[k.i] : x.args[k.i];
        const b = k.useOrder ? y.order[k.i] : y.args[k.i];
        if (a === null || b === null) {
          if (a === null && b === null) {
            continue;
          }
          const r = a === null ? 1 : -1;
          return k.nullsFirst ? -r : r;
        }
        const r = k.cmp(a, b);
        if (r !== 0) {
          return k.desc ? -r : r;
        }
      }
      return 0;
    };
    pgQsort(inputs, cmp);
    if (agg.distinct) {
      const types = agg.args.map((a) => a.type);
      const seen = new Set<unknown>();
      inputs = inputs.filter((inp) => {
        const k = typeOps.multiKey(types, inp.args);
        if (seen.has(k)) {
          return false;
        }
        seen.add(k);
        return true;
      });
    }
  }
  let state = impl.init(fc);
  for (const inp of inputs) {
    state = impl.step(state, inp.args, fc);
  }
  return impl.final(state, fc);
}

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

export function computeWindowFunctions(executor: Executor, plan: QueryPlan, rows: EvalCtx[]): { rows: EvalCtx[]; finalOrder: SortGroupClause[] | null } {
  const q = plan.q;
  const typeOps = executor.host.session.typeOps;
  for (const c of rows) {
    c.winValues = new Array(q.windowFuncs.length).fill(null);
  }
  let current = rows;
  let finalOrder: SortGroupClause[] | null = null;
  // evaluate window clauses in order of definition
  for (let w = 0; w < q.windowClause.length; w++) {
    const wc = q.windowClause[w];
    const funcs = q.windowFuncs.filter((f) => f.winRef === w);
    if (funcs.length === 0) {
      continue;
    }
    const partKeys = wc.partitionClause.map((sc) => tleOf(q, sc));
    const orderKeys = wc.orderClause.map((sc) => ({ sc, te: tleOf(q, sc) }));
    const partEvs = partKeys.map((te) => plan.ev(te.expr));
    const orderEvs = orderKeys.map((k) => plan.ev(k.te.expr));
    const partCmps = partKeys.map((te) => typeOps.comparator(te.expr.type, te.expr.collation));
    const orderCmps = orderKeys.map((k) => typeOps.comparator(k.te.expr.type, k.te.expr.collation));
    const items = current.map((c) => ({ c, pk: partEvs.map((ev) => ev(c)), ok: orderEvs.map((ev) => ev(c)) }));
    const cmpNullable = (a: unknown, b: unknown, cmp: (x: unknown, y: unknown) => number, desc: boolean, nullsFirst: boolean): number => {
      if (a === null || b === null) {
        if (a === null && b === null) {
          return 0;
        }
        const r = a === null ? 1 : -1;
        return nullsFirst ? -r : r;
      }
      const r = cmp(a, b);
      return desc ? -r : r;
    };
    const partCompare = (x: (typeof items)[0], y: (typeof items)[0]): number => {
      for (let i = 0; i < partCmps.length; i++) {
        const r = cmpNullable(x.pk[i], y.pk[i], partCmps[i], wc.partitionClause[i].desc, wc.partitionClause[i].nullsFirst);
        if (r !== 0) {
          return r;
        }
      }
      return 0;
    };
    const orderCompare = (x: (typeof items)[0], y: (typeof items)[0]): number => {
      for (let i = 0; i < orderCmps.length; i++) {
        const r = cmpNullable(x.ok[i], y.ok[i], orderCmps[i], orderKeys[i].sc.desc, orderKeys[i].sc.nullsFirst);
        if (r !== 0) {
          return r;
        }
      }
      return 0;
    };
    if (partCmps.length > 0 || orderCmps.length > 0) {
      pgQsort(items, (x, y) => partCompare(x, y) || orderCompare(x, y));
    }
    // partitions
    let start = 0;
    while (start < items.length) {
      let end = start + 1;
      while (end < items.length && partCompare(items[start], items[end]) === 0) {
        end++;
      }
      const part = items.slice(start, end);
      // peer groups
      const peerStart: number[] = new Array(part.length);
      const peerEnd: number[] = new Array(part.length);
      let ps = 0;
      while (ps < part.length) {
        let pe = ps + 1;
        while (pe < part.length && orderCompare(part[ps], part[pe]) === 0) {
          pe++;
        }
        for (let i = ps; i < pe; i++) {
          peerStart[i] = ps;
          peerEnd[i] = pe;
        }
        ps = pe;
      }
      for (const f of funcs) {
        computeWindowFunc(executor, plan, f, wc, part.map((p) => p.c), peerStart, peerEnd, orderKeys.length > 0);
      }
      start = end;
    }
    current = items.map((i) => i.c);
    finalOrder = [...wc.partitionClause, ...wc.orderClause];
  }
  return { rows: current, finalOrder };
}

function tleOf(q: Query, sc: SortGroupClause) {
  return q.targetList.find((t) => t.sortGroupRef === sc.tleSortGroupRef)!;
}

function computeWindowFunc(
  executor: Executor,
  plan: QueryPlan,
  f: WindowFuncNode,
  wc: Query['windowClause'][0],
  part: EvalCtx[],
  peerStart: number[],
  peerEnd: number[],
  hasOrder: boolean
): void {
  const n = part.length;
  const argEvs = f.args.map((a) => plan.ev(a));
  const idx = f.winIndex;
  const set = (i: number, v: unknown) => {
    part[i].winValues![idx] = v;
  };
  if (!f.isAgg) {
    switch (f.funcName) {
      case 'row_number':
        for (let i = 0; i < n; i++) {
          set(i, BigInt(i + 1));
        }
        return;
      case 'rank':
        for (let i = 0; i < n; i++) {
          set(i, BigInt(peerStart[i] + 1));
        }
        return;
      case 'dense_rank': {
        let rank = 0;
        let last = -1;
        for (let i = 0; i < n; i++) {
          if (peerStart[i] !== last) {
            rank++;
            last = peerStart[i];
          }
          set(i, BigInt(rank));
        }
        return;
      }
      case 'percent_rank':
        for (let i = 0; i < n; i++) {
          set(i, n > 1 ? peerStart[i] / (n - 1) : 0);
        }
        return;
      case 'cume_dist':
        for (let i = 0; i < n; i++) {
          set(i, peerEnd[i] / n);
        }
        return;
      case 'ntile': {
        for (let i = 0; i < n; i++) {
          const buckets = argEvs[0](part[i]) as number;
          if (buckets === null) {
            set(i, null);
            continue;
          }
          if (buckets <= 0) {
            throw new PgError(SqlState.INVALID_ARGUMENT_FOR_NTILE, 'argument of ntile must be greater than zero');
          }
          const per = Math.floor(n / buckets);
          const extra = n % buckets;
          let pos = i;
          let b = 1;
          while (true) {
            const size = per + (b <= extra ? 1 : 0);
            if (pos < size) {
              break;
            }
            pos -= size;
            b++;
          }
          set(i, b);
        }
        return;
      }
      case 'lag':
      case 'lead': {
        for (let i = 0; i < n; i++) {
          const offset = argEvs.length > 1 ? (argEvs[1](part[i]) as number) : 1;
          if (offset === null) {
            set(i, null);
            continue;
          }
          const target = f.funcName === 'lag' ? i - offset : i + offset;
          if (target >= 0 && target < n) {
            set(i, argEvs[0](part[target]));
          } else {
            set(i, argEvs.length > 2 ? argEvs[2](part[i]) : null);
          }
        }
        return;
      }
      case 'first_value':
      case 'last_value':
      case 'nth_value': {
        for (let i = 0; i < n; i++) {
          const [fs, fe] = frameBounds(executor, plan, wc, part, i, peerStart, peerEnd, hasOrder);
          if (fs >= fe) {
            set(i, null);
            continue;
          }
          if (f.funcName === 'first_value') {
            set(i, argEvs[0](part[fs]));
          } else if (f.funcName === 'last_value') {
            set(i, argEvs[0](part[fe - 1]));
          } else {
            const nth = argEvs[1](part[i]) as number;
            if (nth <= 0) {
              throw new PgError(SqlState.INVALID_ARGUMENT_FOR_NTH_VALUE, 'argument of nth_value must be greater than zero');
            }
            set(i, fs + nth - 1 < fe ? argEvs[0](part[fs + nth - 1]) : null);
          }
        }
        return;
      }
    }
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: window function ${f.funcName} is not implemented`);
  }
  // aggregate as window function
  const aggLike: AggNode = {
    k: 'agg',
    aggOid: f.funcOid,
    aggName: f.funcName,
    aggKind: 'n',
    transSrc: f.funcSrc,
    args: f.args,
    argTypes: f.argTypes,
    directArgs: [],
    distinct: false,
    star: f.star,
    order: [],
    filter: f.filter,
    levelsUp: 0,
    aggIndex: -1,
    variadic: false,
    type: f.type,
    typmod: f.typmod,
    collation: f.collation,
    inputCollation: f.inputCollation,
  };
  const impl = lookupAggregate(aggLike, executor.host.session.typeOps);
  if (!impl) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: aggregate ${f.funcName} is not implemented`);
  }
  const filterEv = f.filter ? plan.ev(f.filter) : null;
  const fc: FnCall = { st: executor.st, argTypes: f.args.map((a) => a.type), resultType: f.type, resultTypmod: f.typmod, collation: f.inputCollation, node: f };
  const strict = impl.strict !== false;
  const cache = new Map<string, unknown>();
  for (let i = 0; i < n; i++) {
    const [fs, fe] = frameBounds(executor, plan, wc, part, i, peerStart, peerEnd, hasOrder);
    const key = fs + ':' + fe;
    if (cache.has(key) && wc.frame.exclusion === 'NO_OTHERS') {
      set(i, cloneValue(cache.get(key)));
      continue;
    }
    let state = impl.init(fc);
    for (let j = fs; j < fe; j++) {
      if (wc.frame.exclusion === 'CURRENT_ROW' && j === i) {
        continue;
      }
      if ((wc.frame.exclusion === 'GROUP' || wc.frame.exclusion === 'TIES') && j >= peerStart[i] && j < peerEnd[i] && (wc.frame.exclusion === 'GROUP' || j !== i)) {
        continue;
      }
      const c = part[j];
      if (filterEv && filterEv(c) !== true) {
        continue;
      }
      const args = argEvs.map((ev) => ev(c));
      if (strict && !f.star && args.some((a) => a === null)) {
        continue;
      }
      state = impl.step(state, args, fc);
    }
    const v = impl.final(state, fc);
    cache.set(key, v);
    set(i, cloneValue(v));
  }
}

function cloneValue(v: unknown): unknown {
  return Array.isArray(v) ? v.slice() : v;
}

function frameBounds(
  executor: Executor,
  plan: QueryPlan,
  wc: Query['windowClause'][0],
  part: EvalCtx[],
  i: number,
  peerStart: number[],
  peerEnd: number[],
  hasOrder: boolean
): [number, number] {
  const n = part.length;
  const fr = wc.frame;
  if (fr.defaultFrame) {
    return hasOrder ? [0, peerEnd[i]] : [0, n];
  }
  const offsetOf = (b: { offset: TExpr | null }): number => {
    if (!b.offset) {
      return 0;
    }
    const v = plan.ev(b.offset)(part[i]);
    if (v === null) {
      throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'frame starting offset must not be null');
    }
    const num = Number(v);
    if (num < 0) {
      throw new PgError(SqlState.INVALID_PRECEDING_OR_FOLLOWING_SIZE, 'frame starting offset must not be negative');
    }
    return num;
  };
  let start = 0;
  let end = n;
  if (fr.mode === 'ROWS') {
    switch (fr.start.type) {
      case 'UNBOUNDED_PRECEDING':
        start = 0;
        break;
      case 'PRECEDING':
        start = Math.max(0, i - offsetOf(fr.start));
        break;
      case 'CURRENT_ROW':
        start = i;
        break;
      case 'FOLLOWING':
        start = Math.min(n, i + offsetOf(fr.start));
        break;
      default:
        start = n;
    }
    switch (fr.end.type) {
      case 'UNBOUNDED_FOLLOWING':
        end = n;
        break;
      case 'FOLLOWING':
        end = Math.min(n, i + offsetOf(fr.end) + 1);
        break;
      case 'CURRENT_ROW':
        end = i + 1;
        break;
      case 'PRECEDING':
        end = Math.max(0, i - offsetOf(fr.end) + 1);
        break;
      default:
        end = 0;
    }
    return [start, end];
  }
  if (fr.mode === 'GROUPS') {
    const groupIndex: number[] = [];
    const groupStarts: number[] = [];
    let g = -1;
    for (let j = 0; j < n; j++) {
      if (peerStart[j] === j) {
        g++;
        groupStarts.push(j);
      }
      groupIndex.push(g);
    }
    const gi = groupIndex[i];
    const ng = groupStarts.length;
    const groupStart = (x: number) => (x < 0 ? 0 : x >= ng ? n : groupStarts[x]);
    const groupEnd = (x: number) => (x < 0 ? 0 : x >= ng - 1 ? n : groupStarts[x + 1]);
    switch (fr.start.type) {
      case 'UNBOUNDED_PRECEDING':
        start = 0;
        break;
      case 'PRECEDING':
        start = groupStart(gi - offsetOf(fr.start));
        break;
      case 'CURRENT_ROW':
        start = peerStart[i];
        break;
      case 'FOLLOWING':
        start = groupStart(gi + offsetOf(fr.start));
        break;
    }
    switch (fr.end.type) {
      case 'UNBOUNDED_FOLLOWING':
        end = n;
        break;
      case 'FOLLOWING':
        end = groupEnd(gi + offsetOf(fr.end));
        break;
      case 'CURRENT_ROW':
        end = peerEnd[i];
        break;
      case 'PRECEDING':
        end = groupEnd(gi - offsetOf(fr.end));
        break;
    }
    return [start, end];
  }
  // RANGE
  switch (fr.start.type) {
    case 'UNBOUNDED_PRECEDING':
      start = 0;
      break;
    case 'CURRENT_ROW':
      start = hasOrder ? peerStart[i] : 0;
      break;
    default:
      start = rangeOffsetBound(executor, plan, wc, part, i, fr.start, true);
  }
  switch (fr.end.type) {
    case 'UNBOUNDED_FOLLOWING':
      end = n;
      break;
    case 'CURRENT_ROW':
      end = hasOrder ? peerEnd[i] : n;
      break;
    default:
      end = rangeOffsetBound(executor, plan, wc, part, i, fr.end, false);
  }
  return [start, end];
}

function rangeOffsetBound(executor: Executor, plan: QueryPlan, wc: Query['windowClause'][0], part: EvalCtx[], i: number, bound: { type: string; offset: TExpr | null }, isStart: boolean): number {
  const q = plan.q;
  const te = q.targetList.find((t) => t.sortGroupRef === wc.orderClause[0].tleSortGroupRef)!;
  const ev = plan.ev(te.expr);
  const cur = ev(part[i]);
  const off = plan.ev(bound.offset!)(part[i]);
  const desc = wc.orderClause[0].desc;
  const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : v instanceof Object && 'toNumber' in (v as object) ? (v as { toNumber(): number }).toNumber() : (v as number));
  let offset: number;
  if (te.expr.type === TypeOid.date || te.expr.type === TypeOid.timestamp || te.expr.type === TypeOid.timestamptz) {
    const iv = off as { months: number; days: number; us: number };
    offset = te.expr.type === TypeOid.date ? iv.days + iv.us / 86400000000 : (iv.months * 30 + iv.days) * 86400000000 + iv.us;
  } else {
    offset = toNum(off);
  }
  const c = toNum(cur);
  const preceding = bound.type === 'PRECEDING';
  const limit = desc ? (preceding ? c + offset : c - offset) : preceding ? c - offset : c + offset;
  const n = part.length;
  if (isStart) {
    for (let j = 0; j < n; j++) {
      const v = toNum(ev(part[j]));
      if (desc ? v <= limit : v >= limit) {
        return j;
      }
    }
    return n;
  }
  for (let j = n - 1; j >= 0; j--) {
    const v = toNum(ev(part[j]));
    if (desc ? v >= limit : v <= limit) {
      return j + 1;
    }
  }
  void executor;
  return 0;
}
