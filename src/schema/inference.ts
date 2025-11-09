import { TableBuilder, TableSchema, InferColumnType } from './table-builder';
import { CollectionQueryBuilder } from '../query/query-builder';

/**
 * Infer the complete row type including columns and navigation properties
 */
export type InferRowType<TBuilder extends TableBuilder<any>> =
  TBuilder extends TableBuilder<infer TColumns>
    ? InferRowTypeFromSchema<ReturnType<TBuilder['build']>>
    : never;

/**
 * Infer row type from built schema
 */
type InferRowTypeFromSchema<TSchema extends TableSchema> = {
  readonly [K in keyof TSchema['columns']]: K;
} & {
  readonly [K in keyof TSchema['relations']]: TSchema['relations'][K]['type'] extends 'many'
    ? CollectionQueryBuilder<any>
    : any;
};

/**
 * Extract data type from columns
 */
export type InferDataType<TBuilder extends TableBuilder<any>> =
  TBuilder extends TableBuilder<infer TColumns>
    ? {
        [K in keyof TColumns]: InferColumnType<TColumns[K]>;
      }
    : never;

/**
 * Create typed row for a specific table builder
 */
export type TypedTableRow<TBuilder extends TableBuilder<any>> = InferRowType<TBuilder>;
