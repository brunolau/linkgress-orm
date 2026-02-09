import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { EntityConfigBuilder } from './entity-builder';
import { TableBuilder, ForeignKeyConstraint } from '../schema/table-builder';
import { DbNavigation, DbNavigationCollection } from '../schema/navigation';

/**
 * Model builder for configuring entities
 */
export class DbModelConfig {
  /**
   * Configure an entity
   */
  entity<TEntity extends DbEntity>(
    entityClass: EntityConstructor<TEntity>,
    configure: (builder: EntityConfigBuilder<TEntity>) => void
  ): void {
    const builder = new EntityConfigBuilder(entityClass);
    configure(builder);
  }

  /**
   * Build all table definitions from entity metadata
   * @internal
   */
  buildTables(): Map<string, TableBuilder<any>> {
    const tables = new Map<string, TableBuilder<any>>();
    const metadataEntries: Array<[EntityConstructor<any>, any]> = Array.from((EntityMetadataStore as any).metadata.entries());

    // First pass: build tables without navigations
    const tablesWithoutNav = new Map<string, { table: TableBuilder<any>; entityClass: EntityConstructor<any>; metadata: any }>();

    for (const [entityClass, metadata] of metadataEntries) {
      const schema: any = {};

      // Add properties
      for (const [propKey, propMetadata] of (metadata.properties as Map<any, any>).entries()) {
        schema[propKey as string] = propMetadata.columnBuilder;
      }

      const tableBuilder = new TableBuilder(metadata.tableName, schema, metadata.indexes || [], [], metadata.schemaName);
      tablesWithoutNav.set(metadata.tableName, { table: tableBuilder, entityClass, metadata });
    }

    // Second pass: add navigations
    for (const [entityClass, metadata] of metadataEntries) {
      const tableInfo = Array.from(tablesWithoutNav.values()).find(t => t.entityClass === entityClass);
      if (!tableInfo) continue;

      const { table: tableBuilder } = tableInfo;

      if (metadata.navigations.size > 0) {
        const navSchema: any = {};

        for (const [propKey, navMetadata] of (metadata.navigations as Map<any, any>).entries()) {
          const targetEntityClass = navMetadata.targetEntity();
          const targetMetadata = EntityMetadataStore.getMetadata(targetEntityClass);
          if (!targetMetadata) {
            throw new Error(`No metadata found for target entity ${targetEntityClass.name}`);
          }

          const targetTableInfo = tablesWithoutNav.get(targetMetadata.tableName);
          if (!targetTableInfo) {
            throw new Error(`No table found for ${targetMetadata.tableName}`);
          }

          const targetTable = targetTableInfo.table;

          // Determine which table has the foreign key
          let foreignKeyTable: TableBuilder<any>;
          let principalKeyTable: TableBuilder<any>;
          let foreignKeyParts: string[];
          let principalKeyParts: string[];

          if (navMetadata.relationType === 'many') {
            // For hasMany: FK is on target table, PK is on current table
            foreignKeyTable = targetTable;
            principalKeyTable = tableBuilder;
            foreignKeyParts = navMetadata.foreignKeys;
            principalKeyParts = navMetadata.principalKeys;
          } else {
            // For hasOne: FK is on current table, PK is on target table
            foreignKeyTable = tableBuilder;
            principalKeyTable = targetTable;
            foreignKeyParts = navMetadata.foreignKeys;
            principalKeyParts = navMetadata.principalKeys;
          }

          // Resolve key parts to FieldRefs (supports composite keys and literal values)
          const resolveKeyParts = (parts: string[], table: TableBuilder<any>) => {
            return parts.map(part => {
              if (part.startsWith('__LIT:')) {
                // Literal value — create a special FieldRef
                return { __fieldName: '__const', __dbColumnName: part.substring(6), __isLiteral: true };
              }
              return table.field(part as any);
            });
          };

          const fkRefs = resolveKeyParts(foreignKeyParts, foreignKeyTable);
          const pkRefs = resolveKeyParts(principalKeyParts, principalKeyTable);

          // Create navigation
          if (navMetadata.relationType === 'many') {
            navSchema[propKey as string] = new DbNavigationCollection(targetTable, {
              foreignKeys: fkRefs,
              matches: pkRefs,
              isMandatory: navMetadata.isRequired || false,
            });
          } else {
            navSchema[propKey as string] = new DbNavigation(() => ({
              targetTable: targetTable,
              config: {
                foreignKeys: fkRefs,
                matches: pkRefs,
                isMandatory: navMetadata.isRequired || false,
              }
            }));
          }
        }

        // Merge with existing schema
        const existingSchema = (tableBuilder as any).schemaDef;
        const mergedTable = new TableBuilder(metadata.tableName, { ...existingSchema, ...navSchema }, metadata.indexes || [], [], metadata.schemaName);
        tables.set(metadata.tableName, mergedTable);
      } else {
        tables.set(metadata.tableName, tableBuilder);
      }
    }

    // Third pass: collect foreign key constraints from navigations
    const foreignKeysByTable = new Map<string, ForeignKeyConstraint[]>();

    for (const tableInfo of tablesWithoutNav.values()) {
      const { metadata } = tableInfo;
      const fkConstraints: ForeignKeyConstraint[] = [];

      for (const [propKey, navMetadata] of (metadata.navigations as Map<any, any>).entries()) {
        const targetEntityClass = navMetadata.targetEntity();
        const targetMetadata = EntityMetadataStore.getMetadata(targetEntityClass);
        if (!targetMetadata) continue;

        // Only create FK constraint if this table contains the foreign key
        // Skip if this is an inverse navigation (FK is defined on the other side)
        if (navMetadata.relationType === 'one' && !navMetadata.isInverseNavigation) {
          // For hasOne: FK is on current table
          // Filter out literal values — can't create FK constraints on constants
          const fkColumns: string[] = [];
          const pkColumns: string[] = [];

          for (let i = 0; i < navMetadata.foreignKeys.length; i++) {
            const fkPart = navMetadata.foreignKeys[i];
            const pkPart = navMetadata.principalKeys[i];
            if (fkPart?.startsWith('__LIT:') || pkPart?.startsWith('__LIT:')) continue;

            const fkPropMeta = metadata.properties.get(fkPart);
            const pkPropMeta = (targetMetadata.properties as Map<any, any>).get(pkPart);
            if (!fkPropMeta || !pkPropMeta) continue;

            fkColumns.push(fkPropMeta.columnName);
            pkColumns.push(pkPropMeta.columnName);
          }

          if (fkColumns.length === 0) continue;

          // Generate or use custom constraint name
          const constraintName = navMetadata.constraintName ||
            `FK_${metadata.tableName}_${targetMetadata.tableName}_${fkColumns[0]}`;

          fkConstraints.push({
            name: constraintName,
            columns: fkColumns,
            referencedTable: targetMetadata.tableName,
            referencedColumns: pkColumns,
            onDelete: navMetadata.onDelete,
            onUpdate: navMetadata.onUpdate,
          });
        }
      }

      if (fkConstraints.length > 0) {
        foreignKeysByTable.set(metadata.tableName, fkConstraints);
      }
    }

    // Fourth pass: rebuild tables with foreign key constraints
    const finalTables = new Map<string, TableBuilder<any>>();
    for (const [tableName, tableBuilder] of tables.entries()) {
      const existingSchema = (tableBuilder as any).schemaDef;
      const existingIndexes = (tableBuilder as any).indexDefs || [];
      const existingSchemaName = (tableBuilder as any).schemaName;
      const foreignKeys = foreignKeysByTable.get(tableName) || [];

      const finalTable = new TableBuilder(tableName, existingSchema, existingIndexes, foreignKeys, existingSchemaName);
      finalTables.set(tableName, finalTable);
    }

    return finalTables;
  }
}
