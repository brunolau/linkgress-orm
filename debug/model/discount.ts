import { DbColumn, DbEntity } from "../../src";
import type { DiscountProduct } from "./discountProduct";

export class Discount extends DbEntity {
    id!: DbColumn<number>;
    code!: DbColumn<string>;
    discountProducts?: DiscountProduct[];
}
