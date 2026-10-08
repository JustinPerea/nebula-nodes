import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { NodeData } from '../../src/types';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
function node(id: string, selected = false): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, selected,
    data: { label: id, definitionId: 'text', params: {}, state: 'idle', outputs: {} } };
}

describe('Canvas focus handoff', () => {
  beforeEach(() => {
    useUIStore.setState(initialUI, true);
    useGraphStore.setState({ nodes: [node('motion'), node('earlier', true)],
      edges: [{ id: 'kept-connection', source: 'earlier', target: 'motion', selected: true }],
      isExecuting: false, undoStack: [], redoStack: [], runHistory: [] });
  });
  afterEach(() => {
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('returns from Cinema and selects only the requested live node without changing its data', () => {
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'scene', createSessionId: 'kept-session' });
    const beforeNodes = useGraphStore.getState().nodes;
    const graphData = beforeNodes.map(({ data }) => data);
    useUIStore.getState().requestCanvasNodeFocus('motion');
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('canvas');
    expect(state.cinemaEditorNodeId).toBeNull();
    expect(state.selectedNodeId).toBe('motion');
    expect(state.createSessionId).toBe('kept-session');
    expect(state.canvasFocusRequest).toMatchObject({ nodeId: 'motion' });
    expect(state.canvasFocusRequest?.requestId).toBeTruthy();
    expect(useGraphStore.getState().nodes.map(({ id, selected }) => ({ id, selected })))
      .toEqual([{ id: 'motion', selected: true }, { id: 'earlier', selected: false }]);
    expect(useGraphStore.getState().nodes.map(({ data }) => data)).toEqual(graphData);
    expect(useGraphStore.getState().edges).toEqual([
      { id: 'kept-connection', source: 'earlier', target: 'motion', selected: false },
    ]);
    expect(useGraphStore.getState().runHistory).toEqual([]);
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('does not let completion of an older request clear a newer target', () => {
    useUIStore.getState().requestCanvasNodeFocus('motion');
    const oldRequest = useUIStore.getState().canvasFocusRequest!;
    const oldRevision = useUIStore.getState().canvasFocusRevision;
    useUIStore.getState().requestCanvasNodeFocus('earlier');
    const current = useUIStore.getState().canvasFocusRequest!;
    expect(current.requestId).not.toBe(oldRequest.requestId);
    useUIStore.getState().clearCanvasNodeFocus(oldRequest.requestId);
    expect(useUIStore.getState().canvasFocusRequest).toBe(current);
    expect(useUIStore.getState().canvasFocusRevision).toBe(oldRevision + 1);
    useUIStore.getState().clearCanvasNodeFocus(current.requestId);
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(useUIStore.getState().canvasFocusRevision).toBe(oldRevision + 1);
    expect(useUIStore.getState().selectedNodeId).toBe('earlier');
  });

  it('mints a fresh request even when the target was already focused', () => {
    useUIStore.getState().requestCanvasNodeFocus('motion');
    const first = useUIStore.getState().canvasFocusRequest!;
    useUIStore.getState().clearCanvasNodeFocus(first.requestId);
    useUIStore.getState().requestCanvasNodeFocus('motion');
    expect(useUIStore.getState().canvasFocusRequest?.requestId).not.toBe(first.requestId);
  });

  it('ignores an empty handoff and never stores focus in local storage', () => {
    const storageBefore = { ...localStorage };
    const revision = useUIStore.getState().canvasFocusRevision;
    useUIStore.getState().requestCanvasNodeFocus('  ');
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(useUIStore.getState().canvasFocusRevision).toBe(revision);
    useUIStore.getState().requestCanvasNodeFocus('motion');
    expect({ ...localStorage }).toEqual(storageBefore);
  });
});
