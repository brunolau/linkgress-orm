import { DbColumn, DbEntity } from "../../src";

/**
 * Tag entity - for testing sibling collection isolation
 */
export class Tag extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
}
