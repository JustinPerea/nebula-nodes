/**
 * The Providers row's hover title: the row's note title and the connection's
 * detail are two sentences, each with its full stop, joined by a space
 * (design). A row with no note title has the detail alone.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));

const { KeyRow } = await import('../src/components/panels/settings/KeyRow');
const { PROVIDER_KEY_SPECS } = await import('../src/lib/providerCatalog');
const { useUIStore } = await import('../src/store/uiStore');
const { useProviderReadinessStore } = await import('../src/store/providerReadinessStore');

const lock = { shown: false, line: '', id: 'lock', locked: false, control: () => ({}), guard: (fn: () => void) => fn } as never;

beforeEach(() => {
  useUIStore.setState({ settingsCache: { loaded: true, apiKeys: { TYPESAFE_API_KEY: 'sk-1', OPENAI_API_KEY: 'sk-2' } } } as never);
  useProviderReadinessStore.setState({ loading: false, error: null, providers: {} } as never);
});
afterEach(cleanup);

const titleOf = (container: HTMLElement) => container.querySelector('.settings-row__text')?.getAttribute('title');

describe('the Providers row title', () => {
  it('a connected row with a note title: both sentences, each with its full stop, one space between', () => {
    const { container } = render(<KeyRow spec={PROVIDER_KEY_SPECS.TYPESAFE_API_KEY} configured lock={lock} />);
    expect(titleOf(container)).toBe(
      'Typed judge, classify and pick-best decisions. TypeSafe API key is saved. Use Check connections to verify it without generating.');
  });

  it('a connected row without one: the detail alone', () => {
    const { container } = render(<KeyRow spec={PROVIDER_KEY_SPECS.OPENAI_API_KEY} configured lock={lock} />);
    expect(titleOf(container)).toBe('OpenAI API key is saved. Use Check connections to verify it without generating.');
  });
});
