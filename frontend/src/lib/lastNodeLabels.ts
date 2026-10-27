/**
 * The last card title this tab saw for each node id, kept after the node
 * leaves the canvas, so a World Labs record whose node is gone can still be
 * named (GM, round 14 of PR #114: "“<last label>”, no longer on the
 * canvas"). graphStore notes every node list it holds. In this tab only: a
 * reload starts empty, and such a record then reads "A removed World Labs
 * node".
 */
const LIMIT = 500;
const labels = new Map<string, string>();

export function noteNodeLabels(nodes: readonly { id: string; data?: { label?: unknown } }[]): void {
  for (const node of nodes) {
    const label = node.data?.label;
    if (typeof label !== 'string' || !label.trim() || labels.get(node.id) === label) continue;
    labels.delete(node.id);
    labels.set(node.id, label);
    if (labels.size > LIMIT) labels.delete(labels.keys().next().value!);
  }
}

export function lastNodeLabel(nodeId: string): string | null {
  return labels.get(nodeId) ?? null;
}

export function forgetNodeLabelsForTests(): void {
  labels.clear();
}
