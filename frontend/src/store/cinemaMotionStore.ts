import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Edge, Node } from '@xyflow/react';
import { shotPortId } from '../constants/ports';
import type { CinemaSceneSpec, NodeData } from '../types';

export interface CinemaMotionHandoff {
  nodeId: string;
  shotId: string;
  attempt: string;
  graphRevision: number;
  status: 'pending' | 'error' | 'ready';
  targetId?: string;
  error?: string;
}

export function cinemaMotionSource(nodes: Node<NodeData>[], nodeId: string, shotId: string) {
  const node = nodes.find((item) => item.id === nodeId && item.data.definitionId === 'cinema-scene');
  const scene = node?.data.params.scene as CinemaSceneSpec | undefined;
  const shot = Array.isArray(scene?.shots) ? scene.shots.find((item) => item.id === shotId) : undefined;
  return node && shot ? { node, shot } : null;
}

export function cinemaMotionTarget(nodes: Node<NodeData>[], edges: Edge[], nodeId: string, shotId: string, targetId?: string) {
  return edges.find((edge) => edge.source === nodeId && edge.sourceHandle === shotPortId(shotId)
    && edge.targetHandle === 'image' && (!targetId || edge.target === targetId)
    && nodes.some((node) => node.id === edge.target && node.data.definitionId === 'veo-3'))?.target ?? null;
}

/** Page-memory feedback belongs to its shot, not the mounted editor panel.
 * The graph connection supplies durable retry identity; no history or secret storage. */
export const useCinemaMotionStore = create<{
  handoffs: CinemaMotionHandoff[];
  graphRevision: number;
  observeGraphSync: () => void;
  setHandoffs: (update: (items: CinemaMotionHandoff[]) => CinemaMotionHandoff[]) => void;
  clear: () => void;
  interruptPending: () => void;
  reconcile: (nodes: Node<NodeData>[], edges: Edge[]) => void;
}>((set, get) => ({
  handoffs: [],
  graphRevision: 0,
  observeGraphSync: () => set({ graphRevision: get().graphRevision + 1 }),
  setHandoffs: (update) => set({ handoffs: update(get().handoffs) }),
  clear: () => set({ handoffs: [] }),
  interruptPending: () => set({ handoffs: get().handoffs.map((item) => item.status === 'pending'
    ? { ...item, attempt: uuidv4(), status: 'error', error: 'Connection interrupted by graph import. Retry after the import finishes.' }
    : item) }),
  reconcile: (nodes, edges) => {
    const current = get().handoffs;
    const next = current.flatMap((item): CinemaMotionHandoff[] => {
      if (!cinemaMotionSource(nodes, item.nodeId, item.shotId)) return [];
      const confirmed = item.status === 'pending' ? cinemaMotionTarget(nodes, edges, item.nodeId, item.shotId) : null;
      if (confirmed) return [{ ...item, status: 'ready', targetId: confirmed }];
      if (item.status === 'ready' && !cinemaMotionTarget(nodes, edges, item.nodeId, item.shotId, item.targetId)) {
        return [{ ...item, status: 'error', targetId: undefined,
          error: 'The video connection was removed. Retry to connect a video node.' }];
      }
      return [item];
    });
    if (next.length !== current.length || next.some((item, index) => item !== current[index])) set({ handoffs: next });
  },
}));
