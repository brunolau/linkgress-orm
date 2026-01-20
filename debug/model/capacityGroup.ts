import { DbColumn, DbEntity } from "../../src";

/**
 * CapacityGroup entity - for testing nested collections
 */
export class CapacityGroup extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
}
