import { describe, test, expect, jest } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { and, eq, ne, sql } from '../../src/query/conditions';
import { DbCteBuilder } from '../../src/query/cte-builder';

/**
 * Mutation-gated SELECT — the two pieces that let a compare-and-swap UPDATE and
 * the full row load ride ONE statement:
 *
 *  - `update(...).toStatement(returningSelector?)` — compile the fluent UPDATE
 *    (arbitrary WHERE condition, SqlFragment SET values, fragment-capable
 *    RETURNING) into `{ sql, params }` WITHOUT executing it;
 *  - `DbCteBuilder.withMutation(name, statement, columns)` — wrap that compiled
 *    DML as a named data-modifying CTE (param offsets managed by the builder),
 *    attachable to any query via the existing `.with(cte)`.
 *
 * Semantics under PostgreSQL's data-modifying-CTE rules, pinned below:
 *  - the outer SELECT reading the TABLE sees the PRE-update snapshot (the
 *    "load" half keeps load semantics);
 *  - the gate CTE's RETURNING exposes the POST-update values (scalar
 *    subselects);
 *  - the mutation executes exactly once even when the outer query matches
 *    nothing — and gating the outer WHERE on the CTE makes "0 rows" mean
 *    "the CAS lost", with no update applied.
 */
describe('mutation CTE gate (CAS-gated load)', () => {
	test('toStatement compiles the fluent update without executing', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			const statement = db.users
				.where(u => and(eq(u.id, users.alice.id), ne(u.age, 999)))
				.update({ age: sql`"age" + ${5}::int` })
				.toStatement(u => ({ id: u.id, age: u.age }));

			expect(statement.sql).toMatch(/^UPDATE "users" SET "age" = /);
			expect(statement.sql).toContain('RETURNING');
			expect(statement.params.length).toBeGreaterThan(0);

			// Nothing executed — Alice still seeds at 25.
			const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
			expect(alice.age).toBe(25);
		});
	});

	test('CAS win: one statement updates AND loads, pre-update row + post-update exposures', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			const cteBuilder = new DbCteBuilder();
			const gate = cteBuilder.withMutation(
				'cas_gate',
				db.users
					.where(u => and(eq(u.id, users.alice.id), ne(u.age, 999)))
					.update({ age: sql`"age" + ${100}::int` })
					.toStatement(u => ({ id: u.id, age: u.age })),
				{ id: 'id', age: 'age' },
			);

			const rows = await db.users
				.where(u => eq(u.id, users.alice.id))
				.with(gate.cte)
				.select(u => ({
					id: u.id,
					// The LOAD half — table read = PRE-update snapshot.
					loadedAge: u.age,
					username: u.username,
					// Nested collection stays intact next to the gate (the paid-order
					// load's lateral/CTE machinery must survive the attachment).
					postTitles: u.posts!.select(p => ({ title: p.title })).toList('postTitles'),
					// The gate's POST-update exposure.
					casAge: sql<number>`(SELECT "age" FROM "cas_gate")`.as('casAge'),
					gateWon: sql<boolean>`EXISTS (SELECT 1 FROM "cas_gate")`.as('gateWon'),
				}))
				.toList();

			expect(rows).toHaveLength(1);
			expect(rows[0].loadedAge).toBe(25);
			expect(rows[0].casAge).toBe(125);
			expect(rows[0].gateWon).toBe(true);
			expect(rows[0].postTitles.map(p => p.title).sort()).toEqual([
				'Alice Post 1',
				'Alice Post 2',
			]);

			// The mutation really committed.
			const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
			expect(alice.age).toBe(125);
		});
	});

	test('CAS loss: gating the outer WHERE on the CTE yields 0 rows and NO update', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			const cteBuilder = new DbCteBuilder();
			// The guard refuses: Alice's age IS 25, and the CAS requires it not to be.
			const gate = cteBuilder.withMutation(
				'cas_gate',
				db.users
					.where(u => and(eq(u.id, users.alice.id), ne(u.age, 25)))
					.update({ age: 777 })
					.toStatement(u => ({ id: u.id })),
				{ id: 'id' },
			);

			const rows = await db.users
				.where(u => and(
					eq(u.id, users.alice.id),
					sql`"users"."id" IN (SELECT "id" FROM "cas_gate")`,
				))
				.with(gate.cte)
				.select(u => ({ id: u.id, age: u.age }))
				.toList();

			expect(rows).toHaveLength(0);

			// The loser applied nothing.
			const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
			expect(alice.age).toBe(25);
		});
	});

	test('exactly ONE roundtrip for the gated load', async () => {
		await withDatabase(async (db) => {
			const { users } = await seedTestData(db);

			const cteBuilder = new DbCteBuilder();
			const gate = cteBuilder.withMutation(
				'cas_gate',
				db.users
					.where(u => eq(u.id, users.bob.id))
					.update({ isActive: false })
					.toStatement(u => ({ id: u.id })),
				{ id: 'id' },
			);

			const client = (db as any).client;
			const querySpy = jest.spyOn(client, 'query');

			try {
				const rows = await db.users
					.where(u => and(
						eq(u.id, users.bob.id),
						sql`"users"."id" IN (SELECT "id" FROM "cas_gate")`,
					))
					.with(gate.cte)
					.select(u => ({ id: u.id }))
					.toList();

				expect(rows).toHaveLength(1);
				expect(querySpy).toHaveBeenCalledTimes(1);
			} finally {
				querySpy.mockRestore();
			}
		});
	});
});
