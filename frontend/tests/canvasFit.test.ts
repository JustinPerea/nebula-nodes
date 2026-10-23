import { afterEach, describe, expect, it, vi } from 'vitest';
import { getViewportForBounds } from '@xyflow/react';
import { computeCanvasFitPadding, unionRects, viewportRevealing, visibleFlowBox } from '../src/lib/canvasFit';

function addChrome(className: string, rect: Partial<DOMRect>) {
  const element = document.createElement('div');
  element.className = className;
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
    ...rect,
  });
  document.body.appendChild(element);
}

describe('computeCanvasFitPadding', () => {
  afterEach(() => {
    document.querySelectorAll('.workspace-rail, .workspace-dock-panel, .chat-panel, .canvas-tabs, .canvas-tabs-wrap, .toolbar, .notice-region__stack').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it('reserves the furthest active left chrome without double counting rail and drawer', () => {
    addChrome('workspace-rail', { left: 16, right: 72, top: 16, bottom: 704, width: 56, height: 688 });
    addChrome('workspace-dock-panel', { left: 84, right: 404, top: 16, bottom: 704, width: 320, height: 688 });

    expect(computeCanvasFitPadding().left).toBe('428px');
  });

  it('keeps fitted nodes below canvas tabs and above the execution toolbar', () => {
    addChrome('canvas-tabs', { left: 400, right: 600, top: 44, bottom: 84, width: 200, height: 40 });
    addChrome('toolbar', { left: 300, right: 700, top: window.innerHeight - 64, bottom: window.innerHeight - 16, width: 400, height: 48 });
    expect(computeCanvasFitPadding().top).toBe('108px');
    expect(computeCanvasFitPadding().bottom).toBe('88px');
  });

  it('fits inside a compact viewport when its covering drawer is dismissed', () => {
    vi.stubGlobal('innerWidth', 623);
    vi.stubGlobal('innerHeight', 792);
    addChrome('workspace-rail', { left: 8, right: 56, top: 8, bottom: 402, width: 48, height: 394 });
    addChrome('workspace-dock-panel', { left: 64, right: 615, top: 8, bottom: 652, width: 551, height: 644 });

    const padding = computeCanvasFitPadding();
    const bounds = { x: -360, y: 0, width: 1350, height: 990 };
    const viewport = getViewportForBounds(bounds, 623, 792, 0.1, 4, padding);
    const left = viewport.x + bounds.x * viewport.zoom;
    const right = left + bounds.width * viewport.zoom;

    expect(padding.left).toBe('80px');
    expect(623 - parseFloat(padding.left) - parseFloat(padding.right)).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(80);
    expect(right).toBeLessThanOrEqual(623 - 40);
  });

  it('keeps fitted nodes below the floating top bar', () => {
    // The workspace header (project name, Canvas / Creator Studio): 24 px down, 44 px tall.
    addChrome('canvas-tabs-wrap', { left: 380, right: 900, top: 24, bottom: 68, width: 520, height: 44 });
    expect(computeCanvasFitPadding().top).toBe('92px');
  });

  it('keeps fitted nodes above an open proposal bar', () => {
    // The live check: at 1440x900 the bar sat 636-822 px and Fit view left a node under it.
    addChrome('toolbar', { left: 300, right: 700, top: window.innerHeight - 64, bottom: window.innerHeight - 16, width: 400, height: 48 });
    // Round 2: the bar is in the notice region's one stack, on top (GM - Design, 2026-10-23).
    addChrome('notice-region__stack', { left: 400, right: 1020, top: window.innerHeight - 264, bottom: window.innerHeight - 78, width: 620, height: 186 });
    expect(computeCanvasFitPadding().bottom).toBe('288px');
  });

  it('reserves an independent right chat panel while keeping base vertical padding', () => {
    addChrome('chat-panel', { left: 900, right: 1264, top: 80, bottom: 680, width: 364, height: 600 });

    expect(computeCanvasFitPadding()).toEqual({
      top: '40px',
      right: '148px',
      bottom: '40px',
      left: '40px',
    });
  });
});

const PADDING = { top: '92px', right: '40px', bottom: '88px', left: '80px' };
const SCREEN = { width: 1280, height: 800 };

describe('visibleFlowBox', () => {
  it('is the uncovered screen in flow units', () => {
    expect(visibleFlowBox({ x: -100, y: 50, zoom: 2 }, SCREEN, PADDING)).toEqual({
      left: 90, top: 21, right: 670, bottom: 331,
    });
  });
});

describe('viewportRevealing', () => {
  it('leaves the view alone when the block is already in view', () => {
    expect(viewportRevealing({ left: 100, top: 100, right: 400, bottom: 300 }, { x: 0, y: 0, zoom: 1 }, SCREEN, 0.1, PADDING))
      .toBeNull();
  });

  it('pans as little as it can when the block fits at this zoom', () => {
    // Under the top bar: 40 px of it is above y=92.
    expect(viewportRevealing({ left: 100, top: 52, right: 400, bottom: 300 }, { x: 0, y: 0, zoom: 1 }, SCREEN, 0.1, PADDING))
      .toEqual({ x: 0, y: 40, zoom: 1 });
  });

  it('zooms out only as far as it needs, never past minZoom, and centres the block', () => {
    const block = { left: 0, top: 0, right: 2320, bottom: 620 };
    const view = viewportRevealing(block, { x: 0, y: 0, zoom: 1 }, SCREEN, 0.1, PADDING)!;
    expect(view.zoom).toBeCloseTo(0.5);
    const left = view.x + block.left * view.zoom;
    const right = view.x + block.right * view.zoom;
    expect(left).toBeGreaterThanOrEqual(80);
    expect(right).toBeLessThanOrEqual(SCREEN.width - 40);
    expect(view.y + block.top * view.zoom).toBeGreaterThanOrEqual(92);
    expect(viewportRevealing({ left: 0, top: 0, right: 100_000, bottom: 10 }, { x: 0, y: 0, zoom: 1 }, SCREEN, 0.1, PADDING)!.zoom)
      .toBe(0.1);
  });
});

describe('unionRects', () => {
  it('bounds every rectangle, and is null for none', () => {
    expect(unionRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: -5, y: 20, width: 5, height: 5 }]))
      .toEqual({ x: -5, y: 0, width: 15, height: 25 });
    expect(unionRects([])).toBeNull();
  });
});
