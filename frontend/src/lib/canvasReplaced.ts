/**
 * Round 23 of PR #195 (review 22, M-1 and L-2): the canvas the tab shows was
 * replaced (a project loaded over it, an import, a clear, a sync that brought
 * another canvas). Node ids start again at n1 in every canvas, so anything
 * still holding an id of the canvas that went (the note dialog's target)
 * lets it go here. graphStore says it; whoever holds such an id listens.
 * Its own module so a store can listen without importing graphStore.
 */
const listeners = new Set<() => void>();
let replacements = 0;

export function noteCanvasReplaced(): void {
  replacements += 1;
  for (const listener of [...listeners]) listener();
}

/** How many times the canvas was replaced since the page loaded: a holder of
 * a node id stamps it with this and lets the id go once it moved (the chat's
 * "Apply to @n2", follow-up to PR #195). */
export function canvasReplacements(): number {
  return replacements;
}

export function subscribeCanvasReplaced(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
