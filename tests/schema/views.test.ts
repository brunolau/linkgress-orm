import { describe, test, expect, beforeEach } from 'bun:test';
import * as os from 'os';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbViewTable, DbModelConfig, DbEntity, DbColumn, MigrationScaffold, integer, varchar, doublePrecision, eq } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { buildCreateViewStatements, normalizeViewDefinition, viewMarker } from '../../src/migration/view-sql';

// Neutral fixture: an orders table and a summary VIEW over it.
class ViewTestOrder extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  amount!: DbColumn<number>;
}

class ViewTestOrderSummary extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  amountEur!: DbColumn<number>;
}

const ORDERS_TABLE = 'orders_view_test';
const SUMMARY_VIEW = 'orders_view_test_summary';
const SUMMARY_V1 = `SELECT o."id", o."label", o."amount" / 100 AS "amount_eur" FROM "${ORDERS_TABLE}" o`;

const configureOrders = (model: DbModelConfig, amountType: 'integer' | 'double' = 'integer'): void => {
  model.entity(ViewTestOrder, (entity) => {
    entity.toTable(ORDERS_TABLE);
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'orders_view_test_id_seq' }));
    entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
    entity.property(e => e.amount).hasType(amountType === 'integer' ? integer('amount') : doublePrecision('amount')).isRequired();
  });
};

const configureSummary = (model: DbModelConfig, definition: string): void => {
  model.view(ViewTestOrderSummary, (view) => {
    view.toView(SUMMARY_VIEW);
    view.definedAs(definition);
    view.property(e => e.id).hasType(integer('id'));
    view.property(e => e.label).hasType(varchar('label', 50));
    view.property(e => e.amountEur).hasType(integer('amount_eur'));
  });
};

class ViewTestDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    configureSummary(model, SUMMARY_V1);
  }
}

describe('model-managed views — metadata', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('model.view() registers a TableSchema flagged as a view, with no foreign keys', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      const registry = db.orders._getSchemaRegistry();

      expect(registry.get(SUMMARY_VIEW)?.view?.definition).toBe(SUMMARY_V1);
      expect(registry.get(SUMMARY_VIEW)?.foreignKeys).toEqual([]);
      expect(registry.get(ORDERS_TABLE)?.view).toBeUndefined();
    } finally {
      await db.dispose();
    }
  });

  test('model.view() without definedAs() is rejected when the model is built', async () => {
    class NoDefinitionDatabase extends DbContext {
      protected override setupModel(model: DbModelConfig): void {
        model.view(ViewTestOrderSummary, (view) => {
          view.toView('orders_view_test_nodef');
          view.property(e => e.id).hasType(integer('id'));
        });
      }
    }

    const client = createFreshClient();

    try {
      expect(() => new NoDefinitionDatabase(client)).toThrow(/definedAs/);
    } finally {
      await client.end();
    }
  });
});

const SUMMARY_V2 = `${SUMMARY_V1} WHERE o."amount" >= 0`;

class SummaryV2Database extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    configureSummary(model, SUMMARY_V2);
  }
}

class DoubleAmountDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model, 'double');
    configureSummary(model, SUMMARY_V1);
  }
}

class ReportingSchemaDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    model.view(ViewTestOrderSummary, (view) => {
      view.toView(SUMMARY_VIEW);
      view.toSchema('views_test_reporting');
      view.definedAs(SUMMARY_V1);
      view.property(e => e.id).hasType(integer('id'));
      view.property(e => e.label).hasType(varchar('label', 50));
      view.property(e => e.amountEur).hasType(integer('amount_eur'));
    });
  }
}

/** The marker comment of a view; `undefined` when the view does not exist. */
const readViewMarker = async (client: any, viewName: string, schemaName = 'public'): Promise<string | null | undefined> => {
  const result = await client.query(`
    SELECT obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v' AND n.nspname = $1 AND c.relname = $2
  `, [schemaName, viewName]);
  return result.rows.length === 0 ? undefined : result.rows[0].marker;
};

// A second view that READS the summary view — a chain the manager has to take apart in order.
class ViewTestOrderIds extends DbEntity {
  id!: DbColumn<number>;
}

const IDS_VIEW = 'orders_view_test_ids';
const IDS_DEFINITION = `SELECT s."id" FROM "${SUMMARY_VIEW}" s`;

const configureIds = (model: DbModelConfig): void => {
  model.view(ViewTestOrderIds, (view) => {
    view.toView(IDS_VIEW);
    view.definedAs(IDS_DEFINITION);
    view.property(e => e.id).hasType(integer('id'));
  });
};

class ChainedV1Database extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    configureSummary(model, SUMMARY_V1);
    configureIds(model);
  }
}

class ChainedV2Database extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    configureSummary(model, SUMMARY_V2);
    configureIds(model);
  }
}

const dropFixtures = async (client: any): Promise<void> => {
  await client.query(`DROP SCHEMA IF EXISTS views_test_reporting CASCADE`);
  await client.query(`DROP VIEW IF EXISTS "${IDS_VIEW}" CASCADE`);
  await client.query(`DROP VIEW IF EXISTS "${SUMMARY_VIEW}" CASCADE`);
  await client.query(`DROP TABLE IF EXISTS "${ORDERS_TABLE}" CASCADE`);
};

const viewOps = (ops: Array<{ type: string }>): string[] => ops.map(op => op.type).filter(type => type === 'drop_view' || type === 'create_view' || type === 'alter_column');

describe('model-managed views — schema manager', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('ensureCreated creates the view after its table, stamps the marker, and stays idempotent', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();

      expect(await readViewMarker(client, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V1));
      await client.query(`INSERT INTO "${ORDERS_TABLE}" (label, amount) VALUES ('a', 1500)`);
      const rows = await client.query(`SELECT label, amount_eur FROM "${SUMMARY_VIEW}"`);
      expect(rows.rows).toEqual([{ label: 'a', amount_eur: 15 }]);

      await db.getSchemaManager().ensureCreated();
      expect(await readViewMarker(client, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V1));
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('analyze() never plans the view as a table and is quiet when the view is in sync', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      const ops = await db.getSchemaManager().analyze();

      expect(ops.some(op => op.type === 'create_table' && op.tableName === SUMMARY_VIEW)).toBe(false);
      expect(viewOps(ops)).toEqual([]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('migrate() recreates a view that was dropped by hand, even when every table is in sync', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      await client.query(`DROP VIEW "${SUMMARY_VIEW}"`);

      expect((await db.getSchemaManager().analyze()).map(op => op.type)).toEqual(['create_view']);
      await db.getSchemaManager().migrate();
      expect(await readViewMarker(client, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V1));
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('a changed definition is dropped and re-created with the new marker', async () => {
    const clientV1 = createFreshClient();
    const v1 = new ViewTestDatabase(clientV1);
    const clientV2 = createFreshClient();

    try {
      await dropFixtures(clientV1);
      await v1.getSchemaManager().ensureCreated();
      (EntityMetadataStore as any).metadata.clear();
      const v2 = new SummaryV2Database(clientV2);

      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual(['drop_view', 'create_view']);
      await v2.getSchemaManager().migrate();
      expect(await readViewMarker(clientV2, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V2));
      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(clientV1);
      await v1.dispose();
      await clientV2.end();
    }
  });

  test('a view that reads a changed view is dropped before it and re-created after it', async () => {
    const clientV1 = createFreshClient();
    const v1 = new ChainedV1Database(clientV1);
    const clientV2 = createFreshClient();

    try {
      await dropFixtures(clientV1);
      await v1.getSchemaManager().ensureCreated();
      (EntityMetadataStore as any).metadata.clear();
      const v2 = new ChainedV2Database(clientV2);
      const ops = await v2.getSchemaManager().analyze();

      // Only the summary's SQL changed, but the ids view reads it: PostgreSQL refuses to drop a
      // view another view depends on (2BP01), so the reader goes first and comes back last.
      expect(ops
        .filter(op => op.type === 'drop_view' || op.type === 'create_view')
        .map(op => `${op.type}:${(op as { viewName: string }).viewName}`)).toEqual([
        `drop_view:${IDS_VIEW}`,
        `drop_view:${SUMMARY_VIEW}`,
        `create_view:${SUMMARY_VIEW}`,
        `create_view:${IDS_VIEW}`,
      ]);
      await v2.getSchemaManager().migrate();
      expect(await readViewMarker(clientV2, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V2));
      expect(await readViewMarker(clientV2, IDS_VIEW)).toBe(viewMarker(IDS_DEFINITION));
      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(clientV1);
      await v1.dispose();
      await clientV2.end();
    }
  });

  test('a column type change under the view drops it before the ALTER and re-creates it after', async () => {
    const clientV1 = createFreshClient();
    const v1 = new ViewTestDatabase(clientV1);
    const clientV2 = createFreshClient();

    try {
      await dropFixtures(clientV1);
      await v1.getSchemaManager().ensureCreated();
      await clientV1.query(`INSERT INTO "${ORDERS_TABLE}" (label, amount) VALUES ('a', 1500)`);
      (EntityMetadataStore as any).metadata.clear();
      const v2 = new DoubleAmountDatabase(clientV2);

      // Drops come FIRST (so a file scaffold runs them before the ALTER), creates LAST.
      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual(['drop_view', 'alter_column', 'create_view']);
      // PostgreSQL refuses ALTER COLUMN … TYPE under a dependent view (0A000) — this migrate
      // only succeeds because the view is out of the way.
      await v2.getSchemaManager().migrate();

      const rows = await clientV2.query(`SELECT label, amount_eur FROM "${SUMMARY_VIEW}"`);
      expect(rows.rows).toEqual([{ label: 'a', amount_eur: 15 }]);
      const type = await clientV2.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'amount'`, [ORDERS_TABLE]);
      expect(type.rows[0].data_type).toBe('double precision');
    } finally {
      await dropFixtures(clientV1);
      await v1.dispose();
      await clientV2.end();
    }
  });

  test('a view in its own schema creates that schema', async () => {
    const client = createFreshClient();
    const db = new ReportingSchemaDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();

      expect(await readViewMarker(client, SUMMARY_VIEW, 'views_test_reporting')).toBe(viewMarker(SUMMARY_V1));
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('ensureDeleted drops the view before the tables', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      await db.getSchemaManager().ensureDeleted();

      expect(await readViewMarker(client, SUMMARY_VIEW)).toBeUndefined();
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('a scaffolded create_view also runs on a database that already has the view', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      const scaffold = new MigrationScaffold(db, { migrationsDirectory: os.tmpdir() });
      const up: string[] = (scaffold as any).generateUpSql({ type: 'create_view', viewName: SUMMARY_VIEW, definition: SUMMARY_V1 });

      // A scaffolded file can run where the model's own migrate() already created the view (journal
      // first, auto-sync second, or the other order on another environment) — it must not fail there.
      for (const statement of up) {
        await client.query(statement);
      }
      expect(await readViewMarker(client, SUMMARY_VIEW)).toBe(viewMarker(SUMMARY_V1));
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('a trailing semicolon or whitespace neither breaks CREATE VIEW nor changes the marker', () => {
    const sloppy = `  ${SUMMARY_V1};\n  `;

    expect(normalizeViewDefinition(sloppy)).toBe(SUMMARY_V1);
    expect(viewMarker(sloppy)).toBe(viewMarker(SUMMARY_V1));
    expect(buildCreateViewStatements({ name: SUMMARY_VIEW, definition: sloppy })).toEqual([
      `CREATE VIEW "${SUMMARY_VIEW}" AS ${SUMMARY_V1}`,
      `COMMENT ON VIEW "${SUMMARY_VIEW}" IS '${viewMarker(SUMMARY_V1)}'`,
    ]);
  });
});

// The same orders table without any view — what every model that never declares one looks like.
class TablesOnlyDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
  }
}

class TablesOnlyDoubleAmountDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model, 'double');
  }
}

/** Records every statement sent through the client (the schema manager only ever calls `query`). */
const recordStatements = (client: any): string[] => {
  const statements: string[] = [];
  const query = client.query.bind(client);
  client.query = (text: string, ...rest: any[]) => {
    statements.push(text);
    return query(text, ...rest);
  };
  return statements;
};

const VIEW_SQL = /\bVIEW\b|relkind\s*=\s*'v'|obj_description/i;

describe('model-managed views — a model without views is untouched', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('a table\'s schema entry carries no view key at all', async () => {
    const client = createFreshClient();
    const db = new ViewTestDatabase(client);

    try {
      const registry = db.orders._getSchemaRegistry();

      expect(Object.prototype.hasOwnProperty.call(registry.get(ORDERS_TABLE), 'view')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(registry.get(SUMMARY_VIEW), 'view')).toBe(true);
    } finally {
      await db.dispose();
    }
  });

  test('its schema manager gets the registry\'s tables as they are and sends no view SQL through the whole lifecycle', async () => {
    const client = createFreshClient();
    const db = new TablesOnlyDatabase(client);

    try {
      await dropFixtures(client);
      const statements = recordStatements(client);
      const manager = db.getSchemaManager();
      const registry = db.orders._getSchemaRegistry();

      // Same entries, same order, the very same schema objects — nothing copied or rebuilt.
      expect([...(manager as any).schemaRegistry.entries()]).toEqual([...registry.entries()]);
      expect([...(manager as any).schemaRegistry.values()].every((schema: any, i: number) => schema === [...registry.values()][i])).toBe(true);

      await manager.ensureCreated();
      expect(await manager.analyze()).toEqual([]);
      await manager.migrate();
      await manager.ensureDeleted();

      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter(statement => VIEW_SQL.test(statement))).toEqual([]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('declaring a view changes nothing in the table part of a migration plan', async () => {
    const clientV1 = createFreshClient();
    const v1 = new TablesOnlyDatabase(clientV1);
    const clientWith = createFreshClient();
    const clientWithout = createFreshClient();

    try {
      await dropFixtures(clientV1);
      await v1.getSchemaManager().ensureCreated();
      (EntityMetadataStore as any).metadata.clear();
      const withView = new DoubleAmountDatabase(clientWith);
      const planWithView = await withView.getSchemaManager().analyze();
      (EntityMetadataStore as any).metadata.clear();
      const withoutView = new TablesOnlyDoubleAmountDatabase(clientWithout);
      const planWithoutView = await withoutView.getSchemaManager().analyze();

      const tablePartWithView: unknown[] = planWithView.filter(op => op.type !== 'drop_view' && op.type !== 'create_view');

      expect(planWithoutView.length).toBeGreaterThan(0);
      expect(tablePartWithView).toEqual(planWithoutView);
    } finally {
      await dropFixtures(clientV1);
      await v1.dispose();
      await clientWith.end();
      await clientWithout.end();
    }
  });
});

class QueryableViewDatabase extends DbContext {
  get orders(): DbEntityTable<ViewTestOrder> {
    return this.table(ViewTestOrder);
  }

  get summaries(): DbViewTable<ViewTestOrderSummary> {
    return this.view(ViewTestOrderSummary);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureOrders(model);
    configureSummary(model, SUMMARY_V1);
  }
}

describe('model-managed views — read-only query surface', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('a view is queried like a table and refuses update() / delete()', async () => {
    const client = createFreshClient();
    const db = new QueryableViewDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      await client.query(`INSERT INTO "${ORDERS_TABLE}" (label, amount) VALUES ('a', 1500), ('b', 700)`);

      const rows = await db.summaries
        .where(s => eq(s.label, 'a'))
        .select(s => ({ label: s.label, amountEur: s.amountEur }))
        .toList();

      expect(rows).toEqual([{ label: 'a', amountEur: 15 }]);
      // A single-table view is auto-updatable in PostgreSQL — the guard must stop it first.
      expect(() => db.summaries.where(s => eq(s.label, 'a')).delete()).toThrow(/model-managed view/);
      expect(() => db.summaries.where(s => eq(s.label, 'a')).update({ label: 'z' } as never)).toThrow(/model-managed view/);
      // @ts-expect-error — DbViewTable exposes no insert()
      void db.summaries.insert;

      const untouched = await client.query(`SELECT count(*)::int AS n FROM "${ORDERS_TABLE}"`);
      expect(untouched.rows[0].n).toBe(2);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('view() refuses a class that was declared as a table', async () => {
    class MisusedDatabase extends DbContext {
      get wrong(): DbViewTable<ViewTestOrder> {
        return this.view(ViewTestOrder);
      }

      protected override setupModel(model: DbModelConfig): void {
        configureOrders(model);
      }
    }

    const client = createFreshClient();
    const db = new MisusedDatabase(client);

    try {
      expect(() => db.wrong).toThrow(/is not a view/);
    } finally {
      await db.dispose();
    }
  });
});
