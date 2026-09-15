import { deserialize, serialize } from 'v8';
import { Catalog } from './catalog/catalog';
import { Database, InMemoryDatabaseOptions } from './database';
import { PgError, SqlState } from './errors';
import { JNULL, JsonbObject } from './types/json';
import { PgNumeric } from './types/numeric';
import { ARRAY_LBOUND, PgBits, PgRecord, withLowerBound } from './types/values';

/**
 * Database snapshots: the committed state (catalog, rows, sequences, oid counter) as a Buffer.
 * Restoring yields an independent database whose rows are frozen (visible to every transaction)
 * and kept in their physical order.
 */

const SNAPSHOT_FORMAT = 1;

const CATALOG_MAPS = ['namespaces', 'types', 'relations', 'constraints', 'procs', 'collations', 'extensions', 'statistics', 'triggers', 'operators', 'dbSettings', 'comments'] as const;

interface SnapshotPayload {
  format: number;
  options: InMemoryDatabaseOptions;
  nextOid: number;
  catalogVersion: number;
  catalog: Record<string, unknown>;
  heaps: [number, unknown[][]][];
}

type Tagged =
  | { __t: 'num'; kind: string; neg: boolean; mag: bigint; scale: number }
  | { __t: 'jo'; keys: string[]; vals: unknown[] }
  | { __t: 'jnull' }
  | { __t: 'rec'; values: unknown[]; typeOid: number; fieldTypes: number[]; fieldNames: string[]; fieldTypmods?: number[] }
  | { __t: 'bits'; bits: string }
  | { __t: 'arr'; lb: number; items: unknown[] };

/** cross-realm checks: v8.deserialize builds objects of the main realm (a Jest test runs in another) */
const isMap = (v: unknown): v is Map<unknown, unknown> => Object.prototype.toString.call(v) === '[object Map]';

/** Replace engine value classes by tagged plain objects (structured clone keeps no prototypes). */
function encode(v: unknown, seen: Map<object, unknown>): unknown {
  if (v === null || typeof v !== 'object') {
    return v;
  }
  if (ArrayBuffer.isView(v)) {
    return v;
  }
  const memo = seen.get(v);
  if (memo !== undefined) {
    return memo;
  }
  let out: unknown;
  if (v === JNULL) {
    out = { __t: 'jnull' };
  } else if (v instanceof PgNumeric) {
    out = { __t: 'num', kind: v.kind, neg: v.neg, mag: v.mag, scale: v.scale };
  } else if (v instanceof JsonbObject) {
    out = { __t: 'jo', keys: v.keys, vals: v.vals.map((x) => encode(x, seen)) };
  } else if (v instanceof PgRecord) {
    out = { __t: 'rec', values: v.values.map((x) => encode(x, seen)), typeOid: v.typeOid, fieldTypes: v.fieldTypes, fieldNames: v.fieldNames, fieldTypmods: v.fieldTypmods };
  } else if (v instanceof PgBits) {
    out = { __t: 'bits', bits: v.bits };
  } else if (isMap(v)) {
    const m = new Map();
    seen.set(v, m);
    for (const [k, x] of v) {
      m.set(k, encode(x, seen));
    }
    return m;
  } else if (Array.isArray(v)) {
    const items: unknown[] = [];
    const lb = (v as unknown as Record<symbol, number | undefined>)[ARRAY_LBOUND];
    out = lb !== undefined && lb !== 1 ? { __t: 'arr', lb, items } : items;
    seen.set(v, out);
    for (const x of v) {
      items.push(encode(x, seen));
    }
    return out;
  } else {
    const o: Record<string, unknown> = {};
    seen.set(v, o);
    const src = v as Record<string, unknown>;
    const isStoredExpr = 'raw' in src && 'text' in src;
    for (const k of Object.keys(src)) {
      if (isStoredExpr && k === 'cache') {
        continue;
      }
      const x = src[k];
      if (typeof x === 'function') {
        continue;
      }
      o[k] = encode(x, seen);
    }
    return o;
  }
  seen.set(v, out);
  return out;
}

function decode(v: unknown, seen: Map<object, unknown>): unknown {
  if (v === null || typeof v !== 'object') {
    return v;
  }
  if (ArrayBuffer.isView(v)) {
    // re-created in this realm so `instanceof Uint8Array` holds for the engine
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  const memo = seen.get(v);
  if (memo !== undefined) {
    return memo;
  }
  if (isMap(v)) {
    const m = new Map();
    seen.set(v, m);
    for (const [k, x] of v) {
      m.set(k, decode(x, seen));
    }
    return m;
  }
  if (Array.isArray(v)) {
    const arr: unknown[] = [];
    seen.set(v, arr);
    for (const x of v) {
      arr.push(decode(x, seen));
    }
    return arr;
  }
  const t = v as Tagged | Record<string, unknown>;
  let out: unknown;
  switch ((t as { __t?: string }).__t) {
    case 'jnull':
      out = JNULL;
      break;
    case 'num': {
      const n = t as Extract<Tagged, { __t: 'num' }>;
      out = Object.assign(Object.create(PgNumeric.prototype), { kind: n.kind, neg: n.neg, mag: n.mag, scale: n.scale });
      break;
    }
    case 'jo': {
      const j = t as Extract<Tagged, { __t: 'jo' }>;
      out = new JsonbObject(j.keys, j.vals.map((x) => decode(x, seen) as never));
      break;
    }
    case 'rec': {
      const r = t as Extract<Tagged, { __t: 'rec' }>;
      out = new PgRecord(r.values.map((x) => decode(x, seen)), r.typeOid, r.fieldTypes, r.fieldNames, r.fieldTypmods);
      break;
    }
    case 'bits':
      out = new PgBits((t as Extract<Tagged, { __t: 'bits' }>).bits);
      break;
    case 'arr': {
      const a = t as Extract<Tagged, { __t: 'arr' }>;
      out = withLowerBound(
        a.items.map((x) => decode(x, seen)),
        a.lb
      );
      break;
    }
    default: {
      const o: Record<string, unknown> = {};
      seen.set(v, o);
      for (const k of Object.keys(t)) {
        o[k] = decode((t as Record<string, unknown>)[k], seen);
      }
      return o;
    }
  }
  seen.set(v, out);
  return out;
}

/** Serialize the committed state of a database. */
export function snapshotDatabase(db: Database): Buffer {
  const store = db.store;
  const txns = store.txns;
  // visible to a transaction starting now: committed rows only
  const snap = { xmax: txns.nextXid, xip: new Set(txns.running), ownXid: 0, curCid: 0 };
  const cat = db.catalog;
  const seen = new Map<object, unknown>();
  // temporary objects belong to sessions and are not part of the database state
  const tempNamespaces = new Set([...cat.namespaces.values()].filter((ns) => ns.ownerSessionId).map((ns) => ns.oid));
  const persistent = <T extends { nspOid: number }>(m: Map<number, T>): Map<number, T> => new Map([...m].filter(([, x]) => !tempNamespaces.has(x.nspOid)));
  const filtered: Record<string, unknown> = {
    ...Object.fromEntries(CATALOG_MAPS.map((n) => [n, cat[n]])),
    namespaces: new Map([...cat.namespaces].filter(([oid]) => !tempNamespaces.has(oid))),
    relations: persistent(cat.relations),
    types: persistent(cat.types),
  };
  const tempRelations = new Set([...cat.relations.values()].filter((r) => tempNamespaces.has(r.nspOid)).map((r) => r.oid));
  filtered.constraints = new Map([...cat.constraints].filter(([, c]) => !tempRelations.has(c.relOid)));
  const catalog: Record<string, unknown> = {};
  for (const name of CATALOG_MAPS) {
    catalog[name] = encode(filtered[name], seen);
  }
  const heaps: [number, unknown[][]][] = [];
  for (const rel of cat.relations.values()) {
    if (!rel.storageId || tempNamespaces.has(rel.nspOid)) {
      continue;
    }
    const heap = store.getHeap(rel.storageId);
    const rows: unknown[][] = [];
    for (const t of heap.tuples) {
      if (store.vis.visible(t, snap)) {
        rows.push(encode(t.data, seen) as unknown[]);
      }
    }
    heaps.push([rel.storageId, rows]);
  }
  const payload: SnapshotPayload = {
    format: SNAPSHOT_FORMAT,
    options: { ...db.options },
    nextOid: db.oids.nextOid,
    catalogVersion: cat.version,
    catalog,
    heaps,
  };
  return serialize(payload);
}

/** Restore a database from snapshotDatabase() output. */
export function restoreDatabase(data: Buffer | Uint8Array, overrides: InMemoryDatabaseOptions = {}): Database {
  const payload = deserialize(Buffer.isBuffer(data) ? data : Buffer.from(data)) as SnapshotPayload;
  if (!payload || payload.format !== SNAPSHOT_FORMAT) {
    throw new PgError(SqlState.DATA_EXCEPTION, 'unsupported in-memory database snapshot format');
  }
  const db = new Database({ ...payload.options, ...overrides });
  const seen = new Map<object, unknown>();
  const cat = new Catalog(db.builtin);
  for (const name of CATALOG_MAPS) {
    (cat as unknown as Record<string, unknown>)[name] = decode(payload.catalog[name], seen);
  }
  cat.version = payload.catalogVersion;
  cat.invalidate();
  db.catalog = cat;
  db.oids.nextOid = payload.nextOid;
  for (const [storageId, rows] of payload.heaps) {
    db.store.restoreHeap(storageId, rows.map((r) => decode(r, seen) as unknown[]));
  }
  return db;
}
