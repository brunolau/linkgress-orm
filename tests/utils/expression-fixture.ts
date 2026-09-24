import { createFreshClient } from './test-database';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient,
  serial, integer, bigint, numeric, doublePrecision, varchar, text, boolean, timestamp, timestamptz, jsonb,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * Shared fixture for the SQL expression helper suites (casts, CASE, scalar / string / math /
 * date-time functions, JSONB, array columns): a small library schema with one column per
 * type the helpers have to get right, NULLs in every nullable column, an empty array and a
 * JSON key containing a quote.
 */

export interface ShelfMeta {
  genre?: string;
  dims?: { w: number; h?: number };
  tags?: string[];
  rating?: number;
  [key: string]: unknown;
}

export class ExprLibrary extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  city!: DbColumn<string>;
  timeZone!: DbColumn<string>;
}

export class ExprShelf extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  label?: DbColumn<string | null>;
  qty?: DbColumn<number | null>;
  ratio?: DbColumn<number | null>;
  price?: DbColumn<number | null>;
  tags?: DbColumn<string[] | null>;
  slots?: DbColumn<number[] | null>;
  meta?: DbColumn<ShelfMeta | null>;
  placedAt?: DbColumn<Date | null>;
  placedTz?: DbColumn<Date | null>;
  active?: DbColumn<boolean | null>;
  counter?: DbColumn<string | null>;
  libraryId!: DbColumn<number>;
  library?: ExprLibrary;
}

export class ExpressionTestDatabase extends DbContext {
  get libraries(): DbEntityTable<ExprLibrary> {
    return this.table(ExprLibrary);
  }

  get shelves(): DbEntityTable<ExprShelf> {
    return this.table(ExprShelf);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(ExprLibrary, entity => {
      entity.toTable('expr_libraries');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.city).hasType(varchar('city', 64)).isRequired();
      entity.property(e => e.timeZone).hasType(varchar('time_zone', 64)).isRequired();
    });

    model.entity(ExprShelf, entity => {
      entity.toTable('expr_shelves');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.label).hasType(text('label'));
      entity.property(e => e.qty).hasType(integer('qty'));
      entity.property(e => e.ratio).hasType(doublePrecision('ratio'));
      entity.property(e => e.price).hasType(numeric('price', 10, 2));
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.slots).hasType(integer('slots').array());
      entity.property(e => e.meta).hasType(jsonb('meta'));
      entity.property(e => e.placedAt).hasType(timestamp('placed_at'));
      entity.property(e => e.placedTz).hasType(timestamptz('placed_tz'));
      entity.property(e => e.active).hasType(boolean('active'));
      entity.property(e => e.counter).hasType(bigint('counter'));
      entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();

      entity.hasOne(e => e.library, () => ExprLibrary)
        .withForeignKey(s => s.libraryId)
        .withPrincipalKey(l => l.id);
    });
  }
}

export interface ExpressionFixture {
  db: ExpressionTestDatabase;
  client: DatabaseClient;
  /** Every statement the context logged, in order (logQueries is on). */
  captured: string[];
  /** The last captured statement that starts with the given keyword (default SELECT). */
  lastStatement(keyword?: string): string;
}

/**
 * Build the schema on a fresh client and seed it. Seed (ids are 1-based, in this order):
 *
 * | id | name | label | qty | ratio | price | tags | slots | meta | placed_at (UTC) | active | counter | library |
 * |---|---|---|---|---|---|---|---|---|---|---|---|---|
 * | 1 | Poetry | '  Verse  ' | 12 | 0.25 | 19.99 | {poetry,classic} | {1,2,3} | genre poetry, dims 120×200, tags [a,b], "it's" | 2024-03-10 23:30 | true | 9007199254740993 | Central (Vienna) |
 * | 2 | History | NULL | 0 | 1.5 | 5.00 | {history} | {} | genre history, dims 80×150, tags [], rating 4 | 2024-07-01 08:15 | false | 42 | Harbor (Lisbon) |
 * | 3 | Mystery | '' | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | Central (Vienna) |
 */
export async function createExpressionFixture(): Promise<ExpressionFixture> {
  (EntityMetadataStore as any).metadata.clear();

  const client = createFreshClient();
  const captured: string[] = [];
  const db = new ExpressionTestDatabase(client, {
    logQueries: true,
    logParameters: false,
    logger: (message: string) => {
      captured.push(message);
    },
  });

  await client.query('DROP TABLE IF EXISTS expr_shelves CASCADE');
  await client.query('DROP TABLE IF EXISTS expr_libraries CASCADE');
  await db.getSchemaManager().ensureCreated();

  await db.libraries.insertBulk([
    { name: 'Central', city: 'Vienna', timeZone: 'Europe/Vienna' },
    { name: 'Harbor', city: 'Lisbon', timeZone: 'Europe/Lisbon' },
  ]);

  await db.shelves.insert({
    name: 'Poetry',
    label: '  Verse  ',
    qty: 12,
    ratio: 0.25,
    price: 19.99,
    tags: ['poetry', 'classic'],
    slots: [1, 2, 3],
    meta: { genre: 'poetry', dims: { w: 120, h: 200 }, tags: ['a', 'b'], "it's": 'quoted' },
    // timestamp WITHOUT time zone: bound as text so the stored wall time is exactly this UTC time
    placedAt: '2024-03-10 23:30:00' as any,
    placedTz: new Date('2024-03-10T23:30:00.000Z'),
    active: true,
    counter: '9007199254740993',
    libraryId: 1,
  });

  await db.shelves.insert({
    name: 'History',
    label: null,
    qty: 0,
    ratio: 1.5,
    price: 5,
    tags: ['history'],
    slots: [],
    meta: { genre: 'history', dims: { w: 80, h: 150 }, tags: [], rating: 4 },
    placedAt: '2024-07-01 08:15:00' as any,
    placedTz: new Date('2024-07-01T08:15:00.000Z'),
    active: false,
    counter: '42',
    libraryId: 2,
  });

  await db.shelves.insert({
    name: 'Mystery',
    label: '',
    libraryId: 1,
  });

  captured.length = 0;

  return {
    db,
    client,
    captured,
    lastStatement(keyword = 'SELECT') {
      for (let i = captured.length - 1; i >= 0; i--) {
        if (captured[i].includes(keyword)) {
          return captured[i];
        }
      }
      throw new Error(`No captured statement contains ${keyword}`);
    },
  };
}

export async function disposeExpressionFixture(fixture: ExpressionFixture | undefined): Promise<void> {
  if (!fixture) {
    return;
  }

  await fixture.client.query('DROP TABLE IF EXISTS expr_shelves CASCADE');
  await fixture.client.query('DROP TABLE IF EXISTS expr_libraries CASCADE');
  await fixture.db.dispose();
}

/** A FieldRef as a schema-aware mock row hands it to a selector. */
export function fieldRef(column: string, options: { alias?: string; sqlType?: string; mapper?: unknown; navigationAliases?: string[] } = {}): any {
  return {
    __dbColumnName: column,
    __fieldName: column,
    __tableAlias: options.alias ?? 'expr_shelves',
    __sqlType: options.sqlType,
    __mapper: options.mapper,
    __navigationAliases: options.navigationAliases,
  };
}
