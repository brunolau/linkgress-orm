import { TableBuilder } from '../schema/table-builder';
import { ColumnBuilder } from '../schema/column-builder';

/**
 * Unique symbol for DbEntity type branding
 * @internal
 */
declare const __entityBrandSymbol: unique symbol;

/**
 * Base class for all entities
 */
export abstract class DbEntity {
  /** @internal - Type brand to distinguish DbEntity from plain objects in the type system */
  declare readonly [__entityBrandSymbol]: true;

  /** @internal */
  static readonly __isEntity = true;

  /** @internal */
  static __tableName?: string;

  /** @internal */
  static __tableBuilder?: TableBuilder<any>;
}

/**
 * DbEntity constructor type
 */
export type EntityConstructor<T extends DbEntity = DbEntity> = new () => T;

/**
 * DbEntity metadata for a single entity
 */
export interface EntityMetadata<T extends DbEntity> {
  entityClass: EntityConstructor<T>;
  tableName: string;
  schemaName?: string;
  properties: Map<keyof T, PropertyMetadata>;
  navigations: Map<keyof T, NavigationMetadata<any>>;
  indexes: IndexMetadata[];
}

/**
 * Property metadata
 */
export interface PropertyMetadata {
  propertyKey: keyof any;
  columnName: string;
  columnBuilder: ColumnBuilder;
  isPrimaryKey?: boolean;
  isRequired?: boolean;
  isUnique?: boolean;
  defaultValue?: any;
}

/**
 * Foreign key action type
 */
export type ForeignKeyAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';

/**
 * Navigation metadata
 */
export interface NavigationMetadata<TTarget extends DbEntity> {
  propertyKey: keyof any;
  targetEntity: () => EntityConstructor<TTarget>;
  relationType: 'one' | 'many';
  foreignKeys: string[];
  principalKeys: string[];
  isRequired?: boolean;
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
  constraintName?: string;
  /**
   * If true, this is an inverse navigation (the FK constraint is defined on the other side).
   * No FK constraint will be created for this navigation.
   */
  isInverseNavigation?: boolean;
}

export type IndexMethod = 'btree' | 'gin' | 'gist' | 'hash' | 'brin' | 'spgist';

/**
 * Index expression helpers — wrap entity property references inside hasIndex selectors.
 * Composable: ixLower(ixUnaccent(e.name)) → lower(unaccent("name"))
 *
 * @example
 * entity.hasIndex('idx_name', e => [ixLower(ixUnaccent(e.name))])
 */
export interface IndexColumnRef {
  __indexColumn: true;
  columnName: string;
  expression?: string;
}

function wrapIndexExpression<T>(ref: T, fn: string): T {
  const r = ref as any;
  if (r && r.__indexColumn) {
    return { ...r, expression: `${fn}(${r.expression || `"${r.columnName}"`})` } as T;
  }
  return ref;
}

export function ixLower<T>(ref: T): T {
  return wrapIndexExpression(ref, 'lower');
}

export function ixUnaccent<T>(ref: T): T {
  return wrapIndexExpression(ref, 'unaccent');
}

/**
 * Index metadata
 */
export interface IndexMetadata {
  name: string;
  columns: string[];
  isUnique?: boolean;
  using?: IndexMethod;
  operatorClass?: string;
  /** Raw SQL expressions for expression-based index columns (e.g., 'lower(unaccent(name))') */
  expressions?: string[];
  /** Raw SQL WHERE clause for partial indexes (e.g., 'active = true') */
  where?: string;
}

/**
 * Global entity metadata store
 */
export class EntityMetadataStore {
  private static metadata = new Map<EntityConstructor<any>, EntityMetadata<any>>();

  static getMetadata<T extends DbEntity>(entityClass: EntityConstructor<T>): EntityMetadata<T> | undefined {
    return this.metadata.get(entityClass);
  }

  static setMetadata<T extends DbEntity>(entityClass: EntityConstructor<T>, metadata: EntityMetadata<T>): void {
    this.metadata.set(entityClass, metadata);
  }

  static hasMetadata<T extends DbEntity>(entityClass: EntityConstructor<T>): boolean {
    return this.metadata.has(entityClass);
  }

  static getOrCreateMetadata<T extends DbEntity>(entityClass: EntityConstructor<T>): EntityMetadata<T> {
    let metadata = this.metadata.get(entityClass);
    if (!metadata) {
      metadata = {
        entityClass,
        tableName: entityClass.name.toLowerCase(),
        properties: new Map(),
        navigations: new Map(),
        indexes: [],
      };
      this.metadata.set(entityClass, metadata);
    }
    return metadata;
  }
}
