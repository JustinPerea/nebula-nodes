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
const api = vi.hoisted(() => ({ fetchMoodboard: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/api')>()), fetchMoodboard: api.fetchMoodboard }));

import { STUDIO_BOARD_KEY, useMoodboardDeepLink } from './useMoodboardDeepLink';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';

/** How this document was reached, as Navigation Timing says (GM, PR #204 round 3: restore only on a reload). */
function arrivedBy(type: string | null) {
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(((kind: string) =>
    kind === 'navigation' && type ? [{ type } as unknown as PerformanceEntry] : []) as typeof performance.getEntriesByType);
}

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
  arrivedBy('reload');
  api.fetchMoodboard.mockReset();
});
afterEach(() => { setHash(''); window.sessionStorage.clear(); vi.restoreAllMocks(); });

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

describe('GM, PR #204 round 3: restore only on a reload (review 1 LOW-2)', () => {
  for (const type of ['navigate', 'back_forward', 'prerender', null]) {
    it(`arriving by ${type ?? 'an unknown way'} (a typed address, a bookmark, a fresh link…) lands where it points and forgets the board`, () => {
      arrivedBy(type);
      window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
      renderHook(() => useMoodboardDeepLink());
      expect(useUIStore.getState().viewMode).toBe('canvas');
      expect(window.location.hash).toBe('');
      expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBeNull();
    });
  }

  it('a reload restores it', () => {
    arrivedBy('reload');
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
  });

  it('a board link still opens on a fresh navigation', () => {
    arrivedBy('navigate');
    setHash('#moodboard/b2');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().moodboardEditorId).toBe('b2');
  });

  it('a reconnect that never navigates (the promote, a socket that drops and comes back, a project re-sync) keeps the Studio and the record', () => {
    arrivedBy('navigate');
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().enterMoodboardEditor('b1', 'project'); });
    act(() => { paste(PERSON_LINK); });
    act(() => { useProjectStore.setState({ busy: true }); });
    act(() => { useProjectStore.setState({ busy: false }); });
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBe('b1');
    expect(window.location.hash).toBe('#moodboard/b1');
  });
});

describe('PR #204 review 1 LOW-1: the restore never overrides the person', () => {
  it('opens at once when the project is ready: no request first', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().moodboardEditorId).toBe('b1');
    expect(api.fetchMoodboard).not.toHaveBeenCalled();
  });

  it('the person opens another board before the restore lands: theirs stays', () => {
    useProjectStore.setState({ initialized: false });
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().enterMoodboardEditor('b2', 'project'); });
    act(() => { useProjectStore.setState({ initialized: true }); });
    expect(useUIStore.getState().moodboardEditorId).toBe('b2');
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBe('b2');
  });

  it('the person goes elsewhere before the restore lands: nothing pulls them into the Studio', () => {
    useProjectStore.setState({ initialized: false });
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.setState({ viewMode: 'create' } as never); });
    act(() => { useProjectStore.setState({ initialized: true }); });
    expect(useUIStore.getState().viewMode).toBe('create');
  });

  it('the person leaves for the canvas after the restore: it stays left, and the tab forgets the board', () => {
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().exitMoodboardEditor(); });
    act(() => { useProjectStore.setState({ busy: true }); });
    act(() => { useProjectStore.setState({ busy: false }); });
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBeNull();
  });

  it('a board that fails to load (a 500, no answer) keeps its record: only the person leaving clears it', async () => {
    api.fetchMoodboard.mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));
    window.sessionStorage.setItem(STUDIO_BOARD_KEY, 'b1');
    renderHook(() => useMoodboardDeepLink());
    // The Studio's own load fails (MoodboardStudioView shows its error and stays); nothing here asks or forgets.
    act(() => { useUIStore.setState({ moodboardEditorScope: 'project' }); });
    await act(async () => { await Promise.resolve(); });
    expect(useUIStore.getState().moodboardEditorId).toBe('b1');
    expect(window.sessionStorage.getItem(STUDIO_BOARD_KEY)).toBe('b1');
  });
});

describe('PR #204 review 1 NIT-1: followStudio never writes over a person link', () => {
  it('a person link in the address before personSession reads it stays as it is', () => {
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.getState().enterMoodboardEditor('b1', 'project'); });
    setHash(PERSON_LINK); // arrived, its hashchange not yet heard
    act(() => { useUIStore.setState({ moodboardEditorScope: 'global' }); }); // any UI change runs followStudio
    expect(window.location.hash).toBe(PERSON_LINK);
  });
});
