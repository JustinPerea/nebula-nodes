import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

// A tab built for another params version (lib/savedParamsUpgrades.ts) reloads
// instead of saving or running values from before a one-time upgrade. It
// learns the backend's version from graphSync, the project listing or a 409
// params_outdated (lib/paramsOutdated.ts). Unsaved work is saved once as a
// recovered copy first; a clean tab just reloads.
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  // The project coordinator runs ahead of other handlers (wsClient.subscribeFirst).
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { useProjectStore, resetParamsVersionChangeForTests, subscribeProjectAutosave } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { reloadPage, reportParamsOutdated, noteParamsOutdated } from '../src/lib/paramsOutdated';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { ExecutionStartRejectedError } from '../src/lib/api';
import type { SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const NEXT = GRAPH_PARAMS_VERSION + 1;
const initial = useProjectStore.getState();
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
function editCanvas(value = 'Unsaved edit'): void {
  const [node] = useGraphStore.getState().nodes;
  useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value } } }] });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  resetParamsVersionChangeForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
  await useProjectStore.getState().initialize();
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  unsubscribe?.(); unsubscribe = null;
  vi.useRealTimers();
  await flush();
  setProjectContext(null);
});

describe('a backend at a newer params version', () => {
  it('reloads a clean tab without a recovered copy or a save', async () => {
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await flush();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(projects.recoverProject).not.toHaveBeenCalled();
    expect(projects.saveProject).not.toHaveBeenCalled();
    const state = useProjectStore.getState();
    expect(state.error).toMatch(/^Nebula was updated while this tab was open\. Reloading/);
    expect(state.dirty).toBe(false);
  });

  it('saves unsaved work once as a recovered copy at the tab\'s own version, then reloads once', async () => {
    editCanvas();
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    // A refusal and a second sync arrive while it is handled: no second copy or reload.
    reportParamsOutdated(NEXT);
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    const [source, snapshot, , version] = vi.mocked(projects.recoverProject).mock.calls[0];
    expect(source).toBe('alpha');
    expect(snapshot.nodes[0].data.params.value).toBe('Unsaved edit');
    expect(version).toBe(GRAPH_PARAMS_VERSION);
    expect(vi.mocked(projects.recoverProject).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(reloadPage).mock.invocationCallOrder[0]);
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().error).toContain('Your unsaved edits were saved as a recovered project.');
    // The edits are in the copy: the unsaved-changes prompt doesn't stop the reload.
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  it('a refused save (409 params_outdated) leads to the same reload, not a save error to retry', async () => {
    vi.useFakeTimers();
    editCanvas();
    noteParamsOutdated(new Response(JSON.stringify({ code: 'params_outdated', detail: 'Reload the tab',
      paramsVersion: NEXT }), { status: 409 }));
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    // Saves stopped: the pending autosave never runs.
    await vi.advanceTimersByTimeAsync(2000);
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().initialized).toBe(false);
  });

  it('keeps unsaved work and doesn\'t reload when the recovered copy fails, and Retry finishes it', async () => {
    editCanvas();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(new Error('Recovery disk full'));
    reportParamsOutdated(NEXT);
    await vi.waitFor(() => expect(useProjectStore.getState().error).toContain('Recovery disk full'));
    expect(reloadPage).not.toHaveBeenCalled();
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    const first = vi.mocked(projects.recoverProject).mock.calls[0];
    vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
      workspaceRevision: 'rev-rotated', paramsVersion: NEXT });
    await useProjectStore.getState().retry();
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    // The same copy (same recoveryId), so a retry can't make two.
    expect(vi.mocked(projects.recoverProject).mock.calls).toEqual([first, first]);
    expect(projects.getProject).toHaveBeenCalledTimes(1); // only the first load
  });

  it('reloads from startup when the listing reports a newer version, without loading the project', async () => {
    unsubscribe?.(); unsubscribe = null;
    useProjectStore.setState(initial, true);
    setProjectContext(null);
    vi.mocked(projects.getProject).mockClear();
    vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
      workspaceRevision: 'rev-rotated', paramsVersion: NEXT });
    await useProjectStore.getState().retry();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(projects.getProject).not.toHaveBeenCalled();
    expect(getProjectContext()).toBeNull();
    expect(projects.recoverProject).not.toHaveBeenCalled();
  });

  it('stops instead of reloading again when the reload brought the same old frontend', async () => {
    window.sessionStorage.setItem('nebula:paramsReloadedFor', String(NEXT));
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(useProjectStore.getState().error).toMatch(/still has the frontend from before the update.*Rebuild the frontend/);
    // A later report doesn't start another handling.
    reportParamsOutdated(NEXT);
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('clears the reload mark once the versions match', async () => {
    window.sessionStorage.setItem('nebula:paramsReloadedFor', String(NEXT));
    useProjectStore.setState({ initialized: false });
    await useProjectStore.getState().retry();
    expect(window.sessionStorage.getItem('nebula:paramsReloadedFor')).toBeNull();
  });
});

describe('a backend at an older params version', () => {
  it('stops saving and says to restart the backend, without reloading', async () => {
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION - 1,
      nodes: [], edges: [], empty: true });
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(useProjectStore.getState().error).toMatch(/newer than the Nebula backend.*Restart the backend/);
    expect(useProjectStore.getState().initialized).toBe(false);
  });
});

describe('graphSync from another workspace or version is not merged', () => {
  const backendNode = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'text-input', label: 'Text', params: { value: 'from backend' }, state: 'idle', outputs: {} } };

  it('ignores a sync with another revision: no merge, nothing to save', async () => {
    vi.useFakeTimers();
    // Same version: this is main's path too (its graphStore has the same check).
    emit({ type: 'graphSync', workspaceRevision: 'rev-other', paramsVersion: GRAPH_PARAMS_VERSION,
      nodes: [backendNode], edges: [], empty: false });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    await vi.advanceTimersByTimeAsync(2000);
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(projects.recoverProject).not.toHaveBeenCalled();
  });

  it('ignores a sync at another params version even with this revision', async () => {
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: NEXT,
      nodes: [backendNode], edges: [], empty: false });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    await flush();
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('merges a sync at this revision and version as before', () => {
    emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
      nodes: [backendNode], edges: [], empty: false });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('from backend');
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

describe('review round 2', () => {
  const refusal = () => new Response(JSON.stringify({ code: 'params_outdated', detail: 'Reload the tab',
    paramsVersion: NEXT }), { status: 409 });

  describe('a Run refused with params_outdated is not unsaved work', () => {
    // The refusal reaches projectStore (apiFetch's noteParamsOutdated) and the
    // run's own catch in either order; neither may count the refused run.
    it.each([
      ['the refusal is reported before the start fails', true],
      ['the start fails before the refusal is reported', false],
    ])('a clean tab reloads without a recovered copy when %s', async (_label, reportFirst) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.spyOn(execution, 'executeGraph').mockImplementation(async () => {
        if (reportFirst) { reportParamsOutdated(NEXT); await flush(); } else noteParamsOutdated(refusal());
        throw new ExecutionStartRejectedError('Reload the tab', 409);
      });
      await useGraphStore.getState().executeGraph();
      await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
      expect(projects.recoverProject).not.toHaveBeenCalled();
      expect(projects.saveProject).not.toHaveBeenCalled();
      expect(useProjectStore.getState().error).toContain('Your saved work is kept.');
    });

    it('an edited tab\'s recovered copy keeps the edit and leaves out the refused run', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      editCanvas();
      vi.spyOn(execution, 'executeGraph').mockImplementation(async () => {
        reportParamsOutdated(NEXT);
        await flush();
        throw new ExecutionStartRejectedError('Reload the tab', 409);
      });
      await useGraphStore.getState().executeGraph();
      await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
      expect(projects.recoverProject).toHaveBeenCalledTimes(1);
      const [, snapshot] = vi.mocked(projects.recoverProject).mock.calls[0];
      expect(snapshot.nodes[0].data.params.value).toBe('Unsaved edit');
      expect(snapshot.runHistory).toEqual([]);
    });
  });

  describe('a backend that sends no paramsVersion predates the gate (version 0)', () => {
    it('startup stops before loading a project and says to restart the backend', async () => {
      unsubscribe?.(); unsubscribe = null;
      useProjectStore.setState(initial, true);
      setProjectContext(null);
      vi.mocked(projects.getProject).mockClear();
      vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
        workspaceRevision: 'rev-a' });
      await useProjectStore.getState().retry();
      expect(projects.getProject).not.toHaveBeenCalled();
      expect(getProjectContext()).toBeNull();
      expect(reloadPage).not.toHaveBeenCalled();
      expect(useProjectStore.getState().initialized).toBe(false);
      expect(useProjectStore.getState().error).toMatch(/newer than the Nebula backend.*Restart the backend/);
    });

    it('a graphSync without it is not merged and stops the tab', async () => {
      const backendNode = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input',
        label: 'Text', params: { value: 'max_tokens 4096 from main' }, state: 'idle', outputs: {} } };
      emit({ type: 'graphSync', workspaceRevision: 'rev-a', nodes: [backendNode], edges: [], empty: false });
      await flush();
      expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
      expect(useProjectStore.getState().initialized).toBe(false);
      expect(useProjectStore.getState().error).toMatch(/Restart the backend/);
      expect(projects.recoverProject).not.toHaveBeenCalled();
      expect(reloadPage).not.toHaveBeenCalled();
    });

    it('an open reply without it is not applied', async () => {
      vi.mocked(projects.openProject).mockResolvedValue({ project: { ...project('beta'), snapshot: {
        ...project('beta').snapshot } }, workspaceRevision: 'rev-b' });
      useProjectStore.setState({ screen: 'home' });
      await useProjectStore.getState().open('beta');
      expect(projects.openProject).toHaveBeenCalledTimes(1);
      expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
      expect(getProjectContext()?.id).not.toBe('beta');
      expect(useProjectStore.getState().screen).toBe('home');
      expect(useProjectStore.getState().initialized).toBe(false);
      expect(useProjectStore.getState().error).toMatch(/Restart the backend/);
    });
  });

  it('with sessionStorage blocked, asks for a reload instead of a rebuild', async () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    try {
      emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
      await flush();
      // Without the mark a reload could repeat forever, so the tab asks.
      expect(reloadPage).not.toHaveBeenCalled();
      const { error } = useProjectStore.getState();
      expect(error).toMatch(/^Nebula was updated while this tab was open\. Reload the tab to use the update\./);
      expect(error).not.toMatch(/Rebuild/);
      expect(error).toContain('Your saved work is kept.');
    } finally { getItem.mockRestore(); setItem.mockRestore(); }
  });
});
