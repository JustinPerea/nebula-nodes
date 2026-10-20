import { afterEach, describe, expect, it, vi } from 'vitest';

// The preference is read once when uiStore loads, so each case loads a fresh
// copy of the module after setting localStorage.
async function loadStore() {
  vi.resetModules();
  const mod = await import('./uiStore');
  return mod.useUIStore;
}

describe('Agent log preference (Q38: shown by default)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('reads a missing preference as on (new installs, never touched)', async () => {
    window.localStorage.removeItem('nebula:agentLog:enabled');
    const store = await loadStore();
    expect(store.getState().agentLogEnabled).toBe(true);
  });

  it('keeps someone who turned it off, off', async () => {
    window.localStorage.setItem('nebula:agentLog:enabled', '0');
    const store = await loadStore();
    expect(store.getState().agentLogEnabled).toBe(false);
  });

  it('keeps an explicit on, on', async () => {
    window.localStorage.setItem('nebula:agentLog:enabled', '1');
    const store = await loadStore();
    expect(store.getState().agentLogEnabled).toBe(true);
  });

  it('writes the choice back as 0 or 1', async () => {
    const store = await loadStore();
    store.getState().setAgentLogEnabled(false);
    expect(window.localStorage.getItem('nebula:agentLog:enabled')).toBe('0');
    store.getState().setAgentLogEnabled(true);
    expect(window.localStorage.getItem('nebula:agentLog:enabled')).toBe('1');
  });
});
