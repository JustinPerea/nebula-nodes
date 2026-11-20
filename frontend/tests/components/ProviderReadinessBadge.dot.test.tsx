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

describe('a state after the dot never repeats its route', () => {
  const NBSP = String.fromCharCode(160);
  const shown = (id: string) => render(<ProviderReadinessBadge definition={NODE_DEFINITIONS[id]} />)
    .container.querySelector('.provider-readiness__label')!.textContent ?? '';

  it.each([
    ['disconnected', `Krea sign-in ·${NBSP}setup required`],
    ['needs_auth', `Krea sign-in ·${NBSP}setup required`],
    ['connecting', `Krea sign-in ·${NBSP}finish setup`],
    ['connected', `Krea sign-in ·${NBSP}signed in`],
  ] as const)('reads a Krea sign-in that is %s without "Krea" or "sign-in" twice', (status, expected) => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'mcp', kreaConnection: { status } } });
    expect(shown('krea-video-kling-kling-3-0')).toBe(expected);
  });

  it('reads Nous "not checked" and "setup required", and a configured key with the aside form for both dots', () => {
    expect(shown('nous-portal-universal')).toBe(`Nous sign-in ·${NBSP}not checked`);
    cleanup();
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    expect(shown('gpt-image-1-generate')).toBe(`OpenAI API ·${NBSP}setup required`);
  });
});
