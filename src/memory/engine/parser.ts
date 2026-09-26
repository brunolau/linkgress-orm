import * as A from './ast';
import { syntaxError } from './errors';
import { Token, tokenize } from './lexer';

/**
 * Recursive-descent PostgreSQL parser producing the raw parse tree in ast.ts.
 * Precedences follow src/backend/parser/gram.y.
 */

// Keyword categories (kwlist.h)
const RESERVED = new Set(
  (
    'ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC BOTH CASE CAST CHECK COLLATE COLUMN CONSTRAINT CREATE ' +
    'CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DEFERRABLE DESC ' +
    'DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FROM GRANT GROUP HAVING IN INITIALLY INTERSECT INTO LATERAL ' +
    'LEADING LIMIT LOCALTIME LOCALTIMESTAMP NOT NULL OFFSET ON ONLY OR ORDER PLACING PRIMARY REFERENCES RETURNING ' +
    'SELECT SESSION_USER SOME SYMMETRIC SYSTEM_USER TABLE THEN TO TRAILING TRUE UNION UNIQUE USER USING VARIADIC WHEN ' +
    'WHERE WINDOW WITH'
  ).split(' ')
);

const TYPE_FUNC_NAME = new Set(
  'AUTHORIZATION BINARY COLLATION CONCURRENTLY CROSS CURRENT_SCHEMA FREEZE FULL ILIKE INNER IS ISNULL JOIN LEFT LIKE NATURAL NOTNULL OUTER OVERLAPS RIGHT SIMILAR TABLESAMPLE VERBOSE'.split(
    ' '
  )
);

const COL_NAME = new Set(
  (
    'BETWEEN BIGINT BIT BOOLEAN CHAR CHARACTER COALESCE DEC DECIMAL EXISTS EXTRACT FLOAT GREATEST GROUPING INOUT INT ' +
    'INTEGER INTERVAL JSON JSON_ARRAY JSON_ARRAYAGG JSON_EXISTS JSON_OBJECT JSON_OBJECTAGG JSON_QUERY JSON_SCALAR ' +
    'JSON_SERIALIZE JSON_TABLE JSON_VALUE LEAST MERGE_ACTION NATIONAL NCHAR NONE NORMALIZE NULLIF NUMERIC OUT OVERLAY ' +
    'POSITION PRECISION REAL ROW SETOF SMALLINT SUBSTRING TIME TIMESTAMP TREAT TRIM VALUES VARCHAR XMLATTRIBUTES ' +
    'XMLCONCAT XMLELEMENT XMLEXISTS XMLFOREST XMLNAMESPACES XMLPARSE XMLPI XMLROOT XMLSERIALIZE XMLTABLE'
  ).split(' ')
);

/** Keywords that may only be used as a column label with AS. */
const AS_LABEL_ONLY = new Set(
  (
    'ARRAY AS CHAR CHARACTER CREATE DAY FETCH FILTER FOR FROM GRANT GROUP HAVING HOUR INTO ISNULL LIMIT MINUTE MONTH ' +
    'NOTNULL OFFSET ON ORDER OVER OVERLAPS PRECISION RETURNING SECOND TO UNION INTERSECT EXCEPT WHERE WINDOW WITH ' +
    'WITHIN WITHOUT VARYING YEAR ESCAPE UESCAPE IS LIKE ILIKE SIMILAR BETWEEN IN NOT AND OR COLLATE AT'
  ).split(' ')
);

// Expression precedence levels
const P_OR = 1;
const P_AND = 2;
const P_NOT = 3;
const P_IS = 4;
const P_CMP = 5;
const P_LIKE = 6;
const P_ESCAPE = 7;
const P_OP = 8;
const P_ADD = 9;
const P_MUL = 10;
const P_EXP = 11;
const P_AT = 12;
const P_COLLATE = 13;
const P_UMINUS = 14;

const SQL_TYPE_ALIASES: Record<string, string> = {
  int: 'int4',
  integer: 'int4',
  smallint: 'int2',
  bigint: 'int8',
  real: 'float4',
  boolean: 'bool',
  decimal: 'numeric',
  dec: 'numeric',
  numeric: 'numeric',
};

/** How the query reading of an ambiguous `((SELECT …` operand ended: its error, and the token index it stopped at. */
interface SublinkQueryFailure {
  error: unknown;
  at: number;
}

export class Parser {
  private toks: Token[];
  private p = 0;

  constructor(readonly sql: string) {
    this.toks = tokenize(sql);
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  peek(k = 0): Token {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }

  next(): Token {
    const t = this.toks[this.p];
    if (this.p < this.toks.length - 1) {
      this.p++;
    }
    return t;
  }

  get pos(): number {
    return this.p;
  }

  set pos(v: number) {
    this.p = v;
  }

  isKw(t: Token, ...kws: string[]): boolean {
    if (t.type !== 'ident' || t.quoted) {
      return false;
    }
    for (const k of kws) {
      if (t.kw === k) {
        return true;
      }
    }
    return false;
  }

  atKw(...kws: string[]): boolean {
    return this.isKw(this.peek(), ...kws);
  }

  acceptKw(...kws: string[]): boolean {
    if (this.atKw(...kws)) {
      this.next();
      return true;
    }
    return false;
  }

  /** Accept a sequence of keywords (all or nothing). */
  acceptKws(...kws: string[]): boolean {
    for (let i = 0; i < kws.length; i++) {
      if (!this.isKw(this.peek(i), kws[i])) {
        return false;
      }
    }
    this.p += kws.length;
    return true;
  }

  expectKw(...kws: string[]): Token {
    if (!this.atKw(...kws)) {
      this.error();
    }
    return this.next();
  }

  atPunct(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'punct' && t.value === v;
  }

  acceptPunct(v: string): boolean {
    if (this.atPunct(v)) {
      this.next();
      return true;
    }
    return false;
  }

  expectPunct(v: string): Token {
    if (!this.atPunct(v)) {
      this.error();
    }
    return this.next();
  }

  atOp(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'op' && t.value === v;
  }

  acceptOp(v: string): boolean {
    if (this.atOp(v)) {
      this.next();
      return true;
    }
    return false;
  }

  error(t: Token = this.peek()): never {
    if (t.type === 'eof') {
      throw syntaxError('syntax error at end of input', t.pos);
    }
    const text = this.sql.slice(t.pos, t.end);
    throw syntaxError(`syntax error at or near "${text}"`, t.pos);
  }

  textFrom(startTokIndex: number): string {
    const start = this.toks[startTokIndex].pos;
    const endTok = this.toks[Math.max(startTokIndex, this.p - 1)];
    return this.sql.slice(start, endTok.end);
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  /** ColId: identifier, unreserved keyword or col_name keyword. */
  isColId(t: Token): boolean {
    if (t.type !== 'ident') {
      return false;
    }
    if (t.quoted) {
      return true;
    }
    return !RESERVED.has(t.kw) && !TYPE_FUNC_NAME.has(t.kw);
  }

  /** type_function_name: identifier, unreserved keyword or type_func_name keyword. */
  isTypeFuncName(t: Token): boolean {
    if (t.type !== 'ident') {
      return false;
    }
    if (t.quoted) {
      return true;
    }
    return !RESERVED.has(t.kw) && !COL_NAME.has(t.kw);
  }

  /** ColLabel: any identifier or keyword. */
  isColLabel(t: Token): boolean {
    return t.type === 'ident';
  }

  parseColId(): string {
    const t = this.peek();
    if (!this.isColId(t)) {
      this.error();
    }
    this.next();
    return t.value;
  }

  parseColLabel(): string {
    const t = this.peek();
    if (t.type !== 'ident') {
      this.error();
    }
    this.next();
    return t.value;
  }

  /** Any identifier-like token as name (used in DDL where keywords are fine). */
  parseName(): string {
    const t = this.peek();
    if (t.type !== 'ident') {
      this.error();
    }
    this.next();
    return t.value;
  }

  /** any_name: ColId attrs */
  parseAnyName(): string[] {
    const names = [this.parseColIdOrKeywordName()];
    while (this.atPunct('.')) {
      this.next();
      names.push(this.parseColLabel());
    }
    return names;
  }

  private parseColIdOrKeywordName(): string {
    const t = this.peek();
    if (t.type !== 'ident') {
      this.error();
    }
    this.next();
    return t.value;
  }

  parseQualifiedName(): { schema?: string; catalog?: string; name: string } {
    const parts = this.parseAnyName();
    if (parts.length === 1) {
      return { name: parts[0] };
    }
    if (parts.length === 2) {
      return { schema: parts[0], name: parts[1] };
    }
    if (parts.length === 3) {
      return { catalog: parts[0], schema: parts[1], name: parts[2] };
    }
    throw syntaxError(`improper qualified name (too many dotted names): ${parts.join('.')}`, this.peek().pos);
  }

  parseRangeVar(): A.RangeVar {
    const loc = this.peek().pos;
    let inh = true;
    if (this.acceptKw('ONLY')) {
      inh = false;
      if (this.acceptPunct('(')) {
        const q = this.parseQualifiedName();
        this.expectPunct(')');
        return { kind: 'RangeVar', ...q, inh, loc };
      }
    }
    const q = this.parseQualifiedName();
    if (this.atOp('*')) {
      this.next();
    }
    return { kind: 'RangeVar', ...q, inh, loc };
  }

  parseNameList(): string[] {
    const names = [this.parseColIdOrKeywordName()];
    while (this.acceptPunct(',')) {
      names.push(this.parseColIdOrKeywordName());
    }
    return names;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  parseStatements(): A.ParsedStatement[] {
    const out: A.ParsedStatement[] = [];
    while (true) {
      while (this.acceptPunct(';')) {
        // empty statements
      }
      if (this.peek().type === 'eof') {
        break;
      }
      const startIdx = this.p;
      const start = this.peek().pos;
      const stmt = this.parseStatement();
      const endTok = this.toks[this.p - 1];
      if (!this.atPunct(';') && this.peek().type !== 'eof') {
        this.error();
      }
      out.push({ stmt, text: this.sql.slice(start, endTok.end), start, end: endTok.end });
      void startIdx;
    }
    return out;
  }

  parseStatement(): A.Statement {
    const t = this.peek();
    if (t.type === 'punct' && t.value === '(') {
      return this.parseSelectStatement();
    }
    if (t.type !== 'ident') {
      this.error();
    }
    switch (t.kw) {
      case 'SELECT':
      case 'VALUES':
      case 'TABLE':
        return this.parseSelectStatement();
      case 'WITH':
        return this.parseWithStatement();
      case 'INSERT':
        return this.parseInsert(undefined);
      case 'UPDATE':
        return this.parseUpdate(undefined);
      case 'DELETE':
        return this.parseDelete(undefined);
      case 'MERGE':
        return this.parseMerge(undefined);
      default:
        return this.parseUtilityStatement();
    }
  }

  /** Implemented in parser-ddl.ts (mixed into the prototype). */
  parseUtilityStatement(): A.Statement {
    this.error();
  }

  parseWithStatement(): A.Statement {
    const save = this.p;
    const withClause = this.parseWithClause();
    if (this.atKw('INSERT')) {
      return this.parseInsert(withClause);
    }
    if (this.atKw('UPDATE')) {
      return this.parseUpdate(withClause);
    }
    if (this.atKw('DELETE')) {
      return this.parseDelete(withClause);
    }
    if (this.atKw('MERGE')) {
      return this.parseMerge(withClause);
    }
    this.p = save;
    return this.parseSelectStatement();
  }

  parseWithClause(): A.WithClause {
    this.expectKw('WITH');
    const recursive = this.acceptKw('RECURSIVE');
    const ctes: A.CommonTableExpr[] = [];
    do {
      const loc = this.peek().pos;
      const name = this.parseColIdOrKeywordName();
      let aliasColnames: string[] | undefined;
      if (this.acceptPunct('(')) {
        aliasColnames = this.parseNameList();
        this.expectPunct(')');
      }
      this.expectKw('AS');
      let materialized: A.CommonTableExpr['materialized'] = 'DEFAULT';
      if (this.acceptKw('MATERIALIZED')) {
        materialized = 'ALWAYS';
      } else if (this.acceptKws('NOT', 'MATERIALIZED')) {
        materialized = 'NEVER';
      }
      this.expectPunct('(');
      const query = this.parsePreparableStatement();
      this.expectPunct(')');
      const cte: A.CommonTableExpr = { name, aliasColnames, materialized, query, loc };
      const searchLoc = this.peek().pos;
      if (this.acceptKw('SEARCH')) {
        const breadthFirst = this.acceptKw('BREADTH');
        if (!breadthFirst) {
          this.expectKw('DEPTH');
        }
        this.expectKw('FIRST');
        this.expectKw('BY');
        const columns = this.parseNameList();
        this.expectKw('SET');
        cte.search = { breadthFirst, columns, seqColumn: this.parseColId(), loc: searchLoc };
      }
      const cycleLoc = this.peek().pos;
      if (this.acceptKw('CYCLE')) {
        const columns = this.parseNameList();
        this.expectKw('SET');
        const markColumn = this.parseColId();
        let markValue: A.Expr | undefined;
        let markDefault: A.Expr | undefined;
        if (this.acceptKw('TO')) {
          markValue = this.parseExprPrimaryConst();
          this.expectKw('DEFAULT');
          markDefault = this.parseExprPrimaryConst();
        }
        this.expectKw('USING');
        cte.cycle = { columns, markColumn, markValue, markDefault, pathColumn: this.parseColId(), loc: cycleLoc };
      }
      ctes.push(cte);
    } while (this.acceptPunct(','));
    return { recursive, ctes };
  }

  private parseExprPrimaryConst(): A.Expr {
    return this.parseExpr(P_UMINUS);
  }

  /** PreparableStmt: SELECT / INSERT / UPDATE / DELETE / MERGE (used by CTEs, EXPLAIN, PREPARE). */
  parsePreparableStatement(): A.Statement {
    if (this.atKw('WITH')) {
      return this.parseWithStatement();
    }
    if (this.atKw('INSERT')) {
      return this.parseInsert(undefined);
    }
    if (this.atKw('UPDATE')) {
      return this.parseUpdate(undefined);
    }
    if (this.atKw('DELETE')) {
      return this.parseDelete(undefined);
    }
    if (this.atKw('MERGE')) {
      return this.parseMerge(undefined);
    }
    return this.parseSelectStatement();
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  static emptySelect(loc?: number): A.SelectStmt {
    return {
      kind: 'SelectStmt',
      op: 'NONE',
      all: false,
      distinct: null,
      targetList: [],
      from: [],
      where: null,
      groupBy: [],
      groupDistinct: false,
      having: null,
      windows: [],
      sortClause: [],
      limitCount: null,
      limitOffset: null,
      limitWithTies: false,
      locking: [],
      loc,
    };
  }

  /** select_no_parens / select_with_parens at statement level. */
  parseSelectStatement(): A.SelectStmt {
    let withClause: A.WithClause | undefined;
    if (this.atKw('WITH')) {
      withClause = this.parseWithClause();
    }
    let body = this.parseSetOperation(0);
    body = this.parseSelectTail(body, withClause);
    return body;
  }

  private parseSelectTail(body: A.SelectStmt, withClause: A.WithClause | undefined): A.SelectStmt {
    const hasTail = this.atKw('ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR') || withClause !== undefined;
    if (!hasTail) {
      return body;
    }
    // If the body already carries sort/limit (from parentheses) and a set-op is not in play, wrap it.
    const needsWrap = (b: A.SelectStmt) =>
      b.op === 'NONE' && (b.sortClause.length > 0 || b.limitCount !== null || b.limitOffset !== null || b.locking.length > 0 || b.with !== undefined);
    if (withClause) {
      if (body.with) {
        throw syntaxError('multiple WITH clauses not allowed', this.peek().pos);
      }
      body.with = withClause;
    }
    if (this.atKw('ORDER')) {
      if (body.sortClause.length > 0) {
        if (needsWrap(body)) {
          throw syntaxError('multiple ORDER BY clauses not allowed', this.peek().pos);
        }
      }
      this.next();
      this.expectKw('BY');
      body.sortClause = this.parseSortList();
    }
    // LIMIT/OFFSET/FETCH and FOR UPDATE may come in either order
    for (let guard = 0; guard < 6; guard++) {
      if (this.atKw('LIMIT')) {
        this.next();
        if (this.acceptKw('ALL')) {
          body.limitCount = { kind: 'AConst', val: { type: 'null' } };
        } else {
          body.limitCount = this.parseExpr();
        }
        if (this.acceptPunct(',')) {
          throw syntaxError('LIMIT #,# syntax is not supported', this.peek().pos);
        }
        continue;
      }
      if (this.atKw('OFFSET')) {
        this.next();
        body.limitOffset = this.parseExpr();
        this.acceptKw('ROW', 'ROWS');
        continue;
      }
      if (this.atKw('FETCH')) {
        this.next();
        this.expectKw('FIRST', 'NEXT');
        let count: A.Expr = { kind: 'AConst', val: { type: 'integer', value: '1' } };
        if (!this.atKw('ROW', 'ROWS')) {
          count = this.parseExpr(P_UMINUS - 1);
        }
        this.expectKw('ROW', 'ROWS');
        if (this.acceptKw('ONLY')) {
          body.limitWithTies = false;
        } else {
          this.expectKw('WITH');
          this.expectKw('TIES');
          body.limitWithTies = true;
        }
        body.limitCount = count;
        continue;
      }
      if (this.atKw('FOR')) {
        body.locking.push(this.parseLockingClause());
        continue;
      }
      break;
    }
    return body;
  }

  private parseLockingClause(): A.LockingClause {
    this.expectKw('FOR');
    let strength: A.LockingClause['strength'];
    if (this.acceptKw('UPDATE')) {
      strength = 'UPDATE';
    } else if (this.acceptKws('NO', 'KEY', 'UPDATE')) {
      strength = 'NO KEY UPDATE';
    } else if (this.acceptKw('SHARE')) {
      strength = 'SHARE';
    } else if (this.acceptKws('KEY', 'SHARE')) {
      strength = 'KEY SHARE';
    } else {
      this.error();
    }
    const lockedRels: A.RangeVar[] = [];
    if (this.acceptKw('OF')) {
      do {
        lockedRels.push(this.parseRangeVar());
      } while (this.acceptPunct(','));
    }
    let waitPolicy: A.LockingClause['waitPolicy'] = 'BLOCK';
    if (this.acceptKw('NOWAIT')) {
      waitPolicy = 'NOWAIT';
    } else if (this.acceptKws('SKIP', 'LOCKED')) {
      waitPolicy = 'SKIP';
    }
    return { strength, lockedRels, waitPolicy };
  }

  /** UNION/EXCEPT (level 1) and INTERSECT (level 2), left-assoc. */
  private parseSetOperation(minLevel: number): A.SelectStmt {
    let left = this.parseSelectPrimary();
    while (true) {
      const t = this.peek();
      let level = 0;
      let op: 'UNION' | 'INTERSECT' | 'EXCEPT' | null = null;
      if (this.isKw(t, 'UNION')) {
        level = 1;
        op = 'UNION';
      } else if (this.isKw(t, 'EXCEPT')) {
        level = 1;
        op = 'EXCEPT';
      } else if (this.isKw(t, 'INTERSECT')) {
        level = 2;
        op = 'INTERSECT';
      }
      if (!op || level <= minLevel) {
        break;
      }
      this.next();
      let all = false;
      if (this.acceptKw('ALL')) {
        all = true;
      } else {
        this.acceptKw('DISTINCT');
      }
      const right = this.parseSetOperation(level);
      const node = Parser.emptySelect(t.pos);
      node.op = op;
      node.all = all;
      node.larg = left;
      node.rarg = right;
      left = node;
    }
    return left;
  }

  private parseSelectPrimary(): A.SelectStmt {
    const t = this.peek();
    if (t.type === 'punct' && t.value === '(') {
      this.next();
      const inner = this.parseSelectStatement();
      this.expectPunct(')');
      return inner;
    }
    if (this.isKw(t, 'VALUES')) {
      return this.parseValuesClause();
    }
    if (this.isKw(t, 'TABLE')) {
      this.next();
      const rel = this.parseRangeVar();
      const s = Parser.emptySelect(t.pos);
      s.targetList = [{ val: { kind: 'ColumnRef', fields: ['*'], loc: t.pos } }];
      s.from = [rel];
      return s;
    }
    if (!this.isKw(t, 'SELECT')) {
      this.error();
    }
    return this.parseSimpleSelect();
  }

  parseValuesClause(): A.SelectStmt {
    const t = this.expectKw('VALUES');
    const s = Parser.emptySelect(t.pos);
    s.values = [];
    do {
      this.expectPunct('(');
      const row: A.Expr[] = [];
      do {
        row.push(this.parseExprOrDefault());
      } while (this.acceptPunct(','));
      this.expectPunct(')');
      s.values.push(row);
    } while (this.acceptPunct(','));
    return s;
  }

  parseExprOrDefault(): A.Expr {
    if (this.atKw('DEFAULT')) {
      const t = this.next();
      return { kind: 'SetToDefault', loc: t.pos };
    }
    return this.parseExpr();
  }

  private parseSimpleSelect(): A.SelectStmt {
    const t = this.expectKw('SELECT');
    const s = Parser.emptySelect(t.pos);
    if (this.acceptKw('ALL')) {
      // default
    } else if (this.acceptKw('DISTINCT')) {
      s.distinct = [];
      if (this.acceptKw('ON')) {
        this.expectPunct('(');
        s.distinct = this.parseExprList();
        this.expectPunct(')');
      }
    }
    // target list (may be empty: SELECT FROM t)
    if (!this.atSelectClauseEnd()) {
      s.targetList = this.parseTargetList();
    }
    if (this.atKw('INTO')) {
      this.next();
      let temp = false;
      if (this.acceptKw('TEMPORARY', 'TEMP')) {
        temp = true;
      } else if (this.acceptKw('UNLOGGED')) {
        // ignore
      }
      this.acceptKw('TABLE');
      s.into = { rel: this.parseRangeVar(), temp };
    }
    if (this.acceptKw('FROM')) {
      s.from = this.parseFromList();
    }
    if (this.acceptKw('WHERE')) {
      s.where = this.parseExpr();
    }
    if (this.atKw('GROUP')) {
      this.next();
      this.expectKw('BY');
      if (this.acceptKw('DISTINCT')) {
        s.groupDistinct = true;
      } else {
        this.acceptKw('ALL');
      }
      s.groupBy = this.parseGroupByList();
    }
    if (this.acceptKw('HAVING')) {
      s.having = this.parseExpr();
    }
    if (this.acceptKw('WINDOW')) {
      do {
        const name = this.parseColId();
        this.expectKw('AS');
        const def = this.parseWindowSpecification();
        def.name = name;
        s.windows.push(def);
      } while (this.acceptPunct(','));
    }
    return s;
  }

  private atSelectClauseEnd(): boolean {
    const t = this.peek();
    if (t.type === 'eof') {
      return true;
    }
    if (t.type === 'punct' && (t.value === ')' || t.value === ';')) {
      return true;
    }
    return this.isKw(t, 'FROM', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'INTO');
  }

  parseTargetList(): A.ResTarget[] {
    const list: A.ResTarget[] = [];
    do {
      list.push(this.parseTarget());
    } while (this.acceptPunct(','));
    return list;
  }

  private parseTarget(): A.ResTarget {
    const loc = this.peek().pos;
    if (this.atOp('*')) {
      this.next();
      return { val: { kind: 'ColumnRef', fields: ['*'], loc }, loc };
    }
    const val = this.parseExpr();
    if (this.acceptKw('AS')) {
      return { name: this.parseColLabel(), val, loc };
    }
    const t = this.peek();
    if (t.type === 'ident' && (t.quoted || (!AS_LABEL_ONLY.has(t.kw) && !RESERVED.has(t.kw)))) {
      this.next();
      return { name: t.value, val, loc };
    }
    return { val, loc };
  }

  parseExprList(): A.Expr[] {
    const list: A.Expr[] = [];
    do {
      list.push(this.parseExpr());
    } while (this.acceptPunct(','));
    return list;
  }

  parseSortList(): A.SortBy[] {
    const list: A.SortBy[] = [];
    do {
      const loc = this.peek().pos;
      const node = this.parseExpr();
      let dir: A.SortBy['dir'] = 'DEFAULT';
      let useOp: string[] | undefined;
      if (this.acceptKw('ASC')) {
        dir = 'ASC';
      } else if (this.acceptKw('DESC')) {
        dir = 'DESC';
      } else if (this.acceptKw('USING')) {
        dir = 'USING';
        useOp = this.parseQualOp();
      }
      let nulls: A.SortBy['nulls'] = 'DEFAULT';
      if (this.acceptKw('NULLS')) {
        if (this.acceptKw('FIRST')) {
          nulls = 'FIRST';
        } else {
          this.expectKw('LAST');
          nulls = 'LAST';
        }
      }
      list.push({ kind: 'SortBy', node, dir, nulls, useOp, loc });
    } while (this.acceptPunct(','));
    return list;
  }

  private parseQualOp(): string[] {
    if (this.acceptKw('OPERATOR')) {
      this.expectPunct('(');
      const names: string[] = [];
      while (this.peek().type === 'ident') {
        names.push(this.next().value);
        this.expectPunct('.');
      }
      const op = this.next();
      if (op.type !== 'op') {
        this.error(op);
      }
      names.push(op.value);
      this.expectPunct(')');
      return names;
    }
    const t = this.next();
    if (t.type !== 'op') {
      this.error(t);
    }
    return [t.value];
  }

  private parseGroupByList(): A.GroupItem[] {
    const items: A.GroupItem[] = [];
    do {
      items.push(this.parseGroupItem());
    } while (this.acceptPunct(','));
    return items;
  }

  private parseGroupItem(): A.GroupItem {
    if (this.atPunct('(') && this.atPunct(')', 1)) {
      this.next();
      this.next();
      return { kind: 'empty' };
    }
    if (this.atKw('ROLLUP', 'CUBE') && this.atPunct('(', 1)) {
      const kind = this.next().kw === 'ROLLUP' ? 'rollup' : 'cube';
      this.expectPunct('(');
      const items: A.Expr[][] = [];
      do {
        items.push(this.parseGroupingElementExprs());
      } while (this.acceptPunct(','));
      this.expectPunct(')');
      return { kind, items } as A.GroupItem;
    }
    if (this.atKw('GROUPING') && this.isKw(this.peek(1), 'SETS')) {
      this.next();
      this.next();
      this.expectPunct('(');
      const sets = this.parseGroupByList();
      this.expectPunct(')');
      return { kind: 'sets', sets };
    }
    return { kind: 'expr', expr: this.parseExpr() };
  }

  private parseGroupingElementExprs(): A.Expr[] {
    const e = this.parseExpr();
    if (e.kind === 'RowExpr' && !e.explicitRow) {
      return e.args;
    }
    if (e.kind === 'ParenExpr') {
      return [e.arg];
    }
    return [e];
  }

  private parseWindowSpecification(): A.WindowDef {
    const loc = this.expectPunct('(').pos;
    const def: A.WindowDef = { kind: 'WindowDef', partitionClause: [], orderClause: [], loc };
    const t = this.peek();
    if (t.type === 'ident' && !this.isKw(t, 'PARTITION', 'ORDER', 'RANGE', 'ROWS', 'GROUPS') && this.isColId(t)) {
      def.refname = this.parseColId();
    }
    if (this.acceptKw('PARTITION')) {
      this.expectKw('BY');
      def.partitionClause = this.parseExprList();
    }
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY');
      def.orderClause = this.parseSortList();
    }
    if (this.atKw('RANGE', 'ROWS', 'GROUPS')) {
      const mode = this.next().kw as A.WindowFrame['mode'];
      let start: A.FrameBound;
      let end: A.FrameBound = { type: 'CURRENT_ROW' };
      if (this.acceptKw('BETWEEN')) {
        start = this.parseFrameBound();
        this.expectKw('AND');
        end = this.parseFrameBound();
      } else {
        start = this.parseFrameBound();
      }
      let exclusion: A.WindowFrame['exclusion'] = 'NO_OTHERS';
      if (this.acceptKw('EXCLUDE')) {
        if (this.acceptKws('CURRENT', 'ROW')) {
          exclusion = 'CURRENT_ROW';
        } else if (this.acceptKw('GROUP')) {
          exclusion = 'GROUP';
        } else if (this.acceptKw('TIES')) {
          exclusion = 'TIES';
        } else {
          this.expectKw('NO');
          this.expectKw('OTHERS');
        }
      }
      def.frame = { mode, start, end, exclusion };
    }
    this.expectPunct(')');
    return def;
  }

  private parseFrameBound(): A.FrameBound {
    if (this.acceptKw('UNBOUNDED')) {
      if (this.acceptKw('PRECEDING')) {
        return { type: 'UNBOUNDED_PRECEDING' };
      }
      this.expectKw('FOLLOWING');
      return { type: 'UNBOUNDED_FOLLOWING' };
    }
    if (this.acceptKws('CURRENT', 'ROW')) {
      return { type: 'CURRENT_ROW' };
    }
    const offset = this.parseExpr(P_AND);
    if (this.acceptKw('PRECEDING')) {
      return { type: 'PRECEDING', offset };
    }
    this.expectKw('FOLLOWING');
    return { type: 'FOLLOWING', offset };
  }

  // -------------------------------------------------------------------------
  // FROM
  // -------------------------------------------------------------------------

  parseFromList(): A.FromItem[] {
    const list: A.FromItem[] = [];
    do {
      list.push(this.parseTableRef());
    } while (this.acceptPunct(','));
    return list;
  }

  parseTableRef(): A.FromItem {
    let left = this.parseTableRefPrimary();
    while (true) {
      const loc = this.peek().pos;
      if (this.atKw('CROSS') && this.isKw(this.peek(1), 'JOIN')) {
        this.next();
        this.next();
        const right = this.parseTableRefPrimary();
        left = { kind: 'JoinExpr', joinType: 'CROSS', isNatural: false, larg: left, rarg: right, quals: null, loc };
        continue;
      }
      let natural = false;
      const save = this.p;
      if (this.acceptKw('NATURAL')) {
        natural = true;
      }
      let joinType: A.JoinExpr['joinType'] | null = null;
      if (this.acceptKw('JOIN')) {
        joinType = 'INNER';
      } else if (this.atKw('INNER') && this.isKw(this.peek(1), 'JOIN')) {
        this.p += 2;
        joinType = 'INNER';
      } else if (this.atKw('LEFT', 'RIGHT', 'FULL')) {
        const kw = this.peek().kw;
        const k1 = this.peek(1);
        if (this.isKw(k1, 'JOIN')) {
          this.p += 2;
          joinType = kw as A.JoinExpr['joinType'];
        } else if (this.isKw(k1, 'OUTER') && this.isKw(this.peek(2), 'JOIN')) {
          this.p += 3;
          joinType = kw as A.JoinExpr['joinType'];
        }
      }
      if (!joinType) {
        this.p = save;
        break;
      }
      const right = this.parseTableRefPrimary();
      const join: A.JoinExpr = { kind: 'JoinExpr', joinType, isNatural: natural, larg: left, rarg: right, quals: null, loc };
      if (!natural) {
        if (this.acceptKw('ON')) {
          join.quals = this.parseExpr();
        } else if (this.acceptKw('USING')) {
          this.expectPunct('(');
          join.usingClause = this.parseNameList();
          this.expectPunct(')');
          if (this.acceptKw('AS')) {
            join.joinUsingAlias = this.parseColId();
          }
        } else {
          this.error();
        }
      }
      left = join;
    }
    return left;
  }

  private parseTableRefPrimary(): A.FromItem {
    const t = this.peek();
    const loc = t.pos;
    let lateral = false;
    if (this.isKw(t, 'LATERAL')) {
      this.next();
      lateral = true;
    }
    const cur = this.peek();
    if (cur.type === 'punct' && cur.value === '(') {
      // subquery or parenthesized join
      if (this.looksLikeSubquery(0)) {
        this.next();
        const sub = this.parseSelectStatement();
        this.expectPunct(')');
        const alias = this.parseOptAlias(false);
        return { kind: 'RangeSubselect', lateral, subquery: sub, alias, loc };
      }
      this.next();
      const inner = this.parseTableRef();
      this.expectPunct(')');
      const alias = this.parseOptAlias(false);
      if (alias) {
        if (inner.kind === 'JoinExpr') {
          inner.alias = alias;
        } else {
          (inner as A.RangeVar).alias = alias;
        }
      }
      return inner;
    }
    if (this.isKw(cur, 'ROWS') && this.isKw(this.peek(1), 'FROM')) {
      this.next();
      this.next();
      this.expectPunct('(');
      const functions: A.RangeFunctionItem[] = [];
      do {
        const func = this.parseFuncExprWindowless();
        let coldeflist: A.ColumnDefShort[] | undefined;
        if (this.acceptKw('AS')) {
          this.expectPunct('(');
          coldeflist = this.parseColDefShortList();
          this.expectPunct(')');
        }
        functions.push({ func, coldeflist });
      } while (this.acceptPunct(','));
      this.expectPunct(')');
      const ordinality = this.acceptKws('WITH', 'ORDINALITY');
      const rf: A.RangeFunction = { kind: 'RangeFunction', lateral, ordinality, isRowsFrom: true, functions, loc };
      this.parseFuncAlias(rf);
      return rf;
    }
    // function call in FROM?
    if (cur.type === 'ident' && this.isFunctionCallAhead()) {
      const func = this.parseFuncExprWindowless();
      const ordinality = this.acceptKws('WITH', 'ORDINALITY');
      const rf: A.RangeFunction = { kind: 'RangeFunction', lateral, ordinality, isRowsFrom: false, functions: [{ func }], loc };
      this.parseFuncAlias(rf);
      return rf;
    }
    if (this.isKw(cur, 'XMLTABLE', 'JSON_TABLE')) {
      this.error();
    }
    const rv = this.parseRangeVar();
    rv.loc = loc;
    rv.alias = this.parseOptAlias(false);
    if (this.atKw('TABLESAMPLE')) {
      this.error();
    }
    return rv;
  }

  /** Is the token stream at `(` followed (possibly through more parens) by a query? */
  looksLikeSubquery(k: number): boolean {
    let i = k;
    while (this.atPunct('(', i)) {
      i++;
    }
    if (i === k) {
      return false;
    }
    const t = this.peek(i);
    return this.isKw(t, 'SELECT', 'VALUES', 'WITH', 'TABLE');
  }

  private isFunctionCallAhead(): boolean {
    let i = 0;
    if (this.peek(i).type !== 'ident') {
      return false;
    }
    i++;
    while (this.atPunct('.', i) && this.peek(i + 1).type === 'ident') {
      i += 2;
    }
    return this.atPunct('(', i);
  }

  private parseFuncAlias(rf: A.RangeFunction): void {
    if (this.acceptKw('AS')) {
      if (this.atPunct('(')) {
        this.next();
        rf.coldeflist = this.parseColDefShortList();
        this.expectPunct(')');
        return;
      }
      const name = this.parseColId();
      rf.alias = { name };
      if (this.acceptPunct('(')) {
        this.parseAliasColumnsOrDefs(rf);
        this.expectPunct(')');
      }
      return;
    }
    const t = this.peek();
    if (this.isColId(t) && !this.isJoinOrClauseKeyword(t)) {
      rf.alias = { name: this.parseColId() };
      if (this.acceptPunct('(')) {
        this.parseAliasColumnsOrDefs(rf);
        this.expectPunct(')');
      }
    }
  }

  private parseAliasColumnsOrDefs(rf: A.RangeFunction): void {
    // either a plain name list or a column definition list (name type, ...)
    const names: string[] = [];
    const defs: A.ColumnDefShort[] = [];
    do {
      const name = this.parseColIdOrKeywordName();
      if (!this.atPunct(',') && !this.atPunct(')')) {
        defs.push({ name, typeName: this.parseTypeName() });
      } else {
        names.push(name);
      }
    } while (this.acceptPunct(','));
    if (defs.length > 0) {
      rf.coldeflist = defs;
    } else {
      rf.alias!.colnames = names;
    }
  }

  parseColDefShortList(): A.ColumnDefShort[] {
    const defs: A.ColumnDefShort[] = [];
    do {
      const name = this.parseColIdOrKeywordName();
      defs.push({ name, typeName: this.parseTypeName() });
    } while (this.acceptPunct(','));
    return defs;
  }

  private isJoinOrClauseKeyword(t: Token): boolean {
    return this.isKw(
      t,
      'ON',
      'USING',
      'JOIN',
      'INNER',
      'LEFT',
      'RIGHT',
      'FULL',
      'CROSS',
      'NATURAL',
      'WHERE',
      'GROUP',
      'HAVING',
      'WINDOW',
      'ORDER',
      'LIMIT',
      'OFFSET',
      'FETCH',
      'FOR',
      'UNION',
      'INTERSECT',
      'EXCEPT',
      'RETURNING',
      'SET',
      'WITH',
      'WHEN',
      'TABLESAMPLE',
      'VALUES',
      'SELECT',
      'INTO',
      'DO'
    );
  }

  parseOptAlias(requireAsForKeywords: boolean): A.Alias | undefined {
    void requireAsForKeywords;
    if (this.acceptKw('AS')) {
      const name = this.parseColIdOrKeywordName();
      const alias: A.Alias = { name };
      if (this.acceptPunct('(')) {
        alias.colnames = this.parseNameList();
        this.expectPunct(')');
      }
      return alias;
    }
    const t = this.peek();
    if (this.isColId(t) && !this.isJoinOrClauseKeyword(t)) {
      this.next();
      const alias: A.Alias = { name: t.value };
      if (this.acceptPunct('(')) {
        alias.colnames = this.parseNameList();
        this.expectPunct(')');
      }
      return alias;
    }
    return undefined;
  }

  private parseFuncExprWindowless(): A.Expr {
    const e = this.parseExpr(P_UMINUS);
    return e;
  }

  // -------------------------------------------------------------------------
  // DML
  // -------------------------------------------------------------------------

  parseInsert(withClause: A.WithClause | undefined): A.InsertStmt {
    const t = this.expectKw('INSERT');
    this.expectKw('INTO');
    const relation = this.parseRangeVar();
    if (this.acceptKw('AS')) {
      relation.alias = { name: this.parseColId() };
    }
    const stmt: A.InsertStmt = { kind: 'InsertStmt', with: withClause, relation, select: null, loc: t.pos };
    if (this.atPunct('(') && !this.looksLikeSubquery(0)) {
      this.next();
      stmt.cols = [];
      do {
        const loc = this.peek().pos;
        const name = this.parseColIdOrKeywordName();
        const indirection = this.parseOptIndirectionForTarget();
        stmt.cols.push({ name, val: { kind: 'SetToDefault' }, indirection, loc });
      } while (this.acceptPunct(','));
      this.expectPunct(')');
    }
    if (this.acceptKw('OVERRIDING')) {
      if (this.acceptKw('SYSTEM')) {
        stmt.override = 'SYSTEM';
      } else {
        this.expectKw('USER');
        stmt.override = 'USER';
      }
      this.expectKw('VALUE');
    }
    if (this.acceptKws('DEFAULT', 'VALUES')) {
      stmt.select = null;
    } else {
      stmt.select = this.parseSelectStatement();
    }
    if (this.atKw('ON') && this.isKw(this.peek(1), 'CONFLICT')) {
      this.next();
      this.next();
      const oc: A.OnConflictClause = { action: 'NOTHING', targetList: [], where: null };
      if (this.acceptPunct('(')) {
        oc.inferElems = this.parseIndexElems();
        this.expectPunct(')');
        if (this.acceptKw('WHERE')) {
          oc.inferWhere = this.parseExpr();
        }
      } else if (this.acceptKws('ON', 'CONSTRAINT')) {
        oc.constraintName = this.parseName();
      }
      this.expectKw('DO');
      if (this.acceptKw('NOTHING')) {
        oc.action = 'NOTHING';
      } else {
        this.expectKw('UPDATE');
        this.expectKw('SET');
        oc.action = 'UPDATE';
        const items = this.parseSetClauseList();
        oc.targetList = this.flattenSetClauses(items);
        if (this.acceptKw('WHERE')) {
          oc.where = this.parseExpr();
        }
      }
      stmt.onConflict = oc;
    }
    if (this.atKw('RETURNING')) {
      stmt.returning = this.parseReturning();
    }
    return stmt;
  }

  /** ON CONFLICT ... SET: multi-assign is converted to per-column MultiAssign targets. */
  private flattenSetClauses(items: A.SetClauseItem[]): A.ResTarget[] {
    const out: A.ResTarget[] = [];
    for (const item of items) {
      if (item.kind === 'single') {
        out.push(item.target);
      } else {
        item.targets.forEach((target, i) => {
          out.push({
            name: target.name,
            indirection: target.indirection,
            loc: target.loc,
            val: {
              kind: 'FuncCall',
              name: ['__multiassign'],
              args: [
                item.isSubselect
                  ? { kind: 'SubLink', linkType: 'EXPR', testexpr: null, operName: [], subselect: item.source as A.SelectStmt }
                  : (item.source as A.Expr),
                { kind: 'AConst', val: { type: 'integer', value: String(i + 1) } },
                { kind: 'AConst', val: { type: 'integer', value: String(item.targets.length) } },
              ],
              aggOrder: [],
              aggFilter: null,
              aggWithinGroup: false,
              aggStar: false,
              aggDistinct: false,
              funcVariadic: false,
              over: null,
            },
          });
        });
      }
    }
    return out;
  }

  parseReturning(): A.ReturningClause {
    this.expectKw('RETURNING');
    const clause: A.ReturningClause = { targets: [] };
    if (this.atKw('WITH') && this.atPunct('(', 1)) {
      this.next();
      this.next();
      do {
        const which = this.expectKw('OLD', 'NEW').kw;
        this.expectKw('AS');
        const alias = this.parseColId();
        if (which === 'OLD') {
          clause.oldAlias = alias;
        } else {
          clause.newAlias = alias;
        }
      } while (this.acceptPunct(','));
      this.expectPunct(')');
    }
    clause.targets = this.parseTargetList();
    return clause;
  }

  private parseOptIndirectionForTarget(): A.IndirectionEl[] | undefined {
    const ind: A.IndirectionEl[] = [];
    while (true) {
      if (this.atPunct('.')) {
        this.next();
        if (this.atOp('*')) {
          this.next();
          ind.push({ type: 'star' });
        } else {
          ind.push({ type: 'field', name: this.parseColLabel() });
        }
        continue;
      }
      if (this.atPunct('[')) {
        ind.push(this.parseSubscript());
        continue;
      }
      break;
    }
    return ind.length ? ind : undefined;
  }

  parseSetClauseList(): A.SetClauseItem[] {
    const items: A.SetClauseItem[] = [];
    do {
      const loc = this.peek().pos;
      if (this.atPunct('(')) {
        this.next();
        const targets: A.ResTarget[] = [];
        do {
          const tloc = this.peek().pos;
          const name = this.parseColIdOrKeywordName();
          targets.push({ name, val: { kind: 'SetToDefault' }, indirection: this.parseOptIndirectionForTarget(), loc: tloc });
        } while (this.acceptPunct(','));
        this.expectPunct(')');
        this.expectOp('=');
        const sub = this.parseParenthesizedSublinkQuery();
        if (sub.query) {
          items.push({ kind: 'multi', targets, source: sub.query, isSubselect: true, loc });
        } else {
          const src = this.parseAfterSublinkQuery(sub.failure, () => this.parseExprOrDefaultRow());
          items.push({ kind: 'multi', targets, source: src, isSubselect: false, loc });
        }
        continue;
      }
      const name = this.parseColIdOrKeywordName();
      const indirection = this.parseOptIndirectionForTarget();
      this.expectOp('=');
      const val = this.parseExprOrDefault();
      items.push({ kind: 'single', target: { name, val, indirection, loc } });
    } while (this.acceptPunct(','));
    return items;
  }

  /** Row source for SET (a,b) = (x, DEFAULT) / ROW(...). */
  private parseExprOrDefaultRow(): A.Expr {
    if (this.atKw('ROW')) {
      return this.parseExpr();
    }
    const loc = this.expectPunct('(').pos;
    const args: A.Expr[] = [];
    do {
      args.push(this.parseExprOrDefault());
    } while (this.acceptPunct(','));
    this.expectPunct(')');
    return { kind: 'RowExpr', args, explicitRow: false, loc };
  }

  expectOp(v: string): void {
    if (!this.atOp(v)) {
      this.error();
    }
    this.next();
  }

  parseUpdate(withClause: A.WithClause | undefined): A.UpdateStmt {
    const t = this.expectKw('UPDATE');
    const relation = this.parseRangeVar();
    relation.alias = this.parseDmlAlias();
    this.expectKw('SET');
    const targetList = this.parseSetClauseList();
    const stmt: A.UpdateStmt = { kind: 'UpdateStmt', with: withClause, relation, targetList, from: [], where: null, loc: t.pos };
    if (this.acceptKw('FROM')) {
      stmt.from = this.parseFromList();
    }
    if (this.acceptKw('WHERE')) {
      if (this.acceptKws('CURRENT', 'OF')) {
        this.error();
      }
      stmt.where = this.parseExpr();
    }
    if (this.atKw('RETURNING')) {
      stmt.returning = this.parseReturning();
    }
    return stmt;
  }

  private parseDmlAlias(): A.Alias | undefined {
    if (this.acceptKw('AS')) {
      return { name: this.parseColId() };
    }
    const t = this.peek();
    if (this.isColId(t) && !this.isKw(t, 'SET', 'USING', 'WHERE', 'RETURNING')) {
      this.next();
      return { name: t.value };
    }
    return undefined;
  }

  parseDelete(withClause: A.WithClause | undefined): A.DeleteStmt {
    const t = this.expectKw('DELETE');
    this.expectKw('FROM');
    const relation = this.parseRangeVar();
    relation.alias = this.parseDmlAlias();
    const stmt: A.DeleteStmt = { kind: 'DeleteStmt', with: withClause, relation, using: [], where: null, loc: t.pos };
    if (this.acceptKw('USING')) {
      stmt.using = this.parseFromList();
    }
    if (this.acceptKw('WHERE')) {
      stmt.where = this.parseExpr();
    }
    if (this.atKw('RETURNING')) {
      stmt.returning = this.parseReturning();
    }
    return stmt;
  }

  parseMerge(withClause: A.WithClause | undefined): A.MergeStmt {
    const t = this.expectKw('MERGE');
    this.expectKw('INTO');
    const relation = this.parseRangeVar();
    if (this.acceptKw('AS')) {
      relation.alias = { name: this.parseColId() };
    } else if (this.isColId(this.peek()) && !this.atKw('USING')) {
      relation.alias = { name: this.parseColId() };
    }
    this.expectKw('USING');
    const source = this.parseTableRefPrimary();
    this.expectKw('ON');
    const joinCondition = this.parseExpr();
    const whenClauses: A.MergeWhenClause[] = [];
    while (this.acceptKw('WHEN')) {
      let matchKind: A.MergeWhenClause['matchKind'];
      if (this.acceptKw('MATCHED')) {
        matchKind = 'MATCHED';
      } else {
        this.expectKw('NOT');
        this.expectKw('MATCHED');
        if (this.acceptKws('BY', 'SOURCE')) {
          matchKind = 'NOT_MATCHED_BY_SOURCE';
        } else {
          this.acceptKws('BY', 'TARGET');
          matchKind = 'NOT_MATCHED_BY_TARGET';
        }
      }
      let condition: A.Expr | null = null;
      if (this.acceptKw('AND')) {
        condition = this.parseExpr();
      }
      this.expectKw('THEN');
      const clause: A.MergeWhenClause = { matchKind, condition, command: 'NOTHING', targetList: [] };
      if (this.acceptKw('UPDATE')) {
        this.expectKw('SET');
        clause.command = 'UPDATE';
        clause.targetList = this.parseSetClauseList();
      } else if (this.acceptKw('DELETE')) {
        clause.command = 'DELETE';
      } else if (this.acceptKw('INSERT')) {
        clause.command = 'INSERT';
        if (this.acceptPunct('(')) {
          clause.insertCols = [];
          do {
            const loc = this.peek().pos;
            clause.insertCols.push({ name: this.parseColIdOrKeywordName(), val: { kind: 'SetToDefault' }, loc });
          } while (this.acceptPunct(','));
          this.expectPunct(')');
        }
        if (this.acceptKw('OVERRIDING')) {
          clause.override = this.acceptKw('SYSTEM') ? 'SYSTEM' : (this.expectKw('USER'), 'USER');
          this.expectKw('VALUE');
        }
        if (this.acceptKws('DEFAULT', 'VALUES')) {
          clause.values = null;
        } else {
          this.expectKw('VALUES');
          this.expectPunct('(');
          clause.values = [];
          do {
            clause.values.push(this.parseExprOrDefault());
          } while (this.acceptPunct(','));
          this.expectPunct(')');
        }
      } else {
        this.expectKw('DO');
        this.expectKw('NOTHING');
      }
      whenClauses.push(clause);
    }
    const stmt: A.MergeStmt = { kind: 'MergeStmt', with: withClause, relation, source, joinCondition, whenClauses, loc: t.pos };
    if (this.atKw('RETURNING')) {
      stmt.returning = this.parseReturning();
    }
    return stmt;
  }

  parseIndexElems(): A.IndexElem[] {
    const elems: A.IndexElem[] = [];
    do {
      elems.push(this.parseIndexElem());
    } while (this.acceptPunct(','));
    return elems;
  }

  parseIndexElem(): A.IndexElem {
    const elem: A.IndexElem = { ordering: 'DEFAULT', nullsOrdering: 'DEFAULT' };
    const startIdx = this.p;
    if (this.atPunct('(')) {
      this.next();
      const exprStart = this.p;
      elem.expr = this.parseExpr();
      elem.exprText = this.textFrom(exprStart);
      this.expectPunct(')');
    } else if (this.peek().type === 'ident' && this.isFunctionCallAhead()) {
      elem.expr = this.parseExpr(P_COLLATE);
      elem.exprText = this.textFrom(startIdx);
    } else {
      elem.name = this.parseColIdOrKeywordName();
    }
    if (this.acceptKw('COLLATE')) {
      elem.collation = this.parseAnyName();
    }
    // opclass
    const t = this.peek();
    if (t.type === 'ident' && !this.isKw(t, 'ASC', 'DESC', 'NULLS', 'WITH', 'WHERE', 'INCLUDE') && (t.quoted || !RESERVED.has(t.kw))) {
      elem.opclass = this.parseAnyName();
      if (this.atPunct('(')) {
        this.next();
        elem.opclassOptions = this.parseDefElemList();
        this.expectPunct(')');
      }
    }
    if (this.acceptKw('ASC')) {
      elem.ordering = 'ASC';
    } else if (this.acceptKw('DESC')) {
      elem.ordering = 'DESC';
    }
    if (this.acceptKw('NULLS')) {
      elem.nullsOrdering = this.acceptKw('FIRST') ? 'FIRST' : (this.expectKw('LAST'), 'LAST');
    }
    return elem;
  }

  /** name [= value] list used by WITH (...) options. */
  parseDefElemList(): A.DefElem[] {
    const list: A.DefElem[] = [];
    do {
      let name = this.parseColLabel();
      let namespace: string | undefined;
      if (this.acceptPunct('.')) {
        namespace = name;
        name = this.parseColLabel();
      }
      const el: A.DefElem = { name, namespace };
      if (this.acceptOp('=')) {
        el.value = this.parseDefArg();
      } else if (!this.atPunct(',') && !this.atPunct(')')) {
        el.value = this.parseDefArg();
      }
      list.push(el);
    } while (this.acceptPunct(','));
    return list;
  }

  parseDefArg(): string | number | boolean {
    const t = this.next();
    if (t.type === 'string') {
      return t.value;
    }
    if (t.type === 'integer' || t.type === 'numeric') {
      return t.value;
    }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      const n = this.next();
      return (t.value === '-' ? '-' : '') + n.value;
    }
    if (t.type === 'ident') {
      if (this.isKw(t, 'TRUE', 'ON')) {
        return t.kw === 'TRUE' ? true : 'on';
      }
      if (this.isKw(t, 'FALSE', 'OFF')) {
        return t.kw === 'FALSE' ? false : 'off';
      }
      return t.value;
    }
    this.error(t);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /**
   * Parse an a_expr. Binary operators with precedence strictly greater than `minPrec` are consumed.
   *
   * gram.y declares three levels `%nonassoc`: the comparisons (`< > = <= >= <>`), `BETWEEN IN LIKE ILIKE
   * SIMILAR` (with NOT_LA) and `IS`. Two operators of one such level in a row are a syntax error when the first
   * one's rule ends in an a_expr — `a = b = c`, `a LIKE b IN (…)`, `a IS DISTINCT FROM b IS NULL` — because
   * bison then has to choose between reducing it and shifting the second operator. A rule that ends in a
   * token of its own (`a = ANY (…)`, `a IN (…)`, `a IS NULL`) is reduced first and chains freely.
   * `nonassoc` is the level of the last such open rule at this loop level (0: none).
   */
  parseExpr(minPrec = 0): A.Expr {
    let left = this.parsePrefix();
    let nonassoc = 0;
    while (true) {
      const t = this.peek();
      const loc = t.pos;

      if (t.type === 'punct') {
        if (t.value === '::') {
          // typecast binds tightest; handled here for chains like a::int::text
          this.next();
          left = { kind: 'TypeCast', arg: left, typeName: this.parseTypeName(), loc };
          continue;
        }
        if (t.value === '[') {
          // c_expr: only column references, parameters, parenthesized expressions and subqueries take a subscript
          if (left.kind !== 'ColumnRef' && left.kind !== 'ParamRef' && left.kind !== 'ParenExpr' && !(left.kind === 'SubLink' && left.linkType === 'EXPR') && left.kind !== 'Indirection') {
            this.error(t);
          }
          left = this.appendIndirection(left, this.parseSubscript());
          continue;
        }
        break;
      }

      if (t.type === 'ident' && !t.quoted && t.kw === 'OVERLAPS' && left.kind === 'RowExpr') {
        // row OVERLAPS row -> overlaps(a, b, c, d)
        this.next();
        const right = this.parsePrefix();
        if (left.args.length !== 2) {
          throw syntaxError('wrong number of parameters on left side of OVERLAPS expression', left.loc);
        }
        if (right.kind !== 'RowExpr') {
          this.error(this.peek());
        }
        if (right.args.length !== 2) {
          throw syntaxError('wrong number of parameters on right side of OVERLAPS expression', right.loc);
        }
        left = this.makeFunc(['pg_catalog', 'overlaps'], [...left.args, ...right.args], loc);
        continue;
      }

      if (t.type === 'op') {
        const prec = this.binaryOpPrec(t.value);
        if (prec <= minPrec) {
          break;
        }
        if (prec === P_CMP && nonassoc === P_CMP) {
          this.error(t);
        }
        this.next();
        // subquery / array operators: op ANY|SOME|ALL ( ... ) — closed by its ')'
        if (this.atKw('ANY', 'SOME', 'ALL') && this.atPunct('(', 1)) {
          left = this.parseSubqueryOp(left, [t.value], loc);
          nonassoc = 0;
          continue;
        }
        const right = this.parseExpr(prec);
        left = { kind: 'AExpr', exprKind: 'OP', name: [t.value], lexpr: left, rexpr: right, loc };
        nonassoc = prec === P_CMP ? P_CMP : 0;
        continue;
      }

      if (t.type !== 'ident' || t.quoted) {
        break;
      }

      switch (t.kw) {
        case 'OR':
          if (P_OR <= minPrec) {
            return left;
          }
          this.next();
          left = this.makeBool('OR', left, this.parseExpr(P_OR), loc);
          nonassoc = 0;
          continue;
        case 'AND':
          if (P_AND <= minPrec) {
            return left;
          }
          this.next();
          left = this.makeBool('AND', left, this.parseExpr(P_AND), loc);
          nonassoc = 0;
          continue;
        case 'IS': {
          if (P_IS <= minPrec) {
            return left;
          }
          if (nonassoc === P_IS) {
            this.error(t);
          }
          this.next();
          // only IS [NOT] DISTINCT FROM ends in an a_expr; every other IS form ends in its keyword
          nonassoc = 0;
          const not = this.acceptKw('NOT');
          if (this.acceptKw('NULL')) {
            left = { kind: 'NullTest', arg: left, isNot: not, loc };
          } else if (this.acceptKw('TRUE')) {
            left = { kind: 'BooleanTest', arg: left, test: not ? 'IS_NOT_TRUE' : 'IS_TRUE', loc };
          } else if (this.acceptKw('FALSE')) {
            left = { kind: 'BooleanTest', arg: left, test: not ? 'IS_NOT_FALSE' : 'IS_FALSE', loc };
          } else if (this.acceptKw('UNKNOWN')) {
            left = { kind: 'BooleanTest', arg: left, test: not ? 'IS_NOT_UNKNOWN' : 'IS_UNKNOWN', loc };
          } else if (this.acceptKw('DISTINCT')) {
            this.expectKw('FROM');
            const right = this.parseExpr(P_IS);
            left = { kind: 'AExpr', exprKind: not ? 'NOT_DISTINCT' : 'DISTINCT', name: ['='], lexpr: left, rexpr: right, loc };
            nonassoc = P_IS;
          } else if (this.acceptKw('DOCUMENT')) {
            left = this.makeFunc(['xmlexists_document'], [left], loc);
          } else if (this.atKw('JSON')) {
            this.next();
            let itemType: A.JsonFuncExpr['itemType'] = 'value';
            if (this.acceptKw('VALUE')) {
              itemType = 'value';
            } else if (this.acceptKw('OBJECT')) {
              itemType = 'object';
            } else if (this.acceptKw('ARRAY')) {
              itemType = 'array';
            } else if (this.acceptKw('SCALAR')) {
              itemType = 'scalar';
            }
            let uniqueKeys = false;
            if (this.acceptKws('WITH', 'UNIQUE')) {
              this.acceptKw('KEYS');
              uniqueKeys = true;
            } else if (this.acceptKws('WITHOUT', 'UNIQUE')) {
              this.acceptKw('KEYS');
            }
            const call: A.JsonFuncExpr = { ...this.jsonFuncBase('is_json', left, loc), itemType, uniqueKeys };
            left = not ? { kind: 'BoolExpr', op: 'NOT', args: [call], loc } : call;
          } else if (this.atKw('NFC', 'NFD', 'NFKC', 'NFKD', 'NORMALIZED')) {
            let form = 'NFC';
            if (!this.atKw('NORMALIZED')) {
              form = this.next().kw;
            }
            this.expectKw('NORMALIZED');
            const call = this.makeFunc(['pg_catalog', 'is_normalized'], [left, { kind: 'AConst', val: { type: 'string', value: form } }], loc);
            left = not ? { kind: 'BoolExpr', op: 'NOT', args: [call], loc } : call;
          } else {
            this.error();
          }
          continue;
        }
        case 'ISNULL':
          if (P_IS <= minPrec) {
            return left;
          }
          if (nonassoc === P_IS) {
            this.error(t);
          }
          this.next();
          left = { kind: 'NullTest', arg: left, isNot: false, loc };
          nonassoc = 0;
          continue;
        case 'NOTNULL':
          if (P_IS <= minPrec) {
            return left;
          }
          if (nonassoc === P_IS) {
            this.error(t);
          }
          this.next();
          left = { kind: 'NullTest', arg: left, isNot: true, loc };
          nonassoc = 0;
          continue;
        case 'NOT': {
          const k1 = this.peek(1);
          if (!this.isKw(k1, 'BETWEEN', 'IN', 'LIKE', 'ILIKE', 'SIMILAR')) {
            return left;
          }
          if (P_LIKE <= minPrec) {
            return left;
          }
          if (nonassoc === P_LIKE) {
            this.error(t);
          }
          this.next();
          left = this.parseLikeInBetween(left, true, loc);
          nonassoc = this.endsInOperand(left) ? P_LIKE : 0;
          continue;
        }
        case 'BETWEEN':
        case 'IN':
        case 'LIKE':
        case 'ILIKE':
        case 'SIMILAR':
          if (P_LIKE <= minPrec) {
            return left;
          }
          if (nonassoc === P_LIKE) {
            this.error(t);
          }
          left = this.parseLikeInBetween(left, false, loc);
          nonassoc = this.endsInOperand(left) ? P_LIKE : 0;
          continue;
        case 'AT':
          if (P_AT <= minPrec) {
            return left;
          }
          if (this.isKw(this.peek(1), 'TIME') && this.isKw(this.peek(2), 'ZONE')) {
            this.p += 3;
            const zone = this.parseExpr(P_AT);
            left = this.makeFunc(['pg_catalog', 'timezone'], [zone, left], loc, 'AT TIME ZONE');
            nonassoc = 0;
            continue;
          }
          if (this.isKw(this.peek(1), 'LOCAL')) {
            this.p += 2;
            left = this.makeFunc(['pg_catalog', 'timezone'], [left], loc, 'AT LOCAL');
            nonassoc = 0;
            continue;
          }
          return left;
        case 'COLLATE':
          if (P_COLLATE <= minPrec) {
            return left;
          }
          this.next();
          left = { kind: 'CollateClause', arg: left, collname: this.parseAnyName(), loc };
          nonassoc = 0;
          continue;
        case 'OPERATOR': {
          if (!this.atPunct('(', 1)) {
            return left;
          }
          if (P_OP <= minPrec) {
            return left;
          }
          const name = this.parseQualOp();
          if (this.atKw('ANY', 'SOME', 'ALL') && this.atPunct('(', 1)) {
            left = this.parseSubqueryOp(left, name, loc);
            nonassoc = 0;
            continue;
          }
          const right = this.parseExpr(P_OP);
          left = { kind: 'AExpr', exprKind: 'OP', name, lexpr: left, rexpr: right, loc };
          nonassoc = 0;
          continue;
        }
        default:
          return left;
      }
    }
    return left;
  }

  /**
   * Whether a `[NOT] BETWEEN / IN / LIKE / ILIKE / SIMILAR` construct ends in an a_expr (the pattern, the
   * upper bound) rather than in its own `)` (an IN list or subquery, `LIKE ANY (…)`): only the former
   * leaves the non-associative level open for a following operator of that level.
   */
  private endsInOperand(node: A.Expr): boolean {
    if (node.kind === 'SubLink' || node.kind === 'BoolExpr') {
      return false;
    }

    return !(node.kind === 'AExpr' && (node.exprKind === 'IN' || node.exprKind === 'OP_ANY' || node.exprKind === 'OP_ALL'));
  }

  private binaryOpPrec(op: string): number {
    switch (op) {
      case '<':
      case '>':
      case '=':
      case '<=':
      case '>=':
      case '<>':
        return P_CMP;
      case '+':
      case '-':
        return P_ADD;
      case '*':
      case '/':
      case '%':
        return P_MUL;
      case '^':
        return P_EXP;
      default:
        return P_OP;
    }
  }

  private makeBool(op: 'AND' | 'OR', l: A.Expr, r: A.Expr, loc: number): A.Expr {
    // PostgreSQL flattens nested AND/OR chains (makeAndExpr/makeOrExpr); parentheses are not
    // represented in its raw tree, so a parenthesized left operand flattens too.
    const lu = l.kind === 'ParenExpr' && l.arg.kind === 'BoolExpr' ? l.arg : l;
    if (lu.kind === 'BoolExpr' && lu.op === op) {
      return { kind: 'BoolExpr', op, args: [...lu.args, r], loc: lu.loc };
    }
    return { kind: 'BoolExpr', op, args: [l, r], loc };
  }

  private jsonFuncBase(op: A.JsonFuncExpr['op'], ctx: A.Expr, loc: number): A.JsonFuncExpr {
    return { kind: 'JsonFuncExpr', op, ctx, path: null, passing: [], returning: null, onEmpty: null, onError: null, wrapper: 'none', omitQuotes: false, itemType: 'value', uniqueKeys: false, loc };
  }

  /** JSON_VALUE / JSON_QUERY / JSON_EXISTS (json_value_expr, json_query_expr, json_exists_expr). */
  private parseJsonQueryFunc(loc: number): A.Expr {
    const op = this.next().kw.toLowerCase() as A.JsonFuncExpr['op'];
    this.expectPunct('(');
    const ctx = this.parseExpr();
    this.parseJsonFormatClause();
    this.expectPunct(',');
    const node = this.jsonFuncBase(op, ctx, loc);
    node.path = this.parseExpr();
    if (this.acceptKw('PASSING')) {
      do {
        const expr = this.parseExpr();
        this.parseJsonFormatClause();
        this.expectKw('AS');
        node.passing.push({ name: this.parseColId(), expr });
      } while (this.acceptPunct(','));
    }
    if (op !== 'json_exists' && this.acceptKw('RETURNING')) {
      node.returning = this.parseTypeName();
      this.parseJsonFormatClause();
    } else if (op === 'json_exists' && this.acceptKw('RETURNING')) {
      node.returning = this.parseTypeName();
    }
    if (op === 'json_query') {
      if (this.acceptKw('WITHOUT')) {
        this.acceptKw('ARRAY');
        this.expectKw('WRAPPER');
      } else if (this.atKw('WITH')) {
        this.next();
        node.wrapper = this.acceptKw('CONDITIONAL') ? 'conditional' : (this.acceptKw('UNCONDITIONAL'), 'unconditional');
        this.acceptKw('ARRAY');
        this.expectKw('WRAPPER');
      }
      if (this.atKw('KEEP', 'OMIT')) {
        node.omitQuotes = this.next().kw === 'OMIT';
        this.expectKw('QUOTES');
        if (this.acceptKws('ON', 'SCALAR')) {
          this.expectKw('STRING');
        }
      }
    }
    while (!this.atPunct(')')) {
      const behavior = this.parseJsonBehavior(op);
      this.expectKw('ON');
      if (this.acceptKw('EMPTY') && op !== 'json_exists') {
        node.onEmpty = behavior;
      } else {
        this.expectKw('ERROR');
        node.onError = behavior;
      }
    }
    this.expectPunct(')');
    return node;
  }

  private parseJsonFormatClause(): void {
    if (this.acceptKws('FORMAT', 'JSON')) {
      if (this.acceptKw('ENCODING')) {
        this.parseColId();
      }
    }
  }

  private parseJsonBehavior(op: A.JsonFuncExpr['op']): A.JsonBehavior {
    if (this.acceptKw('DEFAULT') && op !== 'json_exists') {
      return { kind: 'default', expr: this.parseExpr() };
    }
    if (this.acceptKw('EMPTY')) {
      if (this.acceptKw('OBJECT')) {
        return { kind: 'empty_object' };
      }
      this.acceptKw('ARRAY');
      return { kind: 'empty_array' };
    }
    const t = this.peek();
    const kw = this.isKw(t, 'ERROR', 'NULL', 'TRUE', 'FALSE', 'UNKNOWN') ? t.kw : null;
    if (!kw) {
      this.error();
    }
    this.next();
    return { kind: kw!.toLowerCase() as A.JsonBehavior['kind'] };
  }

  makeFunc(name: string[], args: A.Expr[], loc?: number, special?: string): A.FuncCall {
    return {
      kind: 'FuncCall',
      name,
      args,
      aggOrder: [],
      aggFilter: null,
      aggWithinGroup: false,
      aggStar: false,
      aggDistinct: false,
      funcVariadic: false,
      over: null,
      loc,
      special,
    };
  }

  /**
   * The query of `op ANY/ALL (<query>)`, `IN (<query>)` or `SET (a, b) = (<query>)`, the `(` just ahead — or
   * `query: null` when the operand only STARTS with a parenthesised query (`ANY ((SELECT …)::int[])`,
   * `IN ((SELECT 1), 2)`, `SET (a, b) = ((SELECT 1), 2)`): an expression, which the caller then parses from the
   * same `(` through {@link parseAfterSublinkQuery}, handing it `failure` — how the query reading ended. Only
   * an operand opening with `((` is ambiguous; a `(SELECT …` is a query or a syntax error of its own.
   */
  private parseParenthesizedSublinkQuery(): { query: A.SelectStmt; failure?: undefined } | { query: null; failure?: SublinkQueryFailure } {
    if (!this.looksLikeSubquery(0)) {
      return { query: null };
    }
    const ambiguous = this.atPunct('(', 1);
    const save = this.p;
    try {
      this.next();
      const sub = this.parseSelectStatement();
      this.expectPunct(')');
      return { query: sub };
    } catch (e) {
      if (!ambiguous) {
        throw e;
      }
      const failure: SublinkQueryFailure = { error: e, at: this.p };
      this.p = save;
      return { query: null, failure };
    }
  }

  /**
   * Parses an operand as an expression (`parse`) after its query reading failed (`failure`). When the
   * expression reading fails at an EARLIER token than the query reading did, the query reading's error is
   * the one reported: PostgreSQL's parser stops at — and reports — the furthest token either reading reaches
   * (`IN ((SELECT 1 FROM), 2)`: `at or near ")"`, not the expression reading's `at or near "SELECT"`).
   */
  private parseAfterSublinkQuery<T>(failure: SublinkQueryFailure | undefined, parse: () => T): T {
    if (failure === undefined) {
      return parse();
    }
    try {
      return parse();
    } catch (e) {
      throw this.p < failure.at ? failure.error : e;
    }
  }

  private parseSubqueryOp(left: A.Expr, name: string[], loc: number): A.Expr {
    const kind = this.next().kw;
    const linkType = kind === 'ALL' ? 'ALL' : 'ANY';
    const sub = this.parseParenthesizedSublinkQuery();
    if (sub.query) {
      return { kind: 'SubLink', linkType, testexpr: left, operName: name, subselect: sub.query, loc };
    }
    const arr = this.parseAfterSublinkQuery(sub.failure, () => {
      this.expectPunct('(');
      const expr = this.parseExpr();
      this.expectPunct(')');
      return expr;
    });
    return { kind: 'AExpr', exprKind: linkType === 'ALL' ? 'OP_ALL' : 'OP_ANY', name, lexpr: left, rexpr: arr, loc };
  }

  private parseLikeInBetween(left: A.Expr, not: boolean, loc: number): A.Expr {
    const t = this.next();
    switch (t.kw) {
      case 'BETWEEN': {
        let symmetric = false;
        if (this.acceptKw('SYMMETRIC')) {
          symmetric = true;
        } else {
          this.acceptKw('ASYMMETRIC');
        }
        const low = this.parseExpr(P_LIKE);
        this.expectKw('AND');
        const high = this.parseExpr(P_LIKE);
        const exprKind = symmetric ? (not ? 'NOT_BETWEEN_SYM' : 'BETWEEN_SYM') : not ? 'NOT_BETWEEN' : 'BETWEEN';
        return { kind: 'AExpr', exprKind, name: [not ? 'NOT BETWEEN' : 'BETWEEN'], lexpr: left, rexpr: [low, high], loc };
      }
      case 'IN': {
        const sub = this.parseParenthesizedSublinkQuery();
        if (sub.query) {
          const link: A.SubLink = { kind: 'SubLink', linkType: 'ANY', testexpr: left, operName: ['='], subselect: sub.query, loc };
          if (not) {
            return { kind: 'BoolExpr', op: 'NOT', args: [link], loc };
          }
          return link;
        }
        const list = this.parseAfterSublinkQuery(sub.failure, () => {
          this.expectPunct('(');
          const items = this.parseExprList();
          this.expectPunct(')');
          return items;
        });
        return { kind: 'AExpr', exprKind: 'IN', name: [not ? '<>' : '='], lexpr: left, rexpr: list, loc };
      }
      case 'LIKE':
      case 'ILIKE': {
        const isIlike = t.kw === 'ILIKE';
        const opName = isIlike ? (not ? '!~~*' : '~~*') : not ? '!~~' : '~~';
        if (this.atKw('ANY', 'SOME', 'ALL') && this.atPunct('(', 1)) {
          return this.parseSubqueryOp(left, [opName], loc);
        }
        let pattern = this.parseExpr(P_LIKE);
        if (this.acceptKw('ESCAPE')) {
          const esc = this.parseExpr(P_LIKE);
          pattern = this.makeFunc(['pg_catalog', 'like_escape'], [pattern, esc], loc);
        }
        return { kind: 'AExpr', exprKind: isIlike ? 'ILIKE' : 'LIKE', name: [opName], lexpr: left, rexpr: pattern, loc };
      }
      case 'SIMILAR': {
        this.expectKw('TO');
        const pattern = this.parseExpr(P_LIKE);
        let esc: A.Expr | null = null;
        if (this.acceptKw('ESCAPE')) {
          esc = this.parseExpr(P_LIKE);
        }
        const args: A.Expr[] = [pattern];
        if (esc) {
          args.push(esc);
        }
        const re = this.makeFunc(['pg_catalog', 'similar_to_escape'], args, loc);
        return { kind: 'AExpr', exprKind: 'SIMILAR', name: [not ? '!~' : '~'], lexpr: left, rexpr: re, loc };
      }
    }
    this.error(t);
  }

  private parsePrefix(): A.Expr {
    const t = this.peek();
    const loc = t.pos;
    if (t.type === 'op') {
      if (t.value === '-' || t.value === '+') {
        this.next();
        const arg = this.parseExpr(P_UMINUS);
        if (t.value === '+') {
          return { kind: 'AExpr', exprKind: 'OP', name: ['+'], lexpr: null, rexpr: arg, loc };
        }
        // doNegate: fold into numeric constants
        if (arg.kind === 'AConst' && (arg.val.type === 'integer' || arg.val.type === 'numeric')) {
          const v = arg.val.value;
          return { kind: 'AConst', val: { type: arg.val.type, value: v.startsWith('-') ? v.slice(1) : '-' + v }, loc };
        }
        return { kind: 'AExpr', exprKind: 'OP', name: ['-'], lexpr: null, rexpr: arg, loc };
      }
      // other prefix operator
      this.next();
      const arg = this.parseExpr(P_OP);
      return { kind: 'AExpr', exprKind: 'OP', name: [t.value], lexpr: null, rexpr: arg, loc };
    }
    if (t.type === 'ident' && !t.quoted) {
      if (t.kw === 'NOT') {
        this.next();
        const arg = this.parseExpr(P_NOT);
        return { kind: 'BoolExpr', op: 'NOT', args: [arg], loc };
      }
      if (t.kw === 'OPERATOR' && this.atPunct('(', 1)) {
        const name = this.parseQualOp();
        const arg = this.parseExpr(P_OP);
        return { kind: 'AExpr', exprKind: 'OP', name, lexpr: null, rexpr: arg, loc };
      }
    }
    return this.parsePrimaryWithIndirection();
  }

  private parsePrimaryWithIndirection(): A.Expr {
    let e = this.parsePrimary();
    // indirection: [subscript], .field, .*
    // c_expr: only column references, parameters, parenthesized expressions and scalar subqueries take
    // indirection (`ARRAY[1,2][1]`, `f(x)[1]` and `f(x).col` are syntax errors)
    const indirectable = (x: A.Expr) => x.kind === 'ColumnRef' || x.kind === 'ParamRef' || x.kind === 'ParenExpr' || x.kind === 'Indirection' || (x.kind === 'SubLink' && x.linkType === 'EXPR');
    while (true) {
      if (this.atPunct('[')) {
        if (!indirectable(e)) {
          this.error(this.peek());
        }
        e = this.appendIndirection(e, this.parseSubscript());
        continue;
      }
      if (this.atPunct('.') && indirectable(e) && e.kind !== 'ColumnRef') {
        this.next();
        if (this.atOp('*')) {
          this.next();
          e = this.appendIndirection(e, { type: 'star' });
        } else {
          e = this.appendIndirection(e, { type: 'field', name: this.parseColLabel() });
        }
        continue;
      }
      if (this.atPunct('::')) {
        const loc = this.next().pos;
        e = { kind: 'TypeCast', arg: e, typeName: this.parseTypeName(), loc };
        continue;
      }
      break;
    }
    return e;
  }

  private appendIndirection(e: A.Expr, el: A.IndirectionEl): A.Expr {
    if (e.kind === 'Indirection') {
      e.indirection.push(el);
      return e;
    }
    if (e.kind === 'ColumnRef' && el.type !== 'index') {
      // keep plain column refs flat
      e.fields.push(el.type === 'star' ? '*' : el.name);
      return e;
    }
    return { kind: 'Indirection', arg: e, indirection: [el], loc: e.loc };
  }

  parseSubscript(): A.IndirectionEl {
    this.expectPunct('[');
    let lidx: A.Expr | null = null;
    let uidx: A.Expr | null = null;
    let isSlice = false;
    if (!this.atPunct(':')) {
      lidx = this.parseExpr();
    }
    if (this.acceptPunct(':')) {
      isSlice = true;
      if (!this.atPunct(']')) {
        uidx = this.parseExpr();
      }
    }
    this.expectPunct(']');
    if (!isSlice) {
      return { type: 'index', lidx: null, uidx: lidx, isSlice: false };
    }
    return { type: 'index', lidx, uidx, isSlice: true };
  }

  private parsePrimary(): A.Expr {
    const t = this.peek();
    const loc = t.pos;
    switch (t.type) {
      case 'integer':
        this.next();
        return { kind: 'AConst', val: { type: 'integer', value: t.value }, loc };
      case 'numeric':
        this.next();
        return { kind: 'AConst', val: { type: 'numeric', value: t.value }, loc };
      case 'string':
        this.next();
        return { kind: 'AConst', val: { type: 'string', value: t.value }, loc };
      case 'bitstring':
        this.next();
        return { kind: 'AConst', val: { type: 'bitstring', value: t.value }, loc };
      case 'param':
        this.next();
        return { kind: 'ParamRef', number: parseInt(t.value, 10), loc };
      case 'punct':
        if (t.value === '(') {
          return this.parseParenExpr();
        }
        this.error();
      // eslint-disable-next-line no-fallthrough
      case 'ident':
        return this.parseIdentPrimary();
      default:
        this.error();
    }
  }

  private parseParenExpr(): A.Expr {
    const loc = this.peek().pos;
    if (this.looksLikeSubquery(0)) {
      // Could still be an expression like ((SELECT 1) + 1); try subquery first.
      const save = this.p;
      try {
        this.next();
        const sub = this.parseSelectStatement();
        this.expectPunct(')');
        return { kind: 'SubLink', linkType: 'EXPR', testexpr: null, operName: [], subselect: sub, loc };
      } catch (e) {
        this.p = save;
      }
    }
    this.expectPunct('(');
    const first = this.parseExpr();
    if (this.acceptPunct(',')) {
      const args = [first];
      do {
        args.push(this.parseExpr());
      } while (this.acceptPunct(','));
      this.expectPunct(')');
      return { kind: 'RowExpr', args, explicitRow: false, loc };
    }
    this.expectPunct(')');
    return { kind: 'ParenExpr', arg: first, loc };
  }

  private parseIdentPrimary(): A.Expr {
    const t = this.peek();
    const loc = t.pos;

    if (!t.quoted) {
      switch (t.kw) {
        case 'TRUE':
          this.next();
          return { kind: 'AConst', val: { type: 'boolean', value: true }, loc };
        case 'FALSE':
          this.next();
          return { kind: 'AConst', val: { type: 'boolean', value: false }, loc };
        case 'NULL':
          this.next();
          return { kind: 'AConst', val: { type: 'null' }, loc };
        case 'CASE':
          return this.parseCase();
        case 'CAST': {
          this.next();
          this.expectPunct('(');
          const arg = this.parseExpr();
          this.expectKw('AS');
          const typeName = this.parseTypeName();
          this.expectPunct(')');
          return { kind: 'TypeCast', arg, typeName, loc };
        }
        case 'EXISTS':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const sub = this.parseSelectStatement();
            this.expectPunct(')');
            return { kind: 'SubLink', linkType: 'EXISTS', testexpr: null, operName: [], subselect: sub, loc };
          }
          break;
        case 'ARRAY':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const sub = this.parseSelectStatement();
            this.expectPunct(')');
            return { kind: 'SubLink', linkType: 'ARRAY', testexpr: null, operName: [], subselect: sub, loc };
          }
          if (this.atPunct('[', 1)) {
            this.next();
            return this.parseArrayLiteral();
          }
          break;
        case 'ROW':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const args = this.atPunct(')') ? [] : this.parseExprList();
            this.expectPunct(')');
            return { kind: 'RowExpr', args, explicitRow: true, loc };
          }
          break;
        case 'DEFAULT':
          this.next();
          return { kind: 'SetToDefault', loc };
        case 'CURRENT_DATE':
          this.next();
          return { kind: 'SqlValueFunction', op: 'CURRENT_DATE', loc };
        case 'CURRENT_TIME':
        case 'CURRENT_TIMESTAMP':
        case 'LOCALTIME':
        case 'LOCALTIMESTAMP': {
          this.next();
          if (this.atPunct('(') && this.peek(1).type === 'integer') {
            this.next();
            const p = parseInt(this.next().value, 10);
            this.expectPunct(')');
            return { kind: 'SqlValueFunction', op: (t.kw + '_N') as A.SqlValueFunction['op'], typmod: p, loc };
          }
          return { kind: 'SqlValueFunction', op: t.kw as A.SqlValueFunction['op'], loc };
        }
        case 'CURRENT_ROLE':
        case 'CURRENT_USER':
        case 'USER':
        case 'SESSION_USER':
        case 'CURRENT_CATALOG':
        case 'SYSTEM_USER':
          this.next();
          return { kind: 'SqlValueFunction', op: t.kw as A.SqlValueFunction['op'], loc };
        case 'CURRENT_SCHEMA':
          if (!this.atPunct('(', 1)) {
            this.next();
            return { kind: 'SqlValueFunction', op: 'CURRENT_SCHEMA', loc };
          }
          break;
        case 'COALESCE':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const args = this.parseExprList();
            this.expectPunct(')');
            return { kind: 'CoalesceExpr', args, loc };
          }
          break;
        case 'GREATEST':
        case 'LEAST':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const args = this.parseExprList();
            this.expectPunct(')');
            return { kind: 'MinMaxExpr', op: t.kw as 'GREATEST' | 'LEAST', args, loc };
          }
          break;
        case 'NULLIF':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const a = this.parseExpr();
            this.expectPunct(',');
            const b = this.parseExpr();
            this.expectPunct(')');
            return { kind: 'AExpr', exprKind: 'NULLIF', name: ['='], lexpr: a, rexpr: b, loc };
          }
          break;
        case 'EXTRACT':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const ft = this.next();
            let field: string;
            if (ft.type === 'string') {
              field = ft.value;
            } else if (ft.type === 'ident') {
              field = ft.value;
            } else {
              this.error(ft);
            }
            this.expectKw('FROM');
            const src = this.parseExpr();
            this.expectPunct(')');
            return this.makeFunc(['pg_catalog', 'extract'], [{ kind: 'AConst', val: { type: 'string', value: field } }, src], loc, 'extract');
          }
          break;
        case 'POSITION':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const sub = this.parseExpr(P_LIKE);
            this.expectKw('IN');
            const str = this.parseExpr();
            this.expectPunct(')');
            return this.makeFunc(['pg_catalog', 'position'], [str, sub], loc, 'position');
          }
          break;
        case 'SUBSTRING':
          if (this.atPunct('(', 1)) {
            return this.parseSubstring();
          }
          break;
        case 'JSON_VALUE':
        case 'JSON_QUERY':
        case 'JSON_EXISTS':
          if (this.atPunct('(', 1)) {
            return this.parseJsonQueryFunc(loc);
          }
          break;
        case 'OVERLAY':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const a = this.parseExpr();
            this.expectKw('PLACING');
            const b = this.parseExpr();
            this.expectKw('FROM');
            const c = this.parseExpr();
            const args = [a, b, c];
            if (this.acceptKw('FOR')) {
              args.push(this.parseExpr());
            }
            this.expectPunct(')');
            return this.makeFunc(['pg_catalog', 'overlay'], args, loc, 'overlay');
          }
          break;
        case 'TRIM':
          if (this.atPunct('(', 1)) {
            return this.parseTrim();
          }
          break;
        case 'NORMALIZE':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const a = this.parseExpr();
            const args: A.Expr[] = [a];
            if (this.acceptPunct(',')) {
              args.push({ kind: 'AConst', val: { type: 'string', value: this.next().kw } });
            }
            this.expectPunct(')');
            return this.makeFunc(['pg_catalog', 'normalize'], args, loc, 'normalize');
          }
          break;
        case 'COLLATION':
          if (this.isKw(this.peek(1), 'FOR')) {
            this.next();
            this.next();
            this.expectPunct('(');
            const a = this.parseExpr();
            this.expectPunct(')');
            return this.makeFunc(['pg_catalog', 'pg_collation_for'], [a], loc, 'collation for');
          }
          break;
        case 'GROUPING':
          if (this.atPunct('(', 1)) {
            this.next();
            this.expectPunct('(');
            const args = this.parseExprList();
            this.expectPunct(')');
            return { kind: 'GroupingFunc', args, loc };
          }
          break;
        case 'INTERVAL': {
          if (this.peek(1).type === 'string') {
            this.next();
            const s = this.next();
            const tn: A.TypeName = { kind: 'TypeName', names: ['pg_catalog', 'interval'], typmods: [], arrayBounds: [], loc };
            this.parseOptInterval(tn);
            return { kind: 'TypeCast', arg: { kind: 'AConst', val: { type: 'string', value: s.value }, loc: s.pos }, typeName: tn, loc };
          }
          if (this.atPunct('(', 1) && this.peek(2).type === 'integer' && this.atPunct(')', 3) && this.peek(4).type === 'string') {
            this.next();
            this.next();
            const prec = this.next();
            this.next();
            const s = this.next();
            const tn: A.TypeName = {
              kind: 'TypeName',
              names: ['pg_catalog', 'interval'],
              typmods: [{ kind: 'AConst', val: { type: 'integer', value: prec.value } }],
              arrayBounds: [],
              loc,
            };
            return { kind: 'TypeCast', arg: { kind: 'AConst', val: { type: 'string', value: s.value }, loc: s.pos }, typeName: tn, loc };
          }
          break;
        }
      }

      // Typed literal for SQL-standard type keywords: TIMESTAMP '...', DOUBLE PRECISION '...', etc.
      if (this.isSqlTypeKeywordStart(t)) {
        const save = this.p;
        try {
          const tn = this.parseTypeName();
          if (this.peek().type === 'string' && tn.arrayBounds.length === 0) {
            const s = this.next();
            return { kind: 'TypeCast', arg: { kind: 'AConst', val: { type: 'string', value: s.value }, loc: s.pos }, typeName: tn, loc };
          }
        } catch {
          // fall through
        }
        this.p = save;
      }
    }

    // Function call or column reference or generic typed literal (typename 'string')
    const names: string[] = [];
    const first = this.next();
    names.push(first.value);
    const fieldsHaveStar = false;
    while (this.atPunct('.')) {
      const nt = this.peek(1);
      if (nt.type === 'op' && nt.value === '*') {
        this.next();
        this.next();
        names.push('*');
        return { kind: 'ColumnRef', fields: names, loc };
      }
      if (nt.type !== 'ident') {
        break;
      }
      this.next();
      names.push(this.next().value);
    }
    void fieldsHaveStar;

    if (this.atPunct('(')) {
      return this.parseFuncCallRest(names, loc, first);
    }

    // func_name Sconst: generic typed literal, e.g. int4 '1', date '2020-01-01', pg_catalog.text 'x'
    if (this.peek().type === 'string' && (names.length > 1 || this.isTypeFuncName(first) || first.quoted)) {
      const s = this.next();
      const tn: A.TypeName = { kind: 'TypeName', names: this.mapGenericTypeNames(names), typmods: [], arrayBounds: [], loc };
      return { kind: 'TypeCast', arg: { kind: 'AConst', val: { type: 'string', value: s.value }, loc: s.pos }, typeName: tn, loc };
    }

    if (!first.quoted && (RESERVED.has(first.kw) || TYPE_FUNC_NAME.has(first.kw)) && names.length === 1) {
      this.error(first);
    }
    return { kind: 'ColumnRef', fields: names, loc };
  }

  private mapGenericTypeNames(names: string[]): string[] {
    return names;
  }

  private isSqlTypeKeywordStart(t: Token): boolean {
    return this.isKw(
      t,
      'INT',
      'INTEGER',
      'SMALLINT',
      'BIGINT',
      'REAL',
      'FLOAT',
      'DOUBLE',
      'DECIMAL',
      'DEC',
      'NUMERIC',
      'BOOLEAN',
      'BIT',
      'CHARACTER',
      'CHAR',
      'VARCHAR',
      'NATIONAL',
      'NCHAR',
      'TIMESTAMP',
      'TIME',
      'JSON'
    );
  }

  private parseFuncCallRest(names: string[], loc: number, first: Token): A.Expr {
    void first;
    this.expectPunct('(');
    const call = this.makeFunc(names, [], loc);
    if (this.atOp('*')) {
      this.next();
      call.aggStar = true;
      this.expectPunct(')');
    } else if (this.atPunct(')')) {
      this.next();
    } else {
      if (this.acceptKw('ALL')) {
        // default
      } else if (this.acceptKw('DISTINCT')) {
        call.aggDistinct = true;
      }
      const argNames: (string | undefined)[] = [];
      let anyNamed = false;
      do {
        if (this.acceptKw('VARIADIC')) {
          call.funcVariadic = true;
        }
        // named argument: name => expr  |  name := expr
        const nt = this.peek();
        if (nt.type === 'ident' && (this.atPunct('=>', 1) || this.atPunct(':=', 1))) {
          this.next();
          this.next();
          argNames.push(nt.value);
          anyNamed = true;
        } else {
          argNames.push(undefined);
        }
        call.args.push(this.parseExpr());
      } while (this.acceptPunct(','));
      if (anyNamed) {
        call.argNames = argNames;
      }
      if (this.atKw('ORDER')) {
        this.next();
        this.expectKw('BY');
        call.aggOrder = this.parseSortList();
      }
      this.expectPunct(')');
    }
    if (this.atKw('WITHIN') && this.isKw(this.peek(1), 'GROUP')) {
      this.next();
      this.next();
      this.expectPunct('(');
      this.expectKw('ORDER');
      this.expectKw('BY');
      call.aggOrder = this.parseSortList();
      call.aggWithinGroup = true;
      this.expectPunct(')');
    }
    if (this.atKw('FILTER') && this.atPunct('(', 1)) {
      this.next();
      this.next();
      this.expectKw('WHERE');
      call.aggFilter = this.parseExpr();
      this.expectPunct(')');
    }
    if (this.atKw('OVER')) {
      this.next();
      if (this.atPunct('(')) {
        call.over = this.parseWindowSpecification();
      } else {
        call.over = { kind: 'WindowDef', refname: this.parseColId(), partitionClause: [], orderClause: [] };
      }
    }
    return call;
  }

  private parseCase(): A.Expr {
    const loc = this.expectKw('CASE').pos;
    let arg: A.Expr | null = null;
    if (!this.atKw('WHEN')) {
      arg = this.parseExpr();
    }
    const whens: A.CaseWhen[] = [];
    while (this.acceptKw('WHEN')) {
      const expr = this.parseExpr();
      this.expectKw('THEN');
      const result = this.parseExpr();
      whens.push({ expr, result });
    }
    if (whens.length === 0) {
      this.error();
    }
    let defresult: A.Expr | null = null;
    if (this.acceptKw('ELSE')) {
      defresult = this.parseExpr();
    }
    this.expectKw('END');
    return { kind: 'CaseExpr', arg, whens, defresult, loc };
  }

  private parseArrayLiteral(): A.Expr {
    const loc = this.expectPunct('[').pos;
    const elements: A.Expr[] = [];
    if (!this.atPunct(']')) {
      do {
        if (this.atPunct('[')) {
          elements.push(this.parseArrayLiteral());
        } else {
          elements.push(this.parseExpr());
        }
      } while (this.acceptPunct(','));
    }
    this.expectPunct(']');
    return { kind: 'ArrayExpr', elements, loc };
  }

  private parseSubstring(): A.Expr {
    const loc = this.next().pos;
    this.expectPunct('(');
    const str = this.parseExpr();
    if (this.acceptPunct(',')) {
      const args = [str, this.parseExpr()];
      if (this.acceptPunct(',')) {
        args.push(this.parseExpr());
      }
      this.expectPunct(')');
      return this.makeFunc(['substring'], args, loc);
    }
    let from: A.Expr | null = null;
    let forExpr: A.Expr | null = null;
    let similar: A.Expr | null = null;
    while (!this.atPunct(')')) {
      if (this.acceptKw('FROM')) {
        from = this.parseExpr();
      } else if (this.acceptKw('FOR')) {
        forExpr = this.parseExpr();
      } else if (this.acceptKw('SIMILAR')) {
        similar = this.parseExpr();
      } else if (this.acceptKw('ESCAPE')) {
        forExpr = this.parseExpr();
      } else {
        this.error();
      }
    }
    this.expectPunct(')');
    if (similar) {
      return this.makeFunc(['pg_catalog', 'substring'], [str, similar, forExpr!], loc, 'substring');
    }
    if (from && forExpr) {
      return this.makeFunc(['pg_catalog', 'substring'], [str, from, forExpr], loc, 'substring');
    }
    if (from) {
      return this.makeFunc(['pg_catalog', 'substring'], [str, from], loc, 'substring');
    }
    if (forExpr) {
      return this.makeFunc(['pg_catalog', 'substring'], [str, { kind: 'AConst', val: { type: 'integer', value: '1' } }, forExpr], loc, 'substring');
    }
    return this.makeFunc(['pg_catalog', 'substring'], [str], loc, 'substring');
  }

  private parseTrim(): A.Expr {
    const loc = this.next().pos;
    this.expectPunct('(');
    let fn = 'btrim';
    if (this.acceptKw('BOTH')) {
      fn = 'btrim';
    } else if (this.acceptKw('LEADING')) {
      fn = 'ltrim';
    } else if (this.acceptKw('TRAILING')) {
      fn = 'rtrim';
    }
    let args: A.Expr[];
    if (this.acceptKw('FROM')) {
      args = this.parseExprList();
    } else {
      const first = this.parseExpr();
      if (this.acceptKw('FROM')) {
        const rest = this.parseExprList();
        args = [...rest, first];
      } else if (this.acceptPunct(',')) {
        args = [first, ...this.parseExprList()];
      } else {
        args = [first];
      }
    }
    this.expectPunct(')');
    return this.makeFunc(['pg_catalog', fn], args, loc, 'trim');
  }

  // -------------------------------------------------------------------------
  // Type names
  // -------------------------------------------------------------------------

  parseTypeName(): A.TypeName {
    const loc = this.peek().pos;
    let setof = false;
    if (this.acceptKw('SETOF')) {
      setof = true;
    }
    const tn = this.parseSimpleTypeName();
    tn.loc = loc;
    tn.setof = setof;
    // array bounds
    if (this.atKw('ARRAY')) {
      this.next();
      if (this.acceptPunct('[')) {
        const n = this.next();
        this.expectPunct(']');
        tn.arrayBounds.push(parseInt(n.value, 10));
      } else {
        tn.arrayBounds.push(-1);
      }
      return tn;
    }
    while (this.atPunct('[')) {
      this.next();
      if (this.peek().type === 'integer') {
        tn.arrayBounds.push(parseInt(this.next().value, 10));
      } else {
        tn.arrayBounds.push(-1);
      }
      this.expectPunct(']');
    }
    return tn;
  }

  private parseTypeModifiers(tn: A.TypeName): void {
    if (this.atPunct('(')) {
      this.next();
      tn.typmods = this.parseExprList();
      this.expectPunct(')');
    }
  }

  private parseSimpleTypeName(): A.TypeName {
    const t = this.peek();
    const make = (name: string): A.TypeName => ({ kind: 'TypeName', names: ['pg_catalog', name], typmods: [], arrayBounds: [] });
    if (t.type === 'ident' && !t.quoted) {
      switch (t.kw) {
        case 'INT':
        case 'INTEGER':
        case 'SMALLINT':
        case 'BIGINT':
        case 'REAL':
        case 'BOOLEAN': {
          this.next();
          return make(SQL_TYPE_ALIASES[t.value]);
        }
        case 'DECIMAL':
        case 'DEC':
        case 'NUMERIC': {
          this.next();
          const tn = make('numeric');
          this.parseTypeModifiers(tn);
          return tn;
        }
        case 'FLOAT': {
          this.next();
          if (this.atPunct('(')) {
            this.next();
            const p = parseInt(this.next().value, 10);
            this.expectPunct(')');
            if (p < 1) {
              throw syntaxError('precision for type float must be at least 1 bit', t.pos);
            }
            if (p > 53) {
              throw syntaxError('precision for type float must be less than 54 bits', t.pos);
            }
            return make(p <= 24 ? 'float4' : 'float8');
          }
          return make('float8');
        }
        case 'DOUBLE':
          if (this.isKw(this.peek(1), 'PRECISION')) {
            this.next();
            this.next();
            return make('float8');
          }
          break;
        case 'BIT': {
          this.next();
          const varying = this.acceptKw('VARYING');
          const tn = make(varying ? 'varbit' : 'bit');
          this.parseTypeModifiers(tn);
          if (!varying && tn.typmods.length === 0) {
            tn.typmods = [{ kind: 'AConst', val: { type: 'integer', value: '1' } }];
          }
          return tn;
        }
        case 'CHARACTER':
        case 'CHAR':
        case 'NCHAR':
        case 'NATIONAL':
        case 'VARCHAR': {
          this.next();
          let varying = t.kw === 'VARCHAR';
          if (t.kw === 'NATIONAL') {
            this.expectKw('CHARACTER', 'CHAR');
          }
          if (t.kw !== 'VARCHAR' && this.acceptKw('VARYING')) {
            varying = true;
          }
          const tn = make(varying ? 'varchar' : 'bpchar');
          this.parseTypeModifiers(tn);
          if (!varying && tn.typmods.length === 0) {
            tn.typmods = [{ kind: 'AConst', val: { type: 'integer', value: '1' } }];
          }
          if (this.acceptKws('CHARACTER', 'SET')) {
            this.parseName();
          }
          return tn;
        }
        case 'TIMESTAMP':
        case 'TIME': {
          this.next();
          const tn = make(t.kw === 'TIMESTAMP' ? 'timestamp' : 'time');
          this.parseTypeModifiers(tn);
          if (this.atKw('WITH') && this.isKw(this.peek(1), 'TIME')) {
            this.p += 2;
            this.expectKw('ZONE');
            tn.names = ['pg_catalog', t.kw === 'TIMESTAMP' ? 'timestamptz' : 'timetz'];
          } else if (this.atKw('WITHOUT') && this.isKw(this.peek(1), 'TIME')) {
            this.p += 2;
            this.expectKw('ZONE');
          }
          return tn;
        }
        case 'INTERVAL': {
          this.next();
          const tn = make('interval');
          if (this.atPunct('(')) {
            this.parseTypeModifiers(tn);
          } else {
            this.parseOptInterval(tn);
          }
          return tn;
        }
        case 'JSON':
          this.next();
          return make('json');
      }
    }
    // Generic type name: type_function_name [attrs] [typmods]  or %TYPE
    if (t.type !== 'ident') {
      this.error();
    }
    const names = this.parseAnyName();
    const tn: A.TypeName = { kind: 'TypeName', names, typmods: [], arrayBounds: [] };
    if (this.atOp('%')) {
      this.next();
      this.expectKw('TYPE');
      tn.pctType = true;
      return tn;
    }
    this.parseTypeModifiers(tn);
    // `double precision` spelled as generic after quoting etc is not handled; fine.
    return tn;
  }

  private parseOptInterval(tn: A.TypeName): void {
    const fields = ['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];
    if (!this.atKw(...fields)) {
      return;
    }
    let text = this.next().kw;
    if (text === 'SECOND' && this.atPunct('(')) {
      this.next();
      const p = this.next().value;
      this.expectPunct(')');
      tn.typmods = [{ kind: 'AConst', val: { type: 'integer', value: p } }];
    }
    if (this.acceptKw('TO')) {
      const to = this.expectKw(...fields).kw;
      text += ' TO ' + to;
      if (to === 'SECOND' && this.atPunct('(')) {
        this.next();
        const p = this.next().value;
        this.expectPunct(')');
        tn.typmods = [{ kind: 'AConst', val: { type: 'integer', value: p } }];
      }
    }
    tn.intervalFields = text;
  }
}

export { RESERVED as RESERVED_KEYWORDS, TYPE_FUNC_NAME as TYPE_FUNC_NAME_KEYWORDS, COL_NAME as COL_NAME_KEYWORDS };
