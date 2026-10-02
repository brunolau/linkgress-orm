# Lateral Navigation Joins — `lateralJoin()`

A reference navigation (`b.author`) renders as a plain join, and PostgreSQL picks how to run it. `lateralJoin()`
renders ONE navigation, of one query, as a LATERAL probe of its target's key instead — a join the planner can only
run as one key lookup per row of the query.

```typescript
await db.books
  .where(b => eq(b.shelfId, shelfId))
  .lateralJoin(b => b.author)
  .select(b => ({ title: b.title, author: b.author.name, region: b.author.region.name }))
  .toList();
```

```sql
-- without lateralJoin()
SELECT "books"."title" as "title", "author"."name" as "author", "region"."name" as "region"
FROM "books"
LEFT JOIN "authors" AS "author" ON "books"."author_id" = "author"."id"
LEFT JOIN "regions" AS "region" ON "author"."region_id" = "region"."id"
WHERE "books"."shelf_id" = $1

-- with lateralJoin(b => b.author)
SELECT "books"."title" as "title", "author"."name" as "author", "region"."name" as "region"
FROM "books"
LEFT JOIN LATERAL (SELECT "author__probe".* FROM "authors" "author__probe" WHERE "author__probe"."id" = "books"."author_id" OFFSET 0) "author" ON true
LEFT JOIN "regions" AS "region" ON "author"."region_id" = "region"."id"
WHERE "books"."shelf_id" = $1
```

The rows are the same: an unmatched (or NULL) foreign key keeps its row with NULLs, as the LEFT join did; a
required navigation (`.isRequired()`) renders `INNER JOIN LATERAL … ON true` and drops the row, as its INNER join
did. Navigations reached through the probe (`b.author.region`) join off its alias, as before.

## When to use it

When a query reads a FEW rows — the lines of one parent, one page — and joins them to a LARGE table through a
foreign key whose statistics can lag behind the data.

PostgreSQL estimates how much of the target's primary-key index a merge join reads from the statistics of the
foreign-key column: the range of keys its histogram has seen. When the rows being joined hold keys far above
that range — the newest rows of the target, rarely seen in a statistics sample — the planner believes a merge
join stops after a sliver of the index, picks it, and then reads the WHOLE index for a handful of rows. Whether it
does depends on the sample the last `ANALYZE` drew, so the same statement can be fast for weeks and slow after an
autoanalyze, and a pooled connection keeps the plan it cached.

The probe takes that choice away: a LATERAL subquery that reads the outer row's foreign key can only run once per
outer row, through the target's key index. `OFFSET 0` keeps PostgreSQL from pulling the subquery up into a plain
join again (`LIMIT 1` would too, but would drop rows for a principal key that is not unique).

## When NOT to use it

- **A navigation the query filters by.** With `where(b => eq(b.author.name, 'Ann'))` over all books, the plain join
  lets PostgreSQL start from the matching authors; the probe forces it to visit every book and probe its author.
  Opt in only for navigations that READ values of rows the query already found by other means.
- **Many rows.** For thousands of rows joined to a table of similar size, a hash or merge join is the right plan;
  forbidding it costs one index lookup per row.

The opt-in is per navigation and per query, never model-wide: `lateralJoin(b => b.author)` changes the author's
join of this query and nothing else — every other navigation, and every other query, renders as before.

## Where it applies

- **Root queries** — on a table (`db.books.lateralJoin(...)`), after `where()`, and on the untyped builders
  (`QueryBuilder`, `SelectQueryBuilder`). Call it once per navigation to probe several.
- **After `select()`** — and on every other select builder: `selectDistinct()`, `innerJoin()` / `leftJoin()`,
  the end of the chain, or a builder taken as an `IEntityQueryable`. The selector names a navigation of the
  query's ROOT row (`b => b.author`), whatever the projection; the projection and the chain are kept. The
  navigation joins are rendered when the query is built, so the call order does not matter — the statement is
  the one the same `lateralJoin()` renders before `select()`:

  ```typescript
  db.books
    .where(b => eq(b.shelfId, shelfId))
    .select(b => ({ title: b.title, author: b.author.name }))
    .lateralJoin(b => b.author) // the same statement as .lateralJoin(b => b.author).select(…)
    .orderBy(r => r.title)
  ```
- **Collections** — before `select()`: the collection's rows (one parent's) drive, and the probe reads the
  foreign key of the row the strategy renders the item as, under every strategy (`lateral`, `cte`, `temptable`):

  ```typescript
  db.shelves.select(s => ({
    label: s.label,
    books: s.books
      .lateralJoin(b => b.author)
      .select(b => ({ title: b.title, author: b.author.name }))
      .toList(),
  }))
  // … FROM "books" "lateral_0_books"
  //   LEFT JOIN LATERAL (SELECT "author__probe".* FROM "authors" "author__probe"
  //                      WHERE "author__probe"."id" = "lateral_0_books"."author_id" OFFSET 0) "author" ON true
  ```

  A collection's `count()` / `exists()` — projected, or in a `where()` — probes too.
- **Everything that renders the query** — `toList()`, `first()`, `count()`, `exists()`, `min()` / `max()` / `sum()`,
  `countOver()`, `future()`, `prepare()`, `QueryBatch` legs and `union()` / `unionAll()` legs. The text is the same
  every time the query is built, so a prepared statement keeps ONE cached plan.

What the probe renders:

| Navigation | Rendering |
|---|---|
| optional (`hasOne`) | `LEFT JOIN LATERAL (…) "<alias>" ON true` |
| required (`.isRequired()`) | `INNER JOIN LATERAL (…) "<alias>" ON true` |
| composite key | every key pair in the probe's WHERE |
| constant key part (`withForeignKey(b => [b.authorId, true])` / `withPrincipalKey(a => [a.id, a.active])`) | `… AND "<alias>__probe"."active" = true` in the probe's WHERE |
| of a table to itself (`a.mentor`) | the probe reads its table under `"<alias>__probe"`, so the outer row's foreign key is never read off the probed row |

Columns of the target nothing reads cost nothing: PostgreSQL drops them from the subquery's output.

## Refused

Each refusal throws when the query is built, never silently renders a plain join:

- a selector that returns a column, a collection, or a navigation reached through another one
  (`b => b.author.region`) — `lateralJoin()` takes a reference navigation of the row itself;
- `update()` / `delete()` — their navigations join as `FROM` / `USING` items, and PostgreSQL lets no LATERAL
  subquery there read the row the statement writes. Read the value through a correlated scalar subquery instead:
  `db.authors.where(a => eq(a.id, b.authorId)).select(a => a.name).asSubquery('scalar')`;
- `groupBy()`;
- a collection flattened by `selectMany()`, in either order.

## Proving the shape

The planner cannot be tricked out of the probe, which a test can show without a large fixture: with hash joins
and nested loops switched off, the plain join falls back to a merge join while the probe stays a nested loop over
an index lookup:

```sql
SET LOCAL enable_hashjoin = off; SET LOCAL enable_nestloop = off; SET LOCAL enable_seqscan = off;
EXPLAIN (COSTS OFF) <the plain text>   -- Merge Left Join / Merge Cond: (books.author_id = author.id)
EXPLAIN (COSTS OFF) <the probe text>   -- Nested Loop Left Join → Index Scan using authors_pkey on authors author__probe
```

The in-memory database runs both shapes and returns the same rows.

See also: [Collection Strategies](../collection-strategies.md), [Querying](./querying.md).
