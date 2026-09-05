import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, PgClient } from '../../src';
import type { LogSection, QueryOptions } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { testConnectionConfig } from '../utils/test-database';

/**
 * `logFailedQueries` — a production context keeps per-statement logging OFF
 * (`logQueries: false`) yet still records every statement that FAILS, with the
 * statement text, through the logger's `'error'` section. Without it the only
 * `[SQL Error]` line linkgress emits is gated on `logQueries`, so turning the
 * per-statement firehose off also silenced failures.
 */
describe('logFailedQueries', () => {
  let client: PgClient;

  interface Entry {
    msg: string;
    section?: LogSection;
  }

  const recorder = () => {
    const entries: Entry[] = [];
    const logger = (msg: string, section?: LogSection) => {
      entries.push({ msg, section });
    };
    const ofSection = (section: LogSection) => entries.filter(e => e.section === section);
    return { entries, logger, ofSection };
  };

  const contextWith = (options: QueryOptions) => new AppDatabase(client, { collectionStrategy: 'cte', ...options });

  /** A statement that PostgreSQL rejects at execution: a text literal bound to the integer `id`. */
  const failingRead = (db: AppDatabase) => db.users.where(u => eq(u.id, 'not-a-number' as unknown as number)).toList();

  beforeAll(() => {
    const cfg = testConnectionConfig();
    client = new PgClient({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.username,
      password: cfg.password,
    });
  });

  afterAll(async () => {
    await client.end();
  });

  test('logs the failed statement with its SQL when logQueries is off and logFailedQueries is on', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: false, logFailedQueries: true, logger: rec.logger });

    await expect(failingRead(db)).rejects.toThrow(/invalid input syntax for type integer/);

    const errors = rec.ofSection('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('[SQL Error]');
    expect(errors[0].msg).toContain('invalid input syntax for type integer');
    expect(errors[0].msg).toMatch(/SELECT[\s\S]*FROM/);
    // per-statement logging stayed off — nothing but the failure was reported
    expect(rec.ofSection('sql')).toHaveLength(0);
    expect(rec.ofSection('params')).toHaveLength(0);
  });

  test('stays silent on a failed statement when logQueries is off and logFailedQueries is not set', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: false, logger: rec.logger });

    await expect(failingRead(db)).rejects.toThrow();

    expect(rec.entries).toHaveLength(0);
  });

  test('an explicit logFailedQueries: false suppresses the failure line even with logQueries on', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: true, logFailedQueries: false, logger: rec.logger });

    await expect(failingRead(db)).rejects.toThrow();

    expect(rec.ofSection('sql').length).toBeGreaterThan(0);
    expect(rec.ofSection('error')).toHaveLength(0);
  });

  test('appends the parameters to the failure line when logParameters is on', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: false, logFailedQueries: true, logParameters: true, logger: rec.logger });

    await expect(failingRead(db)).rejects.toThrow();

    const [entry] = rec.ofSection('error');
    expect(entry.msg).toContain('[Parameters] ["not-a-number"]');
  });

  test('keeps the parameters out of the failure line when logParameters is off', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: false, logFailedQueries: true, logParameters: false, logger: rec.logger });

    await expect(failingRead(db)).rejects.toThrow();

    // PostgreSQL itself quotes the offending literal in its message, so the assertion is
    // on the parameters LINE, not on the value.
    const [entry] = rec.ofSection('error');
    expect(entry.msg).not.toContain('[Parameters]');
  });

  test('logs a failed statement issued inside a transaction', async () => {
    const rec = recorder();
    const db = contextWith({ logQueries: false, logFailedQueries: true, logger: rec.logger });

    await expect(db.transaction(async ctx => failingRead(ctx))).rejects.toThrow(/invalid input syntax for type integer/);

    const errors = rec.ofSection('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('[SQL Error]');
    expect(errors[0].msg).toMatch(/SELECT[\s\S]*FROM/);
  });

  test('withQueryOptions({ logFailedQueries }) enables the failure line on a context without logging', async () => {
    const rec = recorder();
    const db = contextWith({});

    await expect(
      db.users.withQueryOptions({ logFailedQueries: true, logger: rec.logger }).where(u => eq(u.id, 'not-a-number' as unknown as number)).toList()
    ).rejects.toThrow();

    expect(rec.ofSection('error')).toHaveLength(1);
  });
});
