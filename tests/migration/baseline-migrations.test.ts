import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createFreshClient } from '../utils/test-database';
import {
  MigrationJournal,
  MigrationRunner,
  DbModelConfig,
  DbEntity,
  DbColumn,
  integer,
  varchar,
  text,
  DatabaseClient,
} from '../../src';
import { DatabaseContext } from '../../src/entity/db-context';

// Test entities — the model the fresh-DB baseline path builds the schema from
class BaselineItem extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class BaselineConfigRow extends DbEntity {
  id!: DbColumn<number>;
  configKey!: DbColumn<string>;
  configValue!: DbColumn<string>;
}

class BaselineTestDb extends DatabaseContext {
  get items() {
    return this.table(BaselineItem);
  }

  get configRows() {
    return this.table(BaselineConfigRow);
  }

  protected setupModel(model: DbModelConfig): void {
    model.entity(BaselineItem, e => {
      e.toTable('baseline_test_items');
      e.property(u => u.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      e.property(u => u.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(BaselineConfigRow, e => {
      e.toTable('baseline_test_config');
      e.property(u => u.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity());
      e.property(u => u.configKey).hasType(varchar('config_key', 100)).isRequired();
      e.property(u => u.configValue).hasType(text('config_value')).isRequired();
    });
  }
}

// Own temp directory + journal table so this file cannot clash with
// manual-migration.test.ts state
const TEST_MIGRATIONS_DIR = path.join(__dirname, 'temp_baseline_migrations');
const JOURNAL_TABLE = '__baseline_migrations';

function cleanupMigrationsDir() {
  if (fs.existsSync(TEST_MIGRATIONS_DIR)) {
    fs.rmSync(TEST_MIGRATIONS_DIR, { recursive: true });
  }
}

// Helper to create a test migration file. Supports multiple up/down
// statements and the runOnBaseline flag.
function createTestMigration(
  filename: string,
  options: { up: string[]; down?: string[]; runOnBaseline?: boolean }
) {
  if (!fs.existsSync(TEST_MIGRATIONS_DIR)) {
    fs.mkdirSync(TEST_MIGRATIONS_DIR, { recursive: true });
  }

  // Escape backticks in SQL for template literals
  const upBody = options.up
    .map(sql => `    await db.query(\`${sql.replace(/`/g, '\\`')}\`);`)
    .join('\n');
  const downBody = (options.down ?? ['SELECT 1'])
    .map(sql => `    await db.query(\`${sql.replace(/`/g, '\\`')}\`);`)
    .join('\n');
  const flagLine = options.runOnBaseline ? '  runOnBaseline = true;\n\n' : '';

  const content = `import type { Migration } from '../../../src';

export default class implements Migration {
${flagLine}  async up(db: any): Promise<void> {
${upBody}
  }

  async down(db: any): Promise<void> {
${downBody}
  }
}
`;

  fs.writeFileSync(path.join(TEST_MIGRATIONS_DIR, filename), content);
}

describe('Baseline Migrations (fresh-database path)', () => {
  let client: DatabaseClient;
  let db: BaselineTestDb;
  let runner: MigrationRunner;

  const dropTestTables = async () => {
    try {
      await client.query(`DROP TABLE IF EXISTS "public"."${JOURNAL_TABLE}" CASCADE`);
      await client.query('DROP TABLE IF EXISTS "baseline_test_items" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_test_config" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_multi_stmt" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_one" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_two" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_three" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_four" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_five" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_marker_six" CASCADE');
      await client.query('DROP TABLE IF EXISTS "baseline_fail_toggle" CASCADE');
    } catch {}
  };

  const tableExists = async (tableName: string): Promise<boolean> => {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) as exists`,
      [tableName]
    );
    return result.rows[0].exists;
  };

  const journalRows = async (): Promise<{ filename: string; baselined: boolean }[]> => {
    const result = await client.query(
      `SELECT filename, baselined FROM "public"."${JOURNAL_TABLE}" ORDER BY filename ASC`
    );
    return result.rows;
  };

  // The downstream detection shape: "was this database ever baselined?"
  const dbWasBaselined = async (): Promise<boolean> => {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM "public"."${JOURNAL_TABLE}" WHERE baselined) as exists`
    );
    return result.rows[0].exists;
  };

  beforeAll(async () => {
    client = createFreshClient();
    db = new BaselineTestDb(client);
  });

  beforeEach(async () => {
    cleanupMigrationsDir();
    await dropTestTables();

    runner = new MigrationRunner(db, {
      migrationsDirectory: TEST_MIGRATIONS_DIR,
      journalTable: JOURNAL_TABLE,
      verbose: false,
    });
  });

  afterAll(async () => {
    cleanupMigrationsDir();
    await dropTestTables();
    await client.end();
  });

  describe('fresh database (no journal table)', () => {
    it('should mark baseline-recorded migrations baselined = true without executing them', async () => {
      createTestMigration('20250601-120000.ts', {
        up: ['CREATE TABLE baseline_marker_one (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_one'],
      });
      createTestMigration('20250602-120000.ts', {
        up: ['CREATE TABLE baseline_marker_two (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_two'],
      });

      const result = await runner.up();

      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(['20250601-120000.ts', '20250602-120000.ts']);
      expect(result.baselined).toEqual(['20250601-120000.ts', '20250602-120000.ts']);
      expect(result.failed).toBeUndefined();

      // Schema came from the model build...
      expect(await tableExists('baseline_test_items')).toBe(true);
      expect(await tableExists('baseline_test_config')).toBe(true);

      // ...the migrations themselves never ran
      expect(await tableExists('baseline_marker_one')).toBe(false);
      expect(await tableExists('baseline_marker_two')).toBe(false);

      // Journal marks both rows as baselined
      expect(await journalRows()).toEqual([
        { filename: '20250601-120000.ts', baselined: true },
        { filename: '20250602-120000.ts', baselined: true },
      ]);
    });

    it('should execute runOnBaseline seed migrations and record them baselined = false', async () => {
      createTestMigration('20250603-120000.ts', {
        up: ['CREATE TABLE baseline_marker_three (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_three'],
      });
      createTestMigration('20250604-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('seed', 'v1')`],
        down: [`DELETE FROM baseline_test_config WHERE config_key = 'seed'`],
        runOnBaseline: true,
      });
      createTestMigration('20250605-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('seed2', 'v2')`],
        down: [`DELETE FROM baseline_test_config WHERE config_key = 'seed2'`],
        runOnBaseline: true,
      });

      const result = await runner.up();

      // Executed runOnBaseline migrations, in journal order
      expect(result.applied).toEqual(['20250604-120000.ts', '20250605-120000.ts']);
      expect(result.skipped).toEqual(['20250603-120000.ts']);
      expect(result.baselined).toEqual(['20250603-120000.ts']);
      expect(result.failed).toBeUndefined();

      // Seed rows really landed — the model-built table existed before the
      // runOnBaseline migrations ran
      const seeds = await client.query(
        `SELECT config_key, config_value FROM baseline_test_config ORDER BY config_key`
      );
      expect(seeds.rows).toEqual([
        { config_key: 'seed', config_value: 'v1' },
        { config_key: 'seed2', config_value: 'v2' },
      ]);

      // The plain migration was only recorded
      expect(await tableExists('baseline_marker_three')).toBe(false);

      expect(await journalRows()).toEqual([
        { filename: '20250603-120000.ts', baselined: true },
        { filename: '20250604-120000.ts', baselined: false },
        { filename: '20250605-120000.ts', baselined: false },
      ]);

      // status() exposes the flag too
      const status = await runner.status();
      expect(status.map(s => ({ filename: s.filename, baselined: s.baselined }))).toEqual([
        { filename: '20250603-120000.ts', baselined: true },
        { filename: '20250604-120000.ts', baselined: false },
        { filename: '20250605-120000.ts', baselined: false },
      ]);
    });

    it('should run a data backfill over model-built tables', async () => {
      createTestMigration('20250613-120000.ts', {
        up: [`INSERT INTO baseline_test_items (name) VALUES ('alpha'), ('beta')`],
        down: [`DELETE FROM baseline_test_items WHERE name IN ('alpha', 'beta')`],
        runOnBaseline: true,
      });
      createTestMigration('20250614-120000.ts', {
        up: ['UPDATE baseline_test_items SET name = UPPER(name)'],
        down: ['UPDATE baseline_test_items SET name = LOWER(name)'],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual(['20250613-120000.ts', '20250614-120000.ts']);
      expect(result.failed).toBeUndefined();

      // Seed then backfill really ran, in order, against the model-built table
      const items = await client.query('SELECT name FROM baseline_test_items ORDER BY id');
      expect(items.rows).toEqual([{ name: 'ALPHA' }, { name: 'BETA' }]);

      expect(await journalRows()).toEqual([
        { filename: '20250613-120000.ts', baselined: false },
        { filename: '20250614-120000.ts', baselined: false },
      ]);
    });

    it('should apply storage parameters (reloptions) the schema model cannot represent', async () => {
      createTestMigration('20250616-120000.ts', {
        up: ['ALTER TABLE baseline_test_items SET (autovacuum_enabled = false)'],
        down: ['ALTER TABLE baseline_test_items RESET (autovacuum_enabled)'],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual(['20250616-120000.ts']);
      expect(result.failed).toBeUndefined();

      // The reloption is visible in the catalog on the freshly built DB
      const reloptions = await client.query(
        `SELECT reloptions FROM pg_class WHERE relname = 'baseline_test_items' AND relkind = 'r'`
      );
      expect(reloptions.rows).toHaveLength(1);
      expect(reloptions.rows[0].reloptions).toEqual(
        expect.arrayContaining(['autovacuum_enabled=false'])
      );

      expect(await journalRows()).toEqual([
        { filename: '20250616-120000.ts', baselined: false },
      ]);
    });

    it('should execute all statements of a multi-statement runOnBaseline migration', async () => {
      createTestMigration('20250617-120000.ts', {
        up: [
          'CREATE TABLE baseline_multi_stmt (id INT PRIMARY KEY, label TEXT)',
          `INSERT INTO baseline_multi_stmt (id, label) VALUES (1, 'seeded')`,
          `COMMENT ON TABLE baseline_multi_stmt IS 'baseline seeded'`,
        ],
        down: ['DROP TABLE baseline_multi_stmt'],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual(['20250617-120000.ts']);
      expect(result.failed).toBeUndefined();

      expect(await tableExists('baseline_multi_stmt')).toBe(true);

      const rows = await client.query('SELECT id, label FROM baseline_multi_stmt');
      expect(rows.rows).toEqual([{ id: 1, label: 'seeded' }]);

      const comment = await client.query(
        `SELECT obj_description('baseline_multi_stmt'::regclass, 'pg_class') as cmt`
      );
      expect(comment.rows[0].cmt).toBe('baseline seeded');

      expect(await journalRows()).toEqual([
        { filename: '20250617-120000.ts', baselined: false },
      ]);
    });

    it('should execute interleaved runOnBaseline migrations strictly in journal order, recording non-flagged first', async () => {
      createTestMigration('20250618-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250619-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('ord-a', '1')`],
        runOnBaseline: true,
      });
      createTestMigration('20250620-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250621-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('ord-b', '2')`],
        runOnBaseline: true,
      });
      createTestMigration('20250622-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250623-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('ord-c', '3')`],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual([
        '20250619-120000.ts',
        '20250621-120000.ts',
        '20250623-120000.ts',
      ]);
      expect(result.skipped).toEqual([
        '20250618-120000.ts',
        '20250620-120000.ts',
        '20250622-120000.ts',
      ]);
      expect(result.baselined).toEqual(result.skipped);
      expect(result.failed).toBeUndefined();

      // Execution order is journal order — identity ids prove insertion order
      const ordered = await client.query('SELECT config_key FROM baseline_test_config ORDER BY id');
      expect(ordered.rows.map((r: any) => r.config_key)).toEqual(['ord-a', 'ord-b', 'ord-c']);

      // Non-flagged migrations were all recorded BEFORE the flagged ones ran
      // (journal id order), so a mid-run failure can never leave them pending
      const journalByInsertion = await client.query(
        `SELECT filename FROM "public"."${JOURNAL_TABLE}" ORDER BY id`
      );
      expect(journalByInsertion.rows.map((r: any) => r.filename)).toEqual([
        '20250618-120000.ts',
        '20250620-120000.ts',
        '20250622-120000.ts',
        '20250619-120000.ts',
        '20250621-120000.ts',
        '20250623-120000.ts',
      ]);

      expect(await journalRows()).toEqual([
        { filename: '20250618-120000.ts', baselined: true },
        { filename: '20250619-120000.ts', baselined: false },
        { filename: '20250620-120000.ts', baselined: true },
        { filename: '20250621-120000.ts', baselined: false },
        { filename: '20250622-120000.ts', baselined: true },
        { filename: '20250623-120000.ts', baselined: false },
      ]);
    });

    it('should baseline a fresh database with zero migration files', async () => {
      const result = await runner.up();

      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.baselined).toEqual([]);
      expect(result.failed).toBeUndefined();

      // Schema built, journal created and empty
      expect(await tableExists('baseline_test_items')).toBe(true);
      expect(await journalRows()).toEqual([]);
    });

    it('should execute every migration on a fresh database when ALL are runOnBaseline', async () => {
      createTestMigration('20250624-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('only-a', '1')`],
        runOnBaseline: true,
      });
      createTestMigration('20250625-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('only-b', '2')`],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual(['20250624-120000.ts', '20250625-120000.ts']);
      expect(result.skipped).toEqual([]);
      expect(result.baselined).toEqual([]);
      expect(result.failed).toBeUndefined();

      const seeds = await client.query('SELECT config_key FROM baseline_test_config ORDER BY id');
      expect(seeds.rows.map((r: any) => r.config_key)).toEqual(['only-a', 'only-b']);

      expect(await journalRows()).toEqual([
        { filename: '20250624-120000.ts', baselined: false },
        { filename: '20250625-120000.ts', baselined: false },
      ]);
    });

    it('should report baselined and executed counts through the configured logger', async () => {
      createTestMigration('20250630-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250701-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('log-seed', '1')`],
        runOnBaseline: true,
      });

      const logs: string[] = [];
      const verboseRunner = new MigrationRunner(db, {
        migrationsDirectory: TEST_MIGRATIONS_DIR,
        journalTable: JOURNAL_TABLE,
        verbose: true,
        logger: message => {
          logs.push(message);
        },
      });

      await verboseRunner.up();

      expect(logs.some(m => m.includes('Recorded as applied (baselined): 20250630-120000.ts'))).toBe(true);
      expect(logs.some(m => m.includes('Applying (runOnBaseline): 20250701-120000.ts'))).toBe(true);
      expect(
        logs.some(m =>
          m.includes('1 migration(s) baselined (recorded, not executed), 1 runOnBaseline migration(s) executed')
        )
      ).toBe(true);
    });
  });

  describe('failure semantics on the baseline path', () => {
    it('should fail loudly on a throwing runOnBaseline migration and leave it pending', async () => {
      createTestMigration('20250606-120000.ts', {
        up: ['SELECT 1'],
      });
      // Fails on the fresh run: baseline_fail_toggle does not exist yet.
      // (The file cannot be rewritten between runs — the module registry
      // caches it — so the failure is environmental instead.)
      createTestMigration('20250607-120000.ts', {
        up: ['INSERT INTO baseline_fail_toggle (id) VALUES (1)'],
        down: ['DELETE FROM baseline_fail_toggle WHERE id = 1'],
        runOnBaseline: true,
      });
      createTestMigration('20250608-120000.ts', {
        up: [`INSERT INTO baseline_test_config (config_key, config_value) VALUES ('after-fail', 'v1')`],
        down: [`DELETE FROM baseline_test_config WHERE config_key = 'after-fail'`],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual([]);
      expect(result.baselined).toEqual(['20250606-120000.ts']);
      expect(result.failed?.filename).toBe('20250607-120000.ts');
      expect(result.failed?.error).toBeDefined();

      // The second flagged migration was NOT executed after the failure
      const beforeRetry = await client.query(
        `SELECT 1 FROM baseline_test_config WHERE config_key = 'after-fail'`
      );
      expect(beforeRetry.rows).toHaveLength(0);

      // Baselined row is recorded; the failed and following runOnBaseline
      // migrations are NOT — they stay pending
      expect(await journalRows()).toEqual([
        { filename: '20250606-120000.ts', baselined: true },
      ]);

      const pending = await runner.getPending();
      expect(pending.map(p => p.filename)).toEqual([
        '20250607-120000.ts',
        '20250608-120000.ts',
      ]);

      // Fix the environment and re-run: the journal now exists, so the
      // pending runOnBaseline migrations execute through the normal path
      await client.query('CREATE TABLE baseline_fail_toggle (id INT PRIMARY KEY)');

      const retry = await runner.up();

      expect(retry.applied).toEqual(['20250607-120000.ts', '20250608-120000.ts']);
      expect(retry.failed).toBeUndefined();
      expect(retry.baselined).toBeUndefined();

      // Both retried migrations really ran
      const toggleRows = await client.query('SELECT id FROM baseline_fail_toggle');
      expect(toggleRows.rows).toHaveLength(1);

      const seeds = await client.query(
        `SELECT config_value FROM baseline_test_config WHERE config_key = 'after-fail'`
      );
      expect(seeds.rows).toHaveLength(1);

      expect(await journalRows()).toEqual([
        { filename: '20250606-120000.ts', baselined: true },
        { filename: '20250607-120000.ts', baselined: false },
        { filename: '20250608-120000.ts', baselined: false },
      ]);
    });

    it('should roll back a partially executed runOnBaseline migration (transaction)', async () => {
      // First statement succeeds, second fails — the whole migration must
      // roll back and stay unrecorded
      createTestMigration('20250702-120000.ts', {
        up: [
          `INSERT INTO baseline_test_config (config_key, config_value) VALUES ('atomic', 'v1')`,
          'SELECT * FROM baseline_nonexistent_table_xyz',
        ],
        down: [`DELETE FROM baseline_test_config WHERE config_key = 'atomic'`],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.failed?.filename).toBe('20250702-120000.ts');
      expect(result.applied).toEqual([]);

      // The INSERT from the first statement was rolled back
      const rows = await client.query(
        `SELECT 1 FROM baseline_test_config WHERE config_key = 'atomic'`
      );
      expect(rows.rows).toHaveLength(0);

      // Nothing recorded — the migration stays pending
      expect(await journalRows()).toEqual([]);

      const pending = await runner.getPending();
      expect(pending.map(p => p.filename)).toEqual(['20250702-120000.ts']);
    });
  });

  describe('journal upgrade (pre-baselined column)', () => {
    const createOldShapeJournal = async () => {
      await client.query(`
        CREATE TABLE "public"."${JOURNAL_TABLE}" (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    };

    it('should add the baselined column idempotently and default old rows to false', async () => {
      await createOldShapeJournal();
      await client.query(
        `INSERT INTO "public"."${JOURNAL_TABLE}" (filename) VALUES ('20250501-120000.ts')`
      );

      const journal = new MigrationJournal(client, { journalTable: JOURNAL_TABLE });

      // Upgrade, then again — must be idempotent
      await journal.ensureTable();
      await journal.ensureTable();

      const column = await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'baselined'`,
        [JOURNAL_TABLE]
      );
      expect(column.rows).toHaveLength(1);
      expect(column.rows[0].is_nullable).toBe('NO');
      expect(column.rows[0].column_default).toContain('false');

      // Pre-existing row reads as executed (baselined = false)
      const applied = await journal.getApplied();
      expect(applied).toHaveLength(1);
      expect(applied[0].filename).toBe('20250501-120000.ts');
      expect(applied[0].baselined).toBe(false);

      // New records can carry the flag
      await journal.recordApplied('20250502-120000.ts', true);
      const all = await journal.getApplied();
      expect(all.map(a => ({ filename: a.filename, baselined: a.baselined }))).toEqual([
        { filename: '20250501-120000.ts', baselined: false },
        { filename: '20250502-120000.ts', baselined: true },
      ]);
    });

    it('should upgrade a pre-column journal through runner.up() and migrate normally', async () => {
      await createOldShapeJournal();
      await client.query(
        `INSERT INTO "public"."${JOURNAL_TABLE}" (filename) VALUES ('20250609-120000.ts')`
      );

      createTestMigration('20250609-120000.ts', {
        up: ['SELECT 1'],
      });
      createTestMigration('20250610-120000.ts', {
        up: ['CREATE TABLE baseline_marker_four (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_four'],
      });

      const result = await runner.up();

      // Journal existed → normal path, no baselining
      expect(result.applied).toEqual(['20250610-120000.ts']);
      expect(result.skipped).toEqual(['20250609-120000.ts']);
      expect(result.baselined).toBeUndefined();

      // The pending migration really ran
      expect(await tableExists('baseline_marker_four')).toBe(true);

      expect(await journalRows()).toEqual([
        { filename: '20250609-120000.ts', baselined: false },
        { filename: '20250610-120000.ts', baselined: false },
      ]);
    });

    it('should read mixed old and new rows correctly via getApplied() and status()', async () => {
      await createOldShapeJournal();
      await client.query(
        `INSERT INTO "public"."${JOURNAL_TABLE}" (filename) VALUES ('20250626-120000.ts')`
      );

      createTestMigration('20250626-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250627-120000.ts', { up: ['SELECT 1'] });
      createTestMigration('20250628-120000.ts', { up: ['SELECT 1'] });

      const journal = new MigrationJournal(client, { journalTable: JOURNAL_TABLE });
      await journal.ensureTable();

      // A new-style baselined record next to the pre-upgrade row
      await journal.recordApplied('20250627-120000.ts', true);

      const applied = await journal.getApplied();
      expect(applied.map(a => ({ filename: a.filename, baselined: a.baselined }))).toEqual([
        { filename: '20250626-120000.ts', baselined: false },
        { filename: '20250627-120000.ts', baselined: true },
      ]);

      // status() (which re-runs ensureTable — idempotent again) merges the flag
      const status = await runner.status();
      expect(
        status.map(s => ({ filename: s.filename, applied: s.applied, baselined: s.baselined }))
      ).toEqual([
        { filename: '20250626-120000.ts', applied: true, baselined: false },
        { filename: '20250627-120000.ts', applied: true, baselined: true },
        { filename: '20250628-120000.ts', applied: false, baselined: undefined },
      ]);
    });
  });

  describe('non-fresh database (normal path unchanged)', () => {
    it('should execute migrations normally and record baselined = false; runOnBaseline has no effect', async () => {
      // Pre-create journal table so runner.up() uses the normal migration flow
      await runner.getJournal().ensureTable();

      createTestMigration('20250611-120000.ts', {
        up: ['CREATE TABLE baseline_marker_five (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_five'],
      });
      createTestMigration('20250612-120000.ts', {
        up: ['CREATE TABLE baseline_marker_six (id SERIAL PRIMARY KEY)'],
        down: ['DROP TABLE baseline_marker_six'],
        runOnBaseline: true,
      });

      const result = await runner.up();

      expect(result.applied).toEqual(['20250611-120000.ts', '20250612-120000.ts']);
      expect(result.skipped).toEqual([]);
      expect(result.baselined).toBeUndefined();
      expect(result.failed).toBeUndefined();

      // Both really ran
      expect(await tableExists('baseline_marker_five')).toBe(true);
      expect(await tableExists('baseline_marker_six')).toBe(true);

      expect(await journalRows()).toEqual([
        { filename: '20250611-120000.ts', baselined: false },
        { filename: '20250612-120000.ts', baselined: false },
      ]);
    });
  });

  describe('downstream detection (baselined marker)', () => {
    it('should answer the consumer EXISTS query: false for a never-baselined DB, true after a fresh baseline', async () => {
      createTestMigration('20250629-120000.ts', { up: ['SELECT 1'] });

      // Phase A: journal pre-created → migrations run normally → the
      // detection query says "never baselined"
      await runner.getJournal().ensureTable();

      const normalRun = await runner.up();
      expect(normalRun.applied).toEqual(['20250629-120000.ts']);
      expect(await dbWasBaselined()).toBe(false);

      // Phase B: wipe to a fresh database → the same file is baselined →
      // the detection query flips to true
      await dropTestTables();

      const freshRun = await runner.up();
      expect(freshRun.baselined).toEqual(['20250629-120000.ts']);
      expect(await dbWasBaselined()).toBe(true);
    });
  });
});
