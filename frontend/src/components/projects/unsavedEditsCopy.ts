/** GM - Design's copy for Q116 a) (Justin, 2026-10-23: "a): "Download your
 * edits" plus "Continue without them"."), verbatim, for the held edits'
 * screen (UnsavedEditsNotice.tsx) and Projects home. */
export const UNSAVED_EDITS_HEADING = "Couldn’t save your edits.";
export const CONFIRM_LINE = "Continue without your edits? They can’t be recovered after this.";

/** The confirm when the held edits are the open project's own canvas (Q118
 * review): the backend's switch keeps its nodes, connections and settings in that
 * project, so only what only this tab had is lost. DRAFT, not GM's yet: GM -
 * Design to replace it word for word. */
export function keptConfirmLine(projectName: string): string {
  return `Continue without them? “${projectName}” keeps its nodes, connections and settings. `
    + 'Run history since the last save, and anything else only this tab has, will be lost.';
}

/** GM's line after a download, with the real way back in: Load graph, under
 * Canvas actions on a project's canvas. It replaces that canvas, so the line
 * says to use a new project. Every download reads it since Q118: Load graph
 * opens a file over the save limit (the canvas pauses saving until it is
 * trimmed), and GM's line 1 for a file too large to reopen is gone (GM: "The
 * Load graph line covers every case now"). */
export function editsSavedLine(filename: string): string {
  return `Your edits are saved as ${filename}. Open it with “Load canvas” under “Canvas actions” in a new project to bring them back.`;
}

/** GM's line 2 (2026-10-23), verbatim: the body of the held edits' screen
 * after a download that couldn't be written at all (not a cancelled save
 * picker). The heading and both choices stay. */
export const EDITS_NOT_WRITTEN = "The download didn’t save, so your edits are still only in this tab. "
  + 'Check that your disk has free space, then download them again, or continue without them.';

/** GM - Design (2026-10-24), verbatim: the line above the held edits' screen
 * when an agent's switch is what left the project ("Claude Code is opening
 * “Moodboard v2”."). The agent's name is whatever the switch carries. */
export function agentOpeningLine(agent: string, projectName: string): string {
  return `${agent} is opening “${projectName}”.`;
}

/** GM - Design (2026-10-25), verbatim: the held edits' screen after a
 * download past the browser's string cap. The heading is the download's
 * ("Couldn't download your edits.") and the line is graphFileShared's
 * TOO_BIG_TO_DOWNLOAD; both choices stay. */
export const EDITS_DOWNLOAD_HEADING = "Couldn’t download your edits.";
