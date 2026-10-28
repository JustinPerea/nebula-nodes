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

/** What replaced the canvas, as far as the tab knows (fix round 1 of PR
 * #200, GM answer 4: the chat's Apply says why it can't apply any more).
 * `opened`: another project's canvas came (an agent's switch, or one with
 * no agent behind it); `cleared`: a clear emptied it; `changed`: anything
 * else (an import, a load, a sync that brought another canvas). */
export type CanvasReplacement =
  | { kind: 'opened'; agent: string | null; projectName: string | null }
  | { kind: 'cleared' }
  | { kind: 'changed' };

let last: CanvasReplacement = { kind: 'changed' };

export function noteCanvasReplaced(cause: CanvasReplacement = { kind: 'changed' }): void {
  replacements += 1;
  last = cause;
  for (const listener of [...listeners]) listener();
}

/** The latest replacement's cause (what the canvas shown now came from). */
export function lastCanvasReplacement(): CanvasReplacement {
  return last;
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

/**
 * GM - Design, PR #200 answer 4 (2026-10-27), verbatim: the tooltip of the
 * chat's "Apply to @n2" once the canvas it was written for was replaced.
 *   switched: "Codex opened “Second canvas” after this was written."
 *     (no agent: "Nebula opened “Second canvas” after this was written.")
 *   cleared: "The canvas was cleared after this was written."
 * `projectNow`: the project open now, when the cause didn't name one. Any
 * other replacement (an import, a load) has no GM line yet: "The canvas
 * changed after this was written." (asked of GM).
 */
export function replacedSinceWrittenLine(cause: CanvasReplacement, projectNow: string | null): string {
  if (cause.kind === 'cleared') return 'The canvas was cleared after this was written.';
  const project = cause.kind === 'opened' ? cause.projectName ?? projectNow : null;
  if (cause.kind === 'opened' && project) return `${cause.agent || 'Nebula'} opened “${project}” after this was written.`;
  return 'The canvas changed after this was written.';
}
