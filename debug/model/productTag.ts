import { DbColumn, DbEntity } from "../../src";
import type { Product } from "./product";
import type { Tag } from "./tag";

/**
 * ProductTag entity - join table linking products to tags
 * Used for testing sibling collection isolation where navigation (tag.id) is involved
 */
export class ProductTag extends DbEntity {
    productId!: DbColumn<number>;
    tagId!: DbColumn<number>;
    sortOrder!: DbColumn<number>;

    // Navigation properties
    product?: Product;
    tag?: Tag;
}
