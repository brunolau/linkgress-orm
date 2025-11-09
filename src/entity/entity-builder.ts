import { DbEntity, EntityConstructor, EntityMetadataStore, PropertyMetadata, NavigationMetadata, ForeignKeyAction } from './entity-base';
import { ColumnBuilder } from '../schema/column-builder';
import { TypeMapper } from '../types/type-mapper';
import { DbColumn } from './db-column';
import { SqlFragment } from '../query/conditions';

/**
 * Fluent API for configuring entity properties
 */
export class EntityPropertyBuilder<TEntity extends DbEntity, TProperty> {
  constructor(
    private entityClass: EntityConstructor<TEntity>,
    private propertyKey: keyof TEntity,
    private columnBuilder: ColumnBuilder
  ) {}

  /**
   * Set the database column name
   */
  hasColumnName(name: string): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const propMetadata = metadata.properties.get(this.propertyKey) || {
      propertyKey: this.propertyKey,
      columnName: name,
      columnBuilder: this.columnBuilder,
    };
    propMetadata.columnName = name;
    metadata.properties.set(this.propertyKey, propMetadata);
    return this;
  }

  /**
   * Mark as primary key
   */
  isPrimaryKey(): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const propMetadata = metadata.properties.get(this.propertyKey)!;
    propMetadata.isPrimaryKey = true;
    metadata.properties.set(this.propertyKey, propMetadata);

    // Also mark the column builder as primary key
    this.columnBuilder.primaryKey();

    return this;
  }

  /**
   * Mark as required
   */
  isRequired(): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const propMetadata = metadata.properties.get(this.propertyKey)!;
    propMetadata.isRequired = true;
    metadata.properties.set(this.propertyKey, propMetadata);

    // Also mark the column builder as not null
    this.columnBuilder.notNull();

    return this;
  }

  /**
   * Set default value
   */
  hasDefaultValue(value: any): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const propMetadata = metadata.properties.get(this.propertyKey)!;
    propMetadata.defaultValue = value;
    metadata.properties.set(this.propertyKey, propMetadata);

    // Also set the default on the column builder
    this.columnBuilder.default(value);

    return this;
  }

  /**
   * Mark as unique
   */
  isUnique(): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const propMetadata = metadata.properties.get(this.propertyKey)!;
    propMetadata.isUnique = true;
    metadata.properties.set(this.propertyKey, propMetadata);

    // Also mark the column builder as unique
    this.columnBuilder.unique();

    return this;
  }

  /**
   * Set custom type mapper for bidirectional transformation
   */
  hasCustomMapper<TData = TProperty, TDriver = any>(mapper: TypeMapper<TData, TDriver>): this {
    // Apply mapper to column builder
    this.columnBuilder.mapWith(mapper);

    return this;
  }
}

/**
 * Base navigation builder with shared functionality
 */
abstract class BaseNavigationBuilder<TEntity extends DbEntity, TTarget extends DbEntity> {
  constructor(
    protected entityClass: EntityConstructor<TEntity>,
    protected propertyKey: keyof TEntity,
    protected targetEntity: () => EntityConstructor<TTarget>,
    protected relationType: 'one' | 'many'
  ) {}

  /**
   * Extract property names from selector (supports single or multiple columns)
   */
  protected extractPropertyNamesFromSelector(selector: Function): string[] {
    // Create a proxy to capture property accesses
    const propertyNames: string[] = [];
    const captureProxy = new Proxy({} as any, {
      get: (_, prop) => {
        if (typeof prop === 'string' && prop !== 'constructor') {
          propertyNames.push(prop);
        }
        return captureProxy; // Return proxy for chaining
      }
    });

    try {
      const result = selector(captureProxy);

      // If result is an array, it means multiple properties were captured
      if (Array.isArray(result)) {
        // Properties were already captured during the proxy access
        return propertyNames;
      }

      // Single property case
      return propertyNames;
    } catch (e) {
      // Fallback to regex parsing if proxy approach fails
      const selectorStr = selector.toString();
      const match = selectorStr.match(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (!match) {
        throw new Error('Could not extract property name from selector');
      }
      return [match[1]];
    }
  }

  protected setForeignKeyMetadata(foreignKeyNames: string[]): void {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata: NavigationMetadata<TTarget> = {
      propertyKey: this.propertyKey,
      targetEntity: this.targetEntity,
      relationType: this.relationType,
      foreignKey: foreignKeyNames.length === 1 ? foreignKeyNames[0] : foreignKeyNames.join(','),
      principalKey: '', // Will be set by withPrincipalKey
    };
    metadata.navigations.set(this.propertyKey, navMetadata);
  }

  protected setPrincipalKeyMetadata(principalKeyNames: string[]): void {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata = metadata.navigations.get(this.propertyKey)!;
    navMetadata.principalKey = principalKeyNames.length === 1 ? principalKeyNames[0] : principalKeyNames.join(',');
    metadata.navigations.set(this.propertyKey, navMetadata);
  }

  /**
   * Mark navigation as required
   */
  isRequired(): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata = metadata.navigations.get(this.propertyKey)!;
    navMetadata.isRequired = true;
    metadata.navigations.set(this.propertyKey, navMetadata);
    return this;
  }

  /**
   * Specify the ON DELETE action for the foreign key constraint
   */
  onDelete(action: ForeignKeyAction): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata = metadata.navigations.get(this.propertyKey)!;
    navMetadata.onDelete = action;
    metadata.navigations.set(this.propertyKey, navMetadata);
    return this;
  }

  /**
   * Specify the ON UPDATE action for the foreign key constraint
   */
  onUpdate(action: ForeignKeyAction): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata = metadata.navigations.get(this.propertyKey)!;
    navMetadata.onUpdate = action;
    metadata.navigations.set(this.propertyKey, navMetadata);
    return this;
  }

  /**
   * Specify a custom name for the foreign key constraint
   */
  hasDbName(name: string): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const navMetadata = metadata.navigations.get(this.propertyKey)!;
    navMetadata.constraintName = name;
    metadata.navigations.set(this.propertyKey, navMetadata);
    return this;
  }
}

/**
 * Navigation builder for hasMany relationships (one-to-many)
 * Foreign key is on the target entity (many side)
 * Principal key is on the source entity (one side)
 */
export class HasManyNavigationBuilder<TEntity extends DbEntity, TTarget extends DbEntity> extends BaseNavigationBuilder<TEntity, TTarget> {
  /**
   * Specify the foreign key on the target entity (many side)
   * Supports single column: p => p.userId
   * Supports multiple columns: p => [p.userId, p.type]
   * Supports SQL fragments: p => sql`...`
   */
  withForeignKey(foreignKey: (entity: TTarget) => DbColumn<any> | DbColumn<any>[] | SqlFragment): this {
    const foreignKeyNames = this.extractPropertyNamesFromSelector(foreignKey as Function);
    this.setForeignKeyMetadata(foreignKeyNames);
    return this;
  }

  /**
   * Specify the principal key on the source entity (one side)
   * Supports single column: u => u.id
   * Supports multiple columns: u => [u.id, u.type]
   * Supports SQL fragments: u => sql`...`
   */
  withPrincipalKey(principalKey: (entity: TEntity) => DbColumn<any> | DbColumn<any>[] | SqlFragment): this {
    const principalKeyNames = this.extractPropertyNamesFromSelector(principalKey as Function);
    this.setPrincipalKeyMetadata(principalKeyNames);
    return this;
  }
}

/**
 * Navigation builder for hasOne relationships (many-to-one or one-to-one)
 * Foreign key is on the source entity
 * Principal key is on the target entity
 */
export class HasOneNavigationBuilder<TEntity extends DbEntity, TTarget extends DbEntity> extends BaseNavigationBuilder<TEntity, TTarget> {
  /**
   * Specify the foreign key on the source entity
   * Supports single column: p => p.userId
   * Supports multiple columns: p => [p.userId, p.type]
   * Supports SQL fragments: p => sql`...`
   */
  withForeignKey(foreignKey: (entity: TEntity) => DbColumn<any> | DbColumn<any>[] | SqlFragment): this {
    const foreignKeyNames = this.extractPropertyNamesFromSelector(foreignKey as Function);
    this.setForeignKeyMetadata(foreignKeyNames);
    return this;
  }

  /**
   * Specify the principal key on the target entity
   * Supports single column: u => u.id
   * Supports multiple columns: u => [u.id, u.type]
   * Supports SQL fragments: u => sql`...`
   */
  withPrincipalKey(principalKey: (entity: TTarget) => DbColumn<any> | DbColumn<any>[] | SqlFragment): this {
    const principalKeyNames = this.extractPropertyNamesFromSelector(principalKey as Function);
    this.setPrincipalKeyMetadata(principalKeyNames);
    return this;
  }
}

/**
 * Legacy navigation builder for backward compatibility
 * @deprecated Use HasManyNavigationBuilder or HasOneNavigationBuilder
 */
export class EntityNavigationBuilder<TEntity extends DbEntity, TTarget extends DbEntity> extends BaseNavigationBuilder<TEntity, TTarget> {
  withForeignKey(foreignKey: (entity: TTarget) => any): this;
  withForeignKey(foreignKey: (entity: TEntity) => any): this;
  withForeignKey(foreignKey: Function): this {
    const foreignKeyNames = this.extractPropertyNamesFromSelector(foreignKey);
    this.setForeignKeyMetadata(foreignKeyNames);
    return this;
  }

  withPrincipalKey(principalKey: (entity: TEntity) => any): this;
  withPrincipalKey(principalKey: (entity: TTarget) => any): this;
  withPrincipalKey(principalKey: Function): this {
    const principalKeyNames = this.extractPropertyNamesFromSelector(principalKey);
    this.setPrincipalKeyMetadata(principalKeyNames);
    return this;
  }
}

/**
 * Fluent API for configuring an entity
 */
export class EntityConfigBuilder<TEntity extends DbEntity> {
  constructor(private entityClass: EntityConstructor<TEntity>) {}

  /**
   * Set the table name
   */
  toTable(name: string): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    metadata.tableName = name;
    return this;
  }

  /**
   * Set the schema name
   */
  toSchema(name: string): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    metadata.schemaName = name;
    return this;
  }

  /**
   * Configure a property
   */
  property<K extends keyof TEntity>(
    selector: (entity: TEntity) => TEntity[K]
  ): EntityPropertyConfigBuilder<TEntity, K> {
    const propertyKey = this.extractPropertyName(selector) as K;
    return new EntityPropertyConfigBuilder(this.entityClass, propertyKey);
  }

  /**
   * Configure a one-to-many navigation
   */
  hasMany<TTarget extends DbEntity, K extends keyof TEntity>(
    selector: (entity: TEntity) => TEntity[K],
    targetEntity: () => EntityConstructor<TTarget>
  ): HasManyNavigationBuilder<TEntity, TTarget> {
    const propertyKey = this.extractPropertyName(selector) as K;
    return new HasManyNavigationBuilder(this.entityClass, propertyKey, targetEntity, 'many');
  }

  /**
   * Configure a many-to-one or one-to-one navigation
   */
  hasOne<TTarget extends DbEntity, K extends keyof TEntity>(
    selector: (entity: TEntity) => TEntity[K],
    targetEntity: () => EntityConstructor<TTarget>
  ): HasOneNavigationBuilder<TEntity, TTarget> {
    const propertyKey = this.extractPropertyName(selector) as K;
    return new HasOneNavigationBuilder(this.entityClass, propertyKey, targetEntity, 'one');
  }

  /**
   * Configure an index
   */
  hasIndex(
    indexName: string,
    selector: (entity: TEntity) => Array<TEntity[keyof TEntity]>
  ): this {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);

    // Create a temporary entity to extract column names
    const tempEntity = {} as TEntity;
    const columnNames: string[] = [];

    // Build a proxy to capture property accesses
    const proxy = new Proxy(tempEntity, {
      get: (target, prop) => {
        if (typeof prop === 'string') {
          // Find the column name for this property
          const propMetadata = metadata.properties.get(prop as keyof TEntity);
          if (propMetadata) {
            columnNames.push(propMetadata.columnName);
          }
        }
        return proxy;
      }
    });

    // Execute the selector to capture property accesses
    selector(proxy);

    // Add the index metadata
    metadata.indexes.push({
      name: indexName,
      columns: columnNames
    });

    return this;
  }

  /**
   * Extract property name from selector
   */
  private extractPropertyName<K extends keyof TEntity>(selector: (entity: TEntity) => TEntity[K]): keyof TEntity {
    const selectorStr = selector.toString();
    const match = selectorStr.match(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (!match) {
      throw new Error('Could not extract property name from selector');
    }
    return match[1] as keyof TEntity;
  }
}

/**
 * Property configuration builder that requires a column type
 */
export class EntityPropertyConfigBuilder<TEntity extends DbEntity, K extends keyof TEntity> {
  constructor(
    private entityClass: EntityConstructor<TEntity>,
    private propertyKey: K
  ) {}

  /**
   * Set the column type
   */
  hasType(columnBuilder: ColumnBuilder): EntityPropertyBuilder<TEntity, TEntity[K]> {
    const metadata = EntityMetadataStore.getOrCreateMetadata(this.entityClass);
    const dbColumnName = (columnBuilder as any).build().name;
    const propMetadata: PropertyMetadata = {
      propertyKey: this.propertyKey,
      columnName: dbColumnName,
      columnBuilder: columnBuilder,
    };
    metadata.properties.set(this.propertyKey, propMetadata);
    return new EntityPropertyBuilder(this.entityClass, this.propertyKey, columnBuilder);
  }
}
