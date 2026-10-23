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
import { NO_PROJECT_OPEN } from '../../lib/currentProject';

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
  if (url.pathname === '/api/characters/c1' && method === 'PUT') {
    return json({ ...nari(), ...JSON.parse(String(init?.body ?? '{}')), version: 2 });
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
    ['a lost connection', 'network', "Nebula's server isn't answering. Make sure it's running.",
      "Couldn't save the character. Nebula's server isn't answering. Make sure it's running, then try again."],
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

// Round 3 (GM): "Make Retry redo the failed action, never a different one."
// Character Studio shares the Studio's store: its Retry (the notice's and the
// toolbar's) is a save, so it shows only beside a save's own failure.
describe('the Character Retry', () => {
  it('after a failed save, Retry saves again', async () => {
    state.put = 503;
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    fireEvent.change(await screen.findByDisplayValue('Nari'), { target: { value: 'Nari two' } });
    await waitFor(() => expect(document.querySelector('.character-studio-view__notice--error .failure-lines')).not.toBeNull(), { timeout: 3000 });
    const puts = () => vi.mocked(fetch).mock.calls.filter(([input, init]) =>
      (init?.method ?? 'GET').toUpperCase() === 'PUT' && new URL(String(input)).pathname === '/api/characters/c1').length;
    const before = puts();
    state.put = null;
    fireEvent.click(document.querySelector('.character-studio-view__retry')!);
    await waitFor(() => expect(puts()).toBe(before + 1));
  });

  it('a line no save made has no Retry beside it, and keeps GM\'s full line', async () => {
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    await screen.findByDisplayValue('Nari');
    const key = Object.keys(useAssetStudioDraftStore.getState().entries)[0];
    act(() => {
      useAssetStudioDraftStore.getState().patch(key, { saveState: 'error',
        saveError: { heading: "Couldn't upload the image.", reason: "Nebula didn't respond. Try again." } });
    });
    const notice = await waitFor(() => {
      const shown = document.querySelector('.character-studio-view__notice--error');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(lines(notice)).toEqual(["Couldn't upload the image.", "Nebula didn't respond. Try again."]);
    // Neither the notice's Retry nor the toolbar's (the Move menu shares the toolbar's class).
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

// Review of round 3: a failed save is still owed when another line (no
// project open) replaces its own. The toolbar keeps its Retry, which saves;
// the notice keeps that line in full, with no Retry of its own.
describe('a Character save still owed under another line', () => {
  it('keeps the toolbar Retry, and Retry saves again', async () => {
    state.put = 503;
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    fireEvent.change(await screen.findByDisplayValue('Nari'), { target: { value: 'Nari two' } });
    await waitFor(() => expect(document.querySelector('.character-studio-view__notice--error .failure-lines')).not.toBeNull(), { timeout: 3000 });
    const key = Object.keys(useAssetStudioDraftStore.getState().entries)[0];
    // What "New Character" in a project scope does with no project open.
    act(() => { useAssetStudioDraftStore.getState().patch(key, { saveError: NO_PROJECT_OPEN }); });
    const notice = document.querySelector('.character-studio-view__notice--error')!;
    await waitFor(() => expect(notice.textContent).toContain(NO_PROJECT_OPEN));
    expect(notice.querySelector('.character-studio-view__retry')).toBeNull();
    const puts = () => vi.mocked(fetch).mock.calls.filter(([input, init]) =>
      (init?.method ?? 'GET').toUpperCase() === 'PUT' && new URL(String(input)).pathname === '/api/characters/c1').length;
    const before = puts();
    state.put = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(puts()).toBe(before + 1));
  });
});
