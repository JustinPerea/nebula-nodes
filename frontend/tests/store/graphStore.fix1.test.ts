import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

/**
 * PR #198 fix round 1 (review 1):
 * - M1: Undo of an Accept never removes a Cinema shot's media, or anything
 *   else a run wrote, that the proposal didn't touch. A param that is a
 *   compound value (a scene, a clip list) is put back path by path:
 *   before ⊕ (now − set), never whole.
 * - L1: the undo line names a routed node's settings by their card labels.
 * - GM (pr198 r1, items 1-3): names only when every item is on one node;
 *   across nodes, the count.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { useGraphStore } = await import('../../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { acceptUndoLine, captureOwnAdd, ownAddStep, paramChange, rebaseAcceptedOnRunOutput } = await import('../../src/lib/canvasUndo');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const node = (id: string, params: Record<string, unknown>, label = id, definitionId = 'text-input') => ({ id,
  type: 'model-node', position: { x: 0, y: 0 }, data: { label, definitionId, params, state: 'idle', outputs: {} } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PAID = '/api/outputs/paid-s2.png';

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: () => {} } as never);
});
afterEach(() => { vi.useRealTimers(); });

async function acceptWith(reply: Record<string, unknown>, during?: () => void) {
  useCanvasProposalsStore.getState().open({ id: 'p', status: 'open', agent: { id: 'a', name: 'Codex', color: '#fff', verified: false },
    note: 'x', createdAt: Date.now(), expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] } as never, 'key', {});
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/accept')) { during?.(); return json(reply); }
    return json({});
  });
  await useCanvasProposalsStore.getState().accept('p');
}
const own = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
  edit: { tab: TAB_ID, actor: { kind: 'person' } } });
const runSync = (nodes: unknown[], marked = true) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [],
  ...(marked ? { runParams: 'shot-run' } : {}), nodes });

type Shot = Record<string, unknown>;
const scene = (...shots: Shot[]) => ({ scene: { shots } });
const cinema = (params: Record<string, unknown>) => node('n1', params, 'Scene', 'cinema-scene');
const done = (url: string) => ({ imageUrl: url, status: 'done' });

async function undoAndRead() {
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(json({}));
  useGraphStore.getState().undo();
  await sleep(30);
  const bodies = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { nodes: { params?: Record<string, unknown> }[] });
  const params = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1')?.data.params as Record<string, unknown>;
  const shots = ((params?.scene as { shots?: Shot[] })?.shots ?? []);
  return { bodies, params, shots, notice: useGraphStore.getState().undoNotice?.text ?? null };
}
const shotOf = (shots: Shot[], id: string) => shots.find((shot) => shot.id === id) as Shot;
const media = (shot: Shot | undefined) => JSON.stringify((shot?.output as { imageUrl?: string } | undefined)?.imageUrl ?? null);

describe('M1: Undo of an Accept keeps what a run wrote into a Cinema scene', () => {
  for (const marked of [true, false]) {
    it(`two shots: Accept changed s1's prompt, s2 rendered (${marked ? 'a marked' : 'an unmarked'} merge), Undo puts s1 back and keeps s2's image`, async () => {
      useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other' }))] } as never);
      const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other' }));
      await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
      await sleep(10);
      runSync([cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other', output: done(PAID) }))], marked);
      await sleep(10);
      const { bodies, shots, notice } = await undoAndRead();
      expect(shotOf(shots, 's1').prompt).toBe('a');
      expect(media(shotOf(shots, 's2'))).toContain('paid-s2.png');
      // The backend is told the same scene: s1 back, s2's image kept.
      expect(bodies).toHaveLength(1);
      const sent = (bodies[0].nodes[0].params?.scene as { shots: Shot[] }).shots;
      expect(shotOf(sent, 's1').prompt).toBe('a');
      expect(media(shotOf(sent, 's2'))).toContain('paid-s2.png');
      // Nothing an undo left alone, so no line.
      expect(notice ?? '').not.toContain('changed');
      // Redo still brings the Accept back.
      useGraphStore.getState().redo();
      await sleep(30);
      const redone = ((useGraphStore.getState().nodes[0].data.params.scene as { shots: Shot[] }).shots);
      expect(shotOf(redone, 's1').prompt).toBe('b');
      expect(media(shotOf(redone, 's2'))).toContain('paid-s2.png');
    });
  }

  it('the same shot: Accept changed s1\'s prompt, s1 rendered, Undo puts the prompt back and keeps its image', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    runSync([cinema(scene({ id: 's1', prompt: 'b', output: done('/api/outputs/s1-paid.png') }))]);
    await sleep(10);
    const { shots, bodies } = await undoAndRead();
    expect(shotOf(shots, 's1').prompt).toBe('a');
    expect(media(shotOf(shots, 's1'))).toContain('s1-paid.png');
    expect(media(shotOf((bodies[0].nodes[0].params?.scene as { shots: Shot[] }).shots, 's1'))).toContain('s1-paid.png');
  });

  it('variations: a variation run\'s images and pick on another shot stay', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    const variations = [{ url: '/api/outputs/v0.png', seed: 1 }, { url: '/api/outputs/v1.png', seed: 2 }];
    runSync([cinema(scene({ id: 's1', prompt: 'b' },
      { id: 's2', prompt: 'other', variations, selectedVariation: 0, output: done('/api/outputs/v0.png') }))]);
    await sleep(10);
    const { shots } = await undoAndRead();
    expect(shotOf(shots, 's1').prompt).toBe('a');
    // The canvas shows asset links absolute (the sync's rewrite).
    expect((shotOf(shots, 's2').variations as { url: string }[]).map((variation) => variation.url))
      .toEqual([expect.stringContaining('/api/outputs/v0.png'), expect.stringContaining('/api/outputs/v1.png')]);
    expect(shotOf(shots, 's2').selectedVariation).toBe(0);
  });

  it('a shot\'s image the Accept had cleared, rendered again since, is the run\'s and stays', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a', output: done('/api/outputs/old.png') }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b', output: { status: 'idle' } }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    runSync([cinema(scene({ id: 's1', prompt: 'b', output: done('/api/outputs/new-paid.png') }))]);
    await sleep(10);
    const { shots } = await undoAndRead();
    expect(shotOf(shots, 's1').prompt).toBe('a');
    expect(media(shotOf(shots, 's1'))).toContain('new-paid.png');
  });

  it('a shot the Accept added and a run rendered since stays, and the line says the scene was kept', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's3', prompt: 'new shot' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    runSync([cinema(scene({ id: 's1', prompt: 'b' }, { id: 's3', prompt: 'new shot', output: done('/api/outputs/s3-paid.png') }))]);
    await sleep(10);
    const { shots, notice } = await undoAndRead();
    expect(shotOf(shots, 's1').prompt).toBe('a');
    expect(media(shotOf(shots, 's3'))).toContain('s3-paid.png');
    expect(notice).toBe('Undid the proposal except “Scene” for “Scene”. It was changed after you accepted.');
  });

  it('an agent\'s change to another shot after Accept stays, and only its path is kept', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'x' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'y' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => {
      own([accepted]);
      socketSends({ type: 'graphSync', ...base, empty: false, edges: [],
        nodes: [cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'agent' }))],
        edit: { actor: { kind: 'agent', name: 'Codex', id: 'cx' } } });
    });
    await sleep(10);
    const { shots, notice } = await undoAndRead();
    expect(shotOf(shots, 's1').prompt).toBe('a');
    expect(shotOf(shots, 's2').prompt).toBe('agent');
    expect(notice).toBe('Undid the proposal except “Scene” for “Scene”. Codex changed it after you accepted.');
  });
});

describe('M1: the path merge itself (lib/canvasUndo)', () => {
  const asNode = (params: Record<string, unknown>, definitionId = 'cinema-scene') =>
    node('n1', params, 'Scene', definitionId) as unknown as Node<NodeData>;

  it('before ⊕ (now − set): another shot\'s new image survives, the changed prompt goes back', () => {
    const was = asNode(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other' }));
    const accepted = asNode(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other' }));
    const step = ownAddStep([], [paramChange(was, accepted)!]);
    const now = asNode(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other', output: done(PAID) }));
    rebaseAcceptedOnRunOutput(step, accepted, now);
    expect(captureOwnAdd(step, [now], [])).toEqual([]);
    const shots = (step.before.nodes.n1!.data.params.scene as { shots: Shot[] }).shots;
    expect(shots).toEqual([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other', output: done(PAID) }]);
  });

  it('a run\'s write-back to a flat key the Accept set is still put back (a normalized color)', () => {
    const was = asNode({ prompt: 'p' }, 'recraft-v4');
    const accepted = asNode({ prompt: 'p', colors: '#ff0000' }, 'recraft-v4');
    const step = ownAddStep([], [paramChange(was, accepted)!]);
    const now = asNode({ prompt: 'p', colors: [{ r: 255, g: 0, b: 0 }] }, 'recraft-v4');
    rebaseAcceptedOnRunOutput(step, accepted, now);
    expect(captureOwnAdd(step, [now], [])).toEqual([]);
    expect(step.before.nodes.n1!.data.params).toEqual({ prompt: 'p' });
  });

  it('clips snapped by a run, on a clip the Accept changed, go back with it; another clip keeps the run\'s', () => {
    const clip = (id: string, duration: number) => ({ id, duration, sourceIn: 0, sourceOut: duration });
    const was = asNode({ clips: [clip('c1', 4), clip('c2', 3)] }, 'video-edit');
    const accepted = asNode({ clips: [clip('c1', 2), clip('c2', 3)] }, 'video-edit');
    const step = ownAddStep([], [paramChange(was, accepted)!]);
    const now = asNode({ clips: [clip('c1', 1.96), clip('c2', 2.96)] }, 'video-edit');
    rebaseAcceptedOnRunOutput(step, accepted, now);
    expect(captureOwnAdd(step, [now], [])).toEqual([]);
    expect(step.before.nodes.n1!.data.params.clips).toEqual([clip('c1', 4), clip('c2', 2.96)]);
  });

  it('two changes to the same leaf: the later one stays and is named', () => {
    const was = asNode(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'x' }));
    const accepted = asNode(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'y' }));
    const step = ownAddStep([], [paramChange(was, accepted)!]);
    const now = asNode(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'agent' }));
    expect(captureOwnAdd(step, [now], [])).toEqual([{ nodeId: 'n1', keys: ['scene'], wholeNode: false }]);
    expect((step.before.nodes.n1!.data.params.scene as { shots: Shot[] }).shots)
      .toEqual([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'agent' }]);
  });

  it('a node Accept added: a run\'s write is taken path by path, so an agent\'s earlier edit still keeps it', () => {
    const added = asNode(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'x' }));
    const step = ownAddStep(['n1'], [], [added]);
    const edited = asNode(scene({ id: 's1', prompt: 'agent' }, { id: 's2', prompt: 'x' }));
    const rendered = asNode(scene({ id: 's1', prompt: 'agent' }, { id: 's2', prompt: 'x', output: done(PAID) }));
    rebaseAcceptedOnRunOutput(step, edited, rendered);
    const kept = captureOwnAdd(step, [rendered], []);
    expect(kept).toEqual([{ nodeId: 'n1', keys: ['scene'], wholeNode: true }]);
  });
});

describe('L1: the undo line names a routed node\'s settings by their card labels', () => {
  it('FLUX 1.1 [pro] Ultra\'s aspect_ratio is “Aspect Ratio”, never the key', async () => {
    const flux = (ratio: string) => node('n1', { prompt: 'p', aspect_ratio: ratio }, 'Hero', 'flux-1-1-ultra');
    useGraphStore.setState({ nodes: [flux('1:1')] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [flux('16:9')], runNodeIds: [], idMap: {} }, () => {
      own([flux('16:9')]);
      socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [flux('4:3')],
        edit: { actor: { kind: 'agent', name: 'Codex', id: 'cx' } } });
    });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Nothing was undone. Codex changed “Aspect Ratio” for “Hero” after you accepted.');
  });
});

describe('GM r1 (7): a universal node\'s setting in the undo line is its Inspector label, sentence case', () => {
  it('a Replicate model\'s guidance_scale is “Guidance scale”, even with an older Title Case label saved', async () => {
    const rep = (scale: number) => ({ ...node('n1', { model_id: 'o/m', guidance_scale: scale }, 'Hero still', 'replicate-universal'),
      type: 'dynamic-node', data: { ...node('n1', { model_id: 'o/m', guidance_scale: scale }, 'Hero still', 'replicate-universal').data,
        isDynamic: true, dynamicParams: [{ key: 'guidance_scale', label: 'Guidance Scale', type: 'float' }] } });
    useGraphStore.setState({ nodes: [rep(3)] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [rep(5)], runNodeIds: [], idMap: {} }, () => {
      own([rep(5)]);
      socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [rep(7)],
        edit: { actor: { kind: 'agent', name: 'Codex', id: 'cx' } } });
    });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Nothing was undone. Codex changed “Guidance scale” for “Hero still” after you accepted.');
  });
});

describe('GM pr198 r1: names only on one node; across nodes, the count', () => {
  const agent = { kind: 'agent' as const, name: 'Codex' };
  const unknown = { kind: 'unknown' as const };

  it('(1) settings across nodes are counted, from 2, with no ", and" grouping', () => {
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B'] }], agent, false))
      .toBe('Undid the proposal except 2 settings Codex changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C'] }], unknown, false))
      .toBe('Undid the proposal except 3 settings changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C', 'D'] }], agent, false))
      .toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
  });

  it('(1) on one node, up to 3 settings are named', () => {
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B', 'C'] }], agent, false))
      .toBe('Undid the proposal except “A”, “B” and “C” for “Hero”. Codex changed them after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B', 'C', 'D'] }], agent, false))
      .toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
  });

  it('(2) 1-3 kept nodes are named; from 4, "<N> nodes"', () => {
    const kept = (names: string[]) => names.map((name) => ({ node: name, settings: ['Name'], wholeNode: true }));
    expect(acceptUndoLine(kept(['Hero', 'Logo']), agent, false))
      .toBe('Undid the proposal except “Hero” and “Logo”. Codex changed them after you accepted.');
    expect(acceptUndoLine(kept(['A', 'B', 'C']), agent, false))
      .toBe('Undid the proposal except “A”, “B” and “C”. Codex changed them after you accepted.');
    expect(acceptUndoLine(kept(['A', 'B', 'C', 'D']), agent, false))
      .toBe('Undid the proposal except 4 nodes Codex changed after you accepted.');
  });

  it('(3) the unknown-source count', () => {
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C', 'D'] }], unknown, false))
      .toBe('Undid the proposal except 4 settings changed after you accepted.');
  });

  it('no line has the ", and" grouping', () => {
    const shapes = [
      [{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C'] }],
      [{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B', 'C'] }],
    ];
    for (const shape of shapes) expect(acceptUndoLine(shape, agent, false)).not.toContain(', and');
  });
});
