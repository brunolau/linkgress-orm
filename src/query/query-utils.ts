import type { FieldRef } from './conditions';
import type { OrderDirection, OrderByResult } from '../entity/db-context';

/**
 * Type guard to check if a value is a FieldRef
 */
export function isFieldRef(value: unknown): value is FieldRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__fieldName' in value &&
    '__dbColumnName' in value
  );
}

/**
 * Type guard to check if a value has a field name (minimal FieldRef check)
 */
export function hasFieldName(value: unknown): value is { __fieldName: string; __dbColumnName?: string; __tableAlias?: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__fieldName' in value
  );
}

/**
 * Type guard to check if a value is an aggregate field ref
 */
export function isAggregateFieldRef(value: unknown): value is FieldRef & { __isAggregate: true } {
  return isFieldRef(value) && '__isAggregate' in value && (value as any).__isAggregate === true;
}

/**
 * Order by field definition
 */
export interface OrderByField {
  field: string;
  table?: string;
  direction: 'ASC' | 'DESC';
}

/**
 * Parse orderBy selector result and populate orderByFields array
 * Handles three forms:
 * 1. Single field: p => p.colName
 * 2. Array of fields: p => [p.colName, p.otherCol]
 * 3. Array of tuples: p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']]
 */
export function parseOrderBy<T>(
  result: OrderByResult<T>,
  orderByFields: OrderByField[],
  getFieldName: (fieldRef: any) => string = defaultGetFieldName,
  getTable?: (fieldRef: any) => string | undefined
): void {
  // Handle array of [field, direction] tuples
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    for (const tuple of result as Array<[any, OrderDirection]>) {
      const [fieldRef, direction] = tuple;
      if (hasFieldName(fieldRef)) {
        const field: OrderByField = {
          field: getFieldName(fieldRef),
          direction: direction || 'ASC'
        };
        if (getTable) {
          field.table = getTable(fieldRef);
        }
        orderByFields.push(field);
      }
    }
  }
  // Handle array of fields (all ASC)
  else if (Array.isArray(result)) {
    for (const fieldRef of result) {
      if (hasFieldName(fieldRef)) {
        const field: OrderByField = {
          field: getFieldName(fieldRef),
          direction: 'ASC'
        };
        if (getTable) {
          field.table = getTable(fieldRef);
        }
        orderByFields.push(field);
      }
    }
  }
  // Handle single field
  else if (hasFieldName(result)) {
    const field: OrderByField = {
      field: getFieldName(result),
      direction: 'ASC'
    };
    if (getTable) {
      field.table = getTable(result);
    }
    orderByFields.push(field);
  }
}

/**
 * Default field name extractor - uses __dbColumnName if available, otherwise __fieldName
 */
function defaultGetFieldName(fieldRef: any): string {
  return fieldRef.__dbColumnName || fieldRef.__fieldName;
}

/**
 * Get field name with table alias for qualified column names
 */
export function getQualifiedFieldName(fieldRef: any): string {
  const alias = fieldRef.__tableAlias || '';
  const colName = fieldRef.__dbColumnName || fieldRef.__fieldName;
  return alias ? `"${alias}"."${colName}"` : `"${colName}"`;
}

/**
 * Get table alias from field ref
 */
export function getTableAlias(fieldRef: any): string | undefined {
  return fieldRef.__tableAlias;
}

/**
 * Cached `"__collection_<table>__"` marker matchers. Collection mock items stamp their column
 * refs with this marker alias (see `CollectionQueryBuilder.createMockItem`) and every strategy
 * rewrites it back to the real inner alias while building SQL — for every field expression,
 * WHERE and ORDER BY of every collection, on every build. Constructing the RegExp per call was
 * measurable on wide projections; the pattern is a pure function of the table name, so it is
 * built once. `withDot` selects the `"marker".` form (lateral strategy: only qualified column
 * references) versus the bare `"marker"` form (CTE / temp-table strategies and filter joins).
 */
const collectionMarkerPatterns = new Map<string, RegExp>();

export function collectionMarkerPattern(targetTable: string, withDot: boolean): RegExp {
  const key = withDot ? `${targetTable}.` : targetTable;
  let pattern = collectionMarkerPatterns.get(key);
  if (!pattern) {
    pattern = new RegExp(`"__collection_${targetTable}__"${withDot ? '\\.' : ''}`, 'g');
    collectionMarkerPatterns.set(key, pattern);
  }
  return pattern;
}

/**
 * Whether `ref` was minted by a query chain OTHER than `ownChainId` — i.e. it is a
 * correlation to an enclosing query rather than something this builder owns.
 *
 * Alias identity alone cannot answer this. A subquery's own navigation aliases are its
 * relation NAMES, and a relation name may coincide with an outer table's alias: a child with
 * a `library` navigation, correlated against a parent table also called `library`. Resolving
 * such a ref by name makes the builder join a second, inner copy of the parent and bind the
 * correlation to it, which turns the predicate into a comparison of the inner row with
 * itself — true for every row, no SQL error, no type error. Singular table names
 * (`library` + `shelf.library`) produce that collision as a matter of course; the
 * plural-table/singular-navigation convention (`users` + `post.user`) hides it.
 *
 * The builder families stamp identity differently, and both are handled here:
 *
 * - `QueryBuilder` / `SelectQueryBuilder` / `GroupedQueryBuilder` carry their own chain id,
 *   so a ref is foreign when its id differs from `ownChainId`.
 * - `CollectionQueryBuilder` stamps nothing: the refs IT mints — plain columns under the
 *   `__collection_<table>__` marker AND navigation traversals under the relation name — all
 *   carry no id, while a reference to the enclosing row carries that query's id. Callers
 *   there pass `ownChainId: undefined`, for which "has an id at all" is exactly the right
 *   test. That is what lets `s.library.name` (inner navigation) be told apart from `l.name`
 *   (outer row) when both render under the alias `library`.
 *
 * A ref with no id is never foreign: paths that do not stamp identity keep their previous,
 * name-based treatment.
 */
export function isForeignChainRef(ref: any, ownChainId: number | undefined): boolean {
  if (ref?.__chainId == null) {
    return false;
  }

  return ownChainId == null || ref.__chainId !== ownChainId;
}

/**
 * Refuse a subquery that correlates to an outer table AND joins a navigation of its own under
 * the same alias.
 *
 * Both want one identifier in one scope. The inner join wins, so it shadows the outer table and
 * the correlation predicate silently rebinds to the inner row — true for every row, no SQL
 * error. There is no correct SQL to emit for this shape, so it is refused at build time; the
 * message names the alias and the three ways out.
 *
 * Shared by every builder that resolves aliases into joins, so `.groupBy()` and the collection
 * path cannot become quiet bypasses of a rule the standalone path enforces loudly.
 */
export function assertNoCorrelatedAliasShadowing(
  tableName: string,
  correlatedAliases: Iterable<string>,
  ownJoinAliases: ReadonlySet<string>
): void {
  for (const alias of correlatedAliases) {
    if (ownJoinAliases.has(alias)) {
      throw new Error(
        `Correlated subquery over table "${tableName}" both correlates to an outer "${alias}" and joins its own "${alias}" navigation. `
        + `Both would use the alias "${alias}", so the inner join would shadow the outer table and the correlation would silently bind to the inner row. `
        + `Traverse the navigation in the OUTER query, correlate on a plain key column instead of the navigation, or rename the navigation property.`
      );
    }
  }
}
