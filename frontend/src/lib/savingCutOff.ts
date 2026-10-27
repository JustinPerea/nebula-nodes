/**
 * GM - Design, round 19 (PR #195, review 18 G-1), verbatim. A project switch
 * or an import waits for the saves on their way (15 s at most); one that
 * failed or didn't land in time is said on the new canvas, in place of the
 * out-of-date line:
 *   "Couldn't save “<setting>” for “<node>” in “<old project>”. It was still
 *    saving when you switched."
 *   "Couldn't save your last change in “<old project>”. It was still saving
 *    when you switched."
 *   For an import: "…It was still saving when the import replaced the canvas."
 * An agent's switch (open_project, new_project), when the save of the
 * person's edits into the project left fails:
 *   "…It was still saving when <agent> switched projects." ("when an agent
 *    switched projects" when the agent isn't known).
 * The named form only when exactly one setting of one node was cut off.
 */
export interface CutOffSave {
  /** The node's title as its card showed it. */
  node: string | null;
  /** The setting's label on the card (never a raw key). */
  setting: string | null;
}

export type CutOffEnding = { kind: 'switch' } | { kind: 'import' } | { kind: 'agent'; agent: string | null };

function ending(how: CutOffEnding): string {
  if (how.kind === 'switch') return 'It was still saving when you switched.';
  if (how.kind === 'import') return 'It was still saving when the import replaced the canvas.';
  return `It was still saving when ${how.agent || 'an agent'} switched projects.`;
}

export function savingCutOffLine(saves: CutOffSave[], project: string, how: CutOffEnding): string {
  const [only] = saves;
  const named = saves.length === 1 && only.node && only.setting;
  const head = named
    ? `Couldn't save “${only.setting}” for “${only.node}” in “${project}”.`
    : `Couldn't save your last change in “${project}”.`;
  return `${head} ${ending(how)}`;
}
