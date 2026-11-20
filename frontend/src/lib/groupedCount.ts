// A count of things written for a person (design): grouped in the app's one written form, "1,248 nodes"
// (en-US, as written dates are, so a German system doesn't read "1.248" as a decimal). Kept free
// of imports: the first load pulls it in. Not for years, ids, versions, sizes in px, a percentage,
// a value the person typed or a raw tool value ("120s"): those read as they are.

/** The count with digit grouping: 1248 reads "1,248" whatever the system locale. A value that is not a finite number (a "∞" cap) reads as it is. */
export function groupedCount(count: number | string): string {
  return typeof count === 'number' && Number.isFinite(count) ? count.toLocaleString('en-US') : String(count);
}

/** The count and its noun, "1 node" / "1,248 nodes". `many` defaults to the noun plus "s". */
export function countNoun(count: number, one: string, many: string = `${one}s`): string {
  return `${groupedCount(count)} ${count === 1 ? one : many}`;
}
