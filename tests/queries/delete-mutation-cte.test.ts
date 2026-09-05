import { describe, test, expect, jest } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { and, eq, sql } from '../../src/query/conditions';
import { inSubquery } from '../../src/query/subquery';
import { DbCteBuilder } from '../../src/query/cte-builder';

/**
 * The delete sibling of the mutation CTE gate: `delete(...).toStatement(selector?)`
 * compiles the fluent DELETE (arbitrary WHERE — including navigation joins via
 * `DELETE … USING` and `inSubquery` targets — plus fragment-capable RETURNING)
 * into `{ sql, params }` without executing, so it can ride a query as a
 * data-modifying CTE via `DbCteBuilder.withMutation`.
 *
 * The canonical consumer is a multi-table purge (e.g. gopass's stale-cart
 * cleanup): child deletes and the parent delete as CTEs of ONE driving select —
 * one statement, zero client-materialized ids, FK-safe CTE order, counts read
 * from the CTEs themselves.
 */
describe('delete mutation CTE (multi-table purge)', () => {
	test('toStatement compiles the fluent delete without executing', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			const statement = db.posts
				.where(p => eq(p.userId, users.alice.id))
				.delete()
				.toStatement(p => ({ id: p.id }));

			expect(statement.sql).toMatch(/^DELETE FROM "posts" WHERE /);
			expect(statement.sql).toContain('RETURNING');
			expect(statement.params).toEqual([users.alice.id]);

			// Nothing executed — Alice's posts are all still there.
			const posts = await db.posts.where(p => eq(p.userId, users.alice.id)).toList();
			expect(posts.length).toBeGreaterThan(0);
		});
	});

	test('navigation-join WHERE compiles to DELETE … USING', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const statement = db.posts
				.where(p => eq(p.user!.email, 'nonexistent@example.com'))
				.delete()
				.toStatement(p => ({ id: p.id }));

			expect(statement.sql).toContain('USING');
		});
	});

	test('navigation RETURNING in toStatement fails loudly', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			expect(() => db.posts
				.where(p => eq(p.userId, 1))
				.delete()
				.toStatement(p => ({ email: p.user!.email })))
				.toThrow(/navigation RETURNING/);
		});
	});

	test('children + parent delete ride ONE statement with a gated driving select', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			// The purge shape: delete the children (posts) and the parent (user)
			// as data-modifying CTEs of ONE select over the parent, gated on the
			// parent CTE so its rows ARE the answer.
			const cteBuilder = new DbCteBuilder();
			const deletedPosts = cteBuilder.withMutation(
				'deleted_posts',
				db.posts
					.where(p => inSubquery(p.userId, db.users.where(u => eq(u.id, users.alice.id)).select(u => u.id).asSubquery()))
					.delete()
					.toStatement(p => ({ id: p.id })),
				{ id: 'id' },
			);
			const deletedUsers = cteBuilder.withMutation(
				'deleted_users',
				db.users
					.where(u => eq(u.id, users.alice.id))
					.delete()
					.toStatement(u => ({ id: u.id })),
				{ id: 'id' },
			);

			const client = (db as any).client;
			const querySpy = jest.spyOn(client, 'query');

			try {
				const rows = await db.users
					.where(u => and(
						eq(u.id, users.alice.id),
						sql`"users"."id" IN (SELECT "id" FROM "deleted_users")`,
					))
					.with(deletedPosts.cte)
					.with(deletedUsers.cte)
					.select(u => ({
						id: u.id,
						deletedPostCount: sql<number>`(SELECT count(*)::int FROM "deleted_posts")`.as('deletedPostCount'),
					}))
					.toList();

				expect(rows).toHaveLength(1);
				expect(rows[0].deletedPostCount).toBe(2);
				expect(querySpy).toHaveBeenCalledTimes(1);

				// The deletes really committed — parent AND children are gone.
				const alice = await db.users.where(u => eq(u.id, users.alice.id)).firstOrDefault();
				expect(alice).toBeNull();
				const posts = await db.posts.where(p => eq(p.userId, users.alice.id)).toList();
				expect(posts).toHaveLength(0);
			} finally {
				querySpy.mockRestore();
			}
		});
	});
});
