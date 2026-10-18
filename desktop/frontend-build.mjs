/**
 * Does the built desktop frontend match the backend it is about to talk to?
 *
 * The desktop app runs the checkout's backend, but its renderer is
 * frontend/dist-desktop, which only changes when someone runs
 * `npm run build:desktop`. A `git pull` that raises PARAMS_VERSION
 * (backend/services/saved_graph_upgrades.py) updates the backend at once and
 * leaves the old bundle in place, and the backend refuses that bundle's saves
 * and runs (409 params_outdated). The tab then asks for a rebuild, but only at
 * its first save or run; a bundle built before the gate can't even say that.
 *
 * So main.mjs checks twice, before any window shows the renderer:
 *
 * 1. At launch, next to the "renderer is not built" check: the build's stamp
 *    (nebula-build.json, written by frontend/vite-plugins/buildStamp.ts) must
 *    exist and hold a version. No stamp means a build from before the stamp.
 * 2. Once the sidecar is healthy: the stamp's version must equal
 *    /api/health's `paramsVersion` (a backend that reports none is version 0).
 *
 * Dev mode (VITE_DEV_SERVER_URL) serves current source and skips both. The
 * in-tab gate stays as the backstop. Electron-free, so tests run under Node.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stamp's file name inside the renderer folder. */
export const BUILD_STAMP_FILE = 'nebula-build.json';

/** The command that fixes every failure below. */
export const REBUILD_COMMAND = 'cd frontend && npm run build:desktop';

/** A launch stopped because of the built frontend; main.mjs shows the message. */
export class FrontendBuildError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FrontendBuildError';
    this.type = details.type ?? 'frontend_build';
    this.heading = details.heading ?? 'The desktop frontend needs a rebuild';
    this.frontendVersion = details.frontendVersion;
    this.backendVersion = details.backendVersion;
  }
}

function isVersion(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The params version the renderer in `rendererDir` was built at.
 *
 * @param {string} rendererDir — frontend/dist-desktop
 * @param {{ readFileSync?: typeof readFileSync }} [deps]
 * @returns {number}
 * @throws {FrontendBuildError} when the stamp is missing, unreadable or holds no version
 */
export function readBuildParamsVersion(rendererDir, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const path = join(rendererDir, BUILD_STAMP_FILE);
  let stamp;
  try {
    stamp = JSON.parse(read(path, 'utf8'));
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    throw new FrontendBuildError(
      (missing
        ? `The desktop frontend was built by an older version of Nebula: it has no ${BUILD_STAMP_FILE}.\n`
        : `The desktop frontend's ${BUILD_STAMP_FILE} can't be read: ${path}\n`) +
        `Run \`${REBUILD_COMMAND}\`, then start Nebula again.`,
      { type: missing ? 'build_stamp_missing' : 'build_stamp_unreadable' },
    );
  }
  const version = stamp?.paramsVersion;
  if (!isVersion(version)) {
    throw new FrontendBuildError(
      `The desktop frontend's ${BUILD_STAMP_FILE} holds no valid paramsVersion: ${path}\n` +
        `Run \`${REBUILD_COMMAND}\`, then start Nebula again.`,
      { type: 'build_stamp_unreadable' },
    );
  }
  return version;
}

/**
 * The version a /api/health body reports. A Nebula backend from before the
 * field (2026-10-17) sends none: that is version 0, the same rule the
 * frontend uses (frontend/src/lib/savedParamsUpgrades.ts header).
 *
 * @param {object | null | undefined} health
 * @returns {number | null} null when the field is there but not a version
 */
export function healthParamsVersion(health) {
  const value = health?.paramsVersion;
  if (value === undefined) return 0;
  return isVersion(value) ? value : null;
}

/**
 * Compare the built frontend's version with the running backend's.
 *
 * @param {number} frontendVersion — from readBuildParamsVersion
 * @param {object | null | undefined} health — the sidecar's /api/health body
 * @returns {FrontendBuildError | null} null when they match
 */
export function checkParamsVersions(frontendVersion, health) {
  const backendVersion = healthParamsVersion(health);
  if (backendVersion === frontendVersion) return null;
  const details = { frontendVersion, backendVersion };
  if (backendVersion === null) {
    return new FrontendBuildError(
      `The backend reported a saved-params version Nebula can't read (${JSON.stringify(health?.paramsVersion)}).\n` +
        'Check that this checkout\'s backend is intact, then start Nebula again.',
      { ...details, type: 'backend_version_unreadable', heading: 'Backend startup failed' },
    );
  }
  if (frontendVersion < backendVersion) {
    return new FrontendBuildError(
      'The desktop frontend is older than the backend.\n\n' +
        `The backend was updated (saved-params version ${backendVersion}) after the frontend was built ` +
        `(version ${frontendVersion}), probably by a git pull. The old frontend can't save or run here.\n\n` +
        `Run \`${REBUILD_COMMAND}\`, then start Nebula again.`,
      { ...details, type: 'frontend_older' },
    );
  }
  return new FrontendBuildError(
    'The desktop frontend is newer than the backend.\n\n' +
      `The frontend was built from newer code (saved-params version ${frontendVersion}) than this ` +
      `checkout's backend (version ${backendVersion}), for example on another branch.\n\n` +
      `Run \`${REBUILD_COMMAND}\` from this checkout, then start Nebula again. ` +
      'Don\'t switch branches between building and starting.',
    { ...details, type: 'frontend_newer' },
  );
}
