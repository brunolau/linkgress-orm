import { DatabaseClient } from '../database/database-client.interface';
import { MigrationJournalEntry, MigrationConfig } from './migration.interface';

/**
 * Manages the migration journal table that tracks which migrations have been applied.
 *
 * The journal table stores a record for each successfully applied migration,
 * allowing the system to know which migrations to skip on subsequent runs.
 */
export class MigrationJournal {
  private tableName: string;
  private schemaName: string;
  private qualifiedName: string;

  constructor(
    private client: DatabaseClient,
    config?: Pick<MigrationConfig, 'journalTable' | 'journalSchema'>
  ) {
    this.tableName = config?.journalTable || '__migrations';
    this.schemaName = config?.journalSchema || 'public';
    this.qualifiedName = `"${this.schemaName}"."${this.tableName}"`;
  }

  /**
   * Check if the journal table exists in the database without creating it.
   * Used to detect whether the schema has been previously set up.
   */
  async tableExists(): Promise<boolean> {
    const result = await this.client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) as exists`,
      [this.schemaName, this.tableName]
    );
    return result.rows[0]?.exists === true;
  }

  /**
   * Ensure the journal table exists in the database.
   * Creates it if it doesn't exist.
   */
  async ensureTable(): Promise<void> {
    // First ensure the schema exists
    if (this.schemaName !== 'public') {
      await this.client.query(
        `CREATE SCHEMA IF NOT EXISTS "${this.schemaName}"`
      );
    }

    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.qualifiedName} (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await this.client.query(sql);
  }

  /**
   * Get all applied migrations ordered by filename (chronologically).
   */
  async getApplied(): Promise<MigrationJournalEntry[]> {
    const result = await this.client.query<MigrationJournalEntry>(
      `SELECT id, filename, applied_at FROM ${this.qualifiedName} ORDER BY filename ASC`
    );
    return result.rows;
  }

  /**
   * Check if a specific migration has been applied.
   * @param filename - The migration filename to check
   */
  async isApplied(filename: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM ${this.qualifiedName} WHERE filename = $1`,
      [filename]
    );
    return result.rows.length > 0;
  }

  /**
   * Record a migration as successfully applied.
   * @param filename - The migration filename
   */
  async recordApplied(filename: string): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.qualifiedName} (filename) VALUES ($1)`,
      [filename]
    );
  }

  /**
   * Remove a migration record (used when rolling back).
   * @param filename - The migration filename to remove
   */
  async recordReverted(filename: string): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.qualifiedName} WHERE filename = $1`,
      [filename]
    );
  }

  /**
   * Get the qualified table name (schema.table).
   */
  getQualifiedName(): string {
    return this.qualifiedName;
  }

  /**
   * Get the table name without schema.
   */
  getTableName(): string {
    return this.tableName;
  }

  /**
   * Get the schema name.
   */
  getSchemaName(): string {
    return this.schemaName;
  }
}
