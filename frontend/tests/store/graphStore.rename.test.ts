import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../../src/store/graphStore';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

const DISPLAY = NODE_DEFINITIONS['text-input'].displayName;

function textNode(id: string, label = DISPLAY): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    data: { definitionId: 'text-input', label, params: {}, state: 'idle', outputs: {} } as NodeData,
  };
}

const labelOf = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)?.data.label;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renameNode', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('local-1')], edges: [] });
  });

  it('renames backend nodes optimistically and stores the name on the backend', async () => {
    useGraphStore.getState().renameNode('n1', '  Hero   prompt ');
    expect(labelOf('n1')).toBe('Hero prompt');
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/graph\/node\/n1\/label$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ label: 'Hero prompt' });
  });

  it('keeps local-only nodes on the frontend', async () => {
    useGraphStore.getState().renameNode('local-1', 'Scratch');
    expect(labelOf('local-1')).toBe('Scratch');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the model name for a blank rename and skips no-op renames', async () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [] });
    useGraphStore.getState().renameNode('n1', '   ');
    expect(labelOf('n1')).toBe(DISPLAY);
    await flush();
    fetchMock.mockClear();
    useGraphStore.getState().renameNode('n1', DISPLAY);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rolls back when the backend refuses the rename', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    useGraphStore.getState().renameNode('n1', 'Hero');
    expect(labelOf('n1')).toBe('Hero');
    await flush();
    await flush();
    expect(labelOf('n1')).toBe(DISPLAY);
  });
});
