import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';

export interface RunScopeSummary {
  /** Nodes the run would execute. */
  total: number;
  /** Display names of nodes that call an external (paid) provider. */
  paid: string[];
}

/**
 * Mirrors the stores' run scopes so Run buttons can say what they will do:
 * the whole graph; one target plus every node feeding it; or an explicit
 * cluster. A node is paid when its provider is anything but local tools.
 */
export function summarizeRunScope(
  nodes: Node<NodeData>[],
  edges: Edge[],
  scope: { kind: 'graph' } | { kind: 'node'; nodeId: string } | { kind: 'cluster'; nodeIds: string[] },
): RunScopeSummary {
  let included: Node<NodeData>[];
  if (scope.kind === 'graph') {
    included = nodes;
  } else if (scope.kind === 'cluster') {
    const ids = new Set(scope.nodeIds);
    included = nodes.filter((node) => ids.has(node.id));
  } else {
    const ids = new Set([scope.nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (ids.has(edge.target) && !ids.has(edge.source)) {
          ids.add(edge.source);
          changed = true;
        }
      }
    }
    included = nodes.filter((node) => ids.has(node.id));
  }

  const paid: string[] = [];
  for (const node of included) {
    const definition = node.data?.definitionId ? NODE_DEFINITIONS[node.data.definitionId] : undefined;
    if (definition && definition.apiProvider !== 'utility') paid.push(node.data.label || definition.displayName);
  }
  return { total: included.length, paid };
}

/** "Runs 2 nodes · 1 calls a paid provider: GPT Image 2.5". */
export function describeRunScope({ total, paid }: RunScopeSummary): string {
  const nodes = `${total} ${total === 1 ? 'node' : 'nodes'}`;
  if (paid.length === 0) return `Runs ${nodes} · no paid providers`;
  const names = paid.length <= 3 ? paid.join(', ') : `${paid.slice(0, 3).join(', ')} and ${paid.length - 3} more`;
  return `Runs ${nodes} · ${paid.length} ${paid.length === 1 ? 'calls a paid provider' : 'call paid providers'}: ${names}`;
}
