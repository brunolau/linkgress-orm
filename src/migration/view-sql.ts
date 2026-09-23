import { createHash } from 'crypto';
import { TableSchema } from '../schema/table-builder';

/**
 * Shared SQL for model-managed views (`model.view()`), used by the live
 * migrator (`DbSchemaManager`) and the file scaffold (`MigrationScaffold`) so
 * both emit identical statements.
 *
 * Reconciliation is by a MARKER, not by text: PostgreSQL stores a view's query
 * in its own normalized form (`pg_get_viewdef`), far from the author's
 * spelling, so the manager stamps `COMMENT ON VIEW … IS '<marker>'` with a hash
 * of the model's definition and compares that.
 */

/** Minimal view shape needed to render SQL. */
export interface ViewSqlSpec {
  name: string;
  schema?: string;
  /** The SELECT after `CREATE VIEW … AS`. */
  definition: string;
}

const MARKER_PREFIX = 'linkgress:view:sha256:';

/** The definition as it is executed and hashed: trimmed, without a trailing `;`. */
export function normalizeViewDefinition(definition: string): string {
  return definition.trim().replace(/;\s*$/, '').trim();
}

/** The `COMMENT ON VIEW` marker the manager compares to detect a changed definition. */
export function viewMarker(definition: string): string {
  return `${MARKER_PREFIX}${createHash('sha256').update(normalizeViewDefinition(definition)).digest('hex')}`;
}

export function qualifiedViewName(spec: { name: string; schema?: string }): string {
  return spec.schema ? `"${spec.schema}"."${spec.name}"` : `"${spec.name}"`;
}

/** `CREATE VIEW` + its marker comment, preceded by the view's schema when it names one. */
export function buildCreateViewStatements(spec: ViewSqlSpec): string[] {
  const name = qualifiedViewName(spec);
  return [
    ...(spec.schema ? [`CREATE SCHEMA IF NOT EXISTS "${spec.schema}"`] : []),
    `CREATE VIEW ${name} AS ${normalizeViewDefinition(spec.definition)}`,
    `COMMENT ON VIEW ${name} IS '${viewMarker(spec.definition)}'`,
  ];
}

export function buildDropViewStatement(spec: { name: string; schema?: string }, opts?: { cascade?: boolean }): string {
  return `DROP VIEW IF EXISTS ${qualifiedViewName(spec)}${opts?.cascade ? ' CASCADE' : ''}`;
}

/** The SQL of a raw-SQL view; a query-defined one needs its context (`renderViewDefinition`). */
const rawViewDefinition = (schema: TableSchema): string => {
  if (schema.view?.definition == null) {
    throw new Error(`View ${schema.name} is defined by a query — render it through its DbContext (getSchemaManager())`);
  }
  return schema.view.definition;
};

/**
 * Split a context's schema registry into its TABLES — for every table loop of
 * the schema manager — and its model-managed VIEWS, in declaration order, each
 * with its SQL from `render` (the context renders query-defined views).
 */
export function splitViewsFromRegistry(
  registry: Map<string, TableSchema>,
  render: (schema: TableSchema) => string = rawViewDefinition,
): { tables: Map<string, TableSchema>; views: ViewSqlSpec[] } {
  const tables = new Map<string, TableSchema>();
  const views: ViewSqlSpec[] = [];
  for (const [key, schema] of registry) {
    if (schema.view != null) {
      views.push({ name: schema.name, schema: schema.schema, definition: render(schema) });
    } else {
      tables.set(key, schema);
    }
  }
  return { tables, views };
}
