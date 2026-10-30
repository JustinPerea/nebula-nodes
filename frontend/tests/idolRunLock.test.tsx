import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM, PR #203 r4: without a Hugging Face token, Run on an Idol node is
 * disabled in the shared disabled style with the lock reason as its tooltip,
 * so a sure-to-fail run is never sent. Every Run surface: the selection
 * toolbar, the Inspector and the node's context menu.
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

let executeNode: ReturnType<typeof vi.fn>;

function setup(apiKeys: Record<string, string>, loaded = true) {
  executeNode = vi.fn(async () => undefined);
  useGraphStore.setState({ nodes: [idolNode('n1')], edges: [], executeNode } as never);
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
    it(`${where}: disabled with GM's reason, and a click sends nothing`, () => {
      setup({});
      const run = mount();
      expect(run).toBeDisabled();
      expect(run).toHaveAttribute('title', LOCK);
      fireEvent.click(run);
      expect(executeNode).not.toHaveBeenCalled();
    });

    it(`${where}: runs once a token is set`, () => {
      setup({ HF_TOKEN: '***abcd' });
      const run = mount();
      expect(run).toBeEnabled();
      expect(run).not.toHaveAttribute('title', LOCK);
    });

    it(`${where}: nothing locks before Settings load`, () => {
      setup({}, false);
      const run = mount();
      expect(run).not.toHaveAttribute('title', LOCK);
    });
  }
});
