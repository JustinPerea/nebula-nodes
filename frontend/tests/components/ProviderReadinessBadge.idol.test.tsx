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

describe('ProviderReadinessBadge on Idol (GM, PR #203 r1)', () => {
  it('reads "Hugging Face token Optional · No key needed" with the note muted, and GM\'s detail', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
    render(<ProviderReadinessBadge definition={IDOL} />);
    const note = screen.getByText('Optional');
    expect(note).toHaveClass('provider-readiness__note');
    expect(note.closest('.provider-readiness__route')).toHaveTextContent(/^Hugging Face token Optional ·$/);
    expect(screen.getByText('No key needed').closest('.provider-readiness__label')).toHaveAttribute('title',
      'Runs without a key on a small free daily allowance. Add your Hugging Face token in Settings to use your own.');
  });
});
