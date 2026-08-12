// QueryBatch transport benchmark harness.
// Usage: node run.mjs --profile=direct|lat1|lat5 [--scenarios=S,M,L] [--quick] [--explain]
// Profiles: direct -> :5432, lat1 -> :6432 (+1ms/dir proxy), lat5 -> :6433 (+5ms/dir proxy).
// Methodology: per scenario -> parity check vs seq-pool reference, warmup rounds, then
// interleaved measurement (every variant once per round, rotated start order) -> p50/p90/max/mean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import pg from 'pg';
import { scenarios } from './scenarios.mjs';
import { variants } from './variants.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(DIR, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const PORTS = { direct: 5432, lat1: 6432, lat5: 6433 };
const ITERS = {
	direct: { S: 200, M: 100, L: 25 },
	lat1: { S: 60, M: 24, L: 8 },
	lat5: { S: 40, M: 16, L: 6 },
};
const WARMUP = { S: 15, M: 8, L: 3 };

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);

		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);

const profile = args.profile ?? 'direct';
const scenarioNames = (args.scenarios ?? 'S,M,L').split(',');
const port = PORTS[profile];

if (!port) {
	console.error(`unknown profile ${profile}`);
	process.exit(1);
}

// ---- canonicalization for parity checks (unifies native vs JSON value semantics) ----
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

const canon = (v) => {
	if (v === null || v === undefined) {
		return null;
	}

	if (v instanceof Date) {
		return `ts:${v.getTime()}`;
	}

	if (Array.isArray(v)) {
		return v.map(canon);
	}

	if (typeof v === 'object') {
		const o = {};

		for (const k of Object.keys(v).sort()) {
			o[k] = canon(v[k]);
		}

		return o;
	}

	if (typeof v === 'string') {
		if (TS_RE.test(v)) {
			const t = Date.parse(v);

			if (!Number.isNaN(t)) {
				return `ts:${t}`;
			}
		}

		if (NUM_RE.test(v)) {
			return `num:${Number(v)}`;
		}

		return v;
	}

	if (typeof v === 'number') {
		return `num:${v}`;
	}

	return v;
};

const firstDiff = (ref, got, prefix = '') => {
	const a = JSON.stringify(ref);
	const b = JSON.stringify(got);

	if (a === b) {
		return null;
	}

	if (ref && got && typeof ref === 'object' && typeof got === 'object') {
		const keys = new Set([...Object.keys(ref), ...Object.keys(got)]);

		for (const k of keys) {
			const d = firstDiff(ref[k], got[k], `${prefix}.${k}`);

			if (d) {
				return d;
			}
		}
	}

	return `${prefix}: ref=${String(a).slice(0, 120)} got=${String(b).slice(0, 120)}`;
};

const stats = (samples) => {
	const s = [...samples].sort((x, y) => x - y);
	const pick = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];

	return {
		p50: pick(50),
		p90: pick(90),
		max: s[s.length - 1],
		mean: s.reduce((a, b) => a + b, 0) / s.length,
		n: s.length,
	};
};

const round2 = (x) => Math.round(x * 100) / 100;

// ---- connections ----
const url = `postgres://postgres:admin@127.0.0.1:${port}/linkgress_querybatch_bench`;
const quiet = { onnotice: () => {} };
const pool = postgres(url, { max: 10, prepare: false, ...quiet });
const single = postgres(url, { max: 1, prepare: false, ...quiet });
// prepared-statement instances: postgres.js ignores per-query {prepare:true} unless the
// INSTANCE was created with prepare:true (instance-level false is a hard kill-switch)
const poolPrep = postgres(url, { max: 10, prepare: true, ...quiet });
const singlePrep = postgres(url, { max: 1, prepare: true, ...quiet });
const pgClient = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'admin', database: 'linkgress_querybatch_bench' });
await pgClient.connect();

const ctx = { pool, single, poolPrep, singlePrep, pgClient };

// open all pool connections up front so pool size doesn't drift mid-measurement
await Promise.all(Array.from({ length: 10 }, () => pool.unsafe('select 1')));
await Promise.all(Array.from({ length: 10 }, () => poolPrep.unsafe('select 1')));
await single.unsafe('select 1');
await singlePrep.unsafe('select 1');
await pgClient.query('select 1');

// ---- RTT calibration ----
const rttSamples = [];

for (let i = 0; i < 30; i++) {
	const t0 = performance.now();
	await single.unsafe('select 1');
	rttSamples.push(performance.now() - t0);
}

const rtt = stats(rttSamples.slice(5));
console.log(`profile=${profile} port=${port} | roundtrip(select 1): p50=${round2(rtt.p50)}ms p90=${round2(rtt.p90)}ms`);

const output = { profile, port, node: process.version, roundtripMs: { p50: round2(rtt.p50), p90: round2(rtt.p90) }, scenarios: {} };

// ---- run scenarios ----
for (const name of scenarioNames) {
	const queries = scenarios[name];

	if (!queries) {
		console.error(`unknown scenario ${name}`);
		continue;
	}

	const iters = args.quick ? 5 : ITERS[profile][name];
	const warmup = args.quick ? 1 : WARMUP[name];
	console.log(`\n=== scenario ${name}: ${queries.length} queries, iters=${iters}, warmup=${warmup} ===`);

	const prepared = variants.map((v) => ({ v, p: v.prepare(queries) }));
	const state = new Map(prepared.map(({ v }) => [v.name, { samples: [], parity: 'pending', bytes: 0, error: null }]));

	// parity: seq-pool is the reference implementation
	const refVariant = prepared.find(({ v }) => v.name === 'seq-pool');
	const reference = await refVariant.v.run(ctx, refVariant.p);
	const refCanon = canon(reference);

	for (const { v, p } of prepared) {
		const st = state.get(v.name);

		try {
			const result = v.name === 'seq-pool' ? reference : await v.run(ctx, p);
			st.bytes = JSON.stringify(result).length;
			const diff = v.name === 'seq-pool' ? null : firstDiff(refCanon, canon(result));
			st.parity = diff ? `MISMATCH ${diff}` : 'ok';

			if (diff) {
				console.log(`  parity ${v.name}: ${st.parity}`);
			}
		} catch (e) {
			st.error = String(e?.message ?? e);
			st.parity = 'ERROR';
			console.log(`  ERROR ${v.name}: ${st.error}`);
		}
	}

	const runnable = prepared.filter(({ v }) => !state.get(v.name).error);

	// warmup
	for (let w = 0; w < warmup; w++) {
		for (const { v, p } of runnable) {
			await v.run(ctx, p);
		}
	}

	// interleaved measurement with rotated order
	for (let i = 0; i < iters; i++) {
		for (let j = 0; j < runnable.length; j++) {
			const { v, p } = runnable[(i + j) % runnable.length];
			const t0 = performance.now();
			await v.run(ctx, p);
			state.get(v.name).samples.push(performance.now() - t0);
		}
	}

	const table = [];
	const scenarioOut = {};

	for (const { v } of prepared) {
		const st = state.get(v.name);
		const s = st.samples.length > 0 ? stats(st.samples) : null;
		scenarioOut[v.name] = {
			group: v.group,
			p50: s ? round2(s.p50) : null,
			p90: s ? round2(s.p90) : null,
			max: s ? round2(s.max) : null,
			mean: s ? round2(s.mean) : null,
			n: s ? s.n : 0,
			resultBytes: st.bytes,
			parity: st.parity,
			error: st.error,
		};
		table.push({
			variant: v.name,
			group: v.group,
			'p50 ms': s ? round2(s.p50) : 'ERR',
			'p90 ms': s ? round2(s.p90) : 'ERR',
			'max ms': s ? round2(s.max) : '-',
			parity: st.parity === 'ok' ? 'ok' : st.parity.slice(0, 40),
		});
	}

	table.sort((a, b) => (a['p50 ms'] === 'ERR' ? 1e9 : a['p50 ms']) - (b['p50 ms'] === 'ERR' ? 1e9 : b['p50 ms']));
	console.table(table);
	output.scenarios[name] = { queryCount: queries.length, iters, ...{ variants: scenarioOut } };
}

// ---- EXPLAIN capture (single-statement variants) ----
if (args.explain) {
	for (const name of scenarioNames) {
		const queries = scenarios[name];

		if (!queries) {
			continue;
		}

		for (const v of variants.filter((x) => x.group === 'single-statement' && x.name !== 'simple-multi')) {
			const p = v.prepare(queries);
			const rows = await pool.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${p.text}`, p.params);
			const text = rows.map((r) => r['QUERY PLAN']).join('\n');
			fs.writeFileSync(path.join(RESULTS_DIR, `explain-${name}-${v.name}.txt`), text);
		}

		// standalone branch for plan comparison
		const q0 = queries[0];
		const rows = await pool.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${q0.sql}`, q0.params);
		fs.writeFileSync(path.join(RESULTS_DIR, `explain-${name}-standalone-${q0.key}.txt`), rows.map((r) => r['QUERY PLAN']).join('\n'));
	}

	console.log('EXPLAIN plans written to results/');
}

const outFile = path.join(RESULTS_DIR, `${profile}.json`);
fs.writeFileSync(outFile, JSON.stringify(output, null, '\t'));
console.log(`\nresults -> ${outFile}`);

await pool.end();
await single.end();
await poolPrep.end();
await singlePrep.end();
await pgClient.end();
