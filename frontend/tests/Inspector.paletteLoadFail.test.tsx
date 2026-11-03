import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { Inspector, PALETTE_LINE_MIN_MS } from '../src/components/panels/Inspector';
import { resetPaletteFocusForTests } from '../src/components/panels/paletteFocus';
import { resetPaletteExtractsForTests } from '../src/components/panels/usePaletteExtracts';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { TRY_AGAIN } from '../src/lib/sceneSaveCopy';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const LINE = 'Nebula couldn’t extract the colors because the server isn’t answering.';
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  // A chunk that loaded stays loaded (the module registry keeps it), so
  // only the last test lets it load.
  resetPaletteExtractsForTests();
  resetPaletteFocusForTests();
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

function show() {
  const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#aaaaaa'] }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
  useUIStore.getState().selectNode('n1');
  return render(<Inspector embedded />);
}

async function pick(container: HTMLElement) {
  const input = container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], 'ref.png', { type: 'image/png' })] } });
  });
}

const line = (container: HTMLElement) => container.querySelector('.inspector__palette-cant-run');
const status = (container: HTMLElement) => container.querySelector('.inspector__palette-status')?.textContent;
const tryAgain = (container: HTMLElement) => [...container.querySelectorAll('button')].find((b) => b.textContent === TRY_AGAIN) as HTMLButtonElement | undefined;

describe("Extract when its own code can't load (GM r20 on #208)", () => {
  it('shows the because line with Try again, no toast, the swatches kept', async () => {
    const { container } = show();
    await pick(container);
    await waitFor(() => expect(line(container)).not.toBeNull());
    expect(line(container)!.textContent).toBe(LINE);
    expect(TRY_AGAIN).toBe('Try again');
    expect(status(container)).toBe(LINE);
    expect(useGraphStore.getState().undoNotice).toBeNull();
    expect(container.textContent).not.toMatch(/Couldn't (find colors|load Extract)/);
    expect(useGraphStore.getState().nodes[0].data.params.palette).toEqual(['#aaaaaa']);
  });

  it("takes the line's slot: the line, then one row with Add, and Try again where Extract is (GM r22 Q6)", async () => {
    const { container } = show();
    await pick(container);
    await waitFor(() => expect(line(container)).not.toBeNull());
    const stack = container.querySelector('.inspector__palette')!;
    const kids = [...stack.children].map((e) => e.className);
    const at = kids.indexOf('inspector__palette-cant-run');
    expect(kids[at - 1]).toBe('inspector__palette-list');
    expect(kids[at + 1]).toBe('inspector__palette-actions');
    const row = stack.querySelector('.inspector__palette-actions')!;
    expect([...row.children].map((e) => e.textContent)).toEqual(['Add', TRY_AGAIN]);
    expect(row.querySelector('label[title="Extract a palette from an image"]')).toBeNull();
    expect(stack.querySelector('.inspector__palette-pending')).toBeNull();
  });

  it('scrolls the slot into view by the least amount, once, a jump under reduced motion (GM r22 Q6)', async () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    const calls: ScrollToOptions[] = [];
    scroller.scrollBy = ((options: ScrollToOptions) => { calls.push(options); }) as typeof scroller.scrollBy;
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 300, 300); // 100 to 400
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('inspector__palette-cant-run')) return new DOMRect(0, 380, 300, 34); // line 380-414
      if (this.classList.contains('inspector__palette-actions')) return new DOMRect(0, 418, 300, 28); // row 418-446
      return new DOMRect(0, 0, 0, 0);
    });
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query,
      addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
        data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#aaaaaa'] }, state: 'idle', outputs: {} } };
      useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
      useUIStore.getState().selectNode('n1');
      const { container } = render(<Inspector embedded />, { container: scroller.appendChild(document.createElement('div')) });
      await pick(container);
      await waitFor(() => expect(line(container)).not.toBeNull());
      // The row's bottom (446) past the view's (400): 46 px, one call, a jump.
      expect(calls).toEqual([{ top: 46, behavior: 'auto' }]);
    } finally {
      rects.mockRestore();
      window.matchMedia = matchMedia;
      scroller.remove();
    }
  });

  // Last: the chunk loads in it.
  it('keeps Try again mounted and focused across a second failure, held 400 ms, and re-announces; Try again extracts the same file (GM r22 Q4)', async () => {
    const { container } = show();
    await pick(container);
    await waitFor(() => expect(line(container)).not.toBeNull());
    const button = tryAgain(container)!;
    act(() => button.focus());
    const started = Date.now();
    const loadsBefore = chunk.loads;
    await act(async () => { fireEvent.click(button); });
    // Running: the same element, aria-disabled, the line unchanged, no pending line.
    expect(tryAgain(container)).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(line(container)!.textContent).toBe(LINE);
    expect(container.querySelector('.inspector__palette-pending')).toBeNull();
    expect(status(container)).toBe('');
    // A press while it runs does nothing.
    await act(async () => { fireEvent.click(button); });
    expect(chunk.loads).toBe(loadsBefore + 1);
    await wait(PALETTE_LINE_MIN_MS - 120);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
    expect(Date.now() - started).toBeGreaterThanOrEqual(PALETTE_LINE_MIN_MS - 5);
    // The press made while it ran tried nothing.
    expect(chunk.loads).toBe(loadsBefore + 1);
    // Failed again: the same element, still focused, the status says it again.
    expect(tryAgain(container)).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(status(container)).toBe(LINE);
    // Success: the normal row, focus on Extract, the count.
    chunk.fails = false;
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(line(container)).toBeNull());
    const extract = container.querySelector('label[title="Extract a palette from an image"] input');
    expect(extract).not.toBeNull();
    expect(document.activeElement).toBe(extract);
    expect(useGraphStore.getState().nodes[0].data.params.palette).toEqual(['#112233', '#445566']);
    expect(status(container)).toBe('Extracted 2 colors.');
  });
});
