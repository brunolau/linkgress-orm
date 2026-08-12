import { createCustomType, TypeMapper } from '../../src';

/**
 * Timestamp column whose DRIVER value is the raw text-protocol string
 * ('YYYY-MM-DD HH:MM:SS[.ffffff]', parser passthrough) and whose application
 * value is the ISO 'T' form. Mirrors gopass-eshop's `pgTimestamp` extension
 * (string → Temporal.PlainDateTime): a custom mapper on a DECLARED-timestamp
 * column doing string surgery on the driver text. `fromDriver` tolerates a
 * Date so contexts with default (Date-parsing) drivers remain unaffected.
 */
export const pgTextTimestamp: TypeMapper<string, string> = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'timestamp',

  toDriver: (value: string | null | undefined) => {
    if (value == null) {
      return null;
    }

    return value.replace('T', ' ');
  },

  fromDriver: (value: any) => {
    if (value == null) {
      return null;
    }

    // Under a Date-parsing driver (default test contexts) pass the Date through.
    return typeof value === 'string' ? value.replace(' ', 'T') : value;
  },
});
