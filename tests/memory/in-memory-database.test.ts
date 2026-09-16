/* eslint-disable @typescript-eslint/no-var-requires */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { describe, expect, test } from 'bun:test';
import { createInMemoryDatabase, startInMemoryDatabaseThread } from '../../src';
import { expectToReject } from '../utils/expect-rejects';

// the real drivers (LINKGRESS_TEST_DB=memory replaces the `pg` / `postgres` modules with in-memory wrappers)
const realDrivers = (globalThis as any).__linkgressRealDrivers;
const pgPath = path.resolve(__dirname, '../../node_modules/pg/lib/index.js');
const { Client } = realDrivers?.pg ?? require('pg');
const postgresModule = realDrivers?.postgres ?? require('postgres');
// Bun resolves `require('postgres')` to the package's ES module namespace
const postgres = postgresModule.default ?? postgresModule;

describe('in-memory database API', () => {
  test('dead row versions are vacuumed once no snapshot can see them', async () => {
    const db = createInMemoryDatabase();
    const a = new Client(db.pgPoolConfig());
    const b = new Client(db.pgPoolConfig());
    await a.connect();
    await b.connect();
    const tuples = () => db.engine.stats().allTuples;
    await a.query('create table churn(id int primary key, v text)');
    await a.query(`insert into churn select g, 'v' || g from generate_series(1, 100) g`);
    // versions replaced by committed updates (21 versions per row without vacuum)
    for (let i = 0; i < 20; i++) {
      await a.query(`update churn set v = v || 'x'`);
    }
    expect(tuples()).toBeLessThanOrEqual(200);
    // inserts of rolled-back transactions
    for (let i = 0; i < 10; i++) {
      await a.query('begin');
      await a.query('insert into churn select g, null from generate_series(1000, 1100) g');
      await a.query('rollback');
    }
    expect(tuples()).toBeLessThanOrEqual(201);
    expect((await a.query(`select count(*)::int as n, count(*) filter (where v like 'v%xxxxxxxxxxxxxxxxxxxx')::int as updated from churn`)).rows[0]).toEqual({ n: 100, updated: 100 });

    // an open REPEATABLE READ snapshot keeps every version it can see
    await b.query('begin isolation level repeatable read');
    expect((await b.query('select count(*)::int as n from churn')).rows[0].n).toBe(100);
    await a.query('delete from churn where id <= 90');
    for (let i = 0; i < 20; i++) {
      await a.query(`update churn set v = v || 'y'`);
    }
    expect((await b.query(`select count(*)::int as n, min(id) as lo, count(*) filter (where v like '%y')::int as newer from churn`)).rows[0]).toEqual({ n: 100, lo: 1, newer: 0 });
    await b.query('commit');
    // the next transaction end may remove them
    await a.query(`update churn set v = v || 'z'`);
    expect((await b.query(`select count(*)::int as n, count(*) filter (where v like '%yz')::int as newest from churn`)).rows[0]).toEqual({ n: 10, newest: 10 });
    expect(tuples()).toBeLessThanOrEqual(20);
    await a.end();
    await b.end();
  });

  test('snapshot and fork are independent copies of the committed state', async () => {
    const db = createInMemoryDatabase({ databaseName: 'api_snap' });
    const client = new Client(db.pgPoolConfig());
    await client.connect();
    await client.query('create table t(id int primary key, v text); insert into t values (1, $$a$$)');

    const copy = db.fork();
    await client.query(`insert into t values (2, 'b')`);
    await client.end();

    const forked = new Client(copy.pgPoolConfig());
    await forked.connect();
    const rows = (await forked.query('select id, v from t order by id')).rows;
    expect(rows).toEqual([{ id: 1, v: 'a' }]);
    expect((await forked.query('select current_database() as d')).rows[0].d).toBe('api_snap');
    await forked.end();
  });

  test('listen() serves the database over TCP, procedures COMMIT inside CALL', async () => {
    const db = createInMemoryDatabase();
    const listener = await db.listen();
    try {
      const client = new Client({ connectionString: listener.connectionString(), password: 'ignored' });
      await client.connect();
      await client.query('create table log(id int primary key)');
      await client.query(`create procedure fill(n int, inout total int) language plpgsql as $$
        begin
          for i in 1..n loop
            insert into log values (i);
            if i % 2 = 0 then commit; end if;
          end loop;
          total := (select count(*) from log);
        end $$`);
      const r = await client.query('call fill(5, null)');
      expect(r.command).toBe('CALL');
      expect(r.rows).toEqual([{ total: 5 }]);

      // COMMIT is refused inside a transaction block, like PostgreSQL
      await client.query('begin');
      await client.query('create procedure just_commit() language plpgsql as $$ begin commit; end $$');
      expect(await expectToReject(client.query('call just_commit()'))).toMatchObject({ code: '2D000', message: 'invalid transaction termination' });
      await client.query('rollback');
      await client.end();
    } finally {
      await listener.close();
    }
  });

  test('a thread-hosted database keeps serving while the calling thread is blocked', async () => {
    const server = startInMemoryDatabaseThread({ database: { databaseName: 'api_thread' }, listen: true });
    try {
      const sql = postgres(server.postgresOptions({ max: 2 }));
      await sql`create table items(id int primary key)`;
      await sql`insert into items values (1), (2), (3)`;

      // spawnSync blocks this thread; the child connects over TCP and is answered by the database thread
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const { Client } = require(${JSON.stringify(pgPath)});
           const c = new Client({ host: '127.0.0.1', port: ${server.listener!.port}, user: 'postgres', password: 'x', database: 'api_thread' });
           c.connect().then(() => c.query('select count(*)::int as n from items')).then((r) => { console.log(r.rows[0].n); return c.end(); });`,
        ],
        { encoding: 'utf8', timeout: 20000 }
      );
      expect(child.stderr).toBe('');
      expect(child.stdout.trim()).toBe('3');

      expect(await sql`select count(*)::int as n from items`).toEqual([{ n: 3 }]);
      await sql.end();
    } finally {
      await server.terminate();
    }
  });

  test('databasePerName: each connection database name is its own database', async () => {
    const server = startInMemoryDatabaseThread({ databasePerName: { aliases: [{ pattern: '-w\\d+$', name: 'app_test' }] } });
    try {
      const w1 = postgres(server.postgresOptions({ database: 'app_test-w1', max: 1 }));
      const w2 = postgres(server.postgresOptions({ database: 'app_test-w2', max: 1 }));
      const other = postgres(server.postgresOptions({ database: 'app_dev', max: 1 }));
      await w1`create table shared(id int)`;
      await w1`insert into shared values (7)`;
      // the aliased names share one database, reported under the name each connection used
      expect(await w2`select id, current_database() as db from shared`).toEqual([{ id: 7, db: 'app_test-w2' }]);
      expect(await expectToReject(other`select * from shared`)).toMatchObject({ code: '42P01' });
      await Promise.all([w1.end(), w2.end(), other.end()]);
    } finally {
      await server.terminate();
    }
  });

  test('EXPLAIN reports the index PostgreSQL would use', async () => {
    const db = createInMemoryDatabase();
    const client = new Client(db.pgPoolConfig());
    await client.connect();
    await client.query('create table card(id serial primary key, card_number bigint not null, active bool)');
    await client.query('create index ix_card_suffix on card ((card_number % 10000000))');
    await client.query('insert into card(card_number, active) select 8100000000000 + g, true from generate_series(1, 2000) g');
    const plan = (await client.query('explain (costs off) select id from card where card_number % 10000000 = $1 and active', [1234567])).rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']);
    expect(plan).toEqual(["Index Scan using ix_card_suffix on card", "  Index Cond: ((card_number % '10000000'::bigint) = '1234567'::bigint)", "  Filter: active"]);
    await client.end();
  });

  test('col = ANY(array) index lookups return what a sequential scan returns', async () => {
    const db = createInMemoryDatabase();
    const client = new Client(db.pgPoolConfig());
    await client.connect();
    await client.query('create table item(id int primary key, grp int, code text)');
    await client.query(`insert into item select g, g % 7, 'c' || (g % 5) from generate_series(1, 300) g`);
    await client.query('update item set grp = 3 where id in (10, 20)');
    // the same predicate on an expression cannot use the lookup: the reference result, in heap order
    const same = async (indexed: string, scanned: string, params: unknown[]) => {
      const a = (await client.query(indexed, params)).rows;
      const b = (await client.query(scanned, params)).rows;
      expect(a).toEqual(b);
      return a;
    };
    const rows = await same('select id, grp from item where grp = any($1::int[])', 'select id, grp from item where grp + 0 = any($1::int[])', [[3, 3, null, 5]]);
    expect(rows.length).toBeGreaterThan(80);
    await same('select id from item where id = any($1::bigint[])', 'select id from item where id + 0 = any($1::bigint[])', [[250, 12, 12, 999]]);
    await same('select id from item where id in (7, 3, 5)', 'select id from item where id + 0 in (7, 3, 5)', []);
    await same(`select id from item where code = any('{{c1,c2},{c4,null}}'::text[])`, `select id from item where code || '' = any('{{c1,c2},{c4,null}}'::text[])`, []);
    expect((await client.query('select id from item where id = any($1::int[])', [[]])).rows).toEqual([]);
    expect((await client.query('select id from item where id = any($1::int[])', [null])).rows).toEqual([]);

    // rows inserted by a plpgsql block that rolls back (an exception handler) leave the cached lookups intact
    await client.query(`do $$ begin
      begin
        insert into item values (1001, 3, 'c1'), (1002, 4, 'c2');
        perform 1 / 0;
      exception when division_by_zero then null;
      end;
      insert into item values (1003, 3, 'c3');
    end $$`);
    const after = await same('select id from item where grp = any($1::int[])', 'select id from item where grp + 0 = any($1::int[])', [[3, 4]]);
    expect(after.map((r: { id: number }) => r.id)).toContain(1003);
    expect(after.map((r: { id: number }) => r.id)).not.toContain(1001);
    await client.end();
  });

  test('expression index lookups and LIMIT return what a full scan returns', async () => {
    const db = createInMemoryDatabase();
    const client = new Client(db.pgPoolConfig());
    await client.connect();
    await client.query(`create function norm(v text) returns text language sql immutable strict as $$ select lower(v) $$`);
    await client.query('create table doc(id int primary key, code varchar(20), kind text)');
    await client.query('create index ix_doc_norm on doc (norm(code::text))');
    await client.query(`insert into doc select g, case when g % 3 = 0 then 'AbC' else 'x' || g end, 'k' || (g % 4) from generate_series(1, 200) g`);
    await client.query(`update doc set kind = 'changed' where id = 3`);
    const q = async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows;
    // the indexed expression (also through an implicit varchar -> text relabeling) vs the same predicate spelled differently
    expect(await q('select id, kind from doc where norm(code) = norm($1)', ['ABC'])).toEqual(await q(`select id, kind from doc where lower(code) || '' = lower($1)`, ['ABC']));
    expect(await q('select id from doc where norm(code::text) = $1 and kind = $2', ['abc', 'k2'])).toEqual(await q(`select id from doc where lower(code) = $1 and kind = $2`, ['abc', 'k2']));
    await client.query(`insert into doc values (500, 'ABC', 'late')`);
    expect((await q('select id from doc where norm(code) = $1', ['abc'])).map((r: { id: number }) => r.id)).toContain(500);

    // LIMIT / OFFSET stop the scan early: the same prefix, and the target list only for the rows returned
    const all = await q('select id from doc where kind = $1', ['k1']);
    expect(await q('select id from doc where kind = $1 limit 3 offset 2', ['k1'])).toEqual(all.slice(2, 5));
    expect(await q('select exists(select 1 from doc where kind = $1) as e', ['k1'])).toEqual([{ e: true }]);
    await client.query('create sequence s');
    await q('select nextval($1) from doc limit 2', ['s']);
    expect(await q(`select currval('s') as v`)).toEqual([{ v: '2' }]);
    await client.end();
  });

  test('catalog views that report live state are never served stale', async () => {
    // Catalog rows are cached per catalog VERSION, which only DDL bumps. Two columns move without
    // one: `pg_sequences.last_value` (every nextval) and `pg_class.reltuples` (every write). A
    // caller that allocates from a sequence and reads it back, or counts rows through the catalog,
    // must see its own work — freezing either is how a cached catalog goes wrong.
    const db = createInMemoryDatabase();
    const client = new Client(db.pgPoolConfig());
    await client.connect();
    const q = async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows;
    const lastValue = async () => (await q(`select last_value from pg_sequences where sequencename = 'seq_live'`))[0].last_value;
    const relTuples = async () => Number((await q(`select reltuples from pg_class where relname = 'live'`))[0].reltuples);

    await client.query('create sequence seq_live');
    await client.query('create table live(id int primary key, n int)');

    // read first, so a cache that froze the row would be populated before the change
    expect(await lastValue()).toBe(null);
    await q(`select nextval('seq_live')`);
    expect(Number(await lastValue())).toBe(1);
    await q(`select nextval('seq_live')`);
    expect(Number(await lastValue())).toBe(2);

    expect(await relTuples()).toBe(0);
    await client.query('insert into live select g, g from generate_series(1, 25) g');
    expect(await relTuples()).toBe(25);
    // it counts the versions the heap holds, so a delete shows up only once they are vacuumed —
    // PostgreSQL is no different here (only VACUUM / ANALYZE move its reltuples)
    await client.query('insert into live select g, g from generate_series(100, 109) g');
    expect(await relTuples()).toBe(35);

    // and the rows that DO follow from the catalog still track it across a DDL
    expect((await q(`select count(*)::int as n from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname = 'live' and a.attnum > 0`))[0].n).toBe(2);
    await client.query('alter table live add column tag text');
    expect((await q(`select count(*)::int as n from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname = 'live' and a.attnum > 0`))[0].n).toBe(3);
    await client.end();
  });
});
