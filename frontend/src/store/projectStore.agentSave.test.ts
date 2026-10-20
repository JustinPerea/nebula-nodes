import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An agent's edit reaches the tab as one graphSync that is already a whole,
// coalesced batch, so it saves at once: "Saving…", then "Saved", never
// "Unsaved changes". The camera moves the canvas makes itself (its fit after
// the agent's nodes land, the reveal after an arrange) never restart or
// extend the person's 600 ms autosave debounce, and a camera-only change the
// canvas makes after an agent edit is saved along with it, quietly. The
// person's own edits, pans and zooms keep the debounce and the label they had
// (found live by #108's review, 2026-10-20).

vi.mock('../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/personSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/personSession')>()),
  // The person's own tab: its camera is part of what it saves.
  holdsPersonCredential: vi.fn(() => true),
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  renameProject: vi.fn(),
  listProjects: vi.fn(),
  recoverProject: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSnapshot, SavedProject } from '../lib/projects';

const saveProject = vi.mocked(api.saveProject);
const summary = {
  id: 'p1', name: 'Demo board', createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
};
const saved = (snapshot: ProjectSnapshot): SavedProject => ({ ...summary, snapshot });
const noViewOf = (): ProjectSnapshot => ({ nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null });

const textNode = (id: string, x = 0) => ({
  id, type: 'model', position: { x, y: 0 },
  data: { definitionId: 'text-input', label: 'Text', params: { value: `prompt ${id}` }, outputs: {} },
});
const agent = { kind: 'agent', id: 'app-1', name: 'Claude Code', color: '#f80' };
/** The graphSync an agent's edit_canvas (or `nebula apply`) sends: the whole graph, marked as its edit. */
const agentEdit = (ids: string[]) => ({
  type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
  nodes: ids.map((id, index) => textNode(id, index * 300)), edges: [], edit: { actor: agent },
});
/** The sync that finishes an agent's arrange: the layout the canvas measured and wrote, not an edit. */
const arrangedSync = (ids: string[]) => ({
  type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
  nodes: ids.map((id, index) => textNode(id, index * 420)), edges: [], moved: ids,
  arranged: { id: 'arr-1', nodeIds: ids },
});

/** What wsClient does with a message: the "first" handlers, then every ordinary one (the graph store's). */
function dispatch(event: unknown): void {
  const first = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!first) throw new Error('not subscribed');
  first(event as never);
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) handler(event as never);
}

/** The label states the workspace controls showed, in order (ProjectWorkspaceControls). */
let labels: string[] = [];
let stopWatching: () => void = () => {};
function watchLabel(): void {
  labels = [useProjectStore.getState().saveStatus];
  stopWatching = useProjectStore.subscribe((state) => {
    if (labels.at(-1) !== state.saveStatus) labels.push(state.saveStatus);
  });
}
const savedNodeCounts = () => saveProject.mock.calls.map(([, snapshot]) => snapshot.nodes.length);
/** The canvas's own move: its fit after an agent's nodes land, or an arrange's reveal. */
const canvasMoves = (viewport: { x: number; y: number; zoom: number }) =>
  useUIStore.getState().setCanvasViewport(viewport, { byCanvas: true } as never);

let unsubscribe: () => void = () => {};

beforeEach(async () => {
  resetProjectStoreForTests();
  vi.useFakeTimers();
  saveProject.mockReset();
  saveProject.mockImplementation(async (_id, snapshot) => saved(snapshot));
  setProjectContext({ id: 'p1', revision: 'r1' });
  // A new project, open and saved: empty, at the camera the canvas placed.
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
  useUIStore.setState({ canvasViewport: { x: 0, y: 0, zoom: 1 }, viewMode: 'canvas' });
  useProjectStore.setState({
    screen: 'workspace', initialized: true, busy: false, activeProject: summary, workspaceRevision: 'r1',
    dirty: false, saveStatus: 'saved', error: null, switchNotice: null,
  });
  await useProjectStore.getState().flush();
  saveProject.mockClear();
  unsubscribe = subscribeProjectAutosave();
  watchLabel();
});

afterEach(() => {
  stopWatching();
  unsubscribe();
  vi.useRealTimers();
});

describe('an agent’s edit saves at once', () => {
  it('goes straight to a save: Saving…, then Saved, with no Unsaved changes in between', async () => {
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    // Guarded from the moment it lands, before the request is out.
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'saving' });
    // No debounce: the save goes before any timer runs.
    await vi.advanceTimersByTimeAsync(0);
    expect(savedNodeCounts()).toEqual([3]);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
    expect(labels).toEqual(['saved', 'saving', 'saved']);
  });

  it('the canvas’s fit that follows is saved with it, never as a separate dirty state', async () => {
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    // The fit after the nodes land: 80 ms later, a 400 ms animation.
    await vi.advanceTimersByTimeAsync(80);
    for (let frame = 1; frame <= 25; frame += 1) {
      canvasMoves({ x: -frame * 10, y: -frame * 4, zoom: 1 - frame * 0.01 });
      await vi.advanceTimersByTimeAsync(16);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).not.toContain('unsaved');
    expect(labels.at(-1)).toBe('saved');
    // Saved: the agent's nodes, then the camera the fit ended on.
    expect(saveProject.mock.calls.at(-1)?.[1].viewport).toEqual({ x: -250, y: -100, zoom: 0.75 });
    expect(saveProject.mock.calls.at(-1)?.[1].nodes).toHaveLength(3);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
    // One save for the edit and one for where the canvas settled, not one per frame.
    expect(saveProject).toHaveBeenCalledTimes(2);
  });

  it('a fit that runs while the agent’s save is out rides along with that save', async () => {
    let answer: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => { answer = () => resolve(saved(snapshot)); }));
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    for (let frame = 1; frame <= 10; frame += 1) {
      canvasMoves({ x: -frame * 10, y: 0, zoom: 1 });
      await vi.advanceTimersByTimeAsync(16);
    }
    answer();
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).not.toContain('unsaved');
    expect(saveProject.mock.calls.at(-1)?.[1].viewport).toEqual({ x: -100, y: 0, zoom: 1 });
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('React Flow measuring the new nodes while their save is out changes nothing saved, so it stays Saving…', async () => {
    let answer: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => { answer = () => resolve(saved(snapshot)); }));
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    // The ResizeObserver's dimension changes: a new nodes array, the same project.
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, measured: { width: 280, height: 160 } })) }));
    expect(useProjectStore.getState().saveStatus).toBe('saving');
    answer();
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).toEqual(['saved', 'saving', 'saved']);
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it('the layout the canvas writes for the agent’s nodes (its arrange) saves without Unsaved changes', async () => {
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(400);
    dispatch(arrangedSync(['n1', 'n2', 'n3']));
    expect(useProjectStore.getState().saveStatus).not.toBe('unsaved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).not.toContain('unsaved');
    expect(saveProject.mock.calls.at(-1)?.[1].nodes.map((node) => node.position.x)).toEqual([0, 420, 840]);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('React Flow measuring the arranged nodes before that layout saves doesn’t read Unsaved changes either', async () => {
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(400);
    dispatch(arrangedSync(['n1', 'n2', 'n3']));
    // The ResizeObserver runs after the sync, in a later frame.
    await vi.advanceTimersByTimeAsync(16);
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, measured: { width: 280, height: 160 } })) }));
    expect(useProjectStore.getState().saveStatus).toBe('saved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).not.toContain('unsaved');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('two batches in quick succession: one save at a time, and the newer state wins', async () => {
    const answers: Array<() => void> = [];
    saveProject.mockImplementation((_id, snapshot) => new Promise((resolve) => { answers.push(() => resolve(saved(snapshot))); }));
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    dispatch(agentEdit(['n1', 'n2', 'n3', 'n4', 'n5']));
    await vi.advanceTimersByTimeAsync(0);
    // The second waits for the first to answer.
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'saving' });
    answers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(savedNodeCounts()).toEqual([3, 5]);
    expect(useProjectStore.getState().saveStatus).toBe('saving');
    answers[1]();
    await vi.advanceTimersByTimeAsync(2000);
    expect(savedNodeCounts()).toEqual([3, 5]);
    expect(labels).toEqual(['saved', 'saving', 'saved']);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('a sync that writes the graph twice, while an earlier save is out, still never reads Unsaved changes', async () => {
    // The graph store can write more than once for one sync (provider
    // recoveries, then the merge). Everything it writes is the edit's.
    const answers: Array<() => void> = [];
    saveProject.mockImplementation((_id, snapshot) => new Promise((resolve) => { answers.push(() => resolve(saved(snapshot))); }));
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    dispatch(agentEdit(['n1', 'n2', 'n3', 'n4']));
    // A second write in the same dispatch, before the task ends.
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id === 'n4'
      ? { ...node, data: { ...node.data, params: { ...node.data.params, value: 'recovered' } } } : node) }));
    await vi.advanceTimersByTimeAsync(16);
    // React Flow measures n4 while the first save is still out.
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, measured: { width: 280, height: 160 } })) }));
    expect(useProjectStore.getState().saveStatus).toBe('saving');
    answers[0]();
    await vi.advanceTimersByTimeAsync(0);
    answers[1]?.();
    await vi.advanceTimersByTimeAsync(2000);
    answers.slice(2).forEach((answer) => answer());
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels).toEqual(['saved', 'saving', 'saved']);
    expect(saveProject.mock.calls.at(-1)?.[1].nodes[3]?.data.params.value).toBe('recovered');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('a failed save of an agent’s edit reads unsaved and keeps the unload prompt armed', async () => {
    saveProject.mockRejectedValueOnce(new Error('Disk full'));
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    const whileSaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(whileSaving);
    expect(whileSaving.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'error', error: 'Disk full' });
    const afterFailure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterFailure);
    expect(afterFailure.defaultPrevented).toBe(true);
  });
});

describe('the person’s own changes keep the debounce', () => {
  const personEdits = (value: string) => useGraphStore.setState({ nodes: [{ ...textNode('n1'),
    data: { ...textNode('n1').data, params: { value } } }] as never });

  it('an edit reads Unsaved changes and saves 600 ms after the last change', async () => {
    personEdits('typed');
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.advanceTimersByTimeAsync(599);
    expect(saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(labels).toEqual(['saved', 'unsaved', 'saving', 'saved']);
  });

  it('the wait runs from the person’s last edit: React Flow measuring a node meanwhile doesn’t restart it', async () => {
    personEdits('typed');
    await vi.advanceTimersByTimeAsync(400);
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, measured: { width: 280, height: 190 } })) }));
    await vi.advanceTimersByTimeAsync(200);
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it('a pan or zoom reads Unsaved changes and waits the same 600 ms', async () => {
    useUIStore.getState().setCanvasViewport({ x: 40, y: 0, zoom: 1 });
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.advanceTimersByTimeAsync(300);
    useUIStore.getState().setCanvasViewport({ x: 80, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(599);
    expect(saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveProject.mock.calls[0][1].viewport).toEqual({ x: 80, y: 0, zoom: 1 });
  });

  it('a fit the canvas makes while an edit waits doesn’t extend the wait, and goes with that save', async () => {
    personEdits('typed');
    await vi.advanceTimersByTimeAsync(400);
    for (let frame = 1; frame <= 12; frame += 1) {
      canvasMoves({ x: -frame * 10, y: 0, zoom: 1 });
      await vi.advanceTimersByTimeAsync(16);
    }
    // 400 + 12 × 16 = 592 ms: the person's save is still due at 600.
    await vi.advanceTimersByTimeAsync(8);
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(saveProject.mock.calls[0][1].viewport).toEqual({ x: -120, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('an edit made while the canvas’s own fit waits to save still waits its full 600 ms', async () => {
    dispatch(agentEdit(['n1', 'n2', 'n3']));
    await vi.advanceTimersByTimeAsync(0);
    for (let frame = 1; frame <= 5; frame += 1) {
      canvasMoves({ x: -frame * 10, y: 0, zoom: 1 });
      await vi.advanceTimersByTimeAsync(16);
    }
    // The fit's quiet save is due 300 ms after its last frame; the person types 100 ms in.
    await vi.advanceTimersByTimeAsync(100);
    saveProject.mockClear();
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id === 'n1'
      ? { ...node, data: { ...node.data, params: { value: 'typed' } } } : node) }));
    expect(useProjectStore.getState().saveStatus).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(599);
    expect(saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    // That one save takes the fit's camera along.
    expect(saveProject.mock.calls[0][1].viewport).toEqual({ x: -50, y: 0, zoom: 1 });
    expect(saveProject.mock.calls[0][1].nodes[0]?.data.params.value).toBe('typed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('an edit made while a rename holds the tab busy reads Unsaved changes once it’s done, and saves', async () => {
    let renamed: () => void = () => {};
    vi.mocked(api.renameProject).mockImplementationOnce(() => new Promise((resolve) => { renamed = () => resolve(saved(noViewOf())); }));
    const renaming = useProjectStore.getState().rename('p1', 'Demo board, renamed');
    await vi.advanceTimersByTimeAsync(0);
    personEdits('typed while renaming');
    expect(useProjectStore.getState().saveStatus).toBe('saved');
    renamed();
    await renaming;
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.advanceTimersByTimeAsync(600);
    expect(saveProject.mock.calls.at(-1)?.[1].nodes[0]?.data.params.value).toBe('typed while renaming');
  });

  it('an edit of the person’s during an agent’s save still reads Unsaved changes and debounces after it', async () => {
    let answer: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => { answer = () => resolve(saved(snapshot)); }));
    dispatch(agentEdit(['n1']));
    await vi.advanceTimersByTimeAsync(0);
    personEdits('typed while the agent saved');
    expect(useProjectStore.getState().saveStatus).toBe('unsaved');
    answer();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveProject.mock.calls.at(-1)?.[1].nodes[0]?.data.params.value).toBe('typed while the agent saved');
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });
});
