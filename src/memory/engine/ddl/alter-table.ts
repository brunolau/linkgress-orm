import * as A from '../ast';
import { lookupRelation } from '../analyze/from';
import { transformExpr } from '../analyze/expr';
import { addRelationRte } from '../analyze/from';
import { emptyQuery } from '../analyze/nodes';
import { ParseState } from '../analyze/parse-state';
import { Catalog, Column, Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { EvalCtx } from '../exec/runtime';
import { parseExpression } from '../parser-ddl';
import type { Session } from '../session';
import { buildSequenceInfo, chooseConstraintName, chooseRelationName, createSequenceRelation, newColumn, newConstraint } from './common';
import { addCheckConstraint, addForeignKey, addIndexConstraint, lookupTable } from './create-table';
import { dropRelation } from './drop';
import { DdlContext } from './stmt-context';
import { atPosition } from '../analyze/location';

function current(cat: Catalog, oid: number): Relation {
  return cat.getRelation(oid)!;
}

function patchColumn(cat: Catalog, relOid: number, attnum: number, patch: Partial<Column>): void {
  const rel = current(cat, relOid);
  cat.putRelation({ ...rel, columns: rel.columns.map((c) => (c.attnum === attnum ? { ...c, ...patch } : c)) });
}

function findColumn(rel: Relation, name: string): Column {
  const col = rel.columns.find((c) => !c.isDropped && c.name === name);
  if (!col) {
    throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${name}" of relation "${rel.name}" does not exist`);
  }
  return col;
}

export function executeAlterTable(session: Session, stmt: A.AlterTableStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  const found = lookupRelation(an, stmt.relation, stmt.ifExists);
  const tag = 'ALTER ' + stmt.objectType;
  if (!found) {
    return tag;
  }
  const relOid = found.oid;
  if (stmt.objectType === 'TABLE' && found.kind !== 'r' && found.kind !== 'p' && !stmt.cmds.every((c) => c.kind === 'SET_OPTIONS' || c.kind === 'RESET_OPTIONS' || c.kind === 'OWNER_TO')) {
    if (found.kind === 'v') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${found.name}" is not a table`, { hint: 'Use ALTER VIEW instead.' });
    }
  }
  const ctx = new DdlContext(session, cat);
  for (const cmd of stmt.cmds) {
    const rel = current(cat, relOid);
    ctx.st.scratch.clear();
    switch (cmd.kind) {
      case 'ADD_COLUMN': {
        const def = cmd.def;
        if (rel.columns.some((c) => !c.isDropped && c.name === def.name)) {
          if (cmd.ifNotExists) {
            continue;
          }
          throw new PgError(SqlState.DUPLICATE_COLUMN, `column "${def.name}" of relation "${rel.name}" already exists`);
        }
        const SERIALS: Record<string, number> = { serial: TypeOid.int4, serial4: TypeOid.int4, bigserial: TypeOid.int8, serial8: TypeOid.int8, smallserial: TypeOid.int2, serial2: TypeOid.int2 };
        const serialType = def.typeName.names.length === 1 ? SERIALS[def.typeName.names[0]] : undefined;
        let typeOid: number;
        let typmod = -1;
        if (serialType) {
          typeOid = serialType;
        } else {
          const r = atPosition(def.typeName.loc, () => an.types.lookupTypeName(def.typeName, session.relationSearchPath()));
          typeOid = r.oid;
          typmod = r.typmod;
        }
        const col = newColumn(rel.columns.length + 1, def.name, typeOid, typmod, an.typeCollation(typeOid));
        const tuplesExist = ctx.visibleTuples(rel).length > 0;
        let checks: A.ColumnConstraint[] = [];
        for (const c of def.constraints) {
          switch (c.kind) {
            case 'NOT_NULL':
              col.notNull = true;
              break;
            case 'DEFAULT':
              col.defaultExpr = { raw: c.expr, text: '' };
              break;
            case 'IDENTITY':
              col.identity = c.always ? 'a' : 'd';
              col.notNull = true;
              break;
            case 'GENERATED':
              col.generated = 's';
              col.defaultExpr = { raw: c.expr, text: c.exprText };
              break;
            default:
              checks.push(c);
          }
        }
        if (def.collate) {
          const coll = cat.findCollation(null, def.collate[def.collate.length - 1]);
          if (!coll) {
            throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${def.collate.join('.')}" for encoding "UTF8" does not exist`);
          }
          col.collation = coll.oid;
        }
        cat.putRelation({ ...rel, columns: [...rel.columns, col] });
        if (serialType) {
          const seqName = chooseRelationName(cat, rel.name, col.name, 'seq', rel.nspOid, false);
          const info = buildSequenceInfo(session, [{ name: 'as', typeName: { kind: 'TypeName', names: ['pg_catalog', serialType === TypeOid.int2 ? 'int2' : serialType === TypeOid.int4 ? 'int4' : 'int8'], typmods: [], arrayBounds: [] } }]);
          const seq = createSequenceRelation(session, cat, seqName, rel.nspOid, info, rel.persistence);
          info.ownedBy = { relOid, attnum: col.attnum, identity: false };
          const text = `nextval('${seq.name}'::regclass)`;
          patchColumn(cat, relOid, col.attnum, { defaultExpr: { raw: parseExpression(text), text }, notNull: true });
        }
        if (col.identity) {
          const identity = def.constraints.find((c) => c.kind === 'IDENTITY') as Extract<A.ColumnConstraint, { kind: 'IDENTITY' }>;
          const seqName = chooseRelationName(cat, rel.name, col.name, 'seq', rel.nspOid, false);
          const info = buildSequenceInfo(session, identity.seqOptions, undefined, col.typeOid);
          const seq = createSequenceRelation(session, cat, seqName, rel.nspOid, info, rel.persistence);
          info.ownedBy = { relOid, attnum: col.attnum, identity: true };
          patchColumn(cat, relOid, col.attnum, { identitySeqOid: seq.oid });
        }
        // existing rows get the default (fast default for non-volatile defaults, rewrite otherwise)
        const updatedRel = current(cat, relOid);
        const newCol = updatedRel.columns[col.attnum - 1];
        if (newCol.generated && newCol.defaultExpr) {
          ctx.host.analyzeRelationExpr(updatedRel, newCol.defaultExpr, 'generated');
        }
        if (tuplesExist && (newCol.defaultExpr || newCol.identity)) {
          fillNewColumn(session, cat, ctx, updatedRel, newCol);
        }
        if (newCol.notNull) {
          if (tuplesExist && !newCol.defaultExpr && !newCol.identity) {
            throw new PgError(SqlState.NOT_NULL_VIOLATION, `column "${newCol.name}" of relation "${rel.name}" contains null values`, { table: rel.name, column: newCol.name });
          }
          const cname = chooseConstraintName(cat, rel.name, newCol.name, 'not_null', rel.nspOid, []);
          cat.putConstraint(newConstraint(session, { name: cname, nspOid: rel.nspOid, type: 'n', relOid, columns: [newCol.attnum] }));
        }
        for (const c of checks) {
          ctx.st.scratch.clear();
          if (c.kind === 'CHECK') {
            addCheckConstraint(session, cat, current(cat, relOid), { name: c.name, expr: c.expr, text: c.exprText, noInherit: !!c.noInherit }, ctx, [], true);
          } else if (c.kind === 'PRIMARY_KEY' || c.kind === 'UNIQUE') {
            addIndexConstraint(session, cat, current(cat, relOid), c.kind, c.name, [def.name], c.kind === 'UNIQUE' && !!c.nullsNotDistinct, c.options, ctx);
          } else if (c.kind === 'REFERENCES') {
            addForeignKey(session, cat, current(cat, relOid), { name: c.name, columns: [def.name], fk: c.fk }, ctx, true);
          }
        }
        checks = [];
        break;
      }
      case 'DROP_COLUMN': {
        const col = rel.columns.find((c) => !c.isDropped && c.name === cmd.name);
        if (!col) {
          if (cmd.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${cmd.name}" of relation "${rel.name}" does not exist`);
        }
        // indexes / constraints on the column
        for (const ix of cat.indexesOf(relOid)) {
          if (ix.index!.keys.some((k) => k.attnum === col.attnum || (k.expr && exprMentions(k.expr.text, col.name))) || ix.index!.include.includes(col.attnum)) {
            dropRelation({ session, cat, cascade: true, notices: [], dropped: new Set() }, ix, false);
          }
        }
        for (const c of cat.constraintsOf(relOid)) {
          if (c.columns.includes(col.attnum)) {
            if (c.indexOid && cat.getRelation(c.indexOid)) {
              cat.removeRelation(c.indexOid);
            }
            cat.removeConstraint(c.oid);
          }
        }
        for (const c of [...cat.constraints.values()]) {
          if (c.type === 'f' && c.fk?.refRelOid === relOid && c.fk.refColumns.includes(col.attnum)) {
            if (!cmd.cascade) {
              const other = cat.getRelation(c.relOid)!;
              throw new PgError(SqlState.DEPENDENT_OBJECTS_STILL_EXIST, `cannot drop column ${col.name} of table ${rel.name} because other objects depend on it`, {
                detail: `constraint ${c.name} on table ${other.name} depends on column ${col.name} of table ${rel.name}`,
                hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
              });
            }
            cat.removeConstraint(c.oid);
          }
        }
        for (const s of [...cat.relations.values()]) {
          if (s.kind === 'S' && s.sequence?.ownedBy?.relOid === relOid && s.sequence.ownedBy.attnum === col.attnum) {
            cat.removeRelation(s.oid);
          }
        }
        patchColumn(cat, relOid, col.attnum, { isDropped: true, name: `........pg.dropped.${col.attnum}........`, notNull: false, defaultExpr: undefined, identity: '', generated: '' });
        break;
      }
      case 'ALTER_COLUMN_TYPE':
        alterColumnType(session, cat, ctx, rel, cmd);
        break;
      case 'SET_DEFAULT': {
        const col = findColumn(rel, cmd.name);
        if (col.identity) {
          throw new PgError(SqlState.SYNTAX_ERROR, `column "${col.name}" of relation "${rel.name}" is an identity column`, { hint: 'Use ALTER TABLE ... ALTER COLUMN ... DROP IDENTITY instead.' });
        }
        patchColumn(cat, relOid, col.attnum, { defaultExpr: { raw: cmd.expr, text: '' } });
        ctx.host.analyzeDefault(current(cat, relOid), current(cat, relOid).columns[col.attnum - 1]);
        break;
      }
      case 'DROP_DEFAULT': {
        const col = findColumn(rel, cmd.name);
        patchColumn(cat, relOid, col.attnum, { defaultExpr: undefined });
        break;
      }
      case 'SET_NOT_NULL': {
        const col = findColumn(rel, cmd.name);
        if (col.notNull) {
          break;
        }
        for (const { tuple } of ctx.visibleTuples(rel)) {
          const v = col.attnum - 1 < tuple.data.length ? tuple.data[col.attnum - 1] : col.hasMissing ? col.missingValue : null;
          if (v === null || v === undefined) {
            throw new PgError(SqlState.NOT_NULL_VIOLATION, `column "${col.name}" of relation "${rel.name}" contains null values`, { table: rel.name, column: col.name });
          }
        }
        patchColumn(cat, relOid, col.attnum, { notNull: true });
        const cname = chooseConstraintName(cat, rel.name, col.name, 'not_null', rel.nspOid, []);
        cat.putConstraint(newConstraint(session, { name: cname, nspOid: rel.nspOid, type: 'n', relOid, columns: [col.attnum] }));
        break;
      }
      case 'DROP_NOT_NULL': {
        const col = findColumn(rel, cmd.name);
        if (cat.constraintsOf(relOid).some((c) => c.type === 'p' && c.columns.includes(col.attnum))) {
          throw new PgError(SqlState.INVALID_TABLE_DEFINITION, `column "${col.name}" is in a primary key`);
        }
        if (col.identity) {
          throw new PgError(SqlState.SYNTAX_ERROR, `column "${col.name}" of relation "${rel.name}" is an identity column`);
        }
        patchColumn(cat, relOid, col.attnum, { notNull: false });
        for (const c of cat.constraintsOf(relOid)) {
          if (c.type === 'n' && c.columns[0] === col.attnum) {
            cat.removeConstraint(c.oid);
          }
        }
        break;
      }
      case 'ADD_IDENTITY': {
        const col = findColumn(rel, cmd.name);
        if (col.identity) {
          throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `column "${col.name}" of relation "${rel.name}" is already an identity column`);
        }
        if (col.defaultExpr) {
          throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `column "${col.name}" of relation "${rel.name}" already has a default value`);
        }
        const seqName = chooseRelationName(cat, rel.name, col.name, 'seq', rel.nspOid, false);
        const info = buildSequenceInfo(session, cmd.seqOptions, undefined, col.typeOid);
        const seq = createSequenceRelation(session, cat, seqName, rel.nspOid, info, rel.persistence);
        info.ownedBy = { relOid, attnum: col.attnum, identity: true };
        patchColumn(cat, relOid, col.attnum, { identity: cmd.always ? 'a' : 'd', identitySeqOid: seq.oid, notNull: true });
        break;
      }
      case 'SET_IDENTITY': {
        const col = findColumn(rel, cmd.name);
        if (!col.identity) {
          throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `column "${col.name}" of relation "${rel.name}" is not an identity column`);
        }
        if (cmd.always !== undefined) {
          patchColumn(cat, relOid, col.attnum, { identity: cmd.always ? 'a' : 'd' });
        }
        if (cmd.seqOptions.length && col.identitySeqOid) {
          const seq = cat.getRelation(col.identitySeqOid)!;
          cat.putRelation({ ...seq, sequence: buildSequenceInfo(session, cmd.seqOptions, seq.sequence) });
        }
        break;
      }
      case 'DROP_IDENTITY': {
        const col = rel.columns.find((c) => !c.isDropped && c.name === cmd.name);
        if (!col || !col.identity) {
          if (cmd.ifExists) {
            break;
          }
          throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `column "${cmd.name}" of relation "${rel.name}" is not an identity column`);
        }
        if (col.identitySeqOid) {
          cat.removeRelation(col.identitySeqOid);
        }
        patchColumn(cat, relOid, col.attnum, { identity: '', identitySeqOid: undefined });
        break;
      }
      case 'ADD_CONSTRAINT': {
        const c = cmd.constraint;
        if (c.name && cat.constraintsOf(relOid).some((x) => x.name === c.name)) {
          if (cmd.ifNotExists) {
            break;
          }
          throw new PgError(SqlState.DUPLICATE_OBJECT, `constraint "${c.name}" for relation "${rel.name}" already exists`);
        }
        switch (c.kind) {
          case 'PRIMARY_KEY':
          case 'UNIQUE':
            addIndexConstraint(session, cat, rel, c.kind, c.name, c.columns, c.kind === 'UNIQUE' && !!c.nullsNotDistinct, c.options, ctx);
            break;
          case 'CHECK':
            addCheckConstraint(session, cat, rel, { name: c.name, expr: c.expr, text: c.exprText, noInherit: !!c.noInherit, notValid: c.notValid }, ctx, [], true);
            break;
          case 'FOREIGN_KEY':
            addForeignKey(session, cat, rel, { name: c.name, columns: c.columns, fk: c.fk, notValid: c.notValid }, ctx, true);
            break;
          default:
            throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: EXCLUDE constraints are not supported');
        }
        break;
      }
      case 'DROP_CONSTRAINT': {
        const con = cat.constraintsOf(relOid).find((c) => c.name === cmd.name);
        if (!con) {
          if (cmd.ifExists) {
            break;
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${cmd.name}" of relation "${rel.name}" does not exist`);
        }
        if (con.type === 'p' || con.type === 'u') {
          const deps = [...cat.constraints.values()].filter((f) => f.type === 'f' && f.fk?.refRelOid === relOid && f.indexOid === con.indexOid);
          if (deps.length > 0 && !cmd.cascade) {
            throw new PgError(SqlState.DEPENDENT_OBJECTS_STILL_EXIST, `cannot drop constraint ${con.name} on table ${rel.name} because other objects depend on it`, {
              detail: deps.map((d) => `constraint ${d.name} on table ${cat.getRelation(d.relOid)!.name} depends on index ${con.name}`).join('\n'),
              hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
            });
          }
          for (const d of deps) {
            cat.removeConstraint(d.oid);
          }
          if (con.indexOid) {
            cat.removeRelation(con.indexOid);
          }
        }
        cat.removeConstraint(con.oid);
        break;
      }
      case 'VALIDATE_CONSTRAINT': {
        const con = cat.constraintsOf(relOid).find((c) => c.name === cmd.name);
        if (!con) {
          throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${cmd.name}" of relation "${rel.name}" does not exist`);
        }
        cat.putConstraint({ ...con, validated: true });
        break;
      }
      case 'RENAME_COLUMN': {
        const col = findColumn(rel, cmd.oldName);
        if (rel.columns.some((c) => !c.isDropped && c.name === cmd.newName)) {
          throw new PgError(SqlState.DUPLICATE_COLUMN, `column "${cmd.newName}" of relation "${rel.name}" already exists`);
        }
        patchColumn(cat, relOid, col.attnum, { name: cmd.newName });
        break;
      }
      case 'RENAME_CONSTRAINT': {
        const con = cat.constraintsOf(relOid).find((c) => c.name === cmd.oldName);
        if (!con) {
          throw new PgError(SqlState.UNDEFINED_OBJECT, `constraint "${cmd.oldName}" for table "${rel.name}" does not exist`);
        }
        cat.putConstraint({ ...con, name: cmd.newName });
        if (con.indexOid) {
          const ix = cat.getRelation(con.indexOid);
          if (ix) {
            cat.putRelation({ ...ix, name: cmd.newName });
          }
        }
        break;
      }
      case 'RENAME_TABLE':
        renameRelation(cat, rel, cmd.newName);
        break;
      case 'SET_SCHEMA': {
        const ns = cat.findNamespace(cmd.schema);
        if (!ns) {
          throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${cmd.schema}" does not exist`);
        }
        cat.putRelation({ ...rel, nspOid: ns.oid });
        for (const ix of cat.indexesOf(relOid)) {
          cat.putRelation({ ...ix, nspOid: ns.oid });
        }
        if (rel.rowTypeOid) {
          const t = cat.getType(rel.rowTypeOid)!;
          cat.putType({ ...t, nspOid: ns.oid });
        }
        break;
      }
      case 'SET_OPTIONS': {
        const opts = rel.options.filter((o) => !cmd.options.some((n) => o.startsWith(n.name + '=')));
        for (const o of cmd.options) {
          opts.push(`${o.name}=${o.value ?? 'true'}`);
        }
        cat.putRelation({ ...rel, options: opts });
        break;
      }
      case 'RESET_OPTIONS':
        cat.putRelation({ ...rel, options: rel.options.filter((o) => !cmd.options.some((n) => o.startsWith(n.name + '='))) });
        break;
      case 'SET_STATISTICS': {
        const col = findColumn(rel, cmd.name);
        patchColumn(cat, relOid, col.attnum, { statsTarget: cmd.value });
        break;
      }
      case 'SET_STORAGE':
      case 'SET_COMPRESSION':
      case 'SET_COLUMN_OPTIONS':
      case 'OWNER_TO':
      case 'SET_LOGGED':
      case 'NOOP':
      case 'REPLICA_IDENTITY':
      case 'CLUSTER_ON':
      case 'ROW_LEVEL_SECURITY':
        break;
      case 'ENABLE_TRIGGER':
        break;
      case 'ATTACH_PARTITION': {
        const part = lookupTable(session, cmd.partition);
        cat.putRelation({ ...part, parentOid: relOid, partitionBound: cmd.bound });
        break;
      }
      case 'DETACH_PARTITION': {
        const part = lookupTable(session, cmd.partition);
        cat.putRelation({ ...part, parentOid: undefined, partitionBound: undefined });
        break;
      }
      case 'DROP_EXPRESSION': {
        const col = findColumn(rel, cmd.name);
        patchColumn(cat, relOid, col.attnum, { generated: '', defaultExpr: undefined });
        break;
      }
      default:
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: ALTER TABLE ${(cmd as { kind: string }).kind} is not supported`);
    }
  }
  return tag;
}

function exprMentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^\\w])"?${name}"?([^\\w]|$)`).test(text);
}

export function renameRelation(cat: Catalog, rel: Relation, newName: string): void {
  if (cat.findRelationInNamespace(rel.nspOid, newName)) {
    throw new PgError(SqlState.DUPLICATE_TABLE, `relation "${newName}" already exists`);
  }
  cat.putRelation({ ...rel, name: newName });
  if (rel.rowTypeOid) {
    const t = cat.getType(rel.rowTypeOid);
    if (t) {
      cat.putType({ ...t, name: newName });
      if (t.array) {
        const arr = cat.getType(t.array);
        if (arr) {
          cat.putType({ ...arr, name: '_' + newName });
        }
      }
    }
  }
}

function fillNewColumn(session: Session, cat: Catalog, ctx: DdlContext, rel: Relation, col: Column): void {
  ctx.st.scratch.clear();
  let valueFor: () => unknown;
  let constant = true;
  if (col.identity) {
    constant = false;
    valueFor = () => {
      const v = session.nextval(col.identitySeqOid!);
      return col.typeOid === TypeOid.int8 ? v : Number(v);
    };
  } else {
    const { q, expr } = ctx.host.analyzeDefault(rel, col);
    const plan = ctx.executor.planFor(q, null);
    const ev = plan.ev(expr);
    constant = !containsVolatileCall(expr);
    valueFor = () => ev(new EvalCtx([], null, ctx.st));
  }
  if (constant) {
    const value = valueFor();
    // fast default: tuples shorter than the new column count read the missing value
    const cur = current(cat, rel.oid);
    cat.putRelation({ ...cur, columns: cur.columns.map((c) => (c.attnum === col.attnum ? { ...c, hasMissing: true, missingValue: value } : c)) });
    return;
  }
  rewriteTable(session, cat, ctx, rel, (data) => {
    const out = data.slice();
    while (out.length < col.attnum - 1) {
      out.push(null);
    }
    out[col.attnum - 1] = valueFor();
    return out;
  });
}

function containsVolatileCall(e: import('../analyze/nodes').TExpr): boolean {
  let found = false;
  const visit = (x: import('../analyze/nodes').TExpr) => {
    if (x.k === 'func' && (x.funcName === 'nextval' || x.funcName === 'random' || x.funcName === 'gen_random_uuid' || x.funcName === 'clock_timestamp' || x.funcName === 'uuidv4' || x.funcName === 'uuidv7' || x.isUser)) {
      found = true;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../analyze/walk').forEachChild(x, visit);
  };
  visit(e);
  return found;
}

/** Copy visible rows into a new heap applying `transform` (table rewrite). */
export function rewriteTable(session: Session, cat: Catalog, ctx: DdlContext, rel: Relation, transform: (data: unknown[]) => unknown[]): void {
  const cur = current(cat, rel.oid);
  if (!cur.storageId) {
    return;
  }
  const txn = session.txn!;
  const xid = session.currentWriteXid();
  const heap = session.db.store.createHeap();
  txn.createdStorage.push(heap.storageId);
  for (const { tuple } of ctx.visibleTuples(cur)) {
    heap.insert(transform(tuple.data), xid, txn.cid);
  }
  txn.droppedStorage.push(cur.storageId);
  cat.putRelation({ ...cur, storageId: heap.storageId });
}

function alterColumnType(session: Session, cat: Catalog, ctx: DdlContext, rel: Relation, cmd: Extract<A.AlterTableCmd, { kind: 'ALTER_COLUMN_TYPE' }>): void {
  const col = findColumn(rel, cmd.name);
  const an = session.makeAnalyzer();
  const { oid: newType, typmod } = an.types.lookupTypeName(cmd.typeName, session.relationSearchPath());
  // build conversion expression over the relation
  const q = emptyQuery();
  const pstate = new ParseState(null, q);
  const rtIndex = addRelationRte(an, pstate, rel, undefined, false, rel.name);
  pstate.namespace.push({ rtIndex, rte: q.rtable[rtIndex], relVisible: true, colsVisible: true, lateralOnly: false, lateralOk: true });
  let expr = cmd.using ? transformExpr(an, pstate, cmd.using, 'alter_col_transform') : transformExpr(an, pstate, { kind: 'ColumnRef', fields: [col.name] }, 'alter_col_transform');
  const coerced = an.coerceToTargetType(expr, newType, typmod, 'assignment', 'implicit_cast');
  if (!coerced) {
    throw new PgError(SqlState.DATATYPE_MISMATCH, `column "${col.name}" cannot be cast automatically to type ${an.types.formatType(newType, typmod, false)}`, {
      hint: `You might need to specify "USING ${col.name}::${an.types.formatType(newType, typmod, false)}".`,
    });
  }
  expr = coerced;
  // default must also convert
  let newDefault = col.defaultExpr;
  if (col.defaultExpr) {
    try {
      const d = transformExpr(an, new ParseState(null, emptyQuery()), col.defaultExpr.raw, 'column_default');
      if (!an.coerceToTargetType(d, newType, typmod, 'assignment', 'implicit_cast')) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, `default for column "${col.name}" cannot be cast automatically to type ${an.types.formatType(newType, typmod, false)}`);
      }
    } catch (e) {
      if (e instanceof PgError && e.code === SqlState.DATATYPE_MISMATCH) {
        throw e;
      }
      newDefault = col.defaultExpr;
    }
  }
  const plan = ctx.executor.planFor(q, null);
  const ev = plan.ev(expr);
  const collation = cmd.collate ? cat.findCollation(null, cmd.collate[cmd.collate.length - 1])?.oid ?? col.collation : an.typeCollation(newType) ? (col.typeOid === newType ? col.collation : an.typeCollation(newType)) : 0;
  rewriteTable(session, cat, ctx, rel, (data) => {
    const out = data.slice();
    while (out.length < rel.columns.length) {
      const c = rel.columns[out.length];
      out.push(c.hasMissing ? c.missingValue : null);
    }
    out[col.attnum - 1] = ev(new EvalCtx([data, null], null, ctx.st));
    return out;
  });
  const cur = current(cat, rel.oid);
  cat.putRelation({
    ...cur,
    columns: cur.columns.map((c) => (c.attnum === col.attnum ? { ...c, typeOid: newType, typmod, collation, hasMissing: false, missingValue: null, defaultExpr: newDefault } : c)),
  });
  // re-validate unique indexes over the rewritten data
  ctx.st.scratch.clear();
}
