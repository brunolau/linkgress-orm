import {
  buildIndexColumnList,
  buildCreateIndexStatement,
  buildDropIndexStatement,
  normalizeIndexFragment,
  modelIndexSignature,
  parseDbIndexSignature,
  compareIndexDefinition,
  indexCanonicalSignature,
  canonicalDefsEquivalent,
  IndexSqlSpec,
} from '../../src/migration/index-sql';

/**
 * The `db` strings below are the VERBATIM canonical output of
 * `pg_get_indexdef(oid, 0, true)` captured against a real PostgreSQL 16 for the
 * exact CREATE INDEX statements the ORM emits (see debug probe). Each `model`
 * is the corresponding `IndexDefinition` the entity builder produces. They MUST
 * compare equal — otherwise the auto-migrator would rebuild these indexes on
 * every run.
 */
const UNCHANGED_CASES: Array<{ name: string; model: IndexSqlSpec; db: string }> = [
  {
    name: 'plain single column',
    model: { name: 'ix_plain', columns: ['col_a'] },
    db: 'CREATE INDEX ix_plain ON probe_idx.t USING btree (col_a)',
  },
  {
    name: 'composite',
    model: { name: 'ix_comp', columns: ['col_a', 'col_b'] },
    db: 'CREATE INDEX ix_comp ON probe_idx.t USING btree (col_a, col_b)',
  },
  {
    name: 'unique',
    model: { name: 'ix_uniq', columns: ['email'], isUnique: true },
    db: 'CREATE UNIQUE INDEX ix_uniq ON probe_idx.t USING btree (email)',
  },
  {
    name: 'separate operator class',
    model: { name: 'ix_opc', columns: ['name'], operatorClass: 'text_pattern_ops' },
    db: 'CREATE INDEX ix_opc ON probe_idx.t USING btree (name text_pattern_ops)',
  },
  {
    name: 'gin trigram',
    model: { name: 'ix_gin', columns: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops' },
    db: 'CREATE INDEX ix_gin ON probe_idx.t USING gin (name gin_trgm_ops)',
  },
  {
    name: 'ixNormalized btree (text column)',
    model: {
      name: 'ix_norm',
      columns: ['name'],
      expressions: ['public.search_normalize("name") text_pattern_ops'],
    },
    db: 'CREATE INDEX ix_norm ON probe_idx.t USING btree (search_normalize(name) text_pattern_ops)',
  },
  {
    name: 'ixNormalized btree (varchar column -> ::text cast injected by PG)',
    model: {
      name: 'ix_normv',
      columns: ['email'],
      expressions: ['public.search_normalize("email") text_pattern_ops'],
    },
    db: 'CREATE INDEX ix_normv ON probe_idx.t USING btree (search_normalize(email::text) text_pattern_ops)',
  },
  {
    name: 'ixNormalized gin',
    model: {
      name: 'ix_normgin',
      columns: ['name'],
      using: 'gin',
      operatorClass: 'gin_trgm_ops',
      expressions: ['public.search_normalize("name")'],
    },
    db: 'CREATE INDEX ix_normgin ON probe_idx.t USING gin (search_normalize(name) gin_trgm_ops)',
  },
  {
    name: 'partial',
    model: { name: 'ix_part', columns: ['name'], where: 'active = true' },
    db: 'CREATE INDEX ix_part ON probe_idx.t USING btree (name) WHERE active = true',
  },
  {
    name: 'partial complex (PG strips redundant parens)',
    model: { name: 'ix_part2', columns: ['name'], where: 'active = true AND col_a > 0' },
    db: 'CREATE INDEX ix_part2 ON probe_idx.t USING btree (name) WHERE active = true AND col_a > 0',
  },
  {
    name: 'composite: normalized varchar + plain column, unique',
    model: {
      name: 'ix_mix',
      columns: ['email', 'hash'],
      isUnique: true,
      expressions: ['public.search_normalize("email") text_pattern_ops', '"hash"'],
    },
    db: 'CREATE UNIQUE INDEX ix_mix ON probe_idx.t USING btree (search_normalize(email::text) text_pattern_ops, hash)',
  },
];

describe('index-sql: unchanged definitions must NOT be flagged as changed', () => {
  for (const c of UNCHANGED_CASES) {
    it(c.name, () => {
      const result = compareIndexDefinition(c.db, c.model);
      expect(result.dbSignature).not.toBeNull();
      expect(result.changed).toBe(false);
    });
  }
});

describe('index-sql: genuine signature changes ARE detected', () => {
  it('adding an operator class', () => {
    const db = 'CREATE INDEX ix ON t USING btree (name)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['name'], operatorClass: 'text_pattern_ops' };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('switching btree -> gin', () => {
    const db = 'CREATE INDEX ix ON t USING btree (name)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops' };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('dropping uniqueness', () => {
    const db = 'CREATE UNIQUE INDEX ix ON t USING btree (email)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['email'] };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('adding a column', () => {
    const db = 'CREATE INDEX ix ON t USING btree (col_a)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['col_a', 'col_b'] };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('adding a partial predicate', () => {
    const db = 'CREATE INDEX ix ON t USING btree (name)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['name'], where: 'active = true' };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('changing a partial predicate', () => {
    const db = 'CREATE INDEX ix ON t USING btree (name) WHERE active = true';
    const model: IndexSqlSpec = { name: 'ix', columns: ['name'], where: 'active = false' };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });

  it('changing operator class on an ixNormalized index (btree text_pattern_ops -> gin trgm)', () => {
    const db = 'CREATE INDEX ix ON t USING btree (search_normalize(name) text_pattern_ops)';
    const model: IndexSqlSpec = {
      name: 'ix',
      columns: ['name'],
      using: 'gin',
      operatorClass: 'gin_trgm_ops',
      expressions: ['public.search_normalize("name")'],
    };
    expect(compareIndexDefinition(db, model).changed).toBe(true);
  });
});

describe('index-sql: conservative handling of unparseable / unsupported definitions', () => {
  it('returns null signature and changed=false for an INCLUDE (covering) index', () => {
    const db = 'CREATE INDEX ix ON t USING btree (a) INCLUDE (b)';
    const result = compareIndexDefinition(db, { name: 'ix', columns: ['a'] });
    expect(result.dbSignature).toBeNull();
    expect(result.changed).toBe(false);
  });

  it('returns null signature for garbage input', () => {
    expect(parseDbIndexSignature('not an index def')).toBeNull();
  });
});

describe('index-sql: normalizeIndexFragment', () => {
  it('strips quotes, public. prefix and ::text casts', () => {
    expect(normalizeIndexFragment('public.search_normalize("email"::text) text_pattern_ops'))
      .toBe('search_normalize(email) text_pattern_ops');
  });

  it('removes multi-word type casts without eating trailing tokens', () => {
    expect(normalizeIndexFragment('foo(x::timestamp with time zone) bar'))
      .toBe('foo(x) bar');
  });

  it('does not corrupt text_pattern_ops following a ::text cast', () => {
    expect(normalizeIndexFragment('search_normalize(email::text) text_pattern_ops'))
      .toBe('search_normalize(email) text_pattern_ops');
  });
});

describe('index-sql: SQL builders', () => {
  it('buildIndexColumnList applies operator class per column', () => {
    expect(buildIndexColumnList({ name: 'i', columns: ['a', 'b'], operatorClass: 'gin_trgm_ops' }))
      .toBe('"a" gin_trgm_ops, "b" gin_trgm_ops');
  });

  it('buildIndexColumnList uses raw expressions when present', () => {
    expect(buildIndexColumnList({ name: 'i', columns: ['name'], expressions: ['lower("name")'] }))
      .toBe('lower("name")');
  });

  it('buildCreateIndexStatement matches the legacy live-path format', () => {
    const sql = buildCreateIndexStatement(
      { name: 'ix_norm', columns: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops', expressions: ['public.search_normalize("name")'] },
      '"public"."users"',
      { concurrent: false, ifNotExists: true }
    );
    expect(sql).toBe('CREATE INDEX IF NOT EXISTS "ix_norm" ON "public"."users" USING gin (public.search_normalize("name") gin_trgm_ops)');
  });

  it('buildCreateIndexStatement emits UNIQUE + CONCURRENTLY', () => {
    const sql = buildCreateIndexStatement(
      { name: 'ix', columns: ['email'], isUnique: true },
      '"t"',
      { concurrent: true, ifNotExists: true }
    );
    expect(sql).toBe('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ix" ON "t" ("email")');
  });

  it('buildDropIndexStatement supports CONCURRENTLY + IF EXISTS', () => {
    expect(buildDropIndexStatement('"public"."ix"', { concurrent: true, ifExists: true }))
      .toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."ix"');
    expect(buildDropIndexStatement('"ix"')).toBe('DROP INDEX "ix"');
  });
});

describe('index-sql: canonicalDefsEquivalent (Tier-2 authoritative comparison)', () => {
  // Both inputs come from pg_get_indexdef in the same session; equivalent
  // definitions are byte-identical apart from the index name and table.
  const real = "CREATE INDEX ix_real ON public.users USING btree (email) WHERE (created_at > '2020-01-01 00:00:00+01'::timestamp with time zone)";
  const rebuilt = "CREATE INDEX _lkg_idxchk_1_ix0 ON pg_temp_3._lkg_idxchk_1 USING btree (email) WHERE (created_at > '2020-01-01 00:00:00+01'::timestamp with time zone)";

  it('treats two defs that differ only in name/table as equivalent', () => {
    expect(canonicalDefsEquivalent(real, rebuilt)).toBe(true);
  });

  it('detects a UNIQUE difference', () => {
    const uniq = rebuilt.replace('CREATE INDEX', 'CREATE UNIQUE INDEX');
    expect(canonicalDefsEquivalent(real, uniq)).toBe(false);
  });

  it('detects a method difference', () => {
    const gin = 'CREATE INDEX a ON t USING gin (email)';
    const btree = 'CREATE INDEX b ON u USING btree (email)';
    expect(canonicalDefsEquivalent(gin, btree)).toBe(false);
  });

  it('detects a predicate difference', () => {
    const a = 'CREATE INDEX a ON t USING btree (email) WHERE active = true';
    const b = 'CREATE INDEX b ON u USING btree (email) WHERE active = false';
    expect(canonicalDefsEquivalent(a, b)).toBe(false);
  });

  it('indexCanonicalSignature splits unique and the USING-onward body', () => {
    const sig = indexCanonicalSignature(real);
    expect(sig.isUnique).toBe(false);
    expect(sig.body.startsWith('USING btree (email)')).toBe(true);
  });
});

describe('index-sql: NULLS NOT DISTINCT (opt-in, PG15+ unique indexes)', () => {
  // (a) SQL-gen: a UNIQUE index with the flag emits the clause in PostgreSQL's
  // grammar slot — after the column list, before WHERE.
  it('emits " NULLS NOT DISTINCT" after the column list on a UNIQUE index', () => {
    const sql = buildCreateIndexStatement(
      { name: 'uq_ref', columns: ['external_ref'], isUnique: true, nullsNotDistinct: true },
      '"public"."t"'
    );
    expect(sql).toBe('CREATE UNIQUE INDEX "uq_ref" ON "public"."t" ("external_ref") NULLS NOT DISTINCT');
  });

  it('places NULLS NOT DISTINCT between the column list and WHERE', () => {
    const sql = buildCreateIndexStatement(
      { name: 'uq_ref', columns: ['a', 'b'], isUnique: true, nullsNotDistinct: true, where: 'deleted_at IS NULL' },
      '"t"'
    );
    expect(sql).toBe('CREATE UNIQUE INDEX "uq_ref" ON "t" ("a", "b") NULLS NOT DISTINCT WHERE deleted_at IS NULL');
    // Ordering guard: the clause sits after the closing ')' and before 'WHERE'.
    const nndAt = sql.indexOf('NULLS NOT DISTINCT');
    expect(nndAt).toBeGreaterThan(sql.indexOf(')'));
    expect(nndAt).toBeLessThan(sql.indexOf('WHERE'));
  });

  // (b) Guarded no-op on a NON-unique index (PostgreSQL rejects it there), so the
  // emitted SQL is byte-identical to the same index without the flag.
  it('does NOT emit NULLS NOT DISTINCT on a non-unique index (guarded no-op)', () => {
    const withFlag = buildCreateIndexStatement(
      { name: 'ix_ref', columns: ['external_ref'], nullsNotDistinct: true },
      '"t"'
    );
    const withoutFlag = buildCreateIndexStatement(
      { name: 'ix_ref', columns: ['external_ref'] },
      '"t"'
    );
    expect(withFlag).not.toContain('NULLS NOT DISTINCT');
    expect(withFlag).toBe(withoutFlag);
    expect(withFlag).toBe('CREATE INDEX "ix_ref" ON "t" ("external_ref")');
  });

  // Existing (flag-unset) UNIQUE indexes still emit byte-identically to before.
  it('a UNIQUE index WITHOUT the flag is unchanged — no clause leaks in', () => {
    expect(
      buildCreateIndexStatement({ name: 'uq', columns: ['email'], isUnique: true }, '"t"')
    ).toBe('CREATE UNIQUE INDEX "uq" ON "t" ("email")');
  });

  // parseDbIndexSignature: a live NND index now parses instead of collapsing to
  // null (the prior bug treated it as "unparseable -> unchanged").
  it('parseDbIndexSignature reads NULLS NOT DISTINCT (previously returned null)', () => {
    const sig = parseDbIndexSignature(
      'CREATE UNIQUE INDEX uq ON public.t USING btree (external_ref) NULLS NOT DISTINCT'
    );
    expect(sig).not.toBeNull();
    expect(sig!.isUnique).toBe(true);
    expect(sig!.nullsNotDistinct).toBe(true);
    expect(sig!.where).toBe('');
  });

  it('parseDbIndexSignature reads NULLS NOT DISTINCT together with a WHERE predicate', () => {
    const sig = parseDbIndexSignature(
      'CREATE UNIQUE INDEX uq ON public.t USING btree (a) NULLS NOT DISTINCT WHERE active = true'
    );
    expect(sig).not.toBeNull();
    expect(sig!.nullsNotDistinct).toBe(true);
    expect(sig!.where).toBe('active = true');
  });

  // (c) Reconcile: declared NND vs live NND => UNCHANGED (no churn). The
  // non-null + nullsNotDistinct assertions prove the live def actually parsed.
  it('declared NULLS NOT DISTINCT vs live NULLS NOT DISTINCT => no change', () => {
    const liveDef = 'CREATE UNIQUE INDEX uq ON probe.t USING btree (external_ref) NULLS NOT DISTINCT';
    const model: IndexSqlSpec = { name: 'uq', columns: ['external_ref'], isUnique: true, nullsNotDistinct: true };
    const result = compareIndexDefinition(liveDef, model);
    expect(result.dbSignature).not.toBeNull();
    expect(result.dbSignature!.nullsNotDistinct).toBe(true);
    expect(result.modelSignature.nullsNotDistinct).toBe(true);
    expect(result.changed).toBe(false);
  });

  // (d) Reconcile: declared NND vs live DISTINCT => CHANGED (recreate).
  it('declared NULLS NOT DISTINCT vs live DISTINCT => change (recreate)', () => {
    const liveDistinct = 'CREATE UNIQUE INDEX uq ON probe.t USING btree (external_ref)';
    const model: IndexSqlSpec = { name: 'uq', columns: ['external_ref'], isUnique: true, nullsNotDistinct: true };
    const result = compareIndexDefinition(liveDistinct, model);
    expect(result.dbSignature!.nullsNotDistinct).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.reason).toMatch(/nulls not distinct/i);
  });

  // (d, reverse) declared DISTINCT vs live NND => CHANGED. This specifically
  // exercises the parse fix: the live NND def previously collapsed to null and
  // the real difference was silently invisible (changed=false).
  it('declared DISTINCT vs live NULLS NOT DISTINCT => change (fixes prior null-return bug)', () => {
    const liveNND = 'CREATE UNIQUE INDEX uq ON probe.t USING btree (external_ref) NULLS NOT DISTINCT';
    const model: IndexSqlSpec = { name: 'uq', columns: ['external_ref'], isUnique: true };
    const result = compareIndexDefinition(liveNND, model);
    expect(result.dbSignature).not.toBeNull();
    expect(result.modelSignature.nullsNotDistinct).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.reason).toMatch(/nulls not distinct/i);
  });

  // The flag normalizes to false on a non-unique spec, mirroring the SQL guard,
  // so a non-unique index that erroneously sets it never falsely churns.
  it('a non-unique spec with the flag set normalizes to nullsNotDistinct=false (no false churn)', () => {
    const liveDef = 'CREATE INDEX ix ON probe.t USING btree (external_ref)';
    const model: IndexSqlSpec = { name: 'ix', columns: ['external_ref'], nullsNotDistinct: true };
    const result = compareIndexDefinition(liveDef, model);
    expect(result.modelSignature.nullsNotDistinct).toBe(false);
    expect(result.changed).toBe(false);
  });
});
