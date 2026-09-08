import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, boolean, and, eq, exists, notExists } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * Correlated standalone EXISTS where the INNER table declares a hasOne navigation whose
 * PROPERTY NAME is identical to the OUTER table's alias.
 *
 * `tests/queries/correlated-standalone-exists.test.ts` already covers cross-table correlation,
 * but every schema it uses names tables in the plural and navigations in the singular
 * (`users` + `user`), so the two identifiers can never collide. This file supplies the
 * schema shape that DOES collide — a singular parent table (`library`) and a child hasOne
 * navigation of the same name (`shelf.library`) — which is the norm for singular-table
 * schemas.
 *
 * The defect: the subquery resolved the outer reference by looking the alias up in its own
 * `schema.relations`. On a name match it concluded the ref was its own navigation, dropped it
 * from the correlation, and LEFT JOINed a second copy of the parent into the subquery:
 *
 *   EXISTS (SELECT 1 FROM shelf
 *           LEFT JOIN library AS library ON shelf.library_id = library.id   -- invented
 *           WHERE shelf.library_id = library.id AND shelf.is_open)          -- always true
 *
 * The predicate then compared the inner row with itself, so EXISTS was true for every outer
 * row and the filter silently stopped filtering. No SQL error, no type error — only a row
 * count reveals it.
 *
 * Only a hasOne collision misbinds. A hasMany of the same name is not auto-joined into a
 * WHERE, which is why the plural-schema `users.posts` case in the sibling file renders
 * correctly.
 */

class Library extends DbEntity {
	id!: DbColumn<number>;
	name!: DbColumn<string>;
}

class Shelf extends DbEntity {
	id!: DbColumn<number>;
	libraryId!: DbColumn<number>;
	label!: DbColumn<string>;
	isOpen!: DbColumn<boolean>;

	/**
	 * Named `library` on purpose — identical to the parent's TABLE name, which is exactly
	 * the collision under test. Renaming it would make this suite vacuous.
	 */
	library?: Library;
}

class NavNameCollisionDatabase extends DbContext {
	get libraries(): DbEntityTable<Library> {
		return this.table(Library);
	}

	get shelves(): DbEntityTable<Shelf> {
		return this.table(Shelf);
	}

	protected override setupModel(model: DbModelConfig): void {
		model.entity(Library, entity => {
			entity.toTable('library');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'library_id_seq' }));
			entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
		});

		model.entity(Shelf, entity => {
			entity.toTable('shelf');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'shelf_id_seq' }));
			entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();
			entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();
			entity.property(e => e.isOpen).hasType(boolean('is_open')).isRequired();

			entity.hasOne(e => e.library, () => Library)
				.withForeignKey(s => s.libraryId)
				.withPrincipalKey(l => l.id);
		});
	}
}

describe('Correlated EXISTS with an inner navigation named like the outer table', () => {
	let db: NavNameCollisionDatabase;

	beforeAll(async () => {
		(EntityMetadataStore as any).metadata.clear();

		const client = createFreshClient();
		db = new NavNameCollisionDatabase(client);

		await client.query(`DROP TABLE IF EXISTS shelf CASCADE`);
		await client.query(`DROP TABLE IF EXISTS library CASCADE`);
		await db.getSchemaManager().ensureCreated();

		const [central, annex, empty] = await db.libraries.insertBulk([
			{ name: 'Central' },
			{ name: 'Annex' },
			{ name: 'Empty' },
		]).returning();

		// One library qualifies, one has only a shelf that fails the inner predicate, one has
		// no children at all. All three are needed: with only qualifying rows the assertion
		// cannot tell a working correlation from one that matches everything.
		await db.shelves.insertBulk([
			{ libraryId: central.id, label: 'Central Open', isOpen: true },
			{ libraryId: annex.id, label: 'Annex Closed', isOpen: false },
		]);

		void empty;
	});

	afterAll(async () => {
		await (db as any).client.query(`DROP TABLE IF EXISTS shelf CASCADE`);
		await (db as any).client.query(`DROP TABLE IF EXISTS library CASCADE`);
		await db.dispose();
	});

	test('EXISTS correlates to the outer row instead of self-joining the inner navigation', async () => {
		const result = await db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.isOpen, true)))
				.select(s => ({ id: s.id }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		// Only Central. The defect returned all three: the correlation degenerated into
		// `shelf.library_id = library.id` against a freshly joined inner `library`, which is
		// the join condition itself and therefore true wherever any open shelf exists.
		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('NOT EXISTS yields the exact complement', async () => {
		const result = await db.libraries
			.where(l => notExists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.isOpen, true)))
				.select(s => ({ id: s.id }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		// Pins the other direction, so a "fix" that merely inverts the misbinding — or drops
		// the predicate — cannot satisfy both tests at once.
		expect(result.map(r => r.name)).toEqual([
			'Annex',
			'Empty',
		]);
	});

	test('correlating AND traversing the same-named navigation is rejected loudly', async () => {
		// The one shape that genuinely cannot be rendered: the subquery correlates to the
		// outer `library` AND traverses its own `library` navigation, so both want the same
		// alias in one scope. The inner join would shadow the outer table and the correlation
		// would bind to the inner row — the same silent misbinding the same-table guard
		// refuses. Fail loudly instead, and say what to do about it.
		await expect(db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.library!.name, 'Central')))
				.select(s => ({ id: s.id }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.toList())
			.rejects
			.toThrow(/would shadow the outer table/i);
	});

	test('traversing the navigation without correlating on it still works', async () => {
		// The guard must be narrow: using the inner `library` navigation on its own — no
		// correlation to an outer table of the same name — is unaffected.
		const result = await db.shelves
			.where(s => eq(s.library!.name, 'Central'))
			.select(s => ({ label: s.label }))
			.orderBy(s => s.label)
			.toList();

		expect(result.map(r => r.label)).toEqual(['Central Open']);
	});
});
