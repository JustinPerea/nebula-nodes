import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { allCardChunksSettled, cardChunksOf, type CardChunk } from './cardChunks';
import { canvasGeneration } from '../store/graphStore';

/**
 * The hold at the canvas: nothing a person can see in a canvas's first frame
 * may pop in later, so a node whose card chunks (lib/cardChunks.ts) have not
 * settled is not handed to React Flow yet.
 *
 * - A whole graph put on the canvas (the store's canvasGeneration moved: a
 *   project open, a reload's restore, an import, the sample graph, an agent's
 *   switch) is handed over only when every node of it can draw; until then
 *   React Flow gets nothing and the canvas says it is loading.
 * - A node added to a graph already shown is left out, with its wires, until
 *   its chunks settle; the others are not touched.
 * - A chunk that failed to load counts as settled: the card draws nothing and
 *   retries (DeferredBoundary), and the canvas never waits on it.
 * - With every card chunk settled (the ordinary case after the idle preload)
 *   the inputs come back by identity and no node is looked at.
 *
 * Only what React Flow draws changes; the graph store is never written.
 */

export interface HoldState {
  /** The canvasGeneration of the graph last handed over; -1 before the first. */
  readonly generation: number;
  /** The nodes handed over last time: they stay drawn even if a chunk is retried. */
  readonly handed: readonly Node[];
}

export interface HeldGraph {
  readonly nodes: Node[];
  readonly edges: Edge[];
  /** Chunks still being waited on; empty when nothing is held back. */
  readonly waiting: readonly CardChunk[];
  /** Nothing of a whole graph is handed over yet. */
  readonly wholeGraph: boolean;
  readonly state: HoldState;
}

const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];
const NO_CHUNKS: readonly CardChunk[] = [];

/** Pure core of the hold; `generation` is the store's canvasGeneration() now. */
export function holdCards(nodes: Node[], edges: Edge[], generation: number, previous: HoldState): HeldGraph {
  if (allCardChunksSettled()) {
    return { nodes, edges, waiting: NO_CHUNKS, wholeGraph: false, state: { generation, handed: nodes } };
  }
  const replaced = generation !== previous.generation;
  const shown = replaced ? null : new Set(previous.handed.map((node) => node.id));
  const needs = new Map<string, readonly CardChunk[]>();
  const waiting = new Set<CardChunk>();
  const drawable = new Set<string>();
  for (const node of nodes) {
    const open = cardChunksOf(node).filter((chunk) => !chunk.isSettled());
    needs.set(node.id, open);
    if (open.length === 0 || shown?.has(node.id)) drawable.add(node.id);
    else for (const chunk of open) waiting.add(chunk);
  }
  if (waiting.size === 0) {
    return { nodes, edges, waiting: NO_CHUNKS, wholeGraph: false, state: { generation, handed: nodes } };
  }
  if (replaced) {
    // The whole graph waits; the previous graph's nodes are not this graph's.
    return { nodes: NO_NODES, edges: NO_EDGES, waiting: [...waiting], wholeGraph: true, state: { generation: previous.generation, handed: NO_NODES } };
  }
  const shownNodes = nodes.filter((node) => drawable.has(node.id));
  const shownEdges = edges.filter((edge) => drawable.has(edge.source) && drawable.has(edge.target));
  return { nodes: shownNodes, edges: shownEdges, waiting: [...waiting], wholeGraph: false, state: { generation, handed: shownNodes } };
}

export interface CardHold {
  readonly nodes: Node[];
  readonly edges: Edge[];
  /** A whole graph is waiting on chunks: the canvas is not empty, it is loading. */
  readonly holding: boolean;
  /** Whether any chunk is being waited on (a whole graph or a node added later). */
  readonly waiting: boolean;
}

const START: HoldState = { generation: -1, handed: NO_NODES };

/** The hold as a hook: re-renders when a chunk it waits on settles, and asks for those chunks to load. */
export function useCardHold(nodes: Node[], edges: Edge[]): CardHold {
  const [settled, onSettled] = useReducer((count: number) => count + 1, 0);
  const state = useRef<HoldState>(START);
  const generation = canvasGeneration();
  const held = useMemo(() => {
    const result = holdCards(nodes, edges, generation, state.current);
    state.current = result.state;
    return result;
    // `settled` is the chunk settle signal; the chunks are read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, generation, settled]);

  const { waiting } = held;
  useEffect(() => {
    if (waiting.length === 0) return undefined;
    const unsubscribe = waiting.map((chunk) => chunk.onSettle(onSettled));
    // One may have settled between the render and this subscription.
    if (waiting.some((chunk) => chunk.isSettled())) onSettled();
    // A hold must end: ask for the chunks again (the same attempt, if one is running).
    for (const chunk of waiting) void chunk.preload().catch(() => {});
    return () => { for (const off of unsubscribe) off(); };
  }, [waiting]);

  return { nodes: held.nodes, edges: held.edges, holding: held.wholeGraph, waiting: waiting.length > 0 };
}
