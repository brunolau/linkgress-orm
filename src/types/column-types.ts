/**
 * PostgreSQL column types supported by the ORM
 */
export type ColumnType =
  // Numeric types
  | 'smallint' | 'integer' | 'bigint'
  | 'decimal' | 'numeric'
  | 'real' | 'double precision'
  | 'smallserial' | 'serial' | 'bigserial'
  // Monetary
  | 'money'
  // Character types
  | 'varchar' | 'char' | 'text'
  // Binary types
  | 'bytea'
  // Date/Time types
  | 'timestamp' | 'timestamptz' | 'date' | 'time' | 'timetz' | 'interval'
  // Boolean
  | 'boolean'
  // UUID
  | 'uuid'
  // JSON
  | 'json' | 'jsonb'
  // Network types
  | 'inet' | 'cidr' | 'macaddr' | 'macaddr8'
  // Geometric types
  | 'point' | 'line' | 'lseg' | 'box' | 'path' | 'polygon' | 'circle'
  // Arrays
  | 'array'
  // Custom type
  | string;

/**
 * TypeScript type mapping for PostgreSQL types
 */
export type TypeScriptType<T extends ColumnType> =
  T extends 'smallint' | 'integer' | 'bigint' | 'serial' | 'smallserial' | 'bigserial' ? number :
  T extends 'decimal' | 'numeric' | 'real' | 'double precision' | 'money' ? number :
  T extends 'varchar' | 'char' | 'text' ? string :
  T extends 'bytea' ? Buffer :
  T extends 'timestamp' | 'timestamptz' | 'date' | 'time' | 'timetz' ? Date :
  T extends 'interval' ? string :
  T extends 'boolean' ? boolean :
  T extends 'uuid' ? string :
  T extends 'json' | 'jsonb' ? any :
  T extends 'inet' | 'cidr' | 'macaddr' | 'macaddr8' ? string :
  T extends 'point' | 'line' | 'lseg' | 'box' | 'path' | 'polygon' | 'circle' ? any :
  T extends 'array' ? any[] :
  any;

/**
 * Simplified type names for common PostgreSQL types
 */
export const TypeAliases = {
  int: 'integer' as const,
  float: 'double precision' as const,
  datetime: 'timestamp' as const,
  string: 'text' as const,
  bool: 'boolean' as const,
};

export type TypeAlias = keyof typeof TypeAliases;
