import type { DatabaseClient, QueryResult } from '../database/database-client.interface';

/**
 * Prepared query for efficient reusable parameterized queries.
 *
 * Prepared queries build the SQL once and allow multiple executions
 * with different parameter values. This is useful for:
 * 1. Query building optimization - Build SQL once, execute many times
 * 2. Type-safe placeholders - Named parameters with validation
 * 3. Developer ergonomics - Cleaner API for reusable queries
 *
 * Every other value the query binds — a literal (`eq(u.isActive, true)`), a `param()`, a CTE's
 * parameters — is bound on every execution as it was when the query was prepared.
 *
 * @example
 * const getUserById = db.users
 *   .where(u => eq(u.id, sql.placeholder('userId')))
 *   .prepare('getUserById');
 *
 * await getUserById.execute({ userId: 10 });
 * await getUserById.execute({ userId: 20 });
 *
 * @example
 * // Multiple placeholders
 * const searchUsers = db.users
 *   .where(u => and(
 *     gt(u.age, sql.placeholder('minAge')),
 *     like(u.name, sql.placeholder('namePattern'))
 *   ))
 *   .prepare('searchUsers');
 *
 * await searchUsers.execute({ minAge: 18, namePattern: '%john%' });
 */
export class PreparedQuery<TResult, TParams extends Record<string, any> = Record<string, any>> {
  /**
   * Every `$n` of the statement: the value the build bound for it, or — a placeholder's slot —
   * `null` until an execution fills it.
   */
  private readonly boundTemplate: unknown[];

  /**
   * @param sql - The prepared SQL query string with $1, $2, etc. placeholders
   * @param placeholderMap - Map of placeholder names to their 1-indexed parameter positions
   * @param paramCount - Total number of parameters in the query
   * @param client - The database client for execution
   * @param transformFn - Function to transform raw database rows to the result type
   * @param name - Optional name for the prepared query (for debugging)
   * @param boundParams - The values the build bound for every NON-placeholder `$n`, in `$n` order
   *   (placeholders take a number but bind nothing at build time)
   */
  constructor(
    private readonly sql: string,
    private readonly placeholderMap: Map<string, number>,
    private readonly paramCount: number,
    private readonly client: DatabaseClient,
    private readonly transformFn: (rows: any[]) => TResult[],
    public readonly name: string,
    boundParams: readonly unknown[] = []
  ) {
    const placeholderSlots = new Set(placeholderMap.values());
    let next = 0;

    this.boundTemplate = Array.from({ length: paramCount }, (_, index) =>
      placeholderSlots.has(index + 1) || next >= boundParams.length ? null : boundParams[next++]);
  }

  /**
   * Execute the prepared query with the given parameters
   *
   * @param params - Object mapping placeholder names to their values
   * @returns Promise resolving to the query results
   * @throws Error if a required placeholder parameter is missing
   *
   * @example
   * const result = await preparedQuery.execute({ userId: 10 });
   */
  async execute(params: TParams): Promise<TResult[]> {
    // The bound values as built, each placeholder's slot from the named params
    const paramArray = [...this.boundTemplate];

    for (const [name, index] of this.placeholderMap) {
      if (!(name in params)) {
        throw new Error(`Missing parameter: ${name}`);
      }
      // Convert from 1-indexed (SQL $1, $2) to 0-indexed array
      paramArray[index - 1] = (params as Record<string, any>)[name];
    }

    const result = await this.client.query(this.sql, paramArray);
    return this.transformFn(result.rows);
  }

  /**
   * Get the prepared SQL string (for debugging)
   */
  getSql(): string {
    return this.sql;
  }

  /**
   * Get the placeholder names used in this query
   */
  getPlaceholderNames(): string[] {
    return Array.from(this.placeholderMap.keys());
  }
}
