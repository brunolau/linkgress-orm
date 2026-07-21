/**
 * ORM-layer micro-bench: where does linkgress itself spend time?
 *
 * Measures p50 wall time and (via traceTime) the queryBuild / queryExecution /
 * resultProcessing phase split for representative query shapes against a
 * scaled dataset (~3k post rows).
 *
 * Usage:  npx ts-node debug/bench-orm.ts   |   bun debug/bench-orm.ts
 */
import 'dotenv/config';
import { AppDatabase } from './schema/appDatabase';
import { PostgresClient, gt } from '../src';

const HOST = process.env.DB_HOST || 'localhost';
const PORT = parseInt(process.env.DB_PORT || '5432');
const USER = process.env.DB_USER || 'postgres';
const PASSWORD = process.env.DB_PASSWORD || 'postgres';
const DB = 'linkgress_bench';

const timingLines: string[] = [];

const main = async () => {
	const client = new PostgresClient({ host: HOST, port: PORT, database: DB, username: USER, password: PASSWORD });
	const db = new AppDatabase(client, {
		logQueries: false,
		logger: (message: string, section?: string) => {
			if (section === 'timing') {
				timingLines.push(message);
			}
		},
	} as any);

	// ---- schema + scaled seed (idempotent; db.query returns rows directly) --
	const tableCount: any = await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'users'`);

	if (tableCount[0].n === 0) {
		await db.getSchemaManager().ensureCreated();
	}

	const postCount: any = await db.query(`SELECT count(*)::int AS n FROM posts`).catch(() => [{ n: -1 }]);

	if (postCount[0].n < 3000) {
		await db.getSchemaManager().ensureDeleted();
		await db.getSchemaManager().ensureCreated();

		const users: any[] = [];
		for (let i = 0; i < 50; i++) {
			users.push({ username: `user_${i}`, email: `u${i}@bench.com`, age: 20 + (i % 50), isActive: i % 3 !== 0 });
		}
		const insertedUsers = await db.users.insertBulk(users).returning();

		for (let chunk = 0; chunk < 6; chunk++) {
			const posts: any[] = [];
			for (let i = 0; i < 500; i++) {
				const n = chunk * 500 + i;
				posts.push({
					title: `Post ${n}`,
					content: `Content body for post number ${n} with some length to it`,
					userId: insertedUsers[n % insertedUsers.length].id,
					views: n % 1000,
					publishTime: { hour: n % 24, minute: n % 60 },
				});
			}
			await db.posts.insertBulk(posts);
		}
		console.log('seeded 50 users / 3000 posts');
	}

	// ---- helpers -----------------------------------------------------------
	const bench = async (name: string, iters: number, warmup: number, fn: () => Promise<any>) => {
		for (let i = 0; i < warmup; i++) {
			await fn();
		}

		const samples: number[] = [];
		for (let i = 0; i < iters; i++) {
			const t0 = performance.now();
			await fn();
			samples.push(performance.now() - t0);
		}

		samples.sort((a, b) => a - b);
		const p50 = samples[Math.floor(samples.length / 2)];
		const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
		console.log(`${name.padEnd(34)} p50 ${p50.toFixed(3).padStart(8)}ms  mean ${mean.toFixed(3).padStart(8)}ms`);
	};

	const tracePhases = async (name: string, fn: () => Promise<any>) => {
		timingLines.length = 0;
		await fn();
		console.log(`--- phases: ${name}`);
		console.log(timingLines.map(l => `    ${l.trim()}`).join('\n'));
	};

	// ---- benchmarks --------------------------------------------------------
	await bench('RAW SQL: 3000 posts all cols', 60, 10, () =>
		db.query(`SELECT * FROM posts`));

	await bench('RAW SQL: 3000 posts 5 cols', 60, 10, () =>
		db.query(`SELECT id, title, views, user_id, publish_time FROM posts`));

	await bench('flat: 3000 posts all cols', 60, 10, () =>
		db.posts.toList());

	await bench('flat: 3000 posts 5-col select', 60, 10, () =>
		db.posts.select(p => ({ id: p.id, title: p.title, views: p.views, userId: p.userId, publishTime: p.publishTime })).toList());

	await bench('where+order: top 100 posts', 100, 20, () =>
		db.posts.where(p => gt(p.views!, 500)).orderBy(p => [[p.views, 'desc']] as any).limit(100).select(p => ({ id: p.id, title: p.title, views: p.views })).toList());

	await bench('collections: 50 users lateral', 60, 10, () =>
		db.users.select(u => ({
			id: u.id,
			username: u.username,
			postIds: u.posts!.select(p => ({ id: p.id })).toNumberList(),
			latest: u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ id: p.id, title: p.title })).firstOrDefault(),
			posts: u.posts!.select(p => ({ id: p.id, title: p.title, views: p.views })).toList('posts'),
		})).toList());

	await tracePhases('flat 3000 all cols', () =>
		db.posts.withQueryOptions({ traceTime: true }).toList());

	await tracePhases('collections 50 users', () =>
		db.users.withQueryOptions({ traceTime: true }).select(u => ({
			id: u.id,
			username: u.username,
			postIds: u.posts!.select(p => ({ id: p.id })).toNumberList(),
			latest: u.posts!.orderBy(p => [[p.views, 'DESC']]).select(p => ({ id: p.id, title: p.title })).firstOrDefault(),
			posts: u.posts!.select(p => ({ id: p.id, title: p.title, views: p.views })).toList('posts'),
		})).toList());

	await client.end();
	process.exit(0);
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
