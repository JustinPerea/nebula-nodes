import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The follow-up to PR #114 (GM's r18 rulings, review 17):
 * - GM: the project store's 507 (its storage case) gets its own line, by
 *   node or for the whole run.
 * - GM: never count 1. A single item is always named; counts start at 2 for
 *   kept nodes and settings mixed, and at 4 otherwise. G2: "settings" when
 *   every counted item is a setting, "changes" only when mixed.
 * - Review 17 L2 (probe Z2): a Cinema shot's merge, marked as run output,
 *   doesn't stop Undo of an Accept from putting the scene back.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { useGraphStore } = await import('../../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { acceptUndoLine } = await import('../../src/lib/canvasUndo');
const { PROJECT_LIST_REASON } = await import('../../src/lib/api');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const node = (id: string, params: Record<string, unknown>, label = id, definitionId = 'text-input') => ({ id,
  type: 'model-node', position: { x: 0, y: 0 }, data: { label, definitionId, params, state: 'idle', outputs: {} } });
const notices: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  notices.length = 0;
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n1', { value: 'saved' }, 'Brief')], edges: [], undoStack: [], redoStack: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (line: string) => { if (line) notices.push(line); } } as never);
});
afterEach(() => { vi.useRealTimers(); });

describe('GM: the project store\'s 507 (storage case)', () => {
  const refuseWith = (path: string, body: Record<string, unknown>) => fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).endsWith(path)) return json(body, 507);
    return json({});
  });
  const STORE = { detail: 'Project catalog could not be read; the existing file was preserved', code: 'project_store' };

  it('the reason, exactly', () => {
    expect(PROJECT_LIST_REASON).toBe("Nebula can't read its project list, so nothing was started. Check that the drive Nebula saves to is connected and has space, then try again.");
  });

  it('one node: named, with the storage line', async () => {
    refuseWith('/api/execute-node', STORE);
    await useGraphStore.getState().executeNode('n1');
    expect(notices).toEqual([
      "Couldn't run “Brief”. Nebula can't read its project list, so nothing was started. Check that the drive Nebula saves to is connected and has space, then try again.",
    ]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('no single node: the run\'s own heading', async () => {
    refuseWith('/api/execute', STORE);
    await useGraphStore.getState().executeGraph();
    expect(notices).toEqual([
      "Couldn't start the run. Nebula can't read its project list, so nothing was started. Check that the drive Nebula saves to is connected and has space, then try again.",
    ]);
  });

  it('a 507 with no store named keeps the general line', async () => {
    refuseWith('/api/execute-node', { detail: 'Insufficient storage' });
    await useGraphStore.getState().executeNode('n1');
    expect(notices.join(' ')).not.toContain('project list');
  });
});

describe('GM: never count 1 (and G2\'s settings-or-changes rule)', () => {
  const agent = { kind: 'agent' as const, name: 'Codex' };
  const you = { kind: 'you' as const };
  const unknown = { kind: 'unknown' as const };

  it('a single setting is named, whoever changed it', () => {
    expect(acceptUndoLine([{ node: 'Brief', settings: ['Text'] }], unknown, false))
      .toBe('Undid the proposal except “Text” for “Brief”. It was changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Brief', settings: ['Text'] }], agent, false))
      .toBe('Undid the proposal except “Text” for “Brief”. Codex changed it after you accepted.');
    expect(acceptUndoLine([{ node: 'Brief', settings: ['Text'] }], you, false))
      .toBe('Undid the proposal except “Text” for “Brief”. You changed it in another window after you accepted.');
  });

  it('a single kept node is named, whoever changed it', () => {
    expect(acceptUndoLine([{ node: 'Kept', settings: ['Name'], wholeNode: true }], unknown, false))
      .toBe('Undid the proposal except “Kept”. It was changed after you accepted.');
  });

  it('settings across nodes: named up to 3, counted from 4, "settings"', () => {
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B'] }], agent, false))
      .toBe('Undid the proposal except “A” for “Hero” and “B” for “Logo”. Codex changed them after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C'] }], unknown, false))
      .toBe('Undid the proposal except “A” and “B” for “Hero”, and “C” for “Logo”. They were changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C', 'D'] }], agent, false))
      .toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B'] }, { node: 'Logo', settings: ['C', 'D'] }], unknown, false))
      .toBe('Undid the proposal except 4 settings changed after you accepted.');
    // A rename counts as the setting "Name".
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Name', 'A'] }, { node: 'Logo', settings: ['B', 'C'] }], agent, false))
      .toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
  });

  it('kept nodes and settings mixed: counted from 2, "changes"', () => {
    const mixed = [{ node: 'Kept', settings: ['Name'], wholeNode: true }, { node: 'Other', settings: ['x'] }];
    expect(acceptUndoLine(mixed, agent, false)).toBe('Undid the proposal except 2 changes Codex made after you accepted.');
    expect(acceptUndoLine(mixed, unknown, false)).toBe('Undid the proposal except 2 changes made after you accepted.');
    expect(acceptUndoLine([...mixed, { node: 'Third', settings: ['y'] }], agent, false))
      .toBe('Undid the proposal except 3 changes Codex made after you accepted.');
  });

  it('kept nodes only: named up to 3', () => {
    expect(acceptUndoLine([{ node: 'A', settings: ['Name'], wholeNode: true }, { node: 'B', settings: ['x'], wholeNode: true }], agent, false))
      .toBe('Undid the proposal except “A” and “B”. Codex changed them after you accepted.');
  });

  it('no line ever counts 1', () => {
    const sources = [agent, you, unknown, { kind: 'agent' as const, name: null }];
    const shapes = [
      [{ node: 'A', settings: ['x'] }],
      [{ node: 'A', settings: ['x'], wholeNode: true }],
      [{ node: 'A', settings: ['x'], wholeNode: true }, { node: 'B', settings: ['y'] }],
      [{ node: 'A', settings: ['x'] }, { node: 'B', settings: ['y'] }],
    ];
    for (const source of sources) for (const shape of shapes) for (const nothing of [false, true]) {
      expect(acceptUndoLine(shape, source, nothing)).not.toMatch(/\b1 (change|setting|node)/);
    }
  });
});

describe('Review 17 L2 (probe Z2): a Cinema shot\'s merge is run output', () => {
  async function acceptWith(reply: Record<string, unknown>, during?: () => void) {
    useCanvasProposalsStore.getState().open({ id: 'p', status: 'open', agent: { id: 'a', name: 'Codex', color: '#fff', verified: false },
      note: 'x', createdAt: Date.now(), expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] } as never, 'key', {});
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/accept')) { during?.(); return json(reply); }
      return json({});
    });
    await useCanvasProposalsStore.getState().accept('p');
  }
  const own = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
    edit: { tab: TAB_ID, actor: { kind: 'person' } } });

  it('Accept changed the scene, a shot ran (the backend marks its merge runParams), Undo puts the prompt back with no line', async () => {
    const scene = (prompt: string, output?: string) => ({ shots: [{ id: 's1', prompt, ...(output ? { output } : {}) }] });
    useGraphStore.setState({ nodes: [node('n1', { scene: scene('a') }, 'Scene', 'cinema-scene')], undoStack: [] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [node('n1', { scene: scene('b') }, 'Scene', 'cinema-scene')], runNodeIds: [], idMap: {} },
      () => own([node('n1', { scene: scene('b') }, 'Scene', 'cinema-scene')]));
    await sleep(10);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], runParams: 'shot-run',
      nodes: [node('n1', { scene: scene('b', '/api/outputs/shot1.png') }, 'Scene', 'cinema-scene')] });
    await sleep(10);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await sleep(30);
    const bodies = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore'))
      .map(([, init]) => String((init as RequestInit).body));
    expect(bodies.join(' ')).toContain('"prompt":"a"');
    expect((useGraphStore.getState().undoNotice as { text?: string } | null)?.text ?? '').not.toContain('changed');
  });
});
