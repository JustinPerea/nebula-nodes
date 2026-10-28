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
  /** The node's id (never shown): two nodes with the same title are two
   * changes (round 21, review 20 L-8). Lines written before it key on the title. */
  nodeId?: string | null;
  /** The node's title as its card showed it. */
  node: string | null;
  /** The setting's label on the card (never a raw key). */
  setting: string | null;
}

export type CutOffEnding = { kind: 'switch' } | { kind: 'import' }
  /** `byAgent` false: the switch had no agent behind it (a script, or one
   * found after a reconnect): GM's no-agent form (round 23). */
  | { kind: 'agent'; agent: string | null; copy?: { id: string; name: string } | null; byAgent?: boolean }
  /** An agent's clear (round 20): agentClearedLine, no project. */
  | { kind: 'agentClear'; agent: string | null }
  /** Round 22 (review 21, L-a): a sync with no edit found another canvas (a
   * restart, a missed change): changesNotSavedLine, no project. Round 23
   * (GM): `copy`, the recovered copy the edits it cut off were saved to. */
  | { kind: 'reconnect'; copy?: { id: string; name: string } | null };

function ending(how: CutOffEnding): string {
  if (how.kind === 'reconnect') return '';
  if (how.kind === 'switch') return 'It was still saving when you switched.';
  if (how.kind === 'import') return 'It was still saving when the import replaced the canvas.';
  return `It was still saving when ${how.agent || 'an agent'} switched projects.`;
}

export function savingCutOffLine(saves: CutOffSave[], project: string, how: CutOffEnding): string {
  const [only] = saves;
  const named = saves.length === 1 && only.node && only.setting;
  const head = named
    ? `Couldn’t save “${only.setting}” for “${only.node}” in “${project}”.`
    : `Couldn’t save your last change in “${project}”.`;
  return `${head} ${ending(how)}`;
}

/** Which node a save is for: its id, or its title when it has none. */
const nodeKey = (save: CutOffSave): string => (save.nodeId ? `id:${save.nodeId}` : `title:${save.node}`);

/** Each setting of each node once (a save named twice is one change), by node id (L-8). */
export function distinctSaves(saves: CutOffSave[]): CutOffSave[] {
  const seen = new Set<string>();
  return saves.filter((save) => {
    const key = `${nodeKey(save)}\u0000${save.setting}`;
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
 * "<old project> (recovered)", then "(recovered 2)", 3 and so on (GM round
 * 21, G5: Nebula names it); the line's "Open copy" opens it.
 * GM round 21 (polish): non-breaking spaces inside the quoted project names,
 * so a name wraps as one piece.
 */
export function handoffFailedLine(saves: CutOffSave[], project: string, agent: string | null, copyName: string): string {
  const changes = distinctSaves(saves);
  const [only] = changes;
  const left = keepTogether(project);
  const head = changes.length === 1 && only.node && only.setting
    ? `Couldn’t save “${only.setting}” for “${only.node}” in “${left}”`
    : changes.length > 1 ? `Couldn’t save ${changes.length} changes in “${left}”`
      : `Couldn’t save your last change in “${left}”`;
  return `${head} when ${agent || 'an agent'} switched projects. Your edits were saved as a copy, “${keepTogether(copyName)}”.`;
}

/** A project name that wraps as one piece: its spaces non-breaking. */
function keepTogether(name: string): string {
  return name.replace(/ /g, '\u00a0');
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
  const settings = distinctSaves(saves.filter((save) => save.node && save.setting));
  if (settings.length === 0) return null;
  const who = agent || 'An agent';
  const nodes = new Set(settings.map(nodeKey));
  if (nodes.size === 1 && settings.length <= 3) {
    const tail = settings.length === 1 ? "That change wasn’t saved." : "Those changes weren’t saved.";
    return `${who} cleared the canvas while you were editing ${quotedList(settings.map((save) => save.setting!))} `
      + `for “${settings[0].node}”. ${tail}`;
  }
  return `${who} cleared the canvas while you were editing ${settings.length} settings. Those changes weren’t saved.`;
}

/**
 * Round 22 (review 21, L-a: "never lose it with no line"): typing Nebula
 * didn't keep because the canvas it was for is no longer the one Nebula
 * holds, found by a sync with no edit (a restart that lost Nebula's canvas
 * revisions, then showed another canvas). Not an agent's clear, so not its
 * line (GM follow-up 4). GM - Design's failed-save wording (round 23,
 * 2026-10-27), verbatim:
 *   One node, one setting: "Couldn't save “<setting>” for “<node>”."
 *   One node, 2–3 settings: "Couldn't save “a” and “b” for “Hero still”." /
 *    "“a”, “b” and “c”"
 *   One node, 4+ settings: "Couldn't save 4 settings for “Hero still”."
 *   Two or three nodes: "Couldn't save your changes to “Hero still” and
 *    “Hero prompt”."
 *   Four+ nodes: "Couldn't save your changes to 4 nodes."
 *   None it can name: "Couldn't save your last change."
 */
export function changesNotSavedLine(saves: CutOffSave[]): string | null {
  if (saves.length === 0) return null;
  const settings = distinctSaves(saves.filter((save) => save.node && save.setting));
  if (settings.length === 0) return "Couldn’t save your last change.";
  const nodes = new Map<string, string>();
  for (const save of settings) if (!nodes.has(nodeKey(save))) nodes.set(nodeKey(save), save.node!);
  if (nodes.size > 3) return `Couldn’t save your changes to ${nodes.size} nodes.`;
  if (nodes.size > 1) return `Couldn’t save your changes to ${quotedList([...nodes.values()])}.`;
  return `Couldn’t save ${settingsOnOneNode(settings.map((save) => save.setting!))} for “${settings[0].node}”.`;
}

/** One node's settings as GM counts them (round 23): “a”; “a” and “b”;
 * “a”, “b” and “c”; then "4 settings". The canvas's own failed-save line
 * (graphStore.paramSaveFailedLine) says the same. */
export function settingsOnOneNode(settings: string[]): string {
  return settings.length <= 3 ? quotedList(settings) : `${settings.length} settings`;
}

/**
 * GM - Design, round 23 (2026-10-27), verbatim: a replacement found with no
 * agent behind it (after a reconnect or a restart), or a switch with no
 * agent, whose cut-off edits were saved as a copy. No "when <agent>
 * switched projects":
 *   "Couldn't save “Text” for “Hero prompt”. Your edits were saved as a
 *    copy, “Round r20 (recovered)”."
 * The head is the failed-save line above; the copy's name wraps as one piece.
 */
export function changesSavedAsCopyLine(saves: CutOffSave[], copyName: string): string {
  const head = changesNotSavedLine(saves) ?? "Couldn’t save your last change.";
  return `${head} Your edits were saved as a copy, “${keepTogether(copyName)}”.`;
}
