import { BUILTIN_SETTINGS } from './catalog/builtin-data';
import { PgError, SqlState } from './errors';

export interface SettingDef {
  name: string;
  boot: string;
  unit: string | null;
  vartype: string;
  context: string;
  enumvals: string[] | null;
}

const DEFS = new Map<string, SettingDef>();
for (const s of BUILTIN_SETTINGS) {
  const [name, setting, unit, vartype, context, bootVal, enumvals] = s;
  DEFS.set(String(name).toLowerCase(), { name, boot: setting ?? bootVal ?? '', unit, vartype, context, enumvals });
}

export function settingDef(name: string): SettingDef | undefined {
  return DEFS.get(name.toLowerCase());
}

export function allSettingNames(): string[] {
  return [...DEFS.values()].map((d) => d.name);
}

const MEM_UNITS: Record<string, number> = { B: 1 / 1024, kB: 1, MB: 1024, GB: 1024 * 1024, TB: 1024 * 1024 * 1024 };
const TIME_UNITS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };

/** Normalize a value for storage (integers with units -> base unit number as string). */
export function normalizeSettingValue(name: string, raw: string): string {
  const def = settingDef(name);
  if (!def) {
    return raw;
  }
  const v = raw.trim();
  switch (def.vartype) {
    case 'bool': {
      const l = v.toLowerCase();
      if (['on', 'true', 'yes', '1', 't', 'y'].includes(l)) {
        return 'on';
      }
      if (['off', 'false', 'no', '0', 'f', 'n'].includes(l)) {
        return 'off';
      }
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `parameter "${def.name}" requires a Boolean value`);
    }
    case 'integer':
    case 'real': {
      const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(v);
      if (!m) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid value for parameter "${def.name}": "${raw}"`);
      }
      let num = parseFloat(m[1]);
      const unit = m[2];
      if (unit && def.unit) {
        if (def.unit === 'ms' || def.unit === 's' || def.unit === 'min') {
          const factor = TIME_UNITS[unit];
          if (factor === undefined) {
            throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid value for parameter "${def.name}": "${raw}"`, {
              hint: 'Valid units for this parameter are "us", "ms", "s", "min", "h", and "d".',
            });
          }
          num = (num * factor) / TIME_UNITS[def.unit];
        } else {
          const factor = MEM_UNITS[unit];
          if (factor === undefined) {
            throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid value for parameter "${def.name}": "${raw}"`, {
              hint: 'Valid units for this parameter are "B", "kB", "MB", "GB", and "TB".',
            });
          }
          const baseFactor = def.unit === 'kB' ? 1 : def.unit === '8kB' ? 8 : def.unit === 'MB' ? 1024 : 1;
          num = (num * factor) / baseFactor;
        }
      }
      return String(def.vartype === 'integer' ? Math.round(num) : num);
    }
    case 'enum': {
      const l = v.toLowerCase();
      if (def.enumvals && !def.enumvals.includes(l)) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `invalid value for parameter "${def.name}": "${raw}"`, {
          hint: `Available values: ${def.enumvals.join(', ')}.`,
        });
      }
      return l;
    }
    default:
      return raw;
  }
}

/** SHOW-style display (integers with time/memory units rendered with the largest exact unit). */
export function displaySettingValue(name: string, stored: string): string {
  const def = settingDef(name);
  if (!def || !def.unit || def.vartype !== 'integer') {
    return stored;
  }
  const n = Number(stored);
  if (!Number.isFinite(n)) {
    return stored;
  }
  if (n === 0 || n === -1) {
    return String(n);
  }
  if (def.unit === 'ms' || def.unit === 's' || def.unit === 'min') {
    const ms = n * TIME_UNITS[def.unit];
    for (const [u, f] of [
      ['d', 86400000],
      ['h', 3600000],
      ['min', 60000],
      ['s', 1000],
      ['ms', 1],
    ] as [string, number][]) {
      if (ms % f === 0 && f >= TIME_UNITS[def.unit]) {
        return `${ms / f}${u}`;
      }
    }
    return `${n}${def.unit}`;
  }
  const kb = def.unit === 'kB' ? n : def.unit === '8kB' ? n * 8 : def.unit === 'MB' ? n * 1024 : n;
  for (const [u, f] of [
    ['TB', 1024 * 1024 * 1024],
    ['GB', 1024 * 1024],
    ['MB', 1024],
    ['kB', 1],
  ] as [string, number][]) {
    if (kb % f === 0) {
      return `${kb / f}${u}`;
    }
  }
  return `${n}${def.unit}`;
}
