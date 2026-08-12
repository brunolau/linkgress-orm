// Seeds the QueryBatch benchmark database on the native PostgreSQL (127.0.0.1:5432).
// Creates DB `linkgress_querybatch_bench` with 4 tables (~4.1M rows total) and
// deterministic "bench keys": customer/event ids 1..4 own exactly 5/50/500/5000 rows.
import postgres from 'postgres';

const HOST = '127.0.0.1';
const PORT = 5432;
const USER = 'postgres';
const PASS = 'admin';
export const BENCH_DB = 'linkgress_querybatch_bench';

const url = (db) => `postgres://${USER}:${PASS}@${HOST}:${PORT}/${db}`;

const admin = postgres(url('postgres'), { max: 1, prepare: false, onnotice: () => {} });
console.log(`Dropping + creating ${BENCH_DB} ...`);
await admin.unsafe(`DROP DATABASE IF EXISTS ${BENCH_DB} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${BENCH_DB}`);
await admin.end();

const sql = postgres(url(BENCH_DB), { max: 1, prepare: false, onnotice: () => {} });
const step = async (label, text) => {
	const t0 = performance.now();
	await sql.unsafe(text).simple();
	console.log(`${label}: ${Math.round(performance.now() - t0)}ms`);
};

await step('schema', `
CREATE TABLE users (
	id int PRIMARY KEY,
	email text NOT NULL,
	name text NOT NULL,
	created_at timestamptz NOT NULL,
	balance numeric(12,2) NOT NULL,
	is_active boolean NOT NULL
);
CREATE TABLE orders (
	id int PRIMARY KEY,
	customer_id int NOT NULL,
	name text NOT NULL,
	note text NOT NULL,
	total numeric(12,2) NOT NULL,
	state text NOT NULL,
	created_at timestamptz NOT NULL
);
CREATE TABLE tickets (
	id int PRIMARY KEY,
	event_id int NOT NULL,
	price numeric(10,2) NOT NULL,
	seat text NOT NULL,
	sold_at timestamptz NOT NULL
);
CREATE TABLE payments (
	id int PRIMARY KEY,
	customer_id int NOT NULL,
	amount numeric(12,2) NOT NULL,
	method text NOT NULL,
	paid_at timestamptz NOT NULL
);`);

await step('users 100k', `
INSERT INTO users
SELECT g,
	'user' || g || '@example.com',
	'User ' || g,
	timestamptz '2024-01-01' + (g % 730) * interval '1 day' + (g % 86400) * interval '1 second',
	((g * 37) % 100000000)::numeric / 100,
	g % 7 <> 0
FROM generate_series(1, 100000) g;`);

await step('orders 1M bulk', `
INSERT INTO orders
SELECT g,
	1000 + (g % 90000),
	'Order #' || g || ' ' || md5(g::text),
	repeat('Lorem ipsum dolor sit amet ', 4) || md5((g * 7)::text),
	((g * 131) % 50000000)::numeric / 100,
	(ARRAY['new','paid','shipped','cancelled','refunded'])[1 + g % 5],
	timestamptz '2024-01-01' + (g % 900) * interval '1 day' + (g % 86400) * interval '1 second'
FROM generate_series(1, 1000000) g;`);

await step('orders bench keys (5/50/500/5000)', `
INSERT INTO orders
SELECT 1000000 + row_number() OVER (),
	s.cust,
	'Order special ' || md5(n::text),
	repeat('Note text padding ', 7) || md5((n * 3)::text),
	((n * 97) % 40000000)::numeric / 100,
	(ARRAY['new','paid','shipped'])[1 + n % 3],
	timestamptz '2025-01-01' + (n % 400) * interval '1 day' + n * interval '1 minute'
FROM (VALUES (1, 5), (2, 50), (3, 500), (4, 5000)) AS s(cust, cnt),
	LATERAL generate_series(1, s.cnt) n;`);

await step('tickets 2M bulk', `
INSERT INTO tickets
SELECT g,
	1000 + (g % 20000),
	((g * 53) % 3000000)::numeric / 100,
	'S' || (g % 40) || '-' || (g % 500),
	timestamptz '2024-06-01' + (g % 500) * interval '1 day' + (g % 43200) * interval '1 second'
FROM generate_series(1, 2000000) g;`);

await step('tickets bench keys', `
INSERT INTO tickets
SELECT 2000000 + row_number() OVER (),
	s.ev,
	((n * 71) % 2500000)::numeric / 100,
	'SP-' || n,
	timestamptz '2025-03-01' + n * interval '90 second'
FROM (VALUES (1, 5), (2, 50), (3, 500), (4, 5000)) AS s(ev, cnt),
	LATERAL generate_series(1, s.cnt) n;`);

await step('payments 1M bulk', `
INSERT INTO payments
SELECT g,
	1000 + (g % 90000),
	((g * 211) % 30000000)::numeric / 100,
	(ARRAY['card','transfer','cash','apple_pay'])[1 + g % 4],
	timestamptz '2024-01-01' + (g % 800) * interval '1 day' + (g % 86400) * interval '1 second'
FROM generate_series(1, 1000000) g;`);

await step('payments bench keys', `
INSERT INTO payments
SELECT 1000000 + row_number() OVER (),
	s.cust,
	((n * 13) % 20000000)::numeric / 100,
	(ARRAY['card','transfer'])[1 + n % 2],
	timestamptz '2025-02-01' + n * interval '5 minute'
FROM (VALUES (1, 5), (2, 50), (3, 500), (4, 5000)) AS s(cust, cnt),
	LATERAL generate_series(1, s.cnt) n;`);

await step('indexes', `
CREATE INDEX orders_customer_id_idx ON orders(customer_id);
CREATE INDEX orders_customer_created_idx ON orders(customer_id, created_at DESC);
CREATE INDEX tickets_event_id_idx ON tickets(event_id);
CREATE INDEX payments_customer_id_idx ON payments(customer_id);`);

await step('vacuum analyze', `VACUUM ANALYZE;`);

const counts = await sql.unsafe(`
SELECT (SELECT count(*) FROM users) AS users,
	(SELECT count(*) FROM orders) AS orders,
	(SELECT count(*) FROM tickets) AS tickets,
	(SELECT count(*) FROM payments) AS payments`);
console.log('row counts:', counts[0]);

const benchKeys = await sql.unsafe(`
SELECT 'orders' t, customer_id k, count(*) FROM orders WHERE customer_id <= 4 GROUP BY 2
UNION ALL SELECT 'tickets', event_id, count(*) FROM tickets WHERE event_id <= 4 GROUP BY 2
UNION ALL SELECT 'payments', customer_id, count(*) FROM payments WHERE customer_id <= 4 GROUP BY 2
ORDER BY 1, 2`);
console.table(benchKeys.map((r) => ({ table: r.t, key: r.k, rows: Number(r.count) })));

await sql.end();
console.log('SEED DONE');
