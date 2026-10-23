/**
 * What the canvas says when nodes are deleted and when undo brings them back
 * (GM - Design, 2026-10-23, item 1): "Make undo complete. ... When it lands,
 * every delete path becomes "Deleted {n} nodes." / "Deleted the node." with
 * Undo. One condition: reopen a proposal only if it's still valid against the
 * restored graph. If one can't be reopened, the Undo notice says so:
 * "Restored {n} nodes. 1 proposal couldn't be reopened.""
 *
 * Undo is complete because each delete's answer names what it removed (a
 * RemovalRecord per node: the pins it detached, the proposals it closed), the
 * canvas keeps the records in the undo step, and the restore that brings the
 * nodes back names them again (backend main._undo_removals checks each one).
 * The delete confirm of round 3f is gone with it.
 */

/** One node's delete, as the backend answered it (DELETE /api/graph/node's
 * `removal`, an edit's graphSync `edit.removals`, a restore's `removals`). */
export interface RemovalRecord {
  id: string;
  nodeId: string;
  pins: string[];
  proposals: string[];
}

export function deletedNoticeText(count: number): string {
  return count === 1 ? 'Deleted the node.' : `Deleted ${count} nodes.`;
}

/** "1 proposal couldn't be reopened." / "2 proposals couldn't be reopened." */
export function notReopenedText(count: number): string {
  return count === 1 ? "1 proposal couldn't be reopened." : `${count} proposals couldn't be reopened.`;
}

export function restoredNoticeText(count: number, notReopened: number): string {
  const restored = count === 1 ? 'Restored the node.' : `Restored ${count} nodes.`;
  return notReopened > 0 ? `${restored} ${notReopenedText(notReopened)}` : restored;
}

const REMOVAL_ID = /^rm_[0-9a-f]{16}$/;
const NODE_ID = /^n\d+$/;

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0
    && item.length <= 64).slice(0, 200) : [];
}

/** Well-formed removal records only; anything else is dropped. */
export function cleanRemovals(raw: unknown): RemovalRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: RemovalRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, nodeId, pins, proposals } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !REMOVAL_ID.test(id) || typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) continue;
    records.push({ id, nodeId, pins: ids(pins), proposals: ids(proposals) });
  }
  return records;
}

/** `kept` with `fresh` in place of any record for the same node (a redo deletes again, with new records). */
export function mergeRemovals(kept: RemovalRecord[] | undefined, fresh: RemovalRecord[]): RemovalRecord[] {
  const nodes = new Set(fresh.map((record) => record.nodeId));
  return [...(kept ?? []).filter((record) => !nodes.has(record.nodeId)), ...fresh];
}
