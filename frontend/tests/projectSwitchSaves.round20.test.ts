/**
 * Round 20 of PR #195 (review 19, H1 and M1; GM - Design's follow-up of
 * 2026-10-27, verbatim):
 * - H1: the handoff save names the settings and renames Nebula may not have
 *   (`pendingParams`, `pendingLabels`), and Nebula merges exactly those onto
 *   its copy of the project left.
 * - GM follow-up 2: a failed handoff is one line, "Couldn't save “<setting>”
 *   for “<node>” in “<old project>” when <agent> switched projects. Your
 *   edits were saved as a copy, “<copy name>”." with "Open copy"; the toast
 *   no longer says "Edits saved as a copy." beside it.
 * - M1 (GM follow-ups 1 and 3): from the moment the tab sees an agent's
 *   switch until the new canvas is loaded the canvas is read-only (probe A1:
 *   nothing is typed into a canvas about to go away), the project bar says
 *   "Opening “<project>”…", Run is disabled with "Wait for “<project>” to
 *   open.", and a run press that gets through says "Couldn't run “<node>”.
 *   <agent> is opening “<project>”."
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
import { followingSwitch, resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { switchMessage } from '../src/store/projectStore';

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

const pendingOf = (call = 0) => (vi.mocked(projects.saveProject).mock.calls.filter(([id]) => id === 'alpha')[call] ?? [])[3];
const slowListing = () => {
  let listed: (value: ProjectList) => void = () => {};
  vi.mocked(projects.listProjects).mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
  return () => listed(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
};

describe('H1: the handoff names what Nebula may not have', () => {
  it('typing still in its debounce: its key and value', async () => {
    type('Typed');
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(handoffs()).toContain('Typed');
    expect(pendingOf()).toEqual({ params: { n1: { value: 'Typed' } }, labels: {} });
  });

  it('a rename still on its way: the name', async () => {
    graphWrites.answer = (path) => (path.endsWith('/label') ? hang() : Promise.resolve(answer()));
    useGraphStore.getState().renameNode('n1', 'Hero shot');
    await flush();
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(pendingOf()).toEqual({ params: {}, labels: { n1: 'Hero shot' } });
  });

  it('a rename draft open in the title: saved into the project left, as clicking away would', async () => {
    useGraphStore.getState().noteRenameDraft('n1', 'Draft name');
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    const sent = vi.mocked(projects.saveProject).mock.calls.find(([id]) => id === 'alpha');
    expect((sent?.[1] as { nodes: Array<{ data: { label: string } }> }).nodes[0].data.label).toBe('Draft name');
    expect(pendingOf()).toEqual({ params: {}, labels: { n1: 'Draft name' } });
  });
});

describe('GM follow-up 2: a failed handoff is one line, with Open copy', () => {
  it('names the setting, the node, the project, the agent and the copy', async () => {
    type('Typed');
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError('Nope.', 500, { heading: 'x' } as never));
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered'), name: 'Glass campaign (recovered)' });
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    const line = "Couldn't save “Text” for “Hero prompt” in “Glass\u00a0campaign” when Claude Code switched projects. "
      + 'Your edits were saved as a copy, “Glass\u00a0campaign\u00a0(recovered)”.';
    await vi.waitFor(() => expect(lines()).toContain(line));
    const notice = [useGraphStore.getState().undoNotice, useGraphStore.getState().messageNotice].find((item) => item?.text === line);
    expect(notice?.copy).toEqual({ projectId: 'recovered' });
    // One line, not two: the toast says only who opened what.
    expect(switchMessage(useProjectStore.getState().switchNotice!)).toBe('Claude Code opened “beta”.');
  });
});

describe('M1: the canvas is read-only while it follows an agent\'s switch', () => {
  it('A1: typing made while it follows changes nothing and sends nothing', async () => {
    agentOpens();
    const land = slowListing();
    await flush();
    expect(followingSwitch()).toEqual({ projectName: 'beta', agent: 'Claude Code' });
    type('During');
    useGraphStore.getState().renameNode('n1', 'Renamed');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await flush();
    const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1');
    expect(node?.data.params.value).toBe('alpha');
    expect(node?.data.label).toBe('Hero prompt');
    land();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(graphWrites.sent).toEqual([]);
    expect(handoffs().every((value) => value === 'alpha')).toBe(true);
    expect(followingSwitch()).toBeNull();
  });

  it('a run pressed while it follows: not sent, and GM\'s line', async () => {
    agentOpens();
    const land = slowListing();
    await flush();
    const started = vi.spyOn(execution, 'executeNode');
    await useGraphStore.getState().executeNode('n1');
    expect(started).not.toHaveBeenCalled();
    expect(lines()).toContain("Couldn't run “Hero prompt”. Claude Code is opening “beta”.");
    land();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
  });

  it('the follow ends when the switch can\'t be followed, too', async () => {
    vi.mocked(projects.listProjects).mockRejectedValue(new projects.ProjectRequestError('Nope.', 500, { heading: 'x' } as never));
    agentOpens();
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(followingSwitch()).toBeNull();
  });
});

describe('Round 21 (review 20, M-1): an agent reopens the project the tab shows', () => {
  it('the handoff carries the typing still in its debounce', async () => {
    type('Typed');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'alpha', workspaceRevision: 'rev-a2' }));
    emit({ type: 'graphSync', workspaceRevision: 'rev-a2', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      graphReplaced: true,
      projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousProjectId: 'alpha',
        previousProjectName: 'Glass campaign', previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Codex' } } });
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(handoffs()).toContain('Typed');
    // Params only: a rename an earlier test in this file left on its way is
    // carried too (the module's writes outlive a test), with the same name.
    expect((pendingOf() as { params: unknown }).params).toEqual({ n1: { value: 'Typed' } });
  });
});
