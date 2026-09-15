import { TypeOid } from '../catalog/catalog';
import type { TypeOps } from '../exec/typeops';
import { PgNumeric } from './numeric';

/**
 * PostgreSQL's extended (64-bit, seeded) hash functions — Bob Jenkins' lookup3 as in src/common/hashfn.c
 * — and the per-type `*hashextended` support functions hash partitioning uses, so rows are routed to the
 * same hash partitions as in PostgreSQL.
 */

const rot = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

function mix(s: Uint32Array): void {
  let [a, b, c] = s;
  a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
  a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
  s[0] = a;
  s[1] = b;
  s[2] = c;
}

function final(s: Uint32Array): void {
  let [a, b, c] = s;
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  s[0] = a;
  s[1] = b;
  s[2] = c;
}

const toUint64 = (s: Uint32Array): bigint => (BigInt(s[1]) << 32n) | BigInt(s[2]);

function seedState(init: number, seed: bigint): Uint32Array {
  const s = new Uint32Array([init, init, init]);
  if (seed !== 0n) {
    s[0] = (s[0] + Number((seed >> 32n) & 0xffffffffn)) >>> 0;
    s[1] = (s[1] + Number(seed & 0xffffffffn)) >>> 0;
    mix(s);
  }
  return s;
}

/** hash_bytes_uint32_extended */
export function hashUint32Extended(k: number, seed: bigint): bigint {
  const s = seedState((0x9e3779b9 + 4 + 3923095) >>> 0, seed);
  s[0] = (s[0] + (k >>> 0)) >>> 0;
  final(s);
  return toUint64(s);
}

/** hash_bytes_extended (little-endian byte order) */
export function hashBytesExtended(k: Uint8Array, seed: bigint): bigint {
  let len = k.length;
  const s = seedState((0x9e3779b9 + len + 3923095) >>> 0, seed);
  let o = 0;
  const word = (i: number) => (k[i] | (k[i + 1] << 8) | (k[i + 2] << 16) | (k[i + 3] << 24)) >>> 0;
  while (len >= 12) {
    s[0] = (s[0] + word(o)) >>> 0;
    s[1] = (s[1] + word(o + 4)) >>> 0;
    s[2] = (s[2] + word(o + 8)) >>> 0;
    mix(s);
    o += 12;
    len -= 12;
  }
  /* eslint-disable no-fallthrough */
  switch (len) {
    case 11:
      s[2] = (s[2] + (k[o + 10] << 24)) >>> 0;
    case 10:
      s[2] = (s[2] + (k[o + 9] << 16)) >>> 0;
    case 9:
      s[2] = (s[2] + (k[o + 8] << 8)) >>> 0;
    case 8:
      s[1] = (s[1] + (k[o + 7] << 24)) >>> 0;
    case 7:
      s[1] = (s[1] + (k[o + 6] << 16)) >>> 0;
    case 6:
      s[1] = (s[1] + (k[o + 5] << 8)) >>> 0;
    case 5:
      s[1] = (s[1] + k[o + 4]) >>> 0;
    case 4:
      s[0] = (s[0] + (k[o + 3] << 24)) >>> 0;
    case 3:
      s[0] = (s[0] + (k[o + 2] << 16)) >>> 0;
    case 2:
      s[0] = (s[0] + (k[o + 1] << 8)) >>> 0;
    case 1:
      s[0] = (s[0] + k[o]) >>> 0;
  }
  /* eslint-enable no-fallthrough */
  final(s);
  return toUint64(s);
}

const MASK64 = 0xffffffffffffffffn;

/** hash_combine64 */
export function hashCombine64(a: bigint, b: bigint): bigint {
  return (a ^ ((b + 0x49a0f4dd15e5a8e3n + ((a << 54n) & MASK64) + (a >> 7n)) & MASK64)) & MASK64;
}

/** hashint8extended */
function hashInt8Extended(v: bigint, seed: bigint): bigint {
  const val = BigInt.asIntN(64, v);
  let lo = Number(BigInt.asUintN(32, val));
  const hi = Number(BigInt.asUintN(32, val >> 32n));
  lo = (lo ^ (val >= 0n ? hi : ~hi >>> 0)) >>> 0;
  return hashUint32Extended(lo, seed);
}

/** hash_numeric_extended */
function hashNumericExtended(n: PgNumeric, seed: bigint): bigint {
  if (n.kind !== 'n') {
    return (seed - 1n) & MASK64;
  }
  // base-10000 digits and weight, as numeric's external representation stores them
  const digits = n.mag.toString().padStart(n.scale + 1, '0');
  let intPart = digits.slice(0, digits.length - n.scale).replace(/^0+/, '');
  let fracPart = digits.slice(digits.length - n.scale);
  intPart = intPart.padStart(Math.ceil(intPart.length / 4) * 4, '0');
  fracPart = fracPart.padEnd(Math.ceil(fracPart.length / 4) * 4, '0');
  const groups: number[] = [];
  for (let i = 0; i < intPart.length; i += 4) {
    groups.push(Number(intPart.slice(i, i + 4)));
  }
  let weight = groups.length - 1;
  for (let i = 0; i < fracPart.length; i += 4) {
    groups.push(Number(fracPart.slice(i, i + 4)));
  }
  let start = 0;
  while (start < groups.length && groups[start] === 0) {
    start++;
    weight--;
  }
  if (start === groups.length) {
    return (seed - 1n) & MASK64;
  }
  let end = groups.length;
  while (end > start && groups[end - 1] === 0) {
    end--;
  }
  const bytes = new Uint8Array((end - start) * 2);
  for (let i = start; i < end; i++) {
    bytes[(i - start) * 2] = groups[i] & 0xff;
    bytes[(i - start) * 2 + 1] = (groups[i] >> 8) & 0xff;
  }
  return (hashBytesExtended(bytes, seed) ^ BigInt.asUintN(64, BigInt(weight))) & MASK64;
}

/**
 * The `hashextended` support function of a type's default hash operator class, or null for types whose
 * hash is not reproduced (the caller then falls back to its own hash).
 */
export function hashDatumExtended(typeOid: number, v: unknown, seed: bigint, typeOps: TypeOps): bigint | null {
  switch (typeOid) {
    case TypeOid.int2:
    case TypeOid.int4:
    case TypeOid.date:
    case TypeOid.oid:
      return hashUint32Extended(Number(v) | 0, seed);
    case TypeOid.bool:
      return hashUint32Extended(v ? 1 : 0, seed);
    case TypeOid.int8:
      return hashInt8Extended(BigInt(v as number | bigint), seed);
    case TypeOid.timestamp:
    case TypeOid.timestamptz:
    case TypeOid.time:
      return Number.isFinite(v as number) ? hashInt8Extended(BigInt(Math.round(v as number)), seed) : hashInt8Extended((v as number) > 0 ? 0x7fffffffffffffffn : -0x8000000000000000n, seed);
    case TypeOid.text:
    case TypeOid.varchar:
    case TypeOid.name:
      return hashBytesExtended(Buffer.from(v as string, 'utf8'), seed);
    case TypeOid.bpchar:
      return hashBytesExtended(Buffer.from((v as string).replace(/ +$/, ''), 'utf8'), seed);
    case TypeOid.uuid:
      return hashBytesExtended(Buffer.from((v as string).replace(/-/g, ''), 'hex'), seed);
    case TypeOid.float4:
    case TypeOid.float8: {
      let f = v as number;
      if (f === 0) {
        return seed;
      }
      if (Number.isNaN(f)) {
        f = NaN;
      }
      const b = Buffer.alloc(8);
      b.writeDoubleLE(f);
      return hashBytesExtended(b, seed);
    }
    case TypeOid.numeric:
      return v instanceof PgNumeric ? hashNumericExtended(v, seed) : null;
  }
  void typeOps;
  return null;
}

/** HASH_PARTITION_SEED */
export const HASH_PARTITION_SEED = 0x7a5b22367996dcfdn;
