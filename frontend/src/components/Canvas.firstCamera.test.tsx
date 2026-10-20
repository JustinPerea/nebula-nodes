import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Viewport } from '@xyflow/react';

// The camera the canvas places itself is marked so opening a project doesn't
// read as an unsaved change (projectStore adoptCanvasCamera). React Flow's
// fitView prop queues one fit and runs it once the canvas has nodes: on a
// canvas that mounted empty (an agent's new_project), that is when a followed
// project's graph arrives, so that fit is the canvas's own too (PR #102
// follow-up, 2026-10-20).

type FlowProps = {
  onInit?: (instance: { getViewport: () => Viewport }) => void;
  onMove?: (event: MouseEvent | TouchEvent | null, viewport: Viewport) => void;
};
let flow: FlowProps = {};
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  ReactFlow: (props: FlowProps) => { flow = props; return null; },
}));

import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Canvas';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';

const fit = { x: -120, y: -80, zoom: 0.8 };
const marked = () => useUIStore.getState().canvasViewportInitial === true;

beforeEach(() => {
  flow = {};
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useGraphStore.setState({ nodes: [], edges: [] });
  useUIStore.setState({ viewMode: 'canvas', canvasViewport: null, canvasFocusRequest: null, canvasViewportInitial: undefined });
});
afterEach(() => cleanup());

const mount = () => render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);

describe('the camera the canvas places itself', () => {
  it('on an empty canvas: its start, then its queued fit once a followed graph arrives', () => {
    mount();
    act(() => flow.onInit?.({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }));
    expect(marked()).toBe(true);
    act(() => flow.onMove?.(null, fit));
    expect(useUIStore.getState().canvasViewport).toEqual(fit);
    expect(marked()).toBe(true);
  });

  it('a graph with no saved view: its first fit', () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 }, data: {} }] as never });
    mount();
    act(() => flow.onMove?.(null, fit));
    expect(marked()).toBe(true);
  });

  it('not a pan or zoom by the person, nor any move after one', () => {
    mount();
    act(() => flow.onMove?.(new MouseEvent('mousemove'), { x: 10, y: 0, zoom: 1 }));
    expect(marked()).toBe(false);
    act(() => flow.onMove?.(null, fit));
    expect(marked()).toBe(false);
  });

  it('not a later programmatic move: only the first fit is the canvas’s own', () => {
    mount();
    act(() => flow.onMove?.(null, fit));
    act(() => flow.onMove?.(null, { x: 1, y: 2, zoom: 0.5 }));
    expect(marked()).toBe(false);
  });

  it('not when the project had a saved view (no fit is queued)', () => {
    useUIStore.setState({ canvasViewport: { x: 5, y: 5, zoom: 1 } });
    mount();
    act(() => flow.onMove?.(null, fit));
    expect(marked()).toBe(false);
  });
});
