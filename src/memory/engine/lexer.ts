import { PgError, SqlState, syntaxError } from './errors';

/**
 * PostgreSQL lexer (mirrors src/backend/parser/scan.l).
 *
 * Produces a flat token array; the parser works with a cursor over it.
 */
export type TokenType =
  | 'ident' // identifier or keyword (see `quoted`)
  | 'string' // string constant (all forms, value already decoded)
  | 'bitstring' // B'..' / X'..' (value keeps the leading b/x marker)
  | 'integer'
  | 'numeric' // decimal or real literal
  | 'param' // $n
  | 'op' // operator
  | 'punct' // , ( ) [ ] . ; : :: .. := =>
  | 'eof';

export interface Token {
  type: TokenType;
  /** Decoded value: folded identifier name, string contents, operator text, ... */
  value: string;
  /** Upper-cased text for unquoted identifiers (keyword matching); '' otherwise. */
  kw: string;
  quoted: boolean;
  pos: number;
  end: number;
}

const SELF_CHARS = ',()[].;:+-*/%^<>=';
const OP_CHARS = '~!@#^&|`?+-*/%<>=';

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch >= 128;
}

function isIdentCont(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57) || ch === 36;
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 11;
}

/** Lower-case ASCII letters only (PostgreSQL's downcase_identifier for UTF8). */
export function downcaseIdentifier(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  const push = (type: TokenType, value: string, pos: number, end: number, quoted = false, kw = '') => {
    tokens.push({ type, value, pos, end, quoted, kw });
  };

  while (i < n) {
    const ch = sql.charCodeAt(i);

    if (isSpace(ch)) {
      i++;
      continue;
    }

    // -- comment
    if (ch === 45 && sql.charCodeAt(i + 1) === 45) {
      i += 2;
      while (i < n && sql.charCodeAt(i) !== 10 && sql.charCodeAt(i) !== 13) {
        i++;
      }
      continue;
    }

    // /* nested comment */
    if (ch === 47 && sql.charCodeAt(i + 1) === 42) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.charCodeAt(i) === 47 && sql.charCodeAt(i + 1) === 42) {
          depth++;
          i += 2;
        } else if (sql.charCodeAt(i) === 42 && sql.charCodeAt(i + 1) === 47) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) {
        throw syntaxError(`unterminated /* comment at or near "${sql.slice(start)}"`, start);
      }
      continue;
    }

    const start = i;

    // String constants with prefixes: E'..', B'..', X'..', N'..', U&'..'
    if ((ch === 69 || ch === 101) && sql.charCodeAt(i + 1) === 39) {
      const [value, next] = readQuoted(sql, i + 1, true);
      i = continueString(sql, next, tokens, start, value, true);
      continue;
    }
    if ((ch === 66 || ch === 98 || ch === 88 || ch === 120) && sql.charCodeAt(i + 1) === 39) {
      const [value, next] = readQuoted(sql, i + 1, false);
      const marker = ch === 66 || ch === 98 ? 'b' : 'x';
      push('bitstring', marker + value, start, next);
      i = next;
      continue;
    }
    if ((ch === 78 || ch === 110) && sql.charCodeAt(i + 1) === 39) {
      const [value, next] = readQuoted(sql, i + 1, false);
      i = continueString(sql, next, tokens, start, value, false);
      continue;
    }
    if ((ch === 85 || ch === 117) && sql.charCodeAt(i + 1) === 38 && (sql.charCodeAt(i + 2) === 39 || sql.charCodeAt(i + 2) === 34)) {
      const isIdent = sql.charCodeAt(i + 2) === 34;
      const [raw, next] = isIdent ? readQuotedIdent(sql, i + 2) : readQuoted(sql, i + 2, false);
      let end = next;
      let escape = '\\';
      // optional UESCAPE 'c'
      const m = /^\s*UESCAPE\s*'([^'])'/i.exec(sql.slice(end));
      if (m) {
        escape = m[1];
        end += m[0].length;
      }
      const value = decodeUnicodeEscapes(raw, escape, start);
      if (isIdent) {
        push('ident', value, start, end, true);
      } else {
        push('string', value, start, end);
      }
      i = end;
      continue;
    }

    if (ch === 39) {
      const [value, next] = readQuoted(sql, i, false);
      i = continueString(sql, next, tokens, start, value, false);
      continue;
    }

    if (ch === 34) {
      const [value, next] = readQuotedIdent(sql, i);
      if (value.length === 0) {
        throw syntaxError('zero-length delimited identifier', start);
      }
      push('ident', value, start, next, true);
      i = next;
      continue;
    }

    // Dollar: parameter or dollar-quoted string
    if (ch === 36) {
      if (isDigit(sql.charCodeAt(i + 1))) {
        let j = i + 1;
        while (j < n && isDigit(sql.charCodeAt(j))) {
          j++;
        }
        if (j < n && isIdentCont(sql.charCodeAt(j))) {
          throw syntaxError('trailing junk after parameter', start);
        }
        push('param', sql.slice(i + 1, j), start, j);
        i = j;
        continue;
      }
      // $tag$ ... $tag$
      let j = i + 1;
      if (j < n && isIdentStart(sql.charCodeAt(j))) {
        j++;
        while (j < n && isIdentCont(sql.charCodeAt(j)) && sql.charCodeAt(j) !== 36) {
          j++;
        }
      }
      if (sql.charCodeAt(j) === 36) {
        const tag = sql.slice(i, j + 1);
        const bodyStart = j + 1;
        const close = sql.indexOf(tag, bodyStart);
        if (close < 0) {
          throw syntaxError(`unterminated dollar-quoted string at or near "${sql.slice(start)}"`, start);
        }
        push('string', sql.slice(bodyStart, close), start, close + tag.length);
        i = close + tag.length;
        continue;
      }
      throw syntaxError('syntax error at or near "$"', start);
    }

    // Numbers
    if (isDigit(ch) || (ch === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      i = readNumber(sql, i, tokens);
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentCont(sql.charCodeAt(j))) {
        j++;
      }
      const raw = sql.slice(i, j);
      push('ident', downcaseIdentifier(raw), start, j, false, raw.toUpperCase());
      i = j;
      continue;
    }

    // Punctuation with special multi-char forms
    if (ch === 58) {
      if (sql.charCodeAt(i + 1) === 58) {
        push('punct', '::', start, i + 2);
        i += 2;
        continue;
      }
      if (sql.charCodeAt(i + 1) === 61) {
        push('punct', ':=', start, i + 2);
        i += 2;
        continue;
      }
      push('punct', ':', start, i + 1);
      i++;
      continue;
    }
    if (ch === 46) {
      if (sql.charCodeAt(i + 1) === 46) {
        push('punct', '..', start, i + 2);
        i += 2;
        continue;
      }
      push('punct', '.', start, i + 1);
      i++;
      continue;
    }
    if (ch === 44 || ch === 40 || ch === 41 || ch === 91 || ch === 93 || ch === 59) {
      push('punct', sql[i], start, i + 1);
      i++;
      continue;
    }

    // Operators
    if (OP_CHARS.indexOf(sql[i]) >= 0) {
      let j = i;
      while (j < n && OP_CHARS.indexOf(sql[j]) >= 0) {
        j++;
      }
      let text = sql.slice(i, j);
      let nchars = text.length;
      const slashstar = text.indexOf('/*');
      const dashdash = text.indexOf('--');
      if (slashstar >= 0 && dashdash >= 0) {
        nchars = Math.min(slashstar, dashdash);
      } else if (slashstar >= 0) {
        nchars = slashstar;
      } else if (dashdash >= 0) {
        nchars = dashdash;
      }
      if (nchars > 1 && (text[nchars - 1] === '+' || text[nchars - 1] === '-')) {
        let ic = nchars - 2;
        for (; ic >= 0; ic--) {
          const c = text[ic];
          if (c === '~' || c === '!' || c === '@' || c === '#' || c === '^' || c === '&' || c === '|' || c === '`' || c === '?' || c === '%') {
            break;
          }
        }
        if (ic < 0) {
          do {
            nchars--;
          } while (nchars > 1 && (text[nchars - 1] === '+' || text[nchars - 1] === '-'));
        }
      }
      text = text.slice(0, nchars);
      if (nchars === 0) {
        // "/*" or "--" at operator start is a comment; handled above, but guard anyway
        throw syntaxError(`syntax error at or near "${sql[i]}"`, start);
      }
      if (nchars === 2 && text === '=>') {
        push('punct', '=>', start, i + 2);
      } else if (nchars === 2 && text === '!=') {
        push('op', '<>', start, i + 2);
      } else {
        push('op', text, start, i + nchars);
      }
      i += nchars;
      continue;
    }

    throw syntaxError(`syntax error at or near "${sql[i]}"`, start);
  }

  tokens.push({ type: 'eof', value: '', pos: n, end: n, quoted: false, kw: '' });
  return tokens;
}

/** Read a '...' literal starting at the opening quote. Returns [decoded value, index after closing quote]. */
function readQuoted(sql: string, quotePos: number, escapes: boolean): [string, number] {
  let i = quotePos + 1;
  const n = sql.length;
  let out = '';
  while (true) {
    if (i >= n) {
      // scanner_yyerror: the rest of the input is the offending token
      throw syntaxError(`unterminated quoted string at or near "${sql.slice(quotePos)}"`, quotePos);
    }
    const c = sql[i];
    if (c === "'") {
      if (sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    if (escapes && c === '\\') {
      const d = sql[i + 1];
      i += 2;
      switch (d) {
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'x': {
          const m = /^[0-9A-Fa-f]{1,2}/.exec(sql.slice(i));
          if (m) {
            out += String.fromCharCode(parseInt(m[0], 16));
            i += m[0].length;
          } else {
            out += 'x';
          }
          break;
        }
        case 'u':
        case 'U': {
          const len = d === 'u' ? 4 : 8;
          const hex = sql.slice(i, i + len);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) {
            throw new PgError(SqlState.INVALID_ESCAPE_SEQUENCE, 'invalid Unicode escape', { hint: 'Unicode escapes must be \\uXXXX or \\UXXXXXXXX.' });
          }
          out += String.fromCodePoint(parseInt(hex, 16));
          i += len;
          break;
        }
        default:
          if (d !== undefined && d >= '0' && d <= '7') {
            const m = /^[0-7]{1,3}/.exec(sql.slice(i - 1));
            out += String.fromCharCode(parseInt(m![0], 8) & 0xff);
            i += m![0].length - 1;
          } else if (d !== undefined) {
            out += d;
          }
      }
      continue;
    }
    out += c;
    i++;
  }
}

function readQuotedIdent(sql: string, quotePos: number): [string, number] {
  let i = quotePos + 1;
  let out = '';
  while (true) {
    if (i >= sql.length) {
      throw syntaxError(`unterminated quoted identifier at or near "${sql.slice(quotePos)}"`, quotePos);
    }
    if (sql[i] === '"') {
      if (sql[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += sql[i];
    i++;
  }
}

/** Adjacent string literals separated by whitespace containing a newline are concatenated. */
function continueString(sql: string, next: number, tokens: Token[], start: number, value: string, escapes: boolean): number {
  let i = next;
  while (true) {
    let j = i;
    let sawNewline = false;
    while (j < sql.length && isSpace(sql.charCodeAt(j))) {
      if (sql[j] === '\n' || sql[j] === '\r') {
        sawNewline = true;
      }
      j++;
    }
    if (sawNewline && sql[j] === "'") {
      const [more, after] = readQuoted(sql, j, escapes);
      value += more;
      i = after;
      continue;
    }
    break;
  }
  tokens.push({ type: 'string', value, pos: start, end: i, quoted: false, kw: '' });
  return i;
}

function decodeUnicodeEscapes(raw: string, escape: string, pos: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== escape) {
      out += raw[i];
      continue;
    }
    if (raw[i + 1] === escape) {
      out += escape;
      i++;
      continue;
    }
    if (raw[i + 1] === '+') {
      const hex = raw.slice(i + 2, i + 8);
      if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
        throw syntaxError('invalid Unicode escape', pos);
      }
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 7;
      continue;
    }
    const hex = raw.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
      throw syntaxError('invalid Unicode escape', pos);
    }
    out += String.fromCodePoint(parseInt(hex, 16));
    i += 4;
  }
  return out;
}

function readNumber(sql: string, i: number, tokens: Token[]): number {
  const start = i;
  const n = sql.length;
  const rest = sql.slice(i);
  let m: RegExpExecArray | null;

  // hex / octal / binary integers
  if ((m = /^0[xX](_?[0-9A-Fa-f])+/.exec(rest)) || (m = /^0[oO](_?[0-7])+/.exec(rest)) || (m = /^0[bB](_?[01])+/.exec(rest))) {
    const text = m[0].replace(/_/g, '');
    const end = i + m[0].length;
    checkTrailingJunk(sql, end, start);
    const radix = text[1] === 'x' || text[1] === 'X' ? 16 : text[1] === 'o' || text[1] === 'O' ? 8 : 2;
    const value = BigInt(radix === 16 ? '0x' + text.slice(2) : radix === 8 ? '0o' + text.slice(2) : '0b' + text.slice(2)).toString();
    tokens.push({ type: 'integer', value, pos: start, end, quoted: false, kw: '' });
    return end;
  }

  m = /^(?:\d(?:_?\d)*(?:\.(?!\.)(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[Ee][-+]?\d(?:_?\d)*)?/.exec(rest);
  if (!m) {
    throw syntaxError('syntax error', start);
  }
  let text = m[0];
  let end = i + text.length;
  // "1e" without digits: PG lexes the number then errors on trailing junk
  checkTrailingJunk(sql, end, start);
  text = text.replace(/_/g, '');
  const isInteger = /^\d+$/.test(text);
  tokens.push({ type: isInteger ? 'integer' : 'numeric', value: text, pos: start, end, quoted: false, kw: '' });
  void n;
  return end;
}

function checkTrailingJunk(sql: string, end: number, start: number): void {
  if (end < sql.length && isIdentStart(sql.charCodeAt(end))) {
    throw syntaxError(`trailing junk after numeric literal at or near "${sql.slice(start, end + 1)}"`, start);
  }
}
