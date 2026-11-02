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
// Round 8b: the Inspector extracts through the worker client (a later
// Extract for the same control wins; the earlier resolves null).
vi.mock('../src/lib/paletteWorkerClient', async (original) => ({
  ...await original<typeof import('../src/lib/paletteWorkerClient')>(),
  extractPaletteLatest: (_key: string, file: Blob) => palette.extract(file),
}));

import { Inspector, PALETTE_PENDING_DELAY_MS } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function colorNode(palette: string[] = []): Node<NodeData> {
  return { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette }, state: 'idle', outputs: {} } };
}

function show(palette: string[] = []) {
  useGraphStore.setState({ nodes: [colorNode(palette)], edges: [], undoNotice: null });
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

  it('says a clear or faint image is too transparent to pull colors from', async () => {
    palette.extract.mockResolvedValue({ ok: false, reason: 'transparent' });
    const { container } = show();
    await extractFrom(container, png('clear.png'));
    await waitFor(() => expect(notice()?.text)
      .toBe("Couldn't find colors in “clear.png”.\nThis image is too transparent to pull colors from."));
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

describe('while Extract works (GM r16 on #208, #204\'s one loading look)', () => {
  const pending = (container: HTMLElement) => container.querySelector('.inspector__palette-pending');
  const hexes = (container: HTMLElement) => [...container.querySelectorAll<HTMLInputElement>('.inspector__palette-hex')].map((e) => e.value);
  const later = () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValue(new Promise((resolve) => { done = resolve; }));
    return (value: unknown) => act(async () => { done(value); await new Promise((r) => setTimeout(r, 0)); });
  };
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it(`shows nothing for ${PALETTE_PENDING_DELAY_MS} ms, then "Extracting colors…" in the Add / Extract row's place, the old swatches still shown`, async () => {
    const land = later();
    const { container } = show(['#aaaaaa', '#bbbbbb']);
    await extractFrom(container, png());
    // At once: no line yet; Add and Extract both wait.
    expect(pending(container)).toBeNull();
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect((container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement).disabled).toBe(true);
    // GM's numbers, not the constant's: nothing at 150 ms, the line by 400.
    expect(PALETTE_PENDING_DELAY_MS).toBe(300);
    await wait(150);
    expect(pending(container)).toBeNull();
    await wait(250);
    expect(pending(container)?.textContent).toBe('Extracting colors…');
    expect(pending(container)?.getAttribute('role')).toBe('status');
    expect(container.querySelector('.inspector__palette-actions')).toBeNull();
    expect(hexes(container)).toEqual(['#aaaaaa', '#bbbbbb']);
    // The new palette replaces the old in place, and the row comes back.
    await land({ ok: true, colors: ['#112233', '#445566', '#778899'] });
    expect(hexes(container)).toEqual(['#112233', '#445566', '#778899']);
    expect(pending(container)).toBeNull();
    expect(container.querySelector('.inspector__palette-actions')).not.toBeNull();
    const addAfter = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    expect(addAfter.disabled).toBe(false);
  });

  it('never flashes the line for a quick extract', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(50);
    await land({ ok: true, colors: ['#112233'] });
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(pending(container)).toBeNull();
    expect(hexes(container)).toEqual(['#112233']);
  });

  it('keeps the old swatches when the extract finds nothing, and the row comes back', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png('odd.png'));
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(hexes(container)).toEqual(['#aaaaaa']);
    await land({ ok: false, reason: 'other' });
    expect(hexes(container)).toEqual(['#aaaaaa']);
    expect(pending(container)).toBeNull();
    expect(container.querySelector('.inspector__palette-actions')).not.toBeNull();
  });

  it('leaves the line to a later extract when this one is dropped (null)', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    await land(null);
    expect(hexes(container)).toEqual(['#aaaaaa']);
    expect(pending(container)?.textContent).toBe('Extracting colors…');
    expect(notice()).toBeNull();
  });
});

