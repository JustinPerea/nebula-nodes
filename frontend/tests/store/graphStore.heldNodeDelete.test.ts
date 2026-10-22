import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Error copy round 3b, item 5. The canvas keeps a node that holds World
 * Labs state (a recovery record or an unconfirmed start) when the person
 * presses Delete, without a request. Before this round it said nothing
 * ("Dropped without a word"). Now it says why once per press, in the
 * canvas's own short notice (undoNotice): "Couldn't delete the node." and the
 * same per-state line the backend's delete refusal gives
 * (backend/main.py _paid_state_person; pinned equal by
 * backend/tests/test_error_copy_round3b.py). Nothing is sent, and the wires
 * stay (the Delete key's guard runs before React Flow removes anything).
 */

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

const { useGraphStore } = await import('../../src/store/graphStore');

const UNLOCK = 'This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it.';
const FORGET = 'This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it.';
const SOME_FORGET = 'A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again.';

const node = (id: string, selected = false) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label: 'World', definitionId: 'worldlabs-world', params: {}, state: 'idle', outputs: {} },
});
const recovery = (nodeId: string) => ({ runId: 'r1', nodeId, resumeOperationId: 'op-1', existingWorldId: null, durable: true });
const ambiguity = (nodeId: string) => ({ runId: 'r2', nodeId, kind: 'worldlabs-world', message: 'Check Marble.', durable: true });
const notice = () => useGraphStore.getState().undoNotice;

beforeEach(() => {
  fetchMock.mockReset();
  alertMock.mockClear();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n1'), node('n2')], edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    undoStack: [], redoStack: [], isExecuting: false, undoNotice: null,
    providerRecoveries: [recovery('n1')], providerStartAmbiguities: [] } as never);
});

describe('Delete on a node that holds World Labs state', () => {
  it('a recovery record: the notice names Run History\'s forget; nothing is sent, the node and its wire stay', () => {
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    expect(notice()).toMatchObject({ text: `Couldn't delete the node. ${FORGET}`, offer: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it('an unconfirmed start: the notice names the status bar\'s unlock', () => {
    useGraphStore.setState({ providerRecoveries: [], providerStartAmbiguities: [ambiguity('n1')] } as never);
    useGraphStore.getState().deleteNode('n1');
    expect(notice()?.text).toBe(`Couldn't delete the node. ${UNLOCK}`);
  });

  it('the Delete key\'s guard (Canvas onBeforeDelete) refuses before React Flow removes the node or its wires, once per press', () => {
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    const first = notice();
    expect(first?.text).toBe(`Couldn't delete the node. ${FORGET}`);
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()?.id).not.toBe(first?.id); // a second press says it again
    expect(useGraphStore.getState().allowCanvasDelete(['n2'])).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('several selected nodes, one held: one notice for the press, in the canvas-wide words', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(`Couldn't delete 2 nodes. ${SOME_FORGET}`);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('a generation\'s delete that reaches a held node says so too', () => {
    useGraphStore.getState().deleteGeneration(['n1']);
    expect(notice()?.text).toBe(`Couldn't delete the node. ${FORGET}`);
  });
});
