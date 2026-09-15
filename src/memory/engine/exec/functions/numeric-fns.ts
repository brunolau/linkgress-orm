import { TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { formatFloat4ForNumeric, formatFloat8ForNumeric, PgNumeric } from '../../types/numeric';
import { numericExp, numericLn, numericLog, numericPowerFinite, numericSqrt } from '../../types/numeric-math';
import { floatToChar, intToChar, numericToChar, numericToNumber } from '../../types/numeric-format';
import { FnImpl } from '../runtime';
import { checkFloat4, checkFloat8, checkInt2, checkInt4, checkInt8, divisionByZero, toBigInt } from '../typeops';

const INTS = new Set<number>([TypeOid.int2, TypeOid.int4, TypeOid.int8]);
const FLOATS = new Set<number>([TypeOid.float4, TypeOid.float8]);

function toNumeric(v: unknown, type: number): PgNumeric {
  if (v instanceof PgNumeric) {
    return v;
  }
  if (typeof v === 'bigint') {
    return PgNumeric.fromBigInt(v);
  }
  if (type === TypeOid.float4) {
    return floatToNumeric(v as number, true);
  }
  if (type === TypeOid.float8) {
    return floatToNumeric(v as number, false);
  }
  return PgNumeric.fromInt(v as number);
}

export function floatToNumeric(v: number, isFloat4: boolean): PgNumeric {
  if (Number.isNaN(v)) {
    return PgNumeric.NAN;
  }
  if (v === Infinity) {
    return PgNumeric.PINF;
  }
  if (v === -Infinity) {
    return PgNumeric.NINF;
  }
  return PgNumeric.parse(isFloat4 ? formatFloat4ForNumeric(v) : formatFloat8ForNumeric(v));
}

function toFloat(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  if (v instanceof PgNumeric) {
    return v.toNumber();
  }
  return Number(v);
}

/** round half to even (C rint) */
export function rint(x: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) {
    return f + 1;
  }
  if (diff < 0.5) {
    return f;
  }
  return f % 2 === 0 ? f : f + 1;
}

function intRangeError(type: number): PgError {
  const name = type === TypeOid.int2 ? 'smallint' : type === TypeOid.int4 ? 'integer' : 'bigint';
  return new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, `${name} out of range`);
}

function checkIntResult(type: number, v: number | bigint): number | bigint {
  switch (type) {
    case TypeOid.int2:
      return checkInt2(Number(v));
    case TypeOid.int4:
      return checkInt4(Number(v));
    default:
      return checkInt8(toBigInt(v));
  }
}

/** Generic arithmetic for builtin numeric operators. */
export function genericArith(op: string, argTypes: number[], resultType: number): FnImpl | null {
  if (argTypes.length === 1) {
    const t = argTypes[0];
    if (op === '-') {
      if (INTS.has(t)) {
        return (a) => (t === TypeOid.int8 ? checkInt8(-toBigInt(a[0])) : checkIntResult(t, -(a[0] as number)));
      }
      if (FLOATS.has(t)) {
        return (a) => -(a[0] as number);
      }
      if (t === TypeOid.numeric) {
        return (a) => (a[0] as PgNumeric).neg_();
      }
    }
    if (op === '+') {
      if (INTS.has(t) || FLOATS.has(t) || t === TypeOid.numeric) {
        return (a) => a[0];
      }
    }
    if (op === '@') {
      if (INTS.has(t)) {
        return (a) => (t === TypeOid.int8 ? checkInt8(toBigInt(a[0]) < 0n ? -toBigInt(a[0]) : toBigInt(a[0])) : checkIntResult(t, Math.abs(a[0] as number)));
      }
      if (FLOATS.has(t)) {
        return (a) => Math.abs(a[0] as number);
      }
      if (t === TypeOid.numeric) {
        return (a) => (a[0] as PgNumeric).abs();
      }
    }
    if (op === '|/' && t === TypeOid.float8) {
      return (a) => fsqrt(a[0] as number);
    }
    if (op === '||/' && t === TypeOid.float8) {
      return (a) => Math.cbrt(a[0] as number);
    }
    if (op === '~' && INTS.has(t)) {
      return (a) => (t === TypeOid.int8 ? ~toBigInt(a[0]) : ~(a[0] as number));
    }
    return null;
  }
  if (argTypes.length !== 2) {
    return null;
  }
  const [lt, rt] = argTypes;
  const bothInts = INTS.has(lt) && INTS.has(rt);
  if (bothInts && INTS.has(resultType)) {
    if (resultType === TypeOid.int8) {
      switch (op) {
        case '+':
          return (a) => checkInt8(toBigInt(a[0]) + toBigInt(a[1]));
        case '-':
          return (a) => checkInt8(toBigInt(a[0]) - toBigInt(a[1]));
        case '*':
          return (a) => checkInt8(toBigInt(a[0]) * toBigInt(a[1]));
        case '/':
          return (a) => {
            const d = toBigInt(a[1]);
            if (d === 0n) {
              throw divisionByZero();
            }
            return checkInt8(toBigInt(a[0]) / d);
          };
        case '%':
          return (a) => {
            const d = toBigInt(a[1]);
            if (d === 0n) {
              throw divisionByZero();
            }
            return toBigInt(a[0]) % d;
          };
        case '&':
          return (a) => toBigInt(a[0]) & toBigInt(a[1]);
        case '|':
          return (a) => toBigInt(a[0]) | toBigInt(a[1]);
        case '#':
          return (a) => toBigInt(a[0]) ^ toBigInt(a[1]);
        case '<<':
          return (a) => BigInt.asIntN(64, toBigInt(a[0]) << BigInt(Number(a[1]) & 63));
        case '>>':
          return (a) => toBigInt(a[0]) >> BigInt(Number(a[1]) & 63);
      }
      return null;
    }
    const check = resultType === TypeOid.int2 ? checkInt2 : checkInt4;
    switch (op) {
      case '+':
        return (a) => check((a[0] as number) + (a[1] as number));
      case '-':
        return (a) => check((a[0] as number) - (a[1] as number));
      case '*':
        return (a) => {
          const r = (a[0] as number) * (a[1] as number);
          if (!Number.isSafeInteger(r)) {
            throw intRangeError(resultType);
          }
          return check(r);
        };
      case '/':
        return (a) => {
          const d = a[1] as number;
          if (d === 0) {
            throw divisionByZero();
          }
          return check(Math.trunc((a[0] as number) / d));
        };
      case '%':
        return (a) => {
          const d = a[1] as number;
          if (d === 0) {
            throw divisionByZero();
          }
          const r = (a[0] as number) % d;
          return r === 0 ? 0 : r;
        };
      case '&':
        return (a) => (a[0] as number) & (a[1] as number);
      case '|':
        return (a) => (a[0] as number) | (a[1] as number);
      case '#':
        return (a) => (a[0] as number) ^ (a[1] as number);
      case '<<':
        return (a) => check(resultType === TypeOid.int2 ? ((a[0] as number) << ((a[1] as number) & 31)) << 16 >> 16 : (a[0] as number) << ((a[1] as number) & 31));
      case '>>':
        return (a) => (a[0] as number) >> ((a[1] as number) & 31);
    }
    return null;
  }
  if (resultType === TypeOid.float8 || resultType === TypeOid.float4) {
    const fcheck = resultType === TypeOid.float4 ? checkFloat4 : checkFloat8;
    switch (op) {
      case '+':
        return (a) => {
          const x = toFloat(a[0]);
          const y = toFloat(a[1]);
          return fcheck(x + y, Number.isFinite(x) && Number.isFinite(y));
        };
      case '-':
        return (a) => {
          const x = toFloat(a[0]);
          const y = toFloat(a[1]);
          return fcheck(x - y, Number.isFinite(x) && Number.isFinite(y));
        };
      case '*':
        return (a) => {
          const x = toFloat(a[0]);
          const y = toFloat(a[1]);
          const r = x * y;
          if (r === 0 && x !== 0 && y !== 0 && Number.isFinite(x) && Number.isFinite(y)) {
            throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: underflow');
          }
          return fcheck(r, Number.isFinite(x) && Number.isFinite(y));
        };
      case '/':
        return (a) => {
          const x = toFloat(a[0]);
          const y = toFloat(a[1]);
          if (y === 0 && !Number.isNaN(x)) {
            throw divisionByZero();
          }
          return fcheck(x / y, Number.isFinite(x) && Number.isFinite(y));
        };
      case '^':
        return (a) => fpow(toFloat(a[0]), toFloat(a[1]));
    }
    return null;
  }
  if (resultType === TypeOid.numeric) {
    switch (op) {
      case '+':
        return (a) => toNumeric(a[0], lt).add(toNumeric(a[1], rt));
      case '-':
        return (a) => toNumeric(a[0], lt).sub(toNumeric(a[1], rt));
      case '*':
        return (a) => toNumeric(a[0], lt).mul(toNumeric(a[1], rt));
      case '/':
        return (a) => toNumeric(a[0], lt).div(toNumeric(a[1], rt));
      case '%':
        return (a) => toNumeric(a[0], lt).mod(toNumeric(a[1], rt));
      case '^':
        return (a) => numericPower(toNumeric(a[0], lt), toNumeric(a[1], rt));
    }
  }
  return null;
}

function fsqrt(x: number): number {
  if (x < 0) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'cannot take square root of a negative number');
  }
  return Math.sqrt(x);
}

function fpow(x: number, y: number): number {
  if (x === 0 && y < 0) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'zero raised to a negative power is undefined');
  }
  if (x < 0 && !Number.isInteger(y)) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'a negative number raised to a non-integer power yields a complex result');
  }
  const r = Math.pow(x, y);
  if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: overflow');
  }
  return r;
}

export function numericPower(base: PgNumeric, exp: PgNumeric): PgNumeric {
  if (base.isNaN() || exp.isNaN()) {
    return base.isNaN() && exp.isZero() ? PgNumeric.ONE : exp.isNaN() && base.compare(PgNumeric.ONE) === 0 ? PgNumeric.ONE : PgNumeric.NAN;
  }
  if (base.isZero() && exp.signum() < 0) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'zero raised to a negative power is undefined');
  }
  if (base.kind === 'n' && exp.kind === 'n') {
    return numericPowerFinite(base, exp);
  }
  if (exp.kind === 'n' && exp.scale === 0 || exp.trimScale().scale === 0) {
    const e = exp.trimScale();
    if (e.kind === 'n' && e.mag <= 10000n) {
      const n = Number(e.mag);
      if (!e.neg) {
        let r = PgNumeric.ONE;
        for (let i = 0; i < n; i++) {
          r = r.mul(base);
        }
        // PostgreSQL result scale for integer powers
        const rscale = Math.max(0, Math.min(1000, base.scale * n));
        return r.round(Math.min(rscale, Math.max(16, base.scale))).trimScale().round(Math.max(0, Math.min(rscale, 16 + base.scale)));
      }
      let r = PgNumeric.ONE;
      for (let i = 0; i < n; i++) {
        r = r.mul(base);
      }
      return PgNumeric.divScaled(PgNumeric.ONE, r, 16, true);
    }
  }
  const v = Math.pow(base.toNumber(), exp.toNumber());
  if (base.signum() < 0 && !Number.isInteger(exp.toNumber())) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'a negative number raised to a non-integer power yields a complex result');
  }
  return PgNumeric.parse(v.toFixed(16)).round(16);
}

/** Generic numeric casts between int/float/numeric/bool. */
export function genericNumericCast(from: number, to: number, typmod: number): FnImpl | null {
  if (from === to && to === TypeOid.numeric) {
    return (a) => (typmod >= 4 ? (a[0] as PgNumeric).applyTypmod(typmod) : a[0]);
  }
  if (INTS.has(from) && INTS.has(to)) {
    return (a) => checkIntResult(to, a[0] as number | bigint);
  }
  if (INTS.has(from) && FLOATS.has(to)) {
    return (a) => (to === TypeOid.float4 ? Math.fround(Number(a[0])) : Number(a[0]));
  }
  if (FLOATS.has(from) && INTS.has(to)) {
    return (a) => {
      const x = a[0] as number;
      if (!Number.isFinite(x)) {
        throw intRangeError(to);
      }
      const r = rint(x);
      if (to === TypeOid.int8) {
        if (r < -9223372036854775808 || r >= 9223372036854775808) {
          throw intRangeError(to);
        }
        return BigInt(r);
      }
      return checkIntResult(to, r);
    };
  }
  if (FLOATS.has(from) && FLOATS.has(to)) {
    if (to === TypeOid.float4) {
      return (a) => checkFloat4(a[0] as number, Number.isFinite(a[0] as number));
    }
    return (a) => a[0];
  }
  if ((INTS.has(from) || FLOATS.has(from)) && to === TypeOid.numeric) {
    return (a) => {
      const n = toNumeric(a[0], from);
      return typmod >= 4 ? n.applyTypmod(typmod) : n;
    };
  }
  if (from === TypeOid.numeric && INTS.has(to)) {
    return (a) => {
      const n = a[0] as PgNumeric;
      if (n.kind !== 'n') {
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cannot convert ${n.isNaN() ? 'NaN' : 'infinity'} to ${to === TypeOid.int2 ? 'smallint' : to === TypeOid.int4 ? 'integer' : 'bigint'}`);
      }
      const v = n.toBigIntRounded();
      return to === TypeOid.int8 ? checkInt8(v) : checkIntResult(to, (v > 4294967296n || v < -4294967296n) ? Number.MAX_SAFE_INTEGER : Number(v));
    };
  }
  if (from === TypeOid.numeric && FLOATS.has(to)) {
    return (a) => {
      const f = (a[0] as PgNumeric).toNumber();
      if (to === TypeOid.float4) {
        return checkFloat4(f, Number.isFinite(f));
      }
      if (!Number.isFinite(f) && (a[0] as PgNumeric).kind === 'n') {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: overflow');
      }
      return f;
    };
  }
  if (from === TypeOid.bool && to === TypeOid.int4) {
    return (a) => (a[0] ? 1 : 0);
  }
  if (from === TypeOid.int4 && to === TypeOid.bool) {
    return (a) => a[0] !== 0;
  }
  if (from === TypeOid.oid && INTS.has(to)) {
    return (a) => checkIntResult(to, a[0] as number);
  }
  if (INTS.has(from) && (to === TypeOid.oid || to === TypeOid.regclass || to === TypeOid.regtype || to === TypeOid.regproc)) {
    return (a) => {
      const n = Number(a[0]);
      return n < 0 ? n >>> 0 : n;
    };
  }
  return null;
}

function numArg(v: unknown): PgNumeric {
  return v instanceof PgNumeric ? v : typeof v === 'bigint' ? PgNumeric.fromBigInt(v) : PgNumeric.fromNumber(v as number);
}

/** Math functions keyed by prosrc. */
export const NUMERIC_FUNCS: Record<string, FnImpl> = {
  // to_char / to_number
  numeric_to_char: (a) => numericToChar(a[0] as PgNumeric, a[1] as string),
  int4_to_char: (a) => intToChar(a[0] as number, a[1] as string),
  int8_to_char: (a) => intToChar(toBigInt(a[0]), a[1] as string),
  float4_to_char: (a) => floatToChar(a[0] as number, a[1] as string, true),
  float8_to_char: (a) => floatToChar(a[0] as number, a[1] as string, false),
  numeric_to_number: (a) => numericToNumber(a[0] as string, a[1] as string),
  // abs
  int2abs: (a) => checkInt2(Math.abs(a[0] as number)),
  int4abs: (a) => checkInt4(Math.abs(a[0] as number)),
  int8abs: (a) => checkInt8(toBigInt(a[0]) < 0n ? -toBigInt(a[0]) : toBigInt(a[0])),
  float4abs: (a) => Math.abs(a[0] as number),
  float8abs: (a) => Math.abs(a[0] as number),
  numeric_abs: (a) => (a[0] as PgNumeric).abs(),
  // rounding
  numeric_round: (a) => (a[0] as PgNumeric).round(a.length > 1 ? (a[1] as number) : 0),
  numeric_trunc: (a) => (a[0] as PgNumeric).trunc(a.length > 1 ? (a[1] as number) : 0),
  numeric_ceil: (a) => (a[0] as PgNumeric).ceil(),
  numeric_floor: (a) => (a[0] as PgNumeric).floor(),
  numeric_sign: (a) => {
    const n = a[0] as PgNumeric;
    return n.isNaN() ? PgNumeric.NAN : PgNumeric.fromInt(n.signum());
  },
  dround: (a) => rint(a[0] as number),
  dtrunc: (a) => Math.trunc(a[0] as number),
  dceil: (a) => Math.ceil(a[0] as number),
  dfloor: (a) => Math.floor(a[0] as number),
  dsign: (a) => {
    const x = a[0] as number;
    return x > 0 ? 1 : x < 0 ? -1 : 0;
  },
  dsqrt: (a) => fsqrt(a[0] as number),
  dcbrt: (a) => Math.cbrt(a[0] as number),
  dpow: (a) => fpow(a[0] as number, a[1] as number),
  dexp: (a) => {
    const r = Math.exp(a[0] as number);
    if (!Number.isFinite(r) && Number.isFinite(a[0] as number)) {
      throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value out of range: overflow');
    }
    return r;
  },
  dlog1: (a) => {
    const x = a[0] as number;
    if (x === 0) {
      throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of zero');
    }
    if (x < 0) {
      throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of a negative number');
    }
    return Math.log(x);
  },
  dlog10: (a) => {
    const x = a[0] as number;
    if (x === 0) {
      throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of zero');
    }
    if (x < 0) {
      throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of a negative number');
    }
    return Math.log10(x);
  },
  numeric_sqrt: (a) => numericSqrt(a[0] as PgNumeric),
  numeric_exp: (a) => numericExp(a[0] as PgNumeric),
  numeric_ln: (a) => numericLn(a[0] as PgNumeric),
  numeric_log: (a) => numericLog(a[0] as PgNumeric, a[1] as PgNumeric),
  numeric_power: (a) => numericPower(a[0] as PgNumeric, a[1] as PgNumeric),
  numeric_mod: (a) => (a[0] as PgNumeric).mod(a[1] as PgNumeric),
  numeric_div_trunc: (a) => {
    const x = a[0] as PgNumeric;
    const y = a[1] as PgNumeric;
    if (y.isZero()) {
      throw divisionByZero();
    }
    return PgNumeric.divScaled(x, y, 0, false);
  },
  numeric_scale: (a) => ((a[0] as PgNumeric).kind === 'n' ? (a[0] as PgNumeric).scale : null),
  numeric_min_scale: (a) => ((a[0] as PgNumeric).kind === 'n' ? (a[0] as PgNumeric).minScale() : null),
  numeric_trim_scale: (a) => (a[0] as PgNumeric).trimScale(),
  int4mod: (a) => {
    if (a[1] === 0) {
      throw divisionByZero();
    }
    const r = (a[0] as number) % (a[1] as number);
    return r === 0 ? 0 : r;
  },
  int2mod: (a) => {
    if (a[1] === 0) {
      throw divisionByZero();
    }
    const r = (a[0] as number) % (a[1] as number);
    return r === 0 ? 0 : r;
  },
  int8mod: (a) => {
    if (toBigInt(a[1]) === 0n) {
      throw divisionByZero();
    }
    return toBigInt(a[0]) % toBigInt(a[1]);
  },
  dpi: () => Math.PI,
  degrees: (a) => ((a[0] as number) * 180) / Math.PI,
  radians: (a) => ((a[0] as number) * Math.PI) / 180,
  dsin: (a) => Math.sin(a[0] as number),
  dcos: (a) => Math.cos(a[0] as number),
  dtan: (a) => Math.tan(a[0] as number),
  dasin: (a) => Math.asin(a[0] as number),
  dacos: (a) => Math.acos(a[0] as number),
  datan: (a) => Math.atan(a[0] as number),
  datan2: (a) => Math.atan2(a[0] as number, a[1] as number),
  drandom: (_a, fc) => fc.st.session.random(),
  setseed: (a, fc) => {
    fc.st.session.setSeed(a[0] as number);
    return '';
  },
  int4gcd: (a) => gcdNum(a[0] as number, a[1] as number),
  int8gcd: (a) => gcdBig(toBigInt(a[0]), toBigInt(a[1])),
  int4lcm: (a) => {
    const x = a[0] as number;
    const y = a[1] as number;
    if (x === 0 || y === 0) {
      return 0;
    }
    return checkInt4(Math.abs((x / gcdNum(x, y)) * y));
  },
  numeric_fac: (a) => {
    const n = toBigInt(a[0]);
    if (n < 0n) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'factorial of a negative number is undefined');
    }
    let r = 1n;
    for (let i = 2n; i <= n; i++) {
      r *= i;
    }
    return PgNumeric.fromBigInt(r);
  },
  width_bucket_float8: (a) => widthBucket(a[0] as number, a[1] as number, a[2] as number, a[3] as number),
  width_bucket_numeric: (a) => widthBucket((a[0] as PgNumeric).toNumber(), (a[1] as PgNumeric).toNumber(), (a[2] as PgNumeric).toNumber(), a[3] as number),
  int4larger: (a) => Math.max(a[0] as number, a[1] as number),
  int4smaller: (a) => Math.min(a[0] as number, a[1] as number),
  numeric_larger: (a) => ((a[0] as PgNumeric).compare(a[1] as PgNumeric) >= 0 ? a[0] : a[1]),
  numeric_smaller: (a) => ((a[0] as PgNumeric).compare(a[1] as PgNumeric) <= 0 ? a[0] : a[1]),
  numeric_inc: (a) => (a[0] as PgNumeric).add(PgNumeric.ONE),
  int4inc: (a) => checkInt4((a[0] as number) + 1),
  int8inc: (a) => checkInt8(toBigInt(a[0]) + 1n),
  numeric_int4: (a) => genericNumericCast(TypeOid.numeric, TypeOid.int4, -1)!(a, undefined as never),
};

function gcdNum(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function widthBucket(op: number, lo: number, hi: number, count: number): number {
  if (count <= 0) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_WIDTH_BUCKET_FUNCTION, 'count must be greater than zero');
  }
  if (lo === hi) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_WIDTH_BUCKET_FUNCTION, 'lower bound cannot equal upper bound');
  }
  if (lo < hi) {
    if (op < lo) {
      return 0;
    }
    if (op >= hi) {
      return count + 1;
    }
    return Math.floor(((op - lo) / (hi - lo)) * count) + 1;
  }
  if (op > lo) {
    return 0;
  }
  if (op <= hi) {
    return count + 1;
  }
  return Math.floor(((lo - op) / (lo - hi)) * count) + 1;
}

export { numArg, toNumeric, toFloat };
