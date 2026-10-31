import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// GM r39 item 3 and r40 items 1 and 2 (PR #198 review 24, "Undo before the
// Delete is answered"): an Undo pressed while its Delete is still on its way
// waits for the Delete's answer with nothing said, then restores like any
// Undo ("Restored the node."). A refused Delete brings the node back with its
// own failure line and drops the held press silently. A refused or failed
// restore, or no Delete answer within 15 s, says one neutral line that reads
// the name live: "Nebula couldn’t bring back “X”. Try Undo again." After the
// 15 s give-up a late Delete answer never restores by itself; the next Undo
// press does. Before r39 (r18 option (c)) the press was refused at once with
// "Nothing was undone. Your last change was still saving."

type Answer = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  held: new Map<string, (answer: Answer) => void>(),
  holdDeletes: true,
  /** The restore's answer: a status, or 'hold' to keep it on its way. */
  restore: 200 as number | 'hold',
  heldRestores: [] as Array<(answer: Answer) => void>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      const answer = net.holdDeletes
        ? await new Promise<Answer>((resolve) => { net.held.set(deleted[1], resolve); })
        : { status: 200, body: { status: 'deleted', id: deleted[1] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (path === '/api/graph/restore') {
      const ok = { status: 200, body: { status: 'restored', reattached: [], reopened: [], notReopened: [], pinsLeft: [], removals: [] } };
      const answer = net.restore === 'hold'
        ? await new Promise<Answer>((resolve) => { net.heldRestores.push(resolve); })
        : net.restore === 200 ? ok : { status: net.restore, body: { detail: 'Nebula refused it.' } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';

const DROPPED = 'Nothing was undone. Your last change was still saving.';
/** GM r39 item 3 / r40 item 2, verbatim (curly quotes). */
const bringBack = (names: string) => `Nebula couldn’t bring back ${names}. Try Undo again.`;

const initialGraph = useGraphStore.getState();
function textNode(id: string, label: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
function sceneNode(id: string, label: string): Node<NodeData> {
  return { id, type: 'cinemaSceneNode', position: { x: 300, y: 100 },
    data: { label, definitionId: 'cinema-scene', state: 'idle', outputs: {},
      params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'A' }] } } } } as Node<NodeData>;
}
function wire(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge' };
}
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const stacks = () => ({ undo: store().undoStack.length, redo: store().redoStack.length });
/** Every line the canvas shows now. */
const lines = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean) as string[];
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { store().undo(); }); await settle(); };
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'It is running.' } });
  });
  await settle();
};
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore');

describe('an Undo held on a Delete (GM r39 item 3, r40 items 1 and 2)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    net.restore = 200;
    net.heldRestores.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    // Nothing left on its way for the next test (presses and restores queue behind it).
    for (const [id, resolve] of [...net.held]) {
      net.held.delete(id);
      await act(async () => { resolve({ status: 200, body: { status: 'deleted', id } }); });
    }
    for (const resolve of net.heldRestores.splice(0)) await act(async () => { resolve({ status: 200, body: {} }); });
    await settle();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const setGraph = (nodes: Node<NodeData>[], edges: Edge[] = []) => useGraphStore.setState({ nodes, edges, isExecuting: false,
    undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [] } as never);

  it.each([
    ['a Text node', textNode('n2', 'Brief')],
    ['a Cinema scene', sceneNode('n2', 'Ref scene')],
  ])('%s: the press waits silently, then restores once the Delete answers, with "Restored the node."', async (_kind, node) => {
    setGraph([textNode('n1', 'Prompt'), node], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    // The node leaves at once (GM r18), and the press waits with nothing said.
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(lines()).not.toContain(DROPPED);
    expect(ids()).toEqual(['n1']);
    expect(restores()).toHaveLength(0);
    await answer('n2');
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().edges.map((edge) => edge.id)).toEqual(['e-n1-n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(restores()).toHaveLength(1);
    expect(store().undoNotice?.text).toBe('Restored the node.');
    expect(lines()).not.toContain(DROPPED);
  });

  it('a refused Delete: the node comes back with its own failure line, and the held press says nothing', async () => {
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'Edited' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // Held: nothing said while it waits.
    expect(lines()).toEqual([]);
    await answer('n2', 409);
    expect(ids()).toEqual(['n1', 'n2']);
    // The Delete's own line, alone: no "Nothing was undone", no skipped count beside it.
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^Couldn.t delete/);
    expect(lines().join(' ')).not.toMatch(/Nothing was undone|skipped|bring back/);
    // The press went to nothing: the edit below stays, nothing was restored.
    expect(store().nodes.find((n) => n.id === 'n1')?.data.params.value).toBe('Edited');
    expect(restores()).toHaveLength(0);
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
  });

  it('a refused Delete of two nodes: the same, silent', async () => {
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief'), textNode('n3', 'Note')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'Edited' } }); });
    act(() => { store().deleteCanvasElements(['n2', 'n3'], []); }); await settle();
    await undo();
    expect(lines()).toEqual([]);
    await answer('n2', 409);
    await answer('n3', 409);
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(lines().join(' ')).not.toMatch(/Nothing was undone|skipped|bring back/);
    expect(store().nodes.find((n) => n.id === 'n1')?.data.params.value).toBe('Edited');
    expect(restores()).toHaveLength(0);
  });

  it('two deletes, two held presses, the second Delete refused: the first restores, the second goes silently', async () => {
    setGraph([textNode('n1', 'Brief'), textNode('n2', 'Note'), textNode('n3', 'Prompt')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    expect(lines()).toEqual([]);
    await answer('n1');
    // The first press restores n1 beneath the second delete, still on its way.
    expect(ids()).toEqual(['n1', 'n3']);
    await answer('n2', 409);
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    // The second press was held on the refused Delete: no skipped count, no dropped line.
    expect(lines().join(' ')).not.toMatch(/skipped|Nothing was undone|bring back/);
    expect(restores()).toHaveLength(1);
  });

  it('a refused restore says the new line with the name, and the node goes back off the canvas', async () => {
    net.restore = 409;
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    await answer('n2');
    expect(restores()).toHaveLength(1);
    expect(store().undoNotice?.text).toBe(bringBack('“Brief”'));
    expect(lines().join(' ')).not.toMatch(/Couldn.t undo that/);
    expect(ids()).toEqual(['n1']);
    // The delete's step is back, so Undo can be tried again.
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    net.restore = 200;
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().undoNotice?.text).toBe('Restored the node.');
  });

  it('a rename between the press and the answer: the line names the card as it reads when the answer arrives', async () => {
    net.restore = 'hold';
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    await answer('n2');
    // The held press applied: the node is back and its restore is on its way.
    expect(ids()).toEqual(['n1', 'n2']);
    expect(net.heldRestores).toHaveLength(1);
    act(() => { store().updateNodeData('n2', { label: 'Hero brief' }); });
    await settle();
    const resolve = net.heldRestores.shift()!;
    await act(async () => { resolve({ status: 409, body: { detail: 'Nebula refused it.' } }); });
    await settle();
    expect(lines()).toContain(bringBack('“Hero brief”'));
    expect(lines().join(' ')).not.toMatch(/“Brief”/);
  });

  it('several nodes: the shared name-list wording', async () => {
    net.restore = 409;
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief'), textNode('n3', 'Note')]);
    act(() => { store().deleteCanvasElements(['n2', 'n3'], []); }); await settle();
    await undo();
    await answer('n2');
    await answer('n3');
    expect(store().undoNotice?.text).toBe(bringBack('“Brief” and “Note”'));
  });

  it('four nodes: counted, as the name-list rule says', async () => {
    net.restore = 409;
    setGraph([textNode('n1', 'A'), textNode('n2', 'B'), textNode('n3', 'C'), textNode('n4', 'D'), textNode('n5', 'E')]);
    act(() => { store().deleteCanvasElements(['n1', 'n2', 'n3', 'n4'], []); }); await settle();
    await undo();
    for (const id of ['n1', 'n2', 'n3', 'n4']) await answer(id);
    expect(store().undoNotice?.text).toBe(bringBack('4 nodes'));
  });

  it('a restore with no answer in 15 s says the same line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    net.restore = 'hold';
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { store().undo(); });
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => { resolve({ status: 200, body: { status: 'deleted', id: 'n2' } }); await vi.advanceTimersByTimeAsync(50); });
    expect(net.heldRestores).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    expect(lines()).toContain(bringBack('“Brief”'));
    expect(lines().join(' ')).not.toMatch(/isn't answering/);
  });

  it('no Delete answer in 15 s: the line, read live; a late answer never restores; the next press does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    // Still waiting, silently.
    expect(lines()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(lines()).toContain(bringBack('“Brief”'));
    expect(lines()).not.toContain(DROPPED);
    expect(ids()).toEqual(['n1']);
    // The late Delete answer: no restore by itself.
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => { resolve({ status: 200, body: { status: 'deleted', id: 'n2' } }); await vi.advanceTimersByTimeAsync(50); });
    expect(ids()).toEqual(['n1']);
    expect(restores()).toHaveLength(0);
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    // The next press restores it.
    net.holdDeletes = false;
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().edges.map((edge) => edge.id)).toEqual(['e-n1-n2']);
    expect(restores()).toHaveLength(1);
    expect(store().undoNotice?.text).toBe('Restored the node.');
  });

  it('a scene with no Delete answer in 15 s: the line names the scene', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1', 'Prompt'), sceneNode('n2', 'Ref scene')]);
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    expect(lines()).toContain(bringBack('“Ref scene”'));
  });
});
