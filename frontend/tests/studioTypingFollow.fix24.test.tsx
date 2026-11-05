// PR #199 round 24 (GM r23, 4): a reopen made elsewhere is followed by a
// window in a Studio, but if the person is typing in a Studio field when the
// follow arrives, the follow waits until the field loses focus, so a draft is
// never cut off. The harness is reopenStudio.fix23b's.
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

import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
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


let field: HTMLInputElement | HTMLTextAreaElement | null = null;
/** A focused text field in the document, as a Studio's prompt box is. */
function typeIn(tag: 'input' | 'textarea' = 'textarea'): HTMLInputElement | HTMLTextAreaElement {
  field = document.createElement(tag);
  document.body.appendChild(field);
  field.focus();
  expect(document.activeElement).toBe(field);
  return field;
}
afterEach(() => { field?.remove(); field = null; });
let baseline = 0;
beforeEach(() => { baseline = vi.mocked(projects.getProject).mock.calls.length; });
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const notFollowed = () => {
  expect(getProjectContext()?.revision).toBe('rev-a');
  expect(useProjectStore.getState().busy).toBe(false);
  expect(vi.mocked(projects.getProject).mock.calls.length).toBe(baseline);
};

describe('GM r23, 4: a follow waits while the person types in a Studio field', () => {
  it('waits while a Studio field has focus, then follows when it loses focus; the window stays', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    const box = typeIn();
    reopenElsewhere();
    await settle();
    notFollowed();
    expect(ui().viewMode).toBe('cinema-editor');
    box.blur();
    await landed();
    expect(ui().viewMode).toBe('cinema-editor');
    expect(ui().cinemaEditorNodeId).toBe('n1');
  });

  it('keeps waiting through typing and a move to another field of the Studio', async () => {
    useUIStore.setState({ viewMode: 'editor', editorTargetNodeId: 'n1' });
    const first = typeIn('input');
    reopenElsewhere();
    await settle();
    const second = document.createElement('textarea');
    document.body.appendChild(second);
    second.focus();
    await settle();
    notFollowed();
    second.blur();
    first.remove(); second.remove();
    await landed();
  });

  it('follows at once when no field has focus', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    (document.activeElement as HTMLElement | null)?.blur();
    reopenElsewhere();
    await landed();
  });

  it('follows at once from the canvas even with a field focused (the rule is for Studio windows)', async () => {
    useUIStore.setState({ viewMode: 'canvas' });
    typeIn();
    reopenElsewhere();
    await landed();
  });

  it('a button with focus in a Studio is not typing', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    reopenElsewhere();
    await landed();
    button.remove();
  });

  it('a field that goes away with its view releases the wait, though no focusout comes', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    const box = typeIn();
    reopenElsewhere();
    await settle();
    notFollowed();
    useUIStore.setState({ viewMode: 'canvas' });
    void box;
    await landed();
  });

  it('every sync that came while it waited is replayed, in order, the switch first', async () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    const box = typeIn();
    reopenElsewhere();
    sync('rev-a2');
    await settle();
    notFollowed();
    box.blur();
    await landed();
    expect(ui().viewMode).toBe('cinema-editor');
    expect(useProjectStore.getState().error).toBeNull();
  });
});
