/**
 * Fix round 3 of PR #200 (review 3 and GM's round 3 answers), the store side:
 * - M-2: an interrupted note is kept per project. A second interruption on
 *   another project never replaces the first (review 3's A → B (typed) → C).
 *   GM: "one note per project. On another project, name its project: “Your
 *   note for “Alpha” wasn’t sent because Codex started opening “Second
 *   canvas”.” On its own project the line stays as it is. Notices stack,
 *   newest at the bottom, each with its own Copy note and ×." Only the
 *   person's × drops one.
 * - N-3: a failed send's error stays on its project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string; revision: string | null; canvas?: string | null }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
  /** Answers never given in the test: given after it, so no test leaves a write out. */
  hanging: [] as Array<() => void>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(), setViewing: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  const { getProjectContext } = await import('../src/lib/projectContext');
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: { project?: { revision: string } | null }) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && (path.startsWith('/api/graph') || path.startsWith('/api/cinema') || path.startsWith('/api/canvas/pins'))) {
        const project = options && 'project' in options ? options.project : getProjectContext();
        graphWrites.sent.push({ method, path, body: String(init?.body ?? ''), revision: project?.revision ?? null,
          canvas: (project as { canvas?: string } | null)?.canvas ?? null });
        return graphWrites.answer ? graphWrites.answer(path, init)
          : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // The pins listing a replacement reads (canvasPinsStore.hydrate).
      if (method === 'GET' && path === '/api/canvas/pins') {
        return Promise.resolve(new Response('{"projectId":null,"pins":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';

const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta'), summary('gamma')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  graphWrites.sent = [];
  graphWrites.answer = null;
  resetProjectStoreForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, lateNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b',
    paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
  await useProjectStore.getState().initialize();
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  resetCanvasFollowForTests();
  useGraphStore.getState().finishCanvasReplacement?.(null);
  for (const release of graphWrites.hanging.splice(0)) release();
  graphWrites.answer = null;
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 400));
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
});

import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { keptNoteLine } from '../src/lib/canvasPins';

const resetPins = () => useCanvasPinsStore.setState({ projectId: null, pins: [], composer: null, removing: {}, error: null,
  errorProject: null, composerCanvas: null, draft: '', drafts: {}, kept: [] } as never);
const pins = useCanvasPinsStore;

/** Codex opens `to` from `from`: the open dialog closes as the switch is heard; the returned wait lands on `to`. */
let revisionNow = 'rev-a';
const agentOpensSlow = (from: string, fromName: string, to: string, revision: string) => {
  const previousRevision = revisionNow;
  revisionNow = revision;
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: to, workspaceRevision: revision }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project(to), workspaceRevision: revision,
    paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
  emit({ type: 'graphSync', workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    graphReplaced: true,
    projectSwitch: { projectId: to, projectName: to, previousProjectId: from, previousProjectName: fromName,
      previousRevision, actor: { kind: 'agent', name: 'Codex' } } });
  return async () => {
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe(to));
    await flush();
  };
};
const lines = (here: string) => pins.getState().kept.map((note) => keptNoteLine(note, here));

describe('M-2: interrupted notes are kept per project; a second never replaces the first', () => {
  beforeEach(() => { resetPins(); revisionNow = 'rev-a'; });
  afterEach(() => resetPins());

  it('A → B (typed) → C: both notes kept, each naming its project on C, newest at the bottom', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('A note typed');
    const toB = agentOpensSlow('alpha', 'Glass campaign', 'beta', 'rev-b');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    await toB();
    // On B the dialog starts empty; A's notice stays beside it.
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
    pins.getState().setDraft('B note typed');
    const toC = agentOpensSlow('beta', 'beta', 'gamma', 'rev-c');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(2));
    await toC();
    expect(pins.getState().kept.map((note) => [note.text, note.project])).toEqual([
      ['A note typed', 'alpha'], ['B note typed', 'beta']]);
    expect(lines('gamma')).toEqual([
      'Your note for “Glass campaign” wasn’t sent because Codex started opening “beta”.',
      'Your note for “beta” wasn’t sent because Codex started opening “gamma”.',
    ]);
    // On its own project the line stays as it is.
    expect(keptNoteLine(pins.getState().kept[0], 'alpha')).toBe('Your note wasn’t sent because Codex started opening “beta”.');
    expect(pins.getState().drafts).toEqual({});
  });

  it('only the person drops a note: × drops that one; a follow, a clear or another dialog never does', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('A note');
    const toB = agentOpensSlow('alpha', 'Glass campaign', 'beta', 'rev-b');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    await toB();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('B note');
    const toC = agentOpensSlow('beta', 'beta', 'gamma', 'rev-c');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(2));
    await toC();
    // A dialog on C (no note of its own) leaves both.
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().cancelCompose();
    expect(pins.getState().kept).toHaveLength(2);
    pins.getState().dismissKept('beta');
    expect(pins.getState().kept.map((note) => note.project)).toEqual(['alpha']);
    pins.getState().dismissKept('alpha');
    expect(pins.getState().kept).toEqual([]);
  });

  it('a note opened again on its own project leaves the dialog there and only that notice closes', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('A note');
    const toB = agentOpensSlow('alpha', 'Glass campaign', 'beta', 'rev-b');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    await toB();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('B note');
    const toA = agentOpensSlow('beta', 'beta', 'alpha', 'rev-a2');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(2));
    await toA();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('A note');
    expect(pins.getState().kept.map((note) => note.project)).toEqual(['beta']);
  });

  it('the same project interrupted twice keeps one notice, its newest text, at the bottom', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('first');
    const toB = agentOpensSlow('alpha', 'Glass campaign', 'beta', 'rev-b');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    await toB();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('B note');
    const toA = agentOpensSlow('beta', 'beta', 'alpha', 'rev-a2');
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(2));
    await toA();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('first, then more');
    const toB2 = agentOpensSlow('alpha', 'Glass campaign', 'beta', 'rev-b2');
    await vi.waitFor(() => expect(pins.getState().kept.map((note) => note.project)).toEqual(['beta', 'alpha']));
    await toB2();
    expect(pins.getState().kept.at(-1)).toMatchObject({ project: 'alpha', text: 'first, then more' });
  });
});

describe('N-3: a failed send\'s error stays on its project', () => {
  beforeEach(() => resetPins());
  afterEach(() => resetPins());

  it('the error names the project it was for, and is shown only there', async () => {
    graphWrites.answer = () => Promise.resolve(answer(500, { detail: 'boom' }));
    pins.getState().compose({ nodeId: 'n1' });
    expect(await pins.getState().submit('failed note')).toBe(false);
    expect(pins.getState().error).not.toBeNull();
    expect(pins.getState().errorProject).toBe('alpha');
    graphWrites.answer = null;
  });
});
