import { isSystemAttno, SYSTEM_COLUMN_NAMES } from '../analyze/colref';
import {
  AggNode,
  emptyQuery,
  JoinRTE,
  JoinTreeNode,
  Query,
  RTE,
  SetOpTree,
  SortGroupClause,
  SubqueryRTE,
  TargetEntry,
  TExpr,
  ValuesRTE,
  VarNode,
  WindowClause,
} from '../analyze/nodes';
import { quoteIdentifier } from '../analyze/typeutil';
import type { DeparseCtx } from './deparse';
import { constText, fmtType, funcName } from './deparse';

/**
 * Query deparsing with ruleutils.c's layout (get_query_def and friends): the text pg_get_viewdef,
 * pg_views.definition and information_schema.views.view_definition show for a view.
 */

const PRETTYINDENT_STD = 8;
const PRETTYINDENT_JOIN = 4;
const PRETTYINDENT_VAR = 4;
const PRETTYINDENT_LIMIT = 40;

export interface RuleDeparseOptions {
  /** PRETTYFLAG_PAREN: drop redundant parentheses */
  paren: boolean;
  /** PRETTYFLAG_INDENT: line breaks and indentation */
  indent: boolean;
  /** wrap the target / FROM lists at this column (0 = one item per line, -1 = never) */
  wrapColumn: number;
}

interface Buf {
  s: string;
}

interface Namespace {
  q: Query;
  names: (string | null)[];
}

interface Ctx {
  d: DeparseCtx;
  buf: Buf;
  opts: RuleDeparseOptions;
  namespaces: Namespace[];
  varprefix: boolean;
  indentLevel: number;
  windowClause: WindowClause[] | null;
  targetList: TargetEntry[] | null;
  resultNames: string[] | null;
  varInOrderBy: boolean;
  inGroupBy: boolean;
}

/** pg_get_viewdef: the view's query (analyzed), its column names as the result descriptor */
export function viewDefinition(d: DeparseCtx, q: Query, columnNames: string[], opts: RuleDeparseOptions): string {
  const buf: Buf = { s: '' };
  queryDef(d, q, buf, [], columnNames, true, opts, 0);
  return buf.s + ';';
}

function queryDef(d: DeparseCtx, q: Query, buf: Buf, parent: Namespace[], resultNames: string[] | null, colNamesVisible: boolean, opts: RuleDeparseOptions, startIndent: number): void {
  const ns: Namespace = { q, names: rtableNames(d, q, parent) };
  const ctx: Ctx = {
    d,
    buf,
    opts,
    namespaces: [ns, ...parent],
    varprefix: parent.length > 0 || q.rtable.length !== 1,
    indentLevel: startIndent,
    windowClause: null,
    targetList: null,
    resultNames,
    varInOrderBy: false,
    inGroupBy: false,
  };
  selectQueryDef(ctx, q, resultNames, colNamesVisible);
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

function relationOf(d: DeparseCtx, rte: RTE): { name: string; oid: number } | null {
  if (rte.kind === 'relation' || rte.kind === 'catalog') {
    const rel = d.catalog.getRelation(rte.relOid);
    return { name: rel?.name ?? (rte.kind === 'relation' ? rte.relname : rte.relname), oid: rte.relOid };
  }
  if (rte.kind === 'subquery' && rte.viewOid !== undefined) {
    const rel = d.catalog.getRelation(rte.viewOid);
    return rel ? { name: rel.name, oid: rel.oid } : null;
  }
  return null;
}

/** set_rtable_names */
function rtableNames(d: DeparseCtx, q: Query, parent: Namespace[]): (string | null)[] {
  const used = new Map<string, number>();
  for (const p of parent) {
    for (const n of p.names) {
      if (n !== null) {
        used.set(n, 0);
      }
    }
  }
  return q.rtable.map((rte) => {
    let ref: string | null;
    if (rte.alias) {
      ref = rte.alias;
    } else if (relationOf(d, rte)) {
      ref = relationOf(d, rte)!.name;
    } else if (rte.kind === 'join') {
      ref = null;
    } else {
      ref = rte.eref.aliasname;
    }
    if (ref === null) {
      return null;
    }
    if (used.has(ref)) {
      let counter = used.get(ref)!;
      let mod: string;
      do {
        counter++;
        mod = `${ref}_${counter}`;
      } while (used.has(mod));
      used.set(ref, counter);
      used.set(mod, 0);
      return mod;
    }
    used.set(ref, 0);
    return ref;
  });
}

function relationName(ctx: Ctx, oid: number, name: string): string {
  const s = ctx.d.session;
  const shadowedByCte = ctx.namespaces.some((ns) => ns.q.cteList.some((c) => c.name === name));
  if (!shadowedByCte && s.resolveRelation(quoteIdentifier(name)) === oid) {
    return quoteIdentifier(name);
  }
  const rel = ctx.d.catalog.getRelation(oid);
  const tempNs = s.tempNamespace(false);
  const nsp = rel ? (tempNs && rel.nspOid === tempNs ? 'pg_temp' : ctx.d.catalog.namespaceName(rel.nspOid)) : 'pg_catalog';
  return `${quoteIdentifier(nsp)}.${quoteIdentifier(name)}`;
}

// ---------------------------------------------------------------------------
// layout helpers
// ---------------------------------------------------------------------------

const trimSpaces = (s: string): string => s.replace(/ +$/, '');

/** appendContextKeyword */
function keyword(ctx: Ctx, str: string, indentBefore: number, indentAfter: number, indentPlus: number): void {
  if (!ctx.opts.indent) {
    ctx.buf.s += str;
    return;
  }
  ctx.indentLevel += indentBefore;
  let amount: number;
  if (ctx.indentLevel < PRETTYINDENT_LIMIT) {
    amount = Math.max(ctx.indentLevel, 0) + indentPlus;
  } else {
    amount = PRETTYINDENT_LIMIT + Math.trunc((ctx.indentLevel - PRETTYINDENT_LIMIT) / (PRETTYINDENT_STD / 2));
    amount %= PRETTYINDENT_LIMIT;
    amount += indentPlus;
  }
  ctx.buf.s = trimSpaces(ctx.buf.s) + '\n' + ' '.repeat(amount) + str;
  ctx.indentLevel += indentAfter;
  if (ctx.indentLevel < 0) {
    ctx.indentLevel = 0;
  }
}

function lastLineLength(s: string): number {
  return s.length - (s.lastIndexOf('\n') + 1);
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

function selectQueryDef(ctx: Ctx, q: Query, resultNames: string[] | null, colNamesVisible: boolean): void {
  withClause(ctx, q);
  ctx.windowClause = q.windowClause;
  ctx.targetList = q.targetList;
  let forceColno = false;
  if (q.setOperations) {
    setopQuery(ctx, q.setOperations, q, resultNames, colNamesVisible);
    forceColno = true;
  } else {
    basicSelect(ctx, q, resultNames, colNamesVisible);
  }
  if (q.sortClause.length > 0) {
    keyword(ctx, ' ORDER BY ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 1);
    orderBy(ctx, q.sortClause, q.targetList, forceColno);
  }
  if (q.limitOffset) {
    keyword(ctx, ' OFFSET ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 0);
    ruleExpr(ctx, q.limitOffset, false);
  }
  if (q.limitCount) {
    if (q.limitWithTies) {
      keyword(ctx, ' FETCH FIRST ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 0);
      ctx.buf.s += '(';
      ruleExpr(ctx, q.limitCount, false);
      ctx.buf.s += ') ROWS WITH TIES';
    } else {
      keyword(ctx, ' LIMIT ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 0);
      if (q.limitCount.k === 'const' && q.limitCount.isNull) {
        ctx.buf.s += 'ALL';
      } else {
        ruleExpr(ctx, q.limitCount, false);
      }
    }
  }
  for (const rm of q.rowMarks) {
    keyword(ctx, ` FOR ${rm.strength}`, -PRETTYINDENT_STD, PRETTYINDENT_STD, 0);
    ctx.buf.s += ` OF ${quoteIdentifier(ctx.namespaces[0].names[rm.rtIndex] ?? '?')}`;
    if (rm.waitPolicy === 'NOWAIT') {
      ctx.buf.s += ' NOWAIT';
    } else if (rm.waitPolicy === 'SKIP') {
      ctx.buf.s += ' SKIP LOCKED';
    }
  }
}

function withClause(ctx: Ctx, q: Query): void {
  if (q.cteList.length === 0) {
    return;
  }
  if (ctx.opts.indent) {
    ctx.indentLevel += PRETTYINDENT_STD;
    ctx.buf.s += ' ';
  }
  let sep = q.cteList.some((c) => c.recursive) ? 'WITH RECURSIVE ' : 'WITH ';
  for (const cte of q.cteList) {
    ctx.buf.s += sep + quoteIdentifier(cte.name);
    const body = cteBody(cte.query, cte.recursiveParts);
    const natural = body.targetList.filter((t) => !t.resjunk).map((t) => t.name);
    if (cte.colNames.length > 0 && cte.colNames.some((n, i) => n !== natural[i])) {
      ctx.buf.s += `(${cte.colNames.map(quoteIdentifier).join(', ')})`;
    }
    ctx.buf.s += ' AS ';
    if (cte.materialized === 'ALWAYS') {
      ctx.buf.s += 'MATERIALIZED ';
    } else if (cte.materialized === 'NEVER') {
      ctx.buf.s += 'NOT MATERIALIZED ';
    }
    ctx.buf.s += '(';
    if (ctx.opts.indent) {
      keyword(ctx, '', 0, 0, 0);
    }
    queryDef(ctx.d, body, ctx.buf, ctx.namespaces, null, true, ctx.opts, ctx.indentLevel);
    if (ctx.opts.indent) {
      keyword(ctx, '', 0, 0, 0);
    }
    ctx.buf.s += ')';
    sep = ', ';
  }
  if (ctx.opts.indent) {
    ctx.indentLevel -= PRETTYINDENT_STD;
    keyword(ctx, '', 0, 0, 0);
  } else {
    ctx.buf.s += ' ';
  }
}

/** a recursive CTE's query as PostgreSQL keeps it: non-recursive term UNION [ALL] recursive term */
function cteBody(query: Query, parts: { nonRecursive: Query; recursive: Query; unionAll: boolean } | undefined): Query {
  if (!parts) {
    return query;
  }
  const leaf = (sub: Query): SubqueryRTE => ({
    kind: 'subquery',
    subquery: sub,
    eref: { aliasname: '*SELECT*', colnames: sub.targetList.map((t) => t.name) },
    colTypes: [],
    lateral: false,
  });
  const q = emptyQuery();
  q.rtable = [leaf(parts.nonRecursive), leaf(parts.recursive)];
  q.targetList = parts.nonRecursive.targetList;
  q.setOperations = { k: 'setop', op: 'UNION', all: parts.unionAll, larg: { k: 'leaf', rtIndex: 0 }, rarg: { k: 'leaf', rtIndex: 1 }, colTypes: [] };
  return q;
}

function simpleValuesRte(q: Query, resultNames: string[] | null): ValuesRTE | null {
  if (q.rtable.length !== 1 || q.rtable[0].kind !== 'values') {
    return null;
  }
  const rte = q.rtable[0];
  if (q.targetList.length !== rte.eref.colnames.length) {
    return null;
  }
  for (let i = 0; i < q.targetList.length; i++) {
    const tle = q.targetList[i];
    if (tle.resjunk) {
      return null;
    }
    const colname = resultNames && i < resultNames.length ? resultNames[i] : tle.name;
    if (colname !== rte.eref.colnames[i]) {
      return null;
    }
  }
  return rte;
}

function basicSelect(ctx: Ctx, q: Query, resultNames: string[] | null, colNamesVisible: boolean): void {
  if (ctx.opts.indent) {
    ctx.indentLevel += PRETTYINDENT_STD;
    ctx.buf.s += ' ';
  }
  const values = simpleValuesRte(q, resultNames);
  if (values) {
    valuesDef(ctx, values.lists);
    return;
  }
  ctx.buf.s += 'SELECT';
  if (q.distinctClause && (q.distinctClause.length > 0 || q.hasDistinctOn)) {
    if (q.hasDistinctOn) {
      ctx.buf.s += ' DISTINCT ON (';
      q.distinctClause.forEach((srt, i) => {
        if (i > 0) {
          ctx.buf.s += ', ';
        }
        sortGroupClause(ctx, srt.tleSortGroupRef, q.targetList, false);
      });
      ctx.buf.s += ')';
    } else {
      ctx.buf.s += ' DISTINCT';
    }
  }
  targetList(ctx, q.targetList, resultNames, colNamesVisible);
  fromClause(ctx, q);
  if (q.where) {
    keyword(ctx, ' WHERE ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 1);
    ruleExpr(ctx, q.where, false);
  }
  if (q.groupClause.length > 0 || q.groupingSets) {
    keyword(ctx, ' GROUP BY ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 1);
    const save = ctx.inGroupBy;
    ctx.inGroupBy = true;
    const item = (g: SortGroupClause, i: number) => {
      if (i > 0) {
        ctx.buf.s += ', ';
      }
      sortGroupClause(ctx, g.tleSortGroupRef, q.targetList, false);
    };
    if (!q.groupingSets) {
      q.groupClause.forEach(item);
    } else {
      ctx.buf.s += 'GROUPING SETS (';
      q.groupingSets.forEach((set, i) => {
        ctx.buf.s += (i > 0 ? ', ' : '') + '(';
        set.map((ix) => q.groupClause[ix]).forEach(item);
        ctx.buf.s += ')';
      });
      ctx.buf.s += ')';
    }
    ctx.inGroupBy = save;
  }
  if (q.havingQual) {
    keyword(ctx, ' HAVING ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 0);
    ruleExpr(ctx, q.havingQual, false);
  }
  let sep: string | null = null;
  for (const wc of q.windowClause) {
    if (!wc.name) {
      continue;
    }
    if (sep === null) {
      keyword(ctx, ' WINDOW ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 1);
    } else {
      ctx.buf.s += sep;
    }
    ctx.buf.s += `${quoteIdentifier(wc.name)} AS `;
    windowSpec(ctx, wc, q.targetList);
    sep = ', ';
  }
}

function targetList(ctx: Ctx, tlist: TargetEntry[], resultNames: string[] | null, colNamesVisible: boolean): void {
  const buf = ctx.buf;
  let sep = ' ';
  let colno = 0;
  let lastWasMultiline = false;
  for (const tle of tlist) {
    if (tle.resjunk) {
      continue;
    }
    buf.s += sep;
    sep = ', ';
    colno++;
    const tb: Buf = { s: '' };
    ctx.buf = tb;
    let attname: string | null;
    if (tle.expr.k === 'var') {
      attname = variable(ctx, tle.expr, 0, true);
    } else {
      ruleExpr(ctx, tle.expr, true);
      attname = colNamesVisible ? null : '?column?';
    }
    const colname = resultNames && colno <= resultNames.length ? resultNames[colno - 1] : tle.name;
    if (colname && (attname === null || attname !== colname)) {
      tb.s += ` AS ${quoteIdentifier(colname)}`;
    }
    ctx.buf = buf;
    if (ctx.opts.indent && ctx.opts.wrapColumn >= 0) {
      const leadingNl = tb.s.startsWith('\n') ? 0 : -1;
      if (leadingNl >= 0) {
        buf.s = trimSpaces(buf.s);
      } else if (colno > 1 && (lastLineLength(buf.s) + tb.s.length > ctx.opts.wrapColumn || lastWasMultiline)) {
        keyword(ctx, '', -PRETTYINDENT_STD, PRETTYINDENT_STD, PRETTYINDENT_VAR);
      }
      lastWasMultiline = tb.s.indexOf('\n', leadingNl + 1) >= 0;
    }
    buf.s += tb.s;
  }
}

function setopQuery(ctx: Ctx, op: SetOpTree, q: Query, resultNames: string[] | null, colNamesVisible: boolean): void {
  if (op.k === 'leaf') {
    const sub = (q.rtable[op.rtIndex] as SubqueryRTE).subquery;
    const needParen = sub.cteList.length > 0 || sub.sortClause.length > 0 || sub.rowMarks.length > 0 || !!sub.limitOffset || !!sub.limitCount || !!sub.setOperations;
    if (needParen) {
      ctx.buf.s += '(';
    }
    queryDef(ctx.d, sub, ctx.buf, ctx.namespaces, resultNames, colNamesVisible, ctx.opts, ctx.indentLevel);
    if (needParen) {
      ctx.buf.s += ')';
    }
    return;
  }
  let needParen = op.larg.k === 'setop' && !(op.larg.op === op.op && op.larg.all === op.all);
  let subindent = 0;
  if (needParen) {
    ctx.buf.s += '(';
    subindent = PRETTYINDENT_STD;
    keyword(ctx, '', subindent, 0, 0);
  }
  setopQuery(ctx, op.larg, q, resultNames, colNamesVisible);
  if (needParen) {
    keyword(ctx, ') ', -subindent, 0, 0);
  } else if (ctx.opts.indent) {
    keyword(ctx, '', -subindent, 0, 0);
  } else {
    ctx.buf.s += ' ';
  }
  ctx.buf.s += `${op.op} ${op.all ? 'ALL ' : ''}`;
  needParen = op.rarg.k === 'setop';
  subindent = 0;
  if (needParen) {
    ctx.buf.s += '(';
    subindent = PRETTYINDENT_STD;
  }
  keyword(ctx, '', subindent, 0, 0);
  setopQuery(ctx, op.rarg, q, resultNames, false);
  if (ctx.opts.indent) {
    ctx.indentLevel -= subindent;
  }
  if (needParen) {
    keyword(ctx, ')', 0, 0, 0);
  }
}

function valuesDef(ctx: Ctx, lists: TExpr[][]): void {
  ctx.buf.s += 'VALUES ';
  lists.forEach((row, i) => {
    ctx.buf.s += (i > 0 ? ', ' : '') + '(';
    row.forEach((c, j) => {
      if (j > 0) {
        ctx.buf.s += ',';
      }
      ruleExprToplevel(ctx, c, false);
    });
    ctx.buf.s += ')';
  });
}

// ---------------------------------------------------------------------------
// ORDER BY / GROUP BY / WINDOW
// ---------------------------------------------------------------------------

function sortGroupClause(ctx: Ctx, ref: number, tlist: TargetEntry[], forceColno: boolean): TExpr | null {
  const tle = tlist.find((t) => t.sortGroupRef === ref);
  if (!tle) {
    return null;
  }
  const e = tle.expr;
  if (forceColno) {
    ctx.buf.s += String(tle.resno);
  } else {
    sortExpr(ctx, e);
  }
  return e;
}

function sortExpr(ctx: Ctx, e: TExpr): void {
  if (e.k === 'const') {
    ctx.buf.s += constExpr(ctx, e, 1);
  } else if (e.k === 'var') {
    const save = ctx.varInOrderBy;
    ctx.varInOrderBy = true;
    variable(ctx, e, 0, false);
    ctx.varInOrderBy = save;
  } else {
    const needParen = ctx.opts.paren || e.k === 'func' || e.k === 'agg' || e.k === 'window';
    if (needParen) {
      ctx.buf.s += '(';
    }
    ruleExpr(ctx, e, true);
    if (needParen) {
      ctx.buf.s += ')';
    }
  }
}

function sortDecoration(desc: boolean, nullsFirst: boolean, useOpName: string | undefined): string {
  if (useOpName && useOpName !== '<' && useOpName !== '>') {
    return ` USING ${useOpName}${nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'}`;
  }
  const isDesc = useOpName ? useOpName === '>' : desc;
  if (!isDesc) {
    return nullsFirst ? ' NULLS FIRST' : '';
  }
  return ' DESC' + (nullsFirst ? '' : ' NULLS LAST');
}

function orderBy(ctx: Ctx, list: SortGroupClause[], tlist: TargetEntry[], forceColno: boolean): void {
  list.forEach((srt, i) => {
    if (i > 0) {
      ctx.buf.s += ', ';
    }
    sortGroupClause(ctx, srt.tleSortGroupRef, tlist, forceColno);
    ctx.buf.s += sortDecoration(srt.desc, srt.nullsFirst, srt.useOpName);
  });
}

function windowSpec(ctx: Ctx, wc: WindowClause, tlist: TargetEntry[]): void {
  ctx.buf.s += '(';
  const refname = wc.refname && wc.refname !== wc.name ? wc.refname : undefined;
  let needspace = false;
  const space = () => {
    if (needspace) {
      ctx.buf.s += ' ';
    }
    needspace = true;
  };
  if (refname) {
    space();
    ctx.buf.s += quoteIdentifier(refname);
  }
  if (wc.partitionClause.length > 0 && !refname) {
    space();
    ctx.buf.s += 'PARTITION BY ';
    wc.partitionClause.forEach((g, i) => {
      if (i > 0) {
        ctx.buf.s += ', ';
      }
      sortGroupClause(ctx, g.tleSortGroupRef, tlist, false);
    });
  }
  const refWin = refname ? ctx.windowClause?.find((w) => w.name === refname) : undefined;
  if (wc.orderClause.length > 0 && !(refWin && refWin.orderClause.length > 0)) {
    space();
    ctx.buf.s += 'ORDER BY ';
    orderBy(ctx, wc.orderClause, tlist, false);
  }
  if (!wc.frame.defaultFrame) {
    space();
    const bound = (b: { type: string; offset: TExpr | null }) => {
      if (b.offset) {
        ruleExpr(ctx, b.offset, false);
        ctx.buf.s += b.type.includes('FOLLOWING') ? ' FOLLOWING' : ' PRECEDING';
      } else {
        ctx.buf.s += b.type.replace(/^OFFSET_/, '').replace(/_/g, ' ');
      }
    };
    ctx.buf.s += `${wc.frame.mode} BETWEEN `;
    bound(wc.frame.start);
    ctx.buf.s += ' AND ';
    bound(wc.frame.end);
    if (wc.frame.exclusion && wc.frame.exclusion !== 'NO OTHERS' && wc.frame.exclusion !== 'NO_OTHERS') {
      ctx.buf.s += ` EXCLUDE ${wc.frame.exclusion.replace(/_/g, ' ')}`;
    }
  }
  ctx.buf.s += ')';
}

// ---------------------------------------------------------------------------
// FROM
// ---------------------------------------------------------------------------

function fromClause(ctx: Ctx, q: Query): void {
  let first = true;
  for (const jt of q.fromlist) {
    if (first) {
      keyword(ctx, ' FROM ', -PRETTYINDENT_STD, PRETTYINDENT_STD, 2);
      first = false;
      fromItem(ctx, jt, q);
      continue;
    }
    const buf = ctx.buf;
    buf.s += ', ';
    const ib: Buf = { s: '' };
    ctx.buf = ib;
    fromItem(ctx, jt, q);
    ctx.buf = buf;
    if (ctx.opts.indent && ctx.opts.wrapColumn >= 0) {
      if (ib.s.startsWith('\n')) {
        buf.s = trimSpaces(buf.s);
      } else if (lastLineLength(buf.s) + ib.s.length > ctx.opts.wrapColumn) {
        keyword(ctx, '', -PRETTYINDENT_STD, PRETTYINDENT_STD, PRETTYINDENT_VAR);
      }
    }
    buf.s += ib.s;
  }
}

/** the column names an RTE has without user-written column aliases */
function naturalColumns(ctx: Ctx, rte: RTE): string[] | null {
  const rel = relationOf(ctx.d, rte);
  if (rel) {
    return ctx.d.catalog.getRelation(rel.oid)?.columns.filter((c) => !c.isDropped).map((c) => c.name) ?? null;
  }
  switch (rte.kind) {
    case 'subquery':
      return rte.subquery.targetList.filter((t) => !t.resjunk).map((t) => t.name);
    case 'values':
      return rte.eref.colnames.map((_, i) => `column${i + 1}`);
    case 'cte':
      return rte.cte.colNames;
    default:
      return null;
  }
}

function printAliases(ctx: Ctx, rte: RTE): boolean {
  if (rte.kind === 'function' || ((rte.kind === 'subquery' || rte.kind === 'cte') && rte.userColnames && !(rte.kind === 'subquery' && rte.viewOid !== undefined))) {
    return true;
  }
  const natural = naturalColumns(ctx, rte);
  return !!natural && rte.eref.colnames.some((n, i) => n !== natural[i]);
}

function fromItem(ctx: Ctx, jt: JoinTreeNode, q: Query): void {
  const names = ctx.namespaces[0].names;
  if (jt.k === 'ref') {
    const rte = q.rtable[jt.rtIndex];
    if (rte.lateral && !(rte.kind === 'subquery' && rte.viewOid !== undefined)) {
      ctx.buf.s += 'LATERAL ';
    }
    const rel = relationOf(ctx.d, rte);
    if (rel) {
      const only = rte.kind === 'relation' && rte.inh === false && rte.relkind !== 'v' ? 'ONLY ' : '';
      ctx.buf.s += only + relationName(ctx, rel.oid, rel.name);
    } else if (rte.kind === 'subquery') {
      ctx.buf.s += '(';
      queryDef(ctx.d, rte.subquery, ctx.buf, ctx.namespaces, null, true, ctx.opts, ctx.indentLevel);
      ctx.buf.s += ')';
    } else if (rte.kind === 'function') {
      if (rte.functions.length === 1 && !rte.ordinality) {
        funccall(ctx, rte.functions[0].expr);
      } else {
        ctx.buf.s += 'ROWS FROM(';
        rte.functions.forEach((f, i) => {
          if (i > 0) {
            ctx.buf.s += ', ';
          }
          funccall(ctx, f.expr);
        });
        ctx.buf.s += ')';
      }
      if (rte.ordinality) {
        ctx.buf.s += ' WITH ORDINALITY';
      }
    } else if (rte.kind === 'values') {
      ctx.buf.s += '(';
      valuesDef(ctx, rte.lists);
      ctx.buf.s += ')';
    } else if (rte.kind === 'cte') {
      ctx.buf.s += quoteIdentifier(rte.ctename);
    }
    // get_rte_alias
    const refname = names[jt.rtIndex];
    const aliases = printAliases(ctx, rte);
    let print = false;
    if (rte.alias || aliases) {
      print = true;
    } else if (rel) {
      print = refname !== rel.name;
    } else if (rte.kind === 'function' || rte.kind === 'subquery' || rte.kind === 'values') {
      print = true;
    } else if (rte.kind === 'cte') {
      print = refname !== rte.ctename;
    }
    if (print && refname !== null) {
      ctx.buf.s += ' ' + quoteIdentifier(refname);
    }
    if (aliases) {
      ctx.buf.s += `(${rte.eref.colnames.map(quoteIdentifier).join(', ')})`;
    }
    return;
  }
  const jrte = q.rtable[jt.rtIndex] as JoinRTE;
  const rargAliased = jt.rarg.k === 'join' && !!q.rtable[jt.rarg.rtIndex].alias;
  const needParenOnRight = ctx.opts.paren && jt.rarg.k !== 'ref' && !rargAliased;
  if (!ctx.opts.paren || jrte.alias) {
    ctx.buf.s += '(';
  }
  fromItem(ctx, jt.larg, q);
  const hasCondition = !!jt.quals || jrte.usingCount > 0;
  switch (jt.joinType) {
    case 'INNER':
    case 'CROSS':
      keyword(ctx, hasCondition ? ' JOIN ' : ' CROSS JOIN ', -PRETTYINDENT_STD, PRETTYINDENT_STD, PRETTYINDENT_JOIN);
      break;
    default:
      keyword(ctx, ` ${jt.joinType} JOIN `, -PRETTYINDENT_STD, PRETTYINDENT_STD, PRETTYINDENT_JOIN);
  }
  if (needParenOnRight) {
    ctx.buf.s += '(';
  }
  fromItem(ctx, jt.rarg, q);
  if (needParenOnRight) {
    ctx.buf.s += ')';
  }
  if (jrte.usingCount > 0) {
    ctx.buf.s += ` USING (${jrte.eref.colnames.slice(0, jrte.usingCount).map(quoteIdentifier).join(', ')})`;
  } else if (jt.quals) {
    ctx.buf.s += ' ON ';
    if (!ctx.opts.paren) {
      ctx.buf.s += '(';
    }
    ruleExpr(ctx, jt.quals, false);
    if (!ctx.opts.paren) {
      ctx.buf.s += ')';
    }
  } else if (jt.joinType !== 'INNER' && jt.joinType !== 'CROSS') {
    ctx.buf.s += ' ON TRUE';
  }
  if (!ctx.opts.paren || jrte.alias) {
    ctx.buf.s += ')';
  }
  if (jrte.alias) {
    ctx.buf.s += ' ' + quoteIdentifier(names[jt.rtIndex] ?? jrte.alias);
  }
}

function funccall(ctx: Ctx, e: TExpr): void {
  const looksLikeFunction =
    (e.k === 'func' && (e.format === 'call' || e.format === 'sql_syntax')) || e.k === 'nullif' || e.k === 'coalesce' || e.k === 'minmax' || e.k === 'sqlvalue';
  if (looksLikeFunction) {
    ruleExpr(ctx, e, true);
    return;
  }
  ctx.buf.s += 'CAST(';
  ruleExpr(ctx, e, false);
  ctx.buf.s += ` AS ${fmtType(ctx.d, e.type, e.typmod)})`;
}

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

function sameVar(a: VarNode, b: TExpr): boolean {
  return b.k === 'var' && a.levelsUp === b.levelsUp && a.rtIndex === b.rtIndex && a.attno === b.attno;
}

/** get_variable: returns the column name printed (null for a whole-row reference) */
function variable(ctx: Ctx, v: VarNode, levelsUp: number, istoplevel: boolean): string | null {
  const ns = ctx.namespaces[v.levelsUp + levelsUp];
  const rte = ns?.q.rtable[v.rtIndex];
  if (!ns || !rte) {
    ctx.buf.s += '?';
    return null;
  }
  if (rte.kind === 'join' && !rte.alias && v.attno >= 0) {
    const alias = rte.aliasVars[v.attno];
    if (alias && alias.k === 'var') {
      return variable(ctx, alias, v.levelsUp + levelsUp, istoplevel);
    }
  }
  const refname = ns.names[v.rtIndex];
  let attname: string | null;
  if (v.attno >= 0) {
    attname = rte.eref.colnames[v.attno] ?? '?';
  } else if (isSystemAttno(v.attno)) {
    attname = SYSTEM_COLUMN_NAMES[v.attno];
  } else {
    attname = null;
  }
  let needPrefix = ctx.varprefix || attname === null;
  if (ctx.varInOrderBy && !ctx.inGroupBy && !needPrefix && ctx.targetList) {
    let colno = 0;
    for (const tle of ctx.targetList) {
      if (tle.resjunk) {
        continue;
      }
      colno++;
      const colname = ctx.resultNames && colno <= ctx.resultNames.length ? ctx.resultNames[colno - 1] : tle.name;
      if (colname === attname && !sameVar(v, tle.expr)) {
        needPrefix = true;
        break;
      }
    }
  }
  if (refname && needPrefix) {
    ctx.buf.s += quoteIdentifier(refname) + '.';
  }
  if (attname !== null) {
    ctx.buf.s += quoteIdentifier(attname);
  } else {
    ctx.buf.s += '*';
    if (istoplevel) {
      ctx.buf.s += '::' + fmtType(ctx.d, v.type, v.typmod);
    }
  }
  return attname;
}

function constExpr(ctx: Ctx, e: TExpr & { k: 'const' }, showtype: number): string {
  let s = constText(ctx.d, e, showtype);
  if (showtype >= 0 && e.collation && !e.isNull) {
    const typColl = ctx.d.catalog.getType(e.type)?.collation ?? 0;
    if (typColl && e.collation !== typColl) {
      s += ` COLLATE ${quoteIdentifier(ctx.d.catalog.getCollation(e.collation)?.name ?? 'default')}`;
    }
  }
  return s;
}

const SEPARATOR_PARENTS = new Set(['bool', 'subscript', 'array', 'row', 'coalesce', 'minmax', 'nullif', 'agg', 'grouping', 'window', 'case']);

function isCastLike(e: TExpr): boolean {
  return e.k === 'func' && e.format !== 'call';
}

/** isSimpleNode */
function isSimpleNode(node: TExpr, parent: TExpr, paren: boolean): boolean {
  switch (node.k) {
    case 'var':
    case 'const':
    case 'param':
    case 'default':
    case 'subscript':
    case 'array':
    case 'row':
    case 'coalesce':
    case 'minmax':
    case 'sqlvalue':
    case 'nullif':
    case 'agg':
    case 'grouping':
    case 'window':
    case 'func':
    case 'case':
      return true;
    case 'fieldselect':
      return parent.k !== 'fieldselect';
    case 'domaincoerce':
    case 'relabel':
    case 'iocoerce':
    case 'arraycoerce':
      return isSimpleNode(node.arg, node, paren);
    case 'op':
      if (paren && parent.k === 'op') {
        const op = node.args.length === 2 ? node.opName : null;
        const parentOp = parent.args.length === 2 ? parent.opName : null;
        if (!op || !parentOp) {
          return false;
        }
        const lo = '+-'.includes(op[0]);
        const hi = '*/%'.includes(op[0]);
        const plo = '+-'.includes(parentOp[0]);
        const phi = '*/%'.includes(parentOp[0]);
        if (!(lo || hi) || !(plo || phi)) {
          return false;
        }
        if (hi && plo) {
          return true;
        }
        if (lo && phi) {
          return false;
        }
        return parent.args[0] === node;
      }
      return opLikeUnder(parent);
    case 'sublink':
    case 'nulltest':
    case 'booltest':
      return opLikeUnder(parent);
    case 'distinct':
      return node.isNot ? boolUnder('not', parent, paren) : opLikeUnder(parent);
    case 'bool':
      return boolUnder(node.op, parent, paren);
    default:
      return false;
  }
}

function opLikeUnder(parent: TExpr): boolean {
  if (parent.k === 'func') {
    return !isCastLike(parent);
  }
  if (parent.k === 'distinct' && parent.isNot) {
    return false;
  }
  return SEPARATOR_PARENTS.has(parent.k);
}

function boolUnder(type: 'and' | 'or' | 'not', parent: TExpr, paren: boolean): boolean {
  if (parent.k === 'bool') {
    if (!paren) {
      return false;
    }
    if (type === 'or') {
      return parent.op === 'or';
    }
    return parent.op === 'and' || parent.op === 'or';
  }
  if (parent.k === 'func') {
    return !isCastLike(parent);
  }
  return SEPARATOR_PARENTS.has(parent.k);
}

function exprParen(ctx: Ctx, e: TExpr, showImplicit: boolean, parent: TExpr): void {
  const need = ctx.opts.paren && !isSimpleNode(e, parent, ctx.opts.paren);
  if (need) {
    ctx.buf.s += '(';
  }
  ruleExpr(ctx, e, showImplicit);
  if (need) {
    ctx.buf.s += ')';
  }
}

function ruleExprToplevel(ctx: Ctx, e: TExpr, showImplicit: boolean): void {
  if (e.k === 'var') {
    variable(ctx, e, 0, true);
  } else {
    ruleExpr(ctx, e, showImplicit);
  }
}

function exprList(ctx: Ctx, list: TExpr[], showImplicit: boolean, toplevel = false): void {
  list.forEach((x, i) => {
    if (i > 0) {
      ctx.buf.s += ', ';
    }
    if (toplevel) {
      ruleExprToplevel(ctx, x, showImplicit);
    } else {
      ruleExpr(ctx, x, showImplicit);
    }
  });
}

function coercion(ctx: Ctx, arg: TExpr, resultType: number, resultTypmod: number, parent: TExpr): void {
  if (arg.k === 'const' && arg.type === resultType && arg.typmod === -1) {
    ctx.buf.s += constExpr(ctx, arg, -1);
  } else {
    if (!ctx.opts.paren) {
      ctx.buf.s += '(';
    }
    exprParen(ctx, arg, false, parent);
    if (!ctx.opts.paren) {
      ctx.buf.s += ')';
    }
  }
  ctx.buf.s += '::' + fmtType(ctx.d, resultType, resultTypmod);
}

function wrapParens(ctx: Ctx, body: () => void): void {
  if (!ctx.opts.paren) {
    ctx.buf.s += '(';
  }
  body();
  if (!ctx.opts.paren) {
    ctx.buf.s += ')';
  }
}

function aggOrder(ctx: Ctx, agg: AggNode): void {
  agg.order.forEach((o, i) => {
    if (i > 0) {
      ctx.buf.s += ', ';
    }
    sortExpr(ctx, o.expr);
    ctx.buf.s += sortDecoration(o.desc, o.nullsFirst, o.useOpName);
  });
}

/** get_func_sql_syntax */
function funcSqlSyntax(ctx: Ctx, e: TExpr & { k: 'func' }): boolean {
  const a = e.args;
  const out = (str: string) => {
    ctx.buf.s += str;
  };
  const x = (n: TExpr) => ruleExpr(ctx, n, false);
  switch (e.funcName) {
    case 'timezone':
      if (a.length === 2) {
        out('(');
        exprParen(ctx, a[1], false, e);
        out(' AT TIME ZONE ');
        exprParen(ctx, a[0], false, e);
        out(')');
      } else {
        out('(');
        exprParen(ctx, a[0], false, e);
        out(' AT LOCAL)');
      }
      return true;
    case 'extract':
    case 'date_part':
      if (a[0]?.k !== 'const' || a[0].isNull) {
        return false;
      }
      out(`EXTRACT(${String(a[0].value)} FROM `);
      x(a[1]);
      out(')');
      return true;
    case 'position':
      out('POSITION((');
      x(a[1]);
      out(') IN (');
      x(a[0]);
      out('))');
      return true;
    case 'substring':
      out('SUBSTRING(');
      x(a[0]);
      if (a.length === 3 && a[1].type === a[0].type) {
        out(' SIMILAR ');
        x(a[1]);
        out(' ESCAPE ');
        x(a[2]);
      } else {
        out(' FROM ');
        x(a[1]);
        if (a.length === 3) {
          out(' FOR ');
          x(a[2]);
        }
      }
      out(')');
      return true;
    case 'btrim':
    case 'ltrim':
    case 'rtrim':
      out(`TRIM(${e.funcName === 'btrim' ? 'BOTH' : e.funcName === 'ltrim' ? 'LEADING' : 'TRAILING'}`);
      if (a.length === 2) {
        out(' ');
        x(a[1]);
      }
      out(' FROM ');
      x(a[0]);
      out(')');
      return true;
    case 'overlay':
      out('OVERLAY(');
      x(a[0]);
      out(' PLACING ');
      x(a[1]);
      out(' FROM ');
      x(a[2]);
      if (a.length === 4) {
        out(' FOR ');
        x(a[3]);
      }
      out(')');
      return true;
    case 'normalize':
      out('NORMALIZE(');
      x(a[0]);
      if (a.length === 2 && a[1].k === 'const' && !a[1].isNull) {
        out(`, ${String(a[1].value)}`);
      }
      out(')');
      return true;
    case 'pg_collation_for':
      out('COLLATION FOR (');
      x(a[0]);
      out(')');
      return true;
    default:
      return false;
  }
}

/** get_rule_expr */
function ruleExpr(ctx: Ctx, e: TExpr, showImplicit: boolean): void {
  const b = ctx.buf;
  switch (e.k) {
    case 'var':
      variable(ctx, e, 0, false);
      return;
    case 'const':
      b.s += constExpr(ctx, e, 0);
      return;
    case 'param':
      b.s += `$${e.paramId}`;
      return;
    case 'default':
      b.s += 'DEFAULT';
      return;
    case 'agg':
      b.s += `${funcName(ctx.d, e.aggOid, e.aggName)}(${e.distinct ? 'DISTINCT ' : ''}`;
      if (e.aggKind !== 'n') {
        exprList(ctx, e.directArgs, true);
        b.s += ') WITHIN GROUP (ORDER BY ';
        aggOrder(ctx, e);
      } else {
        if (e.star) {
          b.s += '*';
        } else {
          exprList(ctx, e.args, true);
        }
        if (e.order.length > 0) {
          b.s += ' ORDER BY ';
          aggOrder(ctx, e);
        }
      }
      if (e.filter) {
        b.s += ') FILTER (WHERE ';
        ruleExpr(ctx, e.filter, false);
      }
      b.s += ')';
      return;
    case 'window': {
      b.s += `${funcName(ctx.d, e.funcOid, e.funcName)}(`;
      if (e.star) {
        b.s += '*';
      } else {
        exprList(ctx, e.args, true);
      }
      if (e.filter) {
        b.s += ') FILTER (WHERE ';
        ruleExpr(ctx, e.filter, false);
      }
      b.s += ') OVER ';
      const wc = ctx.windowClause?.[e.winRef];
      if (wc) {
        if (wc.name) {
          b.s += quoteIdentifier(wc.name);
        } else {
          windowSpec(ctx, wc, ctx.targetList ?? []);
        }
      }
      return;
    }
    case 'grouping': {
      const q = ctx.namespaces[e.levelsUp]?.q;
      b.s += 'GROUPING(';
      e.refs.forEach((r, i) => {
        if (i > 0) {
          b.s += ', ';
        }
        const g = q?.groupClause[r];
        const tle = g ? q!.targetList.find((t) => t.sortGroupRef === g.tleSortGroupRef) : undefined;
        if (tle) {
          ruleExpr(ctx, tle.expr, true);
        }
      });
      b.s += ')';
      return;
    }
    case 'subscript': {
      const needParens = e.arg.k !== 'var' && e.arg.k !== 'fieldselect';
      if (needParens) {
        b.s += '(';
      }
      ruleExpr(ctx, e.arg, showImplicit);
      if (needParens) {
        ctx.buf.s += ')';
      }
      e.upper.forEach((u, i) => {
        ctx.buf.s += '[';
        if (e.lower) {
          const l = e.lower[i];
          if (l) {
            ruleExpr(ctx, l, false);
          }
          ctx.buf.s += ':';
        }
        if (u) {
          ruleExpr(ctx, u, false);
        }
        ctx.buf.s += ']';
      });
      return;
    }
    case 'func': {
      if (e.format === 'implicit_cast' && !showImplicit) {
        exprParen(ctx, e.args[0], false, e);
        return;
      }
      if (e.format === 'explicit_cast' || e.format === 'implicit_cast') {
        const typmod = e.args.length > 1 && e.args[1].k === 'const' ? (e.args[1].value as number) : -1;
        coercion(ctx, e.args[0], e.type, typmod, e);
        return;
      }
      if (e.format === 'sql_syntax' && funcSqlSyntax(ctx, e)) {
        return;
      }
      b.s += `${funcName(ctx.d, e.funcOid, e.funcName)}(`;
      e.args.forEach((a, i) => {
        if (i > 0) {
          ctx.buf.s += ', ';
        }
        const argName = e.argNames?.[i];
        if (argName) {
          ctx.buf.s += `${quoteIdentifier(argName)} => `;
        }
        ruleExpr(ctx, a, true);
      });
      ctx.buf.s += ')';
      return;
    }
    case 'op':
      wrapParens(ctx, () => {
        if (e.args.length === 2) {
          exprParen(ctx, e.args[0], true, e);
          ctx.buf.s += ` ${e.opName} `;
          exprParen(ctx, e.args[1], true, e);
        } else {
          ctx.buf.s += `${e.opName} `;
          exprParen(ctx, e.args[0], true, e);
        }
      });
      return;
    case 'distinct': {
      const inner = () =>
        wrapParens(ctx, () => {
          exprParen(ctx, e.args[0], true, { ...e, isNot: false });
          ctx.buf.s += ' IS DISTINCT FROM ';
          exprParen(ctx, e.args[1], true, { ...e, isNot: false });
        });
      if (!e.isNot) {
        inner();
        return;
      }
      wrapParens(ctx, () => {
        ctx.buf.s += 'NOT ';
        const plain: TExpr = { ...e, isNot: false };
        const need = ctx.opts.paren && !isSimpleNode(plain, { k: 'bool', op: 'not', args: [plain], type: e.type, typmod: -1, collation: 0 }, true);
        if (need) {
          ctx.buf.s += '(';
        }
        inner();
        if (need) {
          ctx.buf.s += ')';
        }
      });
      return;
    }
    case 'relabel':
    case 'iocoerce':
    case 'arraycoerce':
      if (e.format === 'implicit_cast' && !showImplicit) {
        exprParen(ctx, e.arg, false, e);
      } else {
        coercion(ctx, e.arg, e.type, e.k === 'iocoerce' ? -1 : e.typmod, e);
      }
      return;
    case 'domaincoerce':
      if (e.format === 'implicit_cast' && !showImplicit) {
        ruleExpr(ctx, e.arg, false);
      } else {
        coercion(ctx, e.arg, e.type, e.typmod, e);
      }
      return;
    case 'collate':
      wrapParens(ctx, () => {
        exprParen(ctx, e.arg, showImplicit, e);
        ctx.buf.s += ` COLLATE ${quoteIdentifier(ctx.d.catalog.getCollation(e.collation)?.name ?? 'default')}`;
      });
      return;
    case 'case': {
      keyword(ctx, 'CASE', 0, PRETTYINDENT_VAR, 0);
      if (e.arg) {
        ctx.buf.s += ' ';
        ruleExpr(ctx, e.arg, true);
      }
      for (const w of e.whens) {
        let cond = w.cond;
        if (e.arg && cond.k === 'op' && cond.args.length === 2) {
          let left = cond.args[0];
          while (left.k === 'relabel' || (left.k === 'func' && left.format === 'implicit_cast')) {
            left = left.k === 'relabel' ? left.arg : left.args[0];
          }
          if (left.k === 'execparam') {
            cond = cond.args[1];
          }
        }
        if (!ctx.opts.indent) {
          ctx.buf.s += ' ';
        }
        keyword(ctx, 'WHEN ', 0, 0, 0);
        ruleExpr(ctx, cond, false);
        ctx.buf.s += ' THEN ';
        ruleExpr(ctx, w.result, true);
      }
      if (!ctx.opts.indent) {
        ctx.buf.s += ' ';
      }
      keyword(ctx, 'ELSE ', 0, 0, 0);
      ruleExpr(ctx, e.def, true);
      if (!ctx.opts.indent) {
        ctx.buf.s += ' ';
      }
      keyword(ctx, 'END', -PRETTYINDENT_VAR, 0, 0);
      return;
    }
    case 'array':
      b.s += 'ARRAY[';
      exprList(ctx, e.elements, true);
      ctx.buf.s += ']';
      if (e.elements.length === 0) {
        ctx.buf.s += '::' + fmtType(ctx.d, e.type, -1);
      }
      return;
    case 'row':
      b.s += 'ROW(';
      exprList(ctx, e.args, true, true);
      ctx.buf.s += ')';
      return;
    case 'rowcompare':
      b.s += '(ROW(';
      exprList(ctx, e.largs, true, true);
      ctx.buf.s += `) ${e.op} ROW(`;
      exprList(ctx, e.rargs, true, true);
      ctx.buf.s += '))';
      return;
    case 'coalesce':
    case 'minmax':
    case 'nullif':
      b.s += `${e.k === 'coalesce' ? 'COALESCE' : e.k === 'nullif' ? 'NULLIF' : e.op.toUpperCase()}(`;
      exprList(ctx, e.args, true);
      ctx.buf.s += ')';
      return;
    case 'sqlvalue':
      b.s += /_N$/.test(e.op) && e.typmod >= 0 ? `${e.op.replace(/_N$/, '')}(${e.typmod})` : e.op.replace(/_N$/, '');
      return;
    case 'bool':
      wrapParens(ctx, () => {
        if (e.op === 'not') {
          ctx.buf.s += 'NOT ';
          exprParen(ctx, e.args[0], false, e);
          return;
        }
        e.args.forEach((a, i) => {
          if (i > 0) {
            ctx.buf.s += e.op === 'and' ? ' AND ' : ' OR ';
          }
          exprParen(ctx, a, false, e);
        });
      });
      return;
    case 'nulltest':
      wrapParens(ctx, () => {
        exprParen(ctx, e.arg, true, e);
        ctx.buf.s += e.isNot ? ' IS NOT NULL' : ' IS NULL';
      });
      return;
    case 'booltest':
      wrapParens(ctx, () => {
        exprParen(ctx, e.arg, false, e);
        ctx.buf.s += ' ' + e.test.replace(/_/g, ' ');
      });
      return;
    case 'saop':
      wrapParens(ctx, () => {
        exprParen(ctx, e.args[0], true, e);
        ctx.buf.s += ` ${e.opName} ${e.useOr ? 'ANY' : 'ALL'} (`;
        exprParen(ctx, e.args[1], true, e);
        if (e.args[1].k === 'sublink' && e.args[1].linkType === 'EXPR') {
          ctx.buf.s += '::' + fmtType(ctx.d, e.args[1].type, e.args[1].typmod);
        }
        ctx.buf.s += ')';
      });
      return;
    case 'sublink': {
      b.s += e.linkType === 'ARRAY' ? 'ARRAY(' : '(';
      let opname = e.operators[0]?.opName ?? '=';
      if (e.testLeft.length === 1 && (e.linkType === 'ANY' || e.linkType === 'ALL' || e.linkType === 'ROWCOMPARE')) {
        ruleExpr(ctx, e.testLeft[0], true);
      } else if (e.testLeft.length > 1) {
        ctx.buf.s += '(';
        exprList(ctx, e.testLeft, true);
        ctx.buf.s += ')';
      } else {
        opname = '=';
      }
      let needParen = true;
      switch (e.linkType) {
        case 'EXISTS':
          ctx.buf.s += 'EXISTS ';
          break;
        case 'ANY':
          ctx.buf.s += opname === '=' ? ' IN ' : ` ${opname} ANY `;
          break;
        case 'ALL':
          ctx.buf.s += ` ${opname} ALL `;
          break;
        case 'ROWCOMPARE':
          ctx.buf.s += ` ${opname} `;
          break;
        default:
          needParen = false;
      }
      if (needParen) {
        ctx.buf.s += '(';
      }
      queryDef(ctx.d, e.subquery, ctx.buf, ctx.namespaces, null, false, ctx.opts, ctx.indentLevel);
      ctx.buf.s += needParen ? '))' : ')';
      return;
    }
    case 'fieldselect': {
      const needParens = e.arg.k !== 'subscript' && e.arg.k !== 'fieldselect';
      if (needParens) {
        b.s += '(';
      }
      ruleExpr(ctx, e.arg, true);
      if (needParens) {
        ctx.buf.s += ')';
      }
      ctx.buf.s += '.' + quoteIdentifier(e.fieldName);
      return;
    }
    case 'execparam':
    case 'groupkey':
      return;
  }
}
