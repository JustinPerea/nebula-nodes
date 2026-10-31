/**
 * Round 21 of PR #199 (GM r31):
 * - 1: the World Labs line names the press of the notice's own button;
 * - 2: the held-reopen lines (the canvas's, after the person asked, and the
 *   card's on Projects) go the moment they are false; a run nobody asked to
 *   reopen through shows neither;
 * - 4 and 5: the reload line has its subject, and its name stays true until
 *   the reload (a rename follows; a copy gone from the list drops the name).
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
  getOpenHold: vi.fn(async () => ({ hold: null })),
}));

import { RELOAD_FOR_UPDATE_UNNAMED, refreshOpenHold, reopenHold, reopenHoldLine, reopenHoldNow, resetProjectStoreForTests, subscribeProjectAutosave,
  subscribeReopenHold, useProjectStore } from '../src/store/projectStore';
import { useCinemaUploadStore } from '../src/store/cinemaUploadStore';
import { UNLOCK_LABEL } from '../src/lib/worldLabsWaiting';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { act, render, renderHook, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';

const initial = useProjectStore.getState();
const realCanSwitch = useGraphStore.getState().canSwitchProject;

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

function duplicateN1(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  return local.id;
}
const noticeNow = () => useGraphStore.getState().messageNotice?.text ?? useGraphStore.getState().undoNotice?.text ?? null;

const WL = 'You can reopen “Glass campaign” after you check its World Labs run in Marble and press “I\'ve checked Marble”.';
const RUN = 'You can reopen “Glass campaign” when the run finishes.';
const ambiguity = { runId: 'wl-run', nodeId: 'n1', kind: 'worldlabs-environment', message: 'Staged.', durable: true };
const card = () => reopenHoldNow()?.line ?? null;
/** The canvas line wherever it sits: by Stop, or by the World Labs notice or Run History (GM r32, 2). */
const shownNow = () => noticeNow() ?? useProjectStore.getState().heldReopenLine?.line ?? null;
/** Nebula's verdict, read as the tab reads it. */
const verdict = async (hold: Record<string, unknown> | null) => {
  vi.mocked(projects.getOpenHold).mockResolvedValue({ hold });
  await refreshOpenHold();
};
const AMBIGUITY_ALPHA = { state: 'ambiguity', nodeId: 'n1', nodeName: 'Hero prompt', projectId: 'alpha', projectName: 'Glass campaign', count: 1, fields: [] };
const askToReopen = async () => {
  useProjectStore.setState({ screen: 'home' });
  await useProjectStore.getState().open('alpha');
  expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
  expect(useProjectStore.getState().screen).toBe('workspace');
};

describe('GM r31, 1: the World Labs line names the press', () => {
  it('GM’s line, quoting the notice button’s own label', () => {
    expect(reopenHoldLine('Glass campaign', 'alpha', AMBIGUITY_ALPHA as never)).toBe(WL);
    expect(reopenHoldLine('Glass campaign', 'alpha', { state: 'uncertain' })).toBe(WL);
    expect(reopenHoldLine('Glass campaign', 'alpha', { state: 'uncertain' })).toContain(`press “${UNLOCK_LABEL}”.`);
  });

  it('the label it names is the one the notice’s button shows', () => {
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity as never] });
    render(<ProviderRecoveryStatus />);
    const button = screen.getByRole('button', { name: /checked Marble/ });
    expect(reopenHoldLine('Glass campaign', 'alpha', { state: 'uncertain' })).toContain(`“${button.textContent}”`);
  });
});

describe('GM r31, 2: the held-reopen lines go the moment they are false', () => {
  it('a run: the canvas line after Open, and the card line, both go as the run finishes', async () => {
    duplicateN1();
    useGraphStore.setState({ isExecuting: true });
    expect(card()).toBe(RUN);
    // Not during the run by itself: only after the person asks to reopen.
    expect(noticeNow()).toBeNull();
    await askToReopen();
    expect(noticeNow()).toBe(RUN);
    useGraphStore.setState({ isExecuting: false });
    expect(noticeNow()).toBeNull();
    expect(card()).toBeNull();
  });

  it('a World Labs hold cleared by the press: both go', async () => {
    duplicateN1();
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity as never] });
    await verdict(AMBIGUITY_ALPHA);
    await askToReopen();
    expect(shownNow()).toBe(WL);
    expect(card()).toBe(WL);
    useGraphStore.setState({ providerStartAmbiguities: [] });
    expect(shownNow()).toBeNull();
    expect(card()).toBeNull();
  });

  it('a World Labs run Nebula hears back about by itself: both just go', async () => {
    duplicateN1();
    useGraphStore.setState({ uncertainWorldLabsRunId: 'wl-run' });
    await askToReopen();
    expect(shownNow()).toBe(WL);
    useGraphStore.setState({ uncertainWorldLabsRunId: null });
    expect(shownNow()).toBeNull();
    expect(card()).toBeNull();
  });

  it('a hold that turns into another (a run, then a World Labs hold): the run’s line goes, and the new hold’s line takes its place (review 19 item 9)', async () => {
    duplicateN1();
    useGraphStore.setState({ isExecuting: true });
    await askToReopen();
    expect(noticeNow()).toBe(RUN);
    useGraphStore.setState({ isExecuting: false, uncertainWorldLabsRunId: 'wl-run' });
    expect(noticeNow()).toBeNull();
    expect(useProjectStore.getState().heldReopenLine).toEqual({ id: 'alpha', line: WL, place: 'worldLabsNotice' });
    expect(card()).toBe(WL);
  });

  it('a hold held outside the graph store (a Cinema upload) goes with it too', async () => {
    duplicateN1();
    useCinemaUploadStore.setState({ uploads: [{ id: 'u1', status: 'uploading' }] as never });
    expect(card()).toBe(RUN);
    await askToReopen();
    expect(noticeNow()).toBe(RUN);
    useCinemaUploadStore.setState({ uploads: [] as never });
    expect(noticeNow()).toBeNull();
    expect(card()).toBeNull();
  });

  it('the card line on Projects re-renders the moment the run finishes (as App reads it)', () => {
    duplicateN1();
    useGraphStore.setState({ isExecuting: true });
    const { result } = renderHook(() => useSyncExternalStore(subscribeReopenHold, reopenHoldNow));
    expect(result.current?.line).toBe(RUN);
    act(() => { useGraphStore.setState({ isExecuting: false }); });
    expect(result.current).toBeNull();
    const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toContain('useSyncExternalStore(subscribeReopenHold, readReopenHold)');
  });

  it('a run that isn’t held for a reopen (no node only this tab has) shows neither line', async () => {
    useGraphStore.setState({ isExecuting: true });
    expect(reopenHold('alpha')).toBeNull();
    expect(card()).toBeNull();
    useProjectStore.setState({ screen: 'home' });
    await useProjectStore.getState().open('alpha');
    expect(noticeNow()).toBeNull();
    useUIStore.setState({ viewMode: 'canvas' });
    expect(card()).toBeNull();
  });
});

describe('GM r31, 4 and 5: the reload line, with its subject, true until the reload', () => {
  const update = () => {
    type('Unsaved edit');
    useProjectStore.setState({ activeProject: null });
    emit({ type: 'graphSync', workspaceRevision: 'rev-rotated', paramsVersion: GRAPH_PARAMS_VERSION + 1, nodes: [], edges: [], empty: true });
  };
  const INTO = (name: string) => `Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in “${name}”.`;
  const OF = (name: string) => `Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in a recovered copy of “${name}”.`;
  const relist = (names: Array<[string, string]>) => useProjectStore.setState({ projects: names.map(([id, name]) => summary(id, name)) });

  it('GM’s subject: “Nebula couldn’t save your changes because it was updated.”', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Recovered Shot 7 copy'), sourceName: 'Shot 7' });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(OF('Shot 7')));
    expect(RELOAD_FOR_UPDATE_UNNAMED).toBe('Nebula couldn’t save your changes because it was updated. Reload Nebula and they’ll open in a recovered copy.');
  });

  it('the race: another recovery between the line and the reload can’t take the copy’s name (it is filed already)', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue(project('copy-1', 'Recovered Shot 7 copy'));
    useProjectStore.setState({ projects: [] });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy')));
    relist([['copy-1', 'Recovered Shot 7 copy']]);
    // Another tab's recovery lands next: Nebula gives it the next free name.
    relist([['copy-1', 'Recovered Shot 7 copy'], ['copy-2', 'Recovered Shot 7 copy 2']]);
    expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy'));
  });

  it('a rename of the copy before the reload: the line follows it', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue(project('copy-1', 'Recovered Shot 7 copy'));
    useProjectStore.setState({ projects: [] });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy')));
    relist([['copy-1', 'Recovered Shot 7 copy']]);
    relist([['copy-1', 'Shot 7 rescue']]);
    expect(useProjectStore.getState().error).toBe(INTO('Shot 7 rescue'));
  });

  it('the copy leaves the list before the reload: the line drops the name', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue(project('copy-1', 'Recovered Shot 7 copy'));
    useProjectStore.setState({ projects: [] });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy')));
    relist([['copy-1', 'Recovered Shot 7 copy']]);
    relist([['beta', 'beta']]);
    expect(useProjectStore.getState().error).toBe(RELOAD_FOR_UPDATE_UNNAMED);
  });

  it('a listing read before the recovery landed (no copy yet) keeps the name', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue(project('copy-1', 'Recovered Shot 7 copy'));
    useProjectStore.setState({ projects: [] });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy')));
    relist([['beta', 'beta']]);
    expect(useProjectStore.getState().error).toBe(INTO('Recovered Shot 7 copy'));
  });

  it('the source form names what Nebula recorded, which a rename of the copy doesn’t change', async () => {
    vi.mocked(projects.recoverProject).mockResolvedValue({ ...project('copy-1', 'Recovered Shot 7 copy'), sourceName: 'Shot 7' });
    update();
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(OF('Shot 7')));
    relist([['copy-1', 'Recovered Shot 7 copy']]);
    relist([['copy-1', 'Shot 7 rescue']]);
    expect(useProjectStore.getState().error).toBe(OF('Shot 7'));
  });

  it('after the reload, the notice names the copy as it is listed now', async () => {
    window.sessionStorage.setItem('nebula:recoveredForUpdate', JSON.stringify({ id: 'copy-1', name: 'Recovered Shot 7 copy' }));
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('copy-1', 'Shot 7 rescue')] }));
    vi.mocked(projects.openProject).mockResolvedValue({ project: project('copy-1', 'Shot 7 rescue'), workspaceRevision: 'rev-c',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
    await useProjectStore.getState().initialize();
    await vi.waitFor(() => expect(noticeNow()).toContain('They’re in “Shot 7 rescue”.'));
  });

  it('after the reload, a copy that won’t open is named as it is listed now', async () => {
    window.sessionStorage.setItem('nebula:recoveredForUpdate', JSON.stringify({ id: 'copy-1', name: 'Recovered Shot 7 copy' }));
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('copy-1', 'Shot 7 rescue')] }));
    vi.mocked(projects.openProject).mockRejectedValue(new Error('refused'));
    await useProjectStore.getState().initialize();
    await vi.waitFor(() => expect(String(useProjectStore.getState().error ?? useProjectStore.getState().copyNotice?.line ?? '')).toContain('“Shot 7 rescue”'));
    expect(String(useProjectStore.getState().error ?? useProjectStore.getState().copyNotice?.line ?? '')).not.toContain('Recovered Shot 7 copy');
  });
});
