import { appendFileSync } from 'fs';
import { BunClient, PGliteClient, PgClient, PostgresClient } from '../../src';
import type { DatabaseClient, PooledConnection } from '../../src';

/**
 * Bound parameters against the `$N` placeholders of the statement they are sent with.
 *
 * A builder that renders an operand — pushing the operand's parameters into the statement's list — and
 * then discards the rendered text leaves those parameters bound but referenced by no `$N`. PostgreSQL
 * fails such a statement (`could not determine data type of parameter $N`, or a bind-count mismatch),
 * and a batch that splices the statement into a bigger one moves the orphan into the middle of the
 * combined list. The suite checks every statement it sends ({@link installParamAudit}) — the failure then
 * names the statement and the parameters, whatever the engine — and a spec can check the statements it
 * captured ({@link auditStatementParams}).
 */

/** The positions a statement's parameters fail the audit at. */
export interface ParamAuditFinding {
  /** 1-based positions of bound parameters no `$N` of the statement references */
  unreferenced: number[];
  /** `$N` the statement references with no parameter bound for it */
  unbound: number[];
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/** A character that continues an identifier — a `$` after one is part of the name (`a$1`), not a placeholder. */
const isIdentifierChar = (ch: string | undefined): boolean => ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch > '\u007f');

/** Where a `'…'` / `"…"` segment opened at `open` ends (the index after its closing quote). */
const skipQuoted = (sqlText: string, open: number, quote: string, backslashEscapes: boolean): number => {
  let at = open + 1;

  while (at < sqlText.length) {
    const ch = sqlText[at];

    if (backslashEscapes && ch === '\\') {
      at += 2;
    } else if (ch === quote) {
      if (sqlText[at + 1] !== quote) {
        return at + 1;
      }

      // a doubled quote is part of the content
      at += 2;
    } else {
      at++;
    }
  }

  return sqlText.length;
};

/** Where a block comment opened at `open` ends — PostgreSQL nests them. */
const skipBlockComment = (sqlText: string, open: number): number => {
  let depth = 0;
  let at = open;

  while (at < sqlText.length) {
    if (sqlText[at] === '/' && sqlText[at + 1] === '*') {
      depth++;
      at += 2;
    } else if (sqlText[at] === '*' && sqlText[at + 1] === '/') {
      depth--;
      at += 2;

      if (depth === 0) {
        return at;
      }
    } else {
      at++;
    }
  }

  return sqlText.length;
};

const DOLLAR_QUOTE_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * The `$N` placeholders a statement references: outside string literals (`'…'`, `E'…'` with backslash
 * escapes), quoted identifiers, dollar-quoted strings (`$$…$$`, `$tag$…$tag$`) and comments (`--`,
 * nested block comments), and not inside an identifier (`a$1`).
 */
export function referencedPlaceholders(sqlText: string): Set<number> {
  const found = new Set<number>();
  const length = sqlText.length;
  let at = 0;

  while (at < length) {
    const ch = sqlText[at];

    if (ch === '\'') {
      // E'…' (or e'…') is an escape string: a backslash escapes the character after it
      const prefix = sqlText[at - 1];
      const escapeString = (prefix === 'E' || prefix === 'e') && !isIdentifierChar(sqlText[at - 2]);
      at = skipQuoted(sqlText, at, '\'', escapeString);
    } else if (ch === '"') {
      at = skipQuoted(sqlText, at, '"', false);
    } else if (ch === '-' && sqlText[at + 1] === '-') {
      const newline = sqlText.indexOf('\n', at + 2);
      at = newline < 0 ? length : newline + 1;
    } else if (ch === '/' && sqlText[at + 1] === '*') {
      at = skipBlockComment(sqlText, at);
    } else if (ch === '$' && !isIdentifierChar(sqlText[at - 1])) {
      if (isDigit(sqlText[at + 1])) {
        let end = at + 1;

        while (isDigit(sqlText[end])) {
          end++;
        }

        found.add(Number(sqlText.slice(at + 1, end)));
        at = end;
        continue;
      }

      const tag = DOLLAR_QUOTE_TAG.exec(sqlText.slice(at, at + 66));

      if (tag) {
        const close = sqlText.indexOf(tag[0], at + tag[0].length);
        at = close < 0 ? length : close + tag[0].length;
      } else {
        at++;
      }
    } else {
      at++;
    }
  }

  return found;
}

/**
 * The parameters of a statement no placeholder references, and the placeholders no parameter is bound
 * for — `undefined` when every bound parameter is referenced and every placeholder has one.
 */
export function auditStatementParams(sqlText: string, params: readonly unknown[] | undefined): ParamAuditFinding | undefined {
  const referenced = referencedPlaceholders(sqlText);
  const bound = params?.length ?? 0;
  const unreferenced: number[] = [];
  const unbound: number[] = [];

  for (let position = 1; position <= bound; position++) {
    if (!referenced.has(position)) {
      unreferenced.push(position);
    }
  }

  for (const position of referenced) {
    if (position < 1 || position > bound) {
      unbound.push(position);
    }
  }

  return unreferenced.length === 0 && unbound.length === 0
    ? undefined
    : { unreferenced, unbound: unbound.sort((a, b) => a - b) };
}

/** The error a statement failing the audit is refused with. */
export class ParamAuditError extends Error {
  constructor(readonly sqlText: string, readonly params: readonly unknown[] | undefined, readonly finding: ParamAuditFinding) {
    const parts = [
      finding.unreferenced.length > 0 ? `binds parameter(s) ${finding.unreferenced.map(p => `$${p}`).join(', ')} that no placeholder references` : '',
      finding.unbound.length > 0 ? `references ${finding.unbound.map(p => `$${p}`).join(', ')} with no parameter bound` : '',
    ].filter(Boolean);
    super(`[param audit] the statement ${parts.join(' and ')} (${params?.length ?? 0} bound):\n${sqlText}`);
    this.name = 'ParamAuditError';
  }
}

type QueryFn = (sql: string, params?: any[], options?: any) => Promise<any>;

/** `query` with the audit in front: a failing statement is refused before it reaches the driver. */
function auditedQuery(query: QueryFn, thisArg: unknown): QueryFn {
  return (sqlText: string, params?: any[], options?: any) => {
    const finding = typeof sqlText === 'string' ? auditStatementParams(sqlText, params) : undefined;

    if (finding !== undefined) {
      const error = new ParamAuditError(sqlText, params, finding);
      const log = process.env.LINKGRESS_TEST_PARAM_AUDIT_LOG;

      if (log) {
        appendFileSync(log, `${JSON.stringify({ file: (globalThis as any).Bun?.main ?? process.argv[1], finding, params: params?.length ?? 0, sql: sqlText })}\n`);
      }

      return Promise.reject(error);
    }

    // called synchronously, so statements reach the driver in the order they were issued
    return query.call(thisArg, sqlText, params, options);
  };
}

let installed = false;

/**
 * Puts {@link auditStatementParams} in front of every statement the built-in clients send with
 * parameters — `query()`, a transaction's query function, a pooled connection's `query()` — for the
 * test process (the preload installs it). The multi-statement simple-protocol calls bind nothing and
 * are left alone. Test-only: the library itself is untouched.
 */
export function installParamAudit(): void {
  if (installed) {
    return;
  }

  installed = true;

  const clientClasses: Array<{ prototype: DatabaseClient }> = [PgClient, PostgresClient, PGliteClient, BunClient];

  for (const { prototype } of clientClasses) {
    const query = prototype.query as QueryFn;
    const transaction = prototype.transaction;
    const connect = prototype.connect;

    prototype.query = function auditedClientQuery(this: DatabaseClient, sqlText: string, params?: any[], options?: any) {
      return auditedQuery(query, this)(sqlText, params, options);
    } as DatabaseClient['query'];

    prototype.transaction = function auditedTransaction<T>(this: DatabaseClient, callback: (query: QueryFn) => Promise<T>): Promise<T> {
      return transaction.call(this, (transactionQuery: QueryFn) => callback(auditedQuery(transactionQuery, undefined))) as Promise<T>;
    } as DatabaseClient['transaction'];

    prototype.connect = async function auditedConnect(this: DatabaseClient): Promise<PooledConnection> {
      const connection = await connect.call(this);
      connection.query = auditedQuery(connection.query as QueryFn, connection) as PooledConnection['query'];

      return connection;
    };
  }
}
