import { isOfflineRefusal, refuseEditWhileOffline } from './backendConnection';
import { deleteSettingsApiKey, updateCredential, updateSettings } from './api';
import { RequestFailedError } from './errorCopy';
import { keyText } from './directRoute';
import { changedKeys, SETTINGS_SAVED_EVENT, type SettingsSavedDetail } from './settingsSignal';
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
  // App and the zoom recorder re-read settings; readiness clears only the
  // checks of the keys this changed (GM, PR #203 r19 item 7).
  const detail: SettingsSavedDetail = { source: 'local', keys: changedKeys(saved.apiKeys, next.apiKeys) };
  window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail }));
}

/** The backend's own line for a settings write it refused because it can't
 * read the settings file (409; main.KEYS_UNREADABLE and
 * SETTINGS_UNREADABLE, GM r22 item 3): it names the file by its full path
 * and what to fix, so the panel says it as it is, not a generic "try
 * again" the person can't act on. Any other failure keeps its own line. */
export function unreadableSettingsLine(error: unknown): string | null {
  if (!(error instanceof RequestFailedError) || error.status !== 409) return null;
  return typeof error.detail === 'string' && error.detail.startsWith('Nothing was saved because Nebula can’t read ')
    ? error.detail : null;
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

/** "Replicate key", and "Krea · API key" as it is: a row label that already
 * ends in "key" ("Krea · API key", "Krea · usage key") takes no second one.
 * A provider whose credential has its own name says it, as its links do:
 * "Hugging Face token" (GM, PR #203 r23; the spec's `credential`). */
export function keyNoun(key: string) {
  const label = labelFor(key);
  const credential = PROVIDER_KEY_SPECS[key]?.credential;
  if (credential) return `${label} ${credential}`;
  return /\bkey$/i.test(label) ? label : `${label} key`;
}

/** What an open panel says, politely, when a key is set or removed
 * somewhere else: the CLI, the API, another window (GM, PR #203 r21 item 4,
 * verbatim: "Replicate key saved." / "Replicate key removed."; never "in
 * another window", which may be false). Its own save's notice reads the
 * same, with "Checking it now." after it. */
export function keyChangedLine(key: string, set: boolean): string {
  return `${keyNoun(key)} ${set ? 'saved' : 'removed'}.`;
}

// GM (PR #203 r2): a Hugging Face token is printable ASCII with no space.
// Leading and trailing spaces, line breaks and invisible marks are trimmed
// without a word (saveKey's keyText); any other stray character is refused by
// the field. The backend's settings check and the Idol handler trim
// (node_route.key_text) and refuse the same.
export const HF_TOKEN_CHARACTER_LINE = 'This token has a character Hugging Face tokens can’t have. '
  + 'Copy it again from Hugging Face, then paste it here.';

/** The field's line for a trimmed key Settings can't store as it is, or null. */
export function keyCharacterLine(key: string, value: string): string | null {
  if (key !== 'HF_TOKEN') return null;
  return /^[\x21-\x7e]+$/.test(value) ? null : HF_TOKEN_CHARACTER_LINE;
}

/** The text Settings stores for a typed key, or null when the backend would
 * refuse it (main._key_refusal is the twin; key_text_cases.json storeCases
 * pins both): trimmed as every surface reads a key (directRoute keyText),
 * never empty, and for a Hugging Face token, printable ASCII. Checked before
 * anything is written, the macOS Keychain included, so a key the backend
 * would refuse never reaches it (review 9 of PR #203, keys NIT-2). */
export function storableKey(key: string, raw: string): string | null {
  const value = keyText(raw);
  return value && !keyCharacterLine(key, value) ? value : null;
}

/** Save one provider key, then check it (read-only; nothing is generated). */
export function saveKey(key: string, raw: string): Promise<boolean> {
  // Trimmed as every surface reads a key (directRoute keyText; review 7 of PR #203, NIT-4).
  const value = storableKey(key, raw);
  if (!value) {
    const refused = keyCharacterLine(key, keyText(raw));
    if (keyText(raw) && refused) fail(key, refused);
    return Promise.resolve(false);
  }
  setPending(key, true);
  return enqueue(async () => {
    const wasConfigured = keyText(useSettingsDraftStore.getState().saved?.apiKeys[key]) !== '';
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
      fail(key, unreadableSettingsLine(error) ?? "The key couldn't be saved. Your text is still here; try again.", error);
      return false;
    }
    const { saved, keyDrafts, openRow } = useSettingsDraftStore.getState();
    const drafts = { ...keyDrafts };
    delete drafts[key];
    useSettingsDraftStore.setState({ keyDrafts: drafts, openRow: openRow?.id === key ? null : openRow });
    confirm({ apiKeys: { ...(saved?.apiKeys ?? {}), [key]: maskKey(value) } });
    setPending(key, false);
    notify(`${keyNoun(key)} saved. Checking it now.`, wasConfigured ? undefined : key);
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
      fail(key, unreadableSettingsLine(error) ?? "The key couldn't be removed. Try again.", error);
      return false;
    }
    const { saved, openRow } = useSettingsDraftStore.getState();
    const apiKeys = { ...(saved?.apiKeys ?? {}) };
    delete apiKeys[key];
    useSettingsDraftStore.setState({ openRow: openRow?.id === key ? null : openRow });
    confirm({ apiKeys });
    setPending(key, false);
    notify(`${keyNoun(key)} removed.`);
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
      fail(field, unreadableSettingsLine(error) ?? "Couldn't save. Try again.", error);
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
      fail(id, unreadableSettingsLine(error) ?? "Couldn't save. Try again.", error);
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
