/**
 * The DOM side of pointing an agent cursor at a surface (Phase 3,
 * "Anywhere"). A surface item carries `data-agent-anchor`, a button that
 * opens a surface carries `data-agent-launcher`; the cursor chunk
 * (lib/agentAnchorResolve.ts) finds them by these values.
 *
 *   data-agent-anchor="moodboard:<board>[/<image>][:<part>]"
 *   data-agent-launcher="moodboard" | "moodboard:<board>" | "canvas"
 *
 * Ids match `[A-Za-z0-9_.-]{1,64}`; an id outside that gets no attribute
 * (undefined, which React leaves off), so no id can break the selector.
 *
 * Eager (the rail, the header and the canvas's Moodboard node use it), so it
 * imports nothing: tests/agentAnchors.test.ts holds that, and entrySplit
 * keeps the resolver out of the entry.
 */
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** `data-agent-anchor` for a board, one of its images, or a control of either. */
export function agentAnchor(board: string | null | undefined, image?: string | null, part?: string | null): string | undefined {
  if (!board || !ID.test(board) || (image && !ID.test(image)) || (part && !ID.test(part))) return undefined;
  return `moodboard:${board}${image ? `/${image}` : ''}${part ? `:${part}` : ''}`;
}

/** `data-agent-launcher` for the button that opens the Moodboard panel
 *  (`'moodboard'`), a board's own row or node (`'moodboard'` + its id), or
 *  the way back to the canvas (`'canvas'`). */
export function agentLauncher(kind: 'moodboard' | 'canvas', board?: string | null): string | undefined {
  if (kind === 'canvas') return 'canvas';
  if (board === undefined || board === null) return 'moodboard';
  return ID.test(board) ? `moodboard:${board}` : undefined;
}
