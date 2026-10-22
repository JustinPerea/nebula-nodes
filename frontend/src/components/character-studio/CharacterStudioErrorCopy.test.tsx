import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Character } from '../../types';

/**
 * error-copy round 2 (GM - Design): "Couldn't save the character." Character
 * Studio's save goes through the same two-line notice as the board, heading
 * over reason, and its Retry is the retry (GM's WRAP rule: the reason drops
 * its "try again"). On 1fc3d846 a 503 read "Update character failed: 503".
 * The real lib/api.ts and apiFetch run; only the browser's fetch is stubbed.
 */

vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));

import { CharacterStudioView } from './CharacterStudioView';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { setOpenProject } from '../../test/projectState';

const nari = (): Character => ({
  id: 'c1', name: 'Nari', version: 1, subjectType: 'human', referenceViews: ['/api/outputs/a.png', '/api/outputs/b.png', '/api/outputs/c.png'],
  frozenTraitString: 'silver hair', seed: 1, consistencyStrength: 0.8, thumbnail: '/api/outputs/a.png',
  projectId: undefined, createdAt: '', updatedAt: '',
} as unknown as Character);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const state: { put: 'network' | 503 | null; load: 503 | null } = { put: null, load: null };

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/characters/c1' && method === 'PUT' && state.put) {
    if (state.put === 'network') throw new TypeError('Failed to fetch');
    return new Response('Service Unavailable', { status: state.put });
  }
  if (url.pathname === '/api/characters/c1' && method === 'GET') return state.load ? new Response('', { status: state.load }) : json(nari());
  if (url.pathname === '/api/characters' && method === 'GET') return json(url.searchParams.get('scope') === 'global' ? [nari()] : []);
  return json({});
}

beforeEach(() => {
  state.put = null;
  state.load = null;
  vi.stubGlobal('fetch', vi.fn(backend));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lines = (shown: Element) => [shown.querySelector('.failure-lines__heading')?.textContent,
  shown.querySelector('.failure-lines__reason')?.textContent];

describe('a Character save that fails', () => {
  it.each([
    ['a lost connection', 'network', "Couldn't reach Nebula. Check your connection.",
      "Couldn't save the character. Couldn't reach Nebula. Check your connection and try again."],
    ['a 503', 503, "Nebula didn't respond.", "Couldn't save the character. Nebula didn't respond. Try again."],
  ] as const)('after %s: the notice says the heading over GM\'s short line; the toolbar Retry\'s tooltip the one line', async (_name, failure, short, oneLine) => {
    state.put = failure;
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    fireEvent.change(await screen.findByDisplayValue('Nari'), { target: { value: 'Nari two' } });
    await waitFor(() => expect(document.querySelector('.character-studio-view__notice--error .failure-lines')).not.toBeNull(), { timeout: 3000 });
    const notice = document.querySelector('.character-studio-view__notice--error')!;
    expect(lines(notice)).toEqual(["Couldn't save the character.", short]);
    expect(notice.textContent).not.toMatch(/Update character failed|\d{3}/);
    expect(document.querySelector('.character-studio-toolbar__retry')?.getAttribute('title')).toBe(oneLine);
  });

  it('a Character that fails to load says "Couldn\'t load the character." over GM\'s short line, beside Retry loading', async () => {
    state.load = 503;
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(lines(alert)).toEqual(["Couldn't load the character.", "Nebula didn't respond."]));
    expect(screen.getByRole('button', { name: 'Retry loading' })).toBeTruthy();
  });
});
