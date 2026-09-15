# In-memory database vs PostgreSQL: the linkgress suite on both

The whole suite (140 files, 1,865 tests) run against a local PostgreSQL 18 server and against the
built-in in-memory database, through the same drivers and the same test code — plus the latency of
individual operations on both. Every run passed all 1,865 tests, with identical outcomes per test
(`bun run test:parity`).

## Setup

| | |
| --- | --- |
| Host | AMD Ryzen 9 7900X (12 cores / 24 threads), 63 GB RAM, Windows 11 Pro (26200) |
| Runtime | Bun 1.4.2, `bun tests/run.ts` — every test file in its own `bun test` process |
| Server | PostgreSQL 18 on localhost over TCP, `pg` driver, database `linkgress_test` |
| In memory | `bun tests/run.ts --memory`: the schema built once into a snapshot, every file's database restored from it; the `pg` / `postgres` modules connect over an in-process socket |
| Runs | two repetitions of each configuration, alternated (pg, memory serial, memory parallel, then again); figures are the mean of the two |

PostgreSQL runs are serial: every file shares the one test database. In memory every file has its own
database, so files can also run in parallel — the default is half the logical cores (12 here).

## The suite

| run | wall time, run 1 / run 2 | vs PostgreSQL |
| --- | --- | --- |
| PostgreSQL, serial | 112.1 s / 124.8 s | — |
| in memory, serial (`-j 1`) | 44.0 s / 43.8 s | **2.7× faster** |
| in memory, 12 files in parallel (default) | 14.1 s / 13.8 s | **8.5× faster** |
| *for reference: PGlite, 8 files in parallel* | *21.0 s* | *5.6× faster* |

Wall time includes the global setup (creating the PostgreSQL schema / building the in-memory snapshot,
each under a second). The in-memory runs are also steadier: the two PostgreSQL runs differ by 12.7 s
(15.1 s summed over files), the serial in-memory ones by 0.2 s (4.3 s over files).

### Per file (serial runs)

| | PostgreSQL | in memory |
| --- | --- | --- |
| sum of per-file times | 118.0 s | 43.7 s |
| median file | 408 ms | 196 ms |
| fastest file (process start included) | 41 ms | 95 ms |
| files faster / slower in memory | — | 105 / 35 |
| median per-file ratio (memory / pg) | — | 0.55× (p10 0.14×, p90 2.19×) |

By how long a file takes on PostgreSQL:

| pg time per file | files | PostgreSQL | in memory | memory / pg |
| --- | --- | --- | --- | --- |
| < 0.5 s | 78 | 16.9 s | 13.1 s | 0.77× |
| 0.5–2 s | 45 | 43.2 s | 12.8 s | 0.30× |
| > 2 s | 17 | 57.9 s | 17.8 s | 0.31× |

**Largest savings** — the database-heavy files:

| file | tests | PostgreSQL | in memory | memory / pg |
| --- | --- | --- | --- | --- |
| `queries/all-strategies-comparison` | 21 | 5.17 s | 0.48 s | 0.09× |
| `queries/navigation-advanced` | 55 | 4.67 s | 0.40 s | 0.09× |
| `queries/complex-query-combinations` | 19 | 4.36 s | 0.48 s | 0.11× |
| `queries/subqueries` | 48 | 4.00 s | 0.39 s | 0.10× |
| `queries/returning-clause` | 50 | 3.73 s | 0.30 s | 0.08× |
| `mutations/insert-update-delete` | 47 | 3.38 s | 0.30 s | 0.09× |
| `queries/lateral-strategy` | 43 | 3.33 s | 0.35 s | 0.10× |
| `queries/toDriver-mapper` | 35 | 2.89 s | 0.34 s | 0.12× |

**Slower in memory**:

| file | tests | PostgreSQL | in memory | why |
| --- | --- | --- | --- | --- |
| `queries/query-timeout` | 14 | 7.13 s | 9.55 s | waits on `pg_sleep` and statement timeouts — wall-clock time either way |
| `database/prepared-statements` | 13 | 0.63 s | 1.53 s | its own clients and pools per test: each connection starts a session on the in-memory database |
| files that never touch a database (`migration/index-sql`, `queries/renumber-placeholders`, …) | 5–43 | ~0.04 s | ~0.10 s | the memory-mode preload loads the engine and restores the snapshot (~55 ms) even when a file does not use it |

## Where the time goes

Per operation, measured outside the test runner with `bench/in-memory/latency.ts` — the same `PgClient`
and statements on each target, warm:

| operation | PostgreSQL | in memory | memory / pg | in memory, worker thread | thread / pg |
| --- | --- | --- | --- | --- | --- |
| `SELECT $1` | 0.076 ms | 0.038 ms | 0.49× | 0.091 ms | 1.20× |
| INSERT one row, autocommit | 0.165 ms | 0.041 ms | 0.25× | 0.106 ms | 0.64× |
| INSERT inside a 100-row transaction, per row | 0.079 ms | 0.026 ms | 0.33× | 0.078 ms | 0.99× |
| **per-test reset: `TRUNCATE` 22 tables + `seedTestData`** | **70.36 ms** | **1.96 ms** | **0.03×** | 3.44 ms | 0.05× |
| ORM read: users with their posts (CTE `json_agg`) | 0.251 ms | 0.280 ms | 1.11× | 0.362 ms | 1.44× |
| ORM read with a filter and ordering | 0.166 ms | 0.119 ms | 0.72× | 0.185 ms | 1.11× |
| DDL: `CREATE TABLE` + `CREATE INDEX` + `DROP TABLE` | 5.04 ms | 0.54 ms | 0.11× | 0.78 ms | 0.15× |

Starting an in-memory database: 46 ms to create (the engine's built-in catalog), 43 ms to build the
AppDatabase schema, 2.7 ms to snapshot it (77 KB), 2.9 ms to restore the snapshot to a first result.

- **The reset dominates.** The suite resets the database before most tests; `TRUNCATE` makes PostgreSQL
  create new relation files and flush, 70 ms each, against 2 ms in memory. That alone accounts for most
  of the 0.30× on the database-heavy files.
- **Writes and DDL are 4–10× cheaper in memory**: no WAL, no fsync, no files.
- **Simple statements are about twice as fast**: no TCP round trip, the protocol is handled in process.
- **Complex reads are on par** (0.7–1.1×): the in-memory engine plans and executes in TypeScript, where
  PostgreSQL's executor is native C — the round trip it saves is eaten by execution.
- **The worker thread** adds a message-channel hop per round trip (~0.05 ms): slower than in-process for
  short statements, still far ahead wherever the server touches the disk. It exists for tests that block
  their own thread (e.g. `spawnSync('psql', …)`).
- **Files without database work pay ~55 ms** for loading the engine and restoring the snapshot in memory
  mode — why the < 0.5 s bucket gains least.

## The parity run (`bun run test:parity`, the publish gate)

A parity run runs the in-memory leg in parallel beside the serial PostgreSQL leg and compares the two
result sets once both are complete. Measured alternately against running the two legs one after the other:

| | run 1 | run 2 |
| --- | --- | --- |
| both legs at once | 121.5 s | 119.8 s |
| PostgreSQL, then memory | 115.3 s + 13.6 s = 128.9 s | 109.6 s + 12.5 s = 122.1 s |

About 5 s (4%) saved: the in-memory leg finishes in ~13 s either way, and the PostgreSQL leg — serial,
because every file shares one database — sets the length of the run; the 12 parallel in-memory files
slow its first seconds a little. Running the PostgreSQL leg itself in parallel would need a database
per worker.

## A large application suite

Measured in a downstream application (17,225 Jest tests on Node, 10 workers, not this repository's
runner): PostgreSQL 229 s, in memory 251 s, with 17,224 identical test outcomes. There the suite's
statement-level audit triggers run on every write in both configurations, and the per-test work is
dominated by application logic rather than resets — the in-memory database replaces the server and its
per-worker template setup (about 3.5 minutes) without making the tests themselves faster.

## Reproduce

```bash
# the suite (repeat, alternating, for stable figures)
bun tests/run.ts                  --json runs/pg.json
bun tests/run.ts --memory -j 1    --json runs/memory-serial.json
bun tests/run.ts --memory         --json runs/memory-parallel.json

# per-file comparison of two runs
node bench/pglite/compare-runs.mjs --a runs/pg.json --b runs/memory-serial.json --a-name pg --b-name memory

# per-operation latency (DB_NAME must contain "test": the AppDatabase schema is dropped there)
bun bench/in-memory/latency.ts
```
