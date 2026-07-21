/**
 * Run the jest test suite under Bun with jest-equivalent module isolation:
 * one `bun test` PROCESS per test file.
 *
 * Why per-file processes: jest gives every test file a fresh module registry,
 * so module-scoped state (shared clients, entity metadata, schema caches)
 * never leaks between files. `bun test` runs all files in ONE module graph,
 * which breaks files that recreate schemas or rely on fresh registries.
 * Spawning per file restores jest semantics exactly.
 *
 * Usage:
 *   bun tests-bun/run-jest-suite.ts                 # pg driver (default)
 *   LINKGRESS_TEST_DRIVER=postgres bun tests-bun/run-jest-suite.ts
 *   LINKGRESS_TEST_DRIVER=bun bun tests-bun/run-jest-suite.ts
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TESTS_DIR = join(ROOT, 'tests');
const TIMEOUT_MS = 20000;

const collectTestFiles = (dir: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }

  return files.sort();
};

const files = collectTestFiles(TESTS_DIR);
const driver = process.env.LINKGRESS_TEST_DRIVER || 'pg';
console.log(`Running ${files.length} test files under Bun (driver: ${driver}), one process per file\n`);

let totalPass = 0;
let totalFail = 0;
const failedFiles: Array<{ file: string; exitCode: number; output: string }> = [];

for (const file of files) {
  const proc = Bun.spawnSync(['bun', 'test', file, '--timeout', String(TIMEOUT_MS)], {
    cwd: ROOT,
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = `${proc.stdout}${proc.stderr}`;
  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  const passes = passMatch ? parseInt(passMatch[1], 10) : 0;
  const fails = failMatch ? parseInt(failMatch[1], 10) : 0;

  totalPass += passes;
  totalFail += fails;

  const rel = file.slice(ROOT.length + 1);

  if (proc.exitCode !== 0 || fails > 0) {
    failedFiles.push({ file: rel, exitCode: proc.exitCode ?? -1, output });
    console.log(`FAIL  ${rel} (exit ${proc.exitCode}, ${passes} pass, ${fails} fail)`);
  } else {
    console.log(`ok    ${rel} (${passes} pass)`);
  }
}

console.log(`\n=== TOTAL: ${totalPass} pass, ${totalFail} fail, ${failedFiles.length} failing files of ${files.length}`);

if (failedFiles.length > 0) {
  console.log('\n=== Failing file details:');

  for (const { file, exitCode, output } of failedFiles) {
    console.log(`\n--- ${file} (exit ${exitCode})`);
    const lines = output.split('\n').filter(l => l.includes('(fail)') || l.includes('error:') || l.includes('panic'));
    console.log(lines.slice(0, 12).join('\n'));
  }

  process.exit(1);
}
