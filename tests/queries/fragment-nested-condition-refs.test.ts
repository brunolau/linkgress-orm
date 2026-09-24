import { describe, test, expect, beforeAll } from 'bun:test';
import { getSharedDatabase, setupDatabase, seedTestData } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { and, eq, gt, not, or, sql, SqlFragment, exists } from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';

/**
 * A Condition nested inside a `sql` fragment must report its field refs.
 *
 * `SqlFragment.getFieldRefs()` used to collect only the FieldRefs and nested fragments
 * interpolated into it, so a Condition interpolated into a fragment
 * (sql`${eq(p.user.username, 'x')}`) hid its navigation refs from JOIN detection:
 * the statement referenced "user"."username" without joining "user" and failed with
 * `missing FROM-clause entry for table "user"` — or, where an alias of the same name was
 * already in scope, silently read that one instead.
 */
describe('Conditions nested in sql fragments expose their field refs', () => {
  const navRef = (column: string, alias: string, navigationAliases: string[] = []) => ({
    __dbColumnName: column,
    __fieldName: column,
    __tableAlias: alias,
    __navigationAliases: navigationAliases,
  }) as any;

  describe('getFieldRefs()', () => {
    test('reports the refs of a comparison interpolated into a fragment', () => {
      const username = navRef('username', 'user');
      const fragment = sql<boolean>`${eq(username, 'alice')}`;

      expect(fragment.getFieldRefs()).toEqual([username]);
    });

    test('reports the refs of a logical condition tree', () => {
      const username = navRef('username', 'user');
      const age = navRef('age', 'user');
      const fragment = sql<boolean>`NOT ${or(eq(username, 'alice'), and(gt(age, 30)))}`;

      expect(fragment.getFieldRefs()).toEqual([username, age]);
    });

    test('reports refs through several levels of fragment nesting', () => {
      const level = navRef('name', 'level', ['task']);
      const inner = sql<boolean>`${not(eq(level, 'High'))}`;
      const outer = sql<boolean>`COALESCE(${inner}, false)`;

      expect(outer.getFieldRefs()).toEqual([level]);
    });

    test('still renders the nested condition in parentheses', () => {
      const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
      const fragment = sql<boolean>`${eq(navRef('username', 'user'), 'alice')}`;

      expect(fragment.buildSql(ctx)).toBe('("user"."username" = $1)');
      expect(ctx.params).toEqual(['alice']);
    });

    test('a fragment with only literals still reports no refs', () => {
      expect(sql`${1} + ${2}`.getFieldRefs()).toEqual([]);
      expect(new SqlFragment(['TRUE'], []).getFieldRefs()).toEqual([]);
    });
  });

  describe('in queries', () => {
    let db: AppDatabase;

    beforeAll(async () => {
      db = getSharedDatabase();
      await setupDatabase(db);
      await seedTestData(db);
    });

    test('a navigation condition inside a projected fragment gets its JOIN', async () => {
      const rows = await db.posts
        .select(p => ({
          title: p.title,
          byAlice: sql<boolean>`${eq(p.user!.username, 'alice')}`,
        }))
        .orderBy(p => p.title)
        .toList();

      expect(rows).toEqual([
        { title: 'Alice Post 1', byAlice: true },
        { title: 'Alice Post 2', byAlice: true },
        { title: 'Bob Post', byAlice: false },
      ]);
    });

    test('a navigation condition inside a WHERE fragment gets its JOIN', async () => {
      const rows = await db.posts
        .where(p => sql<boolean>`${eq(p.user!.username, 'bob')}`)
        .select(p => ({ title: p.title }))
        .toList();

      expect(rows).toEqual([{ title: 'Bob Post' }]);
    });

    test('a multi-level navigation condition inside a fragment joins every hop', async () => {
      const rows = await db.orderTasks
        .where(ot => sql<boolean>`${eq(ot.task!.level!.createdBy!.username, 'alice')}`)
        .select(ot => ({ title: ot.task!.title }))
        .toList();

      expect(rows).toEqual([{ title: 'Important Task' }]);
    });

    test('an EXISTS nested in a fragment keeps its outer navigation correlation', async () => {
      const rows = await db.users
        .select(u => ({
          username: u.username,
          hasPopularPost: sql<boolean>`COALESCE(${exists(u.posts!.where(p => gt(p.views, 120)))}, false)`,
        }))
        .orderBy(u => u.username)
        .toList();

      expect(rows).toEqual([
        { username: 'alice', hasPopularPost: true },
        { username: 'bob', hasPopularPost: true },
        { username: 'charlie', hasPopularPost: false },
      ]);
    });
  });
});
