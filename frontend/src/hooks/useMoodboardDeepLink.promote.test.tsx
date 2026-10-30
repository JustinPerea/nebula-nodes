// GM, 2026-10-30: a promote never moves the person. Pasting the person link
// into a tab that shows Moodboard Studio keeps the Studio on the same board
// (the link takes the hash, then personSession strips it). The tab keeps the
// board it shows in its own storage, so a same-tab reload restores the
// Studio even when the address has lost `#moodboard/<id>`; a board deleted
// meanwhile leaves the person on the canvas, with no new copy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
const api = vi.hoisted(() => ({ fetchMoodboard: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/api')>()), fetchMoodboard: api.fetchMoodboard }));

import { STUDIO_BOARD_KEY, useMoodboardDeepLink } from './useMoodboardDeepLink';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';

const PERSON_LINK = `#nebula-person=${'a'.repeat(43)}&backend=http://127.0.0.1:8795`;
const workspace = { screen: 'workspace' as const, initialized: true, busy: false };

function setHash(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
}

/** Paste a link into the address bar of this tab: the hash changes, nothing reloads. */
function paste(hash: string) {
  const oldURL = window.location.href;
  setHash(hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  setHash('');
  api.fetchMoodboard.mockReset();
  useUIStore.setState({ viewMode: 'canvas', moodboardEditorId: null, moodboardEditorScope: 'global' });
  useProjectStore.setState(workspace);
});
afterEach(() => { setHash(''); window.sessionStorage.clear(); });

describe('GM 2026-10-30: the Studio stays open across a promote', () => {
  it('the person link pasted while the Studio shows a board: same board, its link back in the address', () => {
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().enterMoodboardEditor('b1', 'project'); });
    expect(window.location.hash).toBe('#moodboard/b1');
    act(() => { paste(PERSON_LINK); });
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    // The secret never stays in the address; the board's link does.
    expect(window.location.hash).toBe('#moodboard/b1');
    expect(window.location.href).not.toContain('nebula-person');
  });

  it('the person link on the canvas changes nothing either', () => {
    renderHook(() => useMoodboardDeepLink());
    act(() => { paste(PERSON_LINK); });
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(window.location.hash).toBe('');
  });

  it('keeps the board in the tab while the Studio shows it, and forgets it when the person leaves', () => {
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().enterMoodboardEditor('b1', 'project'); });
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBe('b1');
    act(() => { useUIStore.getState().exitMoodboardEditor(); });
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBeNull();
  });

  it('a same-tab reload without the board in the address restores the Studio from the tab', async () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    api.fetchMoodboard.mockResolvedValue({ id: 'b1', projectId: 'proj1' });
    renderHook(() => useMoodboardDeepLink());
    await waitFor(() => expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' }));
    expect(api.fetchMoodboard).toHaveBeenCalledWith('b1');
    expect(window.location.hash).toBe('#moodboard/b1');
  });

  it('a reload with the person link still in the address restores it too', async () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    api.fetchMoodboard.mockResolvedValue({ id: 'b1', projectId: 'proj1' });
    setHash(PERSON_LINK);
    renderHook(() => useMoodboardDeepLink());
    await waitFor(() => expect(useUIStore.getState().moodboardEditorId).toBe('b1'));
  });

  it('a board deleted meanwhile: the reload stays on the canvas and the tab forgets it', async () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'gone');
    api.fetchMoodboard.mockResolvedValue(null);
    renderHook(() => useMoodboardDeepLink());
    await waitFor(() => expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBeNull());
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(window.location.hash).toBe('');
  });

  it('another link in the address wins over the tab: no restore', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    setHash('#brand');
    renderHook(() => useMoodboardDeepLink());
    expect(api.fetchMoodboard).not.toHaveBeenCalled();
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('a board link still opens straight away, without asking the tab', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    setHash('#moodboard/b2');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().moodboardEditorId).toBe('b2');
    expect(api.fetchMoodboard).not.toHaveBeenCalled();
  });
});
