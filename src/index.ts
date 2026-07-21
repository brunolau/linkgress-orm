// Internal schema builders (exported for DbContext use only)
export {
  integer,
  serial,
  bigint,
  bigserial,
  smallint,
  decimal,
  numeric,
  real,
  doublePrecision,
  varchar,
  char,
  text,
  boolean,
  timestamp,
  timestamptz,
  date,
  time,
  uuid,
  json,
  jsonb,
  bytea,
  enumColumn,
  ColumnBuilder,
} from './schema/column-builder';

export type {
  IdentityOptions,
} from './schema/column-builder';

// Enum types
export {
  pgEnum,
  EnumTypeRegistry,
} from './types/enum-builder';

export type {
  EnumTypeDefinition,
  EnumValues,
} from './types/enum-builder';

// Collation types
export {
  pgCollation,
  CollationRegistry,
} from './types/collation-builder';

export type {
  CollationDefinition,
} from './types/collation-builder';

// Query builders
export {
  QueryBuilder,
  SelectQueryBuilder,
  CollectionQueryBuilder,
} from './query/query-builder';

// Union query builder
export {
  UnionQueryBuilder,
  isUnionQueryBuilder,
} from './query/union-builder';

export type {
  UnionType,
} from './query/union-builder';

// Future queries for batch execution
export {
  FutureQuery,
  FutureSingleQuery,
  FutureCountQuery,
  FutureQueryRunner,
  isFutureQuery,
  isFutureSingleQuery,
  isFutureCountQuery,
} from './query/future-query';

export type {
  AnyFutureQuery,
  FutureQueryResult,
  FutureQueryResults,
} from './query/future-query';

// Prepared statements
export {
  PreparedQuery,
} from './query/prepared-query';

export {
  GroupedQueryBuilder,
  GroupedSelectQueryBuilder,
  GroupedJoinedQueryBuilder,
} from './query/grouped-query';

export type {
  GroupedItem,
} from './query/grouped-query';

export {
  JoinQueryBuilder,
} from './query/join-builder';

export type {
  JoinType,
  JoinDefinition,
} from './query/join-builder';

// Conditions
export {
  ConditionBuilder,
  SqlFragment,
  RawSql,
  Placeholder,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  startsWith,
  searchNormalize,
  containsSearch,
  startsWithSearch,
  endsWithSearch,
  normalizedEq,
  normalizedLike,
  normalizedStartsWith,
  regexMatches,
  regexMatchesCaseInsensitive,
  regexNoMatch,
  regexNoMatchCaseInsensitive,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  between,
  and,
  or,
  not,
  sql,
  coalesce,
  jsonbMerge,
  jsonbSelect,
  jsonbSelectText,
  jsonbArraySome,
  jsonbConditionUnwrap,
  flagHas,
  flagHasAll,
  flagHasAny,
  flagHasNone,
} from './query/conditions';

export type {
  Condition,
  ConditionOperator,
  FieldRef,
  JsonbElement,
} from './query/conditions';

// Subquery support
export {
  Subquery,
  isSubquery,
  exists,
  notExists,
  inSubquery,
  notInSubquery,
  eqSubquery,
  neSubquery,
  gtSubquery,
  gteSubquery,
  ltSubquery,
  lteSubquery,
} from './query/subquery';

export type {
  SubqueryFieldRef,
  SubqueryResult,
  SubqueryMode,
  CollectionSubquerySource,
} from './query/subquery';

// CTE (Common Table Expression) support
export {
  DbCte,
  DbCteBuilder,
  isCte,
} from './query/cte-builder';

export type {
  CteTableRef,
  InferCteColumns,
} from './query/cte-builder';

// CTE-rooted query support (FROM a CTE, with FULL OUTER / RIGHT / CROSS joins)
export {
  CteRootQueryBuilder,
  CteJoinedQueryBuilder,
  onTrue,
} from './query/cte-root-query';

export type {
  CteJoinType,
} from './query/cte-root-query';

// Internal DataContext (for library use only - users should use DbContext)
export {
  defaultLogger,
  TimeTracer,
} from './entity/db-context';

export type {
  QueryOptions,
  LogLevel,
  LogSection,
  SlowQueryInfo,
  TransactionOptions,
  LoggingOptions,
  CollectionStrategyType,
  TimeTraceEntry,
  QueryTimeTrace,
} from './entity/db-context';

// Collection strategy pattern
export type {
  ICollectionStrategy,
  CollectionStrategyType as CollectionStrategy,
  CollectionAggregationConfig,
  CollectionAggregationResult,
} from './query/collection-strategy.interface';

export {
  CollectionStrategyFactory,
} from './query/collection-strategy.factory';


// New Entity-first API with full typing
export {
  DbEntity,
  EntityMetadataStore,
  ixLower,
  ixUnaccent,
  ixNormalized,
} from './entity/entity-base';

export type {
  EntityConstructor,
  IndexMethod,
} from './entity/entity-base';

// Declarative table partitioning
export type {
  PartitionStrategy,
  PartitioningConfig,
} from './schema/table-builder';

export {
  DbColumn,
  isDbColumn,
} from './entity/db-column';

export type {
  UnwrapDbColumns,
  InsertData,
  UpdateData,
  UpsertData,
  ExtractDbColumns,
  ExtractDbColumnKeys,
} from './entity/db-column';






export {
  EntityConfigBuilder,
  EntityPropertyBuilder,
  EntityNavigationBuilder,
  HasManyNavigationBuilder,
  HasOneNavigationBuilder,
} from './entity/entity-builder';

export {
  DbModelConfig,
} from './entity/model-config';

// Main API - DbContext (Entity-first approach)
export {
  DatabaseContext as DbContext,
  DbEntityTable,
  EntityInsertBuilder,
} from './entity/db-context';

export type {
  EntityQuery,
  EntityUpsertConfig,
  EntityCollectionQuery,
  IEntityQueryable,
  EntitySelectQueryBuilder,
  OrderDirection,
  OrderByTuple,
  OrderByResult,
  ColumnInfo,
} from './entity/db-context';

// Types
export {
  TypeAliases,
} from './types/column-types';

export type {
  ColumnType,
  TypeScriptType,
  TypeAlias,
} from './types/column-types';

// Custom types
export {
  CustomTypeBuilder,
  customType,
  json as jsonType,
  array,
  enumType,
  point,
  vector,
  interval,
} from './types/custom-types';

export type {
  CustomType,
  Point,
  Interval,
} from './types/custom-types';

// Type mappers
export {
  customType as createCustomType,
  identityMapper,
  applyToDriver,
  applyFromDriver,
  applyFromDriverArray,
} from './types/type-mapper';

export type {
  TypeMapper,
  CustomTypeDefinition,
} from './types/type-mapper';

// Sequences
export {
  DbSequence,
  SequenceBuilder,
  sequence,
} from './schema/sequence-builder';

export type {
  SequenceConfig,
} from './schema/sequence-builder';

// Migration tools
export {
  DbSchemaManager,
} from './migration/db-schema-manager';

export {
  EnumMigrator,
} from './migration/enum-migrator';

// Manual migrations
export type {
  Migration,
  MigrationConfig,
  MigrationJournalEntry,
  LoadedMigration,
  MigrationRunResult,
  MigrationDirection,
} from './migration/migration.interface';

export {
  MigrationRunner,
} from './migration/migration-runner';

export {
  MigrationJournal,
} from './migration/migration-journal';

export {
  MigrationLoader,
} from './migration/migration-loader';

export {
  MigrationScaffold,
} from './migration/migration-scaffold';

export type {
  MigrationOperation,
} from './migration/db-schema-manager';

// Database clients
export {
  DatabaseClient,
  QueryTimeoutError,
} from './database/database-client.interface';

export type {
  PooledConnection,
  QueryResult as ClientQueryResult,
} from './database/database-client.interface';

export type {
  QueryExecutionOptions,
} from './database/database-client.interface';

export {
  PostgresClient,
} from './database/postgres-client';

export {
  PgClient,
} from './database/pg-client';

export {
  BunClient,
} from './database/bun-client';

export type {
  PoolConfig,
  PostgresOptions,
  BunSqlOptions,
} from './database/types';
