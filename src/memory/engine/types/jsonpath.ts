import { PgError, SqlState } from '../errors';
import { compareUtf8Bytes, JNULL, JsonbObject, JsonbValue } from './json';
import { PgNumeric } from './numeric';

/**
 * SQL/JSON path language (jsonpath): parser and evaluator following PostgreSQL's jsonpath_exec.c
 * semantics for lax/strict mode, filters, comparisons and the common item methods.
 */

type Node =
  | { t: 'root' }
  | { t: 'current' }
  | { t: 'var'; name: string }
  | { t: 'last' }
  | { t: 'lit'; v: JsonbValue }
  | { t: 'key'; base: Node; key: string }
  | { t: 'anykey'; base: Node }
  | { t: 'anyarray'; base: Node }
  | { t: 'index'; base: Node; subs: { from: Node; to: Node | null }[] }
  | { t: 'recursive'; base: Node }
  | { t: 'filter'; base: Node; pred: Node }
  | { t: 'method'; base: Node; name: string; args: Node[] }
  | { t: 'binary'; op: string; left: Node; right: Node }
  | { t: 'unary'; op: string; arg: Node }
  | { t: 'exists'; arg: Node }
  | { t: 'isunknown'; arg: Node }
  | { t: 'like'; arg: Node; pattern: string; flags: string }
  | { t: 'startswith'; arg: Node; prefix: Node };

export interface JsonPath {
  strict: boolean;
  expr: Node;
}

function syntaxError(msg: string): PgError {
  return new PgError(SqlState.SYNTAX_ERROR, msg);
}

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type Tok = { k: 'num'; v: string } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'var'; v: string } | { k: 'p'; v: string } | { k: 'end' };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const two = ['==', '!=', '<>', '<=', '>=', '&&', '||', '**'];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const n = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\', '/': '/' };
          if (n === 'u') {
            s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          s += map[n] ?? n;
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (src[i] !== '"') {
        throw syntaxError('syntax error at end of jsonpath input');
      }
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      if (src[j] === '"') {
        const end = src.indexOf('"', j + 1);
        out.push({ k: 'var', v: src.slice(j + 1, end) });
        i = end + 1;
        continue;
      }
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        j++;
      }
      out.push(j === i + 1 ? { k: 'p', v: '$' } : { k: 'var', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        j++;
      }
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.includes(pair)) {
      out.push({ k: 'p', v: pair });
      i += 2;
      continue;
    }
    if ('.[](),?@*+-/%<>!:'.includes(c)) {
      out.push({ k: 'p', v: c });
      i++;
      continue;
    }
    throw syntaxError(`syntax error at or near "${c}" of jsonpath input`);
  }
  out.push({ k: 'end' });
  return out;
}

class PathParser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos];
  }

  private isP(v: string): boolean {
    const t = this.peek();
    return t.k === 'p' && t.v === v;
  }

  private isId(v: string): boolean {
    const t = this.peek();
    return t.k === 'id' && t.v.toLowerCase() === v;
  }

  private expectP(v: string): void {
    if (!this.isP(v)) {
      throw syntaxError(`syntax error at or near "${this.tokText()}" of jsonpath input`);
    }
    this.pos++;
  }

  private tokText(): string {
    const t = this.peek();
    return t.k === 'end' ? 'end of input' : String((t as { v: string }).v);
  }

  parse(): JsonPath {
    let strict = false;
    if (this.isId('strict')) {
      strict = true;
      this.pos++;
    } else if (this.isId('lax')) {
      this.pos++;
    }
    const expr = this.orExpr();
    if (this.peek().k !== 'end') {
      throw syntaxError(`syntax error at or near "${this.tokText()}" of jsonpath input`);
    }
    return { strict, expr };
  }

  private orExpr(): Node {
    let left = this.andExpr();
    while (this.isP('||')) {
      this.pos++;
      left = { t: 'binary', op: '||', left, right: this.andExpr() };
    }
    return left;
  }

  private andExpr(): Node {
    let left = this.notExpr();
    while (this.isP('&&')) {
      this.pos++;
      left = { t: 'binary', op: '&&', left, right: this.notExpr() };
    }
    return left;
  }

  private notExpr(): Node {
    if (this.isP('!')) {
      this.pos++;
      return { t: 'unary', op: '!', arg: this.notExpr() };
    }
    return this.predicate();
  }

  private predicate(): Node {
    if (this.isId('exists')) {
      this.pos++;
      this.expectP('(');
      const arg = this.orExpr();
      this.expectP(')');
      return { t: 'exists', arg };
    }
    const left = this.additive();
    const t = this.peek();
    if (t.k === 'p' && ['==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      this.pos++;
      return { t: 'binary', op: t.v === '<>' ? '!=' : t.v, left, right: this.additive() };
    }
    if (this.isId('like_regex')) {
      this.pos++;
      const pt = this.peek();
      if (pt.k !== 'str') {
        throw syntaxError('syntax error in like_regex pattern of jsonpath input');
      }
      this.pos++;
      let flags = '';
      if (this.isId('flag')) {
        this.pos++;
        const ft = this.peek();
        if (ft.k !== 'str') {
          throw syntaxError('syntax error in like_regex flags of jsonpath input');
        }
        flags = ft.v;
        this.pos++;
      }
      return { t: 'like', arg: left, pattern: pt.v, flags };
    }
    if (this.isId('starts')) {
      this.pos++;
      if (!this.isId('with')) {
        throw syntaxError('syntax error at or near "starts" of jsonpath input');
      }
      this.pos++;
      return { t: 'startswith', arg: left, prefix: this.primary() };
    }
    if (this.isId('is')) {
      this.pos++;
      if (!this.isId('unknown')) {
        throw syntaxError('syntax error at or near "is" of jsonpath input');
      }
      this.pos++;
      return { t: 'isunknown', arg: left };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.isP('+') || this.isP('-')) {
      const op = (this.peek() as { v: string }).v;
      this.pos++;
      left = { t: 'binary', op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.unary();
    while (this.isP('*') || this.isP('/') || this.isP('%')) {
      const op = (this.peek() as { v: string }).v;
      this.pos++;
      left = { t: 'binary', op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.isP('+') || this.isP('-')) {
      const op = (this.peek() as { v: string }).v;
      this.pos++;
      return { t: 'unary', op, arg: this.unary() };
    }
    return this.accessorChain(this.primary());
  }

  private primary(): Node {
    const t = this.peek();
    if (t.k === 'p' && t.v === '$') {
      this.pos++;
      return { t: 'root' };
    }
    if (t.k === 'p' && t.v === '@') {
      this.pos++;
      return { t: 'current' };
    }
    if (t.k === 'var') {
      this.pos++;
      return { t: 'var', name: t.v };
    }
    if (t.k === 'num') {
      this.pos++;
      return { t: 'lit', v: PgNumeric.parse(t.v) };
    }
    if (t.k === 'str') {
      this.pos++;
      return { t: 'lit', v: t.v };
    }
    if (t.k === 'id') {
      const id = t.v.toLowerCase();
      if (id === 'true' || id === 'false') {
        this.pos++;
        return { t: 'lit', v: id === 'true' };
      }
      if (id === 'null') {
        this.pos++;
        return { t: 'lit', v: JNULL };
      }
      if (id === 'last') {
        this.pos++;
        return { t: 'last' };
      }
    }
    if (t.k === 'p' && t.v === '(') {
      this.pos++;
      const e = this.orExpr();
      this.expectP(')');
      return e;
    }
    throw syntaxError(`syntax error at or near "${this.tokText()}" of jsonpath input`);
  }

  private accessorChain(base: Node): Node {
    let node = base;
    for (;;) {
      if (this.isP('.')) {
        this.pos++;
        const t = this.peek();
        if (t.k === 'p' && t.v === '*') {
          this.pos++;
          node = { t: 'anykey', base: node };
        } else if (t.k === 'p' && t.v === '**') {
          this.pos++;
          node = { t: 'recursive', base: node };
        } else if (t.k === 'str') {
          this.pos++;
          node = { t: 'key', base: node, key: t.v };
        } else if (t.k === 'id') {
          this.pos++;
          if (this.isP('(')) {
            this.pos++;
            const args: Node[] = [];
            while (!this.isP(')')) {
              args.push(this.orExpr());
              if (this.isP(',')) {
                this.pos++;
              }
            }
            this.expectP(')');
            node = { t: 'method', base: node, name: t.v.toLowerCase(), args };
          } else {
            node = { t: 'key', base: node, key: t.v };
          }
        } else if (t.k === 'var') {
          // ".$name" is not valid in PostgreSQL either
          throw syntaxError(`syntax error at or near "$${t.v}" of jsonpath input`);
        } else {
          throw syntaxError(`syntax error at or near "${this.tokText()}" of jsonpath input`);
        }
        continue;
      }
      if (this.isP('[')) {
        this.pos++;
        if (this.isP('*')) {
          this.pos++;
          this.expectP(']');
          node = { t: 'anyarray', base: node };
          continue;
        }
        const subs: { from: Node; to: Node | null }[] = [];
        for (;;) {
          const from = this.additive();
          let to: Node | null = null;
          if (this.isId('to')) {
            this.pos++;
            to = this.additive();
          }
          subs.push({ from, to });
          if (this.isP(',')) {
            this.pos++;
            continue;
          }
          break;
        }
        this.expectP(']');
        node = { t: 'index', base: node, subs };
        continue;
      }
      if (this.isP('?')) {
        this.pos++;
        this.expectP('(');
        const pred = this.orExpr();
        this.expectP(')');
        node = { t: 'filter', base: node, pred };
        continue;
      }
      return node;
    }
  }
}

const parseCache = new Map<string, JsonPath>();

export function parseJsonPath(text: string): JsonPath {
  let p = parseCache.get(text);
  if (!p) {
    p = new PathParser(lex(text)).parse();
    if (parseCache.size > 1000) {
      parseCache.clear();
    }
    parseCache.set(text, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type Bool3 = true | false | null;

class PathError extends Error {
  constructor(readonly pgError: PgError) {
    super(pgError.message);
  }
}

function jpError(code: string, message: string): PathError {
  return new PathError(new PgError(code, message));
}

interface EvalState {
  strict: boolean;
  root: JsonbValue;
  vars: JsonbValue;
  last: number;
}

function isArray(v: JsonbValue): v is JsonbValue[] {
  return Array.isArray(v);
}

function isObject(v: JsonbValue): v is JsonbObject {
  return v instanceof JsonbObject;
}

function objectGet(o: JsonbObject, key: string): JsonbValue | undefined {
  const i = o.keys.indexOf(key);
  return i >= 0 ? o.vals[i] : undefined;
}

function typeName(v: JsonbValue): string {
  if (v === JNULL) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return 'boolean';
  }
  if (v instanceof PgNumeric) {
    return 'number';
  }
  if (typeof v === 'string') {
    return 'string';
  }
  return isArray(v) ? 'array' : 'object';
}

function unwrap(items: JsonbValue[]): JsonbValue[] {
  const out: JsonbValue[] = [];
  for (const it of items) {
    if (isArray(it)) {
      out.push(...it);
    } else {
      out.push(it);
    }
  }
  return out;
}

function evalNode(n: Node, cur: JsonbValue, st: EvalState): JsonbValue[] {
  switch (n.t) {
    case 'root':
      return [st.root];
    case 'current':
      return [cur];
    case 'var': {
      const v = isObject(st.vars) ? objectGet(st.vars, n.name) : undefined;
      if (v === undefined) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `could not find jsonpath variable "${n.name}"`);
      }
      return [v];
    }
    case 'last':
      if (st.last < 0) {
        throw jpError(SqlState.SYNTAX_ERROR, 'evaluating jsonpath LAST outside of array subscript');
      }
      return [PgNumeric.fromInt(st.last)];
    case 'lit':
      return [n.v];
    case 'key': {
      const out: JsonbValue[] = [];
      for (const it of evalNode(n.base, cur, st)) {
        const targets = !st.strict && isArray(it) ? it : [it];
        for (const x of targets) {
          if (isObject(x)) {
            const v = objectGet(x, n.key);
            if (v !== undefined) {
              out.push(v);
            } else if (st.strict) {
              throw jpError('2203A', `JSON object does not contain key "${n.key}"`);
            }
          } else if (st.strict) {
            throw jpError('2203A', 'jsonpath member accessor can only be applied to an object');
          }
        }
      }
      return out;
    }
    case 'anykey': {
      const out: JsonbValue[] = [];
      for (const it of evalNode(n.base, cur, st)) {
        const targets = !st.strict && isArray(it) ? it : [it];
        for (const x of targets) {
          if (isObject(x)) {
            out.push(...x.vals);
          } else if (st.strict) {
            throw jpError('2203C', 'jsonpath wildcard member accessor can only be applied to an object');
          }
        }
      }
      return out;
    }
    case 'anyarray': {
      const out: JsonbValue[] = [];
      for (const it of evalNode(n.base, cur, st)) {
        if (isArray(it)) {
          out.push(...it);
        } else if (st.strict) {
          throw jpError('22039', 'jsonpath wildcard array accessor can only be applied to an array');
        } else {
          out.push(it);
        }
      }
      return out;
    }
    case 'index': {
      const out: JsonbValue[] = [];
      for (const it of evalNode(n.base, cur, st)) {
        const arr: JsonbValue[] = isArray(it) ? it : st.strict ? (() => { throw jpError('22039', 'jsonpath array accessor can only be applied to an array'); })() : [it];
        const saved = st.last;
        st.last = arr.length - 1;
        try {
          for (const s of n.subs) {
            const from = indexValue(s.from, cur, st);
            const to = s.to ? indexValue(s.to, cur, st) : from;
            if (st.strict && (from < 0 || to >= arr.length || from > to)) {
              throw jpError('22033', 'jsonpath array subscript is out of bounds');
            }
            for (let i = Math.max(0, from); i <= Math.min(to, arr.length - 1); i++) {
              out.push(arr[i]);
            }
          }
        } finally {
          st.last = saved;
        }
      }
      return out;
    }
    case 'recursive': {
      const out: JsonbValue[] = [];
      const visit = (v: JsonbValue) => {
        out.push(v);
        if (isArray(v)) {
          v.forEach(visit);
        } else if (isObject(v)) {
          v.vals.forEach(visit);
        }
      };
      for (const it of evalNode(n.base, cur, st)) {
        visit(it);
      }
      return out;
    }
    case 'filter': {
      const out: JsonbValue[] = [];
      let items = evalNode(n.base, cur, st);
      if (!st.strict) {
        items = unwrap(items);
      }
      for (const it of items) {
        if (evalPred(n.pred, it, st) === true) {
          out.push(it);
        }
      }
      return out;
    }
    case 'method':
      return evalMethod(n, cur, st);
    case 'binary':
    case 'unary':
    case 'exists':
    case 'isunknown':
    case 'like':
    case 'startswith': {
      if (n.t === 'binary' && ['+', '-', '*', '/', '%'].includes(n.op)) {
        return [arith(n.op, n.left, n.right, cur, st)];
      }
      if (n.t === 'unary' && (n.op === '+' || n.op === '-')) {
        const vals = evalNode(n.arg, cur, st);
        return (st.strict ? vals : unwrap(vals)).map((v) => {
          if (!(v instanceof PgNumeric)) {
            throw jpError('22038', `operand of unary jsonpath operator ${n.op} is not a numeric value`);
          }
          return n.op === '-' ? PgNumeric.fromInt(0).sub(v) : v;
        });
      }
      const r = evalPred(n, cur, st);
      return [r === null ? JNULL : r];
    }
  }
}

function indexValue(n: Node, cur: JsonbValue, st: EvalState): number {
  const vals = evalNode(n, cur, st);
  if (vals.length !== 1 || !(vals[0] instanceof PgNumeric)) {
    throw jpError('22033', 'jsonpath array subscript is not a single numeric value');
  }
  return Math.trunc((vals[0] as PgNumeric).toNumber());
}

function arith(op: string, l: Node, r: Node, cur: JsonbValue, st: EvalState): JsonbValue {
  const lv = st.strict ? evalNode(l, cur, st) : unwrap(evalNode(l, cur, st));
  const rv = st.strict ? evalNode(r, cur, st) : unwrap(evalNode(r, cur, st));
  if (lv.length !== 1 || !(lv[0] instanceof PgNumeric)) {
    throw jpError('22038', `left operand of jsonpath operator ${op} is not a single numeric value`);
  }
  if (rv.length !== 1 || !(rv[0] instanceof PgNumeric)) {
    throw jpError('22038', `right operand of jsonpath operator ${op} is not a single numeric value`);
  }
  const a = lv[0] as PgNumeric;
  const b = rv[0] as PgNumeric;
  switch (op) {
    case '+':
      return a.add(b);
    case '-':
      return a.sub(b);
    case '*':
      return a.mul(b);
    case '/':
      if (b.isZero()) {
        throw jpError(SqlState.DIVISION_BY_ZERO, 'division by zero');
      }
      return a.div(b);
    default:
      if (b.isZero()) {
        throw jpError(SqlState.DIVISION_BY_ZERO, 'division by zero');
      }
      return a.mod(b);
  }
}

function compareItems(op: string, a: JsonbValue, b: JsonbValue): Bool3 {
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb) {
    if (ta === 'null' || tb === 'null') {
      return op === '!=';
    }
    return null;
  }
  let cmp: number;
  switch (ta) {
    case 'null':
      cmp = 0;
      break;
    case 'boolean':
      cmp = a === b ? 0 : a ? 1 : -1;
      break;
    case 'number':
      cmp = (a as PgNumeric).compare(b as PgNumeric);
      break;
    case 'string':
      cmp = compareUtf8Bytes(a as string, b as string);
      break;
    default:
      return null;
  }
  if (ta === 'null' || ta === 'boolean') {
    if (op !== '==' && op !== '!=') {
      if (ta === 'null') {
        return null;
      }
    }
  }
  switch (op) {
    case '==':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    default:
      return cmp >= 0;
  }
}

function evalPred(n: Node, cur: JsonbValue, st: EvalState): Bool3 {
  switch (n.t) {
    case 'binary': {
      if (n.op === '&&') {
        const l = evalPred(n.left, cur, st);
        if (l === false) {
          return false;
        }
        const r = evalPred(n.right, cur, st);
        return r === false ? false : l === true && r === true ? true : null;
      }
      if (n.op === '||') {
        const l = evalPred(n.left, cur, st);
        if (l === true) {
          return true;
        }
        const r = evalPred(n.right, cur, st);
        return r === true ? true : l === false && r === false ? false : null;
      }
      if (['==', '!=', '<', '<=', '>', '>='].includes(n.op)) {
        let lv: JsonbValue[];
        let rv: JsonbValue[];
        try {
          lv = unwrap(evalNode(n.left, cur, st));
          rv = unwrap(evalNode(n.right, cur, st));
        } catch (e) {
          if (e instanceof PathError) {
            return null;
          }
          throw e;
        }
        let found = false;
        let error = false;
        for (const a of lv) {
          for (const b of rv) {
            const r = compareItems(n.op, a, b);
            if (r === null) {
              if (st.strict) {
                return null;
              }
              error = true;
            } else if (r) {
              if (!st.strict) {
                return true;
              }
              found = true;
            }
          }
        }
        if (found) {
          return true;
        }
        return error ? null : false;
      }
      // arithmetic used as predicate: not boolean
      return null;
    }
    case 'unary':
      if (n.op === '!') {
        const r = evalPred(n.arg, cur, st);
        return r === null ? null : !r;
      }
      return null;
    case 'exists':
      try {
        return evalNode(n.arg, cur, st).length > 0;
      } catch (e) {
        if (e instanceof PathError) {
          return null;
        }
        throw e;
      }
    case 'isunknown':
      return evalPred(n.arg, cur, st) === null;
    case 'like': {
      let vals: JsonbValue[];
      try {
        vals = unwrap(evalNode(n.arg, cur, st));
      } catch (e) {
        if (e instanceof PathError) {
          return null;
        }
        throw e;
      }
      let flags = 'u';
      if (n.flags.includes('i')) {
        flags += 'i';
      }
      if (n.flags.includes('s')) {
        flags += 's';
      }
      if (n.flags.includes('m')) {
        flags += 'm';
      }
      const pattern = n.flags.includes('q') ? n.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : n.pattern;
      const re = new RegExp(pattern, flags);
      let error = false;
      for (const v of vals) {
        if (typeof v !== 'string') {
          error = true;
          continue;
        }
        if (re.test(v)) {
          return true;
        }
      }
      return error ? null : false;
    }
    case 'startswith': {
      let vals: JsonbValue[];
      let prefix: JsonbValue[];
      try {
        vals = unwrap(evalNode(n.arg, cur, st));
        prefix = evalNode(n.prefix, cur, st);
      } catch (e) {
        if (e instanceof PathError) {
          return null;
        }
        throw e;
      }
      if (prefix.length !== 1 || typeof prefix[0] !== 'string') {
        return null;
      }
      let error = false;
      for (const v of vals) {
        if (typeof v !== 'string') {
          error = true;
          continue;
        }
        if (v.startsWith(prefix[0] as string)) {
          return true;
        }
      }
      return error ? null : false;
    }
    default: {
      // a non-predicate expression in a filter: true when it yields a boolean true
      const vals = evalNode(n, cur, st);
      if (vals.length === 1 && typeof vals[0] === 'boolean') {
        return vals[0];
      }
      return null;
    }
  }
}

function evalMethod(n: Extract<Node, { t: 'method' }>, cur: JsonbValue, st: EvalState): JsonbValue[] {
  const items = evalNode(n.base, cur, st);
  const out: JsonbValue[] = [];
  const each = n.name === 'size' || n.name === 'type' ? items : st.strict ? items : unwrap(items);
  for (const it of each) {
    switch (n.name) {
      case 'type':
        out.push(typeName(it));
        break;
      case 'size':
        if (isArray(it)) {
          out.push(PgNumeric.fromInt(it.length));
        } else if (st.strict) {
          throw jpError('22039', `jsonpath item method .size() can only be applied to an array`);
        } else {
          out.push(PgNumeric.fromInt(1));
        }
        break;
      case 'abs':
      case 'floor':
      case 'ceiling':
        if (!(it instanceof PgNumeric)) {
          throw jpError('22038', `jsonpath item method .${n.name}() can only be applied to a numeric value`);
        }
        out.push(n.name === 'abs' ? it.abs() : n.name === 'floor' ? it.floor() : it.ceil());
        break;
      case 'double':
      case 'number':
        if (it instanceof PgNumeric) {
          out.push(it);
        } else if (typeof it === 'string') {
          try {
            out.push(PgNumeric.parse(it.trim()));
          } catch {
            throw jpError('22038', `argument "${it}" of jsonpath item method .${n.name}() is invalid for type ${n.name === 'double' ? 'double precision' : 'numeric'}`);
          }
        } else {
          throw jpError('22038', `jsonpath item method .${n.name}() can only be applied to a string or numeric value`);
        }
        break;
      case 'string':
        if (typeof it === 'string') {
          out.push(it);
        } else if (it instanceof PgNumeric) {
          out.push(it.toString());
        } else if (typeof it === 'boolean') {
          out.push(it ? 'true' : 'false');
        } else {
          throw jpError('22038', 'jsonpath item method .string() can only be applied to a boolean, string, numeric, or datetime value');
        }
        break;
      case 'boolean':
        if (typeof it === 'boolean') {
          out.push(it);
        } else if (typeof it === 'string' && /^(t|true|f|false|y|yes|n|no|on|off|1|0)$/i.test(it.trim())) {
          out.push(/^(t|true|y|yes|on|1)$/i.test(it.trim()));
        } else if (it instanceof PgNumeric) {
          out.push(!it.isZero());
        } else {
          throw jpError('22038', 'jsonpath item method .boolean() can only be applied to a boolean, string, or numeric value');
        }
        break;
      case 'keyvalue':
        if (isObject(it)) {
          it.keys.forEach((k, i) => out.push(JsonbObject.fromPairs([['id', PgNumeric.fromInt(0)], ['key', k], ['value', it.vals[i]]])));
        } else if (st.strict || !isArray(it)) {
          throw jpError('22039', 'jsonpath item method .keyvalue() can only be applied to an object');
        }
        break;
      default:
        throw syntaxError(`syntax error at or near "${n.name}" of jsonpath input`);
    }
  }
  return out;
}

export interface PathResult {
  items: JsonbValue[] | null;
}

/** Evaluate a path; returns null items when an error was suppressed (silent). */
export function executeJsonPath(path: JsonPath, target: JsonbValue, vars: JsonbValue, silent: boolean): JsonbValue[] | null {
  const st: EvalState = { strict: path.strict, root: target, vars, last: -1 };
  try {
    return evalNode(path.expr, target, st);
  } catch (e) {
    if (e instanceof PathError) {
      if (silent) {
        return null;
      }
      throw e.pgError;
    }
    throw e;
  }
}
