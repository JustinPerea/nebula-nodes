/**
 * The DOM side of pointing an agent cursor at a surface (Phase 3,
 * "Anywhere"). A surface item carries `data-agent-anchor`, a button that
 * opens a surface carries `data-agent-launcher`; the cursor chunk
 * (lib/agentAnchorResolve.ts) finds them by these values.
 *
 *   data-agent-anchor="<surface>:<item>[/<sub>][:<part>]"
 *   data-agent-launcher="<surface>" | "<surface>:<item>" | "canvas"
 *
 * The surfaces are moodboard (sub: an image's id), character (sub: a
 * reference view's 1-based position) and style (no sub); lib/agentSurfaces.ts
 * holds the table. A launcher holds space-separated tokens, so one button
 * can open several surfaces (the rail's "Open assets" opens the dock that
 * holds all three lists); the resolver matches a token with `~=`.
 *
 * Ids match `[A-Za-z0-9_.-]{1,64}`; an id outside that gets no attribute
 * (undefined, which React leaves off), so no id can break the selector.
 *
 * Eager (the rail, the header and the canvas's Moodboard node use it), so it
 * imports nothing: tests/agentAnchors.test.ts holds that, and entrySplit
 * keeps the resolver out of the entry.
 */
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** `data-agent-anchor` for an item of `surface`, its sub-item (an image, a
 *  view) or a control of either. */
export function surfaceAnchor(
  surface: string, item: string | null | undefined, sub?: string | null, part?: string | null,
): string | undefined {
  if (!ID.test(surface) || !item || !ID.test(item) || (sub && !ID.test(sub)) || (part && !ID.test(part))) return undefined;
  return `${surface}:${item}${sub ? `/${sub}` : ''}${part ? `:${part}` : ''}`;
}

/** `data-agent-anchor` for a board, one of its images, or a control of either. */
export function agentAnchor(board: string | null | undefined, image?: string | null, part?: string | null): string | undefined {
  return surfaceAnchor('moodboard', board, image, part);
}

/** `data-agent-launcher` for the button that opens a surface's list
 *  (`'moodboard'`), an item's own row or node (a surface and its id), the
 *  way back to the canvas (`'canvas'`), or, with several surfaces, the one
 *  button that opens them all (space-separated tokens). */
export function agentLauncher(kind: string | readonly string[], item?: string | null): string | undefined {
  if (typeof kind !== 'string') {
    const tokens = kind.filter((one) => ID.test(one));
    return tokens.length > 0 && tokens.length === kind.length ? tokens.join(' ') : undefined;
  }
  if (kind === 'canvas') return 'canvas';
  if (!ID.test(kind)) return undefined;
  if (item === undefined || item === null) return kind;
  return ID.test(item) ? `${kind}:${item}` : undefined;
}
