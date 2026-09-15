import * as A from '../ast';
import { transformProcedureCall } from '../analyze/func-call';
import { lookupRelation } from '../analyze/from';
import { emptyQuery, Query } from '../analyze/nodes';
import { ParseState } from '../analyze/parse-state';
import { Executor } from '../exec/executor';
import { SessionHost } from '../session';
import { UndoLog } from '../storage/mvcc';
import { analyzeStatementAsSubquery } from '../analyze/select';
import { quoteIdentifier } from '../analyze/typeutil';
import { Catalog, NS_PG_CATALOG, PgType, ProcDef, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { EvalCtx, StatementState } from '../exec/runtime';
import { runDoBlock } from '../plpgsql/functions';
import type { FieldInfo, Session } from '../session';
import { displaySettingValue, settingDef } from '../settings';
import { executeAlterTable, renameRelation } from './alter-table';
import { arrayTypeName, buildSequenceInfo, chooseRelationName, createRowType, createSequenceRelation, indexColumnName, indexNameAddition, newColumn } from './common';
import { createIndexRelation, createTable, lookupTable, resolveCreationNamespace } from './create-table';
import { executeDrop, executeTruncate } from './drop';
import { createExtension } from './extensions';
import { explainStatement } from './explain';
import { DdlContext } from './stmt-context';

export interface UtilityResult {
  command: string;
  rowCount?: number;
  fields?: FieldInfo[];
  rows?: unknown[][];
}

function textField(name: string): FieldInfo {
  return { name, typeOid: TypeOid.text, typmod: -1, tableOid: 0, columnAttnum: 0 };
}

export function executeUtility(session: Session, stmt: A.Statement, text: string, params: unknown[], parentSt: StatementState | null, boundTypes?: number[], undo?: UndoLog | null): UtilityResult {
  switch (stmt.kind) {
    case 'CreateTableStmt':
      return { command: createTable(session, stmt) };
    case 'CreateTableAsStmt':
      return parentSt ? createTableAs(session, stmt, parentSt.params, parentSt.paramTypes) : createTableAs(session, stmt, params, boundTypes ?? []);
    case 'CreateIndexStmt':
      return { command: createIndex(session, stmt) };
    case 'CreateSequenceStmt':
      return { command: createSequence(session, stmt) };
    case 'AlterSequenceStmt':
      return { command: alterSequence(session, stmt) };
    case 'AlterTableStmt':
      return { command: executeAlterTable(session, stmt) };
    case 'DropStmt':
      return { command: executeDrop(session, stmt) };
    case 'TruncateStmt':
      return { command: executeTruncate(session, stmt) };
    case 'CreateSchemaStmt':
      return { command: createSchema(session, stmt) };
    case 'CreateEnumStmt':
      return { command: createEnum(session, stmt) };
    case 'AlterEnumStmt':
      return { command: alterEnum(session, stmt) };
    case 'CreateDomainStmt':
      return { command: createDomain(session, stmt) };
    case 'CreateCompositeTypeStmt':
      return { command: createCompositeType(session, stmt) };
    case 'CreateFunctionStmt':
      return { command: createFunction(session, stmt) };
    case 'CreateTriggerStmt':
      return { command: createTrigger(session, stmt) };
    case 'ViewStmt':
      return { command: createView(session, stmt) };
    case 'CreateExtensionStmt':
      return { command: createExtension(session, stmt) };
    case 'CreateCollationStmt':
      return { command: createCollation(session, stmt) };
    case 'CreateStatsStmt':
      return { command: createStatistics(session, stmt) };
    case 'CommentStmt':
      return { command: comment(session, stmt) };
    case 'VariableSetStmt':
      return { command: variableSet(session, stmt) };
    case 'VariableShowStmt':
      return variableShow(session, stmt);
    case 'DoStmt':
      runDoBlock(session, stmt, parentSt, undo ?? null);
      return { command: 'DO' };
    case 'ExplainStmt':
      return explainStatement(session, stmt, params, boundTypes ?? [], parentSt);
    case 'NoopStmt':
      if (stmt.tag.startsWith('DISCARD')) {
        discard(session, stmt.tag);
      }
      return { command: stmt.tag };
    case 'LockStmt':
      for (const rv of stmt.relations) {
        lookupTable(session, rv);
      }
      if (!session.txn?.explicit) {
        throw new PgError(SqlState.NO_ACTIVE_SQL_TRANSACTION, 'LOCK TABLE can only be used in transaction blocks');
      }
      return { command: 'LOCK TABLE' };
    case 'AlterDatabaseSetStmt':
      return { command: alterDatabaseSet(session, stmt) };
    case 'CallStmt':
      return callProcedure(session, stmt, params, parentSt, boundTypes, undo ?? null);
    case 'PrepareStmt': {
      if (session.preparedStatements.has(stmt.name)) {
        throw new PgError(SqlState.DUPLICATE_PSTATEMENT, `prepared statement "${stmt.name}" already exists`);
      }
      const an = session.makeAnalyzer();
      const argTypes = stmt.argTypes.map((t) => an.types.lookupTypeName(t, session.relationSearchPath()).oid);
      session.preparedStatements.set(stmt.name, { stmt: stmt.query, argTypes, text, fromSql: true, resultTypes: [], prepareTime: session.statementTimestamp() });
      return { command: 'PREPARE' };
    }
    case 'ExecuteStmt':
      return executePrepared(session, stmt);
    case 'DeallocateStmt':
      if (stmt.name) {
        if (!session.preparedStatements.delete(stmt.name)) {
          throw new PgError(SqlState.INVALID_SQL_STATEMENT_NAME, `prepared statement "${stmt.name}" does not exist`);
        }
      } else {
        session.preparedStatements.clear();
      }
      return { command: 'DEALLOCATE' };
    case 'RenameStmt':
      return { command: rename(session, stmt) };
    case 'AlterTypeStmt':
      return { command: alterType(session, stmt) };
    case 'NotifyStmt':
      session.notify(stmt.channel, stmt.payload ?? '');
      return { command: 'NOTIFY' };
    case 'ListenStmt': {
      if (stmt.unlisten) {
        if (stmt.channel === '*') {
          for (const set of session.db.listeners.values()) {
            set.delete(session);
          }
        } else {
          session.db.listeners.get(stmt.channel)?.delete(session);
        }
        return { command: 'UNLISTEN' };
      }
      let set = session.db.listeners.get(stmt.channel);
      if (!set) {
        set = new Set();
        session.db.listeners.set(stmt.channel, set);
      }
      set.add(session);
      return { command: 'LISTEN' };
    }
    case 'RefreshMatViewStmt':
      return { command: refreshMatView(session, stmt) };
    case 'CopyStmt':
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: COPY is not supported');
  }
  void text;
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: statement ${stmt.kind} is not supported`);
}

// ---------------------------------------------------------------------------
// CREATE INDEX
// ---------------------------------------------------------------------------

function createIndex(session: Session, stmt: A.CreateIndexStmt): string {
  if (stmt.concurrently && session.txn?.explicit) {
    throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
  }
  const cat = session.ddlCatalog();
  const rel = lookupTable(session, stmt.relation);
  if (rel.kind !== 'r' && rel.kind !== 'p' && rel.kind !== 'm') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `cannot create index on relation "${rel.name}"`, { detail: `This operation is not supported for ${rel.kind === 'v' ? 'views' : 'this relation kind'}.` });
  }
  const method = stmt.method.toLowerCase();
  if (!['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'].includes(method)) {
    throw new PgError(SqlState.UNDEFINED_OBJECT, `access method "${stmt.method}" does not exist`);
  }
  if (stmt.unique && method !== 'btree') {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `access method "${method}" does not support unique indexes`);
  }
  if (stmt.include.length > 0 && method !== 'btree' && method !== 'gist' && method !== 'spgist') {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `access method "${method}" does not support included columns`);
  }
  let name = stmt.name;
  if (name) {
    if (cat.findRelationInNamespace(rel.nspOid, name)) {
      if (stmt.ifNotExists) {
        return 'CREATE INDEX';
      }
      throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${name}" already exists`);
    }
  } else {
    const colnames = [...stmt.params.map((p) => indexColumnName(p)), ...stmt.include];
    name = chooseRelationName(cat, rel.name, indexNameAddition(colnames), stmt.unique ? 'key' : 'idx', rel.nspOid, false);
  }
  const ctx = new DdlContext(session, cat);
  createIndexRelation(
    session,
    cat,
    rel,
    name,
    stmt.params,
    stmt.include,
    stmt.where ? { raw: stmt.where, text: stmt.whereText ?? '' } : null,
    method,
    stmt.unique,
    false,
    stmt.nullsNotDistinct,
    stmt.withOptions,
    ctx
  );
  return 'CREATE INDEX';
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

function createSequence(session: Session, stmt: A.CreateSequenceStmt): string {
  const nspOid = resolveCreationNamespace(session, stmt.sequence, stmt.temp);
  const cat = session.ddlCatalog();
  if (cat.findRelationInNamespace(nspOid, stmt.sequence.name)) {
    if (stmt.ifNotExists) {
      return 'CREATE SEQUENCE';
    }
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${stmt.sequence.name}" already exists`);
  }
  const info = buildSequenceInfo(session, stmt.options);
  const rel = createSequenceRelation(session, cat, stmt.sequence.name, nspOid, info, stmt.temp ? 't' : 'p');
  const owned = stmt.options.find((o) => o.name === 'owned_by');
  if (owned && owned.name === 'owned_by' && owned.value) {
    const colName = owned.value[owned.value.length - 1];
    const table = lookupTable(session, { kind: 'RangeVar', name: owned.value[owned.value.length - 2], schema: owned.value.length > 2 ? owned.value[0] : undefined, inh: true });
    const col = table.columns.find((c) => c.name === colName && !c.isDropped);
    if (!col) {
      throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${colName}" of relation "${table.name}" does not exist`);
    }
    info.ownedBy = { relOid: table.oid, attnum: col.attnum, identity: false };
  }
  createRowTypeIfNeeded(session, cat, rel);
  return 'CREATE SEQUENCE';
}

function createRowTypeIfNeeded(session: Session, cat: Catalog, rel: import('../catalog/catalog').Relation): void {
  void session;
  void cat;
  void rel;
}

function alterSequence(session: Session, stmt: A.AlterSequenceStmt): string {
  const cat = session.ddlCatalog();
  const rel = lookupRelation(session.makeAnalyzer(), stmt.sequence, stmt.ifExists);
  if (!rel) {
    return 'ALTER SEQUENCE';
  }
  if (rel.kind !== 'S') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is not a sequence`);
  }
  const info = buildSequenceInfo(session, stmt.options, rel.sequence);
  const owned = stmt.options.find((o) => o.name === 'owned_by');
  if (owned && owned.name === 'owned_by') {
    if (owned.value === null) {
      info.ownedBy = undefined;
    } else {
      const table = lookupTable(session, { kind: 'RangeVar', name: owned.value[owned.value.length - 2], inh: true });
      const col = table.columns.find((c) => c.name === owned.value![owned.value!.length - 1]);
      info.ownedBy = { relOid: table.oid, attnum: col!.attnum, identity: false };
    }
  }
  cat.putRelation({ ...rel, sequence: info });
  return 'ALTER SEQUENCE';
}

// ---------------------------------------------------------------------------
// Schemas, types, domains
// ---------------------------------------------------------------------------

function createSchema(session: Session, stmt: A.CreateSchemaStmt): string {
  const cat = session.ddlCatalog();
  if (cat.findNamespace(stmt.name)) {
    if (stmt.ifNotExists) {
      return 'CREATE SCHEMA';
    }
    throw new PgError(SqlState.DUPLICATE_SCHEMA, `schema "${stmt.name}" already exists`);
  }
  if (stmt.name.startsWith('pg_')) {
    throw new PgError(SqlState.RESERVED_NAME, `unacceptable schema name "${stmt.name}"`, { detail: 'The prefix "pg_" is reserved for system schemas.' });
  }
  const oid = session.db.oids.allocate();
  cat.namespaces.set(oid, { oid, name: stmt.name });
  cat.invalidate();
  return 'CREATE SCHEMA';
}

function typeNamespace(session: Session, names: string[]): { nspOid: number; name: string } {
  if (names.length > 1) {
    const nspName = names[names.length - 2];
    const ns = nspName === 'pg_temp' ? session.catalog().getNamespace(session.tempNamespace(true)) : session.catalog().findNamespace(nspName);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${names[names.length - 2]}" does not exist`);
    }
    return { nspOid: ns.oid, name: names[names.length - 1] };
  }
  return { nspOid: session.creationNamespace(), name: names[0] };
}

function baseTypeRecord(session: Session, name: string, nspOid: number, fields: Partial<PgType>): PgType {
  return {
    oid: session.db.oids.allocate(),
    name,
    nspOid,
    len: -1,
    byval: false,
    typtype: 'b',
    category: 'U',
    preferred: false,
    delim: ',',
    elem: 0,
    array: 0,
    baseType: 0,
    typmod: -1,
    collation: 0,
    align: 'i',
    storage: 'p',
    relid: 0,
    isArray: false,
    ...fields,
  };
}

function registerWithArray(session: Session, cat: Catalog, t: PgType): void {
  const arrOid = session.db.oids.allocate();
  t.array = arrOid;
  cat.putType(t);
  cat.putType({ ...t, oid: arrOid, name: arrayTypeName(cat, '_' + t.name, t.nspOid), typtype: 'b', category: 'A', elem: t.oid, array: 0, isArray: true, enumLabels: undefined, baseType: 0, len: -1, byval: false, align: 'i' });
}

function createEnum(session: Session, stmt: A.CreateEnumStmt): string {
  const { nspOid, name } = typeNamespace(session, stmt.typeName);
  const cat = session.ddlCatalog();
  if (cat.findTypeInNamespace(nspOid, name)) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `type "${name}" already exists`);
  }
  const seen = new Set<string>();
  const labels = stmt.labels.map((label, i) => {
    if (seen.has(label)) {
      throw new PgError(SqlState.DUPLICATE_OBJECT, `enum label "${label}" used more than once`);
    }
    if (Buffer.byteLength(label) > 63) {
      throw new PgError(SqlState.INVALID_NAME, `invalid enum label "${label}"`, { detail: 'Labels must be 63 bytes or less.' });
    }
    seen.add(label);
    return { oid: session.db.oids.allocate(), label, sortOrder: i + 1 };
  });
  const t = baseTypeRecord(session, name, nspOid, { typtype: 'e', category: 'E', len: 4, byval: true, align: 'i', enumLabels: labels });
  registerWithArray(session, cat, t);
  return 'CREATE TYPE';
}

function alterEnum(session: Session, stmt: A.AlterEnumStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  const oid = an.types.lookupTypeName({ kind: 'TypeName', names: stmt.typeName, typmods: [], arrayBounds: [] }, session.relationSearchPath()).oid;
  const t = cat.getType(oid)!;
  if (t.typtype !== 'e') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `${an.types.formatType(oid, -1, false)} is not an enum`);
  }
  const labels = [...(t.enumLabels ?? [])];
  if (stmt.rename) {
    const l = labels.find((x) => x.label === stmt.oldVal);
    if (!l) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `"${stmt.oldVal}" is not an existing enum label`);
    }
    if (labels.some((x) => x.label === stmt.newVal)) {
      throw new PgError(SqlState.DUPLICATE_OBJECT, `enum label "${stmt.newVal}" already exists`);
    }
    cat.putType({ ...t, enumLabels: labels.map((x) => (x === l ? { ...x, label: stmt.newVal! } : x)) });
    return 'ALTER TYPE';
  }
  if (labels.some((x) => x.label === stmt.newVal)) {
    if (stmt.skipIfNewValExists) {
      return 'ALTER TYPE';
    }
    throw new PgError(SqlState.DUPLICATE_OBJECT, `enum label "${stmt.newVal}" already exists`);
  }
  let sortOrder: number;
  if (stmt.newValNeighbor !== undefined) {
    const sorted = labels.sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((x) => x.label === stmt.newValNeighbor);
    if (idx < 0) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `"${stmt.newValNeighbor}" is not an existing enum label`);
    }
    if (stmt.newValIsAfter) {
      const next = sorted[idx + 1];
      sortOrder = next ? (sorted[idx].sortOrder + next.sortOrder) / 2 : sorted[idx].sortOrder + 1;
    } else {
      const prev = sorted[idx - 1];
      sortOrder = prev ? (sorted[idx].sortOrder + prev.sortOrder) / 2 : sorted[idx].sortOrder - 1;
    }
  } else {
    sortOrder = labels.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 1;
  }
  labels.push({ oid: session.db.oids.allocate(), label: stmt.newVal!, sortOrder });
  cat.putType({ ...t, enumLabels: labels });
  return 'ALTER TYPE';
}

function createDomain(session: Session, stmt: A.CreateDomainStmt): string {
  const { nspOid, name } = typeNamespace(session, stmt.domainName);
  const cat = session.ddlCatalog();
  if (cat.findTypeInNamespace(nspOid, name)) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `type "${name}" already exists`);
  }
  const an = session.makeAnalyzer();
  const base = an.types.lookupTypeName(stmt.typeName, session.relationSearchPath());
  const baseType = cat.getType(base.oid)!;
  const t = baseTypeRecord(session, name, nspOid, {
    typtype: 'd',
    category: baseType.category,
    baseType: base.oid,
    typmod: base.typmod,
    collation: baseType.collation,
    len: baseType.len,
    byval: baseType.byval,
    domainChecks: [],
  });
  for (const c of stmt.constraints) {
    if (c.kind === 'NOT_NULL') {
      t.domainNotNull = true;
    } else if (c.kind === 'DEFAULT') {
      t.domainDefault = { raw: c.expr, text: '' };
    } else if (c.kind === 'CHECK') {
      t.domainChecks!.push({ name: c.name ?? `${name}_check`, expr: { raw: c.expr, text: c.exprText } });
    }
  }
  registerWithArray(session, cat, t);
  return 'CREATE DOMAIN';
}

function createCompositeType(session: Session, stmt: A.CreateCompositeTypeStmt): string {
  const { nspOid, name } = typeNamespace(session, stmt.typeName);
  const cat = session.ddlCatalog();
  if (cat.findTypeInNamespace(nspOid, name) || cat.findRelationInNamespace(nspOid, name)) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `type "${name}" already exists`);
  }
  const an = session.makeAnalyzer();
  const rel: import('../catalog/catalog').Relation = {
    oid: session.db.oids.allocate(),
    name,
    nspOid,
    kind: 'c',
    persistence: 'p',
    columns: stmt.columns.map((c, i) => {
      const t = an.types.lookupTypeName(c.typeName, session.relationSearchPath());
      return newColumn(i + 1, c.name, t.oid, t.typmod, an.typeCollation(t.oid));
    }),
    rowTypeOid: 0,
    storageId: 0,
    options: [],
    inheritsFrom: [],
    hasTriggers: false,
    populated: true,
  };
  cat.putRelation(rel);
  createRowType(session, cat, rel);
  cat.putRelation(rel);
  return 'CREATE TYPE';
}

function alterType(session: Session, stmt: A.AlterTypeStmt): string {
  if (stmt.action === 'RENAME') {
    const cat = session.ddlCatalog();
    const an = session.makeAnalyzer();
    const oid = an.types.lookupTypeName({ kind: 'TypeName', names: stmt.typeName, typmods: [], arrayBounds: [] }, session.relationSearchPath()).oid;
    const t = cat.getType(oid)!;
    cat.putType({ ...t, name: stmt.newName! });
    if (t.array) {
      const arr = cat.getType(t.array)!;
      cat.putType({ ...arr, name: '_' + stmt.newName });
    }
  }
  return 'ALTER TYPE';
}

// ---------------------------------------------------------------------------
// Functions, triggers, views
// ---------------------------------------------------------------------------

function createFunction(session: Session, stmt: A.CreateFunctionStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  let nspOid: number;
  let name: string;
  if (stmt.funcname.length > 1) {
    // LookupCreationNamespace: pg_temp names (and creates) the session's temp schema
    const nspName = stmt.funcname[stmt.funcname.length - 2];
    const ns = nspName === 'pg_temp' ? cat.getNamespace(session.tempNamespace(true)) : cat.findNamespace(nspName);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${stmt.funcname[stmt.funcname.length - 2]}" does not exist`);
    }
    nspOid = ns.oid;
    name = stmt.funcname[stmt.funcname.length - 1];
  } else {
    nspOid = session.creationNamespace();
    name = stmt.funcname[0];
  }
  const lang = stmt.language.toLowerCase();
  if (!['sql', 'plpgsql', 'internal', 'c'].includes(lang)) {
    throw new PgError(SqlState.UNDEFINED_OBJECT, `language "${stmt.language}" does not exist`);
  }
  // a procedure's OUT parameters are part of its call signature (PostgreSQL 14+)
  const inParams = stmt.parameters.filter((p) => p.mode === 'IN' || p.mode === 'INOUT' || p.mode === 'VARIADIC' || (stmt.isProcedure && p.mode === 'OUT'));
  const argtypes = inParams.map((p) => an.types.lookupTypeName(p.typeName, session.relationSearchPath()).oid);
  const allParams = stmt.parameters;
  const hasOut = allParams.some((p) => p.mode === 'OUT' || p.mode === 'INOUT' || p.mode === 'TABLE');
  let rettype: number;
  let retset = false;
  let returnsTable: ProcDef['returnsTable'];
  if (stmt.returnsTable) {
    retset = true;
    rettype = TypeOid.record;
    returnsTable = stmt.returnsTable.map((c) => {
      const t = an.types.lookupTypeName(c.typeName, session.relationSearchPath());
      return { name: c.name, typeOid: t.oid, typmod: t.typmod };
    });
  } else if (stmt.returnType) {
    retset = !!stmt.returnType.setof;
    const lookup = stmt.returnType.names.length === 1 && stmt.returnType.names[0] === 'trigger' ? { oid: TypeOid.trigger } : an.types.lookupTypeName(stmt.returnType, session.relationSearchPath());
    rettype = lookup.oid;
  } else if (hasOut) {
    const outs = allParams.filter((p) => p.mode === 'OUT' || p.mode === 'INOUT');
    rettype = outs.length === 1 ? an.types.lookupTypeName(outs[0].typeName, session.relationSearchPath()).oid : TypeOid.record;
  } else if (stmt.isProcedure) {
    rettype = TypeOid.void;
  } else {
    throw new PgError(SqlState.INVALID_FUNCTION_DEFINITION, 'function result type must be specified');
  }
  const existing = [...cat.procs.values()].find((p) => p.name === name && p.nspOid === nspOid && p.argtypes.length === argtypes.length && p.argtypes.every((t, i) => t === argtypes[i]));
  if (existing && !stmt.replace) {
    throw new PgError(SqlState.DUPLICATE_FUNCTION, `function "${name}" already exists with same argument types`);
  }
  if (existing && existing.rettype !== rettype) {
    throw new PgError(SqlState.INVALID_FUNCTION_DEFINITION, 'cannot change return type of existing function', {
      hint: `Use DROP FUNCTION ${name}(${argtypes.map((t) => an.types.formatType(t, -1, false)).join(', ')}) first.`,
    });
  }
  const proc: ProcDef = {
    oid: existing?.oid ?? session.db.oids.allocate(),
    name,
    nspOid,
    kind: stmt.isProcedure ? 'p' : 'f',
    strict: stmt.strict,
    retset,
    volatile: stmt.volatility === 'IMMUTABLE' ? 'i' : stmt.volatility === 'STABLE' ? 's' : 'v',
    nargdefaults: inParams.filter((p) => p.defexpr).length,
    rettype,
    argtypes,
    allargtypes: hasOut ? allParams.map((p) => an.types.lookupTypeName(p.typeName, session.relationSearchPath()).oid) : undefined,
    argmodes: hasOut || allParams.some((p) => p.mode === 'VARIADIC') ? allParams.map((p) => (p.mode === 'IN' ? 'i' : p.mode === 'OUT' ? 'o' : p.mode === 'INOUT' ? 'b' : p.mode === 'VARIADIC' ? 'v' : 't')) : undefined,
    argnames: allParams.some((p) => p.name) ? allParams.map((p) => p.name ?? '') : undefined,
    variadic: allParams.some((p) => p.mode === 'VARIADIC') ? an.types.elemType(argtypes[argtypes.length - 1]) : 0,
    src: stmt.body,
    lang,
    argdefaults: inParams.filter((p) => p.defexpr).map((p) => p.defexpr!),
    body: stmt.body,
    sqlBody: stmt.sqlBody,
    returnsTable,
    isBuiltin: false,
    parallel: stmt.parallel,
    setOptions: stmt.setOptions,
    securityDefiner: stmt.securityDefiner,
  };
  if (lang === 'internal' || lang === 'c') {
    proc.isBuiltin = true;
    proc.src = stmt.body || name;
  }
  cat.putProc(proc);
  return stmt.isProcedure ? 'CREATE PROCEDURE' : 'CREATE FUNCTION';
}

function createTrigger(session: Session, stmt: A.CreateTriggerStmt): string {
  const cat = session.ddlCatalog();
  const rel = lookupTable(session, stmt.relation);
  const procs = cat.findProcsByName(stmt.funcname[stmt.funcname.length - 1]).filter((p) => p.rettype === TypeOid.trigger && p.argtypes.length === 0);
  if (procs.length === 0) {
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `function ${stmt.funcname.join('.')}() does not exist`);
  }
  const existing = [...cat.triggers.values()].find((t) => t.relOid === rel.oid && t.name === stmt.name);
  if (existing && !stmt.replace) {
    throw new PgError(SqlState.DUPLICATE_OBJECT, `trigger "${stmt.name}" for relation "${rel.name}" already exists`);
  }
  const oid = existing?.oid ?? session.db.oids.allocate();
  cat.triggers.set(oid, {
    oid,
    name: stmt.name,
    relOid: rel.oid,
    funcOid: procs[0].oid,
    timing: stmt.timing,
    events: stmt.events,
    updateColumns: stmt.updateColumns,
    forEachRow: stmt.forEachRow,
    when: stmt.when,
    args: stmt.args,
    enabled: true,
  });
  cat.putRelation({ ...cat.getRelation(rel.oid)!, hasTriggers: true });
  return 'CREATE TRIGGER';
}

function createView(session: Session, stmt: A.ViewStmt): string {
  const nspOid = resolveCreationNamespace(session, stmt.view, stmt.temp);
  const cat = session.ddlCatalog();
  const existing = cat.findRelationInNamespace(nspOid, stmt.view.name);
  if (existing && (!stmt.replace || existing.kind !== 'v')) {
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${stmt.view.name}" already exists`);
  }
  const an = session.makeAnalyzer();
  const { query } = analyzeStatementAsSubquery(an, stmt.query, null, true);
  const targets = query.targetList.filter((t) => !t.resjunk);
  const names = targets.map((t, i) => stmt.aliases?.[i] ?? t.name);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      throw new PgError(SqlState.DUPLICATE_COLUMN, `column "${n}" specified more than once`);
    }
    seen.add(n);
  }
  const rel: import('../catalog/catalog').Relation = {
    oid: existing?.oid ?? session.db.oids.allocate(),
    name: stmt.view.name,
    nspOid,
    kind: 'v',
    persistence: stmt.temp ? 't' : 'p',
    columns: targets.map((t, i) => newColumn(i + 1, names[i], t.expr.type, t.expr.typmod, t.expr.collation)),
    rowTypeOid: existing?.rowTypeOid ?? 0,
    storageId: 0,
    options: (stmt.options ?? []).map((o) => `${o.name}=${o.value ?? 'true'}`),
    view: { query: stmt.query, text: stmt.queryText, checkOption: stmt.withCheckOption },
    inheritsFrom: [],
    hasTriggers: false,
    populated: true,
  };
  cat.putRelation(rel);
  if (!existing) {
    createRowType(session, cat, rel);
    cat.putRelation(rel);
  }
  return 'CREATE VIEW';
}

function createTableAs(session: Session, stmt: A.CreateTableAsStmt, params: unknown[], paramTypes: number[]): UtilityResult {
  const nspOid = resolveCreationNamespace(session, stmt.relation, stmt.temp);
  const cat = session.ddlCatalog();
  if (cat.findRelationInNamespace(nspOid, stmt.relation.name)) {
    if (stmt.ifNotExists) {
      return { command: stmt.isMaterializedView ? 'CREATE MATERIALIZED VIEW' : 'CREATE TABLE AS' };
    }
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${stmt.relation.name}" already exists`);
  }
  const an = session.makeAnalyzer(paramTypes, true);
  const { query } = analyzeStatementAsSubquery(an, stmt.query, null, true);
  if (stmt.isMaterializedView && an.paramTypes.length > 0) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'materialized views may not be defined using bound parameters');
  }
  const targets = (query.commandType === 'select' ? query.targetList : query.returningList).filter((t) => !t.resjunk);
  const colDefs = targets.map((t, i) => ({
    kind: 'ColumnDef' as const,
    name: stmt.columnNames?.[i] ?? t.name,
    typeName: { kind: 'TypeName' as const, names: ['pg_catalog', cat.getType(t.expr.type)?.name ?? 'text'], typmods: [], arrayBounds: [] },
    constraints: [],
  }));
  createTable(session, {
    kind: 'CreateTableStmt',
    relation: { ...stmt.relation, schema: stmt.relation.schema ?? (stmt.temp ? undefined : cat.namespaceName(nspOid)) },
    temp: stmt.temp,
    unlogged: false,
    ifNotExists: false,
    columns: colDefs,
    constraints: [],
    inherits: [],
  });
  const newCat = session.catalog();
  const rel = newCat.findRelationInNamespace(nspOid, stmt.relation.name)!;
  // fix exact types (arrays / typmods)
  newCat.putRelation({ ...rel, kind: stmt.isMaterializedView ? 'm' : 'r', columns: rel.columns.map((c, i) => ({ ...c, typeOid: targets[i].expr.type, typmod: targets[i].expr.typmod })) });
  if (stmt.isMaterializedView) {
    newCat.putRelation({ ...newCat.getRelation(rel.oid)!, view: { query: stmt.query as A.SelectStmt, text: '' } });
  }
  let count = 0;
  if (stmt.withData) {
    count = populateFromQuery(session, newCat, rel.oid, query, params, an.paramTypes);
  }
  return { command: stmt.isMaterializedView ? 'CREATE MATERIALIZED VIEW' : 'SELECT', rowCount: stmt.isMaterializedView ? undefined : count };
}

function populateFromQuery(session: Session, cat: Catalog, relOid: number, query: Query, params: unknown[] = [], paramTypes: number[] = []): number {
  const ctx = new DdlContext(session, cat, params, paramTypes);
  const res = ctx.executor.executeQuery(query, null);
  const rel = cat.getRelation(relOid)!;
  const heap = session.db.store.getHeap(rel.storageId);
  const xid = session.currentWriteXid();
  for (const row of res.rows) {
    heap.insert(row.slice(), xid, session.txn!.cid);
  }
  return res.rows.length;
}

function refreshMatView(session: Session, stmt: A.RefreshMatViewStmt): string {
  const cat = session.ddlCatalog();
  const rel = lookupTable(session, stmt.relation);
  if (rel.kind !== 'm') {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is not a materialized view`);
  }
  const heap = session.db.store.createHeap();
  session.txn!.createdStorage.push(heap.storageId);
  session.txn!.droppedStorage.push(rel.storageId);
  cat.putRelation({ ...rel, storageId: heap.storageId });
  if (stmt.withData && rel.view) {
    const an = session.makeAnalyzer();
    const { query } = analyzeStatementAsSubquery(an, rel.view.query, null, true);
    populateFromQuery(session, cat, rel.oid, query);
  }
  return 'REFRESH MATERIALIZED VIEW';
}

// ---------------------------------------------------------------------------
// Collations / statistics / comments
// ---------------------------------------------------------------------------

function createCollation(session: Session, stmt: A.CreateCollationStmt): string {
  const cat = session.ddlCatalog();
  const name = stmt.name[stmt.name.length - 1];
  const nspOid = stmt.name.length > 1 ? cat.findNamespace(stmt.name[0])?.oid ?? session.creationNamespace() : session.creationNamespace();
  if (cat.findCollation(nspOid, name)) {
    if (stmt.ifNotExists) {
      return 'CREATE COLLATION';
    }
    throw new PgError(SqlState.DUPLICATE_OBJECT, `collation "${name}" for encoding "UTF8" already exists`);
  }
  let provider = 'c';
  let locale = '';
  let deterministic = true;
  if (stmt.from) {
    const src = cat.findCollation(null, stmt.from[stmt.from.length - 1]);
    if (!src) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${stmt.from.join('.')}" for encoding "UTF8" does not exist`);
    }
    provider = src.provider;
    locale = src.locale ?? '';
    deterministic = src.deterministic;
  }
  for (const o of stmt.options) {
    const v = String(o.value ?? '');
    switch (o.name.toLowerCase()) {
      case 'provider':
        provider = v.toLowerCase() === 'icu' ? 'i' : v.toLowerCase() === 'builtin' ? 'b' : 'c';
        break;
      case 'locale':
      case 'lc_collate':
        locale = v;
        break;
      case 'deterministic':
        deterministic = !(o.value === false || v.toLowerCase() === 'false' || v === 'off');
        break;
    }
  }
  if (!deterministic && provider !== 'i') {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'nondeterministic collations not supported with this provider');
  }
  const oid = session.db.oids.allocate();
  cat.collations.set(oid, { oid, name, nspOid, provider, deterministic, encoding: -1, locale, options: stmt.options });
  cat.invalidate();
  return 'CREATE COLLATION';
}

function createStatistics(session: Session, stmt: A.CreateStatsStmt): string {
  const cat = session.ddlCatalog();
  const rel = lookupTable(session, stmt.relation);
  const name = stmt.name ? stmt.name[stmt.name.length - 1] : chooseRelationName(cat, rel.name, stmt.exprs.map((e) => e.name ?? 'expr').join('_'), 'stat', rel.nspOid, false);
  if ([...cat.statistics.values()].some((s) => s.name === name && s.nspOid === rel.nspOid)) {
    if (stmt.ifNotExists) {
      return 'CREATE STATISTICS';
    }
    throw new PgError(SqlState.DUPLICATE_OBJECT, `statistics object "${name}" already exists`);
  }
  const columns: number[] = [];
  const exprs: { raw: A.Expr; text: string }[] = [];
  for (const e of stmt.exprs) {
    if (e.name) {
      const col = rel.columns.find((c) => !c.isDropped && c.name === e.name);
      if (!col) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${e.name}" does not exist`);
      }
      columns.push(col.attnum);
    } else {
      exprs.push({ raw: e.expr!, text: e.exprText ?? '' });
    }
  }
  if (columns.length + exprs.length < 2 && stmt.kinds.length > 0) {
    throw new PgError(SqlState.INVALID_OBJECT_DEFINITION, 'extended statistics require at least 2 columns');
  }
  const oid = session.db.oids.allocate();
  const kinds = stmt.kinds.length ? stmt.kinds : columns.length + exprs.length >= 2 ? ['ndistinct', 'dependencies', 'mcv'] : [];
  if (exprs.length > 0 && columns.length + exprs.length >= 1) {
    kinds.push('expressions');
  }
  cat.statistics.set(oid, { oid, name, nspOid: rel.nspOid, relOid: rel.oid, kinds: [...new Set(kinds)], columns: columns.sort((a, b) => a - b), exprs, statsTarget: -1 });
  cat.invalidate();
  return 'CREATE STATISTICS';
}

function comment(session: Session, stmt: A.CommentStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  const set = (key: string) => {
    if (stmt.comment === null) {
      cat.comments.delete(key);
    } else {
      cat.comments.set(key, stmt.comment);
    }
    cat.invalidate();
  };
  switch (stmt.objectType) {
    case 'TABLE':
    case 'VIEW':
    case 'INDEX':
    case 'SEQUENCE':
    case 'MATERIALIZED VIEW': {
      const rel = lookupRelation(an, { name: stmt.object[stmt.object.length - 1], schema: stmt.object.length > 1 ? stmt.object[0] : undefined })!;
      set(`1259:${rel.oid}:0`);
      break;
    }
    case 'COLUMN': {
      const relName = stmt.object.slice(0, -1);
      const rel = lookupRelation(an, { name: relName[relName.length - 1], schema: relName.length > 1 ? relName[0] : undefined })!;
      const col = rel.columns.find((c) => c.name === stmt.object[stmt.object.length - 1] && !c.isDropped);
      if (!col) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${stmt.object[stmt.object.length - 1]}" of relation "${rel.name}" does not exist`);
      }
      set(`1259:${rel.oid}:${col.attnum}`);
      break;
    }
    case 'SCHEMA': {
      const ns = cat.findNamespace(stmt.object[0]);
      if (!ns) {
        throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${stmt.object[0]}" does not exist`);
      }
      set(`2615:${ns.oid}:0`);
      break;
    }
    case 'TYPE':
    case 'DOMAIN': {
      const oid = an.types.lookupTypeName({ kind: 'TypeName', names: stmt.object, typmods: [], arrayBounds: [] }, session.relationSearchPath()).oid;
      set(`1247:${oid}:0`);
      break;
    }
    case 'CONSTRAINT': {
      const rel = lookupRelation(an, { name: stmt.columnTable![stmt.columnTable!.length - 1] })!;
      const con = cat.constraintsOf(rel.oid).find((c) => c.name === stmt.object[0]);
      if (!con) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${stmt.object[0]}" for table "${rel.name}" does not exist`);
      }
      set(`2606:${con.oid}:0`);
      break;
    }
    case 'FUNCTION':
    case 'PROCEDURE': {
      const procs = cat.findProcsByName(stmt.object[stmt.object.length - 1]);
      if (procs.length) {
        set(`1255:${procs[0].oid}:0`);
      }
      break;
    }
    case 'DATABASE':
      set(`1262:1:0`);
      break;
    case 'EXTENSION': {
      const ext = [...cat.extensions.values()].find((e) => e.name === stmt.object[0]);
      if (ext) {
        set(`3079:${ext.oid}:0`);
      }
      break;
    }
    default:
      break;
  }
  return 'COMMENT';
}

// ---------------------------------------------------------------------------
// SET / SHOW / misc
// ---------------------------------------------------------------------------

function settingValueText(values: (string | number)[]): string {
  return values.map((v) => String(v)).join(', ');
}

function variableSet(session: Session, stmt: A.VariableSetStmt): string {
  const isLocal = stmt.isLocal;
  switch (stmt.mode) {
    case 'MULTI': {
      const opts = stmt.transactionOptions ?? {};
      if (stmt.name === 'TRANSACTION' && session.txn) {
        if (opts.isolation) {
          session.txn.isolation = opts.isolation;
        }
        if (opts.readOnly !== undefined) {
          session.txn.readOnly = opts.readOnly;
        }
      } else if (stmt.name === 'SESSION CHARACTERISTICS') {
        if (opts.isolation) {
          session.setSetting('default_transaction_isolation', opts.isolation, false);
        }
        if (opts.readOnly !== undefined) {
          session.setSetting('default_transaction_read_only', opts.readOnly ? 'on' : 'off', false);
        }
      }
      return 'SET';
    }
    case 'RESET_ALL':
      session.resetAllSettings();
      return 'RESET';
    case 'RESET':
    case 'DEFAULT':
      session.setSetting(stmt.name, null, isLocal);
      return stmt.mode === 'RESET' ? 'RESET' : 'SET';
    default: {
      let value = settingValueText(stmt.values);
      if (stmt.name === 'search_path') {
        value = stmt.values.map((v) => (typeof v === 'string' && /[^a-z0-9_$]/.test(v) ? `"${v}"` : String(v))).join(', ');
      }
      session.setSetting(stmt.name, value, isLocal);
      return 'SET';
    }
  }
}

function showFields(stmt: A.VariableShowStmt): FieldInfo[] {
  if (stmt.name === 'all') {
    return [textField('name'), textField('setting'), textField('description')];
  }
  const def = settingDef(stmt.name);
  // PG names the column with the canonical spelling of the setting (e.g. "TimeZone")
  return [textField(def ? def.name : stmt.name)];
}

function variableShow(session: Session, stmt: A.VariableShowStmt): UtilityResult {
  const name = stmt.name;
  if (name === 'all') {
    const rows: unknown[][] = [];
    return { command: 'SHOW', fields: showFields(stmt), rows };
  }
  const value = session.getSetting(name, false);
  return { command: 'SHOW', fields: showFields(stmt), rows: [[displaySettingValue(name, value ?? '')]] };
}

/** Row description of a utility statement for the extended protocol's Describe (null = NoData). */
export function describeUtility(session: Session, stmt: A.Statement): FieldInfo[] | null {
  void session;
  switch (stmt.kind) {
    case 'VariableShowStmt':
      return showFields(stmt);
    case 'ExplainStmt':
      return String(stmt.options.find((o) => o.name.toLowerCase() === 'format')?.value ?? '').toLowerCase() === 'json'
        ? [{ ...textField('QUERY PLAN'), typeOid: TypeOid.json }]
        : [textField('QUERY PLAN')];
    default:
      return null;
  }
}

function alterDatabaseSet(session: Session, stmt: A.AlterDatabaseSetStmt): string {
  if (stmt.dbname !== session.databaseName) {
    throw new PgError(SqlState.UNDEFINED_OBJECT, `database "${stmt.dbname}" does not exist`);
  }
  const cat = session.ddlCatalog();
  const s = stmt.set;
  if (s.mode === 'RESET_ALL') {
    cat.dbSettings.clear();
  } else if (s.mode === 'RESET' || s.mode === 'DEFAULT') {
    cat.dbSettings.delete(s.name.toLowerCase());
  } else {
    cat.dbSettings.set(s.name.toLowerCase(), settingValueText(s.values));
  }
  cat.invalidate();
  return 'ALTER DATABASE';
}

function discard(session: Session, tag: string): void {
  if (tag === 'DISCARD ALL' || tag === 'DISCARD PLANS') {
    session.preparedStatements.clear();
  }
  if (tag === 'DISCARD ALL') {
    session.resetAllSettings();
  }
}

/**
 * ExecuteCallStmt. Arguments are evaluated first; the procedure runs non-atomically (COMMIT /
 * ROLLBACK allowed) when called at top level outside a transaction block. INOUT / OUT parameters
 * come back as one result row.
 */
function callProcedure(session: Session, stmt: A.CallStmt, params: unknown[], parentSt: StatementState | null, boundTypes: number[] | undefined, undo: UndoLog | null): UtilityResult {
  const an = session.makeAnalyzer(parentSt ? parentSt.paramTypes.slice() : (boundTypes ?? []).slice(), !!parentSt || !!boundTypes);
  if (parentSt) {
    an.paramNames = parentSt.paramNames;
    an.paramFunctionName = parentSt.functionName;
  }
  const pstate = new ParseState(null, emptyQuery());
  let call = transformProcedureCall(an, pstate, stmt.func);
  while (call.k === 'relabel') {
    call = call.arg;
  }
  if (call.k !== 'func') {
    throw new PgError(SqlState.INTERNAL_ERROR, 'in-memory engine: CALL did not resolve to a procedure');
  }
  const proc = session.catalog().getProc(call.funcOid)!;
  const st = new StatementState(session, session.catalog(), parentSt ? parentSt.params : params, an.paramTypes, session.takeSnapshot());
  st.undo = undo ?? parentSt?.undo ?? null;
  st.depth = parentSt ? parentSt.depth + 1 : 0;
  st.nonAtomic = session.nonAtomicContext(parentSt);
  const host = new SessionHost(session, st);
  const executor = new Executor(st, host);
  host.executor = executor;
  const plan = executor.planFor(pstate.query, null);
  const args = call.args.map((a) => plan.ev(a)(new EvalCtx([], null, st)));
  const out = session.callProcedure(proc, args, call.args.map((a) => a.type), st);
  if (!out) {
    return { command: 'CALL' };
  }
  return { command: 'CALL', fields: out.fields, rows: [out.values], rowCount: 1 };
}

function executePrepared(session: Session, stmt: A.ExecuteStmt): UtilityResult {
  const prep = session.preparedStatements.get(stmt.name);
  if (!prep) {
    throw new PgError(SqlState.INVALID_SQL_STATEMENT_NAME, `prepared statement "${stmt.name}" does not exist`);
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: EXECUTE of SQL-level prepared statements is not supported');
}

function rename(session: Session, stmt: A.RenameStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  switch (stmt.objectType) {
    case 'TABLE':
    case 'INDEX':
    case 'SEQUENCE':
    case 'VIEW': {
      const rel = lookupRelation(an, stmt.relation!, stmt.ifExists);
      if (!rel) {
        return 'ALTER ' + stmt.objectType;
      }
      renameRelation(cat, rel, stmt.newname);
      if (rel.kind === 'i') {
        const con = [...cat.constraints.values()].find((c) => c.indexOid === rel.oid);
        if (con) {
          cat.putConstraint({ ...con, name: stmt.newname });
        }
      }
      return rel.kind === 'i' ? 'ALTER INDEX' : rel.kind === 'S' ? 'ALTER SEQUENCE' : rel.kind === 'v' ? 'ALTER VIEW' : 'ALTER TABLE';
    }
    case 'COLUMN':
    case 'CONSTRAINT':
      return executeAlterTable(session, {
        kind: 'AlterTableStmt',
        relation: stmt.relation!,
        objectType: 'TABLE',
        ifExists: stmt.ifExists,
        only: false,
        cmds: [stmt.objectType === 'COLUMN' ? { kind: 'RENAME_COLUMN', oldName: stmt.subname!, newName: stmt.newname } : { kind: 'RENAME_CONSTRAINT', oldName: stmt.subname!, newName: stmt.newname }],
      });
    case 'SCHEMA': {
      const ns = cat.findNamespace(stmt.object![0]);
      if (!ns) {
        throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${stmt.object![0]}" does not exist`);
      }
      if (cat.findNamespace(stmt.newname)) {
        throw new PgError(SqlState.DUPLICATE_SCHEMA, `schema "${stmt.newname}" already exists`);
      }
      cat.namespaces.set(ns.oid, { ...ns, name: stmt.newname });
      cat.invalidate();
      return 'ALTER SCHEMA';
    }
  }
  return 'ALTER ' + stmt.objectType;
}

export { NS_PG_CATALOG };
