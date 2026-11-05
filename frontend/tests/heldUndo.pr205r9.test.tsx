import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 9: review 8 of the held Undo. One rule: no sync older than
// an edit Nebula answered OK may undo that edit. Every graphSync carries
// `syncSeq`; a restore's and a node delete's answer names its own sync's, and
// the canvas handles the answer once that sync (or a later one) has come.
// - MEDIUM-1 (S3, S3b): two restores of one node each wait for their own sync.
// - MEDIUM-2 (W9c): a restored connection's hold waits for its sync too, with
//   any number of older agent syncs after the answer.
// - MEDIUM-3 (S5): the person's Delete: an agent's sync read before Nebula
//   applied it never brings the node back as that agent's step.
// - LOW-3 (S1, S6 with the echo lost, or after 15 s): no cap turns an older
//   sync into a step; a reconnect's numbered sync decides.
// - LOW-1 (F3b), LOW-2 (Fa, Fb), LOW-4 (N1).
// - The ways an answer's wait ends: its sync, a later one, a restart, an
//   unnumbered sync, another canvas; and the clear's and import's cleanup.
// - The generator of review 8 (1-4 agents, every hold kind, four socket orders).
// The harness is review 8's: echoes and agent syncs share one socket queue,
// each numbered when Nebula read the graph.

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response> | null),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => fake.override?.(path, init) ?? fake.backend.apiFetch(path, init),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

import { forgetHeldHistoryForTests, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { setProjectContext } from '../src/lib/projectContext';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const initialUi = useUIStore.getState();
const CLI = /^n\d+$/;
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const cliIds = () => ids().filter((id) => CLI.test(id));
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const valueOf = (id: string) => nodeOf(id)?.data.params.value;
const labelOf = (id: string) => nodeOf(id)?.data.label;
const wires = () => store().edges.map((edge) => `${edge.source}>${edge.target}`).sort();
const cliWires = () => wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)));
const notice = () => store().undoNotice?.text ?? null;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); await tick(6000); await settle(); };
const redo = async () => { store().redo(); await settle(); await tick(6000); await settle(); };
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) {
    expect(valueOf(id)).toEqual(nebula().valueOf(id));
    expect(labelOf(id)).toEqual(nebula().nodes.get(id)?.label);
  }
  expect(cliWires()).toEqual(nebula().wires());
};
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const codex = { actor: { kind: 'agent', name: 'Codex', id: 'codex' } };
const claude = { actor: { kind: 'agent', name: 'Claude', id: 'claude' } };
const gemini = { actor: { kind: 'agent', name: 'Gemini', id: 'gemini' } };
const grok = { actor: { kind: 'agent', name: 'Grok', id: 'grok' } };
const wire = (source: string, target: string): FakeWire => ({ id: `w-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text' });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let clock = Date.now();

describe('PR #205 round 9: no sync older than an edit Nebula answered OK undoes it', () => {
  // ---- one socket queue: the person's echoes and agents' syncs, each numbered when read ----
  let sockHold = false;
  const sock: Array<{ label: string; fire: () => void }> = [];
  const snapGraph = () => ({ nodes: [...nebula().nodes.values()].map(clone), edges: clone(nebula().edges) });
  const fireOf = (graph: ReturnType<typeof snapGraph>, seq: number | null, edit?: Record<string, unknown>) => () => emit({
    nodes: FakeNebula.syncNodes(graph), edges: graph.edges, empty: graph.nodes.length === 0,
    ...(seq === null ? {} : { syncSeq: seq }), ...(edit ? { edit } : {}) });
  const flushAll = () => { while (sock.length) sock.shift()!.fire(); };
  const flush = async (n = 1) => { for (let i = 0; i < n && sock.length; i += 1) { sock.shift()!.fire(); await settle(); } };
  const dropSock = (label: string) => { const at = sock.findIndex((each) => each.label.startsWith(label)); if (at >= 0) sock.splice(at, 1); return at >= 0; };
  /** Nebula's own broadcasts (the person's writes) go on the queue, numbered as read. */
  let lastEchoSeq = 0;
  const queueOnSock = () => {
    (nebula() as unknown as { broadcast: () => void }).broadcast = () => {
      lastEchoSeq = nebula().nextSyncSeq();
      sock.push({ label: 'echo', fire: fireOf(snapGraph(), lastEchoSeq, { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' }) });
      if (!sockHold) flushAll();
    };
  };
  /** An agent's edit: Nebula applies it now and numbers its sync now; it reaches the canvas in queue order. */
  const agentQ = (who: Record<string, unknown>, id: string, change: () => void) => {
    nebula().request += 1;
    change();
    sock.push({ label: `agent ${id}`, fire: fireOf(snapGraph(), nebula().nextSyncSeq(), { ...who, id }) });
    if (!sockHold) flushAll();
  };
  /** A reconnect's first sync: no origin, numbered when read. */
  const reconnectQ = () => { sock.push({ label: 'reconnect', fire: fireOf(snapGraph(), nebula().nextSyncSeq()) }); if (!sockHold) flushAll(); };

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
    delete (nebula() as unknown as { broadcast?: unknown }).broadcast;
    sock.length = 0;
    sockHold = false;
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer()) await settle();
    await settle();
    await tick(20_000);
    forgetHeldHistoryForTests();
    setProjectContext(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
    useUIStore.setState(initialUi, true);
  });
  const start = (nodes: FakeNode[], edges: FakeWire[] = []) => {
    nebula().reset(nodes, edges);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node)),
      edges: edges.map((edge) => ({ ...edge, type: 'typed-edge', data: { dataType: 'Text' } })) as Edge[],
      isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const two = () => start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
  /** An agent's edit synced at once (numbered now). */
  const agentDoes = (who: Record<string, unknown>, id: string, change: () => void) => {
    nebula().request += 1;
    change();
    fireOf(snapGraph(), nebula().nextSyncSeq(), { ...who, id })();
  };
  const kinds = () => store().undoStack.map((entry) => { const e = entry as { kind?: string; agentName?: string };
    return e.kind === 'foreign' ? `F(${e.agentName})` : e.kind === 'own-add' ? 'add' : 'own'; });
  const releaseAll = async () => {
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  const releaseLabelled = async (prefix: string) => {
    const at = nebula().answers.findIndex((answer) => answer.label.startsWith(prefix));
    if (at >= 0) { nebula().releaseAnswer(at); await settle(); }
    return at >= 0;
  };
  const refuseDelete = (id = 'n1') => {
    fake.override = (path, init) => (init?.method === 'DELETE' && path === `/api/graph/node/${id}`
      ? nebula().later(`refused ${id}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
      : null);
  };
  const deleteLanded = async (id: string) => {
    store().onNodesChange([{ id, type: 'remove' }]);
    await settle(); await tick(6000); await settle();
  };
  const typeInto = async (id: string, value: string) => {
    store().updateNodeData(id, { params: { ...nodeOf(id)!.data.params, value } });
    await tick(1100); await settle();
  };
  /** A write Nebula applies when it arrives, whose answer waits until let go. */
  const hangPut = (match: (path: string, init?: RequestInit) => boolean) => {
    let letGo: () => void = () => {};
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    const prior = fake.override;
    fake.override = (path, init) => {
      if (match(path, init)) { const applied = fake.backend.apiFetch(path, init); return gate.then(() => applied); }
      return prior?.(path, init) ?? null;
    };
    return () => letGo();
  };
  const isPut = (id: string) => (path: string, init?: RequestInit) => init?.method === 'PUT' && path === `/api/graph/node/${id}`;
  /** The restore's request waits until let go (Nebula hasn't applied it yet). */
  const gateRestore = (onlyFirst = true) => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let first = true;
    const prior = fake.override;
    fake.override = (path, init) => {
      if (path === '/api/graph/restore' && (first || !onlyFirst)) { first = false; return gate.then(() => fake.backend.apiFetch(path, init)); }
      return prior?.(path, init) ?? null;
    };
    return () => open();
  };
  /** Socket orders: A an answer, S/E the next queued sync, L the echo lost, R a reconnect, C 16 s, w 1 s. */
  const runOrder = async (order: string) => {
    for (const ch of order) {
      if (ch === 'A') { nebula().releaseAnswer(); await settle(); await tick(50); await settle(); }
      else if (ch === 'S' || ch === 'E') await flush(1);
      else if (ch === 'L') dropSock('echo');
      else if (ch === 'R') { reconnectQ(); await flush(sock.length); }
      else if (ch === 'C') { await tick(16_000); await settle(); }
      else if (ch === 'w') { await tick(1000); await settle(); }
    }
  };
  const finish = async () => {
    sockHold = false; flushAll(); await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    fake.override = null;
    await tick(20_000); await settle();
  };
  /**
   * Every Undo, then every Redo: after each, the canvas is Nebula, and a step
   * labelled for an agent changes only what that agent's edits touched
   * (`touched`: node ids whose presence or label it may change; connections it
   * may change).
   */
  const walkChecked = async (touched: Record<string, { nodes?: string[]; wires?: string[] }>) => {
    const lines: string[] = [];
    const check = (line: string | null, before: { ids: string[]; labels: string; wires: string[] }) => {
      sameAsNebula();
      const actor = Object.keys(touched).find((name) => line?.includes(`${name}’s`));
      if (!actor) return;
      const may = touched[actor];
      const changedIds = [...new Set([...before.ids, ...nebula().ids()])].filter((id) => before.ids.includes(id) !== nebula().ids().includes(id));
      for (const id of changedIds) expect(may.nodes ?? [], `${line} changed ${id}'s presence`).toContain(id);
      const changedWires = [...new Set([...before.wires, ...nebula().wires()])].filter((w) => before.wires.includes(w) !== nebula().wires().includes(w));
      for (const w of changedWires) expect(may.wires ?? [], `${line} changed ${w}`).toContain(w);
    };
    const snap = () => ({ ids: nebula().ids(), labels: JSON.stringify(nebula().ids().map((id) => nebula().nodes.get(id)?.label)), wires: nebula().wires() });
    let guard = 0;
    while (store().undoStack.length && guard++ < 12) { const before = snap(); await undo(); lines.push(`U ${notice()}`); check(notice(), before); }
    guard = 0;
    while (store().redoStack.length && guard++ < 12) { const before = snap(); await redo(); lines.push(`R ${notice()}`); check(notice(), before); }
    return lines;
  };
  /** A sync Nebula read before it brought n1 back (numbered `seq`, below the
   * restore's), with no origin: n1 stays on the canvas only while held. */
  const n1HeldThroughStale = async (seq: number) => {
    const graph = snapGraph();
    fireOf({ nodes: graph.nodes.filter((node) => node.id !== 'n1'),
      edges: graph.edges.filter((edge) => edge.source !== 'n1' && edge.target !== 'n1') }, seq)();
    await settle();
    return cliIds().includes('n1');
  };
  /** Codex sets n1 now: shown at once only when nothing holds n1. */
  const n1Free = async () => {
    const value = `free${nebula().syncSeq}`;
    agentDoes(codex, `ed_free${String(nebula().syncSeq).padStart(10, '0')}`, () => { nebula().nodes.get('n1')!.params = { value }; });
    await settle();
    return valueOf('n1') === value;
  };

  // ---- S1: the restore brings n1 back; Claude's sync read before Nebula applied it lacks n1 ----
  const s1 = async (order: string) => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    sockHold = true;
    nebula().holdAnswers = true;
    const open = gateRestore();
    store().undo(); await settle();
    agentQ(claude, 'ed_s1claude000001', () => { nebula().nodes.get('n2')!.label = 'Claude'; });
    open(); await settle(); await settle();
    await runOrder(order);
  };
  for (const order of ['ASE', 'SAE', 'SEA', 'ASwE', 'ASLR', 'SLAR', 'ASCE', 'SACE']) {
    it(`S1 ${order}: the stale sync never takes n1 off, and Claude's Undo and Redo touch only n2`, async () => {
      await s1(order);
      expect(cliIds()).toEqual(['n1', 'n2']);
      await finish();
      sameAsNebula();
      expect(kinds()).toEqual(['F(Claude)']);
      const lines = await walkChecked({ Claude: {} });
      expect(lines).toEqual(['U Undid Claude’s edit.', 'R Redid Claude’s edit.']);
      expect(nebula().ids()).toEqual(['n1', 'n2']);
    });
  }
  it('S1 ASL, no echo and no reconnect past 15 s: n1 stays as Nebula has it; the reconnect\'s sync then ends the hold', async () => {
    await s1('ASLC');
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    await tick(60_000); await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    // Still held, a minute on: another sync read before the restore leaves n1 be.
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(true);
    sockHold = false;
    reconnectQ(); await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(valueOf('n1')).toBe(nebula().valueOf('n1'));
    expect(await n1Free()).toBe(true);
    await finish();
    sameAsNebula();
    const lines = await walkChecked({ Claude: {}, Codex: {} });
    expect(lines.filter((line) => line.includes('Claude’s'))).toEqual(['U Undid Claude’s edit.', 'R Redid Claude’s edit.']);
    expect(nebula().ids()).toEqual(['n1', 'n2']);
  });

  // ---- S2: the restore applies, then Claude deletes n1 ----
  for (const order of ['AES', 'EAS', 'ESA', 'ALSR', 'LSA', 'AEwS']) {
    it(`S2 ${order}: Claude's delete after the restore is Claude's step; its Undo brings n1 back with n1>n2`, async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }], [wire('n1', 'n2')]);
      queueOnSock();
      await deleteLanded('n1');
      sockHold = true;
      nebula().holdAnswers = true;
      store().undo(); await settle(); await settle();
      agentQ(claude, 'ed_s2claude000001', () => { nebula().nodes.delete('n1'); nebula().edges = nebula().edges.filter((e) => e.source !== 'n1' && e.target !== 'n1'); });
      await runOrder(order);
      await finish();
      sameAsNebula();
      expect(cliIds()).toEqual(['n2']);
      expect(kinds()).toEqual(['F(Claude)']);
      await undo();
      sameAsNebula();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(nebula().ids()).toEqual(['n1', 'n2']);
      expect(nebula().wires()).toEqual(['n1>n2']);
    });
  }

  // ---- S3: Undo brings n1 back, Redo takes it off; with and without a stale sync ----
  for (const [order, stale] of [['AEAE', false], ['AAEE', false], ['EAAE', false], ['SAEAE', true], ['ASAEE', true], ['AASEE', true], ['ASEAE', true], ['SAAEE', true]] as const) {
    it(`S3 ${stale ? 'stale ' : ''}${order}: two restores of n1 each wait for their own sync; n1 ends off, as in Nebula`, async () => {
      two();
      queueOnSock();
      await deleteLanded('n1');
      sockHold = true;
      nebula().holdAnswers = true;
      const open = gateRestore();
      store().undo(); await settle();
      if (stale) agentQ(claude, 'ed_s3claude000001', () => { nebula().nodes.get('n2')!.label = 'Claude'; });
      open(); await settle();
      store().redo(); await settle();
      await runOrder(order);
      expect(cliIds()).toEqual(['n2']);
      await finish();
      sameAsNebula();
      expect(cliIds()).toEqual(['n2']);
      const lines = await walkChecked({ Claude: {} });
      if (stale) expect(lines.filter((line) => line.includes('Claude’s'))).toEqual(['U Undid Claude’s edit.', 'R Redid Claude’s edit.']);
    });
  }

  // ---- S3b: two Undos of n1: one brings it back, one puts back its typed value ----
  for (const order of ['AASEE', 'ASAEE', 'SAAEE', 'ASEAE', 'SAEAE']) {
    it(`S3b ${order}: the second restore's answer never ends the first's hold; Claude's Redo keeps n1`, async () => {
      two();
      queueOnSock();
      await typeInto('n1', 'typed');
      await settle(); await tick(6000); await settle();
      await deleteLanded('n1');
      sockHold = true;
      nebula().holdAnswers = true;
      const open = gateRestore();
      store().undo(); await settle();
      store().undo(); await settle();
      agentQ(claude, 'ed_s3bclaude00001', () => { nebula().nodes.get('n2')!.label = 'Claude'; });
      open(); await settle(); await settle();
      await runOrder(order);
      expect(cliIds()).toEqual(['n1', 'n2']);
      await finish();
      sameAsNebula();
      expect(nebula().valueOf('n1')).toBe('v0');
      const lines = await walkChecked({ Claude: {} });
      expect(lines.filter((line) => line.includes('Claude’s'))).toEqual(['U Undid Claude’s edit.', 'R Redid Claude’s edit.']);
    });
  }

  // ---- S5: the person's Delete; Claude's rename of n1 read before Nebula applied it trails the answer ----
  for (const order of ['SAE', 'ASE', 'SEA', 'AwSE', 'AES']) {
    it(`S5 ${order}: Claude's rename is its own step under the Delete; no Undo or Redo of Claude's changes n1's presence`, async () => {
      two();
      queueOnSock();
      sockHold = true;
      nebula().holdAnswers = true;
      agentQ(claude, 'ed_s5claude000001', () => { nebula().nodes.get('n1')!.label = 'ClaudeN1'; });
      store().onNodesChange([{ id: 'n1', type: 'remove' }]); await settle();
      if (order === 'AES') {
        // Nebula applied the Delete first: Claude's sync is newer, and has no n1.
        sock.length = 0;
        sock.push({ label: 'echo', fire: fireOf(snapGraph(), nebula().nextSyncSeq(), { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' }) });
      }
      await runOrder(order);
      expect(cliIds()).toEqual(['n2']);
      await finish();
      sameAsNebula();
      expect(cliIds()).toEqual(['n2']);
      if (order !== 'AES') expect(kinds()).toEqual(['F(Claude)', 'own']);
      const lines = await walkChecked({ Claude: {} });
      expect(lines[0]).toBe('U Restored the node.');
      if (order !== 'AES') expect(lines).toContain('R Redid Claude’s edit.');
      expect(nebula().ids()).toEqual(['n2']);
    });
  }

  // ---- S6: the Redo takes n1 off; Claude's rename of n1 read before Nebula applied it ----
  for (const order of ['SAE', 'ASE', 'SEA', 'ASLR', 'ASCE']) {
    it(`S6 ${order}: the stale copy never brings n1 back`, async () => {
      two();
      queueOnSock();
      await deleteLanded('n1');
      await undo();
      expect(cliIds()).toEqual(['n1', 'n2']);
      sockHold = true;
      nebula().holdAnswers = true;
      const open = gateRestore();
      store().redo(); await settle();
      agentQ(claude, 'ed_s6claude000001', () => { nebula().nodes.get('n1')!.label = 'ClaudeN1'; });
      open(); await settle(); await settle();
      await runOrder(order);
      expect(cliIds()).toEqual(['n2']);
      await finish();
      sameAsNebula();
      expect(cliIds()).toEqual(['n2']);
      await walkChecked({ Claude: {} });
    });
  }
  it('S6 ASL, no echo past 15 s: n1 stays off as Nebula has it', async () => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    await undo();
    sockHold = true;
    nebula().holdAnswers = true;
    const open = gateRestore();
    store().redo(); await settle();
    agentQ(claude, 'ed_s6lclaude00001', () => { nebula().nodes.get('n1')!.label = 'ClaudeN1'; });
    open(); await settle(); await settle();
    await runOrder('ASLC');
    await tick(60_000); await settle();
    expect(cliIds()).toEqual(['n2']);
    expect(nebula().ids()).toEqual(['n2']);
    sockHold = false;
    reconnectQ(); await settle();
    await finish();
    sameAsNebula();
    expect(cliIds()).toEqual(['n2']);
  });

  // ---- W9c: the restore brings back n1 and n1>n2; 1-3 stale agent syncs ----
  const w9c = async (stale: number, order: 'ASE' | 'SAE', viaWait: boolean) => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, { ...textFakeNode('n3'), params: { value: 'x0' } }], [wire('n1', 'n2')]);
    queueOnSock();
    let release: () => void = () => {};
    if (viaWait) release = hangPut(isPut('n3'));
    if (viaWait) await typeInto('n3', 'typed');
    await deleteLanded('n1');
    expect(nebula().wires()).toEqual([]);
    sockHold = true;
    nebula().holdAnswers = true;
    let open: () => void = () => {};
    if (!viaWait) open = gateRestore();
    store().undo(); await settle();
    for (let i = 0; i < stale; i += 1) agentQ(claude, `ed_w9c${i}claude00000`, () => { nebula().nodes.get('n2')!.label = `Claude${i}`; });
    await settle();
    if (viaWait) { nebula().holdAnswers = false; release(); nebula().holdAnswers = true; } else open();
    await settle(); await settle();
    if (order === 'ASE') { nebula().releaseAnswer(); await settle(); await tick(50); await settle(); }
    for (let i = 0; i < stale; i += 1) {
      await flush(1);
      expect(cliWires()).toEqual(['n1>n2']);
    }
    if (order === 'SAE') { nebula().releaseAnswer(); await settle(); await tick(50); await settle(); }
    await flush(sock.length);
    sockHold = false;
    nebula().holdAnswers = false; while (nebula().releaseAnswer()) await settle();
    fake.override = null; await tick(16_000); await settle();
  };
  for (const stale of [1, 2, 3]) for (const order of ['ASE', 'SAE'] as const) for (const viaWait of [false, true]) {
    it(`W9c ${stale} stale ${order}${viaWait ? ' behind a save' : ''}: n1>n2 stays, and no Claude Undo or Redo touches it`, async () => {
      await w9c(stale, order, viaWait);
      sameAsNebula();
      expect(nebula().wires()).toEqual(['n1>n2']);
      expect(kinds().filter((kind) => kind === 'F(Claude)')).toHaveLength(stale);
      const lines = await walkChecked({ Claude: {} });
      expect(lines.filter((line) => line.includes('Claude’s'))).toHaveLength(2 * stale);
      expect(nebula().wires()).toEqual(['n1>n2']);
    });
  }

  // ---- a restored connection's hold ends at a later sync: the canvas takes that sync's way ----
  /** Undo brings back n1 and n1>n2; its echo is lost; Claude's next sync decides. */
  it('W9d: the echo lost, Claude takes n1>n2 off after the restore: its sync ends the hold and the canvas drops it', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }], [wire('n1', 'n2')]);
    queueOnSock();
    await deleteLanded('n1');
    sockHold = true;
    store().undo(); await settle(); await tick(50); await settle();
    expect(nebula().wires()).toEqual(['n1>n2']);
    dropSock('echo');
    agentQ(claude, 'ed_w9dclaude00001', () => { nebula().edges = []; });
    await flush(1);
    expect(cliWires()).toEqual([]);
    sameAsNebula();
  });
  /** Undo of the person's connect takes n1>n2 off; its echo is lost; Claude connects them again. */
  const unwireUndone = async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    queueOnSock();
    store().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' });
    await settle(); await tick(6000); await settle();
    expect(nebula().wires()).toEqual(['n1>n2']);
    sockHold = true;
    nebula().holdAnswers = true;
    store().undo(); await settle();
    expect(nebula().wires()).toEqual([]);
  };
  it('W9e: the echo lost, Claude connects n1>n2 again after the Undo took it off: its sync ends the hold and the canvas shows it', async () => {
    await unwireUndone();
    dropSock('echo');
    await releaseLabelled('restore'); await tick(50); await settle();
    agentQ(claude, 'ed_w9eclaude00001', () => { nebula().edges.push(wire('n1', 'n2')); });
    await flush(1);
    expect(cliWires()).toEqual(['n1>n2']);
    sameAsNebula();
  });
  it('W9f: the same with n2 off the canvas (its Delete on its way): no connection to a node the canvas lacks', async () => {
    await unwireUndone();
    dropSock('echo');
    refuseDelete('n2');
    store().onNodesChange([{ id: 'n2', type: 'remove' }]); await tick(5);
    agentQ(claude, 'ed_w9fclaude00001', () => { nebula().edges.push(wire('n1', 'n2')); });
    await releaseLabelled('restore'); await tick(50); await settle();
    await flush(1);
    expect(cliIds()).toEqual(['n1']);
    expect(wires()).toEqual([]);
    await releaseLabelled('refused');
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(cliWires()).toEqual(['n1>n2']);
  });

  it('Codex clears while a Redo holds n1 off (its echo lost, a stale copy has n1): the clear\'s Undo never brings n1 back', async () => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    await undo();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    sockHold = true;
    nebula().holdAnswers = true;
    const open = gateRestore();
    store().redo(); await settle();
    agentQ(claude, 'ed_x2claude000001', () => { nebula().nodes.get('n2')!.label = 'Claude'; });
    open(); await settle(); await settle();
    expect(nebula().ids()).toEqual(['n2']);
    dropSock('echo');
    agentQ(codex, 'ed_x2codex0000001', () => { nebula().nodes.clear(); nebula().edges = []; });
    nebula().releaseAnswer(); await settle(); await tick(50); await settle();
    await flush(sock.length);
    await finish();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    expect(nebula().ids()).toEqual(['n2']);
    sameAsNebula();
  });

  it('a refused Undo of the person\'s disconnect holds nothing after: Claude\'s next sync leaves n1 and n2 unconnected, as Nebula', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }], [wire('n1', 'n2')]);
    store().onEdgesChange([{ id: store().edges[0].id, type: 'remove' }]);
    await settle(); await tick(6000); await settle();
    expect(nebula().wires()).toEqual([]);
    fake.override = (path) => (path === '/api/graph/restore'
      ? Promise.resolve(new Response(JSON.stringify({ detail: 'No.' }), { status: 409 })) : null);
    await undo();
    fake.override = null;
    expect(cliWires()).toEqual([]);
    agentDoes(claude, 'ed_refclaude00001', () => { nebula().nodes.get('n2')!.label = 'Claude'; }); await settle();
    sameAsNebula();
    expect(cliWires()).toEqual([]);
  });

  it('Codex clears while the Undo that brought n1 back waits for its answer: one Codex step, whose Undo brings back n1 and n2', async () => {
    two();
    await deleteLanded('n1');
    nebula().holdAnswers = true;
    store().undo(); await settle();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    agentDoes(codex, 'ed_clrcodex000001', () => { nebula().nodes.clear(); nebula().edges = []; }); await settle();
    await releaseAll();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
    expect(kinds().filter((kind) => kind === 'F(Codex)')).toHaveLength(1);
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    sameAsNebula();
  });

  // ---- the person's Delete of two nodes: the wait is for the newer answer's sync ----
  it('a Delete of n1 and n2: Claude\'s sync between their syncs never brings n2 back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, { ...textFakeNode('n3'), params: { value: 'x0' } }]);
    queueOnSock();
    sockHold = true;
    let letN2: () => void = () => {};
    const gate = new Promise<void>((resolve) => { letN2 = resolve; });
    fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n2' ? gate.then(() => fake.backend.apiFetch(path, init)) : null);
    store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]); await settle();
    agentQ(claude, 'ed_twoclaude00001', () => { nebula().nodes.get('n2')!.label = 'ClaudeN2'; });
    letN2(); await settle(); await tick(50); await settle();
    expect(nebula().ids()).toEqual(['n3']);
    expect(sock.map((each) => each.label)).toEqual(['echo', 'agent ed_twoclaude00001', 'echo']);
    await flush(2);
    expect(cliIds()).toEqual(['n3']);
    await flush(1);
    fake.override = null; await tick(6000); await settle();
    sameAsNebula();
    const lines = await walkChecked({ Claude: { nodes: [] } });
    expect(lines[0]).toMatch(/^U Restored /);
    expect(lines).toContain('U Undid Claude’s edit.');
    expect(nebula().ids()).toEqual(['n3']);
  });
  it('another canvas opened while the person\'s Delete waits for its sync: the new canvas\'s n1 is never held', async () => {
    two();
    queueOnSock();
    sockHold = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await settle(); await tick(50); await settle();
    expect(nebula().ids()).toEqual(['n2']);
    dropSock('echo');
    sockHold = false;
    store().loadGraph([canvasNode({ ...textFakeNode('n1'), params: { value: 'other' } })], []);
    await settle();
    nebula().reset([{ ...textFakeNode('n1'), params: { value: 'other' } }]);
    expect(await n1Free()).toBe(true);
  });
  it('an unnumbered sync after the answer\'s own keeps it seen: the answer is handled at once', async () => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    nebula().holdAnswers = true;
    store().undo(); await settle();
    expect(sock).toHaveLength(0);
    fireOf(snapGraph(), null)(); await settle();
    await releaseAll();
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(false);
  });

  // ---- LOW-1, LOW-2 ----
  it('F3b: a refused Delete of n1 (n1>n2); Claude disconnects n1>n2; Codex deletes n2: Codex\'s Undo brings n2 back without it', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }], [wire('n1', 'n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(claude, 'ed_f3bclaude00001', () => { nebula().edges = []; }); await settle();
    agentDoes(codex, 'ed_f3bcodex000001', () => { nebula().nodes.delete('n2'); }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    sameAsNebula();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    expect(nebula().wires()).toEqual([]);
  });
  it('F3c: the same with Claude\'s disconnect after Codex\'s delete of n2 is no edit of Codex\'s: Codex\'s Undo brings n1>n2 back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')], [wire('n1', 'n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(claude, 'ed_f3cclaude00001', () => { nebula().nodes.get('n3')!.label = 'C'; }); await settle();
    agentDoes(codex, 'ed_f3ccodex000001', () => { nebula().nodes.delete('n2'); nebula().edges = []; }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    sameAsNebula();
    expect(nebula().wires()).toEqual(['n1>n2']);
  });
  it('Fc: a refused Delete of n1 (n1>n2); Codex sets n1; Claude deletes n2: Codex\'s Undo leaves n1>n2 as Nebula had it', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')], [wire('n1', 'n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_fccodex0000001', () => { nebula().nodes.get('n1')!.params = { value: 'codex' }; }); await settle();
    agentDoes(claude, 'ed_fcclaude000001', () => { nebula().nodes.delete('n2'); nebula().edges = []; }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Codex)', 'F(Claude)']);
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    sameAsNebula();
    expect(nebula().wires()).toEqual(['n1>n2']);
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    sameAsNebula();
    expect(nebula().valueOf('n1')).toBe('v0');
    expect(nebula().wires()).toEqual(['n1>n2']);
  });
  it('Fa: a refused Delete of n1; Claude connects n1>n3; Codex deletes n3: two steps; Codex\'s Undo brings n3 back with n1>n3', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), textFakeNode('n3')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(claude, 'ed_faclaude000001', () => { nebula().edges.push(wire('n1', 'n3')); }); await settle();
    agentDoes(codex, 'ed_facodex0000001', () => { nebula().nodes.delete('n3'); nebula().edges = nebula().edges.filter((e) => e.target !== 'n3'); }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Claude)', 'F(Codex)']);
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    sameAsNebula();
    expect(nebula().ids()).toEqual(['n1', 'n2', 'n3']);
    expect(nebula().wires()).toEqual(['n1>n3']);
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    sameAsNebula();
    expect(nebula().wires()).toEqual([]);
    await redo(); sameAsNebula(); expect(nebula().wires()).toEqual(['n1>n3']);
    await redo(); sameAsNebula(); expect(nebula().ids()).toEqual(['n1', 'n2']);
  });
  it('Fa2: the same with Claude\'s connect synced twice (one edit): its Undo still takes n1>n3 off', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), textFakeNode('n3')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(claude, 'ed_fa2claude00001', () => { nebula().edges.push(wire('n1', 'n3')); }); await settle();
    agentDoes(claude, 'ed_fa2claude00001', () => {}); await settle();
    agentDoes(codex, 'ed_fa2codex000001', () => { nebula().nodes.delete('n3'); nebula().edges = nebula().edges.filter((e) => e.target !== 'n3'); }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Claude)', 'F(Codex)']);
    await undo();
    expect(notice()).toBe('Undid Codex’s edit.');
    expect(nebula().wires()).toEqual(['n1>n3']);
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    sameAsNebula();
    expect(nebula().wires()).toEqual([]);
  });
  for (const restoreFirst of [true, false]) {
    it(`Fb ${restoreFirst ? 'restore answers first' : 'refusal first'}: Codex connects n1>n2 to a refused-Delete n2; Claude deletes n1: Claude's Undo brings n1 back with n1>n2`, async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      await deleteLanded('n1');
      nebula().holdAnswers = true;
      store().undo(); await settle();
      expect(cliIds()).toContain('n1');
      refuseDelete('n2');
      store().onNodesChange([{ id: 'n2', type: 'remove' }]); await tick(5);
      agentDoes(codex, 'ed_fbcodex0000001', () => { nebula().edges.push(wire('n1', 'n2')); }); await settle();
      agentDoes(claude, 'ed_fbclaude000001', () => { nebula().nodes.delete('n1'); nebula().edges = nebula().edges.filter((e) => e.source !== 'n1'); }); await settle();
      if (restoreFirst) { await releaseLabelled('restore'); await releaseLabelled('refused'); } else { await releaseLabelled('refused'); await releaseLabelled('restore'); }
      await releaseAll(); fake.override = null;
      sameAsNebula();
      expect(kinds()).toEqual(['F(Codex)', 'F(Claude)']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      sameAsNebula();
      expect(nebula().ids()).toEqual(['n1', 'n2', 'n3']);
      expect(nebula().wires()).toEqual(['n1>n2']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      sameAsNebula();
      expect(nebula().wires()).toEqual([]);
    });
  }

  // ---- LOW-4 ----
  const refuseLabel = (path: string, init?: RequestInit) => (init?.method === 'PUT' && /\/label$/.test(path)
    ? nebula().later('label refused', () => new Response(JSON.stringify({ detail: 'No.' }), { status: 500 })) : null);
  for (const labelFirst of [false, true]) {
    it(`N1 ${labelFirst ? 'the refusal first' : 'the restore first'}: the person's refused rename and Claude's rename of a restore-held node: the canvas shows Claude's, as Nebula`, async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteLanded('n1');
      nebula().holdAnswers = true;
      store().undo(); await settle();
      fake.override = refuseLabel;
      store().renameNode('n1', 'MINE'); await settle();
      agentDoes(claude, 'ed_n1claude000001', () => { nebula().nodes.get('n1')!.label = 'ClaudeName'; }); await settle();
      if (labelFirst) await releaseLabelled('label refused');
      await releaseLabelled('restore'); await settle(); await tick(100); await settle();
      await releaseLabelled('label refused');
      await releaseAll(); fake.override = null; await tick(16_000); await settle();
      expect(labelOf('n1')).toBe('ClaudeName');
      sameAsNebula();
      while (store().undoStack.length) { await undo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).not.toBe('MINE'); }
      while (store().redoStack.length) { await redo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).not.toBe('MINE'); }
    });
  }
  it('N1b: a rename that landed after Claude renamed the held node leaves no name behind: a later refused rename goes back to the landed one', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    await deleteLanded('n1');
    nebula().holdAnswers = true;
    store().undo(); await settle();
    store().renameNode('n1', 'First'); await settle();
    agentDoes(claude, 'ed_n1bclaude00001', () => { nebula().nodes.get('n1')!.label = 'ClaudeName'; }); await settle();
    await releaseAll();
    await tick(16_000); await settle();
    sameAsNebula();
    const landed = labelOf('n1');
    fake.override = refuseLabel;
    nebula().holdAnswers = true;
    store().renameNode('n1', 'MINE'); await settle();
    await releaseAll(); fake.override = null;
    expect(labelOf('n1')).toBe(landed);
    sameAsNebula();
  });
  it('a refused rename the person\'s Delete captured: Undo of the Delete never writes it', async () => {
    two();
    fake.override = refuseLabel;
    nebula().holdAnswers = true;
    store().renameNode('n1', 'MINE'); await settle();
    expect(labelOf('n1')).toBe('MINE');
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await settle();
    await releaseAll(); fake.override = null;
    expect(nebula().ids()).toEqual(['n2']);
    await undo();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    expect(nebula().nodes.get('n1')?.label).toBe('n1');
    sameAsNebula();
  });
  it('an edit that took a held node off, synced twice, stays its removal: its Undo brings the node back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    queueOnSock();
    await deleteLanded('n1');
    sockHold = true;
    nebula().holdAnswers = true;
    store().undo(); await settle();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    agentQ(claude, 'ed_foldclaude0001', () => { nebula().nodes.delete('n1'); });
    agentQ(claude, 'ed_foldclaude0001', () => {});
    reconnectQ();
    await flush(sock.length);
    await releaseAll();
    sameAsNebula();
    expect(kinds()).toEqual(['F(Claude)']);
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    sameAsNebula();
  });
  it('a rename to the refused name itself, which Nebula takes, is the node\'s name: a refused Delete puts it back so', async () => {
    two();
    fake.override = refuseLabel;
    nebula().holdAnswers = true;
    store().renameNode('n1', 'MINE'); await settle();
    await releaseAll();
    expect(labelOf('n1')).toBe('n1');
    fake.override = null;
    store().renameNode('n1', 'MINE'); await settle(); await tick(100); await settle();
    expect(nebula().nodes.get('n1')?.label).toBe('MINE');
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    await releaseAll(); fake.override = null;
    expect(labelOf('n1')).toBe('MINE');
    sameAsNebula();
  });

  // ---- the clear's and the import's cleanup ----
  for (const how of ['clear', 'import', 'person'] as const) {
    it(`${how === 'person' ? 'the person\'s clear' : `an agent's ${how}`}: a refused rename of the old canvas's n1 is no name of the new n1`, async () => {
      two();
      fake.override = refuseLabel;
      nebula().holdAnswers = true;
      store().renameNode('n1', 'MINE'); await settle();
      await releaseAll();
      fake.override = null;
      expect(labelOf('n1')).toBe('n1');
      // Codex replaces the canvas; its new n1 is named MINE.
      nebula().request += 1;
      nebula().nodes = new Map([['n1', { ...textFakeNode('n1'), label: 'MINE' }]]);
      nebula().edges = [];
      if (how === 'person') {
        store().clearGraph();
        await settle();
        emit({ nodes: FakeNebula.syncNodes(snapGraph()), edges: [], empty: false, syncSeq: nebula().nextSyncSeq(), edit: { ...codex, id: 'ed_addcodex000002' } });
      } else if (how === 'clear') {
        fireOf({ nodes: [], edges: [] }, nebula().nextSyncSeq(), { ...codex, id: 'ed_clearcodex0001' })();
        await settle();
        emit({ nodes: FakeNebula.syncNodes(snapGraph()), edges: [], empty: false, syncSeq: nebula().nextSyncSeq(), edit: { ...codex, id: 'ed_addcodex000001' } });
      } else {
        emit({ nodes: FakeNebula.syncNodes(snapGraph()), edges: [], empty: false, graphReplaced: true, syncSeq: nebula().nextSyncSeq(), edit: { ...codex, id: 'ed_importcodex001' } });
      }
      await settle(); await tick(6000); await settle();
      expect(labelOf('n1')).toBe('MINE');
      refuseDelete('n1');
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
      await releaseAll(); fake.override = null;
      expect(labelOf('n1')).toBe('MINE');
      sameAsNebula();
    });
  }

  // ---- how an answer's wait ends ----
  /** The Undo of n1's Delete, answered, its echo held back on the socket. */
  const answeredEchoHeld = async () => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    sockHold = true;
    store().undo(); await settle(); await tick(50); await settle();
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    expect(sock.map((each) => each.label)).toEqual(['echo']);
  };
  it('the wait ends at the sync its answer names, not later: Codex\'s edit right after it shows at once', async () => {
    await answeredEchoHeld();
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(true);
    await flush(1);
    expect(await n1Free()).toBe(true);
    expect(kinds()).toContain('F(Codex)');
    sameAsNebula();
  });
  it('an answer whose sync has already come is handled at once (the echo before the answer)', async () => {
    two();
    queueOnSock();
    await deleteLanded('n1');
    nebula().holdAnswers = true;
    store().undo(); await settle();
    expect(sock).toHaveLength(0);
    await releaseAll();
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(false);
  });
  it('a later sync than the one named ends it too (the echo lost, Claude\'s next sync)', async () => {
    await answeredEchoHeld();
    dropSock('echo');
    sockHold = false;
    agentQ(claude, 'ed_laterclaude001', () => { nebula().nodes.get('n2')!.label = 'Claude'; }); await settle();
    expect(await n1Free()).toBe(true);
    sameAsNebula();
  });
  it('a restarted backend\'s first sync ends it, whatever its number', async () => {
    await answeredEchoHeld();
    dropSock('echo');
    sockHold = false;
    // The process the canvas knows, numbering below the answer's sync: no end.
    emit({ nodes: FakeNebula.syncNodes(snapGraph()), edges: [], empty: false, syncSeq: 1, bootId: 'r9-boot-a', bootStartedAt: 1 });
    await settle();
    expect(await n1HeldThroughStale(2)).toBe(true);
    // A new process, its number lower still: its first sync ends it.
    emit({ nodes: FakeNebula.syncNodes(snapGraph()), edges: [], empty: false, syncSeq: 1, bootId: 'r9-boot-b', bootStartedAt: 2 });
    await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(await n1HeldThroughStale(1)).toBe(false);
    reconnectQ(); await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    // Only that first sync: the next answer of the same process waits for its own.
    await deleteLanded('n1');
    expect(cliIds()).toEqual(['n2']);
    sockHold = true;
    store().undo(); await settle(); await tick(50); await settle();
    expect(sock.map((each) => each.label)).toEqual(['echo']);
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(true);
    await flush(1);
    expect(await n1Free()).toBe(true);
  });
  it('a sync with no number (Nebula read over HTTP) ends it', async () => {
    await answeredEchoHeld();
    dropSock('echo');
    sockHold = false;
    fireOf(snapGraph(), null)(); await settle();
    expect(await n1HeldThroughStale(lastEchoSeq - 1)).toBe(false);
  });
  it('another canvas opened while it waits: the new canvas\'s n1 is never held', async () => {
    await answeredEchoHeld();
    dropSock('echo');
    sockHold = false;
    store().loadGraph([canvasNode({ ...textFakeNode('n1'), params: { value: 'other' } })], []);
    await settle();
    nebula().reset([{ ...textFakeNode('n1'), params: { value: 'other' } }]);
    expect(await n1Free()).toBe(true);
  });

  // ---- review 8's generator, widened: 1-4 agents, every hold kind, four socket orders ----
  const ALL = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const nebState = () => JSON.stringify({ n: ALL.map((id) => [id, nebula().nodes.has(id), nebula().valueOf(id) ?? null, nebula().nodes.get(id)?.label ?? null]), w: nebula().wires() });
  const canvasState = () => JSON.stringify({ n: ALL.map((id) => [id, Boolean(nodeOf(id)), valueOf(id) ?? null, labelOf(id) ?? null]), w: cliWires() });
  const agentsAll = { codex, claude, gemini, grok } as const;
  type Who = keyof typeof agentsAll;
  const NAME: Record<Who, string> = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' };
  const rng = (seed: number) => { let s = (seed * 2654435761) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
  type Hold = 'restore' | 'refused' | 'mixedRestoreFirst' | 'mixedRefusedFirst' | 'deletePending';
  type Sock = 'direct' | 'answersFirst' | 'echoesFirst' | 'stale';
  const cleanup = async () => {
    delete (nebula() as unknown as { broadcast?: unknown }).broadcast; sock.length = 0; sockHold = false;
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer()) await settle();
    await settle();
    await tick(20_000);
    forgetHeldHistoryForTests();
    useGraphStore.setState(initialGraph, true);
    useUIStore.setState(initialUi, true);
  };
  const scenario = async (seed: number, hold: Hold, k: number, agentCount: number, mode: Sock) => {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const who: Who[] = (['codex', 'claude', 'gemini', 'grok'] as Who[]).slice(0, agentCount);
    const held = ALL.slice(0, k);
    const initialWires: FakeWire[] = [];
    for (let i = 0; i < 2; i += 1) {
      if (r() < 0.5) { const a = pick(ALL); const b = pick(ALL.filter((x) => x !== a)); if (!initialWires.some((w) => (w.source === a && w.target === b) || (w.source === b && w.target === a))) initialWires.push(wire(a, b)); }
    }
    start(ALL.map((id, i) => ({ ...textFakeNode(id), params: { value: `${id}v0` }, position: { x: 100 + 200 * i, y: 100 } })), initialWires);
    queueOnSock();
    const restoreIds = hold === 'restore' ? held : hold === 'refused' || hold === 'deletePending' ? [] : held.slice(0, Math.ceil(k / 2));
    const refusedIds = hold === 'restore' || hold === 'deletePending' ? [] : hold === 'refused' ? held : held.slice(Math.ceil(k / 2));
    // The person's Delete Nebula takes, its answer and echo on their way (MEDIUM-3).
    const deletingIds = hold === 'deletePending' ? held.slice(0, 1) : [];
    const overrides: Array<(path: string, init?: RequestInit) => Promise<Response> | null> = [];
    fake.override = (path, init) => { for (const o of overrides) { const got = o(path, init); if (got) return got; } return null; };
    let openGate: () => void = () => {};
    const desc: string[] = [];
    const order: string[] = [];
    const whoOf: string[] = [];
    const states: string[] = [];
    let staleLeft = 0;
    const staleSet = new Set<string>();
    const heldOn = () => JSON.stringify([...restoreIds, ...deletingIds].map((x) => nebula().nodes.has(x)));
    if (restoreIds.length) {
      store().onNodesChange(restoreIds.map((id) => ({ id, type: 'remove' as const })));
      await settle(); await tick(6000); await settle();
      if (mode !== 'direct') sockHold = true;
      nebula().holdAnswers = true;
      if (mode === 'stale') {
        const gate = new Promise<void>((resolve) => { openGate = resolve; });
        let once = true;
        overrides.push((path, init) => (path === '/api/graph/restore' && once ? (once = false, gate.then(() => fake.backend.apiFetch(path, init))) : null));
        staleLeft = 1 + Math.floor(r() * 2);
      }
      store().undo();
      await settle();
    }
    if (refusedIds.length) {
      overrides.push((path, init) => (init?.method === 'DELETE' && refusedIds.some((id) => path === `/api/graph/node/${id}`)
        ? nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null));
      if (mode !== 'direct') sockHold = true;
      nebula().holdAnswers = true;
      store().onNodesChange(refusedIds.map((id) => ({ id, type: 'remove' as const })));
      await tick(5);
    }
    if (deletingIds.length) {
      if (mode !== 'direct') sockHold = true;
      nebula().holdAnswers = true;
      if (mode === 'stale') {
        // Agent syncs read before Nebula applied the Delete: the Delete's request waits.
        const gate = new Promise<void>((resolve) => { openGate = resolve; });
        let once = true;
        overrides.push((path, init) => (init?.method === 'DELETE' && once ? (once = false, gate.then(() => fake.backend.apiFetch(path, init))) : null));
        staleLeft = 1 + Math.floor(r() * 2);
      }
      store().onNodesChange(deletingIds.map((id) => ({ id, type: 'remove' as const })));
      await tick(5);
    }
    let renamed = false;
    if (restoreIds.length && r() < 0.4) {
      overrides.push((path, init) => (init?.method === 'PUT' && /\/label$/.test(path)
        ? nebula().later('label refused', () => new Response(JSON.stringify({ detail: 'No.' }), { status: 500 })) : null));
      store().renameNode(restoreIds[0], 'MINE'); await settle();
      renamed = true; desc.push(`person:refused rename ${restoreIds[0]}`);
    }
    states.push(nebState());
    const count = 3 + Math.floor(r() * 6);
    let freeDeleted = false;
    const deletedHeld = new Set<string>();
    const gated = restoreIds.length > 0 || deletingIds.length > 0;
    for (let i = 0; i < count; i += 1) {
      if (mode === 'stale' && staleLeft === 0 && gated) { openGate(); await settle(); openGate = () => {}; staleLeft = -1; states[states.length - 1] = nebState(); desc.push('(applied)'); }
      if (mode === 'stale' && staleLeft > 0) staleLeft -= 1;
      const present = ALL.filter((id) => nebula().nodes.has(id));
      const heldPresent = held.filter((id) => nebula().nodes.has(id) && !deletedHeld.has(id));
      if (heldPresent.length === 0) break;
      if (r() < 0.12) { reconnectQ(); await settle(); desc.push('reconnect'); continue; }
      const agent = pick(who);
      const k2 = r();
      const a = r() < 0.75 ? pick(heldPresent) : pick(present);
      const id = `ed_g${seed}x${String(i).padStart(2, '0')}${'x'.repeat(8)}`;
      let change: () => void; let d: string;
      const unwired = present.filter((b) => b !== a && !nebula().edges.some((w) => (w.source === a && w.target === b) || (w.source === b && w.target === a)));
      const touching = nebula().edges.filter((w) => heldPresent.includes(w.source) || heldPresent.includes(w.target));
      if (k2 < 0.22 && unwired.length) { const b = pick(unwired); change = () => { nebula().edges.push(wire(a, b)); }; d = `connect ${a}>${b}`; }
      else if (k2 < 0.32 && touching.length) { const w = pick(touching); change = () => { nebula().edges = nebula().edges.filter((e) => e !== w); }; d = `disconnect ${w.source}>${w.target}`; }
      else if (k2 < 0.42 && unwired.length) { const b = pick(unwired); change = () => { nebula().nodes.get(a)!.params = { value: `${agent}${i}` }; nebula().edges.push(wire(b, a)); }; d = `combo ${a}=v,${b}>${a}`; }
      else if (k2 < 0.47 && !freeDeleted && present.some((x) => !held.includes(x))) {
        const f = pick(present.filter((x) => !held.includes(x))); freeDeleted = true;
        change = () => { nebula().nodes.delete(f); nebula().edges = nebula().edges.filter((e) => e.source !== f && e.target !== f); }; d = `delete free ${f}`;
      } else if (k2 < 0.52 && restoreIds.some((x) => heldPresent.includes(x)) && heldPresent.length > 1 && deletedHeld.size === 0 && staleLeft <= 0) {
        const h = pick(restoreIds.filter((x) => heldPresent.includes(x))); deletedHeld.add(h);
        change = () => { nebula().nodes.delete(h); nebula().edges = nebula().edges.filter((e) => e.source !== h && e.target !== h); }; d = `delete held ${h}`;
      } else if (k2 < 0.76) { change = () => { nebula().nodes.get(a)!.params = { value: `${agent}${i}` }; }; d = `value ${a}`; }
      else if (renamed && a === restoreIds[0]) { change = () => { nebula().nodes.get(a)!.params = { value: `${agent}${i}` }; }; d = `value ${a}`; }
      else { change = () => { nebula().nodes.get(a)!.label = `${agent}L${i}`; }; d = `rename ${a}`; }
      const isStale = mode === 'stale' && staleLeft >= 0 && gated;
      if (isStale) staleSet.add(id);
      agentQ(agentsAll[agent], id, change);
      await settle();
      order.push(id); whoOf.push(NAME[agent]); desc.push(`${agent}:${d}${isStale ? ' (stale)' : ''}`);
      states.push(nebState());
    }
    if (mode === 'stale' && staleLeft >= 0) { openGate(); await settle(); states[states.length - 1] = nebState(); desc.push('(applied last)'); }
    if (renamed) await releaseLabelled('label refused');
    if (mode === 'answersFirst' || mode === 'stale') {
      if (hold === 'mixedRestoreFirst') { await releaseLabelled('restore'); await releaseLabelled('refused'); }
      if (hold === 'mixedRefusedFirst') { await releaseLabelled('refused'); await releaseLabelled('restore'); }
      nebula().holdAnswers = false; while (nebula().releaseAnswer()) await settle();
      await settle(); await tick(50);
      sockHold = false; while (sock.length) { sock.shift()!.fire(); await settle(); }
    } else {
      sockHold = false; while (sock.length) { sock.shift()!.fire(); await settle(); }
      if (hold === 'mixedRestoreFirst') { await releaseLabelled('restore'); await releaseLabelled('refused'); }
      if (hold === 'mixedRefusedFirst') { await releaseLabelled('refused'); await releaseLabelled('restore'); }
    }
    await releaseAll();
    await tick(16_000); await settle();
    const problems: string[] = [];
    if (canvasState() !== nebState()) problems.push(`end canvas ${canvasState()} != nebula ${nebState()}`);
    if (r() < 0.25) {
      const id = `ed_g${seed}clear${'x'.repeat(8)}`;
      agentQ(agentsAll[who[0]], id, () => { nebula().nodes.clear(); nebula().edges = []; });
      await settle(); await tick(6000); await settle();
      order.push(id); whoOf.push(NAME[who[0]]); desc.push(`${who[0]}:clear`); states.push(nebState());
      if (canvasState() !== nebState()) problems.push(`after clear canvas ${canvasState()} != nebula ${nebState()}`);
    }
    const foreign = () => store().undoStack.filter((e) => (e as { kind?: string }).kind === 'foreign');
    const editIds = foreign().map((e) => (e as { editId?: string }).editId);
    // With the person's Delete on the stack (deletePending), one step each,
    // in any order: an edit of the deleted node read before Nebula applied
    // the Delete is carried under the Delete's step (GM PR #205 r4 item 1),
    // while an earlier edit of other nodes landed above it when it came.
    const sameSteps = deletingIds.length > 0
      ? JSON.stringify([...editIds].sort()) === JSON.stringify([...order].sort())
      : JSON.stringify(editIds) === JSON.stringify(order);
    if (!sameSteps) problems.push(`steps ${JSON.stringify(editIds)} != order ${JSON.stringify(order)}`);
    const agentSteps = foreign().length;
    const sawMine = () => [...nebula().nodes.values()].some((n) => n.label === 'MINE');
    // The person's Delete on the stack (deletePending): undone in its turn;
    // then each agent step is checked only for leaving the person's node be.
    const ownToo = deletingIds.length > 0;
    for (let s = 1; s <= agentSteps; s += 1) {
      let top = store().undoStack.at(-1) as { editId?: string; kind?: string };
      if (ownToo && top && top.kind !== 'foreign') {
        await undo();
        if (canvasState() !== nebState()) problems.push(`U own canvas ${canvasState()} != nebula ${nebState()}`);
        top = store().undoStack.at(-1) as { editId?: string; kind?: string };
      }
      if (top?.kind !== 'foreign') { problems.push(`U${s} top is ${top?.kind}`); break; }
      const heldBefore = heldOn();
      await undo();
      const at = order.indexOf(top.editId ?? '');
      if (canvasState() !== nebState()) problems.push(`U${s} canvas ${canvasState()} != nebula ${nebState()}`);
      if (ownToo || staleSet.has(top.editId ?? '')) { if (heldOn() !== heldBefore) problems.push(`U${s} (stale ${top.editId}) changed the person's nodes ${heldBefore} -> ${heldOn()}`); }
      else if (at >= 0 && nebState() !== states[at]) problems.push(`U${s} (${order[at]}) ${nebState()} != before it ${states[at]}`);
      if (at >= 0 && notice() !== `Undid ${whoOf[at]}’s edit.`) problems.push(`U${s} line ${notice()} for ${whoOf[at]}`);
      if (sawMine()) problems.push(`U${s} Nebula has the refused name`);
    }
    for (let s = 1; s <= agentSteps; s += 1) {
      let next = store().redoStack.at(-1) as { editId?: string; kind?: string };
      if (ownToo && next && next.kind !== 'foreign') {
        await redo();
        if (canvasState() !== nebState()) problems.push(`R own canvas ${canvasState()} != nebula ${nebState()}`);
        next = store().redoStack.at(-1) as { editId?: string; kind?: string };
      }
      if (!next) { problems.push(`R${s} nothing to redo`); break; }
      const heldBefore = heldOn();
      await redo();
      const at = order.indexOf(next.editId ?? '');
      if (canvasState() !== nebState()) problems.push(`R${s} canvas ${canvasState()} != nebula ${nebState()}`);
      if (ownToo || staleSet.has(next.editId ?? '')) { if (heldOn() !== heldBefore) problems.push(`R${s} (stale ${next.editId}) changed the person's nodes ${heldBefore} -> ${heldOn()}`); }
      else if (at >= 0 && nebState() !== states[at + 1]) problems.push(`R${s} (${order[at]}) ${nebState()} != after it ${states[at + 1]}`);
      if (at >= 0 && notice() !== `Redid ${whoOf[at]}’s edit.`) problems.push(`R${s} line ${notice()} for ${whoOf[at]}`);
      if (sawMine()) problems.push(`R${s} Nebula has the refused name`);
    }
    return { problems, desc, initialWires: initialWires.map((w) => `${w.source}>${w.target}`) };
  };
  const SEEDS = Number(process.env.NEBULA_HELD_GEN_SEEDS ?? 8);
  // One scenario again, by the seed a failure names (sd).
  const ONLY = Number(process.env.NEBULA_HELD_GEN_ONLY ?? 0);
  const holds: Hold[] = ['refused', 'restore', 'mixedRestoreFirst', 'mixedRefusedFirst', 'deletePending'];
  const modes: Sock[] = ['direct', 'answersFirst', 'echoesFirst', 'stale'];
  for (const mode of modes) {
    for (const hold of holds) {
      if (mode === 'stale' && hold === 'refused') continue;
      it(`the generator, ${mode}, ${hold}: canvas = Nebula after every step; each Undo and Redo changes only its own edit`, async () => {
        const failures: string[] = [];
        for (let seed = 1; seed <= SEEDS; seed += 1) {
          const k = 2 + (seed % 3);
          const agentCount = 1 + (seed % 4);
          const sd = seed * 1000 + k * 10 + holds.indexOf(hold) + 100 * modes.indexOf(mode);
          if (ONLY && sd !== ONLY) continue;
          let out: { problems: string[]; desc: string[]; initialWires: string[] };
          try { out = await scenario(sd, hold, k, agentCount, mode); } catch (e) { out = { problems: [`threw ${String(e).slice(0, 300)}`], desc: [], initialWires: [] }; }
          if (out.problems.length) failures.push(`seed ${sd} k=${k} agents=${agentCount} init=${JSON.stringify(out.initialWires)} ops=${JSON.stringify(out.desc)}: ${out.problems.slice(0, 3).join(' | ')}`);
          await cleanup();
          vi.setSystemTime(Date.now() + 600_000);
        }
        expect(failures).toEqual([]);
      }, 900_000);
    }
  }
});
