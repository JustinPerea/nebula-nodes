/**
 * Round 22 of PR #195: review 21's store findings and GM's round-22 rulings.
 * - GM (review 21 G-a): Undo on an agent's clear line puts the canvas back
 *   "as last saved": what Nebula had saved before the clear, never the
 *   typing the line says wasn’t saved.
 * - L-c: a rename draft folded into an agent's switch is handed off once;
 *   a later switch carries no phantom `pendingLabels`.
 * - L-d: Cinema's "Send to motion" is refused while following (the bar
 *   pulses, nothing is sent) and offline.
 * - GM 4a: the Agent log says "Couldn’t delete “<node>”, node <id>. Nebula
 *   returned HTTP <status>."
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
  const { getProjectContext } = await import('../src/lib/projectContext');
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: { project?: { revision: string } | null }) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && (path.startsWith('/api/graph') || path.startsWith('/api/cinema'))) {
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
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useAgentLogStore } from '../src/store/agentLogStore';

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


import { sendCinemaShotToMotion } from '../src/lib/cinemaMotion';
import { useCinemaMotionStore } from '../src/store/cinemaMotionStore';
import { subscribeFollowPulse } from '../src/lib/canvasFollow';

const restoreBodies = () => graphWrites.sent.filter((write) => write.path === '/api/graph/restore')
  .map((write) => JSON.parse(write.body) as { nodes?: Array<{ id: string; data?: { params?: Record<string, unknown> }; params?: Record<string, unknown> }> });
const restoredValue = (body: ReturnType<typeof restoreBodies>[number], id: string) => {
  const node = body.nodes?.find((candidate) => candidate.id === id);
  return node?.data?.params?.value ?? node?.params?.value;
};
const valueOf = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)?.data.params.value;
const agentClear = () => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
  cleared: true, canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } });
const hang = () => new Promise<Response>((resolve) => {
  graphWrites.hanging.push(() => resolve(new Response(JSON.stringify({ detail: 'This canvas is out of date. Open the current project before editing or running it.' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } })));
});

describe('GM (review 21 G-a): Undo on the agent-clear line restores the canvas as last saved', () => {
  it('typing still in its debounce: Undo puts back the saved value, not the typing', async () => {
    expect(valueOf('n1')).toBe('alpha');
    type('alpha typed');
    agentClear();
    await vi.waitFor(() => expect(useGraphStore.getState().undoNotice?.text).toBe(
      "Codex cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved."));
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha');
    await vi.waitFor(() => expect(valueOf('n1')).toBe('alpha'));
  });

  it('a save on its way that Nebula then refused: Undo puts back the saved value, not the typing', async () => {
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT' ? hang() : Promise.resolve(answer()));
    type('alpha held');
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1')).toBe(true), { timeout: 2000 });
    agentClear();
    await flush();
    for (const release of graphWrites.hanging.splice(0)) release();
    await vi.waitFor(() => expect(useGraphStore.getState().undoNotice?.text).toBe(
      "Codex cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved."));
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha');
    await vi.waitFor(() => expect(valueOf('n1')).toBe('alpha'));
  });

  it('a save Nebula took before the clear stays: that is what it had saved', async () => {
    type('alpha landed');
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1')).toBe(true), { timeout: 2000 });
    await flush();
    agentClear();
    await vi.waitFor(() => expect(useGraphStore.getState().undoNotice?.offer).toBe('undo'));
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha landed');
  });
});

describe('L-c: a rename draft folded in at an agent\'s switch is handed off once', () => {
  it('the next agent switch carries no phantom pendingLabels and is not forced', async () => {
    useGraphStore.getState().noteRenameDraft('n1', 'Draft name');
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    const first = vi.mocked(projects.saveProject).mock.calls.filter(([id]) => id === 'alpha');
    expect(first.map(([, , , pending]) => pending)).toEqual([{ params: {}, labels: { n1: 'Draft name' } }]);
    vi.mocked(projects.saveProject).mockClear();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('beta'), summary('gamma')],
      activeProjectId: 'gamma', workspaceRevision: 'rev-c' }));
    emit({ type: 'graphSync', workspaceRevision: 'rev-c', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      graphReplaced: true,
      projectSwitch: { projectId: 'gamma', projectName: 'gamma', previousProjectId: 'beta', previousProjectName: 'beta',
        previousRevision: 'rev-b', actor: { kind: 'agent', name: 'Codex' } } });
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('gamma'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    // Nothing was typed in beta: no handoff, and none naming n1.
    const second = vi.mocked(projects.saveProject).mock.calls.filter(([id]) => id === 'beta');
    expect(second.map(([, , , pending]) => (pending as { labels?: unknown } | undefined)?.labels ?? {})
      .filter((labels) => Object.keys(labels as object).length > 0)).toEqual([]);
  });
});

describe("L-d: Cinema's Send to motion", () => {
  const scene = () => useGraphStore.setState((state) => ({ nodes: [...state.nodes, { id: 'n2', type: 'model-node', position: { x: 300, y: 0 },
    data: { definitionId: 'cinema-scene', label: 'Scene', state: 'idle', outputs: {},
      params: { scene: { shots: [{ id: 's1', prompt: 'a', output: { status: 'done', imageUrl: '/api/outputs/x.png' } }] } } } } as never] }));

  it('while following: nothing is sent, no error is shown, and the bar pulses', async () => {
    scene();
    agentOpens();
    slowListing();
    await flush();
    let pulses = 0;
    const stop = subscribeFollowPulse(() => { pulses += 1; });
    graphWrites.sent = [];
    await sendCinemaShotToMotion('n2', 's1');
    await flush();
    stop();
    expect(graphWrites.sent).toEqual([]);
    expect(useCinemaMotionStore.getState().handoffs).toEqual([]);
    expect(pulses).toBe(1);
  });

  it('offline: nothing is sent and no error is shown', async () => {
    scene();
    noteBackendConnection('offline');
    graphWrites.sent = [];
    await sendCinemaShotToMotion('n2', 's1');
    await flush();
    expect(graphWrites.sent).toEqual([]);
    expect(useCinemaMotionStore.getState().handoffs).toEqual([]);
    resetBackendConnectionForTests();
  });
});

describe('GM round 22 (4a): the Agent log line for a delete answered with a 500', () => {
  it('"Couldn’t delete “Hero prompt”, node n1. Nebula returned HTTP 500."', async () => {
    useAgentLogStore.getState().clear();
    graphWrites.answer = (_path, init) => Promise.resolve(init?.method === 'DELETE' ? answer(500, { detail: 'boom' }) : answer());
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await vi.waitFor(() => expect(useAgentLogStore.getState().entries.map((entry) => entry.message))
      .toContain("Couldn’t delete “Hero prompt”, node n1. Nebula returned HTTP 500."));
    expect(useAgentLogStore.getState().entries.some((entry) => entry.message.startsWith('Delete of'))).toBe(false);
  });
});
