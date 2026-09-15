import * as A from '../ast';
import { JoinTreeNode, makeConst, Query, TExpr } from '../analyze/nodes';
import { analyzeStatementAsSubquery } from '../analyze/select';
import { forEachChild, mapChildren, stripImplicitCoercions } from '../analyze/walk';
import { IndexInfo, Relation, TypeOid } from '../catalog/catalog';
import { expr as deparseExpr } from '../catalog/deparse';
import { Executor } from '../exec/executor';
import { EvalCtx, StatementState } from '../exec/runtime';
import type { Session } from '../session';
import { SessionHost } from '../session';
import type { UtilityResult } from './ddl';
import { evaluateExecuteParams, fetchPreparedStatement, revalidatePrepared } from './prepared';

/**
 * EXPLAIN.
 *
 * The in-memory engine has no cost-based planner, so this describes the plan PostgreSQL would
 * typically choose for the analyzed query: scans use an index when a restriction matches the
 * index's leading key (column, expression, pattern or GIN operator, OR-ed arms as a BitmapOr) and
 * the table is not tiny; equi-joins become hash joins or index nested loops; sort / aggregate /
 * limit / locking nodes follow the query clauses. Plan shape and names are what tests inspect —
 * costs are not reported (COSTS OFF output); ANALYZE runs the statement.
 */

interface PlanNode {
  label: string;
  props: [string, string][];
  children: PlanNode[];
  json: Record<string, unknown>;
  /** estimated output rows (drives join method choice) */
  rows: number;
}

/** below this many rows a sequential scan is cheaper than any index access */
const SMALL_TABLE_ROWS = 100;

const node = (label: string, json: Record<string, unknown>, children: PlanNode[] = [], props: [string, string][] = [], rows?: number): PlanNode => ({
  label,
  props,
  children,
  json,
  rows: rows ?? children.reduce((m, c) => Math.max(m, c.rows), 1),
});

/** A query that only projects its single *SELECT* subquery (INSERT's assignments to parts of columns). */
function isTrivialProjection(q: Query): boolean {
  const from = q.fromlist[0];
  return (
    q.fromlist.length === 1 &&
    from.k === 'ref' &&
    q.rtable[from.rtIndex]?.kind === 'subquery' &&
    q.rtable[from.rtIndex].eref.aliasname === '*SELECT*' &&
    !q.where &&
    !q.setOperations &&
    !q.hasAggs &&
    !q.hasWindowFuncs &&
    q.groupClause.length === 0 &&
    q.sortClause.length === 0 &&
    !q.distinctClause &&
    !q.limitCount &&
    !q.limitOffset
  );
}

/** clause selectivity without statistics (PostgreSQL's DEFAULT_EQ_SEL / DEFAULT_INEQ_SEL family) */
function selectivity(c: TExpr): number {
  const e = stripImplicitCoercions(c);
  switch (e.k) {
    case 'op':
      return e.opName === '=' ? 0.005 : e.opName === '<>' ? 0.995 : ['<', '<=', '>', '>='].includes(e.opName) ? 1 / 3 : e.opName === '~~' || e.opName === '~~*' ? 0.005 : 1 / 3;
    case 'saop': {
      const arr = stripImplicitCoercions(e.args[1]);
      const n = arr.k === 'array' ? arr.elements.length : arr.k === 'const' && Array.isArray(arr.value) ? arr.value.length : 10;
      return e.useOr ? Math.min(1, 0.005 * n) : 0.005;
    }
    case 'nulltest':
      return e.isNot ? 0.995 : 0.005;
    case 'bool':
      if (e.op === 'and') {
        return e.args.reduce((s, a) => s * selectivity(a), 1);
      }
      if (e.op === 'or') {
        return 1 - e.args.reduce((s, a) => s * (1 - selectivity(a)), 1);
      }
      return 1 - selectivity(e.args[0]);
    case 'var':
      return 0.5;
    default:
      return 1 / 3;
  }
}

class Explainer {
  private subplans = 0;
  private readonly host: SessionHost;
  /** sublinks planned as semi / anti joins */
  private readonly pulledUp = new Set<TExpr>();

  constructor(
    private readonly session: Session,
    private readonly st: StatementState
  ) {
    this.host = new SessionHost(session, st);
  }

  // ---------------------------------------------------------------------------
  // Query level
  // ---------------------------------------------------------------------------

  planQuery(q: Query): PlanNode {
    let plan: PlanNode;
    if (q.setOperations) {
      plan = this.planSetOp(q, q.setOperations);
    } else if (q.commandType === 'insert') {
      const rel = this.relOf(q, q.resultRelation);
      const children: PlanNode[] = [];
      if (q.insertSource?.kind === 'select') {
        // the *SELECT* subquery (and the projection of assignments to array elements / subfields over it)
        // is pulled up: its scan is trivial under ModifyTable
        let source = q.rtable[q.insertSource.rtIndex];
        while (source.kind === 'subquery' && source.eref.aliasname === '*SELECT*' && isTrivialProjection(source.subquery)) {
          source = source.subquery.rtable[(source.subquery.fromlist[0] as { rtIndex: number }).rtIndex];
        }
        children.push(source.kind === 'subquery' && source.eref.aliasname === '*SELECT*' ? this.planQuery(source.subquery) : this.planRte(q, q.insertSource.rtIndex, []));
      } else if (q.insertSource?.kind === 'values' && q.insertSource.rows.length > 1) {
        children.push(node('Values Scan on "*VALUES*"', { 'Node Type': 'Values Scan' }));
      } else {
        children.push(node('Result', { 'Node Type': 'Result' }));
      }
      plan = node(`Insert on ${rel?.name ?? '?'}`, { 'Node Type': 'ModifyTable', Operation: 'Insert', 'Relation Name': rel?.name }, children);
      if (q.onConflict) {
        plan.props.push(['Conflict Resolution', q.onConflict.action]);
      }
    } else {
      plan = this.planJoinTree(q);
      if (q.commandType === 'update' || q.commandType === 'delete' || q.commandType === 'merge') {
        const rel = this.relOf(q, q.resultRelation);
        const op = q.commandType === 'update' ? 'Update' : q.commandType === 'delete' ? 'Delete' : 'Merge';
        return this.withSubPlans(q, node(`${op} on ${rel?.name ?? '?'}`, { 'Node Type': 'ModifyTable', Operation: op, 'Relation Name': rel?.name }, [plan]));
      }
      if (q.hasAggs || q.groupClause.length > 0) {
        plan =
          q.groupClause.length > 0
            ? node('HashAggregate', { 'Node Type': 'Aggregate', Strategy: 'Hashed' }, [plan], [['Group Key', q.groupClause.map((g) => this.sortExpr(q, g.tleSortGroupRef)).join(', ')]])
            : node('Aggregate', { 'Node Type': 'Aggregate', Strategy: 'Plain' }, [plan]);
      }
      if (q.hasWindowFuncs) {
        plan = node('WindowAgg', { 'Node Type': 'WindowAgg' }, [plan]);
      }
      if (q.distinctClause && q.distinctClause.length > 0) {
        plan = q.hasDistinctOn ? node('Unique', { 'Node Type': 'Unique' }, [plan]) : node('HashAggregate', { 'Node Type': 'Aggregate', Strategy: 'Hashed' }, [plan]);
      }
    }
    if (q.sortClause.length > 0) {
      plan = node('Sort', { 'Node Type': 'Sort' }, [plan], [['Sort Key', q.sortClause.map((s) => this.sortExpr(q, s.tleSortGroupRef) + (s.desc ? ' DESC' : '')).join(', ')]]);
    }
    if (q.rowMarks.length > 0) {
      plan = node('LockRows', { 'Node Type': 'LockRows' }, [plan]);
    }
    if (q.limitCount || q.limitOffset) {
      plan = node('Limit', { 'Node Type': 'Limit' }, [plan]);
    }
    return this.withSubPlans(q, plan);
  }

  private planSetOp(q: Query, tree: NonNullable<Query['setOperations']>): PlanNode {
    if (tree.k === 'leaf') {
      return this.planRte(q, tree.rtIndex, []);
    }
    const kids = [this.planSetOp(q, tree.larg), this.planSetOp(q, tree.rarg)];
    if (tree.op === 'UNION') {
      const append = node('Append', { 'Node Type': 'Append' }, kids);
      return tree.all ? append : node('HashAggregate', { 'Node Type': 'Aggregate', Strategy: 'Hashed' }, [append]);
    }
    const cmd = `${tree.op === 'INTERSECT' ? 'Intersect' : 'Except'}${tree.all ? ' All' : ''}`;
    return node(`HashSetOp ${cmd}`, { 'Node Type': 'SetOp', Command: cmd }, [node('Append', { 'Node Type': 'Append' }, kids)]);
  }

  /** CTEs and sublinks of a query level, as InitPlan / SubPlan children. */
  private withSubPlans(q: Query, plan: PlanNode): PlanNode {
    for (const cte of q.cteList) {
      if (cte.isModifying || cte.refCount !== 1 || cte.recursive || cte.materialized === 'ALWAYS') {
        plan.children.push(this.subplan(`CTE ${cte.name}`, cte.query));
      }
    }
    const visit = (e: TExpr | null | undefined) => {
      if (!e) {
        return;
      }
      if (e.k === 'sublink' && !this.pulledUp.has(e)) {
        const kind = e.correlated ? 'SubPlan' : 'InitPlan';
        plan.children.push(this.subplan(`${kind} ${++this.subplans}`, e.subquery));
      }
      forEachChild(e, visit);
    };
    visit(q.where);
    visit(q.havingQual);
    for (const t of q.targetList) {
      visit(t.expr);
    }
    for (const t of q.returningList) {
      visit(t.expr);
    }
    for (const s of q.updateSet ?? []) {
      visit(s.expr);
    }
    const joinQuals = (n: JoinTreeNode) => {
      if (n.k === 'join') {
        visit(n.quals);
        joinQuals(n.larg);
        joinQuals(n.rarg);
      }
    };
    q.fromlist.forEach(joinQuals);
    return plan;
  }

  private subplan(label: string, q: Query): PlanNode {
    const inner = this.planQuery(q);
    return { ...inner, label: `${label}\n${inner.label}`, json: { ...inner.json, 'Subplan Name': label } };
  }

  // ---------------------------------------------------------------------------
  // FROM / joins
  // ---------------------------------------------------------------------------

  private planJoinTree(q: Query): PlanNode {
    if (q.fromlist.length === 0) {
      return node('Result', { 'Node Type': 'Result' });
    }
    // pull_up_sublinks: [NOT] EXISTS / IN (subquery) over one relation become semi / anti joins
    const semis: { sub: Query; anti: boolean; testLeft: TExpr | null }[] = [];
    const conjuncts = splitAnd(q.where).filter((c) => {
      const pulled = pullableSublink(c);
      if (!pulled) {
        return true;
      }
      semis.push(pulled);
      this.pulledUp.add(pulled.sublink);
      return false;
    });
    let plan = this.planFromItem(q, q.fromlist[0], conjuncts);
    let leftRels = relsOfTree(q, q.fromlist[0]);
    for (let i = 1; i < q.fromlist.length; i++) {
      const rightRels = relsOfTree(q, q.fromlist[i]);
      const quals = conjuncts.filter((c) => {
        const refs = varRels(q, c);
        return refs.size > 1 && [...refs].every((r) => leftRels.has(r) || rightRels.has(r));
      });
      plan = this.joinNode(q, 'INNER', plan, q.fromlist[i], leftRels, rightRels, quals, conjuncts);
      rightRels.forEach((r) => leftRels.add(r));
      leftRels = new Set(leftRels);
    }
    for (const semi of semis) {
      // the subquery's range table is appended to this level; its outer references become local
      const offset = q.rtable.length;
      const merged: Query = { ...q, rtable: [...q.rtable, ...semi.sub.rtable] };
      const innerRt = offset + (semi.sub.fromlist[0] as { rtIndex: number }).rtIndex;
      const lift = (e: TExpr) => liftVars(e, offset);
      const innerConj = splitAnd(semi.sub.where).map(lift);
      if (semi.testLeft) {
        innerConj.push({ k: 'op', opName: '=', opOid: 0, funcSrc: '', funcOid: 0, args: [semi.testLeft, lift(semi.sub.targetList[0].expr)], inputCollation: 0, retset: false, type: TypeOid.bool, typmod: -1, collation: 0 });
      }
      const cross = innerConj.filter((c) => !onlyRel(merged, c, innerRt));
      plan = this.joinNode(merged, semi.anti ? 'ANTI' : 'SEMI', plan, { k: 'ref', rtIndex: innerRt }, leftRels, new Set([innerRt]), cross, innerConj);
    }
    return plan;
  }

  private planFromItem(q: Query, item: JoinTreeNode, conjuncts: TExpr[]): PlanNode {
    if (item.k === 'ref') {
      return this.planRte(q, item.rtIndex, conjuncts.filter((c) => onlyRel(q, c, item.rtIndex)));
    }
    const left = this.planFromItem(q, item.larg, conjuncts);
    if (item.joinType === 'LEFT' && item.rarg.k === 'ref' && this.removableLeftJoin(q, item, item.rarg.rtIndex)) {
      return left;
    }
    const leftRels = relsOfTree(q, item.larg);
    const rightRels = relsOfTree(q, item.rarg);
    return this.joinNode(q, item.joinType, left, item.rarg, leftRels, rightRels, splitAnd(item.quals), conjuncts);
  }

  /**
   * join_is_removable: a LEFT JOIN to a relation whose join clauses pin a unique index, when nothing
   * above the join reads the relation's columns, cannot change the result and is dropped.
   */
  private removableLeftJoin(q: Query, join: JoinTreeNode & { k: 'join' }, rt: number): boolean {
    const rel = this.relOf(q, rt);
    if (!rel) {
      return false;
    }
    const quals = splitAnd(join.quals);
    const pinned = new Set<number>();
    for (const c of quals) {
      const e = stripImplicitCoercions(c);
      const refs = varRels(q, c);
      if (!refs.has(rt)) {
        continue;
      }
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2) {
        return false;
      }
      const sides = e.args.map((a) => stripImplicitCoercions(a));
      const mine = sides.findIndex((s) => s.k === 'var' && s.levelsUp === 0 && s.rtIndex === rt);
      if (mine < 0 || varRels(q, sides[1 - mine]).has(rt)) {
        return false;
      }
      const v = sides[mine] as TExpr & { k: 'var' };
      pinned.add(rteAttnum(q, rt, v.attno));
    }
    const unique = this.session
      .catalog()
      .indexesOf(rel.oid)
      .some((ix) => ix.index && ix.index.unique && ix.index.valid && !ix.index.predicate && ix.index.keys.every((k) => k.attnum > 0 && pinned.has(k.attnum)));
    if (!unique) {
      return false;
    }
    // no reference to the relation outside this join's own clauses
    let used = false;
    const check = (e: TExpr | null | undefined) => {
      if (!used && e && (varRels(q, e).has(rt) || containsSublinkRef(e, rt))) {
        used = true;
      }
    };
    q.targetList.forEach((t) => check(t.expr));
    q.returningList.forEach((t) => check(t.expr));
    check(q.where);
    check(q.havingQual);
    const otherJoins = (n: JoinTreeNode) => {
      if (n.k === 'join') {
        if (n !== join) {
          check(n.quals);
        }
        otherJoins(n.larg);
        otherJoins(n.rarg);
      }
    };
    q.fromlist.forEach(otherJoins);
    for (const r of q.rtable) {
      if (!used && r && r.kind === 'subquery' && queryRefersTo(r.subquery, 1, rt)) {
        used = true;
      }
    }
    return !used;
  }

  private joinNode(q: Query, joinType: string, left: PlanNode, rightItem: JoinTreeNode, leftRels: Set<number>, rightRels: Set<number>, quals: TExpr[], conjuncts: TExpr[]): PlanNode {
    const typeName = joinType === 'LEFT' ? ' Left' : joinType === 'RIGHT' ? ' Right' : joinType === 'FULL' ? ' Full' : joinType === 'SEMI' ? ' Semi' : joinType === 'ANTI' ? ' Anti' : '';
    // equality between the two sides: hash join, or a nested loop probing an index of the inner relation
    const equi = quals.filter((c) => {
      const e = stripImplicitCoercions(c);
      if (e.k !== 'op' || e.opName !== '=' || e.args.length !== 2) {
        return false;
      }
      const l = varRels(q, e.args[0]);
      const r = varRels(q, e.args[1]);
      return l.size > 0 && r.size > 0 && ((subset(l, leftRels) && subset(r, rightRels)) || (subset(l, rightRels) && subset(r, leftRels)));
    });
    // join clauses are shown outer side first
    const cond = (list: TExpr[]) =>
      this.quals(
        q,
        list.map((c) => (c.k === 'op' && c.args.length === 2 && COMMUTED[c.opName] && subset(varRels(q, c.args[0]), rightRels) && varRels(q, c.args[0]).size > 0 ? { ...c, opName: COMMUTED[c.opName], args: [c.args[1], c.args[0]] } : c)),
        false
      );
    if (rightItem.k === 'ref' && equi.length > 0 && joinType !== 'FULL') {
      const rt = rightItem.rtIndex;
      const rel = this.relOf(q, rt);
      const innerRows = rel ? this.rowCount(rel) : 0;
      // index nested loop when probing once per outer row beats hashing the inner relation
      if (rel && innerRows >= SMALL_TABLE_ROWS && left.rows * 4 < innerRows * 0.02 + left.rows * 0.01) {
        const probe = this.indexFor(q, rt, rel, equi.map((c) => ({ c, paramSides: true })), true);
        if (probe) {
          const inner = this.planRte(q, rt, conjuncts.filter((c) => onlyRel(q, c, rt)), probe);
          const others = quals.filter((c) => !probe.used.includes(c));
          const nl = node(`Nested Loop${typeName} Join`, { 'Node Type': 'Nested Loop', 'Join Type': joinType }, [left, inner], [], Math.max(1, left.rows * inner.rows));
          if (others.length) {
            nl.props.push(['Join Filter', cond(others)]);
          }
          return nl;
        }
      }
    }
    const right = this.planFromItem(q, rightItem, conjuncts);
    if (equi.length > 0) {
      const hj = node(`Hash${typeName} Join`, { 'Node Type': 'Hash Join', 'Join Type': joinType }, [left, node('Hash', { 'Node Type': 'Hash' }, [right])], [['Hash Cond', cond(equi)]], Math.max(left.rows, right.rows));
      const others = quals.filter((c) => !equi.includes(c));
      if (others.length) {
        hj.props.push(['Join Filter', cond(others)]);
      }
      return hj;
    }
    const nl = node(`Nested Loop${typeName} Join`, { 'Node Type': 'Nested Loop', 'Join Type': joinType }, [left, right], [], Math.max(1, left.rows * right.rows * (quals.length ? 1 / 3 : 1)));
    if (quals.length) {
      nl.props.push(['Join Filter', cond(quals)]);
    }
    return nl;
  }

  private planRte(q: Query, rt: number, quals: TExpr[], probe?: IndexChoice): PlanNode {
    const rte = q.rtable[rt];
    const aliasSuffix = (name: string) => (rte.eref.aliasname !== name ? ` ${rte.eref.aliasname}` : '');
    const filter = (n: PlanNode, list: TExpr[]) => {
      if (list.length) {
        n.props.push(['Filter', this.quals(q, list, rt)]);
      }
      return n;
    };
    switch (rte.kind) {
      case 'relation': {
        const rel = this.session.catalog().getRelation(rte.relOid);
        if (!rel) {
          return filter(node(`Seq Scan on ${rte.relname}`, { 'Node Type': 'Seq Scan', 'Relation Name': rte.relname }), quals);
        }
        return this.scanRelation(q, rt, rel, quals, probe);
      }
      case 'subquery': {
        const inner = this.planQuery(rte.subquery);
        return filter(node(`Subquery Scan on ${rte.eref.aliasname}`, { 'Node Type': 'Subquery Scan', Alias: rte.eref.aliasname }, [inner]), quals);
      }
      case 'function': {
        const f = rte.functions[0]?.expr;
        const fname = f && f.k === 'func' ? f.funcName : 'function';
        return filter(node(`Function Scan on ${fname}${aliasSuffix(fname)}`, { 'Node Type': 'Function Scan', 'Function Name': fname, Alias: rte.eref.aliasname }), quals);
      }
      case 'values':
        return filter(node(`Values Scan on "*VALUES*"`, { 'Node Type': 'Values Scan' }), quals);
      case 'cte': {
        const cte = rte.cte;
        if (cte && !cte.recursive && !cte.isModifying && cte.refCount === 1 && cte.materialized !== 'ALWAYS') {
          // inlined into the referencing query (PostgreSQL 12+)
          const inner = this.planQuery(cte.query);
          return filter(node(`Subquery Scan on ${rte.eref.aliasname}`, { 'Node Type': 'Subquery Scan', Alias: rte.eref.aliasname }, [inner]), quals);
        }
        return filter(node(`CTE Scan on ${rte.ctename}${aliasSuffix(rte.ctename)}`, { 'Node Type': 'CTE Scan', 'CTE Name': rte.ctename }), quals);
      }
      case 'catalog':
        return filter(node(`Seq Scan on ${rte.relname}${aliasSuffix(rte.relname)}`, { 'Node Type': 'Seq Scan', 'Relation Name': rte.relname }), quals);
      default:
        return node('Result', { 'Node Type': 'Result' });
    }
  }

  // ---------------------------------------------------------------------------
  // Scans and index matching
  // ---------------------------------------------------------------------------

  private scanRelation(q: Query, rt: number, rel: Relation, quals: TExpr[], probe?: IndexChoice): PlanNode {
    const rte = q.rtable[rt];
    const on = `${rel.name}${rte.eref.aliasname !== rel.name ? ` ${rte.eref.aliasname}` : ''}`;
    const json = { 'Relation Name': rel.name, Alias: rte.eref.aliasname };
    const total = this.rowCount(rel);
    const big = total >= SMALL_TABLE_ROWS;
    const choice = probe ?? (big ? this.indexFor(q, rt, rel, quals.map((c) => ({ c, paramSides: false }))) : null);
    const estimate = choice && choice.arms.length === 1 && choice.arms[0].uniqueEq ? 1 : Math.max(1, Math.round(total * quals.reduce((s, c) => s * selectivity(c), probe ? 0.005 : 1)));
    if (choice) {
      const indexCond = (conds: TExpr[]) => this.quals(q, conds.flatMap((c) => this.indexCondForDisplay(q, rt, c)), rt);
      if (choice.bitmap) {
        const or = choice.arms.length > 1;
        // a BitmapOr rechecks the OR of its arms' index conditions and filters with every clause
        const recheckList = or ? [{ k: 'bool', op: 'or', args: choice.arms.map((a) => andOf(a.conds.filter((c) => !isLike(c)))), type: TypeOid.bool, typmod: -1, collation: 0 } as TExpr] : choice.used;
        const scan = node(`Bitmap Heap Scan on ${on}`, { 'Node Type': 'Bitmap Heap Scan', ...json }, [], [], estimate);
        if (recheckList.length) {
          scan.props.push(['Recheck Cond', this.quals(q, recheckList, rt)]);
        }
        const filter = or ? quals : quals.filter((c) => !choice.used.includes(c));
        if (filter.length) {
          scan.props.push(['Filter', this.quals(q, filter, rt)]);
        }
        const bitmapScans = choice.arms.map((arm) => node(`Bitmap Index Scan on ${arm.index.name}`, { 'Node Type': 'Bitmap Index Scan', 'Index Name': arm.index.name }, [], [['Index Cond', indexCond(arm.conds)]], estimate));
        scan.children.push(or ? node('BitmapOr', { 'Node Type': 'BitmapOr' }, bitmapScans, [], estimate) : bitmapScans[0]);
        return scan;
      }
      const arm = choice.arms[0];
      const rest = quals.filter((c) => !choice.used.includes(c));
      const scan = node(`Index Scan using ${arm.index.name} on ${on}`, { 'Node Type': 'Index Scan', 'Index Name': arm.index.name, ...json }, [], [['Index Cond', indexCond(arm.conds)]], estimate);
      if (rest.length) {
        scan.props.push(['Filter', this.quals(q, rest, rt)]);
      }
      return scan;
    }
    const scan = node(`Seq Scan on ${on}`, { 'Node Type': 'Seq Scan', ...json }, [], [], estimate);
    if (quals.length) {
      scan.props.push(['Filter', this.quals(q, quals, rt)]);
    }
    return scan;
  }

  /** Index conditions as EXPLAIN shows them: indexed side first; LIKE on pattern_ops as its prefix range. */
  private indexCondForDisplay(q: Query, rt: number, c: TExpr): TExpr[] {
    const e = stripImplicitCoercions(c);
    if (isLike(e) && e.k === 'op') {
      const prefix = this.likePrefix(q, e.args[1]);
      if (prefix !== null) {
        const text = (value: string): TExpr => makeConst(TypeOid.text, value);
        const op = (name: string, value: string): TExpr => ({ ...e, opName: name, args: [e.args[0], text(value)] });
        if (!/[%_\\]/.test(this.likePattern(q, e.args[1]) ?? '%')) {
          return [op('=', prefix)];
        }
        const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
        return [op('~>=~', prefix), op('~<~', upper)];
      }
    }
    return [indexSideLeft(q, c, rt)];
  }

  /**
   * Best index access for a set of restriction clauses of relation `rt`: equality on a unique key is
   * an Index Scan; other matches are bitmap scans (plain index scans when probing inside a nested loop).
   */
  private indexFor(q: Query, rt: number, rel: Relation, clauses: { c: TExpr; paramSides: boolean }[], probe = false): IndexChoice | null {
    const indexes = this.session
      .catalog()
      .indexesOf(rel.oid)
      .filter((ix) => ix.index && ix.index.valid && !ix.index.exclusion);
    if (indexes.length === 0) {
      return null;
    }
    let best: { index: Relation; conds: TExpr[]; score: number; uniqueEq: boolean } | null = null;
    for (const ix of indexes) {
      const info = ix.index!;
      if (info.predicate && !this.predicateImplied(q, rt, rel, info, clauses.map((x) => x.c))) {
        continue;
      }
      const conds: TExpr[] = [];
      let eqKeys = 0;
      for (let k = 0; k < info.keys.length; k++) {
        const matched = clauses.filter((x) => this.clauseMatchesKey(q, rt, rel, info, k, x.c, x.paramSides)).map((x) => x.c);
        if (matched.length === 0) {
          break;
        }
        conds.push(...matched);
        if (!matched.some((c) => isEquality(c))) {
          break;
        }
        eqKeys++;
      }
      if (conds.length === 0) {
        continue;
      }
      const uniqueEq = info.unique && eqKeys === info.keys.length && info.method === 'btree';
      const score = (uniqueEq ? 1000 : 0) + eqKeys * 10 + conds.length + (info.unique ? 0.5 : 0) - info.keys.length * 0.01;
      if (!best || score > best.score) {
        best = { index: ix, conds, score, uniqueEq };
      }
    }
    if (best) {
      const info = best.index.index!;
      const method = info.method;
      // a plain index scan when equality on the whole key finds (about) one row; otherwise a bitmap scan
      const pointLookup =
        best.uniqueEq ||
        (method === 'btree' &&
          best.conds.filter((c) => isEquality(c)).length >= info.keys.length &&
          this.rowCount(rel) / this.distinctKeys(rel, info) <= 2);
      const bitmap = method === 'gin' || method === 'gist' || (!pointLookup && !probe);
      return { bitmap, arms: [{ index: best.index, conds: best.conds, uniqueEq: best.uniqueEq }], used: best.conds.filter((c) => !isLike(c)) };
    }
    // OR of indexable arms: BitmapOr over one index scan per arm
    for (const { c } of clauses) {
      const e = stripImplicitCoercions(c);
      if (e.k !== 'bool' || e.op !== 'or') {
        continue;
      }
      const arms: IndexChoice['arms'] = [];
      for (const arm of e.args) {
        const choice = this.indexFor(
          q,
          rt,
          rel,
          splitAnd(arm).map((x) => ({ c: x, paramSides: false }))
        );
        if (!choice || choice.arms.length !== 1) {
          arms.length = 0;
          break;
        }
        arms.push(choice.arms[0]);
      }
      if (arms.length > 0) {
        return { bitmap: true, arms, used: [c] };
      }
    }
    return null;
  }


  /** Does `clause` restrict key `keyNo` of the index (indexable operator, other side free of this relation)? */
  private clauseMatchesKey(q: Query, rt: number, rel: Relation, info: IndexInfo, keyNo: number, clause: TExpr, otherSideMayReferenceOtherRels: boolean): boolean {
    const key = info.keys[keyNo];
    if (!key) {
      return false;
    }
    const e = stripImplicitCoercions(clause);
    const opclass = this.session.catalog().builtin.opclasses.get(key.opclassOid)?.name ?? '';
    const matchesKey = (side: TExpr): boolean => {
      const s = stripImplicitCoercions(side);
      if (key.attnum > 0) {
        return s.k === 'var' && s.levelsUp === 0 && s.rtIndex === rt && rteAttnum(q, rt, s.attno) === key.attnum;
      }
      if (!key.expr) {
        return false;
      }
      const indexExpr = this.host.analyzeRelationExpr(rel, key.expr, 'index').expr;
      return sameExpr(s, stripImplicitCoercions(indexExpr), rt);
    };
    // restriction clauses compare with constants / parameters / outer references; join clauses
    // (a parameterized inner index scan) with columns of the other relations
    const freeOfRel = (side: TExpr) => {
      const refs = varRels(q, side);
      return !refs.has(rt) && (otherSideMayReferenceOtherRels || refs.size === 0);
    };
    const btreeOps = ['=', '<', '<=', '>', '>='];
    if (e.k === 'op' && e.args.length === 2) {
      const [a, b] = e.args;
      const keySide = matchesKey(a) && freeOfRel(b) ? b : matchesKey(b) && freeOfRel(a) ? a : null;
      if (!keySide) {
        return false;
      }
      switch (info.method) {
        case 'btree':
          if (btreeOps.includes(e.opName)) {
            return true;
          }
          if (e.opName === '~~' && keySide === b) {
            // LIKE is a range scan on pattern_ops indexes when the pattern has a fixed prefix
            return /pattern_ops$/.test(opclass) && this.likePrefix(q, b) !== null;
          }
          return false;
        case 'hash':
          return e.opName === '=';
        case 'gin':
          if (/trgm/.test(opclass)) {
            return ['~~', '~~*', '~', '~*', '%', '='].includes(e.opName);
          }
          return ['@>', '<@', '?', '?|', '?&', '&&', '@@', '@?'].includes(e.opName);
        case 'gist':
          return /trgm/.test(opclass) ? ['~~', '~~*', '%', '<->'].includes(e.opName) : ['&&', '@>', '<@', '<<', '>>', '~=', '-|-'].includes(e.opName);
        default:
          return false;
      }
    }
    if (e.k === 'saop' && e.useOr && (info.method === 'btree' || info.method === 'hash') && e.opName === '=') {
      return matchesKey(e.args[0]) && freeOfRel(e.args[1]);
    }
    if (e.k === 'nulltest' && info.method === 'btree') {
      return !e.isNot && matchesKey(e.arg);
    }
    return false;
  }

  /** The LIKE pattern value (a constant, or computable from parameters), or null. */
  private likePattern(q: Query, pattern: TExpr): string | null {
    if (varRels(q, pattern).size > 0) {
      return null;
    }
    try {
      const executor = new Executor(this.st, this.host);
      this.host.executor = executor;
      const v = executor.planFor(q, null).ev(pattern)(new EvalCtx([], null, this.st));
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  /** like_fixed_prefix: the literal characters before the first wildcard (null when there are none). */
  private likePrefix(q: Query, pattern: TExpr): string | null {
    const v = this.likePattern(q, pattern);
    if (v === null) {
      return null;
    }
    let prefix = '';
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (ch === '%' || ch === '_') {
        break;
      }
      if (ch === '\\' && i + 1 < v.length) {
        prefix += v[++i];
        continue;
      }
      prefix += ch;
    }
    return prefix.length > 0 ? prefix : null;
  }

  /** Partial index: every conjunct of the predicate appears among the restriction clauses. */
  private predicateImplied(q: Query, rt: number, rel: Relation, info: IndexInfo, clauses: TExpr[]): boolean {
    const pred = this.host.analyzeRelationExpr(rel, info.predicate!, 'predicate').expr;
    return splitAnd(pred).every((p) => clauses.some((c) => sameExpr(stripImplicitCoercions(c), stripImplicitCoercions(p), rt)));
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** number of distinct key values of an index (the statistics ANALYZE would gather), from a sample */
  private distinctKeys(rel: Relation, info: IndexInfo): number {
    const heap = this.session.db.store.getHeap(rel.storageId);
    const vis = this.session.db.store.vis;
    const keyEvals = info.keys.map((k) => {
      if (k.attnum > 0) {
        return (data: unknown[]) => (k.attnum - 1 < data.length ? data[k.attnum - 1] : null);
      }
      const { q, expr } = this.host.analyzeRelationExpr(rel, k.expr!, 'index');
      const executor = new Executor(this.st, this.host);
      this.host.executor = executor;
      const ev = executor.planFor(q, null).ev(expr);
      return (data: unknown[], t: unknown) => ev(new EvalCtx([data, t], null, this.st));
    });
    const seen = new Set<string>();
    let sampled = 0;
    for (const t of heap.tuples) {
      if (sampled >= 20000) {
        break;
      }
      if (!vis.visible(t, this.st.snapshot)) {
        continue;
      }
      sampled++;
      try {
        seen.add(JSON.stringify(keyEvals.map((f) => f(t.data, t)), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      } catch {
        return 1;
      }
    }
    return Math.max(1, Math.round((seen.size * this.rowCount(rel)) / Math.max(1, sampled)));
  }

  private relOf(q: Query, rt: number): Relation | undefined {
    const rte = q.rtable[rt];
    return rte && rte.kind === 'relation' ? this.session.catalog().getRelation(rte.relOid) : undefined;
  }

  private rowCount(rel: Relation): number {
    if (rel.kind === 'p') {
      return this.session.catalog().childrenOf(rel.oid).reduce((n, c) => n + this.rowCount(c), 0);
    }
    return this.session.relationRowCount(rel.oid);
  }

  private sortExpr(q: Query, ref: number): string {
    const tle = q.targetList.find((t) => t.sortGroupRef === ref);
    return tle ? this.text(q, tle.expr) : '?';
  }

  /**
   * Deparse a plan expression the way EXPLAIN shows it after eval_const_expressions: parameters
   * and immutable calls over constants are folded, `x = true` is `x`. Scan quals are unqualified;
   * join clauses and sort keys carry the relation prefix when the query has several relations.
   */
  private text(q: Query, e: TExpr, scanRt: number | false = false): string {
    try {
      // scan quals name other relations' columns (nested loop parameters) only
      const qualify = scanRt === false ? q.rtable.filter((r) => r && r.kind !== 'join').length > 1 : [...varRels(q, e)].some((r) => r !== scanRt);
      return deparseExpr({ session: this.session, catalog: this.session.catalog(), types: this.session.makeAnalyzer().types, pretty: false, q, qualifyVars: qualify, unqualifiedRt: scanRt === false ? undefined : scanRt }, this.fold(q, e), false);
    } catch {
      return '?';
    }
  }

  /** show_qual: an implicitly AND-ed clause list */
  private quals(q: Query, list: TExpr[], scanRt: number | false): string {
    return this.text(q, andOf(list), scanRt);
  }

  private fold(q: Query, e: TExpr): TExpr {
    const mapped = mapChildren(e, (c) => this.fold(q, c));
    if (mapped.k === 'param' && mapped.paramId >= 1 && mapped.paramId <= this.st.params.length) {
      return makeConst(mapped.type, this.st.params[mapped.paramId - 1], mapped.typmod, mapped.collation);
    }
    if (mapped.k === 'op' && mapped.opName === '=' && mapped.type === TypeOid.bool) {
      const [a, b] = mapped.args;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        if (y.k === 'const' && !y.isNull && y.type === TypeOid.bool && x.type === TypeOid.bool && x.k !== 'const') {
          return y.value === true ? x : { k: 'bool', op: 'not', args: [x], type: TypeOid.bool, typmod: -1, collation: 0 };
        }
      }
    }
    const foldable =
      (mapped.k === 'array' ||
        mapped.k === 'relabel' || mapped.k === 'iocoerce' || (mapped.k === 'func' && this.session.catalog().getProc(mapped.funcOid)?.volatile === 'i') || (mapped.k === 'op' && this.session.catalog().getProc(mapped.funcOid)?.volatile === 'i')) &&
      childExprs(mapped).length > 0 &&
      childExprs(mapped).every((c) => c.k === 'const');
    if (!foldable) {
      return mapped;
    }
    try {
      const executor = new Executor(this.st, this.host);
      this.host.executor = executor;
      const value = executor.planFor(q, null).ev(mapped)(new EvalCtx([], null, this.st));
      return makeConst(mapped.type, value, mapped.typmod, mapped.collation);
    } catch {
      return mapped;
    }
  }
}

interface IndexChoice {
  bitmap: boolean;
  arms: { index: Relation; conds: TExpr[]; uniqueEq: boolean }[];
  /** restriction clauses the index access implements (lossy LIKE prefixes stay filters) */
  used: TExpr[];
}

function isLike(c: TExpr): boolean {
  const e = stripImplicitCoercions(c);
  return e.k === 'op' && e.opName === '~~';
}

const COMMUTED: Record<string, string> = { '=': '=', '<': '>', '>': '<', '<=': '>=', '>=': '<=', '<>': '<>' };

/** Index conditions are shown with the indexed side on the left (the operator commuted). */
function indexSideLeft(q: Query, c: TExpr, rt: number): TExpr {
  if (c.k !== 'op' || c.args.length !== 2 || !COMMUTED[c.opName]) {
    return c;
  }
  const [a, b] = c.args;
  if (!varRels(q, a).has(rt) && varRels(q, b).has(rt)) {
    return { ...c, opName: COMMUTED[c.opName], args: [b, a] };
  }
  return c;
}

/** `[NOT] EXISTS (SELECT … FROM rel WHERE …)` / `expr IN (SELECT col FROM rel …)` that pull_up_sublinks turns into a semi / anti join */
function pullableSublink(c: TExpr): { sub: Query; anti: boolean; testLeft: TExpr | null; sublink: TExpr } | null {
  let e = stripImplicitCoercions(c);
  let anti = false;
  if (e.k === 'bool' && e.op === 'not' && e.args.length === 1) {
    anti = true;
    e = stripImplicitCoercions(e.args[0]);
  }
  if (e.k !== 'sublink') {
    return null;
  }
  const sub = e.subquery;
  const simple =
    sub.fromlist.length === 1 &&
    sub.fromlist[0].k === 'ref' &&
    sub.rtable[sub.fromlist[0].rtIndex]?.kind === 'relation' &&
    !sub.hasAggs &&
    sub.groupClause.length === 0 &&
    !sub.setOperations &&
    !sub.limitCount &&
    !sub.limitOffset &&
    sub.cteList.length === 0 &&
    !sub.hasWindowFuncs;
  if (!simple) {
    return null;
  }
  if (e.linkType === 'EXISTS') {
    return { sub, anti, testLeft: null, sublink: e };
  }
  if (e.linkType === 'ANY' && !anti && e.testLeft.length === 1 && e.operators.length === 1 && e.operators[0].opName === '=' && sub.targetList.filter((t) => !t.resjunk).length === 1) {
    return { sub, anti, testLeft: e.testLeft[0], sublink: e };
  }
  return null;
}

/** move a subquery expression up one level: its own Vars shift by `offset`, outer references become local */
function liftVars(e: TExpr, offset: number): TExpr {
  if (e.k === 'var') {
    return e.levelsUp === 0 ? { ...e, rtIndex: e.rtIndex + offset } : { ...e, levelsUp: e.levelsUp - 1 };
  }
  return mapChildren(e, (x) => liftVars(x, offset));
}

function andOf(list: TExpr[]): TExpr {
  return list.length === 1 ? list[0] : { k: 'bool', op: 'and', args: list, type: TypeOid.bool, typmod: -1, collation: 0 };
}

function childExprs(e: TExpr): TExpr[] {
  const out: TExpr[] = [];
  forEachChild(e, (c) => out.push(c));
  return out;
}

function splitAnd(e: TExpr | null | undefined): TExpr[] {
  if (!e) {
    return [];
  }
  const s = stripImplicitCoercions(e);
  if (s.k === 'bool' && s.op === 'and') {
    return s.args.flatMap((a) => splitAnd(a));
  }
  return [e];
}

function isEquality(c: TExpr): boolean {
  const e = stripImplicitCoercions(c);
  return (e.k === 'op' && e.opName === '=') || (e.k === 'saop' && e.opName === '=');
}

/** base relation range-table indexes referenced (at query level 0) by an expression; join alias vars resolve to their inputs */
function varRels(q: Query, e: TExpr): Set<number> {
  const out = new Set<number>();
  const visit = (x: TExpr, level: number) => {
    if (x.k === 'var') {
      if (x.levelsUp === level) {
        const rte = q.rtable[x.rtIndex];
        if (rte && rte.kind === 'join' && x.attno >= 0 && rte.aliasVars[x.attno]) {
          varRels(q, rte.aliasVars[x.attno]).forEach((r) => out.add(r));
        } else {
          out.add(x.rtIndex);
        }
      }
      return;
    }
    if (x.k === 'sublink') {
      x.testLeft.forEach((t) => visit(t, level));
      return;
    }
    forEachChild(x, (c) => visit(c, level));
  };
  visit(e, 0);
  return out;
}

/** correlated sublinks referencing range table entry `rt` of the enclosing level */
function containsSublinkRef(e: TExpr, rt: number): boolean {
  let found = false;
  const visit = (x: TExpr) => {
    if (found) {
      return;
    }
    if (x.k === 'sublink' && queryRefersTo(x.subquery, 1, rt)) {
      found = true;
      return;
    }
    forEachChild(x, visit);
  };
  visit(e);
  return found;
}

/** does a query nested `level` levels below reference range table entry `rt`? */
function queryRefersTo(query: Query, startLevel: number, rt: number): boolean {
  let found = false;
  const inQuery = (sub: Query, level: number) => {
    const visit = (x: TExpr) => {
      if (found) {
        return;
      }
      if (x.k === 'var' && x.levelsUp === level && x.rtIndex === rt) {
        found = true;
        return;
      }
      if (x.k === 'sublink') {
        inQuery(x.subquery, level + 1);
      }
      forEachChild(x, visit);
    };
    sub.targetList.forEach((t) => visit(t.expr));
    if (sub.where) {
      visit(sub.where);
    }
    if (sub.havingQual) {
      visit(sub.havingQual);
    }
    const joins = (n: JoinTreeNode) => {
      if (n.k === 'join') {
        if (n.quals) {
          visit(n.quals);
        }
        joins(n.larg);
        joins(n.rarg);
      }
    };
    sub.fromlist.forEach(joins);
    for (const r of sub.rtable) {
      if (r && r.kind === 'subquery') {
        inQuery(r.subquery, level + 1);
      }
    }
  };
  inQuery(query, startLevel);
  return found;
}

function onlyRel(q: Query, c: TExpr, rt: number): boolean {
  const refs = varRels(q, c);
  return refs.size === 1 && refs.has(rt);
}

function relsOfTree(q: Query, n: JoinTreeNode): Set<number> {
  if (n.k === 'ref') {
    return new Set([n.rtIndex]);
  }
  return new Set([...relsOfTree(q, n.larg), ...relsOfTree(q, n.rarg)]);
}

function subset(a: Set<number>, b: Set<number>): boolean {
  return [...a].every((x) => b.has(x));
}

function rteAttnum(q: Query, rt: number, attno: number): number {
  const rte = q.rtable[rt];
  return rte.kind === 'relation' ? rte.attnums[attno] : -1;
}

const SKIP_KEYS = new Set(['location', 'id', 'aggIndex', 'winIndex', 'testSlot', 'elemSlot', 'correlated', 'collation', 'inputCollation']);

/** structural equality where Vars of relation `rt` in `a` match Vars (any range table index) in the index expression `b` */
function sameExpr(a: unknown, b: unknown, rt: number): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return typeof a === 'bigint' || typeof b === 'bigint' ? a === b : false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameExpr(x, b[i], rt));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  if (ao.k === 'var' && bo.k === 'var') {
    return ao.levelsUp === 0 && ao.rtIndex === rt && ao.attno === bo.attno;
  }
  if (ao.constructor !== bo.constructor) {
    return false;
  }
  if ('mag' in ao) {
    return String(ao) === String(bo);
  }
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!SKIP_KEYS.has(k) && !sameExpr(ao[k], bo[k], rt)) {
      return false;
    }
  }
  return true;
}

function renderText(plan: PlanNode): string[] {
  const lines: string[] = [];
  const walk = (n: PlanNode, depth: number) => {
    const [first, ...rest] = n.label.split('\n');
    const pad = depth === 0 ? '' : ' '.repeat(depth * 6 - 4) + '->  ';
    const propPad = depth === 0 ? '  ' : ' '.repeat(depth * 6 + 2);
    if (rest.length > 0) {
      // subplan heading ("SubPlan 1", "CTE x") above its node
      lines.push(' '.repeat(Math.max(0, depth * 6 - 4)) + first);
      lines.push(pad + rest.join(' '));
    } else {
      lines.push(pad + first);
    }
    for (const [k, v] of n.props) {
      lines.push(`${propPad}${k}: ${v}`);
    }
    for (const c of n.children) {
      walk(c, depth + 1);
    }
  };
  walk(plan, 0);
  return lines;
}

function renderJson(plan: PlanNode): unknown {
  const walk = (n: PlanNode): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...n.json };
    for (const [k, v] of n.props) {
      out[k] = v;
    }
    if (n.children.length) {
      out.Plans = n.children.map(walk);
    }
    return out;
  };
  return [{ Plan: walk(plan) }];
}

function optionOn(stmt: A.ExplainStmt, name: string): boolean {
  const o = stmt.options.find((x) => x.name.toLowerCase() === name);
  if (!o) {
    return false;
  }
  return o.value === undefined || o.value === true || (typeof o.value === 'string' && !/^(false|off|0)$/i.test(o.value)) || (typeof o.value === 'number' && o.value !== 0);
}

export function explainStatement(session: Session, stmt: A.ExplainStmt, params: unknown[], paramTypes: number[] = [], parentSt: StatementState | null = null): UtilityResult {
  const format = String(stmt.options.find((x) => x.name.toLowerCase() === 'format')?.value ?? 'text').toLowerCase();
  let inner = stmt.query;
  const lines: string[] = [];
  let plan: PlanNode = node('Result', { 'Node Type': 'Result' });
  const started = Date.now();
  if (inner.kind === 'ExecuteStmt') {
    // EXPLAIN EXECUTE: the prepared statement with its evaluated arguments
    const prepared = fetchPreparedStatement(session, inner.name);
    params = evaluateExecuteParams(session, inner, prepared, params, paramTypes, parentSt, parentSt?.undo ?? null);
    revalidatePrepared(session, prepared);
    paramTypes = prepared.paramTypes;
    parentSt = null;
    inner = prepared.stmt ?? inner;
  }
  if (inner.kind === 'SelectStmt' || inner.kind === 'InsertStmt' || inner.kind === 'UpdateStmt' || inner.kind === 'DeleteStmt' || inner.kind === 'MergeStmt') {
    const typedParams = parentSt ? parentSt.params : params;
    const types = parentSt ? parentSt.paramTypes : paramTypes;
    const an = session.makeAnalyzer(types.slice(), true);
    const { query } = analyzeStatementAsSubquery(an, inner, null, true);
    const st = new StatementState(session, session.catalog(), typedParams, an.paramTypes, session.takeSnapshot());
    plan = new Explainer(session, st).planQuery(query);
    if (optionOn(stmt, 'analyze')) {
      session.executeParsedSync({ stmt: inner, text: '', start: 0, end: 0 }, typedParams, st.undo, parentSt, 0, parentSt ? undefined : an.paramTypes);
    }
  }
  if (format === 'json') {
    const doc = renderJson(plan) as { Plan: unknown; 'Planning Time'?: number; 'Execution Time'?: number }[];
    if (optionOn(stmt, 'analyze')) {
      doc[0]['Planning Time'] = 0.05;
      doc[0]['Execution Time'] = Date.now() - started;
    }
    return {
      command: 'EXPLAIN',
      fields: [{ name: 'QUERY PLAN', typeOid: TypeOid.json, typmod: -1, tableOid: 0, columnAttnum: 0 }],
      rows: [[JSON.stringify(doc, null, 2)]],
      rowCount: 1,
    };
  }
  lines.push(...renderText(plan));
  if (optionOn(stmt, 'analyze')) {
    lines.push('Planning Time: 0.050 ms', `Execution Time: ${(Date.now() - started).toFixed(3)} ms`);
  }
  return {
    command: 'EXPLAIN',
    fields: [{ name: 'QUERY PLAN', typeOid: TypeOid.text, typmod: -1, tableOid: 0, columnAttnum: 0 }],
    rows: lines.map((l) => [l]),
    rowCount: lines.length,
  };
}
