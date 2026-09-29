import { DatabaseContext, LogLevel } from '../entity/db-context';

/**
 * Migration interface that all migration files must implement.
 *
 * Each migration has an up() method to apply changes and a down() method to revert them.
 * The db parameter provides full access to the DataContext for raw SQL execution.
 *
 * @example
 * ```typescript
 * export default class implements Migration {
 *   async up(db: AppDatabase): Promise<void> {
 *     await db.client.querySimple(`
 *       ALTER TABLE users ADD COLUMN new_field TEXT;
 *     `);
 *   }
 *
 *   async down(db: AppDatabase): Promise<void> {
 *     await db.client.querySimple(`
 *       ALTER TABLE users DROP COLUMN new_field;
 *     `);
 *   }
 * }
 * ```
 */
export interface Migration {
  /**
   * Apply the migration (upgrade)
   * @param db - The DataContext instance for executing queries
   */
  up(db: DatabaseContext): Promise<void>;

  /**
   * Revert the migration (downgrade)
   * @param db - The DataContext instance for executing queries
   */
  down(db: DatabaseContext): Promise<void>;

  /**
   * When true, this migration is EXECUTED — not just recorded — when up()
   * baselines a fresh database (no journal table found, schema built from
   * the model).
   *
   * Use it for migrations whose effects the schema model cannot represent:
   * storage parameters (e.g. per-table autovacuum reloptions), data
   * backfills, seeded/config rows. Such migrations must be safe to run on a
   * freshly model-built schema.
   *
   * On the baseline path these migrations run in journal order after the
   * model build completes and are recorded with `baselined = false` because
   * they really ran. A failing runOnBaseline migration stops the run exactly
   * like a normal migration failure (result.failed is set, later
   * runOnBaseline migrations stay pending). On a non-fresh database the flag
   * has no effect — the migration runs through the normal pending path.
   *
   * @default false
   */
  runOnBaseline?: boolean;

  /**
   * Whether the runner wraps up() / down() in a transaction.
   *
   * Set it to `false` for statements PostgreSQL refuses inside a transaction
   * block — `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`,
   * `REINDEX … CONCURRENTLY`, `ALTER TYPE … ADD VALUE` (before PG 12),
   * `VACUUM` — or for long data backfills that should commit in batches
   * instead of holding every lock until one final commit.
   *
   * Without a transaction the migration is NOT atomic: each statement
   * commits on its own, so a failure part-way leaves the earlier statements
   * applied. The migration is still recorded in the journal only after
   * up() resolves, so a failed one stays pending and is retried by the next
   * run — write it to be re-runnable (`IF NOT EXISTS`, `IF EXISTS`, and for
   * a concurrent build that failed, drop the INVALID index it left behind
   * before building again).
   *
   * The context passed to up() / down() is the runner's own. On a pooled
   * client each statement may run on a different connection, so session
   * state (`SET`, temp tables, advisory locks) does not carry over from one
   * statement to the next; open an explicit `db.transaction()` inside the
   * migration for the parts that need it.
   *
   * @default true
   */
  transaction?: boolean;
}

/**
 * Configuration for the migration system
 */
export interface MigrationConfig {
  /**
   * Directory containing migration files.
   * Can be relative to process.cwd() or absolute.
   */
  migrationsDirectory: string;

  /**
   * Name of the journal table that tracks applied migrations.
   * @default '__migrations'
   */
  journalTable?: string;

  /**
   * PostgreSQL schema for the journal table.
   * @default 'public'
   */
  journalSchema?: string;

  /**
   * Enable verbose logging of migration progress.
   * @default false
   */
  verbose?: boolean;

  /**
   * Custom logger function. If not provided, uses console.log.
   * Level indicates the type of log message ('info', 'error', 'debug').
   */
  logger?: (message: string, level?: LogLevel) => void;

  /**
   * Free-form label stored in every journal row this runner records as
   * applied (normal path, baselined rows, and runOnBaseline-executed rows) —
   * typically the release/image tag (e.g. `2026.09.25-88a9dc5`). Lets a
   * later rollback know which release applied which migration, so it can
   * pick the files and the build that contains them.
   *
   * linkgress never reads this from the environment — the caller passes it.
   * Unset means the row's `applied_by` is NULL, same as rows written before
   * this option existed.
   *
   * @default undefined (NULL)
   */
  appliedBy?: string;
}

/**
 * Journal entry representing an applied migration stored in the database
 */
export interface MigrationJournalEntry {
  /** Auto-generated ID */
  id: number;
  /** Migration filename (e.g., '20260204-143052.ts') */
  filename: string;
  /** Timestamp when the migration was applied */
  applied_at: Date;
  /**
   * True when the migration was recorded by the fresh-database baseline
   * shortcut WITHOUT being executed (its effects came from the model-built
   * schema). False when the migration's up() really ran — including
   * runOnBaseline migrations executed during a baseline.
   */
  baselined: boolean;
  /**
   * The `MigrationConfig.appliedBy` label of the runner that recorded this
   * row, or NULL when that runner had none set (including every row written
   * before this column existed).
   */
  applied_by: string | null;
}

/**
 * Loaded migration with metadata from the filesystem
 */
export interface LoadedMigration {
  /** Migration filename */
  filename: string;
  /** Parsed timestamp from filename (YYYYMMDD-HHMMSS) */
  timestamp: string;
  /** The migration instance */
  migration: Migration;
  /** Absolute path to the migration file */
  filePath: string;
}

/**
 * Result of running migrations
 */
export interface MigrationRunResult {
  /** List of successfully applied migration filenames */
  applied: string[];
  /** List of skipped migration filenames (already applied) */
  skipped: string[];
  /**
   * Filenames recorded during a fresh-database baseline without being
   * executed (their effects are covered by the model-built schema). Only
   * present when up() took the fresh-database baseline path; baselined
   * migrations are also listed in `skipped`. Executed runOnBaseline
   * migrations appear in `applied` instead.
   */
  baselined?: string[];
  /** If a migration failed, contains the filename and error */
  failed?: {
    filename: string;
    error: Error;
  };
}

/**
 * Direction for migration execution
 */
export type MigrationDirection = 'up' | 'down';
