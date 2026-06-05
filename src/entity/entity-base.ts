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
  /**
   * Set when the column participates in an {@link ixNormalized} index. A
   * transferable hint that the column has an accent/case-insensitive index, so
   * normalized query helpers can be applied against it efficiently.
   */
  hasNormalizedIndex?: boolean;
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
  /**
   * Set by {@link ixNormalized}. Signals that this index entry uses
   * `public.search_normalize()`, so the migration must create the `unaccent`
   * extension and the `search_normalize` function before building the index.
   */
  __requiresSearchNormalize?: boolean;
  /**
   * Set by `ixNormalized(ref, { gin: true })`. Signals that the index should be
   * a trigram GIN index (`USING gin (... gin_trgm_ops)`), which also requires
   * the `pg_trgm` extension.
   */
  __gin?: boolean;
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
 * Index expression helper that wraps a column in `public.search_normalize()`,
 * producing an accent- and case-insensitive expression index. Composable with
 * the other `ix*` helpers.
 *
 * Pass `{ gin: true }` to build a trigram GIN index (best for substring /
 * `normalizedLike('%x%')` searches); omit it for a plain btree expression index
 * (best for `normalizedEq` / `normalizedStartsWith` and unique constraints).
 *
 * Declaring any `ixNormalized` index automatically makes the migration create
 * the `unaccent` extension + `search_normalize` function (and `pg_trgm` when
 * `gin` is used) before the index is built.
 *
 * @example
 * // unique normalized lookup (btree)
 * entity.hasIndex('user_admin_query', e => [ixNormalized(e.email), e.hash]).isUnique();
 *
 * // fuzzy substring search (trigram GIN)
 * entity.hasIndex('user_name_search', e => [ixNormalized(e.username, { gin: true })]);
 */
export function ixNormalized<T>(ref: T, options?: { gin?: boolean }): T {
  const wrapped = wrapIndexExpression(ref, 'public.search_normalize') as any;
  if (wrapped && wrapped.__indexColumn) {
    wrapped.__requiresSearchNormalize = true;
    if (options?.gin) {
      wrapped.__gin = true;
    } else {
      // btree expression index: `text_pattern_ops` makes anchored LIKE
      // ('prefix%', i.e. normalizedStartsWith) index-usable on non-C-locale
      // databases, while still serving normalizedEq (=) and UNIQUE constraints.
      // Baked into the expression so it applies per-column in composite indexes.
      // (Keep ixNormalized the OUTERMOST helper — don't wrap it with ixLower etc.)
      wrapped.expression = `${wrapped.expression} text_pattern_ops`;
    }
  }
  return wrapped as T;
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
  /**
   * If true, the index is created with `CREATE INDEX CONCURRENTLY`, which avoids
   * holding a long write lock on the table. The statement must run outside of a
   * transaction — PostgreSQL will raise an error otherwise.
   */
  concurrent?: boolean;
  /** Raw SQL expressions for expression-based index columns (e.g., 'lower(unaccent(name))') */
  expressions?: string[];
  /** Raw SQL WHERE clause for partial indexes (e.g., 'active = true') */
  where?: string;
  /**
   * Set when the index contains an {@link ixNormalized} expression. The schema
   * manager uses this to create the `unaccent` extension + `search_normalize`
   * function (and `pg_trgm` when `using === 'gin'`) before building the index.
   */
  requiresSearchNormalize?: boolean;
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
