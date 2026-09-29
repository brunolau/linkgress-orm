import { describe, test, expect } from 'bun:test';
import { renumberPlaceholders } from '../../src/query/sql-utils';

/**
 * `renumberPlaceholders` is the cross-leg $N rewriter shared by QueryBatch,
 * MutationBatch and insertWithChildren. Its tokenizer must recognize SQL
 * comments as a token class of their own — the original regex only knew
 * string literals and quoted identifiers, so an APOSTROPHE inside a `--`
 * comment (`-- the user's own orders`) opened a phantom string literal that
 * ran to the next apostrophe anywhere later in the statement, leaving every
 * placeholder in between at its STANDALONE number. In a fused MutationBatch
 * (e.g. gopass-eshop's paid-webhook tail) those stale `$N` collide with the
 * preceding legs' bindings and Postgres rejects the whole batch with
 * `operator does not exist: integer = jsonb`.
 */
describe('renumberPlaceholders', () => {
	test('bare placeholders are renumbered by the offset', () => {
		expect(renumberPlaceholders('$1 + $2', 14)).toBe('$15 + $16');
	});

	test('single-quoted literals pass through verbatim (dollar sequences inside are prose)', () => {
		expect(renumberPlaceholders(`'price: $1' = $2`, 10)).toBe(`'price: $1' = $12`);
	});

	test('double-quoted identifiers pass through verbatim', () => {
		expect(renumberPlaceholders(`"col$1" = $2`, 10)).toBe(`"col$1" = $12`);
	});

	test('REGRESSION: an apostrophe inside a -- comment must not open a phantom string literal', () => {
		// Pre-fix: the `user's` apostrophe opened a phantom literal that ran to
		// the next apostrophe, so $2/$3 below kept their standalone numbers.
		const sql = [
			'$1 = 1',
			`-- the user's own orders PLUS their current family`,
			'AND $2 = 2',
			`-- members' household`,
			'AND $3 = 3',
		].join('\n');

		expect(renumberPlaceholders(sql, 10)).toBe([
			'$11 = 1',
			`-- the user's own orders PLUS their current family`,
			'AND $12 = 2',
			`-- members' household`,
			'AND $13 = 3',
		].join('\n'));
	});

	test('dollar sequences inside a -- comment are prose and stay verbatim', () => {
		expect(renumberPlaceholders('$1 -- see $5 above\nAND $2 = 2', 10)).toBe('$11 -- see $5 above\nAND $12 = 2');
	});

	test('a -- comment without a trailing newline is consumed to end-of-input', () => {
		const sql = `$1 AND $2 = 2 -- don't renumber $9`;

		expect(renumberPlaceholders(sql, 10)).toBe(`$11 AND $12 = 2 -- don't renumber $9`);
	});

	test('REGRESSION: block comments with apostrophes and dollar sequences pass through verbatim', () => {
		const sql = `$1 AND /* the user's $7 note */ $2 = 2`;

		expect(renumberPlaceholders(sql, 10)).toBe(`$11 AND /* the user's $7 note */ $12 = 2`);
	});

	test('-- inside a single-quoted literal does NOT start a comment (the literal wins)', () => {
		expect(renumberPlaceholders(`'a--b$3' = $1`, 10)).toBe(`'a--b$3' = $11`);
	});

	test('-- inside a double-quoted identifier does NOT start a comment', () => {
		expect(renumberPlaceholders(`"col--name" = $1`, 10)).toBe(`"col--name" = $11`);
	});

	test('placeholder runs around comments stay correctly sequenced', () => {
		// The shape of the gopass-eshop webhook fold: params, then a commented
		// household arm, then more params — the tail must continue the RENUMBERED
		// sequence, not resume standalone numbering.
		const sql = [
			'SELECT $1::int AS uid, $2, $3',
			'FROM t',
			`WHERE (t.owner = 'x' -- owner's row`,
			'  AND t.a = $4',
			'  AND t.b = $5)',
		].join('\n');

		expect(renumberPlaceholders(sql, 14)).toBe([
			'SELECT $15::int AS uid, $16, $17',
			'FROM t',
			`WHERE (t.owner = 'x' -- owner's row`,
			'  AND t.a = $18',
			'  AND t.b = $19)',
		].join('\n'));
	});
});

/**
 * renumberPlaceholders scans the statement token by token instead of running a regular expression's replace
 * with a callback per quoted identifier. The scan must do exactly what that replace did — including where the
 * regex backtracks (an unclosed literal or comment is plain text; `'a''` is `'a'` then a new quote) — so it is
 * pinned against it: the replace below is the implementation it took over from.
 */
describe('renumberPlaceholders, token by token, as the regular expression renumbered', () => {
	const QUOTED_OR_PLACEHOLDER = /('(?:[^']|'')*')|("(?:[^"]|"")*")|(--[^\n]*)|(\/\*[\s\S]*?\*\/)|\$(?<digits>\d+)/g;
	const byRegExp = (sqlText: string, offset: number): string =>
		sqlText.replace(QUOTED_OR_PLACEHOLDER, (match, _single, _dbl, _lineComment, _blockComment, digits) =>
			digits !== undefined ? `$${Number(digits) + offset}` : match);

	test('unclosed and doubled quotes, unclosed comments, placeholders at both ends, long digit runs', () => {
		const cases = [
			`'a''`, `'a'' $1`, `"x""y" $2 "z`, `'it''s $1' $2 ''''`, `$1'`, `'$1`, `/* $1`, `/* a */ $1 /* $2`, `/*/ $1 */ $2`,
			'-- $1', '--\n$1', '-$1', '/$1', '$', '$$1', '$0', '$007', '$123456789012345678901234', `'a'b'$1'c'$2`, '"a""""b" $3',
			'', 'no placeholder at all', `$1`, `x$1y$2`, `'\n$1\n'`, '$1\r\n-- $2\r\n$3',
		];

		for (const sqlText of cases) {
			expect({ sqlText, renumbered: renumberPlaceholders(sqlText, 7) }).toEqual({ sqlText, renumbered: byRegExp(sqlText, 7) });
		}
	});

	test('50 000 generated statements of quotes, comments, dollars and digits', () => {
		const pieces = ['\'', '"', '\'\'', '""', '-', '--', '/', '*', '/*', '*/', '$', '$1', '$12', '9', ' ', '\n', 'a', 'x = ', ',', '$$'];
		let seed = 11;
		const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);

		for (let n = 0; n < 50000; n++) {
			const sqlText = Array.from({ length: next() % 14 }, () => pieces[next() % pieces.length]).join('');
			const offset = next() % 40;

			if (renumberPlaceholders(sqlText, offset) !== byRegExp(sqlText, offset)) {
				expect({ sqlText, offset, renumbered: renumberPlaceholders(sqlText, offset) }).toEqual({ sqlText, offset, renumbered: byRegExp(sqlText, offset) });
			}
		}
	});
});
