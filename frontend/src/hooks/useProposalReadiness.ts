import { useMemo } from 'react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { stillNotReady, type ProposalNotReady } from '../lib/canvasProposals';
import { acceptKeyLockLine } from '../lib/runKeyLock';
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
  return useProposalReadiness(entry).notReady;
}

/**
 * The proposal's not-ready rows, and GM's Accept lock when one of them can't
 * run without its key (PR #203 r6 item 1: "You can accept this after you add
 * your Hugging Face token in Settings."; lib/runKeyLock acceptKeyLockLine).
 */
export function useProposalReadiness(entry: ProposalEntry | undefined): {
  notReady: ProposalNotReady[];
  acceptLock: string | null;
} {
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
    if (!entry) return { notReady: [], acceptLock: null };
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
    const notReady = stillNotReady(view, cache, nodeFor);
    let acceptLock: string | null = null;
    if (cache.loaded && view.run.length > 0) {
      for (const row of notReady) {
        const node = nodeFor(row);
        acceptLock = node ? acceptKeyLockLine(node.definition, node.params, cache.apiKeys) : null;
        if (acceptLock) break;
      }
    }
    return { notReady, acceptLock };
  }, [entry, cache, named]);
}
