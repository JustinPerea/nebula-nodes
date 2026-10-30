import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM, PR #203 r4: without a Hugging Face token, Run on an Idol node is
 * locked in the shared disabled style with the lock reason as its tooltip,
 * so a sure-to-fail run is never sent. Every Run surface: the selection
 * toolbar, the Inspector and the node's context menu. Review r3 LOW-2: it is
 * aria-disabled, not natively disabled, so a keyboard reaches it and its
 * reason (its accessible description), as the toolbar Run is while
 * following; one cursor on every surface. GM r6: a node fed by Idol locks
 * too (its run would run Idol), and the whole canvas's Run, Cmd+Enter and
 * the palette's Run graph say the canvas's line.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Inspector } from '../src/components/panels/Inspector';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const LOCK = 'You can run Idol after you add your Hugging Face token in Settings.';


function idolNode(id: string, selected = true): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {}, outputs: {}, state: 'idle' } };
}

function previewNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 300, y: 0 }, selected,
    data: { label: 'Preview', definitionId: 'preview', params: {}, outputs: {}, state: 'idle' } };
}

let executeNode: ReturnType<typeof vi.fn>;
let runCluster: ReturnType<typeof vi.fn>;

function setup(apiKeys: Record<string, string>, loaded = true) {
  executeNode = vi.fn(async () => undefined);
  runCluster = vi.fn(async () => undefined);
  useGraphStore.setState({ nodes: [idolNode('n1')], edges: [], executeNode, executeCluster: runCluster } as never);
  useUIStore.setState({ settingsCache: { apiKeys, loaded } });
}

beforeEach(() => {
  cleanup();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const surfaces = [
  ['the selection toolbar', () => {
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
    return screen.getByRole('button', { name: 'Run selected nodes' });
  }],
  ['the Inspector', () => {
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
    return screen.getByRole('button', { name: /^Run/ });
  }],
  ['the context menu', () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n1', null);
    render(<ContextMenu />);
    return screen.getByRole('button', { name: 'Run This Node' });
  }],
] as const;

describe('Idol without a Hugging Face token: Run is locked', () => {
  for (const [where, mount] of surfaces) {
    it(`${where}: locked with GM's reason, focusable, and a click or key sends nothing`, () => {
      setup({});
      const run = mount();
      expect(run).toHaveAttribute('aria-disabled', 'true');
      expect(run).not.toBeDisabled();
      expect(run).toHaveAttribute('data-key-locked', '');
      expect(run).toHaveAttribute('title', LOCK);
      expect(run).toHaveAccessibleDescription(LOCK);
      run.focus();
      expect(document.activeElement).toBe(run);
      fireEvent.click(run);
      fireEvent.keyDown(run, { key: 'Enter' });
      expect(executeNode).not.toHaveBeenCalled();
      expect(runCluster).not.toHaveBeenCalled();
    });

    it(`${where}: runs once a token is set`, () => {
      setup({ HF_TOKEN: '***abcd' });
      const run = mount();
      expect(run).toBeEnabled();
      expect(run).not.toHaveAttribute('aria-disabled');
      expect(run).not.toHaveAttribute('data-key-locked');
      expect(run).not.toHaveAttribute('title', LOCK);
    });

    it(`${where}: a node fed by Idol is locked with Idol's line (its run would run Idol)`, () => {
      setup({});
      useGraphStore.setState({ nodes: [idolNode('n1', false), previewNode('n2', true)],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'world', targetHandle: 'input' }] } as never);
      if (where === 'the Inspector') useUIStore.getState().selectNode('n2');
      if (where === 'the context menu') {
        useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n2', null);
        render(<ContextMenu />);
      }
      const run = where === 'the context menu' ? screen.getByRole('button', { name: 'Run This Node' })
        : where === 'the Inspector' ? (render(<Inspector embedded />), screen.getByRole('button', { name: /^Run/ }))
          : (render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>),
            screen.getByRole('button', { name: 'Run selected nodes' }));
      expect(run).toHaveAttribute('aria-disabled', 'true');
      expect(run).toHaveAccessibleDescription(LOCK);
    });

    it(`${where}: nothing locks before Settings load`, () => {
      setup({}, false);
      const run = mount();
      expect(run).not.toHaveAttribute('title', LOCK);
    });
  }
});

describe('the selection toolbar reads the run plan of the selection (GM, PR #203 r8 item 2)', () => {
  function chain(selected: string[]) {
    const pick = (n: Node<NodeData>) => ({ ...n, selected: selected.includes(n.id) });
    const text: Node<NodeData> = { id: 'text', type: 'model-node', position: { x: 0, y: 200 },
      data: { label: 'Text', definitionId: 'text-input', params: { value: 'a cube' }, outputs: {}, state: 'idle' } };
    const exporter: Node<NodeData> = { id: 'export', type: 'model-node', position: { x: 600, y: 0 },
      data: { label: 'Export', definitionId: 'worldlabs-world-export', params: {}, outputs: {}, state: 'idle' } };
    useGraphStore.setState({ nodes: [idolNode('n1', false), exporter, text].map(pick),
      edges: [{ id: 'e1', source: 'n1', target: 'export', sourceHandle: 'world', targetHandle: 'world' }] } as never);
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
    return screen.getByRole('button', { name: 'Run selected nodes' });
  }

  it('Export with Text: the selection runs only those two, so Idol is not in it and Run is open', () => {
    setup({ WORLDLABS_API_KEY: '***abcd' });
    const run = chain(['export', 'text']);
    expect(run).not.toHaveAttribute('aria-disabled');
    expect(run).not.toHaveAttribute('data-key-locked');
    expect(run).not.toHaveAttribute('title', LOCK);
  });

  it("Export alone: its run pulls in the Idol that feeds it, so Run is locked with Idol's line", () => {
    setup({ WORLDLABS_API_KEY: '***abcd' });
    const run = chain(['export']);
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAccessibleDescription(LOCK);
  });
});
