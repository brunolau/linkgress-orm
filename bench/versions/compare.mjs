/**
 * Performance comparison of two linkgress versions (git refs) on one machine, one database and one set
 * of scenarios: bench/versions/harness.ts compiled against each version's own source tree.
 *
 *   node bench/versions/compare.mjs --base v1.0.5 --head HEAD
 *
 * Phases (`--phases`, default all, in this order):
 *   build    extract each ref's src/ and debug/ into --work-dir, compile it with the ref's own compiler
 *            options (what its dist/ is built with) plus the harness; node_modules is a junction to this
 *            repository's
 *   setup    create VERBENCH_DB (default linkgress_verbench) if missing, then schema + seed through head
 *   verify   run every scenario once per version: statements and a digest of the result, compared
 *   startup  cold start (import, context, first queries) in --startup-runs fresh processes per version,
 *            alternated
 *   bench    --rounds processes per runtime, each running BOTH versions with their samples interleaved
 *            (bench/versions/interleave.mjs)
 *   report   summary.md and summary.json in <work-dir>/<results>
 *
 * Every figure compares the two versions round by round (a round's two versions ran side by side);
 * a change is reported with the 95 % confidence interval of that ratio over the rounds.
 *
 * Options: --runtimes node,bun  --rounds 8  --bun-rounds <rounds>  --startup-runs 20
 *          --work-dir <dir> (default <tmp>/linkgress-verbench)  --results <subdir of work-dir> (default results)
 *          passed to the bench: --quick  --filter <regex>  --tiers e2e,overhead,build  --samples  --sample-ms  --warmup-ms
 *
 * The connection comes from .env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD). `HEAD` means the committed
 * state: uncommitted changes are not part of the head tree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
require('dotenv').config({ path: path.join(repoRoot, '.env'), quiet: true });

const args = parseArgs(process.argv.slice(2));
const rounds = Number(args.rounds ?? 8);
const bunRounds = Number(args['bun-rounds'] ?? rounds);
const startupRuns = Number(args['startup-runs'] ?? 20);
const runtimes = (args.runtimes ?? 'node,bun').split(',');
const phases = new Set((args.phases ?? 'build,setup,verify,startup,bench,report').split(','));
const workDir = path.resolve(args['work-dir'] ?? path.join(os.tmpdir(), 'linkgress-verbench'));
const resultsDir = path.join(workDir, args.results ?? 'results');
const dbName = process.env.VERBENCH_DB || 'linkgress_verbench';
const benchArgs = ['quick', 'filter', 'tiers', 'samples', 'sample-ms', 'warmup-ms']
  .filter(key => args[key] !== undefined)
  .flatMap(key => (args[key] === 'true' ? [`--${key}`] : [`--${key}`, args[key]]));

const childEnv = { ...process.env, VERBENCH_DB: dbName };

const sides = {
  base: describeRef(args.base ?? 'v1.0.5'),
  head: describeRef(args.head ?? 'HEAD'),
};

fs.mkdirSync(resultsDir, { recursive: true });

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

function git(gitArgs, options = {}) {
  return execFileSync('git', gitArgs, { cwd: repoRoot, maxBuffer: 1 << 30, ...options });
}

function describeRef(ref) {
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  const version = JSON.parse(git(['show', `${sha}:package.json`]).toString()).version;
  const label = `${version}-${sha.slice(0, 7)}`;
  const dir = path.join(workDir, label);

  return { ref, sha, version, label, dir, build: path.join(dir, 'build') };
}

const harnessOf = side => path.join(side.build, 'bench', 'versions', 'harness.js');
const startupOf = side => path.join(side.build, 'bench', 'versions', 'startup.js');

function log(message) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

// ---------------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------------

/** Every file under `paths` at the commit, written below `dir` — one `git cat-file --batch` call. */
function extractTree(sha, paths, dir) {
  const files = git(['ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths]).toString().split('\0').filter(Boolean);
  const out = git(['cat-file', '--batch'], { input: files.map(file => `${sha}:${file}`).join('\n') + '\n' });
  let pos = 0;

  for (const file of files) {
    const newline = out.indexOf(0x0a, pos);
    const [, type, size] = out.subarray(pos, newline).toString().split(' ');

    if (type !== 'blob') {
      throw new Error(`${file}: unexpected git object type ${type}`);
    }

    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out.subarray(newline + 1, newline + 1 + Number(size)));
    pos = newline + 1 + Number(size) + 1;
  }

  return files.length;
}

function sizeOf(dir, extension) {
  let bytes = 0;
  let files = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) {
      bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
      files++;
    }
  }

  return { bytes, files };
}

function build(side) {
  log(`build ${side.label} (${side.ref})`);
  fs.rmSync(side.dir, { recursive: true, force: true });
  fs.mkdirSync(side.dir, { recursive: true });

  const count = extractTree(side.sha, ['src', 'debug/schema', 'debug/model', 'debug/types', 'package.json', 'tsconfig.json'], side.dir);
  const benchDir = path.join(side.dir, 'bench', 'versions');
  fs.mkdirSync(benchDir, { recursive: true });

  for (const file of ['harness.ts', 'startup.ts']) {
    fs.copyFileSync(path.join(here, file), path.join(benchDir, file));
  }

  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(side.dir, 'node_modules'), 'junction');

  // The ref's own compiler options — its dist/ is exactly this output — rooted at the tree.
  const own = JSON.parse(fs.readFileSync(path.join(side.dir, 'tsconfig.json'), 'utf8'));
  const compilerOptions = {
    ...own.compilerOptions,
    rootDir: '.',
    outDir: 'build',
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
  };
  fs.writeFileSync(path.join(side.dir, 'tsconfig.verbench.json'),
    JSON.stringify({ compilerOptions, include: ['src/**/*', 'bench/versions/*.ts'] }, null, 2));

  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(side.dir, 'tsconfig.verbench.json'),
    '--noCheck',
  ], { stdio: 'inherit' });

  const js = sizeOf(path.join(side.build, 'src'), '.js');
  const ts = sizeOf(path.join(side.dir, 'src'), '.ts');
  const info = { ref: side.ref, sha: side.sha, version: side.version, sourceFiles: count, srcTs: ts, distJs: js };
  fs.writeFileSync(path.join(resultsDir, `build-${side.label}.json`), JSON.stringify(info, null, 2));
  log(`  ${count} files; src ${ts.files} .ts / ${(ts.bytes / 1024).toFixed(0)} KB; compiled ${js.files} .js / ${(js.bytes / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------------------------------

/** `exposeGc`: node gets --expose-gc (the bench collects the heap before every measurement). */
function runChild(runtime, script, scriptArgs, { exposeGc = false } = {}) {
  const executable = runtime === 'node' ? process.execPath : runtime;
  const flags = runtime === 'node' && exposeGc ? ['--expose-gc'] : [];
  const started = performance.now();
  const result = spawnSync(executable, [...flags, script, ...scriptArgs], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 1 << 28,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${runtime} ${path.basename(script)} ${scriptArgs.join(' ')} exited with ${result.status}`);
  }

  return { stdout: result.stdout.toString(), ms: performance.now() - started };
}

async function ensureDatabase() {
  const { Client } = require('pg');
  const admin = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: 'postgres',
  });
  await admin.connect();

  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);

    if (found.rowCount === 0) {
      log(`create database ${dbName}`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

/** Base first in even runs, head first in odd ones. */
const orderFor = run => (run % 2 === 0 ? ['base', 'head'] : ['head', 'base']);

function verify() {
  for (const key of ['base', 'head']) {
    const side = sides[key];
    log(`verify ${side.label}`);
    runChild('node', harnessOf(side), ['--mode', 'verify', '--out', path.join(resultsDir, `verify-${key}.json`), ...benchArgs]);
  }
}

function startup() {
  for (const runtime of runtimes) {
    log(`startup ${runtime}: ${startupRuns} fresh processes per version`);
    const samples = { base: [], head: [] };

    for (let run = 0; run < startupRuns; run++) {
      for (const key of orderFor(run)) {
        samples[key].push(JSON.parse(runChild(runtime, startupOf(sides[key]), []).stdout));
      }
    }

    fs.writeFileSync(path.join(resultsDir, `startup-${runtime}.json`), JSON.stringify(samples));
  }
}

function bench() {
  for (const runtime of runtimes) {
    const count = runtime === 'bun' ? bunRounds : rounds;

    for (let round = 0; round < count; round++) {
      const out = path.join(resultsDir, `bench-${runtime}-r${round}.json`);
      log(`bench ${runtime} round ${round + 1}/${count}: ${sides.base.label} and ${sides.head.label} interleaved`);
      const { ms } = runChild(runtime, path.join(here, 'interleave.mjs'), [
        '--base', harnessOf(sides.base),
        '--head', harnessOf(sides.head),
        '--round', String(round),
        '--out', out,
        '--progress',
        ...benchArgs,
      ], { exposeGc: true });
      log(`  ${(ms / 1000).toFixed(1)} s`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (sorted.length === 0) {
    return NaN;
  }

  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Two-sided 95 % Student t quantiles by degrees of freedom. */
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160,
  2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

/**
 * head / base over paired runs: the geometric mean of the ratios and its 95 % confidence interval
 * (t interval of the log ratios).
 */
function ratioStats(ratios) {
  const logs = ratios.filter(r => Number.isFinite(r) && r > 0).map(Math.log);
  const n = logs.length;

  if (n === 0) {
    return { n, ratio: NaN, lo: NaN, hi: NaN };
  }

  const mean = logs.reduce((a, b) => a + b, 0) / n;

  if (n === 1) {
    return { n, ratio: Math.exp(mean), lo: NaN, hi: NaN };
  }

  const sd = Math.sqrt(logs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = (T975[n - 1] ?? 2.0) * sd / Math.sqrt(n);

  return { n, ratio: Math.exp(mean), lo: Math.exp(mean - half), hi: Math.exp(mean + half) };
}

/** A change counts when its whole interval is on one side of 1 and it is at least `minEffect`. */
function verdict({ ratio, lo, hi }, minEffect = 0.02) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return 'n/a';
  }

  if (hi < 1 && ratio < 1 - minEffect) {
    return 'faster';
  }

  if (lo > 1 && ratio > 1 + minEffect) {
    return 'slower';
  }

  return '';
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function formatMs(ms) {
  if (!Number.isFinite(ms)) {
    return '—';
  }

  if (ms < 1) {
    return `${(ms * 1000).toFixed(ms < 0.01 ? 2 : 1)} µs`;
  }

  return `${ms.toFixed(ms < 10 ? 3 : 1)} ms`;
}

function formatChange(ratio) {
  if (!Number.isFinite(ratio)) {
    return '—';
  }

  const pct = (ratio - 1) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)} %`;
}

const formatInterval = ({ lo, hi }) => (Number.isFinite(lo) ? `${formatChange(lo)} … ${formatChange(hi)}` : '—');

function roundFiles(runtime) {
  const files = [];

  for (let round = 0; ; round++) {
    const file = path.join(resultsDir, `bench-${runtime}-r${round}.json`);

    if (!fs.existsSync(file)) {
      return files;
    }

    files.push(file);
  }
}

function summarizeBench(runtime) {
  const runs = roundFiles(runtime).map(readJson);

  if (runs.length === 0) {
    return undefined;
  }

  const rows = [];

  for (const [id, meta] of Object.entries(runs[0].scenarios)) {
    for (const tier of ['e2e', 'overhead', 'build']) {
      if (!runs.some(run => run.results[id]?.[tier])) {
        continue;
      }

      const ok = runs.map(run => run.results[id]?.[tier]).filter(r => r && !r.error);
      const base = ok.map(r => median(r.base));
      const head = ok.map(r => median(r.head));
      const stats = ratioStats(base.map((b, i) => head[i] / b));

      rows.push({
        id,
        group: meta.group,
        title: meta.title,
        tier,
        base: median(base),
        head: median(head),
        ...stats,
        verdict: verdict(stats),
        perRound: base.map((b, i) => [b, head[i]]),
        statements: ok[0]?.statements,
        errors: [...new Set(runs.map(run => run.results[id]?.[tier]?.error).filter(Boolean))],
      });
    }
  }

  // One number per tier: the geometric mean of the scenarios' ratios (controls left out)
  const overall = {};

  for (const tier of ['e2e', 'overhead', 'build']) {
    const ratios = rows.filter(r => r.tier === tier && r.group !== 'control' && Number.isFinite(r.ratio)).map(r => r.ratio);
    const without = rows.filter(r => r.tier === tier && r.group !== 'control' && r.id !== 'nav-whole-row' && Number.isFinite(r.ratio)).map(r => r.ratio);
    const geo = list => Math.exp(list.reduce((a, r) => a + Math.log(r), 0) / list.length);

    if (ratios.length) {
      overall[tier] = { scenarios: ratios.length, geomean: geo(ratios), geomeanWithoutWholeRow: geo(without) };
    }
  }

  return { runtime: runs[0].runtime, rounds: runs.length, options: runs[0].options, rows, overall };
}

function summarizeStartup(runtime) {
  const file = path.join(resultsDir, `startup-${runtime}.json`);

  if (!fs.existsSync(file)) {
    return undefined;
  }

  const samples = readJson(file);

  return Object.keys(samples.base[0]).map(metric => {
    const base = samples.base.map(s => s[metric]);
    const head = samples.head.map(s => s[metric]);
    const stats = ratioStats(base.map((b, i) => head[i] / b));

    return { metric, base: median(base), head: median(head), ...stats, verdict: verdict(stats) };
  });
}

function summarizeVerify() {
  const baseFile = path.join(resultsDir, 'verify-base.json');
  const headFile = path.join(resultsDir, 'verify-head.json');

  if (!fs.existsSync(baseFile) || !fs.existsSync(headFile)) {
    return undefined;
  }

  const base = readJson(baseFile);
  const head = readJson(headFile);

  return Object.keys(head).map(id => {
    const b = base[id];
    const h = head[id];

    if (!b || b.error || h.error) {
      return { id, sql: '—', result: 'error', baseError: b?.error ?? 'missing', headError: h.error };
    }

    const sqlOf = report => report.statements.map(s => s.sql.replace(/\s+/g, ' ').trim());
    const sameSql = JSON.stringify(sqlOf(b)) === JSON.stringify(sqlOf(h));
    const result = b.ordered === h.ordered ? 'identical' : b.unordered === h.unordered ? 'same rows, other order' : 'DIFFERENT';

    return { id, sql: sameSql ? 'identical' : 'changed', statements: [b.statements.length, h.statements.length], result, rows: [b.rows, h.rows] };
  });
}

function report() {
  const builds = Object.fromEntries(['base', 'head'].map(key => {
    const file = path.join(resultsDir, `build-${sides[key].label}.json`);
    return [key, fs.existsSync(file) ? readJson(file) : undefined];
  }));
  const benchSummaries = runtimes.map(summarizeBench).filter(Boolean);
  const startupSummaries = Object.fromEntries(runtimes.map(r => [r, summarizeStartup(r)]).filter(([, s]) => s));
  const parity = summarizeVerify();
  const b = sides.base.version;
  const h = sides.head.version;

  const lines = [];
  lines.push(`# linkgress ${b} vs ${h}`, '');
  lines.push(`base ${sides.base.ref} (${sides.base.sha.slice(0, 7)}), head ${sides.head.ref} (${sides.head.sha.slice(0, 7)}); ` +
    `${os.cpus()[0].model.trim()}, ${os.platform()} ${os.release()}`, '');
  lines.push('change = head / base, geometric mean over the rounds, with its 95 % confidence interval; ' +
    '"faster" / "slower" when the whole interval is on one side and the change is at least 2 %.', '');

  if (builds.base && builds.head) {
    lines.push(`| build | ${b} | ${h} |`, '| --- | --- | --- |');
    lines.push(`| src .ts files / KB | ${builds.base.srcTs.files} / ${(builds.base.srcTs.bytes / 1024).toFixed(0)} | ${builds.head.srcTs.files} / ${(builds.head.srcTs.bytes / 1024).toFixed(0)} |`);
    lines.push(`| compiled .js files / KB | ${builds.base.distJs.files} / ${(builds.base.distJs.bytes / 1024).toFixed(0)} | ${builds.head.distJs.files} / ${(builds.head.distJs.bytes / 1024).toFixed(0)} |`, '');
  }

  if (parity) {
    lines.push('## Parity (one execution per scenario, node)', '');
    lines.push('| scenario | SQL | result | rows |', '| --- | --- | --- | --- |');

    for (const row of parity) {
      lines.push(`| ${row.id} | ${row.sql} | ${row.result}${row.baseError ? ` (base: ${row.baseError})` : ''}${row.headError ? ` (head: ${row.headError})` : ''} | ${row.rows ? row.rows.join(' / ') : ''} |`);
    }

    lines.push('');
  }

  for (const [runtime, rows] of Object.entries(startupSummaries)) {
    lines.push(`## Cold start — ${runtime} (${rows[0].n} fresh processes per version, alternated)`, '');
    lines.push(`| | ${b} | ${h} | change | 95 % CI | |`, '| --- | --- | --- | --- | --- | --- |');

    for (const row of rows) {
      lines.push(`| ${row.metric} | ${formatMs(row.base)} | ${formatMs(row.head)} | ${formatChange(row.ratio)} | ${formatInterval(row)} | ${row.verdict} |`);
    }

    lines.push('');
  }

  const tierTitles = {
    e2e: 'End to end on PostgreSQL (pg driver)',
    overhead: 'linkgress overhead: statements answered from memory with the recorded rows',
    build: 'Build and dispatch only: every statement answered with zero rows',
  };

  for (const summary of benchSummaries) {
    for (const tier of ['e2e', 'overhead', 'build']) {
      const rows = summary.rows.filter(row => row.tier === tier);

      if (rows.length === 0) {
        continue;
      }

      const overall = summary.overall[tier];
      lines.push(`## ${tierTitles[tier]} — ${summary.runtime}, ${summary.rounds} rounds`, '');

      if (overall) {
        lines.push(`Geometric mean over ${overall.scenarios} scenarios: ${formatChange(overall.geomean)} ` +
          `(${formatChange(overall.geomeanWithoutWholeRow)} without nav-whole-row).`, '');
      }

      lines.push(`| scenario | ${b} | ${h} | change | 95 % CI | |`, '| --- | --- | --- | --- | --- | --- |');

      for (const row of rows) {
        const errors = row.errors.join('; ');
        lines.push(`| ${row.id} | ${formatMs(row.base)} | ${formatMs(row.head)} | ${formatChange(row.ratio)} | ${formatInterval(row)} | ` +
          `${row.verdict}${errors ? ` ${errors.slice(0, 200)}` : ''} |`);
      }

      lines.push('');
    }
  }

  fs.writeFileSync(path.join(resultsDir, 'summary.md'), lines.join('\n'));
  fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify({
    base: { ...sides.base, build: builds.base },
    head: { ...sides.head, build: builds.head },
    machine: { cpu: os.cpus()[0].model.trim(), cores: os.cpus().length, platform: `${os.platform()} ${os.release()}`, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    parity,
    startup: startupSummaries,
    bench: benchSummaries,
  }, null, 1));
  log(`report: ${path.join(resultsDir, 'summary.md')}`);
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  log(`base ${sides.base.label}, head ${sides.head.label}; work dir ${workDir}; database ${dbName}`);

  if (phases.has('build')) {
    build(sides.base);
    build(sides.head);
  }

  if (phases.has('setup')) {
    await ensureDatabase();
    log('setup: schema + seed (head tree)');
    runChild('node', harnessOf(sides.head), ['--mode', 'setup']);
  }

  if (phases.has('verify')) {
    verify();
  }

  if (phases.has('startup')) {
    startup();
  }

  if (phases.has('bench')) {
    bench();
  }

  if (phases.has('report')) {
    report();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
