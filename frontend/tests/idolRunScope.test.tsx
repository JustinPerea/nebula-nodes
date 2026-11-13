import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * Review r4 MEDIUM-1 and GM, PR #203 r8 items 1-2: one rule for every scope.
 * Run locks only when the run plan for that scope (lib/runScope nodesThatRun)
 * includes a real Idol. A canvas run skips an agent's placeholder and what
 * needs it, so a placeholder Idol never locks the toolbar's Run, Cmd+Enter
 * or the palette, and the rest of the canvas runs. A selection runs exactly
 * the selected nodes; one node's run takes what feeds it.
 */

const net = vi.hoisted(() => ({ apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) }));

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: net.apiFetch,
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});

import { Toolbar } from '../src/components/panels/Toolbar';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { keyIdolInEachTest } from './helpers/keyedSpace';

// PR #203 round 7: Idol is keyless. These tests pin the shared key-lock
// machinery on Idol's keyed shape (rounds 4 to 6; tests/helpers/keyedSpace.ts).
keyIdolInEachTest();

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const CANVAS_LOCK = 'You can run this canvas after you add your Hugging Face token in Settings.';
const IDOL_LOCK = 'You can run Idol after you add your Hugging Face token in Settings.';
const CLAUDE = { id: 'claude-code', name: 'Claude Code', color: '#d97757' };

function node(id: string, definitionId: string, label: string, extra: Partial<NodeData> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label, definitionId, params: definitionId === 'text-input' ? { value: 'a cube' } : {}, outputs: {},
      state: 'idle', ...extra } };
}

const toIdol = { id: 'e1', source: 'img', target: 'idol', sourceHandle: 'image', targetHandle: 'image' };
const toExport = { id: 'e2', source: 'idol', target: 'export', sourceHandle: 'world', targetHandle: 'world' };

/** Text on its own, and an image into Idol into World Labs Export; Idol is
 * an agent's placeholder when `placeholder`. */
function setup(placeholder: boolean) {
  const pending = placeholder ? { pending: { agent: CLAUDE, at: 1 } } as Partial<NodeData> : {};
  useGraphStore.setState({ nodes: [node('text', 'text-input', 'Text'),
    node('img', 'image-input', 'Image', { params: { filePath: '/x.png' } } as Partial<NodeData>),
    node('idol', 'speridlabs-idol', 'Idol', pending),
    node('export', 'worldlabs-world-export', 'Export')], edges: [toIdol, toExport] } as never);
  useUIStore.setState({ settingsCache: { apiKeys: { WORLDLABS_API_KEY: '***abcd' }, loaded: true } });
}

function sentRuns() {
  return net.apiFetch.mock.calls.filter(([path]) => String(path).includes('/execute'));
}

beforeEach(() => {
  cleanup();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  net.apiFetch.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a placeholder Idol never locks the canvas's Run (review r4 MEDIUM-1, GM r8 item 1)", () => {
  it("the toolbar's Run is unlocked", () => {
    setup(true);
    render(<Toolbar />);
    const run = screen.getByRole('button', { name: /^Run/ });
    expect(run).not.toHaveAttribute('aria-disabled');
    expect(run).not.toHaveAttribute('data-key-locked');
    expect(run).not.toHaveAttribute('title', CANVAS_LOCK);
  });

  it('Cmd+Enter (executeGraph) runs the rest of the canvas and shows no lock line', async () => {
    setup(true);
    await useGraphStore.getState().executeGraph();
    expect(sentRuns()).toHaveLength(1);
    expect(useGraphStore.getState().undoNotice?.text).not.toBe(CANVAS_LOCK);
  });
});

describe('a real Idol in the plan locks it', () => {
  it("the toolbar's Run is locked with the canvas's line", () => {
    setup(false);
    render(<Toolbar />);
    const run = screen.getByRole('button', { name: /^Run/ });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAccessibleDescription(CANVAS_LOCK);
  });

  it('Cmd+Enter sends nothing and says the canvas line', async () => {
    setup(false);
    await useGraphStore.getState().executeGraph();
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe(CANVAS_LOCK);
  });
});

describe("the store's selection runs read the same plan (GM r8 item 2)", () => {
  it('Export with Text runs only those two, so Idol is not in the plan: it runs', async () => {
    setup(false);
    await useGraphStore.getState().executeCluster(['export', 'text']);
    expect(useGraphStore.getState().undoNotice?.text).not.toBe(IDOL_LOCK);
    expect(sentRuns()).toHaveLength(1);
  });

  it("Export alone pulls in the Idol that feeds it: refused with Idol's line", async () => {
    setup(false);
    await useGraphStore.getState().executeNode('export');
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe(IDOL_LOCK);
  });

  it("the person's own run of the placeholder Idol itself makes it real, so it locks with Idol's line (GM r9 item 1)", async () => {
    setup(true);
    await useGraphStore.getState().executeNode('idol');
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe(IDOL_LOCK);
  });

  it("Export alone over a placeholder Idol: the person's own run makes it run, so it locks", async () => {
    setup(true);
    await useGraphStore.getState().executeNode('export');
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe(IDOL_LOCK);
  });
});
