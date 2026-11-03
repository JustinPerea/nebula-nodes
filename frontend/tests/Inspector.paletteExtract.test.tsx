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
const palette = vi.hoisted(() => ({ extract: vi.fn(), keys: [] as string[] }));
// Round 8b: the Inspector extracts through the worker client (a later
// Extract for the same control wins; the earlier resolves null).
vi.mock('../src/lib/paletteWorkerClient', async (original) => ({
  ...await original<typeof import('../src/lib/paletteWorkerClient')>(),
  extractPaletteLatest: (key: string, file: Blob) => { palette.keys.push(key); return palette.extract(file); },
}));

import { Inspector, PALETTE_LINE_MIN_MS, PALETTE_PENDING_DELAY_MS } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function colorNode(palette: string[] = [], id = 'n1'): Node<NodeData> {
  return { id, type: 'model', position: { x: 0, y: 0 },
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
  palette.keys.length = 0;
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

describe('while Extract works (GM r16, r17 and r18 on #208)', () => {
  const pending = (container: HTMLElement) => container.querySelector('.inspector__palette-pending');
  const hexInputs = (container: HTMLElement) => [...container.querySelectorAll<HTMLInputElement>('.inspector__palette-hex')];
  const hexes = (container: HTMLElement) => hexInputs(container).map((e) => e.value);
  const add = (container: HTMLElement) => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement | undefined;
  const extractInput = (container: HTMLElement) => container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement | null;
  const removes = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.inspector__palette-remove')];
  const colors = (container: HTMLElement) => [...container.querySelectorAll<HTMLInputElement>('.inspector__palette-color')];
  const later = () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    return (value: unknown) => act(async () => { done(value); await new Promise((r) => setTimeout(r, 0)); });
  };
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  /** Nothing on screen says an extract runs: the row is there and live, the swatches editable. */
  const untouched = (container: HTMLElement) => {
    expect(pending(container)).toBeNull();
    expect(add(container)?.disabled).toBe(false);
    expect(extractInput(container)?.disabled).toBe(false);
    for (const input of [...hexInputs(container), ...colors(container), ...removes(container)]) expect(input.disabled).toBe(false);
  };

  it('pins GM\'s numbers: the line after 300 ms, then for at least 400 ms', () => {
    expect(PALETTE_PENDING_DELAY_MS).toBe(300);
    expect(PALETTE_LINE_MIN_MS).toBe(400);
  });

  it('changes nothing for 300 ms, then shows "Extracting colors…" in the row\'s place, the old swatches read-only', async () => {
    const land = later();
    const { container } = show(['#aaaaaa', '#bbbbbb']);
    await extractFrom(container, png());
    // GM r18 2: Add and Extract don't grey for a quick extract.
    untouched(container);
    await wait(150);
    untouched(container);
    await wait(250);
    expect(pending(container)?.textContent).toBe('Extracting colors…');
    expect(container.querySelector('.inspector__palette-actions')).toBeNull();
    expect(hexes(container)).toEqual(['#aaaaaa', '#bbbbbb']);
    // GM r17: the old swatches' ×, hex and colour fields are read-only.
    for (const input of [...hexInputs(container), ...colors(container), ...removes(container)]) expect(input.disabled).toBe(true);
    await land({ ok: true, colors: ['#112233', '#445566', '#778899'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(hexes(container)).toEqual(['#112233', '#445566', '#778899']);
    untouched(container);
  });

  it('keeps every chip at its full colour while the swatches are read-only (GM r20)', async () => {
    later();
    const { container } = show(['#ff285a', '#3759c7']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(pending(container)).not.toBeNull();
    const chips = colors(container);
    expect(chips.map((c) => c.disabled)).toEqual([true, true]);
    expect(chips.map((c) => getComputedStyle(c).backgroundColor)).toEqual(['rgb(255, 40, 90)', 'rgb(55, 89, 199)']);
    expect(chips.map((c) => getComputedStyle(c).opacity)).not.toContain('0.45');
  });

  it('keeps Strength and Method live under the line (GM r18 1)', async () => {
    later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(pending(container)).not.toBeNull();
    const fields = [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')]
      .filter((e) => !e.closest('.inspector__palette'));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field.disabled).toBe(false);
  });

  it('holds the line 400 ms and lands the swatches and the row in one change, never the line with the new swatches', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 30);
    expect(pending(container)).not.toBeNull();
    // Ready 30 ms after the line showed: it waits out the 400.
    await land({ ok: true, colors: ['#112233', '#445566'] });
    const seen: string[] = [];
    const look = () => {
      const line = Boolean(pending(container));
      const row = Boolean(container.querySelector('.inspector__palette-actions'));
      const fresh = hexes(container).join() === '#112233,#445566';
      expect(line && fresh).toBe(false);
      expect(line === row).toBe(false);
      seen.push(`${line ? 'line' : 'row'}:${fresh ? 'new' : 'old'}`);
    };
    for (let i = 0; i < 12; i++) { look(); await wait(40); }
    look();
    expect(seen[0]).toBe('line:old');
    expect(seen.at(-1)).toBe('row:new');
    // One change: line with the old swatches, then the row with the new, nothing between.
    expect([...new Set(seen)]).toEqual(['line:old', 'row:new']);
    // Not before the 400 ms were up (300 + 400 from the pick, less the 30 waited).
    expect(seen.indexOf('row:new')).toBeGreaterThanOrEqual(Math.floor((PALETTE_LINE_MIN_MS - 30 - 40) / 40));
  });

  it('never flashes the line for a quick extract', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(50);
    await land({ ok: true, colors: ['#112233'] });
    untouched(container);
    expect(hexes(container)).toEqual(['#112233']);
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(pending(container)).toBeNull();
  });

  it('keeps the old swatches when the extract finds nothing, and the row comes back', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png('odd.png'));
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(hexes(container)).toEqual(['#aaaaaa']);
    await land({ ok: false, reason: 'other' });
    await wait(PALETTE_LINE_MIN_MS);
    expect(hexes(container)).toEqual(['#aaaaaa']);
    untouched(container);
  });

  it('leaves the line to a later extract when this one is dropped (null)', async () => {
    const land = later();
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    await land(null);
    await wait(PALETTE_LINE_MIN_MS);
    expect(hexes(container)).toEqual(['#aaaaaa']);
    expect(pending(container)?.textContent).toBe('Extracting colors…');
    expect(notice()).toBeNull();
  });

  it('lands a palette held by the line even when the Inspector closes first', async () => {
    const land = later();
    const { container, unmount } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 30);
    await land({ ok: true, colors: ['#112233'] });
    expect(swatches()).toEqual(['#aaaaaa']);
    unmount();
    expect(swatches()).toEqual(['#112233']);
  });
});

describe('the status region (GM r18 4 on #208)', () => {
  const status = (container: HTMLElement) => container.querySelector('.inspector__palette-status');
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it('is always mounted, reads "Extracting colors…" with the line, then the real count', async () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    const { container } = show(['#aaaaaa']);
    expect(status(container)?.getAttribute('role')).toBe('status');
    expect(status(container)?.textContent).toBe('');
    await extractFrom(container, png());
    expect(status(container)?.textContent).toBe('');
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(status(container)?.textContent).toBe('Extracting colors…');
    // The visible line isn't read twice.
    expect(container.querySelector('.inspector__palette-pending')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { done({ ok: true, colors: ['#112233', '#445566', '#778899', '#aabbcc', '#ddeeff'] }); });
    await wait(PALETTE_LINE_MIN_MS);
    expect(status(container)?.textContent).toBe('Extracted 5 colors.');
  });

  it('says one color, and a quick extract says its count too', async () => {
    palette.extract.mockResolvedValueOnce({ ok: true, colors: ['#112233'] });
    const { container } = show();
    await extractFrom(container, png());
    await waitFor(() => expect(status(container)?.textContent).toBe('Extracted 1 color.'));
  });

  it("reads a failure's own line, on one line", async () => {
    palette.extract.mockResolvedValueOnce({ ok: false, reason: 'decode' });
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png('broken.png'));
    await waitFor(() => expect(status(container)?.textContent)
      .toBe("Couldn't find colors in “broken.png”. Nebula can't read this image. Try a PNG or JPEG."));
  });
});

describe('an edit made while Extract works stays (review 7 M1)', () => {
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const params = () => useGraphStore.getState().nodes[0].data.params;
  const setStrength = (container: HTMLElement, value: string) => {
    const field = container.querySelector<HTMLInputElement>('[data-inspector-param="strength"] input');
    expect(field).not.toBeNull();
    fireEvent.change(field!, { target: { value } });
  };

  it("keeps the person's Strength and lands the palette", async () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    act(() => setStrength(container, '0.3'));
    expect(params().strength).toBe(0.3);
    await act(async () => { done({ ok: true, colors: ['#112233'] }); });
    await wait(PALETTE_LINE_MIN_MS);
    expect(params()).toMatchObject({ palette: ['#112233'], strength: 0.3 });
  });

  it("keeps an agent's edit to the node, made in the store meanwhile", async () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    const { container } = show(['#aaaaaa']);
    await extractFrom(container, png());
    await wait(50);
    act(() => useGraphStore.getState().updateNodeData('n1', { params: { ...params(), strength: 0.25, method: 'reinhard' } }));
    await act(async () => { done({ ok: true, colors: ['#112233', '#445566'] }); });
    expect(params()).toMatchObject({ palette: ['#112233', '#445566'], strength: 0.25, method: 'reinhard' });
  });
});

describe("Extract's state belongs to one node (review 7 L1)", () => {
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it("asks the client by node and param, and shows one node's extract on that node only", async () => {
    let done!: (value: unknown) => void;
    palette.extract.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    useGraphStore.setState({ nodes: [colorNode(['#aaaaaa'], 'n1'), colorNode(['#bbbbbb'], 'n2')], edges: [], undoNotice: null });
    useUIStore.getState().selectNode('n1');
    const { container } = render(<Inspector embedded />);
    await extractFrom(container, png());
    expect(palette.keys).toEqual(['n1:palette']);
    await wait(PALETTE_PENDING_DELAY_MS + 100);
    expect(container.querySelector('.inspector__palette-pending')).not.toBeNull();
    act(() => useUIStore.getState().selectNode('n2'));
    await wait(0);
    expect(container.querySelector('.inspector__palette-pending')).toBeNull();
    expect((container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement).disabled).toBe(false);
    await act(async () => { done({ ok: true, colors: ['#112233'] }); });
    await wait(PALETTE_LINE_MIN_MS);
    const byId = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data.params.palette;
    expect(byId('n1')).toEqual(['#112233']);
    expect(byId('n2')).toEqual(['#bbbbbb']);
  });
});
