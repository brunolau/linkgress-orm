#!/usr/bin/env node
/**
 * Compare two runs of the linkgress suite — typically real PostgreSQL vs PGlite:
 *
 *  - per-test outcomes: what passes on one side only, and the first line of each failure
 *  - per-file timings
 *  - with both runs recorded (LINKGRESS_TEST_RECORD_DIR, tests/utils/query-recorder.ts): the
 *    result of every statement both runs executed, paired by test and SQL text
 *
 * A run is the `--json` output of the test runner (`bun tests/run.ts [--driver pglite] --json <file>`;
 * it holds no failure messages or wall time) or a jest `--json --outputFile` report (the suite ran on
 * jest before 1.0).
 *
 * Usage:
 *   node bench/pglite/compare-runs.mjs --a pg.json --b pglite.json \
 *     [--a-rec rec-pg --b-rec rec-pglite] [--a-name pg --b-name pglite] [--details out.json]
 *
 * Writes a markdown report to stdout; --details also writes every finding as JSON.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const option = name => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const A = { name: option('a-name') ?? 'pg', run: option('a'), rec: option('a-rec') };
const B = { name: option('b-name') ?? 'pglite', run: option('b'), rec: option('b-rec') };

if (!A.run || !B.run) {
  console.error('usage: compare-runs.mjs --a <run.json> --b <run.json> [--a-rec <dir> --b-rec <dir>] [--details <out.json>]');
  process.exit(2);
}

const EXAMPLES = 25;
const ROOT = process.cwd();
const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const toRel = file => relative(ROOT, file).split('\\').join('/');
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The first few informative lines of a jest failure message. */
function failureSummary(text) {
  const lines = stripAnsi(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('at ') && !/^\d+ \|/.test(line) && !/^>\s*\d+ \|/.test(line) && line !== '|');

  return clip(lines.slice(0, 4).join(' ⏎ '), 400);
}

/** tests/run.ts --json: [{ mode, files: [{ file, exitCode, tests: { "describe > test": status }, durationMs }] }] */
function loadRunnerRun(runs) {
  const files = new Map();
  const tests = new Map();

  for (const outcome of runs.flatMap(run => run.files)) {
    const counts = { passed: 0, failed: 0, skipped: 0 };

    for (const [name, status] of Object.entries(outcome.tests)) {
      if (name === '(file)') continue;
      counts[status]++;
      tests.set(`${outcome.file} › ${name}`, { file: outcome.file, name, status, duration: 0, failure: status === 'failed' ? '(see the runner output)' : '' });
    }

    const failedToRun = outcome.tests['(file)'] === 'failed';
    files.set(outcome.file, {
      status: outcome.exitCode === 0 ? 'passed' : 'failed',
      duration: outcome.durationMs,
      counts,
      suiteError: failedToRun ? `process exited with ${outcome.exitCode} outside any test` : null,
    });
  }

  return { files, tests, wall: NaN };
}

function loadRun(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));

  if (Array.isArray(json)) {
    return loadRunnerRun(json);
  }

  const files = new Map();
  const tests = new Map();
  let lastEnd = json.startTime;

  for (const suite of json.testResults) {
    const file = toRel(suite.name);
    const counts = { passed: 0, failed: 0, skipped: 0 };
    const seen = new Map();
    lastEnd = Math.max(lastEnd, suite.endTime ?? 0);

    for (const test of suite.assertionResults) {
      const status = test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped';
      counts[status]++;

      const base = `${file} › ${test.fullName}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);

      tests.set(occurrence > 1 ? `${base} #${occurrence}` : base, {
        file,
        name: test.fullName,
        status,
        duration: test.duration ?? 0,
        failure: status === 'failed' ? failureSummary((test.failureMessages ?? []).join('\n')) : '',
      });
    }

    files.set(file, {
      status: suite.status,
      duration: (suite.endTime ?? 0) - (suite.startTime ?? 0),
      counts,
      suiteError: suite.status === 'failed' && suite.assertionResults.length === 0 ? failureSummary(suite.message ?? '') : null,
    });
  }

  return { files, tests, wall: lastEnd - json.startTime };
}

function table(header, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

const a = loadRun(A.run);
const b = loadRun(B.run);
const details = { a: A.name, b: B.name };
const out = [];
const print = text => out.push(text);

const countStatus = (run, status) => [...run.tests.values()].filter(test => test.status === status).length;
const suiteErrors = run => [...run.files.values()].filter(file => file.suiteError).length;
const fileTime = run => [...run.files.values()].reduce((sum, file) => sum + file.duration, 0);

print(`# ${A.name} vs ${B.name}: linkgress test suite\n`);
print(table(['', A.name, B.name], [
  ['test files', a.files.size, b.files.size],
  ['tests passed', countStatus(a, 'passed'), countStatus(b, 'passed')],
  ['tests failed', countStatus(a, 'failed'), countStatus(b, 'failed')],
  ['tests skipped', countStatus(a, 'skipped'), countStatus(b, 'skipped')],
  ['files that failed to run', suiteErrors(a), suiteErrors(b)],
  ['wall time', secs(a.wall), secs(b.wall)],
  ['sum of per-file times', secs(fileTime(a)), secs(fileTime(b))],
]));

// ---------------------------------------------------------------- per-test outcomes
const outcome = { same: 0, bothFailed: [], onlyAPasses: [], onlyBPasses: [], skipDiffers: [], missingInA: [], missingInB: [] };

for (const key of new Set([...a.tests.keys(), ...b.tests.keys()])) {
  const x = a.tests.get(key);
  const y = b.tests.get(key);

  if (!x) outcome.missingInA.push(key);
  else if (!y) outcome.missingInB.push(key);
  else if (x.status === y.status) x.status === 'failed' ? outcome.bothFailed.push(key) : outcome.same++;
  else if (x.status === 'passed' && y.status === 'failed') outcome.onlyAPasses.push(key);
  else if (x.status === 'failed' && y.status === 'passed') outcome.onlyBPasses.push(key);
  else outcome.skipDiffers.push(key);
}

print(`\n## Per-test outcomes\n`);
print(table(['outcome', 'tests'], [
  ['same outcome on both', outcome.same],
  [`pass on ${A.name}, FAIL on ${B.name}`, outcome.onlyAPasses.length],
  [`fail on ${A.name}, pass on ${B.name}`, outcome.onlyBPasses.length],
  ['fail on both', outcome.bothFailed.length],
  ['skipped on one side only', outcome.skipDiffers.length],
  [`only in ${A.name}'s run`, outcome.missingInB.length],
  [`only in ${B.name}'s run`, outcome.missingInA.length],
]));

const listFailures = (title, keys, run) => {
  if (keys.length === 0) return;
  print(`\n### ${title} (${keys.length})\n`);
  const byFile = new Map();
  for (const key of keys) {
    const test = run.tests.get(key);
    (byFile.get(test.file) ?? byFile.set(test.file, []).get(test.file)).push(test);
  }
  for (const [file, tests] of [...byFile].sort((x, y) => y[1].length - x[1].length)) {
    print(`- **${file}** (${tests.length})`);
    for (const test of tests) print(`  - ${test.name}\n    - \`${test.failure.replace(/`/g, "'")}\``);
  }
};

listFailures(`Pass on ${A.name}, fail on ${B.name}`, outcome.onlyAPasses, b);
listFailures(`Fail on ${A.name}, pass on ${B.name}`, outcome.onlyBPasses, a);
listFailures('Fail on both', outcome.bothFailed, b);

const suiteErrorRows = [...new Set([...a.files.keys(), ...b.files.keys()])]
  .filter(file => a.files.get(file)?.suiteError || b.files.get(file)?.suiteError)
  .map(file => [file, a.files.get(file)?.suiteError ?? '', b.files.get(file)?.suiteError ?? '']);

if (suiteErrorRows.length > 0) {
  print(`\n### Files that failed to run\n`);
  print(table(['file', A.name, B.name], suiteErrorRows.map(row => row.map(cell => clip(String(cell).replace(/\|/g, '\\|'), 200)))));
}

details.outcomes = {
  onlyAPasses: outcome.onlyAPasses.map(key => ({ key, ...b.tests.get(key) })),
  onlyBPasses: outcome.onlyBPasses.map(key => ({ key, ...a.tests.get(key) })),
  bothFailed: outcome.bothFailed.map(key => ({ key, a: a.tests.get(key).failure, b: b.tests.get(key).failure })),
  skipDiffers: outcome.skipDiffers,
  missingInA: outcome.missingInA,
  missingInB: outcome.missingInB,
};

// ---------------------------------------------------------------- per-file timings
const timings = [...new Set([...a.files.keys(), ...b.files.keys()])]
  .map(file => ({ file, a: a.files.get(file)?.duration ?? NaN, b: b.files.get(file)?.duration ?? NaN }))
  .filter(row => Number.isFinite(row.a) && Number.isFinite(row.b));

const ratios = timings.filter(row => row.a > 0).map(row => row.b / row.a).sort((x, y) => x - y);
const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;

print(`\n## Per-file timings\n`);
print(`${timings.length} files ran on both sides. Median ${B.name}/${A.name} time ratio per file: **${median.toFixed(2)}×**; ` +
  `${B.name} faster on ${timings.filter(row => row.b < row.a).length} files, slower on ${timings.filter(row => row.b > row.a).length}.\n`);

const timingRows = rows => rows.map(row => [row.file, secs(row.a), secs(row.b), `${row.b - row.a >= 0 ? '+' : ''}${((row.b - row.a) / 1000).toFixed(2)} s`, `${(row.b / row.a).toFixed(2)}×`]);
const byDelta = [...timings].sort((x, y) => (y.b - y.a) - (x.b - x.a));

print(`**Largest slowdowns on ${B.name}**\n`);
print(table(['file', A.name, B.name, 'delta', 'ratio'], timingRows(byDelta.slice(0, 12))));
print(`\n**Largest speedups on ${B.name}**\n`);
print(table(['file', A.name, B.name, 'delta', 'ratio'], timingRows(byDelta.slice(-12).reverse())));
details.timings = timings;

// ---------------------------------------------------------------- statement-level diff
function loadRecordings(dir) {
  const groups = new Map();
  let total = 0;

  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      total++;
      const key = `${record.file}\u0000${record.test}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(record);
    }
  }

  for (const list of groups.values()) list.sort((x, y) => x.seq - y.seq);

  return { groups, total };
}

/** SQL text with whitespace collapsed and long digit runs (Date.now()-based names) masked. */
const normalizeSql = sql => sql.replace(/\s+/g, ' ').replace(/\d{10,}/g, '<N>').trim();

const describeRecord = record => {
  if (record.error) return `ERROR ${record.error.code ?? ''} ${record.error.message}`;
  const digests = record.results ?? [record.result];
  return digests.map(d => `${d.rows} row(s), rowCount ${d.rowCount}: ${d.sample.replace(/\n/g, ' ')}`).join(' ‖ ');
};

if (A.rec && B.rec) {
  const ra = loadRecordings(A.rec);
  const rb = loadRecordings(B.rec);
  const stats = { pairs: 0, match: 0, orderOnly: 0, rowCount: 0, content: 0, errorMismatch: 0, paramsDiffer: 0, onlyA: 0, onlyB: 0 };
  const findings = { orderOnly: [], rowCount: [], content: [], errorMismatch: [], paramsDiffer: [] };
  const findingsPerFile = new Map();

  const note = (category, x, y) => {
    stats[category]++;
    findings[category].push({ file: x.file, test: x.test, kind: `${x.kind}/${y.kind}`, sql: clip(normalizeSql(x.sql), 400), a: clip(describeRecord(x), 500), b: clip(describeRecord(y), 500) });
    if (category !== 'paramsDiffer') findingsPerFile.set(x.file, (findingsPerFile.get(x.file) ?? 0) + 1);
  };

  const classify = (x, y) => {
    stats.pairs++;

    if (x.error || y.error) {
      if (x.error && y.error && x.error.code === y.error.code) stats.match++;
      else note('errorMismatch', x, y);
      return;
    }

    const dx = x.results ?? [x.result];
    const dy = y.results ?? [y.result];

    if (dx.length !== dy.length) {
      note(x.params === y.params ? 'content' : 'paramsDiffer', x, y);
      return;
    }

    const sameOrdered = dx.every((d, i) => d.ordered === dy[i].ordered);
    const sameUnordered = dx.every((d, i) => d.unordered === dy[i].unordered);
    const sameRowCount = dx.every((d, i) => d.rowCount === dy[i].rowCount);

    if (sameOrdered && sameRowCount) stats.match++;
    else if (x.params !== y.params) note('paramsDiffer', x, y);
    else if (sameOrdered) note('rowCount', x, y);
    else if (sameUnordered) note('orderOnly', x, y);
    else note('content', x, y);
  };

  const bySql = list => {
    const map = new Map();
    for (const record of list) {
      const key = normalizeSql(record.sql);
      (map.get(key) ?? map.set(key, []).get(key)).push(record);
    }
    return map;
  };

  for (const key of new Set([...ra.groups.keys(), ...rb.groups.keys()])) {
    const sa = bySql(ra.groups.get(key) ?? []);
    const sb = bySql(rb.groups.get(key) ?? []);

    for (const [sql, xs] of sa) {
      const ys = sb.get(sql) ?? [];
      const paired = Math.min(xs.length, ys.length);
      stats.onlyA += xs.length - paired;
      for (let i = 0; i < paired; i++) classify(xs[i], ys[i]);
    }

    for (const [sql, ys] of sb) {
      stats.onlyB += Math.max(0, ys.length - (sa.get(sql)?.length ?? 0));
    }
  }

  print(`\n## Statement-level result diff\n`);
  print(`${ra.total} statements recorded on ${A.name}, ${rb.total} on ${B.name}. ` +
    `Statements are paired within the same test by SQL text (whitespace collapsed, 10+ digit runs masked) and occurrence.\n`);
  print(table(['result of paired statements', 'count'], [
    ['identical rows, order and rowCount (or the same SQLSTATE)', stats.match],
    ['same rows, different order', stats.orderOnly],
    ['same rows, different rowCount', stats.rowCount],
    ['different rows', stats.content],
    ['error on one side / different SQLSTATE', stats.errorMismatch],
    ['different parameter values (time-dependent input), different result', stats.paramsDiffer],
    [`**total paired**`, stats.pairs],
    [`executed only on ${A.name} (no counterpart)`, stats.onlyA],
    [`executed only on ${B.name} (no counterpart)`, stats.onlyB],
  ]));

  if (findingsPerFile.size > 0) {
    print(`\n**Files with differing results** (excluding time-dependent inputs)\n`);
    print(table(['file', 'findings'], [...findingsPerFile].sort((x, y) => y[1] - x[1]).slice(0, 25)));
  }

  for (const [category, title] of [['content', 'Different rows'], ['errorMismatch', 'Error on one side'], ['orderOnly', 'Same rows, different order'], ['rowCount', 'Different rowCount'], ['paramsDiffer', 'Different parameters']]) {
    if (findings[category].length === 0) continue;
    print(`\n### ${title}: first ${Math.min(EXAMPLES, findings[category].length)} of ${findings[category].length}\n`);
    for (const f of findings[category].slice(0, EXAMPLES)) {
      print(`- ${f.file} › ${f.test} [${f.kind}]\n  - SQL: \`${f.sql.replace(/`/g, "'")}\`\n  - ${A.name}: \`${f.a.replace(/`/g, "'")}\`\n  - ${B.name}: \`${f.b.replace(/`/g, "'")}\``);
    }
  }

  details.statements = { stats, findings };
}

console.log(out.join('\n'));

const detailsPath = option('details');

if (detailsPath) {
  writeFileSync(detailsPath, JSON.stringify(details, null, 2));
}
