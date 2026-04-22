import { DbColumn, DbEntity } from "../../src";
import type { Discount } from "./discount";

export class DiscountCode extends DbEntity {
    id!: DbColumn<number>;
    discountId!: DbColumn<number>;

    discount?: Discount;
}
