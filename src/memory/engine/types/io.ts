import type { Catalog, PgType } from '../catalog/catalog';
import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import {
  DateTimeContext,
  Interval,
  TimeTz,
  ZoneSpec,
  formatDate,
  formatInterval,
  formatIntervalIso,
  formatTime,
  formatTimeTz,
  formatTimestamp,
  formatTimestampTz,
  parseDate,
  parseInterval,
  parseTime,
  parseTimeTz,
  parseTimestamp,
  USECS_PER_SEC,
} from './datetime';
import { JsonbValue, jsonbToText, parseJsonb, validateJson } from './json';
import { PgNumeric } from './numeric';
import { PgBits, PgRecord, arrayLowerBound, withLowerBound } from './values';

/** Session-dependent state needed by type input/output functions. */
export interface IoContext extends DateTimeContext {
  catalog: Catalog;
  extraFloatDigits: number;
  byteaOutput: 'hex' | 'escape';
  intervalStyle: string;
  /** resolve a (possibly qualified, possibly quoted) relation name for regclass input */
  resolveRelationName(name: string): number | null;
  /** resolve a type name for regtype input */
  resolveTypeName(name: string): number | null;
  /** resolve function name for regproc input */
  resolveProcName(name: string): number | null;
  /** relation display name (qualified when not visible) */
  relationDisplayName(oid: number): string;
  /** type display (format_type) */
  formatType(oid: number, typmod: number): string;
  procDisplayName(oid: number): string;
}

// ---------------------------------------------------------------------------
// Integers
// ---------------------------------------------------------------------------

const INT_TYPE_NAMES: Record<number, string> = { 21: 'smallint', 23: 'integer', 20: 'bigint', 26: 'oid' };

function parseIntText(text: string, typeOid: number): bigint {
  const typeName = INT_TYPE_NAMES[typeOid] ?? 'integer';
  const s = text.trim();
  let m = /^([+-])?(\d(?:_?\d)*)$/.exec(s);
  let value: bigint;
  if (m) {
    value = BigInt(m[2].replace(/_/g, ''));
    if (m[1] === '-') {
      value = -value;
    }
  } else {
    m = /^([+-])?0([xXoObB])((?:_?[0-9a-fA-F])+)$/.exec(s);
    if (!m) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeName}: "${text}"`);
    }
    const kind = m[2].toLowerCase();
    const digits = m[3].replace(/_/g, '');
    const valid = kind === 'x' ? /^[0-9a-fA-F]+$/ : kind === 'o' ? /^[0-7]+$/ : /^[01]+$/;
    if (!valid.test(digits)) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeName}: "${text}"`);
    }
    value = BigInt((kind === 'x' ? '0x' : kind === 'o' ? '0o' : '0b') + digits);
    if (m[1] === '-') {
      value = -value;
    }
  }
  return value;
}

export function inputInt(text: string, typeOid: number): number | bigint {
  const v = parseIntText(text, typeOid);
  const typeName = INT_TYPE_NAMES[typeOid] ?? 'integer';
  switch (typeOid) {
    case TypeOid.int2:
      if (v < -32768n || v > 32767n) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `value "${text}" is out of range for type ${typeName}`);
      }
      return Number(v);
    case TypeOid.int4:
      if (v < -2147483648n || v > 2147483647n) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `value "${text}" is out of range for type ${typeName}`);
      }
      return Number(v);
    case TypeOid.int8:
      if (v < -9223372036854775808n || v > 9223372036854775807n) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `value "${text}" is out of range for type ${typeName}`);
      }
      return v;
    default:
      return Number(v);
  }
}

// ---------------------------------------------------------------------------
// Floats
// ---------------------------------------------------------------------------

export function inputFloat(text: string, isFloat4: boolean): number {
  const typeName = isFloat4 ? 'real' : 'double precision';
  const s = text.trim();
  const l = s.toLowerCase();
  let v: number;
  if (l === 'nan') {
    return NaN;
  } else if (l === 'infinity' || l === '+infinity' || l === 'inf' || l === '+inf') {
    return Infinity;
  } else if (l === '-infinity' || l === '-inf') {
    return -Infinity;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeName}: "${text}"`);
  }
  v = Number(s);
  if (isFloat4) {
    const f = Math.fround(v);
    if (!Number.isFinite(f) || (f === 0 && v !== 0 && Math.abs(v) > 0)) {
      if (!Number.isFinite(f) || Math.abs(v) < 1e-45) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `"${text}" is out of range for type real`);
      }
    }
    return f;
  }
  if (!Number.isFinite(v) || (v === 0 && /[1-9]/.test(s.replace(/[eE].*$/, '')))) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `"${text}" is out of range for type double precision`);
  }
  return v;
}

function layoutShortest(v: number, digits: string, exp: number, threshold: number): string {
  const sign = v < 0 ? '-' : '';
  if (exp >= -4 && exp < threshold) {
    if (exp >= 0) {
      if (digits.length <= exp + 1) {
        return sign + digits + '0'.repeat(exp + 1 - digits.length);
      }
      return sign + digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
    }
    return sign + '0.' + '0'.repeat(-exp - 1) + digits;
  }
  const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
  const ae = Math.abs(exp);
  return sign + mant + 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
}

function decompose(expStr: string): { digits: string; exp: number } {
  // expStr like "-1.2345e+17"
  const m = /^-?(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(expStr)!;
  let digits = m[1] + (m[2] ?? '');
  digits = digits.replace(/0+$/, '') || '0';
  return { digits, exp: parseInt(m[3], 10) };
}

export function formatFloat8(v: number, extraFloatDigits = 1): string {
  if (Number.isNaN(v)) {
    return 'NaN';
  }
  if (v === Infinity) {
    return 'Infinity';
  }
  if (v === -Infinity) {
    return '-Infinity';
  }
  if (v === 0) {
    return Object.is(v, -0) ? '-0' : '0';
  }
  if (extraFloatDigits > 0) {
    const { digits, exp } = decompose(v.toExponential());
    return layoutShortest(v, digits, exp, 15);
  }
  return formatG(v, Math.max(1, 15 + extraFloatDigits));
}

export function formatFloat4(v: number, extraFloatDigits = 1): string {
  if (Number.isNaN(v)) {
    return 'NaN';
  }
  if (v === Infinity) {
    return 'Infinity';
  }
  if (v === -Infinity) {
    return '-Infinity';
  }
  if (v === 0) {
    return Object.is(v, -0) ? '-0' : '0';
  }
  if (extraFloatDigits > 0) {
    let p = 1;
    for (; p <= 9; p++) {
      if (Math.fround(Number(v.toPrecision(p))) === v) {
        break;
      }
    }
    const { digits, exp } = decompose(Number(v.toPrecision(p)).toExponential());
    return layoutShortest(v, digits, exp, 6);
  }
  return formatG(v, Math.max(1, 6 + extraFloatDigits));
}

/** C printf %.<p>g */
export function formatG(v: number, precision: number): string {
  if (v === 0) {
    return Object.is(v, -0) ? '-0' : '0';
  }
  const e = v.toExponential(precision - 1);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e)!;
  const exp = parseInt(m[4], 10);
  if (exp < -4 || exp >= precision) {
    let frac = (m[3] ?? '').replace(/0+$/, '');
    const ae = Math.abs(exp);
    return m[1] + m[2] + (frac ? '.' + frac : '') + 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  }
  let fixed = v.toFixed(Math.max(0, precision - 1 - exp));
  if (fixed.includes('.')) {
    fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// Bool / uuid / bytea / text
// ---------------------------------------------------------------------------

export function inputBool(text: string): boolean {
  const s = text.trim().toLowerCase();
  const len = s.length;
  if (len > 0) {
    switch (s[0]) {
      case 't':
        if ('true'.startsWith(s)) {
          return true;
        }
        break;
      case 'f':
        if ('false'.startsWith(s)) {
          return false;
        }
        break;
      case 'y':
        if ('yes'.startsWith(s)) {
          return true;
        }
        break;
      case 'n':
        if ('no'.startsWith(s)) {
          return false;
        }
        break;
      case 'o':
        if (len >= 2 && 'on'.startsWith(s)) {
          return true;
        }
        if (len >= 2 && 'off'.startsWith(s)) {
          return false;
        }
        break;
      case '1':
        if (len === 1) {
          return true;
        }
        break;
      case '0':
        if (len === 1) {
          return false;
        }
        break;
    }
  }
  throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type boolean: "${text}"`);
}

export function inputUuid(text: string): string {
  let s = text;
  let braces = false;
  if (s.startsWith('{')) {
    braces = true;
    s = s.slice(1);
  }
  let hex = '';
  let i = 0;
  for (; i < s.length && hex.length < 32; i++) {
    const c = s[i];
    if (/[0-9a-fA-F]/.test(c)) {
      hex += c;
      // an optional hyphen may follow every 4th digit (except the last group)
      if (hex.length % 4 === 0 && hex.length < 32 && s[i + 1] === '-') {
        i++;
      }
    } else {
      break;
    }
  }
  let rest = s.slice(i);
  if (braces) {
    if (!rest.startsWith('}')) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type uuid: "${text}"`);
    }
    rest = rest.slice(1);
  }
  if (hex.length !== 32 || rest.length > 0) {
    throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type uuid: "${text}"`);
  }
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function inputBytea(text: string): Uint8Array {
  if (text.startsWith('\\x')) {
    const hex = text.slice(2).replace(/\s+/g, '');
    for (const ch of hex) {
      if (!/[0-9a-fA-F]/.test(ch)) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid hexadecimal digit: "${ch}"`);
      }
    }
    if (hex.length % 2 !== 0) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'invalid hexadecimal data: odd number of digits');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\\') {
        bytes.push(92);
        i++;
        continue;
      }
      const oct = text.slice(i + 1, i + 4);
      if (/^[0-3][0-7][0-7]$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, 'invalid input syntax for type bytea');
    }
    for (const b of enc.encode(c)) {
      bytes.push(b);
    }
  }
  return Uint8Array.from(bytes);
}

const HEX = '0123456789abcdef';

export function outputBytea(v: Uint8Array, style: 'hex' | 'escape' = 'hex'): string {
  if (style === 'escape') {
    let out = '';
    for (const b of v) {
      if (b === 92) {
        out += '\\\\';
      } else if (b < 32 || b > 126) {
        out += '\\' + b.toString(8).padStart(3, '0');
      } else {
        out += String.fromCharCode(b);
      }
    }
    return out;
  }
  let out = '\\x';
  for (let i = 0; i < v.length; i++) {
    out += HEX[v[i] >> 4] + HEX[v[i] & 15];
  }
  return out;
}

export function charLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      i++;
    }
    n++;
  }
  return n;
}

/** Slice by characters (code points). */
export function charSlice(s: string, start: number, end?: number): string {
  let hasSurrogate = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      hasSurrogate = true;
      break;
    }
  }
  if (!hasSurrogate) {
    return s.slice(start, end);
  }
  return Array.from(s).slice(start, end).join('');
}

/** varchar(n) / bpchar(n) typmod application. */
export function applyCharTypmod(s: string, typeOid: number, typmod: number, isExplicit: boolean): string {
  if (typmod < 4) {
    return s;
  }
  const maxLen = typmod - 4;
  const len = charLength(s);
  if (typeOid === TypeOid.varchar) {
    if (len <= maxLen) {
      return s;
    }
    const truncated = charSlice(s, 0, maxLen);
    if (!isExplicit) {
      const rest = charSlice(s, maxLen);
      if (!/^ *$/.test(rest)) {
        throw new PgError(SqlState.STRING_DATA_RIGHT_TRUNCATION, `value too long for type character varying(${maxLen})`);
      }
    }
    return truncated;
  }
  // bpchar
  if (len > maxLen) {
    const rest = charSlice(s, maxLen);
    if (!isExplicit && !/^ *$/.test(rest)) {
      throw new PgError(SqlState.STRING_DATA_RIGHT_TRUNCATION, `value too long for type character(${maxLen})`);
    }
    return charSlice(s, 0, maxLen);
  }
  if (len < maxLen) {
    return s + ' '.repeat(maxLen - len);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

function arrayMalformed(text: string, detail: string): PgError {
  return new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `malformed array literal: "${text}"`, { detail });
}

/** array_in: returns nested JS arrays of element values. */
export function inputArray(text: string, elemTypeOid: number, elemTypmod: number, ctx: IoContext, delim = ','): unknown[] {
  let s = text;
  let i = 0;
  const n = s.length;
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
  while (i < n && isSpace(s[i])) {
    i++;
  }
  const lowerBounds: number[] = [];
  if (s[i] === '[') {
    // dimension decoration [lo:hi][lo:hi]=
    while (s[i] === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) {
        throw arrayMalformed(text, 'Missing "]" after array dimensions.');
      }
      const dim = s.slice(i + 1, close);
      const m = /^\s*([+-]?\d+)\s*(?::\s*([+-]?\d+)\s*)?$/.exec(dim);
      if (!m) {
        throw arrayMalformed(text, 'Array dimensions must be followed by an equals sign.');
      }
      lowerBounds.push(m[2] !== undefined ? parseInt(m[1], 10) : 1);
      i = close + 1;
    }
    while (i < n && isSpace(s[i])) {
      i++;
    }
    if (s[i] !== '=') {
      throw arrayMalformed(text, 'Missing "=" after array dimensions.');
    }
    i++;
    while (i < n && isSpace(s[i])) {
      i++;
    }
  }
  if (s[i] !== '{') {
    throw arrayMalformed(text, 'Array value must start with "{" or dimension information.');
  }
  const parseLevel = (): unknown[] => {
    // at '{'
    i++;
    const items: unknown[] = [];
    let expectElem = true;
    let sawSub = false;
    let sawScalar = false;
    while (true) {
      while (i < n && isSpace(s[i])) {
        i++;
      }
      if (i >= n) {
        throw arrayMalformed(text, 'Unexpected end of input.');
      }
      const c = s[i];
      if (c === '}') {
        if (expectElem && items.length > 0) {
          throw arrayMalformed(text, 'Unexpected "}" character.');
        }
        i++;
        return items;
      }
      if (!expectElem) {
        if (c === delim) {
          i++;
          expectElem = true;
          continue;
        }
        throw arrayMalformed(text, `Expected "${delim}" or "}" character.`);
      }
      if (c === '{') {
        if (sawScalar) {
          throw arrayMalformed(text, 'Unexpected "{" character.');
        }
        sawSub = true;
        items.push(parseLevel());
        expectElem = false;
        continue;
      }
      if (sawSub) {
        throw arrayMalformed(text, 'Unexpected array element.');
      }
      sawScalar = true;
      if (c === '"') {
        i++;
        let val = '';
        while (true) {
          if (i >= n) {
            throw arrayMalformed(text, 'Unexpected end of input.');
          }
          const d = s[i];
          if (d === '\\') {
            val += s[i + 1] ?? '';
            i += 2;
            continue;
          }
          if (d === '"') {
            i++;
            break;
          }
          val += d;
          i++;
        }
        items.push(inputValue(elemTypeOid, val, elemTypmod, ctx));
      } else {
        let val = '';
        let hadEscape = false;
        let trailingSpaceStart = -1;
        while (i < n) {
          const d = s[i];
          if (d === delim || d === '}') {
            break;
          }
          if (d === '{' || d === '"') {
            throw arrayMalformed(text, `Unexpected "${d}" character.`);
          }
          if (d === '\\') {
            val += s[i + 1] ?? '';
            i += 2;
            hadEscape = true;
            trailingSpaceStart = -1;
            continue;
          }
          if (isSpace(d)) {
            if (trailingSpaceStart < 0) {
              trailingSpaceStart = val.length;
            }
          } else {
            trailingSpaceStart = -1;
          }
          val += d;
          i++;
        }
        if (trailingSpaceStart >= 0) {
          val = val.slice(0, trailingSpaceStart);
        }
        if (val === '' && !hadEscape) {
          throw arrayMalformed(text, 'Unexpected "' + (s[i] ?? '') + '" character.');
        }
        if (!hadEscape && val.toUpperCase() === 'NULL') {
          items.push(null);
        } else {
          items.push(inputValue(elemTypeOid, val, elemTypmod, ctx));
        }
      }
      expectElem = false;
    }
  };
  const result = parseLevel();
  while (i < n && isSpace(s[i])) {
    i++;
  }
  if (i < n) {
    throw arrayMalformed(text, 'Junk after closing right brace.');
  }
  // validate rectangular
  checkRectangular(result, text);
  void s;
  s = '';
  if (lowerBounds.length > 0 && lowerBounds[0] !== 1) {
    withLowerBound(result, lowerBounds[0]);
  }
  return result;
}

function checkRectangular(arr: unknown[], text: string): void {
  if (arr.length === 0 || !Array.isArray(arr[0])) {
    for (const x of arr) {
      if (Array.isArray(x)) {
        throw arrayMalformed(text, 'Multidimensional arrays must have sub-arrays with matching dimensions.');
      }
    }
    return;
  }
  const len = (arr[0] as unknown[]).length;
  for (const x of arr) {
    if (!Array.isArray(x) || x.length !== len) {
      throw arrayMalformed(text, 'Multidimensional arrays must have sub-arrays with matching dimensions.');
    }
    checkRectangular(x, text);
  }
}

function quoteArrayElement(s: string, delim: string): string {
  if (s === '') {
    return '""';
  }
  let needs = false;
  if (s.length === 4 && s.toUpperCase() === 'NULL') {
    needs = true;
  } else {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === '\\' || c === '{' || c === '}' || c === delim || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') {
        needs = true;
        break;
      }
    }
  }
  if (!needs) {
    return s;
  }
  return '"' + s.replace(/[\\"]/g, (m) => '\\' + m) + '"';
}

export function outputArray(arr: unknown[], elemTypeOid: number, ctx: IoContext): string {
  const elemType = ctx.catalog.getType(elemTypeOid);
  const delim = elemType?.delim ?? ',';
  const lb = arrayLowerBound(arr);
  const render = (a: unknown[]): string => {
    let out = '{';
    for (let i = 0; i < a.length; i++) {
      if (i > 0) {
        out += delim;
      }
      const v = a[i];
      if (v === null || v === undefined) {
        out += 'NULL';
      } else if (Array.isArray(v) && !(v instanceof Uint8Array) && !isArrayElementType(elemType)) {
        out += render(v);
      } else {
        out += quoteArrayElement(outputValue(elemTypeOid, v, ctx), delim);
      }
    }
    return out + '}';
  };
  const body = render(arr);
  if (lb !== 1) {
    return `[${lb}:${lb + arr.length - 1}]=` + body;
  }
  return body;
}

function isArrayElementType(t: PgType | undefined): boolean {
  // element types are never arrays themselves; nested JS arrays mean extra dimensions
  void t;
  return false;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function outputRecord(rec: PgRecord, ctx: IoContext): string {
  let out = '(';
  const types = recordFieldTypes(rec, ctx);
  for (let i = 0; i < rec.values.length; i++) {
    if (i > 0) {
      out += ',';
    }
    const v = rec.values[i];
    if (v === null || v === undefined) {
      continue;
    }
    const s = outputValue(types[i], v, ctx);
    let needs = s === '';
    for (let j = 0; j < s.length && !needs; j++) {
      const c = s[j];
      if (c === '"' || c === '\\' || c === '(' || c === ')' || c === ',' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') {
        needs = true;
      }
    }
    out += needs ? '"' + s.replace(/["\\]/g, (m) => m + m) + '"' : s;
  }
  return out + ')';
}

export function recordFieldTypes(rec: PgRecord, ctx: IoContext): number[] {
  if (rec.fieldTypes && rec.fieldTypes.length === rec.values.length) {
    return rec.fieldTypes;
  }
  const t = ctx.catalog.getType(rec.typeOid);
  if (t && t.relid) {
    const rel = ctx.catalog.getRelation(t.relid);
    if (rel) {
      return rel.columns.filter((c) => !c.isDropped).map((c) => c.typeOid);
    }
  }
  return rec.values.map(() => TypeOid.text);
}

export function inputRecord(text: string, typeOid: number, ctx: IoContext): PgRecord {
  const t = ctx.catalog.getType(typeOid);
  const rel = t && t.relid ? ctx.catalog.getRelation(t.relid) : undefined;
  if (!rel) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'input of anonymous composite types is not implemented');
  }
  const cols = rel.columns.filter((c) => !c.isDropped);
  const malformed = (detail: string) => new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `malformed record literal: "${text}"`, { detail });
  let i = 0;
  const s = text;
  while (i < s.length && /\s/.test(s[i])) {
    i++;
  }
  if (s[i] !== '(') {
    throw malformed('Missing left parenthesis.');
  }
  i++;
  const values: unknown[] = [];
  for (let f = 0; f < cols.length; f++) {
    if (f > 0) {
      if (s[i] !== ',') {
        throw malformed('Too few columns.');
      }
      i++;
    }
    if (s[i] === ',' || s[i] === ')') {
      values.push(null);
      continue;
    }
    let val = '';
    let inQuote = false;
    while (i < s.length) {
      const c = s[i];
      if (inQuote) {
        if (c === '\\') {
          val += s[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          if (s[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          inQuote = false;
          i++;
          continue;
        }
        val += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        i++;
        continue;
      }
      if (c === '\\') {
        val += s[i + 1];
        i += 2;
        continue;
      }
      if (c === ',' || c === ')') {
        break;
      }
      val += c;
      i++;
    }
    values.push(inputValue(cols[f].typeOid, val, cols[f].typmod, ctx));
  }
  if (s[i] !== ')') {
    throw malformed('Too many columns.');
  }
  i++;
  if (s.slice(i).trim() !== '') {
    throw malformed('Junk after right parenthesis.');
  }
  return new PgRecord(
    values,
    typeOid,
    cols.map((c) => c.typeOid),
    cols.map((c) => c.name)
  );
}

// ---------------------------------------------------------------------------
// Generic dispatch
// ---------------------------------------------------------------------------

export function inputValue(typeOid: number, text: string, typmod: number, ctx: IoContext): unknown {
  switch (typeOid) {
    case TypeOid.bool:
      return inputBool(text);
    case TypeOid.int2:
    case TypeOid.int4:
    case TypeOid.int8:
      return inputInt(text, typeOid);
    case TypeOid.oid:
    case TypeOid.xid:
    case TypeOid.cid: {
      const s = text.trim();
      if (!/^-?\d+$/.test(s)) {
        throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeOid === TypeOid.oid ? 'oid' : typeOid === TypeOid.xid ? 'xid' : 'cid'}: "${text}"`);
      }
      let v = Number(s);
      if (v < 0) {
        v = v >>> 0;
      }
      if (v > 4294967295) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `value "${text}" is out of range for type oid`);
      }
      return v;
    }
    case TypeOid.float4:
      return inputFloat(text, true);
    case TypeOid.float8:
      return inputFloat(text, false);
    case TypeOid.numeric: {
      const v = PgNumeric.parse(text);
      return typmod >= 4 ? v.applyTypmod(typmod) : v;
    }
    case TypeOid.text:
    case TypeOid.unknown:
    case TypeOid.cstring:
      return text;
    case TypeOid.varchar:
    case TypeOid.bpchar:
      return applyCharTypmod(text, typeOid, typmod, false);
    case TypeOid.name: {
      const enc = new TextEncoder().encode(text);
      if (enc.length > 63) {
        let out = '';
        let bytes = 0;
        for (const ch of text) {
          const l = new TextEncoder().encode(ch).length;
          if (bytes + l > 63) {
            break;
          }
          bytes += l;
          out += ch;
        }
        return out;
      }
      return text;
    }
    case TypeOid.char:
      return text.length > 0 ? text[0] : '';
    case TypeOid.bytea:
      return inputBytea(text);
    case TypeOid.uuid:
      return inputUuid(text);
    case TypeOid.json:
      return validateJson(text);
    case TypeOid.jsonb:
      return parseJsonb(text, 'jsonb');
    case TypeOid.date:
      return parseDate(text, ctx);
    case TypeOid.timestamp:
      return roundTimestamp(parseTimestamp(text, ctx, false), typmod);
    case TypeOid.timestamptz:
      return roundTimestamp(parseTimestamp(text, ctx, true), typmod);
    case TypeOid.time:
      return roundTime(parseTime(text), typmod);
    case TypeOid.timetz: {
      const v = parseTimeTz(text, ctx);
      return { us: roundTime(v.us, typmod), zone: v.zone };
    }
    case TypeOid.interval:
      return parseInterval(text);
    case TypeOid.bit:
    case TypeOid.varbit: {
      let bits = text;
      if (/^[xX]/.test(bits)) {
        bits = bits
          .slice(1)
          .split('')
          .map((h) => parseInt(h, 16).toString(2).padStart(4, '0'))
          .join('');
      } else if (/^[bB]/.test(bits)) {
        bits = bits.slice(1);
      }
      if (!/^[01]*$/.test(bits)) {
        const bad = bits.replace(/[01]/g, '')[0];
        throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `"${bad}" is not a valid binary digit`);
      }
      if (typmod > 0) {
        if (typeOid === TypeOid.bit && bits.length !== typmod) {
          throw new PgError(SqlState.STRING_DATA_LENGTH_MISMATCH, `bit string length ${bits.length} does not match type bit(${typmod})`);
        }
        if (typeOid === TypeOid.varbit && bits.length > typmod) {
          throw new PgError(SqlState.STRING_DATA_RIGHT_TRUNCATION, `bit string too long for type bit varying(${typmod})`);
        }
      }
      return new PgBits(bits);
    }
    case TypeOid.regclass: {
      const s = text.trim();
      if (/^\d+$/.test(s)) {
        return Number(s);
      }
      const oid = ctx.resolveRelationName(s);
      if (oid === null) {
        throw new PgError(SqlState.UNDEFINED_TABLE, `relation "${s}" does not exist`);
      }
      return oid;
    }
    case TypeOid.regtype: {
      const s = text.trim();
      if (/^\d+$/.test(s)) {
        return Number(s);
      }
      const oid = ctx.resolveTypeName(s);
      if (oid === null) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `type "${s}" does not exist`);
      }
      return oid;
    }
    case TypeOid.regproc:
    case TypeOid.regprocedure: {
      const s = text.trim();
      if (/^\d+$/.test(s)) {
        return Number(s);
      }
      const oid = ctx.resolveProcName(s);
      if (oid === null) {
        throw new PgError(SqlState.UNDEFINED_FUNCTION, `function "${s}" does not exist`);
      }
      return oid;
    }
    case TypeOid.regnamespace: {
      const s = text.trim();
      if (/^\d+$/.test(s)) {
        return Number(s);
      }
      const ns = ctx.catalog.findNamespace(s.replace(/^"|"$/g, ''));
      if (!ns) {
        throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${s}" does not exist`);
      }
      return ns.oid;
    }
    case TypeOid.regrole:
    case TypeOid.regoper:
    case TypeOid.regoperator:
    case TypeOid.regconfig:
    case TypeOid.regcollation:
      return /^\d+$/.test(text.trim()) ? Number(text.trim()) : 10;
    case TypeOid.int2vector:
    case TypeOid.oidvector:
      return text
        .trim()
        .split(/\s+/)
        .filter((x) => x)
        .map((x) => Number(x));
    case TypeOid.tid: {
      const m = /^\((\d+),(\d+)\)$/.exec(text.trim());
      if (!m) {
        throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type tid: "${text}"`);
      }
      return text.trim();
    }
    case TypeOid.pg_lsn:
    case TypeOid.inet:
    case TypeOid.cidr:
    case TypeOid.macaddr:
    case TypeOid.money:
    case TypeOid.xml:
    case TypeOid.tsvector:
    case TypeOid.tsquery:
    case TypeOid.point:
    case TypeOid.jsonpath:
      return text;
  }
  const t = ctx.catalog.getType(typeOid);
  if (!t) {
    return text;
  }
  if (t.isArray) {
    const elemTypmod = typmod;
    return inputArray(text, t.elem, elemTypmod, ctx, ctx.catalog.getType(t.elem)?.delim ?? ',');
  }
  if (t.typtype === 'e') {
    const label = t.enumLabels?.find((l) => l.label === text);
    if (!label) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input value for enum ${t.name}: "${text}"`);
    }
    return text;
  }
  if (t.typtype === 'd') {
    return inputValue(t.baseType, text, typmod >= 0 ? typmod : t.typmod, ctx);
  }
  if (t.typtype === 'c') {
    return inputRecord(text, typeOid, ctx);
  }
  if (t.typtype === 'p') {
    if (typeOid === TypeOid.record) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'input of anonymous composite types is not implemented');
    }
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cannot accept a value of type ${t.name}`);
  }
  return text;
}

export function roundTimestamp(ts: number, typmod: number): number {
  if (typmod < 0 || typmod >= 6 || !Number.isFinite(ts)) {
    return ts;
  }
  const scale = 10 ** (6 - typmod);
  // PostgreSQL rounds half away from zero
  const q = ts / scale;
  const r = ts >= 0 ? Math.floor(q + 0.5) : -Math.floor(-q + 0.5);
  return r * scale;
}

export function roundTime(us: number, typmod: number): number {
  if (typmod < 0 || typmod >= 6) {
    return us;
  }
  const scale = 10 ** (6 - typmod);
  return Math.floor(us / scale + 0.5) * scale;
}

export function outputValue(typeOid: number, v: unknown, ctx: IoContext): string {
  switch (typeOid) {
    case TypeOid.bool:
      return v ? 't' : 'f';
    case TypeOid.int2:
    case TypeOid.int4:
    case TypeOid.int8:
    case TypeOid.oid:
    case TypeOid.xid:
    case TypeOid.cid:
      return String(v);
    case TypeOid.float4:
      return formatFloat4(v as number, ctx.extraFloatDigits);
    case TypeOid.float8:
      return formatFloat8(v as number, ctx.extraFloatDigits);
    case TypeOid.numeric:
      return (v as PgNumeric).toString();
    case TypeOid.text:
    case TypeOid.varchar:
    case TypeOid.bpchar:
    case TypeOid.name:
    case TypeOid.char:
    case TypeOid.unknown:
    case TypeOid.json:
    case TypeOid.uuid:
    case TypeOid.cstring:
      return v as string;
    case TypeOid.jsonb:
      return jsonbToText(v as JsonbValue);
    case TypeOid.bytea:
      return outputBytea(v as Uint8Array, ctx.byteaOutput);
    case TypeOid.date:
      return formatDate(v as number);
    case TypeOid.timestamp:
      return formatTimestamp(v as number);
    case TypeOid.timestamptz:
      return formatTimestampTz(v as number, ctx.zone);
    case TypeOid.time:
      return formatTime(v as number);
    case TypeOid.timetz:
      return formatTimeTz(v as TimeTz);
    case TypeOid.interval:
      return ctx.intervalStyle === 'iso_8601' ? formatIntervalIso(v as Interval) : formatInterval(v as Interval);
    case TypeOid.bit:
    case TypeOid.varbit:
      return (v as PgBits).bits;
    case TypeOid.regclass:
      return ctx.relationDisplayName(v as number);
    case TypeOid.regtype:
      return ctx.formatType(v as number, -1);
    case TypeOid.regproc:
    case TypeOid.regprocedure:
      return ctx.procDisplayName(v as number);
    case TypeOid.regnamespace: {
      const ns = ctx.catalog.getNamespace(v as number);
      return ns ? ns.name : String(v);
    }
    case TypeOid.regrole:
      return 'postgres';
    case TypeOid.int2vector:
    case TypeOid.oidvector:
      return (v as number[]).join(' ');
    case TypeOid.record:
      return outputRecord(v as PgRecord, ctx);
    case TypeOid.void:
      return '';
  }
  if (v instanceof PgRecord) {
    return outputRecord(v, ctx);
  }
  const t = ctx.catalog.getType(typeOid);
  if (t) {
    if (t.isArray) {
      return outputArray(v as unknown[], t.elem, ctx);
    }
    if (t.typtype === 'd') {
      return outputValue(t.baseType, v, ctx);
    }
    if (t.typtype === 'e') {
      return v as string;
    }
    if (Array.isArray(v) && t.oid === TypeOid.anyarray) {
      return outputArray(v, TypeOid.text, ctx);
    }
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return String(v);
  }
  if (v instanceof PgNumeric) {
    return v.toString();
  }
  return String(v);
}

export { USECS_PER_SEC, ZoneSpec };
