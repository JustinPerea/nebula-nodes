import { onPersonPromoted, personGateHeld, personUnconfirmed } from './personSession';

/**
 * PR #204 round 11: person-only work the app does on its own (no click) runs only on a tab
 * connected as the person. On a held or demoted tab, or before the socket's first answer, it
 * waits and runs once on the promote. Keyed, so asking again while it waits keeps one: a tab
 * never sends a person-only request by itself only to be refused, and never retries a refusal
 * in a loop. tests/presenceRound11.heldLoad.test.tsx loads the app as a held tab and fails on
 * any automatic request the gate would refuse.
 */
const waiting = new Map<string, () => void>();
let stopListening: (() => void) | null = null;

export function whenPerson(key: string, work: () => void): void {
  if (!personUnconfirmed()) {
    waiting.delete(key);
    work();
    return;
  }
  waitForPromote(key, work);
}

/**
 * The same work, refused (403 person_required) after it went out: it waits for the next promote,
 * even if this tab reads as connected now, so a refusal is never retried in a loop. Only a
 * refusal of a request sent before a promote that has already happened (`sentBeforePromote`,
 * lib/backend) runs again at once: that promote won't come again.
 */
export function afterPersonRefusal(key: string, error: unknown, work: () => void): void {
  if ((error as { sentBeforePromote?: unknown } | null)?.sentBeforePromote === true && !personGateHeld()) {
    waiting.delete(key);
    queueMicrotask(work);
    return;
  }
  waitForPromote(key, work);
}

function waitForPromote(key: string, work: () => void): void {
  waiting.set(key, work);
  stopListening ??= onPersonPromoted(() => {
    const due = [...waiting.values()];
    waiting.clear();
    due.forEach((run) => {
      try {
        run();
      } catch (error) {
        console.error('[person] work waiting for the promote failed to start:', error);
      }
    });
  });
}

/** Whether `key` is waiting for the promote (tests). */
export function personWorkWaiting(key: string): boolean {
  return waiting.has(key);
}

export function resetPersonWorkForTests(): void {
  waiting.clear();
  stopListening?.();
  stopListening = null;
}
