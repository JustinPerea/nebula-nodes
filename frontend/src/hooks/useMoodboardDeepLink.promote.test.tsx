// GM, 2026-10-30: a promote never moves the person. Pasting the person link
// into a tab that shows Moodboard Studio keeps the Studio on the same board
// (the link takes the hash, then personSession strips it). The tab keeps the
// board it shows in its own storage, so a same-tab reload restores the
// Studio even when the address has lost `#moodboard/<id>`. A board deleted
// meanwhile opens the way a `#moodboard/<id>` link to it does, into the
// Studio's own "Moodboard not found" (GM, PR #204 round 1: one behaviour for a
// missing board however reached; MoodboardStudioView shows the message).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

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

  it('a same-tab reload without the board in the address restores the Studio from the tab', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    expect(window.location.hash).toBe('#moodboard/b1');
  });

  it('a reload with the person link still in the address restores it too', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    setHash(PERSON_LINK);
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().moodboardEditorId).toBe('b1');
  });

  it('a board deleted meanwhile opens exactly as its #moodboard link does: into the Studio, which says it is not found', () => {
    setHash('#moodboard/gone');
    const viaLink = renderHook(() => useMoodboardDeepLink());
    const linkState = { ...useUIStore.getState() };
    const linkHash = window.location.hash;
    viaLink.unmount();

    useUIStore.setState({ viewMode: 'canvas', moodboardEditorId: null, moodboardEditorScope: 'global' });
    setHash('');
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'gone');
    renderHook(() => useMoodboardDeepLink());
    const restored = useUIStore.getState();
    expect(restored).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'gone' });
    expect({ viewMode: restored.viewMode, id: restored.moodboardEditorId, scope: restored.moodboardEditorScope })
      .toEqual({ viewMode: linkState.viewMode, id: linkState.moodboardEditorId, scope: linkState.moodboardEditorScope });
    expect(window.location.hash).toBe(linkHash);
    // The tab keeps it, as the address keeps the link: a reload says the same again.
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBe('gone');
  });

  it('another link in the address wins over the tab: no restore', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    setHash('#brand');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('a board link still opens straight away, without asking the tab', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    setHash('#moodboard/b2');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().moodboardEditorId).toBe('b2');
  });
});
