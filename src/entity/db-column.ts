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
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. See conditions.ts for detailed explanation.
 * Excludes DbColumn and SqlFragment which have valueOf but are not value types.
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Exclude DbColumn
  : T extends { mapWith: any; as: any; buildSql: any }  // SqlFragment-like
  ? false  // Exclude SqlFragment
  : T extends { valueOf(): infer V }
  ? V extends T
    ? true
    : V extends number | string | boolean | bigint | symbol
    ? true
    : false
  : false;

/**
 * Check for types with known class method signatures
 */
type HasClassMethods<T> = T extends { getTime(): number }  // Date-like
  ? true
  : T extends { size: number; has(value: any): boolean }  // Set/Map-like
  ? true
  : T extends { byteLength: number }  // ArrayBuffer/TypedArray-like
  ? true
  : T extends { then(onfulfilled?: any): any }  // Promise-like
  ? true
  : T extends { message: string; name: string }  // Error-like
  ? true
  : T extends { exec(string: string): any }  // RegExp-like
  ? true
  : false;

/**
 * Combined check for value types that should not be recursively processed
 */
type IsValueType<T> = IsClassInstance<T> extends true
  ? true
  : HasClassMethods<T> extends true
  ? true
  : false;

/**
 * Type helper to unwrap DbColumn types to their underlying values
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
export type UnwrapDbColumns<T> = T extends DbColumn<infer V>
  ? V
  : T extends object
  ? IsValueType<T> extends true
    ? T  // Preserve class instances as-is
    : {
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
 * Type helper to extract just the keys of DbColumn properties from an entity.
 * Returns a union of string literal types representing the column property names.
 *
 * @example
 * ```typescript
 * interface User {
 *   id: DbColumn<number>;
 *   username: DbColumn<string>;
 *   posts: Post[]; // navigation property
 * }
 *
 * type UserColumnKeys = ExtractDbColumnKeys<User>;
 * // Result: 'id' | 'username'
 * ```
 */
export type ExtractDbColumnKeys<T> = keyof ExtractDbColumns<T> & string;

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
