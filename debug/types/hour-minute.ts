import { createCustomType, TypeMapper } from '../../src';

/**
 * HourMinute type for storing time as hours and minutes
 */
export interface HourMinute {
  hour: number;
  minute: number;
}

/**
 * Custom type mapper for HourMinute
 * Stores as smallint (minutes since midnight) in database
 * Converts to/from {hour, minute} object in application
 */
export const pgHourMinute: TypeMapper<HourMinute, number> = createCustomType<{ data: HourMinute; driverData: number }>({
  dataType: () => 'smallint',

  toDriver: (value: HourMinute | null | undefined) => {
    if (value == null) {
      return null;
    }

    return (value.hour * 60) + value.minute;
  },

  fromDriver: (value: number | null | undefined) => {
    if (value == null) {
      return null;
    }

    const hour = Math.floor(value / 60);
    return {
      hour,
      minute: value % 60,
    };
  },
});
