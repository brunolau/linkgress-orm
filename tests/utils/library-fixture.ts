import { createFreshClient } from './test-database';
import {
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  integer,
  varchar,
} from '../../src';
import type { CollectionStrategyType } from '../../src/query/collection-strategy.interface';

/**
 * A lending library where every navigation PATH yields a different value, shared by the suites that
 * pin how navigations are joined and read: inside collections under every strategy, in ORDER BY, in
 * insert / upsert RETURNING, in a collection's correlation, and nested aggregates.
 *
 *   category <- book <- edition <- loan -> member
 *                 ^                  |      |
 *                 +------ own book --+      +-> favorite book
 *
 * Relations: book.category, book.editions, category.books, edition.book, edition.category,
 * edition.loans, loan.member, loan.edition, loan.book (the loan's OWN book — the relation name
 * `edition` carries too), member.loans, member.favoriteBook.
 *
 *   loan  member  own book  own book's category  edition  edition's book  its category  edition's category
 *   L1    Ada     Dune      Sci-fi               E-1      Emma            Classics      Hardback line
 *   L2    Ada     Emma      Classics             E-2      Dune            Sci-fi        Paperback line
 *   L3    Bo      Emma      Classics             E-3      Dune            Sci-fi        Hardback line
 *
 * Members: Ada (favorite Emma), Bo (favorite Dune), Cy (no favorite, no loans).
 *
 *   edition  book  category          held by
 *   E-1      Emma  Hardback line     L1
 *   E-2      Dune  Paperback line    L2
 *   E-3      Dune  Hardback line     L3
 *   E-4      Emma  Paperback line    -
 *   E-5      Dune  Paperback line    -
 *
 * so Dune has three editions and Emma two: a count over `ln.book.editions` and one over
 * `ln.edition.book.editions` differ for every loan. Categories "Hardback line" and "Paperback line"
 * have no books.
 *
 * A second book → category relation is keyed on a NON-id principal key: categories carry a `code`
 * (SF, CL, HB, PB) and books a `categoryCode`, deliberately pointing at the OTHER category than
 * `categoryId` does — Dune is coded CL (Classics), Emma SF (Sci-fi). So `category.booksByCode` and
 * `book.categoryByCode` differ from `category.books` / `book.category`, and a join on `id` instead of
 * `code` cannot pass by accident.
 *
 * Every loan's own book differs from its edition's book, and ordering by either one gives a
 * different row order, so neither a collapsed / re-parented join nor an ignored ORDER BY can pass
 * an assertion by accident.
 */

export class LibCategory extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  code?: DbColumn<string | null>;

  books?: LibBook[];
  booksByCode?: LibBook[];
}

export class LibBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  categoryId!: DbColumn<number>;
  categoryCode?: DbColumn<string | null>;

  category?: LibCategory;
  categoryByCode?: LibCategory;
  editions?: LibEdition[];
}

export class LibEdition extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  bookId!: DbColumn<number>;
  categoryId!: DbColumn<number>;

  book?: LibBook;
  category?: LibCategory;
  loans?: LibLoan[];
}

export class LibMember extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  favoriteBookId?: DbColumn<number | null>;

  favoriteBook?: LibBook;
  loans?: LibLoan[];
}

export class LibLoan extends DbEntity {
  id!: DbColumn<number>;
  memberId!: DbColumn<number>;
  editionId!: DbColumn<number>;
  bookId!: DbColumn<number>;
  note!: DbColumn<string>;

  member?: LibMember;
  edition?: LibEdition;
  book?: LibBook;
}

export class LibraryDatabase extends DbContext {
  get libCategories(): DbEntityTable<LibCategory> {
    return this.table(LibCategory);
  }

  get libBooks(): DbEntityTable<LibBook> {
    return this.table(LibBook);
  }

  get libEditions(): DbEntityTable<LibEdition> {
    return this.table(LibEdition);
  }

  get libMembers(): DbEntityTable<LibMember> {
    return this.table(LibMember);
  }

  get libLoans(): DbEntityTable<LibLoan> {
    return this.table(LibLoan);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(LibCategory, entity => {
      entity.toTable('lib_categories');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lib_categories_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 8));

      entity.hasMany(e => e.books, () => LibBook)
        .withForeignKey(b => b.categoryId)
        .withPrincipalKey(c => c.id);

      // Keyed on the category CODE, not its id (no FK constraint: `code` is not a key column)
      entity.hasMany(e => e.booksByCode, () => LibBook)
        .withForeignKey(b => b.categoryCode!)
        .withPrincipalKey(c => c.code!)
        .isInverseNavigation();
    });

    model.entity(LibBook, entity => {
      entity.toTable('lib_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lib_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.categoryId).hasType(integer('category_id')).isRequired();
      entity.property(e => e.categoryCode).hasType(varchar('category_code', 8));

      entity.hasOne(e => e.category, () => LibCategory)
        .withForeignKey(b => b.categoryId)
        .withPrincipalKey(c => c.id);

      entity.hasOne(e => e.categoryByCode, () => LibCategory)
        .withForeignKey(b => b.categoryCode!)
        .withPrincipalKey(c => c.code!)
        .isInverseNavigation();

      entity.hasMany(e => e.editions, () => LibEdition)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);
    });

    model.entity(LibEdition, entity => {
      entity.toTable('lib_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lib_editions_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.categoryId).hasType(integer('category_id')).isRequired();

      entity.hasOne(e => e.book, () => LibBook)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);

      entity.hasOne(e => e.category, () => LibCategory)
        .withForeignKey(ed => ed.categoryId)
        .withPrincipalKey(c => c.id);

      entity.hasMany(e => e.loans, () => LibLoan)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);
    });

    model.entity(LibMember, entity => {
      entity.toTable('lib_members');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lib_members_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.favoriteBookId).hasType(integer('favorite_book_id'));

      entity.hasOne(e => e.favoriteBook, () => LibBook)
        .withForeignKey(m => m.favoriteBookId!)
        .withPrincipalKey(b => b.id);

      entity.hasMany(e => e.loans, () => LibLoan)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(m => m.id);
    });

    model.entity(LibLoan, entity => {
      entity.toTable('lib_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lib_loans_id_seq' }));
      entity.property(e => e.memberId).hasType(integer('member_id')).isRequired();
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 100)).isRequired();

      entity.hasOne(e => e.member, () => LibMember)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(m => m.id);

      entity.hasOne(e => e.edition, () => LibEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);

      // The loan's own book — the same relation NAME the edition carries
      entity.hasOne(e => e.book, () => LibBook)
        .withForeignKey(ln => ln.bookId)
        .withPrincipalKey(b => b.id);
    });
  }
}

export interface LibraryIds {
  sciFi: number;
  classics: number;
  hardback: number;
  paperback: number;
  dune: number;
  emma: number;
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  e5: number;
  ada: number;
  bo: number;
  cy: number;
  l1: number;
  l2: number;
  l3: number;
}

export const LIBRARY_STRATEGIES: readonly CollectionStrategyType[] = ['lateral', 'cte', 'temptable'];

export interface LibraryFixture {
  db: LibraryDatabase;
  client: DatabaseClient;
  ids: LibraryIds;
  /** Every statement the context logged, in order (logQueries is on). */
  captured: string[];
  /** The logged statements, without the logger's `[SQL Query]` headers. */
  statements(): string[];
  /** The last logged statement that contains `keyword` (default: the last one). */
  lastStatement(keyword?: string): string;
  /** Drops every captured statement (call before the query a test inspects). */
  resetCapture(): void;
}

const TABLES = ['lib_loans', 'lib_members', 'lib_editions', 'lib_books', 'lib_categories'];

async function dropTables(client: DatabaseClient): Promise<void> {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

/** Seeds the library described in the module comment; ids come from the database. */
export async function seedLibrary(db: LibraryDatabase): Promise<LibraryIds> {
  const [sciFi, classics, hardback, paperback] = await db.libCategories.insertBulk([
    { name: 'Sci-fi', code: 'SF' },
    { name: 'Classics', code: 'CL' },
    { name: 'Hardback line', code: 'HB' },
    { name: 'Paperback line', code: 'PB' },
  ]).returning();

  // Each book's code points at the OTHER category than its categoryId
  const [dune, emma] = await db.libBooks.insertBulk([
    { name: 'Dune', categoryId: sciFi.id, categoryCode: 'CL' },
    { name: 'Emma', categoryId: classics.id, categoryCode: 'SF' },
  ]).returning();

  const [e1, e2, e3, e4, e5] = await db.libEditions.insertBulk([
    { label: 'E-1', bookId: emma.id, categoryId: hardback.id },
    { label: 'E-2', bookId: dune.id, categoryId: paperback.id },
    { label: 'E-3', bookId: dune.id, categoryId: hardback.id },
    { label: 'E-4', bookId: emma.id, categoryId: paperback.id },
    { label: 'E-5', bookId: dune.id, categoryId: paperback.id },
  ]).returning();

  const [ada, bo, cy] = await db.libMembers.insertBulk([
    { name: 'Ada', favoriteBookId: emma.id },
    { name: 'Bo', favoriteBookId: dune.id },
    { name: 'Cy', favoriteBookId: null },
  ]).returning();

  const [l1, l2, l3] = await db.libLoans.insertBulk([
    { memberId: ada.id, editionId: e1.id, bookId: dune.id, note: 'first' },
    { memberId: ada.id, editionId: e2.id, bookId: emma.id, note: 'second' },
    { memberId: bo.id, editionId: e3.id, bookId: emma.id, note: 'third' },
  ]).returning();

  return {
    sciFi: sciFi.id,
    classics: classics.id,
    hardback: hardback.id,
    paperback: paperback.id,
    dune: dune.id,
    emma: emma.id,
    e1: e1.id,
    e2: e2.id,
    e3: e3.id,
    e4: e4.id,
    e5: e5.id,
    ada: ada.id,
    bo: bo.id,
    cy: cy.id,
    l1: l1.id,
    l2: l2.id,
    l3: l3.id,
  };
}

/**
 * Creates the schema on a fresh client and seeds it. The context logs every statement it runs;
 * `strategy` is its default collection strategy (a query can still override it with
 * `withQueryOptions({ collectionStrategy })`).
 */
export async function createLibraryFixture(strategy: CollectionStrategyType = 'lateral'): Promise<LibraryFixture> {
  const client = createFreshClient();
  const captured: string[] = [];
  const db = new LibraryDatabase(client, {
    logQueries: true,
    logParameters: false,
    collectionStrategy: strategy,
    logger: (message: string) => {
      captured.push(message);
    },
  });

  await dropTables(client);
  await db.getSchemaManager().ensureCreated();
  const ids = await seedLibrary(db);
  captured.length = 0;

  const statements = (): string[] => captured.filter(entry => !entry.trimStart().startsWith('['));

  return {
    db,
    client,
    ids,
    captured,
    statements,
    lastStatement(keyword?: string) {
      const all = statements();

      for (let i = all.length - 1; i >= 0; i--) {
        if (keyword === undefined || all[i].includes(keyword)) {
          return all[i];
        }
      }

      throw new Error(keyword === undefined ? 'No statement was captured' : `No captured statement contains ${keyword}`);
    },
    resetCapture() {
      captured.length = 0;
    },
  };
}

export async function disposeLibraryFixture(fixture: LibraryFixture | undefined): Promise<void> {
  if (!fixture) {
    return;
  }

  await dropTables(fixture.client);
  await fixture.db.dispose();
}

/** Rows sorted by `id`, so assertions do not depend on the row order a query did not ask for. */
export const byId = <T extends { id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.id - b.id);
