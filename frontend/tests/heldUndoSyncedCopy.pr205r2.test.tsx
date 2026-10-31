import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// PR #205 round 2, GM r2 item 2 (review 1 LOW-3): an agent's edit to a node
// whose Delete is on its way is what Undo brings back. "Undo means 'bring
// back what I deleted', not 'roll back what someone else did since'." Both
// paths: the Undo held on the Delete, and an Undo pressed after its answer
// (main's path; before, both restored the copy from when Delete was pressed).
// The harness is round 18's (a fake Nebula that applies each request).

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
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); };
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) expect(valueOf(id)).toEqual(nebula().valueOf(id));
  expect(wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)))).toEqual(nebula().wires());
};
const del = async (id: string) => { store().onNodesChange([{ id, type: 'remove' }]); await settle(); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const codex = { actor: { kind: 'agent', name: 'Codex', id: 'codex' } };
let clock = Date.now();

describe('GM PR #205 r2 item 2: Undo brings back the newest copy Nebula synced', () => {
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


  /** An agent's edit to n1 that Nebula synced while n1's Delete was on its way
   * (Nebula took the edit first: the sync still has n1); `gone`: then the sync
   * without n1 that comes before the Delete's answer on the person's machine. */
  const agentEditsWhileDeleting = (gone = true) => {
    const nodes = FakeNebula.syncNodes({ nodes: [...nebula().nodes.values(), { ...textFakeNode('n1'), label: 'Agent title', params: { value: 'AGENT' } }], edges: [] });
    emit({ nodes, edges: [], empty: false, edit: { ...codex, id: 'ed_ag1' } });
    if (!gone) return;
    // Then Nebula carries out the Delete and syncs its graph without n1, as
    // the real backend does: after the agent's edit, before the Delete's answer.
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false,
      edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own_delete' } });
  };

  it('the Undo held on the Delete: the node comes back as the agent left it, here and in Nebula', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')]);
    nebula().holdAnswers = true;
    await del('n1');
    await undo(); // held on the Delete
    agentEditsWhileDeleting();
    await settle();
    expect(nodeOf('n1')).toBeUndefined();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    expect(nodeOf('n1')?.data.params.value).toBe('AGENT');
    expect(nodeOf('n1')?.data.label).toBe('Agent title');
    expect(nebula().valueOf('n1')).toBe('AGENT');
    expect(nebula().nodes.get('n1')?.label).toBe('Agent title');
    expect(notice()).toBe('Restored the node.');
    sameAsNebula();
  });

  it('an Undo pressed after the Delete answered (main\'s path): the same', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')]);
    nebula().holdAnswers = true;
    await del('n1');
    agentEditsWhileDeleting();
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    expect(nodeOf('n1')).toBeUndefined();
    await undo();
    await tick(6000); await settle();
    expect(nodeOf('n1')?.data.params.value).toBe('AGENT');
    expect(nodeOf('n1')?.data.label).toBe('Agent title');
    expect(nebula().valueOf('n1')).toBe('AGENT');
    sameAsNebula();
  });

  it.each(['the held Undo', 'an Undo after the answer'])('%s, the Delete\'s answer first (no sync without the node before it): the same', async (when) => {
    start([textFakeNode('n1'), textFakeNode('n2')]);
    nebula().holdAnswers = true;
    await del('n1');
    if (when === 'the held Undo') await undo();
    agentEditsWhileDeleting(false);
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    if (when !== 'the held Undo') { await undo(); await tick(6000); await settle(); }
    expect(nodeOf('n1')?.data.params.value).toBe('AGENT');
    expect(nebula().valueOf('n1')).toBe('AGENT');
  });

  it('no edit while it was on its way: the copy from when Delete was pressed, as before', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'mine' } }, textFakeNode('n2')]);
    nebula().holdAnswers = true;
    await del('n1');
    await undo();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    expect(nodeOf('n1')?.data.params.value).toBe('mine');
    sameAsNebula();
  });
});
