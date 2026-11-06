import { afterEach, describe, expect, it, vi } from 'vitest';
import { facingPortEdge } from '../../src/lib/facingPort';

/**
 * GM r114 (#226 review 5): the panel stands at the farthest of the dot's edge
 * + 8, the hit target's edge + 2 and the hover circle's edge + 2, each read
 * from the boxes the skin draws (jsdom has no layout, so the page's answers
 * are given here).
 */

type Skin = { dot?: number; circle?: number; circleBox?: 'border-box' | 'content-box'; border?: number; magnet?: number; rest?: number };

function portAt(side: 'left' | 'right', centre: number, zoom: number, skin: Skin) {
  const node = document.createElement('div');
  node.className = 'react-flow__node';
  const handle = document.createElement('div');
  handle.className = `react-flow__handle react-flow__handle-${side}`;
  Object.defineProperty(handle, 'offsetWidth', { value: 20 });
  handle.getBoundingClientRect = () => new DOMRect(centre - 10 * zoom, 100, 20 * zoom, 20 * zoom);
  node.append(handle);
  document.body.append(node);
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    if (element !== handle) return original(element, pseudo);
    const none = { width: 'auto', boxSizing: 'content-box', borderLeftWidth: '0px', getPropertyValue: () => '' };
    if (pseudo === '::before') return { ...none, width: skin.dot === undefined ? 'auto' : `${skin.dot}px` } as unknown as CSSStyleDeclaration;
    if (pseudo === '::after') {
      return {
        ...none, width: skin.circle === undefined ? 'auto' : `${skin.circle}px`, boxSizing: skin.circleBox ?? 'border-box',
        borderLeftWidth: `${skin.border ?? 0}px`,
      } as unknown as CSSStyleDeclaration;
    }
    return {
      ...none, width: '20px',
      getPropertyValue: (name: string) => (name === '--sr-handle-rest-offset' ? `${skin.rest ?? 0}px`
        : name === '--sr-handle-magnet-x' ? `${skin.magnet ?? 0}px` : ''),
    } as unknown as CSSStyleDeclaration;
  });
  return node;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const HOUSE: Skin = { dot: 9, circle: 20, border: 1, rest: 4 };

describe('the panel stands clear of the facing port at every zoom (GM r114)', () => {
  for (const zoom of [1, 2, 4]) {
    it(`right at ${zoom * 100} %: past the hit target and the hover circle by 2 px, never under either`, () => {
      const node = portAt('right', 600, zoom, HOUSE);
      const edge = facingPortEdge(node, 'right')!;
      const boxRight = 600 + 10 * zoom;
      expect(edge).toBeGreaterThanOrEqual(boxRight + 2 - 1e-9);
      expect(edge).toBeCloseTo(Math.max(600 + (4.5 - 4) * zoom + 8, boxRight + 2), 9);
    });
    it(`left at ${zoom * 100} %: the mirror`, () => {
      const node = portAt('left', 600, zoom, HOUSE);
      const edge = facingPortEdge(node, 'left')!;
      expect(edge).toBeLessThanOrEqual(600 - 10 * zoom - 2 + 1e-9);
      expect(edge).toBeCloseTo(Math.min(600 - (4.5 - 4) * zoom - 8, 600 - 10 * zoom - 2), 9);
    });
  }

  it('farthest wins: at 50 % the dot + 8 is past the 2 px target gap; at 100 % the target is', () => {
    expect(facingPortEdge(portAt('right', 600, 0.5, HOUSE), 'right')).toBeCloseTo(600 + 0.25 + 8, 9);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    expect(facingPortEdge(portAt('right', 600, 1, HOUSE), 'right')).toBeCloseTo(600 + 10 + 2, 9);
  });

  it('the hit target counts on its own: a skin that draws no hover circle still keeps the panel 2 px off the handle\'s box', () => {
    const node = portAt('right', 600, 2, { dot: 9, rest: 4 });
    expect(facingPortEdge(node, 'right')).toBeCloseTo(600 + 10 * 2 + 2, 9);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    expect(facingPortEdge(portAt('left', 600, 2, { dot: 9, rest: 4 }), 'left')).toBeCloseTo(600 - 10 * 2 - 2, 9);
  });

  it('measures the circle the skin draws: a content-box circle counts its border, a larger one reaches further', () => {
    // 24 + 2 x 2 = 28 wide: 14 out from the centre, past the 10 px target.
    const node = portAt('right', 600, 2, { dot: 9, circle: 24, circleBox: 'content-box', border: 2, rest: 4 });
    expect(facingPortEdge(node, 'right')).toBeCloseTo(600 + 14 * 2 + 2, 9);
  });

  it('the magnet\'s offset moves the circle, and the panel clears it', () => {
    const node = portAt('right', 600, 2, { ...HOUSE, magnet: 3 });
    expect(facingPortEdge(node, 'right')).toBeCloseTo(600 + (3 + 10) * 2 + 2, 9);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    const left = portAt('left', 600, 2, { ...HOUSE, magnet: -3 });
    expect(facingPortEdge(left, 'left')).toBeCloseTo(600 + (-3 - 10) * 2 - 2, 9);
  });

  it('no port on the side: null; a port with no drawn pseudos counts as its box at the dot\'s gap', () => {
    const none = portAt('left', 600, 1, HOUSE);
    expect(facingPortEdge(none, 'right')).toBeNull();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    expect(facingPortEdge(portAt('right', 600, 1, {}), 'right')).toBeCloseTo(610 + 8, 9);
  });
});
