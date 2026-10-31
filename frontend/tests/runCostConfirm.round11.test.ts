/**
 * PR #204 round 11: the run-cost carry-over (PUT /api/settings, the person's alone) goes out
 * only from a tab connected as the person, once. On f93f2968 it went out from a held tab on
 * every read that lacked the setting, and a refusal reset it to go again on the next read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: (...args: unknown[]) => api.getSettings(...args),
  updateSettings: (...args: unknown[]) => api.updateSettings(...args),
}));

const session = await import('../src/lib/personSession');
const { whenPerson, personWorkWaiting, resetPersonWorkForTests } = await import('../src/lib/personWork');
const { applySavedRunCostConfirm, resetRunCostConfirmMigration, runCostMigrationState } = await import('../src/lib/runCostConfirm');
const { useUIStore } = await import('../src/store/uiStore');

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const refusal = () => Object.assign(new Error('Only the person can do this.'), { code: 'person_required', status: 403 });

beforeEach(() => {
  api.getSettings.mockReset().mockResolvedValue({ apiKeys: {} });
  api.updateSettings.mockReset().mockResolvedValue({ status: 'ok' });
  resetPersonWorkForTests();
  resetRunCostConfirmMigration();
  session.resetPersonSessionForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  session.notePersonPromoted();
  resetPersonWorkForTests();
  vi.restoreAllMocks();
});

describe('the run-cost carry-over (PR #204 round 11)', () => {
  it('a tab connected as the person carries it over once, however often it reads', async () => {
    applySavedRunCostConfirm({ apiKeys: {} });
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    applySavedRunCostConfirm({ apiKeys: {} });
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith({ runCostConfirmUsd: useUIStore.getState().runCostConfirmUsd });
  });

  it('a held tab sends nothing on any read; the promote reads again, then sends it once', async () => {
    session.reportPersonRequired();
    for (let i = 0; i < 4; i++) applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(runCostMigrationState()).toBe('waiting');
    session.notePersonPromoted();
    await flush();
    expect(api.getSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('before the socket answers, the tab waits too (not confirmed as the person)', async () => {
    session.resetPersonSessionForTests({ unanswered: true });
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    session.notePersonPromoted();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('two tabs: one another tab already carried over is applied, not written twice', async () => {
    session.reportPersonRequired();
    applySavedRunCostConfirm({ apiKeys: {} });
    api.getSettings.mockResolvedValue({ apiKeys: {}, runCostConfirmUsd: 7 });
    session.notePersonPromoted();
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(useUIStore.getState().runCostConfirmUsd).toBe(7);
  });

  it('a refusal while sending waits for the promote; the next read does not retry it', async () => {
    api.updateSettings.mockRejectedValueOnce(refusal());
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(runCostMigrationState()).toBe('waiting');
    for (let i = 0; i < 3; i++) applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    session.notePersonPromoted();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(runCostMigrationState()).toBe('sent');
  });

  it('a refusal of a request sent before a promote that already happened goes again at once, once', async () => {
    api.updateSettings.mockRejectedValueOnce(Object.assign(refusal(), { sentBeforePromote: true }));
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.getSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(runCostMigrationState()).toBe('sent');
  });

  it('another failure (offline) is tried again on the next read, as before', async () => {
    api.updateSettings.mockRejectedValueOnce(new Error('offline'));
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(runCostMigrationState()).toBe('none');
    applySavedRunCostConfirm({ apiKeys: {} });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
  });
});

describe('whenPerson (PR #204 round 11)', () => {
  it('runs at once on a connected tab; on a held one, keyed, once on the promote', () => {
    const now = vi.fn();
    whenPerson('a', now);
    expect(now).toHaveBeenCalledTimes(1);
    session.reportPersonRequired();
    const later = vi.fn();
    whenPerson('b', later);
    whenPerson('b', later);
    expect(later).not.toHaveBeenCalled();
    expect(personWorkWaiting('b')).toBe(true);
    session.notePersonPromoted();
    session.notePersonPromoted();
    expect(later).toHaveBeenCalledTimes(1);
    expect(personWorkWaiting('b')).toBe(false);
  });
});
