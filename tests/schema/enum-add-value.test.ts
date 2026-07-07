import { describe, test, expect, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbEntity, DbColumn, DbModelConfig, integer, pgEnum, enumColumn } from '../../src';

// Unique enum/table names so this suite can't collide with enums other test modules
// register into the global EnumTypeRegistry.
const addValStatus = pgEnum('test_enum_addval_status', ['draft', 'active', 'archived'] as const);

class AddValEntity extends DbEntity {
  id!: DbColumn<number>;
  status!: DbColumn<'draft' | 'active' | 'archived'>;
}

class AddValDatabase extends DbContext {
  get items(): DbEntityTable<AddValEntity> {
    return this.table(AddValEntity);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(AddValEntity, entity => {
      entity.toTable('test_enum_addval_items');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'test_enum_addval_items_id_seq' }));
      entity.property(e => e.status).hasType(enumColumn('status', addValStatus)).isRequired();
    });
  }
}

async function readEnumLabels(client: any, enumName: string): Promise<string[]> {
  const res = await client.query(`
    SELECT e.enumlabel AS label
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = $1
    ORDER BY e.enumsortorder
  `, [enumName]);
  return res.rows.map((r: any) => r.label);
}

// Regression coverage: adding a value to an existing pgEnum must be back-filled into a
// long-lived database. Previously analyze()/migrate() only ever CREATE'd an absent enum and
// silently ignored value drift on an existing one — so a new label reached fresh databases
// (via CREATE TYPE) but never existing ones, breaking any code that cast to that enum.
describe('ENUM add-value sync on an existing enum', () => {
  const client = createFreshClient();
  const db = new AddValDatabase(client);

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS test_enum_addval_items CASCADE`);
    await client.query(`DROP TYPE IF EXISTS test_enum_addval_status CASCADE`);
    await db.dispose();
  });

  test('analyze() emits add_enum_value for model values missing from an existing enum', async () => {
    // Simulate a long-lived DB whose enum predates the 'archived' value.
    await client.query(`DROP TABLE IF EXISTS test_enum_addval_items CASCADE`);
    await client.query(`DROP TYPE IF EXISTS test_enum_addval_status CASCADE`);
    await client.query(`CREATE TYPE "test_enum_addval_status" AS ENUM ('draft', 'active')`);

    const ops = await db.getSchemaManager().analyze();
    const addOp = ops.find(o => o.type === 'add_enum_value' && o.enumName === 'test_enum_addval_status');

    expect(addOp).toBeDefined();
    if (addOp && addOp.type === 'add_enum_value') {
      expect(addOp.values).toEqual(['archived']);
    }
  });

  test('migrate() adds the missing value so the DB enum matches the model', async () => {
    await db.getSchemaManager().migrate();

    const labels = await readEnumLabels(client, 'test_enum_addval_status');
    expect(labels).toContain('archived');
    expect(labels).toEqual(['draft', 'active', 'archived']);
  });

  test('re-running analyze() is a no-op once the enum is in sync (idempotent)', async () => {
    const ops = await db.getSchemaManager().analyze();
    const addOp = ops.find(o => o.type === 'add_enum_value' && o.enumName === 'test_enum_addval_status');

    expect(addOp).toBeUndefined();
  });
});
