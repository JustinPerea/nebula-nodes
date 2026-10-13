/**
 * What the packaged app's bootstrap tells the checkout's main.mjs.
 *
 * Nebula.app's bootstrap (packaging/bootstrap.mjs) imports this module from
 * the checkout, records the packaged config, and only then imports
 * main.mjs, which reads it back. ESM caches modules by URL, so both see the
 * same instance. `npm run start` never calls setPackagedLaunch, so
 * packagedLaunch() stays null there.
 */

/** @type {Readonly<{ validation: boolean, bundlePath: string | null }> | null} */
let launch = null;

/**
 * @param {{ validation?: boolean, bundlePath?: string | null }} value
 */
export function setPackagedLaunch(value) {
  if (launch) throw new Error('packaged launch already recorded');
  launch = Object.freeze({
    validation: value?.validation === true,
    bundlePath: typeof value?.bundlePath === 'string' ? value.bundlePath : null,
  });
}

export function packagedLaunch() {
  return launch;
}

/**
 * Whether launch-overrides.mjs should treat this launch as packaged
 * (ignore every dev/test override).
 *
 * A normal Nebula.app: yes. `npm run start`: no. A validation build
 * (`npm run package -- --validation`, written to desktop/out/validation/ and
 * refused by install-app) honours the overrides, so validators can launch
 * the real bundle against a throwaway profile instead of the person's data.
 *
 * @param {boolean} isPackaged — app.isPackaged
 * @param {{ validation: boolean } | null} packaged — packagedLaunch()
 */
export function treatAsPackaged(isPackaged, packaged) {
  if (!isPackaged) return false;
  return !(packaged && packaged.validation === true);
}
