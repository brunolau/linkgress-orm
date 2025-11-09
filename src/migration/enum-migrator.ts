import { DatabaseClient } from '../database/database-client.interface';
import { EnumTypeRegistry, EnumTypeDefinition } from '../types/enum-builder';

/**
 * Handles migration of PostgreSQL ENUM types
 */
export class EnumMigrator {
  private logQueries: boolean;

  constructor(
    private client: DatabaseClient,
    options?: { logQueries?: boolean }
  ) {
    this.logQueries = options?.logQueries ?? false;
  }

  /**
   * Get existing enum values from the database
   */
  private async getExistingEnumValues(enumName: string): Promise<string[] | null> {
    const query = `
      SELECT e.enumlabel as value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = $1
      ORDER BY e.enumsortorder
    `;

    const result = await this.client.query(query, [enumName]);

    if (result.rows.length === 0) {
      return null; // Enum doesn't exist
    }

    return result.rows.map(row => row.value);
  }

  /**
   * Add a new value to an existing enum
   */
  private async addEnumValue(enumName: string, value: string, afterValue?: string): Promise<void> {
    let sql = `ALTER TYPE "${enumName}" ADD VALUE '${value}'`;

    if (afterValue) {
      sql += ` AFTER '${afterValue}'`;
    }

    if (this.logQueries) {
      console.log(`  Adding value '${value}' to ENUM "${enumName}"...`);
    }

    await this.client.query(sql);

    if (this.logQueries) {
      console.log(`  ✓ Value '${value}' added to ENUM "${enumName}"\n`);
    }
  }

  /**
   * Remove a value from an enum (PostgreSQL 12+)
   * Note: This requires no existing rows to use this value
   */
  private async removeEnumValue(enumName: string, value: string): Promise<void> {
    // Check PostgreSQL version
    const versionResult = await this.client.query('SHOW server_version_num');
    const version = parseInt(versionResult.rows[0].server_version_num);

    if (version < 120000) {
      console.warn(`  ⚠ Cannot remove enum value '${value}' - requires PostgreSQL 12+`);
      console.warn(`  ⚠ Current version: ${version}. You need to recreate the enum type manually.`);
      return;
    }

    if (this.logQueries) {
      console.log(`  Removing value '${value}' from ENUM "${enumName}"...`);
    }

    // Note: This will fail if any rows reference this value
    try {
      await this.client.query(`ALTER TYPE "${enumName}" DROP VALUE '${value}'`);

      if (this.logQueries) {
        console.log(`  ✓ Value '${value}' removed from ENUM "${enumName}"\n`);
      }
    } catch (error: any) {
      console.error(`  ✗ Failed to remove value '${value}' from ENUM "${enumName}"`);
      console.error(`  Error: ${error.message}`);
      console.error(`  This usually means there are existing rows using this value.`);
      throw error;
    }
  }

  /**
   * Migrate enum types - sync enum definitions with database
   */
  async migrateEnums(): Promise<void> {
    const enums = EnumTypeRegistry.getAll();

    if (enums.size === 0) {
      return;
    }

    if (this.logQueries) {
      console.log('Migrating ENUM types...\n');
    }

    for (const [enumName, enumDef] of enums.entries()) {
      const existingValues = await this.getExistingEnumValues(enumName);

      if (!existingValues) {
        // Enum doesn't exist, create it
        const values = enumDef.values.map(v => `'${v}'`).join(', ');
        const createEnumSQL = `CREATE TYPE "${enumName}" AS ENUM (${values})`;

        if (this.logQueries) {
          console.log(`  Creating ENUM type "${enumName}"...`);
        }
        await this.client.query(createEnumSQL);
        if (this.logQueries) {
          console.log(`  ✓ ENUM type "${enumName}" created\n`);
        }
        continue;
      }

      // Compare and sync values
      const newValues = new Set(enumDef.values);
      const oldValues = new Set(existingValues);

      // Find values to add
      const valuesToAdd = enumDef.values.filter(v => !oldValues.has(v));

      // Find values to remove
      const valuesToRemove = existingValues.filter(v => !newValues.has(v));

      if (valuesToAdd.length === 0 && valuesToRemove.length === 0) {
        if (this.logQueries) {
          console.log(`  ENUM "${enumName}" is up to date\n`);
        }
        continue;
      }

      // Remove values that are no longer needed
      for (const value of valuesToRemove) {
        await this.removeEnumValue(enumName, value);
      }

      // Add new values
      for (let i = 0; i < valuesToAdd.length; i++) {
        const value = valuesToAdd[i];
        const valueIndex = enumDef.values.indexOf(value);

        // Find the previous value for ordering
        let afterValue: string | undefined;
        if (valueIndex > 0) {
          afterValue = enumDef.values[valueIndex - 1];
        }

        await this.addEnumValue(enumName, value, afterValue);
      }
    }

    if (this.logQueries) {
      console.log('✓ ENUM types migrated successfully\n');
    }
  }
}
