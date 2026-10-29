import { useCallback, useLayoutEffect, useRef, useState, type AnimationEvent, type ReactNode } from 'react';
import { dialogStart, openModalDialog } from './modalFocus';

/**
 * The one place a notice-region item leaves (fix round 7 of PR #200, GM r11
 * answer 2: "The leave mirrors the enter for EVERY surface, toasts included").
 *
 * An item that goes stays mounted, marked `data-leaving` with its kind, until
 * its own leave animation ends; noticeRegion.css gives each kind its leave
 * (a surface scales out on the exit spring, a row collapses, reduced motion
 * fades). It is `inert` from the first frame of its leave, so focus is never
 * left on it: whatever moves focus does so at the start, not the end. A leave
 * animation is any animation whose name ends in `-out`; an item with none
 * running (no region CSS, a test without layout) goes at once, as before.
 */
export type LeaveKind = 'surface' | 'row';

const isLeave = (name: string | undefined) => Boolean(name && /-out$/.test(name));

const leaves = (element: Element) => element.getAnimations().filter((animation) => isLeave((animation as CSSAnimation).animationName));

/** Whether a leave animation is running on the element itself. */
export function runsLeave(element: Element | null): boolean {
  if (!element || typeof element.getAnimations !== 'function') return false;
  return leaves(element).length > 0;
}

/** Slack past a leave's own end before the fallback looks again. */
export const LEAVE_SLACK_MS = 250;
/** How many times the fallback waits again for a leave still running. */
export const MAX_REARMS = 8;
/** How long a visible leave may stall (running late, paused, never ending)
 * before it finishes with the reduced-motion fade (GM r12 answer 5). */
export const STALL_LIMIT_MS = 2300;
/** The reduced-motion fade a stalled leave finishes with (noticeRegion.css notice-fade-out). */
export const STALL_FADE_MS = 140;

/** The longest time any of `animations` has left, from now. */
function timeLeft(animations: Animation[]): number {
  let left = 0;
  for (const animation of animations) {
    const timing = animation.effect?.getComputedTiming();
    const total = Number(timing?.endTime ?? 0);
    const now = Number(animation.currentTime ?? 0);
    const rate = Math.abs(animation.playbackRate) || 1;
    if (Number.isFinite(total)) left = Math.max(left, (total - now) / rate);
  }
  return Math.max(0, left);
}

const unfinished = (animation: Animation) => animation.pending || animation.playState === 'running' || animation.playState === 'paused';
const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * How a leave ends, whatever happens to its animation (review 8 NIT-1,
 * review 9 LOW-3, review 10 NIT-1, GM r12 answer 5):
 * - It ends on its own animationend (the caller's onAnimationEnd), or at
 *   once when its animation is cancelled (by a style change or by script).
 * - The tab hidden (now or during the leave): it finishes at once; nobody
 *   sees it, and a hidden tab's timers and frames are throttled.
 * - Visible but stalled (a late first frame, a blocked main thread, a paused
 *   or endless animation): the fallback waits out the time it has left, up
 *   to STALL_LIMIT_MS from the start, then finishes it with the
 *   reduced-motion fade from where it stands, never a hard cut.
 * `end` (the item unmounts, the space closes) runs when the exit finishes.
 * Returns the cleanup.
 */
export function watchLeave(element: HTMLElement, end: () => void): () => void {
  const running = leaves(element);
  const started = Date.now();
  let ended = false;
  let rearms = 0;
  let timer = 0;
  let fade: Animation | null = null;
  const finish = () => { if (!ended) { ended = true; stop(); end(); } };
  const arm = (delay: number) => { window.clearTimeout(timer); timer = window.setTimeout(check, delay); };
  const onCancel = (event: Event) => {
    if (event.target === element && isLeave((event as globalThis.AnimationEvent).animationName)) finish();
  };
  const onVisibility = () => { if (tabHidden()) finish(); };
  const listen = (on: boolean) => {
    // A style change that drops the animation fires animationcancel on the
    // element; Animation.cancel() from script fires only the animation's own
    // cancel event (Chrome, live), so both are heard.
    const method = on ? 'addEventListener' : 'removeEventListener';
    element[method]('animationcancel', onCancel);
    for (const animation of running) animation[method]?.('cancel', finish);
  };
  const stop = () => {
    listen(false);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearTimeout(timer);
  };
  const fadeOut = () => {
    // From where it stands: its look now, held while only the opacity goes.
    const style = getComputedStyle(element);
    const from = { opacity: style.opacity, transform: style.transform === 'none' ? 'none' : style.transform };
    listen(false);
    for (const animation of running) animation.cancel();
    if (typeof element.animate !== 'function') { finish(); return; }
    fade = element.animate([from, { opacity: '0', transform: from.transform }], { duration: STALL_FADE_MS, easing: 'ease-out', fill: 'forwards' });
    fade.addEventListener('finish', finish);
    fade.addEventListener('cancel', finish);
    // Its own fallback: the fade's time plus the slack, then it's done.
    arm(STALL_FADE_MS + LEAVE_SLACK_MS);
  };
  const check = () => {
    if (ended) return;
    if (fade || tabHidden()) { finish(); return; }
    const waited = Date.now() - started;
    if (running.some(unfinished)) {
      if (waited < STALL_LIMIT_MS && rearms < MAX_REARMS) {
        rearms += 1;
        arm(Math.min(timeLeft(running) + LEAVE_SLACK_MS, Math.max(16, STALL_LIMIT_MS - waited)));
      } else {
        fadeOut();
      }
      return;
    }
    finish();
  };
  if (tabHidden()) { queueMicrotask(finish); return () => { ended = true; }; }
  listen(true);
  document.addEventListener('visibilitychange', onVisibility);
  const planned = timeLeft(running);
  // GM r19 answer 2 (PR #200 fix round 12): a running leave longer than the
  // limit plays out (only a stalled one is rescued), but it means a spring
  // or keyframe needs tuning: say so in development, never in production.
  if (import.meta.env.DEV && planned > STALL_LIMIT_MS) {
    console.warn(`[noticeLeave] a leave runs ${Math.round(planned)} ms, past the ${STALL_LIMIT_MS} ms limit: tune its animation.`, element);
  }
  arm(planned + LEAVE_SLACK_MS);
  return () => { ended = true; stop(); fade?.removeEventListener('finish', finish); };
}

// A notice's ×: every notice labels it "Dismiss…".
const DISMISS = 'button[aria-label^="Dismiss"]:not(:disabled)';

const usable = (element: Element, leaving: Element) => !leaving.contains(element) && !element.closest('[inert], [data-leaving]');

function focusOn(target: HTMLElement): void {
  if (!target.matches('button, a[href], input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * Review 8 NIT-2, review 9 LOW-2, GM r16 answer 2: when what leaves holds
 * focus, focus lands on the next notice's × (else the one before's), never
 * on a primary or destructive action (Run, Restore, Undo, Delete), so a
 * second Enter (a double press, key repeat) can only dismiss. A notice with
 * no × takes focus itself. With no notice left and a dialog open, focus goes
 * back to the dialog's field (GM r25). Else it goes to the surface's
 * start of page content: the Projects "Recent projects" heading, the canvas,
 * or the screen's <main>. Never <body>. It runs as the leave starts, before
 * the item's `inert` drops focus.
 */
export function moveFocusFromLeave(leaving: HTMLElement): void {
  if (!leaving.contains(document.activeElement)) return;
  const notices = [...document.querySelectorAll<HTMLElement>('.notice-region__slot > *')];
  const own = leaving.closest<HTMLElement>('.notice-region__slot > *');
  const at = own ? notices.indexOf(own) : -1;
  const ordered: HTMLElement[] = [];
  // A row inside a notice that stays: that notice's own × first.
  if (own && own !== leaving) ordered.push(own);
  if (at >= 0) ordered.push(...notices.slice(at + 1), ...notices.slice(0, at).reverse());
  else {
    const after = notices.filter((notice) => leaving.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = notices.filter((notice) => leaving.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING);
    ordered.push(...after, ...before.reverse());
  }
  for (const notice of ordered) {
    if (!usable(notice, leaving) && notice !== own) continue;
    const close = [...notice.querySelectorAll<HTMLElement>(DISMISS)].find((button) => usable(button, leaving));
    if (close) { close.focus({ preventScroll: true }); return; }
    if (notice !== own) { focusOn(notice); return; }
  }
  // GM r25: with a dialog open, back to the dialog's field, never the page behind it.
  const dialog = document.querySelector('[aria-modal="true"]') ? openModalDialog() : null;
  if (dialog) { focusOn(dialogStart(dialog) ?? dialog); return; }
  const start = document.getElementById('recent-projects-title')
    ?? document.querySelector<HTMLElement>('.canvas-wrapper')
    ?? [...document.querySelectorAll<HTMLElement>('main')].find((main) => !main.closest('[inert]')) ?? null;
  if (start) focusOn(start);
}

export interface LeaveProps {
  ref: (element: HTMLElement | null) => void;
  'data-leaving'?: LeaveKind;
  inert?: boolean;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * One item: `shown` is the value while it is there and, once it goes, the
 * last value until its leave ends. Spread `props` on the item's own element.
 * A new value while it leaves brings it back at once.
 */
export function useLeave<T>(value: T | null | undefined | false, kind: LeaveKind = 'surface'): {
  shown: T | null; leaving: boolean; props: LeaveProps;
} {
  const present = value === null || value === undefined || value === false ? null : value;
  const [last, setLast] = useState<T | null>(present);
  const [leaving, setLeaving] = useState(false);
  if (present !== null && (present !== last || leaving)) {
    setLast(present);
    setLeaving(false);
  } else if (present === null && last !== null && !leaving) {
    setLeaving(true);
  }
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const done = useCallback(() => { setLast(null); setLeaving(false); }, []);
  useLayoutEffect(() => {
    const node = element.current;
    if (!leaving) return;
    if (node) moveFocusFromLeave(node);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM read: whether a leave animation runs is known only once the mark is drawn; none runs, it goes before paint
    if (!node || !runsLeave(node)) { done(); return; }
    return watchLeave(node, done);
  }, [leaving, done]);
  const shown = present ?? (leaving ? last : null);
  return {
    shown,
    leaving: present === null && shown !== null,
    props: {
      ref,
      'data-leaving': present === null && shown !== null ? kind : undefined,
      inert: present === null && shown !== null ? true : undefined,
      onAnimationEnd: (event) => {
        if (event.target === event.currentTarget && isLeave(event.animationName) && present === null) done();
      },
    },
  };
}

/**
 * For an item its parent mounts only while it is there (a toast drawn as
 * `{toast && <Toast />}`): `<NoticeLeave value={toast}>{(toast, leave) =>
 * <Toast … leave={leave} />}</NoticeLeave>` keeps it through its leave.
 */
export function NoticeLeave<T>({ value, kind = 'surface', children }: {
  value: T | null | undefined | false; kind?: LeaveKind; children: (shown: T, leave: LeaveProps) => ReactNode;
}): ReactNode {
  const { shown, props } = useLeave(value, kind);
  return shown === null ? null : children(shown, props);
}

type Entry<T> = { key: string; item: T; leaving: boolean };

/** Where each item that went sits: it keeps its place among the rest. */
function merge<T>(before: Entry<T>[], items: readonly T[], keyOf: (item: T) => string): Entry<T>[] {
  const at = new Map(items.map((item, index) => [keyOf(item), index]));
  const out: Entry<T>[] = [];
  let next = 0;
  for (const entry of before) {
    const index = at.get(entry.key);
    if (index === undefined) {
      out.push({ ...entry, leaving: true });
      continue;
    }
    while (next <= index) {
      const item = items[next];
      out.push({ key: keyOf(item), item, leaving: false });
      next += 1;
    }
  }
  for (; next < items.length; next += 1) out.push({ key: keyOf(items[next]), item: items[next], leaving: false });
  return out;
}

/**
 * A list of rows: `rows` holds each row still there and each that went,
 * in place, until its own leave ends. `hold` keeps the rows that went as
 * they are, unmarked (their surface is leaving with them in it).
 * `onRowLeft` runs after a row's leave ends (the open kept list re-sizes
 * there, not at its start).
 */
export function useLeavingRows<T>(items: readonly T[], keyOf: (item: T) => string, { hold = false, onRowLeft }: {
  hold?: boolean; onRowLeft?: () => void;
} = {}): {
  rows: Array<{ key: string; item: T; leaving: boolean }>;
  rowProps: (key: string, leaving: boolean) => LeaveProps;
} {
  const [state, setState] = useState(() => ({ items, entries: items.map((item) => ({ key: keyOf(item), item, leaving: false })) }));
  let entries = state.entries;
  // A list made afresh each render (`kept.slice(-2)`) is the same list when
  // its items are.
  if (state.items !== items && (state.items.length !== items.length || state.items.some((item, index) => item !== items[index]))) {
    entries = merge(state.entries, items, keyOf);
    setState({ items, entries });
  }
  const elements = useRef(new Map<string, HTMLElement>());
  const finish = useCallback((key: string) => {
    setState((now) => {
      if (!now.entries.some((entry) => entry.key === key && entry.leaving)) return now;
      return { ...now, entries: now.entries.filter((entry) => !(entry.key === key && entry.leaving)) };
    });
    onRowLeft?.();
  }, [onRowLeft]);
  const pending = entries.filter((entry) => entry.leaving).map((entry) => entry.key).join('\n');
  useLayoutEffect(() => {
    if (hold || !pending) return;
    const stops: Array<() => void> = [];
    for (const key of pending.split('\n')) {
      const node = elements.current.get(key) ?? null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM read: as above, a row with no leave running goes before paint
      if (!node || !runsLeave(node)) finish(key);
      else stops.push(watchLeave(node, () => finish(key)));
    }
    return () => { for (const stop of stops) stop(); };
  }, [pending, hold, finish]);
  return {
    rows: entries,
    rowProps: (key, leaving) => ({
      ref: (node) => {
        if (node) elements.current.set(key, node);
        else if (elements.current.get(key)?.isConnected === false) elements.current.delete(key);
      },
      'data-leaving': leaving && !hold ? 'row' : undefined,
      inert: leaving ? true : undefined,
      onAnimationEnd: (event) => {
        if (leaving && event.target === event.currentTarget && isLeave(event.animationName)) finish(key);
      },
    }),
  };
}
