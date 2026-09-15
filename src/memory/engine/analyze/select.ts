import type * as A from '../ast';
import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { colNameToVar, expandNsItemColumns, missingRteError, refnameNsItem } from './colref';
import { requireOrdering, transformExpr } from './expr';
import { addRte, transformFromClause } from './from';
import {
  CteEntry,
  emptyQuery,
  Query,
  SetOpTree,
  SortGroupClause,
  SubqueryRTE,
  TargetEntry,
  TExpr,
  TypeInfo,
  ValuesRTE,
  WindowClause,
} from './nodes';
import { ExprKind, ParseState } from './parse-state';
import { analyzeDmlStatement } from './dml';
import { exprEqual, forEachChild, stripImplicitCoercions } from './walk';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Analyze a SELECT used as a sub-query of `parent` (sublink). */
export function analyzeSelectForSubquery(an: Analyzer, stmt: A.SelectStmt, parent: ParseState): { query: Query; child: ParseState } {
  const child = new ParseState(parent, emptyQuery());
  child.isSubquery = true;
  const query = analyzeSelectStmt(an, stmt, child);
  return { query, child };
}

/** Analyze any preparable statement as a subquery (FROM subselect, CTE body, view). */
export function analyzeStatementAsSubquery(an: Analyzer, stmt: A.Statement, parent: ParseState | null, resolveUnknowns: boolean): { query: Query; child: ParseState } {
  const child = new ParseState(parent, emptyQuery());
  child.isSubquery = true;
  child.resolveUnknowns = resolveUnknowns;
  if (stmt.kind === 'SelectStmt') {
    return { query: analyzeSelectStmt(an, stmt, child), child };
  }
  return { query: analyzeDmlStatement(an, stmt, child), child };
}

export function analyzeSelectStmt(an: Analyzer, stmt: A.SelectStmt, pstate: ParseState): Query {
  if (stmt.with) {
    transformWithClause(an, pstate, stmt.with);
  }
  if (stmt.op !== 'NONE') {
    return transformSetOperationStmt(an, stmt, pstate);
  }
  if (stmt.values) {
    return transformValuesClause(an, stmt, pstate);
  }
  return transformSelectCore(an, stmt, pstate);
}

// ---------------------------------------------------------------------------
// WITH
// ---------------------------------------------------------------------------

export function transformWithClause(an: Analyzer, pstate: ParseState, withClause: A.WithClause): void {
  const seen = new Set<string>();
  for (const c of withClause.ctes) {
    if (seen.has(c.name)) {
      throw new PgError(SqlState.DUPLICATE_ALIAS, `WITH query name "${c.name}" specified more than once`);
    }
    seen.add(c.name);
  }
  for (const c of withClause.ctes) {
    const entry = analyzeCte(an, pstate, c, withClause.recursive);
    pstate.ctes.push(entry);
    pstate.query.cteList.push(entry);
    if (entry.isModifying) {
      pstate.query.hasModifyingCte = true;
      if (pstate.parent) {
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'WITH clause containing a data-modifying statement must be at the top level');
      }
    }
  }
}

function cteOutput(query: Query): { names: string[]; types: TypeInfo[] } {
  const list = query.commandType === 'select' ? query.targetList : query.returningList;
  const visible = list.filter((t) => !t.resjunk);
  return {
    names: visible.map((t) => t.name),
    types: visible.map((t) => ({ type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
  };
}

function analyzeCte(an: Analyzer, pstate: ParseState, c: A.CommonTableExpr, recursive: boolean): CteEntry {
  const isModifying = c.query.kind !== 'SelectStmt';
  if (isModifying && !(c.query as A.InsertStmt).returning) {
    // allowed; produces no columns
  }
  const entry: CteEntry = {
    name: c.name,
    query: emptyQuery(),
    recursive: false,
    colNames: [],
    colTypes: [],
    materialized: c.materialized,
    refCount: 0,
    isModifying,
    id: an.nextCteId++,
  };
  const sel = c.query.kind === 'SelectStmt' ? c.query : null;
  if (recursive && sel && sel.op === 'UNION' && referencesName(sel.rarg!, c.name)) {
    // non-recursive term
    const nonRec = analyzeStatementAsSubquery(an, sel.larg!, pstate, true).query;
    const out = cteOutput(nonRec);
    entry.colNames = applyCteAliases(c, out.names);
    entry.colTypes = out.types;
    entry.recursive = true;
    const savedPending = pstate.pendingRecursiveCte;
    pstate.pendingRecursiveCte = entry;
    let rec: Query;
    try {
      rec = analyzeStatementAsSubquery(an, sel.rarg!, pstate, true).query;
    } finally {
      pstate.pendingRecursiveCte = savedPending;
    }
    const recOut = cteOutput(rec);
    if (recOut.types.length !== out.types.length) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'each UNION query must have the same number of columns');
    }
    for (let i = 0; i < out.types.length; i++) {
      if (recOut.types[i].type !== out.types[i].type) {
        throw new PgError(
          SqlState.DATATYPE_MISMATCH,
          `recursive query "${c.name}" column ${i + 1} has type ${an.types.formatType(out.types[i].type, out.types[i].typmod)} in non-recursive term but type ${an.types.formatType(recOut.types[i].type, recOut.types[i].typmod)} overall`,
          { hint: 'Cast the output of the non-recursive term to the correct type.' }
        );
      }
    }
    entry.recursiveParts = { nonRecursive: nonRec, recursive: rec, unionAll: sel.all };
    entry.query = nonRec;
    // outer ORDER BY / LIMIT on the recursive union
    if (sel.sortClause.length || sel.limitCount || sel.limitOffset) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'ORDER BY/LIMIT in a recursive query is not implemented');
    }
  } else {
    const q = analyzeStatementAsSubquery(an, c.query, pstate, true).query;
    const out = cteOutput(q);
    entry.query = q;
    entry.colNames = applyCteAliases(c, out.names);
    entry.colTypes = out.types;
  }
  if (c.search || c.cycle) {
    if (c.search) {
      entry.search = {
        breadthFirst: c.search.breadthFirst,
        columns: c.search.columns.map((n) => entry.colNames.indexOf(n)),
        seqColumn: c.search.seqColumn,
      };
      entry.colNames.push(c.search.seqColumn);
      entry.colTypes.push({ type: TypeOid.record, typmod: -1, collation: 0 });
    }
    if (c.cycle) {
      entry.colNames.push(c.cycle.markColumn, c.cycle.pathColumn);
      entry.colTypes.push({ type: TypeOid.bool, typmod: -1, collation: 0 }, { type: TypeOid._record, typmod: -1, collation: 0 });
      entry.cycle = {
        columns: c.cycle.columns.map((n) => entry.colNames.indexOf(n)),
        markColumn: c.cycle.markColumn,
        markValue: an.makeBoolConst(true),
        markDefault: an.makeBoolConst(false),
        pathColumn: c.cycle.pathColumn,
      };
    }
  }
  return entry;
}

function applyCteAliases(c: A.CommonTableExpr, names: string[]): string[] {
  const out = names.slice();
  if (c.aliasColnames) {
    if (c.aliasColnames.length > out.length) {
      throw new PgError(SqlState.SYNTAX_ERROR, `WITH query "${c.name}" has ${out.length} columns available but ${c.aliasColnames.length} columns specified`);
    }
    c.aliasColnames.forEach((n, i) => (out[i] = n));
  }
  return out;
}

function referencesName(node: unknown, name: string): boolean {
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((n) => referencesName(n, name));
  }
  const o = node as Record<string, unknown>;
  if (o.kind === 'RangeVar' && o.name === name && !o.schema) {
    return true;
  }
  for (const k of Object.keys(o)) {
    if (referencesName(o[k], name)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Simple SELECT
// ---------------------------------------------------------------------------

function transformSelectCore(an: Analyzer, stmt: A.SelectStmt, pstate: ParseState): Query {
  const q = pstate.query;
  q.commandType = 'select';
  if (stmt.into) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'SELECT ... INTO is not supported by the in-memory engine');
  }
  transformFromClause(an, pstate, stmt.from);

  // WINDOW clause definitions are available to OVER references
  for (const w of stmt.windows) {
    if (pstate.windowDefs.has(w.name!)) {
      throw new PgError(SqlState.WINDOWING_ERROR, `window "${w.name}" is already defined`);
    }
    pstate.windowDefs.set(w.name!, w);
  }

  q.targetList = transformTargetList(an, pstate, stmt.targetList, 'select');
  if (stmt.where) {
    q.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.where, 'where'), 'WHERE');
  }
  if (stmt.having) {
    q.havingQual = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.having, 'having'), 'HAVING');
  }

  q.sortClause = transformSortClause(an, pstate, stmt.sortClause, q.targetList, true);
  q.groupClause = transformGroupClause(an, pstate, stmt.groupBy, q.targetList, q.sortClause);

  if (stmt.distinct) {
    if (stmt.distinct.length === 0) {
      q.distinctClause = transformDistinctClause(an, pstate, q.targetList, q.sortClause);
    } else {
      q.distinctClause = transformDistinctOnClause(an, pstate, stmt.distinct, q.targetList, q.sortClause);
      q.hasDistinctOn = true;
    }
  }
  q.limitOffset = transformLimit(an, pstate, stmt.limitOffset, 'offset');
  q.limitCount = transformLimit(an, pstate, stmt.limitCount, 'limit');
  q.limitWithTies = stmt.limitWithTies;
  if (stmt.limitWithTies && q.sortClause.length === 0) {
    throw new PgError(SqlState.SYNTAX_ERROR, 'WITH TIES cannot be specified without ORDER BY clause');
  }
  resolveWindowClauses(an, pstate);

  // unresolved window references (named windows) complete here
  if (pstate.resolveUnknowns) {
    resolveTargetListUnknowns(an, q.targetList);
  }
  q.hasTargetSRFs = pstate.hasTargetSRFs;
  if (q.hasAggs || q.groupClause.length > 0 || q.havingQual) {
    parseCheckAggregates(an, pstate, q);
  }
  if (stmt.locking.length > 0) {
    transformLockingClause(an, pstate, q, stmt.locking);
  }
  markTargetListOrigins(an, q);
  return q;
}

export function resolveTargetListUnknowns(an: Analyzer, tlist: TargetEntry[]): void {
  for (const te of tlist) {
    if (te.expr.type === TypeOid.unknown) {
      te.expr = an.resolveUnknownToText(te.expr);
    }
  }
}

// ---------------------------------------------------------------------------
// Target list
// ---------------------------------------------------------------------------

export function transformTargetList(an: Analyzer, pstate: ParseState, targets: A.ResTarget[], kind: ExprKind): TargetEntry[] {
  const out: TargetEntry[] = [];
  for (const rt of targets) {
    const v = rt.val;
    if (v.kind === 'ColumnRef' && v.fields[v.fields.length - 1] === '*') {
      expandStar(an, pstate, v, out);
      continue;
    }
    if (v.kind === 'Indirection' && v.indirection[v.indirection.length - 1].type === 'star') {
      // (expr).* composite expansion
      const baseNode: A.Indirection = { ...v, indirection: v.indirection.slice(0, -1) };
      const base = transformExpr(an, pstate, baseNode.indirection.length ? baseNode : v.arg, kind);
      const fields = compositeFieldList(an, base);
      fields.forEach((f, i) => {
        out.push(makeTle({ k: 'fieldselect', arg: base, fieldIndex: i, fieldName: f.name, type: f.type, typmod: f.typmod, collation: f.collation }, out.length + 1, f.name, false));
      });
      continue;
    }
    const expr = transformExpr(an, pstate, v, kind);
    const name = rt.name ?? figureColname(v, expr);
    out.push(makeTle(expr, out.length + 1, name, false));
  }
  return out;
}

function compositeFieldList(an: Analyzer, e: TExpr): { name: string; type: number; typmod: number; collation: number }[] {
  if (e.k === 'row') {
    return e.args.map((a, i) => ({ name: e.fieldNames[i], type: a.type, typmod: a.typmod, collation: a.collation }));
  }
  const t = an.catalog.getType(an.types.baseType(e.type));
  if (t && t.relid) {
    const rel = an.catalog.getRelation(t.relid)!;
    return rel.columns.filter((c) => !c.isDropped).map((c) => ({ name: c.name, type: c.typeOid, typmod: c.typmod, collation: c.collation }));
  }
  throw new PgError(SqlState.WRONG_OBJECT_TYPE, `type ${an.types.formatType(e.type, -1, false)} is not composite`);
}

export function makeTle(expr: TExpr, resno: number, name: string, resjunk: boolean): TargetEntry {
  return { expr, resno, name, resjunk, sortGroupRef: 0, origTable: 0, origColumn: 0 };
}

function expandStar(an: Analyzer, pstate: ParseState, ref: A.ColumnRef, out: TargetEntry[]): void {
  if (ref.fields.length === 1) {
    let any = false;
    for (const item of pstate.namespace) {
      if (!item.colsVisible || item.lateralOnly) {
        continue;
      }
      any = true;
      for (const c of expandNsItemColumns(item, 0)) {
        out.push(makeTle(c.expr, out.length + 1, c.name, false));
      }
    }
    if (!any) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'SELECT * with no tables specified is not valid');
    }
    return;
  }
  const relname = ref.fields[ref.fields.length - 2];
  const schema = ref.fields.length >= 3 ? ref.fields[ref.fields.length - 3] : undefined;
  const found = refnameNsItem(an, pstate, schema, relname);
  if (!found) {
    // composite column expansion: col.*
    const col = ref.fields.length === 2 ? colNameToVar(an, pstate, relname, true) : null;
    if (col) {
      compositeFieldList(an, col).forEach((f, i) => {
        out.push(makeTle({ k: 'fieldselect', arg: col, fieldIndex: i, fieldName: f.name, type: f.type, typmod: f.typmod, collation: f.collation }, out.length + 1, f.name, false));
      });
      return;
    }
    throw missingRteError(an, pstate, relname);
  }
  for (const c of expandNsItemColumns(found.item, found.levelsUp)) {
    out.push(makeTle(c.expr, out.length + 1, c.name, false));
  }
}

/** FigureColname */
export function figureColname(node: A.Expr, expr?: TExpr): string {
  const r = figureColnameInternal(node);
  void expr;
  return r.name ?? '?column?';
}

function figureColnameInternal(node: A.Expr): { name: string | null; strength: number } {
  switch (node.kind) {
    case 'ColumnRef': {
      for (let i = node.fields.length - 1; i >= 0; i--) {
        if (node.fields[i] !== '*') {
          return { name: node.fields[i], strength: 2 };
        }
      }
      return { name: null, strength: 0 };
    }
    case 'Indirection': {
      for (let i = node.indirection.length - 1; i >= 0; i--) {
        const el = node.indirection[i];
        if (el.type === 'field') {
          return { name: el.name, strength: 2 };
        }
      }
      return figureColnameInternal(node.arg);
    }
    case 'FuncCall':
      return { name: node.name[node.name.length - 1], strength: 2 };
    case 'AExpr':
      if (node.exprKind === 'NULLIF') {
        return { name: 'nullif', strength: 2 };
      }
      return { name: null, strength: 0 };
    case 'TypeCast': {
      const inner = figureColnameInternal(node.arg);
      if (inner.strength <= 1) {
        const names = node.typeName.names;
        return { name: names[names.length - 1], strength: 1 };
      }
      return inner;
    }
    case 'CollateClause':
      return figureColnameInternal(node.arg);
    case 'GroupingFunc':
      return { name: 'grouping', strength: 2 };
    case 'SubLink':
      switch (node.linkType) {
        case 'EXISTS':
          return { name: 'exists', strength: 2 };
        case 'ARRAY':
          return { name: 'array', strength: 2 };
        case 'EXPR': {
          const sel = node.subselect;
          const leftmost = leftmostSelect(sel);
          const t = leftmost.targetList[0];
          if (t) {
            if (t.name) {
              return { name: t.name, strength: 2 };
            }
            const inner = figureColnameInternal(t.val);
            if (inner.name) {
              return { name: inner.name, strength: 2 };
            }
          }
          return { name: null, strength: 0 };
        }
        default:
          return { name: null, strength: 0 };
      }
    case 'CaseExpr':
      return { name: 'case', strength: 1 };
    case 'ArrayExpr':
      return { name: 'array', strength: 2 };
    case 'RowExpr':
      return { name: 'row', strength: 2 };
    case 'CoalesceExpr':
      return { name: 'coalesce', strength: 2 };
    case 'MinMaxExpr':
      return { name: node.op === 'GREATEST' ? 'greatest' : 'least', strength: 2 };
    case 'SqlValueFunction': {
      const names: Record<string, string> = {
        CURRENT_DATE: 'current_date',
        CURRENT_TIME: 'current_time',
        CURRENT_TIME_N: 'current_time',
        CURRENT_TIMESTAMP: 'current_timestamp',
        CURRENT_TIMESTAMP_N: 'current_timestamp',
        LOCALTIME: 'localtime',
        LOCALTIME_N: 'localtime',
        LOCALTIMESTAMP: 'localtimestamp',
        LOCALTIMESTAMP_N: 'localtimestamp',
        CURRENT_ROLE: 'current_role',
        CURRENT_USER: 'current_user',
        USER: 'current_user',
        SESSION_USER: 'session_user',
        CURRENT_CATALOG: 'current_catalog',
        CURRENT_SCHEMA: 'current_schema',
        SYSTEM_USER: 'system_user',
      };
      return { name: names[node.op], strength: 2 };
    }
    case 'ParenExpr':
      return figureColnameInternal(node.arg);
    default:
      return { name: null, strength: 0 };
  }
}

function leftmostSelect(sel: A.SelectStmt): A.SelectStmt {
  let s = sel;
  while (s.op !== 'NONE' && s.larg) {
    s = s.larg;
  }
  return s;
}

// ---------------------------------------------------------------------------
// ORDER BY / GROUP BY / DISTINCT
// ---------------------------------------------------------------------------

function findTargetlistEntrySQL92(an: Analyzer, pstate: ParseState, node: A.Expr, tlist: TargetEntry[], kind: ExprKind): TargetEntry {
  const inner = node.kind === 'ParenExpr' ? node : node;
  if (inner.kind === 'ColumnRef' && inner.fields.length === 1 && inner.fields[0] !== '*') {
    let name: string | null = inner.fields[0];
    if (kind === 'group_by') {
      // prefer FROM columns of this level
      if (colNameToVarLocal(an, pstate, name)) {
        name = null;
      }
    }
    if (name !== null) {
      let result: TargetEntry | null = null;
      for (const tle of tlist) {
        if (!tle.resjunk && tle.name === name) {
          if (result) {
            if (!exprEqual(result.expr, tle.expr)) {
              throw new PgError(SqlState.AMBIGUOUS_COLUMN, `${an.exprKindName(kind)} "${name}" is ambiguous`);
            }
          } else {
            result = tle;
          }
        }
      }
      if (result) {
        return result;
      }
    }
  }
  if (inner.kind === 'AConst') {
    if (inner.val.type !== 'integer') {
      throw new PgError(SqlState.SYNTAX_ERROR, `non-integer constant in ${an.exprKindName(kind)}`);
    }
    const pos = parseInt(inner.val.value, 10);
    let n = 0;
    for (const tle of tlist) {
      if (!tle.resjunk) {
        if (++n === pos) {
          return tle;
        }
      }
    }
    throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, `${an.exprKindName(kind)} position ${pos} is not in select list`);
  }
  return findTargetlistEntrySQL99(an, pstate, node, tlist, kind);
}

function colNameToVarLocal(an: Analyzer, pstate: ParseState, name: string): boolean {
  const saved = pstate.parent;
  pstate.parent = null;
  try {
    return colNameToVar(an, pstate, name, true) !== null;
  } finally {
    pstate.parent = saved;
  }
}

function findTargetlistEntrySQL99(an: Analyzer, pstate: ParseState, node: A.Expr, tlist: TargetEntry[], kind: ExprKind): TargetEntry {
  const expr = transformExpr(an, pstate, node, kind);
  for (const tle of tlist) {
    if (exprEqual(expr, stripImplicitCoercions(tle.expr))) {
      return tle;
    }
  }
  const e = expr.type === TypeOid.unknown && pstate.resolveUnknowns ? an.resolveUnknownToText(expr) : expr;
  const tle = makeTle(e, tlist.length + 1, figureColname(node), true);
  tlist.push(tle);
  return tle;
}

function assignSortGroupRef(tle: TargetEntry, tlist: TargetEntry[]): number {
  if (tle.sortGroupRef) {
    return tle.sortGroupRef;
  }
  let max = 0;
  for (const t of tlist) {
    if (t.sortGroupRef > max) {
      max = t.sortGroupRef;
    }
  }
  tle.sortGroupRef = max + 1;
  return tle.sortGroupRef;
}

export function transformSortClause(an: Analyzer, pstate: ParseState, sortBy: A.SortBy[], tlist: TargetEntry[], useSQL99: boolean): SortGroupClause[] {
  void useSQL99;
  const out: SortGroupClause[] = [];
  for (const s of sortBy) {
    const tle = findTargetlistEntrySQL92(an, pstate, s.node, tlist, 'order_by');
    if (tle.expr.type === TypeOid.unknown) {
      tle.expr = an.resolveUnknownToText(tle.expr);
    }
    const desc = s.dir === 'DESC' || (s.dir === 'USING' && s.useOp![s.useOp!.length - 1] === '>');
    if (s.dir !== 'USING') {
      requireOrderingOp(an, tle.expr.type);
    }
    const nullsFirst = s.nulls === 'DEFAULT' ? desc : s.nulls === 'FIRST';
    const ref = assignSortGroupRef(tle, tlist);
    if (out.some((o) => o.tleSortGroupRef === ref)) {
      continue;
    }
    out.push({ tleSortGroupRef: ref, desc, nullsFirst, useOpName: s.dir === 'USING' ? s.useOp![s.useOp!.length - 1] : undefined });
  }
  return out;
}

function requireOrderingOp(an: Analyzer, type: number): void {
  const base = an.types.baseType(type);
  if (base === TypeOid.json || base === TypeOid.xml || base === TypeOid.point) {
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `could not identify an ordering operator for type ${an.types.formatType(type, -1, false)}`, {
      hint: 'Use an explicit ordering operator or modify the query.',
    });
  }
}

function transformGroupClause(an: Analyzer, pstate: ParseState, items: A.GroupItem[], tlist: TargetEntry[], sortClause: SortGroupClause[]): SortGroupClause[] {
  const out: SortGroupClause[] = [];
  const q = pstate.query;
  const addExpr = (e: A.Expr): number => {
    const tle = findTargetlistEntrySQL92(an, pstate, e, tlist, 'group_by');
    if (tle.expr.type === TypeOid.unknown) {
      tle.expr = an.resolveUnknownToText(tle.expr);
    }
    if (an.types.baseType(tle.expr.type) === TypeOid.json) {
      throw new PgError(SqlState.UNDEFINED_FUNCTION, `could not identify an equality operator for type json`);
    }
    const ref = assignSortGroupRef(tle, tlist);
    let idx = out.findIndex((o) => o.tleSortGroupRef === ref);
    if (idx < 0) {
      const sc = sortClause.find((s) => s.tleSortGroupRef === ref);
      out.push({ tleSortGroupRef: ref, desc: sc ? sc.desc : false, nullsFirst: sc ? sc.nullsFirst : false });
      idx = out.length - 1;
    }
    return idx;
  };
  let hasSets = false;
  const sets: number[][][] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'expr':
        sets.push([[addExpr(item.expr)]]);
        break;
      case 'empty':
        hasSets = true;
        sets.push([[]]);
        break;
      case 'rollup': {
        hasSets = true;
        const groups = item.items.map((g) => g.map(addExpr));
        const rs: number[][] = [];
        for (let i = groups.length; i >= 0; i--) {
          rs.push(groups.slice(0, i).flat());
        }
        sets.push(rs);
        break;
      }
      case 'cube': {
        hasSets = true;
        const groups = item.items.map((g) => g.map(addExpr));
        const rs: number[][] = [];
        const n = groups.length;
        for (let mask = (1 << n) - 1; mask >= 0; mask--) {
          const s: number[] = [];
          for (let i = 0; i < n; i++) {
            if (mask & (1 << (n - 1 - i))) {
              s.push(...groups[i]);
            }
          }
          rs.push(s);
        }
        sets.push(rs);
        break;
      }
      case 'sets': {
        hasSets = true;
        const rs: number[][] = [];
        for (const sub of item.sets) {
          if (sub.kind === 'expr') {
            const e = sub.expr;
            if (e.kind === 'RowExpr' && !e.explicitRow) {
              rs.push(e.args.map(addExpr));
            } else {
              rs.push([addExpr(e)]);
            }
          } else if (sub.kind === 'empty') {
            rs.push([]);
          } else {
            throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'nested grouping sets are not supported');
          }
        }
        sets.push(rs);
        break;
      }
    }
  }
  if (hasSets) {
    // cartesian product of the per-item set lists
    let product: number[][] = [[]];
    for (const s of sets) {
      const next: number[][] = [];
      for (const p of product) {
        for (const x of s) {
          next.push([...p, ...x]);
        }
      }
      product = next;
    }
    q.groupingSets = product.map((p) => [...new Set(p)]);
  }
  return out;
}

function transformDistinctClause(an: Analyzer, pstate: ParseState, tlist: TargetEntry[], sortClause: SortGroupClause[]): SortGroupClause[] {
  const out: SortGroupClause[] = [];
  // ORDER BY items first (in order), then remaining target entries
  for (const s of sortClause) {
    const tle = tlist.find((t) => t.sortGroupRef === s.tleSortGroupRef)!;
    if (tle.resjunk) {
      throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, 'for SELECT DISTINCT, ORDER BY expressions must appear in select list');
    }
    out.push({ ...s });
  }
  for (const tle of tlist) {
    if (tle.resjunk) {
      continue;
    }
    if (tle.expr.type === TypeOid.unknown) {
      tle.expr = an.resolveUnknownToText(tle.expr);
    }
    const ref = assignSortGroupRef(tle, tlist);
    if (!out.some((o) => o.tleSortGroupRef === ref)) {
      if (an.types.baseType(tle.expr.type) === TypeOid.json) {
        throw new PgError(SqlState.UNDEFINED_FUNCTION, 'could not identify an equality operator for type json');
      }
      out.push({ tleSortGroupRef: ref, desc: false, nullsFirst: false });
    }
  }
  void pstate;
  return out;
}

function transformDistinctOnClause(an: Analyzer, pstate: ParseState, exprs: A.Expr[], tlist: TargetEntry[], sortClause: SortGroupClause[]): SortGroupClause[] {
  const refs: number[] = [];
  for (const e of exprs) {
    const tle = findTargetlistEntrySQL92(an, pstate, e, tlist, 'distinct_on');
    refs.push(assignSortGroupRef(tle, tlist));
  }
  // ORDER BY must start with the DISTINCT ON expressions
  const out: SortGroupClause[] = [];
  let skipped = false;
  for (const s of sortClause) {
    if (refs.includes(s.tleSortGroupRef)) {
      if (skipped) {
        throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, 'SELECT DISTINCT ON expressions must match initial ORDER BY expressions');
      }
      out.push({ ...s });
    } else {
      skipped = true;
    }
  }
  for (const r of refs) {
    if (!out.some((o) => o.tleSortGroupRef === r)) {
      if (sortClause.length > 0 && !skipped && out.length < sortClause.length) {
        // DISTINCT ON item not in ORDER BY prefix
      }
      if (sortClause.length > 0 && sortClause.some((s) => !refs.includes(s.tleSortGroupRef)) && out.length < refs.length) {
        throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, 'SELECT DISTINCT ON expressions must match initial ORDER BY expressions');
      }
      out.push({ tleSortGroupRef: r, desc: false, nullsFirst: false });
    }
  }
  return out;
}

function transformLimit(an: Analyzer, pstate: ParseState, node: A.Expr | null, kind: 'limit' | 'offset'): TExpr | null {
  if (!node) {
    return null;
  }
  if (node.kind === 'AConst' && node.val.type === 'null' && kind === 'limit') {
    return null;
  }
  const e = transformExpr(an, pstate, node, kind);
  const c = an.coerceToSpecificType(e, TypeOid.int8, kind.toUpperCase());
  if (containsLocalVars(c)) {
    throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, `argument of ${kind.toUpperCase()} must not contain variables`);
  }
  return c;
}

function containsLocalVars(e: TExpr): boolean {
  let found = false;
  const visit = (x: TExpr) => {
    if (x.k === 'var' && x.levelsUp === 0) {
      found = true;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return found;
}

// ---------------------------------------------------------------------------
// Aggregate checks
// ---------------------------------------------------------------------------

function parseCheckAggregates(an: Analyzer, pstate: ParseState, q: Query): void {
  const groupExprs = q.groupClause.map((g) => q.targetList.find((t) => t.sortGroupRef === g.tleSortGroupRef)!.expr);
  // functional dependency: relations whose primary key columns are all grouped
  const dependentRts = new Set<number>();
  for (let rt = 0; rt < q.rtable.length; rt++) {
    const rte = q.rtable[rt];
    if (rte.kind !== 'relation') {
      continue;
    }
    const pk = an.catalog.constraintsOf(rte.relOid).find((c) => c.type === 'p');
    if (!pk) {
      continue;
    }
    const allGrouped = pk.columns.every((attnum) => {
      const colIdx = rte.attnums.indexOf(attnum);
      return groupExprs.some((g) => g.k === 'var' && g.levelsUp === 0 && g.rtIndex === rt && g.attno === colIdx);
    });
    if (allGrouped) {
      dependentRts.add(rt);
    }
  }
  const check = (e: TExpr, clause: string) => {
    const visit = (x: TExpr) => {
      if (x.k === 'agg' || x.k === 'window') {
        if (x.k === 'window') {
          for (const a of x.args) {
            visit(a);
          }
        }
        return;
      }
      if (groupExprs.some((g) => exprEqual(g, x))) {
        return;
      }
      if (x.k === 'var' && x.levelsUp === 0) {
        if (dependentRts.has(x.rtIndex)) {
          return;
        }
        const rte = q.rtable[x.rtIndex];
        if (rte.kind === 'join') {
          const v = rte.aliasVars[x.attno];
          if (v) {
            visit(v);
            return;
          }
        }
        const colname = x.attno >= 0 ? rte.eref.colnames[x.attno] : '*';
        throw new PgError(SqlState.GROUPING_ERROR, `column "${rte.eref.aliasname}.${colname}" must appear in the GROUP BY clause or be used in an aggregate function`);
      }
      if (x.k === 'sublink') {
        for (const t of x.testLeft) {
          visit(t);
        }
        checkSublinkUngrouped(an, x.subquery, 1, groupExprs, dependentRts, q);
        return;
      }
      forEachChild(x, visit);
    };
    visit(e);
    void clause;
  };
  for (const te of q.targetList) {
    check(te.expr, 'SELECT');
  }
  if (q.havingQual) {
    check(q.havingQual, 'HAVING');
  }
  void pstate;
}

function checkSublinkUngrouped(an: Analyzer, sub: Query, level: number, groupExprs: TExpr[], dependentRts: Set<number>, outer: Query): void {
  const visit = (x: TExpr | null | undefined, lvl: number) => {
    if (!x) {
      return;
    }
    if (x.k === 'var' && x.levelsUp === lvl) {
      const shifted: TExpr = { ...x, levelsUp: 0 };
      if (groupExprs.some((g) => exprEqual(g, shifted)) || dependentRts.has(x.rtIndex)) {
        return;
      }
      const rte = outer.rtable[x.rtIndex];
      const colname = x.attno >= 0 ? rte.eref.colnames[x.attno] : '*';
      throw new PgError(SqlState.GROUPING_ERROR, `subquery uses ungrouped column "${rte.eref.aliasname}.${colname}" from outer query`);
    }
    if (x.k === 'agg' && x.levelsUp === lvl) {
      return;
    }
    if (x.k === 'sublink') {
      checkSublinkUngrouped(an, x.subquery, lvl + 1, groupExprs, dependentRts, outer);
    }
    forEachChild(x, (c) => visit(c, lvl));
  };
  for (const te of sub.targetList) {
    visit(te.expr, level);
  }
  visit(sub.where, level);
  visit(sub.havingQual, level);
  const visitJoin = (j: import('./nodes').JoinTreeNode) => {
    if (j.k === 'join') {
      visit(j.quals, level);
      visitJoin(j.larg);
      visitJoin(j.rarg);
    }
  };
  sub.fromlist.forEach(visitJoin);
  for (const rte of sub.rtable) {
    if (rte.kind === 'subquery') {
      checkSublinkUngrouped(an, rte.subquery, level + 1, groupExprs, dependentRts, outer);
    }
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** Register the window a window function uses; returns its winRef (resolved later by resolveWindowClauses). */
export function findOrCreateWindowClause(an: Analyzer, pstate: ParseState, over: A.WindowDef): number {
  void an;
  let def = over;
  if (over.refname && over.partitionClause.length === 0 && over.orderClause.length === 0 && !over.frame && !over.name) {
    const named = pstate.windowDefs.get(over.refname) as A.WindowDef | undefined;
    if (!named) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `window "${over.refname}" does not exist`);
    }
    const existing = pstate.pendingWindows.findIndex((w) => w.name === over.refname);
    if (existing >= 0) {
      return existing;
    }
    pstate.pendingWindows.push({ def: named, name: over.refname, refname: over.refname, key: '' });
    return pstate.pendingWindows.length - 1;
  } else if (over.refname) {
    const named = pstate.windowDefs.get(over.refname) as A.WindowDef | undefined;
    if (!named) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `window "${over.refname}" does not exist`);
    }
    if (over.partitionClause.length > 0) {
      throw new PgError(SqlState.WINDOWING_ERROR, `cannot override PARTITION BY clause of window "${over.refname}"`);
    }
    if (over.orderClause.length > 0 && named.orderClause.length > 0) {
      throw new PgError(SqlState.WINDOWING_ERROR, `cannot override ORDER BY clause of window "${over.refname}"`);
    }
    if (named.frame) {
      throw new PgError(SqlState.WINDOWING_ERROR, `cannot copy window "${over.refname}" because it has a frame clause`);
    }
    def = { ...over, partitionClause: named.partitionClause, orderClause: over.orderClause.length ? over.orderClause : named.orderClause };
  }
  const key = JSON.stringify(def, (k, v) => (k === 'loc' || k === 'location' ? undefined : v));
  const existing = pstate.pendingWindows.findIndex((w) => !w.name && w.key === key);
  if (existing >= 0) {
    return existing;
  }
  pstate.pendingWindows.push({ def, refname: over.refname, key });
  return pstate.pendingWindows.length - 1;
}

/** Resolve the windows registered during analysis into Query.windowClause (PG transformWindowDefinitions). */
export function resolveWindowClauses(an: Analyzer, pstate: ParseState): void {
  const q = pstate.query;
  for (const pw of pstate.pendingWindows) {
    q.windowClause.push(resolveWindowClause(an, pstate, pw.def as A.WindowDef, pw.name, pw.refname));
  }
}

function resolveWindowClause(an: Analyzer, pstate: ParseState, def: A.WindowDef, name: string | undefined, refname: string | undefined): WindowClause {
  const q = pstate.query;
  const tlist = q.targetList;
  const saved = pstate.exprKind;
  const partitionClause: SortGroupClause[] = def.partitionClause.map((p) => {
    const tle = findTargetlistEntrySQL99(an, pstate, p, tlist, 'window_partition');
    return { tleSortGroupRef: assignSortGroupRef(tle, tlist), desc: false, nullsFirst: false };
  });
  const orderClause: SortGroupClause[] = def.orderClause.map((s) => {
    const tle = findTargetlistEntrySQL99(an, pstate, s.node, tlist, 'window_order');
    const desc = s.dir === 'DESC';
    return { tleSortGroupRef: assignSortGroupRef(tle, tlist), desc, nullsFirst: s.nulls === 'DEFAULT' ? desc : s.nulls === 'FIRST' };
  });
  pstate.exprKind = saved;
  const frame = def.frame;
  const wc: WindowClause = {
    name,
    partitionClause,
    orderClause,
    frame: frame
      ? {
          mode: frame.mode,
          start: { type: frame.start.type, offset: frame.start.offset ? an.coerceToSpecificType(transformExpr(an, pstate, frame.start.offset, 'window_frame'), frame.mode === 'RANGE' ? orderColumnType(q, orderClause) : TypeOid.int8, 'ROWS') : null },
          end: { type: frame.end.type, offset: frame.end.offset ? an.coerceToSpecificType(transformExpr(an, pstate, frame.end.offset, 'window_frame'), frame.mode === 'RANGE' ? orderColumnType(q, orderClause) : TypeOid.int8, 'ROWS') : null },
          exclusion: frame.exclusion,
          defaultFrame: false,
        }
      : { mode: 'RANGE', start: { type: 'UNBOUNDED_PRECEDING', offset: null }, end: { type: 'CURRENT_ROW', offset: null }, exclusion: 'NO_OTHERS', defaultFrame: true },
    refname,
  };
  return wc;
}

function orderColumnType(q: Query, order: SortGroupClause[]): number {
  if (order.length !== 1) {
    throw new PgError(SqlState.WINDOWING_ERROR, 'RANGE with offset PRECEDING/FOLLOWING requires exactly one ORDER BY column');
  }
  const t = q.targetList.find((x) => x.sortGroupRef === order[0].tleSortGroupRef)!.expr.type;
  if (t === TypeOid.timestamp || t === TypeOid.timestamptz || t === TypeOid.date) {
    return TypeOid.interval;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function transformLockingClause(an: Analyzer, pstate: ParseState, q: Query, clauses: A.LockingClause[]): void {
  const what = clauses[0].strength === 'UPDATE' ? 'FOR UPDATE' : clauses[0].strength === 'SHARE' ? 'FOR SHARE' : clauses[0].strength === 'NO KEY UPDATE' ? 'FOR NO KEY UPDATE' : 'FOR KEY SHARE';
  if (q.hasAggs) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `${what} is not allowed with aggregate functions`);
  }
  if (q.groupClause.length) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `${what} is not allowed with GROUP BY clause`);
  }
  if (q.distinctClause) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `${what} is not allowed with DISTINCT clause`);
  }
  if (q.hasWindowFuncs) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `${what} is not allowed with window functions`);
  }
  for (const lc of clauses) {
    const targets: number[] = [];
    if (lc.lockedRels.length === 0) {
      q.rtable.forEach((rte, i) => {
        if (rte.kind === 'relation') {
          targets.push(i);
        }
      });
    } else {
      for (const rv of lc.lockedRels) {
        const idx = q.rtable.findIndex((rte) => rte.eref.aliasname === rv.name && (rte.kind === 'relation' || rte.kind === 'subquery'));
        if (idx < 0) {
          throw new PgError(SqlState.UNDEFINED_TABLE, `relation "${rv.name}" in ${what} clause not found in FROM clause`);
        }
        targets.push(idx);
      }
    }
    for (const rt of targets) {
      const existing = q.rowMarks.find((m) => m.rtIndex === rt);
      if (existing) {
        continue;
      }
      q.rowMarks.push({ rtIndex: rt, strength: lc.strength, waitPolicy: lc.waitPolicy });
    }
  }
  void an;
  void pstate;
}

// ---------------------------------------------------------------------------
// VALUES
// ---------------------------------------------------------------------------

function transformValuesClause(an: Analyzer, stmt: A.SelectStmt, pstate: ParseState): Query {
  const q = pstate.query;
  const rows = stmt.values!;
  const ncols = rows[0].length;
  const exprRows: TExpr[][] = rows.map((row) => {
    if (row.length !== ncols) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'VALUES lists must all be the same length');
    }
    return row.map((e) => transformExpr(an, pstate, e, 'values'));
  });
  const colTypes: TypeInfo[] = [];
  for (let c = 0; c < ncols; c++) {
    const col = exprRows.map((r) => r[c]);
    const type = an.types.selectCommonType(
      col.map((e) => e.type),
      'VALUES'
    );
    const typmod = an.selectCommonTypmod(col, type);
    for (const r of exprRows) {
      r[c] = an.coerceToCommonType(r[c], type, 'VALUES');
    }
    colTypes.push({ type, typmod, collation: an.typeCollation(type) });
  }
  const colnames = colTypes.map((_, i) => `column${i + 1}`);
  const rte: ValuesRTE = { kind: 'values', lists: exprRows, eref: { aliasname: '*VALUES*', colnames }, colTypes, lateral: false };
  const rtIndex = addRte(pstate, rte);
  q.fromlist.push({ k: 'ref', rtIndex });
  q.targetList = colTypes.map((ti, i) => makeTle({ k: 'var', levelsUp: 0, rtIndex, attno: i, type: ti.type, typmod: ti.typmod, collation: ti.collation }, i + 1, colnames[i], false));
  pstate.namespace.push({ rtIndex, rte, relVisible: false, colsVisible: true, lateralOnly: false, lateralOk: true });
  q.sortClause = transformSortClause(an, pstate, stmt.sortClause, q.targetList, true);
  q.limitOffset = transformLimit(an, pstate, stmt.limitOffset, 'offset');
  q.limitCount = transformLimit(an, pstate, stmt.limitCount, 'limit');
  if (stmt.locking.length) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'FOR UPDATE cannot be applied to VALUES');
  }
  return q;
}

// ---------------------------------------------------------------------------
// Set operations
// ---------------------------------------------------------------------------

function transformSetOperationStmt(an: Analyzer, stmt: A.SelectStmt, pstate: ParseState): Query {
  const q = pstate.query;
  const opName = stmt.op;
  const tree = transformSetOperationTree(an, pstate, stmt, true);
  const leftmost = findLeftmostLeaf(tree);
  const leftRte = q.rtable[leftmost.rtIndex] as SubqueryRTE;
  const colTypes = tree.k === 'setop' ? tree.colTypes : leftRte.colTypes;
  const names = leftRte.subquery.targetList.filter((t) => !t.resjunk).map((t) => t.name);
  q.setOperations = tree;
  // Result target list: vars over a pseudo "set op" RTE index -1 (executor supplies the rows)
  q.targetList = colTypes.map((ti, i) => makeTle({ k: 'var', levelsUp: 0, rtIndex: -1, attno: i, type: ti.type, typmod: ti.typmod, collation: ti.collation }, i + 1, names[i], false));
  // ORDER BY may only reference result columns by name/position
  const rteForSort: SubqueryRTE = { kind: 'subquery', subquery: leftRte.subquery, eref: { aliasname: '*SELECT*', colnames: names }, colTypes, lateral: false };
  const savedNs = pstate.namespace;
  pstate.namespace = [{ rtIndex: -1, rte: rteForSort, relVisible: false, colsVisible: true, lateralOnly: false, lateralOk: true }];
  try {
    const before = q.targetList.length;
    q.sortClause = transformSortClause(an, pstate, stmt.sortClause, q.targetList, false);
    if (q.targetList.length > before) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `invalid UNION/INTERSECT/EXCEPT ORDER BY clause`, {
        detail: 'Only result column names can be used, not expressions or functions.',
        hint: 'Add the expression/function to every SELECT, or move the UNION into a FROM clause.',
      });
    }
    q.limitOffset = transformLimit(an, pstate, stmt.limitOffset, 'offset');
    q.limitCount = transformLimit(an, pstate, stmt.limitCount, 'limit');
  } finally {
    pstate.namespace = savedNs;
  }
  if (stmt.locking.length) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `FOR UPDATE is not allowed with ${opName}`);
  }
  return q;
}

function findLeftmostLeaf(tree: SetOpTree): { k: 'leaf'; rtIndex: number } {
  let t = tree;
  while (t.k === 'setop') {
    t = t.larg;
  }
  return t;
}

function transformSetOperationTree(an: Analyzer, pstate: ParseState, stmt: A.SelectStmt, isTop: boolean): SetOpTree {
  const isLeaf = stmt.op === 'NONE' || stmt.sortClause.length > 0 || stmt.limitCount !== null || stmt.limitOffset !== null || stmt.locking.length > 0 || (stmt.with !== undefined && !isTop);
  if (isLeaf && !isTop) {
    const child = new ParseState(pstate, emptyQuery());
    child.isSubquery = true;
    child.resolveUnknowns = false;
    const sub = analyzeSelectStmt(an, stmt, child);
    const targets = sub.targetList.filter((t) => !t.resjunk);
    const rte: SubqueryRTE = {
      kind: 'subquery',
      subquery: sub,
      eref: { aliasname: '*SELECT*', colnames: targets.map((t) => t.name) },
      colTypes: targets.map((t) => ({ type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
      lateral: false,
    };
    const rtIndex = addRte(pstate, rte);
    return { k: 'leaf', rtIndex };
  }
  const larg = transformSetOperationTree(an, pstate, stmt.larg!, false);
  const rarg = transformSetOperationTree(an, pstate, stmt.rarg!, false);
  const ltypes = setOpColTypes(pstate, larg);
  const rtypes = setOpColTypes(pstate, rarg);
  const ctx = stmt.op;
  if (ltypes.length !== rtypes.length) {
    throw new PgError(SqlState.SYNTAX_ERROR, `each ${ctx} query must have the same number of columns`);
  }
  const colTypes: TypeInfo[] = [];
  for (let i = 0; i < ltypes.length; i++) {
    let type = an.types.selectCommonType([ltypes[i].type, rtypes[i].type], ctx);
    const typmod = ltypes[i].type === rtypes[i].type && ltypes[i].typmod === rtypes[i].typmod ? ltypes[i].typmod : -1;
    if (type === TypeOid.unknown) {
      type = TypeOid.text;
    }
    // at the top level, unresolved unknowns become text
    if (isTop && type === TypeOid.unknown) {
      type = TypeOid.text;
    }
    colTypes.push({ type, typmod, collation: an.typeCollation(type) });
    coerceSetOpLeaf(an, pstate, larg, i, type, ctx);
    coerceSetOpLeaf(an, pstate, rarg, i, type, ctx);
  }
  if (stmt.op !== 'UNION' || !stmt.all) {
    for (const ti of colTypes) {
      if (an.types.baseType(ti.type) === TypeOid.json) {
        throw new PgError(SqlState.UNDEFINED_FUNCTION, 'could not identify an equality operator for type json');
      }
    }
  }
  return { k: 'setop', op: stmt.op as 'UNION', all: stmt.all, larg, rarg, colTypes };
}

function setOpColTypes(pstate: ParseState, t: SetOpTree): TypeInfo[] {
  if (t.k === 'setop') {
    return t.colTypes;
  }
  return (pstate.query.rtable[t.rtIndex] as SubqueryRTE).colTypes;
}

function coerceSetOpLeaf(an: Analyzer, pstate: ParseState, t: SetOpTree, col: number, type: number, ctx: string): void {
  if (t.k === 'setop') {
    // nested set op columns already coerced to their common type; coerce leaves further
    coerceSetOpLeaf(an, pstate, t.larg, col, type, ctx);
    coerceSetOpLeaf(an, pstate, t.rarg, col, type, ctx);
    t.colTypes[col] = { type, typmod: t.colTypes[col].typmod, collation: an.typeCollation(type) };
    return;
  }
  const rte = pstate.query.rtable[t.rtIndex] as SubqueryRTE;
  const targets = rte.subquery.targetList.filter((x) => !x.resjunk);
  const te = targets[col];
  if (te.expr.type !== type) {
    te.expr = an.coerceToCommonType(te.expr, type, ctx);
    rte.colTypes[col] = { type, typmod: te.expr.typmod, collation: te.expr.collation };
  }
}

// ---------------------------------------------------------------------------
// Target origins
// ---------------------------------------------------------------------------

function markTargetListOrigins(an: Analyzer, q: Query): void {
  for (const te of q.targetList) {
    const e = te.expr;
    if (e.k !== 'var' || e.levelsUp !== 0 || e.rtIndex < 0) {
      continue;
    }
    const rte = q.rtable[e.rtIndex];
    if (rte.kind === 'relation' && e.attno >= 0) {
      te.origTable = rte.relOid;
      te.origColumn = rte.attnums[e.attno];
    } else if (rte.kind === 'subquery' && e.attno >= 0) {
      const sub = rte.subquery.targetList.filter((t) => !t.resjunk)[e.attno];
      if (sub) {
        te.origTable = sub.origTable;
        te.origColumn = sub.origColumn;
      }
    }
  }
  void an;
}
