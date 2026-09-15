import type * as A from '../ast';
import { Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { Query, RelationRTE, RTE, TExpr } from './nodes';
import { analyzeStatementAsSubquery } from './select';

/**
 * Automatically updatable views (rewriteHandler.c: rewriteTargetView).
 *
 * INSERT / UPDATE / DELETE whose target is a simple view — one base relation, no DISTINCT, GROUP BY,
 * HAVING, set operations, WITH, LIMIT / OFFSET, aggregates, window functions or set-returning
 * functions — are rewritten into the same statement on the base relation: references to the view's
 * columns become the view's column expressions, UPDATE / DELETE also apply the view's WHERE, and only
 * view columns that are plain columns of the base relation may be assigned. Nested views are rewritten
 * one level at a time.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Array.isArray(v));

const isQuery = (v: unknown): v is Query => isPlainObject(v) && !Array.isArray(v) && Array.isArray((v as { rtable?: unknown }).rtable) && 'commandType' in v;

/** Visit every expression node of a query tree with its query depth (nested queries are one level deeper). */
function walkTree(root: unknown, visit: (node: Record<string, unknown>, depth: number) => void): void {
  const seen = new Map<object, Set<number>>();
  const walk = (v: unknown, depth: number) => {
    if (!isPlainObject(v)) {
      return;
    }
    let depths = seen.get(v);
    if (!depths) {
      depths = new Set();
      seen.set(v, depths);
    }
    if (depths.has(depth)) {
      return;
    }
    depths.add(depth);
    if (Array.isArray(v)) {
      for (const x of v) {
        walk(x, depth);
      }
      return;
    }
    if (typeof v.k === 'string') {
      visit(v, depth);
    }
    for (const [key, child] of Object.entries(v)) {
      // a CTE reference points at the CteEntry of the level that defines it (walked through cteList)
      if (key === 'cte' && (v as { kind?: unknown }).kind === 'cte') {
        continue;
      }
      walk(child, isQuery(child) ? depth + 1 : depth);
    }
  };
  walk(root, isQuery(root) ? 0 : 0);
}

/** Deep copy of an analyzed expression (shared nodes stay shared, class instances are kept). */
function cloneTree<T>(v: T, memo = new Map<object, unknown>()): T {
  if (!isPlainObject(v)) {
    return v;
  }
  const hit = memo.get(v);
  if (hit) {
    return hit as T;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    memo.set(v, out);
    for (const x of v) {
      out.push(cloneTree(x, memo));
    }
    return out as T;
  }
  const out: Record<string, unknown> = {};
  memo.set(v, out);
  for (const [key, child] of Object.entries(v)) {
    out[key] = cloneTree(child, memo);
  }
  return out as T;
}

/** Shift Vars of the expression's own level by `rtOffset` and every Var's level by `levels`. */
function relocate<T>(e: T, rtOffset: number, levels: number): T {
  const copy = cloneTree(e);
  walkTree(copy, (node, depth) => {
    if (node.k !== 'var' && node.k !== 'agg') {
      return;
    }
    const levelsUp = node.levelsUp as number;
    if (node.k === 'var' && levelsUp === depth && (node.rtIndex as number) >= 0) {
      node.rtIndex = (node.rtIndex as number) + rtOffset;
    }
    if (levelsUp >= depth) {
      node.levelsUp = levelsUp + levels;
    }
  });
  return copy;
}

/** view_query_is_auto_updatable: null, or the reason the view is not automatically updatable. */
function autoUpdateDetail(an: Analyzer, vq: Query, checkColumns: boolean): string | null {
  if (vq.distinctClause) {
    return 'Views containing DISTINCT are not automatically updatable.';
  }
  if (vq.groupClause.length > 0 || vq.groupingSets) {
    return 'Views containing GROUP BY are not automatically updatable.';
  }
  if (vq.havingQual) {
    return 'Views containing HAVING are not automatically updatable.';
  }
  if (vq.setOperations) {
    return 'Views containing UNION, INTERSECT, or EXCEPT are not automatically updatable.';
  }
  if (vq.cteList.length > 0) {
    return 'Views containing WITH are not automatically updatable.';
  }
  if (vq.limitCount || vq.limitOffset) {
    return 'Views containing LIMIT or OFFSET are not automatically updatable.';
  }
  if (vq.hasAggs) {
    return 'Views that return aggregate functions are not automatically updatable.';
  }
  if (vq.hasWindowFuncs) {
    return 'Views that return window functions are not automatically updatable.';
  }
  if (vq.hasTargetSRFs) {
    return 'Views that return set-returning functions are not automatically updatable.';
  }
  const single = vq.fromlist.length === 1 && vq.fromlist[0].k === 'ref' ? vq.rtable[vq.fromlist[0].rtIndex] : null;
  const baseRel = single && single.kind === 'relation' ? an.catalog.getRelation(single.relOid) : null;
  if (!baseRel || !['r', 'p', 'v', 'f'].includes(baseRel.kind)) {
    return 'Views that do not select from a single table or view are not automatically updatable.';
  }
  if (checkColumns) {
    const baseRt = (vq.fromlist[0] as { rtIndex: number }).rtIndex;
    const anyUpdatable = vq.targetList.some((te) => !te.resjunk && columnNotUpdatableDetail(te.expr, baseRt) === null);
    if (!anyUpdatable) {
      return 'Views that have no updatable columns are not automatically updatable.';
    }
  }
  return null;
}

/** view_col_is_auto_updatable */
function columnNotUpdatableDetail(e: TExpr, baseRt: number): string | null {
  if (e.k !== 'var' || e.levelsUp !== 0 || e.rtIndex !== baseRt) {
    return 'View columns that are not columns of their base relation are not updatable.';
  }
  if (e.attno === -1) {
    return 'View columns that return whole-row references are not updatable.';
  }
  if (e.attno < 0) {
    return 'View columns that refer to system columns are not updatable.';
  }
  return null;
}

const COMMAND_TEXT: Record<string, { verb: string; hint: string }> = {
  insert: { verb: 'insert into', hint: 'To enable inserting into the view, provide an INSTEAD OF INSERT trigger or an unconditional ON INSERT DO INSTEAD rule.' },
  update: { verb: 'update', hint: 'To enable updating the view, provide an INSTEAD OF UPDATE trigger or an unconditional ON UPDATE DO INSTEAD rule.' },
  delete: { verb: 'delete from', hint: 'To enable deleting from the view, provide an INSTEAD OF DELETE trigger or an unconditional ON DELETE DO INSTEAD rule.' },
};

/** The view's query, with views it selects from kept as relation entries (a view over a view). */
function analyzeViewQuery(an: Analyzer, view: Relation): Query {
  return analyzeViewStatement(an, view.view!.query);
}

/** DefineView: WITH CHECK OPTION needs an automatically updatable view — null, or the reason it is not. */
export function viewStatementUpdateDetail(an: Analyzer, stmt: A.Statement): string | null {
  return autoUpdateDetail(an, analyzeViewStatement(an, stmt), true);
}

function analyzeViewStatement(an: Analyzer, stmt: A.Statement): Query {
  const { query: vq } = analyzeStatementAsSubquery(an, stmt, null, true);
  for (let i = 0; i < vq.rtable.length; i++) {
    const rte = vq.rtable[i];
    const inner = rte.kind === 'subquery' && rte.viewOid !== undefined ? an.catalog.getRelation(rte.viewOid) : undefined;
    if (rte.kind === 'subquery' && inner) {
      const live = inner.columns.filter((c) => !c.isDropped);
      vq.rtable[i] = {
        kind: 'relation',
        relOid: inner.oid,
        relkind: inner.kind,
        relname: inner.name,
        alias: rte.alias,
        eref: rte.eref,
        colTypes: live.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })),
        attnums: live.map((c) => c.attnum),
        inh: true,
        lateral: false,
      };
    }
  }
  return vq;
}

/** relation_is_updatable for information_schema.views: an automatically updatable view (INSERT, UPDATE and DELETE). */
export function viewIsAutoUpdatable(an: Analyzer, view: Relation, depth = 0): boolean {
  if (!view.view || depth > 32) {
    return false;
  }
  let vq: Query;
  try {
    vq = analyzeViewQuery(an, view);
  } catch {
    return false;
  }
  if (autoUpdateDetail(an, vq, true) !== null) {
    return false;
  }
  const base = an.catalog.getRelation((vq.rtable[(vq.fromlist[0] as { rtIndex: number }).rtIndex] as RelationRTE).relOid);
  return !!base && (base.kind !== 'v' || viewIsAutoUpdatable(an, base, depth + 1));
}

/** Rewrite an analyzed INSERT / UPDATE / DELETE on a view into one on the view's base relation (in place). */
export function rewriteTargetView(an: Analyzer, q: Query): void {
  for (let guard = 0; guard < 64; guard++) {
    const target = q.rtable[q.resultRelation] as RelationRTE;
    const view = an.catalog.getRelation(target.relOid);
    if (!view || view.kind !== 'v' || !view.view) {
      return;
    }
    rewriteOneLevel(an, q, view);
  }
  throw new PgError(SqlState.INVALID_OBJECT_DEFINITION, 'infinite recursion detected in rules for relation');
}

function rewriteOneLevel(an: Analyzer, q: Query, view: Relation): void {
  const command = COMMAND_TEXT[q.commandType];
  if (!command) {
    throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `cannot merge into view "${view.name}"`, {
      hint: 'To enable merging into the view, either provide a full set of INSTEAD OF triggers or drop existing rules.',
    });
  }
  for (const trg of an.catalog.triggers.values()) {
    if (trg.relOid === view.oid && trg.timing === 'INSTEAD OF' && trg.events.some((ev) => ev.toLowerCase() === q.commandType)) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: INSTEAD OF triggers on view "${view.name}" are not supported`);
    }
  }
  const vq = analyzeViewQuery(an, view);
  const detail = autoUpdateDetail(an, vq, q.commandType !== 'delete');
  if (detail) {
    throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `cannot ${command.verb} view "${view.name}"`, { detail, hint: command.hint });
  }
  const viewTargets = vq.targetList.filter((te) => !te.resjunk);
  const baseRtInView = (vq.fromlist[0] as { rtIndex: number }).rtIndex;

  // assigned columns must be plain columns of the base relation (view_cols_are_auto_updatable)
  const assigned = q.commandType === 'insert' ? (q.insertColumns ?? []) : q.commandType === 'update' ? (q.updateSet ?? []).map((s) => s.attIndex) : [];
  for (const index of assigned) {
    const colDetail = columnNotUpdatableDetail(viewTargets[index].expr, baseRtInView);
    if (colDetail) {
      const colName = view.columns.filter((c) => !c.isDropped)[index].name;
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cannot ${q.commandType === 'insert' ? 'insert into' : 'update'} column "${colName}" of view "${view.name}"`, { detail: colDetail });
    }
  }

  // the view's range table joins the statement's; the base relation becomes the result relation
  const offset = q.rtable.length;
  for (const rte of vq.rtable) {
    q.rtable.push(relocate(rte, offset, 0) as RTE);
  }
  const oldResult = q.resultRelation;
  const newResult = offset + baseRtInView;
  const baseRte = q.rtable[newResult] as RelationRTE;
  const viewRow = view.rowTypeOid || TypeOid.record;
  const liveNames = view.columns.filter((c) => !c.isDropped).map((c) => c.name);

  // RETURNING OLD / NEW read their own copies of the target
  const aliasTargets = new Map<number, number>([[oldResult, newResult]]);
  for (const key of ['returningOldRt', 'returningNewRt'] as const) {
    const rt = q[key];
    if (rt !== undefined && rt >= 0) {
      const copy: RelationRTE = { ...baseRte, alias: q.rtable[rt].alias, eref: { ...baseRte.eref, aliasname: q.rtable[rt].eref.aliasname } };
      q.rtable.push(copy);
      aliasTargets.set(rt, q.rtable.length - 1);
      q[key] = q.rtable.length - 1;
    }
  }

  const columnExpr = (attno: number, rtIndex: number, depth: number): TExpr => {
    const rtShift = rtIndex - newResult;
    if (attno === -1) {
      return {
        k: 'row',
        args: viewTargets.map((te) => relocate(te.expr, offset + rtShift, depth)),
        fieldNames: liveNames,
        explicitRow: false,
        type: viewRow,
        typmod: -1,
        collation: 0,
      } as TExpr;
    }
    return relocate(viewTargets[attno].expr, offset + rtShift, depth);
  };

  // references to the view's columns become the view's column expressions
  const replaceIn = (tree: unknown) =>
    walkTree(tree, (node, depth) => {
      if (node.k !== 'var' || node.levelsUp !== depth || !aliasTargets.has(node.rtIndex as number) || (node.attno as number) < -1) {
        return;
      }
      const replacement = columnExpr(node.attno as number, aliasTargets.get(node.rtIndex as number)!, depth);
      for (const key of Object.keys(node)) {
        delete node[key];
      }
      Object.assign(node, replacement);
    });
  replaceIn(q.targetList);
  replaceIn(q.returningList);
  replaceIn(q.where);
  replaceIn(q.fromlist);
  replaceIn(q.updateSet);
  replaceIn(q.insertSource);
  replaceIn(q.onConflict);
  replaceIn(q.cteList);
  replaceIn(q.withCheckOptions);
  for (let i = 0; i < offset; i++) {
    replaceIn(q.rtable[i]);
  }

  // column positions: view column -> base relation column
  const baseIndex = (viewIndex: number) => (viewTargets[viewIndex].expr as { attno: number }).attno;
  if (q.insertColumns) {
    q.insertColumns = q.insertColumns.map(baseIndex);
  }
  if (q.updateSet) {
    q.updateSet = q.updateSet.map((s) => ({ ...s, attIndex: baseIndex(s.attIndex) }));
  }
  // WITH [CASCADED | LOCAL] CHECK OPTION: new rows must satisfy the view's WHERE (a cascaded option of an
  // outer view applies to the views below it too); innermost view first
  if (q.commandType !== 'delete') {
    const parent = q.withCheckOptions?.[0];
    const hasCheck = !!view.view!.checkOption || !!parent?.cascaded;
    const cascaded = view.view!.checkOption === 'cascaded' || !!parent?.cascaded;
    if (hasCheck && (cascaded || vq.where)) {
      q.withCheckOptions = [{ viewName: view.name, qual: vq.where ? relocate(vq.where, offset, 0) : null, cascaded }, ...(q.withCheckOptions ?? [])];
    }
  }
  if (q.commandType !== 'insert') {
    q.fromlist = q.fromlist.map((j) => (j.k === 'ref' && j.rtIndex === oldResult ? { k: 'ref', rtIndex: newResult } : j));
    if (vq.where) {
      const viewQual = relocate(vq.where, offset, 0);
      q.where = q.where ? ({ k: 'bool', op: 'and', args: [q.where, viewQual], type: TypeOid.bool, typmod: -1, collation: 0 } as TExpr) : viewQual;
    }
  }
  q.resultRelation = newResult;
  baseRte.inh = baseRte.inh ?? true;
}
