import type { TableSchema } from '../schema/table-builder';
import type { SqlBuildContext } from '../query/conditions';
import { Placeholder } from '../query/conditions';
import { materializeMockSelection } from '../query/query-builder';
import { toPgArrayLiteral } from '../types/custom-types';

/**
 * Renders a model-managed VIEW declared with a linkgress query (`view.definedAs(db => query)`)
 * into the SQL that `CREATE VIEW … AS` receives. The same SQL feeds the view's marker, so the
 * rendering is deterministic: the same model always yields the same text.
 *
 * - The query is built through `asSubquery('table')` — every linkgress query shape has it — on a
 *   context that pins native array aggregation, so the text does not depend on the driver.
 * - The projection is wrapped in an outer SELECT that renames each projected key to its view
 *   property's column name, in declaration order: the view's columns are exactly the declared ones.
 * - The query's bound values are inlined as literals. A view cannot carry parameters, and a
 *   quoted, untyped literal resolves its type from context exactly like an untyped `$n` does.
 */

interface ViewColumn {
  property: string;
  column: string;
}

interface ViewSubquery {
  buildSql(context: SqlBuildContext): string;
  getSelectionMetadata(): Record<string, unknown> | undefined;
}

/** The SQL of a registry entry that is a view: its raw definition, or its query rendered against `db`. */
export function renderViewDefinition(schema: TableSchema, db: unknown): string {
  const view = schema.view;

  if (view == null) {
    throw new Error(`${schema.name} is not a view`);
  }

  if (view.definition != null) {
    return view.definition;
  }

  const name = schema.schema ? `${schema.schema}.${schema.name}` : schema.name;
  const columns = [...(schema.columnNameMap ?? new Map<string, string>())].map(([property, column]) => ({ property, column }));

  return renderViewQuery(name, columns, view.query!(db));
}

function renderViewQuery(viewName: string, columns: ViewColumn[], source: unknown): string {
  if (source == null || typeof (source as { asSubquery?: unknown }).asSubquery !== 'function') {
    throw new Error(
      `View ${viewName}: definedAs(db => …) must return a linkgress query ending in select(…), got ${describe(source)}`,
    );
  }

  const subquery = (source as { asSubquery(mode: 'table'): ViewSubquery }).asSubquery('table');
  const selection = subquery.getSelectionMetadata();

  if (selection != null) {
    checkProjection(viewName, columns, materializeMockSelection(selection));
  }

  const context: SqlBuildContext = { paramCounter: 1, params: [], useJsonArrayAggregation: false };
  const inner = subquery.buildSql(context);
  const selectList = columns.map(c => `"q".${quoteIdentifier(c.property)} AS ${quoteIdentifier(c.column)}`).join(', ');

  return `SELECT ${selectList} FROM (${inlineViewParameters(inner, context.params, viewName)}) AS "q"`;
}

function checkProjection(viewName: string, columns: ViewColumn[], selection: Record<string, unknown>): void {
  const keys = Object.keys(selection);
  const properties = columns.map(c => c.property);
  const missing = properties.filter(property => !keys.includes(property));

  if (missing.length > 0) {
    throw new Error(
      `View ${viewName}: the query does not project ${missing.join(', ')} — every view property needs a key of the same name in select(…) (it projects ${keys.join(', ') || 'nothing'})`,
    );
  }

  const extra = keys.filter(key => !properties.includes(key));

  if (extra.length > 0) {
    throw new Error(
      `View ${viewName}: the query projects ${extra.join(', ')}, which the view does not declare — add view.property(…) for it or leave it out of select(…)`,
    );
  }

  const nested = keys.filter(key => isNestedProjection(selection[key]));

  if (nested.length > 0) {
    throw new Error(`View ${viewName}: ${nested.join(', ')} is a nested object in select(…) — a view's columns are flat`);
  }
}

/**
 * A projection value the query would flatten into several `__nested__…` columns: a plain object
 * or a whole navigation row. Columns, SQL fragments, aggregates, subqueries and collection
 * results are single columns.
 */
function isNestedProjection(value: unknown): boolean {
  if (value == null || typeof value !== 'object') {
    return false;
  }

  if ('__fieldName' in value || '__collectionResult' in value || '__isAggregationArray' in value) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  // A navigation row inherits its columns and materializes into a new plain object.
  return proto === Object.prototype || proto === null || materializeMockSelection(value) !== value;
}

/**
 * Replaces every `$n` placeholder of `text` with the literal of `params[n - 1]` — outside
 * quoted strings, quoted identifiers, dollar-quoted bodies and comments, which are copied as-is.
 */
export function inlineViewParameters(text: string, params: readonly unknown[], viewName = 'view'): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\'') {
      const escapes = (text[i - 1] === 'E' || text[i - 1] === 'e') && !isIdentifierChar(text[i - 2]);
      let j = i + 1;

      while (j < text.length) {
        if (escapes && text[j] === '\\') {
          j += 2;
          continue;
        }

        if (text[j] === '\'') {
          if (text[j + 1] === '\'') {
            j += 2;
            continue;
          }

          break;
        }

        j++;
      }

      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;

      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }

          break;
        }

        j++;
      }

      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;

      out += text.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      let j = i + 2;

      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }

      out += text.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '$' && !isIdentifierChar(text[i - 1])) {
      const placeholder = /^\$(\d+)/.exec(text.slice(i, i + 12));

      if (placeholder) {
        const index = Number(placeholder[1]);

        if (index < 1 || index > params.length) {
          throw new Error(`View ${viewName}: the query references $${index} but binds ${params.length} value(s)`);
        }

        out += toViewLiteral(params[index - 1]);
        i += placeholder[0].length;
        continue;
      }

      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z_0-9\u0080-￿]*)?\$/.exec(text.slice(i));

      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? text.length : close + tag[0].length;

        out += text.slice(i, end);
        i = end;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * The SQL literal of one bound value, as the driver would have sent it: text in a quoted,
 * untyped literal (so PostgreSQL resolves its type from context), `NULL` for null.
 */
export function toViewLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (value instanceof Placeholder) {
    throw new Error(`a view cannot use sql.placeholder("${value.name}") — its SQL has no parameters`);
  }

  switch (typeof value) {
    case 'string':
      return quoteString(value);
    case 'number':
      return quoteString(Number.isFinite(value) ? String(value) : Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity');
    case 'bigint':
      return quoteString(value.toString());
    case 'boolean':
      return value ? '\'true\'' : '\'false\'';
    case 'object': {
      if (value instanceof Date) {
        return quoteString(value.toISOString());
      }

      if (value instanceof Uint8Array) {
        return quoteString(`\\x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`);
      }

      if (Array.isArray(value)) {
        return quoteString(toPgArrayLiteral(value));
      }

      const proto = Object.getPrototypeOf(value);

      // A plain object is JSON (jsonb); a value class (Temporal, decimals, …) prints its SQL text.
      return quoteString(proto === Object.prototype || proto === null ? JSON.stringify(value) : String(value));
    }
    default:
      throw new Error(`cannot inline a ${typeof value} into a view`);
  }
}

/** `'…'` with doubled quotes; an `E'…'` string (doubled backslashes) when the text has a backslash. */
function quoteString(text: string): string {
  const quoted = text.replace(/'/g, '\'\'');

  return text.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_$\u0080-￿]/.test(ch);
}

function describe(value: unknown): string {
  if (value == null) {
    return String(value);
  }

  if (typeof value === 'string') {
    return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)} (use definedAs(sql) for SQL text)`;
  }

  return typeof value === 'object' ? `a ${value.constructor?.name ?? 'object'}` : `a ${typeof value}`;
}
