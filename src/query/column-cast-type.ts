/**
 * The type a value is cast to for a column — one rule for every place that binds or writes a value for a
 * column through a cast: `insertFrom`'s SELECT list (a plain value, and an expression for a column that is not
 * a string column), the cast-annotated VALUES cells (row-guarded / dependent-insert `MutationBatch` legs,
 * `insertWithChildren`, `bulkUpdate`, `mergeBulk`) and the arrays of a typed rows source (`unnestRows`).
 */

/** Column types and the type a value of theirs is cast to */
const PG_TYPE_MAP: Record<string, string> = {
  'smallint': 'smallint',
  'integer': 'integer',
  'bigint': 'bigint',
  'serial': 'integer',
  'smallserial': 'smallint',
  'bigserial': 'bigint',
  'decimal': 'decimal',
  'numeric': 'numeric',
  'real': 'real',
  'double precision': 'double precision',
  'money': 'money',
  'varchar': 'varchar',
  'char': 'char',
  'text': 'text',
  'bytea': 'bytea',
  'timestamp': 'timestamp',
  'timestamptz': 'timestamptz',
  'date': 'date',
  'time': 'time',
  'timetz': 'timetz',
  'interval': 'interval',
  'boolean': 'boolean',
  'uuid': 'uuid',
  'json': 'json',
  'jsonb': 'jsonb',
  'inet': 'inet',
  'cidr': 'cidr',
  'macaddr': 'macaddr',
  'macaddr8': 'macaddr8',
};

/**
 * Types whose bare name carries a typmod of 1 — `char` is `character(1)`, `bit` is `bit(1)` — mapped to their
 * unbounded forms. An explicit cast to the bare name truncates SILENTLY (`CAST('ABCDEF' AS char)` is `'A'`).
 */
const UNBOUNDED_CAST_TYPES = new Map<string, string>([
  ['char', 'bpchar'],
  ['character', 'bpchar'],
  ['bit', 'varbit'],
]);

/**
 * The type a value is cast to for a column of type `columnType`. It never carries a typmod: the assignment to
 * the column then pads, rounds or raises (22001) exactly as `INSERT … VALUES` does.
 * @internal
 */
export function columnCastType(columnType: string): string {
  const pgType = PG_TYPE_MAP[columnType] || columnType;

  return UNBOUNDED_CAST_TYPES.get(pgType) ?? pgType;
}

/** The string types: every value is assignable to a column of one, through its text — no cast is needed. */
const STRING_CAST_TYPES = new Set(['text', 'varchar', 'character varying', 'bpchar', 'character', 'char', 'name']);

/**
 * Whether a column whose values are cast to `castType` is a string column (`varchar(20)` too — the typmod
 * aside): any expression is assignable to it as it is. @internal
 */
export function isStringCastType(castType: string): boolean {
  return typeof castType === 'string' && STRING_CAST_TYPES.has(castType.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase());
}
