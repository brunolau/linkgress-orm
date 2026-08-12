import { DbColumn, DbEntity } from "../../src";

/**
 * One nullable column per declarable column type — the QueryBatch fidelity
 * sweep's playground. Every value stored here must come back from a batch
 * EXACTLY as the driver's native protocol would have delivered it (same value,
 * same JS type), across hostile inputs: precision-heavy numerics, padded
 * chars, escaped text, binary, nulls.
 */
export class TypeZooRow extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  vInteger?: DbColumn<number>;
  vSmallint?: DbColumn<number>;
  vBigint?: DbColumn<bigint>;
  vDecimal?: DbColumn<number>;
  vNumeric?: DbColumn<number>;
  vReal?: DbColumn<number>;
  vDouble?: DbColumn<number>;
  vBool?: DbColumn<boolean>;
  vTimestamp?: DbColumn<Date>;
  vTimestamptz?: DbColumn<Date>;
  vDate?: DbColumn<Date>;
  vTime?: DbColumn<string>;
  vUuid?: DbColumn<string>;
  vText?: DbColumn<string>;
  vVarchar?: DbColumn<string>;
  vChar?: DbColumn<string>;
  vJson?: DbColumn<any>;
  vJsonb?: DbColumn<any>;
  vBytea?: DbColumn<Uint8Array>;
}
