import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * PR #203 review finding: on a kept canvas `withKeyLock` hands its props back
 * with the kept line, and the missing-key reason waits until the canvas is
 * back. Every surface that reads the reason out asks the props it got back
 * (`isKeyLocked`), so a screen reader never hears a line the tooltip doesn't
 * say. Each surface, with a node missing its key: kept, no key line anywhere
 * (the Toolbar's description reads the run scope); not kept, the key line.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Inspector } from '../src/components/panels/Inspector';
import { ContextMenu } from '../src/components/ContextMenu';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { Toolbar } from '../src/components/panels/Toolbar';
import { KEPT_MARK } from '../src/lib/canvasLock';
import { keptLockTitle, resetKeptCanvasForTests, setCanvasKept } from '../src/lib/keptCanvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { RunRecord } from '../src/lib/runHistory';
import { KEYED_LINE, keyIdolInEachTest } from './helpers/keyedSpace';

keyIdolInEachTest();

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const CANVAS_LINE = 'You can run this canvas after you add your Hugging Face token in Settings.';

const idolNode = (): Node<NodeData> => ({ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
  data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {}, outputs: {}, state: 'idle' } });

const idolRun = (id: string): RunRecord => ({ id, status: 'complete', trigger: 'graph', startedAt: Date.now(), snapshot: {
  nodes: [{ id: 'img', definitionId: 'image-input', params: { filePath: '/x.png' }, outputs: {} },
    { id: 'idol', definitionId: 'speridlabs-idol', params: {}, outputs: {} }],
  edges: [{ id: 'e1', source: 'img', sourceHandle: 'image', target: 'idol', targetHandle: 'image' }],
} });

beforeEach(() => {
  resetKeptCanvasForTests();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useGraphStore.setState({ nodes: [idolNode()], edges: [], runHistory: [idolRun('r1')], isExecuting: false } as never);
  useUIStore.setState((state) => ({ settingsCache: { apiKeys: {}, loaded: true },
    panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
});
afterEach(() => {
  cleanup();
  resetKeptCanvasForTests();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
});

interface Surface { where: string; line: string; name: string | RegExp; keptLine: string; mount: () => void }

const surfaces: Surface[] = [
  { where: 'the Inspector', line: KEYED_LINE, name: /^Run/, keptLine: keptLockTitle('run'), mount: () => {
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
  } },
  { where: 'the context menu', line: KEYED_LINE, name: 'Run This Node', keptLine: keptLockTitle('run'), mount: () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n1', null);
    render(<ContextMenu />);
  } },
  { where: 'Run History', line: KEYED_LINE, name: 'Rerun Full canvas', keptLine: keptLockTitle('rerun'), mount: () => {
    render(<RunHistoryPanel />);
  } },
  { where: "the toolbar's Run", line: CANVAS_LINE, name: /^Run/, keptLine: keptLockTitle('run-nodes'), mount: () => {
    render(<ReactFlowProvider><Toolbar /></ReactFlowProvider>);
  } },
];

describe('a kept canvas shows no missing-key line, and an open one does', () => {
  for (const surface of surfaces) {
    it(`${surface.where}, kept, key missing: the kept line, no key line in the page`, () => {
      act(() => setCanvasKept(true));
      surface.mount();
      const run = screen.getByRole('button', { name: surface.name });
      expect(run).toHaveAttribute(KEPT_MARK, '');
      expect(run).toHaveAttribute('title', surface.keptLine);
      expect(run).not.toHaveAttribute('data-key-locked');
      expect(run.className).not.toContain('toolbar__button--waiting');
      // The node card's own line (the Inspector's status) stays; the screen-reader span does not.
      for (const span of document.querySelectorAll('.toolbar__sr-only')) expect(span.textContent).not.toBe(surface.line);
    });

    it(`${surface.where}, not kept, key missing: the key line is the title and is read out`, () => {
      surface.mount();
      const run = screen.getByRole('button', { name: surface.name });
      expect(run).toHaveAttribute('title', surface.line);
      expect(run).toHaveAttribute('data-key-locked', '');
      const described = document.getElementById(run.getAttribute('aria-describedby') ?? '');
      expect(described?.textContent).toBe(surface.line);
    });
  }

  it("the toolbar's description span reads the run scope on a kept canvas, the key line otherwise", () => {
    act(() => setCanvasKept(true));
    render(<ReactFlowProvider><Toolbar /></ReactFlowProvider>);
    const run = screen.getByRole('button', { name: /^Run/ });
    const described = document.getElementById(run.getAttribute('aria-describedby') ?? '');
    expect(described).not.toBeNull();
    expect(described?.textContent).not.toBe(CANVAS_LINE);
    expect(described?.textContent?.length).toBeGreaterThan(0);
    cleanup();
    act(() => setCanvasKept(false));
    render(<ReactFlowProvider><Toolbar /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: /^Run/ })).toHaveClass('toolbar__button--waiting');
  });
});
