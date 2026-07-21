/**
 * Bun.SQL (postgres) binary result decoding — two bugs, Bun 1.3.14 Windows x64.
 * Repro needs any reachable PostgreSQL; no tables required.
 *
 * BUG 1 (crash): in a parameterized query (extended protocol -> binary results),
 * an int[] column PANICS the runtime ("incorrect alignment") whenever the
 * preceding variable-length column's byte length is not a multiple of 4.
 *
 * BUG 2 (wrong shape): when it does not crash, int[] decodes to a numeric-keyed
 * OBJECT ({"0":1,"1":2}) instead of a JS array. Unparameterized (simple
 * protocol, text results) queries decode the same column correctly.
 *
 * Run: bun debug/bun-sql-binary-array-repro.ts [crash]
 */
const main = async () => {
const sql = new Bun.SQL({
  hostname: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// BUG 2 — object instead of array (aligned, so no crash):
const simple = await sql.unsafe(`SELECT ARRAY[1,2,3] AS a`);
console.log('simple protocol :', JSON.stringify(simple[0].a), '<- correct');

const binary = await sql.unsafe(`SELECT ARRAY[1,2,3] AS a WHERE $1::int = 1`, [1]);
console.log('binary protocol :', JSON.stringify(binary[0].a), '<- object, should be [1,2,3]');

const empty = await sql.unsafe(`SELECT '{}'::int[] AS a WHERE $1::int = 1`, [1]);
console.log('empty int[]     :', JSON.stringify(empty[0].a), '<- should be []');

// BUG 1 — crash. Any text column with length % 4 != 0 before an array column:
if (process.argv[2] === 'crash') {
  console.log('about to panic: SELECT \'x\'::text, ARRAY[1,2,3] WHERE $1::int = 1 ...');
  await sql.unsafe(`SELECT 'x'::text AS t, ARRAY[1,2,3] AS a WHERE $1::int = 1`, [1]);
  console.log('unreachable on affected versions');
}

await sql.close();
};

main();
