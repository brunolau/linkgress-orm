import { PgError, SqlState } from '../../errors';
import {
  constructRange,
  lowerBound,
  makeMultirange,
  makeRange,
  multirangeCmp,
  multirangeContainsElem,
  multirangeContainsMultirange,
  multirangeContainsRange,
  multirangeOverlapsMultirange,
  multirangeOverlapsRange,
  multirangeSpan,
  multirangeTypeInfo,
  PgMultirange,
  PgRange,
  rangeAdjacent,
  rangeAfter,
  rangeBefore,
  rangeCmp,
  rangeCmpBounds,
  rangeContains,
  rangeContainsElem,
  rangeEq,
  rangeIntersect,
  rangeMinus,
  rangeOverlaps,
  rangeOverleft,
  rangeOverright,
  rangeTypeInfo,
  rangeUnion,
  upperBound,
} from '../../types/range';
import { AggImpl, FnImpl } from '../runtime';

/** Built-in range / multirange functions and operators, keyed by prosrc. */

const R = (v: unknown) => v as PgRange;
const M = (v: unknown) => v as PgMultirange;

/** A range with the parts of `r` outside `sub` (range_minus without the contiguity requirement). */
function rangeSubtract(r: PgRange, sub: PgRange): PgRange[] {
  if (r.empty) {
    return [];
  }
  if (sub.empty || !rangeOverlaps(r, sub)) {
    return [r];
  }
  const subtype = rangeTypeInfo(r.typeOid)!.subtype;
  const out: PgRange[] = [];
  if (rangeCmpBounds(subtype, lowerBound(r), lowerBound(sub)) < 0) {
    const l2 = lowerBound(sub);
    out.push(makeRange(r.typeOid, lowerBound(r), { ...l2, inclusive: !l2.inclusive, lower: false }, false));
  }
  if (rangeCmpBounds(subtype, upperBound(r), upperBound(sub)) > 0) {
    const u2 = upperBound(sub);
    out.push(makeRange(r.typeOid, { ...u2, inclusive: !u2.inclusive, lower: true }, upperBound(r), false));
  }
  return out.filter((x) => !x.empty);
}

function multirangeMinus(a: PgMultirange, b: PgMultirange): PgMultirange {
  let pieces = a.ranges;
  for (const sub of b.ranges) {
    pieces = pieces.flatMap((p) => rangeSubtract(p, sub));
  }
  return makeMultirange(a.typeOid, pieces);
}

function multirangeIntersect(a: PgMultirange, b: PgMultirange): PgMultirange {
  const out: PgRange[] = [];
  for (const x of a.ranges) {
    for (const y of b.ranges) {
      const r = rangeIntersect(x, y);
      if (!r.empty) {
        out.push(r);
      }
    }
  }
  return makeMultirange(a.typeOid, out);
}

const first = (m: PgMultirange) => m.ranges[0];
const last = (m: PgMultirange) => m.ranges[m.ranges.length - 1];
const asMultirange = (typeOid: number, r: PgRange) => new PgMultirange(typeOid, r.empty ? [] : [r]);

function multirangeOfRangeType(rangeOid: number): number {
  const info = rangeTypeInfo(rangeOid);
  if (!info) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `in-memory engine: range type ${rangeOid} is not supported`);
  }
  return info.multirangeOid;
}

export const RANGE_FUNCS: Record<string, FnImpl> = {
  range_constructor2: (a, fc) => constructRange(fc.resultType, a[0], a[1], undefined),
  range_constructor3: (a, fc) => constructRange(fc.resultType, a[0], a[1], a[2] as string | null),
  range_lower: (a) => (R(a[0]).empty || R(a[0]).lowerInf ? null : R(a[0]).lower),
  range_upper: (a) => (R(a[0]).empty || R(a[0]).upperInf ? null : R(a[0]).upper),
  range_empty: (a) => R(a[0]).empty,
  range_lower_inc: (a) => R(a[0]).lowerInc,
  range_upper_inc: (a) => R(a[0]).upperInc,
  range_lower_inf: (a) => R(a[0]).lowerInf,
  range_upper_inf: (a) => R(a[0]).upperInf,
  range_eq: (a) => rangeEq(R(a[0]), R(a[1])),
  range_ne: (a) => !rangeEq(R(a[0]), R(a[1])),
  range_lt: (a) => rangeCmp(R(a[0]), R(a[1])) < 0,
  range_le: (a) => rangeCmp(R(a[0]), R(a[1])) <= 0,
  range_gt: (a) => rangeCmp(R(a[0]), R(a[1])) > 0,
  range_ge: (a) => rangeCmp(R(a[0]), R(a[1])) >= 0,
  range_cmp: (a) => Math.sign(rangeCmp(R(a[0]), R(a[1]))),
  range_contains_elem: (a) => rangeContainsElem(R(a[0]), a[1]),
  elem_contained_by_range: (a) => rangeContainsElem(R(a[1]), a[0]),
  range_contains: (a) => rangeContains(R(a[0]), R(a[1])),
  range_contained_by: (a) => rangeContains(R(a[1]), R(a[0])),
  range_overlaps: (a) => rangeOverlaps(R(a[0]), R(a[1])),
  range_before: (a) => rangeBefore(R(a[0]), R(a[1])),
  range_after: (a) => rangeAfter(R(a[0]), R(a[1])),
  range_overleft: (a) => rangeOverleft(R(a[0]), R(a[1])),
  range_overright: (a) => rangeOverright(R(a[0]), R(a[1])),
  range_adjacent: (a) => rangeAdjacent(R(a[0]), R(a[1])),
  range_union: (a) => rangeUnion(R(a[0]), R(a[1]), true),
  range_merge: (a) => rangeUnion(R(a[0]), R(a[1]), false),
  range_intersect: (a) => rangeIntersect(R(a[0]), R(a[1])),
  range_minus: (a) => rangeMinus(R(a[0]), R(a[1])),

  multirange_constructor0: (_a, fc) => new PgMultirange(fc.resultType, []),
  multirange_constructor1: (a, fc) => makeMultirange(fc.resultType, [R(a[0])]),
  multirange_constructor2: (a, fc) => {
    const ranges = (a[0] as unknown[] | null) ?? [];
    if (ranges.some((r) => r === null)) {
      throw new PgError(SqlState.NULL_VALUE_NOT_ALLOWED, 'multirange values cannot contain null members');
    }
    return makeMultirange(fc.resultType, ranges as PgRange[]);
  },
  multirange_eq: (a) => multirangeCmp(M(a[0]), M(a[1])) === 0,
  multirange_ne: (a) => multirangeCmp(M(a[0]), M(a[1])) !== 0,
  multirange_lt: (a) => multirangeCmp(M(a[0]), M(a[1])) < 0,
  multirange_le: (a) => multirangeCmp(M(a[0]), M(a[1])) <= 0,
  multirange_gt: (a) => multirangeCmp(M(a[0]), M(a[1])) > 0,
  multirange_ge: (a) => multirangeCmp(M(a[0]), M(a[1])) >= 0,
  multirange_cmp: (a) => Math.sign(multirangeCmp(M(a[0]), M(a[1]))),
  multirange_empty: (a) => M(a[0]).ranges.length === 0,
  multirange_lower: (a) => (M(a[0]).ranges.length === 0 || first(M(a[0])).lowerInf ? null : first(M(a[0])).lower),
  multirange_upper: (a) => (M(a[0]).ranges.length === 0 || last(M(a[0])).upperInf ? null : last(M(a[0])).upper),
  multirange_lower_inc: (a) => M(a[0]).ranges.length > 0 && first(M(a[0])).lowerInc,
  multirange_upper_inc: (a) => M(a[0]).ranges.length > 0 && last(M(a[0])).upperInc,
  multirange_lower_inf: (a) => M(a[0]).ranges.length > 0 && first(M(a[0])).lowerInf,
  multirange_upper_inf: (a) => M(a[0]).ranges.length > 0 && last(M(a[0])).upperInf,
  multirange_contains_elem: (a) => multirangeContainsElem(M(a[0]), a[1]),
  elem_contained_by_multirange: (a) => multirangeContainsElem(M(a[1]), a[0]),
  multirange_contains_range: (a) => multirangeContainsRange(M(a[0]), R(a[1])),
  range_contained_by_multirange: (a) => multirangeContainsRange(M(a[1]), R(a[0])),
  range_contains_multirange: (a) => M(a[1]).ranges.every((x) => rangeContains(R(a[0]), x)),
  multirange_contained_by_range: (a) => M(a[0]).ranges.every((x) => rangeContains(R(a[1]), x)),
  multirange_contains_multirange: (a) => multirangeContainsMultirange(M(a[0]), M(a[1])),
  multirange_contained_by_multirange: (a) => multirangeContainsMultirange(M(a[1]), M(a[0])),
  multirange_overlaps_range: (a) => multirangeOverlapsRange(M(a[0]), R(a[1])),
  range_overlaps_multirange: (a) => multirangeOverlapsRange(M(a[1]), R(a[0])),
  multirange_overlaps_multirange: (a) => multirangeOverlapsMultirange(M(a[0]), M(a[1])),
  multirange_overleft_multirange: (a) => M(a[0]).ranges.length > 0 && M(a[1]).ranges.length > 0 && rangeOverleft(last(M(a[0])), last(M(a[1]))),
  multirange_overleft_range: (a) => M(a[0]).ranges.length > 0 && rangeOverleft(last(M(a[0])), R(a[1])),
  range_overleft_multirange: (a) => M(a[1]).ranges.length > 0 && rangeOverleft(R(a[0]), last(M(a[1]))),
  multirange_overright_multirange: (a) => M(a[0]).ranges.length > 0 && M(a[1]).ranges.length > 0 && rangeOverright(first(M(a[0])), first(M(a[1]))),
  multirange_overright_range: (a) => M(a[0]).ranges.length > 0 && rangeOverright(first(M(a[0])), R(a[1])),
  range_overright_multirange: (a) => M(a[1]).ranges.length > 0 && rangeOverright(R(a[0]), first(M(a[1]))),
  multirange_before_multirange: (a) => M(a[0]).ranges.length > 0 && M(a[1]).ranges.length > 0 && rangeBefore(last(M(a[0])), first(M(a[1]))),
  multirange_after_multirange: (a) => M(a[0]).ranges.length > 0 && M(a[1]).ranges.length > 0 && rangeAfter(first(M(a[0])), last(M(a[1]))),
  multirange_before_range: (a) => M(a[0]).ranges.length > 0 && rangeBefore(last(M(a[0])), R(a[1])),
  multirange_after_range: (a) => M(a[0]).ranges.length > 0 && rangeAfter(first(M(a[0])), R(a[1])),
  range_before_multirange: (a) => M(a[1]).ranges.length > 0 && rangeBefore(R(a[0]), first(M(a[1]))),
  range_after_multirange: (a) => M(a[1]).ranges.length > 0 && rangeAfter(R(a[0]), last(M(a[1]))),
  multirange_adjacent_multirange: (a) =>
    M(a[0]).ranges.length > 0 && M(a[1]).ranges.length > 0 && (rangeAdjacent(last(M(a[0])), first(M(a[1]))) || rangeAdjacent(first(M(a[0])), last(M(a[1])))),
  multirange_adjacent_range: (a) => M(a[0]).ranges.length > 0 && (rangeAdjacent(last(M(a[0])), R(a[1])) || rangeAdjacent(first(M(a[0])), R(a[1]))),
  range_adjacent_multirange: (a) => M(a[1]).ranges.length > 0 && (rangeAdjacent(R(a[0]), first(M(a[1]))) || rangeAdjacent(R(a[0]), last(M(a[1])))),
  range_merge_from_multirange: (a) => multirangeSpan(M(a[0])),
  multirange_union: (a) => makeMultirange(M(a[0]).typeOid, [...M(a[0]).ranges, ...M(a[1]).ranges]),
  multirange_minus: (a) => multirangeMinus(M(a[0]), M(a[1])),
  multirange_intersect: (a) => multirangeIntersect(M(a[0]), M(a[1])),
};

export const RANGE_SRFS: Record<string, FnImpl> = {
  multirange_unnest: (a) => M(a[0]).ranges.slice(),
};

/**
 * range_agg (range or multirange input → multirange; NULL inputs are skipped, but a group of only NULLs
 * still yields an empty multirange) and range_intersect_agg (strict; the intersection of the inputs).
 */
export function rangeAggregate(name: 'range_agg' | 'range_intersect_agg', argType: number, resultType: number): AggImpl {
  const multiInput = multirangeTypeInfo(argType) !== undefined;
  if (name === 'range_agg') {
    return {
      strict: false,
      init: () => ({ seen: false, ranges: [] as PgRange[] }),
      step: (s, a) => {
        const st = s as { seen: boolean; ranges: PgRange[] };
        st.seen = true;
        if (a[0] !== null && a[0] !== undefined) {
          if (multiInput) {
            st.ranges.push(...M(a[0]).ranges);
          } else {
            st.ranges.push(R(a[0]));
          }
        }
        return st;
      },
      final: (s) => {
        const st = s as { seen: boolean; ranges: PgRange[] };
        return st.seen ? makeMultirange(resultType, st.ranges) : null;
      },
    };
  }
  return {
    init: () => undefined,
    step: (s, a) => {
      if (s === undefined) {
        return a[0];
      }
      return multiInput ? multirangeIntersect(M(s), M(a[0])) : rangeIntersect(R(s), R(a[0]));
    },
    final: (s) => (s === undefined ? null : s),
  };
}

export { asMultirange, multirangeOfRangeType };
