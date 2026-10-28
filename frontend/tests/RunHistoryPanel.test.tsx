import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { ForgetRecoveryConfirm } from '../src/components/panels/ForgetRecoveryConfirm';
import { forgetNodeLabelsForTests } from '../src/lib/lastNodeLabels';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { clampRunHistoryPosition } from '../src/lib/panelPosition';
import {
  WORLD_LABS_CANCELLATION_NOTE,
  WORLD_LABS_FAILURE_NOTE,
  WORLD_LABS_RECOVERY_READY_NOTE,
  type RunRecord,
} from '../src/lib/runHistory';
import { noticeSpy } from './helpers/noticeSpy';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';

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
    forgetNodeLabelsForTests();
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

    const stop = screen.getByRole('button', { name: 'Stop the run' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
    expect(stop).toHaveAttribute('title', 'Stopping the run…');
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

  it('labels the two-node seven-item fanout as execution steps instead of eight canvas nodes', () => {
    const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'];
    const saved = record('colors-run', 'complete');
    saved.nodesExecuted = 8;
    saved.snapshot.nodes = [
      { id: 'colors', definitionId: 'batch', params: { items_text: colors.join('\n') }, outputs: {} },
      { id: 'preview', definitionId: 'preview', params: {}, outputs: {} },
    ];
    saved.batchOutputs = {
      colors: colors.map((color) => ({ set: { type: 'Text', value: color } })),
      preview: colors.map((color) => ({ input: { type: 'Text', value: color } })),
    };
    useGraphStore.setState({ runHistory: [saved], isExecuting: false });

    render(<RunHistoryPanel />);
    expect(screen.getByText(/8 steps/)).toBeInTheDocument();
    expect(screen.queryByText(/8 nodes/)).not.toBeInTheDocument();
    expect(screen.getByText('Batch results · 14')).toBeInTheDocument();
  });

  it.each([1, 2])('keeps the ordinary %i-node execution count label', (count) => {
    useGraphStore.setState({ runHistory: [{ ...record('ordinary', 'complete'), nodesExecuted: count }],
      isExecuting: false });
    render(<RunHistoryPanel />);
    expect(screen.getByText(new RegExp(`${count} node${count === 1 ? '' : 's'}`))).toBeInTheDocument();
    expect(screen.queryByText(/\d steps?/)).not.toBeInTheDocument();
  });

  it.each([
    {
      label: 'an active execution',
      state: { isExecuting: true },
      title: 'Wait for the run to finish first.',
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
      title: "Can't clear while a World Labs recovery ID is saved.",
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
      title: "Can't clear while a World Labs recovery ID is saved.",
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
    // Error copy round 3c (GM): "World Labs run" where it said "paid start".
    expect(safeguards).toHaveTextContent('These IDs prevent an accidental second World Labs run.');
    // GM, round 14 of PR #114: rows are named by node, "Operation ID" /
    // "World ID", the ID in mono. Neither node is on the canvas or was seen.
    expect(safeguards).toHaveTextContent('A removed World Labs node · Operation ID operation-accepted');
    expect(safeguards).toHaveTextContent('A removed World Labs node · World ID world-complete');
    expect(within(safeguards).getByText('operation-accepted').tagName).toBe('CODE');
    expect(screen.getByTitle('A removed World Labs node · Operation ID operation-accepted')).toBeInTheDocument();
    expect(screen.getByTitle('A removed World Labs node · World ID world-complete')).toBeInTheDocument();
  });

  it('"Forget ID" asks in the app\'s own dialog first; Cancel forgets nothing (GM, round 13 of PR #114)', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const deleteProviderRecovery = vi.fn(async () => undefined);
    useGraphStore.setState({
      nodes: [{ id: 'world-node', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Harbor world', definitionId: 'worldlabs-environment', params: {}, state: 'idle', outputs: {} } }] as never,
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
    // GM, round 14: the button's name says which ID it forgets; the row
    // ("“Harbor world” · Operation ID operation-saved") stays its description.
    const row = screen.getByRole('button', { name: 'Forget the recovery ID for “Harbor world”' });
    expect(row.textContent).toBe('Forget ID');
    expect(row).toHaveAccessibleDescription('“Harbor world” · Operation ID operation-saved');
    fireEvent.click(row);

    const dialog = screen.getByRole('alertdialog', { name: 'Forget the recovery ID for “Harbor world”?' });
    expect(dialog).toHaveAccessibleDescription(
      "Only do this after you've checked the run in Marble. Without the ID, Nebula can't stop you from paying for the same run twice.");
    // On the page body, through ModalPortal (the round 21 merge with #195).
    expect(dialog.closest('.modal-portal')?.parentElement).toBe(document.body);
    // GM, round 14: Cancel on the left, the action on the right, in the
    // destructive style (the trash's red text, never orange primary).
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Forget ID']);
    expect(within(dialog).getByRole('button', { name: 'Forget ID' })).toHaveClass('prompt-dialog__destructive');
    expect(within(dialog).getByRole('button', { name: 'Forget ID' })).not.toHaveClass('prompt-dialog__danger');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteProviderRecovery).not.toHaveBeenCalled();
    expect(screen.getByTitle('“Harbor world” · Operation ID operation-saved')).toBeInTheDocument();
  });

  it('Escape is Cancel, and Tab stays inside the dialog', () => {
    const deleteProviderRecovery = vi.fn(async () => undefined);
    useGraphStore.setState({
      providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node', resumeOperationId: 'operation-saved',
        existingWorldId: null, durable: true }],
      deleteProviderRecovery,
    });
    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget the recovery ID for a removed World Labs node' }));
    // Not on the canvas and never seen with a label (GM, round 14).
    const dialog = screen.getByRole('alertdialog', { name: 'Forget the recovery ID for a removed World Labs node?' });
    const [cancel, forgetButton] = within(dialog).getAllByRole('button');
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(forgetButton).toHaveFocus();
    fireEvent.keyDown(forgetButton, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteProviderRecovery).not.toHaveBeenCalled();
  });

  it('deletes only the confirmed recovery row through the exact store action', async () => {
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
    fireEvent.click(screen.getAllByRole('button', { name: /^Forget the recovery ID for / })[0]);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Forget ID' }));

    await waitFor(() => expect(deleteProviderRecovery).toHaveBeenCalledWith(
      'paid-run',
      'world-node',
    ));
    await waitFor(() => {
      expect(screen.queryByTitle('A removed World Labs node · Operation ID operation-saved')).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('A removed World Labs node · World ID world-retained')).toBeInTheDocument();
  });

  it('keeps a recovery visible and reports the failure when exact deletion fails', async () => {
    const alert = noticeSpy();
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
    fireEvent.click(screen.getAllByRole('button', { name: /^Forget the recovery ID for / })[0]);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Forget ID' }));

    // Error copy round 3b: an error that isn't a request's never shows its
    // own message; it says GM's general line under the button's heading.
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Couldn't forget the recovery safeguard. Try again, or reload if it keeps happening.",
    ));
    expect(screen.getByTitle('A removed World Labs node · Operation ID operation-saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forget the recovery ID for a removed World Labs node' })).toBeEnabled();
  });

  it('a node that left the canvas goes by its last label (GM, round 14)', () => {
    const world = { id: 'world-node', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Harbor world', definitionId: 'worldlabs-environment', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [world] as never });
    useGraphStore.setState({ nodes: [] as never,
      providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node', resumeOperationId: 'op-1', existingWorldId: null, durable: true }] });
    render(<RunHistoryPanel />);
    const row = screen.getByRole('button', { name: 'Forget the recovery ID for “Harbor world”, no longer on the canvas' });
    expect(row).toHaveAccessibleDescription('“Harbor world”, no longer on the canvas · Operation ID op-1');
    fireEvent.click(row);
    expect(screen.getByRole('alertdialog', { name: 'Forget the recovery ID for “Harbor world”, no longer on the canvas?' })).toBeTruthy();
  });

  // Review 13, L5 (live L8, probes U2/U3).
  it('the dialog owns Escape however focus got there (a backdrop click), and Run History stays open', () => {
    const deleteProviderRecovery = vi.fn(async () => undefined);
    useGraphStore.setState({ providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node',
      resumeOperationId: 'op-1', existingWorldId: null, durable: true }], deleteProviderRecovery });
    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Forget the recovery ID for / }));
    const backdrop = screen.getByRole('alertdialog').parentElement!;
    // The backdrop keeps focus in the dialog.
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useUIStore.getState().panels.history.visible).toBe(true);
    expect(deleteProviderRecovery).not.toHaveBeenCalled();
  });

  it('Tab from outside the card brings focus back into it', () => {
    useGraphStore.setState({ providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node',
      resumeOperationId: 'op-1', existingWorldId: null, durable: true }] });
    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Forget the recovery ID for / }));
    (document.activeElement as HTMLElement | null)?.blur();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('closing Run History cancels the dialog; it does not come back on reopen, and nothing is forgotten', () => {
    vi.useFakeTimers();
    const deleteProviderRecovery = vi.fn(async () => undefined);
    useGraphStore.setState({ providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node',
      resumeOperationId: 'op-1', existingWorldId: null, durable: true }], deleteProviderRecovery });
    const setVisible = (visible: boolean) => useUIStore.setState((state) => ({
      panels: { ...state.panels, history: { ...state.panels.history, visible } } }));
    render(<RunHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Forget the recovery ID for / }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    act(() => setVisible(false));
    // Gone at once, during the panel's exit too: nothing there can forget.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(600); });
    act(() => setVisible(true));
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteProviderRecovery).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('offline, the dialog\'s Forget ID is disabled and Cancel still closes it (round 15)', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    noteBackendConnection('offline');
    render(<ForgetRecoveryConfirm name="“Harbor world”" onCancel={onCancel} onConfirm={onConfirm} />);
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByRole('button', { name: 'Forget ID' })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Forget ID' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    resetBackendConnectionForTests();
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
