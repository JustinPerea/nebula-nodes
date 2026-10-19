import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUIStore } from '../../store/uiStore';
import { useHomeSettingsDock } from './useHomeSettingsDock';

const dock = () => useUIStore.getState().leftDock;

describe('useHomeSettingsDock', () => {
  beforeEach(() => act(() => useUIStore.getState().setLeftDock('library')));

  it('toggles the shared Settings drawer from home', () => {
    const { result } = renderHook(() => useHomeSettingsDock(true));
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    expect(dock()).toBe('settings');
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    expect(result.current.open).toBe(true);
    act(() => result.current.toggle());
    expect(dock()).toBeNull();
  });

  it("doesn't carry Settings opened on home into the project, and restores the workspace's drawer", () => {
    const { result, rerender } = renderHook(({ home }) => useHomeSettingsDock(home), { initialProps: { home: true } });
    act(() => result.current.toggle());
    rerender({ home: false });
    expect(dock()).toBe('library');
    expect(result.current.open).toBe(false);
  });

  it('closes a workspace Settings drawer on arriving home and reopens it on leaving', () => {
    act(() => useUIStore.getState().setLeftDock('settings'));
    const { rerender } = renderHook(({ home }) => useHomeSettingsDock(home), { initialProps: { home: true } });
    expect(dock()).toBeNull();
    rerender({ home: false });
    expect(dock()).toBe('settings');
  });

  it("keeps a drawer the person picked elsewhere while home", () => {
    const { rerender } = renderHook(({ home }) => useHomeSettingsDock(home), { initialProps: { home: true } });
    act(() => useUIStore.getState().setLeftDock('history'));
    rerender({ home: false });
    expect(dock()).toBe('history');
  });

  it('lets a project opened from home pick its own drawer', () => {
    const { rerender } = renderHook(({ home }) => useHomeSettingsDock(home), { initialProps: { home: true } });
    act(() => useUIStore.getState().resetPanelsForFreshCanvas({ canvasEmpty: false }));
    rerender({ home: false });
    expect(dock()).toBeNull();
    expect(useUIStore.getState().panels.library.visible).toBe(false);
  });

  it("doesn't reopen a workspace's Settings in a different project", () => {
    act(() => useUIStore.getState().setLeftDock('settings'));
    const { rerender } = renderHook(({ home }) => useHomeSettingsDock(home), { initialProps: { home: true } });
    act(() => useUIStore.getState().resetPanelsForFreshCanvas({ canvasEmpty: true }));
    rerender({ home: false });
    expect(dock()).toBe('library');
  });

  it('reports closed outside home even when the workspace has Settings open', () => {
    act(() => useUIStore.getState().setLeftDock('settings'));
    const { result } = renderHook(() => useHomeSettingsDock(false));
    expect(result.current.open).toBe(false);
    expect(dock()).toBe('settings');
  });
});
