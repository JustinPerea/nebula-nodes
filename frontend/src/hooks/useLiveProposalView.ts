import { useMemo } from 'react';
import { liveKeyBilling } from '../lib/canvasProposals';
import type { ProposalEntry } from '../store/canvasProposalsStore';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';

/**
 * The proposal as the bar, the Accept chip and the ghost cards show it: each
 * key-billing node's class ("free" or "may cost") read from the keys set
 * now (canvasProposals liveKeyBilling; GM, PR #203 r15 items 1 and 2), so a
 * token added or removed after the agent proposed shows at once, both ways.
 * A new node is read at the values Accept will write; a canvas node at its
 * params with the proposed changes applied (as useProposalNotReady reads it).
 */
export function useLiveProposalEntry(entry: ProposalEntry | undefined): ProposalEntry | undefined {
  const apiKeys = useUIStore((s) => s.settingsCache.apiKeys);
  // Until this tab has read the keys, the backend's classes stand.
  const loaded = useUIStore((s) => s.settingsCache.loaded);
  // Only the canvas nodes the run names, as text, so a drag elsewhere
  // doesn't re-render the bar or the ghosts.
  const named = useGraphStore((s) => {
    const ids = new Set((entry?.view.cost.nodes ?? []).map((row) => row.nodeId).filter(Boolean));
    if (ids.size === 0) return '[]';
    return JSON.stringify(s.nodes.filter((node) => ids.has(node.id)).map((node) => [node.id, node.data.params ?? {}]));
  });
  return useMemo(() => {
    if (!entry || !loaded) return entry;
    const { view, values } = entry;
    const canvas = new Map(JSON.parse(named) as Array<[string, Record<string, unknown>]>);
    const view2 = liveKeyBilling(view, apiKeys ?? {}, (ref, nodeId) => {
      if (nodeId === null) return values?.nodes[ref] ?? view.nodes.find((node) => node.ref === ref)?.params ?? null;
      const base = canvas.get(nodeId);
      if (!base) return null;
      const changes = values?.params[nodeId] ?? view.params.find((change) => change.nodeId === nodeId)?.changes ?? {};
      return { ...base, ...Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.to])) };
    });
    return view2 === view ? entry : { ...entry, view: view2 };
  }, [entry, apiKeys, loaded, named]);
}
