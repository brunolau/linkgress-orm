import { describe, test, expect, beforeEach } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// A data-warehouse shape: a season table and a per-user statistic that references it,
// both living in a schema another team owns.
const SCHEMA = 'ext_mgd_test';

class ExtSeason extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class ExtStatistic extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  seasonId!: DbColumn<number>;
  distance!: DbColumn<number>;
  season?: ExtSeason;
}

const buildModel = (model: DbModelConfig, externallyManaged: boolean) => {
  model.entity(ExtSeason, entity => {
    entity.toTable('ext_season');
    entity.toSchema(SCHEMA);
    if (externallyManaged) entity.isExternallyManaged();

    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ext_season_id_seq' }));
    entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
  });

  model.entity(ExtStatistic, entity => {
    entity.toTable('ext_statistic');
    entity.toSchema(SCHEMA);
    if (externallyManaged) entity.isExternallyManaged();

    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ext_statistic_id_seq' }));
    entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
    entity.property(e => e.seasonId).hasType(integer('season_id')).isRequired();
    entity.property(e => e.distance).hasType(integer('distance'));

    entity.hasOne(e => e.season, () => ExtSeason)
      .withForeignKey(e => e.seasonId)
      .withPrincipalKey(e => e.id);

    entity.hasIndex('ix_ext_statistic_user_id', e => [e.userId]);
    entity.hasCheckConstraint('chk_ext_statistic_distance', '"distance" >= 0');
  });
};

class ExternalDatabase extends DbContext {
  get statistics(): DbEntityTable<ExtStatistic> {
    return this.table(ExtStatistic);
  }

  protected override setupModel(model: DbModelConfig): void {
    buildModel(model, true);
  }
}

class OwnedDatabase extends DbContext {
  get statistics(): DbEntityTable<ExtStatistic> {
    return this.table(ExtStatistic);
  }

  protected override setupModel(model: DbModelConfig): void {
    buildModel(model, false);
  }
}

// The owner's DDL, which drifted from the model in every way the schema manager compares:
// a bigint id, a column the model does not have and one it lacks (`distance`), a nullable
// `user_id`, no index, no CHECK and no foreign key.
const createOwnersTables = async (client: any) => {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`CREATE TABLE ${SCHEMA}.ext_season (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)`);
  await client.query(`CREATE TABLE ${SCHEMA}.ext_statistic (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint,
    season_id bigint NOT NULL,
    elevation integer
  )`);
};

// Everything the schema manager could have changed on the owner's tables.
const snapshotOwnersTables = async (client: any) => {
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema = $1
    ORDER BY table_name, column_name`, [SCHEMA]);
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`, [SCHEMA]);
  const constraints = await client.query(`
    SELECT conname, contype FROM pg_constraint
    WHERE connamespace = $1::regnamespace ORDER BY conname`, [SCHEMA]);
  return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
};

describe('isExternallyManaged() — tables owned outside the model', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('analyze() plans nothing for existing external tables, however far they drifted', async () => {
    const client = createFreshClient();
    const db = new ExternalDatabase(client);

    try {
      await createOwnersTables(client);

      const operations = await db.getSchemaManager().analyze();
      const touching = operations.filter(op => (op as any).schema === SCHEMA || op.type === 'create_table' || op.type === 'create_schema');
      expect(touching).toEqual([]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await db.dispose();
    }
  });

  test('without the flag the same drift IS planned (the control)', async () => {
    const client = createFreshClient();
    const db = new OwnedDatabase(client);

    try {
      await createOwnersTables(client);

      const operations = await db.getSchemaManager().analyze();
      const types = new Set(operations.filter(op => (op as any).schema === SCHEMA).map(op => op.type));
      expect(types.has('add_column')).toBe(true);
      expect(types.has('alter_column')).toBe(true);
      expect(types.has('create_index')).toBe(true);
      expect(types.has('create_check_constraint')).toBe(true);
      expect(types.has('create_foreign_key')).toBe(true);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await db.dispose();
    }
  });

  test('migrate() and ensureCreated() leave existing external tables exactly as their owner made them', async () => {
    const client = createFreshClient();
    const db = new ExternalDatabase(client);

    try {
      await createOwnersTables(client);
      const before = await snapshotOwnersTables(client);

      await db.getSchemaManager().migrate();
      expect(await snapshotOwnersTables(client)).toEqual(before);

      await db.getSchemaManager().ensureCreated();
      expect(await snapshotOwnersTables(client)).toEqual(before);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await db.dispose();
    }
  });

  test('a MISSING external table is still created from the model, with its index, CHECK and foreign key', async () => {
    const client = createFreshClient();
    const db = new ExternalDatabase(client);

    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);

      await db.getSchemaManager().migrate();

      const { columns, indexes, constraints } = await snapshotOwnersTables(client);
      expect(columns.filter((c: any) => c.table_name === 'ext_statistic').map((c: any) => c.column_name))
        .toEqual(['distance', 'id', 'season_id', 'user_id']);
      expect(indexes.map((i: any) => i.indexname)).toContain('ix_ext_statistic_user_id');
      expect(constraints.map((c: any) => c.conname)).toContain('chk_ext_statistic_distance');
      expect(constraints.some((c: any) => c.contype === 'f')).toBe(true);

      // …and once it exists, it is the owner's: nothing further is planned.
      const operations = await db.getSchemaManager().analyze();
      expect(operations.filter(op => (op as any).schema === SCHEMA || op.type === 'create_table')).toEqual([]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await db.dispose();
    }
  });
});
