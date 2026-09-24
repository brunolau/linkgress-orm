import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, like, or, sql } from '../../src';
import { byId, createLibraryFixture, disposeLibraryFixture, LibraryFixture } from '../utils/library-fixture';

/**
 * A mutation's RETURNING reads what its selector selects the way a SELECT reads it — `sql`
 * expressions, conditions, literals and ONE value on its own included, on every mutation (insert,
 * insertBulk, upsertBulk, mergeBulk, bulkUpdate, where().update(), where().delete(), the composed
 * child inserts) and on both of its paths: the plain `… RETURNING <list>` and the navigation
 * RETURNING, which runs the mutation as a data-modifying CTE and joins the navigations onto it.
 *
 * What used to happen instead:
 *  - an `sql` expression, a literal and `null` were silently dropped on the navigation path, and on
 *    the plain path of insert / upsert / merge / bulkUpdate (only update / delete rendered them);
 *  - an expression reading a navigation rendered on the plain path ("missing FROM-clause entry for
 *    table book"), or — reading nothing but a navigation — as `RETURNING ) SELECT FROM`;
 *  - a condition came back as its own internals (`{ field: 7 }`);
 *  - a selector returning one value (`ln => ln.note`) rendered an empty RETURNING list;
 *  - a WHERE reading a navigation plus a navigation RETURNING failed on an ambiguous `id`;
 *  - bulkUpdate rendered a navigation's column as the updated row's column of the same name.
 */
describe('mutation RETURNING: sql expressions, conditions, literals, single values', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  // Every test inserts its own loans (notes prefixed `rx-`) and they are removed after it
  afterEach(async () => {
    await fx.db.libLoans.where(ln => like(ln.note, 'rx-%')).delete();
    await fx.db.libMembers.where(m => like(m.name, 'rx-%')).delete();
  });

  const loan = (note: string, overrides: Partial<{ memberId: number; editionId: number; bookId: number }> = {}) => ({
    memberId: fx.ids.cy,
    editionId: fx.ids.e1,
    bookId: fx.ids.dune,
    note,
    ...overrides,
  });

  const returningSql = (): string => fx.lastStatement('RETURNING').replace(/\s+/g, ' ');

  describe('the plain RETURNING (the row\'s own columns)', () => {
    test('insert: an sql expression, a literal and null read back next to a column', async () => {
      fx.resetCapture();
      const row = await fx.db.libLoans.insert(loan('rx-a')).returning(ln => ({
        id: ln.id,
        loud: sql<string>`upper(${ln.note})`,
        kind: 'loan',
        nothing: null,
      }));

      expect(row).toEqual({ id: expect.any(Number), loud: 'RX-A', kind: 'loan', nothing: null });
      // One statement, no CTE: the expression renders over the inserted row's own column
      expect(returningSql()).toContain('upper("note") AS "loud"');
      expect(returningSql()).not.toContain('__mutation__');
    });

    test('insertBulk: an expression binding a parameter reads back per row', async () => {
      const rows = await fx.db.libLoans.insertBulk([loan('rx-b1'), loan('rx-b2')]).returning(ln => ({
        id: ln.id,
        tagged: sql<string>`${ln.note} || ${'-tag'}`,
      }));

      expect(byId(rows).map(r => r.tagged)).toEqual(['rx-b1-tag', 'rx-b2-tag']);
    });

    test('upsertBulk: an expression reads back from the upserted row', async () => {
      const [first] = await fx.db.libLoans.insertBulk([loan('rx-u')]).returning(ln => ({ id: ln.id }));
      const rows = await fx.db.libLoans
        .upsertBulk([{ id: first.id, ...loan('rx-u-new') }] as any, { primaryKey: 'id', overridingSystemValue: true } as any)
        .returning(ln => ({ id: ln.id, loud: sql<string>`upper(${ln.note})`, source: 'upsert' }));

      expect(rows).toEqual([{ id: first.id, loud: 'RX-U-NEW', source: 'upsert' }]);
    });

    test('mergeBulk: an expression renders under the MERGE target alias', async () => {
      fx.resetCapture();
      const rows = await fx.db.libLoans
        .mergeBulk([loan('rx-m')], { on: ['memberId', 'note'] })
        .returning(ln => ({ id: ln.id, loud: sql<string>`upper(${ln.note})` }));

      expect(rows).toEqual([{ id: expect.any(Number), loud: 'RX-M' }]);
      // A bare "note" is ambiguous between the target and the source there
      expect(returningSql()).toContain('upper(t."note") AS "loud"');
    });

    test('bulkUpdate: an expression renders under the updated row alias', async () => {
      const [inserted] = await fx.db.libLoans.insertBulk([loan('rx-bu')]).returning(ln => ({ id: ln.id }));
      fx.resetCapture();
      const rows = await fx.db.libLoans
        .bulkUpdate([{ id: inserted.id, note: 'rx-bu-2' }] as any)
        .returning(ln => ({ id: ln.id, loud: sql<string>`upper(${ln.note})`, flag: true }));

      expect(rows).toEqual([{ id: inserted.id, loud: 'RX-BU-2', flag: true }]);
      expect(returningSql()).toContain('upper(t."note") AS "loud"');
    });

    test('where().update() and where().delete(): expressions and literals read back', async () => {
      await fx.db.libLoans.insertBulk([loan('rx-w1'), loan('rx-w2')]);

      const updated = await fx.db.libLoans
        .where(ln => like(ln.note, 'rx-w%'))
        .update({ note: 'rx-w-updated' })
        .returning(ln => ({ id: ln.id, loud: sql<string>`upper(${ln.note})`, step: 1 }));

      expect(updated).toHaveLength(2);
      expect(updated.every(r => r.loud === 'RX-W-UPDATED' && r.step === 1)).toBe(true);

      const deleted = await fx.db.libLoans
        .where(ln => eq(ln.note, 'rx-w-updated'))
        .delete()
        .returning(ln => ({ id: ln.id, gone: sql<string>`${ln.note} || ${'!'}`, step: 2 }));

      expect(byId(deleted)).toEqual(byId(updated).map(r => ({ id: r.id, gone: 'rx-w-updated!', step: 2 })));
    });
  });

  describe('conditions', () => {
    test('insert: a condition reads back as a boolean', async () => {
      const row = await fx.db.libLoans.insert(loan('rx-c')).returning(ln => ({
        mine: eq(ln.memberId, fx.ids.cy),
        theirs: eq(ln.memberId, fx.ids.ada),
        either: or(eq(ln.note, 'nope'), like(ln.note, 'rx-%')),
      }));

      expect(row).toEqual({ mine: true, theirs: false, either: true });
    });

    test('update and delete: conditions read back as booleans', async () => {
      await fx.db.libLoans.insertBulk([loan('rx-c1'), loan('rx-c2', { memberId: fx.ids.bo })]);

      const updated = await fx.db.libLoans
        .where(ln => like(ln.note, 'rx-c%'))
        .update({ note: 'rx-cc' })
        .returning(ln => ({ memberId: ln.memberId, isBo: eq(ln.memberId, fx.ids.bo), both: and(eq(ln.note, 'rx-cc'), eq(ln.memberId, fx.ids.bo)) }));

      expect(updated.map(r => [r.memberId === fx.ids.bo, r.isBo, r.both]).sort()).toEqual([[false, false, false], [true, true, true]]);

      const deleted = await fx.db.libLoans.where(ln => eq(ln.note, 'rx-cc')).delete().returning(ln => ({ wasCy: eq(ln.memberId, fx.ids.cy) }));

      expect(deleted.map(r => r.wasCy).sort()).toEqual([false, true]);
    });
  });

  describe('literals', () => {
    test('every kind of literal reads back as it is, at any depth', async () => {
      const at = new Date('2021-02-03T04:05:06.000Z');
      const row = await fx.db.libLoans.insert(loan('rx-l')).returning(ln => ({
        id: ln.id,
        text: 'text',
        count: 42,
        ratio: 0.5,
        yes: true,
        no: false,
        nothing: null,
        at,
        list: ['a', 'b'],
        meta: { source: 'import', version: 3, note: ln.note },
      }));

      expect(row).toEqual({
        id: expect.any(Number),
        text: 'text',
        count: 42,
        ratio: 0.5,
        yes: true,
        no: false,
        nothing: null,
        at,
        list: ['a', 'b'],
        meta: { source: 'import', version: 3, note: 'rx-l' },
      });
      // Literals are not read from the database: a number stays a number, a Date a Date
      expect(typeof row.count).toBe('number');
      expect(row.at).toBeInstanceOf(Date);
    });

    test('an undefined field is left out, as a SELECT leaves it out', async () => {
      const row = await fx.db.libLoans.insert(loan('rx-undef')).returning(ln => ({ note: ln.note, missing: undefined }));

      expect(Object.keys(row)).toEqual(['note']);
      expect(row.note).toBe('rx-undef');
    });

    test('a selection of literals only still returns one row per mutated row', async () => {
      const inserted = await fx.db.libLoans.insertBulk([loan('rx-o1'), loan('rx-o2')]).returning(() => ({ ok: true }));
      expect(inserted).toEqual([{ ok: true }, { ok: true }]);

      const updated = await fx.db.libLoans.where(ln => like(ln.note, 'rx-o%')).update({ note: 'rx-o' }).returning(() => ({ ok: 'updated' }));
      expect(updated).toEqual([{ ok: 'updated' }, { ok: 'updated' }]);

      const none = await fx.db.libLoans.where(ln => eq(ln.note, 'rx-nobody')).update({ note: 'rx-x' }).returning(() => ({ ok: 1 }));
      expect(none).toEqual([]);
    });

    test('an empty selection returns an empty object per mutated row', async () => {
      const rows = await fx.db.libLoans.insertBulk([loan('rx-e1'), loan('rx-e2')]).returning(() => ({}));

      expect(rows).toEqual([{}, {}]);
    });

    test('a nested object of literals only rides the navigation RETURNING', async () => {
      const row = await fx.db.libLoans.insert(loan('rx-n')).returning(() => ({ meta: { a: 1, b: { c: 'deep' } } }));

      expect(row).toEqual({ meta: { a: 1, b: { c: 'deep' } } });
    });

    test('an array of columns is refused with a clear error', async () => {
      await expect(async () => {
        await fx.db.libLoans.insert(loan('rx-arr')).returning(ln => ({ pair: [ln.id, ln.note] }));
      }).toThrow(/array of columns or expressions/);
    });
  });

  describe('a selector returning ONE value', () => {
    test('a column: insert returns the value, insertBulk / update / delete their lists', async () => {
      const note = await fx.db.libLoans.insert(loan('rx-s1')).returning(ln => ln.note);
      expect(note).toBe('rx-s1');

      const ids = await fx.db.libLoans.insertBulk([loan('rx-s2'), loan('rx-s3')]).returning(ln => ln.id);
      expect(ids).toHaveLength(2);
      expect(ids.every(id => typeof id === 'number')).toBe(true);

      const notes = await fx.db.libLoans.where(ln => like(ln.note, 'rx-s%')).update({ note: 'rx-s' }).returning(ln => ln.note);
      expect(notes).toEqual(['rx-s', 'rx-s', 'rx-s']);

      const deleted = await fx.db.libLoans.where(ln => inIds(ln.id, ids)).delete().returning(ln => ln.id);
      expect([...deleted].sort()).toEqual([...ids].sort());
    });

    test('an expression, a condition and a navigation column', async () => {
      expect(await fx.db.libLoans.insert(loan('rx-v1')).returning(ln => sql<string>`upper(${ln.note})`)).toBe('RX-V1');
      expect(await fx.db.libLoans.insert(loan('rx-v2')).returning(ln => eq(ln.memberId, fx.ids.cy))).toBe(true);
      expect(await fx.db.libLoans.insert(loan('rx-v3')).returning(ln => ln.book!.name)).toBe('Dune');
      expect(await fx.db.libLoans.insert(loan('rx-v4')).returning(ln => sql<string>`lower(${ln.book!.name})`)).toBe('dune');
    });

    test('upsertBulk, mergeBulk and bulkUpdate return the values', async () => {
      const [first] = await fx.db.libLoans.insertBulk([loan('rx-sv')]).returning(ln => ({ id: ln.id }));

      expect(await fx.db.libLoans.mergeBulk([loan('rx-sv')], { on: ['memberId', 'note'] }).returning(ln => ln.id)).toEqual([first.id]);
      expect(await fx.db.libLoans.bulkUpdate([{ id: first.id, note: 'rx-sv2' }] as any).returning(ln => ln.note)).toEqual(['rx-sv2']);
      expect(
        await fx.db.libLoans.upsertBulk([{ id: first.id, ...loan('rx-sv3') }] as any, { primaryKey: 'id', overridingSystemValue: true } as any).returning(ln => ln.note)
      ).toEqual(['rx-sv3']);
    });

    test('a collection: an aggregate returns the number, a list its items', async () => {
      await fx.db.libMembers.insert({ name: 'rx-member', favoriteBookId: null });
      const member = await fx.db.libMembers.where(m => eq(m.name, 'rx-member')).first();
      await fx.db.libLoans.insertBulk([loan('rx-k1', { memberId: member!.id }), loan('rx-k2', { memberId: member!.id })]);

      // The update's RETURNING reads the row's collections (typed as the entity's, like an insert's)
      const counts: number[] = await fx.db.libMembers.where(m => eq(m.id, member!.id)).update({ name: 'rx-member' }).returning(m => m.loans!.count());
      expect(counts).toEqual([2]);

      const notes: string[][] = await fx.db.libMembers.where(m => eq(m.id, member!.id)).update({ name: 'rx-member' })
        .returning(m => m.loans!.orderBy(l => l.note).select(l => l.note).toList());
      expect(notes).toEqual([['rx-k1', 'rx-k2']]);
    });
  });

  describe('expressions reading navigations (the navigation RETURNING)', () => {
    test('an expression over a navigation joins it', async () => {
      fx.resetCapture();
      const row = await fx.db.libLoans.insert(loan('rx-nav')).returning(ln => ({ id: ln.id, loudBook: sql<string>`upper(${ln.book!.name})` }));

      expect(row).toEqual({ id: expect.any(Number), loudBook: 'DUNE' });
      expect(fx.lastStatement('__mutation__').replace(/\s+/g, ' ')).toContain('upper("book"."name") AS "loudBook"');
    });

    test('an expression reading nothing but a navigation is the whole selection', async () => {
      const row = await fx.db.libLoans.insert(loan('rx-only')).returning(ln => ({ loudBook: sql<string>`upper(${ln.book!.name})` }));

      expect(row).toEqual({ loudBook: 'DUNE' });
    });

    test('an expression mixing the row\'s column, a navigation\'s column and a parameter', async () => {
      const row = await fx.db.libLoans.insert(loan('rx-mix')).returning(ln => ({
        label: sql<string>`${ln.note} || ${' @ '} || ${ln.book!.name}`,
        member: ln.member!.name,
      }));

      expect(row).toEqual({ label: 'rx-mix @ Dune', member: 'Cy' });
    });

    test('two paths to one relation name each read their own row', async () => {
      // The loan's own book is Dune; its edition E-1 is an edition of Emma
      const row = await fx.db.libLoans.insert(loan('rx-paths')).returning(ln => ({
        direct: sql<string>`upper(${ln.book!.name})`,
        viaEdition: sql<string>`upper(${ln.edition!.book!.name})`,
        plain: ln.edition!.book!.name,
      }));

      expect(row).toEqual({ direct: 'DUNE', viaEdition: 'EMMA', plain: 'Emma' });
    });

    test('update and delete: expressions over navigations', async () => {
      await fx.db.libLoans.insertBulk([loan('rx-ud1'), loan('rx-ud2', { bookId: fx.ids.emma })]);

      const updated = await fx.db.libLoans
        .where(ln => like(ln.note, 'rx-ud%'))
        .update({ note: 'rx-ud' })
        .returning(ln => ({ id: ln.id, title: sql<string>`lower(${ln.book!.name})` }));
      expect(updated.map(r => r.title).sort()).toEqual(['dune', 'emma']);

      const deleted = await fx.db.libLoans
        .where(ln => eq(ln.note, 'rx-ud'))
        .delete()
        .returning(ln => ({ title: sql<string>`${ln.book!.name} || ${'#'}` }));
      expect(deleted.map(r => r.title).sort()).toEqual(['Dune#', 'Emma#']);
    });

    test('a WHERE reading a navigation next to a navigation RETURNING', async () => {
      await fx.db.libLoans.insertBulk([loan('rx-wn1'), loan('rx-wn2', { bookId: fx.ids.emma })]);

      // The WHERE joins lib_books into the UPDATE / DELETE itself; the returned "id" was ambiguous
      const updated = await fx.db.libLoans
        .where(ln => and(eq(ln.book!.name, 'Dune'), like(ln.note, 'rx-wn%')))
        .update({ note: 'rx-wn-dune' })
        .returning(ln => ({ id: ln.id, book: ln.book!.name }));
      expect(updated).toEqual([{ id: expect.any(Number), book: 'Dune' }]);

      const deleted = await fx.db.libLoans
        .where(ln => and(eq(ln.book!.name, 'Emma'), like(ln.note, 'rx-wn%')))
        .delete()
        .returning(ln => ({ id: ln.id, book: ln.book!.name, loud: sql<string>`upper(${ln.book!.name})` }));
      expect(deleted).toEqual([{ id: expect.any(Number), book: 'Emma', loud: 'EMMA' }]);
    });

    test('bulkUpdate: navigations, expressions over them and collections', async () => {
      const [inserted] = await fx.db.libLoans.insertBulk([loan('rx-bn', { memberId: fx.ids.ada })]).returning(ln => ({ id: ln.id }));
      fx.resetCapture();

      const rows = await fx.db.libLoans.bulkUpdate([{ id: inserted.id, note: 'rx-bn2' }] as any).returning(ln => ({
        id: ln.id,
        book: ln.book!.name,
        loudMember: sql<string>`upper(${ln.member!.name})`,
        memberLoans: (ln.member as any).loans.count(),
      }));

      // Ada has the two seeded loans and this one
      expect(rows).toEqual([{ id: inserted.id, book: 'Dune', loudMember: 'ADA', memberLoans: 3 }]);
      // The updated row's columns ride the CTE under the UPDATE's alias
      expect(fx.lastStatement('__mutation__').replace(/\s+/g, ' ')).toContain('RETURNING t."id"');
    });

    test('mergeBulk: an expression over a navigation', async () => {
      const rows = await fx.db.libLoans
        .mergeBulk([loan('rx-mn', { bookId: fx.ids.emma })], { on: ['memberId', 'note'] })
        .returning(ln => ({ note: ln.note, book: sql<string>`lower(${ln.book!.name})` }));

      expect(rows).toEqual([{ note: 'rx-mn', book: 'emma' }]);
    });
  });

  describe('composed inserts', () => {
    test('insertWithChildren: expressions, literals and navigation expressions of the children', async () => {
      const result = await fx.db.libMembers.insertWithChildren({
        row: { name: 'rx-parent', favoriteBookId: fx.ids.emma },
        children: {
          table: fx.db.libLoans,
          foreignKey: 'memberId',
          rows: [
            { editionId: fx.ids.e2, bookId: fx.ids.dune, note: 'rx-child-1' },
            { editionId: fx.ids.e3, bookId: fx.ids.emma, note: 'rx-child-2' },
          ],
        },
        returning: {
          parent: m => ({ id: m.id, name: m.name, shout: sql<string>`upper(${m.name})`, kind: 'parent' }),
          children: ln => ({ id: ln.id, loud: sql<string>`upper(${ln.note})`, kind: 'child', book: sql<string>`lower(${ln.book!.name})` }),
        },
      });

      expect(result.parent).toEqual({ id: expect.any(Number), name: 'rx-parent', shout: 'RX-PARENT', kind: 'parent' });
      expect(result.children).toEqual([
        { id: expect.any(Number), loud: 'RX-CHILD-1', kind: 'child', book: 'dune' },
        { id: expect.any(Number), loud: 'RX-CHILD-2', kind: 'child', book: 'emma' },
      ]);
    });

    test('insertWithChildren: children returning their own columns, expressions and literals only', async () => {
      const result = await fx.db.libMembers.insertWithChildren({
        row: { name: 'rx-parent-2', favoriteBookId: null },
        children: {
          table: fx.db.libLoans,
          foreignKey: 'memberId',
          rows: [{ editionId: fx.ids.e2, bookId: fx.ids.dune, note: 'rx-child-3' }],
        },
        returning: {
          parent: m => ({ id: m.id }),
          children: ln => ({ note: ln.note, tagged: sql<string>`${ln.note} || ${'+'}`, n: 7 }),
        },
      });

      expect(result.children).toEqual([{ note: 'rx-child-3', tagged: 'rx-child-3+', n: 7 }]);
    });

    test('insertBulkWithChildren: children selectors return one value each', async () => {
      const result = await fx.db.libMembers.insertBulkWithChildren({
        rows: [{ name: 'rx-bp-1', favoriteBookId: null }, { name: 'rx-bp-2', favoriteBookId: null }],
        children: {
          table: fx.db.libLoans,
          foreignKey: 'memberId',
          rows: [
            { parentIndex: 0, row: { editionId: fx.ids.e2, bookId: fx.ids.dune, note: 'rx-bc-1' } },
            { parentIndex: 1, row: { editionId: fx.ids.e3, bookId: fx.ids.emma, note: 'rx-bc-2' } },
          ],
        },
        returning: {
          parents: m => ({ name: m.name }),
          children: ln => sql<string>`upper(${ln.note})`,
        },
      });

      expect(result.parents).toEqual([{ name: 'rx-bp-1' }, { name: 'rx-bp-2' }]);
      expect(result.children).toEqual(['RX-BC-1', 'RX-BC-2']);
    });
  });

  describe('toStatement()', () => {
    test('a literal of the RETURNING binds as a parameter of the compiled statement', () => {
      const compiled = fx.db.libLoans
        .where(ln => eq(ln.note, 'rx-t'))
        .update({ note: 'rx-t2' })
        .toStatement(ln => ({ id: ln.id, kind: 'moved', loud: sql<string>`upper(${ln.note})` }));

      expect(compiled.sql.replace(/\s+/g, ' ')).toContain('RETURNING "id" AS "id", $3 AS "kind", upper("note") AS "loud"');
      expect(compiled.params).toEqual(['rx-t2', 'rx-t', 'moved']);
    });

    test('a selector returning one value, or reading a navigation, is refused', () => {
      const update = () => fx.db.libLoans.where(ln => eq(ln.note, 'rx-t')).update({ note: 'rx-t2' });
      const del = () => fx.db.libLoans.where(ln => eq(ln.note, 'rx-t')).delete();

      expect(() => update().toStatement(ln => ln.id)).toThrow(/must return an object/);
      expect(() => del().toStatement(ln => ln.id)).toThrow(/must return an object/);
      expect(() => update().toStatement(ln => ({ id: ln.id, book: ln.book!.name }))).toThrow(/navigation RETURNING is not supported in compiled UPDATE/);
      expect(() => del().toStatement(ln => ({ book: sql<string>`upper(${ln.book!.name})` }))).toThrow(/navigation RETURNING is not supported in compiled DELETE/);
    });
  });
});

/** `inArray` over plain ids (the where lambda's column is typed as its value). */
function inIds(column: unknown, ids: number[]) {
  return sql<boolean>`${column} = ANY(${sql.raw(`ARRAY[${ids.map(Number).join(', ')}]::int[]`)})`;
}
