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

const fake = vi.hoisted(() => ({ backend: null as unknown as FakeNebula }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => fake.backend.apiFetch(path, init),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import type { ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const CLI = /^n\d+$/;
/** Each seed runs on a fresh store module, so no seed leaves module state (a
 * pending create, a held press, a typing debounce) to the next. */
type GraphModule = typeof import('../src/store/graphStore');
let useGraphStore: GraphModule['useGraphStore'];
let subscribers: () => Array<(event: ExecutionEvent) => void>;
async function freshStore(): Promise<void> {
  vi.resetModules();
  const graph = await import('../src/store/graphStore');
  const ws = await import('../src/lib/wsClient');
  nebula().tab = (await import('../src/lib/tabId')).TAB_ID;
  useGraphStore = graph.useGraphStore;
  subscribers = () => vi.mocked(ws.wsClient.subscribe).mock.calls.map(([handler]) => handler as (event: ExecutionEvent) => void);
}
const store = () => useGraphStore.getState();
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };

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

async function runSeed(seed: number): Promise<Failure | null> {
  const failure = await runSeedInner(seed);
  if (failure) failure.calls = nebula().calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path} ${call.body ?? ''}`.slice(0, 300));
  return failure;
}

async function runSeedInner(seed: number): Promise<Failure | null> {
  await freshStore();
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
  const connectingFrom = new Set<string>();
  let letter = 0;
  const quiet = () => nebula().answers.length === 0 && nebula().echoes.length === 0;

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
    const roll = random();
    // A person's action comes after every echo whose answer already landed
    // (Nebula writes the echo first: FakeNebula.catchUp).
    if (roll >= 0.06 && roll < 0.80) {
      nebula().catchUp();
      await settle();
    }
    const nodes = store().nodes;
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
  for (let presses = 0; store().undoStack.length > 0 && presses < 120; presses += 1) {
    const failed = await press('undo', OPS + presses);
    if (failed) return failed;
    await deliverAll();
  }
  await deliverAll();
  if (store().undoStack.length > 0) return { calls: [], seed, step: OPS, what: 'the undo stack never emptied', log };
  if (canvasShape() !== start) return { calls: [], seed, step: OPS, what: `back at ${canvasShape()}, started at ${start}`, log };
  if (nebulaShape() !== startNebula) return { calls: [], seed, step: OPS, what: `Nebula at ${nebulaShape()}, started at ${startNebula}`, log };
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

  const chunks: number[][] = [];
  for (let seed = FIRST; seed < FIRST + SEEDS; seed += CHUNK) {
    chunks.push(Array.from({ length: Math.min(CHUNK, FIRST + SEEDS - seed) }, (_, index) => seed + index));
  }
  it.each(chunks.map((seeds) => [`${seeds[0]}-${seeds[seeds.length - 1]}`, seeds] as const))('seeds %s', async (_range, seeds) => {
    const failures: Failure[] = [];
    for (const seed of seeds) {
      const failure = await runSeed(seed);
      if (failure) failures.push(failure);
      await tick(20_000);
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
