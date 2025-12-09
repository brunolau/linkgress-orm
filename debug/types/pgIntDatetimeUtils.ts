import { and, Condition, DbColumn, gte, lt, sql, SqlFragment } from "../../src";
import { pgIntDatetime } from "./int-datetime";

const CUSTOM_EPOCH = 1735689600;
export default class PgIntDateTimeUtils {
    static getLocalDay(
        date: DbColumn<Date> | undefined,
        timeZone: string,
        colName: string,
    ): SqlFragment<Date> {
        return sql`((${date} + EXTRACT(TIMEZONE FROM timezone('${sql.raw(timeZone)}', (to_timestamp(${date}) + INTERVAL '${sql.raw(String(CUSTOM_EPOCH))} seconds') AT TIME ZONE 'UTC'))) / 86400)`
            .mapWith((value: number) => PgIntDateTimeUtils.getLocalDayFromNumber(value))
            .as(colName);
    }

    static getLocalDayFromNumber(value: number): Date {
        if (value == null) {
            return null as any;
        }

        return pgIntDatetime.fromDriver(value * 86400) as Date;
    }

    static between(
        date: DbColumn<Date> | undefined,
        from: Date,
        to: Date,
        timeZone?: string,
    ): Condition {
        if (from != null && to == null) {
            return this.greaterThanOrEqual(
                date,
                from,
                timeZone,
            );
        } else if (from == null && to != null) {
            return this.lessThan(
                date,
                to,
                timeZone,
            );
        }

        // if (timeZone) {
        //     from = TemporalUtils.convertLocalToUtc(from, timeZone);
        //     to = TemporalUtils.convertLocalToUtc(to, timeZone);
        // }

        return and(gte(date, from), lt(date, to));
    }

    static greaterThanOrEqual(
        date: DbColumn<Date> | undefined,
        from: Date,
        timeZone?: string,
    ): Condition {
        return gte(date, from);
    }

    static lessThan(
        date: DbColumn<Date> | undefined,
        to: Date,
        timeZone?: string,
    ): Condition {
        // if (timeZone) {
        //     to = TemporalUtils.convertLocalToUtc(to, timeZone);
        // }

        return lt(date, to);
    }
}
