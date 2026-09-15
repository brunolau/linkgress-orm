/**
 * Test runner: every test file in its own `bun test` process.
 *
 *   bun tests/run.ts [paths...] [options]
 *
 *   paths              test files or directories (or substrings of their paths); default: all of tests/
 *   --memory           run against the in-memory database instead of PostgreSQL (LINKGRESS_TEST_DB=memory)
 *   --parity           run against PostgreSQL and in memory — both at once — and fail unless every test
 *                      file and every test has the same outcome in both
 *   --thread           memory mode: host each file's database in a worker thread (LINKGRESS_MEMORY_THREAD)
 *   --driver <name>    the DatabaseClient the suite uses: pg (default), postgres, bun or pglite (LINKGRESS_TEST_DRIVER)
 *   -t, --test-name-pattern <regex>   only run tests whose full name matches
 *   -j, --jobs <n>     parallel files in memory and PGlite runs (default: half the CPU cores)
 *   --pg-jobs <n>      parallel files against PostgreSQL, each on a database of its own (default 6); 1 runs
 *                      the files one after another on DB_NAME itself
 *   --timeout <ms>     per-test timeout (default 30000)
 *   --json <file>      write the per-test outcomes of the run(s)
 *   --coverage         collect coverage (lcov) for every file, merged into coverage/lcov.info
 *   --verbose          print the output of every file, not only of failing ones
 *
 * Why one process per file: each test file gets a fresh module registry (entity metadata, schema caches,
 * shared clients) and, in memory mode, its own database — so files never see each other's state.
 *
 * PostgreSQL runs use the server in DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD (`.env` supported;
 * the name must contain "test"). With --pg-jobs N > 1 (the default) the runner builds a template database
 * (the extensions the suite uses plus the test schema), clones it into N worker databases
 * (`<DB_NAME>_<host>_<pid>_w<k>`, CREATE DATABASE … TEMPLATE), runs N files at a time — each file's process
 * gets its worker's database as DB_NAME — and drops every database it created when the run ends: normally,
 * on a failure, or on Ctrl+C / SIGTERM (DROP DATABASE … WITH (FORCE)). Databases of a runner that could
 * not clean up (killed hard) are dropped by the next PostgreSQL run on the same machine (`<host>` is a
 * short hash of the host name): the process that created them no longer exists. Runs on other machines
 * sharing the server never touch each other's databases. With --pg-jobs 1 the schema is created in DB_NAME itself, the files run one after
 * another, and the schema is dropped afterwards. Memory runs build the schema once into a snapshot every
 * file's database is restored from.
 *
 * A parity run starts both legs together — the PostgreSQL files, the in-memory files in parallel beside
 * them — and compares the two result sets once both are complete. When the PostgreSQL leg runs serially on
 * DB_NAME, the few files that reach the real server even in memory mode (SERVER_BOUND_IN_MEMORY) wait until
 * it has finished, so the legs never use that database at the same time (worker databases are private to
 * the PostgreSQL leg). The SQL parity test must find the server in a parity run
 * (LINKGRESS_SQL_PARITY_REQUIRE_PG=1). PGlite runs
 * (`--driver pglite`) dump the schema from one PGlite once; every file boots its own instance from that
 * dump (tests/utils/pglite-server.ts), so they run in parallel — the server is then only needed by files
 * that construct PgClient / PostgresClient themselves, and a run without one only warns.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism, hostname, tmpdir } from 'node:os';
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

/** Test files that use the real PostgreSQL server even in memory mode (they compare with it). */
const SERVER_BOUND_IN_MEMORY = new Set(['tests/memory/sql-parity.test.ts']);

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
const pgJobsOption = option(['--pg-jobs']);
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
const pgJobs = Math.max(1, pgJobsOption ? parseInt(pgJobsOption, 10) : 6);
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
if (parity) {
  // a parity run needs the server anyway: the SQL parity test must not skip itself
  baseEnv.LINKGRESS_SQL_PARITY_REQUIRE_PG = '1';
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
  // output is shown only when the script fails (or with --verbose): parity runs print two runs side by side
  const result = spawnSync(process.execPath, [script, ...extraArgs], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  if (verbose && output) {
    console.log(output);
  }
  if (result.status !== 0) {
    if (!verbose && output) {
      console.error(output);
    }
    if (optional) {
      return false;
    }
    throw new Error(`${rel(script)} ${extraArgs.join(' ')} failed (exit ${result.status})`);
  }
  return true;
};

const MODE_LABEL: Record<Mode, string> = { pg: 'PostgreSQL', memory: 'In memory', pglite: 'PGlite' };

// ---------------------------------------------------------------------------
// PostgreSQL worker databases (--pg-jobs > 1)
// ---------------------------------------------------------------------------

const BASE_DB = baseEnv.DB_NAME || 'linkgress_test';
/** this machine, so stale-database cleanup only judges process ids it can actually check */
const HOST_TAG = createHash('sha1').update(hostname()).digest('hex').slice(0, 6);
const RUN_TAG = `${BASE_DB}_${HOST_TAG}_${process.pid}_`;
/** worker databases of runners on this machine: <DB_NAME>_<host>_<pid>_(tpl|w<k>) */
const WORKER_DB = new RegExp(`^${BASE_DB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_${HOST_TAG}_(\\d+)_(tpl|w\\d+)$`);
const createdDatabases = new Set<string>();
const children = new Set<ReturnType<typeof spawn>>();

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** One statement on DB_NAME (CREATE / DROP DATABASE cannot run inside a transaction, so no pool, no BEGIN). */
const adminQuery = async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pg = require('pg');
  const client = new pg.Client({
    host: baseEnv.DB_HOST || 'localhost',
    port: parseInt(baseEnv.DB_PORT || '5432', 10),
    database: BASE_DB,
    user: baseEnv.DB_USER || 'postgres',
    password: baseEnv.DB_PASSWORD || 'postgres',
  });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const dropDatabase = async (name: string): Promise<void> => {
  await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  createdDatabases.delete(name);
};

/** Worker databases left behind by runners that no longer exist (killed before they could clean up). */
const dropStaleWorkerDatabases = async (): Promise<void> => {
  const { rows } = await adminQuery('SELECT datname FROM pg_database');
  for (const { datname } of rows as { datname: string }[]) {
    const m = WORKER_DB.exec(datname);
    if (m && Number(m[1]) !== process.pid && !processAlive(Number(m[1]))) {
      console.log(`Dropping ${datname}, left behind by an earlier run`);
      await dropDatabase(datname);
    }
  }
};

/** Drops every database this run created; safe to call more than once. */
const dropWorkerDatabases = async (): Promise<void> => {
  const names = [...createdDatabases];
  const failures: string[] = [];
  for (const name of names) {
    try {
      await dropDatabase(name);
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failures.length > 0) {
    console.error(`Could not drop test database(s) — the next PostgreSQL run drops them:\n  ${failures.join('\n  ')}`);
  }
};

/**
 * A template database (extensions + the test schema) cloned into `count` worker databases; returns their names.
 * The template carries pg_trgm and unaccent, which the long-lived DB_NAME has from earlier runs.
 */
const createWorkerDatabases = async (count: number, env: Record<string, string>, log: (message: string) => void): Promise<string[]> => {
  if (`${RUN_TAG}w${count}`.length > 63) {
    throw new Error(`DB_NAME "${BASE_DB}" is too long for worker database names (PostgreSQL allows 63 characters); use --pg-jobs 1`);
  }
  const template = `${RUN_TAG}tpl`;
  log(`Creating ${count} worker databases on ${baseEnv.DB_HOST || 'localhost'}:${baseEnv.DB_PORT || '5432'} (${RUN_TAG}w1..w${count})...`);
  // registered before CREATE: a statement that fails half-way still gets a DROP … IF EXISTS
  createdDatabases.add(template);
  await adminQuery(`CREATE DATABASE ${quoteIdent(template)}`);
  runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['create'], { ...env, DB_NAME: template, LINKGRESS_TEST_EXTENSIONS: env.LINKGRESS_TEST_EXTENSIONS ?? 'pg_trgm,unaccent' });
  const names: string[] = [];
  for (let k = 1; k <= count; k++) {
    const name = `${RUN_TAG}w${k}`;
    createdDatabases.add(name);
    await adminQuery(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`);
    names.push(name);
  }
  return names;
};

let interrupted = false;
/** Stop the test files, drop this run's databases, exit: Ctrl+C / termination and crashes that skip `finally`. */
const abort = (reason: string, exitCode: number): void => {
  if (interrupted) {
    return;
  }
  interrupted = true;
  console.error(`\n${reason}: stopping the test files and dropping the worker databases...`);
  for (const child of children) {
    child.kill();
  }
  void dropWorkerDatabases().finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(exitCode);
  });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
  process.on(signal, () => abort(signal, 130));
}
process.on('uncaughtException', (error) => {
  console.error(error);
  abort('uncaught exception', 1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  abort('unhandled rejection', 1);
});

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
    children.add(child);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    // a process that cannot start still ends with 'close'; the error goes into the file's output
    child.on('error', (error) => (output += `\n${error.stack ?? error.message}`));
    child.on('close', (code) => {
      children.delete(child);
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

interface RunOptions {
  /** prefixes every line this run prints (runs side by side) */
  prefix?: string;
  /** memory mode: SERVER_BOUND_IN_MEMORY files start only once this settles (the PostgreSQL leg is done) */
  serverFree?: Promise<unknown>;
}

const runAll = async (mode: Mode, options: RunOptions = {}): Promise<RunResult> => {
  const log = (message = ''): void => {
    console.log(options.prefix ? message.split('\n').map((line) => (line ? options.prefix + line : line)).join('\n') : message);
  };
  const env: Record<string, string> = { ...baseEnv };
  if (mode === 'memory') {
    env.LINKGRESS_TEST_DB = 'memory';
    if (thread) {
      env.LINKGRESS_MEMORY_THREAD = 'true';
    }
    const snapshot = path.join(workDir, 'schema.snapshot');
    log('Building the in-memory schema snapshot...');
    runSetupScript(path.join(TESTS_DIR, 'memory', 'create-schema-snapshot.ts'), [snapshot], env);
    env.LINKGRESS_MEMORY_SNAPSHOT = snapshot;
  } else if (mode === 'pglite') {
    delete env.LINKGRESS_TEST_DB;
    const snapshot = path.join(workDir, 'pglite-schema.tar');
    log('Building the PGlite schema snapshot...');
    runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['pglite-snapshot', snapshot], env);
    env.LINKGRESS_TEST_PGLITE_SNAPSHOT = snapshot;
    // only the files that construct PgClient / PostgresClient themselves need the server
    log('Creating the test schema in PostgreSQL (optional on PGlite)...');
    if (!runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['create'], env, true)) {
      log('PostgreSQL unreachable: files that construct PgClient / PostgresClient directly will fail.');
    }
  }

  const jobs = mode === 'pg' ? Math.min(pgJobs, files.length) : parallelJobs;
  // --pg-jobs > 1: every worker runs its files on a database of its own
  let workerDatabases: string[] = [];
  const setupStarted = Date.now();
  if (mode === 'pg') {
    delete env.LINKGRESS_TEST_DB;
    await dropStaleWorkerDatabases();
    if (jobs > 1) {
      try {
        workerDatabases = await createWorkerDatabases(jobs, env, log);
      } catch (e) {
        await dropWorkerDatabases();
        throw e;
      }
    } else {
      log('Creating the test schema in PostgreSQL...');
      runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['create'], env);
    }
  }
  const runStarted = Date.now();
  log(`Running ${files.length} test file(s) ${mode === 'pg' ? `against PostgreSQL${jobs > 1 ? ` (${jobs} in parallel, one database each; setup ${((runStarted - setupStarted) / 1000).toFixed(1)}s)` : ''}` : `${mode === 'memory' ? 'in memory' : 'on PGlite'} (${jobs} in parallel)`}`);
  const outcomes: FileOutcome[] = new Array(files.length);
  const indices = files.map((_, i) => i);
  const waitsForServer = (i: number) => mode === 'memory' && !!options.serverFree && SERVER_BOUND_IN_MEMORY.has(rel(files[i]));
  const runQueue = async (queue: number[]) => {
    let next = 0;
    const worker = async (workerIndex: number) => {
      const workerEnv = workerDatabases.length > 0 ? { ...env, DB_NAME: workerDatabases[workerIndex] } : env;
      while (next < queue.length && !interrupted) {
        const index = queue[next++];
        const outcome = await runFile(files[index], mode, workerEnv, index);
        outcomes[index] = outcome;
        const s = summarize(outcome);
        const failed = s.failed > 0;
        log(`${failed ? 'FAIL' : 'ok  '}  ${outcome.file}  (${s.passed} passed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}, ${(outcome.durationMs / 1000).toFixed(1)}s)`);
        if (verbose || failed) {
          log(outcome.output.trimEnd().split('\n').map((l) => `      ${l}`).join('\n'));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, (_, workerIndex) => worker(workerIndex)));
  };
  try {
    await runQueue(indices.filter((i) => !waitsForServer(i)));
    const deferred = indices.filter(waitsForServer);
    if (deferred.length > 0) {
      log(`Waiting for the PostgreSQL run to finish before ${deferred.length} file(s) that use the server...`);
      await options.serverFree;
      await runQueue(deferred);
    }
  } finally {
    if (workerDatabases.length > 0) {
      await dropWorkerDatabases();
    } else if (mode !== 'memory') {
      runSetupScript(path.join(TESTS_DIR, 'global-schema.ts'), ['drop'], env, mode === 'pglite');
    }
  }

  const totals = outcomes.map(summarize).reduce((a, b) => ({ passed: a.passed + b.passed, failed: a.failed + b.failed, skipped: a.skipped + b.skipped }), { passed: 0, failed: 0, skipped: 0 });
  const failedFiles = outcomes.filter((o) => summarize(o).failed > 0);
  log();
  log(`${MODE_LABEL[mode]}: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped — ${files.length - failedFiles.length}/${files.length} files passed in ${((Date.now() - runStarted) / 1000).toFixed(1)}s`);
  for (const o of failedFiles) {
    log(`  FAIL ${o.file}: ${Object.entries(o.tests).filter(([, s]) => s === 'failed').map(([n]) => n).join('; ')}`);
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
    // both legs at once: PostgreSQL files serially, in-memory files in parallel beside them
    const started = Date.now();
    const pgRun = runAll('pg', { prefix: '[pg]     ' });
    // server-bound in-memory files wait only when the PostgreSQL leg uses DB_NAME itself (--pg-jobs 1)
    const memoryRun = runAll('memory', { prefix: '[memory] ', serverFree: pgJobs > 1 ? undefined : pgRun.catch(() => undefined) });
    runs.push(...(await Promise.all([pgRun, memoryRun])));
    console.log(`\nBoth runs finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
  // normally already dropped by the run that created them; this covers a run that threw half-way
  await dropWorkerDatabases();
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
