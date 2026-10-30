import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderReadinessBadge } from '../../src/components/ProviderReadinessBadge';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/useBackendOffline', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/useBackendOffline')>(),
  useBackendOffline: () => false,
}));

const IDOL = NODE_DEFINITIONS['speridlabs-idol'];

afterEach(() => cleanup());

describe('ProviderReadinessBadge on Idol (GM, PR #203 r3 and r4)', () => {
  it('reads "Hugging Face token · Needed" without the token, with GM\'s detail', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
    const { container } = render(<ProviderReadinessBadge definition={IDOL} />);
    expect(container.querySelector('.provider-readiness')).toHaveClass('provider-readiness--warning');
    const label = screen.getByText('Needed').closest('.provider-readiness__label');
    expect(label).toHaveTextContent(/^Hugging Face token · Needed$/);
    expect(label).toHaveAttribute('title',
      'Add your Hugging Face token in Settings to run Idol. A free Hugging Face account gives a few runs a day.');
    // No "Optional" any more (GM r4).
    expect(container.querySelector('.provider-readiness__note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connection settings for Idol' })).toHaveTextContent('Set up');
  });

  it('shows only "Runs on your own Hugging Face allowance." with the token (r3: never the generic line too)', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { HF_TOKEN: 'hf_fixture' } } });
    render(<ProviderReadinessBadge definition={IDOL} />);
    const label = screen.getByText('Configured · not checked').closest('.provider-readiness__label');
    expect(label).toHaveTextContent(/^Hugging Face token · Configured · not checked$/);
    expect(label).toHaveAttribute('title', 'Runs on your own Hugging Face allowance.');
  });
});
