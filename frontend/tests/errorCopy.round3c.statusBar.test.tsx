/**
 * Error copy round 3c (GM - Design), the status bar and its warnings:
 * ""PAID START" WORDING ... People never see the word "start"; they ran a
 * World Labs job. Status bar: "Paid start needs review." → "A World Labs run
 * needs your check." In its warnings and the node's run errors, write "World
 * Labs run" wherever they now say "paid start". Keep the rest of each line."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderRecoveryStatus } from '../src/components/ProviderRecoveryStatus';
import { useGraphStore } from '../src/store/graphStore';
import * as waiting from '../src/lib/worldLabsWaiting';

const ambiguity = (nodeId: string) => ({
  runId: 'run-1', nodeId, kind: 'worldlabs-environment' as const,
  message: 'World Labs may have accepted a World Labs run without returning a recovery ID. Check Marble before unlocking; do not rerun blindly.',
  durable: true,
});

describe('the status bar', () => {
  beforeEach(() => {
    useGraphStore.setState({ providerRecoveryWarning: null, uncertainWorldLabsRunId: null,
      providerRecoveries: [], providerStartAmbiguities: [] });
  });
  afterEach(cleanup);

  it('a held start reads "A World Labs run needs your check."', () => {
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity('n1')] });
    render(<ProviderRecoveryStatus />);
    const bar = screen.getByRole('alert');
    expect(bar.querySelector('strong')?.textContent).toBe('A World Labs run needs your check.');
    expect(bar.textContent).not.toMatch(/paid start/i);
  });

  it('more nodes held: "N more nodes also need your check."', () => {
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity('n1'), ambiguity('n2')] });
    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert').textContent).toContain('1 more node also needs your check.');
    cleanup();
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity('n1'), ambiguity('n2'), ambiguity('n3')] });
    render(<ProviderRecoveryStatus />);
    expect(screen.getByRole('alert').textContent).toContain('2 more nodes also need your check.');
  });

  it('a run Nebula couldn\'t confirm reads "World Labs run status unknown." over its warning', () => {
    useGraphStore.setState({ uncertainWorldLabsRunId: 'run-u', providerRecoveryWarning: waiting.WORLD_LABS_STATUS_UNCERTAIN_WARNING });
    render(<ProviderRecoveryStatus />);
    const bar = screen.getByRole('alert');
    expect(bar.querySelector('strong')?.textContent).toBe('World Labs run status unknown.');
    expect(bar.textContent).toContain(
      'Nebula could not confirm whether this World Labs run was accepted. Run remains locked to prevent duplicate paid work. Check Marble before clearing or retrying.');
    expect(bar.textContent).not.toMatch(/\bstart\b/i);
  });
});
