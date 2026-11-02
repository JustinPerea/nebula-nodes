import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * Every person move of a node is marked for the agent cursors (GM - Design,
 * PR #211 review 4, item 2): a cursor resting on it rides it, never flies.
 * A drag's drop and a keyboard nudge (React Flow's position change with
 * dragging false), Arrange and Arrange selected; never a sync.
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

describe('the person moves a node', () => {
  it('a keyboard nudge (a position change, not dragging) marks where they put it', () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 20, y: 0 }, dragging: false }]);
    expect(position('n1')).toEqual({ x: 20, y: 0 });
    expect(placedByPerson('n1', { x: 20, y: 0 })).toBe(true);
    expect(placedByPerson('n1', { x: 0, y: 0 })).toBe(false);
    expect(placedByPerson('n2', position('n2'))).toBe(false);
  });

  it('a drag marks its drop, not its frames (React Flow marks those as dragging)', () => {
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 5, y: 0 }, dragging: true }]);
    expect(placedByPerson('n1', { x: 5, y: 0 })).toBe(false);
    useGraphStore.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 9, y: 0 }, dragging: false }]);
    expect(placedByPerson('n1', { x: 9, y: 0 })).toBe(true);
  });

  it('Arrange and Arrange selected mark every node they place', () => {
    useGraphStore.getState().autoLayout();
    for (const id of ['n1', 'n2']) expect(placedByPerson(id, position(id))).toBe(true);
    forgetPersonPlaced();
    useGraphStore.setState({ nodes: [node('n1', 0, 0, { selected: true }), node('n2', 400, 300, { selected: true })] });
    useGraphStore.getState().autoLayoutSelected();
    for (const id of ['n1', 'n2']) expect(placedByPerson(id, position(id))).toBe(true);
  });

  it("a sync's move isn't the person's", () => {
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [node('n1', 0, 0), node('n2', 300, 300)],
      edges: [], empty: false, moved: ['n2'] } as unknown as ExecutionEvent;
    for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
    expect(position('n2')).toEqual({ x: 300, y: 300 });
    expect(placedByPerson('n2', position('n2'))).toBe(false);
  });

  it('remembers a bounded number of nodes, the oldest going first', () => {
    for (let i = 0; i <= PERSON_NODE_MOVES_MAX; i += 1) notePersonPlaced({ [`k${i}`]: { x: i, y: 0 } });
    expect(placedByPerson('k0', { x: 0, y: 0 })).toBe(false);
    expect(placedByPerson(`k${PERSON_NODE_MOVES_MAX}`, { x: PERSON_NODE_MOVES_MAX, y: 0 })).toBe(true);
  });
});
