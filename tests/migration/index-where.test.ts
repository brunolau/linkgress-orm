import {
  normalizeIndexPredicate,
  compareIndexDefinition,
  IndexSqlSpec,
} from '../../src/migration/index-sql';

/**
 * Partial-index WHERE predicate comparison matrix.
 *
 * Every `pg` string below is the VERBATIM `WHERE` clause from
 * `pg_get_indexdef(oid, 0, true)` captured against a real PostgreSQL for an index
 * created with `... (id) WHERE <model>` (see debug probe). The model side is the
 * raw predicate string a user passes to `.where()`. They must compare equal —
 * otherwise the migrator would rebuild the partial index on every run.
 */
function dbDef(whereClause: string | null): string {
  return whereClause
    ? `CREATE INDEX ix ON s.t USING btree (id) WHERE ${whereClause}`
    : `CREATE INDEX ix ON s.t USING btree (id)`;
}
function model(where?: string): IndexSqlSpec {
  return { name: 'ix', columns: ['id'], where };
}

// [label, model `.where()` string, PostgreSQL's stored WHERE]
const UNCHANGED: Array<[string, string, string]> = [
  ['boolean = true', 'active = true', 'active = true'],
  ['boolean shorthand', 'active', 'active'],
  ['IS TRUE', 'active IS TRUE', 'active IS TRUE'],
  ['NOT boolean', 'NOT active', 'NOT active'],
  ['boolean = false', 'active = false', 'active = false'],
  ['IS NULL', 'deleted_at IS NULL', 'deleted_at IS NULL'],
  ['IS NOT NULL', 'deleted_at IS NOT NULL', 'deleted_at IS NOT NULL'],
  ['int >', 'age > 0', 'age > 0'],
  ['int >=', 'age >= 18', 'age >= 18'],
  ['range AND', 'age >= 18 AND age < 65', 'age >= 18 AND age < 65'],
  ['mixed OR', 'age > 0 OR active = true', 'age > 0 OR active = true'],
  ['varchar = literal (PG adds ::text)', "status = 'active'", "status::text = 'active'::text"],
  ['varchar <> literal', "status <> 'deleted'", "status::text <> 'deleted'::text"],
  ['!= normalized to <>', "status != 'deleted'", "status::text <> 'deleted'::text"],
  ['IN list -> = ANY(ARRAY[...])', "status IN ('a', 'b', 'c')", "status::text = ANY (ARRAY['a'::character varying, 'b'::character varying, 'c'::character varying]::text[])"],
  ['LIKE -> ~~', "name LIKE 'A%'", "name ~~ 'A%'::text"],
  ['function = literal', "lower(name) = 'x'", "lower(name) = 'x'::text"],
  ['IS NOT NULL AND boolean', 'email IS NOT NULL AND active', 'email IS NOT NULL AND active'],
  ['numeric literal', 'price > 100.50', 'price > 100.50'],
  ['numeric >= 0 (PG adds ::numeric)', 'price >= 0', 'price >= 0::numeric'],
  ['column = column', 'col_a = col_b', 'col_a = col_b'],
  ['varchar literal AND int', "status = 'a' AND age > 5", "status::text = 'a'::text AND age > 5"],
  ['function in predicate', 'char_length(name) > 5', 'char_length(name) > 5'],
  ['text IS NOT NULL', 'name IS NOT NULL', 'name IS NOT NULL'],
  ['int IN -> = ANY(ARRAY[...])', 'age IN (1, 2, 3)', 'age = ANY (ARRAY[1, 2, 3])'],
  ['COALESCE', 'coalesce(age, 0) > 0', 'COALESCE(age, 0) > 0'],
  ['LIKE contains', "email LIKE '%@x.com'", "email::text ~~ '%@x.com'::text"],
  ['BETWEEN -> range', 'age BETWEEN 1 AND 10', 'age >= 1 AND age <= 10'],
  ['compound with IS NULL', "status = 'active' AND deleted_at IS NULL", "status::text = 'active'::text AND deleted_at IS NULL"],
];

describe('partial-index WHERE: unchanged predicates must NOT churn', () => {
  for (const [label, modelWhere, pgWhere] of UNCHANGED) {
    it(label, () => {
      const result = compareIndexDefinition(dbDef(pgWhere), model(modelWhere));
      expect(result.dbSignature).not.toBeNull();
      if (result.changed) {
        // Surface the normalized forms to make a failure diagnosable.
        throw new Error(
          `churned: model→ "${result.modelSignature.where}" vs pg→ "${result.dbSignature!.where}"`
        );
      }
      expect(result.changed).toBe(false);
    });
  }
});

describe('partial-index WHERE: genuine predicate changes ARE detected', () => {
  it('adding a predicate (db had none)', () => {
    expect(compareIndexDefinition(dbDef(null), model('active = true')).changed).toBe(true);
  });

  it('removing a predicate (model has none)', () => {
    expect(compareIndexDefinition(dbDef('active = true'), model(undefined)).changed).toBe(true);
  });

  it('flipping a boolean literal', () => {
    expect(compareIndexDefinition(dbDef('active = true'), model('active = false')).changed).toBe(true);
  });

  it('changing a numeric bound', () => {
    expect(compareIndexDefinition(dbDef('age > 0'), model('age > 5')).changed).toBe(true);
  });

  it('changing the predicate column', () => {
    expect(compareIndexDefinition(dbDef('deleted_at IS NULL'), model('archived_at IS NULL')).changed).toBe(true);
  });

  it('shrinking an IN list', () => {
    const db = dbDef('age = ANY (ARRAY[1, 2, 3])');
    expect(compareIndexDefinition(db, model('age IN (1, 2)')).changed).toBe(true);
  });

  it('changing a LIKE pattern', () => {
    expect(compareIndexDefinition(dbDef("name ~~ 'A%'::text"), model("name LIKE 'B%'")).changed).toBe(true);
  });

  it('tightening a range', () => {
    expect(compareIndexDefinition(dbDef('age >= 18 AND age < 65'), model('age >= 21 AND age < 65')).changed).toBe(true);
  });
});

describe('normalizeIndexPredicate: deterministic rewrite rules', () => {
  it('!= becomes <>', () => {
    expect(normalizeIndexPredicate("status != 'x'")).toBe(normalizeIndexPredicate("status <> 'x'"));
  });
  it('LIKE/ILIKE/NOT LIKE/NOT ILIKE map to operators', () => {
    expect(normalizeIndexPredicate("a LIKE 'x'")).toBe("a ~~ 'x'");
    expect(normalizeIndexPredicate("a ILIKE 'x'")).toBe("a ~~* 'x'");
    expect(normalizeIndexPredicate("a NOT LIKE 'x'")).toBe("a !~~ 'x'");
    expect(normalizeIndexPredicate("a NOT ILIKE 'x'")).toBe("a !~~* 'x'");
  });
  it('= ANY(ARRAY[...]) collapses to IN', () => {
    expect(normalizeIndexPredicate("age = ANY (ARRAY[1, 2, 3])")).toBe('age in (1, 2, 3)');
  });
  it('BETWEEN expands to a range', () => {
    expect(normalizeIndexPredicate('age BETWEEN 1 AND 10')).toBe('age >= 1 and age <= 10');
  });
  it('IN list and ANY(ARRAY) forms converge', () => {
    expect(normalizeIndexPredicate("status IN ('a', 'b')"))
      .toBe(normalizeIndexPredicate("status = ANY (ARRAY['a'::text, 'b'::text]::text[])"));
  });
});

/**
 * These predicate forms are rewritten by PostgreSQL in ways this string compare
 * cannot reverse, so Tier 1 (`compareIndexDefinition`) reports them as changed.
 * That is by design: Tier 1 only PROPOSES a recreate. The schema manager then
 * runs the Tier-2 canonical confirmation (rebuild on an empty mirror table +
 * compare PostgreSQL's own `pg_get_indexdef`), which recognizes them as
 * equivalent and suppresses the rebuild — so the live migrator does NOT churn.
 * The end-to-end no-churn proof lives in
 * tests/schema/recreate-changed-index.test.ts.
 */
describe('partial-index WHERE: Tier-1 cannot resolve these (Tier-2 confirmation does)', () => {
  it('Tier 1 flags a bare date literal (PG expands it to timestamptz)', () => {
    const db = dbDef("created_at > '2020-01-01 00:00:00+01'::timestamp with time zone");
    expect(compareIndexDefinition(db, model("created_at > '2020-01-01'")).changed).toBe(true);
  });

  it('Tier 1 flags precedence re-parenthesization', () => {
    expect(compareIndexDefinition(dbDef('(col_a + col_b) > 10'), model('col_a + col_b > 10')).changed).toBe(true);
    expect(compareIndexDefinition(dbDef('col_a > 1 AND col_b < 2 OR active'), model('(col_a > 1 AND col_b < 2) OR active')).changed).toBe(true);
  });
});
