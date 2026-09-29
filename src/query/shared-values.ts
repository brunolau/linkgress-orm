/**
 * Mapped values shared within one result set — the reads of a custom type declared `immutable` (see
 * `TypeMapper.immutable`): its `fromDriver` runs once per distinct driver value of a column, and every row with
 * that driver value gets the same mapped value.
 *
 * A read site makes its reader of a mapper for ONE result set with {@link forResultSet}, handing it the number of
 * values the reader will read (the result set's rows; a collection's items across them). A read plan that serves
 * several result sets — a future's, a prepared query's, a grouped query's readers kept by a join, a mutation's
 * RETURNING plan — keeps the declared mapper and asks for a fresh reader per result set, so a memo never outlives
 * the rows it was made for: two queries, two QueryBatch branches, two executions of one future never share a value.
 * @internal
 */

/** What a result set reads a value through: a mapper's `fromDriver`. */
interface ReadMapper {
  fromDriver(value: any): any;
}

/**
 * How many values a reader reads within its result set — its rows, a collection's items across them — when the
 * read site knows it: a number, or a function computing it (asked only when a mapper declared `immutable` needs
 * it). `undefined` when it is not known.
 * @internal
 */
export type ValueCount = number | (() => number) | undefined;

/** The most distinct driver values one column's memo holds within one result set. @internal */
export const SHARED_VALUES_CAP = 1024;

/**
 * The fewest distinct driver values a column reads before its memo has to prove itself: when that many came in and
 * none repeated, the column stops memoizing. @internal
 */
export const SHARED_VALUES_PROBE = 128;

/**
 * How many times a value has to repeat on average over a result set for a column that repeats only every more
 * than SHARED_VALUES_PROBE rows (a calendar read entity by entity) to be found: a result set of N values probes
 * N / SHARED_VALUES_REPEATS distinct values before it gives up — at least SHARED_VALUES_PROBE, at most
 * SHARED_VALUES_CAP. @internal
 */
export const SHARED_VALUES_REPEATS = 2;

/**
 * The distinct driver values a column of a result set of `count` values reads before its memo has to prove itself
 * (see SHARED_VALUES_REPEATS); SHARED_VALUES_PROBE when the count is not known. @internal
 */
export function probeWindow(count: number | undefined): number {
  return count === undefined
    ? SHARED_VALUES_PROBE
    : Math.min(SHARED_VALUES_CAP, Math.max(SHARED_VALUES_PROBE, Math.floor(count / SHARED_VALUES_REPEATS)));
}

/**
 * How a derived mapper (an `agg.arrayAgg()`'s) or a reader function kept by a read plan (see readerThrough) is made
 * anew for a result set of a given number of values. Held off the objects themselves: a spread of one
 * (`{ ...derived, fromDriver: other }`) does not carry it along.
 */
const FACTORIES = new WeakMap<object, (count: ValueCount) => unknown>();

/**
 * A mapper declared `immutable`, read for one result set: `fromDriver` runs once per distinct PRIMITIVE driver
 * value — a string, a number, a bigint, a boolean — and every later row with that value gets the value it mapped
 * to. NULL / undefined and any other driver value (a Date, a Buffer, an array, an object) go through `fromDriver`
 * every time, as without the flag; so does -0 (a key equal to 0, a value that is not). A driver value mapped to
 * `undefined` is not kept. `fromDriver` is called on the mapper itself (`this` is the mapper), and what it throws
 * propagates from the value it threw for; nothing is kept for that value.
 *
 * Bounded: the memo holds at most SHARED_VALUES_CAP values, in a Map made when it keeps its first one. A column
 * whose first `window` distinct values (probeWindow) brought no repeat gives up — every later value maps on its
 * own, as without the flag. A column that fills the memo keeps it — adding nothing more — while at least as many
 * of the values it read were repeats as it holds, and gives up otherwise.
 */
class SharedValueRead implements ReadMapper {
  /** The values kept, by driver value: made with the first one */
  private values: Map<unknown, unknown> | undefined;
  /** Still memoizing — false once the column gave up */
  private open = true;
  private hits = 0;

  constructor(private readonly mapper: ReadMapper, private readonly window: number) {}

  fromDriver(value: any): any {
    if (!this.open) {
      return this.mapper.fromDriver(value);
    }

    const type = typeof value;

    if ((type !== 'string' && type !== 'number' && type !== 'bigint' && type !== 'boolean') || (value === 0 && Object.is(value, -0))) {
      return this.mapper.fromDriver(value);
    }

    const values = this.values;

    if (values !== undefined) {
      const known = values.get(value);

      if (known !== undefined) {
        this.hits++;

        return known;
      }
    }

    const mapped = this.mapper.fromDriver(value);

    if (mapped !== undefined) {
      this.keep(value, mapped);
    }

    return mapped;
  }

  /** Keeps a new driver value's mapped value — or gives up, see the class doc. */
  private keep(value: unknown, mapped: unknown): void {
    const values = (this.values ??= new Map());
    const size = values.size;

    if (size === this.window && this.hits === 0) {
      this.stop();
    } else if (size < SHARED_VALUES_CAP) {
      values.set(value, mapped);
    } else if (this.hits < size) {
      this.stop();
    }
  }

  private stop(): void {
    this.open = false;
    this.values = undefined;
  }
}

/** A value count as a number (see ValueCount). */
const countOf = (count: ValueCount): number | undefined => (typeof count === 'function' ? count() : count);

/** `count`, computed at most once however many memos ask for it (see ValueCount). @internal */
export function countedOnce(count: ValueCount): ValueCount {
  if (typeof count !== 'function') {
    return count;
  }

  let counted: number | undefined;

  return () => (counted ??= count());
}

/**
 * Whether a mapper — or a reader built by {@link readerThrough} — shares mapped values within a result set: a
 * mapper declared `immutable`, or one derived from such a mapper (an `agg.arrayAgg()` of its column). @internal
 */
export function sharesValues(mapper: unknown): boolean {
  return mapper !== null
    && (typeof mapper === 'object' || typeof mapper === 'function')
    && ((mapper as { immutable?: unknown }).immutable === true || FACTORIES.has(mapper as object));
}

/**
 * `mapper` as ONE result set reads through it, for `count` values (its rows, a collection's items across them; see
 * ValueCount): a mapper declared `immutable` in a memo of its own ({@link SharedValueRead}) — none for fewer than
 * two values, which have nothing to share —, a derived mapper or a reader of one ({@link readerThrough}) made
 * anew; anything else (no mapper, a mapper without the flag) as it is. Call it once per result set and column: the
 * memo lives as long as what it returns, and the reads of a mapper without the flag are exactly what they were
 * (`count` is not even computed for them). @internal
 */
export function forResultSet<T>(mapper: T, count?: ValueCount): T {
  if (mapper === undefined || mapper === null || (typeof mapper !== 'object' && typeof mapper !== 'function')) {
    return mapper;
  }

  if ((mapper as { immutable?: unknown }).immutable === true && typeof (mapper as any).fromDriver === 'function') {
    const values = countOf(count);

    return values !== undefined && values < 2
      ? mapper
      : new SharedValueRead(mapper as unknown as ReadMapper, probeWindow(values)) as unknown as T;
  }

  const make = FACTORIES.get(mapper as object);

  return make !== undefined ? make(count) as T : mapper;
}

/**
 * What reads values through `mapper`, as `make` builds it around the mapper — a reader function kept by a read plan
 * (a grouped query's), a derived mapper (the elements of an `agg.arrayAgg()`). When `mapper` shares values within a
 * result set, `forResultSet()` of what `make` built builds it again around `forResultSet(mapper, count)`, once per
 * result set — or is what `make` built itself when that is `mapper` (a mapper declared immutable, read for fewer
 * than two values). `rowsAreValues`: whether the values it reads are the result set's rows — a list's elements are
 * not (their memo gets no count, and a one-row result set still shares its elements, read through a plan's reader
 * too). Read without `forResultSet()`, it reads through `mapper` itself — every value mapped on its own. @internal
 */
export function readerThrough<M, R extends object>(mapper: M, make: (mapper: M) => R, rowsAreValues: boolean = true): R {
  const reader = make(mapper);

  if (sharesValues(mapper)) {
    FACTORIES.set(reader, count => {
      const read = forResultSet(mapper, rowsAreValues ? count : undefined);

      // Nothing made for this result set: what `make` built already reads through the mapper itself
      return read === mapper ? reader : make(read);
    });
  }

  return reader;
}

/**
 * The readers of a read plan (see {@link readerThrough}) for ONE result set of `count` rows: `readers` itself when
 * none of them is made anew for it (none shares values, or fewer than two rows leave nothing to share), else a copy
 * with those made anew. @internal
 */
export function readersForResultSet<K, R>(readers: ReadonlyMap<K, R>, count?: ValueCount): ReadonlyMap<K, R> {
  const values = countedOnce(count);
  let fresh: Map<K, R> | undefined;

  for (const [key, reader] of readers) {
    const read = forResultSet(reader, values);

    if (read !== reader) {
      (fresh ??= new Map(readers)).set(key, read);
    }
  }

  return fresh ?? readers;
}

/**
 * How many values `rows` carry at `path` (a key, or the keys down to a nested object's value): a list's elements,
 * one for any other value but NULL — a collection's items, a `withAggregation` list's, across a result set. A
 * ValueCount for the readers of those items. @internal
 */
export function valuesAt(rows: readonly any[], path: readonly string[]): number {
  let count = 0;

  for (let r = 0; r < rows.length; r++) {
    let value = rows[r];

    // Down objects only: a string's `at` is a method, not a value at the path
    for (let p = 0; p < path.length; p++) {
      value = value !== null && typeof value === 'object' ? value[path[p]] : undefined;
    }

    if (Array.isArray(value)) {
      count += value.length;
    } else if (value !== null && value !== undefined) {
      count++;
    }
  }

  return count;
}
