/**
 * Cold start of one version (bench/versions/compare.mjs runs it in many fresh processes): loading the
 * package, constructing a context, and the first two queries — built by cold code, answered with zero
 * rows by a client that never connects, so only linkgress is on the clock.
 *
 *   node <tree>/build/bench/versions/startup.js
 */
async function main(): Promise<void> {
  const t0 = performance.now();
  const lib: any = require('../../src');
  const t1 = performance.now();
  const { AppDatabase } = require('../../debug/schema/appDatabase');
  const t2 = performance.now();

  const NullClient: any = class extends lib.PgClient {
    async query(): Promise<any> {
      return { rows: [], rowCount: 0 };
    }
  };

  const db = new AppDatabase(new NullClient({ host: 'localhost' }), { logQueries: false, collectionStrategy: 'lateral' });
  const t3 = performance.now();
  await db.users.where((u: any) => lib.eq(u.id, 1)).firstOrDefault();
  const t4 = performance.now();
  await db.users
    .where((u: any) => lib.lte(u.id, 100))
    .select((u: any) => ({ id: u.id, posts: u.posts.select((p: any) => ({ id: p.id, title: p.title })).toList('posts') }))
    .toList();
  const t5 = performance.now();

  process.stdout.write(JSON.stringify({
    importMs: t1 - t0,
    schemaModuleMs: t2 - t1,
    contextMs: t3 - t2,
    firstQueryMs: t4 - t3,
    firstCollectionQueryMs: t5 - t4,
  }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
