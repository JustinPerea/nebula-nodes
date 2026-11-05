/**
 * PR #204 round 7, review 5 MEDIUM-1: a wire the gate refused only because this tab isn't
 * connected as the person says so, and its line clears on the promote (it goes through notify
 * with the refusal and its own stamp). The reviewer's probe, kept as tests; harness from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';


vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
type Answer = { status: number; detail?: string; body?: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  /** Paths whose answers wait until the test releases them. */
  held: new Set<string>(),
  waiting: [] as Array<{ path: string; release: (answer?: { status: number; detail?: string; body?: unknown }) => void }>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    net.calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // As the real apiFetch does: each answer carries the promote count its request went out under.
    const session = await import('../src/lib/personSession');
    const sentAt = session.personPromotions();
    const respond = (answer: Answer = { status: 200 }) => {
      const response = new Response(JSON.stringify(answer.body ?? (answer.detail ? { detail: answer.detail } : {})),
        { status: answer.status, headers: { 'Content-Type': 'application/json' } });
      session.noteSentUnder(response, sentAt);
      return response;
    };
    if (!net.held.has(path)) return Promise.resolve(respond());
    return new Promise<Response>((resolve, reject) => {
      // Status 0: the request got no answer (the network dropped it).
      net.waiting.push({ path, release: (answer) => (answer?.status === 0
        ? reject(new TypeError('Failed to fetch')) : resolve(respond(answer))) });
    });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';


function textNode(id: string, x = 0): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'fog' }, state: 'idle', outputs: {} },
  };
}
function previewNode(id: string, x = 400): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 },
    data: { label: 'Preview', definitionId: 'preview', params: {}, state: 'idle', outputs: {} },
  };
}
function wire(source: string, target: string, id: string): Edge {
  return { id, source, sourceHandle: 'text', target, targetHandle: 'input', type: 'typed-edge' };
}
const connection = (source: string, target: string) => ({ source, sourceHandle: 'text', target, targetHandle: 'input' });

function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = {
    type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra,
  } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const links = () => useGraphStore.getState().edges.map((edge) => `${edge.source}->${edge.target}`);
async function release(path: string, answer?: Answer) {
  await flush();
  const index = net.waiting.findIndex((item) => item.path === path);
  expect(index, `a ${path} request is waiting`).toBeGreaterThanOrEqual(0);
  const [item] = net.waiting.splice(index, 1);
  item.release(answer);
  await flush();
  await flush();
}

const nodes = () => [textNode('n1'), previewNode('n2')];

beforeEach(() => {
  net.calls.length = 0;
  net.held.clear();
  net.waiting.length = 0;
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], undoNotice: null,
    isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
  // Every test starts from a canvas the backend drew: n1 and n2, no wires.
  sync(nodes(), [], { graphReplaced: true });
});


import * as session from '../src/lib/personSession';
import { PERSON_REQUIRED_COPY } from '../src/lib/errorCopy';

const shown = () => { const s = useGraphStore.getState(); return s.undoNotice?.text ?? s.messageNotice?.text ?? null; };
const GATE = { status: 403, body: { detail: 'Only the person can wire nodes.', code: 'person_required' } };

describe('review 5 MEDIUM-1: a wire the gate refused', () => {
  beforeEach(() => { session.resetPersonSessionForTests(); session.reportPersonRequired(); });

  it('a connection: its line says why, and clears on the promote', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect', GATE);
    expect(shown()).toMatch(/connected as you/);
    expect(links()).toEqual([]);
    session.notePersonPromoted();
    await flush();
    expect(shown()).toBeNull();
  });

  it('a removal (DELETE /api/graph/edge): its line says why, and clears on the promote', async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')]);
    net.held.add('/api/graph/edge');
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'e1' }]);
    await release('/api/graph/edge', GATE);
    expect(shown()).toMatch(/connected as you/);
    expect(links()).toEqual(['n1->n2']);
    session.notePersonPromoted();
    await flush();
    expect(shown()).toBeNull();
  });

  it('refused before the promote and answered after it: its own stamp says it is old, so the line goes at once', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await flush();
    session.notePersonPromoted();
    await release('/api/graph/connect', GATE);
    expect(shown()).toBeNull();
  });

  it('review 5 LOW-4, the text path: an answer with no code whose words say it (an older backend) clears on the promote too', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect', { status: 403, detail: PERSON_REQUIRED_COPY });
    expect(shown()).toContain(PERSON_REQUIRED_COPY);
    session.notePersonPromoted();
    await flush();
    expect(shown()).toBeNull();
  });

  it('an add (POST /api/graph/node) refused before the promote and answered after it: its line goes at once', async () => {
    net.held.add('/api/graph/node');
    const adding = useGraphStore.getState().addNode('text-input', { x: 40, y: 40 });
    await flush();
    session.notePersonPromoted();
    await release('/api/graph/node', { status: 403, body: { detail: 'Only the person can add nodes.', code: 'person_required' } });
    await adding;
    expect(shown()).toBeNull();
  });

  it('an add refused under the current state: the line stays until the promote', async () => {
    net.held.add('/api/graph/node');
    const adding = useGraphStore.getState().addNode('text-input', { x: 40, y: 40 });
    await release('/api/graph/node', { status: 403, body: { detail: 'Only the person can add nodes.', code: 'person_required' } });
    await adding;
    expect(shown()).toMatch(/connected as you/);
    session.notePersonPromoted();
    await flush();
    expect(shown()).toBeNull();
  });

  it('a refusal for another reason keeps its line through the promote', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect', { status: 409, detail: 'That input already has a connection.' });
    expect(shown()).toMatch(/already has a connection/);
    session.notePersonPromoted();
    await flush();
    expect(shown()).toMatch(/already has a connection/);
  });
});
