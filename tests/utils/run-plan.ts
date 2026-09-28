/**
 * Which PostgreSQL databases a run of tests/run.ts uses — the one decision that keeps runs sharing a server (other
 * checkouts, parallel agents, CI jobs) off each other's data. Pure, so tests/runner/database-plan.test.ts pins it.
 *
 * A PostgreSQL run's files run on PRIVATE databases — a template (the extensions + the test schema) cloned into
 * `<DB_NAME>_<host>_<pid>_w<k>` databases, one per parallel file slot, dropped when the run ends — also when it runs a
 * single file (the slot count used to be `min(--pg-jobs, files)`, which put a one-file run on `DB_NAME` itself: it
 * rebuilt that database's schema and dropped it at the end, under whoever else was using it); only an explicit
 * `--pg-jobs 1` runs them on `DB_NAME`. A PGlite run gives the files that reach the server private databases too, and
 * falls back to `DB_NAME` — the test schema created there and dropped at the end, as before — only when they cannot be
 * created (no CREATEDB, say). `DB_NAME` stays the database the runner connects to for CREATE / DROP DATABASE, and
 * memory and parity runs run tests/memory/sql-parity.test.ts against it, inside transactions it rolls back.
 */
export type RunMode = 'pg' | 'memory' | 'pglite';

export interface DatabasePlanOptions {
  /** `--pg-jobs` after the runner's clamp (≥ 1; default 6) */
  pgJobs: number;
  /** parallel files of memory / PGlite runs (`--jobs`, default half the cores) */
  parallelJobs: number;
  /** test files the run executes */
  fileCount: number;
}

export interface DatabasePlan {
  /** files the run executes at once */
  jobs: number;
  /** private databases to clone for the run's parallel slots (0: none) */
  workerDatabases: number;
  /** the run creates the test schema in `DB_NAME` itself and drops it when it ends */
  usesSharedDatabase: boolean;
  /**
   * when the private databases cannot be created, the run falls back to `DB_NAME` (the test schema created there and
   * dropped at the end, as before 1.0.11) instead of failing — PGlite runs, whose server is optional
   */
  sharedDatabaseFallback: boolean;
}

export function databasePlan(mode: RunMode, options: DatabasePlanOptions): DatabasePlan {
  const { pgJobs, parallelJobs, fileCount } = options;
  const slots = (jobs: number): number => Math.max(1, Math.min(jobs, fileCount));
  // an explicit `--pg-jobs 1`: the old serial run on DB_NAME itself
  const serialOnSharedDatabase = pgJobs <= 1;

  if (mode === 'memory') {
    // every file on its own in-memory database; no server database is created or dropped
    return { jobs: parallelJobs, workerDatabases: 0, usesSharedDatabase: false, sharedDatabaseFallback: false };
  }

  if (mode === 'pglite') {
    // every file boots its own PGlite; the server serves only the files that construct PgClient / PostgresClient
    // themselves — on private databases like a PostgreSQL run's, one per parallel slot, else on DB_NAME as before
    return serialOnSharedDatabase
      ? { jobs: parallelJobs, workerDatabases: 0, usesSharedDatabase: true, sharedDatabaseFallback: false }
      : { jobs: parallelJobs, workerDatabases: slots(parallelJobs), usesSharedDatabase: false, sharedDatabaseFallback: true };
  }

  return serialOnSharedDatabase
    ? { jobs: 1, workerDatabases: 0, usesSharedDatabase: true, sharedDatabaseFallback: false }
    : { jobs: slots(pgJobs), workerDatabases: slots(pgJobs), usesSharedDatabase: false, sharedDatabaseFallback: false };
}
