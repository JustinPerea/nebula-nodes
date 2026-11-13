import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 22 of PR #199, 2a (review 20 RV LOW-2, LU "on main, scope only"):
 * World Labs records belong to a project. The backend's journals list every
 * project's records with no project on them, and node ids repeat across
 * projects, so the tab never matches a record to a node by node id alone. A
 * record holds a node only when it is this project's (its run is in the open
 * canvas's run history, or a run this tab started here is still going), or
 * when the project can't be known and the node's own settings hold the
 * record's ID. An unconfirmed start carries no ID: it holds a node only when
 * its run is this project's.
 *
 * LR1: Delta's own n1 is a Text Input the person renamed "Delta brief";
 * Alpha's n1 has a recovery record (op-alpha-probe) that Delta's run history
 * doesn't name.
 */

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    connect: vi.fn(), disconnect: vi.fn(), setViewing: () => {}, notePersonAct: () => {},
    subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {}; }),
    subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {}; }),
  },
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { useGraphStore } = await import('../src/store/graphStore');
const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
const { noticeSpy } = await import('./helpers/noticeSpy');

const UNSAFE_CLONE = "Couldn't duplicate a paid World Labs node. Add a new one from the Nodes rail instead.";
const DELTA_FORGET = "Couldn't delete “Delta brief”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.";
const WORLD_FORGET = "Couldn't delete “Delta world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.";
const WORLD_UNLOCK = "Couldn't delete “Delta world”. A World Labs run needs your check first. Use the notice at the top of the screen.";

const text = (id: string, label = 'Delta brief', selected = false) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label, definitionId: 'text-input', params: { value: 'Delta' }, state: 'idle', outputs: {} },
});
const world = (id: string, params: Record<string, unknown> = {}, selected = false) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label: 'Delta world', definitionId: 'worldlabs-environment', params, state: 'idle', outputs: {} },
});
const run = (id: string) => ({ id, trigger: 'graph', startedAt: 1, status: 'complete', snapshot: { nodes: [], edges: [] } });
const alphaRecord = (nodeId = 'n1', id = 'op-alpha-probe') => ({
  runId: 'run-alpha', nodeId, resumeOperationId: id, existingWorldId: null, durable: true,
});
const alphaAmbiguity = (nodeId = 'n1') => ({
  runId: 'run-alpha', nodeId, kind: 'worldlabs-environment', message: 'Check Marble.', durable: true,
});
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);
const set = (state: Record<string, unknown>) => useGraphStore.setState(state as never);

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  useGraphStore.getState().resetExecution();
  set({ nodes: [text('n1')], edges: [], undoStack: [], redoStack: [], clipboard: null, isExecuting: false,
    undoNotice: null, messageNotice: null, providerRecoveries: [alphaRecord()], providerStartAmbiguities: [],
    runHistory: [run('run-delta')] });
});

describe('LR1: Alpha’s n1 record never holds Delta’s n1', () => {
  it('Delete of Delta’s renamed n1 goes', () => {
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
    useGraphStore.getState().deleteNode('n1');
    expect(notice()).not.toBe(DELTA_FORGET);
    expect(ids()).toEqual([]);
  });

  it('…but a record of Delta’s own run holds it (the guard stays)', () => {
    set({ runHistory: [run('run-delta'), run('run-alpha')] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()).toBe(DELTA_FORGET);
    expect(ids()).toEqual(['n1']);
  });

  it('Duplicate of Delta’s renamed n1 goes, with its own settings', () => {
    const said = noticeSpy();
    useGraphStore.getState().duplicateNode('n1');
    expect(said).not.toHaveBeenCalledWith(UNSAFE_CLONE);
    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].data.params).toEqual({ value: 'Delta' });
  });

  it('Copy and Paste of Delta’s renamed n1 go', () => {
    const said = noticeSpy();
    set({ nodes: [text('n1', 'Delta brief', true)] });
    useGraphStore.getState().copySelected();
    expect(useGraphStore.getState().pasteClipboard()).toHaveLength(1);
    expect(said).not.toHaveBeenCalledWith(UNSAFE_CLONE);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('a record of Delta’s own run on a Text Input still refuses the Duplicate (the guard stays)', () => {
    const said = noticeSpy();
    set({ runHistory: [run('run-alpha')] });
    useGraphStore.getState().duplicateNode('n1');
    expect(said).toHaveBeenCalledWith(UNSAFE_CLONE);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });
});

describe('a record the tab can’t place holds a node only when the node holds its ID', () => {
  it('a World node whose Resume Operation ID is the record’s: Delete refused, Duplicate copies that ID', () => {
    set({ nodes: [world('n1', { resume_operation_id: 'op-alpha-probe' })] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()).toBe(WORLD_FORGET);
    useGraphStore.getState().duplicateNode('n1');
    expect(useGraphStore.getState().nodes.map((node) => node.data.params)).toEqual([
      { resume_operation_id: 'op-alpha-probe' }, { resume_operation_id: 'op-alpha-probe' }]);
  });

  it('a World node whose World ID is the record’s holds it too (the Environment’s second field)', () => {
    set({ nodes: [world('n1', { existing_world_id: 'world-alpha' })],
      providerRecoveries: [{ runId: 'run-alpha', nodeId: 'n1', resumeOperationId: null, existingWorldId: 'world-alpha', durable: true }] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
  });

  it('an Export’s World ID field isn’t one paramsWithProviderRecovery writes: it holds nothing', () => {
    set({ nodes: [{ ...world('n1', { existing_world_id: 'world-alpha' }), data: { ...world('n1').data,
      definitionId: 'worldlabs-world-export', params: { existing_world_id: 'world-alpha' } } }],
      providerRecoveries: [{ runId: 'run-alpha', nodeId: 'n1', resumeOperationId: null, existingWorldId: 'world-alpha', durable: true }] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
  });

  it('a World node holding its own, different ID: Delete goes; Duplicate keeps its own ID', () => {
    set({ nodes: [world('n1', { resume_operation_id: 'op-delta' })] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
    useGraphStore.getState().duplicateNode('n1');
    expect(useGraphStore.getState().nodes.map((node) => node.data.params)).toEqual([
      { resume_operation_id: 'op-delta' }, { resume_operation_id: 'op-delta' }]);
  });
});

describe('an unconfirmed start holds a node only when its run is this project’s', () => {
  it('Alpha’s ambiguity on n1: Delta’s World n1 deletes and duplicates', () => {
    const said = noticeSpy();
    set({ nodes: [world('n1', { resume_operation_id: 'op-delta' })], providerRecoveries: [],
      providerStartAmbiguities: [alphaAmbiguity()] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
    useGraphStore.getState().duplicateNode('n1');
    expect(said).not.toHaveBeenCalledWith(UNSAFE_CLONE);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('this project’s ambiguity holds it: the unlock line, and no clone', () => {
    const said = noticeSpy();
    set({ nodes: [world('n1', { resume_operation_id: 'op-delta' })], providerRecoveries: [],
      providerStartAmbiguities: [alphaAmbiguity()], runHistory: [run('run-alpha')] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()).toBe(WORLD_UNLOCK);
    useGraphStore.getState().duplicateNode('n1');
    expect(said).toHaveBeenCalledWith(UNSAFE_CLONE);
  });

  it('a recovery of this project’s and another project’s ambiguity on the same node: the forget line, not the unlock', () => {
    set({ nodes: [world('n1')], providerRecoveries: [{ ...alphaRecord(), runId: 'run-delta' }],
      providerStartAmbiguities: [alphaAmbiguity()] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()).toBe(WORLD_FORGET);
  });
});

describe('P7: a hydrate never writes another project’s ID into this project’s node', () => {
  it('Delta’s World n1 keeps its own Resume Operation ID and never gets Alpha’s', () => {
    set({ nodes: [world('n1', { resume_operation_id: 'op-delta' })], providerRecoveries: [] });
    useGraphStore.getState().hydrateProviderRecoveries([alphaRecord('n1', 'op-alpha')]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ resume_operation_id: 'op-delta' });
  });

  it('a blank World n1 stays blank', () => {
    set({ nodes: [world('n1')], providerRecoveries: [] });
    useGraphStore.getState().hydrateProviderRecoveries([alphaRecord('n1', 'op-alpha')]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({});
  });

  it('a sync carrying Alpha’s record never writes it either', () => {
    set({ nodes: [], providerRecoveries: [alphaRecord('n1', 'op-alpha')] });
    for (const handler of socket.handlers) handler({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION,
      empty: false, edges: [], nodes: [world('n1', { resume_operation_id: 'op-delta' })] });
    expect(useGraphStore.getState().nodes.map((node) => node.data.params)).toEqual([{ resume_operation_id: 'op-delta' }]);
  });

  it('…while Delta’s own run’s record still writes its ID (the reload path stays)', () => {
    set({ nodes: [world('n1')], providerRecoveries: [], runHistory: [run('run-alpha')] });
    useGraphStore.getState().hydrateProviderRecoveries([alphaRecord('n1', 'op-own')]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ resume_operation_id: 'op-own' });
  });

  it('a later record of another project for the same node id never wins over this project’s', () => {
    set({ nodes: [world('n1')], providerRecoveries: [], runHistory: [run('run-delta')] });
    useGraphStore.getState().hydrateProviderRecoveries([
      { ...alphaRecord('n1', 'op-own'), runId: 'run-delta' }, alphaRecord('n1', 'op-alpha')]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ resume_operation_id: 'op-own' });
  });
});

describe('the renumber collision', () => {
  it('a tab-local node renumbered to n2, the node id of Alpha’s record, stays deletable', () => {
    set({ nodes: [text('n1'), text('local-uuid', 'Second prompt')], providerRecoveries: [alphaRecord('n2')] });
    expect(useGraphStore.getState().allowCanvasDelete(['local-uuid'])).toBe(true);
    for (const handler of socket.handlers) handler({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION,
      empty: false, edges: [], renumbered: { 'local-uuid': 'n2' },
      nodes: [text('n1'), text('n2', 'Second prompt')] });
    expect(ids().sort()).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().allowCanvasDelete(['n2'])).toBe(true);
    useGraphStore.getState().deleteNode('n2');
    expect(ids()).toEqual(['n1']);
  });
});
