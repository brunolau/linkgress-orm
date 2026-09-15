import { JoinTreeNode, Query, TExpr } from '../analyze/nodes';
import { forEachChild } from '../analyze/walk';

// Analyzed expression trees are immutable once planned; these per-node results are memoized (a
// correlated subquery plans and runs its joins once per outer row). Callers must not mutate them.
const relidsMemo = new WeakMap<TExpr, Set<number>>();
const volatileMemo = new WeakMap<TExpr, boolean>();
const conjunctsMemo = new WeakMap<TExpr, TExpr[]>();
const EMPTY: TExpr[] = [];

/** Range table indexes of query level 0 referenced by an expression (including inside sublinks). */
export function exprRelids(e: TExpr): Set<number> {
  let out = relidsMemo.get(e);
  if (!out) {
    out = new Set<number>();
    collect(e, 0, out);
    relidsMemo.set(e, out);
  }
  return out;
}

function collect(e: TExpr | null | undefined, depth: number, out: Set<number>): void {
  if (!e) {
    return;
  }
  if (e.k === 'var') {
    if (e.levelsUp === depth) {
      out.add(e.rtIndex);
    }
    return;
  }
  if (e.k === 'sublink') {
    for (const t of e.testLeft) {
      collect(t, depth, out);
    }
    collectQuery(e.subquery, depth + 1, out);
    return;
  }
  if (e.k === 'agg') {
    for (const a of e.args) {
      collect(a, depth, out);
    }
    if (e.filter) {
      collect(e.filter, depth, out);
    }
    return;
  }
  forEachChild(e, (c) => collect(c, depth, out));
}

function collectQuery(q: Query, depth: number, out: Set<number>): void {
  for (const te of q.targetList) {
    collect(te.expr, depth, out);
  }
  for (const te of q.returningList) {
    collect(te.expr, depth, out);
  }
  collect(q.where, depth, out);
  collect(q.havingQual, depth, out);
  collect(q.limitCount, depth, out);
  collect(q.limitOffset, depth, out);
  const visitJoin = (j: JoinTreeNode) => {
    if (j.k === 'join') {
      collect(j.quals, depth, out);
      visitJoin(j.larg);
      visitJoin(j.rarg);
    }
  };
  q.fromlist.forEach(visitJoin);
  for (const rte of q.rtable) {
    if (rte.kind === 'subquery') {
      collectQuery(rte.subquery, depth + 1, out);
    } else if (rte.kind === 'function') {
      for (const f of rte.functions) {
        collect(f.expr, depth, out);
      }
    } else if (rte.kind === 'values') {
      for (const row of rte.lists) {
        for (const v of row) {
          collect(v, depth, out);
        }
      }
    } else if (rte.kind === 'join') {
      for (const v of rte.aliasVars) {
        collect(v, depth, out);
      }
    }
  }
  for (const c of q.cteList) {
    collectQuery(c.query, depth + 1, out);
    if (c.recursiveParts) {
      collectQuery(c.recursiveParts.recursive, depth + 1, out);
    }
  }
  if (q.updateSet) {
    for (const s of q.updateSet) {
      collect(s.expr, depth, out);
    }
  }
}

const joinRelidsMemo = new WeakMap<JoinTreeNode, Set<number>>();

export function joinTreeRelids(j: JoinTreeNode, into?: Set<number>): Set<number> {
  if (!into) {
    let memo = joinRelidsMemo.get(j);
    if (!memo) {
      memo = joinTreeRelids(j, new Set());
      joinRelidsMemo.set(j, memo);
    }
    return memo;
  }
  const out = into;
  if (j.k === 'ref') {
    out.add(j.rtIndex);
  } else {
    joinTreeRelids(j.larg, out);
    joinTreeRelids(j.rarg, out);
    out.add(j.rtIndex);
  }
  return out;
}

/** Split an AND tree into conjuncts. */
export function splitConjuncts(e: TExpr | null): TExpr[] {
  if (!e) {
    return EMPTY;
  }
  let out = conjunctsMemo.get(e);
  if (!out) {
    out = e.k === 'bool' && e.op === 'and' ? e.args.flatMap((a) => splitConjuncts(a)) : [e];
    conjunctsMemo.set(e, out);
  }
  return out;
}

/**
 * find_nonnullable_rels: range table indexes (query level 0) whose columns must be non-NULL for the
 * qual to be TRUE — through strict operators / functions, AND (union), OR (intersection), IS NOT
 * NULL, IS TRUE / IS FALSE and = ANY. A WHERE qual like that turns an outer join whose nullable side
 * it references into an inner join (reduce_outer_joins).
 */
export function nonNullableRels(e: TExpr, isStrict: (funcOid: number) => boolean): Set<number> {
  const out = new Set<number>();
  const strictArgs = (x: TExpr): void => {
    switch (x.k) {
      case 'var':
        if (x.levelsUp === 0) {
          out.add(x.rtIndex);
        }
        return;
      case 'relabel':
      case 'iocoerce':
        strictArgs(x.arg);
        return;
      case 'op':
        if (!x.retset && isStrict(x.funcOid)) {
          x.args.forEach(strictArgs);
        }
        return;
      case 'func':
        if (x.strict && !x.retset && !x.isUser) {
          x.args.forEach(strictArgs);
        }
        return;
      default:
        return;
    }
  };
  switch (e.k) {
    case 'bool':
      if (e.op === 'and') {
        for (const a of e.args) {
          nonNullableRels(a, isStrict).forEach((r) => out.add(r));
        }
      } else if (e.op === 'or') {
        const sets = e.args.map((a) => nonNullableRels(a, isStrict));
        for (const r of sets[0] ?? []) {
          if (sets.every((s) => s.has(r))) {
            out.add(r);
          }
        }
      }
      return out;
    case 'nulltest':
      if (e.isNot) {
        strictArgs(e.arg);
      }
      return out;
    case 'booltest':
      if (e.test === 'IS_TRUE' || e.test === 'IS_FALSE') {
        strictArgs(e.arg);
      }
      return out;
    case 'saop':
      strictArgs(e.args[0]);
      return out;
    default:
      strictArgs(e);
      return out;
  }
}

/** Does the expression contain volatile constructs that must not be evaluated out of order? */
export function containsVolatile(e: TExpr): boolean {
  const memo = volatileMemo.get(e);
  if (memo !== undefined) {
    return memo;
  }
  const result = containsVolatileUncached(e);
  volatileMemo.set(e, result);
  return result;
}

function containsVolatileUncached(e: TExpr): boolean {
  let found = false;
  const visit = (x: TExpr) => {
    if (found) {
      return;
    }
    if (x.k === 'func' && (x.funcName === 'random' || x.funcName === 'nextval' || x.funcName === 'setval' || x.funcName === 'pg_sleep' || x.funcName === 'clock_timestamp' || x.isUser)) {
      found = true;
      return;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return found;
}
