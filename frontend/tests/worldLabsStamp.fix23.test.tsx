import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/**
 * Round 23 of PR #199, 2a and GM r36 item 1 (review 21 LOW-1 and LU LOW-2):
 * Nebula stamps each World Labs record, when it writes it, with the project
 * whose canvas the run is on and the node's type. The person's tab gets
 * those places on its own channels (the graphSync's person form, a frame
 * after a verified hello); agents never do.
 * - A record whose stamp names the open project is this project's, even
 *   when its run left the history (the hydrate writes its ID into the
 *   node; Delete refuses it on the canvas with its own line).
 * - The tab never releases a hold on its own: a node it can't place goes
 *   to the backend's guard, which holds unless the stamp names another
 *   project.
 * - One type rule: the stored type ("World Labs Environment", "World Labs
 *   Export"), else a World ID's Environment, else "A World Labs node".
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

const { useGraphStore, providerRecordIsThisProjects, providerRecoveryPlacesFrom } = await import('../src/store/graphStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useUIStore } = await import('../src/store/uiStore');
const { setProjectContext } = await import('../src/lib/projectContext');
const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
const { NODE_DEFINITIONS } = await import('../src/constants/nodeDefinitions');
const { RunHistoryPanel } = await import('../src/components/panels/RunHistoryPanel');
const {
  OTHER_PROJECT_WORLD_LABS_NODE, WORLD_LABS_NODE_TYPE_NAMES, heldRecordName, otherWorldLabsNode,
  providerRecoveryPlaceKey, recordNodeType,
} = await import('../src/lib/worldLabsWaiting');
const { frames } = await import('./helpers/frames');

const DELTA_FORGET = "Couldn't delete “Delta world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.";

const world = (id: string, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Delta world', definitionId: 'worldlabs-environment', params, state: 'idle', outputs: {} },
});
const run = (id: string) => ({ id, trigger: 'graph', startedAt: 1, status: 'complete', snapshot: { nodes: [], edges: [] } });
const record = (runId: string, nodeId = 'n1', id = 'op-1', worldId = false) => ({
  runId, nodeId, resumeOperationId: worldId ? null : id, existingWorldId: worldId ? id : null, durable: true });
const place = (runId: string, projectId: string | null, nodeType: string | null = null, nodeId = 'n1') =>
  ({ runId, nodeId, projectId, nodeType });
const set = (state: Record<string, unknown>) => useGraphStore.setState(state as never);
const send = (event: unknown) => { for (const handler of socket.handlers) handler(event); };
const places = () => useGraphStore.getState().providerRecoveryPlaces;
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;

const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PROJECT = { ...useProjectStore.getState() };
const clock = frames();

beforeEach(() => {
  clock.install();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  useGraphStore.getState().resetExecution();
  useUIStore.setState(INITIAL_UI, true);
  useProjectStore.setState(INITIAL_PROJECT, true);
  setProjectContext({ id: 'delta', revision: 'r1' });
  set({ nodes: [world('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false, undoNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], providerRecoveryPlaces: {}, runHistory: [run('run-delta')] });
});
afterEach(() => {
  clock.uninstall();
  setProjectContext(null);
});

describe('the places reach the store only from the person’s payloads', () => {
  it('the frame after a verified hello sets them', () => {
    send({ type: 'providerRecoveryPlaces', places: [place('run-alpha', 'alpha', 'worldlabs-world-export')] });
    expect(places()).toEqual({ [providerRecoveryPlaceKey('run-alpha', 'n1')]: { projectId: 'alpha', nodeType: 'worldlabs-world-export' } });
  });

  it('a graphSync’s person form replaces them; an agents’ form (no places) keeps them', () => {
    const sync = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, empty: false, edges: [], nodes: [world('n1')] };
    send({ ...sync, providerRecoveryPlaces: [place('run-alpha', 'alpha')] });
    expect(Object.keys(places())).toEqual([providerRecoveryPlaceKey('run-alpha', 'n1')]);
    const before = places();
    send(sync);
    expect(places()).toBe(before);
    send({ ...sync, providerRecoveryPlaces: [place('run-alpha', 'alpha')] });
    expect(places()).toBe(before); // the same places: the same object, no re-render
    send({ ...sync, providerRecoveryPlaces: [] });
    expect(places()).toEqual({});
  });

  it('malformed entries are left out; a gone project reads as unknown', () => {
    expect(providerRecoveryPlacesFrom('nope')).toBeNull();
    expect(providerRecoveryPlacesFrom([null, { runId: 1 }, { runId: 'r', nodeId: 'n', projectId: '', nodeType: 7 }]))
      .toEqual({ [providerRecoveryPlaceKey('r', 'n')]: { projectId: null, nodeType: null } });
  });
});

describe('a stamp naming the open project makes a record this project’s', () => {
  it('even with its run gone from the history: Delete refuses it on the canvas with its own line', () => {
    set({ runHistory: [], providerRecoveries: [record('run-capped')],
      providerRecoveryPlaces: providerRecoveryPlacesFrom([place('run-capped', 'delta')]) });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()).toBe(DELTA_FORGET);
  });

  it('the hydrate writes its ID into the node', () => {
    set({ runHistory: [], providerRecoveryPlaces: providerRecoveryPlacesFrom([place('run-capped', 'delta')]) });
    useGraphStore.getState().hydrateProviderRecoveries([record('run-capped', 'n1', 'op-own')]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ resume_operation_id: 'op-own' });
  });

  it('a stamp naming another project, or none, is not this project’s: the tab leaves the delete to the backend', () => {
    for (const stamped of [place('run-alpha', 'alpha'), null]) {
      set({ nodes: [world('n1')], runHistory: [], providerRecoveries: [record('run-alpha')], undoNotice: null,
        providerRecoveryPlaces: providerRecoveryPlacesFrom(stamped ? [stamped] : []) });
      expect(providerRecordIsThisProjects(useGraphStore.getState(), 'run-alpha', 'n1')).toBe(false);
      expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
      expect(notice()).toBeNull();
    }
  });

  it('the stamp is per node: the same run’s record for another node isn’t placed by it', () => {
    set({ runHistory: [], providerRecoveryPlaces: providerRecoveryPlacesFrom([place('run-x', 'delta', null, 'n2')]) });
    expect(providerRecordIsThisProjects(useGraphStore.getState(), 'run-x', 'n1')).toBe(false);
    expect(providerRecordIsThisProjects(useGraphStore.getState(), 'run-x', 'n2')).toBe(true);
    // An ambiguity has no stamp: without a node id the stamp is never read.
    expect(providerRecordIsThisProjects(useGraphStore.getState(), 'run-x')).toBe(false);
  });

  it('with no project open, no stamp places anything', () => {
    setProjectContext(null);
    set({ runHistory: [], providerRecoveryPlaces: providerRecoveryPlacesFrom([place('run-x', 'delta')]) });
    expect(providerRecordIsThisProjects(useGraphStore.getState(), 'run-x', 'n1')).toBe(false);
  });
});

describe('the one type rule (GM r36 item 1)', () => {
  it('names the type the record knows, and the names are the node picker’s', () => {
    expect(recordNodeType('worldlabs-world-export', null)).toBe('World Labs Export');
    expect(recordNodeType('worldlabs-environment', null)).toBe('World Labs Environment');
    expect(recordNodeType(null, 'world-1')).toBe('World Labs Environment');
    expect(recordNodeType('worldlabs-world-export', 'world-1')).toBe('World Labs Export');
    expect(recordNodeType(null, null)).toBeNull();
    expect(recordNodeType('text-input', null)).toBeNull();
    for (const [definitionId, name] of Object.entries(WORLD_LABS_NODE_TYPE_NAMES)) {
      expect(NODE_DEFINITIONS[definitionId]?.displayName).toBe(name);
    }
    expect(otherWorldLabsNode('World Labs Export')).toBe('A World Labs Export node from another project');
    expect(otherWorldLabsNode(null, true)).toBe('a World Labs node from another project');
    expect(OTHER_PROJECT_WORLD_LABS_NODE).toBe('A World Labs node from another project');
    expect(heldRecordName([], 'n1', false, null, false, 'World Labs Environment'))
      .toBe('A World Labs Environment node from another project');
  });

  const rows = () => within(screen.getByRole('region', { name: 'World Labs recovery safeguards' }))
    .getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent);

  it('Run History’s placeholder: Export by its stored type, Environment by its World ID, else a World Labs node', () => {
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    useProjectStore.setState({ openHold: null, activeProject: { id: 'delta', name: 'Delta' } as never });
    set({ nodes: [], providerRecoveries: [record('run-a', 'n1', 'op-a'), record('run-b', 'n2', 'world-b', true),
      record('run-c', 'n3', 'op-c')],
    providerRecoveryPlaces: providerRecoveryPlacesFrom([place('run-a', 'alpha', 'worldlabs-world-export')]) });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual([
      'A World Labs Export node from another project · Operation ID op-a',
      'A World Labs Environment node from another project · World ID world-b',
      'A World Labs node from another project · Operation ID op-c',
    ]);
    expect(screen.getByRole('button', { name: 'Forget the recovery ID for a World Labs Export node from another project' }))
      .toBeTruthy();
  });
});
