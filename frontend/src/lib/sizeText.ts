const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** `bytes` in tenths of `unit`, rounded half up with integer arithmetic on the bytes (no float division, so the
 * backend's twin, execution/person_line.py size_text, rounds the same value the same way). */
const tenthsOf = (bytes: number, unit: number) => Math.floor((20 * bytes + unit) / (2 * unit));

/** A size as a person line says it: MB to one decimal, GB from 1,024 MB, never a trailing ".0" ("528 MB", "1.5 GB").
 * The unit is chosen after rounding: a size that rounds to 1,024 MB reads "1 GB". */
export function sizeText(bytes: number): string {
  const whole = Math.floor(bytes + 0.5);
  const inMb = tenthsOf(whole, MIB);
  const [tenths, unit] = inMb >= 10240 ? [tenthsOf(whole, GIB), 'GB'] : [inMb, 'MB'];
  return `${tenths % 10 === 0 ? tenths / 10 : `${Math.floor(tenths / 10)}.${tenths % 10}`} ${unit}`;
}

/** A size and its limit for one line: `size` is null when both would read the same, so the line says "over the limit" and names only the limit. */
export function sizeAndLimit(bytes: number, limitBytes: number): { size: string | null; limit: string } {
  const size = sizeText(bytes);
  const limit = sizeText(limitBytes);
  return { size: size === limit ? null : size, limit };
}
