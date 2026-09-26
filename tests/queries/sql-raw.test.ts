import { describe, test, expect } from 'bun:test';
import { and, coalesce, eq, gt, isNull, lt, not, or, sql, RawSql, SqlFragment } from '../../src';

describe('SQL Raw and Helper Functions', () => {
  describe('sql.raw()', () => {
    test('should insert raw SQL without parameterization', () => {
      const fragment = sql`SELECT * FROM ${sql.raw('users')} WHERE id = ${1}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      // Raw SQL should be inserted directly, not as a parameter
      expect(result).toBe('SELECT * FROM users WHERE id = $1');
      expect(context.params).toEqual([1]);
    });

    test('should handle multiple raw SQL values', () => {
      const fragment = sql`SELECT ${sql.raw('name')}, ${sql.raw('email')} FROM ${sql.raw('users')}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT name, email FROM users');
      expect(context.params).toEqual([]);
    });

    test('should mix raw SQL with parameterized values', () => {
      const tableName = 'users';
      const columnName = 'status';
      const value = 'active';

      const fragment = sql`SELECT * FROM ${sql.raw(tableName)} WHERE ${sql.raw(columnName)} = ${value}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT * FROM users WHERE status = $1');
      expect(context.params).toEqual(['active']);
    });

    test('should handle raw SQL for ORDER BY direction', () => {
      const sortDirection = 'DESC';
      const fragment = sql`SELECT * FROM users ORDER BY name ${sql.raw(sortDirection)}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT * FROM users ORDER BY name DESC');
      expect(context.params).toEqual([]);
    });

    test('should handle raw SQL for complex expressions', () => {
      const fragment = sql`SELECT ${sql.raw('COUNT(*)')} as total FROM users`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT COUNT(*) as total FROM users');
      expect(context.params).toEqual([]);
    });

    test('should handle raw SQL with operators', () => {
      const operator = '>=';
      const fragment = sql`SELECT * FROM users WHERE age ${sql.raw(operator)} ${18}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT * FROM users WHERE age >= $1');
      expect(context.params).toEqual([18]);
    });

    test('should handle raw SQL for JOIN types', () => {
      const joinType = 'LEFT OUTER JOIN';
      const fragment = sql`SELECT * FROM users ${sql.raw(joinType)} posts ON users.id = posts.user_id`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT * FROM users LEFT OUTER JOIN posts ON users.id = posts.user_id');
      expect(context.params).toEqual([]);
    });

    test('should handle empty raw SQL', () => {
      const fragment = sql`SELECT * FROM users${sql.raw('')}`;
      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('SELECT * FROM users');
      expect(context.params).toEqual([]);
    });

    test('RawSql class should be exported and usable', () => {
      const raw = new RawSql('test');
      expect(raw.value).toBe('test');
      expect(raw instanceof RawSql).toBe(true);
    });
  });

  describe('sql.empty', () => {
    test('should create an empty SQL fragment', () => {
      const context = { paramCounter: 1, params: [] as any[] };
      const result = sql.empty.buildSql(context);

      expect(result).toBe('');
      expect(context.params).toEqual([]);
    });

    test('should be usable for conditional SQL', () => {
      const shouldFilter = false;
      const condition = shouldFilter ? sql`WHERE active = ${true}` : sql.empty;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = condition.buildSql(context);

      expect(result).toBe('');
      expect(context.params).toEqual([]);
    });

    test('should work when condition is true', () => {
      const shouldFilter = true;
      const condition = shouldFilter ? sql`WHERE active = ${true}` : sql.empty;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = condition.buildSql(context);

      expect(result).toBe('WHERE active = $1');
      expect(context.params).toEqual([true]);
    });

    test('sql.empty should be a SqlFragment instance', () => {
      expect(sql.empty instanceof SqlFragment).toBe(true);
    });
  });

  describe('sql.join()', () => {
    test('should join SQL fragments with default separator', () => {
      const fragments = [
        sql`name`,
        sql`email`,
        sql`age`,
      ];
      const joined = sql.join(fragments);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('name, email, age');
      expect(context.params).toEqual([]);
    });

    test('should join SQL fragments with custom separator', () => {
      const fragments = [
        sql`name`,
        sql`email`,
        sql`age`,
      ];
      const joined = sql.join(fragments, sql` AND `);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('name AND email AND age');
      expect(context.params).toEqual([]);
    });

    test('should handle fragments with parameters', () => {
      const fragments = [
        sql`name = ${`Alice`}`,
        sql`age > ${18}`,
        sql`active = ${true}`,
      ];
      const joined = sql.join(fragments, sql` AND `);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('name = $1 AND age > $2 AND active = $3');
      expect(context.params).toEqual(['Alice', 18, true]);
    });

    test('should return empty for empty array', () => {
      const joined = sql.join([]);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('');
      expect(context.params).toEqual([]);
    });

    test('should return single fragment for array with one element', () => {
      const fragments = [sql`name = ${`Bob`}`];
      const joined = sql.join(fragments);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('name = $1');
      expect(context.params).toEqual(['Bob']);
    });

    test('should work with raw SQL in fragments', () => {
      const columns = ['name', 'email', 'created_at'];
      const fragments = columns.map(col => sql`${sql.raw(col)}`);
      const joined = sql.join(fragments);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('name, email, created_at');
      expect(context.params).toEqual([]);
    });

    test('should handle complex fragments with mixed content', () => {
      const fragments = [
        sql`${sql.raw('COUNT(*)')} as total`,
        sql`${sql.raw('MAX')}(age) as max_age`,
        sql`${sql.raw('AVG')}(score) as avg_score`,
      ];
      const joined = sql.join(fragments);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('COUNT(*) as total, MAX(age) as max_age, AVG(score) as avg_score');
      expect(context.params).toEqual([]);
    });

    test('should work with separator containing parameters', () => {
      const fragments = [
        sql`a`,
        sql`b`,
        sql`c`,
      ];
      // Unusual but should work
      const joined = sql.join(fragments, sql` || ${'-'} || `);

      const context = { paramCounter: 1, params: [] as any[] };
      const result = joined.buildSql(context);

      expect(result).toBe('a || $1 || b || $2 || c');
      expect(context.params).toEqual(['-', '-']);
    });
  });

  describe('Combined usage', () => {
    test('should combine raw, empty, and join in complex query', () => {
      const tableName = 'users';
      const columns = ['id', 'name', 'email'];
      const shouldFilter = true;

      const selectColumns = sql.join(columns.map(c => sql`${sql.raw(c)}`));
      const whereClause = shouldFilter ? sql` WHERE active = ${true}` : sql.empty;

      const query = sql`SELECT ${selectColumns} FROM ${sql.raw(tableName)}${whereClause}`;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = query.buildSql(context);

      expect(result).toBe('SELECT id, name, email FROM users WHERE active = $1');
      expect(context.params).toEqual([true]);
    });

    test('should build dynamic INSERT statement', () => {
      const tableName = 'users';
      const columns = ['name', 'email', 'age'];
      const values = ['Alice', 'alice@test.com', 30];

      const columnList = sql.join(columns.map(c => sql`${sql.raw(c)}`));
      const valueList = sql.join(values.map(v => sql`${v}`));

      const query = sql`INSERT INTO ${sql.raw(tableName)} (${columnList}) VALUES (${valueList})`;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = query.buildSql(context);

      expect(result).toBe('INSERT INTO users (name, email, age) VALUES ($1, $2, $3)');
      expect(context.params).toEqual(['Alice', 'alice@test.com', 30]);
    });

    test('should build dynamic UPDATE statement', () => {
      const tableName = 'users';
      const updates = { name: 'Bob', email: 'bob@test.com' };
      const id = 123;

      const setClause = sql.join(
        Object.entries(updates).map(([col, val]) => sql`${sql.raw(col)} = ${val}`),
      );

      const query = sql`UPDATE ${sql.raw(tableName)} SET ${setClause} WHERE id = ${id}`;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = query.buildSql(context);

      expect(result).toBe('UPDATE users SET name = $1, email = $2 WHERE id = $3');
      expect(context.params).toEqual(['Bob', 'bob@test.com', 123]);
    });

    test('should handle nested SQL fragments with raw values', () => {
      const innerFragment = sql`${sql.raw('COALESCE')}(name, ${`Unknown`})`;
      const outerFragment = sql`SELECT ${innerFragment} as display_name FROM users`;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = outerFragment.buildSql(context);

      expect(result).toBe('SELECT COALESCE(name, $1) as display_name FROM users');
      expect(context.params).toEqual(['Unknown']);
    });
  });

  describe('Parameter counting', () => {
    test('should correctly count parameters with raw SQL interspersed', () => {
      const fragment = sql`
        SELECT * FROM ${sql.raw('users')}
        WHERE name = ${`Alice`}
        AND ${sql.raw('status')} = ${`active`}
        AND age > ${18}
        ORDER BY ${sql.raw('created_at')} DESC
      `;

      const context = { paramCounter: 1, params: [] as any[] };
      const result = fragment.buildSql(context);

      // Should have exactly 3 parameters
      expect(context.params).toEqual(['Alice', 'active', 18]);
      expect(result).toContain('$1');
      expect(result).toContain('$2');
      expect(result).toContain('$3');
      expect(result).not.toContain('$4');
    });

    test('should continue parameter counting from context', () => {
      const fragment = sql`name = ${`Test`}`;
      const context = { paramCounter: 5, params: ['a', 'b', 'c', 'd'] as any[] };
      const result = fragment.buildSql(context);

      expect(result).toBe('name = $5');
      expect(context.params).toEqual(['a', 'b', 'c', 'd', 'Test']);
      expect(context.paramCounter).toBe(6);
    });
  });

  describe('a raw fragment as an and() / or() operand', () => {
    const render = (condition: { buildSql(context: any): string }): string => condition.buildSql({ paramCounter: 1, params: [] });
    const age = { __dbColumnName: 'age', __fieldName: 'age', __tableAlias: 'users' } as any;
    const active = { __dbColumnName: 'is_active', __fieldName: 'isActive', __tableAlias: 'users' } as any;

    test('keeps its own grouping: it renders in parentheses', () => {
      expect(render(and(sql<boolean>`${age} > 40 OR ${age} < 30`, eq(active, true))))
        .toBe('(("users"."age" > 40 OR "users"."age" < 30) AND "users"."is_active" = $1)');
      expect(render(or(sql<boolean>`a`, sql<boolean>`b`))).toBe('((a) OR (b))');
      expect(render(and(sql.join([sql`a`, sql`b`], sql` OR `), sql`c`))).toBe('((a OR b) AND (c))');
      // .as() / .mapWith() copies of a raw fragment are raw too
      expect(render(and(sql<boolean>`a OR b`.as('x'), sql<boolean>`c`))).toBe('((a OR b) AND (c))');
      // one operand, and NOT, which parenthesizes its operand anyway
      expect(render(and(sql<boolean>`a OR b`))).toBe('(a OR b)');
      expect(render(not(sql<boolean>`a OR b`))).toBe('NOT (a OR b)');
    });

    test('comparisons, helpers and nested and() / or() render as before', () => {
      expect(render(and(eq(active, true), gt(age, 30)))).toBe('("users"."is_active" = $1 AND "users"."age" > $2)');
      expect(render(or(and(eq(active, true), gt(age, 30)), lt(age, 20))))
        .toBe('(("users"."is_active" = $1 AND "users"."age" > $2) OR "users"."age" < $3)');
      expect(render(and(isNull(age), coalesce(active, false)))).toBe('("users"."age" IS NULL AND COALESCE("users"."is_active", $1))');
    });
  });
});
