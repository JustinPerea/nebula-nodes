/**
 * Q116 a) (Justin, 2026-10-23): "a): "Download your edits" plus "Continue
 * without them"." The question: "If the backend refuses it for good, for
 * example because it's too large, the Projects screen can't load: every Try
 * again sends the same copy and gets the same refusal. The only way past is
 * reloading the page, which throws the edits away without saying so."
 *
 * GM - Design's screen for it (copy verbatim): heading "Couldn't save your
 * edits.", the reason ("These edits are too large for Nebula to save.
 * Download them so nothing is lost, or continue without them." for too
 * large; otherwise the mapped reason with the same second sentence), and
 * "Download your edits" / "Continue without them". A failure a retry can fix
 * keeps today's Try again. Every path that sends the held copy goes through
 * this, and none of them sends it again once it was refused for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
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
vi.mock('../src/lib/graphFileShared', async (original) => ({
  ...await original<typeof import('../src/lib/graphFileShared')>(), saveEditsToFile: vi.fn(),
}));

import * as projectStore from '../src/store/projectStore';
import { projectRetryOffer, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import { reloadPage } from '../src/lib/paramsOutdated';
import { saveEditsToFile } from '../src/lib/graphFileShared';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { ConnectionLostError, REFUSED_FALLBACK_COPY } from '../src/lib/errorCopy';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const NEXT = GRAPH_PARAMS_VERSION + 1;
const TOO_LARGE = 'These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them.';
const RECOVER = "Couldn't recover the project.";
const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
const refusal = (reason: string, status: number, options: { storageLimit?: 'projects' | 'storage'; code?: string } = {}) =>
  new projects.ProjectRequestError(reason, status, { heading: RECOVER, ...options } as never);
const tooLarge = () => refusal('Project snapshot exceeds the 16 MiB limit', 413);

function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
function editCanvas(value = 'Unsaved edit'): void {
  const [node] = useGraphStore.getState().nodes;
  useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value } } }] });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Another window took the project while this tab held an unsaved edit. */
function falleBehind(): void {
  editCanvas();
  emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true });
}
const state = () => useProjectStore.getState() as ReturnType<typeof useProjectStore.getState> & {
  unsavedEdits?: { reason: string } | null; editsSavedAs?: { name: string; reopens: boolean } | null;
  downloadUnsavedEdits?: () => Promise<void>; continueWithoutEdits?: () => Promise<void>;
};
const unloadPrompts = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(saveEditsToFile).mockResolvedValue({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
  await useProjectStore.getState().initialize();
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
});

describe('a recovered copy the backend refuses for good', () => {
  it("too large: GM's screen, no Try again, and the copy is never sent again", async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    expect(state().error).toBeNull();
    expect(projectRetryOffer(state())).toBe('none');
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    // Nothing else sends it: a startup load, Try again, another window, an update.
    await useProjectStore.getState().initialize();
    await useProjectStore.getState().retry();
    emit({ type: 'graphSync', workspaceRevision: 'rev-c', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true });
    emit({ type: 'graphSync', workspaceRevision: 'rev-d', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await flush();
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('another refusal for good: the mapped reason, then GM\'s second sentence', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(refusal('Recovery ID already belongs to a different snapshot', 409));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason:
      'Recovery ID already belongs to a different snapshot. Download them so nothing is lost, or continue without them.' });
  });

  it("the store's project limit is a 413 but not a copy that's too large: the mapped reason", async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(refusal('Project limit reached', 413, { storageLimit: 'projects' }));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason:
      'Project limit reached. Download them so nothing is lost, or continue without them.' });
  });

  it("a refusal with no reason of its own: GM's second sentence alone (the general line says reload)", async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(refusal(REFUSED_FALLBACK_COPY, 422));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: 'Download them so nothing is lost, or continue without them.' });
  });
});

describe('a failure a retry can fix keeps Try again', () => {
  it.each([
    ['503', () => refusal("Nebula didn't respond. Try again.", 503)],
    ['no answer', () => new ConnectionLostError(new TypeError('Failed to fetch'), { heading: RECOVER })],
    ['507 storage', () => refusal('Project storage is unavailable; the canvas was preserved', 507)],
  ])('%s: today\'s line and Try again, then it recovers', async (_label, failure) => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(failure());
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits ?? null).toBeNull();
    expect(state().error).not.toBeNull();
    expect(projectRetryOffer(state())).not.toBe('none');
    vi.mocked(projects.recoverProject).mockResolvedValueOnce(project('recovered'));
    await useProjectStore.getState().retry();
    expect(projects.recoverProject).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ initialized: true, error: null });
  });
});

describe('Download your edits', () => {
  it('writes the held copy, says where it went, then loads the projects', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    const held = vi.mocked(projects.recoverProject).mock.calls[0][1];
    vi.mocked(projects.listProjects).mockClear();
    await state().downloadUnsavedEdits!();
    expect(saveEditsToFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveEditsToFile).mock.calls[0]).toEqual([held, 'Glass campaign']);
    expect(vi.mocked(saveEditsToFile).mock.calls[0][0].nodes[0].data.params.value).toBe('Unsaved edit');
    expect(state().unsavedEdits).toBeNull();
    expect(state().editsSavedAs).toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
    expect(projects.listProjects).toHaveBeenCalled();
    expect(state()).toMatchObject({ initialized: true, error: null, screen: 'home', dirty: false });
    // The edits are in the file now: the tab let go of the copy.
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(unloadPrompts()).toBe(false);
  });

  it('a cancelled save returns to the two choices with the copy still held', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    vi.mocked(saveEditsToFile).mockResolvedValueOnce(null);
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    expect(state().editsSavedAs ?? null).toBeNull();
    expect(state().initialized).toBe(false);
    expect(unloadPrompts()).toBe(true);
    await state().downloadUnsavedEdits!();
    expect(vi.mocked(saveEditsToFile).mock.calls[1][0]).toEqual(vi.mocked(saveEditsToFile).mock.calls[0][0]);
    expect(state()).toMatchObject({ unsavedEdits: null, initialized: true });
  });
});

describe('Continue without them', () => {
  it('drops the copy and loads the projects, and sends nothing about it', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    vi.mocked(projects.saveProject).mockClear();
    await state().continueWithoutEdits!();
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(saveEditsToFile).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ unsavedEdits: null, initialized: true, error: null, dirty: false });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
  });
});

describe('nothing is thrown away without asking', () => {
  it('a reload or a closed tab asks while the screen holds the edits', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    expect(unloadPrompts()).toBe(true);
    await state().continueWithoutEdits!();
    expect(unloadPrompts()).toBe(false);
  });
});

describe('every path that sends the held copy', () => {
  it('a stop for a Nebula update: the screen at once, no "Try again before you reload"; a download asks for the reload instead of reloading', async () => {
    editCanvas();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: NEXT, workspaceRevision: 'rev-up' }));
    emit({ type: 'graphSync', workspaceRevision: 'rev-up', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE }));
    expect(state().error).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    await state().downloadUnsavedEdits!();
    expect(saveEditsToFile).toHaveBeenCalledTimes(1);
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    // A reload now would drop the line that says where the file went.
    expect(reloadPage).not.toHaveBeenCalled();
    expect(state().editsSavedAs).toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
    expect(state().error).toBe('Nebula was updated while this tab was open. Reload the tab to use the update. Your saved work is kept.');
    expect(state().unsavedEdits).toBeNull();
    expect(unloadPrompts()).toBe(false);
  });

  it('a stop for a Nebula update, then Continue without them: it reloads as it would have', async () => {
    editCanvas();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: NEXT, workspaceRevision: 'rev-up' }));
    emit({ type: 'graphSync', workspaceRevision: 'rev-up', paramsVersion: NEXT, nodes: [], edges: [], empty: true });
    await vi.waitFor(() => expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE }));
    await state().continueWithoutEdits!();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
  });

  it("following an agent's switch: a save that failed and a copy refused for good show the screen, not \"couldn't follow it\"", async () => {
    editCanvas();
    vi.mocked(projects.saveProject).mockRejectedValue(refusal('This canvas is out of date. Open the current project before editing or running it.', 409));
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
        previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' } } });
    // GM, 2026-10-24: the screen names the agent and the project it opens.
    await vi.waitFor(() => expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE,
      agentOpening: { agent: 'Claude', projectName: 'beta' } }));
    expect(state().error).toBeNull();
    expect(state().busy).toBe(false);
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    await state().downloadUnsavedEdits!();
    expect(vi.mocked(saveEditsToFile).mock.calls[0][1]).toBe('Glass campaign');
    expect(state()).toMatchObject({ unsavedEdits: null, initialized: true });
    expect(state().activeProject?.id).toBe('beta');
  });

  it('an Open whose answer was lost: the screen, then the projects and the open it was finishing', async () => {
    vi.mocked(projects.openProject).mockImplementationOnce(async () => {
      editCanvas('Edited while it opened');
      throw new ConnectionLostError(new TypeError('Failed to fetch'), { heading: "Couldn't open the project." });
    });
    await useProjectStore.getState().open('beta');
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    expect(vi.mocked(projects.recoverProject).mock.calls[0][1].nodes[0].data.params.value).toBe('Edited while it opened');
    await state().downloadUnsavedEdits!();
    expect(projects.openProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(projects.openProject).mock.calls[1][0]).toBe('beta');
    expect(state()).toMatchObject({ unsavedEdits: null, screen: 'workspace' });
    expect(state().activeProject?.id).toBe('beta');
  });

  it('exports what the Projects screen needs', () => {
    expect(typeof (projectStore as Record<string, unknown>).projectRetryOffer).toBe('function');
    expect(typeof state().downloadUnsavedEdits).toBe('function');
    expect(typeof state().continueWithoutEdits).toBe('function');
  });
});

describe("review: refusals reconnecting can fix, and files Load graph can't open", () => {
  const BILLING = "zz1: Changing how a Krea node is billed (_kreaAuth) is the person's call, so it needs their OK.";

  it('a tab not connected as the person (person_required) keeps Try again, and the same copy saves once it reconnects', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(refusal(BILLING, 403, { code: 'person_required' }));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits ?? null).toBeNull();
    expect(state().error).not.toBeNull();
    expect(projectRetryOffer(state())).not.toBe('none');
    vi.mocked(projects.recoverProject).mockResolvedValueOnce(project('recovered'));
    await useProjectStore.getState().retry();
    const [first, second] = vi.mocked(projects.recoverProject).mock.calls;
    expect(second[2]).toBe(first[2]);
    expect(second[1]).toEqual(first[1]);
    expect(state()).toMatchObject({ initialized: true, error: null });
  });

  it('a 403 with no person_required code is still a refusal for good', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(refusal(BILLING, 403));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: `${BILLING} Download them so nothing is lost, or continue without them.` });
    expect(projectRetryOffer(state())).toBe('none');
  });

  it("a held copy over Load graph's node limit still downloads, and says it won't reopen", async () => {
    const actual = await vi.importActual<typeof import('../src/lib/graphFileShared')>('../src/lib/graphFileShared');
    vi.mocked(saveEditsToFile).mockImplementation(actual.saveEditsToFile);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:edits'), revokeObjectURL: vi.fn() });
    const [node] = useGraphStore.getState().nodes;
    useGraphStore.setState({ nodes: Array.from({ length: 10_001 }, (_, index) => ({
      ...node, id: `n${index + 1}`, data: { ...node.data, params: { value: `Unsaved ${index}` } } })) });
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true });
    vi.mocked(projects.recoverProject).mockRejectedValue(refusal('Project contains too many nodes or connections', 413));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    await state().downloadUnsavedEdits!();
    expect(downloads).toEqual(['Glass campaign - unsaved edits.nebula']);
    expect(state().editsSavedAs).toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: false });
    expect(state()).toMatchObject({ unsavedEdits: null, initialized: true });
  });
});

/** GM - Design, 2026-10-23, verbatim (Q116 a). */
describe("GM's lines in the store", () => {
  const GM3 = "This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.";
  const BILLING = "zz1: Changing how a Krea node is billed (_kreaAuth) is the person's call, so it needs their OK.";
  const errorDetails = () => (projectStore as unknown as {
    projectErrorDetails?: (state: unknown) => string | null }).projectErrorDetails?.(state()) ?? null;

  it("a person-only refusal under \"Couldn't recover the project.\": GM's line 3, the backend's words behind Details", async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(
      new projects.ProjectRequestError(BILLING, 403, { heading: RECOVER, detail: BILLING, code: 'person_required' }));
    await useProjectStore.getState().retry();
    expect(state().error).toBe(`${RECOVER} ${GM3}`);
    expect(errorDetails()).toBe(BILLING);
    expect(projectRetryOffer(state())).toBe('redo');
    // Another line later doesn't carry these Details.
    useProjectStore.setState({ error: "Couldn't load your projects." });
    expect(errorDetails()).toBeNull();
  });

  it('a refusal without the code has no Details', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(new ConnectionLostError(new TypeError('Failed to fetch')));
    await useProjectStore.getState().retry();
    expect(state().error).not.toBeNull();
    expect(errorDetails()).toBeNull();
  });

  it("a download that couldn't be written: GM's line 2, the copy still held, and a retry writes it", async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    vi.mocked(saveEditsToFile).mockRejectedValueOnce(new DOMException('The disk is full.', 'QuotaExceededError'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, downloadFailed: true });
    expect(state().editsSavedAs ?? null).toBeNull();
    expect(state().busy).toBe(false);
    expect(unloadPrompts()).toBe(true);
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    // The retry writes the same copy and lets go of it.
    await state().downloadUnsavedEdits!();
    expect(vi.mocked(saveEditsToFile).mock.calls[1][0]).toEqual(vi.mocked(saveEditsToFile).mock.calls[0][0]);
    expect(state().unsavedEdits).toBeNull();
    expect(state().editsSavedAs).toEqual({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
  });

  it('a cancelled picker after a failed write goes back to the two choices, with no line', async () => {
    falleBehind();
    vi.mocked(projects.recoverProject).mockRejectedValue(tooLarge());
    await useProjectStore.getState().retry();
    vi.mocked(saveEditsToFile).mockRejectedValueOnce(new Error('write failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, downloadFailed: true });
    vi.mocked(saveEditsToFile).mockResolvedValueOnce(null);
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
    // Continue without them still works from here.
    await state().continueWithoutEdits!();
    expect(state().unsavedEdits).toBeNull();
  });
});
