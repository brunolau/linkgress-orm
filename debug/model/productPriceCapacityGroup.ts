import { DbColumn, DbEntity } from "../../src";
import type { ProductPrice } from "./productPrice";
import type { CapacityGroup } from "./capacityGroup";

/**
 * ProductPriceCapacityGroup entity - join table for testing nested collections
 */
export class ProductPriceCapacityGroup extends DbEntity {
    productPriceId!: DbColumn<number>;
    capacityGroupId!: DbColumn<number>;

    // Navigation properties
    productPrice?: ProductPrice;
    capacityGroup?: CapacityGroup;
}
