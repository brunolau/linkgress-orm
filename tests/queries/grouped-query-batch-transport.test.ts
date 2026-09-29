import { describe, expect, test } from 'bun:test';
import {
  isTextParsedType, JSON_TEXT_TYPE_OIDS, needsClientParse, parseBuiltInTypedText, parsePgArrayText, TEXT_TRANSPORT_TYPE_OIDS, textOfJsonForm, withArrayTypes,
} from '../../src/database/typed-text';
import { applyBatchOverrides, canonicalJsonColumnType, flatRowBatchMeta, jsonColumnDelivery } from '../../src/query/future-query';

/** A date column's value as node-postgres reads it: local midnight of that day. */
const localDay = (text: string): Date => {
  const [year, month, dayOfMonth] = text.split('-').map(Number);

  return new Date(year, month - 1, dayOfMonth);
};

/** A timestamp-without-time-zone value as node-postgres reads it: that wall-clock time, local. */
const localTime = (text: string): Date => new Date(text.replace(' ', 'T'));

/** A client that parses a text as `<oid>:<text>` and records every call (with whether the read was parameterised). */
const recordingClient = () => {
  const calls: Array<[number, string, boolean | undefined]> = [];

  return {
    calls,
    parseTypedText: (oid: number, text: string, read?: { parameterized?: boolean }): unknown => {
      calls.push([oid, text, read?.parameterized]);

      return `${oid}:${text}`;
    },
  };
};

/** The types a batch sends as their text for a client without parsers of its own. */
const TEXT_TYPES: ReadonlySet<number> = new Set(TEXT_TRANSPORT_TYPE_OIDS);

const NODE_POSTGRES = { dateAsUtc: false, timestampAsUtc: false };
const BUN = { dateAsUtc: true, timestampAsUtc: true };

/**
 * The QueryBatch transport of a row, on rows shaped as the batch envelope delivers them: the texts a
 * branch sends parsed in by the client, by the type the branch sends once per value; a flat row's
 * metadata; a plain select's declared-column revivals (1.0.10's, unchanged); and the text parsing a client
 * without parsers of its own falls back to.
 */
describe('the QueryBatch transport of a row', () => {
  test('type names — declared, as pg_typeof prints them, aliased, with modifiers — map to the types a batch knows', () => {
    expect(['timestamp', 'timestamp without time zone', 'timestamp(3) without time zone', 'TIMESTAMP'].map(canonicalJsonColumnType))
      .toEqual(['timestamp', 'timestamp', 'timestamp', 'timestamp']);
    expect(['timestamptz', 'timestamp with time zone', 'timestamp(6) with time zone'].map(canonicalJsonColumnType))
      .toEqual(['timestamptz', 'timestamptz', 'timestamptz']);
    expect(['bigint', 'int8', 'bigserial', 'serial8'].map(canonicalJsonColumnType)).toEqual(['bigint', 'bigint', 'bigint', 'bigint']);
    expect(['numeric', 'decimal', 'numeric(10,2)', 'numeric(10, 2)'].map(canonicalJsonColumnType)).toEqual(['numeric', 'numeric', 'numeric', 'numeric']);
    expect(['date', 'bytea'].map(canonicalJsonColumnType)).toEqual(['date', 'bytea']);
    // Types JSON carries as the drivers deliver them, arrays, and no type at all
    expect(['integer', 'text', 'character varying', 'boolean', 'jsonb', 'double precision', 'date[]', 'bigint[]', 'interval', undefined, 42]
      .map(canonicalJsonColumnType)).toEqual(new Array(11).fill(undefined));
  });

  test('each text a branch sent is parsed by the client, by the type the branch sent once for it; a row keeps its key order', () => {
    const meta = { textColumns: ['weight'], runtimeTypedColumns: ['day', 'label'] };
    const client = recordingClient();
    const rows = [
      { day: '2024-03-04', n: 2, weight: 12, label: 'calm' },
      { day: null, n: 3, weight: 9007199254740992, label: 'fog' },
    ];

    // In the envelope's order: the text columns, then the runtime-typed ones — NULL where a value needs no
    // text (label's type needs none); the empty text of a NULL value
    const merged = applyBatchOverrides(rows, [['12', '2024-03-04', null], ['9007199254740993', '', null]], meta, [20, 1082, 25], client, TEXT_TYPES, { parameterized: true });

    expect(merged).toEqual([
      { day: '1082:2024-03-04', n: 2, weight: '20:12', label: 'calm' },
      { day: null, n: 3, weight: '20:9007199254740993', label: 'fog' },
    ]);
    expect(merged.map(row => Object.keys(row))).toEqual([['day', 'n', 'weight', 'label'], ['day', 'n', 'weight', 'label']]);
    expect(client.calls).toEqual([[20, '12', true], [1082, '2024-03-04', true], [20, '9007199254740993', true]]);
  });

  test('no texts (no value of the branch needed one), a row without texts, a branch of no rows (NULL types): the rows as they came', () => {
    const meta = { runtimeTypedColumns: ['day'] };
    const client = recordingClient();

    // An int8 and a numeric: their JSON form gives no text back — nothing to parse without the server's
    expect(applyBatchOverrides([{ big: 12, exact: 1.5 }], undefined, { runtimeTypedColumns: ['big', 'exact'] }, [20, 1700], client, TEXT_TYPES))
      .toEqual([{ big: 12, exact: 1.5 }]);
    expect(applyBatchOverrides([{ day: '2024-03-04' }], [null], meta, [1082], client, TEXT_TYPES)).toEqual([{ day: '2024-03-04' }]);
    expect(applyBatchOverrides([], [], meta, [null], client, TEXT_TYPES)).toEqual([]);
    expect(applyBatchOverrides([], undefined, meta, [null], client, TEXT_TYPES)).toEqual([]);
    // Over no rows `min(pg_typeof(…))` is NULL: a text (there is none) would stay as it is
    expect(applyBatchOverrides([{ day: '2024-03-04' }], [['2024-03-04']], meta, [null], client, TEXT_TYPES)).toEqual([{ day: '2024-03-04' }]);
    // A plain branch has no types at all
    expect(applyBatchOverrides([{ day: '2024-03-04' }], undefined, meta, undefined, client, TEXT_TYPES)).toEqual([{ day: '2024-03-04' }]);
    expect(client.calls).toEqual([]);
  });

  test('a value whose JSON form gives its text back — the server sent none — is parsed from the text that form rebuilds; a text the server sent wins', () => {
    const columns = ['day', 'at', 'stamp', 'time', 'timetz', 'span', 'money', 'raw', 'point', 'circle'];
    const meta = { runtimeTypedColumns: columns };
    const oids = [1082, 1114, 1184, 1083, 1266, 1186, 790, 17, 600, 718];
    // As row_to_json writes them (the ISO form of a date / timestamp, every other type's output text)
    const json = {
      day: '0044-03-15 BC', at: '2024-03-01T06:00:00.123', stamp: '2024-03-01T06:00:00.5+01:00', time: '06:00:00.123',
      timetz: '06:00:00+05:30', span: '1 day 01:30:00', money: '$12.50', raw: '\\x00ff', point: '(1.5,2)', circle: '<(1,2),3>',
    };
    const client = recordingClient();

    // No texts at all (no value of the branch needed the server's), and texts whose values the server sent none of
    for (const texts of [undefined, [new Array(columns.length).fill(null)]]) {
      client.calls.length = 0;
      const [row] = applyBatchOverrides([{ ...json, id: 7 }], texts, meta, oids, client, TEXT_TYPES, { parameterized: true });

      expect(row).toEqual({
        day: '1082:0044-03-15 BC', at: '1114:2024-03-01 06:00:00.123', stamp: '1184:2024-03-01 06:00:00.5+01', time: '1083:06:00:00.123',
        timetz: '1266:06:00:00+05:30', span: '1186:1 day 01:30:00', money: '790:$12.50', raw: '17:\\x00ff', point: '600:(1.5,2)', circle: '718:<(1,2),3>',
        id: 7,
      });
      expect(Object.keys(row)).toEqual([...columns, 'id']);
      expect(client.calls.every(([, , parameterized]) => parameterized === true)).toBe(true);
    }

    // Under a DateStyle other than ISO the server sends a date's / timestamp's text: that text, not the JSON form's
    const sent = applyBatchOverrides([{ day: '2024-03-04', at: '2024-03-01T06:00:00', n: 1 }], [['03/04/2024', '03/01/2024 06:00:00']],
      { runtimeTypedColumns: ['day', 'at'] }, [1082, 1114], client, TEXT_TYPES);
    expect(sent).toEqual([{ day: '1082:03/04/2024', at: '1114:03/01/2024 06:00:00', n: 1 }]);

    // NULL stays NULL, unparsed; a type the client does not parse keeps its JSON value
    client.calls.length = 0;
    expect(applyBatchOverrides([{ day: null, at: undefined, note: 'calm' }], undefined, { runtimeTypedColumns: ['day', 'at', 'note'] }, [1082, 1114, 25], client, TEXT_TYPES))
      .toEqual([{ day: null, at: undefined, note: 'calm' }]);
    expect(client.calls).toEqual([]);
  });

  test('for a client that parses json itself nothing is rebuilt from the row: only the texts the server sent are parsed', () => {
    const client = recordingClient();
    const meta = { runtimeTypedColumns: ['at', 'day'] };
    // Its json parser made the first row's timestamp a Date already: the server sent its text, which wins
    const revived = new Date(Date.UTC(2024, 2, 1, 6));
    const rows = [{ at: revived, day: '2024-03-01' }, { at: '2024-03-02T07:00:00', day: '2024-03-02' }];
    const merged = applyBatchOverrides(rows, [['2024-03-01 06:00:00', '2024-03-01'], [null, null]], meta, [1114, 1082], client, TEXT_TYPES, undefined, false);

    expect(merged).toEqual([{ at: '1114:2024-03-01 06:00:00', day: '1082:2024-03-01' }, { at: '2024-03-02T07:00:00', day: '2024-03-02' }]);
    // No texts at all: the rows as they came
    expect(applyBatchOverrides([{ at: '2024-03-02T07:00:00' }], undefined, { runtimeTypedColumns: ['at'] }, [1114], client, TEXT_TYPES, undefined, false))
      .toEqual([{ at: '2024-03-02T07:00:00' }]);
    expect(client.calls).toEqual([[1114, '2024-03-01 06:00:00', undefined], [1082, '2024-03-01', undefined]]);
  });

  test('a value repeated on consecutive rows is parsed for every row — each row gets a value of its own', () => {
    const parsed: string[] = [];
    const client = {
      parseTypedText: (oid: number, text: string): unknown => {
        parsed.push(text);

        return { oid, text };
      },
    };
    const rows = ['2024-03-01T00:00:00', '2024-03-01T00:00:00', '2024-03-02T00:00:00', '2024-03-01T00:00:00'].map(day => ({ day }));
    const merged = applyBatchOverrides(rows, undefined, { runtimeTypedColumns: ['day'] }, [1114], client, TEXT_TYPES);

    expect(parsed).toEqual(['2024-03-01 00:00:00', '2024-03-01 00:00:00', '2024-03-02 00:00:00', '2024-03-01 00:00:00']);
    expect(merged.map(row => row.day)).toEqual(parsed.map(text => ({ oid: 1114, text })));
    expect(merged[0].day).not.toBe(merged[1].day);
  });

  test('a client\'s parser for one type is resolved once per branch, then called per value — exactly as parseTypedText would be', () => {
    const resolved: Array<[number, boolean | undefined]> = [];
    const client = {
      ...recordingClient(),
      typedTextParser: (oid: number, read?: { parameterized?: boolean }) => {
        resolved.push([oid, read?.parameterized]);

        return (text: string) => `${oid}~${text}`;
      },
    };
    const rows = [{ at: '2024-03-01T06:00:00', big: 1 }, { at: '2024-03-02T07:00:00', big: 2 }, { at: null, big: 3 }];

    expect(applyBatchOverrides(rows, [[null, '1'], [null, '2'], [null, '3']], { runtimeTypedColumns: ['at', 'big'] }, [1114, 20], client, TEXT_TYPES, { parameterized: false }))
      .toEqual([{ at: '1114~2024-03-01 06:00:00', big: '20~1' }, { at: '1114~2024-03-02 07:00:00', big: '20~2' }, { at: null, big: '20~3' }]);
    expect(resolved).toEqual([[1114, false], [20, false]]);
    expect(client.calls).toEqual([]);
  });

  test('the text of a date / time / timestamp / interval, money, bytea, point or circle from its JSON form', () => {
    // A timestamp's T; a timestamptz's whole-hour offset (not a half-hour one, not one with seconds), before BC too
    expect(textOfJsonForm(1114, '2024-03-01T06:00:00')).toBe('2024-03-01 06:00:00');
    expect(textOfJsonForm(1114, '0044-03-15T06:00:00.5 BC')).toBe('0044-03-15 06:00:00.5 BC');
    expect(textOfJsonForm(1114, '12024-01-01T00:00:00')).toBe('12024-01-01 00:00:00');
    expect(textOfJsonForm(1184, '2024-03-01T06:00:00+01:00')).toBe('2024-03-01 06:00:00+01');
    expect(textOfJsonForm(1184, '2024-03-01T06:00:00.123456-03:00')).toBe('2024-03-01 06:00:00.123456-03');
    expect(textOfJsonForm(1184, '2024-03-01T06:00:00+05:30')).toBe('2024-03-01 06:00:00+05:30');
    expect(textOfJsonForm(1184, '1900-01-01T00:00:00+00:19:32')).toBe('1900-01-01 00:00:00+00:19:32');
    expect(textOfJsonForm(1184, '0044-03-15T07:16:20+01:16:20 BC')).toBe('0044-03-15 07:16:20+01:16:20 BC');
    expect(textOfJsonForm(1184, '0044-03-15T06:00:00+00:00 BC')).toBe('0044-03-15 06:00:00+00 BC');
    // ±infinity, a date, and every other type: the JSON form is the text
    expect(['infinity', '-infinity'].map(text => [textOfJsonForm(1114, text), textOfJsonForm(1184, text), textOfJsonForm(1082, text)]))
      .toEqual([['infinity', 'infinity', 'infinity'], ['-infinity', '-infinity', '-infinity']]);
    expect([[1082, '0044-03-15 BC'], [1083, '06:00:00'], [1266, '06:00:00+05:30'], [1186, '1 day'], [790, '$12.50'], [17, '\\x01'], [600, '(1,2)'], [718, '<(1,2),3>']]
      .map(([oid, text]) => textOfJsonForm(oid as number, text as string))).toEqual(['0044-03-15 BC', '06:00:00', '06:00:00+05:30', '1 day', '$12.50', '\\x01', '(1,2)', '<(1,2),3>']);
    // They are text-sent types; an int8, a numeric and every array are not rebuilt
    expect([...JSON_TEXT_TYPE_OIDS].every(oid => TEXT_TRANSPORT_TYPE_OIDS.includes(oid))).toBe(true);
    expect([20, 1700, 1182, 1115, 1185, 1016, 1231, 1001].some(oid => JSON_TEXT_TYPE_OIDS.has(oid))).toBe(false);
  });

  test('a value of a domain over a type JSON carries keeps its JSON value; one of a user-defined type, or of a type the client parses itself, is parsed', () => {
    const meta = { runtimeTypedColumns: ['score', 'flag', 'mood', 'point', 'rank'] };
    const client = recordingClient();
    // A domain over int4 and one over boolean (their base types sent), an enum and a composite (their own
    // OIDs), and an int4 the client parses with a parser of its own (23 among its text types)
    const row = { score: 7, flag: true, mood: 'calm', point: { x: 1, y: null }, rank: 3 };
    const texts = [['7', 't', 'calm', '(1,)', '3']];

    expect(applyBatchOverrides([{ ...row }], texts, meta, [23, 16, 16500, 16501, 23], client, TEXT_TYPES)[0])
      .toEqual({ score: 7, flag: true, mood: '16500:calm', point: '16501:(1,)', rank: 3 });
    expect(applyBatchOverrides([{ ...row }], texts, meta, [23, 16, 16500, 16501, 23], client, new Set([...TEXT_TYPES, 23]))[0])
      .toEqual({ score: '23:7', flag: true, mood: '16500:calm', point: '16501:(1,)', rank: '23:3' });
    expect([isTextParsedType(23, TEXT_TYPES), isTextParsedType(1082, TEXT_TYPES), isTextParsedType(16384, TEXT_TYPES)]).toEqual([false, true, true]);
  });

  test('a flat row\'s metadata lists its runtime-typed fields in projection order; a row with none has no metadata to apply', () => {
    const meta = flatRowBatchMeta([
      ['zeta', { kind: 'runtime' }],
      ['n', undefined],
      ['alpha', { kind: 'runtime' }],
    ]);

    expect(meta).toEqual({ hasNestedPaths: false, runtimeTypedColumns: ['zeta', 'alpha'] });
    expect(flatRowBatchMeta([['n', undefined], ['name', undefined]])).toEqual({ hasNestedPaths: false, runtimeTypedColumns: undefined });
  });

  test('a plain select\'s declared date / timestamp / timestamptz / bytea column: revived from its JSON form as in 1.0.10', () => {
    expect(jsonColumnDelivery('timestamp', false)!.revive('2024-03-01T09:15:00')).toEqual(localTime('2024-03-01 09:15:00'));
    expect((jsonColumnDelivery('timestamptz', false)!.revive('2024-03-05T11:00:00+01:00') as Date).toISOString()).toBe('2024-03-05T10:00:00.000Z');
    expect(jsonColumnDelivery('date', false)!.revive('2024-03-18')).toEqual(localDay('2024-03-18'));
    expect(Array.from(jsonColumnDelivery('bytea', false)!.revive('\\x01ff') as Uint8Array)).toEqual([1, 255]);
    // A custom mapper gets the driver's text form
    expect(jsonColumnDelivery('timestamp', true)!.revive('2024-03-01T09:15:00')).toBe('2024-03-01 09:15:00');
    expect(jsonColumnDelivery('timestamptz', true)!.revive('2024-03-05T11:00:00+01:00')).toBe('2024-03-05 11:00:00+01');
    expect(jsonColumnDelivery('date', true)).toBeUndefined();
    // Every other type has no JSON revival: an int8 / numeric travels as its text
    expect(['bigint', 'numeric', 'integer', 'text', undefined].map(type => jsonColumnDelivery(type, false))).toEqual(new Array(5).fill(undefined));
  });
});

describe('a PostgreSQL value\'s text, parsed as a driver parses its column', () => {
  test('an array literal: quoted and escaped elements, NULL, nesting, a dimension prefix, an empty array', () => {
    const asIs = (element: string) => element;

    expect(parsePgArrayText('{1,2,3}', Number)).toEqual([1, 2, 3]);
    expect(parsePgArrayText('{"a b","c\\"d","e\\\\f",NULL,"NULL",null}', asIs)).toEqual(['a b', 'c"d', 'e\\f', null, 'NULL', null]);
    expect(parsePgArrayText('{{1,2},{3,4}}', Number)).toEqual([[1, 2], [3, 4]]);
    expect(parsePgArrayText('[0:1]={7,8}', Number)).toEqual([7, 8]);
    expect(parsePgArrayText('{}', asIs)).toEqual([]);
    expect(parsePgArrayText('{"2024-03-01 06:00:00","2024-03-02 07:15:00.5"}', asIs)).toEqual(['2024-03-01 06:00:00', '2024-03-02 07:15:00.5']);
  });

  test('node-postgres\'s rules: a date at local midnight, a timestamp local, a timestamptz its instant, bytea a Buffer', () => {
    expect(parseBuiltInTypedText(1082, '2024-03-01', NODE_POSTGRES)).toEqual(localDay('2024-03-01'));
    expect(parseBuiltInTypedText(1114, '2024-03-01 06:00:00.123', NODE_POSTGRES)).toEqual(new Date(2024, 2, 1, 6, 0, 0, 123));
    expect((parseBuiltInTypedText(1184, '2024-03-01 06:00:00+05:30', NODE_POSTGRES) as Date).toISOString()).toBe('2024-03-01T00:30:00.000Z');
    expect((parseBuiltInTypedText(1184, '2024-03-01 06:00:00.5-03', NODE_POSTGRES) as Date).toISOString()).toBe('2024-03-01T09:00:00.500Z');
    expect(Array.from(parseBuiltInTypedText(17, '\\x00ff10', NODE_POSTGRES) as Uint8Array)).toEqual([0, 255, 16]);
    // Before Christ, and a year beyond 9999
    expect((parseBuiltInTypedText(1082, '0044-03-15 BC', NODE_POSTGRES) as Date).getFullYear()).toBe(-43);
    expect((parseBuiltInTypedText(1184, '12024-01-01 00:00:00+00', NODE_POSTGRES) as Date).getUTCFullYear()).toBe(12024);
    // Arrays element by element, NULL kept
    expect(parseBuiltInTypedText(1182, '{2024-03-01,NULL}', NODE_POSTGRES)).toEqual([localDay('2024-03-01'), null]);
    expect(parseBuiltInTypedText(1115, '{"2024-03-01 06:00:00"}', NODE_POSTGRES)).toEqual([localTime('2024-03-01 06:00:00')]);
    // Any other type: its text (an array of one: its elements' texts)
    expect(parseBuiltInTypedText(20, '9007199254740993', NODE_POSTGRES)).toBe('9007199254740993');
    expect(parseBuiltInTypedText(1700, '1013.25', NODE_POSTGRES)).toBe('1013.25');
    expect(parseBuiltInTypedText(1016, '{1,9007199254740993}', NODE_POSTGRES)).toEqual(['1', '9007199254740993']);
    expect(parseBuiltInTypedText(1186, '01:30:00', NODE_POSTGRES)).toBe('01:30:00');
    // ±infinity as ±Infinity, in an array too; a fraction truncated to milliseconds
    expect([parseBuiltInTypedText(1082, 'infinity', NODE_POSTGRES), parseBuiltInTypedText(1114, '-infinity', NODE_POSTGRES), parseBuiltInTypedText(1184, 'infinity', NODE_POSTGRES)])
      .toEqual([Infinity, -Infinity, Infinity]);
    expect(parseBuiltInTypedText(1182, '{infinity,-infinity}', NODE_POSTGRES)).toEqual([Infinity, -Infinity]);
    expect((parseBuiltInTypedText(1184, '1969-12-31 23:59:59.9995+00', NODE_POSTGRES) as Date).getTime()).toBe(-1);
    // Any other text: as it is
    expect(parseBuiltInTypedText(1082, 'epoch-ish', NODE_POSTGRES)).toBe('epoch-ish');
  });

  test('the builtins JSON carries: a boolean, an int2 / int4 / oid and a float as numbers, json parsed, text as it is — and their arrays; an int8 as a BigInt on request', () => {
    expect([parseBuiltInTypedText(16, 't', NODE_POSTGRES), parseBuiltInTypedText(16, 'f', NODE_POSTGRES)]).toEqual([true, false]);
    expect([21, 23, 26].map(oid => parseBuiltInTypedText(oid, '4000000000', NODE_POSTGRES))).toEqual([4000000000, 4000000000, 4000000000]);
    expect(['1.5', 'NaN', 'Infinity', '-Infinity'].map(text => parseBuiltInTypedText(701, text, NODE_POSTGRES))).toEqual([1.5, NaN, Infinity, -Infinity]);
    expect(parseBuiltInTypedText(3802, '{"a": [2], "b": 1}', NODE_POSTGRES)).toEqual({ a: [2], b: 1 });
    expect(parseBuiltInTypedText(114, 'null', NODE_POSTGRES)).toBeNull();
    expect(parseBuiltInTypedText(1000, '{t,f,NULL}', NODE_POSTGRES)).toEqual([true, false, null]);
    expect(parseBuiltInTypedText(1007, '{1,-2}', NODE_POSTGRES)).toEqual([1, -2]);
    expect(parseBuiltInTypedText(199, '{"{\\"a\\":1}"}', NODE_POSTGRES)).toEqual([{ a: 1 }]);
    expect(parseBuiltInTypedText(1014, '{"a  "}', NODE_POSTGRES)).toEqual(['a  ']);
    // uuid[] is read as its text, as Bun reads it
    expect(parseBuiltInTypedText(2951, '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}', NODE_POSTGRES)).toBe('{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}');
    expect([parseBuiltInTypedText(20, '9007199254740993', { ...BUN, int8AsBigInt: true }), parseBuiltInTypedText(1016, '{1,2}', { ...BUN, int8AsBigInt: true })])
      .toEqual([9007199254740993n, [1n, 2n]]);
  });

  test('Bun\'s rules: a date at UTC midnight, a timestamp without a zone as a UTC wall time, a value before Christ as its decoding makes it', () => {
    expect((parseBuiltInTypedText(1082, '2024-03-01', BUN) as Date).toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect((parseBuiltInTypedText(1114, '2024-03-01 06:00:00.123', BUN) as Date).toISOString()).toBe('2024-03-01T06:00:00.123Z');
    expect((parseBuiltInTypedText(1184, '2024-03-01 06:00:00+01', BUN) as Date).toISOString()).toBe('2024-03-01T05:00:00.000Z');
    expect((parseBuiltInTypedText(1185, '{"2024-03-01 06:00:00+00"}', BUN) as Date[])[0].toISOString()).toBe('2024-03-01T06:00:00.000Z');
    expect(parseBuiltInTypedText(1114, 'infinity', BUN)).toBe(Infinity);

    // Bun reads no date before Christ; its binary decoding reads a timestamp before Christ, its text decoding does not
    const textDecoding = { ...BUN, bcDateInvalid: true, bcTimestampInvalid: true };
    const binaryDecoding = { ...BUN, bcDateInvalid: true, bcTimestampInvalid: false };
    expect((parseBuiltInTypedText(1082, '0044-03-15 BC', binaryDecoding) as Date).getTime()).toBeNaN();
    expect((parseBuiltInTypedText(1114, '0044-03-15 06:00:00 BC', textDecoding) as Date).getTime()).toBeNaN();
    expect((parseBuiltInTypedText(1114, '0044-03-15 06:00:00 BC', binaryDecoding) as Date).toISOString()).toBe('-000043-03-15T06:00:00.000Z');
    expect((parseBuiltInTypedText(1184, '0044-03-15 07:16:20+01:16:20 BC', binaryDecoding) as Date).toISOString()).toBe('-000043-03-15T06:00:00.000Z');
  });

  test('which declared types a batch sends as their text: all but those JSON carries as the drivers deliver them — and those too when the client parses them itself', () => {
    expect(['integer', 'int4', 'serial', 'smallint', 'boolean', 'text', 'varchar(64)', 'character varying', 'uuid', 'json', 'jsonb', 'double precision', 'real']
      .map(type => needsClientParse(type, []))).toEqual(new Array(13).fill(false));
    expect(['bigint', 'bigserial', 'numeric(12,2)', 'decimal', 'date', 'timestamp(3)', 'timestamp with time zone', 'interval', 'bytea', 'money', 'integer[]', 'wx_day', undefined]
      .map(type => needsClientParse(type, []))).toEqual(new Array(13).fill(true));
    // A client with a parser of its own for int4 (23) and for boolean (16)
    expect(['integer', 'boolean', 'text'].map(type => needsClientParse(type, [23, 16]))).toEqual([true, true, false]);
  });

  test('a custom-parsed builtin brings its array type along; the text-sent types include every temporal, int8, numeric, money and bytea type and their arrays', () => {
    expect(withArrayTypes([23, 1114, 99999]).sort((a, b) => a - b)).toEqual([23, 1007, 1114, 1115, 99999]);
    expect([1082, 1083, 1266, 1114, 1184, 1186, 20, 1700, 790, 17].every(oid => TEXT_TRANSPORT_TYPE_OIDS.includes(oid))).toBe(true);
    expect([1182, 1183, 1270, 1115, 1185, 1187, 1016, 1231, 791, 1001].every(oid => TEXT_TRANSPORT_TYPE_OIDS.includes(oid))).toBe(true);
    // Types JSON carries as the drivers deliver them are not among them
    expect([16, 21, 23, 25, 114, 3802, 2950, 701].some(oid => TEXT_TRANSPORT_TYPE_OIDS.includes(oid))).toBe(false);
  });
});
