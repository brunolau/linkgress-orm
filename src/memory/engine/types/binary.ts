import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { inputValue, IoContext, recordFieldTypes } from './io';
import { jsonbToText, JsonbValue, parseJsonb } from './json';
import { PgNumeric } from './numeric';
import { arrayLowerBound, PgBits, PgRecord, withLowerBound } from './values';
import type { Interval, TimeTz } from './datetime';
import { makeMultirange, makeRange, multirangeTypeInfo, PgMultirange, PgRange, rangeTypeInfo } from './range';

/**
 * Binary wire formats (PostgreSQL's typsend / typreceive) for the types the engine represents natively:
 * results a client requests in binary (Bind result-format codes) and binary-format bind parameters.
 */

const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;

const NUMERIC_POS = 0x0000;
const NUMERIC_NEG = 0x4000;
const NUMERIC_NAN = 0xc000;
const NUMERIC_PINF = 0xd000;
const NUMERIC_NINF = 0xf000;
const MAXDIM = 6;

// ---------------------------------------------------------------------------
// output (typsend)
// ---------------------------------------------------------------------------

class BinWriter {
  private chunks: Buffer[] = [];

  int16(v: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(v);
    this.chunks.push(b);
    return this;
  }

  uint16(v: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(v);
    this.chunks.push(b);
    return this;
  }

  int32(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(v);
    this.chunks.push(b);
    return this;
  }

  uint32(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(v >>> 0);
    this.chunks.push(b);
    return this;
  }

  int64(v: bigint): this {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64BE(v);
    this.chunks.push(b);
    return this;
  }

  bytes(b: Uint8Array): this {
    this.chunks.push(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    return this;
  }

  done(): Buffer {
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
  }
}

const int64Of = (v: number): bigint => (v === Infinity ? INT64_MAX : v === -Infinity ? INT64_MIN : BigInt(Math.round(v)));

function numericSend(n: PgNumeric, w: BinWriter): void {
  if (n.kind !== 'n') {
    w.int16(0).int16(0).uint16(n.kind === 'nan' ? NUMERIC_NAN : n.kind === '+inf' ? NUMERIC_PINF : NUMERIC_NINF).uint16(0);
    return;
  }
  const digits = n.mag.toString().padStart(n.scale + 1, '0');
  let intPart = digits.slice(0, digits.length - n.scale);
  let fracPart = digits.slice(digits.length - n.scale);
  intPart = intPart.replace(/^0+/, '');
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
  let end = groups.length;
  while (end > start && groups[end - 1] === 0) {
    end--;
  }
  const kept = groups.slice(start, end);
  if (kept.length === 0) {
    weight = 0;
  }
  w.int16(kept.length).int16(weight).uint16(n.neg ? NUMERIC_NEG : NUMERIC_POS).uint16(n.scale);
  for (const g of kept) {
    w.int16(g);
  }
}

function arrayDims(arr: unknown[]): number[] {
  const dims: number[] = [arr.length];
  let cur: unknown = arr[0];
  while (Array.isArray(cur) && !(cur instanceof Uint8Array)) {
    dims.push(cur.length);
    cur = cur[0];
  }
  return arr.length === 0 ? [] : dims;
}

function arraySend(arr: unknown[], elemType: number, ctx: IoContext, w: BinWriter): void {
  const dims = arrayDims(arr);
  const flat: unknown[] = dims.length > 1 ? (arr as unknown[][]).flat(dims.length - 1) : arr;
  const hasNull = flat.some((v) => v === null || v === undefined);
  w.int32(dims.length).int32(hasNull ? 1 : 0).uint32(elemType);
  dims.forEach((d, i) => {
    w.int32(d).int32(i === 0 ? arrayLowerBound(arr) : 1);
  });
  for (const v of flat) {
    if (v === null || v === undefined) {
      w.int32(-1);
    } else {
      const b = sendBinary(elemType, v, ctx);
      w.int32(b.length).bytes(b);
    }
  }
}

function recordSend(rec: PgRecord, ctx: IoContext, w: BinWriter): void {
  const types = recordFieldTypes(rec, ctx);
  w.int32(rec.values.length);
  rec.values.forEach((v, i) => {
    w.uint32(types[i]);
    if (v === null || v === undefined) {
      w.int32(-1);
    } else {
      const b = sendBinary(types[i], v, ctx);
      w.int32(b.length).bytes(b);
    }
  });
}

function noBinaryOutput(typeOid: number, ctx: IoContext): PgError {
  const t = ctx.catalog.getType(typeOid);
  return new PgError(SqlState.UNDEFINED_FUNCTION, `no binary output function available for type ${t ? t.name : typeOid}`);
}

/** The binary representation of a (non-null) value: the payload of a binary-format DataRow column. */
export function sendBinary(typeOid: number, v: unknown, ctx: IoContext): Buffer {
  const w = new BinWriter();
  switch (typeOid) {
    case TypeOid.bool:
      return Buffer.from([v ? 1 : 0]);
    case TypeOid.bytea:
      return Buffer.from(v as Uint8Array);
    case TypeOid.char:
      return Buffer.from(v as string, 'latin1').subarray(0, 1);
    case TypeOid.int2:
      return w.int16(Number(v)).done();
    case TypeOid.int4:
      return w.int32(Number(v)).done();
    case TypeOid.int8:
      return w.int64(BigInt(v as number | bigint)).done();
    case TypeOid.oid:
    case TypeOid.xid:
    case TypeOid.cid:
    case TypeOid.regclass:
    case TypeOid.regtype:
    case TypeOid.regproc:
    case TypeOid.regprocedure:
    case TypeOid.regnamespace:
    case TypeOid.regoper:
    case TypeOid.regoperator:
    case TypeOid.regconfig:
    case TypeOid.regcollation:
      return w.uint32(Number(v)).done();
    case TypeOid.regrole:
      return w.uint32(typeof v === 'number' ? v : 10).done();
    case TypeOid.float4: {
      const b = Buffer.allocUnsafe(4);
      b.writeFloatBE(v as number);
      return b;
    }
    case TypeOid.float8: {
      const b = Buffer.allocUnsafe(8);
      b.writeDoubleBE(v as number);
      return b;
    }
    case TypeOid.numeric:
      numericSend(v instanceof PgNumeric ? v : PgNumeric.parse(String(v)), w);
      return w.done();
    case TypeOid.text:
    case TypeOid.varchar:
    case TypeOid.bpchar:
    case TypeOid.name:
    case TypeOid.unknown:
    case TypeOid.json:
    case TypeOid.xml:
    case TypeOid.cstring:
      return Buffer.from(String(v), 'utf8');
    case TypeOid.jsonb:
      return Buffer.concat([Buffer.from([1]), Buffer.from(jsonbToText(v as JsonbValue), 'utf8')]);
    case TypeOid.uuid:
      return Buffer.from((v as string).replace(/-/g, ''), 'hex');
    case TypeOid.date: {
      const d = v as number;
      return w.int32(d === Infinity ? INT32_MAX : d === -Infinity ? INT32_MIN : d).done();
    }
    case TypeOid.timestamp:
    case TypeOid.timestamptz:
    case TypeOid.time:
      return w.int64(int64Of(v as number)).done();
    case TypeOid.timetz: {
      const t = v as TimeTz;
      return w.int64(BigInt(Math.round(t.us))).int32(t.zone).done();
    }
    case TypeOid.interval: {
      const iv = v as Interval;
      return w.int64(BigInt(Math.round(iv.us))).int32(iv.days).int32(iv.months).done();
    }
    case TypeOid.bit:
    case TypeOid.varbit: {
      const bits = (v as PgBits).bits;
      const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
      for (let i = 0; i < bits.length; i++) {
        if (bits[i] === '1') {
          bytes[i >> 3] |= 0x80 >> (i & 7);
        }
      }
      return w.int32(bits.length).bytes(bytes).done();
    }
    case TypeOid.int2vector:
    case TypeOid.oidvector:
      arraySend(withLowerBound((v as number[]).slice(), 0), typeOid === TypeOid.int2vector ? TypeOid.int2 : TypeOid.oid, ctx, w);
      return w.done();
    case TypeOid.void:
      return Buffer.alloc(0);
    case TypeOid.record:
      recordSend(v as PgRecord, ctx, w);
      return w.done();
  }
  if (v instanceof PgRecord) {
    recordSend(v, ctx, w);
    return w.done();
  }
  if (v instanceof PgRange) {
    return rangeSend(v, ctx);
  }
  if (v instanceof PgMultirange) {
    // multirange_send: range count, then each range_send payload with its length
    w.int32(v.ranges.length);
    for (const r of v.ranges) {
      const b = rangeSend(r, ctx);
      w.int32(b.length).bytes(b);
    }
    return w.done();
  }
  const t = ctx.catalog.getType(typeOid);
  if (t) {
    if (t.isArray && Array.isArray(v)) {
      arraySend(v, t.elem, ctx, w);
      return w.done();
    }
    if (t.typtype === 'd') {
      return sendBinary(t.baseType, v, ctx);
    }
    if (t.typtype === 'e') {
      return Buffer.from(String(v), 'utf8');
    }
  }
  throw noBinaryOutput(typeOid, ctx);
}

// ---------------------------------------------------------------------------
// input (typreceive)
// ---------------------------------------------------------------------------

/** pq_getmsg* over one parameter value */
class BinReader {
  pos = 0;

  constructor(readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new PgError(SqlState.PROTOCOL_VIOLATION, 'insufficient data left in message');
    }
  }

  int16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  uint16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  int32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  int64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  rest(): Buffer {
    const v = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return v;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }
}

const timestampOf = (v: bigint): number => (v === INT64_MAX ? Infinity : v === INT64_MIN ? -Infinity : Number(v));

function invalidBinary(message: string): PgError {
  return new PgError(SqlState.INVALID_BINARY_REPRESENTATION, message);
}

function numericRecv(r: BinReader): PgNumeric {
  const ndigits = r.uint16();
  const weight = r.int16();
  const sign = r.uint16();
  if (sign !== NUMERIC_POS && sign !== NUMERIC_NEG && sign !== NUMERIC_NAN && sign !== NUMERIC_PINF && sign !== NUMERIC_NINF) {
    throw invalidBinary('invalid sign in external "numeric" value');
  }
  const dscale = r.uint16();
  if ((dscale & 0x3fff) !== dscale) {
    throw invalidBinary('invalid scale in external "numeric" value');
  }
  let total = 0n;
  for (let i = 0; i < ndigits; i++) {
    const d = r.int16();
    if (d < 0 || d >= 10000) {
      throw invalidBinary('invalid digit in external "numeric" value');
    }
    total = total * 10000n + BigInt(d);
  }
  if (sign === NUMERIC_NAN) {
    return PgNumeric.NAN;
  }
  if (sign === NUMERIC_PINF) {
    return PgNumeric.PINF;
  }
  if (sign === NUMERIC_NINF) {
    return PgNumeric.NINF;
  }
  // value = total * 10000^(weight - ndigits + 1)
  const exp4 = weight - ndigits + 1;
  let mag: bigint;
  let scale: number;
  if (exp4 >= 0) {
    mag = total * 10n ** BigInt(exp4 * 4);
    scale = 0;
  } else {
    mag = total;
    scale = -exp4 * 4;
  }
  if (scale > dscale) {
    const div = 10n ** BigInt(scale - dscale);
    const q = mag / div;
    mag = (mag % div) * 2n >= div ? q + 1n : q;
  } else if (scale < dscale) {
    mag *= 10n ** BigInt(dscale - scale);
  }
  return PgNumeric.make(sign === NUMERIC_NEG, mag, dscale);
}

function arrayRecv(r: BinReader, typeOid: number, elemTypeOid: number, ctx: IoContext): unknown[] {
  const ndim = r.int32();
  const flags = r.int32();
  const elemType = r.uint32();
  if (ndim < 0) {
    throw invalidBinary(`invalid number of dimensions: ${ndim}`);
  }
  if (ndim > MAXDIM) {
    throw new PgError(SqlState.PROGRAM_LIMIT_EXCEEDED ?? '54000', `number of array dimensions (${ndim}) exceeds the maximum allowed (${MAXDIM})`);
  }
  if (flags !== 0 && flags !== 1) {
    throw invalidBinary('invalid array flags');
  }
  if (elemType !== elemTypeOid) {
    const t = ctx.catalog.getType(elemTypeOid);
    throw new PgError(SqlState.DATATYPE_MISMATCH ?? '42804', `binary data has array element type ${elemType} (${ctx.catalog.getType(elemType)?.name ?? '???'}) instead of expected ${elemTypeOid} (${t?.name ?? '???'})`);
  }
  const dims: number[] = [];
  let lbound = 1;
  for (let i = 0; i < ndim; i++) {
    dims.push(r.int32());
    const lb = r.int32();
    if (i === 0) {
      lbound = lb;
    }
  }
  if (ndim === 0) {
    return [];
  }
  const total = dims.reduce((a, b) => a * b, 1);
  const flat: unknown[] = [];
  for (let i = 0; i < total; i++) {
    const len = r.int32();
    if (len === -1) {
      flat.push(null);
      continue;
    }
    if (len < 0) {
      throw invalidBinary('insufficient data left in message');
    }
    const elem = new BinReader(r.bytes(len));
    flat.push(recvValue(elemTypeOid, elem, ctx));
    if (elem.remaining > 0) {
      throw invalidBinary('improper binary format in array element 1');
    }
  }
  const nest = (level: number, offset: number): unknown[] => {
    const out: unknown[] = [];
    const size = dims.slice(level + 1).reduce((a, b) => a * b, 1);
    for (let i = 0; i < dims[level]; i++) {
      out.push(level === dims.length - 1 ? flat[offset + i] : nest(level + 1, offset + i * size));
    }
    return out;
  };
  void typeOid;
  return withLowerBound(nest(0, 0), lbound);
}

function utf8Text(buf: Buffer, typeName: string): string {
  const s = buf.toString('utf8');
  if (s.includes('�') && !Buffer.from(s, 'utf8').equals(buf)) {
    throw new PgError(SqlState.CHARACTER_NOT_IN_REPERTOIRE ?? '22021', `invalid byte sequence for encoding "UTF8"`);
  }
  if (s.includes(' ')) {
    throw new PgError(SqlState.CHARACTER_NOT_IN_REPERTOIRE ?? '22021', 'invalid byte sequence for encoding "UTF8": 0x00');
  }
  void typeName;
  return s;
}

function recvValue(typeOid: number, r: BinReader, ctx: IoContext): unknown {
  switch (typeOid) {
    case TypeOid.bytea:
      return new Uint8Array(r.rest());
    case TypeOid.bool: {
      const b = r.bytes(1);
      return b[0] !== 0;
    }
    case TypeOid.char:
      return r.rest().subarray(0, 1).toString('latin1');
    case TypeOid.int2:
      return r.int16();
    case TypeOid.int4:
      return r.int32();
    case TypeOid.int8:
      return r.int64();
    case TypeOid.oid:
    case TypeOid.xid:
    case TypeOid.cid:
    case TypeOid.regclass:
    case TypeOid.regtype:
    case TypeOid.regproc:
    case TypeOid.regprocedure:
    case TypeOid.regnamespace:
      return r.uint32();
    case TypeOid.float4: {
      const b = r.bytes(4);
      return b.readFloatBE(0);
    }
    case TypeOid.float8: {
      const b = r.bytes(8);
      return b.readDoubleBE(0);
    }
    case TypeOid.numeric:
      return numericRecv(r);
    case TypeOid.uuid: {
      const h = r.bytes(16).toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    case TypeOid.jsonb: {
      const version = r.bytes(1)[0];
      if (version !== 1) {
        throw invalidBinary(`unsupported jsonb version number ${version}`);
      }
      return parseJsonb(utf8Text(r.rest(), 'jsonb'));
    }
    case TypeOid.date: {
      const d = r.int32();
      return d === INT32_MAX ? Infinity : d === INT32_MIN ? -Infinity : d;
    }
    case TypeOid.timestamp:
    case TypeOid.timestamptz:
      return timestampOf(r.int64());
    case TypeOid.time:
      return Number(r.int64());
    case TypeOid.timetz: {
      const us = Number(r.int64());
      return { us, zone: r.int32() } as TimeTz;
    }
    case TypeOid.interval: {
      const us = Number(r.int64());
      const days = r.int32();
      const months = r.int32();
      return { months, days, us } as Interval;
    }
    case TypeOid.bit:
    case TypeOid.varbit: {
      const len = r.int32();
      if (len < 0) {
        throw invalidBinary('invalid length in external bit string');
      }
      const bytes = r.bytes(Math.ceil(len / 8));
      let bits = '';
      for (let i = 0; i < len; i++) {
        bits += bytes[i >> 3] & (0x80 >> (i & 7)) ? '1' : '0';
      }
      return new PgBits(bits);
    }
    case TypeOid.text:
    case TypeOid.varchar:
    case TypeOid.bpchar:
    case TypeOid.name:
    case TypeOid.unknown:
    case TypeOid.json:
    case TypeOid.xml:
      return inputValue(typeOid, utf8Text(r.rest(), 'text'), -1, ctx);
  }
  const t = ctx.catalog.getType(typeOid);
  if (t) {
    if (t.isArray) {
      return arrayRecv(r, typeOid, t.elem, ctx);
    }
    if (t.typtype === 'd') {
      return recvValue(t.baseType, r, ctx);
    }
    if (t.typtype === 'e') {
      return inputValue(typeOid, utf8Text(r.rest(), t.name), -1, ctx);
    }
    if (t.typtype === 'r' && rangeTypeInfo(typeOid)) {
      return rangeRecv(typeOid, r, ctx);
    }
    if (t.typtype === 'm' && multirangeTypeInfo(typeOid)) {
      // multirange_recv
      const rangeOid = multirangeTypeInfo(typeOid)!.rangeOid;
      const count = r.int32();
      const ranges: PgRange[] = [];
      for (let i = 0; i < count; i++) {
        const len = r.int32();
        ranges.push(rangeRecv(rangeOid, new BinReader(r.bytes(len)), ctx));
      }
      return makeMultirange(typeOid, ranges);
    }
  }
  throw new PgError(SqlState.UNDEFINED_FUNCTION, `no binary input function available for type ${t ? t.name : typeOid}`);
}

const RANGE_EMPTY = 0x01;
const RANGE_LB_INC = 0x02;
const RANGE_UB_INC = 0x04;
const RANGE_LB_INF = 0x08;
const RANGE_UB_INF = 0x10;

/** range_send: a flags byte, then the length-prefixed binary bounds that exist */
function rangeSend(v: PgRange, ctx: IoContext): Buffer {
  const w = new BinWriter();
  const subtype = rangeTypeInfo(v.typeOid)!.subtype;
  let flags = 0;
  if (v.empty) {
    flags = RANGE_EMPTY;
  } else {
    flags |= v.lowerInc ? RANGE_LB_INC : 0;
    flags |= v.upperInc ? RANGE_UB_INC : 0;
    flags |= v.lowerInf ? RANGE_LB_INF : 0;
    flags |= v.upperInf ? RANGE_UB_INF : 0;
  }
  w.bytes(Buffer.from([flags]));
  if (!v.empty && !v.lowerInf) {
    const b = sendBinary(subtype, v.lower, ctx);
    w.int32(b.length).bytes(b);
  }
  if (!v.empty && !v.upperInf) {
    const b = sendBinary(subtype, v.upper, ctx);
    w.int32(b.length).bytes(b);
  }
  return w.done();
}

/** range_recv: unsupported flag bits are masked out; the range is then serialized and canonicalized */
function rangeRecv(typeOid: number, r: BinReader, ctx: IoContext): PgRange {
  const subtype = rangeTypeInfo(typeOid)!.subtype;
  const flags = r.bytes(1)[0] & (RANGE_EMPTY | RANGE_LB_INC | RANGE_LB_INF | RANGE_UB_INC | RANGE_UB_INF);
  const bound = (hasFlag: number): unknown => {
    if (flags & (RANGE_EMPTY | hasFlag)) {
      return null;
    }
    const len = r.int32();
    return recvValue(subtype, new BinReader(r.bytes(len)), ctx);
  };
  const lower = bound(RANGE_LB_INF);
  const upper = bound(RANGE_UB_INF);
  return makeRange(
    typeOid,
    { val: lower, infinite: (flags & RANGE_LB_INF) !== 0, inclusive: (flags & RANGE_LB_INC) !== 0, lower: true },
    { val: upper, infinite: (flags & RANGE_UB_INF) !== 0, inclusive: (flags & RANGE_UB_INC) !== 0, lower: false },
    (flags & RANGE_EMPTY) !== 0
  );
}

/**
 * Binary-format bind parameter input: the whole value must be consumed, as in exec_bind_message.
 * `paramNo` is 1-based.
 */
export function receiveBinary(typeOid: number, bytes: Uint8Array, ctx: IoContext, paramNo = 1): unknown {
  const r = new BinReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const value = recvValue(typeOid, r, ctx);
  if (r.remaining > 0) {
    throw invalidBinary(`incorrect binary data format in bind parameter ${paramNo}`);
  }
  return value;
}
