import * as A from '../ast';
import { Catalog, ProcDef, Relation, TriggerDef, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { EvalCtx, StatementState, TransitionCapture, TransitionTable } from '../exec/runtime';
import { Token, tokenize } from '../lexer';
import type { FieldInfo, Session, StatementResult } from '../session';
import type { UndoLog } from '../storage/mvcc';
import { PgRecord } from '../types/values';
import { inputValue, outputValue } from '../types/io';

/**
 * SQL-language and PL/pgSQL function execution.
 */

// ---------------------------------------------------------------------------
// SQL functions
// ---------------------------------------------------------------------------

function nestedState(session: Session, parent: StatementState, args: unknown[], argTypes: number[], names: string[], fname: string): StatementState {
  const st = new StatementState(session, session.catalog(), args, argTypes, parent.snapshot);
  st.paramNames = names;
  st.functionName = fname;
  st.undo = parent.undo;
  st.depth = parent.depth + 1;
  if (st.depth > 100) {
    throw new PgError(SqlState.STATEMENT_TOO_COMPLEX, 'stack depth limit exceeded', { hint: 'Increase the configuration parameter "max_stack_depth".' });
  }
  return st;
}

export function callSqlFunction(session: Session, proc: ProcDef, args: unknown[], argTypes: number[], st: StatementState): { value: unknown; rows?: unknown[][] } {
  const names = inputArgNames(proc);
  const declared = proc.argtypes.length === args.length ? proc.argtypes : argTypes;
  const nested = nestedState(session, st, args, declared, names, proc.name);
  const inlined = session.sqlFunctionExpression(proc, nested);
  if (inlined) {
    let v = inlined.ev(new EvalCtx([], null, nested));
    if (inlined.type !== proc.rettype && v !== null) {
      v = inputValue(proc.rettype, outputValue(inlined.type, v, session.io), -1, session.io);
    }
    return { value: v };
  }
  let last: StatementResult | null = null;
  if (proc.sqlBody) {
    for (const stmt of proc.sqlBody) {
      last = session.executeParsedSync({ stmt, text: '', start: 0, end: 0 }, [], st.undo, nested);
    }
  } else {
    const parsed = session.db.parse(proc.body ?? '');
    for (const ps of parsed) {
      last = session.executeParsedSync(ps, [], st.undo, nested);
    }
  }
  if (!last) {
    return { value: null, rows: [] };
  }
  if (proc.retset) {
    if (proc.returnsTable || proc.rettype === TypeOid.record || last.fields.length > 1) {
      return { value: null, rows: last.rows.map((r) => r) as unknown[][] };
    }
    return { value: null, rows: last.rows.map((r) => r[0]) as unknown as unknown[][] };
  }
  if (proc.rettype === TypeOid.void) {
    return { value: '' };
  }
  if (last.rows.length === 0) {
    return { value: null };
  }
  const row = last.rows[0];
  const retType = session.catalog().getType(proc.rettype);
  if (retType && (retType.typtype === 'c' || proc.rettype === TypeOid.record) && row.length > 1) {
    return { value: new PgRecord(row, proc.rettype, last.fields.map((f) => f.typeOid), last.fields.map((f) => f.name)) };
  }
  let v = row[0];
  if (last.fields[0] && last.fields[0].typeOid !== proc.rettype && v !== null) {
    v = inputValue(proc.rettype, outputValue(last.fields[0].typeOid, v, session.io), -1, session.io);
  }
  return { value: v };
}

function inputArgNames(proc: ProcDef): string[] {
  if (!proc.argnames) {
    return [];
  }
  if (!proc.argmodes) {
    return proc.argnames;
  }
  return proc.argnames.filter((_, i) => proc.argmodes![i] === 'i' || proc.argmodes![i] === 'b' || proc.argmodes![i] === 'v' || (proc.kind === 'p' && proc.argmodes![i] === 'o'));
}

// ---------------------------------------------------------------------------
// PL/pgSQL
// ---------------------------------------------------------------------------

type PlStmt =
  | { k: 'block'; label?: string; decls: PlDecl[]; body: PlStmt[]; handlers: { conditions: string[]; body: PlStmt[] }[] }
  | { k: 'assign'; target: string; expr: string }
  | { k: 'if'; branches: { cond: string; body: PlStmt[] }[]; elseBody: PlStmt[] | null }
  | { k: 'return'; expr: string | null }
  | { k: 'return_next'; expr: string | null }
  | { k: 'return_query'; sql: string; dynamic: boolean; using: string[] }
  | { k: 'raise'; level: string; message: string; args: string[]; options: { name: string; expr: string }[]; condition?: string }
  | { k: 'perform'; sql: string }
  | { k: 'execute'; sql: string; into: string[] | null; strict: boolean; using: string[] }
  | { k: 'sql'; sql: string; into: string[] | null; strict: boolean }
  | { k: 'loop'; label?: string; body: PlStmt[] }
  | { k: 'while'; label?: string; cond: string; body: PlStmt[] }
  | { k: 'fori'; label?: string; var: string; from: string; to: string; by: string | null; reverse: boolean; body: PlStmt[] }
  | { k: 'forq'; label?: string; vars: string[]; sql: string; dynamic: boolean; using: string[]; body: PlStmt[] }
  | { k: 'foreach'; label?: string; var: string; array: string; body: PlStmt[] }
  | { k: 'exit'; label?: string; cond: string | null; isContinue: boolean }
  | { k: 'case'; expr: string | null; whens: { exprs: string; body: PlStmt[] }[]; elseBody: PlStmt[] | null }
  | { k: 'null' }
  | { k: 'getdiag'; items: { target: string; item: string }[] };

interface PlDecl {
  name: string;
  typeText: string;
  constant: boolean;
  notNull: boolean;
  defaultExpr: string | null;
  alias?: string;
}

class PlParser {
  private toks: Token[];
  private p = 0;

  constructor(private readonly src: string) {
    this.toks = tokenize(src);
  }

  private peek(k = 0): Token {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }

  private isKw(t: Token, ...kws: string[]): boolean {
    return t.type === 'ident' && !t.quoted && kws.includes(t.kw);
  }

  private atKw(...kws: string[]): boolean {
    return this.isKw(this.peek(), ...kws);
  }

  private expectKw(kw: string): void {
    if (!this.atKw(kw)) {
      this.fail(`expected ${kw}`);
    }
    this.p++;
  }

  private fail(msg: string): never {
    const t = this.peek();
    throw new PgError(SqlState.SYNTAX_ERROR, t.type === 'eof' ? 'syntax error at end of input' : `syntax error at or near "${this.src.slice(t.pos, t.end)}"`, { detail: msg });
  }

  /** text from current token up to (not including) the first token at depth 0 matching stop */
  private textUntil(stop: (t: Token, depth: number) => boolean): string {
    const start = this.peek().pos;
    let depth = 0;
    let end = start;
    while (this.peek().type !== 'eof') {
      const t = this.peek();
      if (depth === 0 && stop(t, depth)) {
        break;
      }
      if (t.type === 'punct' && (t.value === '(' || t.value === '[')) {
        depth++;
      } else if (t.type === 'punct' && (t.value === ')' || t.value === ']')) {
        depth--;
      } else if (this.isKw(t, 'CASE')) {
        depth++;
      } else if (this.isKw(t, 'END') && depth > 0 && !this.isKw(this.peek(1), 'IF', 'LOOP')) {
        depth--;
      }
      end = t.end;
      this.p++;
    }
    return this.src.slice(start, end);
  }

  private semi(t: Token): boolean {
    return t.type === 'punct' && t.value === ';';
  }

  parseBlockTop(): PlStmt {
    let label: string | undefined;
    if (this.peek().type === 'op' && this.peek().value === '<<') {
      this.p++;
      label = this.peek().value;
      this.p += 2;
    }
    const decls: PlDecl[] = [];
    if (this.atKw('DECLARE')) {
      this.p++;
      while (!this.atKw('BEGIN')) {
        decls.push(this.parseDecl());
      }
    }
    this.expectKw('BEGIN');
    const body = this.parseStmts(['END', 'EXCEPTION']);
    const handlers: { conditions: string[]; body: PlStmt[] }[] = [];
    if (this.atKw('EXCEPTION')) {
      this.p++;
      while (this.atKw('WHEN')) {
        this.p++;
        const conds: string[] = [];
        do {
          let c = this.peek().value;
          this.p++;
          if (c === 'sqlstate') {
            c = 'sqlstate:' + this.peek().value;
            this.p++;
          }
          conds.push(c);
        } while (this.atKw('OR') && (this.p++, true));
        this.expectKw('THEN');
        handlers.push({ conditions: conds, body: this.parseStmts(['WHEN', 'END']) });
      }
    }
    this.expectKw('END');
    if (this.peek().type === 'ident' && !this.semi(this.peek())) {
      this.p++;
    }
    if (this.semi(this.peek())) {
      this.p++;
    }
    return { k: 'block', label, decls, body, handlers };
  }

  private parseDecl(): PlDecl {
    const name = this.peek().value;
    this.p++;
    if (this.atKw('ALIAS')) {
      this.p++;
      this.expectKw('FOR');
      const alias = this.textUntil((t) => this.semi(t));
      this.p++;
      return { name, typeText: '', constant: false, notNull: false, defaultExpr: null, alias };
    }
    let constant = false;
    if (this.atKw('CONSTANT')) {
      constant = true;
      this.p++;
    }
    const typeText = this.textUntil((t) => this.semi(t) || this.isKw(t, 'NOT', 'DEFAULT', 'COLLATE') || (t.type === 'punct' && t.value === ':=') || (t.type === 'op' && t.value === '='));
    let notNull = false;
    if (this.atKw('COLLATE')) {
      this.p += 2;
    }
    if (this.atKw('NOT')) {
      this.p += 2;
      notNull = true;
    }
    let defaultExpr: string | null = null;
    if (this.atKw('DEFAULT') || (this.peek().type === 'punct' && this.peek().value === ':=') || (this.peek().type === 'op' && this.peek().value === '=')) {
      this.p++;
      defaultExpr = this.textUntil((t) => this.semi(t));
    }
    this.p++;
    return { name, typeText: typeText.trim(), constant, notNull, defaultExpr };
  }

  private parseStmts(terminators: string[]): PlStmt[] {
    const out: PlStmt[] = [];
    while (this.peek().type !== 'eof' && !(this.peek().type === 'ident' && !this.peek().quoted && terminators.includes(this.peek().kw) && !this.isStmtStartingKw(this.peek()))) {
      if (this.semi(this.peek())) {
        this.p++;
        continue;
      }
      out.push(this.parseStmt());
    }
    return out;
  }

  private isStmtStartingKw(t: Token): boolean {
    void t;
    return false;
  }

  private parseLabel(): string | undefined {
    if (this.peek().type === 'op' && this.peek().value === '<<') {
      this.p++;
      const l = this.peek().value;
      this.p++;
      this.p++; // >>
      return l;
    }
    return undefined;
  }

  private parseStmt(): PlStmt {
    const label = this.parseLabel();
    const t = this.peek();
    if (this.isKw(t, 'DECLARE', 'BEGIN')) {
      const b = this.parseBlockTop();
      if (b.k === 'block') {
        b.label = label;
      }
      return b;
    }
    if (this.isKw(t, 'IF')) {
      this.p++;
      const branches: { cond: string; body: PlStmt[] }[] = [];
      const cond = this.textUntil((x) => this.isKw(x, 'THEN'));
      this.p++;
      branches.push({ cond, body: this.parseStmts(['ELSIF', 'ELSEIF', 'ELSE', 'END']) });
      let elseBody: PlStmt[] | null = null;
      while (this.atKw('ELSIF', 'ELSEIF')) {
        this.p++;
        const c = this.textUntil((x) => this.isKw(x, 'THEN'));
        this.p++;
        branches.push({ cond: c, body: this.parseStmts(['ELSIF', 'ELSEIF', 'ELSE', 'END']) });
      }
      if (this.atKw('ELSE')) {
        this.p++;
        elseBody = this.parseStmts(['END']);
      }
      this.expectKw('END');
      this.expectKw('IF');
      this.p++;
      return { k: 'if', branches, elseBody };
    }
    if (this.isKw(t, 'CASE')) {
      this.p++;
      let expr: string | null = null;
      if (!this.atKw('WHEN')) {
        expr = this.textUntil((x) => this.isKw(x, 'WHEN'));
      }
      const whens: { exprs: string; body: PlStmt[] }[] = [];
      while (this.atKw('WHEN')) {
        this.p++;
        const e = this.textUntil((x) => this.isKw(x, 'THEN'));
        this.p++;
        whens.push({ exprs: e, body: this.parseStmts(['WHEN', 'ELSE', 'END']) });
      }
      let elseBody: PlStmt[] | null = null;
      if (this.atKw('ELSE')) {
        this.p++;
        elseBody = this.parseStmts(['END']);
      }
      this.expectKw('END');
      this.expectKw('CASE');
      this.p++;
      return { k: 'case', expr, whens, elseBody };
    }
    if (this.isKw(t, 'LOOP')) {
      this.p++;
      const body = this.parseStmts(['END']);
      this.expectKw('END');
      this.expectKw('LOOP');
      if (this.peek().type === 'ident' && !this.semi(this.peek())) {
        this.p++;
      }
      this.p++;
      return { k: 'loop', label, body };
    }
    if (this.isKw(t, 'WHILE')) {
      this.p++;
      const cond = this.textUntil((x) => this.isKw(x, 'LOOP'));
      this.p++;
      const body = this.parseStmts(['END']);
      this.expectKw('END');
      this.expectKw('LOOP');
      if (this.peek().type === 'ident' && !this.semi(this.peek())) {
        this.p++;
      }
      this.p++;
      return { k: 'while', label, cond, body };
    }
    if (this.isKw(t, 'FOR')) {
      this.p++;
      const vars: string[] = [this.peek().value];
      this.p++;
      while (this.peek().type === 'punct' && this.peek().value === ',') {
        this.p++;
        vars.push(this.peek().value);
        this.p++;
      }
      this.expectKw('IN');
      let reverse = false;
      if (this.atKw('REVERSE')) {
        reverse = true;
        this.p++;
      }
      if (this.atKw('SELECT', 'WITH', 'EXECUTE', 'VALUES')) {
        let dynamic = false;
        if (this.atKw('EXECUTE')) {
          dynamic = true;
          this.p++;
        }
        const sql = this.textUntil((x) => this.isKw(x, 'LOOP', 'USING'));
        const using: string[] = [];
        if (this.atKw('USING')) {
          this.p++;
          using.push(...this.textUntil((x) => this.isKw(x, 'LOOP')).split(','));
        }
        this.p++;
        const body = this.parseStmts(['END']);
        this.expectKw('END');
        this.expectKw('LOOP');
        this.p++;
        return { k: 'forq', label, vars, sql, dynamic, using, body };
      }
      const from = this.textUntil((x) => x.type === 'punct' && x.value === '..');
      this.p++;
      const to = this.textUntil((x) => this.isKw(x, 'LOOP', 'BY'));
      let by: string | null = null;
      if (this.atKw('BY')) {
        this.p++;
        by = this.textUntil((x) => this.isKw(x, 'LOOP'));
      }
      this.p++;
      const body = this.parseStmts(['END']);
      this.expectKw('END');
      this.expectKw('LOOP');
      this.p++;
      return { k: 'fori', label, var: vars[0], from, to, by, reverse, body };
    }
    if (this.isKw(t, 'FOREACH')) {
      this.p++;
      const v = this.peek().value;
      this.p++;
      if (this.atKw('SLICE')) {
        this.p += 2;
      }
      this.expectKw('IN');
      this.expectKw('ARRAY');
      const arr = this.textUntil((x) => this.isKw(x, 'LOOP'));
      this.p++;
      const body = this.parseStmts(['END']);
      this.expectKw('END');
      this.expectKw('LOOP');
      this.p++;
      return { k: 'foreach', label, var: v, array: arr, body };
    }
    if (this.isKw(t, 'EXIT', 'CONTINUE')) {
      this.p++;
      let lbl: string | undefined;
      if (this.peek().type === 'ident' && !this.atKw('WHEN')) {
        lbl = this.peek().value;
        this.p++;
      }
      let cond: string | null = null;
      if (this.atKw('WHEN')) {
        this.p++;
        cond = this.textUntil((x) => this.semi(x));
      }
      this.p++;
      return { k: 'exit', label: lbl, cond, isContinue: t.kw === 'CONTINUE' };
    }
    if (this.isKw(t, 'RETURN')) {
      this.p++;
      if (this.atKw('NEXT')) {
        this.p++;
        const e = this.textUntil((x) => this.semi(x));
        this.p++;
        return { k: 'return_next', expr: e.trim() || null };
      }
      if (this.atKw('QUERY')) {
        this.p++;
        let dynamic = false;
        if (this.atKw('EXECUTE')) {
          dynamic = true;
          this.p++;
        }
        const sql = this.textUntil((x) => this.semi(x) || (dynamic && this.isKw(x, 'USING')));
        const using: string[] = [];
        if (this.atKw('USING')) {
          this.p++;
          using.push(...splitTopLevel(this.textUntil((x) => this.semi(x))));
        }
        this.p++;
        return { k: 'return_query', sql, dynamic, using };
      }
      const e = this.textUntil((x) => this.semi(x));
      this.p++;
      return { k: 'return', expr: e.trim() || null };
    }
    if (this.isKw(t, 'RAISE')) {
      this.p++;
      let level = 'EXCEPTION';
      if (this.atKw('DEBUG', 'LOG', 'INFO', 'NOTICE', 'WARNING', 'EXCEPTION')) {
        level = this.peek().kw;
        this.p++;
      }
      let message = '';
      const args: string[] = [];
      let condition: string | undefined;
      if (this.peek().type === 'string') {
        message = this.peek().value;
        this.p++;
        while (this.peek().type === 'punct' && this.peek().value === ',') {
          this.p++;
          args.push(this.textUntil((x) => this.semi(x) || (x.type === 'punct' && x.value === ',') || this.isKw(x, 'USING')));
        }
      } else if (this.peek().type === 'ident' && !this.atKw('USING')) {
        condition = this.peek().value;
        this.p++;
        if (condition === 'sqlstate') {
          condition = 'sqlstate:' + this.peek().value;
          this.p++;
        }
      }
      const options: { name: string; expr: string }[] = [];
      if (this.atKw('USING')) {
        this.p++;
        do {
          const name = this.peek().value;
          this.p++;
          this.p++; // =
          options.push({ name, expr: this.textUntil((x) => this.semi(x) || (x.type === 'punct' && x.value === ',')) });
        } while (this.peek().type === 'punct' && this.peek().value === ',' && (this.p++, true));
      }
      this.p++;
      return { k: 'raise', level, message, args, options, condition };
    }
    if (this.isKw(t, 'PERFORM')) {
      this.p++;
      const sql = 'SELECT ' + this.textUntil((x) => this.semi(x));
      this.p++;
      return { k: 'perform', sql };
    }
    if (this.isKw(t, 'NULL')) {
      this.p += 2;
      return { k: 'null' };
    }
    if (this.isKw(t, 'GET')) {
      this.p++;
      if (this.atKw('CURRENT', 'STACKED')) {
        this.p++;
      }
      this.expectKw('DIAGNOSTICS');
      const items: { target: string; item: string }[] = [];
      do {
        const target = this.peek().value;
        this.p++;
        this.p++; // = or :=
        items.push({ target, item: this.peek().value.toLowerCase() });
        this.p++;
      } while (this.peek().type === 'punct' && this.peek().value === ',' && (this.p++, true));
      this.p++;
      return { k: 'getdiag', items };
    }
    if (this.isKw(t, 'EXECUTE')) {
      this.p++;
      const sql = this.textUntil((x) => this.semi(x) || this.isKw(x, 'INTO', 'USING'));
      let into: string[] | null = null;
      let strict = false;
      const using: string[] = [];
      while (this.atKw('INTO', 'USING')) {
        if (this.atKw('INTO')) {
          this.p++;
          if (this.atKw('STRICT')) {
            strict = true;
            this.p++;
          }
          into = this.textUntil((x) => this.semi(x) || this.isKw(x, 'USING'))
            .split(',')
            .map((s) => s.trim());
        } else {
          this.p++;
          using.push(...splitTopLevel(this.textUntil((x) => this.semi(x) || this.isKw(x, 'INTO'))));
        }
      }
      this.p++;
      return { k: 'execute', sql, into, strict, using };
    }
    // assignment: target := expr
    const t1 = this.peek(1);
    if (t.type === 'ident' && ((t1.type === 'punct' && t1.value === ':=') || (t1.type === 'op' && t1.value === '='))) {
      this.p += 2;
      const expr = this.textUntil((x) => this.semi(x));
      this.p++;
      return { k: 'assign', target: t.value, expr };
    }
    if (t.type === 'ident' && t1.type === 'punct' && t1.value === '.' && this.peek(2).type === 'ident' && ((this.peek(3).type === 'punct' && this.peek(3).value === ':=') || (this.peek(3).type === 'op' && this.peek(3).value === '='))) {
      const field = this.peek(2).value;
      this.p += 4;
      const expr = this.textUntil((x) => this.semi(x));
      this.p++;
      return { k: 'assign', target: t.value + '.' + field, expr };
    }
    // plain SQL (possibly SELECT ... INTO)
    const start = this.peek().pos;
    let into: string[] | null = null;
    let strict = false;
    let sqlText = '';
    let segStart = start;
    let depth = 0;
    while (this.peek().type !== 'eof' && !(depth === 0 && this.semi(this.peek()))) {
      const x = this.peek();
      if (x.type === 'punct' && x.value === '(') {
        depth++;
      } else if (x.type === 'punct' && x.value === ')') {
        depth--;
      }
      if (depth === 0 && this.isKw(x, 'INTO') && !into && /^\s*(select|with)\b/i.test(this.src.slice(start, x.pos))) {
        sqlText += this.src.slice(segStart, x.pos);
        this.p++;
        if (this.atKw('STRICT')) {
          strict = true;
          this.p++;
        }
        into = [];
        do {
          into.push(this.peek().value);
          this.p++;
        } while (this.peek().type === 'punct' && this.peek().value === ',' && (this.p++, true));
        segStart = this.peek().pos;
        continue;
      }
      this.p++;
    }
    const endTok = this.toks[this.p - 1];
    sqlText += this.src.slice(segStart, Math.max(segStart, endTok.end));
    this.p++;
    return { k: 'sql', sql: sqlText, into, strict };
  }
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inStr) {
      inStr = true;
    } else if (c === "'" && inStr) {
      inStr = false;
    }
    if (!inStr) {
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      } else if (c === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) {
    out.push(cur);
  }
  return out;
}

/** tokens of the SQL a function body runs (the same statement texts run on every call); read-only */
const statementTokenCache = new Map<string, Token[]>();
const STATEMENT_TOKEN_CACHE_MAX = 5000;

function statementTokens(sql: string): Token[] {
  let toks = statementTokenCache.get(sql);
  if (!toks) {
    try {
      toks = tokenize(sql);
    } catch {
      toks = [];
    }
    if (statementTokenCache.size >= STATEMENT_TOKEN_CACHE_MAX) {
      statementTokenCache.clear();
    }
    statementTokenCache.set(sql, toks);
  }
  return toks;
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}

class ExitSignal {
  constructor(
    readonly label: string | undefined,
    readonly isContinue: boolean
  ) {}
}

interface PlVar {
  name: string;
  type: number;
  typmod: number;
  value: unknown;
}

class PlFrame {
  vars = new Map<string, PlVar>();
  constructor(readonly parent: PlFrame | null) {}

  lookup(name: string): PlVar | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  all(): PlVar[] {
    const seen = new Set<string>();
    const out: PlVar[] = [];
    let f: PlFrame | null = this;
    while (f) {
      for (const v of f.vars.values()) {
        if (!seen.has(v.name)) {
          seen.add(v.name);
          out.push(v);
        }
      }
      f = f.parent;
    }
    return out;
  }
}

class PlInterpreter {
  rowCount = 0;
  found = false;
  returnRows: unknown[][] = [];
  /** blocks with an EXCEPTION clause being executed (each runs as a subtransaction) */
  subxactDepth = 0;
  /** a trigger function's transition tables (SPI_register_trigger_data), visible to its statements */
  transitionTables: TransitionTable[] | null = null;
  /** exceptions whose handlers are running (bare RAISE re-throws the innermost) */
  handling: PgError[] = [];

  /** COMMIT / ROLLBACK [AND [NO] CHAIN] (exec_stmt_commit / exec_stmt_rollback) */
  transactionControl(commit: boolean, chain: boolean): void {
    if (!this.st.nonAtomic) {
      throw new PgError(SqlState.INVALID_TRANSACTION_TERMINATION, 'invalid transaction termination');
    }
    if (this.subxactDepth > 0) {
      throw new PgError(SqlState.INVALID_TRANSACTION_TERMINATION, `cannot ${commit ? 'commit' : 'roll back'} while a subtransaction is active`);
    }
    this.session.procedureTransactionEnd(commit, chain, this.st);
  }

  /** a function with OUT / INOUT / TABLE parameters: their variables form the result (row) */
  outParams: { name: string; type: number }[] | null = null;

  constructor(
    readonly session: Session,
    readonly st: StatementState,
    readonly retType: number,
    readonly retset: boolean
  ) {}

  /** The value the OUT parameters make up: the single one, or a record of all of them. */
  outValue(frame: PlFrame): unknown {
    const params = this.outParams!;
    const values = params.map((p) => frame.lookup(p.name)?.value ?? null);
    if (params.length === 1) {
      return values[0];
    }
    return new PgRecord(values, TypeOid.record, params.map((p) => p.type), params.map((p) => p.name));
  }

  /** Replace variable references with $n parameters and run the SQL. */
  runSql(sql: string, frame: PlFrame, extraParams: { values: unknown[]; types: number[] } | null = null): StatementResult {
    const params: unknown[] = [];
    const types: number[] = [];
    const names = new Map<string, number>();
    let out = '';
    const toks = statementTokens(sql);
    let last = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'ident') {
        continue;
      }
      const prev = toks[i - 1];
      if (prev && prev.type === 'punct' && prev.value === '.' ) {
        // NEW.col / OLD.col handled when prev ident is a record var
        continue;
      }
      const next = toks[i + 1];
      let name = t.value;
      let v = frame.lookup(name);
      let consumed = 0;
      if (v && v.value === null && next && next.type === 'punct' && next.value === '.' && toks[i + 2] && toks[i + 2].type === 'ident') {
        // a NULL row of a known composite type (OLD in an INSERT trigger): its fields are NULL
        const relid = this.session.catalog().getType(v.type)?.relid;
        const col = relid ? this.session.catalog().getRelation(relid)?.columns.find((c) => !c.isDropped && c.name === toks[i + 2].value) : undefined;
        if (col) {
          name = name + '.' + col.name;
          if (!names.has(name)) {
            params.push(null);
            types.push(col.typeOid);
            names.set(name, params.length);
          }
          out += sql.slice(last, t.pos) + '$' + names.get(name);
          last = toks[i + 2].end;
          i += 2;
          continue;
        }
      }
      if (v && next && next.type === 'punct' && next.value === '.' && toks[i + 2] && toks[i + 2].type === 'ident' && v.value instanceof PgRecord) {
        const field = toks[i + 2].value;
        const rec = v.value as PgRecord;
        const idx = rec.fieldNames.indexOf(field);
        if (idx >= 0) {
          name = name + '.' + field;
          if (!names.has(name)) {
            params.push(rec.values[idx]);
            types.push(rec.fieldTypes[idx]);
            names.set(name, params.length);
          }
          out += sql.slice(last, t.pos) + '$' + names.get(name);
          last = toks[i + 2].end;
          i += 2;
          continue;
        }
      }
      if (!v || (next && next.type === 'punct' && next.value === '(')) {
        continue;
      }
      if (v.value instanceof PgRecord && next && next.type === 'punct' && next.value === '.') {
        continue;
      }
      if (!names.has(name)) {
        params.push(v.value);
        types.push(v.type);
        names.set(name, params.length);
      }
      out += sql.slice(last, t.pos) + '$' + names.get(name);
      last = t.end;
      void consumed;
    }
    out += sql.slice(last);
    if (extraParams) {
      // dynamic SQL with USING: keep $1..$n for USING values; variables are not substituted
      return this.execNested(sql, extraParams.values, extraParams.types);
    }
    return this.execNested(out, params, types);
  }

  execNested(sql: string, params: unknown[], types: number[]): StatementResult {
    const nested = new StatementState(this.session, this.session.catalog(), params, types, this.st.snapshot);
    nested.undo = this.st.undo;
    nested.depth = this.st.depth + 1;
    nested.nonAtomic = this.st.nonAtomic && this.subxactDepth === 0;
    nested.transitionTables = this.transitionTables;
    let last: StatementResult | null = null;
    try {
      const parsed = this.session.db.parse(sql);
      for (const ps of parsed) {
        last = this.session.executeParsedSync(ps, [], this.st.undo, nested);
      }
    } catch (e) {
      // a position within a statement run by the function is an internal position, not one in the client's query
      if (e instanceof PgError && e.position !== undefined && e.internalPosition === undefined) {
        e.internalPosition = e.position;
        e.internalQuery = sql;
        e.position = undefined;
      }
      throw e;
    }
    const r = last ?? { command: '', rowCount: 0, fields: [], rows: [], hasRows: false };
    this.rowCount = r.rowCount ?? r.rows.length;
    this.found = this.rowCount > 0;
    return r;
  }

  evalExpr(expr: string, frame: PlFrame): { value: unknown; type: number } {
    const r = this.runSql('SELECT ' + expr, frame);
    if (r.rows.length === 0) {
      return { value: null, type: r.fields[0]?.typeOid ?? TypeOid.text };
    }
    if (r.fields.length > 1) {
      return { value: new PgRecord(r.rows[0], TypeOid.record, r.fields.map((f) => f.typeOid), r.fields.map((f) => f.name)), type: TypeOid.record };
    }
    return { value: r.rows[0][0], type: r.fields[0].typeOid };
  }

  evalBool(expr: string, frame: PlFrame): boolean {
    return this.evalExpr(expr, frame).value === true;
  }

  assign(frame: PlFrame, target: string, value: unknown, type: number): void {
    const [name, field] = target.split('.');
    const v = frame.lookup(name);
    if (!v) {
      throw new PgError(SqlState.SYNTAX_ERROR, `"${name}" is not a known variable`);
    }
    if (field) {
      const rec = v.value as PgRecord;
      const idx = rec.fieldNames.indexOf(field);
      if (idx < 0) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `record "${name}" has no field "${field}"`);
      }
      const values = rec.values.slice();
      values[idx] = this.convert(value, type, rec.fieldTypes[idx]);
      v.value = new PgRecord(values, rec.typeOid, rec.fieldTypes, rec.fieldNames);
      return;
    }
    v.value = this.convert(value, type, v.type);
  }

  convert(value: unknown, from: number, to: number): unknown {
    if (value === null || from === to || to === TypeOid.record || to === 0 || value instanceof PgRecord) {
      return value;
    }
    const io = this.session.io;
    return inputValue(to, outputValue(from, value, io), -1, io);
  }

  declare(frame: PlFrame, decl: PlDecl): void {
    if (decl.alias) {
      const target = frame.lookup(decl.alias.trim().replace(/^\$/, 'arg'));
      if (target) {
        frame.vars.set(decl.name, target);
      }
      return;
    }
    let type: number = TypeOid.text;
    let typmod = -1;
    const tt = decl.typeText.toLowerCase();
    if (tt === 'record') {
      type = TypeOid.record;
    } else if (/%rowtype$/.test(tt) || /%type$/.test(tt)) {
      type = TypeOid.record;
    } else {
      const oid = this.session.resolveType(decl.typeText);
      if (oid === null) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `type "${decl.typeText}" does not exist`);
      }
      type = oid;
    }
    const v: PlVar = { name: decl.name, type, typmod, value: null };
    frame.vars.set(decl.name, v);
    if (decl.defaultExpr) {
      const r = this.evalExpr(decl.defaultExpr, frame);
      v.value = this.convert(r.value, r.type, type);
    }
  }

  execBlock(stmt: Extract<PlStmt, { k: 'block' }>, parent: PlFrame): void {
    const frame = new PlFrame(parent);
    for (const d of stmt.decls) {
      this.declare(frame, d);
    }
    if (stmt.handlers.length === 0) {
      this.execList(stmt.body, frame);
      return;
    }
    const undo = this.st.undo;
    const mark = undo ? undo.length : 0;
    this.subxactDepth++;
    try {
      this.execList(stmt.body, frame);
      this.subxactDepth--;
    } catch (e) {
      // the handler runs after the block's subtransaction is gone
      this.subxactDepth--;
      if (!(e instanceof PgError)) {
        throw e;
      }
      const handler = stmt.handlers.find((h) => h.conditions.some((c) => conditionMatches(c, e)));
      if (!handler) {
        throw e;
      }
      if (undo && undo.length > mark) {
        rollbackTo(undo, mark);
      }
      const hframe = new PlFrame(frame);
      hframe.vars.set('sqlstate', { name: 'sqlstate', type: TypeOid.text, typmod: -1, value: e.code });
      hframe.vars.set('sqlerrm', { name: 'sqlerrm', type: TypeOid.text, typmod: -1, value: e.message });
      this.handling.push(e);
      try {
        this.execList(handler.body, hframe);
      } finally {
        this.handling.pop();
      }
    }
  }

  execList(list: PlStmt[], frame: PlFrame): void {
    for (const s of list) {
      this.exec(s, frame);
    }
  }

  exec(s: PlStmt, frame: PlFrame): void {
    switch (s.k) {
      case 'block':
        this.execBlock(s, frame);
        return;
      case 'null':
        return;
      case 'assign': {
        const r = this.evalExpr(s.expr, frame);
        this.assign(frame, s.target, r.value, r.type);
        return;
      }
      case 'if':
        for (const b of s.branches) {
          if (this.evalBool(b.cond, frame)) {
            this.execList(b.body, frame);
            return;
          }
        }
        if (s.elseBody) {
          this.execList(s.elseBody, frame);
        }
        return;
      case 'case': {
        for (const w of s.whens) {
          const cond = s.expr ? `(${s.expr}) IN (${w.exprs})` : w.exprs;
          if (this.evalBool(cond, frame)) {
            this.execList(w.body, frame);
            return;
          }
        }
        if (s.elseBody) {
          this.execList(s.elseBody, frame);
          return;
        }
        throw new PgError('20000', 'case not found', { hint: 'CASE statement is missing ELSE part.' });
      }
      case 'return':
        if (this.outParams && s.expr !== null) {
          throw new PgError(SqlState.DATATYPE_MISMATCH, 'RETURN cannot have a parameter in function with OUT parameters');
        }
        if (this.retset) {
          throw new ReturnSignal(null);
        }
        if (this.outParams) {
          throw new ReturnSignal(this.outValue(frame));
        }
        if (s.expr === null) {
          throw new ReturnSignal(null);
        }
        {
          const r = this.evalExpr(s.expr, frame);
          throw new ReturnSignal(this.convert(r.value, r.type, this.retType));
        }
      case 'return_next': {
        if (this.outParams) {
          if (s.expr) {
            throw new PgError(SqlState.DATATYPE_MISMATCH, 'RETURN NEXT cannot have a parameter in function with OUT parameters');
          }
          this.returnRows.push(this.outParams.map((p) => frame.lookup(p.name)?.value ?? null));
          return;
        }
        if (s.expr) {
          const r = this.evalExpr(s.expr, frame);
          this.returnRows.push(r.value instanceof PgRecord ? r.value.values : [r.value]);
        }
        return;
      }
      case 'return_query': {
        const r = s.dynamic ? this.dynamic(s.sql, s.using, frame) : this.runSql(s.sql, frame);
        this.returnRows.push(...r.rows);
        return;
      }
      case 'raise':
        this.raise(s, frame);
        return;
      case 'perform':
        this.runSql(s.sql, frame);
        return;
      case 'execute': {
        const r = this.dynamic(s.sql, s.using, frame);
        if (s.into) {
          this.intoVars(s.into, r, s.strict, frame);
        }
        return;
      }
      case 'sql': {
        const tc = /^\s*(commit|rollback)(?:\s+(?:work|transaction))?(?:\s+and\s+(no\s+)?chain)?\s*;?\s*$/i.exec(s.sql);
        if (tc) {
          this.transactionControl(tc[1].toLowerCase() === 'commit', /\band\s+chain\s*;?\s*$/i.test(s.sql));
          return;
        }
        const r = this.runSql(s.sql, frame);
        if (s.into) {
          this.intoVars(s.into, r, s.strict, frame);
        }
        return;
      }
      case 'getdiag':
        for (const it of s.items) {
          if (it.item === 'row_count') {
            this.assign(frame, it.target, BigInt(this.rowCount), TypeOid.int8);
          }
        }
        return;
      case 'loop':
        for (let guard = 0; ; guard++) {
          if (guard > 10_000_000) {
            throw new PgError(SqlState.PROGRAM_LIMIT_EXCEEDED, 'loop limit exceeded');
          }
          try {
            this.execList(s.body, frame);
          } catch (e) {
            if (e instanceof ExitSignal && (!e.label || e.label === s.label)) {
              if (e.isContinue) {
                continue;
              }
              return;
            }
            throw e;
          }
        }
      case 'while':
        while (this.evalBool(s.cond, frame)) {
          try {
            this.execList(s.body, frame);
          } catch (e) {
            if (e instanceof ExitSignal && (!e.label || e.label === s.label)) {
              if (e.isContinue) {
                continue;
              }
              return;
            }
            throw e;
          }
        }
        return;
      case 'fori': {
        const from = Number(this.evalExpr(s.from, frame).value);
        const to = Number(this.evalExpr(s.to, frame).value);
        const by = s.by ? Number(this.evalExpr(s.by, frame).value) : 1;
        const lframe = new PlFrame(frame);
        const v: PlVar = { name: s.var, type: TypeOid.int4, typmod: -1, value: from };
        lframe.vars.set(s.var, v);
        for (let i = from; s.reverse ? i >= to : i <= to; i += s.reverse ? -by : by) {
          v.value = i;
          try {
            this.execList(s.body, lframe);
          } catch (e) {
            if (e instanceof ExitSignal && (!e.label || e.label === s.label)) {
              if (e.isContinue) {
                continue;
              }
              return;
            }
            throw e;
          }
        }
        return;
      }
      case 'forq': {
        const r = s.dynamic ? this.dynamic(s.sql, s.using, frame) : this.runSql(s.sql, frame);
        for (const row of r.rows) {
          if (s.vars.length === 1 && frame.lookup(s.vars[0])?.type === TypeOid.record) {
            frame.lookup(s.vars[0])!.value = new PgRecord(row, TypeOid.record, r.fields.map((f) => f.typeOid), r.fields.map((f) => f.name));
          } else if (s.vars.length === 1 && r.fields.length > 1) {
            const v = frame.lookup(s.vars[0]);
            if (v) {
              v.value = new PgRecord(row, TypeOid.record, r.fields.map((f) => f.typeOid), r.fields.map((f) => f.name));
            }
          } else {
            s.vars.forEach((name, i) => this.assign(frame, name, row[i], r.fields[i]?.typeOid ?? TypeOid.text));
          }
          try {
            this.execList(s.body, frame);
          } catch (e) {
            if (e instanceof ExitSignal && (!e.label || e.label === s.label)) {
              if (e.isContinue) {
                continue;
              }
              return;
            }
            throw e;
          }
        }
        return;
      }
      case 'foreach': {
        const arr = (this.evalExpr(s.array, frame).value as unknown[]) ?? [];
        for (const el of arr.flat(Infinity as 1)) {
          frame.lookup(s.var)!.value = el;
          try {
            this.execList(s.body, frame);
          } catch (e) {
            if (e instanceof ExitSignal && (!e.label || e.label === s.label)) {
              if (e.isContinue) {
                continue;
              }
              return;
            }
            throw e;
          }
        }
        return;
      }
      case 'exit':
        if (s.cond === null || this.evalBool(s.cond, frame)) {
          throw new ExitSignal(s.label, s.isContinue);
        }
        return;
    }
  }

  dynamic(sqlExpr: string, using: string[], frame: PlFrame): StatementResult {
    const sql = this.evalExpr(sqlExpr, frame).value;
    if (sql === null) {
      throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'query string argument of EXECUTE is null');
    }
    const vals: unknown[] = [];
    const types: number[] = [];
    for (const u of using) {
      const r = this.evalExpr(u, frame);
      vals.push(r.value);
      types.push(r.type);
    }
    return this.execNested(String(sql), vals, types);
  }

  intoVars(into: string[], r: StatementResult, strict: boolean, frame: PlFrame): void {
    if (strict) {
      if (r.rows.length === 0) {
        throw new PgError(SqlState.NO_DATA_FOUND, 'query returned no rows');
      }
      if (r.rows.length > 1) {
        throw new PgError(SqlState.TOO_MANY_ROWS, 'query returned more than one row', { hint: 'Make sure the query returns a single row, or use LIMIT 1.' });
      }
    }
    const row = r.rows[0];
    if (into.length === 1) {
      const v = frame.lookup(into[0].split('.')[0]);
      if (v && v.type === TypeOid.record && !into[0].includes('.')) {
        v.value = row ? new PgRecord(row, TypeOid.record, r.fields.map((f) => f.typeOid), r.fields.map((f) => f.name)) : null;
        return;
      }
    }
    into.forEach((name, i) => this.assign(frame, name, row ? row[i] : null, r.fields[i]?.typeOid ?? TypeOid.text));
  }

  raise(s: Extract<PlStmt, { k: 'raise' }>, frame: PlFrame): void {
    if (s.level === 'EXCEPTION' && !s.message && s.args.length === 0 && s.options.length === 0 && !s.condition) {
      // bare RAISE: re-throw the exception the enclosing handler is processing
      const current = this.handling[this.handling.length - 1];
      if (!current) {
        throw new PgError('0Z002', 'RAISE without parameters cannot be used outside an exception handler');
      }
      throw current;
    }
    let msg = s.message;
    let argIdx = 0;
    msg = msg.replace(/%%|%/g, (m) => {
      if (m === '%%') {
        return '%';
      }
      const a = s.args[argIdx++];
      if (a === undefined) {
        return '';
      }
      const r = this.evalExpr(a, frame);
      return r.value === null ? '<NULL>' : outputValue(r.type, r.value, this.session.io);
    });
    const isError = s.level === 'EXCEPTION';
    // errstart's default codes: raise_exception for errors, warning / successful_completion below
    let code = isError ? (SqlState.RAISE_EXCEPTION as string) : s.level === 'WARNING' ? '01000' : '00000';
    const fields: Record<string, string> = {};
    if (s.condition) {
      code = s.condition.startsWith('sqlstate:') ? s.condition.slice(9) : conditionCode(s.condition) ?? code;
      if (!msg) {
        msg = s.condition;
      }
    }
    for (const o of s.options) {
      const v = this.evalExpr(o.expr, frame).value;
      const name = o.name.toLowerCase();
      if (name === 'errcode') {
        code = String(v);
      } else if (name === 'message') {
        msg = String(v);
      } else {
        fields[name] = String(v);
      }
    }
    const errFields = { detail: fields.detail, hint: fields.hint, constraint: fields.constraint, table: fields.table, column: fields.column };
    if (!isError) {
      this.session.notice(s.level, code, msg, errFields);
      return;
    }
    throw new PgError(code, msg, errFields);
  }
}

const CONDITION_CODES: Record<string, string> = {
  unique_violation: '23505',
  foreign_key_violation: '23503',
  not_null_violation: '23502',
  check_violation: '23514',
  division_by_zero: '22012',
  no_data_found: 'P0002',
  too_many_rows: 'P0003',
  raise_exception: 'P0001',
  undefined_table: '42P01',
  undefined_column: '42703',
  duplicate_object: '42710',
  duplicate_table: '42P07',
  invalid_text_representation: '22P02',
  numeric_value_out_of_range: '22003',
  lock_not_available: '55P03',
  serialization_failure: '40001',
  deadlock_detected: '40P01',
  undefined_object: '42704',
  duplicate_column: '42701',
  invalid_parameter_value: '22023',
};

function conditionCode(name: string): string | undefined {
  return CONDITION_CODES[name.toLowerCase()];
}

function conditionMatches(cond: string, e: PgError): boolean {
  const c = cond.toLowerCase();
  if (c === 'others') {
    return e.code !== '57014';
  }
  if (c.startsWith('sqlstate:')) {
    return e.code === cond.slice(9);
  }
  return conditionCode(c) === e.code;
}

function rollbackTo(undo: import('../storage/mvcc').UndoLog, mark: number): void {
  // partial undo: roll back entries beyond mark
  const u = undo as unknown as { entries: unknown[] };
  const tail = u.entries.splice(mark);
  const tmp = new (undo.constructor as new () => import('../storage/mvcc').UndoLog)();
  (tmp as unknown as { entries: unknown[] }).entries = tail;
  tmp.rollback();
}

function parseBody(body: string): Extract<PlStmt, { k: 'block' }> {
  const parser = new PlParser(body.trim());
  const b = parser.parseBlockTop();
  return b as Extract<PlStmt, { k: 'block' }>;
}

export function callPlpgsqlFunction(
  session: Session,
  proc: ProcDef,
  args: unknown[],
  argTypes: number[],
  st: StatementState
): { value: unknown; rows?: unknown[][]; outputs?: { fields: FieldInfo[]; values: unknown[] } } {
  const cacheKey = '__plpgsql_ast';
  let ast = (proc as unknown as Record<string, unknown>)[cacheKey] as Extract<PlStmt, { k: 'block' }> | undefined;
  if (!ast) {
    ast = parseBody(proc.body ?? '');
    (proc as unknown as Record<string, unknown>)[cacheKey] = ast;
  }
  const interp = new PlInterpreter(session, st, proc.rettype, proc.retset);
  const frame = new PlFrame(null);
  const names = inputArgNames(proc);
  args.forEach((a, i) => {
    const v: PlVar = { name: names[i] || `$${i + 1}`, type: proc.argtypes[i] ?? argTypes[i], typmod: -1, value: a };
    if (names[i]) {
      frame.vars.set(names[i], v);
    }
    frame.vars.set(`$${i + 1}`, v);
  });
  // a function's OUT / INOUT / TABLE parameters are variables (initially NULL) forming its result
  if (proc.kind !== 'p' && ((proc.argmodes && proc.argmodes.some((m) => m === 'o' || m === 'b' || m === 't')) || proc.returnsTable)) {
    interp.outParams = [];
    (proc.argmodes ?? []).forEach((mode, i) => {
      if (mode !== 'o' && mode !== 'b' && mode !== 't') {
        return;
      }
      const name = proc.argnames?.[i] || `$${i + 1}`;
      const type = proc.allargtypes?.[i] ?? TypeOid.text;
      if (mode !== 'b') {
        frame.vars.set(name, { name, type, typmod: -1, value: null });
      }
      interp.outParams!.push({ name, type });
    });
    if (proc.returnsTable && !(proc.argmodes ?? []).includes('t')) {
      for (const c of proc.returnsTable) {
        frame.vars.set(c.name, { name: c.name, type: c.typeOid, typmod: c.typmod, value: null });
        interp.outParams.push({ name: c.name, type: c.typeOid });
      }
    }
  }
  frame.vars.set('found', { name: 'found', type: TypeOid.bool, typmod: -1, value: false });
  // a procedure's INOUT parameters are returned as a row with their final values
  const outputs = () => {
    if (proc.kind !== 'p' || !proc.argmodes || !proc.argnames) {
      return undefined;
    }
    const fields: FieldInfo[] = [];
    const values: unknown[] = [];
    proc.argmodes.forEach((mode, i) => {
      if (mode === 'b' || mode === 'o') {
        const v = frame.vars.get(proc.argnames![i]);
        fields.push({ name: proc.argnames![i], typeOid: proc.allargtypes?.[i] ?? TypeOid.text, typmod: -1, tableOid: 0, columnAttnum: 0 });
        values.push(v ? v.value : null);
      }
    });
    return fields.length ? { fields, values } : undefined;
  };
  try {
    interp.execBlock(ast, frame);
  } catch (e) {
    if (e instanceof ReturnSignal) {
      return { value: e.value, rows: interp.returnRows, outputs: outputs() };
    }
    throw e;
  }
  if (proc.retset) {
    return { value: null, rows: interp.returnRows };
  }
  if (interp.outParams) {
    return { value: interp.outValue(frame) };
  }
  if (proc.rettype !== TypeOid.void && proc.kind !== 'p') {
    throw new PgError('2F005', 'control reached end of function without RETURN', { where: `PL/pgSQL function ${proc.name}` });
  }
  return { value: '', outputs: outputs() };
}

export function runDoBlock(session: Session, stmt: A.DoStmt, parentSt: StatementState | null, undo: UndoLog | null = null): void {
  if (stmt.language.toLowerCase() !== 'plpgsql') {
    throw new PgError(SqlState.UNDEFINED_OBJECT, `language "${stmt.language}" does not exist`);
  }
  const ast = parseBody(stmt.body);
  let st = parentSt;
  if (!st) {
    st = new StatementState(session, session.catalog(), [], [], session.takeSnapshot());
    st.undo = undo;
    st.nonAtomic = session.nonAtomicContext(null);
  }
  const interp = new PlInterpreter(session, st, TypeOid.void, false);
  const frame = new PlFrame(null);
  frame.vars.set('found', { name: 'found', type: TypeOid.bool, typmod: -1, value: false });
  try {
    interp.execBlock(ast, frame);
  } catch (e) {
    if (e instanceof ReturnSignal) {
      return;
    }
    throw e;
  }
}

function triggerFrame(session: Session, rel: Relation, trig: { name: string; args: string[] }, timing: string, event: string, level: 'ROW' | 'STATEMENT'): PlFrame {
  const cat = session.catalog();
  const frame = new PlFrame(null);
  const set = (name: string, type: number, value: unknown) => frame.vars.set(name, { name, type, typmod: -1, value });
  set('tg_op', TypeOid.text, event);
  set('tg_when', TypeOid.text, timing);
  set('tg_level', TypeOid.text, level);
  set('tg_table_name', TypeOid.name, rel.name);
  set('tg_relname', TypeOid.name, rel.name);
  set('tg_table_schema', TypeOid.name, cat.namespaceName(rel.nspOid));
  set('tg_relid', TypeOid.oid, rel.oid);
  set('tg_name', TypeOid.name, trig.name);
  set('tg_nargs', TypeOid.int4, trig.args.length);
  set('tg_argv', 1009 /* text[] */, trig.args.slice());
  set('found', TypeOid.bool, false);
  return frame;
}

function triggerAst(session: Session, funcOid: number): Extract<PlStmt, { k: 'block' }> {
  const proc = session.catalog().getProc(funcOid)!;
  let ast = (proc as unknown as Record<string, unknown>).__plpgsql_ast as Extract<PlStmt, { k: 'block' }> | undefined;
  if (!ast) {
    ast = parseBody(proc.body ?? '');
    (proc as unknown as Record<string, unknown>).__plpgsql_ast = ast;
  }
  return ast;
}

const NO_TRIGGERS: TriggerDef[] = [];
/** the triggers of each relation in firing (name) order, per catalog version: a statement and each of its rows look them up */
const triggersByRelation = new WeakMap<Catalog, { version: number; size: number; byRel: Map<number, TriggerDef[]> }>();

function relationTriggers(cat: Catalog, relOid: number): TriggerDef[] {
  let index = triggersByRelation.get(cat);
  if (!index || index.version !== cat.version || index.size !== cat.triggers.size) {
    const byRel = new Map<number, TriggerDef[]>();
    for (const t of cat.triggers.values()) {
      let list = byRel.get(t.relOid);
      if (!list) {
        list = [];
        byRel.set(t.relOid, list);
      }
      list.push(t);
    }
    for (const list of byRel.values()) {
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    index = { version: cat.version, size: cat.triggers.size, byRel };
    triggersByRelation.set(cat, index);
  }
  return index.byRel.get(relOid) ?? NO_TRIGGERS;
}

/** FOR EACH STATEMENT triggers of a relation (BEFORE ones run before the first row, AFTER ones at the end of the statement). */
export function fireStatementTrigger(session: Session, rel: Relation, timing: 'BEFORE' | 'AFTER', event: 'INSERT' | 'UPDATE' | 'DELETE', st: StatementState, transition?: TransitionCapture): void {
  const cat = session.catalog();
  const triggers = relationTriggers(cat, rel.oid).filter((t) => t.enabled && t.timing === timing && t.events.includes(event) && !t.forEachRow);
  for (const trig of triggers) {
    const ast = triggerAst(session, trig.funcOid);
    const interp = new PlInterpreter(session, st, TypeOid.record, false);
    interp.transitionTables = transitionTablesOf(trig, rel, event, transition);
    const frame = triggerFrame(session, rel, trig, timing, event, 'STATEMENT');
    frame.vars.set('new', { name: 'new', type: rel.rowTypeOid, typmod: -1, value: null });
    frame.vars.set('old', { name: 'old', type: rel.rowTypeOid, typmod: -1, value: null });
    try {
      interp.execBlock(ast, frame);
    } catch (e) {
      if (!(e instanceof ReturnSignal)) {
        throw e;
      }
    }
  }
}

/** The transition tables a trigger declared, filled from the statement's captured rows. */
function transitionTablesOf(trig: TriggerDef, rel: Relation, event: 'INSERT' | 'UPDATE' | 'DELETE', transition: TransitionCapture | undefined): TransitionTable[] | null {
  if (!trig.newTable && !trig.oldTable) {
    return null;
  }
  const out: TransitionTable[] = [];
  if (trig.newTable) {
    out.push({ name: trig.newTable, rel, rows: (event === 'INSERT' ? transition?.insertNew : event === 'UPDATE' ? transition?.updateNew : undefined) ?? [] });
  }
  if (trig.oldTable) {
    out.push({ name: trig.oldTable, rel, rows: (event === 'DELETE' ? transition?.deleteOld : event === 'UPDATE' ? transition?.updateOld : undefined) ?? [] });
  }
  return out;
}

export function fireTrigger(
  session: Session,
  rel: Relation,
  timing: 'BEFORE' | 'AFTER',
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  newData: unknown[] | null,
  oldData: unknown[] | null,
  st: StatementState,
  transition?: TransitionCapture
): unknown[] | null | undefined {
  const cat = session.catalog();
  const triggers = relationTriggers(cat, rel.oid).filter((t) => t.enabled && t.timing === timing && t.events.includes(event) && t.forEachRow);
  if (triggers.length === 0) {
    return undefined;
  }
  const live = rel.columns.filter((c) => !c.isDropped);
  const toRecord = (data: unknown[] | null) =>
    data
      ? new PgRecord(
          live.map((c) => data[c.attnum - 1] ?? null),
          rel.rowTypeOid,
          live.map((c) => c.typeOid),
          live.map((c) => c.name)
        )
      : null;
  let current = newData;
  for (const trig of triggers) {
    // UPDATE OF columns: only when one of them is a target of the UPDATE
    if (event === 'UPDATE' && trig.updateColumns && trig.updateColumns.length > 0 && st.updateTargetColumns && !trig.updateColumns.some((name) => st.updateTargetColumns!.has(name))) {
      continue;
    }
    const ast = triggerAst(session, trig.funcOid);
    const interp = new PlInterpreter(session, st, TypeOid.record, false);
    interp.transitionTables = transitionTablesOf(trig, rel, event, transition);
    const frame = triggerFrame(session, rel, trig, timing, event, 'ROW');
    // OLD / NEW have the table's row type even when NULL (OLD in INSERT, NEW in DELETE triggers)
    frame.vars.set('new', { name: 'new', type: rel.rowTypeOid, typmod: -1, value: toRecord(current) });
    frame.vars.set('old', { name: 'old', type: rel.rowTypeOid, typmod: -1, value: toRecord(oldData) });
    if (trig.whenText && !interp.evalBool(trig.whenText, frame)) {
      continue;
    }
    let result: unknown = null;
    try {
      interp.execBlock(ast, frame);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        result = e.value;
      } else {
        throw e;
      }
    }
    if (timing === 'BEFORE') {
      if (result === null) {
        return null;
      }
      if (result instanceof PgRecord && current) {
        const data = current.slice();
        live.forEach((c, i) => {
          data[c.attnum - 1] = result instanceof PgRecord ? result.values[i] : data[c.attnum - 1];
        });
        current = data;
      }
    }
  }
  return current;
}
