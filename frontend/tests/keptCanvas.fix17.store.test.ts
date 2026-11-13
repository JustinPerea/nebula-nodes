/**
 * Round 17 of PR #199 (GM r23, 2; GM r24; review 15 renumber-recover LOW-2),
 * the store's side, on keptCanvas.fix16.store's harness:
 * - the connections Save as a project left out are the second sentence of
 *   the notice that confirms the save, on all three endings: the copy opens
 *   here, the tab reloads for an update (the line survives the reload, as
 *   "opened after the update" does), and Save lands on Projects;
 * - a node deleted while kept takes its connections with it, so none of the
 *   four checks can fail at Save for a connection the tab still shows;
 * - review 15 HIGH-1: a sync whose `renumbered` says Nebula gave the tab's
 *   local nodes its own ids replaces them (never both), and the selection
 *   and the Inspector follow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const acts = vi.hoisted(() => ({ said: [] as Array<[string, string]> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
  notePersonAct: (kind: string, id: string) => { acts.said.push([kind, id]); },
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: unknown) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && path.startsWith('/api/graph')) {
        graphWrites.sent.push({ method, path, body: String(init?.body ?? '') });
        return graphWrites.answer ? graphWrites.answer(path, init)
          : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.apiFetch(path, init, options as never);
    },
  };
});
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { reloadPage, reportParamsOutdated } from '../src/lib/paramsOutdated';
import { checkKeptWire } from '../src/lib/keptWires';

const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id, value: string = id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string, name?: string) => { const { snapshot: _s, ...rest } = project(id, name); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const type = (value: string) => {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1')!;
  useGraphStore.getState().updateNodeData('n1', { params: { ...node.data.params, value } });
};
/** A sync carrying the canvas as Nebula has it (the tab's own nodes). */
const sync = (workspaceRevision: string, more: Record<string, unknown> = {}) => emit({ type: 'graphSync', workspaceRevision,
  paramsVersion: GRAPH_PARAMS_VERSION, nodes: useGraphStore.getState().nodes.map((node) => ({ ...node })), edges: [],
  empty: false, ...more });
/** Nebula restored its project list while running: Delta's revision is gone. */
const restoreWhileRunning = () => sync('rev-restored', { catalogRestore: 'restore-new', activeProjectId: null,
  nodes: [], edges: [], empty: true });

let notices: CanvasNoticeDetail[] = [];
const onNotice = (event: Event) => { notices.push((event as CustomEvent<CanvasNoticeDetail>).detail); };
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  graphWrites.sent = [];
  graphWrites.answer = null;
  acts.said = [];
  notices = [];
  resetProjectStoreForTests();
  resetKeptCanvasForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, lateNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b',
    paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  window.addEventListener(CANVAS_NOTICE_EVENT, onNotice);
  unsubscribe = subscribeProjectAutosave();
  // The socket's first sync: this tab's revision, no restore yet.
  sync('rev-a');
});
afterEach(async () => {
  window.removeEventListener(CANVAS_NOTICE_EVENT, onNotice);
  resetCanvasFollowForTests();
  graphWrites.answer = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  resetProjectStoreForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setProjectContext(null);
});


let pulses = 0;
let stopPulses: () => void = () => {};
beforeEach(() => { pulses = 0; stopPulses = subscribeKeptPulse(() => { pulses += 1; }); });
afterEach(() => { stopPulses(); });

/** Kept with a typed edit, a delete and its kept Undo step. */
function keepWithEdits(): void {
  type('alpha typed');
  restoreWhileRunning();
  expect(isCanvasKept()).toBe(true);
  type('alpha typed and more');
  expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
}

const canvasNode = (id: string, definitionId: string, x = 0, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x, y: 0 },
  data: { definitionId, label: id, params, state: 'idle', outputs: {} },
}) as never;
/** Kept, with these nodes beside n1 (the text input), and nothing sent yet. */
function keepWith(extra: unknown[]): void {
  useGraphStore.setState((state) => ({ nodes: [...state.nodes, ...(extra as typeof state.nodes)] }));
  keepWithEdits();
  graphWrites.sent = [];
}
const edges = () => useGraphStore.getState().edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]);
const noticeText = () => {
  const state = useGraphStore.getState();
  return [state.undoNotice?.text, state.messageNotice?.text].filter(Boolean).join(' ');
};

const DROPPED = [{ source: 'n1', sourceHandle: 'text', target: null, targetHandle: 'prompt', targetWas: 'local-7',
  sourceName: 'Hero prompt', targetName: null, kind: 'missing' }];
const DROPPED_LINE = 'Nebula left out the connection from “Hero prompt” because the node it went to isn’t on the canvas.';
const copyListing = () => listing({ projects: [summary('alpha'), summary('alpha-rec')] });

describe('GM r24 on PR #199: the left-out connections are said on every ending of Save as a project', () => {
  it('the copy opens here: the saved toast, then the line', async () => {
    keepWithEdits();
    const copy = project('alpha-rec', 'Recovered Glass campaign');
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...copy, droppedWires: DROPPED } as never);
    vi.mocked(projects.listProjects).mockResolvedValue(copyListing());
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    expect(notices.at(-1)?.text).toBe(`Your latest edits were saved as their own project, “Recovered Glass campaign”. ${DROPPED_LINE}`);
  });

  it('a staged update: the tab reloads, and the line survives the reload beside “opened after the update”', async () => {
    const newer = GRAPH_PARAMS_VERSION + 1;
    keepWithEdits();
    reportParamsOutdated(newer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('alpha-rec', 'Recovered Glass campaign'),
      droppedWires: DROPPED } as never);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: newer }));
    await useProjectStore.getState().saveKeptEdits();
    await vi.waitFor(() => expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(window.sessionStorage.getItem('nebula:recoveredForUpdate') ?? 'null'))
      .toEqual({ id: 'alpha-rec', name: 'Recovered Glass campaign', dropped: DROPPED_LINE });
    // The reload: a fresh store reads the copy back and opens it.
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    const copy = project('alpha-rec', 'Recovered Glass campaign');
    vi.mocked(projects.listProjects).mockResolvedValue({ ...copyListing(), paramsVersion: GRAPH_PARAMS_VERSION });
    vi.mocked(projects.openProject).mockResolvedValue({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    const said = vi.spyOn(useGraphStore.getState(), 'notify');
    await useProjectStore.getState().initialize();
    await vi.waitFor(() => expect(said).toHaveBeenCalled());
    expect(said.mock.calls.at(-1)?.[0]).toBe(
      `These are the changes Nebula couldn’t save before it updated. They’re in “Recovered Glass campaign”. ${DROPPED_LINE}`);
  });

  it('Save lands on Projects (the copy didn’t open): the home’s notice carries the line', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('alpha-rec', 'Recovered Glass campaign'),
      droppedWires: DROPPED } as never);
    vi.mocked(projects.listProjects).mockResolvedValue(copyListing());
    vi.mocked(projects.openProject).mockRejectedValueOnce(new Error('offline'));
    await useProjectStore.getState().saveKeptEdits();
    const state = useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(isCanvasKept()).toBe(false);
    expect(state.editsRecoveredAs).toEqual({ id: 'alpha-rec', name: 'Recovered Glass campaign', dropped: DROPPED_LINE });
  });
});

describe('GM r23 (2) and (a) on PR #199: the names in the notice', () => {
  it('a left-out connection the copy names by its new id only: the tab’s own name for the node it renumbered', async () => {
    keepWithEdits();
    const local = await useGraphStore.getState().addNode('text-input', { x: 400, y: 0 });
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => (node.id === local
      ? { ...node, data: { ...node.data, label: 'Second prompt' } } : node)) }));
    const copy = project('alpha-rec', 'Recovered Glass campaign');
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...copy, renumbered: { [local!]: 'n2' }, droppedWires: [
      { source: 'n2', sourceHandle: 'text', target: 'n1', targetHandle: 'text', kind: 'loop' }] } as never);
    vi.mocked(projects.listProjects).mockResolvedValue(copyListing());
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    expect(notices.at(-1)?.text).toBe('Your latest edits were saved as their own project, “Recovered Glass campaign”. '
      + 'Nebula left out the connection from “Second prompt” to “Hero prompt” because it connected the node to itself.');
  });

  it('an answer without the copy’s name: the tab names it “Recovered <project>”, never “(recovered)”', async () => {
    keepWithEdits();
    const copy = project('alpha-rec', 'Recovered Glass campaign');
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...copy, name: undefined } as never);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha')] }));
    vi.mocked(projects.openProject).mockRejectedValueOnce(new Error('offline'));
    await useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().editsRecoveredAs?.name).toBe('Recovered Glass campaign');
  });
});

describe('GM r23 (2) on PR #199: a node deleted while kept takes its connections with it', () => {
  it('delete a kept node with connections in and out: none is left pointing at it, and the rest still pass the rules', () => {
    keepWith([canvasNode('n2', 'seedream-4-5', 300), canvasNode('n3', 'seedream-4-5', 600)]);
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' });
    useGraphStore.getState().onConnect({ source: 'n2', sourceHandle: 'image', target: 'n3', targetHandle: 'images' });
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n3', targetHandle: 'prompt' });
    expect(edges()).toHaveLength(3);
    useGraphStore.getState().deleteNode('n2');
    const state = useGraphStore.getState();
    const ids = new Set(state.nodes.map((node) => node.id));
    expect(edges()).toEqual([['n1', 'text', 'n3', 'prompt']]);
    // A tab-only delete: its own Undo line, nothing refused or pulsed.
    expect(noticeText()).toBe('Deleted the node.');
    expect(pulses).toBe(0);
    for (const item of state.edges) {
      expect(ids.has(item.source) && ids.has(item.target)).toBe(true);
      const others = state.edges.filter((other) => other.id !== item.id);
      expect(checkKeptWire({ source: item.source, sourceHandle: item.sourceHandle ?? null, target: item.target,
        targetHandle: item.targetHandle ?? null }, state.nodes, others)).toMatchObject({ ok: true });
    }
    expect(graphWrites.sent).toEqual([]);
  });
});

describe('review 15 HIGH-1 on PR #199: the tab adopts the ids Nebula gave its local nodes', () => {
  it('a duplicate (a local id), selected and inspected; a sync renumbers it: one node, by the new id, still selected', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    const local = useGraphStore.getState().nodes.find((node) => node.id !== 'n1')!;
    expect(local.id).not.toMatch(/^n[0-9]+$/);
    useUIStore.getState().selectNode(local.id);
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: { [local.id]: 'n2' },
      nodes: [{ ...n1, selected: false }, { ...local, id: 'n2', selected: false }], edges: [] });
    const ids = useGraphStore.getState().nodes.map((node) => node.id).sort();
    expect(ids).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['n2']);
    expect(useUIStore.getState().selectedNodeId).toBe('n2');
  });

  it('the first sync after a restart (no replaced canvas) renumbers it too: the tab’s copy under the old id gives way', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    const local = useGraphStore.getState().nodes.find((node) => node.id !== 'n1')!;
    useUIStore.getState().selectNode(local.id);
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      bootId: 'boot-after-restart', renumbered: { [local.id]: 'n2' },
      nodes: [{ ...n1, selected: false }, { ...local, id: 'n2', selected: false }], edges: [] });
    expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']);
    expect(useUIStore.getState().selectedNodeId).toBe('n2');
  });

  it('a sync without `renumbered` keeps the tab’s local nodes, as before', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    const local = useGraphStore.getState().nodes.find((node) => node.id !== 'n1')!;
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      nodes: [{ ...n1 }], edges: [] });
    expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', local.id].sort());
  });
});
