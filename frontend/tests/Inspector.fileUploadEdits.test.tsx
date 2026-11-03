import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { ModelNodeDefinition, NodeData } from '../src/types';

// fix/file-param-upload-edits (#208 round 8c): a file picked into a file
// param lands over the node's params as they are when the upload answers,
// not as the pick's render saw them. An edit made while it uploads, the
// person's or an agent's, stays; the provider snap runs on it as on any
// edit; an older pick that answers late is dropped; and it never lands on a
// node that's gone or on another project's node with the same id.

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
// The mask painter's canvas needs a real 2D context; its Save is one button
// that hands the Inspector a mask, as the modal's saveMask does.
vi.mock('../src/components/DeferredPanels', async (original) => ({
  ...await original<typeof import('../src/components/DeferredPanels')>(),
  MaskPainterModal: ({ onSave }: { onSave: (dataUri: string) => void }) => (
    <button type="button" data-testid="mask-save" onClick={() => onSave('data:image/png;base64,AAAA')}>Save</button>
  ),
}));

import { Inspector } from '../src/components/panels/Inspector';
import { resetPaletteExtractsForTests } from '../src/components/panels/usePaletteExtracts';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { useGraphStore } from '../src/store/graphStore';
import { useProviderNoteStore } from '../src/store/providerNoteStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProject = getProjectContext();

/** Each /api/uploads call waits until the test answers it. */
let uploads: { name: string; answer: (filePath: string) => void; fail: () => void }[] = [];
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
      fail: () => resolve(new Response('', { status: 503 })),
    }));
  });
  useUIStore.setState(initialUI, true);
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  setProjectContext(initialProject);
});

const params = () => useGraphStore.getState().nodes.find((n) => n.id === 'n1')?.data.params ?? {};

function show(definitionId = 'style-reference', extra: Record<string, unknown> = {}) {
  const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Reference', definitionId, params: { filePath: '', strength: 0.7, ...extra }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null, undoStack: [] });
  useUIStore.getState().selectNode('n1');
  return render(<Inspector embedded />);
}

async function pick(container: HTMLElement, name = 'ref.png') {
  const inputs = container.querySelectorAll('.inspector__file-input');
  expect(inputs).toHaveLength(1);
  await act(async () => {
    fireEvent.change(inputs[0], { target: { files: [new File([new Uint8Array(8)], name, { type: 'image/png' })] } });
  });
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('a file upload into a file param', () => {
  it("keeps what the person typed into another param while it uploaded", async () => {
    const { container } = show();
    await pick(container);
    const strength = container.querySelector('input[aria-label="Strength"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(strength, { target: { value: '0.35' } }); });
    expect(params().strength).toBe(0.35);
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params()).toMatchObject({ filePath: '/out/chat-uploads/abc.png', strength: 0.35,
      _fileName: { file: 'abc.png', name: 'ref.png' } });
    expect(String(params()._previewUrl)).toContain('/api/outputs/chat-uploads/abc.png');
  });

  it("keeps an agent's edit (updateNodeData, as MCP and the CLI land) made while it uploaded", async () => {
    const { container } = show();
    await pick(container);
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { ...params(), strength: 0.2, mode: 'manual' } }); });
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params()).toMatchObject({ filePath: '/out/chat-uploads/abc.png', strength: 0.2, mode: 'manual' });
  });

  it('resolves an agent setting the same file param mid-upload as last writer wins: the upload, landing last', async () => {
    const { container } = show();
    await pick(container);
    // An agent can set the public file param (edit_canvas, `nebula set`),
    // never _previewUrl or _fileName (internal): it lands alone.
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { ...params(), filePath: '/out/agent.png' } }); });
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params()).toMatchObject({ filePath: '/out/chat-uploads/abc.png', _fileName: { file: 'abc.png', name: 'ref.png' } });
    expect(String(params()._previewUrl)).toContain('/api/outputs/chat-uploads/abc.png');
  });

  it('lands only the newest pick into the param, whichever answers first', async () => {
    const { container } = show();
    await pick(container, 'old.png');
    await pick(container, 'new.png');
    expect(uploads.map((u) => u.name)).toEqual(['old.png', 'new.png']);
    // The newer answers first; the older, later, is dropped.
    uploads[1].answer('/out/chat-uploads/new.png');
    await settle();
    uploads[0].answer('/out/chat-uploads/old.png');
    await settle();
    expect(params()).toMatchObject({ filePath: '/out/chat-uploads/new.png', _fileName: { file: 'new.png', name: 'new.png' } });

    // The older answers first: dropped, and the newer still lands.
    await pick(container, 'third.png');
    await pick(container, 'fourth.png');
    uploads[2].answer('/out/chat-uploads/third.png');
    await settle();
    expect(params().filePath).toBe('/out/chat-uploads/new.png');
    uploads[3].answer('/out/chat-uploads/fourth.png');
    await settle();
    expect(params().filePath).toBe('/out/chat-uploads/fourth.png');
  });

  it("says nothing of an older pick's failure once a newer one replaced it", async () => {
    const { container } = show();
    await pick(container, 'old.png');
    await pick(container, 'new.png');
    uploads[0].fail();
    await settle();
    expect(useGraphStore.getState().undoNotice).toBeNull();
    uploads[1].fail();
    await settle();
    expect(useGraphStore.getState().undoNotice?.text).toContain('Couldn\'t upload “new.png”.');
  });

  it('writes nothing to a node deleted mid-upload, and nothing throws', async () => {
    const errors: unknown[] = [];
    const onError = (event: PromiseRejectionEvent | ErrorEvent) => errors.push(event);
    window.addEventListener('unhandledrejection', onError);
    window.addEventListener('error', onError);
    try {
      const { container } = show();
      await pick(container);
      act(() => { useGraphStore.getState().deleteNode('n1'); });
      expect(useGraphStore.getState().nodes).toHaveLength(0);
      uploads[0].answer('/out/chat-uploads/abc.png');
      await settle();
      expect(useGraphStore.getState().nodes).toHaveLength(0);
      // The delete's own line, and no upload line over it.
      expect(useGraphStore.getState().undoNotice?.text).toBe('Deleted the node.');

      // Its add undone (the canvas without it), then a node of another
      // kind under the same id: nothing lands on that one either.
      cleanup();
      const second = show();
      await pick(second.container);
      act(() => { useGraphStore.setState({ nodes: [] }); });
      act(() => { useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
        data: { label: 'Image', definitionId: 'image-input', params: { filePath: '' }, state: 'idle', outputs: {} } }] }); });
      uploads[1].answer('/out/chat-uploads/def.png');
      await settle();
      expect(params()).toEqual({ filePath: '' });
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onError);
      window.removeEventListener('error', onError);
    }
  });

  it("never lands on another project's node with the same id", async () => {
    setProjectContext({ id: 'project-a', revision: 'r1' });
    const { container } = show();
    await pick(container);
    // The person switches to project B, whose canvas has its own n1.
    act(() => {
      setProjectContext({ id: 'project-b', revision: 'r1' });
      useGraphStore.getState().updateNodeData('n1', { params: { filePath: '/out/b-own.png', strength: 0.5 } });
    });
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(params()).toEqual({ filePath: '/out/b-own.png', strength: 0.5 });
  });

  it('takes one undo step, which puts back the params from before it landed', async () => {
    // Past the store's 500 ms merge of one node's edits into one step.
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    const { container } = show();
    await pick(container);
    const before = useGraphStore.getState().undoStack.length;
    uploads[0].answer('/out/chat-uploads/abc.png');
    await settle();
    expect(useGraphStore.getState().undoStack.length).toBe(before + 1);
    act(() => { useGraphStore.getState().undo(); });
    expect(params().filePath).toBe('');
  });

  it('runs the provider snap, as any edit does: a setting the new file hides goes back to its default', async () => {
    // A route-table node whose file param controls another setting. No
    // shipped node has one yet, so FLUX.2 with its Model as a file param:
    // on fal.ai, klein 4B doesn't take Safety 3, so Safety goes back to 2
    // with the card's note.
    const flux = NODE_DEFINITIONS['flux-2-pro'] as ModelNodeDefinition;
    const fileModel: ModelNodeDefinition = { ...flux, id: 'test-file-model',
      sharedParams: flux.sharedParams!.map((param) => (param.key === 'model' ? { ...param, type: 'file' } : param)) };
    (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['test-file-model'] = fileModel;
    try {
      const { container } = show('test-file-model', { _provider: 'fal', model: 'pro', safety_tolerance: '3' });
      await pick(container);
      uploads[0].answer('klein-4b');
      await settle();
      expect(params()).toMatchObject({ model: 'klein-4b', safety_tolerance: '2' });
      expect(useProviderNoteStore.getState().notes.n1).toBe("Safety 3 isn't on fal.ai with FLUX.2 [klein] 4B: back to 2");
    } finally {
      delete (NODE_DEFINITIONS as Record<string, ModelNodeDefinition>)['test-file-model'];
    }
  });

  // #208's notes called the mask painter's Save low risk, not reproduced.
  // Rechecked: its Save is synchronous (no await before the write), and the
  // modal gets the Inspector's newest onSave on every render, so an agent's
  // edit made while the painter is open is part of what Save writes over.
  it("the mask painter's Save keeps an agent's edit made while it was open", async () => {
    const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Mask', definitionId: 'mask-painter', params: { polarity: 'white-edit' }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
    useUIStore.getState().selectNode('n1');
    const { getByText, findByTestId } = render(<Inspector embedded />);
    await act(async () => { fireEvent.click(getByText(/Paint Mask/)); });
    const save = await findByTestId('mask-save');
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { ...params(), polarity: 'black-edit' } }); });
    await act(async () => { fireEvent.click(save); });
    expect(params()).toEqual({ polarity: 'black-edit', _maskData: 'data:image/png;base64,AAAA' });
  });
});
