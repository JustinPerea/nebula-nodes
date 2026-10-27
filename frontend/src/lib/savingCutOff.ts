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

export type CutOffEnding = { kind: 'switch' } | { kind: 'import' }
  | { kind: 'agent'; agent: string | null; copy?: { id: string; name: string } | null }
  /** An agent's clear (round 20): agentClearedLine, no project. */
  | { kind: 'agentClear'; agent: string | null };

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

/** Each setting once (a save named twice is one change). */
function distinct(saves: CutOffSave[]): CutOffSave[] {
  const seen = new Set<string>();
  return saves.filter((save) => {
    const key = `${save.node}\u0000${save.setting}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "“a”", "“a” and “b”", "“a”, “b” and “c”". */
function quotedList(items: string[]): string {
  const quoted = items.map((item) => `“${item}”`);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * GM - Design, round 20 (follow-up 2, 2026-10-27), verbatim: an agent's
 * switch whose handoff save failed, as one line, not two (the toast no
 * longer says "Edits saved as a copy." beside it):
 *   "Couldn't save “<setting>” for “<node>” in “<old project>” when <agent>
 *    switched projects. Your edits were saved as a copy, “<copy name>”."
 *   Several settings use the undo counting: "Couldn't save 3 changes in
 *   “<old project>”…". One it can't name: "your last change" (as round 19).
 * The copy is a whole new project in Projects (POST /api/projects/recover),
 * "<old project> (recovered)"; the line's "Open copy" opens it.
 */
export function handoffFailedLine(saves: CutOffSave[], project: string, agent: string | null, copyName: string): string {
  const changes = distinct(saves);
  const [only] = changes;
  const head = changes.length === 1 && only.node && only.setting
    ? `Couldn't save “${only.setting}” for “${only.node}” in “${project}”`
    : changes.length > 1 ? `Couldn't save ${changes.length} changes in “${project}”`
      : `Couldn't save your last change in “${project}”`;
  return `${head} when ${agent || 'an agent'} switched projects. Your edits were saved as a copy, “${copyName}”.`;
}

/**
 * GM - Design, round 20 (item 3 and follow-up 4, 2026-10-27), verbatim: an
 * AGENT's clear that dropped what the person was editing (typing not yet
 * saved, a write on its way that Nebula then refused, a rename):
 *   One: "<Agent> cleared the canvas while you were editing “<s>” for
 *    “<node>”. That change wasn't saved."
 *   2-3 on one node: "…while you were editing “<a>” and “<b>” for “<node>”.
 *    Those changes weren't saved." (3: “a”, “b” and “c”)
 *   4+ or across nodes: "…while you were editing <N> settings. Those changes
 *    weren't saved."
 *   A rename draft counts as "Name". Unknown agent: "An agent cleared…".
 * The person's own Clear says nothing, and neither does a backend restart
 * (graphStore only calls this for a clear a sync names an agent for). Only
 * named settings count; null when there are none.
 */
export function agentClearedLine(saves: CutOffSave[], agent: string | null): string | null {
  const settings = distinct(saves.filter((save) => save.node && save.setting));
  if (settings.length === 0) return null;
  const who = agent || 'An agent';
  const nodes = new Set(settings.map((save) => save.node));
  if (nodes.size === 1 && settings.length <= 3) {
    const tail = settings.length === 1 ? "That change wasn't saved." : "Those changes weren't saved.";
    return `${who} cleared the canvas while you were editing ${quotedList(settings.map((save) => save.setting!))} `
      + `for “${settings[0].node}”. ${tail}`;
  }
  return `${who} cleared the canvas while you were editing ${settings.length} settings. Those changes weren't saved.`;
}
