import { DbColumn, DbEntity } from "../../src";
import type { User } from "./user";
import type { HourMinute } from "../types/hour-minute";

export class Post extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  subtitle?: DbColumn<string>;
  content?: DbColumn<string>;
  userId!: DbColumn<number>;
  publishedAt!: DbColumn<Date>;
  views!: DbColumn<number>;
  publishTime!: DbColumn<HourMinute>;
  customDate?: DbColumn<Date>; // Integer-based custom datetime
  category!: DbColumn<'tech' | 'lifestyle' | 'business' | 'entertainment'>;

  // Navigation property
  user?: User;
}