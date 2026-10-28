import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Projects keeps its list live (projectsChanged). A listing that fails (a
// network blip, a 5xx) is tried again with backoff, a few times, while the
// person stays on Projects, and again when the window regains focus, comes
// back online or the socket reconnects (PR #102 follow-up, 2026-10-20).

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  openProject: vi.fn(),
  recoverProject: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSummary } from '../lib/projects';

const listProjects = vi.mocked(api.listProjects);
const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const listing = (...names: string[]) => ({
  projects: names.map((name, index) => summary(`p${index + 1}`, name)), trash: [], activeProjectId: null,
  workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION,
}) as never;
const blip = () => new api.ProjectRequestError('Bad gateway', 502);
const names = () => useProjectStore.getState().projects.map((project) => project.name);

function socket() {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  return handler;
}
const somethingChanged = () => socket()({ type: 'projectsChanged', change: 'created', projectId: 'p9' } as never);

let unsubscribe: () => void = () => {};

beforeEach(() => {
  resetProjectStoreForTests();
  vi.useFakeTimers();
  listProjects.mockReset();
  setProjectContext(null);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
  useProjectStore.setState({
    screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [], dirty: false, saveStatus: 'saved', error: null, switchNotice: null,
  });
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe('a listing that fails on Projects is tried again', () => {
  it('after a blip, quietly: no error, then the list', async () => {
    listProjects.mockRejectedValueOnce(blip()).mockResolvedValue(listing('Made by Claude'));
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().error).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['Made by Claude']);
    expect(useProjectStore.getState().error).toBeNull();
    // Listed: nothing more is scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('with backoff, a bounded number of times, and never alarms', async () => {
    listProjects.mockRejectedValue(blip());
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    const calls: number[] = [];
    for (const wait of [999, 1, 1999, 1, 3999, 1, 7999, 1, 15_999, 1]) {
      await vi.advanceTimersByTimeAsync(wait);
      calls.push(listProjects.mock.calls.length);
    }
    // 1 s, 2 s, 4 s, 8 s, 16 s after each failure.
    expect(calls).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listProjects).toHaveBeenCalledTimes(6);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('when the window regains focus or comes back online, once the retries ran out', async () => {
    listProjects.mockRejectedValue(blip());
    somethingChanged();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listProjects).toHaveBeenCalledTimes(6);

    listProjects.mockResolvedValueOnce(listing('Back')).mockRejectedValue(blip());
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(7);
    expect(names()).toEqual(['Back']);
    // Listed and current: focus doesn't list again for nothing.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(7);

    somethingChanged(); // fails: stale again
    await vi.advanceTimersByTimeAsync(0);
    listProjects.mockResolvedValue(listing('Online again'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(['Online again']);
  });

  it('when the socket reconnects (its first sync), even with the revision unchanged', async () => {
    listProjects.mockRejectedValueOnce(blip()).mockResolvedValue(listing('After reconnect'));
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    socket()({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [] } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['After reconnect']);
    // The backoff retry it replaced doesn't send another.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('stops when the person leaves Projects, and lists again when they come back', async () => {
    listProjects.mockRejectedValue(blip());
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(api.openProject).mockResolvedValue({ project: { ...summary('p1', 'Loop'), snapshot: {
      nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null } },
    workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await useProjectStore.getState().open('p1');
    expect(useProjectStore.getState().screen).toBe('workspace');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(1);

    listProjects.mockResolvedValue(listing('Loop', 'Made meanwhile'));
    await useProjectStore.getState().goHome();
    await vi.advanceTimersByTimeAsync(0);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['Loop', 'Made meanwhile']);
  });

  it('one request at a time, and an older reply never replaces a newer list', async () => {
    let inFlight = 0; let most = 0;
    const replies: Array<(value: unknown) => void> = [];
    listProjects.mockRejectedValueOnce(blip());
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    listProjects.mockImplementation(() => {
      inFlight += 1; most = Math.max(most, inFlight);
      return new Promise((resolve) => replies.push((value) => { inFlight -= 1; resolve(value as never); }));
    });
    window.dispatchEvent(new Event('focus')); // starts a listing, still out
    await vi.advanceTimersByTimeAsync(0);
    somethingChanged(); // asks for one more after it
    await vi.advanceTimersByTimeAsync(60_000); // the backoff timer would have fired
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(1);
    replies[0](listing('Older'));
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(2);
    replies[1](listing('Newer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(['Newer']);
    expect(most).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(replies).toHaveLength(2);
  });

  it('a retry still out when the person presses Try again doesn’t replace the list Try again got', async () => {
    const replies: Array<(value: unknown) => void> = [];
    listProjects.mockRejectedValueOnce(blip());
    somethingChanged();
    await vi.advanceTimersByTimeAsync(0);
    listProjects.mockImplementation(() => new Promise((resolve) => replies.push(resolve as never)));
    await vi.advanceTimersByTimeAsync(1000); // the backoff retry goes out
    expect(replies).toHaveLength(1);
    useProjectStore.setState({ error: 'Could not rename the project.' });
    const retry = useProjectStore.getState().retry(); // the error's Try again
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(2);
    replies[1](listing('Newer'));
    await retry;
    expect(names()).toEqual(['Newer']);
    replies[0](listing('Older'));
    await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual(['Newer']);
  });
});
