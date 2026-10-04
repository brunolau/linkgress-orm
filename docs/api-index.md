# API Index

> **For agents:** Which linkgress-orm call does a task need, on which object does it exist, and which guide section documents it?
> **Use this page when:** you need the exact spelling and an abridged signature of an export or a builder method, want to check that a method exists on the object you hold before you write the call, or look for the guide section of a call. **Look elsewhere when:** you must pick an approach for a data need (rows, totals, related rows, several reads, bulk writes) → [Choosing the Right Query](./choosing-the-right-query.md)
> **Key APIs:** every export of `linkgress-orm` (`src/index.ts`) and the methods of what they return: `DbContext`, `DbEntityTable`, `IEntityQueryable`, `EntitySelectQueryBuilder`, `EntityCollectionQuery`, the grouped, CTE-rooted, set and union builders, `AliasedScope`, `QueryBatch`, `MutationBatch`, `PreparedQuery`, `FutureQueryRunner`, `DbCteBuilder`, `DbSchemaManager`, `MigrationRunner`, the clients, `LinkgressConfig`, the in-memory database

## Contents

- [How to read this index](#how-to-read-this-index)
- [Which object has which method](#which-object-has-which-method)
- [Context and tables](#context-and-tables)
- [Reading: terminal methods](#reading-terminal-methods)
- [Projection and filtering](#projection-and-filtering)
- [Conditions (operators)](#conditions-operators)
- [Expression helpers](#expression-helpers)
- [Aggregates and windows](#aggregates-and-windows)
- [Collections and navigations](#collections-and-navigations)
- [Joins](#joins)
- [Subqueries and scopes](#subqueries-and-scopes)
- [CTEs and set-returning sources](#ctes-and-set-returning-sources)
- [Batching and prepared queries](#batching-and-prepared-queries)
- [Writing](#writing)
- [Transactions and locks](#transactions-and-locks)
- [Schema model](#schema-model)
- [Migrations](#migrations)
- [Clients and connections](#clients-and-connections)
- [Configuration and diagnostics](#configuration-and-diagnostics)
- [Errors](#errors)
- [Types](#types)
- [Internal: do not call](#internal-do-not-call)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## How to read this index

Each entry is one line: the call with an abridged signature, what it is for, the guide section that documents
it, and `(since 1.0.N)` when a changelog of 1.0.20 or later added it (unmarked entries are older). Every name is
spelled as `src/` declares it and imported from `'linkgress-orm'`.

Notation: `db` is an instance of your `DbContext` subclass (the docs use the example model `AppDatabase`:
[Example Model and Seed Data](./example-model.md)); `tx`
is the context `db.transaction()` hands its callback; `db.<table>` is a table getter (a `DbEntityTable<T>`); `q`
is a query builder; `T` is the entity row, `S` the projected row. Other receivers are named after what they hold:
`select` (an `EntitySelectQueryBuilder`), `grouped` / `groupedSelect`, `union`, `cteRoot`, `setQuery`,
`collection` (a `hasMany` navigation in a selector), `scope` (an `AliasedScope`), `fragment` (an `SqlFragment`),
`subquery`, `cte` (a `DbCte`), `builder` (a `DbCteBuilder`), `batch` (a `QueryBatch`), `mb` (a `MutationBatch`),
`future`, `prepared`, `model` (`DbModelConfig`), `e` (`EntityConfigBuilder`), `index` (`IndexBuilder`), `seq`
(`DbSequence`), `schemaManager`, `runner`, `client`, `conn`, `memory`. A builder step (`where()`, `select()`,
`orderBy()`) sends nothing; a terminal (`toList()`, `count()`) sends the statements; a write builder sends its
statement when it is awaited.

```ts
import { PgClient, eq } from 'linkgress-orm';
import { AppDatabase } from './app-database';   // your DbContext subclass

const db = new AppDatabase(new PgClient({ connectionString: process.env.DATABASE_URL }));

const names = await db.users           // DbEntityTable<User>: the table getter
  .where(u => eq(u.isActive, true))    // IEntityQueryable<User>: a builder step, sends nothing
  .select(u => u.username)             // EntitySelectQueryBuilder<User, string>
  .toList();                           // terminal: 1 statement, resolves string[]
```

```sql
SELECT "users"."username"
FROM "users"
WHERE "users"."is_active" = $1
-- params: [ true ]
```

## Which object has which method

A method the object's type does not declare does not compile. Columns: table = `DbEntityTable` (`db.<table>`);
query = `IEntityQueryable` (from `where()`, `orderBy()`, `limit()`, `offset()`, `with()`, `lateralJoin()`,
`joinFilter()` of a table); select = `EntitySelectQueryBuilder` (from `select()`, `selectDistinct()`, joins,
`crossJoinLateral()`); grouped = `GroupedSelectQueryBuilder`; CTE root = `CteRootQueryBuilder`
(`db.selectFromCte()`); set = `SetQueryBuilder` (`db.selectFromSet()`, `fromSet()`); union =
`UnionQueryBuilder`.

| Method | table | query | select | grouped | CTE root | set | union |
|---|---|---|---|---|---|---|---|
| `select()` | yes | yes | yes | no | yes | yes | no |
| `selectDistinct()` | yes | no | yes | no | no | no | no |
| `where()` | yes | yes | yes | `having()` | yes | yes | no |
| `orderBy()`, `limit()`, `offset()` | yes | yes | yes | yes | yes | yes | yes |
| `toList()` | yes | yes | yes | yes | yes | yes (not `fromSet()`) | yes |
| `first()` | throws on no row | `null` on no row | `null` on no row | `null` | `null` | no | no |
| `firstOrDefault()` | yes | yes | yes | yes | no | yes | yes |
| `firstOrThrow()` | no | no | yes | yes | no | no | no |
| `count()` | yes | yes | yes | no (`futureCount()`) | no | no | yes |
| `exists()`, `countOver()` | yes | yes | yes | no | no | no | no |
| `min()`, `max()`, `sum()` | no | no | yes | no | no | no | no |
| `groupBy()` | no | no | yes | no | no | no | no |
| `forUpdate()` | no | no | yes | no | throws¹ | no | no |
| `asSubquery()` | no | no | yes | yes | yes | yes | yes |
| `union()`, `unionAll()` | no | no | yes | no | yes | yes | yes |
| `future()` | yes | yes | yes | yes | no | no | yes |
| `futureFirstOrDefault()`, `futureCount()` | yes | yes | yes | yes | no | no | yes (since 1.0.31) |
| `prepare()` | yes | yes | yes | no | no | no | no |
| `update()`, `delete()` | yes | yes | yes | no | no | no | no |
| `innerJoin()`, `leftJoin()` | yes | yes | yes | CTE or subquery | CTE | no | no |
| `withTimeout()`, `expectedExecutionTime()` | yes | yes | yes | yes | yes | no | yes |
| `withPreparedStatements()` | yes | yes | yes | no | no | no | no |
| `toSql()` | no | no | no | no | yes | yes | yes |

¹ Since 1.0.33 a CTE-rooted query's `forUpdate()` throws `forUpdate() on a CTE-rooted query locks no rows: …` and
is `@deprecated`: a `FOR UPDATE` on an outer SELECT whose FROM holds only CTEs does not reach the `WITH` queries, so
before 1.0.33 it locked no row. Lock in the CTE body
(`builder.with('locked', db.users.where(…).select(…).forUpdate())`), see
[Lock the rows a CTE reads](./guides/cte-guide.md#lock-the-rows-a-cte-reads-forupdate-in-the-body).

On a table, `withQueryOptions()`, `withTimeout()`, `withPreparedStatements()` and `expectedExecutionTime()` return a
derived table and leave `db.<table>` unchanged. On a builder, `where()`, `orderBy()`, `limit()`, `offset()` and the
per-query overrides change the builder and return it, and `first*()` leaves `LIMIT 1` set on it; `select()` returns a
new builder; set queries and aliased scopes are immutable. A CTE-rooted query runs only after `select()`: without it
`toList()`, `first()`, `toSql()` and `asSubquery()` throw `A selection is required. Call .select(...) …`.

## Context and tables

- `abstract class DbContext` — the base class of every context (`DatabaseContext` in `src/entity/db-context.ts`): subclass it, implement `setupModel()`, expose each table as a getter. [guide](./guides/schema-configuration.md#declare-the-context-dbcontext-table-getters-and-setupmodel)
- `new AppDatabase(client: DatabaseClient, queryOptions?: QueryOptions)` — builds the model and sends no SQL; construct one context per client at startup and reuse it (entity metadata is process-wide). [guide](./database-clients.md#connect-a-context-to-a-client)
- `protected abstract setupModel(model: DbModelConfig): void` — declares entities, relations, indexes and views; runs on every construction. [guide](./guides/schema-configuration.md#define-a-model-entity-classes-a-context-and-setupmodel)
- `protected table(Entity): DbEntityTable<T>` — return it from a getter (`get users() { return this.table(User); }`); a class field breaks inside `transaction()`. [guide](./guides/schema-configuration.md#declare-the-context-dbcontext-table-getters-and-setupmodel)
- `protected view(View): DbViewTable<T>` — the read-only accessor of a `model.view()` declaration. [guide](./guides/schema-configuration.md#expose-a-read-only-view-modelview)
- `db.<table>`: `DbEntityTable<T>` — the query roots and the writes of one table; its methods are listed by task below. [guide](./guides/querying.md#choose-the-call-that-returns-what-you-need)
- `DbViewTable<T>` — the read subset of `DbEntityTable` for a view: `toList`, `first`, `firstOrDefault`, `count`, `exists`, `orderBy`, `limit`, `offset`, `select`, `selectDistinct`, `where`, `with`, `leftJoin`, `innerJoin`, `getColumns`, `getColumnKeys`, `props`, `selectFromCte`, `selectFromSet`, `isInTransaction`, `getClient` (the last four since 1.0.30); `countOver()`, `withTimeout()`, `prepare()` and `future()` work after `where()` or `select()`; `update()` / `delete()` throw. [guide](./guides/schema-configuration.md#expose-a-read-only-view-modelview)
- `` db.query<T>(sql`…`): Promise<T[]> `` / `db.query<T>(text, params?)` — run raw SQL and get the driver's rows: no mappers, no logging, no slow-query hook, no timeout, never a named statement. [guide](./guides/querying.md#run-a-raw-statement-dbquery)
- `db.getClient(): DatabaseClient` — the context's client; on `tx`, the transaction's. [guide](./database-clients.md#run-raw-sql)
- `db.<table>.getClient(): DatabaseClient` — the client of the table's context (the transaction's on `tx.<table>`), for what takes a client such as `new DbCteBuilder(client)`. (since 1.0.30) [guide](./guides/cte-guide.md#run-cte-statements-on-a-tables-own-connection-tableselectfromcte)
- `db.dispose(): Promise<void>` — `client.end()`: closes the pool the client created; call it once at shutdown, never per request. [guide](./database-clients.md#manage-the-client-lifecycle)

`db.transaction()` and the advisory locks are under [Transactions and locks](#transactions-and-locks);
`db.selectFromCte()` and `db.selectFromSet()` under [CTEs and set-returning sources](#ctes-and-set-returning-sources);
`db.getSchemaManager()` under [Migrations](#migrations); `db.runtimeSequence()` under [Schema model](#schema-model);
`withQueryOptions()` and the per-query overrides under [Configuration and diagnostics](#configuration-and-diagnostics).

## Reading: terminal methods

A terminal sends 1 statement unless noted; the `temptable` collection strategy and `withTimeout()` on
`PostgresClient` add statements. The terminals of grouped, CTE-rooted, set and union builders are listed with
those builders.

- `db.<table>.toList(): Promise<T[]>` — every row with every column, no WHERE and no ORDER BY; since 1.0.33 it honours `rawResult` (the driver's rows, keyed by the database column names) and `disableMappers` (stored values) as `first()` and `firstOrDefault()` do, never `traceTime` (before 1.0.33 it ignored all three). [guide](./guides/querying.md#read-whole-rows-tolist)
- `q.toList(): Promise<S[]>` — the rows of the query in the projection's shape; the order is unspecified without `orderBy()`. [guide](./guides/querying.md#read-whole-rows-tolist)
- `db.<table>.first(): Promise<T>` — `LIMIT 1` without WHERE or ORDER BY; throws `Sequence contains no elements` on an empty table. [guide](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first)
- `q.first(): Promise<S | null>` — on a query or select builder: the first row, or `null` when no row matches, as `firstOrDefault()`; typed `S | null` since 1.0.33 (before, typed `S`); sets `LIMIT 1` on the builder itself. [guide](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first)
- `firstOrDefault(): Promise<S | null>` — the first row or `null` (`LIMIT 1`); add `orderBy()` for a defined row; on a query, select or grouped builder it leaves `LIMIT 1` set (a union restores its own limit). [guide](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first)
- `firstOrThrow(): Promise<S>` — select builders and grouped selects only (call `select()` first); throws `No results found` when no row matches, and also when a one-value projection's first value is falsy (`0`, `''`, `false`, NULL). [guide](./guides/querying.md#get-one-row-firstordefault-firstorthrow-first)
- `count(): Promise<number>` — `SELECT COUNT(*) as count`; ignores `orderBy()`, `limit()`, `offset()` and `selectDistinct()`. [guide](./guides/querying.md#count-rows-without-loading-them-count)
- `exists(): Promise<boolean>` — `SELECT EXISTS(SELECT 1 …)`; stops at the first matching row; cheaper than `count() > 0`. [guide](./guides/querying.md#check-whether-rows-exist-exists)
- `countOver(): Promise<{ data: S[]; totalCount: number }>` — a page and the total match count in one statement (`COUNT(*) OVER()`); a page past the end reports `totalCount: 0`. [guide](./guides/querying.md#a-page-and-the-total-in-one-round-trip)

## Projection and filtering

- `select<S>(selector: (row) => S): EntitySelectQueryBuilder<T, S>` — on tables, queries and select builders: project columns, navigation columns, nested objects, conditions, literals and `sql` expressions; a selector returning one value reads a list of values. [guide](./guides/querying.md#select-only-the-columns-you-need-select)
- `selectDistinct<S>(selector)` — `SELECT DISTINCT` over the projection; on tables and select builders, not after `where()` (call it first, then `where()`). [guide](./guides/querying.md#return-unique-rows-selectdistinct)
- `where(condition: (row) => Condition)` — adds a WHERE predicate, ANDed with earlier ones; after `select()` a projected `sql` expression or literal cannot be filtered (filter before `select()`). [guide](./guides/querying.md#filter-rows-where)
- `orderBy(row => key | key[] | Array<[key, OrderDirection]>)` — ORDER BY columns, navigation columns, projected fields, `sql` expressions or conditions; replaces an earlier `orderBy()` (a collection's appends); a `false`, `null` or `undefined` key is skipped. [guide](./guides/querying.md#order-results-orderby)
- `OrderDirection` — `'ASC'`, `'DESC'`, `'ASC NULLS FIRST'`, `'ASC NULLS LAST'`, `'DESC NULLS FIRST'`, `'DESC NULLS LAST'`; any case. [guide](./guides/querying.md#order-results-orderby)
- `limit(n)` / `offset(n)` — on tables, queries, select and grouped builders, unions and CTE-rooted queries: written into the statement text as literals and not validated (`limit(2.5)` sends `LIMIT 2.5`): coerce request input to an integer; set queries and aliased scopes throw on anything but a non-negative integer; for deep pages use keyset paging (`where(u => gt(u.id, lastId)).orderBy(u => u.id).limit(n)`). [guide](./guides/querying.md#offset-pages-limit-and-offset)
- `let q: IEntityQueryable<T> = db.<table>; if (x) q = q.where(…)` — compose optional filters; skip unset values (`eq(col, undefined)` renders `IS NULL`). [guide](./guides/querying.md#build-a-query-from-optional-filters)

### Combine result sets: `union()`, `unionAll()`

- `select.union(q)` / `select.unionAll(q): UnionQueryBuilder<S>` — one result set from same-shaped projections (also on CTE-rooted and set queries); columns match by position; each leg is parenthesized; an entity leg's own `orderBy()`, `limit()` and `offset()` are dropped, a CTE-rooted or set leg keeps them. [guide](./guides/querying.md#combine-result-sets-union-unionall)
- `union.union(q)` / `union.unionAll(q)` — add another leg. [guide](./guides/querying.md#combine-result-sets-union-unionall)
- `union.orderBy(r => …)` / `union.limit(n)` / `union.offset(n)` — order and page the whole union by its projected fields. [guide](./guides/querying.md#combine-result-sets-union-unionall)
- `union.toList(): Promise<S[]>` / `union.firstOrDefault(): Promise<S | null>` / `union.count(): Promise<number>` — run it; `count()` wraps it in `SELECT COUNT(*) … FROM (…) as union_count`. [guide](./guides/querying.md#combine-result-sets-union-unionall)
- `union.future()` — a `QueryBatch.addList()` leg. [guide](./guides/batching-and-prepared-queries.md#check-which-queries-can-be-a-batch-leg)
- `union.futureCount()` / `union.futureFirstOrDefault()` — the union's count and first row as `QueryBatch.addCount()` / `addFirstOrDefault()` legs (also `execute()` alone and `FutureQueryRunner`); the count is the statement `count()` sends, so it counts the union's own `LIMIT` / `OFFSET`; both throw when the legs declare a data-modifying CTE (run `count()` / `firstOrDefault()` on its own). (since 1.0.31) [guide](./guides/batching-and-prepared-queries.md#count-a-union-or-read-its-first-row-in-a-batch)
- `union.asSubquery(mode?)` — embed the union in `inSubquery()`, a join or a CTE body. [guide](./guides/subquery-guide.md#subqueries-over-unions-ctes-and-sets)
- `union.toSql(): string` — the statement text without running it (the values: `union.future().getParams()`). [guide](./guides/configuration.md#see-the-sql-a-query-sends)
- `union.withTimeout(ms)` / `union.expectedExecutionTime(ms)` — per-query overrides; a union has no `withPreparedStatements()`. [guide](./guides/configuration.md#override-options-for-one-table-or-query)
- `isUnionQueryBuilder(value): boolean` — type guard. [guide](./guides/querying.md#combine-result-sets-union-unionall)

## Conditions (operators)

Each returns a `Condition` (or a boolean `SqlFragment`) for `where()`, `having()`, `joinFilter()`, a `caseWhen()`
branch or a projection. A JS value becomes a bound parameter, converted by the column's mapper.

- `eq(a, b)` / `ne(a, b)` — `=` / `!=`; either side may be a column, a value, an `sql` fragment, a scalar subquery or `sql.placeholder()`; `null` or `undefined` renders `IS NULL` / `IS NOT NULL`. [guide](./guides/querying.md#null-and-undefined-in-conditions)
- `gt(a, b)` / `gte(a, b)` / `lt(a, b)` / `lte(a, b)` — `>`, `>=`, `<`, `<=`; an `undefined` value throws `Cannot use > operator with undefined value …` when the query is built. [guide](./guides/querying.md#condition-functions)
- `isNull(a)` / `isNotNull(a)` — `IS NULL` / `IS NOT NULL`, no parameter. [guide](./guides/querying.md#condition-functions)
- `between(a, min, max)` — inclusive `BETWEEN $1 AND $2`; an `undefined` bound binds NULL and matches no row. [guide](./guides/querying.md#null-and-undefined-in-conditions)
- `and(...conditions)` / `or(...conditions)` / `not(condition)` — boolean composition; `and()` or `or()` of no operand renders `1=1` (an empty `or()` matches every row); an `undefined` operand throws. [guide](./guides/querying.md#condition-functions)
- `like(a, pattern)` / `ilike(a, pattern)` — `LIKE` / `ILIKE`, the pattern bound. [guide](./guides/querying.md#match-a-pattern-like-ilike-startswith)
- `startsWith(a, prefix)` — PostgreSQL's prefix operator `^@`. [guide](./guides/querying.md#match-a-pattern-like-ilike-startswith)
- `containsSearch(v)` / `startsWithSearch(v)` / `endsWithSearch(v): string` — build `'%v%'`, `'v%'`, `'%v'`; they do not escape `%`, `_` or `\` in `v`. [guide](./guides/querying.md#match-a-pattern-like-ilike-startswith)
- `regexMatches(a, re)` / `regexMatchesCaseInsensitive(a, re)` / `regexNoMatch(a, re)` / `regexNoMatchCaseInsensitive(a, re)` — `~`, `~*`, `!~`, `!~*`, the pattern bound. [guide](./guides/querying.md#match-a-regular-expression)
- `normalizedEq(a, v)` / `normalizedLike(a, pattern)` / `normalizedStartsWith(a, prefix)` — accent- and case-insensitive comparison through `public.search_normalize()`; needs an `ixNormalized()` index or `model.useSearchNormalize()`. [guide](./guides/querying.md#normalized-accentcase-insensitive-search)
- `searchNormalize(value): SqlFragment<string>` — `public.search_normalize(x)` as an expression. [guide](./guides/querying.md#normalized-accentcase-insensitive-search)
- `inArrayOpt(col, values)` / `notInArrayOpt(col, values)` — `IN ($1, …)` up to `LinkgressConfig.inArrayOptThreshold` (default 8) elements, `= ANY($1::type[])` / `<> ALL(…)` above it; the default choice for data-driven lists. [guide](./guides/querying.md#letting-the-list-length-decide-inarrayopt--notinarrayopt)
- `eqAny(col, values)` / `neAll(col, values)` — the whole list as one array parameter cast to the column's type (`= ANY($1::integer[])`): one statement text for every length. [guide](./guides/querying.md#one-parameter-for-every-length-eqany--neall)
- `inArray(col, values)` / `notInArray(col, values)` — one placeholder per element; `[]` renders `1=0` / `1=1`; a statement binds at most 65 535 parameters (32 767 on PGlite). [guide](./guides/querying.md#exact-placeholders-inarray--notinarray)
- `flagHas(col, flag)` / `flagHasAll(col, flags)` / `flagHasAny(col, flags)` / `flagHasNone(col, flags)` — bitmask tests on integer columns, the mask bound. [guide](./guides/querying.md#test-bitmask-flags)

Subquery conditions (`exists`, `inSubquery`, `gtSubquery`, …) are under [Subqueries and scopes](#subqueries-and-scopes);
JSONB and array predicates under [Expression helpers](#expression-helpers).

## Expression helpers

A helper renders one operand of the statement that uses it and sends nothing on its own.

### Raw SQL and fragments

- `` sql<T>`… ${x} …`: SqlFragment<T> `` — raw SQL: an interpolated column renders as its reference, a value as a bound parameter, a fragment inline; usable as a condition, projected value, order key or `db.query()` statement. [guide](./guides/sql-expressions.md#write-sql-no-helper-covers-the-sql-template)
- `sql.raw(text): RawSql` — text written into the statement verbatim, never bound; trusted text only. [guide](./guides/querying.md#values-are-bound-parameters)
- `sql.join(fragments, separator?: SqlFragment)` — fragments joined with one parameter numbering; the separator is a fragment (`` sql`, ` ``), `, ` by default. [guide](./guides/querying.md#values-are-bound-parameters)
- `sql.empty` — an empty fragment for conditional SQL. [guide](./guides/querying.md#values-are-bound-parameters)
- `sql.placeholder(name): Placeholder` — a named parameter that `PreparedQuery.execute({ name: value })` fills; refused by `db.query()`. [guide](./guides/batching-and-prepared-queries.md#build-a-query-once-and-execute-it-many-times-prepare)
- `fragment.mapWith(fn | mapper): SqlFragment<U>` — read the value through a function (null-safe) or a type mapper. [guide](./guides/sql-expressions.md#read-results-with-the-right-type-withreadtype-mapwith)
- `fragment.withReadType(pgType)` — read the value as a column of `pgType` reads (`'text'` keeps `'007'`); the SQL is unchanged. [guide](./guides/sql-expressions.md#read-results-with-the-right-type-withreadtype-mapwith)
- `fragment.as(alias)` — a copy with an alias; a projection key wins over it. [guide](./guides/sql-expressions.md#read-results-with-the-right-type-withreadtype-mapwith)
- `fragment.cast<T>(pgType)` / `fragment.castAsInt()` (and the other `castAs*()`) — `CAST(<fragment> AS type)`; drops the mapper. [guide](./guides/sql-expressions.md#cast-a-value-cast-castas)
- `fragment.toString(): string` — the fragment's SQL, `$1`-numbered, for debugging. [guide](./guides/sql-expressions.md#write-sql-no-helper-covers-the-sql-template)
- `class SqlFragment<T>` / `class RawSql` / `class Placeholder` — the classes of an expression, of `sql.raw()` and of `sql.placeholder()`. [guide](./guides/sql-expressions.md#write-sql-no-helper-covers-the-sql-template)

### Casts and constants

- `cast<T>(value, pgType: PgCastType): SqlFragment<T>` — `CAST(x AS type)`; a plain value binds as one parameter. [guide](./guides/sql-expressions.md#cast-a-value-cast-castas)
- `castAsInt` / `castAsSmallInt` / `castAsDouble` / `castAsBoolean` / `castAsString` / `castAsUuid` / `castAsDate` / `castAsTimestamp` / `castAsTimestamptz` / `castAsJson` / `castAsJsonb(value)` — typed shortcuts of `cast()`. [guide](./guides/sql-expressions.md#cast-a-value-cast-castas)
- `castAsVarchar(value, length?)` / `castAsNumeric(value, precision?, scale?)` / `castAsBigInt(value)` — `castAsNumeric` reads a JS number, `castAsBigInt` the exact string. [guide](./guides/sql-expressions.md#cast-a-value-cast-castas)
- `literal(value, pgType?)` — a constant written into the statement text, quoted (`'user'`); strings, numbers, bigints, booleans and `null`; each distinct value is another statement text. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `literalOf<T>(value, pgType?)` — `literal()` typed as the literal type (`'book' | 'film'`). [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `param(value, pgType?)` — exactly one bound parameter as an expression; `eq(col, param(null))` compares `= NULL` and matches nothing. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `typedNull<T>(pgType)` — `CAST(NULL AS type)`. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `asBoolean(condition): SqlFragment<boolean>` — a condition as a boolean value. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `quoteSqlLiteral(text): string` — the quoting `literal()` uses (`'it''s'`), for trusted SQL text. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `pgTypeOfValue(value): string | undefined` — the PostgreSQL type a helper gives a plain JS value (`1` → `integer`, a `Date` → `timestamptz`). [guide](./guides/sql-expressions.md#know-how-plain-values-are-bound)

### CASE and NULL handling

- `caseWhen(condition, then).when(condition, then).else(value)` — searched CASE (`CaseWhenExpression`); without `.else()` an unmatched row gives NULL. [guide](./guides/sql-expressions.md#choose-a-value-by-condition-casewhen-caseof)
- `caseOf(subject).when(match, then).else(value)` — simple CASE (`CaseOfBuilder` → `CaseOfExpression`), compared with `=`, so a NULL subject matches no branch. [guide](./guides/sql-expressions.md#choose-a-value-by-condition-casewhen-caseof)
- `coalesce(a, b, …)` — `COALESCE`; the first operand that carries a mapper reads the result. [guide](./guides/sql-expressions.md#handle-nulls-and-compare-null-safely-coalesce-nullif-greatest-isdistinctfrom)
- `nullIf(value, other)` — `NULLIF`. [guide](./guides/sql-expressions.md#handle-nulls-and-compare-null-safely-coalesce-nullif-greatest-isdistinctfrom)
- `greatest(a, b, …)` / `least(a, b, …)` — `GREATEST` / `LEAST`, at least two operands. [guide](./guides/sql-expressions.md#handle-nulls-and-compare-null-safely-coalesce-nullif-greatest-isdistinctfrom)
- `isDistinctFrom(a, b)` / `isNotDistinctFrom(a, b)` — NULL-safe comparison, as a condition or a value. [guide](./guides/sql-expressions.md#handle-nulls-and-compare-null-safely-coalesce-nullif-greatest-isdistinctfrom)

### Text

- `lower(x)` / `upper(x)` — `lower()` / `upper()`. [guide](./guides/sql-expressions.md#transform-text)
- `trim(x, chars?)` / `trimStart(x, chars?)` / `trimEnd(x, chars?)` — `btrim()` / `ltrim()` / `rtrim()`. [guide](./guides/sql-expressions.md#transform-text)
- `length(x)` — `char_length()`, in characters. [guide](./guides/sql-expressions.md#transform-text)
- `concat(a, …)` / `concatWs(separator, a, …)` / `concatStrict(a, b, …)` — `concat()` treats NULL as `''`, `concat_ws()` skips NULLs, `concatStrict` renders `a || b` and is NULL when an operand is NULL. [guide](./guides/sql-expressions.md#transform-text)
- `substring(x, start, count?)` / `substring(x, pattern)` — 1-based substring, or the first group of a POSIX pattern. [guide](./guides/sql-expressions.md#transform-text)
- `replace(x, from, to)` / `regexpReplace(x, pattern, replacement, flags?)` — `replace()` / `regexp_replace()`. [guide](./guides/sql-expressions.md#transform-text)

### Numbers

- `round(x, digits?)` / `floor(x)` / `ceil(x)` / `abs(x)` — read back as JS numbers. [guide](./guides/sql-expressions.md#compute-numbers)
- `mod(a, b)` / `modulo(a, b)` — the `mod()` function / the `%` operator (`modulo` with a `literal()` divisor matches an index on `col % n`). [guide](./guides/sql-expressions.md#compute-numbers)
- `add(a, b, …)` / `sub(a, b)` / `mul(a, b, …)` / `div(a, b)` — parenthesized arithmetic for projections, filters and `update()` values; integer by integer truncates; two plain JS values fail (`operator is not unique`). [guide](./guides/sql-expressions.md#compute-numbers)

### Dates and times

- `currentTimestamp()` / `localTimestamp()` / `currentDate()` / `utcTimestamp()` — `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`, `CURRENT_DATE`, `(now() AT TIME ZONE 'UTC')`: the transaction's start time. [guide](./guides/sql-expressions.md#work-with-dates-times-and-intervals)
- `atTimeZone(x, zone)` / `dateTrunc(unit, x, zone?)` / `datePart(field, x)` / `toChar(x, format)` — zone conversion, truncation, `EXTRACT`, formatting. [guide](./guides/sql-expressions.md#work-with-dates-times-and-intervals)
- `toInterval(spec)` / `addInterval(x, spec)` / `subInterval(x, spec)` — an interval (`'7 days'` or `{ days: 7 }`) bound as one text parameter. [guide](./guides/sql-expressions.md#work-with-dates-times-and-intervals)

### JSONB

- `jsonbPath<T>(doc, ...keys)` / `jsonbPathText(doc, ...keys)` — `->` / `->>` paths: string keys inline, numbers index arrays, `param(key)` binds a key; `->>` reads the exact text. [guide](./guides/sql-expressions.md#read-a-value-from-a-document-jsonbpath-jsonbpathtext)
- `jsonbValueText(doc)` — the whole value as text. [guide](./guides/sql-expressions.md#read-a-value-from-a-document-jsonbpath-jsonbpathtext)
- `jsonbSelect<T>(col, key)` / `jsonbSelectText<T>(col, key)` — older extractors typed by `keyof T`, without a mapper (`'007'` reads `7`); prefer `jsonbPath*`. [guide](./guides/querying.md#read-jsonb-fields)
- `jsonbContains(doc, value)` / `jsonbContainedBy(doc, value)` / `jsonbHasKey(doc, key)` / `jsonbHasAnyKey(doc, keys)` / `jsonbHasAllKeys(doc, keys)` — `@>`, `<@`, `?`, `?|`, `?&`; a GIN index with the default `jsonb_ops` class serves all but `<@`. [guide](./guides/sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome)
- `jsonbPathExists(doc, path, { vars?, silent? })` — `jsonb_path_exists()`, a function call no GIN index serves. [guide](./guides/sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome)
- `jsonbArraySome<T>(doc, element => condition)` — whether some element of a jsonb array matches; element values compare as text, so pass numbers and booleans through `jsonbConditionUnwrap(value)` (`String(value)`). [guide](./guides/sql-expressions.md#filter-documents-jsonbcontains-jsonbhaskey-jsonbpathexists-jsonbarraysome)
- `jsonbArrayLength(x)` / `jsonbTypeOf(x)` — `jsonb_array_length()` (raises for a non-array) / `jsonb_typeof()`. [guide](./guides/sql-expressions.md#read-filter-build-and-change-jsonb)
- `jsonbBuildObject({ … })` / `jsonbBuildArray(…)` / `jsonBuildObject({ … })` / `jsonBuildArray(…)` / `toJsonb(x)` — build JSON in SQL; no mappers inside (a timestamp becomes JSON text). [guide](./guides/sql-expressions.md#build-json-in-sql-jsonbbuildobject-jsonbuildarray-tojsonb)
- `jsonbSet(doc, path, value, { createMissing? })` / `jsonbRemoveKey(doc, ...keys)` / `jsonbRemovePath(doc, path)` / `jsonbMerge(doc, patch)` — change part of a document inside one UPDATE; `jsonbMerge` starts a NULL document from `{}`; wrap an array patch in `castAsJsonb()`. [guide](./guides/sql-expressions.md#change-part-of-a-document-in-one-update-jsonbset-jsonbmerge-jsonbremovekey)

### Array columns and flags

- `arrayContains(col, value)` — `value = ANY(col)`, which no GIN index serves. [guide](./guides/sql-expressions.md#query-array-columns)
- `arrayContainsAll(col, values)` / `arrayOverlaps(col, values)` / `arrayContainedBy(col, values)` — `@>`, `&&`, `<@` with the list bound as one array literal. [guide](./guides/sql-expressions.md#query-array-columns)
- `arrayLength(col)` / `arrayIsEmpty(col)` / `arrayIsNotEmpty(col)` — `cardinality()` (0 for an empty array, NULL for a NULL one). [guide](./guides/sql-expressions.md#query-array-columns)
- `arrayAppendUnique(col, value)` / `arrayRemove(col, value)` — `update(r => ({ tags: arrayAppendUnique(r.tags, v) }))` values that change an array column inside the UPDATE, from each row's current array: append unless present (a NULL array counts as empty; a `null` value throws) / `array_remove()` of every occurrence; a second run changes nothing. (since 1.0.31) [guide](./guides/sql-expressions.md#change-an-array-in-place-arrayappendunique-arrayremove-since-1031), [writes](./guides/insert-update-guide.md#add-or-remove-one-value-of-an-array-column-arrayappendunique-arrayremove-since-1031)
- `flagSet(col, flags)` / `flagUnset(col, flags)` — `col | mask` / `col & ~mask` as `update()` values: change bits without reading the row. [guide](./guides/querying.md#test-bitmask-flags)

## Aggregates and windows

- `agg.count()` / `agg.count(v)` / `agg.countDistinct(v)` — `count(*)`, `count(v)`, `count(DISTINCT v)`; a select of `agg.*` values without `groupBy()` returns one row over the filtered set. [guide](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg)
- `agg.sum(v, { distinct? })` / `agg.avg(v, { distinct? })` — read as JS numbers; NULL over no rows. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `agg.min(v)` / `agg.max(v)` — read through the operand's mapper. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `agg.bitOr(v)` / `agg.bitAnd(v)` — `bit_or()` / `bit_and()`. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `agg.arrayAgg(v, { distinct?, orderBy? })` / `agg.jsonAgg(v, …)` / `agg.jsonbAgg(v, …)` — the values as one array; NULL over no rows (`coalesce(…, literal('{}', 'integer[]'))` for `[]`); in a grouped select it reads the grouping key only (the members: `g.arrayAgg()`). [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `aggregate.filter(condition)` — `FILTER (WHERE …)`; a second call is ANDed; call it before `.mapWith()` or `.as()`. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `class AggregateFragment<T>` — what `agg.*` returns. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `select.min(sel?)` / `select.max(sel?)` / `select.sum(sel?): Promise<R | null>` — one statement per call; since 1.0.33 the value reads as `agg.sum()` / `agg.min()` / `agg.max()` read it (`sum()` a number, `450`; `min()` / `max()` through the column's mapper; NULL over no rows; `rawResult` keeps the driver's value), before 1.0.33 the driver's value (`'450'`); a column selector only; no `avg()`; several aggregates in one statement: an `agg.*` select. [guide](./guides/querying.md#aggregate-the-whole-set-in-one-statement-agg)
- `select.groupBy(r => key): GroupedQueryBuilder` — only after `select()`; group keys and aggregate arguments must be in that projection. [guide](./guides/querying.md#group-rows-groupby)
- `grouped.select(g => S): GroupedSelectQueryBuilder` — one row per group from `g.key.<k>`, `g.count()`, `g.sum(r => …)`, `g.avg(r => …)`, `g.min(r => …)`, `g.max(r => …)`, `g.arrayAgg(r => …)`, `g.countDistinct(r => …)`. [guide](./guides/querying.md#aggregates-per-group)
- `GroupedItem<K, Row>` — `key`, `count()` (integer), `sum()` / `avg()` (cast to double precision), `min()` / `max()` (read through the column's mapper), `arrayAgg()` / `countDistinct()` (since 1.0.31). [guide](./guides/querying.md#aggregates-per-group)
- `g.arrayAgg(r => value, { distinct?, orderBy? })` / `g.countDistinct(r => value)` — `array_agg([DISTINCT] … [ORDER BY …])` and `count(DISTINCT …)` over a column or `sql` expression of the grouped row: each group's members as a list (elements read through the column's mapper, a NULL value is an element) and its number of distinct non-NULL values; in the grouped `select()` and in `having()`; with `distinct` the list orders by the aggregated value only; a constant or a nested aggregate is refused. (since 1.0.31) [guide](./guides/querying.md#list-a-groups-members-and-count-distinct-values-garrayagg-gcountdistinct)
- `having(g => condition)` — on `GroupedQueryBuilder` and `GroupedSelectQueryBuilder`: HAVING over keys and aggregates (`g.countDistinct()` too, since 1.0.31); calls are ANDed. [guide](./guides/querying.md#filter-groups-having)
- `groupedSelect.orderBy(r => …)` / `.limit(n)` / `.offset(n)` — order and page the groups by projected fields. [guide](./guides/querying.md#order-and-limit-groups)
- `groupedSelect.toList()` / `.first()` / `.firstOrDefault()` / `.firstOrThrow()` — run it; `first*()` leaves `LIMIT 1` on the builder; no `count()` (use `futureCount().execute()` or `QueryBatch.addCount()`). [guide](./guides/querying.md#group-rows-groupby)
- `groupedSelect.future()` / `.futureFirstOrDefault()` / `.futureCount()` — batch legs; `futureCount()` counts the groups. [guide](./guides/batching-and-prepared-queries.md#batch-a-grouped-query-with-other-reads)
- `groupedSelect.asSubquery(mode?)` — the groups as a table, array or scalar subquery, or a CTE body. [guide](./guides/subquery-guide.md#build-a-subquery-assubquerymode)
- `groupedSelect.leftJoin(cte | subquery, on, select, alias?)` / `.innerJoin(…)`: `GroupedJoinedQueryBuilder` — join the groups to a CTE or a table subquery (not to an entity table). [guide](./guides/querying.md#group-rows-groupby)
- `GroupedJoinedQueryBuilder` — `orderBy`, `limit`, `offset`, `toList`, `first`, `firstOrDefault`, `firstOrThrow`, `future`, `futureFirstOrDefault`, `futureCount`, `asSubquery`, `withTimeout`, `expectedExecutionTime`. [guide](./guides/querying.md#group-rows-groupby)
- `win.rowNumber()` / `win.rank()` / `win.denseRank()` — window ranking functions read as JS numbers. (since 1.0.21) [guide](./guides/querying.md#number-and-rank-rows-window-functions)
- `windowFragment.over({ partitionBy?, orderBy? })` — the window; a new call replaces it; filter a window value where a CTE is read, never in the query that computes it. (since 1.0.21) [guide](./guides/sql-expressions.md#number-and-rank-rows-win-since-1021)
- `class WindowFragment<T>` — what `win.*` returns. (since 1.0.21) [guide](./guides/sql-expressions.md#number-and-rank-rows-win-since-1021)

Per-parent aggregates of a collection (`u.posts!.count()`, `.sum()`, `.max()`) are under
[Collections and navigations](#collections-and-navigations).

## Collections and navigations

- `r.<nav>!.<column>` in `select()`, `where()`, `orderBy()` — a reference navigation (`hasOne`): one join per hop, INNER for an `isRequired()` relation, LEFT otherwise; an unread navigation adds no join. [guide](./guides/querying.md#read-a-related-rows-columns-navigations)
- `select(p => ({ author: p.user }))` — a whole navigation row: every column of the related row. [guide](./guides/querying.md#project-one-value-a-condition-a-literal-or-a-nested-object)
- `lateralJoin(row => row.<nav>)` — one reference navigation (or a path's last hop) as a per-row key probe (`LEFT` or `INNER JOIN LATERAL (… OFFSET 0)`), for few rows read into a large table; on tables, queries, select builders and collections (before their `select()`); refused by `update()`, `delete()`, `groupBy()`, `selectMany()`. (since 1.0.23) [guide](./guides/lateral-navigation-joins.md#probe-one-navigation-instead-of-joining-it)
- `r.<collection>!`: `EntityCollectionQuery<C>` — a `hasMany` navigation inside a selector; it renders a subquery and sends nothing by itself. [guide](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections)
- `collection.select(i => S)` / `collection.selectDistinct(i => S)` — the shape of each item. [guide](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections)
- `collection.where(i => condition)` — filter each parent's items (the condition reads the item, also after `select()`); a value compared directly with a mapped column of the item binds through its `toDriver` (since 1.0.31: pass the application value). [guide](./guides/querying.md#filter-order-and-limit-each-parents-children), [mapped columns](./guides/querying.md#compare-and-aggregate-the-items-mapped-columns)
- `collection.orderBy(…)` / `collection.limit(n)` / `collection.offset(n)` — per parent; a second `orderBy()` appends keys. [guide](./guides/querying.md#filter-order-and-limit-each-parents-children)
- `collection.toList(name?)` — each parent's items as an array (`[]` when none); `name` does not rename the result key. [guide](./guides/querying.md#load-each-rows-children-in-the-same-statement-collections)
- `collection.toNumberList(name?)` / `collection.toStringList(name?)` — a flat native array of one value per item. [guide](./guides/querying.md#value-lists-and-one-child-per-parent)
- `collection.firstOrDefault(name?)` — one item per parent or `null`; pair it with `orderBy()`. [guide](./guides/querying.md#value-lists-and-one-child-per-parent)
- `collection.count()` / `collection.exists()` — per-parent count and flag; also valid in `where()`, `orderBy()` and `` sql`…` ``. [guide](./guides/querying.md#count-sum-min-and-max-per-parent)
- `collection.sum(i => …)` / `collection.min(i => …)` / `collection.max(i => …)` — per-parent aggregates, NULL without items; projections only (not in `where()` / `orderBy()`); a collection has no `avg()`; `min()` / `max()` of a bare mapped column read through its mapper (since 1.0.31; typed `number | null`). [guide](./guides/querying.md#count-sum-min-and-max-per-parent), [mapped columns](./guides/querying.md#compare-and-aggregate-the-items-mapped-columns)
- `collection.sum(i => i.<nav>!.<collection>!.count())` — a count of a collection reached through the item's reference navigations, summed per parent; the hop is joined inside the summed collection's subquery (it failed with 42P01 before 1.0.31). (since 1.0.31) [guide](./guides/querying.md#sum-a-count-over-each-items-related-rows)
- `collection.selectMany(i => i.<collection>!)` — flatten grandchildren through an intermediate collection. [guide](./guides/querying.md#many-to-many-and-grandchildren-selectmany)
- `r.<nav>!.<nav>!.<column>` — a path of several hops: one join per hop, each INNER or LEFT by its own declaration; intermediate hops are joined even when none of their columns is read. [guide](./guides/querying.md#paths-of-several-hops)
- navigation join aliases — a hop renders under its relation name (`"user"`); when two paths in one query end in the same relation name the shallowest keeps it and the others render as `"<parentAlias>__<relation>"` (`"order__user"`): interpolate the column (`` sql`upper(${pc.order!.user!.username})` ``), never write an alias into raw SQL. [guide](./guides/querying.md#navigation-joins-and-their-aliases)
- `r.<nav>!.<collection>!` — a collection reached through navigations (`pc.post!.user!.posts!.count()`), any chain of reference navigations; a row whose navigation is missing gets the empty value (`[]`, `0`, `null`), except under `temptable` when every returned row lacks it (an error). [guide](./guides/querying.md#collections-reached-through-navigations)
- `collection.where(i => …)` reading the enclosing row — items compared with the row the collection hangs off (`p.user!.posts!.where(x => ne(x.id, p.id))`); renders as a LATERAL subquery under every strategy. [guide](./guides/querying.md#comparing-items-with-the-enclosing-row)
- a collection inside a collection's projection — nested collections (`u.posts!.select(p => ({ comments: p.postComments!.select(…).toList() })).toList()`): a nested LATERAL under `lateral`, a nested CTE under `cte`, still 1 statement. [guide](./collection-strategies.md#read-the-sql-of-the-lateral-strategy-default)
- navigations and collections of a manually joined table — `innerJoin(db.posts, …, (o, p) => ({ author: p.user!.username }))` renders `LEFT JOIN "users" AS "posts_0__user"` (LEFT even for a required relation); a joined table's collections need the `lateral` strategy (`cte` / `temptable` throw). [guide](./guides/querying.md#how-a-joined-tables-columns-read)
- `collectionStrategy: 'lateral' | 'cte' | 'temptable'` — how collections render: `'lateral'` (default) and `'cte'` in 1 statement, `'temptable'` in several; set it per context or with `withQueryOptions()`. [guide](./collection-strategies.md#pick-a-strategy)
- strategy fallbacks — the configured strategy is a request: under `cte` / `temptable` a collection that reads the enclosing row or projects a window value renders as LATERAL; under `temptable` a query built as one statement (`countOver()`, `prepare()`, `future()` / a `QueryBatch` leg, a `union()` leg) renders the `cte` form. [guide](./collection-strategies.md#know-when-another-strategy-is-rendered)
- `class CollectionQueryBuilder` — the runtime class behind `EntityCollectionQuery`; reached through a navigation, never constructed. [guide](./collection-strategies.md#reference-options-types-and-exports)

Entity rows from `toList()` / `first()` never carry navigations: there is no lazy or eager loading; project
related rows in the same statement.

## Joins

- `innerJoin(db.<table>, (l, r) => on, (l, r) => S, alias?)` / `leftJoin(…)` — on tables, queries and select builders: join any table on any condition and project from both; the selector is required; a joined table is aliased `<table>_<n>` whatever the alias argument; an unmatched `leftJoin()` column reads `undefined`. [guide](./guides/querying.md#join-tables-without-a-navigation-innerjoin-leftjoin)
- `innerJoin(subquery, on, select, alias)` / `leftJoin(subquery, on, select, alias)` — join a derived table (`asSubquery('table')`); the alias is required. [guide](./guides/subquery-guide.md#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)
- `innerJoin(cte, on, select)` / `leftJoin(cte, on, select)` — join a CTE; no alias; the CTE is added to the statement's WITH. [guide](./guides/cte-guide.md#join-a-per-key-aggregate-to-entity-rows-with--leftjoin)
- `joinFilter(db.<table> | cte, (l, r) => on, filter?)` / `leftJoinFilter(…)` — a join used only to filter rows; the shape is kept; `leftJoinFilter` with `isNull(right.<pk>)` is an anti-join. [guide](./guides/querying.md#filter-by-a-joined-table-joinfilter-leftjoinfilter)
- `SelectQueryBuilder.leftJoinSubquery(sub, alias, on, select)` / `.innerJoinSubquery(…)` — older argument order, declared on the class but not on the typed `EntitySelectQueryBuilder`; write `leftJoin(sub, on, select, alias)`. [guide](./guides/subquery-guide.md#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)

Joins of grouped selects are under [Aggregates and windows](#aggregates-and-windows), joins between CTEs under
[CTEs and set-returning sources](#ctes-and-set-returning-sources), joins inside an aliased scope under
[Subqueries and scopes](#subqueries-and-scopes), `crossJoinLateral()` under set-returning sources.

## Subqueries and scopes

- `asSubquery(mode?: 'table' | 'array' | 'scalar'): Subquery` — on select builders, grouped selects, unions, CTE-rooted and set queries (call `select()` first): the query embedded in another statement; `'table'` by default. [guide](./guides/subquery-guide.md#build-a-subquery-assubquerymode)
- `exists(source)` / `notExists(source)` — `EXISTS (…)` / `NOT EXISTS (…)`; `source` is a `'table'` subquery or a collection (`u.posts!.where(…)`), never a builder, a table or an `sql` fragment. [guide](./guides/subquery-guide.md#keep-rows-that-have-related-rows-exists)
- `inSubquery(col, sub)` / `notInSubquery(col, sub)` — `IN (SELECT …)` / `NOT IN`; `sub` is an `'array'` subquery of one value; `NOT IN` returns no row once the subquery yields a NULL. [guide](./guides/subquery-guide.md#filter-by-keys-another-query-computes-insubquery)
- `eqAnySubquery(col, sub)` / `neAllSubquery(col, sub)` — `= ANY (ARRAY(SELECT …))` / `<> ALL (…)`: the result collected once into one array. [guide](./guides/subquery-guide.md#match-against-one-array-eqanysubquery--neallsubquery)
- `eqSubquery(col, sub)` / `neSubquery` / `gtSubquery` / `gteSubquery` / `ltSubquery` / `lteSubquery` — compare a column with a `'scalar'` subquery (`eq()`, `gt()` and the others take a scalar subquery on either side too). [guide](./guides/subquery-guide.md#compare-a-column-with-a-computed-value)
- `q.select(x => x.col).asSubquery('scalar')` as a projected value — one value per outer row; no LIMIT is added, so two rows fail. [guide](./guides/subquery-guide.md#project-a-per-row-value-a-scalar-subquery-in-select)
- `subquery.asExpression<T>(): SqlFragment<T>` — a scalar subquery as an operand of `coalesce()`, arithmetic, an order key or an `update()` value. [guide](./guides/subquery-guide.md#use-a-scalar-subquery-inside-an-expression-asexpression)
- `subquery.as(alias)` — names the subquery; joins ignore it and take their alias argument. [guide](./guides/subquery-guide.md#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)
- `subquery.isScalar()` / `.isArray()` / `.isTable()` / `isSubquery(value)` — guards; `class Subquery<R, M>` is what `asSubquery()` returns. [guide](./guides/subquery-guide.md#api-signatures)
- `db.<table>.as(alias): AliasedScope` — a correlated subquery over the table under an explicit alias: same-table probes, top-1 lookups, joins inside the probe. [guide](./guides/aliased-scopes.md#choose-a-scope-or-another-tool)
- `scope.where((...rows) => condition)` / `scope.orderBy((...rows) => [[key, 'ASC' | 'DESC'], …])` / `scope.limit(n)` — immutable steps, each returning a new scope. [guide](./guides/aliased-scopes.md#read-the-top-value-per-row-orderby--limit1--scalar)
- `scope.innerJoin(db.<t>.as(a), (...rows) => on)` / `scope.leftJoin(…)` — join another table inside the probe. [guide](./guides/aliased-scopes.md#join-tables-inside-the-probe-innerjoin--leftjoin)
- `scope.scalar((...rows) => value): SqlFragment<T>` — `(SELECT value FROM … [ORDER BY …] [LIMIT n])` as one value. [guide](./guides/aliased-scopes.md#read-the-top-value-per-row-orderby--limit1--scalar)
- `scope.exists()` / `scope.notExists(): SqlFragment<boolean>` — `EXISTS (…)` / `(NOT EXISTS (…))` of the scope. [guide](./guides/aliased-scopes.md#test-for-another-row-of-the-same-table-exists)
- `scope.row` — the scope's row: column refs qualified by its alias. [guide](./guides/aliased-scopes.md#use-a-scope-anywhere-a-fragment-goes)

## CTEs and set-returning sources

### CTEs

- `new DbCteBuilder(client?)` — collects named CTEs; pass `db.getClient()` (or a table's) so bodies follow the driver's array support. [guide](./guides/cte-guide.md#decide-cte-subquery-join-or-collection)
- `builder.with(name, query, { materialized? }): { cte }` — any query as the body (entity, grouped, union, CTE-rooted, set); `materialized: true` renders `AS MATERIALIZED`. [guide](./guides/cte-guide.md#choose-the-cte-body-any-query-a-statement-can-run)
- `builder.withAggregation(name, query, keySelector, alias = 'items'): DbCte` — one row per key with the other columns folded into a JSON array; returns the `DbCte` itself. [guide](./guides/cte-guide.md#attach-child-rows-as-a-json-array-per-key-withaggregation)
- `builder.withMutation(name, statement: CompiledStatement): { cte }` — a write (from `.toStatement()`) as a data-modifying CTE, typed by its RETURNING. [guide](./guides/cte-guide.md#write-and-read-back-in-one-statement-withmutation)
- `builder.getCtes()` / `builder.clear()` — the CTEs collected so far / start over. [guide](./guides/cte-guide.md#combine-ctes-of-several-builders-getctes-clear)
- `q.with(...ctes)` — declare CTEs on the executing query; nested subqueries then read them by name. [guide](./guides/cte-guide.md#read-one-cte-from-several-subqueries-declare-it-once)
- `cte.as(alias?): CteTableRef` — a CTE reference to interpolate in `` sql`…` `` templates. [guide](./guides/cte-guide.md#read-a-cte-from-a-raw-sql-fragment-cteasalias)
- `cte.getColumn(name)` / `cte.isAggregationColumn(name)` / `cte.name` / `cte.materialized` / `cte.dataModifying` — members of `class DbCte<C>`; `isCte(value)` is its guard. [guide](./guides/cte-guide.md#type-cte-columns)
- `afterMutation(cte): Condition` — in a compiled statement's WHERE: that statement writes after the data-modifying CTE ran (it orders writes, not what they see). (since 1.0.29) [guide](./guides/cte-guide.md#order-two-writes-in-one-statement-aftermutation)
- `db.selectFromCte(cte, alias?): CteRootQueryBuilder` — a query whose FROM root is a CTE. [guide](./guides/cte-guide.md#read-a-cte-as-the-from-root-dbselectfromcte)
- `db.<table>.selectFromCte(cte, alias?)` — the same on the table's context and connection (inside the transaction on `tx.<table>`). (since 1.0.30) [guide](./guides/cte-guide.md#run-cte-statements-on-a-tables-own-connection-tableselectfromcte)
- `cteRoot.select(root => S)` / `cteRoot.where(root => condition)` / `.orderBy(…)` / `.limit(n)` / `.offset(n)` — `select()` is required before any terminal and returns a new builder; `where()`, `orderBy()`, `limit()` and `offset()` change the builder; `orderBy()` names output aliases. [guide](./guides/cte-guide.md#read-a-cte-as-the-from-root-dbselectfromcte)
- `cteRoot.toList()` / `cteRoot.first(): Promise<S | null>` — run it (after `select()`); there is no `count()` or `firstOrDefault()` (`select(() => agg.count()).first()` resolves the number). [guide](./guides/cte-guide.md#read-a-cte-as-the-from-root-dbselectfromcte)
- `cteRoot.forUpdate({ skipLocked?, noWait? })` — `@deprecated`; since 1.0.33 it throws `forUpdate() on a CTE-rooted query locks no rows: …` and sends nothing. Before 1.0.33 it appended `FOR UPDATE` to the outer SELECT, whose FROM holds only CTEs, and PostgreSQL locked NO rows. To lock, put `.forUpdate()` on the query that is the CTE's body. [guide](./guides/cte-guide.md#lock-the-rows-a-cte-reads-forupdate-in-the-body)
- `cteRoot.toSql()` / `cteRoot.asSubquery(mode?)` / `cteRoot.withTimeout(ms)` / `cteRoot.expectedExecutionTime(ms)` — text, embedding and per-query overrides. [guide](./guides/cte-guide.md#read-a-cte-as-the-from-root-dbselectfromcte)
- `cteRoot.union(q)` / `cteRoot.unionAll(q)` — a CTE-rooted query as a union leg, beside entity and set queries: the typed readback of several data-modifying CTEs. (since 1.0.29) [guide](./guides/cte-guide.md#order-two-writes-in-one-statement-aftermutation)
- `cteRoot.innerJoin(cte, condition)` / `.leftJoin` / `.rightJoin` / `.fullOuterJoin(cte, condition)` / `.crossJoin(cte)`: `CteJoinedQueryBuilder` — joins between CTEs; its `select((root, right) => …)` and `where((root, right) => …)` receive one row per source. [guide](./guides/cte-guide.md#join-derived-sets-with-full-outer-right-or-cross-joins)
- `onTrue()` / `onFalse()` — the join conditions `TRUE` / `FALSE` (`onFalse` since 1.0.29). [guide](./guides/cte-guide.md#join-derived-sets-with-full-outer-right-or-cross-joins)

### Set-returning sources

- `unnest(array, elementType?)` — one row per element in column `value`; a JS array binds as one array parameter and needs `elementType`. [guide](./guides/set-returning-functions.md#turn-a-js-list-into-rows-dbselectfromsetunnest)
- `unnestZip({ col: { values, type }, … })` — several arrays zipped by position into rows. [guide](./guides/set-returning-functions.md#zip-js-arrays-into-typed-rows-unnestzip)
- `unnestRows(table, rows, columns?)` — JS rows typed by a table's columns, one array parameter per column, cells bound through the column mappers. (since 1.0.29) [guide](./guides/set-returning-functions.md#bind-js-rows-typed-by-a-table-unnestrows--fromrows)
- `fromRows(table, rows, { columns?, alias? })` — `fromSet(unnestRows(…), alias ?? 'rows')`: an `insertFrom()` source or a `notExists()` set whose statement text does not grow with the rows. (since 1.0.29) [guide](./guides/set-returning-functions.md#bind-js-rows-typed-by-a-table-unnestrows--fromrows)
- `jsonbArrayElements<T>(doc)` / `jsonbEachText(doc)` — the elements of a jsonb array (`value`) / the entries of an object (`key`, `value`). [guide](./guides/set-returning-functions.md#turn-jsonb-into-rows-jsonbarrayelements--jsonbeachtext)
- `fromSet(set, alias?): SetQueryBuilder` — a set query without a context, to embed in `exists()`, `inSubquery()`, a join or a union; its `toList()` throws. [guide](./guides/set-returning-functions.md#test-each-row-against-a-list-or-a-jsonb-document-fromset-subqueries)
- `db.selectFromSet(set, alias?)` — a set query that runs on the context. [guide](./guides/set-returning-functions.md#turn-a-js-list-into-rows-dbselectfromsetunnest)
- `db.<table>.selectFromSet(set, alias?)` — the same on the table's context and connection. (since 1.0.30) [guide](./guides/set-returning-functions.md#run-a-set-query-on-a-tables-own-connection-tableselectfromset)
- `setQuery.where` / `.select` / `.orderBy` / `.limit` / `.offset` / `.union` / `.unionAll` / `.asSubquery` / `.toList` / `.firstOrDefault` / `.toSql` — the `SetQueryBuilder` surface; immutable (every method returns a new query); `orderBy()` reads the set's columns, not the projection; the alias defaults to the function's name (`"unnest"`); no `count()` (`select(() => agg.count()).firstOrDefault()` resolves the number). [guide](./guides/set-returning-functions.md#combine-sets-with-other-queries-joins-unions-cte-bodies)
- `crossJoinLateral(row => set, (row, setRow) => S, alias)` — a set per row (`CROSS JOIN LATERAL`) on tables, queries and select builders; a row whose set is empty drops out. [guide](./guides/set-returning-functions.md#join-a-set-to-every-row-crossjoinlateral)
- `class SetReturningFunction<Row>` — what `unnest()` and the others return; as a projection value it repeats the row per element. [guide](./guides/set-returning-functions.md#repeat-each-row-per-element-a-set-as-a-projection-value)

## Batching and prepared queries

- `new QueryBatch()` — independent reads of ONE context run as one `UNION ALL` statement. [guide](./guides/batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch)
- `batch.addList(q, id): BatchListKey<S>` — a list leg: anything with `future()` (tables, queries, select builders, grouped selects, unions). [guide](./guides/batching-and-prepared-queries.md#check-which-queries-can-be-a-batch-leg)
- `batch.addFirstOrDefault(q, id): BatchItemKey<S>` — the first row or `null` (`LIMIT 1`); of a union too (since 1.0.31). [guide](./guides/batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch)
- `batch.addCount(q, id): BatchCountKey` — a count leg; ignores `orderBy()`, `limit()` and `offset()`, except of a union (since 1.0.31), whose count counts its own `LIMIT` / `OFFSET`. [guide](./guides/batching-and-prepared-queries.md#load-a-page-and-its-total-count-in-one-round-trip)
- `batch.executeBatch(): Promise<void>` — 1 statement for every leg; one-shot; an empty batch throws; legs of another client, transaction or derived executor are refused before anything is sent. [guide](./guides/batching-and-prepared-queries.md#fix-batch-refusals)
- `batch.getList(key | id)` / `batch.getItem(key | id)` / `batch.getCount(key | id)` — the results, after `executeBatch()`. [guide](./guides/batching-and-prepared-queries.md#read-a-batchs-results-keys-ids-and-getters)
- `batch.withPreparedStatements(bool)` — name or un-name the batch statement, whatever the context says. [guide](./guides/batching-and-prepared-queries.md#name-or-un-name-the-batch-statement-withpreparedstatements)
- `q.future(): FutureQuery<S>` / `q.futureFirstOrDefault(): FutureSingleQuery<S>` / `q.futureCount(): FutureCountQuery` — build a read's SQL now and run it later; sends nothing. [guide](./guides/batching-and-prepared-queries.md#build-a-read-now-and-run-it-later-future)
- `future.execute()` — run one future: 1 statement through the context's executor. [guide](./guides/batching-and-prepared-queries.md#build-a-read-now-and-run-it-later-future)
- `future.getSql()` / `future.getParams()` — the statement text and its parameters, without running it. [guide](./guides/configuration.md#see-the-sql-a-query-sends)
- `FutureQueryRunner.runAsync([…] as const)` — run futures of one context: one multi-statement message only on `PostgresClient`, `BunClient` and `PGliteClient` at the root with futures that bind no parameter, otherwise one statement per future. [guide](./guides/batching-and-prepared-queries.md#run-several-futures-together-futurequeryrunnerrunasync)
- `isFutureQuery(value)` / `isFutureSingleQuery(value)` / `isFutureCountQuery(value)` — guards. [guide](./guides/batching-and-prepared-queries.md#build-a-read-now-and-run-it-later-future)
- `q.prepare<P>(name): PreparedQuery<S, P>` — build the SQL once; each execution fills the `sql.placeholder()` values; the hot-path choice on every client, on `PostgresClient` from a `preparedStatements: true` context ([Run one query shape many times](./guides/batching-and-prepared-queries.md#run-one-query-shape-many-times-prepare-and-preparedstatements)); per-query overrides (`withTimeout()`, `withPreparedStatements()`, `expectedExecutionTime()`) go before it. [guide](./guides/batching-and-prepared-queries.md#build-a-query-once-and-execute-it-many-times-prepare)
- `prepared.execute(params: P): Promise<S[]>` — 1 statement; a missing placeholder throws `Missing parameter: <name>`; since 1.0.33 it runs through the executor of the query it was prepared from (logged, timed, named under `preparedStatements`, time-limited by its `withTimeout()`); before 1.0.33 it bypassed the executor (unnamed, unlogged, no timeout). [guide](./guides/batching-and-prepared-queries.md#know-what-execute-checks-and-what-it-skips)
- `prepared.getSql()` / `prepared.getPlaceholderNames()` / `prepared.name` — inspect it. [guide](./guides/batching-and-prepared-queries.md#inspect-a-prepared-query)

Independent writes in one statement (`MutationBatch`) are under [Writing](#writing).

## Writing

A write method returns a lazy builder: `await` sends the statement and resolves `undefined`; `.returning()`
resolves the written rows (`insert()`: the one row) and `.affectedCount()` (update and delete) a count. A builder
awaited twice runs twice. `insertWithChildren()` and `insertBulkWithChildren()` return promises that start at once.

- `db.<table>.insert(row)` — one row (`insertBulk([row])`); a value for an identity or serial column is left out. [guide](./guides/insert-update-guide.md#insert-one-row-insert)
- `db.<table>.insertBulk(rows, { chunkSize?, overridingSystemValue?, onConflictDoNothing? })` — a multi-row `INSERT … VALUES`, one statement per chunk (chunks are not atomic outside a transaction); a key missing from some rows is NULL there, not the column default. [guide](./guides/insert-update-guide.md#insert-many-rows-in-one-statement-insertbulk)
- the client's parameter limit in the chunks of `insertBulk`, `upsertBulk`, `bulkUpdate` and `mergeBulk` — a chunk is `floor(floor(65 535 ÷ keys of the first row) × 0.6)` rows and binds no more parameters than `client.maxParameters()` (PGlite: at most `floor(32 767 ÷ keys)` rows); a `chunkSize` is used as given; `insertBulk(…).toStatement()` compiles at most one chunk. (since 1.0.32) [guide](./guides/insert-update-guide.md#how-many-rows-one-statement-carries-chunks-within-the-clients-parameter-limit-since-1032)
- `db.<table>.insertFrom(subquery, src => values, { where?, with?, onConflictDoNothing?, expectedErrorCodes? })` — `INSERT … SELECT` from a `'table'` subquery (`with` since 1.0.22, `onConflictDoNothing` since 1.0.29). [guide](./guides/insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom)
- `db.<table>.upsertBulk(rows, config?)` — `INSERT … ON CONFLICT (key) DO UPDATE` arbitrated by a unique index; `config`: `primaryKey`, `updateColumns`, `updateColumnFilter`, `updateSet`, `updateWhere`, `targetWhere`, `setWhere`, `chunkSize`, `overridingSystemValue`, `referenceItem`. [guide](./guides/insert-update-guide.md#insert-or-update-by-a-unique-key-upsertbulk)
- `db.<table>.upsert(rows: InsertData<T>[], config?)` — `upsertBulk()` with rows typed without `sql` fragments; takes an array. [guide](./guides/insert-update-guide.md#insert-or-update-by-a-unique-key-upsertbulk)
- `db.<table>.mergeBulk(rows, { on, matchWhere?, updateColumns?, updateColumnFilter?, chunkSize?, referenceItem? })` — PostgreSQL `MERGE` (15+, `returning()` 17+) on an explicit identity without a unique index; one writer at a time. [guide](./guides/insert-update-guide.md#insert-or-update-without-a-unique-index-mergebulk)
- `db.<table>.values(rows): EntityInsertBuilder` — an explicit ON CONFLICT builder: `.onConflict(columns | { constraint })`, `.targetWhere(predicate)`, `.doNothing()`, `.doUpdate({ set?, updateColumns?, where? })`, `.execute()`; conflict columns are DB column names; without `.doUpdate()` it renders `ON CONFLICT DO NOTHING`, also when `.onConflict()` is not called; `execute()` resolves the rows of its `RETURNING` (every column). [guide](./guides/insert-update-guide.md#conflict-on-a-constraint-name-or-set-explicit-values-values)
- `q.update(data | row => data)` — after `where()`: one UPDATE of every matching row; a navigation in the WHERE renders `UPDATE … FROM`. [guide](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate)
- `db.<table>.update(data)` — every row of the table (`WHERE TRUE`). [guide](./guides/insert-update-guide.md#update-the-rows-that-match-a-condition-whereupdate)
- `db.<table>.bulkUpdate(rows, { primaryKey?, chunkSize?, set?, where? })` — `UPDATE … FROM (VALUES …)`: each row's own values by key; a column a row omits keeps its stored value. [guide](./guides/insert-update-guide.md#update-many-rows-each-with-its-own-values-bulkupdate)
- `q.delete()` — after `where()`: one DELETE; a navigation in the WHERE renders `DELETE … USING`. [guide](./guides/insert-update-guide.md#delete-rows-wheredelete)
- `db.<table>.delete()` — every row of the table (`WHERE TRUE`). [guide](./guides/insert-update-guide.md#delete-rows-wheredelete)
- `.returning()` / `.returning(row => S)` — the written rows in the same statement; a navigation or collection runs the write in a `"__mutation__"` CTE. [guide](./guides/insert-update-guide.md#read-back-what-a-write-changed-returningselector)
- `.returning((row, old) => S)` — on `update()` and `delete()`: `old.<column>` is the value before the write (PostgreSQL 18). [guide](./guides/insert-update-guide.md#read-the-row-as-it-was-before-the-update-old-postgresql-18)
- `.affectedCount(): PromiseLike<number>` — on `update()` and `delete()` only: the row count, no RETURNING. [guide](./guides/insert-update-guide.md#how-a-write-runs-lazy-builders-and-what-await-returns)
- `.toStatement(selector?): CompiledStatement` — compile without running, for `DbCteBuilder.withMutation()` (on `insert`, `insertBulk` and `insertFrom` since 1.0.22; on `update` and `delete`). [guide](./guides/insert-update-guide.md#feed-one-write-into-another-in-one-statement-data-modifying-ctes)
- `db.<parent>.insertWithChildren({ row, unlessExists?, children: { table, foreignKey, rows }, returning: { parent, children } })` — a parent and its children in one statement, the children receiving the new key; `children.rows` must be non-empty (a childless parent: `insert()`). [guide](./guides/insert-update-guide.md#insert-a-parent-and-its-children-in-one-statement-insertwithchildren)
- `db.<parent>.insertBulkWithChildren({ rows, children: { table, foreignKey, rows: [{ parentIndex, row }] }, returning: { parents, children } })` — N parents and their children in one statement; every parent needs at least one child. [guide](./guides/insert-update-guide.md#insert-a-parent-and-its-children-in-one-statement-insertwithchildren)
- `new MutationBatch()` — independent writes as one atomic statement of data-modifying CTEs; each `add*()` returns a `MutationBatchKey`, or `null` for empty input. [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `mb.addInsertBulk(table, rows, id, { onConflictDoNothing?, overridingSystemValue?, rowGuard?, returning?, ifFits? })` — an insert leg; `rowGuard` is a per-row WHERE and cannot be combined with `onConflictDoNothing` or `overridingSystemValue` (`returning` since 1.0.29). [guide](./guides/insert-update-guide.md#insert-only-the-rows-that-pass-a-per-row-check-rowguard)
- `mb.addBulkUpdate(table, rows, id, { primaryKey?, set?, where?, ifFits? })` — a `bulkUpdate()` leg. [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `mb.addUpsertBulk(table, rows, { primaryKey, updateColumns?, updateSet?, updateWhere?, targetWhere? }, id, { returning?, ifFits? })` — an upsert leg. [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `mb.addDeleteWhereIn(table, field, values, id, { ifFits? })` — a DELETE `WHERE field IN (…)` leg, one parameter per value (the options argument since 1.0.32). [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `mb.addUpdateWhereIn(table, field, values, set, id, { exposeColumns?, exposeOldColumns?, where?, ifFits? })` — an UPDATE `WHERE field IN (…)` leg setting constant values (or a function of the row); generic over the table's entity (since 1.0.32). [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `addUpdateWhereIn`'s `where: t => condition` — a guard over the target row (`"t"."<column>"`, values through the column mappers), ANDed into the leg's WHERE: `UPDATE … AS t SET … WHERE "col" IN (…) AND (<guard>)`; a subquery correlated to `t` is in scope, also over the same table; a navigation is refused; only the rows it lets through are counted and exposed. (since 1.0.32) [guide](./guides/insert-update-guide.md#update-a-key-list-only-where-a-guard-holds-addupdatewherein-with-where-since-1032)
- `{ ifFits: true }` on every leg but `addDependentInsert` — register the leg only when the statement can carry it (its rows within its own budget, its parameters with every earlier leg's within `maxParameters()`); otherwise return `null` and register nothing: write the input standalone. (since 1.0.32) [guide](./guides/insert-update-guide.md#register-a-leg-only-when-the-statement-can-carry-it-iffits-since-1032)
- `mb.addDependentInsert(table, row, { onLeg, whereColumn, whereNotEquals }, id)` — insert one row only when the parent leg's exposed column differs from a value; no `ifFits`. [guide](./guides/insert-update-guide.md#write-an-audit-row-only-when-a-value-really-changed-adddependentinsert)
- `mb.addInsertBulkWithChildren(table, { rows, children }, id, { parentReturning?, ifFits? })` — parents and children as one leg; childless parents allowed. [guide](./guides/insert-update-guide.md#insert-parents-and-children-as-a-leg-addinsertbulkwithchildren)
- `mb.executeBatch(): Promise<void>` — one statement; refuses more parameters than the client's `maxParameters()` before sending; no legs, no statement; one-shot. [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `mb.getAffectedCount(key | id)` / `mb.getLegRows(key | id)` — per-leg counts / RETURNING rows (raw JSON values), after `executeBatch()`. [guide](./guides/insert-update-guide.md#read-back-the-rows-an-insert-leg-wrote-returning-and-getlegrows)
- `mb.size` / `mb.parameterCount` — the registered legs / the parameters the statement binds (`parameterCount` since 1.0.29); to decide whether a leg fits, register it `ifFits` (the count misses the leg's own row budget). [guide](./guides/insert-update-guide.md#read-back-the-rows-an-insert-leg-wrote-returning-and-getlegrows)
- `` sql`nextval('seq')` `` as an `insertBulk()` cell or an `insertFrom()` value — one sequence draw per row inside the INSERT instead of one `nextValue()` round trip per row; an `insertBulk()` row is typed without fragments, so cast the cell (`` sql<number>`nextval('seq')` as unknown as number ``). [guide](./guides/insert-update-guide.md#number-many-rows-from-a-sequence-in-one-statement)

## Transactions and locks

- `db.transaction(async tx => …, { timeoutMs?, expectedExecutionMs? }): Promise<R>` — BEGIN … COMMIT (ROLLBACK when the callback throws) on one connection; use `tx.<table>` inside; `timeoutMs` runs `SET LOCAL statement_timeout` first. [guide](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction)
- `TransactionOptions` — `timeoutMs` (ms, `0` disables) and `expectedExecutionMs` (the slow-statement threshold, default `timeoutMs`). [guide](./guides/configuration.md#where-settings-live-and-which-value-wins)
- `tx.query('SAVEPOINT …')` / `tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')` — there is no nested `transaction()` and no isolation option; send them as SQL. [guide](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction)
- `tx.advisoryXactLock(key)` / `tx.advisoryXactLock(classId, key)` — wait for a transaction-scoped advisory lock (`pg_advisory_xact_lock`); outside a transaction it throws. [guide](./guides/insert-update-guide.md#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks)
- `tx.tryAdvisoryXactLock(key)` / `tx.tryAdvisoryXactLock(classId, key): Promise<boolean>` — take the lock when it is free. [guide](./guides/insert-update-guide.md#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks)
- `tx.advisoryXactLockAll(classId, keys)` — every key in one statement in a fixed order (no deadlock between overlapping sets); all integers or all strings. [guide](./guides/insert-update-guide.md#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks)
- `tx.tryAdvisoryXactLockAll(classId, keys): Promise<boolean>` — try every key in one statement without waiting, in `advisoryXactLockAll`'s order: `true` when the transaction holds them all, `false` at the first key another session holds (the keys tried before it stay held until the transaction ends; the rest are never tried); an empty list returns `true` and sends nothing; outside a transaction it throws. (since 1.0.31) [guide](./guides/insert-update-guide.md#try-many-keys-without-waiting-tryadvisoryxactlockall-since-1031)
- `forUpdate({ skipLocked?, noWait? })` — on select builders, including a select builder that is a CTE's body: `FOR UPDATE [SKIP LOCKED | NOWAIT]`; holds the lock only inside a transaction. A CTE-rooted query's `forUpdate()` (`db.selectFromCte(cte).select(…).forUpdate()`) throws since 1.0.33 (before, it locked nothing). [guide](./guides/insert-update-guide.md#lock-the-rows-you-read-before-writing-them-forupdate)
- `db.<table>.isInTransaction(): boolean` — whether the table belongs to a transaction's context (still `true` after that transaction ended). (since 1.0.30) [guide](./guides/cte-guide.md#run-cte-statements-on-a-tables-own-connection-tableselectfromcte)
- `client.isInTransaction()` / `client.transaction(query => …)` — the same check on a client / a driver-level transaction handing a raw query function. [guide](./database-clients.md#run-a-transaction)

## Schema model

### Entities, context model, views

- `abstract class DbEntity` — the base class of entity and view classes (`class User extends DbEntity`). [guide](./guides/schema-configuration.md#declare-an-entity-class-dbentity-and-dbcolumnt)
- `DbColumn<T>` — the type of a column property (`id!: DbColumn<number>`); `!` / `?` change typing only, NOT NULL comes from `isRequired()`, `notNull()` or `primaryKey()`; `isDbColumn(value)` is its guard. [guide](./guides/schema-configuration.md#declare-an-entity-class-dbentity-and-dbcolumnt)
- `model.entity(Entity, e => …)` — configure the table of an entity (`DbModelConfig.entity`); `e` is an `EntityConfigBuilder`, whose methods follow. [guide](./guides/schema-configuration.md#define-a-model-entity-classes-a-context-and-setupmodel)
- `model.view(View, v => …)` — a model-managed VIEW; `ViewConfigBuilder`: `toView(name)`, `toSchema(name)`, `definedAs(sql | db => query)`, `property(x => x.p).hasType(…)`. [guide](./guides/schema-configuration.md#expose-a-read-only-view-modelview)
- `model.useSearchNormalize()` — create `unaccent` and `public.search_normalize()` without an `ixNormalized()` index. [guide](./guides/schema-configuration.md#search-case--and-accent-insensitively-ixnormalized)
- `model.hasDbSetting(name, value)` — `ALTER DATABASE … SET` on `ensureCreated()` / `migrate()`; removing it never resets the value. [guide](./guides/schema-configuration.md#persist-a-database-setting-modelhasdbsetting)
- `e.toTable(name)` / `e.toSchema(name)` — table name and schema. [guide](./guides/schema-configuration.md#define-a-model-entity-classes-a-context-and-setupmodel)
- `e.isExternallyManaged()` — created only when missing; never compared or altered by `migrate()`. [guide](./guides/schema-configuration.md#map-a-table-another-system-owns-isexternallymanaged)
- `e.property(x => x.p).hasType(columnBuilder): EntityPropertyBuilder` — map a property to a column; the builder's first argument is the DB column name. [guide](./guides/schema-configuration.md#map-properties-to-columns-propertyhastype)
- `.isPrimaryKey()` / `.isRequired()` / `.isUnique()` — primary key, NOT NULL, UNIQUE (`isUnique()` takes no name). [guide](./guides/schema-configuration.md#map-properties-to-columns-propertyhastype)
- `.hasDefaultValue(value)` — the column DEFAULT; a string is raw SQL, so quote a text literal (`"'pending'"`). [guide](./guides/schema-configuration.md#set-column-defaults-hasdefaultvalue)
- `.generatedAlwaysAsIdentity({ startWith?, incrementBy? })` — `GENERATED ALWAYS AS IDENTITY` (also on `ColumnBuilder`). [guide](./guides/schema-configuration.md#generate-primary-keys-identity-columns)
- `.hasCustomMapper(mapper)` / `.hasCollation(collation)` — a value mapper (`createCustomType()`) / a collation (`pgCollation()`). [guide](./guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)
- `.hasColumnName(name)` — renames the column for indexes and keys while DDL and queries keep the builder's name; name the column in the builder instead. [guide](./guides/schema-configuration.md#map-properties-to-columns-propertyhastype)

### Relations

- `e.hasOne(x => x.nav, () => Target): HasOneNavigationBuilder` — a many-to-one or one-to-one navigation; creates the FOREIGN KEY. [guide](./guides/schema-configuration.md#many-to-one-and-one-to-many)
- `e.hasMany(x => x.items, () => Target): HasManyNavigationBuilder` — a one-to-many collection; creates no constraint. [guide](./guides/schema-configuration.md#many-to-one-and-one-to-many)
- `.withForeignKey(x => x.fk)` / `.withPrincipalKey(x => x.id)` — the key columns; a composite key is ONE selector returning an array (`x => [x.a, x.b]`), a constant part (`x => [x.id, true]`) filters the navigation. [guide](./guides/schema-configuration.md#composite-keys)
- `.isRequired()` — the navigation joins INNER; it adds no NOT NULL. [guide](./guides/schema-configuration.md#required-and-optional-navigations-isrequired)
- `.onDelete(action)` / `.onUpdate(action)` — `'cascade'`, `'restrict'`, `'no action'`, `'set null'` or `'set default'`. [guide](./guides/schema-configuration.md#many-to-one-and-one-to-many)
- `.hasDbName(name)` — the FOREIGN KEY constraint's name. [guide](./guides/schema-configuration.md#many-to-one-and-one-to-many)
- `.isInverseNavigation()` — no constraint from this side of a one-to-one. [guide](./guides/schema-configuration.md#one-to-one-in-both-directions-isinversenavigation)

### Indexes, statistics, constraints, partitions

- `e.hasIndex(name, x => [x.a, x.b]?): IndexBuilder` — `CREATE INDEX IF NOT EXISTS`, recreated by `migrate()` when its definition changes; foreign-key columns get no index by themselves. [guide](./guides/schema-configuration.md#index-what-your-queries-filter-join-and-sort-on-hasindex)
- `index.isUnique()` / `.using('btree' | 'gin' | 'gist' | 'hash' | 'brin' | 'spgist')` / `.withOperatorClass(name)` / `.where(rawSql)` / `.include(x => [...])` / `.nullsNotDistinct()` / `.concurrent()` / `.withExpression(...expressions)` — the `IndexBuilder` options (`withOperatorClass()` applies to every column). [guide](./guides/schema-configuration.md#index-what-your-queries-filter-join-and-sort-on-hasindex)
- `ixLower(col)` / `ixNormalized(col, { gin? })` / `ixUnaccent(col)` — expression-index column helpers; `ixUnaccent` fails on PostgreSQL (`unaccent()` is not IMMUTABLE), use `ixNormalized`. [guide](./guides/schema-configuration.md#index-an-expression-the-queries-use-withexpression-and-ixlower)
- `e.hasStatistics(name, sel?): StatisticsBuilder` → `.withExpression(...)`, `.withKinds('ndistinct' | 'dependencies' | 'mcv', …)` — `CREATE STATISTICS` plus `ANALYZE`. [guide](./guides/schema-configuration.md#improve-row-estimates-hasstatistics)
- `e.hasCheckConstraint(name, rawSql)` — a CHECK over quoted DB column names, reconciled by name. [guide](./guides/schema-configuration.md#enforce-row-rules-hascheckconstraint)
- `e.hasPartitioning({ strategy, columns } | { strategy, expression })` — a `PARTITION BY` parent table; partitions are yours to create. [guide](./guides/schema-configuration.md#partition-a-large-table-haspartitioning)

### Column types

Column builders are called inside `setupModel()` (`src/index.ts` marks them "for DbContext use only").
[guide](./guides/schema-configuration.md#pick-a-column-type)

| Builder | SQL type | Declared TS type |
|---|---|---|
| `smallint(name)`, `integer(name)`, `serial(name)` | `smallint`, `integer`, `serial` | `number` |
| `bigint(name)`, `bigserial(name)` | `bigint`, `bigserial` | `bigint`, but `PgClient`, `PostgresClient` and `PGliteClient` read a string |
| `decimal(name, precision?, scale?)`, `numeric(name, precision?, scale?)` | `decimal(p, s)`, `numeric(p, s)` | `number`, but `PgClient`, `PostgresClient` and `PGliteClient` read a string |
| `real(name)`, `doublePrecision(name)` | `real`, `double precision` | `number` |
| `varchar(name, length?)`, `char(name, length?)`, `text(name)` | `varchar(n)`, `char(n)`, `text` | `string` |
| `boolean(name)` | `boolean` | `boolean` |
| `timestamp(name)`, `timestamptz(name)`, `date(name)` | `timestamp`, `timestamptz`, `date` | `Date` |
| `time(name)`, `uuid(name)` | `time`, `uuid` | `string` |
| `json(name)`, `jsonb(name)` | `json`, `jsonb` | `any` |
| `bytea(name)` | `bytea` | `Buffer` |
| `enumColumn(name, pgEnum(…))` | the enum type | `string` (`pgEnum()` keeps no label type: declare the union on the property) |
| `new ColumnBuilder<T>(name, sqlType)` | any type (`inet`, `interval`, `vector(3)`) | `T` |

- `ColumnBuilder` methods — `notNull()`, `primaryKey()`, `unique()`, `default(value)`, `length(n)`, `precision(p, s?)`, `references(table, column = 'id')`, `autoIncrement()`, `generatedAlwaysAsIdentity(options?)`, `array()`, `mapWith(mapper)`, `hasTypescriptType<U>()`, `hasCollation(collation)`. [guide](./guides/schema-configuration.md#column-builder-methods)
- `TypeAliases` — `{ int: 'integer', float: 'double precision', datetime: 'timestamp', string: 'text', bool: 'boolean' }`, type names for `new ColumnBuilder()`. [guide](./guides/schema-configuration.md#name-any-other-sql-type-new-columnbuildertname-sqltype)

### Enums, collations, custom types

- `pgEnum(name, labels as const)` — a native ENUM type, registered process-wide when called: every schema manager creates every registered enum. [guide](./guides/schema-configuration.md#store-a-fixed-set-of-labels-pgenum-and-enumcolumn)
- `pgCollation({ name, provider, locale, deterministic })` — a collation for `hasCollation()`, registered process-wide. [guide](./guides/schema-configuration.md#compare-text-case--and-accent-insensitively-pgcollation)
- `createCustomType<{ data; driverData }>({ dataType: () => 'smallint', toDriver, fromDriver, immutable? })` — a column mapper for `hasCustomMapper()`; `immutable: true` shares mapped values within a result set. [guide](./guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)
- `customType({ dataType, toDriver, fromDriver })` / `jsonType<T>()` / `array<T>(itemType)` / `enumType(name, values)` / `point()` / `vector(dimensions)` / `interval()` — converters for expressions (`` sql`…`.mapWith(converter) ``), returning a `CustomTypeBuilder`; as a column mapper they throw `mapper.dataType is not a function`. [guide](./guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)
- `identityMapper` / `applyToDriver(mapper, value)` / `applyFromDriver(mapper, value)` / `applyFromDriverArray(mapper, values)` — apply a mapper by hand, for example to `db.query()` rows. [guide](./guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)

### Sequences

- `sequence(name): SequenceBuilder` → `.inSchema()`, `.startWith()`, `.incrementBy()`, `.minValue()`, `.maxValue()`, `.cache()`, `.cycle()`, `.build(): SequenceConfig`. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `protected sequence(config): DbSequence` in a getter, touched in `protected setupSequences()` — a model sequence the schema manager creates; `protected registerSequence(config)` registers one without an instance. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `seq.nextValue()` / `seq.nextValueBigInt()` — `nextval()`, 1 statement per value; `nextValue()` throws a RangeError beyond 2^53. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `seq.currentValue()` / `seq.currentValueBigInt()` / `seq.resync(value)` — `currval()` (per session) / `setval(…, value, true)`. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `seq.nextValueCreatingIfMissing()` / `seq.nextValueCreatingIfMissingBigInt()` — create the sequence on first use, then draw. [guide](./guides/schema-configuration.md#name-a-sequence-at-run-time-runtimesequence)
- `seq.getConfig()` / `seq.getQualifiedName()` — its configuration and quoted name. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `db.runtimeSequence(config): DbSequence` — a sequence named at run time, not registered, bound to the root client even on `tx`. [guide](./guides/schema-configuration.md#name-a-sequence-at-run-time-runtimesequence)

### Model introspection

- `db.<table>.getColumns({ includeNavigation? }): ColumnInfo<T>[]` / `.getColumnKeys({ includeNavigation?, includePrimaryKey? })` / `.props({ excludeNavigation? })` — model metadata without a statement. [guide](./guides/schema-configuration.md#inspect-the-model-at-run-time-getcolumns-getcolumnkeys-props)

## Migrations

- `db.getSchemaManager({ concurrentIndexes?, recreateChangedIndexes? }): DbSchemaManager` — create, migrate, analyze and drop the model's schema; `recreateChangedIndexes` defaults to `true`. [guide](./guides/migrations.md#configure-and-log-the-schema-manager-getschemamanager)
- `schemaManager.ensureCreated(): Promise<void>` — creates what is missing (`IF NOT EXISTS`) and, on a table that exists, adds missing indexes and CHECK constraints by name; never adds or changes a column of an existing table; re-creates every view. [guide](./guides/migrations.md#create-the-schema-of-an-empty-database-ensurecreated)
- `schemaManager.migrate(): Promise<void>` — apply the model's changes to an existing database (creates what is missing, alters changed columns, recreates changed indexes and views); never drops what the model no longer declares, never renames; throws `IndexRepairError` at the end when an INVALID-index repair failed. [guide](./guides/migrations.md#apply-model-changes-to-an-existing-database-migrate)
- `schemaManager.analyze(): Promise<MigrationOperation[]>` — the plan `migrate()` would run, changing nothing. [guide](./guides/migrations.md#preview-the-plan-without-changing-anything-analyze)
- `schemaManager.ensureDeleted(): Promise<void>` — drop the model's views, tables, sequences, every registered enum and every schema a table names with `toSchema()` (CASCADE; `toSchema('public')` drops `public`); throwaway databases only. [guide](./guides/migrations.md#drop-every-model-object-in-a-throwaway-database-ensuredeleted)
- `schemaManager.runPreMigrationHook()` / `schemaManager.ensureSearchNormalizeSupport()` / `schemaManager.close()` — run `onMigrationStart()` alone / create the `search_normalize` support / close the console prompt the manager may hold. [guide](./guides/migrations.md#configure-and-log-the-schema-manager-getschemamanager)
- `protected onMigrationStart(client)` / `protected onMigrationComplete(client)` — context hooks: first in `ensureCreated()`, `migrate()` and `MigrationRunner.up()` / after `ensureCreated()` and after a `migrate()` that ran at least one operation. [guide](./guides/migrations.md#run-sql-before-and-after-schema-work-onmigrationstart-and-onmigrationcomplete)
- `new MigrationRunner(db, { migrationsDirectory, journalTable?, journalSchema?, verbose?, logger?, appliedBy? })` — journaled migration files; journal `"public"."__migrations"` by default. [guide](./guides/migrations.md#version-schema-changes-in-migration-files-migrationrunner)
- `runner.up(): Promise<MigrationRunResult>` — run pending files, each in its own transaction (unless the file sets `transaction = false`); on a database without a journal it runs `migrate()` and records every file as baselined without running it (`runOnBaseline` files run). [guide](./guides/migrations.md#run-pending-files-up)
- `runner.down(count = 1)` / `runner.status()` / `runner.getPending()` / `runner.getApplied()` / `runner.getLoader()` / `runner.getJournal()` — revert, report, list `LoadedMigration`s, reach the loader and the journal. [guide](./guides/migrations.md#revert-the-newest-files-down)
- `interface Migration` — a file's default export: `up(db)`, `down(db)`, `runOnBaseline?` (default `false`), `transaction?` (default `true`). [guide](./guides/migrations.md#write-a-migration-file)
- `new MigrationJournal(client, { journalTable?, journalSchema?, appliedBy? })` → `tableExists()`, `ensureTable()`, `getApplied()`, `isApplied(file)`, `recordApplied(file, baselined = false)`, `recordReverted(file)`, `getQualifiedName()`, `getTableName()`, `getSchemaName()`. [guide](./guides/migrations.md#read-or-repair-the-journal-migrationjournal)
- `new MigrationLoader(directory)` → `getMigrationFiles()`, `loadMigration(file)`, `loadAllMigrations()`, `generateFilename()` (`YYYYMMDD-HHMMSS.ts`, local time), `getAbsoluteDirectory()`, `ensureDirectory()`; loads `.ts` files only. [guide](./guides/migrations.md#find-and-name-files-migrationloader)
- `new MigrationScaffold(db, config)` → `scaffold(contextImportPath?)` / `scaffoldEmpty(contextImportPath?)` — draft a migration file from `analyze()`; review it before use. [guide](./guides/migrations.md#draft-a-migration-file-from-the-model-diff-migrationscaffold)

## Clients and connections

- `new PgClient(config: PoolConfig | pg.Pool)` — node-postgres; ignores `withTimeout()` and `preparedStatements`; `getPool()` returns the pool. [guide](./database-clients.md#pgclient-node-postgres)
- `new PostgresClient(url | PostgresOptions | sql)` — postgres.js; honors `withTimeout()` (`QueryTimeoutError`) and named prepared statements; `getSql()` returns the `sql` instance; `begin()` is deprecated and not guarded. [guide](./database-clients.md#postgresclient-postgresjs)
- `new BunClient(url | BunSqlOptions | Bun.SQL)` — Bun.SQL, Bun runtime only; `prepare: false` decodes native arrays (text results), `datesAsStrings`; `getSql()`. [guide](./database-clients.md#bunclient-bunsql)
- `new PGliteClient(dataDir? | PGliteClientOptions | PGlite)` — PostgreSQL in WASM, in process, one session; 32 767 parameters per statement; `getPGlite()`. [guide](./database-clients.md#pgliteclient-pglite)
- `client.query<T>(sql, params?, { timeoutMs?, prepare? }): Promise<ClientQueryResult<T>>` — a driver-level statement (`{ rows, rowCount }`); the options are honored by `PostgresClient` only. [guide](./database-clients.md#run-raw-sql)
- `client.querySimple(sql)` / `client.querySimpleMulti(sql)` — several statements in one round trip over the simple protocol, no parameters; on `PostgresClient`, `BunClient` and `PGliteClient`, not `PgClient`. [guide](./database-clients.md#several-statements-in-one-round-trip-querysimple-and-querysimplemulti)
- `client.connect(): Promise<PooledConnection>` → `conn.query(…)`, `conn.release()` — pin one session (temp tables, SET); release it in `finally`; throws inside a transaction. [guide](./database-clients.md#pin-one-session-for-several-statements-connect-and-release)
- `client.end(): Promise<void>` — close the pool the client created; a pool, `sql` instance or PGlite you passed in stays open. [guide](./database-clients.md#manage-the-client-lifecycle)
- `client.getDriverName()` — `'pg'`, `'postgres'`, `'bun'` or `'pglite'`. [guide](./database-clients.md#what-each-client-supports)
- `client.supportsMultiStatementQueries()` / `.supportsBinaryProtocol()` / `.supportsBinaryArrayResults()` / `.losesNumericZeroScale()` / `.maxParameters()` — capability flags the builders read (`maxParameters()` since 1.0.29: 65 535, PGlite 32 767; `MutationBatch` holds its statement to it, and since 1.0.32 its `ifFits` legs and the chunks of the bulk writes too). [guide](./database-clients.md#what-each-client-supports)
- `client.parseTypedText(oid, text, read?)` / `.customParsedTypeOids()` — how a `QueryBatch` revives values sent as text; override them in a custom client. [guide](./database-clients.md#write-a-custom-client)
- `abstract class DatabaseClient` — implement `query`, `connect`, `end`, `getDriverName` and `transaction` for another driver. [guide](./database-clients.md#write-a-custom-client)

### In-memory database

- `createInMemoryDatabase({ databaseName?, userName?, timeZone?, collation?, settings? }): InMemoryDatabase` — a PostgreSQL-compatible engine in the process, reached through the real `pg` / `postgres` drivers. [guide](./guides/in-memory-database.md#start-a-database-and-connect-a-context)
- `memory.pgPoolConfig(config?)` / `memory.postgresOptions(options?)` / `memory.createPgPool()` / `memory.createPostgresSql()` / `memory.createSocket()` — connect `new PgClient(…)` or postgres.js to it. [guide](./guides/in-memory-database.md#connection-helpers)
- `memory.snapshot(): Buffer` / `restoreInMemoryDatabase(snapshot, options?)` / `memory.fork(options?)` — start each test from a committed state. [guide](./guides/in-memory-database.md#start-every-test-from-a-seeded-state-snapshot-restoreinmemorydatabase-fork)
- `memory.listen({ port?, host? }): Promise<InMemoryDatabaseListener>` → `connectionString(database?)`, `close()` — serve it over TCP (for `BunClient`, `psql`, other processes). [guide](./guides/in-memory-database.md#serve-other-processes-over-tcp-listen)
- `memory.close()` — close all sessions. [guide](./guides/in-memory-database.md#start-a-database-and-connect-a-context)
- an aggregate that reads only an outer query's columns (`agg.sum(u.age)` in a scalar subquery over `posts`, `u.posts!.sum(_p => u.orders!.count())`) — PostgreSQL evaluates it in the outer query (42803, or one row); the engine refuses it with `0A000` (since 1.0.31). [guide](./guides/in-memory-database.md#aggregates-that-read-only-an-outer-querys-columns-refused-since-1031)
- `startInMemoryDatabaseThread({ snapshot?, snapshotPath?, database?, listen?, databasePerName? }): InMemoryDatabaseThread` → `listener`, `pgPoolConfig()`, `postgresOptions()`, `createSocket()`, `snapshot(database?)`, `stats()`, `terminate()` — the engine in a worker thread. [guide](./guides/in-memory-database.md#run-the-database-in-a-worker-thread-startinmemorydatabasethread)

## Configuration and diagnostics

### Context options: `QueryOptions`

The second constructor argument. An "executor duty" is one of `logQueries`, `logFailedQueries`,
`logExecutionTime`, `onQueryTakingTooLong`, `preparedStatements` and, since 1.0.33, `disableMappers`, `rawResult`,
`traceTime`, `useBinaryProtocol`: each creates the executor. Before 1.0.33 the last four did not, and
`disableMappers`, `rawResult` and `traceTime` took effect only next to one of the first five. [guide](./guides/configuration.md#configure-a-context-queryoptions)

| Key | Default | Effect |
|---|---|---|
| `logQueries` | `false` | log every statement the executor sends (section `'sql'`), a `prepare()`d query's executions included since 1.0.33; `db.query()` and `FutureQueryRunner`'s multi-statement message bypass the executor |
| `logParameters` | `false` | add the parameters to the logged statements and failures |
| `logExecutionTime` | `false` | log each statement's duration (section `'timing'`) |
| `logFailedQueries` | the value of `logQueries` | log failed statements (section `'error'`) |
| `logger` | `defaultLogger` | `(message, section?: LogSection) => void` |
| `onQueryTakingTooLong` | unset | `(info: SlowQueryInfo) => void` after a statement ran longer than its threshold; never cancels |
| `longRunningQueryThreshold` | `10000` ms | the slow-statement threshold |
| `slowQueryStackTraceLimit` | `50` frames | the stack captured per statement while the callback is set; `0` captures none |
| `preparedStatements` | `false` | send statements named on the server (`PostgresClient` only) |
| `collectionStrategy` | `'lateral'` | `'lateral'`, `'cte'` or `'temptable'` |
| `inArrayOptThreshold` | `8` | writes `LinkgressConfig.inArrayOptThreshold` for the whole process at construction |
| `inArrayPadBuckets` | `null` | writes `LinkgressConfig.inArrayPadBuckets` for the whole process |
| `inArrayUsesOpt` | `false` | writes `LinkgressConfig.inArrayUsesOpt` for the whole process |
| `disableMappers` | `false` | builder reads and (since 1.0.33) a table's own reads skip `fromDriver` (bound values still go through `toDriver`); on its own since 1.0.33 |
| `rawResult` | `false` | builder terminals and (since 1.0.33) a table's own reads return the driver's rows; on its own since 1.0.33 |
| `traceTime` | `false` | per-phase timing (section `'timing'`); on its own since 1.0.33 |
| `useBinaryProtocol` | `false` | no effect: no shipped client has a binary protocol (since 1.0.33 it creates the executor) |

### Per table and per query

- `db.<table>.withQueryOptions(options): DbEntityTable<T>` — a derived table with `options` merged over the context's; tables only; call it before the other overrides. [guide](./guides/configuration.md#override-options-for-one-table-or-query)
- `withTimeout(ms)` — `SET LOCAL statement_timeout` around the statement on `PostgresClient` (+3 statements; `0` lifts the connection default); ignored by `PgClient`, `BunClient` and `PGliteClient`. [guide](./guides/configuration.md#cancel-statements-that-run-too-long-withtimeout-and-statement_timeout)
- `withPreparedStatements(bool)` — run as a named (`true`) or unnamed (`false`) statement; on tables, queries, select builders and `QueryBatch`. [guide](./guides/configuration.md#opt-one-query-in-or-out-withpreparedstatements)
- `expectedExecutionTime(ms)` — this query's slow-statement threshold; never cancels. [guide](./guides/configuration.md#get-notified-about-slow-statements-onquerytakingtoolong)

### Process-wide settings

- `LinkgressConfig.inArrayOptThreshold` (default `8`) — the list length up to which `inArrayOpt()` renders `IN (…)`; `0` sends every list to the array form; an invalid value throws. [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `LinkgressConfig.inArrayPadBuckets` (default `null`) — opt-in widths a shorter list is padded to by repeating its last element (`[1, 2, 8]`). [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `LinkgressConfig.inArrayUsesOpt` (default `false`) — plain `inArray()` / `notInArray()` render as `inArrayOpt()` does. [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `LinkgressConfig.configure(settings: LinkgressSettings)` / `LinkgressConfig.resetToDefaults()` — several settings at once / back to the defaults (tests). [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD` (`8`) / `LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS` (`[1, 4, 8]`, applied only when you set it). [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `MockRowCache.setEnabled(true)` — memoize query building (the one switch for `MockRowCache`, `NavigationPathCache` and `LateralSqlCache`); identical SQL; off by default. [guide](./guides/configuration.md#cut-query-build-cpu-mockrowcache)
- `MockRowCache.isEnabled()` / `.diagnostics()` / `.reset()` (also switches it off) · `NavigationPathCache.diagnostics()` / `.reset()` · `LateralSqlCache.isEnabled()` / `.diagnostics()` / `.reset()`. [guide](./guides/configuration.md#cut-query-build-cpu-mockrowcache)

### See the SQL

- `q.future().getSql()` / `q.future().getParams()` — the text and values of a select, join, grouped select or union; nothing is sent. [guide](./guides/configuration.md#see-the-sql-a-query-sends)
- `toSql()` — on unions, CTE-rooted and set queries; select builders have none. [guide](./guides/configuration.md#see-the-sql-a-query-sends)
- `.toStatement(selector?)` / `prepared.getSql()` / `fragment.toString()` — a write's `{ sql, params }`, a prepared query's text, a fragment's text. [guide](./guides/configuration.md#see-the-sql-a-query-sends)
- `SlowQueryInfo` — `{ sql, params?, durationMs, thresholdMs, stack }`, what `onQueryTakingTooLong` receives. [guide](./guides/configuration.md#get-notified-about-slow-statements-onquerytakingtoolong)
- `LogSection` — `'sql'`, `'params'`, `'timing'`, `'slow'`, `'info'`, `'warn'`, `'error'` (nothing logs on `'slow'`). [guide](./guides/configuration.md#route-log-lines-logger-and-logsection)

## Errors

- `QueryTimeoutError` (`timeoutMs`, `sql`, `cause`) — a statement cancelled by a timeout on `PostgresClient`; `PgClient` and `BunClient` raise the driver's own error (SQLSTATE `57014`). [guide](./guides/configuration.md#cancel-statements-that-run-too-long-withtimeout-and-statement_timeout)
- `TransactionEndedError` (`sql`) — a statement from an object of an ended transaction (a kept `tx`, its tables, futures, prepared queries); never sent. [guide](./guides/insert-update-guide.md#make-several-statements-atomic-dbtransaction)
- `ConnectionReleasedError` (`sql`) — a statement on a `PooledConnection` after `release()`; never sent. [guide](./database-clients.md#pin-one-session-for-several-statements-connect-and-release)
- `IndexRepairError` (`failures`, `indexName`, `tableName`, `schema`, `code`, `cause`) — `migrate()` could not repair an INVALID index; the rest of the migration ran. [guide](./guides/migrations.md#repair-invalid-indexes-indexrepairerror)

Messages of plain `Error`s, as thrown:

| Message starts with | Thrown by | Do instead |
|---|---|---|
| `Sequence contains no elements` | `db.<table>.first()` on an empty table | `firstOrDefault()` |
| `No results found` | `firstOrThrow()` when no row matches, or a one-value projection's first value is falsy | `firstOrDefault()` when a missing row is normal (and for one-value projections) |
| `Missing parameter: <name>` | `PreparedQuery.execute()` | pass every `sql.placeholder()` name |
| `Cannot use <operator> operator with undefined value on field <f>` | `gt()`, `gte()`, `lt()`, `lte()`, `like()` and the other non-equality operators with `undefined` | leave the condition out when the value is unset |
| `Alias is required when joining a subquery` | `innerJoin()` / `leftJoin()` of a subquery | pass the alias as the 4th argument |
| `forUpdate: skipLocked and noWait are mutually exclusive` | `forUpdate({ skipLocked: true, noWait: true })` | one of the two |
| `forUpdate() on a CTE-rooted query locks no rows` | `db.selectFromCte(…).forUpdate()` (since 1.0.33) | `.forUpdate()` on the builder that forms the CTE body: `new DbCteBuilder().with('x', db.<table>.where(…).select(…).forUpdate())` |
| `Nested transactions are not supported` | `tx.transaction()` | `tx.query('SAVEPOINT …')` |
| `Cannot get a new connection while in a transaction` | `tx.getClient().connect()` | the transaction's own statements |
| `QueryBatch: query "<id>" uses a different database client or transaction than the rest of the batch` | `QueryBatch.executeBatch()` | build every leg from one context (or one derived table) |
| `FutureQueryRunner: future #<i> uses a different database client or transaction` | `FutureQueryRunner.runAsync()` | futures of one context |
| `QueryBatch results are not available — call executeBatch() first` | `getList()` / `getItem()` / `getCount()` before execution | `await batch.executeBatch()` first |
| `QueryBatch is empty — register queries before executing` | `QueryBatch.executeBatch()` with no leg | skip the call (a `MutationBatch` with no leg sends nothing) |
| `A selection is required. Call .select(...) before` | `toList()`, `first()`, `toSql()` or `asSubquery()` of a CTE-rooted query without `select()` | `db.selectFromCte(cte).select(r => ({ … }))` first |
| `MutationBatch: the statement binds <n> parameters — over` | `MutationBatch.executeBatch()` | register the legs whose size depends on the data `ifFits` (since 1.0.32) and write a declined one standalone, or move some legs to a second batch |
| `MutationBatch: leg "<id>" carries <n> rows, above the ~<m>-row single statement budget` | an `add*()` leg over its own row budget | write it standalone (it is chunked), or register it `ifFits` (since 1.0.32) |
| `toStatement(): <n> rows exceed the <m>-row chunk of one insert into` | `insertBulk(…).toStatement()` over one chunk (on PGlite 8 191 rows of 4 keys) | compile the rows in batches, or `insertFrom(fromRows(…))` |
| `PGliteClient: the statement binds <n> parameters — PGlite takes at most 32 767` | any statement over 32 767 parameters on PGlite (an explicit `chunkSize`, a long `inArray()`) | leave `chunkSize` out (the default chunk fits the client since 1.0.32); bind a list as one array (`eqAny()`) |
| `addUpdateWhereIn where: navigation "<nav>" is not available` | a navigation in `addUpdateWhereIn`'s `where` | the target row's own columns, or a subquery correlated to them |
| `Cannot update "<view>": it is a model-managed view (read-only)` (or `Cannot delete from`) | a write on a `DbViewTable` query | write to the underlying tables |
| `Aggregation selector must return a field reference` | `select.sum()` / `min()` / `max()` over an expression | `agg.sum(expression)` in a `select()` |
| `buildSql() on CollectionQueryBuilder is only supported for EXISTS and COUNT aggregations` | a collection's `sum()` / `min()` / `max()` in `where()` or `orderBy()` | `exists(collection.where(…))`, or a grouped subquery |
| `The collection "<name>" of the joined table "<alias>" needs the 'lateral'` | a collection of a manually joined table under `cte` / `temptable` | `withQueryOptions({ collectionStrategy: 'lateral' })` |
| `No valid columns to update` | `update()` with no column key | pass at least one column |
| `Fully optimized mode requires querySimpleMulti support` | the `temptable` strategy inside `db.transaction()` on `PostgresClient`, `BunClient`, `PGliteClient`, for a query that binds no parameter and projects plain collection lists | `lateral` or `cte` in transactions |

## Types

Exported types; import them with `import type { … } from 'linkgress-orm'`.

- `Condition` — what `where()` and the operators take and return. [guide](./guides/querying.md#condition-functions)
- `ConditionOperator` — `'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'notIn' | 'isNull' | 'isNotNull' | 'between'`. [guide](./guides/querying.md#condition-functions)
- `FieldRef<Name, V>` — a column reference inside a selector. [guide](./guides/querying.md#filter-rows-where)
- `PgCastType` — the type names `cast()`, `literal()`, `param()` and `withReadType()` accept (any validated type name). [guide](./guides/sql-expressions.md#cast-a-value-cast-castas)
- `SqlOperand<V>` / `OperandValue<T>` — what a helper takes as an operand / the value an operand yields. [guide](./guides/sql-expressions.md#combine-helpers-each-renders-one-operand)
- `LiteralValue` — `string | number | bigint | boolean | null`, what `literal()` takes. [guide](./guides/sql-expressions.md#write-constants-parameters-and-typed-nulls-literal-param-typednull)
- `DateTruncUnit` / `DatePartField` / `IntervalSpec` — the units of `dateTrunc()`, the fields of `datePart()`, the spec of `toInterval()`. [guide](./guides/sql-expressions.md#work-with-dates-times-and-intervals)
- `JsonbPathKey` / `JsonbElement<T>` — a `jsonbPath()` key (string, number, fragment, placeholder) / a `jsonbArraySome()` element. [guide](./guides/sql-expressions.md#read-filter-build-and-change-jsonb)
- `AggListOptions` / `AggOrderKey` / `AggregateFunctions` — the options and order keys of the `agg` list aggregates / the type of `agg`. [guide](./guides/sql-expressions.md#aggregate-inside-an-expression-agg)
- `WindowOptions` / `WindowFunctions` — the argument of `over()` / the type of `win`. (since 1.0.21) [guide](./guides/sql-expressions.md#number-and-rank-rows-win-since-1021)
- `GroupedItem<K, Row>` — the group a grouped `select()` receives. [guide](./guides/querying.md#aggregates-per-group)
- `GroupedListAggregateOptions<Row>` / `GroupedAggregateOrderKey<Row>` — the options of `g.arrayAgg()` (`distinct`, `orderBy`) / one of its order keys (a selector, or `[selector, 'ASC' | 'DESC']`). (since 1.0.31) [guide](./guides/querying.md#list-a-groups-members-and-count-distinct-values-garrayagg-gcountdistinct)
- `ScalarSubqueryOperand<V>` / `SubqueryFieldRef` / `SubqueryResult<S>` / `SubqueryMode<S>` / `CollectionSubquerySource` — subquery operands, refs, result and mode of a `Subquery`, and what `exists()` accepts besides a subquery. [guide](./guides/subquery-guide.md#api-signatures)
- `AliasedScopeOrderKey` — `[key, 'ASC' | 'DESC']` for `scope.orderBy()`. [guide](./guides/aliased-scopes.md#read-the-top-value-per-row-orderby--limit1--scalar)
- `CteTableRef<C>` / `InferCteColumns<Cte>` / `CteColumnRefs<C>` / `CteJoinType` — `cte.as()`'s reference, a CTE's column type, a CTE row in a condition, `'INNER' | 'LEFT' | 'RIGHT' | 'FULL OUTER' | 'CROSS'`. [guide](./guides/cte-guide.md#type-cte-columns)
- `CompiledStatement<Row>` — `{ sql, params }` from `.toStatement()`, typed by its RETURNING. [guide](./guides/cte-guide.md#write-and-read-back-in-one-statement-withmutation)
- `SetRow<Row>` — the row of a set source. [guide](./guides/set-returning-functions.md#how-set-columns-read-back)
- `UnionType` — `'UNION' | 'UNION ALL'`. [guide](./guides/querying.md#combine-result-sets-union-unionall)
- `AnyFutureQuery` / `FutureQueryResult<F>` / `FutureQueryResults<F[]>` — future types and the tuple `runAsync()` resolves. [guide](./guides/batching-and-prepared-queries.md#run-several-futures-together-futurequeryrunnerrunasync)
- `BatchListKey<T>` / `BatchItemKey<T>` / `BatchCountKey` / `BatchListSource<T>` / `BatchItemSource<T>` / `BatchCountSource` — `QueryBatch` keys and what each `add*()` accepts. [guide](./guides/batching-and-prepared-queries.md#read-a-batchs-results-keys-ids-and-getters)
- `MutationBatchKey` / `UpsertLegConfig` / `BulkUpdateLegConfig` / `InsertLegOptions` / `RowGuard` / `ArbiterPredicate` — `MutationBatch` keys, leg configurations, a row guard and an arbiter predicate. [guide](./guides/insert-update-guide.md#run-independent-writes-in-one-round-trip-mutationbatch)
- `LegFitOptions` / `UpdateWhereInLegOptions<TEntity>` — `{ ifFits? }`, which `InsertLegOptions`, `BulkUpdateLegConfig` and `UpdateWhereInLegOptions` extend / the options of `addUpdateWhereIn()`: `exposeColumns`, `exposeOldColumns`, `where`, `ifFits`. (since 1.0.32) [guide](./guides/insert-update-guide.md#register-a-leg-only-when-the-statement-can-carry-it-iffits-since-1032)
- `QueryOptions` / `TransactionOptions` / `SlowQueryInfo` / `LogSection` — context options, transaction options, the slow-statement notice, the log section. [guide](./guides/configuration.md#configure-a-context-queryoptions)
- `CollectionStrategyType` (also exported as `CollectionStrategy`) — `'cte' | 'temptable' | 'lateral'`. [guide](./collection-strategies.md#reference-options-types-and-exports)
- `TimeTraceEntry` / `QueryTimeTrace` — the data of a `traceTime` trace. [guide](./guides/configuration.md#read-raw-driver-values-or-time-one-query)
- `AdvisoryLockKey` — `number | bigint | string`, an advisory lock key. [guide](./guides/insert-update-guide.md#serialize-check-then-write-on-a-key-that-is-not-a-row-advisory-locks)
- `LinkgressSettings` — what `LinkgressConfig.configure()` takes. [guide](./guides/configuration.md#bound-the-statement-texts-of-list-filters-linkgressconfig)
- `EntityQuery<T>` / `IEntityQueryable<T>` / `EntitySelectQueryBuilder<T, S>` / `EntityCollectionQuery<T>` — a row in a selector, a query, a select builder, a collection. [guide](./guides/querying.md#choose-the-call-that-returns-what-you-need)
- `LateralNavigation<N>` — what a `lateralJoin()` selector may return (a reference navigation). (since 1.0.28) [guide](./guides/lateral-navigation-joins.md#know-what-lateraljoin-refuses)
- `OrderDirection` / `OrderByTuple<T>` / `OrderByResult<T>` — sort directions and what an `orderBy()` selector returns. [guide](./guides/querying.md#order-results-orderby)
- `DbViewTable<T>` — a view accessor. [guide](./guides/schema-configuration.md#expose-a-read-only-view-modelview)
- `ColumnInfo<T>` — an entry of `getColumns()`. [guide](./guides/schema-configuration.md#inspect-the-model-at-run-time-getcolumns-getcolumnkeys-props)
- `UnwrapDbColumns<T>` / `ExtractDbColumns<T>` / `ExtractDbColumnKeys<T>` / `ColumnRow<T>` — an entity's plain row, its column properties, their names, its column refs. [guide](./guides/schema-configuration.md#declare-an-entity-class-dbentity-and-dbcolumnt)
- `InsertData<T>` / `UpdateData<T>` / `UpsertData<T>` — write row types (`InsertData` is `Partial`: a missing NOT NULL column fails only at run time). [guide](./guides/insert-update-guide.md#what-the-typings-check)
- `EntityUpsertConfig<T>` / `EntityMergeConfig<T>` / `BulkUpdateExpressionConfig<T>` / `FluentMerge<T>` — the configurations of `upsertBulk()`, `mergeBulk()`, `bulkUpdate()` and the builder `mergeBulk()` returns. [guide](./guides/insert-update-guide.md#choose-a-write)
- `InsertFromSourceRow<S>` / `InsertFromValues<T>` / `InsertFromOptions<S>` / `StatementExecutionOptions` — the source row, the values and the options of `insertFrom()`; `expectedErrorCodes`. [guide](./guides/insert-update-guide.md#insert-rows-computed-from-the-database-insertfrom)
- `EntityConstructor<T>` — `new () => T`, an entity class. [guide](./guides/schema-configuration.md#declare-an-entity-class-dbentity-and-dbcolumnt)
- `IndexMethod` / `IndexExpression<T>` / `StatisticsMetadata` / `StatisticsDefinition` — index methods, index and statistics expressions, statistics metadata. [guide](./guides/schema-configuration.md#index-what-your-queries-filter-join-and-sort-on-hasindex)
- `PartitionStrategy` / `PartitioningConfig` — `'range' | 'list' | 'hash'` and a partitioning declaration. [guide](./guides/schema-configuration.md#partition-a-large-table-haspartitioning)
- `TableViewDefinition` / `ViewQueryRow<V>` / `ViewQuerySource<R>` — a view's definition and the row a query-defined view must project. [guide](./guides/schema-configuration.md#expose-a-read-only-view-modelview)
- `IdentityOptions` — `{ name?, startWith?, incrementBy? }` (`name` is never emitted). [guide](./guides/schema-configuration.md#generate-primary-keys-identity-columns)
- `EnumTypeDefinition` / `EnumValues<E>` / `CollationDefinition` — an enum (`{ name, values: string[] }`), `E['values'][number]` (`string` for what `pgEnum()` returns, not a label union), a collation. [guide](./guides/schema-configuration.md#store-a-fixed-set-of-labels-pgenum-and-enumcolumn)
- `ColumnType` / `TypeScriptType<C>` / `TypeAlias` — SQL type names, their TS types, the keys of `TypeAliases`. [guide](./guides/schema-configuration.md#pick-a-column-type)
- `TypeMapper<Data, Driver>` / `CustomTypeDefinition<Data, Driver>` / `CustomType<Data, Driver>` / `Point` / `Interval` — a column mapper, its definition, an expression converter, the values of `point()` and `interval()`. [guide](./guides/schema-configuration.md#convert-column-values-createcustomtype-and-hascustommapper)
- `SequenceConfig` — a sequence's name, schema and options. [guide](./guides/schema-configuration.md#number-documents-model-sequences-and-runtimesequence)
- `Migration` / `MigrationConfig` / `MigrationJournalEntry` / `LoadedMigration` / `MigrationRunResult` / `MigrationDirection` — the migration-file contract, the runner's options, a journal row, a loaded file, the result of `up()` / `down()`, `'up' | 'down'`. [guide](./guides/migrations.md#version-schema-changes-in-migration-files-migrationrunner)
- `MigrationOperation` / `IndexRepairFailure` — an entry of `analyze()` / of `IndexRepairError.failures`. [guide](./guides/migrations.md#migration-operations-reference)
- `PooledConnection` / `ClientQueryResult<T>` / `QueryExecutionOptions` / `TypedTextRead` — a leased session, `{ rows, rowCount }`, `{ timeoutMs?, prepare?, useBinaryProtocol? }`, a typed-text read hint. [guide](./database-clients.md#run-raw-sql)
- `PoolConfig` / `PostgresOptions` / `BunSqlOptions` / `PGliteClientOptions` — client constructor options. [guide](./installation.md#construct-the-client)
- `InMemoryDatabase` / `InMemoryDatabaseOptions` / `InMemoryDatabaseListener` / `InMemoryListenOptions` / `InMemoryDatabaseThread` / `InMemoryDatabaseThreadOptions` — the in-memory database types (`InMemoryDatabase` is a type only: create one with `createInMemoryDatabase()`). [guide](./guides/in-memory-database.md#connection-helpers)

## Internal: do not call

`src/index.ts` marks two groups: the column builders, "exported for DbContext use only", which means inside
`setupModel()` (they are listed under [Column types](#column-types)); and `defaultLogger` and `TimeTracer`,
"for library use only". The other entries below are exported for the library's own modules or tests, or are
legacy.

- `TimeTracer` — the timer `traceTime` runs; read the trace through `traceTime` and a `logger` instead. [guide](./guides/configuration.md#read-raw-driver-values-or-time-one-query)
- `defaultLogger(message, section?)` — the logger a context uses when `QueryOptions.logger` is unset (`'error'` → `console.error`, `'warn'` → `console.warn`, else `console.log`); a custom logger may delegate to it, nothing requires a call. [guide](./guides/configuration.md#route-log-lines-logger-and-logsection)
- `ConditionBuilder` — renders a `Condition` into `{ sql, params }` for the builders. [guide](./guides/querying.md#see-the-sql-a-query-sends)
- `CollectionStrategyFactory` and the types `ICollectionStrategy`, `CollectionAggregationConfig`, `CollectionAggregationResult` — strategy internals; select a strategy with `collectionStrategy`. [guide](./collection-strategies.md#internals-for-contributors)
- `JoinQueryBuilder` and the types `JoinType`, `JoinDefinition` — a legacy two-table builder no public method returns; its `leftJoin()` / `innerJoin()` throw; use `db.<table>.innerJoin()`. [guide](./guides/querying.md#join-tables-without-a-navigation-innerjoin-leftjoin)
- `EnumMigrator` — a standalone enum sync whose label-removal path fails on PostgreSQL; `migrate()` appends enum labels. [guide](./guides/migrations.md#add-enum-labels-migrate-not-enummigrator)
- `EntityMetadataStore` / `EnumTypeRegistry` / `CollationRegistry` — process-wide registries the model and the schema manager read; changing them changes every context. [guide](./guides/schema-configuration.md#inspect-the-model-at-run-time-getcolumns-getcolumnkeys-props)
- `EntityNavigationBuilder` — deprecated; `hasOne()` / `hasMany()` return `HasOneNavigationBuilder` / `HasManyNavigationBuilder`. [guide](./guides/schema-configuration.md#link-tables-hasone-and-hasmany)
- `QueryBuilder` / `SelectQueryBuilder` (constructors) — the untyped classes: every query a table starts (`where()`, `select()`, `orderBy()`, joins, …) is a `SelectQueryBuilder` instance typed as `IEntityQueryable` / `EntitySelectQueryBuilder`; `QueryBuilder` is what the untyped `db.getTable(name).where()` returns. Get builders from a table. [guide](./guides/querying.md#choose-the-call-that-returns-what-you-need)
- `LoggingOptions` / `LogLevel` — deprecated aliases of `QueryOptions` / `LogSection`. [guide](./guides/configuration.md#route-log-lines-logger-and-logsection)
- `db.getTable(name)` — the untyped, name-keyed accessor of the base `DataContext`; a `DbContext` exposes typed getters. [guide](./guides/schema-configuration.md#declare-the-context-dbcontext-table-getters-and-setupmodel)
- Methods with a leading `_` (`_getSchema()`, `_buildInsertBulkStatement()`, …), those marked `@internal` in `src/` (`buildUnionSql()`, `buildCteQuery()`, `CteRootQueryBuilder.buildQuery()`, `SetQueryBuilder.buildStatement()`, `getSequenceRegistry()`, `DbCte.columnRef()`, `DatabaseClient.typedTextParser()`) and the cache primitives the builders call (`MockRowCache.getOrBuild()`, `NavigationPathCache.getOrBuild()`, `LateralSqlCache.get()` / `.store()`) — library plumbing; for a statement's text use [See the SQL](#see-the-sql). [guide](./guides/configuration.md#see-the-sql-a-query-sends)

## Pitfalls

Calls that do not exist or do not do what their name suggests; each was checked against `src/` (a TypeScript error,
`undefined` at run time, or the error quoted).

- **Don't** call `q.single()`, `q.any()` or `q.none()` → **Do** use `firstOrDefault()` (or `limit(2).toList()` to check uniqueness), `exists()` and `!(await q.exists())`.
- **Don't** call `db.<table>.sum()`, `.min()`, `.max()` or `.avg()`, or import `sum` / `min` / `max` / `avg` → **Do** `select(p => ({ total: agg.sum(p.views), avg: agg.avg(p.views) })).firstOrDefault()`: one statement, typed numbers.
- **Don't** call `avg()` on a collection or a select builder → **Do** `agg.avg()` in a select, `g.avg()` in a grouped select, or `db.posts.where(p => eq(p.userId, u.id)).select(p => agg.avg(p.views)).asSubquery('scalar')` per row.
- **Don't** call `db.ensureCreated()` or `db.ensureDeleted()` → **Do** `db.getSchemaManager().ensureCreated()` (or `migrate()` on an existing database).
- **Don't** write `db.posts.join(db.users, …)` → **Do** `innerJoin(db.users, (p, u) => eq(p.userId, u.id), (p, u) => ({ … }))`: the third argument is required.
- **Don't** call `toSql()` on a select builder → **Do** `q.future().getSql()` and `q.future().getParams()`.
- **Don't** import `cte`, `SqlFormatter` or use `sql.custom` → **Do** `new DbCteBuilder().with(name, query)`; bind JSON with `castAsJsonb()` or `jsonbContains()`.
- **Don't** call `upsertMany()` or `updateReturning()` → **Do** `upsertBulk(rows, { primaryKey })` and `where(…).update(…).returning()`.
- **Don't** use `generatedByDefaultAsIdentity()` or identity options `minValue` / `maxValue` / `cache` / `cycle` → **Do** `generatedAlwaysAsIdentity({ startWith, incrementBy })`, or a model sequence for those options.
- **Don't** call `hasIndex()` on a property or pass a name to `isUnique()` → **Do** `e.hasIndex('ix_posts_user_id', p => [p.userId])` and `e.hasIndex('uq_users_email', u => [u.email]).isUnique()`.
- **Don't** expect `include()` to load related rows → **Do** project navigations and collections in `select()`; `include()` exists only on `IndexBuilder` (covering columns).
- **Don't** call `firstOrThrow()`, `forUpdate()`, `groupBy()`, `union()` or `asSubquery()` right after `where()` → **Do** `select()` first: the `IEntityQueryable` that `where()` returns does not declare them (see [Which object has which method](#which-object-has-which-method)).
- **Don't** run `db.selectFromCte(cte).toList()` → **Do** `db.selectFromCte(cte).select(r => ({ id: r.id })).toList()`: a CTE-rooted query without `select()` throws `A selection is required. Call .select(...) before executing a CTE-rooted query.`
- **Don't** construct `new DbContext(client, schema)` → **Do** subclass it: `new AppDatabase(client, queryOptions?)`.
- **Don't** expect `await db.users.insert(row)` to return the row → **Do** `await db.users.insert(row).returning(u => ({ id: u.id }))`; every bare write resolves `undefined`.

## See also

- [Choosing the Right Query](./choosing-the-right-query.md) — start here to pick the call for a data need, with its SQL shape and round trips.
- [Querying](./guides/querying.md) — reads: projections, filters, paging, navigations, collections, joins, grouping, with captured SQL.
- [Inserts, Updates, Upserts and Deletes](./guides/insert-update-guide.md) — every write, its SQL and the loop it replaces.
- [Batching and Prepared Queries](./guides/batching-and-prepared-queries.md) — several reads in one round trip, build-once queries.
- [SQL Expression Helpers](./guides/sql-expressions.md) — every expression helper with its SQL and read-back type.
- [Configuration and Options](./guides/configuration.md) — every option with its default and scope.
- [Schema Configuration](./guides/schema-configuration.md) — entities, relations, indexes, types, sequences, views.
- [Database Clients](./database-clients.md) — choosing and configuring a driver.
- [Example Model and Seed Data](./example-model.md) — the tables, columns, relations and seed rows of the `AppDatabase` the examples use.
