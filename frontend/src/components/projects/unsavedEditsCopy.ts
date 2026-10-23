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

/** The line after a download whose file is past Load graph's limits (over
 * 16 MiB, 10,000 nodes, 50,000 wires or 1,000,000 values): the file keeps
 * the edits, but Load graph won't open it, so the line doesn't say it will.
 * Not GM's copy yet (GM's line assumes the file reopens): built in GM's
 * words and flagged for GM in the notes (Q116 a review). */
export function editsSavedTooLargeLine(filename: string): string {
  return `Your edits are saved as ${filename}. The file keeps them, but it's too large for “Load graph” to open.`;
}
