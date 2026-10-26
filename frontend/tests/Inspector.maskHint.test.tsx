import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// The Inspector's mask hint on a Mask Painter whose mask goes to an edit
// node with no base image connected: GM - Design's words (2026-10-25),
// "Nebula says connected, never wired".

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function node(id: string, definitionId: string): Node<NodeData> {
  return { id, type: 'model', position: { x: 0, y: 0 },
    data: { label: id, definitionId, params: {}, state: 'idle', outputs: {} } };
}

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("the Inspector's mask hint", () => {
  it('says connect, in GM - Design’s words', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'm1', sourceHandle: 'mask', target: 'f1', targetHandle: 'mask' }];
    useGraphStore.setState({ nodes: [node('m1', 'mask-painter'), node('f1', 'flux-fill-inpaint')], edges });
    useUIStore.getState().selectNode('m1');
    const { container } = render(<Inspector embedded />);
    const hint = container.querySelector('.mask-painter__hint')?.textContent ?? '';
    expect(hint).toContain('Reconnect the mask, and Nebula connects the base image for you.');
    expect(hint).not.toMatch(/\b(wire|wires|wired|wiring|auto-wire)\b/i);
  });
});
