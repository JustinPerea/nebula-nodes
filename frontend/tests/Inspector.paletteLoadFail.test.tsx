import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 7 L3 (round 8c): when the extraction's own chunk can't load (a tab
// left open across an update, the server gone), Extract says the app
// couldn't load it, never "Couldn't find colors in" a file it never read.
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
vi.mock('../src/lib/paletteWorkerClient', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("Extract when its code can't load", () => {
  it("says it couldn't load Extract, keeps the swatches and gives the row back", async () => {
    const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#aaaaaa'] }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
    useUIStore.getState().selectNode('n1');
    const { container } = render(<Inspector embedded />);
    const input = container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], 'ref.png', { type: 'image/png' })] } });
    });
    const copy = "Couldn't load Extract from reference. Nebula's server isn't answering. Make sure it's running.";
    await waitFor(() => expect(useGraphStore.getState().undoNotice?.text).toBe(copy));
    expect(useGraphStore.getState().undoNotice?.text).not.toMatch(/Couldn't find colors/);
    expect(container.querySelector('.inspector__palette-status')?.textContent).toBe(copy);
    expect(useGraphStore.getState().nodes[0].data.params.palette).toEqual(['#aaaaaa']);
    expect(container.querySelector('.inspector__palette-actions')).not.toBeNull();
  });
});
