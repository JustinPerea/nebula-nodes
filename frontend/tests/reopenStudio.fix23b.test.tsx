// PR #199 fix round 23, lane B, items 2 and 3 (review 21 reopen-tabs LOW-2
// and NIT-1, GM r36 item 5): the person's reopen of this project in another
// window keeps this window's studio. A window in Cinema, the video editor or
// the composition editor stays there with its node carried through the
// renumbering (and Cinema's shot selection with it); a studio whose node is
// gone goes to the canvas. The canvas view stays the window's own, so the
// next save doesn't store a null viewport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {}, notePersonAct: () => {},
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
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
  getOpenHold: vi.fn(async () => ({ hold: null })),
}));

import { captureProjectSnapshot, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';

const initial = useProjectStore.getState();
const realCanSwitch = useGraphStore.getState().canSwitchProject;
const P = 'Glass campaign';

const textNode = (id: string, label = 'Hero prompt') => ({ id, type: 'model-node', position: { x: 10, y: 20 },
  data: { definitionId: 'text-input', label, params: { value: id }, state: 'idle', outputs: {} } });
/** Project `id` as Nebula stores it, with the nodes `ids`. */
function project(id = 'alpha', ids: string[] = ['n1']): SavedProject {
  return {
    id, name: id === 'alpha' ? P : id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: ids.length, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: ids.map((nodeId) => textNode(nodeId)), edges: [], runHistory: [], viewport: null, createSessionId: null },
  } as unknown as SavedProject;
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const sync = (workspaceRevision: string) => emit({ type: 'graphSync', workspaceRevision,
  paramsVersion: GRAPH_PARAMS_VERSION, nodes: useGraphStore.getState().nodes.map((node) => ({ ...node })), edges: [],
  empty: false });

/** The person reopened this project in another window: Nebula's switch, with
 * the ids it gave this window's tab-local nodes (`renumbered`). */
const reopenElsewhere = (renumbered: Record<string, string> = {}, actor: Record<string, unknown> = { kind: 'person', tab: 'tab-window-a' }) => {
  const to = (id: string) => renumbered[id] ?? id;
  emit({ type: 'graphSync', workspaceRevision: 'rev-a2', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
    graphReplaced: true, renumbered,
    projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor, created: false },
    nodes: useGraphStore.getState().nodes.map((node) => ({ ...node, id: to(node.id), selected: false })), edges: [] });
};
const landed = async () => {
  await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
  await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
};
/** A node only this window has (a duplicate it hasn't saved), with a local id. */
function localNode(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: false })) }));
  return local.id;
}
/** Holds getProject's answer until `release()`, to act during the follow. */
function holdTheLoad(ids: string[]) {
  const waiting: Array<() => void> = [];
  let released = false;
  vi.mocked(projects.getProject).mockImplementation((id) => (released ? Promise.resolve(project(id, ids))
    : new Promise((resolve) => { waiting.push(() => resolve(project(id, ids))); })));
  return () => { released = true; for (const go of waiting.splice(0)) go(); };
}
const ui = () => useUIStore.getState();

let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  resetKeptCanvasForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, lateNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null,
    canSwitchProject: realCanSwitch });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null, editorTargetNodeId: null,
    remotionEditorTargetNodeId: null, cinemaEditorNodeId: null, cinemaSelectedShotIds: {}, characterEditorId: null,
    moodboardEditorId: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  unsubscribe = subscribeProjectAutosave();
  sync('rev-a');
  // From here the follow reads the reopened project.
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
});
afterEach(async () => {
  resetCanvasFollowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  resetProjectStoreForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setProjectContext(null);
});

const STUDIOS = [['cinema-editor', 'cinemaEditorNodeId'], ['editor', 'editorTargetNodeId'],
  ['remotion-editor', 'remotionEditorTargetNodeId']] as const;

describe('review 21 LOW-2 (GM r36 item 5): a window in a studio stays there through the person’s reopen elsewhere', () => {
  for (const [mode, key] of STUDIOS) {
    it(`${mode}: its node still exists under the same id: the window stays, editing it`, async () => {
      useUIStore.setState({ viewMode: mode, [key]: 'n1' } as never);
      reopenElsewhere();
      await landed();
      expect(ui().viewMode).toBe(mode);
      expect((ui() as unknown as Record<string, unknown>)[key]).toBe('n1');
    });

    it(`${mode}: its node had a tab-local id: the window stays, editing it under its new id`, async () => {
      const local = localNode();
      vi.mocked(projects.getProject).mockImplementation(async (id) => project(id, ['n1', 'n2']));
      useUIStore.setState({ viewMode: mode, [key]: local } as never);
      reopenElsewhere({ [local]: 'n2' });
      await landed();
      expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']);
      expect(ui().viewMode).toBe(mode);
      expect((ui() as unknown as Record<string, unknown>)[key]).toBe('n2');
    });

    it(`${mode}: its node is gone from the reopened project: the window goes to the canvas`, async () => {
      const local = localNode();
      // The reopened project holds only n1: the node this window edits isn't in it.
      useUIStore.setState({ viewMode: mode, [key]: local } as never);
      reopenElsewhere();
      await landed();
      expect(ui().viewMode).toBe('canvas');
      expect((ui() as unknown as Record<string, unknown>)[key]).toBeNull();
    });
  }

  it('cinema-editor: the shot selection stays, on the node’s new id; a selection on a node that’s gone goes', async () => {
    const local = localNode();
    const gone = localNode();
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id, ['n1', 'n2']));
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: local,
      cinemaSelectedShotIds: { [local]: 'shot-2', n1: 'shot-7', [gone]: 'shot-9' } });
    reopenElsewhere({ [local]: 'n2' });
    await landed();
    expect(ui().viewMode).toBe('cinema-editor');
    expect(ui().cinemaEditorNodeId).toBe('n2');
    expect(ui().cinemaSelectedShotIds).toEqual({ n2: 'shot-2', n1: 'shot-7' });
  });

  it('the Character and Moodboard studios keep their assets (their ids aren’t canvas nodes)', async () => {
    useUIStore.setState({ viewMode: 'character-editor', characterEditorId: 'char-1', moodboardEditorId: 'mood-1' });
    reopenElsewhere();
    await landed();
    expect(ui().viewMode).toBe('character-editor');
    expect(ui().characterEditorId).toBe('char-1');
    expect(ui().moodboardEditorId).toBe('mood-1');
  });

  it('a window the person moved to another studio during the follow stays where they took it', async () => {
    const release = holdTheLoad(['n1']);
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    reopenElsewhere();
    await vi.waitFor(() => expect(vi.mocked(projects.getProject)).toHaveBeenCalled());
    // The person opens n1 in the video editor meanwhile.
    useUIStore.setState({ viewMode: 'editor', editorTargetNodeId: 'n1' });
    release();
    await landed();
    expect(ui().viewMode).toBe('editor');
    expect(ui().editorTargetNodeId).toBe('n1');
  });

  it('a window the person moved to another node in the same studio during the follow stays on that node', async () => {
    const release = holdTheLoad(['n1', 'n2']);
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    reopenElsewhere();
    await vi.waitFor(() => expect(vi.mocked(projects.getProject)).toHaveBeenCalled());
    useUIStore.setState({ cinemaEditorNodeId: 'n2' });
    release();
    await landed();
    expect(ui().viewMode).toBe('cinema-editor');
    expect(ui().cinemaEditorNodeId).toBe('n2');
  });

  it('an agent’s reopen of the same project still takes the window to the canvas', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1', cinemaSelectedShotIds: { n1: 'shot-1' } });
    reopenElsewhere({}, { kind: 'agent', name: 'Codex' });
    await landed();
    expect(ui().viewMode).toBe('canvas');
    expect(ui().cinemaEditorNodeId).toBeNull();
  });
});

describe('review 21 NIT-1: the canvas view stays the window’s own, and its next save keeps it', () => {
  const VIEW = { x: 312, y: -442, zoom: 3.71 };

  it('after the follow the stored viewport is the view (not null), and the next save sends it', async () => {
    useUIStore.setState({ canvasViewport: VIEW });
    reopenElsewhere();
    await landed();
    expect(ui().canvasViewport).toEqual(VIEW);
    expect(captureProjectSnapshot().viewport).toEqual(VIEW);
    vi.mocked(projects.saveProject).mockClear();
    // The person's next edit saves (AUTOSAVE_MS).
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, position: { x: 99, y: 99 } })) }));
    await vi.waitFor(() => expect(vi.mocked(projects.saveProject)).toHaveBeenCalled(), { timeout: 3000 });
    const saved = vi.mocked(projects.saveProject).mock.calls.at(-1)![1];
    expect(saved.viewport).toEqual(VIEW);
  });

  it('a pan during the follow is the person’s own: it stays', async () => {
    const release = holdTheLoad(['n1']);
    useUIStore.setState({ canvasViewport: VIEW });
    reopenElsewhere();
    await vi.waitFor(() => expect(vi.mocked(projects.getProject)).toHaveBeenCalled());
    const pan = { x: 5, y: 6, zoom: 0.5 };
    useUIStore.setState({ canvasViewport: pan });
    release();
    await landed();
    expect(ui().canvasViewport).toEqual(pan);
  });

  it('an agent’s reopen takes the project’s stored view, as before', async () => {
    useUIStore.setState({ canvasViewport: VIEW });
    reopenElsewhere({}, { kind: 'agent', name: 'Codex' });
    await landed();
    expect(ui().canvasViewport).toBeNull();
  });
});
