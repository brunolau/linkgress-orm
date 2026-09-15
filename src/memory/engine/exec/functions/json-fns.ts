import type { JsonFuncSpec } from '../../analyze/expr';
import { Catalog, TypeOid } from '../../catalog/catalog';
import { PgError, SqlState } from '../../errors';
import { formatDate, formatTimestampJson } from '../../types/datetime';
import { inputValue, outputValue } from '../../types/io';
import {
  compareJsonbKeys,
  escapeJsonString,
  isJsonbObject,
  JNULL,
  jsonArrayElements,
  jsonbAsText,
  jsonbConcat,
  jsonbContains,
  jsonbExists,
  jsonbPretty,
  jsonbToText,
  JsonbObject,
  JsonbValue,
  jsonObjectMembers,
  jsonScalarText,
  jsonTextKind,
  parseJsonb,
} from '../../types/json';
import { executeJsonPath, parseJsonPath } from '../../types/jsonpath';
import { PgNumeric } from '../../types/numeric';
import { PgRecord } from '../../types/values';
import { FnCall, FnImpl } from '../runtime';

type JsonCategory = 'null' | 'bool' | 'numeric' | 'date' | 'timestamp' | 'timestamptz' | 'json' | 'jsonb' | 'array' | 'composite' | 'other';

const BUILTIN_JSON_CATEGORIES = new Map<number, { cat: JsonCategory; base: number }>(
  (
    [
      [TypeOid.bool, 'bool'],
      [TypeOid.int2, 'numeric'],
      [TypeOid.int4, 'numeric'],
      [TypeOid.int8, 'numeric'],
      [TypeOid.float4, 'numeric'],
      [TypeOid.float8, 'numeric'],
      [TypeOid.numeric, 'numeric'],
      [TypeOid.date, 'date'],
      [TypeOid.timestamp, 'timestamp'],
      [TypeOid.timestamptz, 'timestamptz'],
      [TypeOid.json, 'json'],
      [TypeOid.jsonb, 'jsonb'],
      [TypeOid.record, 'composite'],
      [TypeOid.text, 'other'],
      [TypeOid.varchar, 'other'],
      [TypeOid.uuid, 'other'],
    ] as [number, JsonCategory][]
  ).map(([t, cat]) => [t, { cat, base: t }])
);

export function jsonCategory(catalog: Catalog, type: number): { cat: JsonCategory; base: number } {
  // the common built-in scalar types (never domains, arrays or composites) need no catalog lookup
  const builtin = BUILTIN_JSON_CATEGORIES.get(type);
  if (builtin) {
    return builtin;
  }
  let t = type;
  let guard = 0;
  while (guard++ < 16) {
    const def = catalog.getType(t);
    if (def && def.typtype === 'd') {
      t = def.baseType;
      continue;
    }
    break;
  }
  switch (t) {
    case TypeOid.bool:
      return { cat: 'bool', base: t };
    case TypeOid.int2:
    case TypeOid.int4:
    case TypeOid.int8:
    case TypeOid.float4:
    case TypeOid.float8:
    case TypeOid.numeric:
      return { cat: 'numeric', base: t };
    case TypeOid.date:
      return { cat: 'date', base: t };
    case TypeOid.timestamp:
      return { cat: 'timestamp', base: t };
    case TypeOid.timestamptz:
      return { cat: 'timestamptz', base: t };
    case TypeOid.json:
      return { cat: 'json', base: t };
    case TypeOid.jsonb:
      return { cat: 'jsonb', base: t };
    case TypeOid.record:
      return { cat: 'composite', base: t };
  }
  const def = catalog.getType(t);
  if (def?.isArray) {
    return { cat: 'array', base: t };
  }
  if (def && def.typtype === 'c') {
    return { cat: 'composite', base: t };
  }
  return { cat: 'other', base: t };
}

function isValidJsonNumber(s: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}

/** datum_to_json */
export function datumToJson(v: unknown, type: number, fc: FnCall, keyScalar = false): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (v instanceof PgRecord) {
    return compositeToJson(v, fc, false);
  }
  const { cat, base } = jsonCategory(fc.st.catalog, type);
  if (keyScalar && (cat === 'array' || cat === 'composite' || cat === 'json' || cat === 'jsonb')) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'key value must be scalar, not array, composite, or json');
  }
  const io = fc.st.session.io;
  switch (cat) {
    case 'bool':
      return keyScalar ? `"${v ? 'true' : 'false'}"` : v ? 'true' : 'false';
    case 'numeric': {
      const s = outputValue(base, v, io);
      if (!keyScalar && isValidJsonNumber(s)) {
        return s;
      }
      return escapeJsonString(s);
    }
    case 'date':
      return escapeJsonString(formatDate(v as number));
    case 'timestamp':
      return escapeJsonString(formatTimestampJson(v as number, null));
    case 'timestamptz':
      return escapeJsonString(formatTimestampJson(v as number, io.zone));
    case 'json':
      return v as string;
    case 'jsonb':
      return jsonbToText(v as JsonbValue);
    case 'array':
      return arrayToJson(v as unknown[], fc.st.catalog.getType(base)!.elem, fc, false);
    case 'composite':
      return compositeToJson(v as PgRecord, fc, false);
    default:
      return escapeJsonString(outputValue(base, v, io));
  }
}

export function arrayToJson(arr: unknown[], elemType: number, fc: FnCall, pretty: boolean): string {
  const sep = pretty ? ',\n ' : ',';
  const render = (a: unknown[]): string => {
    const parts = a.map((x) => (Array.isArray(x) && !(x instanceof Uint8Array) && !isArrayElem(fc, elemType) ? render(x) : datumToJson(x, elemType, fc)));
    return '[' + parts.join(sep) + ']';
  };
  return render(arr);
}

function isArrayElem(fc: FnCall, elemType: number): boolean {
  return fc.st.catalog.getType(elemType)?.isArray ?? false;
}

export function recordFieldInfo(rec: PgRecord, catalog: Catalog): { names: string[]; types: number[] } {
  if (rec.fieldNames && rec.fieldNames.length === rec.values.length && rec.fieldTypes && rec.fieldTypes.length === rec.values.length) {
    return { names: rec.fieldNames, types: rec.fieldTypes };
  }
  const t = catalog.getType(rec.typeOid);
  if (t && t.relid) {
    const rel = catalog.getRelation(t.relid);
    if (rel) {
      const cols = rel.columns.filter((c) => !c.isDropped);
      return { names: cols.map((c) => c.name), types: cols.map((c) => c.typeOid) };
    }
  }
  return { names: rec.values.map((_, i) => `f${i + 1}`), types: rec.fieldTypes ?? rec.values.map(() => TypeOid.text) };
}

export function compositeToJson(rec: PgRecord, fc: FnCall, pretty: boolean): string {
  const { names, types } = recordFieldInfo(rec, fc.st.catalog);
  const sep = pretty ? ',\n ' : ',';
  const parts: string[] = [];
  for (let i = 0; i < rec.values.length; i++) {
    parts.push(escapeJsonString(names[i]) + ':' + datumToJson(rec.values[i], types[i], fc));
  }
  return '{' + parts.join(sep) + '}';
}

/** datum_to_jsonb */
export function datumToJsonb(v: unknown, type: number, fc: FnCall, keyScalar = false): JsonbValue {
  if (v === null || v === undefined) {
    return JNULL;
  }
  if (v instanceof PgRecord) {
    return compositeToJsonb(v, fc);
  }
  const { cat, base } = jsonCategory(fc.st.catalog, type);
  if (keyScalar && (cat === 'array' || cat === 'composite' || cat === 'json' || cat === 'jsonb')) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'key value must be scalar, not array, composite, or json');
  }
  const io = fc.st.session.io;
  switch (cat) {
    case 'bool':
      return keyScalar ? (v ? 'true' : 'false') : (v as boolean);
    case 'numeric': {
      if (base === TypeOid.numeric) {
        const n = v as PgNumeric;
        if (n.kind !== 'n') {
          return n.toString();
        }
        return keyScalar ? n.toString() : n;
      }
      const s = outputValue(base, v, io);
      if (!keyScalar && isValidJsonNumber(s)) {
        return PgNumeric.parse(s);
      }
      return s;
    }
    case 'date':
      return formatDate(v as number);
    case 'timestamp':
      return formatTimestampJson(v as number, null);
    case 'timestamptz':
      return formatTimestampJson(v as number, io.zone);
    case 'json':
      return parseJsonb(v as string, 'json');
    case 'jsonb':
      return v as JsonbValue;
    case 'array': {
      const elem = fc.st.catalog.getType(base)!.elem;
      const conv = (a: unknown[]): JsonbValue[] => a.map((x) => (Array.isArray(x) && !isArrayElem(fc, elem) ? conv(x) : datumToJsonb(x, elem, fc)));
      return conv(v as unknown[]);
    }
    case 'composite':
      return compositeToJsonb(v as PgRecord, fc);
    default:
      return outputValue(base, v, io);
  }
}

export function compositeToJsonb(rec: PgRecord, fc: FnCall): JsonbValue {
  const { names, types } = recordFieldInfo(rec, fc.st.catalog);
  const pairs: [string, JsonbValue][] = [];
  for (let i = 0; i < rec.values.length; i++) {
    pairs.push([names[i], datumToJsonb(rec.values[i], types[i], fc)]);
  }
  return JsonbObject.fromPairs(pairs);
}

function jsonbArg(v: unknown): JsonbValue {
  return v as JsonbValue;
}

function jsonbArrayElementAt(v: JsonbValue, idx: number): JsonbValue | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const i = idx < 0 ? v.length + idx : idx;
  if (i < 0 || i >= v.length) {
    return null;
  }
  return v[i];
}

function jsonbPath(v: JsonbValue, path: (string | null)[]): JsonbValue | null {
  let cur: JsonbValue | null = v;
  for (const p of path) {
    if (cur === null) {
      return null;
    }
    if (p === null) {
      return null;
    }
    if (cur instanceof JsonbObject) {
      const got: JsonbValue | undefined = cur.get(p);
      cur = got === undefined ? null : got;
    } else if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(p.trim())) {
        return null;
      }
      cur = jsonbArrayElementAt(cur, parseInt(p, 10));
    } else {
      return null;
    }
  }
  return cur;
}

function flatTextArray(v: unknown): (string | null)[] {
  const arr = v as unknown[];
  if (arr.length > 0 && Array.isArray(arr[0])) {
    throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'wrong number of array subscripts');
  }
  return arr as (string | null)[];
}

// json (text) path navigation
function jsonField(text: string, key: string): string | null {
  const members = jsonObjectMembers(text);
  if (!members) {
    return null;
  }
  let found: string | null = null;
  for (const [k, span] of members) {
    if (k === key) {
      found = text.slice(span.start, span.end);
    }
  }
  return found;
}

function jsonElement(text: string, idx: number): string | null {
  const elems = jsonArrayElements(text);
  if (!elems) {
    return null;
  }
  const i = idx < 0 ? elems.length + idx : idx;
  if (i < 0 || i >= elems.length) {
    return null;
  }
  return text.slice(elems[i].start, elems[i].end);
}

function jsonPath(text: string, path: (string | null)[]): string | null {
  let cur: string | null = text;
  for (const p of path) {
    if (cur === null || p === null) {
      return null;
    }
    const kind = jsonTextKind(cur);
    if (kind === 'object') {
      cur = jsonField(cur, p);
    } else if (kind === 'array') {
      if (!/^-?\d+$/.test(p.trim())) {
        return null;
      }
      cur = jsonElement(cur, parseInt(p, 10));
    } else {
      return null;
    }
  }
  return cur;
}

function jsonbTypeofName(v: JsonbValue): string {
  if (v === JNULL) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return 'boolean';
  }
  if (typeof v === 'string') {
    return 'string';
  }
  if (v instanceof PgNumeric) {
    return 'number';
  }
  if (Array.isArray(v)) {
    return 'array';
  }
  return 'object';
}

function stripNulls(v: JsonbValue, stripInArrays: boolean): JsonbValue {
  if (Array.isArray(v)) {
    return (stripInArrays ? v.filter((x) => x !== JNULL) : v).map((x) => stripNulls(x, stripInArrays));
  }
  if (v instanceof JsonbObject) {
    const keys: string[] = [];
    const vals: JsonbValue[] = [];
    v.keys.forEach((k, i) => {
      if (v.vals[i] !== JNULL) {
        keys.push(k);
        vals.push(stripNulls(v.vals[i], stripInArrays));
      }
    });
    return new JsonbObject(keys, vals);
  }
  return v;
}

function jsonbSet(target: JsonbValue, path: (string | null)[], newVal: JsonbValue, create: boolean, level = 0, insertMode: 'set' | 'before' | 'after' = 'set'): JsonbValue {
  if (path.length === 0) {
    return target;
  }
  const key = path[level];
  if (key === null) {
    throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, `path element at position ${level + 1} is null`);
  }
  const last = level === path.length - 1;
  if (target instanceof JsonbObject) {
    const existing = target.get(key);
    if (last) {
      if (insertMode !== 'set' && existing !== undefined) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot replace existing key', { hint: 'Try using the function jsonb_set to replace key value.' });
      }
      if (existing === undefined && !create && insertMode === 'set') {
        return target;
      }
      return target.with(key, newVal);
    }
    if (existing === undefined) {
      return target;
    }
    return target.with(key, jsonbSet(existing, path, newVal, create, level + 1, insertMode));
  }
  if (Array.isArray(target)) {
    if (!/^-?\d+$/.test(key.trim())) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `path element at position ${level + 1} is not an integer: "${key}"`);
    }
    let idx = parseInt(key, 10);
    const n = target.length;
    if (idx < 0) {
      idx += n;
    }
    const out = target.slice();
    if (last) {
      if (insertMode === 'set') {
        if (idx >= 0 && idx < n) {
          out[idx] = newVal;
        } else if (create) {
          if (idx < 0) {
            out.unshift(newVal);
          } else {
            out.push(newVal);
          }
        }
      } else {
        const pos = idx < 0 ? 0 : idx > n ? n : insertMode === 'after' ? idx + 1 : idx;
        out.splice(pos, 0, newVal);
      }
      return out;
    }
    if (idx >= 0 && idx < n) {
      out[idx] = jsonbSet(out[idx], path, newVal, create, level + 1, insertMode);
    }
    return out;
  }
  if (level === 0) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot set path in scalar');
  }
  return target;
}

function jsonbDeletePath(v: JsonbValue, path: (string | null)[], level = 0): JsonbValue {
  if (path.length === 0) {
    return v;
  }
  const key = path[level];
  if (key === null) {
    throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, `path element at position ${level + 1} is null`);
  }
  const last = level === path.length - 1;
  if (v instanceof JsonbObject) {
    if (last) {
      return v.without(key);
    }
    const child = v.get(key);
    return child === undefined ? v : v.with(key, jsonbDeletePath(child, path, level + 1));
  }
  if (Array.isArray(v)) {
    if (!/^-?\d+$/.test(key.trim())) {
      throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `path element at position ${level + 1} is not an integer: "${key}"`);
    }
    let idx = parseInt(key, 10);
    if (idx < 0) {
      idx += v.length;
    }
    if (idx < 0 || idx >= v.length) {
      return v;
    }
    const out = v.slice();
    if (last) {
      out.splice(idx, 1);
    } else {
      out[idx] = jsonbDeletePath(out[idx], path, level + 1);
    }
    return out;
  }
  throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot delete path in scalar');
}

function jsonbCastError(v: JsonbValue, target: string): PgError {
  return new PgError(SqlState.INVALID_PARAMETER_VALUE, `cannot cast jsonb ${jsonbTypeofName(v)} to type ${target}`);
}

function buildObjectArgs(a: unknown[], fc: FnCall, fnName: string): void {
  if (a.length % 2 !== 0) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'argument list must have even number of elements', {
      hint: `The arguments of ${fnName}() must consist of alternating keys and values.`,
    });
  }
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === null) {
      throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, `argument ${i + 1}: key must not be null`);
    }
  }
  void fc;
}

function variadicArgs(a: unknown[], fc: FnCall): { values: unknown[]; types: number[] } {
  if ((fc.node as { variadic?: boolean }).variadic) {
    const arr = (a[a.length - 1] as unknown[]) ?? [];
    const elemType = fc.st.catalog.getType(fc.argTypes[fc.argTypes.length - 1])?.elem ?? TypeOid.text;
    return { values: [...a.slice(0, -1), ...arr], types: [...fc.argTypes.slice(0, -1), ...arr.map(() => elemType)] };
  }
  return { values: a, types: fc.argTypes };
}

export const JSON_FUNCS: Record<string, FnImpl> = {
  __linkgress_json_func: (a, fc) => jsonFunc(a, fc),
  // constructors
  to_json: (a, fc) => datumToJson(a[0], fc.argTypes[0], fc),
  to_jsonb: (a, fc) => datumToJsonb(a[0], fc.argTypes[0], fc),
  row_to_json: (a, fc) => compositeToJson(a[0] as PgRecord, fc, false),
  row_to_json_pretty: (a, fc) => compositeToJson(a[0] as PgRecord, fc, a[1] === true),
  array_to_json: (a, fc) => arrayToJson(a[0] as unknown[], fc.st.catalog.getType(fc.argTypes[0])?.elem ?? TypeOid.text, fc, false),
  array_to_json_pretty: (a, fc) => arrayToJson(a[0] as unknown[], fc.st.catalog.getType(fc.argTypes[0])?.elem ?? TypeOid.text, fc, a[1] === true),
  json_build_object: (args, fc) => {
    const { values: a, types } = variadicArgs(args, fc);
    buildObjectArgs(a, fc, 'json_build_object');
    const parts: string[] = [];
    for (let i = 0; i < a.length; i += 2) {
      const key = datumToJson(a[i], types[i], fc, true);
      parts.push(key + ' : ' + datumToJson(a[i + 1], types[i + 1], fc));
    }
    return '{' + parts.join(', ') + '}';
  },
  json_build_object_noargs: () => '{}',
  json_build_array: (args, fc) => {
    const { values: a, types } = variadicArgs(args, fc);
    return '[' + a.map((v, i) => datumToJson(v, types[i], fc)).join(', ') + ']';
  },
  json_build_array_noargs: () => '[]',
  jsonb_build_object: (args, fc) => {
    const { values: a, types } = variadicArgs(args, fc);
    buildObjectArgs(a, fc, 'jsonb_build_object');
    const pairs: [string, JsonbValue][] = [];
    for (let i = 0; i < a.length; i += 2) {
      const k = datumToJsonb(a[i], types[i], fc, true);
      pairs.push([typeof k === 'string' ? k : jsonbToText(k), datumToJsonb(a[i + 1], types[i + 1], fc)]);
    }
    return JsonbObject.fromPairs(pairs);
  },
  jsonb_build_object_noargs: () => new JsonbObject(),
  jsonb_build_array: (args, fc) => {
    const { values: a, types } = variadicArgs(args, fc);
    return a.map((v, i) => datumToJsonb(v, types[i], fc));
  },
  jsonb_build_array_noargs: () => [],
  json_object: (a) => {
    const arr = a[0] as unknown[];
    const pairs: string[] = [];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      for (const p of arr as unknown[][]) {
        pairs.push(`${escapeJsonString(p[0] as string)} : ${p[1] === null ? 'null' : escapeJsonString(p[1] as string)}`);
      }
    } else {
      if (arr.length % 2 !== 0) {
        throw new PgError(SqlState.ARRAY_SUBSCRIPT_ERROR, 'array must have even number of elements');
      }
      for (let i = 0; i < arr.length; i += 2) {
        pairs.push(`${escapeJsonString(arr[i] as string)} : ${arr[i + 1] === null ? 'null' : escapeJsonString(arr[i + 1] as string)}`);
      }
    }
    return '{' + pairs.join(', ') + '}';
  },
  jsonb_object: (a) => {
    const arr = a[0] as unknown[];
    const pairs: [string, JsonbValue][] = [];
    if (arr.length > 0 && Array.isArray(arr[0])) {
      for (const p of arr as unknown[][]) {
        pairs.push([p[0] as string, p[1] === null ? JNULL : (p[1] as string)]);
      }
    } else {
      for (let i = 0; i + 1 < arr.length; i += 2) {
        pairs.push([arr[i] as string, arr[i + 1] === null ? JNULL : (arr[i + 1] as string)]);
      }
    }
    return JsonbObject.fromPairs(pairs);
  },
  // conversions
  jsonb_in: (a) => parseJsonb(a[0] as string),
  json_in: (a) => a[0],
  jsonb_to_json: (a) => jsonbToText(jsonbArg(a[0])),
  json_to_jsonb: (a) => parseJsonb(a[0] as string, 'json'),
  jsonb_numeric: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'numeric');
    }
    return v;
  },
  jsonb_int4: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'integer');
    }
    const r = Number(v.toBigIntRounded());
    if (r > 2147483647 || r < -2147483648) {
      throw new PgError(SqlState.NUMERIC_VALUE_OUT_OF_RANGE, 'integer out of range');
    }
    return r;
  },
  jsonb_int8: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'bigint');
    }
    return v.toBigIntRounded();
  },
  jsonb_int2: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'smallint');
    }
    return Number(v.toBigIntRounded());
  },
  jsonb_float8: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'double precision');
    }
    return v.toNumber();
  },
  jsonb_float4: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof PgNumeric)) {
      throw jsonbCastError(v, 'real');
    }
    return Math.fround(v.toNumber());
  },
  jsonb_bool: (a) => {
    const v = jsonbArg(a[0]);
    if (typeof v !== 'boolean') {
      throw jsonbCastError(v, 'boolean');
    }
    return v;
  },
  // accessors (jsonb)
  jsonb_object_field: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof JsonbObject)) {
      return null;
    }
    const r = v.get(a[1] as string);
    return r === undefined ? null : r;
  },
  jsonb_object_field_text: (a) => {
    const v = jsonbArg(a[0]);
    if (!(v instanceof JsonbObject)) {
      return null;
    }
    const r = v.get(a[1] as string);
    return r === undefined ? null : jsonbAsText(r);
  },
  jsonb_array_element: (a) => jsonbArrayElementAt(jsonbArg(a[0]), a[1] as number),
  jsonb_array_element_text: (a) => {
    const r = jsonbArrayElementAt(jsonbArg(a[0]), a[1] as number);
    return r === null ? null : jsonbAsText(r);
  },
  jsonb_extract_path: (a) => jsonbPath(jsonbArg(a[0]), flatTextArray(a[1])),
  jsonb_extract_path_text: (a) => {
    const r = jsonbPath(jsonbArg(a[0]), flatTextArray(a[1]));
    return r === null ? null : jsonbAsText(r);
  },
  jsonb_contains: (a) => jsonbContains(jsonbArg(a[0]), jsonbArg(a[1])),
  jsonb_contained: (a) => jsonbContains(jsonbArg(a[1]), jsonbArg(a[0])),
  jsonb_exists: (a) => jsonbExists(jsonbArg(a[0]), a[1] as string),
  jsonb_exists_any: (a) => (a[1] as (string | null)[]).some((k) => k !== null && jsonbExists(jsonbArg(a[0]), k)),
  jsonb_exists_all: (a) => (a[1] as (string | null)[]).every((k) => k === null || jsonbExists(jsonbArg(a[0]), k)),
  jsonb_concat: (a) => jsonbConcat(jsonbArg(a[0]), jsonbArg(a[1])),
  jsonb_delete: (a, fc) => {
    const v = jsonbArg(a[0]);
    if (fc.argTypes[1] === TypeOid.int4) {
      if (!Array.isArray(v)) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, v instanceof JsonbObject ? 'cannot delete from object using integer index' : 'cannot delete from scalar');
      }
      let idx = a[1] as number;
      if (idx < 0) {
        idx += v.length;
      }
      if (idx < 0 || idx >= v.length) {
        return v;
      }
      const out = v.slice();
      out.splice(idx, 1);
      return out;
    }
    if (fc.argTypes[1] === TypeOid._text) {
      let cur = v;
      for (const k of a[1] as (string | null)[]) {
        if (k === null) {
          continue;
        }
        cur = deleteKey(cur, k);
      }
      return cur;
    }
    return deleteKey(v, a[1] as string);
  },
  jsonb_delete_idx: (a) => {
    const v = jsonbArg(a[0]);
    if (!Array.isArray(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, v instanceof JsonbObject ? 'cannot delete from object using integer index' : 'cannot delete from scalar');
    }
    let idx = a[1] as number;
    if (idx < 0) {
      idx += v.length;
    }
    if (idx < 0 || idx >= v.length) {
      return v;
    }
    const out = v.slice();
    out.splice(idx, 1);
    return out;
  },
  jsonb_delete_array: (a) => {
    let cur = jsonbArg(a[0]);
    for (const k of a[1] as (string | null)[]) {
      if (k !== null) {
        cur = deleteKey(cur, k);
      }
    }
    return cur;
  },
  jsonb_delete_path: (a) => jsonbDeletePath(jsonbArg(a[0]), flatTextArray(a[1])),
  jsonb_set: (a) => jsonbSet(jsonbArg(a[0]), flatTextArray(a[1]), jsonbArg(a[2]), a.length > 3 ? a[3] !== false : true),
  jsonb_set_lax: (a) => {
    if (a[2] === null) {
      const treat = (a[4] as string) ?? 'use_json_null';
      switch (treat) {
        case 'raise_exception':
          throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'JSON value must not be null');
        case 'delete_key':
          return jsonbDeletePath(jsonbArg(a[0]), flatTextArray(a[1]));
        case 'return_target':
          return a[0];
        default:
          return jsonbSet(jsonbArg(a[0]), flatTextArray(a[1]), JNULL, a[3] !== false);
      }
    }
    return jsonbSet(jsonbArg(a[0]), flatTextArray(a[1]), jsonbArg(a[2]), a[3] !== false);
  },
  jsonb_insert: (a) => jsonbSet(jsonbArg(a[0]), flatTextArray(a[1]), jsonbArg(a[2]), true, 0, a[3] === true ? 'after' : 'before'),
  jsonb_array_length: (a) => {
    const v = jsonbArg(a[0]);
    if (Array.isArray(v)) {
      return v.length;
    }
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, v instanceof JsonbObject ? 'cannot get array length of a non-array' : 'cannot get array length of a scalar');
  },
  jsonb_typeof: (a) => jsonbTypeofName(jsonbArg(a[0])),
  jsonb_strip_nulls: (a) => stripNulls(jsonbArg(a[0]), a[1] === true),
  jsonb_pretty: (a) => jsonbPretty(jsonbArg(a[0])),
  jsonb_hash: (a) => jsonbToText(jsonbArg(a[0])).length,
  // accessors (json text)
  json_object_field: (a) => (jsonTextKind(a[0] as string) === 'object' ? jsonField(a[0] as string, a[1] as string) : null),
  json_object_field_text: (a) => {
    if (jsonTextKind(a[0] as string) !== 'object') {
      return null;
    }
    const r = jsonField(a[0] as string, a[1] as string);
    return r === null ? null : jsonScalarText(r);
  },
  json_array_element: (a) => (jsonTextKind(a[0] as string) === 'array' ? jsonElement(a[0] as string, a[1] as number) : null),
  json_array_element_text: (a) => {
    if (jsonTextKind(a[0] as string) !== 'array') {
      return null;
    }
    const r = jsonElement(a[0] as string, a[1] as number);
    return r === null ? null : jsonScalarText(r);
  },
  json_extract_path: (a) => jsonPath(a[0] as string, flatTextArray(a[1])),
  json_extract_path_text: (a) => {
    const r = jsonPath(a[0] as string, flatTextArray(a[1]));
    return r === null ? null : jsonScalarText(r);
  },
  json_array_length: (a) => {
    const kind = jsonTextKind(a[0] as string);
    if (kind !== 'array') {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, kind === 'object' ? 'cannot get array length of a non-array' : 'cannot get array length of a scalar');
    }
    return jsonArrayElements(a[0] as string)!.length;
  },
  json_typeof: (a) => jsonTextKind(a[0] as string),
  json_strip_nulls: (a) => jsonbToText(stripNulls(parseJsonb(a[0] as string, 'json'), a[1] === true)).replace(/": /g, '":').replace(/, "/g, ',"'),
};

function deleteKey(v: JsonbValue, key: string): JsonbValue {
  if (v instanceof JsonbObject) {
    return v.without(key);
  }
  if (Array.isArray(v)) {
    return v.filter((e) => e !== key);
  }
  throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot delete from scalar');
}

// ---------------------------------------------------------------------------
// Set-returning json functions: return arrays of rows (arrays for multi-column results)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SQL/JSON path
// ---------------------------------------------------------------------------

function pathItems(a: unknown[], silentDefault: boolean): JsonbValue[] | null {
  const target = jsonbArg(a[0]);
  const path = parseJsonPath(a[1] as string);
  const vars = a.length > 2 && a[2] !== null && a[2] !== undefined ? jsonbArg(a[2]) : new JsonbObject();
  const silent = a.length > 3 ? a[3] === true : silentDefault;
  if (a.length > 2 && a[2] !== null && !(vars instanceof JsonbObject)) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, '"vars" argument is not an object', { detail: 'Jsonpath parameters should be encoded as key-value pairs of "vars" object.' });
  }
  return executeJsonPath(path, target, vars, silent);
}

function pathMatch(a: unknown[], silentDefault: boolean): unknown {
  const items = pathItems(a, silentDefault);
  const silent = a.length > 3 ? a[3] === true : silentDefault;
  if (items === null) {
    return null;
  }
  if (items.length === 1) {
    if (typeof items[0] === 'boolean') {
      return items[0];
    }
    if (items[0] === JNULL) {
      return null;
    }
  }
  if (silent) {
    return null;
  }
  throw new PgError('22038', 'single boolean result is expected');
}

export const JSON_PATH_FUNCS: Record<string, FnImpl> = {
  jsonb_path_exists: (a) => {
    const items = pathItems(a, false);
    return items === null ? null : items.length > 0;
  },
  jsonb_path_exists_opr: (a) => {
    const items = pathItems(a, true);
    return items === null ? null : items.length > 0;
  },
  jsonb_path_match: (a) => pathMatch(a, false),
  jsonb_path_match_opr: (a) => pathMatch(a, true),
  jsonb_path_query_array: (a) => pathItems(a, false) ?? [],
  jsonb_path_query_first: (a) => {
    const items = pathItems(a, false);
    return items && items.length > 0 ? items[0] : null;
  },
};

export const JSON_SRFS: Record<string, FnImpl> = {
  jsonb_path_query: (a) => pathItems(a, false) ?? [],
  jsonb_array_elements: (a) => {
    const v = jsonbArg(a[0]);
    if (!Array.isArray(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, v instanceof JsonbObject ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
    }
    return v.slice();
  },
  jsonb_array_elements_text: (a) => {
    const v = jsonbArg(a[0]);
    if (!Array.isArray(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, v instanceof JsonbObject ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
    }
    return v.map((x) => jsonbAsText(x));
  },
  jsonb_each: (a) => {
    const v = jsonbArg(a[0]);
    if (!isJsonbObject(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot call jsonb_each on a non-object');
    }
    return v.keys.map((k, i) => [k, v.vals[i]]);
  },
  jsonb_each_text: (a) => {
    const v = jsonbArg(a[0]);
    if (!isJsonbObject(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot call jsonb_each_text on a non-object');
    }
    return v.keys.map((k, i) => [k, jsonbAsText(v.vals[i])]);
  },
  jsonb_object_keys: (a) => {
    const v = jsonbArg(a[0]);
    if (!isJsonbObject(v)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `cannot call jsonb_object_keys on ${Array.isArray(v) ? 'an array' : 'a scalar'}`);
    }
    return v.keys.slice();
  },
  json_array_elements: (a) => {
    const t = a[0] as string;
    const elems = jsonArrayElements(t);
    if (!elems) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, jsonTextKind(t) === 'object' ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar');
    }
    return elems.map((s) => t.slice(s.start, s.end));
  },
  json_array_elements_text: (a) => {
    const t = a[0] as string;
    const elems = jsonArrayElements(t);
    if (!elems) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot extract elements from a scalar');
    }
    return elems.map((s) => jsonScalarText(t.slice(s.start, s.end)));
  },
  json_each: (a) => {
    const t = a[0] as string;
    const members = jsonObjectMembers(t);
    if (!members) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot call json_each on a non-object');
    }
    return members.map(([k, s]) => [k, t.slice(s.start, s.end)]);
  },
  json_each_text: (a) => {
    const t = a[0] as string;
    const members = jsonObjectMembers(t);
    if (!members) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot call json_each_text on a non-object');
    }
    return members.map(([k, s]) => [k, jsonScalarText(t.slice(s.start, s.end))]);
  },
  json_object_keys: (a) => {
    const members = jsonObjectMembers(a[0] as string);
    if (!members) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'cannot call json_object_keys on a scalar');
    }
    return members.map(([k]) => k);
  },
};

/** Does JSON text contain an object with a repeated key? (IS JSON ... WITH UNIQUE KEYS) */
function jsonHasDuplicateKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      const lit = text.slice(i, j + 1);
      i = j + 1;
      while (i < text.length && /\s/.test(text[i])) {
        i++;
      }
      const top = stack[stack.length - 1];
      if (text[i] === ':' && top) {
        const key = JSON.parse(lit) as string;
        if (top.has(key)) {
          return true;
        }
        top.add(key);
      }
      continue;
    }
    if (ch === '{') {
      stack.push(new Set());
    } else if (ch === '[') {
      stack.push(null);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
    i++;
  }
  return false;
}

function jsonIsPredicate(v: unknown, argType: number, spec: JsonFuncSpec): boolean {
  let value: JsonbValue;
  if (argType === TypeOid.jsonb) {
    value = v as JsonbValue;
  } else {
    const text = v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v);
    try {
      value = parseJsonb(text, 'json');
    } catch {
      return false;
    }
    if (spec.uniqueKeys && jsonHasDuplicateKeys(text)) {
      return false;
    }
  }
  switch (spec.itemType) {
    case 'object':
      return isJsonbObject(value);
    case 'array':
      return Array.isArray(value);
    case 'scalar':
      return !isJsonbObject(value) && !Array.isArray(value);
    default:
      return true;
  }
}

/** JSON_VALUE / JSON_QUERY / JSON_EXISTS / IS JSON (ExecEvalJsonExprPath). */
function jsonFunc(a: unknown[], fc: FnCall): unknown {
  const isPredicate = fc.node.k === 'func' && fc.node.funcName === 'is_json';
  const spec = JSON.parse(a[isPredicate ? 1 : 2] as string) as JsonFuncSpec;
  if (spec.op === 'is_json') {
    return a[0] === null ? null : jsonIsPredicate(a[0], fc.st.catalog.getType(fc.argTypes[0])?.baseType || fc.argTypes[0], spec);
  }
  if (a[0] === null || a[1] === null) {
    return null;
  }
  const io = fc.st.session.io;
  const type = fc.resultType;
  const typmod = fc.resultTypmod;
  const fromText = (text: string): unknown => inputValue(type, text, typmod, io);
  const fromJsonb = (v: JsonbValue): unknown => {
    if (type === TypeOid.jsonb) {
      return v;
    }
    return fromText(jsonbToText(v));
  };
  const behaviorValue = (kind: JsonFuncSpec['onError'], defaultIdx: number): unknown => {
    switch (kind) {
      case 'null':
      case 'unknown':
        return null;
      case 'true':
      case 'false':
        return type === TypeOid.bool ? kind === 'true' : fromText(kind);
      case 'empty_array':
        return fromJsonb([]);
      case 'empty_object':
        return fromJsonb(new JsonbObject());
      case 'default':
        return a[defaultIdx];
      default:
        return null;
    }
  };
  let emptyError: PgError | null = null;
  try {
    const vars = new JsonbObject();
    const pairs: [string, JsonbValue][] = spec.names.map((n, i) => [n, datumToJsonb(a[3 + i], fc.argTypes[3 + i], fc)]);
    const items = executeJsonPath(parseJsonPath(a[1] as string), a[0] as JsonbValue, pairs.length ? JsonbObject.fromPairs(pairs) : vars, false) ?? [];
    if (spec.op === 'json_exists') {
      const exists = items.length > 0;
      return type === TypeOid.bool ? exists : fromText(String(exists));
    }
    let singleton: JsonbValue | null;
    if (spec.op === 'json_value') {
      if (items.length > 1) {
        throw new PgError('22034', 'JSON path expression in JSON_VALUE must return single scalar item');
      }
      singleton = items.length ? items[0] : null;
      if (singleton !== null && (isJsonbObject(singleton) || Array.isArray(singleton))) {
        throw new PgError('2203F', 'JSON path expression in JSON_VALUE must return single scalar item');
      }
    } else {
      const wrap = items.length > 0 && (spec.wrapper === 'unconditional' || (spec.wrapper === 'conditional' && items.length > 1));
      if (wrap) {
        singleton = items;
      } else {
        if (items.length > 1) {
          throw new PgError('22034', 'JSON path expression in JSON_QUERY must return single item when no wrapper is requested', {
            hint: 'Use the WITH WRAPPER clause to wrap SQL/JSON items into an array.',
          });
        }
        singleton = items.length ? items[0] : null;
      }
    }
    if (singleton === null) {
      if (spec.onEmpty === 'error') {
        emptyError = new PgError('22035', 'no SQL/JSON item found for specified path');
        throw emptyError;
      }
      return behaviorValue(spec.onEmpty, spec.emptyDefault);
    }
    if (singleton === JNULL) {
      return null;
    }
    if (spec.op === 'json_value') {
      return type === TypeOid.jsonb ? singleton : type === TypeOid.json ? jsonbToText(singleton) : fromText(jsonbAsText(singleton)!);
    }
    if (spec.omitQuotes && typeof singleton === 'string') {
      return fromText(singleton);
    }
    return fromJsonb(singleton);
  } catch (err) {
    if (spec.onError === 'error' || !(err instanceof PgError) || err === emptyError) {
      throw err;
    }
    return behaviorValue(spec.onError, spec.errorDefault);
  }
}

export const JSON_TO_RECORD_FUNCS =new Set(['json_to_record', 'jsonb_to_record', 'json_to_recordset', 'jsonb_to_recordset']);

/** Rows of json(b)_to_record(set) for a column definition list (populate_record semantics). */
export function jsonToRecordRows(
  funcSrc: string,
  arg: unknown,
  cols: { type: number; typmod: number }[],
  colNames: string[],
  fc: FnCall,
): unknown[][] {
  const catalog = fc.st.catalog;
  const io = fc.st.session.io;
  const isJson = !funcSrc.startsWith('jsonb');
  const root = isJson ? parseJsonb(arg as string, 'json') : (arg as JsonbValue);
  const scalar = (v: JsonbValue, type: number, typmod: number, key: string): unknown => {
    if (v === JNULL) {
      return null;
    }
    const t = catalog.getType(type);
    if (type === TypeOid.jsonb) {
      return v;
    }
    if (type === TypeOid.json) {
      return jsonbToText(v);
    }
    if (t?.isArray) {
      if (Array.isArray(v)) {
        const conv = (arr: JsonbValue[]): unknown[] => arr.map((x) => (Array.isArray(x) ? conv(x) : scalar(x, t.elem, -1, key)));
        return conv(v);
      }
      if (typeof v !== 'string') {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'expected JSON array', { hint: `See the value of key "${key}".` });
      }
    }
    return inputValue(type, jsonbAsText(v)!, typmod, io);
  };
  const record = (obj: JsonbValue): unknown[] =>
    cols.map((c, i) => {
      const idx = (obj as JsonbObject).indexOf(colNames[i]);
      return idx < 0 ? null : scalar((obj as JsonbObject).vals[idx], c.type, c.typmod, colNames[i]);
    });
  if (funcSrc.endsWith('recordset')) {
    if (!Array.isArray(root)) {
      throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `cannot call ${funcSrc} on a non-array`);
    }
    return root.map((el) => {
      if (!isJsonbObject(el)) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `argument of ${funcSrc} must be an array of objects`);
      }
      return record(el);
    });
  }
  if (!isJsonbObject(root)) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `cannot call ${funcSrc} on a non-object`);
  }
  return [record(root)];
}

export { compareJsonbKeys };
