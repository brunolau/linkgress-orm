import { afterAll, afterEach, describe, expect, test } from '@jest/globals';
import { MockRowCache, NavigationPathCache } from '../../src';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * NavigationPathCache: memo for the transitive navigation-path BFS, gated by the same
 * opt-in switch as MockRowCache. Off → every call computes; on → one computation per
 * (registry, signature), always handed out as a fresh array.
 */
describe('NavigationPathCache', () => {
	afterEach(() => {
		NavigationPathCache.reset();
	});

	afterAll(() => {
		MockRowCache.reset();
	});

	test('switch OFF: computes on every call and retains nothing', () => {
		MockRowCache.setEnabled(false);
		const registry = new Map();
		let builds = 0;
		const build = () => { builds++; return [{ alias: 'user', relation: {}, sourceAlias: 'post' }]; };

		NavigationPathCache.getOrBuild(registry, 'user|post:.posts', build);
		NavigationPathCache.getOrBuild(registry, 'user|post:.posts', build);

		expect(builds).toBe(2);
		expect(NavigationPathCache.diagnostics()).toMatchObject({ enabled: false, entries: 0 });
	});

	test('switch ON: one computation per registry + signature, fresh array per call', () => {
		MockRowCache.setEnabled(true);
		const registryA = new Map();
		const registryB = new Map();
		let builds = 0;
		const build = () => { builds++; return [{ alias: 'user', relation: {}, sourceAlias: 'post' }]; };

		const first = NavigationPathCache.getOrBuild(registryA, 'k', build);
		const second = NavigationPathCache.getOrBuild(registryA, 'k', build);
		NavigationPathCache.getOrBuild(registryB, 'k', build);

		expect(builds).toBe(2);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		// A caller mutating its copy must not poison the memo.
		second.push({ alias: 'x', relation: {}, sourceAlias: 'y' });
		expect(NavigationPathCache.getOrBuild(registryA, 'k', build)).toHaveLength(1);
		expect(NavigationPathCache.diagnostics()).toMatchObject({ enabled: true, entries: 2 });
	});

	test('deep navigation queries return identical rows with the switch OFF and ON', async () => {
		await withDatabase(async (db) => {
			await seedTestData(db);

			const runQuery = () => db.posts
				.select(p => ({
					title: p.title,
					authorName: p.user!.username,
					otherTitles: (p.user as any).posts.select((op: any) => ({ t: op.title })).toList('otherTitles'),
				}))
				.orderBy(p => p.title)
				.toList();

			MockRowCache.setEnabled(false);
			const off = await runQuery();

			MockRowCache.setEnabled(true);
			const on = await runQuery();
			const onAgain = await runQuery();

			expect(off.length).toBeGreaterThan(0);
			expect(on).toEqual(off);
			expect(onAgain).toEqual(off);
		});
	});
});
