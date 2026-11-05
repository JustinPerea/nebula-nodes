// PR #199 fix round 23, lane B (review 21 reopen-tabs NIT-3, mutants P5 and
// P7): the person's reopen in place.
// - P5: a 409 that carries its own hold names the line, even when an older
//   verdict read before the press holds something else (the carried hold
//   wins over the stale one).
// - P7: a reopen in place that goes moves focus to the canvas it lands on
//   (lines-ui LOW-2 of review 20). focusCanvasSoon is spied, so a focus
//   loop still running from an earlier test can't pass it (lines-ui NIT-1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {}, notePersonAct: () => {},
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
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: unknown) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && path.startsWith('/api/graph')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
vi.mock('../src/lib/canvasFocus', async (original) => {
  const real = await original<typeof import('../src/lib/canvasFocus')>();
  return { ...real, focusCanvasSoon: vi.fn(real.focusCanvasSoon) };
});
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
  getOpenHold: vi.fn(async () => ({ hold: null })),
}));

import { refreshOpenHold, reopenHold, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { focusCanvasSoon } from '../src/lib/canvasFocus';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';

const initial = useProjectStore.getState();
const realCanSwitch = useGraphStore.getState().canSwitchProject;
const P = 'Glass campaign';

const textNode = (id: string, label = 'Hero prompt') => ({ id, type: 'model-node', position: { x: 10, y: 20 },
  data: { definitionId: 'text-input', label, params: { value: id }, state: 'idle', outputs: {} } });
/** Project `id` as Nebula stores it, with the nodes `ids`. */
function project(id = 'alpha', ids: string[] = ['n1']): SavedProject {
  return {
    id, name: id === 'alpha' ? P : id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: ids.length, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: ids.map((nodeId) => textNode(nodeId)), edges: [], runHistory: [], viewport: null, createSessionId: null },
  } as unknown as SavedProject;
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const sync = (workspaceRevision: string) => emit({ type: 'graphSync', workspaceRevision,
  paramsVersion: GRAPH_PARAMS_VERSION, nodes: useGraphStore.getState().nodes.map((node) => ({ ...node })), edges: [],
  empty: false });

/** A node only this window has (a duplicate it hasn't saved), with a local id. */
function localNode(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: false })) }));
  return local.id;
}

let unsubscribe: (() => void) | null = null;
type Verdict = { state: string; nodeId?: string | null; nodeName?: string | null; projectId?: string | null;
  projectName?: string | null; count?: number; fields?: string[] };
const hold = (state: string, more: Partial<Verdict> = {}): Verdict => ({ state, nodeId: null, nodeName: null,
  projectId: null, projectName: null, count: 1, fields: [], ...more });
const refusal = (reason: string, more: { hold?: unknown } = {}) =>
  new projects.ProjectRequestError(reason, 409, { heading: 'Couldn’t open the project.', ...more });
const noticeNow = () => useGraphStore.getState().messageNotice?.text ?? useGraphStore.getState().undoNotice?.text ?? null;
const askToReopen = async () => {
  useProjectStore.setState({ screen: 'home' });
  await useProjectStore.getState().open('alpha');
};
const openedAlpha = () => ({ project: project('alpha'), workspaceRevision: 'rev-a3',
  paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' }) as never;
const LINES = {
  run: `You can reopen “${P}” when the run finishes.`,
  bootstrap: `Nebula couldn’t save its World Labs safeguards. You can reopen “${P}” after you restart Nebula.`,
};

beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  resetKeptCanvasForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, lateNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null,
    canSwitchProject: realCanSwitch });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: null });
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  unsubscribe = subscribeProjectAutosave();
  sync('rev-a');
});
afterEach(async () => {
  resetCanvasFollowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  resetProjectStoreForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setProjectContext(null);
});

describe('review 21 NIT-3 (P5): the 409’s own hold wins over a stale verdict read before the press', () => {
  it('a bootstrap verdict read before the press, then a 409 carrying a run: the run’s line, not the bootstrap one', async () => {
    localNode();
    vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: hold('bootstrap') });
    await refreshOpenHold();
    // Before the press the bootstrap verdict locks nothing (the press goes);
    // after it, it would name a line.
    expect(reopenHold('alpha')).toBeNull();
    expect(reopenHold('alpha', true)?.state).toBe('bootstrap');
    // Nebula's verdict is the run from the 409 on (its next read says so too).
    vi.mocked(projects.openProject).mockImplementation(async () => {
      vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: hold('run') });
      throw refusal('a run', { hold: hold('run') });
    });
    // Every line the canvas shows, however briefly (a live region reads it).
    const shown = new Set<string>();
    const stop = useGraphStore.subscribe(() => { const text = noticeNow(); if (text) shown.add(text); });
    try {
      await askToReopen();
      expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(noticeNow()).toBe(LINES.run));
      // The verdict's 4 s watch reads again: still the run's line.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(noticeNow()).toBe(LINES.run);
    } finally {
      stop();
    }
    // The stale bootstrap line never showed, not even for a moment.
    expect([...shown]).toEqual([LINES.run]);
  });
});

describe('review 21 NIT-3 (P7): a reopen in place that goes moves focus to the canvas', () => {
  it('focusCanvasSoon runs once the reopen lands, and focus reaches the canvas', async () => {
    localNode();
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    document.body.appendChild(canvas);
    const open = document.createElement('button');
    document.body.appendChild(open);
    open.focus();
    try {
      vi.mocked(projects.openProject).mockResolvedValue(openedAlpha());
      vi.mocked(focusCanvasSoon).mockClear();
      await askToReopen();
      expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
      expect(getProjectContext()?.revision).toBe('rev-a3');
      expect(vi.mocked(focusCanvasSoon)).toHaveBeenCalled();
      await vi.waitFor(() => expect(document.activeElement).toBe(canvas));
    } finally {
      canvas.remove();
      open.remove();
    }
  });
});
