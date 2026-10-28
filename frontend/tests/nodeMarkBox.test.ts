import { afterEach, describe, expect, it } from 'vitest';

/**
 * Where the agent's pill anchors (Q125 item 3). GM - Design, 2026-10-25:
 * "a 6 px gap above the node's top edge". The node's React Flow box starts
 * about 38 px above the drawn card (room for the floating settings bar), so
 * the live check showed a 40 px gap: the pill anchors on the card. When the
 * settings bar is up (the node is selected with others), it anchors above
 * the bar instead, so the two never overlap.
 */

const { nodeMarkBox } = await import('../src/components/canvas/nodeCardBox');

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function mount(id: string, { bar }: { bar: boolean }) {
  const el = document.createElement('div');
  el.className = 'react-flow__node';
  el.dataset.id = id;
  el.getBoundingClientRect = () => rect(200, 100, 480, 400); // zoom 2: 240 x 200 flow units
  if (bar) {
    const settings = document.createElement('div');
    settings.className = 'model-node__settings-bar';
    settings.getBoundingClientRect = () => rect(200, 110, 300, 40);
    el.appendChild(settings);
  }
  const card = document.createElement('div');
  card.className = 'model-node__card';
  card.getBoundingClientRect = () => rect(200, 176, 480, 324);
  el.appendChild(card);
  document.body.appendChild(el);
}

const state = (id: string) => ({
  transform: [0, 0, 2] as [number, number, number],
  nodeLookup: new Map([[id, { measured: { width: 240, height: 200 }, internals: { positionAbsolute: { x: 10, y: 20 } } }]]),
}) as never;

afterEach(() => { document.body.innerHTML = ''; });

describe('nodeMarkBox', () => {
  it("anchors on the drawn card's top edge, not the node box's", () => {
    mount('n4', { bar: false });
    expect(nodeMarkBox(state('n4'), 'n4')).toEqual({ x: 10, y: 20 + 38, width: 240, height: 162 });
  });

  it('anchors above the settings bar while it floats over the card', () => {
    mount('n4', { bar: true });
    expect(nodeMarkBox(state('n4'), 'n4')).toEqual({ x: 10, y: 20 + 5, width: 240, height: 162 + 33 });
  });

  it('falls back to the node box when nothing is drawn', () => {
    expect(nodeMarkBox(state('n9'), 'n9')).toEqual({ x: 10, y: 20, width: 240, height: 200 });
  });
});
