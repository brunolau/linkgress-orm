/**
 * Port of PostgreSQL's quicksort (src/include/lib/sort_template.h).
 *
 * PostgreSQL's sort is not stable; reproducing its exact algorithm makes the relative order of
 * rows with equal sort keys identical to a real server for the same input order.
 */
export function pgQsort<T>(data: T[], cmp: (a: T, b: T) => number): void {
  sortRange(data, 0, data.length, cmp);
}

function med3<T>(data: T[], a: number, b: number, c: number, cmp: (a: T, b: T) => number): number {
  return cmp(data[a], data[b]) < 0
    ? cmp(data[b], data[c]) < 0
      ? b
      : cmp(data[a], data[c]) < 0
        ? c
        : a
    : cmp(data[b], data[c]) > 0
      ? b
      : cmp(data[a], data[c]) < 0
        ? a
        : c;
}

function swap<T>(data: T[], i: number, j: number): void {
  const t = data[i];
  data[i] = data[j];
  data[j] = t;
}

function swapn<T>(data: T[], i: number, j: number, n: number): void {
  for (let k = 0; k < n; k++) {
    swap(data, i + k, j + k);
  }
}

function sortRange<T>(data: T[], a: number, n: number, cmp: (a: T, b: T) => number): void {
  for (;;) {
    if (n < 7) {
      for (let pm = a + 1; pm < a + n; pm++) {
        for (let pl = pm; pl > a && cmp(data[pl - 1], data[pl]) > 0; pl--) {
          swap(data, pl, pl - 1);
        }
      }
      return;
    }
    let presorted = true;
    for (let pm = a + 1; pm < a + n; pm++) {
      if (cmp(data[pm - 1], data[pm]) > 0) {
        presorted = false;
        break;
      }
    }
    if (presorted) {
      return;
    }
    let pm = a + Math.floor(n / 2);
    if (n > 7) {
      let pl = a;
      let pn = a + n - 1;
      if (n > 40) {
        const d = Math.floor(n / 8);
        pl = med3(data, pl, pl + d, pl + 2 * d, cmp);
        pm = med3(data, pm - d, pm, pm + d, cmp);
        pn = med3(data, pn - 2 * d, pn - d, pn, cmp);
      }
      pm = med3(data, pl, pm, pn, cmp);
    }
    swap(data, a, pm);
    let pa = a + 1;
    let pb = a + 1;
    let pc = a + n - 1;
    let pd = a + n - 1;
    let r: number;
    for (;;) {
      while (pb <= pc && (r = cmp(data[pb], data[a])) <= 0) {
        if (r === 0) {
          swap(data, pa, pb);
          pa++;
        }
        pb++;
      }
      while (pb <= pc && (r = cmp(data[pc], data[a])) >= 0) {
        if (r === 0) {
          swap(data, pc, pd);
          pd--;
        }
        pc--;
      }
      if (pb > pc) {
        break;
      }
      swap(data, pb, pc);
      pb++;
      pc--;
    }
    const pn = a + n;
    let d1 = Math.min(pa - a, pb - pa);
    swapn(data, a, pb - d1, d1);
    d1 = Math.min(pd - pc, pn - pd - 1);
    swapn(data, pb, pn - d1, d1);
    d1 = pb - pa;
    const d2 = pd - pc;
    if (d1 <= d2) {
      if (d1 > 1) {
        sortRange(data, a, d1, cmp);
      }
      if (d2 > 1) {
        a = pn - d2;
        n = d2;
        continue;
      }
      return;
    }
    if (d2 > 1) {
      sortRange(data, pn - d2, d2, cmp);
    }
    if (d1 > 1) {
      n = d1;
      continue;
    }
    return;
  }
}
