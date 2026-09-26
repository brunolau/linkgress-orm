import type { DbColumn, ExtractDbColumnKeys, ExtractDbColumns } from './db-column';

/**
 * A column-only row of an entity: one column ref per mapped property, rendering qualified by an explicit
 * alias (`"v"."col"`) — or unqualified (`"col"`) where no alias is in scope. It is the row a statement
 * hands a callback when only the row's own columns exist there: the `existing` / `excluded` rows of an
 * upsert's conflict arm, the `t` / `v` rows of a bulk update or a row-guarded insert, the `old` row of a
 * RETURNING, an index expression's columns. Navigations are not in scope in those statements.
 */
export type ColumnRow<TEntity> = {
  readonly [K in ExtractDbColumnKeys<TEntity>]-?: DbColumn<ExtractDbColumns<TEntity>[K]>;
};

/** The part of a table schema a column row is built from. */
interface ColumnRowSchema {
  name: string;
  columns: Record<string, unknown>;
  relations: Record<string, unknown>;
}

/**
 * Build a {@link ColumnRow} over `schema`: every mapped property is a FieldRef carrying its column name,
 * mapper and SQL type, qualified by `alias` — or UNQUALIFIED when `alias` is `null` (an index expression,
 * an ON CONFLICT arbiter predicate). Each property returns the same ref object on every access.
 * Accessing a navigation throws, naming `usage`. `chainId` stamps the refs with a query-chain
 * identity (an aliased scope's rows: a query nested in the scope then reads them as correlations).
 * @internal
 */
export function createColumnRow<TEntity = any>(schema: ColumnRowSchema, alias: string | null, usage: string, chainId?: number): ColumnRow<TEntity> {
  const row: any = {};

  for (const [propName, colBuilder] of Object.entries(schema.columns)) {
    const config = (colBuilder as any).build();
    // Key order as the upsert / bulk-update proxies always built it (nothing may depend on it, but a
    // refactor is no place to find out)
    const ref: Record<string, unknown> = alias !== null
      ? { __fieldName: propName, __dbColumnName: config.name, __tableAlias: alias, __mapper: config.mapper, __sqlType: config.type }
      : { __fieldName: propName, __dbColumnName: config.name, __mapper: config.mapper, __sqlType: config.type };

    if (chainId !== undefined) {
      ref.__chainId = chainId;
    }

    Object.defineProperty(row, propName, { get: () => ref, enumerable: true });
  }

  for (const relName of Object.keys(schema.relations)) {
    Object.defineProperty(row, relName, {
      get: () => {
        throw new Error(`${usage}: navigation "${relName}" is not available — only the row's own columns are in scope`);
      },
      enumerable: false,
    });
  }

  return row as ColumnRow<TEntity>;
}
