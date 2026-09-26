import type * as A from '../ast';
import { Column, Relation, StoredExpr, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { Analyzer } from './analyzer';
import { varForColumn } from './colref';
import { compositeFields, transformExpr, transformExprRecurse, transformSubscripts } from './expr';
import { addRelationRte, addRte, lookupRelation, transformFromClause, transformFromItem } from './from';
import { ConstNode, emptyQuery, makeNullConst, MergeAction, OnConflictSpec, OpNode, Query, RelationRTE, SubLinkNode, SubqueryRTE, TargetEntry, TExpr } from './nodes';
import { rewriteTargetView } from './view-rewrite';
import { NsItem, ParseState } from './parse-state';
import { analyzeSelectStmt, resolveTargetListUnknowns, transformTargetList, transformWithClause } from './select';
import { atPosition, exprLocation, positioned, rawLocation } from './location';
import { stripImplicitCoercions } from './walk';

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
    const arbiterWhere = oc.inferWhere ? transformArbiterWhere(an, pstate, oc.inferWhere, resultRt) : null;
    for (const ix of indexes) {
      const keys = ix.index!.keys;
      const keyAttnums = keys.filter((k) => k.attnum > 0).map((k) => k.attnum);
      const keyExprs = keys.filter((k) => k.attnum === 0).map((k) => (k.expr?.text ?? '').replace(/\s+/g, ' ').trim());
      const sameAtts = keyAttnums.length === attnums.length && attnums.every((a) => keyAttnums.includes(a));
      const sameExprs = keyExprs.length === exprTexts.length && exprTexts.every((e) => keyExprs.some((k) => normalizeExprText(k) === normalizeExprText(e)));
      if (!sameAtts || !sameExprs) {
        continue;
      }
      // infer_arbiter_indexes: a partial index is an arbiter only when the ON CONFLICT WHERE implies its predicate
      if (ix.index!.predicate && !(arbiterWhere && arbiterWhereImplies(an, rel, ix.index!.predicate, arbiterWhere, resultRt))) {
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

/**
 * transformOnConflictArbiter: the arbiter WHERE is analysed with the target relation as the only
 * namespace entry (the source is analysed, EXCLUDED not yet added) and as an index predicate — no
 * subqueries, aggregates, window functions or set-returning functions. Not coerced to boolean, as there.
 */
function transformArbiterWhere(an: Analyzer, pstate: ParseState, where: A.Expr, resultRt: number): TExpr {
  const saved = pstate.namespace;
  pstate.namespace = [targetNsItem(pstate, resultRt)];
  try {
    return transformExpr(an, pstate, where, 'index_predicate');
  } finally {
    pstate.namespace = saved;
  }
}

/**
 * predicate_implied_by(index predicate, arbiter WHERE), for the forms arbiter inference meets. Both sides are
 * first normalised as the planner does before comparing them ({@link normalizeArbiterExpr}); then every
 * conjunct of the index predicate must be implied by one conjunct of the WHERE ({@link arbiterClauseImplies}),
 * or — the AND of a `NOT IN` list — each of its comparisons by one ({@link comparisonsImpliedByConjuncts}).
 * A parameter is no constant: it proves nothing, as in a GENERIC plan — a statement relying on a custom plan
 * to see its bound value would fail there.
 *
 * Not modelled (the engine then answers 42P10 where PostgreSQL may still infer the index — never the reverse):
 * OR on either side (reordered arms, `a` ⇒ `a OR b`, `a OR b` ⇒ `x` arm by arm — a ScalarArrayOp over constants,
 * an IN list, is modelled: {@link constantComparisonsImply}), range proofs (`x > 5` ⇒ `x > 0`, `x = 'a'` ⇒
 * `x <> 'b'`), cross-type proofs other than int2 / int4 / int8 constants, constant folding beyond a cast of a
 * constant (`0 + 0`, `'a' || 'b'`, `'1'::text::int`), and ScalarArrayOp arrays that are empty, hold a NULL,
 * are multi-dimensional or longer than 100 elements, or hold booleans compared with a bare boolean column
 * (predtest.c proves `x` from its `x = true` element; this model compares elements only with elements).
 */
function arbiterWhereImplies(an: Analyzer, rel: Relation, predicate: StoredExpr, arbiterWhere: TExpr, resultRt: number): boolean {
  const clauses = arbiterConjuncts(an, arbiterWhere);
  return arbiterConjuncts(an, analyzeIndexPredicate(an, rel, predicate)).every(
    (p) => clauses.some((c) => arbiterClauseImplies(an, c, p, resultRt)) || comparisonsImpliedByConjuncts(an, clauses, p, resultRt)
  );
}

/** The stored predicate of a partial index, analysed over the relation alone (a fresh analyzer: no SQL-function parameter names). */
function analyzeIndexPredicate(an: Analyzer, rel: Relation, predicate: StoredExpr): TExpr {
  const indexAnalyzer = new Analyzer(an.env);
  const q = emptyQuery();
  const pstate = new ParseState(null, q);
  const rtIndex = addRelationRte(indexAnalyzer, pstate, rel, undefined, false, rel.name);
  pstate.namespace.push({ rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true });
  return indexAnalyzer.coerceToBoolean(pstate, transformExpr(indexAnalyzer, pstate, predicate.raw, 'index_predicate'), 'WHERE');
}

/** make_ands_implicit over the normalised AND tree. */
function arbiterConjuncts(an: Analyzer, e: TExpr): TExpr[] {
  const flatten = (x: TExpr): TExpr[] => {
    const s = stripImplicitCoercions(x);
    return s.k === 'bool' && s.op === 'and' ? s.args.flatMap(flatten) : [s];
  };
  return flatten(normalizeArbiterExpr(an, e));
}

const INTEGER_TYPES = new Map<number, [bigint, bigint]>([
  [TypeOid.int2, [-32768n, 32767n]],
  [TypeOid.int4, [-2147483648n, 2147483647n]],
  [TypeOid.int8, [-9223372036854775808n, 9223372036854775807n]],
]);

const COMPARISON_OPERATORS = new Set(['=', '<>', '<', '<=', '>', '>=']);

/**
 * An arbiter WHERE / index predicate in the form PostgreSQL's planner compares them in (eval_const_expressions,
 * as far as arbiter inference needs it), applied to both sides alike:
 * - a relabel (binary-compatible cast) of a constant is that constant retyped; stacked relabels collapse, to
 *   nothing when they net out (`email::varchar::text` is `email`);
 * - an explicit or implicit cast between int2 / int4 / int8 of an integer constant is the constant of the target
 *   type (`CAST(1 AS smallint)`, `1::bigint`);
 * - `x = true` / `x <> false` → `x`, `x = false` / `x <> true` → `NOT x`, either operand order;
 * - NOT is pushed down as negate_clause does: `NOT NOT x` → `x`, `NOT (a op b)` → `a <negator> b`,
 *   `NOT (x IS NULL)` → `x IS NOT NULL`, `NOT (x = ANY(…))` → `x <> ALL(…)`, `NOT (x IS TRUE)` → `x IS NOT TRUE`,
 *   De Morgan over AND / OR;
 * - `x IS [NOT] DISTINCT FROM NULL` → `x IS [NOT] NULL` (a scalar `x`);
 * - `<constant> op x` becomes `x <commutator> <constant>`: predtest.c proves `c op x` ⇒ `x op' c` for any
 *   operator with a commutator (and commutes before its cross-type btree proof).
 */
function normalizeArbiterExpr(an: Analyzer, e: TExpr): TExpr {
  switch (e.k) {
    case 'relabel': {
      let arg = normalizeArbiterExpr(an, e.arg);
      while (arg.k === 'relabel') {
        arg = arg.arg;
      }
      if (arg.k === 'const') {
        return { ...arg, type: e.type, typmod: e.typmod, collation: e.collation };
      }
      return arg.type === e.type && arg.typmod === e.typmod ? arg : { ...e, arg };
    }
    case 'func': {
      const args = e.args.map((a) => normalizeArbiterExpr(an, a));
      const cast = (e.format === 'explicit_cast' || e.format === 'implicit_cast') && args.length === 1 ? foldIntegerCast(args[0], e.type) : null;
      return cast ?? { ...e, args };
    }
    case 'op': {
      const op: OpNode = { ...e, args: e.args.map((a) => normalizeArbiterExpr(an, a)) };
      const simplified = simplifyBooleanEquality(op);
      if (simplified !== op) {
        return simplified.k === 'bool' && simplified.op === 'not' ? negateArbiterExpr(an, simplified.args[0]) : simplified;
      }
      return commuteConstantFirst(an, op);
    }
    case 'bool': {
      const args = e.args.map((a) => normalizeArbiterExpr(an, a));
      return e.op === 'not' ? negateArbiterExpr(an, args[0]) : { ...e, args };
    }
    case 'distinct': {
      const args = e.args.map((a) => normalizeArbiterExpr(an, a));
      const nullAt = args.findIndex((a) => a.k === 'const' && a.isNull);
      const other = args.length === 2 && nullAt >= 0 ? args[1 - nullAt] : null;
      if (other && !(other.k === 'const' && other.isNull) && other.k !== 'row' && !(an.types.isComposite(other.type) && other.type !== TypeOid.record)) {
        return { k: 'nulltest', arg: other, isNot: !e.isNot, argIsRow: false, type: TypeOid.bool, typmod: -1, collation: 0 };
      }
      return { ...e, args };
    }
    case 'nulltest':
      return { ...e, arg: normalizeArbiterExpr(an, e.arg) };
    case 'saop':
      return { ...e, args: [normalizeArbiterExpr(an, e.args[0]), normalizeArbiterExpr(an, e.args[1])] };
    default:
      return e;
  }
}

/** A cast between int2 / int4 / int8 of an integer constant, folded — or null (another cast, or out of range: PostgreSQL raises there). */
function foldIntegerCast(arg: TExpr, target: number): TExpr | null {
  const range = INTEGER_TYPES.get(target);
  if (!range || arg.k !== 'const' || arg.isNull || !INTEGER_TYPES.has(arg.type)) {
    return null;
  }
  const value = BigInt(arg.value as number | bigint);
  if (value < range[0] || value > range[1]) {
    return null;
  }
  return { k: 'const', type: target, typmod: -1, collation: 0, value: target === TypeOid.int8 ? value : Number(value), isNull: false };
}

/** negate_clause: the exact negation where one exists, else `NOT x`. */
function negateArbiterExpr(an: Analyzer, x: TExpr): TExpr {
  const negatorOf = (opOid: number) => an.catalog.getOperator(an.catalog.getOperator(opOid)?.negator ?? 0);
  switch (x.k) {
    case 'const':
      if (x.type === TypeOid.bool) {
        return x.isNull ? x : { ...x, value: !x.value };
      }
      break;
    case 'op': {
      const negator = x.args.length === 2 ? negatorOf(x.opOid) : undefined;
      if (negator) {
        return { ...x, opOid: negator.oid, opName: negator.name, funcOid: negator.codeOid, funcSrc: negator.codeSrc };
      }
      break;
    }
    case 'saop': {
      const negator = negatorOf(x.opOid);
      if (negator) {
        return { ...x, opOid: negator.oid, opName: negator.name, opSrc: negator.codeSrc, useOr: !x.useOr };
      }
      break;
    }
    case 'bool':
      if (x.op === 'not') {
        return x.args[0];
      }
      return { ...x, op: x.op === 'and' ? 'or' : 'and', args: x.args.map((a) => negateArbiterExpr(an, a)) };
    case 'nulltest':
      if (!x.argIsRow) {
        return { ...x, isNot: !x.isNot };
      }
      break;
    case 'booltest':
      return { ...x, test: BOOLTEST_NEGATION[x.test] };
  }
  return { k: 'bool', op: 'not', args: [x], type: TypeOid.bool, typmod: -1, collation: 0 };
}

const BOOLTEST_NEGATION = {
  IS_TRUE: 'IS_NOT_TRUE',
  IS_NOT_TRUE: 'IS_TRUE',
  IS_FALSE: 'IS_NOT_FALSE',
  IS_NOT_FALSE: 'IS_FALSE',
  IS_UNKNOWN: 'IS_NOT_UNKNOWN',
  IS_NOT_UNKNOWN: 'IS_UNKNOWN',
} as const;

/** `<constant> op x` → `x <commutator> <constant>` (a binary operator with a commutator). */
function commuteConstantFirst(an: Analyzer, op: OpNode): OpNode {
  const [left, right] = op.args;
  if (op.args.length !== 2 || left.k !== 'const' || right.k === 'const') {
    return op;
  }
  const commutator = an.catalog.getOperator(an.catalog.getOperator(op.opOid)?.commutator ?? 0);
  if (!commutator) {
    return op;
  }
  return { ...op, opOid: commutator.oid, opName: commutator.name, funcOid: commutator.codeOid, funcSrc: commutator.codeSrc, args: [right, left] };
}

/** `x = true` / `x <> false` → `x`, `x = false` / `x <> true` → `NOT x` (either operand order). */
function simplifyBooleanEquality(e: TExpr): TExpr {
  if (e.k !== 'op' || (e.opName !== '=' && e.opName !== '<>') || e.args.length !== 2 || e.type !== TypeOid.bool) {
    return e;
  }
  const [a, b] = e.args.map((x) => stripImplicitCoercions(x));
  for (const [x, c] of [
    [a, b],
    [b, a],
  ]) {
    if (c.k === 'const' && !c.isNull && c.type === TypeOid.bool && x.type === TypeOid.bool && x.k !== 'const') {
      const keeps = (c.value === true) === (e.opName === '=');
      return keeps ? x : { k: 'bool', op: 'not', args: [x], type: TypeOid.bool, typmod: -1, collation: 0 };
    }
  }
  return e;
}

/**
 * Does one normalised WHERE conjunct `clause` imply one normalised index-predicate conjunct `pred`
 * (predicate_implied_by_simple_clause)? When they are equal; when they are the same comparison of the same
 * expression with integer constants of equal value; when either is a ScalarArrayOp over constants whose
 * comparisons imply the other's ({@link constantComparisonsImply}); or when `pred` is `x IS NOT NULL` and
 * `clause` is strict for `x`.
 */
function arbiterClauseImplies(an: Analyzer, clause: TExpr, pred: TExpr, resultRt: number): boolean {
  if (sameArbiterExpr(clause, pred, resultRt) || sameIntegerComparison(clause, pred, resultRt)) {
    return true;
  }
  if (clause.k === 'saop' || pred.k === 'saop') {
    const c = constantComparisons(an, clause);
    const p = constantComparisons(an, pred);
    if (c && p && constantComparisonsImply(c, p, resultRt)) {
      return true;
    }
  }
  return pred.k === 'nulltest' && pred.isNot && !pred.argIsRow && clauseIsStrictFor(an, clause, pred.arg, resultRt, true);
}

/** predtest.c's MAX_SAOP_ARRAY_SIZE: a longer array is not taken apart. */
const MAX_SAOP_ARRAY_SIZE = 100;

/**
 * `x op c1 … x op cn` as predtest.c reads a ScalarArrayOp over constants: the OR (`ANY`, an IN list) or the
 * AND (`ALL`, a NOT IN list) of one comparison per element. A plain comparison `x op c` is the one-element
 * case (OR and AND alike).
 */
interface ConstantComparisons {
  x: TExpr;
  opOid: number;
  opName: string;
  useOr: boolean;
  values: ConstNode[];
}

/**
 * The comparisons of `e` (see {@link ConstantComparisons}) — a comparison operator with a non-NULL constant on
 * the right, or a ScalarArrayOp whose array is a constant (a literal, or `ARRAY[…]` / an IN list of constants,
 * relabelled or not); `undefined` otherwise. Left alone (answered by the other rules): an empty array, one
 * holding a NULL, a multi-dimensional one and one past MAX_SAOP_ARRAY_SIZE elements — predtest.c takes those
 * apart too, and proves more from a NULL element than this model does.
 */
function constantComparisons(an: Analyzer, e: TExpr): ConstantComparisons | undefined {
  if (e.k === 'op') {
    const [x, c] = e.args;
    return e.args.length === 2 && COMPARISON_OPERATORS.has(e.opName) && c.k === 'const' && !c.isNull
      ? { x, opOid: e.opOid, opName: e.opName, useOr: true, values: [c] }
      : undefined;
  }
  if (e.k !== 'saop' || !COMPARISON_OPERATORS.has(e.opName)) {
    return undefined;
  }
  const values = arrayConstants(an, e.args[1]);
  if (!values || values.length === 0 || values.length > MAX_SAOP_ARRAY_SIZE) {
    return undefined;
  }
  return { x: e.args[0], opOid: e.opOid, opName: e.opName, useOr: e.useOr, values };
}

/** The elements of a constant one-dimensional array operand as non-NULL constants of its element type; `undefined` for anything else. */
function arrayConstants(an: Analyzer, array: TExpr): ConstNode[] | undefined {
  // A binary-compatible coercion of the whole array (varchar[] → text[]): the elements, retyped
  if (array.k === 'arraycoerce') {
    const elem = array.elemExpr.k === 'relabel' ? array.elemExpr.arg : array.elemExpr;
    const elemType = an.types.elemType(array.type);
    const inner = elem.k === 'execparam' && elem.slot === array.elemSlot && elemType ? arrayConstants(an, array.arg) : undefined;
    return inner?.map((c) => ({ ...c, type: elemType, typmod: -1, collation: an.typeCollation(elemType) }));
  }
  if (array.k === 'array') {
    if (array.multidims) {
      return undefined;
    }
    const elements = array.elements.map((element) => normalizeArbiterExpr(an, element));
    return elements.every((element): element is ConstNode => element.k === 'const' && !element.isNull) ? elements : undefined;
  }
  if (array.k === 'const' && !array.isNull && Array.isArray(array.value)) {
    const elemType = an.types.elemType(array.type);
    if (!elemType || !array.value.every((v) => v !== null && v !== undefined && !Array.isArray(v))) {
      return undefined;
    }
    return array.value.map((value) => ({ k: 'const', type: elemType, typmod: -1, collation: an.typeCollation(elemType), value, isNull: false }));
  }
  return undefined;
}

/**
 * predicate_implied_by_recurse over two comparison sets of one expression (`clause` from the WHERE, `pred` from
 * the index predicate), each comparison of `clause` proving one of `pred` when they are the same comparison
 * ({@link sameConstantComparison}):
 * - OR ⇒ OR (atom ⇒ OR, OR ⇒ atom, atom ⇒ atom): each of the clause's comparisons proves one of the predicate's
 *   — an IN list implies an IN list holding all its values, in any order;
 * - AND ⇒ OR: one of the clause's comparisons proves one of the predicate's;
 * - AND ⇒ AND (atom ⇒ AND): each of the predicate's comparisons is proven by one of the clause's — a NOT IN list
 *   implies one holding a subset of its values;
 * - OR ⇒ AND: each of the clause's comparisons proves every one of the predicate's.
 */
function constantComparisonsImply(clause: ConstantComparisons, pred: ConstantComparisons, rt: number): boolean {
  if (!sameArbiterExpr(clause.x, pred.x, rt)) {
    return false;
  }
  const proves = (c: ConstNode, p: ConstNode): boolean => sameConstantComparison(clause, c, pred, p);
  const clauseOr = clause.useOr || clause.values.length === 1;
  const clauseAnd = !clause.useOr || clause.values.length === 1;
  const predOr = pred.useOr || pred.values.length === 1;
  if (predOr) {
    return clauseOr
      ? clause.values.every((c) => pred.values.some((p) => proves(c, p)))
      : clause.values.some((c) => pred.values.some((p) => proves(c, p)));
  }
  return clauseAnd
    ? pred.values.every((p) => clause.values.some((c) => proves(c, p)))
    : clause.values.every((c) => pred.values.every((p) => proves(c, p)));
}

/**
 * `x op c` proves `x op' p`: the same operator and equal constants of one type, or — as the integer btree
 * family's cross-type operators do ({@link sameIntegerComparison}) — the same comparison of an int2 / int4 /
 * int8 expression with integer constants of equal value.
 */
function sameConstantComparison(clause: ConstantComparisons, c: ConstNode, pred: ConstantComparisons, p: ConstNode): boolean {
  if (clause.opOid === pred.opOid && c.type === p.type && sameArbiterExpr(c.value, p.value, -1)) {
    return true;
  }
  return clause.opName === pred.opName && INTEGER_TYPES.has(clause.x.type)
    && INTEGER_TYPES.has(c.type) && INTEGER_TYPES.has(p.type)
    && BigInt(c.value as number | bigint) === BigInt(p.value as number | bigint);
}

/**
 * An index-predicate conjunct that is the AND of comparisons with constants (`x NOT IN (…)`, `x op ALL(…)`)
 * no single WHERE conjunct implies: AND ⇒ AND, each of its comparisons implied by one of the WHERE's conjuncts
 * (`x <> 'a' AND x <> 'b'` for `x NOT IN ('a', 'b')`).
 */
function comparisonsImpliedByConjuncts(an: Analyzer, clauses: TExpr[], pred: TExpr, rt: number): boolean {
  const p = pred.k === 'saop' ? constantComparisons(an, pred) : undefined;
  if (!p || p.useOr || p.values.length < 2) {
    return false;
  }
  const conjuncts = clauses.map((clause) => constantComparisons(an, clause)).filter((c): c is ConstantComparisons => c !== undefined);
  return p.values.every((value) => conjuncts.some((c) => constantComparisonsImply(c, { ...p, useOr: true, values: [value] }, rt)));
}

/**
 * `x op c1` and `x op c2` with the same comparison operator name, `x` an int2 / int4 / int8 expression and c1, c2
 * integer constants of equal value, whatever their types (`st = 1::smallint` / `st = 1`): the integer btree
 * family's cross-type operators prove one from the other (operator_predicate_proof).
 */
function sameIntegerComparison(clause: TExpr, pred: TExpr, rt: number): boolean {
  if (clause.k !== 'op' || pred.k !== 'op' || clause.opName !== pred.opName || !COMPARISON_OPERATORS.has(clause.opName) || clause.args.length !== 2 || pred.args.length !== 2) {
    return false;
  }
  const [clauseExpr, clauseConst] = clause.args;
  const [predExpr, predConst] = pred.args;
  return clauseConst.k === 'const' && predConst.k === 'const' && !clauseConst.isNull && !predConst.isNull
    && INTEGER_TYPES.has(clauseConst.type) && INTEGER_TYPES.has(predConst.type) && INTEGER_TYPES.has(clauseExpr.type)
    && BigInt(clauseConst.value as number | bigint) === BigInt(predConst.value as number | bigint)
    && sameArbiterExpr(clauseExpr, predExpr, rt);
}

/**
 * clause_is_strict_for: is `clause` NULL — or, with `allowFalse`, false — whenever `sub` is NULL, so that a
 * true `clause` proves `sub IS NOT NULL`? Through strict operators and functions, relabels and COLLATE (a
 * relabel once planned), I/O, array and domain coercions, and a ScalarArrayOp: strict in its scalar input over
 * an array known non-empty (or any array for `= ANY` when a false result is allowed), or NULL for a NULL array.
 */
function clauseIsStrictFor(an: Analyzer, clause: TExpr, sub: TExpr, rt: number, allowFalse: boolean): boolean {
  const c = clause.k === 'relabel' || clause.k === 'collate' ? clause.arg : clause;
  const s = sub.k === 'relabel' || sub.k === 'collate' ? sub.arg : sub;
  if (sameArbiterExpr(c, s, rt)) {
    return true;
  }
  switch (c.k) {
    case 'op':
    case 'func':
      return an.catalog.getProc(c.funcOid)?.strict === true && c.args.some((a) => clauseIsStrictFor(an, a, s, rt, false));
    case 'iocoerce':
    case 'arraycoerce':
    case 'domaincoerce':
      return clauseIsStrictFor(an, c.arg, s, rt, false);
    case 'saop': {
      const [scalar, array] = c.args;
      if (an.catalog.getProc(an.catalog.getOperator(c.opOid)?.codeOid ?? 0)?.strict === true && clauseIsStrictFor(an, scalar, s, rt, false)) {
        if ((allowFalse && c.useOr) || (array.k === 'const' && array.isNull)) {
          return true;
        }
        const elements = array.k === 'const' ? countArrayElements(array.value) : array.k === 'array' && !array.multidims ? array.elements.length : 0;
        if (elements > 0) {
          return true;
        }
      }
      return clauseIsStrictFor(an, array, s, rt, false);
    }
    case 'const':
      return c.isNull;
    default:
      return false;
  }
}

function countArrayElements(value: unknown): number {
  return Array.isArray(value) ? value.reduce((n: number, el: unknown) => n + (Array.isArray(el) ? countArrayElements(el) : 1), 0) : 0;
}

/** Keys that never make two expressions differ: locations, slots, collations and — as PostgreSQL's equal() — coercion forms. */
const ARBITER_SKIP_KEYS = new Set(['location', 'id', 'aggIndex', 'winIndex', 'testSlot', 'elemSlot', 'correlated', 'collation', 'inputCollation', 'format']);

/**
 * Structural equality of an arbiter WHERE expression `a` (its Vars on the INSERT's target, range table
 * entry `rt`) and an index-predicate expression `b` (analysed over the relation alone): Vars match by
 * column; locations, collations and coercion forms (`x::t` written or implicit) are ignored.
 */
function sameArbiterExpr(a: unknown, b: unknown, rt: number): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameArbiterExpr(x, b[i], rt));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  if (ao.k === 'var' && bo.k === 'var') {
    return ao.levelsUp === 0 && bo.levelsUp === 0 && ao.rtIndex === rt && ao.attno === bo.attno;
  }
  if (ao.constructor !== bo.constructor) {
    return false;
  }
  if ('mag' in ao) {
    return String(ao) === String(bo);
  }
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!ARBITER_SKIP_KEYS.has(k) && !sameArbiterExpr(ao[k], bo[k], rt)) {
      return false;
    }
  }
  return true;
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
