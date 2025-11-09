import { TableBuilder, SchemaDefinition, ExtractColumns, ExtractNavigations } from './table-builder';
import { DbCollection, DbReference, DbNavigationCollection, DbNavigation } from './navigation';
import { CollectionQueryBuilder } from '../query/query-builder';
import { InferColumnType } from './table-builder';
import { FieldRef } from '../query/conditions';

/**
 * Infer the row type for queries from a table builder
 * This includes both columns (as FieldRef) and navigation properties (as query builders)
 */
export type InferRowType<TBuilder extends TableBuilder<any>> =
  TBuilder extends TableBuilder<infer TSchema>
    ? InferRowTypeFromSchema<TSchema>
    : never;

/**
 * Infer row type from schema definition
 */
type InferRowTypeFromSchema<TSchema extends SchemaDefinition> =
  // Columns as FieldRef with type-safe property names AND value types
  {
    readonly [K in keyof ExtractColumns<TSchema>]: FieldRef<
      K & string,
      InferColumnType<ExtractColumns<TSchema>[K]>
    >;
  }
  // Navigation properties as query builders
  & {
    readonly [K in keyof ExtractNavigations<TSchema>]:
      ExtractNavigations<TSchema>[K] extends DbNavigationCollection<infer TTarget>
        ? CollectionQueryBuilder<InferRowType<TTarget>>
        : ExtractNavigations<TSchema>[K] extends DbNavigation<infer TTarget>
        ? InferRowType<TTarget>  // Single navigation returns the row type directly
        : ExtractNavigations<TSchema>[K] extends DbCollection<infer TTarget>
        ? CollectionQueryBuilder<InferRowType<TTarget>>
        : ExtractNavigations<TSchema>[K] extends DbReference<infer TTarget>
        ? InferRowType<TTarget>  // Reference navigation returns the row type directly
        : never;
  };

/**
 * Infer the data type (actual values) from a table builder
 */
export type InferDataType<TBuilder extends TableBuilder<any>> =
  TBuilder extends TableBuilder<infer TSchema>
    ? {
        [K in keyof ExtractColumns<TSchema>]:
          ExtractColumns<TSchema>[K] extends infer Col
            ? InferColumnType<Col>
            : never;
      }
    : never;
