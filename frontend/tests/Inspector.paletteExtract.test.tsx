import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// The palette's "Extract from reference" (fix/drop-followups, 2026-10-24,
// GM - Design): it reads the picked file itself (nothing is uploaded), and
// an image that gives no colours says why when Nebula knows ("Couldn't find colors in “{filename}”." over the reason), with
// the heading alone when it doesn't.

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const palette = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('../src/lib/paletteExtract', async (original) => ({
  ...await original<typeof import('../src/lib/paletteExtract')>(), extractPaletteFromImage: palette.extract,
}));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function colorNode(): Node<NodeData> {
  return { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: [] }, state: 'idle', outputs: {} } };
}

function show() {
  useGraphStore.setState({ nodes: [colorNode()], edges: [], undoNotice: null });
  useUIStore.getState().selectNode('n1');
  return render(<Inspector embedded />);
}

async function extractFrom(container: HTMLElement, file: File) {
  const input = container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function answer(upload: () => Response) {
  api.fetch.mockImplementation(async (path: string) => (path === '/api/uploads' ? upload() : new Response('{}')));
}

const uploaded = () => new Response(JSON.stringify({
  filePath: '/out/chat-uploads/abc.png', url: '/api/outputs/chat-uploads/abc.png' }), { status: 200 });

const png = (name = 'grade-ref.png') => new File([new Uint8Array(16)], name, { type: 'image/png' });
const notice = () => useGraphStore.getState().undoNotice;
const swatches = () => useGraphStore.getState().nodes[0].data.params.palette;

beforeEach(() => {
  api.fetch.mockReset();
  palette.extract.mockReset();
  answer(uploaded);
  useUIStore.setState(initialUI, true);
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe("the palette's Extract from reference", () => {
  it('reads the picked file itself and uploads nothing', async () => {
    palette.extract.mockResolvedValue({ ok: true, colors: ['#112233'] });
    const picked = png();
    const { container } = show();
    await extractFrom(container, picked);
    await waitFor(() => expect(swatches()).toEqual(['#112233']));
    expect(palette.extract).toHaveBeenCalledWith(picked);
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/uploads')).toEqual([]);
    // Extracting… ends.
    expect(container.textContent).toContain('Extract from reference');
  });

  it("says Nebula can't read an image it can't decode", async () => {
    palette.extract.mockResolvedValue({ ok: false, reason: 'decode' });
    const { container } = show();
    await extractFrom(container, png('broken.png'));
    await waitFor(() => expect(notice()?.text)
      .toBe("Couldn't find colors in “broken.png”.\nNebula can't read this image. Try a PNG or JPEG."));
    expect(swatches()).toEqual([]);
  });

  it('says a fully transparent image is fully transparent', async () => {
    palette.extract.mockResolvedValue({ ok: false, reason: 'transparent' });
    const { container } = show();
    await extractFrom(container, png('clear.png'));
    await waitFor(() => expect(notice()?.text)
      .toBe("Couldn't find colors in “clear.png”.\nThe image is fully transparent."));
  });

  it("gives only the heading when it can't tell why", async () => {
    palette.extract.mockResolvedValue({ ok: false, reason: 'other' });
    const { container } = show();
    await extractFrom(container, png('odd.png'));
    await waitFor(() => expect(notice()?.text).toBe("Couldn't find colors in “odd.png”."));
  });

  it('writes the swatches and shows no notice when it finds colours', async () => {
    palette.extract.mockResolvedValue({ ok: true, colors: ['#112233', '#445566'] });
    const { container } = show();
    await extractFrom(container, png());
    await waitFor(() => expect(swatches()).toEqual(['#112233', '#445566']));
    expect(notice()).toBeNull();
    expect(container.textContent).toContain('Extract from reference');
  });
});
