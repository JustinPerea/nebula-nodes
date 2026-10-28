import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 5 of PR #199 (GM r7): a restore from Recently deleted refused
// because the list filled between render and click (the race) is the same
// neutral toast as Undo's refusal, never the banner. The held model (GM,
// 2026-10-28): an agent's clear or graph load that made Nebula hold the
// waiting canvas aside, or that Nebula refused at the limit, is one Agent
// log line, no toast.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  restoreProject: vi.fn(),
  listProjects: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';

const restoreProject = vi.mocked(api.restoreProject);
const listProjects = vi.mocked(api.listProjects);
const ALPHA = 'a'.repeat(32);
const alpha = { id: ALPHA, name: 'Alpha', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z',
  lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null, deletedAt: '2026-10-27T10:00:00Z',
  purgeAt: '2026-11-26T10:00:00Z' };
const limitRefusal = () => new api.ProjectRequestError('Project limit reached', 413,
  { heading: "Couldn't restore the project.", detail: 'Project limit reached', storageLimit: 'projects' });
const LINE = "Couldn't restore “Alpha”. You've reached the limit of 3 projects.";

let unsubscribe: () => void = () => {};
const logged: string[] = [];
const onLog = (event: Event) => logged.push(String((event as CustomEvent).detail?.message));

beforeEach(() => {
  resetProjectStoreForTests();
  restoreProject.mockReset();
  listProjects.mockReset().mockResolvedValue({ projects: [], trash: [alpha], activeProjectId: null,
    workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, projectLimit: 3 } as never);
  setProjectContext(null);
  logged.length = 0;
  window.addEventListener('nebula:agent-log-entry', onLog);
  useProjectStore.setState({
    screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [alpha], catalogRestore: null, dirty: false, saveStatus: 'saved', error: null,
    projectLimit: 3, lastDeleted: null,
  } as never);
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  window.removeEventListener('nebula:agent-log-entry', onLog);
  unsubscribe();
});

describe('GM r7: a restore refused by the race', () => {
  it('is the neutral toast from Recently deleted, never the banner', async () => {
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA);
    const state = useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha', refused: LINE });
  });

  it('takes the place of a toast already up for it', async () => {
    useProjectStore.setState({ lastDeleted: { id: ALPHA, name: 'Alpha', refused: LINE } });
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA);
    const state = useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.lastDeleted?.refused).toBe(LINE);
  });
});

const send = (event: Record<string, unknown>) => {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  handler(event as never);
};

describe('GM held model: the Agent log', () => {
  it('logs a hold an agent caused, with its name', () => {
    send({ type: 'projectsChanged', change: 'canvasHeld', projectId: null, canvasHeld: { action: 'cleared', agent: 'Codex' } });
    expect(logged).toEqual(['Codex cleared the canvas. The one you had open is kept until Nebula can save it as a project.']);
  });

  it('logs a refused replace, "An agent" when unnamed', () => {
    send({ type: 'projectsChanged', change: 'canvasHoldRefused', projectId: null, canvasHeld: { action: 'replace', agent: null } });
    expect(logged).toEqual(["An agent tried to replace the canvas you had open. Nebula stopped it because that canvas isn't saved as a project yet."]);
  });

  it('shows no toast for either', () => {
    send({ type: 'projectsChanged', change: 'canvasHeld', projectId: null, canvasHeld: { action: 'replaced', agent: 'Codex' } });
    const state = useProjectStore.getState();
    expect(state.lastDeleted).toBeNull();
    expect(state.error).toBeNull();
  });
});
