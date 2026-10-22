/**
 * What the person asks of a deferred piece (lib/deferredChunks.ts) before its
 * chunk has arrived. The command palette and the chat used to listen from the
 * first frame (⌘K, the rail's palette button, a node's Enhance sending to the
 * chat). Now their eager wrappers (components/DeferredPanels.tsx) listen until
 * the piece mounts and claims the intent: the latest one is held here and
 * handed over on the claim, so nothing done in that gap is lost. Once claimed,
 * the piece's own listener handles every intent and the wrapper's stands back.
 *
 * Kept in the startup entry (tests/entrySplit.test.ts, STARTUP_STATE).
 */

export type HeldIntentName = 'command-palette' | 'chat-send';

const held = new Map<HeldIntentName, unknown>();
const claimed = new Set<HeldIntentName>();

/** True while the deferred piece listens for `name` itself. */
export function isIntentClaimed(name: HeldIntentName): boolean {
  return claimed.has(name);
}

/** Hold `detail` for the piece; a later intent replaces an earlier one. */
export function holdIntent(name: HeldIntentName, detail: unknown): void {
  held.set(name, detail);
}

/** Forget a held intent the person took back (a second ⌘K before the palette arrived). */
export function dropIntent(name: HeldIntentName): void {
  held.delete(name);
}

/** The intent held for `name`, if any (it stays held). */
export function heldIntent<T = unknown>(name: HeldIntentName): T | undefined {
  return held.get(name) as T | undefined;
}

/**
 * Called by the piece in the effect that adds its own listener: from now on it
 * owns the intent. Returns what was held (handed over once) and a release for
 * the effect's cleanup.
 */
export function claimIntent<T = unknown>(name: HeldIntentName): { held: T | undefined; release: () => void } {
  claimed.add(name);
  const detail = held.get(name) as T | undefined;
  held.delete(name);
  return { held: detail, release: () => { claimed.delete(name); } };
}
