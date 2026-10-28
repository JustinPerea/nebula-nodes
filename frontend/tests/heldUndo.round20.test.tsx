import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// Review 19, round 20. The reviewer's probes (r19/fe r19new: CLR1, CLR2,
// RST, SEL, DR) turned into failing tests first, against the fake Nebula of
// round 17, with GM's lines (gm-item3-r20.md and its follow-up).
// L2 (GM 3, follow-up 4): an agent's clear that dropped the person's editing
//   says so; the person's own clear and a backend restart never do.
// M2: a sync after a backend restart (the same canvas, its revision kept, or
//   one moved by a restart that lost it) is not a clear.
// L1 (GM B): a refused delete brings the node back unselected.
// L4: two drains at once: a save that landed is never named as cut off.
// GM 1: a failed delete with no answer names the nodes.
// M3: a delete from before a clear never touches the new canvas.

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
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { STALE_CANVAS_DETAIL } from '../src/lib/projectContext';
import { useUIStore } from '../src/store/uiStore';
import { cleanup, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { ConnectionLostError } from '../src/lib/errorCopy';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const lines = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const writes = () => nebula().calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
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


const NO_ANSWER = "Nebula isn't answering. Make sure it's running, then try again.";
const project = (name = 'Glass campaign') => { store().setCanvasProjectName?.(() => name); };

describe('round 20 (review 19)', () => {
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
    useUIStore.setState({ selectedNodeId: null });
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
  /** An agent clears the canvas (DELETE /api/graph): ids start again at n1. */
  const agentClear = (canvas = '1', actor: Record<string, unknown> = codex.actor) => {
    nebula().request += 1;
    nebula().nodes.clear(); nebula().edges = []; nebula().next = 1;
    emit({ nodes: [], edges: [], empty: true, workspaceRevision: 'r1', edit: { actor, id: 'ed_clear' }, canvasRevision: canvas });
  };
  const sync = (canvas: string, extra: Record<string, unknown> = {}) => emit({
    nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
    empty: nebula().nodes.size === 0, workspaceRevision: 'r1', canvasRevision: canvas, ...extra });

  describe("L2: an agent's clear says what it dropped (GM 3, follow-up 4)", () => {
    it('CLR1: typing still in its debounce: never sent, and named', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'Typed');
      await tick(200);
      agentClear();
      await settle();
      await tick(6000);
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      expect(lines()).toContain("Codex cleared the canvas while you were editing “Text” for “n2”. That change wasn’t saved.");
    });

    it('CLR2: a PUT on its way that Nebula refuses for the old canvas is named', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'PUT', 409, STALE_CANVAS_DETAIL);
      nebula().holdAnswers = true;
      type('n2', 'Typed');
      await tick(1100);
      nebula().holdAnswers = false;
      agentClear();
      await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(lines()).toContain("Codex cleared the canvas while you were editing “Text” for “n2”. That change wasn’t saved.");
      expect(lines().some((line) => String(line).includes(STALE_CANVAS_DETAIL))).toBe(false);
    });

    it('typing on two nodes: counted', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'One');
      type('n2', 'Two');
      await tick(200);
      agentClear();
      await settle();
      expect(lines()).toContain("Codex cleared the canvas while you were editing 2 settings. Those changes weren’t saved.");
    });

    it('a rename on its way counts as "Name"', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      let answerRename: () => void = () => {};
      fake.override = (path, init) => {
        if (path === '/api/graph/node/n2/label') {
          nebula().calls.push({ path, method: init?.method ?? 'GET' });
          return new Promise((resolve) => {
            answerRename = () => resolve(new Response(JSON.stringify({ detail: STALE_CANVAS_DETAIL }), { status: 409 }));
          });
        }
        return nebula().apiFetch(path, init);
      };
      store().renameNode('n2', 'Hero');
      await settle();
      agentClear();
      await settle();
      answerRename();
      await settle();
      expect(lines()).toContain("Codex cleared the canvas while you were editing “Name” for “n2”. That change wasn’t saved.");
    });

    it('a rename draft open in the title counts as "Name"', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      store().noteRenameDraft('n2', 'Hero');
      agentClear();
      await settle();
      expect(lines()).toContain("Codex cleared the canvas while you were editing “Name” for “n2”. That change wasn’t saved.");
    });

    it('an agent with no name: "An agent"', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'Typed');
      await tick(200);
      agentClear('1', { kind: 'anonymous' });
      await settle();
      expect(lines()).toContain("An agent cleared the canvas while you were editing “Text” for “n2”. That change wasn’t saved.");
    });

    it("the person's own clear: no line", async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'Typed');
      await tick(200);
      store().clearGraph();
      await settle();
      expect(lines().filter((line) => String(line).includes('cleared the canvas'))).toEqual([]);
    });

    it('nothing being edited: no line', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      agentClear();
      await settle();
      expect(lines().filter((line) => String(line).includes('cleared the canvas'))).toEqual([]);
    });
  });

  describe('M2: a backend restart is never a clear', () => {
    it('the reconnect sync keeps the canvas revision: the typing goes out, no line', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '2' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n2', 'Typed');
      await tick(200);
      sync('2');
      await settle();
      await tick(6000);
      expect(writes()).toContain('PUT /api/graph/node/n2');
      expect(nebula().valueOf('n2')).toBe('Typed');
      expect(lines()).toEqual([]);
    });

    it("RST as the reviewer wrote it: a sync with no edit whose revision moved but whose canvas didn't keeps the typing", async () => {
      // Round 21 (review 20, L-4): only when Nebula says it lost its revisions.
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '2' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      // Round 22 (review 21, L-b): a restart is a sync from another process.
      sync('2', { bootId: 'rst-boot-a' });
      await settle();
      type('n2', 'Typed');
      await tick(200);
      sync('0', { canvasRevisionRestored: false, bootId: 'rst-boot-b' });
      await settle();
      await tick(6000);
      expect(writes()).toContain('PUT /api/graph/node/n2');
      expect(valueOf('n2')).toBe('Typed');
      expect(getProjectContext()?.canvas).toBe('0');
      expect(lines()).toEqual([]);
    });

    it("the agent-clear line never fires after a restart, even when the sync's canvas is empty", async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '2' });
      start([textFakeNode('n1'), textFakeNode('n2')]);
      sync('2', { bootId: 'rst-boot-c' });
      await settle();
      type('n2', 'Typed');
      await tick(200);
      nebula().nodes.clear(); nebula().edges = [];
      sync('0', { canvasRevisionRestored: false, bootId: 'rst-boot-d' });
      await settle();
      await tick(6000);
      expect(lines().filter((line) => String(line).includes('cleared the canvas'))).toEqual([]);
      // That canvas is gone: its typing never reaches a node that takes its id.
      expect(writes()).not.toContain('PUT /api/graph/node/n2');
      // Round 22 (review 21, L-a): and it is never lost with no line.
      expect(lines()).toEqual(["Couldn’t save “Text” for “n2”."]);
    });
  });

  it('SEL (L1, GM B): a refused delete of the node the person clicked comes back unselected', async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2')], [], ['n2']);
    useUIStore.getState().selectNode('n2');
    refuse((path, init) => path === '/api/graph/node/n2' && init?.method === 'DELETE', 500, 'Nope.');
    await del('n2');
    await tick(2000);
    expect(nodeOf('n2')).toBeTruthy();
    expect(nodeOf('n2')?.selected ?? false).toBe(false);
    expect(useUIStore.getState().selectedNodeId).toBeNull();
    // As drawn: no selected ring, no settings pill.
    const node = nodeOf('n2')!;
    const { container } = render(<ModelNode {...({ id: 'n2', data: node.data, selected: node.selected ?? false } as NodeProps)} />);
    expect(container.querySelector('.model-node')).not.toHaveClass('model-node--selected');
    expect(container.querySelector('.model-node__settings-edit')).toBeNull();
    cleanup();
  });

  it('a delete that lands clears the selection that named the node', async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2')], [], ['n2']);
    useUIStore.getState().selectNode('n2');
    await del('n2');
    expect(useUIStore.getState().selectedNodeId).toBeNull();
  });

  it('DR (L4): two drains at once: the save that landed is cut off for neither', async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2')]);
    nebula().holdAnswers = true;
    type('n2', 'Typed');
    await tick(1100);
    const first = store().drainGraphWrites('switch');
    await settle();
    const second = store().drainGraphWrites('import');
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    let firstDone = false;
    void first.then(() => { firstDone = true; });
    await tick(300);
    expect(firstDone).toBe(true);
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(nebula().valueOf('n2')).toBe('Typed');
  });

  describe('GM 1: a failed delete with no answer', () => {
    const noAnswer = (ids: string[]) => {
      fake.override = (path, init) => {
        const match = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
        if (match && init?.method === 'DELETE' && ids.includes(match[1])) {
          nebula().calls.push({ path, method: 'DELETE' });
          return Promise.reject(new ConnectionLostError(new TypeError('Failed to fetch')));
        }
        return nebula().apiFetch(path, init);
      };
    };
    const named = (id: string, label: string) => ({ ...textFakeNode(id), label });

    it('one node', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([named('n1', 'Nano Banana'), textFakeNode('n2')]);
      noAnswer(['n1']);
      await del('n1');
      await tick(200);
      expect(nodeOf('n1')).toBeTruthy();
      expect(lines()).toContain(`Couldn't delete “Nano Banana”. ${NO_ANSWER}`);
    });

    it('three nodes', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([named('n1', 'A'), named('n2', 'B'), named('n3', 'C')]);
      noAnswer(['n1', 'n2', 'n3']);
      store().onNodesChange(['n1', 'n2', 'n3'].map((id) => ({ id, type: 'remove' as const })));
      await settle();
      await tick(200);
      expect(lines()).toContain(`Couldn't delete “A”, “B” and “C”. ${NO_ANSWER}`);
    });

    it('four nodes', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([named('n1', 'A'), named('n2', 'B'), named('n3', 'C'), named('n4', 'D')]);
      noAnswer(['n1', 'n2', 'n3', 'n4']);
      store().onNodesChange(['n1', 'n2', 'n3', 'n4'].map((id) => ({ id, type: 'remove' as const })));
      await settle();
      await tick(200);
      expect(lines()).toContain(`Couldn't delete 4 nodes. ${NO_ANSWER}`);
    });

    it('another cause keeps its reason', async () => {
      setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
      start([named('n1', 'Nano Banana'), textFakeNode('n2')]);
      refuse((path, init) => path === '/api/graph/node/n1' && init?.method === 'DELETE', 409, 'It is still running.');
      await del('n1');
      await tick(200);
      expect(lines()).toContain("Couldn't delete the node. It is still running.");
    });
  });

  it("M3 (seed 84's shape): a delete from before an agent's clear never drops the typing on the new node with its id", async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
    nebula().holdAnswers = true;
    await del('n3');
    nebula().holdAnswers = false;
    // An agent clears and adds n1..n3 again.
    agentClear();
    await settle();
    agentEdit(() => { for (const id of ['n1', 'n2', 'n3']) nebula().nodes.set(id, textFakeNode(id, `AG${id}`)); nebula().next = 4; });
    await settle();
    setProjectContext({ ...getProjectContext()!, canvas: '1' });
    type('n3', 'v1');
    await tick(1100);
    await settle();
    type('n3', 'v2');
    await tick(100);
    // The pre-clear DELETE n3 answer lands now.
    while (nebula().releaseAnswer()) await settle();
    await tick(2000);
    await settle();
    expect(valueOf('n3')).toBe('v2');
    expect(nebula().valueOf('n3')).toBe('v2');
  });
});
