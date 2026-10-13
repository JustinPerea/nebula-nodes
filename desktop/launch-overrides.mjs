/**
 * Which launch-time environment overrides this process honours.
 *
 * The overrides below exist for development and for the validators and
 * tests that launch Electron. A packaged app is what a person double-clicks,
 * and its environment can be set from outside (`launchctl setenv`, a
 * wrapper script), so a packaged build ignores every one of them:
 *
 * - `NEBULA_DESKTOP_DEBUG_PORT` opens a CDP port.
 * - `NEBULA_DESKTOP_USER_DATA_DIR` / `NEBULA_DESKTOP_APP_ID` move the profile.
 * - `NEBULA_DESKTOP_TEST=1` (with a user-data dir) switches safeStorage to
 *   Chromium's mock keychain, whose key is a fixed, public constant. Keys
 *   saved under it are effectively unencrypted, so it is opt-in and only for
 *   throwaway test profiles. A user-data dir alone keeps the real keychain.
 * - `VITE_DEV_SERVER_URL` loads the renderer from a dev server.
 * - `NEBULA_DESKTOP_DEV_PERSON` only matters together with the dev server.
 */

/** Env vars a packaged build refuses. */
export const DEV_ONLY_ENV_VARS = Object.freeze([
  'NEBULA_DESKTOP_DEBUG_PORT',
  'NEBULA_DESKTOP_USER_DATA_DIR',
  'NEBULA_DESKTOP_APP_ID',
  'NEBULA_DESKTOP_TEST',
  'VITE_DEV_SERVER_URL',
  'NEBULA_DESKTOP_DEV_PERSON',
]);

/**
 * @param {{ env: Record<string, string | undefined>, isPackaged: boolean }} options
 * @returns {{
 *   debugPort: string | undefined,
 *   userDataDir: string | undefined,
 *   appId: string | undefined,
 *   devServerUrl: string | undefined,
 *   devPersonOptIn: string | undefined,
 *   mockKeychain: boolean,
 *   ignored: string[],
 * }}
 */
export function resolveLaunchOverrides({ env, isPackaged }) {
  const pick = (name) => {
    const value = env[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  if (isPackaged) {
    return {
      debugPort: undefined,
      userDataDir: undefined,
      appId: undefined,
      devServerUrl: undefined,
      devPersonOptIn: undefined,
      mockKeychain: false,
      ignored: DEV_ONLY_ENV_VARS.filter((name) => pick(name) !== undefined),
    };
  }

  const userDataDir = pick('NEBULA_DESKTOP_USER_DATA_DIR');
  return {
    debugPort: pick('NEBULA_DESKTOP_DEBUG_PORT'),
    userDataDir,
    appId: pick('NEBULA_DESKTOP_APP_ID'),
    devServerUrl: pick('VITE_DEV_SERVER_URL'),
    devPersonOptIn: pick('NEBULA_DESKTOP_DEV_PERSON'),
    mockKeychain: Boolean(userDataDir) && env.NEBULA_DESKTOP_TEST === '1',
    ignored: [],
  };
}
