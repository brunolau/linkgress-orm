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
});
