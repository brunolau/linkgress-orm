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
