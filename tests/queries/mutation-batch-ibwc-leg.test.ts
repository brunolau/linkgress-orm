import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { withDatabase, seedTestData, createFreshClient } from '../utils/test-database';
import { eq, sql } from '../../src/query/conditions';
import { MutationBatch } from '../../src/query/mutation-batch';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, smallint } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * insertBulkWithChildren as a MutationBatch LEG — `addInsertBulkWithChildren`
 * flattens the parent/ordinal/child CTE chain into sibling CTEs of the batch
 * statement, so N parents + their children can ride ONE statement together
 * with upsert/update/delete legs (the payment webhook's grand write batch).
 *
 * Same v1 guarantees as the standalone form: parents insert ORDER BY an input
 * ordinal (serial ids ascend in input order), a row_number-over-pk CTE
 * recovers each parent's input index for the child FK join; single-column
 * serial PKs, flat columns, every parent referenced by at least one child.
 *
 * `getAffectedCount` reports PARENT rows; `options.parentReturning` (prop
 * names) exposes the parent rows — input-ordinal order — via `getLegRows`
 * (raw JSON values), so callers can e.g. read back the task ids they must
 * publish to a queue after the batch commits.
 */

class MbwParent extends DbEntity {
	id!: DbColumn<number>;
	label!: DbColumn<string>;
	kind!: DbColumn<number>;
}

class MbwChild extends DbEntity {
	id!: DbColumn<number>;
	parentId!: DbColumn<number>;
	note!: DbColumn<string>;
}

class MbwTestDatabase extends DbContext {
	get mbwParents(): DbEntityTable<MbwParent> {
		return this.table(MbwParent);
	}

	get mbwChildren(): DbEntityTable<MbwChild> {
		return this.table(MbwChild);
	}

	protected override setupModel(model: DbModelConfig): void {
		model.entity(MbwParent, (entity) => {
			entity.toTable('mbw_parent_test');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mbw_parent_test_id_seq' }));
			entity.property(e => e.label).hasType(varchar('label', 60)).isRequired();
			entity.property(e => e.kind).hasType(smallint('kind')).isRequired();
		});

		model.entity(MbwChild, (entity) => {
			entity.toTable('mbw_child_test');
			entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mbw_child_test_id_seq' }));
			entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
			entity.property(e => e.note).hasType(varchar('note', 60)).isRequired();
		});
	}
}

describe('MutationBatch insertBulkWithChildren leg', () => {
	let db: MbwTestDatabase;
	let client: ReturnType<typeof createFreshClient>;

	beforeAll(async () => {
		(EntityMetadataStore as any).metadata.clear();
		client = createFreshClient();
		db = new MbwTestDatabase(client);
		await client.query('DROP TABLE IF EXISTS mbw_child_test CASCADE');
		await client.query('DROP TABLE IF EXISTS mbw_parent_test CASCADE');
		await db.getSchemaManager().ensureCreated();
	});

	afterAll(async () => {
		await client.query('DROP TABLE IF EXISTS mbw_child_test CASCADE');
		await client.query('DROP TABLE IF EXISTS mbw_parent_test CASCADE');
		await db.dispose();
	});

	test('parents + index-mapped children ride the batch, parent rows read back in input order', async () => {
		await client.query('TRUNCATE mbw_child_test, mbw_parent_test RESTART IDENTITY CASCADE');

		const batch = new MutationBatch();
		const tasks = batch.addInsertBulkWithChildren(
			db.mbwParents,
			{
				rows: [
					{ label: 'email', kind: 30 },
					{ label: 'accounting', kind: 2 },
				],
				children: {
					table: db.mbwChildren,
					foreignKey: 'parentId',
					rows: [
						{ parentIndex: 0, row: { note: 'created-email' } },
						{ parentIndex: 0, row: { note: 'final-email' } },
						{ parentIndex: 1, row: { note: 'created-accounting' } },
					],
				},
			},
			'tasks',
			{ parentReturning: ['id', 'label', 'kind'] },
		);

		const querySpy = jest.spyOn(client, 'query');

		try {
			await batch.executeBatch();

			expect(querySpy).toHaveBeenCalledTimes(1);
		} finally {
			querySpy.mockRestore();
		}

		// Count = PARENT rows.
		expect(batch.getAffectedCount(tasks!)).toBe(2);

		// Parent readback in INPUT order with ascending serial ids.
		const parents = batch.getLegRows(tasks!) as Array<{ id: number; label: string; kind: number }>;
		expect(parents.map(p => p.label)).toEqual(['email', 'accounting']);
		expect(parents[0].id).toBeLessThan(parents[1].id);

		// Children mapped to THEIR parent by index.
		const children = await db.mbwChildren.toList();
		const byNote = new Map(children.map(c => [c.note, c.parentId]));
		expect(byNote.get('created-email')).toBe(parents[0].id);
		expect(byNote.get('final-email')).toBe(parents[0].id);
		expect(byNote.get('created-accounting')).toBe(parents[1].id);
	});

	test('composes with other leg kinds in the SAME statement', async () => {
		await client.query('TRUNCATE mbw_child_test, mbw_parent_test RESTART IDENTITY CASCADE');
		const [victim] = await db.mbwParents.insertBulk([{ label: 'stale', kind: 0 }]).returning();
		await db.mbwChildren.insertBulk([{ parentId: victim.id, note: 'stale-child' }]);

		const batch = new MutationBatch();
		batch.addDeleteWhereIn(db.mbwChildren, 'parentId', [victim.id], 'clear-children');
		batch.addDeleteWhereIn(db.mbwParents, 'id', [victim.id], 'clear-parents');
		const tasks = batch.addInsertBulkWithChildren(
			db.mbwParents,
			{
				rows: [{ label: 'fresh', kind: 7 }],
				children: {
					table: db.mbwChildren,
					foreignKey: 'parentId',
					rows: [{ parentIndex: 0, row: { note: 'fresh-child' } }],
				},
			},
			'tasks',
			{ parentReturning: ['id'] },
		);

		const querySpy = jest.spyOn(client, 'query');

		try {
			await batch.executeBatch();

			expect(querySpy).toHaveBeenCalledTimes(1);
		} finally {
			querySpy.mockRestore();
		}

		expect(batch.getAffectedCount('clear-children')).toBe(1);
		expect(batch.getAffectedCount('clear-parents')).toBe(1);
		expect(batch.getAffectedCount(tasks!)).toBe(1);

		const parents = await db.mbwParents.toList();
		expect(parents.map(p => p.label)).toEqual(['fresh']);
		const children = await db.mbwChildren.toList();
		expect(children.map(c => c.note)).toEqual(['fresh-child']);
	});

	test('a child with an out-of-range parentIndex throws at registration', async () => {
		const batch = new MutationBatch();

		expect(() => batch.addInsertBulkWithChildren(
			db.mbwParents,
			{
				rows: [{ label: 'solo', kind: 1 }],
				children: {
					table: db.mbwChildren,
					foreignKey: 'parentId',
					rows: [{ parentIndex: 3, row: { note: 'orphan' } }],
				},
			},
			'bad',
		)).toThrow(/parentIndex/);
	});
});

describe('MutationBatch insertBulkWithChildren leg — shared-schema smoke', () => {
	test('rides next to an upsert leg against the standard test schema', async () => {
		await withDatabase(async (db) => {
			const { users, orders } = await seedTestData(db);

			const batch = new MutationBatch();
			const posts = batch.addInsertBulkWithChildren(
				db.posts,
				{
					rows: [{ title: 'Batched parent', content: 'body', userId: users.alice.id, views: 0, publishTime: { hour: 8, minute: 0 } }],
					children: {
						table: db.postComments,
						foreignKey: 'postId',
						rows: [{ parentIndex: 0, row: { orderId: orders.aliceOrder.id, comment: 'first!' } }],
					},
				},
				'posts',
				{ parentReturning: ['id', 'title'] },
			);
			batch.addUpsertBulk(
				db.users,
				[{ username: 'alice', email: 'alice@test.com', age: sql`(${1}::int + ${1}::int)` }],
				{ primaryKey: 'username', updateColumns: ['age'] },
				'spend',
				{ returning: ['age'] },
			);

			await batch.executeBatch();

			const parent = (batch.getLegRows(posts!)[0] as { id: number; title: string });
			expect(parent.title).toBe('Batched parent');
			expect((batch.getLegRows('spend')[0] as { age: number }).age).toBe(2);

			const comment = (await db.postComments.where(c => eq(c.postId, parent.id)).toList())[0];
			expect(comment?.comment).toBe('first!');
		});
	});
});
