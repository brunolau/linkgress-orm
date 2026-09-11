import { describe, test, expect } from '@jest/globals';
import {
  buildCreateIndexStatement,
  modelIndexSignature,
  parseDbIndexSignature,
  compareIndexDefinition,
} from '../../src/migration/index-sql';

/**
 * `INCLUDE` (covering) columns — the pure SQL half: rendering, parsing the live
 * definition back, and comparing the two.
 *
 * The `db` strings are the canonical `pg_get_indexdef(oid, 0, true)` form, which
 * PostgreSQL deparses as `(keys) INCLUDE (cols) [NULLS NOT DISTINCT] [WHERE ...]`.
 * Before INCLUDE support the parser gave up on any definition carrying the clause
 * and reported it as unchanged, so a changed INCLUDE list was never recreated.
 */

describe('INCLUDE columns: CREATE INDEX rendering', () => {
  test('renders INCLUDE right after the key column list', () => {
    expect(buildCreateIndexStatement(
      { name: 'ix_cover', columns: ['book_id', 'is_active'], include: ['loaned_at', 'reader_id'] },
      '"book_loan"'
    )).toBe('CREATE INDEX "ix_cover" ON "book_loan" ("book_id", "is_active") INCLUDE ("loaned_at", "reader_id")');
  });

  test('keeps PostgreSQL grammar order: INCLUDE, then NULLS NOT DISTINCT, then WHERE', () => {
    expect(buildCreateIndexStatement(
      {
        name: 'uq_cover',
        columns: ['isbn'],
        include: ['title'],
        isUnique: true,
        nullsNotDistinct: true,
        where: 'archived = false',
      },
      '"book"',
      { concurrent: true, ifNotExists: true }
    )).toBe('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_cover" ON "book" ("isbn") INCLUDE ("title") NULLS NOT DISTINCT WHERE archived = false');
  });

  test('an empty include list renders no INCLUDE clause', () => {
    expect(buildCreateIndexStatement({ name: 'ix_plain', columns: ['book_id'], include: [] }, '"book_loan"'))
      .toBe('CREATE INDEX "ix_plain" ON "book_loan" ("book_id")');
  });
});

describe('INCLUDE columns: signature parsing and comparison', () => {
  const dbCovering = 'CREATE INDEX ix_cover ON public.book_loan USING btree (book_id, is_active) INCLUDE (loaned_at, reader_id)';

  test('parses the INCLUDE clause of a live definition instead of giving up on it', () => {
    const sig = parseDbIndexSignature(dbCovering);
    expect(sig).not.toBeNull();
    expect(sig!.columns).toBe('book_id, is_active');
    expect(sig!.include).toBe('loaned_at, reader_id');
    expect(sig!.where).toBe('');
  });

  test('parses INCLUDE together with NULLS NOT DISTINCT and WHERE', () => {
    expect(parseDbIndexSignature(
      'CREATE UNIQUE INDEX uq_cover ON public.book USING btree (isbn) INCLUDE (title) NULLS NOT DISTINCT WHERE archived = false'
    )).toEqual({
      isUnique: true,
      method: 'btree',
      columns: 'isbn',
      include: 'title',
      where: 'archived = false',
      nullsNotDistinct: true,
    });
  });

  test('a model declaring the same INCLUDE list is unchanged (no churn)', () => {
    const cmp = compareIndexDefinition(dbCovering, {
      name: 'ix_cover',
      columns: ['book_id', 'is_active'],
      include: ['loaned_at', 'reader_id'],
    });
    expect(cmp.changed).toBe(false);
  });

  test('detects INCLUDE added to a plain index', () => {
    const cmp = compareIndexDefinition(
      'CREATE INDEX ix_cover ON public.book_loan USING btree (book_id, is_active)',
      { name: 'ix_cover', columns: ['book_id', 'is_active'], include: ['loaned_at'] }
    );
    expect(cmp.changed).toBe(true);
    expect(cmp.reason).toBe('include (none) -> (loaned_at)');
  });

  test('detects INCLUDE removed from a covering index', () => {
    const cmp = compareIndexDefinition(dbCovering, { name: 'ix_cover', columns: ['book_id', 'is_active'] });
    expect(cmp.changed).toBe(true);
    expect(cmp.reason).toBe('include (loaned_at, reader_id) -> (none)');
  });

  test('detects a changed INCLUDE list', () => {
    const cmp = compareIndexDefinition(dbCovering, {
      name: 'ix_cover',
      columns: ['book_id', 'is_active'],
      include: ['loaned_at', 'returned_at', 'reader_id'],
    });
    expect(cmp.changed).toBe(true);
    expect(cmp.reason).toBe('include (loaned_at, reader_id) -> (loaned_at, returned_at, reader_id)');
  });

  test('moving a column between the key and INCLUDE is a change on both sides', () => {
    const cmp = compareIndexDefinition(dbCovering, {
      name: 'ix_cover',
      columns: ['book_id', 'is_active', 'loaned_at'],
      include: ['reader_id'],
    });
    expect(cmp.changed).toBe(true);
    expect(cmp.reason).toContain('columns (book_id, is_active) -> (book_id, is_active, loaned_at)');
    expect(cmp.reason).toContain('include (loaned_at, reader_id) -> (reader_id)');
  });

  test('a model without include normalizes to an empty INCLUDE signature', () => {
    expect(modelIndexSignature({ name: 'ix', columns: ['book_id'] }).include).toBe('');
    expect(modelIndexSignature({ name: 'ix', columns: ['book_id'], include: [] }).include).toBe('');
  });

  test('definitions with clauses the model still cannot express stay "unknown"', () => {
    // WITH (...) storage parameters are not modelled: keep the conservative
    // null so such an index is never rebuilt on every run.
    expect(parseDbIndexSignature(
      'CREATE INDEX ix_cover ON public.book_loan USING btree (book_id) INCLUDE (reader_id) WITH (fillfactor=70)'
    )).toBeNull();
  });
});
