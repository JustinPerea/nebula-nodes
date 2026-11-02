import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { failureMessage, loadFailedLine, notConnectedBecause, RequestFailedError } from '../../lib/errorCopy';
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
 * tests/clearsOnPromote.ratchet.test.ts ties both markers here to the Commons; a Commons screen
 * that sets a failure line some other way fails tests/presenceRound9.commons.test.tsx (structural).
 */
export function useCommonsLine<T extends string | null>(
  setLine: Dispatch<SetStateAction<T>>, empty: NoInfer<T>, reloadKey?: string, reload?: () => void,
) {
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
    // Round 15 (GM r25, pane loads): a pane's load is named by the pane's own words ("load Agent
    // review", "load this reference", "load the Commons settings"), whichever of its requests
    // failed, and no answer is the because form too: "Nebula couldn’t load Agent review because
    // the server didn’t respond. Try again." (GM r31 wording)
    const what = /^Couldn['’]t (.+)\.$/.exec((options.reload ? heading : '') || requestHeading(error) || heading)?.[1];
    // Round 18b (GM r29 1): a load says every reason in the because form (loadFailedLine).
    const line = (isPersonRefusal(error) && what ? notConnectedBecause(what)
      : options.reload && what ? loadFailedLine(what, error) : failureMessage(error, heading)) as T;
    setLine(line);
    register(error, line);
    if (options.reload && reloadKey && reload) retryOnPromote(error, reloadKey, reload); // clears-on-promote: commons.reload-retry
  }, [setLine, register, reloadKey, reload]);
  return useMemo(() => ({ show, keep }), [show, keep]);
}

/** A load's epoch: a dependency of the load's effect, bumped to run it again (on the promote). */
export function useReloadEpoch(): [number, () => void] {
  const [epoch, setEpoch] = useState(0);
  const again = useCallback(() => setEpoch((value) => value + 1), []);
  return [epoch, again];
}

/** GM r22 (PR #204 round 14): the page's own words, for a line that covers every load. */
export const COMMONS_PAGE_HEADING = 'Couldn’t load Commons.';
const COMMONS_PAGE_WHAT = 'load Commons';

/** One load's failure: its own line, the page line it would share, and whether it was refused
 * only because this tab isn't connected as you. */
export interface LoadFailure { readonly line: string; readonly page: string; readonly person: boolean }

/**
 * GM r22 (PR #204 round 14): what a page's failed loads show, one rule, no ranking between loads.
 * - Refused because this tab isn't connected as you (never connected, demoted, a stale token):
 *   one line for the page, "Nebula couldn’t load the Commons because this tab isn’t connected
 *   as you. …", and never a load's own line.
 * - Two or more loads failing for the same reason: the page line with that reason.
 * - One load failing alone, or loads failing for different reasons: each load's own line, in
 *   the page's order.
 */
export function pageLoadLines(failures: readonly LoadFailure[]): string[] {
  const person = failures.find((failure) => failure.person);
  if (person) return [person.page];
  if (failures.length >= 2 && failures.every((failure) => failure.page === failures[0].page)) return [failures[0].page];
  return [...new Set(failures.map((failure) => failure.line))];
}

/** How long a load's own line waits for the page's other loads (GM r25 1): Add's wait, the same
 * 1.5 s (useLockLineHold ADD_LINE_HOLD_MS; tests/presenceRound15.loadHold pins them equal). */
export const LOAD_LINE_HOLD_MS = 1500;

const NO_LINES: string[] = [];

/**
 * A page's loads and their lines (GM r22, PR #204 round 14), so the page never sets a line
 * itself (tests/presenceRound9.commons). `order` is the page's order of its loads.
 * - `show(load, error, heading)`: that load failed. A refusal for this tab clears on the promote
 *   and the loads run again (`reload`, once per `reloadKey`), as `useCommonsLine` does.
 * - `clear(load)`: that load answered, which also ends any "not connected" line (the tab is
 *   connected now); `clear()` empties all (a new view, a reconnect).
 * - `start(load)`: that load was sent. Round 15 (GM r25 1): a failed load's own line waits until
 *   the page's other loads sent meanwhile have answered or failed, capped at LOAD_LINE_HOLD_MS,
 *   so a connected tab whose loads fail for one reason sees one line (the page line), not a
 *   load's line swapped for it. Past the cap the lines show as they stand. A not-connected
 *   refusal's page line never waits (Add's line waits on it). Once shown, lines stay while any
 *   load still fails.
 * - `lines`: what shows (pageLoadLines, after the hold).
 */
export function useCommonsLoadLines<K extends string>(order: readonly K[], reloadKey: string, reload: () => void) {
  const [failures, setFailures] = useState<Partial<Record<K, LoadFailure>>>({});
  /** The loads sent and not answered yet (start, then show or clear). */
  const [inFlight, setInFlight] = useState<ReadonlySet<K>>(() => new Set());
  const settle = useCallback((load: K) => setInFlight((current) => {
    if (!current.has(load)) return current;
    const next = new Set(current);
    next.delete(load);
    return next;
  }), []);
  const start = useCallback((load: K) => setInFlight((current) => (current.has(load) ? current : new Set(current).add(load))), []);
  /** The lines already waiting for the promote, per load (the sweep empties it). */
  const pending = useRef(new Set<string>());
  const setFailure = useCallback((load: K, line: string, page: string, person: boolean) => setFailures((current) => {
    const was = current[load];
    return was && was.line === line && was.page === page ? current : { ...current, [load]: { line, page, person } };
  }), []);
  const register = useCallback((load: K, error: unknown, line: string) => {
    const key = `${load}\n${line}`;
    if (pending.current.has(key)) return;
    const set = (update: (current: string | null) => string | null) => {
      pending.current.delete(key);
      setFailures((current) => {
        const was = current[load]?.line ?? null;
        if (update(was) === was) return current;
        const next = { ...current };
        delete next[load];
        return next;
      });
    };
    if (clearSetterOnPromote(error, set, line, null)) pending.current.add(key); // clears-on-promote: commons.load-lines
  }, []);
  const show = useCallback((load: K, error: unknown, heading: string) => {
    // A refusal says why in the because form, under the request's own words; the page line
    // under the page's (GM r22).
    const what = /^Couldn['’]t (.+)\.$/.exec(requestHeading(error) || heading)?.[1];
    // Round 15 (GM r24 c): no answer's reason is the because form too, one sentence for one cause.
    // Round 18b (GM r29 1): and every other reason too (loadFailedLine).
    const line = isPersonRefusal(error) && what ? notConnectedBecause(what)
      : what ? loadFailedLine(what, error) : failureMessage(error, heading);
    // The page's own words over the failure's reason (the request names only itself).
    const page = isPersonRefusal(error) ? notConnectedBecause('load Commons')
      : loadFailedLine(COMMONS_PAGE_WHAT, error) || line;
    setFailure(load, line, page, isPersonRefusal(error));
    settle(load);
    register(load, error, line);
    retryOnPromote(error, reloadKey, reload); // clears-on-promote: commons.load-lines-retry
  }, [setFailure, settle, register, reloadKey, reload]);
  const clear = useCallback((load?: K) => { if (load !== undefined) settle(load); setFailures((current) => {
    // A load that answered also ends every "not connected" line: the tab is connected now.
    const kept = Object.entries(current).filter(([key, failure]) => load !== undefined && key !== load
      && !(failure as LoadFailure).person);
    return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept) as Partial<Record<K, LoadFailure>>;
  }); }, [settle]);
  const all = useMemo(() => pageLoadLines(order.flatMap((load) => failures[load] ?? [])), [order, failures]);
  // GM r25 1: hold the lines while another load is still on its way, up to the cap.
  const any = all.length > 0;
  const othersOnTheWay = order.some((load) => inFlight.has(load) && !failures[load]);
  const ready = any && (Object.values(failures).some((failure) => (failure as LoadFailure).person) || !othersOnTheWay);
  const [open, setOpen] = useState(false);
  if (!any && open) setOpen(false);
  else if (ready && !open) setOpen(true);
  const holding = any && !open && !ready;
  useEffect(() => {
    if (!holding) return undefined;
    const timer = window.setTimeout(() => setOpen(true), LOAD_LINE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  const lines = any && (open || ready) ? all : NO_LINES;
  // Round 17 (review 13 LOW-1): a load cancelled before it answered (a search the person left for
  // Settings) will never answer, so it is no longer on its way: later lines don't wait for it.
  return useMemo(() => ({ show, clear, start, abandon: settle, lines }), [show, clear, start, settle, lines]);
}
