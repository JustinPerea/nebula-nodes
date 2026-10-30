import { PERSON_REQUIRED_CODE } from './errorCopy';
import { onPersonPromoted } from './personSession';

/**
 * GM, PR #204 round 3 (2026-10-30): "on promote, every line whose only
 * reason was 'this tab isn't connected as you' clears at once, wherever it
 * sits": panel lines, toasts, tooltips and notices.
 *
 * The one mechanism for it. A surface that keeps such a line (a failure the
 * person gate refused, `code: person_required`, or a notice shown because
 * the gate held) registers how to clear it here as it shows it. When the
 * server promotes this tab (personSession.notePersonPromoted), every
 * registered line goes in the same tick. A line with any other reason never
 * registers, so it stays.
 *
 * tests/clearsOnPromote.ratchet.test.ts fails when a person-gated backend
 * route's surface, or a new person-refusal check, doesn't come through here.
 * Tooltips and locks that read the gate's live state (personGateHeld, the
 * proposal bar, the held rows) need nothing: they follow the state itself.
 */

type Clear = () => void;

const sweeps = new Set<Clear>();

/** Clear this line when the tab is promoted. Returns a function that unregisters it (the line went first). */
export function clearsOnPromote(clear: Clear): () => void {
  sweeps.add(clear);
  return () => { sweeps.delete(clear); };
}

/** Whether a failure is the person gate's refusal (403 `person_required`): its only reason was this tab. */
export function isPersonRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PERSON_REQUIRED_CODE;
}

/**
 * A line a failure put on screen: when the failure was the person gate's
 * refusal, it clears on the promote, but only while it is still the line
 * there (`current()` still returns `line`), so a newer line with another
 * reason stays. Returns whether it registered.
 */
export function clearLineOnPromote<T>(error: unknown, current: () => T, line: T, clear: Clear): boolean {
  if (!isPersonRefusal(error)) return false;
  clearsOnPromote(() => { if (current() === line) clear(); });
  return true;
}

/**
 * The same for a line kept in component state (a React setter): it clears
 * through the setter, and only while the line is still `line`.
 */
export function clearSetterOnPromote<T>(error: unknown, setLine: (update: (current: T) => T) => void, line: T, empty: T): boolean {
  if (!isPersonRefusal(error)) return false;
  clearsOnPromote(() => setLine((current) => (current === line ? empty : current)));
  return true;
}

/** How many lines wait for the promote (tests). */
export function pendingPromoteClears(): number {
  return sweeps.size;
}

const retries = new Map<string, Clear>();

/**
 * GM, PR #204 round 4 (item 1): a write the gate refused only because of this tab, done
 * again once on the promote, silently (its line has cleared; a retry that fails again
 * says nothing new). `key` keeps one retry per thing: a later refusal of the same write
 * replaces the earlier one. Only for a person refusal; returns whether it registered.
 */
export function retryOnPromote(error: unknown, key: string, run: Clear): boolean {
  if (!isPersonRefusal(error)) return false;
  retries.set(key, run);
  return true;
}

/** How many writes wait for the promote to retry (tests). */
export function pendingPromoteRetries(): number {
  return retries.size;
}

function sweep(): void {
  const all = [...sweeps];
  sweeps.clear();
  for (const clear of all) {
    try {
      clear();
    } catch (error) {
      console.error('[person] a line that clears on promote failed to clear:', error);
    }
  }
  // After the lines: a retry that fails again must not find its old line still there.
  const again = [...retries.values()];
  retries.clear();
  for (const run of again) {
    try {
      run();
    } catch (error) {
      console.error('[person] a write retried on promote failed to start:', error);
    }
  }
}

if (typeof window !== 'undefined') onPersonPromoted(sweep);
