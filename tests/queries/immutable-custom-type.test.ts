import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  agg,
  createCustomType,
  customType,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  FutureQueryRunner,
  gt,
  integer,
  JoinQueryBuilder,
  QueryBatch,
  serial,
  sql,
  text,
  timestamp,
  varchar,
} from '../../src';
import {
  countedOnce,
  forResultSet,
  probeWindow,
  readersForResultSet,
  readerThrough,
  SHARED_VALUES_CAP,
  SHARED_VALUES_PROBE,
  SHARED_VALUES_REPEATS,
  sharesValues,
  valuesAt,
} from '../../src/query/shared-values';
import { createFreshClient } from '../utils/test-database';

/**
 * A custom type declared `immutable` (createCustomType / customType): linkgress calls its fromDriver once per
 * distinct driver value of a column within ONE result set and hands every row with that value the same mapped
 * value — at every place a result set reads a mapped value: the row loop, a navigation's column and a navigation
 * row projected whole, nested objects, collections (nested ones, nested objects in their items), QueryBatch
 * branches, grouped queries and their joins, UNIONs, CTEs, joins, aggregates, RETURNING. Never across queries,
 * batch branches or executions of one future. Without the flag every value maps on its own, as before.
 *
 * A small harbour (defined here). Moments are text (`2026-09-28 10:00:00`) read into frozen Stamp objects; days are
 * integers read into frozen Day objects; a note reads into a Note — NULL too, so the NULL reads are observable.
 *
 *   dock   opened              vessels (arrived, day, note)                   cargo (loaded)
 *   North  2020-01-01 08:00    Ada (A, 1001, calm)  Bea (B, 1001, -)          Ada: A, B · Bea: A
 *                              Cleo (A, 1002, calm)
 *   South  2020-01-01 08:00    Dora (C, 1002, rough) Eve (A, 1001, -)         Dora: C, A
 *                              Fay (B, 1001, calm)
 *   East   2021-06-01 08:00    Gus (C, 1002, rough)  Hal (A, 1002, -)         Gus: B
 *
 *   A = 2026-09-28 10:00:00, B = 2026-09-28 11:00:00, C = 2026-09-29 09:30:00
 */

/** A moment, as its text. */
class Stamp {
  constructor(readonly text: string) {
    Object.freeze(this);
  }
}

/** A day number. */
class Day {
  constructor(readonly n: number) {
    Object.freeze(this);
  }
}

/** A note — `null` text for NULL: a NULL read makes a Note of its own. */
class Note {
  constructor(readonly text: string | null) {
    Object.freeze(this);
  }
}

/** How often each type's fromDriver ran (NULL included). */
const calls = { stamp: 0, copy: 0, day: 0, note: 0, logged: 0 };

const resetCalls = (): void => {
  calls.stamp = 0;
  calls.copy = 0;
  calls.day = 0;
  calls.note = 0;
  calls.logged = 0;
};

/** A text moment, shared within a result set. */
const stampType = createCustomType<{ data: Stamp; driverData: string }>({
  dataType: () => 'text',
  toDriver: value => (value == null ? null : value.text),
  fromDriver: value => {
    calls.stamp++;

    return value == null ? null : new Stamp(value);
  },
  immutable: true,
});

/** The same moment, WITHOUT the flag: every value maps on its own. */
const copyType = createCustomType<{ data: Stamp; driverData: string }>({
  dataType: () => 'text',
  toDriver: value => (value == null ? null : value.text),
  fromDriver: value => {
    calls.copy++;

    return value == null ? null : new Stamp(value);
  },
});

/** An integer day, shared. */
const dayType = createCustomType<{ data: Day; driverData: number }>({
  dataType: () => 'integer',
  toDriver: value => (value == null ? null : value.n),
  fromDriver: value => {
    calls.day++;

    return value == null ? null : new Day(Number(value));
  },
  immutable: true,
});

/** The same day through the builder form (customType), which an expression reads through (`.mapWith()`), shared. */
const dayBuilder = customType<Day, number>({
  dataType: 'integer',
  toDriver: value => value.n,
  fromDriver: value => {
    calls.day++;

    return new Day(Number(value));
  },
  immutable: true,
});

/** A note — a NULL reads as a Note of its own, so NULL reads show. */
const noteType = createCustomType<{ data: Note; driverData: string }>({
  dataType: () => 'text',
  toDriver: value => (value == null || value.text === null ? null : value.text),
  fromDriver: value => {
    calls.note++;

    return new Note(value ?? null);
  },
  immutable: true,
});

const pad = (n: number): string => String(n).padStart(2, '0');

/** A `timestamp` column's moment: its text — rebuilt by a QueryBatch — or a Date a driver parsed (local time). */
const loggedType = createCustomType<{ data: Stamp; driverData: string | Date }>({
  dataType: () => 'timestamp',
  toDriver: value => (value == null ? null : value.text),
  fromDriver: value => {
    calls.logged++;

    if (value == null) {
      return null;
    }

    return new Stamp(typeof value === 'string'
      ? value
      : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`);
  },
  immutable: true,
});

class ImvDock extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  openedAt!: DbColumn<Stamp>;

  vessels?: ImvVessel[];
}

class ImvVessel extends DbEntity {
  id!: DbColumn<number>;
  dockId!: DbColumn<number>;
  name!: DbColumn<string>;
  arrivedAt!: DbColumn<Stamp>;
  arrivedCopy!: DbColumn<Stamp>;
  arrivedDay!: DbColumn<Day>;
  note!: DbColumn<Note>;
  loggedAt!: DbColumn<Stamp>;
  berth!: DbColumn<number>;

  dock?: ImvDock;
  cargo?: ImvCargo[];
}

class ImvCargo extends DbEntity {
  id!: DbColumn<number>;
  vesselId!: DbColumn<number>;
  label!: DbColumn<string>;
  loadedAt!: DbColumn<Stamp>;

  vessel?: ImvVessel;
}

class HarbourDatabase extends DbContext {
  get docks(): DbEntityTable<ImvDock> {
    return this.table(ImvDock);
  }

  get vessels(): DbEntityTable<ImvVessel> {
    return this.table(ImvVessel);
  }

  get cargo(): DbEntityTable<ImvCargo> {
    return this.table(ImvCargo);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(ImvDock, entity => {
      entity.toTable('imv_docks');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
      entity.property(e => e.openedAt).hasType(text('opened_at')).hasCustomMapper(stampType).isRequired();

      entity.hasMany(e => e.vessels, () => ImvVessel)
        .withForeignKey(v => v.dockId)
        .withPrincipalKey(d => d.id);
    });

    model.entity(ImvVessel, entity => {
      entity.toTable('imv_vessels');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.dockId).hasType(integer('dock_id')).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
      entity.property(e => e.arrivedAt).hasType(text('arrived_at')).hasCustomMapper(stampType).isRequired();
      entity.property(e => e.arrivedCopy).hasType(text('arrived_copy')).hasCustomMapper(copyType).isRequired();
      entity.property(e => e.arrivedDay).hasType(integer('arrived_day')).hasCustomMapper(dayType).isRequired();
      entity.property(e => e.note).hasType(text('note')).hasCustomMapper(noteType);
      entity.property(e => e.loggedAt).hasType(timestamp('logged_at')).hasCustomMapper(loggedType).isRequired();
      entity.property(e => e.berth).hasType(integer('berth')).isRequired();

      entity.hasOne(e => e.dock, () => ImvDock)
        .withForeignKey(v => v.dockId)
        .withPrincipalKey(d => d.id);
      entity.hasMany(e => e.cargo, () => ImvCargo)
        .withForeignKey(c => c.vesselId)
        .withPrincipalKey(v => v.id);
    });

    model.entity(ImvCargo, entity => {
      entity.toTable('imv_cargo');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.vesselId).hasType(integer('vessel_id')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 32)).isRequired();
      entity.property(e => e.loadedAt).hasType(text('loaded_at')).hasCustomMapper(stampType).isRequired();

      entity.hasOne(e => e.vessel, () => ImvVessel)
        .withForeignKey(c => c.vesselId)
        .withPrincipalKey(v => v.id);
    });
  }
}

const TABLES = ['imv_cargo', 'imv_vessels', 'imv_docks'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

const A = '2026-09-28 10:00:00';
const B = '2026-09-28 11:00:00';
const C = '2026-09-29 09:30:00';
const OPENED_EARLY = '2020-01-01 08:00:00';
const OPENED_LATE = '2021-06-01 08:00:00';

const VESSELS: Array<{ name: string; dock: 'North' | 'South' | 'East'; at: string; day: number; note: string | null }> = [
  { name: 'Ada', dock: 'North', at: A, day: 1001, note: 'calm' },
  { name: 'Bea', dock: 'North', at: B, day: 1001, note: null },
  { name: 'Cleo', dock: 'North', at: A, day: 1002, note: 'calm' },
  { name: 'Dora', dock: 'South', at: C, day: 1002, note: 'rough' },
  { name: 'Eve', dock: 'South', at: A, day: 1001, note: null },
  { name: 'Fay', dock: 'South', at: B, day: 1001, note: 'calm' },
  { name: 'Gus', dock: 'East', at: C, day: 1002, note: 'rough' },
  { name: 'Hal', dock: 'East', at: A, day: 1002, note: null },
];

const CARGO: Array<{ vessel: string; label: string; at: string }> = [
  { vessel: 'Ada', label: 'grain', at: A },
  { vessel: 'Ada', label: 'salt', at: B },
  { vessel: 'Bea', label: 'wool', at: A },
  { vessel: 'Dora', label: 'tea', at: C },
  { vessel: 'Dora', label: 'rice', at: A },
  { vessel: 'Gus', label: 'coal', at: B },
];

/** The texts of the arrival moments, in vessel-name order. */
const ARRIVALS = [...VESSELS].sort((a, b) => a.name.localeCompare(b.name)).map(v => v.at);

/** Every value with the same text is ONE object, values of different texts are different objects — and some text repeats. */
const expectShared = (values: ReadonlyArray<{ text: string | null } | null>): void => {
  const byText = new Map<string | null, unknown>();

  for (const value of values) {
    expect(value).not.toBeNull();
    const first = byText.get(value!.text);

    if (first === undefined) {
      byText.set(value!.text, value);
    } else {
      expect(value).toBe(first as any);
    }
  }

  expect(new Set(values).size).toBe(byText.size);
  expect(values.length).toBeGreaterThan(byText.size);
};

/** Every value is an object of its own (some of them equal). */
const expectOwnValues = (values: ReadonlyArray<object | null>): void => {
  expect(new Set(values).size).toBe(values.length);
};

const texts = (values: ReadonlyArray<{ text: string | null } | null>): Array<string | null> => values.map(value => value!.text);

// ---------------------------------------------------------------------------------------------------------------
// The option and the memo itself
// ---------------------------------------------------------------------------------------------------------------

/** A mapper declared immutable that counts its calls — through `this`, which must be the mapper. */
const countingMapper = (map: (value: unknown) => unknown = value => ({ value })) => ({
  calls: 0,
  immutable: true as const,
  fromDriver(value: unknown): unknown {
    this.calls++;

    return map(value);
  },
});

describe('the immutable option', () => {
  test('createCustomType without it builds the mapper it always built; with it, the mapper says so', () => {
    const base = { dataType: () => 'text', toDriver: (value: string | null | undefined) => value ?? null, fromDriver: (value: string | null | undefined) => value ?? null };

    expect(Object.keys(createCustomType<{ data: string; driverData: string }>(base))).toEqual(['dataType', 'toDriver', 'fromDriver']);
    expect(Object.keys(createCustomType<{ data: string; driverData: string }>({ ...base, immutable: false }))).toEqual(['dataType', 'toDriver', 'fromDriver']);
    expect(createCustomType<{ data: string; driverData: string }>({ ...base, immutable: true }).immutable).toBe(true);
    expect(stampType.immutable).toBe(true);
    expect(copyType.immutable).toBeUndefined();
  });

  test('customType (the builder form) carries it into its type; without it the type is what it was', () => {
    expect(dayBuilder.getType().immutable).toBe(true);
    expect(Object.keys(customType<number, number>({ dataType: 'integer', toDriver: v => v, fromDriver: v => v }).getType()))
      .toEqual(['dataType', 'toDriver', 'fromDriver']);
  });

  test('a mapper without it is read through as it is — the reads of today', () => {
    const plain = { fromDriver: (value: unknown) => ({ value }) };
    const off = { fromDriver: (value: unknown) => ({ value }), immutable: false };

    expect(forResultSet(plain)).toBe(plain);
    expect(forResultSet(off)).toBe(off);
    expect(forResultSet(copyType)).toBe(copyType);
    expect(forResultSet(undefined)).toBeUndefined();
    expect(forResultSet(null)).toBeNull();
  });
});

describe('a result set\'s memo of an immutable mapper', () => {
  test('one fromDriver call per distinct string; the same value for every repeat, another for another string', () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const a1 = read.fromDriver(A);
    const b1 = read.fromDriver(B);
    const a2 = read.fromDriver(A);

    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);
    expect(b1).toEqual({ value: B });
    expect(read.fromDriver(B)).toBe(b1);
    expect(mapper.calls).toBe(2);
  });

  test('numbers, bigints and booleans are keys too — each of its own type (1, "1", 1n and true differ)', () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const keys: unknown[] = [1, '1', 1n, true, 'true', false, 0, 2.5];
    const first = keys.map(key => read.fromDriver(key));
    const again = keys.map(key => read.fromDriver(key));

    again.forEach((value, i) => expect(value).toBe(first[i]));
    expect(new Set(first).size).toBe(keys.length);
    expect(mapper.calls).toBe(keys.length);
    expect(first.map(value => (value as { value: unknown }).value)).toEqual(keys);
  });

  test('NULL and undefined go through fromDriver every time, as without the flag', () => {
    const mapper = countingMapper(value => ({ none: value }));
    const read = forResultSet(mapper);
    const nulls = [read.fromDriver(null), read.fromDriver(null), read.fromDriver(undefined), read.fromDriver(undefined)];

    expectOwnValues(nulls as object[]);
    expect(nulls).toEqual([{ none: null }, { none: null }, { none: undefined }, { none: undefined }]);
    expect(mapper.calls).toBe(4);
  });

  test('a driver value that is an object — a Date, bytes, an array, a document — maps every time, the same instance too', () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const values: object[] = [new Date(0), new Uint8Array([1, 2]), [1, 2], { a: 1 }];

    for (const value of values) {
      expect(read.fromDriver(value)).not.toBe(read.fromDriver(value));
    }

    expect(mapper.calls).toBe(values.length * 2);
  });

  test('-0 is not 0: it maps on its own — NaN is one value', () => {
    const mapper = countingMapper(value => ({ negative: Object.is(value, -0), value }));
    const read = forResultSet(mapper);
    const zero = read.fromDriver(0);
    const negativeZero = read.fromDriver(-0);

    expect(negativeZero).not.toBe(zero);
    expect(negativeZero).toEqual({ negative: true, value: -0 });
    expect(read.fromDriver(0)).toBe(zero);
    expect(read.fromDriver(-0)).not.toBe(negativeZero);
    expect(read.fromDriver(NaN)).toBe(read.fromDriver(NaN));
    expect(mapper.calls).toBe(4);
  });

  test('fromDriver runs on the mapper itself (`this`)', () => {
    const mapper = {
      immutable: true as const,
      prefix: 'at ',
      fromDriver(value: unknown): unknown {
        return `${this.prefix}${value}`;
      },
    };

    expect(forResultSet(mapper).fromDriver(A)).toBe(`at ${A}`);
  });

  test('what fromDriver throws propagates as it is, and nothing is kept for that value', () => {
    const failure = new Error('unreadable moment');
    const mapper = countingMapper(value => {
      if (value === 'bad') {
        throw failure;
      }

      return { value };
    });
    const read = forResultSet(mapper);
    const good = read.fromDriver(A);
    const thrown: unknown[] = [];

    for (let i = 0; i < 2; i++) {
      try {
        read.fromDriver('bad');
      } catch (error) {
        thrown.push(error);
      }
    }

    expect(thrown).toEqual([failure, failure]);
    expect(thrown[0]).toBe(failure);
    expect(read.fromDriver(A)).toBe(good);
    expect(mapper.calls).toBe(3);
  });

  test('a driver value mapped to undefined is not kept: it maps every time', () => {
    const mapper = countingMapper(value => (value === 'gap' ? undefined : { value }));
    const read = forResultSet(mapper);

    expect(read.fromDriver('gap')).toBeUndefined();
    expect(read.fromDriver('gap')).toBeUndefined();
    expect(mapper.calls).toBe(2);
  });

  test('two result sets never share: each forResultSet() is a memo of its own', () => {
    const mapper = countingMapper();
    const first = forResultSet(mapper);
    const second = forResultSet(mapper);

    expect(second).not.toBe(first);
    expect(second.fromDriver(A)).not.toBe(first.fromDriver(A));
    expect(first.fromDriver(A)).toBe(first.fromDriver(A));
    expect(mapper.calls).toBe(2);
  });

  test(`a column whose first ${SHARED_VALUES_PROBE} values are all distinct stops memoizing: a later repeat maps again`, () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const first = read.fromDriver('v0');

    for (let i = 1; i < SHARED_VALUES_PROBE; i++) {
      read.fromDriver(`v${i}`);
    }

    // Still memoizing: the probe has not seen a new value past its window yet
    expect(read.fromDriver('v0')).toBe(first);

    const mapperWithoutRepeat = countingMapper();
    const noRepeat = forResultSet(mapperWithoutRepeat);
    const noRepeatFirst = noRepeat.fromDriver('v0');

    for (let i = 1; i <= SHARED_VALUES_PROBE; i++) {
      noRepeat.fromDriver(`v${i}`);
    }

    expect(noRepeat.fromDriver('v0')).not.toBe(noRepeatFirst);
    expect(noRepeat.fromDriver('v0')).toEqual({ value: 'v0' });
    expect(mapperWithoutRepeat.calls).toBe(SHARED_VALUES_PROBE + 3);
  });

  test('one repeat within the first values keeps a column memoizing past them', () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const first = read.fromDriver('v0');

    read.fromDriver('v0');

    for (let i = 1; i <= SHARED_VALUES_PROBE * 2; i++) {
      read.fromDriver(`v${i}`);
    }

    expect(read.fromDriver('v0')).toBe(first);
    expect(read.fromDriver(`v${SHARED_VALUES_PROBE * 2}`)).toBe(read.fromDriver(`v${SHARED_VALUES_PROBE * 2}`));
    expect(mapper.calls).toBe(SHARED_VALUES_PROBE * 2 + 1);
  });

  test(`a memo that fills its ${SHARED_VALUES_CAP} values with at least as many repeats keeps them and adds no more`, () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const first = read.fromDriver('v0');

    for (let i = 0; i < SHARED_VALUES_CAP; i++) {
      read.fromDriver(`v${i}`);
      read.fromDriver(`v${i}`);
    }

    expect(mapper.calls).toBe(SHARED_VALUES_CAP);

    // Full: a new value maps on its own, every time; the values kept are still shared
    const late = read.fromDriver('late');

    expect(read.fromDriver('late')).not.toBe(late);
    expect(read.fromDriver('v0')).toBe(first);
    expect(read.fromDriver(`v${SHARED_VALUES_CAP - 1}`)).toBe(read.fromDriver(`v${SHARED_VALUES_CAP - 1}`));
    expect(mapper.calls).toBe(SHARED_VALUES_CAP + 2);
  });

  test(`a memo that fills its ${SHARED_VALUES_CAP} values with fewer repeats than values gives up`, () => {
    const mapper = countingMapper();
    const read = forResultSet(mapper);
    const first = read.fromDriver('v0');

    // One repeat keeps the probe from giving up; then distinct values only
    read.fromDriver('v0');

    for (let i = 1; i < SHARED_VALUES_CAP; i++) {
      read.fromDriver(`v${i}`);
    }

    expect(read.fromDriver('v0')).toBe(first);
    expect(mapper.calls).toBe(SHARED_VALUES_CAP);

    read.fromDriver('late');

    expect(read.fromDriver('v0')).not.toBe(first);
    expect(read.fromDriver('v1')).not.toBe(read.fromDriver('v1'));
    expect(mapper.calls).toBe(SHARED_VALUES_CAP + 4);
  });

  test('a reader kept by a read plan is made anew for each result set; without the flag it is kept as it is', () => {
    const shared = countingMapper();
    const plain = { fromDriver: (value: unknown) => ({ value }) };
    const readers = new Map<string, (value: unknown) => unknown>([
      ['shared', readerThrough(shared, mapper => (value: unknown) => mapper.fromDriver(value))],
      ['plain', readerThrough(plain, mapper => (value: unknown) => mapper.fromDriver(value))],
    ]);

    // Read without a result set of its own, it maps every value
    expect(readers.get('shared')!(A)).not.toBe(readers.get('shared')!(A));

    const one = readersForResultSet(readers);
    const two = readersForResultSet(readers);

    expect(one.get('shared')!(A)).toBe(one.get('shared')!(A));
    expect(two.get('shared')!(A)).not.toBe(one.get('shared')!(A));
    expect(one.get('plain')).toBe(readers.get('plain'));

    const plainOnly = new Map([['plain', readers.get('plain')!]]);

    expect(readersForResultSet(plainOnly)).toBe(plainOnly);
  });
});

describe('the probe window follows the values a result set holds', () => {
  /** A column of `period` distinct values cycling `cycles` times, read through `read`: the fromDriver calls. */
  const readCycles = (read: { fromDriver(value: unknown): unknown }, period: number, cycles: number): void => {
    for (let c = 0; c < cycles; c++) {
      for (let v = 0; v < period; v++) {
        read.fromDriver(`v${v}`);
      }
    }
  };

  test(`${SHARED_VALUES_PROBE} values for an unknown count; N / ${SHARED_VALUES_REPEATS} for N values, between ${SHARED_VALUES_PROBE} and ${SHARED_VALUES_CAP}`, () => {
    expect(probeWindow(undefined)).toBe(SHARED_VALUES_PROBE);
    expect(probeWindow(2)).toBe(SHARED_VALUES_PROBE);
    expect(probeWindow(SHARED_VALUES_PROBE * SHARED_VALUES_REPEATS)).toBe(SHARED_VALUES_PROBE);
    expect(probeWindow(1000)).toBe(Math.max(SHARED_VALUES_PROBE, Math.floor(1000 / SHARED_VALUES_REPEATS)));
    expect(probeWindow(1001)).toBe(Math.max(SHARED_VALUES_PROBE, Math.floor(1001 / SHARED_VALUES_REPEATS)));
    expect(probeWindow(SHARED_VALUES_CAP * SHARED_VALUES_REPEATS)).toBe(SHARED_VALUES_CAP);
    expect(probeWindow(1_000_000)).toBe(SHARED_VALUES_CAP);
  });

  // The review's U5: a column repeating only every more than 128 rows — a calendar read entity by entity
  for (const period of [100, 129, 200, 365]) {
    test(`a period of ${period} over 20 cycles shares when the memo knows its ${period * 20} values — not without a count above ${SHARED_VALUES_PROBE}`, () => {
      const counted = countingMapper();
      const uncounted = countingMapper();

      readCycles(forResultSet(counted, period * 20), period, 20);
      readCycles(forResultSet(uncounted), period, 20);

      expect(counted.calls).toBe(period);
      expect(uncounted.calls).toBe(period <= SHARED_VALUES_PROBE ? period : period * 20);
    });
  }

  test(`a period that each value repeats fewer than ${SHARED_VALUES_REPEATS} times over does not`, () => {
    const mapper = countingMapper();

    // 300 distinct values, then the first 100 again: 400 values, a window of max(128, 200)
    const read = forResultSet(mapper, 400);

    readCycles(read, 300, 1);
    readCycles(read, 100, 1);

    expect(mapper.calls).toBe(400);
  });

  test('the window is the count\'s: the value past it with no repeat gives up, one within it does not', () => {
    const window = probeWindow(1000);
    const full = countingMapper();
    const within = forResultSet(full, 1000);
    const first = within.fromDriver('v0');

    // `window` distinct values, no repeat: still memoizing
    for (let i = 1; i < window; i++) {
      within.fromDriver(`v${i}`);
    }

    expect(within.fromDriver('v0')).toBe(first);

    const past = countingMapper();
    const beyond = forResultSet(past, 1000);
    const beyondFirst = beyond.fromDriver('v0');

    // One distinct value more: it gives up
    for (let i = 1; i <= window; i++) {
      beyond.fromDriver(`v${i}`);
    }

    expect(beyond.fromDriver('v0')).not.toBe(beyondFirst);
    expect(past.calls).toBe(window + 2);
  });

  test('fewer than two values: no memo at all — the mapper itself; a count to compute is computed then', () => {
    const mapper = countingMapper();

    expect(forResultSet(mapper, 0)).toBe(mapper);
    expect(forResultSet(mapper, 1)).toBe(mapper);
    expect(forResultSet(mapper, () => 1)).toBe(mapper);
    expect(forResultSet(mapper, 2)).not.toBe(mapper);
    expect(forResultSet(mapper, () => 2)).not.toBe(mapper);
  });

  test('a count to compute is never computed for a mapper without the flag, and once for many memos', () => {
    const plain = { fromDriver: (value: unknown) => value };
    let counted = 0;
    const count = countedOnce(() => {
      counted++;

      return 10;
    });

    expect(forResultSet(plain, () => {
      throw new Error('not asked');
    })).toBe(plain);

    forResultSet(countingMapper(), count);
    forResultSet(countingMapper(), count);

    expect(counted).toBe(1);
    expect(countedOnce(7)).toBe(7);
  });

  test('a memo holds no Map before it keeps a value', () => {
    const read = forResultSet(countingMapper(), 10) as unknown as { values?: Map<unknown, unknown>; fromDriver(value: unknown): unknown };

    expect(read.values).toBeUndefined();
    read.fromDriver(null);
    read.fromDriver(new Date(0));
    expect(read.values).toBeUndefined();
    read.fromDriver(A);
    expect(read.values).toBeInstanceOf(Map);
  });

  test('a reader of the rows over one row is the plan\'s own reader; a reader of a list\'s elements still shares them', () => {
    const mapper = countingMapper();
    const make = (read: { fromDriver(value: unknown): unknown }) => ({ fromDriver: (value: unknown) => read.fromDriver(value) });
    const ofRows = readerThrough(mapper, make);
    const ofElements = readerThrough(mapper, make, false);

    expect(forResultSet(ofRows, 1)).toBe(ofRows);

    const elements = forResultSet(ofElements, 1);

    expect(elements).not.toBe(ofElements);
    expect(elements.fromDriver(A)).toBe(elements.fromDriver(A));
    expect(mapper.calls).toBe(1);

    // A plan's reader of the rows around a list (a grouped query's agg.arrayAgg()): one row still shares its elements
    const ofListRows = readerThrough(ofElements, make);
    const listRow = forResultSet(ofListRows, 1);

    expect(listRow).not.toBe(ofListRows);
    expect(listRow.fromDriver(B)).toBe(listRow.fromDriver(B));
    expect(mapper.calls).toBe(2);

    // A plan whose readers read the rows through a mapper itself: one row leaves the plan as it is
    const plan = new Map([['rows', ofRows]]);

    expect(readersForResultSet(plan, 1)).toBe(plan);
    expect(readersForResultSet(plan, 2)).not.toBe(plan);
    expect(readersForResultSet(new Map([['list', ofListRows]]), 1).get('list')).not.toBe(ofListRows);
  });

  test('how a derived mapper is made anew is not an own property: a spread of it does not carry it along', () => {
    const mapper = countingMapper();
    const derived = readerThrough(mapper, read => ({ fromDriver: (value: unknown) => read.fromDriver(value) }));
    const other = (value: unknown) => ({ other: value });
    const spread = { ...derived, fromDriver: other };

    expect(Object.getOwnPropertySymbols(derived)).toEqual([]);
    expect(sharesValues(derived)).toBe(true);
    expect(sharesValues(spread)).toBe(false);
    expect(forResultSet(spread, 10)).toBe(spread);
    expect(forResultSet(spread, 10).fromDriver(A)).toEqual({ other: A });
  });

  test('the values rows carry at a path: a list\'s elements, one per other non-NULL value', () => {
    const rows = [
      { items: [1, 2, 3], one: { at: 'x' }, deep: { list: [1] } },
      { items: [], one: null, deep: { list: [1, 2] } },
      { items: null, one: { at: 'y' }, deep: null },
      { one: 'z' },
    ];

    expect(valuesAt(rows, ['items'])).toBe(3);
    expect(valuesAt(rows, ['one'])).toBe(3);
    expect(valuesAt(rows, ['one', 'at'])).toBe(2);
    expect(valuesAt(rows, ['deep', 'list'])).toBe(3);
    expect(valuesAt([], ['items'])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every place a result set reads a mapped value
// ---------------------------------------------------------------------------------------------------------------

describe('a custom type declared immutable, read by queries', () => {
  let db: HarbourDatabase;
  let client: DatabaseClient;
  const dockIds: Record<string, number> = {};
  const vesselIds: Record<string, number> = {};

  beforeAll(async () => {
    client = createFreshClient();
    db = new HarbourDatabase(client);

    await dropTables(client);
    await db.getSchemaManager().ensureCreated();

    const docks = await db.docks.insertBulk([
      { name: 'North', openedAt: new Stamp(OPENED_EARLY) },
      { name: 'South', openedAt: new Stamp(OPENED_EARLY) },
      { name: 'East', openedAt: new Stamp(OPENED_LATE) },
    ]).returning();

    for (const dock of docks) {
      dockIds[dock.name] = dock.id;
    }

    const vessels = await db.vessels.insertBulk(VESSELS.map((v, i) => ({
      dockId: dockIds[v.dock],
      name: v.name,
      arrivedAt: new Stamp(v.at),
      arrivedCopy: new Stamp(v.at),
      arrivedDay: new Day(v.day),
      note: v.note === null ? null : new Note(v.note),
      loggedAt: new Stamp(v.at),
      berth: (i % 3) + 1,
    })) as any).returning();

    for (const vessel of vessels) {
      vesselIds[vessel.name] = vessel.id;
    }

    await db.cargo.insertBulk(CARGO.map(c => ({ vesselId: vesselIds[c.vessel], label: c.label, loadedAt: new Stamp(c.at) })));
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  beforeEach(() => {
    resetCalls();
  });

  describe('a plain select', () => {
    test('without the flag: fromDriver once per row, every row a value of its own — as it always was', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, at: v.arrivedCopy })).orderBy(v => v.name).toList();

      expect(texts(rows.map(r => r.at))).toEqual(ARRIVALS);
      expectOwnValues(rows.map(r => r.at));
      expect(calls.copy).toBe(VESSELS.length);
    });

    test('with it: fromDriver once per distinct value, rows with the same value share ONE, others differ', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, at: v.arrivedAt })).orderBy(v => v.name).toList();

      expect(texts(rows.map(r => r.at))).toEqual(ARRIVALS);
      expectShared(rows.map(r => r.at));
      expect(rows[0].at).toBe(rows[2].at);          // Ada, Cleo: A
      expect(rows[0].at).not.toBe(rows[1].at);      // Ada A, Bea B
      expect(calls.stamp).toBe(3);
    });

    test('two queries never share a value — the same query run twice either', async () => {
      const first = await db.vessels.select(v => ({ name: v.name, at: v.arrivedAt })).orderBy(v => v.name).toList();
      const query = db.vessels.select(v => ({ name: v.name, at: v.arrivedAt })).orderBy(v => v.name);
      const second = await query.toList();
      const third = await query.toList();

      first.forEach((row, i) => {
        expect(second[i].at).not.toBe(row.at);
        expect(third[i].at).not.toBe(second[i].at);
        expect(second[i].at).toEqual(row.at);
      });
      expect(calls.stamp).toBe(9);
    });

    test('each column its own memo: one column read twice maps its values twice; a number-keyed type shares too', async () => {
      const rows = await db.vessels.select(v => ({ at: v.arrivedAt, again: v.arrivedAt, day: v.arrivedDay })).toList();
      const days = rows.map(r => r.day as unknown as Day);

      expectShared(rows.map(r => r.at));
      expectShared(rows.map(r => r.again));
      expect(days.map(day => day.n).sort()).toEqual([1001, 1001, 1001, 1001, 1002, 1002, 1002, 1002]);
      // Two distinct days: two objects for the eight rows
      expect(new Set(days).size).toBe(2);
      expect(calls.stamp).toBe(6);
      expect(calls.day).toBe(2);
    });

    test('NULL goes through fromDriver on every row, as without the flag: each NULL row its own value', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, note: v.note })).orderBy(v => v.name).toList();
      const notes = rows.map(r => r.note as unknown as Note);
      const nullNotes = notes.filter(note => note.text === null);

      expect(notes.map(note => note.text)).toEqual(['calm', null, 'calm', 'rough', null, 'calm', 'rough', null]);
      expectOwnValues(nullNotes);
      expectShared(notes.filter(note => note.text !== null));
      // 3 NULL rows + 2 distinct notes
      expect(calls.note).toBe(5);
    });

    test('a fromDriver that throws fails the query with what it threw — with the flag as without it', async () => {
      const failure = new Error('unreadable note');
      const failing = (immutable: boolean) => createCustomType<{ data: Note; driverData: string }>({
        dataType: () => 'text',
        toDriver: value => (value == null ? null : value.text),
        fromDriver: value => {
          if (value === 'rough') {
            throw failure;
          }

          return new Note(value ?? null);
        },
        immutable,
      });
      const read = async (immutable: boolean): Promise<unknown> => {
        try {
          await db.vessels.select(v => ({ note: sql<string>`${v.note}`.mapWith(failing(immutable)) })).toList();
        } catch (error) {
          return error;
        }

        return undefined;
      };

      expect(await read(true)).toBe(failure);
      expect(await read(false)).toBe(failure);

      // The next query is unaffected
      const calm = await db.vessels.where(v => eq(v.name, 'Ada')).select(v => ({ note: v.note })).toList();

      expect((calm[0].note as unknown as Note).text).toBe('calm');
    });

    test('an entity read whole: the table\'s toList() and a filtered select of every column', async () => {
      const all = await db.vessels.toList();

      expectShared(all.map(v => v.arrivedAt as unknown as Stamp));
      expectOwnValues(all.map(v => v.arrivedCopy as unknown as Stamp));
      expect(calls.stamp).toBe(3);
      expect(calls.copy).toBe(VESSELS.length);

      resetCalls();
      const filtered = await db.vessels.where(v => gt(v.berth, 0)).toList();

      expectShared(filtered.map(v => v.arrivedAt as unknown as Stamp));
      expect(filtered.map(v => v.arrivedAt)[0]).not.toBe(all.find(v => v.name === filtered[0].name)!.arrivedAt);
      expect(calls.stamp).toBe(3);
    });

    test('a selector returning ONE column reads as its values, shared', async () => {
      const values = await db.vessels.orderBy(v => v.name).select(v => v.arrivedAt).toList();

      expect(texts(values as unknown as Stamp[])).toEqual(ARRIVALS);
      expectShared(values as unknown as Stamp[]);
      expect(calls.stamp).toBe(3);
    });

    test('an expression read through the type (mapWith) shares; an inline function mapper never does', async () => {
      const rows = await db.vessels.select(v => ({
        typed: sql<string>`${v.arrivedAt}`.mapWith(stampType),
        inline: sql<string>`${v.arrivedAt}`.mapWith((value: string) => new Stamp(value)),
      })).toList();

      expectShared(rows.map(r => r.typed as unknown as Stamp));
      expectOwnValues(rows.map(r => r.inline));
      expect(calls.stamp).toBe(3);
    });

    test('an expression read through the builder form of a custom type (customType) shares too', async () => {
      const rows = await db.vessels.select(v => ({ day: sql<number>`${v.berth} * 0 + 1001`.mapWith(dayBuilder) })).toList();
      const days = rows.map(r => r.day as unknown as Day);

      expect(days.map(day => day.n)).toEqual(VESSELS.map(() => 1001));
      expect(new Set(days).size).toBe(1);
      expect(calls.day).toBe(1);
    });

    test('a one-row read (firstOrDefault()) maps each of its values once — through the type itself, no memo', async () => {
      const first = await db.vessels.where(v => eq(v.name, 'Ada')).select(v => ({ at: v.arrivedAt, again: v.arrivedAt })).firstOrDefault();

      expect(first!.at.text).toBe(A);
      expect(first!.again).not.toBe(first!.at);
      expect(calls.stamp).toBe(2);
    });
  });

  describe('navigations', () => {
    test('a navigation\'s column: the dock\'s opening shared by its vessels and by docks that opened together', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, opened: v.dock!.openedAt })).orderBy(v => v.name).toList();

      expect(texts(rows.map(r => r.opened))).toEqual([OPENED_EARLY, OPENED_EARLY, OPENED_EARLY, OPENED_EARLY, OPENED_EARLY, OPENED_EARLY, OPENED_LATE, OPENED_LATE]);
      expectShared(rows.map(r => r.opened));
      expect(calls.stamp).toBe(2);
    });

    test('a navigation row projected whole: its mapped columns shared across the rows', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, at: v.arrivedAt, dock: v.dock })).orderBy(v => v.name).toList();
      const docks = rows.map(r => r.dock!);

      expect(docks.map(d => d.name)).toEqual(['North', 'North', 'North', 'South', 'South', 'South', 'East', 'East']);
      expectShared(docks.map(d => d.openedAt as unknown as Stamp));
      expectShared(rows.map(r => r.at));
      // Each row still gets a dock object of its own
      expect(docks[0]).not.toBe(docks[1]);
      expect(calls.stamp).toBe(3 + 2);
    });

    test('a nested object of the projection: its mapped values shared as the top level\'s', async () => {
      const rows = await db.vessels.select(v => ({ name: v.name, when: { at: v.arrivedAt, day: v.arrivedDay, copy: v.arrivedCopy } })).toList();

      expectShared(rows.map(r => r.when.at));
      expectOwnValues(rows.map(r => r.when.copy));
      expect(calls.stamp).toBe(3);
      expect(calls.day).toBe(2);
      expect(calls.copy).toBe(VESSELS.length);
    });
  });

  describe('collections', () => {
    for (const strategy of ['cte', 'lateral', 'temptable'] as const) {
      describe(strategy, () => {
        const docks = () => db.docks.withQueryOptions({ collectionStrategy: strategy });

        test('a list\'s items share across every parent row; without the flag they do not', async () => {
          const rows = await docks().select(d => ({
            name: d.name,
            vessels: d.vessels!.orderBy(v => v.name).select(v => ({ name: v.name, at: v.arrivedAt, copy: v.arrivedCopy })).toList(),
          })).orderBy(d => d.name).toList();
          const items = rows.flatMap(r => r.vessels);

          expect(items.map(i => i.name).sort()).toEqual(VESSELS.map(v => v.name).sort());
          expectShared(items.map(i => i.at));
          expectOwnValues(items.map(i => i.copy));
          expect(calls.stamp).toBe(3);
          expect(calls.copy).toBe(VESSELS.length);
        });

        test('firstOrDefault(): the one item of every parent row, shared', async () => {
          const rows = await docks().select(d => ({
            name: d.name,
            latest: d.vessels!.orderBy(v => [[v.berth, 'DESC'], [v.name, 'ASC']]).select(v => ({ at: v.arrivedAt, day: v.arrivedDay })).firstOrDefault(),
          })).orderBy(d => d.name).toList();

          // East: Hal (berth 2, A) · North: Cleo (berth 3, A) · South: Fay (berth 3, B)
          expect(rows.map(r => r.latest!.at.text)).toEqual([A, A, B]);
          expect(rows[0].latest!.at).toBe(rows[1].latest!.at);
          expect(calls.stamp).toBe(2);
        });

        test('a nested collection: the cargo of every vessel of every dock, shared', async () => {
          const rows = await docks().select(d => ({
            name: d.name,
            vessels: d.vessels!.select(v => ({
              name: v.name,
              cargo: v.cargo!.select(c => ({ label: c.label, at: c.loadedAt })).toList(),
            })).toList(),
          })).toList();
          const cargo = rows.flatMap(r => r.vessels.flatMap(v => v.cargo));

          expect(cargo.map(c => c.label).sort()).toEqual(CARGO.map(c => c.label).sort());
          expectShared(cargo.map(c => c.at));
          expect(calls.stamp).toBe(3);
        });

        test('a nested object in the items reads its values through the same memo', async () => {
          const rows = await docks().select(d => ({
            vessels: d.vessels!.select(v => ({ name: v.name, when: { at: v.arrivedAt } })).toList(),
          })).toList();
          const items = rows.flatMap(r => r.vessels);

          expect(items).toHaveLength(VESSELS.length);
          expectShared(items.map(i => i.when.at));
          expect(calls.stamp).toBe(3);
        });

        test('two queries of the same collection never share', async () => {
          const query = () => docks().select(d => ({ name: d.name, vessels: d.vessels!.orderBy(v => v.name).select(v => ({ name: v.name, at: v.arrivedAt })).toList() })).orderBy(d => d.name);
          const [one, two] = [await query().toList(), await query().toList()];
          const first = one.flatMap(r => r.vessels);
          const second = two.flatMap(r => r.vessels);

          first.forEach((item, i) => {
            expect(second[i].at).not.toBe(item.at);
            expect(second[i].at).toEqual(item.at);
          });
          expect(calls.stamp).toBe(6);
        });
      });
    }
  });

  describe('QueryBatch and futures', () => {
    test('each branch shares within its own rows, never with another branch — the same query twice included', async () => {
      const list = () => db.vessels.select(v => ({ name: v.name, at: v.arrivedAt, copy: v.arrivedCopy })).orderBy(v => v.name);
      const batch = new QueryBatch();
      const one = batch.addList(list(), 'one');
      const two = batch.addList(list(), 'two');
      const first = batch.addFirstOrDefault(db.vessels.where(v => eq(v.name, 'Ada')).select(v => ({ at: v.arrivedAt })), 'first');

      await batch.executeBatch();

      const rowsOne = batch.getList(one);
      const rowsTwo = batch.getList(two);

      expect(texts(rowsOne.map(r => r.at))).toEqual(ARRIVALS);
      expectShared(rowsOne.map(r => r.at));
      expectShared(rowsTwo.map(r => r.at));
      expectOwnValues(rowsOne.map(r => r.copy));
      rowsOne.forEach((row, i) => expect(rowsTwo[i].at).not.toBe(row.at));
      expect(batch.getItem(first)!.at).not.toBe(rowsOne[0].at);
      expect(calls.stamp).toBe(3 + 3 + 1);
    });

    test('a declared timestamp column: its text rebuilt from the JSON form is what the rows share', async () => {
      const batch = new QueryBatch();
      const key = batch.addList(db.vessels.select(v => ({ name: v.name, logged: v.loggedAt })).orderBy(v => v.name), 'logged');

      await batch.executeBatch();

      const rows = batch.getList(key);

      expect(texts(rows.map(r => r.logged))).toEqual(ARRIVALS);
      expectShared(rows.map(r => r.logged));
      expect(calls.logged).toBe(3);
    });

    test('a collection in a batch branch: its items shared across the parent rows', async () => {
      const batch = new QueryBatch();
      const key = batch.addList(db.docks.select(d => ({ vessels: d.vessels!.select(v => ({ at: v.arrivedAt })).toList() })), 'docks');

      await batch.executeBatch();

      expectShared(batch.getList(key).flatMap(r => r.vessels).map(i => i.at));
      expect(calls.stamp).toBe(3);
    });

    test('a future executed twice, and the futures of FutureQueryRunner, share within their own result only', async () => {
      const future = db.vessels.select(v => ({ at: v.arrivedAt })).orderBy(v => v.at).future();
      const first = await future.execute();
      const second = await future.execute();

      expectShared(first.map(r => r.at));
      expectShared(second.map(r => r.at));
      first.forEach((row, i) => expect(second[i].at).not.toBe(row.at));

      const [a, b] = await FutureQueryRunner.runAsync([
        db.vessels.select(v => ({ at: v.arrivedAt })).future(),
        db.vessels.select(v => ({ at: v.arrivedAt })).future(),
      ] as const);

      expectShared(a.map(r => r.at));
      expect(new Set([...a.map(r => r.at), ...b.map(r => r.at)]).size).toBe(6);
      expect(calls.stamp).toBe(12);
    });

    test('a prepared query shares within each execution only', async () => {
      const prepared = db.vessels.where(v => gt(v.berth, sql.placeholder('minBerth'))).select(v => ({ at: v.arrivedAt })).prepare('imv_prepared');
      const first = await prepared.execute({ minBerth: 0 });
      const second = await prepared.execute({ minBerth: 0 });

      expectShared(first.map(r => r.at));
      expectShared(second.map(r => r.at));
      expect(new Set([...first.map(r => r.at), ...second.map(r => r.at)]).size).toBe(6);
      expect(calls.stamp).toBe(6);
    });
  });

  describe('grouped queries', () => {
    const byDockAndDay = () => db.vessels
      .select(v => ({ dockId: v.dockId, day: v.arrivedDay, at: v.arrivedAt }))
      .groupBy(r => ({ dockId: r.dockId, day: r.day }));

    test('a mapped grouping key repeating across groups is shared; a MIN / MAX through the type too', async () => {
      const rows = await byDockAndDay()
        .select(g => ({ dockId: g.key.dockId, day: g.key.day, latest: g.max(r => r.at), vessels: g.count() }))
        .orderBy(r => [r.dockId, r.day])
        .toList();
      const days = rows.map(r => r.day as unknown as Day);
      const latest = rows.map(r => r.latest as unknown as Stamp);

      // North 1001 (A, B), North 1002 (A), South 1001 (A, B), South 1002 (C), East 1002 (C, A)
      expect(days.map(d => d.n)).toEqual([1001, 1002, 1001, 1002, 1002]);
      expect(texts(latest)).toEqual([B, A, B, C, C]);
      expect(days[0]).toBe(days[2]);
      expect(days[1]).toBe(days[3]);
      expectShared(latest);
      expect(calls.day).toBe(2);
      expect(calls.stamp).toBe(3);
    });

    test('a grouped future executed twice, and a grouped query in a QueryBatch, share within their own result', async () => {
      const grouped = () => byDockAndDay().select(g => ({ dockId: g.key.dockId, day: g.key.day, latest: g.max(r => r.at) })).orderBy(r => [r.dockId, r.day]);
      const future = grouped().future();
      const first = await future.execute();
      const second = await future.execute();

      expectShared(first.map(r => r.latest as unknown as Stamp));
      first.forEach((row, i) => expect(second[i].latest).not.toBe(row.latest));

      const batch = new QueryBatch();
      const key = batch.addList(grouped(), 'grouped');

      await batch.executeBatch();

      const batched = batch.getList(key);

      expectShared(batched.map(r => r.latest as unknown as Stamp));
      expect(texts(batched.map(r => r.latest as unknown as Stamp))).toEqual(texts(first.map(r => r.latest as unknown as Stamp)));
      expect(calls.stamp).toBe(9);
    });

    test('a grouped query joined to a CTE: its grouped fields and the CTE\'s columns shared, never across runs', async () => {
      const opened = new DbCteBuilder().with('imv_dock_openings', db.docks.select(d => ({ dockId: d.id, opened: d.openedAt })));
      const joined = byDockAndDay()
        .select(g => ({ dockId: g.key.dockId, day: g.key.day, latest: g.max(r => r.at) }))
        .innerJoin(opened.cte, (g, o) => eq(g.dockId, o.dockId), (g, o) => ({ dockId: g.dockId, day: g.day, latest: g.latest, opened: o.opened }))
        .orderBy(r => [r.dockId, r.day]);
      const first = await joined.toList();
      const second = await joined.toList();

      expect(first).toHaveLength(5);
      expectShared(first.map(r => r.latest as unknown as Stamp));
      expectShared(first.map(r => r.opened as unknown as Stamp));
      expect(first[0].day).toBe(first[2].day);
      first.forEach((row, i) => {
        expect(second[i].latest).not.toBe(row.latest);
        expect(second[i].opened).not.toBe(row.opened);
      });
      expect(calls.stamp).toBe(2 * (3 + 2));
    });

    test('agg.arrayAgg() through the type in a grouped select: a list\'s elements share — in a one-group result too', async () => {
      const [north, ...none] = await db.vessels
        .where(v => eq(v.dockId, dockIds.North))
        .select(v => ({ dockId: v.dockId }))
        .groupBy(r => ({ dockId: r.dockId }))
        .select(g => ({
          dockId: g.key.dockId,
          arrivals: agg.arrayAgg(sql<string>`"imv_vessels"."arrived_at"`.mapWith(stampType), { orderBy: sql`"imv_vessels"."name"` }),
        }))
        .toList();
      const list = north.arrivals as unknown as Stamp[];

      expect(none).toHaveLength(0);
      expect(texts(list)).toEqual([A, B, A]);
      expectShared(list);
      expect(calls.stamp).toBe(2);
    });
  });

  describe('other reads', () => {
    test('a UNION reads every leg\'s rows as one result set', async () => {
      const rows = await db.vessels.where(v => eq(v.dockId, dockIds.North)).select(v => ({ name: v.name, at: v.arrivedAt }))
        .unionAll(db.vessels.where(v => eq(v.dockId, dockIds.East)).select(v => ({ name: v.name, at: v.arrivedAt })))
        .toList();

      expect(rows.map(r => r.name).sort()).toEqual(['Ada', 'Bea', 'Cleo', 'Gus', 'Hal']);
      expectShared(rows.map(r => r.at));
      expect(calls.stamp).toBe(3);
    });

    test('a CTE\'s column — joined, and at a CTE root', async () => {
      const cte = new DbCteBuilder().with('imv_arrivals', db.vessels.select(v => ({ vid: v.id, dockId: v.dockId, at: v.arrivedAt })));
      const joined = await db.docks
        .with(cte.cte)
        .innerJoin(cte.cte, (d, x) => eq(d.id, x.dockId), (d, x) => ({ name: d.name, at: x.at, opened: d.openedAt }))
        .toList();

      expect(joined).toHaveLength(VESSELS.length);
      expectShared(joined.map(r => r.at as unknown as Stamp));
      expectShared(joined.map(r => r.opened as unknown as Stamp));
      expect(calls.stamp).toBe(3 + 2);

      resetCalls();
      const root = await db.selectFromCte(cte.cte).select(x => ({ vid: x.vid, at: x.at })).toList();

      expectShared(root.map(r => r.at as unknown as Stamp));
      expect(calls.stamp).toBe(3);
    });

    test('a withAggregation CTE\'s items, through the aggregated query\'s type', async () => {
      const builder = new DbCteBuilder();
      const arrivals = builder.withAggregation(
        'imv_dock_arrivals',
        db.vessels.select(v => ({ dockId: v.dockId, name: v.name, at: v.arrivedAt })),
        v => ({ dockId: v.dockId }),
        'arrivals',
      );
      const rows = await db.docks
        .with(...builder.getCtes())
        .leftJoin(arrivals, (d, a) => eq(d.id, a.dockId), (d, a) => ({ name: d.name, arrivals: a.arrivals }))
        .toList();
      const items = rows.flatMap(r => r.arrivals as unknown as Array<{ at: Stamp }>);

      expect(items).toHaveLength(VESSELS.length);
      expectShared(items.map(i => i.at));
      expect(calls.stamp).toBe(3);
    });

    test('agg.arrayAgg() of the column: the elements of the list share', async () => {
      const row = await db.vessels.select(v => ({ list: agg.arrayAgg(v.arrivedAt, { orderBy: v.name }) })).firstOrDefault();
      const list = row!.list as unknown as Stamp[];

      expect(texts(list)).toEqual(ARRIVALS);
      expectShared(list);
      expect(calls.stamp).toBe(3);
    });

    test('a JoinQueryBuilder\'s columns of either table', async () => {
      const vessels = (db.vessels as any)._getSchema();
      const docks = (db.docks as any)._getSchema();
      const on = eq({ __dbColumnName: 'dock_id', __tableAlias: 'v' } as any, { __dbColumnName: 'id', __tableAlias: 'd' } as any);
      const join = new JoinQueryBuilder<any, any>(vessels, 'v', docks, 'd', 'INNER', on, client);

      join._setSelection((v: any, d: any) => ({ name: v.name, at: v.arrivedAt, opened: d.openedAt }));

      const rows = await join.toList();

      expect(rows).toHaveLength(VESSELS.length);
      expectShared(rows.map(r => r.at));
      expectShared(rows.map(r => r.opened));
      expect(calls.stamp).toBe(3 + 2);
    });
  });

  describe('mutations', () => {
    const moored = (i: number) => ({
      dockId: dockIds.East,
      name: `Moored ${i}`,
      arrivedAt: new Stamp(i % 2 === 0 ? A : B),
      arrivedCopy: new Stamp(A),
      arrivedDay: new Day(1003),
      note: null,
      loggedAt: new Stamp(A),
      berth: 9,
    });

    afterAll(async () => {
      await db.vessels.where(v => eq(v.berth, 9)).delete();
    });

    test('RETURNING of an insertBulk — a selector and the whole entity — shares within the statement', async () => {
      const selected = await db.vessels.insertBulk([0, 1, 2, 3].map(moored) as any).returning(v => ({ name: v.name, at: v.arrivedAt, day: v.arrivedDay }));

      expect(texts(selected.map(r => r.at))).toEqual([A, B, A, B]);
      expectShared(selected.map(r => r.at));
      expect(selected[0].day).toBe(selected[3].day);
      expect(calls.stamp).toBe(2);
      expect(calls.day).toBe(1);

      resetCalls();
      const whole = await db.vessels.insertBulk([4, 5, 6].map(moored) as any).returning();

      expectShared(whole.map(v => v.arrivedAt as unknown as Stamp));
      expectOwnValues(whole.map(v => v.arrivedCopy as unknown as Stamp));
      expect(calls.stamp).toBe(2);
    });

    test('RETURNING of an update and of a delete; two statements never share', async () => {
      const updated = await db.vessels.where(v => eq(v.berth, 9)).update({ berth: 9 }).returning(v => ({ at: v.arrivedAt, opened: v.arrivedAt }));
      const again = await db.vessels.where(v => eq(v.berth, 9)).update({ berth: 9 }).returning(v => ({ at: v.arrivedAt, opened: v.arrivedAt }));

      // The seven vessels the insertBulk test moored
      expect(updated).toHaveLength(7);
      expect(texts(updated.map(r => r.at)).sort()).toEqual([A, A, A, A, B, B, B]);
      expectShared(updated.map(r => r.at));
      expectShared(again.map(r => r.at));
      expect(new Set([...updated.map(r => r.at), ...again.map(r => r.at)]).size).toBe(4);

      resetCalls();
      const deleted = await db.vessels.where(v => eq(v.berth, 9)).delete().returning();

      expect(deleted.length).toBe(updated.length);
      expectShared(deleted.map(v => v.arrivedAt as unknown as Stamp));
      expect(calls.stamp).toBe(2);
    });

    test('a RETURNING of one collection under two keys: each key a memo of its own, as in a SELECT', async () => {
      const returned = await db.docks.where(d => gt(d.id, 0)).update({ name: sql<string>`"name"` } as any).returning(d => {
        const arrivals = d.vessels!.orderBy(v => v.name).select(v => ({ at: v.arrivedAt })).toList();

        return { id: d.id, a: arrivals, b: arrivals };
      });
      const a = returned.flatMap(r => r.a.map(item => item.at));
      const b = returned.flatMap(r => r.b.map(item => item.at));

      expect(a).toHaveLength(VESSELS.length);
      expectShared(a);
      expectShared(b);
      a.forEach((value, i) => {
        expect(b[i]).not.toBe(value);
        expect(b[i]).toEqual(value);
      });
      // Two memos of 3 distinct moments each
      expect(calls.stamp).toBe(6);
    });
  });

  describe('giving up', () => {
    const MANY = SHARED_VALUES_PROBE + 72;
    const moment = (i: number): string => `2027-01-01 00:${pad(Math.floor(i / 60))}:${pad(i % 60)}`;
    const reads = () => db.cargo.where(c => eq(c.vesselId, vesselIds.Hal)).select(c => ({ label: c.label, at: c.loadedAt })).orderBy(c => c.label);

    // Each test reads Hal's cargo alone: the rows it inserted itself
    beforeEach(async () => {
      await db.cargo.where(c => eq(c.vesselId, vesselIds.Hal)).delete();
    });

    afterAll(async () => {
      await db.cargo.where(c => eq(c.vesselId, vesselIds.Hal)).delete();
    });

    test('a column whose first values are all distinct stops sharing: a far repeat maps on its own', async () => {
      const rows = Array.from({ length: MANY }, (_, i) => ({ vesselId: vesselIds.Hal, label: `m${String(i).padStart(4, '0')}`, loadedAt: new Stamp(moment(i)) }));

      // The first and the last value repeat — MANY distinct values apart, whichever end a read starts from
      rows.push({ vesselId: vesselIds.Hal, label: `m${String(MANY).padStart(4, '0')}`, loadedAt: new Stamp(moment(0)) });
      await db.cargo.insertBulk(rows as any);

      resetCalls();
      const read = await reads().toList();

      // The window of MANY + 1 values is shorter than the distance between the repeats
      expect(probeWindow(MANY + 1)).toBeLessThan(MANY);
      expect(read).toHaveLength(MANY + 1);
      expect(read[MANY].at).toEqual(read[0].at);
      expect(read[MANY].at).not.toBe(read[0].at);
      expect(calls.stamp).toBe(MANY + 1);

      await db.cargo.where(c => eq(c.vesselId, vesselIds.Hal)).delete();
    });

    test('a column repeating only every 200 rows shares once each value repeats — a plain select and a collection alike', async () => {
      // 4 cycles of 200 distinct moments: 800 values, a window of 400 (a fixed 128-value probe gave up on it)
      const cycled = Array.from({ length: 800 }, (_, i) => ({ vesselId: vesselIds.Hal, label: `p${String(i).padStart(4, '0')}`, loadedAt: new Stamp(moment(i % 200)) }));

      await db.cargo.insertBulk(cycled as any);

      resetCalls();
      const read = await reads().toList();

      expect(probeWindow(800)).toBeGreaterThanOrEqual(200);
      expect(read).toHaveLength(800);
      expect(read[0].at).toBe(read[200].at);
      expect(read[199].at).toBe(read[799].at);
      expect(read[0].at).not.toBe(read[1].at);
      expect(calls.stamp).toBe(200);

      resetCalls();
      const nested = await db.vessels.where(v => eq(v.id, vesselIds.Hal))
        .select(v => ({ cargo: v.cargo!.orderBy(c => c.label).select(c => ({ label: c.label, at: c.loadedAt })).toList() }))
        .toList();
      const items = nested[0].cargo;

      expect(items).toHaveLength(800);
      expect(items[0].at).toBe(items[200].at);
      expect(items[199].at).toBe(items[799].at);
      expect(calls.stamp).toBe(200);

      await db.cargo.where(c => eq(c.vesselId, vesselIds.Hal)).delete();
    });

    test('a column that repeats early keeps sharing past them', async () => {
      const rows = Array.from({ length: MANY }, (_, i) => ({ vesselId: vesselIds.Hal, label: `m${String(i + 1).padStart(4, '0')}`, loadedAt: new Stamp(moment(i)) }));

      // A repeat at both ends — the read meets one early, whichever end it starts from
      rows.unshift({ vesselId: vesselIds.Hal, label: 'm0000', loadedAt: new Stamp(moment(0)) });
      rows.push({ vesselId: vesselIds.Hal, label: 'm9998', loadedAt: new Stamp(moment(MANY - 1)) });
      rows.push({ vesselId: vesselIds.Hal, label: 'm9999', loadedAt: new Stamp(moment(0)) });
      await db.cargo.insertBulk(rows as any);

      resetCalls();
      const read = await reads().toList();
      const first = read[0].at;

      expect(read).toHaveLength(MANY + 3);
      expect(read[1].at).toBe(first);
      expect(read[MANY + 2].at).toBe(first);
      expect(read[MANY + 1].at).toBe(read[MANY].at);
      expect(calls.stamp).toBe(MANY);
    });
  });
});
