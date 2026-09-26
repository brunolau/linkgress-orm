# linkgress 1.0.5 → 1.0.8: performance

The current version (1.0.8, `HEAD` ae6e73f) against 1.0.5 (`v1.0.5` f9f7f87) on 35 scenarios: reads,
reference navigations, collections under all three strategies, grouping, joins, unions, subqueries, CTEs
and writes. Each is measured end to end against PostgreSQL, and separately as the time linkgress itself
spends per query. Both versions run in one process with their measurements interleaved. Every change below
is a ratio over 8 (Node) or 6 (Bun) such rounds, with its 95 % confidence interval.

## Summary

- **End to end, 1.0.8 performs like 1.0.5, with one exception.** Over the other 32 scenarios the geometric
  mean change is −0.7 % on Node and +0.1 % on Bun. The significant slowdowns are small (+2 … +8 %:
  collection projections, a filter through a navigation, an explicit join), and writes are unchanged.
- **The exception is a navigation row projected whole (`{ author: p.user }`), about twice as slow end to
  end:** +94 % on Node, +130 % on Bun. This is the cost of a 1.0.7 fix. 1.0.5 returned that row as JSON,
  with `createdAt` as a string and `lastActiveAt` never passed through its mapper; 1.0.8 reads every column
  through its mapper. About 80 % of linkgress's time in that query goes to `reconstructNestedObjects`, which
  splits every column's path again for every row. Splitting it once per result set brings the shape to
  +6 % of 1.0.5 ([experiment](#a-navigation-row-projected-whole)).
- **The temp-table collection strategy is 23–24 % faster end to end:** its aggregation no longer sorts.
- **The time spent inside linkgress per query grew:** +11 % on Node and +15 % on Bun on average, +30 … +42 %
  for collections, +17 … +21 % for building a query. It is at most about a fifth of a query's time, so it
  barely shows end to end. For collections, most of the growth is per-collection setup that 1.0.8 extended and
  that runs for every parent row instead of once per query. Caching it per query puts collections back at
  or below 1.0.5 ([experiment](#collection-projections)).
- **Cold start:** importing the package takes 11–24 % longer (4.02 MB of compiled JavaScript against
  3.77 MB, +6.8 %). The first query of a shape takes ~0.4–0.6 ms longer, and constructing a context is
  13–17 % faster.

## Setup

| | |
| --- | --- |
| Host | AMD Ryzen 9 7900X (12 cores / 24 threads), 63 GB RAM, Windows 11 Pro (26200), power plan Balanced |
| Runtimes | Node 26.8.1 (the published CommonJS `dist/`) and Bun 1.4.2 |
| Server | PostgreSQL 18.3 on localhost over TCP (`shared_buffers` 128 MB); `pg` 8.16.3 through `PgClient`, which is identical in both versions |
| Versions | each compiled from its own tree with its own `tsconfig.json` (the JavaScript its `dist/` ships): 140 modules / 3.77 MB (1.0.5), 144 / 4.02 MB (1.0.8) |
| Model | the `debug/schema` AppDatabase (identical in both versions); the writes go to a table of the harness's own |
| Data | 2,000 users · 20,003 posts · 10,000 orders · 30,006 comments · 2,000 tasks, 10,000 order links · 200 products × 4 prices × 2 capacity groups (deterministic, `harness.ts`) |
| Rounds | Node 8, Bun 6: one process per round, running both versions with their samples interleaved |

Each scenario runs in up to three tiers:

| tier | statements answered by | measures |
| --- | --- | --- |
| **e2e** | PostgreSQL | what an application waits for |
| **in linkgress** | memory: the rows PostgreSQL returned for the scenario, recorded once and deep-copied off the clock before every iteration | the time inside linkgress: building the SQL, dispatching it, reading the rows back |
| **build** | memory: zero rows | building and dispatching alone |

`ctl-select-1` and `ctl-raw-1k` run through `PgClient` without any query building, so they show the noise
floor of the e2e tier. Both come out within ±0.9 %, and their intervals include zero. The in-linkgress tier
leaves out the driver's own parsing. A shape that moves work between the driver and linkgress
(`nav-whole-row`: JSON parsed by `pg` in 1.0.5, eight columns read by linkgress in 1.0.8) can only be
compared fairly end to end.

<details>
<summary>The scenarios</summary>

| scenario | runs |
| --- | --- |
| `ctl-select-1`, `ctl-raw-1k` | `SELECT $1` and 1,000 raw rows through `PgClient` (no query building) |
| `raw-via-context` | `db.query()`: raw SQL through the context, 100 rows |
| `pk-lookup` | `users.where(id = …).firstOrDefault()` |
| `filter-order-limit` | `where` + `orderBy` + `limit(50)`, 4-column projection |
| `count-where` | `count()` with a filter |
| `entity-1k` | whole entities (all columns, jsonb, a custom mapper), 1,000 rows |
| `projection-20k` | 6-column projection with 2 custom mappers, 20,003 rows |
| `nav-1hop`, `nav-3hop` | navigation columns one and three hops away, 1,000 rows |
| `nav-where` | a filter through a navigation, 544 rows |
| `nav-whole-row` | a navigation row projected whole (`{ id, author: p.user }`), 500 rows |
| `coll-cte`, `coll-lateral`, `coll-temptable` | 100 users with their posts (≈ 1,000) as a `toList()`, one per strategy |
| `coll-large-cte` | 2,000 users with their 20,003 posts, CTE |
| `coll-aggregates-lateral`, `-cte` | per user: `count()`, `max()`, `toNumberList()`, `firstOrDefault()` |
| `coll-nested-lateral`, `-cte` | 100 products → prices → capacity groups (with a navigation) |
| `coll-exists-where` | `where(p => p.postComments.where(…).exists())` |
| `groupby-having`, `groupby-small` | `groupBy` + `having` + count/sum (1,474 groups); `groupBy` over the table (4 groups) |
| `left-join`, `union`, `subquery-exists`, `cte-aggregation` | explicit `leftJoin`; `union`; `where(exists(correlated subquery))`; `DbCteBuilder.withAggregation` + `leftJoin` |
| `insert-one`, `insert-bulk-100`, `insert-bulk-1000-ret` | `insert().returning()`; `insertBulk` of 100; of 1,000 with `.returning()` |
| `upsert-bulk-100`, `bulk-update-100` | `upsertBulk` of 100 (conflict → update); `bulkUpdate` of 100 by key |
| `update-where-ret`, `delete-where`, `transaction` | `where().update().returning()` (50 rows); `where().delete()` (20); insert + update in a transaction |

</details>

## Parity

Before any timing, every scenario ran once on each version and the results were compared. 31 of 35
scenarios render the same statements, and 33 return identical results.

| scenario | statements | result |
| --- | --- | --- |
| `nav-whole-row` | a `json_build_object(…)` column became the row's columns (`__nested__author__<column>`) | different: 1.0.5 returned `createdAt` as the JSON string `"2024-01-01T00:01:00"` and `lastActiveAt` as the stored integer `3607`; 1.0.8 returns `Date`s, the latter through `pgIntDatetime` |
| `coll-temptable` | the aggregation no longer selects `*` and sorts (`ORDER BY "id" DESC`) | the same rows; the order inside each `json_agg`, which nothing guaranteed, differs |
| `coll-aggregates-lateral`, `-cte` | `ORDER BY "views"` became `ORDER BY "lateral_3_posts"."views"` | identical |

## Results

Change = 1.0.8 / 1.0.5, geometric mean over the rounds, **bold** when its whole 95 % interval is on one side
of zero and the change is at least 2 %. Times are medians over the rounds. Every interval is listed in
[results/1.0.5-vs-1.0.8.md](results/1.0.5-vs-1.0.8.md).

### Node 26.8.1, 8 rounds

| scenario | e2e 1.0.5 | e2e 1.0.8 | e2e | in linkgress 1.0.5 | 1.0.8 | in linkgress | build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ctl-select-1` | 115.5 µs | 118.3 µs | −0.9 % | — | — | — | — |
| `ctl-raw-1k` | 745.5 µs | 781.7 µs | +0.0 % | — | — | — | — |
| `raw-via-context` | 239.5 µs | 236.5 µs | −0.2 % | 0.34 µs | 0.35 µs | −2.2 % | — |
| `pk-lookup` | 232.6 µs | 230.6 µs | +1.0 % | 19.7 µs | 22.0 µs | **+8.6 %** | **+12 %** |
| `filter-order-limit` | 1.82 ms | 1.85 ms | +2.6 % | 37.5 µs | 49.1 µs | **+26 %** | **+18 %** |
| `count-where` | 1.44 ms | 1.42 ms | +0.2 % | 8.34 µs | 8.80 µs | **+8.3 %** | +4.2 % |
| `entity-1k` | 2.94 ms | 3.01 ms | −1.1 % | 294.3 µs | 336.7 µs | **+16 %** | **+35 %** |
| `projection-20k` | 25.7 ms | 25.8 ms | −0.1 % | 5.13 ms | 5.48 ms | **+8.9 %** | **+21 %** |
| `nav-1hop` | 1.43 ms | 1.40 ms | −0.5 % | 199.0 µs | 185.4 µs | **−6.0 %** | **+10 %** |
| `nav-3hop` | 1.61 ms | 1.65 ms | −0.0 % | 206.9 µs | 198.2 µs | **−5.3 %** | **+24 %** |
| `nav-where` | 1.51 ms | 1.64 ms | **+5.3 %** | 70.0 µs | 78.3 µs | **+10 %** | **+16 %** |
| `nav-whole-row` | 1.69 ms | 3.37 ms | **+94 %** | 88.8 µs | 1.34 ms | **+1481 %** | **+56 %** |
| `coll-cte` | 1.38 ms | 1.40 ms | **+3.2 %** | 203.5 µs | 233.1 µs | **+18 %** | **+23 %** |
| `coll-lateral` | 1.36 ms | 1.40 ms | +1.8 % | 169.7 µs | 210.3 µs | **+23 %** | **+20 %** |
| `coll-temptable` | 16.5 ms | 12.7 ms | **−23 %** | 218.7 µs | 258.4 µs | **+20 %** | — |
| `coll-large-cte` | 18.8 ms | 19.1 ms | +5.2 % | 2.69 ms | 3.27 ms | +11 % | **+27 %** |
| `coll-aggregates-lateral` | 1.42 ms | 1.50 ms | **+5.4 %** | 132.2 µs | 206.8 µs | **+47 %** | **+32 %** |
| `coll-aggregates-cte` | 7.16 ms | 7.43 ms | +2.2 % | 134.8 µs | 186.0 µs | **+45 %** | **+33 %** |
| `coll-nested-lateral` | 5.87 ms | 5.98 ms | +1.9 % | 206.2 µs | 295.7 µs | **+44 %** | **+37 %** |
| `coll-nested-cte` | 3.55 ms | 3.55 ms | +4.6 % | 231.1 µs | 335.5 µs | **+40 %** | **+37 %** |
| `coll-exists-where` | 2.64 ms | 2.68 ms | +0.8 % | 60.7 µs | 70.6 µs | **+24 %** | **+16 %** |
| `groupby-having` | 3.53 ms | 3.57 ms | +0.8 % | 181.0 µs | 179.0 µs | −2.7 % | −0.8 % |
| `groupby-small` | 2.21 ms | 2.19 ms | +2.2 % | 14.2 µs | 17.6 µs | **+27 %** | **+26 %** |
| `left-join` | 1.40 ms | 1.48 ms | **+3.3 %** | 163.0 µs | 220.5 µs | **+31 %** | +13 % |
| `union` | 645.7 µs | 650.3 µs | +3.3 % | 58.8 µs | 72.4 µs | **+21 %** | **+11 %** |
| `subquery-exists` | 1.70 ms | 1.64 ms | +0.4 % | 70.4 µs | 85.5 µs | **+25 %** | +2.7 % |
| `cte-aggregation` | 1.39 ms | 1.37 ms | +2.2 % | 165.6 µs | 101.5 µs | **−40 %** | **+9.7 %** |
| `insert-one` | 345.5 µs | 351.1 µs | −0.8 % | 3.74 µs | 3.83 µs | +5.3 % | — |
| `insert-bulk-100` | 2.09 ms | 2.06 ms | −1.7 % | 61.8 µs | 62.7 µs | +0.7 % | +0.4 % |
| `insert-bulk-1000-ret` | 24.6 ms | 24.2 ms | −1.1 % | 814.9 µs | 837.3 µs | +5.5 % | — |
| `upsert-bulk-100` | 1.89 ms | 1.87 ms | +1.5 % | 69.2 µs | 65.7 µs | −2.7 % | −4.3 % |
| `bulk-update-100` | 1.19 ms | 1.18 ms | +1.6 % | 60.9 µs | 65.7 µs | +4.1 % | +5.5 % |
| `update-where-ret` | 688.8 µs | 663.0 µs | −19 % ¹ | 23.8 µs | 22.7 µs | −4.0 % | — |
| `delete-where` | 386.3 µs | 387.4 µs | −1.9 % | 7.06 µs | 7.23 µs | +0.7 % | +15 % |
| `transaction` | 896.9 µs | 869.6 µs | −14 % ¹ | 15.9 µs | 17.3 µs | +5.9 % | — |

Geometric mean over the 33 scenarios other than the controls: e2e +1.4 % (−0.7 % without `nav-whole-row`),
in linkgress +21 % (+11 %), build +18 % (+17 %).
¹ Not significant: single rounds hit by server-side write latency (intervals −48 … +26 % and −41 … +25 %).

### Bun 1.4.2, 6 rounds

| scenario | e2e 1.0.5 | e2e 1.0.8 | e2e | in linkgress 1.0.5 | 1.0.8 | in linkgress | build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ctl-select-1` | 59.8 µs | 59.7 µs | +0.6 % | — | — | — | — |
| `ctl-raw-1k` | 554.8 µs | 555.1 µs | +0.4 % | — | — | — | — |
| `raw-via-context` | 168.2 µs | 168.3 µs | +0.4 % | 0.34 µs | 0.33 µs | +0.8 % | — |
| `pk-lookup` | 189.7 µs | 195.0 µs | +3.9 % | 13.0 µs | 15.1 µs | **+15 %** | +7.5 % |
| `filter-order-limit` | 1.54 ms | 1.53 ms | −2.5 % | 22.0 µs | 25.6 µs | **+20 %** | **+23 %** |
| `count-where` | 1.05 ms | 1.02 ms | −4.4 % | 4.75 µs | 4.97 µs | **+5.5 %** | −1.9 % |
| `entity-1k` | 2.14 ms | 2.17 ms | +4.7 % | 121.7 µs | 129.7 µs | +2.4 % | **+23 %** |
| `projection-20k` | 18.5 ms | 19.2 ms | +2.8 % | 1.88 ms | 1.96 ms | +3.8 % | **+15 %** |
| `nav-1hop` | 1.51 ms | 1.45 ms | −4.3 % | 88.2 µs | 89.3 µs | +0.6 % | **+10 %** |
| `nav-3hop` | 1.46 ms | 1.45 ms | −1.2 % | 83.9 µs | 94.6 µs | **+9.3 %** | **+18 %** |
| `nav-where` | 1.55 ms | 1.51 ms | −1.2 % | 37.4 µs | 41.8 µs | **+15 %** | +5.8 % |
| `nav-whole-row` | 1.65 ms | 4.18 ms | **+130 %** | 58.2 µs | 2.39 ms | **+4082 %** | **+73 %** |
| `coll-cte` | 1.37 ms | 1.45 ms | **+5.1 %** | 174.0 µs | 224.2 µs | **+31 %** | **+30 %** |
| `coll-lateral` | 1.33 ms | 1.40 ms | +6.0 % | 141.3 µs | 195.2 µs | **+35 %** | **+36 %** |
| `coll-temptable` | 15.1 ms | 11.4 ms | **−24 %** | 174.3 µs | 247.7 µs | **+35 %** | — |
| `coll-large-cte` | 18.3 ms | 19.6 ms | +9.5 % | 2.46 ms | 3.25 ms | **+37 %** | **+34 %** |
| `coll-aggregates-lateral` | 1.45 ms | 1.52 ms | +4.3 % | 162.9 µs | 230.7 µs | **+45 %** | **+52 %** |
| `coll-aggregates-cte` | 6.83 ms | 7.11 ms | +7.2 % | 146.8 µs | 214.9 µs | **+48 %** | **+46 %** |
| `coll-nested-lateral` | 5.59 ms | 5.75 ms | **+2.3 %** | 216.9 µs | 371.4 µs | **+71 %** | **+27 %** |
| `coll-nested-cte` | 2.66 ms | 2.81 ms | **+8.0 %** | 199.5 µs | 340.2 µs | **+66 %** | **+45 %** |
| `coll-exists-where` | 2.50 ms | 2.48 ms | −1.5 % | 42.2 µs | 49.7 µs | **+19 %** | **+19 %** |
| `groupby-having` | 3.52 ms | 3.51 ms | +5.2 % | 231.3 µs | 262.4 µs | **+18 %** | **+30 %** |
| `groupby-small` | 2.35 ms | 2.54 ms | +5.0 % | 7.55 µs | 11.7 µs | **+43 %** | **+32 %** |
| `left-join` | 1.41 ms | 1.34 ms | −4.3 % | 136.2 µs | 111.4 µs | **−17 %** | **+22 %** |
| `union` | 656.7 µs | 683.0 µs | −5.4 % | 37.3 µs | 44.4 µs | **+22 %** | +7.6 % |
| `subquery-exists` | 1.90 ms | 1.65 ms | −7.4 % | 51.2 µs | 60.9 µs | +12 % | +29 % |
| `cte-aggregation` | 1.28 ms | 1.23 ms | −4.0 % | 103.1 µs | 79.9 µs | **−32 %** | +30 % |
| `insert-one` | 401.2 µs | 395.8 µs | −1.0 % | 3.76 µs | 4.36 µs | **+18 %** | — |
| `insert-bulk-100` | 1.68 ms | 1.70 ms | −1.2 % | 57.8 µs | 70.3 µs | **+19 %** | **+15 %** |
| `insert-bulk-1000-ret` | 18.0 ms | 17.4 ms | +1.2 % | 855.9 µs | 966.4 µs | **+14 %** | — |
| `upsert-bulk-100` | 1.51 ms | 1.48 ms | +0.9 % | 53.1 µs | 51.4 µs | −1.5 % | +0.4 % |
| `bulk-update-100` | 704.7 µs | 713.6 µs | +0.4 % | 42.9 µs | 44.8 µs | +3.0 % | +1.5 % |
| `update-where-ret` | 446.1 µs | 442.7 µs | +0.8 % | 15.6 µs | 12.7 µs | **−20 %** | — |
| `delete-where` | 249.3 µs | 251.5 µs | +1.3 % | 4.14 µs | 4.55 µs | **+10 %** | **+10 %** |
| `transaction` | 509.5 µs | 526.9 µs | +0.7 % | 10.9 µs | 12.2 µs | +5.6 % | — |

Geometric mean over the 33 scenarios other than the controls: e2e +2.6 % (+0.1 % without `nav-whole-row`),
in linkgress +28 % (+15 %), build +23 % (+21 %). Some shapes land differently per engine: `left-join` is
+31 % in linkgress on Node and −17 % on Bun.

### Cold start

A fresh process per measurement, 20 per version and runtime, alternated. Every statement is answered with
zero rows by a client that never connects, so only linkgress (and loading `pg`) is on the clock.

| | Node 1.0.5 | Node 1.0.8 | change | Bun 1.0.5 | Bun 1.0.8 | change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `require` the package | 26.4 ms | 30.5 ms | +11 % ² | 22.6 ms | 28.3 ms | **+24 %** |
| `require` the AppDatabase model | 5.24 ms | 4.82 ms | **−8.1 %** | 3.74 ms | 3.71 ms | +0.6 % |
| construct the client (loads `pg`) and the context | 20.0 ms | 17.9 ms | **−13 %** | 16.1 ms | 13.7 ms | **−17 %** |
| first query (`pk-lookup` shape), cold | 1.68 ms | 2.08 ms | **+23 %** | 2.05 ms | 2.47 ms | **+19 %** |
| first collection query, cold | 1.38 ms | 1.97 ms | **+46 %** | 1.35 ms | 1.75 ms | **+32 %** |

² Interval −0.1 … +22 %.

## Where the differences come from

### A navigation row projected whole

`nav-whole-row` projects `{ id: p.id, author: p.user }`. In 1.0.5 that rendered one
`json_build_object('id', "user"."id", …)` column: `pg` parsed it with `JSON.parse`, and linkgress passed the
object through untouched. So `createdAt` stayed a string and the custom mapper of `lastActiveAt` was never
applied. Since 1.0.7 the row renders as its eight columns (`"user"."id" AS "__nested__author__id"`, …),
and each value is read through its own column's mapper.

A CPU profile of 1.0.8's in-linkgress tier puts 79 % of the time in `reconstructNestedObjects`. For every
row it takes `Object.entries(row)`, and for each of the eight `__nested__author__<column>` keys it runs a
`substring`, a `split('__')` and keyed stores. Reading the values (`transformResults` + `readField`) takes
14 %. The routine is 1.0.5's, minus a numeric-string conversion, so a plain nested object
(`{ a: { b: x.col } }`) pays the same in both versions. 1.0.7 routed the whole navigation row through it.

**Experiment:** a copy of 1.0.8's compiled output whose `reconstructNestedObjects` splits the column paths
once per result set, in a plan cached by the query's `nestedPaths` set. It returns identical results on all
35 scenarios. Six interleaved rounds (Node), `nav-whole-row` only:

| | e2e | in linkgress |
| --- | ---: | ---: |
| 1.0.8 + plan / 1.0.8 | **−29 %** (−31 … −28) | **−71 %** (−72 … −70) |
| 1.0.8 + plan / 1.0.5 | **+6.2 %** (+3.7 … +8.8) | 7× (the values are now mapped; 1.0.5 passed parsed JSON through) |

### Collection projections

A per-iteration profile of `coll-nested-lateral` (in-linkgress tier, Node, the scenario alone in its process)
goes from 185 to 337 µs. Reading the items accounts for 110 → 223 µs of it: in 1.0.5
`transformCollectionItems`, `transformNestedCollectionValue` and `transformItem`; in 1.0.8
`transformCollectionItemsOf`, `transformNestedCollectionValueOf`, `transformItem`, `selectedFieldMapper` and
`hasFieldReads`.

Both versions rebuild a collection's read setup every time they read one parent row's items, and, for a
nested collection, every time they read one item's. That setup is a mapper cache, a scan of the target
table's column cache, a nested-collection map and an item closure. 1.0.8 added a `describedAliases` set
built from a fresh array, a second pass for `mapWith` mappers, and `hasFieldReads`. Here that setup runs
500 times per query (100 parent rows, 400 nested values).

**Experiment:** a copy of 1.0.8 that caches that setup per query (by the collection builder and by its
nested-collection info). It returns identical results on all 35 scenarios. Six interleaved rounds (Node),
in-linkgress tier:

| | 1.0.8 + cache / 1.0.8 | 1.0.8 + cache / 1.0.5 |
| --- | ---: | ---: |
| `coll-cte` | **−22 %** | −5.1 % |
| `coll-lateral` | **−24 %** | −4.6 % |
| `coll-temptable` | **−17 %** | +2.4 % |
| `coll-large-cte` | **−35 %** | **−18 %** |
| `coll-aggregates-lateral` | **−32 %** | +1.8 % |
| `coll-aggregates-cte` | **−28 %** | +7.8 % |
| `coll-nested-lateral` | **−39 %** | **−9.4 %** |
| `coll-nested-cte` | **−36 %** | −5.3 % |
| `coll-exists-where` | −1.2 % | **+15 %** (its difference is in building, not reading) |

End to end the cache is worth −1 … −5 % against 1.0.8 (`coll-nested-cte` −4.9 %, the rest within noise).

### Building a query

There is no single hot spot. Per-iteration profiles of a scenario alone in its process: `entity-1k` builds
in 15.4 → 18.6 µs, `coll-aggregates-lateral` in 44.3 → 46.8 µs. The difference is spread over passes added
by the 1.0.6–1.0.7 correctness fixes, each costing 0.1–1 µs:

- the navigation alias plan (`withNavigationPlan`, `addSelectionToNavigationPlan`, `NavigationAliasPlan`)
- a joined table's explicit join paths (`addExplicitJoinPathsFromSelection`)
- `orderBy` keys (`orderKey`)
- conditions projected as columns (`projectConditionValue`)
- outer references (`collectOuterRefs`)

In the benchmark, where one process builds all 35 shapes, the difference is larger (+18 % Node, +23 % Bun on
average). With many query shapes in one process, the larger and more generic code paths cost more.

### What got faster

- **`coll-temptable`, −23 % (Node) / −24 % (Bun) end to end.** 1.0.5 aggregated
  `FROM (SELECT * FROM "posts" WHERE … ORDER BY "id" DESC) t`, sorting the rows. 1.0.8 selects only the
  needed columns and does not sort.
- **`cte-aggregation`, −40 % / −32 % in linkgress.** 1.0.5 rebuilt the aggregated items' mapper cache for
  every row (`transformCteAggregationItems`). 1.0.8 compiles it once per query (`aggregatedItemReads`).
- **Constructing a context, −13 % / −17 %.**

## Method notes

- **Why interleaved.** A first run measured each version in processes of its own, alternated, 6 rounds per
  runtime. Within a process the samples agreed within 3–12 % (coefficient of variation). From one process
  to the next, the same version's median moved 10–30 %, up to 2× (`coll-cte`'s build on 1.0.8: 26 µs in one
  process, 62 µs in another). The likely causes are which core Windows picked, its boost clock and
  background load. Even the `PgClient` control swung −23 … +35 % between rounds. `interleave.mjs` therefore
  loads both versions' trees into one process, with separate module instances and pools, and the writes on
  separate tables. For every scenario and tier it prepares both versions and collects the heap. It then
  warms both up in alternating 75 ms chunks (300 ms each) and takes 10 pairs of 30 ms samples, alternating
  which version goes first.
- **Statistics.** Per round, the ratio of the two versions' medians. Over the rounds, their geometric mean
  with a 95 % t-interval of the log ratios.
- **The in-linkgress tier** replays each statement's recorded rows as `pg` returned them (JSON already
  parsed, timestamps already `Date`s). A fresh deep copy is made before every iteration, off the clock,
  since linkgress may rewrite the rows it is handed. The replay is checked: a changed statement sequence
  fails the scenario.
- **Caveats.** One machine (Windows, power plan Balanced), the server on localhost, the `pg` driver only. A
  network round trip adds the same time to both versions and makes every relative end-to-end difference
  smaller.

## Reproduce

```bash
# everything (~40 min): build both trees, seed, verify, cold start, interleaved rounds, report
node bench/versions/compare.mjs --base v1.0.5 --head HEAD

# a subset
node bench/versions/compare.mjs --phases bench,report --runtimes node --rounds 4 --filter '^coll-'
```

`compare.mjs` extracts each ref's `src/` and the `debug/` model into `--work-dir` (default
`<tmp>/linkgress-verbench`) and compiles it with the ref's own compiler options plus `harness.ts` and
`startup.ts`. Both trees resolve `node_modules` to this repository's. The database is `VERBENCH_DB`
(default `linkgress_verbench`), created if missing and reseeded by the `setup` phase, on the `.env`
connection. `HEAD` means the committed state. The report lands in `<work-dir>/results/summary.md` (the
source of `results/1.0.5-vs-1.0.8.md`) and `summary.json`.
