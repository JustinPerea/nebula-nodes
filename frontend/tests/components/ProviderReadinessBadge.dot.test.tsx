import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ProviderReadinessBadge } from '../../src/components/ProviderReadinessBadge';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useUIStore } from '../../src/store/uiStore';
import { useProviderReadinessStore } from '../../src/store/providerReadinessStore';

const ui = useUIStore.getState();

beforeEach(() => {
  useProviderReadinessStore.getState().invalidate();
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'api-token', kreaConnection: { status: 'connected' } } });
});
afterEach(() => {
  cleanup(); useProviderReadinessStore.getState().invalidate(); useUIStore.setState(ui, true);
});

describe('the readiness line after its connection name', () => {
  it('reads "<name> · setup required": lower case after the dot, a no-break space after it', () => {
    const { container } = render(<ProviderReadinessBadge definition={NODE_DEFINITIONS['gpt-image-1-generate']} />);
    const text = container.querySelector('.provider-readiness__label')!.textContent ?? '';
    expect(text.endsWith(` ·${String.fromCharCode(160)}setup required`)).toBe(true);
    expect(text).not.toMatch(/Setup required/);
  });
});
