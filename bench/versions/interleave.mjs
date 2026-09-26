/**
 * Both versions in ONE process, their samples interleaved (bench/versions/compare.mjs runs one per round).
 * Machine state — clock boost, the core the scheduler picked, background load — then hits both versions
 * alike. With one process per version it did not: the same code's median drifted 10–30 % (up to 2×)
 * from one process to the next, more than most of the differences being measured.
 *
 *   node --expose-gc bench/versions/interleave.mjs --base <base harness.js> --head <head harness.js> --out <file>
 *        [--round n] [--filter regex] [--tiers e2e,overhead,build] [--samples 10] [--sample-ms 30] [--warmup-ms 300]
 *
 * Per scenario and tier: both sides prepared (tapes recorded), the heap collected, warmed up in
 * alternating chunks, then --samples pairs of samples, alternating which side goes first. Each side
 * writes to its own table (verbench_items_base / _head), so interleaved writes never collide.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      parsed[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? 'true' : (i++, next);
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const round = Number(args.round ?? 0);
const options = {
  warmupMs: Number(args['warmup-ms'] ?? (args.quick ? 60 : 300)),
  warmupChunks: 4,
  samples: Number(args.samples ?? (args.quick ? 3 : 10)),
  sampleMs: Number(args['sample-ms'] ?? (args.quick ? 10 : 30)),
};
const tiers = (args.tiers ?? 'e2e,overhead,build').split(',');
const filter = args.filter ? new RegExp(args.filter) : undefined;

const sides = {
  base: require(args.base).createBench({ itemsTable: 'verbench_items_base' }),
  head: require(args.head).createBench({ itemsTable: 'verbench_items_head' }),
};

const collectGarbage = globalThis.Bun ? () => globalThis.Bun.gc(true) : globalThis.gc ?? (() => undefined);

/** Who goes first alternates per pair, and the starting side alternates per round. */
const orderFor = pair => ((pair + round) % 2 === 0 ? ['base', 'head'] : ['head', 'base']);

/** Rethrows with the side named: a failure of one version is not a failure of the other. */
async function onSide(key, work) {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${key}: ${error?.message ?? error}`);
  }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const results = {};
const started = performance.now();

for (const scenario of sides.head.scenarios) {
  const baseScenario = sides.base.scenarios.find(s => s.id === scenario.id);

  if (!baseScenario || (filter && !filter.test(scenario.id))) {
    continue;
  }

  results[scenario.id] = {};

  for (const tier of tiers) {
    if (!scenario.tiers.includes(tier) || !baseScenario.tiers.includes(tier)) {
      continue;
    }

    try {
      const states = {};

      for (const key of orderFor(0)) {
        states[key] = await onSide(key, () => sides[key].begin(scenario.id, tier));
      }

      collectGarbage();

      for (let chunk = 0; chunk < options.warmupChunks; chunk++) {
        for (const key of orderFor(chunk)) {
          await onSide(key, () => sides[key].sample(states[key], options.warmupMs / options.warmupChunks, chunk === 0 ? 3 : 1));
        }
      }

      const samples = { base: [], head: [] };

      for (let pair = 0; pair < options.samples; pair++) {
        for (const key of orderFor(pair)) {
          samples[key].push(await onSide(key, () => sides[key].sample(states[key], options.sampleMs)));
        }
      }

      results[scenario.id][tier] = {
        ...samples,
        statements: { base: states.base.tape?.length, head: states.head.tape?.length },
      };
    } catch (error) {
      results[scenario.id][tier] = { error: String(error?.message ?? error) };
    }
  }

  if (args.progress === 'true') {
    const line = Object.entries(results[scenario.id])
      .map(([tier, r]) => r.error
        ? `${tier} ERROR ${r.error.slice(0, 80)}`
        : `${tier} ${(median(r.base) * 1000).toFixed(1)}→${(median(r.head) * 1000).toFixed(1)}µs`)
      .join('  ');
    process.stderr.write(`  ${scenario.id.padEnd(26)} ${line}\n`);
  }
}

for (const side of Object.values(sides)) {
  await side.close();
}

fs.writeFileSync(args.out, JSON.stringify({
  runtime: sides.head.runtime,
  round,
  options,
  durationMs: performance.now() - started,
  scenarios: Object.fromEntries(sides.head.scenarios.map(s => [s.id, { group: s.group, title: s.title }])),
  results,
}));
