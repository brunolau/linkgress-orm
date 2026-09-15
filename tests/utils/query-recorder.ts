import { appendFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import type { DatabaseClient } from '../../src';

/**
 * LINKGRESS_TEST_RECORD_DIR=<dir>: record every statement the harness's clients run, per test
 * and in order, with a digest of what came back. Two recorded runs (e.g. pg and pglite) are
 * then diffed statement by statement by bench/pglite/compare-runs.mjs, which catches result
 * differences no assertion looks at. Off by default — it hashes every row.
 */

const ROOT = join(__dirname, '..', '..');
const statementsPerTest = new Map<string, number>();

/**
 * now() / CURRENT_TIMESTAMP values differ between any two runs, while fixed test data never
 * falls within a day of the moment it is recorded: such timestamps are masked.
 */
const NOW_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ResultDigest {
  rowCount: number | null;
  rows: number;
  /** Hash of the rows in the order returned */
  ordered: string;
  /** Hash of the rows sorted: equals the other run's when only the order differs */
  unordered: string;
  /** The first rows, canonicalized, for the report */
  sample: string;
}

/** A JSON-safe, key-order-independent form of a value that keeps JS types visible. */
function canonical(value: any): any {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $number: String(value) };
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Object.prototype.toString.call(value) === '[object Date]') {
    const time = value.getTime();

    if (Number.isNaN(time)) {
      return { $date: 'Invalid Date' };
    }

    return { $date: Math.abs(time - Date.now()) < NOW_WINDOW_MS ? '<now>' : value.toISOString() };
  }

  if (ArrayBuffer.isView(value)) {
    return { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') };
  }

  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  const result: Record<string, any> = {};

  for (const key of Object.keys(value).sort()) {
    result[key] = canonical(value[key]);
  }

  return result;
}

const hash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);

function digest(result: { rows?: any[]; rowCount?: number | null }): ResultDigest {
  const rows = (result.rows ?? []).map(row => JSON.stringify(canonical(row)));

  return {
    rowCount: result.rowCount ?? null,
    rows: rows.length,
    ordered: hash(rows.join('\n')),
    unordered: hash([...rows].sort().join('\n')),
    sample: rows.slice(0, 3).join('\n').slice(0, 800),
  };
}

function currentTest(): { file: string; test: string } {
  let state: any;

  try {
    state = (globalThis as any).expect?.getState?.();
  } catch {
    state = undefined;
  }

  const file = state?.testPath ? relative(ROOT, state.testPath).split(/[\\/]/).join('/') : 'unknown';

  return { file, test: state?.currentTestName ?? '(hook)' };
}

/**
 * Instrument a client in place (its class and extra methods stay intact, so `instanceof` and
 * driver-specific calls in tests keep working) and return it.
 */
export function recordQueries<T extends DatabaseClient>(client: T, dir: string): T {
  mkdirSync(dir, { recursive: true });
  const target = client as any;

  const write = (kind: string, sql: string, params: any[] | undefined, outcome: { result?: ResultDigest; results?: ResultDigest[]; error?: any }) => {
    const { file, test } = currentTest();
    const key = `${file}\u0000${test}`;
    const seq = statementsPerTest.get(key) ?? 0;
    statementsPerTest.set(key, seq + 1);

    const line = {
      file,
      test,
      seq,
      kind,
      sql,
      params: hash(JSON.stringify(canonical(params ?? []))),
      ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.results ? { results: outcome.results } : {}),
      ...(outcome.error
        ? { error: { code: outcome.error?.code ?? null, message: String(outcome.error?.message ?? outcome.error).slice(0, 300) } }
        : {}),
    };

    appendFileSync(join(dir, `${file.replace(/[\\/:]/g, '__')}.jsonl`), JSON.stringify(line) + '\n');
  };

  const recorded = (kind: string, run: (sql: string, params?: any[], options?: any) => Promise<any>) =>
    async (sql: string, params?: any[], options?: any) => {
      try {
        const result = await run(sql, params, options);
        write(kind, sql, params, { result: digest(result) });
        return result;
      } catch (error) {
        write(kind, sql, params, { error });
        throw error;
      }
    };

  target.query = recorded('query', target.query.bind(target));

  if (typeof target.querySimple === 'function') {
    target.querySimple = recorded('simple', target.querySimple.bind(target));
  }

  if (typeof target.querySimpleMulti === 'function') {
    const querySimpleMulti = target.querySimpleMulti.bind(target);

    target.querySimpleMulti = async (sql: string) => {
      try {
        const results = await querySimpleMulti(sql);
        write('multi', sql, undefined, { results: results.map(digest) });
        return results;
      } catch (error) {
        write('multi', sql, undefined, { error });
        throw error;
      }
    };
  }

  const transaction = target.transaction.bind(target);
  target.transaction = (callback: (query: any) => Promise<any>) => transaction((query: any) => callback(recorded('tx', query)));

  const connect = target.connect.bind(target);
  target.connect = async () => {
    const connection = await connect();
    connection.query = recorded('conn', connection.query.bind(connection));
    return connection;
  };

  return client;
}
