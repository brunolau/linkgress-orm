import { PgError, SqlState } from '../errors';
import { PgNumeric } from './numeric';

/**
 * jsonb value model:
 *  - JNULL              JSON null
 *  - boolean            JSON true/false
 *  - PgNumeric          JSON number (numeric semantics, preserves scale)
 *  - string             JSON string
 *  - JsonbValue[]       JSON array
 *  - JsonbObject        JSON object (keys kept in jsonb order: shorter first, then bytewise)
 *
 * json values are kept as their original text.
 */

export const JNULL: { readonly __jnull: true } = Object.freeze({ __jnull: true as const });
export type JsonbNull = typeof JNULL;

export type JsonbValue = JsonbNull | boolean | PgNumeric | string | JsonbValue[] | JsonbObject;

export class JsonbObject {
  keys: string[];
  vals: JsonbValue[];

  constructor(keys: string[] = [], vals: JsonbValue[] = []) {
    this.keys = keys;
    this.vals = vals;
  }

  /** Build from unsorted pairs; later duplicates win (jsonb semantics). */
  static fromPairs(pairs: [string, JsonbValue][]): JsonbObject {
    const map = new Map<string, JsonbValue>();
    for (const [k, v] of pairs) {
      map.set(k, v);
    }
    const keys = [...map.keys()].sort(compareJsonbKeys);
    return new JsonbObject(
      keys,
      keys.map((k) => map.get(k)!)
    );
  }

  get size(): number {
    return this.keys.length;
  }

  indexOf(key: string): number {
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = compareJsonbKeys(this.keys[mid], key);
      if (c === 0) {
        return mid;
      }
      if (c < 0) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return -1;
  }

  get(key: string): JsonbValue | undefined {
    const i = this.indexOf(key);
    return i >= 0 ? this.vals[i] : undefined;
  }

  with(key: string, value: JsonbValue): JsonbObject {
    const pairs: [string, JsonbValue][] = this.keys.map((k, i) => [k, this.vals[i]]);
    pairs.push([key, value]);
    return JsonbObject.fromPairs(pairs);
  }

  without(key: string): JsonbObject {
    const i = this.indexOf(key);
    if (i < 0) {
      return this;
    }
    const keys = this.keys.slice();
    const vals = this.vals.slice();
    keys.splice(i, 1);
    vals.splice(i, 1);
    return new JsonbObject(keys, vals);
  }
}

const utf8Encoder = new TextEncoder();

function utf8Length(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      len += 1;
    } else if (c < 0x800) {
      len += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      len += 4;
      i++;
    } else {
      len += 3;
    }
  }
  return len;
}

/** jsonb key order: shorter (in bytes) first, then bytewise. */
export function compareJsonbKeys(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const la = utf8Length(a);
  const lb = utf8Length(b);
  if (la !== lb) {
    return la - lb;
  }
  return compareUtf8Bytes(a, b);
}

export function compareUtf8Bytes(a: string, b: string): number {
  // For strings without surrogates, UTF-16 code unit order equals code point order equals UTF-8 byte order
  // except for the BMP vs supplementary ordering; handle via encoded bytes when needed.
  let ascii = true;
  for (let i = 0; i < a.length && ascii; i++) {
    if (a.charCodeAt(i) >= 0xd800) {
      ascii = false;
    }
  }
  for (let i = 0; i < b.length && ascii; i++) {
    if (b.charCodeAt(i) >= 0xd800) {
      ascii = false;
    }
  }
  if (ascii) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const ea = utf8Encoder.encode(a);
  const eb = utf8Encoder.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i] !== eb[i]) {
      return ea[i] - eb[i];
    }
  }
  return ea.length - eb.length;
}

export function isJsonbObject(v: unknown): v is JsonbObject {
  return v instanceof JsonbObject;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function jsonError(typeName: string, detail: string, line: number, context: string): PgError {
  // json_errsave_error names type json for json and jsonb input alike
  void typeName;
  return new PgError(SqlState.INVALID_TEXT_REPRESENTATION, 'invalid input syntax for type json', {
    detail,
    where: `JSON data, line ${line}: ${context}`,
  });
}

class JsonScanner {
  pos = 0;
  constructor(
    readonly text: string,
    readonly typeName: string
  ) {}

  line(): number {
    let n = 1;
    for (let i = 0; i < this.pos && i < this.text.length; i++) {
      if (this.text[i] === '\n') {
        n++;
      }
    }
    return n;
  }

  context(end: number): string {
    const lineStart = this.text.lastIndexOf('\n', Math.max(0, end - 1)) + 1;
    let ctx = this.text.slice(lineStart, end);
    if (lineStart > 0 || ctx.length > 30) {
      // PostgreSQL prefixes with "..." when truncated
      if (ctx.length > 30) {
        ctx = '...' + ctx.slice(ctx.length - 30);
      }
    }
    return ctx;
  }

  skipWs(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  fail(detail: string, tokenEnd?: number): never {
    const end = tokenEnd ?? Math.min(this.text.length, this.pos + 1);
    throw jsonError(this.typeName, detail, this.line(), this.context(end));
  }

  invalidToken(): never {
    // token: run of non-delimiter chars
    const start = this.pos;
    let end = start;
    const t = this.text;
    if (end < t.length && /[A-Za-z0-9_+\-.]/.test(t[end])) {
      while (end < t.length && /[A-Za-z0-9_+\-.]/.test(t[end])) {
        end++;
      }
    } else {
      end = Math.min(t.length, start + 1);
    }
    const tok = t.slice(start, end);
    this.fail(`Token "${tok}" is invalid.`, end);
  }

  expectedEnd(): never {
    if (this.pos >= this.text.length) {
      this.fail('The input string ended unexpectedly.', this.text.length);
    }
    this.invalidToken();
  }

  parseValue(forJsonb: boolean): JsonbValue {
    this.skipWs();
    const t = this.text;
    if (this.pos >= t.length) {
      this.fail('The input string ended unexpectedly.', t.length);
    }
    const c = t[this.pos];
    if (c === '{') {
      this.pos++;
      const pairs: [string, JsonbValue][] = [];
      this.skipWs();
      if (t[this.pos] === '}') {
        this.pos++;
        return forJsonb ? new JsonbObject() : new JsonbObject();
      }
      while (true) {
        this.skipWs();
        if (t[this.pos] !== '"') {
          if (this.pos >= t.length) {
            this.fail('The input string ended unexpectedly.', t.length);
          }
          const tokStart = this.pos;
          void tokStart;
          this.expectedToken('Expected string or "}", but found', '}');
        }
        const key = this.parseString();
        this.skipWs();
        if (t[this.pos] !== ':') {
          if (this.pos >= t.length) {
            this.fail('The input string ended unexpectedly.', t.length);
          }
          this.expectedToken('Expected ":", but found', ':');
        }
        this.pos++;
        const v = this.parseValue(forJsonb);
        pairs.push([key, v]);
        this.skipWs();
        if (t[this.pos] === ',') {
          this.pos++;
          continue;
        }
        if (t[this.pos] === '}') {
          this.pos++;
          break;
        }
        if (this.pos >= t.length) {
          this.fail('The input string ended unexpectedly.', t.length);
        }
        this.expectedToken('Expected "," or "}", but found', '}');
      }
      return JsonbObject.fromPairs(pairs);
    }
    if (c === '[') {
      this.pos++;
      const arr: JsonbValue[] = [];
      this.skipWs();
      if (t[this.pos] === ']') {
        this.pos++;
        return arr;
      }
      while (true) {
        arr.push(this.parseValue(forJsonb));
        this.skipWs();
        if (t[this.pos] === ',') {
          this.pos++;
          continue;
        }
        if (t[this.pos] === ']') {
          this.pos++;
          break;
        }
        if (this.pos >= t.length) {
          this.fail('The input string ended unexpectedly.', t.length);
        }
        this.expectedToken('Expected "," or "]", but found', ']');
      }
      return arr;
    }
    if (c === '"') {
      return this.parseString();
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(t.slice(this.pos));
      if (!m) {
        this.invalidToken();
      }
      const end = this.pos + m[0].length;
      // number must be followed by delimiter
      if (end < t.length && /[A-Za-z0-9_.]/.test(t[end])) {
        this.invalidToken();
      }
      this.pos = end;
      return PgNumeric.parse(m[0]);
    }
    if (t.startsWith('true', this.pos) && !/[A-Za-z0-9_]/.test(t[this.pos + 4] ?? '')) {
      this.pos += 4;
      return true;
    }
    if (t.startsWith('false', this.pos) && !/[A-Za-z0-9_]/.test(t[this.pos + 5] ?? '')) {
      this.pos += 5;
      return false;
    }
    if (t.startsWith('null', this.pos) && !/[A-Za-z0-9_]/.test(t[this.pos + 4] ?? '')) {
      this.pos += 4;
      return JNULL;
    }
    this.invalidToken();
  }

  private expectedToken(prefix: string, _expect: string): never {
    const t = this.text;
    const start = this.pos;
    let end = start;
    if (/[A-Za-z0-9_+\-.]/.test(t[end])) {
      while (end < t.length && /[A-Za-z0-9_+\-.]/.test(t[end])) {
        end++;
      }
    } else if (t[end] === '"') {
      end++;
      while (end < t.length && t[end] !== '"') {
        if (t[end] === '\\') {
          end++;
        }
        end++;
      }
      end = Math.min(t.length, end + 1);
    } else {
      end = start + 1;
    }
    const tok = t.slice(start, end);
    this.fail(`${prefix} "${tok}".`, end);
  }

  parseString(): string {
    const t = this.text;
    // assumes t[pos] === '"'
    let i = this.pos + 1;
    let out = '';
    let segStart = i;
    while (true) {
      if (i >= t.length) {
        this.pos = t.length;
        this.fail('The input string ended unexpectedly.', t.length);
      }
      const c = t.charCodeAt(i);
      if (c === 34) {
        out += t.slice(segStart, i);
        this.pos = i + 1;
        return out;
      }
      if (c < 32) {
        this.pos = i;
        const ch = t[i];
        this.fail(`Character with value 0x${c.toString(16).padStart(2, '0')} must be escaped.`, i + 1);
        void ch;
      }
      if (c === 92) {
        out += t.slice(segStart, i);
        const e = t[i + 1];
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = t.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.pos = i;
              this.fail('"\\u" must be followed by four hexadecimal digits.', Math.min(t.length, i + 2 + hex.replace(/[^0-9a-fA-F].*$/, '').length));
            }
            const code = parseInt(hex, 16);
            if (code === 0 && this.typeName === 'jsonb') {
              throw new PgError(SqlState.UNTRANSLATABLE_CHARACTER, 'unsupported Unicode escape sequence', {
                detail: '\\u0000 cannot be converted to text.',
                where: `JSON data, line ${this.line()}: ${this.context(i + 6)}`,
              });
            }
            if (code >= 0xd800 && code <= 0xdbff) {
              const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(t.slice(i + 6));
              if (!low) {
                this.pos = i;
                throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, 'invalid input syntax for type json', {
                  detail: 'Unicode high surrogate must not follow a high surrogate.',
                });
              }
              out += String.fromCharCode(code, parseInt(low[1], 16));
              i += 6;
            } else {
              out += String.fromCharCode(code);
            }
            i += 4;
            break;
          }
          default:
            this.pos = i;
            this.fail(`Escape sequence "\\${e ?? ''}" is invalid.`, i + 2);
        }
        i += 2;
        segStart = i;
        continue;
      }
      i++;
    }
  }
}

/** Parse JSON text into a jsonb tree (validating like json_in/jsonb_in). */
export function parseJsonb(text: string, typeName: 'json' | 'jsonb' = 'jsonb'): JsonbValue {
  const s = new JsonScanner(text, typeName);
  const v = s.parseValue(true);
  s.skipWs();
  if (s.pos < text.length) {
    s.expectedEnd();
  }
  return v;
}

/** Validate json text (json_in keeps the text verbatim). */
export function validateJson(text: string): string {
  parseJsonb(text, 'json');
  return text;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const JSON_ESCAPED_CHAR = /["\\ -]/;

export function escapeJsonString(s: string): string {
  if (!JSON_ESCAPED_CHAR.test(s)) {
    return '"' + s + '"';
  }
  let out = '"';
  let segStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string | null = null;
    if (c < 32 || c === 34 || c === 92) {
      switch (c) {
        case 8:
          rep = '\\b';
          break;
        case 12:
          rep = '\\f';
          break;
        case 10:
          rep = '\\n';
          break;
        case 13:
          rep = '\\r';
          break;
        case 9:
          rep = '\\t';
          break;
        case 34:
          rep = '\\"';
          break;
        case 92:
          rep = '\\\\';
          break;
        default:
          rep = '\\u' + c.toString(16).padStart(4, '0');
      }
    }
    if (rep !== null) {
      out += s.slice(segStart, i) + rep;
      segStart = i + 1;
    }
  }
  return out + s.slice(segStart) + '"';
}

/** jsonb_out */
export function jsonbToText(v: JsonbValue): string {
  if (v === JNULL) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'string') {
    return escapeJsonString(v);
  }
  if (v instanceof PgNumeric) {
    return v.toString();
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return '[]';
    }
    let out = '[';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) {
        out += ', ';
      }
      out += jsonbToText(v[i]);
    }
    return out + ']';
  }
  const o = v as JsonbObject;
  if (o.keys.length === 0) {
    return '{}';
  }
  let out = '{';
  for (let i = 0; i < o.keys.length; i++) {
    if (i > 0) {
      out += ', ';
    }
    out += escapeJsonString(o.keys[i]) + ': ' + jsonbToText(o.vals[i]);
  }
  return out + '}';
}

/** jsonb_pretty */
export function jsonbPretty(v: JsonbValue, indent = 0): string {
  const pad = (n: number) => '    '.repeat(n);
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return '[\n' + pad(indent) + ']';
    }
    return '[\n' + v.map((x) => pad(indent + 1) + jsonbPretty(x, indent + 1)).join(',\n') + '\n' + pad(indent) + ']';
  }
  if (v instanceof JsonbObject) {
    if (v.keys.length === 0) {
      return '{\n' + pad(indent) + '}';
    }
    return '{\n' + v.keys.map((k, i) => pad(indent + 1) + escapeJsonString(k) + ': ' + jsonbPretty(v.vals[i], indent + 1)).join(',\n') + '\n' + pad(indent) + '}';
  }
  return jsonbToText(v);
}

/** Convert a jsonb tree into plain JS (for driver-level JSON.parse equivalence checks). */
export function jsonbTypeName(v: JsonbValue): string {
  if (v === JNULL) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return 'boolean';
  }
  if (typeof v === 'string') {
    return 'string';
  }
  if (v instanceof PgNumeric) {
    return 'number';
  }
  if (Array.isArray(v)) {
    return 'array';
  }
  return 'object';
}

// ---------------------------------------------------------------------------
// Comparison / equality (jsonb btree ordering)
// ---------------------------------------------------------------------------

function typeRank(v: JsonbValue): number {
  // Object > Array > Boolean > Number > String > Null
  if (v === JNULL) {
    return 0;
  }
  if (typeof v === 'string') {
    return 1;
  }
  if (v instanceof PgNumeric) {
    return 2;
  }
  if (typeof v === 'boolean') {
    return 3;
  }
  if (Array.isArray(v)) {
    return 4;
  }
  return 5;
}

export function compareJsonb(a: JsonbValue, b: JsonbValue, textCompare: (x: string, y: string) => number): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  // a scalar top-level is stored as a raw scalar pseudo array, which compares with arrays specially;
  // we treat scalars and arrays by rank (matches common cases).
  if (ra !== rb) {
    return ra - rb;
  }
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return textCompare(a as string, b as string);
    case 2:
      return (a as PgNumeric).compare(b as PgNumeric);
    case 3:
      return a === b ? 0 : a ? 1 : -1;
    case 4: {
      const x = a as JsonbValue[];
      const y = b as JsonbValue[];
      if (x.length !== y.length) {
        return x.length - y.length;
      }
      for (let i = 0; i < x.length; i++) {
        const c = compareJsonb(x[i], y[i], textCompare);
        if (c !== 0) {
          return c;
        }
      }
      return 0;
    }
    default: {
      const x = a as JsonbObject;
      const y = b as JsonbObject;
      if (x.keys.length !== y.keys.length) {
        return x.keys.length - y.keys.length;
      }
      for (let i = 0; i < x.keys.length; i++) {
        const kc = compareJsonbKeys(x.keys[i], y.keys[i]);
        if (kc !== 0) {
          return kc;
        }
        const vc = compareJsonb(x.vals[i], y.vals[i], textCompare);
        if (vc !== 0) {
          return vc;
        }
      }
      return 0;
    }
  }
}

export function jsonbEquals(a: JsonbValue, b: JsonbValue): boolean {
  return compareJsonb(a, b, (x, y) => (x === y ? 0 : x < y ? -1 : 1)) === 0;
}

/** Stable hash key for jsonb values (equality semantics). */
export function jsonbKey(v: JsonbValue): string {
  if (v === JNULL) {
    return 'n';
  }
  if (typeof v === 'boolean') {
    return v ? 't' : 'f';
  }
  if (typeof v === 'string') {
    return 's' + v.length + ':' + v;
  }
  if (v instanceof PgNumeric) {
    return 'd' + v.canonicalKey();
  }
  if (Array.isArray(v)) {
    return '[' + v.map(jsonbKey).join(',') + ']';
  }
  const o = v as JsonbObject;
  return '{' + o.keys.map((k, i) => k.length + ':' + k + '=' + jsonbKey(o.vals[i])).join(',') + '}';
}

/** jsonb @> containment (JsonbDeepContains). */
export function jsonbContains(val: JsonbValue, sub: JsonbValue, topLevel = true): boolean {
  if (Array.isArray(val) && !Array.isArray(sub)) {
    // top-level: an array contains a scalar (raw scalar special case)
    if (topLevel && !(sub instanceof JsonbObject)) {
      return val.some((e) => !Array.isArray(e) && !(e instanceof JsonbObject) && jsonbEquals(e, sub));
    }
    return false;
  }
  if (val instanceof JsonbObject) {
    if (!(sub instanceof JsonbObject)) {
      return false;
    }
    if (sub.keys.length > val.keys.length) {
      return false;
    }
    for (let i = 0; i < sub.keys.length; i++) {
      const lhs = val.get(sub.keys[i]);
      if (lhs === undefined) {
        return false;
      }
      const rhs = sub.vals[i];
      const lhsContainer = Array.isArray(lhs) || lhs instanceof JsonbObject;
      const rhsContainer = Array.isArray(rhs) || rhs instanceof JsonbObject;
      if (!lhsContainer && !rhsContainer) {
        if (!jsonbEquals(lhs, rhs)) {
          return false;
        }
      } else {
        if (Array.isArray(lhs) !== Array.isArray(rhs) || (lhs instanceof JsonbObject) !== (rhs instanceof JsonbObject)) {
          return false;
        }
        if (!jsonbContains(lhs, rhs, false)) {
          return false;
        }
      }
    }
    return true;
  }
  if (Array.isArray(val)) {
    const subArr = sub as JsonbValue[];
    for (const rhs of subArr) {
      const rhsContainer = Array.isArray(rhs) || rhs instanceof JsonbObject;
      if (!rhsContainer) {
        if (!val.some((e) => !(Array.isArray(e) || e instanceof JsonbObject) && jsonbEquals(e, rhs))) {
          return false;
        }
      } else {
        let found = false;
        for (const e of val) {
          if (Array.isArray(e) === Array.isArray(rhs) && (e instanceof JsonbObject) === (rhs instanceof JsonbObject) && jsonbContains(e, rhs, false)) {
            found = true;
            break;
          }
        }
        if (!found) {
          return false;
        }
      }
    }
    return true;
  }
  // scalars
  if (Array.isArray(sub) || sub instanceof JsonbObject) {
    return false;
  }
  return jsonbEquals(val, sub);
}

/** jsonb ? key (top-level key or array string element) */
export function jsonbExists(v: JsonbValue, key: string): boolean {
  if (v instanceof JsonbObject) {
    return v.indexOf(key) >= 0;
  }
  if (Array.isArray(v)) {
    return v.some((e) => e === key);
  }
  return typeof v === 'string' && v === key;
}

/** jsonb || jsonb */
export function jsonbConcat(a: JsonbValue, b: JsonbValue): JsonbValue {
  if (a instanceof JsonbObject && b instanceof JsonbObject) {
    const pairs: [string, JsonbValue][] = a.keys.map((k, i) => [k, a.vals[i]]);
    b.keys.forEach((k, i) => pairs.push([k, b.vals[i]]));
    return JsonbObject.fromPairs(pairs);
  }
  const arrA = Array.isArray(a) ? a : [a];
  const arrB = Array.isArray(b) ? b : [b];
  return [...arrA, ...arrB];
}

// ---------------------------------------------------------------------------
// json (text) navigation helpers — operate on the original text
// ---------------------------------------------------------------------------

interface JsonSpan {
  start: number;
  end: number;
}

/** Scan a JSON value starting at pos (after whitespace), returning its span end. Text is assumed valid. */
function scanValueEnd(t: string, pos: number): number {
  let i = pos;
  const c = t[i];
  if (c === '"') {
    i++;
    while (i < t.length) {
      if (t[i] === '\\') {
        i += 2;
        continue;
      }
      if (t[i] === '"') {
        return i + 1;
      }
      i++;
    }
    return i;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') {
        i = scanValueEnd(t, i);
        continue;
      }
      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return i;
  }
  while (i < t.length && !/[\s,\]}]/.test(t[i])) {
    i++;
  }
  return i;
}

function skipWsAt(t: string, pos: number): number {
  let i = pos;
  while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) {
    i++;
  }
  return i;
}

/** Top-level object members of json text: [key, valueSpan]. */
export function jsonObjectMembers(t: string): [string, JsonSpan][] | null {
  let i = skipWsAt(t, 0);
  if (t[i] !== '{') {
    return null;
  }
  i++;
  const out: [string, JsonSpan][] = [];
  i = skipWsAt(t, i);
  if (t[i] === '}') {
    return out;
  }
  while (i < t.length) {
    i = skipWsAt(t, i);
    const keyEnd = scanValueEnd(t, i);
    const key = new JsonScanner(t.slice(i, keyEnd), 'json').parseString();
    i = skipWsAt(t, keyEnd);
    i++; // ':'
    i = skipWsAt(t, i);
    const vEnd = scanValueEnd(t, i);
    out.push([key, { start: i, end: vEnd }]);
    i = skipWsAt(t, vEnd);
    if (t[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return out;
}

/** Top-level array elements of json text. */
export function jsonArrayElements(t: string): JsonSpan[] | null {
  let i = skipWsAt(t, 0);
  if (t[i] !== '[') {
    return null;
  }
  i++;
  const out: JsonSpan[] = [];
  i = skipWsAt(t, i);
  if (t[i] === ']') {
    return out;
  }
  while (i < t.length) {
    i = skipWsAt(t, i);
    const vEnd = scanValueEnd(t, i);
    out.push({ start: i, end: vEnd });
    i = skipWsAt(t, vEnd);
    if (t[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return out;
}

export function jsonTextKind(t: string): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  const i = skipWsAt(t, 0);
  const c = t[i];
  if (c === '{') {
    return 'object';
  }
  if (c === '[') {
    return 'array';
  }
  if (c === '"') {
    return 'string';
  }
  if (c === 't' || c === 'f') {
    return 'boolean';
  }
  if (c === 'n') {
    return 'null';
  }
  return 'number';
}

/** json ->> scalar text: de-escape strings, other scalars verbatim, containers as text; null => SQL NULL */
export function jsonScalarText(t: string): string | null {
  const s = t.trim();
  if (s === 'null') {
    return null;
  }
  if (s.startsWith('"')) {
    return new JsonScanner(s, 'json').parseString();
  }
  return s;
}

/** jsonb ->> text */
export function jsonbAsText(v: JsonbValue): string | null {
  if (v === JNULL) {
    return null;
  }
  if (typeof v === 'string') {
    return v;
  }
  return jsonbToText(v);
}
