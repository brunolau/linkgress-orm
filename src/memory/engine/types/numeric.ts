import { PgError, SqlState } from '../errors';

/**
 * Arbitrary precision decimal with PostgreSQL `numeric` semantics (display scale rules,
 * rounding half away from zero, NaN / ±Infinity).
 *
 * value = sign * mag / 10^scale
 */
export class PgNumeric {
  /** 'n' normal, 'nan', '+inf', '-inf' */
  readonly kind: 'n' | 'nan' | '+inf' | '-inf';
  readonly neg: boolean;
  readonly mag: bigint;
  readonly scale: number;

  private constructor(kind: 'n' | 'nan' | '+inf' | '-inf', neg: boolean, mag: bigint, scale: number) {
    this.kind = kind;
    this.neg = mag === 0n ? false : neg;
    this.mag = mag;
    this.scale = scale;
  }

  static readonly NAN = new PgNumeric('nan', false, 0n, 0);
  static readonly PINF = new PgNumeric('+inf', false, 0n, 0);
  static readonly NINF = new PgNumeric('-inf', true, 0n, 0);
  static readonly ZERO = new PgNumeric('n', false, 0n, 0);
  static readonly ONE = new PgNumeric('n', false, 1n, 0);

  static make(neg: boolean, mag: bigint, scale: number): PgNumeric {
    return new PgNumeric('n', neg, mag, scale);
  }

  static fromBigInt(v: bigint): PgNumeric {
    return v < 0n ? new PgNumeric('n', true, -v, 0) : new PgNumeric('n', false, v, 0);
  }

  static fromInt(v: number): PgNumeric {
    return PgNumeric.fromBigInt(BigInt(v));
  }

  /** numeric_in */
  static parse(input: string, typeName = 'numeric'): PgNumeric {
    const s = input.trim();
    const lower = s.toLowerCase();
    if (lower === 'nan') {
      return PgNumeric.NAN;
    }
    if (lower === 'infinity' || lower === '+infinity' || lower === 'inf' || lower === '+inf') {
      return PgNumeric.PINF;
    }
    if (lower === '-infinity' || lower === '-inf') {
      return PgNumeric.NINF;
    }
    const m = /^([+-])?(?:(\d(?:_?\d)*)(?:\.(\d(?:_?\d)*)?)?|\.(\d(?:_?\d)*))(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) {
      const hm = /^([+-])?0([xXoObB])([0-9a-fA-F_]+)$/.exec(s);
      if (hm) {
        const radix = hm[2].toLowerCase() === 'x' ? '0x' : hm[2].toLowerCase() === 'o' ? '0o' : '0b';
        try {
          const v = BigInt(radix + hm[3].replace(/_/g, ''));
          return new PgNumeric('n', hm[1] === '-', v, 0);
        } catch {
          // fallthrough
        }
      }
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeName}: "${input}"`);
    }
    const neg = m[1] === '-';
    const intPart = (m[2] ?? '').replace(/_/g, '');
    const fracPart = (m[3] ?? m[4] ?? '').replace(/_/g, '');
    const exp = m[5] ? parseInt(m[5], 10) : 0;
    if (Math.abs(exp) > 1000) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `invalid input syntax for type ${typeName}: "${input}"`);
    }
    let digits = intPart + fracPart;
    let scale = fracPart.length - exp;
    if (digits === '') {
      digits = '0';
    }
    let mag = BigInt(digits);
    if (scale < 0) {
      mag = mag * 10n ** BigInt(-scale);
      scale = 0;
    }
    return new PgNumeric('n', neg, mag, scale);
  }

  static fromNumber(v: number): PgNumeric {
    if (Number.isNaN(v)) {
      return PgNumeric.NAN;
    }
    if (v === Infinity) {
      return PgNumeric.PINF;
    }
    if (v === -Infinity) {
      return PgNumeric.NINF;
    }
    if (Number.isInteger(v) && Math.abs(v) < 1e21) {
      return PgNumeric.fromBigInt(BigInt(v));
    }
    return PgNumeric.parse(formatFloat8ForNumeric(v));
  }

  isNaN(): boolean {
    return this.kind === 'nan';
  }

  isInf(): boolean {
    return this.kind === '+inf' || this.kind === '-inf';
  }

  isZero(): boolean {
    return this.kind === 'n' && this.mag === 0n;
  }

  signum(): number {
    if (this.kind === 'nan') {
      return NaN;
    }
    if (this.kind === '+inf') {
      return 1;
    }
    if (this.kind === '-inf') {
      return -1;
    }
    return this.mag === 0n ? 0 : this.neg ? -1 : 1;
  }

  /** numeric_out */
  toString(): string {
    switch (this.kind) {
      case 'nan':
        return 'NaN';
      case '+inf':
        return 'Infinity';
      case '-inf':
        return '-Infinity';
    }
    let s = this.mag.toString();
    if (this.scale > 0) {
      if (s.length <= this.scale) {
        s = '0'.repeat(this.scale - s.length + 1) + s;
      }
      s = s.slice(0, s.length - this.scale) + '.' + s.slice(s.length - this.scale);
    }
    return this.neg ? '-' + s : s;
  }

  toNumber(): number {
    switch (this.kind) {
      case 'nan':
        return NaN;
      case '+inf':
        return Infinity;
      case '-inf':
        return -Infinity;
    }
    return parseFloat(this.toString());
  }

  /** Value with trailing fractional zeros removed (canonical key for hashing/equality). */
  canonicalKey(): string {
    if (this.kind !== 'n') {
      return this.kind;
    }
    let mag = this.mag;
    let scale = this.scale;
    while (scale > 0 && mag % 10n === 0n) {
      mag /= 10n;
      scale--;
    }
    return (this.neg ? '-' : '') + mag.toString() + 'e' + scale;
  }

  private rescaled(targetScale: number): bigint {
    if (targetScale === this.scale) {
      return this.neg ? -this.mag : this.mag;
    }
    const v = this.mag * 10n ** BigInt(targetScale - this.scale);
    return this.neg ? -v : v;
  }

  static fromSigned(v: bigint, scale: number): PgNumeric {
    return v < 0n ? new PgNumeric('n', true, -v, scale) : new PgNumeric('n', false, v, scale);
  }

  compare(other: PgNumeric): number {
    // NaN sorts above everything and equals itself
    if (this.kind === 'nan') {
      return other.kind === 'nan' ? 0 : 1;
    }
    if (other.kind === 'nan') {
      return -1;
    }
    if (this.kind === '+inf') {
      return other.kind === '+inf' ? 0 : 1;
    }
    if (this.kind === '-inf') {
      return other.kind === '-inf' ? 0 : -1;
    }
    if (other.kind === '+inf') {
      return -1;
    }
    if (other.kind === '-inf') {
      return 1;
    }
    const s = Math.max(this.scale, other.scale);
    const a = this.rescaled(s);
    const b = other.rescaled(s);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  add(other: PgNumeric): PgNumeric {
    if (this.kind !== 'n' || other.kind !== 'n') {
      return specialAdd(this, other, false);
    }
    const s = Math.max(this.scale, other.scale);
    return PgNumeric.fromSigned(this.rescaled(s) + other.rescaled(s), s);
  }

  sub(other: PgNumeric): PgNumeric {
    if (this.kind !== 'n' || other.kind !== 'n') {
      return specialAdd(this, other, true);
    }
    const s = Math.max(this.scale, other.scale);
    return PgNumeric.fromSigned(this.rescaled(s) - other.rescaled(s), s);
  }

  mul(other: PgNumeric): PgNumeric {
    if (this.kind !== 'n' || other.kind !== 'n') {
      if (this.kind === 'nan' || other.kind === 'nan') {
        return PgNumeric.NAN;
      }
      const sa = this.signum();
      const sb = other.signum();
      if (sa === 0 || sb === 0) {
        return PgNumeric.NAN;
      }
      return sa * sb > 0 ? PgNumeric.PINF : PgNumeric.NINF;
    }
    // PostgreSQL: result dscale = dscale1 + dscale2, capped at NUMERIC_MAX_DISPLAY_SCALE
    let rscale = this.scale + other.scale;
    let v = (this.neg !== other.neg ? -1n : 1n) * this.mag * other.mag;
    if (rscale > 1000) {
      v = roundScaled(v, rscale, 1000);
      rscale = 1000;
    }
    return PgNumeric.fromSigned(v, rscale);
  }

  neg_(): PgNumeric {
    if (this.kind === '+inf') {
      return PgNumeric.NINF;
    }
    if (this.kind === '-inf') {
      return PgNumeric.PINF;
    }
    if (this.kind === 'nan') {
      return this;
    }
    return new PgNumeric('n', !this.neg, this.mag, this.scale);
  }

  abs(): PgNumeric {
    if (this.kind === '-inf') {
      return PgNumeric.PINF;
    }
    if (this.kind !== 'n') {
      return this;
    }
    return new PgNumeric('n', false, this.mag, this.scale);
  }

  /**
   * select_div_scale(): the default result scale of a division.
   */
  static selectDivScale(a: PgNumeric, b: PgNumeric): number {
    const [w1, f1] = a.weightAndFirstDigit();
    const [w2, f2] = b.weightAndFirstDigit();
    let qweight = w1 - w2;
    if (f1 <= f2) {
      qweight--;
    }
    let rscale = 16 - qweight * 4;
    rscale = Math.max(rscale, a.scale);
    rscale = Math.max(rscale, b.scale);
    rscale = Math.max(rscale, 0);
    rscale = Math.min(rscale, 1000);
    return rscale;
  }

  /** Base-10000 weight and first (non-zero) base-10000 digit, as in numeric.c. Zero -> [0, 0]. */
  weightAndFirstDigit(): [number, number] {
    if (this.kind !== 'n' || this.mag === 0n) {
      return [0, 0];
    }
    const s = this.mag.toString();
    // decimal exponent of the most significant digit
    const p = s.length - 1 - this.scale;
    const weight = Math.floor(p / 4);
    // first base-10000 digit = floor(|v| / 10000^weight) mod 10000
    // digits of |v| aligned: position of the group containing p
    const groupLow = weight * 4; // decimal exponent of the group's lowest digit
    const digitsInGroup = p - groupLow + 1; // 1..4
    const first = parseInt(s.slice(0, digitsInGroup), 10);
    return [weight, first];
  }

  /** numeric division with PostgreSQL's default scale, rounding half away from zero. */
  div(other: PgNumeric): PgNumeric {
    if (this.kind !== 'n' || other.kind !== 'n') {
      return specialDiv(this, other);
    }
    if (other.mag === 0n) {
      throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
    }
    const rscale = PgNumeric.selectDivScale(this, other);
    return PgNumeric.divScaled(this, other, rscale, true);
  }

  /** a / b at exactly `rscale` fractional digits, rounded (round=true) or truncated. */
  static divScaled(a: PgNumeric, b: PgNumeric, rscale: number, round: boolean): PgNumeric {
    if (b.mag === 0n) {
      throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
    }
    // (a.mag / 10^a.scale) / (b.mag / 10^b.scale) = a.mag * 10^b.scale / (b.mag * 10^a.scale)
    // we want q * 10^-rscale, so q = a.mag * 10^(b.scale + rscale) / (b.mag * 10^a.scale)
    let num = a.mag * 10n ** BigInt(b.scale + rscale + (round ? 1 : 0));
    let den = b.mag * 10n ** BigInt(a.scale);
    let q = num / den;
    if (round) {
      // q has one extra digit
      const last = q % 10n;
      q = q / 10n;
      if (last >= 5n) {
        q += 1n;
      }
    }
    void num;
    void den;
    const neg = a.neg !== b.neg;
    return new PgNumeric('n', neg, q, rscale);
  }

  /** numeric_mod: truncated division remainder with dscale = max(dscales). */
  mod(other: PgNumeric): PgNumeric {
    if (this.kind !== 'n' || other.kind !== 'n') {
      if (this.kind === 'nan' || other.kind === 'nan') {
        return PgNumeric.NAN;
      }
      if (this.isInf()) {
        if (other.isZero()) {
          throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
        }
        return PgNumeric.NAN;
      }
      return this;
    }
    if (other.mag === 0n) {
      throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
    }
    const s = Math.max(this.scale, other.scale);
    const a = this.rescaled(s);
    const b = other.rescaled(s);
    return PgNumeric.fromSigned(a % b, s);
  }

  /** round(numeric, int) */
  round(scale: number): PgNumeric {
    if (this.kind !== 'n') {
      return this;
    }
    if (scale >= this.scale) {
      return new PgNumeric('n', this.neg, this.mag * 10n ** BigInt(Math.max(0, scale) - this.scale), Math.max(0, scale));
    }
    const v = roundScaled(this.rescaled(this.scale), this.scale, scale);
    if (scale < 0) {
      return PgNumeric.fromSigned(v * 10n ** BigInt(-scale), 0);
    }
    return PgNumeric.fromSigned(v, scale);
  }

  /** trunc(numeric, int) */
  trunc(scale: number): PgNumeric {
    if (this.kind !== 'n') {
      return this;
    }
    if (scale >= this.scale) {
      return new PgNumeric('n', this.neg, this.mag * 10n ** BigInt(Math.max(0, scale) - this.scale), Math.max(0, scale));
    }
    const drop = 10n ** BigInt(this.scale - scale);
    let v = this.mag / drop;
    if (scale < 0) {
      v = v * 10n ** BigInt(-scale);
      return new PgNumeric('n', this.neg, v, 0);
    }
    return new PgNumeric('n', this.neg, v, scale);
  }

  ceil(): PgNumeric {
    if (this.kind !== 'n') {
      return this;
    }
    const t = this.trunc(0);
    if (!this.neg && t.compare(this) !== 0) {
      return new PgNumeric('n', false, t.mag + 1n, 0);
    }
    return t;
  }

  floor(): PgNumeric {
    if (this.kind !== 'n') {
      return this;
    }
    const t = this.trunc(0);
    if (this.neg && t.compare(this) !== 0) {
      return new PgNumeric('n', true, t.mag + 1n, 0);
    }
    return t;
  }

  /** Round to int (half away from zero) and return as bigint; used by numeric -> int casts. */
  toBigIntRounded(): bigint {
    const r = this.round(0);
    return r.neg ? -r.mag : r.mag;
  }

  /** numeric(p, s) typmod enforcement (apply_typmod). */
  applyTypmod(typmod: number): PgNumeric {
    if (typmod < 4) {
      return this;
    }
    const tm = typmod - 4;
    const precision = (tm >> 16) & 0xffff;
    // scale is a signed 11-bit value in PG15+
    let scale = tm & 0x7ff;
    if (scale & 0x400) {
      scale = scale - 0x800;
    }
    if (this.kind !== 'n') {
      if (this.isInf()) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'numeric field overflow', {
          detail: `A field with precision ${precision}, scale ${scale} cannot hold an infinite value.`,
        });
      }
      return this;
    }
    const r = this.round(scale);
    // digits before decimal point
    const maxDigits = precision - scale;
    if (r.mag !== 0n) {
      const s = r.mag.toString();
      const intDigits = s.length - r.scale;
      if (intDigits > maxDigits) {
        throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'numeric field overflow', {
          detail:
            maxDigits <= 0
              ? `A field with precision ${precision}, scale ${scale} must round to an absolute value less than 1.`
              : `A field with precision ${precision}, scale ${scale} must round to an absolute value less than 10^${maxDigits}.`,
        });
      }
    }
    if (scale < 0) {
      return new PgNumeric('n', r.neg, r.mag, 0);
    }
    return r;
  }

  /** Strip trailing zeros (trim_scale). */
  trimScale(): PgNumeric {
    if (this.kind !== 'n') {
      return this;
    }
    let mag = this.mag;
    let scale = this.scale;
    while (scale > 0 && mag % 10n === 0n) {
      mag /= 10n;
      scale--;
    }
    return new PgNumeric('n', this.neg, mag, scale);
  }

  /** Number of significant fractional digits (scale()) */
  minScale(): number {
    return this.trimScale().scale;
  }
}

function roundScaled(v: bigint, fromScale: number, toScale: number): bigint {
  if (toScale >= fromScale) {
    return v * 10n ** BigInt(toScale - fromScale);
  }
  const neg = v < 0n;
  let a = neg ? -v : v;
  const drop = 10n ** BigInt(fromScale - toScale);
  const q = a / drop;
  const r = a % drop;
  a = q;
  if (r * 2n >= drop) {
    a += 1n;
  }
  return neg ? -a : a;
}

function specialAdd(a: PgNumeric, b: PgNumeric, subtract: boolean): PgNumeric {
  if (a.kind === 'nan' || b.kind === 'nan') {
    return PgNumeric.NAN;
  }
  const bk = subtract ? (b.kind === '+inf' ? '-inf' : b.kind === '-inf' ? '+inf' : b.kind) : b.kind;
  if (a.kind === '+inf') {
    return bk === '-inf' ? PgNumeric.NAN : PgNumeric.PINF;
  }
  if (a.kind === '-inf') {
    return bk === '+inf' ? PgNumeric.NAN : PgNumeric.NINF;
  }
  return bk === '+inf' ? PgNumeric.PINF : PgNumeric.NINF;
}

function specialDiv(a: PgNumeric, b: PgNumeric): PgNumeric {
  if (a.kind === 'nan' || b.kind === 'nan') {
    return PgNumeric.NAN;
  }
  if (a.isInf()) {
    if (b.isInf()) {
      return PgNumeric.NAN;
    }
    if (b.isZero()) {
      throw new PgError(SqlState.DIVISION_BY_ZERO, 'division by zero');
    }
    return a.signum() * b.signum() > 0 ? PgNumeric.PINF : PgNumeric.NINF;
  }
  // finite / inf = 0
  return PgNumeric.ZERO;
}

/**
 * float8 -> numeric conversion text: PostgreSQL uses DBL_DIG (15) significant digits (%.*g).
 */
export function formatFloat8ForNumeric(v: number): string {
  const s = v.toPrecision(15);
  // strip trailing zeros in the mantissa
  if (s.includes('e')) {
    const [mant, exp] = s.split('e');
    let m = mant;
    if (m.includes('.')) {
      m = m.replace(/0+$/, '').replace(/\.$/, '');
    }
    return m + 'e' + exp;
  }
  if (s.includes('.')) {
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

/** float4 -> numeric uses FLT_DIG (6) significant digits. */
export function formatFloat4ForNumeric(v: number): string {
  const s = v.toPrecision(6);
  if (s.includes('e')) {
    const [mant, exp] = s.split('e');
    let m = mant;
    if (m.includes('.')) {
      m = m.replace(/0+$/, '').replace(/\.$/, '');
    }
    return m + 'e' + exp;
  }
  if (s.includes('.')) {
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}
