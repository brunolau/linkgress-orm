import { TableBuilder } from './table-builder';
import { FieldRef } from '../query/conditions';

/**
 * Navigation configuration
 */
export interface NavigationConfig<
  TSourceTable extends TableBuilder<any> = TableBuilder<any>,
  TTargetTable extends TableBuilder<any> = TableBuilder<any>
> {
  /**
   * Array of foreign key fields from the source table
   * Example: [users.id] when defining a collection on users table
   */
  foreignKeys: FieldRef<any, any>[];

  /**
   * Array of matching fields from the target table
   * Example: [posts.userId] when defining posts collection
   */
  matches: FieldRef<any, any>[];

  /**
   * Determines if the join is mandatory (INNER JOIN) or optional (LEFT JOIN)
   * Default: false (LEFT JOIN)
   */
  isMandatory?: boolean;
}

/**
 * Navigation property marker - represents a collection navigation property (one-to-many)
 * Represents a collection of related entities in a navigation property
 */
export class DbNavigationCollection<
  TTarget extends TableBuilder<any> = TableBuilder<any>
> {
  /** @internal */
  readonly __targetTable!: TTarget;
  /** @internal */
  readonly __navigationType = 'collection' as const;

  constructor(
    /** @internal */
    public readonly targetTableBuilder: TTarget,
    /** @internal */
    public readonly config: NavigationConfig<any, TTarget>
  ) { }

  /**
   * Get the target table name
   */
  get targetTable(): string {
    return this.targetTableBuilder.getName();
  }

  /**
   * Get foreign key column names
   */
  get foreignKeyColumns(): string[] {
    return this.config.foreignKeys.map(fk => fk.__dbColumnName);
  }

  /**
   * Get matching column names
   */
  get matchColumns(): string[] {
    return this.config.matches.map(m => m.__dbColumnName);
  }

  /**
   * Whether this navigation requires a mandatory join
   */
  get isMandatory(): boolean {
    return this.config.isMandatory ?? false;
  }
}

/**
 * Navigation property marker for single reference (one-to-one or many-to-one)
 */
export class DbNavigation<
  TTarget extends TableBuilder<any> = TableBuilder<any>
> {
  /** @internal */
  readonly __targetTable!: TTarget;
  /** @internal */
  readonly __navigationType = 'navigation' as const;
  /** @internal */
  public targetTableBuilder: TTarget = null as any;
  /** @internal */
  public config: NavigationConfig<any, TTarget> = null as any;



  constructor(
    /** @internal */
    readonly builder: () => {
      targetTable: TTarget,
      config: NavigationConfig<any, TTarget>
    }
  ) { }

  private ensureNavigation() {
    if (this.targetTableBuilder == null) {
      const val = this.builder();
      this.targetTableBuilder = val.targetTable;
      this.config = val.config;

      this.getTargetTable = () => this.targetTableBuilder.getName();
      this.getForeignKeyColumns = () => this.config.foreignKeys.map(fk => fk.__dbColumnName);
      this.getMatchColumns = () => this.config.matches.map(m => m.__dbColumnName);
      this.getIsMandatory = () => this.config.isMandatory ?? false;
    }
  }

  /**
   * Get the target table name
   */
  getTargetTable(): string {
    this.ensureNavigation();
    return this.targetTableBuilder.getName();
  }

  /**
   * Get foreign key column names
   */
  getForeignKeyColumns(): string[] {
    this.ensureNavigation();
    return this.config.foreignKeys.map(fk => fk.__dbColumnName);
  }

  /**
   * Get matching column names
   */
  getMatchColumns(): string[] {
    this.ensureNavigation();
    return this.config.matches.map(m => m.__dbColumnName);
  }

  /**
   * Whether this navigation requires a mandatory join
   */
  getIsMandatory(): boolean {
    this.ensureNavigation();
    return this.config.isMandatory ?? false;
  }
}

/**
 * Helper to create a collection navigation property (one-to-many)
 *
 * @example
 * ```typescript
 * const users = table('users', {
 *   id: serial('id').primaryKey(),
 *   posts: navigationCollection(posts, {
 *     foreignKeys: [users.id],
 *     matches: [posts.userId],
 *     isMandatory: false
 *   })
 * });
 * ```
 */
export function navigationCollection<TTarget extends TableBuilder<any>>(
  targetTable: TTarget,
  config: NavigationConfig<any, TTarget>
): DbNavigationCollection<TTarget> {
  return new DbNavigationCollection<TTarget>(targetTable, config);
}

/**
 * Helper to create a single navigation property (one-to-one or many-to-one)
 *
 * @example
 * ```typescript
 * const orders = table('orders', {
 *   id: serial('id').primaryKey(),
 *   userId: integer('user_id').notNull(),
 *   user: navigation(users, {
 *     foreignKeys: [orders.userId],
 *     matches: [users.id],
 *     isMandatory: true
 *   })
 * });
 * ```
 */
export function navigation<TTarget extends TableBuilder<any>>(builder: () => {
  targetTable: TTarget,
  config: NavigationConfig<any, TTarget>
}): DbNavigation<TTarget> {
  return new DbNavigation<TTarget>(builder);
}

// ============================================================================
// Backward compatibility - old API (deprecated)
// ============================================================================

/**
 * @deprecated Use navigationCollection instead
 */
export class DbCollection<TTarget extends TableBuilder<any> = TableBuilder<any>> {
  /** @internal */
  readonly __targetTable!: TTarget;
  /** @internal */
  readonly __navigationType = 'collection' as const;

  constructor(
    /** @internal */
    public readonly targetTable: string,
    /** @internal */
    public readonly foreignKey: string
  ) { }
}

/**
 * @deprecated Use navigation instead
 */
export class DbReference<TTarget extends TableBuilder<any> = TableBuilder<any>> {
  /** @internal */
  readonly __targetTable!: TTarget;
  /** @internal */
  readonly __navigationType = 'reference' as const;

  constructor(
    /** @internal */
    public readonly targetTable: string,
    /** @internal */
    public readonly foreignKey: string,
    /** @internal */
    public readonly references: string = 'id'
  ) { }
}

/**
 * @deprecated Use navigationCollection instead
 */
export function collection<TTarget extends TableBuilder<any> = TableBuilder<any>>(
  targetTable: string,
  foreignKey: string
): DbCollection<TTarget> {
  return new DbCollection<TTarget>(targetTable, foreignKey);
}

/**
 * @deprecated Use navigation instead
 */
export function reference<TTarget extends TableBuilder<any> = TableBuilder<any>>(
  targetTable: string,
  foreignKey: string,
  references: string = 'id'
): DbReference<TTarget> {
  return new DbReference<TTarget>(targetTable, foreignKey, references);
}

// ============================================================================
// Type guards
// ============================================================================

/**
 * Type guard to check if a property is a navigation property
 */
export function isNavigationProperty(value: any): value is DbNavigationCollection<any> | DbNavigation<any> | DbCollection<any> | DbReference<any> {
  return value instanceof DbNavigationCollection
    || value instanceof DbNavigation
    || value instanceof DbCollection
    || value instanceof DbReference;
}

/**
 * Type guard for collection navigation (both old and new)
 */
export function isCollection(value: any): value is DbNavigationCollection<any> | DbCollection<any> {
  return value instanceof DbNavigationCollection || value instanceof DbCollection;
}

/**
 * Type guard for reference navigation (both old and new)
 */
export function isReference(value: any): value is DbNavigation<any> | DbReference<any> {
  return value instanceof DbNavigation || value instanceof DbReference;
}

/**
 * Type guard for new navigation collection
 */
export function isNavigationCollection(value: any): value is DbNavigationCollection<any> {
  return value instanceof DbNavigationCollection;
}

/**
 * Type guard for new single navigation
 */
export function isNavigation(value: any): value is DbNavigation<any> {
  return value instanceof DbNavigation;
}

/**
 * Extract navigation properties from a schema definition
 */
export type NavigationProperties<T> = {
  [K in keyof T]: T[K] extends DbNavigationCollection<any> | DbNavigation<any> | DbCollection<any> | DbReference<any> ? K : never;
}[keyof T];

/**
 * Extract regular column properties from a schema definition
 */
export type ColumnProperties<T> = {
  [K in keyof T]: T[K] extends DbNavigationCollection<any> | DbNavigation<any> | DbCollection<any> | DbReference<any> ? never : K;
}[keyof T];
