/**
 * Round 21 of PR #195: review 20's store findings and GM's round 21 lines.
 * - M-1's reopen case is in projectSwitchSaves.round20 (the backend keeps
 *   the typing live: test_round21_review20.py).
 * - L-1: every action that changes nodes or edges, or sends a graph write,
 *   is gated while following and while offline (the Delete key, the chat's
 *   clear, proposal Accept).
 * - L-4/L-5: a sync with no origin whose revision moved is adopted as the
 *   same canvas only when Nebula says its revisions weren't restored, and
 *   the writes held from before go out under the adopted revision.
 * - L-7: a later switch during a follow updates what the bar and the toast name.
 * - GM: an agent's clear is one toast, its line carrying Undo; a delete
 *   answered with a 500 says GM's locked line, its status in the Agent log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string; revision: string | null; canvas?: string | null }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
  /** Answers never given in the test: given after it, so no test leaves a write out. */
  hanging: [] as Array<() => void>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
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
  const { getProjectContext } = await import('../src/lib/projectContext');
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: { project?: { revision: string } | null }) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && path.startsWith('/api/graph')) {
        const project = options && 'project' in options ? options.project : getProjectContext();
        graphWrites.sent.push({ method, path, body: String(init?.body ?? ''), revision: project?.revision ?? null,
          canvas: (project as { canvas?: string } | null)?.canvas ?? null });
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
import { CREATE_WHILE_FOLLOWING_HEADING, followingSwitch, resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { failureMessage } from '../src/lib/errorCopy';
import * as graphStoreModule from '../src/store/graphStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useAgentLogStore } from '../src/store/agentLogStore';
import { getProjectContext } from '../src/lib/projectContext';

const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
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
const lines = () => [useGraphStore.getState().undoNotice?.text, useGraphStore.getState().messageNotice?.text].filter(Boolean);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** An agent opened another project (Nebula switched; the canvas hears it). */
const agentOpens = (actor: Record<string, unknown> = { kind: 'agent', name: 'Claude Code' }) => {
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    graphReplaced: true,
    projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
      previousRevision: 'rev-a', actor } });
};

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  graphWrites.sent = [];
  graphWrites.answer = null;
  resetProjectStoreForTests();
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
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  resetCanvasFollowForTests();
  useGraphStore.getState().finishCanvasReplacement?.(null);
  for (const release of graphWrites.hanging.splice(0)) release();
  graphWrites.answer = null;
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 400));
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
});

const slowListing = () => {
  let listed: (value: ProjectList) => void = () => {};
  vi.mocked(projects.listProjects).mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
  return () => listed(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
};


const NOT_EDITS = new Set<string>([]);

describe('L-1: every edit is gated, following and offline', () => {
  it('walks every action of the store: each is gated or listed as not an edit', () => {
    const gated = new Set(graphStoreModule.gatedGraphActions());
    const state = useGraphStore.getState() as unknown as Record<string, unknown>;
    const actions = Object.keys(state).filter((key) => typeof state[key] === 'function');
    expect(actions.filter((name) => !gated.has(name) && !graphStoreModule.NOT_GRAPH_EDITS.has(name) && !NOT_EDITS.has(name)))
      .toEqual([]);
    for (const name of ['deleteCanvasElements', 'clearBackendNodes', 'adoptAcceptedProposal']) expect(gated.has(name)).toBe(true);
  });

  for (const mode of ['following', 'offline'] as const) {
    it(`${mode}: the Delete key, the chat's clear and Accept change nothing and send nothing`, async () => {
      if (mode === 'following') {
        agentOpens();
        slowListing();
        await flush();
      } else {
        noteBackendConnection('offline');
      }
      const before = useGraphStore.getState().nodes.map((node) => node.id);
      useGraphStore.getState().deleteCanvasElements(['n1'], []);
      const step = useGraphStore.getState().beginUndoStep({ clear: true });
      useGraphStore.getState().clearBackendNodes({ undoStep: step });
      useGraphStore.getState().cancelUndoStep(step);
      useCanvasProposalsStore.getState().open({ id: 'p1', status: 'open', agent: { id: 'a', name: 'Codex', color: '#ffffff', verified: false },
        note: 'x', nodes: [], edges: [], references: [], runNodeIds: [], cost: {}, createdAt: 0, expiresAt: Date.now() + 60_000 } as never, 'key');
      await useCanvasProposalsStore.getState().accept('p1');
      await flush();
      expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(before);
      expect(graphWrites.sent.filter((write) => write.method !== 'GET')).toEqual([]);
      resetBackendConnectionForTests();
    });
  }
});

describe('G1: Create while following', () => {
  it("rejects with Create's own heading over who is opening what", async () => {
    expect(graphStoreModule.GENERATE_HEADING).toBe(CREATE_WHILE_FOLLOWING_HEADING);
    agentOpens();
    slowListing();
    await flush();
    const error = await useGraphStore.getState().authorGenerationCluster({ definitionId: 'text-input', prompt: 'x', params: {},
      refPaths: [], quantity: 1, sessionId: 's', genId: 'g', layoutOrigin: { x: 0, y: 0 } } as never).catch((reason: unknown) => reason);
    expect(failureMessage(error, graphStoreModule.GENERATE_HEADING))
      .toBe("Nebula couldn’t start the generation. Claude Code is opening “beta”.");
    expect(graphWrites.sent).toEqual([]);
  });
});

describe('L-7: a later switch while following is the one named', () => {
  it('the bar and the toast name the project loaded and the last agent', async () => {
    agentOpens();
    const land = slowListing();
    await flush();
    emit({ type: 'graphSync', workspaceRevision: 'rev-g', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      graphReplaced: true,
      projectSwitch: { projectId: 'gamma', projectName: 'gamma', previousProjectId: 'beta', previousProjectName: 'beta',
        previousRevision: 'rev-b', actor: { kind: 'agent', name: 'Codex' } } });
    await flush();
    expect(followingSwitch()).toEqual({ projectName: 'gamma', agent: 'Codex' });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('beta'), summary('gamma')],
      activeProjectId: 'gamma', workspaceRevision: 'rev-g' }));
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
    land();
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    const notice = useProjectStore.getState().switchNotice;
    expect(notice?.actorName).toBe('Codex');
    expect(notice?.projectName).toBe(useProjectStore.getState().activeProject?.name);
    expect(followingSwitch()).toBeNull();
  });
});

describe('L-4/L-5: a sync with no origin whose revision moved', () => {
  const sameCanvasSync = (extra: Record<string, unknown>) => emit({ type: 'graphSync', workspaceRevision: 'rev-a',
    paramsVersion: GRAPH_PARAMS_VERSION, empty: false, canvasRevision: '17', edges: [],
    nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value: 'alpha' }, state: 'idle', outputs: {} } }],
    ...extra });

  it('restored revisions: it is another canvas (a missed agent clear), and the typing never reaches its n1', async () => {
    type('Mine');
    sameCanvasSync({});
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(graphWrites.sent.filter((write) => write.method === 'PUT' && write.path === '/api/graph/node/n1')).toEqual([]);
  });

  it('revisions not restored: the same canvas, and the held typing goes out under the adopted revision', async () => {
    // Round 22 (review 21, L-b): only across an actual restart, so the canvas
    // first syncs with one process (its own revision) and then another.
    sameCanvasSync({ canvasRevision: getProjectContext()?.canvas, bootId: 'r21-boot-a' });
    type('Mine');
    sameCanvasSync({ canvasRevisionRestored: false, bootId: 'r21-boot-b' });
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.method === 'PUT' && write.path === '/api/graph/node/n1'))
      .toBe(true), { timeout: 2000 });
    const put = graphWrites.sent.find((write) => write.method === 'PUT' && write.path === '/api/graph/node/n1');
    expect(put?.canvas).toBe('17');
    expect(getProjectContext()?.canvas).toBe('17');
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('Mine');
  });
});

describe('GM round 21: an agent\'s clear is one toast, its line carrying Undo', () => {
  it('the clear line replaces "<agent> changed the canvas" and keeps its Undo', async () => {
    type('Mine');
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true, cleared: true,
      canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_1', actor: { kind: 'agent', name: 'Codex' } } });
    await vi.waitFor(() => expect(useGraphStore.getState().undoNotice?.text).toBe(
      "Codex cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved."));
    expect(useGraphStore.getState().undoNotice?.offer).toBe('undo');
    expect(useGraphStore.getState().messageNotice).toBeNull();
  });
});

describe('GM round 21 (LOCKED): a delete answered with a 500', () => {
  it('names the node, puts it back, and logs the status in the Agent log', async () => {
    useAgentLogStore.getState().clear();
    graphWrites.answer = (_path, init) => Promise.resolve(init?.method === 'DELETE'
      ? answer(500, { detail: 'boom' }) : answer());
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await vi.waitFor(() => expect(lines()).toContain(
      "Couldn't delete “Hero prompt”. Nebula ran into an error, so it's back on the canvas. Try again, and if it keeps happening, restart Nebula."));
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toContain('n1');
    expect(useAgentLogStore.getState().entries.some((entry) => entry.message.includes('500'))).toBe(true);
  });
});
