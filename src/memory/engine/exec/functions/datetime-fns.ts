import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import {
  ageTimestamps,
  date2j,
  DAY_NAMES,
  daysInMonth,
  EPOCH_DIFF_US,
  Interval,
  intervalNegate,
  isLeap,
  j2date,
  j2day,
  justifyDays,
  justifyHours,
  justifyInterval,
  localToUtcOffset,
  MONTH_NAMES,
  parseInterval,
  POSTGRES_EPOCH_JDATE,
  resolveZone,
  timestampDiff,
  timestampPlusInterval,
  timestampToTm,
  TimeTz,
  Tm,
  tmToTimestamp,
  USECS_PER_DAY,
  USECS_PER_HOUR,
  USECS_PER_MINUTE,
  USECS_PER_SEC,
  ZoneSpec,
  zoneOffsetAt,
  formatZoneOffset,
} from '../../types/datetime';
import { PgNumeric } from '../../types/numeric';
import { FnCall, FnImpl } from '../runtime';
import { checkInt4 } from '../typeops';
import { rint } from './numeric-fns';
import { generateUuidV7, realTimeNsAscending } from './text-fns';

function sessionZone(fc: FnCall): ZoneSpec {
  return fc.st.session.io.zone;
}

function zoneArg(name: string): ZoneSpec {
  const z = resolveZone(name);
  if (!z) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `time zone "${name}" not recognized`);
  }
  return z;
}

function tsRangeCheck(v: number): number {
  if (Number.isFinite(v) && (v < -211813488000000000 || v >= 9223371331200000000)) {
    throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'timestamp out of range');
  }
  return v;
}

export function dateToTimestamp(d: number): number {
  return Number.isFinite(d) ? d * USECS_PER_DAY : d;
}

export function dateToTimestamptz(d: number, zone: ZoneSpec): number {
  if (!Number.isFinite(d)) {
    return d;
  }
  const local = d * USECS_PER_DAY;
  return local - localToUtcOffset(zone, local) * USECS_PER_SEC;
}

export function timestamptzToTimestamp(ts: number, zone: ZoneSpec): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  return ts + zoneOffsetAt(zone, ts) * USECS_PER_SEC;
}

export function timestampToTimestamptz(ts: number, zone: ZoneSpec): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  return ts - localToUtcOffset(zone, ts) * USECS_PER_SEC;
}

function timestampToDate(ts: number): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  return Math.floor(ts / USECS_PER_DAY);
}

// ---------------------------------------------------------------------------
// date_trunc
// ---------------------------------------------------------------------------

function truncTm(field: string, tm: Tm): Tm {
  const f = field.toLowerCase();
  const t = { ...tm };
  switch (f) {
    case 'millennium':
      t.year = t.year > 0 ? Math.floor((t.year - 1) / 1000) * 1000 + 1 : -(Math.floor((-t.year) / 1000) * 1000) + 1;
      t.month = 1;
      t.day = 1;
      t.hour = t.minute = t.second = t.fsec = 0;
      return t;
    case 'century':
      t.year = t.year > 0 ? Math.floor((t.year - 1) / 100) * 100 + 1 : -(Math.floor((-t.year) / 100) * 100) + 1;
      t.month = 1;
      t.day = 1;
      t.hour = t.minute = t.second = t.fsec = 0;
      return t;
    case 'decade':
      t.year = t.year > 0 ? Math.floor(t.year / 10) * 10 : -(Math.floor((8 - (t.year - 1)) / 10) * 10);
      t.month = 1;
      t.day = 1;
      t.hour = t.minute = t.second = t.fsec = 0;
      return t;
    case 'year':
      t.month = 1;
    // fallthrough
    case 'quarter':
      if (f === 'quarter') {
        t.month = 3 * Math.floor((t.month - 1) / 3) + 1;
      }
    // fallthrough
    case 'month':
      t.day = 1;
    // fallthrough
    case 'day':
      t.hour = 0;
    // fallthrough
    case 'hour':
      t.minute = 0;
    // fallthrough
    case 'minute':
      t.second = 0;
    // fallthrough
    case 'second':
      t.fsec = 0;
      return t;
    case 'milliseconds':
      t.fsec = Math.floor(t.fsec / 1000) * 1000;
      return t;
    case 'microseconds':
      return t;
    case 'week': {
      const jd = date2j(t.year, t.month, t.day);
      const dow = j2day(jd);
      const monday = jd - ((dow + 6) % 7);
      const [y, m, d] = j2date(monday);
      return { year: y, month: m, day: d, hour: 0, minute: 0, second: 0, fsec: 0 };
    }
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `unit "${field}" not supported for type timestamp without time zone`);
}

function truncUnitError(field: string, typeName: string): PgError {
  return new PgError(SqlState.FEATURE_NOT_SUPPORTED, `unit "${field}" not supported for type ${typeName}`);
}

const VALID_UNITS = new Set(['microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'decade', 'century', 'millennium']);

function normUnit(u: string): string {
  const l = u.toLowerCase();
  const map: Record<string, string> = {
    microsecond: 'microseconds',
    us: 'microseconds',
    usec: 'microseconds',
    usecs: 'microseconds',
    millisecond: 'milliseconds',
    ms: 'milliseconds',
    msec: 'milliseconds',
    msecs: 'milliseconds',
    seconds: 'second',
    sec: 'second',
    secs: 'second',
    s: 'second',
    minutes: 'minute',
    min: 'minute',
    mins: 'minute',
    m: 'minute',
    hours: 'hour',
    hr: 'hour',
    hrs: 'hour',
    h: 'hour',
    days: 'day',
    d: 'day',
    weeks: 'week',
    w: 'week',
    months: 'month',
    mon: 'month',
    mons: 'month',
    quarters: 'quarter',
    qtr: 'quarter',
    years: 'year',
    yr: 'year',
    yrs: 'year',
    y: 'year',
    decades: 'decade',
    dec: 'decade',
    centuries: 'century',
    cent: 'century',
    c: 'century',
    millennia: 'millennium',
    millenniums: 'millennium',
    mil: 'millennium',
  };
  return map[l] ?? l;
}

function timestampTrunc(unit: string, ts: number, typeName: string): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  const u = normUnit(unit);
  if (!VALID_UNITS.has(u)) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unit "${unit}" not recognized for type ${typeName}`);
  }
  return tmToTimestamp(truncTm(u, timestampToTm(ts)));
}

function timestamptzTrunc(unit: string, ts: number, zone: ZoneSpec): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  const u = normUnit(unit);
  if (!VALID_UNITS.has(u)) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unit "${unit}" not recognized for type timestamp with time zone`);
  }
  const off = zoneOffsetAt(zone, ts);
  const local = ts + off * USECS_PER_SEC;
  const truncated = tmToTimestamp(truncTm(u, timestampToTm(local)));
  if (u === 'microseconds' || u === 'milliseconds' || u === 'second' || u === 'minute' || u === 'hour') {
    // keep the original offset for sub-day truncation (no DST re-resolution) like PostgreSQL
    return truncated - localToUtcOffset(zone, truncated) * USECS_PER_SEC;
  }
  return truncated - localToUtcOffset(zone, truncated) * USECS_PER_SEC;
}

function intervalTrunc(unit: string, iv: Interval): Interval {
  const u = normUnit(unit);
  let months = iv.months;
  let days = iv.days;
  let us = iv.us;
  switch (u) {
    case 'millennium':
      months = Math.trunc(months / 12000) * 12000;
      days = 0;
      us = 0;
      break;
    case 'century':
      months = Math.trunc(months / 1200) * 1200;
      days = 0;
      us = 0;
      break;
    case 'decade':
      months = Math.trunc(months / 120) * 120;
      days = 0;
      us = 0;
      break;
    case 'year':
      months = Math.trunc(months / 12) * 12;
      days = 0;
      us = 0;
      break;
    case 'quarter':
      months = Math.trunc(months / 3) * 3;
      days = 0;
      us = 0;
      break;
    case 'month':
      days = 0;
      us = 0;
      break;
    case 'day':
      us = 0;
      break;
    case 'hour':
      us = Math.trunc(us / USECS_PER_HOUR) * USECS_PER_HOUR;
      break;
    case 'minute':
      us = Math.trunc(us / USECS_PER_MINUTE) * USECS_PER_MINUTE;
      break;
    case 'second':
      us = Math.trunc(us / USECS_PER_SEC) * USECS_PER_SEC;
      break;
    case 'milliseconds':
      us = Math.trunc(us / 1000) * 1000;
      break;
    case 'microseconds':
      break;
    default:
      throw truncUnitError(unit, 'interval');
  }
  return { months, days, us };
}

// ---------------------------------------------------------------------------
// extract / date_part
// ---------------------------------------------------------------------------

function isoWeekInfo(y: number, m: number, d: number): { isoYear: number; week: number; isoDow: number } {
  const jd = date2j(y, m, d);
  const dow = j2day(jd);
  const isoDow = dow === 0 ? 7 : dow;
  // Thursday of this week determines the ISO year
  const thursday = jd - isoDow + 4;
  const [ty] = j2date(thursday);
  const jan1 = date2j(ty, 1, 1);
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return { isoYear: ty, week, isoDow };
}

function extractFromTm(field: string, tm: Tm, ts: number | null, typeName: string, zoneOff: number | null, isDate: boolean): PgNumeric {
  const f = normUnit(field);
  const num = (v: number) => PgNumeric.fromInt(v);
  const secWithFrac = (): PgNumeric => PgNumeric.make(false, BigInt(tm.second * USECS_PER_SEC + tm.fsec), 6);
  switch (f) {
    case 'microseconds':
      if (isDate) {
        break;
      }
      return num(tm.second * USECS_PER_SEC + tm.fsec);
    case 'milliseconds':
      if (isDate) {
        break;
      }
      return PgNumeric.make(false, BigInt(tm.second * USECS_PER_SEC + tm.fsec), 3);
    case 'second':
      if (isDate) {
        break;
      }
      return secWithFrac();
    case 'minute':
      if (isDate) {
        break;
      }
      return num(tm.minute);
    case 'hour':
      if (isDate) {
        break;
      }
      return num(tm.hour);
    case 'day':
      return num(tm.day);
    case 'month':
      return num(tm.month);
    case 'quarter':
      return num(Math.floor((tm.month - 1) / 3) + 1);
    case 'week':
      return num(isoWeekInfo(tm.year, tm.month, tm.day).week);
    case 'year':
      return num(tm.year > 0 ? tm.year : tm.year - 1);
    case 'decade':
      return num(tm.year >= 0 ? Math.floor(tm.year / 10) : -Math.floor((8 - (tm.year - 1)) / 10));
    case 'century':
      return num(tm.year > 0 ? Math.floor((tm.year + 99) / 100) : -Math.floor((99 - (tm.year - 1)) / 100));
    case 'millennium':
      return num(tm.year > 0 ? Math.floor((tm.year + 999) / 1000) : -Math.floor((999 - (tm.year - 1)) / 1000));
    case 'dow':
      return num(j2day(date2j(tm.year, tm.month, tm.day)));
    case 'isodow':
      return num(isoWeekInfo(tm.year, tm.month, tm.day).isoDow);
    case 'doy':
      return num(date2j(tm.year, tm.month, tm.day) - date2j(tm.year, 1, 1) + 1);
    case 'isoyear': {
      const y = isoWeekInfo(tm.year, tm.month, tm.day).isoYear;
      return num(y > 0 ? y : y - 1);
    }
    case 'julian': {
      const jd = date2j(tm.year, tm.month, tm.day);
      if (isDate) {
        return num(jd);
      }
      const frac = (tm.hour * USECS_PER_HOUR + tm.minute * USECS_PER_MINUTE + tm.second * USECS_PER_SEC + tm.fsec) / USECS_PER_DAY;
      return PgNumeric.parse(String(jd)).add(PgNumeric.divScaled(PgNumeric.fromInt(tm.hour * 3600 + tm.minute * 60 + tm.second).mul(PgNumeric.fromInt(USECS_PER_SEC)).add(PgNumeric.fromInt(tm.fsec)), PgNumeric.fromBigInt(BigInt(USECS_PER_DAY)), 16, true).trimScale());
      void frac;
    }
    case 'epoch': {
      if (ts === null) {
        break;
      }
      if (isDate) {
        return num(ts / USECS_PER_DAY * 86400 + (POSTGRES_EPOCH_JDATE - 2440588) * 86400);
      }
      const us = ts + EPOCH_DIFF_US - (zoneOff === null ? 0 : 0);
      return PgNumeric.make(us < 0, BigInt(Math.abs(Math.round(us))), 6);
    }
    case 'timezone':
      if (zoneOff !== null) {
        return num(zoneOff);
      }
      break;
    case 'timezone_hour':
      if (zoneOff !== null) {
        return num(Math.trunc(zoneOff / 3600));
      }
      break;
    case 'timezone_minute':
      if (zoneOff !== null) {
        return num(Math.trunc((zoneOff % 3600) / 60));
      }
      break;
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `unit "${field}" not supported for type ${typeName}`);
}

function extractTimestamp(field: string, ts: number, typeName: string, zone: ZoneSpec | null): PgNumeric {
  if (!Number.isFinite(ts)) {
    const f = normUnit(field);
    if (['epoch', 'julian', 'year', 'isoyear', 'decade', 'century', 'millennium'].includes(f)) {
      return ts > 0 ? PgNumeric.PINF : PgNumeric.NINF;
    }
    return null as unknown as PgNumeric;
  }
  let off: number | null = null;
  let local = ts;
  if (zone) {
    off = zoneOffsetAt(zone, ts);
    local = ts + off * USECS_PER_SEC;
  }
  return extractFromTm(field, timestampToTm(local), ts, typeName, off, false);
}

function extractInterval(field: string, iv: Interval): PgNumeric {
  const f = normUnit(field);
  let time = iv.us;
  const hour = Math.trunc(time / USECS_PER_HOUR);
  time -= hour * USECS_PER_HOUR;
  const minute = Math.trunc(time / USECS_PER_MINUTE);
  time -= minute * USECS_PER_MINUTE;
  const usec = time;
  const n = (v: number) => PgNumeric.fromInt(v);
  switch (f) {
    case 'microseconds':
      return n(usec);
    case 'milliseconds':
      return PgNumeric.make(usec < 0, BigInt(Math.abs(usec)), 3);
    case 'second':
      return PgNumeric.make(usec < 0, BigInt(Math.abs(usec)), 6);
    case 'minute':
      return n(minute);
    case 'hour':
      return n(hour);
    case 'day':
      return n(iv.days);
    case 'week':
      return n(Math.trunc(iv.days / 7));
    case 'month':
      return n(iv.months % 12);
    case 'quarter':
      return n(Math.trunc((iv.months % 12) / 3) + 1);
    case 'year':
      return n(Math.trunc(iv.months / 12));
    case 'decade':
      return n(Math.trunc(iv.months / 120));
    case 'century':
      return n(Math.trunc(iv.months / 1200));
    case 'millennium':
      return n(Math.trunc(iv.months / 12000));
    case 'epoch': {
      // days*86400 + months*30*86400 (365.25 days per year for the year part)
      const years = Math.trunc(iv.months / 12);
      const months = iv.months % 12;
      const secs =
        PgNumeric.fromInt(years).mul(PgNumeric.parse('31557600')).add(PgNumeric.fromInt(months * 30 * 86400)).add(PgNumeric.fromInt(iv.days * 86400));
      return secs.add(PgNumeric.make(iv.us < 0, BigInt(Math.abs(iv.us)), 6));
    }
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `unit "${field}" not supported for type interval`);
}

function toFloat(n: PgNumeric | null): number | null {
  return n === null ? null : n.toNumber();
}

// ---------------------------------------------------------------------------
// to_char
// ---------------------------------------------------------------------------

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ordinalSuffix(n: number): string {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) {
    return 'th';
  }
  switch (Math.abs(n) % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
  }
  return 'th';
}

export function formatTimestampWithPattern(ts: number, fmt: string, zone: ZoneSpec | null, isInterval = false, iv?: Interval): string {
  let tm: Tm;
  let off = 0;
  if (isInterval && iv) {
    let time = iv.us;
    const hour = Math.trunc(time / USECS_PER_HOUR);
    time -= hour * USECS_PER_HOUR;
    const minute = Math.trunc(time / USECS_PER_MINUTE);
    time -= minute * USECS_PER_MINUTE;
    const second = Math.trunc(time / USECS_PER_SEC);
    tm = { year: Math.trunc(iv.months / 12), month: iv.months % 12, day: iv.days, hour, minute, second, fsec: time - second * USECS_PER_SEC };
  } else {
    if (zone) {
      off = zoneOffsetAt(zone, ts);
    }
    tm = timestampToTm(ts + off * USECS_PER_SEC);
  }
  const patterns = [
    'HH24', 'HH12', 'HH', 'MI', 'SS', 'MS', 'US', 'SSSSS', 'SSSS', 'AM', 'PM', 'am', 'pm', 'A.M.', 'P.M.', 'a.m.', 'p.m.',
    'Y,YYY', 'YYYY', 'YYY', 'YY', 'Y', 'IYYY', 'IYY', 'IY', 'I', 'BC', 'AD', 'bc', 'ad', 'B.C.', 'A.D.',
    'MONTH', 'Month', 'month', 'MON', 'Mon', 'mon', 'MM', 'DAY', 'Day', 'day', 'DY', 'Dy', 'dy', 'DDD', 'IDDD', 'DD', 'D', 'ID',
    'WW', 'IW', 'W', 'CC', 'J', 'Q', 'RM', 'rm', 'TZH', 'TZM', 'TZ', 'tz', 'OF', 'FF1', 'FF2', 'FF3', 'FF4', 'FF5', 'FF6',
  ];
  // the longest keyword at a position wins (SSSSS over SS, IW over I)
  const patternsByLength = [...patterns].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    let fm = false;
    let th: '' | 'TH' | 'th' = '';
    if (fmt.startsWith('FM', i) || fmt.startsWith('fm', i)) {
      fm = true;
      i += 2;
    }
    if (fmt[i] === '"') {
      const end = fmt.indexOf('"', i + 1);
      out += fmt.slice(i + 1, end < 0 ? fmt.length : end);
      i = end < 0 ? fmt.length : end + 1;
      continue;
    }
    if (fmt[i] === '\\' && i + 1 < fmt.length) {
      out += fmt[i + 1];
      i += 2;
      continue;
    }
    const p = patternsByLength.find((x) => fmt.startsWith(x, i));
    if (!p) {
      out += fmt[i];
      i++;
      continue;
    }
    i += p.length;
    if (fmt.startsWith('TH', i)) {
      th = 'TH';
      i += 2;
    } else if (fmt.startsWith('th', i)) {
      th = 'th';
      i += 2;
    }
    const padNum = (v: number, width: number): string => {
      const s = String(Math.abs(v));
      const body = fm ? s : s.padStart(width, '0');
      return (v < 0 ? '-' : '') + body;
    };
    const jd = isInterval ? 0 : date2j(tm.year, tm.month, tm.day);
    let s = '';
    let numeric: number | null = null;
    switch (p) {
      case 'HH24':
        numeric = tm.hour;
        s = padNum(tm.hour, 2);
        break;
      case 'HH12':
      case 'HH': {
        const h = tm.hour % 12 === 0 ? 12 : tm.hour % 12;
        numeric = h;
        s = padNum(h, 2);
        break;
      }
      case 'MI':
        numeric = tm.minute;
        s = padNum(tm.minute, 2);
        break;
      case 'SS':
        numeric = tm.second;
        s = padNum(tm.second, 2);
        break;
      case 'MS':
        s = padNum(Math.floor(tm.fsec / 1000), 3);
        break;
      case 'US':
        s = padNum(tm.fsec, 6);
        break;
      case 'FF1':
      case 'FF2':
      case 'FF3':
      case 'FF4':
      case 'FF5':
      case 'FF6': {
        const n = parseInt(p[2], 10);
        s = String(tm.fsec).padStart(6, '0').slice(0, n);
        break;
      }
      case 'SSSSS':
      case 'SSSS':
        s = String(tm.hour * 3600 + tm.minute * 60 + tm.second);
        break;
      case 'AM':
      case 'PM':
        s = tm.hour >= 12 ? 'PM' : 'AM';
        break;
      case 'am':
      case 'pm':
        s = tm.hour >= 12 ? 'pm' : 'am';
        break;
      case 'A.M.':
      case 'P.M.':
        s = tm.hour >= 12 ? 'P.M.' : 'A.M.';
        break;
      case 'a.m.':
      case 'p.m.':
        s = tm.hour >= 12 ? 'p.m.' : 'a.m.';
        break;
      case 'Y,YYY': {
        const y = tm.year <= 0 && !isInterval ? 1 - tm.year : tm.year;
        s = `${Math.floor(y / 1000)},${String(y % 1000).padStart(3, '0')}`;
        break;
      }
      case 'YYYY':
      case 'IYYY': {
        let y = p === 'IYYY' ? isoWeekInfo(tm.year, tm.month, tm.day).isoYear : tm.year;
        if (y <= 0 && !isInterval) {
          y = 1 - y;
        }
        numeric = y;
        s = padNum(y, 4);
        break;
      }
      case 'YYY':
      case 'IYY': {
        const y = p === 'IYY' ? isoWeekInfo(tm.year, tm.month, tm.day).isoYear : tm.year;
        s = padNum(Math.abs(y) % 1000, 3);
        break;
      }
      case 'YY':
      case 'IY': {
        const y = p === 'IY' ? isoWeekInfo(tm.year, tm.month, tm.day).isoYear : tm.year;
        s = padNum(Math.abs(y) % 100, 2);
        break;
      }
      case 'Y':
      case 'I': {
        const y = p === 'I' ? isoWeekInfo(tm.year, tm.month, tm.day).isoYear : tm.year;
        s = String(Math.abs(y) % 10);
        break;
      }
      case 'BC':
      case 'AD':
        s = tm.year <= 0 ? 'BC' : 'AD';
        break;
      case 'bc':
      case 'ad':
        s = tm.year <= 0 ? 'bc' : 'ad';
        break;
      case 'B.C.':
      case 'A.D.':
        s = tm.year <= 0 ? 'B.C.' : 'A.D.';
        break;
      case 'MONTH':
      case 'Month':
      case 'month': {
        const name = MONTH_NAMES[tm.month - 1] ?? '';
        const cased = p === 'MONTH' ? name.toUpperCase() : p === 'Month' ? capitalize(name) : name;
        s = fm ? cased : cased.padEnd(9, ' ');
        break;
      }
      case 'MON':
      case 'Mon':
      case 'mon': {
        const name = MONTHS_ABBR[tm.month - 1] ?? '';
        s = p === 'MON' ? name.toUpperCase() : p === 'Mon' ? name : name.toLowerCase();
        break;
      }
      case 'MM':
        numeric = tm.month;
        s = padNum(tm.month, 2);
        break;
      case 'DAY':
      case 'Day':
      case 'day': {
        const name = DAY_NAMES[j2day(jd)];
        const cased = p === 'DAY' ? name.toUpperCase() : p === 'Day' ? capitalize(name) : name;
        s = fm ? cased : cased.padEnd(9, ' ');
        break;
      }
      case 'DY':
      case 'Dy':
      case 'dy': {
        const name = DAYS_ABBR[j2day(jd)];
        s = p === 'DY' ? name.toUpperCase() : p === 'Dy' ? name : name.toLowerCase();
        break;
      }
      case 'DDD':
        numeric = jd - date2j(tm.year, 1, 1) + 1;
        s = padNum(numeric, 3);
        break;
      case 'IDDD': {
        const info = isoWeekInfo(tm.year, tm.month, tm.day);
        numeric = (info.week - 1) * 7 + info.isoDow;
        s = padNum(numeric, 3);
        break;
      }
      case 'DD':
        numeric = tm.day;
        s = padNum(tm.day, 2);
        break;
      case 'D':
        numeric = j2day(jd) + 1;
        s = String(numeric);
        break;
      case 'ID':
        numeric = isoWeekInfo(tm.year, tm.month, tm.day).isoDow;
        s = String(numeric);
        break;
      case 'WW':
        numeric = Math.floor((jd - date2j(tm.year, 1, 1)) / 7) + 1;
        s = padNum(numeric, 2);
        break;
      case 'IW':
        numeric = isoWeekInfo(tm.year, tm.month, tm.day).week;
        s = padNum(numeric, 2);
        break;
      case 'W':
        numeric = Math.floor((tm.day - 1) / 7) + 1;
        s = String(numeric);
        break;
      case 'CC':
        numeric = tm.year > 0 ? Math.floor((tm.year + 99) / 100) : -Math.floor((99 - (tm.year - 1)) / 100);
        s = padNum(numeric, 2);
        break;
      case 'J':
        numeric = jd;
        s = String(jd);
        break;
      case 'Q':
        numeric = Math.floor((tm.month - 1) / 3) + 1;
        s = String(numeric);
        break;
      case 'RM':
      case 'rm': {
        const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
        const r = romans[tm.month - 1] ?? '';
        const cased = p === 'RM' ? r : r.toLowerCase();
        s = fm ? cased : cased.padEnd(4, ' ');
        break;
      }
      case 'TZH':
        s = (off < 0 ? '-' : '+') + String(Math.floor(Math.abs(off) / 3600)).padStart(2, '0');
        break;
      case 'TZM':
        s = String(Math.floor((Math.abs(off) % 3600) / 60)).padStart(2, '0');
        break;
      case 'TZ':
      case 'tz': {
        let abbr = zone ? zoneAbbreviation(zone, ts) : '';
        if (p === 'tz') {
          abbr = abbr.toLowerCase();
        }
        s = abbr;
        break;
      }
      case 'OF':
        s = zone ? formatZoneOffset(off) : '';
        break;
    }
    if (th && numeric !== null) {
      s += th === 'TH' ? ordinalSuffix(numeric).toUpperCase() : ordinalSuffix(numeric);
    }
    out += s;
  }
  return out;
}

function zoneAbbreviation(zone: ZoneSpec, ts: number): string {
  if (zone.fixed !== null) {
    return zone.fixed === 0 && /utc|gmt|z/i.test(zone.name) ? zone.name.toUpperCase() : formatZoneOffset(zone.fixed);
  }
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone.name, timeZoneName: 'short' });
    const part = f.formatToParts((ts + EPOCH_DIFF_US) / 1000).find((x) => x.type === 'timeZoneName');
    const name = part?.value ?? '';
    if (/^GMT[+-]/.test(name)) {
      return formatZoneOffset(zoneOffsetAt(zone, ts));
    }
    return name === 'GMT' ? 'GMT' : name;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// to_timestamp / to_date parsing
// ---------------------------------------------------------------------------

function parseWithPattern(input: string, fmt: string, fnName: string): Tm & { tzOffset?: number } {
  const tm: Tm & { tzOffset?: number; pm?: boolean; bc?: boolean; doy?: number } = { year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, fsec: 0 };
  let pos = 0;
  let i = 0;
  const skipSpaces = () => {
    while (pos < input.length && input[pos] === ' ') {
      pos++;
    }
  };
  const readInt = (maxLen: number): number => {
    skipSpaces();
    const m = new RegExp(`^[+-]?\\d{1,${maxLen}}`).exec(input.slice(pos));
    if (!m) {
      throw new PgError(SqlState.INVALID_DATETIME_FORMAT, `invalid value "${input.slice(pos, pos + maxLen)}" for "${fmt.slice(i - 2, i)}"`, {
        detail: 'Value must be an integer.',
      });
    }
    pos += m[0].length;
    return parseInt(m[0], 10);
  };
  const patterns = ['HH24', 'HH12', 'HH', 'MI', 'SS', 'MS', 'US', 'AM', 'PM', 'am', 'pm', 'YYYY', 'YY', 'MONTH', 'Month', 'month', 'MON', 'Mon', 'mon', 'MM', 'DDD', 'DD', 'TZH', 'TZM', 'FF1', 'FF2', 'FF3', 'FF4', 'FF5', 'FF6', 'Y,YYY', 'BC', 'AD', 'J', 'OF', 'TZ'];
  const patternsByLength = [...patterns].sort((a, b) => b.length - a.length);
  while (i < fmt.length) {
    if (fmt.startsWith('FM', i)) {
      i += 2;
      continue;
    }
    const p = patternsByLength.find((x) => fmt.startsWith(x, i));
    if (!p) {
      if (fmt[i] === '"') {
        const end = fmt.indexOf('"', i + 1);
        pos += end - i - 1;
        i = end + 1;
        continue;
      }
      if (fmt[i] !== ' ' && pos < input.length && !/[0-9A-Za-z]/.test(input[pos])) {
        pos++;
      } else if (fmt[i] === ' ') {
        skipSpaces();
      } else if (pos < input.length && input[pos] === fmt[i]) {
        pos++;
      }
      i++;
      continue;
    }
    i += p.length;
    switch (p) {
      case 'HH24':
        tm.hour = readInt(2);
        break;
      case 'HH12':
      case 'HH':
        tm.hour = readInt(2);
        break;
      case 'MI':
        tm.minute = readInt(2);
        break;
      case 'SS':
        tm.second = readInt(2);
        break;
      case 'MS':
        tm.fsec = readInt(3) * 1000;
        break;
      case 'US':
        tm.fsec = readInt(6);
        break;
      case 'FF1':
      case 'FF2':
      case 'FF3':
      case 'FF4':
      case 'FF5':
      case 'FF6': {
        const n = parseInt(p[2], 10);
        const m = new RegExp(`^\\d{1,${n}}`).exec(input.slice(pos));
        if (m) {
          tm.fsec = parseInt(m[0].padEnd(6, '0'), 10);
          pos += m[0].length;
        }
        break;
      }
      case 'AM':
      case 'PM':
      case 'am':
      case 'pm': {
        const s = input.slice(pos, pos + 2).toUpperCase();
        tm.pm = s === 'PM';
        pos += 2;
        break;
      }
      case 'YYYY':
        tm.year = readInt(4);
        break;
      case 'Y,YYY': {
        const m = /^(\d),?(\d{3})/.exec(input.slice(pos));
        if (m) {
          tm.year = parseInt(m[1] + m[2], 10);
          pos += m[0].length;
        }
        break;
      }
      case 'YY': {
        const y = readInt(2);
        tm.year = y < 70 ? 2000 + y : 1900 + y;
        break;
      }
      case 'MONTH':
      case 'Month':
      case 'month':
      case 'MON':
      case 'Mon':
      case 'mon': {
        skipSpaces();
        const rest = input.slice(pos).toLowerCase();
        let found = false;
        for (let mi = 0; mi < 12; mi++) {
          const full = MONTH_NAMES[mi];
          if (p.toLowerCase() === 'month' && rest.startsWith(full)) {
            tm.month = mi + 1;
            pos += full.length;
            found = true;
            break;
          }
          if (rest.startsWith(full.slice(0, 3))) {
            tm.month = mi + 1;
            pos += p.toLowerCase() === 'month' && rest.startsWith(full) ? full.length : 3;
            found = true;
            break;
          }
        }
        if (!found) {
          throw new PgError(SqlState.INVALID_DATETIME_FORMAT, `invalid value "${input.slice(pos, pos + 3)}" for "${p}"`, {
            detail: 'The given value did not match any of the allowed values for this field.',
          });
        }
        break;
      }
      case 'MM':
        tm.month = readInt(2);
        break;
      case 'DD':
        tm.day = readInt(2);
        break;
      case 'DDD':
        tm.doy = readInt(3);
        break;
      case 'J': {
        const jd = readInt(10);
        const [y, m, d] = j2date(jd);
        tm.year = y;
        tm.month = m;
        tm.day = d;
        break;
      }
      case 'TZH': {
        skipSpaces();
        const m = /^([+-])?(\d{1,2})/.exec(input.slice(pos));
        if (m) {
          const h = parseInt(m[2], 10);
          tm.tzOffset = (m[1] === '-' ? -1 : 1) * h * 3600 + (tm.tzOffset && Math.abs(tm.tzOffset) % 3600 ? tm.tzOffset % 3600 : 0);
          pos += m[0].length;
        }
        break;
      }
      case 'TZM': {
        const mm = readInt(2);
        tm.tzOffset = (tm.tzOffset ?? 0) + (tm.tzOffset !== undefined && tm.tzOffset < 0 ? -mm * 60 : mm * 60);
        break;
      }
      case 'OF': {
        const m = /^([+-])(\d{1,2})(?::(\d{2}))?/.exec(input.slice(pos));
        if (m) {
          tm.tzOffset = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0));
          pos += m[0].length;
        }
        break;
      }
      case 'TZ': {
        const m = /^[A-Za-z]+/.exec(input.slice(pos));
        if (m) {
          const z = resolveZone(m[0]);
          if (z && z.fixed !== null) {
            tm.tzOffset = z.fixed;
          }
          pos += m[0].length;
        }
        break;
      }
      case 'BC':
      case 'AD': {
        const s = input.slice(pos, pos + 2).toUpperCase();
        tm.bc = s === 'BC';
        pos += 2;
        break;
      }
    }
  }
  if (tm.pm !== undefined) {
    if (tm.hour > 12 || tm.hour < 1) {
      throw new PgError(SqlState.INVALID_DATETIME_FORMAT, `hour "${tm.hour}" is invalid for the 12-hour clock`, { hint: 'Use the 24-hour clock, or give an hour between 1 and 12.' });
    }
    if (tm.pm && tm.hour !== 12) {
      tm.hour += 12;
    } else if (!tm.pm && tm.hour === 12) {
      tm.hour = 0;
    }
  }
  if (tm.bc) {
    tm.year = 1 - tm.year;
  }
  if (tm.doy !== undefined) {
    const [y, m, d] = j2date(date2j(tm.year, 1, 1) + tm.doy - 1);
    tm.year = y;
    tm.month = m;
    tm.day = d;
  }
  if (tm.month < 1 || tm.month > 12 || tm.day < 1 || tm.day > daysInMonth(tm.year, tm.month)) {
    throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`);
  }
  if (tm.hour > 24 || tm.minute > 59 || tm.second > 60) {
    throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`);
  }
  void fnName;
  void isLeap;
  return tm;
}

function intervalMul(iv: Interval, factor: number): Interval {
  if (!Number.isFinite(factor)) {
    throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'interval out of range');
  }
  const monthsF = iv.months * factor;
  const months = Math.trunc(monthsF);
  const daysF = iv.days * factor + (monthsF - months) * 30;
  const days = Math.trunc(daysF);
  const us = Math.round(iv.us * factor + (daysF - days) * USECS_PER_DAY);
  return { months: months + 0, days: days + 0, us: us + 0 };
}

function makeInterval(a: unknown[]): Interval {
  const [years, months, weeks, days, hours, mins, secs] = a.map((x) => (x === null || x === undefined ? 0 : Number(x)));
  return {
    months: years * 12 + months,
    days: weeks * 7 + days,
    us: Math.round(hours * USECS_PER_HOUR + mins * USECS_PER_MINUTE + secs * USECS_PER_SEC),
  };
}

function timeFromTimestamp(ts: number): number {
  return ((ts % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY;
}

export const DATETIME_FUNCS: Record<string, FnImpl> = {
  now: (_a, fc) => fc.st.session.transactionTimestamp(),
  statement_timestamp: (_a, fc) => fc.st.session.statementTimestamp(),
  clock_timestamp: (_a, fc) => fc.st.session.clockTimestamp(),
  timeofday: (_a, fc) => {
    const ts = fc.st.session.clockTimestamp();
    return new Date((ts + EPOCH_DIFF_US) / 1000).toString();
  },
  // date arithmetic
  date_pli: (a) => (a[0] as number) + (a[1] as number),
  date_mii: (a) => (a[0] as number) - (a[1] as number),
  integer_pl_date: (a) => (a[1] as number) + (a[0] as number),
  date_mi: (a) => {
    const x = a[0] as number;
    const y = a[1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'cannot subtract infinite dates');
    }
    return checkInt4(x - y);
  },
  date_pl_interval: (a) => tsRangeCheck(timestampPlusInterval(dateToTimestamp(a[0] as number), a[1] as Interval, null)),
  date_mi_interval: (a) => tsRangeCheck(timestampPlusInterval(dateToTimestamp(a[0] as number), intervalNegate(a[1] as Interval), null)),
  datetime_pl: (a) => dateToTimestamp(a[0] as number) + (a[1] as number),
  // timestamp(date, time) and the date + time operator
  datetime_timestamp: (a) => {
    const ts = dateToTimestamp(a[0] as number);
    return Number.isFinite(ts) ? tsRangeCheck(ts + (a[1] as number)) : ts;
  },
  timedate_pl: (a) => dateToTimestamp(a[1] as number) + (a[0] as number),
  datetimetz_pl: (a) => {
    const t = a[1] as TimeTz;
    return dateToTimestamp(a[0] as number) + t.us + t.zone * USECS_PER_SEC;
  },
  timestamp_pl_interval: (a) => tsRangeCheck(timestampPlusInterval(a[0] as number, a[1] as Interval, null)),
  timestamp_mi_interval: (a) => tsRangeCheck(timestampPlusInterval(a[0] as number, intervalNegate(a[1] as Interval), null)),
  interval_pl_timestamp: (a) => tsRangeCheck(timestampPlusInterval(a[1] as number, a[0] as Interval, null)),
  timestamptz_pl_interval: (a, fc) => tsRangeCheck(timestampPlusInterval(a[0] as number, a[1] as Interval, sessionZone(fc))),
  timestamptz_mi_interval: (a, fc) => tsRangeCheck(timestampPlusInterval(a[0] as number, intervalNegate(a[1] as Interval), sessionZone(fc))),
  interval_pl_timestamptz: (a, fc) => tsRangeCheck(timestampPlusInterval(a[1] as number, a[0] as Interval, sessionZone(fc))),
  // uuidv7(shift interval): the timestamp part is now + shift (timestamptz arithmetic in the session zone)
  uuidv7_interval: (a, fc) => {
    const ns = realTimeNsAscending(fc.st.session);
    const epochUs = BigInt(EPOCH_DIFF_US);
    const ts = Number(ns / 1000n - epochUs);
    const us = BigInt(tsRangeCheck(timestampPlusInterval(ts, a[0] as Interval, sessionZone(fc)))) + epochUs;
    return generateUuidV7(us / 1000n, (us % 1000n) * 1000n + (ns % 1000n));
  },
  timestamptz_pl_interval_at_zone: (a) => tsRangeCheck(timestampPlusInterval(a[0] as number, a[1] as Interval, zoneArg(a[2] as string))),
  timestamptz_mi_interval_at_zone: (a) => tsRangeCheck(timestampPlusInterval(a[0] as number, intervalNegate(a[1] as Interval), zoneArg(a[2] as string))),
  timestamp_mi: (a) => {
    const x = a[0] as number;
    const y = a[1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (x === y) {
        throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'interval out of range');
      }
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'interval out of range');
    }
    return justifyHours(timestampDiff(x, y));
  },
  timestamptz_mi: (a) => justifyHours(timestampDiff(a[0] as number, a[1] as number)),
  interval_pl: (a) => {
    const x = a[0] as Interval;
    const y = a[1] as Interval;
    return { months: x.months + y.months, days: x.days + y.days, us: x.us + y.us };
  },
  interval_mi: (a) => {
    const x = a[0] as Interval;
    const y = a[1] as Interval;
    return { months: x.months - y.months, days: x.days - y.days, us: x.us - y.us };
  },
  interval_um: (a) => intervalNegate(a[0] as Interval),
  interval_mul: (a) => intervalMul(a[0] as Interval, a[1] as number),
  mul_d_interval: (a) => intervalMul(a[1] as Interval, a[0] as number),
  interval_div: (a) => {
    const f = a[1] as number;
    if (f === 0) {
      throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
    }
    return intervalMul(a[0] as Interval, 1 / f);
  },
  time_pl_interval: (a) => {
    const us = ((((a[0] as number) + (a[1] as Interval).us) % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY;
    return us;
  },
  time_mi_interval: (a) => ((((a[0] as number) - (a[1] as Interval).us) % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY,
  interval_pl_time: (a) => ((((a[1] as number) + (a[0] as Interval).us) % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY,
  time_mi_time: (a) => ({ months: 0, days: 0, us: (a[0] as number) - (a[1] as number) }),
  timetz_pl_interval: (a) => {
    const t = a[0] as TimeTz;
    return { us: (((t.us + (a[1] as Interval).us) % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY, zone: t.zone };
  },
  // casts
  date_timestamp: (a) => tsRangeCheck(dateToTimestamp(a[0] as number)),
  date_timestamptz: (a, fc) => dateToTimestamptz(a[0] as number, sessionZone(fc)),
  timestamp_date: (a) => timestampToDate(a[0] as number),
  timestamptz_date: (a, fc) => timestampToDate(timestamptzToTimestamp(a[0] as number, sessionZone(fc))),
  timestamp_timestamptz: (a, fc) => timestampToTimestamptz(a[0] as number, sessionZone(fc)),
  timestamptz_timestamp: (a, fc) => timestamptzToTimestamp(a[0] as number, sessionZone(fc)),
  timestamp_time: (a) => timeFromTimestamp(a[0] as number),
  timestamptz_time: (a, fc) => timeFromTimestamp(timestamptzToTimestamp(a[0] as number, sessionZone(fc))),
  timestamptz_timetz: (a, fc) => {
    const off = zoneOffsetAt(sessionZone(fc), a[0] as number);
    return { us: timeFromTimestamp((a[0] as number) + off * USECS_PER_SEC), zone: -off };
  },
  time_interval: (a) => ({ months: 0, days: 0, us: a[0] as number }),
  interval_time: (a) => ((((a[0] as Interval).us % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY),
  timetz_time: (a) => (a[0] as TimeTz).us,
  time_timetz: (a, fc) => ({ us: a[0] as number, zone: -zoneOffsetAt(sessionZone(fc), fc.st.session.transactionTimestamp()) }),
  timestamp_scale: (a) => a[0],
  timestamptz_scale: (a) => a[0],
  // truncation & extraction
  timestamp_trunc: (a) => timestampTrunc(a[0] as string, a[1] as number, 'timestamp without time zone'),
  timestamptz_trunc: (a, fc) => timestamptzTrunc(a[0] as string, a[1] as number, sessionZone(fc)),
  timestamptz_trunc_zone: (a) => timestamptzTrunc(a[0] as string, a[1] as number, zoneArg(a[2] as string)),
  interval_trunc: (a) => intervalTrunc(a[0] as string, a[1] as Interval),
  extract_date: (a) => {
    const d = a[1] as number;
    if (!Number.isFinite(d)) {
      return d > 0 ? PgNumeric.PINF : PgNumeric.NINF;
    }
    const [y, m, day] = j2date(d + POSTGRES_EPOCH_JDATE);
    return extractFromTm(a[0] as string, { year: y, month: m, day, hour: 0, minute: 0, second: 0, fsec: 0 }, d * USECS_PER_DAY, 'date', null, true);
  },
  extract_timestamp: (a) => extractTimestamp(a[0] as string, a[1] as number, 'timestamp without time zone', null),
  extract_timestamptz: (a, fc) => extractTimestamp(a[0] as string, a[1] as number, 'timestamp with time zone', sessionZone(fc)),
  extract_interval: (a) => extractInterval(a[0] as string, a[1] as Interval),
  extract_time: (a) => {
    const us = a[1] as number;
    const tm: Tm = { year: 0, month: 0, day: 0, hour: Math.floor(us / USECS_PER_HOUR), minute: Math.floor((us % USECS_PER_HOUR) / USECS_PER_MINUTE), second: Math.floor((us % USECS_PER_MINUTE) / USECS_PER_SEC), fsec: us % USECS_PER_SEC };
    const f = normUnit(a[0] as string);
    if (f === 'epoch') {
      return PgNumeric.make(false, BigInt(us), 6);
    }
    if (!['microseconds', 'milliseconds', 'second', 'minute', 'hour'].includes(f)) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `unit "${a[0]}" not supported for type time without time zone`);
    }
    return extractFromTm(f, tm, null, 'time', null, false);
  },
  timestamp_part: (a) => toFloat(extractTimestamp(a[0] as string, a[1] as number, 'timestamp without time zone', null)),
  timestamptz_part: (a, fc) => toFloat(extractTimestamp(a[0] as string, a[1] as number, 'timestamp with time zone', sessionZone(fc))),
  interval_part: (a) => toFloat(extractInterval(a[0] as string, a[1] as Interval)),
  // age & justify
  timestamp_age: (a) => ageTimestamps(a[0] as number, a[1] as number, null),
  timestamptz_age: (a, fc) => ageTimestamps(a[0] as number, a[1] as number, sessionZone(fc)),
  interval_justify_hours: (a) => justifyHours(a[0] as Interval),
  interval_justify_days: (a) => justifyDays(a[0] as Interval),
  interval_justify_interval: (a) => justifyInterval(a[0] as Interval),
  date_finite: (a) => Number.isFinite(a[0] as number),
  timestamp_finite: (a) => Number.isFinite(a[0] as number),
  interval_finite: () => true,
  // constructors
  make_date: (a) => {
    const y = a[0] as number;
    const m = a[1] as number;
    const d = a[2] as number;
    if (y === 0 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y < 0 ? y + 1 : y, m)) {
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date field value out of range: ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return date2j(y < 0 ? y + 1 : y, m, d) - POSTGRES_EPOCH_JDATE;
  },
  make_time: (a) => Math.round((a[0] as number) * USECS_PER_HOUR + (a[1] as number) * USECS_PER_MINUTE + (a[2] as number) * USECS_PER_SEC),
  make_timestamp: (a) =>
    (date2j(a[0] as number, a[1] as number, a[2] as number) - POSTGRES_EPOCH_JDATE) * USECS_PER_DAY +
    (a[3] as number) * USECS_PER_HOUR +
    (a[4] as number) * USECS_PER_MINUTE +
    Math.round((a[5] as number) * USECS_PER_SEC),
  make_timestamptz: (a, fc) => {
    const local =
      (date2j(a[0] as number, a[1] as number, a[2] as number) - POSTGRES_EPOCH_JDATE) * USECS_PER_DAY +
      (a[3] as number) * USECS_PER_HOUR +
      (a[4] as number) * USECS_PER_MINUTE +
      Math.round((a[5] as number) * USECS_PER_SEC);
    return timestampToTimestamptz(local, sessionZone(fc));
  },
  make_timestamptz_at_timezone: (a) => {
    const local =
      (date2j(a[0] as number, a[1] as number, a[2] as number) - POSTGRES_EPOCH_JDATE) * USECS_PER_DAY +
      (a[3] as number) * USECS_PER_HOUR +
      (a[4] as number) * USECS_PER_MINUTE +
      Math.round((a[5] as number) * USECS_PER_SEC);
    return timestampToTimestamptz(local, zoneArg(a[6] as string));
  },
  make_interval: (a) => makeInterval(a),
  float8_timestamptz: (a) => {
    const secs = a[0] as number;
    if (Number.isNaN(secs)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'timestamp cannot be NaN');
    }
    if (!Number.isFinite(secs)) {
      return secs;
    }
    return tsRangeCheck(Math.round(secs * USECS_PER_SEC) - EPOCH_DIFF_US);
  },
  to_timestamp: (a, fc) => {
    const tm = parseWithPattern(a[0] as string, a[1] as string, 'to_timestamp');
    const local = tmToTimestamp(tm);
    if (tm.tzOffset !== undefined) {
      return local - tm.tzOffset * USECS_PER_SEC;
    }
    return timestampToTimestamptz(local, sessionZone(fc));
  },
  to_date: (a) => {
    const tm = parseWithPattern(a[0] as string, a[1] as string, 'to_date');
    return date2j(tm.year, tm.month, tm.day) - POSTGRES_EPOCH_JDATE;
  },
  timestamp_to_char: (a) => formatTimestampWithPattern(a[0] as number, a[1] as string, null),
  timestamptz_to_char: (a, fc) => formatTimestampWithPattern(a[0] as number, a[1] as string, sessionZone(fc)),
  interval_to_char: (a) => formatTimestampWithPattern(0, a[1] as string, null, true, a[0] as Interval),
  // AT TIME ZONE
  timestamp_zone: (a) => timestampToTimestamptz(a[1] as number, zoneArg(a[0] as string)),
  timestamptz_zone: (a) => timestamptzToTimestamp(a[1] as number, zoneArg(a[0] as string)),
  timestamp_izone: (a) => (a[1] as number) - (a[0] as Interval).us,
  timestamptz_izone: (a) => (a[1] as number) + (a[0] as Interval).us,
  timetz_zone: (a, fc) => {
    const t = a[1] as TimeTz;
    const z = zoneArg(a[0] as string);
    const off = zoneOffsetAt(z, fc.st.session.transactionTimestamp());
    const utc = t.us + t.zone * USECS_PER_SEC;
    return { us: (((utc + off * USECS_PER_SEC) % USECS_PER_DAY) + USECS_PER_DAY) % USECS_PER_DAY, zone: -off };
  },
  timestamp_at_local: (a, fc) => timestamptzToTimestamp(a[0] as number, sessionZone(fc)),
  timestamptz_at_local: (a, fc) => timestamptzToTimestamp(a[0] as number, sessionZone(fc)),
  date_bin_timestamp: (a) => {
    const stride = a[0] as Interval;
    const src = a[1] as number;
    const origin = a[2] as number;
    const s = stride.days * USECS_PER_DAY + stride.us;
    if (stride.months !== 0) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'timestamps cannot be binned into intervals containing months or years');
    }
    if (s <= 0) {
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, 'stride must be greater than zero');
    }
    const diff = src - origin;
    let q = Math.trunc(diff / s);
    if (diff < 0 && diff % s !== 0) {
      q -= 1;
    }
    return origin + q * s;
  },
  overlaps_timestamp: (a) => {
    let [s1, e1, s2, e2] = a as number[];
    if (s1 > e1) {
      [s1, e1] = [e1, s1];
    }
    if (s2 > e2) {
      [s2, e2] = [e2, s2];
    }
    return s1 < e2 && s2 < e1;
  },
  interval: (a) => a[0],
  interval_scale: (a) => a[0],
  isfinite: (a) => Number.isFinite(a[0] as number),
  pg_sleep: (a, fc) => {
    const secs = a[0] as number;
    fc.st.session.requestSleep(Math.max(0, secs * 1000), fc.st);
    return '';
  },
  text_interval: (a) => parseInterval(a[0] as string),
  date_trunc_rint: (a) => rint(a[0] as number),
};
