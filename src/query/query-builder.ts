import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef, UnwrapSelection, and as andCondition, Placeholder, WhereConditionBase, castTo } from './conditions';
import { pgTypeOfValue, selectorProjectingConditions } from './sql-functions';
import { numericZeroScaleMapper } from '../types/custom-types';
import { collectionMarkerPattern } from './query-utils';
import { PreparedQuery } from './prepared-query';
import { TableSchema } from '../schema/table-builder';
import type { CollectionStrategyType, OrderDirection, OrderByResult, FluentDelete, FluentQueryUpdate } from '../entity/db-context';
import { TimeTracer, QueryExecutor } from '../entity/db-context';
import { assertNoCorrelatedAliasShadowing, forEachOrderByKey, getTableAlias, isForeignChainRef, parseOrderBy } from './query-utils';
import type { DatabaseClient, QueryResult } from '../database/database-client.interface';
import { Subquery } from './subquery';
import { GroupedQueryBuilder } from './grouped-query';
import { DbCte, isCte, projectedValueRef } from './cte-builder';
import { CollectionStrategyFactory } from './collection-strategy.factory';
import type { CollectionAggregationConfig, SelectedField, NavigationJoin } from './collection-strategy.interface';
import { UnionQueryBuilder } from './union-builder';
import { FutureQuery, FutureSingleQuery, FutureCountQuery, FutureBatchMeta } from './future-query';
import type { ColumnConfig } from '../schema/column-builder';
import { MockRowCache } from './mock-row-cache';
import { NavigationPathCache } from './navigation-path-cache';
import { formatJoinValue, isLiteralKeyPart, buildCollectionCorrelationWhere, NavigationAliasPlan, quoteTableReference } from './join-utils';
import type { NavigationPathNode } from './join-utils';

/**
 * Field type categories for optimized result transformation
 * const enum is inlined at compile time for zero runtime overhead
 */
const enum FieldType {
  NAVIGATION = 0,
  COLLECTION_SCALAR = 1,
  COLLECTION_ARRAY = 2,
  COLLECTION_JSON = 3,
  CTE_AGGREGATION = 4,
  SQL_FRAGMENT_MAPPER = 5,
  FIELD_REF_MAPPER = 6,
  FIELD_REF_NO_MAPPER = 7,
  SIMPLE = 8,
  COLLECTION_SINGLE = 9,  // firstOrDefault() - single item or null
  LITERAL = 10,           // a literal of the projection - reads back as itself
  NESTED = 11,            // a nested object or a navigation row - each of its values read its own way
}

/**
 * Whether a projection value is a literal — a string, a number, a boolean, `null`, a Date, a list of
 * values — rather than a column, an expression, a collection or a nested projection.
 */
const isProjectionLiteral = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') {
    return value !== undefined;
  }

  if (value instanceof Date) {
    return true;
  }

  return Array.isArray(value) && value.length > 0 && value.every(item => item === null || typeof item !== 'object' || item instanceof Date);
};

/**
 * Whether a selector returned ONE literal (`select(() => 'x')`, `select(() => 7)`, a Date, `null`)
 * rather than an object of fields: the query reads as that value on every row. A string used to be
 * walked as an object of its characters (`[{ "0": "x" }]`), a number projected no field at all.
 */
export const isScalarLiteralSelection = (selection: unknown): boolean =>
  selection === null
  || selection instanceof Date
  || (selection !== undefined && typeof selection !== 'object' && typeof selection !== 'function');

/**
 * A plain nested projection object (no markers) — the kind `tryBuildFlatNestedSelect` flattens. A
 * select-all row (the `u` of `where(...).select(u => ({ me: u }))`: its columns own properties, its
 * navigations inherited from a prototype of its own, see createSelectAllRow) is one too: it was
 * flattened into columns and then read back unmapped, or — nested deeper — bound as a parameter.
 */
const isPlainNestedProjection = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return (proto === Object.prototype || proto === null || (value as any).constructor === Object)
    && !('__dbColumnName' in value)
    && !('__collectionResult' in value)
    && !('__isAggregationArray' in value);
};

/** How one key of a `withAggregation` CTE's item reads back (see aggregatedItemReads). */
interface AggregatedItemRead {
  /** A column's / an expression's mapper */
  mapper?: { fromDriver(value: any): any };
  /** A literal of the aggregated projection: read back as itself (its JSON form: a Date as text) */
  literal?: boolean;
  value?: unknown;
  /** A nested object (a navigation row): the reads of its own keys */
  nested?: Record<string, AggregatedItemRead>;
}

/** The read of one value of an aggregated projection, `undefined` when it reads as JSON delivers it. */
const aggregatedItemRead = (value: unknown): AggregatedItemRead | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== 'object' || value instanceof Date || (Array.isArray(value) && !holdsSqlValue(value))) {
    return { literal: true, value };
  }

  const fields = materializeMockSelection(value);

  if (isPlainNestedProjection(fields)) {
    const nested = aggregatedItemReads(fields);

    return nested === undefined ? undefined : { nested };
  }

  const meta = value as any;
  const mapper = fromDriverMapper(meta.__mapper)
    ?? (typeof meta.getMapper === 'function' ? fromDriverMapper(meta.getMapper()) : undefined);

  return mapper === undefined ? undefined : { mapper };
};

/**
 * How each key of a `withAggregation` CTE's items reads back: through the aggregated query's OWN
 * mappers — a column's (`__mapper`), an expression's `mapWith` — a literal as itself, a nested
 * object key by key. The mappers used to be looked up by NAME among the columns of the table reading
 * the CTE: another table's mapper, or none at all. `undefined` when every key reads as delivered.
 * @internal
 */
export const aggregatedItemReads = (innerMetadata: Record<string, any> | undefined): Record<string, AggregatedItemRead> | undefined => {
  let reads: Record<string, AggregatedItemRead> | undefined;

  for (const key in innerMetadata) {
    const read = aggregatedItemRead(innerMetadata[key]);

    if (read !== undefined) {
      (reads ??= {})[key] = read;
    }
  }

  return reads;
};

/** One aggregated item (or a nested object of one) read as `reads` says. */
const readAggregatedItem = (item: any, reads: Record<string, AggregatedItemRead>): any => {
  if (item === null || typeof item !== 'object') {
    return item;
  }

  const transformedItem: any = {};

  for (const key in item) {
    const read = reads[key];
    const value = item[key];

    // Mappers handle null internally (mapWith wraps user functions)
    transformedItem[key] = read === undefined
      ? value
      : read.literal
        ? read.value
        : read.mapper !== undefined
          ? read.mapper.fromDriver(value)
          : readAggregatedItem(value, read.nested!);
  }

  return transformedItem;
};

/** Reads a `withAggregation` CTE's items (see aggregatedItemReads). @internal */
export const mapAggregatedItems = (items: any[], reads: Record<string, AggregatedItemRead>): any[] => {
  // Transform items using while(i--) loop - decrement and compare to 0 is fastest
  const results: any[] = new Array(items.length);
  let i = items.length;

  while (i--) {
    results[i] = readAggregatedItem(items[i], reads);
  }

  return results;
};

/**
 * Performance utility: Get column name map from schema, using cached version if available
 */
export function getColumnNameMapForSchema(schema: TableSchema): Map<string, string> {
  if (schema.columnNameMap) {
    return schema.columnNameMap;
  }
  // Fallback: build the map (for schemas that weren't built with the new TableBuilder)
  const map = new Map<string, string>();
  for (const [colName, colBuilder] of Object.entries(schema.columns)) {
    map.set(colName, (colBuilder as any).build().name);
  }
  return map;
}

/**
 * Performance utility: Get relation entries array from schema, using cached version if available
 */
export function getRelationEntriesForSchema(schema: TableSchema): Array<[string, any]> {
  if (schema.relationEntries) {
    return schema.relationEntries;
  }
  // Fallback: build the array (for schemas that weren't built with the new TableBuilder)
  return Object.entries(schema.relations);
}

/**
 * Performance utility: per-schema column metadata (mapper + SQL type), computed once per
 * schema object. `_createMockRow` and the collection mock-item builder both used to call
 * `colBuilder.build()` for EVERY column on EVERY query build — pure waste for an immutable
 * schema. WeakMap keyed by schema identity so schemas can be garbage-collected with their
 * DbContext.
 */
const schemaColumnMetaCache = new WeakMap<TableSchema, Map<string, { mapper?: any; type?: string; name?: string; primaryKey?: boolean }>>();

export function getSchemaColumnMeta(schema: TableSchema): Map<string, { mapper?: any; type?: string; name?: string; primaryKey?: boolean }> {
  let meta = schemaColumnMetaCache.get(schema);

  if (meta == null) {
    meta = new Map();

    for (const [colName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      meta.set(colName, { mapper: config.mapper, type: config.type, name: config.name, primaryKey: config.primaryKey });
    }

    schemaColumnMetaCache.set(schema, meta);
  }

  return meta;
}

/**
 * Reverse of the column-name map — db column name → property name — cached per schema.
 * An ordered collection needs it on every build to render the alias form of its ORDER BY;
 * rebuilding it walked every column of the schema per build.
 */
const schemaDbToPropertyMapCache = new WeakMap<TableSchema, Map<string, string>>();

export function getDbToPropertyMapForSchema(schema: TableSchema): Map<string, string> {
  let map = schemaDbToPropertyMapCache.get(schema);

  if (map == null) {
    map = new Map();

    for (const [propName, meta] of getSchemaColumnMeta(schema)) {
      map.set(meta.name!, propName);
    }

    schemaDbToPropertyMapCache.set(schema, map);
  }

  return map;
}

/**
 * Mock-row descriptor cache for {@link ReferenceQueryBuilder.createMockTargetRow}.
 *
 * Building a reference mock row costs O(columns + relations) `Object.defineProperty`
 * calls plus fresh closures per row — and deep selectors (cart → items → product →
 * price → …) rebuild that graph from scratch on EVERY query build. All of it is
 * deterministic in (target schema, relation alias, navigation path), so the property
 * descriptors are built once per signature and reused: each new mock row is a bare
 * object + one `Object.defineProperties` call with the shared descriptor map.
 *
 * Per-instance state (the lazy FieldRef cache and the memoized navigation rows)
 * lives in symbol-keyed slots read by the shared getters through `this`, so sharing
 * descriptors across rows is safe. The navigation-path arrays captured at build
 * time are shared by content — nothing downstream mutates them (they are always
 * spread-copied when extended).
 */
const MOCK_ROW_FIELD_REFS = Symbol('linkgressMockFieldRefs');
const MOCK_ROW_NAV_CACHE = Symbol('linkgressMockNavCache');
const MOCK_ROW_CHAIN_ID = Symbol('linkgressMockChainId');

type MockRowSlots = {
  [MOCK_ROW_FIELD_REFS]?: Record<string, any>;
  [MOCK_ROW_NAV_CACHE]?: Record<string, any>;
  [MOCK_ROW_CHAIN_ID]?: string | number;
};

const navigationPathSignature = (path: NavigationJoin[]): string => path
  .map(step => `${step.alias}:${step.targetTable}:${(step.foreignKeys ?? []).join('+')}:${(step.matches ?? []).join('+')}:${step.isMandatory ? 1 : 0}:${step.sourceAlias ?? ''}`)
  .join('>');

/**
 * A reference mock row: `Object.create(prototype)` plus its own state slots.
 *
 * `chainId` is the identity of the row this navigation hangs off, and it is propagated so the
 * field refs minted from the nav row answer "which query do I belong to?" the same way a plain
 * column ref does. Without it a navigation ref is anonymous, and an outer correlation written
 * THROUGH a navigation (`l.city!.name`) is indistinguishable from the inner table's own
 * navigation of the same name — which is precisely the misbinding isForeignChainRef exists to
 * catch. Undefined stays undefined: a row minted outside any chain stays anonymous and keeps
 * the name-based treatment isForeignChainRef gives such refs.
 */
const mintReferenceMockRow = (prototype: object, chainId?: string | number): any => {
  const mock: any = Object.create(prototype);
  mock[MOCK_ROW_FIELD_REFS] = {};
  mock[MOCK_ROW_NAV_CACHE] = {};
  mock[MOCK_ROW_CHAIN_ID] = chainId;

  return mock;
};

/**
 * Per-getter memo of the prototype a reference navigation's mock rows share.
 *
 * The per-row navigation slot (MOCK_ROW_NAV_CACHE) makes repeated reads of `p.user` on one row
 * free; the FIRST read on every row still constructed a `ReferenceQueryBuilder`, concatenated
 * its MockRowCache key (navigation-path signature included) and looked the prototype up — a
 * fresh, unhashed string per row. One holder lives in each reference-getter closure, and that
 * closure is itself per (schema, relation, navigation path) — exactly the cache signature — so
 * once filled, minting a row is one property read plus `Object.create`: no builder, no key, no
 * lookup. Filled only while the switch is on and read only while it is on, so switching it off
 * still yields a fresh prototype per row, as before.
 */
type MockPrototypeHolder = { prototype?: object };

/**
 * Whether `value` is a mock row minted by the query builders (`createMockTargetRow`,
 * `SelectQueryBuilder._createMockRow`, `CollectionQueryBuilder.createMockItem`). Every
 * such row INHERITS its column/relation getters from a shared prototype (see MockRowCache),
 * so `Object.getPrototypeOf(row) !== Object.prototype` and own-property APIs (`Object.keys`,
 * `{...row}`) see no columns — the row's own state slots are the reliable marker. Callers
 * must treat a mock row like the plain-object mock it replaced (walk it for revivals,
 * read properties directly) but never enumerate it with own-property APIs.
 */
const isReferenceMockRow = (value: unknown): boolean =>
  value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, MOCK_ROW_FIELD_REFS);

/** `Object.getOwnPropertyDescriptor` that walks the prototype chain (stops before Object.prototype). */
const findPropertyDescriptor = (value: object, key: string): PropertyDescriptor | undefined => {
  let current: object | null = value;

  while (current != null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);

    if (descriptor) {
      return descriptor;
    }

    current = Object.getPrototypeOf(current);
  }

  return undefined;
};

/**
 * Materializes a selector RESULT that is itself a mock row (identity selectors like
 * `.select(p => p)` or `(l, r) => l`): such rows inherit their columns from the shared
 * prototype, so own-property walkers (`Object.entries` / `keys` / `values`) would see
 * NOTHING and silently project zero columns. Reading every enumerable column getter
 * once into a plain object restores exactly what the pre-prototype mocks exposed (their
 * own enumerable getters) — non-enumerable relation getters stay out, as before. No-op
 * for every other result shape (FieldRef, SqlFragment, builder, plain object, array).
 */
export const materializeMockSelection = (result: any): any => {
  if (!isReferenceMockRow(result)) {
    return result;
  }

  const out: any = {};

  for (const key in result) {
    if (findPropertyDescriptor(result, key)?.get != null) {
      out[key] = result[key];
    }
  }

  return out;
};

/**
 * One ORDER BY key of a root query (`SelectQueryBuilder` / `QueryBuilder`). `field` names the key
 * the way the projection it was written against named it: an output alias, or a column name.
 */
interface RootOrderByField {
  field: string;
  direction: OrderDirection;
  /**
   * The ordered column's own ref. The key renders as the output alias `field` only while the
   * projection being built still selects this very column under that alias; otherwise — a column
   * read through a navigation row, a nested object's leaf, or a key a later `select()` renamed or
   * dropped — it renders as the qualified column, and a navigation it reads is joined like a
   * projected one. Keys that are not columns (a projected `sql` fragment, a literal) have no ref.
   */
  ref?: FieldRef;
  /** `field` is the flattened output alias of a nested object's leaf: `__nested__<key>__<leaf>`. */
  nestedAlias?: boolean;
  /**
   * A key that is an SQL expression — a `sql` fragment, a condition, a `count()` / `exists()` over a
   * collection — rendered (parenthesized) in the query's parameter sequence; its columns are joined
   * like projected ones. `field` is empty. Such keys used to be dropped from the ORDER BY silently.
   */
  expression?: Condition;
}

/** What {@link SelectQueryBuilder.createOrderByProxy} attaches to the keys it hands out. */
const ORDER_KEY = Symbol('linkgress.orderKey');

interface OrderKeyMeta {
  ref?: FieldRef;
  nested: boolean;
  /** The output alias the key names (a nested leaf's flattened alias). */
  alias: string;
}

/** The ORDER BY key of an `orderBy` selector's result entry (see createOrderByProxy). */
const rootOrderByFieldOf = (key: any, direction: OrderDirection): RootOrderByField => {
  const meta: OrderKeyMeta | undefined = key[ORDER_KEY];

  if (meta === undefined) {
    // A column read through a navigation row IS its ref
    return { field: key.__dbColumnName ?? key.__fieldName, direction, ref: key };
  }

  const entry: RootOrderByField = { field: meta.alias, direction };

  if (meta.ref !== undefined) {
    entry.ref = meta.ref;
  }

  if (meta.nested) {
    entry.nestedAlias = true;
  }

  return entry;
};

/** The column an expression key's ref stands for: a projected column's key (see createOrderByProxy) stands for its column. */
const orderKeyColumnRef = (ref: any): FieldRef => (ref?.[ORDER_KEY] as OrderKeyMeta | undefined)?.ref ?? ref;

/** The parenthesized SQL of an ORDER BY expression key, built in `context`'s parameter sequence. */
const buildOrderByExpressionSql = (
  expression: Condition,
  context: { paramCounter: number; allParams: any[]; placeholders?: Map<string, number>; hoistedCteNames?: Set<string> },
  lateralTableAliasMap?: Map<string, string>,
  localParams?: any[]
): string => {
  const { sql, params, placeholders, paramCounter } = new ConditionBuilder().build(
    expression,
    context.paramCounter,
    context.placeholders,
    context.hoistedCteNames,
    lateralTableAliasMap
  );
  context.paramCounter = paramCounter;
  context.allParams.push(...params);
  localParams?.push(...params);

  if (placeholders) {
    context.placeholders = placeholders;
  }

  return `(${sql})`;
};

/**
 * The value a scalar collection aggregate (`count()`, `min()`, `max()`, `sum()`, `exists()`) reads
 * back as, the way a SELECT reads it (see transformResults): a numeric string (a bigint COUNT / SUM)
 * as a number, NULL as null. A RETURNING that projected one used to hand back the driver's string.
 */
export const scalarCollectionValue = (aggregationType: string | undefined, rawValue: unknown): unknown => {
  if (rawValue === null || rawValue === undefined) {
    return aggregationType === 'COUNT' ? 0 : aggregationType === 'EXISTS' ? false : null;
  }

  return typeof rawValue === 'string' && aggregationType !== 'EXISTS' && NUMERIC_REGEX.test(rawValue) ? +rawValue : rawValue;
};

/** Whether the projected `value` is the column `ref` names: same column, same table alias, same path. */
const isSameColumnRef = (value: any, ref: any): boolean => {
  if (value === ref) {
    return true;
  }

  if (!value || typeof value !== 'object' || !('__dbColumnName' in value) || value.__dbColumnName !== ref.__dbColumnName) {
    return false;
  }

  if ((value.__tableAlias ?? '') !== (ref.__tableAlias ?? '')) {
    return false;
  }

  const left: readonly string[] = Array.isArray(value.__navigationAliases) ? value.__navigationAliases : [];
  const right: readonly string[] = Array.isArray(ref.__navigationAliases) ? ref.__navigationAliases : [];

  return left.length === right.length && left.every((alias, index) => alias === right[index]);
};

/**
 * The alias of a reference navigation reached from a MANUALLY joined table: `<parent alias>__<relation>`
 * (`posts_0__user`, `posts_0__user__profile`). Such a hop cannot render under its relation name — that
 * name is resolved against the ROOT's relations and binds to the root's navigation of the same name.
 * PostgreSQL truncates an identifier past 63 bytes, and two truncated aliases can collide, so a longer
 * one is refused rather than emitted.
 */
export const explicitNavigationAlias = (parentAlias: string, relationName: string): string => {
  const alias = `${parentAlias}__${relationName}`;
  let bytes = 0;

  for (const char of alias) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }

  if (bytes > 63) {
    throw new Error(
      `The navigation "${relationName}" of the joined "${parentAlias}" would render as "${alias}", longer than `
      + `PostgreSQL's 63-byte identifier limit. Join that table explicitly instead of navigating to it.`
    );
  }

  return alias;
};

/**
 * The `joins` entries added from an explicit join path. By-name resolution (resolveJoinsForTableAliases)
 * must never search their schemas: a ROOT chain's next hop (`comment.order.user`) would otherwise bind to
 * whichever joined table's navigation target happens to have a relation of that name.
 */
const explicitJoinEntries = new WeakSet<object>();

/**
 * Appends the hops of an explicit join path (a `__joinPath`, or a collection's navigation path that
 * starts at a manually joined table) to `joins`, parent hop first, skipping hops already there.
 */
const addExplicitJoinPath = (
  path: NavigationJoin[] | undefined,
  joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
): void => {
  if (!Array.isArray(path)) {
    return;
  }

  for (const hop of path) {
    if (!joins.some(join => join.alias === hop.alias)) {
      const entry = {
        alias: hop.alias,
        targetTable: hop.targetTable,
        targetSchema: hop.targetSchema,
        foreignKeys: hop.foreignKeys,
        matches: hop.matches,
        isMandatory: hop.isMandatory,
        sourceAlias: hop.sourceAlias,
      };
      explicitJoinEntries.add(entry);
      joins.push(entry);
    }
  }
};

/**
 * The mock row of a MANUALLY joined table (`leftJoin` / `innerJoin` on a table), under the join's
 * alias. The table's NAME is not in the FROM clause — only the alias is — so its collections
 * correlate to the alias, and its reference navigations hang off it under explicit aliases whose
 * refs carry their join path (see explicitNavigationAlias). The schema registry is what gives a
 * navigation's target its own relations, so a chain (`orderTask.task.level.createdBy`) can go on.
 */
export const createJoinedTableMockRow = (
  schema: TableSchema,
  alias: string,
  schemaRegistry: Map<string, TableSchema> | undefined
): any => {
  const mock: any = {};

  // Performance: Use pre-computed column name map if available
  const columnNameMap = getColumnNameMapForSchema(schema);

  // Performance: Lazy-cache FieldRef objects
  const fieldRefCache: Record<string, any> = {};

  // Add columns as FieldRef objects with table alias
  for (const [colName, dbColumnName] of columnNameMap) {
    Object.defineProperty(mock, colName, {
      get() {
        let cached = fieldRefCache[colName];
        if (!cached) {
          cached = fieldRefCache[colName] = {
            __fieldName: colName,
            __dbColumnName: dbColumnName,
            __tableAlias: alias,
          };
        }
        return cached;
      },
      enumerable: true,
      configurable: true,
    });
  }

  // Add navigation properties (single references and collections)
  for (const [relName, relConfig] of getRelationEntriesForSchema(schema)) {
    const targetSchema = getTargetSchemaForRelation(schema, relName, relConfig);

    if (relConfig.type === 'many') {
      // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
      Object.defineProperty(mock, relName, {
        get: () => new CollectionQueryBuilder(
          relName,
          relConfig.targetTable,
          relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
          alias,
          targetSchema,
          schemaRegistry,
          undefined,
          relConfig.foreignKeys,  // Propagate composite FK / literal predicates
          relConfig.matches
        ),
        enumerable: false,
        configurable: true,
      });
    } else {
      // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
      Object.defineProperty(mock, relName, {
        get(this: any) {
          // One mock target row per row and relation (a selector reading `p.user.*` several
          // times used to mint a builder and a row per access)
          const slots: MockRowSlots = this;
          const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
          const cachedRow = navCache[relName];
          if (cachedRow !== undefined) {
            return cachedRow;
          }
          const refBuilder = new ReferenceQueryBuilder(
            relName,
            relConfig.targetTable,
            relConfig.foreignKeys || [relConfig.foreignKey || ''],
            relConfig.matches || [],
            relConfig.isMandatory ?? false,
            targetSchema,
            schemaRegistry,
            [],
            alias,
            explicitNavigationAlias(alias, relName)
          );
          return (navCache[relName] = refBuilder.createMockTargetRow(undefined, slots[MOCK_ROW_CHAIN_ID]));
        },
        enumerable: false,
        configurable: true,
      });
    }
  }

  return mock;
};

/**
 * First enumerable key (own or inherited) backed by a getter — the "is this a mock row" probe
 * shared by the selection resolvers. All mock rows (root, collection-item, reference)
 * inherit their getters from a shared prototype; column getters are enumerable, so the first
 * enumerable getter is always a column and `row[key]` yields its FieldRef.
 */
const findFirstGetterKey = (value: object): string | undefined => {
  for (const key in value) {
    if (findPropertyDescriptor(value, key)?.get != null) {
      return key;
    }
  }

  return undefined;
};

/**
 * Performance utility: Get target schema for a relation, using cached version if available
 */
export function getTargetSchemaForRelation(schema: TableSchema, relName: string, relConfig: { targetTableBuilder?: { build(): TableSchema } }): TableSchema | undefined {
  // Try cached version first
  if (schema.relationSchemaCache) {
    const cached = schema.relationSchemaCache.get(relName);
    if (cached) return cached;
  }
  // Fallback: build the schema
  if (relConfig.targetTableBuilder) {
    return relConfig.targetTableBuilder.build();
  }
  return undefined;
}

// Performance: Cache nested field ref proxies per table alias
const nestedFieldRefProxyCache = new Map<string, any>();

/**
 * Creates a nested proxy that supports accessing properties at any depth.
 * This allows patterns like `p.product.priceMode` to work even without full schema information.
 * Each property access returns an object that is both a FieldRef and can be further accessed.
 *
 * @param tableAlias The table alias to use for the FieldRef
 * @returns A proxy that creates FieldRefs for any property access
 */
export function createNestedFieldRefProxy(tableAlias: string): any {
  // Return cached proxy if available
  const cached = nestedFieldRefProxyCache.get(tableAlias);
  if (cached) return cached;

  const handler: ProxyHandler<any> = {
    get: (_target: any, prop: string | symbol) => {
      // Handle Symbol.toPrimitive for string conversion (used in template literals)
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => `[NestedFieldRefProxy:${tableAlias}]`;
      }
      if (typeof prop === 'symbol') return undefined;
      // Return an object that is both a FieldRef AND a proxy for further nesting
      const fieldRef = {
        __fieldName: prop,
        __dbColumnName: prop,
        __tableAlias: tableAlias,
      };
      // Return a proxy that acts as both the FieldRef and allows further property access
      return new Proxy(fieldRef, {
        get: (fieldTarget: any, nestedProp: string | symbol) => {
          // Handle Symbol.toPrimitive for string conversion (used in template literals)
          if (nestedProp === Symbol.toPrimitive || nestedProp === 'toString' || nestedProp === 'valueOf') {
            return () => fieldTarget.__dbColumnName;
          }
          if (typeof nestedProp === 'symbol') return undefined;
          // If accessing FieldRef properties, return them
          if (nestedProp === '__fieldName' || nestedProp === '__dbColumnName' || nestedProp === '__tableAlias') {
            return fieldTarget[nestedProp];
          }
          // Otherwise, treat as nested navigation and create a new nested proxy
          // The nested table alias is the property name (e.g., 'product' for p.product)
          return createNestedFieldRefProxy(prop as string)[nestedProp];
        },
        has: (_fieldTarget, _nestedProp) => true,
      });
    },
    has: (_target, prop) => {
      // The outer proxy doesn't have FieldRef properties - only field names
      if (prop === '__fieldName' || prop === '__dbColumnName' || prop === '__tableAlias') {
        return false;
      }
      return true;
    },
  };
  const proxy = new Proxy({}, handler);
  nestedFieldRefProxyCache.set(tableAlias, proxy);
  return proxy;
}

/**
 * Join type
 */
export type JoinType = 'INNER' | 'LEFT';

/**
 * Manual join definition
 */
export interface ManualJoinDefinition {
  type: JoinType;
  table: string;
  alias: string;
  schema: TableSchema;
  condition: Condition;
  cte?: DbCte<any>;  // Optional CTE reference if joining with a CTE
}

/**
 * Query context for tracking CTEs and aliases
 */
export interface QueryContext {
  ctes: Map<string, { sql: string; params: any[] }>;
  cteCounter: number;
  paramCounter: number;
  allParams: any[];
  collectionStrategy?: CollectionStrategyType;
  executor?: QueryExecutor;
  /** Map of placeholder names to their parameter indices (for prepared statements) */
  placeholders?: Map<string, number>;
  /**
   * Map of original table names to their LATERAL aliases.
   * Used by nested LATERALs to reference parent collection tables correctly.
   * Example: { "posts": "lateral_0_posts" }
   */
  lateralTableAliasMap?: Map<string, string>;
  /**
   * True when the driver cannot decode native ARRAY result columns
   * (BunClient) — array-producing aggregations must use json_agg.
   */
  useJsonArrayAggregation?: boolean;
  /**
   * Names of CTEs an enclosing builder has already declared at statement level
   * (see {@link SqlBuildContext.hoistedCteNames}). Attached CTEs whose name is
   * listed here contribute neither params nor a `WITH` entry from this builder.
   */
  hoistedCteNames?: Set<string>;
  /**
   * Render the projection's literals typed from their JS type — set for a projection other queries
   * read as columns (a CTE body, a table subquery). See {@link SqlBuildContext.typedLiterals}.
   */
  typedLiterals?: boolean;
}

/**
 * A literal of a projection as SQL, its parameter appended to `context`: `$n`, or — when the
 * projection is read by another query as columns (`context.typedLiterals`) — typed from its JS type
 * (`CAST($n AS boolean)`, a timestamptz for a Date, jsonb for a list of values). `null` is `NULL`.
 * @internal
 */
export function projectionLiteralSql(value: unknown, context: { paramCounter: number; allParams: any[]; typedLiterals?: boolean }): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const pgType = context.typedLiterals ? pgTypeOfValue(value) : undefined;

  if (pgType === undefined) {
    context.allParams.push(value);
    return `$${context.paramCounter++}`;
  }

  const buildContext: SqlBuildContext = { paramCounter: context.paramCounter, params: context.allParams };
  const sqlText = castTo(value, pgType).buildSql(buildContext);
  context.paramCounter = buildContext.paramCounter;

  return sqlText;
}

/**
 * Whether a value holds a column, an expression or a collection anywhere in it (an array, a plain
 * object) — no single SQL value to project for it as a literal. @internal
 */
export function holdsSqlValue(value: unknown, depth: number = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 16) {
    return false;
  }

  // A row (a navigation row, the root row) is a row of columns
  if ('__dbColumnName' in value || value instanceof WhereConditionBase || value instanceof CollectionQueryBuilder
    || value instanceof Subquery || '__collectionResult' in value || isReferenceMockRow(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(item => holdsSqlValue(item, depth + 1));
  }

  // A plain object — a select-all row's own columns included (see isPlainNestedProjection)
  const proto = Object.getPrototypeOf(value);

  return (proto === Object.prototype || proto === null || (value as any).constructor === Object)
    && Object.values(value).some(item => holdsSqlValue(item, depth + 1));
}

/** Refuses a projected array that holds columns or expressions (see {@link holdsSqlValue}). @internal */
export function assertProjectionArrayOfValues(value: unknown, path: string, where: string): void {
  if (Array.isArray(value) && holdsSqlValue(value)) {
    throw new Error(
      `${where}: "${path}" is an array of columns or expressions, which has no single SQL value to select — `
      + 'select them as an object, or build the array in SQL (sql`ARRAY[...]`, jsonbBuildArray(...))'
    );
  }
}

/**
 * A mock row of a CTE's columns: a proxy handing out, for each column, the ref that carries how it
 * reads — its own mapper, a json_agg column's inner metadata, a literal's type, a nested object's
 * flattened columns (see DbCte.columnRef).
 * @internal
 */
export function createCteMockRow<TCteColumns extends Record<string, any>>(cte: DbCte<TCteColumns>): TCteColumns {
  return new Proxy({} as any, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined;

      return cte.columnRef(prop);
    },
    has() {
      return true;
    },
    ownKeys() {
      return cte.columnDefs ? Object.keys(cte.columnDefs) : [];
    },
    getOwnPropertyDescriptor() {
      return {
        enumerable: true,
        configurable: true,
      };
    }
  }) as TCteColumns;
}

/**
 * Selection definition
 */
type SelectionDef = {
  [key: string]: any;
};

/**
 * Cached regex for numeric string detection
 * Used to convert PostgreSQL NUMERIC/BIGINT strings to numbers
 */
const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;

/** SQL types whose values a numeric string read back for them stands for (a numeric, an int8). */
const NUMERIC_SQL_TYPE_REGEX = /^\s*(smallint|integer|int|int2|int4|int8|bigint|smallserial|serial|serial4|bigserial|serial8|decimal|numeric|real|float4|float8|double precision|money)\b/i;

/**
 * Whether a value read back for a column of `sqlType` turns from a numeric string into a number:
 * for a numeric type, and for a value of unknown type (an expression). Never for a text, uuid, enum
 * or json column: '01234' is a name there, not the number 1234.
 */
export const coercesNumericText = (sqlType: unknown): boolean =>
  typeof sqlType !== 'string' || NUMERIC_SQL_TYPE_REGEX.test(sqlType);

/**
 * How a bigint literal a CTE body (or a subquery) projected reads back through the reading query:
 * the driver may hand its int8 column back as text or as a number — it is the bigint it was.
 * @internal
 */
export const BIGINT_LITERAL_READ = {
  fromDriver: (value: unknown): unknown =>
    value === null || value === undefined || typeof value === 'bigint' ? value : BigInt(value as string | number),
};

/** A column mapper normalized to the object that has `fromDriver` (a custom type builder unwrapped). */
export const fromDriverMapper = (mapper: any): any | undefined => {
  const type = mapper && typeof mapper.getType === 'function' ? mapper.getType() : mapper;

  return type && typeof type.fromDriver === 'function' ? type : undefined;
};

/**
 * How one value of a projection reads back from the column (or JSON value) delivered for it —
 * compiled once per query by `SelectQueryBuilder.compileFieldRead`, applied per row.
 */
interface FieldRead {
  key: string;
  type: FieldType;
  value: any;
  mapper?: any;
  aggregationType?: string;
  collectionBuilder?: CollectionQueryBuilder<any>;
  /** SIMPLE: a numeric string becomes a number (not for a text column, see coercesNumericText) */
  coerce?: boolean;
  /** SIMPLE: NULL stays null — a nested object's value — instead of reading as undefined */
  keepNull?: boolean;
  /** NESTED: the reads of the nested object's own values */
  children?: FieldRead[];
  /** CTE_AGGREGATION: the mapper of each aggregated item's key */
  itemReads?: Record<string, any>;
}

/**
 * Query builder for a table
 */
/**
 * Monotonic sequence for query-chain identities. Every root builder gets a fresh id and
 * derived builders inherit it, so every field ref can say which query it belongs to — which is
 * what lets a subquery tell its OWN refs from ones leaking in from an OUTER chain (see
 * isForeignChainRef).
 *
 * Navigation rows inherit the id of the row they hang off (`mintReferenceMockRow`), so
 * `outer.nav.col` carries the OUTER chain while `inner.nav.col` carries the inner one even
 * when both render under the same alias. That propagation is load-bearing: without it a
 * correlation written through a navigation is anonymous and indistinguishable from the inner
 * table's own navigation of the same name.
 *
 * `CollectionQueryBuilder` carries one too and stamps it on its item rows. It used to stamp
 * nothing, reading "carries an id at all" as the mark of a correlation — which holds only while
 * every enclosing query is a stamped one. Inside another COLLECTION the enclosing item was as
 * anonymous as the inner collection's own rows, so a correlation written through it passed for
 * the inner collection's own navigation.
 */
let chainIdSeq = 0;

export class QueryBuilder<TSchema extends TableSchema, TRow = any> {
  /** @internal Chain identity — see chainIdSeq. */
  public chainId: number = ++chainIdSeq;
  private schema: TSchema;
  private client: DatabaseClient;
  private whereCond?: Condition;
  private selection?: (row: any) => SelectionDef;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: RootOrderByField[] = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private collectionStrategy?: CollectionStrategyType;
  private schemaRegistry?: Map<string, TableSchema>;

  // Performance: Cache the mock row to avoid recreating it
  private _cachedMockRow?: any;

  constructor(schema: TSchema, client: DatabaseClient, whereCond?: Condition, limit?: number, offset?: number, orderBy?: RootOrderByField[], executor?: QueryExecutor, manualJoins?: ManualJoinDefinition[], joinCounter?: number, collectionStrategy?: CollectionStrategyType, schemaRegistry?: Map<string, TableSchema>) {
    this.schema = schema;
    this.client = client;
    this.whereCond = whereCond;
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.collectionStrategy = collectionStrategy;
    this.schemaRegistry = schemaRegistry;
  }

  /**
   * Override the timeout for this single query (in milliseconds). Only this query
   * is wrapped (`SET LOCAL statement_timeout` inside a short transaction) — other
   * queries are unaffected. Overrides the connection-level default; pass `0` to
   * disable the timeout for this query. On timeout a `QueryTimeoutError` is thrown.
   *
   * @example
   * await db.users.where(u => gt(u.id, 0)).withTimeout(5000).select(...).toList();
   */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires — the query is
   * NOT cancelled (use `.withTimeout()` for that). Overrides the context's
   * `longRunningQueryThreshold` for this query.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
  }

  /**
   * Run THIS query as a named server-side prepared statement (`true`) or as an unnamed
   * statement (`false`), overriding the context's `preparedStatements` default — the
   * query-builder counterpart of `DbEntityTable.withPreparedStatements`, for code that
   * receives an already-built query (a paginated-grid helper, for instance).
   *
   * An unnamed statement leaves NO parse tree and NO plan in the connection's cache. That is
   * the right choice for statements whose text varies with the request — paging offsets,
   * sort columns, filter combinations — on paths that run a few times a minute: every
   * distinct text of a prepared statement is a cached plan in every pooled connection.
   *
   * @example
   * await db.orders.where(o => eq(o.status, status)).orderBy(o => o.createdAt).limit(25).offset(250)
   *   .withPreparedStatements(false).toList();
   */
  withPreparedStatements(prepare: boolean): this {
    this.executor = this.executor
      ? this.executor.withPreparedStatements(prepare)
      : new QueryExecutor(this.client, undefined, undefined, undefined, prepare);
    return this;
  }

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  /**
   * Define the selection with support for nested queries
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TSelection>(selector: (row: TRow) => TSelection): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    return new SelectQueryBuilder(
      this.schema,
      this.client,
      selector as any,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      false,  // isDistinct defaults to false
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      [],  // ctes - start with empty array
      this.collectionStrategy,
      this.chainId
    );
  }

  /**
   * Add WHERE condition
   * Multiple where() calls are chained with AND logic
   */
  where(condition: (row: TRow) => Condition): this {
    const mockRow = this._createMockRow();
    const newCondition = condition(mockRow);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: DbCte<any>[]): SelectQueryBuilder<TRow> {
    return new SelectQueryBuilder(
      this.schema,
      this.client,
      (row: any) => row,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      false,
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      ctes,
      this.collectionStrategy,
      this.chainId
    );
  }

  /**
   * Create mock row for analysis
   * @internal - Also used by DbEntityTable.props() to avoid code duplication
   */
  _createMockRow(): any {
    // Performance: Return cached mock if available
    if (this._cachedMockRow) {
      return this._cachedMockRow;
    }

    // Prototype-level cache — same pattern as ReferenceQueryBuilder.createMockTargetRow
    // (see MockRowCache): every getter of a root mock row is fully determined by the
    // schema object, so every query over the same table can share ONE prebuilt prototype
    // carrying all column/relation getters; a new row is `Object.create` plus its own
    // state slots — O(1) instead of one property definition per column+relation per
    // query (measurable CPU under load: the root-mock walk was the ORM's largest
    // per-query-build item after 0.4.69). Per-query state (`chainId`, the FieldRef
    // cache) lives in symbol-keyed slots read through `this`; relation getters still
    // construct FRESH builders per access (memoizing would fuse repeated
    // `.where()` chains). Opt-in via the same static switch; OFF = fresh prototype
    // per row (the pre-0.4.70 behaviour). Consumers must not probe mock rows with
    // OWN-property APIs (`Object.keys`, `{...row}`) — see `isReferenceMockRow`.
    const prototype = MockRowCache.getOrBuild(
      `select|${this.schema.name}`,
      () => Object.defineProperties({}, this.buildRootMockDescriptors()),
    );

    const mock: any = Object.create(prototype);
    mock[MOCK_ROW_FIELD_REFS] = {};
    mock[MOCK_ROW_CHAIN_ID] = this.chainId;

    // Cache the mock for reuse
    this._cachedMockRow = mock;
    return mock;
  }

  /**
   * Builds the shared property-descriptor map for {@link _createMockRow}'s cached path.
   * The getters read per-row state through `this`-bound symbol slots, so one descriptor
   * map serves every root mock row of the same schema. Values captured at build time
   * (column mappers/types, target schemas, the registry) are schema-constants identical
   * for every row of the signature.
   */
  private buildRootMockDescriptors(): PropertyDescriptorMap {
    const tableAlias = this.schema.name;

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Build a mapper lookup for columns (only when needed)
    const columnMappers: Record<string, any> = {};
    const columnSqlTypes: Record<string, string> = {};
    // Per-schema mapper/type lookup, computed once — `colBuilder.build()` per column
    // per row was measurable CPU under load (every query build walks every column
    // twice: once here, once in the descriptors). Keyed by schema identity.
    const schemaColumnMeta = getSchemaColumnMeta(this.schema);
    for (const [colName, meta] of schemaColumnMeta) {
      if (meta.mapper) {
        columnMappers[colName] = meta.mapper;
      }

      if (meta.type) {
        columnSqlTypes[colName] = meta.type;
      }
    }

    const descriptors: PropertyDescriptorMap = {};

    // Add columns as FieldRef objects - type-safe with property name and database column name
    for (const [colName, dbColumnName] of columnNameMap) {
      const mapper = columnMappers[colName];
      descriptors[colName] = {
        get(this: any) {
          const slots: MockRowSlots = this;
          const fieldRefCache = slots[MOCK_ROW_FIELD_REFS] ??= {};
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
              __chainId: slots[MOCK_ROW_CHAIN_ID],
              // Include mapper for toDriver transformation in conditions
              __mapper: mapper,
              // Column SQL type — lets flag* emit width-exact mask casts
              __sqlType: columnSqlTypes[colName],
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      };
    }

    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(this.schema);

    // Values captured at descriptor-build time — identical for every row of this
    // signature (the registry is the process-wide schema registry).
    const schemaRegistry = this.schemaRegistry;
    const sourceTableName = this.schema.name;

    // Add relations (both collections and single references)
    for (const [relName, relConfig] of relationEntries) {
      // Performance: Use cached target schema, but prefer registry lookup for full relations
      let targetSchema = schemaRegistry?.get(relConfig.targetTable);
      if (!targetSchema) {
        targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);
      }

      if (relConfig.type === 'many') {
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        descriptors[relName] = {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              sourceTableName,
              targetSchema,
              schemaRegistry,  // Pass schema registry for nested navigation resolution
              undefined,
              relConfig.foreignKeys,  // Propagate composite FK / literal predicates
              relConfig.matches
            );
          },
          enumerable: false,
          configurable: true,
        };
      } else {
        // Single reference navigation (many-to-one, one-to-one)
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow
        // with circular relations like User->Posts->User)
        const holder: MockPrototypeHolder = {};
        descriptors[relName] = {
          get(this: any) {
            // One mock target row per row and relation (a selector reading `p.user.*` several
            // times used to mint a builder and a row per access)
            const slots: MockRowSlots = this;
            const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
            const cachedRow = navCache[relName];
            if (cachedRow !== undefined) {
              return cachedRow;
            }
            if (holder.prototype !== undefined && MockRowCache.isEnabled()) {
              return (navCache[relName] = mintReferenceMockRow(holder.prototype, slots[MOCK_ROW_CHAIN_ID]));
            }
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,
              schemaRegistry,  // Pass schema registry for nested navigation resolution
              [],  // Empty navigation path for first level navigation
              sourceTableName  // Pass source table name for lateral join correlation
            );
            return (navCache[relName] = refBuilder.createMockTargetRow(holder, slots[MOCK_ROW_CHAIN_ID]));
          },
          enumerable: false,
          configurable: true,
        };
      }
    }

    return descriptors;
  }

  /**
   * Add a LEFT JOIN to the query with a selector (supports both tables and subqueries)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  leftJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    // A CTE (the typings of db.<table>.leftJoin offer it; it used to throw "_getSchema is not a function")
    if (isCte(rightTable)) {
      return this.joinCteFromRoot('LEFT', rightTable, condition, selector);
    }

    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      // Delegate to SelectQueryBuilder which handles subquery joins
      const qb = new SelectQueryBuilder(
        this.schema,
        this.client,
        (row: any) => row as TRow,
        this.whereCond,
        this.limitValue,
        this.offsetValue,
        this.orderByFields,
        this.executor,
        this.manualJoins,
        this.joinCounter,
        false,  // isDistinct defaults to false
        this.schemaRegistry,  // a joined table's navigations need its targets' relations
        [],  // ctes
        this.collectionStrategy,
      this.chainId
    );
      return qb.leftJoinSubquery(rightTable, alias, condition as any, selector as any);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock rows for condition evaluation
    const mockLeft = this._createMockRow();
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);
    const joinCondition = condition(mockLeft, mockRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Store schemas for creating fresh mocks in the selector
    const leftSchema = this.schema;
    const createLeftMock = () => this._createMockRow();
    const createRightMock = () => this.createMockRowForTable(rightSchema, rightAlias);

    // Create a selector wrapper that generates fresh mocks and calls the user's selector
    const wrappedSelector = (row: any) => {
      // Create fresh mocks for the selector invocation
      const freshMockLeft = createLeftMock();
      const freshMockRight = createRightMock();
      return materializeMockSelection(selector(freshMockLeft as TRow, freshMockRight as TRight));
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      wrappedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      false,  // isDistinct defaults to false
      this.schemaRegistry,  // a joined table's navigations need its targets' relations
      [],  // ctes
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * A JOIN of a CTE straight off the table: the CTE's columns on the right, the CTE attached to the
   * statement's WITH list (as `.with(cte)` would — see SelectQueryBuilder.joinCte).
   */
  private joinCteFromRoot<TRight, TSelection>(
    type: JoinType,
    cte: DbCte<TRight>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    const joinCondition = condition(this._createMockRow(), createCteMockRow(cte as DbCte<any>) as TRight);
    const updatedJoins = [...this.manualJoins, {
      type,
      table: cte.name,
      alias: cte.name,
      schema: null as any,
      condition: joinCondition,
      cte: cte as DbCte<any>,
    }];

    // Fresh mocks for every selector invocation
    const wrappedSelector = () =>
      materializeMockSelection(selector(this._createMockRow() as TRow, createCteMockRow(cte as DbCte<any>) as TRight));

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      wrappedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      this.joinCounter + 1,
      false,  // isDistinct defaults to false
      this.schemaRegistry,
      [cte as DbCte<any>],
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * Add an INNER JOIN to the query with a selector (supports both tables and subqueries)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  innerJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    // A CTE (see leftJoin)
    if (isCte(rightTable)) {
      return this.joinCteFromRoot('INNER', rightTable, condition, selector);
    }

    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      // Delegate to SelectQueryBuilder which handles subquery joins
      const qb = new SelectQueryBuilder(
        this.schema,
        this.client,
        (row: any) => row as TRow,
        this.whereCond,
        this.limitValue,
        this.offsetValue,
        this.orderByFields,
        this.executor,
        this.manualJoins,
        this.joinCounter,
        false,  // isDistinct defaults to false
        this.schemaRegistry,  // a joined table's navigations need its targets' relations
        [],  // ctes
        this.collectionStrategy,
      this.chainId
    );
      return qb.innerJoinSubquery(rightTable, alias, condition as any, selector as any);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock rows for condition evaluation
    const mockLeft = this._createMockRow();
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);
    const joinCondition = condition(mockLeft, mockRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Store schemas for creating fresh mocks in the selector
    const leftSchema = this.schema;
    const createLeftMock = () => this._createMockRow();
    const createRightMock = () => this.createMockRowForTable(rightSchema, rightAlias);

    // Create a selector wrapper that generates fresh mocks and calls the user's selector
    const wrappedSelector = (row: any) => {
      // Create fresh mocks for the selector invocation
      const freshMockLeft = createLeftMock();
      const freshMockRight = createRightMock();
      return materializeMockSelection(selector(freshMockLeft as TRow, freshMockRight as TRight));
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      wrappedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      false,  // isDistinct defaults to false
      this.schemaRegistry,  // a joined table's navigations need its targets' relations
      [],  // ctes
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    return createJoinedTableMockRow(schema, alias, this.schemaRegistry);
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Offset results
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Order by field(s)
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (row: TRow) => T): this;
  orderBy<T>(selector: (row: TRow) => T[]): this;
  orderBy<T>(selector: (row: TRow) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TRow) => OrderByResult<T>): this {
    const mockRow = this._createMockRow();
    const result = materializeMockSelection(selector(mockRow));
    // Every key is a column of the row or of one of its navigations: it keeps its ref, so the
    // projection chosen later renders it qualified — and joins the navigation it reads. A key that
    // is an expression over them (`sql` fragment, condition, a collection's count) renders as such.
    forEachOrderByKey(result, (key, direction) => {
      this.orderByFields.push({ field: key.__dbColumnName || key.__fieldName, direction, ref: key });
    }, (expression, direction) => {
      this.orderByFields.push({ field: '', direction, expression });
    });
    return this;
  }
}

/**
 * Select query builder with nested collection support
 */
export class SelectQueryBuilder<TSelection> {
  /** @internal Chain identity — see chainIdSeq. */
  public chainId: number;
  /**
   * @internal Aliases the WHERE correlated on, recorded by `detectAndAddJoinsFromCondition`
   * so the shadow check can be re-run after the SELECT list has contributed its joins.
   */
  private correlatedAliasesFromCondition: Set<string> = new Set();
  /**
   * @internal The navigation plan of the build in progress (see {@link withNavigationPlan}), read by
   * the join collectors and resolvers; `undefined` between builds and for builds it cannot change.
   */
  private navigationPlan?: NavigationAliasPlan;
  private schema: TableSchema;
  private client: DatabaseClient;
  private selector: (row: any) => TSelection;
  private whereCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private lockClause?: string;
  private orderByFields: RootOrderByField[] = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private isDistinct: boolean = false;
  private _includeCountOver: boolean = false;
  private schemaRegistry?: Map<string, TableSchema>;
  private ctes: DbCte<any>[] = [];  // Track CTEs attached to this query
  private collectionStrategy?: CollectionStrategyType;

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    selector: (row: any) => TSelection,
    whereCond?: Condition,
    limit?: number,
    offset?: number,
    orderBy?: RootOrderByField[],
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number,
    isDistinct?: boolean,
    schemaRegistry?: Map<string, TableSchema>,
    ctes?: DbCte<any>[],
    collectionStrategy?: CollectionStrategyType,
    chainId?: number
  ) {
    this.schema = schema;
    this.client = client;
    // A condition value in the projection selects as a boolean column
    this.selector = selectorProjectingConditions(selector);
    this.chainId = chainId ?? ++chainIdSeq;
    this.whereCond = whereCond;
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.isDistinct = isDistinct || false;
    this.schemaRegistry = schemaRegistry;
    this.ctes = ctes || [];
    this.collectionStrategy = collectionStrategy;
  }

  /**
   * Override the timeout for this single query (in milliseconds). Only this query
   * is wrapped (`SET LOCAL statement_timeout` inside a short transaction).
   * Overrides the connection-level default; pass `0` to disable. On timeout a
   * `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires — the query is
   * NOT cancelled (use `.withTimeout()` for that). Overrides the context's
   * `longRunningQueryThreshold` for this query.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
  }

  /**
   * Run THIS query as a named prepared statement (`true`) or unnamed (`false`), overriding
   * the context's `preparedStatements` default. See `QueryBuilder.withPreparedStatements`.
   */
  withPreparedStatements(prepare: boolean): this {
    this.executor = this.executor
      ? this.executor.withPreparedStatements(prepare)
      : new QueryExecutor(this.client, undefined, undefined, undefined, prepare);
    return this;
  }

  /**
   * Transform the selection with a new selector
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TNewSelection>(selector: (row: TSelection) => TNewSelection): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // Create a composed selector that applies both transformations
    const composedSelector = (row: any) => {
      const firstResult = materializeMockSelection(this.selector(row));
      return selector(firstResult);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add WHERE condition
   * Multiple where() calls are chained with AND logic
   * Note: The row parameter represents the selected shape (after select())
   */
  /**
   * INNER JOIN used purely as a row FILTER — the selection shape is preserved
   * (unlike innerJoin, no selector is required and the builder stays chainable
   * as the same entity/selection type). The ON condition receives (left, right)
   * mocks; an optional third callback contributes an extra WHERE predicate with
   * the same (left, right) arguments.
   *
   * Intended for scope-style predicates that hop across an N:1 FK (e.g.
   * loan → borrower_data): a JOIN against the "one" side never
   * duplicates left rows. Joining a 1:N side WILL duplicate rows — callers own
   * that trade-off (use exists()/inSubquery for semi-join semantics instead).
   *
   * Also accepts a {@link DbCte}: the right side then addresses the CTE's
   * columns, and the CTE is auto-attached to the statement's WITH list (as if
   * `.with(cte)` had been called). The canonical candidate-set shape — a
   * MATERIALIZED CTE of ids inner-joined back to the entity — keeps the CTE
   * the driving side of the plan while the selection carries the projection.
   */
  joinFilter<TRight = any>(
    rightTable: { _getSchema: () => TableSchema } | DbCte<TRight>,
    on: (left: any, right: TRight) => Condition,
    filter?: (left: any, right: TRight) => Condition
  ): this {
    return this.addFilterJoin('INNER', rightTable, on, filter);
  }

  /**
   * LEFT JOIN used purely as a row FILTER — see joinFilter. Useful with an
   * IS NULL predicate in the filter callback for anti-join shapes
   * ("rows with NO matching right row"). Accepts a {@link DbCte} like
   * joinFilter does.
   */
  leftJoinFilter<TRight = any>(
    rightTable: { _getSchema: () => TableSchema } | DbCte<TRight>,
    on: (left: any, right: TRight) => Condition,
    filter?: (left: any, right: TRight) => Condition
  ): this {
    return this.addFilterJoin('LEFT', rightTable, on, filter);
  }

  private addFilterJoin<TRight>(
    type: JoinType,
    rightTable: { _getSchema: () => TableSchema } | DbCte<TRight>,
    on: (left: any, right: TRight) => Condition,
    filter?: (left: any, right: TRight) => Condition
  ): this {
    if (isCte(rightTable)) {
      return this.addCteFilterJoin(
        type,
        rightTable,
        on,
        filter
      );
    }

    const rightSchema = rightTable._getSchema();
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    this.joinCounter = this.joinCounter + 1;

    const mockRow = this._createMockRow();
    const selectedMock = materializeMockSelection(this.selector(mockRow));
    const leftMock = this.createFieldRefProxy(selectedMock, true);
    const rightMock = this.createMockRowForTable(rightSchema, rightAlias);

    const onCondition = on(leftMock, rightMock as TRight);
    this.manualJoins = [
      ...this.manualJoins,
      {
        type,
        table: rightSchema.name,
        alias: rightAlias,
        schema: rightSchema,
        condition: onCondition,
      },
    ];

    if (filter) {
      const filterCondition = filter(leftMock, rightMock as TRight);
      this.whereCond = this.whereCond ? andCondition(this.whereCond, filterCondition) : filterCondition;
    }

    return this;
  }

  /**
   * joinFilter / leftJoinFilter against a CTE: identical pure-filter
   * semantics, with the right-side mock addressing the CTE's columns. The CTE
   * is auto-attached to the query's WITH list (deduplicated by name), so the
   * emitted statement always carries its definition even without an explicit
   * `.with(cte)`.
   */
  private addCteFilterJoin<TRight>(
    type: JoinType,
    cte: DbCte<TRight>,
    on: (left: any, right: TRight) => Condition,
    filter?: (left: any, right: TRight) => Condition
  ): this {
    const mockRow = this._createMockRow();
    const selectedMock = materializeMockSelection(this.selector(mockRow));
    const leftMock = this.createFieldRefProxy(selectedMock, true);
    const rightMock = this.createMockRowForCte(cte as DbCte<any>);

    const onCondition = on(leftMock, rightMock as TRight);
    this.manualJoins = [
      ...this.manualJoins,
      {
        type,
        table: cte.name,
        alias: cte.name,
        schema: null as any,
        condition: onCondition,
        cte: cte as DbCte<any>,
      },
    ];

    if (!this.ctes.some(existing => existing.name === cte.name)) {
      this.ctes = [...this.ctes, cte as DbCte<any>];
    }

    if (filter) {
      const filterCondition = filter(leftMock, rightMock as TRight);
      this.whereCond = this.whereCond ? andCondition(this.whereCond, filterCondition) : filterCondition;
    }

    return this;
  }

  where(condition: (row: any) => Condition): this {
    const mockRow = this._createMockRow();
    // Apply the selector to get the selected shape that the user sees in the WHERE condition
    const selectedMock = materializeMockSelection(this.selector(mockRow));
    // Wrap in proxy - for WHERE, we preserve original column names
    const fieldRefProxy = this.createFieldRefProxy(selectedMock, true);
    const newCondition = condition(fieldRefProxy);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Attach one or more CTEs to this query
   *
   * @example
   * const result = await db.users
   *   .where(u => eq(u.id, 1))
   *   .with(activeUsersCte.cte)
   *   .leftJoin(activeUsersCte.cte, ...)
   *   .toList();
   */
  with(...ctes: DbCte<any>[]): this {
    // Add CTEs, avoiding duplicates by name
    for (const cte of ctes) {
      if (!this.ctes.some(existing => existing.name === cte.name)) {
        this.ctes.push(cte);
      }
    }
    return this;
  }

  /**
   * The CTEs attached to this query through `.with(...)` (or auto-attached by
   * `joinFilter(cte, ...)`). Read by {@link UnionQueryBuilder.buildSql}, which
   * hoists them to statement level so a CTE declared on one union leg is
   * visible to all of them.
   * @internal
   */
  _getAttachedCtes(): DbCte<any>[] {
    return this.ctes;
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Offset results
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Append a row-level lock clause to the final SELECT — `FOR UPDATE` (with the
   * optional `SKIP LOCKED` / `NOWAIT` modifiers). The lock is taken on the rows
   * the statement reads, making a following check+write in the SAME transaction
   * (or a later CTE leg of a fused statement) atomic against every other
   * `forUpdate` reader of those rows — the DB-side replacement for app-level
   * distributed locks around read-then-write sequences (TOCTOU).
   *
   * Always pair with `.orderBy(...)` for a deterministic lock ORDER (lock
   * multi-row sets in a stable order — e.g. ascending id — to avoid deadlocks).
   *
   * Execution paths: toList()/firstOrDefault() emit the clause; UNION builds and
   * nested-collection CTE legs intentionally drop it (a lock on a lateral join
   * leg is meaningless). A query used as a Subquery/CTE leg through
   * `asSubquery()` carries it verbatim — that is the fused-conditional-INSERT
   * pattern's lock leg.
   *
   * @example
   * .orderBy(g => g.id)
   * .forUpdate()
   * .toList()
   */
  forUpdate(options?: { skipLocked?: boolean; noWait?: boolean }): this {
    if (options?.skipLocked && options?.noWait) {
      throw new Error('forUpdate: skipLocked and noWait are mutually exclusive');
    }

    this.lockClause = options?.skipLocked
      ? 'FOR UPDATE SKIP LOCKED'
      : options?.noWait
        ? 'FOR UPDATE NOWAIT'
        : 'FOR UPDATE';

    return this;
  }

  /**
   * Order by field(s)
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockRow = this._createMockRow();
    const selectedMock = materializeMockSelection(this.selector(mockRow));
    const result = selector(this.createOrderByProxy(selectedMock));

    // Clear previous orderBy - last one takes precedence
    this.orderByFields = [];
    forEachOrderByKey(result, (key, direction) => {
      this.orderByFields.push(rootOrderByFieldOf(key, direction));
    }, (expression, direction) => {
      // An expression reads columns; a projected `sql` fragment or literal has only its output alias
      for (const ref of expression.getFieldRefs()) {
        const meta: OrderKeyMeta | undefined = (ref as any)?.[ORDER_KEY];

        if (meta !== undefined && meta.ref === undefined) {
          throw new Error(
            `orderBy(): an expression cannot read the projected value "${meta.alias}", which is not a column — `
            + 'order by that value itself, or build the expression from the columns it is computed from.'
          );
        }
      }

      this.orderByFields.push({ field: '', direction, expression });
    });

    return this;
  }

  /**
   * The row an `orderBy` selector reads. A top-level value names its output alias (and, for a
   * column, keeps the column's ref — see RootOrderByField); a nested object's leaf names its
   * flattened alias (`__nested__<key>__<leaf>`) and, for a column, its ref; a navigation row — one
   * projected whole, or reached through a select-all row — is handed out as is, so a column read
   * through it IS that column's ref, joined and qualified like a projected one.
   */
  private createOrderByProxy(selectedMock: any, nestedPrefix?: string): any {
    if (!selectedMock || typeof selectedMock !== 'object' || ('__fieldName' in selectedMock && '__dbColumnName' in selectedMock)) {
      return selectedMock;
    }

    // A projected column's key inherits the column's ref: inside an expression
    // (`sql\`lower(${r.name})\``) it renders — and is joined and re-aliased — as that column, which is
    // all an expression can read (an output alias is visible to ORDER BY only standing alone)
    const orderKey = (fieldName: string, alias: string, meta: Omit<OrderKeyMeta, 'alias'>): any => {
      const key: any = meta.ref !== undefined ? Object.create(meta.ref) : { __dbColumnName: alias };
      key.__fieldName = fieldName;
      key[ORDER_KEY] = { ...meta, alias };

      return key;
    };

    return new Proxy(selectedMock, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then') {
          return target[prop];
        }

        const value = target[prop];
        const nested = nestedPrefix !== undefined;
        const alias = nested ? `${nestedPrefix}__${prop}` : prop;

        if (value && typeof value === 'object' && '__fieldName' in value && '__dbColumnName' in value) {
          return orderKey(prop, alias, { ref: value, nested });
        }

        // Navigation builders pass through untouched (see createFieldRefProxy)
        if (
          value instanceof CollectionQueryBuilder
          || value instanceof ReferenceQueryBuilder
          || value instanceof QueryBuilder
          || value instanceof SelectQueryBuilder
        ) {
          return value;
        }

        // A navigation row: its columns are ordered by their own refs
        if (isReferenceMockRow(value)) {
          return value;
        }

        if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof SqlFragment)) {
          return this.createOrderByProxy(value, nested ? alias : `__nested__${prop}`);
        }

        // A projected `sql` fragment or literal: ordered by its output alias
        return orderKey(prop, alias, { nested });
      },
    });
  }

  /** The refs of the ORDER BY keys' columns (an expression key's included) — joined and planned like the projection's. */
  private orderByRefs(): FieldRef[] {
    const refs: FieldRef[] = [];

    for (const entry of this.orderByFields) {
      if (entry.ref !== undefined) {
        refs.push(entry.ref);
      }

      if (entry.expression !== undefined) {
        for (const ref of entry.expression.getFieldRefs()) {
          refs.push(orderKeyColumnRef(ref));
        }
      }
    }

    return refs;
  }

  /**
   * One ORDER BY key's SQL (without the direction): the output alias while the projection being built
   * still selects the key's column under it, else the qualified column; keys without a column ref keep
   * their previous rendering (an output alias, or a column of the root table).
   */
  private orderByKeySql(entry: RootOrderByField, selection: any, colNameMap: Map<string, string>): string {
    const { field, ref } = entry;
    const projected = selection && typeof selection === 'object' && !Array.isArray(selection) ? selection : undefined;

    if (ref !== undefined) {
      if (!entry.nestedAlias && projected !== undefined && field in projected && isSameColumnRef(projected[field], ref)) {
        return `"${field}"`;
      }

      return `"${(ref as any).__tableAlias || this.schema.name}"."${ref.__dbColumnName}"`;
    }

    if (entry.nestedAlias || (projected !== undefined && field in projected)) {
      // Output alias of the projection (a nested leaf's flattened alias)
      return `"${field}"`;
    }

    // Not in the projection: a column of the root table
    return `"${this.schema.name}"."${colNameMap.get(field) ?? field}"`;
  }

  /**
   * Group by fields - returns a GroupedQueryBuilder for type-safe aggregations
   * @param selector Function that selects the grouping key from the current selection
   * @example
   * db.users
   *   .select(u => ({ id: u.id, street: u.address.street, name: u.name }))
   *   .groupBy(p => ({ street: p.street }))
   *   .select(g => ({ street: g.key.street, count: g.count() }))
   */
  groupBy<TGroupingKey>(
    selector: (row: TSelection) => TGroupingKey
  ): GroupedQueryBuilder<TSelection, TGroupingKey> {
    return new GroupedQueryBuilder(
      this.schema,
      this.client,
      this.selector,
      selector,
      this.whereCond,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      this.schemaRegistry,
      this.chainId
    );
  }

  /**
   * Add a LEFT JOIN with a subquery
   * @param subquery The subquery to join (must be 'table' mode)
   * @param alias Alias for the subquery in the FROM clause
   * @param condition Join condition
   * @param selector Result selector
   */
  leftJoinSubquery<TSubqueryResult, TNewSelection>(
    subquery: Subquery<TSubqueryResult, 'table'>,
    alias: string,
    condition: (left: TSelection, right: TSubqueryResult) => Condition,
    selector: (left: TSelection, right: TSubqueryResult) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = materializeMockSelection(this.selector(mockRow));

    // Create mock for the subquery result (right side)
    // For subqueries, we create a mock based on the result type
    const mockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight);

    // Store the subquery join info
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: `(${subquery.buildSql({ paramCounter: 0, params: [] })})`, // This will be rebuilt properly
      alias: alias,
      schema: null as any, // Subqueries don't have schema
      condition: joinCondition,
      isSubquery: true,
      subquery: subquery,
    } as any];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = materializeMockSelection(this.selector(row));
      const freshMockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);
      return selector(leftResult as TSelection, freshMockRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add a LEFT JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  // Overload for CTE
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Overload for Subquery
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: Subquery<TRight, 'table'>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Overload for Table
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema },
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Implementation
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // Check if rightTable is a CTE
    if (isCte(rightTable)) {
      return this.leftJoinCte(rightTable, condition, selector);
    }

    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      return this.leftJoinSubquery(rightTable, alias, condition, selector);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    // IMPORTANT: We call the selector with the mock row to get a result that contains FieldRef objects
    const mockRow = this._createMockRow();
    const mockLeftSelection = materializeMockSelection(this.selector(mockRow));

    // The mockLeftSelection now contains FieldRef objects (with __fieldName, __dbColumnName, __tableAlias)
    // These FieldRef objects preserve the table context

    // Create mock for the right table
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);

    // Evaluate the join condition - the mockLeftSelection has FieldRef objects,
    // so the condition can properly reference table aliases
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Create a new selector that first applies the current selector, then the new selector
    const composedSelector = (row: any) => {
      const leftResult = materializeMockSelection(this.selector(row));
      const freshMockRight = this.createMockRowForTable(rightSchema, rightAlias);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add a LEFT JOIN with a CTE
   */
  private leftJoinCte<TRight extends Record<string, any>, TNewSelection>(
    cte: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    return this.joinCte('LEFT', cte, condition, selector);
  }

  /**
   * Add a JOIN with a CTE. A CTE the query does not carry yet is attached to its WITH list (as
   * `.with(cte)` would), like joinFilter does — an INNER JOIN of a CTE used to throw
   * "rightTable._getSchema is not a function", though the typings offer it.
   * @internal
   */
  joinCte<TRight extends Record<string, any>, TNewSelection>(
    type: JoinType,
    cte: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = materializeMockSelection(this.selector(mockRow));

    // Create mock for the CTE columns (right side)
    const mockRight = this.createMockRowForCte(cte);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the CTE join
    const updatedJoins = [...this.manualJoins, {
      type,
      table: cte.name,
      alias: cte.name,
      schema: null as any,
      condition: joinCondition,
      cte: cte,
    }];
    const ctes = this.ctes.some(existing => existing.name === cte.name) ? this.ctes : [...this.ctes, cte];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = materializeMockSelection(this.selector(row));
      const freshMockRight = this.createMockRowForCte(cte);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add an INNER JOIN with a subquery
   * @param subquery The subquery to join (must be 'table' mode)
   * @param alias Alias for the subquery in the FROM clause
   * @param condition Join condition
   * @param selector Result selector
   */
  innerJoinSubquery<TSubqueryResult, TNewSelection>(
    subquery: Subquery<TSubqueryResult, 'table'>,
    alias: string,
    condition: (left: TSelection, right: TSubqueryResult) => Condition,
    selector: (left: TSelection, right: TSubqueryResult) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = materializeMockSelection(this.selector(mockRow));

    // Create mock for the subquery result (right side)
    const mockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight);

    // Store the subquery join info
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: `(${subquery.buildSql({ paramCounter: 0, params: [] })})`,
      alias: alias,
      schema: null as any,
      condition: joinCondition,
      isSubquery: true,
      subquery: subquery,
    } as any];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = materializeMockSelection(this.selector(row));
      const freshMockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);
      return selector(leftResult as TSelection, freshMockRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add an INNER JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  innerJoin<TRight, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // A CTE: its columns, as a LEFT JOIN of one reads them
    if (isCte(rightTable)) {
      return this.joinCte('INNER', rightTable as DbCte<any>, condition as any, selector as any);
    }

    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      return this.innerJoinSubquery(rightTable, alias, condition, selector);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = materializeMockSelection(this.selector(mockRow));

    // Create mock for the right table
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Create a new selector that first applies the current selector, then the new selector
    const composedSelector = (row: any) => {
      const leftResult = materializeMockSelection(this.selector(row));
      const freshMockRight = this.createMockRowForTable(rightSchema, rightAlias);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    return createJoinedTableMockRow(schema, alias, this.schemaRegistry);
  }

  /**
   * Whether a projected value is a row of OURS projected whole — a navigation row (`p.user`), the
   * root row itself — which renders as its columns, flattened like a nested object's, and reads back
   * as the object of them. A row of an enclosing query (a correlation) is not ours to render.
   */
  private isFlattenedNavigationRow(value: unknown): boolean {
    if (!isReferenceMockRow(value)) {
      return false;
    }

    const firstKey = findFirstGetterKey(value as object);

    return firstKey !== undefined && !isForeignChainRef((value as any)[firstKey], this.chainId);
  }

  /**
   * Create mock row for a subquery result (for subquery joins)
   * The subquery result type defines the shape - we create FieldRefs for each property
   */
  private createMockRowForSubquery<TSubqueryResult>(alias: string, subquery?: Subquery<TSubqueryResult, 'table'>): TSubqueryResult {
    const mock: any = {};

    // Get selection metadata from subquery if available
    const selectionMetadata = subquery?.getSelectionMetadata();

    // We need to infer the structure from TSubqueryResult
    // Since we can't iterate over a type at runtime, we create a proxy that
    // returns FieldRefs for any property access — each carrying how its column reads
    // (see projectedColumnRef)
    return new Proxy(mock, {
      get(_target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        return projectedValueRef(prop, alias, selectionMetadata ? selectionMetadata[prop] : undefined);
      },
      has() {
        return true; // All properties "exist"
      },
      ownKeys() {
        return []; // We don't know the keys ahead of time
      },
      getOwnPropertyDescriptor() {
        return {
          enumerable: true,
          configurable: true,
        };
      }
    }) as TSubqueryResult;
  }

  /**
   * Create a mock row for CTE columns
   */
  private createMockRowForCte<TCteColumns extends Record<string, any>>(cte: DbCte<TCteColumns>): TCteColumns {
    return createCteMockRow(cte);
  }

  /**
   * Select distinct rows
   */
  selectDistinct<TNewSelection>(selector: (row: TSelection) => TNewSelection): SelectQueryBuilder<TNewSelection> {
    const composedSelector = (row: any) => {
      const firstResult = materializeMockSelection(this.selector(row));
      return selector(firstResult);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      true,  // Set isDistinct to true
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy,
      this.chainId
    );
  }

  /**
   * Get minimum value from the query
   */
  async min<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = materializeMockSelection(this.selector(mockRow));
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = materializeMockSelection(this.selector(mockRow));
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('MIN', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get maximum value from the query
   */
  async max<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = materializeMockSelection(this.selector(mockRow));
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = materializeMockSelection(this.selector(mockRow));
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('MAX', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get sum of values from the query
   */
  async sum<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = materializeMockSelection(this.selector(mockRow));
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = materializeMockSelection(this.selector(mockRow));
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('SUM', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get count of rows from the query
   */
  async count(): Promise<number> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'count');

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Execute query and return results with total count using COUNT(*) OVER().
   * Useful for pagination - gets data and total count in a single query.
   */
  async countOver(): Promise<{ data: ResolveCollectionResults<TSelection>[]; totalCount: number }> {
    this._includeCountOver = true;
    try {
      const options = this.executor?.getOptions();
      const tracer = new TimeTracer(options?.traceTime ?? false, options?.logger);

      tracer.startPhase('queryBuild');

      const context: QueryContext = tracer.trace('createContext', () => ({
        ctes: new Map(),
        cteCounter: 0,
        useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
        paramCounter: 1,
        allParams: [],
        collectionStrategy: this.collectionStrategy,
        executor: this.executor,
      }));

      const mockRow = tracer.trace('createMockRow', () => this._createMockRow());
      const selectionResult = tracer.trace('evaluateSelector', () => materializeMockSelection(this.selector(mockRow)));

      const { sql, params, nestedPaths } = tracer.trace('buildQuery', () => this.buildQuery(selectionResult, context));
      tracer.endPhase();

      tracer.startPhase('queryExecution');
      const result = await tracer.traceAsync('executeQuery', async () =>
        this.executor
          ? await this.executor.query(sql, params)
          : await this.client.query(sql, params),
        { rowCount: 'pending' }
      );
      tracer.endPhase();

      // Extract totalCount from first raw row before transformation
      // PostgreSQL COUNT() OVER() returns bigint (string in pg driver)
      const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].__countOver ?? '0', 10) : 0;

      // Strip __countOver from raw rows before processing
      for (const row of result.rows) {
        delete row.__countOver;
      }

      if (this.executor?.getOptions().rawResult) {
        return { data: result.rows, totalCount };
      }

      tracer.startPhase('resultProcessing');
      let rows = result.rows;
      if (nestedPaths.size > 0) {
        rows = tracer.trace('reconstructNestedObjects', () =>
          rows.map(row => this.reconstructNestedObjects(row, nestedPaths)),
          { rowCount: rows.length }
        );
      }

      const data = tracer.trace('transformResults', () =>
        this.transformResults(rows, selectionResult),
        { rowCount: rows.length }
      );
      tracer.endPhase();

      tracer.logSummary(data.length);

      return { data: data as any, totalCount };
    } finally {
      this._includeCountOver = false;
    }
  }

  /**
   * Check if any rows match the query
   * More efficient than count() > 0 as it can stop after finding one row
   */
  async exists(): Promise<boolean> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'exists');

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.exists === true;
  }

  /**
   * Combine this query with another using UNION (removes duplicates)
   *
   * @param query Another SelectQueryBuilder with compatible selection type
   * @returns A UnionQueryBuilder for further chaining
   *
   * @example
   * ```typescript
   * const result = await db.users
   *   .select(u => ({ id: u.id, name: u.name }))
   *   .union(db.customers.select(c => ({ id: c.id, name: c.name })))
   *   .orderBy(r => r.name)
   *   .toList();
   * ```
   */
  union(query: SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection> {
    const unionBuilder = new UnionQueryBuilder<TSelection>(this, this.client, this.executor);
    return unionBuilder.union(query);
  }

  /**
   * Combine this query with another using UNION ALL (keeps all rows including duplicates)
   *
   * @param query Another SelectQueryBuilder with compatible selection type
   * @returns A UnionQueryBuilder for further chaining
   *
   * @example
   * ```typescript
   * // UNION ALL is faster than UNION as it doesn't need to remove duplicates
   * const allLogs = await db.errorLogs
   *   .select(l => ({ timestamp: l.createdAt, message: l.message }))
   *   .unionAll(db.infoLogs.select(l => ({ timestamp: l.createdAt, message: l.message })))
   *   .orderBy(r => r.timestamp)
   *   .toList();
   * ```
   */
  unionAll(query: SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection> {
    const unionBuilder = new UnionQueryBuilder<TSelection>(this, this.client, this.executor);
    return unionBuilder.unionAll(query);
  }

  /**
   * Build SQL for use in UNION queries (without ORDER BY, LIMIT, OFFSET)
   * @internal Used by UnionQueryBuilder
   */
  buildUnionSql(context: SqlBuildContext): string {
    const queryContext: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: context.useJsonArrayAggregation ?? !this.client.supportsBinaryArrayResults(),
      paramCounter: context.paramCounter,
      allParams: context.params,
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
      // CTEs the union already declared ahead of the whole statement — this leg
      // must not re-declare them (nor re-push their params).
      hoistedCteNames: context.hoistedCteNames,
    };

    const mockRow = this._createMockRow();
    const selectionResult = materializeMockSelection(this.selector(mockRow));

    // Build query without ORDER BY, LIMIT, OFFSET for union component
    const { sql, nestedPaths } = this.buildQueryCore(selectionResult, queryContext, false);

    // Update context's param counter
    context.paramCounter = queryContext.paramCounter;

    // Stash the rich metadata (nestedPaths + selection) so UnionQueryBuilder
    // can post-process the result rows (reconstructNestedObjects +
    // transformResults for collection projections). buildUnionSql is always
    // called by UnionQueryBuilder synchronously immediately before the union
    // SQL is executed, so this is safe — no concurrency. The fields are
    // refreshed on every call; `_lastUnionMetadata` is the contract.
    this._lastUnionMetadata = {
      nestedPaths,
      selectionResult,
    };

    return sql;
  }

  /**
   * Metadata captured by the most recent `buildUnionSql` invocation. Used by
   * `UnionQueryBuilder.toList()` to drive `reconstructNestedObjects` and
   * `transformResults` on the union result. Cleared after each consume.
   * @internal
   */
  private _lastUnionMetadata?: {
    nestedPaths: Set<string>;
    selectionResult: any;
  };

  /**
   * Read (and consume) the metadata captured by the most recent
   * `buildUnionSql` call. Internal contract with `UnionQueryBuilder`.
   * @internal
   */
  _consumeUnionMetadata(): { nestedPaths: Set<string>; selectionResult: any } | undefined {
    const meta = this._lastUnionMetadata;
    this._lastUnionMetadata = undefined;
    return meta;
  }

  /**
   * Apply the standard post-fetch result transformation to the raw rows
   * returned by a UNION execution. Combines `reconstructNestedObjects` (for
   * `__nested__<path>` columns produced by nested-object projections) with
   * `transformResults` (for collection projections, scalar mappers, FieldRef
   * mappers, etc.). Used exclusively by `UnionQueryBuilder.toList()`.
   * @internal
   */
  _applyUnionPostProcessing(rows: any[], meta: { nestedPaths: Set<string>; selectionResult: any }): TSelection[] {
    let processed = rows;
    if (meta.nestedPaths.size > 0) {
      processed = rows.map(row => this.reconstructNestedObjects(row, meta.nestedPaths));
    }
    // Every leg's rows go through the FIRST leg's selection here: a literal is read from its row,
    // as each leg projects its own
    return this.transformResults(processed, meta.selectionResult, true);
  }

  /**
   * Create a future query that will be executed later.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureQuery that can be executed individually or in a batch
   *
   * @example
   * ```typescript
   * const q1 = db.users.select(u => ({ id: u.id, name: u.username })).future();
   * const q2 = db.posts.select(p => ({ title: p.title })).future();
   *
   * // Execute in a single roundtrip
   * const [users, posts] = await FutureQueryRunner.runAsync([q1, q2]);
   * ```
   */
  future(): FutureQuery<ResolveCollectionResults<TSelection>> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    const mockRow = this._createMockRow();
    const selectionResult = materializeMockSelection(this.selector(mockRow));
    const { sql, params, nestedPaths } = this.buildQuery(selectionResult, context);

    // Create transform function that captures current state
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      if (rows.length === 0) return [];

      // Reconstruct nested objects if needed
      let processedRows = rows;
      if (nestedPaths.size > 0) {
        processedRows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      return this.transformResults(processedRows, selectionResult) as ResolveCollectionResults<TSelection>[];
    };

    const future = new FutureQuery<ResolveCollectionResults<TSelection>>(
      sql,
      params,
      transformFn,
      this.client,
      this.executor
    );
    future._batchMeta = this.buildBatchMeta(selectionResult, nestedPaths.size > 0);

    return future;
  }

  /**
   * Create a future query that returns a single result or null.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureSingleQuery that resolves to a single result or null
   *
   * @example
   * ```typescript
   * const q1 = db.users.where(u => eq(u.id, 1)).select(u => u).futureFirstOrDefault();
   * const q2 = db.posts.where(p => eq(p.id, 5)).select(p => p).futureFirstOrDefault();
   *
   * const [user, post] = await FutureQueryRunner.runAsync([q1, q2]);
   * // user: User | null
   * // post: Post | null
   * ```
   */
  futureFirstOrDefault(): FutureSingleQuery<ResolveCollectionResults<TSelection>> {
    // Apply LIMIT 1 for efficiency
    const originalLimit = this.limitValue;
    this.limitValue = 1;

    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    const mockRow = this._createMockRow();
    const selectionResult = materializeMockSelection(this.selector(mockRow));
    const { sql, params, nestedPaths } = this.buildQuery(selectionResult, context);

    // Restore original limit
    this.limitValue = originalLimit;

    // Create transform function
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      if (rows.length === 0) return [];

      let processedRows = rows;
      if (nestedPaths.size > 0) {
        processedRows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      return this.transformResults(processedRows, selectionResult) as ResolveCollectionResults<TSelection>[];
    };

    const future = new FutureSingleQuery<ResolveCollectionResults<TSelection>>(
      sql,
      params,
      transformFn,
      this.client,
      this.executor
    );
    future._batchMeta = this.buildBatchMeta(selectionResult, nestedPaths.size > 0);

    return future;
  }

  /**
   * Create a future query that returns a count.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureCountQuery that resolves to a number
   *
   * @example
   * ```typescript
   * const q1 = db.users.futureCount();
   * const q2 = db.posts.futureCount();
   * const q3 = db.comments.where(c => eq(c.isPublished, true)).futureCount();
   *
   * const [userCount, postCount, commentCount] = await FutureQueryRunner.runAsync([q1, q2, q3]);
   * ```
   */
  futureCount(): FutureCountQuery {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'count');

    const future = new FutureCountQuery(sql, params, this.client, this.executor);
    future._batchMeta = { hasNestedPaths: false };

    return future;
  }

  /**
   * Build a value reviver for rows delivered as JSON (QueryBatch json_agg
   * envelope). JSON serialization bypasses the driver's type parsers:
   * timestamps and dates arrive as ISO strings, numerics as JSON numbers.
   * The reviver restores driver-equivalent values BEFORE the normal transform
   * pipeline runs, driven by the DECLARED column types of the selected fields —
   * never by value shape, so string columns are never misinterpreted.
   * Returns undefined when no selected column needs revival.
   * @internal
   */
  private buildBatchMeta(selection: any, hasNestedPaths: boolean): FutureBatchMeta {
    const revivals: Array<{ key: string; revive: (value: any) => any }> = [];
    const textColumns: string[] = [];
    // A selector returning one column: its row key is the column's name (see transformResults)
    const revivalSelection = isScalarSelection(selection) && '__dbColumnName' in selection
      ? { [(selection as FieldRef).__dbColumnName]: selection }
      : selection;
    this.collectJsonRowRevivals(revivalSelection, undefined, revivals, textColumns);

    const reviveJsonRow = revivals.length === 0
      ? undefined
      : (row: any) => {
          for (const { key, revive } of revivals) {
            const value = row[key];

            if (value !== null && value !== undefined) {
              row[key] = revive(value);
            }
          }

          return row;
        };

    return {
      hasNestedPaths,
      reviveJsonRow,
      textColumns: textColumns.length > 0 ? textColumns : undefined,
    };
  }

  /**
   * Walk a selection — including nested-object projections — collecting revival
   * entries keyed by the FLAT column alias each leaf is delivered under: top-level
   * keys as-is, nested leaves under the `__nested__<path>__<leaf>` path-encoded
   * alias that tryBuildFlatNestedSelect emits (revival runs BEFORE nested
   * reconstruction, so it must target the flat row shape). Only plain object
   * literals are recursed into; collections, SqlFragments and subquery builders
   * are skipped — they are delivered as json under standalone execution too, so
   * they need no revival.
   * @internal
   */
  private collectJsonRowRevivals(
    selection: any,
    pathPrefix: string | undefined,
    revivals: Array<{ key: string; revive: (value: any) => any }>,
    textColumns: string[]
  ): void {
    for (const key in selection) {
      const value = selection[key];

      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }

      if ('__fieldName' in value) {
        const config = this.resolveFieldColumnConfig(value);

        if (!config) {
          continue;
        }

        const flatKey = pathPrefix ? `${pathPrefix}__${key}` : key;
        // A custom fromDriver mapper is the column's type authority: it was
        // written against the driver's RAW output (apps that configure
        // timestamp parser passthrough, so their mappers expect the
        // text-protocol string). For mapper columns, revival reconstructs that
        // text form — json's ISO 'T' separator back to the driver's space, a
        // timestamptz's ':00' offset minutes collapsed to the driver's short
        // form — and never hands the mapper a Date it does not expect.
        const hasMapper = config.mapper != null;

        if (config.type === 'timestamp') {
          revivals.push(hasMapper
            ? { key: flatKey, revive: (v) => (typeof v === 'string' ? v.replace('T', ' ') : v) }
            : { key: flatKey, revive: (v) => (typeof v === 'string' ? new Date(v) : v) });
        } else if (config.type === 'timestamptz') {
          revivals.push(hasMapper
            ? { key: flatKey, revive: (v) => (typeof v === 'string' ? v.replace('T', ' ').replace(/([+-]\d{2}):00$/, '$1') : v) }
            : { key: flatKey, revive: (v) => (typeof v === 'string' ? new Date(v) : v) });
        } else if (config.type === 'date') {
          if (hasMapper) {
            // json 'YYYY-MM-DD' IS the driver text form — the mapper gets it as-is.
            continue;
          }

          revivals.push({
            key: flatKey,
            revive: (v) => {
              if (typeof v !== 'string') {
                return v;
              }

              // Mirror the drivers' date parsing: local midnight, not UTC
              const [year, month, day] = v.split('-').map(Number);

              return new Date(year, month - 1, day);
            },
          });
        } else if (config.type === 'decimal' || config.type === 'numeric' || config.type === 'bigint') {
          // Values of these types can exceed float53 precision, and JSON.parse
          // silently collapses arbitrary-precision JSON numerals to floats —
          // unrecoverable here. The batch therefore casts them ::text
          // server-side (see the envelope in query-batch.ts); these fallback
          // revivals only normalize a NUMBER that slipped through (older
          // metadata without textColumns) and no-op on the cast strings.
          textColumns.push(flatKey);
          const scale = config.scale;
          revivals.push({
            key: flatKey,
            revive: (v) => (typeof v === 'number' ? (scale != null && config.type !== 'bigint' ? v.toFixed(scale) : String(v)) : v),
          });
        } else if (config.type === 'bytea') {
          // Driver delivery is a byte buffer; row_to_json emits the '\x…' hex text.
          revivals.push({
            key: flatKey,
            revive: (v) => {
              if (typeof v !== 'string' || !v.startsWith('\\x')) {
                return v;
              }

              const hex = v.slice(2);
              const bufferCtor = (globalThis as any).Buffer;

              return bufferCtor
                ? bufferCtor.from(hex, 'hex')
                : Uint8Array.from(hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
            },
          });
        }

        continue;
      }

      // Recurse only into plain object literals — the nested-object projections
      // tryBuildFlatNestedSelect flattens. Class instances (collections, SqlFragment,
      // Subquery) and collection-result markers must not be walked.
      const proto = Object.getPrototypeOf(value);

      // Reference mock rows inherit their getters from a shared prototype (see
      // createMockTargetRow) yet must keep being walked exactly like the plain-object mocks
      // they replaced.
      if ((proto === Object.prototype || proto === null || isReferenceMockRow(value)) && !('__collectionResult' in value)) {
        this.collectJsonRowRevivals(
          value,
          pathPrefix ? `${pathPrefix}__${key}` : `__nested__${key}`,
          revivals,
          textColumns
        );
      }
    }
  }

  /**
   * Union-leg hook: builds the full batch metadata (reviver + text-cast column
   * aliases) for a previously consumed union selection so
   * UnionQueryBuilder.future() can attach it. Same mechanics as the standalone
   * future factories.
   * @internal
   */
  _buildUnionBatchMeta(selectionResult: any, hasNestedPaths: boolean): FutureBatchMeta {
    return this.buildBatchMeta(selectionResult, hasNestedPaths);
  }

  /**
   * Resolve the declared column config for a selected FieldRef: base table
   * fast path, then schema registry lookup for navigation-sourced fields.
   * Mirrors the mapper resolution order used by transformResults().
   * @internal
   */
  private resolveFieldColumnConfig(fieldRef: any): ColumnConfig | undefined {
    const sourceTable = fieldRef.__sourceTable;
    const schema =
      !sourceTable || sourceTable === this.schema.name ? this.schema : this.schemaRegistry?.get(sourceTable);

    if (!schema) {
      return undefined;
    }

    const cached = schema.columnMetadataCache?.get(fieldRef.__fieldName);

    if (cached?.config) {
      return cached.config;
    }

    const column = schema.columns?.[fieldRef.__fieldName];

    return column && typeof column.build === 'function' ? column.build() : undefined;
  }

  /**
   * Execute query and return results as array
   * Collection results are automatically resolved to arrays
   */
  async toList(): Promise<ResolveCollectionResults<TSelection>[]> {
    const options = this.executor?.getOptions();
    const tracer = new TimeTracer(options?.traceTime ?? false, options?.logger);

    // Query Build Phase
    tracer.startPhase('queryBuild');

    const context: QueryContext = tracer.trace('createContext', () => ({
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    }));

    // Analyze the selector to extract nested queries
    const mockRow = tracer.trace('createMockRow', () => this._createMockRow());
    const selectionResult = tracer.trace('evaluateSelector', () => materializeMockSelection(this.selector(mockRow)));

    // Check if we're using temp table strategy and have collections. A collection reading its
    // parent row beyond the relation key stays in the base query, where it renders as LATERAL
    // (see CollectionQueryBuilder.getOuterFieldRefs): an aggregate over temp-table parent ids
    // cannot see that row.
    const collections = tracer.trace('detectCollections', () => this.detectCollections(selectionResult))
      .filter(collection => this.collectionStrategy !== 'temptable' || collection.builder.getOuterFieldRefs().length === 0);
    const useTempTableStrategy = this.collectionStrategy === 'temptable' && collections.length > 0;

    tracer.endPhase();

    let results: any[];
    if (useTempTableStrategy) {
      for (const collection of collections) {
        this.assertJoinedCollectionStrategy(collection.builder, context);
      }

      // Two-phase execution for temp table strategy
      results = await this.executeWithTempTables(selectionResult, context, collections, tracer);
    } else {
      // Single-phase execution for JSONB strategy (current behavior)
      results = await this.executeSinglePhase(selectionResult, context, tracer);
    }

    // Log trace summary if tracing is enabled
    tracer.logSummary(results.length);

    return results;
  }

  /**
   * Execute query using single-phase approach (JSONB/CTE strategy)
   */
  private async executeSinglePhase(selectionResult: any, context: QueryContext, tracer: TimeTracer): Promise<any[]> {
    // Build the query
    tracer.startPhase('queryBuild');
    const { sql, params, nestedPaths } = tracer.trace('buildQuery', () => this.buildQuery(selectionResult, context));
    tracer.endPhase();

    // Execute using executor if available, otherwise use client directly
    tracer.startPhase('queryExecution');
    const result = await tracer.traceAsync('executeQuery', async () =>
      this.executor
        ? await this.executor.query(sql, params)
        : await this.client.query(sql, params),
      { rowCount: 'pending' }
    );
    tracer.endPhase();

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      return result.rows;
    }

    // Reconstruct nested objects from flat row data (if any)
    tracer.startPhase('resultProcessing');
    let rows = result.rows;
    if (nestedPaths.size > 0) {
      rows = tracer.trace('reconstructNestedObjects', () =>
        rows.map(row => this.reconstructNestedObjects(row, nestedPaths)),
        { rowCount: rows.length }
      );
    }

    // Transform results
    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(rows, selectionResult),
      { rowCount: rows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Execute query using two-phase approach (temp table strategy)
   */
  private async executeWithTempTables(
    selectionResult: any,
    context: QueryContext,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    tracer: TimeTracer
  ): Promise<any[]> {
    // Build base selection (excludes collections, includes each collection's parent key)
    tracer.startPhase('queryBuild');
    const parentKeyAliases = new Map<CollectionQueryBuilder<any>, string>();
    const baseSelection = tracer.trace('buildBaseSelection', () =>
      this.buildBaseSelection(selectionResult, collections, parentKeyAliases)
    );
    const { sql: baseSql, params: baseParams, nestedPaths: baseNestedPaths } = tracer.trace('buildBaseQuery', () =>
      this.buildQuery(baseSelection, {
        ...context,
        ctes: new Map(), // Clear CTEs since we're not using them for collections
      })
    );
    tracer.endPhase();

    // The base rows' nested objects (and navigation rows) arrive as flattened path aliases: they are
    // rebuilt before the collections are merged into them. They used to stay flat — a nested object
    // came back without its columns, or not at all
    const rebuildNested = (rows: any[]): any[] =>
      baseNestedPaths.size === 0 ? rows : rows.map(row => this.reconstructNestedObjects(row, baseNestedPaths));

    // Check if we can use fully optimized single-query approach
    // Requirements: PostgresClient with querySimpleMulti support AND no parameters in base query
    // AND every collection expressible by the naive per-collection SQL that
    // executeFullyOptimized emits (plain flat list over a single-column `id`
    // correlation). Anything richer — collection .where(), limit/offset, scalar
    // aggregations, firstOrDefault, toNumberList/toStringList, DISTINCT,
    // constant-FK (`__LIT:`) predicates, navigation paths, selectMany joins,
    // nested/fragment/mapped selector fields — must go through the two-phase
    // path, whose strategy builders handle those features. The naive SQL used
    // to silently drop them (e.g. a `.where()` filter on the collection).
    const canUseFullOptimization =
      this.client.supportsMultiStatementQueries() &&
      baseParams.length === 0 &&
      collections.length > 0 &&
      collections.every(c => this.isNaiveCollectionFastPathSafe(c.builder));

    if (canUseFullOptimization) {
      return this.executeFullyOptimized(baseSql, baseSelection, selectionResult, context, collections, tracer, rebuildNested);
    }

    // Legacy two-phase approach: execute base query first
    tracer.startPhase('queryExecution');
    const baseResult = await tracer.traceAsync('executeBaseQuery', async () =>
      this.executor
        ? await this.executor.query(baseSql, baseParams)
        : await this.client.query(baseSql, baseParams)
    );

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      tracer.endPhase();
      return baseResult.rows;
    }

    if (baseResult.rows.length === 0) {
      tracer.endPhase();
      return [];
    }

    // Phase 2: Execute collection aggregations using temp tables
    // For each collection, call buildCTE with the ids of ITS parents: the values of the parent key
    // buildBaseSelection selected for it (the root row's key, or the key of the navigation it hangs off)
    const collectionResults = new Map<string, Map<any, any>>();

    for (const collection of collections) {
      const builder = collection.builder;
      const keyAlias = parentKeyAliases.get(builder) ?? '__pk_id';
      const parentIds = baseResult.rows.map(row => row[keyAlias]);

      // Each aggregation runs as a statement of its own: its parameters are numbered from $1
      const collectionContext: QueryContext = {
        ctes: new Map(),
        cteCounter: context.cteCounter,
        paramCounter: 1,
        allParams: [],
        collectionStrategy: context.collectionStrategy,
        executor: context.executor,
        useJsonArrayAggregation: context.useJsonArrayAggregation,
      };

      // Call buildCTE with parent IDs - this will use the temp table strategy
      const aggResult = await tracer.traceAsync(`buildCTE:${collection.name}`, async () =>
        builder.buildCTE(collectionContext, this.client, parentIds)
      );
      context.cteCounter = collectionContext.cteCounter;

      // aggResult is a Promise<CollectionAggregationResult> for temp table strategy
      const result = await (aggResult as any as Promise<any>);

      // If the result has a tableName, it means temp tables were created and we need to query them
      if (result.tableName && !result.isCTE) {
        // Check if data was already fetched (multi-statement optimization)
        if (result.dataFetched && result.data) {
          // Data already fetched - use it directly
          collectionResults.set(collection.name, result.data);
        } else {
          // Temp table strategy (legacy) - query the aggregation table
          const aggQuery = `SELECT parent_id, data FROM ${result.tableName}`;
          const aggQueryResult = await tracer.traceAsync(`queryCollection:${collection.name}`, async () =>
            this.executor
              ? await this.executor.query(aggQuery, [])
              : await this.client.query(aggQuery, [])
          );

          // Cleanup temp tables if needed
          if (result.cleanupSql) {
            await this.client.query(result.cleanupSql);
          }

          // Index results by parent_id for merging
          const resultMap = new Map<number, any>();
          for (const row of aggQueryResult.rows) {
            resultMap.set(row.parent_id, row.data);
          }
          collectionResults.set(collection.name, resultMap);
        }
      } else {
        // CTE strategy (shouldn't happen in temp table mode, but handle it)
        throw new Error('Expected temp table result but got CTE');
      }
    }
    tracer.endPhase();

    // Phase 3: Merge base results with collection results
    tracer.startPhase('resultProcessing');
    const mergedRows = tracer.trace('mergeResults', () =>
      rebuildNested(baseResult.rows).map(baseRow => {
        const merged = { ...baseRow };
        for (const collection of collections) {
          const resultMap = collectionResults.get(collection.name);
          const parentId = baseRow[parentKeyAliases.get(collection.builder) ?? '__pk_id'];
          const rawData = parentId === null || parentId === undefined ? undefined : resultMap?.get(parentId);

          // Check if this is a single result (firstOrDefault) - return first item or null
          const isSingleResult = collection.builder.isSingleResult();
          let collectionData: any;

          if (isSingleResult) {
            // For single results, rawData might already be an object (from temp table strategy)
            // or might be an array (from other strategies) that we need to extract the first item from
            if (rawData === undefined || rawData === null) {
              collectionData = null;
            } else if (Array.isArray(rawData)) {
              collectionData = rawData.length > 0 ? rawData[0] : null;
            } else {
              // Already a single object
              collectionData = rawData;
            }
          } else {
            // For list results, ensure we return an array
            collectionData = rawData || this.getDefaultValueForCollection(collection.builder);
          }

          // Handle nested paths
          if (collection.path.length > 0) {
            // Navigate to the nested object and set the collection there
            let current = merged;
            for (let i = 0; i < collection.path.length; i++) {
              const pathPart = collection.path[i];
              if (!(pathPart in current)) {
                current[pathPart] = {};
              }
              current = current[pathPart];
            }
            current[collection.name] = collectionData;
          } else {
            merged[collection.name] = collectionData;
          }
        }
        // Remove the internal parent-key fields before returning
        delete merged.__pk_id;
        for (const keyAlias of parentKeyAliases.values()) {
          delete merged[keyAlias];
        }
        return merged;
      }),
      { rowCount: baseResult.rows.length }
    );

    // Transform results using the original selection
    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(mergedRows, selectionResult),
      { rowCount: mergedRows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Execute using fully optimized single-query approach (PostgresClient only)
   * Combines base query + all collections into ONE multi-statement query
   */
  /**
   * Whether a collection can be served by the naive per-collection SQL emitted
   * in {@link executeFullyOptimized} (`SELECT fk AS parent_id, <flat fields>
   * FROM target WHERE fk IN (SELECT __pk_id FROM tmp_base)`). That SQL knows
   * nothing about collection filters, pagination, aggregations, constant-FK
   * predicates, navigation correlation, or mapper transforms — so any of those
   * features disqualifies the fast path and the query falls back to the
   * two-phase execution whose strategy builders implement them correctly.
   */
  private isNaiveCollectionFastPathSafe(builder: CollectionQueryBuilder<any>): boolean {
    const b = builder as any;

    if (b.whereCond) {
      return false;
    }
    if (b.limitValue != null || b.offsetValue != null) {
      return false;
    }
    if (b.aggregationType) {
      return false;
    }
    if (b.flattenResultType) {
      return false;
    }
    if (b.isDistinct) {
      return false;
    }
    if (typeof b.isSingleResult === 'function' && b.isSingleResult()) {
      return false;
    }
    if ((b.navigationPath?.length ?? 0) > 0 || (b.selectManyJoins?.length ?? 0) > 0 || b.foreignKeyTableAlias) {
      return false;
    }

    // The naive SQL names bare columns of the collection's own table: a column read through a
    // navigation — in the projection or the ORDER BY — would silently read the own column of the
    // same name (`ln.edition.id` as the loan's id), or fail
    const ownMarker = `__collection_${b.targetTable}__`;
    if ((b.orderByFields ?? []).some((field: any) => field.fragment !== undefined || (field.table !== undefined && field.table !== ownMarker && field.table !== b.targetTable))) {
      return false;
    }

    // Single-column `fk = parent.id` correlation only; composite keys and
    // `__LIT:` constant predicates (SCD2 is_current etc.) need the strategies.
    const hasLiteralMarker = (arr?: string[]) =>
      (arr ?? []).some(entry => typeof entry === 'string' && entry.startsWith('__LIT:'));
    if (hasLiteralMarker(b.foreignKeys) || hasLiteralMarker(b.matches)) {
      return false;
    }
    if ((b.foreignKeys?.length ?? 0) > 1) {
      return false;
    }
    if ((b.matches?.length ?? 0) > 0 && !(b.matches.length === 1 && b.matches[0] === 'id')) {
      return false;
    }

    // Selector must project only direct, unmapped FieldRef columns — nested
    // objects, SQL fragments, and nested collection builders are silently
    // dropped by the naive field loop, and custom mappers would be skipped.
    // Column types must additionally be "jsonb-stable": the naive path returns
    // DRIVER-native values (numeric => string, timestamp => Date), while every
    // aggregating strategy returns json_agg semantics (numeric => number,
    // timestamp => ISO string). Only allow types where both representations
    // are identical, so all execution paths stay value-equal.
    if (!b.selector || typeof b.createMockItem !== 'function') {
      return false;
    }

    const JSONB_STABLE_TYPES = new Set([
      'smallint',
      'integer',
      'smallserial',
      'serial',
      'real',
      'double precision',
      'boolean',
      'varchar',
      'char',
      'text',
      'uuid',
      'json',
      'jsonb',
    ]);

    try {
      const selected = materializeMockSelection(b.selector(b.createMockItem()));

      // The rows carry the parent key as `parent_id` next to the projection: a projected
      // `parent_id` would collide with it
      if (Object.prototype.hasOwnProperty.call(selected, 'parent_id')) {
        return false;
      }

      for (const value of Object.values(selected)) {
        if (!(value && typeof value === 'object' && '__dbColumnName' in (value as any))) {
          return false;
        }
        if ((value as any).__tableAlias !== ownMarker) {
          return false;
        }
        if ((value as any).__mapper) {
          return false;
        }

        const fieldName = (value as any).__fieldName;
        const meta = b.targetTableSchema?.columnMetadataCache?.get?.(fieldName);

        if (meta?.hasMapper) {
          return false;
        }

        const columnBuilder = b.targetTableSchema?.columns?.[fieldName];
        const columnConfig = typeof columnBuilder?.build === 'function' ? columnBuilder.build() : null;

        if (!columnConfig || !JSONB_STABLE_TYPES.has(columnConfig.type)) {
          return false;
        }
      }
    } catch {
      return false;
    }

    return true;
  }

  private async executeFullyOptimized(
    baseSql: string,
    baseSelection: any,
    selectionResult: any,
    context: QueryContext,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    tracer: TimeTracer,
    rebuildNested: (rows: any[]) => any[]
  ): Promise<any[]> {
    tracer.startPhase('queryBuild');
    const baseTempTable = `tmp_base_${context.cteCounter++}`;

    // Build SQL for each collection
    const collectionSQLs: string[] = tracer.trace('buildCollectionSQLs', () => {
      const sqls: string[] = [];
      for (const collection of collections) {
        const builderAny = collection.builder as any;
        const targetTable = builderAny.targetTable;
        const foreignKey = builderAny.foreignKey;
        const selector = builderAny.selector;
        const orderByFields = builderAny.orderByFields || [];

        // Build selected fields
        let selectedFieldsSQL = '';
        if (selector) {
          const mockItem = builderAny.createMockItem();
          const selectedFields = selector(mockItem);

          const fieldParts: string[] = [];
          for (const [alias, field] of Object.entries(selectedFields)) {
            if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
              const dbColumnName = (field as any).__dbColumnName;
              fieldParts.push(`"${dbColumnName}" as "${alias}"`);
            }
          }
          selectedFieldsSQL = fieldParts.join(', ');
        }

        // Build ORDER BY. Every key names its table: a bare name binds to an OUTPUT column first, so
        // `ORDER BY "id"` next to `"book_id" as "id"` ordered by the projected book id.
        let orderBySQL: string;
        const targetSchema = builderAny.targetTableSchema;
        if (orderByFields.length > 0) {
          const colNameMap = targetSchema ? getColumnNameMapForSchema(targetSchema) : null;
          orderBySQL = ` ORDER BY ${orderByFields.map(({ field, direction }: any) => {
            const dbColumnName = colNameMap?.get(field) ?? field;
            return `"${targetTable}"."${dbColumnName}" ${direction}`;
          }).join(', ')}`;
        } else {
          // Find primary key column from schema, fallback to "id" if not found
          let pkColumn: string = null as any;
          if (targetSchema) {
            for (const meta of getSchemaColumnMeta(targetSchema).values()) {
              if (meta.primaryKey && meta.name != null) {
                pkColumn = meta.name;
                break;
              }
            }
          }

          if (pkColumn) {
            orderBySQL = ` ORDER BY "${targetTable}"."${pkColumn}" DESC`;
          } else {
            orderBySQL = ' ';
          }
        }

        const fromTable = quoteTableReference(targetTable, targetSchema?.schema);
        const collectionSQL = `SELECT "${foreignKey}" as parent_id, ${selectedFieldsSQL} FROM ${fromTable} WHERE "${foreignKey}" IN (SELECT "__pk_id" FROM ${baseTempTable})${orderBySQL}`;
        sqls.push(collectionSQL);
      }
      return sqls;
    });

    // Build mega multi-statement SQL
    const multiStatementSQL = tracer.trace('buildMultiStatement', () => {
      const statements = [
        `CREATE TEMP TABLE ${baseTempTable} AS ${baseSql}`,
        `SELECT * FROM ${baseTempTable}`,
        ...collectionSQLs,
        `DROP TABLE IF EXISTS ${baseTempTable}`
      ];
      return statements.join(';\n');
    });
    tracer.endPhase();

    // Execute via querySimpleMulti
    tracer.startPhase('queryExecution');
    const executor = this.executor || this.client;
    let resultSets: QueryResult[];

    if ('querySimpleMulti' in executor && typeof (executor as any).querySimpleMulti === 'function') {
      resultSets = await tracer.traceAsync('executeMultiStatement', async () =>
        (executor as any).querySimpleMulti(multiStatementSQL)
      );
    } else {
      throw new Error('Fully optimized mode requires querySimpleMulti support');
    }
    tracer.endPhase();

    // Parse result sets: [0]=CREATE, [1]=base, [2..N]=collections, [N+1]=DROP
    const baseResult = resultSets[1];

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      return baseResult?.rows || [];
    }

    if (!baseResult || baseResult.rows.length === 0) {
      return [];
    }

    // Result processing phase
    tracer.startPhase('resultProcessing');

    // Group collection results by parent_id
    const collectionResults = tracer.trace('groupCollectionResults', () => {
      const results = new Map<string, Map<number, any>>();
      collections.forEach((collection, idx) => {
        const collectionResultSet = resultSets[2 + idx];
        const dataMap = new Map<number, any>();

        for (const row of collectionResultSet.rows) {
          const parentId = row.parent_id;
          if (!dataMap.has(parentId)) {
            dataMap.set(parentId, []);
          }
          const { parent_id, ...rowData } = row;
          dataMap.get(parentId)!.push(rowData);
        }

        results.set(collection.name, dataMap);
      });
      return results;
    });

    // Merge base results with collection results (the base rows' nested objects rebuilt first)
    const mergedRows = tracer.trace('mergeResults', () =>
      rebuildNested(baseResult.rows).map((baseRow: any) => {
        const merged = { ...baseRow };
        for (const collection of collections) {
          const resultMap = collectionResults.get(collection.name);
          const parentId = baseRow.__pk_id;
          const rawData = resultMap?.get(parentId);

          // Check if this is a single result (firstOrDefault) - return first item or null
          const isSingleResult = collection.builder.isSingleResult();
          let collectionData: any;

          if (isSingleResult) {
            // For single results, rawData might already be an object (from temp table strategy)
            // or might be an array (from other strategies) that we need to extract the first item from
            if (rawData === undefined || rawData === null) {
              collectionData = null;
            } else if (Array.isArray(rawData)) {
              collectionData = rawData.length > 0 ? rawData[0] : null;
            } else {
              // Already a single object
              collectionData = rawData;
            }
          } else {
            // For list results, ensure we return an array
            collectionData = rawData || [];
          }

          // Handle nested paths
          if (collection.path.length > 0) {
            // Navigate to the nested object and set the collection there
            let current = merged;
            for (let i = 0; i < collection.path.length; i++) {
              const pathPart = collection.path[i];
              if (!(pathPart in current)) {
                current[pathPart] = {};
              }
              current = current[pathPart];
            }
            current[collection.name] = collectionData;
          } else {
            merged[collection.name] = collectionData;
          }
        }
        delete merged.__pk_id;
        return merged;
      }),
      { rowCount: baseResult.rows.length }
    );

    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(mergedRows, selectionResult),
      { rowCount: mergedRows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Detect collections in the selection result, including nested objects.
   * Returns collections with path information for proper result reconstruction.
   */
  private detectCollections(selection: any): Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }> {
    const collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }> = [];
    this.detectCollectionsRecursive(selection, [], collections);
    return collections;
  }

  /**
   * Recursively detect collections in nested objects
   */
  private detectCollectionsRecursive(
    selection: any,
    currentPath: string[],
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>
  ): void {
    if (typeof selection !== 'object' || selection === null || selection instanceof SqlFragment) {
      return;
    }

    for (const [key, value] of Object.entries(selection)) {
      if (value instanceof CollectionQueryBuilder) {
        collections.push({ name: key, path: [...currentPath], builder: value });
      } else if (value && typeof value === 'object' && '__collectionResult' in value && 'buildCTE' in value) {
        // This is a CollectionResult which wraps a CollectionQueryBuilder
        collections.push({ name: key, path: [...currentPath], builder: value as any as CollectionQueryBuilder<any> });
      } else if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value)) {
        // Recursively check nested objects (but not FieldRefs or arrays)
        this.detectCollectionsRecursive(value, [...currentPath, key], collections);
      }
    }
  }

  /**
   * Build base selection excluding collections but including necessary foreign keys.
   * Handles nested collections by removing them from nested structures.
   */
  private buildBaseSelection(
    selection: any,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    parentKeyAliases?: Map<CollectionQueryBuilder<any>, string>
  ): any {
    const baseSelection: any = {};

    // Build a set of top-level collection names (for backward compatibility)
    const topLevelCollectionNames = new Set(
      collections.filter(c => c.path.length === 0).map(c => c.name)
    );

    // Always ensure we have the primary key in the base selection with a known alias
    const mockRow = this._createMockRow();
    baseSelection['__pk_id'] = mockRow.id; // Add primary key with a known alias

    // A collection whose parents are not identified by the root row's `id` — it hangs off a
    // navigation (`ln.edition.book.editions`: the edition's BOOK), or its relation names another
    // principal key — gets a key column of its own
    if (parentKeyAliases !== undefined) {
      for (const [index, collection] of collections.entries()) {
        const path = collection.builder.getNavigationPath();
        const key = collection.builder.getParentKeyColumn();

        if (path.length === 0 && key === 'id') {
          continue;
        }

        const alias = `__pk_${index}`;
        const rootAnchored = path.length === 0 || path[0].sourceAlias !== this.schema.name;
        baseSelection[alias] = rootAnchored
          ? { __fieldName: key, __dbColumnName: key, __tableAlias: this.schema.name, __chainId: this.chainId }
          : {
            // The key column of the path's last hop — joined and aliased like a column read through it
            __fieldName: key,
            __dbColumnName: key,
            __tableAlias: path[path.length - 1].alias,
            __navigationAliases: path.slice(0, -1).map(step => step.alias),
            __chainId: this.chainId,
          };
        parentKeyAliases.set(collection.builder, alias);
      }
    }

    for (const [key, value] of Object.entries(selection)) {
      if (!topLevelCollectionNames.has(key)) {
        // For nested objects, recursively remove collections
        if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value) && !(value instanceof SqlFragment)) {
          const nestedCollections = collections.filter(c => c.path.length > 0 && c.path[0] === key);
          if (nestedCollections.length > 0) {
            // This nested object contains collections - build it recursively
            baseSelection[key] = this.buildBaseSelectionRecursive(value, nestedCollections, 1);
          } else {
            baseSelection[key] = value;
          }
        } else {
          baseSelection[key] = value;
        }
      }
    }

    return baseSelection;
  }

  /**
   * Recursively build base selection for nested objects, excluding collections
   */
  private buildBaseSelectionRecursive(
    selection: any,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    depth: number
  ): any {
    const baseSelection: any = {};

    // Build a set of collection names at this depth
    const collectionNamesAtDepth = new Set(
      collections.filter(c => c.path.length === depth).map(c => c.name)
    );

    for (const [key, value] of Object.entries(selection)) {
      if (!collectionNamesAtDepth.has(key)) {
        // For nested objects, continue recursively
        if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value) && !(value instanceof SqlFragment)) {
          const nestedCollections = collections.filter(c => c.path.length > depth && c.path[depth] === key);
          if (nestedCollections.length > 0) {
            baseSelection[key] = this.buildBaseSelectionRecursive(value, nestedCollections, depth + 1);
          } else {
            baseSelection[key] = value;
          }
        } else {
          baseSelection[key] = value;
        }
      }
    }

    return baseSelection;
  }

  /**
   * Build collection aggregation config from CollectionQueryBuilder
   */
  private buildCollectionConfig(
    builder: CollectionQueryBuilder<any>,
    context: QueryContext,
    parentIds: any[]
  ): CollectionAggregationConfig {
    // This is similar to the logic in CollectionQueryBuilder.buildCTE()
    // but extracts the config instead of building SQL directly

    // We need to access private members - use type assertion
    const builderAny = builder as any;

    const selectedFieldConfigs: Array<{ alias: string; expression: string }> = [];

    // Determine aggregation type
    let aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum' | 'exists' = 'jsonb';
    let aggregateField: string | undefined;
    let arrayField: string | undefined;

    if (builderAny.aggregationType) {
      aggregationType = builderAny.aggregationType.toLowerCase() as any;
    } else if (builderAny.flattenResultType) {
      aggregationType = 'array';
    }

    return {
      relationName: builderAny.relationName,
      targetTable: builderAny.targetTable,
      foreignKey: builderAny.foreignKey,
      sourceTable: builderAny.sourceTable,
      parentIds,
      selectedFields: selectedFieldConfigs,
      whereClause: '',  // Will be built from whereCond
      orderByClause: '',  // Will be built from orderByFields
      limitValue: builderAny.limitValue,
      offsetValue: builderAny.offsetValue,
      isDistinct: builderAny.isDistinct,
      aggregationType,
      aggregateField,
      arrayField: builderAny.flattenResultType ? this.extractArrayField(builderAny) : undefined,
      defaultValue: this.getDefaultValueString(aggregationType),
      counter: context.cteCounter++,
    };
  }

  /**
   * Extract array field from collection builder for array aggregations
   */
  private extractArrayField(builder: any): string | undefined {
    // For array aggregations, we need to determine which field to aggregate
    if (builder.selector) {
      const mockItem = builder.createMockItem?.() || {};
      const selectedField = builder.selector(mockItem);

      if (typeof selectedField === 'object' && selectedField !== null && '__dbColumnName' in selectedField) {
        return selectedField.__dbColumnName;
      }
    }

    return undefined;
  }

  /**
   * Get default value string for aggregation type
   */
  private getDefaultValueString(aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum' | 'exists'): string {
    switch (aggregationType) {
      case 'jsonb':
        // Use JSON instead of JSONB for better aggregation performance
        return "'[]'::json";
      case 'array':
        return "'{}'";
      case 'count':
        return '0';
      case 'exists':
        return 'false';
      case 'min':
      case 'max':
      case 'sum':
        return 'null';
      default:
        return "'[]'::json";
    }
  }

  /**
   * Get default value for collection based on aggregation type
   */
  private getDefaultValueForCollection(builder: CollectionQueryBuilder<any>): any {
    const builderAny = builder as any;

    if (builderAny.aggregationType) {
      // Scalar aggregation
      if (builderAny.aggregationType === 'COUNT') return 0;
      if (builderAny.aggregationType === 'EXISTS') return false;
      return null;
    } else if (builderAny.flattenResultType) {
      // Array aggregation
      return [];
    } else if (builder.isSingleResult()) {
      // firstOrDefault() - single item
      return null;
    } else {
      // JSONB aggregation (object array)
      return [];
    }
  }

  /**
   * Execute query and return first result or null
   */
  async first(): Promise<ResolveCollectionResults<TSelection> | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return first result or null (alias for first)
   */
  async firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null> {
    return this.first();
  }

  /**
   * Execute query and return first result or throw
   */
  async firstOrThrow(): Promise<ResolveCollectionResults<TSelection>> {
    const result = await this.first();
    if (!result) {
      throw new Error('No results found');
    }
    return result;
  }

  /**
   * Create a prepared query for efficient reusable parameterized execution.
   *
   * Prepared queries build the SQL once and allow multiple executions
   * with different parameter values. This is useful for:
   * 1. Query building optimization - Build SQL once, execute many times
   * 2. Type-safe placeholders - Named parameters with validation
   * 3. Developer ergonomics - Cleaner API for reusable queries
   *
   * @param name - A name for the prepared query (for debugging)
   * @returns PreparedQuery that can be executed multiple times with different parameters
   *
   * @example
   * ```typescript
   * // Create a prepared query with a placeholder
   * const getUserById = db.users
   *   .where(u => eq(u.id, sql.placeholder('userId')))
   *   .prepare('getUserById');
   *
   * // Execute multiple times with different values
   * const user1 = await getUserById.execute({ userId: 10 });
   * const user2 = await getUserById.execute({ userId: 20 });
   * ```
   *
   * @example
   * ```typescript
   * // Multiple placeholders
   * const searchUsers = db.users
   *   .where(u => and(
   *     gt(u.age, sql.placeholder('minAge')),
   *     like(u.name, sql.placeholder('namePattern'))
   *   ))
   *   .prepare('searchUsers');
   *
   * await searchUsers.execute({ minAge: 18, namePattern: '%john%' });
   * ```
   */
  prepare<TParams extends Record<string, any> = Record<string, any>>(
    name: string
  ): PreparedQuery<ResolveCollectionResults<TSelection>, TParams> {
    // Build query with placeholder tracking
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
      placeholders: new Map(),
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    // Analyze the selector to extract nested queries
    const mockRow = this._createMockRow();
    const selectionResult = materializeMockSelection(this.selector(mockRow));

    // Build the query - this populates context.placeholders
    const { sql, nestedPaths } = this.buildQuery(selectionResult, context);

    // Create transform function (closure over schema, selection, nestedPaths)
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      // If rawResult is enabled, return raw rows without any processing
      if (this.executor?.getOptions().rawResult) {
        return rows as any;
      }

      // Reconstruct nested objects from flat row data (if any)
      if (nestedPaths.size > 0) {
        rows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      // Transform results
      return this.transformResults(rows, selectionResult) as any;
    };

    return new PreparedQuery(
      sql,
      context.placeholders || new Map(),
      context.paramCounter - 1,
      this.client,
      transformFn,
      name
    );
  }

  /**
   * Delete records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.where(u => eq(u.id, 1)).delete();
   *
   * // With returning() - returns full entities
   * const deleted = await db.users.where(u => eq(u.id, 1)).delete().returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.where(u => eq(u.isActive, false)).delete()
   *   .returning(u => ({ id: u.id, username: u.username }));
   * ```
   */
  /** A model-managed VIEW is read-only — refuse a write PostgreSQL might accept on a simple view. */
  private static assertWritable(schema: TableSchema, verb: string): void {
    if (schema.view != null) {
      throw new Error(`Cannot ${verb} "${schema.name}": it is a model-managed view (read-only)`);
    }
  }

  /**
   * The WHERE of an UPDATE / DELETE: the joins of its navigations (rendered as `FROM` / `USING`) and
   * its SQL, built under ONE navigation plan so that both name the same aliases.
   */
  private buildMutationWhere(startParam: number): {
    whereJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
    whereSql: string;
    whereParams: any[];
  } {
    return this.withNavigationPlan(undefined, this.whereCond, () => {
      const whereJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
      this.detectAndAddJoinsFromCondition(this.whereCond, whereJoins);

      const { sql, params } = new ConditionBuilder().build(this.whereCond!, startParam);

      return { whereJoins, whereSql: sql, whereParams: params };
    });
  }

  delete(): FluentDelete<TSelection> {
    SelectQueryBuilder.assertWritable(this.schema, 'delete from');
    const queryBuilder = this;

    const executeDelete = async <TResult>(
      returning?: undefined | true | ((row: TSelection) => TResult) | 'count'
    ): Promise<any> => {
      // Build WHERE clause
      if (!queryBuilder.whereCond) {
        throw new Error('Delete requires a WHERE condition. Use where() before delete().');
      }

      // Detect navigation property joins from WHERE condition (and build it under the same plan)
      const { whereJoins, whereSql, whereParams } = queryBuilder.buildMutationWhere(1);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      // Build USING clause for navigation properties (PostgreSQL syntax for DELETE with JOINs)
      let usingClause = '';
      let joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);

        if (usingClause) {
          usingClause += `, ${joinTableName} AS "${join.alias}"`;
        } else {
          usingClause = `USING ${joinTableName} AS "${join.alias}"`;
        }

        // Build ON conditions as part of WHERE clause
        for (let i = 0; i < join.foreignKeys.length; i++) {
          const fk = join.foreignKeys[i];
          const match = join.matches[i];
          joinConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
        }
      }

      // Combine join conditions with the original WHERE clause
      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      // Check if RETURNING uses navigation properties
      const navigationInfo = returning && returning !== 'count' && returning !== true
        ? queryBuilder.detectNavigationInReturning(returning)
        : null;

      if (navigationInfo) {
        // Use CTE-based approach for navigation properties in RETURNING
        let deleteSql = `DELETE FROM ${qualifiedTableName}`;
        if (usingClause) {
          deleteSql += ` ${usingClause}`;
        }
        deleteSql += ` WHERE ${fullWhereClause}`;

        const { sql, params, read } = queryBuilder.buildReturningWithNavigation(
          deleteSql,
          whereParams,
          returning as ((row: TSelection) => TResult),
          navigationInfo
        );

        const result = queryBuilder.executor
          ? await queryBuilder.executor.query(sql, params)
          : await queryBuilder.client.query(sql, params);

        return readReturningRows(result.rows, read, queryBuilder.schemaRegistry);
      }

      // Standard RETURNING (no navigation properties)
      // Qualify columns with table name when using USING clause to avoid ambiguity
      const hasJoins = whereJoins.length > 0;
      const returningClause = returning !== 'count'
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, hasJoins, { paramCounter: whereParams.length + 1, params: whereParams })
        : undefined;

      let sql = `DELETE FROM ${qualifiedTableName}`;
      if (usingClause) {
        sql += ` ${usingClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = queryBuilder.executor
        ? await queryBuilder.executor.query(sql, whereParams)
        : await queryBuilder.client.query(sql, whereParams);

      // Return affected count
      if (returning === 'count') {
        return result.rowCount ?? 0;
      }

      if (!returningClause) {
        return undefined;
      }

      return queryBuilder.mapDeleteReturningResults(result.rows, returning, returningClause.read);
    };

    /**
     * Compile the DELETE into `{ sql, params }` WITHOUT executing — the
     * standard-path assembly (same WHERE/USING semantics as execution,
     * fragment-capable RETURNING included; navigation RETURNING is not
     * supported here — the execute path's CTE machinery is statement-bound).
     * Used to ride the statement as a data-modifying CTE
     * (`DbCteBuilder.withMutation`), the delete sibling of the update CAS gate.
     */
    const compileDelete = (returning?: undefined | true | ((row: TSelection) => any)): { sql: string; params: any[] } => {
      if (!queryBuilder.whereCond) {
        throw new Error('Delete requires a WHERE condition. Use where() before delete().');
      }

      const { whereJoins, whereSql, whereParams } = queryBuilder.buildMutationWhere(1);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      let usingClause = '';
      const joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);

        usingClause = usingClause ? `${usingClause}, ${joinTableName} AS "${join.alias}"` : `USING ${joinTableName} AS "${join.alias}"`;

        for (let i = 0; i < join.foreignKeys.length; i++) {
          joinConditions.push(`${formatJoinValue(sourceTable, join.foreignKeys[i])} = ${formatJoinValue(join.alias, join.matches[i])}`);
        }
      }

      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      if (returning && returning !== true && queryBuilder.detectNavigationInReturning(returning)) {
        throw new Error('toStatement(): navigation RETURNING is not supported in compiled DELETE statements — select plain or fragment columns only.');
      }

      // Qualify columns with table name when using USING clause to avoid ambiguity.
      const returningClause = returning
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, whereJoins.length > 0, { paramCounter: whereParams.length + 1, params: whereParams }, true)
        : null;

      let sql = `DELETE FROM ${qualifiedTableName}`;
      if (usingClause) {
        sql += ` ${usingClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      return { sql, params: whereParams };
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeDelete(undefined).then(onfulfilled, onrejected);
      },
      affectedCount() {
        return {
          then<T1 = number, T2 = never>(
            onfulfilled?: ((value: number) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeDelete('count').then(onfulfilled, onrejected);
          }
        };
      },
      toStatement(selector?: (row: TSelection) => any) {
        return compileDelete(selector);
      },
      returning<TResult>(selector?: (row: TSelection) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeDelete(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Update records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @param data Partial data to update
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.where(u => eq(u.id, 1)).update({ age: 30 });
   *
   * // With returning() - returns full entities
   * const updated = await db.users.where(u => eq(u.id, 1)).update({ age: 30 }).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.where(u => eq(u.isActive, true)).update({ lastLogin: new Date() })
   *   .returning(u => ({ id: u.id, lastLogin: u.lastLogin }));
   * ```
   */
  update(data: Partial<Record<string, any>> | ((row: TSelection) => Partial<Record<string, any>>)): FluentQueryUpdate<TSelection> {
    SelectQueryBuilder.assertWritable(this.schema, 'update');
    const queryBuilder = this;

    const executeUpdate = async <TResult>(
      returning?: undefined | true | ((row: TSelection) => TResult) | 'count'
    ): Promise<any> => {
      // Build WHERE clause
      if (!queryBuilder.whereCond) {
        throw new Error('Update requires a WHERE condition. Use where() before update().');
      }

      // Resolve the data object - if a function, invoke it with the column proxy so that
      // expressions like `update(p => ({ col: sql`... ${p.col} ...` }))` resolve the
      // SqlFragment column references against the actual table.
      const resolvedData = typeof data === 'function'
        ? (data as (row: TSelection) => Partial<Record<string, any>>)(queryBuilder._createMockRow() as TSelection)
        : data;

      // Build SET clause
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(resolvedData)) {
        const column = queryBuilder.schema.columns[key];
        if (column) {
          const config = (column as any).build();

          // If the value is a SqlFragment, inline it as a SQL expression
          // (with its own params merged into our values array). This allows
          // expressions like `update({ jsonbCol: sql\`COALESCE(...) || ${patch}::jsonb\` })`
          // to execute as SQL instead of being JSON-serialised as a literal.
          if (value instanceof SqlFragment) {
            const sqlBuildContext: SqlBuildContext = {
              paramCounter: paramIndex,
              params: values,
            };
            const fragmentSql = value.buildSql(sqlBuildContext);
            paramIndex = sqlBuildContext.paramCounter;
            setClauses.push(`"${config.name}" = ${fragmentSql}`);
            continue;
          }

          setClauses.push(`"${config.name}" = $${paramIndex++}`);
          // Apply toDriver mapper if present
          const mappedValue = config.mapper
            ? config.mapper.toDriver(value)
            : value;
          values.push(mappedValue);
        }
      }

      if (setClauses.length === 0) {
        throw new Error('No valid columns to update');
      }

      // Detect navigation property joins from WHERE condition (and build it under the same plan)
      const { whereJoins, whereSql, whereParams } = queryBuilder.buildMutationWhere(paramIndex);
      values.push(...whereParams);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      // Build FROM clause for navigation properties (PostgreSQL syntax for UPDATE with JOINs)
      let fromClause = '';
      let joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);

        if (fromClause) {
          fromClause += `, ${joinTableName} AS "${join.alias}"`;
        } else {
          fromClause = `FROM ${joinTableName} AS "${join.alias}"`;
        }

        // Build ON conditions as part of WHERE clause
        for (let i = 0; i < join.foreignKeys.length; i++) {
          const fk = join.foreignKeys[i];
          const match = join.matches[i];
          joinConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
        }
      }

      // Combine join conditions with the original WHERE clause
      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      // Check if RETURNING uses navigation properties
      const navigationInfo = returning && returning !== 'count' && returning !== true
        ? queryBuilder.detectNavigationInReturning(returning)
        : null;

      if (navigationInfo) {
        // Use CTE-based approach for navigation properties in RETURNING
        let updateSql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')}`;
        if (fromClause) {
          updateSql += ` ${fromClause}`;
        }
        updateSql += ` WHERE ${fullWhereClause}`;

        const { sql, params, read } = queryBuilder.buildReturningWithNavigation(
          updateSql,
          values,
          returning as ((row: TSelection) => TResult),
          navigationInfo
        );

        const result = queryBuilder.executor
          ? await queryBuilder.executor.query(sql, params)
          : await queryBuilder.client.query(sql, params);

        return readReturningRows(result.rows, read, queryBuilder.schemaRegistry);
      }

      // Standard RETURNING (no navigation properties)
      // Qualify columns with table name when using FROM clause to avoid ambiguity
      const hasJoins = whereJoins.length > 0;
      const returningClause = returning !== 'count'
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, hasJoins, { paramCounter: values.length + 1, params: values })
        : undefined;

      let sql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')}`;
      if (fromClause) {
        sql += ` ${fromClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = queryBuilder.executor
        ? await queryBuilder.executor.query(sql, values)
        : await queryBuilder.client.query(sql, values);

      // Return affected count
      if (returning === 'count') {
        return result.rowCount ?? 0;
      }

      if (!returningClause) {
        return undefined;
      }

      return queryBuilder.mapDeleteReturningResults(result.rows, returning, returningClause.read);
    };

    /**
     * Compile the UPDATE into `{ sql, params }` WITHOUT executing — the
     * standard-path assembly (same SET/WHERE/FROM semantics as execution,
     * SqlFragment values and fragment-capable RETURNING included; navigation
     * RETURNING is not supported here). Used to ride the statement as a
     * data-modifying CTE (`DbCteBuilder.withMutation`).
     */
    const compileUpdate = <TResult>(returning?: (row: TSelection) => TResult): { sql: string; params: any[] } => {
      if (!queryBuilder.whereCond) {
        throw new Error('Update requires a WHERE condition. Use where() before update().');
      }

      const resolvedData = typeof data === 'function'
        ? (data as (row: TSelection) => Partial<Record<string, any>>)(queryBuilder._createMockRow() as TSelection)
        : data;

      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(resolvedData)) {
        const column = queryBuilder.schema.columns[key];
        if (column) {
          const config = (column as any).build();

          if (value instanceof SqlFragment) {
            const sqlBuildContext: SqlBuildContext = {
              paramCounter: paramIndex,
              params: values,
            };
            const fragmentSql = value.buildSql(sqlBuildContext);
            paramIndex = sqlBuildContext.paramCounter;
            setClauses.push(`"${config.name}" = ${fragmentSql}`);
            continue;
          }

          setClauses.push(`"${config.name}" = $${paramIndex++}`);
          values.push(config.mapper ? config.mapper.toDriver(value) : value);
        }
      }

      if (setClauses.length === 0) {
        throw new Error('No valid columns to update');
      }

      const { whereJoins, whereSql, whereParams } = queryBuilder.buildMutationWhere(paramIndex);
      values.push(...whereParams);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      let fromClause = '';
      const joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);
        fromClause = fromClause ? `${fromClause}, ${joinTableName} AS "${join.alias}"` : `FROM ${joinTableName} AS "${join.alias}"`;

        for (let i = 0; i < join.foreignKeys.length; i++) {
          joinConditions.push(`${formatJoinValue(sourceTable, join.foreignKeys[i])} = ${formatJoinValue(join.alias, join.matches[i])}`);
        }
      }

      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      // A navigation read renders from the navigation RETURNING's CTE, which a compiled statement
      // does not have — it rendered as the mutated table's column of the same name
      if (returning != null && queryBuilder.detectNavigationInReturning(returning)) {
        throw new Error('toStatement(): navigation RETURNING is not supported in compiled UPDATE statements — select plain or fragment columns only.');
      }

      const returningClause = returning != null
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, whereJoins.length > 0, { paramCounter: values.length + 1, params: values }, true)
        : null;

      let sql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')}`;
      if (fromClause) {
        sql += ` ${fromClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      return { sql, params: values };
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeUpdate(undefined).then(onfulfilled, onrejected);
      },
      affectedCount() {
        return {
          then<T1 = number, T2 = never>(
            onfulfilled?: ((value: number) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeUpdate('count').then(onfulfilled, onrejected);
          }
        };
      },
      toStatement<TResult>(selector?: (row: TSelection) => TResult): { sql: string; params: any[] } {
        return compileUpdate(selector);
      },
      returning<TResult>(selector?: (row: TSelection) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeUpdate(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Build RETURNING clause for delete/update operations
   * @param returning - The returning configuration
   * @param qualifyWithTable - If true, qualify column names with the main table name (needed for DELETE with USING)
   * @param paramContext - Statement parameter state (params array + next $n). Required when the
   *                       selector contains SqlFragments — their parameters append here, which is
   *                       positionally correct because RETURNING is last in the statement text.
   * @internal
   */
  private buildUpdateDeleteReturningClause<TResult>(
    returning: undefined | true | ((row: TSelection) => TResult),
    qualifyWithTable: boolean = false,
    paramContext?: { paramCounter: number; params: any[] },
    compiled: boolean = false
  ): { sql: string; columns: string[]; read?: ReturningReadPlan } | null {
    if (returning === undefined) {
      return null;
    }

    const tablePrefix = qualifyWithTable ? `"${this.schema.name}".` : '';

    if (returning === true) {
      // Return all columns
      const columns = Object.values(this.schema.columns).map(col => (col as any).build().name);
      const sql = columns.map(name => `${tablePrefix}"${name}"`).join(', ');
      return { sql, columns };
    }

    const { selection, scalar } = this.evaluateReturning(returning);

    if (compiled && scalar) {
      throw new Error('toStatement(): the RETURNING selector must return an object — its keys name the columns the compiled statement returns.');
    }

    // Expressions append their parameters to the statement's (RETURNING ends the statement text);
    // headline use case: PG18 `old."col"` capture
    const rendered = renderPlainReturning(selection, {
      isOwnColumn: ref => this.isMutatedRowColumn(ref),
      columnSql: ref => `${tablePrefix}"${ref.__dbColumnName}"`,
      columnMapper: ref => this.returningColumnMapper(ref),
      context: paramContext ?? { paramCounter: 1, params: [] },
      constantsAsParams: compiled,
    });

    return { sql: rendered.sql, columns: rendered.columns, read: { shape: rendered.shape, scalar } };
  }

  /**
   * A RETURNING selector's selection over the mutated row (see returningSelection) — evaluated over
   * this query's projection when it has one.
   */
  private evaluateReturning(returning: (row: TSelection) => unknown): { selection: Record<string, unknown>; scalar: boolean } {
    const mockRow = this._createMockRow();
    const selectedMock = materializeMockSelection(this.selector(mockRow));

    return returningSelection(returning(selectedMock as TSelection));
  }

  /** Whether a ref reads the mutated row itself (not a navigation's table, not another query's row). */
  private isMutatedRowColumn(ref: FieldRef): boolean {
    const tableAlias = (ref as any).__tableAlias as string | undefined;

    return (!tableAlias || tableAlias === this.schema.name) && !isForeignChainRef(ref, this.chainId);
  }

  /**
   * The mapper a RETURNING column reads back through: a column of the mutated row its own — or,
   * through a client that drops a numeric(p, s) zero's scale, the one restoring it — and a
   * navigation's column the mapper of the table it belongs to.
   */
  private returningColumnMapper(ref: FieldRef): { fromDriver(value: any): any } | undefined {
    const fieldRef = ref as any;

    if (!this.isMutatedRowColumn(ref)) {
      return fieldRef.__mapper;
    }

    const cached = this.schema.columnMetadataCache?.get(fieldRef.__fieldName);

    if (cached === undefined) {
      return fieldRef.__mapper;
    }

    if (cached.hasMapper) {
      return cached.mapper;
    }

    return this.client.losesNumericZeroScale() ? numericZeroScaleMapper(cached.config) : undefined;
  }

  /**
   * Map row results for delete/update RETURNING clause
   * @param read - The read plan the RETURNING rendering built (a selector's rows are read through
   *               it, never by matching their keys against the table's columns).
   * @internal
   */
  private mapDeleteReturningResults<TResult>(
    rows: any[],
    returning: undefined | true | ((row: TSelection) => TResult),
    read?: ReturningReadPlan
  ): any[] {
    if (returning === true || read === undefined) {
      // Full entity mapping - apply fromDriver mappers (a numeric(p, s) zero gets back the scale a
      // client dropped). Computed once per call, not per row.
      const restoreZeroScale = this.client.losesNumericZeroScale();
      const columns = [...getSchemaColumnMeta(this.schema)].map(([propName, meta]) => ({
        propName,
        dbName: meta.name!,
        mapper: meta.mapper ?? (restoreZeroScale ? numericZeroScaleMapper(this.schema.columnMetadataCache?.get(propName)?.config ?? {}) : undefined),
      }));

      return rows.map(row => {
        const mapped: any = {};
        for (const { propName, dbName, mapper } of columns) {
          const dbValue = row[dbName];
          mapped[propName] = mapper ? mapper.fromDriver(dbValue) : dbValue;
        }
        return mapped;
      });
    }

    return readReturningRows(rows, read, this.schemaRegistry);
  }

  /**
   * Detect if a RETURNING selector uses navigation properties
   * Returns navigation info if found, null otherwise
   * @internal
   */
  private detectNavigationInReturning<TResult>(
    returning: true | ((row: TSelection) => TResult)
  ): {
    hasNavigation: boolean;
    selection: any;
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
    navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
    nestedObjects?: Map<string, any>;
    collectionFields?: Map<string, any>;
  } | null {
    if (returning === true) {
      // Full entity returning doesn't need navigation support
      return null;
    }

    // Analyze the returning selector
    const { selection } = this.evaluateReturning(returning);

    // Joined under the navigation plan of the selection; buildReturningWithNavigation renders a
    // second evaluation of the same selector under the same (deterministic) plan
    return this.withNavigationPlan(selection, undefined, () => this.resolveReturningNavigation(selection));
  }

  /** The body of {@link detectNavigationInReturning}, run under the selection's navigation plan. */
  private resolveReturningNavigation(selection: any): {
    hasNavigation: boolean;
    selection: any;
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
    navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
    nestedObjects?: Map<string, any>;
    collectionFields?: Map<string, any>;
  } | null {
    const navigationFields = new Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>();
    const allTableAliases = new Set<string>();
    const nestedObjects = new Map<string, any>();
    const collectionFields = new Map<string, any>();
    let expressionReadsNavigation = false;

    // A navigation of the mutated row read by a ref (of a collection, of an `sql` expression) is
    // joined like a projected one
    const collectNavigationRef = (ref: FieldRef): boolean => {
      if (this.isMutatedRowColumn(ref) || isForeignChainRef(ref, this.chainId)) {
        return false;
      }

      if (!this.collectPlannedAliases(ref, allTableAliases)) {
        const refAlias = (ref as any).__tableAlias;
        if (refAlias && refAlias !== this.schema.name) {
          allTableAliases.add(refAlias);
        }
        for (const navAlias of (ref as any).__navigationAliases ?? []) {
          if (navAlias && navAlias !== this.schema.name) {
            allTableAliases.add(navAlias);
          }
        }
      }

      return true;
    };

    // Recursively collect field refs and table aliases from selection
    const collectFieldRefs = (obj: any, path: string = '') => {
      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const classified = classifyReturningValue(field, fieldPath);

        if (classified.kind === 'column') {
          // Direct field reference (either main table or navigation)
          const fieldRef = classified.ref as any;
          const tableAlias = fieldRef.__tableAlias as string | undefined;
          // A navigation of the plan collects the aliases of its whole path
          const planned = this.collectPlannedAliases(fieldRef, allTableAliases);
          if (tableAlias && tableAlias !== this.schema.name) {
            // Navigation field
            if (!planned) {
              allTableAliases.add(tableAlias);
            }
            navigationFields.set(fieldPath, {
              tableAlias,
              dbColumnName: fieldRef.__dbColumnName,
              schemaTable: fieldRef.__sourceTable,
            });
          }
          // Also collect intermediate navigation aliases for multi-level navigation
          if (!planned && Array.isArray(fieldRef.__navigationAliases)) {
            for (const navAlias of fieldRef.__navigationAliases) {
              if (navAlias && navAlias !== this.schema.name) {
                allTableAliases.add(navAlias);
              }
            }
          }
        } else if (classified.kind === 'collection') {
          // CollectionQueryBuilder (.toList(), .firstOrDefault())
          collectionFields.set(fieldPath, field);
          // Also extract the navigation path from the collection builder
          // so we can add the necessary joins to reach the collection's source table
          const collectionBuilder = field as any;
          if (collectionBuilder.navigationPath && Array.isArray(collectionBuilder.navigationPath)) {
            for (const navJoin of collectionBuilder.navigationPath) {
              if (navJoin.alias && navJoin.alias !== this.schema.name) {
                allTableAliases.add(navJoin.alias);
              }
            }
          }
          // Also add the source table alias
          if (collectionBuilder.sourceTable && collectionBuilder.sourceTable !== this.schema.name) {
            allTableAliases.add(collectionBuilder.sourceTable);
          }
          // A navigation of the mutated row the collection reads (in its WHERE, projection or
          // ORDER BY) is joined here like a projected one
          if (field instanceof CollectionQueryBuilder) {
            for (const ref of field.getOuterFieldRefs()) {
              collectNavigationRef(ref);
            }
          }
        } else if (classified.kind === 'expression') {
          // An `sql` expression (or condition) reading a navigation renders from the navigation
          // RETURNING's CTE — the plain RETURNING has no join for it ("missing FROM-clause entry")
          for (const ref of classified.fragment.getFieldRefs()) {
            expressionReadsNavigation = collectNavigationRef(ref) || expressionReadsNavigation;
          }
        } else if (classified.kind === 'nested') {
          // Nested plain object - recurse into it
          nestedObjects.set(fieldPath, field);
          collectFieldRefs(field, fieldPath);
        }
      }
    };

    collectFieldRefs(selection);

    if (navigationFields.size === 0 && nestedObjects.size === 0 && collectionFields.size === 0 && !expressionReadsNavigation) {
      return null;
    }

    // Resolve navigation joins
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    this.resolveJoinsForTableAliases(allTableAliases, joins);

    return { hasNavigation: true, selection, joins, navigationFields, nestedObjects, collectionFields };
  }

  /**
   * Build RETURNING clause with navigation property support using CTE
   * @internal
   */
  private buildReturningWithNavigation<TResult>(
    mutationSql: string,
    mutationParams: any[],
    returning: true | ((row: TSelection) => TResult),
    navigationInfo: {
      selection: any;
      joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
      navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
      nestedObjects?: Map<string, any>;
      collectionFields?: Map<string, any>;
    }
  ): { sql: string; params: any[]; nestedPaths?: Set<string>; read: ReturningReadPlan } {
    const { selection, scalar } = this.evaluateReturning(returning as (row: TSelection) => TResult);

    // The navigation plan detectNavigationInReturning resolved navigationInfo.joins under — the
    // plan is a function of the selection's shape, so this evaluation gets the same aliases
    return this.withNavigationPlan(selection, undefined, () => this.renderReturningWithNavigation(mutationSql, mutationParams, selection, scalar, navigationInfo));
  }

  /** The body of {@link buildReturningWithNavigation}, run under the selection's navigation plan. */
  private renderReturningWithNavigation(
    mutationSql: string,
    mutationParams: any[],
    selection: any,
    scalar: boolean,
    navigationInfo: {
      selection: any;
      joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
      navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
      nestedObjects?: Map<string, any>;
      collectionFields?: Map<string, any>;
    }
  ): { sql: string; params: any[]; nestedPaths?: Set<string>; read: ReturningReadPlan } {
    // Build the CTE wrapping the mutation
    // First, collect all columns needed from the main table in the mutation's RETURNING
    const mainTableColumns = new Set<string>();
    const selectParts: string[] = [];
    const nestedPaths = new Set<string>();

    // Helper to get FK db column name from a schema
    const getFkDbColumnName = (sourceSchema: TableSchema, fkPropName: string): string => {
      const colEntry = Object.entries(sourceSchema.columns).find(([propName, _]) => propName === fkPropName);
      if (colEntry) {
        const config = (colEntry[1] as any).build();
        return config.name;
      }
      return fkPropName; // Fallback to property name
    };

    // Build a map of alias -> source table name for FK lookups
    const aliasToSourceTable = new Map<string, string>();
    aliasToSourceTable.set(this.schema.name, this.schema.name);
    for (const join of navigationInfo.joins) {
      aliasToSourceTable.set(join.alias, join.targetTable);
    }

    // Track collection subqueries for LATERAL JOINs
    const collectionSubqueries: Array<{
      fieldPath: string;
      lateralAlias: string;
      joinClause: string;
      selectExpression: string;
    }> = [];
    let lateralCounter = 0;
    // Track all params including those from collection subqueries
    const allParams = [...mutationParams];
    let currentParamCounter = mutationParams.length + 1;

    // Build a QueryContext for collection subquery building. The mutated row is the "__mutation__"
    // CTE: a collection correlates to it under that name, through the lateral alias map every
    // correlation (and the first hop of a path it hangs off) already resolves the root table by. The
    // collection's SQL used to be rewritten afterwards, table name → alias, which also rewrote the
    // tables of subqueries NESTED in it (an exists() over the root table, or over a joined table's)
    // and was ambiguous for two joins to one table.
    const buildCollectionContext = (): QueryContext => ({
      ctes: new Map(),
      cteCounter: lateralCounter,
      paramCounter: currentParamCounter,
      allParams: allParams,
      collectionStrategy: 'lateral',
      lateralTableAliasMap: new Map([[this.schema.name, '__mutation__']]),
    });

    // A column of the mutated row reads off the CTE, which returns it
    const mutationColumnSql = (ref: FieldRef): string => {
      mainTableColumns.add(ref.__dbColumnName);

      return `"__mutation__"."${ref.__dbColumnName}"`;
    };

    // Recursively process selection to build SELECT parts — and the shape the rows are read by
    const processSelection = (obj: any, path: string = ''): ReturningShape => {
      const shape: ReturningShape = [];

      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const classified = classifyReturningValue(field, fieldPath);

        if (classified.kind === 'constant') {
          // A literal reads back as it is — it used to be dropped from the row
          shape.push({ key, read: { kind: 'constant', value: classified.value } });
        } else if (classified.kind === 'expression') {
          // Columns of the mutated row read off the CTE; a navigation's, off its join
          const context: SqlBuildContext = {
            paramCounter: currentParamCounter,
            params: allParams,
            lateralTableAliasMap: new Map([[this.schema.name, '__mutation__']]),
          };
          const expressionSql = renderReturningExpression(classified.fragment, context, ref => this.isMutatedRowColumn(ref), mutationColumnSql);
          currentParamCounter = context.paramCounter;
          selectParts.push(`${expressionSql} AS "${fieldPath}"`);
          shape.push({ key, read: { kind: 'value', column: fieldPath, mapper: fragmentReadMapper(classified.fragment) } });
        } else if (classified.kind === 'column') {
          // Direct field reference
          const tableAlias = (field as any).__tableAlias as string;
          const dbColumnName = (field as any).__dbColumnName as string;

          if (this.isMutatedRowColumn(classified.ref)) {
            selectParts.push(`${mutationColumnSql(classified.ref)} AS "${fieldPath}"`);
          } else {
            selectParts.push(`"${tableAlias}"."${dbColumnName}" AS "${fieldPath}"`);
          }

          shape.push({ key, read: { kind: 'value', column: fieldPath, mapper: this.returningColumnMapper(classified.ref) } });
        } else if (classified.kind === 'collection') {
          if (!(field instanceof CollectionQueryBuilder)) {
            throw new Error(`RETURNING field "${fieldPath}" is a collection result this RETURNING cannot build`);
          }

          // CollectionQueryBuilder (.toList(), .firstOrDefault())
          // Build a correlated subquery that references joined tables from the main query
          const collectionBuilder = field as CollectionQueryBuilder<any>;
          const context = buildCollectionContext();

          // A column of the mutated row the collection reads renders under "__mutation__" as well,
          // for the build — and the CTE returns it
          const mutatedRowRefs = collectionBuilder.getOuterFieldRefs()
            .filter(ref => (ref as any).__tableAlias === this.schema.name && !isForeignChainRef(ref, this.chainId));
          for (const ref of mutatedRowRefs) {
            mainTableColumns.add(ref.__dbColumnName);
            (ref as any).__tableAlias = '__mutation__';
          }

          // Build the CTE/subquery using lateral strategy. A collection hanging off a path the plan
          // renders under a path alias joins that path itself — bound by name, its correlated form
          // would read the other path's join (see buildProjectedCollection)
          let cteResult: ReturnType<CollectionQueryBuilder<any>['buildCTE']>;
          try {
            cteResult = collectionBuilder.buildCTE(
              context,
              undefined,
              undefined,
              CollectionQueryBuilder.pathRenamedIn(collectionBuilder, this.navigationPlan, this.schema.name)
            );
          } finally {
            for (const ref of mutatedRowRefs) {
              (ref as any).__tableAlias = this.schema.name;
            }
          }
          lateralCounter = context.cteCounter;
          currentParamCounter = context.paramCounter; // Track new param index after collection subquery

          // The mapping reads what the build learned about the collection (a collection selecting
          // ONE value unwraps its items) off the builder that was built
          navigationInfo.collectionFields?.set(fieldPath, collectionBuilder);

          // The lateral strategy returns either:
          // 1. A correlated subquery in selectExpression (no join needed)
          // 2. A LATERAL JOIN with joinClause and selectExpression
          if (cteResult.joinClause && cteResult.joinClause.trim()) {
            collectionSubqueries.push({
              fieldPath,
              lateralAlias: cteResult.tableName || `lateral_${lateralCounter - 1}`,
              joinClause: cteResult.joinClause,
              selectExpression: cteResult.selectExpression || `"${cteResult.tableName}".data`,
            });
            selectParts.push(`${cteResult.selectExpression || `"${cteResult.tableName}".data`} AS "${fieldPath}"`);
          } else if (cteResult.selectExpression) {
            // Correlated subquery in SELECT
            selectParts.push(`${cteResult.selectExpression} AS "${fieldPath}"`);
          }

          // Its items read through their columns' mappers, as a SELECT reads them
          shape.push({ key, read: { kind: 'collection', column: fieldPath, collection: collectionBuilder } });
        } else if (classified.kind === 'nested') {
          // Nested plain object - recurse into it and mark as nested path
          nestedPaths.add(fieldPath);
          shape.push({ key, read: { kind: 'nested', shape: processSelection(field, fieldPath) } });
        }
      }

      return shape;
    };

    const shape = processSelection(selection);

    if (selectParts.length === 0) {
      // Only literals: the statement still yields one row per mutated row
      selectParts.push(`NULL AS "${RETURNING_PLACEHOLDER_COLUMN}"`);
    }

    // Include foreign keys needed for joins - only for joins from main table
    for (const join of navigationInfo.joins) {
      // Only add FK to mainTableColumns if the join source is the main table
      if (join.sourceAlias === this.schema.name || !join.sourceAlias) {
        for (const fk of join.foreignKeys) {
          if (isLiteralKeyPart(fk)) continue; // Skip literal values
          const fkDbCol = getFkDbColumnName(this.schema, fk);
          mainTableColumns.add(fkDbCol);
        }
      }
    }

    // Include 'id' column if there are collection subqueries (needed for correlation)
    if (collectionSubqueries.length > 0 || (navigationInfo.collectionFields && navigationInfo.collectionFields.size > 0)) {
      // Find the 'id' column db name
      const idColEntry = Object.entries(this.schema.columns).find(([propName, _]) => propName === 'id');
      if (idColEntry) {
        const idDbCol = (idColEntry[1] as any).build().name;
        mainTableColumns.add(idDbCol);
      } else {
        // Fallback to 'id' if not found in schema
        mainTableColumns.add('id');
      }
    }

    // Build RETURNING clause for CTE with all needed columns from main table. Qualified by the table:
    // a WHERE reading a navigation joins it into the statement (UPDATE … FROM / DELETE … USING), and a
    // bare column that table has too ("id") was ambiguous
    const cteReturningCols = mainTableColumns.size > 0
      ? Array.from(mainTableColumns).map(col => `"${this.schema.name}"."${col}"`).join(', ')
      : `NULL AS "${RETURNING_PLACEHOLDER_COLUMN}"`;

    // Add RETURNING to the mutation SQL for CTE
    const mutationWithReturning = `${mutationSql} RETURNING ${cteReturningCols}`;

    // Build the JOINs for the outer SELECT
    const joinClauses: string[] = [];
    for (const join of navigationInfo.joins) {
      const qualifiedJoinTable = this.getQualifiedTableName(join.targetTable, join.targetSchema);

      // Find the db column names for the foreign keys
      const joinConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i] || 'id';

        if (isLiteralKeyPart(fk) || isLiteralKeyPart(match)) {
          // Literal key parts don't need column name resolution
          const fkSide = isLiteralKeyPart(fk)
            ? formatJoinValue('', fk)
            : `"${join.sourceAlias === this.schema.name || !join.sourceAlias ? '__mutation__' : join.sourceAlias}"."${getFkDbColumnName(this.schema, fk)}"`;
          const matchSide = formatJoinValue(join.alias, match);
          joinConditions.push(`${fkSide} = ${matchSide}`);
        } else if (join.sourceAlias === this.schema.name || !join.sourceAlias) {
          // FK is on main table - look up db column name from main schema
          const fkDbCol = getFkDbColumnName(this.schema, fk);
          joinConditions.push(`"__mutation__"."${fkDbCol}" = ${formatJoinValue(join.alias, match)}`);
        } else {
          // FK is on an intermediate joined table - look up from its schema
          const sourceTableName = aliasToSourceTable.get(join.sourceAlias);
          const sourceSchema = sourceTableName && this.schemaRegistry ? this.schemaRegistry.get(sourceTableName) : undefined;
          const fkDbCol = sourceSchema ? getFkDbColumnName(sourceSchema, fk) : fk;
          joinConditions.push(`"${join.sourceAlias}"."${fkDbCol}" = ${formatJoinValue(join.alias, match)}`);
        }
      }

      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      joinClauses.push(`${joinType} ${qualifiedJoinTable} AS "${join.alias}" ON ${joinConditions.join(' AND ')}`);
    }

    // Add LATERAL JOINs for collections
    for (const collection of collectionSubqueries) {
      joinClauses.push(collection.joinClause);
    }

    // Build the final CTE query
    const sql = `WITH "__mutation__" AS (
  ${mutationWithReturning}
)
SELECT ${selectParts.join(', ')}
FROM "__mutation__"
${joinClauses.join('\n')}`;

    return { sql, params: allParams, nestedPaths, read: { shape, scalar } };
  }

  /**
   * Create mock row for analysis
   * @internal
   */
  _createMockRow(): any {
    // Prototype-level cache — same pattern as the SelectQueryBuilder mock (see
    // MockRowCache). The signature includes the manual-join shape because join
    // sub-objects are part of the mock's surface; joined queries carry a per-query
    // alias counter, so their signatures are effectively unique and they degrade to
    // the uncached cost (built and discarded per row), while the far more common
    // join-less `qb|<table>` signature hits the shared prototype. Per-query state
    // (`chainId`, FieldRef cache, join sub-objects) lives in symbol-keyed slots read
    // through `this`. Opt-in via the same static switch; OFF = fresh prototype per row
    // (the pre-0.4.70 behaviour).
    const joinSig = this.manualJoins
      .filter(j => !(j as any).isSubquery && j.schema)
      .map(j => `${j.alias}:${j.schema!.name}`)
      .join('+');

    const prototype = MockRowCache.getOrBuild(
      `qb|${this.schema.name}|${joinSig}`,
      () => Object.defineProperties({}, this.buildRootMockDescriptors()),
    );

    const mock: any = Object.create(prototype);
    mock[MOCK_ROW_FIELD_REFS] = {};
    mock[MOCK_ROW_NAV_CACHE] = {};
    mock[MOCK_ROW_CHAIN_ID] = this.chainId;

    return mock;
  }

  /**
   * Builds the shared property-descriptor map for {@link _createMockRow}'s cached path.
   * The getters read per-row state through `this`-bound symbol slots; values captured at
   * build time are signature-constants identical for every row of the signature.
   */
  private buildRootMockDescriptors(): PropertyDescriptorMap {
    const tableAlias = this.schema.name;

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Build a mapper lookup for columns (only when needed)
    const columnMappers: Record<string, any> = {};
    const columnSqlTypes: Record<string, string> = {};
    for (const [colName, meta] of getSchemaColumnMeta(this.schema)) {
      if (meta.mapper) {
        columnMappers[colName] = meta.mapper;
      }
      if (meta.type) {
        columnSqlTypes[colName] = meta.type;
      }
    }

    const descriptors: PropertyDescriptorMap = {};

    // Add columns as FieldRef objects - type-safe with property name and database column name
    for (const [colName, dbColumnName] of columnNameMap) {
      const mapper = columnMappers[colName];
      descriptors[colName] = {
        get(this: any) {
          const slots: MockRowSlots = this;
          const fieldRefCache = slots[MOCK_ROW_FIELD_REFS] ??= {};
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
              __chainId: slots[MOCK_ROW_CHAIN_ID],
              // Include mapper for toDriver transformation in conditions
              __mapper: mapper,
              // Column SQL type — lets flag* emit width-exact mask casts
              __sqlType: columnSqlTypes[colName],
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      };
    }

    // Captured at descriptor-build time — identical for every row of this signature.
    const manualJoins = this.manualJoins;

    // Add columns from manually joined tables
    for (const join of manualJoins) {
      // Skip subquery joins (they don't have a schema)
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

      // The join sub-object is built lazily per row (its FieldRef cache and identity are
      // row-scoped, exactly as the pre-prototype own-property sub-object was) and
      // memoized in the row's navigation slot so repeated accesses share one object.
      const joinSchema = join.schema;
      const joinAlias = join.alias;
      descriptors[joinAlias] = {
        get(this: any) {
          const slots: MockRowSlots = this;
          const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
          let sub = navCache[joinAlias];
          if (sub === undefined) {
            sub = navCache[joinAlias] = {};
            const joinColumnNameMap = getColumnNameMapForSchema(joinSchema);
            const joinFieldRefCache: Record<string, any> = {};
            for (const [colName, dbColumnName] of joinColumnNameMap) {
              Object.defineProperty(sub, colName, {
                get() {
                  let cached = joinFieldRefCache[colName];
                  if (!cached) {
                    cached = joinFieldRefCache[colName] = {
                      __fieldName: colName,
                      __dbColumnName: dbColumnName,
                      __tableAlias: joinAlias,
                    };
                  }
                  return cached;
                },
                enumerable: true,
                configurable: true,
              });
            }
          }
          return sub;
        },
        enumerable: true,
        configurable: true,
      };
    }

    // Performance: Use pre-computed relation entries
    const relationEntries = getRelationEntriesForSchema(this.schema);

    // Values captured at descriptor-build time — identical for every row of this
    // signature (the registry is the process-wide schema registry).
    const schemaRegistry = this.schemaRegistry;
    const sourceTableName = this.schema.name;

    // Add relations as CollectionQueryBuilder or ReferenceQueryBuilder
    for (const [relName, relConfig] of relationEntries) {
      // Try to get target schema from registry (preferred, has full relations) or cached schema
      let targetSchema: TableSchema | undefined;
      if (schemaRegistry) {
        targetSchema = schemaRegistry.get(relConfig.targetTable);
      }
      if (!targetSchema) {
        // Performance: Use cached target schema
        targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);
      }

      if (relConfig.type === 'many') {
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        descriptors[relName] = {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              sourceTableName,
              targetSchema,  // Pass the target schema directly
              schemaRegistry,  // Pass schema registry for nested resolution
              undefined,
              relConfig.foreignKeys,  // Propagate composite FK / literal predicates
              relConfig.matches
            );
          },
          enumerable: false,
          configurable: true,
        };
      } else {
        // For single reference (many-to-one), create a ReferenceQueryBuilder
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        const holder: MockPrototypeHolder = {};
        descriptors[relName] = {
          get(this: any) {
            // One mock target row per row and relation (a selector reading `p.user.*` several
            // times used to mint a builder and a row per access)
            const slots: MockRowSlots = this;
            const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
            const cachedRow = navCache[relName];
            if (cachedRow !== undefined) {
              return cachedRow;
            }
            if (holder.prototype !== undefined && MockRowCache.isEnabled()) {
              return (navCache[relName] = mintReferenceMockRow(holder.prototype, slots[MOCK_ROW_CHAIN_ID]));
            }
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,  // Pass the target schema directly
              schemaRegistry,  // Pass schema registry for nested resolution
              [],  // Empty navigation path for first level navigation
              sourceTableName  // Pass source table name for lateral join correlation
            );
            // Return a mock object that exposes the target table's columns
            return (navCache[relName] = refBuilder.createMockTargetRow(holder, slots[MOCK_ROW_CHAIN_ID]));
          },
          enumerable: false,
          configurable: true,
        };
      }
    }

    return descriptors;
  }

  /**
   * Create a proxy that wraps selected values and returns FieldRefs for property access
   * This enables orderBy and other operations to work with chained selects
   * @param preserveOriginal - If true (for WHERE), preserve original column names; if false (for ORDER BY), use alias names
   */
  private createFieldRefProxy(selectedMock: any, preserveOriginal: boolean = false): any {
    if (!selectedMock || typeof selectedMock !== 'object') {
      return selectedMock;
    }

    // If it already has FieldRef properties, return as-is
    if ('__fieldName' in selectedMock && '__dbColumnName' in selectedMock) {
      return selectedMock;
    }

    // Create a proxy that returns FieldRefs for each property access
    return new Proxy(selectedMock, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then') {
          return target[prop];
        }

        const value = target[prop];

        // If the value is already a FieldRef
        if (value && typeof value === 'object' && '__fieldName' in value && '__dbColumnName' in value) {
          if (preserveOriginal) {
            // For WHERE: preserve original column name, table alias, mapper, and navigation aliases
            // This ensures WHERE references the actual database column with proper type conversion
            // and can resolve intermediate JOINs for multi-level navigation
            const fieldRef: any = {
              __fieldName: prop as string,
              __dbColumnName: (value as any).__dbColumnName,
              __tableAlias: (value as any).__tableAlias,
              __mapper: (value as any).__mapper,  // Preserve mapper for toDriver in conditions
            };
            if ((value as any).__navigationAliases) {
              fieldRef.__navigationAliases = (value as any).__navigationAliases;
            }
            if ((value as any).__sourceTable) {
              fieldRef.__sourceTable = (value as any).__sourceTable;
            }
            if ((value as any).__joinPath) {
              fieldRef.__joinPath = (value as any).__joinPath;
            }
            return fieldRef;
          } else {
            // For ORDER BY: use the alias (property name) as the column name
            // In chained selects, the alias becomes the column name in the subquery
            return {
              __fieldName: prop as string,
              __dbColumnName: prop as string,
              // No table alias - column comes from the selection/subquery
            };
          }
        }

        // If the value is a SqlFragment, treat it as a FieldRef using the property name as the alias
        if (value && typeof value === 'object' && value instanceof SqlFragment) {
          return {
            __fieldName: prop as string,
            __dbColumnName: prop as string,
          };
        }

        // Navigation builders (hasMany -> CollectionQueryBuilder, hasOne ->
        // ReferenceQueryBuilder, and nested QueryBuilders surfaced via
        // mock-row getters) must pass through untouched, so callers like
        // `exists(p.children.where(...))` can still reach .where(), .exists(),
        // .select() etc. on the second .where() call (where the row has been
        // wrapped in this proxy via DbEntityTable.where()'s all-columns
        // selector). Wrapping them in another get-trap proxy turned their
        // methods into FieldRef objects and produced
        // "TypeError: p.<navProp>.where is not a function".
        if (
          value instanceof CollectionQueryBuilder
          || value instanceof ReferenceQueryBuilder
          || value instanceof QueryBuilder
          || value instanceof SelectQueryBuilder
        ) {
          return value;
        }

        // If the value is an object (nested selection), recursively wrap it
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return this.createFieldRefProxy(value, preserveOriginal);
        }

        // For primitive values or arrays, create a FieldRef
        // Use the property name as both fieldName and dbColumnName
        return {
          __fieldName: prop as string,
          __dbColumnName: prop as string,
        };
      }
    });
  }

  /**
   * Detect navigation property references in selection and add necessary JOINs
   * Supports multi-level navigation like task.level.createdBy
   */
  /**
   * Try to build flat SQL SELECT parts for a nested object containing FieldRefs.
   * Uses path-encoded aliases (e.g., __nested__address__street) for JS-side reconstruction.
   * This is more performant than json_build_object() as it avoids JSON serialization overhead.
   *
   * @param obj The nested object from the selector
   * @param context Query context for parameter tracking
   * @param joins Array to add necessary JOINs
   * @param selectParts Array to add SELECT parts to
   * @param pathPrefix Current path prefix for alias encoding (e.g., "__nested__address")
   * @param nestedPaths Set to track all nested paths for reconstruction
   * @returns true if handled as nested object, false if not a valid nested object
   */
  private tryBuildFlatNestedSelect(
    obj: any,
    context: QueryContext,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    selectParts: string[],
    pathPrefix: string,
    nestedPaths: Set<string>
  ): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return false;
    }

    // A collection at ANY depth takes the caller's collection-aware path — decided before anything
    // is emitted. A collection found half-way used to return false after the siblings' columns were
    // already in the SELECT list.
    if (this.hasNestedCollections(obj)) {
      return false;
    }

    // Track this path as a nested object
    nestedPaths.add(pathPrefix);

    for (const [nestedKey, nestedValue] of entries) {
      this.renderFlatNestedLeaf(nestedValue, `${pathPrefix}__${nestedKey}`, context, joins, selectParts, (inner, innerPath) => {
        // An empty nested object has no column to read (and is left out)
        this.tryBuildFlatNestedSelect(inner, context, joins, selectParts, innerPath, nestedPaths);
      });
    }

    return true;
  }

  /**
   * One value of a flattened nested object: an `sql` expression (a subquery renders as one), a
   * column (its navigation joined), NULL, a nested object flattened further by `recurse` (a
   * navigation row projected whole flattens as its columns), or a value bound as a parameter — a
   * Date or any class instance included. A Date used to be walked as a nested object: with no own
   * keys it made the whole object fall off the flat path after its siblings' columns were emitted,
   * and the object was then bound as ONE parameter, mock column refs and all.
   */
  private renderFlatNestedLeaf(
    nestedValue: unknown,
    fieldPath: string,
    context: QueryContext,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    selectParts: string[],
    recurse: (inner: Record<string, unknown>, fieldPath: string) => void
  ): void {
    if (nestedValue instanceof SqlFragment || nestedValue instanceof Subquery) {
      // SQL Fragment - build the SQL expression
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragment = nestedValue instanceof SqlFragment ? nestedValue : new SqlFragment(['', ''], [nestedValue]);
      const fragmentSql = fragment.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      selectParts.push(`${fragmentSql} as "${fieldPath}"`);
    } else if (typeof nestedValue === 'object' && nestedValue !== null && '__dbColumnName' in nestedValue) {
      // FieldRef - extract table alias and column name
      const ref = nestedValue as any;
      const tableAlias = ref.__tableAlias ? ref.__tableAlias as string : this.schema.name;
      const columnName = ref.__dbColumnName as string;

      // Add JOIN if needed for navigation fields
      if (tableAlias !== this.schema.name) {
        const relConfig = this.relationForRef(ref, tableAlias);
        if (relConfig && !joins.find(j => j.alias === tableAlias)) {
          let targetSchema: string | undefined;
          if (relConfig.targetTableBuilder) {
            const targetTableSchema = relConfig.targetTableBuilder.build();
            targetSchema = targetTableSchema.schema;
          }
          joins.push({
            alias: tableAlias,
            targetTable: relConfig.targetTable,
            targetSchema,
            foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
            matches: relConfig.matches || [],
            isMandatory: relConfig.isMandatory ?? false,
          });
        }
      }

      selectParts.push(`"${tableAlias}"."${columnName}" as "${fieldPath}"`);
    } else if (nestedValue === undefined || nestedValue === null) {
      selectParts.push(`NULL as "${fieldPath}"`);
    } else if (typeof nestedValue === 'object' && isReferenceMockRow(nestedValue)) {
      // A navigation row projected whole: its columns
      recurse(materializeMockSelection(nestedValue), fieldPath);
    } else if (isPlainNestedProjection(nestedValue)) {
      // Recursively handle deeper nested objects
      recurse(nestedValue, fieldPath);
    } else {
      // Literal value (string, number, boolean, Date, a list of values) — a list of columns has no
      // one SQL value: it used to be bound as a parameter, the mock column refs serialized into it
      assertProjectionArrayOfValues(nestedValue, fieldPath.substring('__nested__'.length).split('__').join('.'), 'select()');
      selectParts.push(`${projectionLiteralSql(nestedValue, context)} as "${fieldPath}"`);
    }
  }

  /**
   * Reconstruct nested objects from flat row data with path-encoded column names.
   * Transforms { "__nested__address__street": "Main St", "__nested__address__city": "NYC" }
   * into { address: { street: "Main St", city: "NYC" } }
   * Also handles nested collections with paths like "__nested__content__posts"
   * Values are left as the driver read them: each is read through its own field's read by
   * transformResults (a count's numeric string becomes a number there, a text column's '01234' stays
   * text — every nested numeric-looking string used to become a number here).
   */
  private reconstructNestedObjects(row: any, nestedPaths: Set<string>): any {
    if (nestedPaths.size === 0) {
      return row;
    }

    const result: any = {};
    const nestedPrefix = '__nested__';

    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(nestedPrefix)) {
        // This is a nested field - parse the path and set the value
        const pathParts = key.substring(nestedPrefix.length).split('__');
        let current = result;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!(part in current)) {
            current[part] = {};
          }
          current = current[part];
        }
        current[pathParts[pathParts.length - 1]] = value;
      } else {
        // Regular field
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Check if an object contains any CollectionQueryBuilder instances (recursively)
   */
  private hasNestedCollections(obj: any): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }

    for (const value of Object.values(obj)) {
      if (value instanceof CollectionQueryBuilder) {
        return true;
      }
      if (value && typeof value === 'object' && '__collectionResult' in value) {
        return true;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value)) {
        if (this.hasNestedCollections(value)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Build flat SQL SELECT parts for a nested object, excluding collections.
   * Collections are added to collectionFields for separate handling.
   */
  private tryBuildFlatNestedSelectExcludingCollections(
    obj: any,
    context: QueryContext,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    selectParts: string[],
    pathPrefix: string,
    nestedPaths: Set<string>,
    collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string; parentKey?: string }>
  ): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    // Track this path as a nested object
    nestedPaths.add(pathPrefix);

    for (const [nestedKey, nestedValue] of Object.entries(obj)) {
      const fieldPath = `${pathPrefix}__${nestedKey}`;

      // Check if this is a collection - handle it separately
      if (nestedValue instanceof CollectionQueryBuilder || (nestedValue && typeof nestedValue === 'object' && '__collectionResult' in nestedValue)) {
        // Build CTE for collection and add to collectionFields
        const cteData = this.buildProjectedCollection(nestedValue, context);
        const isCTE = cteData.isCTE !== false;

        collectionFields.push({
          name: fieldPath, // Use full path as the name
          cteName: cteData.tableName || `cte_${context.cteCounter - 1}`,
          isCTE,
          joinClause: cteData.joinClause,
          selectExpression: cteData.selectExpression,
          parentKey: cteData.parentKey,
        });
        continue;
      }

      this.renderFlatNestedLeaf(nestedValue, fieldPath, context, joins, selectParts, (inner, innerPath) => {
        this.tryBuildFlatNestedSelectExcludingCollections(inner, context, joins, selectParts, innerPath, nestedPaths, collectionFields);
      });
    }
  }

  /**
   * Runs one build under the navigation plan of `selection` (the projection, when the build has one),
   * `condition` (its WHERE) and `extraRefs`: every reference-navigation path they traverse is joined
   * on its own parent, and the refs of a path that lost its plain alias to another path ending in the
   * same relation name render under a path alias until `build` returns. See NavigationAliasPlan.
   */
  private withNavigationPlan<T>(
    selection: unknown,
    condition: Condition | undefined,
    build: () => T,
    extraRefs?: readonly unknown[]
  ): T {
    const plan = new NavigationAliasPlan(this.schema, this.schema.name, this.schemaRegistry, this.chainId);
    const collectionPaths: string[][] = [];
    this.addSelectionToNavigationPlan(selection, plan, collectionPaths);

    if (condition) {
      for (const ref of condition.getFieldRefs()) {
        plan.addRef(ref);
      }
    }

    if (extraRefs) {
      for (const ref of extraRefs) {
        plan.addRef(ref);
      }
    }

    // After every ref: at equal depth, a path a field reads keeps the plain alias
    for (const path of collectionPaths) {
      plan.addPath(path);
    }

    const sealed = plan.seal();
    const previous = this.navigationPlan;
    this.navigationPlan = sealed;
    const restore = sealed?.apply();

    try {
      return build();
    } finally {
      restore?.();
      this.navigationPlan = previous;
    }
  }

  /**
   * Records the navigation paths a projection traverses: its field refs, the refs inside its `sql`
   * fragments and nested objects, and navigation rows projected whole (which render from the table
   * their first column's ref names). Collections and subqueries plan their own; the path a collection
   * hangs off (when it starts at the root) goes to `collectionPaths`.
   */
  private addSelectionToNavigationPlan(value: unknown, plan: NavigationAliasPlan, collectionPaths: string[][]): void {
    if (value === null || typeof value !== 'object') {
      return;
    }

    if ('__dbColumnName' in value) {
      plan.addRef(value);
      return;
    }

    if (value instanceof SqlFragment) {
      for (const ref of value.getFieldRefs()) {
        plan.addRef(ref);
      }
      return;
    }

    if (value instanceof CollectionQueryBuilder) {
      // The refs by which it reads our row are ours to join (and alias)
      for (const ref of value.getOuterFieldRefs()) {
        plan.addRef(ref);
      }

      const path = value.getNavigationPath();

      if (path.length > 0 && path[0].sourceAlias === this.schema.name) {
        collectionPaths.push(path.map(step => step.alias));
      }
      return;
    }

    if (Array.isArray(value) || value instanceof ReferenceQueryBuilder || value instanceof Subquery) {
      return;
    }

    // A navigation row projected whole renders as its columns: each is a ref of its path (a path
    // alias renames them all — naming only the first left the others under the plain alias)
    if (isReferenceMockRow(value)) {
      const columns = materializeMockSelection(value);

      for (const key in columns) {
        plan.addRef(columns[key]);
      }
      return;
    }

    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        this.addSelectionToNavigationPlan((value as any)[key], plan, collectionPaths);
      }
    }
  }

  /** Adds the joins of a planned navigation hop and of every hop above it, each on its own parent. */
  private addPlannedJoins(
    node: NavigationPathNode,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    if (node.parent !== undefined) {
      this.addPlannedJoins(node.parent, joins);
    }

    if (!joins.some(join => join.alias === node.alias)) {
      joins.push(this.navigationPlan!.joinOf(node));
    }
  }

  private detectAndAddJoinsFromSelection(selection: any, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    // A selector returning one column or expression: its navigations are joined like a field's
    // (`e => e.book.name` used to render without the join — "missing FROM-clause entry")
    if (isScalarSelection(selection)) {
      selection = { value: selection };
    }

    // Navigations of a manually joined table name their joins themselves — added first, verbatim
    this.addExplicitJoinPathsFromSelection(selection, joins);

    // First pass: collect all table aliases
    const allTableAliases = new Set<string>();
    this.collectTableAliasesFromSelection(selection, allTableAliases);

    // Second pass: resolve all joins through the schema graph
    this.resolveJoinsForTableAliases(allTableAliases, joins);
  }

  /**
   * Builds a projected collection. When the build's navigation plan renders the last hop of the path
   * the collection hangs off under another alias (another path owns the relation name), the collection
   * must not correlate to the root's join of that name — see CollectionQueryBuilder.buildCTE.
   */
  private buildProjectedCollection(value: any, context: QueryContext): { sql: string; params: any[]; isCTE?: boolean; joinClause?: string; selectExpression?: string; tableName?: string; memoId?: number; parentKey?: string } {
    const joinOwnPath = value instanceof CollectionQueryBuilder
      && CollectionQueryBuilder.pathRenamedIn(value, this.navigationPlan, this.schema.name);
    const built = value.buildCTE(context, undefined, undefined, joinOwnPath);

    return value instanceof CollectionQueryBuilder ? { ...built, parentKey: this.collectionParentKeySql(value) } : built;
  }

  /**
   * The parent key a CTE aggregate of `collection` joins back on: the collection's principal key
   * column (`withPrincipalKey`, `id` by default) of the row it hangs off — the root row, or the last
   * hop of the navigation path it hangs off, under that hop's (planned) alias. The CTE join used to
   * name the root's `id` for every collection, pairing a path's aggregate with the ROOT row's id.
   */
  private collectionParentKeySql(collection: CollectionQueryBuilder<any>): string {
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    const key = collection.getParentKeyColumn();
    const path = collection.getNavigationPath();

    if (path.length === 0 || path[0].sourceAlias !== this.schema.name) {
      return key === 'id' ? `${qualifiedTableName}.id` : `${qualifiedTableName}."${key}"`;
    }

    const node = this.navigationPlan?.nodeForPath(path.map(step => step.alias));

    return `"${node?.alias ?? path[path.length - 1].alias}"."${key}"`;
  }

  /**
   * Joins the navigation path of every projected collection whose SQL reads the path's last hop
   * from THIS scope (see CollectionQueryBuilder.correlatesThroughEnclosingPath): a count, flat list
   * or CTE / temp-table aggregate over `ln.edition.book.editions` correlates to `"book"."id"`, which
   * used to be joined only when the projection happened to read `book` too (`missing FROM-clause
   * entry for table "book"`).
   */
  private addCollectionPathJoins(
    selection: any,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    strategy: CollectionStrategyType
  ): void {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || selection instanceof SqlFragment || '__dbColumnName' in selection || isReferenceMockRow(selection)) {
      return;
    }

    for (const key in selection) {
      if (!Object.prototype.hasOwnProperty.call(selection, key)) {
        continue;
      }

      const value = selection[key];

      if (value instanceof CollectionQueryBuilder) {
        const path = value.getNavigationPath();

        if (path.length === 0 || path[0].sourceAlias !== this.schema.name || !value.correlatesThroughEnclosingPath(strategy)) {
          continue;
        }

        const node = this.navigationPlan?.nodeForPath(path.map(step => step.alias));

        if (node !== undefined) {
          this.addPlannedJoins(node, joins);
          continue;
        }

        for (const step of path) {
          if (!joins.some(join => join.alias === step.alias)) {
            joins.push({
              alias: step.alias,
              targetTable: step.targetTable,
              targetSchema: step.targetSchema,
              foreignKeys: step.foreignKeys,
              matches: step.matches,
              isMandatory: step.isMandatory,
              sourceAlias: step.sourceAlias,
            });
          }
        }
      } else if (value && typeof value === 'object' && !(value instanceof Subquery)) {
        this.addCollectionPathJoins(value, joins, strategy);
      }
    }
  }

  /**
   * A collection of a MANUALLY joined table — or of a navigation below one — correlates to the
   * join's alias. The LATERAL strategy renders exactly that; the CTE and temp-table strategies
   * attach their aggregate to the ROOT row's id and would pair it with the wrong parent without an
   * error, so they refuse it.
   */
  private assertJoinedCollectionStrategy(value: unknown, context: QueryContext): void {
    const strategy = context.collectionStrategy || 'lateral';

    if (strategy === 'lateral' || !(value instanceof CollectionQueryBuilder)) {
      return;
    }

    const path = value.getNavigationPath();
    const anchor = path.length > 0 ? path[0].sourceAlias : value.getSourceAlias();

    if (this.manualJoins.some(join => join.alias === anchor)) {
      throw new Error(
        `The collection "${value.getRelationName()}" of the joined table "${value.getSourceAlias()}" needs the 'lateral' `
        + `collection strategy: the '${strategy}' strategy attaches a collection to the root row.`
      );
    }
  }

  /**
   * Adds the joins of every navigation hop below a MANUALLY joined table that the selection
   * reaches: the `__joinPath` of a column read through such a navigation, and the navigation
   * path of a collection hanging off one. Those hops render under explicit aliases
   * (explicitNavigationAlias) that the by-name resolution cannot find — and must not: by name,
   * `post.user` would bind to the root's own `user`.
   */
  private addExplicitJoinPathsFromSelection(
    selection: any,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    // A navigation row projected whole renders as its columns (own-property walks see none of them)
    for (const value of Object.values(materializeMockSelection(selection))) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      if (value instanceof CollectionQueryBuilder) {
        const path = value.getNavigationPath();

        if (path.length > 0 && this.manualJoins.some(join => join.alias === path[0].sourceAlias)) {
          addExplicitJoinPath(path, joins);
        }
      } else if (value instanceof SqlFragment) {
        for (const fieldRef of value.getFieldRefs()) {
          addExplicitJoinPath((fieldRef as any).__joinPath, joins);
        }
      } else if ('__dbColumnName' in value) {
        addExplicitJoinPath((value as any).__joinPath, joins);
      } else if (!Array.isArray(value)) {
        this.addExplicitJoinPathsFromSelection(value, joins);
      }
    }
  }

  /**
   * Collect all table aliases from a selection
   */
  private collectTableAliasesFromSelection(selection: any, allTableAliases: Set<string>): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    // A navigation row projected whole renders as its columns (own-property walks see none of them)
    for (const [_key, value] of Object.entries(materializeMockSelection(selection))) {
      // A ref from another chain is a correlation to an enclosing query, which already has
      // that table in scope — resolving it here would join a second copy of it into this
      // subquery. Same rule as the WHERE path; see isForeignChainRef.
      if (isForeignChainRef(value, this.chainId)) {
        continue;
      }

      if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
        // A navigation of the build's plan collects the aliases of its own path, in the same order
        if (this.collectPlannedAliases(value, allTableAliases)) {
          continue;
        }

        // This is a FieldRef with a table alias
        const tableAlias = value.__tableAlias as string;
        if (tableAlias && tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
        // Also collect intermediate navigation aliases for multi-level navigation (e.g., task.level.name)
        if ('__navigationAliases' in value && Array.isArray((value as any).__navigationAliases)) {
          for (const navAlias of (value as any).__navigationAliases) {
            if (navAlias && navAlias !== this.schema.name) {
              allTableAliases.add(navAlias);
            }
          }
        }
      } else if (value instanceof SqlFragment) {
        // SqlFragment may contain navigation property references
        const fieldRefs = value.getFieldRefs();
        for (const fieldRef of fieldRefs) {
          if (isForeignChainRef(fieldRef, this.chainId)) {
            continue;
          }

          if (this.collectPlannedAliases(fieldRef, allTableAliases)) {
            continue;
          }

          if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
            const tableAlias = fieldRef.__tableAlias as string;
            if (tableAlias && tableAlias !== this.schema.name) {
              allTableAliases.add(tableAlias);
            }
          }
          // Also collect intermediate navigation aliases for multi-level navigation
          if ('__navigationAliases' in fieldRef && Array.isArray((fieldRef as any).__navigationAliases)) {
            for (const navAlias of (fieldRef as any).__navigationAliases) {
              if (navAlias && navAlias !== this.schema.name) {
                allTableAliases.add(navAlias);
              }
            }
          }
        }
      } else if (value instanceof CollectionQueryBuilder) {
        // What a projected collection reads from OUR row — a column of a navigation of ours, in its
        // WHERE, projection or ORDER BY — must be in scope for its subquery to bind
        this.collectTableAliasesFromSelection(value.getOuterFieldRefs(), allTableAliases);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Recursively check nested objects
        this.collectTableAliasesFromSelection(value, allTableAliases);
      }
    }
  }

  /**
   * Adds the aliases of the path `ref` navigates — its own first, then its ancestors' from the root
   * down, the order `__tableAlias` + `__navigationAliases` have always been collected in — when the
   * build's navigation plan knows the path. False for any other ref.
   */
  private collectPlannedAliases(ref: unknown, allTableAliases: Set<string>): boolean {
    const planned = this.navigationPlan?.nodeOf(ref);

    if (planned === undefined) {
      return false;
    }

    for (const alias of planned.collectOrder) {
      allTableAliases.add(alias);
    }

    return true;
  }

  /**
   * The relation `ref` navigates, or `undefined` when `ref` does not belong to this query.
   *
   * Every inline "field ref -> relation -> JOIN" site routes through here instead of reading
   * `this.schema.relations[alias]` directly, because the alias alone cannot tell a navigation
   * of OURS from a correlation to an enclosing query: a relation name may equal an outer
   * table's alias (a child's `library` navigation against a parent table also called
   * `library`). Joining on that name pulls a second copy of the outer table into this query
   * and rebinds the correlation to it — the predicate then compares the inner row with
   * itself and is true for every row, with no SQL error and no type error to show for it.
   *
   * See isForeignChainRef for how the two are told apart.
   */
  private relationForRef(ref: any, tableAlias: string): any {
    if (isForeignChainRef(ref, this.chainId)) {
      return undefined;
    }

    return this.schema.relations[tableAlias];
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph
   * This handles multi-level navigation like task.level.createdBy
   */
  private resolveJoinsForTableAliases(
    allTableAliases: Set<string>,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    if (allTableAliases.size === 0) {
      return;
    }

    // Keep resolving until we've resolved all aliases or can't make progress
    const resolved = new Set<string>();
    let maxIterations = allTableAliases.size * 3; // Prevent infinite loops

    while (resolved.size < allTableAliases.size && maxIterations-- > 0) {
      // Build a map of already joined schemas for path resolution
      const joinedSchemas = new Map<string, TableSchema>();
      joinedSchemas.set(this.schema.name, this.schema);

      for (const join of joins) {
        // A hop below a manually joined table is not a place to look for a root chain's next hop
        if (explicitJoinEntries.has(join)) {
          continue;
        }

        let schema: TableSchema | undefined;
        if (this.schemaRegistry) {
          schema = this.schemaRegistry.get(join.targetTable);
        }
        if (schema) {
          joinedSchemas.set(join.alias, schema);
        }
      }

      // Try to resolve each unresolved alias
      for (const alias of allTableAliases) {
        if (resolved.has(alias) || joins.some(j => j.alias === alias)) {
          resolved.add(alias);
          continue;
        }

        // A path of the build's navigation plan hangs off its OWN parent, once that is joined —
        // never off whichever joined table happens to have a relation of the same name
        const planned = this.navigationPlan?.nodeForAlias(alias);
        if (planned !== undefined) {
          if (planned.parent === undefined || joinedSchemas.has(planned.parent.alias)) {
            joins.push(this.navigationPlan!.joinOf(planned));
            resolved.add(alias);
          }
          continue;
        }

        // Look for this alias in any of the already joined schemas
        for (const [sourceAlias, schema] of joinedSchemas) {
          if (schema.relations && schema.relations[alias]) {
            const relation = schema.relations[alias];
            if (relation.type === 'one') {
              // Get target schema
              let targetSchema: TableSchema | undefined;
              let targetSchemaName: string | undefined;

              if (this.schemaRegistry) {
                targetSchema = this.schemaRegistry.get(relation.targetTable);
                targetSchemaName = targetSchema?.schema;
              }
              if (!targetSchema && relation.targetTableBuilder) {
                targetSchema = relation.targetTableBuilder.build();
                targetSchemaName = targetSchema?.schema;
              }

              joins.push({
                alias,
                targetTable: relation.targetTable,
                targetSchema: targetSchemaName,
                foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
                matches: relation.matches || ['id'],
                isMandatory: relation.isMandatory ?? false,
                sourceAlias,  // Track where this join comes from
              });
              resolved.add(alias);
              break;
            }
          }
        }
      }
    }
  }

  /**
   * Add a JOIN for a FieldRef if it references a related table
   * @deprecated Use detectAndAddJoinsFromSelection with multi-level resolution instead
   */
  private addJoinForFieldRef(fieldRef: any, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!fieldRef || typeof fieldRef !== 'object' || !('__tableAlias' in fieldRef) || !('__dbColumnName' in fieldRef)) {
      return;
    }

    const tableAlias = fieldRef.__tableAlias as string;
    if (tableAlias && tableAlias !== this.schema.name && !joins.some(j => j.alias === tableAlias)) {
      // This references a related table - find the relation and add a JOIN
      const relation = this.relationForRef(fieldRef, tableAlias);
      if (relation && relation.type === 'one') {
        // Get target schema from targetTableBuilder if available
        let targetSchema: string | undefined;
        if (relation.targetTableBuilder) {
          const targetTableSchema = relation.targetTableBuilder.build();
          targetSchema = targetTableSchema.schema;
        }

        // Add a JOIN for this reference
        joins.push({
          alias: tableAlias,
          targetTable: relation.targetTable,
          targetSchema,
          foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
          matches: relation.matches || [],
          isMandatory: relation.isMandatory ?? false,
        });
      }
    }
  }

  /**
   * Detect navigation property references in a WHERE condition and add necessary JOINs
   */
  private detectAndAddJoinsFromCondition(condition: Condition | undefined, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!condition) {
      return;
    }

    // Collect all table aliases from the condition
    const allTableAliases = new Set<string>();
    const correlatedAliases = new Set<string>();
    const fieldRefs = condition.getFieldRefs();

    for (const fieldRef of fieldRefs) {
      // A ref minted by a DIFFERENT chain belongs to an enclosing query: it is a
      // CORRELATION, not one of our navigations, and the outer query already has that
      // table in scope. Joining it here would resolve the alias against OUR relations and
      // pull in a second, inner copy of the outer table — see isForeignChainRef.
      if (isForeignChainRef(fieldRef, this.chainId)) {
        if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
          correlatedAliases.add(fieldRef.__tableAlias as string);
        }
        continue;
      }

      // A navigation of the build's plan collects the aliases of its own path
      if (this.collectPlannedAliases(fieldRef, allTableAliases)) {
        continue;
      }

      if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
        const tableAlias = fieldRef.__tableAlias as string;
        if (tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
      }
      // Also collect intermediate navigation aliases for multi-level navigation (e.g., task.level.name)
      // The field ref may have __navigationAliases containing all aliases in the path
      if ('__navigationAliases' in fieldRef && Array.isArray((fieldRef as any).__navigationAliases)) {
        for (const navAlias of (fieldRef as any).__navigationAliases) {
          if (navAlias && navAlias !== this.schema.name) {
            allTableAliases.add(navAlias);
          }
        }
      }
      // A navigation of a manually joined table names its joins itself (see explicitNavigationAlias)
      addExplicitJoinPath((fieldRef as any).__joinPath, joins);
    }

    // Kept for the second, wider check once the SELECT list has added its own joins: the
    // colliding navigation can be named ONLY in the projection, which this method never sees.
    this.correlatedAliasesFromCondition = correlatedAliases;

    // Refuse the one shape that cannot be rendered — see assertNoCorrelatedAliasShadowing.
    assertNoCorrelatedAliasShadowing(this.schema.name, correlatedAliases, allTableAliases);

    // Resolve all joins through the schema graph
    this.resolveJoinsForTableAliases(allTableAliases, joins);
  }

  /**
   * Build SQL query — under the navigation plan of the projection and the WHERE (see withNavigationPlan)
   */
  private buildQuery(selection: any, context: QueryContext): { sql: string; params: any[]; nestedPaths: Set<string> } {
    return this.withNavigationPlan(selection, this.whereCond, () => this.buildQueryBody(selection, context), this.orderByRefs());
  }

  /** The body of {@link buildQuery}. */
  private buildQueryBody(selection: any, context: QueryContext): { sql: string; params: any[]; nestedPaths: Set<string> } {
    // Handle user-defined CTEs first - their params need to come before main query params
    for (const cte of this.ctes) {
      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    const selectParts: string[] = [];
    const collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string; parentKey?: string }> = [];
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    const nestedPaths: Set<string> = new Set(); // Track nested object paths for JS-side reconstruction

    // Scan selection for navigation property references and add JOINs
    this.detectAndAddJoinsFromSelection(selection, joins);

    // Scan WHERE condition for navigation property references and add JOINs
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // ORDER BY keys read through a navigation the projection does not select are joined too
    const orderByRefs = this.orderByRefs();
    if (orderByRefs.length > 0) {
      this.detectAndAddJoinsFromSelection(orderByRefs, joins);
    }

    // So is the path a projected collection correlates through
    this.addCollectionPathJoins(selection, joins, context.collectionStrategy || 'lateral');

    // Repeat the shadow check now that the SELECT list has contributed its joins: the colliding
    // navigation can be named ONLY in the projection, where the WHERE-time check cannot see it.
    // EXISTS ignores the select list, so nothing else would catch that shape.
    assertNoCorrelatedAliasShadowing(
      this.schema.name,
      this.correlatedAliasesFromCondition,
      new Set(joins.map(join => join.alias))
    );

    // Handle case where selection is a single value (not an object with properties)
    if (selection instanceof SqlFragment) {
      // Single SQL fragment - just build it directly
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragmentSql = selection.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      selectParts.push(fragmentSql);
    } else if (isScalarLiteralSelection(selection)) {
      // A selector returning ONE literal (`() => 'x'`): one column holding it. A string used to be
      // walked as an object of its characters, a number projected no column at all
      selectParts.push(`${projectionLiteralSql(selection, context)} as "value"`);
    } else if (typeof selection === 'object' && selection !== null && '__dbColumnName' in selection) {
      // Single FieldRef
      const tableAlias = ('__tableAlias' in selection && selection.__tableAlias) ? selection.__tableAlias as string : this.schema.name;
      selectParts.push(`"${tableAlias}"."${selection.__dbColumnName}"`);
    } else if (selection instanceof CollectionQueryBuilder) {
      // This shouldn't happen in normal flow, but handle it
      throw new Error('select(): a collection cannot be the whole selection — project it as a field: select(row => ({ count: row.items.count() }))');
    } else {
      // Process selection object properties
      for (const key in selection) {
        if (!Object.prototype.hasOwnProperty.call(selection, key)) {
          continue;
        }
        const value = selection[key];
        if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
          // Handle collection - delegate to strategy pattern via buildCTE
          // The strategy handles CTE/LATERAL specifics and returns necessary info
          this.assertJoinedCollectionStrategy(value, context);
          const cteData = this.buildProjectedCollection(value, context);
          const isCTE = cteData.isCTE !== false; // Default to CTE if not specified

          // Note: For CTE strategy, context.ctes is already populated by the strategy
          // We don't need to add it again - the strategy has already done this

          collectionFields.push({
            name: key,
            cteName: cteData.tableName || `cte_${context.cteCounter - 1}`, // Use tableName from result or infer from counter
            isCTE,
            joinClause: cteData.joinClause,
            selectExpression: cteData.selectExpression,
            parentKey: cteData.parentKey,
          });
        } else if (value instanceof Subquery || (value && typeof value === 'object' && 'buildSql' in value && typeof (value as any).buildSql === 'function' && '__mode' in value)) {
          // Handle Subquery - build SQL and wrap in parentheses
          // Check both instanceof and duck typing for Subquery
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const subquerySql = (value as Subquery).buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`(${subquerySql}) as "${key}"`);
        } else if (value instanceof SqlFragment) {
          // SQL Fragment - build the SQL expression
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`${fragmentSql} as "${key}"`);
        } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
          // FieldRef object - check if it has a table alias (from navigation)
          if ('__tableAlias' in value && value.__tableAlias && typeof value.__tableAlias === 'string') {
            // This is a field from a joined table
            const tableAlias = value.__tableAlias as string;
            const columnName = value.__dbColumnName as string;

            // Find the relation config for this navigation
            const relConfig = this.relationForRef(value, tableAlias);
            if (relConfig) {
              // Add JOIN if not already added
              if (!joins.find(j => j.alias === tableAlias)) {
                // Get target schema from targetTableBuilder if available
                let targetSchema: string | undefined;
                if (relConfig.targetTableBuilder) {
                  const targetTableSchema = relConfig.targetTableBuilder.build();
                  targetSchema = targetTableSchema.schema;
                }

                joins.push({
                  alias: tableAlias,
                  targetTable: relConfig.targetTable,
                  targetSchema,
                  foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                  matches: relConfig.matches || [],
                  isMandatory: relConfig.isMandatory ?? false,
                });
              }
            }

            // Check if this is a CTE aggregation column that needs COALESCE
            const cteJoin = this.manualJoins.find(j => j.cte && j.cte.name === tableAlias);
            if (cteJoin && cteJoin.cte && cteJoin.cte.isAggregationColumn(columnName)) {
              // CTE aggregation column - wrap with COALESCE to return empty array instead of null
              selectParts.push(`COALESCE("${tableAlias}"."${columnName}", '[]'::json) as "${key}"`);
            } else {
              selectParts.push(`"${tableAlias}"."${columnName}" as "${key}"`);
            }
          } else {
            // Regular field from the main table
            selectParts.push(`"${this.schema.name}"."${value.__dbColumnName}" as "${key}"`);
          }
        } else if (typeof value === 'string') {
          // A string is a value, as its type says (`kind: 'loan'`) — a parameter like any other
          // literal. It used to render as a column of that NAME: an error, or another column's data
          // (`kind: 'name'` read the name column)
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        } else if (typeof value === 'object' && value !== null) {
          // Check if this is a navigation property mock or placeholder
          if (!('__dbColumnName' in value)) {
            // This is not a FieldRef - check if it's a navigation property mock or array
            if (Array.isArray(value)) {
              // A list of columns has no one SQL value (it used to vanish from the result)
              assertProjectionArrayOfValues(value, key, 'select()');

              // A list of values reads back as itself; a projection read as columns (a CTE body)
              // carries it as a jsonb column
              if (context.typedLiterals) {
                selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
              }
              continue;
            }

            // A navigation row projected whole: its columns, flattened like a nested object's, so
            // each reads back typed and through its own mapper. It used to render as ONE
            // json_build_object — timestamps came back as strings, mappers never ran, and a
            // DISTINCT or UNION over it failed (json has no equality operator)
            if (this.isFlattenedNavigationRow(value)
              && this.tryBuildFlatNestedSelect(materializeMockSelection(value), context, joins, selectParts, `__nested__${key}`, nestedPaths)) {
              continue;
            }
            // Check if it's a CollectionQueryBuilder or ReferenceQueryBuilder instance
            if (value instanceof CollectionQueryBuilder) {
              // Skip collection query builders that haven't been resolved
              continue;
            } else if (value instanceof ReferenceQueryBuilder) {
              // Handle ReferenceQueryBuilder - select all fields from the target table
              const targetSchema = value.getTargetTableSchema();
              const alias = value.getAlias();

              if (targetSchema) {
                // Add JOIN if not already added
                if (!joins.find(j => j.alias === alias)) {
                  // Get target schema name from targetSchema
                  let targetTableSchema: string | undefined;
                  if (targetSchema.schema) {
                    targetTableSchema = targetSchema.schema;
                  }

                  joins.push({
                    alias,
                    targetTable: value.getTargetTable(),
                    targetSchema: targetTableSchema,
                    foreignKeys: value.getForeignKeys(),
                    matches: value.getMatches(),
                    isMandatory: value.getIsMandatory(),
                  });
                }

                // Select all columns from the target table and group them
                // We'll need to use JSON object building in SQL
                const fieldParts: string[] = [];
                // Performance: Use cached column name map
                const targetColMap = getColumnNameMapForSchema(targetSchema);
                for (const [colKey, dbColName] of targetColMap) {
                  fieldParts.push(`'${colKey}', "${alias}"."${dbColName}"`);
                }

                selectParts.push(`json_build_object(${fieldParts.join(', ')}) as "${key}"`);
              } else {
                // No target schema available, skip
                continue;
              }
            }
            // Check if it's a mock object with getter-backed properties (navigation property
            // mock). The getters may be OWN (root mocks) or INHERITED from the shared
            // prototype (reference mocks) — findFirstGetterKey walks both.
            {
              const tableAlias = findFirstGetterKey(value);
              if (tableAlias) {
                // This object has getter properties - likely a navigation mock
                // Try to determine if this is a reference navigation by checking the schema relations

                {
                  // Try to get the first property to check if it has __tableAlias
                  try {
                    const firstValue = (value as any)[tableAlias];
                    if (firstValue && typeof firstValue === 'object' && '__tableAlias' in firstValue) {
                      const alias = firstValue.__tableAlias as string;

                      // A navigation row below the root, or one whose relation name another path
                      // owns: the plan joins it on its own path (a relation of OURS by that name
                      // would be a different row)
                      const planned = this.navigationPlan?.nodeOf(firstValue);

                      if (planned !== undefined && planned.targetSchema && (planned.parent !== undefined || planned.alias !== planned.relationName)) {
                        this.addPlannedJoins(planned, joins);

                        const plannedParts: string[] = [];
                        for (const [colKey, dbColName] of getColumnNameMapForSchema(planned.targetSchema)) {
                          plannedParts.push(`'${colKey}', "${planned.alias}"."${dbColName}"`);
                        }

                        selectParts.push(`json_build_object(${plannedParts.join(', ')}) as "${key}"`);
                        continue;
                      }

                      // A navigation of a manually joined table: no relation of OURS names it, its
                      // hops carry their joins (see explicitNavigationAlias)
                      const joinPath: NavigationJoin[] | undefined = (firstValue as any).__joinPath;
                      const explicitTarget = Array.isArray(joinPath) && joinPath.length > 0
                        ? this.schemaRegistry?.get(joinPath[joinPath.length - 1].targetTable)
                        : undefined;

                      if (explicitTarget) {
                        addExplicitJoinPath(joinPath, joins);

                        const explicitParts: string[] = [];
                        for (const [colKey, dbColName] of getColumnNameMapForSchema(explicitTarget)) {
                          explicitParts.push(`'${colKey}', "${alias}"."${dbColName}"`);
                        }

                        selectParts.push(`json_build_object(${explicitParts.join(', ')}) as "${key}"`);
                        continue;
                      }

                      const relConfig = this.relationForRef(firstValue, alias);

                      if (relConfig && relConfig.type === 'one') {
                        // This is a reference navigation - select all fields from the target table
                        // Performance: Use cached target schema
                        const targetSchema = getTargetSchemaForRelation(this.schema, alias, relConfig);

                        if (targetSchema) {
                          // Add JOIN if not already added
                          if (!joins.find(j => j.alias === alias)) {
                            let targetTableSchema: string | undefined;
                            if (targetSchema.schema) {
                              targetTableSchema = targetSchema.schema;
                            }

                            joins.push({
                              alias,
                              targetTable: relConfig.targetTable,
                              targetSchema: targetTableSchema,
                              foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                              matches: relConfig.matches || [],
                              isMandatory: relConfig.isMandatory ?? false,
                            });
                          }

                          // Select all columns from the target table and group them into a JSON object
                          const fieldParts: string[] = [];
                          // Performance: Use cached column name map
                          const targetColMap = getColumnNameMapForSchema(targetSchema);
                          for (const [colKey, dbColName] of targetColMap) {
                            fieldParts.push(`'${colKey}', "${alias}"."${dbColName}"`);
                          }

                          selectParts.push(`json_build_object(${fieldParts.join(', ')}) as "${key}"`);
                          continue;
                        }
                      }
                    }
                  } catch (e) {
                    // If accessing the property fails, just skip this navigation
                  }
                }

                // Default: skip this navigation mock
                continue;
              }
            }

            // Check if this is a plain nested object containing FieldRefs
            // e.g., address: { street: p.street, city: p.city }
            // Use flat select with path-encoded aliases for better performance
            const handled = this.tryBuildFlatNestedSelect(value, context, joins, selectParts, `__nested__${key}`, nestedPaths);
            if (handled) {
              continue;
            }

            // Check if this is a nested object with collections inside
            // e.g., content: { posts: u.posts!.toList() }
            // In this case, we need to handle it specially:
            // - Build the non-collection parts with flat select
            // - Let collections be handled by the collection handler
            if (this.hasNestedCollections(value)) {
              // Build flat select for non-collection parts of the nested object
              this.tryBuildFlatNestedSelectExcludingCollections(value, context, joins, selectParts, `__nested__${key}`, nestedPaths, collectionFields);
              continue;
            }
          }
          // Otherwise, treat as literal value (a Date, a class instance)
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        } else if (value === undefined) {
          // Skip undefined values (navigation property placeholders)
          continue;
        } else {
          // Literal value (a number, a boolean, a bigint, null)
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        }
      } // End of for loop
    } // End of else block

    // Add collection fields as JSON/array aggregations joined from CTEs or LATERAL joins
    for (const { name, cteName, selectExpression } of collectionFields) {
      // If selectExpression is provided (from strategy), use it directly
      if (selectExpression) {
        selectParts.push(`${selectExpression} as "${name}"`);
        continue;
      }

      // Fallback to old logic for backward compatibility
      // Get the collection value - handle both top-level and nested paths
      // For nested paths like "__nested__activity__postCount", we need to navigate the selection object
      let collectionValue: any;
      if (name.startsWith('__nested__')) {
        // Parse the nested path and navigate to the collection
        const pathParts = name.substring('__nested__'.length).split('__');
        collectionValue = selection;
        for (const part of pathParts) {
          if (collectionValue && typeof collectionValue === 'object') {
            collectionValue = collectionValue[part];
          } else {
            collectionValue = undefined;
            break;
          }
        }
      } else {
        collectionValue = selection[name];
      }

      // Check if this is an array aggregation (from toNumberList/toStringList)
      const isArrayAgg = collectionValue && typeof collectionValue === 'object' && 'isArrayAggregation' in collectionValue && collectionValue.isArrayAggregation();

      // Check if this is a scalar aggregation (count, sum, max, min)
      const isScalarAgg = collectionValue instanceof CollectionQueryBuilder &&
        collectionValue.isScalarAggregation();

      if (isScalarAgg) {
        // For scalar aggregations, handle COUNT vs other aggregations differently
        // COUNT should default to 0, while MAX/MIN/SUM should remain NULL
        const aggregationType = collectionValue.getAggregationType();
        if (aggregationType === 'COUNT') {
          selectParts.push(`COALESCE("${cteName}".data, 0) as "${name}"`);
        } else if (aggregationType === 'EXISTS') {
          selectParts.push(`COALESCE("${cteName}".data, false) as "${name}"`);
        } else {
          // For MAX/MIN/SUM, keep NULL as-is
          selectParts.push(`"${cteName}".data as "${name}"`);
        }
      } else if (isArrayAgg) {
        // For array aggregation, determine the array type from flattenResultType
        const flattenType = (collectionValue as any).getFlattenResultType?.() || 'string';
        const arrayType = flattenType === 'number' ? 'integer[]' : 'text[]';
        selectParts.push(`COALESCE("${cteName}".data, ARRAY[]::${arrayType}) as "${name}"`);
      } else {
        // For JSON aggregation, use json type for better performance
        selectParts.push(`COALESCE("${cteName}".data, '[]'::json) as "${name}"`);
      }
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders, context.hoistedCteNames);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      // Update placeholders from the condition builder (for prepared statements)
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      // Performance: Pre-compute column name map for ORDER BY lookups
      const colNameMap = getColumnNameMapForSchema(this.schema);
      const orderParts = this.orderByFields.map(entry => `${entry.expression !== undefined
        ? buildOrderByExpressionSql(entry.expression, context)
        : this.orderByKeySql(entry, selection, colNameMap)} ${entry.direction}`);
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }

    // Build LIMIT/OFFSET
    let limitClause = '';
    if (this.limitValue !== undefined) {
      limitClause = `LIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== undefined) {
      limitClause += ` OFFSET ${this.offsetValue}`;
    }

    // Build final query with CTEs
    let finalQuery = '';

    const allCtes: string[] = [];

    // Add user-defined CTEs (from .with() method)
    // Note: CTE params were already added to context.allParams at the start of buildQuery
    for (const cte of this.ctes) {
      allCtes.push(`"${cte.name}" AS ${cte.materialized ? 'MATERIALIZED ' : ''}(${cte.query})`);
    }

    // Add generated CTEs (from collection queries)
    if (context.ctes.size > 0) {
      for (const [cteName, { sql }] of context.ctes.entries()) {
        allCtes.push(`"${cteName}" AS (${sql})`);
      }
    }

    if (allCtes.length > 0) {
      finalQuery = `WITH ${allCtes.join(', ')}\n`;
    }

    // Build main query
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs (from leftJoin/innerJoin methods)
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';

      // Build ON condition
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a CTE join
      if (manualJoin.cte) {
        // Join with CTE - use CTE name directly
        fromClause += `\n${joinTypeStr} "${manualJoin.cte.name}" ON ${condSql}`;
      } else if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        // Build the subquery SQL
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;

        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        // Regular table join
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for single navigation (references)
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      // Build ON clause for the join
      // For multi-level navigation, use the sourceAlias (the intermediate table)
      // For direct navigation, use the main table name
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      // Use schema-qualified table name if schema is specified
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Join CTEs and LATERAL subqueries for collections
    for (const { cteName, isCTE, joinClause, parentKey } of collectionFields) {
      if (isCTE) {
        // CTE strategy - join by parent_id
        fromClause += `\nLEFT JOIN "${cteName}" ON "${cteName}".parent_id = ${parentKey ?? `${qualifiedTableName}.id`}`;
      } else if (joinClause) {
        // LATERAL strategy - use the provided join clause (contains full LATERAL subquery)
        fromClause += `\n${joinClause}`;
      }
    }

    // Add COUNT(*) OVER() for countOver() support
    if (this._includeCountOver) {
      selectParts.push('COUNT(*) OVER() as "__countOver"');
    }

    // Add DISTINCT if needed
    const distinctClause = this.isDistinct ? 'DISTINCT ' : '';
    // Row-level lock clause (forUpdate) — emitted only on the TOP-LEVEL statement:
    // nested-collection CTE legs run as lateral joins where a lock is meaningless
    // (and would be a syntax error inside some leg shapes), so the flag is read
    // ONLY here at the final assembly point.
    const lockClause = this.lockClause ? `\n${this.lockClause}` : '';
    finalQuery += `SELECT ${distinctClause}${selectParts.join(', ')}\n${fromClause}\n${whereClause}\n${orderByClause}\n${limitClause}${lockClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
      nestedPaths,
    };
  }

  /**
   * Build the core SQL query, optionally excluding ORDER BY, LIMIT, and OFFSET
   * Used by buildUnionSql to build component queries for UNION
   * @internal
   */
  private buildQueryCore(selection: any, context: QueryContext, includeOrderLimitOffset: boolean = true): { sql: string; params: any[]; nestedPaths: Set<string> } {
    return this.withNavigationPlan(
      selection,
      this.whereCond,
      () => this.buildQueryCoreBody(selection, context, includeOrderLimitOffset),
      includeOrderLimitOffset ? this.orderByRefs() : undefined
    );
  }

  /** The body of {@link buildQueryCore}, run under its navigation plan. */
  private buildQueryCoreBody(selection: any, context: QueryContext, includeOrderLimitOffset: boolean): { sql: string; params: any[]; nestedPaths: Set<string> } {
    // Handle user-defined CTEs first - their params need to come before main query params.
    // A CTE the enclosing builder already hoisted to statement level (UNION) has had both
    // its params and its WITH entry contributed there; pushing them again would duplicate
    // the params and shift every placeholder in this leg.
    for (const cte of this.ctes) {
      if (context.hoistedCteNames?.has(cte.name)) {
        continue;
      }

      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    const selectParts: string[] = [];
    const collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string; parentKey?: string }> = [];
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    const nestedPaths: Set<string> = new Set();

    // Scan selection for navigation property references and add JOINs
    this.detectAndAddJoinsFromSelection(selection, joins);

    // Scan WHERE condition for navigation property references and add JOINs
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // ORDER BY keys read through a navigation the projection does not select are joined too
    if (includeOrderLimitOffset) {
      const orderByRefs = this.orderByRefs();
      if (orderByRefs.length > 0) {
        this.detectAndAddJoinsFromSelection(orderByRefs, joins);
      }
    }

    // So is the path a projected collection correlates through
    this.addCollectionPathJoins(selection, joins, context.collectionStrategy || 'lateral');

    // Repeat the shadow check now that the SELECT list has contributed its joins: the colliding
    // navigation can be named ONLY in the projection, where the WHERE-time check cannot see it.
    // EXISTS ignores the select list, so nothing else would catch that shape.
    assertNoCorrelatedAliasShadowing(
      this.schema.name,
      this.correlatedAliasesFromCondition,
      new Set(joins.map(join => join.alias))
    );

    // Handle case where selection is a single value (not an object with properties)
    if (selection instanceof SqlFragment) {
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragmentSql = selection.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      selectParts.push(fragmentSql);
    } else if (isScalarLiteralSelection(selection)) {
      // One literal (`() => 'x'`): one column holding it (see buildQueryBody)
      selectParts.push(`${projectionLiteralSql(selection, context)} as "value"`);
    } else if (typeof selection === 'object' && selection !== null && '__dbColumnName' in selection) {
      const tableAlias = ('__tableAlias' in selection && selection.__tableAlias) ? selection.__tableAlias as string : this.schema.name;
      selectParts.push(`"${tableAlias}"."${selection.__dbColumnName}"`);
    } else if (selection instanceof CollectionQueryBuilder) {
      throw new Error('select(): a collection cannot be the whole selection — project it as a field: select(row => ({ count: row.items.count() }))');
    } else {
      // Process selection object properties
      //
      // Parity with buildQuery (the non-UNION path): UNION legs must support
      // nested-object projections (`{ address: { street, city } }`) AND
      // collection projections (`{ cards: u.cards.toList(...) }`) so that the
      // same selector shape can be reused across UNION legs and stand-alone
      // queries. The legacy buildQueryCore silently dropped both:
      //   - nested objects fell through to the literal-param branch and
      //     arrived as a stringified blob,
      //   - collections hit an explicit `continue` and were never emitted.
      // Both regressions are now covered by union-nested-select.test.ts and
      // union-collection-nav.test.ts.
      for (const key in selection) {
        if (!Object.prototype.hasOwnProperty.call(selection, key)) {
          continue;
        }
        const value = selection[key];
        if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
          // Collection projection inside a UNION leg — delegate to the
          // collection strategy (LATERAL by default) and emit per-row
          // correlated subquery. Same flow as buildQuery (line ~4266):
          //   buildCTE() registers the CTE / produces the joinClause +
          //   selectExpression. We push the selectExpression as the SELECT
          //   slot for this leg and add the joinClause to FROM later.
          this.assertJoinedCollectionStrategy(value, context);
          const cteData = this.buildProjectedCollection(value, context);
          const isCTE = cteData.isCTE !== false;

          collectionFields.push({
            name: key,
            cteName: cteData.tableName || `cte_${context.cteCounter - 1}`,
            isCTE,
            joinClause: cteData.joinClause,
            selectExpression: cteData.selectExpression,
            parentKey: cteData.parentKey,
          });
        } else if (value instanceof Subquery || (value && typeof value === 'object' && 'buildSql' in value && typeof (value as any).buildSql === 'function' && '__mode' in value)) {
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const subquerySql = (value as Subquery).buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`(${subquerySql}) as "${key}"`);
        } else if (value instanceof SqlFragment) {
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`${fragmentSql} as "${key}"`);
        } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
          if ('__tableAlias' in value && value.__tableAlias && typeof value.__tableAlias === 'string') {
            const tableAlias = value.__tableAlias as string;
            const columnName = value.__dbColumnName as string;

            const relConfig = this.relationForRef(value, tableAlias);
            if (relConfig && !joins.find(j => j.alias === tableAlias)) {
              let targetSchema: string | undefined;
              if (relConfig.targetTableBuilder) {
                const targetTableSchema = relConfig.targetTableBuilder.build();
                targetSchema = targetTableSchema.schema;
              }
              joins.push({
                alias: tableAlias,
                targetTable: relConfig.targetTable,
                targetSchema,
                foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                matches: relConfig.matches || [],
                isMandatory: relConfig.isMandatory ?? false,
              });
            }

            const cteJoin = this.manualJoins.find(j => j.cte && j.cte.name === tableAlias);
            if (cteJoin && cteJoin.cte && cteJoin.cte.isAggregationColumn(columnName)) {
              selectParts.push(`COALESCE("${tableAlias}"."${columnName}", '[]'::json) as "${key}"`);
            } else {
              selectParts.push(`"${tableAlias}"."${columnName}" as "${key}"`);
            }
          } else {
            selectParts.push(`"${this.schema.name}"."${value.__dbColumnName}" as "${key}"`);
          }
        } else if (typeof value === 'string') {
          // A string is a value (see buildQuery), not a column name
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        } else if (typeof value === 'object' && value !== null) {
          if (!('__dbColumnName' in value)) {
            if (Array.isArray(value)) {
              // A list of columns has no one SQL value; a list of values reads back as itself
              assertProjectionArrayOfValues(value, key, 'select()');

              if (context.typedLiterals) {
                selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
              }
              continue;
            }
            if (value instanceof CollectionQueryBuilder) {
              continue;
            } else if (value instanceof ReferenceQueryBuilder) {
              continue; // Skip ReferenceQueryBuilder in union queries
            }

            // A navigation row projected whole: its columns, flattened (see buildQueryBody). A leg
            // used to bind the row object itself as a parameter: every leg read back "{}"
            if (this.isFlattenedNavigationRow(value)
              && this.tryBuildFlatNestedSelect(materializeMockSelection(value), context, joins, selectParts, `__nested__${key}`, nestedPaths)) {
              continue;
            }

            // Plain nested object containing FieldRefs / SqlFragments /
            // primitives (e.g. `address: { street: p.street, city: p.city }`).
            // Same flat-flattening pass as buildQuery: produces flat
            // `__nested__<path>__<leaf>` columns with deterministic ordering
            // across UNION legs. The UnionQueryBuilder reconstructs them
            // post-fetch via reconstructNestedObjects().
            const handled = this.tryBuildFlatNestedSelect(value, context, joins, selectParts, `__nested__${key}`, nestedPaths);
            if (handled) {
              continue;
            }

            // Nested object that ALSO contains a collection inside it
            // (e.g. `content: { posts: u.posts.toList() }`). Build the
            // non-collection leaves flat, register the collection in
            // collectionFields so it gets the LATERAL / CTE treatment.
            if (this.hasNestedCollections(value)) {
              this.tryBuildFlatNestedSelectExcludingCollections(value, context, joins, selectParts, `__nested__${key}`, nestedPaths, collectionFields);
              continue;
            }
          }
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        } else if (value === undefined) {
          continue;
        } else {
          selectParts.push(`${projectionLiteralSql(value, context)} as "${key}"`);
        }
      }

      // Add collection fields as JSON / array aggregations joined from CTEs or
      // LATERAL joins. Mirrors the buildQuery flow at line ~4498 — collections
      // must contribute a SELECT slot (or every UNION leg's column count
      // diverges) and a FROM-side join clause.
      for (const { name, cteName, selectExpression } of collectionFields) {
        if (selectExpression) {
          selectParts.push(`${selectExpression} as "${name}"`);
          continue;
        }

        // Fallback path mirrors buildQuery for the CTE strategy (when no
        // pre-built selectExpression was produced by buildCTE).
        let collectionValue: any;
        if (name.startsWith('__nested__')) {
          const pathParts = name.substring('__nested__'.length).split('__');
          collectionValue = selection;
          for (const part of pathParts) {
            if (collectionValue && typeof collectionValue === 'object') {
              collectionValue = collectionValue[part];
            } else {
              collectionValue = undefined;
              break;
            }
          }
        } else {
          collectionValue = (selection as any)[name];
        }

        const isArrayAgg = collectionValue && typeof collectionValue === 'object' && 'isArrayAggregation' in collectionValue && collectionValue.isArrayAggregation();
        const isScalarAgg = collectionValue instanceof CollectionQueryBuilder && collectionValue.isScalarAggregation();

        if (isScalarAgg) {
          const aggregationType = collectionValue.getAggregationType();
          if (aggregationType === 'COUNT') {
            selectParts.push(`COALESCE("${cteName}".data, 0) as "${name}"`);
          } else if (aggregationType === 'EXISTS') {
            selectParts.push(`COALESCE("${cteName}".data, false) as "${name}"`);
          } else {
            selectParts.push(`"${cteName}".data as "${name}"`);
          }
        } else if (isArrayAgg) {
          const flattenType = (collectionValue as any).getFlattenResultType?.() || 'string';
          const arrayType = flattenType === 'number' ? 'integer[]' : 'text[]';
          selectParts.push(`COALESCE("${cteName}".data, ARRAY[]::${arrayType}) as "${name}"`);
        } else {
          selectParts.push(`COALESCE("${cteName}".data, '[]'::json) as "${name}"`);
        }
      }
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders, context.hoistedCteNames);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build ORDER BY clause (only if includeOrderLimitOffset is true)
    let orderByClause = '';
    if (includeOrderLimitOffset && this.orderByFields.length > 0) {
      const colNameMap = getColumnNameMapForSchema(this.schema);
      const orderParts = this.orderByFields.map(entry => `${entry.expression !== undefined
        ? buildOrderByExpressionSql(entry.expression, context)
        : this.orderByKeySql(entry, selection, colNameMap)} ${entry.direction}`);
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }

    // Build LIMIT/OFFSET (only if includeOrderLimitOffset is true)
    let limitClause = '';
    if (includeOrderLimitOffset) {
      if (this.limitValue !== undefined) {
        limitClause = `LIMIT ${this.limitValue}`;
      }
      if (this.offsetValue !== undefined) {
        limitClause += ` OFFSET ${this.offsetValue}`;
      }
    }

    // Build final query with CTEs
    let finalQuery = '';

    const allCtes: string[] = [];

    for (const cte of this.ctes) {
      // Hoisted to statement level by the enclosing UNION - declared there, not here.
      if (context.hoistedCteNames?.has(cte.name)) {
        continue;
      }

      allCtes.push(`"${cte.name}" AS ${cte.materialized ? 'MATERIALIZED ' : ''}(${cte.query})`);
    }

    if (context.ctes.size > 0) {
      for (const [cteName, { sql }] of context.ctes.entries()) {
        allCtes.push(`"${cteName}" AS (${sql})`);
      }
    }

    if (allCtes.length > 0) {
      finalQuery = `WITH ${allCtes.join(', ')}\n`;
    }

    // Build main query
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newParamCounter;
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      if (manualJoin.cte) {
        fromClause += `\n${joinTypeStr} "${manualJoin.cte.name}" ON ${condSql}`;
      } else if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for single navigation
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Join CTEs / LATERAL subqueries for collection projections inside the UNION
    // leg. Mirror the buildQuery flow at line ~4678. CTE legs join by parent_id;
    // LATERAL legs splice in the pre-built `LEFT JOIN LATERAL (...)` clause.
    for (const { cteName, isCTE, joinClause, parentKey } of collectionFields) {
      if (isCTE) {
        fromClause += `\nLEFT JOIN "${cteName}" ON "${cteName}".parent_id = ${parentKey ?? `${qualifiedTableName}.id`}`;
      } else if (joinClause) {
        fromClause += `\n${joinClause}`;
      }
    }

    // Add DISTINCT if needed
    const distinctClause = this.isDistinct ? 'DISTINCT ' : '';

    // Build final SQL
    const queryParts = [`SELECT ${distinctClause}${selectParts.join(', ')}`, fromClause];
    if (whereClause) queryParts.push(whereClause);
    if (orderByClause) queryParts.push(orderByClause);
    if (limitClause) queryParts.push(limitClause);

    finalQuery += queryParts.join('\n').trim();

    return {
      sql: finalQuery,
      params: context.allParams,
      nestedPaths,
    };
  }


  /**
   * Transform database results
   * @param literalsFromRows - Read the projection's literals from the rows instead of from
   *   `selection`: a UNION reads every leg's rows through its FIRST leg's selection, while each leg
   *   may project its own literal (a discriminator).
   */
  private transformResults(rows: any[], selection: any, literalsFromRows: boolean = false): TSelection[] {
    if (rows.length === 0) {
      return [];
    }

    // A selector returning ONE column or expression reads as its values (see isScalarSelection):
    // each row is transformed as the one-field projection it is, then unwrapped
    if (isScalarSelection(selection)) {
      const column = '__dbColumnName' in selection ? (selection as FieldRef).__dbColumnName : undefined;
      const key = column !== undefined && column in rows[0] ? column : Object.keys(rows[0])[0];

      return this.transformResults(rows, { [key]: selection }).map(row => (row as any)[key]);
    }

    // A selector returning one literal (`select(() => 'x')`) reads as that literal on every row
    if (isScalarLiteralSelection(selection)) {
      if (!literalsFromRows) {
        return rows.map(() => selection);
      }

      const valueKey = Object.keys(rows[0])[0];
      const read: FieldRead = { key: valueKey, type: FieldType.SIMPLE, value: selection, coerce: true };

      return rows.map(row => this.readField(read, row[valueKey], literalsFromRows));
    }

    // Check if mappers are disabled for performance
    const disableMappers = this.executor?.getOptions().disableMappers ?? false;

    // Pre-analyze selection structure ONCE: how each field reads back
    // This moves all type checks out of the per-row loop
    const reads: FieldRead[] = [];

    for (const key in selection) {
      reads.push(this.compileFieldRead(key, selection[key], disableMappers, literalsFromRows, false));
    }

    // Transform each row using the compiled reads
    // Using while(i--) for maximum performance - decrement and compare to 0 is faster
    const results: TSelection[] = new Array(rows.length);
    const readCount = reads.length;
    let rowIdx = rows.length;

    while (rowIdx--) {
      const row = rows[rowIdx];
      const result: any = {};
      let i = readCount;

      while (i--) {
        const read = reads[i];
        result[read.key] = this.readField(read, row[read.key], literalsFromRows);
      }

      results[rowIdx] = result as TSelection;
    }

    return results;
  }

  /**
   * How one value of a projection reads back — decided once per query (see FieldRead). A value of a
   * nested object (`nested`) keeps NULL as null, as nested values always did; at the top level a
   * value that is not a column of the table reads NULL as undefined.
   */
  private compileFieldRead(key: string, value: any, disableMappers: boolean, literalsFromRows: boolean, nested: boolean): FieldRead {
    // Check for navigation placeholders first (most common early exit)
    if (value === undefined) {
      // A nested undefined renders as NULL (see renderFlatNestedLeaf)
      return nested ? { key, type: FieldType.FIELD_REF_NO_MAPPER, value } : { key, type: FieldType.NAVIGATION, value };
    }

    // A literal reads back as itself — it rides the statement as a parameter, which the database
    // hands back as text (`true` came back "true", a Date as a string, `null` as undefined). A list
    // of values (empty ones included) is its own value everywhere: a UNION leg does not select it.
    if (Array.isArray(value) ? !holdsSqlValue(value) : !literalsFromRows && isProjectionLiteral(value)) {
      return { key, type: FieldType.LITERAL, value };
    }

    // A navigation row projected whole reads as the object of its columns, each through its own
    // mapper — it renders as those columns (see buildQueryBody); a plain nested object as its values
    const navigationRow = this.isFlattenedNavigationRow(value);

    if (navigationRow || (isPlainNestedProjection(value) && findFirstGetterKey(value) == null)) {
      const fields = navigationRow ? materializeMockSelection(value) : value;
      const children: FieldRead[] = [];

      for (const childKey in fields) {
        children.push(this.compileFieldRead(childKey, fields[childKey], disableMappers, literalsFromRows, true));
      }

      return { key, type: FieldType.NESTED, value, children };
    }

    // Getter-backed rows of another kind: their data comes from the row as it is
    if (value !== null && typeof value === 'object' && !('__dbColumnName' in value) && !('__fieldName' in value)
      && !('__collectionResult' in value) && !('__isAggregationArray' in value) && findFirstGetterKey(value) != null) {
      return { key, type: FieldType.SIMPLE, value, coerce: true, keepNull: nested };
    }

    // Collection types
    if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
      if (value instanceof CollectionQueryBuilder && value.isScalarAggregation()) {
        return { key, type: FieldType.COLLECTION_SCALAR, value, aggregationType: value.getAggregationType() };
      }

      if ('isArrayAggregation' in value && value.isArrayAggregation()) {
        return { key, type: FieldType.COLLECTION_ARRAY, value };
      }

      if (value instanceof CollectionQueryBuilder && value.isSingleResult()) {
        return { key, type: FieldType.COLLECTION_SINGLE, value, collectionBuilder: value };
      }

      return { key, type: FieldType.COLLECTION_JSON, value, collectionBuilder: value instanceof CollectionQueryBuilder ? value : undefined };
    }

    // CTE aggregation array: its items read through the aggregated query's own mappers
    if (typeof value === 'object' && value !== null && '__isAggregationArray' in value && (value as any).__isAggregationArray) {
      return {
        key,
        type: FieldType.CTE_AGGREGATION,
        value,
        itemReads: disableMappers ? undefined : aggregatedItemReads((value as any).__innerSelectionMetadata),
      };
    }

    // A column of a CTE or a table subquery reads the way the projection that made it says (see
    // projectedColumnRef) — never through the mapper of a column of OUR table sharing its name
    if (typeof value === 'object' && value !== null && '__cteKind' in value) {
      // A literal column (typed from its value, see projectionLiteralSql) reads as the driver hands
      // its type back, NULL kept — as the literal reads in the body's own result
      const literal = (value as any).__cteKind === 'literal';
      const mapper = literal
        ? ((value as any).__bigintLiteral ? BIGINT_LITERAL_READ : undefined)
        : disableMappers
          ? undefined
          : fromDriverMapper((value as any).__mapper) ?? (typeof (value as any).getMapper === 'function' ? fromDriverMapper((value as any).getMapper()) : undefined);

      return mapper
        ? { key, type: FieldType.FIELD_REF_MAPPER, value, mapper }
        : { key, type: FieldType.SIMPLE, value, coerce: coercesNumericText((value as any).__sqlType), keepNull: nested || literal };
    }

    // SqlFragment with mapper
    if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
      const mapper = disableMappers ? undefined : fromDriverMapper((value as any).getMapper());

      return mapper
        ? { key, type: FieldType.SQL_FRAGMENT_MAPPER, value, mapper }
        : { key, type: FieldType.SIMPLE, value, coerce: true, keepNull: nested };
    }

    // FieldRef with potential mapper
    if (typeof value === 'object' && value !== null && '__fieldName' in value) {
      if (disableMappers) {
        return { key, type: FieldType.FIELD_REF_NO_MAPPER, value };
      }

      const cached = this.schema.columnMetadataCache?.get(value.__fieldName as string);
      // A navigation's column reads through ITS mapper, also when the root has a column of the
      // same name (whose mapper — or lack of one — it used to get)
      const ownTable = value.__sourceTable === undefined || value.__sourceTable === this.schema.name;
      const cachedMapper = ownTable ? (cached?.hasMapper ? cached.mapper : undefined) : value.__mapper;

      if (cached && cachedMapper && typeof cachedMapper.fromDriver === 'function') {
        return { key, type: FieldType.FIELD_REF_MAPPER, value, mapper: cachedMapper };
      }

      if (cached) {
        // A numeric(p, s) zero read through a client that drops its scale gets it back
        const zeroScale = ownTable && this.client.losesNumericZeroScale() ? numericZeroScaleMapper(cached.config) : undefined;

        return zeroScale
          ? { key, type: FieldType.FIELD_REF_MAPPER, value, mapper: zeroScale }
          : { key, type: FieldType.FIELD_REF_NO_MAPPER, value };
      }

      // Not in root schema cache — check FieldRef's own mapper (from navigation properties)
      const fieldMapper = (value as any).__mapper;

      if (fieldMapper && typeof fieldMapper.fromDriver === 'function') {
        return { key, type: FieldType.FIELD_REF_MAPPER, value, mapper: fieldMapper };
      }

      // A navigation's text column keeps its text: '01234' used to read back as the number 1234
      return { key, type: FieldType.SIMPLE, value, coerce: coercesNumericText((value as any).__sqlType), keepNull: nested };
    }

    // Default: simple value
    return { key, type: FieldType.SIMPLE, value, coerce: true, keepNull: nested };
  }

  /** Reads one value of a row as `read` says (see compileFieldRead). */
  private readField(read: FieldRead, rawValue: any, literalsFromRows: boolean): any {
    switch (read.type) {
      case FieldType.NAVIGATION:
      case FieldType.LITERAL:
        return read.value;
      case FieldType.NESTED: {
        // The object reconstructed from the nested object's flattened columns — a fresh one per row
        if (rawValue === null || typeof rawValue !== 'object') {
          return rawValue;
        }

        const children = read.children!;

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          rawValue[child.key] = this.readField(child, rawValue[child.key], literalsFromRows);
        }

        return rawValue;
      }
      case FieldType.COLLECTION_SCALAR:
        if (read.aggregationType === 'COUNT') {
          return this.convertValue(rawValue);
        }

        // MAX/MIN/SUM: preserve NULL, convert numeric strings
        return typeof rawValue === 'string' && NUMERIC_REGEX.test(rawValue) ? +rawValue : rawValue;
      case FieldType.COLLECTION_ARRAY:
        return rawValue || [];
      case FieldType.COLLECTION_JSON: {
        const items = rawValue || [];

        if (!read.collectionBuilder) {
          return items;
        }

        const transformed = this.transformCollectionItems(items, read.collectionBuilder, literalsFromRows);
        const scalarAlias = read.collectionBuilder.getScalarSelectionAlias();

        return scalarAlias !== undefined ? unwrapScalarItems(transformed, scalarAlias) : transformed;
      }
      case FieldType.COLLECTION_SINGLE: {
        // firstOrDefault() - return single object or null
        // With CTE/LATERAL single result, rawValue is already a single object (not array)
        if (rawValue === null || rawValue === undefined) {
          return null;
        }

        if (!read.collectionBuilder) {
          return rawValue;
        }

        // Transform the single item using collection mapper if available
        const transformedItems = this.transformCollectionItems([rawValue], read.collectionBuilder, literalsFromRows);
        const scalarAlias = read.collectionBuilder.getScalarSelectionAlias();
        const item = scalarAlias !== undefined ? unwrapScalarItems(transformedItems, scalarAlias) : transformedItems;

        return item[0] ?? null;
      }
      case FieldType.CTE_AGGREGATION: {
        const items = rawValue || [];

        return read.itemReads ? mapAggregatedItems(items, read.itemReads) : items;
      }
      case FieldType.SQL_FRAGMENT_MAPPER:
        // mapWith wraps user functions to handle null
        return read.mapper.fromDriver(rawValue);
      case FieldType.FIELD_REF_MAPPER:
        // Column mappers (customType) - null check done here
        return read.mapper.fromDriver(rawValue);
      case FieldType.FIELD_REF_NO_MAPPER:
        return rawValue;
      case FieldType.SIMPLE:
      default:
        if (rawValue === null) {
          return read.keepNull ? null : undefined;
        }

        // A numeric string (a NUMERIC / BIGINT value — also of an aggregate subquery, AVG, SUM)
        // becomes a number; the regex validates the format, so `+` always yields a valid number
        return read.coerce && typeof rawValue === 'string' && NUMERIC_REGEX.test(rawValue) ? +rawValue : rawValue;
    }
  }

  /**
   * Convert database values: null to undefined, numeric strings to numbers
   */
  private convertValue(value: any): any {
    if (value === null) {
      return undefined;
    }
    // Check if it's a numeric string (PostgreSQL NUMERIC type)
    // This handles scalar subqueries with aggregates like AVG, SUM, etc.
    // The regex validates format, so Number() is guaranteed to produce a valid number
    if (typeof value === 'string' && NUMERIC_REGEX.test(value)) {
      return +value; // Faster than Number(value)
    }
    return value;
  }

  /**
   * Transform collection items applying fromDriver mappers
   */
  private transformCollectionItems(items: any[], collectionBuilder: CollectionQueryBuilder<any>, literalsFromRows: boolean = false): any[] {
    // Check if mappers are disabled for performance
    if (this.executor?.getOptions().disableMappers ?? false) {
      // Skip mapper transformation for performance - return items as-is
      return items;
    }

    return transformCollectionItemsOf(items, collectionBuilder, this.schemaRegistry, !literalsFromRows);
  }

  /**
   * Build aggregation query (MIN, MAX, SUM)
   */
  private buildAggregationQuery(aggregation: 'MIN' | 'MAX' | 'SUM', fieldToAggregate: any, context: QueryContext): { sql: string; params: any[] } {
    return this.withNavigationPlan(
      undefined,
      this.whereCond,
      () => this.buildAggregationQueryBody(aggregation, fieldToAggregate, context),
      [fieldToAggregate]
    );
  }

  /** The body of {@link buildAggregationQuery}, run under its navigation plan. */
  private buildAggregationQueryBody(aggregation: 'MIN' | 'MAX' | 'SUM', fieldToAggregate: any, context: QueryContext): { sql: string; params: any[] } {
    // Extract the field name from FieldRef object
    let fieldName: string;
    let tableAlias: string = this.schema.name;

    if (typeof fieldToAggregate === 'object' && fieldToAggregate !== null && '__dbColumnName' in fieldToAggregate) {
      fieldName = fieldToAggregate.__dbColumnName as string;
      if ('__tableAlias' in fieldToAggregate && fieldToAggregate.__tableAlias) {
        tableAlias = fieldToAggregate.__tableAlias as string;
      }
    } else if (typeof fieldToAggregate === 'string') {
      fieldName = fieldToAggregate;
    } else {
      throw new Error('Aggregation selector must return a field reference');
    }

    // Detect navigation property joins from WHERE condition (same as buildAggregateQuery)
    const navJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    this.detectAndAddJoinsFromCondition(this.whereCond, navJoins);

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders, context.hoistedCteNames);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build FROM clause with JOINs
    let fromClause = `FROM "${this.schema.name}"`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newJoinParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newJoinParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a subquery join
      if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for navigation properties referenced in WHERE clause
    for (const join of navJoins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    const sql = `SELECT ${aggregation}("${tableAlias}"."${fieldName}") as result\n${fromClause}\n${whereClause}`.trim();

    return {
      sql,
      params: context.allParams,
    };
  }

  /**
   * Build aggregate query (count or exists)
   */
  private buildAggregateQuery(context: QueryContext, type: 'count' | 'exists'): { sql: string; params: any[] } {
    return this.withNavigationPlan(undefined, this.whereCond, () => this.buildAggregateQueryBody(context, type));
  }

  /** The body of {@link buildAggregateQuery}, run under its navigation plan. */
  private buildAggregateQueryBody(context: QueryContext, type: 'count' | 'exists'): { sql: string; params: any[] } {
    // User-defined CTEs first, exactly as buildQuery does: their params occupy the
    // opening slots of the statement because DbCte bodies carry placeholders numbered
    // from $1. Without this, `.with(cte).count()` / `.exists()` dropped the WITH clause
    // entirely and PostgreSQL answered `relation "<cte>" does not exist` (42P01) for any
    // query whose WHERE referenced the CTE.
    for (const cte of this.ctes) {
      if (context.hoistedCteNames?.has(cte.name)) {
        continue;
      }

      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    // Detect navigation property joins from WHERE condition
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders, context.hoistedCteNames);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build FROM clause with JOINs
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newJoinParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newJoinParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a subquery join
      if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for navigation properties referenced in WHERE clause
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      // Build ON clause for the join
      // For multi-level navigation, use the sourceAlias (the intermediate table)
      // For direct navigation, use the main table name
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      // Use schema-qualified table name if schema is specified
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Build SELECT clause based on type
    const selectClause = type === 'count'
      ? 'SELECT COUNT(*) as count'
      : 'SELECT EXISTS(SELECT 1';

    // WITH clause - same assembly as buildQuery, so an aggregate can reference the
    // CTEs attached to the query it is aggregating.
    const allCtes: string[] = [];
    for (const cte of this.ctes) {
      if (context.hoistedCteNames?.has(cte.name)) {
        continue;
      }

      allCtes.push(`"${cte.name}" AS ${cte.materialized ? 'MATERIALIZED ' : ''}(${cte.query})`);
    }

    if (context.ctes.size > 0) {
      for (const [cteName, { sql: cteSql }] of context.ctes.entries()) {
        allCtes.push(`"${cteName}" AS (${cteSql})`);
      }
    }

    const withClause = allCtes.length > 0 ? `WITH ${allCtes.join(', ')}\n` : '';

    const sql = type === 'count'
      ? `${withClause}${selectClause}\n${fromClause}\n${whereClause}`.trim()
      : `${withClause}${selectClause}\n${fromClause}\n${whereClause})`.trim();

    return {
      sql,
      params: context.allParams,
    };
  }

  /**
   * Convert this query to a subquery that can be used in WHERE, SELECT, JOIN, or FROM clauses
   *
   * @template TMode - 'scalar' for single value, 'array' for column list, 'table' for full rows
   * @returns Subquery that maintains type safety
   *
   * @example
   * // Scalar subquery (returns single value)
   * const avgAge = db.users.select(u => u.age).asSubquery('scalar');
   *
   * // Array subquery (returns list of values for IN clause)
   * const activeUserIds = db.users
   *   .where(u => eq(u.isActive, true))
   *   .select(u => u.id)
   *   .asSubquery('array');
   *
   * // Table subquery (returns rows for FROM or JOIN)
   * const activeUsers = db.users
   *   .where(u => eq(u.isActive, true))
   *   .select(u => ({ id: u.id, name: u.username }))
   *   .asSubquery('table');
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<TMode extends 'scalar' ? ResolveFieldRefs<TSelection> : TMode extends 'array' ? ResolveFieldRefs<TSelection>[] : ResolveCollectionResults<TSelection>, TMode> {
    // Create a function that builds the subquery SQL when called
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string => {
      // Create a fresh context for this subquery, inheriting placeholders from outer context
      const context: QueryContext = {
        ctes: new Map(),
        cteCounter: 0,
        useJsonArrayAggregation: outerContext.useJsonArrayAggregation ?? !this.client.supportsBinaryArrayResults(),
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
        placeholders: outerContext.placeholders,  // Pass placeholders through for prepared statements
        // CTEs an enclosing builder already declared at statement level stay
        // declared for anything NESTED in this subquery too. Without this the
        // signal dies at the subquery boundary and a CTE-rooted subquery one
        // level deeper re-declares (and re-materializes) a CTE it was handed.
        hoistedCteNames: outerContext.hoistedCteNames,
        executor: this.executor,
        // The enclosing query reads the subquery's columns (or its value): its literals render
        // typed — untyped, a `true` reached it as the text 'true'
        typedLiterals: true,
      };

      // Analyze the selector to extract nested queries
      const mockRow = this._createMockRow();
      const selectionResult = materializeMockSelection(this.selector(mockRow));

      // Build the query
      const { sql } = this.buildQuery(selectionResult, context);

      // Update the outer context's param counter
      outerContext.paramCounter = context.paramCounter;

      return sql;
    };

    // For table subqueries, preserve the selection metadata (includes SqlFragments with mappers)
    let selectionMetadata: Record<string, any> | undefined;
    if (mode === 'table') {
      const mockRow = this._createMockRow();
      selectionMetadata = materializeMockSelection(this.selector(mockRow));
    }

    // Extract outer field refs from the WHERE condition
    // These are field refs that reference tables other than this subquery's table
    // and need to be propagated to the outer query for JOIN detection
    const outerFieldRefs = this.extractOuterFieldRefs();

    return new Subquery(sqlBuilder, mode, selectionMetadata, outerFieldRefs) as any;
  }

  /**
   * Extract field refs from the WHERE condition that reference outer queries.
   * These are field refs with a __tableAlias that doesn't match this query's schema.
   */
  private extractOuterFieldRefs(): FieldRef[] {
    if (!this.whereCond) {
      return [];
    }

    const allRefs = this.whereCond.getFieldRefs();
    const outerRefs: FieldRef[] = [];
    const currentTableName = this.schema.name;

    for (const ref of allRefs) {
      // Check if this ref is from an outer query (different table alias)
      if ('__tableAlias' in ref && ref.__tableAlias) {
        const tableAlias = ref.__tableAlias as string;
        // If the table alias doesn't match our current schema, it's from an outer query
        // Also check if it's not a navigation property of this table (which would be in schema.relations)
        // and not one of our own manual-join aliases (filter-joins qualify refs by join alias).
        //
        // Chain identity outranks both name checks: a ref stamped by another chain is a
        // correlation whatever it is called, and reading it as our own navigation (because a
        // relation happens to carry the same name) is what silently misbinds the predicate.
        // See isForeignChainRef.
        if (tableAlias !== currentTableName && isForeignChainRef(ref, this.chainId)) {
          outerRefs.push(ref);
        } else if (tableAlias !== currentTableName && !this.schema.relations[tableAlias]) {
          if (!this.manualJoins.some(j => j.alias === tableAlias)) {
            outerRefs.push(ref);
          }
        } else if (
          tableAlias === currentTableName
          && (ref as any).__chainId != null
          && this.chainId != null
          && (ref as any).__chainId !== this.chainId
        ) {
          // A ref over OUR table name that was created by a DIFFERENT query chain:
          // this is a same-table correlated standalone subquery. Inner and outer
          // FROM would share the alias, so the "correlation" would silently bind
          // to the INNER row and return wrong results — refuse loudly instead.
          throw new Error(
            `Correlated standalone subquery over table "${currentTableName}" references the same table from the outer query. `
            + `Both sides would share the alias "${currentTableName}" and the correlation would silently compare the inner row with itself. `
            + `Correlate through a different table or key column, or materialize the outer value before building the subquery.`
          );
        }
      }
    }

    return outerRefs;
  }
}

/**
 * Marker interface for collection results - signals that this will be an array at runtime
 */
export interface CollectionResult<TItem> {
  readonly __collectionResult: true;
  readonly __itemType: TItem;
}

/**
 * Type helper to extract the value type from FieldRef
 * FieldRef<"id", number> becomes number
 */
type ExtractFieldValue<T> = T extends FieldRef<any, infer V>
  ? V
  : T;

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. See conditions.ts for detailed explanation.
 * Excludes DbColumn and SqlFragment which have valueOf but are not value types.
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Exclude DbColumn
  : T extends SqlFragment<any>
  ? false  // Exclude SqlFragment
  : T extends { valueOf(): infer V }
  ? V extends T
  ? true
  : V extends number | string | boolean | bigint | symbol
  ? true
  : false
  : false;

/**
 * Check for types with known class method signatures
 */
type HasClassMethods<T> = T extends { getTime(): number }  // Date-like
  ? true
  : T extends { size: number; has(value: any): boolean }  // Set/Map-like
  ? true
  : T extends { byteLength: number }  // ArrayBuffer/TypedArray-like
  ? true
  : T extends { then(onfulfilled?: any): any }  // Promise-like
  ? true
  : T extends { message: string; name: string }  // Error-like
  ? true
  : T extends { exec(string: string): any }  // RegExp-like
  ? true
  : false;

/**
 * Combined check for value types that should not be recursively processed
 */
type IsValueType<T> = IsClassInstance<T> extends true
  ? true
  : HasClassMethods<T> extends true
  ? true
  : false;

/**
 * Type helper to resolve all FieldRef and SqlFragment types to their value types
 * Recursively processes nested objects and arrays
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
export type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends SqlFragment<infer V>
  ? V
  : T extends CollectionResult<any>
  ? T  // Preserve CollectionResult for ResolveCollectionResults to handle
  : T extends Array<infer U>
  ? Array<ResolveFieldRefs<U>>
  : T extends (...args: any[]) => any
  ? T  // Preserve functions as-is
  : T extends object
  ? IsValueType<T> extends true
  ? T  // Preserve class instances (Date, Map, Set, Temporal, etc.) as-is
  : { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Whether a selector returned ONE column or expression (`b => b.name`, `b => b.book.name`,
 * `b => sql\`upper(${b.name})\``) instead of an object of fields. Such a query — a root query or a
 * collection — reads as the list of that value, as its type (`string[]`) says. Its rows came back as
 * objects: empty ones for a root query (the value's own ref keys were read as the projection's
 * fields) or an expression, `{ <column>: value }` in a collection.
 */
export function isScalarSelection(selection: unknown): selection is FieldRef | WhereConditionBase {
  return typeof selection === 'object'
    && selection !== null
    && !(selection instanceof CollectionQueryBuilder)
    && (selection instanceof WhereConditionBase || ('__dbColumnName' in selection && '__fieldName' in selection));
}

/** The field an expression a collection selects on its own (`e => sql\`...\``) is projected under. */
const SCALAR_SELECTION_ALIAS = '__value';

/** Unwraps each item of a scalar collection selection (`{ <alias>: value }` → value). */
export function unwrapScalarItems(items: any[], alias: string): any[] {
  return items.map(item => (item !== null && typeof item === 'object' ? item[alias] : item));
}

/**
 * Collection items read back through the mappers of the columns they carry (an aliased column, a
 * navigation's column, a nested collection's items) — how a SELECT reads a collection's items, and
 * a mutation RETURNING too: it used to hand them back as the driver sent them, a mapped column as
 * its raw storage value. @internal
 * @param applyLiterals - Read the projection's literals from its field configs (false: from the items,
 *   see SelectQueryBuilder.transformResults' literalsFromRows)
 */
export function transformCollectionItemsOf(
  items: any[],
  collectionBuilder: CollectionQueryBuilder<any>,
  fallbackRegistry: Map<string, TableSchema> | undefined,
  applyLiterals: boolean = true
): any[] {
  const targetSchema = collectionBuilder.getTargetTableSchema();
  const selectedFieldConfigs = collectionBuilder.getSelectedFieldConfigs();
  const schemaRegistryForItems = collectionBuilder.getSchemaRegistry() || fallbackRegistry;

  if (!targetSchema) {
    // No schema to read mappers from — the projection's own reads (literals, expressions) still apply
    return hasFieldReads(selectedFieldConfigs, applyLiterals)
      ? items.map(item => applyFieldReads({ ...item }, selectedFieldConfigs, undefined, schemaRegistryForItems, false, applyLiterals))
      : items;
  }

  // Use pre-cached column metadata from target schema
  // This avoids repeated column.build() calls for each item
  const columnCache = targetSchema.columnMetadataCache;

  // Build alias-to-field-info mapping from selected field configs
  // This allows us to find the correct mapper when:
  // 1. alias differs from property name (e.g., reservationExpiry: i.expiresAt)
  // 2. field comes from navigation (e.g., customerBirthdate: i.member.birthdate)
  interface FieldMapperInfo {
    propertyName: string;
    sourceTable?: string;  // If set, look up mapper from this table's schema
  }
  const aliasToFieldInfo = new Map<string, FieldMapperInfo>();
  if (selectedFieldConfigs) {
    for (const field of selectedFieldConfigs) {
      if (field.propertyName) {
        aliasToFieldInfo.set(field.alias, {
          propertyName: field.propertyName,
          sourceTable: field.sourceTable,
        });
      }
    }
  }

  // Pre-build mapper cache for all fields (including navigation fields)
  // This avoids repeated schema lookups per item
  const mapperCache = new Map<string, any>();  // alias -> mapper
  for (const [alias, fieldInfo] of aliasToFieldInfo) {
    const mapper = selectedFieldMapper(fieldInfo, columnCache, schemaRegistryForItems);
    if (mapper) {
      mapperCache.set(alias, mapper);
    }
  }

  // An expression's own mapper (`sql\`…\`.mapWith(...)`); it used to be ignored in a collection
  for (const field of selectedFieldConfigs ?? []) {
    if (field.mapper) {
      mapperCache.set(field.alias, field.mapper);
    }
  }

  // Also add direct property matches from target schema (when no alias mapping) — never for a
  // field the projection describes as something else (an expression, a literal, a nested object):
  // under a mapped column's NAME it used to go through that column's mapper
  const describedAliases = new Set((selectedFieldConfigs ?? []).map(field => field.alias));
  if (columnCache) {
    for (const [propertyName, cached] of columnCache) {
      if (!mapperCache.has(propertyName) && !describedAliases.has(propertyName) && cached.hasMapper) {
        mapperCache.set(propertyName, cached.mapper);
      }
    }
  }

  // Literals and nested objects of the projection read through their own field configs
  const readsFields = hasFieldReads(selectedFieldConfigs, applyLiterals);

  // Build cache of nested collection info (fields that are themselves nested collections)
  // This is used for recursive transformation of nested collection results
  const nestedCollectionCache = new Map<string, { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean; flattenResultType?: 'number' | 'string'; scalarAlias?: string }>();
  if (selectedFieldConfigs) {
    for (const field of selectedFieldConfigs) {
      if (field.nestedCollectionInfo) {
        nestedCollectionCache.set(field.alias, field.nestedCollectionInfo);
      }
    }
  }

  // Get schema registry for nested collection transformation
  const schemaRegistry = collectionBuilder.getSchemaRegistry() || fallbackRegistry;

  // Transform items using pre-built mapper cache
  const results: any[] = new Array(items.length);
  let i = items.length;
  while (i--) {
    const item = items[i];
    const transformedItem: any = {};
    for (const key in item) {
      const value = item[key];
      const mapper = mapperCache.get(key);
      if (mapper) {
        transformedItem[key] = mapper.fromDriver(value);
      } else {
        // Check if this field is a nested collection that needs recursive transformation
        const nestedInfo = nestedCollectionCache.get(key);
        if (nestedInfo && value !== null && value !== undefined && schemaRegistry) {
          transformedItem[key] = transformNestedCollectionValueOf(value, nestedInfo, schemaRegistry, applyLiterals);
        } else {
          transformedItem[key] = value;
        }
      }
    }
    results[i] = readsFields ? applyFieldReads(transformedItem, selectedFieldConfigs, columnCache, schemaRegistry, true, applyLiterals) : transformedItem;
  }
  return results;
}

/** The mapper of a collection field reading a column (of the item's table, or of a navigation's). */
function selectedFieldMapper(
  field: { propertyName?: string; sourceTable?: string },
  columnCache: TableSchema['columnMetadataCache'],
  schemaRegistry: Map<string, TableSchema> | undefined
): any {
  if (!field.propertyName) {
    return undefined;
  }

  const cached = field.sourceTable
    ? schemaRegistry?.get(field.sourceTable)?.columnMetadataCache?.get(field.propertyName)
    : columnCache?.get(field.propertyName);

  return cached?.hasMapper ? cached.mapper : undefined;
}

/** Whether a collection projection has fields the item mapping reads by their configs (literals, nested objects). */
function hasFieldReads(fields: SelectedField[] | undefined, applyLiterals: boolean = true): boolean {
  return fields !== undefined && fields.some(field => (applyLiterals && field.literal !== undefined) || (field.nested !== undefined && field.nested.length > 0));
}

/**
 * Applies what a collection projection's field configs say about an item's fields: a literal reads
 * back as its value (the database returns an untyped parameter as text — `42` came back "42",
 * `true` "true"), and a nested object's fields read like top-level ones — a literal as itself, a
 * column through its mapper, an expression through its own. `topLevelDone` skips the top level's
 * columns and expressions, which the caller already mapped.
 */
function applyFieldReads(
  item: any,
  fields: SelectedField[] | undefined,
  columnCache: TableSchema['columnMetadataCache'],
  schemaRegistry: Map<string, TableSchema> | undefined,
  topLevelDone: boolean = false,
  applyLiterals: boolean = true
): any {
  if (fields === undefined || item === null || typeof item !== 'object') {
    return item;
  }

  for (const field of fields) {
    if (field.literal !== undefined) {
      if (applyLiterals) {
        item[field.alias] = field.literal.value;
      }
    } else if (field.nested !== undefined) {
      const nested = item[field.alias];

      if (nested !== null && typeof nested === 'object') {
        item[field.alias] = applyFieldReads({ ...nested }, field.nested, columnCache, schemaRegistry, false, applyLiterals);
      }
    } else if (!topLevelDone && field.alias in item) {
      const mapper = field.mapper ?? selectedFieldMapper(field, columnCache, schemaRegistry);

      if (mapper && typeof mapper.fromDriver === 'function') {
        item[field.alias] = mapper.fromDriver(item[field.alias]);
      }
    }
  }

  return item;
}

/**
 * Transform a nested collection value (from firstOrDefault or toList inside another collection)
 * Applies custom mappers to fields within the nested collection result.
 */
function transformNestedCollectionValueOf(
  value: any,
  nestedInfo: { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean; flattenResultType?: 'number' | 'string'; scalarAlias?: string },
  schemaRegistry: Map<string, TableSchema>,
  applyLiterals: boolean = true
): any {
  // Flattened lists (toNumberList/toStringList) return a primitive array directly
  // from the driver — no per-element object transformation applies. Iterating with
  // `for (const key in item)` on a number/string would yield an empty object, so
  // short-circuit here before touching any elements.
  if (nestedInfo.flattenResultType) {
    return value;
  }

  // A collection selecting ONE value reads as its values (see isScalarSelection): its items are
  // transformed as the one-field objects they arrive as, then unwrapped
  if (nestedInfo.scalarAlias !== undefined) {
    const { scalarAlias, ...objectInfo } = nestedInfo;
    const transformed = transformNestedCollectionValueOf(value, objectInfo, schemaRegistry, applyLiterals);

    if (Array.isArray(transformed)) {
      return unwrapScalarItems(transformed, scalarAlias);
    }

    return transformed !== null && typeof transformed === 'object' ? transformed[scalarAlias] : transformed;
  }

  const nestedSchema = schemaRegistry.get(nestedInfo.targetTable);
  if (!nestedSchema?.columnMetadataCache) {
    return value;  // No schema info, return as-is
  }

  const columnCache = nestedSchema.columnMetadataCache;
  const selectedFieldConfigs = nestedInfo.selectedFieldConfigs;

  // Build mapper cache for nested collection fields
  const mapperCache = new Map<string, any>();

  // First, add mappers from selected field configs (for aliased/navigation fields, and an
  // expression's own `mapWith`)
  if (selectedFieldConfigs) {
    for (const field of selectedFieldConfigs) {
      const mapper = field.mapper ?? selectedFieldMapper(field, columnCache, schemaRegistry);
      if (mapper) {
        mapperCache.set(field.alias, mapper);
      }
    }
  }

  // Also add direct property matches from target schema — never for a field the projection
  // describes as something else (see transformCollectionItemsOf)
  const describedAliases = new Set((selectedFieldConfigs ?? []).map(field => field.alias));
  for (const [propertyName, cached] of columnCache) {
    if (!mapperCache.has(propertyName) && !describedAliases.has(propertyName) && cached.hasMapper) {
      mapperCache.set(propertyName, cached.mapper);
    }
  }

  // Literals and nested objects of the projection read through their own field configs
  const readsFields = hasFieldReads(selectedFieldConfigs, applyLiterals);

  // Build cache for any deeply nested collections
  const deeplyNestedCache = new Map<string, { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean; flattenResultType?: 'number' | 'string'; scalarAlias?: string }>();
  if (selectedFieldConfigs) {
    for (const field of selectedFieldConfigs) {
      if (field.nestedCollectionInfo) {
        deeplyNestedCache.set(field.alias, field.nestedCollectionInfo);
      }
    }
  }

  // Transform the value(s)
  const transformItem = (item: any): any => {
    if (item === null || item === undefined) {
      return item;
    }
    const transformedItem: any = {};
    for (const key in item) {
      const fieldValue = item[key];
      const mapper = mapperCache.get(key);
      if (mapper) {
        transformedItem[key] = mapper.fromDriver(fieldValue);
      } else {
        // Check for deeply nested collections
        const deepNestedInfo = deeplyNestedCache.get(key);
        if (deepNestedInfo && fieldValue !== null && fieldValue !== undefined) {
          transformedItem[key] = transformNestedCollectionValueOf(fieldValue, deepNestedInfo, schemaRegistry, applyLiterals);
        } else {
          transformedItem[key] = fieldValue;
        }
      }
    }
    return readsFields ? applyFieldReads(transformedItem, selectedFieldConfigs, columnCache, schemaRegistry, true, applyLiterals) : transformedItem;
  };

  if (nestedInfo.isSingleResult) {
    // Single item (firstOrDefault)
    return transformItem(value);
  } else if (Array.isArray(value)) {
    // Array of items (toList)
    return value.map(transformItem);
  } else {
    // Single object that should be treated as single result
    return transformItem(value);
  }
}

/**
 * How one value of a mutation's RETURNING selection reads back — a column or an `sql` expression
 * (through its own mapper), a literal, a collection, a nested object — keyed by its result key, in
 * selection order. It is built while the RETURNING renders, and the rows are read through it: they
 * used to be mapped by their result KEYS, so an aliased column (`when: ln.dueAt`) lost its mapper
 * and a value under a column's name (a fragment, another column) got that column's. @internal
 */
export type ReturningRead =
  | { kind: 'value'; column: string; mapper?: { fromDriver(value: any): any } }
  | { kind: 'constant'; value: unknown }
  | { kind: 'collection'; column: string; collection: any }
  | { kind: 'nested'; shape: ReturningShape };

/** The fields of a RETURNING row (or of a nested object in it), in selection order. @internal */
export type ReturningShape = Array<{ key: string; read: ReturningRead }>;

/**
 * The read plan of a mutation's RETURNING: the shape of its rows, and whether its selector returned
 * ONE value (`ln => ln.note`) — each row then reads as that value, as `.returning()`'s type says.
 * @internal
 */
export interface ReturningReadPlan {
  shape: ReturningShape;
  scalar: boolean;
}

/**
 * The column a RETURNING returns when its selection has no SQL value at all (only literals), so the
 * statement still yields one row per mutated row. @internal
 */
export const RETURNING_PLACEHOLDER_COLUMN = '__returning__';

/** A nested projection — a plain object literal of fields, not a column, an expression, a collection or a value. */
const isNestedProjection = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || '__dbColumnName' in value || '__collectionResult' in value) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
};

/**
 * A value of a mutation's RETURNING selection, prepared for the walkers: a navigation row projected
 * whole (`printed: ln.edition.book`) becomes an object of its columns — the walkers read with
 * `Object.entries`, which sees nothing of a mock row (its columns are inherited getters), so such a
 * field vanished from the result; a SELECT returns the same object — and a condition or a subquery
 * becomes the `sql` expression it renders, a fragment interpolating it (which parenthesizes it and
 * reports its refs). A condition used to be walked as a nested object and came back as its own
 * internals (`{ field: 7 }`).
 */
const prepareReturningValue = (value: any): any => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || '__dbColumnName' in value
    || value instanceof CollectionQueryBuilder || value instanceof SqlFragment) {
    return value;
  }

  if (value instanceof WhereConditionBase || value instanceof Subquery) {
    return new SqlFragment(['', ''], [value]);
  }

  const row = materializeMockSelection(value);

  if (row !== value) {
    return row;
  }

  if (!isNestedProjection(value)) {
    // A value (a Date, any class instance) stays as it is
    return value;
  }

  let changed = false;
  const out: Record<string, any> = {};

  for (const [key, field] of Object.entries(value)) {
    out[key] = prepareReturningValue(field);
    changed = changed || out[key] !== field;
  }

  return changed ? out : value;
};

/**
 * What a mutation's RETURNING selector returned, ready to render (see prepareReturningValue). A
 * selector returning ONE value — a column, a navigation's column, an `sql` expression, a condition,
 * a collection — renders as `{ __value: <value> }`, each row reading as that value (`scalar`): its
 * RETURNING list used to render empty, the value's own ref keys read as the projection's fields.
 * @internal
 */
export function returningSelection(result: unknown): { selection: Record<string, unknown>; scalar: boolean } {
  const prepared = prepareReturningValue(result);

  return isNestedProjection(prepared)
    ? { selection: prepared, scalar: false }
    : { selection: { [SCALAR_SELECTION_ALIAS]: prepared }, scalar: true };
}

/**
 * One value of a (prepared, see returningSelection) mutation RETURNING selection. An `undefined`
 * field is left out, as a SELECT leaves it out; a literal — a string, a number, a Date, `null`, an
 * array of values — reads back as it is. @internal
 */
export type ReturningValue =
  | { kind: 'column'; ref: FieldRef }
  | { kind: 'expression'; fragment: SqlFragment }
  | { kind: 'collection'; collection: any }
  | { kind: 'nested'; value: Record<string, unknown> }
  | { kind: 'constant'; value: unknown }
  | { kind: 'skip' };

/** Classifies one value of a mutation's RETURNING selection; `path` names it in errors. @internal */
export function classifyReturningValue(value: unknown, path: string): ReturningValue {
  if (value === undefined) {
    return { kind: 'skip' };
  }

  if (value === null || typeof value !== 'object') {
    return { kind: 'constant', value };
  }

  if (value instanceof CollectionQueryBuilder || '__collectionResult' in value) {
    return { kind: 'collection', collection: value };
  }

  if ('__dbColumnName' in value) {
    return { kind: 'column', ref: value as FieldRef };
  }

  if (value instanceof SqlFragment) {
    return { kind: 'expression', fragment: value };
  }

  if (value instanceof WhereConditionBase || value instanceof Subquery) {
    return { kind: 'expression', fragment: new SqlFragment(['', ''], [value]) };
  }

  if (isNestedProjection(value)) {
    return { kind: 'nested', value };
  }

  if (Array.isArray(value) && value.some((item, i) => item !== null && typeof item === 'object' && classifyReturningValue(item, `${path}[${i}]`).kind !== 'constant')) {
    throw new Error(
      `RETURNING field "${path}" is an array of columns or expressions, which has no single SQL value to return — `
      + 'select them as an object, or build the array in SQL (sql`ARRAY[...]`)'
    );
  }

  return { kind: 'constant', value };
}

/** The `mapWith` mapper of an `sql` expression, resolved the way a SELECT resolves it. @internal */
export function fragmentReadMapper(fragment: SqlFragment): { fromDriver(value: any): any } | undefined {
  let mapper: any = fragment.getMapper();

  if (mapper && typeof mapper.getType === 'function') {
    mapper = mapper.getType();
  }

  return mapper && typeof mapper.fromDriver === 'function' ? mapper : undefined;
}

/**
 * Renders an `sql` expression of a mutation's RETURNING. The columns of the mutated row it reads
 * render as `columnSql` gives them — a column qualified by the table's alias (MERGE, bulkUpdate), a
 * column of the navigation RETURNING's CTE: their plain `"table"."col"` is not in scope there. Only
 * the expression's own refs render so (a subquery's inner columns keep their table). Its parameters
 * append to `context`. @internal
 */
export function renderReturningExpression(
  fragment: SqlFragment,
  context: SqlBuildContext,
  isOwnColumn: (ref: FieldRef) => boolean,
  columnSql: (ref: FieldRef) => string
): string {
  const ownRefs = new Set<object>(fragment.getFieldRefs().filter(isOwnColumn));
  const previous = context.substitute;
  context.substitute = (value, ctx) => (ownRefs.has(value) ? columnSql(value as FieldRef) : previous?.(value, ctx));

  try {
    return fragment.buildSql(context);
  } finally {
    context.substitute = previous;
  }
}

/**
 * What differs between the mutations in a plain (single-statement) RETURNING: how a column of the
 * mutated row renders — bare, qualified by the table, or by its alias — and reads back. @internal
 */
export interface PlainReturningHooks {
  isOwnColumn(ref: FieldRef): boolean;
  columnSql(ref: FieldRef): string;
  columnMapper(ref: FieldRef): { fromDriver(value: any): any } | undefined;
  /** The statement's parameters: an expression's append here (RETURNING ends the statement). */
  context: SqlBuildContext;
  /**
   * Bind the selection's literals as parameters instead of reading them from the plan: a compiled
   * statement (`toStatement()`) is read by SQL, which sees only what the statement returns.
   */
  constantsAsParams?: boolean;
}

/**
 * Renders a mutation's plain RETURNING list — the mutated row's own columns, `sql` expressions over
 * them, literals — and its read plan. A selection reading anything else (a navigation, a collection,
 * a nested object) takes the navigation RETURNING. @internal
 */
export function renderPlainReturning(
  selection: Record<string, unknown>,
  hooks: PlainReturningHooks
): { sql: string; columns: string[]; shape: ReturningShape } {
  const parts: string[] = [];
  const columns: string[] = [];
  const shape: ReturningShape = [];

  for (const [key, value] of Object.entries(selection)) {
    const classified = classifyReturningValue(value, key);

    switch (classified.kind) {
      case 'skip':
        break;
      case 'column':
        if (!hooks.isOwnColumn(classified.ref)) {
          throw new Error(`RETURNING field "${key}" reads a column of another table, which this RETURNING cannot join`);
        }

        parts.push(`${hooks.columnSql(classified.ref)} AS "${key}"`);
        columns.push(key);
        shape.push({ key, read: { kind: 'value', column: key, mapper: hooks.columnMapper(classified.ref) } });
        break;
      case 'expression':
        parts.push(`${renderReturningExpression(classified.fragment, hooks.context, hooks.isOwnColumn, hooks.columnSql)} AS "${key}"`);
        columns.push(key);
        shape.push({ key, read: { kind: 'value', column: key, mapper: fragmentReadMapper(classified.fragment) } });
        break;
      case 'constant':
        if (hooks.constantsAsParams) {
          parts.push(`$${hooks.context.paramCounter++} AS "${key}"`);
          hooks.context.params.push(classified.value);
          columns.push(key);
        }

        shape.push({ key, read: { kind: 'constant', value: classified.value } });
        break;
      default:
        throw new Error(`RETURNING field "${key}" reads a ${classified.kind === 'nested' ? 'nested object' : 'collection'}, which this RETURNING cannot render`);
    }
  }

  if (parts.length === 0) {
    parts.push(`NULL AS "${RETURNING_PLACEHOLDER_COLUMN}"`);
  }

  return { sql: parts.join(', '), columns, shape };
}

/**
 * A collection a mutation's RETURNING projects, read the way a SELECT reads it: an aggregate as its
 * number, a list's items (and a `firstOrDefault()`'s item) through their columns' mappers, and a
 * collection selecting ONE value as its values. @internal
 */
export function readCollectionResult(collection: any, raw: any, registry: Map<string, TableSchema> | undefined): any {
  if (!(collection instanceof CollectionQueryBuilder)) {
    return raw;
  }

  if (collection.isScalarAggregation()) {
    return scalarCollectionValue(collection.getAggregationType(), raw);
  }

  if (typeof (collection as any).isArrayAggregation === 'function' && (collection as any).isArrayAggregation()) {
    return raw ?? [];
  }

  const scalarAlias = collection.getScalarSelectionAlias();

  if (collection.isSingleResult()) {
    if (raw === null || raw === undefined) {
      return null;
    }

    const items = transformCollectionItemsOf([raw], collection, registry);

    return (scalarAlias !== undefined ? unwrapScalarItems(items, scalarAlias) : items)[0] ?? null;
  }

  const items = transformCollectionItemsOf(raw ?? [], collection, registry);

  return scalarAlias !== undefined ? unwrapScalarItems(items, scalarAlias) : items;
}

/** A mutation's RETURNING rows, read through the plan its rendering built (see ReturningRead). @internal */
export function readReturningRows(rows: any[], plan: ReturningReadPlan, registry: Map<string, TableSchema> | undefined): any[] {
  const readShape = (row: any, shape: ReturningShape): any => {
    const out: any = {};

    for (const { key, read } of shape) {
      switch (read.kind) {
        case 'value': {
          const raw = row[read.column];
          out[key] = read.mapper ? read.mapper.fromDriver(raw) : raw;
          break;
        }
        case 'constant':
          out[key] = read.value;
          break;
        case 'collection':
          out[key] = readCollectionResult(read.collection, row[read.column], registry);
          break;
        case 'nested':
          out[key] = readShape(row, read.shape);
          break;
      }
    }

    return out;
  };

  return rows.map(row => {
    const out = readShape(row, plan.shape);

    return plan.scalar ? out[SCALAR_SELECTION_ALIAS] : out;
  });
}

/**
 * Type helper to resolve collection results to arrays
 * Transforms CollectionResult<T> to T[] and resolves FieldRef to their value types
 */
export type ResolveCollectionResults<T> = {
  [K in keyof T]: T[K] extends CollectionResult<infer TItem>
  ? ResolveFieldRefs<TItem>[]
  : ResolveFieldRefs<T[K]>;
};

/**
 * Reference query builder for single navigation (many-to-one, one-to-one)
 */
export class ReferenceQueryBuilder<TItem = any> {
  private relationName: string;
  private targetTable: string;
  private targetTableSchema?: TableSchema;
  private foreignKeys: string[];  // Column(s) in source table
  private matches: string[];      // Column(s) in target table
  private isMandatory: boolean;
  private schemaRegistry?: Map<string, TableSchema>;
  // Navigation path leading to this reference (for nested collections)
  private navigationPath: NavigationJoin[];
  // Source alias for this reference (the table containing the FK)
  private sourceAlias: string;
  // Set for a navigation reached from a MANUALLY joined table (and for every hop below it): the
  // alias this hop renders under. The relation name cannot be the alias there — it is resolved by
  // name against the root's relations and would bind to the root's navigation of the same name.
  private explicitAlias?: string;

  constructor(
    relationName: string,
    targetTable: string,
    foreignKeys: string[],
    matches: string[],
    isMandatory: boolean,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>,
    navigationPath?: NavigationJoin[],
    sourceAlias?: string,
    explicitAlias?: string
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.foreignKeys = foreignKeys;
    this.matches = matches;
    this.isMandatory = isMandatory;
    this.schemaRegistry = schemaRegistry;
    this.navigationPath = navigationPath || [];
    this.sourceAlias = sourceAlias || '';
    this.explicitAlias = explicitAlias;

    // Prefer registry lookup (has full relations) over passed schema
    if (this.schemaRegistry) {
      this.targetTableSchema = this.schemaRegistry.get(targetTable);
    }
    // Fallback to passed schema if registry lookup failed
    if (!this.targetTableSchema) {
      this.targetTableSchema = targetTableSchema;
    }
  }

  /**
   * Get the alias to use for this reference in the query
   */
  getAlias(): string {
    return this.explicitAlias ?? this.relationName;
  }

  /**
   * Get target table name
   */
  getTargetTable(): string {
    return this.targetTable;
  }

  /**
   * Get foreign keys
   */
  getForeignKeys(): string[] {
    return this.foreignKeys;
  }

  /**
   * Get matches
   */
  getMatches(): string[] {
    return this.matches;
  }

  /**
   * Is this a mandatory relation (INNER JOIN vs LEFT JOIN)
   */
  getIsMandatory(): boolean {
    return this.isMandatory;
  }

  /**
   * Get target table schema
   */
  getTargetTableSchema(): TableSchema | undefined {
    return this.targetTableSchema;
  }

  /**
   * Create a mock object that exposes the target table's columns
   * This allows accessing related fields like: p.user.username
   */
  createMockTargetRow(holder?: MockPrototypeHolder, chainId?: string | number): any {
    if (this.targetTableSchema) {
      // Prototype-level cache — see MockRowCache's doc. Everything the getters close over
      // is fully determined by (target schema object identity, relationName, sourceAlias,
      // navigation-path content), so rows with the same signature can share one prebuilt
      // PROTOTYPE carrying every column/relation getter; a new row is then `Object.create`
      // plus its two own state slots — O(1) instead of one property definition per column.
      // The cross-row cache is OPT-IN via the static switch (MockRowCache.setEnabled — the
      // host app flips it from its own config): with it off, each row gets a FRESH
      // prototype (the pre-0.4.66 memory profile — nothing retained beyond the row's
      // lifetime), while the per-row FieldRef and navigation slots stay row-scoped either
      // way (the shared getters read them through `this`).
      //
      // Consumers must not probe these rows with OWN-property APIs (`Object.keys`,
      // `getOwnPropertyNames`, `getOwnPropertyDescriptor` on the row itself) — the getters
      // are inherited. Use `isReferenceMockRow` / `findFirstGetterKey` instead.
      //
      // The getter that minted this builder may hand in its MockPrototypeHolder: a filled holder
      // short-circuits the key build and the lookup, and a miss fills it (switch on only).
      const enabled = MockRowCache.isEnabled();
      let prototype = enabled ? holder?.prototype : undefined;

      if (prototype === undefined) {
        prototype = MockRowCache.getOrBuild(
          enabled
            ? `${this.targetTable}|${this.relationName}|${this.sourceAlias ?? ''}|${navigationPathSignature(this.navigationPath)}`
              + (this.explicitAlias !== undefined ? `|@${this.explicitAlias}` : '')
            : '',
          () => Object.defineProperties({}, this.buildMockRowDescriptors()),
        );

        if (enabled && holder !== undefined) {
          holder.prototype = prototype;
        }
      }

      return mintReferenceMockRow(prototype, chainId);
    } else {
      // Fallback: use the shared nested proxy that supports deep property access
      return createNestedFieldRefProxy(this.getAlias());
    }
  }

  /**
   * Builds the shared property-descriptor map for {@link createMockTargetRow}'s cached path.
   * The getters read per-row state through `this`-bound symbol slots, so one descriptor
   * map serves every row of the same signature.
   */
  private buildMockRowDescriptors(): PropertyDescriptorMap {
    // Add columns - use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.targetTableSchema!);
    const tableAlias = this.getAlias();

    // Build a mapper lookup for columns (only when needed)
    const columnMappers: Record<string, any> = {};
    const columnSqlTypes: Record<string, string> = {};
    for (const [colName, meta] of getSchemaColumnMeta(this.targetTableSchema!)) {
      if (meta.mapper) {
        columnMappers[colName] = meta.mapper;
      }
      if (meta.type) {
        columnSqlTypes[colName] = meta.type;
      }
      }

    const sourceTable = this.targetTable;  // Actual table name for schema lookup
    // Collect all navigation aliases from the path leading to this reference
    // This is needed for WHERE conditions that use multi-level navigation (e.g., task.level.name)
    const navigationAliases = this.navigationPath.map(nav => nav.alias);

    // Build extended navigation path for nested collections
    // Only build navigation path if we have a sourceAlias (meaning we're inside a collection's selector)
    // If sourceAlias is empty, we're in the main query and references are joined in the FROM clause
    let extendedNavPath: NavigationJoin[] = [];
    if (this.sourceAlias) {
      // Build the current navigation step to include in path for nested collections
      // This represents the join from sourceAlias to this.relationName (this.targetTable)
      const currentNavStep: NavigationJoin = {
        alias: tableAlias,
        targetTable: this.targetTable,
        foreignKeys: this.foreignKeys,
        matches: this.matches.length > 0 ? this.matches : ['id'],  // Default to 'id' if not specified
        // Below a manually joined table every hop is a LEFT JOIN: the join may be a LEFT one
        // whose row is missing, and a required hop's INNER JOIN would then drop the row it kept.
        // From a present parent a required hop always matches, so LEFT loses nothing there.
        isMandatory: this.explicitAlias !== undefined ? false : this.isMandatory,
        sourceAlias: this.sourceAlias,
      };
      if (this.targetTableSchema?.schema) {
        currentNavStep.targetSchema = this.targetTableSchema.schema;
      }
      extendedNavPath = [...this.navigationPath, currentNavStep];
    }

    // A hop below a manually joined table cannot be found by its name (see explicitAlias), so its
    // columns carry the whole path from the join; the query emits exactly those joins.
    const joinPath = this.explicitAlias !== undefined ? extendedNavPath : undefined;

    const descriptors: PropertyDescriptorMap = {};

    for (const [colName, dbColumnName] of columnNameMap) {
      const mapper = columnMappers[colName];
      descriptors[colName] = {
        get(this: any) {
          const slots: MockRowSlots = this;
          const fieldRefCache = slots[MOCK_ROW_FIELD_REFS] ??= {};
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,  // Alias for SQL generation
              // Identity of the query this navigation hangs off — see mintReferenceMockRow.
              __chainId: slots[MOCK_ROW_CHAIN_ID],
              __sourceTable: sourceTable,  // Actual table name for mapper lookup
              __mapper: mapper,  // Include mapper for toDriver transformation in conditions
              __sqlType: columnSqlTypes[colName],  // Column SQL type — lets flag* emit width-exact mask casts
              __navigationAliases: navigationAliases,  // All intermediate navigation aliases for JOIN resolution
            };
            if (joinPath !== undefined) {
              cached.__joinPath = joinPath;
            }
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      };
    }

    // Values captured at descriptor-build time — identical for every row of this
    // signature (the registry is the process-wide schema registry; `sourceAlias`
    // determines whether nested references track their join path).
    const schemaRegistry = this.schemaRegistry;
    const parentSourceAlias = this.sourceAlias;
    const explicitParent = this.explicitAlias !== undefined;

    // Add navigation properties (both collections and references)
    if (this.targetTableSchema!.relations) {
      for (const [relName, relConfig] of Object.entries(this.targetTableSchema!.relations)) {
        // Try to get target schema from registry (preferred, has full relations) or targetTableBuilder
        let nestedTargetSchema: TableSchema | undefined;
        if (this.schemaRegistry) {
          nestedTargetSchema = this.schemaRegistry.get(relConfig.targetTable);
        }
        if (!nestedTargetSchema && relConfig.targetTableBuilder) {
          nestedTargetSchema = relConfig.targetTableBuilder.build();
        }

        if (relConfig.type === 'many') {
          // Collection navigation
          // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
          descriptors[relName] = {
            get(this: any) {
              const slots: MockRowSlots = this;
              const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
              // Memoize per row: selectors revisit the same navigation repeatedly
              // (aggregates, predicates), and each fresh visit used to rebuild the
              // whole sub-graph. BUT never hand a builder out again once an in-place
              // op (`.where()` / `.orderBy()` / `.limit()` / `.offset()`) has written
              // to it: that instance is a query root some already-captured condition
              // owns, and sharing it fuses independent predicates — the two-leg gate
              // `or(notExists(row.nav), exists(row.nav.where(P)))` used to compile
              // both legs from ONE object and emit `NOT EXISTS(P) OR EXISTS(P)`
              // ≡ TRUE (valid SQL, silently wrong rows). Re-minting restores the
              // invariant the root mock's relation getters keep by never memoizing
              // at all (see _createMockRow: "memoizing would fuse repeated .where()
              // chains"); repeated PURE reads still share one builder.
              let cached = navCache[relName];
              if (cached === undefined || cached.hasInPlaceWrites()) {
                const fk = relConfig.foreignKey || relConfig.foreignKeys?.[0] || '';
                cached = navCache[relName] = new CollectionQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  fk,
                  tableAlias,  // Use alias (relationName) for correlation in lateral joins
                  nestedTargetSchema,  // Pass the target schema directly
                  schemaRegistry,  // Pass schema registry for nested resolution
                  extendedNavPath,  // Pass navigation path for intermediate joins (empty if main query)
                  relConfig.foreignKeys,  // Propagate composite FK / literal predicates
                  relConfig.matches
                );
              }
              return cached;
            },
            enumerable: false,
            configurable: true,
          };
        } else {
          // Reference navigation
          // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow
          // with circular relations like User->Posts->User)
          const holder: MockPrototypeHolder = {};
          descriptors[relName] = {
            get(this: any) {
              const slots: MockRowSlots = this;
              const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
              let cached = navCache[relName];
              if (cached === undefined) {
                if (holder.prototype !== undefined && MockRowCache.isEnabled()) {
                  cached = navCache[relName] = mintReferenceMockRow(holder.prototype, slots[MOCK_ROW_CHAIN_ID]);
                } else {
                  const refBuilder = new ReferenceQueryBuilder(
                    relName,
                    relConfig.targetTable,
                    relConfig.foreignKeys || [relConfig.foreignKey || ''],
                    relConfig.matches || [],
                    relConfig.isMandatory ?? false,
                    nestedTargetSchema,  // Pass the target schema directly
                    schemaRegistry,  // Pass schema registry for nested resolution
                    extendedNavPath,  // Pass navigation path for nested collections
                    parentSourceAlias ? tableAlias : '',  // Only set source if tracking path
                    explicitParent ? explicitNavigationAlias(tableAlias, relName) : undefined
                  );
                  cached = navCache[relName] = refBuilder.createMockTargetRow(holder, slots[MOCK_ROW_CHAIN_ID]);
                }
              }
              return cached;
            },
            enumerable: false,
            configurable: true,
          };
        }
      }
    }

    return descriptors;
  }
}

/**
 * Collection query builder for nested queries
 */
export class CollectionQueryBuilder<TItem = any> {
  private relationName: string;
  private targetTable: string;
  private targetTableSchema?: TableSchema;  // Optional schema for type-safe operations
  private foreignKey: string;
  // Full composite FK column list on the target (child) side. May contain
  // `__LIT:<value>` markers for constant FK predicates (e.g. SCD2 `is_current = TRUE`).
  // When present (length > 0), all strategies must build the parent-correlation
  // WHERE by iterating this in lock-step with `matches`, not via the legacy
  // single-column `foreignKey = sourceTable.id` form. The latter silently drops
  // every literal predicate past index 0.
  private foreignKeys: string[];
  // Match-key columns on the source (parent) side. Paired index-for-index with
  // `foreignKeys`. May also contain `__LIT:<value>` markers. Defaults to `['id']`.
  private matches: string[];
  private sourceTable: string;
  private selector?: (item: any) => any;
  private whereCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  // `table` is the alias the ordered column rendered under: the collection marker for an own
  // column, a relation name for a navigation column; `ref` is the column's own ref, which the
  // build renders qualified (under its planned alias) and joins like a projected navigation.
  // `fragment` is a key that is an SQL expression (a `sql` fragment, a condition, a nested
  // collection's count / exists), rendered in the collection's parameter sequence; `field` is empty.
  private orderByFields: Array<{ field: string; direction: OrderDirection; table?: string; ref?: FieldRef; fragment?: Condition }> = [];
  private asName?: string;
  private isMarkedAsList: boolean = false;
  private isDistinct: boolean = false;
  private aggregationType?: 'MIN' | 'MAX' | 'SUM' | 'COUNT' | 'EXISTS';
  private flattenResultType?: 'number' | 'string';
  /** Set by a build whose selector returned ONE value (see isScalarSelection): the field its items are unwrapped from. */
  private scalarSelectionAlias?: string;
  private schemaRegistry?: Map<string, TableSchema>;
  // Navigation path leading to this collection (for intermediate joins in lateral subqueries)
  private navigationPath: NavigationJoin[];
  // Navigation joins added by selectMany() - included in both CTE and LATERAL navigation joins
  private selectManyJoins: NavigationJoin[] = [];
  // When FK is on a different table than target (from selectMany), the table alias to qualify FK
  private foreignKeyTableAlias?: string;

  // Performance: Cache the mock item to avoid recreating it
  private _cachedMockItem?: any;
  // The selector's result on the mock item (see evaluateSelector); never copied to derived builders
  private evaluatedSelection?: { result: any };
  // Cache selected field configs for mapper lookup during transformation
  private _selectedFieldConfigs?: SelectedField[];

  /**
   * @internal Chain identity — see chainIdSeq. Stamped on every row this collection mints (its
   * item rows and the navigation rows reached through them), so a ref can be told apart from one
   * minted by an ENCLOSING query — including an enclosing COLLECTION, whose rows used to carry no
   * identity at all and therefore looked exactly like this collection's own. Every builder derived
   * from this one (`select`, `selectMany`) keeps the id: a `where` built before the `select`
   * must stay this collection's own.
   */
  public chainId: number = ++chainIdSeq;

  /**
   * True once an in-place chainable op (`where`, `orderBy`, `limit`, `offset`) has written
   * state into this instance. Read through {@link hasInPlaceWrites} by the memoized
   * collection-navigation getter (ReferenceQueryBuilder.buildMockRowDescriptors), which
   * re-mints instead of handing a written builder out again — a written instance is a query
   * root some captured condition already owns, and sharing it would fuse independent
   * predicates. Terminal reads (`exists()`, `count()`, `min()`/`max()`/`sum()`, the
   * `toList()` family) do NOT set this: they snapshot instead of writing
   * (see {@link captureSnapshot}).
   */
  private writtenInPlace: boolean = false;

  /**
   * @internal The navigation plan of the build in progress (see {@link withNavigationPlan});
   * `undefined` between builds and for builds it cannot change. Never copied to derived builders.
   */
  private navigationPlan?: NavigationAliasPlan;

  constructor(
    relationName: string,
    targetTable: string,
    foreignKey: string,
    sourceTable: string,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>,
    navigationPath?: NavigationJoin[],
    foreignKeys?: string[],
    matches?: string[]
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.targetTableSchema = targetTableSchema;
    this.foreignKey = foreignKey;
    // Default `foreignKeys` to the single-column form so every strategy can
    // iterate uniformly. Constant FK predicates ([col, literal] + [id, true])
    // arrive via the explicit `foreignKeys`/`matches` arrays passed from the
    // navigation metadata.
    this.foreignKeys = (foreignKeys && foreignKeys.length > 0) ? foreignKeys : (foreignKey ? [foreignKey] : []);
    this.matches = (matches && matches.length > 0) ? matches : ['id'];
    this.sourceTable = sourceTable;
    this.schemaRegistry = schemaRegistry;
    this.navigationPath = navigationPath || [];

    // Prefer registry lookup (has full relations) over passed schema
    if (this.schemaRegistry) {
      const registrySchema = this.schemaRegistry.get(targetTable);
      if (registrySchema) {
        this.targetTableSchema = registrySchema;
      }
    }
    // Fallback to passed schema if registry lookup failed
    if (!this.targetTableSchema) {
      this.targetTableSchema = targetTableSchema;
    }
  }

  /**
   * Select specific fields from collection items
   */
  select<TSelection>(selector: (item: TItem) => TSelection): CollectionQueryBuilder<TSelection> {
    const newBuilder = new CollectionQueryBuilder<TSelection>(
      this.relationName,
      this.targetTable,
      this.foreignKey,
      this.sourceTable,
      this.targetTableSchema,
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      this.navigationPath,  // Pass navigation path for intermediate joins
      this.foreignKeys,      // Propagate composite/literal FK metadata
      this.matches
    );
    newBuilder.selector = selectorProjectingConditions(selector as any);
    newBuilder.whereCond = this.whereCond;
    newBuilder.limitValue = this.limitValue;
    newBuilder.offsetValue = this.offsetValue;
    // Copy, not alias: `orderBy()` PUSHES into this array, so sharing it would let an
    // orderBy on the derived builder write through into this one (or vice versa) — this
    // instance may be the per-row memoized navigation node other conditions still read.
    newBuilder.orderByFields = [...this.orderByFields];
    newBuilder.asName = this.asName;
    newBuilder.isDistinct = this.isDistinct;
    newBuilder.selectManyJoins = this.selectManyJoins;
    newBuilder.foreignKeyTableAlias = this.foreignKeyTableAlias;
    newBuilder.chainId = this.chainId;
    return newBuilder;
  }

  /**
   * Full-state copy of this builder onto a fresh instance (same chain identity).
   *
   * Terminal reads — `exists()`, `count()`, `min()`/`max()`/`sum()`, `toList()` and its
   * variants, `firstOrDefault()` — return this snapshot instead of writing their result
   * shape into `this`. The instance they are called on may be the per-row MEMOIZED
   * navigation node (see ReferenceQueryBuilder.buildMockRowDescriptors), which every
   * access of `row.nav` inside one lambda hands out again, or a node the caller captured
   * in a variable and reuses. A terminal that mutated `this` made the captured
   * condition share live state with every later use of the node:
   * `or(notExists(row.nav), exists(row.nav.where(P)))` compiled both legs from ONE
   * object and emitted `NOT EXISTS(P) OR EXISTS(P)` ≡ TRUE — valid SQL, silently wrong
   * rows. Snapshotting at capture time makes every captured leg independent, for the
   * re-retrieved and the variable-captured form alike, and keeps condition resolution
   * (ExistsConditionBase calling `.exists()`) a true read that persists nothing.
   *
   * `chainId` is carried over so conditions built against this builder's item rows stay
   * "own" refs of the snapshot; `_cachedMockItem` is shared deliberately — its FieldRefs
   * are stamped with that same chainId, so the snapshot answers identity questions
   * identically. `_selectedFieldConfigs` stays behind: it is resolution-phase output
   * written to the CAPTURED object after the build, not carried-forward build state.
   * `writtenInPlace` intentionally resets: the snapshot is unshared until it is written.
   */
  private captureSnapshot(): CollectionQueryBuilder<TItem> {
    // A terminal read runs once per selector/condition evaluation, so this stays lean:
    // `new` keeps the hidden class identical to every other builder (downstream reads
    // stay monomorphic), while passing `undefined` for the registry skips the
    // constructor's Map lookup — this instance already carries the resolved schema and
    // normalized foreignKeys/matches, so they copy through unchanged.
    const snapshot = new CollectionQueryBuilder<TItem>(
      this.relationName,
      this.targetTable,
      this.foreignKey,
      this.sourceTable,
      this.targetTableSchema,
      undefined,  // registry set below — skips the constructor's lookup
      this.navigationPath,
      this.foreignKeys,
      this.matches
    );
    snapshot.schemaRegistry = this.schemaRegistry;
    snapshot.selector = this.selector;
    snapshot.whereCond = this.whereCond;
    snapshot.limitValue = this.limitValue;
    snapshot.offsetValue = this.offsetValue;
    snapshot.orderByFields = this.orderByFields.length > 0 ? [...this.orderByFields] : [];
    snapshot.asName = this.asName;
    snapshot.isMarkedAsList = this.isMarkedAsList;
    snapshot.isDistinct = this.isDistinct;
    snapshot.aggregationType = this.aggregationType;
    snapshot.flattenResultType = this.flattenResultType;
    snapshot.selectManyJoins = this.selectManyJoins;
    snapshot.foreignKeyTableAlias = this.foreignKeyTableAlias;
    snapshot.chainId = this.chainId;
    snapshot._cachedMockItem = this._cachedMockItem;

    return snapshot;
  }

  /** @internal See {@link writtenInPlace} — read by the memoized collection-navigation getter. */
  hasInPlaceWrites(): boolean {
    return this.writtenInPlace;
  }

  /**
   * Select distinct fields from collection items
   */
  selectDistinct<TSelection>(selector: (item: TItem) => TSelection): CollectionQueryBuilder<TSelection> {
    const newBuilder = this.select(selector);
    newBuilder.isDistinct = true;
    return newBuilder;
  }

  /**
   * Filter collection items
   * Multiple where() calls are chained with AND logic
   */
  where(condition: (item: TItem) => Condition): this {
    // In place by contract (statement-style accumulation, documented AND chaining) — but
    // flagged, so the memoized navigation getter never hands this instance out again
    // (see writtenInPlace).
    this.writtenInPlace = true;
    // Create mock item with proper schema if available
    const mockItem = this.createMockItem();
    const newCondition = condition(mockItem);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Create a mock item for the target table with proper typing
   */
  private createMockItem(): any {
    // Performance: Return cached mock if available
    if (this._cachedMockItem) {
      return this._cachedMockItem;
    }

    if (this.targetTableSchema) {
      // Prototype-level cache — same pattern as the root mock and
      // ReferenceQueryBuilder.createMockTargetRow (see MockRowCache): the getters are
      // fully determined by the target schema, so every collection item mock of the same
      // table shares one prebuilt prototype and a new item is `Object.create` plus its
      // FieldRef slot — O(1) instead of one property definition per column+relation per
      // `.where()`/`.select()`/`.orderBy()` call. Opt-in via the same static switch; OFF
      // = fresh prototype per item (the pre-0.4.70 behaviour).
      const prototype = MockRowCache.getOrBuild(
        `citem|${this.targetTable}`,
        () => Object.defineProperties({}, this.buildMockItemDescriptors()),
      );

      const mock: any = Object.create(prototype);
      mock[MOCK_ROW_FIELD_REFS] = {};
      mock[MOCK_ROW_CHAIN_ID] = this.chainId;

      // Cache the mock for reuse
      this._cachedMockItem = mock;
      return mock;
    } else {
      // Fallback: use the shared nested proxy that supports deep property access
      return createNestedFieldRefProxy(this.targetTable);
    }
  }

  /**
   * Builds the shared property-descriptor map for {@link createMockItem}'s cached path.
   * The getters read per-row state through `this`-bound symbol slots; values captured at
   * build time are signature-constants identical for every item mock of the table.
   */
  private buildMockItemDescriptors(): PropertyDescriptorMap {
    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.targetTableSchema!);

    // Add columns - include tableAlias for unambiguous column references in WHERE clauses
    // Use a special marker alias for the collection's own table that can be rewritten later
    // This allows distinguishing between outer table references and inner collection references
    // when both target the same table (e.g., post.user.posts where both are "posts" table)
    const tableAlias = `__collection_${this.targetTable}__`;

    const descriptors: PropertyDescriptorMap = {};
    for (const [colName, dbColumnName] of columnNameMap) {
      descriptors[colName] = {
        get(this: any) {
          const slots: MockRowSlots = this;
          const fieldRefCache = slots[MOCK_ROW_FIELD_REFS] ??= {};
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,  // Include table alias for unambiguous references
              __chainId: slots[MOCK_ROW_CHAIN_ID],  // This collection's identity — see chainId
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      };
    }

    // Values captured at descriptor-build time — identical for every item of this
    // signature (the registry is the process-wide schema registry).
    const targetTable = this.targetTable;
    const schemaRegistry = this.schemaRegistry;

    // Add navigation properties (both collections and references)
    if (this.targetTableSchema!.relations) {
      for (const [relName, relConfig] of Object.entries(this.targetTableSchema!.relations)) {
        if (relConfig.type === 'many') {
          // Collection navigation
          // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
          descriptors[relName] = {
            get: () => {
              // Don't call build() - it returns schema without relations
              const fk = relConfig.foreignKey || relConfig.foreignKeys?.[0] || '';
              return new CollectionQueryBuilder(
                relName,
                relConfig.targetTable,
                fk,
                targetTable,
                undefined,  // Don't pass schema, force registry lookup
                schemaRegistry,  // Pass schema registry for nested resolution
                // No navigation path needed here - direct collection access from parent
                undefined,
                relConfig.foreignKeys,  // Propagate composite FK / literal predicates
                relConfig.matches
              );
            },
            enumerable: false,
            configurable: true,
          };
        } else {
          // Reference navigation
          // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
          const holder: MockPrototypeHolder = {};
          descriptors[relName] = {
            get(this: any) {
              // Don't call build() - it returns schema without relations
              // Instead, pass undefined and let ReferenceQueryBuilder look it up from registry
              // One mock target row per ITEM row and relation: a selector that reads
              // `it.product.*` fifteen times used to mint fifteen builders and rows.
              const slots: MockRowSlots = this;
              const navCache = slots[MOCK_ROW_NAV_CACHE] ??= {};
              const cachedRow = navCache[relName];
              if (cachedRow !== undefined) {
                return cachedRow;
              }
              if (holder.prototype !== undefined && MockRowCache.isEnabled()) {
                return (navCache[relName] = mintReferenceMockRow(holder.prototype, slots[MOCK_ROW_CHAIN_ID]));
              }
              const refBuilder = new ReferenceQueryBuilder(
                relName,
                relConfig.targetTable,
                relConfig.foreignKeys || [relConfig.foreignKey || ''],
                relConfig.matches || [],
                relConfig.isMandatory ?? false,
                undefined,  // Don't pass schema, force registry lookup
                schemaRegistry,  // Pass schema registry for nested resolution
                [],  // Empty navigation path - this is the first reference in the chain
                targetTable  // Source alias is this collection's target table
              );
              return (navCache[relName] = refBuilder.createMockTargetRow(holder, slots[MOCK_ROW_CHAIN_ID]));
            },
            enumerable: false,
            configurable: true,
          };
        }
      }
    }

    return descriptors;
  }

  /**
   * Limit collection items
   */
  limit(count: number): this {
    this.writtenInPlace = true;
    this.limitValue = count;
    return this;
  }

  /**
   * Offset collection items
   */
  offset(count: number): this {
    this.writtenInPlace = true;
    this.offsetValue = count;
    return this;
  }

  /**
   * Order collection items
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (item: TItem) => T): this;
  orderBy<T>(selector: (item: TItem) => T[]): this;
  orderBy<T>(selector: (item: TItem) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (item: TItem) => T | T[] | Array<[T, OrderDirection]>): this {
    this.writtenInPlace = true;
    const mockItem = this.createMockItem();
    const result = selector(mockItem);
    forEachOrderByKey(result, (key, direction) => {
      this.orderByFields.push({ field: key.__dbColumnName || key.__fieldName, direction, table: getTableAlias(key), ref: key });
    }, (fragment, direction) => {
      // Used to be dropped from the ORDER BY silently
      this.orderByFields.push({ field: '', direction, fragment });
    });
    return this;
  }

  /** The refs of this collection's ORDER BY keys (the columns an expression key reads included). */
  private orderByRefs(): FieldRef[] {
    const refs: FieldRef[] = [];

    for (const entry of this.orderByFields) {
      if (entry.ref !== undefined) {
        refs.push(entry.ref);
      }

      if (entry.fragment !== undefined) {
        refs.push(...entry.fragment.getFieldRefs());
      }
    }

    return refs;
  }

  /**
   * One ORDER BY key as a qualified expression over the collection's FROM: an own column under the
   * collection marker (every strategy rewrites the marker to its alias for the target table), any
   * other column under the alias its ref renders under — a navigation of ours under its planned
   * alias (joined like a projected one), an enclosing row's column under that row's alias.
   */
  private orderByKeyExpression(entry: { field: string; table?: string; ref?: FieldRef }): string {
    const alias = ((entry.ref as any)?.__tableAlias as string | undefined) ?? entry.table;
    const marker = `__collection_${this.targetTable}__`;

    if (!alias || alias === this.targetTable || alias === marker) {
      return `"${marker}"."${entry.field}"`;
    }

    return `"${alias}"."${entry.field}"`;
  }

  /**
   * Get minimum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  min<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    const snapshot = this.captureSnapshot();
    if (selector && !snapshot.selector) {
      snapshot.selector = selector as any;
    }
    snapshot.aggregationType = 'MIN';
    return snapshot as unknown as SqlFragment<number | null>;
  }

  /**
   * Get maximum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  max<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    const snapshot = this.captureSnapshot();
    if (selector && !snapshot.selector) {
      snapshot.selector = selector as any;
    }
    snapshot.aggregationType = 'MAX';
    return snapshot as unknown as SqlFragment<number | null>;
  }

  /**
   * Get sum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  sum<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    const snapshot = this.captureSnapshot();
    if (selector && !snapshot.selector) {
      snapshot.selector = selector as any;
    }
    snapshot.aggregationType = 'SUM';
    return snapshot as unknown as SqlFragment<number | null>;
  }

  /**
   * Get count of items
   * Returns SqlFragment for automatic type resolution in selectors.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  count(): SqlFragment<number> {
    const snapshot = this.captureSnapshot();
    snapshot.aggregationType = 'COUNT';
    return snapshot as unknown as SqlFragment<number>;
  }

  /**
   * Check if any items exist in the collection
   * Returns SqlFragment<boolean> for automatic type resolution in selectors.
   *
   * A terminal READ: captures a snapshot, persists nothing on this builder. This is what
   * `exists(...)`/`notExists(...)` resolve a collection source through
   * (ExistsConditionBase), so a condition leg owns its predicate state from the moment it
   * is written — a later `.where()` on the same navigation node can no longer rewrite an
   * already-captured leg (see {@link captureSnapshot} for the two-leg gate this fixes).
   */
  exists(): SqlFragment<boolean> {
    const snapshot = this.captureSnapshot();
    snapshot.aggregationType = 'EXISTS';
    return snapshot as unknown as SqlFragment<boolean>;
  }

  /**
   * Flatten a nested collection through this collection.
   * Similar to LINQ's SelectMany - projects each item to a collection and flattens.
   *
   * Example: product.productPrices!.selectMany(pp => pp.capacityGroups!).exists()
   * SQL: SELECT EXISTS(SELECT 1 FROM capacity_groups JOIN product_prices ON ... WHERE ...)
   */
  selectMany<TInner>(selector: (item: TItem) => CollectionQueryBuilder<TInner>): CollectionQueryBuilder<TInner> {
    const mockItem = this.createMockItem();
    const innerCollection = selector(mockItem);
    const innerAny = innerCollection as any;

    // Build a navigation join from inner target table → this (intermediate) table
    // e.g., product_price_capacity_groups.product_price_id → product_prices.id — on the INNER
    // relation's own keys: its foreign key(s) on the inner table, the intermediate's principal key(s)
    const navJoin: NavigationJoin = {
      alias: this.targetTable,
      targetTable: this.targetTable,
      targetSchema: this.targetTableSchema?.schema,
      foreignKeys: innerAny.foreignKeys,   // FK on inner table pointing to intermediate
      matches: innerAny.matches,           // Principal key on intermediate table (`id` by default)
      isMandatory: true,                   // INNER JOIN for flattening
      sourceAlias: innerAny.targetTable,   // Source is the inner (target) table
    };

    // Create new builder targeting the inner table but with outer's FK for parent correlation — and
    // the outer relation's principal key: a relation keyed on another column than `id`
    // (`withPrincipalKey(c => c.code)`) used to correlate `fk = parent.id`
    const newBuilder = new CollectionQueryBuilder<TInner>(
      this.relationName,            // Keep outer relation name for CTE naming
      innerAny.targetTable,         // Target is the inner collection's table
      this.foreignKey,              // FK is the outer collection's FK (e.g., product_id)
      this.sourceTable,             // Source is the outer collection's source (e.g., products)
      innerAny.targetTableSchema,
      this.schemaRegistry,
      this.navigationPath,
      this.foreignKeys,
      this.matches
    );

    // The FK column lives on the intermediate table, not the target table
    newBuilder.selectManyJoins = [navJoin];
    newBuilder.foreignKeyTableAlias = this.targetTable;

    // Carry over where condition from outer collection if any. It was built on this
    // collection's item rows, so the flattened builder keeps this chain's identity.
    newBuilder.whereCond = this.whereCond;
    newBuilder.chainId = this.chainId;

    return newBuilder;
  }

  /**
   * Flatten result to number array (for single-column selections)
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  toNumberList(name?: string): CollectionResult<number> {
    const snapshot = this.captureSnapshot();
    if (name) {
      snapshot.asName = name;
    }
    snapshot.flattenResultType = 'number';
    snapshot.isMarkedAsList = true;
    return snapshot as any as CollectionResult<number>;
  }

  /**
   * Flatten result to string array (for single-column selections)
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  toStringList(name?: string): CollectionResult<string> {
    const snapshot = this.captureSnapshot();
    if (name) {
      snapshot.asName = name;
    }
    snapshot.flattenResultType = 'string';
    snapshot.isMarkedAsList = true;
    return snapshot as any as CollectionResult<string>;
  }

  /**
   * Specify the property name for the collection in the result
   * Marks this collection to be resolved as an array in the final result.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  toList(name?: string): CollectionResult<TItem> {
    const snapshot = this.captureSnapshot();
    if (name) {
      snapshot.asName = name;
    }
    snapshot.isMarkedAsList = true;
    // Cast to CollectionResult for type inference
    // At runtime, this is still a CollectionQueryBuilder, but TypeScript sees it as CollectionResult
    return snapshot as any as CollectionResult<TItem>;
  }

  /**
   * Get first item from collection or null if empty
   * Automatically applies LIMIT 1 and returns a single item instead of array.
   * A terminal READ: captures a snapshot, persists nothing on this builder
   * (see {@link captureSnapshot}).
   */
  firstOrDefault(name?: string): CollectionResult<TItem | null> {
    const snapshot = this.captureSnapshot();
    if (name) {
      snapshot.asName = name;
    }
    snapshot.limitValue = 1;
    snapshot.isMarkedAsList = false;  // Single item, not a list
    return snapshot as any as CollectionResult<TItem | null>;
  }

  /**
   * Get target table schema
   */
  getTargetTableSchema(): TableSchema | undefined {
    return this.targetTableSchema;
  }

  /**
   * Get target table name
   */
  getTargetTable(): string {
    return this.targetTable;
  }

  /**
   * Get selected field configs (for mapper lookup during transformation)
   */
  getSelectedFieldConfigs(): SelectedField[] | undefined {
    return this._selectedFieldConfigs;
  }

  /**
   * Get schema registry (for mapper lookup during transformation of navigation fields)
   */
  getSchemaRegistry(): Map<string, TableSchema> | undefined {
    return this.schemaRegistry;
  }

  /**
   * Get the navigation path leading to this collection.
   * Non-empty when this collection was reached through a reference chain
   * (e.g. `cdc.discountCode!.discount!.discountProducts`). The outer collection
   * builder needs these joins emitted in its own FROM so the nested aggregation's
   * correlation key (e.g. `discount.id`) resolves.
   */
  getNavigationPath(): NavigationJoin[] {
    return this.navigationPath;
  }

  /** The alias this collection correlates to (its parent row's table alias). */
  getSourceAlias(): string {
    return this.sourceTable;
  }

  /**
   * The parent's key column this collection's foreign key refers to — the relation's principal key
   * (`withPrincipalKey`), `id` by default. The CTE and temp-table strategies group the collection by
   * its foreign-key value, so their aggregate joins back on THIS column of the parent, not on `id`.
   */
  getParentKeyColumn(): string {
    for (let i = 0; i < this.foreignKeys.length; i++) {
      const match = this.matches[i];

      if (match !== undefined && !isLiteralKeyPart(this.foreignKeys[i]) && !isLiteralKeyPart(match)) {
        return match;
      }
    }

    return 'id';
  }

  /**
   * The SQL type of {@link getParentKeyColumn} in the parent's table: the last hop of the navigation
   * path the collection hangs off, else its source table. `undefined` when the schema is not known.
   */
  getParentKeyType(): string | undefined {
    const parentTable = this.navigationPath.length > 0 ? this.navigationPath[this.navigationPath.length - 1].targetTable : this.sourceTable;
    const parentSchema = this.schemaRegistry?.get(parentTable);

    if (parentSchema === undefined) {
      return undefined;
    }

    const column = getSchemaColumnMeta(parentSchema).get(this.getParentKeyColumn())
      ?? [...getSchemaColumnMeta(parentSchema).values()].find(meta => meta.name === this.getParentKeyColumn());

    return column?.type;
  }

  /**
   * Whether the SQL this collection renders under `strategy` reads the last hop of its navigation
   * path from the ENCLOSING scope, which then has to join the path: the CTE and temp-table strategies
   * correlate their aggregate to it, and so does the correlated-subquery form of LATERAL (a count,
   * min / max / sum, exists or flat list without LIMIT / OFFSET). A LATERAL join joins the path itself.
   */
  correlatesThroughEnclosingPath(strategy: CollectionStrategyType): boolean {
    if (this.navigationPath.length === 0) {
      return false;
    }

    if (strategy !== 'lateral') {
      return true;
    }

    const scalarOrFlat = this.aggregationType !== undefined || this.flattenResultType !== undefined;

    return scalarOrFlat && this.limitValue === undefined && this.offsetValue === undefined;
  }

  /** The relation this collection navigates. */
  getRelationName(): string {
    return this.relationName;
  }

  /**
   * Check if this collection uses array aggregation (for flattened results)
   */
  isArrayAggregation(): boolean {
    return this.flattenResultType !== undefined;
  }

  /**
   * Check if this is a scalar aggregation (count, sum, max, min)
   */
  isScalarAggregation(): boolean {
    return this.aggregationType !== undefined;
  }

  /**
   * Check if this is a single item result (firstOrDefault). A count / min / max / sum / exists or a
   * flat list over `.limit(1)` is not: it keeps its own shape and default (0, false, null, []) —
   * read as a single item, a parent without rows got `null` for its `.limit(1).count()`.
   */
  isSingleResult(): boolean {
    return !this.isMarkedAsList && this.limitValue === 1 && this.aggregationType === undefined && this.flattenResultType === undefined;
  }

  /**
   * Get the aggregation type
   */
  getAggregationType(): 'MIN' | 'MAX' | 'SUM' | 'COUNT' | 'EXISTS' | undefined {
    return this.aggregationType;
  }

  /**
   * Get the flatten result type (for determining PostgreSQL array type)
   */
  getFlattenResultType(): 'number' | 'string' | undefined {
    return this.flattenResultType;
  }

  /**
   * The field the items of a collection selecting ONE value are unwrapped from (`e => e.label`
   * yields its labels, not `{ label }` objects), once it was built; `undefined` otherwise.
   * @internal
   */
  getScalarSelectionAlias(): string | undefined {
    return this.scalarSelectionAlias;
  }

  /**
   * Get field references from this condition.
   *
   * Only the ones belonging to an ENCLOSING query — the root, or an enclosing collection — are
   * surfaced. Those are correlations, and the outer query has to have their tables in scope for
   * the subquery to reference them: a lambda saying `l.city!.name` needs the OUTER query to join
   * `city`, or the emitted `"city"."name"` has no FROM-clause entry to bind to. Reporting them
   * here is what lets the parent's join detection see the requirement.
   *
   * Our OWN refs stay hidden, as they always were — they are emitted inside this subquery and
   * must not drag joins into the parent. Required for duck-typing compatibility with the
   * Condition interface when used in WHERE clauses.
   */
  getFieldRefs(): FieldRef[] {
    if (!this.whereCond) {
      return [];
    }

    return this.whereCond.getFieldRefs().filter(ref => isForeignChainRef(ref, this.chainId));
  }

  /**
   * Every ref this collection reads from an ENCLOSING query: in its WHERE (see {@link getFieldRefs}),
   * its projection — columns, `sql` fragments, nested objects, subqueries — its ORDER BY, and the
   * ones its own nested collections read from beyond it. The enclosing scope has to have their
   * tables in scope (it joins the navigations they read through), and a collection reading its
   * parent row this way cannot be aggregated apart from that row: under the CTE and temp-table
   * strategies it renders as LATERAL (see buildCTEBody).
   */
  getOuterFieldRefs(): FieldRef[] {
    const refs: FieldRef[] = [];
    const add = (ref: any): void => {
      if (ref && typeof ref === 'object' && '__dbColumnName' in ref && isForeignChainRef(ref, this.chainId)) {
        refs.push(ref);
      }
    };

    if (this.whereCond) {
      for (const ref of this.whereCond.getFieldRefs()) {
        add(ref);
      }
    }

    for (const entry of this.orderByFields) {
      add(entry.ref);

      if (entry.fragment !== undefined) {
        for (const ref of entry.fragment.getFieldRefs()) {
          add(ref);
        }
      }
    }

    if (this.selector) {
      this.collectOuterRefs(this.evaluateSelector(), add, 0);
    }

    return refs;
  }

  /**
   * Runs `build` with the refs this collection reads from an ENCLOSING collection's row renamed from
   * that collection's marker (`"__collection_<table>__"`) to the alias the row renders under: an
   * enclosing lateral's inner alias (its entry in `aliasMap`), else the table's own name — the CTE and
   * temp-table aggregations select from the table unaliased. The marker names a TABLE, not a query,
   * so only the collection that owns it can resolve it, and a nested build never reached it: a list
   * nested in a collection kept the foreign marker (`missing FROM-clause entry for table
   * "__collection_…__"`), and a collection over the table its enclosing collection reads
   * (`m.loans` → `ln.member.loans.where(x => gt(x.id, ln.id))`) rewrote the enclosing row's refs to
   * its own alias with its own marker — `x.id > x.id`, false for every row.
   */
  private withEnclosingRowAliases<T>(aliasMap: Map<string, string> | undefined, build: () => T): T {
    const renamed: Array<[any, string]> = [];

    for (const ref of this.getOuterFieldRefs()) {
      const alias = (ref as any).__tableAlias;

      if (typeof alias === 'string' && alias.length > 15 && alias.startsWith('__collection_') && alias.endsWith('__')) {
        const table = alias.slice('__collection_'.length, -2);
        (ref as any).__tableAlias = aliasMap?.get(table) ?? table;
        renamed.push([ref, alias]);
      }
    }

    if (renamed.length === 0) {
      return build();
    }

    try {
      return build();
    } finally {
      for (const [ref, alias] of renamed) {
        ref.__tableAlias = alias;
      }
    }
  }

  /** Walks a selector result for {@link getOuterFieldRefs}. */
  private collectOuterRefs(value: any, add: (ref: any) => void, depth: number): void {
    if (value === null || typeof value !== 'object' || depth > 16) {
      return;
    }

    if ('__dbColumnName' in value) {
      add(value);
      return;
    }

    if (value instanceof SqlFragment) {
      for (const ref of value.getFieldRefs()) {
        add(ref);
      }
      return;
    }

    // A nested collection or a subquery: what it reads from beyond itself
    if (typeof value.getOuterFieldRefs === 'function') {
      for (const ref of value.getOuterFieldRefs()) {
        add(ref);
      }
      return;
    }

    if (Array.isArray(value) || value instanceof ReferenceQueryBuilder) {
      return;
    }

    // A navigation row projected whole: its first column's ref names its row
    if (isReferenceMockRow(value)) {
      const firstKey = findFirstGetterKey(value);

      if (firstKey !== undefined) {
        add(value[firstKey]);
      }
      return;
    }

    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        this.collectOuterRefs(value[key], add, depth + 1);
      }
    }
  }

  /**
   * The selector's result on this collection's item, evaluated once per builder: the enclosing
   * scope reads it for {@link getOuterFieldRefs}, and every build of this collection renders it.
   */
  private evaluateSelector(): any {
    if (!this.selector) {
      return undefined;
    }

    if (this.evaluatedSelection === undefined) {
      this.evaluatedSelection = { result: materializeMockSelection(this.selector(this.createMockItem())) };
    }

    return this.evaluatedSelection.result;
  }

  /**
   * Build SQL for this collection as a correlated subquery — the form it takes inside a condition
   * or a `sql` fragment.
   * EXISTS produces: EXISTS (SELECT 1 FROM "table" [JOINs] WHERE correlation AND conditions)
   * COUNT produces:  SELECT COUNT(*) FROM "table" [JOINs] WHERE correlation AND conditions
   *                  (a fragment wraps it in parentheses), e.g. sql`${u.posts.count()}::int`
   * Required for duck-typing compatibility with Condition interface when used in WHERE clauses.
   */
  buildSql(context: SqlBuildContext): string {
    if (this.aggregationType !== 'EXISTS' && this.aggregationType !== 'COUNT') {
      throw new Error('buildSql() on CollectionQueryBuilder is only supported for EXISTS and COUNT aggregations');
    }

    return this.withEnclosingRowAliases(context.lateralTableAliasMap, () =>
      this.withNavigationPlan(undefined, () => this.buildSqlBody(context)));
  }

  /** The body of {@link buildSql}, run under the navigation plan of this collection's WHERE. */
  private buildSqlBody(context: SqlBuildContext): string {
    const targetTable = this.targetTable;
    const foreignKey = this.foreignKey;
    const sourceTable = this.sourceTable;

    // Inside a lateral, the collection's λ-root table is visible only under the
    // lateral's generated alias (e.g. `FROM "cart_discount_code" "lateral_3_cartDiscountCodes"`).
    // The first bridge hop / root correlation must anchor on that alias, not the raw
    // table name — mirrors lateral-collection-strategy's own correlation handling.
    // Only the λ-root is translated: bridge-internal aliases are emitted by this very
    // subquery and must never be remapped, even if they collide with a lateral's
    // target table name.
    const aliasMap = (context as { lateralTableAliasMap?: Map<string, string> }).lateralTableAliasMap;
    const rootAnchor = (alias: string): string => aliasMap?.get(alias) || alias;

    // COUNT names its own table: a count reached through a navigation back to the SAME table
    // (`post.user.posts`) would otherwise shadow the outer row that navigation hangs off — the
    // bridge join and the correlation would both bind to the inner row, and every row would count
    // everything. EXISTS keeps its historical unaliased form unless that bare name is one the
    // subquery reads from the enclosing scope — the row it correlates to (a relation of a table to
    // itself), the row the first hop of its navigation path starts from (`ed.book.editions` from an
    // edition), or an enclosing row its WHERE reads — the same shadowing made those EXISTS true for
    // every row. A selectMany bridge addresses the raw table name, so it keeps it.
    const readsOuterNamed = (name: string): boolean =>
      rootAnchor(this.navigationPath.length === 0 ? sourceTable : this.navigationPath[0].sourceAlias) === name
      || this.getOuterFieldRefs().some(ref => (ref as any).__tableAlias === name);
    const ownAlias = this.selectManyJoins.length > 0
      ? targetTable
      : this.aggregationType === 'COUNT'
        ? `${this.relationName}__count`
        : readsOuterNamed(targetTable) ? `${this.relationName}__exists` : targetTable;
    const ownRef = (alias: string): string => (alias === targetTable ? ownAlias : alias);

    // Build JOINs needed inside the EXISTS subquery
    const allJoins: string[] = [];

    // Navigation path joins (for reference navigation like pc.order → orders)
    for (const [index, nav] of this.navigationPath.entries()) {
      const joinType = nav.isMandatory ? 'JOIN' : 'LEFT JOIN';
      const fk = nav.foreignKeys[0];
      const pk = (nav.matches && nav.matches.length > 0) ? nav.matches[0] : 'id';
      const src = index === 0 ? rootAnchor(nav.sourceAlias) : nav.sourceAlias;
      allJoins.push(`${joinType} ${quoteTableReference(nav.targetTable, nav.targetSchema)} "${nav.alias}" ON "${src}"."${fk}" = "${nav.alias}"."${pk}"`);
    }

    // SelectMany joins (for selectMany navigation through intermediate tables)
    for (const nav of this.selectManyJoins) {
      const joinType = nav.isMandatory ? 'JOIN' : 'LEFT JOIN';
      const fk = nav.foreignKeys[0];
      const pk = (nav.matches && nav.matches.length > 0) ? nav.matches[0] : 'id';
      allJoins.push(`${joinType} ${quoteTableReference(nav.targetTable, nav.targetSchema)} "${nav.alias}" ON "${nav.sourceAlias}"."${fk}" = "${nav.alias}"."${pk}"`);
    }

    // Joins required by REFERENCE navigations inside the collection's own
    // where-condition, e.g. `exists(links.where(l => eq(l.campaign.isPublic, true)))`.
    // Navigation joins were historically derived from selectors only; an EXISTS
    // aggregation has no selector, so a where-navigated alias rendered unjoined and
    // the statement failed with `missing FROM-clause entry for table "<alias>"`.
    // Reuses the selector path's machinery: seed aliases + chains from the
    // condition's FieldRefs, then resolve multi-hop paths against the target schema.
    for (const nav of this.resolveWhereNavigationJoins(sourceTable)) {
      const joinType = nav.isMandatory ? 'JOIN' : 'LEFT JOIN';
      const fk = nav.foreignKeys[0];
      const pk = (nav.matches && nav.matches.length > 0) ? nav.matches[0] : 'id';
      allJoins.push(`${joinType} ${quoteTableReference(nav.targetTable, nav.targetSchema)} "${nav.alias}" ON "${ownRef(nav.sourceAlias)}"."${fk}" = "${nav.alias}"."${pk}"`);
    }

    const navJoinsSQL = allJoins.join('\n');

    // Build WHERE clause: correlation + additional conditions
    // Use full composite-FK / literal-predicate form when navigation declared
    // multiple key pairs (e.g. SCD2 `[productId, isCurrent] / [id, true]`).
    const fkTableAlias = this.foreignKeyTableAlias || ownAlias;
    // Root-attached collections correlate on the λ-root itself, which a lateral
    // exposes only under its generated alias; nav-derived collections correlate on
    // the bridge's terminal alias, which this subquery emits itself — never remap it.
    const correlationSource = this.navigationPath.length === 0 ? rootAnchor(sourceTable) : sourceTable;
    let whereSQL: string;
    if (this.foreignKeys && this.foreignKeys.length > 0) {
      const matches = this.matches && this.matches.length > 0 ? this.matches : ['id'];
      whereSQL = buildCollectionCorrelationWhere(fkTableAlias, correlationSource, this.foreignKeys, matches);
    } else {
      whereSQL = `"${fkTableAlias}"."${foreignKey}" = "${correlationSource}"."id"`;
    }

    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params, placeholders, paramCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders, context.hoistedCteNames);
      context.paramCounter = paramCounter;
      context.params.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }

      // Rewrite collection marker aliases to actual table names
      const markerPattern = collectionMarkerPattern(targetTable, false);
      const rewrittenCondSql = condSql.replace(markerPattern, `"${ownAlias}"`);

      whereSQL += ` AND ${rewrittenCondSql}`;
    }

    const fromTable = quoteTableReference(targetTable, this.targetTableSchema?.schema);

    if (this.aggregationType === 'COUNT') {
      const countParts = [ownAlias === targetTable ? `SELECT COUNT(*) FROM ${fromTable}` : `SELECT COUNT(*) FROM ${fromTable} "${ownAlias}"`];
      if (navJoinsSQL) countParts.push(navJoinsSQL);
      countParts.push(`WHERE ${whereSQL}`);

      return countParts.join('\n');
    }

    const parts = [ownAlias === targetTable ? `EXISTS (SELECT 1 FROM ${fromTable}` : `EXISTS (SELECT 1 FROM ${fromTable} "${ownAlias}"`];
    if (navJoinsSQL) parts.push(navJoinsSQL);
    parts.push(`WHERE ${whereSQL})`);

    return parts.join('\n');
  }

  /**
   * Runs one build under the navigation plan of this collection's item: every reference-navigation
   * path its selector result and its WHERE traverse is joined on its own parent, and the refs of a
   * path that lost its plain alias to another path ending in the same relation name render under a
   * path alias until `build` returns. See NavigationAliasPlan.
   */
  private withNavigationPlan<T>(selectorResult: unknown, build: (plan: NavigationAliasPlan | undefined) => T): T {
    const anchorSchema = this.targetTableSchema ?? this.schemaRegistry?.get(this.targetTable);

    if (anchorSchema === undefined) {
      return build(undefined);
    }

    // Aliases that already mean something in our scope: the hops of the path this collection hangs
    // off (and of a selectMany bridge), which render in — or correlate from — the same scope, and
    // every alias an ENCLOSING row's ref we read renders under (`m.favoriteBook.category` next to
    // our `ln.edition.book.category`: one alias `category`, and the inner join would shadow the
    // outer row — the comparison became the inner row with itself). A navigation of ours by one of
    // those names gets a path alias. The parent's own alias is left to the correlation rules of
    // resolveRefNavigationJoins (the inverse of our own key IS the parent row).
    const reserved = new Set([...this.navigationPath, ...this.selectManyJoins].map(step => step.alias));
    for (const ref of this.getOuterFieldRefs()) {
      const alias = (ref as any).__tableAlias;

      if (typeof alias === 'string' && alias !== '' && alias !== this.sourceTable && !alias.startsWith('__collection_')) {
        reserved.add(alias);
      }
    }
    const plan = new NavigationAliasPlan(anchorSchema, this.targetTable, this.schemaRegistry, this.chainId, reserved.size > 0 ? reserved : undefined);
    const nestedPaths: string[][] = [];
    this.addSelectionToNavigationPlan(selectorResult, plan, nestedPaths);

    if (this.whereCond) {
      for (const ref of this.whereCond.getFieldRefs()) {
        plan.addRef(ref);
      }
    }

    // ORDER BY keys read through our navigations are joined (and aliased) like projected ones
    for (const ref of this.orderByRefs()) {
      plan.addRef(ref);
    }

    // After every ref: at equal depth, a path a field reads keeps the plain alias
    for (const path of nestedPaths) {
      plan.addPath(path);
    }

    const sealed = plan.seal();
    const previous = this.navigationPlan;
    this.navigationPlan = sealed;
    const restore = sealed?.apply();

    try {
      return build(sealed);
    } finally {
      restore?.();
      this.navigationPlan = previous;
    }
  }

  /**
   * Records the navigation paths a selector result traverses — the same values detectNavigationJoins
   * walks: field refs, the refs inside `sql` fragments and nested objects, and, for a collection
   * nested in the selector, the refs by which it correlates to our item. The path such a collection
   * hangs off (when it starts at our item) goes to `nestedPaths`.
   */
  private addSelectionToNavigationPlan(value: unknown, plan: NavigationAliasPlan, nestedPaths: string[][]): void {
    if (value === null || typeof value !== 'object') {
      return;
    }

    if ('__dbColumnName' in value) {
      plan.addRef(value);
      return;
    }

    if (value instanceof SqlFragment) {
      for (const ref of value.getFieldRefs()) {
        plan.addRef(ref);
      }
      return;
    }

    if (value instanceof CollectionQueryBuilder) {
      for (const ref of value.getOuterFieldRefs()) {
        plan.addRef(ref);
      }

      const nestedPath = value.getNavigationPath();

      if (nestedPath.length > 0 && nestedPath[0].sourceAlias === this.targetTable) {
        nestedPaths.push(nestedPath.map(step => step.alias));
      }
      return;
    }

    if (Array.isArray(value)) {
      return;
    }

    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        this.addSelectionToNavigationPlan((value as any)[key], plan, nestedPaths);
      }
    }
  }

  /**
   * The planned hops of the navigation path a nested collection hangs off, or `undefined` when the
   * plan does not cover that path (no plan, or a path that does not start at our item).
   */
  private plannedNestedPath(nestedPath: NavigationJoin[]): NavigationPathNode[] | undefined {
    const plan = this.navigationPlan;

    if (plan === undefined || nestedPath.length === 0 || nestedPath[0].sourceAlias !== this.targetTable) {
      return undefined;
    }

    let node = plan.nodeForPath(nestedPath.map(step => step.alias));

    if (node === undefined) {
      return undefined;
    }

    const nodes: NavigationPathNode[] = [];

    while (node !== undefined) {
      nodes.unshift(node);
      node = node.parent;
    }

    return nodes;
  }

  /**
   * Detect navigation property references in the selected fields and add necessary JOINs
   * This supports multi-level navigation like p.task.level.createdBy.username
   */
  private detectNavigationJoins(
    selection: any,
    joins: NavigationJoin[],
    currentSourceAlias: string,
    currentSchema: TableSchema,
    nestedCorrelationRefs?: FieldRef[]
  ): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    // Collect all table aliases referenced in the selection
    const allTableAliases = new Set<string>();
    // Aliases already joined — kept in step with `joins` so membership is O(1) instead of a
    // `joins.some(...)` scan per field ref (a wide projection asks this for every field)
    const joinedAliases = new Set<string>();
    for (const join of joins) {
      joinedAliases.add(join.alias);
    }

    // Helper to collect from a single selection
    const collectFromSelection = (sel: any): void => {
      if (!sel || typeof sel !== 'object') {
        return;
      }

      // Handle single FieldRef
      if ('__tableAlias' in sel && '__dbColumnName' in sel) {
        this.addNavigationJoinForFieldRef(sel, joins, currentSourceAlias, currentSchema, allTableAliases, joinedAliases);
        return;
      }

      // An `sql` expression on its own — an aggregate's argument (`max(l => sql\`…${l.book.name}…\`)`)
      // or a scalar selection: the navigations it reads are joined like a projected field's. Its
      // own properties were walked as if they were fields, and the navigation left unjoined
      if (sel instanceof SqlFragment) {
        for (const fieldRef of sel.getFieldRefs()) {
          this.addNavigationJoinForFieldRef(fieldRef, joins, currentSourceAlias, currentSchema, allTableAliases, joinedAliases);
        }
        return;
      }

      // Handle object with multiple fields
      // Own enumerable keys only (the set Object.entries walks), without allocating the pairs:
      // a wide collection projection runs this for every field on every build.
      for (const key in sel) {
        if (!Object.prototype.hasOwnProperty.call(sel, key)) {
          continue;
        }
        const value = sel[key];
        if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
          // This is a FieldRef with a table alias
          this.addNavigationJoinForFieldRef(value, joins, currentSourceAlias, currentSchema, allTableAliases, joinedAliases);
        } else if (value instanceof SqlFragment) {
          // SqlFragment may contain navigation property references
          const fieldRefs = value.getFieldRefs();
          for (const fieldRef of fieldRefs) {
            this.addNavigationJoinForFieldRef(fieldRef, joins, currentSourceAlias, currentSchema, allTableAliases, joinedAliases);
          }
        } else if (value instanceof CollectionQueryBuilder) {
          // A nested collection that was reached via a reference chain (e.g.
          // `cdc.discountCode!.discount!.discountProducts`) carries the chain as its
          // navigationPath. The nested aggregation will correlate on the last alias's
          // PK (e.g. `discount.id`), so the outer collection must emit those joins
          // in its own FROM for the correlation to resolve.
          const nestedPath = value.getNavigationPath();
          // Under a navigation plan each hop joins under its planned alias, on its own parent: a
          // hop named like another path's hop must not reuse that path's join
          const plannedPath = this.plannedNestedPath(nestedPath);
          for (let i = 0; i < nestedPath.length; i++) {
            const planned = plannedPath?.[i];
            const step = planned === undefined || (planned.alias === nestedPath[i].alias && this.navigationPlan!.parentAliasOf(planned) === nestedPath[i].sourceAlias)
              ? nestedPath[i]
              : { ...nestedPath[i], alias: planned.alias, sourceAlias: this.navigationPlan!.parentAliasOf(planned) };
            if (!joinedAliases.has(step.alias)) {
              joins.push(step);
              joinedAliases.add(step.alias);
            }
          }
          // Its WHERE, projection or ORDER BY may also correlate to OUR item through one of our
          // navigations (`line.reader.passes.where(p => eq(line.book.genre.lendable, true))`):
          // that subquery renders `"genre"."lendable"`, leaves the ref to us as foreign, and relies
          // on this FROM to bind it. getOuterFieldRefs() reports exactly its foreign refs; the
          // caller resolves the ones that are ours under the same rules as our own WHERE.
          nestedCorrelationRefs?.push(...value.getOuterFieldRefs());
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          // Recursively check nested objects
          collectFromSelection(value);
        }
      }
    };

    // First pass: collect all table aliases
    collectFromSelection(selection);

    // Second pass: resolve all navigation joins by finding the correct path through schemas
    if (allTableAliases.size > 0) {
      this.resolveNavigationJoins(allTableAliases, joins, currentSchema, joinedAliases);
    }
  }

  /**
   * Add a navigation JOIN for a FieldRef if it references a related table
   * Handles multi-level navigation by recursively resolving the join chain
   */
  /**
   * The joins required by REFERENCE navigations inside this collection's OWN where-condition,
   * e.g. `shelves.where(s => eq(s.city!.name, 'Rural'))`.
   *
   * Navigation joins used to be derived from SELECTORS only, which left a where-navigated
   * alias unjoined. Both collection render paths need this and neither can rely on the other:
   * an `exists()` aggregation has no selector at all, and a collection in a PROJECTION has one
   * that says nothing about the where-clause. Emitting it in one place is what keeps the two
   * paths answering the same question — the projection path previously bound such an alias to
   * whatever the OUTER query happened to have joined under that name (silently wrong under
   * `lateral`) or failed with `missing FROM-clause entry` when it had not.
   *
   * `correlationAlias` is the parent's alias in the collection's implicit correlation; a
   * navigation of ours named the same would shadow it, which cannot be rendered.
   */
  private resolveWhereNavigationJoins(correlationAlias: string): NavigationJoin[] {
    if (!this.whereCond) {
      return [];
    }

    return this.resolveRefNavigationJoins(this.whereCond.getFieldRefs(), correlationAlias);
  }

  /**
   * The joins THIS collection's FROM needs for `refs`: the reference navigations of ours they
   * traverse. Serves our own WHERE and the correlations by which collections nested in our
   * selector reach our item (see detectNavigationJoins) — those subqueries leave such refs to us
   * as foreign, so without this the alias renders unjoined. One resolver, so both obey the same
   * alias rules below.
   */
  private resolveRefNavigationJoins(refs: readonly FieldRef[], correlationAlias: string): NavigationJoin[] {
    if (refs.length === 0) {
      return [];
    }

    const targetSchema = this.schemaRegistry?.get(this.targetTable);

    if (!targetSchema) {
      return [];
    }

    const alreadyJoined = new Set<string>([
      ...this.navigationPath.map(nav => nav.alias),
      ...this.selectManyJoins.map(nav => nav.alias),
    ]);
    const whereJoins: NavigationJoin[] = [];
    const whereAliases = new Set<string>();

    for (const ref of refs) {
      const refAlias = (ref as any)?.__tableAlias as string | undefined;

      // Correlations to the enclosing row are filtered inside `addNavigationJoinForFieldRef` —
      // the choke point shared with the selector loops. Direct columns of the target arrive
      // under the `__collection_<table>__` marker or the bare table name; neither needs a join.
      if (!refAlias || refAlias === this.targetTable || refAlias.startsWith('__collection_') || alreadyJoined.has(refAlias)) {
        continue;
      }
      this.addNavigationJoinForFieldRef(ref, whereJoins, this.targetTable, targetSchema, whereAliases);
    }

    if (whereAliases.size > 0) {
      this.resolveNavigationJoins(whereAliases, whereJoins, targetSchema);
    }

    // A navigation of ours named like the collection's PARENT needs care: the collection's
    // correlation to that parent is implicit and always present, so both want one alias.
    //
    // Whether that is a problem depends on whether the navigation is the INVERSE of the
    // collection's own foreign key:
    //
    // - Same key pair (`userEshop.cards` correlating on `card.user_id = user_eshop.id`, and
    //   the card's own `userEshop` navigation joining on exactly that) — the navigation IS
    //   the parent row. The join would be the identity, so it is dropped and the alias keeps
    //   denoting the parent, which is what the reference meant. Rendering the join instead
    //   would shadow the correlation and detach every child from its parent.
    // - A DIFFERENT key pair — the navigation points at another row of the parent's table, so
    //   the alias would have to mean two things at once. That cannot be rendered; refuse it.
    const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
      const left = a ?? [];
      const right = b ?? [];

      return left.length === right.length && left.every((key, index) => key === right[index]);
    };
    const inverseOfCollectionKey = (nav: NavigationJoin): boolean =>
      sameKeys(nav.foreignKeys, this.foreignKeys) && sameKeys(nav.matches, this.matches);

    const clashing = whereJoins.filter(nav => nav.alias === correlationAlias);
    assertNoCorrelatedAliasShadowing(
      this.targetTable,
      [correlationAlias],
      new Set(clashing.filter(nav => !inverseOfCollectionKey(nav)).map(nav => nav.alias))
    );

    return whereJoins.filter(nav => !alreadyJoined.has(nav.alias) && nav.alias !== correlationAlias);
  }

  private addNavigationJoinForFieldRef(
    fieldRef: any,
    joins: NavigationJoin[],
    sourceAlias: string,
    sourceSchema: TableSchema,
    allTableAliases: Set<string>,
    joinedAliases?: Set<string>
  ): void {
    if (!fieldRef || typeof fieldRef !== 'object' || !('__tableAlias' in fieldRef)) {
      return;
    }

    // A ref stamped by ANOTHER chain was minted by an enclosing query — the root, or an
    // enclosing collection — not by this collection: it is a correlation to the outer row,
    // which the outer query already has in scope. Refs this builder mints carry OUR chain id
    // (marker-aliased columns AND navigation traversals alike), so this separates
    // `s.library.name` (ours: join it) from `l.name` (outer: leave it) even though both render
    // under the alias `library`. Joining the latter pulls a second copy of the outer table
    // into the subquery and binds the correlation to it, which silently compares the wrong row.
    // Collection rows used to carry NO id, which made a ref reached through an enclosing
    // COLLECTION's item look like ours — see chainId.
    //
    // Guarded HERE rather than at each caller because this method is the single choke point
    // through which the WHERE loop and all three selector loops resolve a ref into a join.
    // See isForeignChainRef.
    if (isForeignChainRef(fieldRef, this.chainId)) {
      return;
    }

    const tableAlias = fieldRef.__tableAlias as string;

    // If this references the target table directly, no join needed
    if (!tableAlias || tableAlias === this.targetTable) {
      return;
    }

    // A path of the build's navigation plan: its ancestors' aliases, then its own — the order the
    // branch below records `__navigationAliases` and `__tableAlias` in. Only a hop of the collection's
    // own table is joined right away; a deeper one waits for its parent (resolveNavigationJoins).
    const planned = this.navigationPlan?.nodeOf(fieldRef);
    if (planned !== undefined) {
      for (let i = 1; i < planned.collectOrder.length; i++) {
        allTableAliases.add(planned.collectOrder[i]);
      }
      allTableAliases.add(planned.alias);

      if (planned.parent === undefined && !(joinedAliases !== undefined ? joinedAliases.has(planned.alias) : joins.some(j => j.alias === planned.alias))) {
        this.addNavigationJoin(planned.alias, planned.relation, joins, sourceAlias, joinedAliases);
      }
      return;
    }

    // Seed the chain the projection ACTUALLY navigated, not just its terminal alias.
    // Without this, a projection that names only the deep leaf (e.g. `oi.productPrice.product.category.name`
    // with no sibling scalar off `productPrice` / `product`) leaves the intermediates out of
    // `allTableAliases` entirely, so resolveNavigationJoins' direct-relation phase has nothing to
    // anchor on and falls through to the name-based schema-graph BFS - which happily reaches
    // `category` one hop sooner through an unrelated same-table FK (`loan.featured_book_id`)
    // and silently returns another row's data.
    // This is the same `__navigationAliases` signal QueryBuilder.collectTableAliasesFromSelection,
    // GroupedQueryBuilder and DbContext already consume, and the same treatment nested
    // CollectionQueryBuilder values already get in detectNavigationJoins.
    if (Array.isArray(fieldRef.__navigationAliases)) {
      for (const navAlias of fieldRef.__navigationAliases) {
        if (navAlias && navAlias !== this.targetTable) {
          allTableAliases.add(navAlias);
        }
      }
    }

    // Collect this table alias for later resolution
    allTableAliases.add(tableAlias);

    // Check if we already have this join
    if (joinedAliases !== undefined ? joinedAliases.has(tableAlias) : joins.some(j => j.alias === tableAlias)) {
      return;
    }

    // Find the relation in the current schema
    const relation = sourceSchema.relations?.[tableAlias];
    if (relation && relation.type === 'one') {
      this.addNavigationJoin(tableAlias, relation, joins, sourceAlias, joinedAliases);
    }
  }

  /**
   * Add a navigation join and return the target schema
   */
  private addNavigationJoin(
    alias: string,
    relation: any,
    joins: NavigationJoin[],
    sourceAlias: string,
    joinedAliases?: Set<string>
  ): TableSchema | undefined {
    // Check if already added
    if (joinedAliases !== undefined ? joinedAliases.has(alias) : joins.some(j => j.alias === alias)) {
      return undefined;
    }
    joinedAliases?.add(alias);

    // Get the target table schema
    let targetSchema: TableSchema | undefined;
    let targetSchemaName: string | undefined;

    if (this.schemaRegistry) {
      targetSchema = this.schemaRegistry.get(relation.targetTable);
      targetSchemaName = targetSchema?.schema;
    }
    if (!targetSchema && relation.targetTableBuilder) {
      targetSchema = relation.targetTableBuilder.build();
      targetSchemaName = targetSchema?.schema;
    }

    // Build the join info
    const foreignKeys = relation.foreignKeys || [relation.foreignKey || ''];
    const matches = relation.matches || ['id'];  // Default to 'id' as the PK

    joins.push({
      alias,
      targetTable: relation.targetTable,
      targetSchema: targetSchemaName,
      foreignKeys,
      matches,
      isMandatory: relation.isMandatory ?? false,
      sourceAlias,
    });

    return targetSchema;
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph
   * This handles multi-level navigation like task.level.createdBy
   */
  private resolveNavigationJoins(
    allTableAliases: Set<string>,
    joins: NavigationJoin[],
    startSchema: TableSchema,
    joinedAliases?: Set<string>
  ): void {
    // Aliases already joined, kept in step with `joins` (O(1) membership; the caller may hand
    // in the set it maintained while collecting the field refs)
    if (joinedAliases === undefined) {
      joinedAliases = new Set<string>();
      for (const join of joins) {
        joinedAliases.add(join.alias);
      }
    }

    // Keep resolving until we've resolved all aliases or can't make progress
    // Fast path: every referenced alias is already joined (direct relations of the target table
    // were added while the field refs were collected) — the loop below would only mark them.
    let allJoined = true;
    for (const alias of allTableAliases) {
      if (!joinedAliases.has(alias)) {
        allJoined = false;
        break;
      }
    }
    if (allJoined) {
      return;
    }

    let resolved = new Set<string>();
    let lastResolvedCount = -1;
    let maxIterations = 100; // Prevent infinite loops

    while (resolved.size < allTableAliases.size && resolved.size !== lastResolvedCount && maxIterations-- > 0) {
      lastResolvedCount = resolved.size;

      // Build a map of already joined schemas for path resolution
      const joinedSchemas = new Map<string, TableSchema>();
      joinedSchemas.set(this.targetTable, startSchema);

      for (const join of joins) {
        let schema: TableSchema | undefined;
        if (this.schemaRegistry) {
          schema = this.schemaRegistry.get(join.targetTable);
        }
        if (schema) {
          joinedSchemas.set(join.alias, schema);
        }
      }

      // PHASE 1 - direct relation lookups, run to a FIXPOINT.
      // A join added here immediately becomes an anchor candidate for the remaining aliases in
      // this very pass, so a parent that is itself several hops away from the root (e.g.
      // loan -> edition -> book) can still anchor its own children. Without the
      // fixpoint those children never see their real parent (joinedSchemas was snapshotted before
      // the parent was joined) and fall through to the BFS below, which anchors them on whatever
      // other relation happens to point at the same table - e.g.
      // loan.featured_book_id -> book - silently returning another row's data.
      let progressed = true;

      // Termination (why no maxIterations guard is needed here, unlike every other loop in this
      // file): `progressed` is only ever set on a path that also adds a NEW alias to `resolved`
      // - every other path `continue`s - so `resolved` grows strictly monotonically and is
      // bounded above by `allTableAliases.size`. The loop therefore runs at most
      // `allTableAliases.size + 1` times.
      while (progressed) {
        progressed = false;

        for (const alias of allTableAliases) {
          if (resolved.has(alias)) {
            continue;
          }

          if (joinedAliases.has(alias)) {
            resolved.add(alias);
            continue;
          }

          // A path of the build's navigation plan hangs off its OWN parent, once that is joined —
          // never off whichever joined table happens to have a relation of the same name
          const planned = this.navigationPlan?.nodeForAlias(alias);
          if (planned !== undefined) {
            const parentAlias = this.navigationPlan!.parentAliasOf(planned);

            if (planned.parent === undefined || joinedSchemas.has(parentAlias)) {
              const targetSchema = this.addNavigationJoin(alias, planned.relation, joins, parentAlias, joinedAliases);
              if (targetSchema) {
                joinedSchemas.set(alias, targetSchema);
              }

              resolved.add(alias);
              progressed = true;
            }
            continue;
          }

          // Look for this alias in any of the already joined schemas (direct lookup)
          for (const [schemaAlias, schema] of joinedSchemas) {
            const relation = schema.relations?.[alias];
            if (!relation || relation.type !== 'one') {
              continue;
            }

            const targetSchema = this.addNavigationJoin(alias, relation, joins, schemaAlias, joinedAliases);
            if (targetSchema) {
              // Keep the anchor map current so the alias we just joined can serve as the
              // source for further direct lookups in the next fixpoint round
              joinedSchemas.set(alias, targetSchema);
            }

            resolved.add(alias);
            progressed = true;
            break;
          }
        }
      }

      // PHASE 2 - only aliases with no direct relation path at all fall back to the transitive
      // schema-graph BFS, which searches by relation NAME and therefore cannot tell which of
      // several relations pointing at the same table the projection actually meant
      for (const alias of allTableAliases) {
        // A planned path is anchored on its own parent or not at all — never by name
        if (resolved.has(alias) || !this.schemaRegistry || this.navigationPlan?.nodeForAlias(alias) !== undefined) {
          continue;
        }

        const path = this.findNavigationPath(alias, joinedSchemas, startSchema);
        if (path.length === 0) {
          continue;
        }

        // Add all intermediate joins
        for (const step of path) {
          if (!joinedAliases.has(step.alias)) {
            const stepSchema = this.addNavigationJoin(step.alias, step.relation, joins, step.sourceAlias, joinedAliases);
            if (stepSchema) {
              joinedSchemas.set(step.alias, stepSchema);
            }
          }
        }

        resolved.add(alias);
      }
    }
  }

  /**
   * Find a path from already-joined schemas to the target alias
   * Uses BFS to find the shortest path through the schema graph
   */
  private findNavigationPath(
    targetAlias: string,
    joinedSchemas: Map<string, TableSchema>,
    _startSchema: TableSchema
  ): Array<{ alias: string; relation: any; sourceAlias: string }> {
    if (!this.schemaRegistry) {
      return [];
    }

    // Memoised per registry — the BFS below depends only on the target alias and the ORDERED
    // joined alias→table pairs (order decides which of several equal-length paths wins), so
    // the same query shape resolves to the same path on every build. See NavigationPathCache.
    // Built by concatenation over the map (no spread / map / join allocations — this runs on every
    // build of every projection that reaches an alias through a second hop)
    let signature = targetAlias + '|';
    for (const [alias, schema] of joinedSchemas) {
      signature += alias + ':' + (schema.schema ?? '') + '.' + schema.name + ',';
    }

    return NavigationPathCache.getOrBuild(
      this.schemaRegistry,
      signature,
      () => this.computeNavigationPath(targetAlias, joinedSchemas),
    );
  }

  /** The uncached BFS behind {@link findNavigationPath}. */
  private computeNavigationPath(
    targetAlias: string,
    joinedSchemas: Map<string, TableSchema>
  ): Array<{ alias: string; relation: any; sourceAlias: string }> {
    if (!this.schemaRegistry) {
      return [];
    }

    // BFS to find path from any joined schema to the target alias
    const queue: Array<{
      schemaAlias: string;
      schema: TableSchema;
      path: Array<{ alias: string; relation: any; sourceAlias: string }>;
    }> = [];

    // Start from all currently joined schemas
    for (const [schemaAlias, schema] of joinedSchemas) {
      queue.push({ schemaAlias, schema, path: [] });
    }

    const visited = new Set<string>();
    for (const [alias] of joinedSchemas) {
      visited.add(alias);
    }

    while (queue.length > 0) {
      const { schemaAlias, schema, path } = queue.shift()!;

      if (!schema.relations) {
        continue;
      }

      for (const [relName, relConfig] of Object.entries(schema.relations)) {
        if (relConfig.type !== 'one') {
          continue; // Only follow reference (one-to-one/many-to-one) relations
        }

        if (visited.has(relName)) {
          continue;
        }

        const newPath = [...path, { alias: relName, relation: relConfig, sourceAlias: schemaAlias }];

        // Found the target!
        if (relName === targetAlias) {
          return newPath;
        }

        // Continue searching through this relation's schema
        visited.add(relName);
        const nextSchema = this.schemaRegistry.get(relConfig.targetTable);
        if (nextSchema) {
          queue.push({ schemaAlias: relName, schema: nextSchema, path: newPath });
        }
      }
    }

    return []; // No path found
  }

  /**
   * Build CTE for this collection query
   * Now delegates to collection strategy pattern
   * Returns full CollectionAggregationResult for strategies that need special handling (like LATERAL)
   */
  /**
   * @param joinOwnPath Set by the enclosing builder when it renders the last hop of the navigation
   *   path this collection hangs off under another alias than that hop's relation name (another path
   *   of the enclosing scope owns the name). The LATERAL correlated-subquery form then joins the path
   *   inside its own subquery, as the LATERAL-join form always does, instead of binding to the
   *   enclosing scope's join of that name — which would be the other path's row.
   */
  buildCTE(context: QueryContext, client?: DatabaseClient, parentIds?: any[], joinOwnPath?: boolean): { sql: string; params: any[]; isCTE?: boolean; joinClause?: string; selectExpression?: string; tableName?: string; memoId?: number } {
    // The user's selector is evaluated once per builder (see evaluateSelector). Downstream steps
    // (field collection, aggregate-expression discovery, navigation-join detection) all
    // need to walk the same selection, and re-invoking the selector is expensive
    // (rebuilds proxy mocks and any nested CollectionQueryBuilder instances).
    const selectorResult = this.evaluateSelector();

    return this.withEnclosingRowAliases(context.lateralTableAliasMap, () =>
      this.withNavigationPlan(selectorResult, () => this.buildCTEBody(context, client, parentIds, selectorResult, joinOwnPath === true)));
  }

  /**
   * Whether the enclosing scope of a collection renders the last hop of the navigation path the
   * collection hangs off under another alias than its relation name (see buildCTE's `joinOwnPath`).
   * `plan` is the enclosing build's navigation plan and `anchorAlias` the alias its paths start from.
   */
  static pathRenamedIn(collection: CollectionQueryBuilder<any>, plan: NavigationAliasPlan | undefined, anchorAlias: string): boolean {
    const path = collection.navigationPath;

    if (plan === undefined || path.length === 0 || path[0].sourceAlias !== anchorAlias) {
      return false;
    }

    const node = plan.nodeForPath(path.map(step => step.alias));

    return node !== undefined && node.alias !== path[path.length - 1].alias;
  }

  /** The body of {@link buildCTE}, run under the navigation plan of the collection's item. */
  private buildCTEBody(
    context: QueryContext,
    client: DatabaseClient | undefined,
    parentIds: any[] | undefined,
    selectorResult: any,
    joinOwnPath: boolean
  ): { sql: string; params: any[]; isCTE?: boolean; joinClause?: string; selectExpression?: string; tableName?: string; memoId?: number } {
    // Determine strategy type - default to 'lateral' if not specified. A temp-table collection needs
    // its parents' ids fetched first (executeWithTempTables); rendered inside one statement —
    // countOver(), prepare(), a UNION leg, a future — it takes the CTE form, which is the very
    // aggregation the temp-table strategy runs, over every parent (the temp-table strategy's
    // promise used to land in the SQL as a join to a CTE nobody declared). A collection that reads
    // its enclosing row beyond the relation key (see getOuterFieldRefs) cannot be aggregated apart
    // from that row, which is what the CTE and temp-table strategies do: it renders as LATERAL.
    const configuredStrategy: CollectionStrategyType = context.collectionStrategy || 'lateral';
    const requestedStrategy: CollectionStrategyType = configuredStrategy === 'temptable' && parentIds === undefined ? 'cte' : configuredStrategy;
    const strategyType: CollectionStrategyType = requestedStrategy !== 'lateral' && this.getOuterFieldRefs().length > 0
      ? 'lateral'
      : requestedStrategy;
    const strategy = CollectionStrategyFactory.getStrategy(strategyType);

    // For LATERAL strategy, reserve the counter early and register the table alias
    // This allows nested collections to reference this collection's aliased table
    let reservedCounter: number | undefined;
    let previousTableAlias: string | undefined;  // For restoring after build
    let hadPreviousEntry = false;
    if (strategyType === 'lateral') {
      reservedCounter = context.cteCounter++;
      const lateralAlias = `lateral_${reservedCounter}`;
      const innerTableAlias = `${lateralAlias}_${this.relationName}`;

      // Initialize the map if needed
      if (!context.lateralTableAliasMap) {
        context.lateralTableAliasMap = new Map();
      }
      // Save previous value (if any) so we can restore it after building
      // This prevents sibling collections from seeing each other's aliases
      hadPreviousEntry = context.lateralTableAliasMap.has(this.targetTable);
      previousTableAlias = context.lateralTableAliasMap.get(this.targetTable);
      // Register this collection's table alias for nested collections to reference
      context.lateralTableAliasMap.set(this.targetTable, innerTableAlias);
    }

    // Build selected fields configuration (supports nested objects)
    const selectedFieldConfigs: SelectedField[] = [];
    const localParams: any[] = [];

    // A literal of the item's projection. Typed from its JS type when the items are read as columns
    // (a CTE body) or aggregated into a native array (toNumberList / toStringList): untyped, the
    // array of a literal `7` aggregated as text[], and the JSON of a CTE body's items held '7'
    const typedLiterals = context.typedLiterals === true || this.flattenResultType !== undefined;
    const literalExpression = (value: unknown): string => {
      const start = context.allParams.length;
      const literalContext = { paramCounter: context.paramCounter, allParams: context.allParams, typedLiterals };
      const expression = projectionLiteralSql(value, literalContext);
      context.paramCounter = literalContext.paramCounter;
      localParams.push(...context.allParams.slice(start));

      return expression;
    };

    // Helper function to check if a value is a plain object (not FieldRef, SqlFragment, etc.)
    const isPlainObject = (val: any): boolean => {
      return typeof val === 'object' &&
        val !== null &&
        !('__dbColumnName' in val) &&
        !(val instanceof SqlFragment) &&
        !Array.isArray(val) &&
        val.constructor === Object;
    };

    // Helper function to recursively process fields and build SelectedField structures
    const collectionMarkerAlias = `__collection_${this.targetTable}__`;
    const processField = (alias: string, field: any): SelectedField => {
      if (field instanceof SqlFragment) {
        // SQL Fragment - build the SQL expression
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
          placeholders: context.placeholders,  // Pass placeholders for prepared statements
          // Thread the lateral alias scope into fragments: an EXISTS collection
          // rendered inside this lateral must anchor its λ-root on the lateral's
          // generated alias (see CollectionQueryBuilder.buildSql rootAnchor).
          lateralTableAliasMap: context.lateralTableAliasMap,
        };
        const fragmentSql = field.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        // Its `mapWith` reads the item's value back, as it does in a root projection
        return { alias, expression: fragmentSql, mapper: fragmentReadMapper(field) };
      } else if (field instanceof CollectionQueryBuilder) {
        // Nested collection query builder, built as a subquery of this one. Inside a temp-table
        // aggregation — a statement of its own, with no WITH list of its enclosing query — it
        // renders as LATERAL, which needs nothing outside the aggregation's own FROM.
        // Inside a LATERAL collection it is LATERAL too: its aggregate joins back on this
        // collection's table, which is visible there only under the lateral's alias.
        const nestedCtx: QueryContext = {
          ...context,
          cteCounter: context.cteCounter,
          collectionStrategy: strategyType === 'cte' ? 'cte' : 'lateral',
        };
        const nestedResult = field.buildCTE(nestedCtx, client, undefined, CollectionQueryBuilder.pathRenamedIn(field, this.navigationPlan, this.targetTable));
        // Sync both counters back - cteCounter for CTE naming, paramCounter for parameter numbering
        context.cteCounter = nestedCtx.cteCounter;
        context.paramCounter = nestedCtx.paramCounter;

        // For CTE/LATERAL strategy, we need to track the nested join
        // The nested aggregation needs to be joined in the outer collection's subquery
        // However, correlated subqueries (used for toNumberList, etc.) don't need joins -
        // they are embedded directly in the SELECT expression
        if (nestedResult.tableName && (nestedResult.isCTE || nestedResult.joinClause)) {
          let nestedJoinClause: string;

          if (nestedResult.isCTE) {
            // CTE strategy: join by parent_id. When the nested collection was reached
            // through a reference chain (e.g. `cdc.discountCode!.discount!.discountProducts`),
            // the CTE aggregates on the chain's terminal PK (here `discount.id`), not on
            // the outer collection's own PK — and the outer's target table may not even
            // have an `id` column (junction tables like `cart_discount_codes`). The
            // intermediate joins are emitted into the outer's FROM via detectNavigationJoins
            // picking up the nested path.
            // The CTE groups by the nested collection's foreign key, i.e. by its PARENT's principal
            // key column (`withPrincipalKey`, `id` by default)
            const nestedPath = field.getNavigationPath();
            const parentKey = field.getParentKeyColumn();
            if (nestedPath.length > 0) {
              const lastStep = nestedPath[nestedPath.length - 1];
              // The alias detectNavigationJoins joined the path's last hop under
              const plannedPath = this.plannedNestedPath(nestedPath);
              const lastAlias = plannedPath !== undefined ? plannedPath[plannedPath.length - 1].alias : lastStep.alias;
              nestedJoinClause = `LEFT JOIN "${nestedResult.tableName}" ON "${lastAlias}"."${parentKey}" = "${nestedResult.tableName}".parent_id`;
            } else {
              nestedJoinClause = `LEFT JOIN "${nestedResult.tableName}" ON "${this.targetTable}"."${parentKey}" = "${nestedResult.tableName}".parent_id`;
            }
          } else {
            // LATERAL strategy: use the provided join clause (contains full LATERAL subquery)
            nestedJoinClause = nestedResult.joinClause!;
          }

          const joined: SelectedField = {
            alias,
            expression: nestedResult.selectExpression || nestedResult.sql,
            nestedCteJoin: {
              cteName: nestedResult.tableName,
              joinClause: nestedJoinClause,
              memoId: nestedResult.memoId,
            },
          };

          // A scalar aggregate (count / min / max / sum / exists) is a plain value: the collection
          // mapping of `nestedCollectionInfo` turned a CTE count into `{}` and a string min / max
          // into an object of its characters
          if (!field.isScalarAggregation()) {
            // Store nested collection info for recursive mapper transformation
            joined.nestedCollectionInfo = {
              targetTable: field.getTargetTable(),
              selectedFieldConfigs: field.getSelectedFieldConfigs(),
              isSingleResult: field.isSingleResult(),
              flattenResultType: field.getFlattenResultType(),
              scalarAlias: field.getScalarSelectionAlias(),
            };
          }

          return joined;
        }

        // The nested collection becomes a correlated subquery in SELECT
        // For scalar aggregations (count, min, max, sum), don't include nestedCollectionInfo
        // because the result is a scalar value, not a structured object that needs transformation
        const aggregationType = field.getAggregationType();
        const isScalarAggregation = aggregationType && ['COUNT', 'MIN', 'MAX', 'SUM', 'EXISTS'].includes(aggregationType);

        if (isScalarAggregation) {
          // Scalar aggregation - just return the expression, no nested transformation needed
          return {
            alias,
            expression: nestedResult.selectExpression || nestedResult.sql,
          };
        }

        return {
          alias,
          expression: nestedResult.selectExpression || nestedResult.sql,
          // Store nested collection info for recursive mapper transformation
          nestedCollectionInfo: {
            targetTable: field.getTargetTable(),
            selectedFieldConfigs: field.getSelectedFieldConfigs(),
            isSingleResult: field.isSingleResult(),
            flattenResultType: field.getFlattenResultType(),
            scalarAlias: field.getScalarSelectionAlias(),
          },
        };
      } else if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
        // FieldRef object - use database column name with optional table alias
        const dbColumnName = (field as any).__dbColumnName;
        const tableAlias = (field as any).__tableAlias;
        const fieldName = (field as any).__fieldName;  // Property name for mapper lookup
        const sourceTable = (field as any).__sourceTable;  // Actual table name for schema lookup
        // If tableAlias differs from the target table (or its collection marker), it's a navigation property reference
        // The collection marker is `__collection_tableName__` and should be treated as the target table
        if (tableAlias && tableAlias !== this.targetTable && tableAlias !== collectionMarkerAlias) {
          return { alias, expression: `"${tableAlias}"."${dbColumnName}"`, propertyName: fieldName, sourceTable };
        }
        return { alias, expression: `"${dbColumnName}"`, propertyName: fieldName, isColumn: true };
      } else if (typeof field === 'string') {
        // A string is a value, as its type says — a parameter, read back as itself (`literal`). It
        // used to render as a column of that NAME of the item's table
        return { alias, expression: literalExpression(field), literal: { value: field } };
      } else if (isPlainObject(field)) {
        // Nested object - recursively process its fields
        const nestedFields: SelectedField[] = [];
        for (const nestedAlias in field) {
          if (Object.prototype.hasOwnProperty.call(field, nestedAlias)) {
            nestedFields.push(processField(nestedAlias, field[nestedAlias]));
          }
        }
        return { alias, nested: nestedFields };
      } else {
        // Literal value or expression: a parameter, which the item reads back as the value itself
        // (the database hands a parameter of unknown type back as text — `42` came back "42",
        // `true` as "true"). A list of columns has no one SQL value
        assertProjectionArrayOfValues(field, alias, `${this.relationName}.select()`);

        return { alias, expression: literalExpression(field), literal: { value: field } };
      }
    };

    // Step 1: Build field selection configuration
    if (this.selector) {
      const selectedFields = selectorResult;

      // A list / single item of ONE value (`e => e.label`, `e => sql\`upper(${e.label})\``) reads as
      // that value: its items are unwrapped from the one field they are built with (see isScalarSelection)
      const readsScalar = this.aggregationType === undefined && this.flattenResultType === undefined;
      this.scalarSelectionAlias = undefined;

      // Check if the selector returns a FieldRef directly (single field selection like p => p.title)
      if (typeof selectedFields === 'object' && selectedFields !== null && '__dbColumnName' in selectedFields) {
        // Single field selection - the column name is the alias; a column read through a
        // navigation (`ln => ln.edition.book.name`) renders qualified by that navigation's alias
        const config = processField(selectedFields.__dbColumnName, selectedFields);
        selectedFieldConfigs.push(config);
        if (readsScalar) {
          this.scalarSelectionAlias = config.alias;
        }
      } else if ((selectedFields instanceof SqlFragment || isScalarLiteralSelection(selectedFields)) && this.aggregationType === undefined) {
        // An expression of the item — or ONE literal (`() => 'x'`) — projected as a field of its
        // own (a list of it, a flattened list of it); it used to project no field at all — items
        // came back as `{}` — and a string was walked as an object of its characters
        selectedFieldConfigs.push(processField(SCALAR_SELECTION_ALIAS, selectedFields));
        if (readsScalar) {
          this.scalarSelectionAlias = SCALAR_SELECTION_ALIAS;
        }
      } else if (selectedFields instanceof CollectionQueryBuilder || selectedFields instanceof SqlFragment) {
        // Selector returns a scalar subquery (e.g. .sum(row => other.count())) or a raw fragment.
        // No per-column fields to collect — the aggregate argument lives on aggregateExpression.
      } else {
        // Object selection - extract each field (with support for nested objects)
        // Own enumerable keys, without allocating the entry pairs (this runs per field per build)
        for (const alias in selectedFields) {
          if (Object.prototype.hasOwnProperty.call(selectedFields, alias)) {
            selectedFieldConfigs.push(processField(alias, selectedFields[alias]));
          }
        }
      }
    } else {
      // No selector - select all fields from the target table schema
      if (this.targetTableSchema && this.targetTableSchema.columns) {
        // Performance: Use cached column name map
        const colNameMap = getColumnNameMapForSchema(this.targetTableSchema);
        for (const [colName, dbColumnName] of colNameMap) {
          selectedFieldConfigs.push({
            alias: colName,
            expression: `"${dbColumnName}"`,
            propertyName: colName,  // Same as alias when selecting all fields
            isColumn: true,
          });
        }
      } else {
        // Fallback: use * (less ideal, may cause issues)
        selectedFieldConfigs.push({
          alias: '*',
          expression: '*',
        });
      }
    }

    // Cache selected field configs for mapper lookup during transformation
    this._selectedFieldConfigs = selectedFieldConfigs;

    // Step 2: Build WHERE clause SQL (without WHERE keyword). Under LATERAL our table renders under
    // the lateral's alias: an exists() / count() over a collection of our item correlates to it
    let whereClause: string | undefined;
    let whereParams: any[] | undefined;
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(
        this.whereCond,
        context.paramCounter,
        context.placeholders,
        context.hoistedCteNames,
        strategyType === 'lateral' ? context.lateralTableAliasMap : undefined
      );
      whereClause = sql;
      whereParams = params;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      localParams.push(...params);
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Step 3: ORDER BY keys as qualified expressions over the collection's FROM (see
    // orderByKeyExpression). They used to render as bare column NAMES: under LATERAL a name the
    // inner table lacks bound to the ENCLOSING row (the list came back unordered) and a name the
    // projection reuses as an alias bound to that alias; the CTE / temp-table aggregates ordered
    // by names their subquery output does not carry. Each strategy now orders by the expression
    // itself, or by a column of its inner SELECT carrying it.
    let orderByClause: string | undefined;
    let orderByFields: CollectionAggregationConfig['orderByFields'];
    if (this.orderByFields.length > 0) {
      orderByFields = this.orderByFields.map(({ field, direction, table, fragment }, index) => ({
        field,
        direction,
        table,
        // An expression key renders in our parameter sequence, its own columns under our marker
        expression: fragment !== undefined
          ? buildOrderByExpressionSql(fragment, context, strategyType === 'lateral' ? context.lateralTableAliasMap : undefined, localParams)
          : this.orderByKeyExpression(this.orderByFields[index]),
      }));
      orderByClause = orderByFields.map(({ expression, direction }) => `${expression} ${direction}`).join(', ');
    }

    // Step 4: Determine aggregation type and field
    let aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum' | 'exists';
    let aggregateField: string | undefined;
    let aggregateExpression: string | undefined;
    let arrayField: string | undefined;
    let defaultValue: string;

    if (this.aggregationType) {
      // Scalar aggregations: count, min, max, sum, exists
      aggregationType = this.aggregationType.toLowerCase() as 'count' | 'min' | 'max' | 'sum' | 'exists';

      // For aggregations other than COUNT and EXISTS, determine which field to aggregate
      if (this.aggregationType !== 'COUNT' && this.aggregationType !== 'EXISTS' && this.selector) {
        const selectedField = selectorResult;
        if (typeof selectedField === 'object' && selectedField !== null && '__dbColumnName' in selectedField) {
          const tableAlias = (selectedField as any).__tableAlias;

          if (tableAlias && tableAlias !== this.targetTable && tableAlias !== collectionMarkerAlias && !isForeignChainRef(selectedField, this.chainId)) {
            // A column read through a navigation (`max(ed => ed.category.name)`): aggregated
            // qualified by the navigation's alias — joined with the selector's navigations
            aggregateExpression = `"${tableAlias}"."${(selectedField as any).__dbColumnName}"`;
          } else {
            aggregateField = (selectedField as any).__dbColumnName;
          }
        } else if (selectedField instanceof CollectionQueryBuilder) {
          // Selector returns a nested collection (e.g., sum(row => other.where(...).count())).
          // We need a *scalar* SQL expression to feed into the aggregate — so force the nested
          // build to emit a correlated subquery (lateral's scalar form) rather than a CTE/temp
          // table that can't be composed inside SUM(...). Outer strategies (CTE, temp table,
          // lateral) then wrap this expression with the aggregate function via
          // config.aggregateExpression.
          const nestedCtx: QueryContext = { ...context, collectionStrategy: 'lateral' };
          const nestedResult = selectedField.buildCTE(nestedCtx, client, undefined, CollectionQueryBuilder.pathRenamedIn(selectedField, this.navigationPlan, this.targetTable));
          context.cteCounter = nestedCtx.cteCounter;
          context.paramCounter = nestedCtx.paramCounter;
          aggregateExpression = nestedResult.selectExpression || nestedResult.sql;
        } else if (selectedField instanceof SqlFragment) {
          // An expression of the item (`max(p => sql\`length(${p.title})\`)`): aggregated as it
          // renders in the item's projection, its columns under our marker (each strategy rewrites
          // it to the alias the item's table renders under). It used to throw "MAX requires an
          // aggregate field".
          const sqlBuildContext: SqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
            placeholders: context.placeholders,
            lateralTableAliasMap: context.lateralTableAliasMap,
          };
          aggregateExpression = selectedField.buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
        }
      }

      // Set default value based on aggregation type
      if (aggregationType === 'count') {
        defaultValue = '0';
      } else if (aggregationType === 'exists') {
        defaultValue = 'false';
      } else {
        defaultValue = 'null';
      }
    } else if (this.flattenResultType) {
      // Array aggregation for toNumberList/toStringList
      aggregationType = 'array';

      // Determine the field to aggregate from the selected fields
      if (selectedFieldConfigs.length > 0) {
        const firstField = selectedFieldConfigs[0];
        arrayField = firstField.alias;
      }

      // Use typed empty array literal (PostgreSQL will infer type from array_agg).
      // Drivers that cannot decode native arrays aggregate via json_agg instead,
      // so the default must be a JSON empty array for those.
      defaultValue = context.useJsonArrayAggregation ? "'[]'::json" : "'{}'";
    } else {
      // JSON aggregation (default) - use JSON instead of JSONB for better performance
      aggregationType = 'jsonb';
      defaultValue = "'[]'::json";
    }

    // Step 5: Detect navigation joins from the selected fields
    const navigationJoins: NavigationJoin[] = [];
    // Refs by which collections nested in the selector correlate to OUR item — resolved below
    // under the same rules as our own WHERE (see detectNavigationJoins).
    const nestedCorrelationRefs: FieldRef[] = [];
    if (this.selector && this.targetTableSchema && selectorResult !== undefined) {
      // A CollectionQueryBuilder summand already had its navigation joins built via the
      // recursive buildCTE above; detectNavigationJoins would iterate its own properties
      // as if they were fields and produce nothing useful. Skip the walk in that case.
      if (!(selectorResult instanceof CollectionQueryBuilder)) {
        this.detectNavigationJoins(selectorResult, navigationJoins, this.targetTable, this.targetTableSchema, nestedCorrelationRefs);
      }
    }

    // The selector says nothing about the collection's own WHERE, so a navigation used only
    // there would render unjoined — and then bind to whatever the OUTER query has under that
    // alias instead of failing. Same resolution the inline EXISTS path uses. A nested
    // collection correlating through one of our navigations is in the same position: its
    // subquery leaves that ref to us, so the navigation must be joined HERE.
    const refNavigationJoins = [
      ...this.resolveWhereNavigationJoins(this.sourceTable),
      ...this.resolveRefNavigationJoins(nestedCorrelationRefs, this.sourceTable),
      // An ORDER BY key read through one of our navigations
      ...this.resolveRefNavigationJoins(this.orderByRefs(), this.sourceTable),
    ];
    for (const nav of refNavigationJoins) {
      if (!navigationJoins.some(existing => existing.alias === nav.alias)) {
        navigationJoins.push(nav);
      }
    }

    // Step 5b: Merge navigation path joins (for intermediate tables in navigation chains)
    // These joins are needed when accessing a collection through a chain like:
    // ln.edition.book.category.formats
    // The navigation path contains joins for productPrice, product, category
    // which must be included in the lateral subquery for correlation
    // Include selectMany joins in both all and selector navigation joins
    // selectMany joins are structural (from flattening) and needed by both CTE and LATERAL
    // (the common case — no navigation path, no selectMany — reuses the detected array instead of
    // spreading it twice; strategies only read these lists)
    const allNavigationJoins: NavigationJoin[] = this.navigationPath.length === 0 && this.selectManyJoins.length === 0
      ? navigationJoins
      : [...this.navigationPath, ...this.selectManyJoins, ...navigationJoins];
    // The correlated form joins the path this collection hangs off as well when the enclosing scope
    // renders the path's last hop under another alias (see buildCTE's `joinOwnPath`)
    const allSelectorJoins: NavigationJoin[] = joinOwnPath && strategyType === 'lateral' && this.navigationPath.length > 0
      ? allNavigationJoins
      : this.selectManyJoins.length === 0
        ? navigationJoins
        : [...this.selectManyJoins, ...navigationJoins];

    // Step 6: Build CollectionAggregationConfig object
    const config: CollectionAggregationConfig = {
      relationName: this.relationName,
      targetTable: this.targetTable,
      targetSchema: this.targetTableSchema?.schema,
      foreignKey: this.foreignKey,
      // Composite FK metadata: enables strategies to emit constant FK predicates
      // (e.g. SCD2 `is_current = TRUE` from `withForeignKey: [col, isCurrent] /
      // withPrincipalKey: [id, true]`) in the projection WHERE clause.
      foreignKeys: this.foreignKeys,
      matches: this.matches,
      foreignKeyTableAlias: this.foreignKeyTableAlias,
      sourceTable: this.sourceTable,
      parentIds,  // Pass parent IDs for temp table strategy
      parentKeyType: strategyType === 'temptable' ? this.getParentKeyType() : undefined,
      selectedFields: selectedFieldConfigs,
      whereClause,
      whereParams,  // Pass WHERE clause parameters
      orderByClause,
      orderByFields,
      limitValue: this.limitValue,
      offsetValue: this.offsetValue,
      isDistinct: this.isDistinct,
      isSingleResult: this.isSingleResult(),  // For firstOrDefault() - returns single object instead of array
      aggregationType,
      aggregateField,
      aggregateExpression,
      arrayField,
      defaultValue,
      useJsonArrayAggregation: context.useJsonArrayAggregation,
      // Use the reserved counter for LATERAL strategy, otherwise increment as before
      counter: reservedCounter !== undefined ? reservedCounter : context.cteCounter++,
      navigationJoins: allNavigationJoins.length > 0 ? allNavigationJoins : undefined,
      selectorNavigationJoins: allSelectorJoins.length > 0 ? allSelectorJoins : undefined,
      navigationPath: this.navigationPath.length > 0 ? this.navigationPath : undefined,
    };

    // Step 6: Restore the lateralTableAliasMap to prevent sibling collections from seeing this alias
    // This is important because sibling collections at the same level should not affect each other.
    // Restored BEFORE the strategy renders this collection: our own entry exists for what we nest
    // (built above), while the names our correlation and the first hop of our navigation path read
    // are the ENCLOSING scope's — a relation of a table to itself (`c.children`, `ed.book.editions`)
    // used to correlate to its own inner row through that entry.
    if (strategyType === 'lateral' && context.lateralTableAliasMap) {
      if (hadPreviousEntry) {
        // Restore the previous value
        context.lateralTableAliasMap.set(this.targetTable, previousTableAlias!);
      } else {
        // Remove the entry we added
        context.lateralTableAliasMap.delete(this.targetTable);
      }
    }

    // Step 7: Call the strategy
    const result = strategy.buildAggregation(config, context, client!);

    // Step 8: Return the result
    // For synchronous strategies (like JSONB), result is returned directly
    // For async strategies (like temp table), return the Promise
    // Callers need to handle both cases
    if (result instanceof Promise) {
      // Async strategy - return special marker with the promise
      return result as any;
    }

    // Synchronous strategy (JSONB/CTE/LATERAL)
    return {
      sql: result.sql,
      params: localParams,
      isCTE: result.isCTE,
      joinClause: result.joinClause,
      selectExpression: result.selectExpression,
      tableName: result.tableName,
      memoId: result.memoId,
    };
  }
}
