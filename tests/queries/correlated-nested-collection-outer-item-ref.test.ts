import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, boolean, and, eq, exists } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * A NESTED collection correlating to the ENCLOSING collection's item through one of that item's
 * navigations.
 *
 * Per loan line, project the reader's active pass — but only when the LINE's book is in a
 * lendable genre:
 *
 *   loan.lines.select(line => ({
 *     pass: line.reader.passes.where(p => and(eq(p.active, true), eq(line.book.genre.lendable, true))),
 *   }))
 *
 * `line.book.genre` belongs to the ENCLOSING item, while `pass` declares a `genre` navigation of its
 * own. A collection told its own refs from outer ones by whether a ref carries a chain id — and the
 * rows a collection mints carried none. So a ref reached through the enclosing collection's item
 * (`line`) was indistinguishable from one of the pass collection's own, and once collection
 * where-navigations were resolved on the projection path as well, the pass subquery joined its OWN
 * `genre` and filtered every pass by the pass's genre instead of the line's book's. No error.
 *
 * The fixture makes the answers DISJOINT — correct is L1 → Ada's pass, L2 → none; the misbind
 * returns L1 → none, L2 → Bo's pass — so neither can be reached by accident.
 */

class NcGenre extends DbEntity {
	id!: DbColumn<number>;
	name!: DbColumn<string>;
	lendable!: DbColumn<boolean>;
}

class NcBook extends DbEntity {
	id!: DbColumn<number>;
	title!: DbColumn<string>;
	genreId!: DbColumn<number>;

	/** Same property name as {@link NcPass.genre} — the collision under test. */
	genre?: NcGenre;
}

class NcPass extends DbEntity {
	id!: DbColumn<number>;
	readerId!: DbColumn<number>;
	active!: DbColumn<boolean>;
	genreId!: DbColumn<number>;

	/** Same property name as {@link NcBook.genre}. */
	genre?: NcGenre;
}

class NcReader extends DbEntity {
	id!: DbColumn<number>;
	name!: DbColumn<string>;

	passes?: NcPass[];
}

class NcLoanLine extends DbEntity {
	id!: DbColumn<number>;
	loanId!: DbColumn<number>;
	bookId!: DbColumn<number>;
	readerId!: DbColumn<number>;

	book?: NcBook;
	reader?: NcReader;
}

class NcLoan extends DbEntity {
	id!: DbColumn<number>;
	label!: DbColumn<string>;

	lines?: NcLoanLine[];
}

class NestedOuterNavDatabase extends DbContext {
	get genres(): DbEntityTable<NcGenre> {
		return this.table(NcGenre);
	}

	get books(): DbEntityTable<NcBook> {
		return this.table(NcBook);
	}

	get passes(): DbEntityTable<NcPass> {
		return this.table(NcPass);
	}

	get readers(): DbEntityTable<NcReader> {
		return this.table(NcReader);
	}

	get loanLines(): DbEntityTable<NcLoanLine> {
		return this.table(NcLoanLine);
	}

	get loans(): DbEntityTable<NcLoan> {
		return this.table(NcLoan);
	}

	protected override setupModel(model: DbModelConfig): void {
		model.entity(NcGenre, entity => {
			entity.toTable('ncor_genre');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_genre_id_seq' }));
			entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
			entity.property(e => e.lendable).hasType(boolean('lendable')).isRequired();
		});

		model.entity(NcBook, entity => {
			entity.toTable('ncor_book');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_book_id_seq' }));
			entity.property(e => e.title).hasType(varchar('title', 100)).isRequired();
			entity.property(e => e.genreId).hasType(integer('genre_id')).isRequired();

			entity.hasOne(e => e.genre, () => NcGenre)
				.withForeignKey(b => b.genreId)
				.withPrincipalKey(g => g.id);
		});

		model.entity(NcPass, entity => {
			entity.toTable('ncor_pass');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_pass_id_seq' }));
			entity.property(e => e.readerId).hasType(integer('reader_id')).isRequired();
			entity.property(e => e.active).hasType(boolean('active')).isRequired();
			entity.property(e => e.genreId).hasType(integer('genre_id')).isRequired();

			entity.hasOne(e => e.genre, () => NcGenre)
				.withForeignKey(p => p.genreId)
				.withPrincipalKey(g => g.id);
		});

		model.entity(NcReader, entity => {
			entity.toTable('ncor_reader');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_reader_id_seq' }));
			entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();

			entity.hasMany(e => e.passes, () => NcPass)
				.withForeignKey(p => p.readerId)
				.withPrincipalKey(r => r.id);
		});

		model.entity(NcLoanLine, entity => {
			entity.toTable('ncor_loan_line');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_loan_line_id_seq' }));
			entity.property(e => e.loanId).hasType(integer('loan_id')).isRequired();
			entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
			entity.property(e => e.readerId).hasType(integer('reader_id')).isRequired();

			entity.hasOne(e => e.book, () => NcBook)
				.withForeignKey(l => l.bookId)
				.withPrincipalKey(b => b.id);

			entity.hasOne(e => e.reader, () => NcReader)
				.withForeignKey(l => l.readerId)
				.withPrincipalKey(r => r.id);
		});

		model.entity(NcLoan, entity => {
			entity.toTable('ncor_loan');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ncor_loan_id_seq' }));
			entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();

			entity.hasMany(e => e.lines, () => NcLoanLine)
				.withForeignKey(l => l.loanId)
				.withPrincipalKey(l => l.id);
		});
	}
}

const TABLES = ['ncor_loan_line', 'ncor_loan', 'ncor_pass', 'ncor_reader', 'ncor_book', 'ncor_genre'];

const firstPassPerLoan = (rows: any[]): Array<{ label: string; pass: number | null }> =>
	rows.map(r => ({ label: r.label, pass: r.lines?.[0]?.pass?.id ?? null }));

describe('A nested collection correlating through the ENCLOSING collection item\'s navigation', () => {
	let db: NestedOuterNavDatabase;
	let adaPassId: number;
	let boPassId: number;

	beforeAll(async () => {
		(EntityMetadataStore as any).metadata.clear();

		const client = createFreshClient();
		db = new NestedOuterNavDatabase(client, { collectionStrategy: 'lateral' });

		for (const table of TABLES) {
			await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
		}
		await db.getSchemaManager().ensureCreated();

		const [lendable, restricted] = await db.genres.insertBulk([
			{ name: 'Fiction', lendable: true },
			{ name: 'Reference', lendable: false },
		]).returning();
		const [novel, atlas] = await db.books.insertBulk([
			{ title: 'Novel', genreId: lendable.id },
			{ title: 'Atlas', genreId: restricted.id },
		]).returning();
		const [ada, bo] = await db.readers.insertBulk([
			{ name: 'Ada' },
			{ name: 'Bo' },
		]).returning();

		// Each reader's pass sits in the OTHER genre than the book they borrow, so filtering by the
		// LINE's book genre and by the PASS's own genre select disjoint passes.
		const [adaPass, boPass] = await db.passes.insertBulk([
			// Ada borrows the lendable Novel; her pass's own genre is NOT lendable.
			{ readerId: ada.id, active: true, genreId: restricted.id },
			// Bo borrows the restricted Atlas; his pass's own genre IS lendable.
			{ readerId: bo.id, active: true, genreId: lendable.id },
		]).returning();
		adaPassId = adaPass.id;
		boPassId = boPass.id;

		const [l1, l2] = await db.loans.insertBulk([
			{ label: 'L1' },
			{ label: 'L2' },
		]).returning();
		await db.loanLines.insertBulk([
			{ loanId: l1.id, bookId: novel.id, readerId: ada.id },
			{ loanId: l2.id, bookId: atlas.id, readerId: bo.id },
		]);
	});

	afterAll(async () => {
		for (const table of TABLES) {
			await (db as any).client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
		}
		await db.dispose();
	});

	test('binds to the ENCLOSING item\'s navigation when that navigation is also projected', async () => {
		const rows = await db.loans
			.select(ln => ({
				label: ln.label,
				lines: ln.lines!.select(line => ({
					bookLendable: line.book!.genre!.lendable,
					pass: line.reader!.passes!
						.where(p => and(eq(p.active, true), eq(line.book!.genre!.lendable, true)))
						.select(p => ({ id: p.id }))
						.firstOrDefault('pass'),
				})).toList('lines'),
			}))
			.orderBy(ln => ln.label)
			.toList();

		// L1: Novel is lendable → Ada's pass. L2: Atlas is not → none.
		// The misbind filters each pass by its OWN genre and returns exactly the complement.
		expect(firstPassPerLoan(rows)).toEqual([
			{ label: 'L1', pass: adaPassId },
			{ label: 'L2', pass: null },
		]);
	});

	test('binds to the ENCLOSING item\'s navigation when nothing else projects it — the parent joins what the correlation needs', async () => {
		const rows = await db.loans
			.select(ln => ({
				label: ln.label,
				lines: ln.lines!.select(line => ({
					pass: line.reader!.passes!
						.where(p => and(eq(p.active, true), eq(line.book!.genre!.lendable, true)))
						.select(p => ({ id: p.id }))
						.firstOrDefault('pass'),
				})).toList('lines'),
			}))
			.orderBy(ln => ln.label)
			.toList();

		expect(firstPassPerLoan(rows)).toEqual([
			{ label: 'L1', pass: adaPassId },
			{ label: 'L2', pass: null },
		]);
	});

	test('an inline aggregate over the nested collection binds the same way', async () => {
		const rows = await db.loans
			.select(ln => ({
				label: ln.label,
				lines: ln.lines!.select(line => ({
					lendablePasses: line.reader!.passes!
						.where(p => and(eq(p.active, true), eq(line.book!.genre!.lendable, true)))
						.count(),
				})).toList('lines'),
			}))
			.orderBy(ln => ln.label)
			.toList();

		expect(rows.map((r: any) => ({ label: r.label, count: Number(r.lines?.[0]?.lendablePasses ?? -1) }))).toEqual([
			{ label: 'L1', count: 1 },
			{ label: 'L2', count: 0 },
		]);
	});

	test('a nested EXISTS inside the enclosing collection\'s WHERE binds the same way', async () => {
		// The enclosing collection's own WHERE has to join what the nested correlation needs —
		// the EXISTS render path, no projection involved.
		const rows = await db.loans
			.where(ln => exists(ln.lines!.where(line => exists(line.reader!.passes!
				.where(p => and(eq(p.active, true), eq(line.book!.genre!.lendable, true)))))))
			.select(ln => ({ label: ln.label }))
			.orderBy(ln => ln.label)
			.toList();

		// Only L1's line has a matching pass (Ada's, via the lendable Novel).
		expect(rows.map((r: any) => r.label)).toEqual(['L1']);
	});

	test('the nested collection\'s OWN same-named navigation still binds to itself', async () => {
		// The fix must not overreach: `p.genre` IS the pass's own navigation and has to be joined
		// inside the pass subquery and filtered there.
		const rows = await db.loans
			.select(ln => ({
				label: ln.label,
				lines: ln.lines!.select(line => ({
					pass: line.reader!.passes!
						.where(p => and(eq(p.active, true), eq(p.genre!.lendable, true)))
						.select(p => ({ id: p.id }))
						.firstOrDefault('pass'),
				})).toList('lines'),
			}))
			.orderBy(ln => ln.label)
			.toList();

		// Ada's pass is in the restricted genre, Bo's in the lendable one.
		expect(firstPassPerLoan(rows)).toEqual([
			{ label: 'L1', pass: null },
			{ label: 'L2', pass: boPassId },
		]);
	});
});
