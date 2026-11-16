/**
 * The Title Case default labels of six nodes, before the copy sweep renamed
 * them to sentence case. A node saved earlier carries the old label, which no
 * longer equals the definition's name, so a plain comparison would read it as a
 * name the person chose. Every default-title check goes through here, so a
 * former default counts as the default. A loaded canvas also shows the new
 * default in its place (withCurrentDefaultLabels); the stored file is not
 * rewritten by the load, and the next ordinary save stores the new label.
 * Same table as backend/services/node_route.py FORMER_DEFAULT_TITLES;
 * contracts/fixtures/former-default-titles.json pins both.
 */
export const FORMER_DEFAULT_TITLES: Readonly<Record<string, string>> = {
  'camera-rig': 'Camera Rig',
  'cinema-scene': 'Cinema Scene',
  'paper-source': 'Paper Source',
  'reference-set': 'Reference Set',
  'remotion-node': 'Remotion Composition',
  'video-edit': 'Video Edit',
};

/** The label is the Title Case default this definition had before the sweep. */
export function isFormerDefaultTitle(definitionId: string | undefined, label: string | null | undefined): boolean {
  return !!definitionId && !!label && FORMER_DEFAULT_TITLES[definitionId] === label;
}

/**
 * A loaded canvas's nodes, with each label that is exactly the former default
 * of its own definition replaced by the definition's current name. A label the
 * person changed, and a label that matches another definition's former
 * default, stay as they are.
 */
export function withCurrentDefaultLabels<T extends { data: { definitionId: string; label?: unknown } }>(
  nodes: readonly T[], currentName: (definitionId: string) => string | undefined,
): T[] {
  return nodes.map((node) => {
    const label = typeof node.data.label === 'string' ? node.data.label : undefined;
    if (!isFormerDefaultTitle(node.data.definitionId, label)) return node;
    const current = currentName(node.data.definitionId);
    return current && current !== label ? { ...node, data: { ...node.data, label: current } } : node;
  });
}
