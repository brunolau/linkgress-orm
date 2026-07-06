import type { Migration } from '../../../src';

export default class implements Migration {
  async up(db: any): Promise<void> {
    await db.query(`CREATE TABLE "test_table_one" (id SERIAL PRIMARY KEY)`);
  }

  async down(db: any): Promise<void> {
    await db.query(`DROP TABLE "test_table_one"`);
  }
}
