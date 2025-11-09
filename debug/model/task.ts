import { DbEntity, DbColumn } from "../../src";

export class Task extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  status!: DbColumn<'pending' | 'processing' | 'completed' | 'cancelled'>;
  priority!: DbColumn<'low' | 'medium' | 'high'>;
}
