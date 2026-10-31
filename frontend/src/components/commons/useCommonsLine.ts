import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { failureMessage, notConnectedBecause, RequestFailedError } from '../../lib/errorCopy';
import { clearSetterOnPromote, isPersonRefusal, retryOnPromote } from '../../lib/clearsOnPromote';

/** The heading the request itself carries (lib/commonsApi: each call names itself). */
const requestHeading = (error: unknown) => (error instanceof RequestFailedError ? error.heading : '');

interface Options {
  /** A load: on the promote it runs again (once), so the screen comes back as it normally reads. */
  reload?: boolean;
}

/**
 * Every Commons screen's failure line (PR #204 round 9). A Commons call refused only because this
 * tab isn't connected as the person (lib/commonsApi sessionLost: a `person_required` refusal under
 * the call's own heading) puts up a because line; when the tab is promoted, the line clears
 * (lib/clearsOnPromote), and a load runs again, so its references, status or review load. Any
 * other failure's line stays, as before.
 *
 * `setLine` is the screen's line state and `empty` its empty value. `reloadKey` and `reload` name
 * the screen's load and how to run it again (one retry per key, lib/clearsOnPromote).
 *
 * - `show(error, heading)`: the line for a failure: a refusal for this tab in the because form
 *   (notConnectedBecause, under the request's own words), anything else under `heading`
 *   (failureMessage). With `{ reload: true }` a refused load runs again on the promote.
 * - `keep(error, line)`: a line the screen worded itself from the failure (a label write's).
 *
 * The status poll and the review's refresh fail every few seconds while the tab waits; a line
 * already waiting for the promote isn't registered again.
 *
 * `rank` (round 13, review 10 NIT-2): for a pane whose loads all fail at once on a tab that
 * isn't connected as you, which line it shows by that state, not by which refusal lands last: a
 * new line doesn't replace one of a lower rank (0 first; -1 for a line outside the order).
 *
 * tests/clearsOnPromote.ratchet.test.ts ties both markers here to the Commons; a Commons screen
 * that sets a failure line some other way fails tests/presenceRound9.commons.test.tsx (structural).
 */
export function useCommonsLine<T extends string | null>(
  setLine: Dispatch<SetStateAction<T>>, empty: NoInfer<T>, reloadKey?: string, reload?: () => void,
  rank?: (line: T) => number,
) {
  // Puts a new line up; with `rank`, not over one that ranks before it (an update passes through).
  const showLine = useCallback((line: T) => {
    if (!rank) setLine(line);
    else setLine((current) => (rank(current) >= 0 && rank(line) > rank(current) ? current : line));
  }, [setLine, rank]);
  /** The lines already waiting for the promote (the sweep empties it). */
  const pending = useRef(new Set<T>());
  const register = useCallback((error: unknown, line: T) => {
    if (pending.current.has(line)) return;
    const set = (update: (current: T) => T) => { pending.current.delete(line); setLine(update); };
    if (clearSetterOnPromote(error, set, line, empty)) pending.current.add(line); // clears-on-promote: commons.line
  }, [setLine, empty]);
  const keep = useCallback((error: unknown, line: T) => {
    setLine(line);
    register(error, line);
  }, [setLine, register]);
  const show = useCallback((error: unknown, heading: string, options: Options = {}) => {
    // A refusal says why in the because form (GM r6 (2), r12 (2)), under the request's own words
    // ("Couldn’t load the references." gives "Nebula couldn’t load the references because …").
    const what = /^Couldn['’]t (.+)\.$/.exec(requestHeading(error) || heading)?.[1];
    const line = (isPersonRefusal(error) && what ? notConnectedBecause(what) : failureMessage(error, heading)) as T;
    showLine(line);
    register(error, line);
    if (options.reload && reloadKey && reload) retryOnPromote(error, reloadKey, reload); // clears-on-promote: commons.reload-retry
  }, [showLine, register, reloadKey, reload]);
  return useMemo(() => ({ show, keep }), [show, keep]);
}

/** A load's epoch: a dependency of the load's effect, bumped to run it again (on the promote). */
export function useReloadEpoch(): [number, () => void] {
  const [epoch, setEpoch] = useState(0);
  const again = useCallback(() => setEpoch((value) => value + 1), []);
  return [epoch, again];
}
