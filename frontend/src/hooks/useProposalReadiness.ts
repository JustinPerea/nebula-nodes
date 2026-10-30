import { useMemo } from 'react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { stillNotReady, type ProposalNotReady } from '../lib/canvasProposals';
import { proposalAcceptLock } from '../lib/proposalAcceptLock';
import type { ProposalEntry } from '../store/canvasProposalsStore';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';

/**
 * The run nodes of a proposal that can't run here, kept current as the
 * person adds keys: the ghosts' ⚠ and the bar's lines both read this.
 * A node the proposal adds is checked at the values Accept will write; a
 * canvas node at its params with the proposed changes applied.
 */
export function useProposalNotReady(entry: ProposalEntry | undefined): ProposalNotReady[] {
  const cache = useUIStore((s) => s.settingsCache);
  // Only the canvas nodes the rows name, as text, so a drag elsewhere
  // doesn't re-render the ghosts.
  const named = useGraphStore((s) => {
    const ids = new Set((entry?.view.cost.notReady ?? []).map((row) => row.nodeId).filter(Boolean));
    if (ids.size === 0) return '[]';
    return JSON.stringify(s.nodes.filter((node) => ids.has(node.id))
      .map((node) => [node.id, node.data.definitionId, node.data.params]));
  });
  return useMemo(() => {
    if (!entry) return [];
    const { view, values } = entry;
    const nodes = new Map((JSON.parse(named) as Array<[string, string, Record<string, unknown>]>)
      .map(([id, definitionId, params]) => [id, { definitionId, params }]));
    const nodeFor = (row: ProposalNotReady) => {
      if (row.nodeId === null) {
        const ghost = view.nodes.find((node) => node.ref === row.ref);
        if (!ghost) return null;
        return { definition: NODE_DEFINITIONS[ghost.definitionId], params: values?.nodes[ghost.ref] ?? ghost.params };
      }
      const node = nodes.get(row.nodeId);
      if (!node) return null;
      const changes = values?.params[row.nodeId] ?? view.params.find((change) => change.nodeId === row.nodeId)?.changes ?? {};
      const proposed = Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.to]));
      return { definition: NODE_DEFINITIONS[node.definitionId], params: { ...node.params, ...proposed } };
    };
    return stillNotReady(view, cache, nodeFor);
  }, [entry, cache, named]);
}

/**
 * GM's Accept lock (PR #203 r6 item 1: "You can accept this after you add
 * your Hugging Face token in Settings."), read from the run Accept would
 * start with the keys set now (lib/proposalAcceptLock), so it follows the
 * token both ways, whenever the proposal was made (review r4 LOW-1). The bar
 * alone reads it: it follows the whole canvas, which the ghosts needn't.
 */
export function useProposalAcceptLock(entry: ProposalEntry | undefined): string | null {
  const cache = useUIStore((s) => s.settingsCache);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  return useMemo(() => (entry ? proposalAcceptLock(entry.view, entry.values, { nodes, edges }, cache) : null),
    [entry, cache, nodes, edges]);
}
