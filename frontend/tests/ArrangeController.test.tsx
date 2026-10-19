import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

import { ArrangeController } from '../src/components/canvas/ArrangeController';
import { selectMeasuring, useArrangeStore } from '../src/store/arrangeStore';
import { useGraphStore } from '../src/store/graphStore';

beforeEach(() => {
  vi.useFakeTimers();
  useGraphStore.setState({ nodes: [], edges: [] });
  useArrangeStore.setState({ pending: [], finished: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ArrangeController', () => {
  it('stops waiting for nodes that never reach this canvas, so culling comes back', () => {
    render(<ReactFlowProvider><ArrangeController /></ReactFlowProvider>);
    act(() => {
      useArrangeStore.getState().setPending([{ id: 'a_1', nodeIds: ['n7'], direction: 'right', gap: 120 }]);
    });
    expect(selectMeasuring(useArrangeStore.getState())).toBe(true);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(useArrangeStore.getState().finished).toEqual([]);

    act(() => { vi.advanceTimersByTime(11000); });
    expect(useArrangeStore.getState().finished).toEqual(['a_1']);
    expect(selectMeasuring(useArrangeStore.getState())).toBe(false);
  });
});
