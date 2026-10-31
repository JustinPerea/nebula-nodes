/**
 * GM r10 (2), PR #204 round 8: the permission card's tag says what the agent asks to do in
 * Nebula's words, not ACP's. One table for every ACP ToolKind (agentclientprotocol.com,
 * "Tool calls": read, edit, delete, move, search, execute, think, fetch, switch_mode, other).
 * "execute" is "run", as everywhere else in Nebula; "switch_mode" reads as words. "other" and
 * any kind ACP adds later get no tag, never a raw protocol word. Person-side only: agents
 * send ACP's kinds and never see this.
 */
const TOOL_KIND_WORDS: Readonly<Record<string, string | null>> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'run',
  think: 'think',
  fetch: 'fetch',
  switch_mode: 'switch mode',
  other: null,
};

/** The card's tag for an ACP tool kind, or null for none. */
export function toolKindWord(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_KIND_WORDS, kind) ? TOOL_KIND_WORDS[kind] : null;
}
