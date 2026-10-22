import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  apiFetch: async () => new Response('{}', { status: 200 }),
}));

import { useGraphStore } from '../../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../../src/lib/savedParamsUpgrades';
import { noticeHoldMs } from '../../src/lib/canvasNoticeHold';
import { CanvasUndoNotice, UNDO_NOTICE_MS } from '../../src/components/canvas/CanvasUndoNotice';

const node = (id: string): Node<NodeData> => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} },
});

function agentAdds(id: string) {
  const event = {
    type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, empty: false, edges: [],
    nodes: [...useGraphStore.getState().nodes, node(id)],
    edit: { actor: { kind: 'agent', name: 'Claude', color: '#d97757' } },
  } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

beforeEach(() => {
  useGraphStore.setState({ nodes: [node('n1')], edges: [], undoStack: [], redoStack: [], undoNotice: null,
    isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CanvasUndoNotice', () => {
  it('names the agent, undoes its edit, then offers Redo', () => {
    render(<CanvasUndoNotice />);
    act(() => agentAdds('n2'));
    expect(screen.getByRole('status')).toHaveTextContent('Claude changed the canvas');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(screen.getByRole('status')).toHaveTextContent('Undid Claude’s edit');

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('hides Undo once another step is on top, so it never undoes something else', () => {
    render(<CanvasUndoNotice />);
    act(() => agentAdds('n2'));
    const notice = useGraphStore.getState().undoNotice;
    act(() => useGraphStore.getState().updateNodeData('n1', { params: { value: 'typed' } }));
    act(() => useGraphStore.setState({ undoNotice: notice }));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('goes away on its own', () => {
    vi.useFakeTimers();
    render(<CanvasUndoNotice />);
    act(() => agentAdds('n2'));
    act(() => { vi.advanceTimersByTime(UNDO_NOTICE_MS + 10); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  // Error copy round 3b (live check): a refusal line ("Couldn't delete the node. This node is still
  // waiting on World Labs. …") was cut to one line with an ellipsis, so the step it names ("use
  // “Checked Marble — forget” in Run History") never showed, and it left after 6 seconds, before
  // it could be read. A notice with no button wraps and stays up for its reading time.
  it('a refusal line wraps (no one-line ellipsis) and stays up long enough to read', () => {
    vi.useFakeTimers();
    const text = "Couldn't delete the node. This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it.";
    render(<CanvasUndoNotice />);
    act(() => useGraphStore.setState({ undoNotice: { id: 9001, text, offer: null } }));
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.getByRole('status').classList.contains('canvas-undo-notice--message')).toBe(true);
    const hold = noticeHoldMs(text, null);
    expect(hold).toBeGreaterThan(UNDO_NOTICE_MS);
    act(() => { vi.advanceTimersByTime(UNDO_NOTICE_MS + 10); });
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(hold); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a short line with a button keeps the 6-second hold and its one line', () => {
    render(<CanvasUndoNotice />);
    act(() => agentAdds('n2'));
    expect(screen.getByRole('status').classList.contains('canvas-undo-notice--message')).toBe(false);
    expect(noticeHoldMs('Claude changed the canvas', 'undo')).toBe(UNDO_NOTICE_MS);
  });
});
