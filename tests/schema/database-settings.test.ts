import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { buildSetDatabaseSettingStatement, buildResetDatabaseSettingStatement } from '../../src/migration/dbsetting-sql';

// Database-level settings (`model.hasDbSetting('jit', 'off')`) — persisted via
// `ALTER DATABASE ... SET` into pg_db_role_setting so every NEW connection to the
// database inherits them. The declarations live on the model, and the schema
// manager converges the database toward them on ensureCreated()/migrate(), the
// same way declared statistics objects are reconciled.
//
// The tests use CUSTOM GUCs under the `linkgress_test.` namespace: they are
// settable at database level without being defined by any extension, and they
// leave the shared test database's REAL planner/executor settings untouched.
// Every test RESETs its keys in `finally`.

class Widget extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

const widgetEntity = (model: DbModelConfig, tableName: string): void => {
  model.entity(Widget, entity => {
    entity.toTable(tableName);

    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${tableName}_id_seq` }));
    entity.property(e => e.name).hasType(varchar('name', 100));
  });
};

class EnsureCreatedSettingsDatabase extends DbContext {
  get widgets(): DbEntityTable<Widget> {
    return this.table(Widget);
  }

  protected override setupModel(model: DbModelConfig): void {
    widgetEntity(model, 'widgets_dbset_ensure_test');
    model.hasDbSetting('linkgress_test.db_setting_ensure', 'off');
  }
}

// The "old model": same table, NO setting — baseline for the migrate() test.
class MigrateBaselineDatabase extends DbContext {
  get widgets(): DbEntityTable<Widget> {
    return this.table(Widget);
  }

  protected override setupModel(model: DbModelConfig): void {
    widgetEntity(model, 'widgets_dbset_migrate_test');
  }
}

class MigrateSettingsDatabase extends DbContext {
  get widgets(): DbEntityTable<Widget> {
    return this.table(Widget);
  }

  protected override setupModel(model: DbModelConfig): void {
    widgetEntity(model, 'widgets_dbset_migrate_test');
    model.hasDbSetting('linkgress_test.db_setting_migrate', '32MB');
  }
}

class ConvergeSettingsDatabase extends DbContext {
  get widgets(): DbEntityTable<Widget> {
    return this.table(Widget);
  }

  protected override setupModel(model: DbModelConfig): void {
    widgetEntity(model, 'widgets_dbset_converge_test');
    model.hasDbSetting('linkgress_test.db_setting_converge', 'declared');
  }
}

/** The database-wide (`setrole = 0`) value of one settings key, or undefined. */
const getDbSetting = async (client: any, key: string): Promise<string | undefined> => {
  const result = await client.query(`
    SELECT entry
    FROM pg_db_role_setting, LATERAL unnest(setconfig) AS entry
    WHERE setrole = 0
      AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
  `);
  const prefix = `${key}=`;
  const entry = result.rows.map((r: any) => r.entry).find((e: string) => e.startsWith(prefix));
  return entry === undefined ? undefined : entry.slice(prefix.length);
};

const resetDbSetting = async (client: any, key: string): Promise<void> => {
  await client.query(`DO $lnk_dbset$ BEGIN EXECUTE format('ALTER DATABASE %I RESET %s', current_database(), '${key}'); END $lnk_dbset$`);
};

describe('Database-level settings (model.hasDbSetting)', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  describe('model DSL', () => {
    test('collects settings, last declaration per key wins', () => {
      const model = new DbModelConfig();
      model.hasDbSetting('jit', 'off');
      model.hasDbSetting('work_mem', '32MB');
      model.hasDbSetting('jit', 'on');

      expect(model.getDatabaseSettings().get('jit')).toBe('on');
      expect(model.getDatabaseSettings().get('work_mem')).toBe('32MB');
    });

    test('normalizes booleans to on/off and numbers to strings', () => {
      const model = new DbModelConfig();
      model.hasDbSetting('jit', false);
      model.hasDbSetting('statement_timeout', 20000);

      expect(model.getDatabaseSettings().get('jit')).toBe('off');
      expect(model.getDatabaseSettings().get('statement_timeout')).toBe('20000');
    });

    test('rejects invalid setting names synchronously', () => {
      const model = new DbModelConfig();

      expect(() => model.hasDbSetting('bad name', 'x')).toThrow(/setting name/i);
      expect(() => model.hasDbSetting('jit; DROP TABLE x', 'x')).toThrow(/setting name/i);
      expect(() => model.hasDbSetting('a.b.c', 'x')).toThrow(/setting name/i);
    });

    test('rejects a value that would break out of the dollar-quoted DO body', () => {
      const model = new DbModelConfig();

      expect(() => model.hasDbSetting('jit', 'evil$lnk_dbset$')).toThrow(/value/i);
    });
  });

  describe('SQL builders (scaffold parity)', () => {
    test('buildSetDatabaseSettingStatement resolves the database name at run time', () => {
      const sql = buildSetDatabaseSettingStatement('jit', 'off');

      expect(sql).toBe(`DO $lnk_dbset$ BEGIN EXECUTE format('ALTER DATABASE %I SET %s = %L', current_database(), 'jit', 'off'); END $lnk_dbset$`);
    });

    test('buildSetDatabaseSettingStatement escapes single quotes in the value', () => {
      const sql = buildSetDatabaseSettingStatement('linkgress_test.quoted', "o'clock");

      expect(sql).toContain("'o''clock'");
    });

    test('buildResetDatabaseSettingStatement mirrors the set form', () => {
      const sql = buildResetDatabaseSettingStatement('jit');

      expect(sql).toBe(`DO $lnk_dbset$ BEGIN EXECUTE format('ALTER DATABASE %I RESET %s', current_database(), 'jit'); END $lnk_dbset$`);
    });
  });

  test('ensureCreated applies declared database settings', async () => {
    const client = createFreshClient();
    const db = new EnsureCreatedSettingsDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_ensure_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      expect(await getDbSetting(client, 'linkgress_test.db_setting_ensure')).toBe('off');
    } finally {
      await resetDbSetting(client, 'linkgress_test.db_setting_ensure');
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_ensure_test CASCADE`);
      await db.dispose();
    }
  });

  test('migrate() applies a missing setting on an existing database, then reports in-sync', async () => {
    const baselineClient = createFreshClient();
    const baseline = new MigrateBaselineDatabase(baselineClient);

    try {
      await baselineClient.query(`DROP TABLE IF EXISTS widgets_dbset_migrate_test CASCADE`);
      await baseline.getSchemaManager().ensureCreated();
    } finally {
      await baseline.dispose();
    }

    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db = new MigrateSettingsDatabase(client);

    try {
      const manager = db.getSchemaManager();
      const plan = await manager.analyze();
      const settingOps = plan.filter(op => op.type === 'set_database_setting');

      expect(settingOps).toEqual([
        { type: 'set_database_setting', name: 'linkgress_test.db_setting_migrate', value: '32MB' },
      ]);

      await manager.migrate();
      expect(await getDbSetting(client, 'linkgress_test.db_setting_migrate')).toBe('32MB');

      // Idempotence: a second analysis has nothing left to do for settings.
      const secondPlan = await manager.analyze();
      expect(secondPlan.filter(op => op.type === 'set_database_setting')).toEqual([]);
    } finally {
      await resetDbSetting(client, 'linkgress_test.db_setting_migrate');
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_migrate_test CASCADE`);
      await db.dispose();
    }
  });

  test('migrate() converges a drifted value back to the declared one', async () => {
    const client = createFreshClient();
    const db = new ConvergeSettingsDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_converge_test CASCADE`);
      await client.query(buildSetDatabaseSettingStatement('linkgress_test.db_setting_converge', 'drifted'));

      const manager = db.getSchemaManager();
      const plan = await manager.analyze();

      expect(plan.filter(op => op.type === 'set_database_setting')).toEqual([
        { type: 'set_database_setting', name: 'linkgress_test.db_setting_converge', value: 'declared' },
      ]);

      await manager.migrate();
      expect(await getDbSetting(client, 'linkgress_test.db_setting_converge')).toBe('declared');
    } finally {
      await resetDbSetting(client, 'linkgress_test.db_setting_converge');
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_converge_test CASCADE`);
      await db.dispose();
    }
  });

  test('settings the model does not declare are never touched', async () => {
    const client = createFreshClient();
    const db = new EnsureCreatedSettingsDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_ensure_test CASCADE`);
      await client.query(buildSetDatabaseSettingStatement('linkgress_test.db_setting_unmanaged', 'keep'));

      const manager = db.getSchemaManager();
      const plan = await manager.analyze();

      // Converge-only contract: no reset/change op may target the undeclared key.
      expect(plan.filter(op => op.type === 'set_database_setting' && (op as any).name === 'linkgress_test.db_setting_unmanaged')).toEqual([]);

      await manager.migrate();
      expect(await getDbSetting(client, 'linkgress_test.db_setting_unmanaged')).toBe('keep');
    } finally {
      await resetDbSetting(client, 'linkgress_test.db_setting_unmanaged');
      await resetDbSetting(client, 'linkgress_test.db_setting_ensure');
      await client.query(`DROP TABLE IF EXISTS widgets_dbset_ensure_test CASCADE`);
      await db.dispose();
    }
  });
});
