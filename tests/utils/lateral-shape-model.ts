import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, boolean } from '../../src';
import {
  DatabaseClient, QueryResult, PooledConnection, QueryExecutionOptions,
} from '../../src/database/database-client.interface';
import type { CollectionStrategyType } from '../../src/query/collection-strategy.interface';

/**
 * A small blog-shaped model (users → posts → comments, plus a hasOne profile) shared by the
 * query-build cache tests. Nothing here touches a database: {@link RecordingClient} records
 * the last statement and answers with no rows.
 */

export class LscUser extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  active!: DbColumn<boolean>;
  profileId!: DbColumn<number>;

  posts?: LscPost[];
  profile?: LscProfile;
}

export class LscPost extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  title!: DbColumn<string>;
  views!: DbColumn<number>;
  published!: DbColumn<boolean>;

  user?: LscUser;
  comments?: LscComment[];
}

export class LscComment extends DbEntity {
  id!: DbColumn<number>;
  postId!: DbColumn<number>;
  authorId!: DbColumn<number>;
  body!: DbColumn<string>;

  post?: LscPost;
  author?: LscUser;
}

export class LscProfile extends DbEntity {
  id!: DbColumn<number>;
  bio!: DbColumn<string>;
}

/** Records the last statement; nothing here needs a database. */
export class RecordingClient extends DatabaseClient {
  last: { sql: string; params: any[] } | null = null;

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    this.last = { sql, params: params ?? [] };

    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PooledConnection> {
    throw new Error('not needed');
  }

  async end(): Promise<void> {
    // no pool to close
  }

  getDriverName(): string {
    return 'postgres';
  }

  async transaction<T>(
    callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>
  ): Promise<T> {
    return callback((sql, params) => this.query(sql, params));
  }
}

export class LscDatabase extends DbContext {
  get lscUsers(): DbEntityTable<LscUser> {
    return this.table(LscUser);
  }

  get lscPosts(): DbEntityTable<LscPost> {
    return this.table(LscPost);
  }

  get lscComments(): DbEntityTable<LscComment> {
    return this.table(LscComment);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(LscUser, entity => {
      entity.toTable('lsc_users');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 80));
      entity.property(e => e.active).hasType(boolean('active'));
      entity.property(e => e.profileId).hasType(integer('profile_id'));

      entity.hasMany(e => e.posts, () => LscPost).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
      entity.hasOne(e => e.profile, () => LscProfile).withForeignKey(u => u.profileId).withPrincipalKey(p => p.id);
    });

    model.entity(LscPost, entity => {
      entity.toTable('lsc_posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.userId).hasType(integer('user_id'));
      entity.property(e => e.title).hasType(varchar('title', 200));
      entity.property(e => e.views).hasType(integer('views'));
      entity.property(e => e.published).hasType(boolean('published'));

      entity.hasOne(e => e.user, () => LscUser).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
      entity.hasMany(e => e.comments, () => LscComment).withForeignKey(c => c.postId).withPrincipalKey(p => p.id);
    });

    model.entity(LscComment, entity => {
      entity.toTable('lsc_comments');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.postId).hasType(integer('post_id'));
      entity.property(e => e.authorId).hasType(integer('author_id'));
      entity.property(e => e.body).hasType(varchar('body', 400));

      entity.hasOne(e => e.post, () => LscPost).withForeignKey(c => c.postId).withPrincipalKey(p => p.id);
      entity.hasOne(e => e.author, () => LscUser).withForeignKey(c => c.authorId).withPrincipalKey(u => u.id);
    });

    model.entity(LscProfile, entity => {
      entity.toTable('lsc_profiles');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.bio).hasType(varchar('bio', 400));
    });
  }
}

export const makeLscDb = (collectionStrategy: CollectionStrategyType = 'lateral') => {
  const client = new RecordingClient();

  return { client, db: new LscDatabase(client, { collectionStrategy }) };
};
