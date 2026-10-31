/**
 * Round 16 of PR #199 (review 14; GM r21 and r22), the store's side. The
 * harness is keptCanvas.fix15.store's (catalogRestore.fix11.store's):
 * - HIGH-1: nodes added while kept are renumbered by the copy, and the tab
 *   adopts the copy's ids, so typing after [Save as a project] reaches Nebula.
 * - GM r21 (3): wires drawn while kept are this tab's own, held to the
 *   server's wire rules (a refused one never exists).
 * - GM r21 (5): Discard opens the saved copy of the canvas, else Projects.
 * - GM r22 (2): an update while kept: Save and Discard reload.
 * - GM r22 on the limit: a 413 at the project limit keeps kept mode.
 * - Review 14 kept-hold MEDIUM-3, LOW-1, LOW-2 (H24), LOW-4, NIT-1;
 *   lock-order LOW-1 (M14), LOW-2 and NIT-3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const acts = vi.hoisted(() => ({ said: [] as Array<[string, string]> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
  notePersonAct: (kind: string, id: string) => { acts.said.push([kind, id]); },
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
        graphWrites.sent.push({ method, path, body: String(init?.body ?? '') });
        return graphWrites.answer ? graphWrites.answer(path, init)
          : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

import { DISCARDED_KEPT_EDITS, KEPT_UPDATE_LINE, KEPT_UPDATE_RELOAD_LINE, keptDiscardTarget, keptExitBlocker, keptProjectLimitLine,
  resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { RequestFailedError } from '../src/lib/errorCopy';
import { setFollowingSwitch } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests, subscribeOfflinePulse } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { reloadPage, reportParamsOutdated } from '../src/lib/paramsOutdated';

const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id, value: string = id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string, name?: string) => { const { snapshot: _s, ...rest } = project(id, name); void _s; return rest; };
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
/** A sync carrying the canvas as Nebula has it (the tab's own nodes). */
const sync = (workspaceRevision: string, more: Record<string, unknown> = {}) => emit({ type: 'graphSync', workspaceRevision,
  paramsVersion: GRAPH_PARAMS_VERSION, nodes: useGraphStore.getState().nodes.map((node) => ({ ...node })), edges: [],
  empty: false, ...more });
/** Nebula restored its project list while running: Delta's revision is gone. */
const restoreWhileRunning = () => sync('rev-restored', { catalogRestore: 'restore-new', activeProjectId: null,
  nodes: [], edges: [], empty: true });

let notices: CanvasNoticeDetail[] = [];
const onNotice = (event: Event) => { notices.push((event as CustomEvent<CanvasNoticeDetail>).detail); };
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  graphWrites.sent = [];
  graphWrites.answer = null;
  acts.said = [];
  notices = [];
  resetProjectStoreForTests();
  resetKeptCanvasForTests();
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
  useProjectStore.setState({ screen: 'workspace' });
  window.addEventListener(CANVAS_NOTICE_EVENT, onNotice);
  unsubscribe = subscribeProjectAutosave();
  // The socket's first sync: this tab's revision, no restore yet.
  sync('rev-a');
});
afterEach(async () => {
  window.removeEventListener(CANVAS_NOTICE_EVENT, onNotice);
  resetCanvasFollowForTests();
  graphWrites.answer = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  resetProjectStoreForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setProjectContext(null);
});


let pulses = 0;
let stopPulses: () => void = () => {};
beforeEach(() => { pulses = 0; stopPulses = subscribeKeptPulse(() => { pulses += 1; }); });
afterEach(() => { stopPulses(); });

/** Kept with a typed edit, a delete and its kept Undo step. */
function keepWithEdits(): void {
  type('alpha typed');
  restoreWhileRunning();
  expect(isCanvasKept()).toBe(true);
  type('alpha typed and more');
  expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
}

const canvasNode = (id: string, definitionId: string, x = 0, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x, y: 0 },
  data: { definitionId, label: id, params, state: 'idle', outputs: {} },
}) as never;
/** Kept, with these nodes beside n1 (the text input), and nothing sent yet. */
function keepWith(extra: unknown[]): void {
  useGraphStore.setState((state) => ({ nodes: [...state.nodes, ...(extra as typeof state.nodes)] }));
  keepWithEdits();
  graphWrites.sent = [];
}
const edges = () => useGraphStore.getState().edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]);
const noticeText = () => {
  const state = useGraphStore.getState();
  return [state.undoNotice?.text, state.messageNotice?.text].filter(Boolean).join(' ');
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('GM r21 (3) on PR #199: a connection drawn while kept is this tab’s own, by the server’s rules', () => {
  it('a wire the rules allow: drawn here, nothing sent, one kept step that Undo and Redo walk', async () => {
    keepWith([canvasNode('n2', 'seedream-4-5', 300)]);
    const saved = useGraphStore.getState().undoStack;
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' });
    expect(edges()).toEqual([['n1', 'text', 'n2', 'prompt']]);
    expect(useGraphStore.getState().keptUndo.at(-1)).toMatchObject({ kind: 'wire' });
    expect(useGraphStore.getState().undoStack).toBe(saved);
    expect(pulses).toBe(0);
    const id = useGraphStore.getState().edges[0].id;
    useGraphStore.getState().undo();
    expect(edges()).toEqual([]);
    useGraphStore.getState().redo();
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual([id]);
    await settle();
    expect(graphWrites.sent).toEqual([]);
    // [Save as a project] files it with the canvas.
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('alpha-rec', 'Glass campaign (recovered)') });
    await useProjectStore.getState().saveKeptEdits();
    const snapshot = vi.mocked(projects.recoverProject).mock.calls[0][1];
    expect(snapshot.edges.map((edge) => [edge.source, edge.target])).toEqual([['n1', 'n2']]);
  });

  it('a wire the server would refuse is never drawn, and says why: the wrong kind, a loop, past a several-input limit', () => {
    const images = Array.from({ length: 11 }, (_, index) => canvasNode(`n${index + 10}`, 'image-input', index * 10));
    keepWith([canvasNode('n2', 'seedream-4-5', 300), canvasNode('n3', 'seedream-4-5', 600), ...images]);
    const before = useGraphStore.getState().keptUndo.length;
    // Text into an image input.
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'images' });
    expect(edges()).toEqual([]);
    expect(noticeText()).toBe('Couldn’t connect to “References”. It takes images and masks, not text.');
    // A loop: n2's image into n3, then n3's image back into n2.
    useGraphStore.getState().onConnect({ source: 'n2', sourceHandle: 'image', target: 'n3', targetHandle: 'images' });
    useGraphStore.getState().onConnect({ source: 'n3', sourceHandle: 'image', target: 'n2', targetHandle: 'images' });
    expect(edges()).toEqual([['n2', 'image', 'n3', 'images']]);
    expect(noticeText()).toBe('Couldn’t connect to “References”. It would make a loop.');
    // "References" takes up to 10: the 11th is refused.
    for (let index = 10; index < 21; index += 1) {
      useGraphStore.getState().onConnect({ source: `n${index}`, sourceHandle: 'image', target: 'n2', targetHandle: 'images' });
    }
    expect(useGraphStore.getState().edges.filter((edge) => edge.target === 'n2')).toHaveLength(10);
    expect(noticeText()).toBe('Couldn’t connect to “References”. It takes up to 10 connections.');
    // Only the drawn ones are kept steps; nothing was sent.
    expect(useGraphStore.getState().keptUndo.length).toBe(before + 11);
    expect(graphWrites.sent).toEqual([]);
  });

  it('a second wire into a one-connection input replaces the first, as on any tab; Undo puts the first back', () => {
    keepWith([canvasNode('n2', 'seedream-4-5', 300), canvasNode('n4', 'text-input', 0)]);
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' });
    const first = useGraphStore.getState().edges[0].id;
    useGraphStore.getState().onConnect({ source: 'n4', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' });
    expect(edges()).toEqual([['n4', 'text', 'n2', 'prompt']]);
    // The same wire again: nothing new, no step.
    const steps = useGraphStore.getState().keptUndo.length;
    useGraphStore.getState().onConnect({ source: 'n4', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' });
    expect(useGraphStore.getState().keptUndo.length).toBe(steps);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual([first]);
    expect(graphWrites.sent).toEqual([]);
  });

  it('the wire-drop popup’s add-and-connect: a tab-local node and its wire, one kept step, nothing sent', async () => {
    keepWith([canvasNode('n2', 'seedream-4-5', 300)]);
    const id = await useGraphStore.getState().addNodeAndConnect('text-input', { x: 0, y: 200 },
      { source: '', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt', newNodeIs: 'source' });
    expect(id).toEqual(expect.any(String));
    expect(id).not.toMatch(/^n\d+$/);
    expect(edges()).toEqual([[id, 'text', 'n2', 'prompt']]);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.some((node) => node.id === id)).toBe(false);
    expect(edges()).toEqual([]);
    // One refused (an image into a text input): no node is left behind.
    const refused = await useGraphStore.getState().addNodeAndConnect('image-input', { x: 0, y: 400 },
      { source: '', sourceHandle: 'image', target: 'n2', targetHandle: 'prompt', newNodeIs: 'source' });
    expect(refused).toBeNull();
    expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']);
    await settle();
    expect(graphWrites.sent).toEqual([]);
  });
});

describe('review 14 of PR #199, HIGH-1: a node added while kept is the copy’s own after [Save as a project]', () => {
  it('add, type, Save: the copy’s ids are the tab’s, and typing after the save reaches Nebula', async () => {
    keepWithEdits();
    const local = await useGraphStore.getState().addNode('text-input', { x: 400, y: 0 });
    expect(local).not.toMatch(/^n\d+$/);
    useGraphStore.getState().updateNodeData(local!, { params: { value: 'typed-while-kept' } });
    useGraphStore.getState().onConnect({ source: local!, sourceHandle: 'text', target: 'n1', targetHandle: 'text' });
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === local })) }));
    useUIStore.getState().selectNode(local!);
    // The copy as the route makes it: the added node is n2 now.
    const copy = project('alpha-rec', 'Glass campaign (recovered)');
    copy.snapshot.nodes.push({ id: 'n2', type: 'model-node', position: { x: 400, y: 0 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: 'typed-while-kept' }, state: 'idle', outputs: {} } } as never);
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...copy, renumbered: { [local!]: 'n2' } });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('alpha-rec')] }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha-rec');
    expect(useGraphStore.getState().nodes.every((node) => /^n\d+$/.test(node.id))).toBe(true);
    expect(useGraphStore.getState().keptUndo).toEqual([]);
    // The person's selection, by the copy's id.
    expect(useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['n2']);
    expect(useUIStore.getState().selectedNodeId).toBe('n2');
    // Typing after the save goes to Nebula's node, so no read puts it back.
    graphWrites.sent = [];
    useGraphStore.getState().updateNodeData('n2', { params: { value: 'typed-while-kept after-save' } });
    await vi.waitFor(() => expect(graphWrites.sent.some((write) => write.path.includes('/n2'))).toBe(true));
  });

  it('wires the copy’s rules left out are said after the saved toast, never silently', async () => {
    keepWithEdits();
    const copy = project('alpha-rec', 'Glass campaign (recovered)');
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...copy, droppedWires: [
      { source: 'n1', sourceHandle: 'text', target: 'n9', targetHandle: 'prompt', kind: 'limit', limit: 1,
        sourceName: 'Hero prompt', targetName: 'Seedream 4.5' }] });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('alpha-rec')] }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    // Round 17 (GM r23, 2): the tab's own line, naming the connection.
    expect(notices.at(-1)?.text).toBe('Your latest edits were saved as their own project, “Glass campaign (recovered)”. '
      + 'Nebula left out the connection from “Hero prompt” to “Seedream 4.5” because “Seedream 4.5” takes only one connection there.');
  });
});

describe('GM r21 (5) on PR #199: [Discard edits] opens the saved copy of the canvas, else Projects', () => {
  it('the project isn’t in the restored list but its copy is (“Recovered canvas”): the copy opens', async () => {
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('beta'), summary('rec', 'Recovered canvas')],
      activeProjectId: null, workspaceRevision: 'rev-restored',
      catalogRestore: { id: 'restore-new', recoveredCanvas: { id: 'rec', name: 'Recovered canvas' }, openProjectMissing: 'alpha' } as never }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: project('rec', 'Recovered canvas', 'saved'),
      workspaceRevision: 'rev-rec', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().discardKeptEdits();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('rec', 'rev-restored');
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'rec' } });
    expect(notices).toContainEqual({ text: DISCARDED_KEPT_EDITS, tone: 'info' });
  });

  it('no saved copy (it couldn’t be saved at the limit): Projects home', async () => {
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('beta')], activeProjectId: null,
      workspaceRevision: 'rev-restored',
      catalogRestore: { id: 'restore-new', canvasNotFiled: { reason: 'projects' }, openProjectMissing: 'alpha' } as never }));
    await useProjectStore.getState().discardKeptEdits();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', keptEdits: null });
  });

  it('keptDiscardTarget: a copy filed for another project isn’t this canvas’s', () => {
    const list = { projects: [summary('rec')], catalogRestore: { recoveredCanvas: { id: 'rec', name: 'Recovered canvas' },
      openProjectMissing: 'other' } } as never;
    expect(keptDiscardTarget({ sourceId: 'alpha' }, list)).toBeNull();
    expect(keptDiscardTarget({ sourceId: 'other' }, list)).toBe('rec');
  });
});

describe('GM r22 (2) on PR #199: Nebula updated while kept (review 14 kept-hold MEDIUM-1: P4, P4b)', () => {
  const newer = GRAPH_PARAMS_VERSION + 1;
  const outdated = async () => {
    reportParamsOutdated(newer);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('the kept line says the tab reloads after Save or Discard', async () => {
    keepWithEdits();
    await outdated();
    expect(KEPT_UPDATE_LINE).toBe('Nebula was updated while this tab was open. Save the kept edits as a project or discard them, and the tab reloads to use the update.');
    expect(useProjectStore.getState().error).toBe(KEPT_UPDATE_LINE);
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
  });

  it('P4: Discard leaves kept mode and reloads (no open in this bundle)', async () => {
    keepWithEdits();
    await outdated();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: newer }));
    await useProjectStore.getState().discardKeptEdits();
    expect(isCanvasKept()).toBe(false);
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1));
    expect(useProjectStore.getState().error).not.toBe(KEPT_UPDATE_LINE);
    // Nothing of the kept canvas was filed on the way out.
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
  });

  it('P4b: Save as a project files the copy, then reloads by itself and opens it after', async () => {
    keepWithEdits();
    await outdated();
    vi.mocked(projects.recoverProject).mockResolvedValue(project('alpha-rec', 'Glass campaign (recovered)'));
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: newer }));
    await useProjectStore.getState().saveKeptEdits();
    expect(vi.mocked(projects.recoverProject)).toHaveBeenCalledTimes(1);
    expect(isCanvasKept()).toBe(false);
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(window.sessionStorage.getItem('nebula:recoveredForUpdate') ?? 'null')).toEqual(
      { id: 'alpha-rec', name: 'Glass campaign (recovered)' });
    expect(useProjectStore.getState().error).not.toBe(KEPT_UPDATE_LINE);
  });

  it('when the tab can’t reload by itself (it already did for this version): the line says to reload, and Save says it after', async () => {
    window.sessionStorage.setItem('nebula:paramsReloadedFor', String(newer));
    keepWithEdits();
    await outdated();
    expect(useProjectStore.getState().error).toBe(KEPT_UPDATE_RELOAD_LINE);
    expect(KEPT_UPDATE_RELOAD_LINE).toBe('Nebula was updated while this tab was open. Save the kept edits as a project or discard them, then reload the tab to use the update.');
    vi.mocked(projects.recoverProject).mockResolvedValue(project('alpha-rec', 'Glass campaign (recovered)'));
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: newer }));
    await useProjectStore.getState().saveKeptEdits();
    // The update's own line for a tab that can't reload (a rebuild, here).
    await vi.waitFor(() => expect(useProjectStore.getState().error).toMatch(/^Nebula was updated/));
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState().error).not.toBe(KEPT_UPDATE_RELOAD_LINE);
  });

  it('any other end of kept mode takes the stale line with it', async () => {
    keepWithEdits();
    await outdated();
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    expect(useGraphStore.getState().loadProjectGraph([], [], [])).toBe(true);
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });
});

describe('GM r22 on PR #199 (review 14 kept-hold MEDIUM-2): [Save as a project] at the project limit', () => {
  const limitRefusal = () => new RequestFailedError("Couldn't recover the project.", 413,
    { detail: 'Project limit reached', storageLimit: 'projects' });

  it('at the limit: kept mode stays, and the line names the limit (never the backend’s words)', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(limitRefusal());
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('a'), summary('b'), summary('c')], projectLimit: 3 } as never));
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits).toMatchObject({ saving: false,
      error: 'You’ve reached the limit of 3 projects. Delete one, then save it as a project.' });
    expect(useProjectStore.getState().unsavedEdits).toBeNull();
    expect(JSON.stringify(useProjectStore.getState())).not.toContain('Project limit reached');
  });

  it('over it: how many to delete', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(limitRefusal());
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: ['a', 'b', 'c', 'd', 'e'].map((id) => summary(id)), projectLimit: 3 } as never));
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits?.error).toBe('You have 5 projects, over the limit of 3. Delete 3, then save it as a project.');
    expect(keptProjectLimitLine(4, 3)).toBe('You have 4 projects, over the limit of 3. Delete 2, then save it as a project.');
  });
});

describe('review 14 of PR #199, kept-hold: the rest', () => {
  it('MEDIUM-3 (P1): a save pause carried into kept mode doesn’t send Discard to the held-edits screen', async () => {
    useProjectStore.setState({ savePaused: { bytes: 17 * 1024 * 1024 }, saveStatus: 'paused', dirty: true });
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: null, workspaceRevision: 'rev-restored' }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: project('alpha', 'Glass campaign', 'alpha saved'),
      workspaceRevision: 'rev-alpha', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().discardKeptEdits();
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({ unsavedEdits: null, screen: 'workspace', activeProject: { id: 'alpha' } });
  });

  it('LOW-1: Discard, then Save while it is on its way: one busy state, only the discard runs', async () => {
    keepWithEdits();
    let answer: (list: ProjectList) => void = () => {};
    vi.mocked(projects.listProjects).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: project('alpha', 'Glass campaign', 'alpha saved'),
      workspaceRevision: 'rev-alpha', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    const discarding = useProjectStore.getState().discardKeptEdits();
    expect(useProjectStore.getState().keptEdits?.discarding).toBe(true);
    await useProjectStore.getState().saveKeptEdits();
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
    answer(listing({ activeProjectId: null, workspaceRevision: 'rev-restored' }));
    await discarding;
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha');
  });

  it('LOW-1: Save, then Discard while it is on its way: only the save runs', async () => {
    keepWithEdits();
    let answer: (saved: SavedProject) => void = () => {};
    vi.mocked(projects.recoverProject).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const saving = useProjectStore.getState().saveKeptEdits();
    await useProjectStore.getState().discardKeptEdits();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    const copy = project('alpha-rec', 'Glass campaign (recovered)');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('alpha-rec')] }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    answer(copy);
    await saving;
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha-rec');
    expect(notices).not.toContainEqual({ text: DISCARDED_KEPT_EDITS, tone: 'info' });
  });

  it('LOW-2 (H24): a Save whose open throws leaves the canvas kept, and its routes off still refused', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockResolvedValue(project('alpha-rec', 'Glass campaign (recovered)'));
    const open = vi.spyOn(useProjectStore.getState(), 'open').mockRejectedValueOnce(new Error('boom'));
    await expect(useProjectStore.getState().saveKeptEdits()).rejects.toThrow('boom');
    open.mockRestore();
    expect(isCanvasKept()).toBe(true);
    pulses = 0;
    await useProjectStore.getState().goHome();
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(pulses).toBeGreaterThan(0);
  });

  it('LOW-4: a Discard whose open fails says the real reason on the kept line', async () => {
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: null, workspaceRevision: 'rev-restored' }));
    vi.mocked(projects.openProject).mockRejectedValueOnce(new projects.ProjectRequestError('The disk is full.', 507,
      { heading: "Couldn't open the project." }));
    await useProjectStore.getState().discardKeptEdits();
    expect(isCanvasKept()).toBe(true);
    const line = useProjectStore.getState().keptEdits?.error ?? '';
    expect(line).not.toBe("Couldn't discard the kept edits.");
    expect(line).toContain('The disk is full.');
    expect(useProjectStore.getState().keptEdits?.discarding).toBe(false);
  });

  it('NIT-1: Save as a project checks offline too, as Discard does (nothing is sent)', async () => {
    keepWithEdits();
    noteBackendConnection('offline');
    expect(keptExitBlocker()).toBe('offline');
    await useProjectStore.getState().saveKeptEdits();
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
    resetBackendConnectionForTests();
    expect(keptExitBlocker()).toBeNull();
  });
});

describe('review 14 of PR #199, lock-order', () => {
  it('M14: kept and offline at once: a refused edit pulses the kept line, not the offline banner', () => {
    keepWithEdits();
    noteBackendConnection('offline');
    let banner = 0;
    const stop = subscribeOfflinePulse(() => { banner += 1; });
    pulses = 0;
    useGraphStore.getState().clearGraph();
    stop();
    resetBackendConnectionForTests();
    expect(pulses).toBe(1);
    expect(banner).toBe(0);
    expect(useGraphStore.getState().nodes.length).toBeGreaterThan(0);
  });

  it('LOW-2: a kept tab shares neither its selection nor its view', async () => {
    keepWithEdits();
    const { publishCanvasSelection } = await import('../src/lib/canvasSelection');
    const { publishCanvasView } = await import('../src/lib/canvasView');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await publishCanvasSelection(['n1']);
    await publishCanvasView({ viewport: { x: 0, y: 0, zoom: 1 }, screen: { width: 1, height: 1 }, nodes: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('NIT-3: kept and following at once: Save and Discard wait for the follow, as kept’s live controls do', () => {
    keepWithEdits();
    setFollowingSwitch({ projectName: 'Beta', agent: 'Claude' });
    expect(keptExitBlocker()).toBe('following');
    setFollowingSwitch(null);
    expect(keptExitBlocker()).toBeNull();
  });
});
