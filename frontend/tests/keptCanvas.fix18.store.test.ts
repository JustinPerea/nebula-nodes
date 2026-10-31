/**
 * Round 18 of PR #199, the store's side, on keptCanvas.fix17.store's harness:
 * - review 16 HIGH-1: an agent that reopens the project this tab shows gave
 *   its duplicated node Nebula's id; the handoff the tab sends speaks of it
 *   by that id (never the old one, which Nebula would add back beside it);
 * - GM r26, 3: a connection the canvas refused at the drop says why, on
 *   kept and normal tabs alike (the store's sayRefusedConnection, which
 *   Canvas.onConnectEnd calls for a drop isValidConnection refused);
 * - review 16 kept-ui LOW-1: after a scene edit, a Cinema node's Character
 *   refs keep every connection, on kept and normal tabs;
 * - review 16 kept-ui LOW-3: the reload line names the project a recovered
 *   copy was made from, never "Recovered Recovered …";
 * - review 16 MEDIUM-1: the first sync after a boot that renumbered the
 *   open project's tab-local nodes is Nebula's own reopen of it (actor
 *   system): the tab follows it as an agent's reopen, so its run history
 *   takes the new id and its next autosave can't write the old one back,
 *   with no agent named, no toast and no way back.
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
import { followingReason, followingSwitch, resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests } from '../src/lib/keptCanvas';

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


describe('review 16 HIGH-1: an agent reopens the project this tab shows', () => {
  it('the handoff carries the duplicate under the id the open gave it, with the latest typing', async () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    const local = useGraphStore.getState().nodes.find((node) => node.id !== 'n1')!;
    expect(local.id).not.toMatch(/^n[0-9]+$/);
    useGraphStore.getState().updateNodeData(local.id, { params: { ...local.data.params, value: 'dup typed late' } });
    // A connection out of the duplicate (into a node Nebula holds): its end follows the new id.
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, canvasNode('n5', 'seedream-4-5', 400)],
      edges: [...state.edges, { id: 'e-dup', source: local.id, sourceHandle: 'text', target: 'n5', targetHandle: 'prompt' }] }));
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a2', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: { [local.id]: 'n2' },
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'agent', name: 'Codex' } },
      nodes: [{ ...n1, selected: false }, { ...local, id: 'n2', selected: false }], edges: [] });
    await vi.waitFor(() => expect(vi.mocked(projects.saveProject)).toHaveBeenCalled());
    const handoff = vi.mocked(projects.saveProject).mock.calls.at(-1)!;
    expect(handoff[0]).toBe('alpha');
    const sent = handoff[1] as SavedProject['snapshot'];
    expect(sent.nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2', 'n5']);
    expect(sent.edges.map((item) => [item.source, item.target])).toEqual([['n2', 'n5']]);
    expect(sent.nodes.find((node) => node.id === 'n2')?.data.params.value).toBe('dup typed late');
    expect(JSON.stringify(handoff)).not.toContain(local.id);
  });

  it('a reopen that renumbered nothing sends the snapshot as it was', async () => {
    type('alpha typed');
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a2', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true,
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'agent', name: 'Codex' } },
      nodes: [{ ...n1 }], edges: [] });
    await vi.waitFor(() => expect(vi.mocked(projects.saveProject)).toHaveBeenCalled());
    const sent = vi.mocked(projects.saveProject).mock.calls.at(-1)![1] as SavedProject['snapshot'];
    expect(sent.nodes.map((node) => [node.id, node.data.params.value])).toEqual([['n1', 'alpha typed']]);
  });
});

describe('GM r26, 3: a refused drop says why, on kept and normal tabs alike', () => {
  const seedream = () => canvasNode('s1', 'seedream-4-5', 400);
  it('a normal tab: the wrong kind, in GM’s words, masks named', () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, seedream()] }));
    useGraphStore.getState().sayRefusedConnection({ source: 'n1', sourceHandle: 'text', target: 's1', targetHandle: 'images' });
    expect(noticeText()).toBe('Couldn’t connect to “References”. It takes images and masks, not text.');
    expect(graphWrites.sent).toEqual([]);
  });

  it('a normal tab: a loop says GM’s loop line', () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, canvasNode('a', 'seedream-4-5', 400), canvasNode('b', 'seedream-4-5', 800)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'images' }] }));
    useGraphStore.getState().sayRefusedConnection({ source: 'b', sourceHandle: 'image', target: 'a', targetHandle: 'images' });
    expect(noticeText()).toBe('Couldn’t connect to “References”. It would make a loop.');
  });

  it('kept: the same line, nothing drawn or sent', () => {
    keepWith([seedream()]);
    const before = edges();
    useGraphStore.getState().sayRefusedConnection({ source: 'n1', sourceHandle: 'text', target: 's1', targetHandle: 'images' });
    expect(noticeText()).toContain('Couldn’t connect to “References”. It takes images and masks, not text.');
    expect(edges()).toEqual(before);
    expect(graphWrites.sent).toEqual([]);
  });

  it('a drop the rules take says nothing', () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, seedream()], undoNotice: null, messageNotice: null }));
    useGraphStore.getState().sayRefusedConnection({ source: 'n1', sourceHandle: 'text', target: 's1', targetHandle: 'prompt' });
    expect(noticeText()).toBe('');
  });
});

describe('review 16 kept-ui LOW-1: a Cinema scene’s Character refs keep every connection after a scene edit', () => {
  const cinemaWithShot = () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, canvasNode('cin', 'cinema-scene', 400),
      canvasNode('i1', 'image-input', 0), canvasNode('i2', 'image-input', 0)] }));
    useGraphStore.getState().addShot('cin');
    const data = useGraphStore.getState().nodes.find((node) => node.id === 'cin')!.data as unknown as { isDynamic?: boolean;
      dynamicInputPorts?: Array<{ id: string; multiple?: boolean }> };
    expect(data.isDynamic).toBe(true);
    // The scene edit keeps the definition's inputs, as a loaded file does.
    expect(data.dynamicInputPorts?.find((port) => port.id === 'character_refs')?.multiple).toBe(true);
  };
  const refs = () => useGraphStore.getState().edges.filter((edge) => edge.target === 'cin' && edge.targetHandle === 'character_refs')
    .map((edge) => edge.source).sort();

  it('a normal tab: two references stay', () => {
    cinemaWithShot();
    useGraphStore.getState().onConnect({ source: 'i1', sourceHandle: 'image', target: 'cin', targetHandle: 'character_refs' });
    useGraphStore.getState().onConnect({ source: 'i2', sourceHandle: 'image', target: 'cin', targetHandle: 'character_refs' });
    expect(refs()).toEqual(['i1', 'i2']);
  });

  it('kept: two references stay', () => {
    cinemaWithShot();
    keepWithEdits();
    useGraphStore.getState().onConnect({ source: 'i1', sourceHandle: 'image', target: 'cin', targetHandle: 'character_refs' });
    useGraphStore.getState().onConnect({ source: 'i2', sourceHandle: 'image', target: 'cin', targetHandle: 'character_refs' });
    expect(refs()).toEqual(['i1', 'i2']);
  });
});

describe('review 16 MEDIUM-1: Nebula’s reopen after a boot renumbering', () => {
  it('the tab follows it: run history takes the new id, nothing names an agent, no toast', async () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    const local = useGraphStore.getState().nodes.find((node) => node.id !== 'n1')!;
    const record = (target: string) => ({ id: 'r1', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: target,
      snapshot: { nodes: [{ id: target, definitionId: 'text-input', params: { value: 'dup' }, outputs: {} }], edges: [] } });
    useGraphStore.setState({ runHistory: [record(local.id)] as never });
    // What Nebula holds after its boot: the project with the duplicate as n2,
    // its run history remapped, under the new workspace revision.
    const saved = project('alpha');
    saved.snapshot.nodes.push({ ...saved.snapshot.nodes[0], id: 'n2', position: { x: 300, y: 20 } });
    saved.snapshot.runHistory = [record('n2')] as never;
    vi.mocked(projects.getProject).mockImplementation(async (id) => (id === 'alpha' ? saved : project(id)));
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-boot' }));
    let whileFollowing = '';
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => {
      whileFollowing = followingReason(followingSwitch());
      return { ...project(id), snapshot };
    });
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-boot', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: { [local.id]: 'n2' },
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'system' }, created: false },
      nodes: [{ ...n1, selected: false }, { ...local, id: 'n2', selected: false }], edges: [] });
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    await vi.waitFor(() => expect(followingSwitch()).toBeNull());
    // The handoff went under the new id (the tab's end of HIGH-1).
    const handoff = vi.mocked(projects.saveProject).mock.calls.at(-1)!;
    expect(handoff[0]).toBe('alpha');
    expect(JSON.stringify(handoff[1])).not.toContain(local.id);
    expect(whileFollowing).toBe('Nebula is opening “Glass campaign”.');
    // Run history follows the reopen.
    expect(useGraphStore.getState().runHistory.map((item) => item.targetNodeId)).toEqual(['n2']);
    expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']);
    // No toast, no way back, no agent named anywhere.
    expect(useProjectStore.getState().switchNotice).toBeNull();
    expect(noticeText()).not.toMatch(/agent|outside app/i);
    expect(useProjectStore.getState().screen).toBe('workspace');
    // The next autosave speaks of n2 only.
    vi.mocked(projects.saveProject).mockClear();
    type('after the boot');
    await vi.waitFor(() => expect(vi.mocked(projects.saveProject)).toHaveBeenCalled(), { timeout: 3000 });
    const next = JSON.stringify(vi.mocked(projects.saveProject).mock.calls.at(-1)![1]);
    expect(next).not.toContain(local.id);
    expect(next).toContain('after the boot');
  });

  it('a script’s reopen (actor anonymous) still says who opened it: only Nebula’s own is quiet', async () => {
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-a2', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: {},
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'anonymous' }, created: false },
      nodes: [{ ...n1 }], edges: [] });
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(useProjectStore.getState().switchNotice?.actorName ?? null).toBeNull();
  });

  it('a follow that fails names Nebula, not another app', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-boot', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: {},
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'system' }, created: false },
      nodes: [{ ...n1 }], edges: [] });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    expect(useProjectStore.getState().error).toMatch(/^Nebula opened “Glass campaign”, but this window couldn't follow it\./);
  });

  it('a run pressed while following names Nebula', async () => {
    expect(followingReason({ agent: null, projectName: 'Glass campaign', byNebula: true })).toBe('Nebula is opening “Glass campaign”.');
    expect(followingReason({ agent: null, projectName: 'Glass campaign' })).toBe('An agent is opening “Glass campaign”.');
    setFollowingSwitch({ projectName: 'Glass campaign', agent: null, byNebula: true });
    await useGraphStore.getState().executeGraph();
    expect(noticeText()).toBe('Couldn\'t run the canvas. Nebula is opening “Glass campaign”.');
    setFollowingSwitch(null);
  });
});
