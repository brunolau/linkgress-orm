/**
 * Two navigation paths that end in the SAME relation name.
 *
 *   loan -> book                          (the loan's own book)
 *   loan -> edition -> book               (the book the edition prints)
 *   loan -> edition -> category           (the edition's own category)
 *   loan -> edition -> book -> category   (the category of the edition's book)
 *
 * THE BUG (1.0.6 and earlier): a reference navigation rendered under its relation NAME, and the
 * joins were resolved by that name. Two paths ending in `book` collapsed into ONE join, and a deep
 * path such as `edition.book.category` was anchored on the first joined table that HAD a relation of
 * that name — the loan's own `book`, then the edition's own `category`:
 *
 *   LEFT JOIN "nac_editions" AS "edition"  ON "nac_loans"."edition_id" = "edition"."id"
 *   LEFT JOIN "nac_books" AS "book"        ON "nac_loans"."book_id" = "book"."id"          -- parent should be "edition"
 *   LEFT JOIN "nac_categories" AS "category" ON "edition"."category_id" = "category"."id" -- parent should be "book"
 *
 * Valid SQL, plausible rows, the wrong book and the wrong category.
 *
 * THE FIX: every path gets its own join, anchored on its own parent. The shallowest path (then the
 * first one projected) keeps the plain relation-name alias — so a query without a collision renders
 * exactly the SQL it rendered before, and a raw `sql` fragment naming `"book"` still resolves — and
 * every other path to the same name renders as `<parentAlias>__<relation>`.
 *
 * The fixture makes every path yield a DIFFERENT value for every loan, so neither a collapsed nor a
 * re-parented join can produce an expected value by accident:
 *
 *   loan  own book   edition's book   own book's category   edition's book's category   edition's category
 *   L1    Dune       Emma             Sci-fi                Classics                    Hardback line
 *   L2    Emma       Dune             Classics              Sci-fi                      Paperback line
 *
 * Dune has two editions (E-2, and E-3 that no loan holds), Emma one (E-1), so a collection hanging off
 * a book path (`ln.edition.book.editions`) yields a different list AND count per path too.
 */

import { describe, test, expect } from 'bun:test';
import { withCapturedSql } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import {
  DatabaseClient,
  DbContext,
  DbEntityTable,
  DbModelConfig,
  DbEntity,
  DbColumn,
  integer,
  varchar,
  and,
  eq,
  exists,
  sql,
} from '../../src';

// ---------------------------------------------------------------------------
// Schema: member -> loan -> { book, edition -> { book, category } }, book -> { category, editions }
// ---------------------------------------------------------------------------

class NacCategory extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NacBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  categoryId!: DbColumn<number>;

  category?: NacCategory;
  editions?: NacEdition[];
}

class NacEdition extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  bookId!: DbColumn<number>;
  categoryId!: DbColumn<number>;

  book?: NacBook;
  category?: NacCategory;
}

class NacMember extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  loans?: NacLoan[];
}

class NacLoan extends DbEntity {
  id!: DbColumn<number>;
  memberId!: DbColumn<number>;
  editionId!: DbColumn<number>;
  bookId!: DbColumn<number>;
  note!: DbColumn<string>;

  member?: NacMember;
  edition?: NacEdition;
  book?: NacBook;
}

class NacDatabase extends DbContext {
  get nacCategories(): DbEntityTable<NacCategory> {
    return this.table(NacCategory);
  }

  get nacBooks(): DbEntityTable<NacBook> {
    return this.table(NacBook);
  }

  get nacEditions(): DbEntityTable<NacEdition> {
    return this.table(NacEdition);
  }

  get nacMembers(): DbEntityTable<NacMember> {
    return this.table(NacMember);
  }

  get nacLoans(): DbEntityTable<NacLoan> {
    return this.table(NacLoan);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(NacCategory, entity => {
      entity.toTable('nac_categories');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_categories_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NacBook, entity => {
      entity.toTable('nac_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.categoryId).hasType(integer('category_id')).isRequired();

      entity.hasOne(e => e.category, () => NacCategory)
        .withForeignKey(b => b.categoryId)
        .withPrincipalKey(c => c.id);

      entity.hasMany(e => e.editions, () => NacEdition)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);
    });

    model.entity(NacEdition, entity => {
      entity.toTable('nac_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_editions_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.categoryId).hasType(integer('category_id')).isRequired();

      entity.hasOne(e => e.book, () => NacBook)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);

      entity.hasOne(e => e.category, () => NacCategory)
        .withForeignKey(ed => ed.categoryId)
        .withPrincipalKey(c => c.id);
    });

    model.entity(NacMember, entity => {
      entity.toTable('nac_members');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_members_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();

      entity.hasMany(e => e.loans, () => NacLoan)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(m => m.id);
    });

    model.entity(NacLoan, entity => {
      entity.toTable('nac_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_loans_id_seq' }));
      entity.property(e => e.memberId).hasType(integer('member_id')).isRequired();
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 100)).isRequired();

      entity.hasOne(e => e.member, () => NacMember)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(m => m.id);

      entity.hasOne(e => e.edition, () => NacEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);

      // The loan's own book — the same relation NAME the edition carries
      entity.hasOne(e => e.book, () => NacBook)
        .withForeignKey(ln => ln.bookId)
        .withPrincipalKey(b => b.id);
    });
  }
}

async function cleanupSchema(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS nac_loans CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_members CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_editions CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_books CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_categories CASCADE');
}

interface SeedIds {
  dune: number;
  emma: number;
  loan1: number;
  loan2: number;
  ada: number;
  bo: number;
}

async function seed(db: NacDatabase): Promise<SeedIds> {
  const [sciFi, classics, hardback, paperback] = await db.nacCategories.insertBulk([
    { name: 'Sci-fi' },
    { name: 'Classics' },
    { name: 'Hardback line' },
    { name: 'Paperback line' },
  ]).returning();

  const [dune, emma] = await db.nacBooks.insertBulk([
    { name: 'Dune', categoryId: sciFi.id },
    { name: 'Emma', categoryId: classics.id },
  ]).returning();

  // Each edition prints the OTHER book than the loan that holds it; E-3 is held by no loan
  const [edition1, edition2] = await db.nacEditions.insertBulk([
    { label: 'E-1', bookId: emma.id, categoryId: hardback.id },
    { label: 'E-2', bookId: dune.id, categoryId: paperback.id },
    { label: 'E-3', bookId: dune.id, categoryId: hardback.id },
  ]).returning();

  const [ada, bo] = await db.nacMembers.insertBulk([
    { name: 'Ada' },
    { name: 'Bo' },
  ]).returning();

  const [loan1, loan2] = await db.nacLoans.insertBulk([
    { memberId: ada.id, editionId: edition1.id, bookId: dune.id, note: 'first' },
    { memberId: ada.id, editionId: edition2.id, bookId: emma.id, note: 'second' },
  ]).returning();

  return { dune: dune.id, emma: emma.id, loan1: loan1.id, loan2: loan2.id, ada: ada.id, bo: bo.id };
}

type Strategy = 'cte' | 'lateral' | 'temptable';

/** Fresh schema per test, with the executed statements captured. */
async function withCapture<T>(
  strategy: Strategy,
  testFn: (db: NacDatabase, captured: string[], ids: SeedIds) => Promise<T>,
): Promise<T> {
  return withCapturedSql(
    (client, options) => new NacDatabase(client, options),
    strategy,
    cleanupSchema,
    async (db, captured) => {
      const ids = await seed(db);

      // Drop the DDL / INSERT chatter so the assertions see only what the test ran
      captured.length = 0;

      return testFn(db, captured, ids);
    },
  );
}

/** The executed statements, without the logger's `[SQL Query]` headers. */
const statements = (captured: string[]): string[] => captured.filter(entry => !entry.trimStart().startsWith('['));

/** The last executed statement. */
const lastStatement = (captured: string[]): string => {
  const all = statements(captured);

  return all[all.length - 1] ?? '';
};

const byId = <T extends { id: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

// ---------------------------------------------------------------------------
// Root projection
// ---------------------------------------------------------------------------

describe('navigation alias collision — root projection', () => {
  test('A: ln.book and ln.edition.book get two joins and two values', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          directBook: ln.book!.name,
          editionBook: ln.edition!.book!.name,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' },
        { id: ids.loan2, directBook: 'Emma', editionBook: 'Dune' },
      ]);

      const statement = lastStatement(captured);
      expect(statement).toContain('LEFT JOIN "nac_books" AS "book" ON "nac_loans"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "nac_editions" AS "edition" ON "nac_loans"."edition_id" = "edition"."id"');
      expect(statement).toContain('LEFT JOIN "nac_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
      expect(statement).toContain('"book"."name" as "directBook"');
      expect(statement).toContain('"edition__book"."name" as "editionBook"');
    });
  });

  test('A: the shallowest path owns the plain alias whatever the projection order', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          editionBook: ln.edition!.book!.name,
          directBook: ln.book!.name,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, editionBook: 'Emma', directBook: 'Dune' },
        { id: ids.loan2, editionBook: 'Dune', directBook: 'Emma' },
      ]);

      const statement = lastStatement(captured);
      expect(statement).toContain('"edition__book"."name" as "editionBook"');
      expect(statement).toContain('"book"."name" as "directBook"');
    });
  });

  test('B: ln.edition.book.category alone anchors book on edition and category on that book', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          editionBookCategory: ln.edition!.book!.category!.name,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, editionBookCategory: 'Classics' },
        { id: ids.loan2, editionBookCategory: 'Sci-fi' },
      ]);

      const statement = lastStatement(captured);
      expect(statement).toContain('LEFT JOIN "nac_editions" AS "edition" ON "nac_loans"."edition_id" = "edition"."id"');
      expect(statement).toContain('LEFT JOIN "nac_books" AS "book" ON "edition"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "category" ON "book"."category_id" = "category"."id"');
      expect(statement).not.toContain('"nac_loans"."book_id"');
    });
  });

  test('C: ln.edition.book.category and ln.edition.category get two category joins', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          bookCategory: ln.edition!.book!.category!.name,
          editionCategory: ln.edition!.category!.name,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, bookCategory: 'Classics', editionCategory: 'Hardback line' },
        { id: ids.loan2, bookCategory: 'Sci-fi', editionCategory: 'Paperback line' },
      ]);

      const statement = lastStatement(captured);
      expect(statement).toContain('LEFT JOIN "nac_books" AS "book" ON "edition"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "category" ON "edition"."category_id" = "category"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "book__category" ON "book"."category_id" = "book__category"."id"');
      expect(statement).toContain('"book__category"."name" as "bookCategory"');
      expect(statement).toContain('"category"."name" as "editionCategory"');
    });
  });

  test('all five paths at once — each on its own join', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          directBook: ln.book!.name,
          directBookCategory: ln.book!.category!.name,
          editionBook: ln.edition!.book!.name,
          editionBookCategory: ln.edition!.book!.category!.name,
          editionCategory: ln.edition!.category!.name,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        {
          id: ids.loan1,
          directBook: 'Dune',
          directBookCategory: 'Sci-fi',
          editionBook: 'Emma',
          editionBookCategory: 'Classics',
          editionCategory: 'Hardback line',
        },
        {
          id: ids.loan2,
          directBook: 'Emma',
          directBookCategory: 'Classics',
          editionBook: 'Dune',
          editionBookCategory: 'Sci-fi',
          editionCategory: 'Paperback line',
        },
      ]);

      const statement = lastStatement(captured);
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "category" ON "book"."category_id" = "category"."id"');
      expect(statement).toContain('LEFT JOIN "nac_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "edition__category" ON "edition"."category_id" = "edition__category"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "edition__book__category" ON "edition__book"."category_id" = "edition__book__category"."id"');
    });
  });

  test('a whole navigation row (ln.edition.book) reads the edition\'s book, not the loan\'s', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          directBook: ln.book!.name,
          editionBook: ln.edition!.book,
        }))
        .toList();

      const sorted = byId(rows);
      expect(sorted.map(row => row.directBook)).toEqual(['Dune', 'Emma']);
      expect(sorted.map(row => (row.editionBook as any)?.name)).toEqual(['Emma', 'Dune']);
      expect(sorted.map(row => (row.editionBook as any)?.id)).toEqual([ids.emma, ids.dune]);
    });
  });

  test('a raw sql fragment naming "book" resolves to the path that owns the plain alias', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          directBook: ln.book!.name,
          editionBook: ln.edition!.book!.name,
          shout: sql<string>`upper("book"."name")`,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, directBook: 'Dune', editionBook: 'Emma', shout: 'DUNE' },
        { id: ids.loan2, directBook: 'Emma', editionBook: 'Dune', shout: 'EMMA' },
      ]);
    });
  });

  test('a raw sql fragment naming "book" follows the only book path when that path is deep', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          editionBook: ln.edition!.book!.name,
          shout: sql<string>`upper("book"."name")`,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, editionBook: 'Emma', shout: 'EMMA' },
        { id: ids.loan2, editionBook: 'Dune', shout: 'DUNE' },
      ]);
    });
  });

  test('field refs inside a projected sql fragment follow their own path', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({
          id: ln.id,
          pair: sql<string>`${ln.book!.name} || '/' || ${ln.edition!.book!.name}`,
        }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, pair: 'Dune/Emma' },
        { id: ids.loan2, pair: 'Emma/Dune' },
      ]);
      expect(lastStatement(captured)).toContain(`"book"."name" || '/' || "edition__book"."name"`);
    });
  });
});

// ---------------------------------------------------------------------------
// WHERE / ORDER BY / aggregates
// ---------------------------------------------------------------------------

describe('navigation alias collision — where, orderBy and aggregates', () => {
  test('where on ln.edition.book while ln.book is projected', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .where(ln => eq(ln.edition!.book!.name, 'Emma'))
        .select(ln => ({ id: ln.id, directBook: ln.book!.name }))
        .toList();

      expect(rows).toEqual([{ id: ids.loan1, directBook: 'Dune' }]);

      const statement = lastStatement(captured);
      expect(statement).toContain('"edition__book"."name" = $1');
      expect(statement).toContain('LEFT JOIN "nac_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
    });
  });

  test('where on a projected colliding field after select()', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({ id: ln.id, directBook: ln.book!.name, editionBook: ln.edition!.book!.name }))
        .where(row => eq(row.editionBook, 'Emma'))
        .toList();

      expect(rows).toEqual([{ id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' }]);
    });
  });

  test('orderBy a projected colliding field', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const byEditionBook = await db.nacLoans
        .select(ln => ({ id: ln.id, directBook: ln.book!.name, editionBook: ln.edition!.book!.name }))
        .orderBy(row => row.editionBook)
        .toList();

      // Dune (loan 2) sorts before Emma (loan 1) — the loan's own book would give the opposite order
      expect(byEditionBook.map(row => row.id)).toEqual([ids.loan2, ids.loan1]);
    });
  });

  test('count() and exists() with a where over both paths', async () => {
    await withCapture('lateral', async (db) => {
      const both = await db.nacLoans
        .where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Emma')))
        .count();

      expect(both).toBe(1);

      const none = await db.nacLoans
        .where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Dune')))
        .exists();

      expect(none).toBe(false);
    });
  });

  test('a correlated subquery reads the outer ln.edition.book while the outer projects ln.book', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      // Only Dune has an edition labelled E-3: the loan whose EDITION prints Dune is loan 2 — the
      // loan whose OWN book is Dune is loan 1
      const rows = await db.nacLoans
        .where(ln => exists(db.nacEditions
          .where(ed => and(eq(ed.bookId, ln.edition!.book!.id), eq(ed.label, 'E-3')))
          .select(ed => ({ id: ed.id }))
          .asSubquery()))
        .select(ln => ({ id: ln.id, directBook: ln.book!.name }))
        .toList();

      expect(rows).toEqual([{ id: ids.loan2, directBook: 'Emma' }]);
      expect(lastStatement(captured)).toContain('"nac_editions"."book_id" = "edition__book"."id"');
    });
  });

  test('where through a deep path whose leaf name the root also has (mis-anchored before)', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const rows = await db.nacLoans
        .where(ln => eq(ln.edition!.book!.category!.name, 'Classics'))
        .select(ln => ({ id: ln.id }))
        .toList();

      expect(rows).toEqual([{ id: ids.loan1 }]);

      const statement = lastStatement(captured);
      expect(statement).toContain('LEFT JOIN "nac_books" AS "book" ON "edition"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "nac_categories" AS "category" ON "book"."category_id" = "category"."id"');
    });
  });
});

// ---------------------------------------------------------------------------
// Grouped queries
// ---------------------------------------------------------------------------

describe('navigation alias collision — groupBy', () => {
  test('grouping by both book paths', async () => {
    await withCapture('lateral', async (db) => {
      const rows = await db.nacLoans
        .select(ln => ({ directBook: ln.book!.name, editionBook: ln.edition!.book!.name }))
        .groupBy(row => ({ directBook: row.directBook, editionBook: row.editionBook }))
        .select(group => ({
          directBook: group.key.directBook,
          editionBook: group.key.editionBook,
          loans: group.count(),
        }))
        .toList();

      expect([...rows].sort((a, b) => a.directBook.localeCompare(b.directBook))).toEqual([
        { directBook: 'Dune', editionBook: 'Emma', loans: 1 },
        { directBook: 'Emma', editionBook: 'Dune', loans: 1 },
      ]);
    });
  });

  test('grouping with a where on the other book path', async () => {
    await withCapture('lateral', async (db) => {
      const rows = await db.nacLoans
        .where(ln => eq(ln.edition!.book!.name, 'Emma'))
        .select(ln => ({ directBook: ln.book!.name }))
        .groupBy(row => ({ directBook: row.directBook }))
        .select(group => ({ directBook: group.key.directBook, loans: group.count() }))
        .toList();

      expect(rows).toEqual([{ directBook: 'Dune', loans: 1 }]);
    });
  });

  test('grouping by a deep path whose leaf name the root also has', async () => {
    await withCapture('lateral', async (db) => {
      const rows = await db.nacLoans
        .select(ln => ({ category: ln.edition!.book!.category!.name }))
        .groupBy(row => ({ category: row.category }))
        .select(group => ({ category: group.key.category, loans: group.count() }))
        .toList();

      expect([...rows].sort((a, b) => a.category.localeCompare(b.category))).toEqual([
        { category: 'Classics', loans: 1 },
        { category: 'Sci-fi', loans: 1 },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Collections — every strategy renders navigations inside a collection
// ---------------------------------------------------------------------------

for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
  describe(`navigation alias collision — inside a collection (${strategy})`, () => {
    test('A: member.loans.select(ln.book, ln.edition.book)', async () => {
      await withCapture(strategy, async (db, _captured, ids) => {
        const members = await db.nacMembers
          .select(m => ({
            id: m.id,
            loans: m.loans!.select(ln => ({
              id: ln.id,
              directBook: ln.book!.name,
              editionBook: ln.edition!.book!.name,
            })).toList(),
          }))
          .toList();

        const ada = members.find(m => m.id === ids.ada)!;
        expect(byId(ada.loans as any[])).toEqual([
          { id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' },
          { id: ids.loan2, directBook: 'Emma', editionBook: 'Dune' },
        ]);
        expect(members.find(m => m.id === ids.bo)!.loans).toEqual([]);
      });
    });

    test('B: member.loans.select(ln.edition.book.category) alone', async () => {
      await withCapture(strategy, async (db, captured, ids) => {
        const members = await db.nacMembers
          .select(m => ({
            id: m.id,
            loans: m.loans!.select(ln => ({
              id: ln.id,
              editionBookCategory: ln.edition!.book!.category!.name,
            })).toList(),
          }))
          .toList();

        expect(byId(members.find(m => m.id === ids.ada)!.loans as any[])).toEqual([
          { id: ids.loan1, editionBookCategory: 'Classics' },
          { id: ids.loan2, editionBookCategory: 'Sci-fi' },
        ]);

        const statement = statements(captured).join('\n');
        expect(statement).toContain('"edition"."book_id" = "book"."id"');
        expect(statement).toContain('"book"."category_id" = "category"."id"');
        expect(statement).not.toContain('"nac_loans"."book_id" = "book"."id"');
      });
    });

    test('C: member.loans.select(ln.edition.book.category, ln.edition.category)', async () => {
      await withCapture(strategy, async (db, _captured, ids) => {
        const members = await db.nacMembers
          .select(m => ({
            id: m.id,
            loans: m.loans!.select(ln => ({
              id: ln.id,
              bookCategory: ln.edition!.book!.category!.name,
              editionCategory: ln.edition!.category!.name,
            })).toList(),
          }))
          .toList();

        expect(byId(members.find(m => m.id === ids.ada)!.loans as any[])).toEqual([
          { id: ids.loan1, bookCategory: 'Classics', editionCategory: 'Hardback line' },
          { id: ids.loan2, bookCategory: 'Sci-fi', editionCategory: 'Paperback line' },
        ]);
      });
    });

    test('a collection where on ln.edition.book while ln.book is projected', async () => {
      await withCapture(strategy, async (db, _captured, ids) => {
        const members = await db.nacMembers
          .select(m => ({
            id: m.id,
            loans: m.loans!
              .where(ln => eq(ln.edition!.book!.name, 'Emma'))
              .select(ln => ({ id: ln.id, directBook: ln.book!.name }))
              .toList(),
          }))
          .toList();

        expect(members.find(m => m.id === ids.ada)!.loans).toEqual([{ id: ids.loan1, directBook: 'Dune' }]);
      });
    });

    test('a collection count() with a where over both paths', async () => {
      await withCapture(strategy, async (db, _captured, ids) => {
        const members = await db.nacMembers
          .select(m => ({
            id: m.id,
            matching: m.loans!
              .where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Emma')))
              .count(),
          }))
          .toList();

        expect(members.find(m => m.id === ids.ada)!.matching).toBe(1);
        expect(members.find(m => m.id === ids.bo)!.matching).toBe(0);
      });
    });
  });
}

describe('navigation alias collision — a collection hanging off a colliding path', () => {
  // The nested list correlates through the path's last hop (`edition__book` here). The count is the
  // LATERAL correlated-subquery form, which relies on the enclosing scope for that hop unless the
  // hop was renamed.
  test('lateral: member.loans.select(ln.book, ln.edition.book.editions)', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const members = await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            directBook: ln.book!.name,
            printed: ln.edition!.book!.editions!.select(ed => ({ label: ed.label })).toList(),
            printedCount: ln.edition!.book!.editions!.count(),
          })).toList(),
        }))
        .toList();

      const loans = byId(members.find(m => m.id === ids.ada)!.loans as any[]);
      expect(loans.map(ln => ln.directBook)).toEqual(['Dune', 'Emma']);
      expect(loans.map(ln => (ln.printed as any[]).map(ed => ed.label).sort())).toEqual([['E-1'], ['E-2', 'E-3']]);
      expect(loans.map(ln => ln.printedCount)).toEqual([1, 2]);
    });
  });

  test('cte: member.loans.select(ln.book, ln.edition.book.editions)', async () => {
    await withCapture('cte', async (db, captured, ids) => {
      const members = await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            directBook: ln.book!.name,
            printed: ln.edition!.book!.editions!.select(ed => ({ label: ed.label })).toList(),
            printedCount: ln.edition!.book!.editions!.count(),
          })).toList(),
        }))
        .toList();

      const loans = byId(members.find(m => m.id === ids.ada)!.loans as any[]);
      expect(loans.map(ln => ln.directBook)).toEqual(['Dune', 'Emma']);
      expect(loans.map(ln => (ln.printed as any[]).map(ed => ed.label).sort())).toEqual([['E-1'], ['E-2', 'E-3']]);
      // A nested count under the CTE strategy used to come back as `{}`
      expect(loans.map(ln => ln.printedCount)).toEqual([1, 2]);
      expect(lastStatement(captured)).toContain('LEFT JOIN "cte_0" ON "edition__book"."id" = "cte_0".parent_id');
    });
  });

  test('temptable: member.loans.select(ln.book, ln.edition.book.editions)', async () => {
    await withCapture('temptable', async (db, _captured, ids) => {
      const members = await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            directBook: ln.book!.name,
            printed: ln.edition!.book!.editions!.select(ed => ({ label: ed.label })).toList(),
            printedCount: ln.edition!.book!.editions!.count(),
          })).toList(),
        }))
        .toList();

      const loans = byId(members.find(m => m.id === ids.ada)!.loans as any[]);
      expect(loans.map(ln => ln.directBook)).toEqual(['Dune', 'Emma']);
      expect(loans.map(ln => (ln.printed as any[]).map(ed => ed.label).sort())).toEqual([['E-1'], ['E-2', 'E-3']]);
      expect(loans.map(ln => ln.printedCount)).toEqual([1, 2]);
    });
  });
});

describe('navigation alias collision — a root collection hanging off a colliding path', () => {
  test.each(['lateral', 'cte', 'temptable'] as const)('%s: loans.select(ln.book, ln.edition.book.editions)', async (strategy) => {
    await withCapture(strategy, async (db, _captured, ids) => {
      const rows = byId(await db.nacLoans
        .select(ln => ({
          id: ln.id,
          directBook: ln.book!.name,
          printed: ln.edition!.book!.editions!.select(ed => ({ label: ed.label })).toList(),
          printedCount: ln.edition!.book!.editions!.count(),
        }))
        .toList());

      expect(rows.map(row => row.id)).toEqual([ids.loan1, ids.loan2]);
      expect(rows.map(row => row.directBook)).toEqual(['Dune', 'Emma']);
      expect(rows.map(row => (row.printed as any[]).map(ed => ed.label).sort())).toEqual([['E-1'], ['E-2', 'E-3']]);
      expect(rows.map(row => row.printedCount)).toEqual([1, 2]);
    });
  });
});

describe('navigation alias collision — exists() over a collection in a where', () => {
  test('the correlated EXISTS joins both paths', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacMembers
        .where(m => exists(m.loans!.where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Emma')))))
        .select(m => ({ id: m.id }))
        .toList();

      expect(rows).toEqual([{ id: ids.ada }]);
    });
  });
});

describe('navigation alias collision — temptable', () => {
  test('the base query of a temptable run is fixed like any root query', async () => {
    await withCapture('temptable', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .select(ln => ({ id: ln.id, directBook: ln.book!.name, editionBook: ln.edition!.book!.name }))
        .toList();

      expect(byId(rows)).toEqual([
        { id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' },
        { id: ids.loan2, directBook: 'Emma', editionBook: 'Dune' },
      ]);
    });
  });

  test('colliding paths inside a temptable collection get a join each in the aggregation statement', async () => {
    await withCapture('temptable', async (db, captured, ids) => {
      const members = await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            directBook: ln.book!.name,
            editionBook: ln.edition!.book!.name,
          })).toList(),
        }))
        .toList();

      expect(byId(members.find(m => m.id === ids.ada)!.loans as any[])).toEqual([
        { id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' },
        { id: ids.loan2, directBook: 'Emma', editionBook: 'Dune' },
      ]);

      // The temp-table aggregation: the loan's own book, and the edition's book under its path alias
      const aggregation = statements(captured).find(statement => statement.includes('json_agg')) ?? '';
      expect(aggregation).toContain('LEFT JOIN "nac_books" "book" ON "nac_loans"."book_id" = "book"."id"');
      expect(aggregation).toContain('LEFT JOIN "nac_books" "edition__book" ON "edition"."book_id" = "edition__book"."id"');
      expect(aggregation).toContain('IN (SELECT id FROM tmp_parent_ids_');
    });
  });
});

// ---------------------------------------------------------------------------
// UPDATE … FROM / DELETE … USING
// ---------------------------------------------------------------------------

describe('navigation alias collision — update and delete', () => {
  test('update where ln.edition.book matches — the loan\'s own book must not decide', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      await db.nacLoans
        .where(ln => eq(ln.edition!.book!.name, 'Emma'))
        .update({ note: 'edition prints Emma' });

      const statement = lastStatement(captured);
      expect(statement).toContain('"edition"."book_id" = "book"."id"');
      expect(statement).not.toContain('"nac_loans"."book_id"');

      const rows = byId(await db.nacLoans.select(ln => ({ id: ln.id, note: ln.note })).toList());
      expect(rows).toEqual([
        { id: ids.loan1, note: 'edition prints Emma' },
        { id: ids.loan2, note: 'second' },
      ]);
    });
  });

  test('update where both book paths are tested', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      await db.nacLoans
        .where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Emma')))
        .update({ note: 'both' });

      const rows = byId(await db.nacLoans.select(ln => ({ id: ln.id, note: ln.note })).toList());
      expect(rows).toEqual([
        { id: ids.loan1, note: 'both' },
        { id: ids.loan2, note: 'second' },
      ]);
    });
  });

  test('update toStatement renders both paths', async () => {
    await withCapture('lateral', async (db) => {
      const statement = db.nacLoans
        .where(ln => and(eq(ln.book!.name, 'Dune'), eq(ln.edition!.book!.name, 'Emma')))
        .update({ note: 'both' })
        .toStatement();

      expect(statement.sql).toContain('"nac_books" AS "edition__book"');
      expect(statement.sql).toContain('"edition"."book_id" = "edition__book"."id"');
      expect(statement.sql).toContain('"book"."name" = $2 AND "edition__book"."name" = $3');
    });
  });

  test('update … returning both book paths', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .where(ln => eq(ln.id, ids.loan1))
        .update({ note: 'returned' })
        .returning(ln => ({ id: ln.id, directBook: ln.book!.name, editionBook: ln.edition!.book!.name }));

      expect(rows).toEqual([{ id: ids.loan1, directBook: 'Dune', editionBook: 'Emma' }]);
    });
  });

  test('delete … returning a deep path whose leaf name the root also has', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const rows = await db.nacLoans
        .where(ln => eq(ln.id, ids.loan2))
        .delete()
        .returning(ln => ({ id: ln.id, editionBookCategory: ln.edition!.book!.category!.name }));

      expect(rows).toEqual([{ id: ids.loan2, editionBookCategory: 'Sci-fi' }]);
    });
  });

  test('delete where both book paths are tested', async () => {
    await withCapture('lateral', async (db, _captured, ids) => {
      const deleted = await db.nacLoans
        .where(ln => and(eq(ln.book!.name, 'Emma'), eq(ln.edition!.book!.name, 'Dune')))
        .delete()
        .affectedCount();

      expect(deleted).toBe(1);

      const rows = await db.nacLoans.select(ln => ({ id: ln.id })).toList();
      expect(rows).toEqual([{ id: ids.loan1 }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Refusal: a path alias PostgreSQL would truncate. Relation names this long are unusual, but a
// truncated alias can collide with another one, so the build refuses rather than emit it.
// ---------------------------------------------------------------------------

class NacLongBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NacLongEdition extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;

  bookThatThisRelationNameMakesDeliberatelyLong?: NacLongBook;
}

class NacLongLoan extends DbEntity {
  id!: DbColumn<number>;
  editionId!: DbColumn<number>;
  bookId!: DbColumn<number>;

  editionThatThisRelationNameMakesLongToo?: NacLongEdition;
  bookThatThisRelationNameMakesDeliberatelyLong?: NacLongBook;
}

class NacLongDatabase extends DbContext {
  get nacLongLoans(): DbEntityTable<NacLongLoan> {
    return this.table(NacLongLoan);
  }

  get nacLongEditions(): DbEntityTable<NacLongEdition> {
    return this.table(NacLongEdition);
  }

  get nacLongBooks(): DbEntityTable<NacLongBook> {
    return this.table(NacLongBook);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(NacLongBook, entity => {
      entity.toTable('nac_long_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_long_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NacLongEdition, entity => {
      entity.toTable('nac_long_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_long_editions_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();

      entity.hasOne(e => e.bookThatThisRelationNameMakesDeliberatelyLong, () => NacLongBook)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);
    });

    model.entity(NacLongLoan, entity => {
      entity.toTable('nac_long_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nac_long_loans_id_seq' }));
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();

      entity.hasOne(e => e.editionThatThisRelationNameMakesLongToo, () => NacLongEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);

      entity.hasOne(e => e.bookThatThisRelationNameMakesDeliberatelyLong, () => NacLongBook)
        .withForeignKey(ln => ln.bookId)
        .withPrincipalKey(b => b.id);
    });
  }
}

async function cleanupLongSchema(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS nac_long_loans CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_long_editions CASCADE');
  await client.query('DROP TABLE IF EXISTS nac_long_books CASCADE');
}

describe('navigation alias collision — refusals', () => {
  test('a path alias past PostgreSQL\'s 63-byte identifier limit is refused, naming both paths', async () => {
    await withCapturedSql(
      (client, options) => new NacLongDatabase(client, options),
      'lateral',
      cleanupLongSchema,
      async (db) => {
        const error = await expectToReject(
          db.nacLongLoans
            .select(ln => ({
              direct: ln.bookThatThisRelationNameMakesDeliberatelyLong!.name,
              throughEdition: ln.editionThatThisRelationNameMakesLongToo!.bookThatThisRelationNameMakesDeliberatelyLong!.name,
            }))
            .toList(),
        );

        expect(error.message).toContain('"editionThatThisRelationNameMakesLongToo.bookThatThisRelationNameMakesDeliberatelyLong"');
        expect(error.message).toContain('the path "bookThatThisRelationNameMakesDeliberatelyLong"');
        expect(error.message).toContain('63-byte');
        expect(error.message).toContain('separate query');
      },
    );
  });

  test('NOT refused: the query reads the long two-hop path, a projected subquery the one-hop path of that name', async () => {
    await withCapturedSql(
      (client, options) => new NacLongDatabase(client, options),
      'lateral',
      cleanupLongSchema,
      async (db, captured) => {
        const [dune, emma] = await db.nacLongBooks.insertBulk([{ name: 'Dune' }, { name: 'Emma' }]).returning();
        const [edition] = await db.nacLongEditions.insertBulk([{ bookId: emma.id }]).returning();
        const [loan] = await db.nacLongLoans.insertBulk([{ editionId: edition.id, bookId: dune.id }]).returning();
        captured.length = 0;

        // The query's own path is the only one it reads: it keeps the plain alias, as without the subquery.
        // The subquery's path used to take it (the shallower one), and the query's path then needed the
        // 86-byte alias "editionThatThisRelationNameMakesLongToo__bookThatThisRelationNameMakesDeliberatelyLong"
        const rows = await db.nacLongLoans
          .select(ln => ({
            id: ln.id,
            printed: ln.editionThatThisRelationNameMakesLongToo!.bookThatThisRelationNameMakesDeliberatelyLong!.name,
            own: db.nacLongBooks.where(b => eq(b.id, ln.bookThatThisRelationNameMakesDeliberatelyLong!.id)).select(b => b.name).asSubquery('scalar'),
          }))
          .toList();

        expect(rows).toEqual([{ id: loan.id, printed: 'Emma', own: 'Dune' }]);
        const statement = lastStatement(captured);
        expect(statement).toContain('AS "bookThatThisRelationNameMakesDeliberatelyLong" ON "editionThatThisRelationNameMakesLongToo"."book_id" = "bookThatThisRelationNameMakesDeliberatelyLong"."id"');
        expect(statement).toContain('AS "nac_long_loans__bookThatThisRelationNameMakesDeliberatelyLong" ON "nac_long_loans"."book_id"');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Counter-tests: a query without a collision renders exactly the SQL it rendered before.
// Every statement below was captured from 1.0.6, before the fix, and must never change.
// ---------------------------------------------------------------------------

const PIN_ROOT_BOOK_AND_CATEGORY = [
  'SELECT "nac_loans"."id" as "id", "book"."name" as "bookName", "category"."name" as "bookCategory"',
  'FROM "nac_loans"',
  'LEFT JOIN "nac_books" AS "book" ON "nac_loans"."book_id" = "book"."id"',
  'LEFT JOIN "nac_categories" AS "category" ON "book"."category_id" = "category"."id"',
].join('\n');

const PIN_ROOT_EDITION_AND_CATEGORY = [
  'SELECT "nac_loans"."id" as "id", "edition"."label" as "edition", "category"."name" as "editionCategory"',
  'FROM "nac_loans"',
  'LEFT JOIN "nac_editions" AS "edition" ON "nac_loans"."edition_id" = "edition"."id"',
  'LEFT JOIN "nac_categories" AS "category" ON "edition"."category_id" = "category"."id"',
].join('\n');

const PIN_ROOT_RAW_FRAGMENT = [
  'SELECT "nac_loans"."id" as "id", "book"."name" as "bookName", upper("book"."name") as "shout"',
  'FROM "nac_loans"',
  'LEFT JOIN "nac_books" AS "book" ON "nac_loans"."book_id" = "book"."id"',
].join('\n');

const PIN_LATERAL_COLLECTION = [
  'SELECT "nac_members"."id" as "id", COALESCE("lateral_0".data, \'[]\'::json) as "loans"',
  'FROM "nac_members"',
  'LEFT JOIN LATERAL (SELECT json_agg(',
  '  json_build_object(\'id\', "id", \'bookName\', "bookName", \'bookCategory\', "bookCategory", \'edition\', "edition")',
  ') as data',
  'FROM (',
  '  SELECT "lateral_0_loans"."id" as "id", "book"."name" as "bookName", "category"."name" as "bookCategory", "edition"."label" as "edition"',
  '  FROM "nac_loans" "lateral_0_loans"',
  '  LEFT JOIN "nac_books" "book" ON "lateral_0_loans"."book_id" = "book"."id"',
  '  LEFT JOIN "nac_editions" "edition" ON "lateral_0_loans"."edition_id" = "edition"."id"',
  '  LEFT JOIN "nac_categories" "category" ON "book"."category_id" = "category"."id"',
  '  ',
  '  WHERE "lateral_0_loans"."member_id" = "nac_members"."id"',
  '  ',
  '  ',
  ') sub) "lateral_0" ON true',
].join('\n');

const PIN_CTE_COLLECTION = [
  'WITH "cte_0" AS (SELECT',
  '  "__fk_member_id" as parent_id,',
  '  json_agg(',
  '    json_build_object(\'id\', "id", \'bookName\', "bookName", \'bookCategory\', "bookCategory", \'edition\', "edition")',
  '  ) as data',
  'FROM (',
  '  SELECT "nac_loans"."member_id" as "__fk_member_id", "nac_loans"."id" as "id", "book"."name" as "bookName", "category"."name" as "bookCategory", "edition"."label" as "edition"',
  '  FROM "nac_loans"',
  '  LEFT JOIN "nac_books" "book" ON "nac_loans"."book_id" = "book"."id"',
  '  LEFT JOIN "nac_editions" "edition" ON "nac_loans"."edition_id" = "edition"."id"',
  '  LEFT JOIN "nac_categories" "category" ON "book"."category_id" = "category"."id"',
  '  ',
  '  ',
  '  ',
  ') sub',
  'GROUP BY "__fk_member_id")',
  'SELECT "nac_members"."id" as "id", COALESCE("cte_0".data, \'[]\'::json) as "loans"',
  'FROM "nac_members"',
  'LEFT JOIN "cte_0" ON "cte_0".parent_id = "nac_members".id',
].join('\n');

const PIN_GROUPED = [
  'SELECT "book"."name" as "bookName", CAST(COUNT(*) AS INTEGER) as "loans"',
  'FROM "nac_loans"',
  'LEFT JOIN "nac_books" AS "book" ON "nac_loans"."book_id" = "book"."id"',
  '',
  'GROUP BY "book"."name"',
].join('\n');

const PIN_UPDATE = 'UPDATE "nac_loans" SET "note" = $1 FROM "nac_books" AS "book" WHERE "nac_loans"."book_id" = "book"."id" AND "book"."name" = $2';

describe('navigation alias collision — non-colliding SQL is unchanged', () => {
  test('root: ln.book + ln.book.category', async () => {
    await withCapture('lateral', async (db, captured) => {
      await db.nacLoans
        .select(ln => ({ id: ln.id, bookName: ln.book!.name, bookCategory: ln.book!.category!.name }))
        .toList();

      expect(lastStatement(captured)).toBe(PIN_ROOT_BOOK_AND_CATEGORY);
    });
  });

  test('root: ln.edition + ln.edition.category', async () => {
    await withCapture('lateral', async (db, captured) => {
      await db.nacLoans
        .select(ln => ({ id: ln.id, edition: ln.edition!.label, editionCategory: ln.edition!.category!.name }))
        .toList();

      expect(lastStatement(captured)).toBe(PIN_ROOT_EDITION_AND_CATEGORY);
    });
  });

  test('root: a raw fragment naming the plain alias', async () => {
    await withCapture('lateral', async (db, captured) => {
      const rows = await db.nacLoans
        .select(ln => ({ id: ln.id, bookName: ln.book!.name, shout: sql<string>`upper("book"."name")` }))
        .toList();

      expect(rows.map(row => row.shout).sort()).toEqual(['DUNE', 'EMMA']);
      expect(lastStatement(captured)).toBe(PIN_ROOT_RAW_FRAGMENT);
    });
  });

  test('lateral collection: ln.book + ln.book.category + ln.edition', async () => {
    await withCapture('lateral', async (db, captured) => {
      await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            bookName: ln.book!.name,
            bookCategory: ln.book!.category!.name,
            edition: ln.edition!.label,
          })).toList(),
        }))
        .toList();

      expect(lastStatement(captured)).toBe(PIN_LATERAL_COLLECTION);
    });
  });

  test('cte collection: ln.book + ln.book.category + ln.edition', async () => {
    await withCapture('cte', async (db, captured) => {
      await db.nacMembers
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            bookName: ln.book!.name,
            bookCategory: ln.book!.category!.name,
            edition: ln.edition!.label,
          })).toList(),
        }))
        .toList();

      expect(lastStatement(captured)).toBe(PIN_CTE_COLLECTION);
    });
  });

  test('grouped: ln.book', async () => {
    await withCapture('lateral', async (db, captured) => {
      await db.nacLoans
        .select(ln => ({ bookName: ln.book!.name }))
        .groupBy(row => ({ bookName: row.bookName }))
        .select(group => ({ bookName: group.key.bookName, loans: group.count() }))
        .toList();

      expect(lastStatement(captured)).toBe(PIN_GROUPED);
    });
  });

  test('update: where ln.book', async () => {
    await withCapture('lateral', async (db) => {
      const statement = db.nacLoans
        .where(ln => eq(ln.book!.name, 'Dune'))
        .update({ note: 'dune' })
        .toStatement();

      expect(statement.sql).toBe(PIN_UPDATE);
    });
  });
});
