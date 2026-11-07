import { describe, expect, it } from 'vitest';
import { chainPoint, HEADER_ICON_X, nodeHeaderPoint, resolveAnchor, restPoints, waitRestPoint } from '../src/lib/agentCursorMotion';

/**
 * GM - Design, PR #212 round 3, item 2: while a node's header shows the wait,
 * the cursor is drawn at the header's left end (tip over the icon); the point
 * it counts as for its target chain stays the header's middle, which is what
 * the backend counts (agent_presence._header_point, the same split as a port's).
 */
const node = (x: number, y: number, width: number, height: number, handle?: { id: string; x: number; y: number }) => new Map([
  ['n1', {
    id: 'n1', measured: { width, height },
    internals: { positionAbsolute: { x, y }, handleBounds: { source: handle ? [{ id: handle.id, x: handle.x, y: handle.y, width: 10, height: 10 }] : [], target: [] } },
  }],
]) as never;

describe('the cursor\'s drawn rest while a node\'s header waits', () => {
  it.each([[200, 120], [156, 129], [320, 60]])('is the header\'s left end at the icon, on the header\'s row (%i x %i)', (w, h) => {
    const lookup = node(400, 300, w, h);
    const drawn = waitRestPoint({ nodeId: 'n1' }, lookup)!;
    expect(drawn.x).toBe(400 + HEADER_ICON_X);
    expect(drawn.y).toBe(nodeHeaderPoint(400, 300, w, h).y);
    // Left of the header's middle, never past it: the label is on the right.
    expect(drawn.x).toBeLessThan(nodeHeaderPoint(400, 300, w, h).x);
  });

  it('leaves what it counts as for its chain at the header\'s middle, as the backend counts it', () => {
    const lookup = node(400, 300, 200, 120);
    expect(chainPoint({ nodeId: 'n1' }, lookup)).toEqual({ x: 500, y: 344 });
    expect(resolveAnchor({ nodeId: 'n1' }, lookup)).toEqual({ x: 500, y: 344 });
    expect(waitRestPoint({ nodeId: 'n1' }, lookup)).not.toEqual(chainPoint({ nodeId: 'n1' }, lookup));
  });

  it('is nothing for a port, a point, or a node that is not drawn', () => {
    expect(waitRestPoint({ nodeId: 'n1', handle: 'text' }, node(0, 0, 200, 120, { id: 'text', x: 185, y: 100 }))).toBeNull();
    expect(waitRestPoint({ x: 5, y: 6 }, node(0, 0, 200, 120))).toBeNull();
    expect(waitRestPoint({ nodeId: 'gone' }, node(0, 0, 200, 120))).toBeNull();
  });
});

describe('the two points a cursor has on a node (drawn, counted for its chain)', () => {
  it('are one point, the header middle, while the header does not wait', () => {
    const lookup = node(400, 300, 200, 120);
    expect(restPoints({ nodeId: 'n1' }, lookup, false)).toEqual({ drawn: { x: 500, y: 344 }, chain: { x: 500, y: 344 } });
  });

  it.each([[200, 120], [156, 129], [320, 60]])('split while it waits: drawn at the left end, counted at the header middle (%i x %i)', (w, h) => {
    const lookup = node(400, 300, w, h);
    const { drawn, chain } = restPoints({ nodeId: 'n1' }, lookup, true)!;
    expect(chain).toEqual(nodeHeaderPoint(400, 300, w, h));
    expect(drawn).toEqual({ x: 400 + HEADER_ICON_X, y: chain.y });
    expect(drawn.x).toBeLessThan(chain.x);
  });

  it('keeps a port\'s own split (drawn on the port, counted at the header) and never moves it for a wait', () => {
    const lookup = node(400, 300, 200, 120, { id: 'text', x: 185, y: 100 });
    const asked = restPoints({ nodeId: 'n1', handle: 'text' }, lookup, true)!;
    expect(asked.drawn).toEqual({ x: 400 + 185 + 5, y: 300 + 100 + 5 });
    expect(asked.chain).toEqual({ x: 500, y: 344 });
  });

  it('is null for a node that is not drawn', () => {
    expect(restPoints({ nodeId: 'gone' }, node(0, 0, 200, 120), true)).toBeNull();
  });
});

describe('the spot read from the page', () => {
  const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  function pane(zoom: number) {
    const dom = document.createElement('div');
    dom.innerHTML = '<div class="react-flow__node" data-id="n1"><div class="model-node__header" data-waiting="true"><span class="model-node__type-icon"></span></div></div>';
    const card = dom.querySelector<HTMLElement>('.react-flow__node')!;
    // The card's top-left is the node's flow origin on screen; the icon is 20 in and 55 down, in screen px.
    card.getBoundingClientRect = rect(100, 50, 200 * zoom, 120 * zoom);
    dom.querySelector<HTMLElement>('.model-node__header')!.getBoundingClientRect = rect(100, 50 + 40 * zoom, 200 * zoom, 30 * zoom);
    dom.querySelector<HTMLElement>('.model-node__type-icon')!.getBoundingClientRect = rect(100 + 14 * zoom, 50 + 48 * zoom, 13 * zoom, 13 * zoom);
    return { dom, zoom };
  }
  it.each([1, 0.5, 2])('is the icon\'s centre on the header\'s row, in flow units, at zoom %s', (zoom) => {
    const point = waitRestPoint({ nodeId: 'n1' }, node(400, 300, 200, 120), pane(zoom))!;
    expect(point.x).toBeCloseTo(400 + 20.5, 6);
    expect(point.y).toBeCloseTo(300 + 54.5, 6);
  });
  it('falls back to the constants when the header is not on the page or not laid out', () => {
    const lookup = node(400, 300, 200, 120);
    expect(waitRestPoint({ nodeId: 'n1' }, lookup, { dom: document.createElement('div'), zoom: 1 })).toEqual({ x: 418, y: 344 });
    const unlaid = pane(1);
    unlaid.dom.querySelector<HTMLElement>('.react-flow__node')!.getBoundingClientRect = rect(0, 0, 0, 0);
    expect(waitRestPoint({ nodeId: 'n1' }, lookup, unlaid)).toEqual({ x: 418, y: 344 });
  });
});
