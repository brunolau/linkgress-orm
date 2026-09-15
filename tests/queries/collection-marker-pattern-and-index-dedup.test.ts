import { describe, expect, test } from 'bun:test';
import { DbContext, DbEntity, DbColumn, DbModelConfig, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { collectionMarkerPattern } from '../../src/query/query-utils';

describe('collectionMarkerPattern', () => {
	test('returns one RegExp per (table, form) and rewrites exactly like the inline pattern', () => {
		const dotted = collectionMarkerPattern('posts', true);
		expect(collectionMarkerPattern('posts', true)).toBe(dotted);
		expect(collectionMarkerPattern('posts', false)).not.toBe(dotted);

		const expression = '"__collection_posts__"."title" = "__collection_posts__"."body"';
		expect(expression.replace(dotted, '"lateral_0_posts".')).toBe('"lateral_0_posts"."title" = "lateral_0_posts"."body"');
		expect(expression.replace(collectionMarkerPattern('posts', false), '"posts"')).toBe('"posts"."title" = "posts"."body"');
		// Repeated use of the cached global RegExp must not leak `lastIndex` state
		expect(expression.replace(dotted, 'X.')).toBe(expression.replace(dotted, 'X.'));
	});
});

describe('hasIndex de-duplicates by name', () => {
	class DedupItem extends DbEntity {
		id!: DbColumn<number>;
		email!: DbColumn<string>;
		name!: DbColumn<string>;
	}

	class DedupDb extends DbContext {
		protected override setupModel(model: DbModelConfig): void {
			model.entity(DedupItem, entity => {
				entity.toTable('dedup_items');
				entity.property(e => e.id).hasType(integer('id').primaryKey());
				entity.property(e => e.email).hasType(varchar('email', 200));
				entity.property(e => e.name).hasType(varchar('name', 200));
				// Registered twice on purpose (a host that builds its model twice does this)
				entity.hasIndex('ix_dedup_email', e => [e.email]);
				entity.hasIndex('ix_dedup_email', e => [e.email, e.name]);
			});
		}
	}

	test('a repeated registration replaces the earlier entry instead of appending', () => {
		(EntityMetadataStore as any).metadata.clear();
		new DedupDb({ query: async () => ({ rows: [], rowCount: 0 }) } as any);
		const metadata = EntityMetadataStore.getOrCreateMetadata(DedupItem);
		const named = metadata.indexes.filter(index => index.name === 'ix_dedup_email');
		expect(named).toHaveLength(1);
		expect(named[0].columns).toEqual(['email', 'name']);
	});
});
