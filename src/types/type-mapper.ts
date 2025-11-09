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
}

/**
 * Custom type definition with mapper
 */
export interface CustomTypeDefinition<TData = any, TDriver = any> {
  dataType: () => string;
  toDriver: (value: TData | null | undefined) => TDriver | null;
  fromDriver: (value: TDriver | null | undefined) => TData | null;
}

/**
 * Create a custom type mapper
 */
export function customType<T extends { data: any; driverData?: any }>(
  config: CustomTypeDefinition<T['data'], T['driverData'] extends never ? T['data'] : T['driverData']>
): TypeMapper<T['data'], T['driverData'] extends never ? T['data'] : T['driverData']> {
  return {
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
