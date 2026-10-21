/**
 * Whether the Commons holds unsaved work: Blind labeling or Agent review has
 * unsaved labels, or is saving or generating (their onDirtyChange). The
 * Commons disables its own Back, tabs and More then; CommonsView publishes it
 * here so the Updates corner, which shows on every screen (Q107 a), refuses to
 * leave the Commons too (goToCanvas, Review). A plain module, not a store
 * field: only the Commons (lazy) and the corner (deferred) read it, so it
 * stays out of the startup entry, and nothing renders from it.
 */
let unsaved = false;

export function setCommonsUnsaved(value: boolean): void {
  unsaved = value;
}

export function commonsUnsaved(): boolean {
  return unsaved;
}

/** Throws, with the reason the corner shows, while the Commons holds unsaved work. */
export function refuseWhileCommonsUnsaved(): void {
  if (unsaved) throw new Error('The Commons has unsaved changes: save or discard them first.');
}
