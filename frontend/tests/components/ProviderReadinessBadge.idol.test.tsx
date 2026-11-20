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

describe('ProviderReadinessBadge on Idol (PR #203)', () => {
  it('reads "Hugging Face · free" without the token, with design\'s detail', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
    const { container } = render(<ProviderReadinessBadge definition={IDOL} />);
    expect(container.querySelector('.provider-readiness')).not.toHaveClass('provider-readiness--warning');
    const label = screen.getByText('free').closest('.provider-readiness__label');
    expect(label).toHaveTextContent(/^Hugging Face · free$/);
    expect(label).toHaveAttribute('title', 'Idol runs free on Hugging Face’s shared GPUs, which can be busy. '
      + 'Add a Hugging Face token in Settings to use your own allowance.');
  });

  it('reads "Hugging Face token · saved" with the token, and only "Idol uses your Hugging Face allowance."', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { HF_TOKEN: 'hf_fixture' } } });
    render(<ProviderReadinessBadge definition={IDOL} />);
    const label = screen.getByText('saved').closest('.provider-readiness__label');
    expect(label).toHaveTextContent(/^Hugging Face token · saved$/);
    expect(label).toHaveAttribute('title', 'Idol uses your Hugging Face allowance.');
  });

  it('offers "Settings" beside a saved token and "Set up" only without one', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
      apiKeys: { HF_TOKEN: 'hf_fixture' } } });
    const saved = render(<ProviderReadinessBadge definition={IDOL} />);
    expect(screen.getByRole('button', { name: 'Connection settings for Idol' })).toHaveTextContent(/^Settings$/);
    saved.unmount();
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
    render(<ProviderReadinessBadge definition={IDOL} />);
    expect(screen.getByRole('button', { name: 'Connection settings for Idol' })).toHaveTextContent(/^Set up$/);
  });
});
