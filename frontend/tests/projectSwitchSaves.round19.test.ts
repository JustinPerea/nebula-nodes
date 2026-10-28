/**
 * Round 19 of PR #195 (review 18 G-1 and H-B; GM - Design's follow-up of
 * 2026-10-27, verbatim):
 * - The person's switch or import waits for the saves on their way (15 s at
 *   most). While it waits, the project bar shows "Saving…"; once they land
 *   it goes through with no line. One that fails or times out doesn't hold
 *   it: the new canvas says GM's line, in place of the out-of-date line.
 *   Drained writes keep their admission: they never land in the new project.
 * - An agent's switch (Nebula already switched): graph writes stop at once,
 *   and the handoff save into the project left carries every value the person
 *   typed that hadn't landed (the coordinator: "rather than saving only when
 *   the snapshot differs from lastSaved"). An undo still on its way is
 *   dropped, not folded in. GM's line shows only when that handoff fails:
 *   "…It was still saving when <agent> switched projects." ("an agent" when
 *   it isn't known).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string; revision: string | null }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
  /** Answers never given in the test: given after it, so no test leaves a write out. */
  hanging: [] as Array<() => void>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
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
        graphWrites.sent.push({ method, path, body: String(init?.body ?? ''), revision: project?.revision ?? null });
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
import { STALE_CANVAS_DETAIL } from '../src/lib/projectContext';

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
const puts = () => graphWrites.sent.filter((write) => write.method === 'PUT').map((write) => `${write.path} ${write.body} @${write.revision}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** An answer that doesn't come during the test. */
const hang = () => new Promise<Response>((resolve) => {
  graphWrites.hanging.push(() => resolve(new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json' } })));
});
const answer = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** An agent opened another project (Nebula switched; the canvas hears it). */
const agentOpens = (actor: Record<string, unknown> = { kind: 'agent', name: 'Claude Code' }) => {
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    graphReplaced: true,
    projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
      previousRevision: 'rev-a', actor } });
};
const handoffs = () => vi.mocked(projects.saveProject).mock.calls.filter(([id]) => id === 'alpha')
  .map(([, snapshot]) => (snapshot as { nodes: Array<{ data: { params: { value: unknown } } }> }).nodes[0]?.data.params.value);

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

describe("the person's switch waits for the saves on their way", () => {
  it('typing still in its debounce goes out first, under the project it was typed in; then no line', async () => {
    type('Typed');
    await useProjectStore.getState().open('beta');
    expect(puts()).toEqual(['/api/graph/node/n1 {"params":{"value":"Typed"}} @rev-a']);
    expect(vi.mocked(projects.openProject).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(projects.saveProject).mock.invocationCallOrder[0] ?? 0);
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(lines()).toEqual([]);
  });

  it('the project bar says "Saving…" while it waits', async () => {
    let land = () => {};
    graphWrites.answer = () => new Promise((resolve) => {
      land = () => resolve(answer());
      graphWrites.hanging.push(land);
    });
    type('Typed');
    const opening = useProjectStore.getState().open('beta');
    await vi.waitFor(() => expect(graphWrites.sent).toHaveLength(1));
    expect(useProjectStore.getState().saveStatus).toBe('saving');
    expect(projects.openProject).not.toHaveBeenCalled();
    land();
    await opening;
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(lines()).toEqual([]);
  });

  it('a save refused meanwhile doesn\'t hold the switch; the new canvas says GM\'s line', async () => {
    graphWrites.answer = async () => answer(500, { detail: 'Nope.' });
    type('Typed');
    await useProjectStore.getState().open('beta');
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(lines()).toEqual(["Couldn't save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when you switched."]);
  });

  it('a save that never answers holds it for 15 s at most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    graphWrites.answer = () => hang();
    type('Typed');
    const opening = useProjectStore.getState().open('beta');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(projects.openProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await opening;
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(lines()).toEqual(["Couldn't save “Text” for “Hero prompt” in “Glass campaign”. It was still saving when you switched."]);
    expect(lines().some((line) => String(line).includes(STALE_CANVAS_DETAIL))).toBe(false);
  });
});

describe("an agent's switch: the handoff carries what the person typed", () => {
  it('typing still in its debounce: never sent, and the project left gets it', async () => {
    type('Typed');
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(puts()).toEqual([]);
    expect(handoffs()).toContain('Typed');
    expect(lines()).toEqual([]);
  });

  it('a write still out when the autosave already landed: the handoff is sent all the same', async () => {
    graphWrites.answer = () => hang();
    type('Typed');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(handoffs()).toEqual(['Typed']);
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(handoffs()).toEqual(['Typed', 'Typed']);
    expect(lines()).toEqual([]);
  });

  it('N2: a Delete pressed while the tab follows is never sent', async () => {
    let listed: (value: ProjectList) => void = () => {};
    agentOpens();
    vi.mocked(projects.listProjects).mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
    await flush();
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await flush();
    expect(graphWrites.sent.filter((write) => write.method === 'DELETE')).toEqual([]);
    listed(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await flush();
    expect(graphWrites.sent.filter((write) => write.method === 'DELETE')).toEqual([]);
  });

  // Round 20 (GM follow-up 2): one line, naming the copy.
  it('the handoff fails: GM\'s line names the setting, the node, the project and the agent', async () => {
    type('Typed');
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError('Nope.', 500, { heading: 'x' } as never));
    vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await vi.waitFor(() => expect(lines()).toContain(
      "Couldn't save “Text” for “Hero prompt” in “Glass\u00a0campaign” when Claude Code switched projects. "
      + 'Your edits were saved as a copy, “recovered”.'));
  });

  it('the handoff fails and the agent isn\'t known: "an agent"', async () => {
    type('Typed');
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError('Nope.', 500, { heading: 'x' } as never));
    vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
    agentOpens({ kind: 'anonymous' });
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await vi.waitFor(() => expect(lines()).toContain(
      "Couldn't save “Text” for “Hero prompt” in “Glass\u00a0campaign” when an agent switched projects. "
      + 'Your edits were saved as a copy, “recovered”.'));
  });

  it('the handoff fails with a delete still out: "your last change"', async () => {
    graphWrites.answer = (path, init) => (init?.method === 'DELETE' ? hang() : Promise.resolve(answer()));
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await flush();
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError('Nope.', 500, { heading: 'x' } as never));
    vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await vi.waitFor(() => expect(lines()).toContain(
      "Couldn't save your last change in “Glass\u00a0campaign” when Claude Code switched projects. "
      + 'Your edits were saved as a copy, “recovered”.'));
  });

  it('an undo still on its way is dropped, not folded into the handoff', async () => {
    type('Typed');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(handoffs()).toEqual(['Typed']);
    graphWrites.answer = (path) => (path === '/api/graph/restore' ? hang() : Promise.resolve(answer()));
    useGraphStore.getState().undo();
    await flush();
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(handoffs()).toEqual(['Typed', 'Typed']);
  });
});
