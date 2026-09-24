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
  direction: OrderDirection;
  /** `field` is an output alias of the projection (see parseOrderBy's `aliasOf`): render it as is. */
  aliased?: boolean;
}

/**
 * Whether an orderBy key is an SQL expression — a `sql` fragment or a condition (anything that
 * renders itself and reports the columns it reads) — rather than a column.
 */
export function isOrderByExpression(value: unknown): value is { buildSql(context: any): string; getFieldRefs(): FieldRef[] } {
  return value !== null
    && typeof value === 'object'
    && !hasFieldName(value)
    && typeof (value as any).buildSql === 'function'
    && typeof (value as any).getFieldRefs === 'function';
}

const ORDER_DIRECTIONS: ReadonlySet<string> = new Set([
  'ASC',
  'DESC',
  'ASC NULLS FIRST',
  'ASC NULLS LAST',
  'DESC NULLS FIRST',
  'DESC NULLS LAST',
]);

/**
 * The canonical form of a sort direction — `'desc'` → `'DESC'`, `' asc  nulls last '` →
 * `'ASC NULLS LAST'` — or `undefined` when `value` is not one.
 */
export function toOrderDirection(value: unknown): OrderDirection | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const canonical = value.trim().replace(/\s+/g, ' ').toUpperCase();

  return ORDER_DIRECTIONS.has(canonical) ? canonical as OrderDirection : undefined;
}

/** Why `value` cannot be an orderBy key, for the error that refuses it. */
function describeInvalidOrderByKey(value: unknown): string {
  if (typeof value === 'string') {
    return toOrderDirection(value) !== undefined
      ? `"${value}" is a sort direction, not a key: a direction goes in a [key, direction] pair — [[row.column, '${toOrderDirection(value)}']]`
      : `"${value}" is a string, not a key: a key is a column read off the row (row => row.name) or an SQL expression`;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return `${String(value)} is a number, not a key: ORDER BY position is not supported — name the column (row => row.name)`;
  }

  if (value === true) {
    return 'true is not a key: a key is a column read off the row or an SQL expression';
  }

  if (typeof value === 'function') {
    return 'a function is not a key: return the column itself (row => row.name), not a function';
  }

  return 'an object that is neither a column nor an SQL expression (a whole navigation row, or a nested object of the projection?) '
    + 'is not a key: order by one of its columns (row => row.book.name)';
}

/**
 * Calls `visit` for every key of an orderBy selector result, in order, with its direction.
 * Handles every form `orderBy` accepts:
 * 1. Single key: p => p.colName
 * 2. Array of keys (all ASC): p => [p.colName, p.otherCol]
 * 3. Array of [key, direction] pairs: p => [[p.colName, 'ASC'], [p.otherCol, 'DESC NULLS LAST']]
 * 4. One flat pair: p => [p.colName, 'DESC'] — its direction used to be skipped as a key (ASC)
 * 5. Pairs and keys mixed: p => [[p.colName, 'DESC'], p.otherCol]
 *
 * A key that is an SQL expression (`sql` fragment, condition, a collection's count / exists) goes to
 * `visitExpression`. `null`, `undefined` and `false` are "no key" (`flag && p.col`) and are skipped;
 * any other value — a string, a number, a navigation row — is refused, as is an expression where no
 * `visitExpression` is given, and a direction that is not `ASC` / `DESC` (optionally with
 * `NULLS FIRST` / `NULLS LAST`, any case). They all used to be dropped from the ORDER BY silently.
 */
export function forEachOrderByKey<T>(
  result: OrderByResult<T>,
  visit: (key: any, direction: OrderDirection) => void,
  visitExpression?: (expression: any, direction: OrderDirection) => void
): void {
  const one = (key: any, direction: OrderDirection): void => {
    if (key === null || key === undefined || key === false) {
      return;
    }

    if (hasFieldName(key)) {
      visit(key, direction);
      return;
    }

    if (isOrderByExpression(key)) {
      if (visitExpression === undefined) {
        throw new Error(
          'orderBy(): an SQL expression cannot be a key here — project it in select() and order by that field'
        );
      }

      visitExpression(key, direction);
      return;
    }

    throw new Error(`orderBy(): ${describeInvalidOrderByKey(key)}.`);
  };

  const pair = (entry: readonly unknown[]): void => {
    if (entry.length === 0 || entry.length > 2) {
      throw new Error(`orderBy(): a pair is [key, direction] — got an array of ${entry.length} values`);
    }

    const direction = entry.length === 2 && entry[1] !== undefined ? toOrderDirection(entry[1]) : 'ASC';

    if (direction === undefined) {
      throw new Error(
        `orderBy(): ${JSON.stringify(entry[1])} is not a sort direction — use 'ASC' or 'DESC', optionally with NULLS FIRST / NULLS LAST`
      );
    }

    one(entry[0], direction);
  };

  if (!Array.isArray(result)) {
    one(result, 'ASC');
    return;
  }

  // One flat [key, direction] pair
  if (result.length === 2 && !Array.isArray(result[0]) && toOrderDirection(result[1]) !== undefined) {
    pair(result);
    return;
  }

  for (const entry of result as unknown[]) {
    if (Array.isArray(entry)) {
      pair(entry);
    } else {
      one(entry, 'ASC');
    }
  }
}

/**
 * Parse orderBy selector result and populate orderByFields array (see {@link forEachOrderByKey}
 * for the accepted forms).
 *
 * `aliasOf` resolves a key the selector handed back from the projection itself — a grouped query's
 * aggregate or `sql` fragment — to its output alias; the key then orders by that alias. Without it
 * (or when it has no answer) a column key orders by its name, and an expression key is refused.
 */
export function parseOrderBy<T>(
  result: OrderByResult<T>,
  orderByFields: OrderByField[],
  getFieldName: (fieldRef: any) => string = defaultGetFieldName,
  getTable?: (fieldRef: any) => string | undefined,
  aliasOf?: (key: unknown) => string | undefined
): void {
  const push = (key: any, direction: OrderDirection, fieldName: string, aliased: boolean): void => {
    const field: OrderByField = { field: fieldName, direction };
    if (getTable) {
      field.table = getTable(key);
    }
    if (aliased) {
      field.aliased = true;
    }
    orderByFields.push(field);
  };

  forEachOrderByKey(
    result,
    (fieldRef, direction) => {
      const alias = aliasOf?.(fieldRef);
      push(fieldRef, direction, alias ?? getFieldName(fieldRef), alias !== undefined);
    },
    aliasOf === undefined
      ? undefined
      : (expression, direction) => {
        const alias = aliasOf(expression);

        if (alias === undefined) {
          throw new Error(
            'orderBy(): an SQL expression written inside orderBy() cannot be a key here — project it in select() and order by that field'
          );
        }

        push(expression, direction, alias, true);
      }
  );
}

/**
 * For a grouped query's `orderBy`: resolves an aggregate (`g.count()`, `g.max(...)`) or an SQL
 * expression the selector handed back from the projection to the output alias it is projected
 * under. An aggregate's own name is its FUNCTION (`count`, `max`), which is what ORDER BY used to
 * name — `column "count" does not exist` — and an expression used to be dropped from the ORDER BY
 * without a word.
 *
 * Plain column keys get no answer and keep ordering by their column — unless `columns` is set: a
 * grouped select orders a projected key column by its output alias too, which is the only name it
 * has over the subquery an expression grouping key reads from, and which never picks the wrong one of
 * two joined tables' same-named columns.
 */
export function projectedAliasOf(selection: unknown, options: { columns?: boolean } = {}): (key: unknown) => string | undefined {
  return (key: unknown): string | undefined => {
    if (key === null || typeof key !== 'object') {
      return undefined;
    }

    if (!('__isAggregate' in key || isOrderByExpression(key) || (options.columns === true && isFieldRef(key)))) {
      return undefined;
    }

    if (selection === null || typeof selection !== 'object') {
      return undefined;
    }

    for (const [alias, value] of Object.entries(selection)) {
      if (value === key) {
        return alias;
      }
    }

    return undefined;
  };
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
 * Every builder family carries a chain id, so a ref is foreign when its id differs from
 * `ownChainId`:
 *
 * - `QueryBuilder` / `SelectQueryBuilder` / `GroupedQueryBuilder` carry their own.
 * - `CollectionQueryBuilder` carries one too — shared by every builder derived from it
 *   (`select`, `selectMany`) — and stamps it on the rows it mints: plain columns under the
 *   `__collection_<table>__` marker AND navigation traversals under the relation name. That is
 *   what lets `s.library.name` (inner navigation) be told apart from `l.name` (outer row) when
 *   both render under the alias `library` — and from `line.book.genre` reached through an
 *   ENCLOSING collection's item. Collections used to stamp nothing and pass
 *   `ownChainId: undefined`, reading "has an id at all" as foreign; an enclosing collection's
 *   item was then as anonymous as the inner collection's own rows and passed for them.
 *
 * A builder without an id of its own (`ownChainId` undefined) treats every stamped ref as
 * foreign. A ref with no id is never foreign: paths that do not stamp identity keep their
 * previous, name-based treatment.
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
