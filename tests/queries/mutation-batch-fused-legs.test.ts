import { describe, test, expect, jest } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src/query/conditions';
import { MutationBatch } from '../../src/query/mutation-batch';
import { sql } from '../../src';

/**
 * MutationBatch fused legs — the three leg types that let a webhook tail
 * (status flip + audit log + accumulator upsert + cleanup deletes) ride ONE
 * data-modifying-CTE statement:
 *
 *  - `addUpdateWhereIn(table, field, values, set, id, opts)` — UPDATE with the
 *    same SET semantics as the fluent `update()` (plain values through column
 *    mappers, SqlFragment values inlined, lambda form resolving column refs).
 *    `opts.exposeColumns` / `opts.exposeOldColumns` publish columns on the
 *    leg's CTE (old-columns via PostgreSQL 18's `old.` RETURNING qualifier,
 *    aliased `old__<prop>`) so dependent legs can read them.
 *  - `addUpsertBulk(table, rows, config, id, opts)` — INSERT .. ON CONFLICT
 *    DO UPDATE (EXCLUDED semantics), SqlFragment cells supported;
 *    `opts.returning` (prop names) makes the rows readable AFTER execution via
 *    `getLegRows` (json_agg readback — raw JSON values, no fromDriver pass).
 *  - `addDependentInsert(table, row, dependency, id)` — single row inserted
 *    iff the PARENT leg's exposed column satisfies `whereNotEquals` — the
 *    conditional-audit-log shape (`old status ≠ final` → write the log).
 *    Cell values run through column mappers and are cast like the
 *    insertBulkWithChildren VALUES cells.
 */
describe('MutationBatch fused legs', () => {
	describe('addUpdateWhereIn', () => {
		test('updates rows by field IN values with plain SET values', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				const key = batch.addUpdateWhereIn(db.users, 'id', [users.alice.id, users.bob.id], { age: 77 }, 'ages');

				await batch.executeBatch();

				expect(batch.getAffectedCount(key!)).toBe(2);
				const rows = await db.users.where(u => eq(u.age, 77)).toList();
				expect(rows.map(r => r.username).sort()).toEqual(['alice', 'bob']);
			});
		});

		test('lambda SET with a SqlFragment value (flag-style column expression)', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				// The lambda form resolves column refs exactly like fluent update(p => ...).
				batch.addUpdateWhereIn(
					db.users,
					'id',
					[users.alice.id],
					(u: { age: number }) => ({ age: sql`${u.age} + ${100}::int` }),
					'bump',
				);

				await batch.executeBatch();

				const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
				// Alice seeds at 25.
				expect(alice.age).toBe(125);
			});
		});

		test('empty values register nothing and return null', async () => {
			await withDatabase(async (db) => {
				await seedTestData(db);

				const batch = new MutationBatch();
				const key = batch.addUpdateWhereIn(db.users, 'id', [], { age: 1 }, 'noop');

				expect(key).toBeNull();
				expect(batch.size).toBe(0);
			});
		});

		test('composes with delete legs in ONE statement', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				batch.addUpdateWhereIn(db.users, 'id', [users.charlie.id], { isActive: true }, 'activate');
				batch.addDeleteWhereIn(db.posts, 'userId', [users.alice.id], 'posts');

				const client = (db as any).client;
				const querySpy = jest.spyOn(client, 'query');

				try {
					await batch.executeBatch();

					expect(querySpy).toHaveBeenCalledTimes(1);
				} finally {
					querySpy.mockRestore();
				}

				expect(batch.getAffectedCount('activate')).toBe(1);
				expect(batch.getAffectedCount('posts')).toBe(2);
			});
		});
	});

	describe('addUpsertBulk with row readback', () => {
		test('fresh insert and conflict update both read back via getLegRows', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				// Alice exists (conflict → DO UPDATE), "dave" is fresh. The age cell is a
				// SqlFragment computed IN the statement — the accumulator-fold shape.
				const key = batch.addUpsertBulk(
					db.users,
					[
						{ username: 'alice', email: 'alice@test.com', age: sql`(${7}::int + ${8}::int)` },
						{ username: 'dave', email: 'dave@test.com', age: sql`(${1}::int + ${2}::int)` },
					],
					{ primaryKey: 'username', updateColumns: ['age'] },
					'spend',
					{ returning: ['username', 'age'] },
				);

				await batch.executeBatch();

				expect(batch.getAffectedCount(key!)).toBe(2);
				const rows = batch.getLegRows(key!) as Array<{ username: string; age: number }>;
				const byName = new Map(rows.map(r => [r.username, r.age]));
				expect(byName.get('alice')).toBe(15);
				expect(byName.get('dave')).toBe(3);

				// Persisted truth matches; Alice's other columns untouched.
				const alice = (await db.users.where(u => eq(u.id, users.alice.id)).toList())[0];
				expect(alice.age).toBe(15);
				expect(alice.email).toBe('alice@test.com');
			});
		});

		test('getLegRows throws for a leg registered without returning', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				const key = batch.addUpdateWhereIn(db.users, 'id', [users.alice.id], { age: 30 }, 'plain');

				await batch.executeBatch();

				expect(() => batch.getLegRows(key!)).toThrow(/returning/);
			});
		});
	});

	describe('addDependentInsert (parent-condition gated)', () => {
		test('inserts the row when the parent old-column differs from the sentinel', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				// Flip isActive false→true; old."is_active" was false ≠ true → log row fires.
				const flip = batch.addUpdateWhereIn(
					db.users,
					'id',
					[users.charlie.id],
					{ isActive: true },
					'flip',
					{ exposeOldColumns: ['isActive'] },
				);
				const log = batch.addDependentInsert(
					db.posts,
					{
						title: 'activation log',
						content: 'charlie went active',
						userId: users.charlie.id,
						views: 0,
						publishTime: { hour: 6, minute: 45 },
					},
					{ onLeg: flip!, whereColumn: 'old__isActive', whereNotEquals: true },
					'log',
				);

				await batch.executeBatch();

				expect(batch.getAffectedCount(flip!)).toBe(1);
				expect(batch.getAffectedCount(log!)).toBe(1);

				const logged = (await db.posts.where(p => eq(p.title, 'activation log')).toList())[0];
				expect(logged).toBeTruthy();
				// The custom HourMinute mapper applied to the dependent cell.
				expect(logged.publishTime).toEqual({ hour: 6, minute: 45 });
			});
		});

		test('skips the row when the parent old-column equals the sentinel (idempotent replay)', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				// Alice is ALREADY active — old."is_active" = true → the same-value write
				// is a no-op transition and the log row must NOT fire.
				const flip = batch.addUpdateWhereIn(
					db.users,
					'id',
					[users.alice.id],
					{ isActive: true },
					'flip',
					{ exposeOldColumns: ['isActive'] },
				);
				batch.addDependentInsert(
					db.posts,
					{
						title: 'phantom log',
						content: 'must not exist',
						userId: users.alice.id,
						views: 0,
						publishTime: { hour: 1, minute: 1 },
					},
					{ onLeg: flip!, whereColumn: 'old__isActive', whereNotEquals: true },
					'log',
				);

				await batch.executeBatch();

				expect(batch.getAffectedCount('flip')).toBe(1);
				expect(batch.getAffectedCount('log')).toBe(0);
				expect(await db.posts.where(p => eq(p.title, 'phantom log')).toList()).toHaveLength(0);
			});
		});

		test('dependent leg registered before its parent throws', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();

				expect(() => batch.addDependentInsert(
					db.posts,
					{ title: 'x', content: 'y', userId: users.alice.id, views: 0, publishTime: { hour: 1, minute: 0 } },
					{ onLeg: 'ghost', whereColumn: 'old__isActive', whereNotEquals: true },
					'orphan',
				)).toThrow(/ghost/);
			});
		});
	});

	describe('mixed webhook-tail shape (integration)', () => {
		test('update+dependent-log + upsert-readback + deletes ride ONE statement', async () => {
			await withDatabase(async (db) => {
				const { users } = await seedTestData(db);

				const batch = new MutationBatch();
				const compl = batch.addUpdateWhereIn(
					db.users,
					'id',
					[users.charlie.id],
					{ isActive: true },
					'compl',
					{ exposeOldColumns: ['isActive'] },
				);
				batch.addDependentInsert(
					db.posts,
					{ title: 'tail log', content: 'log', userId: users.charlie.id, views: 0, publishTime: { hour: 2, minute: 30 } },
					{ onLeg: compl!, whereColumn: 'old__isActive', whereNotEquals: true },
					'log',
				);
				const spend = batch.addUpsertBulk(
					db.users,
					[{ username: 'erin', email: 'erin@test.com', age: sql`(${20}::int + ${1}::int)` }],
					{ primaryKey: 'username', updateColumns: ['age'] },
					'spend',
					{ returning: ['age'] },
				);
				batch.addDeleteWhereIn(db.posts, 'userId', [users.alice.id], 'clear');

				const client = (db as any).client;
				const querySpy = jest.spyOn(client, 'query');

				try {
					await batch.executeBatch();

					expect(querySpy).toHaveBeenCalledTimes(1);
				} finally {
					querySpy.mockRestore();
				}

				expect(batch.getAffectedCount('compl')).toBe(1);
				expect(batch.getAffectedCount('log')).toBe(1);
				expect((batch.getLegRows(spend!)[0] as { age: number }).age).toBe(21);
				expect(batch.getAffectedCount('clear')).toBe(2);
			});
		});
	});
});
