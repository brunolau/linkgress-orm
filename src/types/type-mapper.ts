/**
 * Custom type mapper for bidirectional data transformation
 */
export interface TypeMapper<TData = any, TDriver = any> {
  /**
   * Convert from application data type to database driver type
   */
  toDriver(value: TData | null | undefined): TDriver | null;

  /**
   * Convert from database driver type to application data type
   */
  fromDriver(value: TDriver | null | undefined): TData | null;

  /**
   * Optional: Get the PostgreSQL data type for schema generation
   */
  dataType?: () => string;

  /**
   * The values `fromDriver` returns are never mutated — Temporal values, primitives, frozen objects — so rows
   * with the same driver value may share one. linkgress then calls `fromDriver` once per distinct driver value
   * of a column within ONE result set and hands every row with that driver value the SAME mapped value (see
   * {@link CustomTypeDefinition.immutable}). Unset or `false`: `fromDriver` runs for every value, as it always did.
   */
  readonly immutable?: boolean;
}

/**
 * Custom type definition with mapper
 */
export interface CustomTypeDefinition<TData = any, TDriver = any> {
  dataType: () => string;
  toDriver: (value: TData | null | undefined) => TDriver | null;
  fromDriver: (value: TDriver | null | undefined) => TData | null;

  /**
   * `true` declares that the values `fromDriver` returns are never mutated — Temporal values, primitives, frozen
   * objects — so rows with the same driver value may share one. linkgress then calls `fromDriver` once per distinct
   * driver value within one result set and gives every row with that driver value the same mapped value: an
   * expensive `fromDriver` (a Temporal parse, a date library) runs once per distinct value instead of once per row.
   *
   * What is shared: within ONE result set — one query execution, one QueryBatch branch, one collection's items —
   * and within one column (each value a projection reads through the type is a column of its own), the values a
   * driver delivers as a string, a number, a bigint or a boolean. Never across queries, statements, batch
   * branches or executions of one future or prepared query. NULL / undefined and a driver value of any other
   * kind (a Date, a Buffer, an array, an object) go through `fromDriver` every time, as without the flag; so does
   * -0 (a key equal to 0, a value that is not). Under a driver's DEFAULT parsing a `timestamp` / `timestamptz` /
   * `date` column arrives as a `Date` — an object, never shared: a type over one shares its values only on a
   * client that hands it the value's text (a text pass-through parser, see the second example).
   *
   * Bounded: at most 1,024 distinct values per column and result set. A column whose first distinct values bring
   * no repeat stops sharing: after 128 of them, or — for a result set of N values — N / 2 (at most 1,024), so a
   * column whose values repeat only more than 128 rows apart (a calendar read entity by entity) still shares once
   * each value repeats; an all-distinct column costs that many lookups, then nothing. A column that fills the
   * 1,024 with fewer repeats than distinct values stops too; one with at least as many keeps what it holds. A
   * result set of fewer than two values reads through the type itself. A `fromDriver` that throws fails the read
   * as it always did.
   *
   * Sharing makes equal values IDENTICAL: code that mutates a mapped value, or that tells two values apart by
   * identity (`===`, a `Set` or `Map` keyed by them, a `WeakMap`), sees every row with that driver value at once.
   * Declare it only for values nothing mutates. Default `false`.
   *
   * @example
   * // With every driver's defaults: an integer column of days since 1970-01-01, read into a Temporal.PlainDate
   * const EPOCH = Temporal.PlainDate.from('1970-01-01');
   * const epochDay = createCustomType<{ data: Temporal.PlainDate; driverData: number }>({
   *   dataType: () => 'integer',
   *   toDriver: (value) => (value == null ? null : EPOCH.until(value).days),
   *   fromDriver: (value) => (value == null ? null : EPOCH.add({ days: value })),
   *   immutable: true,
   * });
   *
   * @example
   * // A timestamp column read from its TEXT ('2026-09-28 10:00:00'): only on a client with a text pass-through
   * // parser for timestamp (node-postgres `pg.types.setTypeParser(1114, v => v)` or a pool's `types`, postgres.js
   * // `types`, PGlite `parsers`); under a driver's default parsing the value is a Date, which is never shared
   * const plainDateTime = createCustomType<{ data: Temporal.PlainDateTime; driverData: string }>({
   *   dataType: () => 'timestamp',
   *   toDriver: (value) => (value == null ? null : value.toString().replace('T', ' ')),
   *   fromDriver: (value) => (value == null ? null : Temporal.PlainDateTime.from(value.replace(' ', 'T'))),
   *   immutable: true,
   * });
   */
  immutable?: boolean;
}

/**
 * Create a custom type mapper
 */
export function customType<T extends { data: any; driverData?: any }>(
  config: CustomTypeDefinition<T['data'], T['driverData'] extends never ? T['data'] : T['driverData']>
): TypeMapper<T['data'], T['driverData'] extends never ? T['data'] : T['driverData']> {
  // A mapper without the flag keeps the shape it always had
  return config.immutable === true
    ? {
      dataType: config.dataType,
      toDriver: config.toDriver,
      fromDriver: config.fromDriver,
      immutable: true,
    }
    : {
      dataType: config.dataType,
      toDriver: config.toDriver,
      fromDriver: config.fromDriver,
    };
}

/**
 * Identity mapper (no transformation)
 */
export const identityMapper: TypeMapper = {
  toDriver: (value) => value,
  fromDriver: (value) => value,
};

/**
 * Apply a mapper to a value (toDriver direction)
 */
export function applyToDriver<TData, TDriver>(
  mapper: TypeMapper<TData, TDriver> | undefined,
  value: TData | null | undefined
): TDriver | null {
  if (!mapper) return value as any;
  return mapper.toDriver(value);
}

/**
 * Apply a mapper to a value (fromDriver direction)
 */
export function applyFromDriver<TData, TDriver>(
  mapper: TypeMapper<TData, TDriver> | undefined,
  value: TDriver | null | undefined
): TData | null {
  if (!mapper) return value as any;
  return mapper.fromDriver(value);
}

/**
 * Apply mapper to array of values
 */
export function applyFromDriverArray<TData, TDriver>(
  mapper: TypeMapper<TData, TDriver> | undefined,
  values: (TDriver | null)[]
): (TData | null)[] {
  if (!mapper) return values as any[];
  return values.map(v => mapper.fromDriver(v));
}
