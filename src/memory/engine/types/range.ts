import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { inputValue, IoContext, outputValue } from './io';
import { PgNumeric } from './numeric';

/**
 * Range and multirange values (rangetypes.c / multirangetypes.c) of the built-in range types.
 *
 * A range keeps PostgreSQL's normalized form: empty ranges carry no bounds, an infinite bound is never
 * inclusive, and discrete ranges (int4range, int8range, daterange) are canonical `[)`.
 */

export interface RangeTypeInfo {
  rangeOid: number;
  subtype: number;
  multirangeOid: number;
  /** discrete types with a canonical function */
  canonical: 'int4' | 'int8' | 'date' | null;
}

const RANGE_TYPES: RangeTypeInfo[] = [
  { rangeOid: 3904, subtype: TypeOid.int4, multirangeOid: 4451, canonical: 'int4' },
  { rangeOid: 3906, subtype: TypeOid.numeric, multirangeOid: 4532, canonical: null },
  { rangeOid: 3908, subtype: TypeOid.timestamp, multirangeOid: 4533, canonical: null },
  { rangeOid: 3910, subtype: TypeOid.timestamptz, multirangeOid: 4534, canonical: null },
  { rangeOid: 3912, subtype: TypeOid.date, multirangeOid: 4535, canonical: 'date' },
  { rangeOid: 3926, subtype: TypeOid.int8, multirangeOid: 4536, canonical: 'int8' },
];

const BY_RANGE = new Map(RANGE_TYPES.map((r) => [r.rangeOid, r]));
const BY_MULTIRANGE = new Map(RANGE_TYPES.map((r) => [r.multirangeOid, r]));

export function rangeTypeInfo(rangeOid: number): RangeTypeInfo | undefined {
  return BY_RANGE.get(rangeOid);
}

export function multirangeTypeInfo(multirangeOid: number): RangeTypeInfo | undefined {
  return BY_MULTIRANGE.get(multirangeOid);
}

function requireRangeInfo(rangeOid: number): RangeTypeInfo {
  const info = BY_RANGE.get(rangeOid);
  if (!info) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: range type ${rangeOid} is not supported`);
  }
  return info;
}

export class PgRange {
  constructor(
    readonly typeOid: number,
    readonly empty: boolean,
    /** bound values (null when infinite or empty) */
    readonly lower: unknown,
    readonly upper: unknown,
    readonly lowerInc: boolean,
    readonly upperInc: boolean,
    readonly lowerInf: boolean,
    readonly upperInf: boolean
  ) {}

  static emptyOf(typeOid: number): PgRange {
    return new PgRange(typeOid, true, null, null, false, false, false, false);
  }
}

export class PgMultirange {
  constructor(
    readonly typeOid: number,
    /** canonical: sorted, non-empty, neither overlapping nor adjacent */
    readonly ranges: PgRange[]
  ) {}
}

/** One bound of a range (RangeBound). */
export interface RangeBound {
  val: unknown;
  infinite: boolean;
  inclusive: boolean;
  lower: boolean;
}

export function lowerBound(r: PgRange): RangeBound {
  return { val: r.lower, infinite: r.lowerInf, inclusive: r.lowerInc, lower: true };
}

export function upperBound(r: PgRange): RangeBound {
  return { val: r.upper, infinite: r.upperInf, inclusive: r.upperInc, lower: false };
}

// ---------------------------------------------------------------------------
// subtype comparison
// ---------------------------------------------------------------------------

export function subtypeCompare(subtype: number, a: unknown, b: unknown): number {
  switch (subtype) {
    case TypeOid.numeric:
      return (a as PgNumeric).compare(b as PgNumeric);
    case TypeOid.int8: {
      const x = typeof a === 'bigint' ? a : BigInt(a as number);
      const y = typeof b === 'bigint' ? b : BigInt(b as number);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    default: {
      const x = a as number;
      const y = b as number;
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
}

/** range_cmp_bounds: compare two bounds (lower or upper) of the same range type. */
export function rangeCmpBounds(subtype: number, b1: RangeBound, b2: RangeBound): number {
  if (b1.infinite && b2.infinite) {
    if (b1.lower === b2.lower) {
      return 0;
    }
    return b1.lower ? -1 : 1;
  }
  if (b1.infinite) {
    return b1.lower ? -1 : 1;
  }
  if (b2.infinite) {
    return b2.lower ? 1 : -1;
  }
  const result = subtypeCompare(subtype, b1.val, b2.val);
  if (result === 0) {
    if (!b1.inclusive && !b2.inclusive) {
      if (b1.lower === b2.lower) {
        return 0;
      }
      return b1.lower ? 1 : -1;
    } else if (!b1.inclusive) {
      return b1.lower ? 1 : -1;
    } else if (!b2.inclusive) {
      return b2.lower ? -1 : 1;
    }
    return 0;
  }
  return result;
}

/** range_cmp_bound_values: compare bound values only (infinities included, inclusivity ignored). */
function rangeCmpBoundValues(subtype: number, b1: RangeBound, b2: RangeBound): number {
  if (b1.infinite && b2.infinite) {
    if (b1.lower === b2.lower) {
      return 0;
    }
    return b1.lower ? -1 : 1;
  }
  if (b1.infinite) {
    return b1.lower ? -1 : 1;
  }
  if (b2.infinite) {
    return b2.lower ? 1 : -1;
  }
  return subtypeCompare(subtype, b1.val, b2.val);
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

function intOutOfRange(which: 'int4' | 'int8'): PgError {
  return new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `${which === 'int4' ? 'integer' : 'bigint'} out of range`);
}

function increment(canonical: 'int4' | 'int8' | 'date', v: unknown): unknown {
  if (canonical === 'int8') {
    const n = (typeof v === 'bigint' ? v : BigInt(v as number)) + 1n;
    if (n > 9223372036854775807n) {
      throw intOutOfRange('int8');
    }
    return n;
  }
  const n = v as number;
  if (canonical === 'date' && !Number.isFinite(n)) {
    return n;
  }
  if (canonical === 'int4' && n + 1 > 2147483647) {
    throw intOutOfRange('int4');
  }
  return n + 1;
}

/** make_range: serialize (checks the bound order, detects empty ranges) and canonicalize. */
export function makeRange(typeOid: number, lower: RangeBound, upper: RangeBound, empty: boolean): PgRange {
  const info = requireRangeInfo(typeOid);
  let r = serializeRange(info, lower, upper, empty);
  if (!r.empty && info.canonical) {
    r = canonicalize(info, r);
  }
  return r;
}

function serializeRange(info: RangeTypeInfo, lower: RangeBound, upper: RangeBound, empty: boolean): PgRange {
  if (!empty) {
    const cmp = rangeCmpBoundValues(info.subtype, lower, upper);
    if (cmp > 0) {
      throw new PgError(SqlState.DATA_EXCEPTION, 'range lower bound must be less than or equal to range upper bound');
    }
    if (cmp === 0 && !(lower.inclusive && upper.inclusive)) {
      empty = true;
    }
  }
  if (empty) {
    return PgRange.emptyOf(info.rangeOid);
  }
  return new PgRange(
    info.rangeOid,
    false,
    lower.infinite ? null : lower.val,
    upper.infinite ? null : upper.val,
    lower.infinite ? false : lower.inclusive,
    upper.infinite ? false : upper.inclusive,
    lower.infinite,
    upper.infinite
  );
}

/** int4range_canonical / int8range_canonical / daterange_canonical */
function canonicalize(info: RangeTypeInfo, r: PgRange): PgRange {
  const lower = lowerBound(r);
  const upper = upperBound(r);
  const canonical = info.canonical!;
  if (!lower.infinite && !lower.inclusive && !(canonical === 'date' && !Number.isFinite(lower.val as number))) {
    lower.val = increment(canonical, lower.val);
    lower.inclusive = true;
  }
  if (!upper.infinite && upper.inclusive && !(canonical === 'date' && !Number.isFinite(upper.val as number))) {
    upper.val = increment(canonical, upper.val);
    upper.inclusive = false;
  }
  return serializeRange(info, lower, upper, false);
}

/** range_constructor2 / range_constructor3 */
export function constructRange(typeOid: number, lowerVal: unknown, upperVal: unknown, flags: string | null | undefined): PgRange {
  let lowerInc = true;
  let upperInc = false;
  if (flags !== undefined) {
    if (flags === null) {
      throw new PgError(SqlState.DATA_EXCEPTION, 'range constructor flags argument must not be null');
    }
    if (flags.length !== 2 || (flags[0] !== '[' && flags[0] !== '(') || (flags[1] !== ']' && flags[1] !== ')')) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'invalid range bound flags', { hint: 'Valid values are "[]", "[)", "(]", and "()".' });
    }
    lowerInc = flags[0] === '[';
    upperInc = flags[1] === ']';
  }
  return makeRange(
    typeOid,
    { val: lowerVal, infinite: lowerVal === null || lowerVal === undefined, inclusive: lowerInc, lower: true },
    { val: upperVal, infinite: upperVal === null || upperVal === undefined, inclusive: upperInc, lower: false },
    false
  );
}

// ---------------------------------------------------------------------------
// text input / output
// ---------------------------------------------------------------------------

function malformedRange(text: string, detail: string): PgError {
  return new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `malformed range literal: "${text}"`, { detail });
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';

/** range_parse_bound: returns the bound text (null when empty = infinite) and the next position */
function parseBound(text: string, pos: number): { str: string | null; pos: number } {
  const ch0 = text[pos];
  if (ch0 === ',' || ch0 === ')' || ch0 === ']') {
    return { str: null, pos };
  }
  let out = '';
  let inquote = false;
  while (inquote || !(text[pos] === ',' || text[pos] === ')' || text[pos] === ']')) {
    const ch = text[pos++];
    if (ch === undefined) {
      throw malformedRange(text, 'Unexpected end of input.');
    }
    if (ch === '\\') {
      if (pos >= text.length) {
        throw malformedRange(text, 'Unexpected end of input.');
      }
      out += text[pos++];
    } else if (ch === '"') {
      if (!inquote) {
        inquote = true;
      } else if (text[pos] === '"') {
        out += text[pos++];
      } else {
        inquote = false;
      }
    } else {
      out += ch;
    }
  }
  return { str: out, pos };
}

/** range_in */
export function inputRange(typeOid: number, text: string, ctx: IoContext): PgRange {
  const info = requireRangeInfo(typeOid);
  let pos = 0;
  while (pos < text.length && isSpace(text[pos])) {
    pos++;
  }
  if (text.slice(pos, pos + 5).toLowerCase() === 'empty') {
    pos += 5;
    while (pos < text.length && isSpace(text[pos])) {
      pos++;
    }
    if (pos < text.length) {
      throw malformedRange(text, 'Junk after "empty" key word.');
    }
    return PgRange.emptyOf(typeOid);
  }
  let lowerInc = false;
  if (text[pos] === '[') {
    lowerInc = true;
    pos++;
  } else if (text[pos] === '(') {
    pos++;
  } else {
    throw malformedRange(text, 'Missing left parenthesis or bracket.');
  }
  const lb = parseBound(text, pos);
  pos = lb.pos;
  if (text[pos] === ',') {
    pos++;
  } else {
    throw malformedRange(text, 'Missing comma after lower bound.');
  }
  const ub = parseBound(text, pos);
  pos = ub.pos;
  let upperInc = false;
  if (text[pos] === ']') {
    upperInc = true;
    pos++;
  } else if (text[pos] === ')') {
    pos++;
  } else {
    throw malformedRange(text, 'Too many commas.');
  }
  while (pos < text.length && isSpace(text[pos])) {
    pos++;
  }
  if (pos < text.length) {
    throw malformedRange(text, 'Junk after right parenthesis or bracket.');
  }
  const lowerVal = lb.str === null ? null : inputValue(info.subtype, lb.str, -1, ctx);
  const upperVal = ub.str === null ? null : inputValue(info.subtype, ub.str, -1, ctx);
  return makeRange(
    typeOid,
    { val: lowerVal, infinite: lb.str === null, inclusive: lowerInc, lower: true },
    { val: upperVal, infinite: ub.str === null, inclusive: upperInc, lower: false },
    false
  );
}

/** range_bound_escape */
function escapeBound(value: string): string {
  let quote = value === '';
  for (const ch of value) {
    if (ch === '"' || ch === '\\' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',' || isSpace(ch)) {
      quote = true;
      break;
    }
  }
  let out = quote ? '"' : '';
  for (const ch of value) {
    if (ch === '"' || ch === '\\') {
      out += ch;
    }
    out += ch;
  }
  return quote ? out + '"' : out;
}

/** range_out */
export function outputRange(r: PgRange, ctx: IoContext): string {
  if (r.empty) {
    return 'empty';
  }
  const info = requireRangeInfo(r.typeOid);
  let out = r.lowerInc ? '[' : '(';
  if (!r.lowerInf) {
    out += escapeBound(outputValue(info.subtype, r.lower, ctx));
  }
  out += ',';
  if (!r.upperInf) {
    out += escapeBound(outputValue(info.subtype, r.upper, ctx));
  }
  return out + (r.upperInc ? ']' : ')');
}

function malformedMultirange(text: string, detail: string): PgError {
  return new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `malformed multirange literal: "${text}"`, { detail });
}

/** multirange_in */
export function inputMultirange(typeOid: number, text: string, ctx: IoContext): PgMultirange {
  const info = multirangeTypeInfo(typeOid);
  if (!info) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: multirange type ${typeOid} is not supported`);
  }
  let pos = 0;
  while (pos < text.length && isSpace(text[pos])) {
    pos++;
  }
  if (text[pos] === '{') {
    pos++;
  } else {
    throw malformedMultirange(text, 'Missing left brace.');
  }
  type State = 'before' | 'in' | 'inEscaped' | 'inQuoted' | 'inQuotedEscaped' | 'after' | 'finished';
  let state: State = 'before';
  let rangesSeen = 0;
  let rangeStart = 0;
  const ranges: PgRange[] = [];
  for (; state !== 'finished'; pos++) {
    const ch = text[pos];
    if (ch === undefined) {
      throw malformedMultirange(text, 'Unexpected end of input.');
    }
    if (isSpace(ch)) {
      continue;
    }
    switch (state) {
      case 'before':
        if (ch === '[' || ch === '(') {
          rangeStart = pos;
          state = 'in';
        } else if (ch === '}' && rangesSeen === 0) {
          state = 'finished';
        } else if (text.slice(pos, pos + 5).toLowerCase() === 'empty') {
          rangesSeen++;
          pos += 4;
          state = 'after';
        } else {
          throw malformedMultirange(text, 'Expected range start.');
        }
        break;
      case 'in':
        if (ch === ']' || ch === ')') {
          const r = inputRange(info.rangeOid, text.slice(rangeStart, pos + 1), ctx);
          if (!r.empty) {
            ranges.push(r);
          }
          rangesSeen++;
          state = 'after';
        } else if (ch === '"') {
          state = 'inQuoted';
        } else if (ch === '\\') {
          state = 'inEscaped';
        }
        break;
      case 'inEscaped':
        state = 'in';
        break;
      case 'inQuoted':
        if (ch === '"') {
          if (text[pos + 1] === '"') {
            pos++;
          } else {
            state = 'in';
          }
        } else if (ch === '\\') {
          state = 'inQuotedEscaped';
        }
        break;
      case 'inQuotedEscaped':
        state = 'inQuoted';
        break;
      case 'after':
        if (ch === ',') {
          state = 'before';
        } else if (ch === '}') {
          state = 'finished';
        } else {
          throw malformedMultirange(text, 'Expected comma or end of multirange.');
        }
        break;
    }
  }
  while (pos < text.length && isSpace(text[pos])) {
    pos++;
  }
  if (pos < text.length) {
    throw malformedMultirange(text, 'Junk after closing right brace.');
  }
  return makeMultirange(typeOid, ranges);
}

/** multirange_out */
export function outputMultirange(m: PgMultirange, ctx: IoContext): string {
  return '{' + m.ranges.map((r) => outputRange(r, ctx)).join(',') + '}';
}

// ---------------------------------------------------------------------------
// range operations
// ---------------------------------------------------------------------------

const subtypeOf = (r: PgRange) => requireRangeInfo(r.typeOid).subtype;

export function rangeEq(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return a.empty && b.empty;
  }
  const st = subtypeOf(a);
  return rangeCmpBounds(st, lowerBound(a), lowerBound(b)) === 0 && rangeCmpBounds(st, upperBound(a), upperBound(b)) === 0;
}

/** range_cmp: empty first, then lower bounds, then upper bounds */
export function rangeCmp(a: PgRange, b: PgRange): number {
  if (a.empty && b.empty) {
    return 0;
  }
  if (a.empty) {
    return -1;
  }
  if (b.empty) {
    return 1;
  }
  const st = subtypeOf(a);
  const c = rangeCmpBounds(st, lowerBound(a), lowerBound(b));
  return c !== 0 ? c : rangeCmpBounds(st, upperBound(a), upperBound(b));
}

export function rangeContainsElem(r: PgRange, v: unknown): boolean {
  if (r.empty) {
    return false;
  }
  const st = subtypeOf(r);
  if (!r.lowerInf) {
    const c = subtypeCompare(st, r.lower, v);
    if (c > 0 || (c === 0 && !r.lowerInc)) {
      return false;
    }
  }
  if (!r.upperInf) {
    const c = subtypeCompare(st, r.upper, v);
    if (c < 0 || (c === 0 && !r.upperInc)) {
      return false;
    }
  }
  return true;
}

export function rangeContains(a: PgRange, b: PgRange): boolean {
  if (b.empty) {
    return true;
  }
  if (a.empty) {
    return false;
  }
  const st = subtypeOf(a);
  return rangeCmpBounds(st, lowerBound(a), lowerBound(b)) <= 0 && rangeCmpBounds(st, upperBound(a), upperBound(b)) >= 0;
}

export function rangeOverlaps(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  const st = subtypeOf(a);
  const l1 = lowerBound(a);
  const u1 = upperBound(a);
  const l2 = lowerBound(b);
  const u2 = upperBound(b);
  if (rangeCmpBounds(st, l1, l2) >= 0 && rangeCmpBounds(st, l1, u2) <= 0) {
    return true;
  }
  return rangeCmpBounds(st, l2, l1) >= 0 && rangeCmpBounds(st, l2, u1) <= 0;
}

export function rangeBefore(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  return rangeCmpBounds(subtypeOf(a), upperBound(a), lowerBound(b)) < 0;
}

export function rangeAfter(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  return rangeCmpBounds(subtypeOf(a), lowerBound(a), upperBound(b)) > 0;
}

export function rangeOverleft(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  return rangeCmpBounds(subtypeOf(a), upperBound(a), upperBound(b)) <= 0;
}

export function rangeOverright(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  return rangeCmpBounds(subtypeOf(a), lowerBound(a), lowerBound(b)) >= 0;
}

/** bounds_adjacent: is there no point between an upper bound and a lower bound? */
function boundsAdjacent(typeOid: number, boundA: RangeBound, boundB: RangeBound): boolean {
  const info = requireRangeInfo(typeOid);
  const cmp = rangeCmpBoundValues(info.subtype, boundA, boundB);
  if (cmp < 0) {
    if (!info.canonical) {
      return false;
    }
    // the range between the bounds (flipped inclusivity) is empty when they are adjacent
    const r = makeRange(typeOid, { ...boundA, inclusive: !boundA.inclusive, lower: true }, { ...boundB, inclusive: !boundB.inclusive, lower: false }, false);
    return r.empty;
  }
  if (cmp === 0) {
    return boundA.inclusive !== boundB.inclusive;
  }
  return false;
}

export function rangeAdjacent(a: PgRange, b: PgRange): boolean {
  if (a.empty || b.empty) {
    return false;
  }
  return boundsAdjacent(a.typeOid, upperBound(a), lowerBound(b)) || boundsAdjacent(a.typeOid, upperBound(b), lowerBound(a));
}

/** range_union_internal: `strict` requires the ranges to overlap or touch */
export function rangeUnion(a: PgRange, b: PgRange, strict: boolean): PgRange {
  if (a.empty) {
    return b;
  }
  if (b.empty) {
    return a;
  }
  if (strict && !rangeOverlaps(a, b) && !rangeAdjacent(a, b)) {
    throw new PgError(SqlState.DATA_EXCEPTION, 'result of range union would not be contiguous');
  }
  const st = subtypeOf(a);
  const lower = rangeCmpBounds(st, lowerBound(a), lowerBound(b)) < 0 ? lowerBound(a) : lowerBound(b);
  const upper = rangeCmpBounds(st, upperBound(a), upperBound(b)) > 0 ? upperBound(a) : upperBound(b);
  return makeRange(a.typeOid, lower, upper, false);
}

export function rangeIntersect(a: PgRange, b: PgRange): PgRange {
  if (a.empty || b.empty || !rangeOverlaps(a, b)) {
    return PgRange.emptyOf(a.typeOid);
  }
  const st = subtypeOf(a);
  const lower = rangeCmpBounds(st, lowerBound(a), lowerBound(b)) >= 0 ? lowerBound(a) : lowerBound(b);
  const upper = rangeCmpBounds(st, upperBound(a), upperBound(b)) <= 0 ? upperBound(a) : upperBound(b);
  return makeRange(a.typeOid, lower, upper, false);
}

export function rangeMinus(a: PgRange, b: PgRange): PgRange {
  if (a.empty || b.empty) {
    return a;
  }
  const st = subtypeOf(a);
  const l1 = lowerBound(a);
  const u1 = upperBound(a);
  const l2 = lowerBound(b);
  const u2 = upperBound(b);
  const cmpL1L2 = rangeCmpBounds(st, l1, l2);
  const cmpL1U2 = rangeCmpBounds(st, l1, u2);
  const cmpU1L2 = rangeCmpBounds(st, u1, l2);
  const cmpU1U2 = rangeCmpBounds(st, u1, u2);
  if (cmpL1L2 < 0 && cmpU1U2 > 0) {
    throw new PgError(SqlState.DATA_EXCEPTION, 'result of range difference would not be contiguous');
  }
  if (cmpL1U2 > 0 || cmpU1L2 < 0) {
    return a;
  }
  if (cmpL1L2 >= 0 && cmpU1U2 <= 0) {
    return PgRange.emptyOf(a.typeOid);
  }
  if (cmpL1L2 <= 0 && cmpU1L2 >= 0 && cmpU1U2 <= 0) {
    return makeRange(a.typeOid, l1, { ...l2, inclusive: !l2.inclusive, lower: false }, false);
  }
  if (cmpL1L2 >= 0 && cmpU1U2 >= 0 && cmpL1U2 <= 0) {
    return makeRange(a.typeOid, { ...u2, inclusive: !u2.inclusive, lower: true }, u1, false);
  }
  throw new PgError(SqlState.INTERNAL_ERROR, 'unexpected case in range_minus');
}

// ---------------------------------------------------------------------------
// multiranges
// ---------------------------------------------------------------------------

/** make_multirange + multirange_canonicalize: sort, drop empties, merge overlapping / adjacent ranges */
export function makeMultirange(typeOid: number, input: PgRange[]): PgMultirange {
  const ranges = input.filter((r) => !r.empty).sort(rangeCmp);
  const out: PgRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && (rangeOverlaps(last, r) || rangeAdjacent(last, r))) {
      out[out.length - 1] = rangeUnion(last, r, false);
    } else {
      out.push(r);
    }
  }
  return new PgMultirange(typeOid, out);
}

/** multirange_cmp */
export function multirangeCmp(a: PgMultirange, b: PgMultirange): number {
  const n1 = a.ranges.length;
  const n2 = b.ranges.length;
  if (n1 === 0 || n2 === 0) {
    return n1 === n2 ? 0 : n1 === 0 ? -1 : 1;
  }
  for (let i = 0; i < Math.max(n1, n2); i++) {
    if (i >= n1) {
      return -1;
    }
    if (i >= n2) {
      return 1;
    }
    const st = subtypeOf(a.ranges[i]);
    let c = rangeCmpBounds(st, lowerBound(a.ranges[i]), lowerBound(b.ranges[i]));
    if (c === 0) {
      c = rangeCmpBounds(st, upperBound(a.ranges[i]), upperBound(b.ranges[i]));
    }
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

export function multirangeContainsElem(m: PgMultirange, v: unknown): boolean {
  return m.ranges.some((r) => rangeContainsElem(r, v));
}

export function multirangeContainsRange(m: PgMultirange, r: PgRange): boolean {
  if (r.empty) {
    return true;
  }
  return m.ranges.some((x) => rangeContains(x, r));
}

export function multirangeContainsMultirange(a: PgMultirange, b: PgMultirange): boolean {
  return b.ranges.every((r) => multirangeContainsRange(a, r));
}

export function multirangeOverlapsRange(m: PgMultirange, r: PgRange): boolean {
  return m.ranges.some((x) => rangeOverlaps(x, r));
}

export function multirangeOverlapsMultirange(a: PgMultirange, b: PgMultirange): boolean {
  return a.ranges.some((r) => multirangeOverlapsRange(b, r));
}

/** The smallest range containing a multirange (range_merge(anymultirange)). */
export function multirangeSpan(m: PgMultirange): PgRange {
  const info = multirangeTypeInfo(m.typeOid)!;
  if (m.ranges.length === 0) {
    return PgRange.emptyOf(info.rangeOid);
  }
  const first = m.ranges[0];
  const last = m.ranges[m.ranges.length - 1];
  return makeRange(info.rangeOid, lowerBound(first), upperBound(last), false);
}

/** Hash key: equal ranges (under the subtype's equality) share it. */
export function rangeHashKey(r: PgRange, subKey: (subtype: number, v: unknown) => unknown): string {
  if (r.empty) {
    return 'range:empty';
  }
  const st = subtypeOf(r);
  const key = (inf: boolean, v: unknown) => (inf ? 'inf' : String(subKey(st, v)));
  return `range:${r.lowerInc ? '[' : '('}${key(r.lowerInf, r.lower)},${key(r.upperInf, r.upper)}${r.upperInc ? ']' : ')'}`;
}
