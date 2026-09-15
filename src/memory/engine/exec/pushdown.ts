import { Query, TExpr } from '../analyze/nodes';
import { TypeOid } from '../catalog/catalog';
import { forEachChild, mapChildren } from '../analyze/walk';
import { containsVolatile } from './relids';

/**
 * Restriction pushdown into subqueries (PostgreSQL set_subquery_pathlist / subquery_is_pushdown_safe):
 * a qual on a subquery's (or inlined CTE's) output columns is added to the subquery's WHERE, so the
 * subquery only produces rows that can pass. Results are unchanged; only the work shrinks.
 */

function hasNode(e: TExpr, pred: (x: TExpr) => boolean): boolean {
  let found = false;
  const visit = (x: TExpr) => {
    if (found) {
      return;
    }
    if (pred(x)) {
      found = true;
      return;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return found;
}

const UNSAFE_NODE = (x: TExpr) => x.k === 'sublink' || x.k === 'agg' || x.k === 'window' || x.k === 'groupkey' || x.k === 'grouping' || x.k === 'default';

/** contain_volatile_functions over a whole query tree (conservative). */
export function queryHasVolatile(q: Query): boolean {
  const exprs: TExpr[] = [];
  const add = (e: TExpr | null | undefined) => {
    if (e) {
      exprs.push(e);
    }
  };
  q.targetList.forEach((t) => add(t.expr));
  add(q.where);
  add(q.havingQual);
  const visitJoin = (j: Query['fromlist'][0]) => {
    if (j.k === 'join') {
      add(j.quals);
      visitJoin(j.larg);
      visitJoin(j.rarg);
    }
  };
  q.fromlist.forEach(visitJoin);
  for (const e of exprs) {
    if (containsVolatile(e) || hasNode(e, (x) => x.k === 'sublink' && queryHasVolatile(x.subquery))) {
      return true;
    }
  }
  for (const rte of q.rtable) {
    if (rte.kind === 'subquery' && queryHasVolatile(rte.subquery)) {
      return true;
    }
    if (rte.kind === 'function' && rte.functions.some((f) => containsVolatile(f.expr))) {
      return true;
    }
  }
  return q.cteList.some((c) => c.isModifying || queryHasVolatile(c.query));
}

/** Can quals be pushed into this query at all? */
export function subqueryPushdownSafe(q: Query): boolean {
  return (
    q.commandType === 'select' &&
    !q.setOperations &&
    !q.limitCount &&
    !q.limitOffset &&
    !q.hasWindowFuncs &&
    !q.hasTargetSRFs &&
    q.rowMarks.length === 0 &&
    !q.hasDistinctOn &&
    !(q.distinctClause && q.distinctClause.length > 0) &&
    !q.groupingSets &&
    !(q.hasAggs && q.groupClause.length === 0) &&
    !q.hasModifyingCte
  );
}

const exprIds = new WeakMap<TExpr, number>();
let nextExprId = 1;

function exprId(e: TExpr): number {
  let id = exprIds.get(e);
  if (id === undefined) {
    id = nextExprId++;
    exprIds.set(e, id);
  }
  return id;
}

const rewritten = new WeakMap<Query, Map<string, Query | null>>();

/**
 * Returns a copy of `sub` with the pushable `quals` (referencing range table entry `rtIndex`, which is
 * `levelsUp` levels above the subquery's owning level) added to its WHERE, or null when none can be pushed.
 */
export function pushQualsIntoSubquery(sub: Query, rtIndex: number, levelsUp: number, quals: TExpr[]): Query | null {
  if (quals.length === 0 || !subqueryPushdownSafe(sub)) {
    return null;
  }
  const key = quals.map(exprId).join(',') + '@' + rtIndex + ':' + levelsUp;
  let cache = rewritten.get(sub);
  if (!cache) {
    cache = new Map();
    rewritten.set(sub, cache);
  }
  if (cache.has(key)) {
    return cache.get(key)!;
  }
  const visible = sub.targetList.filter((t) => !t.resjunk);
  const groupRefs = new Set(sub.groupClause.map((g) => g.tleSortGroupRef));
  const pushed: TExpr[] = [];
  for (const qual of quals) {
    if (containsVolatile(qual) || hasNode(qual, UNSAFE_NODE)) {
      continue;
    }
    let ok = true;
    const subst = (e: TExpr): TExpr => {
      if (!ok) {
        return e;
      }
      if (e.k === 'var') {
        if (e.levelsUp === 0) {
          if (e.rtIndex !== rtIndex || e.attno < 0 || e.attno >= visible.length) {
            ok = false;
            return e;
          }
          const te = visible[e.attno];
          if (containsVolatile(te.expr) || hasNode(te.expr, UNSAFE_NODE) || (sub.hasAggs && !(te.sortGroupRef && groupRefs.has(te.sortGroupRef)))) {
            ok = false;
            return e;
          }
          return te.expr;
        }
        if (e.levelsUp < levelsUp) {
          // references a level between the subquery's owner and the qual: not visible inside
          ok = false;
          return e;
        }
        return { ...e, levelsUp: e.levelsUp - levelsUp + 1 };
      }
      return mapChildren(e, subst);
    };
    const moved = subst(qual);
    if (ok) {
      pushed.push(moved);
    }
  }
  if (pushed.length === 0) {
    cache.set(key, null);
    return null;
  }
  const conj = sub.where ? [sub.where, ...pushed] : pushed;
  const where: TExpr = conj.length === 1 ? conj[0] : ({ k: 'bool', op: 'and', args: conj, type: TypeOid.bool, typmod: -1, collation: 0 } as TExpr);
  const out: Query = { ...sub, where };
  cache.set(key, out);
  return out;
}
