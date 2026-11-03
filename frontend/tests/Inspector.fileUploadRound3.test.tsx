import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// GM r48 on #222 (fix/file-param-upload-edits round 3):
// - bug 1: while an upload is in flight, never "No preview". A preview the
//   param holds stays until the new one lands; with nothing, or a file with
//   no preview, nothing shows under the row;
// - bug 2: the dropped-upload line goes on ANY change to that param's value:
//   a person's pick, an agent's set (graphSync), an undo or a redo;
// - Q1: a file param's name is the name it was uploaded with, else the
//   path's base name, never a bare content hash ("Uploaded file").

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
const ws = vi.hoisted(() => {
  const handlers = new Set<(event: unknown) => void>();
  return {
    emit: (event: unknown) => { for (const handler of [...handlers]) handler(event); },
    client: {
      connect: () => {}, send: () => {}, disconnect: () => {},
      subscribe: (handler: (event: unknown) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
      subscribeFirst: (handler: (event: unknown) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    },
  };
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: ws.client }));

import { Inspector } from '../src/components/panels/Inspector';
import {
  paletteDropNote, paletteNoteKey, resetPaletteExtractsForTests, setPaletteDropNote, PALETTE_PENDING_DELAY_MS,
} from '../src/components/panels/usePaletteExtracts';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { recordedUploadName, resetUploadNamesForTests } from '../src/lib/uploadNames';
import { fileParamName } from '../src/lib/fileName';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProject = getProjectContext();

const HASH = 'c0ffee'.repeat(10) + 'beef';
let recorded: Record<string, string> = {};
let uploads: { name: string; answer: (filePath: string) => void }[] = [];
beforeEach(() => {
  resetPaletteExtractsForTests();
  resetUploadNamesForTests();
  uploads = [];
  recorded = {};
  api.fetch.mockReset();
  api.fetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.startsWith('/api/uploads/names?')) {
      const asked = new URLSearchParams(path.split('?')[1]).getAll('file');
      const names = Object.fromEntries(asked.filter((f) => recorded[f]).map((f) => [f, recorded[f]]));
      return Promise.resolve(new Response(JSON.stringify({ names }), { status: 200 }));
    }
    if (path !== '/api/uploads') return Promise.resolve(new Response('{}'));
    const file = (init?.body as FormData).get('file') as File;
    return new Promise<Response>((resolve) => uploads.push({
      name: file.name,
      answer: (filePath) => resolve(new Response(JSON.stringify({
        filePath, url: `/api/outputs/chat-uploads/${filePath.split('/').pop()}` }), { status: 200 })),
    }));
  });
  useUIStore.setState(initialUI, true);
  setProjectContext({ id: 'project-a', revision: 'r1', canvas: '1' });
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  setProjectContext(initialProject);
});

const params = (id = 'n1') => useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params ?? {};
const styleRef = (id: string, extra: Record<string, unknown> = {}): Node<NodeData> => ({ id, type: 'model', position: { x: 0, y: 0 },
  data: { label: 'Reference', definitionId: 'style-reference', params: { filePath: '', strength: 0.7, ...extra }, state: 'idle', outputs: {} } });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const landed = () => wait(450);

function show(nodes: Node<NodeData>[] = [styleRef('n1')], select = 'n1') {
  useGraphStore.setState({ nodes, edges: [], undoNotice: null, undoStack: [], redoStack: [] });
  useUIStore.getState().selectNode(select);
  return render(<Inspector embedded />);
}

async function pick(container: HTMLElement, name = 'green.png') {
  const input = container.querySelector('.inspector__file-input') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(8)], name, { type: 'image/png' })] } });
  });
}

const row = (container: HTMLElement) => container.querySelector('.inspector__file-button span') as HTMLElement;
const note = (container: HTMLElement) => container.querySelector('.inspector__control-stack .inspector__palette-note')?.textContent ?? null;
const noPreview = (container: HTMLElement) => container.querySelector('.inspector__file-no-preview')?.textContent ?? null;
const frame = (container: HTMLElement) => container.querySelector('.inspector__file-preview-frame') as HTMLElement | null;
const LINE = (name: string) =>
  `Nebula couldn’t add “${name}” because the project changed before it finished uploading. Choose the file again.`;
// Bug 2's node: its own id, so no write left from an earlier test's upload
// into n1 (a param push still pending) holds its params against a sync.
const D = 'n7';
const NOTE_KEY = paletteNoteKey('project-a', D, 'filePath');

/** The line as an upload dropped for a project switch leaves it, over `value`. */
function dropLine(value: unknown, name = 'sunset.png') {
  setPaletteDropNote(NOTE_KEY, { text: LINE(name), definitionId: 'style-reference',
    file: { project: 'project-a', nodeId: D, key: 'filePath', value } });
}

describe('bug 1: never "No preview" while an upload is in flight', () => {
  it('a param holding a file with no preview (shot 1\'s case): nothing under the row until the new one lands', async () => {
    const { container } = show([styleRef('n1', { filePath: '/elsewhere/harbour.png' })]);
    expect(noPreview(container)).toBe('No preview');
    await pick(container);
    // From the pick, not only once the row reads "Uploading…".
    expect(noPreview(container)).toBeNull();
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(row(container).textContent).toBe('Uploading “green.png”…');
    expect(noPreview(container)).toBeNull();
    expect(frame(container)).toBeNull();
    uploads[0].answer('/out/chat-uploads/green.png');
    await landed();
    expect(row(container).textContent).toBe('green.png');
    expect(frame(container)?.querySelector('img')?.getAttribute('src')).toContain('green.png');
    expect(noPreview(container)).toBeNull();
  });

  it('a param holding nothing: nothing under the row', async () => {
    const { container } = show();
    await pick(container);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(row(container).textContent).toBe('Uploading “green.png”…');
    expect(noPreview(container)).toBeNull();
    expect(frame(container)).toBeNull();
    const stack = container.querySelector('.inspector__control-stack') as HTMLElement;
    expect([...stack.children].map((c) => c.className)).toEqual(['inspector__file-button', 'inspector__palette-status']);
  });

  it('a param holding a file with a preview keeps that preview until the new one lands', async () => {
    const { container } = show([styleRef('n1', { filePath: '/out/chat-uploads/sunset.png',
      _previewUrl: '/api/outputs/chat-uploads/sunset.png' })]);
    await pick(container);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(row(container).textContent).toBe('Uploading “green.png”…');
    expect(frame(container)?.hasAttribute('data-collapsed')).toBe(false);
    expect(frame(container)?.querySelector('img')?.getAttribute('src')).toBe('/api/outputs/chat-uploads/sunset.png');
    expect(noPreview(container)).toBeNull();
    uploads[0].answer('/out/chat-uploads/green.png');
    await landed();
    expect(frame(container)?.querySelector('img')?.getAttribute('src')).toContain('green.png');
  });
});

describe('bug 2: the dropped line goes on any change to its param', () => {
  it("an agent's set (a graphSync, as MCP edit_canvas or `nebula set` reaches the tab) clears it", async () => {
    act(() => dropLine(''));
    const view = show([styleRef(D)], D);
    expect(note(view.container)).toBe(LINE('sunset.png'));
    act(() => ws.emit({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      canvasRevision: '1', edges: [], edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } },
      nodes: [styleRef(D, { filePath: '/out/chat-uploads/harbour.png' })] }));
    expect(params(D).filePath).toBe('/out/chat-uploads/harbour.png');
    expect(note(view.container)).toBeNull();
    // Cleared, not hidden: the agent setting it back doesn't bring it back.
    expect(paletteDropNote(NOTE_KEY)).toBeNull();
    act(() => ws.emit({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      canvasRevision: '1', edges: [], edit: { id: 'ed_agent2', actor: { kind: 'agent', name: 'Codex' } },
      nodes: [styleRef(D, { filePath: '' })] }));
    expect(note(view.container)).toBeNull();
  });

  it("a person's edit, an undo and a redo clear it", async () => {
    const back = show([styleRef(D, { filePath: '/out/chat-uploads/b.png' })], D);
    act(() => dropLine('/out/chat-uploads/b.png'));
    expect(note(back.container)).toBe(LINE('sunset.png'));
    // Past the store's 500 ms undo coalescing, so the edit is its own step.
    await wait(520);
    act(() => { useGraphStore.getState().updateNodeData(D, { params: { ...params(D), filePath: '/out/chat-uploads/a.png' } }); });
    expect(note(back.container)).toBeNull();
    expect(paletteDropNote(NOTE_KEY)).toBeNull();
    act(() => dropLine('/out/chat-uploads/a.png'));
    expect(note(back.container)).toBe(LINE('sunset.png'));
    act(() => { useGraphStore.getState().undo(); });
    expect(params(D).filePath).toBe('/out/chat-uploads/b.png');
    expect(note(back.container)).toBeNull();
    expect(paletteDropNote(NOTE_KEY)).toBeNull();
    act(() => dropLine('/out/chat-uploads/b.png'));
    expect(note(back.container)).toBe(LINE('sunset.png'));
    act(() => { useGraphStore.getState().redo(); });
    expect(params(D).filePath).toBe('/out/chat-uploads/a.png');
    expect(note(back.container)).toBeNull();
    expect(paletteDropNote(NOTE_KEY)).toBeNull();
  });

  it('a value changed while the person was in another project: never shown over it', () => {
    act(() => dropLine(''));
    const view = show([styleRef(D, { filePath: '/out/chat-uploads/harbour.png' })], D);
    expect(note(view.container)).toBeNull();
  });

  it("another node's edit, or another param of the same node, keeps it", () => {
    act(() => dropLine(''));
    const view = show([styleRef(D), styleRef('n2')], D);
    act(() => {
      useGraphStore.getState().updateNodeData('n2', { params: { ...params('n2'), filePath: '/out/x.png' } });
      useGraphStore.getState().updateNodeData(D, { params: { ...params(D), strength: 0.2 } });
    });
    expect(note(view.container)).toBe(LINE('sunset.png'));
  });

  it("a project switch and back (another canvas's n1 in between) keeps it", async () => {
    act(() => dropLine(''));
    act(() => { setProjectContext({ id: 'project-b', revision: 'r2' }); });
    useGraphStore.setState({ nodes: [styleRef(D, { filePath: '/b/other.png' })] });
    act(() => { setProjectContext({ id: 'project-a', revision: 'r1' }); });
    const view = show([styleRef(D)], D);
    expect(note(view.container)).toBe(LINE('sunset.png'));
  });
});

describe('Q1: the name a file param shows', () => {
  it('a bare content hash never renders: the row, the in-flight row and the dropped line say "Uploaded file"', async () => {
    const view = show([styleRef('n1', { filePath: `/out/chat-uploads/${HASH}.png` })]);
    await settle();
    expect(row(view.container).textContent).toBe('Uploaded file');
    await pick(view.container, `${HASH}.png`);
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(row(view.container).textContent).toBe('Uploading “Uploaded file”…');
    expect(row(view.container).getAttribute('title')).toBe('Uploaded file');
    act(() => { setProjectContext({ id: 'project-b', revision: 'r2' }); });
    uploads[0].answer(`/out/chat-uploads/${HASH}.png`);
    await landed();
    cleanup();
    act(() => { setProjectContext({ id: 'project-a', revision: 'r1' }); });
    const back = show([styleRef('n1', { filePath: `/out/chat-uploads/${HASH}.png` })]);
    expect(note(back.container)).toBe(LINE('Uploaded file'));
    expect(back.container.textContent).not.toMatch(/[0-9a-f]{32}/i);
  });

  it("names a stored file by Nebula's upload record (an agent's own upload, set over MCP)", async () => {
    recorded[`${HASH}.png`] = 'harbour.png';
    const view = show([styleRef('n1', { filePath: `/out/chat-uploads/${HASH}.png` })]);
    await settle();
    expect(row(view.container).textContent).toBe('harbour.png');
    expect(api.fetch).toHaveBeenCalledWith(`/api/uploads/names?file=${HASH}.png`);
    // Asked once, however many renders read it while the answer was on its way.
    await settle();
    expect(api.fetch.mock.calls.filter(([path]) => String(path).startsWith('/api/uploads/names'))).toHaveLength(1);
  });

  it('asks once for a stored name while its answer is on its way', async () => {
    let answer: (r: Response) => void = () => {};
    api.fetch.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    expect(recordedUploadName(`${HASH}.png`)).toBeUndefined();
    await settle();
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(recordedUploadName(`${HASH}.png`)).toBeUndefined();
    await settle();
    expect(api.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { answer(new Response(JSON.stringify({ names: { [`${HASH}.png`]: 'harbour.png' } }), { status: 200 })); });
    await settle();
    expect(recordedUploadName(`${HASH}.png`)).toBe('harbour.png');
  });

  it("the person's own upload is named at once, without asking", async () => {
    const view = show();
    await pick(view.container, 'teal-orange.png');
    uploads[0].answer(`/out/chat-uploads/${HASH}.png`);
    await landed();
    expect(row(view.container).textContent).toBe('teal-orange.png');
    // Any param holding that stored file (not only filePath, which keeps
    // `_fileName`) has its name from this tab's own upload.
    expect(fileParamName({ lut: `/elsewhere/${HASH}.png` }, 'lut')).toBe('teal-orange.png');
    await settle();
    expect(api.fetch.mock.calls.some(([path]) => String(path).startsWith('/api/uploads/names'))).toBe(false);
  });
});
