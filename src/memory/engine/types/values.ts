/**
 * Runtime value classes shared by the engine.
 */

/** A composite / record value. */
export class PgRecord {
  constructor(
    public values: unknown[],
    /** composite type oid, or 2249 (record) for anonymous rows */
    public typeOid: number,
    /** field type oids (required for anonymous records) */
    public fieldTypes: number[],
    public fieldNames: string[],
    public fieldTypmods?: number[]
  ) {}
}

/** Bit string value ("0101"). */
export class PgBits {
  constructor(public bits: string) {}
}

export function isRecord(v: unknown): v is PgRecord {
  return v instanceof PgRecord;
}

/** Multi-dimensional arrays are nested JS arrays; lower bounds other than 1 are kept here. */
export interface ArrayMeta {
  lowerBounds?: number[];
}

export const ARRAY_LBOUND = Symbol('pg.array.lbound');

export function arrayLowerBound(arr: unknown[]): number {
  const lb = (arr as unknown as Record<symbol, number>)[ARRAY_LBOUND];
  return lb === undefined ? 1 : lb;
}

export function withLowerBound<T>(arr: T[], lb: number): T[] {
  if (lb !== 1) {
    Object.defineProperty(arr, ARRAY_LBOUND, { value: lb, enumerable: false, configurable: true, writable: true });
  }
  return arr;
}
