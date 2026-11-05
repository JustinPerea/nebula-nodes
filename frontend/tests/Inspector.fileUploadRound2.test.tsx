import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// GM r46 on #222 (fix/file-param-upload-edits round 2):
// - the file row reads "Uploading “name”…" while an upload is on its way,
//   the control still live;
// - an upload dropped for a project switch or a graph replace says so under
//   the param, once, when the person is back on the node; ordinary edits,
//   the person's or an agent's, never drop one (the graph generation only
//   moves on a replace);
// - with no preview, the frame collapses and "No preview" sits under the name.

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
import { resetPaletteExtractsForTests, PALETTE_PENDING_DELAY_MS } from '../src/components/panels/usePaletteExtracts';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { setFollowingSwitch } from '../src/lib/canvasFollow';
import { canvasGeneration, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProject = getProjectContext();

let uploads: { name: string; answer: (filePath: string) => void }[] = [];
beforeEach(() => {
  resetPaletteExtractsForTests();
  uploads = [];
  api.fetch.mockReset();
  api.fetch.mockImplementation((path: string, init?: RequestInit) => {
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
/** Past the line's delay and its minimum. */
const landed = () => wait(450);

function show(nodes: Node<NodeData>[] = [styleRef('n1')], select = 'n1') {
  useGraphStore.setState({ nodes, edges: [], undoNotice: null, undoStack: [] });
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
const LINE = (name: string) =>
  `Nebula couldn’t add “${name}” because the project changed before it finished uploading. Choose the file again.`;

describe('the file row while an upload is on its way', () => {
  it('reads "Uploading “name”…" in place of the name, the control live and described by the row, never announced', async () => {
    const { container } = show();
    await pick(container);
    // A quick upload changes nothing (#204's one loading look).
    expect(row(container).textContent).toBe('Choose File');
    await wait(PALETTE_PENDING_DELAY_MS + 50);
    expect(row(container).textContent).toBe('Uploading “green.png”…');
    const input = container.querySelector('.inspector__file-input') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-describedby')).toBe(row(container).id);
    expect(container.querySelector('.inspector__control-stack [role="status"]')?.textContent).toBe('');
    // The newest pick names itself, its long name cut in the middle.
    await pick(container, 'harbour-at-dawn-from-the-north-pier-final.png');
    expect(row(container).textContent).toBe('Uploading “harbour-at-dawn-from-th….png”…');
    uploads[1].answer('/out/chat-uploads/abc.png');
    await landed();
    expect(row(container).textContent).toBe('harbour-at-dawn-from-th….png');
    expect(input.getAttribute('aria-describedby')).toBeNull();
    // The older, answering late, is dropped.
    uploads[0].answer('/out/chat-uploads/old.png');
    await settle();
    expect(params().filePath).toBe('/out/chat-uploads/abc.png');
  });
});

describe('an upload dropped for a project switch or a graph replace', () => {
  it('says so under the param once, when the person is back on the node, until the next pick', async () => {
    const view = show();
    await pick(view.container, 'sunset.png');
    // The person opens project B, whose canvas has its own n1.
    act(() => { setProjectContext({ id: 'project-b', revision: 'r2' }); });
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params().filePath).toBe('');
    cleanup();
    expect(note(show([styleRef('n1')]).container)).toBeNull(); // not B's
    cleanup();
    // Back in project A, on the node.
    act(() => { setProjectContext({ id: 'project-a', revision: 'r1' }); });
    let back = show([styleRef('n1')]);
    expect(note(back.container)).toBe(LINE('sunset.png'));
    // Once: leaving the node and coming back, it's gone.
    act(() => { useUIStore.getState().selectNode(null); });
    await wait(10);
    act(() => { useUIStore.getState().selectNode('n1'); });
    expect(note(back.container)).toBeNull();
    cleanup();
    // The next pick clears a line still waiting.
    act(() => { setProjectContext({ id: 'project-b', revision: 'r2' }); });
    back = show([styleRef('n1')]);
    await pick(back.container, 'a-very-long-name-for-the-evening-sunset-shot.png');
    act(() => { setProjectContext({ id: 'project-c', revision: 'r3' }); });
    uploads[1].answer('/out/chat-uploads/def.png');
    await settle();
    cleanup();
    act(() => { setProjectContext({ id: 'project-b', revision: 'r2' }); });
    back = show([styleRef('n1')]);
    expect(note(back.container)).toBe(LINE('a-very-long-name-for-th….png'));
    await pick(back.container, 'again.png');
    expect(note(back.container)).toBeNull();
  });

  it('an agent opening another project (the follow switch, before the canvas goes) drops it with the line', async () => {
    const view = show();
    await pick(view.container, 'sunset.png');
    act(() => setFollowingSwitch({ agent: 'Codex', projectName: 'Second canvas' }));
    try {
      uploads[0].answer('/out/chat-uploads/abc.png');
      await settle();
      expect(params().filePath).toBe('');
    } finally {
      act(() => setFollowingSwitch(null));
    }
    cleanup();
    expect(note(show([styleRef('n1')]).container)).toBe(LINE('sunset.png'));
  });

  it('a node deleted or redefined meanwhile hears nothing', async () => {
    const view = show();
    await pick(view.container, 'sunset.png');
    act(() => { useGraphStore.getState().deleteNode('n1'); });
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    cleanup();
    expect(note(show([styleRef('n1')]).container)).toBeNull();
  });

  it('an agent clear (a graph replace) drops it, said when the node is back', async () => {
    const view = show();
    await pick(view.container, 'sunset.png');
    const generation = canvasGeneration();
    act(() => ws.emit({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
      cleared: true, canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } }));
    expect(canvasGeneration()).toBe(generation + 1);
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    cleanup();
    const back = show([styleRef('n1')]);
    expect(params().filePath).toBe('');
    expect(note(back.container)).toBe(LINE('sunset.png'));
  });
});

describe('ordinary edits never drop an upload: the graph generation moves only on a replace', () => {
  it("the person's edits, a move, nodes added and removed, and an agent's edit_canvas sync", async () => {
    const view = show([styleRef('n1'), styleRef('n2')]);
    const generation = canvasGeneration();
    await pick(view.container, 'sunset.png');
    const strength = view.container.querySelector('input[aria-label="Strength"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(strength, { target: { value: '0.35' } }); });
    act(() => {
      const store = useGraphStore.getState();
      store.onNodesChange([{ id: 'n1', type: 'position', position: { x: 40, y: 80 } }]);
      store.updateNodeData('n2', { params: { ...params('n2'), strength: 0.1 } });
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, styleRef('n3')] });
      store.deleteNode('n2');
    });
    // An agent's edit_canvas reaches the tab as a graphSync with its edit.
    act(() => ws.emit({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      canvasRevision: '1', edges: [], edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } },
      nodes: [{ ...styleRef('n1', { strength: 0.35, focus: 'lighting' }), position: { x: 40, y: 80 } }, styleRef('n3')] }));
    expect(canvasGeneration()).toBe(generation);
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params()).toMatchObject({ filePath: '/out/chat-uploads/abc.png', strength: 0.35, focus: 'lighting' });
    expect(note(view.container)).toBeNull();
  });
});

describe('a file with no preview (GM r46 Q2)', () => {
  it('shows "No preview" under the name and draws no frame', () => {
    const { container } = show([styleRef('n1', { filePath: '/elsewhere/harbour.png' })]);
    expect(row(container).textContent).toBe('harbour.png');
    expect(container.querySelector('.inspector__file-no-preview')?.textContent).toBe('No preview');
    expect(container.querySelector('.inspector__file-preview-frame')).toBeNull();
  });

  it('collapses the frame when an agent sets a file Nebula has no preview of, keeping the old image inside while it closes', () => {
    const { container } = show([styleRef('n1', { filePath: '/out/chat-uploads/abc.png', _previewUrl: '/api/outputs/chat-uploads/abc.png',
      _fileName: { file: 'abc.png', name: 'sunset.png' } })]);
    const frame = container.querySelector('.inspector__file-preview-frame') as HTMLElement;
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
    expect(container.querySelector('.inspector__file-no-preview')).toBeNull();
    expect(row(container).textContent).toBe('sunset.png');
    // What the backend leaves after `nebula set n1 filePath=…` (file_param_preview.py).
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { filePath: '/elsewhere/harbour.png', strength: 0.7 } }); });
    expect(frame.getAttribute('data-collapsed')).toBe('true');
    expect(frame.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(row(container).textContent).toBe('harbour.png');
    expect(container.querySelector('.inspector__file-no-preview')?.textContent).toBe('No preview');
    // A preview again opens it.
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { filePath: '/out/chat-uploads/b.png', _previewUrl: '/api/outputs/chat-uploads/b.png' } }); });
    expect(frame.hasAttribute('data-collapsed')).toBe(false);
    expect(container.querySelector('.inspector__file-no-preview')).toBeNull();
  });

  it('glides on the layout spring, and jumps under reduced motion', () => {
    const css = readFileSync(join(__dirname, '../src/styles/panels.css'), 'utf8');
    expect(css).toMatch(/\.inspector__file-preview-frame \{[^}]*transition: grid-template-rows var\(--inspector-layout-spring\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.inspector__file-preview-frame \{\s*transition: none;/);
    // The popover's own layout spring, the same curve.
    const springs = [...css.matchAll(/--inspector-layout-spring:\s*([^;]+);/g)].map((m) => m[1]);
    expect(springs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(springs).size).toBe(1);
    expect(springs[0]).toMatch(/^360ms linear\(/);
  });
});
