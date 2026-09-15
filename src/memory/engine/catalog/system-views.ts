import { quoteIdentifier, TypeUtil } from '../analyze/typeutil';
import { StatementState } from '../exec/runtime';
import type { Session } from '../session';
import { EPOCH_DIFF_US } from '../types/datetime';
import { PgNumeric } from '../types/numeric';
import { withLowerBound } from '../types/values';
import { Catalog, Column, NS_PG_CATALOG, PgType, Relation, TypeOid } from './catalog';
import { CatalogFunctionsImpl } from './deparse';

type Row = Record<string, unknown>;

const CLASS_OID = { pg_class: 1259, pg_type: 1247, pg_proc: 1255, pg_namespace: 2615, pg_constraint: 2606 };

function allRelations(cat: Catalog): Relation[] {
  return [...cat.builtin.relations.values(), ...cat.relations.values()];
}

function allTypes(cat: Catalog): PgType[] {
  return [...cat.builtin.types.values(), ...cat.types.values()];
}

function allNamespaces(cat: Catalog) {
  // the user catalog re-declares "public"; each namespace appears once
  return [...[...cat.builtin.namespaces.values()].filter((ns) => !cat.namespaces.has(ns.oid)), ...cat.namespaces.values()];
}

function liveCols(rel: Relation): Column[] {
  return rel.columns.filter((c) => !c.isDropped);
}

function yesNo(b: boolean): string {
  return b ? 'YES' : 'NO';
}

function relkindChar(rel: Relation): string {
  return rel.kind;
}

function typeLen(t: PgType | undefined): number {
  return t ? t.len : -1;
}

function charMaxLength(typeOid: number, typmod: number): number | null {
  if ((typeOid === TypeOid.varchar || typeOid === TypeOid.bpchar) && typmod >= 4) {
    return typmod - 4;
  }
  if ((typeOid === TypeOid.bit || typeOid === TypeOid.varbit) && typmod > 0) {
    return typmod;
  }
  return null;
}

function numericPrecision(typeOid: number, typmod: number): number | null {
  switch (typeOid) {
    case TypeOid.int2:
      return 16;
    case TypeOid.int4:
      return 32;
    case TypeOid.int8:
      return 64;
    case TypeOid.float4:
      return 24;
    case TypeOid.float8:
      return 53;
    case TypeOid.numeric:
      return typmod >= 4 ? ((typmod - 4) >> 16) & 0xffff : null;
  }
  return null;
}

function numericScale(typeOid: number, typmod: number): number | null {
  switch (typeOid) {
    case TypeOid.int2:
    case TypeOid.int4:
    case TypeOid.int8:
      return 0;
    case TypeOid.numeric:
      return typmod >= 4 ? (typmod - 4) & 0x7ff : null;
  }
  return null;
}

function dataTypeName(types: TypeUtil, cat: Catalog, typeOid: number): string {
  const t = cat.getType(typeOid);
  if (!t) {
    return 'unknown';
  }
  if (t.isArray) {
    return 'ARRAY';
  }
  if (t.typtype === 'e' || t.typtype === 'c' || (t.nspOid !== NS_PG_CATALOG && t.typtype !== 'd')) {
    return 'USER-DEFINED';
  }
  if (t.typtype === 'd') {
    return dataTypeName(types, cat, t.baseType);
  }
  return types.formatType(typeOid, -1, false, false, [NS_PG_CATALOG]);
}

/** system catalogs whose rows are a function of the catalog alone (no session or storage state) */
const CATALOG_ONLY_RELATIONS = new Set(['pg_catalog.pg_type', 'pg_catalog.pg_namespace']);
const catalogOnlyRows = new WeakMap<Catalog, Map<number, { version: number; rows: unknown[][] }>>();

export function catalogRelationRows(session: Session, relOid: number, st: StatementState): unknown[][] {
  const cat = st.catalog;
  const rel = cat.getRelation(relOid);
  if (!rel) {
    return [];
  }
  const nsName = cat.namespaceName(rel.nspOid);
  const qualified = `${nsName}.${rel.name}`;
  const gen = GENERATORS[qualified];
  if (!gen) {
    return [];
  }
  if (!CATALOG_ONLY_RELATIONS.has(qualified)) {
    return generateCatalogRows(session, cat, rel, gen);
  }
  // e.g. the type query every postgres.js connection starts with: rebuilt only when the catalog changes
  let perCatalog = catalogOnlyRows.get(cat);
  if (!perCatalog) {
    perCatalog = new Map();
    catalogOnlyRows.set(cat, perCatalog);
  }
  const cached = perCatalog.get(relOid);
  if (cached && cached.version === cat.version) {
    return cached.rows;
  }
  const rows = generateCatalogRows(session, cat, rel, gen);
  perCatalog.set(relOid, { version: cat.version, rows });
  return rows;
}

function generateCatalogRows(session: Session, cat: Catalog, rel: Relation, gen: (session: Session, cat: Catalog) => Row[]): unknown[][] {
  const cols = rel.columns;
  // int2vector / oidvector values are zero-based arrays
  const zeroBased = cols.map((c) => c.typeOid === TypeOid.int2vector || c.typeOid === TypeOid.oidvector);
  return gen(session, cat).map((r) =>
    cols.map((c, i) => {
      const v = r[c.name];
      if (v === undefined || v === null) {
        return null;
      }
      return zeroBased[i] && Array.isArray(v) ? withLowerBound(v.slice(), 0) : v;
    })
  );
}

const GENERATORS: Record<string, (session: Session, cat: Catalog) => Row[]> = {
  'pg_catalog.pg_namespace': (_s, cat) => allNamespaces(cat).map((ns) => ({ oid: ns.oid, nspname: ns.name, nspowner: 10 })),
  'pg_catalog.pg_class': (session, cat) =>
    allRelations(cat).map((r) => ({
      oid: r.oid,
      relname: r.name,
      relnamespace: r.nspOid,
      reltype: r.rowTypeOid,
      reloftype: 0,
      relowner: 10,
      relam: r.index ? amOid(cat, r.index.method) : r.kind === 'r' || r.kind === 'm' ? 2 : 0,
      relfilenode: r.storageId || r.oid,
      reltablespace: 0,
      relpages: 0,
      reltuples: r.storageId ? session.relationRowCount(r.oid) : -1,
      relallvisible: 0,
      relallfrozen: 0,
      reltoastrelid: 0,
      relhasindex: cat.indexesOf(r.oid).length > 0,
      relisshared: false,
      relpersistence: r.persistence,
      relkind: relkindChar(r),
      relnatts: liveCols(r).length,
      relchecks: cat.constraintsOf(r.oid).filter((c) => c.type === 'c').length,
      relhasrules: false,
      relhastriggers: r.hasTriggers,
      relhassubclass: allRelations(cat).some((x) => x.parentOid === r.oid || x.inheritsFrom.includes(r.oid)),
      relrowsecurity: false,
      relforcerowsecurity: false,
      relispopulated: r.populated,
      relreplident: 'd',
      relispartition: !!r.parentOid,
      relrewrite: 0,
      relfrozenxid: 0,
      relminmxid: 0,
      relacl: null,
      reloptions: r.options.length ? r.options : null,
      relpartbound: r.partitionBound ? JSON.stringify(r.partitionBound) : null,
    })),
  'pg_catalog.pg_attribute': (_s, cat) => {
    const out: Row[] = [];
    for (const r of cat.relations.values()) {
      for (const c of r.columns) {
        out.push({
          attrelid: r.oid,
          attname: c.name,
          atttypid: c.typeOid,
          attlen: typeLen(cat.getType(c.typeOid)),
          attnum: c.attnum,
          atttypmod: c.typmod,
          attndims: c.ndims,
          attbyval: cat.getType(c.typeOid)?.byval ?? false,
          attalign: cat.getType(c.typeOid)?.align ?? 'i',
          attstorage: cat.getType(c.typeOid)?.storage ?? 'p',
          attcompression: '',
          attnotnull: c.notNull,
          atthasdef: !!c.defaultExpr,
          atthasmissing: c.hasMissing,
          attidentity: c.identity,
          attgenerated: c.generated,
          attisdropped: c.isDropped,
          attislocal: c.isLocal,
          attinhcount: c.inhCount,
          attcollation: c.collation,
          attstattarget: c.statsTarget < 0 ? null : c.statsTarget,
          attacl: null,
          attoptions: null,
          attfdwoptions: null,
          attmissingval: null,
        });
      }
      // system columns
      const sys: [string, number, number][] = [
        ['tableoid', TypeOid.oid, -6],
        ['cmax', TypeOid.cid, -5],
        ['xmax', TypeOid.xid, -4],
        ['cmin', TypeOid.cid, -3],
        ['xmin', TypeOid.xid, -2],
        ['ctid', TypeOid.tid, -1],
      ];
      if (r.kind === 'r' || r.kind === 'p' || r.kind === 'm') {
        for (const [name, type, num] of sys) {
          out.push({ attrelid: r.oid, attname: name, atttypid: type, attnum: num, atttypmod: -1, attnotnull: true, atthasdef: false, attidentity: '', attgenerated: '', attisdropped: false, attislocal: true, attinhcount: 0, attcollation: 0, attlen: 4, attbyval: true, attalign: 'i', attstorage: 'p', attndims: 0 });
        }
      }
    }
    for (const r of cat.builtin.relations.values()) {
      for (const c of r.columns) {
        out.push({ attrelid: r.oid, attname: c.name, atttypid: c.typeOid, attnum: c.attnum, atttypmod: c.typmod, attnotnull: c.notNull, atthasdef: false, attisdropped: false, attidentity: '', attgenerated: '', attislocal: true, attinhcount: 0, attcollation: c.collation, attndims: 0 });
      }
    }
    return out;
  },
  'pg_catalog.pg_type': (_s, cat) =>
    allTypes(cat).map((t) => ({
      oid: t.oid,
      typname: t.name,
      typnamespace: t.nspOid,
      typowner: 10,
      typlen: t.len,
      typbyval: t.byval,
      typtype: t.typtype,
      typcategory: t.category,
      typispreferred: t.preferred,
      typisdefined: true,
      typdelim: t.delim,
      typrelid: t.relid,
      typsubscript: t.isArray ? 6179 : 0,
      typelem: t.elem,
      typarray: t.array,
      typinput: 0,
      typoutput: 0,
      typreceive: 0,
      typsend: 0,
      typmodin: 0,
      typmodout: 0,
      typanalyze: 0,
      typalign: t.align,
      typstorage: t.storage,
      typnotnull: !!t.domainNotNull,
      typbasetype: t.baseType,
      typtypmod: t.typmod,
      typndims: 0,
      typcollation: t.collation,
      typdefaultbin: null,
      typdefault: null,
      typacl: null,
    })),
  'pg_catalog.pg_enum': (_s, cat) => {
    const out: Row[] = [];
    for (const t of cat.types.values()) {
      if (t.typtype === 'e') {
        for (const l of t.enumLabels ?? []) {
          out.push({ oid: l.oid, enumtypid: t.oid, enumsortorder: l.sortOrder, enumlabel: l.label });
        }
      }
    }
    return out;
  },
  'pg_catalog.pg_index': (_s, cat) => {
    const out: Row[] = [];
    for (const r of cat.relations.values()) {
      if (!r.index) {
        continue;
      }
      const ix = r.index;
      out.push({
        indexrelid: r.oid,
        indrelid: ix.tableOid,
        indnatts: ix.keys.length + ix.include.length,
        indnkeyatts: ix.keys.length,
        indisunique: ix.unique,
        indnullsnotdistinct: ix.nullsNotDistinct,
        indisprimary: ix.primary,
        indisexclusion: ix.exclusion,
        indimmediate: ix.immediate,
        indisclustered: false,
        indisvalid: ix.valid,
        indcheckxmin: false,
        indisready: true,
        indislive: true,
        indisreplident: false,
        indkey: [...ix.keys.map((k) => k.attnum), ...ix.include],
        indcollation: ix.keys.map((k) => k.collation),
        indclass: ix.keys.map((k) => k.opclassOid),
        indoption: ix.keys.map((k) => (k.desc ? 1 : 0) | (k.nullsFirst ? 2 : 0)),
        indexprs: ix.keys.some((k) => k.attnum === 0) ? `__indexprs:${r.oid}` : null,
        indpred: ix.predicate ? `__indpred:${r.oid}` : null,
      });
    }
    return out;
  },
  'pg_catalog.pg_indexes': (session, cat) => {
    const fns = new CatalogFunctionsImpl(session);
    const out: Row[] = [];
    for (const r of cat.relations.values()) {
      if (!r.index) {
        continue;
      }
      const table = cat.getRelation(r.index.tableOid);
      if (!table || (table.kind !== 'r' && table.kind !== 'm' && table.kind !== 'p')) {
        continue;
      }
      out.push({ schemaname: cat.namespaceName(table.nspOid), tablename: table.name, indexname: r.name, tablespace: null, indexdef: fns.indexDef(r.oid, 0, false) });
    }
    return out;
  },
  'pg_catalog.pg_constraint': (_s, cat) =>
    [...cat.constraints.values()].map((c) => ({
      oid: c.oid,
      conname: c.name,
      connamespace: c.nspOid,
      contype: c.type,
      condeferrable: c.deferrable,
      condeferred: c.initiallyDeferred,
      conenforced: true,
      convalidated: c.validated,
      conrelid: c.relOid,
      contypid: c.typeOid,
      conindid: c.indexOid,
      conparentid: 0,
      confrelid: c.fk?.refRelOid ?? 0,
      confupdtype: c.fk ? fkActionChar(c.fk.onUpdate) : ' ',
      confdeltype: c.fk ? fkActionChar(c.fk.onDelete) : ' ',
      confmatchtype: c.fk ? (c.fk.matchType === 'FULL' ? 'f' : c.fk.matchType === 'PARTIAL' ? 'p' : 's') : ' ',
      conislocal: c.isLocal,
      coninhcount: c.inhCount,
      connoinherit: c.noInherit,
      conperiod: false,
      conkey: c.columns.length ? c.columns : null,
      confkey: c.fk ? c.fk.refColumns : null,
      conpfeqop: null,
      conppeqop: null,
      conffeqop: null,
      confdelsetcols: null,
      conexclop: null,
      conbin: c.type === 'c' ? `__check:${c.oid}` : null,
    })),
  'pg_catalog.pg_proc': (_s, cat) =>
    [...cat.builtin.procs.values(), ...cat.procs.values()].map((p) => ({
      oid: p.oid,
      proname: p.name,
      pronamespace: p.nspOid,
      proowner: 10,
      prolang: p.lang === 'sql' ? 14 : p.lang === 'plpgsql' ? 13601 : 12,
      procost: 1,
      prorows: p.retset ? 1000 : 0,
      provariadic: p.variadic,
      prosupport: 0,
      prokind: p.kind,
      prosecdef: !!p.securityDefiner,
      proleakproof: false,
      proisstrict: p.strict,
      proretset: p.retset,
      provolatile: p.volatile,
      proparallel: p.parallel ? p.parallel[0] : 'u',
      pronargs: p.argtypes.length,
      pronargdefaults: p.nargdefaults,
      prorettype: p.rettype,
      proargtypes: p.argtypes,
      proallargtypes: p.allargtypes ?? null,
      proargmodes: p.argmodes ?? null,
      proargnames: p.argnames ?? null,
      proargdefaults: null,
      protrftypes: null,
      prosrc: p.isBuiltin ? p.src : p.body ?? '',
      probin: null,
      prosqlbody: null,
      proconfig: null,
      proacl: null,
    })),
  'pg_catalog.pg_extension': (_s, cat) => [...cat.extensions.values()].map((e) => ({ oid: e.oid, extname: e.name, extowner: 10, extnamespace: e.nspOid, extrelocatable: false, extversion: e.version, extconfig: null, extcondition: null })),
  'pg_catalog.pg_database': (session) => [
    { oid: 16384, datname: session.databaseName, datdba: 10, encoding: 6, datlocprovider: 'c', datistemplate: false, datallowconn: true, dathasloginevt: false, datconnlimit: -1, datfrozenxid: 0, datminmxid: 1, dattablespace: 1663, datcollate: session.db.options.collation, datctype: session.db.options.collation, datlocale: null, daticurules: null, datcollversion: null, datacl: null },
  ],
  'pg_catalog.pg_db_role_setting': (_s, cat) => (cat.dbSettings.size ? [{ setdatabase: 16384, setrole: 0, setconfig: [...cat.dbSettings.entries()].map(([k, v]) => `${k}=${v}`) }] : []),
  'pg_catalog.pg_collation': (_s, cat) =>
    [...cat.builtin.collations.values(), ...cat.collations.values()].map((c) => ({
      oid: c.oid,
      collname: c.name,
      collnamespace: c.nspOid,
      collowner: 10,
      collprovider: c.provider,
      collisdeterministic: c.deterministic,
      collencoding: c.encoding,
      collcollate: c.provider === 'c' ? c.locale ?? 'C' : null,
      collctype: c.provider === 'c' ? c.locale ?? 'C' : null,
      colllocale: c.provider === 'i' ? c.locale ?? '' : null,
      collicurules: null,
      collversion: null,
    })),
  'pg_catalog.pg_statistic_ext': (_s, cat) =>
    [...cat.statistics.values()].map((s) => ({
      oid: s.oid,
      stxrelid: s.relOid,
      stxname: s.name,
      stxnamespace: s.nspOid,
      stxowner: 10,
      stxkeys: s.columns,
      stxstattarget: s.statsTarget < 0 ? null : s.statsTarget,
      stxkind: s.kinds.map((k) => (k === 'ndistinct' ? 'd' : k === 'dependencies' ? 'f' : k === 'mcv' ? 'm' : 'e')),
      stxexprs: s.exprs.length ? s.exprs.map((e) => e.text).join(' ') : null,
    })),
  'pg_catalog.pg_tables': (_s, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.kind === 'r' || r.kind === 'p')
      .map((r) => ({ schemaname: cat.namespaceName(r.nspOid), tablename: r.name, tableowner: 'postgres', tablespace: null, hasindexes: cat.indexesOf(r.oid).length > 0, hasrules: false, hastriggers: r.hasTriggers, rowsecurity: false })),
  'pg_catalog.pg_views': (_s, cat) => [...cat.relations.values()].filter((r) => r.kind === 'v').map((r) => ({ schemaname: cat.namespaceName(r.nspOid), viewname: r.name, viewowner: 'postgres', definition: r.view?.text ?? '' })),
  'pg_catalog.pg_matviews': (_s, cat) => [...cat.relations.values()].filter((r) => r.kind === 'm').map((r) => ({ schemaname: cat.namespaceName(r.nspOid), matviewname: r.name, matviewowner: 'postgres', tablespace: null, hasindexes: cat.indexesOf(r.oid).length > 0, ispopulated: r.populated, definition: r.view?.text ?? '' })),
  'pg_catalog.pg_sequence': (_s, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.kind === 'S' && r.sequence)
      .map((r) => ({ seqrelid: r.oid, seqtypid: r.sequence!.typeOid, seqstart: r.sequence!.start, seqincrement: r.sequence!.increment, seqmax: r.sequence!.max, seqmin: r.sequence!.min, seqcache: r.sequence!.cache, seqcycle: r.sequence!.cycle })),
  'pg_catalog.pg_sequences': (_s, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.kind === 'S' && r.sequence)
      .map((r) => {
        const s = r.sequence!;
        return { schemaname: cat.namespaceName(r.nspOid), sequencename: r.name, sequenceowner: 'postgres', data_type: s.typeOid, start_value: s.start, min_value: s.min, max_value: s.max, increment_by: s.increment, cycle: s.cycle, cache_size: s.cache, last_value: s.state.isCalled ? s.state.lastValue : null };
      }),
  'pg_catalog.pg_attrdef': (_s, cat) => {
    const out: Row[] = [];
    for (const r of cat.relations.values()) {
      for (const c of r.columns) {
        if (c.defaultExpr && !c.isDropped) {
          out.push({ oid: r.oid * 1000 + c.attnum, adrelid: r.oid, adnum: c.attnum, adbin: `__default:${r.oid}:${c.attnum}` });
        }
      }
    }
    return out;
  },
  'pg_catalog.pg_description': (_s, cat) => {
    const out: Row[] = [];
    for (const [k, v] of cat.comments) {
      const m = /^(\d+):(\d+):(\d+)$/.exec(k);
      if (m) {
        out.push({ objoid: Number(m[2]), classoid: Number(m[1]), objsubid: Number(m[3]), description: v });
      }
    }
    return out;
  },
  'pg_catalog.pg_settings': (session) =>
    ['TimeZone', 'DateStyle', 'search_path', 'statement_timeout', 'extra_float_digits', 'application_name', 'client_encoding', 'server_version', 'server_version_num', 'IntervalStyle', 'standard_conforming_strings', 'max_identifier_length', 'lock_timeout', 'work_mem'].map((name) => ({
      name,
      setting: session.getSetting(name, true),
      unit: null,
      category: '',
      short_desc: '',
      extra_desc: null,
      context: 'user',
      vartype: 'string',
      source: 'default',
    })),
  'pg_catalog.pg_am': (_s, cat) => [...cat.builtin.ams.values()].map((a) => ({ oid: a.oid, amname: a.name, amhandler: 0, amtype: a.type })),
  'pg_catalog.pg_opclass': (_s, cat) => [...cat.builtin.opclasses.values()].map((o) => ({ oid: o.oid, opcmethod: amOid(cat, o.am), opcname: o.name, opcnamespace: o.nspOid, opcowner: 10, opcfamily: o.family, opcintype: o.inputType, opcdefault: o.isDefault, opckeytype: o.keyType })),
  'pg_catalog.pg_inherits': (_s, cat) => {
    const out: Row[] = [];
    for (const r of cat.relations.values()) {
      if (r.parentOid) {
        out.push({ inhrelid: r.oid, inhparent: r.parentOid, inhseqno: 1, inhdetachpending: false });
      }
      r.inheritsFrom.forEach((p, i) => out.push({ inhrelid: r.oid, inhparent: p, inhseqno: i + 1, inhdetachpending: false }));
    }
    return out;
  },
  'pg_catalog.pg_partitioned_table': (_s, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.partitionKey)
      .map((r) => ({ partrelid: r.oid, partstrat: r.partitionKey!.strategy, partnatts: r.partitionKey!.keys.length, partdefid: 0, partattrs: r.partitionKey!.keys.map((k) => k.attnum), partclass: r.partitionKey!.keys.map((k) => k.opclassOid), partcollation: r.partitionKey!.keys.map((k) => k.collation), partexprs: null })),
  'pg_catalog.pg_trigger': (_s, cat) =>
    [...cat.triggers.values()].map((t) => ({ oid: t.oid, tgrelid: t.relOid, tgparentid: 0, tgname: t.name, tgfoid: t.funcOid, tgtype: 0, tgenabled: t.enabled ? 'O' : 'D', tgisinternal: false, tgconstrrelid: 0, tgconstrindid: 0, tgconstraint: 0, tgdeferrable: false, tginitdeferred: false, tgnargs: t.args.length, tgattr: [], tgargs: null, tgqual: null, tgoldtable: null, tgnewtable: null })),
  'pg_catalog.pg_roles': () => [{ rolname: 'postgres', rolsuper: true, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolconnlimit: -1, rolpassword: '********', rolvaliduntil: null, rolbypassrls: true, rolconfig: null, oid: 10 }],
  'pg_catalog.pg_user': () => [{ usename: 'postgres', usesysid: 10, usecreatedb: true, usesuper: true, userepl: true, usebypassrls: true, passwd: '********', valuntil: null, useconfig: null }],
  'pg_catalog.pg_authid': () => [{ oid: 10, rolname: 'postgres', rolsuper: true, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolbypassrls: true, rolconnlimit: -1 }],
  'pg_catalog.pg_stat_activity': (session) =>
    [...session.db.sessions].map((s) => {
      const running = s.isStatementRunning || s === session;
      const explicit = !!s.txn && s.txn.explicit;
      return {
        datid: 16384,
        datname: session.databaseName,
        pid: s.backendPid,
        usesysid: 10,
        usename: s.userName,
        application_name: s.getSetting('application_name', true) ?? '',
        client_addr: '127.0.0.1',
        client_port: 5432,
        backend_start: s.activityBackendStart * 1000 - EPOCH_DIFF_US,
        xact_start: s.txn ? s.txn.startTs : null,
        query_start: s.activityQueryStart || null,
        state_change: s.activityStateChange || null,
        // a statement blocked on another transaction's row / advisory lock waits on its transactionid
        wait_event_type: s.waitingFor ? 'Lock' : running ? null : 'Client',
        wait_event: s.waitingFor ? 'transactionid' : running ? null : 'ClientRead',
        state: running ? 'active' : explicit ? (s.txn!.failed ? 'idle in transaction (aborted)' : 'idle in transaction') : 'idle',
        backend_xid: s.txn && s.txn.topXid ? s.txn.topXid : null,
        query: s.activityQuery,
        backend_type: 'client backend',
      };
    }),
  'pg_catalog.pg_locks': (session) => {
    const rows: Record<string, unknown>[] = [];
    for (const s of session.db.sessions) {
      if (s.txn && s.txn.topXid) {
        rows.push({ locktype: 'transactionid', transactionid: s.txn.topXid, virtualtransaction: `${s.backendPid}/${s.txn.topXid}`, pid: s.backendPid, mode: 'ExclusiveLock', granted: true, fastpath: false });
      }
      if (s.waitingFor) {
        rows.push({ locktype: 'transactionid', transactionid: s.waitingFor, virtualtransaction: `${s.backendPid}/0`, pid: s.backendPid, mode: 'ShareLock', granted: false, fastpath: false });
      }
    }
    for (const [key, lock] of session.db.advisoryLocks) {
      const [hi, lo] = key.split(':');
      rows.push({ locktype: 'advisory', database: 16384, classid: Number(hi ?? 0) >>> 0, objid: Number(lo ?? key) >>> 0, objsubid: 1, virtualtransaction: `${lock.pid}/0`, pid: lock.pid, mode: 'ExclusiveLock', granted: true, fastpath: false });
    }
    return rows;
  },
  'pg_catalog.pg_prepared_statements': (session) =>
    [...session.preparedStatements.entries()].map(([name, p]) => ({
      name,
      statement: p.text,
      prepare_time: p.prepareTime,
      parameter_types: p.argTypes,
      result_types: p.resultTypes.length ? p.resultTypes : null,
      from_sql: p.fromSql,
      generic_plans: BigInt(0),
      custom_plans: BigInt(0),
    })),
  'pg_catalog.pg_language': () => [
    { oid: 12, lanname: 'internal', lanowner: 10, lanispl: false, lanpltrusted: false },
    { oid: 13, lanname: 'c', lanowner: 10, lanispl: false, lanpltrusted: false },
    { oid: 14, lanname: 'sql', lanowner: 10, lanispl: false, lanpltrusted: true },
    { oid: 13601, lanname: 'plpgsql', lanowner: 10, lanispl: true, lanpltrusted: true },
  ],
  'pg_catalog.pg_tablespace': () => [
    { oid: 1663, spcname: 'pg_default', spcowner: 10 },
    { oid: 1664, spcname: 'pg_global', spcowner: 10 },
  ],
  'pg_catalog.pg_operator': (_s, cat) => [...cat.builtin.operators.values(), ...cat.operators.values()].map((o) => ({ oid: o.oid, oprname: o.name, oprnamespace: o.nspOid, oprowner: 10, oprkind: o.kind, oprcanmerge: false, oprcanhash: false, oprleft: o.left, oprright: o.right, oprresult: o.result, oprcom: o.commutator, oprnegate: o.negator, oprcode: o.codeOid, oprrest: 0, oprjoin: 0 })),
  'pg_catalog.pg_cast': (_s, cat) => [...cat.builtin.casts.values()].map((c, i) => ({ oid: 10000 + i, castsource: c.source, casttarget: c.target, castfunc: c.funcOid, castcontext: c.context, castmethod: c.method })),
  'pg_catalog.pg_depend': () => [],
  'pg_catalog.pg_shdepend': () => [],
  'pg_catalog.pg_rewrite': () => [],
  'pg_catalog.pg_policy': () => [],
  'pg_catalog.pg_publication': () => [],
  'pg_catalog.pg_timezone_names': () => [],

  // ---------------------------------------------------------------------------
  // information_schema
  // ---------------------------------------------------------------------------

  'information_schema.schemata': (session, cat) => allNamespaces(cat).map((ns) => ({ catalog_name: session.databaseName, schema_name: ns.name, schema_owner: 'postgres', default_character_set_catalog: null, default_character_set_schema: null, default_character_set_name: null, sql_path: null })),
  'information_schema.tables': (session, cat) =>
    allRelations(cat)
      .filter((r) => r.kind === 'r' || r.kind === 'p' || r.kind === 'v' || r.kind === 'f')
      .map((r) => ({
        table_catalog: session.databaseName,
        table_schema: cat.namespaceName(r.nspOid),
        table_name: r.name,
        table_type: r.persistence === 't' ? 'LOCAL TEMPORARY' : r.kind === 'v' ? 'VIEW' : r.kind === 'f' ? 'FOREIGN' : 'BASE TABLE',
        self_referencing_column_name: null,
        reference_generation: null,
        user_defined_type_catalog: null,
        user_defined_type_schema: null,
        user_defined_type_name: null,
        is_insertable_into: r.kind === 'v' ? 'NO' : 'YES',
        is_typed: 'NO',
        commit_action: r.persistence === 't' ? 'PRESERVE' : null,
      })),
  'information_schema.views': (session, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.kind === 'v')
      .map((r) => ({ table_catalog: session.databaseName, table_schema: cat.namespaceName(r.nspOid), table_name: r.name, view_definition: r.view?.text ?? null, check_option: 'NONE', is_updatable: 'NO', is_insertable_into: 'NO', is_trigger_updatable: 'NO', is_trigger_deletable: 'NO', is_trigger_insertable_into: 'NO' })),
  'information_schema.columns': (session, cat) => {
    const types = new TypeUtil(cat);
    const fns = new CatalogFunctionsImpl(session);
    const out: Row[] = [];
    for (const r of allRelations(cat)) {
      if (r.kind !== 'r' && r.kind !== 'p' && r.kind !== 'v' && r.kind !== 'f' && r.kind !== 'm') {
        continue;
      }
      if (r.kind === 'm') {
        continue;
      }
      let pos = 0;
      for (const c of r.columns) {
        if (c.isDropped) {
          continue;
        }
        pos++;
        const t = cat.getType(c.typeOid);
        const base = t && t.typtype === 'd' ? cat.getType(t.baseType) : t;
        const coll = c.collation && c.collation !== 100 ? cat.getCollation(c.collation) : undefined;
        out.push({
          table_catalog: session.databaseName,
          table_schema: cat.namespaceName(r.nspOid),
          table_name: r.name,
          column_name: c.name,
          ordinal_position: pos,
          column_default: r.isBuiltinCatalog ? null : c.generated ? null : c.defaultExpr ? fns.defaultText(r.oid, c.attnum, false) : null,
          is_nullable: yesNo(!c.notNull && !(t?.domainNotNull)),
          data_type: dataTypeName(types, cat, c.typeOid),
          character_maximum_length: charMaxLength(base?.oid ?? c.typeOid, c.typmod),
          character_octet_length: base && (base.category === 'S') ? (charMaxLength(base.oid, c.typmod) ?? 0) * 4 || 1073741824 : null,
          numeric_precision: numericPrecision(base?.oid ?? c.typeOid, c.typmod),
          numeric_precision_radix: numericPrecision(base?.oid ?? c.typeOid, c.typmod) !== null ? (base?.oid === TypeOid.numeric ? 10 : 2) : null,
          numeric_scale: numericScale(base?.oid ?? c.typeOid, c.typmod),
          datetime_precision: ([TypeOid.date, TypeOid.time, TypeOid.timetz, TypeOid.timestamp, TypeOid.timestamptz, TypeOid.interval] as number[]).includes(base?.oid ?? 0) ? (base?.oid === TypeOid.date ? 0 : c.typmod >= 0 ? c.typmod : 6) : null,
          interval_type: null,
          interval_precision: null,
          character_set_catalog: null,
          character_set_schema: null,
          character_set_name: null,
          collation_catalog: coll ? session.databaseName : null,
          collation_schema: coll ? cat.namespaceName(coll.nspOid) : null,
          collation_name: coll ? coll.name : null,
          domain_catalog: t && t.typtype === 'd' ? session.databaseName : null,
          domain_schema: t && t.typtype === 'd' ? cat.namespaceName(t.nspOid) : null,
          domain_name: t && t.typtype === 'd' ? t.name : null,
          udt_catalog: session.databaseName,
          udt_schema: base ? cat.namespaceName(base.nspOid) : 'pg_catalog',
          udt_name: base?.name ?? null,
          scope_catalog: null,
          scope_schema: null,
          scope_name: null,
          maximum_cardinality: null,
          dtd_identifier: String(pos),
          is_self_referencing: 'NO',
          is_identity: yesNo(!!c.identity),
          identity_generation: c.identity === 'a' ? 'ALWAYS' : c.identity === 'd' ? 'BY DEFAULT' : null,
          identity_start: identityProp(cat, c, 'start'),
          identity_increment: identityProp(cat, c, 'increment'),
          identity_maximum: identityProp(cat, c, 'max'),
          identity_minimum: identityProp(cat, c, 'min'),
          identity_cycle: c.identity ? yesNo(!!cat.getRelation(c.identitySeqOid ?? 0)?.sequence?.cycle) : 'NO',
          is_generated: c.generated ? 'ALWAYS' : 'NEVER',
          generation_expression: c.generated && c.defaultExpr ? fns.defaultText(r.oid, c.attnum, false) : null,
          is_updatable: r.kind === 'v' ? 'NO' : 'YES',
        });
      }
    }
    return out;
  },
  'information_schema.sequences': (session, cat) =>
    [...cat.relations.values()]
      .filter((r) => r.kind === 'S' && r.sequence)
      .map((r) => {
        const s = r.sequence!;
        return {
          sequence_catalog: session.databaseName,
          sequence_schema: cat.namespaceName(r.nspOid),
          sequence_name: r.name,
          data_type: s.typeOid === TypeOid.int2 ? 'smallint' : s.typeOid === TypeOid.int4 ? 'integer' : 'bigint',
          numeric_precision: s.typeOid === TypeOid.int2 ? 16 : s.typeOid === TypeOid.int4 ? 32 : 64,
          numeric_precision_radix: 2,
          numeric_scale: 0,
          start_value: String(s.start),
          minimum_value: String(s.min),
          maximum_value: String(s.max),
          increment: String(s.increment),
          cycle_option: yesNo(s.cycle),
        };
      }),
  'information_schema.table_constraints': (session, cat) => {
    const out: Row[] = [];
    for (const c of cat.constraints.values()) {
      const r = cat.getRelation(c.relOid);
      if (!r) {
        continue;
      }
      const typeName = c.type === 'p' ? 'PRIMARY KEY' : c.type === 'u' ? 'UNIQUE' : c.type === 'f' ? 'FOREIGN KEY' : c.type === 'c' || c.type === 'n' ? 'CHECK' : null;
      if (!typeName) {
        continue;
      }
      out.push({
        constraint_catalog: session.databaseName,
        constraint_schema: cat.namespaceName(c.nspOid),
        constraint_name: c.name,
        table_catalog: session.databaseName,
        table_schema: cat.namespaceName(r.nspOid),
        table_name: r.name,
        constraint_type: typeName,
        is_deferrable: yesNo(c.deferrable),
        initially_deferred: yesNo(c.initiallyDeferred),
        enforced: 'YES',
        nulls_distinct: c.type === 'u' ? yesNo(!cat.getRelation(c.indexOid)?.index?.nullsNotDistinct) : null,
      });
    }
    return out;
  },
  'information_schema.key_column_usage': (session, cat) => {
    const out: Row[] = [];
    for (const c of cat.constraints.values()) {
      if (c.type !== 'p' && c.type !== 'u' && c.type !== 'f') {
        continue;
      }
      const r = cat.getRelation(c.relOid);
      if (!r) {
        continue;
      }
      c.columns.forEach((a, i) => {
        out.push({
          constraint_catalog: session.databaseName,
          constraint_schema: cat.namespaceName(c.nspOid),
          constraint_name: c.name,
          table_catalog: session.databaseName,
          table_schema: cat.namespaceName(r.nspOid),
          table_name: r.name,
          column_name: r.columns[a - 1].name,
          ordinal_position: i + 1,
          position_in_unique_constraint: c.type === 'f' ? i + 1 : null,
        });
      });
    }
    return out;
  },
  'information_schema.constraint_column_usage': (session, cat) => {
    const out: Row[] = [];
    for (const c of cat.constraints.values()) {
      if (c.type === 'n') {
        continue;
      }
      const targetRel = c.type === 'f' ? cat.getRelation(c.fk!.refRelOid) : cat.getRelation(c.relOid);
      if (!targetRel) {
        continue;
      }
      const cols = c.type === 'f' ? c.fk!.refColumns : c.columns;
      const sorted = [...cols].sort((a, b) => a - b);
      for (const a of sorted) {
        out.push({
          table_catalog: session.databaseName,
          table_schema: cat.namespaceName(targetRel.nspOid),
          table_name: targetRel.name,
          column_name: targetRel.columns[a - 1].name,
          constraint_catalog: session.databaseName,
          constraint_schema: cat.namespaceName(c.nspOid),
          constraint_name: c.name,
        });
      }
    }
    return out;
  },
  'information_schema.referential_constraints': (session, cat) => {
    const out: Row[] = [];
    for (const c of cat.constraints.values()) {
      if (c.type !== 'f') {
        continue;
      }
      const uniq = [...cat.constraints.values()].find((u) => u.indexOid === c.indexOid && (u.type === 'p' || u.type === 'u'));
      out.push({
        constraint_catalog: session.databaseName,
        constraint_schema: cat.namespaceName(c.nspOid),
        constraint_name: c.name,
        unique_constraint_catalog: session.databaseName,
        unique_constraint_schema: uniq ? cat.namespaceName(uniq.nspOid) : null,
        unique_constraint_name: uniq?.name ?? null,
        match_option: c.fk!.matchType === 'FULL' ? 'FULL' : c.fk!.matchType === 'PARTIAL' ? 'PARTIAL' : 'NONE',
        update_rule: c.fk!.onUpdate,
        delete_rule: c.fk!.onDelete,
      });
    }
    return out;
  },
  'information_schema.check_constraints': (session, cat) => {
    const fns = new CatalogFunctionsImpl(session);
    const out: Row[] = [];
    for (const c of cat.constraints.values()) {
      if (c.type === 'c') {
        out.push({ constraint_catalog: session.databaseName, constraint_schema: cat.namespaceName(c.nspOid), constraint_name: c.name, check_clause: fns.constraintDef(c.oid, false)?.replace(/^CHECK /, '') ?? null });
      } else if (c.type === 'n') {
        const r = cat.getRelation(c.relOid)!;
        out.push({ constraint_catalog: session.databaseName, constraint_schema: cat.namespaceName(c.nspOid), constraint_name: c.name, check_clause: `${quoteIdentifier(r.columns[c.columns[0] - 1].name)} IS NOT NULL` });
      }
    }
    return out;
  },
  'information_schema.routines': (session, cat) =>
    [...cat.procs.values()].map((p) => ({ specific_catalog: session.databaseName, specific_schema: cat.namespaceName(p.nspOid), specific_name: `${p.name}_${p.oid}`, routine_catalog: session.databaseName, routine_schema: cat.namespaceName(p.nspOid), routine_name: p.name, routine_type: p.kind === 'p' ? 'PROCEDURE' : 'FUNCTION', data_type: dataTypeName(new TypeUtil(cat), cat, p.rettype), routine_body: p.lang === 'sql' ? 'SQL' : 'EXTERNAL', routine_definition: p.body ?? null, external_language: p.lang.toUpperCase() })),
  'information_schema.triggers': (session, cat) =>
    [...cat.triggers.values()].flatMap((t) => {
      const r = cat.getRelation(t.relOid)!;
      return t.events.map((ev) => ({ trigger_catalog: session.databaseName, trigger_schema: cat.namespaceName(r.nspOid), trigger_name: t.name, event_manipulation: ev, event_object_catalog: session.databaseName, event_object_schema: cat.namespaceName(r.nspOid), event_object_table: r.name, action_orientation: t.forEachRow ? 'ROW' : 'STATEMENT', action_timing: t.timing }));
    }),
  'information_schema.enabled_roles': () => [{ role_name: 'postgres' }],
};

function identityProp(cat: Catalog, c: Column, prop: 'start' | 'increment' | 'max' | 'min'): string | null {
  if (!c.identity || !c.identitySeqOid) {
    return null;
  }
  const s = cat.getRelation(c.identitySeqOid)?.sequence;
  return s ? String(s[prop]) : null;
}

function fkActionChar(a: string): string {
  switch (a) {
    case 'CASCADE':
      return 'c';
    case 'RESTRICT':
      return 'r';
    case 'SET NULL':
      return 'n';
    case 'SET DEFAULT':
      return 'd';
    default:
      return 'a';
  }
}

function amOid(cat: Catalog, name: string): number {
  for (const a of cat.builtin.ams.values()) {
    if (a.name === name) {
      return a.oid;
    }
  }
  return 0;
}

export { CLASS_OID, PgNumeric };
