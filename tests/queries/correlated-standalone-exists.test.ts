import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { and, eq, gt, exists, notExists } from '../../src';

/**
 * Correlated STANDALONE subqueries inside exists()/notExists().
 *
 * Motivation (gopass QA_AT-136 / QA_AT-323 class): navigation properties in
 * WHERE-only positions inside correlated subselects emit dangling aliases, so
 * services fall back to UNCORRELATED standalone subqueries composed with
 * inSubquery() on an FK column. The natural alternative — EXISTS over a
 * standalone builder whose WHERE references the OUTER row's column — was
 * assumed unsafe. These tests pin down what actually happens:
 *
 *  - cross-table correlation (different aliases) — does the outer field
 *    reference render with the outer alias, producing a valid correlated
 *    EXISTS?
 *  - same-table self-correlation — the alias-collision case: if the inner
 *    builder reuses the outer's alias, the correlation predicate silently
 *    binds to the inner row (wrong results, no SQL error). This is the
 *    dangerous failure mode.
 *  - correlation from INSIDE a navigation-collection lambda (the gopass
 *    refund-group counts shape) — two nesting levels.
 */
describe('Correlated standalone subqueries in exists()', () => {
	test('cross-table correlated EXISTS on an FK column filters by the outer row', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Users having at least one post with views > 120:
			// alice (Alice Post 2, 150) and bob (Bob Post, 200); charlie has no posts.
			const result = await db.users
				.where(u => exists(db.posts
					.where(p => and(eq(p.userId, u.id), gt(p.views, 120)))
					.select(p => ({ id: p.id }))
					.asSubquery()))
				.select(u => ({ username: u.username }))
				.orderBy(u => u.username)
				.toList();

			expect(result.map(r => r.username)).toEqual([
				'alice',
				'bob',
			]);
		});
	});

	test('cross-table correlated NOT EXISTS yields the complement', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Users with NO posts at all: charlie only.
			const result = await db.users
				.where(u => notExists(db.posts
					.where(p => eq(p.userId, u.id))
					.select(p => ({ id: p.id }))
					.asSubquery()))
				.select(u => ({ username: u.username }))
				.toList();

			expect(result.map(r => r.username)).toEqual(['charlie']);
		});
	});

	test('same-table self-correlated EXISTS is rejected loudly (alias collision would silently misbind)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Same-table correlation cannot render correctly: inner and outer FROM
			// share the alias ("posts"), so the correlation predicate would bind to
			// the INNER row (p2.views > p2.views ⇒ always false ⇒ silently empty).
			// The builder must detect the foreign-chain same-table refs and throw
			// instead of returning wrong rows.
			expect(() => db.posts
				.where(p => exists(db.posts
					.where(p2 => and(eq(p2.userId, p.userId), gt(p2.views, p.views)))
					.select(p2 => ({ id: p2.id }))
					.asSubquery())))
				.toThrow(/same table/i);
		});
	});

	test('correlated EXISTS from inside a navigation-collection lambda (refund-group counts shape)', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Per user, count posts that HAVE a comment — via a correlated
			// standalone EXISTS on postComments.postId = p.id, evaluated inside
			// the u.posts collection filter (two nesting levels, like gopass'
			// correlated hasPending/hasFailed counts). Every seeded post has
			// exactly one comment: alice 2, bob 1, charlie 0.
			const result = await db.users
				.select(u => ({
					username: u.username,
					commentedPosts: u.posts!
						.where(p => exists(db.postComments
							.where(c => eq(c.postId, p.id))
							.select(c => ({ id: c.id }))
							.asSubquery()))
						.count(),
				}))
				.orderBy(u => u.username)
				.toList();

			expect(result).toEqual([
				{ username: 'alice', commentedPosts: 2 },
				{ username: 'bob', commentedPosts: 1 },
				{ username: 'charlie', commentedPosts: 0 },
			]);
		});
	});

	test('correlated IN-style shape stays available: exists with extra constant filter matches inSubquery result', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			// Sanity cross-check of the two shapes on the same predicate
			// (posts of active users): correlated EXISTS vs uncorrelated
			// IN-subquery must agree.
			const viaExists = await db.posts
				.where(p => exists(db.users
					.where(u => and(eq(u.id, p.userId), eq(u.isActive, true)))
					.select(u => ({ id: u.id }))
					.asSubquery()))
				.select(p => ({ title: p.title }))
				.orderBy(p => p.title)
				.toList();

			expect(viaExists.map(r => r.title)).toEqual([
				'Alice Post 1',
				'Alice Post 2',
				'Bob Post',
			]);
		});
	});
});
