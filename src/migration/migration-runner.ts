import { DatabaseContext } from '../entity/db-context';
import {
  MigrationConfig,
  MigrationRunResult,
  LoadedMigration,
} from './migration.interface';
import { MigrationJournal } from './migration-journal';
import { MigrationLoader } from './migration-loader';

/**
 * Executes migrations against the database.
 *
 * The runner:
 * - Loads migration files from the configured directory
 * - Tracks applied migrations in a journal table
 * - Executes pending migrations in chronological order
 * - Supports rolling back migrations
 * - Runs each migration within a transaction for atomicity
 *
 * @example
 * ```typescript
 * const runner = new MigrationRunner(db, {
 *   migrationsDirectory: './migrations',
 *   verbose: true,
 * });
 *
 * // Run all pending migrations
 * const result = await runner.up();
 * console.log(`Applied ${result.applied.length} migrations`);
 *
 * // Rollback last migration
 * await runner.down(1);
 * ```
 */
export class MigrationRunner {
  private journal: MigrationJournal;
  private loader: MigrationLoader;
  private verbose: boolean;
  private logger: (message: string) => void;

  constructor(
    private db: DatabaseContext,
    private config: MigrationConfig
  ) {
    this.journal = new MigrationJournal(db.getClient(), config);
    this.loader = new MigrationLoader(config.migrationsDirectory);
    this.verbose = config.verbose ?? false;
    this.logger = config.logger ?? console.log;
  }

  private log(message: string): void {
    if (this.verbose) {
      this.logger(message);
    }
  }

  /**
   * Run all pending migrations in chronological order.
   *
   * If the journal table does not exist (fresh database), the schema is
   * created from the model definition first (diff-based), and all existing
   * migration files are recorded as applied.
   *
   * Each migration is executed within a transaction. If a migration fails,
   * the transaction is rolled back and execution stops.
   *
   * @returns Result containing applied, skipped, and failed migrations
   */
  async up(): Promise<MigrationRunResult> {
    // Check if journal table exists — if not, this is a fresh database
    const journalExists = await this.journal.tableExists();

    if (!journalExists) {
      this.log('No migration journal found — creating schema from model...');
      await this.db.getSchemaManager().migrate();

      // Create journal table and mark all existing migrations as applied
      await this.journal.ensureTable();
      const allMigrations = await this.loader.loadAllMigrations();

      const result: MigrationRunResult = {
        applied: [],
        skipped: allMigrations.map(m => m.filename),
      };

      for (const migration of allMigrations) {
        await this.journal.recordApplied(migration.filename);
        this.log(`  Recorded as applied: ${migration.filename}`);
      }

      this.log(`Schema created. ${allMigrations.length} migration(s) recorded as applied.`);
      return result;
    }

    await this.journal.ensureTable();

    const allMigrations = await this.loader.loadAllMigrations();
    const applied = await this.journal.getApplied();
    const appliedSet = new Set(applied.map(a => a.filename));

    const pending = allMigrations.filter(m => !appliedSet.has(m.filename));

    const result: MigrationRunResult = {
      applied: [],
      skipped: allMigrations
        .filter(m => appliedSet.has(m.filename))
        .map(m => m.filename),
    };

    this.log(`Found ${pending.length} pending migration(s)`);

    for (const migration of pending) {
      try {
        this.log(`Applying: ${migration.filename}`);

        // Execute migration within a transaction
        await this.db.transaction(async (txDb) => {
          await migration.migration.up(txDb);
        });

        // Record only after successful commit
        await this.journal.recordApplied(migration.filename);
        result.applied.push(migration.filename);

        this.log(`  Applied: ${migration.filename}`);
      } catch (error) {
        result.failed = {
          filename: migration.filename,
          error: error as Error,
        };
        this.logger(`  FAILED: ${migration.filename} - ${(error as Error).message}`);
        break; // Stop on first failure
      }
    }

    if (result.applied.length > 0) {
      this.log(`\nCompleted: ${result.applied.length} migration(s) applied`);
    } else if (!result.failed) {
      this.log('No pending migrations');
    }

    return result;
  }

  /**
   * Revert the last N migrations in reverse chronological order.
   *
   * Each migration's down() method is executed within a transaction.
   *
   * @param count - Number of migrations to revert (default: 1)
   * @returns Result containing reverted migrations
   */
  async down(count: number = 1): Promise<MigrationRunResult> {
    await this.journal.ensureTable();

    const applied = await this.journal.getApplied();
    const allMigrations = await this.loader.loadAllMigrations();

    // Get migrations to revert (most recent first)
    const toRevert = applied.slice(-count).reverse();

    const result: MigrationRunResult = {
      applied: [],
      skipped: [],
    };

    this.log(`Reverting ${toRevert.length} migration(s)`);

    for (const entry of toRevert) {
      const migration = allMigrations.find(m => m.filename === entry.filename);

      if (!migration) {
        this.logger(`  WARNING: Migration file not found for ${entry.filename}, removing from journal`);
        await this.journal.recordReverted(entry.filename);
        result.applied.push(entry.filename);
        continue;
      }

      try {
        this.log(`Reverting: ${migration.filename}`);

        // Execute down migration within a transaction
        await this.db.transaction(async (txDb) => {
          await migration.migration.down(txDb);
        });

        // Remove from journal only after successful rollback
        await this.journal.recordReverted(migration.filename);
        result.applied.push(migration.filename);

        this.log(`  Reverted: ${migration.filename}`);
      } catch (error) {
        result.failed = {
          filename: migration.filename,
          error: error as Error,
        };
        this.logger(`  FAILED: ${migration.filename} - ${(error as Error).message}`);
        break;
      }
    }

    if (result.applied.length > 0) {
      this.log(`\nCompleted: ${result.applied.length} migration(s) reverted`);
    }

    return result;
  }

  /**
   * Get all pending migrations (not yet applied).
   */
  async getPending(): Promise<LoadedMigration[]> {
    await this.journal.ensureTable();

    const allMigrations = await this.loader.loadAllMigrations();
    const applied = await this.journal.getApplied();
    const appliedSet = new Set(applied.map(a => a.filename));

    return allMigrations.filter(m => !appliedSet.has(m.filename));
  }

  /**
   * Get all applied migrations.
   */
  async getApplied(): Promise<LoadedMigration[]> {
    await this.journal.ensureTable();

    const allMigrations = await this.loader.loadAllMigrations();
    const applied = await this.journal.getApplied();
    const appliedSet = new Set(applied.map(a => a.filename));

    return allMigrations.filter(m => appliedSet.has(m.filename));
  }

  /**
   * Get the status of all migrations.
   *
   * @returns Array of migration status objects
   */
  async status(): Promise<{ filename: string; applied: boolean; appliedAt?: Date }[]> {
    await this.journal.ensureTable();

    const allMigrations = await this.loader.loadAllMigrations();
    const applied = await this.journal.getApplied();
    const appliedMap = new Map(applied.map(a => [a.filename, a]));

    return allMigrations.map(m => ({
      filename: m.filename,
      applied: appliedMap.has(m.filename),
      appliedAt: appliedMap.get(m.filename)?.applied_at,
    }));
  }

  /**
   * Get the migration loader (for generating filenames, etc.)
   */
  getLoader(): MigrationLoader {
    return this.loader;
  }

  /**
   * Get the migration journal (for advanced operations)
   */
  getJournal(): MigrationJournal {
    return this.journal;
  }
}
