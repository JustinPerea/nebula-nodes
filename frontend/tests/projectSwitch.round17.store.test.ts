/**
 * Round 17 of PR #114, review 16 M1 (live F and G): an agent's switches while
 * the tab is offline. The tab keeps the newest switch notice, its held save
 * goes to its own project, a recovered copy is made only when that project's
 * saved copy lacks something the tab holds, and the toast names the project
 * the tab landed on, with the way back to the one it was showing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
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
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, ProjectSnapshot, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const initial = useProjectStore.getState();
const textNode = (id: string, value: string) => ({ id, type: 'model-node', position: { x: 10, y: 20 },
  data: { definitionId: 'text-input', label: 'Text', params: { value }, state: 'idle' as const, outputs: {} } });

function project(id: string, name: string, nodes = [textNode('n1', id)]): SavedProject {
  return {
    id, name, createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z',
    lastOpenedAt: null, nodeCount: nodes.length, edgeCount: 0, thumbnail: null,
    snapshot: { nodes, edges: [], runHistory: [], viewport: null, createSessionId: null } as unknown as ProjectSnapshot,
  };
}
const summary = (item: SavedProject) => { const { snapshot: _s, ...rest } = item; void _s; return rest; };
const NAMES: Record<string, string> = { A: 'Recovered canvas', B: 'Agent B', C: 'Agent C', D: 'Agent D' };
let saved: Record<string, SavedProject> = {};
function listing(active: string, revision: string): ProjectList {
  return { projects: Object.values(saved).map(summary), trash: [], activeProjectId: active,
    workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION };
}

function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const switched = (to: string, from: string, previousRevision: string, revision: string, created: boolean) => emit({
  type: 'graphSync', workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
  graphReplaced: true, projectSwitch: { projectId: to, projectName: NAMES[to], previousProjectId: from,
    previousProjectName: NAMES[from], previousRevision, created, actor: { kind: 'agent', name: 'Codex' } },
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => useProjectStore.getState();

let unsubscribe: (() => void) | null = null;
async function startOn(id: string, nodes = [textNode('n1', id)]): Promise<void> {
  saved = { [id]: project(id, NAMES[id], nodes) };
  vi.mocked(projects.listProjects).mockResolvedValue(listing(id, `rev-${id}`));
  await state().initialize();
  unsubscribe = subscribeProjectAutosave();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.getProject).mockImplementation(async (id) => saved[id]);
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...saved[id], snapshot }));
  vi.mocked(projects.recoverProject).mockResolvedValue({ project: project('R', 'Recovered canvas (recovered)') } as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
});

/** The tab holds a change the backend never saw (a pan's worth: a node moved
 * before the outage that the autosave hadn't sent yet). */
function holdUnsavedChange(): void {
  const [first] = useGraphStore.getState().nodes;
  useGraphStore.setState({ nodes: [{ ...first, position: { x: 99, y: 99 } }] });
}

describe('A → B → C while offline (review 16 F)', () => {
  it('the held save goes to A, no copy is made, and the toast names C with the way back to A', async () => {
    await startOn('A');
    holdUnsavedChange();
    noteBackendConnection('offline');
    saved.B = project('B', 'Agent B', []);
    switched('B', 'A', 'rev-A', 'rev-B', true);
    saved.C = project('C', 'Agent C', []);
    switched('C', 'B', 'rev-B', 'rev-C', true);
    await flush();
    // Nothing is sent while offline.
    expect(projects.saveProject).not.toHaveBeenCalled();
    vi.mocked(projects.listProjects).mockResolvedValue(listing('C', 'rev-C'));
    noteBackendConnection('online');
    await vi.waitFor(() => expect(state().busy).toBe(false));
    await vi.waitFor(() => expect(state().switchNotice).not.toBeNull());
    expect(vi.mocked(projects.saveProject).mock.calls[0]?.[0]).toBe('A');
    expect(vi.mocked(projects.saveProject).mock.calls[0]?.[2]).toBe('rev-A');
    expect(projects.recoverProject).not.toHaveBeenCalled();
    expect(state().activeProject?.id).toBe('C');
    expect(state().switchNotice).toMatchObject({ actorName: 'Codex', created: true, projectName: 'Agent C',
      previousProjectId: 'A', previousProjectName: 'Recovered canvas', keptCopy: false });
  });
});

describe('C → D → back to C while offline (review 16 G)', () => {
  it("C's save is refused (it was opened again) and C already holds it: no copy, and no way back", async () => {
    await startOn('C');
    noteBackendConnection('offline');
    // The agent's node reaches the tab by sync (the backend has it too).
    const withNote = [textNode('n1', 'C'), textNode('n2', 'Agent note')];
    emit({ type: 'graphSync', workspaceRevision: 'rev-C', paramsVersion: GRAPH_PARAMS_VERSION, empty: false, edges: [],
      nodes: withNote, edit: { actor: { kind: 'agent', name: 'Codex' } } });
    await flush();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    saved.C = project('C', 'Agent C', withNote);
    saved.D = project('D', 'Agent D', []);
    switched('D', 'C', 'rev-C', 'rev-D', true);
    switched('C', 'D', 'rev-D', 'rev-C2', false);
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot, revision) => {
      if (id === 'C' && revision === 'rev-C') {
        throw new projects.ProjectRequestError('This project view is out of date.', 409, { heading: "Couldn't save the project." } as never);
      }
      return { ...saved[id], snapshot };
    });
    vi.mocked(projects.listProjects).mockResolvedValue(listing('C', 'rev-C2'));
    noteBackendConnection('online');
    await vi.waitFor(() => expect(state().busy).toBe(false));
    await vi.waitFor(() => expect(state().switchNotice).not.toBeNull());
    expect(projects.recoverProject).not.toHaveBeenCalled();
    expect(state().activeProject?.id).toBe('C');
    expect(state().switchNotice).toMatchObject({ actorName: 'Codex', created: false, projectName: 'Agent C',
      previousProjectId: null, previousProjectName: null, keptCopy: false });
  });

  it('a held change the saved copy lacks is still kept as a copy', async () => {
    await startOn('C');
    holdUnsavedChange();
    noteBackendConnection('offline');
    saved.D = project('D', 'Agent D', []);
    switched('D', 'C', 'rev-C', 'rev-D', true);
    switched('C', 'D', 'rev-D', 'rev-C2', false);
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot, revision) => {
      if (id === 'C' && revision === 'rev-C') {
        throw new projects.ProjectRequestError('This project view is out of date.', 409, { heading: "Couldn't save the project." } as never);
      }
      return { ...saved[id], snapshot };
    });
    vi.mocked(projects.listProjects).mockResolvedValue(listing('C', 'rev-C2'));
    noteBackendConnection('online');
    await vi.waitFor(() => expect(state().busy).toBe(false));
    await vi.waitFor(() => expect(state().switchNotice).not.toBeNull());
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(state().switchNotice?.keptCopy).toBe(true);
  });
});
