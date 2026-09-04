import { afterAll, describe, expect, test } from '@jest/globals';
import { MockRowCache } from '../../src';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * MockRowCache static switch: the cross-row descriptor cache is OPT-IN, off by default,
 * and produces byte-identical query results in both modes.
 */
describe('MockRowCache static switch', () => {
	afterAll(() => {
		MockRowCache.reset();
	});

	test('default state is disabled with zero retained entries', () => {
		expect(MockRowCache.isEnabled()).toBe(false);
		expect(MockRowCache.diagnostics()).toMatchObject({ enabled: false, entries: 0 });
	});

	test('queries work unchanged with the cache OFF and retain no entries', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const rows = await db.posts
				.select(p => ({
					title: p.title,
					authorName: p.user!.username,
					authorId: p.user!.id,
				}))
				.toList();

			expect(rows.length).toBeGreaterThan(0);
			expect(MockRowCache.diagnostics().entries).toBe(0);
		});
	});

	test('enabling the cache retains signature entries and returns IDENTICAL results', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const runQuery = () => db.posts
				.select(p => ({
					title: p.title,
					authorName: p.user!.username,
					authorId: p.user!.id,
					// deep navigation: post -> user -> their posts' titles (collection nav)
					otherTitles: (p.user as any).posts.select((op: any) => ({ t: op.title })).toList('otherTitles'),
				}))
				.toList();

			MockRowCache.setEnabled(false);
			const before = await runQuery();
			expect(MockRowCache.diagnostics().entries).toBe(0);

			MockRowCache.setEnabled(true);
			const cached = await runQuery();
			// A second run reuses the retained signature entries.
			const cachedAgain = await runQuery();

			expect(MockRowCache.isEnabled()).toBe(true);
			expect(MockRowCache.diagnostics().entries).toBeGreaterThan(0);
			expect(cached).toEqual(before);
			expect(cachedAgain).toEqual(before);
		});
	});

	test('reset() restores the default-off state and drops retained entries', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			MockRowCache.setEnabled(true);
			await db.posts.select(p => ({ title: p.title, authorName: p.user!.username })).toList();
			expect(MockRowCache.diagnostics().entries).toBeGreaterThan(0);

			MockRowCache.reset();
			expect(MockRowCache.isEnabled()).toBe(false);
			expect(MockRowCache.diagnostics().entries).toBe(0);
		});
	});

	test('cache ON: rows of one signature share a prototype but keep their own state slots', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const captured: any[] = [];
			const runQuery = () => db.posts
				.select(p => {
					captured.push(p.user);

					return { title: p.title, authorName: p.user!.username };
				})
				.toList();

			MockRowCache.setEnabled(true);
			await runQuery();
			await runQuery();

			expect(captured.length).toBeGreaterThanOrEqual(2);
			const [first, second] = captured;

			// The getters are inherited from ONE shared prototype per signature …
			expect(first).not.toBe(second);
			expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second));
			expect(Object.getPrototypeOf(first)).not.toBe(Object.prototype);
			// … which is why own-property APIs see no columns on the row itself …
			expect(Object.keys(first)).toEqual([]);
			// … while normal access and enumeration still behave like a plain mock row.
			expect('username' in first).toBe(true);
			expect(first.username.__fieldName).toBe('username');
			expect(Object.keys(Object.getPrototypeOf(first))).toContain('username');
			// Per-row state stays per row: the FieldRef built on `first` is not `second`'s.
			expect(first.username).not.toBe(second.username);
		});
	});

	test('whole-reference selection (`author: p.user`) is identical with the cache OFF and ON', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const runQuery = () => db.posts
				.select(p => ({
					title: p.title,
					author: p.user,
				}))
				.orderBy(p => p.title)
				.toList();

			MockRowCache.setEnabled(false);
			const off = await runQuery();

			MockRowCache.setEnabled(true);
			const on = await runQuery();

			expect(off.length).toBeGreaterThan(0);
			expect(off[0].author).toBeTruthy();
			expect(on).toEqual(off);
		});
	});
});
