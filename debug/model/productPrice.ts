import { DbColumn, DbEntity } from "../../src";
import type { Product } from "./product";
import type { ProductPriceCapacityGroup } from "./productPriceCapacityGroup";

/**
 * ProductPrice entity - simplified version for testing sibling collection isolation
 */
export class ProductPrice extends DbEntity {
    id!: DbColumn<number>;
    productId!: DbColumn<number>;
    seasonId!: DbColumn<number>;
    price!: DbColumn<number>;

    // Navigation properties
    product?: Product;
    productPriceCapacityGroups?: ProductPriceCapacityGroup[];
}
