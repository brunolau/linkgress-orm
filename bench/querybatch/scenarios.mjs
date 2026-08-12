// Dashboard-shaped query scenarios. Each query: { key, kind: list|first|count, sql, params }.
// Bench keys: customer/event ids 1..4 own exactly 5/50/500/5000 rows (see seed.mjs);
// bulk keys >= 1000 own ~11 orders / ~100 tickets / ~11 payments each.

const ORDER_COLS = 'id, customer_id, name, total, state, created_at';
const PAYMENT_COLS = 'id, customer_id, amount, method, paid_at';
const TICKET_COLS = 'id, event_id, price, seat, sold_at';

const ordersByCustomer = (key, cust) => ({
	key,
	kind: 'list',
	sql: `SELECT ${ORDER_COLS} FROM orders WHERE customer_id = $1 ORDER BY id`,
	params: [cust],
});

const paymentsByCustomer = (key, cust) => ({
	key,
	kind: 'list',
	sql: `SELECT ${PAYMENT_COLS} FROM payments WHERE customer_id = $1 ORDER BY id`,
	params: [cust],
});

const ticketsByEvent = (key, ev) => ({
	key,
	kind: 'list',
	sql: `SELECT ${TICKET_COLS} FROM tickets WHERE event_id = $1 ORDER BY id`,
	params: [ev],
});

const bigList = (key, table, filterCol, id, limit) => {
	const cols = table === 'orders' ? ORDER_COLS : table === 'tickets' ? TICKET_COLS : PAYMENT_COLS;

	return {
		key,
		kind: 'list',
		sql: `SELECT ${cols} FROM ${table} WHERE ${filterCol} = $1 ORDER BY id LIMIT $2`,
		params: [id, limit],
	};
};

// S — typical dashboard: 12 queries, ~185 rows
const S = [
	ordersByCustomer('ordersC2', 2), // 50 rows
	paymentsByCustomer('paymentsC2', 2), // 50 rows
	ticketsByEvent('ticketsE2', 2), // 50 rows
	ordersByCustomer('ordersC1', 1), // 5 rows
	{
		key: 'recentOrdersC3',
		kind: 'list',
		sql: `SELECT id, name, total, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`,
		params: [3, 10],
	},
	{
		key: 'usersPage',
		kind: 'list',
		sql: `SELECT id, email, name, balance, created_at FROM users WHERE id BETWEEN $1 AND $2 ORDER BY id`,
		params: [500, 519],
	},
	{
		key: 'user42',
		kind: 'first',
		sql: `SELECT id, email, name, balance, created_at, is_active FROM users WHERE id = $1`,
		params: [42],
	},
	{
		key: 'lastOrderC3',
		kind: 'first',
		sql: `SELECT id, name, total, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
		params: [3],
	},
	{
		key: 'statsC3',
		kind: 'first',
		sql: `SELECT count(*)::int AS order_count, coalesce(sum(total), 0) AS revenue FROM orders WHERE customer_id = $1`,
		params: [3],
	},
	{ key: 'cntOrdersC4', kind: 'count', sql: `SELECT count(*)::int AS count FROM orders WHERE customer_id = $1`, params: [4] },
	{ key: 'cntTicketsE3', kind: 'count', sql: `SELECT count(*)::int AS count FROM tickets WHERE event_id = $1`, params: [3] },
	{ key: 'cntPaymentsC3', kind: 'count', sql: `SELECT count(*)::int AS count FROM payments WHERE customer_id = $1`, params: [3] },
];

// M — heavy dashboard: 30 queries, ~2400 rows (S + 12 bulk-key widgets + 500-row lists + more stats)
const M = [
	...S,
	...[0, 1, 2, 3].map((i) => ordersByCustomer(`ordersB${i}`, 1000 + i * 7)), // ~11 rows each
	...[0, 1, 2, 3].map((i) => ticketsByEvent(`ticketsB${i}`, 1000 + i * 13)), // ~100 rows each
	...[0, 1, 2, 3].map((i) => paymentsByCustomer(`paymentsB${i}`, 1000 + i * 11)), // ~11 rows each
	ordersByCustomer('ordersC3full', 3), // 500 rows
	ticketsByEvent('ticketsE3full', 3), // 500 rows
	paymentsByCustomer('paymentsC3full', 3), // 500 rows
	{
		key: 'topSpenders',
		kind: 'list',
		sql: `SELECT customer_id, count(*)::int AS cnt, sum(amount) AS total FROM payments WHERE customer_id BETWEEN $1 AND $2 GROUP BY customer_id ORDER BY total DESC LIMIT $3`,
		params: [1000, 1200, 10],
	},
	{
		key: 'lastPaymentC3',
		kind: 'first',
		sql: `SELECT ${PAYMENT_COLS} FROM payments WHERE customer_id = $1 ORDER BY paid_at DESC LIMIT 1`,
		params: [3],
	},
	{ key: 'cntUsers', kind: 'count', sql: `SELECT count(*)::int AS count FROM users WHERE id BETWEEN $1 AND $2`, params: [1, 50000] },
];

// L — stress / big lists: 10 queries x 2000 rows = 20k rows (~4MB payload)
const L = [
	bigList('bigOrders1', 'orders', 'customer_id', 4, 2000),
	bigList('bigOrders2', 'orders', 'customer_id', 4, 2000),
	bigList('bigOrders3', 'orders', 'customer_id', 4, 2000),
	bigList('bigTickets1', 'tickets', 'event_id', 4, 2000),
	bigList('bigTickets2', 'tickets', 'event_id', 4, 2000),
	bigList('bigTickets3', 'tickets', 'event_id', 4, 2000),
	bigList('bigTickets4', 'tickets', 'event_id', 4, 2000),
	bigList('bigPayments1', 'payments', 'customer_id', 4, 2000),
	bigList('bigPayments2', 'payments', 'customer_id', 4, 2000),
	bigList('bigPayments3', 'payments', 'customer_id', 4, 2000),
];

export const scenarios = { S, M, L };
