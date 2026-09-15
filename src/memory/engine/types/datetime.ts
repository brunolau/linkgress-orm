import { PgError, SqlState } from '../errors';

/**
 * Date/time support with PostgreSQL semantics.
 *
 * Internal representations (JS numbers):
 *  - date:        days since 2000-01-01 (±Infinity for infinity)
 *  - timestamp:   microseconds since 2000-01-01 00:00:00 (±Infinity)
 *  - timestamptz: microseconds since 2000-01-01 00:00:00 UTC (±Infinity)
 *  - time:        microseconds since midnight
 *  - timetz:      { us, zone } where zone = seconds WEST of UTC (PostgreSQL convention)
 *  - interval:    { months, days, us }
 */

export const USECS_PER_SEC = 1000000;
export const USECS_PER_MINUTE = 60000000;
export const USECS_PER_HOUR = 3600000000;
export const USECS_PER_DAY = 86400000000;
export const POSTGRES_EPOCH_JDATE = 2451545;
export const UNIX_EPOCH_JDATE = 2440588;
/** µs between 1970-01-01 and 2000-01-01 */
export const EPOCH_DIFF_US = (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY;
export const EPOCH_DIFF_MS = EPOCH_DIFF_US / 1000;

export interface Interval {
  months: number;
  days: number;
  us: number;
}

export interface TimeTz {
  us: number;
  /** seconds west of UTC */
  zone: number;
}

export function isInterval(v: unknown): v is Interval {
  return typeof v === 'object' && v !== null && 'months' in v && 'days' in v && 'us' in v;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function date2j(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m > 2) {
    m += 1;
    y += 4800;
  } else {
    m += 13;
    y += 4799;
  }
  const century = Math.trunc(y / 100);
  let julian = y * 365 - 32167;
  julian += Math.trunc(y / 4) - century + Math.trunc(century / 4);
  julian += Math.trunc((7834 * m) / 256) + day;
  return julian;
}

export function j2date(jd: number): [number, number, number] {
  let julian = jd >>> 0;
  julian += 32044;
  let quad = Math.floor(julian / 146097);
  const extra = (julian - quad * 146097) * 4 + 3;
  julian += 60 + quad * 3 + Math.floor(extra / 146097);
  quad = Math.floor(julian / 1461);
  julian -= quad * 1461;
  let y = Math.floor((julian * 4) / 1461);
  julian = (y !== 0 ? (julian + 305) % 365 : (julian + 306) % 366) + 123;
  y += quad * 4;
  const year = y - 4800;
  quad = Math.floor((julian * 2141) / 65536);
  const day = julian - Math.floor((7834 * quad) / 256);
  const month = ((quad + 10) % 12) + 1;
  return [year, month, day];
}

/** day of week, 0 = Sunday */
export function j2day(jd: number): number {
  let d = (jd + 1) % 7;
  if (d < 0) {
    d += 7;
  }
  return d;
}

export function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

function pad(n: number, width: number): string {
  const s = String(Math.abs(n));
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();
/** per zone: offset by UTC day / quarter hour (NaN: a transition falls inside) */
const offsetCaches = new Map<string, { days: Map<number, number>; quarters: Map<number, number> }>();

function getFormatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        era: 'short',
      });
    } catch {
      f = null;
    }
    formatterCache.set(zone, f);
  }
  return f;
}

/** Fixed-offset abbreviations accepted in datetime input (subset of PostgreSQL's Default set), seconds EAST. */
const ZONE_ABBREVS: Record<string, number> = {
  utc: 0,
  gmt: 0,
  z: 0,
  zulu: 0,
  ut: 0,
  est: -5 * 3600,
  edt: -4 * 3600,
  cst: -6 * 3600,
  cdt: -5 * 3600,
  mst: -7 * 3600,
  mdt: -6 * 3600,
  pst: -8 * 3600,
  pdt: -7 * 3600,
  cet: 3600,
  cest: 7200,
  met: 3600,
  mest: 7200,
  eet: 7200,
  eest: 10800,
  wet: 0,
  west: 3600,
  bst: 3600,
  msk: 10800,
  ist: 7200,
  jst: 9 * 3600,
  kst: 9 * 3600,
  hkt: 8 * 3600,
  awst: 8 * 3600,
  aest: 10 * 3600,
  aedt: 11 * 3600,
  nzst: 12 * 3600,
  nzdt: 13 * 3600,
  akst: -9 * 3600,
  akdt: -8 * 3600,
  hst: -10 * 3600,
};

export interface ZoneSpec {
  /** fixed offset seconds east, or null for an IANA zone */
  fixed: number | null;
  name: string;
}

const zoneSpecCache = new Map<string, ZoneSpec | null>();

/** Resolve a time zone name (IANA name, abbreviation, or POSIX-ish offset). Returns null if unknown. */
export function resolveZone(name: string): ZoneSpec | null {
  const key = name;
  if (zoneSpecCache.has(key)) {
    return zoneSpecCache.get(key)!;
  }
  let spec: ZoneSpec | null = null;
  const lower = name.toLowerCase();
  if (lower in ZONE_ABBREVS) {
    spec = { fixed: ZONE_ABBREVS[lower], name };
  } else if (lower === 'etc/utc' || lower === 'etc/gmt' || lower === 'utc0' || lower === 'gmt0' || lower === 'universal' || lower === 'zulu' || lower === 'etc/universal') {
    spec = { fixed: 0, name };
  } else {
    // numeric offsets: "+02", "-05:30", "+0530" (ISO sign: east positive)
    const m = /^([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(name.trim());
    if (m) {
      const secs = parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0) + (m[4] ? parseInt(m[4], 10) : 0);
      spec = { fixed: m[1] === '-' ? -secs : secs, name };
    } else {
      // POSIX style "UTC+3" means 3 hours WEST
      const pm = /^([A-Za-z]{3,})([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name.trim());
      if (pm) {
        const secs = parseInt(pm[3], 10) * 3600 + (pm[4] ? parseInt(pm[4], 10) * 60 : 0);
        spec = { fixed: pm[2] === '-' ? secs : -secs, name };
      } else if (getFormatter(name)) {
        spec = { fixed: null, name };
      }
    }
  }
  zoneSpecCache.set(key, spec);
  return spec;
}

/** Offset (seconds EAST of UTC) of `zone` at the given UTC instant (µs since PG epoch). */
export function zoneOffsetAt(zone: ZoneSpec, utcUs: number): number {
  if (zone.fixed !== null) {
    return zone.fixed;
  }
  if (!Number.isFinite(utcUs)) {
    return 0;
  }
  const unixMs = Math.floor((utcUs + EPOCH_DIFF_US) / 1000);
  // offsets only change at transitions: a day whose first and last millisecond share an offset has it
  // throughout; a transition day is resolved per quarter hour, and inside a transition quarter exactly
  let cache = offsetCaches.get(zone.name);
  if (!cache || cache.days.size + cache.quarters.size > 200000) {
    cache = { days: new Map(), quarters: new Map() };
    offsetCaches.set(zone.name, cache);
  }
  const day = Math.floor(unixMs / 86400000);
  let dayOff = cache.days.get(day);
  if (dayOff === undefined) {
    const start = computeOffset(zone.name, day * 86400000);
    dayOff = start === computeOffset(zone.name, (day + 1) * 86400000 - 1) ? start : NaN;
    cache.days.set(day, dayOff);
  }
  if (!Number.isNaN(dayOff)) {
    return dayOff;
  }
  const quarter = Math.floor(unixMs / 900000);
  let quarterOff = cache.quarters.get(quarter);
  if (quarterOff === undefined) {
    const start = computeOffset(zone.name, quarter * 900000);
    quarterOff = start === computeOffset(zone.name, (quarter + 1) * 900000 - 1) ? start : NaN;
    cache.quarters.set(quarter, quarterOff);
  }
  return Number.isNaN(quarterOff) ? computeOffset(zone.name, unixMs) : quarterOff;
}

function computeOffset(zone: string, unixMs: number): number {
  const f = getFormatter(zone)!;
  // Intl supports the full Date range; clamp outside
  const clamped = Math.max(-8.64e15, Math.min(8.64e15, unixMs));
  const secMs = Math.floor(clamped / 1000) * 1000;
  const parts = f.formatToParts(secMs);
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = parseInt(p.value, 10);
        break;
      case 'month':
        mo = parseInt(p.value, 10);
        break;
      case 'day':
        d = parseInt(p.value, 10);
        break;
      case 'hour':
        h = parseInt(p.value, 10);
        break;
      case 'minute':
        mi = parseInt(p.value, 10);
        break;
      case 'second':
        s = parseInt(p.value, 10);
        break;
      case 'era':
        bc = p.value === 'BC' || p.value === 'B';
        break;
    }
  }
  if (bc) {
    y = 1 - y;
  }
  const localDays = date2j(y, mo, d) - UNIX_EPOCH_JDATE;
  const localSec = localDays * 86400 + h * 3600 + mi * 60 + s;
  return localSec - secMs / 1000;
}

/**
 * Convert a local wall-clock time (µs since PG epoch, as if UTC) in `zone` to a UTC instant,
 * resolving DST gaps/overlaps like PostgreSQL's DetermineTimeZoneOffsetInternal.
 * Returns the offset (seconds east) used.
 */
export function localToUtcOffset(zone: ZoneSpec, localUs: number): number {
  if (zone.fixed !== null) {
    return zone.fixed;
  }
  const day = USECS_PER_DAY;
  const offBefore = zoneOffsetAt(zone, localUs - day);
  const offAfter = zoneOffsetAt(zone, localUs + day);
  if (offBefore === offAfter) {
    // verify no double transition inside the window
    const mid = zoneOffsetAt(zone, localUs - offBefore * USECS_PER_SEC);
    if (mid === offBefore) {
      return offBefore;
    }
  }
  // find boundary (UTC) between localUs - day and localUs + day where offset changes
  let lo = localUs - day;
  let hi = localUs + day;
  const loOff = zoneOffsetAt(zone, lo);
  while (hi - lo > USECS_PER_SEC) {
    const mid = Math.floor((lo + hi) / 2 / USECS_PER_SEC) * USECS_PER_SEC;
    if (mid <= lo || mid >= hi) {
      break;
    }
    if (zoneOffsetAt(zone, mid) === loOff) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const boundary = hi;
  const before = loOff;
  const after = zoneOffsetAt(zone, hi);
  const beforeTime = localUs - before * USECS_PER_SEC;
  const afterTime = localUs - after * USECS_PER_SEC;
  if (beforeTime < boundary && afterTime < boundary) {
    return before;
  }
  if (beforeTime >= boundary && afterTime >= boundary) {
    return after;
  }
  return beforeTime > afterTime ? before : after;
}

// ---------------------------------------------------------------------------
// Broken-down time
// ---------------------------------------------------------------------------

export interface Tm {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** microseconds fraction */
  fsec: number;
}

export function timestampToTm(ts: number): Tm {
  let days = Math.floor(ts / USECS_PER_DAY);
  let time = ts - days * USECS_PER_DAY;
  if (time < 0) {
    time += USECS_PER_DAY;
    days -= 1;
  }
  const [year, month, day] = j2date(days + POSTGRES_EPOCH_JDATE);
  const hour = Math.floor(time / USECS_PER_HOUR);
  time -= hour * USECS_PER_HOUR;
  const minute = Math.floor(time / USECS_PER_MINUTE);
  time -= minute * USECS_PER_MINUTE;
  const second = Math.floor(time / USECS_PER_SEC);
  const fsec = Math.round(time - second * USECS_PER_SEC);
  return { year, month, day, hour, minute, second, fsec };
}

export function tmToTimestamp(tm: Tm): number {
  const days = date2j(tm.year, tm.month, tm.day) - POSTGRES_EPOCH_JDATE;
  return days * USECS_PER_DAY + tm.hour * USECS_PER_HOUR + tm.minute * USECS_PER_MINUTE + tm.second * USECS_PER_SEC + tm.fsec;
}

function checkTimestampRange(ts: number, typeName: string): number {
  // PostgreSQL range: 4714-11-24 BC .. 294276 AD
  const MIN = -211813488000000000;
  const MAX = 9223371331200000000;
  if (ts < MIN || ts >= MAX) {
    throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `${typeName} out of range`);
  }
  return ts;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function formatYear(year: number): { text: string; bc: boolean } {
  if (year <= 0) {
    return { text: pad(1 - year, 4), bc: true };
  }
  return { text: pad(year, 4), bc: false };
}

function formatFraction(fsec: number): string {
  if (fsec === 0) {
    return '';
  }
  let s = pad(fsec, 6);
  s = s.replace(/0+$/, '');
  return '.' + s;
}

export function formatDate(d: number): string {
  if (d === Infinity) {
    return 'infinity';
  }
  if (d === -Infinity) {
    return '-infinity';
  }
  const [y, m, day] = j2date(d + POSTGRES_EPOCH_JDATE);
  const yr = formatYear(y);
  return `${yr.text}-${pad(m, 2)}-${pad(day, 2)}${yr.bc ? ' BC' : ''}`;
}

export function formatTime(us: number): string {
  const hour = Math.floor(us / USECS_PER_HOUR);
  let rest = us - hour * USECS_PER_HOUR;
  const minute = Math.floor(rest / USECS_PER_MINUTE);
  rest -= minute * USECS_PER_MINUTE;
  const second = Math.floor(rest / USECS_PER_SEC);
  const fsec = Math.round(rest - second * USECS_PER_SEC);
  return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${formatFraction(fsec)}`;
}

export function formatZoneOffset(offEastSec: number, alwaysMinutes = false): string {
  const sign = offEastSec < 0 ? '-' : '+';
  const abs = Math.abs(offEastSec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  let out = sign + pad(h, 2);
  if (m !== 0 || s !== 0 || alwaysMinutes) {
    out += ':' + pad(m, 2);
  }
  if (s !== 0) {
    out += ':' + pad(s, 2);
  }
  return out;
}

export function formatTimeTz(t: TimeTz): string {
  return formatTime(t.us) + formatZoneOffset(-t.zone);
}

export function formatTimestamp(ts: number): string {
  if (ts === Infinity) {
    return 'infinity';
  }
  if (ts === -Infinity) {
    return '-infinity';
  }
  const tm = timestampToTm(ts);
  const yr = formatYear(tm.year);
  return `${yr.text}-${pad(tm.month, 2)}-${pad(tm.day, 2)} ${pad(tm.hour, 2)}:${pad(tm.minute, 2)}:${pad(tm.second, 2)}${formatFraction(tm.fsec)}${yr.bc ? ' BC' : ''}`;
}

export function formatTimestampTz(ts: number, zone: ZoneSpec): string {
  if (ts === Infinity) {
    return 'infinity';
  }
  if (ts === -Infinity) {
    return '-infinity';
  }
  const off = zoneOffsetAt(zone, ts);
  const local = ts + off * USECS_PER_SEC;
  const tm = timestampToTm(local);
  const yr = formatYear(tm.year);
  return `${yr.text}-${pad(tm.month, 2)}-${pad(tm.day, 2)} ${pad(tm.hour, 2)}:${pad(tm.minute, 2)}:${pad(tm.second, 2)}${formatFraction(tm.fsec)}${formatZoneOffset(off)}${yr.bc ? ' BC' : ''}`;
}

/** XSD / JSON style timestamps (used by to_json): 2000-01-01T00:00:00[.ffffff][+01:00] */
export function formatTimestampJson(ts: number, zone: ZoneSpec | null): string {
  if (ts === Infinity) {
    return 'infinity';
  }
  if (ts === -Infinity) {
    return '-infinity';
  }
  let off = 0;
  let local = ts;
  if (zone) {
    off = zoneOffsetAt(zone, ts);
    local = ts + off * USECS_PER_SEC;
  }
  const tm = timestampToTm(local);
  const yr = formatYear(tm.year);
  let s = `${yr.text}-${pad(tm.month, 2)}-${pad(tm.day, 2)}T${pad(tm.hour, 2)}:${pad(tm.minute, 2)}:${pad(tm.second, 2)}${formatFraction(tm.fsec)}`;
  if (zone) {
    s += formatZoneOffset(off, true);
  }
  if (yr.bc) {
    s += ' BC';
  }
  return s;
}

export function formatInterval(iv: Interval): string {
  const year = Math.trunc(iv.months / 12);
  const mon = iv.months - year * 12;
  const mday = iv.days;
  let time = iv.us;
  const hour = Math.trunc(time / USECS_PER_HOUR);
  time -= hour * USECS_PER_HOUR;
  const min = Math.trunc(time / USECS_PER_MINUTE);
  time -= min * USECS_PER_MINUTE;
  const sec = Math.trunc(time / USECS_PER_SEC);
  const fsec = Math.round(time - sec * USECS_PER_SEC);

  let out = '';
  let isZero = true;
  let isBefore = false;
  const addPart = (value: number, units: string) => {
    if (value === 0) {
      return;
    }
    out += `${!isZero ? ' ' : ''}${isBefore && value > 0 ? '+' : ''}${value} ${units}${value !== 1 ? 's' : ''}`;
    isBefore = value < 0;
    isZero = false;
  };
  addPart(year, 'year');
  addPart(mon, 'mon');
  addPart(mday, 'day');
  if (isZero || hour !== 0 || min !== 0 || sec !== 0 || fsec !== 0) {
    const minus = hour < 0 || min < 0 || sec < 0 || fsec < 0;
    out += `${isZero ? '' : ' '}${minus ? '-' : isBefore ? '+' : ''}${pad(Math.abs(hour), 2)}:${pad(Math.abs(min), 2)}:`;
    out += pad(Math.abs(sec), 2) + formatFraction(Math.abs(fsec));
  }
  return out;
}

/** ISO 8601 interval format (IntervalStyle iso_8601), used by to_json for intervals? (json uses postgres style) */
export function formatIntervalIso(iv: Interval): string {
  const year = Math.trunc(iv.months / 12);
  const mon = iv.months - year * 12;
  let time = iv.us;
  const hour = Math.trunc(time / USECS_PER_HOUR);
  time -= hour * USECS_PER_HOUR;
  const min = Math.trunc(time / USECS_PER_MINUTE);
  time -= min * USECS_PER_MINUTE;
  const sec = time / USECS_PER_SEC;
  if (year === 0 && mon === 0 && iv.days === 0 && iv.us === 0) {
    return 'PT0S';
  }
  let s = 'P';
  if (year) {
    s += year + 'Y';
  }
  if (mon) {
    s += mon + 'M';
  }
  if (iv.days) {
    s += iv.days + 'D';
  }
  if (hour || min || sec) {
    s += 'T';
    if (hour) {
      s += hour + 'H';
    }
    if (min) {
      s += min + 'M';
    }
    if (sec) {
      s += String(sec) + 'S';
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ParsedDateTime {
  special?: 'infinity' | '-infinity' | 'epoch' | 'now' | 'today' | 'tomorrow' | 'yesterday' | 'allballs';
  year?: number;
  month?: number;
  day?: number;
  hour: number;
  minute: number;
  second: number;
  fsec: number;
  /** explicit offset seconds east, if given */
  tzOffset?: number;
  /** named zone given in the string */
  tzName?: ZoneSpec;
  hasDate: boolean;
  hasTime: boolean;
}

function badFormat(typeName: string, input: string): PgError {
  return new PgError(SqlState.INVALID_DATETIME_FORMAT, `invalid input syntax for type ${typeName}: "${input}"`);
}

function fieldOverflow(typeName: string, input: string): PgError {
  return new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`);
}

/**
 * Parse a date/time string (subset of PostgreSQL's DecodeDateTime), DateStyle MDY.
 */
export function parseDateTime(input: string, typeName: string, dateOrder: 'MDY' | 'DMY' | 'YMD' = 'MDY'): ParsedDateTime {
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const result: ParsedDateTime = { hour: 0, minute: 0, second: 0, fsec: 0, hasDate: false, hasTime: false };
  switch (lower) {
    case 'infinity':
    case '+infinity':
      return { ...result, special: 'infinity' };
    case '-infinity':
      return { ...result, special: '-infinity' };
    case 'epoch':
      return { ...result, special: 'epoch' };
    case 'now':
      return { ...result, special: 'now' };
    case 'today':
      return { ...result, special: 'today' };
    case 'tomorrow':
      return { ...result, special: 'tomorrow' };
    case 'yesterday':
      return { ...result, special: 'yesterday' };
    case 'allballs':
      return { ...result, special: 'allballs', hasTime: true };
  }
  if (raw === '') {
    throw badFormat(typeName, input);
  }

  let s = raw;
  let bc = false;
  let pm: 'am' | 'pm' | null = null;

  // ISO 8601 "T" separator: 2024-01-15T10:00:00
  s = s.replace(/^(\d{4,}-\d{1,2}-\d{1,2})[Tt](\d)/, '$1 $2');
  s = s.replace(/^(\d{8})[Tt](\d)/, '$1 $2');

  // tokenize on whitespace and commas
  const tokens = s.split(/[\s,]+/).filter((x) => x.length > 0);
  const pendingNumbers: string[] = [];

  for (let ti = 0; ti < tokens.length; ti++) {
    let tok = tokens[ti];
    const tl = tok.toLowerCase();

    if (tl === 'bc') {
      bc = true;
      continue;
    }
    if (tl === 'ad') {
      continue;
    }
    if (tl === 'am' || tl === 'a.m.') {
      pm = 'am';
      continue;
    }
    if (tl === 'pm' || tl === 'p.m.') {
      pm = 'pm';
      continue;
    }
    if (tl === 'at' || tl === 'on') {
      continue;
    }
    if (tl === 'today' || tl === 'now' || tl === 'tomorrow' || tl === 'yesterday' || tl === 'epoch' || tl === 'allballs') {
      result.special = tl as ParsedDateTime['special'];
      continue;
    }

    // Julian day J2451545
    if (/^j\d+$/i.test(tok)) {
      const [y, m, d] = j2date(parseInt(tok.slice(1), 10));
      result.year = y;
      result.month = m;
      result.day = d;
      result.hasDate = true;
      continue;
    }

    // time with optional attached zone: 10:00:00.123+01:00 / 10:00Z / 10:00:00-05
    const timeMatch = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d+))?)?(.*)$/.exec(tok);
    if (timeMatch && !result.hasTime) {
      result.hour = parseInt(timeMatch[1], 10);
      result.minute = parseInt(timeMatch[2], 10);
      result.second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      if (timeMatch[4]) {
        const frac = (timeMatch[4] + '000000').slice(0, 7);
        // round to microseconds
        result.fsec = Math.round(parseInt(frac, 10) / 10);
      }
      result.hasTime = true;
      const rest = timeMatch[5];
      if (rest) {
        applyZoneToken(result, rest, typeName, input);
      }
      continue;
    }

    // ISO date YYYY-MM-DD (optionally with more)
    let dm = /^(\d{1,})-(\d{1,2})-(\d{1,2})$/.exec(tok);
    if (dm && dm[1].length >= 3) {
      result.year = parseInt(dm[1], 10);
      result.month = parseInt(dm[2], 10);
      result.day = parseInt(dm[3], 10);
      result.hasDate = true;
      continue;
    }
    // YYYY-Mon-DD or DD-Mon-YYYY
    dm = /^(\d+)-([a-zA-Z]+)-(\d+)$/.exec(tok);
    if (dm) {
      const mon = monthFromName(dm[2]);
      if (mon === 0) {
        throw badFormat(typeName, input);
      }
      if (dm[1].length >= 3) {
        result.year = parseInt(dm[1], 10);
        result.day = parseInt(dm[3], 10);
      } else {
        result.day = parseInt(dm[1], 10);
        result.year = normalizeYear(dm[3]);
      }
      result.month = mon;
      result.hasDate = true;
      continue;
    }
    // Mon-DD-YYYY
    dm = /^([a-zA-Z]+)-(\d+)-(\d+)$/.exec(tok);
    if (dm) {
      const mon = monthFromName(dm[1]);
      if (mon === 0) {
        throw badFormat(typeName, input);
      }
      result.month = mon;
      result.day = parseInt(dm[2], 10);
      result.year = normalizeYear(dm[3]);
      result.hasDate = true;
      continue;
    }
    // slashed / dotted / dashed dates
    dm = /^(\d+)([/.\-])(\d+)\2(\d+)$/.exec(tok);
    if (dm) {
      const a = dm[1];
      const b = dm[3];
      const c = dm[4];
      if (a.length >= 3) {
        result.year = parseInt(a, 10);
        result.month = parseInt(b, 10);
        result.day = parseInt(c, 10);
      } else if (dateOrder === 'DMY') {
        result.day = parseInt(a, 10);
        result.month = parseInt(b, 10);
        result.year = normalizeYear(c);
      } else {
        result.month = parseInt(a, 10);
        result.day = parseInt(b, 10);
        result.year = normalizeYear(c);
      }
      result.hasDate = true;
      continue;
    }
    // compact YYYYMMDD
    dm = /^(\d{4})(\d{2})(\d{2})$/.exec(tok);
    if (dm && !result.hasDate) {
      result.year = parseInt(dm[1], 10);
      result.month = parseInt(dm[2], 10);
      result.day = parseInt(dm[3], 10);
      result.hasDate = true;
      continue;
    }
    // compact time HHMMSS
    if (/^\d{6}(\.\d+)?$/.test(tok) && result.hasDate && !result.hasTime) {
      result.hour = parseInt(tok.slice(0, 2), 10);
      result.minute = parseInt(tok.slice(2, 4), 10);
      result.second = parseInt(tok.slice(4, 6), 10);
      if (tok.length > 7) {
        result.fsec = Math.round(parseInt((tok.slice(7) + '000000').slice(0, 7), 10) / 10);
      }
      result.hasTime = true;
      continue;
    }
    // zone offsets / names
    if (/^[+-]\d/.test(tok) && (result.hasTime || result.hasDate)) {
      applyZoneToken(result, tok, typeName, input);
      continue;
    }
    if (/^[a-zA-Z]/.test(tok)) {
      const mon = monthFromName(tok);
      if (mon) {
        result.month = mon;
        result.hasDate = true;
        continue;
      }
      if (dayFromName(tok) >= 0) {
        continue;
      }
      if (tl === 'z' || tl === 'zulu') {
        result.tzOffset = 0;
        continue;
      }
      // zone name possibly with trailing offset
      const zone = resolveZone(tok);
      if (zone) {
        result.tzName = zone;
        continue;
      }
      throw badFormat(typeName, input);
    }
    if (/^\d+$/.test(tok)) {
      pendingNumbers.push(tok);
      continue;
    }
    tok = tok;
    throw badFormat(typeName, input);
  }

  // textual month forms: "Jan 15 2024", "15 Jan 2024", "January 8, 1999"
  if (pendingNumbers.length > 0) {
    if (result.month !== undefined && result.day === undefined) {
      const nums = pendingNumbers.map((x) => x);
      if (nums.length >= 2) {
        const [a, b] = nums;
        if (a.length >= 3) {
          result.year = parseInt(a, 10);
          result.day = parseInt(b, 10);
        } else if (b.length >= 3 || nums.length === 2) {
          result.day = parseInt(a, 10);
          result.year = normalizeYear(b);
        }
      } else if (nums.length === 1) {
        result.day = parseInt(nums[0], 10);
      }
    } else if (result.hasDate && result.year === undefined && pendingNumbers.length === 1) {
      result.year = normalizeYear(pendingNumbers[0]);
    } else {
      throw badFormat(typeName, input);
    }
  }

  if (pm) {
    if (result.hour > 12 || result.hour < 1) {
      throw fieldOverflow(typeName, input);
    }
    if (pm === 'pm' && result.hour !== 12) {
      result.hour += 12;
    } else if (pm === 'am' && result.hour === 12) {
      result.hour = 0;
    }
  }

  if (result.hasDate) {
    if (result.year === undefined || result.month === undefined || result.day === undefined) {
      throw badFormat(typeName, input);
    }
    if (bc) {
      if (result.year <= 0) {
        throw badFormat(typeName, input);
      }
      result.year = 1 - result.year;
    } else if (result.year === 0) {
      throw new PgError(SqlState.INVALID_DATETIME_FORMAT, `date/time field value out of range: "${input}"`);
    }
    if (result.month < 1 || result.month > 12) {
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`, {
        hint: 'Perhaps you need a different "DateStyle" setting.',
      });
    }
    if (result.day < 1 || result.day > daysInMonth(result.year <= 0 ? result.year - 1 : result.year, result.month)) {
      if (!(result.day >= 1 && result.day <= daysInMonth(result.year, result.month))) {
        throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`);
      }
    }
  }
  if (result.hasTime) {
    if (
      result.hour < 0 ||
      result.minute < 0 ||
      result.minute > 59 ||
      result.second < 0 ||
      result.second > 60 ||
      result.hour > 24 ||
      (result.hour === 24 && (result.minute > 0 || result.second > 0 || result.fsec > 0))
    ) {
      throw new PgError(SqlState.DATETIME_FIELD_OVERFLOW, `date/time field value out of range: "${input}"`);
    }
  }
  return result;
}

function applyZoneToken(result: ParsedDateTime, tok: string, typeName: string, input: string): void {
  const t = tok.trim();
  if (t === '') {
    return;
  }
  if (/^z$/i.test(t)) {
    result.tzOffset = 0;
    return;
  }
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(t);
  if (m) {
    const secs = parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0) + (m[4] ? parseInt(m[4], 10) : 0);
    if (parseInt(m[2], 10) > 15 && !m[3]) {
      // could be a 4-digit "+0100" parsed as 2+2 already; >15h invalid
    }
    result.tzOffset = m[1] === '-' ? -secs : secs;
    return;
  }
  const m4 = /^([+-])(\d{2})(\d{2})$/.exec(t);
  if (m4) {
    const secs = parseInt(m4[2], 10) * 3600 + parseInt(m4[3], 10) * 60;
    result.tzOffset = m4[1] === '-' ? -secs : secs;
    return;
  }
  const zone = resolveZone(t);
  if (zone) {
    result.tzName = zone;
    return;
  }
  throw badFormat(typeName, input);
}

function normalizeYear(s: string): number {
  const y = parseInt(s, 10);
  if (s.length <= 2) {
    // two-digit years: 70-99 -> 19xx, 00-69 -> 20xx
    return y >= 70 ? 1900 + y : 2000 + y;
  }
  return y;
}

function monthFromName(s: string): number {
  const l = s.toLowerCase().replace(/\.$/, '');
  if (l.length < 3) {
    return 0;
  }
  for (let i = 0; i < 12; i++) {
    if (MONTH_NAMES[i].startsWith(l) && (l.length >= 3)) {
      if (l === 'sept') {
        return 9;
      }
      return i + 1;
    }
  }
  if (l === 'sept') {
    return 9;
  }
  return 0;
}

function dayFromName(s: string): number {
  const l = s.toLowerCase().replace(/\.$/, '');
  if (l.length < 3) {
    return -1;
  }
  for (let i = 0; i < 7; i++) {
    if (DAY_NAMES[i].startsWith(l)) {
      return i;
    }
  }
  if (l === 'tues' || l === 'thur' || l === 'thurs' || l === 'wednes') {
    return 0;
  }
  return -1;
}

/** Session-dependent context for input functions. */
export interface DateTimeContext {
  zone: ZoneSpec;
  /** transaction start timestamp (µs, UTC) for 'now' etc */
  now: () => number;
}

export function parseDate(input: string, ctx: DateTimeContext): number {
  const p = parseDateTime(input, 'date');
  if (p.special) {
    switch (p.special) {
      case 'infinity':
        return Infinity;
      case '-infinity':
        return -Infinity;
      case 'epoch':
        return date2j(1970, 1, 1) - POSTGRES_EPOCH_JDATE;
      case 'now':
      case 'today':
      case 'tomorrow':
      case 'yesterday': {
        const nowUs = ctx.now();
        const local = nowUs + zoneOffsetAt(ctx.zone, nowUs) * USECS_PER_SEC;
        let d = Math.floor(local / USECS_PER_DAY);
        if (p.special === 'tomorrow') {
          d += 1;
        } else if (p.special === 'yesterday') {
          d -= 1;
        }
        return d;
      }
      default:
        throw badFormat('date', input);
    }
  }
  if (!p.hasDate) {
    throw badFormat('date', input);
  }
  return date2j(p.year!, p.month!, p.day!) - POSTGRES_EPOCH_JDATE;
}

export function parseTimestamp(input: string, ctx: DateTimeContext, withTz: boolean): number {
  const typeName = withTz ? 'timestamp with time zone' : 'timestamp without time zone';
  const p = parseDateTime(input, typeName);
  let localUs: number;
  if (p.special === 'infinity') {
    return Infinity;
  }
  if (p.special === '-infinity') {
    return -Infinity;
  }
  if (p.special === 'epoch') {
    return withTz ? -EPOCH_DIFF_US : -EPOCH_DIFF_US;
  }
  if (p.special === 'now') {
    const nowUs = ctx.now();
    if (withTz) {
      return nowUs;
    }
    return nowUs + zoneOffsetAt(ctx.zone, nowUs) * USECS_PER_SEC;
  }
  if (p.special === 'today' || p.special === 'tomorrow' || p.special === 'yesterday') {
    const nowUs = ctx.now();
    const local = nowUs + zoneOffsetAt(ctx.zone, nowUs) * USECS_PER_SEC;
    let d = Math.floor(local / USECS_PER_DAY);
    if (p.special === 'tomorrow') {
      d += 1;
    } else if (p.special === 'yesterday') {
      d -= 1;
    }
    localUs = d * USECS_PER_DAY + p.hour * USECS_PER_HOUR + p.minute * USECS_PER_MINUTE + p.second * USECS_PER_SEC + p.fsec;
  } else {
    if (!p.hasDate) {
      throw badFormat(typeName, input);
    }
    localUs =
      (date2j(p.year!, p.month!, p.day!) - POSTGRES_EPOCH_JDATE) * USECS_PER_DAY +
      p.hour * USECS_PER_HOUR +
      p.minute * USECS_PER_MINUTE +
      p.second * USECS_PER_SEC +
      p.fsec;
  }
  if (!withTz) {
    // time zone in input is silently ignored for timestamp without time zone
    return checkTimestampRange(localUs, 'timestamp');
  }
  if (p.tzOffset !== undefined) {
    return checkTimestampRange(localUs - p.tzOffset * USECS_PER_SEC, 'timestamp');
  }
  const zone = p.tzName ?? ctx.zone;
  const off = localToUtcOffset(zone, localUs);
  return checkTimestampRange(localUs - off * USECS_PER_SEC, 'timestamp');
}

export function parseTime(input: string, typeName = 'time without time zone'): number {
  const p = parseDateTime(input, typeName);
  if (p.special === 'allballs') {
    return 0;
  }
  if (p.special === 'now') {
    throw badFormat(typeName, input);
  }
  if (!p.hasTime) {
    throw badFormat(typeName, input);
  }
  return p.hour * USECS_PER_HOUR + p.minute * USECS_PER_MINUTE + p.second * USECS_PER_SEC + p.fsec;
}

export function parseTimeTz(input: string, ctx: DateTimeContext): TimeTz {
  const p = parseDateTime(input, 'time with time zone');
  if (!p.hasTime) {
    throw badFormat('time with time zone', input);
  }
  const us = p.hour * USECS_PER_HOUR + p.minute * USECS_PER_MINUTE + p.second * USECS_PER_SEC + p.fsec;
  let east: number;
  if (p.tzOffset !== undefined) {
    east = p.tzOffset;
  } else {
    const zone = p.tzName ?? ctx.zone;
    east = zoneOffsetAt(zone, ctx.now());
  }
  return { us, zone: -east };
}

const INTERVAL_UNITS: Record<string, string> = {
  microsecond: 'us',
  microseconds: 'us',
  microsecon: 'us',
  us: 'us',
  usec: 'us',
  usecs: 'us',
  millisecond: 'ms',
  milliseconds: 'ms',
  millisecon: 'ms',
  ms: 'ms',
  msec: 'ms',
  msecs: 'ms',
  second: 's',
  seconds: 's',
  sec: 's',
  secs: 's',
  s: 's',
  minute: 'm',
  minutes: 'm',
  min: 'm',
  mins: 'm',
  m: 'm',
  hour: 'h',
  hours: 'h',
  hr: 'h',
  hrs: 'h',
  h: 'h',
  day: 'd',
  days: 'd',
  d: 'd',
  week: 'w',
  weeks: 'w',
  w: 'w',
  month: 'mon',
  months: 'mon',
  mon: 'mon',
  mons: 'mon',
  year: 'y',
  years: 'y',
  yr: 'y',
  yrs: 'y',
  y: 'y',
  decade: 'dec',
  decades: 'dec',
  dec: 'dec',
  decs: 'dec',
  century: 'c',
  centuries: 'c',
  cent: 'c',
  c: 'c',
  millennium: 'mil',
  millennia: 'mil',
  millenniums: 'mil',
  mil: 'mil',
  mils: 'mil',
};

/** interval_in (postgres, sql_standard and ISO 8601 formats) */
export function parseInterval(input: string): Interval {
  const raw = input.trim();
  const bad = () => new PgError(SqlState.INVALID_DATETIME_FORMAT, `invalid input syntax for type interval: "${input}"`);
  if (raw === '') {
    throw bad();
  }
  let months = 0;
  let days = 0;
  let us = 0;
  const addFractional = (value: number, unit: string) => {
    switch (unit) {
      case 'us':
        us += value;
        break;
      case 'ms':
        us += value * 1000;
        break;
      case 's':
        us += value * USECS_PER_SEC;
        break;
      case 'm':
        us += value * USECS_PER_MINUTE;
        break;
      case 'h':
        us += value * USECS_PER_HOUR;
        break;
      case 'd': {
        const whole = Math.trunc(value);
        days += whole;
        us += (value - whole) * USECS_PER_DAY;
        break;
      }
      case 'w': {
        const dd = value * 7;
        const whole = Math.trunc(dd);
        days += whole;
        us += (dd - whole) * USECS_PER_DAY;
        break;
      }
      case 'mon': {
        const whole = Math.trunc(value);
        months += whole;
        const fracDays = (value - whole) * 30;
        const wd = Math.trunc(fracDays);
        days += wd;
        us += (fracDays - wd) * USECS_PER_DAY;
        break;
      }
      case 'y': {
        const mm = value * 12;
        const whole = Math.trunc(Math.round(mm * 1e6) / 1e6);
        months += whole;
        break;
      }
      case 'dec':
        months += Math.trunc(value * 120);
        break;
      case 'c':
        months += Math.trunc(value * 1200);
        break;
      case 'mil':
        months += Math.trunc(value * 12000);
        break;
      default:
        throw bad();
    }
  };

  // ISO 8601: P1Y2M3DT4H5M6S
  if (/^-?P/i.test(raw)) {
    const m = /^(-)?P(?:(-?[\d.]+)Y)?(?:(-?[\d.]+)M)?(?:(-?[\d.]+)W)?(?:(-?[\d.]+)D)?(?:T(?:(-?[\d.]+)H)?(?:(-?[\d.]+)M)?(?:(-?[\d.]+)S)?)?$/i.exec(raw);
    if (!m) {
      throw bad();
    }
    const sign = m[1] ? -1 : 1;
    if (m[2]) {
      addFractional(sign * parseFloat(m[2]), 'y');
    }
    if (m[3]) {
      addFractional(sign * parseFloat(m[3]), 'mon');
    }
    if (m[4]) {
      addFractional(sign * parseFloat(m[4]), 'w');
    }
    if (m[5]) {
      addFractional(sign * parseFloat(m[5]), 'd');
    }
    if (m[6]) {
      addFractional(sign * parseFloat(m[6]), 'h');
    }
    if (m[7]) {
      addFractional(sign * parseFloat(m[7]), 'm');
    }
    if (m[8]) {
      addFractional(sign * parseFloat(m[8]), 's');
    }
    return { months, days, us: Math.round(us) };
  }

  let s = raw.toLowerCase();
  let ago = false;
  if (s.startsWith('@')) {
    s = s.slice(1).trim();
  }
  if (/\bago$/.test(s)) {
    ago = true;
    s = s.replace(/\s*ago$/, '');
  }
  // ParseDateTime: a sign followed by whitespace belongs to the next number ("1 month - 1 day");
  // digits glued to letters are two fields ("10min")
  const rawTokens = s.split(/\s+/).filter((x) => x);
  const tokens: string[] = [];
  for (let k = 0; k < rawTokens.length; k++) {
    let tok = rawTokens[k];
    if ((tok === '+' || tok === '-') && k + 1 < rawTokens.length && /^[\d.]/.test(rawTokens[k + 1])) {
      tok += rawTokens[++k];
    }
    const glued = /^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)([a-z]+)$/.exec(tok);
    if (glued && INTERVAL_UNITS[glued[2]]) {
      tokens.push(glued[1], glued[2]);
    } else {
      tokens.push(tok);
    }
  }
  // DecodeInterval: fields right to left; a unitless number takes the unit of the field to its right
  // (seconds when there is none, days left of a time field); each unit may be given once
  const UNIT_MASK: Record<string, number> = { us: 1, ms: 2, s: 4, m: 8, h: 16, d: 32, w: 64, mon: 128, y: 256, dec: 512, c: 1024, mil: 2048 };
  const TIME_MASK = 1 | 2 | 4 | 8 | 16;
  let fmask = 0;
  let pendingUnit: string | null = null;
  const claim = (mask: number) => {
    if (fmask & mask) {
      throw bad();
    }
    fmask |= mask;
  };
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tok = tokens[k];
    // time field hh:mm[:ss[.fff]] with optional sign
    const tm = /^([+-])?(\d+):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?$/.exec(tok);
    if (tm) {
      claim(TIME_MASK);
      const sign = tm[1] === '-' ? -1 : 1;
      let t = parseInt(tm[2], 10) * USECS_PER_HOUR + parseInt(tm[3], 10) * USECS_PER_MINUTE;
      if (tm[4]) {
        t += parseInt(tm[4], 10) * USECS_PER_SEC;
      }
      if (tm[5]) {
        t += Math.round(parseInt((tm[5] + '000000').slice(0, 7), 10) / 10);
      }
      us += sign * t;
      pendingUnit = 'd';
      continue;
    }
    if (/^[+-]?\d*\.?\d+(?:e[+-]?\d+)?$/.test(tok)) {
      const unit: string = pendingUnit ?? 's';
      pendingUnit = unit;
      claim(UNIT_MASK[unit] ?? 0);
      addFractional(parseFloat(tok), unit);
      continue;
    }
    if (INTERVAL_UNITS[tok]) {
      pendingUnit = INTERVAL_UNITS[tok];
      continue;
    }
    // sql standard year-month "1-2"
    const ym = /^([+-])?(\d+)-(\d+)$/.exec(tok);
    if (ym) {
      claim(UNIT_MASK.y | UNIT_MASK.mon);
      const sign = ym[1] === '-' ? -1 : 1;
      months += sign * (parseInt(ym[2], 10) * 12 + parseInt(ym[3], 10));
      continue;
    }
    throw bad();
  }
  let result = { months, days, us: Math.round(us) };
  if (ago) {
    result = { months: -result.months, days: -result.days, us: -result.us };
  }
  return normalizeNegZero(result);
}

function normalizeNegZero(iv: Interval): Interval {
  return { months: iv.months + 0, days: iv.days + 0, us: iv.us + 0 };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** timestamp + interval (month arithmetic clamps day-of-month) */
export function timestampPlusInterval(ts: number, iv: Interval, zone: ZoneSpec | null): number {
  if (!Number.isFinite(ts)) {
    return ts;
  }
  let result = ts;
  if (iv.months !== 0) {
    let local = result;
    let off = 0;
    if (zone) {
      off = zoneOffsetAt(zone, result);
      local = result + off * USECS_PER_SEC;
    }
    const tm = timestampToTm(local);
    let month = tm.month - 1 + iv.months;
    const yearShift = Math.floor(month / 12);
    month -= yearShift * 12;
    tm.year += yearShift;
    tm.month = month + 1;
    const dim = daysInMonth(tm.year, tm.month);
    if (tm.day > dim) {
      tm.day = dim;
    }
    local = tmToTimestamp(tm);
    if (zone) {
      const newOff = localToUtcOffset(zone, local);
      result = local - newOff * USECS_PER_SEC;
    } else {
      result = local;
    }
  }
  if (iv.days !== 0) {
    if (zone) {
      const off = zoneOffsetAt(zone, result);
      let local = result + off * USECS_PER_SEC;
      local += iv.days * USECS_PER_DAY;
      const newOff = localToUtcOffset(zone, local);
      result = local - newOff * USECS_PER_SEC;
    } else {
      result += iv.days * USECS_PER_DAY;
    }
  }
  result += iv.us;
  return result;
}

export function intervalNegate(iv: Interval): Interval {
  return normalizeNegZero({ months: -iv.months, days: -iv.days, us: -iv.us });
}

/** interval comparison key (interval_cmp_value): months*30 days + days, in µs */
export function intervalCmpValue(iv: Interval): number {
  return (iv.months * 30 + iv.days) * USECS_PER_DAY + iv.us;
}

/** timestamp - timestamp => interval (days + time, no months) as interval_justify_hours */
export function timestampDiff(a: number, b: number): Interval {
  const diff = a - b;
  const days = Math.trunc(diff / USECS_PER_DAY);
  const us = diff - days * USECS_PER_DAY;
  return normalizeNegZero({ months: 0, days, us });
}

export function justifyHours(iv: Interval): Interval {
  let days = iv.days;
  let us = iv.us;
  const wholeDay = Math.trunc(us / USECS_PER_DAY);
  days += wholeDay;
  us -= wholeDay * USECS_PER_DAY;
  if (days > 0 && us < 0) {
    us += USECS_PER_DAY;
    days--;
  } else if (days < 0 && us > 0) {
    us -= USECS_PER_DAY;
    days++;
  }
  return normalizeNegZero({ months: iv.months, days, us });
}

export function justifyDays(iv: Interval): Interval {
  let months = iv.months;
  let days = iv.days;
  const wholeMonth = Math.trunc(days / 30);
  months += wholeMonth;
  days -= wholeMonth * 30;
  if (months > 0 && days < 0) {
    days += 30;
    months--;
  } else if (months < 0 && days > 0) {
    days -= 30;
    months++;
  }
  return normalizeNegZero({ months, days, us: iv.us });
}

/** age(timestamp, timestamp) — symbolic result using years/months/days */
export function ageTimestamps(a: number, b: number, zone: ZoneSpec | null): Interval {
  const localA = zone ? a + zoneOffsetAt(zone, a) * USECS_PER_SEC : a;
  const localB = zone ? b + zoneOffsetAt(zone, b) * USECS_PER_SEC : b;
  const tm1 = timestampToTm(localA);
  const tm2 = timestampToTm(localB);
  let fsec = tm1.fsec - tm2.fsec;
  let sec = tm1.second - tm2.second;
  let min = tm1.minute - tm2.minute;
  let hour = tm1.hour - tm2.hour;
  let mday = tm1.day - tm2.day;
  let mon = tm1.month - tm2.month;
  let year = tm1.year - tm2.year;
  // flip sign if necessary
  let neg = false;
  if (localA < localB) {
    neg = true;
    fsec = -fsec;
    sec = -sec;
    min = -min;
    hour = -hour;
    mday = -mday;
    mon = -mon;
    year = -year;
  }
  while (fsec < 0) {
    fsec += USECS_PER_SEC;
    sec--;
  }
  while (sec < 0) {
    sec += 60;
    min--;
  }
  while (min < 0) {
    min += 60;
    hour--;
  }
  while (hour < 0) {
    hour += 24;
    mday--;
  }
  while (mday < 0) {
    if (neg) {
      mday += daysInMonth(tm1.year, tm1.month);
    } else {
      // days in month of tm2
      mday += daysInMonth(tm2.year, tm2.month);
    }
    mon--;
  }
  while (mon < 0) {
    mon += 12;
    year--;
  }
  if (neg) {
    fsec = -fsec;
    sec = -sec;
    min = -min;
    hour = -hour;
    mday = -mday;
    mon = -mon;
    year = -year;
  }
  return normalizeNegZero({
    months: year * 12 + mon,
    days: mday,
    us: hour * USECS_PER_HOUR + min * USECS_PER_MINUTE + sec * USECS_PER_SEC + fsec,
  });
}

/** Convert JS Date ms to PG timestamptz µs. */
export function unixMsToPgUs(ms: number): number {
  return ms * 1000 - EPOCH_DIFF_US;
}

export function pgUsToUnixMs(us: number): number {
  return (us + EPOCH_DIFF_US) / 1000;
}

export { MONTH_NAMES, DAY_NAMES };
