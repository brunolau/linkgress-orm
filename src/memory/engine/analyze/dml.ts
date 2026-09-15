import type * as A from '../ast';
import { Column, Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { transformExpr, transformExprRecurse } from './expr';
import { addRelationRte, addRte, lookupRelation, transformFromClause, transformFromItem } from './from';
import { emptyQuery, MergeAction, OnConflictSpec, Query, SubLinkNode, SubqueryRTE, TExpr } from './nodes';
import { NsItem, ParseState } from './parse-state';
import { analyzeSelectStmt, resolveTargetListUnknowns, transformTargetList, transformWithClause } from './select';

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
  const rel = lookupRelation(an, rv)!;
  if (rel.isBuiltinCatalog) {
    throw new PgError(SqlState.INSUFFICIENT_PRIVILEGE, `permission denied for table ${rel.name}`);
  }
  if (rel.kind === 'v' || rel.kind === 'm') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot ${verb} ${rel.kind === 'v' ? 'view' : 'materialized view'} "${rel.name}"`);
  }
  if (rel.kind === 'S') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot change sequence "${rel.name}"`);
  }
  if (rel.kind !== 'r' && rel.kind !== 'p') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot ${verb} relation "${rel.name}"`);
  }
  return rel;
}

function targetNsItem(pstate: ParseState, rtIndex: number): NsItem {
  return { rtIndex, rte: pstate.query.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true };
}

function findColumn(rel: Relation, name: string): { col: Column; index: number } {
  const live = liveColumns(rel);
  const index = live.findIndex((c) => c.name === name);
  if (index < 0) {
    throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${name}" of relation "${rel.name}" does not exist`);
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
  const resultRt = addRelationRte(an, pstate, rel, stmt.relation.alias, false, stmt.relation.name);
  q.resultRelation = resultRt;
  q.override = stmt.override;
  const live = liveColumns(rel);

  // target columns
  let cols: number[];
  if (stmt.cols) {
    cols = [];
    for (const c of stmt.cols) {
      if (c.indirection) {
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'INSERT into array elements / subfields is not supported by the in-memory engine');
      }
      const { index } = findColumn(rel, c.name!);
      if (cols.includes(index)) {
        throw new PgError(SqlState.DUPLICATE_COLUMN, `column "${c.name}" specified more than once`);
      }
      cols.push(index);
    }
  } else {
    cols = live.map((_, i) => i);
  }
  q.insertColumns = cols;

  const sel = stmt.select;
  if (sel === null) {
    q.insertSource = { kind: 'default' };
  } else if (sel.values && sel.op === 'NONE' && sel.sortClause.length === 0 && !sel.limitCount && !sel.limitOffset && !sel.with) {
    const rows: (TExpr | null)[][] = [];
    pstate.allowDefault = true;
    try {
      for (const row of sel.values) {
        if (row.length > cols.length) {
          throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns');
        }
        if (row.length < cols.length && stmt.cols) {
          throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions');
        }
        const out: (TExpr | null)[] = [];
        row.forEach((e, i) => {
          const col = live[cols[i]];
          if (e.kind === 'SetToDefault') {
            out.push(null);
            return;
          }
          const x = transformExpr(an, pstate, e, 'values');
          out.push(an.coerceForAssignment(x, col.typeOid, col.typmod, col.name));
        });
        // implicit column list shorter than table: remaining columns default
        rows.push(out);
      }
    } finally {
      pstate.allowDefault = false;
    }
    // identity / generated checks (a column is fine when DEFAULT in every row)
    for (let i = 0; i < cols.length; i++) {
      const col = live[cols[i]];
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
      throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns');
    }
    if (targets.length < cols.length && stmt.cols) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions');
    }
    targets.forEach((te, i) => {
      const col = live[cols[i]];
      te.expr = an.coerceForAssignment(te.expr, col.typeOid, col.typmod, col.name);
      checkAssignedValue(col, false, stmt.override, false);
    });
    const rte: SubqueryRTE = {
      kind: 'subquery',
      subquery: sub,
      eref: { aliasname: '*SELECT*', colnames: targets.map((t) => t.name) },
      colTypes: targets.map((t) => ({ type: t.expr.type, typmod: t.expr.typmod, collation: t.expr.collation })),
      lateral: false,
    };
    const rtIndex = addRte(pstate, rte);
    q.insertSource = { kind: 'select', rtIndex };
    q.insertColumns = cols.slice(0, targets.length);
  }

  // ON CONFLICT
  if (stmt.onConflict) {
    q.onConflict = transformOnConflict(an, pstate, stmt.onConflict, rel, resultRt);
  }

  pstate.namespace = [targetNsItem(pstate, resultRt)];
  transformReturning(an, pstate, q, stmt.returning);
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
        const { col, index } = findColumn(rel, t.name!);
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
  const resultRt = addRelationRte(an, pstate, rel, stmt.relation.alias, stmt.relation.inh, stmt.relation.name);
  q.resultRelation = resultRt;
  q.fromlist.push({ k: 'ref', rtIndex: resultRt });
  transformFromClause(an, pstate, stmt.from);
  pstate.namespace.unshift(targetNsItem(pstate, resultRt));
  if (stmt.where) {
    q.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.where, 'where'), 'WHERE');
  }
  q.updateSet = transformSetClauses(an, pstate, rel, stmt.targetList);
  transformReturning(an, pstate, q, stmt.returning);
  return q;
}

function transformSetClauses(an: Analyzer, pstate: ParseState, rel: Relation, items: A.SetClauseItem[]): { attIndex: number; expr: TExpr }[] {
  const out: { attIndex: number; expr: TExpr }[] = [];
  const assigned = new Set<number>();
  pstate.allowDefault = true;
  try {
    const assign = (target: A.ResTarget, expr: TExpr | 'default') => {
      if (target.indirection) {
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'UPDATE of array elements / subfields is not supported by the in-memory engine');
      }
      const { col, index } = findColumn(rel, target.name!);
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
  const resultRt = addRelationRte(an, pstate, rel, stmt.relation.alias, stmt.relation.inh, stmt.relation.name);
  q.resultRelation = resultRt;
  q.fromlist.push({ k: 'ref', rtIndex: resultRt });
  transformFromClause(an, pstate, stmt.using);
  pstate.namespace.unshift(targetNsItem(pstate, resultRt));
  if (stmt.where) {
    q.where = an.coerceToBoolean(pstate, transformExpr(an, pstate, stmt.where, 'where'), 'WHERE');
  }
  transformReturning(an, pstate, q, stmt.returning);
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
        cols = wc.insertCols.map((c) => findColumn(rel, c.name!).index);
      } else {
        cols = live.map((_, i) => i);
      }
      if (wc.values) {
        if (wc.values.length > cols.length) {
          throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more expressions than target columns');
        }
        if (wc.values.length < cols.length && wc.insertCols) {
          throw new PgError(SqlState.SYNTAX_ERROR, 'INSERT has more target columns than expressions');
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
