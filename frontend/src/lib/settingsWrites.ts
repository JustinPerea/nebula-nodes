import { isOfflineRefusal, refuseEditWhileOffline } from './backendConnection';
import { deleteSettingsApiKey, getSettings, updateCredential, updateSettings } from './api';
import { RequestFailedError } from './errorCopy';
import { keyPhrase, keyText } from './directRoute';
import { changedKeys, SETTINGS_SAVED_EVENT, type SettingsSavedDetail } from './settingsSignal';
import { credentialNoun, PROVIDER_KEY_SPECS } from './providerCatalog';
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

/** The codes the backend puts beside a settings write's 409 (main
 * SETTINGS_UNREADABLE_CODE, KEYS_UNREADABLE_CODE, SETTINGS_UNWRITABLE_CODE,
 * SETTINGS_NOT_A_FOLDER_CODE): the file can't be read, its keys can't,
 * Nebula isn't allowed to change it or its folder (GM, PR #203 r28 item 4,
 * r31 item 1), or a file is where its folder must be (r31 item 2). */
export const SETTINGS_REFUSAL_CODES: readonly string[] = [
  'settings_unreadable', 'keys_unreadable', 'settings_unwritable', 'settings_not_a_folder',
];

/** The backend's own line for a settings write it refused over the settings
 * file itself (a 409 with one of SETTINGS_REFUSAL_CODES; GM r22 item 3, r28
 * item 4): it names the file by its path and what to do, worded for the
 * person, so the panel says it as it is, not a generic "try again" the
 * person can't act on. Picked by the code, never by the words. Any other
 * failure keeps its own line. */
export function unreadableSettingsLine(error: unknown): string | null {
  if (!(error instanceof RequestFailedError) || error.status !== 409) return null;
  return error.code && SETTINGS_REFUSAL_CODES.includes(error.code) && typeof error.detail === 'string' && error.detail
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

function bridgeInUse(): boolean {
  return desktopCredentials() !== undefined;
}

/** A Keychain write the backend then refused is undone, so the key is in
 * both or in neither whatever the order of the calls (review 13 of PR #203,
 * LOW-1): the bridge puts the entry back as it was (desktop credentials
 * `revert`; main keeps the earlier entry, the renderer never holds it).
 * When it can't, the line says what Nebula is using now instead of
 * "Nothing was saved" (keychainKeptLine). */
export type KeychainKeptCase = 'save-over' | 'save-new' | 'removal';

/** GM, PR #203 r28 item 2: what Nebula is using now, after a Keychain write
 * the backend refused and the bridge couldn't put back. `save-over` is a
 * save over a key Nebula had, `save-new` a save where it had none. Beside
 * the key's row the line says "this key"; shown as a notice, away from the
 * row, it names the key from the noun source (directRoute.keyPhrase: "your
 * OpenAI API key", "your Replicate token"). */
export function keychainKeptLine(kind: KeychainKeptCase, key: string, placement: 'row' | 'notice', fix?: string | null): string {
  const phrase = placement === 'notice' ? keyPhrase([key]) : null;
  const it = phrase ? `your ${phrase}` : 'this key';
  // GM r29 item 6: a newer refusal's own fix sentence replaces the general one.
  if (kind === 'removal') return `Nebula removed ${it} from your Keychain but is still using it. ${fix || 'Try again.'}`;
  if (kind === 'save-over') {
    return `Nebula couldn’t save ${it} and is still using the one it had. Your Keychain has the new one. ${fix || 'Try again, or remove it.'}`;
  }
  return `Nebula couldn’t save ${it}, but your Keychain has it. ${fix || 'Try again, or remove it.'}`;
}

/** GM, PR #203 r29 item 7: Nebula didn't answer (a lost answer, a 5xx), so
 * whether it took the write isn't known, and the backend couldn't say when
 * asked again. Saving or removing the same key again is safe: it writes the
 * same value, mints nothing and rotates nothing. Beside the key's row it
 * says "this key"; shown as a notice, away from the row, it names the key
 * from the noun source, as keychainKeptLine does (GM r28 item 2, r31 item
 * 5: "Nebula didn’t respond, so your Replicate token may not be removed.
 * Remove it again to be sure."). */
export function keychainUnknownLine(kind: 'save' | 'removal', key: string, placement: 'row' | 'notice'): string {
  const phrase = placement === 'notice' ? keyPhrase([key]) : null;
  const it = phrase ? `your ${phrase}` : 'this key';
  return kind === 'save'
    ? `Nebula didn’t respond, so ${it} may not be saved. Save it again to be sure.`
    : `Nebula didn’t respond, so ${it} may not be removed. Remove it again to be sure.`;
}

/** The keys whose Keychain entry and what Nebula uses still differ after a
 * kept write (keychainKeptLine): the line stays until the two agree again,
 * a later write the backend takes or a put-back (GM r29 item 6). */
const keychainDiffers = new Map<string, KeychainKeptCase>();

class KeychainKept extends Error {
  readonly kind: KeychainKeptCase;
  constructor(kind: KeychainKeptCase, cause: unknown) {
    super(`Keychain kept: ${kind}`, { cause });
    this.kind = kind;
  }
}

/** Nebula didn't answer and couldn't say afterwards whether it took the write. */
class KeychainUnknown extends Error {
  constructor(cause: unknown) {
    super('Keychain write not confirmed', { cause });
  }
}

/** A refusal that says the backend didn't take the write: a 4xx answer. A
 * 5xx or a lost answer doesn't say; the backend may hold the new key
 * already (review 14 of PR #203, keychain LOW-1). */
function definiteRefusal(error: unknown): boolean {
  return error instanceof RequestFailedError && error.status >= 400 && error.status < 500;
}

type CredentialBridge = NonNullable<ReturnType<typeof desktopCredentials>>;

/** The Keychain step, then the backend's (review 13 of PR #203, LOW-1;
 * review 14, keychain HIGH-1 and LOW-1 to LOW-3):
 * - the Keychain write failing throws, and nothing is put back (it changed
 *   nothing);
 * - the backend taking it commits the write, so nothing can undo it;
 * - a definite refusal (4xx) puts the Keychain back by the write's id, or
 *   throws KeychainKept when it can't;
 * - no answer, or a 5xx: the backend is asked what it holds now (`holds`):
 *   the new state commits, the old one puts the Keychain back as for a
 *   refusal, and when it can't say, KeychainUnknown, the Keychain left as
 *   written. */
async function keychainThenBackend(bridge: CredentialBridge, write: () => Promise<{ ok: boolean; writeId?: string }>,
  backend: () => Promise<unknown>, kept: KeychainKeptCase, holds: () => Promise<boolean | null>) {
  const result = await write();
  if (!result.ok) throw new Error('Credential storage failed');
  const writeId = result.writeId;
  const commit = async () => {
    if (!writeId) return;
    try {
      await bridge.commit?.(writeId);
    } catch {
      // The window drops it anyway (desktop credentials REVERT_WINDOW_MS).
    }
  };
  const putBack = async (error: unknown): Promise<never> => {
    let undone = false;
    try {
      undone = Boolean(writeId) && (await bridge.revert?.(writeId!))?.ok === true;
    } catch {
      undone = false;
    }
    throw undone ? error : new KeychainKept(kept, error);
  };
  try {
    await backend();
  } catch (error) {
    if (definiteRefusal(error) || isOfflineRefusal(error)) return putBack(error);
    const took = await holds().catch(() => null);
    if (took === true) return commit();
    if (took === false) return putBack(error);
    await commit();
    throw new KeychainUnknown(error);
  }
  await commit();
}

/** What GET /api/settings says the backend holds for `key` now, against
 * what the write wanted (`after`, a masked value or '' for none) and what
 * it had (`before`): true when it holds the new state, false when the old,
 * null when the two look alike or the backend doesn't answer. */
async function backendHolds(key: string, before: string, after: string): Promise<boolean | null> {
  if (before === after) return null;
  try {
    const settings = await getSettings();
    const keys = settings.apiKeys && typeof settings.apiKeys === 'object' ? settings.apiKeys as Record<string, unknown> : null;
    if (!keys) return null;
    const now = typeof keys[key] === 'string' ? keys[key] as string : '';
    return now === after ? true : now === before ? false : null;
  } catch {
    return null;
  }
}

/** The line for a desktop key write that failed: the Keychain's own state
 * first, while it still differs from what Nebula uses (GM r29 item 6), with
 * a newer refusal's fix sentence; else the backend's own settings line;
 * else `fallback`. Records or clears the difference. */
function desktopFailureLine(key: string, error: unknown, placement: 'row' | 'notice', unknown: 'save' | 'removal',
  fallback: string): string {
  if (error instanceof KeychainKept) keychainDiffers.set(key, error.kind);
  if (error instanceof KeychainUnknown) {
    keychainDiffers.delete(key);
    return keychainUnknownLine(unknown, key, placement);
  }
  const differs = keychainDiffers.get(key);
  if (differs) {
    const cause = error instanceof KeychainKept ? error.cause : error;
    return keychainKeptLine(differs, key, placement, cause instanceof RequestFailedError ? cause.fix : null);
  }
  return unreadableSettingsLine(error) ?? fallback;
}

function labelFor(key: string) {
  return PROVIDER_KEY_SPECS[key]?.label ?? key;
}

/** "fal.ai key", and "Krea · API key" as it is: a row label that already
 * ends in "key" ("Krea · API key", "Krea · usage key") takes no second one.
 * Each provider says its own noun, the word its link uses
 * (`credentialNoun`): "Hugging Face token", "Replicate token" (GM, PR #203
 * r23; r25 item 3, every provider). */
export function keyNoun(key: string) {
  const label = labelFor(key);
  const spec = PROVIDER_KEY_SPECS[key];
  // A service account's key by the noun source's name, without the row's
  // "Google ·" (GM, PR #203 r29 item 4): "Vertex AI service account key
  // saved."
  if (spec?.input === 'service-account') return keyPhrase([key]) ?? `${label} key`;
  const noun = spec ? credentialNoun(spec) : 'key';
  if (noun !== 'key') return `${label} ${noun}`;
  return /\bkey$/i.test(label) ? label : `${label} key`;
}

/** What an open panel says, politely, when a key is set or removed
 * somewhere else: another window, the desktop app, a script with the
 * person token (the CLI only reads keys). GM, PR #203 r21 item 4, with r25
 * item 3's noun: "Replicate token saved." / "Replicate token removed.";
 * never "in another window", which may be false. Its own save's notice reads the
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
        // The backend's refusal first (a settings file it can't read): the
        // key lands in both the Keychain and the backend, or in neither
        // (review 12 of PR #203, LOW-3).
        await updateCredential(key, value, { check: true });
        const before = keyText(useSettingsDraftStore.getState().saved?.apiKeys[key]);
        await keychainThenBackend(bridge, () => bridge.set(key, value), () => updateCredential(key, value),
          wasConfigured ? 'save-over' : 'save-new', () => backendHolds(key, before, maskKey(value)));
        keychainDiffers.delete(key);
      } else {
        await updateSettings({ apiKeys: { [key]: value } });
      }
    } catch (error) {
      setPending(key, false);
      const fallback = "The key couldn't be saved. Your text is still here; try again.";
      fail(key, bridgeInUse() ? desktopFailureLine(key, error, 'row', 'save', fallback)
        : unreadableSettingsLine(error) ?? fallback, error);
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

/** Remove one provider key from disk or the Keychain. `from` is where the
 * person asked: the key's row, or a notice's Undo (the row is closed then,
 * so a failure is said in a notice, the key named; GM, PR #203 r28 item 2). */
export function removeKey(key: string, from: 'row' | 'notice' = 'row'): Promise<boolean> {
  setPending(key, true);
  return enqueue(async () => {
    if (refuseEditWhileOffline()) { setPending(key, false); return false; }
    try {
      const bridge = desktopCredentials();
      if (bridge) {
        await updateCredential(key, '', { check: true });
        const before = keyText(useSettingsDraftStore.getState().saved?.apiKeys[key]);
        await keychainThenBackend(bridge, () => bridge.clear(key), () => updateCredential(key, ''), 'removal',
          () => backendHolds(key, before, ''));
        keychainDiffers.delete(key);
      } else {
        await deleteSettingsApiKey(key);
      }
    } catch (error) {
      setPending(key, false);
      const fallback = "The key couldn't be removed. Try again.";
      const line = bridgeInUse() ? desktopFailureLine(key, error, from, 'removal', fallback)
        : unreadableSettingsLine(error) ?? fallback;
      if (from === 'notice') {
        if (!isOfflineRefusal(error)) notify(line);
      } else {
        fail(key, line, error);
      }
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
  return removeKey(notice.undoKey, 'notice');
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
  keychainDiffers.clear();
  if (savedMarkTimer) clearTimeout(savedMarkTimer);
  savedMarkTimer = undefined;
}
