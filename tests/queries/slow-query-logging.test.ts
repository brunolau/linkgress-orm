import { describe, it, expect } from '@jest/globals';

import { SlowQueryInfo, LogSection, eq } from '../../src';
import { withDatabase } from '../utils/test-database';

/**
 * Tests for the slow-query callback (`onQueryTakingTooLong` +
 * `.expectedExecutionTime(ms)`) and the section-aware logger.
 *
 * Driver-agnostic (the mechanism lives in QueryExecutor), so these run on the
 * shared PgClient harness; per-chain options are injected with
 * `.withQueryOptions(...)`. `withDatabase()` guarantees the schema exists.
 */

describe('Slow-query detection (onQueryTakingTooLong / expectedExecutionTime)', () => {
  it('fires the callback when a query exceeds the threshold, with a user-facing stack', async () => {
    await withDatabase(async (db) => {
      const calls: SlowQueryInfo[] = [];

      // The line below is the user call site that info.stack must point at.
      await db.users
        .withQueryOptions({ onQueryTakingTooLong: (info) => calls.push(info), longRunningQueryThreshold: 0 })
        .select(u => ({ id: u.id }))
        .toList();

      expect(calls).toHaveLength(1);
      const info = calls[0];
      expect(info.sql).toContain('FROM');
      expect(info.durationMs).toBeGreaterThan(0);
      expect(info.thresholdMs).toBe(0);

      // The stack points at THIS test file (the caller of .toList()) and must NOT
      // contain internal linkgress frames (db-context / query-builder).
      expect(info.stack).toContain('slow-query-logging.test');
      expect(info.stack).not.toMatch(/query-builder\.[jt]s/);
      expect(info.stack).not.toMatch(/db-context\.[jt]s/);
      // First user frame is this test, not an ORM internal.
      expect(info.stack.split('\n')[0]).toContain('slow-query-logging.test');
    });
  });

  it('does NOT fire when the query is within the threshold', async () => {
    await withDatabase(async (db) => {
      const calls: SlowQueryInfo[] = [];
      await db.users
        .withQueryOptions({ onQueryTakingTooLong: (info) => calls.push(info), longRunningQueryThreshold: 60000 })
        .select(u => ({ id: u.id }))
        .toList();
      expect(calls).toHaveLength(0);
    });
  });

  it('.expectedExecutionTime(ms) overrides the context default threshold', async () => {
    await withDatabase(async (db) => {
      const calls: SlowQueryInfo[] = [];
      await db.users
        .withQueryOptions({ onQueryTakingTooLong: (info) => calls.push(info), longRunningQueryThreshold: 60000 })
        .select(u => ({ id: u.id }))
        .expectedExecutionTime(0) // override the 60s default to 0 → fires
        .toList();
      expect(calls).toHaveLength(1);
      expect(calls[0].thresholdMs).toBe(0);
    });
  });

  it('does nothing when no callback is configured (detection disabled)', async () => {
    await withDatabase(async (db) => {
      // .expectedExecutionTime is a harmless no-op without a callback.
      const rows = await db.users.select(u => ({ id: u.id })).expectedExecutionTime(0).toList();
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});

describe('Section-aware logger', () => {
  it('passes a LogSection to the logger for each part (sql / params / timing)', async () => {
    await withDatabase(async (db) => {
      const entries: Array<{ message: string; section?: LogSection }> = [];
      await db.users
        .withQueryOptions({
          logQueries: true,
          logParameters: true,
          logExecutionTime: true,
          logger: (message, section) => entries.push({ message, section }),
        })
        .where(u => eq(u.id, 1))
        .select(u => ({ id: u.id }))
        .toList();

      const sections = new Set(entries.map(e => e.section));
      expect(sections.has('sql')).toBe(true);     // the query text
      expect(sections.has('params')).toBe(true);  // eq(u.id, 1) → $1
      expect(sections.has('timing')).toBe(true);  // execution time
      // The legacy 'debug' level is gone — sections are semantic now.
      expect(sections.has('debug' as any)).toBe(false);

      const sqlEntry = entries.find(e => e.section === 'sql' && e.message.includes('SELECT'));
      expect(sqlEntry).toBeDefined();
    });
  });

  it('can be disabled granularly (logQueries off → no sql/params sections)', async () => {
    await withDatabase(async (db) => {
      const entries: Array<{ message: string; section?: LogSection }> = [];
      await db.users
        .withQueryOptions({
          logQueries: false,
          logExecutionTime: true,
          logger: (message, section) => entries.push({ message, section }),
        })
        .select(u => ({ id: u.id }))
        .toList();

      const sections = new Set(entries.map(e => e.section));
      expect(sections.has('sql')).toBe(false);
      expect(sections.has('params')).toBe(false);
      expect(sections.has('timing')).toBe(true);
    });
  });
});
