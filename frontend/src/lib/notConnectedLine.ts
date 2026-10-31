import { DEFERS_TO_NOTICE, saysPersonRequired } from './errorCopy';

/**
 * GM r8 (1), PR #204 round 7: one notice, not two. GM r11 (round 8) gives the rule, verbatim:
 * "the general notice steps out only beside a line that carries the fix itself. A 'because' line
 * names the fix, so the general notice steps out. A lock line, or a line that ends 'The notice
 * below says why.', doesn't name the fix, so the general notice stays."
 *
 * So a line on the page is one of three kinds:
 * - `fix`: a "because" line or the general words ("…Open the link Nebula printed when it
 *   started…"). The general notice steps out beside it.
 * - `defers`: the desktop app's dev setups ("…The notice below says why."). The notice stays.
 * - `lock`: "You can … when this tab is connected as you." The notice stays.
 *
 * Read from the page's text, so every surface that shows one counts without registering (about
 * fifty files render these lines; a site that forgot to register would hide the notice's fix
 * nowhere, but one that forgot to unregister would hide it everywhere). A line counts only while
 * it is rendered: not under `hidden`, `aria-hidden`, `inert`, `display: none`, `visibility:
 * hidden` or opacity 0 (the Commons keeps Settings and Chat mounted in a `display: none`, inert
 * group). A tooltip (`title`) isn't text, so it never counts.
 */
export type NotConnectedKind = 'fix' | 'defers' | 'lock';

const LOCK = /\bYou can .+ when this (?:tab|window) is connected as you\./;
/** Every kind says this; a page without it has none (a quick check before the walk). */
const PHRASE = 'connected as you';

export function notConnectedKind(text: string): NotConnectedKind | null {
  if (!text.includes(PHRASE)) return null;
  if (saysPersonRequired(text)) return text.includes(DEFERS_TO_NOTICE) ? 'defers' : 'fix';
  return LOCK.test(text) ? 'lock' : null;
}

const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';

/** Whether an element is on screen: the browser's own check, or its computed styles in jsdom. */
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

/** A `fix` line on the page and whether it already announces itself (it sits in a live region). */
export interface FixLine { readonly text: string; readonly live: boolean }
interface Found { element: Element; text: string }

const NOTICE_ITSELF = '.person-required, .person-required__announce';
const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';

function fixLinesIn(root: Node): Found[] {
  if (!(root.textContent ?? '').includes(PHRASE)) return [];
  const found: Found[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const element = text.parentElement;
    // The notice itself, and its live region's copy of a line, never count.
    if (!element || element.closest(NOTICE_ITSELF)) continue;
    const words = text.textContent ?? '';
    if (notConnectedKind(words) === 'fix') found.push({ element, text: words });
  }
  return found;
}

function firstRendered(found: Found[]): FixLine | null {
  const line = found.find(({ element }) => element.isConnected && lineRendered(element));
  return line ? { text: line.text, live: line.element.closest(LIVE) !== null } : null;
}

/** The first `fix` line rendered under `root`, read now. */
export function shownFixLine(root: Node = document.body): FixLine | null {
  return firstRendered(fixLinesIn(root));
}

export function notConnectedLineShown(root: Node = document.body): boolean {
  return shownFixLine(root) !== null;
}

// While anything subscribes, the answer is kept current and cached: a change to the page's text
// finds the lines again; a change to what hides them (an attribute, an animation's end) only
// checks the lines already found (review 6 NIT-2: no walk of every text node per style change).
const listeners = new Set<() => void>();
let found: Found[] = [];
let cached: FixLine | null = null;
let rescan = false;
let frame = 0;
let stop = () => {};

const same = (a: FixLine | null, b: FixLine | null) => a === b || (!!a && !!b && a.text === b.text && a.live === b.live);

function settle() {
  frame = 0;
  if (rescan) { found = fixLinesIn(document.body); rescan = false; }
  const next = firstRendered(found);
  if (same(next, cached)) return;
  cached = next;
  listeners.forEach((listener) => listener());
}

function schedule(texts: boolean) {
  if (texts) rescan = true;
  if (!frame) frame = requestAnimationFrame(settle);
}

function start() {
  found = fixLinesIn(document.body);
  cached = firstRendered(found);
  const observer = new MutationObserver((records) => {
    schedule(records.some((record) => record.type !== 'attributes'));
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'inert', 'class', 'style'] });
  // A line that fades in is at opacity 0 when it mounts; check again once it has.
  const settled = () => schedule(false);
  document.addEventListener('animationend', settled, true);
  document.addEventListener('transitionend', settled, true);
  stop = () => {
    observer.disconnect();
    document.removeEventListener('animationend', settled, true);
    document.removeEventListener('transitionend', settled, true);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}

/** Calls `onChange` (at most once a frame) when the rendered `fix` line changes. */
export function subscribeToLines(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) { stop(); found = []; cached = null; }
  };
}

/** The rendered `fix` line: the cached answer while subscribed, else read now. */
export function currentFixLine(): FixLine | null {
  return listeners.size > 0 ? cached : shownFixLine();
}
