import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { allCardChunksLoaded, cardChunksOf, ownCardChunk, type CardChunk } from './cardChunks';
import { fallbackNode, markSwap } from './cardFallback';
import { canvasGeneration } from '../store/graphStore';

/**
 * The hold at the canvas: nothing a person can see in a canvas's first frame
 * may pop in later, so a node whose card chunks (lib/cardChunks.ts) have not
 * settled is not drawn as its card yet.
 *
 * - A whole graph put on the canvas (the store's canvasGeneration moved: a
 *   project open, a reload's restore, an import, the sample graph, an agent's
 *   switch) is handed over only when every node of it can draw; until then
 *   React Flow gets nothing and the canvas says it is loading.
 * - A node added to a graph already shown is handed over at once as a
 *   fallback card (lib/cardFallback.ts): its frame, name and ports, with its
 *   wires, and the real card replaces it when its chunks settle.
 * - A node whose own card chunk failed to load is a fallback card too, with
 *   the line that says why (components/nodes/CardFallback.tsx); it retries on
 *   focus and when the browser is back online, and the real card replaces the
 *   frame when a retry works.
 * - A whole-graph hold has a ceiling (HOLD_CEILING_MS): a chunk request that
 *   hangs, neither loading nor failing, must not keep a graph off the canvas
 *   for as long as the browser lets it sit. Past the ceiling the graph is
 *   handed over like a node added later: the nodes whose chunks are in draw as
 *   their cards, the others as fallback frames, and each card replaces its
 *   frame when its chunk arrives. A new graph starts a new ceiling.
 * - With every card chunk loaded (the ordinary case after the idle preload)
 *   the inputs come back by identity and no node is looked at.
 *
 * Only what React Flow draws changes; the graph store is never written.
 */

export interface HoldState {
  /** The canvasGeneration of the graph last handed over; -1 before the first. */
  readonly generation: number;
  /** The nodes handed over as their real card last time: they stay drawn even if a chunk is retried. */
  readonly handed: readonly Node[];
  /** The nodes handed over as a fallback card last time. */
  readonly placeholders: ReadonlySet<string>;
}

export interface HeldGraph {
  readonly nodes: Node[];
  readonly edges: Edge[];
  /** Chunks still being waited on; empty when nothing is held back. */
  readonly waiting: readonly CardChunk[];
  /** Chunks whose settling changes what is drawn: the ones waited on, and failed ones a retry may bring in. */
  readonly watching: readonly CardChunk[];
  /** Nothing of a whole graph is handed over yet. */
  readonly wholeGraph: boolean;
  /** Nodes that were a fallback card last time and are their real card now. */
  readonly swapped: readonly string[];
  readonly state: HoldState;
}

/** How long a whole graph may be held back for card chunks before it is handed over with frames for what is still missing. */
export const HOLD_CEILING_MS = 8000;

const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];
const NO_CHUNKS: readonly CardChunk[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Pure core of the hold; `generation` is the store's canvasGeneration() now,
 * and `ceilingPassed` is whether the whole-graph hold of this generation has
 * lasted HOLD_CEILING_MS (the graph is then handed over with frames).
 */
export function holdCards(nodes: Node[], edges: Edge[], generation: number, previous: HoldState, ceilingPassed = false): HeldGraph {
  const swappedOf = (placeholders: ReadonlySet<string>, ids: readonly string[]): string[] =>
    previous.placeholders.size === 0 ? [] : ids.filter((id) => previous.placeholders.has(id) && !placeholders.has(id));
  if (allCardChunksLoaded()) {
    const swapped = previous.placeholders.size === 0 ? [] : swappedOf(NO_IDS, nodes.map((node) => node.id));
    return { nodes, edges, waiting: NO_CHUNKS, watching: NO_CHUNKS, wholeGraph: false, swapped, state: { generation, handed: nodes, placeholders: NO_IDS } };
  }
  const replaced = generation !== previous.generation;
  const kept = replaced ? null : new Set(previous.handed.map((node) => node.id));
  const waiting = new Set<CardChunk>();
  const watching = new Set<CardChunk>();
  const placeholders = new Set<string>();
  const real: Node[] = [];
  const drawn: Node[] = [];
  for (const node of nodes) {
    if (kept?.has(node.id)) {
      drawn.push(node);
      real.push(node);
      continue;
    }
    const open = cardChunksOf(node).filter((chunk) => !chunk.isSettled());
    const own = ownCardChunk(node);
    // Settled and not loaded: the load failed.
    const failed = own !== undefined && !own.isLoaded() && own.isSettled();
    if (open.length > 0 || failed) {
      for (const chunk of open) { waiting.add(chunk); watching.add(chunk); }
      if (failed && own) watching.add(own);
      placeholders.add(node.id);
      drawn.push(fallbackNode(node));
    } else {
      drawn.push(node);
      real.push(node);
    }
  }
  if (replaced && waiting.size > 0 && !ceilingPassed) {
    // The whole graph waits; the previous graph's nodes are not this graph's.
    return {
      nodes: NO_NODES, edges: NO_EDGES, waiting: [...waiting], watching: [...watching], wholeGraph: true, swapped: [],
      state: { generation: previous.generation, handed: NO_NODES, placeholders: NO_IDS },
    };
  }
  return {
    nodes: placeholders.size === 0 ? nodes : drawn,
    edges,
    waiting: waiting.size === 0 ? NO_CHUNKS : [...waiting],
    watching: watching.size === 0 ? NO_CHUNKS : [...watching],
    wholeGraph: false,
    swapped: swappedOf(placeholders, nodes.map((node) => node.id)),
    state: { generation, handed: placeholders.size === 0 ? nodes : real, placeholders },
  };
}

export interface CardHold {
  readonly nodes: Node[];
  readonly edges: Edge[];
  /** A whole graph is waiting on chunks: the canvas is not empty, it is loading. */
  readonly holding: boolean;
  /** Whether any chunk is being waited on (a whole graph or a node added later). */
  readonly waiting: boolean;
}

const START: HoldState = { generation: -1, handed: NO_NODES, placeholders: NO_IDS };

/** The hold as a hook: re-renders when a chunk it watches settles, and asks for the chunks it waits on to load. */
export function useCardHold(nodes: Node[], edges: Edge[]): CardHold {
  const [settled, onSettled] = useReducer((count: number) => count + 1, 0);
  const state = useRef<HoldState>(START);
  const generation = canvasGeneration();
  // The generation whose whole-graph hold has reached its ceiling.
  const [ceilingOf, setCeilingOf] = useState(-1);
  const ceilingPassed = ceilingOf === generation;
  const held = useMemo(() => {
    const result = holdCards(nodes, edges, generation, state.current, ceilingPassed);
    state.current = result.state;
    for (const id of result.swapped) markSwap(id);
    return result;
    // `settled` is the chunk settle signal; the chunks are read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, generation, settled, ceilingPassed]);

  // The ceiling: runs while a whole graph is held, ends with the hold, and starts over when the generation moves.
  const holdingWhole = held.wholeGraph;
  useEffect(() => {
    if (!holdingWhole) return undefined;
    const timer = window.setTimeout(() => setCeilingOf(generation), HOLD_CEILING_MS);
    return () => window.clearTimeout(timer);
  }, [holdingWhole, generation]);

  const { waiting, watching } = held;
  useEffect(() => {
    if (watching.length === 0) return undefined;
    const unsubscribe = watching.map((chunk) => chunk.onSettle(onSettled));
    // One may have settled between the render and this subscription.
    if (waiting.some((chunk) => chunk.isSettled())) onSettled();
    // A hold must end: ask for the chunks again (the same attempt, if one is running).
    for (const chunk of waiting) void chunk.preload().catch(() => {});
    return () => { for (const off of unsubscribe) off(); };
  }, [watching, waiting]);

  return { nodes: held.nodes, edges: held.edges, holding: held.wholeGraph, waiting: waiting.length > 0 };
}
