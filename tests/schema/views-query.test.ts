import { describe, test, expect, beforeEach } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbViewTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, eq, gt, gte, inArray, and, sql } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { inlineViewParameters, toViewLiteral } from '../../src/migration/view-query-sql';
import { viewMarker } from '../../src/migration/view-sql';

// Neutral fixture: orders with lines, and VIEWS over them defined with the linkgress query builder
// (`view.definedAs(db => query)`) instead of SQL text.
class QvOrder extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  amount!: DbColumn<number>;
  lines!: QvOrderLine[];
}

class QvOrderLine extends DbEntity {
  id!: DbColumn<number>;
  orderId!: DbColumn<number>;
  qty!: DbColumn<number>;
  order?: QvOrder;
}

class QvOrderStats extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  amountEur!: DbColumn<number>;
  lineCount!: DbColumn<number>;
  lineQtys!: DbColumn<number[] | null>;
}

class QvBusyOrder extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class QvOrderTotal extends DbEntity {
  orderId!: DbColumn<number>;
  totalQty!: DbColumn<number>;
}

class QvOrderLineRow extends DbEntity {
  orderId!: DbColumn<number>;
  orderLabel!: DbColumn<string>;
  lineQty!: DbColumn<number | null>;
  lineOrderLabel!: DbColumn<string | null>;
  lineSiblingCount!: DbColumn<number>;
  orderQtysDesc!: DbColumn<number[] | null>;
}

const ORDERS = 'qv_orders';
const LINES = 'qv_order_lines';
const STATS = 'qv_order_stats';
const BUSY = 'qv_busy_orders';
const TOTALS = 'qv_order_totals';
const LINE_ROWS = 'qv_order_line_rows';

const configureTables = (model: DbModelConfig): void => {
  model.entity(QvOrder, (entity) => {
    entity.toTable(ORDERS);
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'qv_orders_id_seq' }));
    entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
    entity.property(e => e.amount).hasType(integer('amount')).isRequired();
    entity.hasMany(e => e.lines as any, () => QvOrderLine)
      .withForeignKey(l => l.orderId)
      .withPrincipalKey(o => o.id);
  });

  model.entity(QvOrderLine, (entity) => {
    entity.toTable(LINES);
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'qv_order_lines_id_seq' }));
    entity.property(e => e.orderId).hasType(integer('order_id')).isRequired();
    entity.property(e => e.qty).hasType(integer('qty')).isRequired();
    entity.hasOne(e => e.order, () => QvOrder)
      .withForeignKey(l => l.orderId)
      .withPrincipalKey(o => o.id);
  });
};

/** The stats view: filtered orders with a computed column, a count and a list over their lines. */
const configureStats = (model: DbModelConfig, minAmount: number, label?: string): void => {
  model.view(QvOrderStats, (view) => {
    view.toView(STATS);
    view.definedAs((db: QueryViewDatabase) => db.orders
      .where(o => (label == null ? gte(o.amount, minAmount) : and(eq(o.label, label), inArray(o.amount, [700, 1500]))))
      .select(o => ({
        id: o.id,
        label: o.label,
        amountEur: sql<number>`${o.amount} / 100`,
        lineCount: o.lines.count(),
        lineQtys: o.lines.select(l => ({ qty: l.qty })).toNumberList(),
      })));
    view.property(e => e.id).hasType(integer('id'));
    view.property(e => e.label).hasType(varchar('label', 50));
    view.property(e => e.amountEur).hasType(integer('amount_eur'));
    view.property(e => e.lineCount).hasType(integer('line_count'));
    view.property(e => e.lineQtys).hasType(integer('line_qtys').array());
  });
};

class QueryViewDatabase extends DbContext {
  get orders(): DbEntityTable<QvOrder> {
    return this.table(QvOrder);
  }

  get lines(): DbEntityTable<QvOrderLine> {
    return this.table(QvOrderLine);
  }

  get stats(): DbViewTable<QvOrderStats> {
    return this.view(QvOrderStats);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 0);
  }
}

class QueryViewV2Database extends QueryViewDatabase {
  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 1000);
  }
}

/** A query-defined view that reads ANOTHER view (the stats view) through its read-only table. */
class ChainedQueryViewDatabase extends QueryViewDatabase {
  get busy(): DbViewTable<QvBusyOrder> {
    return this.view(QvBusyOrder);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 0);
    model.view(QvBusyOrder, (view) => {
      view.toView(BUSY);
      view.definedAs((db: ChainedQueryViewDatabase) => db.stats
        .where(s => gt(s.lineCount, 1))
        .select(s => ({ id: s.id, label: s.label })));
      view.property(e => e.id).hasType(integer('id'));
      view.property(e => e.label).hasType(varchar('label', 50));
    });
  }
}

/** A grouped (aggregate) query as a view. */
class GroupedQueryViewDatabase extends QueryViewDatabase {
  get totals(): DbViewTable<QvOrderTotal> {
    return this.view(QvOrderTotal);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 0);
    model.view(QvOrderTotal, (view) => {
      view.toView(TOTALS);
      view.definedAs((db: GroupedQueryViewDatabase) => db.lines
        .select(l => ({ orderId: l.orderId, qty: l.qty }))
        .groupBy(l => ({ orderId: l.orderId }))
        .select(g => ({ orderId: g.key.orderId, totalQty: g.sum(l => l.qty) })));
      view.property(e => e.orderId).hasType(integer('order_id'));
      view.property(e => e.totalQty).hasType(integer('total_qty'));
    });
  }
}

/**
 * A view over an explicit LEFT JOIN, the way a hand-written view joins: a navigation of the JOINED
 * table (`line.order`), a count through that navigation, and an ordered list — every piece a
 * builder call, none of it SQL text.
 */
class JoinedQueryViewDatabase extends QueryViewDatabase {
  get lineRows(): DbViewTable<QvOrderLineRow> {
    return this.view(QvOrderLineRow);
  }

  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 0);
    model.view(QvOrderLineRow, (view) => {
      view.toView(LINE_ROWS);
      view.definedAs((db: JoinedQueryViewDatabase) => db.orders
        .leftJoin(db.lines, (order, line) => eq(line.orderId, order.id), (order, line) => ({
          orderId: order.id,
          orderLabel: order.label,
          lineQty: line.qty,
          lineOrderLabel: line.order!.label,
          lineSiblingCount: line.order!.lines.count(),
          orderQtysDesc: order.lines.orderBy(l => [[l.qty, 'DESC']]).select(l => ({ qty: l.qty })).toNumberList(),
        })));
      view.property(e => e.orderId).hasType(integer('order_id'));
      view.property(e => e.orderLabel).hasType(varchar('order_label', 50));
      view.property(e => e.lineQty).hasType(integer('line_qty'));
      view.property(e => e.lineOrderLabel).hasType(varchar('line_order_label', 50));
      view.property(e => e.lineSiblingCount).hasType(integer('line_sibling_count'));
      view.property(e => e.orderQtysDesc).hasType(integer('order_qtys_desc').array());
    });
  }
}

const TRICKY = `O'Brien \\ $1 -- /* "x" */`;

class TrickyLiteralDatabase extends QueryViewDatabase {
  protected override setupModel(model: DbModelConfig): void {
    configureTables(model);
    configureStats(model, 0, TRICKY);
  }
}

const dropFixtures = async (client: any): Promise<void> => {
  await client.query(`DROP VIEW IF EXISTS "${LINE_ROWS}" CASCADE`);
  await client.query(`DROP VIEW IF EXISTS "${BUSY}" CASCADE`);
  await client.query(`DROP VIEW IF EXISTS "${TOTALS}" CASCADE`);
  await client.query(`DROP VIEW IF EXISTS "${STATS}" CASCADE`);
  await client.query(`DROP TABLE IF EXISTS "${LINES}" CASCADE`);
  await client.query(`DROP TABLE IF EXISTS "${ORDERS}" CASCADE`);
};

/** Orders a (1500, two lines), b (700, no lines), c (-100, one line). */
const seed = async (client: any): Promise<Record<'a' | 'b' | 'c', number>> => {
  const orders = await client.query(`INSERT INTO "${ORDERS}" (label, amount) VALUES ('a', 1500), ('b', 700), ('c', -100) RETURNING id, label`);
  const ids = Object.fromEntries(orders.rows.map((row: any) => [row.label, row.id])) as Record<'a' | 'b' | 'c', number>;

  await client.query(`INSERT INTO "${LINES}" (order_id, qty) VALUES ($1, 2), ($1, 3), ($2, 5)`, [ids.a, ids.c]);
  return ids;
};

const viewColumns = async (client: any, viewName: string): Promise<string[]> => {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [viewName],
  );
  return result.rows.map((row: any) => row.column_name);
};

const viewOps = (ops: Array<{ type: string }>): string[] => ops.map(op => op.type).filter(type => type === 'drop_view' || type === 'create_view');

describe('model-managed views — defined with a linkgress query', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('the query is rendered into the view: declared column names in declared order, rows as the query selects them', async () => {
    const client = createFreshClient();
    const db = new QueryViewDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      const ids = await seed(client);

      expect(await viewColumns(client, STATS)).toEqual(['id', 'label', 'amount_eur', 'line_count', 'line_qtys']);

      const rows = await db.stats
        .orderBy(s => s.id)
        .select(s => ({ id: s.id, label: s.label, amountEur: s.amountEur, lineCount: s.lineCount, lineQtys: s.lineQtys }))
        .toList();

      expect(rows.map(r => ({ ...r, lineCount: Number(r.lineCount), lineQtys: [...(r.lineQtys ?? [])].sort() }))).toEqual([
        { id: ids.a, label: 'a', amountEur: 15, lineCount: 2, lineQtys: [2, 3] },
        { id: ids.b, label: 'b', amountEur: 7, lineCount: 0, lineQtys: [] },
      ]);
      // Rendering is deterministic: the stored marker matches a fresh render, so nothing is planned.
      expect(viewOps(await db.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('the marker follows the query: a changed constant drops and re-creates the view', async () => {
    const clientV1 = createFreshClient();
    const v1 = new QueryViewDatabase(clientV1);
    const clientV2 = createFreshClient();

    try {
      await dropFixtures(clientV1);
      await v1.getSchemaManager().ensureCreated();
      await seed(clientV1);
      (EntityMetadataStore as any).metadata.clear();
      const v2 = new QueryViewV2Database(clientV2);

      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual(['drop_view', 'create_view']);
      await v2.getSchemaManager().migrate();
      expect((await v2.stats.select(s => ({ label: s.label })).toList()).map(r => r.label)).toEqual(['a']);
      expect(viewOps(await v2.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(clientV1);
      await v1.dispose();
      await clientV2.end();
    }
  });

  test('a query-defined view can read another view through its read-only table', async () => {
    const client = createFreshClient();
    const db = new ChainedQueryViewDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      await seed(client);

      expect((await db.busy.select(b => ({ label: b.label })).toList()).map(r => r.label)).toEqual(['a']);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('a grouped query works as a view', async () => {
    const client = createFreshClient();
    const db = new GroupedQueryViewDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      const ids = await seed(client);
      const totals = await db.totals.orderBy(t => t.orderId).select(t => ({ orderId: t.orderId, totalQty: t.totalQty })).toList();

      expect(totals.map(t => ({ orderId: t.orderId, totalQty: Number(t.totalQty) }))).toEqual([
        { orderId: ids.a, totalQty: 5 },
        { orderId: ids.c, totalQty: 5 },
      ]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('a view over an explicit join: navigations and collections of the joined table, ordered lists', async () => {
    const client = createFreshClient();
    const db = new JoinedQueryViewDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      const ids = await seed(client);
      const rows = await db.lineRows
        .select(r => ({
          orderId: r.orderId,
          orderLabel: r.orderLabel,
          lineQty: r.lineQty,
          lineOrderLabel: r.lineOrderLabel,
          lineSiblingCount: r.lineSiblingCount,
          orderQtysDesc: r.orderQtysDesc,
        }))
        .toList();
      const sorted = rows
        .map(r => ({ ...r, lineSiblingCount: Number(r.lineSiblingCount) }))
        .sort((x, y) => x.orderLabel.localeCompare(y.orderLabel) || (x.lineQty ?? 0) - (y.lineQty ?? 0));

      // b has no lines: the LEFT join keeps it, its navigation and count read as NULL / 0
      expect(sorted).toEqual([
        { orderId: ids.a, orderLabel: 'a', lineQty: 2, lineOrderLabel: 'a', lineSiblingCount: 2, orderQtysDesc: [3, 2] },
        { orderId: ids.a, orderLabel: 'a', lineQty: 3, lineOrderLabel: 'a', lineSiblingCount: 2, orderQtysDesc: [3, 2] },
        { orderId: ids.b, orderLabel: 'b', lineQty: null, lineOrderLabel: null, lineSiblingCount: 0, orderQtysDesc: [] },
        { orderId: ids.c, orderLabel: 'c', lineQty: 5, lineOrderLabel: 'c', lineSiblingCount: 1, orderQtysDesc: [5] },
      ]);
      expect(viewOps(await db.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('constants are inlined as literals — a value with quotes, a backslash, "$1" and comment markers cannot break out', async () => {
    const client = createFreshClient();
    const db = new TrickyLiteralDatabase(client);

    try {
      await dropFixtures(client);
      await db.getSchemaManager().ensureCreated();
      await client.query(`INSERT INTO "${ORDERS}" (label, amount) VALUES ($1, 1500), ($1, 999), ('plain', 1500)`, [TRICKY]);

      const rows = await db.stats.select(s => ({ label: s.label, amountEur: s.amountEur })).toList();

      expect(rows).toEqual([{ label: TRICKY, amountEur: 15 }]);
      expect(viewOps(await db.getSchemaManager().analyze())).toEqual([]);
    } finally {
      await dropFixtures(client);
      await db.dispose();
    }
  });

  test('the SQL does not depend on the client: JSON-aggregating and native-array clients render the same view', async () => {
    const native = createFreshClient();
    const jsonAggregating = createFreshClient();

    try {
      (jsonAggregating as any).supportsBinaryArrayResults = () => false;
      const nativeDb = new QueryViewDatabase(native);
      (EntityMetadataStore as any).metadata.clear();
      const jsonDb = new QueryViewDatabase(jsonAggregating);
      const nativeViews = (nativeDb.getSchemaManager() as any).views;
      const jsonViews = (jsonDb.getSchemaManager() as any).views;

      expect(jsonViews.map((v: any) => viewMarker(v.definition))).toEqual(nativeViews.map((v: any) => viewMarker(v.definition)));
      expect(nativeViews[0].definition).not.toMatch(/json_agg|jsonb_agg/i);
    } finally {
      await native.end();
      await jsonAggregating.end();
    }
  });
});

describe('model-managed views — a query that does not fit the view is refused by name', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  const databaseWith = (define: (view: any) => void): QueryViewDatabase => {
    class Probe extends QueryViewDatabase {
      protected override setupModel(model: DbModelConfig): void {
        configureTables(model);
        model.view(QvBusyOrder, (view) => {
          view.toView(BUSY);
          define(view);
          view.property(e => e.id).hasType(integer('id'));
          view.property(e => e.label).hasType(varchar('label', 50));
        });
      }
    }

    return new Probe(createFreshClient());
  };

  test('a view property the query does not project', async () => {
    const db = databaseWith(view => view.definedAs((d: QueryViewDatabase) => d.orders.select(o => ({ id: o.id }))));

    try {
      expect(() => db.getSchemaManager()).toThrow(/qv_busy_orders.*label/);
    } finally {
      await db.dispose();
    }
  });

  test('a projected key the view does not declare', async () => {
    const db = databaseWith(view => view.definedAs((d: QueryViewDatabase) => d.orders.select(o => ({ id: o.id, label: o.label, amount: o.amount }))));

    try {
      expect(() => db.getSchemaManager()).toThrow(/qv_busy_orders.*amount/);
    } finally {
      await db.dispose();
    }
  });

  test('a nested object in the projection', async () => {
    const db = databaseWith(view => view.definedAs((d: QueryViewDatabase) => d.orders.select(o => ({ id: o.id, label: { text: o.label } }))));

    try {
      expect(() => db.getSchemaManager()).toThrow(/qv_busy_orders.*label.*nested/);
    } finally {
      await db.dispose();
    }
  });

  test('something that is not a linkgress query', async () => {
    const db = databaseWith(view => view.definedAs(() => 'SELECT 1'));

    try {
      expect(() => db.getSchemaManager()).toThrow(/qv_busy_orders.*linkgress query/);
    } finally {
      await db.dispose();
    }
  });

  test('the compiler checks the projection against the view\'s properties', () => {
    const typeOnly = (model: DbModelConfig): void => {
      model.view(QvBusyOrder, (view) => {
        // @ts-expect-error — the projection lacks `label`, which the view declares
        view.definedAs((d: QueryViewDatabase) => d.orders.select(o => ({ id: o.id })));
        view.definedAs((d: QueryViewDatabase) => d.orders.select(o => ({ id: o.id, label: o.label })));
      });
    };

    expect(typeof typeOnly).toBe('function');
  });
});

describe('model-managed views — inlining a query\'s parameters', () => {
  test('every value becomes an escaped, untyped literal — the way a driver would have bound it', () => {
    expect(toViewLiteral(null)).toBe('NULL');
    expect(toViewLiteral(undefined)).toBe('NULL');
    expect(toViewLiteral(`it's`)).toBe(`'it''s'`);
    expect(toViewLiteral('a\\b')).toBe(`E'a\\\\b'`);
    expect(toViewLiteral(42)).toBe(`'42'`);
    expect(toViewLiteral(-1.5)).toBe(`'-1.5'`);
    expect(toViewLiteral(10n)).toBe(`'10'`);
    expect(toViewLiteral(true)).toBe(`'true'`);
    expect(toViewLiteral([1, 2])).toBe(`'{1,2}'`);
    // The array literal escapes `"` with a backslash, so the SQL string holding it becomes an E'' string.
    expect(toViewLiteral(['a"b', `c'd`, null])).toBe(`E'{"a\\\\"b","c''d",NULL}'`);
    expect(toViewLiteral({ a: `x'y` })).toBe(`'{"a":"x''y"}'`);
    expect(toViewLiteral(new Date('2026-01-02T03:04:05.000Z'))).toBe(`'2026-01-02T03:04:05.000Z'`);
    expect(() => toViewLiteral(Symbol('x') as any)).toThrow();
  });

  test('placeholders are replaced only outside quoted text, identifiers, dollar quotes and comments', () => {
    const text = `SELECT $1, '$1', "$1", $tag$ $1 $tag$, $$ $2 $$ -- $1\n, /* $2 */ $2, $10`;
    const params = ['one', 'two', 3, 4, 5, 6, 7, 8, 9, 'ten'];

    expect(inlineViewParameters(text, params)).toBe(`SELECT 'one', '$1', "$1", $tag$ $1 $tag$, $$ $2 $$ -- $1\n, /* $2 */ 'two', 'ten'`);
  });

  test('a placeholder without a value is an error, not a silent NULL', () => {
    expect(() => inlineViewParameters('SELECT $2', ['one'])).toThrow(/\$2/);
  });
});
