/**
 * PR #204 round 10 (review 8 LOW-1): the runtime ratchet for the one-notice rule. Every text the
 * page shows that says "connected as you" must sit in an element a line registered on
 * (lib/notConnectedLine LINE_ATTR, set by <LineText>), whatever form put it there: a local const,
 * a prop handed on, literal JSX text, createElement, a state setter or a join (the review's F1-F6,
 * pinned in tests/presenceRound10.bareLines.test.tsx). The general notice and its announce region
 * are the rule's own words; an agent's text quoting them is the agent's (data-agent-text on an
 * Update's words: agent-notes/AgentNoteCard and AgentNotesList only). tests/setup.ts fails a test
 * that leaves any.
 *
 * Round 11 (review 9 lock-sweep LOW-6), closed:
 * - P1: the registered element alone isn't enough. A LineText with no class registers the
 *   surface's element and writes its words as a text node right before its hidden anchor; with a
 *   class it registers its own span. So the words must be that text node (or inside that span),
 *   not another text beside a LineText in the same parent.
 * - P2: data-agent-text counts only on the two Update texts.
 * - P3: a "connected as you" line in a `title` (a tooltip) or an `aria-label` is never right.
 */
import { LINE_ATTR, registeredLines } from '../../src/lib/notConnectedLine';

const WORDS = 'connected as you';
const NOTICE = '.person-required, .person-required__announce';
const AGENT_TEXT = '.agent-note-card__text[data-agent-text], .agent-notes-entry__text[data-agent-text]';
const ANCHOR = '[data-line-anchor]';
const KEY = Symbol.for('nebula.tests.bareLines');
type Store = { bare: string[]; watching: boolean };
const store = (): Store => {
  const holder = globalThis as unknown as Record<symbol, Store>;
  holder[KEY] ??= { bare: [], watching: false };
  return holder[KEY];
};

const fold = (text: string) => text.replace(/\s+/g, ' ').trim();
const isAnchor = (node: Node | null): boolean => node instanceof Element && node.matches(ANCHOR);

/** Whether a text node is a registered line's own words (P1). */
function registeredWords(node: Text, registered: Element): boolean {
  const ownSpan = ![...registered.children].some((child) => child.matches(ANCHOR));
  // A LineText with a class: its span is what registered, and all in it is its words.
  if (ownSpan) return true;
  // With no class: its text node sits right before its anchor in the registered element.
  if (node.parentElement === registered) return isAnchor(node.nextSibling);
  // Its children laid out in elements (a name in monospace): the last of them right before the
  // anchor, and the words those of the line registered there.
  let child: Node = node;
  while (child.parentElement && child.parentElement !== registered) child = child.parentElement;
  const line = registeredLines().get(registered);
  return child instanceof Element && isAnchor(child.nextElementSibling) && !!line && fold(line.text).includes(fold(node.textContent ?? ''));
}

/** The "connected as you" texts under `root` that no registered line holds, and the tooltips and
 * accessible names that carry one. */
export function bareLinesIn(root: Node = document.body): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!text.includes(WORDS)) continue;
    const element = node.parentElement;
    if (!element || element.closest(NOTICE) || element.closest(AGENT_TEXT)) continue;
    if (element.closest('[hidden], template, script, style, title')) continue;
    const registered = element.closest(`[${LINE_ATTR}]`);
    if (registered && registeredWords(node as Text, registered)) continue;
    found.push(text.trim().slice(0, 120));
  }
  if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
    const elements = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll('[title], [aria-label]')];
    for (const element of elements) {
      for (const attribute of ['title', 'aria-label']) {
        const value = element.getAttribute(attribute);
        if (value?.includes(WORDS) && !element.closest(NOTICE)) found.push(`${attribute}: ${value.trim().slice(0, 110)}`);
      }
    }
  }
  return found;
}

/** Watches the page from now on: each change that leaves a bare line records it. React commits
 * (and LineText's layout effects register) before the observer's microtask runs. */
export function watchBareLines(): void {
  const state = store();
  if (state.watching) return;
  state.watching = true;
  new MutationObserver(() => { state.bare.push(...bareLinesIn()); })
    .observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
}

/** The bare lines seen since the last call, once each; clears them. */
export function takeBareLines(): string[] {
  return [...new Set(store().bare.splice(0))];
}
