import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * PR #204 round 14 (review 11 lock-look-ui NIT-1, GM r17 item 1: one line per group): the Settings
 * groups whose lock line is on screen whenever their lock shows it, by the lock's verb, with the
 * line's id. A group registers while it would render its line (ProvidersTab: while any provider
 * row is listed), whether or not the tab is locked right now. A control of the same group
 * elsewhere in the panel (the key-added Undo) reads it while rendering: on a demote both locks
 * flip in the same render, so Undo knows there is a group line before anything is committed and
 * never puts a second copy in the notice's live region. Nothing here reads the page.
 */
const lines = new Map<string, string[]>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The group line's id for `verb`, or null when no group that renders it is on screen. */
export function groupLockLineId(verb: string): string | null {
  return lines.get(verb)?.[0] ?? null;
}

/** Registers a group's lock line (its PersonLock id) for `verb` while `present`. */
export function useGroupLockLine(verb: string, id: string, present: boolean): void {
  useLayoutEffect(() => {
    if (!present) return undefined;
    lines.set(verb, [...(lines.get(verb) ?? []), id]);
    changed();
    return () => {
      const rest = (lines.get(verb) ?? []).filter((other) => other !== id);
      if (rest.length) lines.set(verb, rest); else lines.delete(verb);
      changed();
    };
  }, [verb, id, present]);
}

/** The group line's id for `verb` (groupLockLineId), kept current. */
export function useGroupLockLineId(verb: string): string | null {
  return useSyncExternalStore(subscribe, () => groupLockLineId(verb), () => null);
}
