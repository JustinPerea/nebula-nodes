import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { RunRecord } from '../src/lib/runHistory';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

function record(id: string, status: RunRecord['status'], targetNodeId?: string): RunRecord {
  return {
    id,
    status,
    trigger: targetNodeId ? 'node' : 'graph',
    startedAt: Date.now(),
    targetNodeId,
    snapshot: {
      nodes: [{ id: targetNodeId ?? 'n1', definitionId: 'text-input', params: {}, outputs: {} }],
      edges: [],
    },
  };
}

describe('RunHistoryPanel replay actions', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
    useUIStore.setState((state) => ({
      panels: {
        ...state.panels,
        history: { ...state.panels.history, visible: true },
      },
    }));
  });

  it('routes complete and failed records to the correct exact-replay actions', () => {
    const rerunHistoryRecord = vi.fn(async () => undefined);
    const retryFailedRun = vi.fn(async () => undefined);
    useGraphStore.setState({
      runHistory: [record('failed-run', 'failed', 'target-node'), record('complete-run', 'complete')],
      isExecuting: false,
      rerunHistoryRecord,
      retryFailedRun,
    });

    render(<RunHistoryPanel />);
    expect(screen.getByText(/target target-node/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed Single node run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rerun Full graph' }));

    expect(retryFailedRun).toHaveBeenCalledWith('failed-run');
    expect(rerunHistoryRecord).toHaveBeenCalledWith('complete-run');
  });

  it('disables every replay while another run is active', () => {
    useGraphStore.setState({
      runHistory: [record('failed-run', 'failed'), record('complete-run', 'complete')],
      isExecuting: true,
    });

    render(<RunHistoryPanel />);

    expect(screen.getByRole('button', { name: 'Retry failed Full graph run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rerun Full graph' })).toBeDisabled();
  });

  it('clears persisted history from the header action', () => {
    const clearRunHistory = vi.fn();
    useGraphStore.setState({
      runHistory: [record('complete-run', 'complete')],
      clearRunHistory,
    });

    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear run history' }));
    expect(clearRunHistory).toHaveBeenCalledOnce();
  });
});
