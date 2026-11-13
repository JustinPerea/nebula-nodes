import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Review r5 LOW-3 of PR #203: a tab with site data blocked throws on every
 * storage call. uiStore loads with the app (and with canvasProposalsStore,
 * which reads the keys for the key lock), so it must load there with safe
 * defaults, and a change of a remembered choice must hold for the session
 * without throwing.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function blockStorage() {
  const denied = () => { throw new DOMException('denied', 'SecurityError'); };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
}

describe('uiStore with blocked storage', () => {
  it('loads with safe defaults', async () => {
    blockStorage();
    vi.resetModules();
    const { useUIStore } = await import('../src/store/uiStore');
    const state = useUIStore.getState();
    expect(state.canvasPerfMode).toBe(true);
    expect(state.canvasLowDetail).toBe(true);
    expect(state.canvasMinimapEnabled).toBe(false);
    // As done: a tab that can't remember never reopens the tour on every load.
    expect(state.hasOnboarded).toBe(true);
  });

  it('the canvas proposals store, which reads the keys from it, loads too', async () => {
    blockStorage();
    vi.resetModules();
    await expect(import('../src/store/canvasProposalsStore')).resolves.toBeTruthy();
  });

  it('a remembered choice changes for the session without throwing', async () => {
    blockStorage();
    vi.resetModules();
    const { useUIStore } = await import('../src/store/uiStore');
    const state = useUIStore.getState();
    expect(() => state.setCanvasMinimapEnabled(true)).not.toThrow();
    expect(useUIStore.getState().canvasMinimapEnabled).toBe(true);
    state.startOnboarding();
    expect(() => useUIStore.getState().finishOnboarding()).not.toThrow();
    expect(useUIStore.getState().onboardingActive).toBe(false);
  });
});
