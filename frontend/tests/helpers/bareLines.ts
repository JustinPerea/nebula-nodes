/**
 * PR #204 round 10 (review 8 LOW-1): the runtime ratchet for the one-notice rule. Every text the
 * page shows that says "connected as you" must sit in an element a line registered on
 * (lib/notConnectedLine LINE_ATTR, set by <LineText>), whatever form put it there: a local const,
 * a prop handed on, literal JSX text, createElement, a state setter or a join (the review's F1-F6,
 * pinned in tests/presenceRound10.bareLines.test.tsx). The general notice and its announce region
 * are the rule's own words; an agent's text quoting them is the agent's (data-agent-text: an
 * Update's words in agent-notes/AgentNoteCard and AgentNotesList). tests/setup.ts fails a test
 * that leaves any.
 */
const NOT_LINES = '.person-required, .person-required__announce, [data-agent-text]';
const KEY = Symbol.for('nebula.tests.bareLines');
type Store = { bare: string[]; watching: boolean };
const store = (): Store => {
  const holder = globalThis as unknown as Record<symbol, Store>;
  holder[KEY] ??= { bare: [], watching: false };
  return holder[KEY];
};

/** The "connected as you" texts under `root` that no registered element holds. */
export function bareLinesIn(root: Node = document.body): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!text.includes('connected as you')) continue;
    const element = node.parentElement;
    if (!element || element.closest(NOT_LINES) || element.closest('[data-line-registered]')) continue;
    if (element.closest('[hidden], template, script, style, title')) continue;
    found.push(text.trim().slice(0, 120));
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
    .observe(document, { subtree: true, childList: true, characterData: true });
}

/** The bare lines seen since the last call, once each; clears them. */
export function takeBareLines(): string[] {
  return [...new Set(store().bare.splice(0))];
}
