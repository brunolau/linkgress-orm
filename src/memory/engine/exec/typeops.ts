import { Catalog, COLL_C, COLL_POSIX, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { intervalCmpValue, Interval, TimeTz, USECS_PER_DAY, USECS_PER_SEC, ZoneSpec, localToUtcOffset, zoneOffsetAt } from '../types/datetime';
import { compareJsonb, compareUtf8Bytes, jsonbKey, JsonbValue } from '../types/json';
import { PgNumeric } from '../types/numeric';
import { PgBits, PgRecord } from '../types/values';
import { multirangeCmp, PgMultirange, PgRange, rangeCmp, rangeHashKey } from '../types/range';

export type Comparator = (a: unknown, b: unknown) => number;

/** Collation support for text comparisons. */
export class Collations {
  private cache = new Map<number, Comparator>();
  private collator: Intl.Collator | null;

  constructor(
    readonly catalog: () => Catalog,
    /** 'C' for bytewise, otherwise a BCP47 locale for the default collation */
    readonly defaultLocale: string
  ) {
    this.collator = defaultLocale === 'C' || defaultLocale === 'POSIX' ? null : new Intl.Collator(defaultLocale, { sensitivity: 'variant', numeric: false });
  }

  comparator(collation: number): Comparator {
    let c = this.cache.get(collation);
    if (c) {
      return c;
    }
    if (collation === COLL_C || collation === COLL_POSIX || collation === 0 && !this.collator) {
      c = (a, b) => compareUtf8Bytes(a as string, b as string);
    } else if (collation === 100 || collation === 0) {
      c = this.collator ? this.localeComparator(this.collator) : (a, b) => compareUtf8Bytes(a as string, b as string);
    } else {
      const def = this.catalog().getCollation(collation);
      const locale = def?.locale;
      if (!def || def.provider === 'c' || !locale) {
        c = this.collator && def?.provider !== 'c' ? this.localeComparator(this.collator) : (a, b) => compareUtf8Bytes(a as string, b as string);
      } else {
        const nondeterministic = !def.deterministic;
        const opts: Intl.CollatorOptions = { sensitivity: 'variant' };
        const m = /-ks-(level\d)/.exec(locale);
        if (m) {
          opts.sensitivity = m[1] === 'level1' ? 'base' : m[1] === 'level2' ? 'accent' : 'variant';
        }
        let coll: Intl.Collator;
        try {
          coll = new Intl.Collator(locale.replace(/-u-.*$/, '').replace(/@.*$/, '') || 'und', opts);
        } catch {
          coll = new Intl.Collator('en', opts);
        }
        c = nondeterministic ? (a, b) => coll.compare(a as string, b as string) : this.localeComparator(coll);
      }
    }
    this.cache.set(collation, c);
    return c;
  }

  isDeterministic(collation: number): boolean {
    if (collation === 0 || collation === 100 || collation === COLL_C || collation === COLL_POSIX) {
      return true;
    }
    const def = this.catalog().getCollation(collation);
    return !def || def.deterministic;
  }

  private localeComparator(coll: Intl.Collator): Comparator {
    return (a, b) => {
      const x = a as string;
      const y = b as string;
      if (x === y) {
        return 0;
      }
      const r = coll.compare(x, y);
      return r !== 0 ? r : compareUtf8Bytes(x, y);
    };
  }
}

export function compareNumbers(a: number, b: number): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  // NaN handling: NaN is equal to NaN and greater than everything
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) {
    return 0;
  }
  return an ? 1 : -1;
}

function compareBigints(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

function rtrimSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 32) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/** Convert integer-ish values (number | bigint) to a comparable form. */
function intCompare(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = typeof a === 'bigint' ? a : BigInt(a);
  const y = typeof b === 'bigint' ? b : BigInt(b);
  return compareBigints(x, y);
}

export class TypeOps {
  private cmpCache = new Map<string, Comparator>();

  constructor(
    readonly catalog: () => Catalog,
    readonly collations: Collations,
    readonly zone: () => ZoneSpec
  ) {}

  /** Btree comparison for values of the same type. */
  comparator(typeOid: number, collation: number): Comparator {
    const key = typeOid + ':' + collation;
    let c = this.cmpCache.get(key);
    if (!c) {
      c = this.buildComparator(typeOid, collation);
      this.cmpCache.set(key, c);
    }
    return c;
  }

  private buildComparator(typeOid: number, collation: number): Comparator {
    switch (typeOid) {
      case TypeOid.int2:
      case TypeOid.int4:
      case TypeOid.oid:
      case TypeOid.xid:
      case TypeOid.cid:
      case TypeOid.regclass:
      case TypeOid.regtype:
      case TypeOid.regproc:
      case TypeOid.regnamespace:
      case TypeOid.date:
      case TypeOid.timestamp:
      case TypeOid.timestamptz:
      case TypeOid.time:
        return (a, b) => compareNumbers(a as number, b as number);
      case TypeOid.float4:
      case TypeOid.float8:
        return (a, b) => compareNumbers(a as number, b as number);
      case TypeOid.int8:
        return (a, b) => intCompare(a as bigint, b as bigint);
      case TypeOid.numeric:
        return (a, b) => (a as PgNumeric).compare(b as PgNumeric);
      case TypeOid.bool:
        return (a, b) => (a === b ? 0 : a ? 1 : -1);
      case TypeOid.text:
      case TypeOid.varchar:
      case TypeOid.unknown:
        return this.collations.comparator(collation || 100);
      case TypeOid.bpchar: {
        const cmp = this.collations.comparator(collation || 100);
        return (a, b) => cmp(rtrimSpaces(a as string), rtrimSpaces(b as string));
      }
      case TypeOid.name:
        return this.collations.comparator(collation || COLL_C);
      case TypeOid.char:
        return (a, b) => compareUtf8Bytes(a as string, b as string);
      case TypeOid.uuid:
        return (a, b) => ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0);
      case TypeOid.bytea:
        return (a, b) => compareBytes(a as Uint8Array, b as Uint8Array);
      case TypeOid.interval:
        return (a, b) => compareNumbers(intervalCmpValue(a as Interval), intervalCmpValue(b as Interval));
      case TypeOid.timetz:
        return (a, b) => {
          const x = a as TimeTz;
          const y = b as TimeTz;
          const r = compareNumbers(x.us + x.zone * USECS_PER_SEC, y.us + y.zone * USECS_PER_SEC);
          return r !== 0 ? r : compareNumbers(x.zone, y.zone);
        };
      case TypeOid.jsonb: {
        const cmp = this.collations.comparator(100);
        return (a, b) => compareJsonb(a as JsonbValue, b as JsonbValue, (x, y) => cmp(x, y));
      }
      case TypeOid.bit:
      case TypeOid.varbit:
        return (a, b) => {
          const x = (a as PgBits).bits;
          const y = (b as PgBits).bits;
          return x < y ? -1 : x > y ? 1 : 0;
        };
      case TypeOid.int2vector:
      case TypeOid.oidvector:
        return (a, b) => this.compareArrays(a as unknown[], b as unknown[], (x, y) => compareNumbers(x as number, y as number));
      case TypeOid.json:
      case TypeOid.point:
      case TypeOid.xml:
        return () => {
          throw new PgError(SqlState.UNDEFINED_FUNCTION, `could not identify a comparison function for type ${typeOid === TypeOid.json ? 'json' : 'point'}`);
        };
    }
    const t = this.catalog().getType(typeOid);
    if (!t) {
      return (a, b) => genericCompare(a, b);
    }
    if (t.typtype === 'd') {
      return this.comparator(t.baseType, collation);
    }
    if (t.typtype === 'e') {
      return (a, b) => {
        const labels = this.catalog().getType(typeOid)?.enumLabels ?? [];
        const sa = labels.find((l) => l.label === a)?.sortOrder ?? 0;
        const sb = labels.find((l) => l.label === b)?.sortOrder ?? 0;
        return compareNumbers(sa, sb);
      };
    }
    if (t.isArray) {
      const elemCmp = this.comparator(t.elem, collation);
      return (a, b) => this.compareArrays(a as unknown[], b as unknown[], elemCmp);
    }
    if (t.typtype === 'c' || typeOid === TypeOid.record) {
      return (a, b) => this.compareRecords(a as PgRecord, b as PgRecord);
    }
    if (t.typtype === 'r') {
      return (a, b) => Math.sign(rangeCmp(a as PgRange, b as PgRange));
    }
    if (t.typtype === 'm') {
      return (a, b) => Math.sign(multirangeCmp(a as PgMultirange, b as PgMultirange));
    }
    return (a, b) => genericCompare(a, b);
  }

  private compareArrays(a: unknown[], b: unknown[], elemCmp: Comparator): number {
    const fa = flatten(a);
    const fb = flatten(b);
    const n = Math.min(fa.length, fb.length);
    for (let i = 0; i < n; i++) {
      const x = fa[i];
      const y = fb[i];
      if (x === null && y === null) {
        continue;
      }
      if (x === null) {
        return 1;
      }
      if (y === null) {
        return -1;
      }
      const r = elemCmp(x, y);
      if (r !== 0) {
        return r;
      }
    }
    if (fa.length !== fb.length) {
      return fa.length - fb.length;
    }
    // compare dimensions
    const da = dims(a);
    const db = dims(b);
    if (da.length !== db.length) {
      return da.length - db.length;
    }
    for (let i = 0; i < da.length; i++) {
      if (da[i] !== db[i]) {
        return da[i] - db[i];
      }
    }
    return 0;
  }

  compareRecords(a: PgRecord, b: PgRecord): number {
    const n = Math.min(a.values.length, b.values.length);
    for (let i = 0; i < n; i++) {
      const x = a.values[i];
      const y = b.values[i];
      if (x === null && y === null) {
        continue;
      }
      if (x === null || x === undefined) {
        return 1;
      }
      if (y === null || y === undefined) {
        return -1;
      }
      const ta = a.fieldTypes[i] ?? TypeOid.text;
      const r = this.comparator(ta, 100)(x, y);
      if (r !== 0) {
        return r;
      }
    }
    return a.values.length - b.values.length;
  }

  /** Hash key such that values equal under the type's equality operator share the key. */
  hashKey(typeOid: number, v: unknown): unknown {
    if (v === null || v === undefined) {
      return NULL_KEY;
    }
    switch (typeOid) {
      case TypeOid.int2:
      case TypeOid.int4:
      case TypeOid.oid:
      case TypeOid.date:
      case TypeOid.timestamp:
      case TypeOid.timestamptz:
      case TypeOid.time:
      case TypeOid.bool:
      case TypeOid.text:
      case TypeOid.varchar:
      case TypeOid.name:
      case TypeOid.char:
      case TypeOid.uuid:
      case TypeOid.unknown:
        return v;
      case TypeOid.float4:
      case TypeOid.float8: {
        const n = v as number;
        if (Number.isNaN(n)) {
          return 'NaN';
        }
        return n === 0 ? 0 : n;
      }
      case TypeOid.int8:
        return typeof v === 'bigint' ? v : BigInt(v as number);
      case TypeOid.numeric:
        return 'n' + (v as PgNumeric).canonicalKey();
      case TypeOid.bpchar:
        return rtrimSpaces(v as string);
      case TypeOid.bytea:
        return 'b' + Buffer.from(v as Uint8Array).toString('hex');
      case TypeOid.interval:
        return intervalCmpValue(v as Interval);
      case TypeOid.jsonb:
        return 'j' + jsonbKey(v as JsonbValue);
      case TypeOid.timetz:
        return (v as TimeTz).us + ':' + (v as TimeTz).zone;
      case TypeOid.bit:
      case TypeOid.varbit:
        return 'bits:' + (v as PgBits).bits;
      case TypeOid.json:
        throw new PgError(SqlState.UNDEFINED_FUNCTION, 'could not identify an equality operator for type json');
    }
    const t = this.catalog().getType(typeOid);
    if (t) {
      if (t.typtype === 'd') {
        return this.hashKey(t.baseType, v);
      }
      if (t.isArray) {
        return 'a' + JSON.stringify(this.arrayKey(v as unknown[], t.elem));
      }
      if (t.typtype === 'c' || typeOid === TypeOid.record) {
        const r = v as PgRecord;
        return 'r' + JSON.stringify(r.values.map((x, i) => keyToJson(this.hashKey(r.fieldTypes[i] ?? TypeOid.text, x))));
      }
      if (v instanceof PgRange) {
        return rangeHashKey(v, (st, x) => keyToJson(this.hashKey(st, x)));
      }
      if (v instanceof PgMultirange) {
        return 'multirange:' + v.ranges.map((r) => rangeHashKey(r, (st, x) => keyToJson(this.hashKey(st, x)))).join(';');
      }
    }
    if (typeof v === 'object') {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    }
    return v;
  }

  private arrayKey(arr: unknown[], elem: number): unknown {
    return arr.map((x) => (Array.isArray(x) ? this.arrayKey(x, elem) : keyToJson(this.hashKey(elem, x))));
  }

  /** Composite key for multiple columns. */
  multiKey(types: number[], values: unknown[]): unknown {
    if (types.length === 1) {
      return this.hashKey(types[0], values[0]);
    }
    let s = '';
    for (let i = 0; i < types.length; i++) {
      const k = this.hashKey(types[i], values[i]);
      s += typeof k + ':' + (k === NULL_KEY ? 'NULL' : String(k)).length + ':' + (k === NULL_KEY ? 'NULL' : String(k));
    }
    return s;
  }

  /** Convert timestamp (local, no tz) to timestamptz in the session zone. */
  timestampToTz(ts: number): number {
    if (!Number.isFinite(ts)) {
      return ts;
    }
    const off = localToUtcOffset(this.zone(), ts);
    return ts - off * USECS_PER_SEC;
  }

  tzToTimestamp(ts: number): number {
    if (!Number.isFinite(ts)) {
      return ts;
    }
    return ts + zoneOffsetAt(this.zone(), ts) * USECS_PER_SEC;
  }

  /**
   * Cross-type comparison for builtin operator families. Returns null if the pair is not handled.
   */
  crossComparator(left: number, right: number, collation: number): Comparator | null {
    if (left === right) {
      return this.comparator(left, collation);
    }
    const ints = new Set<number>([TypeOid.int2, TypeOid.int4, TypeOid.int8]);
    if (ints.has(left) && ints.has(right)) {
      return (a, b) => intCompare(a as number | bigint, b as number | bigint);
    }
    const floats = new Set<number>([TypeOid.float4, TypeOid.float8]);
    if (floats.has(left) && floats.has(right)) {
      return (a, b) => compareNumbers(a as number, b as number);
    }
    const textish = new Set<number>([TypeOid.text, TypeOid.name, TypeOid.varchar, TypeOid.bpchar]);
    if (textish.has(left) && textish.has(right)) {
      const cmp = this.collations.comparator(collation || 100);
      return (a, b) => cmp(a as string, b as string);
    }
    const dt = new Set<number>([TypeOid.date, TypeOid.timestamp, TypeOid.timestamptz]);
    if (dt.has(left) && dt.has(right)) {
      const toTz = (t: number, v: number): number => {
        if (t === TypeOid.date) {
          const ts = Number.isFinite(v) ? v * USECS_PER_DAY : v;
          return this.timestampToTz(ts);
        }
        if (t === TypeOid.timestamp) {
          return this.timestampToTz(v);
        }
        return v;
      };
      const toTs = (t: number, v: number): number => (t === TypeOid.date ? (Number.isFinite(v) ? v * USECS_PER_DAY : v) : v);
      if (left === TypeOid.timestamptz || right === TypeOid.timestamptz) {
        return (a, b) => compareNumbers(toTz(left, a as number), toTz(right, b as number));
      }
      return (a, b) => compareNumbers(toTs(left, a as number), toTs(right, b as number));
    }
    if ((left === TypeOid.oid || left === TypeOid.regclass) && (right === TypeOid.oid || right === TypeOid.regclass)) {
      return (a, b) => compareNumbers(a as number, b as number);
    }
    return null;
  }
}

export const NULL_KEY = Symbol('null-key');

function keyToJson(k: unknown): unknown {
  if (k === NULL_KEY) {
    return null;
  }
  if (typeof k === 'bigint') {
    return 'i8:' + k.toString();
  }
  return k;
}

function flatten(a: unknown[]): unknown[] {
  if (a.length === 0 || !Array.isArray(a[0])) {
    return a;
  }
  const out: unknown[] = [];
  const rec = (x: unknown[]) => {
    for (const e of x) {
      if (Array.isArray(e)) {
        rec(e);
      } else {
        out.push(e);
      }
    }
  };
  rec(a);
  return out;
}

function dims(a: unknown[]): number[] {
  const out: number[] = [a.length];
  let cur: unknown = a[0];
  while (Array.isArray(cur)) {
    out.push(cur.length);
    cur = cur[0];
  }
  return out;
}

function genericCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return compareNumbers(a, b);
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return intCompare(a as bigint, b as bigint);
  }
  if (a instanceof PgNumeric && b instanceof PgNumeric) {
    return a.compare(b);
  }
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Integer arithmetic with PostgreSQL overflow semantics
// ---------------------------------------------------------------------------

export function checkInt2(v: number): number {
  if (v < -32768 || v > 32767 || Number.isNaN(v)) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'smallint out of range');
  }
  return v;
}

export function checkInt4(v: number): number {
  if (v < -2147483648 || v > 2147483647 || Number.isNaN(v)) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'integer out of range');
  }
  return v;
}

export function checkInt8(v: bigint): bigint {
  if (v < -9223372036854775808n || v > 9223372036854775807n) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'bigint out of range');
  }
  return v;
}

export function toBigInt(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(v as number);
}

export function divisionByZero(): PgError {
  return new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
}

export function checkFloat8(v: number, inputsFinite: boolean): number {
  if (!Number.isFinite(v) && inputsFinite && !Number.isNaN(v)) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: overflow');
  }
  return v;
}

export function checkFloat4(v: number, inputsFinite: boolean): number {
  const f = Math.fround(v);
  if (!Number.isFinite(f) && inputsFinite && !Number.isNaN(v)) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: overflow');
  }
  if (f === 0 && v !== 0 && inputsFinite) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: underflow');
  }
  return f;
}
