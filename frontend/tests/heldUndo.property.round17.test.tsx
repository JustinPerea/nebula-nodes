import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNebula, canvasNode, textFakeNode } from './helpers/undoFakeBackend';

// Review 16, H1 (the coordinator's decision): a property-style test. Random
// sequences of the person's own edits (type, add from the library, add and
// connect, upload, paste, duplicate, delete, Cmd+Z, Cmd+Shift+Z), with
// Nebula's echoes and HTTP answers reaching the tab in random order (echoes
// in the order Nebula sent them, as a WebSocket delivers them; answers each
// on their own). After each sequence, with everything delivered:
//   1. the canvas is where Nebula's graph is (nodes, values, wires);
//   2. Cmd+Z back to an empty stack restores the start, here and in Nebula;
//   3. no press is silent while its stack holds a step: pressed with nothing
//      on its way, a Cmd+Z or Cmd+Shift+Z changes the canvas or says why.
// Seeds: UNDO_PROPERTY_SEEDS (default 120), from UNDO_PROPERTY_FIRST (default 1).
// Review 17, M-1 (round 18): the foreign-add variant also has nodes added by
// someone else at random (an agent's edit, a reconnect's sync with no edit,
// another window's edit). A plain sync's node is no step, so it stays at the
// end; an agent's or another window's add is a step the person can undo.
// Seeds: UNDO_PROPERTY_FOREIGN_SEEDS (default 60), from
// UNDO_PROPERTY_FOREIGN_FIRST (default 1).
// Review 18 (round 19): the refusal variant refuses 30% of node DELETEs at
// random (409, on its way like any answer), so a failed delete's put-back
// meets every other write in flight (M-A: typing that waited behind an undo;
// M-B: a wire made while the delete was out). Seeds:
// UNDO_PROPERTY_REFUSE_SEEDS (default 30), from UNDO_PROPERTY_REFUSE_FIRST
// (default 1); UNDO_PROPERTY_SKIP_REFUSE=1 / UNDO_PROPERTY_ONLY_REFUSE=1.
// Review 19 (round 20, M3): the clear variant (the reviewer's propclear
// probe). An agent clears once at a random step (about 12% a step) and adds
// 1-3 nodes that reuse ids n1…; the fake models Nebula's fence (no project or
// an old canvas: 409, nothing applied). Undo and redo stop after the clear.
// Checks: canvas = Nebula once everything lands, and no value typed before
// the clear ends up on a node of the new canvas. Seeds:
// UNDO_PROPERTY_CLEAR_SEEDS (default 30, plus seeds 84 and 1123), from
// UNDO_PROPERTY_CLEAR_FIRST (default 1); UNDO_PROPERTY_SKIP_CLEAR=1 /
// UNDO_PROPERTY_ONLY_CLEAR=1.

const fake = vi.hoisted(() => ({ backend: null as unknown as FakeNebula, refuseDelete: null as null | (() => boolean),
  fence: false, canvas: '0', ctx: null as null | { getProjectContext: () => { canvas?: string } | null } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit, options?: { project?: { canvas?: string } | null }) => {
    // Review 19's clear variant: Nebula's fence (backend main.py): a tab write with no project, or made for a
    // canvas cleared since, is refused with the stale line, after Nebula applied nothing.
    const method0 = String(init?.method ?? 'GET').toUpperCase();
    if (fake.fence && method0 !== 'GET' && path.startsWith('/api/graph')) {
      const sent = options && 'project' in options ? options.project : fake.ctx?.getProjectContext();
      if (!sent || (sent.canvas !== undefined && sent.canvas !== fake.canvas)) {
        fake.backend.calls.push({ path, method: method0 + ' (fenced ' + JSON.stringify(sent) + ' vs ' + fake.canvas + ' ctx ' + JSON.stringify(fake.ctx?.getProjectContext()) + ')' });
        return fake.backend.later(`fenced ${path}`, () => new Response(JSON.stringify({ detail: 'This canvas is out of date. Open the current project before editing or running it.' }), { status: 409 }));
      }
    }
    // The refusal variant: Nebula refuses this node's delete (it is running).
    if (init?.method === 'DELETE' && /^\/api\/graph\/node\/n\d+$/.test(path) && fake.refuseDelete?.()) {
      fake.backend.calls.push({ path, method: 'DELETE' });
      fake.backend.request += 1;
      return fake.backend.later(`refused delete ${path}`,
        () => new Response(JSON.stringify({ detail: 'It is still running.' }), { status: 409 }));
    }
    return fake.backend.apiFetch(path, init);
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import type { ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

import * as PC from '../src/lib/projectContext';
import * as GS from '../src/store/graphStore';
import { wsClient as WS } from '../src/lib/wsClient';
const GS_INITIAL = GS.useGraphStore.getState();
fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const CLI = /^n\d+$/;
/** Each seed runs on a fresh store module, so no seed leaves module state (a
 * pending create, a held press, a typing debounce) to the next. */
type GraphModule = typeof import('../src/store/graphStore');
let useGraphStore: GraphModule['useGraphStore'];
let subscribers: () => Array<(event: ExecutionEvent) => void>;
async function freshStore(): Promise<void> {
  if (fake.fence) {
    // The clear variant: one module instance (a reset gave the probe's projectContext another instance).
    GS.useGraphStore.getState().finishCanvasReplacement?.(null);
    GS.useGraphStore.setState(GS_INITIAL, true);
    useGraphStore = GS.useGraphStore;
    subscribers = () => vi.mocked(WS.subscribe).mock.calls.map(([handler]) => handler as (event: ExecutionEvent) => void);
    nebula().tab = (await import('../src/lib/tabId')).TAB_ID;
    fake.ctx = PC;
    return;
  }
  vi.resetModules();
  const graph = await import('../src/store/graphStore');
  const ws = await import('../src/lib/wsClient');
  nebula().tab = (await import('../src/lib/tabId')).TAB_ID;
  fake.ctx = await import('../src/lib/projectContext');
  useGraphStore = graph.useGraphStore;
  subscribers = () => vi.mocked(ws.wsClient.subscribe).mock.calls.map(([handler]) => handler as (event: ExecutionEvent) => void);
}
const store = () => useGraphStore.getState();
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Review 14 NIT-2: the shared fake timers advance in slices of at most a
 * second, and an abandoned block's run (`mine` no longer the generation)
 * stops before and after every slice, so it never finishes a step or its
 * final phase against the next block's canvas. */
function guardedTimers(mine: number) {
  const guard = () => { if (generation !== mine) throw new Abandoned(); };
  const sliced = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1000) { guard(); await tick(Math.min(1000, left)); }
    guard();
  };
  return { guard, tick: sliced, settle: async () => { for (let i = 0; i < 12; i += 1) await sliced(5); } };
}

const SEEDS = Number(process.env.UNDO_PROPERTY_SEEDS ?? 120);
const FIRST = Number(process.env.UNDO_PROPERTY_FIRST ?? 1);
const CHUNK = 30;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The canvas as the person sees it: every node with its value, every wire. */
function canvasShape(): string {
  const nodes = store().nodes.map((node) => `${CLI.test(node.id) ? node.id : 'local'}=${String(node.data.params.value ?? '')}`).sort();
  const edges = store().edges.map((edge) => `${CLI.test(edge.source) ? edge.source : 'local'}>${CLI.test(edge.target) ? edge.target : 'local'}`).sort();
  return JSON.stringify([nodes, edges]);
}
function nebulaShape(): string {
  return JSON.stringify([nebula().ids().map((id) => `${id}=${String(nebula().valueOf(id) ?? '')}`), nebula().wires()]);
}
function canvasBackendShape(): string {
  const cli = store().nodes.filter((node) => CLI.test(node.id)).sort((a, b) => a.id.localeCompare(b.id));
  const wires = store().edges.filter((edge) => CLI.test(edge.source) && CLI.test(edge.target)).map((edge) => `${edge.source}>${edge.target}`).sort();
  return JSON.stringify([cli.map((node) => `${node.id}=${String(node.data.params.value ?? '')}`), wires]);
}
const noticeIds = () => `${store().undoNotice?.id ?? '-'}/${store().messageNotice?.id ?? '-'}/${store().undoNotice?.text ?? ''}`;

interface Failure { seed: number; step: number; what: string; log: string[]; calls: string[] }

type Variant = 'plain' | 'foreign' | 'refuse' | 'clear';

/** PR #198 fix round 14 (review 13's flake): a block vitest timed out isn't
 * cancelled; its seed loop went on against the shared fake Nebula and store
 * while the next block ran, so the next block read the abandoned block's
 * typing ("pre-clear typing landed on the new canvas", seeds 10 and 24
 * under load; reproduced by forcing the block before it to time out). Each
 * block runs under its own generation; an abandoned one stops at its next
 * step; review 14 NIT-2: and at every await within a step and in the final
 * phase (guardedTimers). */
let generation = 0;
class Abandoned extends Error {}

async function runSeed(seed: number, variant: Variant = 'plain'): Promise<Failure | null> {
  const refuser = rng(seed + 7_000_000);
  fake.refuseDelete = variant === 'refuse' ? () => refuser() < 0.3 : null;
  fake.fence = variant === 'clear';
  const failure = await runSeedInner(seed, variant === 'foreign', variant === 'clear');
  if (failure) failure.calls = nebula().calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path} ${call.body ?? ''}`.slice(0, 300));
  return failure;
}

async function runSeedInner(seed: number, foreign: boolean, clearing = false): Promise<Failure | null> {
  const mine = generation;
  // Shadow the shared timers for everything this seed does (its steps, its
  // presses and its final delivery): an abandoned run stops at its next await.
  const { guard, tick, settle } = guardedTimers(mine);
  await freshStore();
  guard();
  const random = rng(seed);
  const pick = <T,>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
  const log: string[] = [];
  const startNodes = [textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')];
  nebula().reset(startNodes);
  useGraphStore.setState({ nodes: startNodes.map((node) => canvasNode(node)), edges: [], isExecuting: false,
    backendFreshStartPending: false, undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [] } as never);
  const start = canvasShape();
  const startNebula = nebulaShape();
  const pending: Array<Promise<unknown>> = [];
  let cleared = false;
  let letterAtClear = -1;
  let agentNow = false;
  const clearRoll = rng(seed + 9_000_000);

  const connectingFrom = new Set<string>();
  let letter = 0;
  const quiet = () => nebula().answers.length === 0 && nebula().echoes.length === 0;
  // The foreign-add variant: which requests were someone else's, and the
  // nodes a plain sync brought (no step: they stay).
  const foreignRequests = new Map<number, 'plain' | 'agent' | 'tab'>();
  const plainIds: string[] = [];
  // Each seed starts with the fake's own echo delivery (a foreign seed's goes with it).
  delete (nebula() as unknown as { deliverEcho?: unknown }).deliverEcho;
  if (clearing) {
    fake.canvas = '0';
    (fake.ctx as unknown as { setProjectContext: (v: unknown) => void }).setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    const fk = nebula() as unknown as { broadcast: () => void; deliverEcho: () => boolean;
      echoes: Array<{ nodes: unknown[]; edges: unknown[]; request: number; canvas?: string; agent?: boolean }> };
    fk.broadcast = function broadcast(): void {
      fk.echoes.push({ nodes: [...nebula().nodes.values()].map((n) => JSON.parse(JSON.stringify(n))), edges: JSON.parse(JSON.stringify(nebula().edges)),
        request: nebula().request, canvas: fake.canvas, agent: agentNow });
      if (!nebula().holdEchoes) nebula().deliverEchoes();
    };
    fk.deliverEcho = function deliverEcho(): boolean {
      const graph = fk.echoes.shift();
      if (!graph) return false;
      const edit = graph.agent ? { actor: { kind: 'agent', name: 'Codex', id: 'codex' }, id: `ed_ag${graph.request}` }
        : { actor: { kind: 'person' }, tab: nebula().tab, id: 'ed_own' };
      nebula().emit({ nodes: FakeNebula.syncNodes(graph as never), edges: graph.edges, empty: graph.nodes.length === 0, edit,
        canvasRevision: graph.canvas, workspaceRevision: 'r1' });
      return true;
    };
  }  if (foreign) {
    const fake = nebula() as unknown as { deliverEcho: () => boolean; echoes: Array<{ nodes: unknown[]; edges: unknown[]; request: number }> };
    fake.deliverEcho = function deliverEcho(): boolean {
      const graph = fake.echoes.shift();
      if (!graph) return false;
      const kind = foreignRequests.get(graph.request);
      const edit = kind === 'plain' ? undefined
        : kind === 'agent' ? { actor: { kind: 'agent', name: 'Codex', id: 'codex' }, id: `ed_ag${graph.request}` }
          : kind === 'tab' ? { actor: { kind: 'person' }, tab: 'another-window', id: `ed_tab${graph.request}` }
            : { actor: { kind: 'person' }, tab: nebula().tab, id: 'ed_own' };
      nebula().emit({ nodes: FakeNebula.syncNodes(graph as never), edges: graph.edges, empty: graph.nodes.length === 0, ...(edit ? { edit } : {}) });
      return true;
    };
  }

  const press = async (action: 'undo' | 'redo', step: number): Promise<Failure | null> => {
    const stack = action === 'undo' ? store().undoStack : store().redoStack;
    const checked = quiet() && stack.length > 0;
    const shape = canvasShape();
    const said = noticeIds();
    if (action === 'undo') store().undo(); else store().redo();
    await settle();
    log.push(`${action} (${stack.length} on its stack)`);
    if (checked && canvasShape() === shape && noticeIds() === said) {
      return { calls: [], seed, step, what: `a silent ${action === 'undo' ? 'Cmd+Z' : 'Cmd+Shift+Z'} with ${stack.length} on its stack`, log };
    }
    return null;
  };

  const deliverAll = async () => {
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    for (let round = 0; round < 40; round += 1) {
      nebula().deliverEchoes();
      await settle();
      while (nebula().releaseAnswer()) await settle();
      await tick(300);
      await settle();
      if (quiet()) {
        await tick(300);
        await settle();
        if (quiet()) break;
      }
    }
    await Promise.allSettled(pending);
    guard();
    await settle();
  };

  const OPS = 14 + Math.floor(random() * 16);
  const debug = Boolean(process.env.UNDO_PROPERTY_DEBUG);
  const state = () => `    ⤷ ${canvasShape()} | Nebula ${nebulaShape()} | undo ${store().undoStack.length} redo ${store().redoStack.length}`
    + ` | waiting: ${nebula().answers.map((a) => a.label).join(',')} / ${nebula().echoes.length} echoes | ${store().undoNotice?.text ?? ''}`
    + (process.env.UNDO_PROPERTY_STACKS ? `\n      undo: ${store().undoStack.map((e) => 'nodes' in e ? `[${(e.nodes as Array<{ id: string }>).map((n) => n.id.length > 4 ? 'L' : n.id).join(' ')}]` : 'agent').join(' ')}`
      + `\n      redo: ${store().redoStack.map((e) => 'nodes' in e ? `[${(e.nodes as Array<{ id: string }>).map((n) => n.id.length > 4 ? 'L' : n.id).join(' ')}]` : 'agent').join(' ')}` : '');
  const push = log.push.bind(log);
  if (debug) log.push = (...items: string[]) => { const n = push(...items); push(state()); return n; };
  for (let step = 0; step < OPS; step += 1) {
    guard();
    const roll = random();
    // A person's action comes after every echo whose answer already landed
    // (Nebula writes the echo first: FakeNebula.catchUp).
    if (roll >= 0.06 && roll < 0.80) {
      nebula().catchUp();
      await settle();
    }
    if (clearing && !cleared && clearRoll() < 0.12) {
      cleared = true;
      letterAtClear = letter;
      agentNow = true;
      nebula().request += 1;
      nebula().nodes.clear(); nebula().edges = []; nebula().next = 1;
      fake.canvas = '1';
      nebula().broadcast();
      const count = 1 + Math.floor(clearRoll() * 3);
      for (let i = 0; i < count; i += 1) {
        nebula().request += 1;
        const id = `n${nebula().next}`; nebula().next += 1;
        nebula().nodes.set(id, textFakeNode(id, `AG${id}`));
        nebula().broadcast();
      }
      agentNow = false;
      await settle();
      log.push(`agent clears and adds ${count} (letter ${letter}) ctx ${JSON.stringify(fake.ctx?.getProjectContext())} echoes ${nebula().echoes.length} subs ${subscribers().length}`);
      continue;
    }
    const nodes = store().nodes;
    if (foreign && random() < 0.10) {
      // Someone else adds a node: Nebula makes it and syncs it.
      const draw = random();
      const kind = draw < 0.4 ? 'plain' : draw < 0.75 ? 'agent' : 'tab';
      const id = `n${nebula().next}`;
      nebula().next += 1;
      nebula().request += 1;
      foreignRequests.set(nebula().request, kind);
      nebula().nodes.set(id, textFakeNode(id, `F${id}`));
      if (kind === 'plain') plainIds.push(id);
      nebula().broadcast();
      await settle();
      log.push(`${kind} foreign add ${id}`);
      continue;
    }
    if (roll < 0.06) {
      nebula().holdEchoes = random() < 0.5;
      nebula().holdAnswers = random() < 0.5;
      log.push(`hold echoes ${nebula().holdEchoes}, answers ${nebula().holdAnswers}`);
    } else if (roll < 0.20) {
      const node = pick(nodes);
      if (!node) continue;
      const value = `v${++letter}`;
      store().updateNodeData(node.id, { params: { ...node.data.params, value } });
      log.push(`type ${CLI.test(node.id) ? node.id : 'local'}=${value}`);
      if (random() < 0.6) await tick(600);
    } else if (roll < 0.27) {
      pending.push(store().addNode('text-input', { x: 300, y: 300 + step * 10 }));
      await settle();
      log.push('add from the library');
    } else if (roll < 0.31) {
      const origin = pick(nodes.filter((node) => CLI.test(node.id) && node.data.definitionId === 'text-input'));
      if (!origin) continue;
      connectingFrom.add(origin.id);
      pending.push(store().addNodeAndConnect('gpt-image-1-generate', { x: 500, y: 100 + step * 10 },
        { source: origin.id, sourceHandle: 'text', target: '', targetHandle: 'prompt', newNodeIs: 'target' })
        .finally(() => connectingFrom.delete(origin.id)));
      await settle();
      log.push(`add and connect from ${origin.id}`);
    } else if (roll < 0.35) {
      // Chat's upload: Nebula makes the node, echoes it, then answers with its id.
      const step0 = store().beginUndoStep();
      const made = { ...textFakeNode(`n${nebula().next}`, 'upload') };
      nebula().next += 1;
      nebula().request += 1;
      const request = nebula().request;
      nebula().nodes.set(made.id, made);
      nebula().broadcast();
      void nebula().later(`upload ${made.id}`, () => {
        nebula().answered.add(request);
        store().endUndoStep(step0, { arrives: [made.id] });
      });
      await settle();
      log.push(`upload ${made.id}`);
    } else if (roll < 0.43) {
      const chosen = nodes.filter(() => random() < 0.4);
      if (chosen.length === 0) continue;
      useGraphStore.setState({ nodes: store().nodes.map((node) => ({ ...node, selected: chosen.some((c) => c.id === node.id) })) });
      store().copySelected();
      const pasted = store().pasteClipboard();
      await tick(600);
      log.push(`paste ${chosen.length} (${pasted.length})`);
    } else if (roll < 0.48) {
      const node = pick(nodes);
      if (!node) continue;
      store().duplicateNode(node.id);
      await tick(600);
      log.push(`duplicate ${CLI.test(node.id) ? node.id : 'local'}`);
    } else if (roll < 0.60) {
      const doomed = nodes.filter((node) => !connectingFrom.has(node.id) && random() < 0.35).slice(0, 2);
      if (doomed.length === 0) continue;
      store().onNodesChange(doomed.map((node) => ({ id: node.id, type: 'remove' as const })));
      await settle();
      log.push(`delete ${doomed.map((node) => (CLI.test(node.id) ? node.id : 'local')).join(',')}`);
    } else if (cleared && roll < 0.80) {
      await tick(100);
      log.push('(no undo after the clear)');
    } else if (roll < 0.74) {
      const failed = await press('undo', step);
      if (failed) return failed;
    } else if (roll < 0.80) {
      const failed = await press('redo', step);
      if (failed) return failed;
    } else if (roll < 0.88) {
      if (nebula().deliverEcho()) log.push('an echo lands');
      await settle();
    } else if (roll < 0.95) {
      if (nebula().answers.length > 0 && nebula().releaseAnswer(Math.floor(random() * nebula().answers.length))) log.push('an answer lands');
      await settle();
    } else {
      await tick(50 + Math.floor(random() * 650));
      log.push('time passes');
    }
  }

  await deliverAll();
  log.push('-- everything delivered');
  if (canvasBackendShape() !== nebulaShape()) {
    return { calls: [], seed, step: OPS, what: `canvas ${canvasBackendShape()} vs Nebula ${nebulaShape()}`, log };
  }
  if (clearing) {
    if (!cleared) return null;
    const leaked = nebula().ids().filter((id) => { const v = String(nebula().valueOf(id) ?? ''); const m = /^v(\d+)$/.exec(v); return m && Number(m[1]) <= letterAtClear; });
    if (leaked.length > 0) return { calls: [], seed, step: OPS, what: `pre-clear typing landed on the new canvas: ${leaked.map((id) => `${id}=${nebula().valueOf(id)}`).join(',')} (letter at clear ${letterAtClear})`, log };
    return null;
  }
  for (let presses = 0; store().undoStack.length > 0 && presses < 120; presses += 1) {
    const failed = await press('undo', OPS + presses);
    if (failed) return failed;
    await deliverAll();
  }
  await deliverAll();
  if (store().undoStack.length > 0) return { calls: [], seed, step: OPS, what: 'the undo stack never emptied', log };
  // A plain sync's nodes are no step: they stay (the foreign-add variant).
  const [startCanvasNodes, startCanvasEdges] = JSON.parse(start) as [string[], string[]];
  const [startNebulaNodes, startNebulaEdges] = JSON.parse(startNebula) as [string[], string[]];
  const extra = plainIds.map((id) => `${id}=F${id}`);
  const expected = JSON.stringify([[...startCanvasNodes, ...extra].sort(), startCanvasEdges]);
  const expectedNebula = JSON.stringify([[...startNebulaNodes, ...extra]
    .sort((a, b) => a.split('=')[0].localeCompare(b.split('=')[0])), startNebulaEdges]);
  if (canvasShape() !== expected) return { calls: [], seed, step: OPS, what: `back at ${canvasShape()}, expected ${expected}`, log };
  if (nebulaShape() !== expectedNebula) return { calls: [], seed, step: OPS, what: `Nebula at ${nebulaShape()}, expected ${expectedNebula}`, log };
  if (canvasBackendShape() !== nebulaShape()) return { calls: [], seed, step: OPS, what: 'canvas and Nebula differ at the end', log };
  return null;
}

let clock = Date.now();

describe('round 17 (review 16, H1): random sequences of edits, undos and echoes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Each block starts later than the last one ended (a clock run backwards
    // would read a block's first typing as the last block's, still going on).
    clock += 100_000_000;
    vi.setSystemTime(clock);
    nebula().emit = (event) => {
      const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
      for (const handler of subscribers()) handler(full);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await tick(20_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const chunksOf = (first: number, count: number) => {
    const chunks: number[][] = [];
    for (let seed = first; seed < first + count; seed += CHUNK) {
      chunks.push(Array.from({ length: Math.min(CHUNK, first + count - seed) }, (_, index) => seed + index));
    }
    return chunks.map((seeds) => [`${seeds[0]}-${seeds[seeds.length - 1]}`, seeds] as const);
  };
  const ONLY_FOREIGN = process.env.UNDO_PROPERTY_ONLY_FOREIGN === '1';
  const ONLY_REFUSE = process.env.UNDO_PROPERTY_ONLY_REFUSE === '1';
  const ONLY_CLEAR = process.env.UNDO_PROPERTY_ONLY_CLEAR === '1';
  const plain = ONLY_FOREIGN || ONLY_REFUSE || ONLY_CLEAR ? [] : chunksOf(FIRST, SEEDS);
  const foreign = process.env.UNDO_PROPERTY_SKIP_FOREIGN === '1' || ONLY_REFUSE || ONLY_CLEAR ? []
    : chunksOf(Number(process.env.UNDO_PROPERTY_FOREIGN_FIRST ?? 1), Number(process.env.UNDO_PROPERTY_FOREIGN_SEEDS ?? 60));
  const refuse = process.env.UNDO_PROPERTY_SKIP_REFUSE === '1' || ONLY_FOREIGN || ONLY_CLEAR ? []
    : chunksOf(Number(process.env.UNDO_PROPERTY_REFUSE_FIRST ?? 1), Number(process.env.UNDO_PROPERTY_REFUSE_SEEDS ?? 30));
  // Review 19, M3: seeds 84 and 1123 always run (a pre-clear delete's answer
  // wiped the typing on the new node with its id).
  const clear = process.env.UNDO_PROPERTY_SKIP_CLEAR === '1' || ONLY_FOREIGN || ONLY_REFUSE ? []
    : [...chunksOf(Number(process.env.UNDO_PROPERTY_CLEAR_FIRST ?? 1), Number(process.env.UNDO_PROPERTY_CLEAR_SEEDS ?? 30)),
      ...((process.env.UNDO_PROPERTY_CLEAR_REGRESSION ?? (process.env.UNDO_PROPERTY_CLEAR_SEEDS ? '0' : '1')) === '1'
        ? [['84, 1123', [84, 1123]] as const] : [])];
  it.each([...plain.map(([range, seeds]) => [range, seeds, 'plain'] as const),
    ...foreign.map(([range, seeds]) => [`${range}, others adding nodes`, seeds, 'foreign'] as const),
    ...refuse.map(([range, seeds]) => [`${range}, 30% of deletes refused`, seeds, 'refuse'] as const),
    ...clear.map(([range, seeds]) => [`${range}, an agent clears`, seeds, 'clear'] as const)])('seeds %s', async (_range, seeds, variant) => {
    const failures: Failure[] = [];
    const mine = ++generation;
    for (const seed of seeds) {
      if (generation !== mine) return;
      const failure = await runSeed(seed, variant).catch((error: unknown) => {
        // Only a run a newer block took over stops this way; a live one rethrows.
        if (error instanceof Abandoned && generation !== mine) return null;
        throw error;
      });
      if (generation !== mine) return;
      if (failure) failures.push(failure);
      for (let left = 20_000; left > 0 && generation === mine; left -= 1000) await tick(1000);
    }
    if (failures.length > 0) {
      const first = failures[0];
      throw new Error(`${failures.length} of ${seeds.length} seeds failed: ${failures.map((f) => f.seed).join(', ')}\n`
        + `seed ${first.seed}, step ${first.step}: ${first.what}\n  ${first.log.join('\n  ')}`
        + (process.env.UNDO_PROPERTY_DEBUG ? `\ncalls:\n  ${first.calls.join('\n  ')}` : ''));
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
