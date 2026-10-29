/**
 * Fix round 2 of PR #200 (review 2 and GM's 2026-10-28 answers), the store
 * side, from review 2's probes (r2/fe/fu2.probe.test.ts):
 * - M-2 (GM answer 1): the kept note and a closed draft remember their
 *   project. The dialog starts with them only there; on another project it
 *   starts empty and an interrupted note's notice (with Copy note) stays
 *   until dismissed. A draft the person closed on purpose gets no line at
 *   all. A send that had already failed keeps its own failure line. A
 *   whitespace-only draft is dropped.
 * - L-3: two recovered copies that race each stay named.
 * - N-5: a save released as unanswered after the hold limit that then
 *   answers 200 clears its "Couldn't save … copy" line.
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
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const type = (value: string) => {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1')!;
  useGraphStore.getState().updateNodeData('n1', { params: { ...node.data.params, value } });
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** An agent opened another project (Nebula switched; the canvas hears it). */
const agentOpens = (actor: Record<string, unknown> = { kind: 'agent', name: 'Claude Code' }) => {
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    graphReplaced: true,
    projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
      previousRevision: 'rev-a', actor } });
};

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

const slowListing = () => {
  let listed: (value: ProjectList) => void = () => {};
  vi.mocked(projects.listProjects).mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
  return () => listed(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
};

const agentClear = () => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
  cleared: true, canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } });
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';

const resetPins = () => useCanvasPinsStore.setState({ projectId: null, pins: [], composer: null, removing: {}, error: null,
  composerCanvas: null, draft: '', drafts: {}, kept: [] } as never);
const pins = useCanvasPinsStore;
const sentPut = () => vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1')).toBe(true), { timeout: 2000 });
const STALE = 'This canvas is out of date. Open the current project before editing or running it.';

/** An agent opens a project (the other way: back to alpha). */
const agentOpensAlpha = () => {
  vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'alpha', workspaceRevision: 'rev-c' }));
  emit({ type: 'graphSync', workspaceRevision: 'rev-c', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
    graphReplaced: true,
    projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousProjectId: 'beta', previousProjectName: 'beta',
      previousRevision: 'rev-b', actor: { kind: 'agent', name: 'Codex' } } });
};
const onBeta = async () => {
  agentOpens({ kind: 'agent', name: 'Codex' });
  await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
  await flush();
};
const backOnAlpha = async () => {
  agentOpensAlpha();
  await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('alpha'));
  await flush();
};
const KEPT_LINE = 'Your note wasn’t sent because Codex started opening “beta”.';

describe('M-2 (GM answer 1): a note written for one project never shows in another project\'s dialog', () => {
  beforeEach(() => resetPins());
  afterEach(() => resetPins());

  it('R2-DRAFT-ACROSS: a draft closed on alpha gets no line, leaves beta\'s dialog empty, and prefills alpha\'s again', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('for alpha n1');
    pins.getState().cancelCompose();
    await onBeta();
    expect(pins.getState().kept).toEqual([]);
    expect(pins.getState().error).toBeNull();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
    // Typing on beta and closing keeps beta's own draft beside alpha's.
    pins.getState().setDraft('for beta n1');
    pins.getState().cancelCompose();
    await backOnAlpha();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('for alpha n1');
  });

  it('an interrupted note: kept with its line; beta\'s dialog starts empty and the notice stays; alpha\'s dialog starts with it', async () => {
    const release = slowListing();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('interrupted on alpha');
    agentOpens({ kind: 'agent', name: 'Codex' });
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'interrupted on alpha', line: KEPT_LINE });
    release();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await flush();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'interrupted on alpha', line: KEPT_LINE });
    pins.getState().cancelCompose();
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'interrupted on alpha' });
    await backOnAlpha();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('interrupted on alpha');
    expect(pins.getState().kept).toEqual([]);
  });

  it('a clear on the same project: a closed draft gets no line and still starts the next dialog there', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('warmer sky');
    pins.getState().cancelCompose();
    agentClear();
    expect(pins.getState().kept).toEqual([]);
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('warmer sky');
  });

  it('R2-FAIL-THEN-FOLLOW: a send that had already failed keeps its own failure line, never "wasn’t sent because the canvas changed"', async () => {
    graphWrites.answer = () => Promise.resolve(answer(500, { detail: 'boom' }));
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('failed note');
    expect(await pins.getState().submit('failed note')).toBe(false);
    const failure = pins.getState().error;
    expect(failure).not.toBeNull();
    graphWrites.answer = null;
    await onBeta();
    expect(pins.getState().kept).toEqual([]);
    expect(pins.getState().error).toBe(failure);
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
    pins.getState().cancelCompose();
    await backOnAlpha();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('failed note');
  });

  it('N-4: a whitespace-only draft is dropped, on close and across a canvas change', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('  \n ');
    pins.getState().cancelCompose();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
    pins.getState().setDraft(' \n\t');
    agentClear();
    expect(pins.getState().kept).toEqual([]);
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
  });

  it('a refusal for the canvas gone keeps the note for its own project', async () => {
    graphWrites.answer = () => Promise.resolve(answer(409, { detail: STALE }));
    pins.getState().compose({ nodeId: 'n1' });
    expect(await pins.getState().submit('refused')).toBe(false);
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'refused', line: 'Your note wasn’t sent because the canvas changed first.' });
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('refused');
  });
});

describe('L-3 and N-5: recovered copies', () => {
  const reconnect = (canvas: string, value: string) => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
    canvasRevision: canvas, empty: false, edges: [],
    nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Other', params: { value }, state: 'idle', outputs: {} } }] });
  const holdPut = () => {
    let settle: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { settle = resolve; graphWrites.hanging.push(() => resolve(answer(200))); })
      : Promise.resolve(answer()));
    return (r: Response) => settle(r);
  };
  const notices = () => [useGraphStore.getState().undoNotice, useGraphStore.getState().messageNotice]
    .filter((notice): notice is NonNullable<typeof notice> => Boolean(notice))
    .map((notice) => ({ text: notice.text.replace(/\u00a0/g, ' '), copy: notice.copy?.projectId ?? null }));

  beforeEach(async () => {
    const { setReplacedCopyWaitForTests } = await import('../src/store/graphStore');
    let n = 0;
    vi.mocked(projects.recoverProject).mockImplementation(async () => { n += 1; return { ...project(`copy-${n}`, `Glass campaign (recovered ${n})`) } as never; });
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    setReplacedCopyWaitForTests(300);
  });
  afterEach(async () => {
    const { setReplacedCopyWaitForTests } = await import('../src/store/graphStore');
    setReplacedCopyWaitForTests(null);
  });

  it('R2-COPY-TWICE-BOTH: two copies race; both stay named, each with its own Open copy', async () => {
    const settle = holdPut();
    type('typed first');
    await sentPut();
    reconnect('12', 'theirs');
    await flush(); await flush();
    type('typed second');
    reconnect('13', 'theirs again');
    await flush(); await flush();
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(notices().some((notice) => notice.copy === 'copy-1')).toBe(true));
    settle(new Response(JSON.stringify({ detail: STALE }), { status: 409 }));
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(notices().some((notice) => notice.copy === 'copy-2')).toBe(true));
    const shown = notices();
    expect(shown.some((notice) => notice.copy === 'copy-1' && notice.text.includes('“Glass campaign (recovered 1)”')), JSON.stringify(shown)).toBe(true);
    expect(shown.some((notice) => notice.copy === 'copy-2' && notice.text.includes('“Glass campaign (recovered 2)”')), JSON.stringify(shown)).toBe(true);
  });

  it('R2-COPY-HANG-THEN-200: a save released as unanswered that then lands clears its "Couldn’t save" line', async () => {
    const settle = holdPut();
    type('typed hang');
    await sentPut();
    reconnect('12', 'theirs');
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await vi.waitFor(() => expect(notices().some((notice) => notice.copy === 'copy-1')).toBe(true));
    settle(answer(200));
    await vi.waitFor(() => expect(notices().filter((notice) => /Couldn't save/.test(notice.text))).toEqual([]));
  });

  it('a save released as unanswered that is then refused keeps its line', async () => {
    const settle = holdPut();
    type('typed hang refused');
    await sentPut();
    reconnect('12', 'theirs');
    await vi.waitFor(() => expect(notices().some((notice) => notice.copy === 'copy-1')).toBe(true), { timeout: 3000 });
    settle(new Response(JSON.stringify({ detail: STALE }), { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notices().some((notice) => notice.copy === 'copy-1')).toBe(true);
  });
});
