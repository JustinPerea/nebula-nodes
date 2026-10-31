import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { cleanPending } from './pendingNodes';
import { currentRunSnapshot, type RunRecord } from './runHistory';
import { canKeyLock, runKeyLockNodeLine, type LockSettings } from './runKeyLock';

/**
 * A Run History replay's key lock (GM, PR #203 r8 item 3): the saved graph a
 * Rerun or Retry sends (each saved node at its saved settings, an agent's
 * placeholder still marked as the live canvas has it), over what that replay
 * would run (a node's replay with what feeds it, a whole-canvas replay
 * without agents' placeholders), with the keys set now. "You can run X
 * after you add your Hugging Face token in Settings." The replay's store path
 * refuses the same way as a backstop. Null when it can run.
 *
 * Here, not in the graph store, so the panel that shows it doesn't import
 * the store's module for one read.
 */
export function historyRunKeyLock(record: RunRecord, live: readonly Node<NodeData>[], settings: LockSettings): string | null {
  if (!settings.loaded) return null;
  const snapshot = currentRunSnapshot(record);
  // Most replays hold no node a key can lock: nothing more to read.
  if (!snapshot.nodes.some((saved) => canKeyLock(saved.definitionId))) return null;
  const byId = new Map(live.map((node) => [node.id, node]));
  const nodes = snapshot.nodes.map((saved) => {
    const flag = cleanPending(byId.get(saved.id)?.data?.pending);
    return {
      id: saved.id, type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: saved.definitionId, label: '', params: saved.params, state: 'idle', outputs: {},
        ...(flag ? { pending: flag } : {}) },
    } as Node<NodeData>;
  });
  const edges = snapshot.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null })) as Edge[];
  const target = record.cinemaShot?.nodeId ?? record.targetNodeId;
  return runKeyLockNodeLine(nodes, edges, target ? { kind: 'node', nodeId: target } : { kind: 'graph' }, settings);
}

/** The live canvas's agent placeholders, as a key that changes only when one
 * comes or goes (not on a drag): the one thing of the live canvas a replay's
 * lock reads (review r5 NIT-1 of PR #203). */
export function placeholderKey(live: readonly Node<NodeData>[]): string {
  return live.filter((node) => cleanPending(node.data?.pending)).map((node) => node.id).sort().join(' ');
}
