import { TableBuilder, InferTableType, TableSchema } from './table-builder';
import { CollectionQueryBuilder } from '../query/query-builder';

/**
 * Create a typed row proxy for queries
 * This allows strong typing without 'as any'
 */
export type TypedRow<T extends TableSchema> = {
  [K in keyof T['columns']]: K;
} & {
  [K in keyof T['relations']]: T['relations'][K]['type'] extends 'many'
    ? CollectionQueryBuilder<any>
    : any;
};

/**
 * Helper to create typed row accessor
 */
export function createTypedRow<T extends TableSchema>(schema: T): TypedRow<T> {
  const row: any = {};

  // Add column accessors
  for (const colName of Object.keys(schema.columns)) {
    Object.defineProperty(row, colName, {
      get: () => colName,
      enumerable: true,
    });
  }

  // Add relation accessors
  for (const [relName, relConfig] of Object.entries(schema.relations)) {
    if (relConfig.type === 'many') {
      Object.defineProperty(row, relName, {
        get: () =>
          new CollectionQueryBuilder(
            relName,
            relConfig.targetTable,
            relConfig.foreignKey!,
            schema.name
          ),
        enumerable: true,
      });
    }
  }

  return row as TypedRow<T>;
}

/**
 * Infer the full type including columns and relations
 */
export type InferSchemaType<T extends TableSchema> = InferTableType<T> & {
  [K in keyof T['relations']]: T['relations'][K]['type'] extends 'many'
    ? CollectionQueryBuilder<any>
    : any;
};
