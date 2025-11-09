/**
 * Database column wrapper that provides type-safe query operations
 * while automatically unwrapping to the underlying type in results
 *
 * DbColumn implements the FieldRef interface so it can be used in conditions
 */
export class DbColumn<TValue> {
  /** @internal */
  readonly __isDbColumn = true;

  /** @internal */
  readonly __fieldName: string;

  /** @internal */
  readonly __dbColumnName: string;

  /** @internal */
  readonly __valueType!: TValue;

  constructor(
    /** @internal */
    columnName: string
  ) {
    this.__fieldName = columnName;
    this.__dbColumnName = columnName;
  }

  /**
   * This is a compile-time only type - at runtime this is never called
   * The actual value is returned by the query execution
   */
  valueOf(): TValue {
    throw new Error('DbColumn.valueOf() should never be called at runtime');
  }
}

/**
 * Type helper to unwrap DbColumn types to their underlying values
 */
export type UnwrapDbColumns<T> = T extends DbColumn<infer V>
  ? V
  : T extends object
  ? {
      [K in keyof T]: T[K] extends DbColumn<infer V>
        ? V
        : T[K] extends (infer U)[] | undefined
        ? U extends DbEntity
          ? UnwrapDbColumns<U>[]
          : T[K]
        : T[K] extends DbEntity | undefined
        ? UnwrapDbColumns<NonNullable<T[K]>>
        : T[K];
    }
  : T;

/**
 * Helper to check if a type includes DbColumn
 */
type IncludesDbColumn<T> =
  T extends DbColumn<any> ? true :
  T extends DbColumn<any> | undefined ? true :
  T extends undefined | DbColumn<any> ? true :
  false;

/**
 * Helper to unwrap DbColumn from potentially optional type
 */
type UnwrapOptionalDbColumn<T> =
  T extends DbColumn<infer V> | undefined ? V :
  T extends DbColumn<infer V> ? V :
  never;

/**
 * Type helper to extract only DbColumn properties from an entity
 * This is used for insert/update operations where only actual columns are needed,
 * excluding navigation properties
 */
export type ExtractDbColumns<T> = {
  [K in keyof T as IncludesDbColumn<T[K]> extends true ? K : never]: UnwrapOptionalDbColumn<T[K]>;
};

/**
 * Type for insert data - only includes DbColumn properties, unwrapped to their values
 */
export type InsertData<TEntity> = Partial<ExtractDbColumns<TEntity>>;

/**
 * Marker to indicate DbEntity type (imported to avoid circular dependency)
 */
interface DbEntity {
  // This is just a marker for the type system
}

/**
 * Check if a value is a DbColumn
 */
export function isDbColumn(value: any): value is DbColumn<any> {
  return value && typeof value === 'object' && value.__isDbColumn === true;
}
