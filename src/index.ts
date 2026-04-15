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
  IdentityOptions,
} from './schema/column-builder';

// Enum types
export {
  pgEnum,
  EnumTypeDefinition,
  EnumTypeRegistry,
  EnumValues,
} from './types/enum-builder';

// Query builders
export {
  QueryBuilder,
  SelectQueryBuilder,
  CollectionQueryBuilder,
} from './query/query-builder';

// Union query builder
export {
  UnionQueryBuilder,
  UnionType,
  isUnionQueryBuilder,
} from './query/union-builder';

// Future queries for batch execution
export {
  FutureQuery,
  FutureSingleQuery,
  FutureCountQuery,
  FutureQueryRunner,
  AnyFutureQuery,
  FutureQueryResult,
  FutureQueryResults,
  isFutureQuery,
  isFutureSingleQuery,
  isFutureCountQuery,
} from './query/future-query';

// Prepared statements
export {
  PreparedQuery,
} from './query/prepared-query';

export {
  GroupedQueryBuilder,
  GroupedSelectQueryBuilder,
  GroupedJoinedQueryBuilder,
  GroupedItem,
} from './query/grouped-query';

export {
  JoinQueryBuilder,
  JoinType,
  JoinDefinition,
} from './query/join-builder';

// Conditions
export {
  Condition,
  ConditionOperator,
  ConditionBuilder,
  SqlFragment,
  RawSql,
  FieldRef,
  Placeholder,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
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
  jsonbSelect,
  jsonbSelectText,
  jsonbArraySome,
  jsonbConditionUnwrap,
  JsonbElement,
  flagHas,
  flagHasAll,
  flagHasAny,
  flagHasNone,
} from './query/conditions';

// Subquery support
export {
  Subquery,
  SubqueryFieldRef,
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
  SubqueryResult,
  SubqueryMode,
} from './query/subquery';

// CTE (Common Table Expression) support
export {
  DbCte,
  DbCteBuilder,
  InferCteColumns,
  isCte,
} from './query/cte-builder';

// Internal DataContext (for library use only - users should use DbContext)
export {
  QueryOptions,
  LogLevel,
  LoggingOptions,
  CollectionStrategyType,
  TimeTracer,
  TimeTraceEntry,
  QueryTimeTrace,
} from './entity/db-context';

// Collection strategy pattern
export {
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
  EntityConstructor,
  EntityMetadataStore,
  IndexMethod,
} from './entity/entity-base';

export {
  DbColumn,
  UnwrapDbColumns,
  isDbColumn,
  InsertData,
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
  EntityQuery,
  EntityInsertBuilder,
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
  ColumnType,
  TypeScriptType,
  TypeAliases,
  TypeAlias,
} from './types/column-types';

// Custom types
export {
  CustomType,
  CustomTypeBuilder,
  customType,
  json as jsonType,
  array,
  enumType,
  point,
  Point,
  vector,
  interval,
  Interval,
} from './types/custom-types';

// Type mappers
export {
  TypeMapper,
  CustomTypeDefinition,
  customType as createCustomType,
  identityMapper,
  applyToDriver,
  applyFromDriver,
  applyFromDriverArray,
} from './types/type-mapper';

// Sequences
export {
  DbSequence,
  SequenceConfig,
  SequenceBuilder,
  sequence,
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
  PooledConnection,
  QueryResult as ClientQueryResult,
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
