import { Relation, TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { quoteIdentifier } from '../../analyze/typeutil';
import { TypeUtil } from '../../analyze/typeutil';
import { arrayLowerBound, withLowerBound } from '../../types/values';
import { unaccentText } from './text-fns';
import { FnImpl } from '../runtime';
import { toBigInt } from '../typeops';

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  for (const w of words) {
    const padded = '  ' + w + ' ';
    const chars = Array.from(padded);
    for (let i = 0; i + 3 <= chars.length; i++) {
      out.add(chars.slice(i, i + 3).join(''));
    }
  }
  return out;
}

function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) {
    return 0;
  }
  let common = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      common++;
    }
  }
  const union = ta.size + tb.size - common;
  return union === 0 ? 0 : Math.fround(common / union);
}

function wordSimilarity(a: string, b: string): number {
  const tb = trigrams(b);
  const words = a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  let best = 0;
  for (const w of words) {
    const tw = trigrams(w);
    let common = 0;
    for (const t of tw) {
      if (tb.has(t)) {
        common++;
      }
    }
    if (tb.size > 0) {
      best = Math.max(best, common / tb.size);
    }
  }
  return Math.fround(best);
}

/** PostgreSQL hash_bytes (Bob Jenkins' lookup3, common/hashfn.c) over UTF-8 bytes. */
export function pgHashBytes(k: Uint8Array): number {
  const rot = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  let len = k.length;
  let a = (0x9e3779b9 + len + 3923095) >>> 0;
  let b = a;
  let c = a;
  const mix = () => {
    a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
  };
  const final = () => {
    c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  };
  const word = (i: number) => (k[i] | (k[i + 1] << 8) | (k[i + 2] << 16) | (k[i + 3] << 24)) >>> 0;
  let p = 0;
  while (len >= 12) {
    a = (a + word(p)) >>> 0;
    b = (b + word(p + 4)) >>> 0;
    c = (c + word(p + 8)) >>> 0;
    mix();
    p += 12;
    len -= 12;
  }
  /* eslint-disable no-fallthrough */
  switch (len) {
    case 11:
      c = (c + (k[p + 10] << 24)) >>> 0;
    case 10:
      c = (c + (k[p + 9] << 16)) >>> 0;
    case 9:
      c = (c + (k[p + 8] << 8)) >>> 0;
    case 8:
      b = (b + (k[p + 7] << 24)) >>> 0;
    case 7:
      b = (b + (k[p + 6] << 16)) >>> 0;
    case 6:
      b = (b + (k[p + 5] << 8)) >>> 0;
    case 5:
      b = (b + k[p + 4]) >>> 0;
    case 4:
      a = (a + (k[p + 3] << 24)) >>> 0;
    case 3:
      a = (a + (k[p + 2] << 16)) >>> 0;
    case 2:
      a = (a + (k[p + 1] << 8)) >>> 0;
    case 1:
      a = (a + k[p]) >>> 0;
  }
  /* eslint-enable no-fallthrough */
  final();
  return c | 0;
}

/** The labels of the enum type an anyenum argument has, in sort order (enum_first & co.). */
function enumLabelsOf(fc: { st: { catalog: { getType(oid: number): { typtype: string; enumLabels?: { label: string; sortOrder: number }[] } | undefined } }; argTypes: number[] }): string[] {
  const t = fc.st.catalog.getType(fc.argTypes[0]);
  if (!t || t.typtype !== 'e') {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'could not determine actual enum type');
  }
  return [...(t.enumLabels ?? [])].sort((x, y) => x.sortOrder - y.sortOrder).map((l) => l.label);
}

const subscriptError = (message: string) => new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, message);

/** Dimensions of a (nested) array value; [] for an empty array. */
function arrayDimsOf(arr: unknown[]): number[] {
  if (arr.length === 0) {
    return [];
  }
  const dims = [arr.length];
  let cur: unknown = arr[0];
  while (Array.isArray(cur)) {
    dims.push(cur.length);
    cur = cur[0];
  }
  return dims;
}

/**
 * UPDATE ... SET col[i] = v / col[l:u] = arr (array_set_element / array_set_slice). `spec` describes the
 * subscripts: 'e' an element subscript, 's' a slice (with the presence of its lower / upper bound as 1/0).
 */
function arrayAssign(container: unknown[] | null, value: unknown, spec: string, bounds: unknown[]): unknown[] {
  const slices = spec.split(',');
  const arr = container ?? [];
  const dims = arrayDimsOf(arr);
  const lb = arrayLowerBound(arr);
  if (slices.every((s) => s === 'e')) {
    const idx = bounds.filter((_, i) => i % 2 === 1).map((b) => {
      if (b === null) {
        throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'array subscript in assignment must not be null');
      }
      return Number(b);
    });
    if (dims.length === 0) {
      let v: unknown = value;
      for (let d = idx.length - 1; d >= 1; d--) {
        v = [v];
      }
      return withLowerBound([v], idx[0]);
    }
    if (idx.length !== dims.length) {
      throw subscriptError('wrong number of array subscripts');
    }
    if (dims.length === 1) {
      const i = idx[0];
      const ub = lb + arr.length - 1;
      const newLb = Math.min(lb, i);
      const newUb = Math.max(ub, i);
      const out: unknown[] = [];
      for (let k = newLb; k <= newUb; k++) {
        out.push(k === i ? value : k >= lb && k <= ub ? arr[k - lb] : null);
      }
      return withLowerBound(out, newLb);
    }
    const copy = (a: unknown[], level: number): unknown[] => {
      const i = idx[level] - (level === 0 ? lb : 1);
      if (i < 0 || i >= a.length) {
        throw subscriptError('array subscript out of range');
      }
      const out = a.slice();
      out[i] = level === dims.length - 1 ? value : copy(a[i] as unknown[], level + 1);
      return out;
    };
    return withLowerBound(copy(arr, 0), lb);
  }
  if (slices.length !== 1 || (dims.length > 1)) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'in-memory engine: assignment to multi-dimensional array slices is not implemented');
  }
  const [hasLower, hasUpper] = [slices[0][1] === '1', slices[0][2] === '1'];
  if (value === null) {
    return withLowerBound(arr.slice(), lb);
  }
  const src = (value as unknown[]).flat(Infinity as 1);
  if ((!hasLower || !hasUpper) && dims.length === 0) {
    throw subscriptError('array slice subscript must provide both boundaries');
  }
  const lower = hasLower ? bounds[0] : lb;
  const upper = hasUpper ? bounds[1] : lb + arr.length - 1;
  if (lower === null || upper === null) {
    throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'array subscript in assignment must not be null');
  }
  const l = Number(lower);
  const u = Number(upper);
  if (u < l) {
    throw subscriptError('upper bound cannot be less than lower bound');
  }
  if (src.length < u - l + 1) {
    throw subscriptError('source array too small');
  }
  const ub = lb + arr.length - 1;
  const newLb = dims.length === 0 ? l : Math.min(lb, l);
  const newUb = dims.length === 0 ? u : Math.max(ub, u);
  const out: unknown[] = [];
  for (let k = newLb; k <= newUb; k++) {
    out.push(k >= l && k <= u ? src[k - l] : dims.length > 0 && k >= lb && k <= ub ? arr[k - lb] : null);
  }
  return withLowerBound(out, newLb);
}

export const SYSTEM_FUNCS: Record<string, FnImpl> = {
  __linkgress_merge_action: (a, fc) => (fc.st.scratch.get('merge-action') as string | undefined) ?? null,
  __linkgress_array_assign:(a) => arrayAssign(a[0] as unknown[] | null, a[1], a[2] as string, a.slice(3)),
  enum_first: (_a, fc) => {
    const labels = enumLabelsOf(fc);
    if (labels.length === 0) {
      throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `enum ${fc.st.catalog.getType(fc.argTypes[0])!.name} contains no values`);
    }
    return labels[0];
  },
  enum_last: (_a, fc) => {
    const labels = enumLabelsOf(fc);
    if (labels.length === 0) {
      throw new PgError(SqlState.OBJECT_NOT_IN_PREREQUISITE_STATE, `enum ${fc.st.catalog.getType(fc.argTypes[0])!.name} contains no values`);
    }
    return labels[labels.length - 1];
  },
  enum_range_all: (_a, fc) => enumLabelsOf(fc),
  enum_range_bounds: (a, fc) => {
    const labels = enumLabelsOf(fc);
    const lo = a[0] === null ? 0 : labels.indexOf(a[0] as string);
    const hi = a[1] === null ? labels.length - 1 : labels.indexOf(a[1] as string);
    return lo < 0 || hi < 0 || lo > hi ? [] : labels.slice(lo, hi + 1);
  },
  hashtext: (a) => pgHashBytes(Buffer.from(a[0] as string, 'utf8')),
  pg_sequence_last_value: (a, fc) => {
    const rel = fc.st.catalog.getRelation(a[0] as number);
    if (!rel || rel.kind !== 'S' || !rel.sequence) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `"${rel?.name ?? a[0]}" is not a sequence`);
    }
    return rel.sequence.state.isCalled ? rel.sequence.state.lastValue : null;
  },
  pg_num_nulls: (a) => a.filter((v) => v === null || v === undefined).length,
  pg_num_nonnulls: (a) => a.filter((v) => v !== null && v !== undefined).length,
  show_config_by_name: (a, fc) => fc.st.session.getSetting(a[0] as string, false),
  show_config_by_name_missing_ok: (a, fc) => fc.st.session.getSetting(a[0] as string, a[1] === true),
  set_config_by_name: (a, fc) => {
    fc.st.session.setSetting(a[0] as string, a[1] as string | null, a[2] === true);
    return fc.st.session.getSetting(a[0] as string, true);
  },
  nextval_oid: (a, fc) => fc.st.session.nextval(a[0] as number),
  currval_oid: (a, fc) => fc.st.session.currval(a[0] as number),
  setval_oid: (a, fc) => fc.st.session.setval(a[0] as number, toBigInt(a[1]), true),
  setval3_oid: (a, fc) => fc.st.session.setval(a[0] as number, toBigInt(a[1]), a[2] === true),
  lastval: (_a, fc) => fc.st.session.lastval(),
  pgsql_version: () => 'PostgreSQL 18.3 (linkgress in-memory engine)',
  current_database: (_a, fc) => fc.st.session.databaseName,
  current_user: (_a, fc) => fc.st.session.userName,
  session_user: (_a, fc) => fc.st.session.userName,
  current_schema: (_a, fc) => {
    const nsps = fc.st.session.searchPathNamespaces();
    for (const n of nsps) {
      const ns = fc.st.catalog.getNamespace(n);
      if (ns && !ns.name.startsWith('pg_temp') && ns.name !== 'pg_catalog') {
        return ns.name;
      }
    }
    return null;
  },
  current_schemas: (a, fc) => {
    const out: string[] = [];
    for (const n of fc.st.session.searchPathNamespaces()) {
      const ns = fc.st.catalog.getNamespace(n);
      if (!ns) {
        continue;
      }
      if (!a[0] && (ns.name === 'pg_catalog' || ns.name.startsWith('pg_temp'))) {
        continue;
      }
      out.push(ns.name);
    }
    return out;
  },
  pg_backend_pid: (_a, fc) => fc.st.session.backendPid,
  pg_current_xact_id: (_a, fc) => BigInt(fc.st.session.currentXid()),
  txid_current: (_a, fc) => BigInt(fc.st.session.currentXid()),
  pg_current_xact_id_if_assigned: (_a, fc) => (fc.st.xid ? BigInt(fc.st.xid) : null),
  txid_current_if_assigned: (_a, fc) => (fc.st.xid ? BigInt(fc.st.xid) : null),
  pg_xact_status: (a, fc) => fc.st.session.txnStatus(Number(a[0])),
  pg_is_in_recovery: () => false,
  pg_postmaster_start_time: (_a, fc) => fc.st.session.transactionTimestamp(),
  pg_conf_load_time: (_a, fc) => fc.st.session.transactionTimestamp(),
  pg_trigger_depth: () => 0,
  pg_encoding_to_char: () => 'UTF8',
  getdatabaseencoding: () => 'UTF8',
  pg_client_encoding: () => 'UTF8',
  pg_get_userbyid: () => 'postgres',
  format_type: (a, fc) => {
    if (a[0] === null) {
      return null;
    }
    const tu = new TypeUtil(fc.st.catalog);
    const t = fc.st.catalog.getType(a[0] as number);
    if (!t) {
      return '???';
    }
    return tu.formatType(a[0] as number, a[1] === null || a[1] === undefined ? -1 : (a[1] as number), a[1] !== null && a[1] !== undefined, false, fc.st.session.searchPathNamespaces());
  },
  pg_typeof: (_a, fc) => fc.argTypes[0],
  pg_get_indexdef: (a, fc) => fc.st.session.catalogFns.indexDef(a[0] as number, 0, false),
  pg_get_indexdef_ext: (a, fc) => fc.st.session.catalogFns.indexDef(a[0] as number, a[1] as number, a[2] === true),
  pg_get_constraintdef: (a, fc) => fc.st.session.catalogFns.constraintDef(a[0] as number, false),
  pg_get_constraintdef_ext: (a, fc) => fc.st.session.catalogFns.constraintDef(a[0] as number, a[1] === true),
  pg_get_viewdef: (a, fc) => fc.st.session.catalogFns.viewDef(a[0] as number, false),
  pg_get_viewdef_ext: (a, fc) => fc.st.session.catalogFns.viewDef(a[0] as number, a[1] === true),
  pg_get_viewdef_wrap: (a, fc) => fc.st.session.catalogFns.viewDef(a[0] as number, true, a[1] as number),
  pg_get_viewdef_name_ext: (a, fc) => {
    const oid = fc.st.session.resolveRelation(a[0] as string);
    return oid === null ? null : fc.st.session.catalogFns.viewDef(oid, a[1] === true);
  },
  pg_get_viewdef_name: (a, fc) => {
    const oid = fc.st.session.resolveRelation(a[0] as string);
    return oid === null ? null : fc.st.session.catalogFns.viewDef(oid, false);
  },
  pg_get_partkeydef: (a, fc) => fc.st.session.catalogFns.partKeyDef(a[0] as number),
  pg_get_statisticsobjdef: (a, fc) => fc.st.session.catalogFns.statisticsObjDef(a[0] as number),
  pg_get_expr: (a, fc) => fc.st.session.catalogFns.expr(a[0], a[1] as number, false),
  pg_get_expr_ext: (a, fc) => fc.st.session.catalogFns.expr(a[0], a[1] as number, a[2] === true),
  pg_get_functiondef: (a, fc) => fc.st.session.catalogFns.functionDef(a[0] as number),
  pg_get_serial_sequence: (a, fc) => fc.st.session.catalogFns.serialSequence(a[0] as string, a[1] as string),
  obj_description: (a, fc) => fc.st.session.catalogFns.objDescription(a[0] as number, (a[1] as string) ?? null),
  obj_description_noname: (a, fc) => fc.st.session.catalogFns.objDescription(a[0] as number, null),
  col_description: (a, fc) => fc.st.session.catalogFns.colDescription(a[0] as number, a[1] as number),
  text_regclass: (a, fc) => {
    const oid = fc.st.session.resolveRelation(a[0] as string);
    if (oid === null) {
      throw new PgError(SqlState.UNDEFINED_TABLE, `relation "${a[0]}" does not exist`);
    }
    return oid;
  },
  to_regclass: (a, fc) => fc.st.session.resolveRelation(a[0] as string),
  to_regtype: (a, fc) => fc.st.session.resolveType(a[0] as string),
  to_regnamespace: (a, fc) => fc.st.catalog.findNamespace((a[0] as string).replace(/^"|"$/g, ''))?.oid ?? null,
  to_regproc: () => null,
  pg_table_is_visible: (a, fc) => {
    const rel = fc.st.catalog.getRelation(a[0] as number);
    if (!rel) {
      return null;
    }
    return fc.st.session.searchPathNamespaces().includes(rel.nspOid);
  },
  pg_type_is_visible: (a, fc) => {
    const t = fc.st.catalog.getType(a[0] as number);
    return t ? fc.st.session.searchPathNamespaces().includes(t.nspOid) : null;
  },
  pg_function_is_visible: () => true,
  has_table_privilege_name: () => true,
  has_table_privilege_name_name: () => true,
  has_table_privilege_name_id: () => true,
  has_table_privilege_id: () => true,
  has_schema_privilege_name: () => true,
  has_schema_privilege_name_name: () => true,
  has_schema_privilege_id: () => true,
  has_database_privilege_name: () => true,
  has_sequence_privilege_name: () => true,
  has_function_privilege_name: () => true,
  has_column_privilege_name_name: () => true,
  has_column_privilege_id_attnum: () => true,
  has_column_privilege_name_attnum: () => true,
  pg_has_role_name: () => true,
  pg_has_role_id_name: () => true,
  pg_relation_size: (a, fc) => BigInt(fc.st.session.relationRowCount(a[0] as number) * 64),
  pg_total_relation_size: (a, fc) => BigInt(fc.st.session.relationRowCount(a[0] as number) * 128 + 8192),
  pg_table_size: (a, fc) => BigInt(fc.st.session.relationRowCount(a[0] as number) * 64),
  pg_indexes_size: () => 16384n,
  pg_database_size_name: () => 8000000n,
  pg_column_size: (a) => (typeof a[0] === 'string' ? Buffer.byteLength(a[0]) + 1 : 4),
  pg_size_pretty: (a) => {
    const n = Number(a[0]);
    if (Math.abs(n) < 10 * 1024) {
      return `${n} bytes`;
    }
    const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let u = -1;
    while (Math.abs(v) >= 10 * 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    return `${Math.round(v)} ${units[u]}`;
  },
  pg_advisory_lock_int8: (a, fc) => {
    fc.st.session.advisoryLock('k' + String(a[0]), false, true, false);
    return '';
  },
  pg_advisory_xact_lock_int8: (a, fc) => {
    fc.st.session.advisoryLock('k' + String(a[0]), false, true, true);
    return '';
  },
  pg_try_advisory_lock_int8: (a, fc) => fc.st.session.advisoryLock('k' + String(a[0]), false, false, false),
  pg_try_advisory_xact_lock_int8: (a, fc) => fc.st.session.advisoryLock('k' + String(a[0]), false, false, true),
  pg_advisory_unlock_int8: (a, fc) => fc.st.session.advisoryUnlock('k' + String(a[0]), false),
  pg_advisory_lock_int4: (a, fc) => {
    fc.st.session.advisoryLock('k' + a[0] + ':' + a[1], false, true, false);
    return '';
  },
  pg_advisory_xact_lock_int4: (a, fc) => {
    fc.st.session.advisoryLock('k' + a[0] + ':' + a[1], false, true, true);
    return '';
  },
  pg_try_advisory_lock_int4: (a, fc) => fc.st.session.advisoryLock('k' + a[0] + ':' + a[1], false, false, false),
  pg_try_advisory_xact_lock_int4: (a, fc) => fc.st.session.advisoryLock('k' + a[0] + ':' + a[1], false, false, true),
  pg_advisory_unlock_int4: (a, fc) => fc.st.session.advisoryUnlock('k' + a[0] + ':' + a[1], false),
  pg_advisory_unlock_all: () => '',
  pg_notify: (a, fc) => {
    fc.st.session.notify(a[0] as string, (a[1] as string) ?? '');
    return '';
  },
  pg_cancel_backend: () => true,
  pg_terminate_backend: () => true,
  pg_stat_reset: () => '',
  inet_server_addr: () => null,
  inet_server_port: () => null,
  pg_input_is_valid: (a, fc) => {
    try {
      const oid = fc.st.session.resolveType(a[1] as string);
      if (oid === null) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `type "${a[1]}" does not exist`);
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../types/io').inputValue(oid, a[0] as string, -1, fc.st.session.io);
      return true;
    } catch (e) {
      if (e instanceof PgError && (e.code.startsWith('22') || e.code === '0A000')) {
        return false;
      }
      throw e;
    }
  },
  quote_ident: (a) => quoteIdentifier(a[0] as string),
  // pg_trgm
  similarity: (a) => similarity(a[0] as string, a[1] as string),
  similarity_op: (a) => similarity(a[0] as string, a[1] as string) >= 0.3,
  similarity_dist: (a) => 1 - similarity(a[0] as string, a[1] as string),
  word_similarity: (a) => wordSimilarity(a[0] as string, a[1] as string),
  word_similarity_op: (a) => wordSimilarity(a[0] as string, a[1] as string) >= 0.6,
  word_similarity_commutator_op: (a) => wordSimilarity(a[1] as string, a[0] as string) >= 0.6,
  strict_word_similarity: (a) => wordSimilarity(a[0] as string, a[1] as string),
  show_trgm: (a) => [...trigrams(a[0] as string)].sort(),
  show_limit: () => Math.fround(0.3),
  set_limit: (a) => a[0],
  unaccent_dict: (a) => unaccentText(a[a.length - 1] as string),
};

/** check_rel_can_be_partition: an existing table/index that is partitioned or is a partition */
const partitionRelation = (fc: Parameters<FnImpl>[1], oid: unknown): Relation | null => {
  const rel = fc.st.catalog.getRelation(Number(oid));
  if (!rel || !['r', 'p', 'i', 'I'].includes(rel.kind)) {
    return null;
  }
  return rel.kind === 'p' || rel.kind === 'I' || rel.parentOid !== undefined ? rel : null;
};

export const SYSTEM_SRFS: Record<string, FnImpl> = {
  pg_listening_channels: () => [],
  pg_get_keywords: () => [],
  pg_partition_ancestors: (a, fc) => {
    const out: number[] = [];
    for (let rel = partitionRelation(fc, a[0]); rel; ) {
      out.push(rel.oid);
      rel = rel.parentOid !== undefined ? fc.st.catalog.getRelation(rel.parentOid) ?? null : null;
    }
    return out;
  },
};

export { TypeOid };
