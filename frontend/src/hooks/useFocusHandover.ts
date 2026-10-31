import { useCallback, useLayoutEffect, useRef, type FocusEvent } from 'react';

/** The attribute a section's lock or not-connected line carries so a handover can find it. */
export const FOCUS_LINE_ATTR = 'data-focus-line';

/** The attribute that names a pane for the handover, when its region has no aria-label. */
export const FOCUS_SCOPE_ATTR = 'data-focus-scope';

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

/**
 * The pane a control sits in, inside the handover's scope (round 14, review 11 MEDIUM-1): its
 * nearest data-focus-scope or labelled region, by that name. Two fields with the same words in
 * two panes (a reference's Role and the filter column's Role) are two controls.
 */
function paneOf(element: HTMLElement, scope: HTMLElement): string {
  const pane = element.parentElement?.closest<HTMLElement>(PANE);
  if (!pane || !scope.contains(pane)) return '';
  const by = pane.getAttribute('aria-labelledby');
  return pane.getAttribute(FOCUS_SCOPE_ATTR) || pane.getAttribute('aria-label') || (by ? textOfIds(by).replace(/\s+/g, ' ').trim() : '');
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
  /** Focus was handed here (a line or the heading) in place of the control `key` names: a later
   * change may move it on, to that control once it is back, or to a line that came meanwhile. */
  handed?: boolean;
}

const LINE = `[${FOCUS_LINE_ATTR}]`;

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
 */
export function useFocusHandover(change: unknown, root: () => HTMLElement | null, heading: () => HTMLElement | null) {
  const last = useRef<Focused | null>(null);
  const snapshot = useCallback((element: HTMLElement, key: string | null, pane?: string): Focused => {
    const scope = root();
    const path: HTMLElement[] = [];
    for (let at = element.parentElement; at && scope?.contains(at); at = at.parentElement) path.push(at);
    return { element, key, pane: pane ?? (scope ? paneOf(element, scope) : ''), path,
      there: new WeakSet(scope ? scope.querySelectorAll(NAMED) : []) };
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
    const stillHanded = () => was.handed === true && document.activeElement === was.element;
    if (was.element.isConnected && !stillHanded()) return undefined;
    let frame = 0;
    let id = 0;
    const lost = () => !document.activeElement || document.activeElement === document.body || stillHanded();
    const attempt = () => {
      if (!lost()) return; // focus went somewhere on its own: leave it
      const scope = root();
      if (!scope) return;
      const same = was.key
        ? [...scope.querySelectorAll<HTMLElement>(NAMED)].find((el) => !was.there.has(el)
          && keyOf(el, scope) === was.key && !el.matches(':disabled'))
        : undefined;
      const line = nearestLine(was, scope);
      // The line can arrive a moment later (a held read answers on the next tick): wait for it.
      const target = same ?? line ?? (frame >= FRAMES ? heading() : null);
      if (target) {
        if (target !== document.activeElement) target.focus({ preventScroll: true });
        // Keep the control's own key: the promote brings it back, and focus goes back to it. What
        // is there now isn't it.
        last.current = same ? snapshot(same, keyOf(same, scope))
          : was.key ? { ...snapshot(target, was.key, was.pane), path: was.path, there: was.there, handed: true } : snapshot(target, keyOf(target, scope));
        return;
      }
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
