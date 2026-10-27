import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// Review 17, round 18. Every case runs against a fake Nebula that applies
// each request, and checks what reached it and that the canvas ends where
// Nebula's graph does. Turned from the reviewer's probes (r17/fe/w17,
// propforeign seed 104) into failing tests first.
// H-1: a write is admitted when the person acts: the project and the graph
//   it was made in are read then. A write that waited behind an undo's
//   restore isn't sent when either changed meanwhile, and one that is sent
//   carries the revision read at admission. The same for a queued restore.
// M-1: a step that can't be popped (a failed add under a newer step) adds
//   nothing, so it is dead and no undo takes off what someone else added.
// M-2: a node held while an undo's restore is on its way keeps the newest
//   copy Nebula synced, and takes it when the hold ends.
// L-1: the first sync after a param PUT's answer ends the wait for its echo,
//   whatever form Nebula saved the value in.
// L-2: a restore that never answers fails at the hold limit; a waiting undo
//   never blocks a project switch.
// W5: a refused undo always says so, and the canvas ends where Nebula is.
// GM r18 (2): a deleted node leaves the canvas at once (option (c)).

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  sent: [] as Array<{ method: string; path: string; project: unknown; context: unknown }>,
  ctxNow: (() => null) as () => unknown,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit, options?: { project?: unknown }) => {
    fake.sent.push({ method: init?.method ?? 'GET', path, project: options && 'project' in options ? options.project : 'unset', context: fake.ctxNow() });
    return fake.override ? fake.override(path, init) : fake.backend.apiFetch(path, init);
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { DROPPED_UNDO_TEXT } from '../src/lib/deleteNotice';
import { CONNECTION_LOST_COPY } from '../src/lib/errorCopy';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const CLI = /^n\d+$/;
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const cliIds = () => ids().filter((id) => CLI.test(id));
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const wires = () => store().edges.map((edge) => `${edge.source}>${edge.target}`).sort();
const notice = () => store().undoNotice?.text ?? null;
const lines = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); };
const writes = () => nebula().calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) expect(valueOf(id)).toEqual(nebula().valueOf(id));
  expect(wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)))).toEqual(nebula().wires());
};
const type = (id: string, value: string) => { store().updateNodeData(id, { params: { ...nodeOf(id)!.data.params, value } }); };
const del = async (id: string) => { store().onNodesChange([{ id, type: 'remove' }]); await settle(); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const codex = { actor: { kind: 'agent', name: 'Codex', id: 'codex' } };
/** Nebula changes its graph for an agent and syncs it (the agent's edit). */
const agentEdit = (change: () => void, id = 'ed_ag') => {
  nebula().request += 1;
  change();
  emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
    empty: nebula().nodes.size === 0, edit: { ...codex, id } });
};
const wire = (source: string, target: string) => ({ id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text' });
const canvasWire = (source: string, target: string): Edge => ({ ...wire(source, target), type: 'typed-edge' });
/** A failing answer for one request, on its way like any other. */
const refuse = (match: (path: string, init?: RequestInit) => boolean, status: number, detail: string, times = 1) => {
  let left = times;
  fake.override = (path, init) => {
    if (left > 0 && match(path, init)) {
      left -= 1;
      nebula().calls.push({ path, method: init?.method ?? 'GET' });
      return nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail }), { status }));
    }
    return nebula().apiFetch(path, init);
  };
};

let clock = Date.now();

describe('round 18 (review 17)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.sent = [];
    fake.ctxNow = getProjectContext;
    fake.override = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer());
    await settle();
    await tick(20_000);
    setProjectContext(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const start = (nodes: FakeNode[], edges: Edge[] = [], selected: string[] = []) => {
    nebula().reset(nodes, edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle ?? '',
      target: edge.target, targetHandle: edge.targetHandle ?? '' })));
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, selected.includes(node.id) ? { selected: true } : {})),
      edges, isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };

  describe('H-1: a write waiting behind an undo goes only to the graph it was made in', () => {
    it('W1: an agent switches project while the writes wait: none is sent', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo(); // its restore goes out; the answer is slow
      type('n2', 'B'); // its PUT waits behind the restore
      await tick(1100);
      await del('n3'); // and so does this delete
      const before = writes().length;
      setProjectContext(null); // followProjectSwitch lets the old project go at once
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      // Nothing after the restore reached Nebula (in the app, the new project).
      expect(writes().slice(before)).toEqual([]);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      expect(writes()).not.toContain('DELETE /api/graph/node/n3');
      expect(fake.sent.filter((call) => call.method !== 'GET' && call.context === null)).toEqual([]);
    });

    it('W1: a write sent after its wait carries the revision read when the person acted', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      const put = fake.sent.find((call) => call.method === 'PUT' && call.path === '/api/graph/node/n2');
      expect(put?.project).toEqual({ id: 'p1', revision: 'r1' });
      expect(nebula().valueOf('n2')).toBe('B');
    });

    it('W1 control: with no undo waiting, the writes go out with the project', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'B');
      await tick(1100);
      await del('n2');
      expect(writes()).toEqual(['PUT /api/graph/node/n2', 'DELETE /api/graph/node/n2']);
      expect(fake.sent.filter((call) => call.method !== 'GET').map((call) => call.context))
        .toEqual([{ id: 'p1', revision: 'r1' }, { id: 'p1', revision: 'r1' }]);
    });

    it('W2: an agent imports a graph while a delete waits: the delete never reaches the imported node', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      await del('n2');
      nebula().nodes = new Map([['n1', textFakeNode('n1', 'imported-1')], ['n2', textFakeNode('n2', 'imported-2')]]);
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false,
        graphReplaced: true, edit: { ...codex, id: 'ed_imp' } });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes()).not.toContain('DELETE /api/graph/node/n2');
      expect(nebula().ids()).toEqual(['n1', 'n2']);
      expect(valueOf('n2')).toBe('imported-2');
      sameAsNebula();
    });

    it('a queued restore checks too: an undo waiting behind another is never sent to the next project', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo(); // n2's restore goes out, slow
      await undo(); // n1's waits behind it
      setProjectContext({ id: 'p2', revision: 'r9' });
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      const restores = fake.sent.filter((call) => call.path === '/api/graph/restore');
      expect(restores).toHaveLength(1);
      expect(restores[0].project).toEqual({ id: 'p1', revision: 'r1' });
      expect(nebula().valueOf('n1')).toBe('A');
    });

    it('a queued restore after an import is never sent to the imported graph', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      await undo();
      nebula().nodes = new Map([['n1', textFakeNode('n1', 'imported-1')]]);
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false,
        graphReplaced: true, edit: { ...codex, id: 'ed_imp' } });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes().filter((call) => call === 'POST /api/graph/restore')).toHaveLength(1);
      expect(nebula().valueOf('n1')).toBe('imported-1');
      sameAsNebula();
    });
  });

  describe('M-1: an add that failed under a newer step takes nothing off', () => {
    const failAdds = () => refuse((path, init) => path === '/api/graph/node' && init?.method === 'POST', 500, 'Nope.');

    it('Z1: the failed add\'s Cmd+Z never takes off a node a reconnect brought', async () => {
      start([textFakeNode('n1')]);
      nebula().holdAnswers = true;
      failAdds();
      const adding = store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      type('n1', 'A');
      await tick(1100);
      // A reconnect's sync (no edit origin) brings a node made elsewhere.
      nebula().nodes.set('n7', textFakeNode('n7', 'other'));
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await adding.catch(() => null);
      await settle(); await tick(6000);
      await undo(); // the typing
      expect(valueOf('n1')).toBe('n1');
      await undo(); // the failed add's step is dead: nothing to take off
      await undo();
      expect(ids()).toEqual(['n1', 'n7']);
      expect(writes().filter((call) => call === 'POST /api/graph/restore')).toHaveLength(1);
      sameAsNebula();
    });

    it('Z2: the same with nothing arriving: the typing is undone and nothing else', async () => {
      start([textFakeNode('n1')]);
      nebula().holdAnswers = true;
      failAdds();
      const adding = store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await adding.catch(() => null);
      await settle(); await tick(6000);
      await undo();
      expect(valueOf('n1')).toBe('n1');
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });
  });

  describe('M-2: a node held during a waiting undo takes the newest copy Nebula synced', () => {
    it('W3: an agent edits a node a waiting undo put back: the canvas shows it, and the next PUT keeps it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }, textFakeNode('n2')]);
      await del('n1');
      nebula().holdAnswers = true;
      await undo(); // n1 back; Nebula has it, the answer is slow
      agentEdit(() => { nebula().nodes.get('n1')!.params.value = 'AGENT'; });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(valueOf('n1')).toBe('AGENT');
      // Its own step: Cmd+Z puts the agent's change back.
      const top = store().undoStack.at(-1) as { kind?: string } | undefined;
      expect(top?.kind).toBe('foreign');
      store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, note: 'y' } });
      await tick(1100); await settle();
      expect(nebula().valueOf('n1')).toBe('AGENT');
      sameAsNebula();
    });

    it('a run\'s outputs synced while the node was held are never dropped', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      await del('n1');
      nebula().holdAnswers = true;
      await undo();
      // A run's result sync (no edit origin) with n1's outputs.
      const nodes = FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }).map((node) => node.id === 'n1'
        ? { ...node, data: { ...node.data, state: 'complete', outputs: { text: { type: 'Text', value: 'result' } } } } : node);
      emit({ nodes, edges: [], empty: false });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(nodeOf('n1')?.data.outputs).toEqual({ text: { type: 'Text', value: 'result' } });
      sameAsNebula();
    });

    it('control (P-11): an echo from before the waiting undo still leaves the undo\'s value', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      await del('n2');
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      await undo(); // n2 back
      await undo(); // n1 back to n1, waiting
      nebula().releaseAnswer();
      await settle();
      nebula().deliverEcho(); // Nebula still had n1=A
      await settle();
      expect(valueOf('n1')).toBe('n1');
      nebula().holdEchoes = false;
      nebula().holdAnswers = false;
      nebula().deliverEchoes();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(valueOf('n1')).toBe('n1');
      sameAsNebula();
    });
  });

  describe('L-1: the first sync after the PUT\'s answer ends the wait for its echo', () => {
    it('L3x: Nebula saves its own form of the value; an agent\'s edit right after shows, and the next PUT keeps it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }]);
      fake.override = (path, init) => {
        if (path === '/api/graph/node/n1' && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { params: Record<string, unknown> };
          body.params = { ...body.params, value: String(body.params.value).trim() };
          return nebula().apiFetch(path, { ...init, body: JSON.stringify(body) });
        }
        return nebula().apiFetch(path, init);
      };
      type('n1', ' A ');
      await tick(1100); await settle();
      agentEdit(() => { nebula().nodes.get('n1')!.params.value = 'AGENT'; });
      await settle();
      expect(valueOf('n1')).toBe('AGENT');
      store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, note: 'y' } });
      await tick(1100); await settle();
      expect(nebula().valueOf('n1')).toBe('AGENT');
      sameAsNebula();
    });
  });

  describe('L-2: a restore that never answers', () => {
    it('W4: fails at the hold limit with the undo failure line, then the waiting typing goes out', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      nebula().holdAnswers = false; // later writes answer at once
      type('n2', 'B');
      await tick(1100);
      // A waiting undo never blocks a project switch under a run's reason.
      expect(store().canSwitchProject()).toBe(true);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      await tick(15_000); await settle();
      expect(lines()).toContain(`Couldn't undo that. ${CONNECTION_LOST_COPY}`);
      expect(writes()).toContain('PUT /api/graph/node/n2');
      expect(nebula().valueOf('n2')).toBe('B');
      // Nebula took the undo after all (its echo showed it): the canvas shows Nebula's.
      sameAsNebula();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      sameAsNebula();
    });
  });

  describe('W5: a refused undo always says so, and the canvas ends where Nebula is', () => {
    it('a newer step landed first: the line shows, and the node the undo put back goes again', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      await del('n2');
      nebula().holdAnswers = true;
      refuse((path) => path === '/api/graph/restore', 409, 'This canvas is out of date.');
      await undo(); // n2 back on the canvas; Nebula will refuse it
      type('n2', 'B'); // a newer step, its PUT waiting behind the restore
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(lines().some((line) => String(line).startsWith("Couldn't undo that."))).toBe(true);
      expect(ids()).toEqual(['n1']);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      sameAsNebula();
      // The delete is undoable again.
      await undo();
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsNebula();
    });
  });

  describe('GM r18 (2), option (c): a deleted node leaves the canvas the moment Delete is pressed', () => {
    it('the node and its wires go at once, before any echo or answer', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [canvasWire('n1', 'n2')]);
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      await del('n2');
      expect(ids()).toEqual(['n1']);
      expect(wires()).toEqual([]);
    });

    it('a sync that still shows it while its delete is on its way leaves it off', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [canvasWire('n1', 'n2')]);
      nebula().holdAnswers = true;
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 500, 'Nope.');
      await del('n2');
      // An agent's edit made before the delete reached Nebula.
      agentEdit(() => { nebula().nodes.get('n1')!.params.value = 'AGENT'; });
      await settle();
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('AGENT');
    });

    it('Cmd+Z while the delete is on its way says nothing was undone; once it lands, one Cmd+Z brings it back with its wire', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [canvasWire('n1', 'n2')]);
      nebula().holdAnswers = true;
      await del('n2');
      await undo();
      expect(lines()).toContain(DROPPED_UNDO_TEXT);
      expect(ids()).toEqual(['n1']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(16_000);
      // The dropped press is never applied late.
      expect(ids()).toEqual(['n1']);
      expect(writes().filter((call) => call === 'POST /api/graph/restore')).toHaveLength(0);
      await undo();
      expect(ids()).toEqual(['n1', 'n2']);
      expect(wires()).toEqual(['n1>n2']);
      expect(notice()).toBe('Restored the node.');
      expect(writes().filter((call) => call === 'POST /api/graph/restore')).toHaveLength(1);
      sameAsNebula();
    });

    it('a failed delete puts the node back where it was, with its wires and the failure line, not selected', async () => {
      start([textFakeNode('n1'), { ...textFakeNode('n2'), position: { x: 420, y: 260 } }], [canvasWire('n1', 'n2')], ['n2']);
      nebula().holdAnswers = true;
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 500, 'Nope.');
      await del('n2');
      expect(ids()).toEqual(['n1']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await settle();
      expect(ids()).toEqual(['n1', 'n2']);
      expect(nodeOf('n2')?.position).toEqual({ x: 420, y: 260 });
      expect(nodeOf('n2')?.selected).toBeFalsy();
      expect(wires()).toEqual(['n1>n2']);
      expect(lines().some((line) => String(line).startsWith("Couldn't delete the node."))).toBe(true);
      // No step is left for a delete that didn't happen.
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('a failed delete under a newer step: the node comes back and stays when that step is undone', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [canvasWire('n1', 'n2')]);
      nebula().holdAnswers = true;
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 500, 'Nope.');
      await del('n2');
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(ids()).toEqual(['n1', 'n2']);
      await undo(); // the typing
      expect(valueOf('n1')).toBe('n1');
      expect(ids()).toEqual(['n1', 'n2']);
      expect(wires()).toEqual(['n1>n2']);
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('typing not yet sent is dropped when the delete lands', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'B'); // within the debounce: no PUT yet
      await del('n2');
      await tick(6000);
      expect(writes()).toEqual(['DELETE /api/graph/node/n2']);
      sameAsNebula();
      await undo();
      expect(valueOf('n2')).toBe('B');
      sameAsNebula();
    });

    it('typing not yet sent goes out when the delete fails, so Nebula has what the card shows', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 500, 'Nope.');
      type('n2', 'B');
      await del('n2');
      await tick(6000);
      expect(ids()).toEqual(['n1', 'n2']);
      expect(valueOf('n2')).toBe('B');
      sameAsNebula();
    });

    it('an agent\'s delete drops the person\'s writes still waiting for it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B'); // waits behind the restore
      await tick(1100);
      agentEdit(() => { nebula().nodes.delete('n2'); }, 'ed_del');
      await settle();
      expect(ids()).toEqual(['n1']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      sameAsNebula();
    });

    it('a delete of two where one fails: the other stays deleted, and one Cmd+Z brings it back', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      refuse((path, init) => path === '/api/graph/node/n3' && init?.method === 'DELETE', 500, 'Nope.');
      store().onNodesChange([{ id: 'n2', type: 'remove' }, { id: 'n3', type: 'remove' }]);
      await settle();
      await tick(1000);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsNebula();
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsNebula();
    });
  });
});
