import 'dotenv/config';
import { PgClient } from '../../src';
import { AppDatabase } from './appDatabase';

/**
 * Database Migration Tool
 *
 * The migrator will:
 * 1. Analyze the current database schema
 * 2. Compare it with the model definition
 * 3. Generate migration operations
 * 4. Prompt for confirmation on destructive operations (table/column drops)
 * 5. Apply the migrations
 */
async function main() {
  console.log('Linkgress ORM - Database Migration\n');

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(
    client,
    {
      logQueries: false, // Disable query logging for cleaner migration output
    }
  );

  try {
    // Get the automatic migrator
    const migrator = db.getMigrator();

    // Run the migration
    // This will:
    // - Analyze what needs to change
    // - Show all operations
    // - Prompt for confirmation on destructive operations
    // - Apply the changes
    await migrator.migrate();

  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { main };
