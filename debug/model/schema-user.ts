import { DbEntity, DbColumn } from "../../src";
import { SchemaPost } from "./schema-post";

export class SchemaUser extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  isActive!: DbColumn<boolean>;
  posts?: SchemaPost[];
}
