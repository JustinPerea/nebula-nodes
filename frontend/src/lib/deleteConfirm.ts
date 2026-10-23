/**
 * The confirm before a delete (error copy round 3f, GM - Design): "Keep the
 * delete confirm, but get the plural right: "Delete {n} nodes?" / "Delete
 * this node?" If the canvas has undo, replace the confirm with a notice ...
 * Tell me if there's no undo and I'll leave the confirm."
 *
 * Cmd+Z puts the nodes, their wires, params and outputs back, but not
 * everything a delete removes: the backend's delete detaches the node's notes
 * for agents (pins) and closes the proposals that read it, and undo's restore
 * puts neither back (docs/notes/2026-10-23-fix-error-copy-3f.md). So every
 * path that deletes nodes asks this first: the selection toolbar, the Delete
 * and Backspace keys, the node's context menu and the Inspector.
 */
export function deleteConfirmLine(count: number): string {
  return count === 1 ? 'Delete this node?' : `Delete ${count} nodes?`;
}

/** Ask before deleting `count` nodes; true to go ahead. */
export function confirmNodeDelete(count: number): boolean {
  if (count <= 0) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(deleteConfirmLine(count));
}
