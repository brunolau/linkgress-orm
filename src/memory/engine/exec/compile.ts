import { Catalog, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { CaseNode, FuncNode, OpNode, Query, SubLinkNode, TExpr, VarNode } from '../analyze/nodes';
import { SYSTEM_ATTNO_BASE } from '../analyze/colref';
import { forEachChild } from '../analyze/walk';
import type { Tuple } from '../storage/mvcc';
import { USECS_PER_DAY, USECS_PER_SEC, zoneOffsetAt } from '../types/datetime';
import { inputValue, outputValue } from '../types/io';
import { JNULL, JsonbObject, JsonbValue } from '../types/json';
import { PgNumeric } from '../types/numeric';
import { PgRecord, arrayLowerBound, withLowerBound } from '../types/values';
import { lookupFunction } from './functions/registry';
import { EvalCtx, Evaluator, FnCall, FnImpl, SubqueryRunner } from './runtime';
import { TypeOps } from './typeops';

export interface CompileEnv {
  catalog: Catalog;
  typeOps: TypeOps;
  runner: SubqueryRunner;
  /** per range table: output column types of relations (for whole-row vars) and physical index mapping */
  rtInfo: (levelsUp: number, rtIndex: number) => RtInfo | undefined;
}

export interface RtInfo {
  /** map output column index -> physical data index (relations) or identity */
  physical?: number[];
  /** missing values per output column for relation tuples shorter than the current schema */
  missing?: unknown[];
  colTypes: number[];
  colNames: string[];
  /** composite type oid for whole-row references */
  rowType: number;
  /** range-table size of the query level (rows keep tuple versions at `nrt + rtIndex`) */
  nrt?: number;
  /** relation oid (tableoid of rows not read through an inheritance parent) */
  relOid?: number;
}

const COMPARISON_OPS = new Set(['=', '<>', '<', '<=', '>', '>=']);

export function compileExpr(e: TExpr, env: CompileEnv): Evaluator {
  switch (e.k) {
    case 'const': {
      const v = e.isNull ? null : e.value;
      return () => v;
    }
    case 'param': {
      const idx = e.paramId - 1;
      return (c) => {
        const v = c.st.params[idx];
        return v === undefined ? null : v;
      };
    }
    case 'execparam': {
      const slot = e.slot;
      return (c) => c.st.execParams[slot];
    }
    case 'var':
      return compileVar(e, env);
    case 'groupkey': {
      const idx = e.index;
      return (c) => {
        let ctx: EvalCtx | null = c;
        while (ctx && ctx.groupKeys === null) {
          ctx = ctx.parent;
        }
        return ctx ? ctx.groupKeys![idx] : null;
      };
    }
    case 'agg': {
      const idx = e.aggIndex;
      const up = e.levelsUp;
      return (c) => {
        let ctx: EvalCtx | null = c;
        for (let i = 0; i < up && ctx; i++) {
          ctx = ctx.parent;
        }
        if (!ctx || !ctx.aggValues) {
          throw new PgError(SqlState.GROUPING_ERROR, 'aggregate function calls cannot be evaluated here');
        }
        return ctx.aggValues[idx];
      };
    }
    case 'window': {
      const idx = e.winIndex;
      return (c) => {
        if (!c.winValues) {
          throw new PgError(SqlState.WINDOWING_ERROR, 'window function calls cannot be evaluated here');
        }
        return c.winValues[idx];
      };
    }
    case 'op':
    case 'func':
      return compileCall(e, env);
    case 'bool':
      return compileBool(e.op, e.args.map((a) => compileExpr(a, env)));
    case 'nulltest': {
      const arg = compileExpr(e.arg, env);
      const isNot = e.isNot;
      if (e.argIsRow || e.arg.k === 'row') {
        return (c) => {
          const v = arg(c);
          if (v === null) {
            return isNot ? false : true;
          }
          if (v instanceof PgRecord) {
            if (isNot) {
              return v.values.every((x) => x !== null && x !== undefined);
            }
            return v.values.every((x) => x === null || x === undefined);
          }
          return isNot;
        };
      }
      return isNot ? (c) => arg(c) !== null : (c) => arg(c) === null;
    }
    case 'booltest': {
      const arg = compileExpr(e.arg, env);
      switch (e.test) {
        case 'IS_TRUE':
          return (c) => arg(c) === true;
        case 'IS_NOT_TRUE':
          return (c) => arg(c) !== true;
        case 'IS_FALSE':
          return (c) => arg(c) === false;
        case 'IS_NOT_FALSE':
          return (c) => arg(c) !== false;
        case 'IS_UNKNOWN':
          return (c) => arg(c) === null;
        case 'IS_NOT_UNKNOWN':
          return (c) => arg(c) !== null;
      }
      break;
    }
    case 'case':
      return compileCase(e, env);
    case 'coalesce': {
      const args = e.args.map((a) => compileExpr(a, env));
      return (c) => {
        for (const a of args) {
          const v = a(c);
          if (v !== null) {
            return v;
          }
        }
        return null;
      };
    }
    case 'minmax': {
      const args = e.args.map((a) => compileExpr(a, env));
      const cmp = env.typeOps.comparator(e.type, e.collation);
      const greatest = e.op === 'greatest';
      return (c) => {
        let best: unknown = null;
        for (const a of args) {
          const v = a(c);
          if (v === null) {
            continue;
          }
          if (best === null) {
            best = v;
          } else {
            const r = cmp(v, best);
            if (greatest ? r > 0 : r < 0) {
              best = v;
            }
          }
        }
        return best;
      };
    }
    case 'nullif': {
      const a = compileExpr(e.args[0], env);
      const b = compileExpr(e.args[1], env);
      const eq = operatorImpl('=', e.opSrc, e.args[0].type, e.args[1].type, e.args[0].collation, env, e);
      return (c) => {
        const x = a(c);
        const y = b(c);
        if (x === null || y === null) {
          return x;
        }
        return eq([x, y]) === true ? null : x;
      };
    }
    case 'distinct': {
      const a = compileExpr(e.args[0], env);
      const b = compileExpr(e.args[1], env);
      const eq = operatorImpl('=', e.opSrc, e.args[0].type, e.args[1].type, e.inputCollation, env, e);
      const isNot = e.isNot;
      return (c) => {
        const x = a(c);
        const y = b(c);
        let distinct: boolean;
        if (x === null && y === null) {
          distinct = false;
        } else if (x === null || y === null) {
          distinct = true;
        } else {
          distinct = eq([x, y]) !== true;
        }
        return isNot ? !distinct : distinct;
      };
    }
    case 'saop':
      return compileSaop(e, env);
    case 'rowcompare': {
      const ls = e.largs.map((a) => compileExpr(a, env));
      const rs = e.rargs.map((a) => compileExpr(a, env));
      const cmps = e.largs.map((l, i) => {
        const cc = env.typeOps.crossComparator(l.type, e.rargs[i].type, e.collations[i]);
        return cc ?? env.typeOps.comparator(l.type, e.collations[i]);
      });
      const op = e.op;
      return (c) => {
        for (let i = 0; i < ls.length; i++) {
          const x = ls[i](c);
          const y = rs[i](c);
          if (x === null || y === null) {
            return null;
          }
          const r = cmps[i](x, y);
          if (r !== 0) {
            return op === '<' || op === '<=' ? r < 0 : r > 0;
          }
        }
        return op === '<=' || op === '>=';
      };
    }
    case 'sublink':
      return compileSublink(e, env);
    case 'row': {
      const args = e.args.map((a) => compileExpr(a, env));
      const fieldTypes = e.args.map((a) => a.type);
      const names = e.fieldNames;
      const type = e.type;
      return (c) =>
        new PgRecord(
          args.map((a) => a(c)),
          type,
          fieldTypes,
          names
        );
    }
    case 'array': {
      const els = e.elements.map((a) => compileExpr(a, env));
      if (e.multidims) {
        return (c) => {
          const out: unknown[] = [];
          for (const el of els) {
            const v = el(c);
            if (v === null) {
              continue;
            }
            out.push(v);
          }
          if (out.length > 0) {
            const len = Array.isArray(out[0]) ? (out[0] as unknown[]).length : -1;
            for (const x of out) {
              if (!Array.isArray(x) || x.length !== len) {
                throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'multidimensional arrays must have array expressions with matching dimensions');
              }
            }
            if (len === 0) {
              return [];
            }
          }
          return out;
        };
      }
      return (c) => els.map((el) => el(c));
    }
    case 'relabel': {
      const arg = compileExpr(e.arg, env);
      if (e.arg.type === TypeOid.bpchar && (e.type === TypeOid.text || e.type === TypeOid.varchar)) {
        return (c) => {
          const v = arg(c);
          return v === null ? null : (v as string).replace(/ +$/, '');
        };
      }
      return arg;
    }
    case 'collate':
      return compileExpr(e.arg, env);
    case 'iocoerce': {
      const arg = compileExpr(e.arg, env);
      const from = e.arg.type;
      const to = e.type;
      return (c) => {
        const v = arg(c);
        if (v === null) {
          return null;
        }
        const text = from === TypeOid.unknown ? (v as string) : outputValue(from, v, c.st.session.io);
        if (to === TypeOid.text || to === TypeOid.varchar || to === TypeOid.unknown) {
          return text;
        }
        return inputValue(to, text, -1, c.st.session.io);
      };
    }
    case 'arraycoerce': {
      const arg = compileExpr(e.arg, env);
      const elem = compileExpr(e.elemExpr, env);
      const slot = e.elemSlot;
      return (c) => {
        const v = arg(c);
        if (v === null) {
          return null;
        }
        const map = (arr: unknown[]): unknown[] => {
          const out = arr.map((x) => {
            if (Array.isArray(x)) {
              return map(x);
            }
            if (x === null) {
              return null;
            }
            const saved = c.st.execParams[slot];
            c.st.execParams[slot] = x;
            try {
              return elem(c);
            } finally {
              c.st.execParams[slot] = saved;
            }
          });
          return withLowerBound(out, arrayLowerBound(arr));
        };
        return map(v as unknown[]);
      };
    }
    case 'domaincoerce':
      return compileDomainCoerce(e.arg, e.domainOid, env);
    case 'fieldselect': {
      const arg = compileExpr(e.arg, env);
      const idx = e.fieldIndex;
      return (c) => {
        const v = arg(c);
        if (v === null) {
          return null;
        }
        const r = v as PgRecord;
        const x = r.values[idx];
        return x === undefined ? null : x;
      };
    }
    case 'subscript':
      return compileSubscript(e, env);
    case 'sqlvalue':
      return compileSqlValue(e.op, e.typmod);
    case 'default':
      return () => {
        throw new PgError(SqlState.SYNTAX_ERROR, 'DEFAULT is not allowed in this context');
      };
    case 'grouping': {
      const refs = e.refs;
      return (c) => {
        let mask = 0;
        let ctx: EvalCtx | null = c;
        while (ctx && ctx.groupKeys === null) {
          ctx = ctx.parent;
        }
        const gm = ctx ? ctx.groupingMask : 0;
        for (const r of refs) {
          mask = (mask << 1) | ((gm >> r) & 1);
        }
        return mask;
      };
    }
  }
  throw new PgError(SqlState.INTERNAL_ERROR, `cannot compile expression ${(e as TExpr).k}`);
}

function compileVar(e: TExpr & { k: 'var' }, env: CompileEnv): Evaluator {
  const { levelsUp, rtIndex, attno } = e;
  if (rtIndex === -1) {
    // set-operation / pseudo row
    return (c) => {
      let ctx: EvalCtx | null = c;
      for (let i = 0; i < levelsUp && ctx; i++) {
        ctx = ctx.parent;
      }
      const r = ctx!.setOpRow;
      return r ? r[attno] ?? null : null;
    };
  }
  const info = env.rtInfo(levelsUp, rtIndex);
  const phys = info?.physical;
  const missing = info?.missing;
  const getTuple =
    levelsUp === 0
      ? (c: EvalCtx) => c.row[rtIndex] as unknown[] | null | undefined
      : (c: EvalCtx) => {
          let ctx: EvalCtx | null = c;
          for (let i = 0; i < levelsUp && ctx; i++) {
            ctx = ctx.parent;
          }
          return ctx ? (ctx.row[rtIndex] as unknown[] | null | undefined) : null;
        };
  if (attno <= SYSTEM_ATTNO_BASE - 1) {
    return compileSystemColumn(levelsUp, rtIndex, attno - SYSTEM_ATTNO_BASE, info);
  }
  if (attno === -1) {
    const colTypes = info?.colTypes ?? [];
    const colNames = info?.colNames ?? [];
    const rowType = info?.rowType ?? TypeOid.record;
    return (c) => {
      const t = getTuple(c);
      if (t === null || t === undefined) {
        return null;
      }
      const values = phys ? phys.map((p, i) => (p < t.length ? t[p] : missing ? missing[i] : null)) : t.slice(0, colTypes.length || t.length);
      return new PgRecord(values, rowType, colTypes, colNames);
    };
  }
  if (phys) {
    const p = phys[attno];
    const miss = missing ? missing[attno] : null;
    return (c) => {
      const t = getTuple(c);
      if (t === null || t === undefined) {
        return null;
      }
      return p < t.length ? t[p] : miss;
    };
  }
  return (c) => {
    const t = getTuple(c);
    if (t === null || t === undefined) {
      return null;
    }
    const v = t[attno];
    return v === undefined ? null : v;
  };
}

/**
 * A system column (PostgreSQL attnum -1 ctid, -2 xmin, -3 cmin, -4 xmax, -5 cmax, -6 tableoid) of the
 * tuple version in the row. xmax also reports a lock-only locker (a row locked by FOR UPDATE, or the new
 * version an ON CONFLICT DO UPDATE wrote), as PostgreSQL's infomask-less xmax field does.
 */
function compileSystemColumn(levelsUp: number, rtIndex: number, attnum: number, info: RtInfo | undefined): Evaluator {
  const nrt = info?.nrt ?? 0;
  const relOid = info?.relOid ?? 0;
  const rowOf = (c: EvalCtx): unknown[] | null => {
    let ctx: EvalCtx | null = c;
    for (let i = 0; i < levelsUp && ctx; i++) {
      ctx = ctx.parent;
    }
    return ctx ? ctx.row : null;
  };
  return (c) => {
    const row = rowOf(c);
    const t = row ? (row[nrt + rtIndex] as Tuple | null | undefined) : null;
    if (!t) {
      return null;
    }
    switch (attnum) {
      case -1:
        return `(${Math.floor(t.seq / 256)},${(t.seq % 256) + 1})`;
      case -2:
        return t.xmin;
      case -3:
      case -5:
        return t.xmax ? t.cmax : t.cmin;
      case -4:
        if (t.xmax) {
          return t.xmax;
        }
        if (t.lockXmax) {
          return t.lockXmax;
        }
        if (t.locks && t.locks.size > 0) {
          return t.locks.keys().next().value as number;
        }
        return 0;
      default:
        return (row![2 * nrt + rtIndex] as number | undefined) ?? relOid;
    }
  };
}

function compileBool(op: 'and' | 'or' | 'not', args: Evaluator[]): Evaluator {
  if (op === 'not') {
    const a = args[0];
    return (c) => {
      const v = a(c);
      return v === null ? null : !v;
    };
  }
  if (op === 'and') {
    if (args.length === 2) {
      const [a, b] = args;
      return (c) => {
        const x = a(c);
        if (x === false) {
          return false;
        }
        const y = b(c);
        if (y === false) {
          return false;
        }
        return x === null || y === null ? null : true;
      };
    }
    return (c) => {
      let sawNull = false;
      for (const a of args) {
        const v = a(c);
        if (v === false) {
          return false;
        }
        if (v === null) {
          sawNull = true;
        }
      }
      return sawNull ? null : true;
    };
  }
  return (c) => {
    let sawNull = false;
    for (const a of args) {
      const v = a(c);
      if (v === true) {
        return true;
      }
      if (v === null) {
        sawNull = true;
      }
    }
    return sawNull ? null : false;
  };
}

function compileCase(e: CaseNode, env: CompileEnv): Evaluator {
  const arg = e.arg ? compileExpr(e.arg, env) : null;
  const whens = e.whens.map((w) => ({ cond: compileExpr(w.cond, env), result: compileExpr(w.result, env) }));
  const def = compileExpr(e.def, env);
  const slot = e.testSlot;
  if (arg) {
    return (c) => {
      const saved = c.st.execParams[slot];
      c.st.execParams[slot] = arg(c);
      try {
        for (const w of whens) {
          if (w.cond(c) === true) {
            return w.result(c);
          }
        }
      } finally {
        c.st.execParams[slot] = saved;
      }
      return def(c);
    };
  }
  return (c) => {
    for (const w of whens) {
      if (w.cond(c) === true) {
        return w.result(c);
      }
    }
    return def(c);
  };
}

function makeFnCall(node: TExpr, argTypes: number[]): Omit<FnCall, 'st'> {
  return { argTypes, resultType: node.type, resultTypmod: node.typmod, collation: (node as FuncNode).inputCollation ?? node.collation, node };
}

/** Resolve an operator implementation into a 2-arg function (no null handling). */
export function operatorImpl(opName: string, src: string, left: number, right: number, collation: number, env: CompileEnv, node: TExpr): (args: unknown[], c?: EvalCtx) => unknown {
  const impl = lookupFunction(src, node, env.typeOps, [left, right], opName);
  if (impl) {
    const fc = makeFnCall(node, [left, right]);
    // one call context per statement (it depends on nothing else), not one per evaluated row
    let fcSt: unknown = null;
    let fcCached: FnCall | null = null;
    return (args, c) => {
      const st = c ? c.st : (undefined as never);
      if (st !== fcSt || fcCached === null) {
        fcSt = st;
        fcCached = { ...fc, collation, st };
      }
      return impl(args, fcCached);
    };
  }
  if (COMPARISON_OPS.has(opName)) {
    const cmp = env.typeOps.crossComparator(left, right, collation) ?? env.typeOps.comparator(left, collation);
    return comparisonFromComparator(opName, cmp);
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: operator implementation ${src} (${opName}) is not supported`);
}

function comparisonFromComparator(op: string, cmp: (a: unknown, b: unknown) => number): (args: unknown[]) => unknown {
  switch (op) {
    case '=':
      return (a) => cmp(a[0], a[1]) === 0;
    case '<>':
      return (a) => cmp(a[0], a[1]) !== 0;
    case '<':
      return (a) => cmp(a[0], a[1]) < 0;
    case '<=':
      return (a) => cmp(a[0], a[1]) <= 0;
    case '>':
      return (a) => cmp(a[0], a[1]) > 0;
    default:
      return (a) => cmp(a[0], a[1]) >= 0;
  }
}

function compileCall(e: OpNode | FuncNode, env: CompileEnv): Evaluator {
  const args = e.args.map((a) => compileExpr(a, env));
  const argTypes = e.args.map((a) => a.type);
  const name = e.k === 'op' ? e.opName : e.funcName;
  const src = e.funcSrc;
  let impl: FnImpl | null = null;
  let strict = true;
  if (e.k === 'func' && e.isUser) {
    const proc = env.catalog.getProc(e.funcOid);
    if (!proc) {
      throw new PgError(SqlState.UNDEFINED_FUNCTION, `function ${e.funcName} does not exist`);
    }
    strict = proc.strict;
    impl = (vals, fc) => fc.st.session.callUserFunction(proc, vals, argTypes, fc.st).value;
  } else {
    impl = lookupFunction(src, e, env.typeOps, argTypes, name);
    if (e.k === 'func') {
      strict = e.strict;
    } else {
      const proc = env.catalog.getProc(e.funcOid);
      strict = proc ? proc.strict : true;
    }
    if (!impl && e.k === 'op' && COMPARISON_OPS.has(e.opName) && e.args.length === 2) {
      const cmp = env.typeOps.crossComparator(argTypes[0], argTypes[1], e.inputCollation) ?? env.typeOps.comparator(argTypes[0], e.inputCollation);
      const f = comparisonFromComparator(e.opName, cmp);
      impl = (vals) => f(vals);
    }
  }
  if (!impl) {
    const what = e.k === 'op' ? `operator ${e.opName} (${src})` : `function ${e.funcName} (${src})`;
    return () => {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: ${what} is not implemented`);
    };
  }
  const base = makeFnCall(e, argTypes);
  const fn = impl;
  const n = args.length;
  // the call context depends only on the statement: built once per statement, not per row
  let fcSt: unknown = null;
  let fcCached: FnCall | null = null;
  const callCtx = (c: EvalCtx): FnCall => {
    if (c.st !== fcSt || fcCached === null) {
      fcSt = c.st;
      fcCached = { ...base, st: c.st };
    }
    return fcCached;
  };
  if (n === 1) {
    const a0 = args[0];
    return (c) => {
      const v0 = a0(c);
      if (strict && v0 === null) {
        return null;
      }
      return fn([v0], callCtx(c));
    };
  }
  if (n === 2) {
    const [a0, a1] = args;
    return (c) => {
      const v0 = a0(c);
      if (strict && v0 === null) {
        return null;
      }
      const v1 = a1(c);
      if (strict && v1 === null) {
        return null;
      }
      return fn([v0, v1], callCtx(c));
    };
  }
  return (c) => {
    const vals = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = args[i](c);
      if (strict && v === null) {
        return null;
      }
      vals[i] = v;
    }
    return fn(vals, callCtx(c));
  };
}

function compileSaop(e: TExpr & { k: 'saop' }, env: CompileEnv): Evaluator {
  const left = compileExpr(e.args[0], env);
  const right = compileExpr(e.args[1], env);
  const ltype = e.args[0].type;
  const elemType = env.typeOps.catalog().getType(e.args[1].type)?.elem ?? e.args[1].type;
  const op = operatorImpl(e.opName, e.opSrc, ltype, elemType, e.inputCollation, env, e);
  const useOr = e.useOr;
  const proc = env.catalog.getProc(env.catalog.getOperator(e.opOid)?.codeOid ?? 0);
  const strict = proc ? proc.strict : true;
  return (c) => {
    const l = left(c);
    const arr = right(c);
    if (arr === null) {
      return null;
    }
    let elems = arr as unknown[];
    if (elems.length > 0 && Array.isArray(elems[0])) {
      elems = (elems as unknown[][]).flat(Infinity as 1);
    }
    if (elems.length === 0) {
      return !useOr;
    }
    if (l === null && strict) {
      return null;
    }
    let sawNull = false;
    for (const el of elems) {
      if (el === null && strict) {
        sawNull = true;
        continue;
      }
      const r = op([l, el], c);
      if (r === null) {
        sawNull = true;
      } else if (useOr && r === true) {
        return true;
      } else if (!useOr && r === false) {
        return false;
      }
    }
    if (sawNull) {
      return null;
    }
    return !useOr;
  };
}

/**
 * The columns of the enclosing query level a correlated subquery reads, when its result depends on
 * nothing else that can change within the statement (no volatile functions, no references further
 * out, no outer aggregates or executor slots). Null when that cannot be established.
 */
function subqueryOuterColumns(query: Query): VarNode[] | null {
  if (query.commandType !== 'select' || query.hasModifyingCte || query.rowMarks.length > 0) {
    return null;
  }
  const refs = new Map<string, VarNode>();
  let ok = true;
  const visitExpr = (x: TExpr | null | undefined, depth: number): void => {
    if (!ok || !x) {
      return;
    }
    switch (x.k) {
      case 'var':
        if (x.levelsUp === depth + 1) {
          refs.set(`${x.rtIndex}:${x.attno}`, { ...x, levelsUp: 0 });
        } else if (x.levelsUp > depth + 1) {
          ok = false;
        }
        return;
      case 'agg':
      case 'window':
        if ((x as { levelsUp?: number }).levelsUp) {
          ok = false;
          return;
        }
        break;
      case 'execparam':
      case 'groupkey':
      case 'grouping':
        ok = false;
        return;
      case 'func':
        if (x.isUser || VOLATILE_FUNCS.has(x.funcName)) {
          ok = false;
          return;
        }
        break;
      case 'sublink':
        x.testLeft.forEach((t) => visitExpr(t, depth));
        visitQuery(x.subquery, depth + 1);
        return;
    }
    if (x.k === 'agg') {
      x.args.forEach((a) => visitExpr(a, depth));
      visitExpr(x.filter, depth);
      x.directArgs.forEach((a) => visitExpr(a, depth));
      x.order.forEach((o) => visitExpr(o.expr, depth));
      return;
    }
    forEachChild(x, (child) => visitExpr(child, depth));
  };
  const visitQuery = (q: Query, depth: number): void => {
    if (!ok) {
      return;
    }
    if (q.commandType !== 'select' || q.rowMarks.length > 0) {
      ok = false;
      return;
    }
    q.targetList.forEach((t) => visitExpr(t.expr, depth));
    visitExpr(q.where, depth);
    visitExpr(q.havingQual, depth);
    visitExpr(q.limitCount, depth);
    visitExpr(q.limitOffset, depth);
    for (const w of q.windowClause) {
      visitExpr(w.frame.start.offset, depth);
      visitExpr(w.frame.end.offset, depth);
    }
    const joins = (j: Query['fromlist'][number]) => {
      if (j.k === 'join') {
        visitExpr(j.quals, depth);
        joins(j.larg);
        joins(j.rarg);
      }
    };
    q.fromlist.forEach(joins);
    for (const rte of q.rtable) {
      if (!rte) {
        continue;
      }
      if (rte.kind === 'subquery') {
        visitQuery(rte.subquery, depth + 1);
      } else if (rte.kind === 'function') {
        rte.functions.forEach((f) => visitExpr(f.expr, depth));
      } else if (rte.kind === 'values') {
        rte.lists.forEach((row) => row.forEach((v) => visitExpr(v, depth)));
      } else if (rte.kind === 'join') {
        rte.aliasVars.forEach((v) => visitExpr(v, depth));
      } else if (rte.kind === 'cte' && rte.selfReference) {
        // a recursive CTE's working table changes between iterations
        ok = false;
        return;
      }
    }
    for (const cte of q.cteList) {
      if (cte.isModifying) {
        ok = false;
        return;
      }
      visitQuery(cte.query, depth + 1);
      if (cte.recursiveParts) {
        visitQuery(cte.recursiveParts.nonRecursive, depth + 1);
        visitQuery(cte.recursiveParts.recursive, depth + 1);
      }
    }
  };
  visitQuery(query, 0);
  return ok ? [...refs.values()] : null;
}

const VOLATILE_FUNCS = new Set(['random', 'nextval', 'setval', 'currval', 'lastval', 'pg_sleep', 'clock_timestamp', 'timeofday', 'gen_random_uuid', 'uuidv4', 'uuidv7', 'uuid_generate_v4', 'txid_current', 'pg_current_xact_id', 'pg_advisory_lock', 'pg_try_advisory_lock', 'pg_advisory_xact_lock', 'pg_try_advisory_xact_lock', 'pg_notify', 'set_config']);

/** entries a correlated subquery's memo holds per statement before it stops growing */
const SUBLINK_MEMO_LIMIT = 10000;
/** distinct outer keys seen before a memo that is (almost) never hit is switched off */
const SUBLINK_MEMO_PROBE = 256;

/**
 * Memo key of an outer value: equal only for values that are indistinguishable inside the subquery
 * (unlike a hash-equality key, 1.0 and 1.00, -0 and 0 or '1 day' and '24 hours' stay apart).
 */
function memoValueKey(typeOps: TypeOps, type: number, v: unknown): unknown {
  switch (typeof v) {
    case 'string':
    case 'boolean':
    case 'bigint':
      return v;
    case 'number':
      return Object.is(v, -0) ? '-0' : v;
  }
  if (v instanceof PgNumeric) {
    return 'n' + v.toString();
  }
  if (type === TypeOid.interval && v !== null && typeof v === 'object') {
    const iv = v as { months: number; days: number; us: number };
    return 'i' + iv.months + ':' + iv.days + ':' + iv.us;
  }
  return typeOps.hashKey(type, v);
}

const HASH_INT_TYPES = new Set<number>([TypeOid.int2, TypeOid.int4, TypeOid.int8]);
const HASH_INT_EQ = new Set(['int2eq', 'int4eq', 'int8eq', 'int24eq', 'int42eq', 'int28eq', 'int82eq', 'int48eq', 'int84eq']);
const HASH_SAME_TYPE_EQ = new Map<number, string>([
  [TypeOid.bool, 'booleq'],
  [TypeOid.text, 'texteq'],
  [TypeOid.uuid, 'uuid_eq'],
  [TypeOid.date, 'date_eq'],
  [TypeOid.timestamp, 'timestamp_eq'],
  [TypeOid.timestamptz, 'timestamp_eq'],
]);

/** `x = sub.col` whose equality is exactly hash-key equality (built-in integer / text / bool / uuid / datetime equality) */
function hashableSublinkEquality(o: SubLinkNode['operators'][number], env: CompileEnv): boolean {
  if (o.opName !== '=') {
    return false;
  }
  if (HASH_INT_TYPES.has(o.leftType) && HASH_INT_TYPES.has(o.rightType)) {
    return HASH_INT_EQ.has(o.opSrc);
  }
  if (o.leftType !== o.rightType || HASH_SAME_TYPE_EQ.get(o.leftType) !== o.opSrc) {
    return false;
  }
  return o.leftType !== TypeOid.text || !o.collation || env.typeOps.collations.isDeterministic(o.collation);
}

/**
 * Uncorrelated `x IN (SELECT …)` with a hashable equality: the sub-select's values go into a hash set
 * once per statement (like PostgreSQL's hashed SubPlan) instead of being compared row by row.
 */
function hashedAnySublink(e: SubLinkNode, left: Evaluator, env: CompileEnv, rowsOf: (c: EvalCtx) => unknown[][]): Evaluator {
  const o = e.operators[0];
  const intKeys = HASH_INT_TYPES.has(o.leftType);
  const typeOps = env.typeOps;
  const keyOf = (type: number, v: unknown): unknown => {
    if (intKeys) {
      return typeof v === 'bigint' ? (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString()) : v;
    }
    return typeOps.hashKey(type, v);
  };
  let forRows: unknown[][] | null = null;
  let keys: Set<unknown> = new Set();
  let sawNull = false;
  return (c) => {
    const l = left(c);
    const rows = rowsOf(c);
    if (rows !== forRows) {
      forRows = rows;
      keys = new Set();
      sawNull = false;
      for (const row of rows) {
        if (row[0] === null) {
          sawNull = true;
        } else {
          keys.add(keyOf(o.rightType, row[0]));
        }
      }
    }
    if (rows.length === 0) {
      return false;
    }
    if (l === null) {
      return null;
    }
    if (keys.has(keyOf(o.leftType, l))) {
      return true;
    }
    return sawNull ? null : false;
  };
}

interface SublinkMemo {
  root: Map<unknown, unknown>;
  size: number;
  hits: number;
  off: boolean;
}

function compileSublink(e: SubLinkNode, env: CompileEnv): Evaluator {
  const runner = env.runner;
  const query: Query = e.subquery;
  const id = e.id;
  const correlated = e.correlated;
  // A correlated subquery re-runs per outer row; within one statement (one snapshot) its result is a
  // function of the outer columns it reads, so repeated combinations are answered from a memo.
  const outerColumns = correlated ? subqueryOuterColumns(query) : null;
  const keyEvs = outerColumns ? outerColumns.map((v) => compileExpr(v, env)) : [];
  const keyTypes = outerColumns ? outerColumns.map((v) => v.type) : [];
  const memoKey = 'sublink-memo:' + id;
  const cached = (c: EvalCtx, compute: () => unknown): unknown => {
    if (correlated) {
      if (!outerColumns) {
        return compute();
      }
      let memo = c.st.scratch.get(memoKey) as SublinkMemo | undefined;
      if (!memo) {
        memo = { root: new Map(), size: 0, hits: 0, off: false };
        c.st.scratch.set(memoKey, memo);
      }
      if (memo.off) {
        return compute();
      }
      // a map per outer column (primitive keys, no composite key strings); the last level holds results
      const typeOps = env.typeOps;
      const last = keyEvs.length - 1;
      let map = memo.root;
      for (let i = 0; i < last; i++) {
        const k = memoValueKey(typeOps, keyTypes[i], keyEvs[i](c));
        let next = map.get(k) as Map<unknown, unknown> | undefined;
        if (!next) {
          next = new Map();
          map.set(k, next);
        }
        map = next;
      }
      const key = memoValueKey(typeOps, keyTypes[last], keyEvs[last](c));
      const hit = map.get(key);
      if (hit !== undefined || map.has(key)) {
        memo.hits++;
        return hit;
      }
      // outer values that (almost) never repeat: stop computing keys for the rest of the statement
      if (memo.size >= SUBLINK_MEMO_PROBE && memo.hits * 16 < memo.size) {
        memo.off = true;
        memo.root = new Map();
        return compute();
      }
      const v = compute();
      if (memo.size < SUBLINK_MEMO_LIMIT) {
        map.set(key, v);
        memo.size++;
      }
      return v;
    }
    const cache = c.st.initPlans;
    if (cache.has(id)) {
      return cache.get(id);
    }
    const v = compute();
    cache.set(id, v);
    return v;
  };
  switch (e.linkType) {
    case 'EXISTS':
      return (c) => cached(c, () => runner.run(query, c, 1).length > 0);
    case 'EXPR':
      return (c) =>
        cached(c, () => {
          const rows = runner.run(query, c, 2);
          if (rows.length > 1) {
            throw new PgError(SqlState.CARDINALITY_VIOLATION, 'more than one row returned by a subquery used as an expression');
          }
          return rows.length === 0 ? null : rows[0][0];
        });
    case 'MULTIEXPR':
      return (c) =>
        cached(c, () => {
          const rows = runner.run(query, c, 2);
          if (rows.length > 1) {
            throw new PgError(SqlState.CARDINALITY_VIOLATION, 'more than one row returned by a subquery used as an expression');
          }
          const visible = query.targetList.filter((t) => !t.resjunk);
          return new PgRecord(
            rows.length === 0 ? visible.map(() => null) : rows[0],
            TypeOid.record,
            visible.map((t) => t.expr.type),
            visible.map((t) => t.name)
          );
        });
    case 'ARRAY':
      return (c) =>
        cached(c, () => {
          const rows = runner.run(query, c);
          const vals = rows.map((r) => r[0]);
          if (vals.length > 0 && vals.some((v) => Array.isArray(v))) {
            for (const v of vals) {
              if (v === null) {
                throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'cannot accumulate null arrays');
              }
            }
            const len = (vals[0] as unknown[]).length;
            for (const v of vals) {
              if ((v as unknown[]).length !== len) {
                throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'cannot accumulate arrays of different dimensionality');
              }
            }
            if (len === 0) {
              return [];
            }
          }
          return vals;
        });
    case 'ANY':
    case 'ALL': {
      const lefts = e.testLeft.map((x) => compileExpr(x, env));
      const ops = e.operators.map((o, i) => operatorImpl(o.opName, o.opSrc, o.leftType, o.rightType, o.collation, env, e.testLeft[i]));
      const isAny = e.linkType === 'ANY';
      if (isAny && !correlated && e.testLeft.length === 1 && hashableSublinkEquality(e.operators[0], env)) {
        return hashedAnySublink(e, lefts[0], env, (c) => cached(c, () => runner.run(query, c)) as unknown[][]);
      }
      return (c) => {
        const lvals = lefts.map((l) => l(c));
        const rows = cached(c, () => runner.run(query, c)) as unknown[][];
        let sawNull = false;
        for (const row of rows) {
          let rowResult: boolean | null = true;
          for (let i = 0; i < ops.length; i++) {
            const x = lvals[i];
            const y = row[i];
            let r: unknown;
            if (x === null || y === null) {
              r = null;
            } else {
              r = ops[i]([x, y], c);
            }
            if (r === false) {
              rowResult = false;
              break;
            }
            if (r === null) {
              rowResult = null;
            }
          }
          if (isAny) {
            if (rowResult === true) {
              return true;
            }
            if (rowResult === null) {
              sawNull = true;
            }
          } else {
            if (rowResult === false) {
              return false;
            }
            if (rowResult === null) {
              sawNull = true;
            }
          }
        }
        if (sawNull) {
          return null;
        }
        return !isAny;
      };
    }
    case 'ROWCOMPARE': {
      const lefts = e.testLeft.map((x) => compileExpr(x, env));
      const opName = e.operators[0].opName;
      const ops = e.operators.map((o, i) => operatorImpl(o.opName, o.opSrc, o.leftType, o.rightType, o.collation, env, e.testLeft[i]));
      const cmps = e.operators.map((o) => env.typeOps.crossComparator(o.leftType, o.rightType, o.collation) ?? env.typeOps.comparator(o.leftType, o.collation));
      return (c) => {
        const lvals = lefts.map((l) => l(c));
        const rows = cached(c, () => runner.run(query, c, 2)) as unknown[][];
        if (rows.length > 1) {
          throw new PgError(SqlState.CARDINALITY_VIOLATION, 'more than one row returned by a subquery used as an expression');
        }
        if (rows.length === 0) {
          return null;
        }
        const row = rows[0];
        if (opName === '=' || opName === '<>') {
          // "=": all columns equal; "<>": any column differs
          const decisive = opName === '<>';
          let sawNull = false;
          for (let i = 0; i < ops.length; i++) {
            const r = lvals[i] === null || row[i] === null ? null : ops[i]([lvals[i], row[i]], c);
            if (r === null) {
              sawNull = true;
            } else if (r === decisive) {
              return decisive;
            }
          }
          return sawNull ? null : !decisive;
        }
        for (let i = 0; i < cmps.length; i++) {
          if (lvals[i] === null || row[i] === null) {
            return null;
          }
          const r = cmps[i](lvals[i], row[i]);
          if (r !== 0) {
            return opName === '<' || opName === '<=' ? r < 0 : r > 0;
          }
        }
        return opName === '<=' || opName === '>=';
      };
    }
    default:
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `sublink ${e.linkType} not supported`);
  }
}

function compileDomainCoerce(argNode: TExpr, domainOid: number, env: CompileEnv): Evaluator {
  const arg = compileExpr(argNode, env);
  return (c) => {
    const v = arg(c);
    const t = c.st.catalog.getType(domainOid);
    if (!t) {
      return v;
    }
    if (v === null && t.domainNotNull) {
      throw new PgError(SqlState.NOT_NULL_VIOLATION, `domain ${t.name} does not allow null values`, { dataType: t.name });
    }
    if (t.domainChecks && t.domainChecks.length > 0 && v !== null) {
      for (const chk of c.st.session.domainChecks(t)) {
        const params = c.st.execParams;
        const saved = params[chk.slot];
        params[chk.slot] = v;
        let r: unknown;
        try {
          r = chk.ev(c);
        } finally {
          params[chk.slot] = saved;
        }
        if (r === false) {
          throw new PgError(SqlState.CHECK_VIOLATION, `value for domain ${t.name} violates check constraint "${chk.name}"`, { dataType: t.name, constraint: chk.name });
        }
      }
    }
    return v;
  };
}

function compileSubscript(e: TExpr & { k: 'subscript' }, env: CompileEnv): Evaluator {
  const arg = compileExpr(e.arg, env);
  const upper = e.upper.map((u) => (u ? compileExpr(u, env) : null));
  const lower = e.lower ? e.lower.map((l) => (l ? compileExpr(l, env) : null)) : null;
  if (e.isJsonb) {
    const keyTypes = e.upper.map((u) => u!.type);
    return (c) => {
      let v = arg(c) as JsonbValue | null;
      for (let i = 0; i < upper.length; i++) {
        if (v === null) {
          return null;
        }
        const k = upper[i]!(c);
        if (k === null) {
          return null;
        }
        if (Array.isArray(v)) {
          let idx: number;
          if (keyTypes[i] === TypeOid.int4) {
            idx = k as number;
          } else {
            const s = String(k);
            if (!/^-?\d+$/.test(s)) {
              return null;
            }
            idx = parseInt(s, 10);
          }
          if (idx < 0) {
            idx += v.length;
          }
          v = idx >= 0 && idx < v.length ? v[idx] : null;
        } else if (v instanceof JsonbObject) {
          if (keyTypes[i] === TypeOid.int4) {
            return null;
          }
          const got = v.get(String(k));
          v = got === undefined ? null : got;
        } else {
          return null;
        }
      }
      return v === JNULL ? JNULL : v;
    };
  }
  if (!e.isSlice) {
    return (c) => {
      let v = arg(c) as unknown;
      for (const u of upper) {
        if (v === null) {
          return null;
        }
        const idx = u!(c);
        if (idx === null) {
          return null;
        }
        const arr = v as unknown[];
        const lb = arrayLowerBound(arr);
        const pos = (idx as number) - lb;
        if (pos < 0 || pos >= arr.length) {
          return null;
        }
        v = arr[pos];
        if (v === undefined) {
          return null;
        }
      }
      return v;
    };
  }
  return (c) => {
    const v = arg(c) as unknown[] | null;
    if (v === null) {
      return null;
    }
    if (upper.length !== 1) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'multi-dimensional array slices are not supported by the in-memory engine');
    }
    const lb = arrayLowerBound(v);
    const lo = lower![0] ? (lower![0]!(c) as number | null) : lb;
    const hi = upper[0] ? (upper[0]!(c) as number | null) : lb + v.length - 1;
    if (lo === null || hi === null) {
      return null;
    }
    const from = Math.max(lo, lb) - lb;
    const to = Math.min(hi, lb + v.length - 1) - lb;
    if (from > to) {
      return [];
    }
    return v.slice(from, to + 1);
  };
}

function compileSqlValue(op: string, typmod: number): Evaluator {
  const round = (us: number) => {
    if (typmod < 0 || typmod >= 6) {
      return us;
    }
    const scale = 10 ** (6 - typmod);
    return Math.round(us / scale) * scale;
  };
  switch (op) {
    case 'CURRENT_DATE':
      return (c) => {
        const ts = c.st.session.transactionTimestamp();
        const off = zoneOffsetAt(c.st.session.io.zone, ts);
        return Math.floor((ts + off * USECS_PER_SEC) / USECS_PER_DAY);
      };
    case 'CURRENT_TIMESTAMP':
    case 'CURRENT_TIMESTAMP_N':
      return (c) => round(c.st.session.transactionTimestamp());
    case 'LOCALTIMESTAMP':
    case 'LOCALTIMESTAMP_N':
      return (c) => {
        const ts = c.st.session.transactionTimestamp();
        return round(ts + zoneOffsetAt(c.st.session.io.zone, ts) * USECS_PER_SEC);
      };
    case 'CURRENT_TIME':
    case 'CURRENT_TIME_N':
      return (c) => {
        const ts = c.st.session.transactionTimestamp();
        const off = zoneOffsetAt(c.st.session.io.zone, ts);
        const local = ts + off * USECS_PER_SEC;
        return { us: round(((local % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY), zone: -off };
      };
    case 'LOCALTIME':
    case 'LOCALTIME_N':
      return (c) => {
        const ts = c.st.session.transactionTimestamp();
        const local = ts + zoneOffsetAt(c.st.session.io.zone, ts) * USECS_PER_SEC;
        return round(((local % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY);
      };
    case 'CURRENT_CATALOG':
      return (c) => c.st.session.databaseName;
    case 'CURRENT_SCHEMA':
      return (c) => c.st.session.getSetting('__current_schema', true);
    default:
      return (c) => c.st.session.userName;
  }
}

export { PgNumeric };
