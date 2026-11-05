/**
 * PR #199 round 23 (review 21 LOW-1, the entry chunk's budget, part 2): the
 * held reopen's table of lines (lib/reopenHoldLines) is its own chunk. It
 * loads when a hold first arrives, not when the store is imported; nothing
 * says a line before it is here; a chunk that fails to load says nothing
 * (never a wrong line) and the press answers with the open's heading and a
 * real Try again (round 24, GM r23 1); and a line waiting on
 * the chunk is said only if its project is still the one open, and only
 * while its hold still holds.
 *
 * Each test imports the store afresh (vi.resetModules), with the lines module
 * behind a gate the test opens or fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { REFUSED_FALLBACK_COPY } from '../src/lib/errorCopy';
import { createElement } from 'react';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const chunk = vi.hoisted(() => ({ loads: 0, gate: null as null | (() => Promise<void>) }));
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
  return { ...real, getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: unknown) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && path.startsWith('/api/graph')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.apiFetch(path, init, options as never);
    } };
});
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(), holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
  getOpenHold: vi.fn(async () => ({ hold: null })),
}));

type Store = typeof import('../src/store/projectStore');
type Graph = typeof import('../src/store/graphStore')['useGraphStore'];

const P = 'Glass campaign';
const UNCERTAIN = `You can reopen “${P}” after you check its World Labs run in Marble and press “I’ve checked Marble”.`;

function project(id = 'alpha', name = id === 'alpha' ? P : id) {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}

/** A gate the test opens (or fails) by hand. */
function gate() {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { wait: () => promise, open, fail };
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

let store: Store;
let graph: Graph;
let stopAutosave: (() => void) | null = null;

/** The store afresh, opened on Alpha as the harness of reopenHold.fix22b does. */
async function boot(): Promise<void> {
  vi.resetModules();
  socket.handlers = [];
  // The lines chunk, counted and gated: each import of it is one load. Set
  // here, after the reset (a hoisted vi.mock's module outlives resetModules).
  vi.doMock('../src/lib/reopenHoldLines', async (original) => {
    chunk.loads += 1;
    if (chunk.gate) await chunk.gate();
    return await original<typeof import('../src/lib/reopenHoldLines')>();
  });
  store = await import('../src/store/projectStore');
  graph = (await import('../src/store/graphStore')).useGraphStore;
  const projects = await import('../src/lib/projects');
  const execution = await import('../src/lib/api');
  const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
  const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [summary('alpha'), summary('beta')], trash: [],
    activeProjectId: 'alpha', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION } as never);
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id) as never);
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }) as never);
  await store.useProjectStore.getState().initialize();
  store.useProjectStore.setState({ screen: 'workspace' });
  stopAutosave = store.subscribeProjectAutosave();
  for (const handler of [...socket.handlers]) {
    handler({ type: 'graphSync', workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
      nodes: graph.getState().nodes.map((node) => ({ ...node })), edges: [] } as unknown as ExecutionEvent);
  }
}

/** A node only this tab has (a duplicate) and a World Labs run whose status
 * this tab lost: reopening Alpha in place is held ('uncertain'). */
function holdAlpha(): void {
  graph.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  graph.getState().duplicateSelected();
  expect(graph.getState().nodes.some((node) => !/^n[0-9]+$/.test(node.id))).toBe(true);
  graph.setState({ uncertainWorldLabsRunId: 'wl-run-1' });
}
const reopenAlpha = () => { store.useProjectStore.setState({ screen: 'home' }); return store.useProjectStore.getState().open('alpha'); };
/** Every reopen line the stores held, however briefly (a subscriber sees each set). */
function recordLines(): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const note = () => { for (const line of said()) if (line.startsWith('You can reopen')) seen.push(line); };
  const stops = [store.useProjectStore.subscribe(note), graph.subscribe(note)];
  return { seen, stop: () => { for (const stop of stops) stop(); } };
}
const said = () => [store.useProjectStore.getState().heldReopenLine?.line ?? null,
  graph.getState().messageNotice?.text ?? null, graph.getState().undoNotice?.text ?? null].filter((line) => line !== null);

beforeEach(() => { chunk.loads = 0; chunk.gate = null; });
afterEach(async () => {
  stopAutosave?.(); stopAutosave = null;
  store?.resetProjectStoreForTests();
  chunk.gate = null;
  await settle();
  vi.restoreAllMocks();
});

describe('the reopen-hold lines load on first need, not with the store', () => {
  it('importing and opening the store loads nothing; the first hold loads them once; the line follows', async () => {
    const opened = gate();
    chunk.gate = opened.wait;
    await boot();
    await settle();
    expect(chunk.loads).toBe(0);
    holdAlpha();
    await settle();
    expect(chunk.loads).toBe(0);
    // The card's read finds the hold: the lines start loading, and nothing is said before they're here.
    expect(store.reopenHoldNow()).toBeNull();
    await settle();
    expect(chunk.loads).toBe(1);
    expect(store.reopenHoldNow()).toBeNull();
    await settle();
    expect(chunk.loads).toBe(1);
    opened.open();
    await store.loadReopenHoldLines();
    await store.loadReopenHoldLines();
    expect(chunk.loads).toBe(1);
    expect(store.reopenHoldNow()).toEqual({ id: 'alpha', line: UNCERTAIN });
  });

  it('a subscriber to the store hears when they arrive (the Projects card wakes with its line)', async () => {
    const opened = gate();
    chunk.gate = opened.wait;
    await boot();
    holdAlpha();
    const heard = vi.fn();
    const stop = store.useProjectStore.subscribe(heard);
    expect(store.reopenHoldNow()).toBeNull();
    opened.open();
    await settle();
    expect(heard).toHaveBeenCalled();
    expect(store.reopenHoldNow()?.line).toBe(UNCERTAIN);
    stop();
  });

  it('the person’s press while the chunk loads says the line once it arrives, not before', async () => {
    const opened = gate();
    chunk.gate = opened.wait;
    await boot();
    holdAlpha();
    const pressed = reopenAlpha();
    await settle();
    expect(said()).toEqual([]);
    opened.open();
    await pressed;
    expect(store.useProjectStore.getState().heldReopenLine).toEqual({ id: 'alpha', line: UNCERTAIN, place: 'worldLabsNotice' });
  });
});

describe('a lines chunk that fails to load (GM r23, 1: a press always answers)', () => {
  const HEADING = 'Nebula couldn’t open the project.';
  const failFirstLoad = async () => {
    const first = gate();
    chunk.gate = first.wait;
    await boot();
    holdAlpha();
    const pressed = reopenAlpha();
    await settle();
    first.fail(new Error('Failed to fetch dynamically imported module'));
    await pressed;
    await settle();
  };

  it('the press answers with the shared open heading on Projects, never a wrong line or a reload', async () => {
    await failFirstLoad();
    const state = store.useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(state.error?.startsWith(HEADING)).toBe(true);
    // GM's general line under the heading (the chunk's failure is no request's); only the kept form never says reload.
    expect(state.error).toBe(`${HEADING} ${REFUSED_FALLBACK_COPY}`);
    expect(state.errorRetry).toEqual({ action: 'open', id: 'alpha' });
    expect(said()).toEqual([]);
    expect(chunk.loads).toBe(1);
  });

  it('Try again loads the chunk again, then reopens: the line shows and the error is gone', async () => {
    await failFirstLoad();
    chunk.gate = null;
    await store.useProjectStore.getState().retry();
    await settle();
    expect(chunk.loads).toBe(2);
    const state = store.useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.errorRetry).toBeNull();
    expect(state.screen).toBe('workspace');
    expect(state.heldReopenLine?.line).toBe(UNCERTAIN);
  });

  it('Try again can fail again and answers the same way', async () => {
    await failFirstLoad();
    const second = gate();
    chunk.gate = second.wait;
    const retried = store.useProjectStore.getState().retry();
    await settle();
    second.fail(new Error('Failed to fetch dynamically imported module'));
    await retried;
    await settle();
    const state = store.useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(state.error?.startsWith(HEADING)).toBe(true);
    expect(state.errorRetry).toEqual({ action: 'open', id: 'alpha' });
  });

  it('while the canvas is kept the kept sentence stays: no error line, no Try again, never a reload', async () => {
    const first = gate();
    chunk.gate = first.wait;
    await boot();
    holdAlpha();
    const { setCanvasKept } = await import('../src/lib/keptCanvas');
    // The press is on its way when the edits become kept (the restore, an agent's write).
    store.useProjectStore.setState({ screen: 'home' });
    const pressed = store.useProjectStore.getState().open('alpha');
    await settle();
    setCanvasKept(true);
    first.fail(new Error('Failed to fetch dynamically imported module'));
    await pressed;
    await settle();
    const state = store.useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.errorRetry).toBeNull();
    expect(state.screen).not.toBe('home');
    setCanvasKept(false);
  });

  it('a read of the hold (the card) after a failed chunk tries again, as before', async () => {
    await failFirstLoad();
    chunk.gate = null;
    expect(store.reopenHoldNow()).toBeNull();
    await settle();
    expect(chunk.loads).toBe(2);
    await store.loadReopenHoldLines();
    expect(store.reopenHoldNow()?.line).toBe(UNCERTAIN);
  });
});

describe('a line waiting on the chunk', () => {
  it('isn’t said once another project is open', async () => {
    const opened = gate();
    chunk.gate = opened.wait;
    await boot();
    holdAlpha();
    const pressed = reopenAlpha();
    await settle();
    store.useProjectStore.setState({ activeProject: project('beta') as never });
    const lines = recordLines();
    opened.open();
    await pressed;
    await settle();
    lines.stop();
    // Not even for a moment: Alpha's line is never set while Beta is open.
    expect(lines.seen).toEqual([]);
    expect(said()).toEqual([]);
    expect(store.useProjectStore.getState().heldReopenLine).toBeNull();
  });

  it('isn’t left showing once its hold ended while the chunk loaded', async () => {
    const opened = gate();
    chunk.gate = opened.wait;
    await boot();
    holdAlpha();
    const pressed = reopenAlpha();
    await settle();
    graph.setState({ uncertainWorldLabsRunId: null });
    const lines = recordLines();
    opened.open();
    await pressed;
    await settle();
    lines.stop();
    // The hold is read again once the lines arrive: one that ended says
    // nothing, not even for a moment.
    expect(lines.seen).toEqual([]);
    expect(said()).toEqual([]);
  });
});

describe('the rail’s held-reopen callout is its own chunk', () => {
  it('loads only when a line for Run History arrives, then shows it', async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock('../src/components/ReopenHoldCallout', async (original) => {
      loads += 1;
      return await original<typeof import('../src/components/ReopenHoldCallout')>();
    });
    const { WorkspaceRail } = await import('../src/components/WorkspaceRail');
    const { useProjectStore } = await import('../src/store/projectStore');
    const view = render(createElement(WorkspaceRail));
    await settle();
    expect(loads).toBe(0);
    // A line placed elsewhere (the World Labs notice) doesn't load it either.
    act(() => { useProjectStore.setState({ heldReopenLine: { id: 'alpha', line: UNCERTAIN, place: 'worldLabsNotice' } }); });
    await settle();
    expect(loads).toBe(0);
    const line = `You can reopen “${P}” after you forget the World Labs recovery ID for “World” in Run History.`;
    act(() => { useProjectStore.setState({ heldReopenLine: { id: 'alpha', line, place: 'runHistory' } }); });
    await vi.waitFor(() => expect(view.container.querySelector('[data-reopen-hold-callout]')?.textContent).toContain(line));
    expect(loads).toBe(1);
    view.unmount();
    act(() => { useProjectStore.setState({ heldReopenLine: null }); });
  });
});
