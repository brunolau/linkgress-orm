/**
 * Cost per object of the forms an object of more than 50 keys can take in SQL (one json_build_object call takes at most
 * 50 keys: PostgreSQL passes at most 100 arguments to a function). Read-only, on a LOCAL server: each form is measured
 * as `EXPLAIN (ANALYZE, TIMING OFF) SELECT <object> FROM generate_series(1, rows) g` — the projection is evaluated for
 * every row, nothing is read from or written to a table — in a session forced read-only.
 *
 *   PGHOST=localhost PGPORT=5432 PGDATABASE=postgres bun bench/json-object/bench.ts [rows=200000] [runs=5]
 *   BENCH_KEYS=51,60,120,200,51c …   (key counts; `c` = the last value a 20-child json_agg)
 *
 * Forms (all but hand-nested rendered by linkgress's own code: renderJsonBuildObject, spliceJsonTexts and
 * jsonbBuildObject, with LinkgressConfig.serverVersion unset or 16):
 * - hand-nested — json_build_object of the first keys flat and the rest in containers of ≤ 50: what a consumer does
 *   by hand to stay under the limit (not the same object: the reference cost)
 * - row_to_json — renderJsonBuildObject(), serverVersion unset / below 16: `(SELECT row_to_json(r.*) FROM (SELECT v AS
 *   "k", …) r)`
 * - JSON_OBJECT — renderJsonBuildObject() (and jsonBuildObject()) with serverVersion 16+: `JSON_OBJECT('k' VALUE v, …
 *   RETURNING json)`
 * - text splice — spliceJsonTexts() over 50-key calls: below 16 the fallback for keys that cannot name a column, and
 *   jsonBuildObject()'s form
 * - jsonb merge — jsonbBuildObject() below 16: `(jsonb_build_object(50) || jsonb_build_object(rest))`
 * - JSON_OBJECT jsonb — jsonbBuildObject() with serverVersion 16+: `JSON_OBJECT('k' VALUE v, … RETURNING jsonb)`
 * Each in the select list and inside `json_agg(…) GROUP BY` (1 000 groups); forms interleaved within a run; one
 * warm-up run discarded; the median of `runs`. jit and parallel workers off, so the figure is the expression's cost.
 */
import { Client } from 'pg';
import { loadavg } from 'os';
import { LinkgressConfig } from '../../src/config/linkgress-config';
import { sql } from '../../src/query/conditions';
import { jsonbBuildObject } from '../../src/query/sql-functions';
import { chunkJsonBuildArgs, JSON_BUILD_OBJECT_MAX_PAIRS, renderJsonBuildObject, spliceJsonTexts } from '../../src/query/sql-utils';
import type { JsonObjectEntry } from '../../src/query/sql-utils';

const rows = Number(process.argv[2] ?? 200000);
const runs = Number(process.argv[3] ?? 5);
const host = process.env.PGHOST ?? 'localhost';

if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  throw new Error(`refusing to benchmark against ${host}: localhost only`);
}

/** The value of key i over the row g: int, text, numeric, boolean, NULL, timestamptz, round robin. */
const valueOf = (i: number): string => {
  switch (i % 6) {
    case 0: return `g + ${i}`;
    case 1: return `'t' || g`;
    case 2: return `(g * 1.5)::numeric`;
    case 3: return `g % 2 = 0`;
    case 4: return 'NULL::int';
    default: return `timestamptz '2024-01-01 00:00:00+00' + g * interval '1 second'`;
  }
};
const CHILDREN = `(SELECT json_agg(json_build_object('x', s, 'y', g)) FROM generate_series(1, 20) s)`;

const entriesOf = (n: number, withChildren: boolean): JsonObjectEntry[] =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: withChildren && i === n - 1 ? CHILDREN : valueOf(i) }));
const pairs = (entries: readonly JsonObjectEntry[]) => entries.map(e => `'${e.key}', ${e.value}`).join(', ');

/** `render` with LinkgressConfig.serverVersion set to `version` for the call. */
const at = (version: number | undefined, render: () => string): string => {
  LinkgressConfig.serverVersion = version;
  try {
    return render();
  } finally {
    LinkgressConfig.resetToDefaults();
  }
};
/** What jsonbBuildObject() renders for the entries (values inlined as raw SQL). */
const jsonbHelper = (entries: readonly JsonObjectEntry[]) =>
  jsonbBuildObject(Object.fromEntries(entries.map(e => [e.key, sql.raw(e.value)]))).buildSql({ paramCounter: 1, params: [] });

const forms: Record<string, (entries: JsonObjectEntry[]) => string> = {
  handNested: entries => {
    const flat = 50 - Math.max(0, Math.ceil((entries.length - 50) / 49));
    const containers = chunkJsonBuildArgs(entries.slice(flat), JSON_BUILD_OBJECT_MAX_PAIRS).map((c, i) => `'c${i}', json_build_object(${pairs(c)})`);

    return `json_build_object(${[pairs(entries.slice(0, flat)), ...containers].filter(Boolean).join(', ')})`;
  },
  rowToJson: entries => at(undefined, () => renderJsonBuildObject(entries)),
  jsonObject: entries => at(16, () => renderJsonBuildObject(entries)),
  textSplice: entries => spliceJsonTexts(chunkJsonBuildArgs(entries, JSON_BUILD_OBJECT_MAX_PAIRS).map(c => `json_build_object(${pairs(c)})`)),
  jsonbMerge: entries => at(undefined, () => jsonbHelper(entries)),
  jsonObjectJsonb: entries => at(16, () => jsonbHelper(entries)),
};

const shapes: Record<string, (object: string) => string> = {
  select: object => `SELECT ${object} FROM generate_series(1, ${rows}) g`,
  json_agg: object => `SELECT g % 1000, json_agg(${object}) FROM generate_series(1, ${rows}) g GROUP BY 1`,
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const main = async () => {
  const client = new Client({ host, port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE ?? 'postgres' });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await client.query('SET jit = off');
  await client.query('SET max_parallel_workers_per_gather = 0');
  const version = (await client.query('SHOW server_version')).rows[0].server_version;

  console.log(`PostgreSQL ${version} on ${host}; ${rows} rows, median of ${runs} runs, jit off, no parallel workers; load ${loadavg().map(l => l.toFixed(1)).join(' ')}`);
  console.log('');
  console.log('| keys | shape | hand-nested µs | row_to_json µs | JSON_OBJECT µs | text splice µs | jsonb merge µs | JSON_OBJECT jsonb µs '
    + '| row_to_json / hand | JSON_OBJECT / hand | splice / hand | merge / hand | JSON_OBJECT jsonb / hand |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const spec of (process.env.BENCH_KEYS ?? '51,60,120,200,51c').split(',')) {
    const withChildren = spec.endsWith('c');
    const entries = entriesOf(Number(spec.replace('c', '')), withChildren);

    const objects = Object.fromEntries(Object.entries(forms).map(([formName, form]) => [formName, form(entries)]));

    for (const [shapeName, shape] of Object.entries(shapes)) {
      const times: Record<string, number[]> = Object.fromEntries(Object.keys(forms).map(formName => [formName, []]));

      for (let run = -1; run < runs; run++) {
        for (const formName of Object.keys(forms)) {
          const result = await client.query(`EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${shape(objects[formName])}`);

          if (run >= 0) {
            times[formName].push(result.rows[0]['QUERY PLAN'][0]['Execution Time']);
          }
        }
      }

      const us = (form: string) => (median(times[form]) * 1000) / rows;
      const hand = us('handNested');
      const others = ['rowToJson', 'jsonObject', 'textSplice', 'jsonbMerge', 'jsonObjectJsonb'].map(us);
      console.log(
        `| ${entries.length}${withChildren ? ' + 20-child json_agg' : ''} | ${shapeName} | ${hand.toFixed(2)} | ${others.map(v => v.toFixed(2)).join(' | ')} `
        + `| ${others.map(v => `${(v / hand).toFixed(2)}×`).join(' | ')} |`
      );
    }
  }

  await client.end();
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
