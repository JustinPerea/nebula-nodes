import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM, PR #203 r6 item 1: nothing on the canvas runs until the Hugging Face
 * token is added. The toolbar's Run is locked (aria-disabled, focusable)
 * with the canvas's line, and reads it out as its scope line (item 3);
 * Cmd+Enter and the palette's "Run graph" (both executeGraph) show that line
 * as a neutral one-line notice and send nothing. An Idol node next to other
 * nodes locks the whole run.
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
import { buildCommands } from '../src/lib/commandPalette';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const CANVAS_LOCK = 'You can run this canvas after you add your Hugging Face token in Settings.';

function node(id: string, definitionId: string, label: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label, definitionId, params: definitionId === 'text-input' ? { value: 'a cube' } : {}, outputs: {}, state: 'idle' } };
}

function setup(apiKeys: Record<string, string>, loaded = true) {
  // An Idol node with no token, next to nodes that could run on their own.
  useGraphStore.setState({ nodes: [node('n1', 'text-input', 'Text'), node('n2', 'speridlabs-idol', 'Idol'),
    node('n3', 'text-input', 'Other text')], edges: [] } as never);
  useUIStore.setState({ settingsCache: { apiKeys, loaded } });
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

describe('the canvas with an Idol node and no Hugging Face token', () => {
  it("locks the toolbar's Run with the canvas line, focusable, read out as its scope line", () => {
    setup({});
    const executeGraph = vi.fn(async () => undefined);
    useGraphStore.setState({ executeGraph } as never);
    render(<Toolbar />);
    const run = screen.getByRole('button', { name: /^Run/ });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).not.toBeDisabled();
    expect(run).toHaveAttribute('title', CANVAS_LOCK);
    expect(run).toHaveAccessibleDescription(CANVAS_LOCK);
    expect(run).toHaveAttribute('data-key-locked', '');
    run.focus();
    expect(document.activeElement).toBe(run);
    fireEvent.click(run);
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it("leaves the toolbar's Run as it is once the token is set, and before Settings load", () => {
    for (const [keys, loaded] of [[{ HF_TOKEN: '***abcd' }, true], [{}, false]] as const) {
      cleanup();
      setup(keys, loaded);
      render(<Toolbar />);
      const run = screen.getByRole('button', { name: /^Run/ });
      expect(run).not.toHaveAttribute('aria-disabled');
      expect(run).not.toHaveAttribute('data-key-locked');
      expect(run.getAttribute('title')).toMatch(/^Run graph\./);
    }
  });

  it('Cmd+Enter and the palette (executeGraph) show the line as a neutral notice and send nothing', async () => {
    setup({});
    await useGraphStore.getState().executeGraph();
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
    const notice = useGraphStore.getState().undoNotice;
    expect(notice?.text).toBe(CANVAS_LOCK);
    expect(notice?.tone).toBe('info');
    // The palette's Run graph is the same call (CommandPalette's runGraph).
    useGraphStore.setState({ undoNotice: null } as never);
    let ran: Promise<void> | undefined;
    const commands = buildCommands({ runGraph: () => { ran = useGraphStore.getState().executeGraph(); }, canRun: true, canvasNodes: [] } as never);
    const command = commands.find((candidate) => candidate.id === 'action:run');
    expect(command?.title).toBe('Run graph');
    command?.perform();
    await ran;
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe(CANVAS_LOCK);
  });

  it("a node's own run that would run Idol says Idol's line and sends nothing", async () => {
    setup({});
    await useGraphStore.getState().executeNode('n2');
    expect(sentRuns()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text)
      .toBe('You can run Idol after you add your Hugging Face token in Settings.');
  });
});
