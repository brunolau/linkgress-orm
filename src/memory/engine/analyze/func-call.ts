import type * as A from '../ast';
import { COLL_DEFAULT, ProcDef, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { SqlParser } from '../parser-ddl';
import type { Analyzer } from './analyzer';
import { transformExprRecurse, coerceArg } from './expr';
import { AggNode, FuncNode, SortClauseItem, TExpr, WindowFuncNode } from './nodes';
import { atPosition, exprLocation, positioned } from './location';
import { ParseState } from './parse-state';
import { FuncCandidate, resolveFunction } from './resolve';
import { findOrCreateWindowClause } from './select';
import { isPolymorphic } from './typeutil';
import { forEachChild } from './walk';

const AGG_FORBIDDEN: Record<string, string> = {
  where: 'WHERE',
  join_on: 'JOIN conditions',
  join_using: 'JOIN conditions',
  group_by: 'GROUP BY',
  values: 'VALUES',
  values_single: 'VALUES',
  filter: 'FILTER',
  limit: 'LIMIT',
  offset: 'OFFSET',
  returning: 'RETURNING',
  update_source: 'UPDATE',
  check_constraint: 'check constraints',
  domain_check: 'check constraints',
  column_default: 'DEFAULT expressions',
  function_default: 'DEFAULT expressions',
  index_expression: 'index expressions',
  index_predicate: 'index predicates',
  partition_expression: 'partition key expressions',
  from_function: 'functions in FROM',
  from_subselect: 'FROM clause of their own query level',
  window_partition: 'window PARTITION BY',
  window_frame: 'window RANGE',
  insert_target: 'INSERT',
  merge_when: 'MERGE WHEN conditions',
  partition_bound: 'partition bound',
  generated_column: 'column generation expressions',
  call_argument: 'CALL arguments',
  execute_parameter: 'EXECUTE parameters',
  alter_col_transform: 'transform expressions',
  trigger_when: 'trigger WHEN conditions',
};

const WINDOW_ALLOWED = new Set(['select', 'order_by']);

function displayArgTypes(an: Analyzer, types: number[]): string {
  return types.map((t) => an.types.formatType(t, -1, false)).join(', ');
}

export function transformFuncCall(an: Analyzer, pstate: ParseState, node: A.FuncCall): TExpr {
  // MERGE_ACTION() (MergeSupportFunc)
  if (node.name.length === 1 && node.name[0] === 'merge_action' && node.args.length === 0 && !node.aggStar && !node.over) {
    let p: ParseState | null = pstate;
    while (p && !(p.exprKind === 'returning' && p.query.commandType === 'merge')) {
      p = p.parent;
    }
    if (!p) {
      throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'MERGE_ACTION() can only be used in the RETURNING list of a MERGE command'), node.loc);
    }
    return {
      k: 'func',
      funcOid: 0,
      funcName: 'merge_action',
      funcSrc: '__linkgress_merge_action',
      args: [],
      type: TypeOid.text,
      typmod: -1,
      collation: COLL_DEFAULT,
      inputCollation: 0,
      retset: false,
      format: 'call',
      variadic: false,
      strict: false,
    };
  }
  // arguments
  const args: TExpr[] = [];
  for (const a of node.args) {
    args.push(transformExprRecurse(an, pstate, a));
  }
  if (node.aggWithinGroup) {
    // an ordered-set aggregate's WITHIN GROUP expressions are arguments after the direct ones
    for (const s of node.aggOrder) {
      const e = transformExprRecurse(an, pstate, s.node);
      args.push(e.type === TypeOid.unknown ? an.resolveUnknownToText(e) : e);
    }
  }
  const result = atPosition(node.loc, () => parseFuncOrColumn(an, pstate, node, args));
  if (node.special && result.k === 'func' && result.format === 'call') {
    // COERCE_SQL_SYNTAX: deparsed back as EXTRACT(... FROM ...), x AT TIME ZONE z, TRIM(...), ...
    result.format = 'sql_syntax';
  }
  return result;
}

function parseDefaults(proc: ProcDef): A.Expr[] {
  if (proc.argdefaults) {
    return proc.argdefaults;
  }
  if (!proc.argdefaultsText) {
    return [];
  }
  const parser = new SqlParser('SELECT ' + proc.argdefaultsText);
  const stmt = parser.parseSelectStatement();
  proc.argdefaults = stmt.targetList.map((t) => t.val);
  return proc.argdefaults;
}

/** transformCallStmt: the procedure invocation of a CALL, arguments resolved like a function call */
export function transformProcedureCall(an: Analyzer, pstate: ParseState, node: A.FuncCall): TExpr {
  const saved = pstate.exprKind;
  pstate.exprKind = 'call_argument';
  try {
    const args = node.args.map((a) => transformExprRecurse(an, pstate, a));
    try {
      return atPosition(node.loc, () => parseFuncOrColumn(an, pstate, node, args, true));
    } catch (e) {
      if (e instanceof PgError && (e.code === SqlState.UNDEFINED_FUNCTION || e.code === SqlState.AMBIGUOUS_FUNCTION) && e.message.startsWith('function ')) {
        throw new PgError(e.code, 'procedure ' + e.message.slice('function '.length), { ...e, hint: e.hint?.replace(/function/g, 'procedure') });
      }
      throw e;
    }
  } finally {
    pstate.exprKind = saved;
  }
}

export function parseFuncOrColumn(an: Analyzer, pstate: ParseState, node: A.FuncCall, args: TExpr[], procCall = false): TExpr {
  const names = node.name;
  const isAggDecorated = node.aggStar || node.aggDistinct || node.aggOrder.length > 0 || node.aggFilter !== null || node.aggWithinGroup;
  const argTypes = args.map((a) => a.type);
  const argNames = node.argNames;

  let cand: FuncCandidate | { coercionTo: number };
  cand = resolveFunction(an, names, argTypes, argNames, node.funcVariadic, () => displayArgTypes(an, argTypes));
  if ('coercionTo' in cand) {
    const target = cand.coercionTo;
    const src = args[0];
    let isCoercion = false;
    if (src.type === TypeOid.unknown && src.k === 'const') {
      isCoercion = true;
    } else {
      const path = an.types.findCoercionPathway(target, src.type, 'explicit');
      if (path.kind === 'relabel') {
        isCoercion = true;
      } else if (path.kind === 'io') {
        isCoercion = !((src.type === TypeOid.record || an.types.isComposite(src.type)) && an.types.category(target) === 'S');
      }
    }
    if (isCoercion && !isAggDecorated && !node.over) {
      const r = an.coerceToTargetType(src, target, -1, 'explicit', 'explicit_cast');
      if (r) {
        return r;
      }
    }
    // not a coercion: resolve as a regular function (excluding the coercion shortcut)
    cand = resolveWithoutCoercion(an, names, argTypes, argNames, node.funcVariadic);
  }
  const proc = cand.proc;

  // kind checks
  if (proc.kind !== 'a' && proc.kind !== 'w') {
    if (node.aggStar) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `${names.join('.')}(*) specified, but ${proc.name} is not an aggregate function`);
    }
    if (node.aggDistinct) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `DISTINCT specified, but ${proc.name} is not an aggregate function`);
    }
    if (node.aggWithinGroup) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `WITHIN GROUP specified, but ${proc.name} is not an aggregate function`);
    }
    if (node.aggOrder.length > 0) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `ORDER BY specified, but ${proc.name} is not an aggregate function`);
    }
    if (node.aggFilter) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `FILTER specified, but ${proc.name} is not an aggregate function`);
    }
    if (node.over) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `OVER specified, but ${proc.name} is not a window function nor an aggregate function`);
    }
    if (proc.kind === 'p' && !procCall) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `${names.join('.')}(${displayArgTypes(an, argTypes)}) is a procedure`, {
        hint: 'To call a procedure, use CALL.',
      });
    }
  }
  if (procCall && proc.kind !== 'p') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `${names.join('.')}(${displayArgTypes(an, argTypes)}) is not a procedure`, {
      hint: 'To call a function, use SELECT.',
    });
  }
  if (proc.kind === 'w' && !node.over) {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `window function ${proc.name} requires an OVER clause`);
  }

  // argument list assembly: named notation reorder, defaults, variadic
  let finalArgs = args.slice();
  let declared = cand.args.slice();
  if (cand.argnumbers) {
    const pronargs = proc.argtypes.length;
    const ordered: (TExpr | null)[] = new Array(pronargs).fill(null);
    cand.argnumbers.forEach((pos, i) => {
      ordered[pos] = args[i];
    });
    const defaults = parseDefaults(proc);
    const firstDefault = pronargs - defaults.length;
    for (let i = 0; i < pronargs; i++) {
      if (ordered[i] === null) {
        ordered[i] = transformExprRecurse(an, pstate, defaults[i - firstDefault]);
      }
    }
    finalArgs = ordered as TExpr[];
    declared = proc.argtypes.slice();
  } else if (cand.ndargs > 0) {
    const defaults = parseDefaults(proc);
    const needed = defaults.slice(defaults.length - cand.ndargs);
    for (const d of needed) {
      finalArgs.push(transformExprRecurse(an, pstate, d));
    }
    declared = proc.argtypes.slice();
  }

  const actualTypes = finalArgs.map((a) => a.type);
  const resolved = an.types.resolvePolymorphic(actualTypes, declared, proc.rettype);
  let rettype = resolved.rettype;
  const declaredResolved = resolved.argTypes;

  // variadic packaging
  let variadic = false;
  if (cand.nvargs > 0 && proc.variadic !== TypeOid.any) {
    const pronargs = proc.argtypes.length;
    const fixed = finalArgs.slice(0, pronargs - 1).map((a, i) => coerceArg(an, a, declaredResolved[i]));
    const vaElem = declaredResolved[pronargs - 1];
    const vaArgs = finalArgs.slice(pronargs - 1).map((a, i) => coerceArg(an, a, declaredResolved[pronargs - 1 + i]));
    const arrType = an.types.arrayTypeOf(vaElem);
    finalArgs = [...fixed, { k: 'array', elements: vaArgs, elemType: vaElem, multidims: false, type: arrType, typmod: -1, collation: an.typeCollation(vaElem) }];
  } else {
    finalArgs = finalArgs.map((a, i) => {
      const target = declaredResolved[i];
      if (target === TypeOid.any) {
        return a;
      }
      return coerceArg(an, a, target);
    });
    if (node.funcVariadic) {
      variadic = true;
      if (proc.variadic === 0) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, 'VARIADIC argument must be an array');
      }
    }
  }

  // output collation
  const inputCollation = mergeArgCollations(finalArgs);
  const rtype = an.catalog.getType(an.types.baseType(rettype));
  const collation = rtype && rtype.collation ? inputCollation || rtype.collation : 0;

  if (proc.kind === 'a' || (proc.kind === 'w' && node.over)) {
    if (node.over) {
      return makeWindowFunc(an, pstate, node, proc, finalArgs, declaredResolved, rettype, collation, inputCollation);
    }
    return makeAggregate(an, pstate, node, proc, finalArgs, declaredResolved, rettype, collation, inputCollation);
  }

  if (proc.retset) {
    checkSrfAllowed(an, pstate);
  }

  if (rettype === TypeOid.record && proc.allargtypes && proc.argmodes && proc.argmodes.some((m) => m === 'o' || m === 'b' || m === 't')) {
    rettype = TypeOid.record;
  }
  if (isPolymorphic(rettype)) {
    // enforce_generic_type_consistency reports no position
    throw new PgError(SqlState.DATATYPE_MISMATCH, 'could not determine polymorphic type because input has type unknown', { noPosition: true });
  }
  const fn: FuncNode = {
    k: 'func',
    funcOid: proc.oid,
    funcName: proc.name,
    funcSrc: proc.src,
    args: finalArgs,
    type: rettype,
    typmod: -1,
    collation,
    inputCollation,
    retset: proc.retset,
    format: 'call',
    variadic,
    strict: proc.strict,
    isUser: !proc.isBuiltin,
  };
  return fn;
}

function resolveWithoutCoercion(an: Analyzer, names: string[], argTypes: number[], argNames: (string | undefined)[] | undefined, funcVariadic: boolean): FuncCandidate {
  const fake = resolveFunction(an, names, argTypes, argNames, funcVariadic, () => displayArgTypes(an, argTypes), false);
  if ('coercionTo' in fake) {
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `function ${names.join('.')}(${displayArgTypes(an, argTypes)}) does not exist`, {
      hint: 'No function matches the given name and argument types. You might need to add explicit type casts.',
    });
  }
  return fake;
}

function mergeArgCollations(args: TExpr[]): number {
  for (const a of args) {
    if (a.k === 'collate') {
      return a.collation;
    }
  }
  for (const a of args) {
    if (a.collation) {
      return a.collation;
    }
  }
  return 0;
}

export function checkSrfAllowed(an: Analyzer, pstate: ParseState): void {
  const kind = pstate.exprKind;
  const forbidden: Record<string, string> = {
    where: 'WHERE',
    join_on: 'JOIN conditions',
    having: 'HAVING',
    filter: 'FILTER',
    group_by: 'GROUP BY',
    order_by: 'ORDER BY',
    limit: 'LIMIT',
    offset: 'OFFSET',
    check_constraint: 'check constraints',
    domain_check: 'check constraints',
    column_default: 'DEFAULT expressions',
    index_expression: 'index expressions',
    index_predicate: 'index predicates',
    partition_expression: 'partition key expressions',
    values: 'VALUES',
    values_single: 'VALUES',
    window_partition: 'window definitions',
    window_order: 'window definitions',
    execute_parameter: 'EXECUTE parameters',
    generated_column: 'column generation expressions',
    call_argument: 'CALL arguments',
    alter_col_transform: 'transform expressions',
  };
  if (forbidden[kind]) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `set-returning functions are not allowed in ${forbidden[kind]}`, {
      hint: kind === 'values' || kind === 'values_single' ? undefined : undefined,
    });
  }
  if (kind === 'select' || kind === 'returning' || kind === 'update_source' || kind === 'insert_target' || kind === 'distinct_on') {
    pstate.hasTargetSRFs = true;
  }
  void an;
}

/** locate_agg_of_level: the location of the first aggregate (or window function) inside an expression */
function innerAggLocation(e: TExpr): number | undefined {
  let loc: number | undefined;
  const visit = (x: TExpr) => {
    if (loc !== undefined) {
      return;
    }
    if ((x.k === 'agg' && x.levelsUp === 0) || x.k === 'window') {
      loc = exprLocation(x);
      return;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return loc;
}

function containsAgg(e: TExpr): boolean {
  let found = false;
  const visit = (x: TExpr) => {
    if (found) {
      return;
    }
    if (x.k === 'agg' && x.levelsUp === 0) {
      found = true;
      return;
    }
    if (x.k === 'window') {
      found = true;
      return;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return found;
}

function makeAggregate(
  an: Analyzer,
  pstate: ParseState,
  node: A.FuncCall,
  proc: ProcDef,
  args: TExpr[],
  argTypes: number[],
  rettype: number,
  collation: number,
  inputCollation: number
): TExpr {
  const kind = pstate.exprKind;
  if (AGG_FORBIDDEN[kind]) {
    throw new PgError(SqlState.GROUPING_ERROR, `aggregate functions are not allowed in ${AGG_FORBIDDEN[kind]}`);
  }
  const aggDef = an.catalog.builtin.aggregates.get(proc.oid);
  const aggKind = (aggDef?.kind ?? 'n') as 'n' | 'o' | 'h';
  for (const a of args) {
    if (containsAgg(a)) {
      throw positioned(new PgError(SqlState.GROUPING_ERROR, 'aggregate function calls cannot be nested'), innerAggLocation(a));
    }
  }
  let order: SortClauseItem[] = [];
  let directArgs: TExpr[] = [];
  let aggArgs = args;
  if (node.aggWithinGroup) {
    if (aggKind === 'n') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `WITHIN GROUP specified, but ${proc.name} is not an ordered-set aggregate`);
    }
    // the aggregated arguments were resolved (and coerced) after the direct ones
    const ndirect = args.length - node.aggOrder.length;
    directArgs = args.slice(0, ndirect);
    aggArgs = args.slice(ndirect);
    order = node.aggOrder.map((s, i) => {
      const desc = s.dir === 'DESC' || (s.dir === 'USING' && s.useOp?.[s.useOp.length - 1] === '>');
      return { expr: aggArgs[i], desc, nullsFirst: s.nulls === 'DEFAULT' ? desc : s.nulls === 'FIRST', useOpName: s.dir === 'USING' ? s.useOp![s.useOp!.length - 1] : undefined };
    });
  } else {
    if (aggKind !== 'n') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `WITHIN GROUP is required for ordered-set aggregate ${proc.name}`);
    }
    order = node.aggOrder.map((s) => sortItem(an, pstate, s));
    if (node.aggDistinct && order.length > 0) {
      for (const o of order) {
        if (!args.some((a) => exprEqualLoose(a, o.expr))) {
          throw positioned(new PgError(SqlState.INVALID_COLUMN_REFERENCE, 'in an aggregate with DISTINCT, ORDER BY expressions must appear in argument list'), exprLocation(o.expr));
        }
      }
    }
  }
  let filter: TExpr | null = null;
  if (node.aggFilter) {
    const saved = pstate.exprKind;
    pstate.exprKind = 'filter';
    try {
      filter = an.coerceToBoolean(pstate, transformExprRecurse(an, pstate, node.aggFilter), 'FILTER');
    } finally {
      pstate.exprKind = saved;
    }
  }
  if (node.aggStar && args.length > 0) {
    throw new PgError(SqlState.SYNTAX_ERROR, 'aggregate star with arguments');
  }
  const agg: AggNode = {
    k: 'agg',
    aggOid: proc.oid,
    aggName: proc.name,
    aggKind,
    transSrc: aggDef?.transSrc ?? proc.name,
    args: aggArgs,
    argTypes,
    directArgs,
    distinct: node.aggDistinct,
    star: node.aggStar,
    order,
    filter,
    levelsUp: 0,
    aggIndex: pstate.query.aggs.length,
    variadic: node.funcVariadic,
    isUser: !proc.isBuiltin,
    type: rettype,
    typmod: -1,
    collation,
    inputCollation,
  };
  pstate.query.aggs.push(agg);
  pstate.query.hasAggs = true;
  return agg;
}

function exprEqualLoose(a: TExpr, b: TExpr): boolean {
  return JSON.stringify(stripLoc(a)) === JSON.stringify(stripLoc(b));
}

function stripLoc(e: unknown): unknown {
  return JSON.parse(
    JSON.stringify(e, (k, v) => (k === 'location' || k === 'aggIndex' ? undefined : typeof v === 'bigint' ? v.toString() : v))
  );
}

export function sortItem(an: Analyzer, pstate: ParseState, s: A.SortBy): SortClauseItem {
  const expr = transformExprRecurse(an, pstate, s.node);
  const e = expr.type === TypeOid.unknown ? an.resolveUnknownToText(expr) : expr;
  const desc = s.dir === 'DESC' || (s.dir === 'USING' && s.useOp?.[s.useOp.length - 1] === '>');
  const nullsFirst = s.nulls === 'DEFAULT' ? desc : s.nulls === 'FIRST';
  return { expr: e, desc, nullsFirst, useOpName: s.dir === 'USING' ? s.useOp![s.useOp!.length - 1] : undefined };
}

function makeWindowFunc(
  an: Analyzer,
  pstate: ParseState,
  node: A.FuncCall,
  proc: ProcDef,
  args: TExpr[],
  argTypes: number[],
  rettype: number,
  collation: number,
  inputCollation: number
): TExpr {
  if (!WINDOW_ALLOWED.has(pstate.exprKind)) {
    const kindName = AGG_FORBIDDEN[pstate.exprKind] ?? an.exprKindName(pstate.exprKind);
    throw new PgError(SqlState.WINDOWING_ERROR, `window functions are not allowed in ${kindName}`);
  }
  if (node.aggDistinct) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'DISTINCT is not implemented for window functions');
  }
  if (node.aggOrder.length > 0) {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, 'aggregate ORDER BY is not implemented for window functions');
  }
  if (node.aggWithinGroup) {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `OVER is not supported for ordered-set aggregate ${proc.name}`);
  }
  for (const a of args) {
    if (containsAgg(a) && a.k === 'window') {
      throw new PgError(SqlState.WINDOWING_ERROR, 'window function calls cannot be nested');
    }
  }
  let filter: TExpr | null = null;
  if (node.aggFilter) {
    if (proc.kind !== 'a') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, 'FILTER is not implemented for non-aggregate window functions');
    }
    filter = an.coerceToBoolean(pstate, transformExprRecurse(an, pstate, node.aggFilter), 'FILTER');
  }
  const winRef = findOrCreateWindowClause(an, pstate, node.over!);
  const aggDef = an.catalog.builtin.aggregates.get(proc.oid);
  const wf: WindowFuncNode = {
    k: 'window',
    funcOid: proc.oid,
    funcName: proc.name,
    funcSrc: proc.kind === 'a' ? aggDef?.transSrc ?? proc.name : proc.src,
    args,
    argTypes,
    filter,
    star: node.aggStar,
    distinct: false,
    winRef,
    isAgg: proc.kind === 'a',
    aggKind: aggDef?.kind as 'n' | undefined,
    winIndex: pstate.query.windowFuncs.length,
    type: rettype,
    typmod: -1,
    collation,
    inputCollation,
  };
  pstate.query.windowFuncs.push(wf);
  pstate.query.hasWindowFuncs = true;
  return wf;
}
