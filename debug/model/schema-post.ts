import { DbEntity, DbColumn } from "../../src";
import { SchemaUser } from "./schema-user";

export class SchemaPost extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;
  user?: SchemaUser;
}
