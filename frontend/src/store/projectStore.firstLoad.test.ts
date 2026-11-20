import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Design: the first load of the projects tries again by itself when Nebula's server can't be
// reached (1, 2, 4, 8, 16 s), says so, and "New project" waits for it; a project open that the
// server never answers stops waiting after 20 s and says so.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  openProject: vi.fn(),
  createProject: vi.fn(),
  recoverProject: vi.fn(),
}));

import * as api from '../lib/projects';
import { BACKEND_NOT_RUNNING_COPY, ConnectionLostError, FIRST_LOAD_RETRYING_COPY, OPEN_TIMEOUT_MS, openTimedOutLine } from '../lib/errorCopy';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { useGraphStore } from './graphStore';
import { projectRetryOffer, resetProjectStoreForTests, stopFirstLoadRetry, subscribeProjectAutosave, useProjectStore, wakeFirstLoad } from './projectStore';
import type { ProjectSummary } from '../lib/projects';

const listProjects = vi.mocked(api.listProjects);
const openProject = vi.mocked(api.openProject);
const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const listing = (...names: string[]) => ({
  projects: names.map((name, index) => summary(`p${index + 1}`, name)), trash: [], activeProjectId: null,
  workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION,
}) as never;
const noServer = () => new ConnectionLostError(new Error('refused'), { reason: BACKEND_NOT_RUNNING_COPY });
const state = () => useProjectStore.getState();
const settle = () => vi.advanceTimersByTimeAsync(0);
const fresh = () => {
  resetProjectStoreForTests();
  useProjectStore.setState({ initialized: false, loading: true, busy: false, screen: 'home', activeProject: null, projects: [], error: null, errorRetry: null });
};

let unsubscribe: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  listProjects.mockReset();
  openProject.mockReset();
  setProjectContext(null);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
  fresh();
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe('a first load with no server tries again by itself', () => {
  it('at 1, 2, 4, 8 and 16 s, then stops with today’s line and Try again', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await settle();
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(state().error).toBe(FIRST_LOAD_RETRYING_COPY);
    expect(projectRetryOffer(state())).toBe('retrying');
    const calls: number[] = [];
    for (const wait of [999, 1, 1999, 1, 3999, 1, 7999, 1, 15_999, 1]) {
      await vi.advanceTimersByTimeAsync(wait);
      calls.push(listProjects.mock.calls.length);
    }
    expect(calls).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(state().error).toBe('Nebula couldn’t load your projects because the server isn’t running. Start Nebula, then reload.');
    expect(projectRetryOffer(state())).toBe('redo');
    expect(state().errorRetry).toEqual({ action: 'load', unreachable: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listProjects).toHaveBeenCalledTimes(6);
  });

  it('keeps the line up while a try is under way, and never runs two loads at once', async () => {
    let release: (value: never) => void = () => {};
    listProjects.mockRejectedValueOnce(noServer()).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as never; }));
    void state().initialize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(state().error).toBe(FIRST_LOAD_RETRYING_COPY);
    expect(state().loading).toBe(true);
    void state().initialize();
    void state().initialize();
    await settle();
    expect(listProjects).toHaveBeenCalledTimes(2);
    release(listing('A'));
    await settle();
    expect(state().initialized).toBe(true);
  });

  it('Try now loads at once and starts the count again', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(listProjects).toHaveBeenCalledTimes(3);
    await state().retry();
    await settle();
    expect(listProjects).toHaveBeenCalledTimes(4);
    // Back to 1 s, not the 4 s the count had reached; the timer it replaced sends nothing.
    await vi.advanceTimersByTimeAsync(999);
    expect(listProjects).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(listProjects).toHaveBeenCalledTimes(5);
  });

  it('Try now: the timer it replaced sends nothing', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    // Tries at 0, 1 and 3 s; the next was due at 7 s.
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(listProjects).toHaveBeenCalledTimes(3);
    await state().retry();
    await settle();
    expect(listProjects).toHaveBeenCalledTimes(4);
    // From the press: 1 s, then 2 s more (4 and 6 s on the clock); the old 7 s timer is gone.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(listProjects).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listProjects).toHaveBeenCalledTimes(6);
  });

  it('a 500, and a 503 with a written reason, show at once and are not tried again', async () => {
    for (const error of [new api.ProjectRequestError('Something broke.', 500),
      new api.ProjectRequestError('Nebula is starting.', 503, { detail: 'Nebula is starting.' })]) {
      fresh();
      listProjects.mockReset();
      listProjects.mockRejectedValue(error);
      void state().initialize();
      await settle();
      expect(state().error).not.toBeNull();
      expect(state().error).not.toBe(FIRST_LOAD_RETRYING_COPY);
      expect(projectRetryOffer(state())).not.toBe('retrying');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listProjects).toHaveBeenCalledTimes(1);
    }
  });

  it('clears the line when a try lands', async () => {
    listProjects.mockRejectedValueOnce(noServer()).mockResolvedValue(listing('Alpha'));
    void state().initialize();
    await settle();
    expect(state().initialized).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().initialized).toBe(true);
    expect(state().error).toBeNull();
    expect(state().errorRetry).toBeNull();
    expect(state().projects.map((project) => project.name)).toEqual(['Alpha']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('a refusal (the server answered) is not tried again by itself', async () => {
    listProjects.mockRejectedValue(new api.ProjectRequestError('Refused', 403));
    void state().initialize();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(state().error).not.toBe(FIRST_LOAD_RETRYING_COPY);
  });

  it('stops when the screen unmounts, and not from a load still on its way', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await settle();
    stopFirstLoadRetry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(1);

    let fail: (error: unknown) => void = () => {};
    fresh();
    listProjects.mockReset();
    listProjects.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    void state().initialize();
    await settle();
    stopFirstLoadRetry();
    fail(noServer());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('loads at once when the server may be back, while retrying or out of tries', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await settle();
    listProjects.mockResolvedValue(listing('Back'));
    wakeFirstLoad();
    await settle();
    expect(state().initialized).toBe(true);
    expect(listProjects).toHaveBeenCalledTimes(2);

    fresh();
    listProjects.mockReset();
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listProjects).toHaveBeenCalledTimes(6);
    listProjects.mockResolvedValue(listing('Back again'));
    wakeFirstLoad();
    await settle();
    expect(state().initialized).toBe(true);
  });

  it('does not wake a screen whose trying-again line another error replaced', async () => {
    listProjects.mockRejectedValue(noServer());
    void state().initialize();
    await settle();
    expect(state().error).toBe(FIRST_LOAD_RETRYING_COPY);
    useProjectStore.setState({ error: 'Something else.', errorRetry: { action: 'load', full: true } });
    wakeFirstLoad();
    await settle();
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(state().error).toBe('Something else.');
  });

  it('does not wake a screen that something else stopped', async () => {
    useProjectStore.setState({ initialized: false, loading: false, error: 'Something else.', errorRetry: { action: 'load', full: true } });
    wakeFirstLoad();
    await settle();
    expect(listProjects).not.toHaveBeenCalled();
  });
});

describe('a project open the server never answers', () => {
  const ready = () => {
    useProjectStore.setState({ initialized: true, loading: false, projects: [summary('p1', 'Alpha'), summary('p2', 'Beta')], workspaceRevision: 'r1' });
  };
  const opened = { project: { ...summary('p2', 'Beta'), snapshot: { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null } }, workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never;

  it('stops waiting after 20 s with its line, and Try again opens it', async () => {
    ready();
    openProject.mockImplementation(() => new Promise(() => {}));
    void state().open('p2');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS - 1);
    expect(state().busy).toBe(true);
    expect(state().error).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(state().busy).toBe(false);
    expect(state().error).toBe('Nebula couldn’t open “Beta” because the server didn’t respond. Try again.');
    expect(projectRetryOffer(state())).toBe('redo');
    expect(state().activeProject).toBeNull();

    listProjects.mockResolvedValue(listing('Alpha', 'Beta'));
    openProject.mockReset();
    openProject.mockResolvedValue(opened);
    await state().retry();
    await settle();
    expect(openProject).toHaveBeenCalledWith('p2', expect.any(String));
    expect(state().error).toBeNull();
    expect(state().activeProject?.id).toBe('p2');
  });

  it('ignores an answer that comes after the timeout: the project does not switch', async () => {
    ready();
    let answer: (value: never) => void = () => {};
    openProject.mockImplementation(() => new Promise((resolve) => { answer = resolve as never; }));
    void state().open('p2');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    expect(state().error).toBe(openTimedOutLine('Beta'));
    answer(opened);
    await settle();
    expect(state().activeProject).toBeNull();
    expect(state().screen).toBe('home');
    expect(state().error).toBe(openTimedOutLine('Beta'));
  });

  const timedOut = async () => {
    ready();
    openProject.mockImplementation(() => new Promise(() => {}));
    void state().open('p2');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    expect(state().error).toBe(openTimedOutLine('Beta'));
    expect(state().initialized).toBe(true);
    openProject.mockReset();
  };
  const createProject = vi.mocked(api.createProject);

  it('after the timeout, New project creates once the projects are read again', async () => {
    await timedOut();
    listProjects.mockResolvedValue({ ...(listing('Alpha', 'Beta') as object), workspaceRevision: 'r9' } as never);
    createProject.mockReset();
    createProject.mockResolvedValue({ ...(opened as object), project: { ...(opened as { project: object }).project, id: 'p3', name: 'New' }, workspaceRevision: 'r10' } as never);
    await state().createProject('New');
    expect(listProjects.mock.invocationCallOrder[0]).toBeLessThan(createProject.mock.invocationCallOrder[0]);
    expect(createProject).toHaveBeenCalledWith('New', 'r9');
    expect(state().activeProject?.id).toBe('p3');
    expect(state().error).toBeNull();
  });

  it('after the timeout, another card’s Open opens it, with a fresh revision', async () => {
    await timedOut();
    listProjects.mockResolvedValue({ ...(listing('Alpha', 'Beta') as object), workspaceRevision: 'r9' } as never);
    openProject.mockResolvedValue({ ...(opened as object), project: { ...(opened as { project: object }).project, id: 'p1', name: 'Alpha' } } as never);
    await state().open('p1');
    expect(openProject).toHaveBeenCalledWith('p1', 'r9');
    expect(state().activeProject?.id).toBe('p1');
    expect(state().error).toBeNull();
  });

  it('after the timeout, a failed re-read keeps the tab usable and says so', async () => {
    await timedOut();
    listProjects.mockRejectedValue(noServer());
    await state().open('p1');
    expect(openProject).not.toHaveBeenCalled();
    expect(state().initialized).toBe(true);
    expect(state().error).not.toBeNull();
    expect(state().busy).toBe(false);
  });

  it('after the timeout, a failed re-read leaves the re-read for the next action', async () => {
    await timedOut();
    listProjects.mockRejectedValueOnce(noServer());
    await state().open('p1');
    expect(openProject).not.toHaveBeenCalled();
    listProjects.mockResolvedValue({ ...(listing('Alpha', 'Beta') as object), workspaceRevision: 'r9' } as never);
    openProject.mockResolvedValue({ ...(opened as object), project: { ...(opened as { project: object }).project, id: 'p1', name: 'Alpha' } } as never);
    await state().open('p1');
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(listProjects.mock.invocationCallOrder[1]).toBeLessThan(openProject.mock.invocationCallOrder[0]);
    expect(openProject).toHaveBeenCalledWith('p1', 'r9');
    expect(state().activeProject?.id).toBe('p1');
  });

  it('after the timeout, Try again still re-reads and opens it', async () => {
    await timedOut();
    listProjects.mockResolvedValue(listing('Alpha', 'Beta'));
    openProject.mockResolvedValue(opened);
    await state().retry();
    await settle();
    expect(listProjects).toHaveBeenCalled();
    expect(listProjects.mock.invocationCallOrder[0]).toBeLessThan(openProject.mock.invocationCallOrder[0]);
    expect(openProject).toHaveBeenCalledWith('p2', expect.any(String));
    expect(state().activeProject?.id).toBe('p2');
    expect(state().error).toBeNull();
  });

  it('a late answer to the timed-out open changes nothing after another open', async () => {
    ready();
    let answer: (value: never) => void = () => {};
    openProject.mockImplementation(() => new Promise((resolve) => { answer = resolve as never; }));
    void state().open('p2');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    listProjects.mockResolvedValue(listing('Alpha', 'Beta'));
    openProject.mockReset();
    openProject.mockResolvedValue({ ...(opened as object), project: { ...(opened as { project: object }).project, id: 'p1', name: 'Alpha' } } as never);
    await state().open('p1');
    expect(state().activeProject?.id).toBe('p1');
    answer(opened);
    await settle();
    expect(state().activeProject?.id).toBe('p1');
    expect(state().error).toBeNull();
    expect(state().screen).toBe('workspace');
  });

  it('an answer inside 20 s opens it as before', async () => {
    ready();
    openProject.mockResolvedValue(opened);
    await state().open('p2');
    expect(state().error).toBeNull();
    expect(state().activeProject?.id).toBe('p2');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS * 2);
    expect(state().error).toBeNull();
  });
});
