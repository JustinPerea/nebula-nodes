/** Names shared by scripts/package.mjs and scripts/install-app.mjs. */

/** The .app name, Finder/Dock label and CFBundleName. */
export const APP_NAME = 'Nebula';

/**
 * CFBundleIdentifier. Derived from the Electron app name `nebula-desktop`
 * (desktop/package.json), which names the profile directory, the
 * single-instance lock and the safeStorage keychain item; the bundle keeps
 * that name so Nebula.app and `npm run start` share all three.
 */
export const APP_BUNDLE_ID = 'com.nebulanodes.nebula-desktop';
