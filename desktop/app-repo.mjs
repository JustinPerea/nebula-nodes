/**
 * How the packaged Nebula.app finds the repo checkout it runs from.
 *
 * The app bundle holds only a small bootstrap (packaging/bootstrap.mjs), this
 * file and `nebula-app.json`, which `npm run package` writes with the
 * absolute path of the checkout it was built from. At launch the bootstrap
 * checks that the checkout is still there, then imports the checkout's own
 * desktop/main.mjs. The Electron main code, preload, renderer
 * (frontend/dist-desktop) and backend (backend/.venv) all come from the
 * checkout, so pulling code updates the app without re-packaging (the
 * renderer still needs `npm run build:desktop` after frontend changes).
 *
 * Electron-free and dependency-injected so `node --test` can cover it.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** File the packager writes next to the bootstrap inside the bundle. */
export const APP_CONFIG_FILE_NAME = 'nebula-app.json';

/** Files the bootstrap needs in the checkout, relative to its root. */
export const REQUIRED_REPO_FILES = Object.freeze({
  main: join('desktop', 'main.mjs'),
  backend: join('backend', 'main.py'),
  python: join('backend', '.venv', 'bin', 'python'),
});

/**
 * Read and shape-check the packaged config.
 *
 * @param {string} appDir — directory holding nebula-app.json
 * @param {{ readFileSync?: typeof readFileSync }} [deps]
 * @returns {{ ok: true, config: { repoRoot: string, validation: boolean, electronVersion: string | null } }
 *   | { ok: false, problem: string, detail: string }}
 */
export function readAppConfig(appDir, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const path = join(appDir, APP_CONFIG_FILE_NAME);
  let parsed;
  try {
    parsed = JSON.parse(read(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      problem: 'This copy of Nebula is incomplete.',
      detail: `It could not read ${path} (${err.message}).\n\n` +
        'Build the app again from your Nebula checkout: cd desktop && npm run package',
    };
  }
  const repoRoot = parsed?.repoRoot;
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    return {
      ok: false,
      problem: 'This copy of Nebula is incomplete.',
      detail: `${path} does not name an absolute repo path.\n\n` +
        'Build the app again from your Nebula checkout: cd desktop && npm run package',
    };
  }
  return {
    ok: true,
    config: {
      repoRoot,
      validation: parsed.validation === true,
      electronVersion: typeof parsed.electronVersion === 'string' ? parsed.electronVersion : null,
    },
  };
}

/**
 * Check that the checkout the app was built from still has what it needs.
 *
 * @param {string} repoRoot
 * @param {{ statSync?: typeof statSync }} [deps]
 * @returns {{ ok: true } | { ok: false, problem: string, detail: string }}
 */
export function checkRepo(repoRoot, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const rebuild = 'If you moved the checkout, build the app again from its new place:\n' +
    '  cd desktop && npm run package && npm run install-app';

  const kind = (path) => {
    try {
      const s = stat(path);
      if (s.isDirectory()) return 'dir';
      if (s.isFile()) return (s.mode & 0o111) ? 'exec' : 'file';
      return 'other';
    } catch {
      return null;
    }
  };

  if (kind(repoRoot) !== 'dir') {
    return {
      ok: false,
      problem: 'Nebula can\'t find its code.',
      detail: `The Nebula checkout this app was built from is missing:\n  ${repoRoot}\n\n${rebuild}`,
    };
  }
  for (const key of ['main', 'backend']) {
    const path = join(repoRoot, REQUIRED_REPO_FILES[key]);
    if (!['file', 'exec'].includes(kind(path))) {
      return {
        ok: false,
        problem: 'Nebula can\'t find its code.',
        detail: `${repoRoot} is not a complete Nebula checkout: ${REQUIRED_REPO_FILES[key]} is missing.\n\n${rebuild}`,
      };
    }
  }
  const python = join(repoRoot, REQUIRED_REPO_FILES.python);
  if (kind(python) !== 'exec') {
    return {
      ok: false,
      problem: 'Nebula\'s backend environment is missing.',
      detail: `There is no Python virtualenv at:\n  ${python}\n\n` +
        'Create it from the checkout, then open Nebula again:\n' +
        '  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    };
  }
  return { ok: true };
}
