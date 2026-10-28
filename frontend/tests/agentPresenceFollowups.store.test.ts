/**
 * Follow-ups to PR #195 (agent presence): review 23's store findings, turned
 * from its probes (r23store.probe.test.ts) into tests.
 * - L-2: a save on its way belongs to the canvas it was sent on. Undo of an
 *   agent's clear takes only the landings of the canvas that clear replaced,
 *   never one sent on an earlier canvas whose node ids came back (TWOCLEARS).
 * - L-3: the kept note (GM r24 item 1 and the 2026-10-27 answers): the next
 *   note dialog starts with it and the notice closes; × or Esc keep the text
 *   as the draft; only sending, or clearing the field and closing, drops it;
 *   the notice's own × drops it. The notice gives the reason.
 * - L-5: a save already sent when a replacement with no agent lands, and then
 *   refused, gets the recovered copy too (COPY-INFLIGHT); one that lands
 *   makes none.
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

const restoreBodies = () => graphWrites.sent.filter((write) => write.path === '/api/graph/restore')
  .map((write) => JSON.parse(write.body) as { nodes?: Array<{ id: string; data?: { params?: Record<string, unknown> }; params?: Record<string, unknown> }> });
const restoredValue = (body: ReturnType<typeof restoreBodies>[number], id: string) => {
  const node = body.nodes?.find((candidate) => candidate.id === id);
  return node?.data?.params?.value ?? node?.params?.value;
};
const valueOf = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)?.data.params.value;
const agentClear = () => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
  cleared: true, canvasRevision: '9', nodes: [], edges: [], edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } });
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';

const resetPins = () => useCanvasPinsStore.setState({ projectId: null, pins: [], composer: null, removing: {}, error: null,
  composerCanvas: null, draft: '', drafts: {}, kept: [] } as never);
const pins = useCanvasPinsStore;
const lines = () => [useGraphStore.getState().undoNotice?.text, useGraphStore.getState().messageNotice?.text].filter(Boolean);
const sentPut = () => vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path === '/api/graph/node/n1')).toBe(true), { timeout: 2000 });
const clearAs = (canvas: string, id: string) => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
  cleared: true, canvasRevision: canvas, nodes: [], edges: [], edit: { id, actor: { kind: 'agent', name: 'Codex' } } });
const agentAdds = (canvas: string, value: string, id: string) => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
  empty: false, canvasRevision: canvas, edges: [], edit: { id, actor: { kind: 'agent', name: 'Codex' } },
  nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Agent prompt', params: { value }, state: 'idle', outputs: {} } }] });
const STALE = 'This canvas is out of date. Open the current project before editing or running it.';

describe('L-2: a landing belongs to the canvas it was sent on', () => {
  it('TWOCLEARS: Undo of the second clear restores the agent\'s "AG", not typing sent on the first canvas', async () => {
    let land200: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { land200 = resolve; }) : Promise.resolve(answer()));
    type('typed for the OLD n1');
    await sentPut();
    clearAs('9', 'ed_c1');
    await flush();
    agentAdds('9', 'AG', 'ed_add');
    await flush();
    expect(valueOf('n1')).toBe('AG');
    clearAs('10', 'ed_c2');
    await flush();
    land200(answer(200));
    await flush(); await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0), { timeout: 3000 });
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('AG');
    expect(valueOf('n1')).toBe('AG');
  });

  it('the first clear still takes its own landing (review 22 L-1 holds)', async () => {
    let land200: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { land200 = resolve; }) : Promise.resolve(answer()));
    type('typed and landed');
    await sentPut();
    clearAs('9', 'ed_c1');
    await flush();
    land200(answer(200));
    await flush(); await flush();
    graphWrites.answer = null;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(restoreBodies().length).toBeGreaterThan(0), { timeout: 3000 });
    expect(restoredValue(restoreBodies()[0], 'n1')).toBe('typed and landed');
  });
});

describe('L-3: the kept note', () => {
  beforeEach(() => resetPins());
  afterEach(() => resetPins());

  it('KEPT: opening Note again starts the dialog with the kept text, and the notice closes', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('Make the sky warmer');
    agentClear();
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'Make the sky warmer' });
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('Make the sky warmer');
    expect(pins.getState().kept).toEqual([]);
  });

  it('× or Esc keeps the text as the draft for the next open; clearing the field and closing drops it', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('warmer sky');
    pins.getState().cancelCompose();
    expect(pins.getState().composer).toBeNull();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('warmer sky');
    pins.getState().setDraft('');
    pins.getState().cancelCompose();
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
  });

  it('sending drops it', async () => {
    graphWrites.answer = () => Promise.resolve(answer(201, { pin: { id: 'pin_new', text: 'warmer', anchor: { nodeId: 'n1' },
      position: null, status: 'open', createdAt: '', detached: false, reply: null } }));
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('warmer');
    expect(await pins.getState().submit('warmer')).toBe(true);
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
  });

  it('the notice\'s own × drops it', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('Make the sky warmer');
    agentClear();
    pins.getState().dismissKept(pins.getState().kept.at(-1)?.project ?? '');
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
  });

  it('the notice gives the reason, in GM\'s words: a replacement, a follow, a refusal', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('after a clear');
    agentClear();
    expect(pins.getState().kept.at(-1)?.line).toBe('Your note wasn’t sent because the canvas changed first.');
    pins.getState().dismissKept(pins.getState().kept.at(-1)?.project ?? '');

    const release = slowListing();
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('during a follow');
    agentOpens({ kind: 'agent', name: 'Codex' });
    await vi.waitFor(() => expect(pins.getState().kept).toHaveLength(1));
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'during a follow',
      line: 'Your note wasn’t sent because Codex started opening “beta”.' });
    release();
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    pins.getState().dismissKept(pins.getState().kept.at(-1)?.project ?? '');

    graphWrites.answer = () => Promise.resolve(answer(409, { detail: STALE }));
    pins.getState().compose({ nodeId: 'n1' });
    expect(await pins.getState().submit('refused')).toBe(false);
    expect(pins.getState().kept.at(-1)).toMatchObject({ text: 'refused', line: 'Your note wasn’t sent because the canvas changed first.' });
  });

  it('an unknown agent reads "an agent"', async () => {
    const { noteKeptLine } = await import('../src/lib/canvasPins');
    expect(noteKeptLine({ agent: null, projectName: 'Second canvas' }))
      .toBe('Your note wasn’t sent because an agent started opening “Second canvas”.');
    expect(noteKeptLine(null)).toBe('Your note wasn’t sent because the canvas changed first.');
  });
});

describe('L-5: a save already sent when a no-agent replacement lands', () => {
  const reconnect = (canvas: string, value: string) => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
    canvasRevision: canvas, empty: false, edges: [],
    nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Other', params: { value }, state: 'idle', outputs: {} } }] });

  it('COPY-INFLIGHT: refused after the replacement, it gets the recovered copy and the line says so', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Glass campaign (recovered)') } as never);
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    let settle: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { settle = resolve; }) : Promise.resolve(answer()));
    type('sent before the gap');
    await sentPut();
    reconnect('12', 'theirs');
    await flush(); await flush();
    settle(new Response(JSON.stringify({ detail: STALE }), { status: 409 }));
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1));
    const snapshot = vi.mocked(projects.recoverProject).mock.calls[0][1] as { nodes: Array<{ id: string; data: { params: { value: unknown } } }> };
    expect(snapshot.nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('sent before the gap');
    await vi.waitFor(() => expect(lines()).toContain(
      "Couldn't save “Text” for “Hero prompt”. Your edits were saved as a copy, “Glass campaign (recovered)”."));
    expect(valueOf('n1')).toBe('theirs');
  });

  it('one that lands (Nebula took it before the replacement) makes no copy and no line', async () => {
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    let settle: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { settle = resolve; }) : Promise.resolve(answer()));
    type('landed before the gap');
    await sentPut();
    reconnect('12', 'theirs');
    await flush(); await flush();
    settle(answer(200));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
    expect(lines()).toEqual([]);
  });
});

// ── Fix round 1 of PR #200 ──────────────────────────────────────────────────

describe('fix round 1, GM 2026-10-27 answer 1 (review N-1): the draft belongs to its canvas', () => {
  beforeEach(() => resetPins());
  afterEach(() => resetPins());

  // Fix round 2 (GM 2026-10-28 answer 1): a draft closed on purpose gets no
  // line; it waits for its own project (agentPresenceFollowups.r2store).
  it('a draft closed with × on one project never prefills the next project\'s dialog, and gets no line', async () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('for alpha n1');
    pins.getState().cancelCompose();
    agentOpens({ kind: 'agent', name: 'Codex' });
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(pins.getState().kept).toEqual([]);
    pins.getState().compose({ nodeId: 'n1' });
    expect(pins.getState().draft).toBe('');
  });

  it('an emptied draft leaves nothing to keep', () => {
    pins.getState().compose({ nodeId: 'n1' });
    pins.getState().setDraft('   ');
    pins.getState().cancelCompose();
    agentClear();
    expect(pins.getState().kept).toEqual([]);
  });
});

describe('fix round 1, GM answer 4: what replaced the canvas, for the chat\'s Apply', () => {
  it('an agent\'s open names the agent and the project; an agent\'s clear says cleared', async () => {
    const { lastCanvasReplacement } = await import('../src/lib/canvasReplaced');
    agentOpens({ kind: 'agent', name: 'Codex' });
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.id).toBe('beta'));
    expect(lastCanvasReplacement()).toEqual({ kind: 'opened', agent: 'Codex', projectName: 'beta' });
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, empty: true,
      cleared: true, canvasRevision: '31', nodes: [], edges: [], edit: { id: 'ed_c31', actor: { kind: 'agent', name: 'Codex' } } });
    expect(lastCanvasReplacement()).toEqual({ kind: 'cleared' });
  });
});

describe('fix round 1, review L-4 and N-2: a recovered copy is always named by a line with Open copy', () => {
  const reconnect = (canvas: string, value: string) => emit({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION,
    canvasRevision: canvas, empty: false, edges: [],
    nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'Other', params: { value }, state: 'idle', outputs: {} } }] });
  const COPY_LINE = 'Couldn\'t save “Text” for “Hero prompt”. Your edits were saved as a copy, “Glass campaign (recovered)”.';
  const holdPut = () => {
    let settle: (r: Response) => void = () => {};
    graphWrites.answer = (path, init) => (path === '/api/graph/node/n1' && init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { settle = resolve; graphWrites.hanging.push(() => resolve(answer(200))); })
      : Promise.resolve(answer()));
    return (r: Response) => settle(r);
  };
  const copyNotice = () => [useGraphStore.getState().undoNotice, useGraphStore.getState().messageNotice]
    // The line keeps the copy's name together with no-break spaces.
    .find((notice) => notice?.text?.replace(/\u00a0/g, ' ') === COPY_LINE);

  it('COPY-TWICE: two reconnect replacements while the save is on its way', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Glass campaign (recovered)') } as never);
    setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
    const settle = holdPut();
    type('typed COPY-TWICE');
    await sentPut();
    reconnect('12', 'theirs');
    await flush(); await flush();
    reconnect('13', 'theirs again');
    await flush(); await flush();
    settle(new Response(JSON.stringify({ detail: STALE }), { status: 409 }));
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(copyNotice(), JSON.stringify(lines())).toBeDefined());
    expect(copyNotice()?.copy).toEqual({ projectId: 'copy-1' });
  });

  it('COPY-HANG: a save that never answers releases the copy after the hold limit', async () => {
    const { setReplacedCopyWaitForTests } = await import('../src/store/graphStore');
    setReplacedCopyWaitForTests(200);
    try {
      vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Glass campaign (recovered)') } as never);
      setProjectContext({ id: 'alpha', revision: 'rev-a', canvas: '4' });
      holdPut();
      type('typed COPY-HANG');
      await sentPut();
      reconnect('12', 'theirs');
      await flush(); await flush();
      expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await vi.waitFor(() => expect(copyNotice()).toBeDefined());
    } finally {
      setReplacedCopyWaitForTests(null);
    }
  });
});
