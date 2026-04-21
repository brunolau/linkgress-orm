import { DbColumn, DbEntity } from "../../src";
import type { Discount } from "./discount";

export class DiscountProduct extends DbEntity {
    discountId!: DbColumn<number>;
    productId!: DbColumn<number>;

    discount?: Discount;
}
