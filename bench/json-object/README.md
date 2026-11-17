# Objects of more than 50 keys: what each SQL form costs

One `json_build_object` call holds at most 50 keys — PostgreSQL passes at most 100 arguments to a function
(`FUNC_MAX_ARGS`; 54023 past it). Since 1.0.43 linkgress builds a wider object as `row_to_json` over a one-row
sub-select (`renderJsonBuildObject()`), and, for keys that cannot name a column and for the `jsonBuildObject()` /
`jsonBuildArray()` helpers, as the json texts of 50-key calls spliced (`spliceJsonTexts()`). This benchmark measures
what those forms cost per object against the alternatives.

## Run it

```bash
PGHOST=localhost PGPORT=5432 PGDATABASE=postgres bun bench/json-object/bench.ts 200000 5
BENCH_KEYS=51,60,120,200,51c bun bench/json-object/bench.ts   # the default key counts; `c`: the last value is a 20-child json_agg
```

- **Read-only, local only.** It refuses a host other than `localhost` / `127.0.0.1` / `::1`, sets the session
  `default_transaction_read_only = on`, and runs only `EXPLAIN (ANALYZE, TIMING OFF) SELECT <object> FROM
  generate_series(1, rows) g` — the object is built for every row, no table is read or written, nothing is created.
- `jit = off` and `max_parallel_workers_per_gather = 0`, so the figure is the expression's own cost.
- The forms run interleaved within each run; one warm-up run is discarded; the table is the median of `runs`
  (`Execution Time` / rows, µs per object).
- The row_to_json and splice forms are rendered by linkgress's own `renderJsonBuildObject()` / `spliceJsonTexts()`.

## Forms

| form | SQL | when linkgress uses it |
|---|---|---|
| hand-nested | `json_build_object('k0', …, 'c0', json_build_object(…50 keys…), …)` — the keys moved into containers of ≤ 50 | never: what a consumer had to do by hand to stay under the limit (a different object, the reference cost) |
| jsonb merge | `(jsonb_build_object(…50…) \|\| jsonb_build_object(…))::json` | never (1.0.43's first draft; reorders keys, re-serializes values) |
| row_to_json | `(SELECT row_to_json(r.*) FROM (SELECT v AS "k", …) r)` | every object a query builds, past 50 keys |
| text splice | `(left(json_build_object(…50…)::text, -1) \|\| ', ' \|\| right(json_build_object(…)::text, -1))::json` | keys empty / over 63 bytes, over 1 664 keys; `jsonBuildObject()` / `jsonBuildArray()` past the limit |

The values: round robin over an integer, a text, a numeric, a boolean, a NULL and a timestamptz computed from `g`
(columns of the row, as every value of an object a query builds is). Shapes: the object in the select list, and
inside `json_agg(…) GROUP BY g % 1000` (a collection's items).

## Results

PostgreSQL 18.6 (Homebrew) on localhost (Apple silicon, 18 cores, shared with other work), 200 000 rows, median of 5
runs, jit off, no parallel workers — 2026-11-17:

| keys | shape | hand-nested µs | jsonb merge µs | row_to_json µs | text splice µs | merge / hand | row_to_json / hand | splice / hand |
|---|---|---|---|---|---|---|---|---|
| 51 | select | 5.67 | 11.15 | 4.60 | 8.15 | 1.97× | 0.81× | 1.44× |
| 51 | json_agg | 6.22 | 11.56 | 5.11 | 8.83 | 1.86× | 0.82× | 1.42× |
| 60 | select | 6.72 | 12.95 | 5.65 | 9.53 | 1.93× | 0.84× | 1.42× |
| 60 | json_agg | 7.20 | 13.33 | 6.12 | 9.83 | 1.85× | 0.85× | 1.37× |
| 120 | select | 13.48 | 28.76 | 14.61 | 18.88 | 2.13× | 1.08× | 1.40× |
| 120 | json_agg | 14.25 | 29.85 | 15.57 | 19.69 | 2.10× | 1.09× | 1.38× |
| 200 | select | 23.06 | 51.31 | 40.46 | 42.87 | 2.23× | 1.75× | 1.86× |
| 200 | json_agg | 30.62 | 69.92 | 40.21 | 38.79 | 2.28× | 1.31× | 1.27× |
| 51 + 20-child json_agg | select | 15.25 | 30.37 | 14.06 | 20.33 | 1.99× | 0.92× | 1.33× |
| 51 + 20-child json_agg | json_agg | 16.35 | 34.76 | 14.96 | 20.96 | 2.13× | 0.91× | 1.28× |

`row_to_json / hand` over four runs of the same matrix (load between 3 and 19 — the absolute µs drift with it, the
ratios much less):

| keys | select | json_agg |
|---|---|---|
| 51 | 0.80–0.81× | 0.82–0.88× |
| 60 | 0.84–0.88× | 0.85–0.87× |
| 120 | 1.08–1.12× | 1.01–1.09× |
| 200 | 1.37–1.75× | 1.28–1.44× |
| 51 + 20-child json_agg (3 runs) | 0.90–0.92× | 0.91–0.92× |

## Reading it

- **At 51–60 keys `row_to_json` costs less than hand-nesting** (0.80–0.88×; 0.90–0.92× with a nested 20-child
  json_agg among the values). Its per-column cost grows with the width: +1–12 % at 120 keys and +28–75 % at 200. The
  crossover lies between 60 and 120 keys and was not measured. A projection of 120 keys or more on a hot path is
  cheaper nested by hand; correctness does not depend on it.
- The text splice costs 1.27–1.44× in the run above (1.86× in its 200-key select row, measured under a load spike;
  `json_in` validates the whole text once) and barely grows with the width: it catches up with `row_to_json` only at
  200 keys, so it stays the fallback.
- The jsonb merge costs ~1.85–2.3× everywhere, reorders the keys and rewrites values (`1e-07` → `0.0000001`) — not used.
