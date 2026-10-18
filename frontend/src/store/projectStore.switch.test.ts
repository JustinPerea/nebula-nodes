import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  openProject: vi.fn(),
  recoverProject: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCLIGraph: vi.fn(),
}));

import * as api from '../lib/projects';
import { fetchCLIGraph } from '../lib/api';
import { getProjectContext, setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import type { ProjectSwitch } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { subscribeProjectAutosave, switchMessage, useProjectStore } from './projectStore';
import type { ProjectSnapshot, ProjectSummary, SavedProject } from '../lib/projects';

const saveProject = vi.mocked(api.saveProject);
const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-18T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const loop = summary('p1', 'Loop');
const sketches = summary('p2', 'Agent sketches');
const empty: ProjectSnapshot = { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null };
const saved = (project: ProjectSummary, snapshot: ProjectSnapshot = empty): SavedProject => ({ ...project, snapshot });

function setPrompt(prompt: string): void {
  useGraphStore.setState({ nodes: [{
    id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt }, outputs: {} },
  }] as never });
}

const agentSwitch: ProjectSwitch = {
  actor: { kind: 'agent', name: 'Claude Code', color: '#f80' },
  projectId: 'p2', projectName: 'Agent sketches', previousProjectId: 'p1', previousProjectName: 'Loop',
  previousRevision: 'r1', created: true,
};

function socket() {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  return handler;
}

let unsubscribe: () => void = () => {};

beforeEach(async () => {
  saveProject.mockReset();
  saveProject.mockImplementation(async (id, snapshot) => saved(id === 'p1' ? loop : sketches, snapshot));
  vi.mocked(api.listProjects).mockResolvedValue({
    projects: [sketches, loop], trash: [], activeProjectId: 'p2', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
  } as never);
  vi.mocked(api.getProject).mockResolvedValue(saved(sketches));
  vi.mocked(fetchCLIGraph).mockResolvedValue({ nodes: [], edges: [], empty: true, workspaceRevision: 'r2' } as never);
  setProjectContext({ id: 'p1', revision: 'r1' });
  setPrompt('a');
  useProjectStore.setState({
    screen: 'workspace', initialized: true, busy: false, activeProject: loop, workspaceRevision: 'r1',
    dirty: false, saveStatus: 'saved', error: null, switchNotice: null,
  });
  await useProjectStore.getState().flush();
  saveProject.mockClear();
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => unsubscribe());

describe('following an agent’s project switch', () => {
  it('follows the switch, keeps this tab’s last edit in the old project, and names the agent', async () => {
    setPrompt('b'); // an edit the backend hasn't seen yet
    socket()({ type: 'graphSync', workspaceRevision: 'r2', activeProjectId: 'p2', graphReplaced: true,
      paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: agentSwitch } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());

    // The last edit went into the project that was open, with the revision it had.
    expect(saveProject).toHaveBeenCalledTimes(1);
    const [id, snapshot, revision] = saveProject.mock.calls[0];
    expect([id, revision, snapshot.nodes[0]?.data.params.prompt]).toEqual(['p1', 'r1', 'b']);
    const state = useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.initialized).toBe(true);
    expect(state.activeProject?.id).toBe('p2');
    expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r2' });
    expect(state.switchNotice).toMatchObject({ actorName: 'Claude Code', previousProjectId: 'p1', keptCopy: false });
    expect(switchMessage(state.switchNotice!)).toBe('Claude Code made a new project, “Agent sketches”, and opened it.');
  });

  it('offers the way back: Back reopens the previous project', async () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: { ...agentSwitch, created: false } } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(saveProject).not.toHaveBeenCalled(); // nothing unsaved, nothing to hand off
    expect(switchMessage(useProjectStore.getState().switchNotice!)).toBe('Claude Code opened “Agent sketches”.');

    vi.mocked(api.openProject).mockResolvedValueOnce({ project: saved(loop), workspaceRevision: 'r3', paramsVersion: GRAPH_PARAMS_VERSION });
    await useProjectStore.getState().switchBack();
    expect(api.openProject).toHaveBeenCalledWith('p1', 'r2');
    expect(useProjectStore.getState()).toMatchObject({ activeProject: { id: 'p1' }, switchNotice: null });
  });

  it('keeps the edit as a recovered copy when the old project refuses it', async () => {
    setPrompt('b');
    saveProject.mockRejectedValueOnce(new Error('changed elsewhere'));
    vi.mocked(api.recoverProject).mockResolvedValueOnce({ project: saved(summary('p3', 'Loop (recovered)')), workspaceRevision: 'r2' } as never);
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: agentSwitch } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(api.recoverProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().switchNotice?.keptCopy).toBe(true);
    expect(switchMessage(useProjectStore.getState().switchNotice!)).toContain('kept as a copy in Projects');
  });

  it('still treats a switch the person made in another window as a conflict', () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    expect(useProjectStore.getState()).toMatchObject({ initialized: false, switchNotice: null });
    expect(useProjectStore.getState().error).toContain('another window');
  });

  it('doesn’t follow a switch away from some other project or revision', () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: { ...agentSwitch, previousRevision: 'r0' } } as never);
    expect(useProjectStore.getState()).toMatchObject({ initialized: false, switchNotice: null });
  });
});
