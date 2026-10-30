/**
 * Fix round 11 of PR #199 (review 11; GM r14 and r15).
 * - HIGH-1 and GM r15, Q11: a restore while the person types keeps the
 *   canvas where they are, with GM r12, 1's line and [Save as a project] in
 *   the canvas notice region. Nothing typed is reverted or sent; typing goes
 *   on and joins the kept edits; the button files everything typed up to the
 *   click, opens that project and shows the saved toast.
 * - The tab learns of the restore from the backend's graphSync, and from
 *   `projectsChanged{catalogRestored}` when that sync is late or lost.
 * - GM r14, 3: an agent's write that closed the project the tab showed: its
 *   line on Projects home, or kept in the tab with the edits not saved.
 * - LOW-2: a restore (or a reconnect) lets the person's next edit say
 *   `personInput` again. GM r15, Q10: the person's log row says "kept".
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

import { keptEditsLine, resetProjectStoreForTests, RESTORED_LIST_UNSAVED, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { editsRecoveredToast } from '../src/components/projects/catalogRestoreCopy';

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
const valueOf = () => useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value;
const nodePuts = () => graphWrites.sent.filter((write) => write.path === '/api/graph/node/n1' && write.method === 'PUT');
const outOfDate = () => Promise.resolve(new Response(JSON.stringify({ detail: 'This canvas is out of date. Open the current project before editing or running it.' }),
  { status: 409, headers: { 'Content-Type': 'application/json' } }));
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

describe('review 11, HIGH-1 and GM r15, Q11: a restore while the person types', () => {
  it('keeps the canvas where the person is, with the line, and puts nothing typed back', async () => {
    expect(getProjectContext()?.id).toBe('alpha');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Nebula refuses the node save as out of date: the restore came first.
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT' ? outOfDate()
      : Promise.resolve(new Response('{}', { status: 200 })));
    vi.mocked(projects.saveProject).mockRejectedValue(new Error('HTTP 404'));
    type('alpha unsaved-edit');
    await vi.waitFor(() => expect(nodePuts().length).toBe(1));
    restoreWhileRunning();
    const state = useProjectStore.getState();
    expect(isCanvasKept()).toBe(true);
    expect(state).toMatchObject({ screen: 'workspace', dirty: true, saveStatus: 'unsaved', error: null,
      keptEdits: { sourceId: 'alpha', sourceName: 'Glass campaign', saving: false, error: null } });
    expect(keptEditsLine(state.keptEdits!)).toBe(RESTORED_LIST_UNSAVED);
    // Past the parked save's 15 s and the autosave: nothing is sent again,
    // nothing is put back, and no "couldn't save" line.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(valueOf()).toBe('alpha unsaved-edit');
    expect(nodePuts().length).toBe(1);
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(useProjectStore.getState()).toMatchObject({ saveStatus: 'unsaved', saveError: null, error: null });
    // Closing the tab meanwhile gets the unload warning.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('the person keeps typing after the line shows: kept, never sent, never reverted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    type('alpha one');
    restoreWhileRunning();
    expect(isCanvasKept()).toBe(true);
    const saves = vi.mocked(projects.saveProject).mock.calls.length;
    type('alpha one two');
    type('alpha one two three');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(valueOf()).toBe('alpha one two three');
    expect(nodePuts()).toEqual([]);
    expect(vi.mocked(projects.saveProject).mock.calls.length).toBe(saves);
    // A later sync (an agent's edit elsewhere) doesn't replace the line.
    sync('rev-restored-2', { catalogRestore: 'restore-new' });
    expect(useProjectStore.getState().keptEdits).not.toBeNull();
    expect(valueOf()).toBe('alpha one two three');
  });

  it('every other edit is refused while kept, and the line pulses', async () => {
    type('alpha typed');
    restoreWhileRunning();
    expect(isCanvasKept()).toBe(true);
    graphWrites.sent = [];
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    // GM r19 (5) and review 13 kept-scratch LOW-2: an added node and a
    // rename are the kept tab's own now (nothing sent).
    const before = useGraphStore.getState().nodes.length;
    const added = await useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    expect(added).not.toBeNull();
    expect(useGraphStore.getState().nodes.length).toBe(before + 1);
    useGraphStore.getState().renameNode('n1', 'New name');
    expect(useGraphStore.getState().nodes[0].data.label).toBe('New name');
    expect(pulses).toBe(0);
    // GM r21 (3): a wire is the kept tab's own too, by the server's rules:
    // a text input has no input, so this one is refused and never drawn
    // (keptCanvas.fix16.store has the rest). Nothing is sent either way.
    const edges = useGraphStore.getState().edges.length;
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: added!, targetHandle: 'text' });
    expect(useGraphStore.getState().edges.length).toBe(edges);
    expect(graphWrites.sent).toEqual([]);
    // Any other edit is refused, with a pulse.
    useGraphStore.getState().clearGraph();
    expect(pulses).toBeGreaterThan(0);
    stop();
  });

  it('[Save as a project] files everything typed up to the click, opens it, and says so', async () => {
    type('alpha typed');
    restoreWhileRunning();
    type('alpha typed and more');
    let finish: (value: SavedProject) => void = () => {};
    vi.mocked(projects.recoverProject).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const saving = useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().keptEdits?.saving).toBe(true);
    // Typing while it is on its way would be lost when the project opens: refused.
    type('alpha after the click');
    expect(valueOf()).toBe('alpha typed and more');
    const [source, snapshot, , version, name] = vi.mocked(projects.recoverProject).mock.calls[0];
    expect(source).toBe('alpha');
    expect(name).toBe('Glass campaign');
    expect(version).toBe(GRAPH_PARAMS_VERSION);
    expect(snapshot.nodes[0]?.data.params.value).toBe('alpha typed and more');
    const recovered = project('rec', 'Glass campaign (recovered)', 'alpha typed and more');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('beta'), summary('rec', 'Glass campaign (recovered)')],
      activeProjectId: null, workspaceRevision: 'rev-restored' }));
    vi.mocked(projects.openProject).mockResolvedValue({ project: recovered, workspaceRevision: 'rev-rec',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    finish(recovered);
    await saving;
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('rec', 'rev-restored');
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'rec' }, keptEdits: null });
    expect(valueOf()).toBe('alpha typed and more');
    expect(notices).toContainEqual({ text: editsRecoveredToast('Glass campaign (recovered)'), tone: 'info' });
    expect(editsRecoveredToast('Glass campaign (recovered)')).toBe(
      'Your latest edits were saved as their own project, “Glass campaign (recovered)”.');
    // The person's click is their own open of it.
    expect(acts.said).not.toContainEqual(['personOpen', 'alpha']);
    // Nothing was ever saved over the project the restore took away.
    expect(vi.mocked(projects.saveProject).mock.calls.filter(([id]) => id === 'alpha').map(([, snap]) => snap.nodes[0]?.data.params.value))
      .not.toContain('alpha typed and more');
  });

  it('[Save as a project] opens the saved project even with a save of the gone project still hanging, and refuses typing until it is open', async () => {
    // The project's own save went out before the restore and never answers
    // (the live SAVEAS check found the open waiting behind it).
    vi.mocked(projects.saveProject).mockImplementation(() => new Promise(() => {}));
    type('alpha typed');
    void useProjectStore.getState().flush();
    await vi.waitFor(() => expect(vi.mocked(projects.saveProject)).toHaveBeenCalled());
    restoreWhileRunning();
    expect(isCanvasKept()).toBe(true);
    const recovered = project('rec', 'Glass campaign (recovered)', 'alpha typed');
    vi.mocked(projects.recoverProject).mockResolvedValue(recovered);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('beta'), summary('rec', 'Glass campaign (recovered)')],
      activeProjectId: null, workspaceRevision: 'rev-restored' }));
    let opened: (value: unknown) => void = () => {};
    vi.mocked(projects.openProject).mockImplementation(() => new Promise((resolve) => { opened = resolve; }) as never);
    const saving = useProjectStore.getState().saveKeptEdits();
    await vi.waitFor(() => expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('rec', 'rev-restored'));
    // Filed, the open on its way: still kept, typing refused, nothing put back.
    expect(isCanvasKept()).toBe(true);
    type('alpha typed while it opens');
    expect(valueOf()).toBe('alpha typed');
    opened({ project: recovered, workspaceRevision: 'rev-rec', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' });
    await saving;
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'rec' }, keptEdits: null,
      dirty: false, saveStatus: 'saved' });
    expect(notices).toContainEqual({ text: editsRecoveredToast('Glass campaign (recovered)'), tone: 'info' });
  });

  it('a failed save keeps the canvas and says why; Try again sends the same recovery id', async () => {
    type('alpha typed');
    restoreWhileRunning();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(new Error('network'));
    await useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().keptEdits).toMatchObject({ saving: false });
    expect(useProjectStore.getState().keptEdits?.error).toBeTruthy();
    expect(isCanvasKept()).toBe(true);
    // The person can type again; a retry of an unchanged canvas reuses the id.
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(new Error('network'));
    await useProjectStore.getState().saveKeptEdits();
    const ids = vi.mocked(projects.recoverProject).mock.calls.map((call) => call[2]);
    expect(ids[0]).toBe(ids[1]);
    type('alpha typed again');
    expect(valueOf()).toBe('alpha typed again');
  });

  it('`projectsChanged{catalogRestored}` alone reaches the tab too (the sync late or lost)', async () => {
    type('alpha typed');
    vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0',
      workspaceRevision: 'rev-restored', catalogRestore: 'restore-new', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    emit({ type: 'projectsChanged', change: 'catalogRestored', projectId: null });
    await vi.waitFor(() => expect(useProjectStore.getState().keptEdits).not.toBeNull());
    expect(useProjectStore.getState().screen).toBe('workspace');
    // The sync arriving after it is the same restore: nothing changes.
    restoreWhileRunning();
    expect(useProjectStore.getState().keptEdits).toMatchObject({ sourceId: 'alpha', lead: null });
  });

  it('the fallback never acts on a restore the tab already saw', async () => {
    restoreWhileRunning();
    // Nothing unsaved: home, as before.
    await vi.waitFor(() => expect(useProjectStore.getState().screen).toBe('home'));
    const fetches = vi.mocked(execution.fetchCLIGraph).mock.calls.length;
    emit({ type: 'projectsChanged', change: 'catalogRestored', projectId: null });
    expect(vi.mocked(execution.fetchCLIGraph).mock.calls.length).toBe(fetches);
  });
});

describe("GM r14, 3: an agent's write closed the project this tab showed", () => {
  const closes = (action: string, agent: string | null) => sync('rev-closed', { activeProjectId: null,
    personsCanvasSaved: { id: `s-${action}`, projectId: 'alpha', name: 'Glass campaign', action, agent, copy: null } });

  it.each([
    ['clear', 'Codex', 'Codex cleared the canvas. “Glass campaign” is kept as its own project.'],
    ['replace', 'Codex', 'Codex replaced the canvas. “Glass campaign” is kept as its own project.'],
    ['change', 'Codex', 'Codex made its changes on a copy of “Glass campaign”. “Glass campaign” is kept as it was.'],
    ['clear', null, 'An agent cleared the canvas. “Glass campaign” is kept as its own project.'],
  ])('nothing unsaved (%s, %s): home, with the line as a toast', async (action, agent, line) => {
    closes(action, agent);
    await vi.waitFor(() => expect(useProjectStore.getState().screen).toBe('home'));
    expect(useProjectStore.getState()).toMatchObject({ error: null, switchNotice: null, agentClosedNote: { text: line } });
  });

  it("where it can't go home: the same line, then \"Reload projects to continue.\"", () => {
    const real = useGraphStore.getState().canSwitchProject;
    useGraphStore.setState({ canSwitchProject: () => false });
    try { closes('clear', 'Codex'); } finally { useGraphStore.setState({ canSwitchProject: real }); }
    expect(useProjectStore.getState().error).toBe(
      'Codex cleared the canvas. “Glass campaign” is kept as its own project. Reload projects to continue.');
  });

  it('with edits not saved: kept in the tab with the line and [Save as a project]', () => {
    type('alpha typed');
    closes('change', 'Codex');
    const kept = useProjectStore.getState().keptEdits!;
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(keptEditsLine(kept)).toBe("Codex made its changes on a copy of “Glass campaign”. “Glass campaign” is kept as it was. "
      + "Your latest edits weren’t saved yet. They’re kept in this tab.");
  });
});

describe("review 11, LOW-2: a restore lets the person's next edit say `personInput` again", () => {
  const edit = () => { useGraphStore.getState().beginUndoStep(); useGraphStore.getState().endUndoStep(); };

  it('a new restore id on the same revision, and a reconnect', () => {
    useProjectStore.setState({ screen: 'workspace' });
    useGraphStore.getState().beginUndoStep();
    useGraphStore.getState().beginUndoStep();
    expect(acts.said.filter(([kind]) => kind === 'personInput')).toEqual([['personInput', 'alpha']]);
    // A restore that protected Alpha again (same revision: the tab stays).
    sync('rev-a', { catalogRestore: 'restore-reprotect' });
    useGraphStore.getState().beginUndoStep();
    expect(acts.said.filter(([kind]) => kind === 'personInput').length).toBe(2);
    emit({ type: 'socketReconnected' });
    useGraphStore.getState().beginUndoStep();
    expect(acts.said.filter(([kind]) => kind === 'personInput').length).toBe(3);
    void edit;
  });
});

describe('GM r15, Q10: the person\'s log row when the canvas already was a project', () => {
  it.each([
    ['changed', true, 'Codex made its changes on a copy of “My film”. “My film” is kept as it was.'],
    ['cleared', false, 'Codex cleared the canvas. “My film” is kept as its own project.'],
    ['replaced', false, 'Codex replaced the canvas. “My film” is kept as its own project.'],
  ])('%s', (action, copy, line) => {
    const rows: string[] = [];
    const listen = (event: Event) => rows.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:agent-log-entry', listen);
    emit({ type: 'projectsChanged', change: 'canvasHeld', projectId: null,
      canvasHeld: { action, agent: 'Codex', agentId: 'a1', color: '#0af', savedAs: 'My film', kept: true, ...(copy ? { copy: true } : {}) } });
    window.removeEventListener('nebula:agent-log-entry', listen);
    expect(rows).toEqual([line]);
  });
});
