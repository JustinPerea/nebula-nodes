import { wsClient } from '../lib/wsClient';
import { SETTINGS_SAVED_EVENT, type SettingsSavedDetail } from '../lib/settingsSignal';

/**
 * Every key change reaches every one of the person's tabs (review 8 of PR
 * #203, NIT-3): the backend sends `settingsChanged` to their tabs only (never
 * to agents: review 9, keys LOW-1), with no values, after PUT /api/settings,
 * a key's DELETE and the desktop credential bridge (main.py
 * _broadcast_settings_changed). Its `keys` names the keys whose value changed
 * (names only), so connection checks are cleared for those alone (GM, PR
 * #203 r19 item 7). The tab then reads GET /api/settings again through the
 * same signal a save in this tab sends ('nebula:settings-saved'), with a
 * `detail` saying it came from elsewhere ({ source: 'remote', keys }), so
 * every cache that listens for it (the settings cache the bar, the chips and
 * the switcher read; provider readiness; the zoom manifest; an open
 * Settings panel, r19 item 6) refreshes. A token set from a second window,
 * the CLI or the desktop app flips an open proposal bar without a reload. A
 * reconnected socket reads them again too ({ source: 'reconnect' }), since a
 * change made while it was away sent nothing it heard; that read clears the
 * checks of any key it finds changed (uiStore setSettingsCache). App imports
 * this at start.
 */
export { SETTINGS_SAVED_EVENT };

wsClient.subscribe((event) => {
  if (event.type === 'settingsChanged') {
    const keys = Array.isArray(event.keys) ? event.keys.filter((key): key is string => typeof key === 'string') : undefined;
    const detail: SettingsSavedDetail = { source: 'remote', ...(keys ? { keys } : {}) };
    window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail }));
  } else if (event.type === 'socketReconnected') {
    window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { source: 'reconnect' } satisfies SettingsSavedDetail }));
  }
});

