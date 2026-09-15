/**
 * SQL-level prepared statements (commands/prepare.c): EXECUTE, EXPLAIN EXECUTE and CREATE TABLE AS
 * EXECUTE run a statement prepared by PREPARE — or by a protocol-level Parse, which shares the namespace.
 */
import * as A from '../ast';
import { transformExpr } from '../analyze/expr';
import { exprLocation, positioned } from '../analyze/location';
import { emptyQuery } from '../analyze/nodes';
import { ParseState } from '../analyze/parse-state';
import { PgError, SqlState } from '../errors';
import { Executor } from '../exec/executor';
import { EvalCtx, StatementState } from '../exec/runtime';
import { SessionHost } from '../session';
import type { Session } from '../session';
import type { UndoLog } from '../storage/mvcc';

export interface ResolvedPreparedStatement {
  /** null for a protocol-level statement of an empty query string */
  stmt: A.Statement | null;
  text: string;
  paramTypes: number[];
  /** column types of the rows the statement returns, null when it returns none */
  resultTypes: number[] | null;
}

/** FetchPreparedStatement */
export function fetchPreparedStatement(session: Session, name: string): ResolvedPreparedStatement {
  const prep = session.preparedStatements.get(name);
  if (!prep) {
    throw new PgError(SqlState.INVALID_SQL_STATEMENT_NAME, `prepared statement "${name}" does not exist`);
  }
  if (prep.info) {
    return { stmt: prep.info.ps?.stmt ?? null, text: prep.text, paramTypes: prep.info.paramTypes, resultTypes: prep.info.fields ? prep.info.fields.map((f) => f.typeOid) : null };
  }
  return { stmt: prep.stmt ?? null, text: prep.text, paramTypes: prep.argTypes, resultTypes: prep.resultTypes.length ? prep.resultTypes : null };
}

/**
 * EvaluateParams: the EXECUTE arguments are transformed, coerced (assignment) to the prepared parameter
 * types and evaluated. `$n` inside them refer to the parameters of the statement running EXECUTE.
 */
export function evaluateExecuteParams(
  session: Session,
  stmt: A.ExecuteStmt,
  prepared: ResolvedPreparedStatement,
  outerParams: unknown[],
  outerTypes: number[] | undefined,
  parentSt: StatementState | null,
  undo: UndoLog | null
): unknown[] {
  const expected = prepared.paramTypes;
  if (stmt.params.length !== expected.length) {
    throw new PgError(SqlState.SYNTAX_ERROR, `wrong number of parameters for prepared statement "${stmt.name}"`, {
      detail: `Expected ${expected.length} parameters but got ${stmt.params.length}.`,
    });
  }
  if (expected.length === 0) {
    return [];
  }
  const an = session.makeAnalyzer(parentSt ? parentSt.paramTypes.slice() : (outerTypes ?? []).slice(), !!parentSt || !!outerTypes);
  if (parentSt) {
    an.paramNames = parentSt.paramNames;
    an.paramFunctionName = parentSt.functionName;
  }
  const pstate = new ParseState(null, emptyQuery());
  const exprs = stmt.params.map((raw, i) => {
    const expr = transformExpr(an, pstate, raw, 'execute_parameter');
    const coerced = an.coerceToTargetType(expr, expected[i], -1, 'assignment', 'implicit_cast');
    if (!coerced) {
      throw positioned(
        new PgError(SqlState.DATATYPE_MISMATCH, `parameter $${i + 1} of type ${an.types.formatType(expr.type, -1, false)} cannot be coerced to the expected type ${an.types.formatType(expected[i], -1, false)}`, {
          hint: 'You will need to rewrite or cast the expression.',
        }),
        exprLocation(expr)
      );
    }
    return coerced;
  });
  const st = new StatementState(session, session.catalog(), parentSt ? parentSt.params : outerParams, an.paramTypes, session.takeSnapshot());
  st.undo = undo ?? parentSt?.undo ?? null;
  const host = new SessionHost(session, st);
  const executor = new Executor(st, host);
  host.executor = executor;
  const plan = executor.planFor(pstate.query, null);
  return exprs.map((e) => plan.ev(e)(new EvalCtx([], null, st)));
}

/** GetCachedPlan for a statement that is planned but not run through executeParsedSync (EXPLAIN, CREATE TABLE AS). */
export function revalidatePrepared(session: Session, prepared: ResolvedPreparedStatement): void {
  const k = prepared.stmt?.kind;
  if (k === 'SelectStmt' || k === 'InsertStmt' || k === 'UpdateStmt' || k === 'DeleteStmt' || k === 'MergeStmt') {
    const { fields } = session.describePreparable(prepared.stmt!, prepared.paramTypes);
    checkResultTypes(prepared, fields ? fields.map((f) => f.typeOid) : null);
  }
}

/** A re-analyzed statement whose result columns changed type (RevalidateCachedQuery). */
export function checkResultTypes(prepared: ResolvedPreparedStatement, types: number[] | null): void {
  const a = prepared.resultTypes;
  const same = (a === null && types === null) || (!!a && !!types && a.length === types.length && a.every((t, i) => t === types[i]));
  if (!same) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'cached plan must not change result type');
  }
}
