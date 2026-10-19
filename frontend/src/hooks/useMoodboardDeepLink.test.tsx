import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { moodboardIdFromHash, useMoodboardDeepLink } from './useMoodboardDeepLink';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { NEW_MOODBOARD_SENTINEL } from '../lib/studioSentinels';

const workspace = { screen: 'workspace' as const, initialized: true, busy: false };

function setHash(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
}

beforeEach(() => {
  setHash('');
  useUIStore.setState({ viewMode: 'canvas', moodboardEditorId: null, moodboardEditorScope: 'global' });
  useProjectStore.setState(workspace);
});

afterEach(() => { setHash(''); });

describe('#moodboard/<id>', () => {
  it('reads only a board id', () => {
    expect(moodboardIdFromHash('#moodboard/abc_12-3')).toBe('abc_12-3');
    expect(moodboardIdFromHash('#moodboard/')).toBeNull();
    expect(moodboardIdFromHash('#moodboard/../x')).toBeNull();
    expect(moodboardIdFromHash('#brand')).toBeNull();
  });

  it('opens Moodboard Studio on the board the app loads with', () => {
    setHash('#moodboard/b1');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    expect(window.location.hash).toBe('#moodboard/b1');
  });

  it('waits for the project to open, which would reset the view, then opens the board', () => {
    useProjectStore.setState({ screen: 'home', initialized: false });
    setHash('#moodboard/b1');
    renderHook(() => useMoodboardDeepLink());
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(window.location.hash).toBe('#moodboard/b1');
    act(() => { useProjectStore.setState(workspace); });
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
  });

  it('goes past the Projects screen into the open project', () => {
    const open = vi.fn((id: string) => { if (id === 'proj1') useProjectStore.setState({ screen: 'workspace' }); return Promise.resolve(); });
    useProjectStore.setState({ screen: 'home', initialized: true, activeProject: { id: 'proj1' } as never, open });
    setHash('#moodboard/b1');
    renderHook(() => useMoodboardDeepLink());
    expect(open).toHaveBeenCalledWith('proj1');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
  });

  it('with no open project, waits on the Projects screen', () => {
    const open = vi.fn();
    useProjectStore.setState({ screen: 'home', initialized: true, activeProject: null, open });
    setHash('#moodboard/b1');
    renderHook(() => useMoodboardDeepLink());
    expect(open).not.toHaveBeenCalled();
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(window.location.hash).toBe('#moodboard/b1');
  });

  it('follows the board the Studio shows, without adding history, and clears when the Studio closes', () => {
    renderHook(() => useMoodboardDeepLink());
    const entries = window.history.length;
    act(() => { useUIStore.getState().enterMoodboardEditor('b2', 'project'); });
    expect(window.location.hash).toBe('#moodboard/b2');
    act(() => { useUIStore.getState().enterMoodboardEditor('b3', 'global'); });
    expect(window.location.hash).toBe('#moodboard/b3');
    act(() => { useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, 'global'); });
    expect(window.location.hash).toBe('');
    act(() => { useUIStore.getState().enterMoodboardEditor('b3', 'global'); });
    act(() => { useUIStore.getState().exitMoodboardEditor(); });
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(entries);
  });

  it('opens a board when the hash changes, and leaves the Studio when the link goes', () => {
    renderHook(() => useMoodboardDeepLink());
    act(() => {
      setHash('#moodboard/b4');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b4' });
    act(() => {
      setHash('');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('leaves other hashes alone', () => {
    setHash('#brand');
    renderHook(() => useMoodboardDeepLink());
    act(() => { useUIStore.setState({ selectedNodeId: 'n1' }); });
    expect(window.location.hash).toBe('#brand');
  });
});
