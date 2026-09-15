// Numeric to_char / to_number, following PostgreSQL's formatting.c (NUM_processor & friends).
import { PgError, SqlState } from '../errors';
import { PgNumeric } from './numeric';

type NumKey = ',' | '.' | '0' | '9' | 'B' | 'C' | 'D' | 'EEEE' | 'FM' | 'G' | 'L' | 'MI' | 'PL' | 'PR' | 'RN' | 'SG' | 'SP' | 'S' | 'TH' | 'V';

// Keyword table in PostgreSQL's order: the first prefix match wins ("SG"/"SP" before "S").
const KEYWORDS: [string, NumKey][] = [
  [',', ','], ['.', '.'], ['0', '0'], ['9', '9'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['EEEE', 'EEEE'], ['FM', 'FM'],
  ['G', 'G'], ['L', 'L'], ['MI', 'MI'], ['PL', 'PL'], ['PR', 'PR'], ['RN', 'RN'], ['SG', 'SG'], ['SP', 'SP'], ['S', 'S'],
  ['TH', 'TH'], ['V', 'V'],
  ['b', 'B'], ['c', 'C'], ['d', 'D'], ['eeee', 'EEEE'], ['fm', 'FM'], ['g', 'G'], ['l', 'L'], ['mi', 'MI'], ['pl', 'PL'],
  ['pr', 'PR'], ['rn', 'RN'], ['sg', 'SG'], ['sp', 'SP'], ['s', 'S'], ['th', 'TH'], ['v', 'V'],
];

type FormatNode = { action: NumKey } | { char: string };

interface NumDesc {
  pre: number;
  post: number;
  lsign: 'none' | 'pre' | 'post';
  preLsignNum: number;
  zeroStart: number;
  zeroEnd: number;
  decimal: boolean;
  zero: boolean;
  fillmode: boolean;
  lsignFlag: boolean;
  bracket: boolean;
  minus: boolean;
  plus: boolean;
}

function syntaxError(msg: string): PgError {
  return new PgError(SqlState.SYNTAX_ERROR, msg);
}

function prepare(num: NumDesc, key: NumKey): void {
  switch (key) {
    case '9':
      if (num.bracket) {
        throw syntaxError('"9" must be ahead of "PR"');
      }
      if (num.decimal) {
        num.post++;
      } else {
        num.pre++;
      }
      break;
    case '0':
      if (num.bracket) {
        throw syntaxError('"0" must be ahead of "PR"');
      }
      if (!num.zero && !num.decimal) {
        num.zero = true;
        num.zeroStart = num.pre + 1;
      }
      if (!num.decimal) {
        num.pre++;
      } else {
        num.post++;
      }
      num.zeroEnd = num.pre + num.post;
      break;
    case 'D':
    case '.':
      if (num.decimal) {
        throw syntaxError('multiple decimal points');
      }
      num.decimal = true;
      break;
    case 'FM':
      num.fillmode = true;
      break;
    case 'S':
      if (num.lsignFlag) {
        throw syntaxError('cannot use "S" twice');
      }
      if (num.plus || num.minus || num.bracket) {
        throw syntaxError('cannot use "S" and "PL"/"MI"/"SG"/"PR" together');
      }
      if (!num.decimal) {
        num.lsign = 'pre';
        num.preLsignNum = num.pre;
        num.lsignFlag = true;
      } else if (num.lsign === 'none') {
        num.lsign = 'post';
        num.lsignFlag = true;
      }
      break;
    case 'MI':
      if (num.lsignFlag) {
        throw syntaxError('cannot use "S" and "MI" together');
      }
      num.minus = true;
      break;
    case 'PL':
      if (num.lsignFlag) {
        throw syntaxError('cannot use "S" and "PL" together');
      }
      num.plus = true;
      break;
    case 'SG':
      if (num.lsignFlag) {
        throw syntaxError('cannot use "S" and "SG" together');
      }
      num.minus = true;
      num.plus = true;
      break;
    case 'PR':
      if (num.lsignFlag || num.plus || num.minus) {
        throw syntaxError('cannot use "PR" and "S"/"PL"/"MI"/"SG" together');
      }
      num.bracket = true;
      break;
    case 'RN':
    case 'EEEE':
    case 'V':
    case 'TH':
    case 'L':
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: number format pattern "${key}" is not implemented`);
    default:
      break;
  }
}

function parseFormat(fmt: string): { nodes: FormatNode[]; num: NumDesc } {
  const num: NumDesc = {
    pre: 0, post: 0, lsign: 'none', preLsignNum: 0, zeroStart: 0, zeroEnd: 0,
    decimal: false, zero: false, fillmode: false, lsignFlag: false, bracket: false, minus: false, plus: false,
  };
  const nodes: FormatNode[] = [];
  const chars = Array.from(fmt);
  let i = 0;
  const offsetOf = (idx: number): number => chars.slice(0, idx).join('').length;
  while (i < chars.length) {
    const offset = offsetOf(i);
    const kw = KEYWORDS.find(([name]) => fmt.startsWith(name, offset));
    if (kw) {
      nodes.push({ action: kw[1] });
      prepare(num, kw[1]);
      i += kw[0].length;
      continue;
    }
    if (chars[i] === '"') {
      i++;
      while (i < chars.length) {
        if (chars[i] === '"') {
          i++;
          break;
        }
        if (chars[i] === '\\' && i + 1 < chars.length) {
          i++;
        }
        nodes.push({ char: chars[i] });
        i++;
      }
      continue;
    }
    if (chars[i] === '\\' && chars[i + 1] === '"') {
      i++;
    }
    nodes.push({ char: chars[i] });
    i++;
  }
  return { nodes, num };
}

/** Last significant fraction digit of a plain decimal string (get_last_relevant_decnum). */
function lastRelevantDecnum(num: string): number {
  const p = num.indexOf('.');
  if (p < 0) {
    return -1;
  }
  let result = p;
  for (let i = p + 1; i < num.length; i++) {
    if (num[i] !== '0') {
      result = i;
    }
  }
  return result;
}

function toCharProcess(nodes: FormatNode[], num: NumDesc, number: string, outPreSpaces: number, sign: '+' | '-'): string {
  let out = '';
  let signWrote: boolean;
  let lastRelevant = -1;
  let numIn = false;
  let numCurr = 0;
  let p = 0; // index into number
  if (num.zeroStart) {
    num.zeroStart--;
  }
  if (num.plus || num.minus) {
    signWrote = !(num.plus && !num.minus);
  } else {
    if (sign !== '-' && num.fillmode) {
      num.bracket = false;
    }
    signWrote = sign === '+' && num.fillmode && !num.lsignFlag;
    if (num.lsign === 'pre' && num.pre === num.preLsignNum) {
      num.lsign = 'post';
    }
  }
  let numCount = num.post + num.pre - 1;
  if (num.fillmode && num.decimal) {
    lastRelevant = lastRelevantDecnum(number);
    if (lastRelevant >= 0 && num.zeroEnd > outPreSpaces) {
      const lastZeroPos = Math.min(number.length - 1, num.zeroEnd - outPreSpaces);
      if (lastRelevant < lastZeroPos) {
        lastRelevant = lastZeroPos;
      }
    }
  }
  if (!signWrote && outPreSpaces === 0) {
    numCount++;
  }
  const at = (i: number): string => (i < number.length ? number[i] : '\0');
  const predecSpace = (): boolean => !num.zero && p === 0 && number[0] === '0' && num.post !== 0;

  const numpart = (id: NumKey): void => {
    if (!signWrote &&
      (numCurr >= outPreSpaces || (num.zero && num.zeroStart === numCurr)) &&
      (!predecSpace() || (lastRelevant >= 0 && at(lastRelevant) === '.'))) {
      if (num.lsignFlag) {
        if (num.lsign === 'pre') {
          out += sign === '-' ? '-' : '+';
          signWrote = true;
        }
      } else if (num.bracket) {
        out += sign === '+' ? ' ' : '<';
        signWrote = true;
      } else if (sign === '+') {
        if (!num.fillmode) {
          out += ' ';
        }
        signWrote = true;
      } else {
        out += '-';
        signWrote = true;
      }
    }
    if (numCurr < outPreSpaces && (num.zeroStart > numCurr || !num.zero)) {
      if (!num.fillmode) {
        out += ' ';
      }
    } else if (num.zero && numCurr < outPreSpaces && num.zeroStart <= numCurr) {
      out += '0';
      numIn = true;
    } else {
      if (at(p) === '.') {
        if (lastRelevant < 0 || at(lastRelevant) !== '.') {
          out += '.';
        } else if (num.fillmode) {
          out += '.';
        }
      } else if (lastRelevant >= 0 && p > lastRelevant && id !== '0') {
        // trailing insignificant digit in fill mode
      } else if (predecSpace()) {
        if (!num.fillmode) {
          out += ' ';
        } else if (lastRelevant >= 0 && at(lastRelevant) === '.') {
          out += '0';
        }
      } else {
        out += at(p);
        numIn = true;
      }
      if (p < number.length) {
        p++;
      }
    }
    let end = numCount + (outPreSpaces ? 1 : 0) + (num.decimal ? 1 : 0);
    if (lastRelevant >= 0 && lastRelevant === p) {
      end = numCurr;
    }
    if (numCurr + 1 === end) {
      if (signWrote && num.bracket) {
        out += sign === '+' ? ' ' : '>';
      } else if (num.lsignFlag && num.lsign === 'post') {
        out += sign === '-' ? '-' : '+';
      }
    }
    numCurr++;
  };

  for (const n of nodes) {
    if (!('action' in n)) {
      out += n.char;
      continue;
    }
    switch (n.action) {
      case '9':
      case '0':
      case '.':
      case 'D':
        numpart(n.action);
        break;
      case ',':
      case 'G':
        if (!numIn) {
          if (!num.fillmode) {
            out += ' ';
          }
        } else {
          out += ',';
        }
        break;
      case 'MI':
        if (sign === '-') {
          out += '-';
        } else if (!num.fillmode) {
          out += ' ';
        }
        break;
      case 'PL':
        if (sign === '+') {
          out += '+';
        } else if (!num.fillmode) {
          out += ' ';
        }
        break;
      case 'SG':
        out += sign;
        break;
      default:
        break;
    }
  }
  // a digit slot past the end of the number writes the C string terminator
  const nul = out.indexOf('\0');
  return nul < 0 ? out : out.slice(0, nul);
}

function finishToChar(fmt: string, digits: string, sign: '+' | '-', num: NumDesc, nodes: FormatNode[]): string {
  let numstr = digits;
  const dot = numstr.indexOf('.');
  const preLen = dot >= 0 ? dot : numstr.length;
  let outPreSpaces = 0;
  if (preLen < num.pre) {
    outPreSpaces = num.pre - preLen;
  } else if (preLen > num.pre) {
    numstr = '#'.repeat(num.pre) + '.' + '#'.repeat(num.post);
  }
  void fmt;
  return toCharProcess(nodes, num, numstr, outPreSpaces, sign);
}

export function numericToChar(value: PgNumeric, fmt: string): string {
  const { nodes, num } = parseFormat(fmt);
  const orgnum = value.round(num.post).toString();
  const sign = orgnum.startsWith('-') ? '-' : '+';
  return finishToChar(fmt, sign === '-' ? orgnum.slice(1) : orgnum, sign, num, nodes);
}

export function intToChar(value: bigint | number, fmt: string): string {
  const { nodes, num } = parseFormat(fmt);
  let orgnum = String(value);
  const sign = orgnum.startsWith('-') ? '-' : '+';
  if (sign === '-') {
    orgnum = orgnum.slice(1);
  }
  const preLen = orgnum.length;
  let numstr = num.post ? orgnum + '.' + '0'.repeat(num.post) : orgnum;
  let outPreSpaces = 0;
  if (preLen < num.pre) {
    outPreSpaces = num.pre - preLen;
  } else if (preLen > num.pre) {
    numstr = '#'.repeat(num.pre) + '.' + '#'.repeat(num.post);
  }
  return toCharProcess(nodes, num, numstr, outPreSpaces, sign);
}

/** C printf("%.*f"): the exact binary value rounded half-to-even (JS toFixed rounds ties away from zero). */
function printfFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf';
  }
  const neg = value < 0 || Object.is(value, -0);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(value));
  const bits = buf.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  let e: number;
  if (exp === 0) {
    e = -1074;
  } else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  // value = mant * 2^e = num / 10^scale
  let num: bigint;
  let scale: number;
  if (e >= 0) {
    num = mant << BigInt(e);
    scale = 0;
  } else {
    num = mant * 5n ** BigInt(-e);
    scale = -e;
  }
  let q: bigint;
  if (scale <= digits) {
    q = num * 10n ** BigInt(digits - scale);
  } else {
    const div = 10n ** BigInt(scale - digits);
    q = num / div;
    const rem = (num % div) * 2n;
    if (rem > div || (rem === div && q % 2n === 1n)) {
      q++;
    }
  }
  let s = q.toString().padStart(digits + 1, '0');
  if (digits > 0) {
    s = s.slice(0, s.length - digits) + '.' + s.slice(s.length - digits);
  }
  return (neg ? '-' : '') + s;
}

const DBL_DIG = 15;
const FLT_DIG = 6;

export function floatToChar(value: number, fmt: string, isFloat4: boolean): string {
  const { nodes, num } = parseFormat(fmt);
  const maxDig = isFloat4 ? FLT_DIG : DBL_DIG;
  const preLen0 = printfFixed(Math.abs(value), 0).length;
  if (preLen0 >= maxDig) {
    num.post = 0;
  } else if (preLen0 + num.post > maxDig) {
    num.post = maxDig - preLen0;
  }
  const orgnum = printfFixed(value, num.post);
  const sign = orgnum.startsWith('-') ? '-' : '+';
  return finishToChar(fmt, orgnum.startsWith('-') ? orgnum.slice(1) : orgnum, sign, num, nodes);
}

export function numericToNumber(input: string, fmt: string): PgNumeric | null {
  if (fmt.length === 0) {
    return null;
  }
  const { nodes, num } = parseFormat(fmt);
  const inout = input;
  const len = inout.length;
  let ip = 0;
  let signCh = ' ';
  let digits = '';
  let readPre = 0;
  let readPost = 0;
  let readDec = false;
  let numIn = false;
  const overload = (): boolean => ip >= len;
  const amount = (s: number): boolean => ip <= len - s;
  const eatNonData = (): void => {
    if (!overload() && !'0123456789.,+-'.includes(inout[ip])) {
      ip++;
    }
  };
  const numpartFromChar = (id: NumKey): void => {
    if (overload()) {
      return;
    }
    if (inout[ip] === ' ') {
      ip++;
    }
    if (overload()) {
      return;
    }
    if (signCh === ' ' && (id === '0' || id === '9') && readPre + readPost === 0) {
      if (num.lsignFlag && num.lsign === 'pre') {
        if (amount(1) && inout[ip] === '-') {
          ip++;
          signCh = '-';
        } else if (amount(1) && inout[ip] === '+') {
          ip++;
          signCh = '+';
        }
      } else if (inout[ip] === '-' || (num.bracket && inout[ip] === '<')) {
        signCh = '-';
        ip++;
      } else if (inout[ip] === '+') {
        signCh = '+';
        ip++;
      }
    }
    if (overload()) {
      return;
    }
    let isread = false;
    if (inout[ip] >= '0' && inout[ip] <= '9') {
      if (readDec && readPost === num.post) {
        return;
      }
      digits += inout[ip];
      if (readDec) {
        readPost++;
      } else {
        readPre++;
      }
      isread = true;
      numIn = true;
    } else if (num.decimal && !readDec) {
      if (amount(1) && inout[ip] === '.') {
        digits += '.';
        readDec = true;
        isread = true;
      }
    }
    if (overload()) {
      return;
    }
    if (signCh === ' ' && readPre + readPost > 0) {
      if (num.lsignFlag && isread && ip + 1 < len && !(inout[ip + 1] >= '0' && inout[ip + 1] <= '9')) {
        const tmp = ip++;
        if (amount(1) && inout[ip] === '-') {
          signCh = '-';
        } else if (amount(1) && inout[ip] === '+') {
          signCh = '+';
        }
        if (signCh === ' ') {
          ip = tmp;
        }
      } else if (!isread && !num.lsignFlag && (num.plus || num.minus)) {
        if (inout[ip] === '-' || inout[ip] === '+') {
          signCh = inout[ip];
        }
      }
    }
  };

  for (const n of nodes) {
    if (overload()) {
      break;
    }
    if (!('action' in n)) {
      ip++;
      continue;
    }
    switch (n.action) {
      case '9':
      case '0':
      case '.':
      case 'D':
        numpartFromChar(n.action);
        break;
      case ',':
        if ((!numIn && num.fillmode) || inout[ip] !== ',') {
          continue;
        }
        break;
      case 'G':
        if (!numIn && num.fillmode) {
          continue;
        }
        if (!(amount(1) && inout[ip] === ',')) {
          continue;
        }
        break;
      case 'MI':
        if (inout[ip] === '-') {
          signCh = '-';
        } else {
          eatNonData();
          continue;
        }
        break;
      case 'PL':
        if (inout[ip] === '+') {
          signCh = '+';
        } else {
          eatNonData();
          continue;
        }
        break;
      case 'SG':
        if (inout[ip] === '-' || inout[ip] === '+') {
          signCh = inout[ip];
        } else {
          eatNonData();
          continue;
        }
        break;
      default:
        continue;
    }
    ip++;
  }
  if (digits.endsWith('.')) {
    digits = digits.slice(0, -1);
  }
  const precision = num.pre + readPost;
  const text = signCh + digits;
  const parsed = PgNumeric.parse(text);
  return parsed.applyTypmod(((precision << 16) | readPost) + 4);
}
