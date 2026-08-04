import { DbColumn, DbEntity } from "../../src";

/**
 * RegistryItem entity — external-sync style row whose business identity
 * (`crmId`) is declared PER QUERY via `mergeBulk({ on: 'crmId', … })`.
 * Deliberately carries NO unique index at all: the mergeBulk tests prove the
 * match works purely off the statement's ON condition.
 */
export class RegistryItem extends DbEntity {
    id!: DbColumn<number>;
    crmId!: DbColumn<string>;
    name!: DbColumn<string>;
    active!: DbColumn<boolean>;
}
