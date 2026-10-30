import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// Review 18, round 19. Turned from the reviewer's probes (r18/fe: h1, m2,
// w5, sw) into failing tests first, against the fake Nebula of round 17.
// H-A: a Clear is a canvas replacement: a write or restore held from before
//   it never reaches the new nodes that reuse its ids (C1-C3), and every
//   write carries the canvas revision read when the person acted.
// G-1 (GM, round 19): a switch or an import waits for the saves on their way
//   (15 s at most), and one that didn't land is said in GM's line on the new
//   canvas, never the out-of-date line.
// M-A: typing that waited behind an undo reaches Nebula when its node's
//   Delete then fails (D1).
// M-B: a failed delete puts back the wires Nebula has (refusal seed 264).
// M-C, L-C: a param write carries only the keys the person changed (M2a,
//   M2b, W5b).
// L-B: a restore that timed out but landed late counts as undone (T1).

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
import { savingCutOffLine } from '../src/lib/savingCutOff';
import { STALE_CANVAS_DETAIL } from '../src/lib/projectContext';

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


const TIMEOUT_LINE = "Nothing was undone. Nebula isn't answering. Make sure it's running, then try again.";
const project = (name = 'Glass campaign') => { store().setCanvasProjectName?.(() => name); };

describe('round 19 (review 18)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.sent = [];
    fake.ctxNow = getProjectContext;
    fake.override = null;
    project();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer());
    await settle();
    await tick(20_000);
    store().finishCanvasReplacement?.(null);
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
  /** An agent clears the canvas (DELETE /api/graph: ids start again at n1). */
  const agentClear = (canvas?: string) => {
    nebula().request += 1;
    nebula().nodes.clear(); nebula().edges = []; nebula().next = 1;
    emit({ nodes: [], edges: [], empty: true, edit: { ...codex, id: 'ed_clear' }, ...(canvas ? { canvasRevision: canvas } : {}) });
  };
  const agentAdd = (id: string, value: string, canvas?: string) => {
    nebula().request += 1;
    nebula().nodes.set(id, textFakeNode(id, value)); nebula().next = Number(id.slice(1)) + 1;
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
      empty: false, edit: { ...codex, id: `ed_add_${id}` }, ...(canvas ? { canvasRevision: canvas } : {}) });
  };
  const stale = () => lines().filter((line) => String(line).includes(STALE_CANVAS_DETAIL));
  /** The person's switch: the drain, then the new project's canvas. */
  const switchProject = async (cutOff: Awaited<ReturnType<ReturnType<typeof store>['drainGraphWrites']>>) => {
    setProjectContext({ id: 'p2', revision: 'r2' });
    expect(store().loadProjectGraph([], [], [])).toBe(true);
    store().finishCanvasReplacement({ kind: 'switch', project: 'Glass campaign', cutOff, show: true });
    await settle();
  };

  describe('H-A: a Clear is a canvas replacement', () => {
    it('C1: a PUT held behind a slow undo never reaches the n2 an agent made after clearing', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      agentClear(); await settle();
      agentAdd('n1', 'AG1'); await settle();
      agentAdd('n2', 'AG2'); await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      expect(nebula().valueOf('n2')).toBe('AG2');
      expect(valueOf('n2')).toBe('AG2');
      expect(stale()).toEqual([]);
    });

    it('C2: an undo queued behind a slow one never overwrites the n1 an agent made after clearing', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      await undo();
      nebula().holdAnswers = false;
      agentClear(); await settle();
      agentAdd('n1', 'AG1'); await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(nebula().valueOf('n1')).toBe('AG1');
      expect(nebula().ids()).toEqual(['n1']);
      expect(cliIds()).toEqual(['n1']);
    });

    it('C3: the person clears while a PUT waits, then adds a node that becomes n1: the PUT never reaches it', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n1', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      const step = store().beginUndoStep({ clear: true });
      fake.override = (path, init) => {
        if (path.startsWith('/api/graph?force') && init?.method === 'DELETE') {
          nebula().calls.push({ path, method: 'DELETE' });
          nebula().request += 1;
          nebula().nodes.clear(); nebula().edges = []; nebula().next = 1;
          nebula().broadcast();
          return Promise.resolve(new Response('{"status":"cleared"}', { status: 200 }));
        }
        return nebula().apiFetch(path, init);
      };
      const { apiFetch } = await import('../src/lib/backend');
      await apiFetch('/api/graph?force=true', { method: 'DELETE' });
      store().clearGraph({ undoStep: step });
      store().endUndoStep(step);
      await settle();
      await store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes().filter((w) => w === 'PUT /api/graph/node/n1')).toEqual([]);
      expect(stale()).toEqual([]);
    });

    it("C3 from chat: the chat's /clear is a replacement too, so the PUT never reaches the next n1", async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n1', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      fake.override = (path, init) => {
        if (path.startsWith('/api/graph?force') && init?.method === 'DELETE') {
          nebula().calls.push({ path, method: 'DELETE' });
          nebula().request += 1;
          nebula().nodes.clear(); nebula().edges = []; nebula().next = 1;
          return Promise.resolve(new Response('{"status":"cleared","canvasRevision":"5"}', { status: 200 }));
        }
        return nebula().apiFetch(path, init);
      };
      const { clearCanvasFromChat } = await import('../src/lib/chatCanvasClear');
      expect(await clearCanvasFromChat()).toBe('cleared');
      expect(getProjectContext()?.canvas).toBe('5');
      await settle();
      await store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes().filter((w) => w === 'PUT /api/graph/node/n1')).toEqual([]);
    });

    it('a sync whose canvas revision moved (an import) drops the writes held from before it', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      // An agent replaced the graph: same ids, new canvas revision, not empty.
      agentAdd('n2', 'AG2', '1'); await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      expect(getProjectContext()?.canvas).toBe('1');
    });

    it('a sync names the canvas revision the tab sends, and a held write carries the one read when the person acted', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false,
        canvasRevision: '4' });
      expect(getProjectContext()).toEqual({ id: 'p1', revision: 'r1', canvas: '4' });
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(2000);
      const put = fake.sent.filter((call) => call.method === 'PUT' && call.path === '/api/graph/node/n2');
      expect(put.map((call) => call.project)).toEqual([{ id: 'p1', revision: 'r1', canvas: '4' }]);
    });

    it('a sync from another workspace revision never changes the canvas revision', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '2' });
      emit({ nodes: [], edges: [], empty: true, canvasRevision: '9', workspaceRevision: 'r9' });
      expect(getProjectContext()?.canvas).toBe('2');
    });
  });

  describe('G-1 (GM, round 19): a switch or an import waits for the saves on their way', () => {
    it('debounced typing goes out at once; once it lands the switch has nothing to say', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1')]);
      type('n1', 'B');
      const cut = await store().drainGraphWrites('switch');
      expect(writes()).toEqual(['PUT /api/graph/node/n1']);
      expect(nebula().valueOf('n1')).toBe('B');
      expect(cut).toEqual([]);
      await switchProject(cut);
      expect(lines()).toEqual([]);
    });

    it('a save refused meanwhile: the new canvas names its setting, node and project in GM\'s words', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([{ ...textFakeNode('n1'), label: 'Hero prompt' }]);
      refuse((path, init) => path === '/api/graph/node/n1' && init?.method === 'PUT', 500, 'Nope.');
      type('n1', 'B');
      const cut = await store().drainGraphWrites('switch');
      await switchProject(cut);
      expect(lines()).toEqual(["Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when you switched."]);
    });

    it('a save that never answers holds the switch for 15 s at most, then is named', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([{ ...textFakeNode('n1'), label: 'Hero prompt' }]);
      nebula().holdAnswers = true;
      type('n1', 'B');
      let cut: Awaited<ReturnType<ReturnType<typeof store>['drainGraphWrites']>> | null = null;
      void store().drainGraphWrites('switch').then((value) => { cut = value; });
      await tick(14_500);
      expect(cut).toBeNull();
      await tick(600);
      expect(cut).not.toBeNull();
      await switchProject(cut!);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(2000);
      expect(lines()).toEqual(["Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when you switched."]);
      expect(stale()).toEqual([]);
    });

    it('typing while it waits is held: sent if the switch doesn\'t happen', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdAnswers = true;
      type('n1', 'A');
      const draining = store().drainGraphWrites('switch');
      await settle();
      type('n2', 'B');
      await tick(1100);
      expect(writes()).toEqual(['PUT /api/graph/node/n1']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await draining;
      store().finishCanvasReplacement(null);
      await settle();
      expect(writes()).toEqual(['PUT /api/graph/node/n1', 'PUT /api/graph/node/n2']);
      expect(nebula().valueOf('n2')).toBe('B');
    });

    it('typing while it waits is never sent to the next project, and the line says a change was lost', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      const draining = store().drainGraphWrites('switch');
      type('n2', 'B');
      await tick(1100);
      const cut = await draining;
      expect(cut).toEqual([]);
      await switchProject(cut);
      await tick(2000);
      expect(writes()).toEqual(['PUT /api/graph/node/n1']);
      expect(fake.sent.filter((call) => call.method !== 'GET').every((call) => call.context === null
        || (call.context as { id: string }).id === 'p1' || call.project !== 'unset')).toBe(true);
      expect(lines()).toEqual(["Couldn’t save “Text” for “n2” in “Glass campaign”. It was still saving when you switched."]);
    });

    it('S1: an undo, a delete and typing all still out: one line, never the out-of-date line', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A'); await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      await del('n2');
      type('n1', 'C'); await tick(1100);
      const draining = store().drainGraphWrites('switch');
      await tick(15_100);
      const cut = await draining;
      await switchProject(cut);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(lines()).toEqual(["Couldn’t save your last change in “Glass campaign”. It was still saving when you switched."]);
    });

    it('an import: the ending says the import replaced the canvas', async () => {
      setProjectContext({ id: 'p1', revision: 'r1' });
      start([{ ...textFakeNode('n1'), label: 'Hero prompt' }]);
      refuse((path, init) => path === '/api/graph/node/n1' && init?.method === 'PUT', 500, 'Nope.');
      type('n1', 'B');
      const cut = await store().drainGraphWrites('import');
      store().loadGraph([], []);
      store().finishCanvasReplacement({ kind: 'import', project: 'Glass campaign', cutOff: cut, show: true });
      await settle();
      expect(lines()).toEqual(["Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when the import replaced the canvas."]);
    });

    it('an agent\'s import while typing waits behind an undo: GM\'s import line, not the out-of-date line', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Hero prompt' }]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = false;
      nebula().request += 1;
      // Nebula loads the agent's graph (its answers on their way stay so).
      nebula().nodes = new Map([['n1', textFakeNode('n1', 'imported')]]);
      nebula().edges = [];
      nebula().next = 2;
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false,
        graphReplaced: true, canvasRevision: '1', edit: { ...codex, id: 'ed_import' } });
      await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      expect(lines()).toContain("Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when the import replaced the canvas.");
      expect(stale()).toEqual([]);
    });

    it('GM\'s lines, word for word', () => {
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', { kind: 'switch' }))
        .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when you switched.");
      expect(savingCutOffLine([], 'Glass campaign', { kind: 'switch' }))
        .toBe("Couldn’t save your last change in “Glass campaign”. It was still saving when you switched.");
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: 'Text' }, { node: 'n2', setting: 'Text' }], 'Glass campaign', { kind: 'switch' }))
        .toBe("Couldn’t save your last change in “Glass campaign”. It was still saving when you switched.");
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: null }], 'Glass campaign', { kind: 'import' }))
        .toBe("Couldn’t save your last change in “Glass campaign”. It was still saving when the import replaced the canvas.");
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', { kind: 'import' }))
        .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when the import replaced the canvas.");
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', { kind: 'agent', agent: 'Claude Code' }))
        .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when Claude Code switched projects.");
      expect(savingCutOffLine([], 'Glass campaign', { kind: 'agent', agent: 'Claude Code' }))
        .toBe("Couldn’t save your last change in “Glass campaign”. It was still saving when Claude Code switched projects.");
      expect(savingCutOffLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', { kind: 'agent', agent: null }))
        .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when an agent switched projects.");
      expect(savingCutOffLine([], 'Glass campaign', { kind: 'agent', agent: null }))
        .toBe("Couldn’t save your last change in “Glass campaign”. It was still saving when an agent switched projects.");
    });
  });

  describe('M-A: typing that waited behind an undo, then Delete, the delete fails', () => {
    it('D1: the typing reaches Nebula, so the node comes back as the card shows it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 409, 'n2 is still running.');
      await del('n2');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).toContain('n2');
      expect(nebula().valueOf('n2')).toBe('B');
      expect(valueOf('n2')).toBe('B');
    });

    it('the typing is dropped when the delete lands', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      type('n2', 'B');
      await tick(1100);
      await del('n2');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).not.toContain('n2');
      sameAsNebula();
    });
  });

  describe('M-B: a failed delete puts back the wires Nebula has', () => {
    it('an agent wires the node while its delete is on its way; the delete fails: the wire is on the canvas', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      nebula().holdAnswers = true;
      refuse((path, init) => path === '/api/graph/node/n3' && init?.method === 'DELETE', 409, 'n3 is still running.');
      await del('n3');
      agentEdit(() => { nebula().edges.push({ id: 'e-n3-n1', source: 'n3', sourceHandle: 'text', target: 'n1', targetHandle: 'text' }); });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
      expect(wires()).toEqual(['n3>n1']);
      sameAsNebula();
    });

    it('a wire an agent took off while the delete was out stays off when the node comes back', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [canvasWire('n1', 'n2')]);
      nebula().holdAnswers = true;
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 409, 'n2 is still running.');
      await del('n2');
      agentEdit(() => { nebula().edges = []; });
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).toEqual(['n1', 'n2']);
      expect(wires()).toEqual([]);
      sameAsNebula();
    });
  });

  describe('M-C, L-C: a param write carries only the keys the person changed', () => {
    it('the PUT body names the changed key alone', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }]);
      type('n1', 'B');
      await tick(1100);
      const put = nebula().calls.find((call) => call.method === 'PUT');
      expect(JSON.parse(put!.body!)).toEqual({ params: { value: 'B' } });
    });

    it('M2a: an agent\'s edit synced while a waiting undo held the node is kept', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }, textFakeNode('n2')]);
      await del('n1'); await tick(1000);
      nebula().holdAnswers = true;
      await undo();
      agentEdit(() => { nebula().nodes.get('n1')!.params.note = 'AG'; });
      await settle();
      type('n1', 'B'); await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(nebula().nodes.get('n1')?.params).toEqual({ value: 'B', note: 'AG' });
      expect(nodeOf('n1')?.data.params).toEqual({ value: 'B', note: 'AG' });
    });

    it('M2b: the same with a param undo holding the node', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }]);
      type('n1', 'A'); await tick(1100);
      nebula().holdAnswers = true;
      await undo();
      agentEdit(() => { nebula().nodes.get('n1')!.params.note = 'AG'; });
      await settle();
      store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, value: 'B' } });
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(nebula().nodes.get('n1')?.params.note).toBe('AG');
      expect(nodeOf('n1')?.data.params.note).toBe('AG');
    });

    it('W5b: a refused undo of typing while the person typed into another field: nothing is undone, here or in Nebula', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'n1', note: 'x' } }]);
      type('n1', 'A'); await tick(1100);
      refuse((path) => path === '/api/graph/restore', 409, 'Nope.');
      nebula().holdAnswers = true;
      await undo();
      store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, note: 'y' } });
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(nebula().nodes.get('n1')?.params).toEqual({ value: 'A', note: 'y' });
      expect(nodeOf('n1')?.data.params).toEqual({ value: 'A', note: 'y' });
      expect(lines()).toContain("Couldn’t undo that. Nope.");
    });
  });

  describe('L-B: a restore that timed out', () => {
    it('says GM\'s line at the limit', async () => {
      start([textFakeNode('n1')]);
      type('n1', 'A'); await tick(1100);
      fake.override = (path, init) => (path === '/api/graph/restore' ? new Promise<Response>(() => {}) : nebula().apiFetch(path, init));
      await undo();
      await tick(16_000); await settle();
      expect(lines()).toEqual([TIMEOUT_LINE]);
      expect(valueOf('n1')).toBe('A');
    });

    it('T1: applied late, the step counts as undone, and the next Cmd+Z is never a silent no-op', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A'); await tick(1100);
      let late: (() => void) | null = null;
      fake.override = (path, init) => {
        if (path === '/api/graph/restore' && !late) {
          nebula().calls.push({ path, method: 'POST', body: String(init?.body) });
          return new Promise<Response>((resolve) => { late = () => { fake.override = null; void nebula().apiFetch(path, init).then(resolve); }; });
        }
        return nebula().apiFetch(path, init);
      };
      await undo();
      await tick(16_000); await settle();
      expect(lines()).toEqual([TIMEOUT_LINE]);
      late!(); await settle(); await tick(1000);
      expect(valueOf('n1')).toBe('n1');
      expect(store().undoStack).toHaveLength(0);
      expect(store().redoStack).toHaveLength(1);
      sameAsNebula();
      store().redo(); await settle(); await tick(1000);
      expect(valueOf('n1')).toBe('A');
      sameAsNebula();
    });
  });
});
