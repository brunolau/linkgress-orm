// All QueryBatch transport strategies under comparison.
// Every variant receives prebuilt SQL (built once per scenario, like an ORM compiling a batch)
// and must return the SAME logical result: { [key]: rows[] | row | number } — parsing included,
// so timings cover delivering ready-to-use JS values, not just wire transfer.

const renumber = (sql, offset) => sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);

const inlineParams = (sql, params) =>
	sql.replace(/\$(\d+)/g, (_, n) => {
		const v = params[Number(n) - 1];

		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new Error(`simple-multi can only inline numeric params, got: ${typeof v}`);
		}

		return String(v);
	});

const finalize = (q, rows) => {
	if (q.kind === 'list') {
		return rows;
	}

	if (q.kind === 'first') {
		return rows.length > 0 ? rows[0] : null;
	}

	return rows.length > 0 ? Number(rows[0].count) : 0;
};

// json value (already parsed by driver) -> same logical shape
const finalizeJson = (q, value) => {
	if (q.kind === 'list') {
		return value ?? [];
	}

	if (q.kind === 'first') {
		if (Array.isArray(value)) {
			return value.length > 0 ? value[0] : null;
		}

		return value ?? null;
	}

	const row = Array.isArray(value) ? value[0] : value;

	return row ? Number(row.count) : 0;
};

// ---- single-statement SQL builders ----

const buildUnionJsonAgg = (queries) => {
	const parts = [];
	const params = [];

	for (const q of queries) {
		parts.push(
			`SELECT '${q.key}' AS k, coalesce(json_agg(row_to_json(t)), '[]'::json) AS v FROM (${renumber(q.sql, params.length)}) t`,
		);
		params.push(...q.params);
	}

	return { text: parts.join('\nUNION ALL\n'), params };
};

const buildUnionRowJson = (queries) => {
	const parts = [];
	const params = [];

	for (const q of queries) {
		parts.push(`SELECT '${q.key}' AS k, to_json(t) AS v FROM (${renumber(q.sql, params.length)}) t`);
		params.push(...q.params);
	}

	return { text: parts.join('\nUNION ALL\n'), params };
};

const jsonColumnExpr = (q, paramOffset) => {
	const inner = renumber(q.sql, paramOffset);

	if (q.kind === 'list') {
		return `(SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${inner}) t)`;
	}

	return `(SELECT row_to_json(t) FROM (${inner}) t)`;
};

const buildScalarSubqueries = (queries) => {
	const cols = [];
	const params = [];

	for (const q of queries) {
		cols.push(`${jsonColumnExpr(q, params.length)} AS "${q.key}"`);
		params.push(...q.params);
	}

	return { text: `SELECT\n${cols.join(',\n')}`, params };
};

const buildJsonBuildObject = (queries) => {
	const pairs = [];
	const params = [];

	for (const q of queries) {
		pairs.push(`'${q.key}', ${jsonColumnExpr(q, params.length)}`);
		params.push(...q.params);
	}

	return { text: `SELECT json_build_object(\n${pairs.join(',\n')}) AS batch`, params };
};

const buildSimpleMulti = (queries) => ({
	text: queries.map((q) => inlineParams(q.sql, q.params)).join(';\n'),
	params: [],
});

// ---- variants ----

export const variants = [
	{
		name: 'seq-pool',
		group: 'baseline',
		desc: 'await each query one-by-one on the pool (current dashboard reality)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalize(q, await ctx.pool.unsafe(q.sql, q.params));
			}

			return out;
		},
	},
	{
		name: 'parallel-pool',
		group: 'baseline',
		desc: 'Promise.all on pool of 10 (N concurrent connections)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const results = await Promise.all(p.queries.map((q) => ctx.pool.unsafe(q.sql, q.params)));
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, results[i])));

			return out;
		},
	},
	{
		name: 'pipeline-postgresjs',
		group: 'pipeline',
		desc: 'fire all on ONE postgres.js connection without awaiting (true wire pipelining)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const results = await Promise.all(p.queries.map((q) => ctx.single.unsafe(q.sql, q.params)));
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, results[i])));

			return out;
		},
	},
	{
		name: 'pipeline-begin',
		group: 'pipeline',
		desc: 'postgres.js sql.begin(sql => [...queries]) — documented pipeline form (adds BEGIN/COMMIT)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const results = await ctx.single.begin((sql) => p.queries.map((q) => sql.unsafe(q.sql, q.params)));
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, results[i])));

			return out;
		},
	},
	{
		name: 'pipeline-prepared',
		group: 'pipeline',
		desc: 'ONE postgres.js connection + prepared statements (instance prepare:true) — skips describe-first, enabling REAL wire pipelining (1 RTT/batch after warmup)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const results = await Promise.all(p.queries.map((q) => ctx.singlePrep.unsafe(q.sql, q.params, { prepare: true })));
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, results[i])));

			return out;
		},
	},
	{
		name: 'pg-1conn-queue',
		group: 'pipeline',
		desc: 'node-postgres single connection, all fired unawaited (internal queue, NOT wire-pipelined)',
		prepare: (queries) => ({ queries }),
		run: async (ctx, p) => {
			const results = await Promise.all(p.queries.map((q) => ctx.pgClient.query(q.sql, q.params)));
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, results[i].rows)));

			return out;
		},
	},
	{
		name: 'union-json-agg',
		group: 'single-statement',
		desc: 'UNION ALL of (identifier, json_agg(rows)) — original QueryBatch proposal',
		prepare: (queries) => ({ queries, ...buildUnionJsonAgg(queries) }),
		run: async (ctx, p) => {
			const rows = await ctx.pool.unsafe(p.text, p.params);
			const byKey = {};

			for (const r of rows) {
				byKey[r.k] = r.v;
			}

			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalizeJson(q, byKey[q.key]);
			}

			return out;
		},
	},
	{
		name: 'union-json-agg-prep',
		group: 'single-statement',
		desc: 'UNION ALL + json_agg as a prepared statement — stable batch text prepared once per connection, 1 RTT afterwards',
		prepare: (queries) => ({ queries, ...buildUnionJsonAgg(queries) }),
		run: async (ctx, p) => {
			const rows = await ctx.poolPrep.unsafe(p.text, p.params, { prepare: true });
			const byKey = {};

			for (const r of rows) {
				byKey[r.k] = r.v;
			}

			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalizeJson(q, byKey[q.key]);
			}

			return out;
		},
	},
	{
		name: 'union-row-json',
		group: 'single-statement',
		desc: 'UNION ALL of (identifier, to_json(row)) per ROW — no aggregation',
		prepare: (queries) => ({ queries, ...buildUnionRowJson(queries) }),
		run: async (ctx, p) => {
			const rows = await ctx.pool.unsafe(p.text, p.params);
			const byKey = {};

			for (const r of rows) {
				(byKey[r.k] ??= []).push(r.v);
			}

			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalizeJson(q, byKey[q.key] ?? []);
			}

			return out;
		},
	},
	{
		name: 'scalar-subqueries',
		group: 'single-statement',
		desc: 'one SELECT, one json scalar-subquery column per query',
		prepare: (queries) => ({ queries, ...buildScalarSubqueries(queries) }),
		run: async (ctx, p) => {
			const rows = await ctx.pool.unsafe(p.text, p.params);
			const row = rows[0];
			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalizeJson(q, row[q.key]);
			}

			return out;
		},
	},
	{
		name: 'json-build-object',
		group: 'single-statement',
		desc: 'one SELECT returning a single json_build_object blob',
		prepare: (queries) => ({ queries, ...buildJsonBuildObject(queries) }),
		run: async (ctx, p) => {
			const rows = await ctx.pool.unsafe(p.text, p.params);
			const batch = rows[0].batch;
			const out = {};

			for (const q of p.queries) {
				out[q.key] = finalizeJson(q, batch[q.key]);
			}

			return out;
		},
	},
	{
		name: 'simple-multi',
		group: 'single-statement',
		desc: 'semicolon-joined statements via simple protocol (params must be INLINED — the ORM problem)',
		prepare: (queries) => ({ queries, ...buildSimpleMulti(queries) }),
		run: async (ctx, p) => {
			const resultSets = await ctx.pool.unsafe(p.text).simple();
			const sets = resultSets.length > 0 && Array.isArray(resultSets[0]) ? resultSets : [resultSets];
			const out = {};
			p.queries.forEach((q, i) => (out[q.key] = finalize(q, sets[i] ?? [])));

			return out;
		},
	},
];
