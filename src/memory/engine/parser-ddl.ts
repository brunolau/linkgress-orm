import * as A from './ast';
import { syntaxError } from './errors';
import { Parser } from './parser';

/**
 * Full statement parser: DDL and utility statements on top of the core SELECT/DML/expression parser.
 */
export class SqlParser extends Parser {
  parseUtilityStatement(): A.Statement {
    const t = this.peek();
    const loc = t.pos;
    switch (t.kw) {
      case 'CREATE':
        return this.parseCreate();
      case 'ALTER':
        return this.parseAlter();
      case 'DROP':
        return this.parseDrop();
      case 'TRUNCATE':
        return this.parseTruncate();
      case 'COMMENT':
        return this.parseComment();
      case 'BEGIN':
      case 'START':
        return this.parseBegin();
      case 'COMMIT':
      case 'END': {
        this.next();
        this.acceptKw('WORK', 'TRANSACTION');
        const chain = this.parseOptChain();
        return { kind: 'TransactionStmt', op: 'COMMIT', options: {}, chain, loc };
      }
      case 'ROLLBACK':
      case 'ABORT': {
        this.next();
        this.acceptKw('WORK', 'TRANSACTION');
        if (this.acceptKw('TO')) {
          this.acceptKw('SAVEPOINT');
          return { kind: 'TransactionStmt', op: 'ROLLBACK_TO', savepointName: this.parseName(), options: {}, loc };
        }
        if (this.atKw('PREPARED')) {
          this.next();
          return { kind: 'TransactionStmt', op: 'ROLLBACK_PREPARED', gid: this.next().value, options: {}, loc };
        }
        const chain = this.parseOptChain();
        return { kind: 'TransactionStmt', op: 'ROLLBACK', options: {}, chain, loc };
      }
      case 'SAVEPOINT':
        this.next();
        return { kind: 'TransactionStmt', op: 'SAVEPOINT', savepointName: this.parseName(), options: {}, loc };
      case 'RELEASE':
        this.next();
        this.acceptKw('SAVEPOINT');
        return { kind: 'TransactionStmt', op: 'RELEASE', savepointName: this.parseName(), options: {}, loc };
      case 'PREPARE':
        if (this.isKw(this.peek(1), 'TRANSACTION')) {
          this.next();
          this.next();
          return { kind: 'TransactionStmt', op: 'PREPARE', gid: this.next().value, options: {}, loc };
        }
        return this.parsePrepare();
      case 'SET':
        return this.parseSet();
      case 'RESET':
        return this.parseReset();
      case 'SHOW':
        return this.parseShow();
      case 'DO':
        return this.parseDo();
      case 'EXPLAIN':
        return this.parseExplain();
      case 'ANALYZE':
      case 'ANALYSE':
      case 'VACUUM':
      case 'CHECKPOINT':
      case 'REINDEX':
      case 'CLUSTER':
      case 'GRANT':
      case 'REVOKE':
      case 'SECURITY':
      case 'LOAD':
      case 'REASSIGN':
        return this.skipNoop(t.kw === 'ANALYSE' ? 'ANALYZE' : t.kw === 'SECURITY' ? 'SECURITY LABEL' : t.kw);
      case 'DISCARD': {
        this.next();
        const what = this.next().kw;
        return { kind: 'NoopStmt', tag: 'DISCARD ' + what, description: 'DISCARD ' + what, loc };
      }
      case 'LOCK':
        return this.parseLock();
      case 'CALL': {
        this.next();
        const func = this.parseExpr() as A.FuncCall;
        if (func.kind !== 'FuncCall') {
          this.error();
        }
        return { kind: 'CallStmt', func, loc };
      }
      case 'EXECUTE': {
        this.next();
        const name = this.parseName();
        const params: A.Expr[] = [];
        if (this.acceptPunct('(')) {
          params.push(...this.parseExprList());
          this.expectPunct(')');
        }
        return { kind: 'ExecuteStmt', name, params, loc };
      }
      case 'DEALLOCATE': {
        this.next();
        this.acceptKw('PREPARE');
        if (this.acceptKw('ALL')) {
          return { kind: 'DeallocateStmt', loc };
        }
        return { kind: 'DeallocateStmt', name: this.parseName(), loc };
      }
      case 'LISTEN':
        this.next();
        return { kind: 'ListenStmt', channel: this.parseName(), unlisten: false, loc };
      case 'UNLISTEN': {
        this.next();
        if (this.acceptOp('*')) {
          return { kind: 'ListenStmt', channel: '*', unlisten: true, loc };
        }
        return { kind: 'ListenStmt', channel: this.parseName(), unlisten: true, loc };
      }
      case 'NOTIFY': {
        this.next();
        const channel = this.parseName();
        let payload: string | undefined;
        if (this.acceptPunct(',')) {
          payload = this.next().value;
        }
        return { kind: 'NotifyStmt', channel, payload, loc };
      }
      case 'REFRESH': {
        this.next();
        this.expectKw('MATERIALIZED');
        this.expectKw('VIEW');
        const concurrently = this.acceptKw('CONCURRENTLY');
        const relation = this.parseRangeVar();
        let withData = true;
        if (this.acceptKw('WITH')) {
          withData = !this.acceptKw('NO');
          this.expectKw('DATA');
        }
        return { kind: 'RefreshMatViewStmt', relation, concurrently, withData, loc };
      }
      case 'COPY':
        this.skipToStatementEnd();
        return { kind: 'CopyStmt', loc };
    }
    this.error();
  }

  private parseOptChain(): boolean {
    if (this.acceptKw('AND')) {
      const no = this.acceptKw('NO');
      this.expectKw('CHAIN');
      return !no;
    }
    return false;
  }

  skipToStatementEnd(): void {
    let depth = 0;
    while (true) {
      const t = this.peek();
      if (t.type === 'eof') {
        return;
      }
      if (t.type === 'punct') {
        if (t.value === '(') {
          depth++;
        } else if (t.value === ')') {
          depth--;
        } else if (t.value === ';' && depth <= 0) {
          return;
        }
      }
      this.next();
    }
  }

  private skipNoop(tag: string): A.GenericNoopStmt {
    const loc = this.peek().pos;
    const startIdx = this.pos;
    this.skipToStatementEnd();
    return { kind: 'NoopStmt', tag, description: this.textFrom(startIdx), loc };
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  private parseCreate(): A.Statement {
    const loc = this.expectKw('CREATE').pos;
    let replace = false;
    if (this.acceptKws('OR', 'REPLACE')) {
      replace = true;
    }
    let temp = false;
    let unlogged = false;
    if (this.acceptKw('GLOBAL', 'LOCAL')) {
      this.expectKw('TEMPORARY', 'TEMP');
      temp = true;
    } else if (this.acceptKw('TEMPORARY', 'TEMP')) {
      temp = true;
    } else if (this.acceptKw('UNLOGGED')) {
      unlogged = true;
    }
    const t = this.peek();
    switch (t.kw) {
      case 'TABLE':
        return this.parseCreateTable(temp, unlogged, loc);
      case 'UNIQUE':
      case 'INDEX':
        return this.parseCreateIndex(loc);
      case 'SEQUENCE':
        return this.parseCreateSequence(temp, loc);
      case 'SCHEMA': {
        this.next();
        const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
        let name: string | undefined;
        let authorization: string | undefined;
        if (this.acceptKw('AUTHORIZATION')) {
          authorization = this.parseName();
          name = authorization;
        } else {
          name = this.parseName();
          if (this.acceptKw('AUTHORIZATION')) {
            authorization = this.parseName();
          }
        }
        return { kind: 'CreateSchemaStmt', name, ifNotExists, authorization, loc };
      }
      case 'TYPE':
        return this.parseCreateType(loc);
      case 'DOMAIN': {
        this.next();
        const domainName = this.parseAnyName();
        this.acceptKw('AS');
        const typeName = this.parseTypeName();
        const stmt: A.CreateDomainStmt = { kind: 'CreateDomainStmt', domainName, typeName, constraints: [], loc };
        this.parseColumnConstraints(stmt.constraints, (c) => (stmt.collate = c));
        return stmt;
      }
      case 'FUNCTION':
      case 'PROCEDURE':
        return this.parseCreateFunction(replace, t.kw === 'PROCEDURE', loc);
      case 'TRIGGER':
      case 'CONSTRAINT':
        return this.parseCreateTrigger(replace, loc);
      case 'RECURSIVE':
      case 'VIEW':
        return this.parseCreateView(replace, temp, loc);
      case 'MATERIALIZED':
        return this.parseCreateMatView(loc);
      case 'EXTENSION': {
        this.next();
        const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
        const name = this.parseName();
        const stmt: A.CreateExtensionStmt = { kind: 'CreateExtensionStmt', name, ifNotExists, cascade: false, loc };
        this.acceptKw('WITH');
        while (true) {
          if (this.acceptKw('SCHEMA')) {
            stmt.schema = this.parseName();
          } else if (this.acceptKw('VERSION')) {
            stmt.version = this.next().value;
          } else if (this.acceptKw('CASCADE')) {
            stmt.cascade = true;
          } else {
            break;
          }
        }
        return stmt;
      }
      case 'COLLATION': {
        this.next();
        const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
        const name = this.parseAnyName();
        if (this.acceptKw('FROM')) {
          return { kind: 'CreateCollationStmt', name, ifNotExists, options: [], from: this.parseAnyName(), loc };
        }
        this.expectPunct('(');
        const options = this.parseDefElemList();
        this.expectPunct(')');
        return { kind: 'CreateCollationStmt', name, ifNotExists, options, loc };
      }
      case 'STATISTICS':
        return this.parseCreateStatistics(loc);
      case 'ROLE':
      case 'USER':
      case 'GROUP':
      case 'POLICY':
      case 'PUBLICATION':
      case 'SUBSCRIPTION':
      case 'DATABASE':
      case 'TABLESPACE':
      case 'EVENT':
      case 'SERVER':
      case 'FOREIGN':
      case 'CAST':
      case 'OPERATOR':
      case 'AGGREGATE':
      case 'LANGUAGE':
      case 'RULE': {
        const tag = 'CREATE ' + t.kw;
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag, description: tag, loc };
      }
    }
    this.error();
  }

  private parseCreateTable(temp: boolean, unlogged: boolean, loc: number): A.Statement {
    this.expectKw('TABLE');
    const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
    const relation = this.parseRangeVar();
    const stmt: A.CreateTableStmt = {
      kind: 'CreateTableStmt',
      relation,
      temp,
      unlogged,
      ifNotExists,
      columns: [],
      constraints: [],
      inherits: [],
      loc,
    };

    if (this.acceptKws('PARTITION', 'OF')) {
      stmt.partitionOf = this.parseRangeVar();
      if (this.atPunct('(')) {
        this.next();
        this.parseTableElements(stmt, true);
        this.expectPunct(')');
      }
      stmt.partitionBound = this.parsePartitionBound();
    } else if (this.atPunct('(')) {
      this.next();
      if (!this.atPunct(')')) {
        this.parseTableElements(stmt, false);
      }
      this.expectPunct(')');
    } else if (this.atKw('AS') || (this.atPunct('('))) {
      // handled below
    }

    // CREATE TABLE ... AS
    if (this.atKw('AS') && stmt.columns.length === 0 && !stmt.partitionOf) {
      this.next();
      const query = this.atKw('EXECUTE') ? this.parseStatement() : this.parsePreparableStatement();
      let withData = true;
      if (this.acceptKw('WITH')) {
        withData = !this.acceptKw('NO');
        this.expectKw('DATA');
      }
      return { kind: 'CreateTableAsStmt', relation, temp, ifNotExists, query, withData, isMaterializedView: false, loc };
    }

    while (true) {
      if (this.acceptKw('INHERITS')) {
        this.expectPunct('(');
        do {
          stmt.inherits.push(this.parseRangeVar());
        } while (this.acceptPunct(','));
        this.expectPunct(')');
        continue;
      }
      if (this.atKw('PARTITION') && this.isKw(this.peek(1), 'BY')) {
        this.next();
        this.next();
        const strategy = this.expectKw('RANGE', 'LIST', 'HASH').kw as A.PartitionSpec['strategy'];
        this.expectPunct('(');
        const params = this.parseIndexElems();
        this.expectPunct(')');
        stmt.partitionSpec = { strategy, params };
        continue;
      }
      if (this.acceptKw('USING')) {
        this.parseName();
        continue;
      }
      if (this.atKw('WITH') && this.atPunct('(', 1)) {
        this.next();
        this.next();
        stmt.withOptions = this.parseDefElemList();
        this.expectPunct(')');
        continue;
      }
      if (this.acceptKws('WITHOUT', 'OIDS')) {
        continue;
      }
      if (this.acceptKws('ON', 'COMMIT')) {
        if (this.acceptKw('DROP')) {
          stmt.onCommit = 'DROP';
        } else if (this.acceptKws('DELETE', 'ROWS')) {
          stmt.onCommit = 'DELETE_ROWS';
        } else {
          this.expectKw('PRESERVE');
          this.expectKw('ROWS');
          stmt.onCommit = 'PRESERVE_ROWS';
        }
        continue;
      }
      if (this.acceptKw('TABLESPACE')) {
        this.parseName();
        continue;
      }
      break;
    }
    if (this.atKw('AS')) {
      this.next();
      const query = this.parsePreparableStatement();
      return {
        kind: 'CreateTableAsStmt',
        relation,
        temp,
        ifNotExists,
        columnNames: stmt.columns.map((c) => c.name),
        query,
        withData: true,
        isMaterializedView: false,
        loc,
      };
    }
    return stmt;
  }

  private parsePartitionBound(): A.PartitionBound {
    if (this.acceptKw('DEFAULT')) {
      return { kind: 'DEFAULT' };
    }
    this.expectKw('FOR');
    this.expectKw('VALUES');
    if (this.acceptKw('IN')) {
      this.expectPunct('(');
      const values = this.parseExprList();
      this.expectPunct(')');
      return { kind: 'LIST', values };
    }
    if (this.acceptKw('FROM')) {
      this.expectPunct('(');
      const from = this.parseExprList();
      this.expectPunct(')');
      this.expectKw('TO');
      this.expectPunct('(');
      const to = this.parseExprList();
      this.expectPunct(')');
      return { kind: 'RANGE', from, to };
    }
    this.expectKw('WITH');
    this.expectPunct('(');
    let modulus = 0;
    let remainder = 0;
    do {
      const name = this.parseName();
      const v = parseInt(this.next().value, 10);
      if (name === 'modulus') {
        modulus = v;
      } else {
        remainder = v;
      }
    } while (this.acceptPunct(','));
    this.expectPunct(')');
    return { kind: 'HASH', modulus, remainder };
  }

  private parseTableElements(stmt: A.CreateTableStmt, partitionOf: boolean): void {
    do {
      const t = this.peek();
      if (this.isKw(t, 'CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE')) {
        stmt.constraints.push(this.parseTableConstraint());
        continue;
      }
      if (this.isKw(t, 'LIKE')) {
        this.next();
        stmt.like = stmt.like ?? [];
        stmt.like.push(this.parseRangeVar());
        while (this.atKw('INCLUDING', 'EXCLUDING')) {
          this.next();
          this.next();
        }
        continue;
      }
      stmt.columns.push(this.parseColumnDef(partitionOf));
    } while (this.acceptPunct(','));
  }

  parseColumnDef(partitionOf: boolean): A.ColumnDef {
    const loc = this.peek().pos;
    const name = this.parseName();
    let typeName: A.TypeName;
    if (partitionOf || this.atKw('WITH')) {
      if (this.acceptKw('WITH')) {
        this.expectKw('OPTIONS');
      }
      typeName = { kind: 'TypeName', names: [], typmods: [], arrayBounds: [] };
    } else {
      typeName = this.parseTypeName();
    }
    const def: A.ColumnDef = { name, typeName, constraints: [], loc };
    this.parseColumnConstraints(def.constraints, (c) => (def.collate = c));
    return def;
  }

  private parseColumnConstraints(out: A.ColumnConstraint[], setCollate: (c: string[]) => void): void {
    while (true) {
      let name: string | undefined;
      if (this.acceptKw('CONSTRAINT')) {
        name = this.parseName();
      }
      if (this.acceptKw('COLLATE')) {
        setCollate(this.parseAnyName());
        continue;
      }
      if (this.acceptKw('STORAGE')) {
        this.next();
        continue;
      }
      if (this.acceptKw('COMPRESSION')) {
        this.next();
        continue;
      }
      if (this.acceptKws('NOT', 'NULL')) {
        this.acceptKws('NO', 'INHERIT');
        out.push({ kind: 'NOT_NULL', name });
      } else if (this.acceptKw('NULL')) {
        out.push({ kind: 'NULL', name });
      } else if (this.acceptKw('DEFAULT')) {
        out.push({ kind: 'DEFAULT', expr: this.parseExpr(4), name });
      } else if (this.acceptKw('CHECK')) {
        this.expectPunct('(');
        const startIdx = this.pos;
        const expr = this.parseExpr();
        const exprText = this.textFrom(startIdx);
        this.expectPunct(')');
        const noInherit = this.acceptKws('NO', 'INHERIT');
        out.push({ kind: 'CHECK', expr, exprText, noInherit, name });
      } else if (this.acceptKws('PRIMARY', 'KEY')) {
        out.push({ kind: 'PRIMARY_KEY', name, options: this.parseIndexParameters() });
      } else if (this.acceptKw('UNIQUE')) {
        let nullsNotDistinct = false;
        if (this.acceptKw('NULLS')) {
          nullsNotDistinct = this.acceptKw('NOT');
          this.expectKw('DISTINCT');
        }
        out.push({ kind: 'UNIQUE', name, nullsNotDistinct, options: this.parseIndexParameters() });
      } else if (this.acceptKw('REFERENCES')) {
        out.push({ kind: 'REFERENCES', name, fk: this.parseReferences() });
      } else if (this.acceptKw('GENERATED')) {
        if (this.acceptKw('ALWAYS')) {
          this.expectKw('AS');
          if (this.acceptKw('IDENTITY')) {
            out.push({ kind: 'IDENTITY', name, always: true, seqOptions: this.parseOptParenSeqOptions() });
          } else {
            this.expectPunct('(');
            const startIdx = this.pos;
            const expr = this.parseExpr();
            const exprText = this.textFrom(startIdx);
            this.expectPunct(')');
            let stored = true;
            if (this.acceptKw('STORED')) {
              stored = true;
            } else if (this.acceptKw('VIRTUAL')) {
              stored = false;
            }
            out.push({ kind: 'GENERATED', name, expr, exprText, stored });
          }
        } else {
          this.expectKw('BY');
          this.expectKw('DEFAULT');
          this.expectKw('AS');
          this.expectKw('IDENTITY');
          out.push({ kind: 'IDENTITY', name, always: false, seqOptions: this.parseOptParenSeqOptions() });
        }
      } else if (this.atKw('DEFERRABLE', 'INITIALLY', 'NOT') || this.atKw('ENFORCED')) {
        if (this.acceptKws('NOT', 'DEFERRABLE') || this.acceptKw('DEFERRABLE')) {
          continue;
        }
        if (this.acceptKw('INITIALLY')) {
          this.next();
          continue;
        }
        if (this.acceptKws('NOT', 'ENFORCED') || this.acceptKw('ENFORCED')) {
          continue;
        }
        this.error();
      } else {
        if (name) {
          this.error();
        }
        return;
      }
    }
  }

  private parseOptParenSeqOptions(): A.SequenceOption[] {
    if (this.acceptPunct('(')) {
      const opts = this.parseSequenceOptions(true);
      this.expectPunct(')');
      return opts;
    }
    return [];
  }

  private parseIndexParameters(): A.IndexOptions {
    const opts: A.IndexOptions = {};
    if (this.acceptKw('INCLUDE')) {
      this.expectPunct('(');
      opts.include = this.parseNameList();
      this.expectPunct(')');
    }
    if (this.atKw('WITH') && this.atPunct('(', 1)) {
      this.next();
      this.next();
      opts.withOptions = this.parseDefElemList();
      this.expectPunct(')');
    }
    if (this.acceptKws('USING', 'INDEX', 'TABLESPACE')) {
      opts.tablespace = this.parseName();
    }
    return opts;
  }

  private parseReferences(): A.ForeignKeySpec {
    const refTable = this.parseRangeVar();
    let refColumns: string[] = [];
    if (this.acceptPunct('(')) {
      refColumns = this.parseNameList();
      this.expectPunct(')');
    }
    const fk: A.ForeignKeySpec = { refTable, refColumns, matchType: 'SIMPLE', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
    while (true) {
      if (this.acceptKw('MATCH')) {
        fk.matchType = this.expectKw('FULL', 'PARTIAL', 'SIMPLE').kw as A.ForeignKeySpec['matchType'];
        continue;
      }
      if (this.atKw('ON') && this.isKw(this.peek(1), 'DELETE', 'UPDATE')) {
        this.next();
        const which = this.next().kw;
        const action = this.parseFkAction();
        if (which === 'DELETE') {
          fk.onDelete = action.action;
          fk.deleteSetColumns = action.columns;
        } else {
          fk.onUpdate = action.action;
        }
        continue;
      }
      if (this.acceptKws('NOT', 'DEFERRABLE')) {
        fk.deferrable = false;
        continue;
      }
      if (this.acceptKw('DEFERRABLE')) {
        fk.deferrable = true;
        continue;
      }
      if (this.acceptKw('INITIALLY')) {
        fk.initiallyDeferred = this.next().kw === 'DEFERRED';
        continue;
      }
      break;
    }
    return fk;
  }

  private parseFkAction(): { action: A.FkAction; columns?: string[] } {
    if (this.acceptKws('NO', 'ACTION')) {
      return { action: 'NO ACTION' };
    }
    if (this.acceptKw('RESTRICT')) {
      return { action: 'RESTRICT' };
    }
    if (this.acceptKw('CASCADE')) {
      return { action: 'CASCADE' };
    }
    this.expectKw('SET');
    const which = this.expectKw('NULL', 'DEFAULT').kw;
    let columns: string[] | undefined;
    if (this.acceptPunct('(')) {
      columns = this.parseNameList();
      this.expectPunct(')');
    }
    return { action: which === 'NULL' ? 'SET NULL' : 'SET DEFAULT', columns };
  }

  parseTableConstraint(): A.TableConstraint {
    const loc = this.peek().pos;
    let name: string | undefined;
    if (this.acceptKw('CONSTRAINT')) {
      name = this.parseName();
    }
    let c: A.TableConstraint;
    if (this.acceptKw('CHECK')) {
      this.expectPunct('(');
      const startIdx = this.pos;
      const expr = this.parseExpr();
      const exprText = this.textFrom(startIdx);
      this.expectPunct(')');
      c = { kind: 'CHECK', name, expr, exprText, loc };
      if (this.acceptKws('NO', 'INHERIT')) {
        c.noInherit = true;
      }
    } else if (this.acceptKw('UNIQUE')) {
      let nullsNotDistinct = false;
      if (this.acceptKw('NULLS')) {
        nullsNotDistinct = this.acceptKw('NOT');
        this.expectKw('DISTINCT');
      }
      this.expectPunct('(');
      const columns = this.parseNameList();
      this.expectPunct(')');
      c = { kind: 'UNIQUE', name, columns, nullsNotDistinct, options: this.parseIndexParameters(), loc };
    } else if (this.acceptKws('PRIMARY', 'KEY')) {
      this.expectPunct('(');
      const columns = this.parseNameList();
      this.expectPunct(')');
      c = { kind: 'PRIMARY_KEY', name, columns, options: this.parseIndexParameters(), loc };
    } else if (this.acceptKws('FOREIGN', 'KEY')) {
      this.expectPunct('(');
      const columns = this.parseNameList();
      this.expectPunct(')');
      this.expectKw('REFERENCES');
      c = { kind: 'FOREIGN_KEY', name, columns, fk: this.parseReferences(), loc };
    } else if (this.acceptKw('EXCLUDE')) {
      this.skipBalancedUntilConstraintEnd();
      c = { kind: 'EXCLUDE', name, loc };
    } else {
      this.error();
    }
    // trailing attributes
    while (true) {
      if (this.acceptKws('NOT', 'VALID')) {
        (c as { notValid?: boolean }).notValid = true;
        continue;
      }
      if (this.acceptKws('NOT', 'DEFERRABLE') || this.acceptKw('DEFERRABLE')) {
        continue;
      }
      if (this.acceptKw('INITIALLY')) {
        this.next();
        continue;
      }
      if (this.acceptKws('NOT', 'ENFORCED') || this.acceptKw('ENFORCED')) {
        continue;
      }
      break;
    }
    return c;
  }

  private skipBalancedUntilConstraintEnd(): void {
    let depth = 0;
    while (true) {
      const t = this.peek();
      if (t.type === 'eof') {
        return;
      }
      if (t.type === 'punct') {
        if (t.value === '(') {
          depth++;
        } else if (t.value === ')') {
          if (depth === 0) {
            return;
          }
          depth--;
        } else if ((t.value === ',' || t.value === ';') && depth === 0) {
          return;
        }
      }
      this.next();
    }
  }

  private parseCreateIndex(loc: number): A.CreateIndexStmt {
    const unique = this.acceptKw('UNIQUE');
    this.expectKw('INDEX');
    const concurrently = this.acceptKw('CONCURRENTLY');
    const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
    let name: string | undefined;
    if (!this.atKw('ON')) {
      name = this.parseName();
    }
    this.expectKw('ON');
    const only = this.acceptKw('ONLY');
    const relation = this.parseRangeVar();
    let method = 'btree';
    if (this.acceptKw('USING')) {
      method = this.parseName();
    }
    this.expectPunct('(');
    const params = this.parseIndexElems();
    this.expectPunct(')');
    const stmt: A.CreateIndexStmt = {
      kind: 'CreateIndexStmt',
      name,
      relation,
      unique,
      concurrently,
      ifNotExists,
      method,
      params,
      include: [],
      withOptions: [],
      where: null,
      nullsNotDistinct: false,
      only,
      loc,
    };
    while (true) {
      if (this.acceptKw('INCLUDE')) {
        this.expectPunct('(');
        stmt.include = this.parseNameList();
        this.expectPunct(')');
        continue;
      }
      if (this.atKw('NULLS')) {
        this.next();
        stmt.nullsNotDistinct = this.acceptKw('NOT');
        this.expectKw('DISTINCT');
        continue;
      }
      if (this.atKw('WITH') && this.atPunct('(', 1)) {
        this.next();
        this.next();
        stmt.withOptions = this.parseDefElemList();
        this.expectPunct(')');
        continue;
      }
      if (this.acceptKw('TABLESPACE')) {
        stmt.tablespace = this.parseName();
        continue;
      }
      if (this.acceptKw('WHERE')) {
        const startIdx = this.pos;
        stmt.where = this.parseExpr();
        stmt.whereText = this.textFrom(startIdx);
        continue;
      }
      break;
    }
    return stmt;
  }

  private parseCreateSequence(temp: boolean, loc: number): A.CreateSequenceStmt {
    this.expectKw('SEQUENCE');
    const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
    const sequence = this.parseRangeVar();
    const options = this.parseSequenceOptions(false);
    return { kind: 'CreateSequenceStmt', sequence, temp, ifNotExists, options, loc };
  }

  parseSequenceOptions(inParens: boolean): A.SequenceOption[] {
    const opts: A.SequenceOption[] = [];
    const num = (): string => {
      let sign = '';
      if (this.atOp('-')) {
        this.next();
        sign = '-';
      } else if (this.atOp('+')) {
        this.next();
      }
      const t = this.next();
      if (t.type !== 'integer' && t.type !== 'numeric') {
        this.error(t);
      }
      return sign + t.value;
    };
    while (true) {
      if (inParens && this.atPunct(')')) {
        break;
      }
      if (this.acceptKw('AS')) {
        opts.push({ name: 'as', typeName: this.parseTypeName() });
      } else if (this.acceptKw('INCREMENT')) {
        this.acceptKw('BY');
        opts.push({ name: 'increment', value: num() });
      } else if (this.acceptKws('NO', 'MINVALUE')) {
        opts.push({ name: 'minvalue', value: null });
      } else if (this.acceptKws('NO', 'MAXVALUE')) {
        opts.push({ name: 'maxvalue', value: null });
      } else if (this.acceptKws('NO', 'CYCLE')) {
        opts.push({ name: 'cycle', value: false });
      } else if (this.acceptKw('MINVALUE')) {
        opts.push({ name: 'minvalue', value: num() });
      } else if (this.acceptKw('MAXVALUE')) {
        opts.push({ name: 'maxvalue', value: num() });
      } else if (this.acceptKw('START')) {
        this.acceptKw('WITH');
        opts.push({ name: 'start', value: num() });
      } else if (this.acceptKw('RESTART')) {
        if (this.acceptKw('WITH') || this.peek().type === 'integer' || this.atOp('-')) {
          opts.push({ name: 'restart', value: num() });
        } else {
          opts.push({ name: 'restart', value: null });
        }
      } else if (this.acceptKw('CACHE')) {
        opts.push({ name: 'cache', value: num() });
      } else if (this.acceptKw('CYCLE')) {
        opts.push({ name: 'cycle', value: true });
      } else if (this.acceptKws('OWNED', 'BY')) {
        if (this.acceptKw('NONE')) {
          opts.push({ name: 'owned_by', value: null });
        } else {
          opts.push({ name: 'owned_by', value: this.parseAnyName() });
        }
      } else if (this.acceptKws('SEQUENCE', 'NAME')) {
        opts.push({ name: 'sequence_name', value: this.parseAnyName() });
      } else if (this.acceptKw('LOGGED', 'UNLOGGED')) {
        // ignore
      } else {
        break;
      }
    }
    return opts;
  }

  private parseCreateType(loc: number): A.Statement {
    this.expectKw('TYPE');
    const typeName = this.parseAnyName();
    this.expectKw('AS');
    if (this.acceptKw('ENUM')) {
      this.expectPunct('(');
      const labels: string[] = [];
      if (!this.atPunct(')')) {
        do {
          const t = this.next();
          if (t.type !== 'string') {
            this.error(t);
          }
          labels.push(t.value);
        } while (this.acceptPunct(','));
      }
      this.expectPunct(')');
      return { kind: 'CreateEnumStmt', typeName, labels, loc };
    }
    if (this.atPunct('(')) {
      this.next();
      const columns = this.atPunct(')') ? [] : this.parseColDefShortList();
      this.expectPunct(')');
      return { kind: 'CreateCompositeTypeStmt', typeName, columns, loc };
    }
    this.skipToStatementEnd();
    return { kind: 'NoopStmt', tag: 'CREATE TYPE', description: 'CREATE TYPE (unsupported form)', loc };
  }

  private parseCreateFunction(replace: boolean, isProcedure: boolean, loc: number): A.CreateFunctionStmt {
    this.next();
    const funcname = this.parseAnyName();
    this.expectPunct('(');
    const parameters: A.FunctionParameter[] = [];
    if (!this.atPunct(')')) {
      do {
        parameters.push(this.parseFunctionParameter());
      } while (this.acceptPunct(','));
    }
    this.expectPunct(')');
    const stmt: A.CreateFunctionStmt = {
      kind: 'CreateFunctionStmt',
      isProcedure,
      replace,
      funcname,
      parameters,
      language: 'sql',
      body: '',
      volatility: 'VOLATILE',
      strict: false,
      securityDefiner: false,
      loc,
    };
    if (this.acceptKw('RETURNS')) {
      if (this.acceptKw('TABLE')) {
        this.expectPunct('(');
        stmt.returnsTable = this.parseColDefShortList();
        this.expectPunct(')');
      } else {
        stmt.returnType = this.parseTypeName();
      }
    }
    let languageSet = false;
    while (true) {
      if (this.acceptKw('LANGUAGE')) {
        stmt.language = this.parseName();
        languageSet = true;
      } else if (this.acceptKw('AS')) {
        const t = this.next();
        if (t.type !== 'string') {
          this.error(t);
        }
        stmt.body = t.value;
        if (this.acceptPunct(',')) {
          this.next();
        }
      } else if (this.acceptKw('IMMUTABLE')) {
        stmt.volatility = 'IMMUTABLE';
      } else if (this.acceptKw('STABLE')) {
        stmt.volatility = 'STABLE';
      } else if (this.acceptKw('VOLATILE')) {
        stmt.volatility = 'VOLATILE';
      } else if (this.acceptKw('STRICT')) {
        stmt.strict = true;
      } else if (this.acceptKws('RETURNS', 'NULL', 'ON', 'NULL', 'INPUT')) {
        stmt.strict = true;
      } else if (this.acceptKws('CALLED', 'ON', 'NULL', 'INPUT')) {
        stmt.strict = false;
      } else if (this.acceptKws('NOT', 'LEAKPROOF') || this.acceptKw('LEAKPROOF')) {
        // ignore
      } else if (this.acceptKw('EXTERNAL')) {
        // SECURITY follows
      } else if (this.acceptKw('SECURITY')) {
        stmt.securityDefiner = this.next().kw === 'DEFINER';
      } else if (this.acceptKw('PARALLEL')) {
        stmt.parallel = this.parseName();
      } else if (this.acceptKw('COST', 'ROWS')) {
        this.next();
      } else if (this.acceptKw('SUPPORT')) {
        this.parseAnyName();
      } else if (this.acceptKw('WINDOW')) {
        // ignore
      } else if (this.atKw('SET')) {
        this.next();
        const name = this.parseAnyName().join('.');
        if (this.acceptKw('FROM')) {
          this.expectKw('CURRENT');
        } else {
          if (!this.acceptKw('TO')) {
            this.expectOp('=');
          }
          const values: string[] = [];
          do {
            values.push(String(this.parseDefArg()));
          } while (this.acceptPunct(','));
          stmt.setOptions = stmt.setOptions ?? [];
          stmt.setOptions.push({ name, value: values });
        }
      } else if (this.atKw('RETURN')) {
        this.next();
        const expr = this.parseExpr();
        const sel = Parser.emptySelect();
        sel.targetList = [{ val: expr }];
        stmt.sqlBody = [sel];
        if (!languageSet) {
          stmt.language = 'sql';
        }
      } else if (this.atKw('BEGIN') && this.isKw(this.peek(1), 'ATOMIC')) {
        this.next();
        this.next();
        const body: A.Statement[] = [];
        while (!this.atKw('END')) {
          if (this.acceptPunct(';')) {
            continue;
          }
          body.push(this.parseStatement());
        }
        this.expectKw('END');
        stmt.sqlBody = body;
      } else if (this.acceptKw('TRANSFORM')) {
        this.skipToStatementEnd();
      } else {
        break;
      }
    }
    return stmt;
  }

  private parseFunctionParameter(): A.FunctionParameter {
    let mode: A.FunctionParameter['mode'] = 'IN';
    if (this.atKw('IN', 'OUT', 'INOUT', 'VARIADIC')) {
      const kw = this.peek().kw;
      // "IN" could also be a parameter name only if followed by a type; treat as mode
      this.next();
      if (kw === 'IN' && this.acceptKw('OUT')) {
        mode = 'INOUT';
      } else {
        mode = kw as A.FunctionParameter['mode'];
      }
    }
    let name: string | undefined;
    // name present if followed by another type-name-like token (not , ) DEFAULT =)
    const t0 = this.peek();
    const t1 = this.peek(1);
    const nextIsTypeStart = t1.type === 'ident' && !this.isKw(t1, 'DEFAULT');
    if (t0.type === 'ident' && nextIsTypeStart && !(this.isKw(t0, 'DOUBLE') && this.isKw(t1, 'PRECISION'))) {
      // "character varying", "timestamp with time zone" etc. are handled by type parser; a name
      // is only assumed when the first token can't start a multi-word type.
      if (!this.isKw(t0, 'CHARACTER', 'CHAR', 'NATIONAL', 'BIT', 'TIMESTAMP', 'TIME', 'INTERVAL', 'DOUBLE')) {
        name = this.parseName();
      }
    }
    const typeName = this.parseTypeName();
    const param: A.FunctionParameter = { name, typeName, mode };
    if (this.acceptKw('DEFAULT') || this.acceptOp('=')) {
      param.defexpr = this.parseExpr();
    }
    return param;
  }

  private parseCreateTrigger(replace: boolean, loc: number): A.CreateTriggerStmt {
    this.acceptKw('CONSTRAINT');
    this.expectKw('TRIGGER');
    const name = this.parseName();
    let timing: A.CreateTriggerStmt['timing'];
    if (this.acceptKw('BEFORE')) {
      timing = 'BEFORE';
    } else if (this.acceptKw('AFTER')) {
      timing = 'AFTER';
    } else {
      this.expectKw('INSTEAD');
      this.expectKw('OF');
      timing = 'INSTEAD OF';
    }
    const events: A.CreateTriggerStmt['events'] = [];
    let updateColumns: string[] | undefined;
    do {
      const ev = this.expectKw('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE').kw as 'INSERT';
      events.push(ev);
      if (ev === ('UPDATE' as string) && this.acceptKw('OF')) {
        updateColumns = this.parseNameList();
      }
    } while (this.acceptKw('OR'));
    this.expectKw('ON');
    const relation = this.parseRangeVar();
    let forEachRow = false;
    const transitionRels: { isNew: boolean; name: string }[] = [];
    while (true) {
      if (this.acceptKw('FOR')) {
        this.acceptKw('EACH');
        forEachRow = this.expectKw('ROW', 'STATEMENT').kw === 'ROW';
        continue;
      }
      if (this.acceptKw('REFERENCING')) {
        while (this.atKw('OLD', 'NEW')) {
          const isNew = this.next().kw === 'NEW';
          this.expectKw('TABLE');
          this.acceptKw('AS');
          transitionRels.push({ isNew, name: this.parseName() });
        }
        continue;
      }
      if (this.acceptKws('NOT', 'DEFERRABLE') || this.acceptKw('DEFERRABLE')) {
        continue;
      }
      if (this.acceptKw('INITIALLY')) {
        this.next();
        continue;
      }
      if (this.acceptKw('FROM')) {
        this.parseRangeVar();
        continue;
      }
      break;
    }
    let when: A.Expr | null = null;
    let whenText: string | undefined;
    if (this.acceptKw('WHEN')) {
      this.expectPunct('(');
      const startIdx = this.pos;
      when = this.parseExpr();
      whenText = this.textFrom(startIdx);
      this.expectPunct(')');
    }
    this.expectKw('EXECUTE');
    this.expectKw('FUNCTION', 'PROCEDURE');
    const funcname = this.parseAnyName();
    this.expectPunct('(');
    const args: string[] = [];
    if (!this.atPunct(')')) {
      do {
        args.push(this.next().value);
      } while (this.acceptPunct(','));
    }
    this.expectPunct(')');
    return { kind: 'CreateTriggerStmt', replace, name, relation, timing, events, updateColumns, forEachRow, transitionRels, when, whenText, funcname, args, loc };
  }

  private parseCreateView(replace: boolean, temp: boolean, loc: number): A.ViewStmt {
    this.acceptKw('RECURSIVE');
    this.expectKw('VIEW');
    const view = this.parseRangeVar();
    let aliases: string[] | undefined;
    if (this.acceptPunct('(')) {
      aliases = this.parseNameList();
      this.expectPunct(')');
    }
    let options: A.DefElem[] | undefined;
    if (this.atKw('WITH') && this.atPunct('(', 1)) {
      this.next();
      this.next();
      options = this.parseDefElemList();
      this.expectPunct(')');
    }
    this.expectKw('AS');
    const startIdx = this.pos;
    const query = this.parseSelectStatement();
    const queryText = this.textFrom(startIdx);
    let withCheckOption: string | undefined;
    if (this.atKw('WITH') && this.isKw(this.peek(1), 'CASCADED', 'LOCAL', 'CHECK')) {
      this.next();
      withCheckOption = this.acceptKw('LOCAL') ? 'local' : (this.acceptKw('CASCADED'), 'cascaded');
      this.expectKw('CHECK');
      this.expectKw('OPTION');
    }
    return { kind: 'ViewStmt', view, replace, temp, aliases, query, queryText, withCheckOption, options, loc };
  }

  private parseCreateMatView(loc: number): A.CreateTableAsStmt {
    this.expectKw('MATERIALIZED');
    this.expectKw('VIEW');
    const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
    const relation = this.parseRangeVar();
    let columnNames: string[] | undefined;
    if (this.acceptPunct('(')) {
      columnNames = this.parseNameList();
      this.expectPunct(')');
    }
    if (this.atKw('WITH') && this.atPunct('(', 1)) {
      this.next();
      this.next();
      this.parseDefElemList();
      this.expectPunct(')');
    }
    this.expectKw('AS');
    const query = this.parseSelectStatement();
    let withData = true;
    if (this.acceptKw('WITH')) {
      withData = !this.acceptKw('NO');
      this.expectKw('DATA');
    }
    return { kind: 'CreateTableAsStmt', relation, temp: false, ifNotExists, columnNames, query, withData, isMaterializedView: true, loc };
  }

  private parseCreateStatistics(loc: number): A.CreateStatsStmt {
    this.expectKw('STATISTICS');
    const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
    let name: string[] | undefined;
    if (!this.atPunct('(') && !this.atKw('ON')) {
      name = this.parseAnyName();
    }
    const kinds: string[] = [];
    if (this.acceptPunct('(')) {
      do {
        kinds.push(this.parseName());
      } while (this.acceptPunct(','));
      this.expectPunct(')');
    }
    this.expectKw('ON');
    const exprs: A.CreateStatsStmt['exprs'] = [];
    do {
      if (this.atPunct('(')) {
        this.next();
        const startIdx = this.pos;
        const expr = this.parseExpr();
        exprs.push({ expr, exprText: this.textFrom(startIdx) });
        this.expectPunct(')');
      } else {
        exprs.push({ name: this.parseName() });
      }
    } while (this.acceptPunct(','));
    this.expectKw('FROM');
    const relation = this.parseRangeVar();
    return { kind: 'CreateStatsStmt', name, ifNotExists, kinds, exprs, relation, loc };
  }

  // -------------------------------------------------------------------------
  // ALTER
  // -------------------------------------------------------------------------

  private parseAlter(): A.Statement {
    const loc = this.expectKw('ALTER').pos;
    const t = this.peek();
    switch (t.kw) {
      case 'TABLE':
      case 'INDEX':
      case 'VIEW':
      case 'FOREIGN':
      case 'MATERIALIZED': {
        let objectType = t.kw as A.AlterTableStmt['objectType'];
        this.next();
        if (t.kw === 'MATERIALIZED') {
          this.expectKw('VIEW');
          objectType = 'MATERIALIZED VIEW';
        } else if (t.kw === 'FOREIGN') {
          this.expectKw('TABLE');
          objectType = 'FOREIGN TABLE';
        }
        if (this.atKw('ALL') && this.isKw(this.peek(1), 'IN')) {
          this.skipToStatementEnd();
          return { kind: 'NoopStmt', tag: 'ALTER ' + objectType, description: 'ALTER ... ALL IN TABLESPACE', loc };
        }
        const ifExists = this.acceptKws('IF', 'EXISTS');
        const only = this.atKw('ONLY');
        const relation = this.parseRangeVar();
        // RENAME forms
        if (this.atKw('RENAME')) {
          this.next();
          if (this.acceptKw('TO')) {
            return { kind: 'RenameStmt', objectType: objectType === 'INDEX' ? 'INDEX' : objectType === 'VIEW' ? 'VIEW' : 'TABLE', relation, newname: this.parseName(), ifExists, loc };
          }
          if (this.acceptKw('CONSTRAINT')) {
            const subname = this.parseName();
            this.expectKw('TO');
            return { kind: 'RenameStmt', objectType: 'CONSTRAINT', relation, subname, newname: this.parseName(), ifExists, loc };
          }
          this.acceptKw('COLUMN');
          const subname = this.parseName();
          this.expectKw('TO');
          return { kind: 'RenameStmt', objectType: 'COLUMN', relation, subname, newname: this.parseName(), ifExists, loc };
        }
        const cmds: A.AlterTableCmd[] = [];
        do {
          cmds.push(this.parseAlterTableCmd());
        } while (this.acceptPunct(','));
        return { kind: 'AlterTableStmt', relation, objectType, ifExists, only, cmds, loc };
      }
      case 'SEQUENCE': {
        this.next();
        const ifExists = this.acceptKws('IF', 'EXISTS');
        const sequence = this.parseRangeVar();
        if (this.acceptKw('RENAME')) {
          this.expectKw('TO');
          return { kind: 'RenameStmt', objectType: 'SEQUENCE', relation: sequence, newname: this.parseName(), ifExists, loc };
        }
        if (this.atKw('OWNER', 'SET')) {
          if (this.isKw(this.peek(1), 'SCHEMA')) {
            this.next();
            this.next();
            return {
              kind: 'AlterTableStmt',
              relation: sequence,
              objectType: 'SEQUENCE',
              ifExists,
              only: false,
              cmds: [{ kind: 'SET_SCHEMA', schema: this.parseName() }],
              loc,
            };
          }
          if (this.atKw('OWNER') || this.isKw(this.peek(1), 'LOGGED', 'UNLOGGED')) {
            this.skipToStatementEnd();
            return { kind: 'NoopStmt', tag: 'ALTER SEQUENCE', description: 'ALTER SEQUENCE', loc };
          }
        }
        return { kind: 'AlterSequenceStmt', sequence, ifExists, options: this.parseSequenceOptions(false), loc };
      }
      case 'TYPE':
        return this.parseAlterType(loc);
      case 'DATABASE': {
        this.next();
        const dbname = this.parseName();
        if (this.atKw('SET', 'RESET')) {
          const set = this.atKw('SET') ? (this.parseSet() as A.VariableSetStmt) : (this.parseReset() as A.VariableSetStmt);
          return { kind: 'AlterDatabaseSetStmt', dbname, set, loc };
        }
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag: 'ALTER DATABASE', description: 'ALTER DATABASE', loc };
      }
      case 'SCHEMA': {
        this.next();
        const name = this.parseName();
        if (this.acceptKw('RENAME')) {
          this.expectKw('TO');
          return { kind: 'RenameStmt', objectType: 'SCHEMA', object: [name], newname: this.parseName(), ifExists: false, loc };
        }
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag: 'ALTER SCHEMA', description: 'ALTER SCHEMA', loc };
      }
      case 'FUNCTION':
      case 'PROCEDURE':
      case 'ROUTINE':
      case 'ROLE':
      case 'USER':
      case 'EXTENSION':
      case 'DEFAULT':
      case 'POLICY':
      case 'COLLATION':
      case 'STATISTICS':
      case 'SYSTEM':
      case 'DOMAIN':
      case 'PUBLICATION':
      case 'SUBSCRIPTION':
      case 'TRIGGER':
      case 'OPERATOR':
      case 'AGGREGATE':
      case 'LARGE':
      case 'EVENT':
      case 'SERVER':
      case 'TABLESPACE':
      case 'GROUP':
      case 'LANGUAGE': {
        const tag = 'ALTER ' + t.kw;
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag, description: tag, loc };
      }
    }
    this.error();
  }

  private parseAlterType(loc: number): A.Statement {
    this.expectKw('TYPE');
    const typeName = this.parseAnyName();
    if (this.acceptKw('ADD')) {
      this.expectKw('VALUE');
      const skipIfNewValExists = this.acceptKws('IF', 'NOT', 'EXISTS');
      const v = this.next();
      if (v.type !== 'string') {
        this.error(v);
      }
      const stmt: A.AlterEnumStmt = { kind: 'AlterEnumStmt', typeName, newVal: v.value, skipIfNewValExists, loc };
      if (this.atKw('BEFORE', 'AFTER')) {
        stmt.newValIsAfter = this.next().kw === 'AFTER';
        stmt.newValNeighbor = this.next().value;
      }
      return stmt;
    }
    if (this.acceptKw('RENAME')) {
      if (this.acceptKw('VALUE')) {
        const oldVal = this.next().value;
        this.expectKw('TO');
        const newVal = this.next().value;
        return { kind: 'AlterEnumStmt', typeName, oldVal, newVal, skipIfNewValExists: false, rename: true, loc };
      }
      this.expectKw('TO');
      return { kind: 'AlterTypeStmt', typeName, action: 'RENAME', newName: this.parseName(), loc };
    }
    this.skipToStatementEnd();
    return { kind: 'AlterTypeStmt', typeName, action: 'NOOP', loc };
  }

  private parseAlterTableCmd(): A.AlterTableCmd {
    if (this.acceptKw('ADD')) {
      if (this.atKw('CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE')) {
        return { kind: 'ADD_CONSTRAINT', constraint: this.parseTableConstraint() };
      }
      this.acceptKw('COLUMN');
      const ifNotExists = this.acceptKws('IF', 'NOT', 'EXISTS');
      return { kind: 'ADD_COLUMN', def: this.parseColumnDef(false), ifNotExists };
    }
    if (this.acceptKw('DROP')) {
      if (this.acceptKw('CONSTRAINT')) {
        const ifExists = this.acceptKws('IF', 'EXISTS');
        const name = this.parseName();
        const cascade = this.acceptKw('CASCADE');
        this.acceptKw('RESTRICT');
        return { kind: 'DROP_CONSTRAINT', name, ifExists, cascade };
      }
      this.acceptKw('COLUMN');
      const ifExists = this.acceptKws('IF', 'EXISTS');
      const name = this.parseName();
      const cascade = this.acceptKw('CASCADE');
      this.acceptKw('RESTRICT');
      return { kind: 'DROP_COLUMN', name, ifExists, cascade };
    }
    if (this.acceptKw('ALTER')) {
      if (this.acceptKw('CONSTRAINT')) {
        const name = this.parseName();
        this.skipToCmdEnd();
        return { kind: 'NOOP', description: 'ALTER CONSTRAINT ' + name };
      }
      this.acceptKw('COLUMN');
      const name = this.parseName();
      if (this.acceptKws('SET', 'DATA', 'TYPE') || this.acceptKw('TYPE')) {
        const typeName = this.parseTypeName();
        const cmd: A.AlterTableCmd = { kind: 'ALTER_COLUMN_TYPE', name, typeName };
        if (this.acceptKw('COLLATE')) {
          cmd.collate = this.parseAnyName();
        }
        if (this.acceptKw('USING')) {
          const startIdx = this.pos;
          cmd.using = this.parseExpr();
          cmd.usingText = this.textFrom(startIdx);
        }
        return cmd;
      }
      if (this.acceptKws('SET', 'DEFAULT')) {
        return { kind: 'SET_DEFAULT', name, expr: this.parseExpr(4) };
      }
      if (this.acceptKws('DROP', 'DEFAULT')) {
        return { kind: 'DROP_DEFAULT', name };
      }
      if (this.acceptKws('SET', 'NOT', 'NULL')) {
        return { kind: 'SET_NOT_NULL', name };
      }
      if (this.acceptKws('DROP', 'NOT', 'NULL')) {
        return { kind: 'DROP_NOT_NULL', name };
      }
      if (this.acceptKws('DROP', 'IDENTITY')) {
        return { kind: 'DROP_IDENTITY', name, ifExists: this.acceptKws('IF', 'EXISTS') };
      }
      if (this.acceptKws('DROP', 'EXPRESSION')) {
        return { kind: 'DROP_EXPRESSION', name, ifExists: this.acceptKws('IF', 'EXISTS') };
      }
      if (this.atKw('ADD') && this.isKw(this.peek(1), 'GENERATED')) {
        this.next();
        this.next();
        const always = this.acceptKw('ALWAYS');
        if (!always) {
          this.expectKw('BY');
          this.expectKw('DEFAULT');
        }
        this.expectKw('AS');
        this.expectKw('IDENTITY');
        const seqOptions: A.SequenceOption[] = [];
        if (this.acceptPunct('(')) {
          seqOptions.push(...this.parseSequenceOptions(true));
          this.expectPunct(')');
        }
        return { kind: 'ADD_IDENTITY', name, always, seqOptions };
      }
      if (this.acceptKws('SET', 'STATISTICS')) {
        const neg = this.acceptOp('-');
        return { kind: 'SET_STATISTICS', name, value: (neg ? -1 : 1) * parseInt(this.next().value, 10) };
      }
      if (this.acceptKws('SET', 'STORAGE')) {
        return { kind: 'SET_STORAGE', name, value: this.parseName() };
      }
      if (this.acceptKws('SET', 'COMPRESSION')) {
        return { kind: 'SET_COMPRESSION', name, value: this.parseName() };
      }
      if (this.atKw('SET', 'RESET') && this.atPunct('(', 1)) {
        const reset = this.next().kw === 'RESET';
        this.next();
        const options = this.parseDefElemList();
        this.expectPunct(')');
        return { kind: 'SET_COLUMN_OPTIONS', name, options, reset };
      }
      if ((this.atKw('SET') && this.isKw(this.peek(1), 'GENERATED', 'INCREMENT', 'START', 'RESTART', 'MINVALUE', 'MAXVALUE', 'CACHE', 'CYCLE', 'NO')) || this.atKw('RESTART')) {
        const seqOptions: A.SequenceOption[] = [];
        let always: boolean | undefined;
        while (this.atKw('SET', 'RESTART')) {
          if (this.acceptKw('RESTART')) {
            if (this.acceptKw('WITH') || this.peek().type === 'integer') {
              seqOptions.push({ name: 'restart', value: this.next().value });
            } else {
              seqOptions.push({ name: 'restart', value: null });
            }
            continue;
          }
          this.next();
          if (this.acceptKw('GENERATED')) {
            always = this.acceptKw('ALWAYS');
            if (!always) {
              this.expectKw('BY');
              this.expectKw('DEFAULT');
            }
          } else {
            seqOptions.push(...this.parseSequenceOptions(false));
          }
        }
        return { kind: 'SET_IDENTITY', name, always, seqOptions };
      }
      this.error();
    }
    if (this.acceptKw('RENAME')) {
      if (this.acceptKw('TO')) {
        return { kind: 'RENAME_TABLE', newName: this.parseName() };
      }
      if (this.acceptKw('CONSTRAINT')) {
        const oldName = this.parseName();
        this.expectKw('TO');
        return { kind: 'RENAME_CONSTRAINT', oldName, newName: this.parseName() };
      }
      this.acceptKw('COLUMN');
      const oldName = this.parseName();
      this.expectKw('TO');
      return { kind: 'RENAME_COLUMN', oldName, newName: this.parseName() };
    }
    if (this.acceptKws('SET', 'SCHEMA')) {
      return { kind: 'SET_SCHEMA', schema: this.parseName() };
    }
    if (this.atKw('SET', 'RESET') && this.atPunct('(', 1)) {
      const reset = this.next().kw === 'RESET';
      this.next();
      const options = this.parseDefElemList();
      this.expectPunct(')');
      return reset ? { kind: 'RESET_OPTIONS', options } : { kind: 'SET_OPTIONS', options };
    }
    if (this.acceptKws('VALIDATE', 'CONSTRAINT')) {
      return { kind: 'VALIDATE_CONSTRAINT', name: this.parseName() };
    }
    if (this.acceptKws('ATTACH', 'PARTITION')) {
      const partition = this.parseRangeVar();
      return { kind: 'ATTACH_PARTITION', partition, bound: this.parsePartitionBound() };
    }
    if (this.acceptKws('DETACH', 'PARTITION')) {
      const partition = this.parseRangeVar();
      const concurrently = this.acceptKw('CONCURRENTLY');
      const finalize = this.acceptKw('FINALIZE');
      return { kind: 'DETACH_PARTITION', partition, concurrently, finalize };
    }
    if (this.acceptKws('OWNER', 'TO')) {
      return { kind: 'OWNER_TO', owner: this.parseName() };
    }
    if (this.acceptKws('SET', 'LOGGED')) {
      return { kind: 'SET_LOGGED', logged: true };
    }
    if (this.acceptKws('SET', 'UNLOGGED')) {
      return { kind: 'SET_LOGGED', logged: false };
    }
    if (this.atKw('ENABLE', 'DISABLE', 'FORCE', 'NO', 'REPLICA', 'CLUSTER', 'SET', 'INHERIT', 'OF', 'NOT')) {
      const startIdx = this.pos;
      this.skipToCmdEnd();
      return { kind: 'NOOP', description: this.textFrom(startIdx) };
    }
    this.error();
  }

  private skipToCmdEnd(): void {
    let depth = 0;
    while (true) {
      const t = this.peek();
      if (t.type === 'eof') {
        return;
      }
      if (t.type === 'punct') {
        if (t.value === '(') {
          depth++;
        } else if (t.value === ')') {
          depth--;
        } else if ((t.value === ',' || t.value === ';') && depth <= 0) {
          return;
        }
      }
      this.next();
    }
  }

  // -------------------------------------------------------------------------
  // DROP / TRUNCATE / COMMENT
  // -------------------------------------------------------------------------

  private parseDrop(): A.Statement {
    const loc = this.expectKw('DROP').pos;
    const t = this.next();
    let objectType: A.DropObjectType;
    switch (t.kw) {
      case 'TABLE':
      case 'INDEX':
      case 'SEQUENCE':
      case 'VIEW':
      case 'TYPE':
      case 'DOMAIN':
      case 'SCHEMA':
      case 'FUNCTION':
      case 'PROCEDURE':
      case 'ROUTINE':
      case 'AGGREGATE':
      case 'EXTENSION':
      case 'COLLATION':
      case 'STATISTICS':
      case 'TRIGGER':
      case 'POLICY':
      case 'RULE':
      case 'OPERATOR':
      case 'CAST':
      case 'SERVER':
      case 'PUBLICATION':
      case 'ROLE':
      case 'USER':
      case 'DATABASE':
        objectType = (t.kw === 'USER' ? 'ROLE' : t.kw) as A.DropObjectType;
        break;
      case 'MATERIALIZED':
        this.expectKw('VIEW');
        objectType = 'MATERIALIZED VIEW';
        break;
      case 'FOREIGN':
        this.expectKw('TABLE');
        objectType = 'FOREIGN TABLE';
        break;
      case 'OWNED':
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag: 'DROP OWNED', description: 'DROP OWNED', loc };
      default:
        this.error(t);
    }
    const concurrently = this.acceptKw('CONCURRENTLY');
    const ifExists = this.acceptKws('IF', 'EXISTS');
    const objects: A.DropStmt['objects'] = [];
    if (objectType === 'ROLE' || objectType === 'DATABASE' || objectType === 'SERVER' || objectType === 'PUBLICATION') {
      this.skipToStatementEnd();
      return { kind: 'NoopStmt', tag: 'DROP ' + objectType, description: 'DROP ' + objectType, loc };
    }
    do {
      const names = this.parseAnyName();
      const obj: A.DropStmt['objects'][0] = { names };
      if ((objectType === 'FUNCTION' || objectType === 'PROCEDURE' || objectType === 'ROUTINE' || objectType === 'AGGREGATE') && this.atPunct('(')) {
        this.next();
        obj.args = [];
        if (!this.atPunct(')')) {
          do {
            const p = this.parseDropFunctionArg();
            if (p) {
              obj.args.push(p);
            }
          } while (this.acceptPunct(','));
        }
        this.expectPunct(')');
      }
      if (objectType === 'TRIGGER' || objectType === 'POLICY' || objectType === 'RULE') {
        this.expectKw('ON');
        obj.onTable = this.parseRangeVar();
      }
      objects.push(obj);
    } while (this.acceptPunct(','));
    let cascade = false;
    if (this.acceptKw('CASCADE')) {
      cascade = true;
    } else {
      this.acceptKw('RESTRICT');
    }
    return { kind: 'DropStmt', objectType, objects, ifExists, cascade, concurrently, loc };
  }

  private parseDropFunctionArg(): A.TypeName | null {
    if (this.atKw('OUT')) {
      this.next();
      this.parseFunctionParameterTypeOnly();
      return null;
    }
    this.acceptKw('IN', 'INOUT', 'VARIADIC');
    return this.parseFunctionParameterTypeOnly();
  }

  private parseFunctionParameterTypeOnly(): A.TypeName {
    const t0 = this.peek();
    const t1 = this.peek(1);
    if (t0.type === 'ident' && t1.type === 'ident' && !this.isKw(t0, 'CHARACTER', 'CHAR', 'NATIONAL', 'BIT', 'TIMESTAMP', 'TIME', 'INTERVAL', 'DOUBLE')) {
      this.next();
    }
    return this.parseTypeName();
  }

  private parseTruncate(): A.TruncateStmt {
    const loc = this.expectKw('TRUNCATE').pos;
    this.acceptKw('TABLE');
    const relations: A.RangeVar[] = [];
    do {
      relations.push(this.parseRangeVar());
    } while (this.acceptPunct(','));
    let restartIdentity = false;
    let cascade = false;
    while (true) {
      if (this.acceptKws('RESTART', 'IDENTITY')) {
        restartIdentity = true;
      } else if (this.acceptKws('CONTINUE', 'IDENTITY')) {
        restartIdentity = false;
      } else if (this.acceptKw('CASCADE')) {
        cascade = true;
      } else if (this.acceptKw('RESTRICT')) {
        cascade = false;
      } else {
        break;
      }
    }
    return { kind: 'TruncateStmt', relations, restartIdentity, cascade, loc };
  }

  private parseComment(): A.CommentStmt {
    const loc = this.expectKw('COMMENT').pos;
    this.expectKw('ON');
    let objectType = this.next().kw;
    if (objectType === 'MATERIALIZED') {
      this.expectKw('VIEW');
      objectType = 'MATERIALIZED VIEW';
    }
    let object: string[];
    let columnTable: string[] | undefined;
    if (objectType === 'CONSTRAINT') {
      object = [this.parseName()];
      this.expectKw('ON');
      this.acceptKw('DOMAIN');
      columnTable = this.parseAnyName();
    } else if (objectType === 'FUNCTION' || objectType === 'PROCEDURE') {
      object = this.parseAnyName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.type === 'punct' && t.value === '(') {
            depth++;
          } else if (t.type === 'punct' && t.value === ')') {
            depth--;
          } else if (t.type === 'eof') {
            this.error(t);
          }
        }
      }
    } else {
      object = this.parseAnyName();
    }
    this.expectKw('IS');
    let comment: string | null = null;
    if (!this.acceptKw('NULL')) {
      const t = this.next();
      if (t.type !== 'string') {
        this.error(t);
      }
      comment = t.value;
    }
    return { kind: 'CommentStmt', objectType, object, columnTable, comment, loc };
  }

  // -------------------------------------------------------------------------
  // Transactions / session
  // -------------------------------------------------------------------------

  private parseTransactionModes(): A.TransactionStmt['options'] {
    const options: A.TransactionStmt['options'] = {};
    while (true) {
      if (this.acceptKws('ISOLATION', 'LEVEL')) {
        if (this.acceptKw('SERIALIZABLE')) {
          options.isolation = 'serializable';
        } else if (this.acceptKws('REPEATABLE', 'READ')) {
          options.isolation = 'repeatable read';
        } else if (this.acceptKws('READ', 'COMMITTED')) {
          options.isolation = 'read committed';
        } else if (this.acceptKws('READ', 'UNCOMMITTED')) {
          options.isolation = 'read uncommitted';
        } else {
          this.error();
        }
      } else if (this.acceptKws('READ', 'WRITE')) {
        options.readOnly = false;
      } else if (this.acceptKws('READ', 'ONLY')) {
        options.readOnly = true;
      } else if (this.acceptKws('NOT', 'DEFERRABLE')) {
        options.deferrable = false;
      } else if (this.acceptKw('DEFERRABLE')) {
        options.deferrable = true;
      } else {
        break;
      }
      this.acceptPunct(',');
    }
    return options;
  }

  private parseBegin(): A.TransactionStmt {
    const t = this.next();
    if (t.kw === 'START') {
      this.expectKw('TRANSACTION');
    } else {
      this.acceptKw('WORK', 'TRANSACTION');
    }
    return { kind: 'TransactionStmt', op: t.kw === 'START' ? 'START' : 'BEGIN', options: this.parseTransactionModes(), loc: t.pos };
  }

  private parseSetValue(): string | number {
    const t = this.peek();
    if (t.type === 'string') {
      this.next();
      return t.value;
    }
    if (t.type === 'integer' || t.type === 'numeric') {
      this.next();
      return t.value;
    }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const n = this.next();
      return (t.value === '-' ? '-' : '') + n.value;
    }
    if (t.type === 'ident') {
      this.next();
      let v = t.value;
      while (this.atPunct('.')) {
        this.next();
        v += '.' + this.next().value;
      }
      return v;
    }
    this.error();
  }

  parseSet(): A.Statement {
    const loc = this.expectKw('SET').pos;
    let isLocal = false;
    if (this.acceptKw('LOCAL')) {
      isLocal = true;
    } else {
      this.acceptKw('SESSION');
      if (this.atKw('CHARACTERISTICS')) {
        this.next();
        this.expectKw('AS');
        this.expectKw('TRANSACTION');
        return { kind: 'VariableSetStmt', mode: 'MULTI', name: 'SESSION CHARACTERISTICS', values: [], isLocal: false, transactionOptions: this.parseTransactionModes(), loc };
      }
      if (this.acceptKw('AUTHORIZATION')) {
        this.skipToStatementEnd();
        return { kind: 'NoopStmt', tag: 'SET', description: 'SET SESSION AUTHORIZATION', loc };
      }
    }
    if (this.acceptKw('TRANSACTION')) {
      if (this.acceptKw('SNAPSHOT')) {
        this.next();
        return { kind: 'NoopStmt', tag: 'SET', description: 'SET TRANSACTION SNAPSHOT', loc };
      }
      return { kind: 'VariableSetStmt', mode: 'MULTI', name: 'TRANSACTION', values: [], isLocal, transactionOptions: this.parseTransactionModes(), loc };
    }
    if (this.atKw('TIME') && this.isKw(this.peek(1), 'ZONE')) {
      this.next();
      this.next();
      if (this.acceptKw('LOCAL') || this.acceptKw('DEFAULT')) {
        return { kind: 'VariableSetStmt', mode: 'DEFAULT', name: 'timezone', values: [], isLocal, loc };
      }
      if (this.acceptKw('INTERVAL')) {
        const v = this.next().value;
        this.skipToStatementEnd();
        return { kind: 'VariableSetStmt', mode: 'VALUE', name: 'timezone', values: [v], isLocal, loc };
      }
      return { kind: 'VariableSetStmt', mode: 'VALUE', name: 'timezone', values: [this.parseSetValue()], isLocal, loc };
    }
    if (this.acceptKw('SCHEMA')) {
      return { kind: 'VariableSetStmt', mode: 'VALUE', name: 'search_path', values: [this.parseSetValue()], isLocal, loc };
    }
    if (this.acceptKw('NAMES')) {
      const values = this.atPunct(';') || this.peek().type === 'eof' ? [] : [this.parseSetValue()];
      return { kind: 'VariableSetStmt', mode: 'VALUE', name: 'client_encoding', values, isLocal, loc };
    }
    if (this.acceptKw('ROLE')) {
      this.skipToStatementEnd();
      return { kind: 'NoopStmt', tag: 'SET', description: 'SET ROLE', loc };
    }
    if (this.acceptKw('CONSTRAINTS')) {
      const all = this.acceptKw('ALL');
      const names: string[][] = [];
      if (!all) {
        do {
          names.push(this.parseAnyName());
        } while (this.acceptPunct(','));
      }
      const deferred = this.expectKw('DEFERRED', 'IMMEDIATE').kw === 'DEFERRED';
      return { kind: 'NoopStmt', tag: 'SET CONSTRAINTS', description: 'SET CONSTRAINTS', setConstraints: { all, names, deferred }, loc };
    }
    let name = this.parseName();
    while (this.acceptPunct('.')) {
      name += '.' + this.parseName();
    }
    if (!this.acceptKw('TO')) {
      if (!this.acceptOp('=')) {
        this.error();
      }
    }
    if (this.acceptKw('DEFAULT')) {
      return { kind: 'VariableSetStmt', mode: 'DEFAULT', name, values: [], isLocal, loc };
    }
    const values: (string | number)[] = [];
    do {
      values.push(this.parseSetValue());
    } while (this.acceptPunct(','));
    return { kind: 'VariableSetStmt', mode: 'VALUE', name, values, isLocal, loc };
  }

  parseReset(): A.Statement {
    const loc = this.expectKw('RESET').pos;
    if (this.acceptKw('ALL')) {
      return { kind: 'VariableSetStmt', mode: 'RESET_ALL', name: '', values: [], isLocal: false, loc };
    }
    if (this.atKw('TIME') && this.isKw(this.peek(1), 'ZONE')) {
      this.next();
      this.next();
      return { kind: 'VariableSetStmt', mode: 'RESET', name: 'timezone', values: [], isLocal: false, loc };
    }
    if (this.acceptKws('SESSION', 'AUTHORIZATION')) {
      return { kind: 'NoopStmt', tag: 'RESET', description: 'RESET SESSION AUTHORIZATION', loc };
    }
    let name = this.parseName();
    while (this.acceptPunct('.')) {
      name += '.' + this.parseName();
    }
    return { kind: 'VariableSetStmt', mode: 'RESET', name, values: [], isLocal: false, loc };
  }

  private parseShow(): A.VariableShowStmt {
    const loc = this.expectKw('SHOW').pos;
    if (this.atKw('TIME') && this.isKw(this.peek(1), 'ZONE')) {
      this.next();
      this.next();
      return { kind: 'VariableShowStmt', name: 'timezone', loc };
    }
    if (this.acceptKws('TRANSACTION', 'ISOLATION', 'LEVEL')) {
      return { kind: 'VariableShowStmt', name: 'transaction_isolation', loc };
    }
    if (this.acceptKws('SESSION', 'AUTHORIZATION')) {
      return { kind: 'VariableShowStmt', name: 'session_authorization', loc };
    }
    if (this.acceptKw('ALL')) {
      return { kind: 'VariableShowStmt', name: 'all', loc };
    }
    let name = this.parseName();
    while (this.acceptPunct('.')) {
      name += '.' + this.parseName();
    }
    return { kind: 'VariableShowStmt', name, loc };
  }

  private parseDo(): A.DoStmt {
    const loc = this.expectKw('DO').pos;
    let language = 'plpgsql';
    if (this.acceptKw('LANGUAGE')) {
      language = this.parseName();
    }
    const t = this.next();
    if (t.type !== 'string') {
      this.error(t);
    }
    if (this.acceptKw('LANGUAGE')) {
      language = this.parseName();
    }
    return { kind: 'DoStmt', body: t.value, language, loc };
  }

  private parseExplain(): A.ExplainStmt {
    const loc = this.expectKw('EXPLAIN').pos;
    const options: A.DefElem[] = [];
    if (this.atPunct('(')) {
      this.next();
      do {
        const name = this.parseName();
        const el: A.DefElem = { name };
        if (!this.atPunct(',') && !this.atPunct(')')) {
          el.value = this.parseDefArg();
        }
        options.push(el);
      } while (this.acceptPunct(','));
      this.expectPunct(')');
    } else {
      if (this.acceptKw('ANALYZE', 'ANALYSE')) {
        options.push({ name: 'analyze', value: true });
      }
      if (this.acceptKw('VERBOSE')) {
        options.push({ name: 'verbose', value: true });
      }
    }
    const query = this.atKw('CREATE', 'EXECUTE', 'DECLARE') ? this.parseStatement() : this.parsePreparableStatement();
    return { kind: 'ExplainStmt', query, options, loc };
  }

  private parseLock(): A.LockStmt {
    const loc = this.expectKw('LOCK').pos;
    this.acceptKw('TABLE');
    const relations: A.RangeVar[] = [];
    do {
      relations.push(this.parseRangeVar());
    } while (this.acceptPunct(','));
    let mode = 'ACCESS EXCLUSIVE';
    if (this.acceptKw('IN')) {
      const words: string[] = [];
      while (!this.atKw('MODE')) {
        words.push(this.next().kw);
      }
      this.expectKw('MODE');
      mode = words.join(' ');
    }
    const nowait = this.acceptKw('NOWAIT');
    return { kind: 'LockStmt', relations, mode, nowait, loc };
  }

  private parsePrepare(): A.PrepareStmt {
    const loc = this.expectKw('PREPARE').pos;
    const name = this.parseName();
    const argTypes: A.TypeName[] = [];
    if (this.acceptPunct('(')) {
      do {
        argTypes.push(this.parseTypeName());
      } while (this.acceptPunct(','));
      this.expectPunct(')');
    }
    this.expectKw('AS');
    return { kind: 'PrepareStmt', name, argTypes, query: this.parsePreparableStatement(), loc };
  }
}

export function parseSql(sql: string): A.ParsedStatement[] {
  return new SqlParser(sql).parseStatements();
}

/** Parse a standalone expression (defaults, plpgsql expressions). */
export function parseExpression(sql: string): A.Expr {
  const parser = new SqlParser(sql);
  const e = parser.parseExpr();
  if (parser.peek().type !== 'eof') {
    parser.error();
  }
  return e;
}

export function assertNever(x: never): never {
  throw syntaxError('unexpected node ' + JSON.stringify(x));
}
