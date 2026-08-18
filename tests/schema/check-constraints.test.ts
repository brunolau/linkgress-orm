import { describe, test, expect, beforeEach } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { buildAddCheckConstraintStatement, buildDropCheckConstraintStatement } from '../../src/migration/check-constraint-sql';

// Test entity — the motivating shape: a pair of columns where the second
// becomes mandatory once the first is set (a carrier reference that must
// always travel with its billing-account reference).
class Shipment extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  carrierId!: DbColumn<number>;
  carrierAccountId!: DbColumn<number>;
}

const CONDITIONAL_NOT_NULL = '"carrier_id" IS NULL OR "carrier_account_id" IS NOT NULL';

class CheckConstraintTestDatabase extends DbContext {
  get shipments(): DbEntityTable<Shipment> {
    return this.table(Shipment);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Shipment, entity => {
      entity.toTable('shipments_chk_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'shipments_chk_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 200)).isRequired();
      entity.property(e => e.carrierId).hasType(integer('carrier_id'));
      entity.property(e => e.carrierAccountId).hasType(integer('carrier_account_id'));

      entity.hasCheckConstraint('chk_shipments_test_carrier_account', CONDITIONAL_NOT_NULL);
    });
  }
}

// Same table WITHOUT the constraint — the "old model" for migrate() reconciliation.
class MigrateBaselineDatabase extends DbContext {
  get shipments(): DbEntityTable<Shipment> {
    return this.table(Shipment);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Shipment, entity => {
      entity.toTable('shipments_chk_migrate_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'shipments_chk_migrate_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 200)).isRequired();
      entity.property(e => e.carrierId).hasType(integer('carrier_id'));
      entity.property(e => e.carrierAccountId).hasType(integer('carrier_account_id'));
    });
  }
}

// The "new model" — same table, check constraint added.
class MigrateWithCheckDatabase extends DbContext {
  get shipments(): DbEntityTable<Shipment> {
    return this.table(Shipment);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Shipment, entity => {
      entity.toTable('shipments_chk_migrate_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'shipments_chk_migrate_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 200)).isRequired();
      entity.property(e => e.carrierId).hasType(integer('carrier_id'));
      entity.property(e => e.carrierAccountId).hasType(integer('carrier_account_id'));

      entity.hasCheckConstraint('chk_shipments_migrate_test_carrier_account', CONDITIONAL_NOT_NULL);
    });
  }
}

const getCheckConstraintRow = async (client: any, tableName: string, constraintName: string) => {
  const result = await client.query(`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = $1
      AND con.contype = 'c'
      AND con.conname = $2
  `, [tableName, constraintName]);
  return result.rows[0];
};

describe('CHECK Constraint Support (ALTER TABLE ... ADD CONSTRAINT ... CHECK)', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('ensureCreated builds the declared check constraint and PostgreSQL enforces it', async () => {
    const client = createFreshClient();
    const db = new CheckConstraintTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS shipments_chk_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const row = await getCheckConstraintRow(client, 'shipments_chk_test', 'chk_shipments_test_carrier_account');
      expect(row).toBeDefined();
      expect(row.def).toContain('CHECK');

      // The conditional-not-null semantics, enforced by PostgreSQL itself:
      // a carrier WITHOUT its billing account must be impossible …
      await expectToReject(
        client.query(`INSERT INTO shipments_chk_test (label, carrier_id) VALUES ('violating', 1)`),
        /chk_shipments_test_carrier_account/
      );

      // … while every legitimate combination stays writable.
      await client.query(`INSERT INTO shipments_chk_test (label) VALUES ('both null')`);
      await client.query(`INSERT INTO shipments_chk_test (label, carrier_id, carrier_account_id) VALUES ('both set', 1, 2)`);
      await client.query(`INSERT INTO shipments_chk_test (label, carrier_account_id) VALUES ('account alone', 2)`);

      const count = await client.query(`SELECT COUNT(*)::int AS n FROM shipments_chk_test`);
      expect(count.rows[0].n).toBe(3);

      // ensureCreated must be idempotent — a second run may not fail on the
      // already-existing constraint (PostgreSQL has no ADD CONSTRAINT IF NOT
      // EXISTS, so the manager has to reconcile by name).
      await db.getSchemaManager().ensureCreated();
    } finally {
      await client.query(`DROP TABLE IF EXISTS shipments_chk_test CASCADE`);
      await db.dispose();
    }
  });

  test('migrate() adds a check constraint missing on an existing table, then reports in-sync', async () => {
    const clientV1 = createFreshClient();
    const v1 = new MigrateBaselineDatabase(clientV1);

    try {
      await clientV1.query(`DROP TABLE IF EXISTS shipments_chk_migrate_test CASCADE`);
      await v1.getSchemaManager().ensureCreated();

      // Model v2 declares the constraint on the already-existing table.
      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      const v2 = new MigrateWithCheckDatabase(clientV2);

      try {
        const plannedOps = await v2.getSchemaManager().analyze();
        const checkOps = plannedOps.filter(op => op.type === 'create_check_constraint');
        expect(checkOps).toHaveLength(1);
        expect((checkOps[0] as any).constraintName).toBe('chk_shipments_migrate_test_carrier_account');

        await v2.getSchemaManager().migrate();

        const row = await getCheckConstraintRow(clientV2, 'shipments_chk_migrate_test', 'chk_shipments_migrate_test_carrier_account');
        expect(row).toBeDefined();

        await expectToReject(
          clientV2.query(`INSERT INTO shipments_chk_migrate_test (label, carrier_id) VALUES ('violating', 1)`),
          /chk_shipments_migrate_test_carrier_account/
        );

        // Reconciliation is by name — a second analyze must not re-plan it.
        const opsAfter = await v2.getSchemaManager().analyze();
        expect(opsAfter.filter(op => op.type === 'create_check_constraint')).toHaveLength(0);
      } finally {
        await v2.dispose();
      }
    } finally {
      await clientV1.query(`DROP TABLE IF EXISTS shipments_chk_migrate_test CASCADE`);
      await v1.dispose();
    }
  });

  test('migrate() creates check constraints for BRAND-NEW tables in the same run', async () => {
    const client = createFreshClient();
    const db = new CheckConstraintTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS shipments_chk_test CASCADE`);

      // migrate() (not ensureCreated) on a database where the table does not
      // exist yet — the create_table path must carry the constraint too.
      await db.getSchemaManager().migrate();

      const row = await getCheckConstraintRow(client, 'shipments_chk_test', 'chk_shipments_test_carrier_account');
      expect(row).toBeDefined();

      await expectToReject(
        client.query(`INSERT INTO shipments_chk_test (label, carrier_id) VALUES ('violating', 1)`),
        /chk_shipments_test_carrier_account/
      );
    } finally {
      await client.query(`DROP TABLE IF EXISTS shipments_chk_test CASCADE`);
      await db.dispose();
    }
  });

  test('hasCheckConstraint captures metadata (name + raw expression)', () => {
    const model = new DbModelConfig();
    model.entity(Shipment, entity => {
      entity.toTable('chk_metadata_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.label).hasType(varchar('label', 200));
      entity.property(e => e.carrierId).hasType(integer('carrier_id'));
      entity.property(e => e.carrierAccountId).hasType(integer('carrier_account_id'));

      entity.hasCheckConstraint('chk_meta', CONDITIONAL_NOT_NULL);
    });

    const metadata = EntityMetadataStore.getMetadata(Shipment)!;
    const chk = (metadata.checkConstraints || []).find(c => c.name === 'chk_meta')!;

    expect(chk).toBeDefined();
    expect(chk.expression).toBe(CONDITIONAL_NOT_NULL);
  });

  test('check-constraint-sql builders emit canonical statements', () => {
    expect(buildAddCheckConstraintStatement(
      { name: 'chk_x', expression: '"a" IS NULL OR "b" IS NOT NULL' },
      '"public"."shipment"'
    )).toBe('ALTER TABLE "public"."shipment" ADD CONSTRAINT "chk_x" CHECK ("a" IS NULL OR "b" IS NOT NULL)');

    expect(buildDropCheckConstraintStatement('"shipment"', 'chk_x', { ifExists: true }))
      .toBe('ALTER TABLE "shipment" DROP CONSTRAINT IF EXISTS "chk_x"');
  });
});
