import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { Interval, USECS_PER_DAY } from '../../types/datetime';
import { escapeJsonString, JNULL, jsonbToText, JsonbObject, JsonbValue } from '../../types/json';
import { PgNumeric } from '../../types/numeric';
import { numericStddev } from '../../types/numeric-math';
import { AggNode } from '../../analyze/nodes';
import { AggImpl, FnCall } from '../runtime';
import { checkInt8, toBigInt, TypeOps } from '../typeops';
import { datumToJson, datumToJsonb, jsonCategory } from './json-fns';
import { floatToNumeric } from './numeric-fns';
import { rangeAggregate } from './range-fns';

interface SumState {
  kind: 'int' | 'numeric' | 'float' | 'interval';
  big: bigint;
  num: PgNumeric;
  f: number;
  iv: Interval;
  count: number;
}

function numOf(v: unknown, type: number): PgNumeric {
  if (v instanceof PgNumeric) {
    return v;
  }
  if (typeof v === 'bigint') {
    return PgNumeric.fromBigInt(v);
  }
  if (type === TypeOid.float4 || type === TypeOid.float8) {
    return floatToNumeric(v as number, type === TypeOid.float4);
  }
  return PgNumeric.fromInt(v as number);
}

function sumAgg(argType: number, resultType: number): AggImpl {
  const isInt = argType === TypeOid.int2 || argType === TypeOid.int4 || argType === TypeOid.int8;
  return {
    init: () => ({ kind: 'int', big: 0n, num: PgNumeric.ZERO, f: 0, iv: { months: 0, days: 0, us: 0 }, count: 0 } as SumState),
    step: (s, a) => {
      const st = s as SumState;
      const v = a[0];
      st.count++;
      if (argType === TypeOid.interval) {
        const iv = v as Interval;
        st.iv = { months: st.iv.months + iv.months, days: st.iv.days + iv.days, us: st.iv.us + iv.us };
      } else if (argType === TypeOid.float4 || argType === TypeOid.float8) {
        st.f += v as number;
      } else if (isInt && resultType === TypeOid.int8) {
        st.big += toBigInt(v);
      } else {
        st.num = st.num.add(numOf(v, argType));
      }
      return st;
    },
    final: (s) => {
      const st = s as SumState;
      if (st.count === 0) {
        return null;
      }
      switch (resultType) {
        case TypeOid.int8:
          return checkInt8(st.big);
        case TypeOid.float4:
          return Math.fround(st.f);
        case TypeOid.float8:
          return st.f;
        case TypeOid.interval:
          return st.iv;
        default:
          return st.num;
      }
    },
  };
}

function avgAgg(argType: number, resultType: number): AggImpl {
  return {
    init: () => ({ kind: 'numeric', big: 0n, num: PgNumeric.ZERO, f: 0, iv: { months: 0, days: 0, us: 0 }, count: 0 } as SumState),
    step: (s, a) => {
      const st = s as SumState;
      st.count++;
      if (resultType === TypeOid.float8) {
        st.f += Number(a[0] instanceof PgNumeric ? (a[0] as PgNumeric).toNumber() : (a[0] as number));
      } else if (resultType === TypeOid.interval) {
        const iv = a[0] as Interval;
        st.iv = { months: st.iv.months + iv.months, days: st.iv.days + iv.days, us: st.iv.us + iv.us };
      } else if (argType === TypeOid.int2 || argType === TypeOid.int4 || argType === TypeOid.int8) {
        st.big += toBigInt(a[0]);
      } else {
        st.num = st.num.add(numOf(a[0], argType));
      }
      return st;
    },
    final: (s) => {
      const st = s as SumState;
      if (st.count === 0) {
        return null;
      }
      if (resultType === TypeOid.float8) {
        return st.f / st.count;
      }
      if (resultType === TypeOid.interval) {
        const n = st.count;
        const monthsF = st.iv.months / n;
        const months = Math.trunc(monthsF);
        const daysF = st.iv.days / n + (monthsF - months) * 30;
        const days = Math.trunc(daysF);
        return { months, days, us: Math.round(st.iv.us / n + (daysF - days) * USECS_PER_DAY) };
      }
      const sum = argType === TypeOid.int2 || argType === TypeOid.int4 || argType === TypeOid.int8 ? PgNumeric.fromBigInt(st.big) : st.num;
      return sum.div(PgNumeric.fromInt(st.count));
    },
  };
}

function minMaxAgg(type: number, collation: number, typeOps: TypeOps, isMax: boolean): AggImpl {
  const cmp = typeOps.comparator(type, collation);
  return {
    init: () => ({ v: null as unknown, has: false }),
    step: (s, a) => {
      const st = s as { v: unknown; has: boolean };
      if (!st.has) {
        st.v = a[0];
        st.has = true;
      } else {
        const r = cmp(a[0], st.v);
        if (isMax ? r > 0 : r < 0) {
          st.v = a[0];
        }
      }
      return st;
    },
    final: (s) => ((s as { has: boolean }).has ? (s as { v: unknown }).v : null),
  };
}

interface StatState {
  n: number;
  sx: number;
  sxx: number;
  nn: PgNumeric;
  sxn: PgNumeric;
  sxxn: PgNumeric;
}

function statAgg(name: string, argType: number, resultType: number): AggImpl {
  const numericMode = resultType === TypeOid.numeric;
  return {
    init: () => ({ n: 0, sx: 0, sxx: 0, nn: PgNumeric.ZERO, sxn: PgNumeric.ZERO, sxxn: PgNumeric.ZERO } as StatState),
    step: (s, a) => {
      const st = s as StatState;
      st.n++;
      if (numericMode) {
        const x = numOf(a[0], argType);
        st.sxn = st.sxn.add(x);
        st.sxxn = st.sxxn.add(x.mul(x));
      } else {
        const x = a[0] instanceof PgNumeric ? (a[0] as PgNumeric).toNumber() : Number(a[0]);
        st.sx += x;
        st.sxx += x * x;
      }
      return st;
    },
    final: (s) => {
      const st = s as StatState;
      const pop = name.endsWith('_pop');
      const isVar = name.startsWith('var');
      if (st.n === 0 || (!pop && st.n < 2)) {
        return null;
      }
      if (numericMode) {
        return numericStddev(st.n, st.sxn, st.sxxn, isVar, !pop);
      }
      const mean = st.sx / st.n;
      const ss = st.sxx - st.sx * mean;
      const variance = Math.max(0, ss / (pop ? st.n : st.n - 1));
      return isVar ? variance : Math.sqrt(variance);
    },
  };
}

function arrayAgg(argType: number, typeOps: TypeOps, fcArgIsArray: boolean): AggImpl {
  void typeOps;
  return {
    strict: false,
    init: () => [] as unknown[],
    step: (s, a) => {
      const arr = s as unknown[];
      if (fcArgIsArray) {
        const v = a[0] as unknown[] | null;
        if (v === null) {
          throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'cannot accumulate null arrays');
        }
        if (v.length === 0) {
          throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'cannot accumulate empty arrays');
        }
        if (arr.length > 0 && (arr[0] as unknown[]).length !== v.length) {
          throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'cannot accumulate arrays of different dimensionality');
        }
      }
      arr.push(a[0]);
      return arr;
    },
    final: (s) => ((s as unknown[]).length === 0 ? null : s),
  };
  void argType;
}

function stringAgg(isBytea: boolean): AggImpl {
  return {
    strict: false,
    init: () => ({ parts: [] as unknown[], delims: [] as unknown[], any: false }),
    step: (s, a) => {
      const st = s as { parts: unknown[]; delims: unknown[]; any: boolean };
      if (a[0] === null) {
        return st;
      }
      st.parts.push(a[0]);
      st.delims.push(a[1]);
      st.any = true;
      return st;
    },
    final: (s) => {
      const st = s as { parts: unknown[]; delims: unknown[]; any: boolean };
      if (!st.any) {
        return null;
      }
      if (isBytea) {
        const chunks: number[] = [];
        st.parts.forEach((p, i) => {
          if (i > 0 && st.delims[i] !== null) {
            chunks.push(...(st.delims[i] as Uint8Array));
          }
          chunks.push(...(p as Uint8Array));
        });
        return Uint8Array.from(chunks);
      }
      let out = '';
      st.parts.forEach((p, i) => {
        if (i > 0 && st.delims[i] !== null) {
          out += st.delims[i] as string;
        }
        out += p as string;
      });
      return out;
    },
  };
}

function jsonAgg(argType: number, strict: boolean): AggImpl {
  return {
    strict: false,
    init: () => ({ text: '', n: 0 }),
    step: (s, a, fc) => {
      const st = s as { text: string; n: number };
      if (strict && a[0] === null) {
        return st;
      }
      if (st.n > 0) {
        st.text += ', ';
        if (a[0] !== null) {
          const cat = jsonCategory(fc.st.catalog, argType).cat;
          if (cat === 'array' || cat === 'composite') {
            st.text += '\n ';
          }
        }
      }
      st.text += datumToJson(a[0], argType, fc);
      st.n++;
      return st;
    },
    final: (s) => ((s as { n: number }).n === 0 ? null : '[' + (s as { text: string }).text + ']'),
  };
}

function jsonbAgg(argType: number, strict: boolean): AggImpl {
  return {
    strict: false,
    init: () => ({ items: [] as JsonbValue[], n: 0 }),
    step: (s, a, fc) => {
      const st = s as { items: JsonbValue[]; n: number };
      if (strict && a[0] === null) {
        return st;
      }
      st.items.push(datumToJsonb(a[0], argType, fc));
      st.n++;
      return st;
    },
    final: (s) => ((s as { n: number }).n === 0 ? null : (s as { items: JsonbValue[] }).items),
  };
}

function jsonObjectAgg(keyType: number, valType: number, isJsonb: boolean, strict: boolean): AggImpl {
  return {
    strict: false,
    init: () => ({ parts: [] as string[], pairs: [] as [string, JsonbValue][], n: 0 }),
    step: (s, a, fc) => {
      const st = s as { parts: string[]; pairs: [string, JsonbValue][]; n: number };
      if (a[0] === null) {
        throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'null value not allowed for object key');
      }
      if (strict && a[1] === null) {
        return st;
      }
      if (isJsonb) {
        const k = datumToJsonb(a[0], keyType, fc, true);
        st.pairs.push([typeof k === 'string' ? k : jsonbToText(k), datumToJsonb(a[1], valType, fc)]);
      } else {
        st.parts.push(datumToJson(a[0], keyType, fc, true) + ' : ' + datumToJson(a[1], valType, fc));
      }
      st.n++;
      return st;
    },
    final: (s) => {
      const st = s as { parts: string[]; pairs: [string, JsonbValue][]; n: number };
      if (st.n === 0) {
        return null;
      }
      if (isJsonb) {
        return JsonbObject.fromPairs(st.pairs);
      }
      return '{ ' + st.parts.join(', ') + ' }';
    },
  };
}

function boolAgg(isAnd: boolean): AggImpl {
  return {
    init: () => null as boolean | null,
    step: (s, a) => {
      const v = a[0] as boolean;
      if (s === null) {
        return v;
      }
      return isAnd ? (s as boolean) && v : (s as boolean) || v;
    },
    final: (s) => s,
  };
}

function bitAgg(op: 'and' | 'or' | 'xor', type: number): AggImpl {
  return {
    init: () => null as unknown,
    step: (s, a) => {
      const v = a[0];
      if (s === null) {
        return v;
      }
      if (type === TypeOid.int8) {
        const x = toBigInt(s);
        const y = toBigInt(v);
        return op === 'and' ? x & y : op === 'or' ? x | y : x ^ y;
      }
      const x = s as number;
      const y = v as number;
      return op === 'and' ? x & y : op === 'or' ? x | y : x ^ y;
    },
    final: (s) => s,
  };
}

function orderedSetAgg(name: string, resultType: number, typeOps: TypeOps, argType: number): AggImpl {
  return {
    init: () => ({ values: [] as unknown[], direct: null as unknown }),
    step: (s, a) => {
      const st = s as { values: unknown[]; direct: unknown };
      if (a[0] !== null) {
        st.values.push(a[0]);
      }
      return st;
    },
    final: (s, fc) => {
      const st = s as { values: unknown[]; direct: unknown };
      const vals = st.values;
      if (vals.length === 0) {
        return null;
      }
      const direct = (fc as FnCall & { directArgs?: unknown[] }).directArgs?.[0];
      if (name === 'mode') {
        const cmp = typeOps.comparator(argType, 100);
        let best = vals[0];
        let bestCount = 0;
        let cur = vals[0];
        let count = 0;
        for (const v of vals) {
          if (cmp(v, cur) === 0) {
            count++;
          } else {
            cur = v;
            count = 1;
          }
          if (count > bestCount) {
            bestCount = count;
            best = cur;
          }
        }
        return best;
      }
      if (direct === null || direct === undefined) {
        return null;
      }
      const p = Number(direct);
      if (p < 0 || p > 1) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `percentile value ${p} is not between 0 and 1`);
      }
      if (name === 'percentile_disc') {
        const idx = Math.max(0, Math.ceil(p * vals.length) - 1);
        return vals[idx];
      }
      const pos = p * (vals.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      const x = Number(vals[lo]);
      const y = Number(vals[hi]);
      void resultType;
      return x + (y - x) * (pos - lo);
    },
  };
}

export function lookupAggregate(agg: AggNode, typeOps: TypeOps): AggImpl | null {
  const argType = agg.args[0]?.type ?? TypeOid.unknown;
  const name = agg.aggName;
  switch (name) {
    case 'count':
      // Counted as a double and widened once at the end: a BigInt increment allocates a new BigInt
      // per row, and `count` is the aggregate a scan runs most. A row count cannot reach 2^53.
      return {
        init: () => 0,
        step: (s) => (s as number) + 1,
        final: (s) => BigInt(s as number),
      };
    case 'sum':
      return sumAgg(argType, agg.type);
    case 'avg':
      return avgAgg(argType, agg.type);
    case 'min':
      return minMaxAgg(agg.type, agg.inputCollation || agg.collation, typeOps, false);
    case 'max':
      return minMaxAgg(agg.type, agg.inputCollation || agg.collation, typeOps, true);
    case 'array_agg':
      return arrayAgg(argType, typeOps, typeOps.catalog().getType(argType)?.isArray ?? false);
    case 'string_agg':
      return stringAgg(argType === TypeOid.bytea);
    case 'json_agg':
      return jsonAgg(argType, false);
    case 'json_agg_strict':
      return jsonAgg(argType, true);
    case 'jsonb_agg':
      return jsonbAgg(argType, false);
    case 'jsonb_agg_strict':
      return jsonbAgg(argType, true);
    case 'json_object_agg':
      return jsonObjectAgg(argType, agg.args[1].type, false, false);
    case 'json_object_agg_strict':
      return jsonObjectAgg(argType, agg.args[1].type, false, true);
    case 'jsonb_object_agg':
      return jsonObjectAgg(argType, agg.args[1].type, true, false);
    case 'jsonb_object_agg_strict':
      return jsonObjectAgg(argType, agg.args[1].type, true, true);
    case 'bool_and':
    case 'every':
      return boolAgg(true);
    case 'bool_or':
      return boolAgg(false);
    case 'bit_and':
      return bitAgg('and', argType);
    case 'bit_or':
      return bitAgg('or', argType);
    case 'bit_xor':
      return bitAgg('xor', argType);
    case 'stddev':
    case 'stddev_samp':
    case 'stddev_pop':
    case 'variance':
    case 'var_samp':
    case 'var_pop':
      return statAgg(name === 'stddev' ? 'stddev_samp' : name === 'variance' ? 'var_samp' : name, argType, agg.type);
    case 'percentile_cont':
    case 'percentile_disc':
    case 'mode':
      return orderedSetAgg(name, agg.type, typeOps, argType);
    case 'range_agg':
    case 'range_intersect_agg':
      return rangeAggregate(name, argType, agg.type);
    case 'any_value':
      // strict transition: the first non-NULL input
      return {
        init: () => undefined,
        step: (s, a) => (s === undefined ? a[0] : s),
        final: (s) => (s === undefined ? null : s),
      };
    case 'corr':
    case 'covar_pop':
    case 'covar_samp':
    case 'regr_avgx':
    case 'regr_avgy':
    case 'regr_count':
    case 'regr_intercept':
    case 'regr_r2':
    case 'regr_slope':
    case 'regr_sxx':
    case 'regr_sxy':
    case 'regr_syy':
      return regrAgg(name, agg.args[0].type, agg.args[1].type);
  }
  return null;
}

/**
 * float8_regr_accum and the regression final functions. Arguments are (Y, X); rows with a NULL in either are
 * skipped. Sxx / Syy / Sxy are kept as running central sums (Welford's method).
 */
function regrAgg(name: string, yType: number, xType: number): AggImpl {
  const toF = (v: unknown, type: number) => (v instanceof PgNumeric ? v.toNumber() : typeof v === 'bigint' ? Number(v) : (v as number));
  return {
    init: () => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }),
    step: (s, a) => {
      const st = s as { n: number; sx: number; sy: number; sxx: number; syy: number; sxy: number };
      const y = toF(a[0], yType);
      const x = toF(a[1], xType);
      const n = st.n + 1;
      if (st.n > 0) {
        const dx = x - st.sx / st.n;
        const dy = y - st.sy / st.n;
        st.sxx += (dx * dx * st.n) / n;
        st.syy += (dy * dy * st.n) / n;
        st.sxy += (dx * dy * st.n) / n;
      }
      st.n = n;
      st.sx += x;
      st.sy += y;
      return st;
    },
    final: (s) => {
      const { n, sx, sy, sxx, syy, sxy } = s as { n: number; sx: number; sy: number; sxx: number; syy: number; sxy: number };
      if (name === 'regr_count') {
        return BigInt(n);
      }
      if (n < 1) {
        return null;
      }
      switch (name) {
        case 'corr':
          return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
        case 'covar_pop':
          return sxy / n;
        case 'covar_samp':
          return n < 2 ? null : sxy / (n - 1);
        case 'regr_avgx':
          return sx / n;
        case 'regr_avgy':
          return sy / n;
        case 'regr_intercept':
          return sxx === 0 ? null : (sy - (sx * sxy) / sxx) / n;
        case 'regr_r2':
          return sxx === 0 ? null : syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
        case 'regr_slope':
          return sxx === 0 ? null : sxy / sxx;
        case 'regr_sxx':
          return sxx;
        case 'regr_sxy':
          return sxy;
        default:
          return syy;
      }
    },
  };
}

export { escapeJsonString, JNULL };
