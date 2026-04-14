# Linkgress ORM - Project Guide

## Project Structure

```
src/
  database/          # Database client implementations (PgClient, PostgresClient, BunClient)
  entity/            # Entity system: DbContext, entity builders, model config
  query/             # Query builder system (core of the ORM)
    strategies/      # Collection aggregation strategies (CTE, Lateral, TempTable)
  schema/            # Table schema builders, navigation metadata
  migrations/        # Migration runner, journal, loader, scaffold
tests/               # Jest test suite
  queries/           # Query-specific integration tests
  utils/             # Test helpers (test-database.ts, shared fixtures)
debug/schema/        # Test entity definitions (AppDatabase, model classes)
docs/                # Documentation
  guides/            # User guides
changelog/           # Versioned changelog files (v0.3.0.md, v0.4.0.md, etc.)
```

## Conventions

- **Changelogs**: Written to `changelog/` folder as versioned files (e.g., `v0.4.4.md`), never a single CHANGELOG.md
- **Tests**: Integration tests against a real PostgreSQL database. Use `withDatabase()` and `seedTestData()` from `tests/utils/test-database.ts`
- **Test isolation**: Use unique timestamps/table names per test to avoid require cache conflicts. Use `createFreshClient()` for isolated schema tests, `getSharedDatabase()` for shared performance

## Database Clients

- `PgClient` - Uses the `pg` npm package
- `PostgresClient` - Uses the `postgres` npm package
- `BunClient` - For Bun runtime
- Use `db.query()` for SQL execution (works with all clients)
- `querySimple()` only exists on PostgresClient/BunClient, not PgClient

## Query Builder Architecture

### Core Files
- `src/query/query-builder.ts` — `QueryBuilder`, `SelectQueryBuilder`, `ReferenceQueryBuilder`, `CollectionQueryBuilder`
- `src/query/grouped-query.ts` — `GroupedQueryBuilder`, `GroupedSelectQueryBuilder` (for `.groupBy()` chains)
- `src/query/conditions.ts` — `Condition`, `SqlFragment`, `FieldRef`, WHERE clause building
- `src/query/subquery.ts` — `Subquery`, `ExistsCondition`, `NotExistsCondition`
- `src/query/join-utils.ts` — Shared `formatJoinValue()` helper for JOIN conditions
- `src/query/cte-builder.ts` — CTE (Common Table Expression) support

### Schema Registry
`schemaRegistry` is a `Map<string, TableSchema>` keyed by **table name** (not entity class name). It is central to resolving navigation property chains. It lives in `DataContext` and is threaded through:

`DataContext` → `TableAccessor` → `QueryBuilder` → `SelectQueryBuilder` → `GroupedQueryBuilder` → `GroupedSelectQueryBuilder`

Every builder that creates mock rows for navigation must receive and propagate `schemaRegistry`.

### Mock Row Pattern (`createMockRow()`)
Each query builder class has a `createMockRow()` method that builds proxy objects with lazy `FieldRef` getters. These proxies are invoked by user-provided selector functions to capture field references and navigation paths at query-build time.

A `FieldRef` object looks like:
```typescript
{
  __fieldName: 'email',
  __dbColumnName: 'email',
  __tableAlias: 'createdBy',       // leaf navigation alias (used in SQL)
  __sourceTable: 'users',           // actual table name (for mapper lookup)
  __navigationAliases: ['task', 'level'],  // intermediate aliases for JOIN resolution
  __mapper: ...,                     // optional column type mapper
}
```

### Navigation Resolution
`ReferenceQueryBuilder.createMockTargetRow()` creates nested mock objects for navigation properties (e.g., `ot.task!.level!.createdBy!.email`). Each level creates a new `ReferenceQueryBuilder` with:
- `schemaRegistry` for resolving the next level's schema
- `navigationPath` tracking the chain of joins
- `sourceAlias` identifying where the FK lives

### JOIN Detection (Two-Phase Pattern)
Used by `SelectQueryBuilder` and `GroupedSelectQueryBuilder`:

1. **`collectTableAliasesFromSelection()`** — Walks the selection object, collecting `__tableAlias` from FieldRefs AND `__navigationAliases` for intermediate tables that have no directly selected fields
2. **`resolveJoinsForTableAliases()`** — Iteratively resolves joins through the schema graph. Each iteration builds a map of already-joined schemas, then looks for unresolved aliases in those schemas' relations. Handles arbitrary navigation depth (e.g., 3-level: task → level → createdBy)

### Collection Strategies
Three strategies for aggregating nested collections, all in `src/query/strategies/`:

| Strategy | File | How it works |
|----------|------|-------------|
| CTE | `cte-collection-strategy.ts` | Independent CTE subqueries joined to main query via `parent_id` |
| Lateral | `lateral-collection-strategy.ts` | `LEFT JOIN LATERAL` correlated subqueries |
| TempTable | `temptable-collection-strategy.ts` | Temp table with parent IDs, then JOIN |

Key config fields in `CollectionAggregationConfig`:
- `aggregationType`: `'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum' | 'exists'`
- `foreignKeyTableAlias`: Used by `selectMany()` when the FK is on an intermediate table, not the target
- `selectorNavigationJoins`: JOINs within the collection's selector (not the outer navigation path)

## Custom Type Mappers

### How They Work
Custom mappers provide bidirectional conversion between application types and database types via `createCustomType<{ data: TData; driverData: TDriver }>()` from `src/types/custom-types.ts`. Each mapper has:
- `toDriver(value)` — converts app type → DB type (used in WHERE, INSERT, UPDATE)
- `fromDriver(value)` — converts DB type → app type (used when reading results)

### Attaching Mappers
```typescript
entity.property(e => e.publishTime)
  .hasType(smallint('publish_time'))
  .hasCustomMapper(pgHourMinute);  // EntityPropertyBuilder.hasCustomMapper() → ColumnBuilder.mapWith()
```

### Storage & Caching
- Mapper stored on `ColumnConfig` via `ColumnBuilder.mapWith()`
- Pre-cached in `TableSchema.columnMetadataCache` (`Map<string, { hasMapper, mapper? }>`)
- Also attached directly on FieldRefs as `__mapper` (set by `ReferenceQueryBuilder.createMockTargetRow()`)

### Result Mapping Pipeline (`transformResults()` in query-builder.ts)
1. **Pre-analysis phase**: Categorizes each field into `FieldType` enum (FIELD_REF_MAPPER, FIELD_REF_NO_MAPPER, SQL_FRAGMENT_MAPPER, SIMPLE, etc.)
2. **Per-row phase**: Applies `mapper.fromDriver()` based on pre-computed field type

Mapper lookup order for FieldRefs:
1. Base table's `schemaColumnCache` (fast path for direct fields)
2. `__mapper` on the FieldRef itself (fallback for navigation property fields from other tables)

### Key Locations
- `createCustomType()`: `src/types/custom-types.ts`
- `hasCustomMapper()`: `src/entity/entity-builder.ts`
- `transformResults()` mapper application: `src/query/query-builder.ts` (FieldType.FIELD_REF_MAPPER case)
- `transformCollectionItems()`: Handles mappers for fields inside collections
- Test custom types: `debug/types/hour-minute.ts` (HourMinute↔smallint), `debug/types/int-datetime.ts` (Date↔integer)

## Entity System

### Entity Definitions
- Test entities: `debug/schema/appDatabase.ts` (imported by `tests/utils/test-database.ts`)
- Production pattern: Subclass `DataContext`, configure entities in `DbModelConfig`
- Navigation: `entity.hasOne(e => e.nav, () => TargetClass).withForeignKey(...).withPrincipalKey(...)`
- Composite keys: `.withForeignKey(e => [e.col1, e.col2])` — array syntax for multi-column FKs
- Constant keys: `.withPrincipalKey(e => [e.id, true])` — literal values in join conditions
- SQL fragment keys: `.withForeignKey(e => sql\`\${e.levelId}\`)` — raw SQL expressions

### Navigation Metadata
Stored in `TableSchema.relations`:
```typescript
{
  type: 'one' | 'many',
  targetTable: string,          // table name
  foreignKey?: string,          // single FK column
  foreignKeys?: string[],       // composite FK columns
  matches?: string[],           // target PK columns
  isMandatory?: boolean,        // INNER vs LEFT JOIN
  targetTableBuilder?: any,     // for lazy schema resolution
}
```

## Migration System

- `MigrationRunner` — Executes migrations
- `MigrationJournal` — Tracks applied migrations in `__migrations` table (configurable)
- `MigrationLoader` — Loads migration files from disk
- `MigrationScaffold` — Generates migration file templates
- Files: Any `.ts` file accepted, `YYYYMMDD-HHMMSS.ts` recommended naming
- Sorted lexicographically for execution order
- Each migration runs in a transaction for atomicity
