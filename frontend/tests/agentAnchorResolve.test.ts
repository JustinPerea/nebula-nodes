import { beforeEach, describe, expect, it } from 'vitest';
import { agentAnchor, agentLauncher } from '../src/lib/agentAnchors';
import {
  AnchorResolver,
  EDGE_INSET_PX,
  LAUNCHER_GAP_PX,
  RESOLVER_REQUERY_MS,
  aimPoint,
  anchorValues,
  clampToClip,
  type Box,
  type ResolverEnv,
} from '../src/lib/agentAnchorResolve';
import type { AgentCursorAnchor } from '../src/lib/wsClient';

/** Cursor Phase 3, slice 4: the DOM resolver chain, over fake rects. */

const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };

class Page {
  boxes = new Map<Element, Box>();
  clips = new Map<Element, Box>();
  queries: string[] = [];
  root = document.createElement('div');

  constructor() {
    document.body.replaceChildren(this.root);
  }

  /** An element in the page with a rect, a clip and attributes. */
  add(attrs: Record<string, string>, box: Box, clip: Box = VIEW, inRail = false): Element {
    const element = document.createElement('button');
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    if (inRail) element.setAttribute('data-rail-item', '');
    this.root.append(element);
    this.boxes.set(element, box);
    this.clips.set(element, clip);
    return element;
  }

  env(): ResolverEnv {
    return {
      query: (selector) => {
        this.queries.push(selector);
        return Array.from(this.root.querySelectorAll(selector));
      },
      measure: (element) => this.boxes.get(element) ?? null,
      clip: (element) => this.clips.get(element) ?? VIEW,
    };
  }
}

const board = (itemId: string, part?: string): AgentCursorAnchor => ({ surface: 'moodboard', itemId, ...(part ? { part } : {}) });
const anchorAttr = (board: string, image?: string, part?: string) => ({ 'data-agent-anchor': agentAnchor(board, image, part)! });
const launcherAttr = (kind: 'moodboard' | 'canvas', id?: string) => ({ 'data-agent-launcher': agentLauncher(kind, id)! });

let page: Page;
let now = 0;
const resolver = () => new AnchorResolver(page.env(), () => now);

beforeEach(() => {
  page = new Page();
  now = 0;
});

describe('the attribute grammar', () => {
  it('writes board, image and part as one string', () => {
    expect(agentAnchor('b1')).toBe('moodboard:b1');
    expect(agentAnchor('b1', 'i2')).toBe('moodboard:b1/i2');
    expect(agentAnchor('b1', null, 'direction')).toBe('moodboard:b1:direction');
    expect(agentAnchor('b1', 'i2', 'note')).toBe('moodboard:b1/i2:note');
    expect(agentLauncher('moodboard')).toBe('moodboard');
    expect(agentLauncher('moodboard', 'b1')).toBe('moodboard:b1');
    expect(agentLauncher('canvas')).toBe('canvas');
  });

  it('leaves the attribute off for an id outside [A-Za-z0-9_.-]{1,64}', () => {
    for (const bad of ['a b', 'a"b', 'a]b', 'x'.repeat(65), 'a/b', 'a:b']) {
      expect(agentAnchor(bad), bad).toBeUndefined();
      expect(agentAnchor('b1', bad), bad).toBeUndefined();
      expect(agentAnchor('b1', null, bad), bad).toBeUndefined();
      expect(agentLauncher('moodboard', bad), bad).toBeUndefined();
    }
    expect(agentAnchor('')).toBeUndefined();
    expect(agentAnchor(null)).toBeUndefined();
    expect(agentAnchor(undefined)).toBeUndefined();
    expect(agentAnchor('x'.repeat(64))).toBe(`moodboard:${'x'.repeat(64)}`);
  });

  it('tries a part, then its item', () => {
    expect(anchorValues({ surface: 'moodboard', itemId: 'b1/i2', part: 'note' })).toEqual(['moodboard:b1/i2:note', 'moodboard:b1/i2']);
    expect(anchorValues({ surface: 'moodboard', itemId: 'b1', part: 'colors' })).toEqual(['moodboard:b1:colors', 'moodboard:b1']);
    expect(anchorValues({ surface: 'moodboard', itemId: 'b1' })).toEqual(['moodboard:b1']);
    expect(anchorValues({ surface: 'moodboard', itemId: 'b 1' })).toEqual([]);
  });
});

describe('step 1: the exact anchor', () => {
  it('aims at the middle across and 24 px down a tall item, or half a short one', () => {
    const tall = page.add(anchorAttr('b1', 'i1'), { left: 100, top: 200, width: 200, height: 300 });
    const short = page.add(anchorAttr('b1', 'i2'), { left: 400, top: 200, width: 100, height: 30 });
    const r = resolver();
    expect(r.resolve(board('b1/i1'))).toMatchObject({ kind: 'anchor', point: { x: 200, y: 224 }, element: tall });
    expect(r.resolve(board('b1/i2'))).toMatchObject({ kind: 'anchor', point: { x: 450, y: 215 }, element: short });
    expect(aimPoint({ left: 0, top: 0, width: 10, height: 100 })).toEqual({ x: 5, y: 24 });
  });

  it('beats every launcher: the exact item wins when it is there', () => {
    page.add(launcherAttr('moodboard', 'b1'), { left: 10, top: 10, width: 200, height: 40 });
    page.add(launcherAttr('moodboard'), { left: 0, top: 100, width: 40, height: 40 }, VIEW, true);
    const tile = page.add(anchorAttr('b1', 'i1'), { left: 600, top: 300, width: 120, height: 120 });
    expect(resolver().resolve(board('b1/i1'))).toMatchObject({ kind: 'anchor', element: tile });
  });

  it('prefers a match visible in its clip, then the larger visible area, then DOM order', () => {
    const clip: Box = { left: 0, top: 0, width: 500, height: 500 };
    page.add(anchorAttr('b1'), { left: 700, top: 10, width: 100, height: 100 }, clip); // out of the clip
    const small = page.add(anchorAttr('b1'), { left: 10, top: 10, width: 50, height: 50 }, clip);
    const big = page.add(anchorAttr('b1'), { left: 100, top: 100, width: 200, height: 200 }, clip);
    const twin = page.add(anchorAttr('b1'), { left: 100, top: 300, width: 200, height: 200 }, clip);
    const r = resolver();
    expect(r.resolve(board('b1'))).toMatchObject({ kind: 'anchor', element: big });
    // Equal visible areas: DOM order.
    expect(big.compareDocumentPosition(twin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    page.boxes.set(big, { left: 100, top: 300, width: 200, height: 200 });
    r.invalidate();
    expect(r.resolve(board('b1'))).toMatchObject({ kind: 'anchor', element: big });
    expect(small.isConnected).toBe(true);
  });

  it('aims at the visible part of an item the clip cuts, when its own aim point is cut off', () => {
    const clip: Box = { left: 0, top: 0, width: 400, height: 300 };
    page.add(anchorAttr('b1', 'i1'), { left: 300, top: 250, width: 400, height: 400 }, clip); // aim point (500, 274): outside the clip
    const result = resolver().resolve(board('b1/i1'));
    expect(result.kind).toBe('anchor');
    if (result.kind === 'anchor') expect(result.point).toEqual({ x: 350, y: 274 });
  });

  it('falls back from a part that is not drawn to its item', () => {
    const tile = page.add(anchorAttr('b1', 'i1'), { left: 100, top: 100, width: 100, height: 100 });
    expect(resolver().resolve(board('b1/i1', 'note'))).toMatchObject({ kind: 'anchor', element: tile });
    const part = page.add(anchorAttr('b1', 'i1', 'note'), { left: 120, top: 150, width: 60, height: 40 });
    expect(resolver().resolve(board('b1/i1', 'note'))).toMatchObject({ kind: 'anchor', element: part });
  });

  it('skips elements with no box (not laid out) and ones with no area', () => {
    page.add(anchorAttr('b1'), { left: 10, top: 10, width: 0, height: 20 });
    const hidden = document.createElement('div');
    hidden.setAttribute('data-agent-anchor', 'moodboard:b1');
    page.root.append(hidden); // no entry in boxes: measure says null
    expect(resolver().resolve(board('b1')).kind).toBe('none');
  });
});

describe('the edge park', () => {
  const clip: Box = { left: 100, top: 100, width: 400, height: 300 };

  it.each([
    ['above', { left: 250, top: -400, width: 100, height: 100 }, { x: 300, y: 100 + EDGE_INSET_PX }, -Math.PI / 2],
    ['below', { left: 250, top: 900, width: 100, height: 100 }, { x: 300, y: 400 - EDGE_INSET_PX }, Math.PI / 2],
    ['left', { left: -500, top: 226, width: 100, height: 100 }, { x: 100 + EDGE_INSET_PX, y: 250 }, Math.PI],
    ['right', { left: 900, top: 226, width: 100, height: 100 }, { x: 500 - EDGE_INSET_PX, y: 250 }, 0],
  ] as const)('parks at the clip\'s edge on the side the item is (%s), the chevron toward it', (_side, box, parked, angle) => {
    page.add(anchorAttr('b1', 'i9'), box, clip);
    const result = resolver().resolve(board('b1/i9'));
    expect(result.kind).toBe('edge');
    if (result.kind !== 'edge') return;
    expect(result.point.x).toBeCloseTo(parked.x, 5);
    expect(result.point.y).toBeCloseTo(parked.y, 5);
    expect(result.angle).toBeCloseTo(angle, 1);
  });

  it('clamps along the line from the clip\'s middle, so a scroll slides the cursor along the edge', () => {
    const far = clampToClip({ x: 2000, y: 250 }, clip);
    const farther = clampToClip({ x: 2000, y: 260 }, clip);
    expect(far.point.x).toBeCloseTo(500 - EDGE_INSET_PX, 5);
    expect(farther.point.x).toBeCloseTo(500 - EDGE_INSET_PX, 5);
    expect(farther.point.y).toBeGreaterThan(far.point.y); // it moved with the item, along the edge
    expect(clampToClip({ x: 120, y: 120 }, clip).point).toEqual({ x: 120, y: 120 }); // inside the inset clip: where it is
    expect(clampToClip({ x: 300, y: 250 }, { left: 0, top: 0, width: 20, height: 20 }).point).toEqual({ x: 10, y: 10 }); // too small for the inset
  });

  it('is beaten by a less exact match that is in view', () => {
    page.add(anchorAttr('b1', 'i1', 'note'), { left: -900, top: 200, width: 100, height: 100 }, clip);
    const tile = page.add(anchorAttr('b1', 'i1'), { left: 150, top: 150, width: 100, height: 100 }, clip);
    expect(resolver().resolve(board('b1/i1', 'note'))).toMatchObject({ kind: 'anchor', element: tile });
  });
});

describe('step 2: the board\'s launcher', () => {
  it('parks 6 px right of the board\'s dock row, at its middle, when the item is not drawn', () => {
    const row = page.add({ ...launcherAttr('moodboard', 'b1'), ...anchorAttr('b2') }, { left: 20, top: 300, width: 280, height: 56 });
    const result = resolver().resolve(board('b1/i4'));
    expect(result).toMatchObject({ kind: 'launcher', step: 'board', element: row, point: { x: 20 + 280 + LAUNCHER_GAP_PX, y: 328 } });
  });

  it('wants at least half of the row in view: a row scrolled mostly out gives way to the tab', () => {
    const clip: Box = { left: 0, top: 0, width: 400, height: 400 };
    page.add(launcherAttr('moodboard', 'b1'), { left: 20, top: 380, width: 280, height: 56 }, clip); // 20 of 56 px visible
    const tab = page.add(launcherAttr('moodboard'), { left: 30, top: 60, width: 90, height: 30 }, VIEW);
    expect(resolver().resolve(board('b1/i4'))).toMatchObject({ kind: 'launcher', step: 'surface', element: tab });
  });

  it('is a Moodboard node on the canvas when it is at least half visible', () => {
    const node = page.add(launcherAttr('moodboard', 'b1'), { left: 600, top: 400, width: 240, height: 200 });
    expect(resolver().resolve(board('b1'))).toMatchObject({ kind: 'launcher', step: 'board', element: node });
  });
});

describe('step 3: the surface\'s launcher', () => {
  it('is the dock\'s tab when the dock is open, else the rail\'s Open assets', () => {
    const rail = page.add(launcherAttr('moodboard'), { left: 8, top: 400, width: 44, height: 44 }, VIEW, true);
    expect(resolver().resolve(board('b1'))).toMatchObject({ kind: 'launcher', step: 'surface', element: rail });
    const tab = page.add(launcherAttr('moodboard'), { left: 90, top: 80, width: 100, height: 32 });
    const result = resolver().resolve(board('b1'));
    expect(result).toMatchObject({ kind: 'launcher', step: 'surface', element: tab });
    if (result.kind === 'launcher') expect(result.point).toEqual({ x: 90 + 100 + LAUNCHER_GAP_PX, y: 96 });
  });

  it('parks a rail button at its right, its middle', () => {
    page.add(launcherAttr('moodboard'), { left: 8, top: 400, width: 44, height: 44 }, VIEW, true);
    const result = resolver().resolve(board('b1/i4', 'weight'));
    expect(result).toMatchObject({ kind: 'launcher', step: 'surface', point: { x: 58, y: 422 } });
  });
});

describe('step 4: the canvas, and step 5: nothing', () => {
  const node: AgentCursorAnchor = { nodeId: 'n1' };

  it('a canvas target with no canvas parks at the Studio\'s back button', () => {
    const back = page.add(launcherAttr('canvas'), { left: 20, top: 12, width: 120, height: 32 });
    expect(resolver().resolve(node)).toMatchObject({ kind: 'launcher', step: 'canvas', element: back, point: { x: 146, y: 28 } });
    expect(resolver().resolve({ x: 5, y: 5 })).toMatchObject({ kind: 'launcher', step: 'canvas' });
  });

  it('a canvas target with the canvas mounted is the canvas layer\'s, not this one\'s', () => {
    page.add(launcherAttr('canvas'), { left: 20, top: 12, width: 120, height: 32 });
    expect(resolver().resolve(node, { canvasMounted: true })).toEqual({ kind: 'none' });
  });

  it('resolves to nothing when nothing is on the page, so the cursor holds its last spot', () => {
    expect(resolver().resolve(board('b1/i4'))).toEqual({ kind: 'none' });
    expect(resolver().resolve(node)).toEqual({ kind: 'none' });
  });

  it('says the item is gone, not that its board is the place, when the caller knows it was removed', () => {
    page.add(launcherAttr('moodboard', 'b1'), { left: 20, top: 300, width: 280, height: 56 });
    expect(resolver().resolve(board('b1/i4'), { gone: true })).toEqual({ kind: 'gone' });
    // The item's own anchor still wins if it is somehow drawn.
    const tile = page.add(anchorAttr('b1', 'i4'), { left: 400, top: 300, width: 100, height: 100 });
    expect(resolver().resolve(board('b1/i4'), { gone: true })).toMatchObject({ kind: 'anchor', element: tile });
  });
});

describe('the element cache', () => {
  it('trusts a found element for 250 ms and while it stays in the page', () => {
    const tile = page.add(anchorAttr('b1', 'i1'), { left: 100, top: 100, width: 100, height: 100 });
    const r = resolver();
    r.resolve(board('b1/i1'));
    now = RESOLVER_REQUERY_MS - 1;
    r.resolve(board('b1/i1'));
    expect(page.queries).toHaveLength(1);
    now = RESOLVER_REQUERY_MS;
    r.resolve(board('b1/i1'));
    expect(page.queries).toHaveLength(2);
    // A disconnected element is looked up again at once.
    tile.remove();
    const other = page.add(anchorAttr('b1', 'i1'), { left: 300, top: 100, width: 100, height: 100 });
    now += 1;
    expect(r.resolve(board('b1/i1'))).toMatchObject({ kind: 'anchor', element: other });
    expect(page.queries).toHaveLength(3);
  });

  it('measures every call: a moved item is followed with no new query', () => {
    const tile = page.add(anchorAttr('b1', 'i1'), { left: 100, top: 100, width: 100, height: 100 });
    const r = resolver();
    expect(r.resolve(board('b1/i1'))).toMatchObject({ point: { x: 150, y: 124 } });
    page.boxes.set(tile, { left: 100, top: 160, width: 100, height: 100 });
    expect(r.resolve(board('b1/i1'))).toMatchObject({ point: { x: 150, y: 184 } });
    expect(page.queries).toHaveLength(1);
  });
});
