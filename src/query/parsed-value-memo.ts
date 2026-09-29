/** A Date the memo hands out a copy of, for every row: its time. */
class MemoDate {
  constructor(readonly time: number) {}
}

/** `undefined` as the memo holds it (a Map's `get` answers `undefined` for a text it does not hold). */
const UNDEFINED = Symbol('undefined');

/**
 * How the memo holds a parsed value (see ParsedValueMemo): a primitive as it is, a plain Date as its time —
 * `NOT_REUSABLE` for any other value.
 */
const NOT_REUSABLE = Symbol('notReusable');

/** Date.prototype.getTime as the module found it: a Date's time — it throws for anything but a Date. */
const dateTimeOf = Date.prototype.getTime;

/** The time of `value` when it is a Date (it has a Date's internal time value), else `undefined`. */
function timeOfDate(value: object): number | undefined {
  try {
    return Reflect.apply(dateTimeOf, value, []) as number;
  } catch {
    // Not a Date: a Proxy of one, an object made from Date.prototype, any other object
    return undefined;
  }
}

function heldValue(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return value;
    case 'undefined':
      return UNDEFINED;
    case 'object': {
      if (value === null) {
        return null;
      }

      // A Date first — asking a Proxy for its prototype, extensibility or keys would run its traps — then one a
      // copy reproduces: a plain one (one the parser froze, sealed or gave properties of its own is not)
      const time = timeOfDate(value);

      return time !== undefined && Object.getPrototypeOf(value) === Date.prototype && Object.isExtensible(value) && Reflect.ownKeys(value).length === 0
        ? new MemoDate(time)
        : NOT_REUSABLE;
    }
    default:
      return NOT_REUSABLE;
  }
}

/**
 * The values ONE column of ONE result set parses its texts into, by text: a column often repeats a value
 * (a day, a status' timestamp), and its parser then runs once per distinct text — every row still gets a
 * value of its own. A result is reused only where that cannot be told from parsing the text again:
 * - a primitive (a string, a number — ±Infinity and NaN included —, a boolean, a bigint, null, undefined):
 *   the same value;
 * - a plain Date (its prototype `Date.prototype`, extensible, no own property), an invalid one included: a
 *   copy of it, for every row — no two rows share a Date;
 * - any other value (a Buffer, an interval object, a Date subclass, a frozen Date or one with a property of
 *   its own, a custom parser's object, a symbol): the column's memo stops, and its parser runs for every
 *   row, as without a memo.
 *
 * The memo also stops when repeats are rare — after GIVE_UP_AFTER texts with fewer than a quarter repeats —
 * and holds at most MAX_TEXTS texts. It lives for one result set: a text one statement parsed is never
 * reused for another.
 * @internal
 */
export class ParsedValueMemo {
  /** The texts after which a memo that found fewer than a quarter of them repeated stops. */
  static readonly GIVE_UP_AFTER = 64;
  /** The most texts one memo holds. */
  static readonly MAX_TEXTS = 4096;

  private readonly values = new Map<string, unknown>();
  private lookups = 0;
  private hits = 0;
  private active = true;

  /** `parse`: the column's parser; `source`, when given, makes the text the parser gets from the one read (a JSON form). */
  constructor(private readonly parse: (text: string) => unknown, private readonly source?: (key: string) => string) {}

  /** The value `key` parses into (`source(key)`, when the memo has a source). */
  read(key: string): unknown {
    if (!this.active) {
      return this.parse(this.source ? this.source(key) : key);
    }

    this.lookups++;
    const held = this.values.get(key);

    if (held !== undefined) {
      this.hits++;

      if (held instanceof MemoDate) {
        return new Date(held.time);
      }

      return held === UNDEFINED ? undefined : held;
    }

    const value = this.parse(this.source ? this.source(key) : key);
    const kept = heldValue(value);

    if (kept === NOT_REUSABLE || (this.lookups >= ParsedValueMemo.GIVE_UP_AFTER && this.hits * 4 < this.lookups)) {
      this.active = false;
      this.values.clear();
    } else if (this.values.size < ParsedValueMemo.MAX_TEXTS) {
      this.values.set(key, kept);
    }

    return value;
  }
}
