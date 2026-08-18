import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { EntityConfigBuilder } from './entity-builder';
import { TableBuilder, ForeignKeyConstraint } from '../schema/table-builder';
import { DbNavigation, DbNavigationCollection } from '../schema/navigation';
import {
  assertValidDatabaseSettingName,
  assertValidDatabaseSettingValue,
  normalizeDatabaseSettingValue,
} from '../migration/dbsetting-sql';

/**
 * Model builder for configuring entities
 */
export class DbModelConfig {
  private _searchNormalizeRequired = false;
  private _databaseSettings = new Map<string, string>();

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
   * Opt into the `search_normalize` support objects (the `unaccent` extension
   * and the `public.search_normalize(text)` function) even when no
   * `ixNormalized` index is declared.
   *
   * Call this in `setupModel` when you use the normalized query helpers
   * (`normalizedEq` / `normalizedLike` / `normalizedStartsWith` / `searchNormalize`)
   * without a dedicated index, so the function exists in the database. When an
   * `ixNormalized` index exists, the support objects are created automatically
   * and this call is not required.
   */
  useSearchNormalize(): this {
    this._searchNormalizeRequired = true;
    return this;
  }

  /**
   * Whether `useSearchNormalize()` was called.
   * @internal
   */
  isSearchNormalizeRequired(): boolean {
    return this._searchNormalizeRequired;
  }

  /**
   * Declare a database-level configuration setting the schema manager keeps in
   * sync — `model.hasDbSetting('jit', 'off')` in `setupModel` makes every
   * environment built or migrated from this model run with that setting.
   *
   * Applied via `ALTER DATABASE <current> SET name = value`, which PERSISTS
   * the setting in `pg_db_role_setting`: it survives restarts and every NEW
   * connection to the database inherits it. `ensureCreated()` applies the
   * declared settings on a fresh database; `migrate()` re-applies any that
   * are missing or whose stored value drifted from the declaration.
   *
   * Converge-only, like declared statistics objects: settings this model does
   * NOT declare are never touched, and REMOVING a declaration leaves the
   * database value in place — `RESET` it via a hand migration when that is
   * intended. The migrating role must OWN the database (or be superuser);
   * that is PostgreSQL's own `ALTER DATABASE` privilege rule.
   *
   * Values: strings pass through verbatim (`'off'`, `'32MB'`, `'UTC'`),
   * booleans normalize to the canonical `on`/`off`, numbers to decimal text.
   * Drift comparison is by that stored text, so an equivalent spelling applied
   * by hand (`'false'` vs a declared `'off'`) converges to the declared form
   * on the next migrate.
   */
  hasDbSetting(name: string, value: string | number | boolean): this {
    assertValidDatabaseSettingName(name);
    const normalized = normalizeDatabaseSettingValue(value);
    assertValidDatabaseSettingValue(normalized);
    this._databaseSettings.set(name, normalized);
    return this;
  }

  /**
   * Declared database-level settings, in declaration order (last declaration
   * per key wins).
   * @internal
   */
  getDatabaseSettings(): Map<string, string> {
    return this._databaseSettings;
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
      tableBuilder.withStatistics(metadata.statistics || []);
      tableBuilder.withCheckConstraints(metadata.checkConstraints || []);
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
        mergedTable.withStatistics(metadata.statistics || []);
        mergedTable.withCheckConstraints(metadata.checkConstraints || []);
        if (metadata.partitioning) mergedTable.partitionBy(metadata.partitioning);
        tables.set(metadata.tableName, mergedTable);
      } else {
        if (metadata.partitioning) tableBuilder.partitionBy(metadata.partitioning);
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
      const existingPartitioning = (tableBuilder as any).partitioningDef;
      const existingStatistics = (tableBuilder as any).statisticsDefs || [];
      const existingCheckConstraints = (tableBuilder as any).checkConstraintDefs || [];
      const foreignKeys = foreignKeysByTable.get(tableName) || [];

      const finalTable = new TableBuilder(tableName, existingSchema, existingIndexes, foreignKeys, existingSchemaName);
      finalTable.withStatistics(existingStatistics);
      finalTable.withCheckConstraints(existingCheckConstraints);
      if (existingPartitioning) finalTable.partitionBy(existingPartitioning);
      finalTables.set(tableName, finalTable);
    }

    return finalTables;
  }
}
