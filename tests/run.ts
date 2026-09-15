/**
 * Test runner: every test file in its own `bun test` process.
 *
 *   bun tests/run.ts [paths...] [options]
 *
 *   paths              test files or directories (or substrings of their paths); default: all of tests/
 *   --memory           run against the in-memory database instead of PostgreSQL (LINKGRESS_TEST_DB=memory)
 *   --parity           run against PostgreSQL, then in memory, and fail unless every test file and
 *                      every test has the same outcome in both
 *   --thread           memory mode: host each file's database in a worker thread (LINKGRESS_MEMORY_THREAD)
 *   --driver <name>    the DatabaseClient the suite uses: pg (default), postgres, bun or pglite (LINKGRESS_TEST_DRIVER)
 *   -t, --test-name-pattern <regex>   only run tests whose full name matches
 *   -j, --jobs <n>     parallel files in memory and PGlite runs (default: half the CPU cores); PostgreSQL runs are serial
 *   --timeout <ms>     per-test timeout (default 30000)
 *   --json <file>      write the per-test outcomes of the run(s)
 *   --coverage         collect coverage (lcov) for every file, merged into coverage/lcov.info
 *   --verbose          print the output of every file, not only of failing ones
 *
 * Why one process per file: each test file gets a fresh module registry (entity metadata, schema caches,
 * shared clients) and, in memory mode, its own database — so files never see each other's state.
 *
 * PostgreSQL runs create the test schema once before the files run and drop it afterwards (the database
 * in DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD, `.env` supported; the name must contain "test").
 * Memory runs build the schema once into a snapshot every file's database is restored from. PGlite runs
 * (`--driver pglite`) dump the schema from one PGlite once; every file boots its own instance from that
 * dump (tests/utils/pglite-server.ts), so they run in parallel — the server is then only needed by files
 * that construct PgClient / PostgresClient themselves, and a run without one only warns.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import * as path from 'node:path';

type Mode = 'pg' | 'memory' | 'pglite';
type Status = 'passed' | 'failed' | 'skipped';

interface FileOutcome {
  file: string;
  exitCode: number;
  /** full test name ("describe > test") -> status; "(file)" records a failure outside any test */
  tests: Record<string, Status>;
  durationMs: number;
  output: string;
}

interface RunResult {
  mode: Mode;
  files: FileOutcome[];
}

const ROOT = path.resolve(import.meta.dir, '..');
const TESTS_DIR = path.join(ROOT, 'tests');

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const option = (names: string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      const value = args[i + 1];
      args.splice(i, 2);
      return value;
    }
    const prefix = names.find((n) => n.startsWith('--') && args[i].startsWith(n + '='));
    if (prefix) {
      const value = args[i].slice(prefix.length + 1);
      args.splice(i, 1);
      return value;
    }
  }
  return undefined;
};
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) {
    args.splice(i, 1);
    return true;
  }
  return false;
};

const parity = flag('--parity');
const memory = flag('--memory');
const thread = flag('--thread');
const coverage = flag('--coverage');
const verbose = flag('--verbose');
const namePattern = option(['-t', '--test-name-pattern']);
const jobsOption = option(['-j', '--jobs']);
const timeout = option(['--timeout']) ?? '30000';
const jsonOut = option(['--json']);
const driver = option(['--driver']);
const unknown = args.filter((a) => a.startsWith('-'));
if (unknown.length > 0) {
  console.error(`unknown option(s): ${unknown.join(' ')}`);
  process.exit(2);
}
const filters = args;
const parallelJobs = Math.max(1, jobsOption ? parseInt(jobsOption, 10) : Math.floor(availableParallelism() / 2));
const onPglite = (driver ?? process.env.LINKGRESS_TEST_DRIVER ?? '').toLowerCase() === 'pglite';
if (onPglite && (memory || parity)) {
  console.error('--driver pglite runs on PGlite: it cannot be combined with --memory or --parity');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

const loadDotEnv = (): Record<string, string> => {
  const file = path.join(ROOT, '.env');
  const env: Record<string, string> = {};
  if (!existsSync(file)) {
    return env;
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) {
      env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return env;
};
const baseEnv: Record<string, string> = { ...loadDotEnv(), ...(process.env as Record<string, string>) };
if (driver) {
  baseEnv.LINKGRESS_TEST_DRIVER = driver;
}

if (!(baseEnv.DB_NAME || 'linkgress_test').includes('test')) {
  console.error('Tests must use a test database! Set DB_NAME to include "test" in the name.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// test files
// ---------------------------------------------------------------------------

const collect = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
    } else if (entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

const allFiles = collect(TESTS_DIR).sort();
const files = filters.length === 0
  ? allFiles
  : allFiles.filter((f) => filters.some((filter) => {
      const normalized = filter.split(path.sep).join('/').replace(/^\.\//, '');
      const abs = path.resolve(ROOT, filter);
      return rel(f).includes(normalized) || f === abs || f.startsWith(abs + path.sep);
    }));

if (files.length === 0) {
  console.error(`no test files match ${filters.join(' ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// global setup (PostgreSQL schema / in-memory schema snapshot)
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(path.join(tmpdir(), 'linkgress-tests-'));

/** Runs a setup script in its own process, so the AppDatabase model never loads into the runner. */
const runSetupScript = (script: string, extraArgs: string[], env: Record<string, string>, optional = false): boolean => {
  const result = spawnSync(process.execPath, [script, ...extraArgs], { cwd: ROOT, env, stdio: 'inherit' });
  if (result.status !== 0) {
    if (optional) {
      return false;
    }
    throw new Error(`${rel(script)} failed (exit ${result.status})`);
  }
  return true;
};

const MODE_LABEL: Record<Mode, string> = { pg: 'PostgreSQL', memory: 'In memory', pglite: 'PGlite' };

// ---------------------------------------------------------------------------
// running files
// ---------------------------------------------------------------------------

const decodeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/** Test outcomes from Bun's JUnit report: names are the nested describe blocks joined with " > ". */
const parseJunit = (xml: string): Record<string, Status> => {
  const tests: Record<string, Status> = {};
  const stack: string[] = [];
  const tag = /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>|<(failure|error)\b|<skipped\b/g;
  let current: string | null = null;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    if (m[5] && current) {
      tests[current] = 'failed';
      continue;
    }
    if (!m[2] && current) {
      if (tests[current] !== 'failed') {
        tests[current] = 'skipped';
      }
      continue;
    }
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[3] ?? '')?.[1] ?? '');
    if (m[2] === 'testsuite') {
      if (closing) {
        stack.pop();
        depth--;
      } else if (!selfClosing) {
        // the outermost suite is the file itself
        stack.push(depth === 0 ? '' : name);
        depth++;
      }
      continue;
    }
    if (closing) {
      current = null;
      continue;
    }
    let full = [...stack.filter(Boolean), name].join(' > ');
    // Bun names failures outside tests (hooks) "(unnamed)"
    if (name === '(unnamed)') {
      full = [...stack.filter(Boolean), '(hook)'].join(' > ');
    }
    while (tests[full] !== undefined && name !== '(unnamed)') {
      full += ' (duplicate name)';
    }
    tests[full] = tests[full] === 'failed' ? 'failed' : 'passed';
    current = selfClosing ? null : full;
  }
  return tests;
};

const runFile = (file: string, mode: Mode, env: Record<string, string>, index: number): Promise<FileOutcome> => {
  const report = path.join(workDir, `${mode}-${index}.xml`);
  const bunArgs = ['test', file, '--timeout', timeout, '--reporter=junit', `--reporter-outfile=${report}`];
  if (namePattern) {
    bunArgs.push('--test-name-pattern', namePattern);
  }
  if (coverage) {
    bunArgs.push('--coverage', '--coverage-reporter=lcov', `--coverage-dir=${path.join(workDir, `coverage-${mode}-${index}`)}`);
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, bunArgs, { cwd: ROOT, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      const tests = existsSync(report) ? parseJunit(readFileSync(report, 'utf8')) : {};
      const exitCode = code ?? 1;
      const anyFailed = Object.values(tests).some((s) => s === 'failed');
      if (exitCode !== 0 && !anyFailed) {
        // the process failed outside any test (load error, crash, unhandled error)
        tests['(file)'] = 'failed';
      }
      resolve({ file: rel(file), exitCode, tests, durationMs: Date.now() - started, output });
    });
  });
};

const summarize = (outcome: FileOutcome) => {
  const values = Object.values(outcome.tests);
  return {
    passed: values.filter((s) => s === 'passed').length,
    failed: values.filter((s) => s === 'failed').length,
    skipped: values.filter((s) => s === 'skipped').length,
  };
};

const runAll = async (mode: Mode): Promise<RunResult> => {
  const env: Record<string, string> = { ...baseEnv };
  if (mode === 'memory') {
    env.LINKGRESS_TEST_DB = 'memory';
    if (thread) {
      env.LINKGRESS_MEMORY_THREAD = 'true';
    }
    const snapshot = path.join(workDir, 'schema.snapshot');
    console.log('Building the in-memory schema snapshot...');
    runSetupScript(path.join(TESTS_DIR, 'memory', 'create-schema-snapshot.ts'), [snapshot], env);
    env.LINKGRESS_MEMORY_SNAPSHOT = snapshot;
  } else if (mode === 'pglite') {
    delete env.LINKGRESS_TEST_DB;
    const snapshot = path.join(workDir, 'pglite-schema.tar');
    console.log('Building the PGlite schema snapshot...');
    runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['pglite-snapshot', snapshot], env);
    env.LINKGRESS_TEST_PGLITE_SNAPSHOT = snapshot;
    // only the files that construct PgClient / PostgresClient themselves need the server
    console.log('Creating the test schema in PostgreSQL (optional on PGlite)...');
    if (!runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['create'], env, true)) {
      console.warn('PostgreSQL unreachable: files that construct PgClient / PostgresClient directly will fail.');
    }
  } else {
    delete env.LINKGRESS_TEST_DB;
    console.log('Creating the test schema in PostgreSQL...');
    runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['create'], env);
  }

  const jobs = mode === 'pg' ? 1 : parallelJobs;
  const runStarted = Date.now();
  console.log(`\nRunning ${files.length} test file(s) ${mode === 'pg' ? 'against PostgreSQL' : `${mode === 'memory' ? 'in memory' : 'on PGlite'} (${jobs} in parallel)`}\n`);
  const outcomes: FileOutcome[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const outcome = await runFile(files[index], mode, env, index);
      outcomes[index] = outcome;
      const s = summarize(outcome);
      const failed = s.failed > 0;
      console.log(`${failed ? 'FAIL' : 'ok  '}  ${outcome.file}  (${s.passed} passed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}, ${(outcome.durationMs / 1000).toFixed(1)}s)`);
      if (verbose || failed) {
        console.log(outcome.output.trimEnd().split('\n').map((l) => `      ${l}`).join('\n'));
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: jobs }, worker));
  } finally {
    if (mode !== 'memory') {
      runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['drop'], env, mode === 'pglite');
    }
  }

  const totals = outcomes.map(summarize).reduce((a, b) => ({ passed: a.passed + b.passed, failed: a.failed + b.failed, skipped: a.skipped + b.skipped }), { passed: 0, failed: 0, skipped: 0 });
  const failedFiles = outcomes.filter((o) => summarize(o).failed > 0);
  console.log(`\n${MODE_LABEL[mode]}: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped — ${files.length - failedFiles.length}/${files.length} files passed in ${((Date.now() - runStarted) / 1000).toFixed(1)}s`);
  for (const o of failedFiles) {
    console.log(`  FAIL ${o.file}: ${Object.entries(o.tests).filter(([, s]) => s === 'failed').map(([n]) => n).join('; ')}`);
  }
  return { mode, files: outcomes };
};

// ---------------------------------------------------------------------------
// parity
// ---------------------------------------------------------------------------

/** Every difference between two runs, per file and per test (a missing test counts as a difference). */
const compareRuns = (a: RunResult, b: RunResult): string[] => {
  const diffs: string[] = [];
  const byFile = new Map(b.files.map((f) => [f.file, f]));
  for (const fa of a.files) {
    const fb = byFile.get(fa.file)!;
    if ((fa.exitCode === 0) !== (fb.exitCode === 0)) {
      diffs.push(`${fa.file}: process ${fa.exitCode === 0 ? 'succeeded' : `failed (exit ${fa.exitCode})`} on ${a.mode}, ${fb.exitCode === 0 ? 'succeeded' : `failed (exit ${fb.exitCode})`} on ${b.mode}`);
    }
    for (const name of new Set([...Object.keys(fa.tests), ...Object.keys(fb.tests)])) {
      const sa = fa.tests[name] ?? 'missing';
      const sb = fb.tests[name] ?? 'missing';
      if (sa !== sb) {
        diffs.push(`${fa.file} :: ${name}: ${sa} on ${a.mode}, ${sb} on ${b.mode}`);
      }
    }
  }
  return diffs;
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const mergeCoverage = (): void => {
  const parts = readdirSync(workDir).filter((d) => d.startsWith('coverage-')).map((d) => path.join(workDir, d, 'lcov.info')).filter(existsSync);
  if (parts.length === 0) {
    return;
  }
  mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
  writeFileSync(path.join(ROOT, 'coverage', 'lcov.info'), parts.map((p) => readFileSync(p, 'utf8')).join('\n'));
  console.log('\nCoverage written to coverage/lcov.info');
};

let exitCode = 0;
try {
  const runs: RunResult[] = [];
  if (parity) {
    runs.push(await runAll('pg'));
    runs.push(await runAll('memory'));
    const diffs = compareRuns(runs[0], runs[1]);
    if (diffs.length > 0) {
      console.log(`\nPARITY: ${diffs.length} difference(s) between PostgreSQL and in-memory outcomes:`);
      for (const d of diffs) {
        console.log(`  ${d}`);
      }
      exitCode = 1;
    } else {
      const tests = runs[0].files.reduce((n, f) => n + Object.keys(f.tests).length, 0);
      console.log(`\nPARITY: identical outcomes for all ${runs[0].files.length} files and ${tests} tests`);
    }
  } else {
    runs.push(await runAll(memory ? 'memory' : onPglite ? 'pglite' : 'pg'));
    if (runs[0].files.some((f) => f.exitCode !== 0 || Object.values(f.tests).includes('failed'))) {
      exitCode = 1;
    }
  }
  if (jsonOut) {
    writeFileSync(path.resolve(jsonOut), JSON.stringify(runs.map((r) => ({ mode: r.mode, files: r.files.map(({ output: _output, ...f }) => f) })), null, 2));
  }
  if (coverage) {
    mergeCoverage();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
