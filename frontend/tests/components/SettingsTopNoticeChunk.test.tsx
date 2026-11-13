import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SettingsTopNotice } from '../../src/components/panels/settings/DeferredSettingsTopNotice';

// The "restored at start" line loads with its own chunk (entry budget, PR #203). It draws only
// what a fetch brings in, so a chunk that cannot load leaves the rest of Settings as it was
// and draws nothing of its own (the DeferredBoundary's quiet failure).
vi.mock('../../src/components/panels/settings/SettingsTopNotice', () => {
  throw new Error('chunk failed: SettingsTopNotice');
});

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings\' restored-at-start line when its chunk cannot load', () => {
  it('draws nothing and leaves its neighbours mounted', async () => {
    render(<div><p>Settings tabs</p><SettingsTopNotice visible /><p>Settings body</p></div>);
    await flush();
    expect(screen.getByText('Settings tabs')).toBeInTheDocument();
    expect(screen.getByText('Settings body')).toBeInTheDocument();
    expect(document.querySelector('.settings-top-notice')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
