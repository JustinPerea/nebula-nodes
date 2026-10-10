/**
 * Node built-in test-runner tests for the Keychain credential service
 * (desktop/credentials.mjs).
 *
 * Covers VAL-KEY-003 through VAL-KEY-013:
 *   - Encryption round-trip with v1:<base64> format
 *   - File persistence to credentials.json
 *   - Provider allowlist (all 16 accepted, unknown/empty/malformed/case-spoofed rejected)
 *   - Sender validation on every IPC handler
 *   - safeStorage unavailability fails closed (no plaintext, no fallback)
 *   - credentials:set / has / clear handler behavior
 *   - credentials:migration-status / retry-migration handler behavior
 *   - No credentials:get channel registered
 *
 * Tests use mock safeStorage and mock ipcMain — Electron is never loaded.
 * File I/O uses real temp directories (like path-migration tests) so
 * persistence round-trips are verified against the actual filesystem.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ALLOWED_PROVIDERS,
  V1_PREFIX,
  CREDENTIALS_FILE_NAME,
  MIGRATION_STATE_FILE_NAME,
  CREDENTIALS_VERSION,
  MIGRATION_STATUSES,
  CREDENTIAL_CHANNELS,
  CredentialError,
  SafeStorageUnavailableError,
  UnknownProviderError,
  isProviderAllowed,
  createSenderValidator,
  isSafeStorageAvailable,
  encryptValue,
  decryptValue,
  readCredentialsStore,
  writeCredentialsStore,
  readMigrationState,
  writeMigrationState,
  createCredentialService,
  registerCredentialHandlers,
} from '../credentials.mjs';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const tempDirs = [];

function mkTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-creds-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup */
    }
  }
});

/**
 * Mock safeStorage that simulates Electron's async API.
 * Encryption is a simple reversible transform (NOT real crypto).
 */
function createMockSafeStorage({ available = true } = {}) {
  return {
    isAsyncEncryptionAvailable: () => available,
    encryptStringAsync: async (plaintext) => {
      if (!available) throw new Error('safeStorage unavailable');
      // Simple reversible transform: prefix plaintext with a marker
      return Buffer.from(`enc::${plaintext}`, 'utf8');
    },
    decryptStringAsync: async (buffer) => {
      if (!available) throw new Error('safeStorage unavailable');
      const str = buffer.toString('utf8');
      const plaintext = str.replace(/^enc::/, '');
      return { result: plaintext, shouldReEncrypt: false };
    },
  };
}

/**
 * Mock safeStorage that is unavailable.
 */
function createUnavailableSafeStorage() {
  return {
    isAsyncEncryptionAvailable: () => false,
    encryptStringAsync: async () => {
      throw new Error('should not be called');
    },
    decryptStringAsync: async () => {
      throw new Error('should not be called');
    },
  };
}

/**
 * Mock safeStorage where isAsyncEncryptionAvailable returns a Promise.
 */
function createAsyncCheckSafeStorage() {
  return {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    encryptStringAsync: async (plaintext) =>
      Buffer.from(`enc::${plaintext}`, 'utf8'),
    decryptStringAsync: async (buffer) => {
      const str = buffer.toString('utf8');
      return { result: str.replace(/^enc::/, ''), shouldReEncrypt: false };
    },
  };
}

/**
 * Mock ipcMain that records registered handlers.
 */
function createMockIpcMain() {
  /** @type {Record<string, Function>} */
  const handlers = {};
  return {
    handle(channel, handler) {
      handlers[channel] = handler;
    },
    removeHandler(channel) {
      delete handlers[channel];
    },
    _handlers: handlers,
    _has(channel) {
      return channel in handlers;
    },
    _get(channel) {
      return handlers[channel];
    },
    _channels() {
      return Object.keys(handlers);
    },
  };
}

/** A mock IPC event with a trusted sender frame. */
function createTrustedEvent(url) {
  return { senderFrame: { url: url || 'file:///app/dist/index.html' } };
}

/** A mock IPC event with an untrusted sender frame. */
function createUntrustedEvent() {
  return { senderFrame: { url: 'https://malicious.example.com' } };
}

/** A mock IPC event with no sender frame. */
function createNoSenderEvent() {
  return {};
}

// ---------------------------------------------------------------------------
// Constants — VAL-KEY-003, VAL-KEY-009
// ---------------------------------------------------------------------------

describe('Published constants', () => {
  test('ALLOWED_PROVIDERS has exactly 17 entries', () => {
    assert.equal(ALLOWED_PROVIDERS.length, 17);
  });

  test('ALLOWED_PROVIDERS is frozen', () => {
    assert.equal(Object.isFrozen(ALLOWED_PROVIDERS), true);
  });

  test('ALLOWED_PROVIDERS contains all documented providers', () => {
    const expected = [
      'ANTHROPIC_API_KEY',
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
      'XAI_API_KEY',
      'WORLDLABS_API_KEY',
      'KREA_USAGE_KEY',
    ];
    assert.deepEqual([...ALLOWED_PROVIDERS].sort(), expected.sort());
  });

  test('V1_PREFIX is "v1:"', () => {
    assert.equal(V1_PREFIX, 'v1:');
  });

  test('CREDENTIALS_FILE_NAME is "credentials.json"', () => {
    assert.equal(CREDENTIALS_FILE_NAME, 'credentials.json');
  });

  test('MIGRATION_STATE_FILE_NAME is "migration-state.json"', () => {
    assert.equal(MIGRATION_STATE_FILE_NAME, 'migration-state.json');
  });

  test('CREDENTIALS_VERSION is 1', () => {
    assert.equal(CREDENTIALS_VERSION, 1);
  });

  test('MIGRATION_STATUSES has the 4 valid states', () => {
    assert.deepEqual([...MIGRATION_STATUSES].sort(), [
      'complete',
      'failed',
      'in-progress',
      'pending',
    ]);
  });

  test('CREDENTIAL_CHANNELS has exactly 5 channels (no get)', () => {
    assert.equal(CREDENTIAL_CHANNELS.length, 5);
    assert.ok(!CREDENTIAL_CHANNELS.includes('credentials:get'));
    assert.deepEqual([...CREDENTIAL_CHANNELS].sort(), [
      'credentials:clear',
      'credentials:has',
      'credentials:migration-status',
      'credentials:retry-migration',
      'credentials:set',
    ]);
  });

  test('CREDENTIAL_CHANNELS is frozen', () => {
    assert.equal(Object.isFrozen(CREDENTIAL_CHANNELS), true);
  });
});

// ---------------------------------------------------------------------------
// isProviderAllowed — VAL-KEY-009
// ---------------------------------------------------------------------------

describe('isProviderAllowed', () => {
  test('accepts all 16 allowed providers', () => {
    for (const provider of ALLOWED_PROVIDERS) {
      assert.ok(
        isProviderAllowed(provider),
        `should accept: ${provider}`,
      );
    }
  });

  test('rejects unknown provider names', () => {
    assert.ok(!isProviderAllowed('UNKNOWN_API_TOKEN'));
    assert.ok(!isProviderAllowed('SOMETHING_ELSE'));
    assert.ok(!isProviderAllowed('ANTHROPIC_SECRET'));
  });

  test('rejects empty string', () => {
    assert.ok(!isProviderAllowed(''));
  });

  test('rejects non-string values', () => {
    assert.ok(!isProviderAllowed(null));
    assert.ok(!isProviderAllowed(undefined));
    assert.ok(!isProviderAllowed(123));
    assert.ok(!isProviderAllowed({}));
    assert.ok(!isProviderAllowed([]));
    assert.ok(!isProviderAllowed(true));
  });

  test('rejects case-spoofed names', () => {
    assert.ok(!isProviderAllowed('openai_api_token'));
    assert.ok(!isProviderAllowed('Openai_Api_Token'));
    assert.ok(!isProviderAllowed('OPENAI_API_KEY '));
    assert.ok(!isProviderAllowed(' OPENAI_API_KEY'));
    assert.ok(!isProviderAllowed('OPENAI_API_KEY\x00'));
  });

  test('rejects names that look like allowed but are substrings', () => {
    assert.ok(!isProviderAllowed('OPENAI'));
    assert.ok(!isProviderAllowed('API_TOKEN'));
    assert.ok(!isProviderAllowed('OPENAI_API_KEY_EXTRA'));
  });
});

// ---------------------------------------------------------------------------
// Sender validation — VAL-KEY-010
// ---------------------------------------------------------------------------

describe('createSenderValidator', () => {
  const validator = createSenderValidator([
    'file://',
    'http://localhost:5173',
  ]);

  test('accepts a file:// origin', () => {
    assert.ok(validator(createTrustedEvent('file:///app/dist/index.html')));
  });

  test('accepts a dev server origin', () => {
    assert.ok(
      validator(createTrustedEvent('http://localhost:5173/#/settings')),
    );
  });

  test('rejects an external origin', () => {
    assert.ok(!validator(createUntrustedEvent()));
  });

  test('rejects an event with no senderFrame', () => {
    assert.ok(!validator(createNoSenderEvent()));
  });

  test('rejects null/undefined event', () => {
    assert.ok(!validator(null));
    assert.ok(!validator(undefined));
  });

  test('rejects senderFrame with non-string url', () => {
    assert.ok(!validator({ senderFrame: { url: 123 } }));
    assert.ok(!validator({ senderFrame: { url: null } }));
  });

  test('rejects senderFrame with empty url', () => {
    assert.ok(!validator({ senderFrame: { url: '' } }));
  });
});

// ---------------------------------------------------------------------------
// isSafeStorageAvailable — VAL-KEY-008
// ---------------------------------------------------------------------------

describe('isSafeStorageAvailable', () => {
  test('returns true when isAsyncEncryptionAvailable returns true', async () => {
    const ss = createMockSafeStorage({ available: true });
    assert.equal(await isSafeStorageAvailable(ss), true);
  });

  test('returns false when isAsyncEncryptionAvailable returns false', async () => {
    const ss = createUnavailableSafeStorage();
    assert.equal(await isSafeStorageAvailable(ss), false);
  });

  test('handles Promise return from isAsyncEncryptionAvailable', async () => {
    const ss = createAsyncCheckSafeStorage();
    assert.equal(await isSafeStorageAvailable(ss), true);
  });

  test('returns false for null safeStorage', async () => {
    assert.equal(await isSafeStorageAvailable(null), false);
  });

  test('returns false for undefined safeStorage', async () => {
    assert.equal(await isSafeStorageAvailable(undefined), false);
  });

  test('falls back to isEncryptionAvailable when async variant missing', async () => {
    const ss = {
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (p) => Buffer.from(p),
      decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }),
    };
    assert.equal(await isSafeStorageAvailable(ss), true);
  });
});

// ---------------------------------------------------------------------------
// encryptValue / decryptValue — VAL-KEY-003, VAL-KEY-004
// ---------------------------------------------------------------------------

describe('encryptValue', () => {
  test('returns a v1: prefixed string', async () => {
    const ss = createMockSafeStorage();
    const encrypted = await encryptValue('aaa-bbb-123', ss);
    assert.ok(encrypted.startsWith(V1_PREFIX), `should start with ${V1_PREFIX}`);
  });

  test('base64 payload is decodable', async () => {
    const ss = createMockSafeStorage();
    const encrypted = await encryptValue('aaa-bbb-123', ss);
    const base64 = encrypted.slice(V1_PREFIX.length);
    const buffer = Buffer.from(base64, 'base64');
    assert.ok(buffer.length > 0, 'base64 should decode to non-empty buffer');
  });

  test('does not contain plaintext in the output', async () => {
    const ss = createMockSafeStorage();
    const encrypted = await encryptValue('UNIQUE_PLAINTEXT_MARKER_42', ss);
    assert.ok(!encrypted.includes('UNIQUE_PLAINTEXT_MARKER_42'));
    assert.ok(!encrypted.includes('UNIQUE_PLAINTEXT'));
  });

  test('throws SafeStorageUnavailableError when unavailable', async () => {
    const ss = createUnavailableSafeStorage();
    await assert.rejects(
      () => encryptValue('aaa', ss),
      (err) => err instanceof SafeStorageUnavailableError,
    );
  });

  test('throws for null safeStorage', async () => {
    await assert.rejects(
      () => encryptValue('aaa', null),
      (err) => err instanceof SafeStorageUnavailableError,
    );
  });
});

describe('decryptValue', () => {
  test('round-trips: encrypt then decrypt returns original plaintext', async () => {
    const ss = createMockSafeStorage();
    const original = 'aaa-bbb-ccc-123';
    const encrypted = await encryptValue(original, ss);
    const { result } = await decryptValue(encrypted, ss);
    assert.equal(result, original);
  });

  test('returns shouldReEncrypt flag', async () => {
    const ss = createMockSafeStorage();
    const encrypted = await encryptValue('aaa', ss);
    const { shouldReEncrypt } = await decryptValue(encrypted, ss);
    assert.equal(typeof shouldReEncrypt, 'boolean');
  });

  test('throws CredentialError for non-v1 format', async () => {
    const ss = createMockSafeStorage();
    await assert.rejects(
      () => decryptValue('not-a-v1-blob', ss),
      (err) => err instanceof CredentialError && err.code === 'BAD_FORMAT',
    );
  });

  test('throws CredentialError for empty string', async () => {
    const ss = createMockSafeStorage();
    await assert.rejects(
      () => decryptValue('', ss),
      (err) => err instanceof CredentialError,
    );
  });

  test('throws SafeStorageUnavailableError when unavailable', async () => {
    const ss = createUnavailableSafeStorage();
    await assert.rejects(
      () => decryptValue('v1:dGVzdA==', ss),
      (err) => err instanceof SafeStorageUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// Credential store I/O — VAL-KEY-003
// ---------------------------------------------------------------------------

describe('readCredentialsStore', () => {
  test('returns empty store when file does not exist', () => {
    const dir = mkTemp();
    const store = readCredentialsStore(join(dir, 'credentials.json'));
    assert.equal(store.version, CREDENTIALS_VERSION);
    assert.deepEqual(store.providers, {});
  });

  test('reads an existing credentials file', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'credentials.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        providers: { OPENAI_API_KEY: 'v1:aaa123' },
      }),
    );
    const store = readCredentialsStore(filePath);
    assert.equal(store.version, 1);
    assert.ok(store.providers.OPENAI_API_KEY);
    assert.equal(store.providers.OPENAI_API_KEY, 'v1:aaa123');
  });

  test('returns empty store for non-object data', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'credentials.json');
    const fakeDeps = {
      readFileSync: () => '"just a string"',
      existsSync: () => true,
    };
    const store = readCredentialsStore(filePath, fakeDeps);
    assert.deepEqual(store.providers, {});
  });

  test('defaults version when missing', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'credentials.json');
    const fakeDeps = {
      readFileSync: () => '{"providers":{}}',
      existsSync: () => true,
    };
    const store = readCredentialsStore(filePath, fakeDeps);
    assert.equal(store.version, CREDENTIALS_VERSION);
  });
});

describe('writeCredentialsStore', () => {
  test('writes a valid JSON file', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'credentials.json');
    writeCredentialsStore(filePath, {
      version: 1,
      providers: { OPENAI_API_KEY: 'v1:aaa' },
    });
    assert.ok(existsSync(filePath));
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.version, 1);
    assert.equal(data.providers.OPENAI_API_KEY, 'v1:aaa');
  });

  test('round-trips: write then read returns same data', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'credentials.json');
    const original = {
      version: 1,
      providers: {
        OPENAI_API_KEY: 'v1:aaa',
        ANTHROPIC_API_KEY: 'v1:bbb',
      },
    };
    writeCredentialsStore(filePath, original);
    const read = readCredentialsStore(filePath);
    assert.deepEqual(read, original);
  });
});

// ---------------------------------------------------------------------------
// Migration state I/O — VAL-KEY-014
// ---------------------------------------------------------------------------

describe('readMigrationState', () => {
  test('returns pending status when file does not exist', () => {
    const dir = mkTemp();
    const state = readMigrationState(join(dir, 'migration-state.json'));
    assert.equal(state.status, 'pending');
  });

  test('reads an existing migration-state file', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'migration-state.json');
    writeFileSync(
      filePath,
      JSON.stringify({ status: 'complete', timestamp: 12345 }),
    );
    const state = readMigrationState(filePath);
    assert.equal(state.status, 'complete');
    assert.equal(state.timestamp, 12345);
  });
});

describe('writeMigrationState', () => {
  test('writes a valid JSON file', () => {
    const dir = mkTemp();
    const filePath = join(dir, 'migration-state.json');
    writeMigrationState(filePath, { status: 'complete' });
    assert.ok(existsSync(filePath));
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.status, 'complete');
  });
});

// ---------------------------------------------------------------------------
// Credential service — VAL-KEY-004, VAL-KEY-005, VAL-KEY-006, VAL-KEY-008
// ---------------------------------------------------------------------------

describe('createCredentialService', () => {
  /**
   * Create a service backed by a temp directory.
   * @param {object} [opts]
   * @returns {{ service: any, credsPath: string, migrationPath: string, ss: any }}
   */
  function makeService(opts) {
    opts = opts || {};
    const dir = mkTemp();
    const ss = opts.safeStorage || createMockSafeStorage();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const migrationPath = join(dir, MIGRATION_STATE_FILE_NAME);
    const service = createCredentialService({
      credentialsPath: credsPath,
      migrationStatePath: migrationPath,
      safeStorage: ss,
    });
    return { service: service, credsPath: credsPath, migrationPath: migrationPath, ss: ss };
  }

  // -- set ---------------------------------------------------------------

  describe('set', () => {
    test('encrypts and persists a credential', async () => {
      const { service, credsPath } = makeService();
      const result = await service.set('OPENAI_API_KEY', 'aaa-bbb-123');
      assert.deepEqual(result, { ok: true });

      // File should exist with v1: format
      const store = readCredentialsStore(credsPath);
      assert.ok(store.providers.OPENAI_API_KEY);
      assert.ok(store.providers.OPENAI_API_KEY.startsWith(V1_PREFIX));
    });

    test('does not write plaintext to the file', async () => {
      const { service, credsPath } = makeService();
      await service.set('OPENAI_API_KEY', 'UNIQUE_MARKER_42');
      const raw = readFileSync(credsPath, 'utf8');
      assert.ok(!raw.includes('UNIQUE_MARKER_42'));
      assert.ok(!raw.includes('UNIQUE_MARKER'));
    });

    test('preserves other providers when setting a new one', async () => {
      const { service, credsPath } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      await service.set('ANTHROPIC_API_KEY', 'bbb');
      const store = readCredentialsStore(credsPath);
      assert.ok(store.providers.OPENAI_API_KEY);
      assert.ok(store.providers.ANTHROPIC_API_KEY);
    });

    test('throws UnknownProviderError for unknown provider', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.set('UNKNOWN', 'aaa'),
        (err) => err instanceof UnknownProviderError,
      );
    });

    test('throws for empty value', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.set('OPENAI_API_KEY', ''),
        (err) => err instanceof CredentialError && err.code === 'EMPTY_KEY',
      );
    });

    test('throws for non-string value', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.set('OPENAI_API_KEY', 123),
        (err) => err instanceof CredentialError,
      );
    });

    test('fails closed when safeStorage unavailable — no file written', async () => {
      const dir = mkTemp();
      const credsPath = join(dir, CREDENTIALS_FILE_NAME);
      const service = createCredentialService({
        credentialsPath: credsPath,
        safeStorage: createUnavailableSafeStorage(),
      });
      await assert.rejects(
        () => service.set('OPENAI_API_KEY', 'aaa'),
        (err) => err instanceof SafeStorageUnavailableError,
      );
      // File must NOT exist — no plaintext, no fabricated value
      assert.ok(!existsSync(credsPath), 'credentials.json must not be written');
    });
  });

  // -- has ---------------------------------------------------------------

  describe('has', () => {
    test('returns true for a stored provider', async () => {
      const { service } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      assert.equal(service.has('OPENAI_API_KEY'), true);
    });

    test('returns false for a provider with no stored value', () => {
      const { service } = makeService();
      assert.equal(service.has('OPENAI_API_KEY'), false);
    });

    test('returns false after clear', async () => {
      const { service } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      assert.equal(service.has('OPENAI_API_KEY'), true);
      service.clear('OPENAI_API_KEY');
      assert.equal(service.has('OPENAI_API_KEY'), false);
    });

    test('throws UnknownProviderError for unknown provider', () => {
      const { service } = makeService();
      assert.throws(
        () => service.has('UNKNOWN'),
        (err) => err instanceof UnknownProviderError,
      );
    });

    test('never returns the stored value or encrypted blob', async () => {
      const { service } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa-bbb');
      const result = service.has('OPENAI_API_KEY');
      assert.equal(typeof result, 'boolean');
      assert.notEqual(typeof result, 'string');
    });
  });

  // -- clear -------------------------------------------------------------

  describe('clear', () => {
    test('removes a provider entry', async () => {
      const { service, credsPath } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      assert.equal(service.has('OPENAI_API_KEY'), true);
      const result = service.clear('OPENAI_API_KEY');
      assert.deepEqual(result, { ok: true });
      assert.equal(service.has('OPENAI_API_KEY'), false);
    });

    test('preserves other provider entries', async () => {
      const { service } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      await service.set('ANTHROPIC_API_KEY', 'bbb');
      service.clear('OPENAI_API_KEY');
      assert.equal(service.has('OPENAI_API_KEY'), false);
      assert.equal(service.has('ANTHROPIC_API_KEY'), true);
    });

    test('is safe to call for a provider that does not exist', () => {
      const { service } = makeService();
      assert.doesNotThrow(() => service.clear('OPENAI_API_KEY'));
      assert.deepEqual(service.clear('OPENAI_API_KEY'), { ok: true });
    });

    test('throws UnknownProviderError for unknown provider', () => {
      const { service } = makeService();
      assert.throws(
        () => service.clear('UNKNOWN'),
        (err) => err instanceof UnknownProviderError,
      );
    });
  });

  // -- decryptAll --------------------------------------------------------

  describe('decryptAll', () => {
    test('decrypts all stored credentials', async () => {
      const { service } = makeService();
      await service.set('OPENAI_API_KEY', 'aaa');
      await service.set('ANTHROPIC_API_KEY', 'bbb');
      const values = await service.decryptAll();
      assert.equal(values.OPENAI_API_KEY, 'aaa');
      assert.equal(values.ANTHROPIC_API_KEY, 'bbb');
    });

    test('returns empty dict when no credentials stored', async () => {
      const { service } = makeService();
      const values = await service.decryptAll();
      assert.deepEqual(values, {});
    });

    test('skips providers not in allowlist', async () => {
      const { service, credsPath } = makeService();
      // Manually write a store with a non-allowed provider
      writeCredentialsStore(credsPath, {
        version: 1,
        providers: {
          OPENAI_API_KEY: 'v1:dGVzdA==',
          EVIL_TOKEN: 'v1:ZXZpbA==',
        },
      });
      const values = await service.decryptAll();
      assert.ok('OPENAI_API_KEY' in values);
      assert.ok(!('EVIL_TOKEN' in values));
    });
  });

  // -- migration status --------------------------------------------------

  describe('getMigrationStatus', () => {
    test('returns pending when no state file exists', () => {
      const { service } = makeService();
      assert.equal(service.getMigrationStatus().status, 'pending');
    });

    test('returns the persisted status', () => {
      const { service, migrationPath } = makeService();
      writeMigrationState(migrationPath, { status: 'complete' });
      assert.equal(service.getMigrationStatus().status, 'complete');
    });
  });

  describe('setMigrationStatus', () => {
    test('writes the status to disk', () => {
      const { service, migrationPath } = makeService();
      service.setMigrationStatus('in-progress');
      const state = readMigrationState(migrationPath);
      assert.equal(state.status, 'in-progress');
    });

    test('throws for invalid status', () => {
      const { service } = makeService();
      assert.throws(
        () => service.setMigrationStatus('invalid'),
        (err) => err instanceof CredentialError,
      );
    });

    test('preserves extra metadata', () => {
      const { service, migrationPath } = makeService();
      service.setMigrationStatus('failed', { error: 'test error' });
      const state = readMigrationState(migrationPath);
      assert.equal(state.status, 'failed');
      assert.equal(state.error, 'test error');
    });
  });

  describe('retryMigration', () => {
    test('sets status to in-progress and returns ok', () => {
      const { service, migrationPath } = makeService();
      const result = service.retryMigration();
      assert.deepEqual(result, { ok: true, status: 'in-progress' });
      const state = readMigrationState(migrationPath);
      assert.equal(state.status, 'in-progress');
    });
  });
});

// ---------------------------------------------------------------------------
// IPC handler registration — VAL-KEY-010, VAL-KEY-011
// ---------------------------------------------------------------------------

describe('registerCredentialHandlers', () => {
  /**
   * Set up a full handler test harness.
   * @param {object} [opts]
   * @returns {{ ipcMain: any, service: any, validateSender: Function, event: any }}
   */
  function makeHarness(opts) {
    opts = opts || {};
    const dir = mkTemp();
    const ss = opts.safeStorage || createMockSafeStorage();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const migrationPath = join(dir, MIGRATION_STATE_FILE_NAME);
    const service = createCredentialService({
      credentialsPath: credsPath,
      migrationStatePath: migrationPath,
      safeStorage: ss,
    });
    const ipcMain = createMockIpcMain();
    const validateSender = opts.validateSender || (() => true);
    registerCredentialHandlers(ipcMain, service, validateSender);
    const event = opts.event || createTrustedEvent();
    return { ipcMain: ipcMain, service: service, validateSender: validateSender, event: event, credsPath: credsPath, migrationPath: migrationPath, ss: ss };
  }

  test('registers exactly 5 channels', () => {
    const { ipcMain } = makeHarness();
    assert.equal(ipcMain._channels().length, 5);
  });

  test('registers all expected channels', () => {
    const { ipcMain } = makeHarness();
    const channels = ipcMain._channels().sort();
    assert.deepEqual(channels, [
      'credentials:clear',
      'credentials:has',
      'credentials:migration-status',
      'credentials:retry-migration',
      'credentials:set',
    ]);
  });

  test('does NOT register credentials:get', () => {
    const { ipcMain } = makeHarness();
    assert.ok(!ipcMain._has('credentials:get'));
  });

  // -- credentials:set handler -------------------------------------------

  describe('credentials:set handler', () => {
    test('encrypts and persists with valid sender and provider', async () => {
      const { ipcMain, event, credsPath } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'OPENAI_API_KEY',
        key: 'aaa',
      });
      assert.deepEqual(result, { ok: true });
      const store = readCredentialsStore(credsPath);
      assert.ok(store.providers.OPENAI_API_KEY.startsWith(V1_PREFIX));
    });

    test('rejects untrusted sender without file mutation', async () => {
      const { ipcMain, credsPath } = makeHarness({
        validateSender: () => false,
      });
      const handler = ipcMain._get('credentials:set');
      const result = await handler(createUntrustedEvent(), {
        provider: 'OPENAI_API_KEY',
        key: 'aaa',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNTRUSTED_SENDER');
      assert.ok(!existsSync(credsPath), 'file must not be written');
    });

    test('rejects unknown provider before file mutation', async () => {
      const { ipcMain, event, credsPath } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'UNKNOWN',
        key: 'aaa',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
      assert.ok(!existsSync(credsPath));
    });

    test('rejects case-spoofed provider', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'openai_api_token',
        key: 'aaa',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
    });

    test('rejects empty value', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'OPENAI_API_KEY',
        key: '',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'EMPTY_KEY');
    });

    test('handles null payload', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, null);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
    });

    test('returns SAFE_STORAGE_UNAVAILABLE when safeStorage is down', async () => {
      const { ipcMain, event, credsPath } = makeHarness({
        safeStorage: createUnavailableSafeStorage(),
      });
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'OPENAI_API_KEY',
        key: 'aaa',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'SAFE_STORAGE_UNAVAILABLE');
      assert.ok(!existsSync(credsPath), 'no file written on unavailable');
    });

    test('never returns the plaintext value to the renderer', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:set');
      const result = await handler(event, {
        provider: 'OPENAI_API_KEY',
        key: 'UNIQUE_RETURN_MARKER_99',
      });
      const json = JSON.stringify(result);
      assert.ok(!json.includes('UNIQUE_RETURN_MARKER_99'));
      assert.ok(!json.includes('UNIQUE_RETURN_MARKER'));
    });
  });

  // -- credentials:has handler -------------------------------------------

  describe('credentials:has handler', () => {
    test('returns { ok: true, has: true } for stored provider', async () => {
      const { ipcMain, event, service } = makeHarness();
      await service.set('OPENAI_API_KEY', 'aaa');
      const handler = ipcMain._get('credentials:has');
      const result = await handler(event, 'OPENAI_API_KEY');
      assert.equal(result.ok, true);
      assert.equal(result.has, true);
    });

    test('returns { ok: true, has: false } for missing provider', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:has');
      const result = await handler(event, 'OPENAI_API_KEY');
      assert.equal(result.ok, true);
      assert.equal(result.has, false);
    });

    test('rejects untrusted sender', async () => {
      const { ipcMain } = makeHarness({
        validateSender: () => false,
      });
      const handler = ipcMain._get('credentials:has');
      const result = await handler(createUntrustedEvent(), 'OPENAI_API_KEY');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNTRUSTED_SENDER');
    });

    test('rejects unknown provider', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:has');
      const result = await handler(event, 'UNKNOWN');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
    });

    test('rejects case-spoofed provider', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:has');
      const result = await handler(event, 'openai_api_token');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
    });

    test('never returns the stored value or encrypted blob', async () => {
      const { ipcMain, event, service } = makeHarness();
      await service.set('OPENAI_API_KEY', 'UNIQUE_HAS_MARKER_77');
      const handler = ipcMain._get('credentials:has');
      const result = await handler(event, 'OPENAI_API_KEY');
      const json = JSON.stringify(result);
      assert.ok(!json.includes('UNIQUE_HAS_MARKER_77'));
      assert.ok(!json.includes('v1:'));
    });
  });

  // -- credentials:clear handler -----------------------------------------

  describe('credentials:clear handler', () => {
    test('removes a provider entry', async () => {
      const { ipcMain, event, service } = makeHarness();
      await service.set('OPENAI_API_KEY', 'aaa');
      const handler = ipcMain._get('credentials:clear');
      const result = await handler(event, 'OPENAI_API_KEY');
      assert.deepEqual(result, { ok: true });
      assert.equal(service.has('OPENAI_API_KEY'), false);
    });

    test('preserves other provider entries', async () => {
      const { ipcMain, event, service } = makeHarness();
      await service.set('OPENAI_API_KEY', 'aaa');
      await service.set('ANTHROPIC_API_KEY', 'bbb');
      const handler = ipcMain._get('credentials:clear');
      await handler(event, 'OPENAI_API_KEY');
      assert.equal(service.has('OPENAI_API_KEY'), false);
      assert.equal(service.has('ANTHROPIC_API_KEY'), true);
    });

    test('rejects untrusted sender', async () => {
      const { ipcMain, service } = makeHarness({
        validateSender: () => false,
      });
      await service.set('OPENAI_API_KEY', 'aaa');
      const handler = ipcMain._get('credentials:clear');
      const result = await handler(createUntrustedEvent(), 'OPENAI_API_KEY');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNTRUSTED_SENDER');
      // Provider should still be present
      assert.equal(service.has('OPENAI_API_KEY'), true);
    });

    test('rejects unknown provider without mutation', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:clear');
      const result = await handler(event, 'UNKNOWN');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNKNOWN_PROVIDER');
    });
  });

  // -- credentials:migration-status handler ------------------------------

  describe('credentials:migration-status handler', () => {
    test('returns the current migration status', async () => {
      const { ipcMain, event } = makeHarness();
      const handler = ipcMain._get('credentials:migration-status');
      const result = await handler(event);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'pending');
    });

    test('returns complete status when set', async () => {
      const { ipcMain, event, service } = makeHarness();
      service.setMigrationStatus('complete');
      const handler = ipcMain._get('credentials:migration-status');
      const result = await handler(event);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
    });

    test('rejects untrusted sender', async () => {
      const { ipcMain } = makeHarness({
        validateSender: () => false,
      });
      const handler = ipcMain._get('credentials:migration-status');
      const result = await handler(createUntrustedEvent());
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNTRUSTED_SENDER');
    });
  });

  // -- credentials:retry-migration handler -------------------------------

  describe('credentials:retry-migration handler', () => {
    test('sets status to in-progress and returns ok', async () => {
      const { ipcMain, event, service } = makeHarness();
      const handler = ipcMain._get('credentials:retry-migration');
      const result = await handler(event);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'in-progress');
      assert.equal(service.getMigrationStatus().status, 'in-progress');
    });

    test('rejects untrusted sender without mutation', async () => {
      const { ipcMain, service } = makeHarness({
        validateSender: () => false,
      });
      service.setMigrationStatus('failed');
      const handler = ipcMain._get('credentials:retry-migration');
      const result = await handler(createUntrustedEvent());
      assert.equal(result.ok, false);
      assert.equal(result.error, 'UNTRUSTED_SENDER');
      // Status should remain 'failed', not changed to 'in-progress'
      assert.equal(service.getMigrationStatus().status, 'failed');
    });
  });
});

// ---------------------------------------------------------------------------
// Credentials file contains only encrypted blobs — VAL-KEY-003
// ---------------------------------------------------------------------------

describe('Credentials file contains only encrypted blobs (VAL-KEY-003)', () => {
  test('no plaintext value appears in the file after set', async () => {
    const dir = mkTemp();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const service = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: createMockSafeStorage(),
    });

    const plaintextValue = 'UNIQUE_FILE_MARKER_12345';
    await service.set('OPENAI_API_KEY', plaintextValue);

    const raw = readFileSync(credsPath, 'utf8');
    assert.ok(!raw.includes(plaintextValue));
    assert.ok(!raw.includes('UNIQUE_FILE_MARKER'));

    // Provider values should match v1: format
    const data = JSON.parse(raw);
    for (const [provider, value] of Object.entries(data.providers)) {
      assert.ok(
        value.startsWith(V1_PREFIX),
        `${provider} value should start with ${V1_PREFIX}`,
      );
    }
  });

  test('multiple providers all have v1: format', async () => {
    const dir = mkTemp();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const service = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: createMockSafeStorage(),
    });

    await service.set('OPENAI_API_KEY', 'aaa');
    await service.set('ANTHROPIC_API_KEY', 'bbb');
    await service.set('FAL_KEY', 'ccc');

    const store = readCredentialsStore(credsPath);
    for (const value of Object.values(store.providers)) {
      assert.ok(value.startsWith(V1_PREFIX));
    }
  });
});

// ---------------------------------------------------------------------------
// Encryption round-trip through the service — VAL-KEY-004
// ---------------------------------------------------------------------------

describe('Encryption round-trip through service', () => {
  test('set then decryptAll returns the original plaintext', async () => {
    const dir = mkTemp();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const ss = createMockSafeStorage();
    const service = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: ss,
    });

    await service.set('OPENAI_API_KEY', 'aaa-roundtrip');
    const values = await service.decryptAll();
    assert.equal(values.OPENAI_API_KEY, 'aaa-roundtrip');
  });

  test('multiple values round-trip correctly', async () => {
    const dir = mkTemp();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const ss = createMockSafeStorage();
    const service = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: ss,
    });

    const expected = {
      OPENAI_API_KEY: 'aaa-123',
      ANTHROPIC_API_KEY: 'bbb-456',
      FAL_KEY: 'ccc-789',
    };

    for (const [provider, value] of Object.entries(expected)) {
      await service.set(provider, value);
    }

    const values = await service.decryptAll();
    assert.deepEqual(values, expected);
  });

  test('credentials survive "restart" (new service instance, same file)', async () => {
    const dir = mkTemp();
    const credsPath = join(dir, CREDENTIALS_FILE_NAME);
    const ss = createMockSafeStorage();

    // First "session" — set a value
    const service1 = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: ss,
    });
    await service1.set('OPENAI_API_KEY', 'aaa-persisted');

    // Second "session" — new service instance, same file path
    const service2 = createCredentialService({
      credentialsPath: credsPath,
      safeStorage: ss,
    });
    assert.equal(service2.has('OPENAI_API_KEY'), true);

    const values = await service2.decryptAll();
    assert.equal(values.OPENAI_API_KEY, 'aaa-persisted');
  });
});
