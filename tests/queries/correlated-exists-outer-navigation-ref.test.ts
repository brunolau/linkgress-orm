import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, and, eq, exists } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * Correlating to the outer row THROUGH one of its navigations.
 *
 * The sibling suite (`correlated-exists-nav-name-collision.test.ts`) covers a correlation on a
 * plain outer COLUMN. This one covers the harder shape: the outer reference is itself a
 * navigation traversal (`l.city!.name`), and the inner table happens to declare a navigation of
 * the SAME property name (`shelf.city`).
 *
 * That combination is what makes it distinct, and worse:
 *
 * - It does NOT need singular table names. The name-collision variant needs a child navigation
 *   named like the parent's TABLE; this one only needs the outer and inner tables to share a
 *   navigation PROPERTY name (`city` on both), which the plural-table convention does nothing
 *   to prevent.
 * - It defeated the first round of guards entirely. Those filter refs by chain identity, but
 *   `ReferenceQueryBuilder` used to mint navigation refs with no identity at all — so
 *   `l.city!.name` was anonymous, indistinguishable from the inner table's own `s.city`, and
 *   every guard waved it through. The subquery then joined its OWN `city` and compared each
 *   shelf's label against ITS city rather than the library's.
 *
 * The fix is on the producer side: a navigation mock row inherits the identity of the row it
 * hangs off (`mintReferenceMockRow`), so a ref reached through the outer row carries the outer
 * chain and a ref reached through the inner row carries the inner one.
 *
 * The fixture makes the two answers DISJOINT rather than merely different — correct is
 * `['Central']`, the defect returns `['Annex']` — so neither can be reached by accident.
 */

class City extends DbEntity {
	id!: DbColumn<number>;
	name!: DbColumn<string>;
}

class Library extends DbEntity {
	id!: DbColumn<number>;
	name!: DbColumn<string>;
	cityId!: DbColumn<number>;

	shelves?: Shelf[];

	/** Same property name as {@link Shelf.city} — the collision under test. */
	city?: City;
}

class Shelf extends DbEntity {
	id!: DbColumn<number>;
	libraryId!: DbColumn<number>;
	cityId!: DbColumn<number>;
	label!: DbColumn<string>;

	/** Same property name as {@link Library.city}. */
	city?: City;
}

class OuterNavRefDatabase extends DbContext {
	get cities(): DbEntityTable<City> {
		return this.table(City);
	}

	get libraries(): DbEntityTable<Library> {
		return this.table(Library);
	}

	get shelves(): DbEntityTable<Shelf> {
		return this.table(Shelf);
	}

	protected override setupModel(model: DbModelConfig): void {
		model.entity(City, entity => {
			entity.toTable('nav_city');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nav_city_id_seq' }));
			entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
		});

		model.entity(Library, entity => {
			entity.toTable('nav_library');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nav_library_id_seq' }));
			entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
			entity.property(e => e.cityId).hasType(integer('city_id')).isRequired();

			entity.hasOne(e => e.city, () => City)
				.withForeignKey(l => l.cityId)
				.withPrincipalKey(c => c.id);

			entity.hasMany(e => e.shelves, () => Shelf)
				.withForeignKey(s => s.libraryId)
				.withPrincipalKey(l => l.id);
		});

		model.entity(Shelf, entity => {
			entity.toTable('nav_shelf');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nav_shelf_id_seq' }));
			entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();
			entity.property(e => e.cityId).hasType(integer('city_id')).isRequired();
			entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();

			entity.hasOne(e => e.city, () => City)
				.withForeignKey(s => s.cityId)
				.withPrincipalKey(c => c.id);
		});
	}
}

describe('Correlating through the outer row\'s own navigation', () => {
	let db: OuterNavRefDatabase;

	beforeAll(async () => {
		(EntityMetadataStore as any).metadata.clear();

		const client = createFreshClient();
		db = new OuterNavRefDatabase(client);

		await client.query(`DROP TABLE IF EXISTS nav_shelf CASCADE`);
		await client.query(`DROP TABLE IF EXISTS nav_library CASCADE`);
		await client.query(`DROP TABLE IF EXISTS nav_city CASCADE`);
		await db.getSchemaManager().ensureCreated();

		const [metro, rural] = await db.cities.insertBulk([
			{ name: 'Metro' },
			{ name: 'Rural' },
		]).returning();

		// Central is in Metro, Annex is in Metro too, and every shelf sits in Rural. The labels
		// are chosen so that matching a shelf's label against the LIBRARY's city and against the
		// SHELF's own city select disjoint sets.
		const [central, annex] = await db.libraries.insertBulk([
			{ name: 'Central', cityId: metro.id },
			{ name: 'Annex', cityId: metro.id },
		]).returning();

		await db.shelves.insertBulk([
			// label = Central's city ('Metro'), but NOT this shelf's own city ('Rural').
			{ libraryId: central.id, cityId: rural.id, label: 'Metro' },
			// label = this shelf's own city ('Rural'), but NOT Annex's city ('Metro').
			{ libraryId: annex.id, cityId: rural.id, label: 'Rural' },
		]);
	});

	afterAll(async () => {
		await (db as any).client.query(`DROP TABLE IF EXISTS nav_shelf CASCADE`);
		await (db as any).client.query(`DROP TABLE IF EXISTS nav_library CASCADE`);
		await (db as any).client.query(`DROP TABLE IF EXISTS nav_city CASCADE`);
		await db.dispose();
	});

	test('an outer navigation reference correlates outward, not to the inner table\'s same-named navigation', async () => {
		const result = await db.libraries
			.where(l => exists(db.shelves
				.where(s => and(eq(s.libraryId, l.id), eq(s.label, l.city!.name)))
				.select(s => ({ id: s.id }))
				.asSubquery()))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		// Central: its shelf is labelled 'Metro', which IS Central's city. Correct → in.
		// Annex:   its shelf is labelled 'Rural', which is the SHELF's city, not Annex's. → out.
		// The defect returns exactly the complement, ['Annex'], by comparing each shelf's label
		// against its own city.
		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('the same shape inside a navigation-collection lambda', async () => {
		const result = await db.libraries
			.where(l => exists(l.shelves!.where(s => eq(s.label, l.city!.name))))
			.select(l => ({ name: l.name }))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => r.name)).toEqual(['Central']);
	});

	test('a collection PROJECTION filtering on its own same-named navigation binds to itself', async () => {
		// `CollectionQueryBuilder.buildCTE` — the path used when a collection appears in a
		// PROJECTION (or as an inline `count()`) — resolved navigation joins from the SELECTOR
		// only, never from the collection's own WHERE. So `s.city` was referenced but never
		// joined inside the collection.
		//
		// Under `lateral` the outer FROM is in scope, so the unjoined `city` silently bound to
		// the OUTER library's city and the filter answered about the wrong row. It was even
		// load-bearing on an unrelated line: projecting `l.city!.name` alongside is what put a
		// `city` join in the outer query for it to latch onto — without that line the same
		// query failed loudly with `missing FROM-clause entry for table "city"`.
		//
		// Every shelf sits in Rural, so filtering on the SHELF's own city keeps both shelves;
		// filtering on the LIBRARY's city (the misbind) would keep only Central's.
		const result = await db.libraries
			.select(l => ({
				name: l.name,
				cityName: l.city!.name,
				shelves: l.shelves!.where(s => eq(s.city!.name, 'Rural')).select(s => ({ label: s.label })).toList(),
			}))
			.orderBy(l => l.name)
			.toList();

		expect(result.map(r => ({ name: r.name, labels: (r.shelves ?? []).map((x: any) => x.label) }))).toEqual([
			{ name: 'Annex', labels: ['Rural'] },
			{ name: 'Central', labels: ['Metro'] },
		]);
	});

	test('the inner table\'s OWN same-named navigation still resolves to itself', async () => {
		// The guard must not overreach: with no correlation in play, `s.city` is the shelf's own
		// navigation and has to be joined and filtered normally.
		const result = await db.shelves
			.where(s => eq(s.city!.name, 'Rural'))
			.select(s => ({ label: s.label }))
			.orderBy(s => s.label)
			.toList();

		expect(result.map(r => r.label)).toEqual([
			'Metro',
			'Rural',
		]);
	});
});
