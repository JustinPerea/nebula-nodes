/**
 * Electron-free, dependency-injected App Support path computation module.
 *
 * Computes the macOS Application Support directory for Nebula Nodes,
 * creates the required subdirectory tree, and builds the NEBULA_* path
 * environment variables for the sidecar child process.
 *
 * Does NOT import Electron. Accepts injectable filesystem dependencies
 * so Node's built-in test runner can verify path computation and env
 * injection deterministically without touching the real home directory.
 *
 * In browser/dev mode (no Electron), none of these env vars are set —
 * the backend uses its default paths (~/.nebula/, <repo>/output/,
 * <repo>/settings.json). This module is only called from Electron's
 * main process before spawning the sidecar.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

/** Application Support subdirectory name for Nebula Nodes. */
export const APP_DATA_DIR_NAME = 'Nebula Nodes';

/** Required subdirectories under the app data root. */
export const APP_DATA_SUBDIRS = [
  'state',
  'output',
  'characters',
  'moodboards',
  'presets',
];

/** NEBULA_* path env var names injected into the sidecar environment. */
export const NEBULA_PATH_ENV_VARS = [
  'NEBULA_STATE_DIR',
  'NEBULA_OUTPUT_ROOT',
  'NEBULA_CHARACTER_ROOT',
  'NEBULA_MOODBOARD_ROOT',
  'NEBULA_PRESET_ROOT',
  'NEBULA_SETTINGS_PATH',
];

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

/**
 * Compute the App Support root for Nebula Nodes.
 *
 * @param {{home?: string}} [options]
 * @returns {string} absolute path to ~/Library/Application Support/Nebula Nodes/
 */
export function computeAppDataRoot(options = {}) {
  const home = options.home ?? homedir();
  return join(home, 'Library', 'Application Support', APP_DATA_DIR_NAME);
}

/**
 * Where this launch keeps its data, and where the one-time migration reads
 * legacy data from.
 *
 * A normal launch uses ~/Library/Application Support/Nebula Nodes/ and
 * migrates from the repo's settings.json, ~/.nebula and <repo>/output.
 *
 * An isolated launch (NEBULA_DESKTOP_USER_DATA_DIR set, which tests and
 * validators use) keeps everything inside that directory: its app data root
 * is <userDataDir>/Nebula Nodes and its legacy sources are
 * <userDataDir>/legacy/... (normally absent, so nothing is migrated). Without
 * this, an "isolated" launch wrote state, connector keys and migration
 * markers into the person's real App Support and read the repo's real
 * settings.json (API keys) into a throwaway profile.
 *
 * @param {{ userDataDir?: string, home?: string, repoRoot: string }} options
 * @returns {{ isolated: boolean, appDataRoot: string, legacy: { settingsPath: string, nebulaDir: string, outputDir: string } }}
 */
export function resolveDesktopDataPaths({ userDataDir, home, repoRoot }) {
  if (userDataDir) {
    const legacyRoot = join(userDataDir, 'legacy');
    return {
      isolated: true,
      appDataRoot: join(userDataDir, APP_DATA_DIR_NAME),
      legacy: {
        settingsPath: join(legacyRoot, 'settings.json'),
        nebulaDir: join(legacyRoot, '.nebula'),
        outputDir: join(legacyRoot, 'output'),
      },
    };
  }
  const realHome = home ?? homedir();
  return {
    isolated: false,
    appDataRoot: computeAppDataRoot({ home: realHome }),
    legacy: {
      settingsPath: join(repoRoot, 'settings.json'),
      nebulaDir: join(realHome, '.nebula'),
      outputDir: join(repoRoot, 'output'),
    },
  };
}

// ---------------------------------------------------------------------------
// Directory tree creation
// ---------------------------------------------------------------------------

/**
 * Ensure the App Support directory tree exists.
 *
 * Creates the root directory and all required subdirectories. Idempotent —
 * safe to call when directories already exist. Must be called BEFORE
 * spawning the sidecar so the backend finds the directories on first access.
 *
 * @param {string} root — absolute path to the app data root
 * @param {{mkdirSync?: typeof mkdirSync}} [deps]
 * @returns {string[]} all created (or pre-existing) directory paths
 */
export function ensureAppDataDirs(root, deps = {}) {
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const dirs = [root, ...APP_DATA_SUBDIRS.map((sub) => join(root, sub))];
  for (const dir of dirs) {
    mkdir(dir, { recursive: true });
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Environment variable injection
// ---------------------------------------------------------------------------

/**
 * Build the NEBULA_* path environment variables for the sidecar.
 *
 * Returns a plain object suitable for merging into the child process
 * environment. Does NOT mutate process.env — the caller (main.mjs)
 * merges these into the env passed to startSidecar().
 *
 * In browser/dev mode this function is never called; the backend uses
 * its default paths.
 *
 * @param {string} root — absolute path to the app data root
 * @returns {Record<string, string>} env var key-value pairs
 */
export function buildSidecarEnvVars(root) {
  return {
    NEBULA_STATE_DIR: join(root, 'state'),
    NEBULA_OUTPUT_ROOT: join(root, 'output'),
    NEBULA_CHARACTER_ROOT: join(root, 'characters'),
    NEBULA_MOODBOARD_ROOT: join(root, 'moodboards'),
    NEBULA_PRESET_ROOT: join(root, 'presets'),
    NEBULA_SETTINGS_PATH: join(root, 'settings.json'),
  };
}

// ---------------------------------------------------------------------------
// Combined prepare function
// ---------------------------------------------------------------------------

/**
 * Prepare the App Support directory tree and build sidecar env vars.
 *
 * Convenience function that calls computeAppDataRoot, ensureAppDataDirs,
 * and buildSidecarEnvVars in sequence. The directory tree is created
 * BEFORE the env vars are returned, ensuring the sidecar finds all
 * directories on first access.
 *
 * @param {{home?: string, root?: string, mkdirSync?: typeof mkdirSync}} [options]
 *   `root` overrides the computed App Support root (isolated launches).
 * @returns {{root: string, envVars: Record<string, string>}}
 */
export function prepareAppDataEnv(options = {}) {
  const root = options.root ?? computeAppDataRoot({ home: options.home });
  ensureAppDataDirs(root, { mkdirSync: options.mkdirSync });
  const envVars = buildSidecarEnvVars(root);
  return { root, envVars };
}
