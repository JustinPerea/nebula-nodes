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
import { useUIStore } from './uiStore';
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
    // GM - Design, round 4: "Claude Code made “{name}” and opened it. A copy of your unsaved changes is in Projects."
    expect(switchMessage(useProjectStore.getState().switchNotice!))
      .toBe('Claude Code made “Agent sketches” and opened it. A copy of your unsaved changes is in Projects.');
  });

  // GM - Design, round 4 (one line at 560 px): the kept-copy forms, verbatim. The
  // forms without a kept copy and the agent's name are unchanged.
  it.each([
    [false, true, 'Claude Code opened “Agent sketches”. A copy of your unsaved changes is in Projects.'],
    [true, true, 'Claude Code made “Agent sketches” and opened it. A copy of your unsaved changes is in Projects.'],
    [false, false, 'Claude Code opened “Agent sketches”.'],
    [true, false, 'Claude Code made a new project, “Agent sketches”, and opened it.'],
  ])('the toast for created=%s, keptCopy=%s reads GM\'s line', (created, keptCopy, line) => {
    expect(switchMessage({ actorName: 'Claude Code', created, projectName: 'Agent sketches',
      previousProjectId: 'p1', previousProjectName: 'Loop', keptCopy })).toBe(line);
  });

  it('an unnamed script keeps its own name in the kept-copy line', () => {
    expect(switchMessage({ actorName: null, created: false, projectName: 'Agent sketches',
      previousProjectId: 'p1', previousProjectName: 'Loop', keptCopy: true }))
      .toBe('An outside app opened “Agent sketches”. A copy of your unsaved changes is in Projects.');
  });

  it('an agent reopening this project saves the last edit into it and offers no way "back" to itself', async () => {
    vi.mocked(api.recoverProject).mockClear();
    setPrompt('b');
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [loop], trash: [], activeProjectId: 'p1', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
    } as never);
    vi.mocked(api.getProject).mockResolvedValue(saved(loop));
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: { ...agentSwitch, projectId: 'p1', projectName: 'Loop', created: false } } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(saveProject.mock.calls[0].slice(0, 1).concat(saveProject.mock.calls[0][2])).toEqual(['p1', 'r1']);
    expect(api.recoverProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().switchNotice).toMatchObject({ previousProjectId: null, keptCopy: false });
    expect(switchMessage(useProjectStore.getState().switchNotice!)).toBe('Claude Code opened “Loop”.');
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

describe('the Nodes panel when a project opens (design-canvas gap 19)', () => {
  const followSwitch = async () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r2', activeProjectId: 'p2', graphReplaced: true,
      paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: agentSwitch } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
  };

  it('stays closed on a project with nodes', async () => {
    const withNodes: ProjectSnapshot = { ...empty, nodes: [{
      id: 'n7', type: 'model', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Prompt', params: { value: 'x' }, outputs: {} },
    }] as never };
    vi.mocked(api.getProject).mockResolvedValue(saved(sketches, withNodes));
    useUIStore.setState({ leftDock: 'library' });
    await followSwitch();
    expect(useUIStore.getState().leftDock).toBeNull();
    expect(useUIStore.getState().panels.library.visible).toBe(false);
  });

  it('opens on an empty canvas, ready for its first node', async () => {
    useUIStore.setState({ leftDock: null });
    await followSwitch();
    expect(useUIStore.getState().leftDock).toBe('library');
    expect(useUIStore.getState().panels.library.visible).toBe(true);
  });
});

describe('Projects follows projects other writers make, rename and delete', () => {
  const summer = summary('p3', 'Summer campaign');
  const onProjects = (revision = 'r0') => {
    setProjectContext(null);
    useProjectStore.setState({ screen: 'home', activeProject: null, workspaceRevision: revision, projects: [], trash: [] });
  };
  const listing = (projects: ProjectSummary[], activeProjectId: string | null, workspaceRevision: string) => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects, trash: [], activeProjectId, workspaceRevision, paramsVersion: GRAPH_PARAMS_VERSION,
    } as never);
    vi.mocked(fetchCLIGraph).mockResolvedValue({ nodes: [], edges: [], empty: true, workspaceRevision } as never);
  };

  it('opens an agent’s new project on the canvas from Projects with nothing open, and names the agent', async () => {
    onProjects('r0');
    listing([summer], 'p3', 'r1');
    vi.mocked(api.getProject).mockResolvedValue(saved(summer));
    socket()({ type: 'graphSync', workspaceRevision: 'r1', activeProjectId: 'p3', graphReplaced: true,
      paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: { ...agentSwitch, projectId: 'p3', projectName: 'Summer campaign',
        previousProjectId: null, previousProjectName: null, previousRevision: 'r0' } } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());

    const state = useProjectStore.getState();
    expect(state).toMatchObject({ screen: 'workspace', activeProject: { id: 'p3' }, error: null, initialized: true });
    expect(state.projects.map((project) => project.id)).toEqual(['p3']);
    expect(getProjectContext()).toEqual({ id: 'p3', revision: 'r1' });
    expect(saveProject).not.toHaveBeenCalled();
    expect(state.switchNotice).toMatchObject({ previousProjectId: null, created: true });
    expect(switchMessage(state.switchNotice!)).toBe('Claude Code made a new project, “Summer campaign”, and opened it.');
  });

  it('opens the canvas when Projects still had a project loaded', async () => {
    useProjectStore.setState({ screen: 'home' });
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: agentSwitch } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'p2' } });
    expect(useProjectStore.getState().switchNotice?.previousProjectId).toBe('p1');
  });

  it('doesn’t follow from Projects a switch made from a workspace it never listed, but lists again', async () => {
    onProjects('r0');
    vi.mocked(api.listProjects).mockClear();
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: { ...agentSwitch, previousProjectId: null, previousRevision: 'r9' } } as never);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', switchNotice: null, activeProject: null });
    await vi.waitFor(() => expect(useProjectStore.getState().workspaceRevision).toBe('r2'));
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', activeProject: null });
  });

  it('lists again on Projects after a reconnect’s sync shows changes it missed', async () => {
    onProjects('r0');
    listing([summer], 'p3', 'r1');
    // What a socket gets on (re)connect: no projectsChanged was replayed.
    socket()({ type: 'graphSync', workspaceRevision: 'r1', activeProjectId: 'p3', paramsVersion: GRAPH_PARAMS_VERSION,
      nodes: [], edges: [], empty: true } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['p3']));
    // So its next New project or Open goes from the current revision.
    expect(useProjectStore.getState()).toMatchObject({ workspaceRevision: 'r1', screen: 'home', activeProject: null });
  });

  it('drops the toast’s way back on the canvas once that project is deleted elsewhere', async () => {
    useProjectStore.setState({ switchNotice: { actorName: 'Claude Code', created: true,
      projectName: 'Agent sketches', previousProjectId: 'p1', previousProjectName: 'Loop', keptCopy: false } });
    vi.mocked(api.listProjects).mockClear();
    socket()({ type: 'projectsChanged', change: 'saved', projectId: 'p2' } as never);
    expect(api.listProjects).not.toHaveBeenCalled(); // the canvas's own saves don't list
    listing([sketches], 'p2', 'r1');
    socket()({ type: 'projectsChanged', change: 'deleted', projectId: 'p1' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice?.previousProjectId).toBeNull());
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', workspaceRevision: 'r1' });
  });

  it('lists again on Projects when someone else makes, renames or deletes a project', async () => {
    onProjects('r0');
    listing([summary('p4', 'Renamed by the CLI'), loop], null, 'r5');
    socket()({ type: 'projectsChanged', change: 'renamed', projectId: 'p4' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().projects.map((project) => project.name))
      .toEqual(['Renamed by the CLI', 'Loop']));
    // Nothing open here, so its next New project or Open goes from the current revision.
    expect(useProjectStore.getState().workspaceRevision).toBe('r5');
  });

  it('keeps the switch toast’s way back current: renamed, or gone once deleted', async () => {
    useProjectStore.setState({ screen: 'home', switchNotice: { actorName: 'Claude Code', created: true,
      projectName: 'Agent sketches', previousProjectId: 'p1', previousProjectName: 'Loop', keptCopy: false } });
    listing([sketches, summary('p1', 'Loop v2')], 'p2', 'r1');
    socket()({ type: 'projectsChanged', change: 'renamed', projectId: 'p1' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice?.previousProjectName).toBe('Loop v2'));
    listing([sketches], 'p2', 'r1');
    socket()({ type: 'projectsChanged', change: 'deleted', projectId: 'p1' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice?.previousProjectId).toBeNull());
  });

  it('leaves the toast alone when a listing doesn’t change its way back (its timer keeps running)', async () => {
    const notice = { actorName: 'Claude Code', created: true, projectName: 'Agent sketches',
      previousProjectId: 'p1', previousProjectName: 'Loop', keptCopy: false };
    useProjectStore.setState({ screen: 'home', switchNotice: notice });
    listing([sketches, summary('p4', 'New elsewhere'), loop], 'p2', 'r1');
    socket()({ type: 'projectsChanged', change: 'created', projectId: 'p4' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(3));
    expect(useProjectStore.getState().switchNotice).toBe(notice);
  });

  it('keeps the open project’s revision when it relists', async () => {
    useProjectStore.setState({ screen: 'home' });
    listing([sketches, loop], 'p1', 'r1');
    socket()({ type: 'projectsChanged', change: 'created', projectId: 'p2' } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().projects).toHaveLength(2));
    expect(useProjectStore.getState().workspaceRevision).toBe('r1');
    expect(getProjectContext()).toEqual({ id: 'p1', revision: 'r1' });
  });

  it('waits until the person is back on Projects to list again', async () => {
    vi.mocked(api.listProjects).mockClear();
    listing([sketches, loop], 'p1', 'r1');
    socket()({ type: 'projectsChanged', change: 'created', projectId: 'p2' } as never);
    expect(api.listProjects).not.toHaveBeenCalled();
    await useProjectStore.getState().goHome();
    await vi.waitFor(() => expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['p2', 'p1']));
    expect(api.listProjects).toHaveBeenCalledTimes(1);
  });

  it('lets go of a saved project another window replaced instead of stopping Projects with a conflict', async () => {
    useProjectStore.setState({ screen: 'home' });
    listing([sketches], 'p2', 'r2');
    socket()({ type: 'graphSync', workspaceRevision: 'r2', activeProjectId: 'p2', graphReplaced: true,
      paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['p2']));
    expect(useProjectStore.getState()).toMatchObject({ initialized: true, error: null, activeProject: null, screen: 'home' });
    expect(getProjectContext()).toBeNull();
    expect(useProjectStore.getState().workspaceRevision).toBe('r2');
  });

  it('still keeps unsaved work on Projects as a conflict', () => {
    useProjectStore.setState({ screen: 'home' });
    setPrompt('unsaved');
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    expect(useProjectStore.getState()).toMatchObject({ initialized: false });
    expect(useProjectStore.getState().error).toContain('another window');
  });
});
