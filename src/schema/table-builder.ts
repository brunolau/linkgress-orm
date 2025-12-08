import { ColumnBuilder, ColumnConfig } from './column-builder';
import {
  DbCollection,
  DbReference,
  DbNavigationCollection,
  DbNavigation,
  isNavigationProperty,
  isCollection,
  isReference,
  isNavigationCollection,
  isNavigation,
} from './navigation';

/**
 * Relation types
 */
export type RelationType = 'one' | 'many';

/**
 * Relation configuration
 */
export interface RelationConfig {
  type: RelationType;
  targetTable: string;
  targetTableBuilder?: TableBuilder<any>;  // For type-safe navigation
  foreignKey?: string;
  foreignKeys?: string[];  // For new navigation API
  matches?: string[];      // For new navigation API
  references?: string;
  isMandatory?: boolean;   // For new navigation API
}

/**
 * Index definition
 */
export interface IndexDefinition {
  name: string;
  columns: string[];
}

/**
 * Foreign key action type
 */
export type ForeignKeyAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';

/**
 * Foreign key constraint definition
 */
export interface ForeignKeyConstraint {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
}

/**
 * Table schema definition
 */
export interface TableSchema<TColumns extends Record<string, ColumnBuilder> = any> {
  name: string;
  schema?: string;
  columns: TColumns;
  relations: Record<string, RelationConfig>;
  indexes: IndexDefinition[];
  foreignKeys: ForeignKeyConstraint[];
  /**
   * Performance optimization: Pre-computed map of property names to database column names
   * Avoids repeated .build().name calls during query building
   */
  columnNameMap?: Map<string, string>;
  /**
   * Performance optimization: Pre-computed array of relation entries
   * Avoids repeated Object.entries() calls during query building
   */
  relationEntries?: Array<[string, RelationConfig]>;
  /**
   * Performance optimization: Cache of built target schemas for relations
   * Avoids repeated targetTableBuilder.build() calls
   */
  relationSchemaCache?: Map<string, TableSchema>;
}

/**
 * Extract TypeScript type from column builders
 */
export type InferColumnType<T> = T extends ColumnBuilder<infer U> ? U : never;

/**
 * Infer table row type from schema
 */
export type InferTableType<T extends TableSchema> = {
  [K in keyof T['columns']]: InferColumnType<T['columns'][K]>;
};

/**
 * Schema definition can include both columns and navigation properties
 */
export type SchemaDefinition = Record<string, ColumnBuilder | DbCollection<any> | DbReference<any> | DbNavigationCollection<any> | DbNavigation<any>>;

/**
 * Extract only column builders from schema definition
 */
export type ExtractColumns<T extends SchemaDefinition> = {
  [K in keyof T as T[K] extends ColumnBuilder ? K : never]: T[K];
};

/**
 * Extract only navigation properties from schema definition
 */
export type ExtractNavigations<T extends SchemaDefinition> = {
  [K in keyof T as T[K] extends DbCollection<any> | DbReference<any> | DbNavigationCollection<any> | DbNavigation<any> ? K : never]: T[K];
};

/**
 * Table builder - fluent API for defining tables with columns and navigation properties
 */
export class TableBuilder<TSchema extends SchemaDefinition = any> {
  private tableName: string;
  private schemaName?: string;
  private schemaDef: TSchema;
  private columnDefs: Record<string, ColumnBuilder> = {};
  private relationDefs: Record<string, RelationConfig> = {};
  private indexDefs: IndexDefinition[] = [];
  private foreignKeyDefs: ForeignKeyConstraint[] = [];

  constructor(name: string, schema: TSchema, indexes?: IndexDefinition[], foreignKeys?: ForeignKeyConstraint[], schemaName?: string) {
    this.tableName = name;
    this.schemaName = schemaName;
    this.schemaDef = schema;
    this.indexDefs = indexes || [];
    this.foreignKeyDefs = foreignKeys || [];

    // Separate columns from navigation properties
    for (const [key, value] of Object.entries(schema)) {
      if (isNavigationProperty(value)) {
        // Navigation property
        if (isNavigationCollection(value)) {
          // New navigation collection API
          this.relationDefs[key] = {
            type: 'many' as const,
            targetTable: value.targetTable,
            targetTableBuilder: value.targetTableBuilder,
            foreignKeys: value.foreignKeyColumns,
            matches: value.matchColumns,
            isMandatory: value.isMandatory,
          };
        } else if (isNavigation(value)) {
          // New single navigation API
          this.relationDefs[key] = {
            type: 'one' as const,
            targetTable: value.getTargetTable(),
            targetTableBuilder: value.targetTableBuilder,
            foreignKeys: value.getForeignKeyColumns(),
            matches: value.getMatchColumns(),
            isMandatory: value.getIsMandatory(),
          };
        } else if (value instanceof DbCollection) {
          // Old collection API (backward compatibility)
          this.relationDefs[key] = {
            type: 'many' as const,
            targetTable: value.targetTable,
            foreignKey: value.foreignKey,
          };
        } else if (value instanceof DbReference) {
          // Old reference API (backward compatibility)
          this.relationDefs[key] = {
            type: 'one' as const,
            targetTable: value.targetTable,
            foreignKey: value.foreignKey,
            references: value.references,
          };
        }
      } else {
        // Regular column
        this.columnDefs[key] = value as ColumnBuilder;
      }
    }
  }

  // Performance: Cache the built schema to avoid repeated builds
  private _cachedSchema?: TableSchema<any>;

  /**
   * Build the final table schema
   */
  build(): TableSchema<any> {
    // Return cached schema if available
    if (this._cachedSchema) {
      return this._cachedSchema;
    }

    // Performance: Pre-compute column name map once during build
    const columnNameMap = new Map<string, string>();
    for (const [propName, colBuilder] of Object.entries(this.columnDefs)) {
      columnNameMap.set(propName, (colBuilder as ColumnBuilder).build().name);
    }

    // Performance: Pre-compute relation entries array
    const relationEntries = Object.entries(this.relationDefs) as Array<[string, RelationConfig]>;

    // Performance: Pre-build and cache target schemas for all relations
    const relationSchemaCache = new Map<string, TableSchema>();
    for (const [relName, relConfig] of relationEntries) {
      if (relConfig.targetTableBuilder) {
        relationSchemaCache.set(relName, relConfig.targetTableBuilder.build());
      }
    }

    this._cachedSchema = {
      name: this.tableName,
      schema: this.schemaName,
      columns: this.columnDefs,
      relations: this.relationDefs,
      indexes: this.indexDefs,
      foreignKeys: this.foreignKeyDefs,
      columnNameMap,
      relationEntries,
      relationSchemaCache,
    };
    return this._cachedSchema;
  }

  /**
   * Get table name
   */
  getName(): string {
    return this.tableName;
  }

  /**
   * Get columns
   */
  getColumns(): Record<string, ColumnBuilder> {
    return this.columnDefs;
  }

  /**
   * Get relations
   */
  getRelations(): Record<string, RelationConfig> {
    return this.relationDefs;
  }

  /**
   * Get full schema definition (columns + navigations)
   */
  getSchema(): TSchema {
    return this.schemaDef;
  }

  /**
   * Get a typed field reference for a column (for use in navigation definitions)
   * @example table.field('id') returns FieldRef<'id', number>
   */
  field<K extends keyof ExtractColumns<TSchema>>(
    columnName: K
  ): any {
    const column = this.schemaDef[columnName];
    if (column instanceof ColumnBuilder || (column as any).build) {
      const dbColumnName = (column as any).build().name;
      return {
        __fieldName: columnName,
        __dbColumnName: dbColumnName,
      };
    }
    throw new Error(`Column ${String(columnName)} not found`);
  }
}

/**
 * Table factory function
 * Supports both columns and navigation properties
 */
export function table<TSchema extends SchemaDefinition>(
  name: string,
  schema: TSchema
): TableBuilder<TSchema> {
  return new TableBuilder(name, schema);
}
