import type { ReactFlowState } from '@xyflow/react';

export interface NodeBox { x: number; y: number; width: number; height: number }

/** The node's box as React Flow lays it out, in flow units (its category label included). */
export function nodeFlowBox(state: Pick<ReactFlowState, 'nodeLookup'>, id: string): NodeBox | null {
  const internal = state.nodeLookup.get(id);
  if (!internal) return null;
  const position = internal.internals?.positionAbsolute;
  const width = internal.measured?.width ?? internal.width;
  const height = internal.measured?.height ?? internal.height;
  if (!position || !width || !height) return null;
  return { x: position.x, y: position.y, width, height };
}

/**
 * The node's card in flow units. A model node's box starts at its small
 * category label, about 38 px above the card (lib/canvasPins.ts), so this
 * measures the drawn `.model-node__card` inside it when there is one.
 */
export function nodeCardBox(state: Pick<ReactFlowState, 'nodeLookup' | 'transform'>, id: string): NodeBox | null {
  const box = nodeFlowBox(state, id);
  if (!box || typeof document === 'undefined') return box;
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const card = el?.querySelector('.model-node__card');
  if (!el || !card) return box;
  const outer = el.getBoundingClientRect();
  const inner = card.getBoundingClientRect();
  const zoom = state.transform[2] || 1;
  if (!outer.width || !inner.width || !inner.height) return box;
  return {
    x: box.x + (inner.left - outer.left) / zoom,
    y: box.y + (inner.top - outer.top) / zoom,
    width: inner.width / zoom,
    height: inner.height / zoom,
  };
}

/**
 * Where an agent's pill anchors (AgentNodeMarkLayer): the drawn card, so
 * the pill's 6 px gap is above the edge the person sees (GM - Design,
 * 2026-10-25), not above the empty room the node box keeps for its settings
 * bar. While that bar floats over the card (the node selected with others),
 * the box starts at the bar, so the pill sits above it and never covers it.
 */
export function nodeMarkBox(state: Pick<ReactFlowState, 'nodeLookup' | 'transform'>, id: string): NodeBox | null {
  const card = nodeCardBox(state, id);
  if (!card || typeof document === 'undefined') return card;
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const bar = el?.querySelector('.model-node__settings-bar');
  const flow = nodeFlowBox(state, id);
  if (!el || !bar || !flow) return card;
  const zoom = state.transform[2] || 1;
  const top = flow.y + (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoom;
  if (!(top < card.y)) return card;
  return { ...card, y: top, height: card.y + card.height - top };
}
