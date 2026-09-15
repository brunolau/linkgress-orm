/**
 * Run the jest suite against PGlite — PostgreSQL compiled to WASM, in-process — instead of a
 * server: sets LINKGRESS_TEST_DRIVER=pglite and starts jest under --experimental-vm-modules,
 * which PGlite needs there (it loads its WASM and data bundles through dynamic import()).
 *
 * Every test file gets its own PGlite, so files cannot interfere through the database and the
 * suite runs on parallel workers (half the cores) unless a worker option is passed. The jest
 * config keeps `maxWorkers: 1` for the real server, whose database all files share.
 *
 * Usage (extra arguments go to jest):
 *   pnpm test:pglite
 *   pnpm test:pglite tests/queries/grouping.test.ts
 *   pnpm test:pglite --runInBand
 *
 * Files that construct PgClient / PostgresClient themselves still need the server.
 */
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const workerOption = /^(-w|--maxWorkers|-i|--runInBand)(=|$)/;
const jestArgs = args.some(arg => workerOption.test(arg)) ? args : ['--maxWorkers=50%', ...args];

const result = spawnSync(
  process.execPath,
  ['--experimental-vm-modules', require.resolve('jest/bin/jest'), ...jestArgs],
  { stdio: 'inherit', env: { ...process.env, LINKGRESS_TEST_DRIVER: 'pglite' } }
);

process.exit(result.status ?? 1);
