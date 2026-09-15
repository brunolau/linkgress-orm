import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { Interval, timestampPlusInterval, USECS_PER_DAY } from '../../types/datetime';
import { outputValue } from '../../types/io';
import { PgNumeric } from '../../types/numeric';
import { arrayLowerBound, withLowerBound } from '../../types/values';
import { FnCall, FnImpl } from '../runtime';
import { toBigInt } from '../typeops';

function elemTypeOf(fc: FnCall, argIndex: number): number {
  const t = fc.st.catalog.getType(fc.argTypes[argIndex]);
  return t?.isArray ? t.elem : fc.argTypes[argIndex];
}

function flat(a: unknown[]): unknown[] {
  if (a.length === 0 || !Array.isArray(a[0])) {
    return a;
  }
  return (a as unknown[][]).flat(Infinity as 1);
}

function equalsFn(fc: FnCall, elemType: number): (x: unknown, y: unknown) => boolean {
  const cmp = fc.st.session.typeOps.comparator(elemType, fc.collation || 100);
  return (x, y) => x !== null && y !== null && cmp(x, y) === 0;
}

function ndims(a: unknown[]): number {
  let n = 1;
  let cur: unknown = a[0];
  while (Array.isArray(cur)) {
    n++;
    cur = cur[0];
  }
  return a.length === 0 ? 0 : n;
}

function dimLengths(a: unknown[]): number[] {
  if (a.length === 0) {
    return [];
  }
  const out = [a.length];
  let cur: unknown = a[0];
  while (Array.isArray(cur)) {
    out.push(cur.length);
    cur = cur[0];
  }
  return out;
}

export const ARRAY_FUNCS: Record<string, FnImpl> = {
  arraycontains: (a, fc) => {
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    const hay = flat(a[0] as unknown[]);
    return flat(a[1] as unknown[]).every((x) => hay.some((y) => eq(x, y)));
  },
  arraycontained: (a, fc) => {
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    const hay = flat(a[1] as unknown[]);
    return flat(a[0] as unknown[]).every((x) => hay.some((y) => eq(x, y)));
  },
  arrayoverlap: (a, fc) => {
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    const hay = flat(a[1] as unknown[]);
    return flat(a[0] as unknown[]).some((x) => hay.some((y) => eq(x, y)));
  },
  array_append: (a) => {
    const arr = (a[0] as unknown[] | null) ?? [];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      throw new PgError(SqlState.DATA_EXCEPTION, 'argument must be empty or one-dimensional array');
    }
    return withLowerBound([...arr, a[1]], arrayLowerBound(arr));
  },
  array_prepend: (a) => {
    const arr = (a[1] as unknown[] | null) ?? [];
    return [a[0], ...arr];
  },
  array_cat: (a) => {
    const x = a[0] as unknown[] | null;
    const y = a[1] as unknown[] | null;
    if (x === null) {
      return y;
    }
    if (y === null) {
      return x;
    }
    if (x.length === 0) {
      return y;
    }
    if (y.length === 0) {
      return x;
    }
    const dx = ndims(x);
    const dy = ndims(y);
    if (dx === dy) {
      return [...x, ...y];
    }
    if (dx === dy + 1) {
      return [...x, y];
    }
    if (dy === dx + 1) {
      return [x, ...y];
    }
    throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'cannot concatenate incompatible arrays', {
      detail: `Arrays with differing element dimensions are not compatible for concatenation.`,
    });
  },
  array_length: (a) => {
    const arr = a[0] as unknown[];
    const dim = a[1] as number;
    const dims = dimLengths(arr);
    if (dim < 1 || dim > dims.length) {
      return null;
    }
    return dims[dim - 1];
  },
  array_lower: (a) => {
    const arr = a[0] as unknown[];
    const dim = a[1] as number;
    if (arr.length === 0 || dim < 1 || dim > ndims(arr)) {
      return null;
    }
    return dim === 1 ? arrayLowerBound(arr) : 1;
  },
  array_upper: (a) => {
    const arr = a[0] as unknown[];
    const dim = a[1] as number;
    const dims = dimLengths(arr);
    if (dim < 1 || dim > dims.length) {
      return null;
    }
    return (dim === 1 ? arrayLowerBound(arr) : 1) + dims[dim - 1] - 1;
  },
  array_ndims: (a) => {
    const arr = a[0] as unknown[];
    return arr.length === 0 ? null : ndims(arr);
  },
  array_dims: (a) => {
    const arr = a[0] as unknown[];
    if (arr.length === 0) {
      return null;
    }
    const lb = arrayLowerBound(arr);
    return dimLengths(arr)
      .map((len, i) => `[${i === 0 ? lb : 1}:${(i === 0 ? lb : 1) + len - 1}]`)
      .join('');
  },
  array_cardinality: (a) => flat(a[0] as unknown[]).length,
  array_position: (a, fc) => {
    const arr = a[0] as unknown[];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'searching for elements in multidimensional arrays is not supported');
    }
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    const start = a.length > 2 && a[2] !== null ? (a[2] as number) - arrayLowerBound(arr) : 0;
    for (let i = Math.max(0, start); i < arr.length; i++) {
      if (a[1] === null ? arr[i] === null : eq(arr[i], a[1])) {
        return i + arrayLowerBound(arr);
      }
    }
    return null;
  },
  array_position_start: (a, fc) => ARRAY_FUNCS.array_position(a, fc),
  array_positions: (a, fc) => {
    const arr = a[0] as unknown[];
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    const out: number[] = [];
    arr.forEach((x, i) => {
      if (a[1] === null ? x === null : eq(x, a[1])) {
        out.push(i + arrayLowerBound(arr));
      }
    });
    return out;
  },
  array_remove: (a, fc) => {
    const arr = a[0] as unknown[];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'removing elements from multidimensional arrays is not supported');
    }
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    return arr.filter((x) => !(a[1] === null ? x === null : eq(x, a[1])));
  },
  array_replace: (a, fc) => {
    const arr = a[0] as unknown[];
    const eq = equalsFn(fc, elemTypeOf(fc, 0));
    return arr.map((x) => ((a[1] === null ? x === null : eq(x, a[1])) ? a[2] : x));
  },
  array_to_text: (a, fc) => {
    const elemType = elemTypeOf(fc, 0);
    const io = fc.st.session.io;
    return flat(a[0] as unknown[])
      .filter((x) => x !== null)
      .map((x) => outputValue(elemType, x, io))
      .join(a[1] as string);
  },
  array_to_text_null: (a, fc) => {
    const elemType = elemTypeOf(fc, 0);
    const io = fc.st.session.io;
    const nullStr = a[2] as string | null;
    return flat(a[0] as unknown[])
      .filter((x) => x !== null || nullStr !== null)
      .map((x) => (x === null ? nullStr : outputValue(elemType, x, io)))
      .join(a[1] as string);
  },
  text_to_array: (a) => splitToArray(a[0] as string, a[1] as string | null, null),
  text_to_array_null: (a) => splitToArray(a[0] as string, a[1] as string | null, a[2] as string | null),
  array_fill: (a) => {
    const dims = a[1] as number[];
    const build = (d: number): unknown[] => {
      const out: unknown[] = [];
      for (let i = 0; i < dims[d]; i++) {
        out.push(d + 1 < dims.length ? build(d + 1) : a[0]);
      }
      return out;
    };
    return dims.length === 0 ? [] : build(0);
  },
  trim_array: (a) => {
    const arr = a[0] as unknown[];
    const n = a[1] as number;
    if (n < 0 || n > arr.length) {
      throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'number of elements to trim must be between 0 and ' + arr.length);
    }
    return arr.slice(0, arr.length - n);
  },
  array_reverse: (a) => (a[0] as unknown[]).slice().reverse(),
  array_sort: (a, fc) => {
    const cmp = fc.st.session.typeOps.comparator(elemTypeOf(fc, 0), fc.collation || 100);
    const desc = a.length > 1 && a[1] === true;
    return (a[0] as unknown[]).slice().sort((x, y) => {
      if (x === null) {
        return y === null ? 0 : 1;
      }
      if (y === null) {
        return -1;
      }
      const r = cmp(x, y);
      return desc ? -r : r;
    });
  },
  array_larger: (a, fc) => (fc.st.session.typeOps.comparator(fc.argTypes[0], 100)(a[0], a[1]) >= 0 ? a[0] : a[1]),
  array_smaller: (a, fc) => (fc.st.session.typeOps.comparator(fc.argTypes[0], 100)(a[0], a[1]) <= 0 ? a[0] : a[1]),
};

function splitToArray(s: string, delim: string | null, nullStr: string | null): (string | null)[] {
  if (s === '') {
    return [];
  }
  let parts: string[];
  if (delim === null) {
    parts = Array.from(s);
  } else if (delim === '') {
    parts = [s];
  } else {
    parts = s.split(delim);
  }
  return parts.map((p) => (nullStr !== null && p === nullStr ? null : p));
}

export const ARRAY_SRFS: Record<string, FnImpl> = {
  array_unnest: (a) => flat(a[0] as unknown[]).slice(),
  generate_series_int4: (a) => seriesInt(a, false),
  generate_series_step_int4: (a) => seriesInt(a, false),
  generate_series_int8: (a) => seriesInt(a, true),
  generate_series_step_int8: (a) => seriesInt(a, true),
  generate_series_numeric: (a) => seriesNumeric(a),
  generate_series_step_numeric: (a) => seriesNumeric(a),
  generate_series_timestamp: (a) => seriesTimestamp(a, null),
  generate_series_timestamptz: (a, fc) => seriesTimestamp(a, fc.st.session.io.zone),
  generate_series_timestamptz_at_zone: (a, fc) => seriesTimestamp(a, fc.st.session.io.zone),
  generate_subscripts: (a) => {
    const arr = a[0] as unknown[];
    const dim = a[1] as number;
    const dims = dimLengths(arr);
    if (dim < 1 || dim > dims.length) {
      return [];
    }
    const lb = dim === 1 ? arrayLowerBound(arr) : 1;
    const out: number[] = [];
    for (let i = 0; i < dims[dim - 1]; i++) {
      out.push(lb + i);
    }
    return a[2] === true ? out.reverse() : out;
  },
  generate_subscripts_nodir: (a) => ARRAY_SRFS.generate_subscripts([a[0], a[1], false], undefined as never),
};

function seriesInt(a: unknown[], big: boolean): unknown[] {
  const out: unknown[] = [];
  if (big) {
    const start = toBigInt(a[0]);
    const stop = toBigInt(a[1]);
    const step = a.length > 2 ? toBigInt(a[2]) : 1n;
    if (step === 0n) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'step size cannot equal zero');
    }
    for (let v = start; step > 0n ? v <= stop : v >= stop; v += step) {
      out.push(v);
    }
    return out;
  }
  const start = a[0] as number;
  const stop = a[1] as number;
  const step = a.length > 2 ? (a[2] as number) : 1;
  if (step === 0) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'step size cannot equal zero');
  }
  for (let v = start; step > 0 ? v <= stop : v >= stop; v += step) {
    out.push(v);
  }
  return out;
}

function seriesNumeric(a: unknown[]): unknown[] {
  const start = a[0] as PgNumeric;
  const stop = a[1] as PgNumeric;
  const step = a.length > 2 ? (a[2] as PgNumeric) : PgNumeric.ONE;
  if (step.isZero()) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'step size cannot equal zero');
  }
  const out: unknown[] = [];
  const pos = step.signum() > 0;
  for (let v = start; pos ? v.compare(stop) <= 0 : v.compare(stop) >= 0; v = v.add(step)) {
    out.push(v);
  }
  return out;
}

function seriesTimestamp(a: unknown[], zone: import('../../types/datetime').ZoneSpec | null): unknown[] {
  const start = a[0] as number;
  const stop = a[1] as number;
  const step = a[2] as Interval;
  const probe = timestampPlusInterval(start, step, zone) - start;
  if (probe === 0) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'step size cannot equal zero');
  }
  const out: number[] = [];
  let v = start;
  let guard = 0;
  while (probe > 0 ? v <= stop : v >= stop) {
    out.push(v);
    v = timestampPlusInterval(v, step, zone);
    if (++guard > 10_000_000) {
      break;
    }
  }
  void USECS_PER_DAY;
  return out;
}

export { TypeOid };
