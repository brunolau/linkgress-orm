import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createCustomType, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, eq, exists, fromSet, gt, gte, inSubquery,
  integer, length, literal, lt, serial, smallint, text, timestamp, unnest, unnestZip, varchar,
} from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * `DbCteBuilder.with(name, query)` takes every query a statement can run as its body — and `withAggregation()`
 * every query it can aggregate: an entity query (projected, whole rows, with navigations, carrying a CTE of its
 * own), a grouped query, a union, a CTE-rooted query (joined or not), a set query (bound to a context or not;
 * filtered, ordered, limited; a union of sets). A set query used to throw `_createMockRow is not a function`, a
 * CTE-rooted one too, and a union of sets lost its columns' types.
 *
 * The matrix: builder × consumer — the CTE read back whole, the CTE declared as a builder's SECOND CTE (its
 * parameters renumbered), the CTE in an EXISTS of an entity query that declares it, the CTE as an insertFrom
 * source, the builder aggregated by `withAggregation` — × engines. The ORACLE is the builder run on its own: the
 * CTE yields the same rows, each column read the way the builder reads it (a mapped column through its mapper, a
 * text column's '0042' as text, a timestamp as a Date).
 */

type Tier = 'bronze' | 'gold';

const tierMapper = createCustomType<{ data: Tier; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Tier | null | undefined) => (value == null ? null : value === 'gold' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'gold' : 'bronze'),
});

class CbAuthor extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  code!: DbColumn<string>;
  tier!: DbColumn<Tier>;

  books?: CbBook[];
}

class CbBook extends DbEntity {
  id!: DbColumn<number>;
  authorId!: DbColumn<number>;
  title!: DbColumn<string>;
  pages!: DbColumn<number>;
  published!: DbColumn<Date>;
  isbn!: DbColumn<string>;

  author?: CbAuthor;
}

class CbSink extends DbEntity {
  id!: DbColumn<number>;
  n!: DbColumn<number>;
}

class CteBodyDatabase extends DbContext {
  get authors(): DbEntityTable<CbAuthor> {
    return this.table(CbAuthor);
  }

  get books(): DbEntityTable<CbBook> {
    return this.table(CbBook);
  }

  get sinks(): DbEntityTable<CbSink> {
    return this.table(CbSink);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CbAuthor, entity => {
      entity.toTable('cb_authors');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
      entity.property(e => e.code).hasType(text('code')).isRequired();
      entity.property(e => e.tier).hasType(smallint('tier')).isRequired().hasCustomMapper(tierMapper);
      entity.hasMany(e => e.books, () => CbBook).withForeignKey(b => b.authorId).withPrincipalKey(a => a.id);
    });

    model.entity(CbBook, entity => {
      entity.toTable('cb_books');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.authorId).hasType(integer('author_id')).isRequired();
      entity.property(e => e.title).hasType(text('title')).isRequired();
      entity.property(e => e.pages).hasType(integer('pages')).isRequired();
      entity.property(e => e.published).hasType(timestamp('published')).isRequired();
      entity.property(e => e.isbn).hasType(varchar('isbn', 20)).isRequired();
      entity.hasOne(e => e.author, () => CbAuthor).withForeignKey(b => b.authorId).withPrincipalKey(a => a.id);
    });

    model.entity(CbSink, entity => {
      entity.toTable('cb_sinks');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.n).hasType(integer('n')).isRequired();
    });
  }
}

type BuilderKind =
  | 'entity-select' | 'entity-navigation' | 'entity-whole' | 'entity-carrying-cte' | 'grouped' | 'union'
  | 'cte-root' | 'cte-joined' | 'set-bound' | 'set-free' | 'set-where-order-limit' | 'set-union';

const BUILDERS: BuilderKind[] = [
  'entity-select', 'entity-navigation', 'entity-whole', 'entity-carrying-cte', 'grouped', 'union',
  'cte-root', 'cte-joined', 'set-bound', 'set-free', 'set-where-order-limit', 'set-union',
];

type Consumer = 'read' | 'second-cte' | 'exists' | 'insert-from' | 'aggregation';

const CONSUMERS: Consumer[] = ['read', 'second-cte', 'exists', 'insert-from', 'aggregation'];

/** A row's identity independent of its keys' order */
const canonical = (row: any): string => JSON.stringify(Object.keys(row).sort().map(k => [k, row[k]]));
const sortRows = (rows: any[]): any[] => [...rows].map(r => ({ ...r })).sort((a, b) => canonical(a).localeCompare(canonical(b)));

const pad = (n: number) => String(n).padStart(2, '0');

/** A timestamp as an aggregated item carries it: the JSON text of the stored (local) wall time */
const jsonTimestamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

describe('DbCteBuilder.with() / withAggregation() take every query builder as a body', () => {
  let client: DatabaseClient;
  let db: CteBodyDatabase;

  /** The body of `kind`, a fresh instance per call; `columns`: the keys of its rows; `key`: the column withAggregation groups by */
  const builderOf = (kind: BuilderKind): { query: any; columns: string[]; key: string } => {
    switch (kind) {
      case 'entity-select':
        return { query: db.books.where(b => gt(b.pages, 0)).select(b => ({ id: b.id, title: b.title, pages: b.pages, published: b.published })), columns: ['id', 'title', 'pages', 'published'], key: 'pages' };
      case 'entity-navigation':
        return { query: db.books.select(b => ({ id: b.id, title: b.title, author: b.author!.name, code: b.author!.code, tier: b.author!.tier })), columns: ['id', 'title', 'author', 'code', 'tier'], key: 'tier' };
      case 'entity-whole':
        return { query: db.books.where(b => gte(b.pages, 100)), columns: ['id', 'authorId', 'title', 'pages', 'published', 'isbn'], key: 'authorId' };
      case 'entity-carrying-cte': {
        const golden = new DbCteBuilder().with('cb_golden', db.authors.where(a => eq(a.tier, 'gold' as Tier)).select(a => ({ id: a.id })));
        return {
          query: db.books.with(golden.cte)
            .where(b => inSubquery(b.authorId, db.selectFromCte(golden.cte).select(r => r.id).asSubquery('array')))
            .select(b => ({ id: b.id, isbn: b.isbn })),
          columns: ['id', 'isbn'],
          key: 'isbn',
        };
      }
      case 'grouped':
        return {
          query: db.books.select(b => ({ authorId: b.authorId, pages: b.pages })).groupBy(b => ({ authorId: b.authorId }))
            .select(g => ({ authorId: g.key.authorId, total: g.sum(b => b.pages), books: g.count() })),
          columns: ['authorId', 'total', 'books'],
          key: 'authorId',
        };
      case 'union':
        return {
          query: db.books.where(b => lt(b.pages, 200)).select(b => ({ id: b.id, isbn: b.isbn, pages: b.pages }))
            .unionAll(db.books.where(b => gte(b.pages, 200)).select(b => ({ id: b.id, isbn: b.isbn, pages: b.pages }))),
          columns: ['id', 'isbn', 'pages'],
          key: 'isbn',
        };
      case 'cte-root': {
        const base = new DbCteBuilder().with('cb_base', db.books.select(b => ({ id: b.id, title: b.title, pages: b.pages, isbn: b.isbn })));
        return { query: db.selectFromCte(base.cte).where(r => gt(r.pages, 100)).select(r => ({ id: r.id, title: r.title, isbn: r.isbn })), columns: ['id', 'title', 'isbn'], key: 'isbn' };
      }
      case 'cte-joined': {
        const builder = new DbCteBuilder();
        const base = builder.with('cb_jbooks', db.books.select(b => ({ id: b.id, authorId: b.authorId, isbn: b.isbn })));
        const people = builder.with('cb_jauthors', db.authors.select(a => ({ id: a.id, code: a.code, tier: a.tier })));
        return {
          query: db.selectFromCte(base.cte).innerJoin(people.cte, sqlEq('cb_jbooks', 'authorId', 'cb_jauthors', 'id'))
            .select((b, a) => ({ id: b.id, isbn: b.isbn, code: a.code, tier: a.tier })),
          columns: ['id', 'isbn', 'code', 'tier'],
          key: 'code',
        };
      }
      case 'set-bound':
        return {
          query: db.selectFromSet(unnestZip({
            id: { values: [1, 2, 3], type: 'integer' },
            code: { values: ['0042', '0007', 'x'], type: 'text' },
          }), 'kc'),
          columns: ['id', 'code'],
          key: 'code',
        };
      case 'set-free':
        return {
          query: fromSet(unnest(['0042', '0007', 'abc'], 'text'), 'u').select(u => ({ code: u.value, len: length(u.value) })),
          columns: ['code', 'len'],
          key: 'len',
        };
      case 'set-where-order-limit':
        return {
          query: fromSet(unnestZip({
            id: { values: [1, 2, 3, 4], type: 'integer' },
            code: { values: ['0001', '0002', '0003', '0004'], type: 'varchar' },
          }), 'k').where(k => gt(k.id, 1)).orderBy(k => k.id).limit(2).select(k => ({ id: k.id, code: k.code })),
          columns: ['id', 'code'],
          key: 'code',
        };
      case 'set-union':
        return {
          query: fromSet(unnest(['0042'], 'text'), 'a').select(a => ({ code: a.value }))
            .unionAll(fromSet(unnest(['0007', '0099'], 'text'), 'b').select(b => ({ code: b.value }))),
          columns: ['code'],
          key: 'code',
        };
    }
  };

  /** ON "<left>"."<lc>" = "<right>"."<rc>" */
  const sqlEq = (left: string, lc: string, right: string, rc: string) =>
    eq({ __fieldName: lc, __dbColumnName: lc, __tableAlias: left } as any, { __fieldName: rc, __dbColumnName: rc, __tableAlias: right } as any);

  /** The builder run on its own: the oracle (a context-free set query runs through a context) */
  const oracleRows = async (kind: BuilderKind): Promise<any[]> => {
    const { query } = builderOf(kind);

    if (kind === 'set-free' || kind === 'set-where-order-limit') {
      // the same set, bound to the context
      const bound = kind === 'set-free'
        ? db.selectFromSet(unnest(['0042', '0007', 'abc'], 'text'), 'u').select(u => ({ code: u.value, len: length(u.value) }))
        : db.selectFromSet(unnestZip({
          id: { values: [1, 2, 3, 4], type: 'integer' },
          code: { values: ['0001', '0002', '0003', '0004'], type: 'varchar' },
        }), 'k').where(k => gt(k.id, 1)).orderBy(k => k.id).limit(2).select(k => ({ id: k.id, code: k.code }));

      return sortRows(await bound.toList());
    }

    if (kind === 'set-union') {
      return sortRows([{ code: '0042' }, { code: '0007' }, { code: '0099' }]);
    }

    return sortRows(await query.toList());
  };

  const readCte = async (cte: any, columns: string[]): Promise<any[]> =>
    sortRows(await db.selectFromCte(cte).select((r: any) => Object.fromEntries(columns.map(c => [c, r[c]]))).toList());

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new CteBodyDatabase(client, { logQueries: false });
    await client.query('DROP TABLE IF EXISTS cb_books, cb_authors, cb_sinks CASCADE');
    await db.getSchemaManager().ensureCreated();

    await db.authors.insertBulk([
      { name: 'Ann', code: '0042', tier: 'gold' },
      { name: 'Bob', code: '0007', tier: 'bronze' },
      { name: 'Cid', code: 'c-3', tier: 'gold' },
    ]);
    await db.books.insertBulk([
      { authorId: 1, title: 'First', pages: 120, published: new Date(2020, 0, 2, 3, 4, 5), isbn: '0001' },
      { authorId: 1, title: 'Second', pages: 80, published: new Date(2021, 5, 6, 7, 8, 9), isbn: '0002' },
      { authorId: 2, title: 'Third', pages: 300, published: new Date(2022, 1, 1), isbn: '0003' },
      { authorId: 3, title: 'Fourth', pages: 250, published: new Date(2023, 2, 3), isbn: '0004' },
      { authorId: 3, title: 'Fifth', pages: 99, published: new Date(2024, 3, 4), isbn: '0005' },
    ]);
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS cb_books, cb_authors, cb_sinks CASCADE');
    await db.dispose();
  });

  describe('matrix: builder × consumer', () => {
    for (const kind of BUILDERS) {
      for (const consumer of CONSUMERS) {
        test(`${kind} | ${consumer}`, async () => {
          const expected = await oracleRows(kind);
          const { query, columns, key } = builderOf(kind);

          switch (consumer) {
            case 'read': {
              const body = new DbCteBuilder().with('cb_body', query);
              expect(await readCte(body.cte, columns)).toEqual(expected);
              break;
            }
            case 'second-cte': {
              // A first CTE with parameters of its own: the body's are renumbered after them
              const builder = new DbCteBuilder();
              const first = builder.with('cb_first', db.authors.where(a => eq(a.code, 'c-3')).select(a => ({ id: a.id, name: a.name })));
              const body = builder.with('cb_body', query);
              expect(body.cte.paramBase).toBe(1 + first.cte.params.length);
              expect(await readCte(body.cte, columns)).toEqual(expected);
              const both = await db.selectFromCte(first.cte).crossJoin(body.cte).select((f: any) => ({ name: f.name })).toList();
              expect(both).toHaveLength(expected.length);
              break;
            }
            case 'exists': {
              const body = new DbCteBuilder().with('cb_body', query);
              const count = await db.authors.with(body.cte)
                .where(() => exists(db.selectFromCte(body.cte).select(() => ({ one: literal(1) })).asSubquery()))
                .count();
              expect(count).toBe(expected.length > 0 ? 3 : 0);
              break;
            }
            case 'insert-from': {
              const body = new DbCteBuilder().with('cb_body', query);
              const rows = await db.sinks.insertFrom(
                db.selectFromCte(body.cte).select(() => ({ one: literal(1) })).asSubquery('table'),
                src => ({ n: src.one }),
                { with: [body.cte] }
              ).returning(s => ({ n: s.n }));
              expect(rows).toHaveLength(expected.length);
              break;
            }
            case 'aggregation': {
              const aggregated = new DbCteBuilder().withAggregation('cb_agg', query, (r: any) => ({ k: r[key] }), 'items');
              const groups = await db.selectFromCte(aggregated).select((r: any) => ({ k: r.k, items: r.items })).toList();
              const expectedGroups = new Map<string, any[]>();
              for (const r of expected) {
                const k = JSON.stringify(r[key]);
                const { [key]: _omit, ...rest } = r;
                // withAggregation's items are JSON: a timestamp is its JSON text (as before — the items' transport);
                // a body of the key alone aggregates its whole rows (withAggregation's to_json fallback)
                const fields = Object.keys(rest).length > 0 ? rest : r;
                const item = Object.fromEntries(Object.entries(fields).map(([c, v]) => [c, v instanceof Date ? jsonTimestamp(v as Date) : v]));
                expectedGroups.set(k, [...(expectedGroups.get(k) ?? []), item]);
              }
              expect(groups.map(g => [JSON.stringify(g.k), sortRows(g.items)]).sort())
                .toEqual([...expectedGroups.entries()].map(([k, items]) => [k, sortRows(items)]).sort());
              break;
            }
          }
        });
      }
    }
  });
});
