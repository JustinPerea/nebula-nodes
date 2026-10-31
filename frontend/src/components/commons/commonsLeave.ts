import { useEffect, useState, type RefObject } from 'react';
import { setCommonsLeaveAsk, whenCommonsClean } from '../../lib/commonsUnsaved';
import { CommonsRequestError } from '../../lib/commonsRequestError';
import { canTryAgain, failureCopy, oneLine } from '../../lib/errorCopy';

/**
 * Leaving the Commons with unsaved labels (commons-leave, GM - Design,
 * 2026-10-22). Moving between the Commons' sections isn't leaving: CommonsView
 * keeps Blind labeling and Agent review mounted once opened, so their drafts
 * live as long as the Commons does. The real exits (its Back, Projects, the
 * browser's Back or a hash change, the Updates corner's Show, See all and
 * Review) ask first in a small popover anchored to what was clicked: Save and
 * leave, Discard and leave, Stay. Agents' and the system's exits stay held
 * as #163 built them (lib/commonsUnsaved), with no popover.
 */

/** `retry`: saving again could work (GM: only then is Save and leave offered
 * again). `reason` is the popover's line under its own heading, in its short
 * form (GM's WRAP rule: Save and leave is the retry); `message` is the
 * one-line form for the panel's banner ("Couldn’t save your labels. ..."). */
export type SaveResult = { ok: true } | { ok: false; reason: string; message: string; retry: boolean };
type SaveFailure = Extract<SaveResult, { ok: false }>;

/**
 * A failed save as a leave sees it. Saving again can work after a lost
 * connection (no answer, status 0), a server error (5xx), a timeout or a
 * rate limit (408, 429; lib/errorCopy canTryAgain); not after a refusal the
 * same request would get again: a conflict ("changed in another window"), a
 * closed batch, no session (any other 4xx). The reason is copy: a Commons
 * request's error carries it (lib/commonsApi); any other error says the
 * connection line or GM's general line, never its own message.
 */
export function saveFailure(error: unknown): SaveFailure {
  const retry = error instanceof CommonsRequestError ? canTryAgain(error.status) : true;
  const copy = failureCopy(error, { heading: "Couldn’t save your labels." });
  // The popover offers Save and leave whenever saving again could work, so
  // its reason is the short form; a refusal's reason has no short form.
  return { ok: false, reason: failureCopy(error, { short: retry }).reason, message: oneLine(copy), retry };
}

/**
 * The panel contract: what Blind labeling and Agent review tell the Commons
 * about their work, through `onWork`, whenever it changes (null on unmount).
 */
export interface LabelingWork {
  /** A draft the person hasn't saved. */
  unsaved: boolean;
  /** A label write already in flight; settles with its result. */
  saving: Promise<SaveResult> | null;
  /** Agent review's grading run: the panel asks for one grade at a time, so leaving stops it. */
  running: boolean;
  /** The panel's own save of its draft (Save labels, Save accents, Save corrections). */
  save: () => Promise<SaveResult>;
  /** The panel's own discard of its draft. */
  discard: () => void;
  /** Ask for no further grade (the one in flight finishes on the backend and is kept). */
  stop: () => void;
}

export type LabelingPanel = 'labeling' | 'review';
type Works = Record<LabelingPanel, LabelingWork | null>;

/** What the popover shows. */
export interface LeaveAsking {
  anchor: HTMLElement | null;
  /** Set when a save failed: its reason ('' when there is none). */
  failure: string | null;
  /** Whether saving again could work after that failure. */
  retry: boolean;
  /** A chosen leave is being carried out (its saves are running). */
  pending: boolean;
  /** Pending for about 300 ms: Save and leave reads "Saving…". */
  slow: boolean;
  /** Bumped by every opening, so a repeated failure is announced again. */
  seq: number;
}

export type LeaveChoice = 'save' | 'discard' | 'stop';

interface Leave {
  anchor: HTMLElement | null;
  /** The navigation the person asked for. */
  go: () => void;
  /** Marks the clicked control while a save already in progress is awaited. */
  busy?: (on: boolean) => void;
}

/** A leave waiting on a save in progress says so after this long. */
export const BUSY_AFTER_MS = 300;
/** How long a chosen leave waits for the panels to report their new state. */
const SETTLE_MS = 2000;

const held = (works: Works) => Object.values(works).some((work) => work && (work.unsaved || work.saving || work.running));

/** Resolves true once `check()` holds, or false after SETTLE_MS. */
function settle(check: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const step = () => {
      if (check()) resolve(true);
      else if (Date.now() - start > SETTLE_MS) resolve(false);
      else window.setTimeout(step, 16);
    };
    step();
  });
}

function controller(setAsking: (next: LeaveAsking | null | ((current: LeaveAsking | null) => LeaveAsking | null)) => void,
  setWorks: (works: Works) => void) {
  /** The panels' latest reports, for the waits (React state lags a render). */
  const latest: { current: Works } = { current: { labeling: null, review: null } };
  const report = (panel: LabelingPanel) => (work: LabelingWork | null) => {
    latest.current = { ...latest.current, [panel]: work };
    setWorks(latest.current);
  };
  let fallback: () => HTMLElement | null = () => null;
  let current: Leave | null = null;
  // Every new ask, choice or close bumps it: an older wait then does nothing.
  let turn = 0;
  let cancelGo = () => {};
  let seq = 0;

  const go = (leave: Leave) => {
    current = null;
    setAsking(null);
    // The panels report clean first; the stores let the exit through once
    // CommonsView has published that (lib/commonsUnsaved).
    cancelGo = whenCommonsClean(leave.go);
  };
  const open = (leave: Leave, failure: SaveFailure | null) => {
    current = leave;
    seq += 1;
    setAsking({ anchor: leave.anchor, failure: failure?.reason ?? null, retry: failure?.retry ?? true,
      pending: false, slow: false, seq });
  };
  const focusBack = (anchor: HTMLElement | null) => {
    (anchor?.isConnected ? anchor : fallback())?.focus();
  };

  const close = (returnFocus: boolean) => {
    turn += 1;
    const anchor = current?.anchor ?? null;
    current = null;
    setAsking(null);
    if (returnFocus) focusBack(anchor);
  };

  const request = (leave: Leave, toggle = false): void => {
    if (toggle && current && current.anchor === leave.anchor) { close(true); return; }
    const mine = ++turn;
    cancelGo();
    const works = Object.values(latest.current).filter((work): work is LabelingWork => work !== null);
    if (!held(latest.current)) { go(leave); return; }
    const saving = works.map((work) => work.saving).filter((save): save is Promise<SaveResult> => save !== null);
    if (saving.length === 0) { open(leave, null); return; }
    // A save already in progress: wait for it, with no popover; say so on the
    // clicked control if it takes a moment.
    current = null;
    setAsking(null);
    const timer = window.setTimeout(() => { if (mine === turn) leave.busy?.(true); }, BUSY_AFTER_MS);
    void Promise.all(saving).then(async (results) => {
      window.clearTimeout(timer);
      leave.busy?.(false);
      if (mine !== turn) return;
      const failed = results.find((result): result is SaveFailure => !result.ok);
      if (failed) { open(leave, failed); return; }
      // Once the panels have reported the save, look again: go, or ask
      // about what's still open (another panel's draft, a grading run).
      await settle(() => Object.values(latest.current).every((work) => !work?.saving));
      if (mine === turn) request(leave);
    });
  };

  const choose = async (choice: LeaveChoice): Promise<void> => {
    const leave = current;
    if (!leave) return;
    const mine = ++turn;
    setAsking((asking) => asking && { ...asking, pending: true });
    const slow = window.setTimeout(() => {
      if (mine === turn) setAsking((asking) => asking && { ...asking, slow: true });
    }, BUSY_AFTER_MS);
    try {
      const works = () => Object.values(latest.current).filter((work): work is LabelingWork => work !== null);
      if (choice === 'save') {
        for (const work of works().filter((w) => w.unsaved)) {
          let result: SaveResult;
          try { result = await work.save(); } catch (error) { result = saveFailure(error); }
          if (mine !== turn) return;
          if (!result.ok) { open(leave, result); return; }
        }
      } else if (choice === 'discard') {
        for (const work of works().filter((w) => w.unsaved)) work.discard();
      }
      for (const work of works().filter((w) => w.running)) work.stop();
      const clean = await settle(() => !held(latest.current));
      if (mine !== turn) return;
      // Something is still open (a save that hadn't finished): ask again.
      if (!clean) { open(leave, null); return; }
      go(leave);
    } finally {
      window.clearTimeout(slow);
    }
  };

  const dispose = () => {
    turn += 1;
    cancelGo();
  };

  return {
    request, choose, close, dispose,
    report: { labeling: report('labeling'), review: report('review') },
    setFallback: (get: () => HTMLElement | null) => { fallback = get; },
  };
}

/**
 * The Commons' side of leaving: the panels report their work here
 * (`report`), `hold` is what CommonsView publishes to lib/commonsUnsaved,
 * and `request` is every person's exit, which goes at once when nothing is
 * open and otherwise waits for a save in progress or asks. The Updates
 * corner reaches `request` through askBeforeLeavingCommons.
 * `fallback` takes focus back when the clicked control is gone.
 */
export function useCommonsLeave(fallback: RefObject<HTMLElement | null>) {
  const [works, setWorks] = useState<Works>({ labeling: null, review: null });
  const [asking, setAsking] = useState<LeaveAsking | null>(null);
  const [control] = useState(() => controller(setAsking, setWorks));

  useEffect(() => {
    control.setFallback(() => fallback.current);
    setCommonsLeaveAsk((anchor, go, busy) => control.request({ anchor, go, busy }));
    return () => {
      setCommonsLeaveAsk(null);
      control.dispose();
    };
  }, [control, fallback]);

  return {
    report: control.report,
    hold: held(works),
    unsaved: { labeling: Boolean(works.labeling?.unsaved), review: Boolean(works.review?.unsaved) },
    running: Boolean(works.labeling?.running || works.review?.running),
    asking,
    request: control.request,
    choose: control.choose,
    close: control.close,
  };
}
