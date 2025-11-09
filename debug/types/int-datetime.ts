import { createCustomType, TypeMapper } from '../../src';

/**
 * Custom epoch for integer-based datetime
 * 2025-01-01T00:00:00Z in Unix seconds
 */
const CUSTOM_EPOCH = 1735689600;

/**
 * Custom type mapper for integer-based datetime
 * Stores as integer (seconds since custom epoch) in database
 * Converts to/from Date object in application
 */
export const pgIntDatetime: TypeMapper<Date, number> = createCustomType<{ data: Date; driverData: number }>({
  dataType: () => 'integer',

  toDriver: (value: Date | null | undefined) => {
    if (value == null) {
      return null;
    }

    // Convert Date to seconds since custom epoch
    const timestampInSeconds = Math.floor(value.getTime() / 1000);
    return timestampInSeconds - CUSTOM_EPOCH;
  },

  fromDriver: (value: number | null | undefined) => {
    if (value == null) {
      return null;
    }

    // Convert seconds since custom epoch to Date
    return new Date((value + CUSTOM_EPOCH) * 1000);
  },
});
