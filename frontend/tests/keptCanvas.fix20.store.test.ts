/**
 * Round 20 of PR #199 (GM r29): Nebula's own reopen this tab couldn't
 * follow ends on Projects with [Open “…”]; the reload line names the project
 * Nebula recorded with the recovered copy; open proposals survive a reopen
 * of the same project.
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

import { projectRetryOffer, reopenHold, reopenHoldLine, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import type { ProposalView } from '../src/lib/wsClient';
import { tabLocalDeletes, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';
import { TAB_ID } from '../src/lib/tabId';

const initial = useProjectStore.getState();
const realCanSwitch = useGraphStore.getState().canSwitchProject;

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
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null,
    canSwitchProject: realCanSwitch });
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




const bootSwitch = (more: Record<string, unknown> = {}) => {
  const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
  emit({ type: 'graphSync', workspaceRevision: 'rev-boot', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
    graphReplaced: true, renumbered: {},
    projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'system' }, created: false },
    nodes: [{ ...n1 }], edges: [], ...more });
};

describe('GM r29, 1: Nebula’s own reopen this tab couldn’t follow, on Projects', () => {
  it('the line ends at the failure, and the box offers [Open “Glass campaign”] in place of Try again', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    bootSwitch();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    const state = useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(state.error).toBe('Nebula opened “Glass campaign”, but this tab couldn’t follow it.');
    expect(state.errorRetry).toEqual({ action: 'openFollowed', id: 'alpha', name: 'Glass campaign' });
    expect(projectRetryOffer(state)).toBe('openFollowed');
  });

  it('[Open “Glass campaign”] loads the projects and opens that project', async () => {
    vi.mocked(projects.listProjects).mockRejectedValueOnce(new Error('down'));
    bootSwitch();
    await vi.waitFor(() => expect(useProjectStore.getState().errorRetry?.action).toBe('openFollowed'));
    // The listing works again, and says another project is open now: the button still opens the one it names.
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-c' }));
    vi.mocked(projects.openProject).mockResolvedValue({ project: project('alpha'), workspaceRevision: 'rev-d',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
    await useProjectStore.getState().retry();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('alpha'));
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('an agent’s follow that fails keeps Try again and its reason', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    bootSwitch({ projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'agent', name: 'Codex' }, created: false } });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    expect(useProjectStore.getState().errorRetry).toEqual({ action: 'load' });
    expect(projectRetryOffer(useProjectStore.getState())).toBe('redo');
  });
});

describe('GM r29, 2: the reload line names what was actually recovered', () => {
  const update = () => {
    type('Unsaved edit');
    useProjectStore.setState({ activeProject: null });
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: GRAPH_PARAMS_VERSION + 1, nodes: [], edges: [], empty: true });
  };
  const line = (source: string) => `Couldn’t save your changes because Nebula was updated. Reload Nebula and they’ll open in a recovered copy of “${source}”.`;

  it('“Recovered Shot 7 copy” made from “Shot 7 copy”: the line says “Shot 7 copy”', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered', 'Recovered Shot 7 copy'), sourceName: 'Shot 7 copy' });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(line('Shot 7 copy')));
  });

  it('the same name made from “Shot 7”: the line says “Shot 7”, never a source read from the copy’s name', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered', 'Recovered Shot 7 copy'), sourceName: 'Shot 7' });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(line('Shot 7')));
  });

  it('Nebula’s recorded source wins over the name this tab listed', async () => {
    // The tab lists alpha as “Glass campaign”; Nebula recorded the name it had when it was recovered.
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered', 'Recovered Glass'), sourceName: 'Glass' });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(line('Glass')));
  });

  it('a source nobody recorded: the line names the copy the reload opens', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered', 'Recovered Shot 7 copy'));
    useProjectStore.setState({ projects: [] });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error)
      .toBe('Couldn’t save your changes because Nebula was updated. Reload Nebula and they’ll open in “Recovered Shot 7 copy”.'));
  });
});

function proposal(id: string): ProposalView {
  return {
    id, status: 'open', agent: { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true },
    note: 'Brighter', projectId: 'alpha', createdAt: 1, expiresAt: Date.now() + 600_000,
    nodes: [], edges: [], params: [{ nodeId: 'n1', name: 'Hero prompt', changes: { value: { from: 'alpha', to: 'lit' } } }], run: [],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '' },
    references: [], reason: null, idMap: null, runNodeIds: null,
  };
}

describe('GM r29, 3: open proposals survive a reopen of the same project', () => {
  beforeEach(() => {
    useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
    useCanvasProposalsStore.getState().open(proposal('p_a'), 'key-a');
    useCanvasProposalsStore.getState().open(proposal('p_b'), 'key-b');
  });

  it('a replacement Nebula marks as keeping them (a reopen of the same project) keeps both, by id', () => {
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: 'rev-reopen', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      graphReplaced: true, proposalsKept: true, renumbered: { 'tab-dup': 'n2' }, nodes: [{ ...n1 }], edges: [] });
    expect(Object.keys(useCanvasProposalsStore.getState().proposals).sort()).toEqual(['p_a', 'p_b']);
  });

  it('another project (or an import) still closes them', () => {
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
      graphReplaced: true, nodes: [], edges: [] });
    expect(useCanvasProposalsStore.getState().proposals).toEqual({});
  });
});

describe('GM r29, 3 and a restart: proposals from before a restart don’t stay', () => {
  beforeEach(() => {
    useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  });
  const reopen = (bootId: string) => {
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    emit({ type: 'graphSync', workspaceRevision: `rev-${bootId}`, paramsVersion: GRAPH_PARAMS_VERSION, empty: false, bootId,
      graphReplaced: true, proposalsKept: true, renumbered: {}, nodes: [{ ...n1 }], edges: [] });
  };

  it('the same process: kept; a new process (the boot’s reopen): cleared, since open proposals live in its memory', () => {
    sync('rev-a', { bootId: 'boot-1' });
    useCanvasProposalsStore.getState().open(proposal('p_a'), 'key-a');
    reopen('boot-1');
    expect(Object.keys(useCanvasProposalsStore.getState().proposals)).toEqual(['p_a']);
    reopen('boot-2');
    expect(useCanvasProposalsStore.getState().proposals).toEqual({});
  });
});

/** Duplicate n1: a node only this tab has, by a tab-local id. */
function duplicateN1(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  return local.id;
}
const noticeNow = () => useGraphStore.getState().messageNotice?.text ?? useGraphStore.getState().undoNotice?.text ?? null;
const RUN_LINE = 'You can reopen “Glass campaign” when the run finishes.';
const WL_LINE = 'You can reopen “Glass campaign” after you check its World Labs run in Marble.';

describe('review 18 MEDIUM-2 and GM r30 item 2: a reopen in place that can’t go yet', () => {
  it('the lines', () => {
    expect(reopenHoldLine('Glass campaign', 'run')).toBe(RUN_LINE);
    expect(reopenHoldLine('Glass campaign', 'worldLabs')).toBe(WL_LINE);
  });

  it('during a run: Open goes back to the canvas with no request, the canvas says when; the line goes with the run, and the next Open reopens', async () => {
    duplicateN1();
    useProjectStore.setState({ screen: 'home' });
    const canSwitch = useGraphStore.getState().canSwitchProject;
    useGraphStore.setState({ canSwitchProject: () => false });
    expect(reopenHold('alpha')).toBe('run');
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useProjectStore.getState().error).toBeNull();
    expect(noticeNow()).toBe(RUN_LINE);
    // The run ends: the hold and its line go.
    useGraphStore.setState({ canSwitchProject: canSwitch });
    expect(reopenHold('alpha')).toBeNull();
    expect(noticeNow()).toBeNull();
    useProjectStore.setState({ screen: 'home' });
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('alpha', 'rev-a');
  });

  it('a World Labs hold: the same, with its line; it goes when the hold does', async () => {
    duplicateN1();
    useProjectStore.setState({ screen: 'home' });
    useGraphStore.setState({ uncertainWorldLabsRunId: 'run-wl' });
    expect(reopenHold('alpha')).toBe('worldLabs');
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(noticeNow()).toBe(WL_LINE);
    useGraphStore.setState({ uncertainWorldLabsRunId: null });
    expect(noticeNow()).toBeNull();
  });

  it('no tab-local node: no hold, whatever runs (the plain shortcut)', () => {
    useGraphStore.setState({ canSwitchProject: () => false });
    expect(reopenHold('alpha')).toBeNull();
  });

  it('a refusal after the press (Nebula’s 409): back on the canvas, its reason said there, the bar not left on Saving…', async () => {
    duplicateN1();
    // Saved before the press: the bar says what it said then, never “Saving…”.
    await useProjectStore.getState().flush();
    expect(useProjectStore.getState().saveStatus).toBe('saved');
    useProjectStore.setState({ screen: 'home' });
    vi.mocked(projects.openProject).mockRejectedValue(new projects.ProjectRequestError('A run is still going. Let it finish or stop it.', 409,
      { heading: "Couldn't open the project." }));
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).toHaveBeenCalled();
    const state = useProjectStore.getState();
    expect(state.screen).toBe('workspace');
    expect(state.error).toBeNull();
    expect(state.saveStatus).toBe('saved');
    expect(noticeNow()).toContain('A run is still going. Let it finish or stop it.');
  });

  it('a run that began between the press and the request: back on the canvas with the run’s line', async () => {
    duplicateN1();
    useProjectStore.setState({ screen: 'home' });
    // The save before the open is where the run begins.
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => {
      useGraphStore.setState({ canSwitchProject: () => false });
      return { ...project(id), snapshot };
    });
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'typed' } });
    await useProjectStore.getState().open('alpha');
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(noticeNow()).toBe(RUN_LINE);
  });
});

describe('review 18 MEDIUM-1: the handoff names the tab-local nodes this tab deleted, and only those', () => {
  it('a duplicate deleted here is named; one Nebula gave an id is not; a project load starts over', () => {
    const local = duplicateN1();
    expect(tabLocalDeletes()).toEqual([]);
    useGraphStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== local) }));
    expect(tabLocalDeletes()).toEqual([local]);
    const other = duplicateN1();
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => (node.id === other ? { ...node, id: 'n7' } : node)) }));
    void import('../src/store/graphStore').then(({ adoptRenumberedSelection }) => adoptRenumberedSelection({ [other]: 'n7' }, [], null));
    return import('../src/store/graphStore').then(() => {
      expect(tabLocalDeletes()).toEqual([local]);
      useGraphStore.getState().loadProjectGraph(project('alpha').snapshot.nodes, [], []);
      expect(tabLocalDeletes()).toEqual([]);
    });
  });

  it('the agent’s switch handoff sends them as deletedNodeIds', async () => {
    const local = duplicateN1();
    useGraphStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== local) }));
    const { pending } = useGraphStore.getState().beginAgentSwitch();
    useGraphStore.getState().finishCanvasReplacement(null);
    expect(pending.deleted).toEqual([local]);
  });
});

describe('review 18 LOW-1 and GM r30 item 4: the person’s reopen in another tab', () => {
  const personReopen = (tab: string) => bootSwitch({ workspaceRevision: 'rev-a2', proposalsKept: true,
    projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'person', tab }, created: false } });

  it('this tab hands its typing off into the project and follows, with no line and no “changed in another window”', async () => {
    type('typed in window B');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id, undefined, 'typed in window B'));
    personReopen('tab-window-a');
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    const handoff = vi.mocked(projects.saveProject).mock.calls.find(([id, , revision]) => id === 'alpha' && revision === 'rev-a');
    expect(handoff).toBeTruthy();
    expect(JSON.stringify(handoff![1])).toContain('typed in window B');
    const state = useProjectStore.getState();
    expect(state.screen).toBe('workspace');
    expect(state.error).toBeNull();
    expect(state.switchNotice).toBeNull();
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('the tab that reopened ignores its own switch (its open’s answer loads it)', async () => {
    personReopen(TAB_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(projects.saveProject)).not.toHaveBeenCalled();
    expect(vi.mocked(projects.listProjects)).toHaveBeenCalledTimes(1); // only the beforeEach's
    expect(useProjectStore.getState().error).toBeNull();
    expect(useProjectStore.getState().busy).toBe(false);
  });

  it('a follow that fails: Projects, the person’s form of the line, [Open “Glass campaign”]', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new Error('down'));
    personReopen('tab-window-a');
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBeTruthy());
    const state = useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(state.error).toBe('“Glass campaign” was reopened in another tab, but this tab couldn’t follow it.');
    expect(state.errorRetry).toEqual({ action: 'openFollowed', id: 'alpha', name: 'Glass campaign' });
  });
});
