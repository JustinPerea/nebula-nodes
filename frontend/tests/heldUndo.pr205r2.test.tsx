import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// PR #205 round 2: review 1's held-undo findings and GM's r2 item 1.
// LOW-1: a Delete partly refused brings back, and names, only what left.
// NIT-1: a held press handed to the step below its Delete (that Delete
//   changed nothing) is no longer "held on a Delete": its refusal says the
//   undo's own line, not the bring-back line.
// GM r2 item 1: a late refusal after the 15 s give-up replaces the give-up
//   line in place; the Delete's own line stands alone.
// (The r39 header follows.)
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
  /** Answers for the next restores, in order, before `restore` applies. */
  restoreQueue: [] as number[],
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
      const status = net.restoreQueue.length > 0 ? net.restoreQueue.shift()! : net.restore;
      const answer = status === 'hold'
        ? await new Promise<Answer>((resolve) => { net.heldRestores.push(resolve); })
        : status === 200 ? ok : { status, body: { detail: 'Nebula refused it.' } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { forgetHeldHistoryForTests, useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

/** GM r39 item 3 / r40 item 2, verbatim (curly quotes). */
const bringBack = (names: string) => `Nebula couldn’t bring back ${names}. Try Undo again.`;

const initialGraph = useGraphStore.getState();
function textNode(id: string, label: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
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


/** Nebula's graph as a sync with no edit of anyone's carries it (no step of its own). */
const plainSync = (nodes: Node<NodeData>[], edges: Edge[] = []) => {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges, empty: nodes.length === 0 } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event); });
};

describe('PR #205 round 2: held undo on a Delete', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    net.restore = 200;
    net.restoreQueue.length = 0;
    net.heldRestores.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const [id, resolve] of [...net.held]) {
      net.held.delete(id);
      await act(async () => { resolve({ status: 200, body: { status: 'deleted', id } }); });
    }
    for (const resolve of net.heldRestores.splice(0)) await act(async () => { resolve({ status: 200, body: {} }); });
    await settle();
    forgetHeldHistoryForTests();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const setGraph = (nodes: Node<NodeData>[], edges: Edge[] = []) => useGraphStore.setState({ nodes, edges, isExecuting: false,
    undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [] } as never);

  describe('LOW-1: a Delete partly refused names only what it brings back', () => {
    it('a refused restore after one of two Deletes was refused: the line names the one that left, not the one still on the canvas', async () => {
      net.restore = 409;
      setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief'), textNode('n3', 'Note')]);
      act(() => { store().deleteCanvasElements(['n2', 'n3'], []); }); await settle();
      await undo();
      await answer('n2', 409);
      await answer('n3');
      // Brief came back with the Delete's answers and stayed; the held press
      // restored the rest, and Nebula refused that restore.
      expect(restores()).toHaveLength(1);
      expect(lines()).toContain(bringBack('“Note”'));
      expect(lines().join(' ')).not.toMatch(/“Brief”/);
      expect(ids()).toEqual(['n1', 'n2']);
    });

    it('the restore brings back only what left: Brief, never sent off, is not in it', async () => {
      setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief'), textNode('n3', 'Note')]);
      act(() => { store().deleteCanvasElements(['n2', 'n3'], []); }); await settle();
      await undo();
      await answer('n2', 409);
      await answer('n3');
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      expect(store().undoNotice?.text).toBe('Restored the node.');
    });
  });

  describe('NIT-1: a press handed on from its Delete is no longer held on a Delete', () => {
    it('its Delete changed nothing in the end, so the press goes to the edit below; that edit\'s refused restore says the undo\'s own line', async () => {
      setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief'), textNode('n3', 'Note')]);
      act(() => { store().updateNodeData('n1', { params: { value: 'Edited' } }); });
      act(() => { store().deleteNode('n2'); }); await settle();
      act(() => { store().deleteNode('n3'); }); await settle();
      await undo(); // bound to n3's Delete
      await undo(); // bound to n2's Delete
      await answer('n2');
      // Nebula's graph has "Brief" again, as it was, before the second answer
      // (a sync with no step of its own): the n2 Delete's step now changes nothing.
      plainSync([textNode('n1', 'Prompt'), textNode('n2', 'Brief')].map((node, i) => i === 0
        ? { ...node, data: { ...node.data, params: { value: 'Edited' } } } : node));
      await settle();
      expect(ids()).toEqual(['n1', 'n2']);
      net.restoreQueue.push(200, 409);
      await answer('n3');
      // The first press restored n3; the second went to the edit, and its refusal is that undo's.
      expect(restores()).toHaveLength(2);
      expect(lines().join(' ')).not.toMatch(/bring back/);
      expect(lines().join(' ')).toMatch(/Couldn.t undo/);
    });
  });

  describe('GM r2 item 1: a late refusal after the give-up replaces the give-up line', () => {
    const giveUp = async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
      act(() => { store().deleteNode('n2'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      act(() => { store().undo(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
      expect(lines()).toEqual([bringBack('“Brief”')]);
      return store().undoNotice!.id;
    };
    const late = async (status: number) => {
      const resolve = net.held.get('n2')!;
      net.held.delete('n2');
      await act(async () => {
        resolve(status === 200 ? { status, body: { status: 'deleted', id: 'n2' } } : { status, body: { detail: 'It is running.' } });
        await vi.advanceTimersByTimeAsync(50);
      });
    };

    it('the node comes back with the Delete\'s own line, alone, in the give-up line\'s place; "Try Undo again" goes', async () => {
      const id = await giveUp();
      await late(409);
      expect(ids()).toEqual(['n1', 'n2']);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/^Couldn.t delete/);
      expect(lines().join(' ')).not.toMatch(/Try Undo again|bring back/);
      // The same notice, in place: the line changed, not the toast.
      expect(store().undoNotice?.id).toBe(id);
      expect(restores()).toHaveLength(0);
    });

    it('beside an error line, the give-up line is the message; the late refusal takes that place and the error stays', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setGraph([textNode('n1', 'Prompt'), textNode('n2', 'Brief')]);
      act(() => { store().deleteNode('n2'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      act(() => { store().undo(); });
      act(() => { useGraphStore.setState({ undoNotice: { id: 9_001, text: 'Something else failed.', offer: null, tone: 'error' } } as never); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
      expect(store().messageNotice?.text).toBe(bringBack('“Brief”'));
      const id = store().messageNotice!.id;
      await late(409);
      expect(lines().join(' ')).not.toMatch(/Try Undo again/);
      expect(lines().some((line) => /^Couldn.t delete/.test(line))).toBe(true);
      // In the give-up line's place, and the error line where it was.
      expect(store().messageNotice?.id).toBe(id);
      expect(store().messageNotice?.text).toMatch(/^Couldn.t delete/);
      expect(store().undoNotice?.text).toBe('Something else failed.');
    });

    it('a late ok: "Deleted the node." with its Undo, true as the give-up line was; nothing restored', async () => {
      await giveUp();
      await late(200);
      expect(lines()).toEqual(['Deleted the node.']);
      expect(store().undoNotice?.offer).toBeTruthy();
      expect(ids()).toEqual(['n1']);
      expect(restores()).toHaveLength(0);
    });
  });
});
