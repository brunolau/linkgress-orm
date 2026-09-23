import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { EntityConfigBuilder, EntityPropertyConfigBuilder } from './entity-builder';
import type { ExtractDbColumnKeys } from './db-column';
import type { Subquery } from '../query/subquery';

/**
 * What `definedAs(db => …)` returns: a linkgress query — anything with `asSubquery()`, i.e. a
 * `select(…)`, a grouped `select(…)`, a union or a CTE-rooted query — whose rows carry `TRow`.
 */
export interface ViewQuerySource<TRow = unknown> {
  asSubquery(mode: 'table'): Subquery<TRow, 'table'>;
}

/** The row a query must produce to define `TView`: a key for every column the view declares. */
export type ViewQueryRow<TView> = { [K in ExtractDbColumnKeys<TView>]: unknown };

/**
 * Fluent API for a model-managed database VIEW (`model.view()`): its name, its
 * SELECT and the typed columns it exposes. A view has no keys, indexes,
 * constraints or navigations — expose it with the context's `view()`, which is
 * read-only.
 */
export class ViewConfigBuilder<TView extends DbEntity> {
  private readonly columns: EntityConfigBuilder<TView>;

  constructor(private readonly viewClass: EntityConstructor<TView>) {
    this.columns = new EntityConfigBuilder(viewClass);
  }

  /** The view's name in the database. */
  toView(name: string): this {
    this.columns.toTable(name);
    return this;
  }

  /** The schema the view lives in (default: `public`). Created if missing. */
  toSchema(name: string): this {
    this.columns.toSchema(name);
    return this;
  }

  /**
   * The view's SELECT as SQL text — everything after `CREATE VIEW … AS`. Its
   * column aliases must match the names given to `property(...).hasType(...)`.
   */
  definedAs(sql: string): this;
  /**
   * The view's SELECT as a linkgress query, built on the context:
   *
   * ```ts
   * view.definedAs((db: AppDatabase) => db.orders
   *   .where(o => gt(o.amount, 0))
   *   .select(o => ({ id: o.id, label: o.label, lineCount: o.lines.count() })));
   * ```
   *
   * Every projected key must be a view property (and the other way round) — the compiler
   * checks that each property is projected. The context renders the query when a schema
   * manager needs it: the projection is aliased to the properties' column names, in
   * declaration order, and the query's bound values are inlined as SQL literals (a view
   * cannot carry parameters).
   */
  definedAs<TDb>(query: (db: TDb) => ViewQuerySource<ViewQueryRow<TView>>): this;
  definedAs(source: string | ((db: any) => unknown)): this {
    EntityMetadataStore.getOrCreateMetadata(this.viewClass).view = typeof source === 'string'
      ? { definition: source }
      : { query: source };
    return this;
  }

  /** One column the view exposes: `view.property(e => e.x).hasType(integer('x'))`. */
  property<K extends keyof TView>(selector: (view: TView) => TView[K]): EntityPropertyConfigBuilder<TView, K> {
    return this.columns.property(selector);
  }
}
