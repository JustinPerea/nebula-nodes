import { v4 as uuidv4 } from 'uuid';
import type { Edge, Node } from '@xyflow/react';
import { apiFetch, rewriteBackendAssetUrls } from './backend';
import { nodeKeyStatus } from './kreaConnection';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { shotPortId } from '../constants/ports';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { cinemaMotionSource, cinemaMotionTarget, useCinemaMotionStore, type CinemaMotionHandoff } from '../store/cinemaMotionStore';
import type { NodeData } from '../types';

const controllers = new Map<string, AbortController>();
const CLI_ID_RE = /^n\d+$/;

function owns(handoff: CinemaMotionHandoff) {
  return !useGraphStore.getState().isImportingGraph
    && useCinemaMotionStore.getState().handoffs.some((item) => item.attempt === handoff.attempt && item.status === 'pending')
    && Boolean(cinemaMotionSource(useGraphStore.getState().nodes, handoff.nodeId, handoff.shotId));
}

function replace(handoff: CinemaMotionHandoff) {
  useCinemaMotionStore.getState().setHandoffs((items) => [
    ...items.filter((item) => item.nodeId !== handoff.nodeId || item.shotId !== handoff.shotId), handoff,
  ]);
}

function validatedResponse(value: unknown, handoff: CinemaMotionHandoff): { node: Node<NodeData>; edge: Edge } {
  if (!value || typeof value !== 'object') throw new Error('Could not confirm the video connection. Retry to check it.');
  const result = value as { node?: Node<NodeData>; edge?: Edge };
  const { node, edge } = result;
  if (!node || typeof node.id !== 'string' || !CLI_ID_RE.test(node.id) || node.id === handoff.nodeId
    || node.data?.definitionId !== 'veo-3' || !node.data.params || !node.data.outputs
    || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
    || !edge || typeof edge.id !== 'string' || !edge.id
    || edge.source !== handoff.nodeId || edge.sourceHandle !== shotPortId(handoff.shotId)
    || edge.target !== node.id || edge.targetHandle !== 'image' || edge.data?.dataType !== 'Image') {
    throw new Error('Could not confirm the video connection. Retry to check it.');
  }
  return rewriteBackendAssetUrls({ node, edge });
}

/** Create or recover a connected video node. This never submits generation. */
export async function sendCinemaShotToMotion(nodeId: string, shotId: string): Promise<void> {
  const graph = useGraphStore.getState();
  if (graph.isImportingGraph) return;
  const previous = useCinemaMotionStore.getState().handoffs.find((item) => item.nodeId === nodeId && item.shotId === shotId);
  if (previous?.status === 'pending') return;
  const source = cinemaMotionSource(graph.nodes, nodeId, shotId);
  if (!source || source.shot.output?.status !== 'done' || !source.shot.output.imageUrl) return;
  const handoff: CinemaMotionHandoff = { nodeId, shotId, attempt: uuidv4(), status: 'pending',
    graphRevision: useCinemaMotionStore.getState().graphRevision };
  replace(handoff); // Reserve synchronously, including rapid keyboard/pointer repeats.

  const controller = new AbortController();
  controllers.set(handoff.attempt, controller);
  try {
    let targetId: string | null;
    if (!CLI_ID_RE.test(nodeId)) {
      // A frontend-only scene needs a frontend-only pair. A server-created
      // destination cannot be wired to a source the server does not know.
      targetId = graph.addLocalCinemaMotionNode(nodeId, shotId);
    } else {
      const response = await apiFetch('/api/cinema/send-to-motion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ nodeId, shotId, expectedImageUrl: source.shot.output.imageUrl }),
      });
      if (!owns(handoff)) return;
      if (!response.ok) {
        throw new Error(response.status === 409
          ? 'The shot changed before it could be connected. Retry with the current result.'
          : 'Could not connect the video node. Retry to check the connection.');
      }
      const result = validatedResponse(await response.json(), handoff);
      if (!owns(handoff)) return;
      const live = useGraphStore.getState();
      const existingTarget = live.nodes.find((node) => node.id === result.node.id);
      if ((existingTarget && existingTarget.data.definitionId !== 'veo-3')
        || (useCinemaMotionStore.getState().graphRevision !== handoff.graphRevision
          && !cinemaMotionTarget(live.nodes, live.edges, nodeId, shotId, result.node.id))) {
        // A newer authoritative graph can omit a pair deleted after the POST
        // committed. Its older HTTP reply cannot put that pair back. Retry
        // asks the idempotent endpoint to confirm today's connection.
        throw new Error('Could not confirm the current video connection. Retry to check it.');
      }
      // Adopt only the confirmed pair when its socket event is delayed. Never
      // replace current source authoring or an already hydrated target's edits.
      useGraphStore.setState((current) => ({
        nodes: current.nodes.some((node) => node.id === result.node.id) ? current.nodes : [
          ...current.nodes, { ...result.node, data: { ...result.node.data,
            keyStatus: nodeKeyStatus(NODE_DEFINITIONS['veo-3'], result.node.data.params, useUIStore.getState().settingsCache) } },
        ],
        edges: current.edges.some((edge) => edge.source === result.edge.source && edge.sourceHandle === result.edge.sourceHandle
          && edge.target === result.edge.target && edge.targetHandle === result.edge.targetHandle)
          ? current.edges : [...current.edges, result.edge],
      }));
      targetId = result.node.id;
    }
    if (!owns(handoff)) return;
    const current = useGraphStore.getState();
    if (!targetId || !cinemaMotionTarget(current.nodes, current.edges, nodeId, shotId, targetId)) {
      throw new Error('Could not confirm the video connection. Retry to check it.');
    }
    replace({ ...handoff, status: 'ready', targetId });
  } catch (error) {
    if (!owns(handoff)) return;
    replace({ ...handoff, status: 'error', error: error instanceof Error
      && (error.message.startsWith('Could not') || error.message.startsWith('The shot changed')) ? error.message
      : 'Could not confirm the video connection. Retry to check it.' });
  } finally { controllers.delete(handoff.attempt); }
}

export function viewCinemaMotionNode(nodeId: string, shotId: string) {
  const graph = useGraphStore.getState();
  if (graph.isImportingGraph || !cinemaMotionSource(graph.nodes, nodeId, shotId)) return;
  const handoff = useCinemaMotionStore.getState().handoffs.find((item) => item.nodeId === nodeId && item.shotId === shotId);
  const targetId = handoff?.status === 'ready'
    ? cinemaMotionTarget(graph.nodes, graph.edges, nodeId, shotId, handoff.targetId) : null;
  if (targetId) useUIStore.getState().requestCanvasNodeFocus(targetId);
}

useCinemaMotionStore.subscribe((state, previous) => {
  for (const item of previous.handoffs) {
    if (state.handoffs.some((next) => next.attempt === item.attempt && next.status === 'pending')) continue;
    controllers.get(item.attempt)?.abort();
    controllers.delete(item.attempt);
  }
});
