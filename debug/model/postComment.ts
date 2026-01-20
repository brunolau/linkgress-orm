import { DbColumn, DbEntity } from "../../src";
import type { Post } from "./post";
import type { Order } from "./order";

/**
 * PostComment entity - links posts to orders (e.g., "order mentioned in post")
 * Used for testing sibling collection isolation in LATERAL joins
 */
export class PostComment extends DbEntity {
    id!: DbColumn<number>;
    postId!: DbColumn<number>;
    orderId!: DbColumn<number>;
    comment!: DbColumn<string>;

    // Navigation properties
    post?: Post;
    order?: Order;
}
