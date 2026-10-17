import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * How a call to the subquery helpers type-checks where it is written: in a CONSUMER, through the published
 * declarations, and in linkgress's own sources. Each with the installed TypeScript and with TypeScript 7
 * (`bun check`, Bun >= 1.4.3).
 *
 * The rest of the suite compiles against `src`, where `Subquery`'s private fields keep their types. Declaration emit
 * erases them (`private __resultType?;`), so for a consumer a subquery's rows constrain nothing and `T` of
 * `inSubquery` & co. comes from the column, while a one-column projection's rows are `{ id: number }`. TypeScript 7
 * inferred `T` from those rows instead, and every such call was TS2345 on its column (1.0.36). The first signature of
 * each helper now takes `T` from the column alone; the second is the 1.0.36 one, which a subquery whose rows are
 * WIDER than the column still needs where the rows are checked.
 */
const ROOT = path.resolve(import.meta.dir, '../..');
// Under node_modules, so the emitted declarations resolve their own imports (`pg`, `postgres`, …) as an install does.
const WORK = path.join(ROOT, 'node_modules', '.cache', 'linkgress-consumer-types', String(process.pid));
const TSC = require.resolve('typescript/lib/tsc.js');
const INSTALLED_TS: string = require('typescript/package.json').version;
const BUN_TS: string | undefined = (process.versions as Record<string, string | undefined>).typescript;

const CONSUMER = `
import {
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eqSubquery,
  gteSubquery,
  gtSubquery,
  inSubquery,
  integer,
  lteSubquery,
  ltSubquery,
  neSubquery,
  notInSubquery,
} from 'linkgress-orm';

class Author extends DbEntity {
  id!: DbColumn<number>;
}

class Post extends DbEntity {
  id!: DbColumn<number>;
  authorId!: DbColumn<number>;
}

class ConsumerDatabase extends DbContext {
  get authors(): DbEntityTable<Author> {
    return this.table(Author);
  }

  get posts(): DbEntityTable<Post> {
    return this.table(Post);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Author, entity => {
      entity.toTable('authors');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
    });
    model.entity(Post, entity => {
      entity.toTable('posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.authorId).hasType(integer('author_id'));
    });
  }
}

declare const db: ConsumerDatabase;

// A one-column projection: its rows are { id: number }, the column it is compared with is a number.
const authorIds = () => db.posts.select(p => ({ id: p.authorId }));

db.authors.where(a => inSubquery(a.id, authorIds().asSubquery()));
db.authors.where(a => inSubquery(a.id, authorIds().asSubquery('array')));
db.authors.where(a => notInSubquery(a.id, authorIds().asSubquery()));
db.authors.where(a => eqSubquery(a.id, authorIds().asSubquery('scalar')));
db.authors.where(a => neSubquery(a.id, authorIds().asSubquery('scalar')));
db.authors.where(a => gtSubquery(a.id, authorIds().asSubquery('scalar')));
db.authors.where(a => gteSubquery(a.id, authorIds().asSubquery('scalar')));
db.authors.where(a => ltSubquery(a.id, authorIds().asSubquery('scalar')));
db.authors.where(a => lteSubquery(a.id, authorIds().asSubquery('scalar')));

// T is the column's value type, whatever the subquery's rows look like.
type Same<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;
declare const author: Author;
const inRows = inSubquery(author.id, authorIds().asSubquery());
const notInRows = notInSubquery(author.id, authorIds().asSubquery());
const eqRow = eqSubquery(author.id, authorIds().asSubquery('scalar'));
const neRow = neSubquery(author.id, authorIds().asSubquery('scalar'));
const gtRow = gtSubquery(author.id, authorIds().asSubquery('scalar'));
const gteRow = gteSubquery(author.id, authorIds().asSubquery('scalar'));
const ltRow = ltSubquery(author.id, authorIds().asSubquery('scalar'));
const lteRow = lteSubquery(author.id, authorIds().asSubquery('scalar'));
export const inferredFromTheColumn: [
  Same<typeof inRows, ReturnType<typeof inSubquery<number>>>,
  Same<typeof notInRows, ReturnType<typeof notInSubquery<number>>>,
  Same<typeof eqRow, ReturnType<typeof eqSubquery<number>>>,
  Same<typeof neRow, ReturnType<typeof neSubquery<number>>>,
  Same<typeof gtRow, ReturnType<typeof gtSubquery<number>>>,
  Same<typeof gteRow, ReturnType<typeof gteSubquery<number>>>,
  Same<typeof ltRow, ReturnType<typeof ltSubquery<number>>>,
  Same<typeof lteRow, ReturnType<typeof lteSubquery<number>>>,
] = [true, true, true, true, true, true, true, true];
`;

// In the sources a subquery's rows ARE checked: rows wider than the column widen T, as they did in 1.0.36.
const SOURCE = `
import {
  DbColumn,
  Subquery,
  eqSubquery,
  gteSubquery,
  gtSubquery,
  inSubquery,
  lteSubquery,
  ltSubquery,
  neSubquery,
  notInSubquery,
} from 'linkgress-orm';

declare const column: DbColumn<number>;
declare const unknownRows: Subquery<unknown[], 'array'>;
declare const nullableRows: Subquery<(number | null)[], 'array'>;
declare const unknownValue: Subquery<unknown, 'scalar'>;
declare const nullableValue: Subquery<number | null, 'scalar'>;

inSubquery(column, unknownRows);
inSubquery(column, nullableRows);
notInSubquery(column, unknownRows);
notInSubquery(column, nullableRows);
eqSubquery(column, unknownValue);
eqSubquery(column, nullableValue);
neSubquery(column, nullableValue);
gtSubquery(column, nullableValue);
gteSubquery(column, nullableValue);
ltSubquery(column, nullableValue);
lteSubquery(column, nullableValue);
`;

const BASE_OPTIONS = {
  strict: true,
  target: 'ES2022',
  lib: ['ES2022'],
  module: 'esnext',
  moduleResolution: 'bundler',
  noEmit: true,
  skipLibCheck: true,
};

const writeProject = (dir: string, file: string, source: string, compilerOptions: Record<string, unknown>) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), source);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [file] }, null, 2));
};

// One-line diagnostics from both tools: drop the agent and CI output modes.
const toolEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
  for (const key of ['CLAUDECODE', 'AGENT', 'REPL_ID', 'GITHUB_ACTIONS', 'FORCE_COLOR']) {
    delete env[key];
  }
  return env;
};

const run = (cwd: string, command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd, env: toolEnv(), encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

const withInstalledTypeScript = (dir: string) => run(dir, 'node', [TSC, '-p', 'tsconfig.json', '--pretty', 'false']);

// A clean run still prints its summary, so the diagnostics are compared only when there are some.
const withBunCheck = (dir: string) => {
  const result = run(dir, process.execPath, ['check', '-p', 'tsconfig.json', '--no-pretty']);
  return result.status === 0 ? 'clean' : result.output;
};

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('subquery helpers in a consumer (published declarations)', () => {
  const dir = path.join(WORK, 'consumer');

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    const pkg = path.join(dir, 'node_modules', 'linkgress-orm');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'linkgress-orm', types: 'dist/index.d.ts' }));
    writeProject(dir, 'consumer.ts', CONSUMER, { ...BASE_OPTIONS, types: [] });

    const emit = spawnSync('node', [
      TSC,
      '-p', path.join(ROOT, 'tsconfig.json'),
      '--emitDeclarationOnly',
      '--declarationMap', 'false',
      '--outDir', path.join(pkg, 'dist'),
    ], { cwd: ROOT, encoding: 'utf8' });
    if (emit.status !== 0) {
      throw new Error(`declaration emit failed:\n${emit.stdout}${emit.stderr}`);
    }
  }, 120_000);

  test(`a one-column subquery type-checks with the installed TypeScript (${INSTALLED_TS})`, () => {
    expect(withInstalledTypeScript(dir)).toEqual({ status: 0, output: '' });
  }, 120_000);

  test.skipIf(BUN_TS == null)(`a one-column subquery type-checks with TypeScript ${BUN_TS ?? '7'} (bun check)`, () => {
    expect(withBunCheck(dir)).toBe('clean');
  }, 120_000);
});

describe("subquery helpers in linkgress's sources", () => {
  const dir = path.join(WORK, 'source');

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    writeProject(dir, 'source.ts', SOURCE, {
      ...BASE_OPTIONS,
      types: ['bun'],
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      paths: { 'linkgress-orm': [path.join(ROOT, 'src', 'index.ts')] },
    });
  });

  test(`a subquery wider than its column type-checks with the installed TypeScript (${INSTALLED_TS})`, () => {
    expect(withInstalledTypeScript(dir)).toEqual({ status: 0, output: '' });
  }, 120_000);

  test.skipIf(BUN_TS == null)(`a subquery wider than its column type-checks with TypeScript ${BUN_TS ?? '7'} (bun check)`, () => {
    expect(withBunCheck(dir)).toBe('clean');
  }, 120_000);
});
