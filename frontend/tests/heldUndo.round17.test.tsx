import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// Review 16, round 17. Every case runs against a fake Nebula that applies
// each request (its graph, params and wires), and checks the restore bodies
// sent and that the canvas ends where Nebula's graph does.
// H1 (coordinator's decision): "arrived elsewhere" is relative to time. A
//   node an undo or redo puts back is someone else's only for the steps taken
//   after the change it undoes; an older step keeps owning what it added, so
//   undoing the paste, duplicate, connect or upload still takes its node off.
// M1: every path that adds nodes has its own undo step that owns them
//   (the node library, a canvas drop and the command palette through
//   addNode; Character and Moodboard drops; Creator's cluster).
// L-3: a param the person typed that Nebula has (its PUT answered) isn't
//   overwritten by a sync sent before it; the typing's step survives.

const fake = vi.hoisted(() => ({ backend: null as unknown as FakeNebula }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => fake.backend.apiFetch(path, init),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const CLI = /^n\d+$/;
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const cliIds = () => ids().filter((id) => CLI.test(id));
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const wires = () => store().edges.map((edge) => `${edge.source}>${edge.target}`).sort();
const notice = () => store().undoNotice?.text ?? null;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); };
const redo = async () => { store().redo(); await settle(); };
const restores = () => nebula().calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string; params?: { value?: string } }>;
    wire?: Array<{ source: string; target: string }>; remove: string[] })
  .map((body) => ({ nodes: body.nodes.filter((node) => CLI.test(node.id)).map((node) => `${node.id}=${node.params?.value}`).sort(),
    wire: (body.wire ?? []).map((edge) => `${edge.source}>${edge.target}`).sort(), remove: [...body.remove].sort() }));
const restore = (nodes: string[], remove: string[] = [], wire: string[] = []) => ({ nodes, wire, remove });
/** Canvas = Nebula: the same backend nodes, values and wires between them. */
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) expect(valueOf(id)).toEqual(nebula().valueOf(id));
  expect(wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)))).toEqual(nebula().wires());
};
/** A card with no measured size. */
const unsized = (node: Node<NodeData>) => {
  const copy = { ...node };
  delete copy.width;
  delete copy.height;
  return copy;
};
const type = (id: string, value: string) => { store().updateNodeData(id, { params: { value } }); };
const del = async (id: string) => { store().onNodesChange([{ id, type: 'remove' }]); await settle(); };
/** A sync with no edit origin (a reconnect, a run's outputs) carrying `graph`. */
const plainSync = (nodes: FakeNode[]) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: FakeNebula.syncNodes({ nodes, edges: [] }),
    edges: [], empty: nodes.length === 0 } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};

let clock = Date.now();

describe('round 17 (review 16): an undo always takes off what its own step added', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Each case starts later than the last one ended: a clock run backwards
    // would read a new case's typing as the last case's, still going on.
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = (event) => {
      const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
      for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    nebula().holdEchoes = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer());
    await settle();
    await tick(16_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const start = (nodes: FakeNode[], edges: Edge[] = [], selected: string[] = []) => {
    nebula().reset(nodes);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, selected.includes(node.id) ? { selected: true } : {})),
      edges, isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const pasteOne = async () => {
    store().copySelected();
    const pasted = store().pasteClipboard();
    await tick(1100);
    return pasted;
  };
  const connectImage = async () => {
    await store().addNodeAndConnect('gpt-image-1-generate', { x: 400, y: 100 },
      { source: 'n1', sourceHandle: 'text', target: '', targetHandle: 'prompt', newNodeIs: 'target' });
    await settle();
    await tick(1100);
  };
  const upload = async () => {
    const step = store().beginUndoStep();
    // The upload's own node arrives with its echo (Nebula made it).
    nebula().nodes.set('n9', { ...textFakeNode('n9', 'img') });
    nebula().next = 10;
    nebula().emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [],
      empty: false, edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_up' } });
    store().endUndoStep(step, { arrives: ['n9'] });
    await settle();
    await tick(1100);
  };

  describe('H1: a node an undo puts back stays its adding step\'s', () => {
    it('A2: paste, delete the pasted node, Cmd+Z, Cmd+Z: the paste is undone', async () => {
      start([textFakeNode('n1')], [], ['n1']);
      const [pasted] = await pasteOne();
      await del(pasted);
      await undo();
      expect(ids()).toContain(pasted);
      await undo();
      expect(ids()).toEqual(['n1']);
      expect(store().undoStack).toHaveLength(0);
      expect(restores()).toEqual([]);
      sameAsNebula();
    });

    it('A3: duplicate, delete the duplicate, Cmd+Z, Cmd+Z: the duplicate is undone', async () => {
      start([textFakeNode('n1')], [], ['n1']);
      store().duplicateSelected();
      await tick(1100);
      const copy = ids().find((id) => id !== 'n1')!;
      await del(copy);
      await undo();
      expect(ids()).toContain(copy);
      await undo();
      expect(ids()).toEqual(['n1']);
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('A4: add and connect n2, delete it, Cmd+Z, Cmd+Z: the node and its wire go, here and in Nebula', async () => {
      start([textFakeNode('n1')]);
      await connectImage();
      expect(cliIds()).toEqual(['n1', 'n2']);
      expect(wires()).toEqual(['n1>n2']);
      await del('n2');
      await undo();
      expect(restores()[0]).toMatchObject({ remove: [], wire: ['n1>n2'] });
      expect(wires()).toEqual(['n1>n2']);
      await undo();
      expect(restores()[1]).toEqual(restore([], ['n2']));
      expect(ids()).toEqual(['n1']);
      expect(wires()).toEqual([]);
      sameAsNebula();
    });

    it('U1: upload n9, delete it, Cmd+Z, Cmd+Z: the upload is undone', async () => {
      start([textFakeNode('n1')]);
      await upload();
      await del('n9');
      await undo();
      expect(restores()).toEqual([restore(['n9=img'])]);
      await undo();
      expect(restores()[1]).toEqual(restore([], ['n9']));
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it('U1 with the delete\'s echo after its answer: the undo, then the stale echo, then the restore\'s echo', async () => {
      start([textFakeNode('n1')]);
      await upload();
      nebula().holdEchoes = true;
      await del('n9');
      await undo();
      // The delete's echo (no n9) lands after the undo put n9 back, then the restore's.
      nebula().deliverEcho(); await settle();
      nebula().deliverEcho(); await settle();
      nebula().holdEchoes = false;
      expect(ids()).toEqual(['n1', 'n9']);
      await undo();
      expect(restores()[1]).toEqual(restore([], ['n9']));
      nebula().deliverEchoes(); await settle();
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it('A10: paste two as one step, delete one, Cmd+Z, Cmd+Z: the whole paste is undone', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1', 'n2']);
      const pasted = await pasteOne();
      expect(pasted).toHaveLength(2);
      await del(pasted[0]);
      await undo();
      await undo();
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('a redo of the paste, a delete, its undo and two Cmd+Z: back to the start', async () => {
      start([textFakeNode('n1')], [], ['n1']);
      const [pasted] = await pasteOne();
      await undo();
      await redo();
      await tick(1100);
      await del(pasted);
      await undo();
      await undo();
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it('control (r16 P1): typing between a delete\'s echoes keeps the restored nodes', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
      await settle();
      nebula().deliverEcho(); await settle();
      type('n3', 'F');
      await tick(300); // the param push goes out
      nebula().deliverEchoes(); await settle();
      while (nebula().releaseAnswer()) await settle();
      nebula().holdAnswers = false;
      nebula().holdEchoes = false;
      await undo();
      expect(restores()[0]).toEqual(restore(['n1=n1', 'n2=n2']));
      await undo();
      expect(restores()[1]).toEqual(restore(['n3=n3']));
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsNebula();
    });
  });

  describe('M1: every path that adds nodes has its own undo step', () => {
    const addFromLibrary = async () => {
      await store().addNode('text-input', { x: 300, y: 300 });
      await settle();
    };

    it('A1: typing, then a node from the library: Cmd+Z takes the node off, the next one the typing', async () => {
      start([textFakeNode('n1')]);
      type('n1', 'A');
      await tick(1100);
      await addFromLibrary();
      expect(cliIds()).toEqual(['n1', 'n2']);
      await undo();
      expect(restores()[restores().length - 1]).toEqual(restore([], ['n2']));
      expect(cliIds()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('A');
      await undo();
      expect(valueOf('n1')).toBe('n1');
      sameAsNebula();
    });

    it('A1b: a node from the library on an empty stack: Cmd+Z takes it off', async () => {
      start([textFakeNode('n1')]);
      await addFromLibrary();
      await undo();
      expect(restores()).toEqual([restore([], ['n2'])]);
      expect(ids()).toEqual(['n1']);
      expect(notice()).toBe('Deleted the node.');
      sameAsNebula();
    });

    it('the answer before the echo: Cmd+Z takes the node off once it is here', async () => {
      start([textFakeNode('n1')]);
      nebula().holdEchoes = true;
      await addFromLibrary();
      nebula().holdEchoes = false;
      nebula().deliverEchoes(); await settle();
      await undo();
      expect(restores()).toEqual([restore([], ['n2'])]);
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it('Cmd+Z while the add is on its way waits for it, then takes the node off', async () => {
      start([textFakeNode('n1')]);
      nebula().holdAnswers = true;
      const adding = store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      await undo();
      nebula().releaseAnswer();
      await adding;
      await settle();
      expect(restores()).toEqual([restore([], ['n2'])]);
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it('an agent\'s node that arrives while the add is on its way stays when the add is undone', async () => {
      start([textFakeNode('n1')]);
      nebula().holdAnswers = true;
      const adding = store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      nebula().nodes.set('n7', textFakeNode('n7'));
      nebula().emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: [] }), edges: [], empty: false });
      await settle();
      nebula().releaseAnswer();
      nebula().holdAnswers = false;
      await adding;
      await settle();
      await undo();
      expect(restores()).toEqual([restore([], ['n2'])]);
      expect(ids()).toEqual(['n1', 'n7']);
      sameAsNebula();
    });

    it.each([
      ['a Character', () => store().addCharacterNode('char-1', { x: 300, y: 300 })],
      ['a Moodboard', () => store().addMoodboardNode('board-1', { x: 300, y: 300 })],
    ] as const)('%s dropped on the canvas: Cmd+Z takes it off', async (_name, add) => {
      start([textFakeNode('n1')]);
      await add();
      await settle();
      expect(cliIds()).toEqual(['n1', 'n2']);
      await undo();
      expect(restores()).toEqual([restore([], ['n2'])]);
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });

    it("Creator's cluster, its echo before its answer: Cmd+Z takes every node it added off", async () => {
      start([textFakeNode('n1')]);
      await store().authorGenerationCluster({ definitionId: 'gpt-image-1-generate', prompt: 'a fox', refPaths: [],
        quantity: 2, params: {}, layoutOrigin: { x: 0, y: 400 }, sessionId: 's1', genId: 'g1' } as never);
      await settle();
      expect(cliIds()).toEqual(['n1', 'n2', 'n3', 'n4']);
      await undo();
      expect(restores()).toEqual([restore([], ['n2', 'n3', 'n4'])]);
      expect(ids()).toEqual(['n1']);
      sameAsNebula();
    });
  });

  describe('L-3: a sync sent before the person\'s saved typing never takes it back', () => {
    it('A11: the PUT answered, a sync from before it arrives, then its own echo: the value and its step stay', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdEchoes = true;
      type('n1', 'A');
      await tick(300); // the push goes out and Nebula answers; its echo is still on its way
      await settle();
      expect(nebula().valueOf('n1')).toBe('A');
      // A reconnect's graph read before the push landed.
      plainSync([textFakeNode('n1'), textFakeNode('n2')]);
      await settle();
      expect(valueOf('n1')).toBe('A');
      nebula().holdEchoes = false;
      nebula().deliverEchoes(); await settle();
      expect(valueOf('n1')).toBe('A');
      await undo();
      expect(restores()).toEqual([restore(['n1=n1'])]);
      expect(valueOf('n1')).toBe('n1');
      sameAsNebula();
    });

    it('A11b: Cmd+Z between that sync and the echo undoes the typing, and the canvas ends where Nebula does', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdEchoes = true;
      type('n1', 'A');
      await tick(300);
      await settle();
      plainSync([textFakeNode('n1'), textFakeNode('n2')]);
      await settle();
      await undo();
      expect(restores()).toEqual([restore(['n1=n1'])]);
      nebula().holdEchoes = false;
      nebula().deliverEchoes(); await settle();
      expect(valueOf('n1')).toBe('n1');
      sameAsNebula();
    });

    it('control: a PUT that failed lets the next sync show Nebula\'s value', async () => {
      start([textFakeNode('n1')]);
      const original = nebula().apiFetch.bind(nebula());
      vi.spyOn(nebula(), 'apiFetch').mockImplementation(async (path, init) =>
        (init?.method === 'PUT' ? new Response('{}', { status: 500 }) : original(path, init)));
      type('n1', 'A');
      await tick(300);
      await settle();
      plainSync([textFakeNode('n1')]);
      await settle();
      expect(valueOf('n1')).toBe('n1');
    });
  });

  // The property test (heldUndo.property.round17) found these beyond the
  // review's list. Each is an order a slow answer allows.
  describe('found by the property test', () => {
    const connectFrom = (origin: string) => store().addNodeAndConnect('gpt-image-1-generate', { x: 400, y: 100 },
      { source: origin, sourceHandle: 'text', target: '', targetHandle: 'prompt', newNodeIs: 'target' });

    it('P-1: a node made from a node deleted before its answer is still its step\'s: undo takes it off', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdAnswers = true;
      const made = connectFrom('n1');
      await settle();
      // Nebula made n3 and its wire; its echo is here, the answer isn't.
      expect(nebula().ids()).toEqual(['n1', 'n2', 'n3']);
      await del('n1');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await made; await settle();
      await undo(); // the delete
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
      await undo(); // the add
      expect(restores()[restores().length - 1]).toEqual(restore([], ['n3']));
      expect(cliIds()).toEqual(['n1', 'n2']);
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('P-2: a node made and then deleted before its answer: the next Cmd+Z is not silent', async () => {
      start([textFakeNode('n1')]);
      nebula().holdAnswers = true;
      const made = connectFrom('n1');
      await settle();
      await del('n2');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await made; await settle();
      expect(cliIds()).toEqual(['n1']);
      await undo(); // the delete: n2 comes back
      expect(cliIds()).toEqual(['n1', 'n2']);
      expect(notice()).toBe('Restored the node.');
      await undo(); // the add: n2 goes
      expect(cliIds()).toEqual(['n1']);
      expect(store().undoStack).toHaveLength(0);
      sameAsNebula();
    });

    it('P-2b: the same with a Cmd+Z held for the add: no step is left that waits for the deleted node', async () => {
      start([textFakeNode('n1')]);
      // Unsized cards, as the app's are until resized: they match their snapshot after a sync.
      useGraphStore.setState({ nodes: store().nodes.map(unsized) as never });
      nebula().holdAnswers = true;
      const made = connectFrom('n1');
      await settle();
      await undo(); // waits for the add's answer
      await del('n2');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await made; await settle();
      expect(cliIds()).toEqual(['n1']);
      // The held press found the add with nothing to change (its node was
      // deleted): the add's node went to the delete, which has nothing left
      // to put back either. A Cmd+Z now finds no step still waiting.
      await undo();
      expect(store().undoStack).toHaveLength(0);
      expect(cliIds()).toEqual(['n1']);
      sameAsNebula();
    });

    it('P-3: a delete placed beneath an add on its way never takes in that add\'s node', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n2']);
      const [local] = await pasteOne(); // a canvas-only node leaves with the delete's answer
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: local, type: 'remove' }, { id: 'n1', type: 'remove' }]);
      await settle();
      const added = store().addNode('text-input', { x: 300, y: 300 });
      await settle();
      expect(nebula().ids()).toEqual(['n2', 'n3']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await added; await settle();
      await tick(16_000);
      expect(cliIds()).toEqual(['n2', 'n3']);
      await undo(); // the add
      expect(cliIds()).toEqual(['n2']);
      await undo(); // the delete: n1 and the pasted node, not n3
      expect(restores()[restores().length - 1].nodes).toEqual(['n1=n1']);
      expect(ids()).toEqual([local, 'n1', 'n2'].sort());
      sameAsNebula();
    });

    it('P-4: an undo\'s restore that waits behind a delete never brings back a node deleted since', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdAnswers = true;
      await del('n1'); // its answer is slow: restores wait behind it
      type('n2', 'B');
      await tick(1100);
      while (nebula().answers.some((held) => held.label.startsWith('params'))) {
        nebula().releaseAnswer(nebula().answers.findIndex((held) => held.label.startsWith('params')));
        await settle();
      }
      await undo(); // the typing: n2 back to n2, its restore queued behind the delete
      expect(valueOf('n2')).toBe('n2');
      await del('n2');
      // The delete waits for the restore: Nebula gets them in the order pressed.
      expect(nebula().ids()).toEqual(['n2']);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await settle();
      const sent = nebula().calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
      expect(sent.slice(-2)).toEqual(['POST /api/graph/restore', 'DELETE /api/graph/node/n2']);
      expect(restores()).toEqual([restore(['n2=n2'])]);
      expect(nebula().ids()).toEqual([]);
      expect(cliIds()).toEqual([]);
      sameAsNebula();
      await undo(); // the delete of n2: back as the undo left it
      expect(cliIds()).toEqual(['n2']);
      expect(valueOf('n2')).toBe('n2');
      sameAsNebula();
    });

    it.each([
      ['applied beneath the steps above it', true],
      ['passing over it as changing nothing', false],
    ])('P-5: Cmd+Z held for an upload whose node a later delete took off (%s): no node is left that no undo takes off', async (_, sized) => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], []);
      // Unsized cards match their snapshot after a sync, so the press finds nothing to change there.
      if (!sized) useGraphStore.setState({ nodes: store().nodes.map(unsized) as never });
      nebula().holdAnswers = true;
      // Chat's upload: Nebula makes n3, echoes it, then answers with its id.
      const step = store().beginUndoStep();
      nebula().request += 1;
      nebula().nodes.set('n3', textFakeNode('n3', 'upload'));
      nebula().next = 4;
      nebula().broadcast();
      void nebula().later('upload n3', () => { store().endUndoStep(step, { arrives: ['n3'] }); });
      await settle();
      await undo(); // held: the upload is on its way
      const added = store().addNode('text-input', { x: 300, y: 300 }); // n4
      await settle();
      store().onNodesChange([{ id: 'n3', type: 'remove' }, { id: 'n4', type: 'remove' }]);
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await added; await settle();
      await tick(16_000);
      expect(cliIds()).toEqual(['n1', 'n2']);
      while (store().undoStack.length > 0) await undo();
      expect(cliIds()).toEqual(['n1', 'n2']);
      sameAsNebula();
    });

    // Seeds 1624 and 147 (3000-seed run): an undo's restore waits behind an
    // earlier restore whose answer is slow, and the person's next write went
    // out at once, ahead of it.
    it('P-6: typing after an undo whose restore is still waiting: the typing is what Nebula keeps', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      type('n2', 'B');
      await tick(1100);
      nebula().holdAnswers = true;
      await undo(); // n2 back to n2: its restore goes out, its answer is slow
      await undo(); // n1 back to n1: its restore waits behind the first
      type('n1', 'C');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(valueOf('n1')).toBe('C');
      expect(nebula().valueOf('n1')).toBe('C');
      sameAsNebula();
    });

    // Seed 147: the node the waiting restore puts back isn't in Nebula yet,
    // so a delete sent ahead of it missed, and the restore made it again.
    it('P-7: deleting a node a waiting restore puts back: it stays deleted', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      await del('n3');
      await del('n2');
      nebula().holdAnswers = true;
      await undo(); // n2 back: its restore reaches Nebula, its answer is slow
      await undo(); // n3 back: its restore waits behind the first
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
      await del('n3');
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(restores()).toEqual([restore(['n2=n2']), restore(['n3=n3'])]);
      expect(cliIds()).toEqual(['n1', 'n2']);
      sameAsNebula();
      await undo(); // the delete of n3
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
      sameAsNebula();
    });

    // Seed 1624: typing on it went ahead too, and the restore wrote over it.
    it('P-8: typing on a node a waiting restore puts back: Nebula keeps the typing', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')]);
      await del('n3');
      await del('n2');
      nebula().holdAnswers = true;
      await undo(); // n2 back, answer slow
      await undo(); // n3 back, waiting behind it
      type('n3', 'C');
      await tick(1100);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(valueOf('n3')).toBe('C');
      expect(nebula().valueOf('n3')).toBe('C');
      sameAsNebula();
      await undo(); // the typing
      expect(valueOf('n3')).toBe('n3');
      sameAsNebula();
    });

    // Seed 266: the earlier restore's echo, sent before the queued one
    // reached Nebula, still had the node the queued undo took off. It came
    // back on the canvas, and a step taken then kept it.
    it('P-9: an echo from before a waiting undo leaves what that undo did on the canvas', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      const added = store().addNode('text-input', { x: 300, y: 300 }); // n3
      await settle();
      await added;
      type('n1', 'A');
      await tick(1100);
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      await undo(); // the typing: its restore reaches Nebula, echo and answer slow
      await undo(); // the add: n3 off, its restore waits behind the first
      expect(cliIds()).toEqual(['n1', 'n2']);
      nebula().releaseAnswer();
      await settle();
      nebula().deliverEcho(); // the first restore's echo: Nebula still has n3
      await settle();
      expect(cliIds()).toEqual(['n1', 'n2']);
      await del('n1'); // a step taken now
      nebula().holdEchoes = false;
      nebula().holdAnswers = false;
      nebula().deliverEchoes();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).toEqual(['n2']);
      sameAsNebula();
      while (store().undoStack.length > 0) await undo();
      expect(cliIds()).toEqual(['n1', 'n2']);
      sameAsNebula();
    });

    // Seed 320: a node stays on the canvas until Nebula answers its delete,
    // so the person can delete it again meanwhile. Two steps then claimed
    // its delete; undoing the second brought it back, and the first's Cmd+Z
    // did nothing, without a word.
    it('P-10: deleting a node again while its delete is on its way: every Cmd+Z does something', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      await del('n1');
      expect(cliIds()).toEqual(['n1', 'n2']);
      await del('n1');
      nebula().holdEchoes = false;
      nebula().holdAnswers = false;
      nebula().deliverEchoes();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(cliIds()).toEqual(['n2']);
      sameAsNebula();
      const steps = store().undoStack.length;
      for (let press = 0; press < steps; press += 1) {
        const before = JSON.stringify([cliIds(), store().undoNotice?.id]);
        await undo();
          expect(JSON.stringify([cliIds(), store().undoNotice?.id])).not.toBe(before);
      }
      expect(cliIds()).toEqual(['n1', 'n2']);
      sameAsNebula();
    });

    // Seed 914: the same with a param. The earlier restore's echo shows the
    // node there, with the value from before the queued undo.
    it('P-11: an echo from before a waiting undo leaves that undo\'s value on the canvas', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      type('n1', 'A');
      await tick(1100);
      await del('n2');
      nebula().holdEchoes = true;
      nebula().holdAnswers = true;
      await undo(); // n2 back: echo and answer slow
      await undo(); // the typing: n1 back to n1, waiting behind it
      expect(valueOf('n1')).toBe('n1');
      nebula().releaseAnswer();
      await settle();
      nebula().deliverEcho(); // the first restore's echo: Nebula still has n1=A
      await settle();
      expect(valueOf('n1')).toBe('n1');
      nebula().holdEchoes = false;
      nebula().holdAnswers = false;
      nebula().deliverEchoes();
      while (nebula().releaseAnswer()) await settle();
      await tick(6000);
      expect(restores()).toEqual([restore(['n2=n2']), restore(['n1=n1'])]);
      expect(valueOf('n1')).toBe('n1');
      sameAsNebula();
    });
  });
});

export type { Node, NodeData };
