import type * as A from '../ast';
import { Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { varForColumn } from './colref';
import { coerceArg, makeOp, transformExpr } from './expr';
import {
  CatalogRTE,
  CteEntry,
  CteRTE,
  FunctionRTE,
  JoinNode,
  JoinRTE,
  JoinTreeNode,
  RangeFunctionItem,
  RelationRTE,
  RTE,
  SubqueryRTE,
  TExpr,
  TypeInfo,
} from './nodes';
import { NsItem, ParseState } from './parse-state';
import { analyzeSelectStmt, analyzeStatementAsSubquery } from './select';
import { atPosition } from './location';

export interface FromResult {
  node: JoinTreeNode;
  /** namespace items this FROM item contributes */
  namespace: NsItem[];
  rtIndex: number;
}

export function addRte(pstate: ParseState, rte: RTE): number {
  pstate.query.rtable.push(rte);
  return pstate.query.rtable.length - 1;
}

function makeNsItem(rtIndex: number, rte: RTE): NsItem {
  return { rtIndex, rte, relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true };
}

/** transformFromClause: processes the FROM list, adding to pstate.namespace. */
export function transformFromClause(an: Analyzer, pstate: ParseState, items: A.FromItem[]): void {
  for (const item of items) {
    const res = transformFromItem(an, pstate, item);
    // items already in namespace become lateral-visible for subsequent LATERAL items
    for (const ns of res.namespace) {
      pstate.namespace.push(ns);
    }
    pstate.query.fromlist.push(res.node);
  }
  // after processing, all items are ordinary (not lateral-only)
  for (const ns of pstate.namespace) {
    ns.lateralOnly = false;
    ns.lateralOk = true;
  }
}

/** Temporarily hide (non-lateral) current namespace items while analyzing a FROM item. */
function withLateralVisibility<T>(pstate: ParseState, lateral: boolean, fn: () => T): T {
  const savedActive = pstate.lateralActive;
  const saved = pstate.namespace.map((n) => [n.lateralOnly, n.lateralOk] as const);
  for (const n of pstate.namespace) {
    n.lateralOnly = true;
    n.lateralOk = lateral;
  }
  pstate.lateralActive = lateral;
  try {
    return fn();
  } finally {
    pstate.lateralActive = savedActive;
    pstate.namespace.forEach((n, i) => {
      n.lateralOnly = saved[i][0];
      n.lateralOk = saved[i][1];
    });
  }
}

export function transformFromItem(an: Analyzer, pstate: ParseState, item: A.FromItem): FromResult {
  switch (item.kind) {
    case 'RangeVar':
      return transformRangeVar(an, pstate, item);
    case 'RangeSubselect': {
      const rte = withLateralVisibility(pstate, item.lateral, () => {
        const { query } = analyzeStatementAsSubquery(an, item.subquery, pstate, true);
        const targets = query.targetList.filter((t) => !t.resjunk);
        const colnames = targets.map((t) => t.name);
        if (item.alias?.colnames) {
          if (item.alias.colnames.length > colnames.length) {
            throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, `table "${item.alias.name}" has ${colnames.length} columns available but ${item.alias.colnames.length} columns specified`);
          }
          item.alias.colnames.forEach((c, i) => (colnames[i] = c));
        }
        const r: SubqueryRTE = {
          kind: 'subquery',
          subquery: query,
          alias: item.alias?.name,
          userColnames: !!item.alias?.colnames?.length,
          eref: { aliasname: item.alias?.name ?? 'unnamed_subquery', colnames },
          colTypes: targets.map((t) => ({ type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
          lateral: item.lateral,
        };
        return r;
      });
      const rtIndex = addRte(pstate, rte);
      const ns = makeNsItem(rtIndex, rte);
      if (!item.alias) {
        ns.relVisible = false;
      }
      return { node: { k: 'ref', rtIndex }, namespace: [ns], rtIndex };
    }
    case 'RangeFunction': {
      const rte = withLateralVisibility(pstate, true, () => transformRangeFunction(an, pstate, item));
      const rtIndex = addRte(pstate, rte);
      return { node: { k: 'ref', rtIndex }, namespace: [makeNsItem(rtIndex, rte)], rtIndex };
    }
    case 'JoinExpr':
      return transformJoin(an, pstate, item);
  }
}

function checkAliasColumns(alias: A.Alias | undefined, colnames: string[], relname: string): string[] {
  const out = colnames.slice();
  if (alias?.colnames) {
    if (alias.colnames.length > out.length) {
      throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, `table "${alias.name ?? relname}" has ${out.length} columns available but ${alias.colnames.length} columns specified`);
    }
    alias.colnames.forEach((c, i) => (out[i] = c));
  }
  return out;
}

function findCte(pstate: ParseState, name: string): { cte: CteEntry; levelsUp: number } | null {
  let ps: ParseState | null = pstate;
  let levelsUp = 0;
  while (ps) {
    for (const c of ps.ctes) {
      if (c.name === name) {
        return { cte: c, levelsUp };
      }
    }
    if (ps.pendingRecursiveCte && ps.pendingRecursiveCte.name === name) {
      return { cte: ps.pendingRecursiveCte, levelsUp };
    }
    ps = ps.parent;
    levelsUp++;
  }
  return null;
}

export function lookupRelation(an: Analyzer, rv: { schema?: string; catalog?: string; name: string }, missingOk = false): Relation | null {
  if (rv.catalog && rv.catalog !== an.env.databaseName) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cross-database references are not implemented: "${rv.catalog}.${rv.schema}.${rv.name}"`);
  }
  if (rv.schema) {
    const ns = rv.schema === 'pg_temp' ? { oid: an.env.tempNamespace(false) } : an.catalog.findNamespace(rv.schema);
    if (!ns || !ns.oid) {
      if (missingOk) {
        return null;
      }
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${rv.schema}" does not exist`);
    }
    const rel = an.catalog.findRelationInNamespace(ns.oid, rv.name);
    if (!rel && !missingOk) {
      throw new PgError(SqlState.UNDEFINED_TABLE, `relation "${rv.schema}.${rv.name}" does not exist`);
    }
    return rel ?? null;
  }
  for (const nsOid of an.env.relationSearchPath()) {
    const rel = an.catalog.findRelationInNamespace(nsOid, rv.name);
    if (rel) {
      return rel;
    }
  }
  if (missingOk) {
    return null;
  }
  throw new PgError(SqlState.UNDEFINED_TABLE, `relation "${rv.name}" does not exist`);
}

function transformRangeVar(an: Analyzer, pstate: ParseState, rv: A.RangeVar): FromResult {
  if (!rv.schema) {
    const c = findCte(pstate, rv.name);
    if (c) {
      const cte = c.cte;
      const selfReference = pstate.pendingRecursiveCte === cte || isSelfReference(pstate, cte);
      if (!selfReference) {
        cte.refCount++;
      }
      const colnames = checkAliasColumns(rv.alias, cte.colNames, rv.name);
      const rte: CteRTE = {
        kind: 'cte',
        ctename: cte.name,
        levelsUp: c.levelsUp,
        selfReference,
        cte,
        alias: rv.alias?.name,
        eref: { aliasname: rv.alias?.name ?? rv.name, colnames },
        colTypes: cte.colTypes,
        lateral: false,
        userColnames: !!rv.alias?.colnames?.length,
      };
      const rtIndex = addRte(pstate, rte);
      return { node: { k: 'ref', rtIndex }, namespace: [makeNsItem(rtIndex, rte)], rtIndex };
    }
    // scanNameSpaceForENR: a transition table of the trigger function running this statement
    const enr = an.transitionTables?.find((t) => t.name === rv.name);
    if (enr) {
      const live = enr.rel.columns.filter((c) => !c.isDropped);
      const rte: CatalogRTE = {
        kind: 'catalog',
        relOid: enr.rel.oid,
        relname: enr.name,
        nspname: '',
        alias: rv.alias?.name,
        eref: { aliasname: rv.alias?.name ?? enr.name, colnames: checkAliasColumns(rv.alias, live.map((c) => c.name), enr.name) },
        colTypes: live.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })),
        lateral: false,
        transitionName: enr.name,
        rowTypeOid: enr.rel.rowTypeOid || undefined,
      };
      const rtIndex = addRte(pstate, rte);
      return { node: { k: 'ref', rtIndex }, namespace: [makeNsItem(rtIndex, rte)], rtIndex };
    }
  }
  // parserOpenTable: a missing relation is reported at its reference
  const rel = atPosition(rv.loc, () => lookupRelation(an, rv)!);
  const rtIndex = addRelationRte(an, pstate, rel, rv.alias, rv.inh, rv.name);
  const rte = pstate.query.rtable[rtIndex];
  return { node: { k: 'ref', rtIndex }, namespace: [makeNsItem(rtIndex, rte)], rtIndex };
}

function isSelfReference(pstate: ParseState, cte: CteEntry): boolean {
  let ps: ParseState | null = pstate;
  while (ps) {
    if (ps.pendingRecursiveCte === cte) {
      return true;
    }
    ps = ps.parent;
  }
  return false;
}

export function addRelationRte(an: Analyzer, pstate: ParseState, rel: Relation, alias: A.Alias | undefined, inh: boolean, writtenName: string): number {
  const live = rel.columns.filter((c) => !c.isDropped);
  if (rel.kind === 'v' && !rel.isBuiltinCatalog) {
    // expand view
    const { query } = analyzeStatementAsSubquery(an, rel.view!.query, null, true);
    const targets = query.targetList.filter((t) => !t.resjunk);
    const colnames = checkAliasColumns(alias, live.map((c) => c.name), rel.name);
    const rte: SubqueryRTE = {
      kind: 'subquery',
      subquery: query,
      alias: alias?.name,
      eref: { aliasname: alias?.name ?? rel.name, colnames },
      colTypes: targets.map((t, i) => ({ type: live[i]?.typeOid ?? t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
      lateral: false,
      viewOid: rel.oid,
    };
    return addRte(pstate, rte);
  }
  if (rel.isBuiltinCatalog) {
    const colnames = checkAliasColumns(alias, live.map((c) => c.name), rel.name);
    const rte: CatalogRTE = {
      kind: 'catalog',
      relOid: rel.oid,
      relname: rel.name,
      nspname: an.catalog.namespaceName(rel.nspOid),
      alias: alias?.name,
      eref: { aliasname: alias?.name ?? rel.name, colnames },
      colTypes: live.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: an.typeCollation(c.typeOid) ? c.collation || 100 : 0 })),
      lateral: false,
    };
    return addRte(pstate, rte);
  }
  if (rel.kind === 'i' || rel.kind === 'I') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot open relation "${rel.name}"`, { detail: `This operation is not supported for indexes.` });
  }
  if (rel.kind === 'c') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is a composite type`);
  }
  const colnames = checkAliasColumns(alias, live.map((c) => c.name), rel.name);
  const rte: RelationRTE = {
    kind: 'relation',
    relOid: rel.oid,
    relkind: rel.kind,
    relname: writtenName,
    alias: alias?.name,
    eref: { aliasname: alias?.name ?? rel.name, colnames },
    colTypes: live.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })),
    attnums: live.map((c) => c.attnum),
    inh,
    lateral: false,
  };
  return addRte(pstate, rte);
}

// ---------------------------------------------------------------------------
// Functions in FROM
// ---------------------------------------------------------------------------

function transformRangeFunction(an: Analyzer, pstate: ParseState, item: A.RangeFunction): FunctionRTE {
  const functions: RangeFunctionItem[] = [];
  const colnames: string[] = [];
  const colTypes: TypeInfo[] = [];
  let items = item.functions;
  // an unqualified multi-argument UNNEST in FROM is ROWS FROM (unnest(arg1), unnest(arg2), ...)
  if (items.length === 1 && !item.coldeflist && !items[0].coldeflist) {
    const fc = items[0].func;
    if (fc.kind === 'FuncCall' && fc.name.length === 1 && fc.name[0] === 'unnest' && fc.args.length > 1 && fc.aggOrder.length === 0 && !fc.aggFilter && !fc.over && !fc.aggStar && !fc.aggDistinct && !fc.funcVariadic) {
      items = fc.args.map((arg) => ({ func: { ...fc, name: ['pg_catalog', 'unnest'], args: [arg] } }));
    }
  } else if (items.some((f) => f.func.kind === 'FuncCall' && f.func.name.length === 1 && f.func.name[0] === 'unnest' && f.func.args.length > 1 && !f.coldeflist)) {
    throw new PgError(SqlState.SYNTAX_ERROR, 'UNNEST() with multiple arguments cannot appear in a ROWS FROM() list');
  }
  for (const f of items) {
    const expr = transformExpr(an, pstate, f.func, 'from_function');
    const coldeflist = f.coldeflist ?? (items.length === 1 ? item.coldeflist : undefined);
    const fi = describeRangeFunction(an, expr, coldeflist, items.length === 1 ? item.alias : undefined);
    functions.push(fi);
    colnames.push(...fi.colNames);
    colTypes.push(...fi.colTypes);
  }
  if (item.ordinality) {
    colnames.push('ordinality');
    colTypes.push({ type: TypeOid.int8, typmod: -1, collation: 0 });
  }
  // addRangeTableEntryForFunction: without an alias, the (first) function's name
  const aliasName = item.alias?.name ?? functionName(functions[0].expr);
  const finalNames = checkAliasColumns(item.alias, colnames, aliasName);
  return {
    kind: 'function',
    functions,
    ordinality: item.ordinality,
    alias: item.alias?.name,
    eref: { aliasname: aliasName, colnames: finalNames },
    colTypes,
    lateral: item.lateral,
  };
}

function functionName(e: TExpr): string {
  if (e.k === 'func') {
    return e.funcName;
  }
  return 'unnamed';
}

export function describeRangeFunction(an: Analyzer, expr: TExpr, coldeflist: A.ColumnDefShort[] | undefined, alias: A.Alias | undefined): RangeFunctionItem {
  const retType = expr.type;
  if (expr.k === 'func') {
    const proc = an.catalog.getProc(expr.funcOid);
    // OUT parameters define columns
    if (proc && proc.allargtypes && proc.argmodes && proc.argmodes.some((m) => m === 'o' || m === 'b' || m === 't')) {
      const names: string[] = [];
      const types: TypeInfo[] = [];
      proc.argmodes.forEach((m, i) => {
        if (m === 'o' || m === 'b' || m === 't') {
          names.push(proc.argnames?.[i] || `column${names.length + 1}`);
          let t = proc.allargtypes![i];
          if (t === TypeOid.anyelement || t === TypeOid.anycompatible) {
            t = an.types.elemType(expr.args[0]?.type) || expr.args[0]?.type || TypeOid.text;
          }
          types.push({ type: t, typmod: -1, collation: an.typeCollation(t) });
        }
      });
      if (names.length === 1) {
        return { expr, colCount: 1, expandComposite: false, colTypes: types, colNames: alias ? [alias.name] : names };
      }
      return { expr, colCount: names.length, expandComposite: true, colTypes: types, colNames: names };
    }
    if (proc && proc.returnsTable) {
      return {
        expr,
        colCount: proc.returnsTable.length,
        expandComposite: true,
        colTypes: proc.returnsTable.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: an.typeCollation(c.typeOid) })),
        colNames: proc.returnsTable.map((c) => c.name),
      };
    }
  }
  if (retType === TypeOid.record) {
    if (!coldeflist) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'a column definition list is required for functions returning "record"');
    }
    const types = coldeflist.map((c) => {
      const t = an.types.lookupTypeName(c.typeName, an.env.relationSearchPath());
      return { type: t.oid, typmod: t.typmod, collation: an.typeCollation(t.oid) };
    });
    return { expr, colCount: types.length, expandComposite: true, colTypes: types, colNames: coldeflist.map((c) => c.name) };
  }
  if (coldeflist) {
    throw new PgError(SqlState.SYNTAX_ERROR, 'a column definition list is only allowed for functions returning "record"');
  }
  const t = an.catalog.getType(an.types.baseType(retType));
  if (t && t.typtype === 'c' && t.relid) {
    const rel = an.catalog.getRelation(t.relid)!;
    const cols = rel.columns.filter((c) => !c.isDropped);
    return {
      expr,
      colCount: cols.length,
      expandComposite: true,
      colTypes: cols.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })),
      colNames: cols.map((c) => c.name),
    };
  }
  const name = alias ? alias.name : functionName(expr);
  return { expr, colCount: 1, expandComposite: false, colTypes: [{ type: retType, typmod: expr.typmod, collation: expr.collation }], colNames: [name] };
}

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

function transformJoin(an: Analyzer, pstate: ParseState, j: A.JoinExpr): FromResult {
  const left = transformFromItem(an, pstate, j.larg);
  // right side may reference the left side if LATERAL: temporarily expose left namespace as lateral-only
  const savedLen = pstate.namespace.length;
  for (const ns of left.namespace) {
    pstate.namespace.push({ ...ns, lateralOnly: true, lateralOk: true });
  }
  let right: FromResult;
  try {
    right = transformFromItem(an, pstate, j.rarg);
  } finally {
    pstate.namespace.length = savedLen;
  }

  const lrte = left.namespace;
  const rrte = right.namespace;
  const leftCols = collectJoinColumns(pstate, left);
  const rightCols = collectJoinColumns(pstate, right);

  let usingNames: string[] = j.usingClause ?? [];
  if (j.isNatural) {
    usingNames = leftCols.names.filter((n) => rightCols.names.includes(n));
  }
  const colnames: string[] = [];
  const colTypes: TypeInfo[] = [];
  const aliasVars: TExpr[] = [];
  let quals: TExpr | null = null;
  const leftUsed = new Set<number>();
  const rightUsed = new Set<number>();
  for (const uname of usingNames) {
    if (colnames.includes(uname) && !j.isNatural) {
      throw new PgError(SqlState.DUPLICATE_COLUMN, `column name "${uname}" appears more than once in USING clause`);
    }
    const li = uniqueColumn(leftCols.names, uname, 'left');
    const ri = uniqueColumn(rightCols.names, uname, 'right');
    leftUsed.add(li);
    rightUsed.add(ri);
    const lv = leftCols.exprs[li];
    const rv = rightCols.exprs[ri];
    const common = an.types.selectCommonType([lv.type, rv.type], 'JOIN/USING');
    const lc = an.coerceToCommonType(lv, common, 'JOIN/USING');
    const rc = an.coerceToCommonType(rv, common, 'JOIN/USING');
    const eq = makeOp(an, pstate, ['='], lc, rc);
    const eqb = an.coerceToBoolean(pstate, eq, 'JOIN/USING');
    quals = quals ? { k: 'bool', op: 'and', args: quals.k === 'bool' && quals.op === 'and' ? [...quals.args, eqb] : [quals, eqb], type: TypeOid.bool, typmod: -1, collation: 0 } : eqb;
    let merged: TExpr;
    switch (j.joinType) {
      case 'INNER':
      case 'LEFT':
        merged = lc;
        break;
      case 'RIGHT':
        merged = rc;
        break;
      default:
        merged = { k: 'coalesce', args: [lc, rc], type: common, typmod: -1, collation: lc.collation };
    }
    colnames.push(uname);
    colTypes.push({ type: merged.type, typmod: merged.typmod, collation: merged.collation });
    aliasVars.push(merged);
  }
  leftCols.names.forEach((n, i) => {
    if (!leftUsed.has(i)) {
      colnames.push(n);
      colTypes.push({ type: leftCols.exprs[i].type, typmod: leftCols.exprs[i].typmod, collation: leftCols.exprs[i].collation });
      aliasVars.push(leftCols.exprs[i]);
    }
  });
  rightCols.names.forEach((n, i) => {
    if (!rightUsed.has(i)) {
      colnames.push(n);
      colTypes.push({ type: rightCols.exprs[i].type, typmod: rightCols.exprs[i].typmod, collation: rightCols.exprs[i].collation });
      aliasVars.push(rightCols.exprs[i]);
    }
  });

  if (j.quals) {
    // ON clause sees both sides
    const saved = pstate.namespace.length;
    for (const ns of [...lrte, ...rrte]) {
      pstate.namespace.push(ns);
    }
    try {
      const q = transformExpr(an, pstate, j.quals, 'join_on');
      quals = an.coerceToBoolean(pstate, q, 'JOIN/ON');
    } finally {
      pstate.namespace.length = saved;
    }
  }

  const rte: JoinRTE = {
    kind: 'join',
    joinType: j.joinType,
    alias: j.alias?.name,
    eref: { aliasname: j.alias?.name ?? 'unnamed_join', colnames: checkAliasColumns(j.alias, colnames, 'unnamed_join') },
    colTypes,
    aliasVars,
    lateral: false,
    usingCount: usingNames.length,
  };
  const rtIndex = addRte(pstate, rte);
  const node: JoinNode = { k: 'join', joinType: j.joinType, larg: left.node, rarg: right.node, quals, rtIndex };
  const jns: NsItem = { rtIndex, rte, relVisible: !!j.alias, colsVisible: true, lateralOnly: false, lateralOk: true };
  let namespace: NsItem[];
  if (j.alias) {
    namespace = [jns];
  } else {
    const children = [...lrte, ...rrte].map((n) => ({ ...n, colsVisible: false }));
    namespace = [...children, jns];
  }
  if (j.joinUsingAlias) {
    const usingRte: JoinRTE = {
      kind: 'join',
      joinType: j.joinType,
      alias: j.joinUsingAlias,
      eref: { aliasname: j.joinUsingAlias, colnames: usingNames.slice() },
      colTypes: colTypes.slice(0, usingNames.length),
      aliasVars: aliasVars.slice(0, usingNames.length),
      lateral: false,
      usingCount: usingNames.length,
    };
    const uIdx = addRte(pstate, usingRte);
    namespace.push({ rtIndex: uIdx, rte: usingRte, relVisible: true, colsVisible: false, lateralOnly: false, lateralOk: true });
  }
  return { node, namespace, rtIndex };
}

function uniqueColumn(names: string[], name: string, side: string): number {
  const idx = names.indexOf(name);
  if (idx < 0) {
    throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${name}" specified in USING clause does not exist in ${side} table`);
  }
  if (names.indexOf(name, idx + 1) >= 0) {
    throw new PgError(SqlState.AMBIGUOUS_COLUMN, `common column name "${name}" appears more than once in ${side} table`);
  }
  return idx;
}

/** The column list exposed by a FROM item (for join column construction). */
function collectJoinColumns(pstate: ParseState, res: FromResult): { names: string[]; exprs: TExpr[] } {
  const rte = pstate.query.rtable[res.rtIndex];
  const names: string[] = [];
  const exprs: TExpr[] = [];
  rte.eref.colnames.forEach((n, i) => {
    names.push(n);
    exprs.push(varForColumn(rte, res.rtIndex, i, 0));
  });
  return { names, exprs };
}

export { coerceArg };
