/**
 * The window signals a settings change sends in this tab (no imports, so
 * any store can read them: store/settingsChangedSocket.ts sends them for the
 * backend's `settingsChanged`, lib/settingsWrites.ts for a save here).
 */

/** The settings changed: every cache reads them again. */
export const SETTINGS_SAVED_EVENT = 'nebula:settings-saved';

/** Where a settings signal came from: 'local' for a save in this tab,
 * 'remote' for the backend's signal, 'reconnect' for a socket that came
 * back or was just promoted (a change it may have missed). `keys` lists
 * the keys whose value changed, when it is known (names only, never a
 * value). */
export interface SettingsSavedDetail {
  source: 'remote' | 'reconnect' | 'local';
  keys?: string[];
}

/** The detail of a settings signal, or null for one with none (an older sender). */
export function settingsSavedDetail(event: Event): SettingsSavedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const { source, keys } = detail as Record<string, unknown>;
  if (source !== 'remote' && source !== 'reconnect' && source !== 'local') return null;
  return { source, ...(Array.isArray(keys) ? { keys: keys.filter((key): key is string => typeof key === 'string') } : {}) };
}

/** The key names whose masked value differs between two reads of the keys. */
export function changedKeys(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => (before[key] ?? '') !== (after[key] ?? '')).sort();
}
