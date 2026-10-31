import { DEFERS_TO_NOTICE, saysPersonRequired } from './errorCopy';

/**
 * GM r8 (1), PR #204 round 7: one notice, not two. GM r11 (round 8) gives the rule, verbatim:
 * "the general notice steps out only beside a line that carries the fix itself. A 'because' line
 * names the fix, so the general notice steps out. A lock line, or a line that ends 'The notice
 * below says why.', doesn't name the fix, so the general notice stays."
 *
 * So a line is one of three kinds:
 * - `fix`: a "because" line or the general words ("…Open the link Nebula printed when it
 *   started…"). The general notice steps out beside it.
 * - `defers`: the desktop app's dev setups ("…The notice below says why."). The notice stays.
 * - `lock`: "You can … when this tab is connected as you." The notice stays.
 *
 * Round 9 (review 7 MEDIUM-1): lines register, the page's text is no longer read. Each surface
 * renders its line through <LineText> (components/LineText.tsx), which registers the element and
 * the kind its words give, and unregisters when it goes. So an agent's own text that quotes the
 * words never counts (review 7 NIT-2), and a line is found however its text is split (NIT-3).
 * A ratchet (tests/lineRegistration.ratchet.test.ts) fails any surface that shows a line
 * without it.
 *
 * A registered line counts only while it is on screen:
 * - an IntersectionObserver (root: the window, any part of it in view) reports it intersecting.
 *   That covers the window's edges, every clipping scroll box (a line scrolled out of Settings'
 *   view doesn't count), `display: none` and a closed popover;
 * - and nothing IntersectionObserver can't see hides it: `hidden`, `aria-hidden`, `inert`,
 *   `visibility: hidden` or opacity 0 (checkVisibility in the browser, computed styles in jsdom).
 *   A change to those attributes, or an animation's end, checks the registered lines again.
 */
export type NotConnectedKind = 'fix' | 'defers' | 'lock';

const LOCK = /\bYou can .+ when this (?:tab|window) is connected as you\./;

export function notConnectedKind(text: string): NotConnectedKind | null {
  if (!text.includes('connected as you')) return null;
  if (saysPersonRequired(text)) return text.includes(DEFERS_TO_NOTICE) ? 'defers' : 'fix';
  return LOCK.test(text) ? 'lock' : null;
}

/** A because line (or the general words, or a dev setup's line): it says why the action didn't
 * happen and destroys nothing, so it is never drawn in the warning colour (GM r14 (4)). */
export function isBecauseLine(text: string): boolean {
  const kind = notConnectedKind(text);
  return kind === 'fix' || kind === 'defers';
}

const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';

/** Whether nothing IntersectionObserver can't see hides the element: hidden, aria-hidden or
 * inert on it or above it, visibility or opacity (the browser's own check, or computed styles in
 * jsdom, where display is read too since jsdom has no layout). */
export function lineRendered(element: Element): boolean {
  if (element.closest(HIDDEN)) return false;
  const check = (element as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility;
  if (typeof check === 'function') {
    return check.call(element, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
  }
  if (getComputedStyle(element).visibility === 'hidden') return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.opacity === '0') return false;
  }
  return true;
}

/** A `fix` line on screen and whether it already announces itself (it sits in a live region). */
export interface FixLine { readonly text: string; readonly live: boolean }

interface Registered { readonly text: string; readonly kind: NotConnectedKind }

const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';

const lines = new Map<Element, Registered>();
/** What the IntersectionObserver last said of each line; a line it hasn't reported yet doesn't count. */
const inView = new Map<Element, boolean>();
const listeners = new Set<() => void>();
let observer: IntersectionObserver | null = null;
let stopWatching = () => {};
let cached: FixLine | null = null;
let frame = 0;

const same = (a: FixLine | null, b: FixLine | null) => a === b || (!!a && !!b && a.text === b.text && a.live === b.live);
const ioAvailable = () => typeof IntersectionObserver === 'function';

function computeFixLine(): FixLine | null {
  const shown = [...lines].filter(([element, line]) => line.kind === 'fix' && element.isConnected
    && (ioAvailable() ? inView.get(element) === true : true) && lineRendered(element));
  // The first in the page's order, so the answer never depends on which mounted first.
  shown.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const first = shown[0];
  return first ? { text: first[1].text, live: first[0].closest(LIVE) !== null } : null;
}

function settle() {
  frame = 0;
  const next = computeFixLine();
  if (same(next, cached)) return;
  cached = next;
  listeners.forEach((listener) => listener());
}

function schedule() {
  if (frame) return;
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(settle) : (setTimeout(settle, 0) as unknown as number);
}

function startWatching() {
  // What IntersectionObserver can't see: these attributes anywhere above a line, and a fade's end.
  const attributes = new MutationObserver(() => schedule());
  attributes.observe(document.body, { subtree: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'inert', 'class', 'style'] });
  const settled = () => schedule();
  document.addEventListener('animationend', settled, true);
  document.addEventListener('transitionend', settled, true);
  stopWatching = () => {
    attributes.disconnect();
    document.removeEventListener('animationend', settled, true);
    document.removeEventListener('transitionend', settled, true);
  };
}

function ensureObserver(): IntersectionObserver | null {
  if (!ioAvailable()) return null;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (lines.has(entry.target)) inView.set(entry.target, entry.isIntersecting && entry.intersectionRatio > 0);
    }
    schedule();
  }, { root: null, threshold: [0, 0.01] });
  return observer;
}

/**
 * Registers a line's element under the kind its words give (none: nothing registers). Returns
 * the unregister. Registering the same element again replaces its entry (StrictMode's double
 * mount leaves one).
 */
export function registerLine(element: Element, text: string): () => void {
  const kind = notConnectedKind(text);
  if (kind === null) return () => {};
  const first = lines.size === 0;
  lines.set(element, { text, kind });
  if (first) startWatching();
  const io = ensureObserver();
  if (io) { inView.delete(element); io.observe(element); }
  schedule();
  return () => {
    if (lines.get(element)?.text !== text) return;
    lines.delete(element);
    inView.delete(element);
    observer?.unobserve(element);
    if (lines.size === 0) stopWatching();
    schedule();
  };
}

/** Calls `onChange` (at most once a frame) when the `fix` line on screen changes. */
export function subscribeToLines(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) cached = computeFixLine();
  return () => { listeners.delete(onChange); };
}

/** The `fix` line on screen: the kept answer while anything subscribes, else read now. */
export function currentFixLine(): FixLine | null {
  return listeners.size > 0 ? cached : computeFixLine();
}

/** What is registered, for tests and the ratchet's runtime check. */
export function registeredLines(): ReadonlyMap<Element, Registered> {
  return lines;
}

export function resetLinesForTests(): void {
  for (const element of lines.keys()) observer?.unobserve(element);
  lines.clear();
  inView.clear();
  stopWatching();
  stopWatching = () => {};
  observer?.disconnect();
  observer = null;
  cached = null;
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = 0;
}
