/**
 * Keep unchanged graph items the same objects across a store update.
 *
 * React Flow re-renders a card when its node object changes, and the canvas
 * passes the store's arrays straight through, so an update that rebuilds
 * every node (a graphSync, a run starting) re-renders every card even when
 * one changed. These helpers let an update rebuild freely and then hand back
 * the previous object for each item that came out equal, and the previous
 * array when nothing changed at all.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep equality for JSON-like values: primitives, arrays and plain objects.
 * A key whose value is undefined counts as absent, as it does in JSON (the
 * store spreads `{ progress: undefined }` and the backend never sends it).
 * Anything else (a Map, a Date, a function) is equal only to itself.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  let defined = 0;
  for (const key in a) {
    const value = a[key];
    if (value === undefined) continue;
    defined += 1;
    if (!Object.prototype.hasOwnProperty.call(b, key) || !jsonEqual(value, b[key])) return false;
  }
  for (const key in b) if (b[key] !== undefined) defined -= 1;
  return defined === 0;
}

/** `items.map(fn)`, or `items` itself when `fn` returned every item unchanged. */
export function replaceChanged<T>(items: T[], fn: (item: T, index: number) => T): T[] {
  let changed = false;
  const next = items.map((item, index) => {
    const result = fn(item, index);
    if (result !== item) changed = true;
    return result;
  });
  return changed ? next : items;
}

/**
 * `next`, with each item that equals the `previous` item of the same key
 * replaced by that previous object, or `previous` itself when the two hold
 * the same items in the same order. The key defaults to the item's id.
 */
export function shareUnchanged<T extends { id: string }>(
  previous: T[], next: T[], keyOf: (item: T) => string = (item) => item.id,
): T[] {
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  let same = previous.length === next.length;
  const shared = next.map((item, index) => {
    const before = byKey.get(keyOf(item));
    const kept = before !== undefined && (before === item || jsonEqual(before, item)) ? before : item;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : shared;
}
