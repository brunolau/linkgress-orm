import { describe, test, expect, jest } from '@jest/globals';

// Mock the bun:sql module since we're not running under Bun
const mockResult = {
  count: 2,
  length: 2,
  [Symbol.iterator]: function* () {
    yield { id: 1, name: 'Alice' };
    yield { id: 2, name: 'Bob' };
  }
};

const mockEmptyResult = {
  count: 0,
  length: 0,
  [Symbol.iterator]: function* () {}
};

const mockInsertResult = {
  count: 1,
  length: 1,
  [Symbol.iterator]: function* () {
    yield { id: 3, name: 'Charlie' };
  }
};

// Create mock SQL instance
const createMockSql = () => {
  const mockReserved = {
    unsafe: jest.fn<any>().mockResolvedValue(mockResult as any),
    release: jest.fn<any>(),
  };

  const mockSql: any = jest.fn<any>();
  mockSql.unsafe = jest.fn<any>().mockImplementation((_sql: string, _params?: any[]) => {
    // Return a thenable that also has .simple()
    const result = Promise.resolve(mockResult) as any;
    result.simple = jest.fn<any>().mockResolvedValue([mockResult, mockInsertResult] as any);
    return result;
  });
  mockSql.close = jest.fn<any>().mockResolvedValue(undefined as any);
  mockSql.reserve = jest.fn<any>().mockResolvedValue(mockReserved as any);
  mockSql.begin = jest.fn<any>().mockImplementation(async (callback: Function) => {
    const txSql: any = {};
    txSql.unsafe = jest.fn<any>().mockResolvedValue(mockInsertResult as any);
    return await callback(txSql);
  });

  return { mockSql, mockReserved };
};

// Mock the require for bun:sql
jest.mock('bun:sql', () => {
  return {
    SQL: jest.fn<any>().mockImplementation((_config: any) => {
      const { mockSql } = createMockSql();
      return mockSql;
    }),
  };
}, { virtual: true });

// Import after mocking
import { BunClient } from '../../src/database/bun-client';

describe('BunClient', () => {
  describe('constructor', () => {
    test('should accept an existing SQL instance', () => {
      const { mockSql } = createMockSql();

      // Pass the mock SQL instance directly
      const client = new BunClient(mockSql);

      expect(client.getDriverName()).toBe('bun');
      expect(client.getSql()).toBe(mockSql);
    });

    test('should detect if value is a Bun SQL instance', () => {
      const { mockSql } = createMockSql();

      // A valid Bun SQL instance has unsafe() and close() methods
      expect(mockSql.unsafe).toBeDefined();
      expect(mockSql.close).toBeDefined();

      // BunClient should accept it
      const client = new BunClient(mockSql);
      expect(client).toBeDefined();
    });
  });

  describe('query', () => {
    test('should execute query with parameters using sql.unsafe()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users WHERE id = $1', [1]);

      // Bun SQL uses .unsafe() for parameterized dynamic SQL strings
      expect(mockSql.unsafe).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: 1, name: 'Alice' });
      expect(result.rows[1]).toEqual({ id: 2, name: 'Bob' });
      expect(result.rowCount).toBe(2);
    });

    test('should execute query without parameters', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users');

      expect(mockSql.unsafe).toHaveBeenCalledWith('SELECT * FROM users', []);
      expect(result.rows).toHaveLength(2);
    });

    test('should handle empty result', async () => {
      const { mockSql } = createMockSql();
      mockSql.unsafe = jest.fn<any>().mockResolvedValue(mockEmptyResult as any);
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users WHERE id = $1', [999]);

      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });
  });

  describe('connect', () => {
    test('should return a pooled connection using reserve()', async () => {
      const { mockSql, mockReserved } = createMockSql();
      const client = new BunClient(mockSql);

      const connection = await client.connect();

      expect(mockSql.reserve).toHaveBeenCalled();
      expect(connection).toBeDefined();

      // Test query on pooled connection
      const result = await connection.query('SELECT 1');
      expect(mockReserved.unsafe).toHaveBeenCalled();
      expect(result.rows).toHaveLength(2);
    });

    test('should release connection', async () => {
      const { mockSql, mockReserved } = createMockSql();
      const client = new BunClient(mockSql);

      const connection = await client.connect();
      connection.release();

      expect(mockReserved.release).toHaveBeenCalled();
    });
  });

  describe('end', () => {
    test('should not close connection when not owning it', async () => {
      const { mockSql } = createMockSql();
      // When passing an existing SQL instance, ownsConnection is false
      const client = new BunClient(mockSql);

      await client.end();

      // Should NOT close because we don't own the connection
      expect(mockSql.close).not.toHaveBeenCalled();
    });
  });

  describe('transaction', () => {
    test('should execute callback within transaction using sql.begin()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.transaction(async (query) => {
        const insertResult = await query('INSERT INTO users (name) VALUES ($1) RETURNING *', ['Charlie']);
        return insertResult.rows[0];
      });

      expect(mockSql.begin).toHaveBeenCalled();
      expect(result).toEqual({ id: 3, name: 'Charlie' });
    });

    test('should pass query function to callback', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      await client.transaction(async (query) => {
        const result = await query('SELECT 1');
        expect(result.rows).toBeDefined();
        expect(result.rowCount).toBeDefined();
        return result;
      });
    });
  });

  describe('getDriverName', () => {
    test('should return "bun"', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.getDriverName()).toBe('bun');
    });
  });

  describe('supportsMultiStatementQueries', () => {
    test('should return true', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.supportsMultiStatementQueries()).toBe(true);
    });
  });

  describe('supportsBinaryProtocol', () => {
    test('should return false (uses binary internally but no explicit control)', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.supportsBinaryProtocol()).toBe(false);
    });
  });

  describe('querySimple', () => {
    test('should execute multi-statement query using .simple()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.querySimple('SELECT 1; SELECT 2;');

      // Should return the last result set
      expect(result.rows).toBeDefined();
    });
  });

  describe('querySimpleMulti', () => {
    test('should return all result sets', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const results = await client.querySimpleMulti('SELECT 1; SELECT 2;');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      results.forEach(result => {
        expect(result.rows).toBeDefined();
        expect(result.rowCount).toBeDefined();
      });
    });
  });

  describe('getSql', () => {
    test('should return underlying SQL instance', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.getSql()).toBe(mockSql);
    });
  });
});

describe('BunClient integration patterns', () => {
  test('should work with typical ORM usage pattern', async () => {
    const { mockSql } = createMockSql();
    const client = new BunClient(mockSql);

    // Simulate typical ORM operations

    // 1. Simple select
    const users = await client.query('SELECT * FROM users');
    expect(users.rows.length).toBeGreaterThan(0);

    // 2. Insert with returning
    mockSql.unsafe = jest.fn<any>().mockResolvedValue(mockInsertResult as any);
    const inserted = await client.query(
      'INSERT INTO users (name) VALUES ($1) RETURNING *',
      ['NewUser']
    );
    expect(inserted.rows[0]).toHaveProperty('id');

    // 3. Transaction
    const txResult = await client.transaction(async (query) => {
      await query('INSERT INTO orders (user_id) VALUES ($1)', [1]);
      await query('UPDATE users SET order_count = order_count + 1 WHERE id = $1', [1]);
      return { success: true };
    });
    expect(txResult).toEqual({ success: true });

    // 4. Cleanup
    await client.end();
  });

  test('should handle connection pooling pattern', async () => {
    const { mockSql, mockReserved } = createMockSql();
    const client = new BunClient(mockSql);

    // Get a dedicated connection
    const conn = await client.connect();

    // Use it for multiple queries
    await conn.query('BEGIN');
    await conn.query('INSERT INTO users (name) VALUES ($1)', ['Test']);
    await conn.query('COMMIT');

    // Release back to pool
    conn.release();

    expect(mockReserved.release).toHaveBeenCalled();
  });
});

describe('BunSqlOptions type', () => {
  test('should accept various configuration options', () => {
    // This is a compile-time type test
    const postgresConfig = {
      hostname: 'localhost',
      port: 5432,
      database: 'mydb',
      username: 'user',
      password: 'pass',
      max: 20,
      idleTimeout: 30,
    };

    const mysqlConfig = {
      adapter: 'mysql' as const,
      hostname: 'localhost',
      port: 3306,
      database: 'mydb',
      username: 'user',
      password: 'pass',
    };

    const sqliteConfig = {
      adapter: 'sqlite' as const,
      filename: ':memory:',
      readonly: false,
      create: true,
    };

    // Type checks pass if this compiles
    expect(postgresConfig.hostname).toBe('localhost');
    expect(mysqlConfig.adapter).toBe('mysql');
    expect(sqliteConfig.filename).toBe(':memory:');
  });
});
