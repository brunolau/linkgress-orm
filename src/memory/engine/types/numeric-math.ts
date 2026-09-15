import { PgError, SqlState } from '../errors';
import { PgNumeric } from './numeric';

/**
 * Transcendental numeric functions (sqrt, exp, ln, log, power) with numeric.c's result scales.
 *
 * Values are computed in BigInt fixed point with guard digits and rounded half away from zero at the
 * result scale PostgreSQL selects, so they agree digit for digit with the server's output.
 */

const NUMERIC_MIN_SIG_DIGITS = 16;
const NUMERIC_MAX_DISPLAY_SCALE = 1000;
const NUMERIC_MAX_RESULT_SCALE = NUMERIC_MAX_DISPLAY_SCALE * 2;
const GUARD = 24;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

const clampScale = (rscale: number, ...dscales: number[]): number => {
  let r = rscale;
  for (const d of dscales) {
    r = Math.max(r, d);
  }
  return Math.min(Math.max(r, 0), NUMERIC_MAX_DISPLAY_SCALE);
};

/** value * 10^w as a (signed) BigInt, truncated */
function toFixed(n: PgNumeric, w: number): bigint {
  const v = w >= n.scale ? n.mag * pow10(w - n.scale) : n.mag / pow10(n.scale - w);
  return n.neg ? -v : v;
}

/** a fixed-point value at scale w, rounded half away from zero to `rscale` digits */
function fromFixed(r: bigint, w: number, rscale: number): PgNumeric {
  const neg = r < 0n;
  let mag = neg ? -r : r;
  if (w > rscale) {
    const d = pow10(w - rscale);
    const q = mag / d;
    const rem = mag % d;
    mag = rem * 2n >= d ? q + 1n : q;
  } else if (w < rscale) {
    mag *= pow10(rscale - w);
  }
  return PgNumeric.make(neg, mag, rscale);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) {
    return n;
  }
  // Newton's method from a start above the root decreases monotonically to floor(sqrt(n))
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      return x;
    }
    x = y;
  }
}

/** base-10000 weight and the first two base-10000 digits of a non-zero value (NumericVar layout) */
function varDigits(n: PgNumeric): { weight: number; d0: number; d1: number; ndigits: number } {
  if (n.mag === 0n) {
    return { weight: 0, d0: 0, d1: 0, ndigits: 0 };
  }
  const s = n.mag.toString();
  const p = s.length - 1 - n.scale;
  const weight = Math.floor(p / 4);
  // decimal digits aligned so that the first group holds exponents weight*4 .. weight*4+3
  const lead = p - weight * 4 + 1;
  const padded = s + '0'.repeat(8);
  const d0 = parseInt(padded.slice(0, lead), 10);
  const d1 = parseInt(padded.slice(lead, lead + 4), 10);
  // number of significant base-10000 digits (trailing zero groups dropped)
  const trimmed = s.replace(/0+$/, '');
  const lowExp = s.length - trimmed.length - n.scale;
  const ndigits = weight - Math.floor(lowExp / 4) + 1;
  return { weight, d0, d1, ndigits };
}

/** estimate_ln_dweight */
function estimateLnDweight(n: PgNumeric): number {
  if (n.neg || n.mag === 0n) {
    return 0;
  }
  const v = n.toNumber();
  if (v >= 0.9 && v <= 1.1) {
    const x = n.sub(PgNumeric.ONE);
    if (x.mag === 0n) {
      return 0;
    }
    const { weight, d0 } = varDigits(x.abs());
    return weight * 4 + Math.trunc(Math.log10(d0));
  }
  const { weight, d0, d1, ndigits } = varDigits(n);
  let digits = d0;
  let dweight = weight * 4;
  if (ndigits > 1) {
    digits = digits * 10000 + d1;
    dweight -= 4;
  }
  const lnVar = Math.log(digits) + dweight * 2.302585092994046;
  return Math.trunc(Math.log10(Math.abs(lnVar)));
}

/** ln(x) for x > 0, fixed point at scale w (x and result both at scale w) */
function lnFixed(x: bigint, w: number): bigint {
  const one = pow10(w);
  const hundredth = one / 100n;
  let y = x;
  let m = 0;
  while (y - one > hundredth || one - y > hundredth) {
    y = isqrt(y * one);
    m++;
  }
  // ln(y) = 2 atanh((y - 1) / (y + 1))
  const z = ((y - one) * one) / (y + one);
  const z2 = (z * z) / one;
  let sum = z;
  let zpow = z;
  for (let i = 3n; ; i += 2n) {
    zpow = (zpow * z2) / one;
    const term = zpow / i;
    if (term === 0n) {
      break;
    }
    sum += term;
  }
  return (sum * 2n) << BigInt(m);
}

/** exp(x), fixed point at scale w */
function expFixed(x: bigint, w: number): bigint {
  const one = pow10(w);
  const hundredth = one / 100n;
  let r = x;
  let m = 0;
  while (r > hundredth || -r > hundredth) {
    r /= 2n;
    m++;
  }
  let sum = one;
  let term = one;
  for (let i = 1n; ; i++) {
    term = (term * r) / (one * i);
    if (term === 0n) {
      break;
    }
    sum += term;
  }
  for (let i = 0; i < m; i++) {
    sum = (sum * sum) / one;
  }
  return sum;
}

const special = (n: PgNumeric): boolean => n.kind !== 'n';

/** sqrt_var at a given result scale (n >= 0) */
export function sqrtAtScale(n: PgNumeric, rscale: number): PgNumeric {
  const w = rscale + 2;
  return fromFixed(isqrt(toFixed(n, 2 * w)), w, rscale);
}

/**
 * numeric_stddev_internal: from the exact N, sum(x) and sum(x*x); the variance at select_div_scale, the
 * standard deviation its square root at that same scale.
 */
export function numericStddev(n: number, sumX: PgNumeric, sumX2: PgNumeric, variance: boolean, sample: boolean): PgNumeric | null {
  if (n === 0 || (sample && n === 1)) {
    return null;
  }
  const vN = PgNumeric.fromInt(n);
  const numerator = vN.mul(sumX2).sub(sumX.mul(sumX));
  if (numerator.signum() <= 0) {
    return PgNumeric.ZERO;
  }
  const denominator = sample ? vN.mul(PgNumeric.fromInt(n - 1)) : vN.mul(vN);
  const rscale = PgNumeric.selectDivScale(numerator, denominator);
  const v = PgNumeric.divScaled(numerator, denominator, rscale, true);
  return variance ? v : sqrtAtScale(v, rscale);
}

export function numericSqrt(n: PgNumeric): PgNumeric {
  if (n.kind === 'nan' || n.kind === '+inf') {
    return n;
  }
  if (n.kind === '-inf' || n.neg) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'cannot take square root of a negative number');
  }
  const { weight } = varDigits(n);
  const sweight = ((weight + 1) * 4) / 2 - 1;
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - sweight, n.scale);
  const w = rscale + 2;
  return fromFixed(isqrt(toFixed(n, 2 * w)), w, rscale);
}

export function numericExp(n: PgNumeric): PgNumeric {
  if (n.kind === 'nan' || n.kind === '+inf') {
    return n;
  }
  if (n.kind === '-inf') {
    return PgNumeric.ZERO;
  }
  let val = n.toNumber() * 0.434294481903252;
  val = Math.min(Math.max(val, -NUMERIC_MAX_RESULT_SCALE), NUMERIC_MAX_RESULT_SCALE);
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - Math.trunc(val), n.scale);
  return expAtScale(n, rscale);
}

function expAtScale(n: PgNumeric, rscale: number): PgNumeric {
  // exp_var's overflow / underflow guard
  const v = n.toNumber();
  if (Math.abs(v) >= NUMERIC_MAX_RESULT_SCALE * 3) {
    if (v > 0) {
      throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value overflows numeric format');
    }
    return PgNumeric.make(false, 0n, rscale);
  }
  const magnitude = Math.max(0, Math.ceil(n.toNumber() * 0.4343));
  const w = rscale + magnitude + GUARD;
  return fromFixed(expFixed(toFixed(n, w), w), w, rscale);
}

function checkLogArg(n: PgNumeric): void {
  if (n.kind === 'n' && n.mag === 0n) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of zero');
  }
  if (n.neg) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_LOG, 'cannot take logarithm of a negative number');
  }
}

/** ln(n) at `rscale` digits */
function lnAtScale(n: PgNumeric, rscale: number): PgNumeric {
  const { weight } = varDigits(n);
  // enough fractional digits for the reduction of a very small or very large argument
  const w = rscale + GUARD + Math.max(0, -weight * 4);
  return fromFixed(lnFixed(toFixed(n, w), w), w, rscale);
}

export function numericLn(n: PgNumeric): PgNumeric {
  if (n.kind === 'nan') {
    return n;
  }
  checkLogArg(n);
  if (n.kind === '+inf') {
    return n;
  }
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - estimateLnDweight(n), n.scale);
  return lnAtScale(n, rscale);
}

/** log(base, num): log_var */
export function numericLog(base: PgNumeric, num: PgNumeric): PgNumeric {
  if (base.kind === 'nan' || num.kind === 'nan') {
    return PgNumeric.NAN;
  }
  checkLogArg(base);
  checkLogArg(num);
  if (special(base) || special(num)) {
    if (base.kind === '+inf') {
      return num.kind === '+inf' ? PgNumeric.NAN : PgNumeric.ZERO;
    }
    return base.compare(PgNumeric.ONE) === 0 ? divisionByZero() : PgNumeric.PINF;
  }
  const lnBaseDweight = estimateLnDweight(base);
  const lnNumDweight = estimateLnDweight(num);
  const resultDweight = lnNumDweight - lnBaseDweight;
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - resultDweight, base.scale, num.scale);
  const w = rscale + Math.max(0, resultDweight) + GUARD + Math.max(0, -varDigits(base).weight * 4, -varDigits(num).weight * 4);
  const lnBase = lnFixed(toFixed(base, w), w);
  if (lnBase === 0n) {
    return divisionByZero();
  }
  const lnNum = lnFixed(toFixed(num, w), w);
  // lnNum / lnBase at scale w
  return fromFixed((lnNum * pow10(w)) / lnBase, w, rscale);
}

function divisionByZero(): never {
  throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
}

/** numeric_power for finite arguments (power_var / power_var_int) */
export function numericPowerFinite(base: PgNumeric, exp: PgNumeric): PgNumeric {
  if (base.mag === 0n && exp.neg) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'zero raised to a negative power is undefined');
  }
  const expTrim = exp.trimScale();
  if (expTrim.scale === 0 && expTrim.mag <= 2147483647n) {
    return powerInt(base, Number(expTrim.mag) * (expTrim.neg ? -1 : 1), exp.scale);
  }
  if (base.neg) {
    throw new PgError(SqlState.INVALID_ARGUMENT_FOR_POWER_FUNCTION, 'a negative number raised to a non-integer power yields a complex result');
  }
  if (base.mag === 0n) {
    return PgNumeric.make(false, 0n, NUMERIC_MIN_SIG_DIGITS);
  }
  const val = exp.toNumber() * Math.log(base.toNumber()) * 0.434294481903252;
  if (Math.abs(val) > NUMERIC_MAX_RESULT_SCALE * 3.01 * 0.434294481903252) {
    if (val < 0) {
      return PgNumeric.make(false, 0n, NUMERIC_MAX_DISPLAY_SCALE);
    }
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value overflows numeric format');
  }
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - Math.trunc(val), base.scale, exp.scale);
  const magnitude = Math.max(0, Math.ceil(val));
  const w = rscale + magnitude + GUARD + Math.max(0, -varDigits(base).weight * 4);
  const lnBase = lnFixed(toFixed(base, w), w);
  const expFixedArg = (lnBase * toFixed(exp, w)) / pow10(w);
  return fromFixed(expFixed(expFixedArg, w), w, rscale);
}

/** power_var_int: exact integer power rounded at the selected scale */
function powerInt(base: PgNumeric, exp: number, expDscale: number): PgNumeric {
  let f = 0;
  if (base.mag !== 0n) {
    // base ~= f * 10^p from its leading (up to 16) decimal digits
    const s = base.mag.toString();
    const lead = s.slice(0, Math.min(s.length, 16));
    const fv = parseInt(lead, 10);
    const p = s.length - lead.length - base.scale;
    f = exp * (Math.log10(fv) + p);
  }
  if (f > 131072 * 4) {
    throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'value overflows numeric format');
  }
  if (f + 1 < -NUMERIC_MAX_DISPLAY_SCALE) {
    return PgNumeric.make(false, 0n, NUMERIC_MAX_DISPLAY_SCALE);
  }
  const rscale = clampScale(NUMERIC_MIN_SIG_DIGITS - Math.trunc(f), base.scale, expDscale);
  if (exp === 0) {
    return PgNumeric.make(false, pow10(rscale), rscale);
  }
  if (base.mag === 0n) {
    if (exp < 0) {
      divisionByZero();
    }
    return PgNumeric.make(false, 0n, rscale);
  }
  const e = BigInt(Math.abs(exp));
  // exact |base|^e as mag / 10^(scale*e)
  const mag = base.mag ** e;
  const scale = base.scale * Math.abs(exp);
  const neg = base.neg && e % 2n === 1n;
  if (exp > 0) {
    return fromFixed(neg ? -mag : mag, scale, rscale);
  }
  // 1 / (mag / 10^scale) = 10^scale / mag, at scale rscale (rounded)
  const num = pow10(scale + rscale + 1);
  let q = num / mag;
  const last = q % 10n;
  q /= 10n;
  if (last >= 5n) {
    q += 1n;
  }
  return PgNumeric.make(neg, q, rscale);
}
