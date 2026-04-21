import { DbColumn, DbEntity } from "../../src";
import type { Cart } from "./cart";
import type { DiscountCode } from "./discountCode";

export class CartDiscountCode extends DbEntity {
    cartId!: DbColumn<number>;
    discountCodeId!: DbColumn<number>;

    cart?: Cart;
    discountCode?: DiscountCode;
}
