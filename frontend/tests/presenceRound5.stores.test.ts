/**
 * PR #204 round 5, the stores:
 * - GM r5 item 1: a project save the gate refused only as "not connected" goes again on the
 *   promote, silently, through the one retry mechanism (retryOnPromote, which mark-read uses
 *   too): the header reads its normal "Saving…" while it does, and a retry that fails keeps
 *   "Save failed · Retry" with the new reason. Another failure isn't retried.
 * - Review 3 NIT: a refused run's nodes go back to how they were on the promote (a complete
 *   node shows its result again, not idle); a newer line on a node stays.
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
import { useGraphStore } from '../src/store/graphStore';
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
const broken = () => new projects.ProjectRequestError('The disk said no.', 500, { heading: "Couldn't save the project." });

describe('GM r5 item 1: a save refused as "not connected" goes again on the promote, silently', () => {
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

  it('the promote sends it again: "Saving…" while it goes, then saved, and no line', async () => {
    await refusedSave();
    let land: () => void = () => {};
    vi.mocked(projects.saveProject).mockImplementationOnce((id, snapshot) =>
      new Promise((resolve) => { land = () => resolve({ ...project(id), snapshot }); }));
    notePersonPromoted();
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(2));
    expect(state().saveStatus).toBe('saving');
    expect(state().saveError).toBeNull();
    land();
    await vi.waitFor(() => expect(state().saveStatus).toBe('saved'));
    expect([state().saveError, state().error, pendingPromoteRetries()]).toEqual([null, null, 0]);
  });

  it('a retry that fails keeps "Save failed · Retry" with the new reason', async () => {
    await refusedSave();
    vi.mocked(projects.saveProject).mockRejectedValueOnce(broken());
    notePersonPromoted();
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state().saveStatus).toBe('error'));
    expect(state().saveError).toContain('The disk said no.');
    expect(pendingPromoteRetries()).toBe(0);
  });

  it('a save that failed for another reason isn\'t retried on the promote', async () => {
    vi.mocked(projects.saveProject).mockRejectedValueOnce(broken());
    editCanvas('broken edit');
    await state().flush().catch(() => {});
    expect(state().saveStatus).toBe('error');
    expect(pendingPromoteRetries()).toBe(0);
    notePersonPromoted();
    await tick();
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
    expect(state().saveStatus).toBe('error');
  });

  it('a refusal for a save sent before the promote, landing after it, sends it again at once', async () => {
    reportPersonRequired();
    let refuse: () => void = () => {};
    vi.mocked(projects.saveProject).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      refuse = () => reject(new projects.ProjectRequestError('Only the person can do this.', 403,
        { heading: "Couldn't save the project.", code: PERSON_REQUIRED_CODE, sentBeforePromote: true }));
    }));
    editCanvas('sent while held');
    const saving = state().flush().catch(() => {});
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(1));
    notePersonPromoted();
    refuse();
    await saving;
    await vi.waitFor(() => expect(projects.saveProject).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state().saveStatus).toBe('saved'));
    expect(state().saveError).toBeNull();
  });
});

describe('review 3 NIT: a refused run\'s nodes go back to how they were on the promote', () => {
  const done = {
    id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Krea 2', definitionId: 'krea-2-generate', params: { _kreaAuth: 'mcp' }, state: 'complete' as const,
      outputs: { image: { type: 'Image', value: '/api/outputs/kept.png' } }, progress: undefined },
  };
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({ nodes: [done] as never, edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [], providerStartAmbiguities: [] });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(api, 'executeNode').mockRejectedValue(new ExecutionStartRejectedError('needs the person', 403,
      { heading: "Couldn't run the node.", detail: 'needs the person', code: PERSON_REQUIRED_CODE }));
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  it('a complete node refused a run is complete again, its result kept, on the promote', async () => {
    reportPersonRequired();
    await useGraphStore.getState().executeNode('n1');
    expect(useGraphStore.getState().nodes[0].data.state).toBe('error');
    notePersonPromoted();
    const [node] = useGraphStore.getState().nodes;
    expect([node.data.state, node.data.error, node.data.errorPerson]).toEqual(['complete', undefined, undefined]);
    expect(node.data.outputs).toEqual(done.data.outputs);
  });

  it('a newer line on that node stays', async () => {
    reportPersonRequired();
    await useGraphStore.getState().executeNode('n1');
    useGraphStore.setState((s) => ({ nodes: s.nodes.map((node) => ({ ...node, data: { ...node.data, error: 'A newer failure.' } })) }));
    notePersonPromoted();
    const [node] = useGraphStore.getState().nodes;
    expect([node.data.state, node.data.error]).toEqual(['error', 'A newer failure.']);
  });
});
