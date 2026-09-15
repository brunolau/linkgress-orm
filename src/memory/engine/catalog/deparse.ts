import { isSystemAttno, SYSTEM_COLUMN_NAMES } from '../analyze/colref';
import { Query, TExpr } from '../analyze/nodes';
import { quoteIdentifier, quoteLiteral, TypeUtil } from '../analyze/typeutil';
import { CatalogFunctions, StatementState } from '../exec/runtime';
import type { Session } from '../session';
import { SessionHost } from '../session';
import { outputValue } from '../types/io';
import { analyzeStatementAsSubquery } from '../analyze/select';
import { Catalog, Relation, StoredExpr, TypeOid } from './catalog';
import { viewDefinition } from './ruleutils';

export interface DeparseCtx {
  session: Session;
  catalog: Catalog;
  types: TypeUtil;
  pretty: boolean;
  q: Query | null;
  qualifyVars: boolean;
  /** EXPLAIN scan quals: the scanned relation's own columns stay unqualified */
  unqualifiedRt?: number;
}

export function fmtType(ctx: DeparseCtx, oid: number, typmod: number): string {
  return ctx.types.formatType(oid, typmod, true, false, ctx.session.searchPathNamespaces());
}

export function constText(ctx: DeparseCtx, e: TExpr & { k: 'const' }, showtype: number): string {
  if (e.isNull) {
    if (showtype < 0) {
      return 'NULL';
    }
    return e.type === TypeOid.unknown ? 'NULL' : `NULL::${fmtType(ctx, e.type, e.typmod)}`;
  }
  const ext = outputValue(e.type, e.value, ctx.session.io);
  let out: string;
  let needLabel = false;
  switch (e.type) {
    case TypeOid.int4:
      if (!ext.startsWith('-')) {
        out = ext;
      } else {
        out = `'${ext}'`;
        needLabel = true;
      }
      break;
    case TypeOid.numeric:
      if (/^\d/.test(ext) && /[eE.]/.test(ext)) {
        out = ext;
      } else {
        out = `'${ext}'`;
        needLabel = true;
      }
      break;
    case TypeOid.bool:
      out = e.value ? 'true' : 'false';
      break;
    default:
      out = quoteLiteral(ext);
  }
  if (showtype < 0) {
    return out;
  }
  switch (e.type) {
    case TypeOid.bool:
    case TypeOid.unknown:
      needLabel = false;
      break;
    case TypeOid.int4:
      break;
    case TypeOid.numeric:
      needLabel = needLabel || e.typmod >= 0;
      break;
    default:
      needLabel = true;
  }
  if (needLabel || showtype > 0) {
    out += '::' + fmtType(ctx, e.type, e.typmod);
  }
  return out;
}

function looksLikeFunction(e: TExpr): boolean {
  switch (e.k) {
    case 'func':
      return e.format === 'call' || e.format === 'sql_syntax';
    case 'coalesce':
    case 'minmax':
    case 'nullif':
    case 'sqlvalue':
      return true;
    default:
      return false;
  }
}

function isSimple(e: TExpr): boolean {
  switch (e.k) {
    case 'var':
    case 'const':
    case 'param':
    case 'coalesce':
    case 'minmax':
    case 'sqlvalue':
    case 'nullif':
    case 'array':
    case 'row':
      return true;
    case 'func':
      return e.format === 'call' || e.format === 'sql_syntax';
    default:
      return false;
  }
}

export function funcName(ctx: DeparseCtx, oid: number, name: string): string {
  const proc = ctx.catalog.getProc(oid);
  if (!proc) {
    return quoteIdentifier(name);
  }
  const visible = ctx.session.functionSearchPath();
  if (visible.includes(proc.nspOid)) {
    return quoteIdentifier(proc.name);
  }
  return quoteIdentifier(ctx.catalog.namespaceName(proc.nspOid)) + '.' + quoteIdentifier(proc.name);
}

function coercion(ctx: DeparseCtx, arg: TExpr, resultType: number, resultTypmod: number): string {
  let inner: string;
  if (arg.k === 'const' && arg.type === resultType && arg.typmod === -1) {
    inner = constText(ctx, arg, -1);
  } else {
    const a = expr(ctx, arg, false);
    inner = ctx.pretty ? (isSimple(arg) ? a : `(${a})`) : `(${a})`;
  }
  return `${inner}::${fmtType(ctx, resultType, resultTypmod)}`;
}

/** get_rule_expr */
export function expr(ctx: DeparseCtx, e: TExpr, showImplicit: boolean): string {
  switch (e.k) {
    case 'var': {
      if (e.attno < 0 && !isSystemAttno(e.attno)) {
        return '*';
      }
      if (!ctx.q) {
        return '?';
      }
      const rte = ctx.q.rtable[e.rtIndex];
      const col = quoteIdentifier(isSystemAttno(e.attno) ? SYSTEM_COLUMN_NAMES[e.attno] : rte.eref.colnames[e.attno]);
      return ctx.qualifyVars && ctx.unqualifiedRt !== e.rtIndex ? `${quoteIdentifier(rte.eref.aliasname)}.${col}` : col;
    }
    case 'const':
      return constText(ctx, e, 0);
    case 'param':
      return `$${e.paramId}`;
    case 'op': {
      const [a, b] = e.args;
      if (e.args.length === 1) {
        const s = `${e.opName} ${paren(ctx, a, true)}`;
        return ctx.pretty ? s : `(${s})`;
      }
      const s = `${paren(ctx, a, true)} ${e.opName} ${paren(ctx, b, true)}`;
      return ctx.pretty ? s : `(${s})`;
    }
    case 'func': {
      if (e.format === 'implicit_cast' && !showImplicit) {
        return expr(ctx, e.args[0], false);
      }
      if (e.format === 'explicit_cast' || e.format === 'implicit_cast') {
        return coercion(ctx, e.args[0], e.type, e.args.length > 1 && e.args[1].k === 'const' ? (e.args[1].value as number) : -1);
      }
      return `${funcName(ctx, e.funcOid, e.funcName)}(${e.args.map((a) => expr(ctx, a, true)).join(', ')})`;
    }
    case 'relabel':
    case 'iocoerce':
    case 'domaincoerce':
      if (e.format === 'implicit_cast' && !showImplicit) {
        return expr(ctx, e.arg, false);
      }
      return coercion(ctx, e.arg, e.type, e.typmod);
    case 'arraycoerce':
      if (e.format === 'implicit_cast' && !showImplicit) {
        return expr(ctx, e.arg, false);
      }
      return coercion(ctx, e.arg, e.type, e.typmod);
    case 'bool': {
      if (e.op === 'not') {
        const s = `NOT ${paren(ctx, e.args[0], false)}`;
        return ctx.pretty ? s : `(${s})`;
      }
      const s = e.args.map((a) => paren(ctx, a, false)).join(e.op === 'and' ? ' AND ' : ' OR ');
      return ctx.pretty ? s : `(${s})`;
    }
    case 'nulltest': {
      const s = `${paren(ctx, e.arg, true)} ${e.isNot ? 'IS NOT NULL' : 'IS NULL'}`;
      return ctx.pretty ? s : `(${s})`;
    }
    case 'booltest': {
      const s = `${paren(ctx, e.arg, true)} ${e.test.replace(/_/g, ' ').replace('IS NOT', 'IS NOT')}`;
      return ctx.pretty ? s : `(${s})`;
    }
    case 'saop': {
      const s = `${paren(ctx, e.args[0], true)} ${e.opName} ${e.useOr ? 'ANY' : 'ALL'} (${expr(ctx, e.args[1], true)})`;
      return ctx.pretty ? s : `(${s})`;
    }
    case 'array':
      return `ARRAY[${e.elements.map((x) => expr(ctx, x, true)).join(', ')}]`;
    case 'row':
      return `ROW(${e.args.map((x) => expr(ctx, x, true)).join(', ')})`;
    case 'coalesce':
      return `COALESCE(${e.args.map((x) => expr(ctx, x, true)).join(', ')})`;
    case 'minmax':
      return `${e.op.toUpperCase()}(${e.args.map((x) => expr(ctx, x, true)).join(', ')})`;
    case 'nullif':
      return `NULLIF(${e.args.map((x) => expr(ctx, x, true)).join(', ')})`;
    case 'case': {
      let s = 'CASE';
      if (e.arg) {
        s += ' ' + expr(ctx, e.arg, true);
      }
      for (const w of e.whens) {
        s += ` WHEN ${expr(ctx, w.cond, false)} THEN ${expr(ctx, w.result, true)}`;
      }
      s += ` ELSE ${expr(ctx, e.def, true)} END`;
      return s;
    }
    case 'sqlvalue':
      return e.op.replace(/_N$/, '');
    case 'distinct': {
      const s = `${paren(ctx, e.args[0], true)} IS ${e.isNot ? 'NOT ' : ''}DISTINCT FROM ${paren(ctx, e.args[1], true)}`;
      return ctx.pretty ? s : `(${s})`;
    }
    case 'collate':
      return `${paren(ctx, e.arg, true)} COLLATE ${quoteIdentifier(ctx.catalog.getCollation(e.collation)?.name ?? 'default')}`;
    case 'fieldselect':
      return `(${expr(ctx, e.arg, true)}).${quoteIdentifier(e.fieldName)}`;
    case 'subscript':
      return `${paren(ctx, e.arg, true)}[${e.upper.map((u) => (u ? expr(ctx, u, true) : '')).join('][')}]`;
    default:
      return '?';
  }
}

function paren(ctx: DeparseCtx, e: TExpr, showImplicit: boolean): string {
  const s = expr(ctx, e, showImplicit);
  if (ctx.pretty && !isSimple(e) && e.k !== 'relabel' && e.k !== 'iocoerce' && !(e.k === 'func' && e.format !== 'call' && e.format !== 'sql_syntax')) {
    return `(${s})`;
  }
  return s;
}

export class CatalogFunctionsImpl implements CatalogFunctions {
  constructor(private readonly session: Session) {}

  private ctx(pretty: boolean, q: Query | null): DeparseCtx {
    const catalog = this.session.catalog();
    return { session: this.session, catalog, types: new TypeUtil(catalog), pretty, q, qualifyVars: false };
  }

  private host(): SessionHost {
    const st = new StatementState(this.session, this.session.catalog(), [], [], { xmax: 0, xip: new Set(), ownXid: 0, curCid: 0 });
    return new SessionHost(this.session, st);
  }

  private analyzed(rel: Relation, stored: StoredExpr, kind: 'check' | 'index' | 'generated' | 'predicate'): { q: Query; expr: TExpr } {
    return this.host().analyzeRelationExpr(rel, stored, kind);
  }

  /** generate_qualified_relation_name (the session's temp schema is spelled pg_temp) */
  private qualifiedRelation(rel: Relation): string {
    const tempNs = this.session.tempNamespace(false);
    const nsp = tempNs && rel.nspOid === tempNs ? 'pg_temp' : this.session.catalog().namespaceName(rel.nspOid);
    return `${quoteIdentifier(nsp)}.${quoteIdentifier(rel.name)}`;
  }

  /** generate_relation_name: unqualified when the relation is visible through the search path */
  private relationName(rel: Relation): string {
    return this.session.resolveRelation(quoteIdentifier(rel.name)) === rel.oid ? quoteIdentifier(rel.name) : this.qualifiedRelation(rel);
  }

  indexDef(indexOid: number, column: number, pretty: boolean): string | null {
    const cat = this.session.catalog();
    const ix = cat.getRelation(indexOid);
    if (!ix || !ix.index) {
      return null;
    }
    const info = ix.index;
    const table = cat.getRelation(info.tableOid)!;
    const keyTexts = info.keys.map((k) => {
      let s: string;
      let colType: number;
      let colColl: number;
      if (k.attnum > 0) {
        const col = table.columns[k.attnum - 1];
        s = quoteIdentifier(col.name);
        colType = col.typeOid;
        colColl = col.collation;
      } else {
        const { q, expr: e } = this.analyzed(table, k.expr!, 'index');
        const str = expr(this.ctx(pretty, q), e, false);
        s = looksLikeFunction(e) ? str : `(${str})`;
        colType = e.type;
        colColl = e.collation;
      }
      if (k.collation && k.collation !== colColl) {
        const coll = cat.getCollation(k.collation);
        s += ` COLLATE ${quoteIdentifier(coll?.name ?? 'default')}`;
      }
      if (k.opclassOid) {
        const oc = cat.builtin.opclasses.get(k.opclassOid);
        const extDef = cat.comments.get(`opclassdef:${k.opclassOid}`);
        const isDefault = oc ? oc.isDefault && (oc.inputType === this.session.makeAnalyzer().types.baseType(colType) || !k.opclassExplicit) : false;
        if (oc && !isDefault) {
          s += ` ${quoteIdentifier(oc.name)}`;
        } else if (!oc && extDef) {
          s += ` ${quoteIdentifier(JSON.parse(extDef).name)}`;
        }
      }
      if (info.method === 'btree') {
        if (k.desc) {
          s += ' DESC';
          if (!k.nullsFirst) {
            s += ' NULLS LAST';
          }
        } else if (k.nullsFirst) {
          s += ' NULLS FIRST';
        }
      }
      return s;
    });
    if (column > 0) {
      return keyTexts[column - 1] ?? null;
    }
    let out = `CREATE ${info.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(ix.name)} ON ${table.kind === 'p' ? 'ONLY ' : ''}${pretty ? this.relationName(table) : this.qualifiedRelation(table)} USING ${info.method} (${keyTexts.join(', ')})`;
    if (info.include.length > 0) {
      out += ` INCLUDE (${info.include.map((a) => quoteIdentifier(table.columns[a - 1].name)).join(', ')})`;
    }
    if (info.nullsNotDistinct) {
      out += ' NULLS NOT DISTINCT';
    }
    if (ix.options.length > 0) {
      out += ` WITH (${ix.options.map((o) => {
        const [k, v] = o.split('=');
        return `${k}='${v}'`;
      }).join(', ')})`;
    }
    if (info.predicate) {
      const { q, expr: e } = this.analyzed(table, info.predicate, 'predicate');
      const str = expr(this.ctx(pretty, q), e, false);
      out += ` WHERE ${str}`;
    }
    return out;
  }

  constraintDef(constraintOid: number, pretty: boolean): string | null {
    const cat = this.session.catalog();
    const con = cat.getConstraint(constraintOid);
    if (!con) {
      return null;
    }
    const rel = cat.getRelation(con.relOid)!;
    const colList = (attnums: number[], r: Relation) => attnums.map((a) => quoteIdentifier(r.columns[a - 1].name)).join(', ');
    switch (con.type) {
      case 'c': {
        const { q, expr: e } = this.analyzed(rel, con.check!, 'check');
        const str = expr(this.ctx(pretty, q), e, false);
        return `CHECK (${str})${con.noInherit ? ' NO INHERIT' : ''}${con.validated ? '' : ' NOT VALID'}`;
      }
      case 'p':
      case 'u': {
        let s = `${con.type === 'p' ? 'PRIMARY KEY' : 'UNIQUE'}${con.type === 'u' && cat.getRelation(con.indexOid)?.index?.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''} (${colList(con.columns, rel)})`;
        const ix = cat.getRelation(con.indexOid);
        if (ix && ix.index && ix.index.include.length > 0) {
          s += ` INCLUDE (${colList(ix.index.include, rel)})`;
        }
        return s;
      }
      case 'f': {
        const ref = cat.getRelation(con.fk!.refRelOid)!;
        const refName = this.relationName(ref);
        let s = `FOREIGN KEY (${colList(con.columns, rel)}) REFERENCES ${refName}(${colList(con.fk!.refColumns, ref)})`;
        if (con.fk!.matchType === 'FULL') {
          s += ' MATCH FULL';
        }
        if (con.fk!.onUpdate !== 'NO ACTION') {
          s += ` ON UPDATE ${con.fk!.onUpdate}`;
        }
        if (con.fk!.onDelete !== 'NO ACTION') {
          s += ` ON DELETE ${con.fk!.onDelete}`;
        }
        if (con.deferrable) {
          s += ' DEFERRABLE';
        }
        if (con.initiallyDeferred) {
          s += ' INITIALLY DEFERRED';
        }
        if (!con.validated) {
          s += ' NOT VALID';
        }
        return s;
      }
      case 'n':
        return `NOT NULL ${quoteIdentifier(rel.columns[con.columns[0] - 1].name)}`;
    }
    return null;
  }

  /** pg_get_viewdef: plain = PRETTYFLAG_INDENT; pretty (or a wrap column) adds PRETTYFLAG_PAREN */
  viewDef(viewOid: number, pretty: boolean, wrapColumn = 0): string | null {
    const rel = this.session.catalog().getRelation(viewOid);
    if (!rel || !rel.view) {
      return null;
    }
    let query: Query;
    try {
      query = analyzeStatementAsSubquery(this.session.makeAnalyzer(), rel.view.query, null, true).query;
    } catch {
      return ' ' + rel.view.text.trim() + ';';
    }
    const columns = rel.columns.filter((c) => !c.isDropped).map((c) => c.name);
    return viewDefinition(this.ctx(pretty, query), query, columns, { paren: pretty, indent: true, wrapColumn });
  }

  partKeyDef(relOid: number): string | null {
    const cat = this.session.catalog();
    const rel = cat.getRelation(relOid);
    if (!rel || !rel.partitionKey) {
      return null;
    }
    const strategy = rel.partitionKey.strategy === 'r' ? 'RANGE' : rel.partitionKey.strategy === 'l' ? 'LIST' : 'HASH';
    const keys = rel.partitionKey.keys.map((k) => {
      if (k.attnum > 0) {
        return quoteIdentifier(rel.columns[k.attnum - 1].name);
      }
      const { q, expr: e } = this.analyzed(rel, k.expr!, 'index');
      const str = expr(this.ctx(false, q), e, false);
      return looksLikeFunction(e) ? str : `(${str})`;
    });
    return `${strategy} (${keys.join(', ')})`;
  }

  statisticsObjDef(statOid: number): string | null {
    const cat = this.session.catalog();
    const s = cat.statistics.get(statOid);
    if (!s) {
      return null;
    }
    const rel = cat.getRelation(s.relOid)!;
    const parts = s.columns.map((a) => quoteIdentifier(rel.columns[a - 1].name));
    for (const e of s.exprs) {
      const { q, expr: te } = this.analyzed(rel, e, 'index');
      const str = expr(this.ctx(false, q), te, false);
      parts.push(looksLikeFunction(te) ? str : `(${str})`);
    }
    const kinds = s.kinds.filter((k) => k !== 'expressions');
    const allKinds = kinds.length === 3 || (kinds.length === 0 && s.exprs.length > 0);
    const kindText = allKinds || kinds.length === 0 ? '' : ` (${kinds.join(', ')})`;
    return `CREATE STATISTICS ${quoteIdentifier(cat.namespaceName(s.nspOid))}.${quoteIdentifier(s.name)}${kindText} ON ${parts.join(', ')} FROM ${quoteIdentifier(rel.name)}`;
  }

  expr(exprValue: unknown, relOid: number, pretty: boolean): string | null {
    if (exprValue === null || exprValue === undefined) {
      return null;
    }
    const holder = exprValue as { __stored?: StoredExpr; __kind?: string; __relOid?: number; __col?: number };
    if (typeof exprValue === 'string') {
      const m = /^__default:(\d+):(\d+)$/.exec(exprValue);
      if (m) {
        return this.defaultText(Number(m[1]), Number(m[2]), pretty);
      }
      const c = /^__check:(\d+)$/.exec(exprValue);
      if (c) {
        const def = this.constraintDef(Number(c[1]), pretty);
        return def ? def.replace(/^CHECK \((.*)\)( NO INHERIT)?( NOT VALID)?$/, '$1') : null;
      }
      const ip = /^__(indpred|indexprs):(\d+)$/.exec(exprValue);
      if (ip) {
        const cat = this.session.catalog();
        const ix = cat.getRelation(Number(ip[2]));
        const table = ix?.index ? cat.getRelation(ix.index.tableOid) : undefined;
        if (!ix || !ix.index || !table) {
          return null;
        }
        if (ip[1] === 'indpred') {
          if (!ix.index.predicate) {
            return null;
          }
          const { q, expr: e } = this.analyzed(table, ix.index.predicate, 'predicate');
          return expr(this.ctx(pretty, q), e, false);
        }
        const parts = ix.index.keys
          .filter((k) => k.attnum === 0 && k.expr)
          .map((k) => {
            const { q, expr: e } = this.analyzed(table, k.expr!, 'index');
            return expr(this.ctx(pretty, q), e, false);
          });
        return parts.join(', ');
      }
      return exprValue;
    }
    void holder;
    void relOid;
    return null;
  }

  defaultText(relOid: number, attnum: number, pretty: boolean): string | null {
    const cat = this.session.catalog();
    const rel = cat.getRelation(relOid);
    const col = rel?.columns[attnum - 1];
    if (!rel || !col || !col.defaultExpr) {
      return null;
    }
    if (col.generated) {
      const { q, expr: e } = this.analyzed(rel, col.defaultExpr, 'generated');
      return expr({ ...this.ctx(pretty, q) }, e, false);
    }
    const { expr: e } = this.host().analyzeDefault(rel, col);
    return expr(this.ctx(pretty, null), e, false);
  }

  objDescription(objOid: number, catalogName: string | null): string | null {
    const cat = this.session.catalog();
    const classOid: Record<string, number> = { pg_class: 1259, pg_namespace: 2615, pg_type: 1247, pg_proc: 1255, pg_constraint: 2606, pg_database: 1262, pg_extension: 3079 };
    if (catalogName) {
      return cat.comments.get(`${classOid[catalogName] ?? 0}:${objOid}:0`) ?? null;
    }
    for (const k of Object.values(classOid)) {
      const v = cat.comments.get(`${k}:${objOid}:0`);
      if (v !== undefined) {
        return v;
      }
    }
    return null;
  }

  colDescription(relOid: number, attnum: number): string | null {
    return this.session.catalog().comments.get(`1259:${relOid}:${attnum}`) ?? null;
  }

  serialSequence(table: string, column: string): string | null {
    const relOid = this.session.resolveRelation(table);
    if (relOid === null) {
      return null;
    }
    const cat = this.session.catalog();
    const rel = cat.getRelation(relOid)!;
    const col = rel.columns.find((c) => !c.isDropped && c.name === column);
    if (!col) {
      return null;
    }
    for (const s of cat.relations.values()) {
      if (s.kind === 'S' && s.sequence?.ownedBy?.relOid === relOid && s.sequence.ownedBy.attnum === col.attnum) {
        return `${quoteIdentifier(cat.namespaceName(s.nspOid))}.${quoteIdentifier(s.name)}`;
      }
    }
    return null;
  }

  functionDef(procOid: number): string | null {
    const p = this.session.catalog().getProc(procOid);
    if (!p || p.isBuiltin) {
      return null;
    }
    return `CREATE OR REPLACE FUNCTION ${p.name}()\n LANGUAGE ${p.lang}\nAS $function$${p.body ?? ''}$function$\n`;
  }
}
