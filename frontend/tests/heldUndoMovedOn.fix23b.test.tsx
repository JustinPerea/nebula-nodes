// PR #199 fix round 23, lane B (review 21 reopen-tabs NIT-3, mutants G1 and
// G2): a refused delete brings its node back as it was at the press only when
// the person hasn't moved on. Moving on is either half alone: inspecting
// another node with no canvas selection (G1), or selecting another node on
// the canvas with nothing inspected (G2). Round 20's SEL changes both at once,
// so it can't tell the halves apart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => (fake.override ? fake.override(path, init) : fake.backend.apiFetch(path, init)),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { setProjectContext } from '../src/lib/projectContext';
import { useUIStore } from '../src/store/uiStore';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
let clock = Date.now();

describe('review 21 NIT-3 (G1, G2): either half of moving on alone counts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.override = null;
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

  const start = (nodes: FakeNode[], selected: string[]) => {
    nebula().reset(nodes, []);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, selected.includes(node.id) ? { selected: true } : {})),
      edges: [], isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** n2 selected and inspected; its delete goes, and Nebula refuses it later. */
  const deleteRefusedLater = async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2')], ['n2']);
    useUIStore.getState().selectNode('n2');
    nebula().holdAnswers = true;
    let left = 1;
    fake.override = (path, init) => {
      if (left > 0 && path === '/api/graph/node/n2' && init?.method === 'DELETE') {
        left -= 1;
        nebula().calls.push({ path, method: 'DELETE' });
        return nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'Refused.' }), { status: 409 }));
      }
      return nebula().apiFetch(path, init);
    };
    store().onNodesChange([{ id: 'n2', type: 'remove' }]);
    await settle();
    expect(nodeOf('n2')).toBeUndefined();
  };
  const answer = async () => {
    while (nebula().releaseAnswer());
    await settle();
    await tick(2000);
  };

  it('G1: the person inspected another node (nothing selected on the canvas): n2 comes back unselected, n1 stays inspected', async () => {
    await deleteRefusedLater();
    useUIStore.getState().selectNode('n1');
    expect(store().nodes.some((node) => node.selected)).toBe(false);
    await answer();
    expect(nodeOf('n2')).toBeTruthy();
    expect(nodeOf('n2')?.selected ?? false).toBe(false);
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
  });

  it('G2: the person selected another node on the canvas (nothing inspected): n2 comes back unselected, n1 stays selected', async () => {
    await deleteRefusedLater();
    expect(useUIStore.getState().selectedNodeId).toBeNull();
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
    await answer();
    expect(nodeOf('n2')).toBeTruthy();
    expect(nodeOf('n2')?.selected ?? false).toBe(false);
    expect(nodeOf('n1')?.selected).toBe(true);
    // Since main's "the unpinned Inspector follows the selection" (#205 r11-r18, merged in
    // round 25), the one selected node is the inspected one too.
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
  });

  it('control: nothing changed since the press: n2 comes back selected and inspected', async () => {
    await deleteRefusedLater();
    await answer();
    expect(nodeOf('n2')?.selected).toBe(true);
    expect(useUIStore.getState().selectedNodeId).toBe('n2');
  });
});
