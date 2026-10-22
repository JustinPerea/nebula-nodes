import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Moodboard } from '../../types';

/**
 * error-copy (GM - Design, 2026-10-22): "Check the other Commons save paths
 * and the board save too, since the same raw string probably leaks there."
 * On main a board save with no answer showed "Failed to fetch", and a 503
 * "Save failed: 503". The board's save now says GM's lines; the backend's own
 * 4xx reason is kept, after "Save failed:". A 4xx with no reason says GM's
 * line for its status; like GM's other lines it stands alone, since the
 * board's notice has no heading of its own. The real lib/api.ts and apiFetch
 * run here; only the browser's fetch is stubbed.
 */

const LOST = "Couldn't reach Nebula. Check your connection and try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";

vi.mock('../../lib/wsClient', () => ({
  wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} },
}));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));

import { MoodboardStudioView } from './MoodboardStudioView';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

type Failure = 'network' | 503 | 500 | 429 | 'detail-409' | 'bare-400' | 'bare-403' | 'bare-413';
const state: { edits: Failure | null; put: Failure | null } = { edits: null, put: null };

const board = (): Moodboard => ({
  id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
  images: [{ id: 'i1', url: '/api/outputs/i1.png', weight: 1, notes: '', privateNote: '', excluded: false,
    placements: [{ id: 'c-i1', frameId: null, x: 0, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' }] }],
  analysis: null, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] },
  briefOverride: null, thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
} as unknown as Moodboard);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fail(failure: Failure): Response {
  if (failure === 'network') throw new TypeError('Failed to fetch');
  if (failure === 'detail-409') return json({ detail: 'This board is locked while it is being moved.' }, 409);
  if (failure === 'bare-400') return new Response('', { status: 400 });
  if (failure === 'bare-403') return new Response('', { status: 403 });
  if (failure === 'bare-413') return new Response('', { status: 413 });
  return new Response('<html>Service Unavailable</html>', { status: failure, headers: { 'content-type': 'text/html' } });
}

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/moodboards/g1/edits' && method === 'POST' && state.edits) return fail(state.edits);
  if (url.pathname === '/api/moodboards/g1' && method === 'PUT' && state.put) return fail(state.put);
  if (url.pathname === '/api/moodboards/g1' && method === 'GET') return json(board());
  if (url.pathname === '/api/moodboards' && method === 'GET') return json(url.searchParams.get('scope') === 'global' ? [board()] : []);
  return json({});
}

beforeEach(() => {
  state.edits = null;
  state.put = null;
  vi.stubGlobal('fetch', vi.fn(backend));
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openStudio() {
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(<MoodboardStudioView />);
  await screen.findByDisplayValue('Global board');
}

const notice = async () => {
  await waitFor(() => expect(document.querySelector('.moodboard-studio__notice--error')).not.toBeNull(), { timeout: 3000 });
  return document.querySelector('.moodboard-studio__notice--error')!;
};

const cases: Array<[string, Failure, string]> = [
  ['a lost connection', 'network', LOST],
  ['a 503', 503, NO_ANSWER],
  ['a 500', 500, NO_ANSWER],
  ['a 429', 429, NO_ANSWER],
];

describe('a board save that fails', () => {
  it.each(cases)('an image edit after %s says GM\'s line', async (_name, failure, line) => {
    state.edits = failure;
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    const shown = await notice();
    expect(shown.textContent).toBe(line);
    expect(screen.queryByText(/Failed to fetch|Save failed: \d{3}/)).toBeNull();
    // Retry stays: saving again can work.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it.each(cases)('a board field (its name) after %s says GM\'s line', async (_name, failure, line) => {
    state.put = failure;
    await openStudio();
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Renamed' } });
    expect((await notice()).textContent).toBe(line);
  });

  it('a 4xx keeps the backend\'s reason', async () => {
    state.edits = 'detail-409';
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    expect((await notice()).textContent).toBe('Save failed: This board is locked while it is being moved.');
  });

  it.each([
    ['bare-400', "That didn't work. Try again, or reload if it keeps happening."],
    ['bare-403', "You don't have access to this anymore. Reload to sign in again."],
    ['bare-413', "That's too large to save."],
  ] as const)('a %s with no reason says GM\'s line for it, without the status code', async (failure, line) => {
    state.edits = failure;
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    expect((await notice()).textContent).toBe(line);
  });
});
