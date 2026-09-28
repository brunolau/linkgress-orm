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

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * An int8 as the driver delivered it — its exact decimal text (pg, postgres.js, Bun.SQL and PGliteClient all deliver
 * int8 that way), a JS bigint, or a JS number — as an exact bigint. A number beyond the safe integer range has
 * already lost its exact value (a driver configured to read int8 as a double), and anything that is no integer
 * (null, a fraction, text) is refused: never a wrong value.
 */
function exactInt8(value: unknown, sequence: string, method: string, verb: 'drew' | 'read'): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
    return BigInt(value.trim());
  }

  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    // the double's exact integer value — `${value}` would print JS's shortest form (2 ** 60 as 1152921504606847000)
    throw new RangeError(
      `sequence ${sequence}: ${method}: the driver delivered the inexact number ${BigInt(value)} — its exact value is lost; ` +
      'have the driver deliver int8 as text (the default of every client linkgress ships) or as a bigint'
    );
  }

  throw new TypeError(`sequence ${sequence}: ${method} ${verb} ${String(value)}, which is no integer`);
}

/**
 * Sequence instance for interacting with PostgreSQL sequences
 */
export class DbSequence {
  private qualifiedName: string;

  /**
   * @param client - The client every statement runs on (a transaction's client for a transaction's instance)
   * @param config - Sequence configuration
   * @param rootClient - Where {@link nextValueCreatingIfMissing} CREATEs a missing sequence when `client` is a
   *   transaction's: the context's root client, so the caller's rollback never undoes the CREATE. Omitted, it is
   *   `client`.
   */
  constructor(
    private client: DatabaseClient,
    private config: SequenceConfig,
    private rootClient: DatabaseClient = client
  ) {
    this.qualifiedName = qualifiedSequenceName(config);
  }

  /**
   * Get the next value from the sequence, as a JS number.
   *
   * A value outside Number's safe integer range (±(2^53 − 1)) throws a RangeError instead of coming back
   * rounded — it is drawn, and so consumed, all the same: draw such a sequence with {@link nextValueBigInt}.
   */
  async nextValue(): Promise<number> {
    return this.safeNumber(await this.drawNext('nextValue()'), 'nextValue()', 'drew', 'the value is consumed; draw it with nextValueBigInt()');
  }

  /**
   * Get the next value from the sequence as a bigint — exact for every int8 value. Same statement as
   * {@link nextValue}.
   */
  async nextValueBigInt(): Promise<bigint> {
    return this.drawNext('nextValueBigInt()');
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
   *
   * A TRANSACTION's instance (`trx.<model sequence>`, bound to the transaction's client with the context's root
   * client beside it) never lets a failed `nextval` abort the caller's transaction:
   *
   * 1. `SELECT to_regclass($1)::oid::text AS oid` in the transaction — no error when the sequence is missing;
   * 2. found: `SELECT nextval($1::regclass)` in the transaction;
   * 3. missing: `CREATE SEQUENCE IF NOT EXISTS …` on the ROOT client (a rollback of the caller never undoes it; a
   *    lost race is swallowed as above), its OID read there with the same query, then `SELECT nextval($1::regclass)`
   *    in the transaction with that OID — an OID, not the name, so the draw never meets a name lookup the
   *    transaction's session cached before the CREATE.
   *
   * The CREATE needs a second pooled connection beside the transaction's (as every draw of a transaction's
   * sequence did before 1.0.11): on a pool of one it waits for the transaction's connection — node-postgres, by
   * default, forever. On PGlite, which has one session, the CREATE on the root client is refused at once
   * (`PGliteClient: PGlite has a single session …`), as `runtimeSequence()` is there; the transaction stays usable.
   * An existing sequence needs neither: the probe and the draw run in the transaction.
   *
   * Returns a JS number, with {@link nextValue}'s RangeError outside the safe integer range (the value is
   * consumed): {@link nextValueCreatingIfMissingBigInt} returns every int8 exactly.
   */
  async nextValueCreatingIfMissing(): Promise<number> {
    return this.safeNumber(
      await this.drawNextCreatingIfMissing('nextValueCreatingIfMissing()'),
      'nextValueCreatingIfMissing()',
      'drew',
      'the value is consumed; draw it with nextValueCreatingIfMissingBigInt()'
    );
  }

  /**
   * {@link nextValueCreatingIfMissing} returning a bigint — exact for every int8 value.
   */
  async nextValueCreatingIfMissingBigInt(): Promise<bigint> {
    return this.drawNextCreatingIfMissing('nextValueCreatingIfMissingBigInt()');
  }

  /**
   * Get the current value of the sequence (without incrementing) — `currval()`, the value this SESSION last
   * drew (or set with {@link resync}) — as a JS number; a RangeError outside the safe integer range: read such a
   * value with {@link currentValueBigInt}.
   */
  async currentValue(): Promise<number> {
    return this.safeNumber(await this.readCurrent('currentValue()'), 'currentValue()', 'is', 'read it with currentValueBigInt()');
  }

  /**
   * {@link currentValue} as a bigint — exact for every int8 value.
   */
  async currentValueBigInt(): Promise<bigint> {
    return this.readCurrent('currentValueBigInt()');
  }

  /**
   * Set the sequence to a specific value (`setval(…, true)`: the next draw returns the value after it). A bigint
   * sets any int8 value exactly. A number must be a safe integer (±(2^53 − 1)) — anything else (2^53 and beyond, a
   * fraction, NaN) throws a RangeError before any SQL: beyond 2^53 a number is no longer the value it was written
   * as, so pass a bigint. Either is bound as its exact decimal text.
   */
  async resync(value: number | bigint): Promise<void> {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new RangeError(
        `sequence ${this.qualifiedName}: resync() takes a number only within the safe integer range ` +
        `(±${Number.MAX_SAFE_INTEGER}), got ${Number.isInteger(value) ? BigInt(value) : value} — pass the exact value as a bigint`
      );
    }

    await this.client.query(
      `SELECT setval($1::regclass, $2, true)`,
      [this.qualifiedName, value.toString()]
    );
  }

  /** `nextval()`, exactly — of `regclass` (the sequence's quoted name, or its OID as text). */
  private async drawNext(method: string, regclass: string = this.qualifiedName): Promise<bigint> {
    const result = await this.client.query(
      `SELECT nextval($1::regclass) as value`,
      [regclass]
    );
    return exactInt8(result.rows[0]?.value, this.qualifiedName, method, 'drew');
  }

  /** The create-on-first-use ladder of {@link nextValueCreatingIfMissing}, exactly. */
  private async drawNextCreatingIfMissing(method: string): Promise<bigint> {
    if (this.rootClient !== this.client) {
      return this.drawNextCreatingIfMissingInTransaction(method);
    }

    try {
      return await this.drawNext(method);
    } catch (error) {
      if (sqlStateOf(error) !== '42P01') {
        throw error;
      }
    }

    await this.createIfMissing(this.client);

    return this.drawNext(method);
  }

  /**
   * The ladder of a transaction's instance: probe without aborting the caller's transaction, CREATE on the root
   * client, draw in the transaction by OID (see {@link nextValueCreatingIfMissing}).
   */
  private async drawNextCreatingIfMissingInTransaction(method: string): Promise<bigint> {
    if ((await this.oidOn(this.client)) !== null) {
      return this.drawNext(method);
    }

    await this.createIfMissing(this.rootClient);
    const oid = await this.oidOn(this.rootClient);

    // null: another session dropped it again in between — draw by name, and let its error speak
    return this.drawNext(method, oid ?? this.qualifiedName);
  }

  /** The sequence's OID as `client` sees it, or null — `to_regclass` fails for no missing name. */
  private async oidOn(client: DatabaseClient): Promise<string | null> {
    const result = await client.query(`SELECT to_regclass($1)::oid::text AS oid`, [this.qualifiedName]);
    return result.rows[0]?.oid ?? null;
  }

  /** `CREATE SEQUENCE IF NOT EXISTS` with the options; a concurrent first use that loses the race is swallowed. */
  private async createIfMissing(client: DatabaseClient): Promise<void> {
    try {
      await client.query(renderCreateSequenceStatement(this.config, { ifNotExists: true }));
    } catch (error) {
      if (!CREATE_RACE_LOST.has(sqlStateOf(error) ?? '')) {
        throw error;
      }
    }
  }

  /** `currval()`, exactly. */
  private async readCurrent(method: string): Promise<bigint> {
    const result = await this.client.query(
      `SELECT currval($1::regclass) as value`,
      [this.qualifiedName]
    );
    return exactInt8(result.rows[0]?.value, this.qualifiedName, method, 'read');
  }

  /** The value as a JS number — or a RangeError when it lies outside Number's safe integer range. */
  private safeNumber(value: bigint, method: string, verb: string, exactly: string): number {
    if (value > MAX_SAFE || value < MIN_SAFE) {
      throw new RangeError(
        `sequence ${this.qualifiedName}: ${method} ${verb} ${value}, beyond the safe integer range of a JS number ` +
        `(±${Number.MAX_SAFE_INTEGER}) — ${exactly}`
      );
    }

    return Number(value);
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
