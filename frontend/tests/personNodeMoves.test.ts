import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * The cause decides, not the position (GM - Design, PR #211 review 5, item
 * 5). The person's own moves of a node are recorded for the agent cursors,
 * which ride them at 0 px: a drag's drop and a keyboard nudge (React Flow's
 * position change with dragging false), Arrange and Arrange selected, and
 * their own undo and redo. Anyone else's move (a sync: an agent, another
 * tab) isn't, even when it puts the node back on the person's spot. A new
 * canvas forgets the record.
 */
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: () => Promise.resolve(new Response('{}', { status: 200 })),
}));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { PERSON_NODE_MOVES_MAX, forgetPersonPlaced, notePersonPlaced, placedByPerson } from '../src/lib/personNodeMoves';

const node = (id: string, x: number, y: number, extra: Partial<Node<NodeData>> = {}): Node<NodeData> => ({
  id, type: 'model-node', position: { x, y }, ...extra,
  data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} },
});
const position = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)?.position;

beforeEach(() => {
  forgetPersonPlaced();
  useGraphStore.setState({ nodes: [node('n1', 0, 0), node('n2', 0, 300)], edges: [], undoStack: [], redoStack: [] });
});
afterEach(() => forgetPersonPlaced());

const sync = (nodes: Node<NodeData>[], moved: string[]) => {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges: [], empty: false, moved } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
};
const placed = (id: string) => placedByPerson(id, position(id));
/** The person's layout PUT has answered: a sync no longer keeps their spot. */
const layoutSaved = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the person moves a node', () => {
  it('a keyboard nudge (a position change, not dragging) is recorded with the move itself', () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    expect(position('n1')).toEqual({ x: 20, y: 0 });
    expect(placed('n1')).toBe(true);
    // The move, not the spot: the same numbers in another object are not it.
    expect(placedByPerson('n1', { x: 20, y: 0 })).toBe(false);
    expect(placed('n2')).toBe(false);
  });

  it('a drag records its drop, not its frames (React Flow marks those as dragging)', () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 5, y: 0 }, dragging: true }]);
    expect(placed('n1')).toBe(false);
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 9, y: 0 }, dragging: false }]);
    expect(placed('n1')).toBe(true);
  });

  it('Arrange and Arrange selected record every node they place', () => {
    useGraphStore.getState().autoLayout();
    for (const id of ['n1', 'n2']) expect(placed(id)).toBe(true);
    forgetPersonPlaced();
    useGraphStore.setState({ nodes: [node('n1', 0, 0, { selected: true }), node('n2', 400, 300, { selected: true })] });
    useGraphStore.getState().autoLayoutSelected();
    for (const id of ['n1', 'n2']) expect(placed(id)).toBe(true);
  });

  it("the person's own undo and redo are theirs: each records the nodes it moves", () => {
    useGraphStore.setState({ nodes: [node('n1', 0, 0), node('n2', 400, 900)] });
    useGraphStore.getState().autoLayout();
    const arranged = position('n2')!;
    expect(arranged).not.toEqual({ x: 400, y: 900 });
    forgetPersonPlaced();
    useGraphStore.getState().undo();
    expect(position('n2')).toEqual({ x: 400, y: 900 });
    expect(placed('n2')).toBe(true);
    forgetPersonPlaced();
    useGraphStore.getState().redo();
    expect(position('n2')).toEqual(arranged);
    expect(placed('n2')).toBe(true);
  });

  it("a sync's move isn't the person's, even back onto the person's spot (review 5, LOW-2)", async () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    expect(placed('n1')).toBe(true);
    await layoutSaved();
    sync([node('n1', 300, 0), node('n2', 0, 300)], ['n1']);
    expect(position('n1')).toEqual({ x: 300, y: 0 });
    expect(placed('n1')).toBe(false);
    sync([node('n1', 20, 0), node('n2', 0, 300)], ['n1']);
    expect(position('n1')).toEqual({ x: 20, y: 0 });
    expect(placed('n1')).toBe(false);
  });

  it('a sync along y only is not the person\'s either', async () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n2', position: { x: 0, y: 320 }, dragging: false }]);
    await layoutSaved();
    sync([node('n1', 0, 0), node('n2', 0, 360)], ['n2']);
    expect(position('n2')).toEqual({ x: 0, y: 360 });
    expect(placed('n2')).toBe(false);
  });

  it('a new canvas (loadGraph) forgets the record', () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    const spot = position('n1')!;
    useGraphStore.getState().loadGraph([{ ...node('n1', 0, 0), position: spot }], []);
    expect(position('n1')).toBe(spot);
    expect(placed('n1')).toBe(false);
  });

  // Review 6, LOW-3: each replacement forgets the record itself. New nodes
  // couldn't match it anyway, so these ask about the very move recorded.
  it('a replacing sync (graphReplaced) forgets the record', async () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    const spot = position('n1')!;
    expect(placedByPerson('n1', spot)).toBe(true);
    await layoutSaved();
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [node('n1', 20, 0)], edges: [], empty: false, graphReplaced: true } as unknown as ExecutionEvent;
    for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
    expect(placedByPerson('n1', spot)).toBe(false);
  });

  it("an agent's clear (a cleared sync) forgets the record", async () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    const spot = position('n1')!;
    await layoutSaved();
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true, cleared: true,
      edit: { id: 'ed_clear', actor: { kind: 'agent', name: 'Codex' } } } as unknown as ExecutionEvent;
    for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
    expect(placedByPerson('n1', spot)).toBe(false);
  });

  it('opening a project (loadProjectGraph) forgets the record', async () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    const spot = position('n1')!;
    await layoutSaved();
    expect(useGraphStore.getState().loadProjectGraph([{ ...node('n1', 0, 0), position: spot }], [], [])).toBe(true);
    expect(placedByPerson('n1', spot)).toBe(false);
  });

  it('an undo that moves a node along y only is recorded too', () => {
    useGraphStore.setState({ nodes: [node('n1', 0, 0), node('n2', 0, 900)] });
    useGraphStore.getState().autoLayout();
    const arranged = position('n2')!;
    expect(arranged.x).toBe(0);
    expect(arranged.y).not.toBe(900);
    forgetPersonPlaced();
    useGraphStore.getState().undo();
    expect(position('n2')).toEqual({ x: 0, y: 900 });
    expect(placed('n2')).toBe(true);
  });

  it('remembers a bounded number of nodes, the least recently moved going first', () => {
    const spots = Array.from({ length: PERSON_NODE_MOVES_MAX + 1 }, (_, i) => ({ x: i, y: 0 }));
    notePersonPlaced({ k0: spots[0] });
    notePersonPlaced({ k1: spots[1] });
    notePersonPlaced({ k0: spots[0] }); // moved again: now the newest
    for (let i = 2; i <= PERSON_NODE_MOVES_MAX; i += 1) notePersonPlaced({ [`k${i}`]: spots[i] });
    expect(placedByPerson('k1', spots[1])).toBe(false);
    expect(placedByPerson('k0', spots[0])).toBe(true);
    expect(placedByPerson(`k${PERSON_NODE_MOVES_MAX}`, spots[PERSON_NODE_MOVES_MAX])).toBe(true);
  });
});
