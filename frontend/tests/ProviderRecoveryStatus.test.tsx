import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { useGraphStore } from '../src/store/graphStore';

const acknowledgeProviderStartAmbiguity = useGraphStore.getState()
  .acknowledgeProviderStartAmbiguity;
const acknowledgeUncertainWorldLabsRun = useGraphStore.getState()
  .acknowledgeUncertainWorldLabsRun;

describe('ProviderRecoveryStatus', () => {
  beforeEach(() => {
    useGraphStore.setState({
      providerRecoveryWarning: null,
      uncertainWorldLabsRunId: null,
      providerRecoveries: [],
      providerStartAmbiguities: [],
      acknowledgeProviderStartAmbiguity,
      acknowledgeUncertainWorldLabsRun,
    });
  });

  it('surfaces and dismisses a non-durable paid-provider recovery warning', () => {
    useGraphStore.setState({
      providerRecoveryWarning: 'Keep this tab open and copy operation_123 before reloading.',
    });

    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent('Recovery ID not saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('operation_123');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss recovery warning' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('requires an explicit Marble check before removing an ambiguous paid-start hold', async () => {
    const acknowledge = vi.fn(async () => {
      useGraphStore.setState({ providerStartAmbiguities: [] });
    });
    useGraphStore.setState({
      acknowledgeProviderStartAmbiguity: acknowledge,
      providerStartAmbiguities: [{
        runId: 'run-1',
        nodeId: 'world-1',
        kind: 'worldlabs-environment',
        message: 'The paid start may have been accepted. Check Marble first.',
        durable: true,
      }],
    });

    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent('Paid start needs review.');
    expect(screen.queryByRole('button', { name: 'Dismiss recovery warning' })).toBeNull();

    fireEvent.click(screen.getByRole('button', {
      name: 'I checked Marble; unlock node world-1',
    }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(
      'worldlabs-environment',
      'world-1',
    ));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('warns when an ambiguity hold cannot survive backend restart', () => {
    useGraphStore.setState({
      providerStartAmbiguities: [{
        runId: 'run-2',
        nodeId: 'export-1',
        kind: 'worldlabs-world-export',
        message: 'Check Marble before unlocking.',
        durable: false,
      }],
    });

    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The hold could not be saved durably; do not restart the backend.',
    );
  });

  it('requires a Marble check before clearing a locally unconfirmed run lock', () => {
    const acknowledge = vi.fn(() => {
      useGraphStore.setState({
        providerRecoveryWarning: null,
        uncertainWorldLabsRunId: null,
      });
    });
    useGraphStore.setState({
      providerRecoveryWarning: 'Run remains locked to prevent duplicate paid work.',
      uncertainWorldLabsRunId: 'run-unconfirmed',
      acknowledgeUncertainWorldLabsRun: acknowledge,
    });

    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent('Paid start status unknown.');
    expect(screen.queryByRole('button', { name: 'Dismiss recovery warning' })).toBeNull();

    fireEvent.click(screen.getByRole('button', {
      name: 'I checked Marble; unlock the unconfirmed run',
    }));

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

});
