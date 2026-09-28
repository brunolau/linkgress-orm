/**
 * A PostgreSQL value's TEXT form, parsed the way a driver parses a result column of its type — what a
 * QueryBatch turns the texts it sends back with (`DatabaseClient.parseTypedText`), so a batched value is
 * the one the same client delivers for the same query on its own.
 * @internal
 */

/** PostgreSQL's FirstNormalObjectId: every user-defined type (a domain, an enum, a composite, an extension's) has an OID at least this. */
export const FIRST_USER_TYPE_OID = 16384;

/**
 * The types whose values a QueryBatch sends as their text: their JSON form is not what the drivers
 * deliver — date / time / timetz / timestamp / timestamptz / interval, int8, numeric, money, bytea, the
 * geometric point / circle (node-postgres parses them) — and their arrays. A value of a user-defined type,
 * and of any type the client parses with a parser of its own, travels as its text too.
 */
export const TEXT_TRANSPORT_TYPE_OIDS: readonly number[] = [
  1082, 1083, 1266, 1114, 1184, 1186, 20, 1700, 790, 17, 600, 718,
  1182, 1183, 1270, 1115, 1185, 1187, 1016, 1231, 791, 1001, 1017, 719,
];

/**
 * The element type of each array type the built-in parsers read element by element (an array of any other
 * type: its text, as Bun reads a `uuid[]`).
 */
const ARRAY_ELEMENT_TYPE: Readonly<Record<number, number>> = {
  1182: 1082, 1183: 1083, 1270: 1266, 1115: 1114, 1185: 1184, 1187: 1186,
  1016: 20, 1231: 1700, 791: 790, 1001: 17, 1017: 600, 719: 718,
  1000: 16, 1005: 21, 1007: 23, 1028: 26, 1021: 700, 1022: 701, 199: 114, 3807: 3802, 1009: 25, 1015: 1043, 1014: 1042,
};

/** The array type of each builtin element type an application may parse with a parser of its own. */
const ARRAY_TYPE_OF: Readonly<Record<number, number>> = {
  16: 1000, 21: 1005, 23: 1007, 26: 1028, 700: 1021, 701: 1022, 114: 199, 3802: 3807, 25: 1009, 1043: 1015, 1042: 1014,
  18: 1002, 19: 1003, 142: 143, 2950: 2951, 650: 651, 869: 1041, 829: 1040,
  1082: 1182, 1083: 1183, 1266: 1270, 1114: 1115, 1184: 1185, 1186: 1187, 20: 1016, 1700: 1231, 790: 791, 17: 1001,
  600: 1017, 718: 719,
};

/**
 * Whether a QueryBatch hands the client the text it sent of a value whose (base) type is `oid`: a type of
 * `textTypeOids` (TEXT_TRANSPORT_TYPE_OIDS and those the client parses itself) or a user-defined one. A
 * value of a domain over a type JSON carries as the drivers deliver it (integer, boolean, …) keeps its JSON
 * form, which is that value.
 */
export function isTextParsedType(oid: number, textTypeOids: ReadonlySet<number>): boolean {
  return textTypeOids.has(oid) || oid >= FIRST_USER_TYPE_OID;
}

/** `oids` with the array type of each builtin one among them (a driver derives an array's parser from its element's). */
export function withArrayTypes(oids: readonly number[]): number[] {
  const all = new Set(oids);

  for (const oid of oids) {
    const array = ARRAY_TYPE_OF[oid];

    if (array !== undefined) {
      all.add(array);
    }
  }

  return [...all];
}

/** The OID of each builtin type whose JSON form IS what the drivers deliver, by name (see needsClientParse). */
const JSON_SAFE_TYPE_OIDS: Readonly<Record<string, number>> = {
  'boolean': 16, 'bool': 16,
  'smallint': 21, 'int2': 21, 'smallserial': 21, 'serial2': 21,
  'integer': 23, 'int': 23, 'int4': 23, 'serial': 23, 'serial4': 23,
  'oid': 26,
  'real': 700, 'float4': 700,
  'double precision': 701, 'float8': 701,
  'text': 25, 'varchar': 1043, 'character varying': 1043, 'char': 1042, 'character': 1042, 'bpchar': 1042, 'name': 19,
  'uuid': 2950, 'json': 114, 'jsonb': 3802,
};

/**
 * Whether a value DECLARED of the SQL type `sqlType` has to travel through a QueryBatch as its text so the
 * client parses it: every type but the builtins JSON carries as the drivers deliver them (integer, text,
 * boolean, uuid, json, …) — and those too when the client parses them with a parser of its own
 * (`customOids`). An unknown type name (a domain, an enum, an extension's type) needs it: only its
 * runtime type can tell.
 */
export function needsClientParse(sqlType: unknown, customOids: readonly number[]): boolean {
  if (typeof sqlType !== 'string') {
    return true;
  }

  const name = sqlType.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const oid = JSON_SAFE_TYPE_OIDS[name];

  return oid === undefined || customOids.includes(oid);
}

/** The text of one array element with its backslash escapes resolved (a quoted element's content). */
function unescapeArrayElement(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/**
 * A PostgreSQL array literal (`{1,"a b",NULL,{2,3}}`, a dimension prefix `[1:2]=` skipped) as a JS array,
 * each element through `parseElement` (NULL as null).
 */
export function parsePgArrayText(text: string, parseElement: (element: string) => unknown): unknown[] {
  let at = text.indexOf('{');

  const parseLevel = (): unknown[] => {
    const values: unknown[] = [];
    at++;

    if (text[at] === '}') {
      at++;

      return values;
    }

    while (at < text.length) {
      if (text[at] === '{') {
        values.push(parseLevel());
      } else if (text[at] === '"') {
        let end = at + 1;

        while (end < text.length && text[end] !== '"') {
          end += text[end] === '\\' ? 2 : 1;
        }

        values.push(parseElement(unescapeArrayElement(text.slice(at + 1, end))));
        at = end + 1;
      } else {
        let end = at;

        while (end < text.length && text[end] !== ',' && text[end] !== '}') {
          end++;
        }

        const token = text.slice(at, end).trim();
        values.push(token.toUpperCase() === 'NULL' ? null : parseElement(token));
        at = end;
      }

      if (text[at] === ',') {
        at++;
      } else {
        at++;

        return values;
      }
    }

    return values;
  };

  return at < 0 ? [] : parseLevel();
}

const TIMESTAMP_TEXT = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( BC)?$/;
const DATE_TEXT = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/;

/** The year of a timestamp's / date's text, BC counted as JS counts it (1 BC is year 0). */
const yearOf = (year: string, bc: string | undefined): number => (bc ? 1 - Number(year) : Number(year));

/** Milliseconds of a fraction's digits (`.123456` → 123). */
const millisOf = (fraction: string | undefined): number => (fraction ? Math.floor(Number(fraction) * 1000) : 0);

/** `infinity` / `-infinity` — a date's or a timestamp's text — as ±Infinity, as the drivers deliver them. */
const infinityOf = (text: string): number | undefined => {
  if (text === 'infinity') {
    return Infinity;
  }

  return text === '-infinity' ? -Infinity : undefined;
};

/**
 * A date's text as a Date — at local midnight (`parsing.dateAsUtc`: at UTC midnight); a date before
 * Christ as an invalid Date where `parsing.bcDateInvalid` says so — ±infinity as ±Infinity, any other
 * text as it is.
 */
function parseDateText(text: string, parsing: BuiltInParsing): unknown {
  const infinite = infinityOf(text);

  if (infinite !== undefined) {
    return infinite;
  }

  const match = DATE_TEXT.exec(text);

  if (!match) {
    return text;
  }

  const [, year, month, day, bc] = match;

  if (bc && parsing.bcDateInvalid) {
    return new Date(NaN);
  }

  const utc = parsing.dateAsUtc;
  const date = utc ? new Date(0) : new Date(0, 0, 1);

  if (utc) {
    date.setUTCFullYear(yearOf(year, bc), Number(month) - 1, Number(day));
  } else {
    date.setFullYear(yearOf(year, bc), Number(month) - 1, Number(day));
  }

  return date;
}

/**
 * A timestamp's / timestamptz's text as a Date: a zone offset makes it an instant; without one it is a
 * wall-clock time — local (`utcWallTime`: read as UTC) — its fraction truncated to milliseconds; one
 * before Christ an invalid Date where `parsing.bcTimestampInvalid` says so. ±infinity as ±Infinity, any
 * other text as it is.
 */
function parseTimestampText(text: string, utcWallTime: boolean, parsing: BuiltInParsing): unknown {
  const infinite = infinityOf(text);

  if (infinite !== undefined) {
    return infinite;
  }

  const match = TIMESTAMP_TEXT.exec(text);

  if (!match) {
    return text;
  }

  const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes, offsetSeconds, bc] = match;

  if (bc && parsing.bcTimestampInvalid) {
    return new Date(NaN);
  }

  const parts = [Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millisOf(fraction)] as const;

  if (sign !== undefined || utcWallTime) {
    const date = new Date(0);
    date.setUTCFullYear(yearOf(year, bc), parts[0], parts[1]);
    date.setUTCHours(parts[2], parts[3], parts[4], parts[5]);

    if (sign !== undefined) {
      const offset = (Number(offsetHours) * 3600 + Number(offsetMinutes ?? 0) * 60 + Number(offsetSeconds ?? 0)) * 1000;
      date.setTime(date.getTime() - (sign === '-' ? -offset : offset));
    }

    return date;
  }

  const date = new Date(0, 0, 1);
  date.setFullYear(yearOf(year, bc), parts[0], parts[1]);
  date.setHours(parts[2], parts[3], parts[4], parts[5]);

  return date;
}

/** A bytea's hex text (`\x01ff`) as a Buffer (a Uint8Array where there is no Buffer); any other text as it is. */
function parseByteaText(text: string): unknown {
  if (!text.startsWith('\\x')) {
    return text;
  }

  const hex = text.slice(2);
  const bufferCtor = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;

  return bufferCtor
    ? bufferCtor.from(hex, 'hex')
    : Uint8Array.from(hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
}

/** How the built-in parsers read a date and a timestamp. */
export interface BuiltInParsing {
  /** A date as UTC midnight (Bun, postgres.js); else local midnight (node-postgres). */
  readonly dateAsUtc: boolean;
  /** A timestamp without a zone as a UTC wall time (Bun); else a local one (node-postgres, postgres.js). */
  readonly timestampAsUtc: boolean;
  /** A date before Christ as an invalid Date (Bun); else that date (node-postgres). */
  readonly bcDateInvalid?: boolean;
  /** A timestamp before Christ as an invalid Date (Bun, decoding a text result); else that time. */
  readonly bcTimestampInvalid?: boolean;
  /** An int8 as a BigInt (Bun's `bigint: true`); else as its text. */
  readonly int8AsBigInt?: boolean;
}

/**
 * A value's text parsed by the built-in rules — a boolean, an int2 / int4 / oid, a float4 / float8 as a
 * number, a json / jsonb document parsed, a date, a timestamp, a timestamptz as a Date (±infinity as
 * ±Infinity), bytea as a Buffer, an array of these or of a text type element by element (`parsing` says how
 * a date and a zone-less timestamp read, a value before Christ, an int8); every other type as its text.
 */
export function parseBuiltInTypedText(oid: number, text: string, parsing: BuiltInParsing): unknown {
  switch (oid) {
    case 16:
      return text === 't' || text === 'true';
    case 21:
    case 23:
    case 26:
      return Number.parseInt(text, 10);
    case 700:
    case 701:
      return Number.parseFloat(text);
    case 114:
    case 3802:
      return JSON.parse(text);
    case 20:
      return parsing.int8AsBigInt ? BigInt(text) : text;
    case 1082:
      return parseDateText(text, parsing);
    case 1114:
      return parseTimestampText(text, parsing.timestampAsUtc, parsing);
    case 1184:
      return parseTimestampText(text, false, parsing);
    case 17:
      return parseByteaText(text);
    default: {
      const element = ARRAY_ELEMENT_TYPE[oid];

      return element === undefined ? text : parsePgArrayText(text, (item) => parseBuiltInTypedText(element, item, parsing));
    }
  }
}
