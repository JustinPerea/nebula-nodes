import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

/**
 * PR #198 fix round 2 (review 2, GM's round-2 rulings):
 * - M1: no undo snapshot carries a transient run status (a shot's optimistic
 *   'running', a node's executing/queued), and a shot that is rendering
 *   can't be removed (GM: block it).
 * - L2: inside a clip the Accept changed, whatever the run wrote there goes
 *   back with it (speed and duration stay consistent); shot images don't.
 * - L3: a list both the Accept and someone since reordered: Undo says so.
 * - N3: Redo after a run keeps the run's shot media and its flat keys.
 * - N5: a part a run's render kept never names an agent.
 * - GM ask 3: an unlabeled setting is "a setting on “<node>”" in the line,
 *   its raw key in the Agent log.
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

const { useGraphStore, paramSaveFailedLine } = await import('../../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { acceptUndoLine, captureOwnAdd, ownAddStep, paramChange, rebaseAcceptedOnRunOutput } =
  await import('../../src/lib/canvasUndo');

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
const agentSync = (nodes: unknown[], name = 'Codex') => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
  edit: { actor: { kind: 'agent', name, id: 'cx' } } });
const windowSync = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
  edit: { tab: 'another-tab', actor: { kind: 'person' } } });
const runSync = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], runParams: 'shot-run', nodes });

type Shot = Record<string, unknown>;
const scene = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (params: Record<string, unknown>) => node('n1', params, 'Scene', 'cinema-scene');
const done = (url: string) => ({ imageUrl: url, status: 'done' });
const media = (shot: Shot | undefined) => String((shot?.output as { imageUrl?: string } | undefined)?.imageUrl ?? '');
const shotsNow = () => ((useGraphStore.getState().nodes.find((n) => n.id === 'n1')?.data.params.scene as { shots: Shot[] })?.shots ?? []);
const shotOf = (shots: Shot[], id: string) => shots.find((shot) => shot.id === id) as Shot;

async function step(action: 'undo' | 'redo') {
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(json({}));
  useGraphStore.getState()[action]();
  await sleep(30);
  const bodies = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { nodes: { params?: Record<string, unknown> }[] });
  return { bodies, notice: useGraphStore.getState().undoNotice?.text ?? null };
}

// -- M1 ----------------------------------------------------------------------------

describe('M1: no undo step carries a transient run status', () => {
  it('a snapshot taken while a shot renders holds it settled: "done" with its image, else "idle"', () => {
    useGraphStore.setState({ nodes: [{ ...cinema(scene(
      { id: 's1', prompt: 'a', output: { imageUrl: '/api/outputs/old.png', status: 'running' } },
      { id: 's2', prompt: 'b', output: { status: 'running' } },
      { id: 's3', prompt: 'c' })), data: { ...cinema({}).data, state: 'executing',
      params: scene({ id: 's1', prompt: 'a', output: { imageUrl: '/api/outputs/old.png', status: 'running' } },
        { id: 's2', prompt: 'b', output: { status: 'running' } }, { id: 's3', prompt: 'c' }) } }] } as never);
    // An edit to s3 pushes the step.
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
      shots: current.shots.map((shot) => (shot.id === 's3' ? { ...shot, prompt: 'typed' } : shot)) }));
    const snapshot = useGraphStore.getState().undoStack.at(-1) as { nodes: Node<NodeData>[] };
    const held = (snapshot.nodes[0].data.params.scene as { shots: Shot[] }).shots;
    expect(shotOf(held, 's1').output).toEqual({ imageUrl: '/api/outputs/old.png', status: 'done' });
    expect(shotOf(held, 's2').output).toEqual({ status: 'idle' });
    expect(snapshot.nodes[0].data.state).not.toBe('executing');
  });

  it('an agent\'s edit landing while a shot renders: its step holds the shot settled too', () => {
    const running = cinema(scene({ id: 's1', prompt: 'a', output: { status: 'running' } }, { id: 's2', prompt: 'b' }));
    useGraphStore.setState({ nodes: [running] } as never);
    agentSync([cinema(scene({ id: 's1', prompt: 'a', output: { status: 'running' } }, { id: 's2', prompt: 'agent' }))]);
    const entry = useGraphStore.getState().undoStack.at(-1) as { before: { nodes: Record<string, Node<NodeData>> } };
    const held = (entry.before.nodes.n1.data.params.scene as { shots: Shot[] }).shots;
    expect((shotOf(held, 's1').output as { status: string }).status).toBe('idle');
  });

  it('an Undo while a shot still renders keeps its spinner (the step holds it settled, the canvas keeps it live)', async () => {
    const running = cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b', output: { status: 'running' } }));
    useGraphStore.setState({ nodes: [running] } as never);
    agentSync([cinema(scene({ id: 's1', prompt: 'agent' }, { id: 's2', prompt: 'b', output: { status: 'running' } }))]);
    await step('undo');
    expect(shotOf(shotsNow(), 's1').prompt).toBe('a');
    expect((shotOf(shotsNow(), 's2').output as { status: string }).status).toBe('running');
    // The person's own step too.
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
      shots: current.shots.map((shot) => (shot.id === 's1' ? { ...shot, prompt: 'typed' } : shot)) }));
    await step('undo');
    expect((shotOf(shotsNow(), 's2').output as { status: string }).status).toBe('running');
  });

  it('a shot that is rendering can\'t be removed: nothing changes and nothing is sent', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b', output: { status: 'running' } }))] } as never);
    fetchMock.mockClear();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(10);
    expect(shotsNow().map((shot) => shot.id)).toEqual(['s1', 's2']);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
    // A shot that isn't rendering still goes.
    useGraphStore.getState().removeShot('n1', 's1');
    expect(shotsNow().map((shot) => shot.id)).toEqual(['s2']);
  });
});

// -- L2 ----------------------------------------------------------------------------

describe('L2: in a clip the Accept changed, the run\'s writes go back with it', () => {
  const asNode = (params: Record<string, unknown>, definitionId = 'video-edit') => node('n1', params, 'Cut', definitionId) as unknown as Node<NodeData>;
  const undoOf = (was: Node<NodeData>, accepted: Node<NodeData>, now: Node<NodeData>) => {
    const s = ownAddStep([], [paramChange(was, accepted)!]);
    rebaseAcceptedOnRunOutput(s, accepted, now);
    const kept = captureOwnAdd(s, [now], []);
    return { kept, params: s.before.nodes.n1?.data.params as { clips: Record<string, unknown>[] } };
  };
  const clip = (id: string, speed: number, duration: number, sourceOut = 4) => ({ id, start: 0, duration, sourceIn: 0, sourceOut, speed });

  it('P2: Accept set only c1\'s speed; the run derived its duration: Undo puts both back', () => {
    const { params, kept } = undoOf(asNode({ clips: [clip('c1', 1, 4)] }), asNode({ clips: [clip('c1', 2, 4)] }),
      asNode({ clips: [clip('c1', 2, 2)] }));
    expect(params.clips[0]).toMatchObject({ speed: 1, duration: 4, sourceOut: 4 });
    expect(kept).toEqual([]);
  });

  it('P2b: a frame-snapped sourceOut goes back with the clip too', () => {
    const { params } = undoOf(asNode({ clips: [clip('c1', 1, 4)] }), asNode({ clips: [clip('c1', 2, 2)] }),
      asNode({ clips: [clip('c1', 2, 1.98, 3.96)] }));
    expect(params.clips[0]).toMatchObject({ speed: 1, duration: 4, sourceOut: 4 });
  });

  it('another clip keeps the run\'s write; a shot image the run made stays', () => {
    const { params } = undoOf(asNode({ clips: [clip('c1', 1, 4), clip('c2', 1, 3)] }),
      asNode({ clips: [clip('c1', 2, 4), clip('c2', 1, 3)] }),
      asNode({ clips: [clip('c1', 2, 2), clip('c2', 1, 2.96, 2.96)] }));
    expect(params.clips[1]).toMatchObject({ duration: 2.96, sourceOut: 2.96 });
    const was = cinema(scene({ id: 's1', prompt: 'a', output: done('/old.png') })) as unknown as Node<NodeData>;
    const accepted = cinema(scene({ id: 's1', prompt: 'b', output: done('/old.png') })) as unknown as Node<NodeData>;
    const now = cinema(scene({ id: 's1', prompt: 'b', output: done('/new.png') })) as unknown as Node<NodeData>;
    const s = ownAddStep([], [paramChange(was, accepted)!]);
    rebaseAcceptedOnRunOutput(s, accepted, now);
    captureOwnAdd(s, [now], []);
    const shot = ((s.before.nodes.n1!.data.params.scene as { shots: Shot[] }).shots)[0];
    expect(shot.prompt).toBe('a');
    expect(media(shot)).toBe('/new.png');
  });
});

// -- L3 ----------------------------------------------------------------------------

describe('L3: both sides reordered the same list: Undo says so', () => {
  it('P3b: the order is kept and named as one item', () => {
    const asNode = (params: Record<string, unknown>) => cinema(params) as unknown as Node<NodeData>;
    const was = asNode(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }));
    const accepted = asNode(scene({ id: 's2', prompt: 'b' }, { id: 's1', prompt: 'a' }, { id: 's3', prompt: 'c' }));
    const now = asNode(scene({ id: 's3', prompt: 'c' }, { id: 's2', prompt: 'b' }, { id: 's1', prompt: 'a' }));
    const s = ownAddStep([], [paramChange(was, accepted)!]);
    const kept = captureOwnAdd(s, [now], []);
    expect(kept).toEqual([{ nodeId: 'n1', keys: [], wholeNode: false, order: 'shots' }]);
  });

  it('GM\'s lines, by who reordered', () => {
    const order = [{ node: 'Opening', settings: [], order: 'shots' as const }];
    expect(acceptUndoLine(order, { kind: 'you' }, true)).toBe('Nothing was undone. You reordered the shots in another window after you accepted.');
    expect(acceptUndoLine(order, { kind: 'agent', name: 'Codex' }, true)).toBe('Nothing was undone. Codex reordered the shots after you accepted.');
    expect(acceptUndoLine(order, { kind: 'unknown' }, true)).toBe('Nothing was undone. The shots were reordered after you accepted.');
    expect(acceptUndoLine(order, { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except the shot order in “Opening”. Codex reordered the shots after you accepted.');
    expect(acceptUndoLine([{ node: 'Cut', settings: [], order: 'clips' as const }], { kind: 'you' }, false))
      .toBe('Undid the proposal except the clip order in “Cut”. You reordered them in another window after you accepted.');
    expect(acceptUndoLine([{ node: 'Cut', settings: [], order: 'clips' as const }], { kind: 'unknown' }, false))
      .toBe('Undid the proposal except the clip order in “Cut”. The clips were reordered after you accepted.');
  });

  it('in the store: Undo never silently uses up the step', async () => {
    const clips = (...ids: string[]) => node('n1', { clips: ids.map((id) => ({ id, duration: 1 })) }, 'Cut', 'video-edit');
    useGraphStore.setState({ nodes: [clips('c1', 'c2', 'c3')] } as never);
    const accepted = clips('c2', 'c1', 'c3');
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => {
      own([accepted]);
      windowSync([clips('c3', 'c2', 'c1')]);
    });
    await sleep(10);
    const { notice } = await step('undo');
    expect(notice).toBe('Nothing was undone. You reordered the clips in another window after you accepted.');
  });
});

// -- N3 ----------------------------------------------------------------------------

describe('N3: Redo after a run keeps what the run wrote', () => {
  it('P1: Accept, Undo, s2 renders, Redo: s2\'s image never leaves the canvas', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'other' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    await step('undo');
    runSync([cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other', output: done(PAID) }))]);
    await sleep(10);
    const { bodies } = await step('redo');
    expect(shotOf(shotsNow(), 's1').prompt).toBe('b');
    expect(media(shotOf(shotsNow(), 's2'))).toContain('paid-s2.png');
    expect(media(shotOf((bodies[0].nodes[0].params?.scene as { shots: Shot[] }).shots, 's2'))).toContain('paid-s2.png');
  });

  it('P10: the person\'s own Cinema step: Undo after a render keeps the render', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'other' }))] } as never);
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
      shots: current.shots.map((shot) => (shot.id === 's1' ? { ...shot, prompt: 'typed' } : shot)) }));
    await sleep(10);
    runSync([cinema(scene({ id: 's1', prompt: 'typed' }, { id: 's2', prompt: 'other', output: done(PAID) }))]);
    await sleep(10);
    await step('undo');
    expect(shotOf(shotsNow(), 's1').prompt).toBe('a');
    expect(media(shotOf(shotsNow(), 's2'))).toContain('paid-s2.png');
  });

  it('P1b: a flat key a run wrote between Undo and Redo stays', async () => {
    useGraphStore.setState({ nodes: [node('n1', { value: 'a', other: 'o' }, 'Brief')] } as never);
    const accepted = node('n1', { value: 'b', other: 'o' }, 'Brief');
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => own([accepted]));
    await sleep(10);
    await step('undo');
    runSync([node('n1', { value: 'a', other: 'run-wrote' }, 'Brief')]);
    await sleep(10);
    const { bodies } = await step('redo');
    const params = useGraphStore.getState().nodes[0].data.params;
    expect(params).toMatchObject({ value: 'b', other: 'run-wrote' });
    expect(bodies[0].nodes[0].params).toMatchObject({ value: 'b', other: 'run-wrote' });
  });
});

// -- N5 ----------------------------------------------------------------------------

describe('N5: what a run\'s render kept never names an agent', () => {
  it('a shot the Accept added and a run rendered: the line drops the actor', async () => {
    useGraphStore.setState({ nodes: [cinema(scene({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'x' }))] } as never);
    const accepted = cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'x' }, { id: 's3', prompt: 'new' }));
    await acceptWith({ nodes: [], edges: [], updatedNodes: [accepted], runNodeIds: [], idMap: {} }, () => {
      own([accepted]);
      // Codex edits another shot, so it is the scene's last toucher.
      agentSync([cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'codex' }, { id: 's3', prompt: 'new' }))]);
    });
    await sleep(10);
    runSync([cinema(scene({ id: 's1', prompt: 'b' }, { id: 's2', prompt: 'codex' },
      { id: 's3', prompt: 'new', output: done('/api/outputs/s3.png') }))]);
    await sleep(10);
    const { notice } = await step('undo');
    expect(shotOf(shotsNow(), 's1').prompt).toBe('a');
    expect(notice).toBe('Undid the proposal except “Scene” for “Scene”. It was changed after you accepted.');
  });
});

// -- GM ask 3 ----------------------------------------------------------------------

describe('GM ask 3: an unlabeled setting is "a setting on “<node>”"; the Agent log keeps its key', () => {
  it('the undo line and the log', async () => {
    const fal = (scale: number, steps: number) => node('n1', { endpoint_id: 'fal-ai/flux', guidance_scale: scale, num_steps: steps },
      'Flux', 'fal-universal');
    const logged: string[] = [];
    const listen = (event: Event) => logged.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:agent-log-entry', listen);
    useGraphStore.setState({ nodes: [fal(3, 10)] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [fal(5, 20)], runNodeIds: [], idMap: {} }, () => {
      own([fal(5, 20)]);
      agentSync([fal(7, 20)]);
    });
    await sleep(10);
    const { notice } = await step('undo');
    window.removeEventListener('nebula:agent-log-entry', listen);
    expect(notice).toBe('Undid the proposal except a setting on “Flux”. Codex changed it after you accepted.');
    expect(logged).toContain('Undid the proposal except “guidance_scale” for “Flux”. Codex changed it after you accepted.');
  });

  it('the line\'s forms', () => {
    expect(acceptUndoLine([{ node: 'Flux', settings: [null] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except a setting on “Flux”. Codex changed it after you accepted.');
    expect(acceptUndoLine([{ node: 'Flux', settings: [null] }], { kind: 'unknown' }, false))
      .toBe('Undid the proposal except a setting on “Flux”. It was changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Flux', settings: [null] }], { kind: 'agent', name: 'Codex' }, true))
      .toBe('Nothing was undone. Codex changed a setting on “Flux” after you accepted.');
    // More than one, one of them unlabeled: counted, never a raw key.
    expect(acceptUndoLine([{ node: 'Flux', settings: ['Prompt', null] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except 2 settings Codex changed after you accepted.');
  });

  it('the save-failed toast', () => {
    expect(paramSaveFailedLine([null], 'Flux', true)).toBe("Couldn't save a setting on “Flux”. It's back to its last saved value.");
    expect(paramSaveFailedLine(['Prompt', null], 'Flux', false)).toBe("Couldn't save 2 settings for “Flux”.");
  });
});
