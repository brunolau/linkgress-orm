import type { FieldRef } from './conditions';
import type { OrderDirection } from '../entity/db-context';

/**
 * Type guard to check if a value is a FieldRef
 */
export function isFieldRef(value: unknown): value is FieldRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__fieldName' in value &&
    '__dbColumnName' in value
  );
}

/**
 * Type guard to check if a value has a field name (minimal FieldRef check)
 */
export function hasFieldName(value: unknown): value is { __fieldName: string; __dbColumnName?: string; __tableAlias?: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__fieldName' in value
  );
}

/**
 * Type guard to check if a value is an aggregate field ref
 */
export function isAggregateFieldRef(value: unknown): value is FieldRef & { __isAggregate: true } {
  return isFieldRef(value) && '__isAggregate' in value && (value as any).__isAggregate === true;
}

/**
 * Order by field definition
 */
export interface OrderByField {
  field: string;
  table?: string;
  direction: 'ASC' | 'DESC';
}

/**
 * Parse orderBy selector result and populate orderByFields array
 * Handles three forms:
 * 1. Single field: p => p.colName
 * 2. Array of fields: p => [p.colName, p.otherCol]
 * 3. Array of tuples: p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']]
 */
export function parseOrderBy<T>(
  result: T | T[] | Array<[T, OrderDirection]>,
  orderByFields: OrderByField[],
  getFieldName: (fieldRef: any) => string = defaultGetFieldName,
  getTable?: (fieldRef: any) => string | undefined
): void {
  // Handle array of [field, direction] tuples
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    for (const tuple of result as Array<[any, OrderDirection]>) {
      const [fieldRef, direction] = tuple;
      if (hasFieldName(fieldRef)) {
        const field: OrderByField = {
          field: getFieldName(fieldRef),
          direction: direction || 'ASC'
        };
        if (getTable) {
          field.table = getTable(fieldRef);
        }
        orderByFields.push(field);
      }
    }
  }
  // Handle array of fields (all ASC)
  else if (Array.isArray(result)) {
    for (const fieldRef of result) {
      if (hasFieldName(fieldRef)) {
        const field: OrderByField = {
          field: getFieldName(fieldRef),
          direction: 'ASC'
        };
        if (getTable) {
          field.table = getTable(fieldRef);
        }
        orderByFields.push(field);
      }
    }
  }
  // Handle single field
  else if (hasFieldName(result)) {
    const field: OrderByField = {
      field: getFieldName(result),
      direction: 'ASC'
    };
    if (getTable) {
      field.table = getTable(result);
    }
    orderByFields.push(field);
  }
}

/**
 * Default field name extractor - uses __dbColumnName if available, otherwise __fieldName
 */
function defaultGetFieldName(fieldRef: any): string {
  return fieldRef.__dbColumnName || fieldRef.__fieldName;
}

/**
 * Get field name with table alias for qualified column names
 */
export function getQualifiedFieldName(fieldRef: any): string {
  const alias = fieldRef.__tableAlias || '';
  const colName = fieldRef.__dbColumnName || fieldRef.__fieldName;
  return alias ? `"${alias}"."${colName}"` : `"${colName}"`;
}

/**
 * Get table alias from field ref
 */
export function getTableAlias(fieldRef: any): string | undefined {
  return fieldRef.__tableAlias;
}
