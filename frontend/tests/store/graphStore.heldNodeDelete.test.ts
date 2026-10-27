import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Error copy round 3b, item 5. The canvas keeps a node that holds World
 * Labs state (a recovery record or an unconfirmed start) when the person
 * presses Delete, without a request. Before that round it said nothing
 * ("Dropped without a word"); since, it says why once per press, in the
 * canvas's own short notice (undoNotice). Nothing is sent, and the wires
 * stay (the Delete key's guard runs before React Flow removes anything).
 *
 * Round 4 (GM - Design, "TRIMS to one line at 560 px"): "Couldn't delete the
 * node. It's waiting on World Labs. Check Marble, then unlock it." The forget
 * form: "Couldn't delete the node. It's waiting on World Labs. Check Marble,
 * then forget it in Run History." If that still wraps, use "Couldn't delete
 * it." as the heading. "Couldn't delete {n} nodes. One is waiting on World
 * Labs. Check Marble, then unlock it." (and the same forget form). Measured
 * live at 560 px in the canvas notice's 12 px font, both forget forms wrap
 * with the full heading, so they take the short one ("Couldn't delete it.",
 * and for several nodes "Couldn't delete them.", the same pattern).
 *
 * Round 4b (GM - Design, on #181): every line for several nodes starts
 * "Couldn't delete them.", and every forget form for several nodes ends
 * "Check Marble, then use Run History." ("Use the same tail on every forget
 * form that wraps, so the single-node one stays as it is."). With one of
 * several held, the unlock line is GM's newest: "Couldn't delete them. One
 * is waiting on World Labs. Check Marble, then unlock it." (it replaces the
 * counted "Couldn't delete {n} nodes. One is waiting …").
 * 2026-10-24 (GM): with every node held, the forget form ends "Check Marble
 * and Run History." ("Couldn't delete them. They're waiting on World Labs.
 * Check Marble and Run History."); the other forget forms keep the tail.
 *
 * The backend's delete refusal says its own, longer line to the person
 * (backend/main.py _paid_state_person, pinned equal to lib/worldLabsWaiting.ts
 * by backend/tests/test_error_copy_round3b.py) and the specific text to
 * agents; both stay word for word. When the canvas didn't know the node was
 * held, the person still reads GM's line: the canvas maps the backend's
 * line to it.
 */

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

const { useGraphStore } = await import('../../src/store/graphStore');

// The backend's lines for the person, word for word (lib/worldLabsWaiting.ts;
// GM's round 13 wording of PR #114).
const BACKEND_UNLOCK = 'A World Labs run needs your check first. Use the notice at the top of the screen.';
const BACKEND_FORGET = '“World Labs Environment” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.';
const BACKEND_ACTIVE = 'A World Labs run is still starting. Try again in a moment.';
// GM's lines (round 4, and round 4b for several nodes).
// GM, round 15 of PR #114: one node reads "Couldn't delete “<node>”. <reason
// line>", the shared World Labs reason with the button named.
const ONE_UNLOCK = "Couldn't delete “World”. A World Labs run needs your check first. Use the notice at the top of the screen.";
const ONE_FORGET = "Couldn't delete “World”. “World” has a saved World Labs recovery ID. Check the run in Marble, then use Forget ID in Run History.";
const SOME_UNLOCK = "Couldn't delete them. One is waiting on World Labs. Check Marble, then unlock it.";
const SOME_FORGET = "Couldn't delete them. One is waiting on World Labs. Check Marble, then use Run History.";
const ALL_UNLOCK = "Couldn't delete them. They're waiting on World Labs. Check Marble, then unlock them.";
// GM - Design, 2026-10-24: every node held, forget form.
const ALL_FORGET = "Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.";
const MANY_UNLOCK = (held: number) => `Couldn't delete them. ${held} are waiting on World Labs. Check Marble, then unlock them.`;
const MANY_FORGET = (held: number) => `Couldn't delete them. ${held} are waiting on World Labs. Check Marble, then use Run History.`;

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
    expect(notice()).toMatchObject({ text: ONE_FORGET, offer: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it('an unconfirmed start: the notice names the status bar\'s unlock', () => {
    useGraphStore.setState({ providerRecoveries: [], providerStartAmbiguities: [ambiguity('n1')] } as never);
    useGraphStore.getState().deleteNode('n1');
    expect(notice()?.text).toBe(ONE_UNLOCK);
  });

  it('the Delete key\'s guard (Canvas onBeforeDelete) refuses before React Flow removes the node or its wires, once per press', () => {
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    const first = notice();
    expect(first?.text).toBe(ONE_FORGET);
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    expect(notice()?.id).not.toBe(first?.id); // a second press says it again
    expect(useGraphStore.getState().allowCanvasDelete(['n2'])).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('several selected nodes, one held: one notice for the press, in the canvas-wide words', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(SOME_FORGET);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('several selected nodes, one with an unconfirmed start: GM\'s "Couldn\'t delete them. One is waiting …"', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true), node('n3', true)],
      providerRecoveries: [], providerStartAmbiguities: [ambiguity('n2')] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(SOME_UNLOCK);
    expect(useGraphStore.getState().nodes).toHaveLength(3);
  });

  it('an unconfirmed start wins over a recovery record (the backend\'s order)', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)],
      providerRecoveries: [recovery('n1')], providerStartAmbiguities: [ambiguity('n2')] } as never);
    useGraphStore.getState().deleteSelected();
    // Both are held, so "They're waiting"; the unlock form wins for both.
    expect(notice()?.text).toBe(ALL_UNLOCK);
  });

  it('one of two held, an unconfirmed start: "One is waiting … unlock it"', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)],
      providerRecoveries: [], providerStartAmbiguities: [ambiguity('n2')] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(SOME_UNLOCK);
  });

  it('two selected, both with recovery records: the line says they\'re both waiting', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)],
      providerRecoveries: [recovery('n1'), recovery('n2')] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(ALL_FORGET);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('two selected, both unconfirmed: the unlock line says they\'re both waiting', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)],
      providerRecoveries: [], providerStartAmbiguities: [ambiguity('n1'), ambiguity('n2')] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(ALL_UNLOCK);
  });

  it('three selected, two held: the line counts the held ones', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true), node('n3', true)],
      providerRecoveries: [recovery('n1')], providerStartAmbiguities: [ambiguity('n3')] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(MANY_UNLOCK(2));
    useGraphStore.setState({ providerRecoveries: [recovery('n1'), recovery('n3')], providerStartAmbiguities: [] } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()?.text).toBe(MANY_FORGET(2));
  });

  it('a generation\'s delete that reaches a held node says so too', () => {
    useGraphStore.getState().deleteGeneration(['n1']);
    expect(notice()?.text).toBe(ONE_FORGET);
  });
});

describe('the backend refuses a Delete the canvas didn\'t know was held', () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' } });
  const refuseWith = (...details: string[]) => {
    let call = 0;
    fetchMock.mockImplementation(async () => json({ detail: details[Math.min(call++, details.length - 1)] }, 409));
  };
  beforeEach(() => {
    useGraphStore.setState({ providerRecoveries: [], providerStartAmbiguities: [] } as never);
  });

  it('the backend\'s forget line: the person reads GM\'s', async () => {
    refuseWith(BACKEND_FORGET);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(ONE_FORGET));
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
  });

  it('the backend\'s unlock line: the person reads GM\'s', async () => {
    refuseWith(BACKEND_UNLOCK);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(ONE_UNLOCK));
  });

  it('two refused, both held: one line that says they\'re both waiting', async () => {
    refuseWith(BACKEND_FORGET, BACKEND_UNLOCK);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(ALL_UNLOCK));
  });

  it('two refused with the same held line: counted before the duplicate is dropped', async () => {
    refuseWith(BACKEND_FORGET, BACKEND_FORGET);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(ALL_FORGET));
  });

  it('two held among three refused: GM\'s sentence counts them, the other reason kept', async () => {
    useGraphStore.setState({ nodes: [node('n1'), node('n2'), node('n3')] } as never);
    refuseWith(BACKEND_UNLOCK, BACKEND_UNLOCK, 'A run is going.');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }, { id: 'n3', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(
      "Couldn't delete them. 2 are waiting on World Labs. Check Marble, then unlock them. A run is going."));
  });

  it('a held node and another reason: GM\'s sentence for the held one, the other reason kept', async () => {
    refuseWith(BACKEND_UNLOCK, 'A run is going.');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(
      "Couldn't delete them. One is waiting on World Labs. Check Marble, then unlock it. A run is going."));
  });

  it('a held node\'s forget line among another reason: the same tail as the store\'s', async () => {
    refuseWith(BACKEND_FORGET, 'A run is going.');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(
      "Couldn't delete them. One is waiting on World Labs. Check Marble, then use Run History. A run is going."));
  });

  it('two refused for other reasons only: the counted heading stays', async () => {
    refuseWith('A run is going.');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe("Couldn't delete 2 nodes. A run is going."));
  });

  it('a line GM didn\'t trim (a run still going) stays the backend\'s', async () => {
    refuseWith(BACKEND_ACTIVE);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await vi.waitFor(() => expect(notice()?.text).toBe(`Couldn't delete the node. ${BACKEND_ACTIVE}`));
  });
});
