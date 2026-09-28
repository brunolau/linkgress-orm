import { describe, test, expect } from 'bun:test';
import { databasePlan } from '../utils/run-plan';

/**
 * tests/run.ts: which PostgreSQL databases a run uses (tests/utils/run-plan.ts). A PostgreSQL run's files run on
 * PRIVATE worker databases — also a single file — unless `--pg-jobs 1` is given; a PGlite run's server-bound files do
 * too, falling back to DB_NAME (the old schema setup there) only when the private databases cannot be created. Before,
 * `jobs = min(--pg-jobs, files)` put every one-file PostgreSQL run on DB_NAME (its schema rebuilt, then dropped at the
 * end), and every PGlite run created and dropped DB_NAME's schema for its server-bound files. (Memory and parity runs
 * still run tests/memory/sql-parity.test.ts against DB_NAME, inside transactions it rolls back.) The end-to-end check
 * against a real server is described in the lane report (a scratch DB_NAME, before and after).
 */
describe('tests/run.ts database plan', () => {
  describe('PostgreSQL', () => {
    test('a single file gets a private worker database of its own — not DB_NAME', () => {
      expect(databasePlan('pg', { pgJobs: 6, parallelJobs: 8, fileCount: 1 })).toEqual({ jobs: 1, workerDatabases: 1, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('two files: two parallel slots, a private database each', () => {
      expect(databasePlan('pg', { pgJobs: 6, parallelJobs: 8, fileCount: 2 })).toEqual({ jobs: 2, workerDatabases: 2, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('the whole suite: one private database per --pg-jobs slot', () => {
      expect(databasePlan('pg', { pgJobs: 6, parallelJobs: 8, fileCount: 194 })).toEqual({ jobs: 6, workerDatabases: 6, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('--pg-jobs 2 with a single file: still a private database', () => {
      expect(databasePlan('pg', { pgJobs: 2, parallelJobs: 8, fileCount: 1 })).toEqual({ jobs: 1, workerDatabases: 1, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('--pg-jobs 3 with five files: three slots', () => {
      expect(databasePlan('pg', { pgJobs: 3, parallelJobs: 8, fileCount: 5 })).toEqual({ jobs: 3, workerDatabases: 3, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('an explicit --pg-jobs 1 runs serially on DB_NAME itself, as before', () => {
      expect(databasePlan('pg', { pgJobs: 1, parallelJobs: 8, fileCount: 1 })).toEqual({ jobs: 1, workerDatabases: 0, usesSharedDatabase: true, sharedDatabaseFallback: false });
      expect(databasePlan('pg', { pgJobs: 1, parallelJobs: 8, fileCount: 194 })).toEqual({ jobs: 1, workerDatabases: 0, usesSharedDatabase: true, sharedDatabaseFallback: false });
    });

    test('--jobs (memory / PGlite parallelism) does not change a PostgreSQL run', () => {
      expect(databasePlan('pg', { pgJobs: 6, parallelJobs: 1, fileCount: 10 })).toEqual(databasePlan('pg', { pgJobs: 6, parallelJobs: 16, fileCount: 10 }));
    });
  });

  describe('PGlite', () => {
    test('the server-bound files get private databases, one per parallel slot', () => {
      expect(databasePlan('pglite', { pgJobs: 6, parallelJobs: 8, fileCount: 194 })).toEqual({ jobs: 8, workerDatabases: 8, usesSharedDatabase: false, sharedDatabaseFallback: true });
    });

    test('fewer files than slots: one private database per file', () => {
      expect(databasePlan('pglite', { pgJobs: 6, parallelJobs: 8, fileCount: 2 })).toEqual({ jobs: 8, workerDatabases: 2, usesSharedDatabase: false, sharedDatabaseFallback: true });
    });

    test('a single file: one private database, not DB_NAME', () => {
      expect(databasePlan('pglite', { pgJobs: 6, parallelJobs: 8, fileCount: 1 })).toEqual({ jobs: 8, workerDatabases: 1, usesSharedDatabase: false, sharedDatabaseFallback: true });
    });

    test('an explicit --pg-jobs 1: DB_NAME itself, as before', () => {
      expect(databasePlan('pglite', { pgJobs: 1, parallelJobs: 8, fileCount: 20 })).toEqual({ jobs: 8, workerDatabases: 0, usesSharedDatabase: true, sharedDatabaseFallback: false });
    });

    test('private databases that cannot be created fall back to DB_NAME (schema created and dropped there, as before) — a PostgreSQL run fails instead', () => {
      expect(databasePlan('pglite', { pgJobs: 6, parallelJobs: 8, fileCount: 3 }).sharedDatabaseFallback).toBe(true);
      expect(databasePlan('pg', { pgJobs: 6, parallelJobs: 8, fileCount: 3 }).sharedDatabaseFallback).toBe(false);
    });
  });

  describe('memory', () => {
    test('no server database is created, dropped or rebuilt', () => {
      expect(databasePlan('memory', { pgJobs: 6, parallelJobs: 8, fileCount: 194 })).toEqual({ jobs: 8, workerDatabases: 0, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });

    test('--pg-jobs 1 does not change a memory run', () => {
      expect(databasePlan('memory', { pgJobs: 1, parallelJobs: 4, fileCount: 1 })).toEqual({ jobs: 4, workerDatabases: 0, usesSharedDatabase: false, sharedDatabaseFallback: false });
    });
  });
});
