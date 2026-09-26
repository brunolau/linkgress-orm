import { DatabaseClient } from '../database/database-client.interface';
import { sqlStateOf } from '../database/sql-state';

/**
 * PostgreSQL sequence configuration
 */
export interface SequenceConfig {
  name: string;
  schema?: string;
  /** Each numeric option is an integer within bigint (-2^63 … 2^63-1): a number, or a JS bigint beyond 2^53. */
  startWith?: number | bigint;
  incrementBy?: number | bigint;
  minValue?: number | bigint;
  maxValue?: number | bigint;
  cache?: number | bigint;
  cycle?: boolean;
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/** The option's value as the integer text of the DDL, or null when it is no integer within bigint. */
function int8OptionText(value: unknown): string | null {
  if (typeof value === 'number') {
    // every integer-valued double in [-2^63, 2^63) is exactly an int8 value
    return Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63 ? BigInt(value).toString() : null;
  }

  if (typeof value === 'bigint') {
    return value >= INT8_MIN && value <= INT8_MAX ? value.toString() : null;
  }

  // An integer STRING — a value read from a JSON / env config: inlined as its integer, as before 1.0.9 (which
  // interpolated it); anything else a string can hold is refused like a fraction.
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
    return int8OptionText(BigInt(value.trim()));
  }

  return null;
}

/** A sequence (or schema) name as a quoted identifier: `"` doubled, NUL refused. @internal */
function quoteSequenceIdentifier(name: string): string {
  if (name.includes('\u0000')) {
    throw new Error('sequence name must not contain a NUL character');
  }

  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The quoted name of a sequence, schema-qualified when the config names a schema (else it resolves through
 * the search path, as an unqualified name does). @internal
 */
export function qualifiedSequenceName(config: Pick<SequenceConfig, 'name' | 'schema'>): string {
  return config.schema
    ? `${quoteSequenceIdentifier(config.schema)}.${quoteSequenceIdentifier(config.name)}`
    : quoteSequenceIdentifier(config.name);
}

/**
 * The option list of `CREATE SEQUENCE` — `START WITH … INCREMENT BY … MINVALUE … MAXVALUE … CACHE … CYCLE`,
 * each only when configured — or `''`. The values are inlined in DDL, so each must be an integer within bigint
 * (a number, or a JS bigint); a fraction, NaN, ±Infinity or anything else is refused. The one renderer of the
 * schema manager and of runtime sequences. @internal
 */
export function renderSequenceOptions(config: SequenceConfig): string {
  const options: string[] = [];
  const numeric: Array<[keyof SequenceConfig, string]> = [
    ['startWith', 'START WITH'],
    ['incrementBy', 'INCREMENT BY'],
    ['minValue', 'MINVALUE'],
    ['maxValue', 'MAXVALUE'],
    ['cache', 'CACHE'],
  ];

  for (const [key, keyword] of numeric) {
    const value = config[key];

    if (value === undefined) {
      continue;
    }

    const text = int8OptionText(value);

    if (text === null) {
      throw new TypeError(`sequence "${config.name}": ${key} must be an integer within bigint, got ${String(value)}`);
    }

    options.push(`${keyword} ${text}`);
  }

  if (config.cycle) {
    options.push('CYCLE');
  }

  return options.join(' ');
}

/**
 * The SQLSTATEs of a `CREATE SEQUENCE IF NOT EXISTS` that lost a concurrent first use: 23505 (blocked on the
 * winner's uncommitted catalog row), 42P07 (the winner committed after this session's IF NOT EXISTS probe)
 * and 42710 (duplicate object).
 */
const CREATE_RACE_LOST = new Set(['23505', '42P07', '42710']);

/** `CREATE SEQUENCE [IF NOT EXISTS] <qualified name> [<options>]`. @internal */
export function renderCreateSequenceStatement(config: SequenceConfig, opts?: { ifNotExists?: boolean }): string {
  const options = renderSequenceOptions(config);

  return `CREATE SEQUENCE ${opts?.ifNotExists ? 'IF NOT EXISTS ' : ''}${qualifiedSequenceName(config)}${options ? ` ${options}` : ''}`;
}

/**
 * Sequence instance for interacting with PostgreSQL sequences
 */
export class DbSequence {
  private qualifiedName: string;

  constructor(
    private client: DatabaseClient,
    private config: SequenceConfig
  ) {
    this.qualifiedName = qualifiedSequenceName(config);
  }

  /**
   * Get the next value from the sequence
   */
  async nextValue(): Promise<number> {
    const result = await this.client.query(
      `SELECT nextval($1::regclass) as value`,
      [this.qualifiedName]
    );
    return Number(result.rows[0].value);
  }

  /**
   * The next value, creating the sequence on first use — for sequences named at run time (one per tenant
   * and year, say) that no model declares:
   *
   * 1. `SELECT nextval($1::regclass)`;
   * 2. only when that fails with SQLSTATE 42P01 (no such relation): `CREATE SEQUENCE IF NOT EXISTS <name>
   *    <options>` — a concurrent first use that loses the race is swallowed: 23505 (the winner's catalog row
   *    was still uncommitted, the loser waited on the unique index), 42P07 (the winner committed between the
   *    loser's IF NOT EXISTS probe and its own insert) or 42710; any other error propagates;
   * 3. `SELECT nextval($1::regclass)` once more (a failure now propagates — also when the name belongs to a
   *    relation that is no sequence: 42809).
   *
   * Any other error of the first `nextval` propagates without a CREATE. The statements go to the client
   * directly — unlogged, like {@link nextValue}. A drawn value is consumed even when the caller's work
   * rolls back (sequences are not transactional); get the sequence from `DbContext.runtimeSequence()`,
   * which binds it to the root client so a CREATE is never undone by a caller's rollback.
   */
  async nextValueCreatingIfMissing(): Promise<number> {
    try {
      return await this.nextValue();
    } catch (error) {
      if (sqlStateOf(error) !== '42P01') {
        throw error;
      }
    }

    try {
      await this.client.query(renderCreateSequenceStatement(this.config, { ifNotExists: true }));
    } catch (error) {
      if (!CREATE_RACE_LOST.has(sqlStateOf(error) ?? '')) {
        throw error;
      }
    }

    return this.nextValue();
  }

  /**
   * Get the current value of the sequence (without incrementing)
   */
  async currentValue(): Promise<number> {
    const result = await this.client.query(
      `SELECT currval($1::regclass) as value`,
      [this.qualifiedName]
    );
    return Number(result.rows[0].value);
  }

  /**
   * Set the sequence to a specific value
   */
  async resync(value: number): Promise<void> {
    await this.client.query(
      `SELECT setval($1::regclass, $2, true)`,
      [this.qualifiedName, value]
    );
  }

  /**
   * Get the sequence configuration
   */
  getConfig(): SequenceConfig {
    return { ...this.config };
  }

  /**
   * Get the qualified sequence name (with schema if applicable)
   */
  getQualifiedName(): string {
    return this.qualifiedName;
  }
}

/**
 * Builder for creating sequence configurations
 */
export class SequenceBuilder {
  private config: SequenceConfig;

  constructor(name: string) {
    this.config = {
      name,
      incrementBy: 1,
    };
  }

  /**
   * Set the schema for this sequence
   */
  inSchema(schema: string): this {
    this.config.schema = schema;
    return this;
  }

  /**
   * Set the starting value
   */
  startWith(value: number | bigint): this {
    this.config.startWith = value;
    return this;
  }

  /**
   * Set the increment value
   */
  incrementBy(value: number | bigint): this {
    this.config.incrementBy = value;
    return this;
  }

  /**
   * Set minimum value
   */
  minValue(value: number | bigint): this {
    this.config.minValue = value;
    return this;
  }

  /**
   * Set maximum value (an integer within bigint; a JS bigint for values beyond 2^53)
   */
  maxValue(value: number | bigint): this {
    this.config.maxValue = value;
    return this;
  }

  /**
   * Set cache size
   */
  cache(value: number | bigint): this {
    this.config.cache = value;
    return this;
  }

  /**
   * Enable cycling (restart when reaching max/min value)
   */
  cycle(): this {
    this.config.cycle = true;
    return this;
  }

  /**
   * Build the sequence configuration
   */
  build(): SequenceConfig {
    return { ...this.config };
  }
}

/**
 * Helper function to create a sequence builder
 */
export function sequence(name: string): SequenceBuilder {
  return new SequenceBuilder(name);
}
