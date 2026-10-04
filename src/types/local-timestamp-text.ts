const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

/**
 * A Date as `YYYY-MM-DDTHH:MM:SS.mmm+HH:MM` in LOCAL time — pg's formatting of a Date parameter, BC years
 * included: a `timestamp` stores its local wall time (the offset is dropped), a `timestamptz` its instant, a
 * `date` its local day. How every driver the suite runs binds a Date (PGlite's serializers, a typed rows
 * source's arrays). @internal
 */
export function toLocalTimestampText(date: Date): string {
  let year = date.getFullYear();
  const isBC = year < 1;

  if (isBC) {
    // JS year 0 is 1 BC
    year = Math.abs(year) + 1;
  }

  const offset = -date.getTimezoneOffset();
  const text =
    `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60), 2)}:${pad(Math.abs(offset) % 60, 2)}`;

  return isBC ? `${text} BC` : text;
}
