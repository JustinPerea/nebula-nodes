import { saysPersonRequired } from './errorCopy';

/**
 * GM r8 (1), PR #204 round 7: one notice, not two. Whether a line on screen other than this
 * notice already says the tab isn't connected as the person (a "because" line, a card's or a
 * row's own line). Read from the page itself, so every surface counts; a tooltip (`title`) and
 * a hidden part don't.
 */
export function notConnectedLineShown(root: Node = document.body): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const element = text.parentElement;
    if (!element || element.closest('.person-required')) continue;
    if (!saysPersonRequired(text.textContent ?? '')) continue;
    if (element.closest('[hidden], [aria-hidden="true"]')) continue;
    return true;
  }
  return false;
}

/** Calls `onChange` (at most once a frame) when the page's text or what hides it changes. */
export function subscribeToLines(onChange: () => void): () => void {
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; onChange(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden'] });
  return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
