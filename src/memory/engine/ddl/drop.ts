import * as A from '../ast';
import { lookupRelation } from '../analyze/from';
import { Catalog, Relation, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Session } from '../session';
import { relationKindName } from './common';

interface DropCtx {
  session: Session;
  cat: Catalog;
  cascade: boolean;
  notices: string[];
  dropped: Set<number>;
}

function dependencyError(what: string, deps: string[]): PgError {
  return new PgError(SqlState.DEPENDENT_OBJECTS_STILL_EXIST, `cannot drop ${what} because other objects depend on it`, {
    detail: deps.join('\n'),
    hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
  });
}

/** Drop a relation and everything that belongs to it. */
export function dropRelation(ctx: DropCtx, rel: Relation, requested: boolean): void {
  const { cat, session } = ctx;
  if (ctx.dropped.has(rel.oid)) {
    return;
  }
  ctx.dropped.add(rel.oid);
  const kindName = relationKindName(rel.kind);

  // dependents: foreign keys from other tables, views, partitions, inheritance children
  const deps: { text: string; drop: () => void }[] = [];
  if (rel.kind === 'r' || rel.kind === 'p') {
    for (const c of [...cat.constraints.values()]) {
      if (c.type === 'f' && c.fk && c.fk.refRelOid === rel.oid && c.relOid !== rel.oid && !ctx.dropped.has(c.relOid)) {
        const other = cat.getRelation(c.relOid)!;
        deps.push({ text: `constraint ${c.name} on table ${other.name} depends on table ${rel.name}`, drop: () => cat.removeConstraint(c.oid) });
      }
    }
    for (const r of [...cat.relations.values()]) {
      if ((r.parentOid === rel.oid || r.inheritsFrom.includes(rel.oid)) && !ctx.dropped.has(r.oid)) {
        if (r.parentOid === rel.oid) {
          // partitions are dropped automatically
          dropRelation(ctx, r, false);
        } else {
          deps.push({ text: `table ${r.name} depends on table ${rel.name}`, drop: () => dropRelation(ctx, r, false) });
        }
      }
    }
  }
  for (const v of [...cat.relations.values()]) {
    if ((v.kind === 'v' || v.kind === 'm') && v.oid !== rel.oid && !ctx.dropped.has(v.oid) && v.view && viewReferences(v.view.text, rel.name)) {
      deps.push({ text: `view ${v.name} depends on ${kindName} ${rel.name}`, drop: () => dropRelation(ctx, v, false) });
    }
  }
  if (deps.length > 0) {
    if (!ctx.cascade) {
      throw dependencyError(`${kindName} ${rel.name}`, deps.map((d) => d.text));
    }
    for (const d of deps) {
      ctx.notices.push('drop cascades to ' + d.text.replace(/ depends on .*$/, ''));
      d.drop();
    }
  }

  if (rel.kind === 'i' || rel.kind === 'I') {
    const con = [...cat.constraints.values()].find((c) => c.indexOid === rel.oid && (c.type === 'p' || c.type === 'u' || c.type === 'x'));
    if (con && requested) {
      const table = cat.getRelation(con.relOid)!;
      throw new PgError(SqlState.DEPENDENT_OBJECTS_STILL_EXIST, `cannot drop index ${rel.name} because constraint ${con.name} on table ${table.name} requires it`, {
        hint: `You can drop constraint ${con.name} on table ${table.name} instead.`,
      });
    }
  }

  // owned objects
  for (const ix of cat.indexesOf(rel.oid)) {
    ctx.dropped.add(ix.oid);
    cat.removeRelation(ix.oid);
  }
  for (const c of cat.constraintsOf(rel.oid)) {
    cat.removeConstraint(c.oid);
  }
  for (const c of [...cat.constraints.values()]) {
    if (c.type === 'f' && c.fk?.refRelOid === rel.oid) {
      cat.removeConstraint(c.oid);
    }
  }
  for (const s of [...cat.relations.values()]) {
    if (s.kind === 'S' && s.sequence?.ownedBy?.relOid === rel.oid) {
      ctx.dropped.add(s.oid);
      cat.removeRelation(s.oid);
    }
  }
  for (const t of [...cat.triggers.values()]) {
    if (t.relOid === rel.oid) {
      cat.triggers.delete(t.oid);
    }
  }
  for (const st of [...cat.statistics.values()]) {
    if (st.relOid === rel.oid) {
      cat.statistics.delete(st.oid);
    }
  }
  if (rel.rowTypeOid) {
    const t = cat.getType(rel.rowTypeOid);
    if (t) {
      if (t.array) {
        cat.removeType(t.array);
      }
      cat.removeType(t.oid);
    }
  }
  if (rel.storageId) {
    session.txn!.droppedStorage.push(rel.storageId);
  }
  cat.removeRelation(rel.oid);
  cat.invalidate();
}

function viewReferences(viewText: string, relName: string): boolean {
  const re = new RegExp(`(^|[^\\w"])"?${relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?([^\\w"]|$)`, 'i');
  return re.test(viewText);
}

export function dropRelationNow(session: Session, relOid: number): void {
  const cat = session.ddlCatalog();
  const rel = cat.getRelation(relOid);
  if (rel) {
    dropRelation({ session, cat, cascade: true, notices: [], dropped: new Set() }, rel, false);
  }
}

export function executeDrop(session: Session, stmt: A.DropStmt): string {
  const cat = session.ddlCatalog();
  const ctx: DropCtx = { session, cat, cascade: stmt.cascade, notices: [], dropped: new Set() };
  const tag = 'DROP ' + stmt.objectType;
  const an = session.makeAnalyzer();
  switch (stmt.objectType) {
    case 'TABLE':
    case 'VIEW':
    case 'MATERIALIZED VIEW':
    case 'INDEX':
    case 'SEQUENCE':
    case 'FOREIGN TABLE': {
      if (stmt.concurrently && session.txn!.explicit) {
        throw new PgError(SqlState.ACTIVE_SQL_TRANSACTION, 'DROP INDEX CONCURRENTLY cannot run inside a transaction block');
      }
      const rels: Relation[] = [];
      for (const obj of stmt.objects) {
        const rv = { schema: obj.names.length > 1 ? obj.names[obj.names.length - 2] : undefined, name: obj.names[obj.names.length - 1] };
        const rel = lookupRelation(an, rv, true);
        if (!rel) {
          if (stmt.ifExists) {
            continue;
          }
          const kindText = stmt.objectType === 'MATERIALIZED VIEW' ? 'materialized view' : stmt.objectType.toLowerCase();
          if (stmt.objectType === 'TABLE' || stmt.objectType === 'SEQUENCE' || stmt.objectType === 'VIEW') {
            throw new PgError(SqlState.UNDEFINED_TABLE, `${kindText} "${obj.names.join('.')}" does not exist`);
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `${kindText} "${obj.names.join('.')}" does not exist`);
        }
        const expected: Record<string, string[]> = {
          TABLE: ['r', 'p'],
          VIEW: ['v'],
          'MATERIALIZED VIEW': ['m'],
          INDEX: ['i', 'I'],
          SEQUENCE: ['S'],
          'FOREIGN TABLE': ['f'],
        };
        if (!expected[stmt.objectType].includes(rel.kind)) {
          const hint = `Use DROP ${relationKindName(rel.kind).toUpperCase()} to remove a ${relationKindName(rel.kind)}.`;
          throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is not a ${stmt.objectType === 'MATERIALIZED VIEW' ? 'materialized view' : stmt.objectType.toLowerCase()}`, { hint });
        }
        if (rel.isBuiltinCatalog) {
          throw new PgError(SqlState.INSUFFICIENT_PRIVILEGE, `permission denied: "${rel.name}" is a system catalog`);
        }
        rels.push(rel);
      }
      // objects dropped together don't count as dependents of each other
      for (const r of rels) {
        ctx.dropped.add(r.oid);
      }
      for (const r of rels) {
        ctx.dropped.delete(r.oid);
        dropRelation(ctx, r, true);
      }
      return tag;
    }
    case 'TYPE':
    case 'DOMAIN': {
      for (const obj of stmt.objects) {
        let typeOid: number | null = null;
        try {
          typeOid = an.types.lookupTypeName({ kind: 'TypeName', names: obj.names, typmods: [], arrayBounds: [] }, session.relationSearchPath()).oid;
        } catch (e) {
          if (stmt.ifExists) {
            continue;
          }
          throw e;
        }
        const t = cat.getType(typeOid)!;
        if (t.typtype === 'c' && t.relid && cat.getRelation(t.relid)?.kind !== 'c') {
          throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${t.name}" is not a type`);
        }
        if (t.nspOid === 11) {
          throw new PgError(SqlState.DEPENDENT_OBJECTS_STILL_EXIST, `cannot drop type ${t.name} because it is required by the database system`);
        }
        // columns using the type
        const deps: { text: string; rel: Relation; attnum: number }[] = [];
        for (const r of cat.relations.values()) {
          if (r.kind !== 'r' && r.kind !== 'p' && r.kind !== 'v' && r.kind !== 'm') {
            continue;
          }
          for (const c of r.columns) {
            if (!c.isDropped && (c.typeOid === t.oid || c.typeOid === t.array)) {
              deps.push({ text: `column ${c.name} of table ${r.name} depends on type ${t.name}`, rel: r, attnum: c.attnum });
            }
          }
        }
        if (deps.length > 0) {
          if (!stmt.cascade) {
            throw dependencyError(`type ${t.name}`, deps.map((d) => d.text));
          }
          for (const d of deps) {
            const r = cat.getRelation(d.rel.oid)!;
            const col = r.columns[d.attnum - 1];
            cat.putRelation({ ...r, columns: r.columns.map((c) => (c.attnum === col.attnum ? { ...c, isDropped: true, name: `........pg.dropped.${c.attnum}........`, typeOid: 0 } : c)) });
          }
        }
        if (t.array) {
          cat.removeType(t.array);
        }
        if (t.relid) {
          cat.removeRelation(t.relid);
        }
        cat.removeType(t.oid);
      }
      return tag;
    }
    case 'SCHEMA': {
      for (const obj of stmt.objects) {
        const ns = cat.findNamespace(obj.names[0]);
        if (!ns) {
          if (stmt.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${obj.names[0]}" does not exist`);
        }
        const members = [...cat.relations.values()].filter((r) => r.nspOid === ns.oid);
        const types = [...cat.types.values()].filter((t) => t.nspOid === ns.oid && !t.relid && !t.isArray);
        const procs = [...cat.procs.values()].filter((p) => p.nspOid === ns.oid);
        if ((members.length || types.length || procs.length) && !stmt.cascade) {
          throw dependencyError(`schema ${ns.name}`, [
            ...members.filter((m) => m.kind !== 'i' && m.kind !== 'S').map((m) => `${relationKindName(m.kind)} ${m.name} depends on schema ${ns.name}`),
            ...types.map((t) => `type ${t.name} depends on schema ${ns.name}`),
            ...procs.map((p) => `function ${p.name} depends on schema ${ns.name}`),
          ]);
        }
        for (const r of members) {
          if (cat.getRelation(r.oid)) {
            dropRelation({ ...ctx, cascade: true }, r, false);
          }
        }
        for (const t of [...cat.types.values()].filter((x) => x.nspOid === ns.oid)) {
          cat.removeType(t.oid);
        }
        for (const p of procs) {
          cat.removeProc(p.oid);
        }
        cat.namespaces.delete(ns.oid);
        cat.invalidate();
      }
      return tag;
    }
    case 'FUNCTION':
    case 'PROCEDURE':
    case 'ROUTINE':
    case 'AGGREGATE': {
      for (const obj of stmt.objects) {
        const name = obj.names[obj.names.length - 1];
        let candidates = [...cat.procs.values()].filter((p) => p.name === name);
        if (obj.names.length > 1) {
          const ns = cat.findNamespace(obj.names[0]);
          candidates = candidates.filter((p) => p.nspOid === ns?.oid);
        }
        if (obj.args) {
          const argOids = obj.args.map((a) => an.types.lookupTypeName(a, session.relationSearchPath()).oid);
          candidates = candidates.filter((p) => p.argtypes.length === argOids.length && p.argtypes.every((t, i) => t === argOids[i]));
        }
        if (candidates.length === 0) {
          if (stmt.ifExists) {
            continue;
          }
          const argText = obj.args ? `(${obj.args.map((a) => an.types.formatType(an.types.lookupTypeName(a, session.relationSearchPath()).oid, -1, false)).join(', ')})` : '()';
          throw new PgError(SqlState.UNDEFINED_FUNCTION, obj.args ? `function ${obj.names.join('.')}${argText} does not exist` : `could not find a function named "${obj.names.join('.')}"`);
        }
        if (candidates.length > 1 && !obj.args) {
          throw new PgError(SqlState.AMBIGUOUS_FUNCTION, `function name "${obj.names.join('.')}" is not unique`, { hint: 'Specify the argument list to select the function unambiguously.' });
        }
        for (const p of candidates) {
          cat.removeProc(p.oid);
        }
      }
      return tag;
    }
    case 'EXTENSION': {
      for (const obj of stmt.objects) {
        const ext = [...cat.extensions.values()].find((e) => e.name === obj.names[0]);
        if (!ext) {
          if (stmt.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `extension "${obj.names[0]}" does not exist`);
        }
        cat.extensions.delete(ext.oid);
        for (const p of [...cat.procs.values()]) {
          if ((p as { extension?: number }).extension === ext.oid) {
            cat.removeProc(p.oid);
          }
        }
        for (const o of [...cat.operators.values()]) {
          if ((o as { extension?: number }).extension === ext.oid) {
            cat.operators.delete(o.oid);
          }
        }
        cat.invalidate();
      }
      return tag;
    }
    case 'COLLATION': {
      for (const obj of stmt.objects) {
        const c = [...cat.collations.values()].find((x) => x.name === obj.names[obj.names.length - 1]);
        if (!c) {
          if (stmt.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${obj.names.join('.')}" for encoding "UTF8" does not exist`);
        }
        cat.collations.delete(c.oid);
        cat.invalidate();
      }
      return tag;
    }
    case 'STATISTICS': {
      for (const obj of stmt.objects) {
        const s = [...cat.statistics.values()].find((x) => x.name === obj.names[obj.names.length - 1]);
        if (!s) {
          if (stmt.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `statistics object "${obj.names.join('.')}" does not exist`);
        }
        cat.statistics.delete(s.oid);
        cat.invalidate();
      }
      return tag;
    }
    case 'TRIGGER': {
      for (const obj of stmt.objects) {
        const rel = lookupRelation(an, obj.onTable!, stmt.ifExists);
        const trig = rel ? [...cat.triggers.values()].find((t) => t.relOid === rel.oid && t.name === obj.names[0]) : undefined;
        if (!trig) {
          if (stmt.ifExists) {
            continue;
          }
          throw new PgError(SqlState.UNDEFINED_OBJECT, `trigger "${obj.names[0]}" for table "${obj.onTable!.name}" does not exist`);
        }
        cat.triggers.delete(trig.oid);
        if (rel && ![...cat.triggers.values()].some((t) => t.relOid === rel.oid)) {
          cat.putRelation({ ...rel, hasTriggers: false });
        }
        cat.invalidate();
      }
      return tag;
    }
    default:
      return tag;
  }
}

// ---------------------------------------------------------------------------
// TRUNCATE
// ---------------------------------------------------------------------------

export function executeTruncate(session: Session, stmt: A.TruncateStmt): string {
  const cat = session.ddlCatalog();
  const an = session.makeAnalyzer();
  const rels: Relation[] = [];
  for (const rv of stmt.relations) {
    const rel = lookupRelation(an, rv)!;
    if (rel.kind !== 'r' && rel.kind !== 'p') {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel.name}" is not a table`);
    }
    if (!rels.some((r) => r.oid === rel.oid)) {
      rels.push(rel);
    }
  }
  // cascade to referencing tables
  const byOid = new Set(rels.map((r) => r.oid));
  if (stmt.cascade) {
    let added = true;
    while (added) {
      added = false;
      for (const c of cat.constraints.values()) {
        if (c.type === 'f' && c.fk && byOid.has(c.fk.refRelOid) && !byOid.has(c.relOid)) {
          const r = cat.getRelation(c.relOid)!;
          rels.push(r);
          byOid.add(r.oid);
          added = true;
        }
      }
    }
  } else {
    for (const c of cat.constraints.values()) {
      if (c.type === 'f' && c.fk && byOid.has(c.fk.refRelOid) && !byOid.has(c.relOid)) {
        const referencing = cat.getRelation(c.relOid)!;
        const referenced = cat.getRelation(c.fk.refRelOid)!;
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'cannot truncate a table referenced in a foreign key constraint', {
          detail: `Table "${referencing.name}" references "${referenced.name}".`,
          hint: `Truncate table "${referencing.name}" at the same time, or use TRUNCATE ... CASCADE.`,
        });
      }
    }
  }
  const txn = session.txn!;
  const truncateOne = (rel: Relation) => {
    if (rel.kind === 'p') {
      for (const part of [...cat.relations.values()].filter((r) => r.parentOid === rel.oid)) {
        truncateOne(part);
      }
      return;
    }
    const current = cat.getRelation(rel.oid)!;
    const heap = session.db.store.createHeap();
    txn.createdStorage.push(heap.storageId);
    if (current.storageId) {
      txn.droppedStorage.push(current.storageId);
    }
    cat.putRelation({ ...current, storageId: heap.storageId });
    if (stmt.restartIdentity) {
      for (const s of cat.relations.values()) {
        if (s.kind === 'S' && s.sequence?.ownedBy?.relOid === rel.oid) {
          const seq = s.sequence;
          const prev = { lastValue: seq.state.lastValue, isCalled: seq.state.isCalled };
          seq.state.lastValue = seq.start;
          seq.state.isCalled = false;
          txn.onAbort.push(() => {
            seq.state.lastValue = prev.lastValue;
            seq.state.isCalled = prev.isCalled;
          });
        }
      }
    }
  };
  for (const rel of rels) {
    truncateOne(rel);
  }
  void TypeOid;
  return 'TRUNCATE TABLE';
}
