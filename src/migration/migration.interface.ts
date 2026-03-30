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
