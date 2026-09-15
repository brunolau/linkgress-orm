# PGlite vs PostgreSQL: the linkgress suite on both

The whole jest suite (136 files, 1,783 tests) run against a real PostgreSQL server through `pg`, and
in-process against PGlite through `PGliteClient` — then every statement the two runs executed,
compared result by result.

> Measured before the suite moved from Jest to `bun:test` (v1.0.0). The findings stand; the commands
> under *Reproduce* are the current, Bun-based ones. On the Bun runner the same host runs the suite in
> 21.0 s on PGlite (8 files in parallel, 1,858 passed / 7 failed — the four `query-batch-fidelity`
> date-revival failures below do not occur under Bun) and in 12.7 s in memory (12 files, 1,865 / 0).

## Setup

| | |
| --- | --- |
| Host | Windows 11 Pro (26200), Node 26.8.1, jest 30.5.1 / ts-jest 29.4.12 (in band, cache warm), zone Europe/Bratislava (CEST, UTC+2 during the runs) |
| Server | PostgreSQL 18.3 x86_64-windows on localhost over TCP, `pg` 8.23.0, a dedicated database; collation `English_United States.1252`, `TimeZone` Europe/Budapest |
| PGlite | `@electric-sql/pglite` 0.5.8 = PostgreSQL 18.3 on wasm32; collation `C` (ctype `C.UTF-8`), `TimeZone` `Etc/GMT-1`; one instance per test file, booted from the schema snapshot `globalSetup` dumps, `pg_trgm` and `unaccent` loaded |
| Both | `node --experimental-vm-modules` (PGlite needs it under jest; pg ran with it too), `--json`; runs alternated pg, PGlite, pg, PGlite; statement recording in two separate runs |

## Outcomes

Identical in both repetitions:

| | pg | PGlite |
| --- | --- | --- |
| tests passed | 1,782 | 1,771 |
| tests failed | 0 | 11 |
| tests skipped | 1 | 1 |
| files that fail to compile | 1 | 1 |

The file that does not compile is `tests/database/bun-client.test.ts` on both sides (pre-existing: its
mocks do not type-check against the jest 30.5 typings). The 11 PGlite-only failures:

| tests | cause | whose |
| --- | --- | --- |
| `query-timeout` × 4, `query-batch` × 1 | the spec seeds through the harness (PGlite) and then queries its own `PostgresClient` on the server, where those rows do not exist | harness artifact, not PGlite |
| `query-batch-fidelity` × 4 | `QueryBatch` revives `date` columns at local midnight (pg's convention); standalone PGlite reads — like postgres.js reads — give UTC midnight | pre-existing linkgress issue: the same 4 fail with `LINKGRESS_TEST_DRIVER=postgres` |
| `for-update` × 1 | holds a row lock in one transaction and opens a second, concurrent one; PGlite has one session, so the second waits for the first — until the 30 s test timeout | engine limit: one session |
| `collation` × 1 | an ICU non-deterministic (case- and accent-insensitive) collation matches nothing | engine limit: PGlite ships no ICU data |

## Time

| | pg | PGlite |
| --- | --- | --- |
| jest wall time, run 2 / run 3 | 140.0 s / 125.7 s | 142.9 s / 140.5 s |
| … of which the `for-update` timeout | — | 30.7 s / 30.6 s |
| sum of per-file times without `for-update` | 138.6 s / 124.4 s | 111.0 s / 108.8 s (−20% / −13%) |
| peak working set of the jest process | 1.53 GB | 1.75–1.80 GB |

pg's own server memory is not in its column; PGlite's engine is. pg's two runs differed by 14 s,
PGlite's by 2 s. By file, bucketed by the file's pg time:

| pg time per file | files (run 2 / 3) | pg | PGlite | PGlite / pg |
| --- | --- | --- | --- | --- |
| < 0.5 s | 59 / 74 | 17.9 s / 18.8 s | 32.4 s / 49.0 s | 1.81× / 2.61× |
| 0.5–2 s | 54 / 42 | 50.1 s / 42.7 s | 46.1 s / 30.3 s | 0.92× / 0.71× |
| > 2 s | 22 / 19 | 70.5 s / 62.9 s | 32.5 s / 29.5 s | 0.46× / 0.47× |

### Where the time goes

Measured outside jest with `bench/pglite/latency.ts` — same machine, same linkgress stack, warm:

| operation | pg | PGlite | PGlite / pg |
| --- | --- | --- | --- |
| `SELECT $1` | 0.086 ms | 0.142 ms | 1.64× |
| ORM read: users with their posts (CTE `json_agg`) | 0.306 ms | 0.398 ms | 1.30× |
| INSERT inside a 100-row transaction, per row | 0.085 ms | 0.155 ms | 1.83× |
| INSERT one row, autocommit | 0.196 ms | 0.163 ms | 0.83× |
| per-test reset: `TRUNCATE` 22 tables + `seedTestData` | 76.6 ms | 16.7 ms | 0.22× |
| DDL: `CREATE TABLE` + `CREATE INDEX` + `DROP TABLE` | 7.60 ms | 2.05 ms | 0.27× |

- **Per statement, PGlite is slower.** The engine runs as WebAssembly on the test's own thread, and
  every query still goes through the PostgreSQL wire protocol, encoded and decoded in JavaScript —
  more than a localhost round trip to a native server costs. Keeping the data in memory buys nothing
  for reads: the server holds a test-sized dataset in RAM as well.
- **PGlite wins where the server touches its disk**: `TRUNCATE` (new relation files), DDL, commit
  flushes. The suite resets the database 1,087 times — about 83 s of a pg run at the benchmark's
  76.6 ms, about 18 s on PGlite.
- **Most of that gain goes to booting.** Each test file boots its own instance from the 39 MB
  snapshot: 152 ms, plus 20 ms for the module and 10 ms for the WASM compile outside jest; inside
  jest's fresh per-file module context a small file takes a median 0.26 s / 0.44 s longer on PGlite —
  about 35–60 s over 136 files. The slower statements cost another ~2 s over ~24,500 of them.

Net: 13–20% less time, and the 30 s `for-update` timeout (since fixed: it now fails at once) brings
the wall time back to parity. These
server costs are file-system bound, so the balance depends on the server's disk and OS — here,
Windows.

## After rebasing onto v1.0.0: parallel workers

Measured later the same day, rebased onto `main` (v1.0.0, which adds the built-in in-memory engine).
Every test file owns its database on PGlite — and on the in-memory engine — so those runs can use
parallel jest workers. The real server cannot with this harness: every file shares one database.

| run | jest wall time | vs pg | peak memory (process tree) | passed / failed |
| --- | --- | --- | --- | --- |
| pg, serial | 147.8 s | — | 1.5 GB | 1,791 / 0 |
| PGlite, serial | 136.4 s | 1.1× | 1.9 GB | 1,780 / 11 |
| **PGlite, 8 workers** | **23.5 s** | **6.3×** | 8.4 GB | 1,780 / 11 |
| PGlite, 12 workers | 25.9 s | 5.7× | 11.8 GB | 1,780 / 11 |
| PGlite, 16 workers | 24.0 s | 6.2× | 13.7 GB | 1,780 / 11 |
| in-memory engine, serial | 82.8 s | 1.8× | 2.8 GB | 1,788 / 1 |
| in-memory engine, 12 workers | 11.6 s | 12.7× | 9.0 GB | 1,790 / 1 |

- Every parallel run has exactly the per-test outcomes of the serial run on the same backend. (The
  serial in-memory run predates the two fail-fast contract tests — hence 1,788.)
- Two changes made the parallel numbers possible. A `transaction()` callback calling back into its
  own instance now fails at once: `for-update` used to hang for 30 s, which with workers would bound
  the whole run. And the contract spec boots its throwaway instances from a dump instead of running
  initdb for each — it was the longest file (20.6 s at 12 workers; 8.7 s at 8 now).
- PGlite stops scaling at about 8 workers: the summed per-file time goes 136 s → 177 s → 293 s →
  363 s at 1 / 8 / 12 / 16 workers — the CPU is saturated. Each file boots its own instance (~0.25 s
  under jest: a fresh PGlite module and WASM instance, then Postgres starting from the 39 MB
  snapshot), and PGlite executes slower than a native server. Tried and ruled out: V8's
  `--no-wasm-tier-up` and `--wasm-lazy-compilation` (no change), caching the snapshot bytes per
  worker (−17 ms per boot), sharing one compiled WASM module between files (the second file hangs).
- `pnpm test:pglite` runs on half the cores unless a worker option is passed.

### A cheaper per-test reset would help the server most

`setupDatabase()` resets with `TRUNCATE … RESTART IDENTITY CASCADE`. A DELETE-based reset — foreign-key
triggers off through `session_replication_role`, owned sequences restarted — measured, seed included:

| per reset | `TRUNCATE` | `DELETE` + `RESTART` |
| --- | --- | --- |
| pg | 98.5 ms | 31.1 ms |
| PGlite | 17.0 ms | 9.5 ms |

Over the suite's 1,087 resets that is ~73 s on pg and ~8 s on PGlite: it would roughly halve the
serial pg run. Not applied — it changes the reset for every driver, and `CASCADE` would no longer
reach tables that specs create with foreign keys into these.

## Results, statement by statement

`LINKGRESS_TEST_RECORD_DIR` recorded every statement the harness ran with a digest of its result:
24,915 on pg, 24,532 on PGlite. Statements pair up within the same test by SQL text and occurrence.

| paired statements | 24,344 |
| --- | --- |
| identical rows, order and rowCount (or the same SQLSTATE) | 24,167 (99.3%) |
| different because a parameter was time- or process-dependent | 27 |
| different | 150: 148 in rows, 1 in order only, 1 an error on one side |
| executed on one side only | 571 on pg, 188 on PGlite |

Every one of the 150 has an identified cause:

| cause | statements | whose |
| --- | --- | --- |
| a shared, long-lived server database vs a fresh database per file: catalog listings see two tables other specs left behind, one `TRUNCATE` found the tables an earlier spec had dropped (pg then rebuilt the schema), OIDs | 79 | test environment |
| `name[]` columns (index column lists): `pg` returns the text `{hash}`, PGlite parses `["hash"]`, as postgres.js does — linkgress accepts both | 43 | driver: `pg` has no `name[]` parser |
| session time zone: PGlite starts in `Etc/GMT-1`, a fixed offset that ignores daylight saving (08:54 while the host read 09:54 CEST), the server in Europe/Budapest — `now()` values and `timestamptz` rendered inside JSON differ by an hour; PGlite's clock also has millisecond, not microsecond, precision | 19 | PGlite default (`SET TIME ZONE 'Europe/Bratislava'` works) |
| `date` columns read as UTC midnight (PGlite, like postgres.js) vs local midnight (`pg`) | 4 | driver convention |
| a JS array bound to a `json` parameter: `pg` sends it as a PostgreSQL array literal, so `[]` is stored as `{}` (and `[1, 2]` fails as invalid JSON), PGlite stores the JSON | 2, plus 2 of the `date` rows | `pg` quirk — PGlite is right |
| default collation `C` on PGlite (byte order: `Alice Post 1` < `alice`) vs the server's linguistic one (`alice` < `Alice Post 1`): a text `ORDER BY` differs | 2 | PGlite default |
| the ICU non-deterministic collation above | 1 | engine limit |

The statements executed on one side only come from execution paths, not results. `PGliteClient`
reports `supportsMultiStatementQueries()`, so the temp-table strategy, the fully-optimized collection
path and `FutureQuery` batches run as one multi-statement call where `pg` runs statement by statement
(≈400 statements on pg, 79 on PGlite); the tests assert those paths' final results and pass on both.
Index checks embed the process id in temp-table names (109 on each side, which SQL-text pairing cannot
match), and pg's schema rebuild accounts for 63.

**Do the results match?** Yes, outside four PGlite defaults and limits, all specific and all
catchable: text sort order (collation `C`), the fixed-offset session time zone, no ICU collations,
and one session. The `int8`, `bytea` and `Date`-parameter conventions, which differ in PGlite itself,
are aligned with `pg` by `PGliteClient` (before that alignment, a local-midnight `Date` landed on the
previous day in a `date` column on this host).

## Reproduce

```bash
# a database the runs may own: the runner drops and recreates the AppDatabase schema
createdb linkgress_test_pglite_cmp
psql -d linkgress_test_pglite_cmp -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent'
export DB_NAME=linkgress_test_pglite_cmp

# outcomes and timings (add -j 1 for a serial PGlite run)
bun tests/run.ts                 --json runs/pg.json
bun tests/run.ts --driver pglite --json runs/pglite.json

# statement results, in separate runs (recording hashes every row)
LINKGRESS_TEST_RECORD_DIR=runs/rec-pg     bun tests/run.ts                 --json runs/rec-pg.json
LINKGRESS_TEST_RECORD_DIR=runs/rec-pglite bun tests/run.ts --driver pglite --json runs/rec-pglite.json

node bench/pglite/compare-runs.mjs --a runs/pg.json --b runs/pglite.json
node bench/pglite/compare-runs.mjs --a runs/rec-pg.json --b runs/rec-pglite.json --a-rec runs/rec-pg --b-rec runs/rec-pglite

# per-operation latency and PGlite's boot costs, outside the test runner
node -r ts-node/register/transpile-only bench/pglite/latency.ts
```
