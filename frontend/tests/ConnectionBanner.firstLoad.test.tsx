import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Design: on Projects the offline banner stays away only while the first-load line is what Projects
// shows; the store goes through the first load for real, and the banner is the app's own.

vi.mock('../src/lib/backend', () => ({ apiFetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../src/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/projects')>()),
  saveProject: vi.fn(), listProjects: vi.fn(), openProject: vi.fn(), createProject: vi.fn(), recoverProject: vi.fn(),
}));

import * as api from '../src/lib/projects';
import { OFFLINE_LINE } from '../src/components/BackendConnectionStatus';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { BACKEND_NOT_RUNNING_COPY, ConnectionLostError, FIRST_LOAD_RETRYING_COPY } from '../src/lib/errorCopy';
import { setProjectContext } from '../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';

const listProjects = vi.mocked(api.listProjects);
const state = () => useProjectStore.getState();
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const banner = () => screen.queryByRole('status');
const noServer = () => new ConnectionLostError(new Error('refused'), { reason: BACKEND_NOT_RUNNING_COPY });
const listed = { projects: [], trash: [], activeProjectId: null, workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION } as never;

/** A first load that finds no server: the retry line is up. */
async function firstLoadFails() {
  resetProjectStoreForTests();
  useProjectStore.setState({ initialized: false, loading: true, busy: false, screen: 'home', activeProject: null, projects: [],
    error: null, errorRetry: null, unsavedEdits: null });
  listProjects.mockRejectedValue(noServer());
  void state().initialize();
  await settle();
  expect(state().error).toBe(FIRST_LOAD_RETRYING_COPY);
}

beforeEach(() => {
  vi.useFakeTimers();
  listProjects.mockReset();
  setProjectContext(null);
  resetBackendConnectionForTests();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the offline banner and the first-load line', () => {
  it('is hidden on Projects while the line shows, and back once Try again lands', async () => {
    await firstLoadFails();
    render(<ConnectionBanner placement="home" />);
    await settle();
    expect(banner()).toBeNull();
    listProjects.mockResolvedValue(listed);
    await act(async () => { await state().retry(); });
    expect(state()).toMatchObject({ initialized: true, error: null });
    expect(banner()?.textContent).toBe(OFFLINE_LINE);
  });

  it('shows on the other screens while the line shows on Projects', async () => {
    await firstLoadFails();
    const { rerender } = render(<ConnectionBanner placement="home" />);
    await settle();
    expect(banner()).toBeNull();
    rerender(<ConnectionBanner placement="workspace" />);
    expect(banner()?.textContent).toBe(OFFLINE_LINE);
    rerender(<ConnectionBanner placement="home" />);
    expect(banner()).toBeNull();
  });

  it('shows again when another error replaces the line', async () => {
    await firstLoadFails();
    render(<ConnectionBanner placement="home" />);
    await settle();
    expect(banner()).toBeNull();
    act(() => { useProjectStore.setState({ error: 'Nebula couldn’t rename the project.', errorRetry: { action: 'load' } }); });
    expect(banner()?.textContent).toBe(OFFLINE_LINE);
  });

  it('shows when a held-edits screen takes the line’s place, and hides again when it goes', async () => {
    await firstLoadFails();
    render(<ConnectionBanner placement="home" />);
    await settle();
    expect(banner()).toBeNull();
    act(() => { useProjectStore.setState({ unsavedEdits: {} as never }); });
    expect(banner()?.textContent).toBe(OFFLINE_LINE);
    act(() => { useProjectStore.setState({ unsavedEdits: null }); });
    expect(banner()).toBeNull();
  });
});
