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
  message: "World Labs may have started this run without sending back its ID, so Nebula can't tell if it was billed. Check the job in Marble before you unlock the node, and don't run it again until you have.",
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

  it('a run Nebula couldn\'t confirm reads "Nebula can\'t tell if this World Labs run started." over its warning', () => {
    useGraphStore.setState({ uncertainWorldLabsRunId: 'run-u', providerRecoveryWarning: waiting.WORLD_LABS_STATUS_UNCERTAIN_WARNING });
    render(<ProviderRecoveryStatus />);
    const bar = screen.getByRole('alert');
    expect(bar.querySelector('strong')?.textContent).toBe("Nebula can't tell if this World Labs run started.");
    expect(bar.textContent).toContain(
      "Nebula couldn't confirm whether World Labs accepted this run, so the node stays locked to avoid paying twice. Check the job in Marble before you unlock it or run it again.");
    expect(bar.textContent).not.toMatch(/\bstart\b/i);
  });
});
