import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, inSubquery, isNull } from '../../src';

/**
 * joinFilter / leftJoinFilter — joins used purely as row FILTERS.
 *
 * Unlike innerJoin/leftJoin they take no selector: the entity/selection shape
 * is preserved, so scope-style predicates can hop across an N:1 FK inside ONE
 * query level (the gopass partner-scope shape: order_item ⋈
 * invoicing_partner_data ON fk AND partner IN (...)) and the builder stays
 * composable (where/orderBy/limit/count/asSubquery).
 */
describe('joinFilter / leftJoinFilter', () => {
	test('joinFilter keeps the entity shape and filters by the joined table (N:1, no row duplication)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// posts ⋈ users (N:1) filtered to active authors — all 3 seeded posts
			// have active authors; each post appears exactly ONCE (N:1 join).
			const result = await db.posts
				.joinFilter(
					db.users,
					(p, u) => eq(u.id, p.userId),
					(_p, u) => eq(u.isActive, true),
				)
				.orderBy(p => p.title)
				.select(p => ({ title: p.title, views: p.views }))
				.toList();

			expect(result.map(r => r.title)).toEqual([
				'Alice Post 1',
				'Alice Post 2',
				'Bob Post',
			]);
		});
	});

	test('joinFilter with the predicate inside ON behaves identically', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Same predicate expressed inside the ON condition (INNER join makes
			// ON and WHERE placement equivalent).
			const result = await db.posts
				.joinFilter(db.users, (p, u) => eq(u.id, p.userId))
				.where(p => gt(p.views, 120))
				.select(p => ({ title: p.title }))
				.orderBy(p => p.title)
				.toList();

			expect(result.map(r => r.title)).toEqual([
				'Alice Post 2',
				'Bob Post',
			]);
		});
	});

	test('leftJoinFilter + IS NULL filter is the anti-join (users with NO posts)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const result = await db.users
				.leftJoinFilter(
					db.posts,
					(u, p) => eq(p.userId, u.id),
					(_u, p) => isNull(p.id),
				)
				.select(u => ({ username: u.username }))
				.toList();

			expect(result.map(r => r.username)).toEqual(['charlie']);
		});
	});

	test('count() honors the filter-join (aggregate path renders manual joins)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const active = await db.posts
				.joinFilter(
					db.users,
					(p, u) => eq(u.id, p.userId),
					(_p, u) => eq(u.isActive, true),
				)
				.count();

			const inactive = await db.posts
				.joinFilter(
					db.users,
					(p, u) => eq(u.id, p.userId),
					(_p, u) => eq(u.isActive, false),
				)
				.count();

			expect(active).toBe(3);
			expect(inactive).toBe(0);
		});
	});

	test('filter-joined query composes as a standalone subquery (gopass scope-filter shape)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// users visible through "has a post whose author is active" — the
			// subquery is a filter-joined FLAT query (single level, no nested IN).
			const visibleUserIds = db.posts
				.joinFilter(
					db.users,
					(p, u) => eq(u.id, p.userId),
					(_p, u) => eq(u.isActive, true),
				)
				.select(p => p.userId)
				.asSubquery('array');

			const result = await db.users
				.where(u => inSubquery(u.id, visibleUserIds))
				.select(u => ({ username: u.username }))
				.orderBy(u => u.username)
				.toList();

			expect(result.map(r => r.username)).toEqual([
				'alice',
				'bob',
			]);
		});
	});

	test('joinFilter directly off the table (no prior where) works', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const result = await db.posts
				.joinFilter(
					db.users,
					(p, u) => eq(u.id, p.userId),
					(_p, u) => eq(u.username, 'alice'),
				)
				.where(p => gt(p.views, 0))
				.select(p => ({ title: p.title }))
				.orderBy(p => p.title)
				.toList();

			expect(result.map(r => r.title)).toEqual([
				'Alice Post 1',
				'Alice Post 2',
			]);
		});
	});
});
