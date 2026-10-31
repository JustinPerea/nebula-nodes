/**
 * Round 19 of PR #199, the store's side, on keptCanvas.fix18.store's harness:
 * - review 17 drops-locks-ui MEDIUM-2: GM r26 4's stopgap lines say "after
 *   you reopen the project"; Projects → Open of the project already open
 *   sent nothing, so the lock stayed. With a node only this tab has, the
 *   open now goes to Nebula, which gives it its `nN` id, and the lines lift;
 * - GM r28, 1: a drop on a handle of the same kind says GM's line, on kept
 *   and normal tabs alike, through the store's sayRefusedDrop;
 * - GM r27, 3: Nebula's reopen that can't be followed says what to do;
 * - review 17 drops-locks-ui NIT: a card addDynamicNode shows while Nebula
 *   makes the node isn't a tab-local node (no stopgap line flashes).
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
import { isTabLocalNode, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { followingSwitch, resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';

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



const OUTPUTS = 'Couldn’t connect two outputs. Drag from an output to an input.';
const INPUTS = 'Couldn’t connect two inputs. Drag from an output to an input.';

/** Duplicate n1: a node only this tab has, by a tab-local id. */
function duplicateN1(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  return local.id;
}

describe('review 17 drops-locks-ui MEDIUM-2: Projects → Open of the open project gives a duplicate its id', () => {
  it('the open goes to Nebula after a save, and the duplicate comes back as n2: the stopgap lifts', async () => {
    const local = duplicateN1();
    expect(isTabLocalNode(local)).toBe(true);
    const reopened = project('alpha');
    reopened.snapshot.nodes.push({ ...reopened.snapshot.nodes[0], id: 'n2', position: { x: 300, y: 20 } });
    vi.mocked(projects.openProject).mockResolvedValue({ project: reopened, workspaceRevision: 'rev-a2',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0', renumbered: { [local]: 'n2' } } as never);
    vi.mocked(projects.saveProject).mockClear();
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('alpha', 'rev-a');
    // Everything the tab had went to the project first (activate's flush), the duplicate included.
    const saved = vi.mocked(projects.saveProject).mock.calls.at(-1)!;
    expect(saved[0]).toBe('alpha');
    expect(JSON.stringify(saved[1])).toContain(local);
    expect(vi.mocked(projects.saveProject).mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(vi.mocked(projects.openProject).mock.invocationCallOrder[0]);
    const ids = useGraphStore.getState().nodes.map((node) => node.id).sort();
    expect(ids).toEqual(['n1', 'n2']);
    expect(ids.some(isTabLocalNode)).toBe(false);
    expect(useProjectStore.getState().screen).toBe('workspace');
  });

  it('with no node only this tab has, the open sends nothing (as before)', async () => {
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
  });

  it('kept: the open of the project shown sends nothing; the kept lines say what unlocks', async () => {
    keepWithEdits();
    duplicateN1();
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    await useProjectStore.getState().open('alpha');
    stop();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(true);
    // The shortcut (back to the canvas shown), never the kept refusal of an open of another project.
    expect(pulses).toBe(0);
    expect(useProjectStore.getState().screen).toBe('workspace');
  });
});

describe('GM r28, 1: a drop on a handle of the same kind', () => {
  const seedreams = () => [canvasNode('s1', 'seedream-4-5', 400), canvasNode('s2', 'seedream-4-5', 800)];
  it('a normal tab: two outputs, two inputs, GM’s lines; nothing drawn or sent', () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, ...seedreams()] }));
    expect(useGraphStore.getState().sayRefusedDrop({ nodeId: 's1', handleId: 'image', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 's2', id: 'image', type: 'source' } })).toBe(true);
    expect(noticeText()).toBe(OUTPUTS);
    expect(useGraphStore.getState().sayRefusedDrop({ nodeId: 's1', handleId: 'prompt', handleType: 'target' },
      { isValid: false, toHandle: { nodeId: 's2', id: 'prompt', type: 'target' } })).toBe(true);
    expect(noticeText()).toBe(INPUTS);
    expect(edges()).toEqual([]);
    expect(graphWrites.sent).toEqual([]);
  });

  it('kept: the same lines', () => {
    keepWith(seedreams());
    useGraphStore.getState().sayRefusedDrop({ nodeId: 's1', handleId: 'image', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 's2', id: 'image', type: 'source' } });
    expect(noticeText()).toContain(OUTPUTS);
    expect(graphWrites.sent).toEqual([]);
  });

  it('not a refusal on a handle: false, and nothing said (the canvas may open its popup)', () => {
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, ...seedreams()], undoNotice: null, messageNotice: null }));
    expect(useGraphStore.getState().sayRefusedDrop({ nodeId: 'n1', handleId: 'text', handleType: 'source' },
      { isValid: null, toHandle: null })).toBe(false);
    expect(noticeText()).toBe('');
  });
});

describe('GM r27, 3: Nebula’s own reopen that the tab can’t follow says what to do', () => {
  it('“Nebula opened “P”, but this tab couldn’t follow it.”', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-boot', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: {},
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'system' }, created: false },
      nodes: [{ ...n1 }], edges: [] });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    // GM r29, 1 (round 20): on Projects the line ends at the failure, beside [Open “…”]; the tab says “tab”.
    expect(useProjectStore.getState().error).toBe('Nebula opened “Glass campaign”, but this tab couldn’t follow it.');
    expect(followingSwitch()).toBeNull();
  });

  it('an agent’s says ’ too', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, renumbered: {},
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
        previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'agent', name: 'Codex' }, created: false },
      nodes: [{ ...n1 }], edges: [] });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    expect(useProjectStore.getState().error).toMatch(/^Codex opened “Glass campaign”, but this tab couldn’t follow it\./);
  });
});

describe('review 17 drops-locks-ui NIT: a dynamic node’s card while Nebula makes it', () => {
  it('isn’t a tab-local node, and its nN id replaces it', async () => {
    let answer: (value: Response) => void = () => {};
    graphWrites.answer = (path) => (path === '/api/graph/node'
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const temp = useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 400, y: 0 })!;
    expect(temp).not.toMatch(/^n[0-9]+$/);
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node')).toBe(true));
    expect(isTabLocalNode(temp)).toBe(false);
    answer(new Response(JSON.stringify({ id: 'n9' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(useGraphStore.getState().nodes.some((node) => node.id === 'n9')).toBe(true));
    expect(isTabLocalNode('n9')).toBe(false);
    // A duplicate is one.
    expect(isTabLocalNode(duplicateN1())).toBe(true);
  });
});
