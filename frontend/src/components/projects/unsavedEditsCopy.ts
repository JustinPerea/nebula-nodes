/** GM - Design's copy for Q116 a) (Justin, 2026-10-23: "a): "Download your
 * edits" plus "Continue without them"."), verbatim, for the held edits'
 * screen (UnsavedEditsNotice.tsx) and Projects home. */
export const UNSAVED_EDITS_HEADING = "Couldn't save your edits.";
export const CONFIRM_LINE = "Continue without your edits? They can't be recovered after this.";

/** GM's line after a download, with the real way back in: Load graph, under
 * Canvas actions on a project's canvas. It replaces that canvas, so the line
 * says to use a new project. */
export function editsSavedLine(filename: string): string {
  return `Your edits are saved as ${filename}. Open it with “Load graph” under “Canvas actions” in a new project to bring them back.`;
}

/** GM's line 1 (2026-10-23), verbatim, after a download whose file is past
 * Load graph's limits (over 16 MiB, 10,000 nodes, 50,000 wires or 1,000,000
 * values): the file keeps the edits, but Load graph won't open it. GM: "If
 * Q118 raises the limit, this line goes and the Load graph line covers every
 * case." Q118 is still open, so the branch that picks this line stays. */
export function editsSavedTooLargeLine(filename: string): string {
  return `Your edits are saved as ${filename}. Keep it somewhere safe. It's too large for “Load graph” to open right now, so Nebula can't bring the edits back yet.`;
}

/** GM's line 2 (2026-10-23), verbatim: the body of the held edits' screen
 * after a download that couldn't be written at all (not a cancelled save
 * picker). The heading and both choices stay. */
export const EDITS_NOT_WRITTEN = "The download didn't save, so your edits are still only in this tab. "
  + 'Check that your disk has free space, then download them again, or continue without them.';
