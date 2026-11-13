import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { runsNothing, withAncestors } from './canvasProposals';
import { acceptKeyLockPhraseLine, type LockSettings } from './runKeyLock';
import { nodesThatRun, type RunScope } from './runScope';
import type { ProposalPersonValues, ProposalView } from './wsClient';

interface CanvasGraph {
  nodes: readonly Node<NodeData>[];
  edges: readonly Edge[];
}

/**
 * The canvas as Accept would leave it: the proposal's nodes (by ref) at the
 * values Accept writes, the canvas's nodes with the proposed param changes,
 * and both sets of wires.
 */
function acceptedGraph(view: ProposalView, values: ProposalPersonValues | undefined, canvas: CanvasGraph): {
  nodes: Node<NodeData>[];
  edges: Edge[];
} {
  const changed = new Map<string, Record<string, unknown>>();
  for (const change of view.params) {
    const changes = values?.params[change.nodeId] ?? change.changes;
    changed.set(change.nodeId, Object.fromEntries(Object.entries(changes).map(([key, diff]) => [key, diff.to])));
  }
  const nodes: Node<NodeData>[] = canvas.nodes.map((node) => {
    const proposed = changed.get(node.id);
    return proposed ? { ...node, data: { ...node.data, params: { ...node.data?.params, ...proposed } } } : node;
  });
  for (const ghost of view.nodes) {
    nodes.push({ id: ghost.ref, type: 'model-node', position: ghost.position,
      data: { label: ghost.name, definitionId: ghost.definitionId, params: values?.nodes[ghost.ref] ?? ghost.params,
        outputs: {}, state: 'idle' } } as Node<NodeData>);
  }
  const edges: Edge[] = [...canvas.edges];
  view.edges.forEach((edge, index) => {
    edges.push({ id: `proposal-edge-${index}`, ...edge });
  });
  return { nodes, edges };
}

/**
 * GM, PR #203 r6 item 1, and review r4 LOW-1/LOW-2: Accept is locked while
 * the run it starts would run a node that can't start without its key (a
 * keyed route's missing key): "You can accept this after you add your
 * Hugging Face token in Settings." Read from the run itself, as Accept runs
 * it (canvasProposalsStore runNodes: one node with what feeds it, several as
 * a cluster with their ancestors), on the canvas as Accept leaves it, and
 * with the keys set now, so a token removed after the proposal was made
 * locks it. Null when it can run, nothing runs, or Settings haven't loaded.
 */
export function proposalAcceptLock(
  view: ProposalView,
  values: ProposalPersonValues | undefined,
  canvas: CanvasGraph,
  settings: LockSettings,
): string | null {
  if (!settings.loaded || view.run.length === 0 || runsNothing(view)) return null;
  const { nodes, edges } = acceptedGraph(view, values, canvas);
  const scope: RunScope = view.run.length === 1
    ? { kind: 'node', nodeId: view.run[0], direct: false }
    : { kind: 'cluster', nodeIds: withAncestors(view.run, edges) };
  return acceptKeyLockPhraseLine(nodesThatRun(nodes, edges, scope), settings);
}
