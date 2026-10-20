/**
 * Gates on the canvas. A gate node (Jev Decide) has conditional output ports
 * (`conditional: true` on the port definition). After a run, each one either
 * carried a value or was withheld, and the backend skipped every node wired
 * to a withheld port, plus their descendants (backend/execution/gating.py).
 */
import type { NodeData } from '../types';
import type { Node } from '@xyflow/react';
import { nodeById } from './graphIndex';

export const SKIPPED_FALLBACK_REASON = 'a gate upstream withheld its input';

/** "Skipped: Jev Decide failed (answered no, 0.12)". */
export function skippedLabel(reason: string | undefined): string {
  return `Skipped: ${reason?.trim() || SKIPPED_FALLBACK_REASON}`;
}

/** A wire draws as inactive when its source port was withheld in the latest
 * run, or its source node was itself skipped. */
export function isInactiveEdge(
  source: Pick<NodeData, 'state' | 'withheldPorts'> | undefined,
  sourceHandle: string | null | undefined,
): boolean {
  if (!source) return false;
  if (source.state === 'skipped') return true;
  return Boolean(sourceHandle && source.withheldPorts && sourceHandle in source.withheldPorts);
}

/** The same check from the store's node list, for one edge. */
export function edgeIsInactive(
  nodes: readonly Node<NodeData>[], sourceId: string, sourceHandle: string | null | undefined,
): boolean {
  // Every wire's TypedEdge runs this on every store change: a map lookup, not a scan.
  const source = nodeById(nodes, sourceId);
  return isInactiveEdge(source?.data, sourceHandle);
}

/** Why a wire is inactive, for its hover title. */
export function inactiveEdgeReason(
  source: Pick<NodeData, 'state' | 'withheldPorts' | 'skipReason'> | undefined,
  sourceHandle: string | null | undefined,
): string | null {
  if (!source) return null;
  if (source.state === 'skipped') return skippedLabel(source.skipReason);
  const reason = sourceHandle ? source.withheldPorts?.[sourceHandle] : undefined;
  return reason ? `Withheld: ${reason}` : null;
}
