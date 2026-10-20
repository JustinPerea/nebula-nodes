import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOODBOARD_VIEW_KEY, loadMoodboardView, useBoardCanvasStore } from './boardCanvasStore';

// The Board / List switch is remembered per viewer (this browser), List by
// default while the Board view is a preview (plan PR5).

afterEach(() => {
  vi.restoreAllMocks();
  try { window.localStorage.removeItem(MOODBOARD_VIEW_KEY); } catch { /* jsdom */ }
});

describe('the Board / List switch', () => {
  it('is List until the viewer picks Board', () => {
    expect(loadMoodboardView()).toBe('list');
    window.localStorage.setItem(MOODBOARD_VIEW_KEY, 'board');
    expect(loadMoodboardView()).toBe('board');
    window.localStorage.setItem(MOODBOARD_VIEW_KEY, 'grid');
    expect(loadMoodboardView()).toBe('list');
  });

  it('remembers the pick', () => {
    useBoardCanvasStore.getState().setView('board');
    expect(useBoardCanvasStore.getState().view).toBe('board');
    expect(window.localStorage.getItem(MOODBOARD_VIEW_KEY)).toBe('board');
    useBoardCanvasStore.getState().setView('list');
    expect(window.localStorage.getItem(MOODBOARD_VIEW_KEY)).toBe('list');
  });

  it('works when storage throws (private window, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadMoodboardView()).toBe('list');
    expect(() => useBoardCanvasStore.getState().setView('board')).not.toThrow();
    expect(useBoardCanvasStore.getState().view).toBe('board');
  });
});

describe('selection and camera, per board', () => {
  it('keeps each board its own selection and viewport', () => {
    const store = useBoardCanvasStore.getState();
    store.setSelection('a', ['c1', 'c2']);
    store.setSelection('b', ['c9']);
    store.setViewport('a', { x: 1, y: 2, zoom: 0.5 });
    expect(useBoardCanvasStore.getState().selection).toMatchObject({ a: ['c1', 'c2'], b: ['c9'] });
    expect(useBoardCanvasStore.getState().viewports.a).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(useBoardCanvasStore.getState().viewports.b).toBeUndefined();
  });

  it('setting the same selection again changes nothing (no re-render storm while dragging)', () => {
    useBoardCanvasStore.getState().setSelection('a', ['c1']);
    const before = useBoardCanvasStore.getState().selection;
    useBoardCanvasStore.getState().setSelection('a', ['c1']);
    expect(useBoardCanvasStore.getState().selection).toBe(before);
  });
});
