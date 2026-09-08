import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, boolean, and, eq, exists, notExists, sql } from '../../src';
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

	shelves?: Shelf[];
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

			entity.hasMany(e => e.shelves, () => Shelf)
				.withForeignKey(s => s.libraryId)
				.withPrincipalKey(l => l.id);
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
			// Label deliberately equal to its OWN library's name, and to no other's. It is what
			// makes a `shelf.label = library.name` correlation discriminating: matched against
			// the outer row it selects Central alone, matched against the inner row (the defect)
			// it is true for every library.
			{ libraryId: central.id, label: 'Central', isOpen: false },
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

	test('an outer reference in the subquery SELECT does not drag in a join either', async () => {
		// The third harvest site: `collectTableAliasesFromSelection`. Even with the WHERE
		// correlating correctly, naming an outer column in the SELECT used to resolve `library`
		// against the subquery's own relations and join a second copy — which then shadowed the
		// outer table and rebound the WHERE to the inner row. EXISTS ignores the select list, so
		// the row set is the only thing that shows it.
		const result = await db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.isOpen, true)))
				.select(s => ({ id: s.id, outerName: l.name }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('a NAVIGATION-COLLECTION exists is unaffected — it correlates through the navigation', async () => {
		// The shape production code should reach for, and the regression guard for the fix: a
		// collection lambda names no outer column at all, so the correlation is implicit in the
		// navigation and there is nothing to mis-resolve. It renders as a bare
		// `EXISTS (SELECT 1 FROM shelf WHERE shelf.library_id = library.id AND …)` with no
		// invented join — the same before and after the fix.
		const result = await db.libraries
			.where(l => exists(l.shelves!.where(s => eq(s.isOpen, true))))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	// The SECOND join-detection path: a collection lambda's WHERE. `CollectionQueryBuilder`
	// mints no chain identity of its own, so "carries an id at all" is what marks a ref as a
	// correlation there — and it is the only signal that can, since an inner navigation
	// traversal (`s.library.name`) renders under the very same alias as the outer row
	// (`l.name`). Both cases below misbound before the fix and returned every library.
	test('collection lambda correlating on the outer key resolves to the outer row', async () => {
		const result = await db.libraries
			.where(l => exists(l.shelves!.where(s => and(eq(s.libraryId, l.id), eq(s.isOpen, true)))))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('collection lambda comparing to an outer non-key column resolves to the outer row', async () => {
		const result = await db.libraries
			.where(l => exists(l.shelves!.where(s => eq(s.label, l.name))))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		// Only Central has a shelf labelled after itself. The defect compared the inner row with
		// itself, so that one shelf satisfied the predicate for EVERY library and all three came
		// back.
		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('a GROUPED correlated subquery resolves its outer reference outward', async () => {
		// The fourth harvest site: `GroupedQueryBuilder` keeps its own copies of the
		// alias-collection helpers. A grouped query can become a correlated subquery via
		// `asSubquery()`, so the same collision is reachable there.
		const result = await db.libraries
			.where(l => exists(db.shelves
				.where(s => eq(s.libraryId, l.id))
				.select(s => ({ libraryId: s.libraryId, isOpen: s.isOpen }))
				.groupBy(s => ({ libraryId: s.libraryId }))
				.select(g => ({ libraryId: g.key.libraryId }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		// Central and Annex have shelves; Empty has none.
		expect(result.map(r => r.name)).toEqual([
			'Annex',
			'Central',
		]);
	});

	test('an outer reference inside a sql`` fragment of a GROUPED projection correlates outward', async () => {
		// `GroupedQueryBuilder` keeps its own copy of the selection collector, and its
		// SqlFragment branch was the one loop the first sweep left unguarded: the top-level
		// check sees the FRAGMENT (which carries no chain id) and the loop inside then harvested
		// the outer ref's alias unguarded.
		const result = await db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.isOpen, true)))
				.select(s => ({ libraryId: s.libraryId, tag: sql`upper(${l.name})` }))
				.groupBy(g => ({ libraryId: g.libraryId }))
				.select(g => ({ libraryId: g.key.libraryId }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('the shadow clash is refused in the GROUPED path too', async () => {
		// Adding `.groupBy()` must not turn the loud refusal back into a silent wrong answer.
		await expect(db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.library!.name, 'Central')))
				.select(s => ({ libraryId: s.libraryId }))
				.groupBy(g => ({ libraryId: g.libraryId }))
				.select(g => ({ libraryId: g.key.libraryId }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.toList())
			.rejects
			.toThrow(/would shadow the outer table/i);
	});

	test('the shadow clash is refused in a COLLECTION lambda too', async () => {
		// A collection's correlation is implicit (`shelf.library_id = library.id`), so it is
		// ALWAYS present — traversing an own navigation named like the parent shadows it every
		// time. The same logical query must not throw on the standalone path and misbind here.
		await expect(db.libraries
			.where(l => exists(l.shelves!.where(s => eq(s.library!.name, 'Central'))))
			.select(l => ({ name: l.name }))
			.toList())
			.rejects
			.toThrow(/would shadow the outer table/i);
	});

	test('the shadow clash is refused when the own navigation appears only in the SELECT list', async () => {
		// The refusal used to inspect only the WHERE, so naming the colliding navigation in the
		// projection slipped past it and misbound silently. EXISTS ignores the select list, which
		// is exactly why nothing else would have caught it.
		await expect(db.libraries
			.where(l => exists(db.shelves
				.where(s => eq(s.libraryId, l.id))
				.select(s => ({ id: s.id, libName: s.library!.name }))
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

		expect(result.map(r => r.label)).toEqual([
			'Central',
			'Central Open',
		]);
	});
});
