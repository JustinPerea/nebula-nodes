import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { clampRunHistoryPosition } from '../src/lib/panelPosition';
import {
  WORLD_LABS_CANCELLATION_NOTE,
  WORLD_LABS_FAILURE_NOTE,
  WORLD_LABS_RECOVERY_READY_NOTE,
  type RunRecord,
} from '../src/lib/runHistory';

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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('disables repeated cancellation while the backend is still stopping', () => {
    const cancelExecution = vi.fn(async () => undefined);
    useGraphStore.setState({
      runHistory: [record('running-world', 'running')],
      isExecuting: true,
      isCancelling: true,
      cancelExecution,
    });

    render(<RunHistoryPanel />);

    const stop = screen.getByRole('button', { name: 'Cancel running execution' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
    expect(stop).toHaveAttribute('title', 'Waiting for execution to stop safely');
    fireEvent.click(stop);
    expect(cancelExecution).not.toHaveBeenCalled();
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

  it.each([
    {
      label: 'an active execution',
      state: { isExecuting: true },
      title: 'Wait for the active run to finish',
    },
    {
      label: 'a saved provider recovery',
      state: {
        providerRecoveries: [{
          runId: 'paid-run',
          nodeId: 'world-node',
          resumeOperationId: 'operation-saved',
          existingWorldId: null,
          durable: true,
        }],
      },
      title: 'Resolve World Labs safety records before clearing history',
    },
    {
      label: 'an ambiguous provider start',
      state: {
        providerStartAmbiguities: [{
          runId: 'paid-run',
          nodeId: 'world-node',
          kind: 'worldlabs-environment' as const,
          message: 'Check Marble before retrying.',
          durable: true,
        }],
      },
      title: 'Resolve World Labs safety records before clearing history',
    },
  ])('disables Clear while $label owns safety state', ({ state, title }) => {
    const clearRunHistory = vi.fn();
    useGraphStore.setState({
      runHistory: [record('complete-run', 'complete')],
      isExecuting: false,
      providerRecoveries: [],
      providerStartAmbiguities: [],
      clearRunHistory,
      ...state,
    });

    render(<RunHistoryPanel />);
    const clear = screen.getByRole('button', { name: 'Clear run history' });
    expect(clear).toBeDisabled();
    expect(clear).toHaveAttribute('title', title);
    fireEvent.click(clear);
    expect(clearRunHistory).not.toHaveBeenCalled();
  });

  it('renders each exact World Labs recovery safeguard', () => {
    useGraphStore.setState({
      providerRecoveries: [
        {
          runId: 'generation-run',
          nodeId: 'world-environment',
          resumeOperationId: 'operation-accepted',
          existingWorldId: null,
          durable: true,
        },
        {
          runId: 'completed-run',
          nodeId: 'world-export',
          resumeOperationId: null,
          existingWorldId: 'world-complete',
          durable: true,
        },
      ],
    });

    render(<RunHistoryPanel />);

    const safeguards = screen.getByRole('region', {
      name: 'World Labs recovery safeguards',
    });
    expect(safeguards).toHaveTextContent('world-environment · operation operation-accepted');
    expect(safeguards).toHaveTextContent('world-export · world world-complete');
    expect(screen.getByTitle('world-environment · operation-accepted')).toBeInTheDocument();
    expect(screen.getByTitle('world-export · world-complete')).toBeInTheDocument();
  });

  it('requires explicit Marble confirmation before deleting an exact recovery', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteProviderRecovery = vi.fn(async () => undefined);
    useGraphStore.setState({
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: 'world-node',
        resumeOperationId: 'operation-saved',
        existingWorldId: null,
        durable: true,
      }],
      deleteProviderRecovery,
    });

    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', {
      name: 'Checked Marble; forget recovery for world-node',
    }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('world-node');
    expect(confirm.mock.calls[0][0]).toContain('Only continue after checking Marble');
    expect(confirm.mock.calls[0][0]).toContain('future fresh paid request');
    expect(deleteProviderRecovery).not.toHaveBeenCalled();
    expect(screen.getByTitle('world-node · operation-saved')).toBeInTheDocument();
  });

  it('deletes only the confirmed recovery row through the exact store action', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const retained = {
      runId: 'other-run',
      nodeId: 'other-world',
      resumeOperationId: null,
      existingWorldId: 'world-retained',
      durable: true,
    };
    const deleteProviderRecovery = vi.fn(async (runId: string, nodeId: string) => {
      useGraphStore.setState((state) => ({
        providerRecoveries: state.providerRecoveries.filter(
          (checkpoint) => checkpoint.runId !== runId || checkpoint.nodeId !== nodeId,
        ),
      }));
    });
    useGraphStore.setState({
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: 'world-node',
        resumeOperationId: 'operation-saved',
        existingWorldId: null,
        durable: true,
      }, retained],
      deleteProviderRecovery,
    });

    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', {
      name: 'Checked Marble; forget recovery for world-node',
    }));

    await waitFor(() => expect(deleteProviderRecovery).toHaveBeenCalledWith(
      'paid-run',
      'world-node',
    ));
    await waitFor(() => {
      expect(screen.queryByTitle('world-node · operation-saved')).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('other-world · world-retained')).toBeInTheDocument();
  });

  it('keeps a recovery visible and reports the failure when exact deletion fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const deleteProviderRecovery = vi.fn().mockRejectedValue(
      new Error('Backend still has an active provider task.'),
    );
    useGraphStore.setState({
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: 'world-node',
        resumeOperationId: 'operation-saved',
        existingWorldId: null,
        durable: true,
      }],
      deleteProviderRecovery,
    });

    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', {
      name: 'Checked Marble; forget recovery for world-node',
    }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      'Backend still has an active provider task.',
    ));
    expect(screen.getByTitle('world-node · operation-saved')).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Checked Marble; forget recovery for world-node',
    })).toBeEnabled();
  });

  it('shows the World Labs local-only cancellation caveat in the run record', () => {
    const cancelled = record('world-cancelled', 'cancelled');
    cancelled.snapshot.nodes[0].definitionId = 'worldlabs-environment';
    useGraphStore.setState({
      runHistory: [{
        ...cancelled,
        statusNote: WORLD_LABS_CANCELLATION_NOTE,
      }],
      isExecuting: false,
    });

    render(<RunHistoryPanel />);
    expect(screen.getByText(WORLD_LABS_CANCELLATION_NOTE)).toBeInTheDocument();
    expect(screen.getByText(
      'Recovery ID unavailable — check Marble and the live World node',
    )).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rerun/ })).not.toBeInTheDocument();
  });

  it('suppresses saved retry for a failed World Labs run', () => {
    const failed = record('world-failed', 'failed');
    failed.snapshot.nodes[0].definitionId = 'worldlabs-world-export';
    failed.snapshot.nodes[0].params = { format: 'glb' };
    useGraphStore.setState({
      runHistory: [{ ...failed, statusNote: WORLD_LABS_FAILURE_NOTE }],
      isExecuting: false,
    });

    render(<RunHistoryPanel />);
    expect(screen.getByText(WORLD_LABS_FAILURE_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry failed/ })).not.toBeInTheDocument();
  });

  it('offers Recover for an exact journal-hydrated World Labs snapshot', () => {
    const rerunHistoryRecord = vi.fn(async () => undefined);
    const recovered = record('world-recovered', 'cancelled', 'world');
    recovered.snapshot.nodes[0] = {
      id: 'world',
      definitionId: 'worldlabs-environment',
      params: { existing_world_id: 'world_already_accepted' },
      outputs: {},
    };
    recovered.statusNote = WORLD_LABS_RECOVERY_READY_NOTE;
    useGraphStore.setState({
      runHistory: [recovered],
      isExecuting: false,
      rerunHistoryRecord,
    });

    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Recover Single node run' }));
    expect(rerunHistoryRecord).toHaveBeenCalledWith('world-recovered');
  });
});

describe('RunHistoryPanel positioning', () => {
  it('clamps stale positions so the full panel and its header remain reachable', () => {
    expect(clampRunHistoryPosition({ x: -340, y: -20 }, { width: 1280, height: 720 }))
      .toEqual({ x: 8, y: 8 });
    expect(clampRunHistoryPosition({ x: 2000, y: 2000 }, { width: 1280, height: 720 }))
      .toEqual({ x: 996, y: 664 });
    expect(clampRunHistoryPosition({ x: 100, y: 60 }, { width: 250, height: 500 }))
      .toEqual({ x: 8, y: 60 });
  });
});
