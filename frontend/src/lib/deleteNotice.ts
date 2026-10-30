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

/** One delete of one node, as the backend answered it (DELETE
 * /api/graph/node's `removal`, an edit's graphSync `edit.removals`, a
 * restore's `removals`). Node ids are not unique over time (an import or a
 * clear starts them again at n1), so a record is bound to the project and
 * model it was made for, and a later delete of the same node names the one
 * it supersedes (`replaces`): only that record is renewed, never one that
 * merely has the same node id (second review). */
export interface RemovalRecord {
  id: string;
  nodeId: string;
  pins: string[];
  proposals: string[];
  projectId?: string;
  definitionId?: string;
  replaces?: string;
}

/** GM - Design, round 12 addendum (a), verbatim: a Cmd+Z pressed while a
 * change was still on its way to Nebula that the canvas dropped instead of
 * undoing something else (a newer step landed on top, the 15 s limit, a
 * project switch). No button, and no promise that a retry works. */
export const DROPPED_UNDO_TEXT = 'Nothing was undone. Your last change was still saving.';

/** GM, PR #198 r39 item 3 and r40 item 2, verbatim: an Undo pressed while a
 * Delete was still on its way waits for the Delete's answer, then restores.
 * When that restore is refused or fails, or the Delete gives no answer in
 * 15 s, one neutral line names what didn't come back, read live (the card
 * title when the answer arrives): "Nebula couldn’t bring back “X”. Try Undo
 * again." Several nodes by the shared name-list rule ("“A” and “B”", from 4
 * "4 nodes"); `names` is that list already joined (errorCopy.nodeNameList). */
export function bringBackFailedText(names: string): string {
  return `Nebula couldn\u2019t bring back ${names}. Try Undo again.`;
}

/** GM - Design, round 13, verbatim: several Cmd+Z held together, some of
 * which went through and some of which were dropped (review 12, L-1). The
 * restore's own line comes first ("Restored the node."), then this; Redo
 * stays, since something was restored. DROPPED_UNDO_TEXT is only for a batch
 * in which no undo went through. */
export function skippedUndoText(count: number): string {
  return skippedPressText(count, 0);
}

/** GM - Design, round 14, item 3, verbatim (review 13, L-4): the dropped
 * Cmd+Z and Cmd+Shift+Z presses counted apart, undos first, a kind with none
 * left out: "1 redo was skipped while a change was saving.", "2 undos and 1
 * redo were skipped while a change was saving." It follows the line of the
 * press that went through. */
export function skippedPressText(undos: number, redos: number): string {
  const parts = [
    ...(undos > 0 ? [undos === 1 ? '1 undo' : `${undos} undos`] : []),
    ...(redos > 0 ? [redos === 1 ? '1 redo' : `${redos} redos`] : []),
  ];
  const one = parts.length === 1 && undos + redos === 1;
  return `${parts.join(' and ')} ${one ? 'was' : 'were'} skipped while a change was saving.`;
}

/** GM - Design, round 14, item 3: no press went through and every one
 * dropped was a redo. Undos only, or both kinds: DROPPED_UNDO_TEXT. */
export const DROPPED_REDO_TEXT = 'Nothing was redone. Your last change was still saving.';

export const SKIPPED_UNDO_TEXT = skippedUndoText(1);

export function deletedNoticeText(count: number): string {
  return count === 1 ? 'Deleted the node.' : `Deleted ${count} nodes.`;
}

/** "1 proposal couldn't be reopened." / "2 proposals couldn't be reopened." */
export function notReopenedText(count: number): string {
  return count === 1 ? "1 proposal couldn't be reopened." : `${count} proposals couldn't be reopened.`;
}

/** What couldn't go back with the nodes. A pin counts only when its node came
 * back as another model (GM, 2026-10-23): "1 pin couldn't be re-attached.",
 * and with proposals "1 pin and 2 proposals couldn't be restored.". */
export function notRestoredText(notReattached: number, notReopened: number): string {
  if (notReattached === 0) return notReopened > 0 ? notReopenedText(notReopened) : '';
  const pins = notReattached === 1 ? '1 pin' : `${notReattached} pins`;
  if (notReopened === 0) return `${pins} couldn't be re-attached.`;
  const proposals = notReopened === 1 ? '1 proposal' : `${notReopened} proposals`;
  return `${pins} and ${proposals} couldn't be restored.`;
}

/**
 * What a restore's answer couldn't put back, on a line of its own, when the
 * "Restored …" line no longer applies because the person moved on before the
 * answer arrived (GM - Design, 2026-10-23, round 3: "Yes, show it as a plain
 * notice with no button, using the standard timeout ... Losing that count
 * silently is the one thing to avoid.").
 *
 * GM's lines, round 4, verbatim: "LATE LINES: drop the node word, which fixes
 * the mismatch for good. "After the restore, 1 proposal couldn't be
 * reopened." / "…{n} proposals couldn't be reopened." "After the restore, 1
 * pin couldn't be re-attached." / "…{n} pins couldn't be re-attached."
 * "After the restore, {p} pin(s) and {q} proposal(s) couldn't be restored."
 * (each noun by its own count)". No node count is named, so a line never
 * disagrees with how many nodes came back (the late count adds up across
 * restores). Empty when nothing was missed.
 */
export function lateRestoreText(notReopened: number, notReattached: number): string {
  const proposals = notReopened === 1 ? '1 proposal' : `${notReopened} proposals`;
  const pins = notReattached === 1 ? '1 pin' : `${notReattached} pins`;
  if (notReattached > 0 && notReopened > 0) return `After the restore, ${pins} and ${proposals} couldn't be restored.`;
  if (notReopened > 0) return `After the restore, ${proposals} couldn't be reopened.`;
  if (notReattached > 0) return `After the restore, ${pins} couldn't be re-attached.`;
  return '';
}

export function restoredNoticeText(count: number, notReopened: number, notReattached = 0): string {
  const restored = count === 1 ? 'Restored the node.' : `Restored ${count} nodes.`;
  const missed = notRestoredText(notReattached, notReopened);
  return missed ? `${restored} ${missed}` : restored;
}

/** The pins a restore answered it left on another model (`pinsLeft` code
 * "another-model"): counted by the code, never by the reason's words. */
export function pinsOnAnotherModel(raw: unknown): number {
  return Array.isArray(raw)
    ? raw.filter((item) => Boolean(item) && typeof item === 'object'
      && (item as { code?: unknown }).code === 'another-model').length
    : 0;
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
    const { id, nodeId, pins, proposals, projectId, definitionId, replaces } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !REMOVAL_ID.test(id) || typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) continue;
    records.push({
      id, nodeId, pins: ids(pins), proposals: ids(proposals),
      ...(typeof projectId === 'string' && projectId.length > 0 && projectId.length <= 64 ? { projectId } : {}),
      ...(typeof definitionId === 'string' && definitionId.length > 0 && definitionId.length <= 128
        ? { definitionId } : {}),
      ...(typeof replaces === 'string' && REMOVAL_ID.test(replaces) ? { replaces } : {}),
    });
  }
  return records;
}

/** The records in `fresh` keyed by the removal each supersedes. */
export function supersededBy(fresh: RemovalRecord[]): Map<string, RemovalRecord> {
  return new Map(fresh.filter((record) => record.replaces).map((record) => [record.replaces as string, record]));
}

/** `kept` with each record `fresh` supersedes (`replaces`) or repeats taken
 * out, and `fresh` added (a redo deletes again, with new records). Never by
 * node id alone. */
export function mergeRemovals(kept: RemovalRecord[] | undefined, fresh: RemovalRecord[]): RemovalRecord[] {
  const gone = new Set([...fresh.map((record) => record.id), ...supersededBy(fresh).keys()]);
  return [...(kept ?? []).filter((record) => !gone.has(record.id)), ...fresh];
}
