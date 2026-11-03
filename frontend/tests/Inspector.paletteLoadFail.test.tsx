import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// GM r20 on #208: when Extract can't run at all (its own code chunk didn't
// load), one neutral line in the because form, with Try again; never a toast
// and never "Couldn't find colors in" a file it never read. (A worker that
// can't load is the client's: the page does it, and nothing shows;
// paletteWorkerClient.test.ts.)
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const chunk = vi.hoisted(() => ({ fails: true, loads: 0 }));
vi.mock('../src/lib/paletteWorkerClient', () => {
  chunk.loads++;
  if (chunk.fails) throw new Error('Failed to fetch dynamically imported module');
  return { extractPaletteLatest: async () => ({ ok: true, colors: ['#112233', '#445566'] }) };
});

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { TRY_AGAIN } from '../src/lib/sceneSaveCopy';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const LINE = 'Nebula couldn’t extract the colors because the server isn’t answering.';

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("Extract when its own code can't load (GM r20 on #208)", () => {
  it('shows the because line with Try again, no toast, the swatches kept; Try again extracts the same file', async () => {
    const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#aaaaaa'] }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
    useUIStore.getState().selectNode('n1');
    const { container } = render(<Inspector embedded />);
    const input = container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], 'ref.png', { type: 'image/png' })] } });
    });
    const line = () => container.querySelector('.inspector__palette-cant-run');
    await waitFor(() => expect(line()).not.toBeNull());
    expect(line()!.textContent).toBe(LINE + TRY_AGAIN);
    expect(TRY_AGAIN).toBe('Try again');
    expect(container.querySelector('.inspector__palette-status')?.textContent).toBe(LINE);
    expect(useGraphStore.getState().undoNotice).toBeNull();
    expect(container.textContent).not.toMatch(/Couldn't (find colors|load Extract)/);
    expect(useGraphStore.getState().nodes[0].data.params.palette).toEqual(['#aaaaaa']);
    // The row stays usable beside it.
    expect(container.querySelector('.inspector__palette-actions')).not.toBeNull();
    // Try again: the code loads this time, and the same file gives its palette.
    chunk.fails = false;
    const button = [...line()!.querySelectorAll('button')].find((b) => b.textContent === TRY_AGAIN)!;
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(useGraphStore.getState().nodes[0].data.params.palette).toEqual(['#112233', '#445566']));
    expect(line()).toBeNull();
    expect(container.querySelector('.inspector__palette-status')?.textContent).toBe('Extracted 2 colors.');
  });
});
