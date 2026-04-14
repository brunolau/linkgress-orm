import { DbEntity, DbColumn } from "../../src";
import type { Order } from "./order";
import type { Post } from "./post";


export class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  age?: DbColumn<number>;
  isActive!: DbColumn<boolean>;
  createdAt!: DbColumn<Date>;
  metadata?: DbColumn<any>;
  lastActiveAt?: DbColumn<Date>; // Integer-based custom datetime (for testing deep navigation mappers)

  // Navigation properties
  posts?: Post[];
  orders?: Order[];
}