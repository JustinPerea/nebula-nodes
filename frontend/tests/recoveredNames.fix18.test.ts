/**
 * Round 18 of PR #199 (review 16 kept-ui LOW-3; GM r25, 5): the tab's side
 * of the recovered-copy names. The reload line names the project a
 * recovered copy was made from, never the copy's own "Recovered …" name, and
 * the tab's fallback name never stacks a second "Recovered" or number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

// A tab built for another params version (lib/savedParamsUpgrades.ts) reloads
// instead of saving or running values from before a one-time upgrade. It
// learns the backend's version from graphSync, the project listing or a 409
// params_outdated (lib/paramsOutdated.ts). Unsaved work is saved once as a
// recovered copy first; a clean tab just reloads.
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {}, notePersonAct: () => {},
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
  restoreProject: vi.fn(),
}));

import { useProjectStore, resetProjectStoreForTests, subscribeProjectAutosave } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { recoveredCopyFallbackName } from '../src/lib/recoveredNames';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
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
  resetProjectStoreForTests();
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


describe('lib/recoveredNames', () => {
  it('never a second “Recovered”: a recovered copy’s copy adds Nebula’s “copy”', () => {
    expect(recoveredCopyFallbackName('Delta')).toBe('Recovered Delta');
    // GM r29, 2 (round 20): no number read in the name; Nebula's own " copy" next.
    expect(recoveredCopyFallbackName('Recovered Delta', ['Recovered Delta'])).toBe('Recovered Delta copy');
    expect(recoveredCopyFallbackName('Recovered Delta 2', ['Recovered Delta 2'])).toBe('Recovered Delta 2 copy');
    // A source the list no longer has (a kept canvas after a restore) is free, as in Nebula's rule.
    expect(recoveredCopyFallbackName('Recovered Alpha copy 2', ['Alpha', 'Beta'])).toBe('Recovered Alpha copy 2');
  });
});

describe('review 16 kept-ui LOW-3: the reload line names the source project', () => {
  it('no project active, the copy named “Recovered alpha”: the line says “alpha”', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered'), name: 'Recovered alpha' });
    editCanvas();
    useProjectStore.setState({ activeProject: null });
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(
      'Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in a recovered copy of “alpha”.'));
  });

  it('the listed name of the source wins when the copy’s name doesn’t say it', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered'), name: 'Untitled copy' });
    editCanvas();
    useProjectStore.setState({ activeProject: null });
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(
      'Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in a recovered copy of “alpha”.'));
  });

  it('a source no longer listed and not in the answer: the line names the copy, never a source read from its name (GM r29, 2)', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('recovered'), name: 'Recovered alpha' });
    editCanvas();
    useProjectStore.setState({ activeProject: null, projects: [] });
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(
      'Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in “Recovered alpha”.'));
  });
});

