import { describe, test, expect } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';

class EmptyDefaultEntity extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class EmptyDefaultDatabase extends DbContext {
  get items(): DbEntityTable<EmptyDefaultEntity> {
    return this.table(EmptyDefaultEntity);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(EmptyDefaultEntity, entity => {
      entity.toTable('empty_default_items');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'empty_default_items_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 100)).isRequired().hasDefaultValue('');
    });
  }
}

async function cleanup(client: any) {
  await client.query(`DROP TABLE IF EXISTS empty_default_items CASCADE`);
  await client.query(`DROP SEQUENCE IF EXISTS empty_default_items_id_seq CASCADE`);
}

describe("hasDefaultValue('') for column", () => {
  test('should create column with empty string default', async () => {
    const client = createFreshClient();
    const db = new EmptyDefaultDatabase(client);

    try {
      await cleanup(client);
      await db.getSchemaManager().ensureCreated();

      // Verify the column default is the empty string
      const result = await client.query(`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'empty_default_items'
          AND column_name = 'label'
      `);

      expect(result.rows).toHaveLength(1);
      // PostgreSQL stores empty string default as: ''::character varying
      expect(result.rows[0].column_default).toMatch(/^''(::.*)?$/);

      // Verify INSERT that omits the column produces an empty string value via the default
      await client.query(`INSERT INTO empty_default_items DEFAULT VALUES`);
      const rows = await client.query(`SELECT label FROM empty_default_items`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].label).toBe('');
    } finally {
      await cleanup(client);
      await db.dispose();
    }
  });
});
