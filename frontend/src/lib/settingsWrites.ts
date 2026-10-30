import { isOfflineRefusal, refuseEditWhileOffline } from './backendConnection';
import { clearLineOnPromote } from './clearsOnPromote';
import { deleteSettingsApiKey, updateCredential, updateSettings } from './api';
import { PROVIDER_KEY_SPECS } from './providerCatalog';
import { RUN_COST_CONFIRM_SETTING } from './runCostConfirm';
import { useSettingsDraftStore, type SettingsDraft, type SettingsField } from '../store/settingsDraftStore';
import { useUIStore } from '../store/uiStore';
import { useProviderReadinessStore } from '../store/providerReadinessStore';

/*
 * Every Settings change saves on its own: a key when you press Save key, a
 * folder when you leave its field, a switch or choice the moment it changes.
 * Writes run one at a time so two quick edits can't land out of order, and the
 * panel shows what the backend confirmed, not what was sent.
 */

let queue: Promise<unknown> = Promise.resolve();
let noticeId = 0;
let savedMarkTimer: ReturnType<typeof setTimeout> | undefined;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation, operation);
  queue = run.catch(() => undefined);
  return run;
}

/** Mirrors the backend's GET /api/settings masking, so a saved key looks the same before and after a reload. */
export function maskKey(value: string): string {
  return value.length > 4 ? `***${value.slice(-4)}` : '***';
}

function setPending(id: string, on: boolean) {
  useSettingsDraftStore.setState((state) => {
    const pending = { ...state.pending };
    if (on) pending[id] = true; else delete pending[id];
    const errors = { ...state.errors };
    if (on) delete errors[id];
    return { pending, errors };
  });
}

function fail(id: string, message: string, error?: unknown) {
  // Round 16 (L3): a write the offline gate refused was never sent, and the
  // banner already says why, so it gets no line of its own. The draft stays.
  if (isOfflineRefusal(error)) return;
  useSettingsDraftStore.setState((state) => ({ errors: { ...state.errors, [id]: message } }));
  // GM, #204 r3: refused only because this tab isn't connected as the person
  // (the banner says so): the row's line goes on the promote.
  clearLineOnPromote(error, () => useSettingsDraftStore.getState().errors[id], message, () => {
    useSettingsDraftStore.setState((state) => {
      const errors = { ...state.errors };
      delete errors[id];
      return { errors };
    });
  });
}

function markSaved(id: string) {
  useSettingsDraftStore.setState({ justSaved: id });
  if (savedMarkTimer) clearTimeout(savedMarkTimer);
  savedMarkTimer = setTimeout(() => {
    if (useSettingsDraftStore.getState().justSaved === id) useSettingsDraftStore.setState({ justSaved: null });
  }, 1600);
}

/** Apply a confirmed change, share it with the rest of the app, and let listeners refresh. */
function confirm(update: Partial<SettingsDraft>) {
  const { saved } = useSettingsDraftStore.getState();
  if (!saved) return;
  const next = { ...saved, ...update };
  useSettingsDraftStore.setState({ saved: next });
  useUIStore.getState().setSettingsCache(next.apiKeys, next.kreaConnectionMode);
  // Readiness invalidates on this; App and the zoom recorder re-read settings.
  window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
}

function notify(message: string, undoKey?: string) {
  noticeId += 1;
  useSettingsDraftStore.setState({ notice: { id: noticeId, message, ...(undoKey ? { undoKey } : {}) } });
}

export function dismissNotice(id: number) {
  if (useSettingsDraftStore.getState().notice?.id === id) useSettingsDraftStore.setState({ notice: null });
}

function desktopCredentials() {
  return typeof window !== 'undefined' ? window.nebulaDesktop?.credentials : undefined;
}

function labelFor(key: string) {
  return PROVIDER_KEY_SPECS[key]?.label ?? key;
}

/** Save one provider key, then check it (read-only; nothing is generated). */
export function saveKey(key: string, raw: string): Promise<boolean> {
  const value = raw.trim();
  if (!value) return Promise.resolve(false);
  setPending(key, true);
  return enqueue(async () => {
    const wasConfigured = !!useSettingsDraftStore.getState().saved?.apiKeys[key]?.trim();
    // Offline, not even the Keychain is written: the backend couldn't hear
    // about it, and the two would disagree. The text stays in the field.
    if (refuseEditWhileOffline()) { setPending(key, false); return false; }
    try {
      const bridge = desktopCredentials();
      if (bridge) {
        const result = await bridge.set(key, value);
        if (!result.ok) throw new Error('Credential storage failed');
        await updateCredential(key, value);
      } else {
        await updateSettings({ apiKeys: { [key]: value } });
      }
    } catch (error) {
      setPending(key, false);
      fail(key, "The key couldn't be saved. Your text is still here; try again.", error);
      return false;
    }
    const { saved, keyDrafts, openRow } = useSettingsDraftStore.getState();
    const drafts = { ...keyDrafts };
    delete drafts[key];
    useSettingsDraftStore.setState({ keyDrafts: drafts, openRow: openRow?.id === key ? null : openRow });
    confirm({ apiKeys: { ...(saved?.apiKeys ?? {}), [key]: maskKey(value) } });
    setPending(key, false);
    notify(`${labelFor(key)} key saved. Checking it now.`, wasConfigured ? undefined : key);
    // Saving is the explicit action that checks credentials (see providerReadinessStore).
    void useProviderReadinessStore.getState().checkConnections();
    return true;
  });
}

/** Remove one provider key from disk or the Keychain. */
export function removeKey(key: string): Promise<boolean> {
  setPending(key, true);
  return enqueue(async () => {
    if (refuseEditWhileOffline()) { setPending(key, false); return false; }
    try {
      const bridge = desktopCredentials();
      if (bridge) {
        const result = await bridge.clear(key);
        if (!result.ok) throw new Error('Credential removal failed');
        await updateCredential(key, '');
      } else {
        await deleteSettingsApiKey(key);
      }
    } catch (error) {
      setPending(key, false);
      fail(key, "The key couldn't be removed. Try again.", error);
      return false;
    }
    const { saved, openRow } = useSettingsDraftStore.getState();
    const apiKeys = { ...(saved?.apiKeys ?? {}) };
    delete apiKeys[key];
    useSettingsDraftStore.setState({ openRow: openRow?.id === key ? null : openRow });
    confirm({ apiKeys });
    setPending(key, false);
    notify(`${labelFor(key)} key removed.`);
    return true;
  });
}

/** Undo a just-added key by removing it. */
export function undoAddedKey(noticeIdToUndo: number): Promise<boolean> {
  const notice = useSettingsDraftStore.getState().notice;
  if (!notice || notice.id !== noticeIdToUndo || !notice.undoKey) return Promise.resolve(false);
  useSettingsDraftStore.setState({ notice: null });
  return removeKey(notice.undoKey);
}

/** Save one setting outside API keys. Empty folders mean "use the default". */
export function saveField<F extends SettingsField>(field: F, value: SettingsDraft[F]): Promise<boolean> {
  setPending(field, true);
  return enqueue(async () => {
    const body = (field === 'outputPath' || field === 'exportFolder') ? { [field]: (value as string).trim() || null } : { [field]: value };
    try {
      await updateSettings(body);
    } catch (error) {
      setPending(field, false);
      fail(field, "Couldn't save. Try again.", error);
      return false;
    }
    if (field === 'outputPath' || field === 'exportFolder') {
      const drafts = { ...useSettingsDraftStore.getState().fieldDrafts };
      delete drafts[field as 'outputPath' | 'exportFolder'];
      useSettingsDraftStore.setState({ fieldDrafts: drafts });
    }
    confirm({ [field]: typeof value === 'string' ? value.trim() : value } as Partial<SettingsDraft>);
    setPending(field, false);
    markSaved(field);
    return true;
  });
}

/** "Ask before costly runs". The canvas uses the new value at once; it also
 * limits what agents may spend, so it is saved to settings.json too. A failed
 * write puts back the old value unless a newer choice has replaced it since. */
export function saveRunCostConfirm(value: number | null): Promise<boolean> {
  const id = RUN_COST_CONFIRM_SETTING;
  const previous = useUIStore.getState().runCostConfirmUsd;
  useUIStore.getState().setRunCostConfirmUsd(value);
  const chosen = useUIStore.getState().runCostConfirmUsd;
  setPending(id, true);
  return enqueue(async () => {
    try {
      await updateSettings({ [id]: chosen });
    } catch (error) {
      if (useUIStore.getState().runCostConfirmUsd === chosen) useUIStore.getState().setRunCostConfirmUsd(previous);
      setPending(id, false);
      fail(id, "Couldn't save. Try again.", error);
      return false;
    }
    setPending(id, false);
    markSaved(id);
    return true;
  });
}

/** For tests: forget queued writes and timers between cases. */
export function resetSettingsWrites() {
  queue = Promise.resolve();
  if (savedMarkTimer) clearTimeout(savedMarkTimer);
  savedMarkTimer = undefined;
}
