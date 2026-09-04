import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getSharedDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { DbCteBuilder, eq } from '../../src';

/**
 * `forUpdate()` — the row-level lock clause on SelectQueryBuilder and
 * CteRootQueryBuilder.
 *
 * SQL-shape assertions (toSql) plus one live lock-behaviour check: two
 * concurrent transactions reading the same row FOR UPDATE serialize — the
 * second blocks until the first commits. That serialization point is what the
 * fused-conditional-INSERT pattern uses as its DB-side guard.
 */
describe('forUpdate()', () => {
	let db: AppDatabase;

	beforeAll(async () => {
		db = getSharedDatabase();
		await setupDatabase(db);
	});

	afterAll(async () => {
		await cleanupDatabase(db);
	});

	test('SelectQueryBuilder emits FOR UPDATE after ORDER BY/LIMIT', async () => {
		const { sql } = (db.users
			.where(u => eq(u.isActive, true))
			.select(u => ({ id: u.id }))
			.orderBy(u => u.id)
			.forUpdate() as any).buildQuery(
			{ id: {} },
			{ ctes: new Map(), cteCounter: 0, paramCounter: 1, allParams: [] },
		) as { sql: string };

		expect(sql).toContain('ORDER BY');
		expect(sql).toMatch(/FOR UPDATE\s*$/);
	});

	test('skipLocked / noWait modifiers and their mutual exclusion', () => {
		const build = (opts: any) => (db.users
			.select(u => ({ id: u.id }))
			.forUpdate(opts) as any).lockClause;

		expect(build({ skipLocked: true })).toBe('FOR UPDATE SKIP LOCKED');
		expect(build({ noWait: true })).toBe('FOR UPDATE NOWAIT');
		expect(() => build({ skipLocked: true, noWait: true })).toThrow('mutually exclusive');
	});

	test('CTE body carries FOR UPDATE verbatim (the fused-INSERT lock leg)', () => {
		const b = new DbCteBuilder();
		const locked = b.with(
			'locked_groups',
			db.users
				.where(u => eq(u.isActive, true))
				.select(u => ({ id: u.id }))
				.orderBy(u => u.id)
				.forUpdate(),
		);

		expect(locked.cte.query).toMatch(/SELECT[\s\S]*FOR UPDATE\s*\)?\s*$/);
	});

	test('CteRootQueryBuilder emits FOR UPDATE after LIMIT', () => {
		const b = new DbCteBuilder();
		const root = b.with('root', db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id })));
		const q = db.selectFromCte(root.cte)
			.select(r => ({ id: r.id }))
			.orderBy(r => r.id)
			.forUpdate();

		expect(q.toSql()).toMatch(/FOR UPDATE\s*$/);
	});

	test('live: a held FOR UPDATE lock makes a second NOWAIT read fail (lock is real)', async () => {
		const user = await db.users.insert({
			username: `for-update-${Date.now()}`,
			email: `for-update-${Date.now()}@test.local`,
			isActive: true,
		} as any).returning();

		// The test DB driver exposes transaction(queryFn) — two SEPARATE transaction
		// calls draw two separate pooled connections, which is exactly the two-session
		// shape the lock check needs. tx1 takes the row lock and holds it while tx2's
		// NOWAIT read of the same row must be rejected with a lock-not-available error.
		const client = getSharedDatabase().getClient();
		let tx2rejectedByLock = false;

		await client.transaction(async (q1) => {
			await q1('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);

			try {
				await client.transaction(async (q2) => {
					await q2('SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT', [user.id]);
				});
			} catch (err: any) {
				tx2rejectedByLock = /lock|55P03|could not obtain/i.test(String(err?.message ?? err));
			}
		});

		await db.users.where(u => eq(u.id, user.id)).delete();

		expect(tx2rejectedByLock).toBe(true);
	});
});
