import { DbColumn, DbEntity } from "../../src";
import type { CartItem } from "./cartItem";
import type { CartDiscountCode } from "./cartDiscountCode";

export class Cart extends DbEntity {
    id!: DbColumn<number>;
    uuid!: DbColumn<string>;

    cartItems?: CartItem[];
    cartDiscountCodes?: CartDiscountCode[];
}
