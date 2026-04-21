import { DbColumn, DbEntity } from "../../src";
import type { Cart } from "./cart";

export class CartItem extends DbEntity {
    id!: DbColumn<number>;
    cartId!: DbColumn<number>;
    productId!: DbColumn<number>;

    cart?: Cart;
}
