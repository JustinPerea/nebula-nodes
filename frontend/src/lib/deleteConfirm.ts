/**
 * The confirm before a delete (error copy round 3f, GM - Design): "Keep the
 * delete confirm, but get the plural right: "Delete {n} nodes?" / "Delete
 * this node?" If the canvas has undo, replace the confirm with a notice ...
 * Tell me if there's no undo and I'll leave the confirm."
 *
 * Cmd+Z puts the nodes, their wires, params and outputs back, but not
 * everything a delete removes: the backend's delete detaches the node's notes
 * for agents (pins) and closes the proposals that read it, and undo's restore
 * puts neither back (docs/notes/2026-10-23-fix-error-copy-3f.md). So the
 * selection toolbar, the node's context menu and the Inspector ask first.
 *
 * Round 3g (GM, option c, until undo puts those back): "ship c) so the Delete
 * key doesn't start asking on every delete. It asks only when a node has pins
 * or open proposals; the toolbar, menu and Inspector paths keep the confirm
 * until a) lands."
 * The Delete and Backspace keys ask only when deleteLosesAttachments says the
 * delete would detach or close something.
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

/** What the canvas holds that a delete can take with it, as its stores have
 * it: the open project's pins, the canvas proposals, the asset proposals and
 * the open project's id, and the graph's nodes (for the images a cover
 * proposal needs). Plain shapes, so a test can build them. */
export interface DeleteAttachments {
  pins: ReadonlyArray<{ anchor: { nodeId: string } | { x: number; y: number } }>;
  proposals: ReadonlyArray<{ view: { status: string; references: readonly string[] }; closing?: string }>;
  covers: ReadonlyArray<{
    view: { kind: string; status: string; target: { id: string }; change: { cover?: { from: string | null; to: string | null } } };
    closing?: string;
  }>;
  projectId: string | null;
  nodes: ReadonlyArray<{ id: string; data?: { definitionId?: string; outputs?: unknown; params?: unknown } }>;
}

// services/project_cover.py: a reference node's picture is the person's own
// (its first one counts), a painted mask is never a picture.
const REFERENCE_NODES = new Set(['image-input', 'style-reference', 'paper-source']);
const NOT_PICTURES = new Set(['mask-painter']);
const OUTPUTS = '/api/outputs/';

/** An image URL as project_cover.portable_url compares it: this machine's
 * /api/outputs/... relative, whatever port wrote it. */
function portable(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith(OUTPUTS)) return value;
  const index = value.indexOf(OUTPUTS);
  if (/^https?:\/\//.test(value) && index >= 0 && /:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(value.slice(0, index))) {
    return value.slice(index);
  }
  return value;
}

function imageValues(port: unknown): string[] {
  if (!port || typeof port !== 'object' || (port as { type?: unknown }).type !== 'Image') return [];
  const value = (port as { value?: unknown }).value;
  return (Array.isArray(value) ? value : [value]).map(portable).filter((url): url is string => Boolean(url));
}

/** The project images a node holds (project_cover.project_images). */
function nodeImages(node: DeleteAttachments['nodes'][number]): string[] {
  const data = node.data;
  const definitionId = data?.definitionId ?? '';
  if (!data || NOT_PICTURES.has(definitionId)) return [];
  const outputs = data.outputs && typeof data.outputs === 'object' ? Object.values(data.outputs as Record<string, unknown>) : [];
  const made = outputs.flatMap(imageValues);
  if (!REFERENCE_NODES.has(definitionId)) return made;
  const params = (data.params && typeof data.params === 'object' ? data.params : {}) as Record<string, unknown>;
  const urls = [...made, ...['_previewUrl', 'file', 'filePath'].map((key) => portable(params[key])).filter((url): url is string => Boolean(url))];
  return urls.slice(0, 1);
}

/**
 * Whether deleting `nodeIds` takes something undo doesn't put back, by the
 * backend's own rules for a delete (backend/tests/test_error_copy_round3g.py
 * pins each case of backend/tests/fixtures/delete_confirm_cases.json against
 * the real delete):
 * - a pin on one of the nodes, open or answered (canvas_pins.detach_node);
 * - an open proposal that reads one (canvas_proposals.invalidate_referencing:
 *   its `references`, the nodes it wires from, changes or runs);
 * - an open cover proposal for the open project whose image, or the pinned
 *   cover a "back to automatic" one is against, only the doomed nodes show
 *   (main._cover_proposal_misfit, on the sweep after the delete).
 */
export function deleteLosesAttachments(nodeIds: readonly string[], attached: DeleteAttachments): boolean {
  const doomed = new Set(nodeIds);
  if (doomed.size === 0) return false;
  if (attached.pins.some((pin) => 'nodeId' in pin.anchor && doomed.has(pin.anchor.nodeId))) return true;
  if (attached.proposals.some((entry) => !entry.closing && entry.view.status === 'open'
    && entry.view.references.some((id) => doomed.has(id)))) return true;
  const needed = attached.covers
    .filter((entry) => !entry.closing && entry.view.status === 'open' && entry.view.kind === 'project'
      && attached.projectId !== null && entry.view.target.id === attached.projectId)
    .map((entry) => portable(entry.view.change.cover ? entry.view.change.cover.to ?? entry.view.change.cover.from : null))
    .filter((url): url is string => Boolean(url));
  if (needed.length === 0) return false;
  const gone = new Set(attached.nodes.filter((node) => doomed.has(node.id)).flatMap(nodeImages));
  const kept = new Set(attached.nodes.filter((node) => !doomed.has(node.id)).flatMap(nodeImages));
  return needed.some((url) => gone.has(url) && !kept.has(url));
}
