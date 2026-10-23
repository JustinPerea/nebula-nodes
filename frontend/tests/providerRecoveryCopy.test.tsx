/**
 * Error copy round 3b, item 3 (GM - Design: "Never show raw error.message
 * strings in UI."). Run History's "Checked Marble — forget" and the status
 * bar's "Checked Marble — unlock" say written copy for every failure: a
 * request's own line, the store's own written refusals, and GM's general line
 * for an error that isn't a request's (no request was made).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { RequestFailedError } from '../src/lib/errorCopy';
import { noticeSpy } from './helpers/noticeSpy';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const FORGET = "Couldn't forget the recovery safeguard.";
const GENERAL = "Try again, or reload if it keeps happening.";
const checkpoint = { runId: 'paid-run', nodeId: 'world-node', resumeOperationId: 'operation-saved', existingWorldId: null, durable: true };

function forget() {
  render(<RunHistoryPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Checked Marble; forget recovery for world-node' }));
}

beforeEach(() => {
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Checked Marble — forget never shows a raw message', () => {
  it('an error that is not a request says GM\'s general line under the heading', async () => {
    const alert = noticeSpy();
    useGraphStore.setState({ providerRecoveries: [checkpoint],
      deleteProviderRecovery: vi.fn().mockRejectedValue(new Error('Backend still has an active provider task.')) });
    forget();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(`${FORGET} ${GENERAL}`));
  });

  it('a request\'s failure says its own line', async () => {
    const alert = noticeSpy();
    const line = 'This node is still waiting on World Labs. Let its run finish, then try again.';
    useGraphStore.setState({ providerRecoveries: [checkpoint],
      deleteProviderRecovery: vi.fn().mockRejectedValue(new RequestFailedError(FORGET, 409, { detail: line })) });
    forget();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(`${FORGET} ${line}`));
  });

  it('the store\'s own refusals (no request made) are written lines, not developer text', async () => {
    useGraphStore.setState({ providerRecoveries: [checkpoint], isExecuting: true });
    await expect(useGraphStore.getState().deleteProviderRecovery('paid-run', 'world-node'))
      .rejects.toThrow(`${FORGET} Let the run finish, then try again.`);
    useGraphStore.setState({ providerRecoveries: [], isExecuting: false });
    await expect(useGraphStore.getState().deleteProviderRecovery('paid-run', 'world-node'))
      .rejects.toThrow(`${FORGET} That recovery safeguard isn't there anymore. Reload to get the latest run history.`);
  });

  it('a checkpoint with two IDs (a broken state; nothing is sent) alerts GM\'s general line', async () => {
    const alert = noticeSpy();
    const fetch = vi.spyOn(globalThis, 'fetch');
    useGraphStore.setState({ providerRecoveries: [{ ...checkpoint, existingWorldId: 'world-1' }] });
    forget();
    await waitFor(() => expect(alert).toHaveBeenCalledWith(`${FORGET} ${GENERAL}`));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Checked Marble — unlock never shows a raw message', () => {
  it('an error that is not a request says GM\'s general line under the heading', async () => {
    useGraphStore.setState({
      providerStartAmbiguities: [{ runId: 'r1', nodeId: 'world-node', kind: 'worldlabs-world', message: 'Check Marble.', durable: true }] as never,
      acknowledgeProviderStartAmbiguity: vi.fn().mockRejectedValue(new Error('internal: lifecycle fd closed')),
    });
    render(<ProviderRecoveryStatus />);
    fireEvent.click(screen.getByRole('button', { name: 'I checked Marble; unlock node world-node' }));
    await waitFor(() => expect(screen.getByText(`Couldn't unlock the node. ${GENERAL}`)).toBeTruthy());
    expect(screen.queryByText(/lifecycle fd/)).toBeNull();
  });
});
