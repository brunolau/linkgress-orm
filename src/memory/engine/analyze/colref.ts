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
      if (idx >= 0) {
        if (result) {
          throw new PgError(SqlState.AMBIGUOUS_COLUMN, `column reference "${colname}" is ambiguous`);
        }
        result = varForColumn(item.rte, item.rtIndex, idx, levelsUp);
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

export function columnDoesNotExist(colname: string, relname?: string): PgError {
  if (relname) {
    return new PgError(SqlState.UNDEFINED_COLUMN, `column ${relname}.${colname} does not exist`);
  }
  return new PgError(SqlState.UNDEFINED_COLUMN, `column "${colname}" does not exist`);
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
