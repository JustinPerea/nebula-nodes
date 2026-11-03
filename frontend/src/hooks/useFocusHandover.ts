import { useCallback, useLayoutEffect, useRef, type FocusEvent } from 'react';

import { FOCUS_LINE_ATTR, FOCUS_SCOPE_ATTR } from '../lib/lineAttrs';

// Round 17 (review 13 NIT-3): the attributes live in lib/lineAttrs, so the lines that carry them
// stay out of this module; it reads them.
export { FOCUS_LINE_ATTR, FOCUS_SCOPE_ATTR };

const FRAMES = 30;

/**
 * What names a control well enough to find it again after a remount: its aria-label, name or id,
 * else (round 13, review 10 MEDIUM-2) its tag and the words that label it: the elements
 * aria-labelledby names, or the <label> around it without the control's own text (a select's
 * options), so an unlabelled field in a wrapping label ("Media", "Corrected only") is found too.
 */
function labelOf(element: HTMLElement): string | null {
  const own = element.getAttribute('aria-label') || element.getAttribute('name') || element.id;
  if (own) return own;
  let words = '';
  const by = element.getAttribute('aria-labelledby');
  if (by) words = textOfIds(by);
  else {
    const label = element.closest('label');
    if (label) for (const node of label.childNodes) if (!node.contains(element)) words += ` ${node.textContent ?? ''}`;
  }
  words = words.replace(/\s+/g, ' ').trim();
  return words ? `${element.tagName.toLowerCase()}: ${words}` : null;
}

function textOfIds(ids: string): string {
  return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

const PANE = `[${FOCUS_SCOPE_ATTR}], [aria-label], [aria-labelledby]`;

/** A pane's name: its data-focus-scope, else its aria-label, else the words it is labelled by. */
function nameOf(pane: HTMLElement): string {
  const by = pane.getAttribute('aria-labelledby');
  return pane.getAttribute(FOCUS_SCOPE_ATTR) || pane.getAttribute('aria-label') || (by ? textOfIds(by).replace(/\s+/g, ' ').trim() : '');
}

/**
 * The pane a control sits in, inside the handover's scope (round 14, review 11 MEDIUM-1): its
 * nearest data-focus-scope or labelled region, by that name. Two fields with the same words in
 * two panes (a reference's Role and the filter column's Role) are two controls.
 *
 * Round 17 (review 13 LOW-1): led by every data-focus-scope above that pane, so a labelled region
 * inside a scope (a membership's "Comments in Refs") stays that scope's. Two memberships of
 * same-named collections are two panes, not look-alikes told apart only by their place.
 */
function paneOf(element: HTMLElement, scope: HTMLElement): string {
  const pane = element.parentElement?.closest<HTMLElement>(PANE);
  if (!pane || !scope.contains(pane)) return '';
  const names = [nameOf(pane)];
  for (let up = pane.parentElement?.closest<HTMLElement>(`[${FOCUS_SCOPE_ATTR}]`); up && scope.contains(up); up = up.parentElement?.closest<HTMLElement>(`[${FOCUS_SCOPE_ATTR}]`)) {
    names.unshift(up.getAttribute(FOCUS_SCOPE_ATTR) ?? '');
  }
  return names.join(' › ');
}

/** A control's key: its pane and its label, or null when nothing names it. */
function keyOf(element: HTMLElement, scope: HTMLElement | null): string | null {
  const label = labelOf(element);
  if (!label) return null;
  return `${scope ? paneOf(element, scope) : ''}\n${label}`;
}

/** Every element labelOf can name: the focusable ones. */
const NAMED = 'input, select, textarea, button, a[href], summary, [tabindex], [aria-label], [name], [id]';

interface Focused {
  element: HTMLElement;
  key: string | null;
  /** Its pane (paneOf), for the line nearest it. */
  pane: string;
  /** Its ancestors inside the scope, nearest first, when focus was taken. */
  path: HTMLElement[];
  /** The scope's named elements when focus was taken: none of them is the control come back. */
  there: WeakSet<Element>;
  /** Round 15 (review 12 MEDIUM-1): how many of the scope's elements had this key when focus was
   * taken, and which of them (in document order) this one was. Look-alikes in one pane (two
   * memberships' Role) share a key; the one come back is the one at the same place, and only
   * while the count is the same. */
  ordinal: number;
  count: number;
  /** Focus was handed here (a line or the heading) in place of the control `key` names: a later
   * change may move it on, to that control once it is back, or to a line that came meanwhile. */
  handed?: boolean;
  /** Round 18h (review 16 MEDIUM-1, GM r38 2): the control that was disabled (or went inert) in
   * place while it had focus. Focus went to the heading; once it is enabled again, and focus is
   * still where the hook put it, it goes back to this very element. */
  origin?: HTMLElement;
}

/**
 * Round 18h (review 16 MEDIUM-1): a focused control is gone when it left the page, and also when
 * it was disabled or went inert in place (offline disables Commons' fields). Chrome's focus fixup
 * drops such focus to <body> without a blur the person can follow, so the hook moves it on.
 */
export function focusGone(element: HTMLElement): boolean {
  return !element.isConnected || element.matches(':disabled') || element.closest('[inert]') !== null;
}

const LINE = `[${FOCUS_LINE_ATTR}]`;

/** The scope's elements with this key, in document order. */
function sameKey(scope: HTMLElement, key: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(NAMED)].filter((el) => keyOf(el, scope) === key);
}

/**
 * The control come back (round 15, review 12 MEDIUM-1): never a guess between look-alikes. Of
 * the elements with its key, the one at its place, when there are as many as when focus was
 * taken, it is new (not there then) and it isn't disabled. Otherwise none, and focus goes to
 * the line.
 */
function cameBack(was: Focused, scope: HTMLElement): HTMLElement | undefined {
  // Round 18h: the control disabled in place is the one to come back to, once it is enabled. If
  // it left meanwhile (a promote remounted it), its look-alike at its place is, as below.
  if (was.origin?.isConnected) return focusGone(was.origin) || !scope.contains(was.origin) ? undefined : was.origin;
  if (!was.key) return undefined;
  const now = sameKey(scope, was.key);
  if (now.length !== was.count) return undefined;
  const el = now[was.ordinal];
  return el && !was.there.has(el) && !el.matches(':disabled') ? el : undefined;
}

/**
 * The line nearest where the control was (round 14): one in its own pane, else, from the nearest
 * ancestor still there outward, a line inside it or one a control inside it points at (Add's
 * menu went, Add's line explains it), else the first in the scope.
 */
function nearestLine(was: Focused, scope: HTMLElement): HTMLElement | null {
  const lines = [...scope.querySelectorAll<HTMLElement>(LINE)];
  if (lines.length === 0) return null;
  if (was.pane) {
    const own = lines.find((line) => paneOf(line, scope) === was.pane);
    if (own) return own;
  }
  for (const near of was.path) {
    if (!near.isConnected || !scope.contains(near)) continue;
    const inside = near.querySelector<HTMLElement>(LINE);
    if (inside) return inside;
    for (const control of near.querySelectorAll('[aria-describedby]')) {
      for (const id of (control.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
        const line = id ? document.getElementById(id) : null;
        if (line && line.matches(LINE) && scope.contains(line)) return line;
      }
    }
  }
  return lines[0];
}

/**
 * PR #204 round 11 (review 9 MEDIUM-3, GM r19 item 2): when a demote (or the promote) takes away
 * the control that had focus, focus moves on instead of dropping to the page: to the same
 * control if it is back (the promote remounts it, matched by labelOf), else to the section's
 * lock or not-connected line (`data-focus-line`, tabIndex -1), else to its heading. Only when the
 * focused control actually went away: while it is still there, or focus went somewhere else
 * meanwhile, nothing moves. `change` is what removes controls (the demote, the promote).
 * Spread `onFocus` on the section's root.
 *
 * Round 14 (review 11 MEDIUM-1): "the same control" is a new element only, one that wasn't there
 * when focus was taken, with the same label in the same pane (the nearest data-focus-scope or
 * labelled region). A look-alike that was there all along, in another pane or the same one, is
 * another control: focus goes to the line instead.
 *
 * Round 15 (review 12 MEDIUM-1): when look-alikes in one pane all come back new (two
 * memberships' Role remount on the promote), the hook takes the one at the control's own place
 * among them, and goes to the line when their count changed. It never takes the first.
 */
export function useFocusHandover(change: unknown, root: () => HTMLElement | null, heading: () => HTMLElement | null) {
  const last = useRef<Focused | null>(null);
  const snapshot = useCallback((element: HTMLElement, key: string | null, pane?: string): Focused => {
    const scope = root();
    const path: HTMLElement[] = [];
    for (let at = element.parentElement; at && scope?.contains(at); at = at.parentElement) path.push(at);
    const alike = scope && key ? sameKey(scope, key) : [];
    const ordinal = Math.max(0, alike.indexOf(element));
    return { element, key, pane: pane ?? (scope ? paneOf(element, scope) : ''), path,
      there: new WeakSet(scope ? scope.querySelectorAll(NAMED) : []), ordinal, count: Math.max(alike.length, 1) };
    // `root` is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    last.current = snapshot(element, keyOf(element, root()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  useLayoutEffect(() => {
    const was = last.current;
    if (!was) return undefined;
    // Round 14: a handed-over focus still on what it was handed to may move on (offline hid Add's
    // line and focus went to the heading; back online, the line again; on the promote, the field).
    // Round 18h: what the hook put focus on last, while it is still there.
    const handedNow = () => {
      const at = last.current;
      return at?.handed === true && document.activeElement === at.element;
    };
    if (!focusGone(was.element) && !(was.handed === true && handedNow())) return undefined;
    // Disabled or inert in place (not removed): the control is still there, so no line stands in
    // for it; focus goes to the heading at once and the line, if any, is heard through its polite
    // region. It comes back to the control when the control is enabled again.
    const inPlace = was.element.isConnected && !was.handed;
    const origin = was.origin ?? (inPlace ? was.element : undefined);
    let frame = 0;
    let id = 0;
    // The heading this run put focus on while it waits for a line: still "lost" to it.
    let held: HTMLElement | null = null;
    const lost = () => {
      const active = document.activeElement as HTMLElement | null;
      return !active || active === document.body || focusGone(active) || handedNow() || (held !== null && active === held);
    };
    // Hand focus to `target` and remember it was handed, keeping the control's own key: the
    // promote brings the control back, and focus goes back to it. What is there now isn't it.
    const hand = (target: HTMLElement, scope: HTMLElement) => {
      if (target !== document.activeElement) target.focus({ preventScroll: true });
      last.current = was.key || origin
        ? { ...snapshot(target, was.key, was.pane), key: was.key, path: was.path, there: was.there, ordinal: was.ordinal,
          count: was.count, handed: true, origin }
        : snapshot(target, keyOf(target, scope));
    };
    const attempt = () => {
      if (!lost()) return; // focus went somewhere on its own: leave it
      const scope = root();
      if (!scope) return;
      const same = cameBack(was, scope);
      if (same) {
        if (same !== document.activeElement) same.focus({ preventScroll: true });
        last.current = snapshot(same, keyOf(same, scope));
        return;
      }
      const line = inPlace || origin ? null : nearestLine(was, scope);
      if (line) {
        hand(line, scope);
        return;
      }
      // Round 18h (review 16 LOW-2): focus never waits on <body>. The heading holds it at once;
      // a line that arrives a moment later (a held read answers on the next tick) still takes it
      // from there, until FRAMES have passed.
      const head = heading();
      if (head && document.activeElement !== head) {
        hand(head, scope);
        held = head;
      }
      if (head && (inPlace || origin || frame >= FRAMES)) return;
      frame += 1;
      id = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(id);
    // `root` and `heading` are read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change]);
  return { onFocus };
}
