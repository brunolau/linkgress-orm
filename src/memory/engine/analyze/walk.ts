import { TExpr } from './nodes';

/** Visit direct child expressions of a node (not descending into sublink subqueries). */
export function forEachChild(e: TExpr, fn: (child: TExpr) => void): void {
  switch (e.k) {
    case 'const':
    case 'param':
    case 'execparam':
    case 'var':
    case 'sqlvalue':
    case 'default':
    case 'grouping':
    case 'groupkey':
      return;
    case 'op':
    case 'func':
    case 'coalesce':
    case 'minmax':
    case 'nullif':
    case 'bool':
    case 'row':
    case 'distinct':
      for (const a of e.args) {
        fn(a);
      }
      return;
    case 'saop':
      fn(e.args[0]);
      fn(e.args[1]);
      return;
    case 'agg':
      for (const a of e.directArgs) {
        fn(a);
      }
      for (const a of e.args) {
        fn(a);
      }
      for (const o of e.order) {
        fn(o.expr);
      }
      if (e.filter) {
        fn(e.filter);
      }
      return;
    case 'window':
      for (const a of e.args) {
        fn(a);
      }
      if (e.filter) {
        fn(e.filter);
      }
      return;
    case 'nulltest':
    case 'booltest':
    case 'relabel':
    case 'iocoerce':
    case 'domaincoerce':
    case 'fieldselect':
    case 'collate':
      fn(e.arg);
      return;
    case 'arraycoerce':
      fn(e.arg);
      fn(e.elemExpr);
      return;
    case 'case':
      if (e.arg) {
        fn(e.arg);
      }
      for (const w of e.whens) {
        fn(w.cond);
        fn(w.result);
      }
      fn(e.def);
      return;
    case 'sublink':
      for (const a of e.testLeft) {
        fn(a);
      }
      return;
    case 'array':
      for (const a of e.elements) {
        fn(a);
      }
      return;
    case 'subscript':
      fn(e.arg);
      for (const u of e.upper) {
        if (u) {
          fn(u);
        }
      }
      if (e.lower) {
        for (const l of e.lower) {
          if (l) {
            fn(l);
          }
        }
      }
      return;
    case 'rowcompare':
      for (const a of e.largs) {
        fn(a);
      }
      for (const a of e.rargs) {
        fn(a);
      }
      return;
  }
}

/** Rebuild a node with children mapped (shallow copy). */
export function mapChildren(e: TExpr, fn: (child: TExpr) => TExpr): TExpr {
  switch (e.k) {
    case 'const':
    case 'param':
    case 'execparam':
    case 'var':
    case 'sqlvalue':
    case 'default':
    case 'grouping':
    case 'groupkey':
      return e;
    case 'op':
    case 'func':
    case 'coalesce':
    case 'minmax':
    case 'nullif':
    case 'bool':
    case 'row':
    case 'distinct':
      return { ...e, args: e.args.map(fn) } as TExpr;
    case 'saop':
      return { ...e, args: [fn(e.args[0]), fn(e.args[1])] };
    case 'agg':
      return e;
    case 'window':
      return e;
    case 'nulltest':
    case 'booltest':
    case 'relabel':
    case 'iocoerce':
    case 'domaincoerce':
    case 'fieldselect':
    case 'collate':
      return { ...e, arg: fn(e.arg) } as TExpr;
    case 'arraycoerce':
      return { ...e, arg: fn(e.arg) };
    case 'case':
      return { ...e, arg: e.arg ? fn(e.arg) : null, whens: e.whens.map((w) => ({ cond: fn(w.cond), result: fn(w.result) })), def: fn(e.def) };
    case 'sublink':
      return { ...e, testLeft: e.testLeft.map(fn) };
    case 'array':
      return { ...e, elements: e.elements.map(fn) };
    case 'subscript':
      return { ...e, arg: fn(e.arg), upper: e.upper.map((u) => (u ? fn(u) : null)), lower: e.lower ? e.lower.map((l) => (l ? fn(l) : null)) : null };
    case 'rowcompare':
      return { ...e, largs: e.largs.map(fn), rargs: e.rargs.map(fn) };
  }
}

const IGNORED_KEYS = new Set(['location', 'id', 'aggIndex', 'winIndex', 'testSlot', 'elemSlot', 'correlated']);

/** Structural equality of analyzed expressions (PostgreSQL's equal()). */
export function exprEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      return a === b;
    }
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!exprEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  if (ao.constructor !== bo.constructor) {
    return false;
  }
  if (typeof (ao as { compare?: unknown }).compare === 'function' && typeof (ao as { toString?: unknown }).toString === 'function' && 'mag' in ao) {
    return String(ao) === String(bo);
  }
  if ('k' in ao && ao.k === 'sublink') {
    return a === b;
  }
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (IGNORED_KEYS.has(k)) {
      continue;
    }
    if (!exprEqual(ao[k], bo[k])) {
      return false;
    }
  }
  return true;
}

/** Does the expression (at this level) contain any Var of levelsUp == level? */
export function containsVarsOfLevel(e: TExpr, level: number): boolean {
  let found = false;
  const visit = (x: TExpr, lvl: number) => {
    if (found) {
      return;
    }
    if (x.k === 'var' && x.levelsUp === lvl) {
      found = true;
      return;
    }
    if (x.k === 'sublink') {
      for (const t of x.testLeft) {
        visit(t, lvl);
      }
      if (queryReferencesLevel(x.subquery, lvl + 1)) {
        found = true;
      }
      return;
    }
    forEachChild(x, (c) => visit(c, lvl));
  };
  visit(e, level);
  return found;
}

import type { Query } from './nodes';

/** Does a query tree reference variables `level` levels above itself? */
export function queryReferencesLevel(q: Query, level: number): boolean {
  let found = false;
  const visitExpr = (x: TExpr | null | undefined, lvl: number) => {
    if (!x || found) {
      return;
    }
    if (x.k === 'var') {
      if (x.levelsUp === lvl) {
        found = true;
      }
      return;
    }
    if (x.k === 'agg' && x.levelsUp === lvl) {
      found = true;
      return;
    }
    if (x.k === 'sublink') {
      for (const t of x.testLeft) {
        visitExpr(t, lvl);
      }
      visitQuery(x.subquery, lvl + 1);
      return;
    }
    forEachChild(x, (c) => visitExpr(c, lvl));
  };
  const visitQuery = (qq: Query, lvl: number) => {
    if (found) {
      return;
    }
    for (const te of qq.targetList) {
      visitExpr(te.expr, lvl);
    }
    for (const te of qq.returningList) {
      visitExpr(te.expr, lvl);
    }
    visitExpr(qq.where, lvl);
    visitExpr(qq.havingQual, lvl);
    visitExpr(qq.limitCount, lvl);
    visitExpr(qq.limitOffset, lvl);
    for (const cte of qq.cteList) {
      visitQuery(cte.query, lvl + 1);
    }
    for (const rte of qq.rtable) {
      switch (rte.kind) {
        case 'subquery':
          visitQuery(rte.subquery, lvl + 1);
          break;
        case 'function':
          for (const f of rte.functions) {
            visitExpr(f.expr, lvl);
          }
          break;
        case 'values':
          for (const row of rte.lists) {
            for (const v of row) {
              visitExpr(v, lvl);
            }
          }
          break;
        case 'join':
          for (const v of rte.aliasVars) {
            visitExpr(v, lvl);
          }
          break;
        case 'cte':
          if (rte.levelsUp >= lvl && rte.levelsUp > 0) {
            // CTE of an outer level is not a variable reference
          }
          break;
      }
    }
    const visitJoin = (j: import('./nodes').JoinTreeNode) => {
      if (j.k === 'join') {
        visitExpr(j.quals, lvl);
        visitJoin(j.larg);
        visitJoin(j.rarg);
      }
    };
    for (const j of qq.fromlist) {
      visitJoin(j);
    }
    if (qq.updateSet) {
      for (const s of qq.updateSet) {
        visitExpr(s.expr, lvl);
      }
    }
    if (qq.insertSource && qq.insertSource.kind === 'values') {
      for (const row of qq.insertSource.rows) {
        for (const v of row) {
          visitExpr(v, lvl);
        }
      }
    }
    if (qq.onConflict) {
      for (const s of qq.onConflict.setList) {
        visitExpr(s.expr, lvl);
      }
      visitExpr(qq.onConflict.where, lvl);
    }
    if (qq.mergeActions) {
      visitExpr(qq.mergeJoinCondition, lvl);
      for (const a of qq.mergeActions) {
        visitExpr(a.condition, lvl);
        for (const t of a.targetList) {
          visitExpr(t.expr, lvl);
        }
      }
    }
    for (const w of qq.windowClause) {
      visitExpr(w.frame.start.offset, lvl);
      visitExpr(w.frame.end.offset, lvl);
    }
  };
  visitQuery(q, level);
  return found;
}

/** Strip implicit coercions at the top of an expression. */
export function stripImplicitCoercions(e: TExpr): TExpr {
  let x = e;
  while (true) {
    if ((x.k === 'relabel' || x.k === 'iocoerce' || x.k === 'arraycoerce' || x.k === 'domaincoerce') && x.format === 'implicit_cast') {
      x = x.arg;
      continue;
    }
    if (x.k === 'func' && x.format === 'implicit_cast') {
      x = x.args[0];
      continue;
    }
    return x;
  }
}
