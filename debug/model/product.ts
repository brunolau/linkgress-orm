import { DbColumn, DbEntity } from "../../src";
import type { ProductPrice } from "./productPrice";
import type { ProductTag } from "./productTag";

/**
 * Product entity - simplified version for testing sibling collection isolation
 */
export class Product extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
    active!: DbColumn<boolean>;

    // Navigation properties
    productPrices?: ProductPrice[];
    productTags?: ProductTag[];
}
