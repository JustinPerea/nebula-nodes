/**
 * Round 23 of PR #195: review 22's store findings.
 * - M-1: the "Note for agents" dialog is part of the read-only state. Its
 *   submit and a pin's delete are refused while following (and offline),
 *   through the same lock every canvas surface reads (lib/canvasLock). The
 *   dialog closes when a follow starts or the canvas is replaced (its target
 *   is a node id of the canvas that went); what the person typed is kept in
 *   a notice, never anchored anywhere. The POST says the project and canvas
 *   the note was composed on, so Nebula refuses it once they moved.
 * - L-1: Undo on an agent's clear never overwrites typing Nebula took (its
 *   PUT answered 200), whichever of the clear's broadcast and the 200 the
 *   tab reads first: the step waits for saves still on their way and takes
 *   the values that landed.
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
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';

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



const restoreBodies = () => graphWrites.sent.filter((write) => write.path === '/api/graph/restore')
  .map((write) => JSON.parse(write.body) as { nodes?: Array<{ id: string; data?: { params?: Record<string, unknown> }; params?: Record<string, unknown> }> });
const restoredValue = (body: ReturnType<typeof restoreBodies>[number], id: string) => {
  const node = body.nodes?.find((candidate) => candidate.id === id);
  return node?.data?.params?.value ?? node?.params?.value;
};
const valueOf = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)?.data.params.value;
const agentClear = () => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
  cleared: true, canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } });
const hang = () => new Promise<Response>((resolve) => {
  graphWrites.hanging.push(() => resolve(new Response(JSON.stringify({ detail: 'This canvas is out of date. Open the current project before editing or running it.' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } })));
});

import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { followingSwitch } from '../src/lib/canvasFollow';

const pinWrites = () => graphWrites.sent.filter((write) => write.path.startsWith('/api/canvas/pins'));
const land = () => new Promise<Response>((resolve) => {
  graphWrites.hanging.push(() => resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
const pinAnswer = () => answer(201, { pin: { id: 'pin_new', text: 'Make the sky warmer', anchor: { nodeId: 'n1' },
  position: null, status: 'open', createdAt: '', detached: false, reply: null } });
const resetPins = () => useCanvasPinsStore.setState({ projectId: null, pins: [], composer: null, removing: {}, error: null,
  composerCanvas: null, draft: '', kept: null } as never);

describe('M-1: the note dialog and the pins while following', () => {
  beforeEach(() => resetPins());
  afterEach(() => resetPins());

  it('PIN-F: a note composed before an agent switch and submitted while following sends nothing', async () => {
    const release = slowListing();
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    agentOpens();
    await vi.waitFor(() => expect(followingSwitch()).not.toBeNull());
    expect(await useCanvasPinsStore.getState().submit('Make the sky warmer')).toBe(false);
    expect(pinWrites()).toEqual([]);
    release();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(pinWrites()).toEqual([]);
  });

  it('PIN-A: the dialog closes when the follow starts, and stays closed on the new project', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    agentOpens();
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    await vi.waitFor(() => expect(followingSwitch()).toBeNull());
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(await useCanvasPinsStore.getState().submit('Make the sky warmer')).toBe(false);
    expect(pinWrites()).toEqual([]);
    // Nothing was typed: nothing to keep.
    expect(useCanvasPinsStore.getState().kept).toBeNull();
  });

  it('what the person typed is kept, not anchored anywhere', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    useCanvasPinsStore.getState().setDraft('Make the sky warmer');
    agentOpens();
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().kept).toEqual({ text: 'Make the sky warmer' });
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(pinWrites()).toEqual([]);
  });

  it('a clear of the canvas closes the dialog too (its node ids start again)', () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    useCanvasPinsStore.getState().setDraft('warmer');
    agentClear();
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().kept).toEqual({ text: 'warmer' });
  });

  it('loadProjectGraph closes it (a project loaded over the canvas)', () => {
    useCanvasPinsStore.getState().compose({ position: { x: 1, y: 2 } });
    useCanvasPinsStore.getState().setDraft('here');
    expect(useGraphStore.getState().loadProjectGraph([], [], [])).toBe(true);
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().kept).toEqual({ text: 'here' });
  });

  it('PIN-D: deleting a note while following sends nothing and keeps it', async () => {
    const release = slowListing();
    useCanvasPinsStore.setState({ pins: [{ id: 'pin_1', text: 'x', anchor: { nodeId: 'n1' } } as never] });
    agentOpens();
    await vi.waitFor(() => expect(followingSwitch()).not.toBeNull());
    await useCanvasPinsStore.getState().remove('pin_1');
    expect(pinWrites()).toEqual([]);
    expect(useCanvasPinsStore.getState().pins.map((pin) => pin.id)).toEqual(['pin_1']);
    release();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
  });

  it('offline: compose, submit and delete send nothing (the same lock)', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    noteBackendConnection('offline');
    expect(await useCanvasPinsStore.getState().submit('warmer')).toBe(false);
    // Offline keeps the dialog open with the text (PR #114, round 15).
    expect(useCanvasPinsStore.getState().composer).toEqual({ nodeId: 'n1' });
    useCanvasPinsStore.setState({ pins: [{ id: 'pin_1', text: 'x', anchor: { nodeId: 'n1' } } as never] });
    await useCanvasPinsStore.getState().remove('pin_1');
    expect(pinWrites()).toEqual([]);
    resetBackendConnectionForTests();
  });

  it('the POST names the project and canvas the note was composed on, not the one open when it is sent', async () => {
    graphWrites.answer = () => Promise.resolve(pinAnswer());
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    // The tab's context moved with nothing telling the pin store (a write
    // path's adoption, a missed sync): the note still says where it was written.
    setProjectContext({ id: 'beta', revision: 'rev-b', canvas: '0' });
    expect(await useCanvasPinsStore.getState().submit('Make the sky warmer')).toBe(true);
    expect(pinWrites().map((write) => [write.method, write.revision, write.canvas])).toEqual([['POST', 'rev-a', '4']]);
  });

  it('Nebula refusing the note as out of date keeps the text', async () => {
    graphWrites.answer = () => Promise.resolve(answer(409, { detail: 'This canvas is out of date. Open the current project before editing or running it.' }));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    expect(await useCanvasPinsStore.getState().submit('Make the sky warmer')).toBe(false);
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().kept).toEqual({ text: 'Make the sky warmer' });
    expect(useCanvasPinsStore.getState().error).toBeNull();
  });
});

describe('L-1: Undo on an agent clear never overwrites a save Nebula took', () => {
  const sentPut = () => vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1')).toBe(true), { timeout: 2000 });
  const holdPut = () => {
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT' ? land() : Promise.resolve(answer()));
  };

  it('GA-LATE: the clear\'s broadcast before the PUT\'s 200, then Undo: the landed typing is restored', async () => {
    holdPut();
    type('alpha landed');
    await sentPut();
    agentClear();
    await flush();
    for (const release of graphWrites.hanging.splice(0)) release();
    await flush(); await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha landed');
    await vi.waitFor(() => expect(valueOf('n1')).toBe('alpha landed'));
  });

  it('GA-EARLY: the 200 before the clear\'s broadcast, then Undo: the landed typing is restored', async () => {
    holdPut();
    type('alpha landed');
    await sentPut();
    for (const release of graphWrites.hanging.splice(0)) release();
    await flush(); await flush();
    agentClear();
    graphWrites.answer = null;
    await vi.waitFor(() => expect(useGraphStore.getState().undoNotice?.offer).toBe('undo'));
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha landed');
  });

  it('Undo pressed while the PUT is still out waits for its answer, then restores what landed', async () => {
    holdPut();
    type('alpha landed');
    await sentPut();
    agentClear();
    await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await flush(); await flush();
    // Not before the answer: the restore can't know yet what Nebula saved.
    expect(restoreBodies()).toEqual([]);
    for (const release of graphWrites.hanging.splice(0)) release();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha landed');
  });

  it('Undo pressed while the PUT is out, and Nebula refuses it: the value saved before is restored', async () => {
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT' ? hang() : Promise.resolve(answer()));
    type('alpha refused');
    await sentPut();
    agentClear();
    await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await flush();
    for (const release of graphWrites.hanging.splice(0)) release();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha');
  });

  it('typing still in its debounce behind a landed PUT: the landed value, never the unsent typing', async () => {
    holdPut();
    type('alpha landed');
    await sentPut();
    type('alpha landed, then more');
    agentClear();
    await flush();
    for (const release of graphWrites.hanging.splice(0)) release();
    await flush(); await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('alpha landed');
  });

  it('a rename on its way that lands after the clear: Undo restores the new name', async () => {
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1/label' && init?.method === 'PUT' ? land() : Promise.resolve(answer()));
    useGraphStore.getState().renameNode('n1', 'Hero prompt 2');
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1/label')).toBe(true));
    agentClear();
    await flush();
    for (const release of graphWrites.hanging.splice(0)) release();
    await flush(); await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0));
    const node = restoreBodies()[0].nodes?.find((candidate) => candidate.id === 'n1') as { data?: { label?: string }; label?: string };
    expect(node.data?.label ?? node.label).toBe('Hero prompt 2');
  });
});

describe('GM round 23: a replacement found with no agent saves the edits as a copy', () => {
  const reconnectFindsAnotherCanvas = () => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
    canvasRevision: '12', empty: false, edges: [],
    nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Other prompt', params: { value: 'theirs' }, state: 'idle', outputs: {} } }] });

  it('the typing it cut off goes into a recovered copy, and the line names it with Open copy', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Glass campaign (recovered)') } as never);
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    type('alpha typed');
    reconnectFindsAnotherCanvas();
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1));
    const [source, snapshot] = vi.mocked(projects.recoverProject).mock.calls[0];
    expect(source).toBe('alpha');
    expect((snapshot as { nodes: Array<{ id: string; data: { params: { value: unknown } } }> }).nodes
      .find((node) => node.id === 'n1')?.data.params.value).toBe('alpha typed');
    const notice = () => useGraphStore.getState().messageNotice ?? useGraphStore.getState().undoNotice;
    await vi.waitFor(() => expect(notice()?.text).toBe(
      "Couldn't save “Text” for “Hero prompt”. Your edits were saved as a copy, “Glass campaign (recovered)”."));
    expect(notice()?.copy).toEqual({ projectId: 'copy-1' });
    expect(valueOf('n1')).toBe('theirs');
  });

  it('the copy failing: the line still names what wasn\'t saved', async () => {
    vi.mocked(projects.recoverProject).mockRejectedValue(new TypeError('Failed to fetch'));
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    type('alpha typed');
    reconnectFindsAnotherCanvas();
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalled());
    await flush(); await flush();
    const notice = useGraphStore.getState().messageNotice ?? useGraphStore.getState().undoNotice;
    expect(notice?.text).toBe("Couldn't save “Text” for “Hero prompt”.");
  });

  it('nothing cut off: no copy', async () => {
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    reconnectFindsAnotherCanvas();
    await flush(); await flush();
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
  });
});
