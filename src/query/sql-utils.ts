import type { TableSchema } from '../schema/table-builder';

/**
 * Column configuration extracted from schema
 */
export interface ColumnConfig {
  propName: string;
  dbName: string;
  mapper?: {
    toDriver: (value: any) => any;
    fromDriver: (value: any) => any;
  };
  primaryKey?: boolean;
  autoIncrement?: boolean;
}

/**
 * Result from building VALUES clause
 */
export interface ValuesClauseResult {
  valueClauses: string[];
  params: any[];
  nextParamIndex: number;
}

/**
 * Get qualified table name with schema prefix if specified
 */
export function getQualifiedTableName(schema: TableSchema): string {
  return schema.schema
    ? `"${schema.schema}"."${schema.name}"`
    : `"${schema.name}"`;
}

/**
 * Build RETURNING column list from schema
 */
export function buildReturningColumnList(schema: TableSchema): string {
  return Object.entries(schema.columns)
    .map(([_, col]) => `"${(col as any).build().name}"`)
    .join(', ');
}

/**
 * Build column names list from property keys
 */
export function buildColumnNamesList(schema: TableSchema, columnKeys: string[]): string[] {
  return columnKeys.map(key => {
    const column = schema.columns[key];
    const config = column.build();
    return `"${config.name}"`;
  });
}

/**
 * Apply mapper and get value for database
 */
export function applyToDriverMapper(value: any, config: ColumnConfig): any {
  const normalizedValue = value !== undefined ? value : null;
  return config.mapper
    ? config.mapper.toDriver(normalizedValue)
    : normalizedValue;
}

/**
 * Apply fromDriver mapper on query result
 */
export function applyFromDriverMapper(value: any, config: ColumnConfig): any {
  return config.mapper
    ? config.mapper.fromDriver(value)
    : value;
}

/**
 * Detect primary keys from schema
 */
export function detectPrimaryKeys(schema: TableSchema): string[] {
  const primaryKeys: string[] = [];
  for (const [key, colBuilder] of Object.entries(schema.columns)) {
    const colConfig = (colBuilder as any).build();
    if (colConfig.primaryKey) {
      primaryKeys.push(key);
    }
  }
  return primaryKeys;
}

/**
 * Check if schema has auto-increment primary key with provided data
 */
export function hasAutoIncrementPrimaryKey(schema: TableSchema, dataKeys: string[]): boolean {
  for (const key of dataKeys) {
    const column = schema.columns[key];
    if (column) {
      const colConfig = (column as any).build();
      if (colConfig.primaryKey && colConfig.autoIncrement) {
        return true;
      }
    }
  }
  return false;
}

/**
 * PostgreSQL maximum parameter limit
 */
export const POSTGRES_MAX_PARAMS = 65535;

/**
 * Calculate optimal chunk size for bulk operations
 */
export function calculateOptimalChunkSize(
  columnCount: number,
  configChunkSize?: number
): number {
  if (configChunkSize != null) {
    return configChunkSize;
  }
  const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
  return Math.floor(maxRowsPerBatch * 0.6); // Use 60% of max to be safe
}

/**
 * Build column configs from schema for given data keys
 */
export function buildColumnConfigs(
  schema: TableSchema,
  dataKeys: string[],
  includeAutoIncrement: boolean = false
): ColumnConfig[] {
  const configs: ColumnConfig[] = [];

  for (const propName of dataKeys) {
    const column = schema.columns[propName];
    if (column) {
      const config = column.build();
      if (!config.autoIncrement || includeAutoIncrement) {
        configs.push({
          propName,
          dbName: config.name,
          mapper: config.mapper,
          primaryKey: config.primaryKey,
          autoIncrement: config.autoIncrement,
        });
      }
    }
  }

  return configs;
}

/**
 * Extract unique column keys from array of data objects
 */
export function extractUniqueColumnKeys(
  dataArray: Record<string, any>[],
  schema: TableSchema,
  includeAutoIncrement: boolean = false
): string[] {
  const columnSet = new Set<string>();

  for (const data of dataArray) {
    for (const key of Object.keys(data)) {
      const column = schema.columns[key];
      if (column) {
        const config = column.build();
        if (!config.autoIncrement || includeAutoIncrement) {
          columnSet.add(key);
        }
      }
    }
  }

  return Array.from(columnSet);
}

/**
 * Build VALUES clause with parameter placeholders
 */
export function buildValuesClause(
  dataArray: Record<string, any>[],
  columnConfigs: ColumnConfig[],
  startParamIndex: number = 1
): ValuesClauseResult {
  const valueClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = startParamIndex;

  for (const data of dataArray) {
    const rowPlaceholders: string[] = [];

    for (const config of columnConfigs) {
      const value = data[config.propName];
      const mappedValue = applyToDriverMapper(value, config);
      params.push(mappedValue);
      rowPlaceholders.push(`$${paramIndex++}`);
    }

    valueClauses.push(`(${rowPlaceholders.join(', ')})`);
  }

  return {
    valueClauses,
    params,
    nextParamIndex: paramIndex,
  };
}

/**
 * Build ON CONFLICT clause for upserts
 */
export function buildConflictClause(
  conflictColumns: string[],
  updateColumns: string[],
  schema: TableSchema,
  targetWhere?: string,
  setWhere?: string
): string {
  let sql = ' ON CONFLICT';

  // Conflict target columns
  const conflictCols = conflictColumns.map(c => {
    const column = schema.columns[c];
    const config = column?.build();
    return `"${config?.name || c}"`;
  }).join(', ');
  sql += ` (${conflictCols})`;

  // Target WHERE clause
  if (targetWhere) {
    sql += ` WHERE ${targetWhere}`;
  }

  // DO UPDATE SET
  sql += ' DO UPDATE SET ';

  const updateParts = updateColumns.map(col => {
    const column = schema.columns[col];
    const config = column.build();
    return `"${config.name}" = EXCLUDED."${config.name}"`;
  });
  sql += updateParts.join(', ');

  // SET WHERE clause
  if (setWhere) {
    sql += ` WHERE ${setWhere}`;
  }

  return sql;
}

/**
 * Build column name to DB name mapping
 */
export function buildColumnNameMap(schema: TableSchema): Map<string, string> {
  const map = new Map<string, string>();
  for (const [propName, colBuilder] of Object.entries(schema.columns)) {
    const config = (colBuilder as any).build();
    map.set(propName, config.name);
  }
  return map;
}

/**
 * Get database column name from property name
 */
export function getDbColumnName(schema: TableSchema, propName: string): string {
  const column = schema.columns[propName];
  if (column) {
    const config = column.build();
    return config.name;
  }
  return propName;
}
