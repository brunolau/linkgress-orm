import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { TExpr } from '../../analyze/nodes';
import { ageTimestamps, Interval, USECS_PER_DAY, USECS_PER_SEC } from '../../types/datetime';
import { applyCharTypmod, outputValue, roundTime, roundTimestamp } from '../../types/io';
import { PgNumeric } from '../../types/numeric';
import { FnImpl } from '../runtime';
import { TypeOps } from '../typeops';
import { ARRAY_FUNCS, ARRAY_SRFS } from './array-fns';
import { DATETIME_FUNCS } from './datetime-fns';
import { JSON_FUNCS, JSON_PATH_FUNCS, JSON_SRFS } from './json-fns';
import { genericArith, genericNumericCast, NUMERIC_FUNCS } from './numeric-fns';
import { SYSTEM_FUNCS, SYSTEM_SRFS } from './system-fns';
import { TEXT_FUNCS } from './text-fns';

const SRC_MAP = new Map<string, FnImpl>();
const SRF_MAP = new Map<string, FnImpl>();

for (const table of [NUMERIC_FUNCS, TEXT_FUNCS, DATETIME_FUNCS, JSON_FUNCS, JSON_PATH_FUNCS, ARRAY_FUNCS, SYSTEM_FUNCS]) {
  for (const [k, v] of Object.entries(table)) {
    SRC_MAP.set(k, v);
  }
}
// builtin SQL-language functions keyed by their prosrc body
// textanycat(text, anynonarray) / anytextcat(anynonarray, text): the non-text side goes through its output function
SRC_MAP.set('select $1 operator(pg_catalog.||) $2::pg_catalog.text', (a, fc) => (a[0] as string) + outputValue(fc.argTypes[1], a[1], fc.st.session.io));
SRC_MAP.set('select $1::pg_catalog.text operator(pg_catalog.||) $2', (a, fc) => outputValue(fc.argTypes[0], a[0], fc.st.session.io) + (a[1] as string));
for (const table of [JSON_SRFS, ARRAY_SRFS, SYSTEM_SRFS]) {
  for (const [k, v] of Object.entries(table)) {
    SRF_MAP.set(k, v);
  }
}

/** Length coercion / simple conversion functions used by pg_cast entries. */
const CAST_SRC: Record<string, FnImpl> = {
  varchar: (a) => applyCharTypmod(a[0] as string, TypeOid.varchar, a[1] as number, a[2] === true),
  bpchar: (a) => applyCharTypmod(a[0] as string, TypeOid.bpchar, a[1] as number, a[2] === true),
  numeric: (a) => (a[0] as PgNumeric).applyTypmod(a[1] as number),
  timestamp_scale: (a) => roundTimestamp(a[0] as number, a[1] as number),
  timestamptz_scale: (a) => roundTimestamp(a[0] as number, a[1] as number),
  time_scale: (a) => roundTime(a[0] as number, a[1] as number),
  timetz_scale: (a) => ({ ...(a[0] as { us: number; zone: number }), us: roundTime((a[0] as { us: number }).us, a[1] as number) }),
  interval_scale: (a) => {
    const iv = a[0] as Interval;
    const typmod = a[1] as number;
    if (typmod < 0) {
      return iv;
    }
    const precision = typmod & 0xffff;
    const range = (typmod >> 16) & 0x7fff;
    let { months, days, us } = iv;
    const YEAR = 1 << 2;
    const MONTH = 1 << 1;
    const DAY = 1 << 3;
    const HOUR = 1 << 10;
    const MINUTE = 1 << 11;
    if (range !== 0x7fff) {
      if (range === YEAR) {
        months = Math.trunc(months / 12) * 12;
        days = 0;
        us = 0;
      } else if (range === MONTH || range === (YEAR | MONTH)) {
        days = 0;
        us = 0;
      } else if (range === DAY) {
        us = 0;
      } else if (range === HOUR || range === (DAY | HOUR)) {
        us = Math.trunc(us / 3600000000) * 3600000000;
      } else if (range === MINUTE || range === (DAY | HOUR | MINUTE) || range === (HOUR | MINUTE)) {
        us = Math.trunc(us / 60000000) * 60000000;
      }
    }
    if (precision !== 0xffff && precision < 6) {
      const scale = 10 ** (6 - precision);
      us = us >= 0 ? Math.floor(us / scale + 0.5) * scale : -Math.floor(-us / scale + 0.5) * scale;
    }
    return { months, days, us };
  },
  rtrim1: (a) => (a[0] as string).replace(/ +$/, ''),
  text_name: (a) => truncateName(a[0] as string),
  name_text: (a) => a[0],
  bpchar_name: (a) => truncateName((a[0] as string).replace(/ +$/, '')),
  name_bpchar: (a) => a[0],
  char_text: (a) => a[0],
  text_char: (a) => (a[0] as string).slice(0, 1),
  char_bpchar: (a) => a[0],
  booltext: (a) => (a[0] ? 'true' : 'false'),
  i8tooid: (a) => Number(a[0]),
  oidtoi8: (a) => BigInt(a[0] as number),
  int4_bool: (a) => a[0] !== 0,
  bool_int4: (a) => (a[0] ? 1 : 0),
  chartoi4: (a) => ((a[0] as string).length ? (a[0] as string).charCodeAt(0) : 0),
  i4tochar: (a) => String.fromCharCode((a[0] as number) & 0xff),
};

function truncateName(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= 63) {
    return s;
  }
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const l = Buffer.byteLength(ch);
    if (bytes + l > 63) {
      break;
    }
    bytes += l;
    out += ch;
  }
  return out;
}

/** Builtin SQL-language functions (empty prosrc) and name-keyed fallbacks: name/nargs. */
const NAME_MAP: Record<string, FnImpl> = {
  'substring/3': (a) => {
    // substring(text similar pattern escape)
    const re = new RegExp(similarPattern(a[1] as string, a[2] as string | null), 'su');
    const m = re.exec(a[0] as string);
    if (!m) {
      return null;
    }
    return m.length > 1 && m[1] !== undefined ? m[1] : m[0];
  },
  'age/1': (a, fc) => {
    const now = fc.st.session.transactionTimestamp();
    const zone = fc.st.session.io.zone;
    if (fc.argTypes[0] === TypeOid.timestamptz) {
      const local = now + (zone.fixed ?? 0) * USECS_PER_SEC;
      void local;
      const midnight = Math.floor((now + offsetOf(fc, now) * USECS_PER_SEC) / USECS_PER_DAY) * USECS_PER_DAY - offsetOf(fc, now) * USECS_PER_SEC;
      return ageTimestamps(midnight, a[0] as number, zone);
    }
    const localNow = now + offsetOf(fc, now) * USECS_PER_SEC;
    const midnight = Math.floor(localNow / USECS_PER_DAY) * USECS_PER_DAY;
    return ageTimestamps(midnight, a[0] as number, null);
  },
  'date_part/2': (a, fc) => {
    // date_part(text, date) is SQL: date_part($1, $2::timestamp)
    const impl = SRC_MAP.get('timestamp_part')!;
    return impl([a[0], (a[1] as number) * USECS_PER_DAY], fc);
  },
  'obj_description/1': (a, fc) => fc.st.session.catalogFns.objDescription(a[0] as number, null),
  'col_description/2': (a, fc) => fc.st.session.catalogFns.colDescription(a[0] as number, a[1] as number),
  'shobj_description/2': () => null,
  'log/1': (a) => {
    const n = a[0] as PgNumeric;
    return PgNumeric.parse(Math.log10(n.toNumber()).toFixed(16));
  },
  'round/1': (a) => (a[0] as PgNumeric).round(0),
  'trunc/1': (a) => (a[0] as PgNumeric).trunc(0),
  'to_timestamp/1': (a, fc) => SRC_MAP.get('float8_timestamptz')!(a, fc),
  'timezone/1': (a, fc) => SRC_MAP.get('timestamptz_timestamp')!(a, fc),
  'bit_length/1': (a) => Buffer.byteLength(a[0] as string) * 8,
  'overlay/3': (a, fc) => SRC_MAP.get('textoverlay_no_len')!(a, fc),
  'overlay/4': (a, fc) => SRC_MAP.get('textoverlay')!(a, fc),
  'pg_sleep_for/1': (a, fc) => {
    const iv = a[0] as Interval;
    fc.st.session.requestSleep((iv.days * USECS_PER_DAY + iv.us) / 1000, fc.st);
    return '';
  },
  'pg_sleep_until/1': (a, fc) => {
    const ms = ((a[0] as number) - fc.st.session.clockTimestamp()) / 1000;
    fc.st.session.requestSleep(Math.max(0, ms), fc.st);
    return '';
  },
  'unaccent/1': (a, fc) => SRC_MAP.get('unaccent_dict')!(a, fc),
  'unaccent/2': (a, fc) => SRC_MAP.get('unaccent_dict')!(a, fc),
};

function offsetOf(fc: { st: { session: { io: { zone: import('../../types/datetime').ZoneSpec } } } }, ts: number): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../types/datetime').zoneOffsetAt(fc.st.session.io.zone, ts);
}

function similarPattern(pattern: string, escape: string | null): string {
  // SQL regex with #" markers around the returned portion
  const esc = escape ?? '\\';
  let out = '^';
  let i = 0;
  let markers = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === esc && pattern[i + 1] === '"') {
      out += markers === 0 ? '(?:' : ')';
      out += markers === 0 ? '' : '';
      if (markers === 0) {
        out = out.slice(0, -3) + '(?:.*?)?';
      }
      markers++;
      i += 2;
      continue;
    }
    if (c === '%') {
      out += '.*?';
    } else if (c === '_') {
      out += '.';
    } else if (c === esc) {
      out += '\\' + pattern[i + 1];
      i++;
    } else {
      out += /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
    }
    i++;
  }
  return out + '$';
}

function isCastNode(node: TExpr): boolean {
  return node.k === 'func' && (node.format === 'explicit_cast' || node.format === 'implicit_cast');
}

export function lookupFunction(src: string, node: TExpr, typeOps: TypeOps, argTypes: number[], name: string): FnImpl | null {
  const direct = SRC_MAP.get(src);
  if (direct && !(node.k === 'op' && src === '')) {
    return direct;
  }
  if (isCastNode(node) || CAST_SRC[src]) {
    const cast = CAST_SRC[src];
    if (cast) {
      return cast;
    }
    const g = genericNumericCast(argTypes[0], node.type, node.typmod);
    if (g) {
      return g;
    }
  }
  if (node.k === 'op') {
    const g = genericArith(name, argTypes, node.type);
    if (g) {
      return g;
    }
  }
  if (node.k === 'func') {
    // numeric-type conversion functions called by name, e.g. int8(x), float8(x)
    const g = argTypes.length === 1 && ['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(name) ? genericNumericCast(argTypes[0], node.type, -1) : null;
    if (g) {
      return g;
    }
    const byName = NAME_MAP[name + '/' + argTypes.length];
    if (byName) {
      return byName;
    }
  }
  void typeOps;
  return null;
}

export function lookupSrf(src: string, name: string): FnImpl | null {
  return SRF_MAP.get(src) ?? SRF_MAP.get(name) ?? null;
}

export function notImplemented(what: string): PgError {
  return new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: ${what} is not implemented`);
}
