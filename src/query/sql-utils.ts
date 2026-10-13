import type { TableSchema } from '../schema/table-builder';

/**
 * Quoted SQL segments (single-quoted literals with '' escaping, double-quoted
 * identifiers with "" escaping) and COMMENTS (`--` line comments and
 * slash-star block comments) pass through verbatim; only bare $N placeholders
 * outside them are renumbered. Without this, a leg at a nonzero offset would
 * corrupt dollar-digit sequences INSIDE string literals
 * (`'price: $1'` → `'price: $8'`) or inside comments.
 *
 * Comments MUST be a recognized token class of their own: an apostrophe inside
 * a `--` comment (`-- the user's own orders`) otherwise opens what the
 * string-literal arm believes is a literal, which then runs to the NEXT
 * apostrophe anywhere later in the statement — swallowing every real
 * placeholder in between verbatim (unrenumbered). In a MutationBatch that
 * manifests as the spliced fragment's `$N` keeping its standalone numbers,
 * colliding with the preceding legs' bindings (`operator does not exist:
 * integer = jsonb` against a leg's jsonb payload param) and decomposing the
 * whole fused batch. `$N` sequences inside comments are likewise left alone —
 * they are prose, not parameters.
 *
 * Shared by QueryBatch, MutationBatch and insertWithChildren for cross-leg
 * parameter renumbering.
 */
const QUOTED_OR_PLACEHOLDER = /('(?:[^']|'')*')|("(?:[^"]|"")*")|(--[^\n]*)|(\/\*[\s\S]*?\*\/)|\$(?<digits>\d+)/g;

const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;

/**
 * Where the quoted segment opened by the quote at `open` ends — what QUOTED_OR_PLACEHOLDER's `'…'` / `"…"`
 * arm matches there: its content is any text in which the quote only appears doubled, and the match is the
 * LONGEST such segment closed by a quote (the regex is greedy and backtracks: `'a''` is `'a'`, followed by a
 * new quote). -1 when no quote closes it — the arm does not match, and the quote is plain text.
 */
const quotedSegmentEnd = (sqlText: string, open: number, quote: string): number => {
  let lastClose = -1;
  let from = open + 1;

  for (;;) {
    const at = sqlText.indexOf(quote, from);

    if (at < 0) {
      return lastClose;
    }

    if (sqlText[at + 1] !== quote) {
      return at;
    }

    // A doubled quote: part of the content — or, if nothing closes the segment later, its closing quote
    lastClose = at;
    from = at + 2;
  }
};

/**
 * `sqlText` with every bare `$N` renumbered to `$(N + offset)` — exactly what replacing QUOTED_OR_PLACEHOLDER's
 * matches does (see above), without running a callback for every quoted identifier of the statement: the
 * scan jumps from one token start (`'`, `"`, `--`, `/*`, `$`) to the next and copies the text between.
 */
export const renumberPlaceholders = (sqlText: string, offset: number): string => {
  const length = sqlText.length;
  let out = '';
  let copied = 0;
  let at = 0;

  while (at < length) {
    const code = sqlText.charCodeAt(at);

    if (code === 39 || code === 34) {
      // '…' or "…": verbatim — an unclosed quote is plain text
      const end = quotedSegmentEnd(sqlText, at, code === 39 ? '\'' : '"');
      at = end < 0 ? at + 1 : end + 1;
    } else if (code === 45 && sqlText.charCodeAt(at + 1) === 45) {
      // -- comment, up to (not including) the end of its line
      const newline = sqlText.indexOf('\n', at + 2);
      at = newline < 0 ? length : newline;
    } else if (code === 47 && sqlText.charCodeAt(at + 1) === 42) {
      // /* comment */ — an unclosed one is plain text
      const close = sqlText.indexOf('*/', at + 2);
      at = close < 0 ? at + 1 : close + 2;
    } else if (code === 36 && isDigitCode(sqlText.charCodeAt(at + 1))) {
      let end = at + 2;

      while (end < length && isDigitCode(sqlText.charCodeAt(end))) {
        end++;
      }

      out += `${sqlText.slice(copied, at)}$${Number(sqlText.slice(at + 1, end)) + offset}`;
      copied = end;
      at = end;
    } else {
      at++;
    }
  }

  return copied === 0 ? sqlText : out + sqlText.slice(copied);
};

/**
 * True when the SQL fragment contains a bare `$N` placeholder OUTSIDE quoted
 * segments and comments — i.e. one {@link renumberPlaceholders} would rebind.
 * Same quote/comment-aware scan, so `'literal $1 inside quotes'` and a `$1`
 * sitting in a `--` comment stay invisible.
 *
 * Reads the regex's NAMED `digits` group rather than a positional index: the
 * token classes of QUOTED_OR_PLACEHOLDER have grown before (comments were
 * added after the literals), and a positional check silently points at the
 * wrong group when that happens.
 */
export const hasBarePlaceholder = (sqlText: string): boolean => {
  for (const match of sqlText.matchAll(QUOTED_OR_PLACEHOLDER)) {
    if (match.groups?.digits !== undefined) {
      return true;
    }
  }

  return false;
};

/**
 * Column configuration extracted from schema
 */
export interface ColumnConfig {
  propName: string;
  dbName: string;
  mapper?: {
    toDriver: (value: any) => any;
    fromDriver: (value: any) => any;
  };
  primaryKey?: boolean;
  autoIncrement?: boolean;
}

/**
 * Result from building VALUES clause
 */
export interface ValuesClauseResult {
  valueClauses: string[];
  params: any[];
  nextParamIndex: number;
}

/**
 * Get qualified table name with schema prefix if specified
 */
export function getQualifiedTableName(schema: TableSchema): string {
  return schema.schema
    ? `"${schema.schema}"."${schema.name}"`
    : `"${schema.name}"`;
}

/**
 * Build RETURNING column list from schema
 */
export function buildReturningColumnList(schema: TableSchema): string {
  return Object.entries(schema.columns)
    .map(([_, col]) => `"${(col as any).build().name}"`)
    .join(', ');
}

/**
 * Build column names list from property keys
 */
export function buildColumnNamesList(schema: TableSchema, columnKeys: string[]): string[] {
  return columnKeys.map(key => {
    const column = schema.columns[key];
    const config = column.build();
    return `"${config.name}"`;
  });
}

/**
 * Apply mapper and get value for database
 */
export function applyToDriverMapper(value: any, config: ColumnConfig): any {
  const normalizedValue = value !== undefined ? value : null;
  return config.mapper
    ? config.mapper.toDriver(normalizedValue)
    : normalizedValue;
}

/**
 * Apply fromDriver mapper on query result
 */
export function applyFromDriverMapper(value: any, config: ColumnConfig): any {
  return config.mapper
    ? config.mapper.fromDriver(value)
    : value;
}

/**
 * Detect primary keys from schema
 */
export function detectPrimaryKeys(schema: TableSchema): string[] {
  const primaryKeys: string[] = [];
  for (const [key, colBuilder] of Object.entries(schema.columns)) {
    const colConfig = (colBuilder as any).build();
    if (colConfig.primaryKey) {
      primaryKeys.push(key);
    }
  }
  return primaryKeys;
}

/**
 * Check if schema has auto-increment primary key with provided data
 */
export function hasAutoIncrementPrimaryKey(schema: TableSchema, dataKeys: string[]): boolean {
  for (const key of dataKeys) {
    const column = schema.columns[key];
    if (column) {
      const colConfig = (column as any).build();
      if (colConfig.primaryKey && colConfig.autoIncrement) {
        return true;
      }
    }
  }
  return false;
}

/**
 * PostgreSQL maximum parameter limit
 */
export const POSTGRES_MAX_PARAMS = 65535;

/**
 * The most parameters one statement binds through `client`: PostgreSQL's 65 535 — or the client's own limit, when
 * lower (`DatabaseClient.maxParameters()`; postgres.js: 65 533, PGlite: 32 767).
 */
export function clientParameterLimit(client: { maxParameters?: () => number } | null | undefined): number {
  return Math.min(POSTGRES_MAX_PARAMS, typeof client?.maxParameters === 'function' ? client.maxParameters() : POSTGRES_MAX_PARAMS);
}

/** A parameter limit as the refusals name it: "PostgreSQL's 65 535", or "the 32 767 this client takes". */
export function parameterLimitText(limit: number): string {
  return limit === POSTGRES_MAX_PARAMS
    ? "PostgreSQL's 65 535"
    : `the ${limit.toLocaleString('en-US').replace(/,/g, ' ')} this client takes`;
}

/**
 * The columns a bulk write's rows bind: every key, over ALL the rows, that names a column of `schema` (with no schema,
 * every key). The chunkers size their chunks by it. They used to read the keys of the FIRST row, which miss a column
 * only later rows carry — a first row of one key before rows of five sent five parameters a row in chunks sized for
 * one — and count the keys that bind nothing (a navigation, a property of the caller's).
 */
export function boundColumnCount(
  rows: ReadonlyArray<Record<string, unknown>>,
  schema?: { columns: Record<string, unknown> }
): number {
  const keys = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (schema === undefined || Object.prototype.hasOwnProperty.call(schema.columns, key)) {
        keys.add(key);
      }
    }
  }

  return Math.max(1, keys.size);
}

/** The parameters `row`'s `sql`-fragment cells bind beyond the one a plain cell binds (each column once). */
function fragmentCellExtraParameters(row: Record<string, unknown>, schema?: { columns: Record<string, unknown> }): number {
  let extra = 0;

  for (const key of Object.keys(row)) {
    const value = row[key];

    if (isSqlExpression(value) && (schema === undefined || Object.prototype.hasOwnProperty.call(schema.columns, key))) {
      const context = { paramCounter: 1, params: [] as any[] };

      value.buildSql(context);
      extra += context.params.length - 1;
    }
  }

  return extra;
}

/**
 * The statements a bulk write of `rows` sends, in order: at most `maxRows` rows each. With a `budget` (the automatic
 * chunk size — an explicit `chunkSize` is the caller's and is never re-cut) a statement also closes before a row would
 * take it past `budget.parameters`: a row binds one parameter per column, and a cell holding an `sql` fragment the
 * fragment's own parameters instead of one. Rows without such a cell cut exactly at `maxRows`.
 */
export function chunkBulkRows<TRow extends Record<string, any>>(
  rows: readonly TRow[],
  maxRows: number,
  budget?: { columnCount: number; parameters: number; schema?: { columns: Record<string, unknown> } }
): TRow[][] {
  const chunks: TRow[][] = [];
  const extras = budget === undefined ? undefined : rows.map(row => fragmentCellExtraParameters(row, budget.schema));

  if (extras === undefined || extras.every(extra => extra === 0)) {
    for (let i = 0; i < rows.length; i += maxRows) {
      chunks.push(rows.slice(i, i + maxRows));
    }

    return chunks;
  }

  let current: TRow[] = [];
  let parameters = 0;

  rows.forEach((row, index) => {
    const weight = budget!.columnCount + extras[index];

    if (current.length > 0 && (current.length >= maxRows || parameters + weight > budget!.parameters)) {
      chunks.push(current);
      current = [];
      parameters = 0;
    }

    current.push(row);
    parameters += weight;
  });

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * The chunks of a bulk write, the way every chunker sizes them: rows per statement by {@link calculateOptimalChunkSize}
 * of the columns the rows bind ({@link boundColumnCount}) within the client's limit, or `configChunkSize` as given;
 * with the automatic size, a statement also stays within the parameters such a chunk of plain cells binds
 * ({@link chunkBulkRows}).
 */
export function bulkWriteChunks<TRow extends Record<string, any>>(
  rows: readonly TRow[],
  schema: { columns: Record<string, unknown> },
  client: { maxParameters?: () => number } | null | undefined,
  configChunkSize?: number
): TRow[][] {
  const columnCount = boundColumnCount(rows, schema);
  const maxRows = calculateOptimalChunkSize(columnCount, configChunkSize, clientParameterLimit(client));

  return chunkBulkRows(rows, maxRows, configChunkSize != null ? undefined : { columnCount, parameters: maxRows * columnCount, schema });
}

/**
 * Calculate optimal chunk size for bulk operations: `configChunkSize` when given; otherwise 60 % of the rows of
 * `columnCount` columns PostgreSQL's 65 535 parameters take — and never more rows than `maxParameters` take, on a
 * client whose limit is lower (see {@link clientParameterLimit}; PGlite: 32 767).
 */
export function calculateOptimalChunkSize(
  columnCount: number,
  configChunkSize?: number,
  maxParameters: number = POSTGRES_MAX_PARAMS
): number {
  if (configChunkSize != null) {
    return configChunkSize;
  }
  const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
  const chunkSize = Math.floor(maxRowsPerBatch * 0.6); // Use 60% of max to be safe

  return maxParameters < POSTGRES_MAX_PARAMS
    ? Math.min(chunkSize, Math.max(1, Math.floor(maxParameters / columnCount)))
    : chunkSize;
}

/**
 * Build column configs from schema for given data keys
 */
export function buildColumnConfigs(
  schema: TableSchema,
  dataKeys: string[],
  includeAutoIncrement: boolean = false
): ColumnConfig[] {
  const configs: ColumnConfig[] = [];

  for (const propName of dataKeys) {
    const column = schema.columns[propName];
    if (column) {
      const config = column.build();
      if (!config.autoIncrement || includeAutoIncrement) {
        configs.push({
          propName,
          dbName: config.name,
          mapper: config.mapper,
          primaryKey: config.primaryKey,
          autoIncrement: config.autoIncrement,
        });
      }
    }
  }

  return configs;
}

/**
 * Extract unique column keys from array of data objects
 * A column is included if ANY row has a non-undefined value for it.
 * Columns with defaults are only skipped if ALL rows have undefined for that column.
 */
export function extractUniqueColumnKeys(
  dataArray: Record<string, any>[],
  schema: TableSchema,
  includeAutoIncrement: boolean = false
): string[] {
  const columnSet = new Set<string>();

  // First, collect all column keys that appear in any data object
  const allKeys = new Set<string>();
  for (const data of dataArray) {
    for (const key of Object.keys(data)) {
      allKeys.add(key);
    }
  }

  // Then determine which columns to include
  for (const key of allKeys) {
    const column = schema.columns[key];
    if (!column) {
      continue;
    }

    const config = column.build();
    // Skip auto-increment columns (unless explicitly including them)
    if (config.autoIncrement && !includeAutoIncrement) {
      continue;
    }

    // Check if any row has a defined (non-undefined) value for this column
    const hasDefinedValue = dataArray.some(data => data[key] !== undefined);

    // If column has a default and ALL rows have undefined, skip it (let DB use default)
    if (!hasDefinedValue && (config.default !== undefined || config.identity)) {
      continue;
    }

    columnSet.add(key);
  }

  return Array.from(columnSet);
}

/**
 * Build VALUES clause with parameter placeholders
 */
/** An `sql` fragment or condition (anything rendering itself with `buildSql` and reporting its refs). */
function isSqlExpression(value: unknown): value is { buildSql(context: { paramCounter: number; params: any[] }): string } {
  return value !== null
    && typeof value === 'object'
    && typeof (value as any).buildSql === 'function'
    && typeof (value as any).getFieldRefs === 'function';
}

export function buildValuesClause(
  dataArray: Record<string, any>[],
  columnConfigs: ColumnConfig[],
  startParamIndex: number = 1
): ValuesClauseResult {
  const valueClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = startParamIndex;

  for (const data of dataArray) {
    const rowPlaceholders: string[] = [];

    for (const config of columnConfigs) {
      const value = data[config.propName];

      // An `sql` fragment renders inline, its parameters continuing the statement's — it used to be
      // bound AS a parameter (duck-typed: this module stays free of the conditions module)
      if (isSqlExpression(value)) {
        const context = { paramCounter: paramIndex, params };
        rowPlaceholders.push(`(${value.buildSql(context)})`);
        paramIndex = context.paramCounter;
        continue;
      }

      const mappedValue = applyToDriverMapper(value, config);
      params.push(mappedValue);
      rowPlaceholders.push(`$${paramIndex++}`);
    }

    valueClauses.push(`(${rowPlaceholders.join(', ')})`);
  }

  return {
    valueClauses,
    params,
    nextParamIndex: paramIndex,
  };
}

/**
 * Build ON CONFLICT clause for upserts
 */
export function buildConflictClause(
  conflictColumns: string[],
  updateColumns: string[],
  schema: TableSchema,
  targetWhere?: string,
  setWhere?: string
): string {
  let sql = ' ON CONFLICT';

  // Conflict target columns
  const conflictCols = conflictColumns.map(c => {
    const column = schema.columns[c];
    const config = column?.build();
    return `"${config?.name || c}"`;
  }).join(', ');
  sql += ` (${conflictCols})`;

  // Target WHERE clause
  if (targetWhere) {
    sql += ` WHERE ${targetWhere}`;
  }

  // DO UPDATE SET
  sql += ' DO UPDATE SET ';

  const updateParts = updateColumns.map(col => {
    const column = schema.columns[col];
    if (!column) {
      // Column not in schema, use as-is (shouldn't happen normally)
      return `"${col}" = EXCLUDED."${col}"`;
    }
    const config = column.build();
    return `"${config.name}" = EXCLUDED."${config.name}"`;
  });
  sql += updateParts.join(', ');

  // SET WHERE clause
  if (setWhere) {
    sql += ` WHERE ${setWhere}`;
  }

  return sql;
}

/**
 * Build column name to DB name mapping
 */
export function buildColumnNameMap(schema: TableSchema): Map<string, string> {
  const map = new Map<string, string>();
  for (const [propName, colBuilder] of Object.entries(schema.columns)) {
    const config = (colBuilder as any).build();
    map.set(propName, config.name);
  }
  return map;
}

/**
 * Get database column name from property name
 */
export function getDbColumnName(schema: TableSchema, propName: string): string {
  const column = schema.columns[propName];
  if (column) {
    const config = column.build();
    return config.name;
  }
  return propName;
}
