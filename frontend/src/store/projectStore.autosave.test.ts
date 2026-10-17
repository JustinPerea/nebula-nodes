import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { wsClient } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSnapshot, SavedProject } from '../lib/projects';

const saveProject = vi.mocked(api.saveProject);
const summary = {
  id: 'p1', name: 'Loop', createdAt: '', updatedAt: '2026-10-16T00:00:00Z', lastOpenedAt: null,
  nodeCount: 1, edgeCount: 0, thumbnail: null,
};
const saved = (snapshot: ProjectSnapshot): SavedProject => ({ ...summary, snapshot });

/** Puts one node on the canvas with the given prompt (a new array, like an Inspector edit). */
function setPrompt(prompt: string): void {
  useGraphStore.setState({ nodes: [{
    id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt }, outputs: {} },
  }] as never });
}
function savedPrompts(): unknown[] {
  return saveProject.mock.calls.map(([, snapshot]) => snapshot.nodes[0]?.data.params.prompt);
}

const originalFlush = useProjectStore.getState().flush;
let flushCalls = 0;
let unsubscribe: () => void = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  saveProject.mockReset();
  saveProject.mockImplementation(async (_id, snapshot) => saved(snapshot));
  setProjectContext({ id: 'p1', revision: 'r1' });
  setPrompt('a');
  useProjectStore.setState({
    initialized: true, busy: false, activeProject: summary, dirty: false, saveStatus: 'saved', error: null,
    flush: originalFlush,
  });
  // The store keeps a private "last saved" fingerprint; a first save of 'a' sets it.
  await useProjectStore.getState().flush();
  // flush re-enters itself through get().flush(), so this wrapper sees every
  // call and stops a runaway loop (which would otherwise hang the test).
  flushCalls = 0;
  useProjectStore.setState({ flush: async () => {
    flushCalls += 1;
    if (flushCalls > 20) throw new Error('flush loop');
    return originalFlush();
  } });
  saveProject.mockClear();
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe('project autosave', () => {
  it('ends clean, without further flushes, when an edit is reverted inside the autosave window', async () => {
    setPrompt('b');
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.advanceTimersByTimeAsync(200);
    setPrompt('a');
    await vi.advanceTimersByTimeAsync(2000);

    expect(flushCalls).toBeLessThanOrEqual(1);
    expect(saveProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved', error: null });
  });

  it('still saves an edit made while a save is in flight', async () => {
    let finish: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => {
      finish = () => resolve(saved(snapshot));
    }));
    setPrompt('b');
    await vi.advanceTimersByTimeAsync(600);
    expect(savedPrompts()).toEqual(['b']);
    expect(useProjectStore.getState().saveStatus).toBe('saving');

    setPrompt('c');
    finish();
    await vi.advanceTimersByTimeAsync(2000);

    expect(savedPrompts()).toEqual(['b', 'c']);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('saves the older value when an edit is reverted while a newer one is in flight', async () => {
    let finish: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => {
      finish = () => resolve(saved(snapshot));
    }));
    setPrompt('b');
    await vi.advanceTimersByTimeAsync(600);
    // Back to 'a', which equals the last completed save but not the one in flight.
    setPrompt('a');
    finish();
    await vi.advanceTimersByTimeAsync(2000);

    expect(savedPrompts()).toEqual(['b', 'a']);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved' });
  });

  it('stops after an in-flight save when another window takes over the project', async () => {
    let finish: () => void = () => {};
    saveProject.mockImplementationOnce((_id, snapshot) => new Promise((resolve) => {
      finish = () => resolve(saved(snapshot));
    }));
    setPrompt('b');
    await vi.advanceTimersByTimeAsync(600);
    setPrompt('c');
    // Another tab switched the backend's active project while 'b' was saving.
    const onSocket = vi.mocked(wsClient.subscribe).mock.calls.at(-1)?.[0];
    onSocket?.({ type: 'graphSync', workspaceRevision: 'r2' } as never);
    expect(useProjectStore.getState()).toMatchObject({ initialized: false, dirty: true });
    finish();
    await vi.advanceTimersByTimeAsync(2000);

    // 'b' landed and 'c' is still unsaved, so flush looks once more, finds the
    // workspace closed, and stops. 'c' waits for the recovery copy on Retry.
    expect(flushCalls).toBe(2);
    expect(savedPrompts()).toEqual(['b']);
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('shows the retry state when a save fails, and Retry saves it', async () => {
    saveProject.mockRejectedValueOnce(new Error('Disk full'));
    setPrompt('b');
    await vi.advanceTimersByTimeAsync(2000);

    expect(savedPrompts()).toEqual(['b']);
    expect(flushCalls).toBe(1);
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'error', error: 'Disk full' });

    vi.mocked(api.listProjects).mockResolvedValueOnce({ projects: [summary], activeProjectId: 'p1', workspaceRevision: 'r1' });
    await useProjectStore.getState().retry();
    expect(savedPrompts()).toEqual(['b', 'b']);
    expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved', error: null });
  });
});
