import type * as A from '../ast';
import { Column, Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { varForColumn } from './colref';
import { compositeFields, transformExpr, transformExprRecurse, transformSubscripts } from './expr';
import { addRelationRte, addRte, lookupRelation, transformFromClause, transformFromItem } from './from';
import { emptyQuery, makeNullConst, MergeAction, OnConflictSpec, Query, RelationRTE, SubLinkNode, SubqueryRTE, TargetEntry, TExpr } from './nodes';
import { rewriteTargetView } from './view-rewrite';
import { NsItem, ParseState } from './parse-state';
import { analyzeSelectStmt, resolveTargetListUnknowns, transformTargetList, transformWithClause } from './select';
import { atPosition, exprLocation, positioned, rawLocation } from './location';

export function analyzeDmlStatement(an: Analyzer, stmt: A.Statement, pstate: ParseState): Query {
  switch (stmt.kind) {
    case 'InsertStmt':
      return transformInsert(an, stmt, pstate);
    case 'UpdateStmt':
      return transformUpdate(an, stmt, pstate);
    case 'DeleteStmt':
      return transformDelete(an, stmt, pstate);
    case 'MergeStmt':
      return transformMerge(an, stmt, pstate);
    case 'SelectStmt':
      return analyzeSelectStmt(an, stmt, pstate);
    default:
      throw new PgError(SqlState.SYNTAX_ERROR, `statement ${stmt.kind} is not allowed here`);
  }
}

function liveColumns(rel: Relation): Column[] {
  return rel.columns.filter((c) => !c.isDropped);
}

function openTarget(an: Analyzer, rv: A.RangeVar, verb: string): Relation {
  const rel = atPosition(rv.loc, () => lookupRelation(an, rv)!);
  if (rel.isBuiltinCatalog) {
    throw new PgError(SqlState.INSUFFICIENT_PRIVILEGE, `permission denied for table ${rel.name}`);
  }
  if (rel.kind === 'v' && verb !== 'merge into') {
    // an automatically updatable view: rewritten onto its base relation once analyzed (view-rewrite.ts)
    return rel;
  }
  if (rel.kind === 'm') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot change materialized view "${rel.name}"`);
  }
  if (rel.kind === 'v') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot ${verb} view "${rel.name}"`);
  }
  if (rel.kind === 'S') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot change sequence "${rel.name}"`);
  }
  if (rel.kind !== 'r' && rel.kind !== 'p') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot ${verb} relation "${rel.name}"`);
  }
  return rel;
}

/** The result relation's range table entry (a view stays a relation entry until it is rewritten). */
function addTargetRte(an: Analyzer, pstate: ParseState, rel: Relation, rv: A.RangeVar, inh: boolean): number {
  if (rel.kind !== 'v') {
    return addRelationRte(an, pstate, rel, rv.alias, inh, rv.name);
  }
  const live = liveColumns(rel);
  const rte: RelationRTE = {
    kind: 'relation',
    relOid: rel.oid,
    relkind: rel.kind,
    relname: rv.name,
    alias: rv.alias?.name,
    eref: { aliasname: rv.alias?.name ?? rel.name, colnames: live.map((c) => c.name) },
    colTypes: live.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })),
    attnums: live.map((c) => c.attnum),
    inh,
    lateral: false,
  };
  return addRte(pstate, rte);
}

function targetNsItem(pstate: ParseState, rtIndex: number): NsItem {
  return { rtIndex, rte: pstate.query.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true };
}

function findColumn(rel: Relation, name: string, loc?: number): { col: Column; index: number } {
  const live = liveColumns(rel);
  const index = live.findIndex((c) => c.name === name);
  if (index < 0) {
    throw positioned(new PgError(SqlState.UNDEFINED_COLUMN, `column "${name}" of relation "${rel.name}" does not exist`), loc);
  }
  return { col: live[index], index };
}

function transformReturning(an: Analyzer, pstate: ParseState, q: Query, returning: A.ReturningClause | undefined): void {
  if (!returning) {
    return;
  }
  // PG 18: OLD / NEW (or their WITH aliases) name the pre- and post-change row of the target
  const target = q.rtable[q.resultRelation];
  const added: NsItem[] = [];
  const addAlias = (name: string, which: 'old' | 'new', explicit: boolean) => {
    if (!explicit && pstate.namespace.some((n) => n.relVisible && n.rte.eref.aliasname === name)) {
      return;
    }
    if (explicit && pstate.namespace.some((n) => n.relVisible && n.rte.eref.aliasname === name)) {
      throw new PgError(SqlState.DUPLICATE_ALIAS, `table name "${name}" specified more than once`);
    }
    const rtIndex = addRte(pstate, { ...target, alias: name, eref: { ...target.eref, aliasname: name } } as typeof target);
    if (which === 'old') {
      q.returningOldRt = rtIndex;
    } else {
      q.returningNewRt = rtIndex;
    }
    const item: NsItem = { rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: false, lateralOnly: false, lateralOk: true };
    pstate.namespace.push(item);
    added.push(item);
  };
  if (returning.oldAlias && returning.newAlias && returning.oldAlias === returning.newAlias) {
    throw new PgError(SqlState.SYNTAX_ERROR, `table name "${returning.oldAlias}" specified more than once`);
  }
  addAlias(returning.oldAlias ?? 'old', 'old', !!returning.oldAlias);
  addAlias(returning.newAlias ?? 'new', 'new', !!returning.newAlias);
  q.returningList = transformTargetList(an, pstate, returning.targets, 'returning');
  resolveTargetListUnknowns(an, q.returningList);
  pstate.namespace = pstate.namespace.filter((n) => !added.includes(n));
}

function checkAssignedValue(col: Column, isDefault: boolean, override: 'SYSTEM' | 'USER' | undefined, forUpdate: boolean): void {
  if (isDefault) {
    return;
  }
  if (col.generated) {
    if (forUpdate) {
      throw new PgError(SqlState.GENERATED_ALWAYS, `column "${col.name}" can only be updated to DEFAULT`, { detail: `Column "${col.name}" is a generated column.` });
    }
    throw new PgError(SqlState.GENERATED_ALWAYS, `cannot insert a non-DEFAULT value into column "${col.name}"`, { detail: `Column "${col.name}" is a generated column.` });
  }
  if (col.identity === 'a' && override !== 'SYSTEM') {
    if (forUpdate) {
      throw new PgError(SqlState.GENERATED_ALWAYS, `column "${col.name}" can only be updated to DEFAULT`, {
        detail: `Column "${col.name}" is an identity column defined as GENERATED ALWAYS.`,
      });
    }
    throw new PgError(SqlState.GENERATED_ALWAYS, `cannot insert a non-DEFAULT value into column "${col.name}"`, {
      detail: `Column "${col.name}" is an identity column defined as GENERATED ALWAYS.`,
      hint: 'Use OVERRIDING SYSTEM VALUE to override.',
    });
  }
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

function transformInsert(an: Analyzer, stmt: A.InsertStmt, pstate: ParseState): Query {
  const q = pstate.query;
  q.commandType = 'insert';
  if (stmt.with) {
    transformWithClause(an, pstate, stmt.with);
  }
  const rel = openTarget(an, stmt.relation, 'insert into');
  const resultRt = addTargetRte(an, pstate, rel, stmt.relation, false);
  q.resultRelation = resultRt;
  q.override = stmt.override;
  const live = liveColumns(rel);

  // target columns (checkInsertTargets): a column may be named several times only with subscripts / subfields
  let cols: number[];
  const indirections: (A.IndirectionEl[] | null)[] = [];
  if (stmt.cols) {
    cols = [];
    const whole = new Set<number>();
    const partial = new Set<number>();
    for (const c of stmt.cols) {
      const { index } = findColumn(rel, c.name!, c.loc);
      const indirection = c.indirection && c.indirection.length > 0 ? c.indirection : null;
      if (whole.has(index) || (!indirection && partial.has(index))) {
        throw positioned(new PgError(SqlState.DUPLICATE_COLUMN, `column "${c.name}" specified more than once`), c.loc);
      }
      (indirection ? partial : whole).add(index);
      cols.push(index);
      indirections.push(indirection);
    }
  } else {
    cols = live.map((_, i) => i);
  }
  const hasIndirection = indirections.some((x) => x);
  /** rewriteTargetListIU: the values of one row's targets, merged per column (assignments to parts compose over NULL) */
  const mergeTargets = (values: (TExpr | null)[]): { columns: number[]; exprs: (TExpr | null)[] } => {
    const columns: number[] = [];
    const exprs: (TExpr | null)[] = [];
    values.forEach((v, i) => {
      const indirection = indirections[i];
      if (!indirection) {
        columns.push(cols[i]);
        exprs.push(v);
        return;
      }
      const col = live[cols[i]];
      const target = stmt.cols![i];
      const at = columns.indexOf(cols[i]);
      const base = at >= 0 ? exprs[at]! : makeNullConst(col.typeOid, col.typmod, col.collation);
      const value = atPosition(target.loc, () => assignIndirection(an, pstate, base, indirection, v!, col.name));
      if (at >= 0) {
        exprs[at] = value;
      } else {
        columns.push(cols[i]);
        exprs.push(value);
      }
    });
    return { columns, exprs };
  };
  q.insertColumns = hasIndirection ? [...new Set(cols)] : cols;

  const sel = stmt.select;
  if (sel === null) {
    q.insertSource = { kind: 'default' };
  } else if (sel.values && sel.op === 'NONE' && sel.sortClause.length === 0 && !sel.limitCount && !sel.limitOffset && !sel.with) {
    const rows: (TExpr | null)[][] = [];
    pstate.allowDefault = true;
    try {
      for (const row of sel.values) {
        if (row.length > cols.length) {
          throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns'), rawLocation(row[cols.length]));
        }
        if (row.length < cols.length && stmt.cols) {
          throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions'), stmt.cols[row.length].loc);
        }
        const out: (TExpr | null)[] = [];
        row.forEach((e, i) => {
          const col = live[cols[i]];
          if (e.kind === 'SetToDefault') {
            const indirection = indirections[i];
            if (indirection) {
              const el = indirection[indirection.length - 1];
              throw positioned(new PgError(SqlState.FEATURE_NOT_SUPPORTED, el.type === 'index' ? 'cannot set an array element to DEFAULT' : 'cannot set a subfield to DEFAULT'), stmt.cols![i].loc);
            }
            out.push(null);
            return;
          }
          const x = transformExpr(an, pstate, e, 'values');
          out.push(indirections[i] ? x : an.coerceForAssignment(x, col.typeOid, col.typmod, col.name));
        });
        // implicit column list shorter than table: remaining columns default
        rows.push(hasIndirection ? mergeTargets(out).exprs : out);
      }
    } finally {
      pstate.allowDefault = false;
    }
    // identity / generated checks (a column is fine when DEFAULT in every row)
    const insertCols = q.insertColumns;
    for (let i = 0; i < insertCols.length; i++) {
      const col = live[insertCols[i]];
      const anyValue = rows.some((r) => i < r.length && r[i] !== null);
      if (anyValue) {
        checkAssignedValue(col, false, stmt.override, false);
      }
    }
    q.insertSource = { kind: 'values', rows };
  } else {
    const child = new ParseState(pstate, emptyQuery());
    child.isSubquery = true;
    child.resolveUnknowns = false;
    const sub = analyzeSelectStmt(an, sel, child);
    const targets = sub.targetList.filter((t) => !t.resjunk);
    if (targets.length > cols.length) {
      throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns'), exprLocation(targets[cols.length].expr));
    }
    if (targets.length < cols.length && stmt.cols) {
      throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions'), stmt.cols[targets.length].loc);
    }
    targets.forEach((te, i) => {
      const col = live[cols[i]];
      if (!indirections[i]) {
        te.expr = an.coerceForAssignment(te.expr, col.typeOid, col.typmod, col.name);
      }
      checkAssignedValue(col, false, stmt.override, false);
    });
    const subqueryRte = (query: Query, entries: TargetEntry[]): SubqueryRTE => ({
      kind: 'subquery',
      subquery: query,
      eref: { aliasname: '*SELECT*', colnames: entries.map((t) => t.name) },
      colTypes: entries.map((t) => ({ type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
      lateral: false,
    });
    let rte = subqueryRte(sub, targets);
    if (hasIndirection) {
      // the assignments to parts of a column apply over the SELECT's output columns, one level up
      const wrapper = emptyQuery();
      wrapper.rtable.push(rte);
      wrapper.fromlist.push({ k: 'ref', rtIndex: 0 });
      // constants (untyped literals among them) are coerced where they are written, as PostgreSQL reports them
      const vars: TExpr[] = targets.map((t, i) => (t.expr.k === 'const' ? t.expr : { k: 'var', levelsUp: 0, rtIndex: 0, attno: i, type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation }));
      const merged = mergeTargets(vars);
      wrapper.targetList = merged.exprs.map((e, i) => ({ expr: e!, resno: i + 1, name: live[merged.columns[i]].name, resjunk: false, sortGroupRef: 0, origTable: 0, origColumn: 0 }));
      rte = subqueryRte(wrapper, wrapper.targetList);
    }
    const rtIndex = addRte(pstate, rte);
    q.insertSource = { kind: 'select', rtIndex };
    if (!hasIndirection) {
      q.insertColumns = cols.slice(0, targets.length);
    }
  }

  // ON CONFLICT
  if (stmt.onConflict) {
    q.onConflict = transformOnConflict(an, pstate, stmt.onConflict, rel, resultRt);
  }

  pstate.namespace = [targetNsItem(pstate, resultRt)];
  transformReturning(an, pstate, q, stmt.returning);
  if (rel.kind === 'v') {
    rewriteTargetView(an, q);
  }
  return q;
}

function transformOnConflict(an: Analyzer, pstate: ParseState, oc: A.OnConflictClause, rel: Relation, resultRt: number): OnConflictSpec {
  const live = liveColumns(rel);
  // arbiter inference
  const indexes = an.catalog.indexesOf(rel.oid).filter((ix) => ix.index!.unique && ix.index!.valid);
  let arbiters: number[] = [];
  if (oc.constraintName) {
    const con = an.catalog.constraintsOf(rel.oid).find((c) => c.name === oc.constraintName);
    if (!con) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${oc.constraintName}" for table "${rel.name}" does not exist`);
    }
    if (con.type !== 'u' && con.type !== 'p' && con.type !== 'x') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, 'constraint in ON CONFLICT clause has no associated index');
    }
    arbiters = [con.indexOid];
  } else if (oc.inferElems) {
    const attnums: number[] = [];
    const exprTexts: string[] = [];
    for (const el of oc.inferElems) {
      if (el.name) {
        const { col } = findColumn(rel, el.name);
        attnums.push(col.attnum);
      } else if (el.expr) {
        exprTexts.push((el.exprText ?? '').replace(/\s+/g, ' ').trim());
      }
    }
    for (const ix of indexes) {
      const keys = ix.index!.keys;
      const keyAttnums = keys.filter((k) => k.attnum > 0).map((k) => k.attnum);
      const keyExprs = keys.filter((k) => k.attnum === 0).map((k) => (k.expr?.text ?? '').replace(/\s+/g, ' ').trim());
      const sameAtts = keyAttnums.length === attnums.length && attnums.every((a) => keyAttnums.includes(a));
      const sameExprs = keyExprs.length === exprTexts.length && exprTexts.every((e) => keyExprs.some((k) => normalizeExprText(k) === normalizeExprText(e)));
      if (!sameAtts || !sameExprs) {
        continue;
      }
      if (ix.index!.predicate && !oc.inferWhere) {
        continue;
      }
      arbiters.push(ix.oid);
    }
    if (arbiters.length === 0) {
      throw new PgError(SqlState.INVALID_COLUMN_REFERENCE, 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
    }
  } else if (oc.action === 'UPDATE') {
    throw new PgError(SqlState.SYNTAX_ERROR, 'ON CONFLICT DO UPDATE requires inference specification or constraint name', {
      hint: 'For example, ON CONFLICT (column_name).',
    });
  }

  const spec: OnConflictSpec = { action: oc.action, arbiterIndexes: arbiters, setList: [], where: null, exclRtIndex: -1 };
  if (oc.action === 'UPDATE') {
    const exclRt = addRelationRte(an, pstate, rel, { name: 'excluded' }, false, rel.name);
    spec.exclRtIndex = exclRt;
    const saved = pstate.namespace;
    pstate.namespace = [targetNsItem(pstate, resultRt), { ...targetNsItem(pstate, exclRt), colsVisible: false }];
    pstate.allowDefault = true;
    try {
      const assigned = new Set<number>();
      const multiSources = new Map<string, TExpr>();
      for (const t of oc.targetList) {
        const { col, index } = findColumn(rel, t.name!, t.loc);
        if (assigned.has(index)) {
          throw new PgError(SqlState.SYNTAX_ERROR, `multiple assignments to same column "${col.name}"`);
        }
        assigned.add(index);
        if (t.val.kind === 'SetToDefault') {
          spec.setList.push({ attIndex: index, expr: { k: 'default', type: col.typeOid, typmod: col.typmod, collation: col.collation } });
          continue;
        }
        let expr: TExpr;
        if (t.val.kind === 'FuncCall' && t.val.name[0] === '__multiassign') {
          expr = multiAssignElement(an, pstate, t.val, multiSources, 'update_source');
        } else {
          expr = transformExpr(an, pstate, t.val, 'update_source');
        }
        checkAssignedValue(col, false, undefined, true);
        spec.setList.push({ attIndex: index, expr: an.coerceForAssignment(expr, col.typeOid, col.typmod, col.name) });
      }
      if (oc.where) {
        spec.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, oc.where, 'where'), 'WHERE');
      }
    } finally {
      pstate.allowDefault = false;
      pstate.namespace = saved;
    }
  }
  void live;
  return spec;
}

function normalizeExprText(s: string): string {
  return s.replace(/[\s()"]/g, '').toLowerCase();
}

function multiAssignElement(an: Analyzer, pstate: ParseState, call: A.FuncCall, sources: Map<string, TExpr>, kind: 'update_source'): TExpr {
  const src = call.args[0];
  const idx = parseInt((call.args[1] as A.AConst & { val: { value: string } }).val.value, 10) - 1;
  const key = JSON.stringify(src, (k, v) => (k === 'loc' ? undefined : v));
  let base = sources.get(key);
  if (!base) {
    if (src.kind === 'SubLink') {
      base = transformMultiExprSublink(an, pstate, src);
    } else {
      const saved = pstate.exprKind;
      pstate.exprKind = kind;
      try {
        base = transformExprRecurse(an, pstate, src);
      } finally {
        pstate.exprKind = saved;
      }
    }
    sources.set(key, base);
  }
  if (base.k === 'row') {
    if (idx >= base.args.length) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'number of columns does not match number of values');
    }
    return base.args[idx];
  }
  if (base.k === 'sublink') {
    const targets = base.subquery.targetList.filter((t) => !t.resjunk);
    const te = targets[idx];
    return { k: 'fieldselect', arg: base, fieldIndex: idx, fieldName: te.name, type: te.expr.type, typmod: te.expr.typmod, collation: te.expr.collation };
  }
  throw new PgError(SqlState.SYNTAX_ERROR, 'source for a multiple-column UPDATE item must be a sub-SELECT or ROW() expression');
}

function transformMultiExprSublink(an: Analyzer, pstate: ParseState, src: A.SubLink): SubLinkNode {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { analyzeSelectForSubquery } = require('./select');
  const { query, child } = analyzeSelectForSubquery(an, src.subselect, pstate);
  return {
    k: 'sublink',
    linkType: 'MULTIEXPR',
    testLeft: [],
    operators: [],
    subquery: query,
    correlated: child.maxOuterRef >= 1,
    id: an.nextSublinkId++,
    type: TypeOid.record,
    typmod: -1,
    collation: 0,
  };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

function transformUpdate(an: Analyzer, stmt: A.UpdateStmt, pstate: ParseState): Query {
  const q = pstate.query;
  q.commandType = 'update';
  if (stmt.with) {
    transformWithClause(an, pstate, stmt.with);
  }
  const rel = openTarget(an, stmt.relation, 'update');
  const resultRt = addTargetRte(an, pstate, rel, stmt.relation, stmt.relation.inh);
  q.resultRelation = resultRt;
  q.fromlist.push({ k: 'ref', rtIndex: resultRt });
  transformFromClause(an, pstate, stmt.from);
  pstate.namespace.unshift(targetNsItem(pstate, resultRt));
  if (stmt.where) {
    q.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.where, 'where'), 'WHERE');
  }
  q.updateSet = transformSetClauses(an, pstate, rel, stmt.targetList);
  transformReturning(an, pstate, q, stmt.returning);
  if (rel.kind === 'v') {
    rewriteTargetView(an, q);
  }
  return q;
}

/**
 * transformAssignmentIndirection: the new value of a column of which a subfield (`col.f`) or an element /
 * slice (`col[i]`, `col[l:u]`) is assigned, built over its current value `base`.
 */
function assignIndirection(an: Analyzer, pstate: ParseState, base: TExpr, els: A.IndirectionEl[], rhs: TExpr, colName: string): TExpr {
  const el = els[0];
  if (el.type === 'star') {
    throw new PgError(SqlState.SYNTAX_ERROR, 'row expansion via "*" is not supported here');
  }
  if (el.type === 'field') {
    const fields = compositeFields(an, base);
    if (!fields) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `cannot assign to field "${el.name}" of column "${colName}" because its type ${an.types.formatType(base.type, -1, false, false, an.env.relationSearchPath())} is not a composite type`);
    }
    const idx = fields.names.indexOf(el.name);
    if (idx < 0) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `cannot assign to field "${el.name}" of column "${colName}" because there is no such column in data type ${an.types.formatType(base.type, -1, false, false, an.env.relationSearchPath())}`);
    }
    const select = (i: number): TExpr => ({ k: 'fieldselect', arg: base, fieldIndex: i, fieldName: fields.names[i], ...fields.types[i] });
    const ft = fields.types[idx];
    let inner: TExpr;
    if (els.length > 1) {
      inner = assignIndirection(an, pstate, select(idx), els.slice(1), rhs, colName);
    } else {
      const c = an.coerceToTargetType(rhs, ft.type, ft.typmod, 'assignment', 'implicit_cast');
      if (!c) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, `subfield "${el.name}" is of type ${an.types.formatType(ft.type, ft.typmod, false)} but expression is of type ${an.types.formatType(rhs.type, -1, false, false, an.env.relationSearchPath())}`, {
          hint: 'You will need to rewrite or cast the expression.',
        });
      }
      inner = c;
    }
    return { k: 'row', args: fields.names.map((_, i) => (i === idx ? inner : select(i))), fieldNames: fields.names.slice(), explicitRow: false, type: base.type, typmod: base.typmod, collation: 0 };
  }
  // a run of subscripts, possibly followed by more indirection on the element
  let n = 0;
  while (n < els.length && els[n].type === 'index') {
    n++;
  }
  const subs = els.slice(0, n) as { type: 'index'; lidx: A.Expr | null; uidx: A.Expr | null; isSlice: boolean }[];
  const elem = transformSubscripts(an, pstate, base, subs);
  if (elem.k !== 'subscript' || elem.isJsonb) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: assignment through this subscript is not implemented');
  }
  let value: TExpr;
  if (n < els.length) {
    value = assignIndirection(an, pstate, elem, els.slice(n), rhs, colName);
  } else {
    const c = an.coerceToTargetType(rhs, elem.type, elem.isSlice ? base.typmod : base.typmod, 'assignment', 'implicit_cast');
    if (!c) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `array assignment to "${colName}" requires type ${an.types.formatType(elem.type, -1, false, false, an.env.relationSearchPath())} but expression is of type ${an.types.formatType(rhs.type, -1, false, false, an.env.relationSearchPath())}`, {
        hint: 'You will need to rewrite or cast the expression.',
      });
    }
    value = c;
  }
  const nullInt: TExpr = { k: 'const', type: TypeOid.int4, typmod: -1, collation: 0, value: null, isNull: true };
  const bounds: TExpr[] = [];
  subs.forEach((s, i) => {
    bounds.push(elem.lower && s.isSlice ? elem.lower[i] ?? nullInt : nullInt);
    bounds.push(elem.upper[i] ?? nullInt);
  });
  const spec = subs.map((s) => (s.isSlice ? `s${s.lidx ? 1 : 0}${s.uidx ? 1 : 0}` : 'e')).join(',');
  return {
    k: 'func',
    funcOid: 0,
    funcName: 'array_assign',
    funcSrc: '__linkgress_array_assign',
    args: [base, value, { k: 'const', type: TypeOid.text, typmod: -1, collation: 0, value: spec, isNull: false }, ...bounds],
    type: base.type,
    typmod: base.typmod,
    collation: base.collation,
    inputCollation: 0,
    retset: false,
    format: 'call',
    variadic: false,
    strict: false,
  };
}

function transformSetClauses(an: Analyzer, pstate: ParseState, rel: Relation, items: A.SetClauseItem[]): { attIndex: number; expr: TExpr }[] {
  const out: { attIndex: number; expr: TExpr }[] = [];
  const assigned = new Set<number>();
  pstate.allowDefault = true;
  try {
    const indirect = new Set<number>();
    const assign = (target: A.ResTarget, expr: TExpr | 'default') => {
      if (target.indirection && target.indirection.length > 0) {
        const { col, index } = findColumn(rel, target.name!, target.loc);
        if (assigned.has(index) && !indirect.has(index)) {
          throw new PgError(SqlState.SYNTAX_ERROR, `multiple assignments to same column "${col.name}"`);
        }
        if (expr === 'default') {
          const el = target.indirection[target.indirection.length - 1];
          throw positioned(new PgError(SqlState.FEATURE_NOT_SUPPORTED, el.type === 'index' ? 'cannot set an array element to DEFAULT' : 'cannot set a subfield to DEFAULT'), target.loc);
        }
        // assignments to several subfields / elements of one column compose (rewriteTargetListUD)
        const prev = out.find((o) => o.attIndex === index);
        const rt = pstate.query.resultRelation;
        const base = prev ? prev.expr : varForColumn(pstate.query.rtable[rt], rt, index, 0);
        const value = atPosition(target.loc, () => assignIndirection(an, pstate, base, target.indirection!, expr, col.name));
        if (prev) {
          prev.expr = value;
        } else {
          out.push({ attIndex: index, expr: value });
        }
        assigned.add(index);
        indirect.add(index);
        return;
      }
      const { col, index } = findColumn(rel, target.name!, target.loc);
      if (assigned.has(index)) {
        throw new PgError(SqlState.SYNTAX_ERROR, `multiple assignments to same column "${col.name}"`);
      }
      assigned.add(index);
      if (expr === 'default') {
        out.push({ attIndex: index, expr: { k: 'default', type: col.typeOid, typmod: col.typmod, collation: col.collation } });
        return;
      }
      checkAssignedValue(col, false, undefined, true);
      out.push({ attIndex: index, expr: an.coerceForAssignment(expr, col.typeOid, col.typmod, col.name) });
    };
    for (const item of items) {
      if (item.kind === 'single') {
        const v = item.target.val;
        if (v.kind === 'SetToDefault') {
          assign(item.target, 'default');
        } else {
          assign(item.target, transformExpr(an, pstate, v, 'update_source'));
        }
        continue;
      }
      if (item.isSubselect) {
        const sl = transformMultiExprSublink(an, pstate, { kind: 'SubLink', linkType: 'EXPR', testexpr: null, operName: [], subselect: item.source as A.SelectStmt });
        const targets = sl.subquery.targetList.filter((t) => !t.resjunk);
        if (targets.length !== item.targets.length) {
          throw new PgError(SqlState.SYNTAX_ERROR, targets.length < item.targets.length ? 'number of columns does not match number of values' : 'number of columns does not match number of values');
        }
        item.targets.forEach((t, i) => {
          const te = targets[i];
          assign(t, { k: 'fieldselect', arg: sl, fieldIndex: i, fieldName: te.name, type: te.expr.type, typmod: te.expr.typmod, collation: te.expr.collation });
        });
        continue;
      }
      const src = item.source as A.Expr;
      const args = src.kind === 'RowExpr' ? src.args : null;
      if (!args) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'source for a multiple-column UPDATE item must be a sub-SELECT or ROW() expression');
      }
      if (args.length !== item.targets.length) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'number of columns does not match number of values');
      }
      item.targets.forEach((t, i) => {
        const a = args[i];
        if (a.kind === 'SetToDefault') {
          assign(t, 'default');
        } else {
          assign(t, transformExpr(an, pstate, a, 'update_source'));
        }
      });
    }
  } finally {
    pstate.allowDefault = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

function transformDelete(an: Analyzer, stmt: A.DeleteStmt, pstate: ParseState): Query {
  const q = pstate.query;
  q.commandType = 'delete';
  if (stmt.with) {
    transformWithClause(an, pstate, stmt.with);
  }
  const rel = openTarget(an, stmt.relation, 'delete from');
  const resultRt = addTargetRte(an, pstate, rel, stmt.relation, stmt.relation.inh);
  q.resultRelation = resultRt;
  q.fromlist.push({ k: 'ref', rtIndex: resultRt });
  transformFromClause(an, pstate, stmt.using);
  pstate.namespace.unshift(targetNsItem(pstate, resultRt));
  if (stmt.where) {
    q.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.where, 'where'), 'WHERE');
  }
  transformReturning(an, pstate, q, stmt.returning);
  if (rel.kind === 'v') {
    rewriteTargetView(an, q);
  }
  return q;
}

// ---------------------------------------------------------------------------
// MERGE
// ---------------------------------------------------------------------------

function transformMerge(an: Analyzer, stmt: A.MergeStmt, pstate: ParseState): Query {
  const q = pstate.query;
  q.commandType = 'merge';
  if (stmt.with) {
    transformWithClause(an, pstate, stmt.with);
  }
  const rel = openTarget(an, stmt.relation, 'merge into');
  const resultRt = addRelationRte(an, pstate, rel, stmt.relation.alias, stmt.relation.inh, stmt.relation.name);
  q.resultRelation = resultRt;
  const src = transformFromItem(an, pstate, stmt.source);
  q.mergeSourceRtIndex = src.rtIndex;
  const targetNs = targetNsItem(pstate, resultRt);
  const live = liveColumns(rel);

  pstate.namespace = [targetNs, ...src.namespace];
  q.mergeJoinCondition = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.joinCondition, 'join_on'), 'JOIN/ON');
  q.fromlist = [src.node];

  const actions: MergeAction[] = [];
  for (const wc of stmt.whenClauses) {
    if (wc.matchKind === 'MATCHED') {
      pstate.namespace = [targetNs, ...src.namespace];
    } else if (wc.matchKind === 'NOT_MATCHED_BY_TARGET') {
      pstate.namespace = [...src.namespace];
    } else {
      pstate.namespace = [targetNs];
    }
    const action: MergeAction = { matchKind: wc.matchKind, command: wc.command, condition: null, targetList: [], override: wc.override };
    if (wc.condition) {
      action.condition = an.coerceToBoolean(pstate, transformExpr(an, pstate, wc.condition, 'merge_when'), 'WHEN');
    }
    if (wc.command === 'UPDATE') {
      if (wc.matchKind === 'NOT_MATCHED_BY_TARGET') {
        throw new PgError(SqlState.SYNTAX_ERROR, 'syntax error');
      }
      action.targetList = transformSetClauses(an, pstate, rel, wc.targetList);
    } else if (wc.command === 'INSERT') {
      let cols: number[];
      if (wc.insertCols) {
        cols = wc.insertCols.map((c) => findColumn(rel, c.name!, c.loc).index);
      } else {
        cols = live.map((_, i) => i);
      }
      if (wc.values) {
        if (wc.values.length > cols.length) {
          throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns'), rawLocation(wc.values[cols.length]));
        }
        if (wc.values.length < cols.length && wc.insertCols) {
          throw positioned(new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions'), wc.insertCols[wc.values.length].loc);
        }
        pstate.allowDefault = true;
        try {
          wc.values.forEach((v, i) => {
            const col = live[cols[i]];
            if (v.kind === 'SetToDefault') {
              action.targetList.push({ attIndex: cols[i], expr: { k: 'default', type: col.typeOid, typmod: col.typmod, collation: col.collation } });
              return;
            }
            checkAssignedValue(col, false, wc.override, false);
            action.targetList.push({ attIndex: cols[i], expr: an.coerceForAssignment(transformExpr(an, pstate, v, 'values'), col.typeOid, col.typmod, col.name) });
          });
        } finally {
          pstate.allowDefault = false;
        }
      }
    }
    actions.push(action);
  }
  q.mergeActions = actions;
  pstate.namespace = [targetNs, ...src.namespace];
  transformReturning(an, pstate, q, stmt.returning);
  return q;
}
