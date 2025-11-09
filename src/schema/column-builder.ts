import { ColumnType } from '../types/column-types';
import { TypeMapper } from '../types/type-mapper';

/**
 * Identity column options
 */
export interface IdentityOptions {
  /** Sequence name (defaults to {table}_{column}_seq) */
  name?: string;
  /** Start value for the sequence */
  startWith?: number;
  /** Increment value */
  incrementBy?: number;
}

/**
 * Column configuration
 */
export interface ColumnConfig {
  name: string;
  type: ColumnType;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
  default?: any;
  length?: number;
  precision?: number;
  scale?: number;
  references?: {
    table: string;
    column: string;
  };
  mapper?: TypeMapper<any, any>;
  /** GENERATED ALWAYS AS IDENTITY configuration */
  identity?: IdentityOptions;
  /** PostgreSQL ENUM type name */
  enumTypeName?: string;
}

/**
 * Column builder - fluent API for defining columns
 */
export class ColumnBuilder<TType = any> {
  protected config: Partial<ColumnConfig>;

  constructor(name: string, type: ColumnType) {
    this.config = {
      name,
      type,
      nullable: true,
      primaryKey: false,
      autoIncrement: false,
      unique: false,
    };
  }

  /**
   * Mark column as NOT NULL
   */
  notNull(): this {
    this.config.nullable = false;
    return this;
  }

  /**
   * Mark column as PRIMARY KEY
   */
  primaryKey(): this {
    this.config.primaryKey = true;
    this.config.nullable = false;
    return this;
  }

  /**
   * Mark column as AUTO INCREMENT
   */
  autoIncrement(): this {
    this.config.autoIncrement = true;
    return this;
  }

  /**
   * Mark column as GENERATED ALWAYS AS IDENTITY (modern PostgreSQL identity columns)
   * This is the preferred way over serial/bigserial for auto-incrementing primary keys
   */
  generatedAlwaysAsIdentity(options?: IdentityOptions): this {
    this.config.autoIncrement = true;
    this.config.identity = options || {};
    return this;
  }

  /**
   * Mark column as UNIQUE
   */
  unique(): this {
    this.config.unique = true;
    return this;
  }

  /**
   * Set default value
   */
  default(value: any): this {
    this.config.default = value;
    return this;
  }

  /**
   * Set column length (for varchar, char)
   */
  length(value: number): this {
    this.config.length = value;
    return this;
  }

  /**
   * Set precision and scale (for decimal, numeric)
   */
  precision(precision: number, scale?: number): this {
    this.config.precision = precision;
    this.config.scale = scale;
    return this;
  }

  /**
   * Define foreign key reference
   */
  references(table: string, column: string = 'id'): this {
    this.config.references = { table, column };
    return this;
  }

  /**
   * Set custom type mapper for bidirectional transformation
   */
  mapWith<TData = TType, TDriver = any>(mapper: TypeMapper<TData, TDriver>): ColumnBuilder<TData> {
    this.config.mapper = mapper;

    // If mapper provides dataType, update the column type
    if (mapper.dataType) {
      this.config.type = mapper.dataType() as ColumnType;
    }

    return this as any;
  }

  /**
   * Get the final column configuration
   */
  build(): ColumnConfig {
    return this.config as ColumnConfig;
  }
}

/**
 * Column factory functions
 */

export const integer = (name: string) => new ColumnBuilder<number>(name, 'integer');
export const serial = (name: string) => new ColumnBuilder<number>(name, 'serial').autoIncrement();
export const bigint = (name: string) => new ColumnBuilder<bigint>(name, 'bigint');
export const bigserial = (name: string) => new ColumnBuilder<bigint>(name, 'bigserial').autoIncrement();
export const smallint = (name: string) => new ColumnBuilder<number>(name, 'smallint');

export const decimal = (name: string, precision?: number, scale?: number) => {
  const builder = new ColumnBuilder<number>(name, 'decimal');
  if (precision) builder.precision(precision, scale);
  return builder;
};

export const numeric = (name: string, precision?: number, scale?: number) => {
  const builder = new ColumnBuilder<number>(name, 'numeric');
  if (precision) builder.precision(precision, scale);
  return builder;
};

export const real = (name: string) => new ColumnBuilder<number>(name, 'real');
export const doublePrecision = (name: string) => new ColumnBuilder<number>(name, 'double precision');

export const varchar = (name: string, length?: number) => {
  const builder = new ColumnBuilder<string>(name, 'varchar');
  if (length) builder.length(length);
  return builder;
};

export const char = (name: string, length?: number) => {
  const builder = new ColumnBuilder<string>(name, 'char');
  if (length) builder.length(length);
  return builder;
};

export const text = (name: string) => new ColumnBuilder<string>(name, 'text');

export const boolean = (name: string) => new ColumnBuilder<boolean>(name, 'boolean');

export const timestamp = (name: string) => new ColumnBuilder<Date>(name, 'timestamp');
export const timestamptz = (name: string) => new ColumnBuilder<Date>(name, 'timestamptz');
export const date = (name: string) => new ColumnBuilder<Date>(name, 'date');
export const time = (name: string) => new ColumnBuilder<string>(name, 'time');

export const uuid = (name: string) => new ColumnBuilder<string>(name, 'uuid');

export const json = (name: string) => new ColumnBuilder<any>(name, 'json');
export const jsonb = (name: string) => new ColumnBuilder<any>(name, 'jsonb');

export const bytea = (name: string) => new ColumnBuilder<Buffer>(name, 'bytea');

/**
 * Create an ENUM column
 *
 * @example
 * import { pgEnum, enumColumn } from 'linkgress-orm';
 *
 * const statusEnum = pgEnum('order_status', ['pending', 'processing', 'completed', 'cancelled'] as const);
 * entity.property(e => e.status).hasType(enumColumn('status', statusEnum));
 */
export function enumColumn<T extends { name: string; values: readonly string[] }>(
  columnName: string,
  enumDef: T
): ColumnBuilder<T['values'][number]> {
  const builder = new ColumnBuilder<T['values'][number]>(columnName, enumDef.name);
  (builder as any).config.enumTypeName = enumDef.name;
  return builder;
}
