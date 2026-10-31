/**
 * Round 21 of PR #199, section 2 (review 19 with GM r32), the tab's side:
 * - item 1: the reopen lock reads Nebula's own verdict, one table of lines
 *   keyed by its state (GM r32, 1), parity with the backend's state list;
 * - item 2: Nebula's 409 after the press shows the hold's line, not agents' text;
 * - item 3: a window on Projects stays there when the person reopens in another;
 * - item 5: the tab keeps its id across a reload; a kept delete is said;
 * - item 6: focus goes to the canvas after a held Open;
 * - items 9 and 10: the line follows the hold, in that hold's place;
 * - items 12-15: no number read in a name, the shared run helper, curly
 *   apostrophes, the messageNotice path.
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

import { deletesKeptLine, refreshOpenHold, reopenHold, reopenHoldNow, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
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
import { takeTabId } from '../src/lib/tabId';
import { OPEN_HOLD_STATES, REOPEN_HOLD_PLACES, reopenHoldLine } from '../src/lib/reopenHold';
import { runFinishesLine } from '../src/lib/useBackendOffline';
import { savedOrder } from '../src/components/projects/catalogRestoreCopy';
import { ReopenHoldCallout } from '../src/components/ReopenHoldCallout';
import { act, render, screen } from '@testing-library/react';
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
const PARAMS = hold('params', { nodeId: 'n1', nodeName: 'World', projectId: 'alpha', projectName: P, fields: ['Resume Operation ID'] });
const LINES = {
  recovery: `You can reopen “${P}” after you forget the World Labs recovery ID for “World” in Run History.`,
  recoveryOther: `You can reopen “${P}” after you forget the World Labs recovery ID for “World” from “Alpha” in Run History.`,
  recovery2: `You can reopen “${P}” after you forget 2 World Labs recovery IDs in Run History.`,
  params: `You can reopen “${P}” after you check the World Labs run for “World” in Marble and clear its “Resume Operation ID”.`,
  active: `You can reopen “${P}” when World Labs confirms the new run.`,
  bootstrap: `Nebula couldn’t save its World Labs safeguards. You can reopen “${P}” after you restart Nebula.`,
  bootstrapApp: `Nebula couldn’t save its World Labs safeguards. You can reopen “${P}” after you quit Nebula and open it again.`,
  ambiguityIts: `You can reopen “${P}” after you check its World Labs run in Marble and press “I've checked Marble”.`,
  ambiguityOther: `You can reopen “${P}” after you check the World Labs run for “World” from “Alpha” in Marble and press “I've checked Marble”.`,
  run: `You can reopen “${P}” when the run finishes.`,
};

describe('review 19 item 1 and GM r32, 1: one table of lines, keyed by Nebula’s state', () => {
  it('GM r32’s lines, exactly: Delta’s node says “its” or names it; another project’s adds “from”', () => {
    expect(reopenHoldLine(P, 'alpha', RECOVERY_ALPHA as never)).toBe(LINES.recovery);
    expect(reopenHoldLine(P, 'alpha', RECOVERY_OTHER as never)).toBe(LINES.recoveryOther);
    expect(reopenHoldLine(P, 'alpha', { ...RECOVERY_OTHER, count: 2 } as never)).toBe(LINES.recovery2);
    expect(reopenHoldLine(P, 'alpha', PARAMS as never)).toBe(LINES.params);
    expect(reopenHoldLine(P, 'alpha', hold('active') as never)).toBe(LINES.active);
    expect(reopenHoldLine(P, 'alpha', hold('bootstrap') as never, false)).toBe(LINES.bootstrap);
    expect(reopenHoldLine(P, 'alpha', hold('bootstrap') as never, true)).toBe(LINES.bootstrapApp);
    expect(reopenHoldLine(P, 'alpha', hold('ambiguity', { nodeName: 'World', projectId: 'alpha', projectName: P }) as never)).toBe(LINES.ambiguityIts);
    expect(reopenHoldLine(P, 'alpha', hold('ambiguity', { nodeName: 'World', projectId: 'beta', projectName: 'Alpha' }) as never)).toBe(LINES.ambiguityOther);
    expect(reopenHoldLine(P, 'alpha', { state: 'uncertain' })).toBe(LINES.ambiguityIts);
    expect(reopenHoldLine(P, 'alpha', hold('run') as never)).toBe(LINES.run);
    // Review 19 item 13: the run form is the shared lock helper's.
    expect(reopenHoldLine(P, 'alpha', { state: 'tabRun' })).toBe(runFinishesLine(`reopen “${P}”`));
  });

  it('a project Nebula can’t name: the node only, never “its”', () => {
    expect(reopenHoldLine(P, 'alpha', hold('recovery', { nodeName: 'World' }) as never))
      .toBe(`You can reopen “${P}” after you forget the World Labs recovery ID for “World” in Run History.`);
    expect(reopenHoldLine(P, 'alpha', hold('ambiguity', { nodeName: 'World' }) as never))
      .toBe(`You can reopen “${P}” after you check the World Labs run for “World” in Marble and press “I've checked Marble”.`);
  });

  it('parity: every state Nebula’s guard can refuse on has a line and a place here', () => {
    const states = JSON.parse(readFileSync(resolve(__dirname, '../../backend/tests/data/replacement_hold_states.json'), 'utf8')) as string[];
    expect([...states].sort()).toEqual([...OPEN_HOLD_STATES].sort());
    for (const state of states) {
      expect(REOPEN_HOLD_PLACES[state as keyof typeof REOPEN_HOLD_PLACES]).toBeTruthy();
      expect(reopenHoldLine(P, 'alpha', hold(state, { nodeName: 'World', projectId: 'alpha', projectName: P }) as never)).toMatch(/^(You can reopen|Nebula couldn’t)/);
    }
  });

  it('each line is curly (’ and “”), with no straight double quote', () => {
    for (const line of Object.values(LINES)) {
      expect(line.replace("I've checked Marble", '')).not.toMatch(/['"]/);
    }
  });
});

describe('review 19 item 1: each state locks before the press, says its line on the card and the canvas, sends nothing, and clears with its own action', () => {
  it('recovery: by Run History; Forget ID clears it', async () => {
    duplicateN1();
    useGraphStore.setState({ providerRecoveries: [{ runId: 'r1', nodeId: 'n1', resumeOperationId: 'op-1', existingWorldId: null }] as never });
    await verdict(RECOVERY_ALPHA);
    expect(reopenHold('alpha')).toMatchObject({ state: 'recovery' });
    expect(card()).toBe(LINES.recovery);
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(held()).toEqual({ id: 'alpha', line: LINES.recovery, place: 'runHistory' });
    expect(noticeNow()).toBeNull();
    // Forget ID: the record goes, and so does the line, at once.
    useGraphStore.setState({ providerRecoveries: [] });
    expect(held()).toBeNull();
    expect(card()).toBeNull();
  });

  it('two records, another project’s: the counted form', async () => {
    duplicateN1();
    await verdict({ ...RECOVERY_OTHER, count: 2 });
    expect(card()).toBe(LINES.recovery2);
  });

  it('params: by the World Labs notice; clearing the field clears it (Nebula’s next read)', async () => {
    duplicateN1();
    await verdict(PARAMS);
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(held()).toEqual({ id: 'alpha', line: LINES.params, place: 'worldLabsNotice' });
    await verdict(null);
    expect(held()).toBeNull();
    expect(card()).toBeNull();
  });

  it('active: by Stop; it goes when the start settles', async () => {
    duplicateN1();
    useGraphStore.setState({ isExecuting: true });
    await verdict(hold('active'));
    expect(card()).toBe(LINES.active);
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(noticeNow()).toBe(LINES.active);
    useGraphStore.setState({ isExecuting: false });
    expect(noticeNow()).toBeNull();
    expect(card()).toBeNull();
  });

  it('bootstrap: by Stop; a restart (Nebula’s next read) clears it', async () => {
    duplicateN1();
    await verdict(hold('bootstrap'));
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(noticeNow()).toBe(LINES.bootstrap);
    await verdict(null);
    expect(noticeNow()).toBeNull();
  });

  it('another tab’s run (Nebula’s `run`): by Stop', async () => {
    duplicateN1();
    await verdict(hold('run'));
    expect(card()).toBe(LINES.run);
    await askToReopen();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(noticeNow()).toBe(LINES.run);
    await verdict(null);
    expect(noticeNow()).toBeNull();
  });

  it('a listing carries the verdict too', async () => {
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    vi.mocked(projects.listProjects).mockResolvedValue({ ...listing(), openHold: RECOVERY_ALPHA } as never);
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().openHold).toEqual(RECOVERY_ALPHA);
  });

  it('an ambiguity this tab lists holds here even when Nebula’s verdict has none (the tab itself won’t switch until its own press)', async () => {
    duplicateN1();
    useGraphStore.setState({ providerStartAmbiguities: [{ runId: 'x', nodeId: 'n1', kind: 'worldlabs-environment', message: 'm', durable: true }] as never });
    const neutral = `You can reopen “${P}” after you check the World Labs run in Marble and press “I've checked Marble”.`;
    expect(reopenHold('alpha')).toMatchObject({ state: 'ambiguity', projectId: null });
    expect(card()).toBe(neutral);
    await verdict(null);
    expect(card()).toBe(neutral);
    useGraphStore.setState({ providerStartAmbiguities: [] });
    expect(reopenHold('alpha')).toBeNull();
  });

  it('no node only this tab has: no hold, whatever Nebula says (the plain shortcut)', async () => {
    await verdict(RECOVERY_ALPHA);
    expect(reopenHold('alpha')).toBeNull();
  });
});

describe('review 19 item 2: Nebula’s own 409 after the press says the hold’s line', () => {
  it('a run another tab started (no hold here at the press): Nebula’s real body, then the run’s line from its verdict', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(new projects.ProjectRequestError(
      'Cannot switch projects while a run is active. Wait for the run to finish or stop it first.', 409, { heading: "Couldn't open the project." }));
    vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: hold('run') });
    await askToReopen();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(noticeNow()).toBe(LINES.run);
    expect(noticeNow()).not.toContain('Cannot switch');
  });

  it('a recovery ID Nebula took between the press and the request: its line by Run History', async () => {
    duplicateN1();
    vi.mocked(projects.openProject).mockRejectedValue(new projects.ProjectRequestError(
      '“World” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.', 409, { heading: "Couldn't open the project." }));
    vi.mocked(projects.getOpenHold).mockResolvedValue({ hold: RECOVERY_ALPHA });
    await askToReopen();
    expect(held()).toEqual({ id: 'alpha', line: LINES.recovery, place: 'runHistory' });
  });
});

describe('review 19 item 9: the canvas line follows the hold, never stale', () => {
  it('World Labs to a run to a recovery ID and back to nothing: each its own line, in its own place', async () => {
    duplicateN1();
    useGraphStore.setState({ uncertainWorldLabsRunId: 'wl', isExecuting: true });
    await askToReopen();
    expect(held()).toEqual({ id: 'alpha', line: LINES.ambiguityIts, place: 'worldLabsNotice' });
    // Nebula heard back "running": the World Labs hold is a run now.
    useGraphStore.setState({ uncertainWorldLabsRunId: null });
    expect(held()).toBeNull();
    expect(noticeNow()).toBe(LINES.run);
    // The run ends with a recovery ID kept.
    useGraphStore.setState({ providerRecoveries: [{ runId: 'r1', nodeId: 'n1', resumeOperationId: 'op', existingWorldId: null }] as never });
    await verdict(RECOVERY_ALPHA);
    useGraphStore.setState({ isExecuting: false });
    expect(noticeNow()).toBeNull();
    expect(held()).toEqual({ id: 'alpha', line: LINES.recovery, place: 'runHistory' });
    useGraphStore.setState({ providerRecoveries: [] });
    expect(held()).toBeNull();
    expect(noticeNow()).toBeNull();
  });

  it('review 19 item 15: a line said while an Undo offer shows (in messageNotice) goes from there too', async () => {
    duplicateN1();
    useGraphStore.setState({ isExecuting: true });
    useGraphStore.setState({ undoNotice: { text: 'Deleted “Hero prompt”.', undo: () => {} } as never });
    await askToReopen();
    expect(useGraphStore.getState().messageNotice?.text ?? useGraphStore.getState().undoNotice?.text).toBe(LINES.run);
    const where = useGraphStore.getState().messageNotice?.text === LINES.run ? 'messageNotice' : 'undoNotice';
    useGraphStore.setState({ isExecuting: false });
    expect(useGraphStore.getState()[where]?.text ?? null).not.toBe(LINES.run);
  });

  it('closing the callout keeps it closed while the hold stays; the next Open says it again', async () => {
    duplicateN1();
    await verdict(PARAMS);
    await askToReopen();
    render(<ReopenHoldCallout place="worldLabsNotice" />);
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).click(); });
    expect(held()).toBeNull();
    useGraphStore.setState({ isExecuting: false });
    expect(held()).toBeNull();
    await askToReopen();
    expect(held()?.line).toBe(LINES.params);
  });
});

describe('review 19 item 10 and GM r32, 2: the line sits by what clears it', () => {
  it('the callout is one polite status region, shown only in its own place', async () => {
    duplicateN1();
    await verdict(RECOVERY_ALPHA);
    await askToReopen();
    const { container } = render(<><ReopenHoldCallout place="worldLabsNotice" /><ReopenHoldCallout place="runHistory" /></>);
    const shown = container.querySelectorAll('[data-reopen-hold-callout]');
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute('data-reopen-hold-callout')).toBe('runHistory');
    expect(shown[0].getAttribute('role')).toBe('status');
    expect(shown[0].textContent).toContain(LINES.recovery);
  });

  it('the Run History form is in the rail beside the Run History button; the Marble forms under the World Labs notice', () => {
    const rail = readFileSync(resolve(__dirname, '../src/components/WorkspaceRail.tsx'), 'utf8');
    const anchor = rail.slice(rail.indexOf('workspace-rail__anchor'), rail.indexOf('</div>', rail.indexOf('workspace-rail__anchor')));
    expect(anchor).toContain('label="Open run history"');
    expect(anchor).toContain('<ReopenHoldCallout place="runHistory" />');
    const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
    const stack = app.slice(app.indexOf('className="world-labs-stack"'), app.indexOf('</div>', app.indexOf('className="world-labs-stack"')));
    expect(stack).toMatch(/<ProviderRecoveryStatus \/>\s*\{isCanvas && <ReopenHoldCallout place="worldLabsNotice" \/>\}/);
  });
});

describe('review 19 item 6: focus goes to the canvas after a held Open', () => {
  it('document.activeElement is the canvas, not <body>', async () => {
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    document.body.appendChild(canvas);
    try {
      duplicateN1();
      useGraphStore.setState({ isExecuting: true });
      const open = document.createElement('button');
      document.body.appendChild(open);
      open.focus();
      await askToReopen();
      open.remove();
      await vi.waitFor(() => expect(document.activeElement).toBe(canvas));
      expect(canvas.getAttribute('tabindex')).toBe('-1');
      expect(noticeNow()).toBe(LINES.run);
    } finally {
      canvas.remove();
    }
  });
});

describe('review 19 item 3 (GM r32, 3): the person’s reopen in another window', () => {
  const personReopen = (tab: string) => bootSwitch({ workspaceRevision: 'rev-a2', proposalsKept: true,
    projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor: { kind: 'person', tab }, created: false } });

  it('a window on Projects stays on Projects, its project followed', async () => {
    useProjectStore.setState({ screen: 'home' });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    personReopen('tab-window-a');
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(useProjectStore.getState().screen).toBe('home');
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha');
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('a window on the canvas follows onto the canvas', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    personReopen('tab-window-a');
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(useProjectStore.getState().screen).toBe('workspace');
  });

  it('an agent’s switch still takes a window on Projects to the canvas, as before', async () => {
    useProjectStore.setState({ screen: 'home' });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    bootSwitch({ workspaceRevision: 'rev-a2', projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor: { kind: 'agent', name: 'Codex' }, created: false } });
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    expect(useProjectStore.getState().screen).toBe('workspace');
  });
});

describe('review 19 item 5: a delete this tab said is never lost silently', () => {
  it('the tab keeps its id across a reload of the same tab', () => {
    const storage = window.sessionStorage;
    storage.clear();
    const first = takeTabId(storage);
    // The page goes (pagehide marks the id free), and the reload takes it.
    storage.setItem('nebula:tabIdFree', first);
    expect(takeTabId(storage)).toBe(first);
    expect(storage.getItem('nebula:tabIdFree')).toBeNull();
  });

  it('a duplicated browser tab (its copy of sessionStorage, the first tab still open) makes its own id', () => {
    const storage = window.sessionStorage;
    storage.clear();
    const first = takeTabId(storage);
    // No free mark: the first tab is still open.
    const copy = takeTabId(storage);
    expect(copy).not.toBe(first);
    expect(copy).toMatch(/^tab-/);
  });

  it('no storage: a fresh id each load, as before', () => {
    expect(takeTabId(null)).toMatch(/^tab-/);
    expect(takeTabId(null)).not.toBe(takeTabId(null));
  });

  it('the line for nodes Nebula kept', () => {
    expect(deletesKeptLine(['Hero prompt'])).toBe('Nebula kept “Hero prompt” because another tab saved it last. Delete it again to remove it.');
    expect(deletesKeptLine(['Hero prompt', 'Brief'])).toBe('Nebula kept “Hero prompt” and “Brief” because another tab saved them last. Delete them again to remove them.');
  });

  it('a handoff whose delete Nebula kept: the node is back on the canvas, and the line says why', async () => {
    const local = duplicateN1();
    // Saved under its tab-local id, then deleted here before the next save.
    await useProjectStore.getState().flush();
    useGraphStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== local) }));
    const kept = { ...project('alpha'), snapshot: { ...project('alpha').snapshot, nodes: [...project('alpha').snapshot.nodes,
      { id: 'n2', type: 'model-node', position: { x: 10, y: 400 }, data: { definitionId: 'text-input', label: 'Kept copy', params: { value: 'v' }, state: 'idle', outputs: {} } }] } };
    vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot, deletesKept: ['n2'] }) as never);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ workspaceRevision: 'rev-a2' }));
    vi.mocked(projects.getProject).mockResolvedValue(kept as never);
    bootSwitch({ workspaceRevision: 'rev-a2', projectSwitch: { projectId: 'alpha', projectName: P, previousRevision: 'rev-a',
      previousProjectId: 'alpha', previousProjectName: P, actor: { kind: 'agent', name: 'Codex' }, created: false } });
    await vi.waitFor(() => expect(getProjectContext()?.revision).toBe('rev-a2'));
    await vi.waitFor(() => expect(useProjectStore.getState().busy).toBe(false));
    const calls = vi.mocked(projects.saveProject).mock.calls.map(([id, , revision, pending]) => ({ id, revision, deleted: pending?.deleted }));
    expect(calls, JSON.stringify(calls)).toContainEqual({ id: 'alpha', revision: 'rev-a', deleted: [local] });
    expect(useGraphStore.getState().nodes.some((node) => node.id === 'n2')).toBe(true);
    await vi.waitFor(() => expect(noticeNow()).toBe('Nebula kept “Kept copy” because another tab saved it last. Delete it again to remove it.'));
  });
});

describe('review 19 item 12: saved canvases are ordered by what Nebula owns, never a number in a name', () => {
  it('equal save times: by id, then as listed; "Shot 12" and "Shot 7" aren’t read', () => {
    const at = '2026-10-31T10:00:00.000Z';
    const rows = [{ id: 'p-b', name: 'Shot 7', filedAt: at }, { id: 'p-a', name: 'Shot 12', filedAt: at }];
    expect(savedOrder(rows).map((row) => row.name)).toEqual(['Shot 12', 'Shot 7']);
    expect(savedOrder([{ name: 'Recovered canvas 2' }, { name: 'Recovered canvas' }]).map((row) => row.name))
      .toEqual(['Recovered canvas 2', 'Recovered canvas']);
    const source = readFileSync(resolve(__dirname, '../src/components/projects/catalogRestoreCopy.ts'), 'utf8');
    expect(source).not.toMatch(/nameNumber|\\d\+\)\$/);
  });
});

describe('review 19 item 14: curly apostrophes on the lines round 20 touched', () => {
  it('the update line and the reopen fallback', () => {
    const store = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    expect(store).toContain('your unsaved edits haven’t been saved yet.');
    expect(store).toContain('Try again before you reload, or they’ll be lost.');
    expect(store).toContain("'Couldn’t reopen the project.'");
    expect(store).not.toContain("haven't been saved yet");
  });
});
