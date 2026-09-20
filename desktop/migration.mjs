/**
 * Electron-free, dependency-injected one-time migration module.
 *
 * On first desktop launch (no credentials.json in App Support), this module:
 *   1. Reads legacy <repo>/settings.json
 *   2. Encrypts each non-empty API key via safeStorage → credentials.json
 *   3. Writes a new settings.json to App Support with apiKeys: {}
 *   4. Copies ~/.nebula/* and <repo>/output/ to App Support (never deletes source)
 *   5. Writes a migration completion marker (migration-state.json)
 *
 * The module is idempotent — repeated runs do not duplicate or overwrite
 * destination files that already exist. Source data is never modified or
 * deleted.
 *
 * Does NOT import Electron. Accepts injectable safeStorage and filesystem
 * dependencies for testability with Node's built-in test runner.
 */

import { join } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  stat,
} from 'node:fs/promises';

import {
  CREDENTIALS_FILE_NAME,
  MIGRATION_STATE_FILE_NAME,
  isProviderAllowed,
  isSafeStorageAvailable,
  encryptValue,
  decryptValue,
  readCredentialsStore,
  writeCredentialsStore,
  readMigrationState,
  writeMigrationState,
} from './credentials.mjs';

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

/** Legacy data directories to copy from ~/.nebula/ to App Support. */
export const LEGACY_DATA_SUBDIRS = ['characters', 'moodboards', 'presets'];

/** Legacy state files to copy from ~/.nebula/ to App Support state/. */
export const LEGACY_STATE_FILES = [
  'state.json',
  'provider-recoveries.json',
  'provider-start-ambiguities.json',
];

/** Settings field name for API keys. */
export const API_KEYS_FIELD = 'apiKeys';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class MigrationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.step = details.step;
    this.cause = details.cause;
  }
}

// ---------------------------------------------------------------------------
// Plaintext key detection
// ---------------------------------------------------------------------------

/**
 * Check whether a settings object has any non-empty API key values.
 *
 * Used on every desktop launch to detect plaintext keys left in
 * settings.json after migration (e.g., user manually edited the file).
 *
 * @param {Record<string, unknown>} settings
 * @returns {{ hasPlaintext: boolean, providers: string[] }}
 */
export function detectPlaintextKeys(settings) {
  if (!settings || typeof settings !== 'object') {
    return { hasPlaintext: false, providers: [] };
  }
  const apiKeys = settings[API_KEYS_FIELD];
  if (!apiKeys || typeof apiKeys !== 'object') {
    return { hasPlaintext: false, providers: [] };
  }
  const providers = [];
  for (const [key, value] of Object.entries(apiKeys)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      providers.push(key);
    }
  }
  return {
    hasPlaintext: providers.length > 0,
    providers,
  };
}

/**
 * Read a settings.json file and check for plaintext API keys.
 *
 * @param {string} settingsPath
 * @param {{ readFile?: typeof readFile, existsSync?: typeof existsSync }} [deps]
 * @returns {Promise<{ hasPlaintext: boolean, providers: string[] }>}
 */
export async function detectPlaintextKeysInFile(settingsPath, deps = {}) {
  const read = deps.readFile ?? readFile;
  const exists = deps.existsSync ?? existsSync;
  if (!exists(settingsPath)) {
    return { hasPlaintext: false, providers: [] };
  }
  try {
    const raw = await read(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    return detectPlaintextKeys(settings);
  } catch {
    return { hasPlaintext: false, providers: [] };
  }
}

// ---------------------------------------------------------------------------
// Directory copy (idempotent, non-destructive)
// ---------------------------------------------------------------------------

/**
 * Copy a directory tree recursively, skipping files that already exist
 * at the destination. Never overwrites an existing destination file.
 * Never deletes or modifies source files.
 *
 * Uses async fs/promises methods so the Electron main event loop stays
 * responsive during large copies (VAL-UX-001, VAL-MIG-010).
 *
 * @param {string} srcDir — source directory (must exist)
 * @param {string} destDir — destination directory (created if missing)
 * @param {{ existsSync?: Function, mkdir?: Function, readdir?: Function, copyFile?: Function, stat?: Function }} [deps]
 * @returns {Promise<{ copied: string[], skipped: string[] }>}
 */
export async function copyDirectoryTree(srcDir, destDir, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const mkdirFn = deps.mkdir ?? mkdir;
  const readdirFn = deps.readdir ?? readdir;
  const copyFileFn = deps.copyFile ?? copyFile;
  const statFn = deps.stat ?? stat;

  const copied = [];
  const skipped = [];

  if (!exists(srcDir)) {
    return { copied, skipped };
  }

  await mkdirFn(destDir, { recursive: true });

  const entries = await readdirFn(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const entryStat = await statFn(srcPath);

    if (entryStat.isDirectory()) {
      const sub = await copyDirectoryTree(srcPath, destPath, deps);
      copied.push(...sub.copied);
      skipped.push(...sub.skipped);
    } else {
      if (exists(destPath)) {
        skipped.push(destPath);
      } else {
        await copyFileFn(srcPath, destPath);
        copied.push(destPath);
      }
    }
  }

  return { copied, skipped };
}

/**
 * Copy individual files from a source directory to a destination directory.
 * Skips files that don't exist at the source or already exist at the
 * destination. Never overwrites.
 *
 * Uses async fs/promises methods so the Electron main event loop stays
 * responsive during large copies (VAL-UX-001, VAL-MIG-010).
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string[]} fileNames
 * @param {{ existsSync?: Function, mkdir?: Function, copyFile?: Function }} [deps]
 * @returns {Promise<{ copied: string[], skipped: string[] }>}
 */
export async function copyFiles(srcDir, destDir, fileNames, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const mkdirFn = deps.mkdir ?? mkdir;
  const copyFileFn = deps.copyFile ?? copyFile;

  const copied = [];
  const skipped = [];

  await mkdirFn(destDir, { recursive: true });

  for (const fileName of fileNames) {
    const srcPath = join(srcDir, fileName);
    const destPath = join(destDir, fileName);
    if (!exists(srcPath)) {
      continue;
    }
    if (exists(destPath)) {
      skipped.push(destPath);
    } else {
      await copyFileFn(srcPath, destPath);
      copied.push(destPath);
    }
  }

  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// Migration orchestration
// ---------------------------------------------------------------------------

/**
 * Determine whether migration is needed.
 *
 * Migration is needed when:
 *   - No migration-state.json exists, OR
 *   - migration-state.json status is not 'complete'
 *
 * If credentials.json already exists AND migration-state.json says
 * 'complete', migration is skipped (idempotent).
 *
 * @param {string} migrationStatePath
 * @param {{ readFileSync?: Function, existsSync?: Function }} [deps]
 * @returns {boolean}
 */
export function isMigrationNeeded(migrationStatePath, deps = {}) {
  const state = readMigrationState(migrationStatePath, deps);
  return state.status !== 'complete';
}

/**
 * Run the one-time migration flow.
 *
 * Steps (each idempotent — safe to re-run after partial failure):
 *   1. Encrypt legacy API keys → credentials.json
 *   2. Write migrated settings.json with apiKeys: {}
 *   3. Copy state files (~/.nebula/*.json → App Support/state/)
 *   4. Copy data directories (~/.nebula/{characters,moodboards,presets}/ → App Support/)
 *   5. Copy output directory (<repo>/output/ → App Support/output/)
 *   6. Write migration completion marker
 *
 * Source files are NEVER modified or deleted. Destination files that
 * already exist are NEVER overwritten.
 *
 * @param {{
 *   appDataRoot: string,
 *   legacySettingsPath: string,
 *   legacyNebulaDir: string,
 *   legacyOutputDir: string,
 *   safeStorage: object,
 *   fs?: { existsSync?: Function, readFile?: Function, writeFile?: Function, mkdir?: Function, readdir?: Function, copyFile?: Function, stat?: Function, readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function },
 *   onProgress?: (step: string, detail?: unknown) => void,
 * }} options
 * @returns {Promise<{ ok: true, migrated: { keys: string[], settings: boolean, stateFiles: string[], dataDirs: string[], output: boolean } }>}
 * @throws {MigrationError}
 */
export async function runMigration(options) {
  const {
    appDataRoot,
    legacySettingsPath,
    legacyNebulaDir,
    legacyOutputDir,
    safeStorage,
    onProgress = () => {},
  } = options;

  const fsDeps = options.fs ?? {};

  // Async filesystem operations for copy and settings I/O.
  // These yield to the event loop on each operation, keeping the
  // Electron main process responsive during large copies
  // (VAL-UX-001, VAL-MIG-010).
  const asyncFs = {
    existsSync: fsDeps.existsSync ?? existsSync,
    readFile: fsDeps.readFile ?? readFile,
    writeFile: fsDeps.writeFile ?? writeFile,
    mkdir: fsDeps.mkdir ?? mkdir,
    readdir: fsDeps.readdir ?? readdir,
    copyFile: fsDeps.copyFile ?? copyFile,
    stat: fsDeps.stat ?? stat,
  };

  // Sync filesystem operations for credentials.mjs store functions.
  // These handle tiny JSON files (credentials.json, migration-state.json)
  // where sync I/O is acceptable and keeps credentials.mjs unchanged.
  const syncFs = {
    readFileSync: fsDeps.readFileSync ?? readFileSync,
    writeFileSync: fsDeps.writeFileSync ?? writeFileSync,
    existsSync: fsDeps.existsSync ?? existsSync,
    mkdirSync: fsDeps.mkdirSync ?? mkdirSync,
  };

  const credentialsPath = join(appDataRoot, CREDENTIALS_FILE_NAME);
  const migrationStatePath = join(appDataRoot, MIGRATION_STATE_FILE_NAME);
  const newSettingsPath = join(appDataRoot, 'settings.json');
  const stateDir = join(appDataRoot, 'state');
  const outputDir = join(appDataRoot, 'output');

  const result = {
    ok: true,
    migrated: {
      keys: [],
      settings: false,
      stateFiles: [],
      dataDirs: [],
      output: false,
    },
  };

  // Check safeStorage availability before any encryption
  const storageAvailable = await isSafeStorageAvailable(safeStorage);
  if (!storageAvailable) {
    throw new MigrationError(
      'safeStorage is not available — cannot encrypt credentials during migration',
      'SAFE_STORAGE_UNAVAILABLE',
      { step: 'encrypt-keys' },
    );
  }

  // --- Step 1: Encrypt legacy API keys → credentials.json ---
  onProgress('encrypt-keys');

  let legacySettings = {};
  if (asyncFs.existsSync(legacySettingsPath)) {
    try {
      const raw = await asyncFs.readFile(legacySettingsPath, 'utf8');
      legacySettings = JSON.parse(raw);
    } catch (err) {
      throw new MigrationError(
        `Failed to read legacy settings: ${err.message}`,
        'READ_LEGACY_SETTINGS_FAILED',
        { step: 'encrypt-keys', cause: err },
      );
    }
  }

  const legacyApiKeys = legacySettings[API_KEYS_FIELD] ?? {};
  const store = readCredentialsStore(credentialsPath, syncFs);

  for (const [provider, value] of Object.entries(legacyApiKeys)) {
    if (!isProviderAllowed(provider)) continue;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    // Skip if already encrypted (idempotent)
    if (provider in store.providers) {
      continue;
    }
    try {
      const encrypted = await encryptValue(value, safeStorage);
      store.providers[provider] = encrypted;
      result.migrated.keys.push(provider);
    } catch (err) {
      throw new MigrationError(
        `Failed to encrypt key for ${provider}: ${err.message}`,
        'ENCRYPT_KEY_FAILED',
        { step: 'encrypt-keys', cause: err },
      );
    }
  }

  // Only write if we added new providers
  if (result.migrated.keys.length > 0) {
    writeCredentialsStore(credentialsPath, store, syncFs);
  }

  // --- Step 2: Write migrated settings.json with apiKeys: {} ---
  onProgress('write-settings');

  if (!asyncFs.existsSync(newSettingsPath)) {
    const migratedSettings = { ...legacySettings };
    migratedSettings[API_KEYS_FIELD] = {};

    try {
      // Ensure root exists
      await asyncFs.mkdir(appDataRoot, { recursive: true });
      await asyncFs.writeFile(newSettingsPath, JSON.stringify(migratedSettings, null, 2) + '\n', 'utf8');
      result.migrated.settings = true;
    } catch (err) {
      throw new MigrationError(
        `Failed to write migrated settings: ${err.message}`,
        'WRITE_SETTINGS_FAILED',
        { step: 'write-settings', cause: err },
      );
    }
  }

  // Yield to the event loop between major steps so the Electron main
  // process can process renderer paint events (VAL-UX-001, VAL-MIG-010).
  await new Promise((resolve) => setImmediate(resolve));

  // --- Step 3: Copy state files ---
  onProgress('copy-state');

  const stateResult = await copyFiles(
    legacyNebulaDir,
    stateDir,
    LEGACY_STATE_FILES,
    asyncFs,
  );
  result.migrated.stateFiles = stateResult.copied;

  // Yield between copy steps
  await new Promise((resolve) => setImmediate(resolve));

  // --- Step 4: Copy data directories ---
  onProgress('copy-data');

  for (const subdir of LEGACY_DATA_SUBDIRS) {
    const srcDir = join(legacyNebulaDir, subdir);
    const destDir = join(appDataRoot, subdir);
    const dirResult = await copyDirectoryTree(srcDir, destDir, asyncFs);
    if (dirResult.copied.length > 0) {
      result.migrated.dataDirs.push(subdir);
    }
    // Yield between each data subdirectory copy
    await new Promise((resolve) => setImmediate(resolve));
  }

  // --- Step 5: Copy output directory ---
  onProgress('copy-output');

  if (asyncFs.existsSync(legacyOutputDir)) {
    const outputResult = await copyDirectoryTree(legacyOutputDir, outputDir, asyncFs);
    result.migrated.output = outputResult.copied.length > 0 || outputResult.skipped.length > 0;
  }

  // Yield before writing the completion marker
  await new Promise((resolve) => setImmediate(resolve));

  // --- Step 6: Write migration completion marker ---
  onProgress('write-marker');

  try {
    writeMigrationState(
      migrationStatePath,
      { status: 'complete', timestamp: new Date().toISOString() },
      syncFs,
    );
  } catch (err) {
    throw new MigrationError(
      `Failed to write migration marker: ${err.message}`,
      'WRITE_MARKER_FAILED',
      { step: 'write-marker', cause: err },
    );
  }

  onProgress('complete', result.migrated);
  return result;
}

/**
 * Decrypt all credentials for sidecar injection.
 *
 * Convenience wrapper around credentialService.decryptAll() that reads
 * the credentials store and returns a plain key-value dict of decrypted
 * API keys. Used by main.mjs to build NEBULA_INJECTED_KEYS.
 *
 * @param {string} credentialsPath
 * @param {object} safeStorage
 * @param {{ readFileSync?: Function, existsSync?: Function }} [deps]
 * @returns {Promise<Record<string, string>>}
 */
export async function decryptAllCredentials(credentialsPath, safeStorage, deps = {}) {
  const fileDeps = {
    readFileSync: deps.readFileSync ?? readFileSync,
    existsSync: deps.existsSync ?? existsSync,
  };
  const store = readCredentialsStore(credentialsPath, fileDeps);
  /** @type {Record<string, string>} */
  const result = {};
  for (const [provider, blob] of Object.entries(store.providers)) {
    if (!isProviderAllowed(provider)) continue;
    try {
      const { result: plaintext } = await decryptValue(blob, safeStorage);
      result[provider] = plaintext;
    } catch {
      // Skip providers that cannot be decrypted
    }
  }
  return result;
}
