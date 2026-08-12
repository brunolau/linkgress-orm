# QueryBatch transport benchmark

Measures every candidate transport for a future linkgress `QueryBatch` (N dashboard queries
delivered in as few round trips as possible), against real PostgreSQL with realistic data volumes.

## What is compared

| Variant | Group | Transport |
|---|---|---|
| `seq-pool` | baseline | await each query on a pool (current dashboard reality) |
| `parallel-pool` | baseline | `Promise.all` on a pool of 10 |
| `pipeline-postgresjs` | pipeline | all queries fired unawaited on ONE postgres.js connection, `prepare:false` |
| `pipeline-prepared` | pipeline | same, but on a `prepare:true` instance — enables true wire pipelining |
| `pipeline-begin` | pipeline | `sql.begin(sql => [...])` documented pipeline form (adds BEGIN/COMMIT) |
| `pg-1conn-queue` | pipeline | node-postgres single connection, unawaited (internal queue — pg has NO pipeline mode) |
| `union-json-agg` | single-statement | `UNION ALL` of `(identifier, json_agg(rows))` — the original QueryBatch proposal |
| `union-json-agg-prep` | single-statement | same statement, prepared (`prepare:true` instance) |
| `union-row-json` | single-statement | `UNION ALL` of `(identifier, to_json(row))` per row |
| `scalar-subqueries` | single-statement | one SELECT, one json scalar-subquery column per query |
| `json-build-object` | single-statement | one SELECT returning a single `json_build_object` blob |
| `simple-multi` | single-statement | semicolon-joined statements over simple protocol (params must be inlined) |

Every variant must deliver the same logical `{ key: rows[] | row | count }` result; parity is
deep-checked against `seq-pool` each run (dates/numerics canonicalized across native vs JSON).

## Scenarios

- **S** — typical dashboard: 12 queries (~185 rows: lists 5–50 rows, firstOrDefault, counts)
- **M** — heavy dashboard: 30 queries (~2 400 rows, includes 500-row lists + group-by widget)
- **L** — stress: 10 × 2 000-row lists (~20k rows, ~2.3MB logical payload)

Data: `linkgress_querybatch_bench` DB — users 100k, orders 1M, tickets 2M, payments 1M rows;
customer/event ids 1..4 own exactly 5/50/500/5000 rows (deterministic result sizes), indexed.

## How to run

```bash
node bench/querybatch/seed.mjs          # drops + recreates linkgress_querybatch_bench (~20s)

node bench/querybatch/run.mjs --profile=direct --scenarios=S,M,L --explain

node bench/querybatch/proxy.mjs 6432 5432 1   # keep running in another terminal
node bench/querybatch/run.mjs --profile=lat1 --scenarios=S,M,L
```

Results land in `results/{profile}.json`; EXPLAIN plans in `results/explain-*.txt`.
`--quick` = 5 iters smoke run. Connection is hardcoded to `postgres:admin@127.0.0.1:5432`.

Note: on Windows the proxy's `setTimeout` granularity is ~15.6ms, so `lat1` measures a ~31ms-RTT
network, not 1ms — treat it as the "high latency" datapoint and read round-trip COUNTS from it
(they transfer to any RTT: `t ≈ t_direct + k × RTT`).

## Key mechanism facts the numbers reflect (postgres.js 3.4.7, pg 8.16.3)

1. **Unprepared parameterized queries cost 2 round trips** — postgres.js sends
   Parse/Describe first, waits, then Bind/Execute (`connection.js:233`:
   `describeFirst = parameters.length && !q.prepared`). This is every linkgress
   query today (`sql.unsafe`, `prepare:false`).
2. **describe-first also blocks wire pipelining** — concurrent unsafe queries on one
   connection serialize (2 RTT each). With a `prepare:true` instance (+ per-query
   `{prepare:true}`), statements are cached after first use, drop to 1 RTT, and DO pipeline
   (whole batch ≈ 1 RTT).
3. **Instance-level `prepare:false` is a hard kill-switch** — per-query `{prepare:true}`
   on such an instance silently does nothing.
4. **node-postgres has no pipeline mode** — one query on the wire at a time per connection
   (1 RTT each; no describe round trip though).
