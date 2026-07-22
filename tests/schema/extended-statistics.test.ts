import { describe, test, expect, beforeEach } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, smallint, boolean as pgBoolean } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { buildCreateStatisticsStatement, buildDropStatisticsStatement } from '../../src/migration/statistics-sql';

// Test entity — a smallint bitmask column plus two correlated columns, the two
// real-world shapes of extended statistics (expression stats for planner
// selectivity of `(flags & N) = 0`; multivariate stats for column correlation).
class Resort extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  flags!: DbColumn<number>;
  city!: DbColumn<string>;
  zip!: DbColumn<string>;
  active!: DbColumn<boolean>;
}

// Univariate expression statistics via the raw-expression escape hatch.
class ExpressionStatisticsTestDatabase extends DbContext {
  get resorts(): DbEntityTable<Resort> {
    return this.table(Resort);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Resort, entity => {
      entity.toTable('resorts_stx_expr_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'resorts_stx_expr_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.flags).hasType(smallint('flags').default(0));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasStatistics('stx_resorts_expr_flags_test')
        .withExpression('("flags" & 1::smallint)');
    });
  }
}

// Multivariate statistics over plain columns from the selector, with kinds.
class MultivariateStatisticsTestDatabase extends DbContext {
  get resorts(): DbEntityTable<Resort> {
    return this.table(Resort);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Resort, entity => {
      entity.toTable('resorts_stx_multi_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'resorts_stx_multi_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.flags).hasType(smallint('flags').default(0));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasStatistics('stx_resorts_city_zip_test', e => [e.city, e.zip])
        .withKinds('ndistinct', 'dependencies');
    });
  }
}

// Same table WITHOUT the statistics declaration — the "old model" for the
// migrate() reconciliation test.
class MigrateBaselineDatabase extends DbContext {
  get resorts(): DbEntityTable<Resort> {
    return this.table(Resort);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Resort, entity => {
      entity.toTable('resorts_stx_migrate_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'resorts_stx_migrate_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.flags).hasType(smallint('flags').default(0));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));
    });
  }
}

// The "new model" — same table, statistics added.
class MigrateWithStatisticsDatabase extends DbContext {
  get resorts(): DbEntityTable<Resort> {
    return this.table(Resort);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Resort, entity => {
      entity.toTable('resorts_stx_migrate_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'resorts_stx_migrate_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.flags).hasType(smallint('flags').default(0));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasStatistics('stx_resorts_migrate_flags_test')
        .withExpression('("flags" & 1::smallint)');
    });
  }
}

// Invalid: kinds on a single-expression declaration (PostgreSQL rejects it) —
// the schema manager must fail fast with a clear error instead.
class InvalidKindsStatisticsDatabase extends DbContext {
  get resorts(): DbEntityTable<Resort> {
    return this.table(Resort);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Resort, entity => {
      entity.toTable('resorts_stx_invalid_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'resorts_stx_invalid_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.flags).hasType(smallint('flags').default(0));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasStatistics('stx_resorts_invalid_test')
        .withExpression('("flags" & 1::smallint)')
        .withKinds('ndistinct');
    });
  }
}

const getStatisticsRow = async (client: any, tableName: string, statisticsName: string) => {
  const result = await client.query(`
    SELECT s.stxname, s.stxkind::text[] AS kinds
    FROM pg_statistic_ext s
    JOIN pg_class c ON c.oid = s.stxrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = $1
      AND s.stxname = $2
  `, [tableName, statisticsName]);
  return result.rows[0];
};

describe('Extended Statistics Support (CREATE STATISTICS)', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('ensureCreated builds univariate expression statistics from withExpression()', async () => {
    const client = createFreshClient();
    const db = new ExpressionStatisticsTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_expr_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const row = await getStatisticsRow(client, 'resorts_stx_expr_test', 'stx_resorts_expr_flags_test');
      expect(row).toBeDefined();
      // A single-expression declaration stores univariate expression stats ('e').
      expect(row.kinds).toContain('e');
    } finally {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_expr_test CASCADE`);
      await db.dispose();
    }
  });

  test('ensureCreated builds multivariate statistics with explicit kinds from selector columns', async () => {
    const client = createFreshClient();
    const db = new MultivariateStatisticsTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_multi_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const row = await getStatisticsRow(client, 'resorts_stx_multi_test', 'stx_resorts_city_zip_test');
      expect(row).toBeDefined();
      expect(row.kinds).toContain('d'); // ndistinct
      expect(row.kinds).toContain('f'); // dependencies
      expect(row.kinds).not.toContain('m'); // mcv not requested
    } finally {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_multi_test CASCADE`);
      await db.dispose();
    }
  });

  test('migrate() creates a statistics object missing on an existing table, then reports in-sync', async () => {
    const clientV1 = createFreshClient();
    const v1 = new MigrateBaselineDatabase(clientV1);

    try {
      await clientV1.query(`DROP TABLE IF EXISTS resorts_stx_migrate_test CASCADE`);
      await v1.getSchemaManager().ensureCreated();

      // Model v2 declares the statistics on the already-existing table.
      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      const v2 = new MigrateWithStatisticsDatabase(clientV2);

      try {
        const plannedOps = await v2.getSchemaManager().analyze();
        const statsOps = plannedOps.filter(op => op.type === 'create_statistics');
        expect(statsOps).toHaveLength(1);
        expect((statsOps[0] as any).statisticsName).toBe('stx_resorts_migrate_flags_test');

        await v2.getSchemaManager().migrate();

        const row = await getStatisticsRow(clientV2, 'resorts_stx_migrate_test', 'stx_resorts_migrate_flags_test');
        expect(row).toBeDefined();
        expect(row.kinds).toContain('e');

        // Reconciliation is by name — a second analyze must not re-plan it.
        const opsAfter = await v2.getSchemaManager().analyze();
        expect(opsAfter.filter(op => op.type === 'create_statistics')).toHaveLength(0);
      } finally {
        await v2.dispose();
      }
    } finally {
      await clientV1.query(`DROP TABLE IF EXISTS resorts_stx_migrate_test CASCADE`);
      await v1.dispose();
    }
  });

  test('kinds on a single-expression declaration fails fast with a clear error', async () => {
    const client = createFreshClient();
    const db = new InvalidKindsStatisticsDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_invalid_test CASCADE`);
      await expectToReject(db.getSchemaManager().ensureCreated());
    } finally {
      await client.query(`DROP TABLE IF EXISTS resorts_stx_invalid_test CASCADE`);
      await db.dispose();
    }
  });

  test('hasStatistics captures metadata: quoted selector columns, appended expressions, kinds', () => {
    const model = new DbModelConfig();
    model.entity(Resort, entity => {
      entity.toTable('stx_metadata_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 200));
      entity.property(e => e.flags).hasType(smallint('flags'));
      entity.property(e => e.city).hasType(varchar('city', 100));
      entity.property(e => e.zip).hasType(varchar('zip', 20));
      entity.property(e => e.active).hasType(pgBoolean('active'));

      entity.hasStatistics('stx_meta', e => [e.city, e.zip])
        .withExpression('("flags" & 1::smallint)')
        .withKinds('mcv');
    });

    const metadata = EntityMetadataStore.getMetadata(Resort)!;
    const stx = (metadata.statistics || []).find(s => s.name === 'stx_meta')!;

    expect(stx.expressions).toEqual(['"city"', '"zip"', '("flags" & 1::smallint)']);
    expect(stx.kinds).toEqual(['mcv']);
  });

  test('statistics-sql builders emit canonical statements', () => {
    expect(buildCreateStatisticsStatement(
      { name: 'stx_x', expressions: ['("flags" & 1::smallint)'] },
      '"public"."resort"',
      { ifNotExists: true }
    )).toBe('CREATE STATISTICS IF NOT EXISTS "stx_x" ON ("flags" & 1::smallint) FROM "public"."resort"');

    expect(buildCreateStatisticsStatement(
      { name: 'stx_y', expressions: ['"city"', '"zip"'], kinds: ['ndistinct', 'dependencies'] },
      '"resort"'
    )).toBe('CREATE STATISTICS "stx_y" (ndistinct, dependencies) ON "city", "zip" FROM "resort"');

    expect(buildDropStatisticsStatement('"stx_x"', { ifExists: true })).toBe('DROP STATISTICS IF EXISTS "stx_x"');
  });
});
