import type * as A from '../ast';
import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';
import { RTE, TExpr, VarNode } from './nodes';
import { NsItem, ParseState } from './parse-state';

/**
 * Column / relation name resolution (parse_relation.c).
 */

export function varForColumn(rte: RTE, rtIndex: number, colIndex: number, levelsUp: number): TExpr {
  if (rte.kind === 'join') {
    const v = rte.aliasVars[colIndex];
    return levelsUp === 0 ? v : incrementLevels(v, levelsUp);
  }
  const ti = rte.colTypes[colIndex];
  const node: VarNode = { k: 'var', levelsUp, rtIndex, attno: colIndex, type: ti.type, typmod: ti.typmod, collation: ti.collation };
  return node;
}

/**
 * System columns of a table reference (PostgreSQL attnums -1 .. -6). Their Vars use attno
 * `SYSTEM_ATTNO_BASE + attnum` (attno -1 is the whole-row reference).
 */
export const SYSTEM_ATTNO_BASE = -10;

const SYSTEM_COLUMNS: Record<string, { attnum: number; type: number }> = {
  ctid: { attnum: -1, type: TypeOid.tid },
  xmin: { attnum: -2, type: TypeOid.xid },
  cmin: { attnum: -3, type: TypeOid.cid },
  xmax: { attnum: -4, type: TypeOid.xid },
  cmax: { attnum: -5, type: TypeOid.cid },
  tableoid: { attnum: -6, type: TypeOid.oid },
};

export const SYSTEM_COLUMN_NAMES: Record<number, string> = Object.fromEntries(Object.entries(SYSTEM_COLUMNS).map(([name, c]) => [SYSTEM_ATTNO_BASE + c.attnum, name]));

export function isSystemAttno(attno: number): boolean {
  return attno <= SYSTEM_ATTNO_BASE - 1;
}

/** A system column of a table (not of a subquery, function or join) named `colname`, or null. */
export function systemColumnVar(item: NsItem, colname: string, levelsUp: number): TExpr | null {
  const sys = Object.prototype.hasOwnProperty.call(SYSTEM_COLUMNS, colname) ? SYSTEM_COLUMNS[colname] : undefined;
  if (!sys || item.rte.kind !== 'relation') {
    return null;
  }
  return { k: 'var', levelsUp, rtIndex: item.rtIndex, attno: SYSTEM_ATTNO_BASE + sys.attnum, type: sys.type, typmod: -1, collation: 0 };
}

/** Adjust levelsUp of Vars in an expression copied into a deeper level. */
export function incrementLevels(e: TExpr, delta: number): TExpr {
  if (delta === 0) {
    return e;
  }
  const visit = (x: TExpr): TExpr => {
    if (x.k === 'var') {
      return { ...x, levelsUp: x.levelsUp + delta };
    }
    if (x.k === 'coalesce') {
      return { ...x, args: x.args.map(visit) };
    }
    if (x.k === 'relabel' || x.k === 'iocoerce' || x.k === 'domaincoerce') {
      return { ...x, arg: visit(x.arg) } as TExpr;
    }
    if (x.k === 'func' || x.k === 'op') {
      return { ...x, args: x.args.map(visit) } as TExpr;
    }
    return x;
  };
  return visit(e);
}

/** Find a column by name within one namespace item. Returns index or -1; throws if ambiguous. */
export function scanNsItemForColumn(item: NsItem, colname: string): number {
  let found = -1;
  const names = item.rte.eref.colnames;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === colname) {
      if (found >= 0) {
        throw new PgError(SqlState.AMBIGUOUS_COLUMN, `column reference "${colname}" is ambiguous`);
      }
      found = i;
    }
  }
  return found;
}

function itemVisibleForColumns(pstate: ParseState, item: NsItem): boolean {
  if (!item.colsVisible) {
    return false;
  }
  if (item.lateralOnly && !(pstate.lateralActive && item.lateralOk)) {
    return false;
  }
  return true;
}

function itemVisibleForRel(pstate: ParseState, item: NsItem): boolean {
  if (!item.relVisible) {
    return false;
  }
  if (item.lateralOnly && !(pstate.lateralActive && item.lateralOk)) {
    return false;
  }
  return true;
}

/** colNameToVar: search all levels for an unqualified column name. */
export function colNameToVar(an: Analyzer, pstate: ParseState, colname: string, missingOk: boolean): TExpr | null {
  let levelsUp = 0;
  let ps: ParseState | null = pstate;
  while (ps) {
    let result: TExpr | null = null;
    for (const item of ps.namespace) {
      if (!itemVisibleForColumns(ps, item)) {
        continue;
      }
      const idx = scanNsItemForColumn(item, colname);
      const found = idx >= 0 ? varForColumn(item.rte, item.rtIndex, idx, levelsUp) : systemColumnVar(item, colname, levelsUp);
      if (found) {
        if (result) {
          throw new PgError(SqlState.AMBIGUOUS_COLUMN, `column reference "${colname}" is ambiguous`);
        }
        result = found;
      }
    }
    if (result) {
      noteOuterRef(pstate, levelsUp);
      return result;
    }
    ps = ps.parent;
    levelsUp++;
  }
  if (missingOk) {
    return null;
  }
  return null;
}

export function noteOuterRef(pstate: ParseState, levelsUp: number): void {
  if (levelsUp > 0) {
    let ps: ParseState | null = pstate;
    let lvl = levelsUp;
    while (ps && lvl > 0) {
      if (ps.maxOuterRef < lvl) {
        ps.maxOuterRef = lvl;
      }
      ps = ps.parent;
      lvl--;
    }
  }
}

/** refnameNamespaceItem: find the namespace item for a relation reference `schema.rel` / `rel`. */
export function refnameNsItem(an: Analyzer, pstate: ParseState, schema: string | undefined, relname: string): { item: NsItem; levelsUp: number } | null {
  let levelsUp = 0;
  let ps: ParseState | null = pstate;
  let schemaOid: number | undefined;
  if (schema) {
    const ns = an.catalog.findNamespace(schema);
    if (!ns) {
      // PostgreSQL reports missing FROM-clause entry
      return null;
    }
    schemaOid = ns.oid;
  }
  while (ps) {
    let result: NsItem | null = null;
    for (const item of ps.namespace) {
      if (!itemVisibleForRel(ps, item)) {
        continue;
      }
      if (schemaOid !== undefined) {
        if (item.rte.kind !== 'relation' && item.rte.kind !== 'catalog') {
          continue;
        }
        if (item.rte.alias !== undefined) {
          continue;
        }
        const rel = an.catalog.getRelation(item.rte.relOid);
        if (!rel || rel.nspOid !== schemaOid || rel.name !== relname) {
          continue;
        }
      } else if (item.rte.eref.aliasname !== relname) {
        continue;
      }
      if (result) {
        throw new PgError(SqlState.AMBIGUOUS_ALIAS, `table reference "${relname}" is ambiguous`);
      }
      result = item;
    }
    if (result) {
      noteOuterRef(pstate, levelsUp);
      return { item: result, levelsUp };
    }
    ps = ps.parent;
    levelsUp++;
  }
  return null;
}

/** Error for a missing relation reference, with PostgreSQL's hints. */
export function missingRteError(an: Analyzer, pstate: ParseState, relname: string): PgError {
  // look for an RTE whose underlying relation has this name but is aliased, or a hidden lateral item
  let ps: ParseState | null = pstate;
  while (ps) {
    for (const item of ps.namespace) {
      const rte = item.rte;
      if ((rte.kind === 'relation' || rte.kind === 'catalog') && rte.relname === relname && rte.alias !== undefined && item.relVisible) {
        return new PgError(SqlState.UNDEFINED_TABLE, `invalid reference to FROM-clause entry for table "${relname}"`, {
          hint: `Perhaps you meant to reference the table alias "${rte.eref.aliasname}".`,
        });
      }
      if (rte.eref.aliasname === relname && item.relVisible && item.lateralOnly) {
        return new PgError(SqlState.UNDEFINED_TABLE, `invalid reference to FROM-clause entry for table "${relname}"`, {
          detail: `There is an entry for table "${relname}", but it cannot be referenced from this part of the query.`,
          hint: rte.kind === 'subquery' || rte.kind === 'function' ? 'To reference that table, you must mark this subquery with LATERAL.' : undefined,
        });
      }
    }
    ps = ps.parent;
  }
  void an;
  return new PgError(SqlState.UNDEFINED_TABLE, `missing FROM-clause entry for table "${relname}"`);
}

/** Whole-row reference to a namespace item. */
export function wholeRowVar(an: Analyzer, item: NsItem, levelsUp: number): TExpr {
  const rte = item.rte;
  if (rte.kind === 'relation') {
    const rel = an.catalog.getRelation(rte.relOid);
    const type = rel && rel.rowTypeOid ? rel.rowTypeOid : TypeOid.record;
    return { k: 'var', levelsUp, rtIndex: item.rtIndex, attno: -1, type, typmod: -1, collation: 0 };
  }
  if (rte.kind === 'catalog' && rte.rowTypeOid) {
    // a transition table has the row type of its table
    return { k: 'var', levelsUp, rtIndex: item.rtIndex, attno: -1, type: rte.rowTypeOid, typmod: -1, collation: 0 };
  }
  if (rte.kind === 'join') {
    // ROW() of all join columns
    return {
      k: 'row',
      args: rte.aliasVars.map((v) => incrementLevels(v, levelsUp)),
      fieldNames: rte.eref.colnames.slice(),
      explicitRow: false,
      type: TypeOid.record,
      typmod: -1,
      collation: 0,
    };
  }
  if (rte.kind === 'function' && rte.functions.length === 1 && !rte.ordinality && !rte.functions[0].expandComposite && rte.colTypes.length === 1) {
    // scalar function RTE: whole-row reference yields the scalar value
    const ti = rte.colTypes[0];
    return { k: 'var', levelsUp, rtIndex: item.rtIndex, attno: 0, type: ti.type, typmod: ti.typmod, collation: ti.collation };
  }
  return { k: 'var', levelsUp, rtIndex: item.rtIndex, attno: -1, type: TypeOid.record, typmod: -1, collation: 0 };
}

export function columnDoesNotExist(colname: string, relname?: string, pstate?: ParseState): PgError {
  const message = relname ? `column ${relname}.${colname} does not exist` : `column "${colname}" does not exist`;
  if (!pstate) {
    return new PgError(SqlState.UNDEFINED_COLUMN, message);
  }
  return new PgError(SqlState.UNDEFINED_COLUMN, message, missingColumnDetails(pstate, relname, colname));
}

/** MAX_FUZZY_DISTANCE of parse_relation.c */
const MAX_FUZZY_DISTANCE = 3;

/** varstr_levenshtein (insertion, deletion and substitution cost 1), over code points */
function levenshtein(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * errorMissingColumn's detail / hint: an exact match in a table this part of the query cannot reference,
 * or up to two closest column names (searchRangeTableForCol + updateFuzzyAttrMatchState).
 */
function missingColumnDetails(pstate: ParseState, alias: string | undefined, colname: string): { detail?: string; hint?: string } {
  let distance = MAX_FUZZY_DISTANCE + 1;
  let first: { rte: RTE; col: string } | null = null;
  let second: { rte: RTE; col: string } | null = null;
  let exact1: { rte: RTE; ps: ParseState } | null = null;
  let exact2: RTE | null = null;
  const update = (penalty: number, rte: RTE, actual: string) => {
    if (penalty > distance || actual === '') {
      return;
    }
    const matchlen = [...colname].length;
    let d = levenshtein(actual, colname);
    if (d > Math.floor(matchlen / 2)) {
      return;
    }
    d += penalty;
    if (d < distance) {
      distance = d;
      first = { rte, col: actual };
      second = null;
    } else if (d === distance) {
      if (second) {
        // too many equally distant matches
        distance = d - 1;
        first = null;
        second = null;
      } else if (first) {
        second = { rte, col: actual };
      } else if (distance <= MAX_FUZZY_DISTANCE) {
        first = { rte, col: actual };
      }
    }
  };
  search: for (let ps: ParseState | null = pstate; ps; ps = ps.parent) {
    for (const rte of ps.query.rtable) {
      if (!rte || rte.kind === 'join') {
        continue;
      }
      const penalty = alias !== undefined ? Math.min(levenshtein(alias, rte.eref.aliasname), MAX_FUZZY_DISTANCE + 1) : 0;
      let exact = false;
      for (const name of rte.eref.colnames) {
        if (name === colname) {
          exact = true;
        }
        update(penalty, rte, name);
      }
      if (exact && penalty === 0) {
        if (!exact1) {
          exact1 = { rte, ps };
        } else if (!exact2) {
          exact2 = rte;
        } else {
          exact1 = null;
          exact2 = null;
          break search;
        }
      }
    }
  }
  const e1 = exact1 as { rte: RTE; ps: ParseState } | null;
  if (e1 && exact2) {
    return {
      detail: `There are columns named "${colname}", but they are in tables that cannot be referenced from this part of the query.`,
      hint: alias === undefined ? 'Try using a table-qualified name.' : undefined,
    };
  }
  if (e1) {
    let item: NsItem | undefined;
    for (let ps: ParseState | null = pstate; ps && !item; ps = ps.parent) {
      item = ps.namespace.find((n) => n.rte === e1.rte);
    }
    const lateral = !!item && item.lateralOnly;
    const qualified = alias === undefined && !!item && item.relVisible && !item.colsVisible;
    return {
      detail: `There is a column named "${colname}" in table "${e1.rte.eref.aliasname}", but it cannot be referenced from this part of the query.`,
      hint: lateral ? 'To reference that column, you must mark this subquery with LATERAL.' : qualified ? 'To reference that column, you must use a table-qualified name.' : undefined,
    };
  }
  const f = first as { rte: RTE; col: string } | null;
  const s = second as { rte: RTE; col: string } | null;
  if (!f) {
    return {};
  }
  if (!s) {
    return { hint: `Perhaps you meant to reference the column "${f.rte.eref.aliasname}.${f.col}".` };
  }
  return { hint: `Perhaps you meant to reference the column "${f.rte.eref.aliasname}.${f.col}" or the column "${s.rte.eref.aliasname}.${s.col}".` };
}

/** Expand `rel.*` / `*` into (name, expr) pairs. */
export function expandNsItemColumns(item: NsItem, levelsUp: number): { name: string; expr: TExpr; colIndex: number }[] {
  const out: { name: string; expr: TExpr; colIndex: number }[] = [];
  const names = item.rte.eref.colnames;
  for (let i = 0; i < names.length; i++) {
    if (item.rte.kind === 'relation' && names[i] === '') {
      continue;
    }
    out.push({ name: names[i], expr: varForColumn(item.rte, item.rtIndex, i, levelsUp), colIndex: i });
  }
  return out;
}

export function isColumnRefStar(node: A.Expr): boolean {
  return node.kind === 'ColumnRef' && node.fields[node.fields.length - 1] === '*';
}
