/**
 * Q116 a) review: the held edits' screen reads two structured fields from
 * the recover route's answer, never its words:
 * - `limit` ("projects" / "storage") on a 413 from the project store's own
 *   limits: those get the mapped reason, not GM's "too large" line;
 * - `code: "person_required"` on a 403 from a tab that isn't connected as the
 *   person (no person token, or one from an earlier launch): reconnecting
 *   fixes it, so it keeps Try again instead of holding the copy.
 * These go through a real Response, readFailureBody, requestError and the
 * project client (asProjectError), so a hop that dropped a field fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const fetch = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: fetch,
}));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(), holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
// The store's other requests are stubbed; recoverProject is the real one.
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), openProject: vi.fn(),
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { recoverProject, type ProjectList, type ProjectSnapshot, type SavedProject } from '../src/lib/projects';
import { projectRetryOffer, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { setProjectContext } from '../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const snapshot: ProjectSnapshot = { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null };
const BILLING = "zz1: Changing how a Krea node is billed (_kreaAuth) is the person's call, so it needs their OK.";

describe('the recover answer, through the real project client', () => {
  beforeEach(() => fetch.mockReset());

  it.each([['projects'], ['storage']] as const)('a 413 naming limit %s keeps it on the error', async (limit) => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit }));
    await expect(recoverProject('alpha', snapshot, 'rec-1', GRAPH_PARAMS_VERSION))
      .rejects.toMatchObject({ status: 413, storageLimit: limit, detail: 'Project limit reached' });
  });

  it('a 413 with no limit leaves storageLimit null', async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project snapshot exceeds the 16 MiB limit' }));
    await expect(recoverProject('alpha', snapshot, 'rec-1', GRAPH_PARAMS_VERSION))
      .rejects.toMatchObject({ status: 413, storageLimit: null });
  });

  it('a 403 carries its code; one with none has a null code', async () => {
    fetch.mockResolvedValueOnce(json(403, { detail: BILLING, code: 'person_required' }));
    await expect(recoverProject('alpha', snapshot, 'rec-1', GRAPH_PARAMS_VERSION))
      .rejects.toMatchObject({ status: 403, code: 'person_required', detail: BILLING });
    fetch.mockResolvedValueOnce(json(403, { detail: BILLING }));
    await expect(recoverProject('alpha', snapshot, 'rec-1', GRAPH_PARAMS_VERSION))
      .rejects.toMatchObject({ status: 403, code: null });
  });
});

function project(id = 'alpha'): SavedProject {
  return {
    id, name: id === 'alpha' ? 'Glass campaign' : id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
const listing = (): ProjectList => ({ projects: [summary('alpha')], trash: [], activeProjectId: 'alpha',
  workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION });
const state = () => useProjectStore.getState();

describe('the held edits screen, from a real answer', () => {
  const initial = useProjectStore.getState();
  let unsubscribe: (() => void) | null = null;
  beforeEach(async () => {
    vi.clearAllMocks();
    fetch.mockReset();
    resetProjectStoreForTests();
    setProjectContext(null);
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
    useProjectStore.setState(initial, true);
    vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
    vi.mocked(projects.listProjects).mockResolvedValue(listing());
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
    vi.mocked(projects.saveProject).mockImplementation(async (id, saved) => ({ ...project(id), snapshot: saved }));
    await useProjectStore.getState().initialize();
    unsubscribe = subscribeProjectAutosave();
    // Another window took the project while this tab held an unsaved edit.
    const [node] = useGraphStore.getState().nodes;
    useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value: 'Unsaved edit' } } }] });
    for (const handler of [...socket.handlers]) handler({ type: 'graphSync', workspaceRevision: 'rev-b',
      paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true } as unknown as ExecutionEvent);
  });
  afterEach(() => { unsubscribe?.(); unsubscribe = null; setProjectContext(null); });

  it("the store's project limit is the mapped reason, not \"too large\"", async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit: 'projects' }));
    await useProjectStore.getState().retry();
    expect(String(fetch.mock.calls[0][0])).toBe('/api/projects/recover');
    expect(state().unsavedEdits).toEqual({ reason: 'Project limit reached. Download them so nothing is lost, or continue without them.' });
    expect(state().unsavedEdits?.reason).not.toContain('too large for Nebula to save');
  });

  it('a copy that is itself too large gets GM\'s line', async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project snapshot exceeds the 16 MiB limit' }));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toEqual({ reason:
      'These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them.' });
  });

  // PR #204 r6 (GM r7 2): no Try again while the reason is "not connected"; the promote retries.
  it('person_required shows no Try again and holds nothing', async () => {
    fetch.mockResolvedValueOnce(json(403, { detail: BILLING, code: 'person_required' }));
    await useProjectStore.getState().retry();
    expect(state().unsavedEdits).toBeNull();
    expect(projectRetryOffer(state())).toBe('none');
  });
});
