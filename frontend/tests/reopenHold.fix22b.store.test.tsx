/**
 * Round 22 of PR #199, section 2 (review 20 with GM r34), the tab's side:
 * - LOW-5 (P1): the 409's own `hold` names the line, before any re-read;
 * - NIT-3: a 409 with nothing holding tries once more, quietly, then says
 *   nothing (no stale line, two presses at once included);
 * - NIT-1 (GM r34 A3): `bootstrap` is sent, its line only on its 409;
 * - LOW-3 (GM r34 A2): the person's reopen of this project in another window
 *   keeps this window's view (the Commons, the Settings dock, the selection);
 *   an agent's switch resets it;
 * - NIT-5: Projects is read when the follow lands;
 * - LOW-4: a Web Lock claims the tab id for the page's life;
 * - lines-ui LOW-1 (GM r34 A4): the rail callout isn't drawn over open Run History;
 * - lines-ui LOW-2 and NIT-1: focus after an in-place reopen; the 4 s poll;
 * - lines-ui NIT-2: the live regions mount empty, then get their text;
 * - lens item 4 (GM r34 A5): the toolbar moves below the World Labs notice;
 * - mutants W11 (seq), W14 (pageshow), W17 (a 409 re-read after another open).
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
// Spied (lines-ui NIT-1 of review 21): a focus loop an earlier test started
// keeps looking for a canvas for about a second, so focus landing on the
// canvas alone can't show that this test's reopen moved it.
vi.mock('../src/lib/canvasFocus', async (original) => {
  const real = await original<typeof import('../src/lib/canvasFocus')>();
  return { ...real, focusCanvasSoon: vi.fn(real.focusCanvasSoon) };
});
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
  getOpenHold: vi.fn(async () => ({ hold: null })),
}));

import { reopenHoldNow, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { reopenHold, watchOpenHold } from '../src/store/projectFlows';
import { refreshOpenHold } from '../src/store/projectFlows';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';
import { TAB_ID, createTabIdentity, takeTabId } from '../src/lib/tabId';
import { ReopenHoldCallout } from '../src/components/ReopenHoldCallout';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { act, render } from '@testing-library/react';
import { publishTopNotice } from '../src/lib/bottomBar';
import { useAnnounced } from '../src/lib/useAnnounced';
import { frames } from './helpers/frames';
import { focusCanvasSoon } from '../src/lib/canvasFocus';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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




const bootSwitch = (more: Record<string, unknown> = {}) => {
  const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
  emit({ type: 'graphSync', workspaceRevision: 'rev-boot', paramsVersion: GRAPH_PARAMS_VERSION, empty: false,
    graphReplaced: true, renumbered: {},
    projectSwitch: { projectId: 'alpha', projectName: 'Glass campaign', previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: 'Glass campaign', actor: { kind: 'system' }, created: false },
    nodes: [{ ...n1 }], edges: [], ...more });
};

function duplicateN1(): string {
  const before = new Set(useGraphStore.getState().nodes.map((node) => node.id));
  useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
  useGraphStore.getState().duplicateSelected();
  const local = useGraphStore.getState().nodes.find((node) => !before.has(node.id))!;
  expect(local.id).not.toMatch(/^n[0-9]+$/);
  return local.id;
}
const noticeNow = () => useGraphStore.getState().messageNotice?.text ?? useGraphStore.getState().undoNotice?.text ?? null;
const held = () => useProjectStore.getState().heldReopenLine;
const card = () => reopenHoldNow()?.line ?? null;
type Verdict = { state: string; nodeId?: string | null; nodeName?: string | null; projectId?: string | null;
  projectName?: string | null; count?: number; fields?: string[]; detail?: string };
const hold = (state: string, more: Partial<Verdict> = {}): Verdict => ({ state, nodeId: null, nodeName: null,
  projectId: null, projectName: null, count: 1, fields: [], ...more });
/** Nebula's verdict, read as the tab reads it. */
const verdict = async (value: Verdict | null) => {
  vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: value });
  await refreshOpenHold();
};
const askToReopen = async () => {
  useProjectStore.setState({ screen: 'home' });
  await useProjectStore.getState().open('alpha');
};
const P = 'Glass campaign';
const RECOVERY_ALPHA = hold('recovery', { nodeId: 'n1', nodeName: 'World', projectId: 'alpha', projectName: P });
const RECOVERY_OTHER = hold('recovery', { nodeId: 'n4', nodeName: 'World', projectId: 'beta', projectName: 'Alpha' });
const LINES = {
  recovery: `You can reopen “${P}” after you forget the World Labs recovery ID for “World” in Run History.`,
  recoveryOther: `You can reopen “${P}” after you forget the World Labs recovery ID for “World” from “Alpha” in Run History.`,
  recovery2: `You can reopen “${P}” after you forget 2 World Labs recovery IDs in Run History.`,
  params: `You can reopen “${P}” after you check the World Labs run for “World” in Marble and clear its “Resume Operation ID”.`,
  active: `You can reopen “${P}” when World Labs confirms the new run.`,
  bootstrap: `Nebula couldn’t save its World Labs safeguards. You can reopen “${P}” after you restart Nebula.`,
  bootstrapApp: `Nebula couldn’t save its World Labs safeguards. You can reopen “${P}” after you quit Nebula and open it again.`,
  ambiguityIts: `You can reopen “${P}” after you check its World Labs run in Marble and press “I’ve checked Marble”.`,
  ambiguityOther: `You can reopen “${P}” after you check the World Labs run for “World” from “Alpha” in Marble and press “I’ve checked Marble”.`,
  run: `You can reopen “${P}” when the run finishes.`,
};

import { useLayoutEffect } from 'react';

const refusal = (reason: string, more: { hold?: unknown } = {}) =>
  new projects.ProjectRequestError(reason, 409, { heading: 'Couldn’t open the project.', ...more });
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const openedAlpha = (revision = 'rev-a3') => ({ project: project('alpha'), workspaceRevision: revision,
  paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' }) as never;

describe('review 20 LOW-5 (P1): the 409’s own hold names the line', () => {
  it('another project’s record: “from “Alpha””, from the 409 body, with no second read and never the refusal’s node', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(refusal(
      '“Hero prompt” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.',
      { hold: RECOVERY_OTHER }));
    vi.mocked(projects.getOpenHold).mockRejectedValue(new Error('offline'));
    await askToReopen();
    expect(held()).toEqual({ id: 'alpha', line: LINES.recoveryOther, place: 'runHistory' });
    expect(vi.mocked(projects.getOpenHold)).not.toHaveBeenCalled();
    expect(JSON.stringify(useGraphStore.getState().messageNotice ?? null)).not.toContain('Hero prompt');
  });

  it('the hold rides the error from the response body (readFailureBody → asProjectError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'refused', hold: RECOVERY_OTHER }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const real = await vi.importActual<typeof import('../src/lib/projects')>('../src/lib/projects');
    const error = await real.openProject('alpha', 'rev-a').then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(real.ProjectRequestError);
    expect((error as { hold: unknown }).hold).toEqual(RECOVERY_OTHER);
  });
});

describe('review 20 NIT-3: a 409 with nothing holding never leaves a line', () => {
  it('tries once more, quietly, and lands', async () => {
    duplicateN1();
    vi.mocked(projects.openProject)
      .mockRejectedValueOnce(refusal('Cannot switch projects while a run is active. Wait for the run to finish or stop it first.'))
      .mockResolvedValueOnce(openedAlpha());
    await askToReopen();
    await vi.waitFor(() => expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a3'));
    expect(noticeNow()).toBeNull();
    expect(held()).toBeNull();
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('a second refusal with nothing holding says nothing, and tries no third time', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(refusal('This project view is out of date. Reload projects and try again.'));
    await askToReopen();
    await vi.waitFor(() => expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(2));
    await settle();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(2);
    expect(noticeNow()).toBeNull();
    expect(held()).toBeNull();
    expect(useProjectStore.getState().error).toBeNull();
    expect(useProjectStore.getState().screen).toBe('workspace');
  });

  it('a hold on the second try still says its line', async () => {
    duplicateN1();
    vi.mocked(projects.openProject)
      .mockRejectedValueOnce(refusal('out of date'))
      .mockRejectedValueOnce(refusal('a run', { hold: hold('run') }));
    await askToReopen();
    await vi.waitFor(() => expect(noticeNow()).toBe(LINES.run));
  });
});

describe('review 20 NIT-1 (GM r34 A3): bootstrap is sent; its line shows on its 409 only', () => {
  it('no lock and no card line before the press; the press goes', async () => {
    duplicateN1();
    await verdict(hold('bootstrap'));
    expect(reopenHold('alpha')).toBeNull();
    expect(card()).toBeNull();
    vi.mocked(projects.openProject).mockResolvedValue(openedAlpha());
    await askToReopen();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a3'));
    expect(noticeNow()).toBeNull();
  });

  it('its 409: the bootstrap line by Stop', async () => {
    duplicateN1();
    await verdict(hold('bootstrap'));
    vi.mocked(projects.openProject).mockRejectedValue(refusal('safeguards', { hold: hold('bootstrap') }));
    await askToReopen();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
    expect(noticeNow()).toBe(LINES.bootstrap);
  });
});

describe('mutants W11 and W17: an older read never wins', () => {
  it('W11: a slower verdict read that started first loses to the newer one', async () => {
    let late: (value: { hold: unknown }) => void = () => {};
    vi.mocked(projects.getOpenHold)
      .mockImplementationOnce(() => new Promise((resolve) => { late = resolve as never; }))
      .mockResolvedValueOnce({ hold: null });
    const first = refreshOpenHold();
    await refreshOpenHold();
    late({ hold: RECOVERY_ALPHA });
    await first;
    expect(useProjectStore.getState().openHold).toBeNull();
  });

  it('W17: a 409’s re-read that lands after another project opened here says nothing', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(refusal('refused'));
    vi.mocked(projects.getOpenHold).mockImplementation(async () => {
      setProjectContext({ id: 'beta', revision: 'rev-b' });
      return { hold: RECOVERY_ALPHA };
    });
    await askToReopen();
    await settle();
    expect(held()).toBeNull();
    expect(noticeNow() ?? '').not.toContain('reopen');
  });
});

describe('review 20 lines-ui LOW-2 and NIT-1: focus and the poll', () => {
  const withCanvas = async (run: (canvas: HTMLElement) => Promise<void>) => {
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    document.body.appendChild(canvas);
    const open = document.createElement('button');
    document.body.appendChild(open);
    open.focus();
    try { await run(canvas); } finally { canvas.remove(); open.remove(); }
  };

  it('an in-place reopen that goes lands focus on the canvas', async () => withCanvas(async (canvas) => {
    duplicateN1();
    vi.mocked(projects.openProject).mockResolvedValue(openedAlpha());
    vi.mocked(focusCanvasSoon).mockClear();
    await askToReopen();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
    expect(getProjectContext()?.revision).toBe('rev-a3');
    // This reopen asked for it, not a loop left from an earlier test.
    expect(vi.mocked(focusCanvasSoon)).toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(canvas));
  }));

  it('a reopen Nebula refused (409) lands focus on the canvas too', async () => withCanvas(async (canvas) => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(refusal('a run', { hold: hold('run') }));
    await askToReopen();
    await vi.waitFor(() => expect(document.activeElement).toBe(canvas));
  }));

  it('the plain return (no request) lands focus on the canvas', async () => withCanvas(async (canvas) => {
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(canvas));
  }));

  it('a verdict another tab changed (nothing changed here) reaches the tab on the 4 s poll', async () => {
    duplicateN1();
    await verdict(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const stop = watchOpenHold();
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(useProjectStore.getState().openHold).toBeNull();
      vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: RECOVERY_ALPHA });
      await vi.advanceTimersByTimeAsync(3000);
      expect(useProjectStore.getState().openHold).toBeNull();
      await vi.advanceTimersByTimeAsync(1200);
      expect(useProjectStore.getState().openHold).toEqual(RECOVERY_ALPHA);
    } finally {
      stop();
    }
  });
});

describe('review 20 LOW-3 (GM r34 A2): the person’s reopen of this project in another window keeps this window’s view', () => {
  const reopenBy = (actor: Record<string, unknown>) => bootSwitch({ workspaceRevision: 'rev-a2',
    projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor, created: false } });
  const lookAround = () => {
    useUIStore.setState({ viewMode: 'commons' });
    useUIStore.getState().setLeftDock('settings');
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' })) }));
    useUIStore.getState().selectNode('n1');
  };
  const landed = async () => {
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
  };

  it('the Commons, the Settings dock and the selection stay; the ids and revision follow', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    lookAround();
    reopenBy({ kind: 'person', tab: 'tab-window-a' });
    await landed();
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(useUIStore.getState().leftDock).toBe('settings');
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.selected).toBe(true);
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
  });

  it('an agent’s reopen of the same project resets the view, as before', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    lookAround();
    reopenBy({ kind: 'agent', name: 'Codex' });
    await landed();
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(useUIStore.getState().leftDock).not.toBe('settings');
  });

  it('a person’s open of another project resets it too', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2', activeProjectId: 'beta' }));
    lookAround();
    bootSwitch({ workspaceRevision: 'rev-a2', projectSwitch: { projectId: 'beta', projectName: 'beta', previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor: { kind: 'person', tab: 'tab-window-a' }, created: false } });
    await landed();
    expect(getProjectContext()?.id).toBe('beta');
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });
});

describe('review 20 NIT-5: where the window is when the follow lands, not when it began', () => {
  it('a window that left Projects during the follow isn’t put back there', async () => {
    useProjectStore.setState({ screen: 'home' });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    const waiting: Array<() => void> = [];
    let released = false;
    const release = () => { released = true; for (const go of waiting.splice(0)) go(); };
    vi.mocked(projects.getProject).mockImplementation((id) => (released ? Promise.resolve(project(id))
      : new Promise((resolve) => { waiting.push(() => resolve(project(id))); })));
    bootSwitch({ workspaceRevision: 'rev-a2', projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor: { kind: 'person', tab: 'tab-window-a' }, created: false } });
    await vi.waitFor(() => expect(vi.mocked(projects.getProject)).toHaveBeenCalled());
    useProjectStore.setState({ screen: 'workspace' });
    release();
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(useProjectStore.getState().screen).toBe('workspace');
  });
});

describe('review 20 LOW-4: the tab claims its id with a Web Lock while the page lives', () => {
  // Round 23 (review 21 LOW-1): the claim never waits (`ifAvailable`); the
  // two-page paths are in tabId.fix23b.test.ts.
  function fakeLocks() {
    const held = new Set<string>();
    return {
      held,
      request: (name: string, _options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({})).finally(() => held.delete(name));
      },
    };
  }

  it('a free id is claimed; one another live page holds isn’t', async () => {
    const locks = fakeLocks();
    const storage = window.sessionStorage;
    storage.clear();
    const a = createTabIdentity(storage, locks);
    expect(await a.ready()).toBe(a.id);
    expect(locks.held.has(`nebula-tab:${a.id}`)).toBe(true);
    storage.setItem('nebula:tabIdFree', a.id);
    const b = createTabIdentity(storage, locks);
    expect(await b.ready()).not.toBe(a.id);
    storage.clear();
  });

  it('the copy whose id another live page holds moves to its own id, stored for its reload; the free mark still let it in', async () => {
    const storage = window.sessionStorage;
    try {
      storage.clear();
      // Tab A left Nebula in its tab (its free mark), was copied, and both came back.
      const a = takeTabId(storage);
      storage.setItem('nebula:tabIdFree', a);
      const locks = fakeLocks();
      locks.held.add(`nebula-tab:${a}`);
      const copy = createTabIdentity(storage, locks);
      expect(copy.id).toBe(a);
      const moved = await copy.ready();
      expect(moved).not.toBe(a);
      expect(moved).toMatch(/^tab-/);
      expect(copy.id).toBe(moved);
      expect(storage.getItem('nebula:tabId')).toBe(moved);
      expect(locks.held.has(`nebula-tab:${moved}`)).toBe(true);
    } finally {
      storage.clear();
    }
  });

  it('a reload whose old page let go keeps its id', async () => {
    const locks = fakeLocks();
    const storage = window.sessionStorage;
    storage.clear();
    const before = createTabIdentity(storage, locks);
    const id = await before.ready();
    before.pageHide();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reload = createTabIdentity(storage, locks);
    expect(await reload.ready()).toBe(id);
    // Claimed: a plain pageshow changes nothing.
    expect(await reload.pageShow(false)).toBe(id);
    storage.clear();
  });

  it('no Web Locks: the free mark alone, as before', async () => {
    const page = createTabIdentity(null, null);
    expect(page.confirmed).toBe(true);
    expect(await page.ready()).toBe(page.id);
  });

  it('W14: back from the back/forward cache, the page takes its id back (its free mark goes); a plain pageshow leaves it', () => {
    const storage = window.sessionStorage;
    const show = (persisted: boolean) => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    };
    storage.setItem('nebula:tabIdFree', TAB_ID);
    show(false);
    expect(storage.getItem('nebula:tabIdFree')).toBe(TAB_ID);
    show(true);
    expect(storage.getItem('nebula:tabIdFree')).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.getItem('nebula:tabIdFree')).toBe(TAB_ID);
  });
});

describe('review 20 lines-ui LOW-1 (GM r34 A4): no callout over open Run History', () => {
  const clock = frames();
  beforeEach(() => clock.install());
  afterEach(() => clock.uninstall());
  it('the rail callout goes while the history dock is open and comes back when it closes', () => {
    useProjectStore.setState({ heldReopenLine: { id: 'alpha', line: LINES.recovery, place: 'runHistory' } });
    const { container } = render(<ReopenHoldCallout place="runHistory" />);
    clock.flush();
    expect(container.querySelector('[data-reopen-hold-callout]')?.textContent).toBe(LINES.recovery);
    act(() => { useUIStore.getState().setLeftDock('history'); });
    expect(container.querySelector('[data-reopen-hold-callout]')).toBeNull();
    act(() => { useUIStore.getState().setLeftDock(null); });
    clock.flush();
    expect(container.querySelector('[data-reopen-hold-callout]')?.textContent).toBe(LINES.recovery);
  });
});

describe('review 20 lines-ui NIT-2: each live region is in the page before its text', () => {
  const clock = frames();
  beforeEach(() => clock.install());
  afterEach(() => clock.uninstall());
  it('useAnnounced: empty on the mount render, the text after', () => {
    const seen: string[] = [];
    function Probe({ text }: { text: string }) { const shown = useAnnounced(text); seen.push(shown); return <p>{shown}</p>; }
    const { container } = render(<Probe text="Line" />);
    expect(seen[0]).toBe('');
    clock.flush();
    expect(container.textContent).toBe('Line');
  });

  const atFirstCommit = (selector: string) => {
    const read: { text: string | null } = { text: null };
    function Peek() {
      useLayoutEffect(() => {
        if (read.text === null) read.text = document.querySelector(selector)?.textContent ?? '(absent)';
      });
      return null;
    }
    return { read, Peek };
  };

  it('the rail callout’s status region mounts empty, then says the line', () => {
    useProjectStore.setState({ heldReopenLine: { id: 'alpha', line: LINES.recovery, place: 'runHistory' } });
    const { read, Peek } = atFirstCommit('[data-reopen-hold-callout]');
    render(<><ReopenHoldCallout place="runHistory" /><Peek /></>);
    expect(read.text).toBe('');
    clock.flush();
    expect(document.querySelector('[data-reopen-hold-callout]')?.textContent).toBe(LINES.recovery);
  });

  it('the params-only notice box mounts empty, then says the line', () => {
    const { read, Peek } = atFirstCommit('.provider-recovery-status');
    render(<><ProviderRecoveryStatus reopenLine={{ line: LINES.params, onDismiss: () => {} }} /><Peek /></>);
    expect(read.text).toBe('');
    clock.flush();
    expect(document.querySelector('.provider-recovery-status')?.textContent).toBe(LINES.params);
  });
});

describe('review 20 lens item 4 (GM r34 A5): the selection toolbar moves below the World Labs notice', () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 680, width: 680, x: 0, y: top,
    toJSON: () => ({}) }) as DOMRect;
  const root = () => document.documentElement.style;

  it('the notice publishes its foot, and the toolbar’s clearance from the canvas’s top; none without it', () => {
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    canvas.getBoundingClientRect = () => rect(0, 900);
    document.body.appendChild(canvas);
    const notice = document.createElement('div');
    notice.getBoundingClientRect = () => rect(54, 160);
    try {
      publishTopNotice(notice);
      expect(root().getPropertyValue('--top-notice-bottom')).toBe('160px');
      expect(root().getPropertyValue('--top-notice-clearance')).toBe('168px');
      publishTopNotice(null);
      expect(root().getPropertyValue('--top-notice-bottom')).toBe('');
      expect(root().getPropertyValue('--top-notice-clearance')).toBe('');
    } finally {
      canvas.remove();
    }
  });

  it('the notice on screen sets it; the notice gone clears it', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('provider-recovery-status') ? rect(54, 150) : rect(0, 0);
    });
    try {
      useGraphStore.setState({ providerStartAmbiguities: [{ runId: 'r', nodeId: 'n1', kind: 'worldlabs-environment', message: 'Staged.', durable: true }] as never });
      const view = render(<ProviderRecoveryStatus reopenLine={null} />);
      expect(root().getPropertyValue('--top-notice-bottom')).toBe('150px');
      act(() => { useGraphStore.setState({ providerStartAmbiguities: [] }); });
      expect(root().getPropertyValue('--top-notice-bottom')).toBe('');
      view.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it('the toolbar takes the lower line, and the offline banner stays under it', () => {
    const canvasCss = readFileSync(resolve(__dirname, '../src/styles/canvas.css'), 'utf8');
    expect(canvasCss).toMatch(/\.selection-toolbar-panel\.react-flow__panel \{[^}]*margin-top: max\(92px, var\(--top-notice-clearance, 0px\)\);/);
    const appCss = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    expect(appCss).toMatch(/\.backend-connection \{[^}]*top: max\(150px, calc\(var\(--top-notice-bottom, 0px\) \+ 66px\)\);/);
  });
});

describe('GM r33, 2: the headings this PR added lead their lines, whatever the request’s own heading', () => {
  it('a reopen in place Nebula refused for good (not a 409): “Nebula couldn’t reopen the project.”, with the reason', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(new projects.ProjectRequestError('That project can’t open.', 422,
      { heading: "Couldn't open the project." }));
    await askToReopen();
    const line = noticeNow() ?? '';
    expect(line.startsWith('Nebula couldn’t reopen the project.')).toBe(true);
    expect(line).not.toContain("Couldn't open the project.");
  });
});
