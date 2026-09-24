import * as A from '../ast';
import { transformExpr } from '../analyze/expr';
import { addRelationRte } from '../analyze/from';
import { emptyQuery } from '../analyze/nodes';
import { ParseState } from '../analyze/parse-state';
import { Catalog, Column, Constraint, IndexElemDef, IndexInfo, NS_PG_CATALOG, Relation, StoredExpr, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { parseExpression } from '../parser-ddl';
import type { Session } from '../session';
import { outputValue } from '../types/io';
import {
  buildSequenceInfo,
  chooseConstraintName,
  chooseRelationName,
  createRowType,
  createSequenceRelation,
  defaultOpclass,
  findOpclass,
  indexColumnName,
  indexNameAddition,
  newColumn,
  newConstraint,
  typeNameInUse,
} from './common';
import { DdlContext } from './stmt-context';
import { atPosition } from '../analyze/location';

const SERIAL_TYPES: Record<string, number> = {
  serial: TypeOid.int4,
  serial4: TypeOid.int4,
  bigserial: TypeOid.int8,
  serial8: TypeOid.int8,
  smallserial: TypeOid.int2,
  serial2: TypeOid.int2,
};

export function resolveCreationNamespace(session: Session, rv: A.RangeVar, temp: boolean): number {
  if (temp) {
    if (rv.schema && rv.schema !== 'pg_temp') {
      throw new PgError(SqlState.INVALID_TABLE_DEFINITION, 'cannot create temporary relation in non-temporary schema');
    }
    return session.tempNamespace(true);
  }
  if (rv.schema) {
    if (rv.schema === 'pg_temp') {
      return session.tempNamespace(true);
    }
    const ns = session.catalog().findNamespace(rv.schema);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${rv.schema}" does not exist`);
    }
    return ns.oid;
  }
  return session.creationNamespace();
}

function storedExpr(expr: A.Expr, text?: string): StoredExpr {
  return { raw: expr, text: text ?? '' };
}

interface PendingIndexConstraint {
  kind: 'PRIMARY_KEY' | 'UNIQUE';
  name?: string;
  columns: string[];
  nullsNotDistinct: boolean;
  options?: A.IndexOptions;
}

interface PendingCheck {
  name?: string;
  expr: A.Expr;
  text: string;
  noInherit: boolean;
  column?: string;
  notValid?: boolean;
}

interface PendingFk {
  name?: string;
  columns: string[];
  fk: A.ForeignKeySpec;
  notValid?: boolean;
}

export function createTable(session: Session, stmt: A.CreateTableStmt): string {
  const nspOid = resolveCreationNamespace(session, stmt.relation, stmt.temp);
  const cat = session.ddlCatalog();
  const name = stmt.relation.name;
  const existing = cat.findRelationInNamespace(nspOid, name);
  if (existing) {
    if (stmt.ifNotExists) {
      return 'CREATE TABLE';
    }
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${name}" already exists`);
  }
  if (typeNameInUse(cat, name, nspOid)) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `type "${name}" already exists`, {
      hint: 'A relation has an associated type of the same name, so you must use a name that doesn\'t conflict with any existing type.',
    });
  }
  const an = session.makeAnalyzer();
  const columns: Column[] = [];
  const indexConstraints: PendingIndexConstraint[] = [];
  const checks: PendingCheck[] = [];
  const fks: PendingFk[] = [];
  const serials: { col: Column; seqType: number }[] = [];
  const identities: { col: Column; options: A.SequenceOption[] }[] = [];
  const notNullNames = new Map<string, string>();

  let parent: Relation | undefined;
  if (stmt.partitionOf) {
    parent = lookupTable(session, stmt.partitionOf);
    if (parent.kind !== 'p') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `table "${parent.name}" is not partitioned`);
    }
    for (const pc of parent.columns) {
      if (pc.isDropped) {
        continue;
      }
      const col = { ...newColumn(columns.length + 1, pc.name, pc.typeOid, pc.typmod, pc.collation), notNull: pc.notNull, defaultExpr: pc.defaultExpr, inhCount: 1, isLocal: false };
      columns.push(col);
    }
  }
  for (const inh of stmt.inherits) {
    const p = lookupTable(session, inh);
    for (const pc of p.columns) {
      if (pc.isDropped || columns.some((c) => c.name === pc.name)) {
        continue;
      }
      columns.push({ ...newColumn(columns.length + 1, pc.name, pc.typeOid, pc.typmod, pc.collation), notNull: pc.notNull, defaultExpr: pc.defaultExpr, inhCount: 1, isLocal: false });
    }
  }
  for (const like of stmt.like ?? []) {
    const src = atPosition(like.loc, () => lookupTable(session, like));
    for (const pc of src.columns) {
      if (pc.isDropped) {
        continue;
      }
      columns.push({ ...newColumn(columns.length + 1, pc.name, pc.typeOid, pc.typmod, pc.collation), notNull: pc.notNull });
    }
  }

  for (const def of stmt.columns) {
    let col = columns.find((c) => c.name === def.name);
    if (col && !stmt.partitionOf && col.isLocal) {
      throw new PgError(SqlState.DUPLICATE_COLUMN, `column "${def.name}" specified more than once`);
    }
    if (!col) {
      const tn = def.typeName;
      let typeOid: number;
      let typmod: number;
      const serialName = tn.names.length === 1 && tn.arrayBounds.length === 0 ? SERIAL_TYPES[tn.names[0]] : undefined;
      if (serialName !== undefined || (tn.names.length === 2 && tn.names[0] === 'pg_catalog' && SERIAL_TYPES[tn.names[1]] !== undefined)) {
        typeOid = serialName ?? SERIAL_TYPES[tn.names[1]];
        typmod = -1;
      } else {
        // transformColumnType: reported at the type name
        const r = atPosition(tn.loc, () => an.types.lookupTypeName(tn, session.relationSearchPath()));
        typeOid = r.oid;
        typmod = r.typmod;
        const t = cat.getType(typeOid);
        if (t && t.typtype === 'p') {
          throw new PgError(SqlState.WRONG_OBJECT_TYPE, `column "${def.name}" has pseudo-type ${an.types.formatType(typeOid, -1, false)}`);
        }
      }
      col = newColumn(columns.length + 1, def.name, typeOid, typmod, an.typeCollation(typeOid));
      col.ndims = tn.arrayBounds.length;
      columns.push(col);
      if (serialName !== undefined || (tn.names.length === 2 && SERIAL_TYPES[tn.names[1]] !== undefined)) {
        serials.push({ col, seqType: typeOid });
        col.notNull = true;
      }
    }
    if (def.collate) {
      const coll = cat.findCollation(def.collate.length > 1 ? cat.findNamespace(def.collate[0])?.oid ?? -1 : null, def.collate[def.collate.length - 1]);
      if (!coll) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${def.collate.join('.')}" for encoding "UTF8" does not exist`);
      }
      if (!an.typeCollation(col.typeOid)) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, `collations are not supported by type ${an.types.formatType(col.typeOid, -1, false)}`);
      }
      col.collation = coll.oid;
    }
    for (const c of def.constraints) {
      switch (c.kind) {
        case 'NOT_NULL':
          col.notNull = true;
          if (c.name) {
            notNullNames.set(col.name, c.name);
          }
          break;
        case 'NULL':
          break;
        case 'DEFAULT':
          if (serials.some((s) => s.col === col)) {
            throw new PgError(SqlState.SYNTAX_ERROR, `multiple default values specified for column "${col.name}" of table "${name}"`);
          }
          col.defaultExpr = storedExpr(c.expr);
          break;
        case 'PRIMARY_KEY':
          indexConstraints.push({ kind: 'PRIMARY_KEY', name: c.name, columns: [col.name], nullsNotDistinct: false, options: c.options });
          break;
        case 'UNIQUE':
          indexConstraints.push({ kind: 'UNIQUE', name: c.name, columns: [col.name], nullsNotDistinct: !!c.nullsNotDistinct, options: c.options });
          break;
        case 'CHECK':
          checks.push({ name: c.name, expr: c.expr, text: c.exprText, noInherit: !!c.noInherit, column: col.name });
          break;
        case 'REFERENCES':
          fks.push({ name: c.name, columns: [col.name], fk: c.fk });
          break;
        case 'IDENTITY':
          identities.push({ col, options: c.seqOptions });
          col.identity = c.always ? 'a' : 'd';
          col.notNull = true;
          break;
        case 'GENERATED':
          col.generated = c.stored ? 's' : 'v';
          col.defaultExpr = storedExpr(c.expr, c.exprText);
          break;
      }
    }
  }
  for (const tc of stmt.constraints) {
    switch (tc.kind) {
      case 'PRIMARY_KEY':
        indexConstraints.push({ kind: 'PRIMARY_KEY', name: tc.name, columns: tc.columns, nullsNotDistinct: false, options: tc.options });
        break;
      case 'UNIQUE':
        indexConstraints.push({ kind: 'UNIQUE', name: tc.name, columns: tc.columns, nullsNotDistinct: !!tc.nullsNotDistinct, options: tc.options });
        break;
      case 'CHECK':
        checks.push({ name: tc.name, expr: tc.expr, text: tc.exprText, noInherit: !!tc.noInherit, notValid: tc.notValid });
        break;
      case 'FOREIGN_KEY':
        fks.push({ name: tc.name, columns: tc.columns, fk: tc.fk, notValid: tc.notValid });
        break;
      case 'EXCLUDE':
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: EXCLUDE constraints are not supported');
    }
  }
  if (indexConstraints.filter((c) => c.kind === 'PRIMARY_KEY').length > 1) {
    throw new PgError(SqlState.INVALID_TABLE_DEFINITION, `multiple primary keys for table "${name}" are not allowed`);
  }
  for (const ic of indexConstraints) {
    for (const cn of ic.columns) {
      const col = columns.find((c) => c.name === cn);
      if (!col) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cn}" named in key does not exist`);
      }
      if (ic.kind === 'PRIMARY_KEY') {
        col.notNull = true;
      }
    }
  }

  const persistence = stmt.temp ? 't' : stmt.unlogged ? 'u' : 'p';
  const relOid = session.db.oids.allocate();
  const rel: Relation = {
    oid: relOid,
    name,
    nspOid,
    kind: stmt.partitionSpec ? 'p' : 'r',
    persistence,
    columns,
    rowTypeOid: 0,
    storageId: 0,
    options: (stmt.withOptions ?? []).map((o) => `${o.name}=${o.value ?? 'true'}`),
    inheritsFrom: [],
    hasTriggers: false,
    populated: true,
    ownerSessionId: stmt.temp ? session.backendPid : undefined,
    onCommit: stmt.onCommit,
  };
  if (rel.kind === 'r') {
    const heap = session.db.store.createHeap();
    rel.storageId = heap.storageId;
    session.txn!.createdStorage.push(heap.storageId);
  }
  if (parent) {
    rel.parentOid = parent.oid;
    rel.partitionBound = stmt.partitionBound;
  }
  for (const inh of stmt.inherits) {
    rel.inheritsFrom.push(lookupTable(session, inh).oid);
  }
  cat.putRelation(rel);
  createRowType(session, cat, rel);

  // partition key
  if (stmt.partitionSpec) {
    const strategy = stmt.partitionSpec.strategy === 'RANGE' ? 'r' : stmt.partitionSpec.strategy === 'LIST' ? 'l' : 'h';
    rel.partitionKey = {
      strategy,
      keys: stmt.partitionSpec.params.map((p) => buildIndexElem(session, cat, rel, p, 'btree', 'partition_expression')),
    };
  }

  // sequences for serial / identity
  for (const s of serials) {
    const seqName = chooseRelationName(cat, name, s.col.name, 'seq', nspOid, false);
    const info = buildSequenceInfo(session, [{ name: 'as', typeName: { kind: 'TypeName', names: ['pg_catalog', s.seqType === TypeOid.int2 ? 'int2' : s.seqType === TypeOid.int4 ? 'int4' : 'int8'], typmods: [], arrayBounds: [] } }]);
    const seq = createSequenceRelation(session, cat, seqName, nspOid, info, persistence);
    info.ownedBy = { relOid, attnum: s.col.attnum, identity: false };
    const nsPrefix = session.searchPathNamespaces().includes(nspOid) ? '' : cat.namespaceName(nspOid) + '.';
    const text = `nextval('${(nsPrefix + seq.name).replace(/'/g, "''")}'::regclass)`;
    s.col.defaultExpr = storedExpr(parseExpression(text), text);
  }
  for (const id of identities) {
    let seqName = chooseRelationName(cat, name, id.col.name, 'seq', nspOid, false);
    const seqNameOpt = id.options.find((o) => o.name === 'sequence_name');
    if (seqNameOpt && seqNameOpt.name === 'sequence_name') {
      seqName = seqNameOpt.value[seqNameOpt.value.length - 1];
    }
    const info = buildSequenceInfo(session, id.options.filter((o) => o.name !== 'sequence_name'), undefined, id.col.typeOid);
    const seq = createSequenceRelation(session, cat, seqName, nspOid, info, persistence);
    info.ownedBy = { relOid, attnum: id.col.attnum, identity: true };
    id.col.identitySeqOid = seq.oid;
  }

  // validate defaults / generated expressions
  const ctx = new DdlContext(session, cat);
  for (const col of columns) {
    if (col.defaultExpr && !col.generated) {
      const r = ctx.host.analyzeDefault(rel, col);
      void r;
    } else if (col.generated && col.defaultExpr) {
      ctx.host.analyzeRelationExpr(rel, col.defaultExpr, 'generated');
    }
  }

  // NOT NULL constraints (PostgreSQL 18 records them in pg_constraint)
  const usedNames: string[] = [];
  for (const col of columns) {
    if (col.notNull) {
      const cname = notNullNames.get(col.name) ?? chooseConstraintName(cat, name, col.name, 'not_null', nspOid, usedNames);
      usedNames.push(cname);
      cat.putConstraint(newConstraint(session, { name: cname, nspOid, type: 'n', relOid, columns: [col.attnum] }));
    }
  }

  // PRIMARY KEY / UNIQUE
  for (const ic of indexConstraints) {
    addIndexConstraint(session, cat, rel, ic.kind, ic.name, ic.columns, ic.nullsNotDistinct, ic.options, ctx);
  }

  // CHECK constraints
  for (const chk of checks) {
    addCheckConstraint(session, cat, rel, chk, ctx, usedNames, false);
  }

  // FOREIGN KEYs
  for (const fk of fks) {
    addForeignKey(session, cat, rel, fk, ctx, false);
  }

  if (stmt.onCommit === 'DROP') {
    // Dropped inside the committing transaction (see TxnState.preCommit)
    session.txn!.preCommit.push(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dropRelationNow } = require('./drop');
      dropRelationNow(session, rel.oid);
    });
  }
  return 'CREATE TABLE';
}

export function lookupTable(session: Session, rv: A.RangeVar): Relation {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { lookupRelation } = require('../analyze/from');
  const rel = lookupRelation(session.makeAnalyzer(), rv) as Relation;
  return rel;
}

export function addIndexConstraint(
  session: Session,
  cat: Catalog,
  rel: Relation,
  kind: 'PRIMARY_KEY' | 'UNIQUE',
  name: string | undefined,
  columns: string[],
  nullsNotDistinct: boolean,
  options: A.IndexOptions | undefined,
  ctx: DdlContext
): { index: Relation; constraint: Constraint } {
  if (kind === 'PRIMARY_KEY' && cat.constraintsOf(rel.oid).some((c) => c.type === 'p')) {
    throw new PgError(SqlState.INVALID_TABLE_DEFINITION, `multiple primary keys for table "${rel.name}" are not allowed`);
  }
  const attnums = columns.map((cn) => {
    const col = rel.columns.find((c) => !c.isDropped && c.name === cn);
    if (!col) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cn}" named in key does not exist`);
    }
    if (kind === 'PRIMARY_KEY' && !col.notNull) {
      col.notNull = true;
      const cname = chooseConstraintName(cat, rel.name, col.name, 'not_null', rel.nspOid, []);
      cat.putConstraint(newConstraint(session, { name: cname, nspOid: rel.nspOid, type: 'n', relOid: rel.oid, columns: [col.attnum] }));
    }
    return col.attnum;
  });
  const indexName = name ?? (kind === 'PRIMARY_KEY' ? chooseRelationName(cat, rel.name, null, 'pkey', rel.nspOid, true) : chooseRelationName(cat, rel.name, indexNameAddition(columns), 'key', rel.nspOid, true));
  if (cat.findRelationInNamespace(rel.nspOid, indexName)) {
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${indexName}" already exists`);
  }
  const elems: A.IndexElem[] = columns.map((c) => ({ name: c, ordering: 'DEFAULT', nullsOrdering: 'DEFAULT' }));
  const index = createIndexRelation(session, cat, rel, indexName, elems, (options?.include ?? []), null, 'btree', true, kind === 'PRIMARY_KEY', nullsNotDistinct, options?.withOptions ?? [], ctx);
  const constraint = newConstraint(session, {
    name: indexName,
    nspOid: rel.nspOid,
    type: kind === 'PRIMARY_KEY' ? 'p' : 'u',
    relOid: rel.oid,
    columns: attnums,
    indexOid: index.oid,
  });
  cat.putConstraint(constraint);
  index.index!.constraintOid = constraint.oid;
  return { index, constraint };
}

export function buildIndexElem(session: Session, cat: Catalog, rel: Relation, elem: A.IndexElem, method: string, exprKind: 'index_expression' | 'partition_expression' = 'index_expression'): IndexElemDef {
  const an = session.makeAnalyzer();
  let attnum = 0;
  let typeOid: number;
  let expr: StoredExpr | undefined;
  let collation = 0;
  if (elem.name) {
    const col = rel.columns.find((c) => !c.isDropped && c.name === elem.name);
    if (!col) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${elem.name}" does not exist`);
    }
    attnum = col.attnum;
    typeOid = col.typeOid;
    collation = col.collation;
  } else {
    expr = { raw: elem.expr!, text: elem.exprText ?? '' };
    const q = emptyQuery();
    const pstate = new ParseState(null, q);
    const rtIndex = addRelationRte(an, pstate, rel, undefined, false, rel.name);
    pstate.namespace.push({ rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true });
    const texpr = transformExpr(an, pstate, elem.expr!, exprKind);
    typeOid = texpr.type;
    collation = texpr.collation;
    const proc = texpr.k === 'func' ? cat.getProc(texpr.funcOid) : null;
    if (proc && proc.volatile !== 'i' && proc.isBuiltin) {
      throw new PgError(SqlState.INVALID_OBJECT_DEFINITION, `functions in ${exprKind === 'partition_expression' ? 'partition key' : 'index'} expression must be marked IMMUTABLE`);
    }
  }
  if (elem.collation) {
    const coll = cat.findCollation(null, elem.collation[elem.collation.length - 1]);
    if (!coll) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${elem.collation.join('.')}" for encoding "UTF8" does not exist`);
    }
    collation = coll.oid;
  }
  let opclassOid: number;
  if (elem.opclass) {
    opclassOid = findOpclass(session, method, elem.opclass);
  } else {
    opclassOid = defaultOpclass(session, method, typeOid);
    if (!opclassOid) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `data type ${an.types.formatType(typeOid, -1, false)} has no default operator class for access method "${method}"`, {
        hint: 'You must specify an operator class for the index or define a default operator class for the data type.',
      });
    }
  }
  const desc = elem.ordering === 'DESC';
  const nullsFirst = elem.nullsOrdering === 'DEFAULT' ? desc : elem.nullsOrdering === 'FIRST';
  return { attnum, expr, collation, opclassOid, desc, nullsFirst, opclassExplicit: !!elem.opclass, opclassOptions: elem.opclassOptions };
}

export function createIndexRelation(
  session: Session,
  cat: Catalog,
  rel: Relation,
  indexName: string,
  elems: A.IndexElem[],
  include: string[],
  predicate: { raw: A.Expr; text: string } | null,
  method: string,
  unique: boolean,
  primary: boolean,
  nullsNotDistinct: boolean,
  withOptions: A.DefElem[],
  ctx: DdlContext
): Relation {
  // transformIndexStmt: the WHERE clause is transformed before the index expressions
  if (predicate) {
    ctx.host.analyzeRelationExpr(rel, predicate, 'predicate');
  }
  const keys = elems.map((e) => buildIndexElem(session, cat, rel, e, method));
  const includeAttnums = include.map((cn) => {
    const col = rel.columns.find((c) => !c.isDropped && c.name === cn);
    if (!col) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cn}" does not exist`);
    }
    return col.attnum;
  });
  const oid = session.db.oids.allocate();
  const info: IndexInfo = {
    tableOid: rel.oid,
    unique,
    primary,
    exclusion: false,
    immediate: true,
    keys,
    include: includeAttnums,
    predicate: predicate ?? undefined,
    method,
    nullsNotDistinct,
    valid: true,
    constraintOid: 0,
  };
  const columns: Column[] = [];
  keys.forEach((k, i) => {
    const colName = k.attnum > 0 ? rel.columns[k.attnum - 1].name : indexColumnName(elems[i]);
    const type = k.attnum > 0 ? rel.columns[k.attnum - 1].typeOid : TypeOid.text;
    columns.push(newColumn(i + 1, colName, type, -1, k.collation));
  });
  includeAttnums.forEach((a) => {
    const c = rel.columns[a - 1];
    columns.push(newColumn(columns.length + 1, c.name, c.typeOid, c.typmod, c.collation));
  });
  const index: Relation = {
    oid,
    name: indexName,
    nspOid: rel.nspOid,
    kind: rel.kind === 'p' ? 'I' : 'i',
    persistence: rel.persistence,
    columns,
    rowTypeOid: 0,
    storageId: 0,
    options: withOptions.map((o) => `${o.name}=${o.value ?? 'true'}`),
    index: info,
    inheritsFrom: [],
    hasTriggers: false,
    populated: true,
  };
  cat.putRelation(index);
  if (unique) {
    validateUniqueIndex(session, cat, rel, index, ctx);
  }
  return index;
}

function validateUniqueIndex(session: Session, cat: Catalog, rel: Relation, index: Relation, ctx: DdlContext): void {
  const tuples = ctx.visibleTuples(rel);
  if (tuples.length === 0) {
    return;
  }
  ctx.st.scratch.clear();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DmlExecutor } = require('../exec/exec-dml');
  const dml = new DmlExecutor(ctx.host, ctx.executor);
  const info = dml.tableInfo(rel.oid);
  const u = info.uniques.find((x: { indexOid: number }) => x.indexOid === index.oid);
  if (!u) {
    return;
  }
  const seen = new Map<string, unknown[]>();
  const typeOps = session.typeOps;
  for (const { tuple } of tuples) {
    const k = u.keyOf(tuple.data, tuple);
    if (k === null) {
      continue;
    }
    const key = String(typeOps.multiKey(u.keyTypes, k));
    if (seen.has(key)) {
      const io = session.io;
      const vals = k.map((v: unknown, i: number) => (v === null ? 'null' : outputValue(u.keyTypes[i], v, io))).join(', ');
      throw new PgError(SqlState.UNIQUE_VIOLATION, `could not create unique index "${index.name}"`, {
        detail: `Key (${u.keyDisplay})=(${vals}) is duplicated.`,
        table: rel.name,
        constraint: index.name,
      });
    }
    seen.set(key, k);
  }
  void cat;
}

export function addCheckConstraint(session: Session, cat: Catalog, rel: Relation, chk: PendingCheck, ctx: DdlContext, usedNames: string[], validate: boolean): Constraint {
  const an = session.makeAnalyzer();
  const q = emptyQuery();
  const pstate = new ParseState(null, q);
  const rtIndex = addRelationRte(an, pstate, rel, undefined, false, rel.name);
  pstate.namespace.push({ rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true });
  const texpr = an.coerceToBoolean(pstate, transformExpr(an, pstate, chk.expr, 'check_constraint'), 'CHECK');
  // single referenced column names the constraint
  const vars = new Set<number>();
  const collect = (e: import('../analyze/nodes').TExpr) => {
    if (e.k === 'var') {
      vars.add(e.attno);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../analyze/walk').forEachChild(e, collect);
  };
  collect(texpr);
  const colName = vars.size === 1 ? q.rtable[rtIndex].eref.colnames[[...vars][0]] : null;
  let name = chk.name;
  if (name) {
    if (cat.constraintsOf(rel.oid).some((c) => c.name === name)) {
      throw new PgError(SqlState.DUPLICATE_OBJECT, `constraint "${name}" for relation "${rel.name}" already exists`);
    }
  } else {
    name = chooseConstraintName(cat, rel.name, colName, 'check', rel.nspOid, usedNames);
  }
  usedNames.push(name);
  const constraint = newConstraint(session, {
    name,
    nspOid: rel.nspOid,
    type: 'c',
    relOid: rel.oid,
    columns: [...vars].map((i) => (q.rtable[rtIndex] as import('../analyze/nodes').RelationRTE).attnums[i]).sort((a, b) => a - b),
    check: { raw: chk.expr, text: chk.text },
    noInherit: chk.noInherit,
    validated: !chk.notValid,
  });
  cat.putConstraint(constraint);
  if (validate && !chk.notValid) {
    const tuples = ctx.visibleTuples(rel);
    if (tuples.length > 0) {
      ctx.st.scratch.clear();
      const { q: cq, expr } = ctx.host.analyzeRelationExpr(rel, constraint.check!, 'check');
      const plan = ctx.executor.planFor(cq, null);
      const ev = plan.ev(expr);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { EvalCtx } = require('../exec/runtime');
      for (const { tuple } of tuples) {
        if (ev(new EvalCtx([tuple.data, tuple], null, ctx.st)) === false) {
          throw new PgError(SqlState.CHECK_VIOLATION, `check constraint "${name}" of relation "${rel.name}" is violated by some row`, {
            table: rel.name,
            constraint: name,
          });
        }
      }
    }
  }
  return constraint;
}

export function addForeignKey(session: Session, cat: Catalog, rel: Relation, fk: PendingFk, ctx: DdlContext, validate: boolean): Constraint {
  const refRel = lookupTable(session, fk.fk.refTable);
  if (refRel.kind !== 'r' && refRel.kind !== 'p') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `referenced relation "${refRel.name}" is not a table`);
  }
  if (rel.persistence !== 't' && refRel.persistence === 't') {
    throw new PgError(SqlState.INVALID_TABLE_DEFINITION, 'constraints on permanent tables may reference only permanent tables');
  }
  const cols = fk.columns.map((cn) => {
    const col = rel.columns.find((c) => !c.isDropped && c.name === cn);
    if (!col) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cn}" referenced in foreign key constraint does not exist`);
    }
    return col;
  });
  let refCols: Column[];
  if (fk.fk.refColumns.length === 0) {
    const pk = cat.constraintsOf(refRel.oid).find((c) => c.type === 'p');
    if (!pk) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `there is no primary key for referenced table "${refRel.name}"`);
    }
    refCols = pk.columns.map((a) => refRel.columns[a - 1]);
  } else {
    refCols = fk.fk.refColumns.map((cn) => {
      const col = refRel.columns.find((c) => !c.isDropped && c.name === cn);
      if (!col) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cn}" referenced in foreign key constraint does not exist`);
      }
      return col;
    });
    const refAttnums = refCols.map((c) => c.attnum);
    const hasUnique = cat
      .constraintsOf(refRel.oid)
      .some((c) => (c.type === 'p' || c.type === 'u') && c.columns.length === refAttnums.length && c.columns.every((a) => refAttnums.includes(a)));
    const hasUniqueIndex = cat.indexesOf(refRel.oid).some((ix) => ix.index!.unique && !ix.index!.predicate && ix.index!.keys.every((k) => k.attnum > 0) && ix.index!.keys.length === refAttnums.length && ix.index!.keys.every((k) => refAttnums.includes(k.attnum)));
    if (!hasUnique && !hasUniqueIndex) {
      throw new PgError(SqlState.INVALID_FOREIGN_KEY, `there is no unique constraint matching given keys for referenced table "${refRel.name}"`);
    }
  }
  if (cols.length !== refCols.length) {
    throw new PgError(SqlState.INVALID_FOREIGN_KEY, 'number of referencing and referenced columns for foreign key disagree');
  }
  const an = session.makeAnalyzer();
  let name = fk.name;
  if (!name) {
    name = chooseConstraintName(cat, rel.name, indexNameAddition(cols.map((c) => c.name)), 'fkey', rel.nspOid, []);
  } else if (cat.constraintsOf(rel.oid).some((c) => c.name === name)) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `constraint "${name}" for relation "${rel.name}" already exists`);
  }
  cols.forEach((c, i) => {
    const rc = refCols[i];
    const ok =
      c.typeOid === rc.typeOid ||
      an.types.findCoercionPathway(rc.typeOid, c.typeOid, 'implicit').kind !== 'none' ||
      an.types.findCoercionPathway(c.typeOid, rc.typeOid, 'implicit').kind !== 'none';
    if (!ok) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `foreign key constraint "${name}" cannot be implemented`, {
        detail: `Key columns "${c.name}" of the referencing table and "${rc.name}" of the referenced table are of incompatible types: ${an.types.formatType(c.typeOid, -1, false)} and ${an.types.formatType(rc.typeOid, -1, false)}.`,
      });
    }
  });
  const constraint = newConstraint(session, {
    name,
    nspOid: rel.nspOid,
    type: 'f',
    relOid: rel.oid,
    columns: cols.map((c) => c.attnum),
    fk: {
      refRelOid: refRel.oid,
      refColumns: refCols.map((c) => c.attnum),
      onDelete: fk.fk.onDelete,
      onUpdate: fk.fk.onUpdate,
      matchType: fk.fk.matchType,
      deleteSetColumns: fk.fk.deleteSetColumns?.map((cn) => rel.columns.find((c) => c.name === cn)!.attnum),
    },
    deferrable: !!fk.fk.deferrable,
    initiallyDeferred: !!fk.fk.initiallyDeferred,
    validated: !fk.notValid,
  });
  // unique index used for the reference
  const refAttnums = refCols.map((c) => c.attnum);
  const refIndex = cat.indexesOf(refRel.oid).find((ix) => ix.index!.unique && ix.index!.keys.length === refAttnums.length && ix.index!.keys.every((k) => refAttnums.includes(k.attnum)));
  constraint.indexOid = refIndex?.oid ?? 0;
  cat.putConstraint(constraint);
  if (validate && !fk.notValid) {
    const tuples = ctx.visibleTuples(rel);
    if (tuples.length > 0) {
      ctx.st.scratch.clear();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DmlExecutor } = require('../exec/exec-dml');
      const dml = new DmlExecutor(ctx.host, ctx.executor);
      const info = dml.tableInfo(rel.oid);
      info.fksOut = [constraint];
      for (const { tuple } of tuples) {
        dml.checkForeignKeysOut(info, tuple.data, rel);
      }
    }
  }
  return constraint;
}

export function defaultNamespaceName(session: Session, nspOid: number): string {
  return nspOid === NS_PG_CATALOG ? 'pg_catalog' : session.catalog().namespaceName(nspOid);
}
