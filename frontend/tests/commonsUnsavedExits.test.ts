import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

/**
 * While Blind labeling or Agent review holds unsaved labels (or is saving or
 * generating), CommonsView publishes it (lib/commonsUnsaved) and nothing in
 * the app may take the person out of the Commons: App unmounts CommonsView
 * as soon as viewMode leaves 'commons' (or the capability goes off, or the
 * screen goes to Projects), and the labels go with it. These pin each exit
 * at the stores, where every caller ends up (commons-exits, 2026-10-22).
 */
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
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { useProjectStore, resetProjectStoreForTests, subscribeProjectAutosave } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { setProjectContext } from '../src/lib/projectContext';
import { setCommonsUnsaved } from '../src/lib/commonsUnsaved';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const REASON = 'The Commons has unsaved changes: save or discard them first.';
const initialProjects = useProjectStore.getState();
const initialUI = useUIStore.getState();

function project(id = 'alpha'): SavedProject {
  return {
    id, name: id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The person in the Commons, opened from `from`, with or without unsaved labels. */
function inCommons(unsaved: boolean, from: 'canvas' | 'moodboard-editor' | 'cinema-editor' = 'canvas'): void {
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: from,
    ...(from === 'moodboard-editor' ? { moodboardEditorId: 'board-1' } : {}),
    ...(from === 'cinema-editor' ? { cinemaEditorNodeId: 'n1' } : {}) });
  setCommonsUnsaved(unsaved);
}

/** An agent's open_project of 'beta' (MCP or the CLI): the graphSync names the switch. */
function agentOpensBeta(): void {
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project(), project('beta')], activeProjectId: 'beta',
    workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION });
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'alpha',
      previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' } } });
}

/** The person opened another project in a second tab: no switch notice, so this tab stops (a conflict). */
function otherTabOpensBeta(): void {
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true });
}

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  setCommonsUnsaved(false);
  resetProjectStoreForTests();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false });
  useProjectStore.setState(initialProjects, true);
  useUIStore.setState(initialUI, true);
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  unsubscribe?.(); unsubscribe = null;
  setCommonsUnsaved(false);
  await flush();
  setProjectContext(null);
  useUIStore.setState(initialUI, true);
});

describe('a project opened elsewhere while the Commons holds unsaved labels', () => {
  it("an agent's open still opens it; the person stays in the Commons, and Back then lands on its canvas", async () => {
    inCommons(true, 'moodboard-editor');
    agentOpensBeta();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await flush();
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', initialized: true });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('beta');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });

    setCommonsUnsaved(false);
    expect(useUIStore.getState().viewMode).toBe('commons');
    useUIStore.getState().exitCommons();
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it("an agent's open takes a clean Commons to the new project's canvas, as before", async () => {
    inCommons(false);
    agentOpensBeta();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('a second tab opening one stops this tab only once the Commons is clean, then shows Projects', async () => {
    inCommons(true);
    otherTabOpensBeta();
    await flush();
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', initialized: false,
      error: expect.stringMatching(/^The active project changed in another window/) });
    expect(useUIStore.getState().viewMode).toBe('commons');

    setCommonsUnsaved(false);
    expect(useProjectStore.getState().screen).toBe('home');
  });

  it('a second tab opening one takes a clean Commons to Projects at once, as before', async () => {
    inCommons(false);
    otherTabOpensBeta();
    await flush();
    expect(useProjectStore.getState().screen).toBe('home');
  });
});

describe('Projects (goHome) while the Commons holds unsaved labels', () => {
  it('is refused with the reason, and works once the labels are saved', async () => {
    inCommons(true);
    await expect(useProjectStore.getState().goHome()).rejects.toThrow(REASON);
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useUIStore.getState().viewMode).toBe('commons');

    setCommonsUnsaved(false);
    expect(useProjectStore.getState().screen).toBe('workspace');
    await useProjectStore.getState().goHome();
    expect(useProjectStore.getState().screen).toBe('home');
  });

  it('works from a clean Commons, as before', async () => {
    inCommons(false);
    await useProjectStore.getState().goHome();
    expect(useProjectStore.getState().screen).toBe('home');
  });

  it('any other write that would show Projects waits until the Commons is clean', () => {
    inCommons(true);
    useProjectStore.setState({ screen: 'home', error: 'Something went wrong.' });
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', error: 'Something went wrong.' });
    setCommonsUnsaved(false);
    expect(useProjectStore.getState().screen).toBe('home');
  });

  it('a held Projects is dropped when a later write shows the workspace again', () => {
    inCommons(true);
    useProjectStore.setState({ screen: 'home' });
    useProjectStore.setState({ screen: 'workspace' });
    setCommonsUnsaved(false);
    expect(useProjectStore.getState().screen).toBe('workspace');
  });
});

describe('the Commons capability turning off while it holds unsaved labels', () => {
  it('waits until the Commons is clean, then leaves to where it was opened from', () => {
    inCommons(true, 'moodboard-editor');
    useUIStore.getState().setCommonsEnabled(false);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsEnabled: true });

    setCommonsUnsaved(false);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', commonsEnabled: false });
  });

  it('stays on when it turns back on before the Commons is clean', () => {
    inCommons(true);
    useUIStore.getState().setCommonsEnabled(false);
    useUIStore.getState().setCommonsEnabled(true);
    setCommonsUnsaved(false);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsEnabled: true });
  });

  it('leaves a clean Commons at once, as before', () => {
    inCommons(false, 'moodboard-editor');
    useUIStore.getState().setCommonsEnabled(false);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', commonsEnabled: false });
  });
});

describe('every other way out of the Commons while it holds unsaved labels', () => {
  const exits: Array<[string, () => void]> = [
    ['exitCommons (Back, the hash route)', () => useUIStore.getState().exitCommons()],
    ['the #brand route', () => useUIStore.getState().enterBrandShowcase()],
    ['a #moodboard link', () => useUIStore.getState().enterMoodboardEditor('board-2')],
    ['the onboarding tour', () => useUIStore.getState().startOnboarding()],
    ["an agent's show-node", () => useUIStore.getState().requestCanvasNodeFocus('n1')],
    ['a graph import (Cmd+O)', () => useUIStore.setState({ viewMode: 'canvas', editorTargetNodeId: null })],
    ['the Creator Studio', () => useUIStore.getState().enterCreateView()],
  ];

  it.each(exits)('%s keeps the person in the Commons', (_name, leave) => {
    inCommons(true);
    leave();
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsEnabled: true });
  });

  it.each(exits)('%s still leaves a clean Commons', (_name, leave) => {
    inCommons(false);
    leave();
    expect(useUIStore.getState().viewMode).not.toBe('commons');
  });

  it('one that sends the person to the canvas makes the canvas where Back goes (the studio it came from may be gone)', () => {
    inCommons(true, 'cinema-editor');
    useUIStore.getState().requestCanvasNodeFocus('n1');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsReturnView: 'canvas', cinemaEditorNodeId: null });
  });

  it('Back keeps where it goes when it is refused', () => {
    inCommons(true, 'moodboard-editor');
    useUIStore.getState().exitCommons();
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'commons', commonsReturnView: 'moodboard-editor' });
    setCommonsUnsaved(false);
    useUIStore.getState().exitCommons();
    expect(useUIStore.getState().viewMode).toBe('moodboard-editor');
  });
});
