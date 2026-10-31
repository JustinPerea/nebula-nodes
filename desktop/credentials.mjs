/**
 * Electron-free, dependency-injected credential service module.
 *
 * Uses safeStorage async API (encryptStringAsync / decryptStringAsync) for
 * encryption. Stores encrypted blobs as `v1:<base64>` strings in
 * `credentials.json` under the App Support root. Does NOT import Electron —
 * safeStorage and ipcMain are dependency-injected for testability with
 * Node's built-in test runner.
 *
 * Security invariants:
 *   - No `credentials:get` channel — renderer never receives plaintext keys.
 *   - Provider names validated against an 18-key allowlist on every handler.
 *   - Sender validated on every IPC handler.
 *   - No plaintext fallback when safeStorage is unavailable (fail closed).
 *   - Encrypted blobs never logged or included in diagnostics.
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Published constants
// ---------------------------------------------------------------------------

/**
 * The 22 provider keys that may be stored in the credential service.
 * Mirrors backend/services/credential_catalog.py CREDENTIAL_PROVIDERS
 * (desktop/tests/sidecar.test.mjs checks they match). sidecar.mjs also strips
 * these names from the sidecar's environment.
 */
export const ALLOWED_PROVIDERS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'BFL_API_KEY',
  'BYTEPLUS_API_KEY',
  'ELEVENLABS_API_KEY',
  'FAL_KEY',
  'GOOGLE_API_KEY',
  'HIGGSFIELD_API_KEY',
  'IDEOGRAM_API_KEY',
  'KREA_API_TOKEN',
  'MESHY_API_KEY',
  'MINIMAX_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'QUIVER_API_KEY',
  'REPLICATE_API_TOKEN',
  'RUNWAY_API_KEY',
  'TYPESAFE_API_KEY',
  'XAI_API_KEY',
  'WORLDLABS_API_KEY',
  'KREA_USAGE_KEY',
  'GOOGLE_VERTEX_CREDENTIALS',
  'HF_TOKEN',
]);

/** Prefix for the encrypted-blob wire format. */
export const V1_PREFIX = 'v1:';

/** Credentials file name within App Support. */
export const CREDENTIALS_FILE_NAME = 'credentials.json';

/** Migration-state file name within App Support. */
export const MIGRATION_STATE_FILE_NAME = 'migration-state.json';

/** Credentials file format version. */
export const CREDENTIALS_VERSION = 1;

/** Valid migration status values. */
export const MIGRATION_STATUSES = Object.freeze([
  'pending',
  'in-progress',
  'complete',
  'failed',
]);

/** How long a write may still be undone by `revert` before it is dropped. */
export const REVERT_WINDOW_MS = 60_000;

/** The complete set of credential IPC channels (no `credentials:get`). */
export const CREDENTIAL_CHANNELS = Object.freeze([
  'credentials:set',
  'credentials:has',
  'credentials:clear',
  'credentials:revert',
  'credentials:commit',
  'credentials:migration-status',
  'credentials:retry-migration',
]);

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class CredentialError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export class SafeStorageUnavailableError extends CredentialError {
  constructor(
    message = 'safeStorage is not available — cannot encrypt credentials',
  ) {
    super(message, 'SAFE_STORAGE_UNAVAILABLE');
    this.name = 'SafeStorageUnavailableError';
  }
}

export class UnknownProviderError extends CredentialError {
  constructor(provider) {
    super(`Unknown provider: ${String(provider)}`, 'UNKNOWN_PROVIDER');
    this.name = 'UnknownProviderError';
  }
}

export class UntrustedSenderError extends CredentialError {
  constructor(message = 'Untrusted sender — IPC invocation rejected') {
    super(message, 'UNTRUSTED_SENDER');
    this.name = 'UntrustedSenderError';
  }
}

// ---------------------------------------------------------------------------
// Provider validation
// ---------------------------------------------------------------------------

/**
 * Check if a provider name is in the 18-key allowlist.
 *
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderAllowed(provider) {
  return (
    typeof provider === 'string' && ALLOWED_PROVIDERS.includes(provider)
  );
}

// ---------------------------------------------------------------------------
// Sender validation
// ---------------------------------------------------------------------------

/**
 * Create a sender validator that checks the sender frame URL against
 * allowed origin prefixes.
 *
 * In production the renderer loads from `file://`; in dev mode from
 * `http://localhost:5173`. Any other origin (external page, iframe with
 * a different origin) is rejected.
 *
 * @param {string[]} allowedOrigins — URL prefixes to accept
 * @returns {(event: import('electron').IpcMainInvokeEvent) => boolean}
 */
export function createSenderValidator(allowedOrigins) {
  return function validateSender(event) {
    if (!event || !event.senderFrame) return false;
    const url = event.senderFrame.url;
    if (typeof url !== 'string' || url.length === 0) return false;
    return allowedOrigins.some((origin) => url.startsWith(origin));
  };
}

// ---------------------------------------------------------------------------
// safeStorage availability
// ---------------------------------------------------------------------------

/**
 * Check if safeStorage async encryption is available.
 *
 * Handles both sync and async return from `isAsyncEncryptionAvailable()`
 * and falls back to the sync `isEncryptionAvailable()` if the async
 * variant is not present.
 *
 * @param {object} safeStorage
 * @returns {Promise<boolean>}
 */
export async function isSafeStorageAvailable(safeStorage) {
  if (!safeStorage) return false;
  if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
    const result = safeStorage.isAsyncEncryptionAvailable();
    return typeof result === 'boolean' ? result : await result;
  }
  if (typeof safeStorage.isEncryptionAvailable === 'function') {
    return safeStorage.isEncryptionAvailable();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string to `v1:<base64>` format.
 *
 * @param {string} plaintext
 * @param {object} safeStorage
 * @returns {Promise<string>} encrypted blob in `v1:<base64>` format
 * @throws {SafeStorageUnavailableError} when safeStorage is not available
 */
export async function encryptValue(plaintext, safeStorage) {
  const available = await isSafeStorageAvailable(safeStorage);
  if (!available) {
    throw new SafeStorageUnavailableError();
  }
  const buffer = await safeStorage.encryptStringAsync(plaintext);
  const base64 = buffer.toString('base64');
  return `${V1_PREFIX}${base64}`;
}

/**
 * Decrypt a `v1:<base64>` blob back to plaintext.
 *
 * @param {string} blob
 * @param {object} safeStorage
 * @returns {Promise<{ result: string, shouldReEncrypt: boolean }>}
 * @throws {CredentialError} when the blob format is unsupported
 * @throws {SafeStorageUnavailableError} when safeStorage is not available
 */
export async function decryptValue(blob, safeStorage) {
  if (typeof blob !== 'string' || !blob.startsWith(V1_PREFIX)) {
    throw new CredentialError(
      `Unsupported credential format (expected ${V1_PREFIX} prefix)`,
      'BAD_FORMAT',
    );
  }
  const available = await isSafeStorageAvailable(safeStorage);
  if (!available) {
    throw new SafeStorageUnavailableError();
  }
  const base64 = blob.slice(V1_PREFIX.length);
  const buffer = Buffer.from(base64, 'base64');
  const decrypted = await safeStorage.decryptStringAsync(buffer);
  // Handle both { result, shouldReEncrypt } and plain-string returns
  if (typeof decrypted === 'string') {
    return { result: decrypted, shouldReEncrypt: false };
  }
  return {
    result: decrypted.result,
    shouldReEncrypt: decrypted.shouldReEncrypt ?? false,
  };
}

// ---------------------------------------------------------------------------
// Credential store (file I/O)
// ---------------------------------------------------------------------------

/**
 * Read the credentials store from disk.
 *
 * Returns `{ version, providers: {} }` when the file does not exist,
 * so callers can always operate on a valid structure.
 *
 * @param {string} filePath
 * @param {{ readFileSync?: typeof readFileSync, existsSync?: typeof existsSync }} [deps]
 * @returns {{ version: number, providers: Record<string, string> }}
 */
export function readCredentialsStore(filePath, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const exists = deps.existsSync ?? existsSync;
  if (!exists(filePath)) {
    return { version: CREDENTIALS_VERSION, providers: {} };
  }
  const raw = read(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    return { version: CREDENTIALS_VERSION, providers: {} };
  }
  return {
    version: data.version ?? CREDENTIALS_VERSION,
    providers: data.providers ?? {},
  };
}

/**
 * Write the credentials store to disk.
 *
 * @param {string} filePath
 * @param {{ version: number, providers: Record<string, string> }} data
 * @param {{ writeFileSync?: typeof writeFileSync }} [deps]
 */
export function writeCredentialsStore(filePath, data, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const payload = JSON.stringify(data, null, 2);
  write(filePath, payload, 'utf8');
}

// ---------------------------------------------------------------------------
// Migration-state store
// ---------------------------------------------------------------------------

/**
 * Read the migration state from disk.
 *
 * Returns `{ status: 'pending' }` when the file does not exist.
 *
 * @param {string} filePath
 * @param {{ readFileSync?: typeof readFileSync, existsSync?: typeof existsSync }} [deps]
 * @returns {{ status: string } & Record<string, unknown>}
 */
export function readMigrationState(filePath, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const exists = deps.existsSync ?? existsSync;
  if (!exists(filePath)) {
    return { status: 'pending' };
  }
  const raw = read(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    return { status: 'pending' };
  }
  return { ...data, status: data.status ?? 'pending' };
}

/**
 * Write the migration state to disk.
 *
 * @param {string} filePath
 * @param {{ status: string } & Record<string, unknown>} data
 * @param {{ writeFileSync?: typeof writeFileSync }} [deps]
 */
export function writeMigrationState(filePath, data, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const payload = JSON.stringify(data, null, 2);
  write(filePath, payload, 'utf8');
}

// ---------------------------------------------------------------------------
// Credential service
// ---------------------------------------------------------------------------

/**
 * Create a credential service instance.
 *
 * Combines encryption, file persistence, and migration-state tracking.
 * All operations validate the provider against the 18-key allowlist.
 *
 * @param {{
 *   credentialsPath: string,
 *   migrationStatePath?: string,
 *   safeStorage: object,
 *   fs?: { readFileSync?: Function, writeFileSync?: Function, existsSync?: Function },
 * }} options
 * @returns {CredentialService}
 */
export function createCredentialService(options) {
  const {
    credentialsPath,
    migrationStatePath,
    safeStorage,
    fs: fsDeps = {},
    revertWindowMs = REVERT_WINDOW_MS,
  } = options;

  const fileDeps = {
    readFileSync: fsDeps.readFileSync ?? readFileSync,
    writeFileSync: fsDeps.writeFileSync ?? writeFileSync,
    existsSync: fsDeps.existsSync ?? existsSync,
  };

  // Each provider's latest write, while it may still be undone (review 13
  // of PR #203, LOW-1; review 14, keychain HIGH-1): its one-time id, the
  // entry as it was before (an encrypted blob, or undefined for none), what
  // the write left there (undefined for a clear), the page that made it and
  // its expiry timer. Kept in this process only: the renderer never holds a
  // key. `revert(id)` undoes only that write, only while the store still
  // holds what it wrote; `commit(id)`, the page going away or the window
  // running out drops it. After that nothing can be undone, so revert can
  // undo only the renderer's own write in flight, which set and clear could
  // do anyway.
  const pending = new Map();

  function remember(provider, previous, wrote, owner) {
    drop(provider);
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (pending.get(provider)?.id === id) pending.delete(provider);
    }, revertWindowMs);
    timer.unref?.();
    pending.set(provider, { id, previous, wrote, owner, timer });
    return id;
  }

  function drop(provider) {
    const entry = pending.get(provider);
    if (entry) clearTimeout(entry.timer);
    pending.delete(provider);
  }

  /** The provider whose latest write has this id, from this page, or null. */
  function latest(writeId, owner) {
    if (typeof writeId !== 'string' || !writeId) return null;
    for (const [provider, entry] of pending) {
      if (entry.id === writeId && entry.owner === owner) return provider;
    }
    return null;
  }

  return {
    /**
     * Encrypt and store a provider key.
     *
     * Encryption happens BEFORE any file I/O, so if safeStorage is
     * unavailable the file is never touched (fail closed).
     *
     * @param {string} provider
     * @param {string} key
     * @returns {Promise<{ ok: true }>}
     * @throws {UnknownProviderError}
     * @throws {CredentialError} when key is empty
     * @throws {SafeStorageUnavailableError}
     */
    async set(provider, key, owner = null) {
      if (!isProviderAllowed(provider)) {
        throw new UnknownProviderError(provider);
      }
      if (typeof key !== 'string' || key.length === 0) {
        throw new CredentialError(
          'Credential key must be a non-empty string',
          'EMPTY_KEY',
        );
      }
      const encrypted = await encryptValue(key, safeStorage);
      const store = readCredentialsStore(credentialsPath, fileDeps);
      const previous = store.providers[provider];
      store.providers[provider] = encrypted;
      writeCredentialsStore(credentialsPath, store, fileDeps);
      return { ok: true, writeId: remember(provider, previous, encrypted, owner) };
    },

    /**
     * Check if a provider key exists.
     *
     * @param {string} provider
     * @returns {boolean}
     * @throws {UnknownProviderError}
     */
    has(provider) {
      if (!isProviderAllowed(provider)) {
        throw new UnknownProviderError(provider);
      }
      const store = readCredentialsStore(credentialsPath, fileDeps);
      return provider in store.providers;
    },

    /**
     * Remove a provider key. Other provider entries are preserved.
     *
     * @param {string} provider
     * @returns {{ ok: true }}
     * @throws {UnknownProviderError}
     */
    clear(provider, owner = null) {
      if (!isProviderAllowed(provider)) {
        throw new UnknownProviderError(provider);
      }
      const store = readCredentialsStore(credentialsPath, fileDeps);
      const previous = store.providers[provider];
      if (provider in store.providers) {
        delete store.providers[provider];
        writeCredentialsStore(credentialsPath, store, fileDeps);
      }
      return { ok: true, writeId: remember(provider, previous, undefined, owner) };
    },

    /**
     * Undo one write: the provider's entry back as it was before it (the
     * earlier key, or none). Only the provider's latest write, by its
     * one-time id, from the page that made it, while it is pending, and only
     * when the store still holds what that write left there
     * (compare-and-swap). Anything else refuses and changes nothing.
     *
     * @param {string} writeId
     * @param {unknown} [owner] the page asking (its webContents)
     * @returns {{ ok: true } | { ok: false, error: 'NOT_THE_LATEST_WRITE' | 'STORE_CHANGED' }}
     */
    revert(writeId, owner = null) {
      const provider = latest(writeId, owner);
      if (provider === null) return { ok: false, error: 'NOT_THE_LATEST_WRITE' };
      const entry = pending.get(provider);
      drop(provider);
      const store = readCredentialsStore(credentialsPath, fileDeps);
      if (store.providers[provider] !== entry.wrote) return { ok: false, error: 'STORE_CHANGED' };
      if (entry.previous === undefined) delete store.providers[provider];
      else store.providers[provider] = entry.previous;
      writeCredentialsStore(credentialsPath, store, fileDeps);
      return { ok: true };
    },

    /**
     * The backend took this write: nothing may undo it now. Drops the
     * entry kept for `revert`.
     *
     * @param {string} writeId
     * @param {unknown} [owner]
     * @returns {{ ok: true } | { ok: false, error: 'NOT_THE_LATEST_WRITE' }}
     */
    commit(writeId, owner = null) {
      const provider = latest(writeId, owner);
      if (provider === null) return { ok: false, error: 'NOT_THE_LATEST_WRITE' };
      drop(provider);
      return { ok: true };
    },

    /** A page went away (destroyed, or navigated): its writes can't be undone. */
    forgetOwner(owner) {
      for (const [provider, entry] of [...pending]) {
        if (entry.owner === owner) drop(provider);
      }
    },

    /**
     * Decrypt all stored credentials into a plain key-value dict.
     *
     * Used by main.mjs at startup for the sidecar's stdin launch-secrets line.
     * Providers that fail to decrypt (corrupted blob, unavailable
     * safeStorage) are silently skipped — the caller decides how to
     * handle missing keys.
     *
     * @returns {Promise<Record<string, string>>}
     */
    async decryptAll() {
      const store = readCredentialsStore(credentialsPath, fileDeps);
      /** @type {Record<string, string>} */
      const result = {};
      for (const [provider, blob] of Object.entries(store.providers)) {
        if (!isProviderAllowed(provider)) continue;
        try {
          const { result: plaintext } = await decryptValue(
            blob,
            safeStorage,
          );
          result[provider] = plaintext;
        } catch {
          // Skip providers that cannot be decrypted
        }
      }
      return result;
    },

    /**
     * Get the current migration status.
     *
     * @returns {{ status: string } & Record<string, unknown>}
     */
    getMigrationStatus() {
      if (!migrationStatePath) return { status: 'pending' };
      return readMigrationState(migrationStatePath, fileDeps);
    },

    /**
     * Set the migration status.
     *
     * @param {string} status — one of MIGRATION_STATUSES
     * @param {Record<string, unknown>} [extra]
     * @throws {CredentialError} when status is invalid
     */
    setMigrationStatus(status, extra = {}) {
      if (!migrationStatePath) return;
      if (!MIGRATION_STATUSES.includes(status)) {
        throw new CredentialError(
          `Invalid migration status: ${status}`,
          'BAD_STATUS',
        );
      }
      writeMigrationState(migrationStatePath, { status, ...extra }, fileDeps);
    },

    /**
     * Trigger a migration retry.
     *
     * Sets status to `in-progress` and returns the new status. The
     * actual migration logic is invoked by the caller (main.mjs)
     * through a separate migration runner.
     *
     * @returns {{ ok: true, status: string }}
     */
    retryMigration() {
      this.setMigrationStatus('in-progress');
      return { ok: true, status: 'in-progress' };
    },
  };
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

/**
 * Register all credential IPC handlers on `ipcMain`.
 *
 * Every handler validates:
 *   1. The sender (via `validateSender`)
 *   2. The provider name (against `ALLOWED_PROVIDERS`) where applicable
 *
 * No `credentials:get` channel is registered — the renderer never
 * receives plaintext keys.
 *
 * All handlers return structured `{ ok, ... }` objects so the renderer
 * can branch on `result.ok` without catching exceptions.
 *
 * @param {object} ipcMain — Electron's ipcMain (or mock)
 * @param {CredentialService} service
 * @param {(event: import('electron').IpcMainInvokeEvent) => boolean} validateSender
 * @returns {string[]} registered channel names
 */
export function registerCredentialHandlers(ipcMain, service, validateSender) {
  // The page that made a write owns it; when it is destroyed or navigates
  // away, its writes can't be undone any more (review 14, keychain HIGH-1).
  const watched = new WeakSet();
  function watchedOwner(event) {
    const sender = event?.sender ?? null;
    if (sender && typeof sender === 'object' && typeof sender.on === 'function' && !watched.has(sender)) {
      watched.add(sender);
      const forget = () => service.forgetOwner?.(sender);
      sender.on('destroyed', forget);
      sender.on('render-process-gone', forget);
      sender.on('did-start-navigation', (details, ...rest) => {
        // Electron passes the details object first; older versions pass
        // (event, url, isInPlace, isMainFrame).
        const sameDocument = details?.isSameDocument ?? rest[1];
        const mainFrame = details?.isMainFrame ?? rest[2] ?? true;
        if (!sameDocument && mainFrame) forget();
      });
    }
    return sender;
  }

  const channels = [];

  // -- credentials:set -----------------------------------------------------
  ipcMain.handle('credentials:set', async (event, payload) => {
    if (!validateSender(event)) {
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    }
    const { provider, key } = payload ?? {};
    if (!isProviderAllowed(provider)) {
      return { ok: false, error: 'UNKNOWN_PROVIDER' };
    }
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'EMPTY_KEY' };
    }
    try {
      return await service.set(provider, key, watchedOwner(event));
    } catch (credentialErr) {
      return {
        ok: false,
        error: credentialErr.code || credentialErr.message,
      };
    }
  });
  channels.push('credentials:set');

  // -- credentials:has -----------------------------------------------------
  ipcMain.handle('credentials:has', (event, provider) => {
    if (!validateSender(event)) {
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    }
    if (!isProviderAllowed(provider)) {
      return { ok: false, error: 'UNKNOWN_PROVIDER' };
    }
    try {
      return { ok: true, has: service.has(provider) };
    } catch (credentialErr) {
      return {
        ok: false,
        error: credentialErr.code || credentialErr.message,
      };
    }
  });
  channels.push('credentials:has');

  // -- credentials:clear ---------------------------------------------------
  ipcMain.handle('credentials:clear', (event, provider) => {
    if (!validateSender(event)) {
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    }
    if (!isProviderAllowed(provider)) {
      return { ok: false, error: 'UNKNOWN_PROVIDER' };
    }
    try {
      return service.clear(provider, watchedOwner(event));
    } catch (credentialErr) {
      return {
        ok: false,
        error: credentialErr.code || credentialErr.message,
      };
    }
  });
  channels.push('credentials:clear');

  // -- credentials:revert / credentials:commit -----------------------------
  // By a write's one-time id (set and clear return it), from the page that
  // made it (review 14 of PR #203, keychain HIGH-1).
  for (const [channel, method] of [['credentials:revert', 'revert'], ['credentials:commit', 'commit']]) {
    ipcMain.handle(channel, (event, writeId) => {
      if (!validateSender(event)) {
        return { ok: false, error: 'UNTRUSTED_SENDER' };
      }
      if (typeof writeId !== 'string' || !writeId) {
        return { ok: false, error: 'NOT_THE_LATEST_WRITE' };
      }
      try {
        return service[method](writeId, event.sender ?? null);
      } catch (credentialErr) {
        return {
          ok: false,
          error: credentialErr.code || credentialErr.message,
        };
      }
    });
    channels.push(channel);
  }

  // -- credentials:migration-status ----------------------------------------
  ipcMain.handle('credentials:migration-status', (event) => {
    if (!validateSender(event)) {
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    }
    try {
      return { ok: true, ...service.getMigrationStatus() };
    } catch (credentialErr) {
      return {
        ok: false,
        error: credentialErr.code || credentialErr.message,
      };
    }
  });
  channels.push('credentials:migration-status');

  // -- credentials:retry-migration -----------------------------------------
  ipcMain.handle('credentials:retry-migration', (event) => {
    if (!validateSender(event)) {
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    }
    try {
      return service.retryMigration();
    } catch (credentialErr) {
      return {
        ok: false,
        error: credentialErr.code || credentialErr.message,
      };
    }
  });
  channels.push('credentials:retry-migration');

  return channels;
}
