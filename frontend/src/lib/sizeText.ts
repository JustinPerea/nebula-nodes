const MIB = 1024 * 1024;

/** A size as a person line says it: MB to one decimal, GB from 1,024 MB, never a trailing ".0" ("528 MB", "1.5 GB"). */
export function sizeText(bytes: number): string {
  const mb = bytes / MIB;
  const [value, unit] = mb >= 1024 ? [mb / 1024, 'GB'] : [mb, 'MB'];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** A size and its limit for one line: `size` is null when both would read the same, so the line says "over the limit" and names only the limit. */
export function sizeAndLimit(bytes: number, limitBytes: number): { size: string | null; limit: string } {
  const size = sizeText(bytes);
  const limit = sizeText(limitBytes);
  return { size: size === limit ? null : size, limit };
}
