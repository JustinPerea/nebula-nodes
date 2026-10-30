import { wsClient } from '../lib/wsClient';

/**
 * Every key change reaches every tab (review 8 of PR #203, NIT-3): the
 * backend sends `settingsChanged`, with no values, after PUT /api/settings,
 * a key's DELETE and the desktop credential bridge (main.py
 * _broadcast_settings_changed). The tab then reads GET /api/settings again
 * through the same signal a save in this tab sends ('nebula:settings-saved'),
 * so every cache that listens for it (the settings cache the bar, the chips
 * and the switcher read; provider readiness; the zoom manifest) refreshes. A
 * token set from a second window, the CLI or the desktop app flips an open
 * proposal bar without a reload. A reconnected socket reads them again too,
 * since a change made while it was away sent nothing it heard. App imports
 * this at start.
 */
export const SETTINGS_SAVED_EVENT = 'nebula:settings-saved';

wsClient.subscribe((event) => {
  if (event.type === 'settingsChanged' || event.type === 'socketReconnected') {
    window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT));
  }
});
