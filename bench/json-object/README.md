# Objects of more than 50 keys: what each SQL form costs

One `json_build_object` call holds at most 50 keys — PostgreSQL passes at most 100 arguments to a function
(`FUNC_MAX_ARGS`; 54023 past it). Since 1.0.43 linkgress builds a wider object (`renderJsonBuildObject()`) as ONE
`JSON_OBJECT('k' VALUE v, … RETURNING json)` when `LinkgressConfig.serverVersion` is 16 or more — a SQL/JSON
constructor, not a function call — and otherwise (the default) as `row_to_json` over a one-row sub-select, or, for
keys that cannot name a column, as the json texts of 50-key calls spliced (`spliceJsonTexts()`). The json(b) helpers
past the cap: `JSON_OBJECT(… RETURNING json|jsonb)` on 16+, below it the splice (json) and `||` (jsonb). This
benchmark measures what those forms cost per object against the alternatives.

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
- Every form but hand-nested is rendered by linkgress's own code — `renderJsonBuildObject()`, `spliceJsonTexts()`,
  `jsonbBuildObject()` — with `LinkgressConfig.serverVersion` unset (row_to_json, jsonb merge) or 16 (the two
  `JSON_OBJECT` forms).

## Forms

| form | SQL | when linkgress uses it |
|---|---|---|
| hand-nested | `json_build_object('k0', …, 'c0', json_build_object(…50 keys…), …)` — the keys moved into containers of ≤ 50 | never: what a consumer had to do by hand to stay under the limit (a different object, the reference cost) |
| row_to_json | `(SELECT row_to_json(r.*) FROM (SELECT v AS "k", …) r)` | every object a query builds, past 50 keys — `serverVersion` unknown (the default) or below 16 |
| JSON_OBJECT | `JSON_OBJECT('k' VALUE v, … RETURNING json)` | every object a query builds past 50 keys, and `jsonBuildObject()` past 50 — `serverVersion` 16+ |
| text splice | `(left(json_build_object(…50…)::text, -1) \|\| ', ' \|\| right(json_build_object(…)::text, -1))::json` | below 16 / unknown: keys empty / over 63 bytes, over 1 664 keys; `jsonBuildObject()` / `jsonBuildArray()` past the limit |
| jsonb merge | `(jsonb_build_object(…50…) \|\| jsonb_build_object(…))` | below 16 / unknown: `jsonbBuildObject()` past 50 keys (1.0.43's first draft used it, cast to json, for every object) |
| JSON_OBJECT jsonb | `JSON_OBJECT('k' VALUE v, … RETURNING jsonb)` | `jsonbBuildObject()` past 50 keys — `serverVersion` 16+ |

The values: round robin over an integer, a text, a numeric, a boolean, a NULL and a timestamptz computed from `g`
(columns of the row, as every value of an object a query builds is). Shapes: the object in the select list, and
inside `json_agg(…) GROUP BY g % 1000` (a collection's items).

## Results

PostgreSQL 18.6 (Homebrew) on localhost (Apple silicon, 18 cores, shared with other work), 200 000 rows, median of 5
runs, jit off, no parallel workers, load 5.1 falling to 1.8 over the run — 2026-11-17:

| keys | shape | hand-nested µs | row_to_json µs | JSON_OBJECT µs | text splice µs | jsonb merge µs | JSON_OBJECT jsonb µs | row_to_json / hand | JSON_OBJECT / hand | splice / hand | merge / hand | JSON_OBJECT jsonb / hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 51 | select | 8.13 | 6.15 | 7.42 | 11.62 | 11.79 | 8.97 | 0.76× | 0.91× | 1.43× | 1.45× | 1.10× |
| 51 | json_agg | 7.71 | 6.21 | 6.76 | 10.44 | 12.97 | 10.35 | 0.81× | 0.88× | 1.35× | 1.68× | 1.34× |
| 60 | select | 8.05 | 6.92 | 7.61 | 11.19 | 11.78 | 8.88 | 0.86× | 0.94× | 1.39× | 1.46× | 1.10× |
| 60 | json_agg | 7.87 | 6.97 | 7.71 | 10.00 | 12.19 | 10.41 | 0.89× | 0.98× | 1.27× | 1.55× | 1.32× |
| 120 | select | 13.12 | 14.72 | 12.43 | 18.39 | 22.27 | 14.44 | 1.12× | 0.95× | 1.40× | 1.70× | 1.10× |
| 120 | json_agg | 14.10 | 15.50 | 13.03 | 19.45 | 26.70 | 18.84 | 1.10× | 0.92× | 1.38× | 1.89× | 1.34× |
| 200 | select | 22.67 | 31.95 | 21.32 | 31.10 | 39.39 | 24.18 | 1.41× | 0.94× | 1.37× | 1.74× | 1.07× |
| 200 | json_agg | 23.91 | 34.25 | 22.06 | 33.33 | 47.16 | 31.86 | 1.43× | 0.92× | 1.39× | 1.97× | 1.33× |
| 51 + 20-child json_agg | select | 11.04 | 10.09 | 10.53 | 14.45 | 18.40 | 15.04 | 0.91× | 0.95× | 1.31× | 1.67× | 1.36× |
| 51 + 20-child json_agg | json_agg | 11.72 | 10.73 | 11.26 | 15.21 | 22.42 | 18.87 | 0.92× | 0.96× | 1.30× | 1.91× | 1.61× |

(`row_to_json` and the splice: the forms below 16 / unknown; the two `JSON_OBJECT` columns: the forms with
`serverVersion` 16+; jsonb merge and `JSON_OBJECT jsonb`: `jsonbBuildObject()` below and from 16. The run of 1.0.43's
first form, without the `JSON_OBJECT` columns, measured `row_to_json` / hand at 0.80–0.88× (51–60 keys), 1.01–1.12×
(120) and 1.28–1.75× (200) over four runs under load 3–19.)

## Reading it

- **`JSON_OBJECT` (16+) costs 0.88–0.98× the hand-nested object at every width** (0.95–0.96× with a 20-child
  `json_agg` among 51 keys): its cost grows linearly with the keys. `row_to_json` is cheaper at 51–60 keys
  (`JSON_OBJECT` costs +9–21 % over it there, +4–5 % with the 20-child value) and dearer from 120 keys on
  (`JSON_OBJECT` −16 % at 120, −33–36 % at 200, where `row_to_json` costs 1.41–1.43× hand-nesting).
- For `jsonbBuildObject()` past 50 keys, `JSON_OBJECT(… RETURNING jsonb)` costs 0.61–0.85× the `||` merge of
  50-key calls it replaces on 16+.
- The text splice (below 16: keys that cannot name a column, `jsonBuildObject()`) costs 1.27–1.43× everywhere.
- A 50 000-row prototype of the same forms (3 runs, load 7–12) gave `JSON_OBJECT` / hand 0.82–1.04× and the same
  ordering: `row_to_json` ahead up to 60 keys, `JSON_OBJECT` ahead from 120.
