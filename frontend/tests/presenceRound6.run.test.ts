/**
 * PR #204 round 6, the stores:
 * - GM r6 (2): the project save's not-connected line is the "because" form, and its retry on the
 *   promote goes only to the project it was refused for (review 4 NIT-1, survivor M9).
 * - Review 4 LOW-4: a refused run's nodes go back to the state they last settled in (idle,
 *   complete, error, skipped), never 'queued' or 'executing'; the kept states are taken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
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
  createProject: vi.fn(),
}));

import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { beforeQueuedSizeForTests, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as api from '../src/lib/api';
import { ExecutionStartRejectedError } from '../src/lib/api';
import { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } from '../src/lib/personSession';
import { pendingPromoteRetries } from '../src/lib/clearsOnPromote';
import { PERSON_REQUIRED_CODE } from '../src/lib/errorCopy';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const initial = useProjectStore.getState();
const state = () => useProjectStore.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function project(id = 'alpha', value = id): SavedProject {
  return {
    id, name: id === 'alpha' ? 'Glass campaign' : id, createdAt: '2026-10-09T10:00:00Z',
    updatedAt: '2026-10-09T10:00:00Z', lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Brief', params: { value }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function editCanvas(value: string): void {
  const [node] = useGraphStore.getState().nodes;
  useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value } } }] });
}
const gate = () => new projects.ProjectRequestError('Only the person can do this.', 403,
  { heading: "Couldn't save the project.", detail: 'Only the person can do this.', code: PERSON_REQUIRED_CODE });

describe('GM r6 (2) and survivor M9: the project save\'s line and its retry', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetPersonSessionForTests();
    resetProjectStoreForTests();
    window.sessionStorage.clear();
    setProjectContext(null);
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
      providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
    useProjectStore.setState(initial, true);
    useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
    useCreateDraftStore.setState({ drafts: {} });
    vi.spyOn(api, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
    vi.mocked(projects.listProjects).mockResolvedValue(listing());
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
    await useProjectStore.getState().initialize();
    useProjectStore.setState({ screen: 'workspace' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    notePersonPromoted();
    await tick();
    vi.restoreAllMocks();
    setProjectContext(null);
  });

  async function refusedSave() {
    reportPersonRequired();
    vi.mocked(projects.saveProject).mockRejectedValueOnce(gate());
    editCanvas('held edit');
    await state().flush().catch(() => {});
    expect(state().saveStatus).toBe('error');
    expect(state().saveError).toContain('isn’t connected as you');
    expect(pendingPromoteRetries()).toBe(1);
  }

  it('the line is the because form, with no "try again" and no "needs your OK"', async () => {
    await refusedSave();
    expect(state().saveError).toBe('Nebula couldn’t save the project because this tab isn’t connected as you. Open the link Nebula printed when it started.');
  });

  it('another project open by the promote: the retry sends nothing to it', async () => {
    await refusedSave();
    useProjectStore.setState({ activeProject: { ...summary('beta') } as never });
    notePersonPromoted();
    await tick(); await tick();
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
  });
});

describe('review 4 LOW-4: a refused run restores the state the node last settled in', () => {
  const node = (state: string, extra: Record<string, unknown> = {}) => ({
    id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Krea 2', definitionId: 'krea-2-generate', params: { _kreaAuth: 'mcp' }, state,
      outputs: { image: { type: 'Image', value: '/api/outputs/kept.png' } }, ...extra },
  });
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api, 'executeNode').mockRejectedValue(new ExecutionStartRejectedError('needs the person', 403,
      { heading: "Couldn't run the node.", detail: 'needs the person', code: PERSON_REQUIRED_CODE }));
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  async function refuseFrom(start: ReturnType<typeof node>) {
    useGraphStore.setState({ nodes: [start] as never, edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [], providerStartAmbiguities: [] });
    reportPersonRequired();
    await useGraphStore.getState().executeNode('n1');
    expect(useGraphStore.getState().nodes[0].data.state).toBe('error');
    notePersonPromoted();
    return useGraphStore.getState().nodes[0].data;
  }

  for (const [state, extra] of [['idle', {}], ['complete', {}], ['skipped', {}],
    ['error', { error: 'The model said no.', errorPerson: 'The model said no.' }]] as const) {
    it(`from ${state}: ${state} again, its result kept`, async () => {
      const data = await refuseFrom(node(state, extra));
      expect(data.state).toBe(state);
      expect(data.error).toBe((extra as { error?: string }).error);
      expect(data.outputs).toEqual({ image: { type: 'Image', value: '/api/outputs/kept.png' } });
    });
  }

  for (const state of ['queued', 'executing'] as const) {
    it(`a node that read ${state} when the start queued it goes back to idle, never ${state}`, async () => {
      const data = await refuseFrom(node(state, { progress: 0.4 }));
      expect([data.state, data.progress]).toEqual(['idle', undefined]);
    });
  }

  it('the kept states are taken by the refusal (the map doesn\'t grow)', async () => {
    await refuseFrom(node('complete'));
    expect(beforeQueuedSizeForTests()).toBe(0);
  });

  it('the kept states are capped at 500: a run over 500 nodes keeps the latest 500, and its refusal takes them', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `t${i}`, type: 'model-node', position: { x: i, y: 0 },
      data: { label: 'Brief', definitionId: 'text-input', params: { value: 'x' }, state: 'idle', outputs: {} } }));
    useGraphStore.setState({ nodes: many as never, edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [], providerStartAmbiguities: [] });
    let refuse!: (error: unknown) => void;
    vi.spyOn(api, 'executeGraph').mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    reportPersonRequired();
    const run = useGraphStore.getState().executeGraph();
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
    expect(beforeQueuedSizeForTests()).toBe(500);
    refuse(new ExecutionStartRejectedError('needs the person', 403,
      { heading: "Couldn't run the graph.", detail: 'needs the person', code: PERSON_REQUIRED_CODE }));
    await run;
    expect(beforeQueuedSizeForTests()).toBe(0);
  });
});
