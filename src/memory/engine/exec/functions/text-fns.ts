import { createHash, randomBytes } from 'crypto';
import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { quoteIdentifier, quoteLiteral } from '../../analyze/typeutil';
import { charLength, outputValue } from '../../types/io';
import { FnCall, FnImpl } from '../runtime';

function chars(s: string): string[] {
  return Array.from(s);
}

function hasSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function substrChars(s: string, start: number, len: number | null): string {
  // PostgreSQL substring semantics: 1-based start, may be <= 0
  if (len !== null && len < 0) {
    throw new PgError(SqlState.SUBSTRING_ERROR, 'negative substring length not allowed');
  }
  let s1 = start - 1;
  let e1 = len === null ? Infinity : start - 1 + len;
  if (s1 < 0) {
    s1 = 0;
  }
  if (e1 <= s1) {
    return '';
  }
  if (!hasSurrogates(s)) {
    return s.slice(s1, e1 === Infinity ? undefined : e1);
  }
  return chars(s)
    .slice(s1, e1 === Infinity ? undefined : e1)
    .join('');
}

function valueToText(v: unknown, type: number, fc: FnCall): string {
  if (type === TypeOid.text || type === TypeOid.varchar || type === TypeOid.unknown || type === TypeOid.name) {
    return v as string;
  }
  if (type === TypeOid.bpchar) {
    return v as string;
  }
  return outputValue(type, v, fc.st.session.io);
}

// ---------------------------------------------------------------------------
// LIKE / regex
// ---------------------------------------------------------------------------

const likeCache = new Map<string, RegExp>();

export function likeToRegex(pattern: string, caseInsensitive: boolean, escape = '\\'): RegExp {
  const key = (caseInsensitive ? 'i' : 's') + escape + '\u0000' + pattern;
  let re = likeCache.get(key);
  if (re) {
    return re;
  }
  let src = '^';
  const p = chars(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (escape !== '' && c === escape) {
      i++;
      if (i >= p.length) {
        throw new PgError(SqlState.INVALID_ESCAPE_SEQUENCE, 'LIKE pattern must not end with escape character');
      }
      src += escapeRegex(p[i]);
    } else if (c === '%') {
      src += '[\\s\\S]*';
    } else if (c === '_') {
      src += '[\\s\\S]';
    } else {
      src += escapeRegex(c);
    }
  }
  src += '$';
  re = new RegExp(src, caseInsensitive ? 'iu' : 'u');
  if (likeCache.size > 5000) {
    likeCache.clear();
  }
  likeCache.set(key, re);
  return re;
}

function escapeRegex(c: string): string {
  // '-' is only special inside a character class; escaping it is invalid in unicode mode
  return /[.*+?^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
}

const regexCache = new Map<string, RegExp>();

const POSIX_CLASSES: Record<string, string> = {
  alpha: '\\p{L}',
  digit: '0-9',
  alnum: '\\p{L}\\p{Nd}',
  upper: '\\p{Lu}',
  lower: '\\p{Ll}',
  space: '\\s',
  punct: '\\p{P}',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

/** Translate a PostgreSQL ARE into a JS RegExp. */
export function pgRegex(pattern: string, flags: string): RegExp {
  const key = flags + '\u0000' + pattern;
  let re = regexCache.get(key);
  if (re) {
    return re;
  }
  let src = pattern;
  let prefixFlags = '';
  const embedded = /^\(\?([bceinpqstwx]+)\)/.exec(src);
  if (embedded) {
    prefixFlags = embedded[1];
    src = src.slice(embedded[0].length);
  }
  const allFlags = flags + prefixFlags;
  if (allFlags.includes('q')) {
    src = src.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  } else {
    src = src
      .replace(/\[\[:(\w+):\]\]/g, (_m, n) => `[${POSIX_CLASSES[n] ?? n}]`)
      .replace(/\[:(\w+):\]/g, (_m, n) => POSIX_CLASSES[n] ?? n)
      .replace(/\\m/g, '\\b(?=\\w)')
      .replace(/\\M/g, '\\b(?<=\\w)')
      .replace(/\\y/g, '\\b')
      .replace(/\\Y/g, '\\B')
      .replace(/\\A/g, '^')
      .replace(/\\Z/g, '$');
  }
  let jsFlags = 'u';
  if (allFlags.includes('i')) {
    jsFlags += 'i';
  }
  if (allFlags.includes('n') || allFlags.includes('w')) {
    jsFlags += 'm';
  } else {
    jsFlags += 's';
  }
  if (allFlags.includes('g')) {
    jsFlags += 'g';
  }
  try {
    re = new RegExp(src, jsFlags);
  } catch (e) {
    try {
      re = new RegExp(src, jsFlags.replace('u', ''));
    } catch {
      throw new PgError(SqlState.INVALID_REGULAR_EXPRESSION, `invalid regular expression: ${(e as Error).message}`);
    }
  }
  if (regexCache.size > 5000) {
    regexCache.clear();
  }
  regexCache.set(key, re);
  return re;
}

function checkRegexFlags(flags: string, fnName: string, allowG: boolean): void {
  for (const f of flags) {
    if (!'bceginpqstwx'.includes(f)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid regular expression option: "${f}"`);
    }
    if (f === 'g' && !allowG) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `${fnName}() does not support the "global" option`, {
        hint: fnName === 'regexp_match' ? 'Use the regexp_matches function instead.' : undefined,
      });
    }
  }
}

function pgReplacement(rep: string): string {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const d = rep[i + 1];
      if (d >= '1' && d <= '9') {
        out += '$' + d;
        i++;
        continue;
      }
      if (d === '&') {
        out += '$&';
        i++;
        continue;
      }
      if (d === '\\') {
        out += '\\';
        i++;
        continue;
      }
      out += d;
      i++;
      continue;
    }
    if (c === '$') {
      out += '$$';
      continue;
    }
    out += c;
  }
  return out;
}

function similarToRegex(pattern: string, escape: string | null): string {
  let out = '^(?:';
  const p = chars(pattern);
  let inBracket = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (escape && c === escape) {
      i++;
      if (i < p.length) {
        out += escapeRegex(p[i]);
      }
      continue;
    }
    if (inBracket) {
      out += c === '\\' ? '\\\\' : c;
      if (c === ']') {
        inBracket = false;
      }
      continue;
    }
    switch (c) {
      case '%':
        out += '[\\s\\S]*';
        break;
      case '_':
        out += '[\\s\\S]';
        break;
      case '[':
        inBracket = true;
        out += '[';
        break;
      case '.':
        out += '\\.';
        break;
      case '\\':
        out += '\\\\';
        break;
      default:
        out += c;
    }
  }
  return out + ')$';
}

// ---------------------------------------------------------------------------
// format()
// ---------------------------------------------------------------------------

function textFormat(args: unknown[], fc: FnCall): string {
  const fmt = args[0] as string;
  const vals = args.slice(1);
  const types = fc.argTypes.slice(1);
  let out = '';
  let argIndex = 0;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    i++;
    if (i >= fmt.length) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'unterminated format() type specifier', { hint: 'For a single "%" use "%%".' });
    }
    if (fmt[i] === '%') {
      out += '%';
      continue;
    }
    let m = /^(\d+)\$/.exec(fmt.slice(i));
    if (m) {
      argIndex = parseInt(m[1], 10) - 1;
      i += m[0].length;
    }
    let leftAlign = false;
    if (fmt[i] === '-') {
      leftAlign = true;
      i++;
    }
    let width = 0;
    m = /^\d+/.exec(fmt.slice(i));
    if (m) {
      width = parseInt(m[0], 10);
      i += m[0].length;
    } else if (fmt[i] === '*') {
      i++;
      const w = vals[argIndex++];
      width = Number(w);
      if (width < 0) {
        leftAlign = true;
        width = -width;
      }
    }
    const spec = fmt[i];
    if (argIndex >= vals.length) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'too few arguments for format()');
    }
    const v = vals[argIndex];
    const t = types[argIndex] ?? TypeOid.text;
    argIndex++;
    let s: string;
    switch (spec) {
      case 's':
        s = v === null ? '' : valueToText(v, t, fc);
        break;
      case 'I':
        if (v === null) {
          throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'null values cannot be formatted as an SQL identifier');
        }
        s = quoteIdentifier(valueToText(v, t, fc));
        break;
      case 'L':
        s = v === null ? 'NULL' : quoteLiteral(valueToText(v, t, fc));
        break;
      default:
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unrecognized format() type specifier "${spec}"`, { hint: 'For a single "%" use "%%".' });
    }
    if (width > 0 && charLength(s) < width) {
      const padding = ' '.repeat(width - charLength(s));
      s = leftAlign ? s + padding : padding + s;
    }
    out += s;
  }
  return out;
}

function trimChars(s: string, set: string, left: boolean, right: boolean): string {
  const arr = chars(s);
  const setChars = new Set(chars(set));
  let start = 0;
  let end = arr.length;
  if (left) {
    while (start < end && setChars.has(arr[start])) {
      start++;
    }
  }
  if (right) {
    while (end > start && setChars.has(arr[end - 1])) {
      end--;
    }
  }
  return arr.slice(start, end).join('');
}

function pad(s: string, len: number, fill: string, left: boolean): string {
  const arr = chars(s);
  if (len <= 0) {
    return '';
  }
  if (arr.length >= len) {
    return arr.slice(0, len).join('');
  }
  const f = chars(fill);
  if (f.length === 0) {
    return s;
  }
  const padding: string[] = [];
  for (let i = 0; padding.length < len - arr.length; i++) {
    padding.push(f[i % f.length]);
  }
  return left ? padding.join('') + s : s + padding.join('');
}

const NS_PER_MS = 1_000_000n;
/** SUBMS_MINIMAL_STEP_NS: the smallest step the 12 sub-millisecond bits can represent (+1) */
const SUBMS_MINIMAL_STEP_NS = NS_PER_MS / 4096n + 1n;
const previousNs = new WeakMap<object, bigint>();
const processNsBase = BigInt(Date.now()) * NS_PER_MS - process.hrtime.bigint();

/** get_real_time_ns_ascending: wall-clock nanoseconds, strictly increasing per backend (session) */
export function realTimeNsAscending(session: object): bigint {
  let ns = processNsBase + process.hrtime.bigint();
  const prev = previousNs.get(session) ?? 0n;
  if (prev + SUBMS_MINIMAL_STEP_NS >= ns) {
    ns = prev + SUBMS_MINIMAL_STEP_NS;
  }
  previousNs.set(session, ns);
  return ns;
}

/** generate_uuidv7: 48-bit Unix milliseconds, 12 bits of sub-millisecond precision, random rest */
export function generateUuidV7(unixTsMs: bigint, subMsNs: bigint): string {
  const ms = unixTsMs;
  const bytes = randomBytes(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const precision = (subMsNs * 4096n) / NS_PER_MS;
  bytes[6] = Number((precision >> 8n) & 0x0fn) | 0x70;
  bytes[7] = Number(precision & 0xffn);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidV4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** unaccent: strip diacritics (approximation of the unaccent dictionary). */
export function unaccentText(s: string): string {
  const special: Record<string, string> = { ß: 'ss', Æ: 'AE', æ: 'ae', Ø: 'O', ø: 'o', Œ: 'OE', œ: 'oe', Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Þ: 'TH', þ: 'th', ı: 'i' };
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßÆæØøŒœŁłĐđÞþı]/g, (c) => special[c] ?? c)
    .normalize('NFC');
}

export const TEXT_FUNCS: Record<string, FnImpl> = {
  textcat: (a) => (a[0] as string) + (a[1] as string),
  anytextcat: (a, fc) => valueToText(a[0], fc.argTypes[0], fc) + (a[1] as string),
  textanycat: (a, fc) => (a[0] as string) + valueToText(a[1], fc.argTypes[1], fc),
  textlen: (a) => charLength(a[0] as string),
  bpcharlen: (a) => charLength((a[0] as string).replace(/ +$/, '')),
  textoctetlen: (a) => Buffer.byteLength(a[0] as string, 'utf8'),
  bpcharoctetlen: (a) => Buffer.byteLength(a[0] as string, 'utf8'),
  byteaoctetlen: (a) => (a[0] as Uint8Array).length,
  bitlength: (a) => Buffer.byteLength(a[0] as string, 'utf8') * 8,
  lower: (a) => (a[0] as string).toLowerCase(),
  upper: (a) => (a[0] as string).toUpperCase(),
  initcap: (a) => (a[0] as string).toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase()),
  text_substr: (a) => substrChars(a[0] as string, a[1] as number, a[2] as number),
  text_substr_no_len: (a) => substrChars(a[0] as string, a[1] as number, null),
  textregexsubstr: (a) => {
    const m = pgRegex(a[1] as string, '').exec(a[0] as string);
    if (!m) {
      return null;
    }
    return m.length > 1 ? (m[1] ?? null) : m[0];
  },
  textpos: (a) => {
    const s = a[0] as string;
    const sub = a[1] as string;
    const idx = s.indexOf(sub);
    return idx < 0 ? 0 : charLength(s.slice(0, idx)) + 1;
  },
  replace_text: (a) => {
    const from = a[1] as string;
    if (from === '') {
      return a[0];
    }
    return (a[0] as string).split(from).join(a[2] as string);
  },
  split_part: (a) => {
    const s = a[0] as string;
    const delim = a[1] as string;
    const n = a[2] as number;
    if (n === 0) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'field position must not be zero');
    }
    if (delim === '') {
      return n === 1 || n === -1 ? s : '';
    }
    const parts = s.split(delim);
    const idx = n > 0 ? n - 1 : parts.length + n;
    return idx >= 0 && idx < parts.length ? parts[idx] : '';
  },
  btrim: (a) => trimChars(a[0] as string, a.length > 1 ? (a[1] as string) : ' ', true, true),
  btrim1: (a) => trimChars(a[0] as string, ' ', true, true),
  ltrim: (a) => trimChars(a[0] as string, a.length > 1 ? (a[1] as string) : ' ', true, false),
  ltrim1: (a) => trimChars(a[0] as string, ' ', true, false),
  rtrim: (a) => trimChars(a[0] as string, a.length > 1 ? (a[1] as string) : ' ', false, true),
  rtrim1: (a) => trimChars(a[0] as string, ' ', false, true),
  lpad: (a) => pad(a[0] as string, a[1] as number, a.length > 2 ? (a[2] as string) : ' ', true),
  rpad: (a) => pad(a[0] as string, a[1] as number, a.length > 2 ? (a[2] as string) : ' ', false),
  text_left: (a) => {
    const arr = chars(a[0] as string);
    const n = a[1] as number;
    return (n >= 0 ? arr.slice(0, n) : arr.slice(0, Math.max(0, arr.length + n))).join('');
  },
  text_right: (a) => {
    const arr = chars(a[0] as string);
    const n = a[1] as number;
    return (n >= 0 ? arr.slice(Math.max(0, arr.length - n)) : arr.slice(-n)).join('');
  },
  repeat: (a) => ((a[1] as number) <= 0 ? '' : (a[0] as string).repeat(a[1] as number)),
  text_reverse: (a) => chars(a[0] as string).reverse().join(''),
  text_concat: (a, fc) => a.map((v, i) => (v === null ? '' : valueToText(v, fc.argTypes[i], fc))).join(''),
  text_concat_ws: (a, fc) => {
    const sep = a[0] as string;
    if (sep === null) {
      return null;
    }
    return a
      .slice(1)
      .map((v, i) => (v === null ? null : valueToText(v, fc.argTypes[i + 1], fc)))
      .filter((v) => v !== null)
      .join(sep);
  },
  text_format: (a, fc) => (a[0] === null ? null : textFormat(a, fc)),
  text_format_nv: (a) => a[0],
  md5_text: (a) => createHash('md5').update(a[0] as string, 'utf8').digest('hex'),
  md5_bytea: (a) => createHash('md5').update(a[0] as Uint8Array).digest('hex'),
  sha256_bytea: (a) => new Uint8Array(createHash('sha256').update(a[0] as Uint8Array).digest()),
  sha512_bytea: (a) => new Uint8Array(createHash('sha512').update(a[0] as Uint8Array).digest()),
  to_hex32: (a) => ((a[0] as number) >>> 0).toString(16),
  to_hex64: (a) => BigInt.asUintN(64, BigInt(a[0] as bigint)).toString(16),
  ascii: (a) => {
    const s = a[0] as string;
    return s.length === 0 ? 0 : s.codePointAt(0)!;
  },
  chr: (a) => {
    const n = a[0] as number;
    if (n === 0) {
      throw new PgError(SqlState.PROGRAM_LIMIT_EXCEEDED, 'null character not permitted');
    }
    return String.fromCodePoint(n);
  },
  quote_ident: (a) => quoteIdentifier(a[0] as string),
  quote_literal: (a) => quoteLiteral(a[0] as string),
  quote_nullable: (a) => (a[0] === null ? 'NULL' : quoteLiteral(a[0] as string)),
  translate: (a) => {
    const from = chars(a[1] as string);
    const to = chars(a[2] as string);
    return chars(a[0] as string)
      .map((c) => {
        const i = from.indexOf(c);
        if (i < 0) {
          return c;
        }
        return i < to.length ? to[i] : '';
      })
      .join('');
  },
  textoverlay: (a) => {
    const s = chars(a[0] as string);
    const rep = a[1] as string;
    const start = a[2] as number;
    const len = a.length > 3 ? (a[3] as number) : charLength(rep);
    return s.slice(0, Math.max(0, start - 1)).join('') + rep + s.slice(start - 1 + len).join('');
  },
  textoverlay_no_len: (a) => {
    const s = chars(a[0] as string);
    const rep = a[1] as string;
    const start = a[2] as number;
    const len = charLength(rep);
    return s.slice(0, Math.max(0, start - 1)).join('') + rep + s.slice(start - 1 + len).join('');
  },
  text_starts_with: (a) => (a[0] as string).startsWith(a[1] as string),
  unicode_normalize_func: (a) => (a[0] as string).normalize(((a[1] as string) ?? 'NFC').toUpperCase() as 'NFC'),
  unicode_is_normalized: (a) => (a[0] as string) === (a[0] as string).normalize(((a[1] as string) ?? 'NFC').toUpperCase() as 'NFC'),
  gen_random_uuid: () => uuidV4(),
  uuidv4: () => uuidV4(),
  // RFC 9562 variant only; version 1 (Gregorian 100ns) and 7 (Unix ms) carry a timestamp
  uuid_extract_version: (a) => {
    const h = (a[0] as string).replace(/-/g, '');
    return (parseInt(h.slice(16, 18), 16) & 0xc0) === 0x80 ? parseInt(h[12], 16) : null;
  },
  uuid_extract_timestamp: (a) => {
    const h = (a[0] as string).replace(/-/g, '');
    if ((parseInt(h.slice(16, 18), 16) & 0xc0) !== 0x80) {
      return null;
    }
    const EPOCH_2000_UNIX_US = 946684800000000n;
    if (h[12] === '7') {
      return Number(BigInt('0x' + h.slice(0, 12)) * 1000n - EPOCH_2000_UNIX_US);
    }
    if (h[12] === '1') {
      // 60-bit count of 100ns intervals since 1582-10-15
      const t = (BigInt('0x' + h.slice(13, 16)) << 48n) | (BigInt('0x' + h.slice(8, 12)) << 32n) | BigInt('0x' + h.slice(0, 8));
      const GREGORIAN_TO_UNIX_100NS = 122192928000000000n;
      return Number((t - GREGORIAN_TO_UNIX_100NS) / 10n - EPOCH_2000_UNIX_US);
    }
    return null;
  },
  uuidv7: (_a, fc) => {
    const ns = realTimeNsAscending(fc.st.session);
    return generateUuidV7(ns / NS_PER_MS, ns % NS_PER_MS);
  },
  // LIKE
  textlike: (a) => likeToRegex(a[1] as string, false).test(a[0] as string),
  textnlike: (a) => !likeToRegex(a[1] as string, false).test(a[0] as string),
  texticlike: (a) => likeToRegex(a[1] as string, true).test(a[0] as string),
  texticnlike: (a) => !likeToRegex(a[1] as string, true).test(a[0] as string),
  bpcharlike: (a) => likeToRegex(a[1] as string, false).test(a[0] as string),
  bpcharnlike: (a) => !likeToRegex(a[1] as string, false).test(a[0] as string),
  bpchariclike: (a) => likeToRegex(a[1] as string, true).test(a[0] as string),
  bpcharicnlike: (a) => !likeToRegex(a[1] as string, true).test(a[0] as string),
  namelike: (a) => likeToRegex(a[1] as string, false).test(a[0] as string),
  namenlike: (a) => !likeToRegex(a[1] as string, false).test(a[0] as string),
  nameiclike: (a) => likeToRegex(a[1] as string, true).test(a[0] as string),
  nameicnlike: (a) => !likeToRegex(a[1] as string, true).test(a[0] as string),
  like_escape: (a) => {
    const pattern = a[0] as string;
    const esc = a[1] as string;
    if (charLength(esc) > 1) {
      throw new PgError(SqlState.INVALID_ESCAPE_SEQUENCE, 'invalid escape string', { hint: 'Escape string must be empty or one character.' });
    }
    if (esc === '\\') {
      return pattern;
    }
    // re-encode the pattern with backslash escaping
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (esc !== '' && c === esc) {
        i++;
        if (i < pattern.length) {
          out += '\\' + pattern[i];
        }
      } else if (c === '\\') {
        out += '\\\\';
      } else {
        out += c;
      }
    }
    return out;
  },
  similar_to_escape_1: (a) => similarToRegex(a[0] as string, '\\'),
  similar_to_escape_2: (a) => similarToRegex(a[0] as string, a[1] as string),
  similar_escape: (a) => similarToRegex(a[0] as string, (a[1] as string) ?? '\\'),
  // regex operators
  textregexeq: (a) => pgRegex(a[1] as string, '').test(a[0] as string),
  textregexne: (a) => !pgRegex(a[1] as string, '').test(a[0] as string),
  texticregexeq: (a) => pgRegex(a[1] as string, 'i').test(a[0] as string),
  texticregexne: (a) => !pgRegex(a[1] as string, 'i').test(a[0] as string),
  nameregexeq: (a) => pgRegex(a[1] as string, '').test(a[0] as string),
  nameregexne: (a) => !pgRegex(a[1] as string, '').test(a[0] as string),
  nameicregexeq: (a) => pgRegex(a[1] as string, 'i').test(a[0] as string),
  nameicregexne: (a) => !pgRegex(a[1] as string, 'i').test(a[0] as string),
  bpcharregexeq: (a) => pgRegex(a[1] as string, '').test(a[0] as string),
  bpcharregexne: (a) => !pgRegex(a[1] as string, '').test(a[0] as string),
  textregexreplace_noopt: (a) => (a[0] as string).replace(pgRegex(a[1] as string, ''), pgReplacement(a[2] as string)),
  textregexreplace: (a) => {
    const flags = a[3] as string;
    checkRegexFlags(flags, 'regexp_replace', true);
    return (a[0] as string).replace(pgRegex(a[1] as string, flags), pgReplacement(a[2] as string));
  },
  textregexreplace_extended: (a) => {
    const s = a[0] as string;
    const start = (a[3] as number) ?? 1;
    const n = a.length > 4 ? (a[4] as number) : 0;
    const flags = a.length > 5 ? (a[5] as string) : '';
    const re = pgRegex(a[1] as string, flags.replace('g', '') + 'g');
    const prefix = substrChars(s, 1, start - 1);
    const rest = substrChars(s, start, null);
    let count = 0;
    const rep = pgReplacement(a[2] as string);
    const replaced = rest.replace(re, (...m) => {
      count++;
      if (n === 0 || count === n) {
        return (m[0] as string).replace(new RegExp(re.source, re.flags.replace('g', '')), rep);
      }
      return m[0] as string;
    });
    return prefix + replaced;
  },
  regexp_like: (a) => pgRegex(a[1] as string, (a[2] as string) ?? '').test(a[0] as string),
  regexp_like_no_flags: (a) => pgRegex(a[1] as string, '').test(a[0] as string),
  regexp_count: (a) => {
    const re = pgRegex(a[1] as string, ((a[3] as string) ?? '') + 'g');
    return ((a[0] as string).slice(((a[2] as number) ?? 1) - 1).match(re) ?? []).length;
  },
  regexp_count_no_start: (a) => ((a[0] as string).match(pgRegex(a[1] as string, 'g')) ?? []).length,
  regexp_match: (a) => {
    const flags = (a[2] as string) ?? '';
    checkRegexFlags(flags, 'regexp_match', false);
    const m = pgRegex(a[1] as string, flags).exec(a[0] as string);
    if (!m) {
      return null;
    }
    return m.length > 1 ? m.slice(1).map((x) => (x === undefined ? null : x)) : [m[0]];
  },
  regexp_match_no_flags: (a) => {
    const m = pgRegex(a[1] as string, '').exec(a[0] as string);
    if (!m) {
      return null;
    }
    return m.length > 1 ? m.slice(1).map((x) => (x === undefined ? null : x)) : [m[0]];
  },
  regexp_split_to_array: (a) => (a[0] as string).split(pgRegex(a[1] as string, (a[2] as string) ?? '')),
  regexp_split_to_array_no_flags: (a) => (a[0] as string).split(pgRegex(a[1] as string, '')),
  regexp_substr: (a) => {
    const m = pgRegex(a[1] as string, '').exec(a[0] as string);
    return m ? m[0] : null;
  },
  regexp_substr_no_start: (a) => {
    const m = pgRegex(a[1] as string, '').exec(a[0] as string);
    return m ? m[0] : null;
  },
  regexp_instr_no_start: (a) => {
    const m = pgRegex(a[1] as string, '').exec(a[0] as string);
    return m ? charLength((a[0] as string).slice(0, m.index)) + 1 : 0;
  },
  // encoding
  binary_encode: (a) => {
    const data = Buffer.from(a[0] as Uint8Array);
    switch ((a[1] as string).toLowerCase()) {
      case 'hex':
        return data.toString('hex');
      case 'base64':
        return data
          .toString('base64')
          .replace(/(.{76})/g, '$1\n')
          .replace(/\n$/, '');
      case 'escape': {
        let out = '';
        for (const b of data) {
          if (b === 0 || b >= 128) {
            out += '\\' + b.toString(8).padStart(3, '0');
          } else if (b === 92) {
            out += '\\\\';
          } else {
            out += String.fromCharCode(b);
          }
        }
        return out;
      }
    }
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unrecognized encoding: "${a[1]}"`);
  },
  binary_decode: (a) => {
    const s = a[0] as string;
    switch ((a[1] as string).toLowerCase()) {
      case 'hex':
        return new Uint8Array(Buffer.from(s.replace(/\s/g, ''), 'hex'));
      case 'base64':
        return new Uint8Array(Buffer.from(s, 'base64'));
      case 'escape':
        return new Uint8Array(Buffer.from(s.replace(/\\\\/g, '\\'), 'latin1'));
    }
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unrecognized encoding: "${a[1]}"`);
  },
  pg_convert_to: (a) => new Uint8Array(Buffer.from(a[0] as string, 'utf8')),
  pg_convert_from: (a) => Buffer.from(a[0] as Uint8Array).toString('utf8'),
  byteacat: (a) => {
    const x = a[0] as Uint8Array;
    const y = a[1] as Uint8Array;
    const out = new Uint8Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return out;
  },
  unaccent_dict: (a) => unaccentText(a[a.length - 1] as string),
  unaccent_lexize: (a) => unaccentText(a[a.length - 1] as string),
};

export { substrChars, valueToText };
