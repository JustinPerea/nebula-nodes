import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Round 8e of #208 (review 8 MEDIUM-1 / LOW-1 / LOW-2, GM r22): a palette is
// written only to the canvas it was made for (project, graph generation,
// the node's definition, an unlocked canvas); one dropped for a switch or a
// lock is said on its node when the person is back; one extract per
// project, graph and node, outside the Inspector; focus kept across it.

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const palette = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('../src/lib/paletteWorkerClient', async (original) => ({
  ...await original<typeof import('../src/lib/paletteWorkerClient')>(),
  extractPaletteLatest: (_key: string, file: Blob) => palette.extract(file),
}));

import { Inspector, PALETTE_LINE_MIN_MS, PALETTE_PENDING_DELAY_MS } from '../src/components/panels/Inspector';
import { resetPaletteFocusForTests } from '../src/components/panels/paletteFocus';
import { paletteExtractView, paletteRunKey, resetPaletteExtractsForTests } from '../src/components/panels/usePaletteExtracts';
import { canvasGeneration, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { PALETTE_OFFLINE_DROPPED, PALETTE_PROJECT_CHANGED } from '../src/lib/paletteNotice';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const PROJECT_LINE = 'Nebula couldn’t add the extracted colors because the project changed before they were ready. Extract again.';
const OFFLINE_LINE = 'Nebula couldn’t add the extracted colors because Nebula was offline when they were ready. Extract again once it reconnects.';

const colorNode = (swatches: string[] = [], id = 'n1'): Node<NodeData> => ({ id, type: 'model', position: { x: 0, y: 0 },
  data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: swatches }, state: 'idle', outputs: {} } });
const textNode = (id = 'n1'): Node<NodeData> => ({ id, type: 'model', position: { x: 0, y: 0 },
  data: { label: 'Text', definitionId: 'text-input', params: { value: 'project B prompt' }, state: 'idle', outputs: {} } });

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const later = () => {
  let done!: (v: unknown) => void;
  palette.extract.mockReturnValueOnce(new Promise((r) => { done = r; }));
  return (v: unknown) => act(async () => { done(v); await new Promise((r) => setTimeout(r, 0)); });
};
const extractInput = (container: HTMLElement) =>
  container.querySelector('label[title="Extract a palette from an image"] input') as HTMLInputElement | null;
async function extractFrom(container: HTMLElement) {
  await act(async () => {
    fireEvent.change(extractInput(container)!, { target: { files: [new File([new Uint8Array(16)], 'a.png', { type: 'image/png' })] } });
    await new Promise((r) => setTimeout(r, 0));
  });
}
const pending = (container: HTMLElement) => container.querySelector<HTMLElement>('.inspector__palette-pending');
const note = (container: HTMLElement) => container.querySelector('.inspector__palette-note');
const status = (container: HTMLElement) => container.querySelector('.inspector__palette-status')?.textContent;
const nodeParams = (id = 'n1') => useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params;

function show(swatches: string[] = ['#aaaaaa']) {
  useGraphStore.setState({ nodes: [colorNode(swatches)], edges: [], undoNotice: null });
  useUIStore.getState().selectNode('n1');
  return render(<Inspector embedded />);
}

/** The person (or a follow) opens project B: its graph replaces the canvas. */
function openProject(id: string, nodes: Node<NodeData>[]) {
  act(() => {
    setProjectContext({ id, revision: `${id}-r` });
    useGraphStore.getState().loadGraph(nodes, []);
  });
}

beforeEach(() => {
  api.fetch.mockReset();
  api.fetch.mockResolvedValue(new Response('{}'));
  palette.extract.mockReset();
  resetPaletteExtractsForTests();
  resetPaletteFocusForTests();
  resetBackendConnectionForTests();
  resetCanvasFollowForTests();
  setProjectContext({ id: 'pA', revision: 'pA-r' });
  useUIStore.setState(initialUI, true);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  resetCanvasFollowForTests();
  setProjectContext(null);
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('a palette lands only on the canvas it was made for (review 8 MEDIUM-1, GM r22 Q1)', () => {
  it('pins the lines', () => {
    expect(PALETTE_PROJECT_CHANGED).toBe(PROJECT_LINE);
    expect(PALETTE_OFFLINE_DROPPED).toBe(OFFLINE_LINE);
  });

  it("the swap-nodes probe: another node under the same id gets nothing, and nothing is said", async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    act(() => { useGraphStore.setState({ nodes: [textNode('n1')], edges: [] }); });
    await finish({ ok: true, colors: ['#ff0000', '#00ff00'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(nodeParams()).toEqual({ value: 'project B prompt' });
    // A redefined node: no line, no status, no toast (LOW-2).
    expect(status(container) ?? '').toBe('');
    expect(container.textContent).not.toMatch(/Extracted|couldn’t add/);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('a deleted node gets no "Extracted N colors." (LOW-2)', async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    act(() => { useGraphStore.setState({ nodes: [] }); });
    await finish({ ok: true, colors: ['#ff0000'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(status(container) ?? '').toBe('');
    // Nothing kept to say either, should the node come back (an undo).
    expect(paletteExtractView(paletteRunKey('pA', canvasGeneration(), 'n1', 'palette')).status).toBe('');
    expect(container.textContent).not.toMatch(/Extracted|couldn’t add/);
  });

  it("a project switch drops the write; the line shows on the node when the person is back, once", async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    // Project B opens; its own n1 is a palette node too.
    openProject('pB', [colorNode(['#bbbbbb'])]);
    await finish({ ok: true, colors: ['#ff0000', '#00ff00'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(nodeParams()?.palette).toEqual(['#bbbbbb']);
    // Not said in project B.
    expect(note(container)).toBeNull();
    expect(status(container)).toBe('');
    expect(useGraphStore.getState().undoNotice).toBeNull();
    // Back on project A: a new generation, the same node.
    act(() => useUIStore.getState().selectNode(null));
    openProject('pA', [colorNode(['#000000'])]);
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(0);
    expect(note(container)?.textContent).toBe(PROJECT_LINE);
    expect(note(container)?.getAttribute('aria-hidden')).toBe('true');
    expect(status(container)).toBe(PROJECT_LINE);
    // Neutral, no button, and the row stays under it.
    expect(note(container)?.querySelector('button')).toBeNull();
    expect(extractInput(container)).not.toBeNull();
    expect(nodeParams()?.palette).toEqual(['#000000']);
    // Once: leaving the node and coming back, it's gone.
    act(() => useUIStore.getState().selectNode(null));
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(0);
    expect(note(container)).toBeNull();
  });

  it('StrictMode (dev) keeps the line it shows: its effect re-run on mount is not leaving the node', async () => {
    const first = show(['#000000']);
    const finish = later();
    await extractFrom(first.container);
    first.unmount();
    act(() => useUIStore.getState().selectNode(null));
    openProject('pB', [textNode('n9')]);
    await finish({ ok: true, colors: ['#ff0000'] });
    openProject('pA', [colorNode(['#000000'])]);
    act(() => useUIStore.getState().selectNode('n1'));
    // The Inspector opens afresh (as the popover does): StrictMode runs its
    // effects twice on mount.
    const { container } = render(<StrictMode><Inspector embedded /></StrictMode>);
    await wait(10);
    expect(note(container)?.textContent).toBe(PROJECT_LINE);
    act(() => useUIStore.getState().selectNode(null));
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(10);
    expect(note(container)).toBeNull();
  });

  it('a replaced graph in the same project (a new generation) drops it too', async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    const before = canvasGeneration();
    openProject('pA', [colorNode(['#cccccc'])]);
    expect(canvasGeneration()).toBe(before + 1);
    await finish({ ok: true, colors: ['#ff0000'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(nodeParams()?.palette).toEqual(['#cccccc']);
  });

  it('another project open, even before its graph replaced the canvas, drops it', async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    const before = canvasGeneration();
    act(() => setProjectContext({ id: 'pB', revision: 'pB-r' }));
    await finish({ ok: true, colors: ['#ff0000'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(canvasGeneration()).toBe(before);
    expect(nodeParams()?.palette).toEqual(['#000000']);
  });

  it('the line clears on the next Extract, and on a swatch edit', async () => {
    const { container } = show(['#000000']);
    let finish = later();
    await extractFrom(container);
    openProject('pB', [textNode('n9')]);
    await finish({ ok: true, colors: ['#ff0000'] });
    act(() => useUIStore.getState().selectNode(null));
    openProject('pA', [colorNode(['#000000'])]);
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(0);
    expect(note(container)?.textContent).toBe(PROJECT_LINE);
    // A swatch edit clears it.
    act(() => { fireEvent.change(container.querySelector('.inspector__palette-hex')!, { target: { value: '#123456' } }); });
    expect(note(container)).toBeNull();
    // Dropped again, then the next Extract clears it.
    finish = later();
    await extractFrom(container);
    openProject('pB', [textNode('n9')]);
    await finish({ ok: true, colors: ['#ff0000'] });
    act(() => useUIStore.getState().selectNode(null));
    openProject('pA', [colorNode(['#000000'])]);
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(0);
    expect(note(container)?.textContent).toBe(PROJECT_LINE);
    finish = later();
    await extractFrom(container);
    expect(note(container)).toBeNull();
    // Gone, not only hidden while it runs: a failed extract leaves no line.
    await finish({ ok: false, reason: 'other' });
    await wait(PALETTE_LINE_MIN_MS);
    expect(note(container)).toBeNull();
  });

  it('a node redefined while away hears nothing on return', async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    openProject('pB', [textNode('n9')]);
    await finish({ ok: true, colors: ['#ff0000'] });
    // Project A's n1 is now another kind of palette-less node.
    openProject('pA', [textNode('n1')]);
    act(() => useUIStore.getState().selectNode(null));
    act(() => useUIStore.getState().selectNode('n1'));
    await wait(0);
    expect(note(container)).toBeNull();
    expect(container.textContent).not.toContain('couldn’t add');
  });

  it('a follow switch says the project line', async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    act(() => setFollowingSwitch({ projectName: 'Brand B', agent: 'Claude' }));
    await finish({ ok: true, colors: ['#ff0000'] });
    expect(nodeParams()?.palette).toEqual(['#000000']);
    act(() => setFollowingSwitch(null));
    await wait(0);
    expect(note(container)?.textContent).toBe(PROJECT_LINE);
  });

  it("offline as it lands: the write drops, and the line gives the lock's reason and what unlocks it", async () => {
    const { container } = show(['#000000']);
    const finish = later();
    await extractFrom(container);
    act(() => noteBackendConnection('offline'));
    await finish({ ok: true, colors: ['#ff0000'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(nodeParams()?.palette).toEqual(['#000000']);
    expect(note(container)?.textContent).toBe(OFFLINE_LINE);
    expect(status(container)).toBe(OFFLINE_LINE);
    expect(container.textContent).not.toContain('Extracted');
    // GM r23: it stays after the reconnect, until the next Extract or a
    // swatch edit, as the project line does.
    act(() => noteBackendConnection('online'));
    await wait(10);
    expect(note(container)?.textContent).toBe(OFFLINE_LINE);
    act(() => { fireEvent.change(container.querySelector('.inspector__palette-hex')!, { target: { value: '#123456' } }); });
    expect(note(container)).toBeNull();
  });
});

describe('one extract per project, graph and node (review 8 LOW-1, GM r22 Q2)', () => {
  it('an Inspector opened again shows the line, read-only swatches at full colour, Strength live', async () => {
    const first = show(['#ff285a', '#3759c7']);
    const finish = later();
    await extractFrom(first.container);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(pending(first.container)).not.toBeNull();
    first.unmount();
    const second = render(<Inspector embedded />);
    expect(pending(second.container)?.textContent).toBe('Extracting colors…');
    const chips = [...second.container.querySelectorAll<HTMLInputElement>('.inspector__palette-color')];
    expect(chips.map((c) => c.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(chips.map((c) => getComputedStyle(c).backgroundColor)).toEqual(['rgb(255, 40, 90)', 'rgb(55, 89, 199)']);
    for (const hex of second.container.querySelectorAll<HTMLInputElement>('.inspector__palette-hex')) expect(hex.readOnly).toBe(true);
    // A hand edit to Strength after reopening stays when the old extract lands.
    const strength = second.container.querySelector<HTMLInputElement>('[data-inspector-param="strength"] input')!;
    expect(strength.disabled).toBe(false);
    act(() => { fireEvent.change(strength, { target: { value: '0.3' } }); });
    // The read-only swatches take no edit meanwhile.
    act(() => { fireEvent.change(second.container.querySelector('.inspector__palette-hex')!, { target: { value: '#123456' } }); });
    expect(nodeParams()?.palette).toEqual(['#ff285a', '#3759c7']);
    await finish({ ok: true, colors: ['#112233'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(nodeParams()).toMatchObject({ palette: ['#112233'], strength: 0.3 });
    expect(pending(second.container)).toBeNull();
    expect(status(second.container)).toBe('Extracted 1 color.');
  });
});

describe('focus across an extract (GM r22 Q3)', () => {
  it('a focused swatch keeps focus, aria-disabled and described by the line; landing keeps the index, clamped', async () => {
    const { container } = show(['#aaaaaa', '#bbbbbb', '#cccccc']);
    const finish = later();
    await extractFrom(container);
    const third = container.querySelectorAll<HTMLInputElement>('.inspector__palette-hex')[2];
    act(() => third.focus());
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    const line = pending(container)!;
    expect(document.activeElement).toBe(third);
    expect(third.getAttribute('aria-disabled')).toBe('true');
    expect(third.getAttribute('aria-describedby')).toBe(line.id);
    expect(line.id).not.toBe('');
    await finish({ ok: true, colors: ['#112233', '#445566'] });
    await wait(PALETTE_LINE_MIN_MS);
    const hexes = container.querySelectorAll<HTMLInputElement>('.inspector__palette-hex');
    expect(hexes).toHaveLength(2);
    // Clamped to the last swatch, the same part.
    expect(document.activeElement).toBe(hexes[1]);
    expect(hexes[1].getAttribute('aria-disabled')).toBeNull();
  });

  it('a focused × in range stays the same element', async () => {
    const { container } = show(['#aaaaaa', '#bbbbbb']);
    const finish = later();
    await extractFrom(container);
    const remove = container.querySelectorAll<HTMLButtonElement>('.inspector__palette-remove')[0];
    act(() => remove.focus());
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(document.activeElement).toBe(remove);
    // A press while read-only removes nothing.
    act(() => { fireEvent.click(remove); });
    expect(nodeParams()?.palette).toEqual(['#aaaaaa', '#bbbbbb']);
    await finish({ ok: true, colors: ['#112233', '#445566', '#778899'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(document.activeElement).toBe(container.querySelectorAll('.inspector__palette-remove')[0]);
  });

  it('focus on Add goes to the line while it shows, then back to Add, not Extract (GM r23)', async () => {
    const { container } = show(['#aaaaaa']);
    const finish = later();
    const add = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Add')!;
    act(() => add().focus());
    await extractFrom(container);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(document.activeElement).toBe(pending(container));
    expect(pending(container)!.tabIndex).toBe(-1);
    await finish({ ok: true, colors: ['#112233'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(document.activeElement).toBe(add());
  });

  it('focus on Extract goes to the line while it shows, then back to Extract', async () => {
    const { container } = show(['#aaaaaa']);
    const finish = later();
    act(() => extractInput(container)!.focus());
    await extractFrom(container);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(document.activeElement).toBe(pending(container));
    await finish({ ok: true, colors: ['#112233'] });
    await wait(PALETTE_LINE_MIN_MS);
    expect(document.activeElement).toBe(extractInput(container));
  });
});
