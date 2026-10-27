import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// After Nebula restored a damaged project list, the listing carries
// `catalogRestore` until the person closes the Projects home notice (×).
// The first time a tab sees it, the Agent log gets the source and the
// damaged file's path, which the notice leaves out (2026-10-27).

vi.mock('../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  dismissCatalogRestore: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { CatalogRestore } from '../lib/projects';

const listProjects = vi.mocked(api.listProjects);
const dismiss = vi.mocked(api.dismissCatalogRestore);
const RESTORE: CatalogRestore = {
  id: 'f'.repeat(32), at: '2026-10-27T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  damagedFile: '/x/projects/catalog.json.damaged-20261027T101500Z-1a2b3c4d',
  addedBack: [{ id: 'a'.repeat(32), name: 'Dunes' }], addedBackCount: 1, notAddedBackCount: 0,
};
const listing = (restore?: CatalogRestore) => ({
  projects: [], trash: [], activeProjectId: null, workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION,
  ...(restore ? { catalogRestore: restore } : {}),
}) as never;
const relist = () => {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  handler({ type: 'projectsChanged', change: 'catalogRestored', projectId: null } as never);
};

let unsubscribe: () => void = () => {};
const logged: string[] = [];
const onLog = (event: Event) => logged.push(String((event as CustomEvent).detail?.message));

beforeEach(() => {
  resetProjectStoreForTests();
  vi.useFakeTimers();
  listProjects.mockReset();
  dismiss.mockReset().mockResolvedValue({ dismissed: true });
  logged.length = 0;
  window.addEventListener('nebula:agent-log-entry', onLog);
  setProjectContext(null);
  useProjectStore.setState({
    screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [], catalogRestore: null, dirty: false, saveStatus: 'saved', error: null, switchNotice: null,
  });
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  window.removeEventListener('nebula:agent-log-entry', onLog);
  unsubscribe();
  vi.useRealTimers();
});

describe('the catalog restore notice', () => {
  it('comes with the listing, logs its source and path once, and stays closed once dismissed', async () => {
    listProjects.mockResolvedValue(listing(RESTORE));
    relist();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectStore.getState().catalogRestore?.id).toBe(RESTORE.id);
    expect(logged).toEqual([`Project list restored from catalog.json.bak; damaged file kept at ${RESTORE.damagedFile}; 1 added back.`]);

    relist();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toHaveLength(1);

    useProjectStore.getState().dismissCatalogRestore();
    expect(dismiss).toHaveBeenCalledWith(RESTORE.id);
    expect(useProjectStore.getState().catalogRestore).toBeNull();
    // A listing from before the dismiss landed still carries it: not shown again here.
    relist();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectStore.getState().catalogRestore).toBeNull();
  });

  it('is gone once the backend no longer lists it', async () => {
    listProjects.mockResolvedValueOnce(listing(RESTORE)).mockResolvedValue(listing());
    relist();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectStore.getState().catalogRestore).not.toBeNull();
    relist();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectStore.getState().catalogRestore).toBeNull();
  });
});
