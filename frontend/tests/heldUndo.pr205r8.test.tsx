import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 8: review 7 of the held Undo (held-undo-order report).
// - HIGH-1 (W9, W9b): a restore whose echo trails its answer, an agent's sync
//   between that lacks the node: the canvas keeps it, and every Undo and Redo
//   after leaves the canvas as Nebula has it.
// - MEDIUM-1 (F1): one agent edit to a node a restore holds and to a node a
//   refused Delete holds is one step; its Undo takes back both changes.
// - MEDIUM-2 (F2, F3, the generator's "delete held"): an agent's edit that
//   took a held node off is that edit's removal, and its Undo brings it back
//   with its connections.
// - LOW-1 (X1, L1a, L1b): a refused rename never reaches Nebula through an
//   earlier held copy, a Delete's put-back, or an agent step's Redo.
// - GM r16 item 4 (X2): an agent's clear during a Delete on its way: the
//   clear's Undo brings the node back as Nebula had it, with the other
//   agent's edit.
// - LOW-3 (W1, W3b): the wait for an unanswered save ends at the 15 s cap.
// The harness is round 7's (round 18's fake Nebula).

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
  expect(wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)))).toEqual(nebula().wires());
};
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const codex = { actor: { kind: 'agent', name: 'Codex', id: 'codex' } };
const claude = { actor: { kind: 'agent', name: 'Claude', id: 'claude' } };
const wire = (source: string, target: string): FakeWire => ({ id: `w-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text' });
let clock = Date.now();

describe("PR #205 round 8: the held Undo after review 7", () => {
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
  const start = (nodes: FakeNode[], edges: FakeWire[] = [], chosen: string[] = []) => {
    nebula().reset(nodes, edges);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, chosen.includes(node.id) ? { selected: true } : {})),
      edges: edges.map((edge) => ({ ...edge, type: 'typed-edge', data: { dataType: 'Text' } })) as Edge[],
      isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** Nebula changes its graph for an agent and syncs all of it (the agent's edit). */
  const agentDoes = (who: Record<string, unknown>, id: string, change: () => void, extra: Record<string, unknown> = {}) => {
    nebula().request += 1;
    change();
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
      empty: nebula().nodes.size === 0, ...extra, edit: { ...who, id } });
  };
  const n1 = () => nebula().nodes.get('n1')!;

  /** Delete n1 and undo it, the restore's answer held after Nebula applied it. */
  const restoreHeld = async () => {
    store().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await settle(); await tick(6000); await settle();
    expect(cliIds()).not.toContain('n1');
    nebula().holdAnswers = true;
    store().undo();
    await settle();
    expect(cliIds()).toContain('n1');
  };
  const releaseAll = async () => {
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  const refuseDelete = (id = 'n1') => {
    fake.override = (path, init) => (init?.method === 'DELETE' && path === `/api/graph/node/${id}`
      ? nebula().later(`refused ${id}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
      : null);
  };

  const gemini = { actor: { kind: 'agent', name: 'Gemini', id: 'gemini' } };
  const releaseLabelled = async (prefix: string) => {
    const at = nebula().answers.findIndex((answer) => answer.label.startsWith(prefix));
    if (at >= 0) { nebula().releaseAnswer(at); await settle(); }
    return at >= 0;
  };

  const kinds = () => store().undoStack.map((entry) => { const e = entry as { kind?: string; agentName?: string };
    return e.kind === 'foreign' ? `F(${e.agentName})` : e.kind === 'own-add' ? 'add' : 'own'; });

  const restoresSent = () => nebula().calls.filter((call) => call.path === '/api/graph/restore').length;
  const linesSeen: string[] = [];
  let unsub: (() => void) | null = null;
  const recordLines = () => { linesSeen.length = 0; unsub?.(); unsub = useGraphStore.subscribe((s) => {
    for (const t of [s.undoNotice?.text, s.messageNotice?.text, (s as { lateNotice?: { text?: string } | null }).lateNotice?.text]) if (t && linesSeen.at(-1) !== t) linesSeen.push(t); }); };
  const failLines = () => linesSeen.filter((t) => /Couldn’t|Nothing was|isn’t answering|not saved/i.test(t));
  /** A write Nebula applies when it arrives, whose answer waits until let go (or never). */
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
  const typeInto = async (id: string, value: string) => {
    store().updateNodeData(id, { params: { ...nodeOf(id)!.data.params, value } });
    await tick(1100); await settle();
  };
  const deleteLanded = async (id: string) => {
    store().onNodesChange([{ id, type: 'remove' }]);
    await settle(); await tick(6000); await settle();
  };
  const isPut = (id: string) => (path: string, init?: RequestInit) => init?.method === 'PUT' && path === `/api/graph/node/${id}`;

  const snap = () => ({ canvas: cliIds(), nebula: nebula().ids(), v2: nebula().valueOf('n2') ?? null, w: nebula().wires() });
  /** Undo every agent step, checking the canvas is Nebula after each. */
  const walk = async () => {
    const out: Array<Record<string, unknown>> = [{ kinds: kinds(), ...snap() }];
    while (store().undoStack.some((e) => (e as { kind?: string }).kind === 'foreign')) { await undo(); sameAsNebula(); out.push({ u: notice(), ...snap() }); }
    return out;
  };

  it('W1: an earlier save never answered: the Undo of a Delete waits 15 s, then goes; nothing lost or doubled', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    recordLines();
    const release = hangPut(isPut('n2'));
    await typeInto('n2', 'typed');
    await deleteLanded('n1');
    store().undo();
    await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    await tick(14_000); await settle();
    expect(restoresSent()).toBe(0);
    await tick(1_200); await settle();
    expect(restoresSent()).toBe(1);
    sameAsNebula();
    release(); await settle(); await tick(6000); await settle();
    sameAsNebula();
    expect(failLines()).toEqual([]);
    await redo(); sameAsNebula(); expect(cliIds()).toEqual(['n2']);
    await undo(); sameAsNebula(); expect(cliIds()).toEqual(['n1', 'n2']);
  });

  it('W3b: two restores while the save never answers: the second waits behind the first, both land within two caps', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, { ...textFakeNode('n3'), params: { value: 'x0' } }]);
    recordLines();
    const release = hangPut(isPut('n2'));
    await typeInto('n2', 'typed');
    await deleteLanded('n1');
    await deleteLanded('n3');
    const t0 = Date.now();
    store().undo(); await settle();
    store().undo(); await settle();
    const times: number[] = [];
    for (let i = 0; i < 400 && times.length < 2; i += 1) { await tick(100); if (restoresSent() > times.length) times.push(Date.now() - t0); }
    await settle(); await tick(6000); await settle();
    expect(times).toHaveLength(2);
    expect(times[1]).toBeLessThan(31_000);
    sameAsNebula();
    release(); await settle(); await tick(6000); await settle();
    sameAsNebula();
    expect(failLines()).toEqual([]);
  });

  const trailingEcho = async (viaWait: boolean) => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    let release: () => void = () => {};
    let restoreArrives: () => void = () => {};
    if (viaWait) release = hangPut(isPut('n2'));
    await typeInto('n2', 'typed');
    await deleteLanded('n1');
    if (!viaWait) {
      const gate = new Promise<void>((resolve) => { restoreArrives = resolve; });
      fake.override = (path, init) => (path === '/api/graph/restore' ? gate.then(() => fake.backend.apiFetch(path, init)) : null);
    }
    store().undo(); await settle();
    // Claude renames n2 before Nebula has the restore: its sync lacks n1.
    agentDoes(claude, viaWait ? 'ed_r8w9claude0001' : 'ed_r8w9bclaude001', () => { nebula().nodes.get('n2')!.label = 'Claude'; });
    await settle();
    // The restore arrives; its echo trails its answer for a moment.
    nebula().holdEchoes = true;
    if (viaWait) release(); else restoreArrives();
    await settle(); await tick(100); await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(nebula().ids()).toEqual(['n1', 'n2']);
    nebula().holdEchoes = false; nebula().deliverEchoes(); await settle(); await tick(6000); await settle();
    fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['own', 'F(Claude)']);
    const lines: Array<string | null> = [];
    while (store().undoStack.length) { await undo(); sameAsNebula(); lines.push(notice()); expect(cliIds()).toEqual(['n1', 'n2']); }
    expect(lines[0]).toBe('Undid Claude’s edit.');
    expect(nebula().nodes.get('n2')?.label).toBe('n2');
    while (store().redoStack.length) { await redo(); sameAsNebula(); expect(cliIds()).toEqual(['n1', 'n2']); }
    expect(notice()).toBe('Redid Claude’s edit.');
    expect(nebula().nodes.get('n2')?.label).toBe('Claude');
  };
  it('W9: the wait; Claude\'s sync during it lacks n1 and the restore\'s echo trails its answer: Undo and Redo agree with Nebula', async () => {
    await trailingEcho(true);
  });
  it('W9b: the same with a slow restore and no wait', async () => {
    await trailingEcho(false);
  });

  it('F1: a restore hold on n1, a refused Delete of n2 behind it; Claude sets n1 and connects n1>n2 in one edit: one step, one Undo', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
    await restoreHeld();
    refuseDelete('n2');
    store().onNodesChange([{ id: 'n2', type: 'remove' }]);
    await tick(5);
    agentDoes(claude, 'ed_r8f1claude0001', () => { n1().params = { value: 'CLAUDE' }; nebula().edges.push(wire('n1', 'n2')); });
    await settle();
    await releaseAll();
    fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Claude)']);
    const out = await walk();
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ u: 'Undid Claude’s edit.', nebula: ['n1', 'n2', 'n3'], w: [] });
    expect(nebula().valueOf('n1')).toBe('v0');
  });

  it('F2: a restore hold; Claude deletes the node it brought back, then Codex sets n2: Codex\'s Undo leaves n1 off, Claude\'s brings it back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    await restoreHeld();
    agentDoes(claude, 'ed_r8f2claude0001', () => { nebula().nodes.delete('n1'); });
    await settle();
    agentDoes(codex, 'ed_r8f2codex00001', () => { nebula().nodes.get('n2')!.params = { value: 'CODEX' }; });
    await settle();
    await releaseAll();
    sameAsNebula();
    const out = await walk();
    expect(out[0]).toMatchObject({ kinds: ['F(Claude)', 'F(Codex)'], nebula: ['n2'] });
    expect(out[1]).toMatchObject({ u: 'Undid Codex’s edit.', nebula: ['n2'], v2: 'w0' });
    expect(out[2]).toMatchObject({ u: 'Undid Claude’s edit.', nebula: ['n1', 'n2'] });
  });

  it('F3: a refused Delete of n1 (connected to n2); Claude deletes n2: Claude\'s Undo brings n2 back with its connection', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }], [wire('n1', 'n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await tick(5);
    agentDoes(claude, 'ed_r8f3claude0001', () => { nebula().nodes.delete('n2'); nebula().edges = []; });
    await settle();
    await releaseAll();
    fake.override = null;
    sameAsNebula();
    const out = await walk();
    expect(out[0]).toMatchObject({ kinds: ['F(Claude)'], nebula: ['n1'] });
    expect(out[1]).toMatchObject({ u: 'Undid Claude’s edit.', nebula: ['n1', 'n2'], w: ['n1>n2'] });
  });

  it('X1: a refused rename, a refused Delete, and two agent edits: Nebula never gets the refused name, through any Undo or Redo', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    fake.override = (path, init) => {
      if (init?.method === 'DELETE' && path === '/api/graph/node/n1') return nebula().later('refused n1', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }));
      if (init?.method === 'PUT' && path === '/api/graph/node/n1/label') return nebula().later('label refused', () => new Response(JSON.stringify({ detail: 'No.' }), { status: 500 }));
      return null;
    };
    nebula().holdAnswers = true;
    store().renameNode('n1', 'Mine'); await settle();
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r8x1codex00001', () => { n1().params = { value: 'CODEX' }; }); await settle();
    agentDoes(gemini, 'ed_r8x1gemini0001', () => { n1().params = { value: 'GEMINI' }; }); await settle();
    await releaseLabelled('label refused'); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Codex)', 'F(Gemini)']);
    const labels: Array<string | undefined> = [nebula().nodes.get('n1')?.label, labelOf('n1')];
    const values: unknown[] = [];
    while (store().undoStack.some((e) => (e as { kind?: string }).kind === 'foreign')) { await undo(); sameAsNebula(); labels.push(nebula().nodes.get('n1')?.label); values.push(nebula().valueOf('n1')); }
    while (store().redoStack.length) { await redo(); sameAsNebula(); labels.push(nebula().nodes.get('n1')?.label); values.push(nebula().valueOf('n1')); }
    expect(labels.filter((label) => label === 'Mine')).toEqual([]);
    expect(values).toEqual(['CODEX', 'v0', 'CODEX', 'GEMINI']);
  });

  it('X2 (GM r16 item 4): an agent clears the canvas while the person\'s Delete of n1 is on its way and Codex edited n1: the clear\'s Undo brings n1 back as Nebula had it', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r8x2codex00001', () => { n1().params = { value: 'CODEX' }; }); await settle();
    agentDoes(claude, 'ed_r8x2claude0001', () => { nebula().nodes.clear(); nebula().edges.length = 0; }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(cliIds()).toEqual([]);
    expect((store().undoStack.at(-1) as { agentName?: string }).agentName).toBe('Claude');
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    sameAsNebula();
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(nebula().valueOf('n1')).toBe('CODEX');
    await redo();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
  });

  it('P-B\'s empty path: Claude deletes the only node, which a restore holds (a sync that empties the canvas, not a clear): its Undo brings it back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }]);
    await restoreHeld();
    // Nebula names the same canvas: an agent's delete, not a clear.
    agentDoes(claude, 'ed_r8pbclaude0001', () => { nebula().nodes.delete('n1'); }, { canvasRevision: 'canvas-1' });
    await settle();
    await releaseAll();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
    expect(kinds()).toEqual(['F(Claude)']);
    await undo();
    expect(notice()).toBe('Undid Claude’s edit.');
    sameAsNebula();
    expect(cliIds()).toEqual(['n1']);
    await redo();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
  });

  it('P-B\'s empty path, a refused Delete: Codex edits n1, Claude then deletes n1 and n2 (not a clear): the steps in Nebula\'s order, each Undo as Nebula', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r8pb2codex0001', () => { n1().params = { value: 'CODEX' }; }, { canvasRevision: 'canvas-1' }); await settle();
    agentDoes(claude, 'ed_r8pb2claude001', () => { nebula().nodes.clear(); }, { canvasRevision: 'canvas-1' }); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    const seen: unknown[] = [kinds()];
    while (store().undoStack.some((e) => (e as { kind?: string }).kind === 'foreign')) { await undo(); sameAsNebula(); seen.push([notice(), cliIds(), nebula().valueOf('n1') ?? null]); }
    // Claude's sync without n1 says the person's Delete is done in Nebula
    // (whatever its answer): it is the person's step, with Codex's copy, and
    // Claude's took off n2 only.
    expect(seen).toEqual([['F(Codex)', 'own', 'F(Claude)'], ['Undid Claude’s edit.', ['n2'], null],
      ['Restored the node.', ['n1', 'n2'], 'CODEX'], ['Undid Codex’s edit.', ['n1', 'n2'], 'v0']]);
  });

  it('a restore waiting on its echo when another project opens: the hold ends with that canvas, so the new canvas\'s n1 is never held', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    await deleteLanded('n1');
    nebula().holdEchoes = true;
    store().undo(); await settle(); await tick(100); await settle();
    expect(cliIds()).toEqual(['n1', 'n2']);
    // Another project opens (its own n1 and n2); the old canvas's echo never comes.
    nebula().echoes = [];
    nebula().holdEchoes = false;
    nebula().reset([{ ...textFakeNode('n1'), params: { value: 'other' } }, textFakeNode('n2')]);
    store().loadProjectGraph([canvasNode({ ...textFakeNode('n1'), params: { value: 'other' } }), canvasNode(textFakeNode('n2'))], [], []);
    await settle();
    // Codex deletes the new n1: the canvas follows Nebula.
    agentDoes(codex, 'ed_r8echoforget01', () => { nebula().nodes.delete('n1'); });
    await settle();
    expect(cliIds()).toEqual(['n2']);
    sameAsNebula();
  });

  const renameRefusal = (status: number) => (path: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && path === '/api/graph/node/n1/label') {
      return nebula().later('label refused', () => status).then((code) => new Response(JSON.stringify({ detail: 'No.' }), { status: code }));
    }
    return null;
  };
  it('L1a: the refused Delete answers before the rename\'s refusal: no trace of the name in the canvas, Nebula, or Codex\'s Undo and Redo', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    const lab = renameRefusal(500);
    fake.override = (path, init) => {
      if (init?.method === 'DELETE' && path === '/api/graph/node/n1') return nebula().later('refused n1', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }));
      return lab(path, init);
    };
    nebula().holdAnswers = true;
    store().renameNode('n1', 'Mine'); await settle();
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r8l1acodex0001', () => { n1().params = { value: 'CODEX' }; });
    await settle();
    await releaseLabelled('refused'); await settle();
    await releaseLabelled('label refused'); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(labelOf('n1')).toBe('n1');
    await undo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).toBe('n1');
    await redo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).toBe('n1');
  });

  it('L1b: a restore hold, the rename on its way at Codex\'s sync, the restore answers, then the rename is refused: Codex\'s Redo never writes it', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    await restoreHeld();
    fake.override = renameRefusal(500);
    store().renameNode('n1', 'Mine'); await settle();
    agentDoes(codex, 'ed_r8l1bcodex0001', () => { n1().params = { value: 'CODEX' }; });
    await settle();
    await releaseLabelled('restore'); await settle(); await tick(100); await settle();
    await releaseLabelled('label refused'); await settle();
    await releaseAll(); fake.override = null;
    sameAsNebula();
    expect(kinds()).toEqual(['F(Codex)']);
    await undo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).toBe('n1');
    await redo(); sameAsNebula(); expect(nebula().nodes.get('n1')?.label).toBe('n1');
  });

  // The generator's "delete held": an agent deletes a node a restore brought
  // back, among other edits. Each Undo leaves Nebula as before that edit.
  const ALL = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const nebState = () => JSON.stringify({ n: ALL.map((id) => [id, nebula().nodes.has(id), nebula().valueOf(id) ?? null, nebula().nodes.get(id)?.label ?? null]), w: nebula().wires() });
  const canvasState = () => JSON.stringify({ n: ALL.map((id) => [id, Boolean(nodeOf(id)), valueOf(id) ?? null, labelOf(id) ?? null]), w: wires().filter((x) => x.split('>').every((e) => CLI.test(e))) });
  const agentsAll = { codex, claude, gemini } as const;
  type Who = keyof typeof agentsAll;
  const NAME: Record<Who, string> = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const rng = (seed: number) => { let s = (seed * 2654435761) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
  type Hold = 'restore' | 'refused' | 'mixedRestoreFirst' | 'mixedRefusedFirst';
  const cleanup = async () => {
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
  const scenario = async (seed: number, hold: Hold, k: number, agentCount: number) => {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const who: Who[] = (['codex', 'claude', 'gemini'] as Who[]).slice(0, agentCount);
    const held = ALL.slice(0, k);
    const initialWires: FakeWire[] = [];
    for (let i = 0; i < 2; i += 1) {
      if (r() < 0.5) { const a = pick(ALL); const b = pick(ALL.filter((x) => x !== a)); if (!initialWires.some((w) => (w.source === a && w.target === b) || (w.source === b && w.target === a))) initialWires.push(wire(a, b)); }
    }
    start(ALL.map((id, i) => ({ ...textFakeNode(id), params: { value: `${id}v0` }, position: { x: 100 + 200 * i, y: 100 } })), initialWires);
    // begin
    const restoreIds = hold === 'restore' ? held : hold === 'refused' ? [] : held.slice(0, Math.ceil(k / 2));
    const refusedIds = hold === 'restore' ? [] : hold === 'refused' ? held : held.slice(Math.ceil(k / 2));
    if (restoreIds.length) {
      store().onNodesChange(restoreIds.map((id) => ({ id, type: 'remove' as const })));
      await settle(); await tick(6000); await settle();
      nebula().holdAnswers = true;
      store().undo();
      await settle();
    }
    if (refusedIds.length) {
      fake.override = (path, init) => (init?.method === 'DELETE' && refusedIds.some((id) => path === `/api/graph/node/${id}`)
        ? nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null);
      nebula().holdAnswers = true;
      store().onNodesChange(refusedIds.map((id) => ({ id, type: 'remove' as const })));
      await tick(5);
    }
    const states = [nebState()];
    const order: string[] = [];
    const whoOf: string[] = [];
    const desc: string[] = [];
    const count = 3 + Math.floor(r() * 6);
    let freeDeleted = false;
    const deletedHeld = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      const present = ALL.filter((id) => nebula().nodes.has(id));
      const heldPresent = held.filter((id) => nebula().nodes.has(id) && !deletedHeld.has(id));
      if (heldPresent.length === 0) break;
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
      } else if (k2 < 0.52 && restoreIds.some((x) => heldPresent.includes(x)) && heldPresent.length > 1 && deletedHeld.size === 0) {
        const h = pick(restoreIds.filter((x) => heldPresent.includes(x))); deletedHeld.add(h);
        change = () => { nebula().nodes.delete(h); nebula().edges = nebula().edges.filter((e) => e.source !== h && e.target !== h); }; d = `delete held ${h}`;
      } else if (k2 < 0.76) { change = () => { nebula().nodes.get(a)!.params = { value: `${agent}${i}` }; }; d = `value ${a}`; }
      else { change = () => { nebula().nodes.get(a)!.label = `${agent}L${i}`; }; d = `rename ${a}`; }
      agentDoes(agentsAll[agent], id, change);
      await settle();
      order.push(id); whoOf.push(NAME[agent]); desc.push(`${agent}:${d}`);
      states.push(nebState());
    }
    if (hold === 'mixedRestoreFirst') { await releaseLabelled('restore'); await releaseLabelled('refused'); }
    if (hold === 'mixedRefusedFirst') { await releaseLabelled('refused'); await releaseLabelled('restore'); }
    await releaseAll();
    fake.override = null;
    const problems: string[] = [];
    if (canvasState() !== nebState()) problems.push(`end canvas ${canvasState()} != nebula ${nebState()}`);
    const foreign = () => store().undoStack.filter((e) => (e as { kind?: string }).kind === 'foreign');
    const editIds = foreign().map((e) => (e as { editId?: string }).editId);
    if (JSON.stringify(editIds) !== JSON.stringify(order)) problems.push(`steps ${JSON.stringify(editIds)} != order ${JSON.stringify(order)}`);
    const agentSteps = foreign().length;
    for (let s = 1; s <= agentSteps; s += 1) {
      const top = store().undoStack.at(-1) as { editId?: string; kind?: string };
      if (top?.kind !== 'foreign') { problems.push(`U${s} top is ${top?.kind}`); break; }
      await undo();
      const at = order.indexOf(top.editId ?? '');
      if (canvasState() !== nebState()) problems.push(`U${s} canvas ${canvasState()} != nebula ${nebState()}`);
      if (at >= 0 && nebState() !== states[at]) problems.push(`U${s} (${desc[at]}) ${nebState()} != before it ${states[at]}`);
      if (at >= 0 && notice() !== `Undid ${whoOf[at]}’s edit.`) problems.push(`U${s} line ${notice()} for ${whoOf[at]}`);
    }
    for (let s = 1; s <= agentSteps; s += 1) {
      const next = store().redoStack.at(-1) as { editId?: string };
      if (!next) { problems.push(`R${s} nothing to redo`); break; }
      await redo();
      const at = order.indexOf(next.editId ?? '');
      if (canvasState() !== nebState()) problems.push(`R${s} canvas ${canvasState()} != nebula ${nebState()}`);
      if (at >= 0 && nebState() !== states[at + 1]) problems.push(`R${s} (${desc[at]}) ${nebState()} != after it ${states[at + 1]}`);
      if (at >= 0 && notice() !== `Redid ${whoOf[at]}’s edit.`) problems.push(`R${s} line ${notice()} for ${whoOf[at]}`);
    }
    return { problems, desc, initialWires: initialWires.map((w) => `${w.source}>${w.target}`) };
  };
  for (const hold of ['restore', 'mixedRestoreFirst'] as Hold[]) {
    it(`generator with "delete held": ${hold}, 3 held nodes`, async () => {
      const failures: string[] = [];
      let deletedHeld = 0;
      for (let seed = 1; seed <= 6; seed += 1) {
        const sd = seed * 7919 + (hold === 'restore' ? 1 : 2);
        const out = await scenario(sd, hold, 3, 1 + (seed % 3));
        if (out.desc.some((each) => each.includes('delete held'))) deletedHeld += 1;
        if (out.problems.length) failures.push(`seed ${sd} ${JSON.stringify(out.desc)}: ${out.problems.join('; ')}`);
        await cleanup();
        vi.setSystemTime(Date.now() + 600_000);
      }
      expect(failures).toEqual([]);
      expect(deletedHeld).toBeGreaterThan(0);
    }, 120_000);
  }
});
